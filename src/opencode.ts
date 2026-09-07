import { isDeepStrictEqual } from "node:util";
import { dirname, join, relative } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { atomicWrite, exists, readUtf8 } from "./fs.js";
import { parseJsonc, type PoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import type { ConfigPatch } from "./manifest.js";
import { run } from "./process.js";

export const SUPPORTED_OPENCODE_VERSION = "1.18.29";
export const OPENCODE_ADAPTER_VERSION = "1";

type JsonObject = Record<string, unknown>;

function permissions(config: PoiesisConfig): Record<string, JsonObject> {
  const reasoning = config.models.reasoning;
  const execution = config.models.execution;
  return {
    explore: { model: execution },
    poiesis: {
      mode: "primary",
      model: reasoning,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        question: "allow",
        todowrite: "allow",
        skill: {
          grilling: "allow",
          "grill-with-docs": "allow",
          "domain-modeling": "allow",
          "to-spec": "allow",
          "to-tickets": "allow",
          "verification-before-completion": "allow",
        },
        task: {
          explore: "allow",
          "poiesis-planner": "allow",
          "poiesis-worker": "allow",
          "poiesis-research": "allow",
          "poiesis-reviewer": "allow",
          "poiesis-final-reviewer": "allow",
        },
        bash: {
          "poiesis *": "allow",
          "pnpm exec poiesis *": "allow",
          "npx poiesis *": "allow",
        },
      },
    },
    "poiesis-planner": {
      mode: "subagent",
      hidden: true,
      model: reasoning,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        skill: { "codebase-design": "allow" },
        task: { explore: "allow", "poiesis-research": "allow" },
      },
    },
    "poiesis-worker": {
      mode: "subagent",
      hidden: true,
      model: execution,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        edit: "allow",
        skill: { "test-driven-development": "allow", "diagnosing-bugs": "allow" },
        task: { explore: "allow" },
        bash: {
          "*": "allow",
          "git *": "deny",
          "poiesis *": "deny",
          "pnpm exec poiesis *": "deny",
          "npx poiesis *": "deny",
        },
      },
    },
    "poiesis-research": {
      mode: "subagent",
      hidden: true,
      model: execution,
      permission: {
        "*": "deny",
        read: "allow",
        webfetch: "allow",
        websearch: "allow",
        skill: { research: "allow" },
      },
    },
    "poiesis-reviewer": {
      mode: "subagent",
      hidden: true,
      model: execution,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        skill: { "code-review": "allow" },
        task: { explore: "allow" },
      },
    },
    "poiesis-final-reviewer": {
      mode: "subagent",
      hidden: true,
      model: reasoning,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        skill: { "code-review": "allow" },
        task: { explore: "allow" },
      },
    },
  };
}

export function desiredOpenCodePatches(config: PoiesisConfig): Array<{ path: string[]; value: unknown }> {
  const agents = permissions(config);
  return [
    { path: ["default_agent"], value: "poiesis" },
    { path: ["subagent_depth"], value: 2 },
    ...Object.entries(agents).map(([name, value]) => ({ path: ["agent", name], value })),
  ];
}

export async function detectOpenCodeConfig(root: string): Promise<string> {
  const candidates = [
    join(root, "opencode.jsonc"),
    join(root, "opencode.json"),
    join(root, ".opencode", "opencode.jsonc"),
    join(root, ".opencode", "opencode.json"),
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return candidates[0]!;
}

function getAtPath(value: unknown, path: string[]): { exists: boolean; value?: unknown } {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return { exists: false };
    current = (current as JsonObject)[part];
  }
  return { exists: true, value: current };
}

export async function applyOpenCodeConfig(
  root: string,
  config: PoiesisConfig,
  managedConfigPath?: string,
): Promise<ConfigPatch[]> {
  const configPath = managedConfigPath ?? (await detectOpenCodeConfig(root));
  let content = (await exists(configPath)) ? await readUtf8(configPath) : "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
  const original = parseJsonc<JsonObject>(content, configPath);
  const patches: ConfigPatch[] = [];
  for (const desired of desiredOpenCodePatches(config)) {
    const previous = getAtPath(original, desired.path);
    patches.push({
      file: relative(root, configPath),
      path: desired.path,
      previousExists: previous.exists,
      ...(previous.exists ? { previous: previous.value } : {}),
      installed: desired.value,
    });
    content = applyEdits(
      content,
      modify(content, desired.path, desired.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  }
  await atomicWrite(configPath, content.endsWith("\n") ? content : `${content}\n`);
  return patches;
}

export async function reverseOpenCodeConfig(root: string, patches: ConfigPatch[]): Promise<string[]> {
  const changed: string[] = [];
  const byFile = new Map<string, ConfigPatch[]>();
  for (const patch of patches) byFile.set(patch.file, [...(byFile.get(patch.file) ?? []), patch]);
  for (const [relativePath, filePatches] of byFile) {
    const path = join(root, relativePath);
    if (!(await exists(path))) continue;
    let content = await readUtf8(path);
    const current = parseJsonc<JsonObject>(content, path);
    for (const patch of [...filePatches].reverse()) {
      const value = getAtPath(current, patch.path);
      if (!value.exists || !isDeepStrictEqual(value.value, patch.installed)) {
        throw new PoiesisError("CONFIG_OWNERSHIP_LOST", "Refusing to reverse a changed OpenCode config value", {
          file: relativePath,
          path: patch.path,
        });
      }
      content = applyEdits(
        content,
        modify(content, patch.path, patch.previousExists ? patch.previous : undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }),
      );
    }
    const restored = parseJsonc<JsonObject>(content, path);
    if (
      filePatches.some((patch) => patch.path.length === 2 && patch.path[0] === "agent" && !patch.previousExists) &&
      typeof restored.agent === "object" &&
      restored.agent !== null &&
      Object.keys(restored.agent).length === 0
    ) {
      content = applyEdits(
        content,
        modify(content, ["agent"], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }),
      );
    }
    await atomicWrite(path, content.endsWith("\n") ? content : `${content}\n`);
    changed.push(relativePath);
  }
  return changed;
}

export async function verifyOpenCodeVersion(root: string): Promise<string> {
  const result = await run("opencode", ["--version"], { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) {
    throw new PoiesisError("OPENCODE_UNAVAILABLE", "OpenCode is not available", { stderr: result.stderr });
  }
  if (result.stdout !== SUPPORTED_OPENCODE_VERSION) {
    throw new PoiesisError("OPENCODE_VERSION_UNSUPPORTED", "Installed OpenCode version is not supported", {
      installed: result.stdout,
      supported: SUPPORTED_OPENCODE_VERSION,
    });
  }
  return result.stdout;
}

export async function validateOpenCodeConfig(root: string): Promise<void> {
  const configPath = await detectOpenCodeConfig(root);
  await run("opencode", ["debug", "config"], {
    cwd: dirname(configPath) === join(root, ".opencode") ? root : dirname(configPath),
  });
}

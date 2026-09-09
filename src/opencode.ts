import { isDeepStrictEqual } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { applyEdits, modify, parseTree, type Node as JsonNode } from "jsonc-parser";
import { atomicCreate, atomicWrite, exists, readUtf8 } from "./fs.js";
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

export const OPENCODE_CONFIG_RELATIVE_PATHS = [
  "opencode.jsonc",
  "opencode.json",
  ".opencode/opencode.jsonc",
  ".opencode/opencode.json",
] as const;

function openCodeConfigCandidates(root: string): string[] {
  return OPENCODE_CONFIG_RELATIVE_PATHS.map((path) => join(root, path));
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function detectOpenCodeConfig(root: string): Promise<string> {
  const candidates = openCodeConfigCandidates(root);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return candidates[0]!;
}

export async function detectOpenCodeConfigForInit(root: string): Promise<string> {
  const candidates = openCodeConfigCandidates(root);
  const present: string[] = [];
  for (const candidate of candidates) if (await pathEntryExists(candidate)) present.push(candidate);
  if (present.length > 1) {
    throw new PoiesisError("OPENCODE_CONFIG_AMBIGUOUS", "Multiple OpenCode config files are present", {
      paths: present.map((path) => relative(root, path)),
    });
  }
  if (present.length === 1) return present[0]!;
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

function assertNoDuplicateProperties(content: string, configPath: string): void {
  const root = parseTree(content);
  function visit(node: JsonNode): void {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (typeof key === "string") {
          if (keys.has(key)) {
            throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config contains duplicate properties", {
              file: configPath,
              property: key,
            });
          }
          keys.add(key);
        }
        const value = property.children?.[1];
        if (value !== undefined) visit(value);
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  }
  if (root !== undefined) visit(root);
}

function assertDesiredOpenCodePathsAvailable(original: unknown, config: PoiesisConfig): void {
  if (typeof original !== "object" || original === null || Array.isArray(original)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config root must be an object");
  }
  for (const desired of desiredOpenCodePatches(config)) {
    let current: unknown = original;
    for (const [index, part] of desired.path.entries()) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config contains an incompatible reserved path", {
          path: desired.path.slice(0, index),
        });
      }
      if (!Object.hasOwn(current, part)) break;
      if (index === desired.path.length - 1) {
        throw new PoiesisError("INSTALL_PATH_CONFLICT", "Refusing to overwrite a preexisting OpenCode config value", {
          path: desired.path,
        });
      }
      current = (current as JsonObject)[part];
    }
  }
}

function assertOpenCodeContentAvailable(content: string, configPath: string, config: PoiesisConfig): void {
  assertNoDuplicateProperties(content, configPath);
  assertDesiredOpenCodePathsAvailable(parseJsonc<unknown>(content, configPath), config);
}

async function readOpenCodeContent(configPath: string): Promise<string> {
  const bytes = await readFile(configPath);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not valid UTF-8", {
      path: configPath,
    });
  }
  return content;
}

export async function assertOpenCodeConfigAvailable(
  root: string,
  configPath: string,
  config: PoiesisConfig,
): Promise<boolean> {
  if (await pathEntryExists(configPath)) {
    const details = await lstat(configPath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not a regular file", {
        path: relative(root, configPath),
      });
    }
    assertOpenCodeContentAvailable(await readOpenCodeContent(configPath), configPath, config);
    return true;
  }
  return false;
}

export async function applyOpenCodeConfig(
  root: string,
  config: PoiesisConfig,
  managedConfigPath?: string,
  options: {
    requireAvailable?: boolean;
    expectedContent?: Buffer | null;
    onWritten?: (content: string) => void;
  } = {},
): Promise<ConfigPatch[]> {
  const configPath = managedConfigPath ?? (await detectOpenCodeConfig(root));
  const present = await pathEntryExists(configPath);
  if (present) {
    const details = await lstat(configPath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not a regular file", {
        path: relative(root, configPath),
      });
    }
  }
  let content = present ? await readOpenCodeContent(configPath) : "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
  if (
    options.expectedContent !== undefined &&
    (options.expectedContent === null
      ? present
      : !present || !options.expectedContent.equals(Buffer.from(content, "utf8")))
  ) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config changed before installation", {
      path: relative(root, configPath),
    });
  }
  if (options.requireAvailable) assertOpenCodeContentAvailable(content, configPath, config);
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
  const serialized = content.endsWith("\n") ? content : `${content}\n`;
  if (present) await atomicWrite(configPath, serialized);
  else await atomicCreate(configPath, serialized);
  options.onWritten?.(serialized);
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

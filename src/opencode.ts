import { isDeepStrictEqual } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { atomicCreate, atomicWrite, exists, readUtf8 } from "./fs.js";
import { parseJsonc, type PoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import type { ConfigPatch } from "./manifest.js";
import { assertNoDuplicateProperties as assertNoDuplicatePropertiesShared } from "./opencode-config-validator.js";
import { projectOpenCodePayload } from "./opencode-preflight.js";
import { run } from "./process.js";

export const SUPPORTED_OPENCODE_VERSION = "1.18.29";
/**
 * The explicit, ordered set of OpenCode versions the V1 adapter contract
 * applies to. `1.18.29`, `1.18.30`, and `1.18.31` lower the same
 * adapter-version-1 config schema and use identical action keys and
 * session endpoints; the `1.18.30` and `1.18.31` release changes are
 * provider/model-only. Newer releases MUST NOT be added here without
 * explicit contract verification (probe parity for `--version`,
 * `models`, and `debug config` against the projected V1 schema).
 */
export const SUPPORTED_OPENCODE_VERSIONS: readonly string[] = ["1.18.29", "1.18.30", "1.18.31"];
export const OPENCODE_ADAPTER_VERSION = "1";

export function isSupportedOpenCodeVersion(version: string): boolean {
  return SUPPORTED_OPENCODE_VERSIONS.includes(version);
}

type JsonObject = Record<string, unknown>;

/**
 * Spec #104 / ticket #105: the runtime identity boundary for the primary
 * (Poiesis) agent. The generated normal installed lifecycle route is exactly
 * `pnpm dlx poiesis-cli@<manifest.poiesisVersion>`. The bare `poiesis`,
 * `pnpm exec poiesis`, and `npx poiesis` canonical routes are removed and
 * explicitly denied, and the unversioned `pnpm dlx poiesis-cli *` launcher is
 * also denied so only the exact-version route survives. The keys are emitted
 * in the documented order so OpenCode's last-match-wins resolver picks the
 * exact-version allow entry last for any matching command.
 *
 * The `*` allow first provides broad ordinary shell; the ordered denies
 * cover every known ambiguous launcher; the exact-version allow last is the
 * sole canonical CLI route. `@latest` remains reserved for human/operator
 * intentional init/update outside this projection.
 */
function primaryBashPermissions(poiesisVersion: string): Record<string, string> {
  return {
    "*": "allow",
    "poiesis *": "deny",
    "pnpm exec poiesis *": "deny",
    "npx poiesis *": "deny",
    "pnpm dlx poiesis-cli *": "deny",
    [`pnpm dlx poiesis-cli@${poiesisVersion} *`]: "allow",
  };
}

function permissions(config: PoiesisConfig, poiesisVersion: string): Record<string, JsonObject> {
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
        bash: primaryBashPermissions(poiesisVersion),
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

export function desiredOpenCodePatches(
  config: PoiesisConfig,
  poiesisVersion: string,
): Array<{ path: string[]; value: unknown }> {
  const agents = permissions(config, poiesisVersion);
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
  // Implemented by the small internal validator module
  // (`src/opencode-config-validator.ts`) that owns the duplicate-property
  // recursion. Kept as a thin pass-through here so init-side callers
  // (`assertOpenCodeContentAvailable`) reuse the same canonical helper
  // without exporting it from this module's public surface.
  assertNoDuplicatePropertiesShared(content, configPath);
}

function assertDesiredOpenCodePathsAvailable(original: unknown, config: PoiesisConfig, poiesisVersion: string): void {
  if (typeof original !== "object" || original === null || Array.isArray(original)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config root must be an object");
  }
  for (const desired of desiredOpenCodePatches(config, poiesisVersion)) {
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

function assertOpenCodeContentAvailable(content: string, configPath: string, config: PoiesisConfig, poiesisVersion: string): void {
  assertNoDuplicateProperties(content, configPath);
  assertDesiredOpenCodePathsAvailable(parseJsonc<unknown>(content, configPath), config, poiesisVersion);
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
  poiesisVersion: string,
): Promise<boolean> {
  if (await pathEntryExists(configPath)) {
    const details = await lstat(configPath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not a regular file", {
        path: relative(root, configPath),
      });
    }
    assertOpenCodeContentAvailable(await readOpenCodeContent(configPath), configPath, config, poiesisVersion);
    return true;
  }
  return false;
}

export async function applyOpenCodeConfig(
  root: string,
  config: PoiesisConfig,
  managedConfigPath: string | undefined,
  poiesisVersion: string,
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
  if (options.requireAvailable) assertOpenCodeContentAvailable(content, configPath, config, poiesisVersion);
  // The pure projection loop (parse original → for each desired patch compute
  // provenance + apply jsonc edits → emit serialized payload) is delegated to
  // `projectOpenCodePayload` so the transaction-time preflight in
  // `runUpdateConfigTransaction` can compute the EXACT same payload
  // deterministically before any owned byte is mutated. The returned
  // `configPatches` are byte-for-byte identical to the previous inline loop.
  const { serialized, configPatches } = projectOpenCodePayload({
    root,
    configPath,
    currentContent: content,
    patches: desiredOpenCodePatches(config, poiesisVersion),
  });
  // Strengthened apply: re-read the on-disk bytes immediately before the
  // atomicWrite and compare against `options.expectedContent`. This is a TOCTOU
  // pre-write byte equality check — POSIX does not offer a portable file-CAS
  // primitive across filesystems (e.g. network mounts may silently rewrite),
  // so this guard is explicitly NOT called a compare-and-swap. A mismatch
  // here is the same kind of foreign-writer race the original
  // `expectedContent.equals(...)` check at the head of this function detects;
  // adding a second sample at the moment of the write raises the probability
  // of catching a foreign writer that slipped in between the head check and
  // the write without changing the caller's contract.
  if (present && options.expectedContent !== undefined && options.expectedContent !== null) {
    const rereadBeforeWrite = await readFile(configPath);
    if (!rereadBeforeWrite.equals(options.expectedContent)) {
      throw new PoiesisError(
        "INSTALL_PATH_CONFLICT",
        "OpenCode config changed between expected-content check and atomic write",
        { path: relative(root, configPath) },
      );
    }
  }
  if (present) await atomicWrite(configPath, serialized);
  else await atomicCreate(configPath, serialized);
  options.onWritten?.(serialized);
  return configPatches;
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
  if (!isSupportedOpenCodeVersion(result.stdout)) {
    throw new PoiesisError("OPENCODE_VERSION_UNSUPPORTED", "Installed OpenCode version is not supported", {
      installed: result.stdout,
      supported: [...SUPPORTED_OPENCODE_VERSIONS],
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

import { isDeepStrictEqual } from "node:util";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { atomicCreate, atomicWrite, exists, readUtf8 } from "./fs.js";
import { parseJsonc, type PoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import type { ConfigPatch } from "./manifest.js";
import { assertNoDuplicateProperties as assertNoDuplicatePropertiesShared } from "./opencode-config-validator.js";
import { projectOpenCodePayload } from "./opencode-preflight.js";
import { run } from "./process.js";

/**
 * The explicit, ordered set of OpenCode versions the V1 adapter contract
 * applies to. `1.18.29`, `1.18.30`, and `1.18.31` lower the same
 * adapter-version-1 config schema and use identical action keys and
 * session endpoints; the `1.18.30` and `1.18.31` release changes are
 * provider/model-only. Newer releases MUST NOT be added here without
 * explicit contract verification (probe parity for `--version`,
 * `models`, and `debug config` against the projected V1 schema).
 *
 * `CERTIFIED_OPENCODE_VERSIONS` is the SINGLE source of truth for every
 * certified-version derived value. `CERTIFIED_OPENCODE_VERSION` (the
 * legacy single-pin shape carried in pre-1.0.3 manifests' `supportedVersion`
 * field) and `LATEST_CERTIFIED_OPENCODE_VERSION` (the informational
 * "latest certified compatibility" pin) are both derived from it so the
 * three cannot drift independently. Edit only this array when adding a
 * newly-verified tag.
 */
export const CERTIFIED_OPENCODE_VERSIONS: readonly string[] = ["1.18.29", "1.18.30", "1.18.31"];
/**
 * The legacy single-version pin recorded in
 * `manifest.adapter.supportedVersion` for backward compatibility with
 * pre-1.0.3 manifests that only carry `supportedVersion`. Derived from
 * `CERTIFIED_OPENCODE_VERSIONS[0]` so the literal `"1.18.29"` lives in
 * exactly one place. Newer releases do NOT need an update here — the
 * authoritative ordered list is `CERTIFIED_OPENCODE_VERSIONS`.
 */
export const CERTIFIED_OPENCODE_VERSION: string = CERTIFIED_OPENCODE_VERSIONS[0]!;
/**
 * The latest version the V1 adapter contract has been explicitly
 * certified against. Derived from `CERTIFIED_OPENCODE_VERSIONS` so the
 * two cannot drift; surfaced only as informational metadata in
 * human-readable "newer than latest certified compatibility" notices.
 * Not part of the public API — callers who need this value compute
 * it from `CERTIFIED_OPENCODE_VERSIONS` directly.
 */
const LATEST_CERTIFIED_OPENCODE_VERSION: string = CERTIFIED_OPENCODE_VERSIONS[CERTIFIED_OPENCODE_VERSIONS.length - 1]!;
export const OPENCODE_ADAPTER_VERSION = "1";

export function isCertifiedOpenCodeVersion(version: string): boolean {
  return CERTIFIED_OPENCODE_VERSIONS.includes(version);
}

type JsonObject = Record<string, unknown>;

/**
 * Result of the V1 adapter contract capability probe. Reports what the
 * installed OpenCode binary actually does (or refuses to do) for the
 * surfaces Poiesis depends on. The version being on the certified
 * `CERTIFIED_OPENCODE_VERSIONS` set is informational metadata; the real
 * safety boundary is the capability probe results.
 *
 * - `installed`              the trimmed `opencode --version` stdout
 * - `certified`              `installed` is in `CERTIFIED_OPENCODE_VERSIONS`
 * - `latestCertified`        latest entry of `CERTIFIED_OPENCODE_VERSIONS`,
 *                            surfaced as informational metadata
 * - `modelsInventory`        result of `opencode models`; `null` if not
 *                            probed or the call failed
 * - `acceptsV1Schema`        result of writing the projected payload
 *                            and running `opencode debug config`;
 *                            `null` if not probed, `true`/`false` if
 *                            probed
 */
export interface OpenCodeAdapterContract {
  installed: string;
  certified: boolean;
  latestCertified: string;
  modelsInventory: readonly string[] | null;
  acceptsV1Schema: boolean | null;
}

/**
 * Options accepted by `probeOpenCodeAdapterContract` /
 * `assertOpenCodeAdapterContract`. Each capability is opt-in so callers
 * can request only the surfaces they actually need; probes that are not
 * requested remain `null` in the returned contract.
 */
export interface ProbeAdapterContractOptions {
  /**
   * Probe the OpenCode model inventory via `opencode models`.
   * When set, `assertOpenCodeAdapterContract` hard-fails with
   * `OPENCODE_ADAPTER_INCOMPATIBLE` if the inventory call fails or
   * returns an empty list.
   */
  probeModels?: boolean;
  /**
   * Probe the V1 adapter projection by writing `payload` to a temp
   * file and running `opencode debug config` from `cwd`. When set,
   * `assertOpenCodeAdapterContract` hard-fails with
   * `OPENCODE_ADAPTER_INCOMPATIBLE` if the call rejects the projection.
   */
  probeSchema?: { payload: string; cwd: string };
}

/**
 * Probe the installed OpenCode for the V1 adapter contract surface
 * Poiesis depends on. The probe is non-fatal: every capability probe
 * that fails records `null` / `false` in the report. The only
 * non-capability failure this function raises is `OPENCODE_UNAVAILABLE`
 * when `opencode --version` itself cannot run; without the version
 * string nothing else can be reported.
 *
 * The capability-based check is what `update --config`, `setModel`,
 * the interactive `poiesis model` flow, and `doctor` rely on. A newer
 * or otherwise unrecognized OpenCode version that satisfies the
 * probed capabilities is reported as `certified: false` with the
 * capability results preserved — callers decide whether to warn the
 * operator or fail closed, never blindly reject by version string.
 */
export async function probeOpenCodeAdapterContract(
  root: string,
  options?: ProbeAdapterContractOptions,
): Promise<OpenCodeAdapterContract> {
  // Always probe `--version`. A missing binary / non-zero exit is the
  // only thing that can fail this probe; every other capability probe
  // is best-effort and reports its own result. We also catch the
  // synchronous spawn failure (e.g. binary not on PATH) so the same
  // OPENCODE_UNAVAILABLE code surfaces from both exit-code and
  // I/O-error branches.
  let versionResult: Awaited<ReturnType<typeof run>>;
  try {
    versionResult = await run("opencode", ["--version"], { cwd: root, allowFailure: true });
  } catch (error) {
    throw new PoiesisError("OPENCODE_UNAVAILABLE", "OpenCode is not available", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (versionResult.exitCode !== 0) {
    throw new PoiesisError("OPENCODE_UNAVAILABLE", "OpenCode is not available", {
      stderr: versionResult.stderr,
    });
  }
  const installed = versionResult.stdout;
  const certified = isCertifiedOpenCodeVersion(installed);

  let modelsInventory: readonly string[] | null = null;
  if (options?.probeModels === true) {
    const modelsResult = await run("opencode", ["models"], { cwd: root, allowFailure: true });
    if (modelsResult.exitCode === 0) {
      modelsInventory = [...new Set(modelsResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
    }
  }

  let acceptsV1Schema: boolean | null = null;
  if (options?.probeSchema !== undefined) {
    const tempDir = await mkdtemp(join(tmpdir(), "poiesis-opencode-contract-probe-"));
    try {
      const payloadPath = join(tempDir, "opencode.jsonc");
      await atomicCreate(payloadPath, options.probeSchema.payload);
      const probeResult = await run("opencode", ["debug", "config"], {
        cwd: options.probeSchema.cwd,
        allowFailure: true,
      });
      acceptsV1Schema = probeResult.exitCode === 0;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  return {
    installed,
    certified,
    latestCertified: LATEST_CERTIFIED_OPENCODE_VERSION,
    modelsInventory,
    acceptsV1Schema,
  };
}

/**
 * Probe and assert that the installed OpenCode satisfies the V1 adapter
 * contract capabilities the caller depends on. Capability probe
 * failures hard-fail with `OPENCODE_ADAPTER_INCOMPATIBLE` and a
 * `capability` field naming the missing surface so an operator can
 * diagnose WHAT the installed binary lacks.
 *
 * The version being on `CERTIFIED_OPENCODE_VERSIONS` is NOT a hard
 * gate — the contract is. A newer or otherwise unrecognized patch
 * version whose capability probe passes is reported as
 * `certified: false` with the capability results preserved; the caller
 * decides whether to emit a "newer than latest certified compatibility"
 * warning to the operator.
 *
 * The only hard failure unrelated to capability is `OPENCODE_UNAVAILABLE`
 * when `opencode --version` cannot run.
 */
export async function assertOpenCodeAdapterContract(
  root: string,
  options?: ProbeAdapterContractOptions,
): Promise<OpenCodeAdapterContract> {
  const contract = await probeOpenCodeAdapterContract(root, options);
  if (options?.probeModels === true && (contract.modelsInventory === null || contract.modelsInventory.length === 0)) {
    throw new PoiesisError(
      "OPENCODE_ADAPTER_INCOMPATIBLE",
      "OpenCode did not return a non-empty models inventory; the installed binary lacks the capability Poiesis requires",
      { installed: contract.installed, capability: "models" },
    );
  }
  if (options?.probeSchema !== undefined && contract.acceptsV1Schema === false) {
    throw new PoiesisError(
      "OPENCODE_ADAPTER_INCOMPATIBLE",
      "OpenCode rejected the V1 adapter projection; the installed binary is incompatible with the configuration Poiesis generates",
      { installed: contract.installed, capability: "debug config schema" },
    );
  }
  return contract;
}
/**
 * Spec #104 / tickets #105 / #110: the runtime identity boundary for the
 * primary (Poiesis) agent. The generated normal installed lifecycle
 * route is exactly `pnpm dlx poiesis-cli@<manifest.poiesisVersion>`. The
 * bare `poiesis`, `pnpm exec poiesis`, and `npx poiesis` canonical routes
 * are removed and explicitly denied, and the unversioned
 * `pnpm dlx poiesis-cli *` launcher is also denied so only the
 * exact-version route survives. The keys are emitted in the documented
 * order so OpenCode's last-match-wins resolver picks the exact-version
 * allow entry last for any matching command.
 *
 * The `*` allow first provides broad ordinary shell; the ordered denies
 * cover every known ambiguous launcher including version-qualified
 * alternate routes (`pnpm dlx poiesis-cli@latest`,
 * `pnpm dlx poiesis-cli@1.0.0`, etc.) so the broad `*` allow does not
 * let off-version dlx invocations slip through; the exact-version allow
 * last is the sole canonical CLI route. `@latest` remains reserved for
 * human/operator intentional init/update outside this projection.
 */
function primaryBashPermissions(poiesisVersion: string): Record<string, string> {
  return {
    "*": "allow",
    "poiesis *": "deny",
    "pnpm exec poiesis *": "deny",
    "npx poiesis *": "deny",
    "pnpm dlx poiesis-cli *": "deny",
    "pnpm dlx poiesis-cli@*": "deny",
    [`pnpm dlx poiesis-cli@${poiesisVersion} *`]: "allow",
  };
}

/**
 * Spec #120 / ticket #123 — narrow Repository Intelligence bash
 * permission for sub-agents. The four exact-version allows are the
 * ONLY bash entries that survive the `*` deny; every other command is
 * blocked. The keys are emitted in the documented order so OpenCode's
 * last-match-wins resolver still applies, but every key here is an
 * exact match (no glob patterns beyond the documented `--question`,
 * `--from`, `--to`, `--node` arg trailing wildcard) so the resolver
 * matches one and only one command per invocation.
 *
 * The narrow allows cover the four deterministic repository subcommands
 * (ticket #121 `status`, ticket #122 `query`, ticket #123 `path`,
 * ticket #123 `explain`). They never grant:
 *
 *   - `workspace *` (lifecycle ownership);
 *   - `checkpoint *`, `verify *`, `publish *`, `preview *`;
 *   - `integrate *`, `promote *`, `release *`;
 *   - `tracker *` (tracker mutation);
 *   - `capability *` (capability installation);
 *   - any broader read/write on the harness or filesystem.
 *
 * Bare `pnpm dlx poiesis-cli`, `npx poiesis`, and version-qualified
 * alternate routes (`pnpm dlx poiesis-cli@latest`) are intentionally
 * absent: only the exact `<manifest.poiesisVersion>` route survives.
 */
function repositoryIntelligenceBashPermissions(poiesisVersion: string): Record<string, string> {
  const exact = `pnpm dlx poiesis-cli@${poiesisVersion}`;
  return {
    "*": "deny",
    [`${exact} repository status`]: "allow",
    [`${exact} repository query *`]: "allow",
    [`${exact} repository path *`]: "allow",
    [`${exact} repository explain *`]: "allow",
  };
}

/**
 * Spec #120 / ticket #123 — narrow additive allow for the Worker
 * sub-agent. The Worker already owns broad project bash with ordered
 * lifecycle denies (Spec #104 / ticket #110 + #113). This helper
 * appends the four Repository Intelligence subcommand allows AFTER
 * the existing `pnpm dlx poiesis-cli@*` deny so OpenCode's
 * last-match-wins resolver grants only the documented operations and
 * leaves every other `pnpm dlx poiesis-cli@…` invocation denied.
 *
 * Returns a NEW object; the caller's existing deny map is not
 * mutated. The exact-version route semantics are preserved: a Worker
 * that launches `pnpm dlx poiesis-cli@latest` (or any other
 * non-manifest version) still sees a `deny` because the broad deny
 * precedes the exact-version allow keys.
 */
function workerRepositoryIntelligenceAllows(poiesisVersion: string): Record<string, string> {
  const exact = `pnpm dlx poiesis-cli@${poiesisVersion}`;
  return {
    [`${exact} repository status`]: "allow",
    [`${exact} repository query *`]: "allow",
    [`${exact} repository path *`]: "allow",
    [`${exact} repository explain *`]: "allow",
  };
}

/**
 * Spec #168 / ticket #173 — the narrow focused-check allow for the Worker.
 *
 * `check` is the ONE Poiesis subcommand a Worker needs to act on real
 * focused-check evidence instead of running the configured full verification
 * plan (reserved for the single whole-change Proof) or guessing from raw
 * shell output. It is the narrowest useful grant because the subcommand
 * itself carries no lifecycle authority by construction:
 *
 *   - its result is typed so `authoritative` is `false` and `verification` /
 *     `proof` are literally `null`, so no downstream step can consume it;
 *   - it writes nothing anywhere — no receipt, no manifest, no durable state;
 *   - it resolves the shared lifecycle authority and then REQUIRES a proven
 *     ownership marker, refusing a primary checkout or a foreign linked
 *     worktree with `WORKSPACE_OWNERSHIP_UNKNOWN`;
 *   - it never retries: one command at most once per invocation.
 *
 * The pattern stops at the subcommand (`check *`) rather than pinning an
 * argument shape (`check --command *`). OpenCode's resolver matches the
 * literal prefix, so an argument-shaped pattern would deny ordinary flag
 * orders such as `check --progress --command ...` — the grant would be
 * narrower than the usage it exists to permit, and the deny would win instead.
 * Flag ORDER is the caller's choice; the subcommand is the authority boundary.
 *
 * It grants NO general lifecycle authority: not `verify`, `checkpoint`,
 * `workspace`, `publish`, `preview`, `promote`, `integrate`, `tracker`,
 * `capability`, `session`, `model`, `update`, nor the broad
 * `pnpm dlx poiesis-cli@<version> *` route, which remains the primary's alone.
 * Reviewer ownership is untouched: the Planner, Ticket Reviewer, and Final
 * Reviewer keep the read-only Repository Intelligence surface, and Research
 * keeps no bash surface at all.
 */
function workerFocusedCheckAllows(poiesisVersion: string): Record<string, string> {
  const exact = `pnpm dlx poiesis-cli@${poiesisVersion}`;
  return { [`${exact} check *`]: "allow" };
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
        // Spec #120 / ticket #123 — Planner reaches Repository
        // Intelligence through the deterministic Poiesis CLI only.
        // No broad shell is granted; only the four exact-version
        // repository subcommands survive. The Planner must still rely
        // on Explore/read/grep for any non-Repository-Intelligence
        // fact and may not bypass the canonical role's bash
        // boundaries.
        bash: repositoryIntelligenceBashPermissions(poiesisVersion),
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
          // Spec #104 / ticket #113: deny package-runner lifecycle
          // launchers as well so the broad `*` allow cannot be used to
          // invoke the same authorized primary canonical route through
          // `pnpm dlx`. Worker retains no exact-version allow for
          // arbitrary Poiesis lifecycle; only the primary does.
          //
          // Spec #168 / ticket #172 added `poiesis check` (non-authoritative
          // focused checks) to the runtime and deliberately left this
          // projection untouched, deferring the security-surface decision to
          // ticket #173. Ticket #173 owns that decision and grants exactly
          // that one subcommand through `workerFocusedCheckAllows` below:
          // no broad route, no other subcommand, and the deny ordering above
          // preserved so the exact-version deny still precedes every allow.
          "pnpm dlx poiesis-cli *": "deny",
          "pnpm dlx poiesis-cli@*": "deny",
          // Spec #120 / ticket #123: append the four Repository
          // Intelligence subcommand allows AFTER the `pnpm dlx
          // poiesis-cli@*` deny so OpenCode's last-match-wins
          // resolver grants only the exact-version repository
          // operations and leaves every other Poiesis lifecycle
          // invocation denied.
          ...workerRepositoryIntelligenceAllows(poiesisVersion),
          // Spec #168 / ticket #173: and then the one narrow focused-check
          // allow, also AFTER the `pnpm dlx poiesis-cli@*` deny, so the
          // Worker reaches real focused-check evidence without gaining any
          // lifecycle authority. The Worker keeps broad project bash, so this
          // is not a new capability for it; the bounded difference is that the
          // evidence becomes a deterministic fingerprint rather than
          // unstructured terminal text.
          ...workerFocusedCheckAllows(poiesisVersion),
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
        // Spec #120 / ticket #123 — Research owns external facts, not
        // repository structure. NO Repository Intelligence bash
        // permission is granted here so a Research subagent cannot
        // accidentally invoke `uvx graphify` against the consumer
        // repository.
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
        // Spec #120 / ticket #123 — Ticket Reviewer reaches Repository
        // Intelligence through the deterministic Poiesis CLI only;
        // no arbitrary bash is granted.
        bash: repositoryIntelligenceBashPermissions(poiesisVersion),
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
        // Spec #120 / ticket #123 — Final Reviewer reaches Repository
        // Intelligence through the deterministic Poiesis CLI only;
        // its filesystem allowlist remains the exact candidate
        // workspace. The repository wrapper must run with the
        // dispatched candidate workspace as `cwd`; it may not inspect
        // a parent or another checkout.
        bash: repositoryIntelligenceBashPermissions(poiesisVersion),
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
export async function validateOpenCodeConfig(root: string): Promise<void> {
  const configPath = await detectOpenCodeConfig(root);
  // The schema probe is best-effort with a typed-failure wrapper: a
  // non-zero `debug config` exit means the installed OpenCode rejected
  // the projected V1 payload. Surface that as
  // `OPENCODE_ADAPTER_INCOMPATIBLE` so the caller's fail-closed path
  // and the doctor `opencode-schema` check both report WHAT capability
  // the installed binary is missing instead of a generic
  // `COMMAND_FAILED`. The probe uses `allowFailure: true` so the
  // exit code is preserved for the wrap rather than thrown as a
  // generic command error.
  const probe = await run("opencode", ["debug", "config"], {
    cwd: dirname(configPath) === join(root, ".opencode") ? root : dirname(configPath),
    allowFailure: true,
  });
  if (probe.exitCode !== 0) {
    let installed = "<unknown>";
    try {
      installed = (await run("opencode", ["--version"], { cwd: root, allowFailure: true })).stdout.trim();
    } catch {
      // The version probe is informational only; we already have the
      // capability failure we wanted to surface.
    }
    throw new PoiesisError(
      "OPENCODE_ADAPTER_INCOMPATIBLE",
      "OpenCode rejected the V1 adapter projection; the installed binary is incompatible with the configuration Poiesis generates",
      { installed, capability: "debug config schema", stderr: probe.stderr },
    );
  }
}

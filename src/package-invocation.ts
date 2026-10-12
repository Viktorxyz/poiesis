/**
 * Spec #207 / ticket #210 — pinned local package invocation (Author replan).
 * Spec #219 / ticket #220 — root-aligned pnpm workspace eligibility.
 * Spec #219 / ticket #221 — update / version-cross `update --config` / removal
 * lifecycle reuses the same centralized eligibility and explicit workspace-root
 * execution scope; config-byte no-op revalidates ownership + readiness; child
 * manifests stay byte-identical; scope/identity/native/runtime failures fail
 * closed without claiming `node_modules` rollback.
 * Spec #219 / ticket #222 — doctor read-only package-contribution check reuses
 * the same eligibility, ownership, and readiness logic; never repairs.
 * Spec #219 / ticket #223 — effective lock settings include pnpm-workspace.yaml
 * (`sharedWorkspaceLockfile` / `lockfileDir`) with fail-closed ambiguity and
 * clear precedence; live eligibility/scope is revalidated immediately before
 * package write and native executor (apply + removal).
 *
 * Ordinary Node packages get a standard npm/pnpm exact `poiesis-cli`
 * devDependency equal to the installed release and `scripts.poiesis = "poiesis"`
 * so local invocation uses the installed runtime. After install, the resolved
 * local package version must equal the target. Self-host `package.name ===
 * "poiesis-cli"` never self-depends; it uses `scripts.poiesis = "node dist/cli.js"`
 * and verifies build readiness by probing that binary directly (`node dist/cli.js
 * --version`) — never by running arbitrary package scripts. Projects without
 * `package.json` keep exact `pnpm dlx poiesis-cli@<version>` and never receive
 * fabricated package metadata.
 *
 * Spec #219: a root-aligned pnpm workspace (root `package.json` + root
 * `pnpm-workspace.yaml` + sole root `pnpm-lock.yaml`, effective workspace root
 * equal to the installation root, shared lockfile contract intact) is eligible.
 * Poiesis owns only the root contribution; child manifests are never mutated.
 * Native pnpm ops use explicit `--workspace-root` (`-w`) semantics. npm
 * package.json workspaces, outer/non-root effective scope, disabled or
 * redirected shared lock settings, and ambiguous/missing locks stay fail-closed.
 * Workspace execution scope is plan/runtime context only — the durable
 * `packageContribution` schema stays root-relative and unchanged.
 *
 * Ownership is contribution-scoped (script + optional exact dep + lockfile
 * fields Poiesis wrote), not whole-file package.json ownership. Native pm runs
 * with `--ignore-scripts`. The artifact journal restores only Poiesis-authored
 * package.json/lock bytes it bound; it does **not** promise atomic rollback of
 * `node_modules` or other native package-manager side effects. A native pm
 * failure is an explicit incomplete operation — never a successful manifest
 * transition. Foreign scripts/deps conflict fail closed before mutation.
 *
 * Former `src/package-script.ts` (`@latest` dlx script) is not resurrected.
 */
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type FormattingOptions,
  type Node,
} from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";
import { parseJsonc } from "./config.js";
import { PoiesisError } from "./errors.js";
import { hashContent } from "./hash.js";
import type { PackageContributionRecord } from "./manifest.js";
import type { ArtifactJournalEntry } from "./mutation-transaction.js";

export const PACKAGE_JSON_RELATIVE = "package.json";
export const POIESIS_SCRIPT_NAME = "poiesis";
export const POIESIS_CLI_PACKAGE_NAME = "poiesis-cli";
export const SELFHOST_PACKAGE_NAME = "poiesis-cli";
export const ORDINARY_SCRIPT_VALUE = "poiesis";
export const SELFHOST_SCRIPT_VALUE = "node dist/cli.js";
/** Resolved ordinary install identity under the primary root. */
export const LOCAL_CLI_PACKAGE_JSON_RELATIVE = "node_modules/poiesis-cli/package.json";
/**
 * Root-local executable shim under a normal isolated pnpm (or npm) linker.
 * Spec #219 / ticket #220 — readiness requires this path to be usable; there is
 * no dlx / global / member-package fallback.
 */
export const LOCAL_CLI_BIN_RELATIVE = "node_modules/.bin/poiesis";
/** Selfhost built entry; probed with `node dist/cli.js --version`. */
export const SELFHOST_DIST_CLI_RELATIVE = "dist/cli.js";

export type SupportedPackageManager = "npm" | "pnpm";
export type PackageLockfileName = "package-lock.json" | "pnpm-lock.yaml";
export type PackageProjectKind = "ordinary" | "selfhost";
/**
 * Spec #219 / ticket #220 — where native package-manager ops must run.
 * Carried on plans and executor requests only; never written into the durable
 * `packageContribution` record schema.
 */
export type PackageExecutionScope =
  | { kind: "single-package" }
  | { kind: "pnpm-workspace-root" };
export type { PackageContributionRecord };

/**
 * Assert the resolved local `poiesis-cli` package version equals the installed
 * target. Reads `node_modules/poiesis-cli/package.json` (injected for tests).
 */
export function assertResolvedLocalCliVersion(args: {
  expectedVersion: string;
  installedPackageJson: string | null;
  path?: string;
}): void {
  const path = args.path ?? LOCAL_CLI_PACKAGE_JSON_RELATIVE;
  if (args.installedPackageJson === null) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "poiesis-cli was not resolved under node_modules after the native package-manager install",
      { path, expectedVersion: args.expectedVersion },
    );
  }
  let document: unknown;
  try {
    document = parseJsonc<unknown>(args.installedPackageJson, path);
  } catch (error) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "Resolved poiesis-cli package.json is not valid JSON",
      { path, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    typeof document !== "object" ||
    document === null ||
    !("version" in document) ||
    typeof (document as { version: unknown }).version !== "string" ||
    (document as { version: string }).version.length === 0
  ) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "Resolved poiesis-cli package.json does not declare a version",
      { path },
    );
  }
  const actual = (document as { version: string }).version;
  if (actual !== args.expectedVersion) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_VERSION_MISMATCH",
      "Resolved local poiesis-cli version does not equal the installed target",
      { path, expectedVersion: args.expectedVersion, actualVersion: actual },
    );
  }
}

/**
 * Spec #219 / ticket #220 — ordinary readiness also requires a usable
 * root-local executable under the normal isolated linker layout
 * (`node_modules/.bin/poiesis`). Missing bin or version-probe mismatch fails
 * closed; there is no dlx/global/member fallback.
 */
export function assertResolvedLocalCliExecutable(args: {
  expectedVersion: string;
  /** Whether `node_modules/.bin/poiesis` exists (file or symlink). */
  present: boolean;
  /**
   * Optional `poiesis --version` (or equivalent) probe of that bin. When
   * omitted, presence alone is accepted (pure unit tests). Production paths
   * should probe.
   */
  versionProbe?: { ok: true; stdout: string } | { ok: false; detail?: string };
  path?: string;
}): void {
  const path = args.path ?? LOCAL_CLI_BIN_RELATIVE;
  if (!args.present) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "poiesis-cli root-local executable was not resolved under node_modules/.bin after the native package-manager install",
      { path, expectedVersion: args.expectedVersion },
    );
  }
  if (args.versionProbe === undefined) return;
  if (!args.versionProbe.ok) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "poiesis-cli root-local executable could not be probed",
      {
        path,
        expectedVersion: args.expectedVersion,
        detail: args.versionProbe.detail,
      },
    );
  }
  const actual = args.versionProbe.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (actual.length === 0) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "poiesis-cli root-local executable produced no version output",
      { path, expectedVersion: args.expectedVersion },
    );
  }
  if (actual !== args.expectedVersion) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_VERSION_MISMATCH",
      "Resolved local poiesis-cli executable version does not equal the installed target",
      { path, expectedVersion: args.expectedVersion, actualVersion: actual },
    );
  }
}

/**
 * Selfhost readiness: probe `node dist/cli.js --version` directly (no package
 * script execution). Missing/unbuilt/stale dist is a typed fail-closed condition.
 */
export function assertSelfhostDistReady(args: {
  expectedVersion: string;
  /** Injected probe result: null ⇒ missing binary / spawn failure. */
  probe: { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string };
}): void {
  if (!args.probe.ok) {
    if (args.probe.code === "missing") {
      throw new PoiesisError(
        "SELFHOST_DIST_MISSING",
        "Selfhost poiesis-cli requires a built dist/cli.js before local invocation can be configured",
        { path: SELFHOST_DIST_CLI_RELATIVE, expectedVersion: args.expectedVersion },
      );
    }
    throw new PoiesisError(
      "SELFHOST_DIST_UNREADABLE",
      "Could not probe selfhost dist/cli.js with node --version",
      {
        path: SELFHOST_DIST_CLI_RELATIVE,
        expectedVersion: args.expectedVersion,
        detail: args.probe.detail,
      },
    );
  }
  const actual = args.probe.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (actual.length === 0) {
    throw new PoiesisError(
      "SELFHOST_DIST_VERSION_MISMATCH",
      "Selfhost dist/cli.js --version produced no version output",
      { path: SELFHOST_DIST_CLI_RELATIVE, expectedVersion: args.expectedVersion },
    );
  }
  if (actual !== args.expectedVersion) {
    throw new PoiesisError(
      "SELFHOST_DIST_VERSION_MISMATCH",
      "Selfhost dist/cli.js version does not equal the package runtime version",
      {
        path: SELFHOST_DIST_CLI_RELATIVE,
        expectedVersion: args.expectedVersion,
        actualVersion: actual,
      },
    );
  }
}

/** Production selfhost probe: `node dist/cli.js --version` under the primary root. */
export async function probeSelfhostDistVersion(
  root: string,
  run: (command: string, args: string[], options: { cwd: string; allowFailure: true }) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>,
): Promise<{ ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }> {
  const { exists } = await import("./fs.js");
  const { join } = await import("node:path");
  const distPath = join(root, SELFHOST_DIST_CLI_RELATIVE);
  if (!(await exists(distPath))) {
    return { ok: false, code: "missing" };
  }
  try {
    const result = await run("node", [SELFHOST_DIST_CLI_RELATIVE, "--version"], {
      cwd: root,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: "spawn-failed",
        detail: result.stderr.trim() || `exit ${result.exitCode}`,
      };
    }
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return {
      ok: false,
      code: "spawn-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type PackageFsSnapshot = {
  packageJson: string | null;
  lockfiles: {
    "pnpm-lock.yaml": string | null;
    "package-lock.json": string | null;
    "yarn.lock": string | null;
    "bun.lock": string | null;
    "bun.lockb": string | null;
    "pnpm-workspace.yaml": string | null;
  };
  /**
   * Spec #219 / ticket #220 — optional root `.npmrc` text used to refuse
   * disabled or redirected shared-workspace lock contracts. `null`/omitted =
   * absent file (defaults apply).
   */
  npmrc?: string | null;
  /**
   * Spec #219 / ticket #220 — when true, a parent of the installation root
   * owns a `pnpm-workspace.yaml`, so the effective pnpm workspace root is not
   * the Poiesis installation root. Production load walks parents; pure tests
   * inject the flag.
   */
  outerPnpmWorkspace?: boolean;
};

export type PackageManagerResolution =
  | { kind: "absent" }
  | {
      kind: "supported";
      manager: SupportedPackageManager;
      lockfile: PackageLockfileName;
      /** Spec #219 — plan/executor scope only; never durable ownership schema. */
      executionScope: PackageExecutionScope;
    }
  | {
      kind: "unsupported";
      code: "PACKAGE_MANAGER_AMBIGUOUS" | "PACKAGE_MANAGER_UNSUPPORTED" | "PACKAGE_WORKSPACE_UNSUPPORTED";
      message: string;
      details: Record<string, unknown>;
    };

export type LockfileOperation =
  | { op: "add-dev"; name: typeof POIESIS_CLI_PACKAGE_NAME; version: string }
  | { op: "remove-dev"; name: typeof POIESIS_CLI_PACKAGE_NAME }
  | null;

/**
 * Exact native package-manager argv for a lock/dep operation.
 * Add-dev always pins exact (`-E` / `--save-exact` equivalent) and runs with
 * `--ignore-scripts`.
 * Spec #219 / ticket #220 — pnpm workspace-root scope adds explicit `-w`
 * (`--workspace-root`) so a member package is never selected accidentally.
 *
 * Spec #219 / ticket #221 — remove-dev runs **after** the journal already wrote
 * planned package.json without the owned dep. `pnpm remove` rejects
 * `--ignore-scripts` and fails with `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS` once
 * the name is gone from package.json; npm uninstall of a missing name is
 * equally unreliable. Reconcile lockfile + node_modules via
 * `install --ignore-scripts` under the same execution scope (pnpm keeps `-w`
 * for workspace-root). The planned package.json bytes stay authoritative;
 * native side effects are still not claimed rolled back on failure.
 */
export function nativePackageManagerArgv(
  manager: SupportedPackageManager,
  operation: Exclude<LockfileOperation, null>,
  executionScope: PackageExecutionScope = { kind: "single-package" },
): readonly string[] {
  if (manager === "pnpm") {
    const workspaceRoot =
      executionScope.kind === "pnpm-workspace-root" ? (["-w"] as const) : ([] as const);
    if (operation.op === "add-dev") {
      return [
        "add",
        ...workspaceRoot,
        "-D",
        "-E",
        `${operation.name}@${operation.version}`,
        "--ignore-scripts",
      ];
    }
    return ["install", ...workspaceRoot, "--ignore-scripts"];
  }
  if (operation.op === "add-dev") {
    return ["install", "-D", "-E", `${operation.name}@${operation.version}`, "--ignore-scripts"];
  }
  return ["install", "--ignore-scripts"];
}

/**
 * Mode for package contribution planning: repair only when an authenticated
 * prior ownership record exists. Without prior, callers must use ensure so
 * foreign scripts/deps stay fail-closed.
 */
export function packageContributionMode(
  prior: PackageContributionRecord | undefined,
): "ensure" | "repair" {
  return prior !== undefined ? "repair" : "ensure";
}
export type PackageContributionPlan =
  | { kind: "absent" }
  | {
      kind: "noop";
      record: PackageContributionRecord;
      packageJsonChanged: false;
      lockfileOperation: null;
      nextPackageJson?: undefined;
      preserved?: undefined;
      /**
       * Spec #219 / ticket #220 — validated execution scope for native ops.
       * Plan/runtime context only; not part of durable package ownership schema.
       */
      executionScope: PackageExecutionScope;
      /**
       * `sha256` of the package.json bytes this noop was observed against when
       * package.json was present at plan time. Required for every contribution
       * noop that retains/advances `packageContribution` — bind via
       * {@link assertPackageContributionCaptureIdentity} before runtime
       * readiness and before successful manifest/receipt. Omitted only when
       * removal observes no package.json (nothing to bind).
       */
      expectedPackageJsonPreimageHash?: string;
    }
  | {
      kind: "apply";
      record: PackageContributionRecord;
      packageJsonChanged: boolean;
      lockfileOperation: LockfileOperation;
      nextPackageJson: string;
      /**
       * Spec #219 / ticket #220 — validated execution scope for native ops.
       * Plan/runtime context only; not part of durable package ownership schema.
       */
      executionScope: PackageExecutionScope;
      /**
       * `sha256` of the **original** package.json snapshot bytes this plan was
       * computed from — never `nextPackageJson`. Callers that await work between
       * plan and `journal.capture` must bind capture preimage/identity to this
       * hash via {@link assertPackageContributionCaptureIdentity} before any
       * Poiesis-authored package replacement or native pm step.
       */
      expectedPackageJsonPreimageHash: string;
      /** Paths left untouched because foreign content no longer matches ownership. */
      preserved?: Array<{ path: string[]; reason: string }>;
    };

/**
 * Non-absent package plan that carries an original package.json preimage hash
 * and may retain/advance `manifest.packageContribution` (apply writes, or noop
 * ownership record). Used by the shared plan-to-capture gate.
 */
export type PackageContributionPlanWithPreimage =
  | Extract<PackageContributionPlan, { kind: "apply" }>
  | (Extract<PackageContributionPlan, { kind: "noop" }> & {
      expectedPackageJsonPreimageHash: string;
    });

/**
 * True when the plan is apply or a noop that retains contribution against a
 * known package.json preimage hash. Absent plans and removal noops without
 * package.json are excluded.
 */
export function packagePlanRetainsContribution(
  plan: PackageContributionPlan,
): plan is PackageContributionPlanWithPreimage {
  if (plan.kind === "apply") return true;
  return plan.kind === "noop" && plan.expectedPackageJsonPreimageHash !== undefined;
}

/**
 * Bind a package contribution **apply or noop** plan to the observed
 * `package.json` identity (journal capture preimage/identity, or current file
 * bytes). The plan is a statement about one specific original snapshot; a
 * writer that lands between plan and observation must not cause a stale
 * ownership record or a stale `nextPackageJson` overwrite to advance.
 *
 * Compares `plan.expectedPackageJsonPreimageHash` (original snapshot identity)
 * against the observation — never against `plan.nextPackageJson`. Raises
 * `ARTIFACT_IDENTITY_DRIFT` before write/native executor/runtime-ready success
 * and before successful manifest/receipt so ownership cannot advance on drifted
 * bytes. Noop paths must not write package bytes or bind
 * `transactionWrittenIdentity`. Existing journal capture-to-write guards remain
 * for the post-capture apply window.
 */
export function assertPackageContributionCaptureIdentity(
  plan: PackageContributionPlanWithPreimage | { expectedPackageJsonPreimageHash: string },
  observed:
    | Pick<ArtifactJournalEntry, "preimage" | "expectedPreWriteIdentity">
    | { packageJsonContent: string },
): void {
  const expected = plan.expectedPackageJsonPreimageHash;
  if ("packageJsonContent" in observed) {
    if (hashContent(observed.packageJsonContent) !== expected) {
      throw new PoiesisError(
        "ARTIFACT_IDENTITY_DRIFT",
        "package.json changed while preparing the package contribution",
        { path: PACKAGE_JSON_RELATIVE },
      );
    }
    return;
  }
  const identity = observed.expectedPreWriteIdentity;
  const preimage = observed.preimage;
  const preimageHash = preimage === undefined ? undefined : hashContent(preimage);
  const identityHash = identity.exists && identity.kind === "file" ? identity.hash : undefined;
  const matchesPlan =
    preimageHash === expected &&
    identityHash === expected &&
    identity.exists === true &&
    identity.kind === "file";
  if (!matchesPlan) {
    throw new PoiesisError(
      "ARTIFACT_IDENTITY_DRIFT",
      "package.json changed while preparing the package contribution",
      { path: PACKAGE_JSON_RELATIVE },
    );
  }
}

/**
 * Noop plan that retains/advances `packageContribution` against a known
 * original package.json preimage hash.
 */
export type PackageContributionNoopPlan = Extract<PackageContributionPlan, { kind: "noop" }> & {
  expectedPackageJsonPreimageHash: string;
};

/** True when the plan is a hashed noop that retains contribution (not apply, not absent). */
export function packagePlanIsNoopWithPreimage(
  plan: PackageContributionPlan,
): plan is PackageContributionNoopPlan {
  return plan.kind === "noop" && plan.expectedPackageJsonPreimageHash !== undefined;
}

/**
 * Shared publication boundary for package contribution that retains
 * `manifest.packageContribution` — both **apply** and hashed **noop**.
 * Call only after:
 *   - runtime readiness,
 *   - all manifest object construction / serialization / version resolution / hash,
 *   - and any `preManifestWrite` hooks.
 *
 * Freshly reads `package.json`, then validates:
 *   - noop: original plan preimage hash via {@link assertPackageContributionCaptureIdentity}
 *   - apply: {@link assertPackageContributionMatches} against the applied/next
 *     record (exact script, exact devDependency path, no foreign non-dev section;
 *     selfhost: script + no poiesis-cli dependency)
 *
 * Immediately invokes `writeManifest` with **no** unrelated awaited work or
 * hook between the validate and the first ownership-bearing manifest write.
 * Missing/unreadable package.json → `ARTIFACT_IDENTITY_DRIFT` (writer not called).
 * Contribution mismatch propagates typed `PACKAGE_CONTRIBUTION_MISMATCH` /
 * `PACKAGE_SELF_DEPENDENCY`. Does **not** write package.json, does **not** bind
 * `transactionWrittenIdentity` from the reread, and claims no lock/`node_modules`
 * rollback. The writer callback is outside the read catch so writer errors
 * propagate. Receipt stays after the ownership-bearing writer.
 */
export async function writeManifestWithPackageContributionGate(args: {
  check:
    | { kind: "noop"; plan: PackageContributionNoopPlan | { expectedPackageJsonPreimageHash: string } }
    | { kind: "apply"; record: PackageContributionRecord };
  /** Fresh reader; `null` or throw → identity drift (writer not invoked). */
  readPackageJson: () => Promise<string | null>;
  /** First ownership-bearing manifest write (atomicCreate / journal.replace). */
  writeManifest: () => Promise<void>;
}): Promise<void> {
  let content: string | null;
  try {
    content = await args.readPackageJson();
  } catch {
    content = null;
  }
  if (content === null) {
    throw new PoiesisError(
      "ARTIFACT_IDENTITY_DRIFT",
      "package.json changed while preparing the package contribution",
      { path: PACKAGE_JSON_RELATIVE },
    );
  }
  if (args.check.kind === "noop") {
    assertPackageContributionCaptureIdentity(args.check.plan, { packageJsonContent: content });
  } else {
    assertPackageContributionMatches(content, args.check.record);
  }
  // Immediate ownership-bearing write — no hooks or other awaits between validate and write.
  // Writer is outside the read catch so its errors propagate unchanged.
  await args.writeManifest();
}

/**
 * Publication boundary for a **noop** package contribution that retains
 * `manifest.packageContribution`. Thin wrapper over
 * {@link writeManifestWithPackageContributionGate} preserving the original
 * snapshot hash assertion. Prefer the unified gate at production call sites.
 */
export async function writeManifestWithNoopPackageContributionGate(args: {
  plan: PackageContributionNoopPlan | { expectedPackageJsonPreimageHash: string };
  /** Fresh reader; `null` or throw → identity drift (writer not invoked). */
  readPackageJson: () => Promise<string | null>;
  /** First ownership-bearing manifest write (atomicCreate / journal.replace). */
  writeManifest: () => Promise<void>;
}): Promise<void> {
  await writeManifestWithPackageContributionGate({
    check: { kind: "noop", plan: args.plan },
    readPackageJson: args.readPackageJson,
    writeManifest: args.writeManifest,
  });
}

export type PackageManagerExecutor = {
  apply(request: {
    manager: SupportedPackageManager;
    operation: Exclude<LockfileOperation, null>;
    packageJson: string;
    lockfile: string;
    ignoreScripts: true;
    /** Spec #219 — explicit workspace-root vs single-package native semantics. */
    executionScope: PackageExecutionScope;
  }): Promise<{ packageJson: string; lockfile: string }>;
};

type JsonObject = Record<string, unknown>;

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}

function parsePackageObject(content: string): JsonObject {
  const document = parseJsonc<unknown>(content, PACKAGE_JSON_RELATIVE);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new PoiesisError("INVALID_PACKAGE_JSON", "package.json is not a JSON object", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }
  const record = document as JsonObject;
  if (Object.hasOwn(record, "scripts")) {
    const scripts = record.scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
      throw new PoiesisError("INVALID_PACKAGE_JSON", 'package.json "scripts" is not a JSON object', {
        path: ["scripts"],
      });
    }
  }
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    if (!Object.hasOwn(record, key)) continue;
    const deps = record[key];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
      throw new PoiesisError("INVALID_PACKAGE_JSON", `package.json "${key}" is not a JSON object`, {
        path: [key],
      });
    }
  }
  return record;
}

function getAtPath(value: unknown, path: readonly string[]): { exists: boolean; value?: unknown } {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
      return { exists: false };
    }
    current = (current as JsonObject)[part];
  }
  return { exists: true, value: current };
}

function hasWorkspacesField(document: JsonObject): boolean {
  if (!Object.hasOwn(document, "workspaces")) return false;
  const workspaces = document.workspaces;
  if (Array.isArray(workspaces) && workspaces.length > 0) return true;
  if (typeof workspaces === "object" && workspaces !== null && !Array.isArray(workspaces)) {
    const packages = (workspaces as JsonObject).packages;
    if (Array.isArray(packages) && packages.length > 0) return true;
  }
  return false;
}

/**
 * Spec #219 / ticket #220 — parse root `.npmrc` for shared-workspace lock
 * contract settings. Unknown keys are ignored. Fail-closed values surface as
 * structured flags for {@link resolvePackageManagerOwnership}.
 */
export function parsePnpmSharedLockSettings(npmrc: string | null | undefined): {
  sharedWorkspaceLockfile: boolean | undefined;
  /** Raw lockfile-dir value when set; undefined when absent. */
  lockfileDir: string | undefined;
} {
  if (npmrc === null || npmrc === undefined || npmrc.length === 0) {
    return { sharedWorkspaceLockfile: undefined, lockfileDir: undefined };
  }
  let sharedWorkspaceLockfile: boolean | undefined;
  let lockfileDir: string | undefined;
  for (const rawLine of npmrc.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === "shared-workspace-lockfile") {
      if (value === "false" || value === "0") sharedWorkspaceLockfile = false;
      else if (value === "true" || value === "1") sharedWorkspaceLockfile = true;
    } else if (key === "lockfile-dir") {
      lockfileDir = value.length === 0 ? undefined : value;
    }
  }
  return { sharedWorkspaceLockfile, lockfileDir };
}

/**
 * Spec #219 / ticket #220 — package.json `pnpm.sharedWorkspaceLockfile` when set.
 */
export function readPackageJsonPnpmSharedLockfile(document: JsonObject): boolean | undefined {
  if (!Object.hasOwn(document, "pnpm")) return undefined;
  const pnpm = document.pnpm;
  if (typeof pnpm !== "object" || pnpm === null || Array.isArray(pnpm)) return undefined;
  if (!Object.hasOwn(pnpm as JsonObject, "sharedWorkspaceLockfile")) return undefined;
  const value = (pnpm as JsonObject).sharedWorkspaceLockfile;
  if (value === false) return false;
  if (value === true) return true;
  return undefined;
}

/**
 * Spec #219 / ticket #223 — package.json `pnpm.lockfileDir` when set as a string.
 * Non-string values are treated as unresolved ambiguity by the caller.
 */
export function readPackageJsonPnpmLockfileDir(document: JsonObject): {
  lockfileDir: string | undefined;
  ambiguous: boolean;
} {
  if (!Object.hasOwn(document, "pnpm")) return { lockfileDir: undefined, ambiguous: false };
  const pnpm = document.pnpm;
  if (typeof pnpm !== "object" || pnpm === null || Array.isArray(pnpm)) {
    return { lockfileDir: undefined, ambiguous: false };
  }
  if (!Object.hasOwn(pnpm as JsonObject, "lockfileDir")) {
    return { lockfileDir: undefined, ambiguous: false };
  }
  const value = (pnpm as JsonObject).lockfileDir;
  if (typeof value === "string") {
    return { lockfileDir: value.length === 0 ? undefined : value, ambiguous: false };
  }
  return { lockfileDir: undefined, ambiguous: true };
}

/**
 * Spec #219 / ticket #223 — parse top-level shared-lock settings from
 * `pnpm-workspace.yaml`. Accepts camelCase and kebab-case scalar forms only.
 * Nested/complex values for these keys are ambiguous (fail closed).
 */
export function parsePnpmWorkspaceYamlLockSettings(yaml: string | null | undefined): {
  sharedWorkspaceLockfile: boolean | undefined;
  lockfileDir: string | undefined;
  ambiguous: boolean;
} {
  if (yaml === null || yaml === undefined || yaml.length === 0) {
    return { sharedWorkspaceLockfile: undefined, lockfileDir: undefined, ambiguous: false };
  }
  let sharedWorkspaceLockfile: boolean | undefined;
  let lockfileDir: string | undefined;
  let ambiguous = false;
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    // Top-level keys only (no leading whitespace).
    if (rawLine.length === 0 || /^\s/.test(rawLine) || rawLine.trimStart().startsWith("#")) continue;
    const line = rawLine.replace(/\s+#.*$/, "").trimEnd();
    const match = /^(sharedWorkspaceLockfile|shared-workspace-lockfile|lockfileDir|lockfile-dir)\s*:\s*(.*)$/.exec(
      line,
    );
    if (match === null) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (value.length === 0) {
      // Multiline / nested form — refuse unresolved ambiguity.
      const next = lines[i + 1];
      if (next !== undefined && /^\s+\S/.test(next)) {
        ambiguous = true;
        continue;
      }
      // Empty scalar: treat shared lock as unset; empty lockfileDir as unset.
      continue;
    }
    // Strip simple YAML quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === "sharedWorkspaceLockfile" || key === "shared-workspace-lockfile") {
      const lower = value.toLowerCase();
      if (lower === "false" || lower === "0" || lower === "no") sharedWorkspaceLockfile = false;
      else if (lower === "true" || lower === "1" || lower === "yes") sharedWorkspaceLockfile = true;
      else ambiguous = true;
    } else if (key === "lockfileDir" || key === "lockfile-dir") {
      if (value.startsWith("{") || value.startsWith("[") || value === "|" || value === ">") {
        ambiguous = true;
      } else {
        lockfileDir = value.length === 0 ? undefined : value;
      }
    }
  }
  return { sharedWorkspaceLockfile, lockfileDir, ambiguous };
}

/**
 * Spec #219 / ticket #223 — effective shared-lock contract from `.npmrc`,
 * package.json `pnpm.*`, and `pnpm-workspace.yaml`.
 *
 * Precedence (highest wins): root `.npmrc` → package.json `pnpm` → workspace YAML.
 * Unresolved / unparseable values fail closed via `ambiguous: true`.
 */
export function resolveEffectivePnpmSharedLockSettings(
  snapshot: PackageFsSnapshot,
  document: JsonObject,
): {
  sharedWorkspaceLockfile: boolean | undefined;
  lockfileDir: string | undefined;
  /** Winning source for a refusing sharedWorkspaceLockfile=false / external lockfileDir. */
  sharedSource: "npmrc" | "package.json" | "pnpm-workspace.yaml" | undefined;
  lockfileDirSource: "npmrc" | "package.json" | "pnpm-workspace.yaml" | undefined;
  ambiguous: boolean;
} {
  const npmrc = parsePnpmSharedLockSettings(snapshot.npmrc);
  const pkgShared = readPackageJsonPnpmSharedLockfile(document);
  const pkgLock = readPackageJsonPnpmLockfileDir(document);
  const ws = parsePnpmWorkspaceYamlLockSettings(snapshot.lockfiles["pnpm-workspace.yaml"]);

  if (pkgLock.ambiguous || ws.ambiguous) {
    return {
      sharedWorkspaceLockfile: undefined,
      lockfileDir: undefined,
      sharedSource: undefined,
      lockfileDirSource: undefined,
      ambiguous: true,
    };
  }

  let sharedWorkspaceLockfile: boolean | undefined;
  let sharedSource: "npmrc" | "package.json" | "pnpm-workspace.yaml" | undefined;
  if (npmrc.sharedWorkspaceLockfile !== undefined) {
    sharedWorkspaceLockfile = npmrc.sharedWorkspaceLockfile;
    sharedSource = "npmrc";
  } else if (pkgShared !== undefined) {
    sharedWorkspaceLockfile = pkgShared;
    sharedSource = "package.json";
  } else if (ws.sharedWorkspaceLockfile !== undefined) {
    sharedWorkspaceLockfile = ws.sharedWorkspaceLockfile;
    sharedSource = "pnpm-workspace.yaml";
  }

  let lockfileDir: string | undefined;
  let lockfileDirSource: "npmrc" | "package.json" | "pnpm-workspace.yaml" | undefined;
  if (npmrc.lockfileDir !== undefined) {
    lockfileDir = npmrc.lockfileDir;
    lockfileDirSource = "npmrc";
  } else if (pkgLock.lockfileDir !== undefined) {
    lockfileDir = pkgLock.lockfileDir;
    lockfileDirSource = "package.json";
  } else if (ws.lockfileDir !== undefined) {
    lockfileDir = ws.lockfileDir;
    lockfileDirSource = "pnpm-workspace.yaml";
  }

  return {
    sharedWorkspaceLockfile,
    lockfileDir,
    sharedSource,
    lockfileDirSource,
    ambiguous: false,
  };
}

/**
 * True when lockfile-dir redirects the lock outside the authoritative root.
 * Only `.` / `./` (and empty) are accepted as root-local; any other value
 * fails closed — Poiesis does not rewrite pnpm configuration to gain eligibility.
 */
export function isExternalLockfileDir(lockfileDir: string | undefined): boolean {
  if (lockfileDir === undefined) return false;
  const normalized = lockfileDir.trim().replace(/\\/g, "/");
  if (normalized.length === 0) return false;
  if (normalized === "." || normalized === "./") return false;
  return true;
}

/**
 * Spec #219 / ticket #223 — revalidate live eligibility + execution scope
 * immediately before package.json write or native executor invocation.
 * Planning-time scope is not trusted after `.npmrc` / workspace configuration
 * can drift. Shared by apply and removal mutation paths.
 */
export function assertLivePackageMutationEligibility(args: {
  liveSnapshot: PackageFsSnapshot;
  expectedManager: SupportedPackageManager;
  expectedLockfile: PackageLockfileName;
  expectedExecutionScope: PackageExecutionScope;
}): void {
  const resolution = resolvePackageManagerOwnership(args.liveSnapshot);
  if (resolution.kind === "absent") {
    throw new PoiesisError(
      "PACKAGE_MANAGER_UNSUPPORTED",
      "Live package eligibility is absent; refuse package mutation and native execution",
      {
        liveEligibilityDrift: true,
        planned: {
          manager: args.expectedManager,
          lockfile: args.expectedLockfile,
          executionScope: args.expectedExecutionScope,
        },
      },
    );
  }
  if (resolution.kind === "unsupported") {
    throw new PoiesisError(resolution.code, resolution.message, {
      ...resolution.details,
      liveEligibilityDrift: true,
      planned: {
        manager: args.expectedManager,
        lockfile: args.expectedLockfile,
        executionScope: args.expectedExecutionScope,
      },
    });
  }
  const scopeMatches = isDeepStrictEqual(resolution.executionScope, args.expectedExecutionScope);
  if (
    resolution.manager !== args.expectedManager ||
    resolution.lockfile !== args.expectedLockfile ||
    !scopeMatches
  ) {
    throw new PoiesisError(
      resolution.manager !== args.expectedManager || resolution.lockfile !== args.expectedLockfile
        ? "PACKAGE_MANAGER_AMBIGUOUS"
        : "PACKAGE_WORKSPACE_UNSUPPORTED",
      "Live package eligibility or execution scope no longer matches the planned contribution; refuse package mutation and native execution",
      {
        liveEligibilityDrift: true,
        planned: {
          manager: args.expectedManager,
          lockfile: args.expectedLockfile,
          executionScope: args.expectedExecutionScope,
        },
        live: {
          manager: resolution.manager,
          lockfile: resolution.lockfile,
          executionScope: resolution.executionScope,
        },
      },
    );
  }
}

function unsupportedWorkspace(
  message: string,
  details: Record<string, unknown>,
): Extract<PackageManagerResolution, { kind: "unsupported" }> {
  return {
    kind: "unsupported",
    code: "PACKAGE_WORKSPACE_UNSUPPORTED",
    message,
    details,
  };
}

export function resolvePackageManagerOwnership(snapshot: PackageFsSnapshot): PackageManagerResolution {
  if (snapshot.packageJson === null) return { kind: "absent" };

  let document: JsonObject;
  try {
    document = parsePackageObject(snapshot.packageJson);
  } catch (error) {
    if (error instanceof PoiesisError) throw error;
    throw new PoiesisError("INVALID_PACKAGE_JSON", "package.json is not valid JSON", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }

  const npmWorkspaces = hasWorkspacesField(document);
  const pnpmWorkspaceFile = present(snapshot.lockfiles["pnpm-workspace.yaml"]);
  const pnpm = present(snapshot.lockfiles["pnpm-lock.yaml"]);
  const npm = present(snapshot.lockfiles["package-lock.json"]);
  const yarn = present(snapshot.lockfiles["yarn.lock"]);
  const bun = present(snapshot.lockfiles["bun.lock"]) || present(snapshot.lockfiles["bun.lockb"]);

  // Spec #219 / ticket #220 correction — outer/non-root effective workspace scope
  // fails closed for every non-absent package.json path, whether or not a local
  // pnpm-workspace.yaml exists. A nested project under an outer pnpm workspace
  // must never resolve as single-package ownership.
  if (snapshot.outerPnpmWorkspace === true) {
    return unsupportedWorkspace(
      "Poiesis installation root is inside an outer pnpm workspace; the effective workspace root must equal the authoritative installation root",
      {
        outerPnpmWorkspace: true,
        pnpmWorkspace: pnpmWorkspaceFile,
        packageWorkspaces: npmWorkspaces,
      },
    );
  }

  // npm package.json workspaces remain unsupported in Spec #219.
  if (npmWorkspaces) {
    return unsupportedWorkspace(
      "Poiesis cannot safely own package/lock contributions in an npm workspaces project; use a single-package project or an eligible root-aligned pnpm workspace",
      {
        pnpmWorkspace: pnpmWorkspaceFile,
        packageWorkspaces: true,
      },
    );
  }

  if (pnpmWorkspaceFile) {
    // Spec #219 / ticket #223 — effective lock contract from .npmrc, package.json
    // pnpm.*, and pnpm-workspace.yaml (precedence + fail-closed ambiguity).
    const effective = resolveEffectivePnpmSharedLockSettings(snapshot, document);

    if (effective.ambiguous) {
      return unsupportedWorkspace(
        "pnpm shared-workspace lock settings are ambiguous or unparseable; Poiesis refuses unresolved workspace lock ownership",
        {
          ambiguousWorkspaceLockSettings: true,
          pnpmWorkspace: true,
        },
      );
    }

    if (effective.sharedWorkspaceLockfile === false) {
      return unsupportedWorkspace(
        "pnpm shared-workspace-lockfile is disabled; Poiesis requires the shared root lockfile contract for workspace ownership",
        {
          sharedWorkspaceLockfile: false,
          pnpmWorkspace: true,
          ...(effective.sharedSource === undefined ? {} : { source: effective.sharedSource }),
        },
      );
    }

    if (isExternalLockfileDir(effective.lockfileDir)) {
      return unsupportedWorkspace(
        "pnpm lockfile-dir redirects the lockfile away from the authoritative installation root; Poiesis refuses external lock ownership",
        {
          lockfileDir: effective.lockfileDir,
          pnpmWorkspace: true,
          ...(effective.lockfileDirSource === undefined
            ? {}
            : { source: effective.lockfileDirSource }),
        },
      );
    }

    if (yarn || bun) {
      return {
        kind: "unsupported",
        code: "PACKAGE_MANAGER_UNSUPPORTED",
        message: "Only npm and pnpm lock ownership are supported for local Poiesis package invocation",
        details: { yarn, bun, supported: ["npm", "pnpm"], pnpmWorkspace: true },
      };
    }

    if (pnpm && npm) {
      return {
        kind: "unsupported",
        code: "PACKAGE_MANAGER_AMBIGUOUS",
        message: "Both pnpm-lock.yaml and package-lock.json are present; refuse to choose a package manager",
        details: { lockfiles: ["pnpm-lock.yaml", "package-lock.json"], pnpmWorkspace: true },
      };
    }

    if (!pnpm) {
      return {
        kind: "unsupported",
        code: "PACKAGE_MANAGER_UNSUPPORTED",
        message:
          "Root pnpm-workspace.yaml is present without a root pnpm-lock.yaml; refuse to invent lock ownership for a workspace",
        details: {
          pnpmWorkspace: true,
          supportedLockfiles: ["pnpm-lock.yaml"],
        },
      };
    }

    return {
      kind: "supported",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      executionScope: { kind: "pnpm-workspace-root" },
    };
  }

  if (pnpm && npm) {
    return {
      kind: "unsupported",
      code: "PACKAGE_MANAGER_AMBIGUOUS",
      message: "Both pnpm-lock.yaml and package-lock.json are present; refuse to choose a package manager",
      details: { lockfiles: ["pnpm-lock.yaml", "package-lock.json"] },
    };
  }

  if (yarn || bun) {
    return {
      kind: "unsupported",
      code: "PACKAGE_MANAGER_UNSUPPORTED",
      message: "Only npm and pnpm lock ownership are supported for local Poiesis package invocation",
      details: {
        yarn: yarn,
        bun: bun,
        supported: ["npm", "pnpm"],
      },
    };
  }

  if (pnpm) {
    return {
      kind: "supported",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      executionScope: { kind: "single-package" },
    };
  }
  if (npm) {
    return {
      kind: "supported",
      manager: "npm",
      lockfile: "package-lock.json",
      executionScope: { kind: "single-package" },
    };
  }

  return {
    kind: "unsupported",
    code: "PACKAGE_MANAGER_UNSUPPORTED",
    message:
      "package.json is present without a supported lockfile (pnpm-lock.yaml or package-lock.json); refuse to invent lock ownership",
    details: { supportedLockfiles: ["pnpm-lock.yaml", "package-lock.json"] },
  };
}

export function classifyPackageProject(document: { name?: unknown }): PackageProjectKind {
  return document.name === SELFHOST_PACKAGE_NAME ? "selfhost" : "ordinary";
}

export function desiredScriptValue(kind: PackageProjectKind): string {
  return kind === "selfhost" ? SELFHOST_SCRIPT_VALUE : ORDINARY_SCRIPT_VALUE;
}

export function buildPackageContributionRecord(args: {
  manager: SupportedPackageManager;
  lockfile: PackageLockfileName;
  projectKind: PackageProjectKind;
  scriptValue: string;
  devDependencyVersion?: string;
}): PackageContributionRecord {
  return {
    owned: true,
    manager: args.manager,
    lockfile: args.lockfile,
    projectKind: args.projectKind,
    packageJson: PACKAGE_JSON_RELATIVE,
    scriptName: POIESIS_SCRIPT_NAME,
    scriptValue: args.scriptValue,
    ...(args.devDependencyVersion === undefined ? {} : { devDependencyVersion: args.devDependencyVersion }),
  };
}

const DEPENDENCY_SECTIONS = [
  "devDependencies",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export type PackageDependencyDeclaration = {
  section: DependencySection;
  /** Declared value — string version or malformed non-string. */
  version: unknown;
};

/**
 * Spec #207 / ticket #215 — every `poiesis-cli` declaration across dependency
 * sections, including malformed non-string values. Multiple declarations are
 * all returned (none hidden). Owned path is only exact
 * `devDependencies.poiesis-cli`.
 */
export function collectPoiesisCliDeclarations(document: JsonObject): PackageDependencyDeclaration[] {
  const found: PackageDependencyDeclaration[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const block = document[section];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    if (!Object.hasOwn(block as JsonObject, POIESIS_CLI_PACKAGE_NAME)) continue;
    found.push({ section, version: (block as JsonObject)[POIESIS_CLI_PACKAGE_NAME] });
  }
  return found;
}

function dependencyVersion(document: JsonObject, name: string): { section: string; version: string } | undefined {
  if (name !== POIESIS_CLI_PACKAGE_NAME) {
    for (const section of DEPENDENCY_SECTIONS) {
      const block = document[section];
      if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
      if (!Object.hasOwn(block as JsonObject, name)) continue;
      const version = (block as JsonObject)[name];
      if (typeof version === "string") return { section, version };
    }
    return undefined;
  }
  // Owned lookup: only exact string in devDependencies counts as the owned path.
  const block = document.devDependencies;
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
  if (!Object.hasOwn(block as JsonObject, name)) return undefined;
  const version = (block as JsonObject)[name];
  if (typeof version === "string") return { section: "devDependencies", version };
  return undefined;
}

function foreignNonDevDeclarations(declarations: readonly PackageDependencyDeclaration[]): PackageDependencyDeclaration[] {
  return declarations.filter((d) => d.section !== "devDependencies");
}

function throwForeignDependencyConflict(foreign: readonly PackageDependencyDeclaration[], expected?: string): never {
  throw new PoiesisError(
    "PACKAGE_DEPENDENCY_CONFLICT",
    "package.json declares poiesis-cli outside owned devDependencies or with a conflicting value",
    {
      path: ["devDependencies", POIESIS_CLI_PACKAGE_NAME],
      ...(expected === undefined ? {} : { expected }),
      foreign: foreign.map((d) => ({ section: d.section, version: d.version })),
    },
  );
}

function detectFormattingOptions(content: string): FormattingOptions {
  const lines = content.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const body = line.trimStart();
    if (body.length === 0 || !body.startsWith('"')) continue;
    const indent = line.slice(0, line.length - body.length);
    if (indent.includes("\t")) return { insertSpaces: false, tabSize: 4, eol: "\n" };
    return { insertSpaces: true, tabSize: indent.length === 0 ? 2 : indent.length, eol: "\n" };
  }
  return { insertSpaces: true, tabSize: 2, eol: "\n" };
}

function propertySourceSlices(content: string, object: Node | undefined, exclude: string): string[] {
  return (object?.children ?? [])
    .filter((property) => property.children?.[0]?.value !== exclude)
    .map((property) => content.slice(property.offset, property.offset + property.length));
}

function assertByteMinimalEdit(before: string, after: string, touchedPaths: readonly string[][]): void {
  const afterTree = parseTree(after);
  if (afterTree === undefined || afterTree.type !== "object") {
    throw new PoiesisError("PACKAGE_EDIT_REFUSED", "Refusing to rewrite a non-object package.json", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }
  const beforeTree = parseTree(before);
  if (beforeTree === undefined || beforeTree.type !== "object") {
    throw new PoiesisError("PACKAGE_EDIT_REFUSED", "Refusing to edit a non-object package.json", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }

  // Root properties other than the top-level containers we intentionally touch
  // must keep exact source slices.
  const touchedRoots = new Set(touchedPaths.map((path) => path[0]!));
  for (const root of ["scripts", "devDependencies", "dependencies", "peerDependencies", "optionalDependencies"]) {
    if (!touchedRoots.has(root)) {
      const beforeNode = findNodeAtLocation(beforeTree, [root]);
      const afterNode = findNodeAtLocation(afterTree, [root]);
      const beforeSlice =
        beforeNode === undefined ? null : before.slice(beforeNode.offset, beforeNode.offset + beforeNode.length);
      const afterSlice =
        afterNode === undefined ? null : after.slice(afterNode.offset, afterNode.offset + afterNode.length);
      if (beforeSlice !== afterSlice) {
        throw new PoiesisError(
          "PACKAGE_EDIT_REFUSED",
          "Refusing to write a package.json edit that would reformat unrelated entries",
          { file: PACKAGE_JSON_RELATIVE, path: [root] },
        );
      }
    }
  }

  // Within scripts, siblings of `poiesis` must keep exact bytes.
  if (touchedRoots.has("scripts")) {
    const beforeScripts = findNodeAtLocation(beforeTree, ["scripts"]);
    const afterScripts = findNodeAtLocation(afterTree, ["scripts"]);
    if (
      !isDeepStrictEqual(
        propertySourceSlices(before, beforeScripts, POIESIS_SCRIPT_NAME),
        propertySourceSlices(after, afterScripts, POIESIS_SCRIPT_NAME),
      )
    ) {
      throw new PoiesisError(
        "PACKAGE_EDIT_REFUSED",
        "Refusing to write a package.json edit that would reformat existing scripts",
        { file: PACKAGE_JSON_RELATIVE, path: ["scripts"] },
      );
    }
  }

  // Within devDependencies, siblings of poiesis-cli must keep exact bytes when we touch that section.
  if (touchedRoots.has("devDependencies")) {
    const beforeDeps = findNodeAtLocation(beforeTree, ["devDependencies"]);
    const afterDeps = findNodeAtLocation(afterTree, ["devDependencies"]);
    if (
      !isDeepStrictEqual(
        propertySourceSlices(before, beforeDeps, POIESIS_CLI_PACKAGE_NAME),
        propertySourceSlices(after, afterDeps, POIESIS_CLI_PACKAGE_NAME),
      )
    ) {
      throw new PoiesisError(
        "PACKAGE_EDIT_REFUSED",
        "Refusing to write a package.json edit that would reformat existing devDependencies",
        { file: PACKAGE_JSON_RELATIVE, path: ["devDependencies"] },
      );
    }
  }

  // Other root properties (name, version, private, …) must keep exact source slices.
  if (
    !isDeepStrictEqual(
      propertySourceSlices(before, beforeTree, "scripts").filter((slice) => {
        // Filter is approximate; also drop touched dep sections by comparing root keys separately.
        return true;
      }),
      propertySourceSlices(after, afterTree, "scripts"),
    )
  ) {
    // Stricter check: every root key except scripts/devDependencies must match.
    const beforeRootKeys = (beforeTree.children ?? [])
      .map((property) => property.children?.[0]?.value as string | undefined)
      .filter((key): key is string => typeof key === "string" && key !== "scripts" && key !== "devDependencies");
    for (const key of beforeRootKeys) {
      const beforeNode = findNodeAtLocation(beforeTree, [key]);
      const afterNode = findNodeAtLocation(afterTree, [key]);
      if (beforeNode === undefined || afterNode === undefined) {
        if (beforeNode === undefined && afterNode === undefined) continue;
        throw new PoiesisError(
          "PACKAGE_EDIT_REFUSED",
          "Refusing to write a package.json edit that would reformat existing entries",
          { file: PACKAGE_JSON_RELATIVE, path: [key] },
        );
      }
      const beforeSlice = before.slice(beforeNode.offset, beforeNode.offset + beforeNode.length);
      const afterSlice = after.slice(afterNode.offset, afterNode.offset + afterNode.length);
      if (beforeSlice !== afterSlice) {
        throw new PoiesisError(
          "PACKAGE_EDIT_REFUSED",
          "Refusing to write a package.json edit that would reformat existing entries",
          { file: PACKAGE_JSON_RELATIVE, path: [key] },
        );
      }
    }
  }
}

function applyJsonPathEdit(
  content: string,
  path: readonly string[],
  value: unknown | undefined,
  options: { insertionIndex?: number } = {},
): string {
  return applyEdits(
    content,
    modify(content, [...path], value, {
      formattingOptions: detectFormattingOptions(content),
      ...(options.insertionIndex === undefined ? {} : { getInsertionIndex: () => options.insertionIndex! }),
    }),
  );
}

function setScript(content: string, value: string): string {
  const next = applyJsonPathEdit(content, ["scripts", POIESIS_SCRIPT_NAME], value, { insertionIndex: 0 });
  assertByteMinimalEdit(content, next, [["scripts", POIESIS_SCRIPT_NAME]]);
  if (getAtPath(parsePackageObject(next), ["scripts", POIESIS_SCRIPT_NAME]).value !== value) {
    throw new PoiesisError("PACKAGE_EDIT_REFUSED", "Refusing to write a package.json edit that did not produce the poiesis script", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }
  return next;
}

function removeScript(content: string): string {
  const next = applyJsonPathEdit(content, ["scripts", POIESIS_SCRIPT_NAME], undefined);
  assertByteMinimalEdit(content, next, [["scripts", POIESIS_SCRIPT_NAME]]);
  return next;
}

function setDevDependency(content: string, version: string): string {
  const next = applyJsonPathEdit(content, ["devDependencies", POIESIS_CLI_PACKAGE_NAME], version, {
    insertionIndex: 0,
  });
  assertByteMinimalEdit(content, next, [["devDependencies", POIESIS_CLI_PACKAGE_NAME]]);
  if (getAtPath(parsePackageObject(next), ["devDependencies", POIESIS_CLI_PACKAGE_NAME]).value !== version) {
    throw new PoiesisError(
      "PACKAGE_EDIT_REFUSED",
      "Refusing to write a package.json edit that did not produce the poiesis-cli devDependency",
      { file: PACKAGE_JSON_RELATIVE },
    );
  }
  return next;
}

function removeDevDependency(content: string): string {
  // Owned removal path is only exact devDependencies.poiesis-cli.
  const document = parsePackageObject(content);
  const found = dependencyVersion(document, POIESIS_CLI_PACKAGE_NAME);
  if (found === undefined || found.section !== "devDependencies") return content;
  const next = applyJsonPathEdit(content, ["devDependencies", POIESIS_CLI_PACKAGE_NAME], undefined);
  assertByteMinimalEdit(content, next, [["devDependencies", POIESIS_CLI_PACKAGE_NAME]]);
  return next;
}

function throwIfUnsupported(resolution: PackageManagerResolution): asserts resolution is Extract<
  PackageManagerResolution,
  { kind: "supported" }
> {
  if (resolution.kind === "supported") return;
  if (resolution.kind === "absent") {
    throw new PoiesisError("PACKAGE_MANAGER_UNSUPPORTED", "package.json is absent", {});
  }
  throw new PoiesisError(resolution.code, resolution.message, resolution.details);
}

export function planPackageContribution(args: {
  snapshot: PackageFsSnapshot;
  poiesisVersion: string;
  mode: "ensure" | "repair";
  prior?: PackageContributionRecord | undefined;
}): PackageContributionPlan {
  const resolution = resolvePackageManagerOwnership(args.snapshot);
  if (resolution.kind === "absent") return { kind: "absent" };
  throwIfUnsupported(resolution);

  const content = args.snapshot.packageJson!;
  const expectedPackageJsonPreimageHash = hashContent(content);
  const document = parsePackageObject(content);
  const projectKind = classifyPackageProject(document);
  const scriptValue = desiredScriptValue(projectKind);
  const desiredDepVersion = projectKind === "ordinary" ? args.poiesisVersion : undefined;

  // Spec #207 / ticket #215 — section-aware declarations (all sections + malformed).
  const allDeclarations = collectPoiesisCliDeclarations(document);
  const foreignNonDev = foreignNonDevDeclarations(allDeclarations);
  const devDeclaration = allDeclarations.find((d) => d.section === "devDependencies");
  const existingDep =
    devDeclaration !== undefined && typeof devDeclaration.version === "string"
      ? { section: "devDependencies" as const, version: devDeclaration.version }
      : undefined;

  // Selfhost must never carry a self-dependency in any section.
  if (projectKind === "selfhost" && allDeclarations.length > 0) {
    throw new PoiesisError(
      "PACKAGE_SELF_DEPENDENCY",
      "poiesis-cli must not depend on itself; use scripts.poiesis = node dist/cli.js",
      {
        foreign: allDeclarations.map((d) => ({ section: d.section, version: d.version })),
        path: [allDeclarations[0]!.section, POIESIS_CLI_PACKAGE_NAME],
        version: allDeclarations[0]!.version,
      },
    );
  }

  // Any non-dev declaration is a foreign conflict even at the desired version.
  if (foreignNonDev.length > 0 && desiredDepVersion !== undefined) {
    throwForeignDependencyConflict(foreignNonDev, desiredDepVersion);
  }
  // Malformed devDependencies value (non-string) is also foreign.
  if (devDeclaration !== undefined && typeof devDeclaration.version !== "string" && desiredDepVersion !== undefined) {
    throwForeignDependencyConflict([devDeclaration], desiredDepVersion);
  }

  const existingScript = getAtPath(document, ["scripts", POIESIS_SCRIPT_NAME]);

  if (args.mode === "ensure") {
    if (existingScript.exists && existingScript.value !== scriptValue) {
      // Owned prior may repair; bare ensure refuses foreign conflict.
      if (args.prior === undefined || args.prior.scriptValue !== existingScript.value) {
        // If prior owned the current value, repair path should be used. Ensure refuses foreign.
        if (args.prior === undefined || existingScript.value !== args.prior.scriptValue) {
          if (args.prior === undefined) {
            throw new PoiesisError(
              "PACKAGE_SCRIPT_CONFLICT",
              "package.json already defines a different poiesis script",
              { path: ["scripts", POIESIS_SCRIPT_NAME], existing: existingScript.value, expected: scriptValue },
            );
          }
        }
      }
    }
    if (existingDep !== undefined && desiredDepVersion !== undefined && existingDep.version !== desiredDepVersion) {
      // Only exact owned dev path version is eligible. Prior permits only same
      // devDependencies path version cross — never a non-dev section.
      const priorOwned =
        args.prior?.devDependencyVersion !== undefined &&
        existingDep.section === "devDependencies" &&
        existingDep.version === args.prior.devDependencyVersion;
      if (!priorOwned) {
        throw new PoiesisError(
          "PACKAGE_DEPENDENCY_CONFLICT",
          "package.json already defines a different poiesis-cli dependency",
          {
            path: ["devDependencies", POIESIS_CLI_PACKAGE_NAME],
            existing: existingDep.version,
            expected: desiredDepVersion,
            foreign: [{ section: existingDep.section, version: existingDep.version }],
          },
        );
      }
    }
  }

  // Repair mode: only rewrite when prior provenance authenticates the current value,
  // or the value is missing / already the desired owned value.
  if (args.mode === "repair" && args.prior !== undefined) {
    if (
      existingScript.exists &&
      existingScript.value !== scriptValue &&
      existingScript.value !== args.prior.scriptValue
    ) {
      throw new PoiesisError(
        "PACKAGE_SCRIPT_CONFLICT",
        "package.json poiesis script drifted from owned contribution and is not the prior owned value",
        { path: ["scripts", POIESIS_SCRIPT_NAME], existing: existingScript.value, prior: args.prior.scriptValue },
      );
    }
    if (
      existingDep !== undefined &&
      desiredDepVersion !== undefined &&
      existingDep.version !== desiredDepVersion &&
      !(
        existingDep.section === "devDependencies" &&
        existingDep.version === args.prior.devDependencyVersion
      )
    ) {
      throw new PoiesisError(
        "PACKAGE_DEPENDENCY_CONFLICT",
        "package.json poiesis-cli dependency drifted from owned contribution and is not the prior owned value",
        {
          path: ["devDependencies", POIESIS_CLI_PACKAGE_NAME],
          existing: existingDep.version,
          prior: args.prior.devDependencyVersion,
          foreign: [{ section: existingDep.section, version: existingDep.version }],
        },
      );
    }
  }

  // Overwrite is allowed only when the field is absent, already desired, or
  // authenticated by prior ownership of the current value on the owned dev path.
  // Mode `"repair"` alone never bypasses foreign conflict — no prior ⇒ same refusal as ensure.
  const mayOverwriteScript =
    !existingScript.exists ||
    existingScript.value === scriptValue ||
    (args.prior !== undefined && existingScript.value === args.prior.scriptValue);
  const mayOverwriteDep =
    desiredDepVersion === undefined ||
    existingDep === undefined ||
    existingDep.version === desiredDepVersion ||
    (args.prior !== undefined &&
      existingDep.section === "devDependencies" &&
      existingDep.version === args.prior.devDependencyVersion);
  if (!mayOverwriteScript) {
    throw new PoiesisError("PACKAGE_SCRIPT_CONFLICT", "package.json already defines a different poiesis script", {
      path: ["scripts", POIESIS_SCRIPT_NAME],
      existing: existingScript.value,
      expected: scriptValue,
    });
  }
  if (!mayOverwriteDep && desiredDepVersion !== undefined && existingDep !== undefined) {
    throw new PoiesisError(
      "PACKAGE_DEPENDENCY_CONFLICT",
      "package.json already defines a different poiesis-cli dependency",
      {
        path: ["devDependencies", POIESIS_CLI_PACKAGE_NAME],
        existing: existingDep.version,
        expected: desiredDepVersion,
        foreign: [{ section: existingDep.section, version: existingDep.version }],
      },
    );
  }

  let next = content;
  let packageJsonChanged = false;

  if (!existingScript.exists || existingScript.value !== scriptValue) {
    next = setScript(next, scriptValue);
    packageJsonChanged = true;
  }

  let lockfileOperation: LockfileOperation = null;
  if (desiredDepVersion !== undefined) {
    if (existingDep === undefined || existingDep.version !== desiredDepVersion) {
      // Only write exact owned devDependencies — never overwrite/relocate non-dev.
      next = setDevDependency(next, desiredDepVersion);
      packageJsonChanged = true;
      lockfileOperation = { op: "add-dev", name: POIESIS_CLI_PACKAGE_NAME, version: desiredDepVersion };
    }
  }

  const record = buildPackageContributionRecord({
    manager: resolution.manager,
    lockfile: resolution.lockfile,
    projectKind,
    scriptValue,
    ...(desiredDepVersion === undefined ? {} : { devDependencyVersion: desiredDepVersion }),
  });
  const executionScope = resolution.executionScope;

  if (!packageJsonChanged && lockfileOperation === null) {
    return {
      kind: "noop",
      record,
      packageJsonChanged: false,
      lockfileOperation: null,
      executionScope,
      expectedPackageJsonPreimageHash,
    };
  }

  // Version-crossing ordinary packages always need lockfile reconciliation when dep version changes.
  // If package.json already had exact dep but lock might be stale, callers may still run install —
  // for ensure/repair we only request lockfile ops when the declared dep changes.
  return {
    kind: "apply",
    record,
    packageJsonChanged,
    lockfileOperation,
    nextPackageJson: next,
    executionScope,
    expectedPackageJsonPreimageHash,
  };
}

export function planPackageContributionRemoval(args: {
  snapshot: PackageFsSnapshot;
  record: PackageContributionRecord;
}): PackageContributionPlan {
  // Removal with no package.json: nothing to bind; scope defaults to single-package
  // (no native op will run from an empty tree). Durable record is unchanged.
  if (args.snapshot.packageJson === null) {
    return {
      kind: "noop",
      record: args.record,
      packageJsonChanged: false,
      lockfileOperation: null,
      executionScope: { kind: "single-package" },
    };
  }
  const resolution = resolvePackageManagerOwnership(args.snapshot);
  if (resolution.kind === "absent") {
    return {
      kind: "noop",
      record: args.record,
      packageJsonChanged: false,
      lockfileOperation: null,
      executionScope: { kind: "single-package" },
    };
  }
  // Removal still requires the same manager/lock ownership that installed the contribution.
  if (resolution.kind === "unsupported") {
    throw new PoiesisError(resolution.code, resolution.message, resolution.details);
  }
  if (resolution.manager !== args.record.manager || resolution.lockfile !== args.record.lockfile) {
    throw new PoiesisError(
      "PACKAGE_MANAGER_AMBIGUOUS",
      "Installed package contribution manager/lockfile no longer matches on-disk lock ownership",
      {
        recorded: { manager: args.record.manager, lockfile: args.record.lockfile },
        actual: { manager: resolution.manager, lockfile: resolution.lockfile },
      },
    );
  }
  const executionScope = resolution.executionScope;

  const content = args.snapshot.packageJson;
  const expectedPackageJsonPreimageHash = hashContent(content);
  const document = parsePackageObject(content);
  const preserved: Array<{ path: string[]; reason: string }> = [];
  let next = content;
  let packageJsonChanged = false;

  const existingScript = getAtPath(document, ["scripts", POIESIS_SCRIPT_NAME]);
  if (existingScript.exists) {
    if (existingScript.value === args.record.scriptValue) {
      next = removeScript(next);
      packageJsonChanged = true;
    } else {
      preserved.push({
        path: ["scripts", POIESIS_SCRIPT_NAME],
        reason: "foreign script value differs from owned contribution",
      });
    }
  }

  let lockfileOperation: LockfileOperation = null;
  if (args.record.devDependencyVersion !== undefined) {
    // Spec #207 / ticket #215 — section-aware removal. Owned path is only
    // exact devDependencies.poiesis-cli when the value matches the record.
    // Non-dev declarations always preserve/report. Native uninstall is
    // name-wide: if any non-dev declaration remains, preserve matching dev
    // too and schedule no native remove. Script removal stays independent.
    const declarations = collectPoiesisCliDeclarations(parsePackageObject(next));
    const nonDev = foreignNonDevDeclarations(declarations);
    const dev = declarations.find((d) => d.section === "devDependencies");
    for (const decl of nonDev) {
      preserved.push({
        path: [decl.section, POIESIS_CLI_PACKAGE_NAME],
        reason: "foreign dependency section is outside owned devDependencies",
      });
    }
    if (nonDev.length > 0) {
      if (dev !== undefined) {
        preserved.push({
          path: ["devDependencies", POIESIS_CLI_PACKAGE_NAME],
          reason: "preserving owned devDependency because a non-dev declaration remains (native remove is name-wide)",
        });
      }
      // No package.json dep mutation and no native remove while non-dev remains.
    } else if (dev !== undefined) {
      if (typeof dev.version === "string" && dev.version === args.record.devDependencyVersion) {
        next = removeDevDependency(next);
        packageJsonChanged = true;
        lockfileOperation = { op: "remove-dev", name: POIESIS_CLI_PACKAGE_NAME };
      } else {
        preserved.push({
          path: ["devDependencies", POIESIS_CLI_PACKAGE_NAME],
          reason: "foreign dependency version differs from owned contribution",
        });
      }
    }
  }

  if (!packageJsonChanged && lockfileOperation === null) {
    if (preserved.length === 0) {
      return {
        kind: "noop",
        record: args.record,
        packageJsonChanged: false,
        lockfileOperation: null,
        executionScope,
        expectedPackageJsonPreimageHash,
      };
    }
    return {
      kind: "apply",
      record: args.record,
      packageJsonChanged: false,
      lockfileOperation: null,
      nextPackageJson: content,
      executionScope,
      expectedPackageJsonPreimageHash,
      preserved,
    };
  }

  return {
    kind: "apply",
    record: args.record,
    packageJsonChanged,
    lockfileOperation,
    nextPackageJson: next,
    executionScope,
    expectedPackageJsonPreimageHash,
    ...(preserved.length === 0 ? {} : { preserved }),
  };
}

export function assertPackageContributionMatches(packageJson: string, record: PackageContributionRecord): void {
  const document = parsePackageObject(packageJson);
  const script = getAtPath(document, ["scripts", record.scriptName]);
  if (!script.exists || script.value !== record.scriptValue) {
    throw new PoiesisError(
      "PACKAGE_CONTRIBUTION_MISMATCH",
      "package.json poiesis script does not match the owned contribution",
      { expected: record.scriptValue, actual: script.value },
    );
  }
  const declarations = collectPoiesisCliDeclarations(document);
  const foreign = foreignNonDevDeclarations(declarations);
  if (record.devDependencyVersion !== undefined) {
    // Ordinary retaining success requires exact owned dev path only; foreign
    // non-dev sections fail closed even at the desired version.
    if (foreign.length > 0) {
      throw new PoiesisError(
        "PACKAGE_CONTRIBUTION_MISMATCH",
        "package.json poiesis-cli devDependency does not match the owned contribution",
        {
          expected: record.devDependencyVersion,
          foreign: foreign.map((d) => ({ section: d.section, version: d.version })),
        },
      );
    }
    const dep = dependencyVersion(document, POIESIS_CLI_PACKAGE_NAME);
    if (dep === undefined || dep.version !== record.devDependencyVersion || dep.section !== "devDependencies") {
      throw new PoiesisError(
        "PACKAGE_CONTRIBUTION_MISMATCH",
        "package.json poiesis-cli devDependency does not match the owned contribution",
        { expected: record.devDependencyVersion, actual: dep },
      );
    }
  } else if (declarations.length > 0) {
    throw new PoiesisError(
      "PACKAGE_SELF_DEPENDENCY",
      "selfhost package contribution must not carry a poiesis-cli dependency",
      {
        foreign: declarations.map((d) => ({ section: d.section, version: d.version })),
        path: [declarations[0]!.section, POIESIS_CLI_PACKAGE_NAME],
      },
    );
  }
}

/**
 * Apply a planned package contribution. Writes planned package.json first
 * (when changed), then runs the injected executor for native pm ops with
 * `ignoreScripts: true`.
 *
 * `writeFile` may return `false` to signal it did **not** perform an owned
 * write (e.g. lockfile already moved by native pm — do not overwrite/adopt).
 * `onWritten` fires only after a successful owned write so the journal binds
 * only Poiesis-known bytes. Native pm failure or post-PM contribution mismatch
 * is {@link PACKAGE_MANAGER_INCOMPLETE}: owned package.json bytes may still be
 * journal-restored; `node_modules` / native lock side effects are **not**
 * claimed rolled back. Executor-returned package/lock rereads are never
 * re-written merely to journal-bind them as ours.
 */
export async function applyPackageContributionPlan(args: {
  plan: Extract<PackageContributionPlan, { kind: "apply" }>;
  preimage: { packageJson: string; lockfile: string };
  executor: PackageManagerExecutor;
  /**
   * Spec #219 / ticket #223 — live FS snapshot revalidated immediately before
   * package.json write and native executor. Planning-time eligibility is not
   * trusted after `.npmrc` / workspace configuration can drift.
   */
  liveSnapshot: PackageFsSnapshot;
  /**
   * Persist Poiesis-known bytes. Return `false` when the adapter skipped the
   * write (preimage drifted / native already wrote) so identity is not bound.
   */
  writeFile: (path: string, content: string) => Promise<void | boolean>;
  onWritten?: (path: string, content: string) => void;
  /** After ordinary add-dev: installed `node_modules/poiesis-cli/package.json` text, or null. */
  readResolvedLocalPackageJson?: () => Promise<string | null>;
  /**
   * Spec #219 / ticket #220 — after ordinary install, prove root-local
   * `node_modules/.bin/poiesis` is usable (isolated linker). Production wires
   * this; pure unit tests may omit when only package.json version is under test.
   */
  assertLocalCliExecutable?: () => Promise<void>;
  /** Before selfhost script write: injected dist probe (tests) or production probe. */
  probeSelfhostDist?: () => Promise<
    { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }
  >;
  /** Runtime version for selfhost dist readiness (package version being installed). */
  selfhostExpectedVersion?: string;
}): Promise<{
  packageJson: string;
  lockfile: string;
  writeSet: string[];
  record: PackageContributionRecord;
  preserved?: Array<{ path: string[]; reason: string }>;
  /**
   * When true, a native pm step failed after some Poiesis writes may have
   * landed. Callers must not advance the install manifest; journal may restore
   * owned package.json/lock only.
   */
  nativePmIncomplete?: true;
}> {
  const writeSet = [PACKAGE_JSON_RELATIVE, args.plan.record.lockfile];
  let packageJson = args.plan.nextPackageJson;
  let lockfile = args.preimage.lockfile;

  const writeOwned = async (path: string, content: string): Promise<void> => {
    const outcome = await args.writeFile(path, content);
    if (outcome === false) return;
    args.onWritten?.(path, content);
  };

  // Spec #219 / ticket #223 — live eligibility/scope before any package write
  // or native executor (config can drift after planning).
  assertLivePackageMutationEligibility({
    liveSnapshot: args.liveSnapshot,
    expectedManager: args.plan.record.manager,
    expectedLockfile: args.plan.record.lockfile,
    expectedExecutionScope: args.plan.executionScope,
  });

  // Selfhost: verify dist readiness BEFORE mutating package.json so a missing
  // build does not leave a half-written contribution.
  if (args.plan.record.projectKind === "selfhost") {
    const expected = args.selfhostExpectedVersion;
    if (expected === undefined || args.probeSelfhostDist === undefined) {
      throw new PoiesisError(
        "SELFHOST_DIST_UNREADABLE",
        "Selfhost package contribution requires a dist probe and the installing runtime version",
        { path: SELFHOST_DIST_CLI_RELATIVE },
      );
    }
    assertSelfhostDistReady({ expectedVersion: expected, probe: await args.probeSelfhostDist() });
  }

  if (args.plan.packageJsonChanged) {
    await writeOwned(PACKAGE_JSON_RELATIVE, packageJson);
  }

  if (args.plan.lockfileOperation !== null) {
    let result: { packageJson: string; lockfile: string };
    const executionScope = args.plan.executionScope;
    try {
      result = await args.executor.apply({
        manager: args.plan.record.manager,
        operation: args.plan.lockfileOperation,
        packageJson,
        lockfile,
        ignoreScripts: true,
        executionScope,
      });
    } catch (error) {
      const cause = error instanceof PoiesisError ? error : undefined;
      throw new PoiesisError(
        "PACKAGE_MANAGER_INCOMPLETE",
        "Native package-manager operation failed; Poiesis did not complete the package contribution and will not advance the install manifest. Owned package.json/lock bytes may be journal-restored; node_modules and other native pm side effects are not claimed rolled back.",
        {
          manager: args.plan.record.manager,
          operation: args.plan.lockfileOperation,
          executionScope,
          argv: [
            ...nativePackageManagerArgv(args.plan.record.manager, args.plan.lockfileOperation, executionScope),
          ],
          ownedArtifactsMayRollback: true,
          nativeSideEffectsNotClaimedRolledBack: true,
          cause: cause?.code ?? (error instanceof Error ? error.message : String(error)),
          ...(cause === undefined ? {} : { causeCode: cause.code, causeDetails: cause.details }),
        },
      );
    }
    packageJson = result.packageJson;
    lockfile = result.lockfile;
    // Validate post-PM package.json contribution fields. Do **not** re-write
    // executor-reread package.json bytes merely to journal-bind them — native
    // reformats / foreign races must not become Poiesis-authored identities.
    try {
      assertPackageContributionMatches(packageJson, args.plan.record);
    } catch (error) {
      throw new PoiesisError(
        "PACKAGE_MANAGER_INCOMPLETE",
        "Native package-manager finished but package.json no longer matches the planned contribution; Poiesis will not advance the install manifest. Owned planned package.json bytes may be journal-restored; native lock/node_modules side effects are not claimed rolled back.",
        {
          manager: args.plan.record.manager,
          operation: args.plan.lockfileOperation,
          executionScope,
          argv: [
            ...nativePackageManagerArgv(args.plan.record.manager, args.plan.lockfileOperation, executionScope),
          ],
          ownedArtifactsMayRollback: true,
          nativeSideEffectsNotClaimedRolledBack: true,
          postPmMismatch: true,
          cause: error instanceof PoiesisError ? error.code : error instanceof Error ? error.message : String(error),
        },
      );
    }
    // Lockfile: pure tests land bytes via writeFile; journal adapters skip when
    // preimage drifted (native already wrote) and must not adopt reread bytes.
    await writeOwned(args.plan.record.lockfile, lockfile);
  }

  // Ordinary contribution: every successful apply that retains a local
  // devDependency MUST prove the resolved primary-root package version. No
  // reader and no skip — missing/wrong version fails closed. Spec #219 also
  // proves the root-local executable when the production probe is wired.
  if (args.plan.record.devDependencyVersion !== undefined) {
    if (args.readResolvedLocalPackageJson === undefined) {
      throw new PoiesisError(
        "PACKAGE_LOCAL_BIN_UNRESOLVED",
        "Ordinary package contribution requires a reader for node_modules/poiesis-cli/package.json",
        { path: LOCAL_CLI_PACKAGE_JSON_RELATIVE, expectedVersion: args.plan.record.devDependencyVersion },
      );
    }
    assertResolvedLocalCliVersion({
      expectedVersion: args.plan.record.devDependencyVersion,
      installedPackageJson: await args.readResolvedLocalPackageJson(),
    });
    if (args.assertLocalCliExecutable !== undefined) {
      await args.assertLocalCliExecutable();
    }
  }

  assertPackageContributionMatches(packageJson, args.plan.record);
  return {
    packageJson,
    lockfile,
    writeSet,
    record: args.plan.record,
    ...(args.plan.preserved === undefined ? {} : { preserved: args.plan.preserved }),
  };
}
/**
 * Walk parent directories of `root` looking for an outer `pnpm-workspace.yaml`.
 * The installation root itself is not counted — only a parent that would make
 * the effective pnpm workspace root differ from the Poiesis root.
 */
export async function detectOuterPnpmWorkspace(
  root: string,
  io: {
    readText: (absolutePath: string) => Promise<string | null>;
  },
): Promise<boolean> {
  const { dirname, join, parse, resolve } = await import("node:path");
  let current = resolve(root);
  const { root: fsRoot } = parse(current);
  for (;;) {
    const parent = dirname(current);
    if (parent === current || parent === fsRoot) {
      // Check fsRoot itself as a possible outer workspace root when root is nested.
      if (parent === fsRoot && resolve(root) !== fsRoot) {
        const atFsRoot = await io.readText(join(fsRoot, "pnpm-workspace.yaml"));
        if (present(atFsRoot)) return true;
      }
      return false;
    }
    const workspace = await io.readText(join(parent, "pnpm-workspace.yaml"));
    if (present(workspace)) return true;
    current = parent;
  }
}

/**
 * Read a filesystem snapshot for package ownership decisions. Callers that
 * already hold primary-root resolution should pass that root — never a
 * linked worktree path for ownership writes.
 *
 * Spec #219 / ticket #220 — also loads root `.npmrc` and detects an outer
 * pnpm workspace so eligibility stays centralized in
 * {@link resolvePackageManagerOwnership}.
 */
export async function readPackageFsSnapshot(
  root: string,
  io: {
    readText: (absolutePath: string) => Promise<string | null>;
  },
): Promise<PackageFsSnapshot> {
  const { join } = await import("node:path");
  const read = async (relative: string): Promise<string | null> => io.readText(join(root, relative));
  const outerPnpmWorkspace = await detectOuterPnpmWorkspace(root, io);
  return {
    packageJson: await read(PACKAGE_JSON_RELATIVE),
    lockfiles: {
      "pnpm-lock.yaml": await read("pnpm-lock.yaml"),
      "package-lock.json": await read("package-lock.json"),
      "yarn.lock": await read("yarn.lock"),
      "bun.lock": await read("bun.lock"),
      "bun.lockb": await read("bun.lockb"),
      "pnpm-workspace.yaml": await read("pnpm-workspace.yaml"),
    },
    npmrc: await read(".npmrc"),
    outerPnpmWorkspace,
  };
}

/** Load a package FS snapshot from the primary installation root. */
export async function loadPackageFsSnapshot(root: string): Promise<PackageFsSnapshot> {
  const { readFile } = await import("node:fs/promises");
  return readPackageFsSnapshot(root, {
    readText: async (absolutePath) => {
      try {
        return await readFile(absolutePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  });
}

/**
 * Plan package contribution at the primary installation root. Throws typed
 * unsupported/ambiguous/workspace errors when package.json is present but
 * lock ownership cannot be claimed safely. Returns `{ kind: "absent" }` when
 * there is no package.json (exact dlx route retained).
 */
export async function planPackageContributionAtRoot(args: {
  root: string;
  poiesisVersion: string;
  mode: "ensure" | "repair";
  prior?: PackageContributionRecord | undefined;
}): Promise<PackageContributionPlan> {
  const snapshot = await loadPackageFsSnapshot(args.root);
  const planArgs: {
    snapshot: PackageFsSnapshot;
    poiesisVersion: string;
    mode: "ensure" | "repair";
    prior?: PackageContributionRecord;
  } = {
    snapshot,
    poiesisVersion: args.poiesisVersion,
    mode: args.mode,
  };
  if (args.prior !== undefined) planArgs.prior = args.prior;
  return planPackageContribution(planArgs);
}

/**
 * Native npm/pnpm executor: full exact install/remove with `--ignore-scripts`
 * under the primary installation root. Tests inject a prepared executor.
 * Does not claim atomic `node_modules` rollback — failure surfaces as
 * {@link PACKAGE_MANAGER_INCOMPLETE} from the apply plan.
 */
export function createNativePackageManagerExecutor(root: string): PackageManagerExecutor {
  return {
    async apply(request) {
      const { run } = await import("./process.js");
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const args = [
        ...nativePackageManagerArgv(request.manager, request.operation, request.executionScope),
      ];
      try {
        // Spec #219 — always run with the authoritative installation root as cwd.
        // Workspace-root scope is also encoded in argv (`-w`) for pnpm.
        await run(request.manager, args, { cwd: root });
      } catch (error) {
        throw new PoiesisError(
          "PACKAGE_MANAGER_FAILED",
          `${request.manager} ${args.join(" ")} failed`,
          {
            manager: request.manager,
            operation: request.operation,
            executionScope: request.executionScope,
            argv: args,
            cwd: root,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      const lockfileName = request.manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
      return {
        packageJson: await readFile(join(root, PACKAGE_JSON_RELATIVE), "utf8"),
        lockfile: await readFile(join(root, lockfileName), "utf8"),
      };
    },
  };
}

/** Test-only seam: replace the native package-manager executor. */
let packageManagerExecutorOverride: PackageManagerExecutor | null = null;

export function setPackageManagerExecutorForTest(executor: PackageManagerExecutor | null): void {
  packageManagerExecutorOverride = executor;
}

export function resolvePackageManagerExecutor(root: string): PackageManagerExecutor {
  return packageManagerExecutorOverride ?? createNativePackageManagerExecutor(root);
}

/**
 * Apply a planned contribution at the primary root and record journal write
 * identities for package.json + lockfile. Callers must have already
 * `journal.capture`d both paths.
 *
 * Poiesis-known bytes (planned package.json, and lockfile only while still at
 * the captured preimage) go through `replaceOwnedFile` — typically
 * `journal.replace` — so the pre-write identity gate detects a stale plan.
 * Native pm / node_modules effects are never claimed fully rolled back on
 * failure (`PACKAGE_MANAGER_INCOMPLETE`). Executor rereads are validated for
 * contribution fields + resolved bin; they are never re-written merely to
 * journal-bind foreign or native-mutated bytes as ours.
 */
export async function applyPackageContributionWithJournal(args: {
  root: string;
  plan: Extract<PackageContributionPlan, { kind: "apply" }>;
  packageJsonEntry: ArtifactJournalEntry;
  lockfileEntry: ArtifactJournalEntry;
  /**
   * Guarded replace for Poiesis-known bytes (typically `journal.replace`).
   * Binds `transactionWrittenIdentity` on success. Throws
   * `ARTIFACT_IDENTITY_DRIFT` when the on-disk preimage no longer matches.
   */
  replaceOwnedFile: (entry: ArtifactJournalEntry, content: string) => Promise<void>;
  executor?: PackageManagerExecutor;
  preimageLockfile: string;
  /** Installing runtime version (selfhost dist check + ordinary target). */
  poiesisVersion: string;
  /** Test injection for resolved local package.json after ordinary install. */
  readResolvedLocalPackageJson?: () => Promise<string | null>;
  /** Test injection for root-local executable readiness after ordinary install. */
  assertLocalCliExecutable?: () => Promise<void>;
  /** Test injection for selfhost dist probe. */
  probeSelfhostDist?: () => Promise<
    { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }
  >;
  /**
   * Spec #219 / ticket #223 — optional live eligibility snapshot. Production
   * omits this and reloads from `root` immediately before mutation. Tests may
   * inject when the journal root is not a real package tree.
   */
  liveSnapshot?: PackageFsSnapshot;
}): Promise<{
  record: PackageContributionRecord;
  packageJson: string;
  lockfile: string;
  preserved?: Array<{ path: string[]; reason: string }>;
}> {
  // Plan-to-capture bind: the apply plan was computed from a specific
  // package.json snapshot. Capture must still hold those original bytes —
  // never authenticate intervening Author edits then overwrite with a stale
  // nextPackageJson. Fail closed before write/native pm/manifest advance.
  assertPackageContributionCaptureIdentity(args.plan, args.packageJsonEntry);

  // Spec #219 / ticket #223 — live eligibility surface (.npmrc /
  // pnpm-workspace.yaml / locks) immediately before mutation. Package.json
  // identity is already gated above; config drift is gated inside apply.
  const liveSnapshot =
    args.liveSnapshot ?? (await loadPackageFsSnapshot(args.root));

  const { run } = await import("./process.js");
  const executor = args.executor ?? resolvePackageManagerExecutor(args.root);
  const lockfileRelative = args.plan.record.lockfile;

  const planArgs: Parameters<typeof applyPackageContributionPlan>[0] = {
    plan: args.plan,
    preimage: {
      // Immutable planned package.json expected bytes + captured lock preimage.
      packageJson: args.plan.nextPackageJson,
      lockfile: args.preimageLockfile,
    },
    liveSnapshot,
    executor,
    writeFile: async (relativePath, content) => {
      const entry =
        relativePath === PACKAGE_JSON_RELATIVE
          ? args.packageJsonEntry
          : relativePath === lockfileRelative
            ? args.lockfileEntry
            : undefined;
      if (entry === undefined) {
        throw new PoiesisError(
          "ARTIFACT_JOURNAL_MISSING",
          "Package contribution write path is not a captured journal entry",
          { path: relativePath },
        );
      }
      try {
        await args.replaceOwnedFile(entry, content);
        return;
      } catch (error) {
        // Lockfile preimage drift after native pm (or a concurrent writer) —
        // do not overwrite or adopt returned bytes as a Poiesis-owned write.
        // Planned package.json drift is a stale plan and must fail closed.
        if (
          relativePath === lockfileRelative &&
          error instanceof PoiesisError &&
          error.code === "ARTIFACT_IDENTITY_DRIFT"
        ) {
          return false;
        }
        throw error;
      }
    },
    // journal.replace already binds transactionWrittenIdentity for owned writes.
    selfhostExpectedVersion: args.poiesisVersion,
  };
  if (args.plan.record.projectKind === "selfhost") {
    planArgs.probeSelfhostDist =
      args.probeSelfhostDist ?? (() => probeSelfhostDistVersion(args.root, run));
  }
  // Ordinary: always wire a primary-root reader — required on every success path.
  // Spec #219 — production (no injected readers) also proves the root-local
  // executable under the isolated linker. Pure unit tests that inject only the
  // package.json reader keep version-only checks unless they wire the executable
  // assert explicitly.
  if (args.plan.record.devDependencyVersion !== undefined) {
    const expectedVersion = args.plan.record.devDependencyVersion;
    const productionPath = args.readResolvedLocalPackageJson === undefined;
    planArgs.readResolvedLocalPackageJson =
      args.readResolvedLocalPackageJson ?? (() => readResolvedLocalCliPackageJson(args.root));
    if (args.assertLocalCliExecutable !== undefined) {
      planArgs.assertLocalCliExecutable = args.assertLocalCliExecutable;
    } else if (productionPath) {
      planArgs.assertLocalCliExecutable = () =>
        assertLocalCliExecutableAtRoot({
          root: args.root,
          expectedVersion,
          run,
        });
    }
  }
  const result = await applyPackageContributionPlan(planArgs);

  return {
    record: result.record,
    packageJson: result.packageJson,
    lockfile: result.lockfile,
    ...(result.preserved === undefined ? {} : { preserved: result.preserved }),
  };
}
/**
 * Production reader: `node_modules/poiesis-cli/package.json` under the primary
 * installation root. Returns null when absent (caller fails closed).
 */
export async function readResolvedLocalCliPackageJson(root: string): Promise<string | null> {
  const { join } = await import("node:path");
  const { exists } = await import("./fs.js");
  const { readFile } = await import("node:fs/promises");
  const path = join(root, LOCAL_CLI_PACKAGE_JSON_RELATIVE);
  if (!(await exists(path))) return null;
  return readFile(path, "utf8");
}

/**
 * Spec #219 / ticket #222 — read-only doctor surface for an owned package
 * contribution. Reuses shared eligibility (`resolvePackageManagerOwnership`),
 * ownership (`assertPackageContributionMatches`), and readiness
 * (`assertPackageContributionRuntimeReady`). Never mutates files, never
 * repairs, and never invents a contribution when the manifest records none.
 */
export type PackageContributionDoctorCheck = {
  id: "package-contribution";
  status: "pass" | "fail";
  message: string;
  details: Record<string, unknown>;
};

/**
 * Actionable remediation tokens for package-contribution doctor findings.
 * Operators re-run an authenticated lifecycle command; doctor itself never
 * mutates package.json, lockfiles, or node_modules.
 */
export function packageContributionDoctorRemediation(code: string): {
  action: string;
  hint: string;
} {
  switch (code) {
    case "PACKAGE_WORKSPACE_UNSUPPORTED":
      return {
        action: "restore-eligible-root-workspace-or-single-package-layout",
        hint: "unsupported-scope",
      };
    case "PACKAGE_MANAGER_AMBIGUOUS":
    case "PACKAGE_MANAGER_UNSUPPORTED":
      return {
        action: "restore-supported-lock-ownership",
        hint: "unsupported-or-ambiguous-lock",
      };
    case "PACKAGE_CONTRIBUTION_MISMATCH":
    case "PACKAGE_SELF_DEPENDENCY":
      return {
        action: "run-poiesis-update",
        hint: "root-ownership-drift",
      };
    case "PACKAGE_LOCAL_BIN_UNRESOLVED":
      return {
        action: "run-poiesis-update",
        hint: "missing-or-unusable-local-executable",
      };
    case "PACKAGE_LOCAL_BIN_VERSION_MISMATCH":
      return {
        action: "run-poiesis-update",
        hint: "exact-version-mismatch",
      };
    case "SELFHOST_DIST_MISSING":
    case "SELFHOST_DIST_UNREADABLE":
    case "SELFHOST_DIST_VERSION_MISMATCH":
      return {
        action: "rebuild-selfhost-dist",
        hint: "selfhost-dist-not-ready",
      };
    default:
      return {
        action: "run-poiesis-update",
        hint: "package-contribution-unhealthy",
      };
  }
}

function packageContributionDoctorFail(
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
): PackageContributionDoctorCheck {
  const remediation = packageContributionDoctorRemediation(code);
  return {
    id: "package-contribution",
    status: "fail",
    message,
    details: {
      code,
      repaired: false,
      ...remediation,
      ...extra,
    },
  };
}

/**
 * Spec #219 / ticket #222 — pure read-only diagnosis against a package FS
 * snapshot and optional readiness seams. Callers must not write package bytes
 * from this path. When `record` is absent, reports a pass that the exact-version
 * launcher is retained (no fabricated contribution).
 */
export async function inspectPackageContributionHealth(args: {
  record: PackageContributionRecord | undefined;
  poiesisVersion: string;
  snapshot: PackageFsSnapshot;
  readResolvedLocalPackageJson?: () => Promise<string | null>;
  assertLocalCliExecutable?: () => Promise<void>;
  probeSelfhostDist?: () => Promise<
    { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }
  >;
}): Promise<PackageContributionDoctorCheck> {
  if (args.record === undefined) {
    return {
      id: "package-contribution",
      status: "pass",
      message: "No owned package contribution; exact-version launcher retained",
      details: {
        packageContribution: null,
        repaired: false,
      },
    };
  }

  const record = args.record;
  try {
    if (args.snapshot.packageJson === null) {
      return packageContributionDoctorFail(
        "Owned package contribution is recorded but root package.json is missing",
        "PACKAGE_CONTRIBUTION_MISMATCH",
        {
          path: PACKAGE_JSON_RELATIVE,
          recorded: {
            manager: record.manager,
            lockfile: record.lockfile,
            scriptValue: record.scriptValue,
            ...(record.devDependencyVersion === undefined
              ? {}
              : { devDependencyVersion: record.devDependencyVersion }),
          },
        },
      );
    }

    const resolution = resolvePackageManagerOwnership(args.snapshot);
    if (resolution.kind === "absent") {
      return packageContributionDoctorFail(
        "Owned package contribution is recorded but package ownership is absent",
        "PACKAGE_CONTRIBUTION_MISMATCH",
        { path: PACKAGE_JSON_RELATIVE },
      );
    }
    if (resolution.kind === "unsupported") {
      return packageContributionDoctorFail(resolution.message, resolution.code, {
        ...resolution.details,
        executionScope: null,
      });
    }
    if (resolution.manager !== record.manager || resolution.lockfile !== record.lockfile) {
      return packageContributionDoctorFail(
        "Installed package contribution manager/lockfile no longer matches on-disk lock ownership",
        "PACKAGE_MANAGER_AMBIGUOUS",
        {
          recorded: { manager: record.manager, lockfile: record.lockfile },
          actual: { manager: resolution.manager, lockfile: resolution.lockfile },
          executionScope: resolution.executionScope,
        },
      );
    }

    assertPackageContributionMatches(args.snapshot.packageJson, record);

    await assertPackageContributionRuntimeReady({
      record,
      poiesisVersion: args.poiesisVersion,
      ...(args.readResolvedLocalPackageJson === undefined
        ? {}
        : { readResolvedLocalPackageJson: args.readResolvedLocalPackageJson }),
      ...(args.assertLocalCliExecutable === undefined
        ? {}
        : { assertLocalCliExecutable: args.assertLocalCliExecutable }),
      ...(args.probeSelfhostDist === undefined ? {} : { probeSelfhostDist: args.probeSelfhostDist }),
    });

    return {
      id: "package-contribution",
      status: "pass",
      message:
        resolution.executionScope.kind === "pnpm-workspace-root"
          ? "Root pnpm workspace package contribution ownership and local readiness are healthy"
          : "Package contribution ownership and local readiness are healthy",
      details: {
        repaired: false,
        manager: record.manager,
        lockfile: record.lockfile,
        projectKind: record.projectKind,
        executionScope: resolution.executionScope,
        ...(record.devDependencyVersion === undefined
          ? {}
          : { devDependencyVersion: record.devDependencyVersion }),
      },
    };
  } catch (error) {
    if (error instanceof PoiesisError) {
      return packageContributionDoctorFail(error.message, error.code, { ...error.details });
    }
    return packageContributionDoctorFail(
      error instanceof Error ? error.message : String(error),
      "UNEXPECTED",
    );
  }
}

/**
 * Spec #219 / ticket #222 — production doctor entry: load the primary-root
 * package snapshot and readiness probes, then diagnose without mutation.
 */
export async function inspectPackageContributionHealthAtRoot(args: {
  root: string;
  record: PackageContributionRecord | undefined;
  poiesisVersion: string;
  run: (command: string, argv: string[], options: { cwd: string; allowFailure: true }) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
}): Promise<PackageContributionDoctorCheck> {
  if (args.record === undefined) {
    return inspectPackageContributionHealth({
      record: undefined,
      poiesisVersion: args.poiesisVersion,
      snapshot: {
        packageJson: null,
        lockfiles: {
          "pnpm-lock.yaml": null,
          "package-lock.json": null,
          "yarn.lock": null,
          "bun.lock": null,
          "bun.lockb": null,
          "pnpm-workspace.yaml": null,
        },
      },
    });
  }

  const snapshot = await loadPackageFsSnapshot(args.root);
  const record = args.record;
  const ordinaryReady =
    record.projectKind === "ordinary" && record.devDependencyVersion !== undefined;
  const expectedVersion = record.devDependencyVersion;
  return inspectPackageContributionHealth({
    record,
    poiesisVersion: args.poiesisVersion,
    snapshot,
    ...(ordinaryReady && expectedVersion !== undefined
      ? {
          readResolvedLocalPackageJson: () => readResolvedLocalCliPackageJson(args.root),
          assertLocalCliExecutable: () =>
            assertLocalCliExecutableAtRoot({
              root: args.root,
              expectedVersion,
              run: args.run,
            }),
        }
      : {}),
    ...(record.projectKind === "selfhost"
      ? { probeSelfhostDist: () => probeSelfhostDistVersion(args.root, args.run) }
      : {}),
  });
}

/**
 * Verify runtime readiness for an owned contribution without mutating files.
 * Ordinary with `devDependencyVersion`: resolved primary-root
 * `node_modules/poiesis-cli/package.json` MUST exist and equal the target —
 * a reader is required; missing/wrong fails closed (no silent skip).
 * Spec #219 / ticket #220 — when `assertLocalCliExecutable` is provided (production
 * and real-pnpm paths), the root-local `node_modules/.bin/poiesis` must also be
 * usable under the normal isolated linker. Selfhost: `node dist/cli.js --version`
 * equals target.
 */
export async function assertPackageContributionRuntimeReady(args: {
  record: PackageContributionRecord;
  poiesisVersion: string;
  readResolvedLocalPackageJson?: () => Promise<string | null>;
  /**
   * Ordinary: prove root-local executable readiness (presence and optional
   * version probe). Production always wires this; pure version-only unit tests
   * may omit it.
   */
  assertLocalCliExecutable?: () => Promise<void>;
  probeSelfhostDist?: () => Promise<
    { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }
  >;
}): Promise<void> {
  if (args.record.projectKind === "selfhost") {
    if (args.probeSelfhostDist === undefined) {
      throw new PoiesisError(
        "SELFHOST_DIST_UNREADABLE",
        "Selfhost package contribution requires a dist probe",
        { path: SELFHOST_DIST_CLI_RELATIVE },
      );
    }
    assertSelfhostDistReady({
      expectedVersion: args.poiesisVersion,
      probe: await args.probeSelfhostDist(),
    });
    return;
  }
  if (args.record.devDependencyVersion !== undefined) {
    if (args.readResolvedLocalPackageJson === undefined) {
      throw new PoiesisError(
        "PACKAGE_LOCAL_BIN_UNRESOLVED",
        "Ordinary package contribution requires a reader for node_modules/poiesis-cli/package.json",
        { path: LOCAL_CLI_PACKAGE_JSON_RELATIVE, expectedVersion: args.record.devDependencyVersion },
      );
    }
    assertResolvedLocalCliVersion({
      expectedVersion: args.record.devDependencyVersion,
      installedPackageJson: await args.readResolvedLocalPackageJson(),
    });
    if (args.assertLocalCliExecutable !== undefined) {
      await args.assertLocalCliExecutable();
    }
  }
}

/**
 * Production ordinary executable readiness under the primary installation root:
 * `node_modules/.bin/poiesis` must exist and `--version` must equal the target.
 */
export async function assertLocalCliExecutableAtRoot(args: {
  root: string;
  expectedVersion: string;
  run: (command: string, argv: string[], options: { cwd: string; allowFailure: true }) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
}): Promise<void> {
  const { join } = await import("node:path");
  const { exists } = await import("./fs.js");
  const binPath = join(args.root, LOCAL_CLI_BIN_RELATIVE);
  const presentBin = await exists(binPath);
  if (!presentBin) {
    assertResolvedLocalCliExecutable({
      expectedVersion: args.expectedVersion,
      present: false,
    });
    return;
  }
  try {
    // Real npm/pnpm installers place a shell shim at node_modules/.bin/poiesis
    // (not a JS file). Execute that path directly; `node <shim>` fails.
    const result = await args.run(binPath, ["--version"], {
      cwd: args.root,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      assertResolvedLocalCliExecutable({
        expectedVersion: args.expectedVersion,
        present: true,
        versionProbe: {
          ok: false,
          detail: result.stderr.trim() || `exit ${result.exitCode}`,
        },
      });
      return;
    }
    assertResolvedLocalCliExecutable({
      expectedVersion: args.expectedVersion,
      present: true,
      versionProbe: { ok: true, stdout: result.stdout },
    });
  } catch (error) {
    assertResolvedLocalCliExecutable({
      expectedVersion: args.expectedVersion,
      present: true,
      versionProbe: {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Spec #207 / ticket #218 — decision for the update-config **config-byte**
 * early no-op branch once `packagePlan` is already computed.
 *
 * - `apply` (repair / version-cross / lock reconciliation) → never early-return;
 *   continue the full transaction so package work still runs.
 * - `absent` (and non-retain plans) → allow early-return; no package gates.
 * - hashed `noop` → allow early-return only after a fresh package.json identity
 *   bind against the original plan hash and runtime readiness (ordinary local
 *   resolved exact version, or selfhost dist target). Read missing / drift /
 *   readiness failure throws; callers must not write package bytes or advance
 *   receipt/manifest generation.
 *
 * Noop is only possible when the package target already matches the candidate
 * runtime `nextPoiesisVersion` (version-cross planning yields `apply` otherwise).
 * Reuses {@link assertPackageContributionCaptureIdentity} — does not duplicate
 * the later full-transaction publication helper.
 */
export type UpdateConfigEarlyNoopPackageDecision =
  | { decision: "continue-transaction" }
  | { decision: "allow-early-return" };

export async function gateUpdateConfigEarlyNoopPackage(args: {
  packagePlan: PackageContributionPlan;
  /** Fresh package.json reader; `null` or throw → identity drift for hashed noop. */
  readPackageJson: () => Promise<string | null>;
  /**
   * Runtime readiness for the hashed-noop record (ordinary resolved local exact
   * version or selfhost dist). Invoked only after identity bind succeeds.
   */
  assertRuntimeReady: (record: PackageContributionRecord) => Promise<void>;
}): Promise<UpdateConfigEarlyNoopPackageDecision> {
  if (args.packagePlan.kind === "apply") {
    return { decision: "continue-transaction" };
  }
  if (packagePlanIsNoopWithPreimage(args.packagePlan)) {
    let content: string | null;
    try {
      content = await args.readPackageJson();
    } catch {
      content = null;
    }
    if (content === null) {
      throw new PoiesisError(
        "ARTIFACT_IDENTITY_DRIFT",
        "package.json changed while preparing the package contribution",
        { path: PACKAGE_JSON_RELATIVE },
      );
    }
    assertPackageContributionCaptureIdentity(args.packagePlan, {
      packageJsonContent: content,
    });
    await args.assertRuntimeReady(args.packagePlan.record);
    return { decision: "allow-early-return" };
  }
  // absent, or non-retain noop without preimage — nothing to bind or write.
  return { decision: "allow-early-return" };
}

/**
 * Spec #207 / ticket #210 — pure planning seam for version-crossing config
 * updates. Given a package FS snapshot, the next runtime version, and any
 * prior owned contribution, returns the plan plus the contribution the
 * OpenCode projection and next manifest must use. Absent package.json keeps
 * the exact dlx route (no fabricated metadata). Conflicts fail closed inside
 * `planPackageContribution`.
 */
export function planPackageContributionForVersionCross(args: {
  snapshot: PackageFsSnapshot;
  nextPoiesisVersion: string;
  prior?: PackageContributionRecord | undefined;
}): {
  plan: PackageContributionPlan;
  /** Contribution for projection + next manifest; undefined ⇒ exact dlx. */
  contributionForProjection: PackageContributionRecord | undefined;
} {
  // With authenticated prior ownership, repair may version-cross the exact
  // dep. Without prior, ensure refuses foreign conflicts rather than
  // overwriting Author scripts/deps.
  const mode = packageContributionMode(args.prior);
  const planArgs: {
    snapshot: PackageFsSnapshot;
    poiesisVersion: string;
    mode: "ensure" | "repair";
    prior?: PackageContributionRecord;
  } = {
    snapshot: args.snapshot,
    poiesisVersion: args.nextPoiesisVersion,
    mode,
  };
  if (args.prior !== undefined) planArgs.prior = args.prior;
  const plan = planPackageContribution(planArgs);
  if (plan.kind === "absent") {
    return { plan, contributionForProjection: undefined };
  }
  return { plan, contributionForProjection: plan.record };
}

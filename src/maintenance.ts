import { isDeepStrictEqual } from "node:util";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import {
  loadConfig,
  parseJsonc,
  serializeConfig,
  validateConfig,
  type PoiesisConfig,
  type ResolvedPoiesisConfig,
} from "./config.js";
import { PoiesisError } from "./errors.js";
import { atomicCreate, atomicWrite, exists, readUtf8 } from "./fs.js";
import { runUpdateConfigTransaction } from "./update-config-internal.js";
import {
  runUpdateTransaction,
  runBootstrapLegacyOwnershipTransaction,
} from "./update-internal.js";
import { hashContent, hashFile } from "./hash.js";
import { ArtifactJournal, type ArtifactJournalEntry } from "./mutation-transaction.js";
import {
  assertManifestAuthority,
  assertManifestAuthorityToleratingPredecessor,
  nextAdapterFiles,
  nextAdapterPatches,
} from "./authority.js";
import {
  assertOwnershipReceipt,
  createOwnershipReceipt,
  ownershipReceiptExists,
  ownershipReceiptLocation,
  removeOwnershipReceipt,
  replaceOwnershipReceipt,
  type OwnershipReceipt,
} from "./receipt.js";
import {
  loadManifest,
  serializeManifest,
  type ConfigPatch,
  type ManagedFile,
  type ManagedSkill,
  type Manifest,
} from "./manifest.js";
import {
  applyOpenCodeConfig,
  assertOpenCodeConfigAvailable,
  desiredOpenCodePatches,
  detectOpenCodeConfig,
  detectOpenCodeConfigForInit,
  OPENCODE_ADAPTER_VERSION,
  SUPPORTED_OPENCODE_VERSION,
  SUPPORTED_OPENCODE_VERSIONS,
  validateOpenCodeConfig,
  verifyOpenCodeVersion,
} from "./opencode.js";
import { ownedPath, packageRoot, poiesisPath } from "./paths.js";
import { run } from "./process.js";
import {
  hashOwnedSkillDirectory,
  assertDefaultSkillDestinationsAvailable,
  installCapability,
  installDefaultSkills,
  loadDefaultSkills,
  removeOwnedSkills,
  skillPath,
  type CapabilityInstallInput,
} from "./skills.js";
import {
  POIESIS_DURABLE_PATHS,
  POIESIS_LOCAL_STATE_PATHS,
  ensureGitignore,
  readTemplate,
  templateMappings,
} from "./templates.js";
import { createDeliveryAdapter } from "./adapters.js";

export interface MaintenanceOptions {
  skipSkills?: boolean;
  allowFixtureAdapters?: boolean;
  bootstrapLegacyOwnership?: boolean;
}

export type DoctorCheckStatus = "pass" | "fail" | "warn";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  root: string;
  ok: boolean;
  checks: DoctorCheck[];
}

export interface UninstallResult {
  complete: boolean;
  manifestRemoved: boolean;
  removed: string[];
  revertedConfigPatches: number;
  preserved: Array<{ path: string; reason: string }>;
}

export interface UpdateResult {
  manifest: Manifest;
  doctor: DoctorReport;
}

interface MaterializedFile {
  path: string;
  kind: ManagedFile["kind"];
  content: string;
}

type JsonObject = Record<string, unknown>;

export function assertResolvedConfig(config: PoiesisConfig): void {
  const unresolved: string[] = [];
  function visit(value: unknown, path: string): void {
    if (typeof value === "string" && /<[^>]+>/.test(value)) unresolved.push(path);
    else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) visit(item, path ? `${path}.${key}` : key);
    }
  }
  visit(config, "");
  if (unresolved.length > 0) {
    throw new PoiesisError("UNRESOLVED_CONFIG", "Poiesis config contains unresolved template values", {
      paths: unresolved,
    });
  }
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof PoiesisError) return { code: error.code, message: error.message, ...error.details };
  if (error instanceof Error) return { message: error.message, cause: error.name };
  return { message: String(error) };
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

async function isRegularFile(path: string): Promise<boolean> {
  const details = await lstat(path);
  return details.isFile() && !details.isSymbolicLink();
}

async function assertSafeParents(root: string, destination: string): Promise<void> {
  const parts = relative(root, destination).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if ((await pathEntryExists(current)) && (await lstat(current)).isSymbolicLink()) {
      throw new PoiesisError("UNSAFE_MANAGED_PATH", "Refusing to traverse a symlinked managed parent", {
        path: relative(root, current),
      });
    }
  }
}

export async function isRegularManagedFile(root: string, path: string): Promise<boolean> {
  await assertSafeParents(root, path);
  return isRegularFile(path);
}

/**
 * Internal test-only seam for `packageVersion()`.
 *
 * Production callers (CLI / runtime) MUST NOT touch this variable; the
 * exact-version canonical route `pnpm dlx poiesis-cli@<X>` is the sole
 * durable source of the executing runtime identity. Tests use the seam
 * to project a synthetic runtime version WITHOUT mutating the
 * workspace `package.json`, because rewriting the workspace manifest on
 * disk is non-atomic (a process crash between snapshot and restore
 * leaves the workspace in a corrupted state and bleeds across the
 * parallel test pool).
 *
 * The seam is module-scoped, lives in this module only, and is NOT
 * re-exported through `src/index.ts`. The setter is intentionally
 * suffixed `ForTest` so accidental production use is grep-able.
 */
let runtimePackageVersionOverride: string | null = null;

export function setRuntimePackageVersionOverrideForTest(version: string | null): void {
  runtimePackageVersionOverride = version;
}

export async function packageVersion(): Promise<string> {
  if (runtimePackageVersionOverride !== null) return runtimePackageVersionOverride;
  const path = join(packageRoot, "package.json");
  const value = parseJsonc<unknown>(await readUtf8(path), path);
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new PoiesisError("INVALID_PACKAGE_METADATA", "Poiesis package version is unavailable", { path });
  }
  return value.version;
}

/**
 * Spec #104 / ticket #106 — runtime identity boundary guard.
 *
 * The executing Poiesis runtime identity is uniquely identified by the
 * package version baked into the exact-version canonical route
 * `pnpm dlx poiesis-cli@<X>` projected into the OpenCode config. The
 * durable half of that pair is `manifest.poiesisVersion`, recorded in
 * `.poiesis/manifest.json` at install time and re-asserted by the
 * receipt-gated `update` boundary. Every project-bound installed
 * lifecycle mutation MUST cross-check that the running package version
 * equals the durable recorded version BEFORE any consequential
 * mutation; a mismatch fails closed with `RUNTIME_VERSION_MISMATCH`
 * and details `{ project, runtime }` so an Operator can diagnose which
 * exact-version `dlx poiesis-cli@X` route is required.
 *
 * This helper is the SINGLE shared seam that enforces the rule. Every
 * guarded entry point (`uninstall`, `installAuthorizedCapability`,
 * `setModel`, `workspacePrepare`, `workspaceCleanup`, `checkpoint`,
 * `publish`, `integrate`, `previewDelivery`, `promoteDelivery`, the
 * tracker mutation dispatcher) calls this helper as its first action so
 * the rule is uniform — the spec explicitly forbids a per-command
 * version matrix. The exempt surfaces are:
 *
 *   - `init` (no manifest yet; this helper no-ops on the absent path),
 *   - `doctor` and `inspect` (read-only; needed for mismatch diagnosis),
 *   - `update` and `updateFromConfig` (the explicit, receipt-gated
 *     version-crossing boundary),
 *   - `verify` and `session cleanup` (no project-bound mutation).
 */
export async function assertRuntimeVersionMatchesProject(root: string): Promise<void> {
  const manifestPath = poiesisPath(root, "manifest.json");
  // Manifest-less path = init scenario. The guard has nothing to
  // compare against and must stay silent; the spec notes "Init has no
  // manifest" as the canonical exemption.
  if (!(await exists(manifestPath))) return;
  // Read the manifest and the running package version directly. A
  // typo / malformed manifest is a manifest-authority error, not a
  // runtime-mismatch error; let `loadManifest` surface its own typed
  // error so existing failure modes stay bounded.
  const manifest = await loadManifest(root);
  const runtime = await packageVersion();
  if (manifest.poiesisVersion === runtime) return;
  throw new PoiesisError(
    "RUNTIME_VERSION_MISMATCH",
    "Executing Poiesis runtime version does not match the project's installed manifest version",
    { project: manifest.poiesisVersion, runtime },
  );
}

export async function autoResolveConfigDefaults(
  root: string,
  config: PoiesisConfig,
): Promise<{ config: ResolvedPoiesisConfig; discovered: { remote: boolean; integrationBranch: boolean; verificationCommands: boolean; tracker: boolean } }> {
  let remote = config.repository?.remote;
  let integrationBranch = config.repository?.integrationBranch;
  let discoveredRemote = false;
  let discoveredBranch = false;

  const remoteList = await run("git", ["remote"], { cwd: root, allowFailure: true });
  const remoteNames = remoteList.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if ((remote === undefined || remote === "origin") && remoteNames.includes("origin")) {
    remote = "origin";
    discoveredRemote = true;
  } else if ((remote === undefined || remote === "") && remoteNames.length === 1) {
    remote = remoteNames[0]!;
    discoveredRemote = true;
  } else if ((remote === undefined || remote === "") && remoteNames.length === 0) {
    throw new PoiesisError("GIT_REMOTE_UNAVAILABLE", "Cannot discover a Git remote in this repository", { root });
  }

  const integrationBranchIsDefault = integrationBranch === undefined || integrationBranch === "" || integrationBranch === "main";
  if (integrationBranchIsDefault && remote !== undefined) {
    const branchList = await run("git", ["branch", "--format=%(refname:short)"], { cwd: root, allowFailure: true });
    const localBranches = branchList.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if ((integrationBranch === undefined || integrationBranch === "") && localBranches.includes("main")) {
      integrationBranch = "main";
      discoveredBranch = true;
    } else if (integrationBranch === "main" && !localBranches.includes("main")) {
      const fetched = await run(
        "git",
        ["ls-remote", "--exit-code", "--heads", remote, "refs/heads/main"],
        { cwd: root, allowFailure: true },
      );
      if (fetched.exitCode !== 0) {
        throw new PoiesisError(
          "INTEGRATION_BRANCH_UNAVAILABLE",
          "Configured integration branch 'main' is not present locally or on the remote",
          { remote, integrationBranch },
        );
      }
      discoveredBranch = false;
    } else if (integrationBranch === undefined || integrationBranch === "") {
      throw new PoiesisError(
        "INTEGRATION_BRANCH_UNAVAILABLE",
        "Cannot discover an integration branch; please set repository.integrationBranch in the config",
      );
    }
  }

  let discoveredVerification = false;
  let verificationCommands = config.verification?.commands ?? [];
  if (verificationCommands.length === 0) {
    const discovered = await discoverVerificationCommands(root);
    if (discovered.length > 0) {
      verificationCommands = discovered;
      discoveredVerification = true;
    }
  }
  if (verificationCommands.length === 0) {
    throw new PoiesisError(
      "NO_VERIFICATION_COMMANDS",
      "Poiesis requires at least one verification command; configure verification.commands or ensure the project exposes a test script",
    );
  }

  let discoveredTracker = false;
  let trackerProvider = config.tracker.provider;
  let trackerProject = config.tracker.project ?? "";
  if (
    (trackerProvider === "github" || trackerProvider === "gitlab") &&
    trackerProject.trim().length === 0 &&
    remote !== undefined
  ) {
    const remotes = await run("git", ["remote", "get-url", "--all", remote], { cwd: root });
    const url = remotes.stdout.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    if (url !== undefined) {
      const parsed = parseTrackerFromUrl(url);
      if (parsed !== null && parsed.provider === trackerProvider) {
        trackerProject = parsed.project;
        discoveredTracker = true;
      }
    }
  }
  if (trackerProject.trim().length === 0) {
    throw new PoiesisError(
      "INVALID_TRACKER_CONFIG",
      "Cannot resolve tracker project; please set tracker.project in the config or configure a recognized Git remote",
      { provider: trackerProvider },
    );
  }

  const resolved: ResolvedPoiesisConfig = {
    schema: 1,
    models: { reasoning: config.models.reasoning, execution: config.models.execution, ...(config.models.roles === undefined ? {} : { roles: config.models.roles }) },
    repository: { remote: remote!, integrationBranch: integrationBranch! },
    tracker: { provider: trackerProvider, project: trackerProject },
    delivery: config.delivery,
    verification: {
      commands: verificationCommands,
      ...(config.verification?.postIntegrationCommands === undefined
        ? {}
        : { postIntegrationCommands: config.verification.postIntegrationCommands }),
    },
  };
  return {
    config: resolved,
    discovered: {
      remote: discoveredRemote,
      integrationBranch: discoveredBranch,
      verificationCommands: discoveredVerification,
      tracker: discoveredTracker,
    },
  };
}

async function discoverVerificationCommands(root: string): Promise<string[]> {
  const packageJsonPath = join(root, "package.json");
  if (!(await exists(packageJsonPath))) return [];
  let value: unknown;
  try {
    value = JSON.parse(await readUtf8(packageJsonPath));
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) return [];
  const scripts = (value as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  const out: string[] = [];
  const scriptRecord = scripts as Record<string, unknown>;
  for (const name of ["test", "lint", "typecheck", "build"]) {
    const script = scriptRecord[name];
    if (typeof script === "string" && script.length > 0) out.push(script);
  }
  return out;
}

export function parseGitHubProject(url: string): string | null {
  const trimmed = url.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch !== null && sshMatch[1] !== undefined && sshMatch[2] !== undefined) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch !== null && httpsMatch[1] !== undefined && httpsMatch[2] !== undefined) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  return null;
}

export function parseGitLabProject(url: string): string | null {
  const trimmed = url.trim();
  // SSH: `git@gitlab.com:<group-path>` (with optional `.git` suffix).
  // Group path may contain nested groups separated by `/`, and must
  // contain at least two non-empty segments (group + project).
  const sshMatch = trimmed.match(/^git@gitlab\.com:(.+?)(?:\.git)?$/);
  if (sshMatch !== null && sshMatch[1] !== undefined) {
    return normalizeGitLabProjectPath(sshMatch[1]);
  }
  // HTTPS / HTTP: `https?://gitlab.com/<group-path>` (with optional
  // `.git` suffix). Same nested-group / minimum-two-segment rule as
  // the SSH form.
  const httpsMatch = trimmed.match(/^https?:\/\/gitlab\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch !== null && httpsMatch[1] !== undefined) {
    return normalizeGitLabProjectPath(httpsMatch[1]);
  }
  return null;
}

/**
 * Normalize the captured GitLab project path: it must contain at least two
 * non-empty slash-separated segments (namespace + project). Nested groups
 * like `group/subgroup/project` are allowed; bare single-segment namespaces
 * (e.g. `group.git`) and empty segments are rejected.
 */
function normalizeGitLabProjectPath(raw: string): string | null {
  if (raw.length === 0) return null;
  const segments = raw.split("/");
  if (segments.length < 2) return null;
  if (segments.some((segment) => segment.length === 0)) return null;
  return raw;
}

export function parseTrackerFromUrl(url: string): { provider: "github" | "gitlab"; project: string } | null {
  const githubProject = parseGitHubProject(url);
  if (githubProject !== null) return { provider: "github", project: githubProject };
  const gitlabProject = parseGitLabProject(url);
  if (gitlabProject !== null) return { provider: "gitlab", project: gitlabProject };
  // Unknown / self-hosted hosts and malformed URLs deliberately do NOT
  // invent a tracker provider; the caller surfaces the unconfigured
  // tracker.project as an explicit validation failure.
  return null;
}

async function materializeFiles(config: PoiesisConfig): Promise<MaterializedFile[]> {
  const templates = await Promise.all(
    templateMappings.map(async (mapping) => ({
      path: mapping.destination,
      kind: mapping.kind,
      content: await readTemplate(mapping.source),
    })),
  );
  return [
    ...templates,
    { path: ".poiesis/config.jsonc", kind: "generated", content: serializeConfig(config) },
  ];
}

export async function verifyGitRepository(root: string, config?: ResolvedPoiesisConfig): Promise<void> {
  const version = await run("git", ["--version"], { cwd: root, allowFailure: true });
  if (version.exitCode !== 0 || !/^git version \d+\.\d+/.test(version.stdout)) {
    throw new PoiesisError("GIT_UNAVAILABLE", "Git is not available", { stderr: version.stderr });
  }
  const topLevel = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root, allowFailure: true });
  if (topLevel.exitCode !== 0 || resolve(topLevel.stdout) !== root) {
    throw new PoiesisError("INVALID_GIT_ROOT", "The explicit root must be the Git repository root", {
      root,
      detected: topLevel.stdout || undefined,
    });
  }
  if (config === undefined) return;

  const remote = await run("git", ["remote", "get-url", config.repository.remote], {
    cwd: root,
    allowFailure: true,
  });
  if (remote.exitCode !== 0 || remote.stdout.length === 0) {
    throw new PoiesisError("GIT_REMOTE_UNAVAILABLE", "Configured Git remote is unavailable", {
      remote: config.repository.remote,
    });
  }
  const remoteBaseAvailable = await run(
    "git",
    ["ls-remote", "--exit-code", "--heads", config.repository.remote, `refs/heads/${config.repository.integrationBranch}`],
    { cwd: root, allowFailure: true },
  );
  if (remoteBaseAvailable.exitCode !== 0 || remoteBaseAvailable.stdout.length === 0) {
    throw new PoiesisError("GIT_REMOTE_UNAVAILABLE", "Configured remote integration branch is unreachable", {
      remote: config.repository.remote,
      branch: config.repository.integrationBranch,
      stderr: remoteBaseAvailable.stderr,
    });
  }
  const localBase = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${config.repository.integrationBranch}`],
    { cwd: root, allowFailure: true },
  );
  const remoteBase = await run(
    "git",
    [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${config.repository.remote}/${config.repository.integrationBranch}`,
    ],
    { cwd: root, allowFailure: true },
  );
  if (localBase.exitCode !== 0 && remoteBase.exitCode !== 0) {
    throw new PoiesisError("INTEGRATION_BRANCH_UNAVAILABLE", "Configured integration branch is unavailable", {
      remote: config.repository.remote,
      branch: config.repository.integrationBranch,
    });
  }
}

export async function verifyModels(root: string, config: ResolvedPoiesisConfig): Promise<void> {
  const result = await run("opencode", ["models"], { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) {
    throw new PoiesisError("MODEL_INVENTORY_UNAVAILABLE", "OpenCode model inventory is unavailable", {
      stderr: result.stderr,
    });
  }
  const available = parseOpenCodeModelInventory(result.stdout);
  const missing = [config.models.reasoning, config.models.execution].filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new PoiesisError("MODEL_UNAVAILABLE", "Configured OpenCode model is unavailable", { missing });
  }
}

/**
 * Single canonical parse of an `opencode models` newline-separated
 * provider/model inventory. Every caller (currently
 * `verifyModels`, but available to future inventory consumers at the
 * same library seam) MUST reuse this function so the trim / blank /
 * dedupe semantics stay consistent.
 */
export function parseOpenCodeModelInventory(stdout: string): Set<string> {
  return new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

async function verifyOpenCodeEnvironment(config: ResolvedPoiesisConfig): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "poiesis-opencode-check-"));
  try {
    await verifyOpenCodeVersion(directory);
    await verifyModels(directory, config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function validateOpenCodeConfigPayload(content: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "poiesis-opencode-config-check-"));
  try {
    await atomicCreate(join(directory, "opencode.jsonc"), content);
    await validateOpenCodeConfig(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}


export async function verifyTracker(root: string, config: ResolvedPoiesisConfig): Promise<"verified" | "fixture"> {
  if (config.tracker.provider === "fixture") return "fixture";
  if (config.tracker.provider === "github") {
    await run("gh", ["auth", "status"], { cwd: root });
    await run("gh", ["repo", "view", config.tracker.project, "--json", "nameWithOwner"], { cwd: root });
    return "verified";
  }
  await run("glab", ["auth", "status"], { cwd: root });
  await run("glab", ["api", `projects/${encodeURIComponent(config.tracker.project)}`], { cwd: root });
  return "verified";
}

export function verifyDeliveryConfiguration(root: string, config: ResolvedPoiesisConfig): "verified" | "fixture" {
  let fixture = false;
  for (const target of ["preview", "staging", "production"] as const) {
    const adapter = createDeliveryAdapter(config.delivery[target], root);
    if (adapter.kind === "fixture") fixture = true;
  }
  return fixture ? "fixture" : "verified";
}

async function assertInitDestinationsAbsent(root: string, files: Array<{ path: string }>): Promise<void> {
  const poiesisDirectory = poiesisPath(root);
  if (await pathEntryExists(poiesisDirectory)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Refusing to initialize over an unowned .poiesis path", {
      path: relative(root, poiesisDirectory),
    });
  }
  for (const file of files) {
    const destination = join(root, file.path);
    await assertSafeParents(root, destination);
    if (await pathEntryExists(destination)) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "Refusing to overwrite a preexisting destination", {
        path: file.path,
      });
    }
  }
  const manifestPath = poiesisPath(root, "manifest.json");
  if (await pathEntryExists(manifestPath)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "A Poiesis manifest already exists", {
      path: relative(root, manifestPath),
    });
  }
}

async function assertGitignoreAvailable(root: string): Promise<boolean> {
  const path = join(root, ".gitignore");
  await assertSafeParents(root, path);
  if (!(await pathEntryExists(path))) return false;
  if (!(await isRegularFile(path))) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore path is not a regular file", {
      path: ".gitignore",
    });
  }
  const bytes = await readFile(path);
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore is not valid UTF-8", { path: ".gitignore" });
  }
  return true;
}

async function removeIfMatching(root: string, path: string, hash: string): Promise<boolean> {
  if (!(await exists(path)) || !(await isRegularManagedFile(root, path))) return false;
  if ((await hashFile(path)) !== hash) return false;
  await unlink(path);
  return true;
}

async function rollbackStep(
  failures: Array<Record<string, unknown>>,
  step: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push({ step, ...errorDetails(error) });
  }
}

async function rollbackInit(
  root: string,
  files: ManagedFile[],
  skills: Manifest["skills"],
  configPath: string,
  configSnapshot: Buffer | null | undefined,
  writtenConfigHash?: string,
): Promise<Array<Record<string, unknown>>> {
  const failures: Array<Record<string, unknown>> = [];
  await rollbackStep(failures, "OpenCode config", async () => {
    if (
      configSnapshot !== undefined &&
      writtenConfigHash !== undefined &&
      (await pathEntryExists(configPath)) &&
      (await isRegularFile(configPath)) &&
      (await hashFile(configPath)) === writtenConfigHash
    ) {
      if (configSnapshot === null) await unlink(configPath);
      else await atomicWrite(configPath, configSnapshot.toString("utf8"));
    }
  });
  await rollbackStep(failures, "skills", async () => {
    const result = await removeOwnedSkills(root, skills);
    if (result.preserved.length > 0) {
      throw new PoiesisError("SKILL_ROLLBACK_INCOMPLETE", "Some authored skills could not be removed", {
        preserved: result.preserved,
      });
    }
  });
  for (const file of [...files].reverse()) {
    await rollbackStep(failures, file.path, async () => {
      await removeIfMatching(root, ownedPath(root, file.path), file.hash);
    });
  }
  return failures;
}

async function createInitFileParents(root: string, files: MaterializedFile[], created: Set<string>): Promise<void> {
  const parents = new Set<string>();
  for (const file of files) {
    let parent = relative(root, join(root, file.path, ".."));
    while (parent !== "" && parent !== ".") {
      parents.add(parent);
      parent = parent.includes(sep) ? parent.slice(0, parent.lastIndexOf(sep)) : "";
    }
  }
  for (const path of [...parents].sort((left, right) => left.split(sep).length - right.split(sep).length)) {
    const destination = join(root, path);
    if (await pathEntryExists(destination)) {
      const details = await lstat(destination);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new PoiesisError("INSTALL_PATH_CONFLICT", "Managed file parent is not a directory", { path });
      }
      continue;
    }
    await mkdir(destination);
    created.add(path);
  }
}

async function removeCreatedInitDirectories(root: string, created: ReadonlySet<string>): Promise<void> {
  for (const path of [...created].sort((left, right) => right.split(sep).length - left.split(sep).length)) {
    try {
      await rmdir(join(root, path));
    } catch {
      // Only empty directories created during init are safe to remove.
    }
  }
}

async function rollbackInitGitignore(path: string, snapshot: Buffer | null | undefined, writtenHash?: string): Promise<void> {
  if (snapshot === undefined || writtenHash === undefined || !(await pathEntryExists(path))) return;
  if (!(await isRegularFile(path)) || (await hashFile(path)) !== writtenHash) return;
  if (snapshot === null) await unlink(path);
  else await atomicWrite(path, snapshot.toString("utf8"));
}

/**
 * Conditional init receipt cleanup. The init catch block calls this helper
 * in place of `removeOwnershipReceipt`. It removes the on-disk receipt
 * ONLY when the failed `init()` invocation recorded a successful
 * `createOwnershipReceipt` AND the on-disk bytes still equal exactly what
 * that invocation wrote. The helper never weakens receipt authority:
 * pre-existing receipts are preserved byte-for-byte, foreign concurrent
 * replacements are preserved byte-for-byte, and an absent receipt is left
 * absent. Ticket #45.
 */
async function rollbackInitOwnershipReceipt(
  root: string,
  authoredReceiptBytes: string | undefined,
): Promise<void> {
  if (authoredReceiptBytes === undefined) return;
  const path = await ownershipReceiptLocation(root);
  let current: Buffer;
  try {
    current = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (Buffer.compare(current, Buffer.from(authoredReceiptBytes, "utf8")) !== 0) return;
  await unlink(path);
}

/**
 * Transactional default-path `.gitignore` seam.
 *
 * Receipt-bearing normal `update` and explicit 1.0.0 `bootstrap` MUST
 * install the `.poiesis/workspaces/` ignore rule before any default-path
 * workspace can leak into the primary checkout as foreign work. `init`
 * installs the rule via the broader init gitignore call. `updateFromConfig`
 * is the strict transactional path and intentionally does NOT mutate
 * `.gitignore` to keep the receipt-authenticated transaction contract
 * identical across the strict set of inputs.
 *
 * `ensureDefaultPathGitignore` only invokes `ensureGitignore` with the
 * transactional rule. The caller is responsible for snapshotting the
 * exact preimage (including absence) BEFORE the try block so any later
 * failure can restore it byte-for-byte via `rollbackDefaultPathGitignore`.
 * `ensureGitignore` returns its post-write content so the caller can
 * capture the commit hash gate and detect concurrent user edits between
 * the write and the rollback. Splitting snapshot + ensure keeps the
 * gitignore mutation inside the transaction; the helper encapsulates
 * only the "what rule to add" logic.
 */
const DEFAULT_PATH_GITIGNORE_HEADER =
  "# Hide the default-path workspace area (Poiesis-managed local state; transactional update/bootstrap line)";
const DEFAULT_PATH_GITIGNORE_PATTERN = ".poiesis/workspaces/";
const DEFAULT_PATH_GITIGNORE_RULES: readonly string[] = [
  DEFAULT_PATH_GITIGNORE_HEADER,
  DEFAULT_PATH_GITIGNORE_PATTERN,
];

async function ensureDefaultPathGitignore(
  root: string,
  expected: Buffer | null,
): Promise<{ writtenHash: string | undefined }> {
  const written = await ensureGitignore(root, [...DEFAULT_PATH_GITIGNORE_RULES], expected);
  return { writtenHash: written === undefined ? undefined : hashContent(written) };
}

async function rollbackDefaultPathGitignore(
  path: string,
  snapshot: Buffer | null,
  writtenHash: string | undefined,
): Promise<void> {
  if (writtenHash === undefined) return;
  if (!(await pathEntryExists(path))) return;
  if (!(await isRegularFile(path)) || (await hashFile(path)) !== writtenHash) return;
  if (snapshot === null) {
    await unlink(path);
    return;
  }
  // Byte-exact restoration: preserve the exact bytes that were snapshotted,
  // including the precise trailing newline state (or absence thereof).
  await atomicWrite(path, snapshot.toString("utf8"));
}

export async function init(root: string, config: PoiesisConfig, options: MaintenanceOptions = {}): Promise<Manifest> {
  const resolvedRoot = resolve(root);
  const resolvedConfig = validateConfig(config, "explicit init config");
  assertResolvedConfig(resolvedConfig);
  await assertInitDestinationsAbsent(
    resolvedRoot,
    templateMappings.map((mapping) => ({ path: mapping.destination })),
  );

  const openCodeConfigPath = await detectOpenCodeConfigForInit(resolvedRoot);
  await assertSafeParents(resolvedRoot, openCodeConfigPath);
  // The Poiesis version is the sole durable source of the exact-version
  // canonical route (`pnpm dlx poiesis-cli@<X>`) projected into the
  // generated OpenCode config. Capture it once at init entry so every
  // downstream ownership assertion and apply step uses the same X.
  const installingPoiesisVersion = await packageVersion();
  const openCodeConfigPresent = await assertOpenCodeConfigAvailable(
    resolvedRoot,
    openCodeConfigPath,
    resolvedConfig,
    installingPoiesisVersion,
  );
  const initialOpenCodeConfigSnapshot = await snapshotFile(openCodeConfigPath);
  await assertGitignoreAvailable(resolvedRoot);
  const initialGitignoreSnapshot = await snapshotFile(join(resolvedRoot, ".gitignore"));
  const initialSkills = options.skipSkills
    ? undefined
    : await assertDefaultSkillDestinationsAvailable(resolvedRoot);

  const resolved = await autoResolveConfigDefaults(resolvedRoot, resolvedConfig);
  const resolvedConfigWithDefaults = resolved.config;
  const files = await materializeFiles(resolvedConfigWithDefaults);

  await verifyGitRepository(resolvedRoot, resolvedConfigWithDefaults);
  await verifyOpenCodeEnvironment(resolvedConfigWithDefaults);
  const trackerMode = await verifyTracker(resolvedRoot, resolvedConfigWithDefaults);
  const deliveryMode = verifyDeliveryConfiguration(resolvedRoot, resolvedConfigWithDefaults);
  if ((trackerMode === "fixture" || deliveryMode === "fixture") && !options.allowFixtureAdapters) {
    throw new PoiesisError(
      "FIXTURE_ADAPTER_NOT_AUTHORIZED",
      "Fixture adapters are test-only and require explicit allowFixtureAdapters authorization",
    );
  }
  const managedFiles: ManagedFile[] = [];
  let managedSkills: Manifest["skills"] = [];
  let configPatches: ConfigPatch[] = [];
  let writtenManifestHash: string | undefined;
  const gitignorePath = join(resolvedRoot, ".gitignore");
  let writtenGitignoreHash: string | undefined;
  const createdInitDirectories = new Set<string>();
  let writtenOpenCodeConfigHash: string | undefined;
  let writtenOpenCodeConfigContent: string | undefined;
  let installedSkillSnapshots: Map<string, string> | undefined;
  // Ticket #46: bounded journal for default-skill mutations. The
  // catch block uses `journal.rollback()` instead of the legacy
  // destructive `removeOwnedSkills` path: foreign writes are
  // preserved and reported via `RollbackDiagnostic` (reason
  // `identity-mismatch`), and the journal owns the preimage backup
  // lifecycle so cleanup is gated on commit/rollback.
  const skillJournal: ArtifactJournal = new ArtifactJournal(32);
  // Ticket #45: exact canonical bytes of the receipt authored by THIS
  // `init()` invocation (set only after a successful `createOwnershipReceipt`),
  // or `undefined` if the receipt was never authored. The catch block uses
  // it to gate receipt removal: pre-existing and concurrently replaced
  // receipts survive byte-for-byte; only this invocation's authored
  // bytes are unlinked on failure.
  let authoredReceiptBytes: string | undefined;

  try {
    await assertInitDestinationsAbsent(resolvedRoot, files);
    await assertGitignoreAvailable(resolvedRoot);
    const currentGitignoreSnapshot = await snapshotFile(gitignorePath);
    const gitignoreUnchanged = initialGitignoreSnapshot === null
      ? currentGitignoreSnapshot === null
      : currentGitignoreSnapshot !== null && initialGitignoreSnapshot.equals(currentGitignoreSnapshot);
    if (!gitignoreUnchanged) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore changed during environment verification", {
        path: ".gitignore",
      });
    }
    if (!options.skipSkills) {
      await assertDefaultSkillDestinationsAvailable(resolvedRoot, initialSkills);
      // Ticket #46: hand the bounded skill journal to installDefaultSkills
      // so every default-skill preimage hash and transaction-written
      // hash is captured into the same journal that owns rollback.
      // Ticket #46: `journal` is an internal-only seam widening the
      // public SkillMaintenanceOptions. Build the options through a
      // local widened type so the structural widening is explicit
      // and the public dist declaration stays free of the transaction
      // surface.
      const initSkillOptions = {
        expectedPreexisting: initialSkills!,
        createdDirectories: createdInitDirectories,
        journal: skillJournal,
      };
      managedSkills = await installDefaultSkills(resolvedRoot, [], initSkillOptions);
      installedSkillSnapshots = await assertDefaultSkillDestinationsAvailable(resolvedRoot);
    }
    await assertInitDestinationsAbsent(resolvedRoot, files);
    const currentOpenCodeConfigPath = await detectOpenCodeConfigForInit(resolvedRoot);
    if (currentOpenCodeConfigPath !== openCodeConfigPath) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config location changed during initialization", {
        before: relative(resolvedRoot, openCodeConfigPath),
        after: relative(resolvedRoot, currentOpenCodeConfigPath),
      });
    }
    await assertSafeParents(resolvedRoot, openCodeConfigPath);
    const currentlyPresent = await assertOpenCodeConfigAvailable(
      resolvedRoot,
      openCodeConfigPath,
      resolvedConfigWithDefaults,
      installingPoiesisVersion,
    );
    if (currentlyPresent !== openCodeConfigPresent) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config presence changed during initialization", {
        path: relative(resolvedRoot, openCodeConfigPath),
      });
    }
    const currentOpenCodeConfigSnapshot = await snapshotFile(openCodeConfigPath);
    const openCodeConfigUnchanged = initialOpenCodeConfigSnapshot === null
      ? currentOpenCodeConfigSnapshot === null
      : currentOpenCodeConfigSnapshot !== null && initialOpenCodeConfigSnapshot.equals(currentOpenCodeConfigSnapshot);
    if (!openCodeConfigUnchanged) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config changed during environment verification", {
        path: relative(resolvedRoot, openCodeConfigPath),
      });
    }
    configPatches = await applyOpenCodeConfig(
      resolvedRoot,
      resolvedConfigWithDefaults,
      openCodeConfigPath,
      installingPoiesisVersion,
      {
        requireAvailable: true,
        expectedContent: initialOpenCodeConfigSnapshot,
        onWritten: (content) => {
          writtenOpenCodeConfigContent = content;
          writtenOpenCodeConfigHash = hashContent(content);
        },
      },
    );
    if (writtenOpenCodeConfigContent === undefined || writtenOpenCodeConfigHash === undefined) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config write did not produce an ownership receipt", {
        path: relative(resolvedRoot, openCodeConfigPath),
      });
    }
    if ((await hashFile(openCodeConfigPath)) !== writtenOpenCodeConfigHash) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config changed after installation", {
        path: relative(resolvedRoot, openCodeConfigPath),
      });
    }
    await validateOpenCodeConfigPayload(writtenOpenCodeConfigContent);
    if (installedSkillSnapshots !== undefined) {
      await assertDefaultSkillDestinationsAvailable(resolvedRoot, installedSkillSnapshots);
    }
    if ((await hashFile(openCodeConfigPath)) !== writtenOpenCodeConfigHash) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config changed during validation", {
        path: relative(resolvedRoot, openCodeConfigPath),
      });
    }
    const currentOpenCodeConfig = await detectOpenCodeConfigForInit(resolvedRoot);
    if (currentOpenCodeConfig !== openCodeConfigPath) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config became ambiguous during initialization", {
        path: relative(resolvedRoot, currentOpenCodeConfig),
      });
    }
    await assertGitignoreAvailable(resolvedRoot);
    const writtenGitignore = await ensureGitignore(resolvedRoot, [
      `# Allow durable Poiesis project files to be tracked`,
      ...POIESIS_DURABLE_PATHS.map((path) => `!${path}`),
      `!${".poiesis"}/`,
      `# Hide local Poiesis state (added by \`poiesis init\` so the default-path workspace area and ownership snapshot never appear as foreign work)`,
      ...POIESIS_LOCAL_STATE_PATHS,
    ], initialGitignoreSnapshot ?? null);
    if (writtenGitignore !== undefined) writtenGitignoreHash = hashContent(writtenGitignore);
    await assertInitDestinationsAbsent(resolvedRoot, files);
    await createInitFileParents(resolvedRoot, files, createdInitDirectories);
    for (const file of files) {
      const destination = join(resolvedRoot, file.path);
      await assertSafeParents(resolvedRoot, destination);
      await atomicCreate(destination, file.content);
      const template = templateMappings.find((mapping) => mapping.destination === file.path);
      managedFiles.push({
        path: file.path,
        kind: file.kind,
        hash: hashContent(file.content),
        owned: true,
        ...(template?.trackInProject === true ? { durable: true } : {}),
      });
    }

    if (!currentlyPresent) {
      managedFiles.push({
        path: relative(resolvedRoot, openCodeConfigPath),
        kind: "generated",
        hash: writtenOpenCodeConfigHash,
        owned: true,
      });
    }

    const manifest: Manifest = {
      schema: 1,
      poiesisVersion: await packageVersion(),
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
      files: managedFiles,
      skills: managedSkills,
      configPatches,
    };
    const manifestContent = serializeManifest(manifest);
    await atomicCreate(poiesisPath(resolvedRoot, "manifest.json"), manifestContent);
    writtenManifestHash = hashContent(manifestContent);
    // Ticket #45: capture the receipt authored by THIS invocation BEFORE
    // any subsequent step so the catch block can gate removal on exact
    // identity. `createOwnershipReceipt` returns the canonical
    // `OwnershipReceipt` object; the on-disk bytes are the canonical
    // `${JSON.stringify(receipt, null, 2)}\n` form emitted by
    // `writeReceipt` in `src/receipt.ts`.
    const authoredReceipt = await createOwnershipReceipt(resolvedRoot, manifest);
    authoredReceiptBytes = `${JSON.stringify(authoredReceipt, null, 2)}\n`;
    if (!options.skipSkills) {
      const report = await doctor(resolvedRoot);
      if (!report.ok) {
        throw new PoiesisError("INIT_DOCTOR_FAILED", "Poiesis installation did not pass doctor", { report });
      }
      await assertDefaultSkillDestinationsAvailable(resolvedRoot, installedSkillSnapshots);
      if ((await hashFile(openCodeConfigPath)) !== writtenOpenCodeConfigHash) {
        throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config changed during final verification", {
          path: relative(resolvedRoot, openCodeConfigPath),
        });
      }
    }
    // Ticket #46: commit the bounded skill journal after every init
    // write has succeeded so the journal-owned preimage backups are
    // removed only after commit. `commit()` swallows its own cleanup
    // failures so they cannot turn a committed init into a failure.
    await skillJournal.commit();
    return manifest;
  } catch (error) {
    const rollbackFailures: Array<Record<string, unknown>> = [];
    const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
    // Ticket #45: receipt cleanup is identity-gated. The helper only
    // unlinks the receipt when THIS `init()` invocation authored it AND
    // the on-disk bytes still equal those exact authored bytes.
    // Pre-existing and concurrently replaced receipts survive
    // byte-for-byte; receipt authority is never weakened by a partial
    // init rollback.
    await rollbackStep(rollbackFailures, "ownership receipt", async () => {
      await rollbackInitOwnershipReceipt(resolvedRoot, authoredReceiptBytes);
    });
    await rollbackStep(rollbackFailures, ".poiesis/manifest.json", async () => {
      if (
        writtenManifestHash !== undefined &&
        (await pathEntryExists(manifestPath)) &&
        (await isRegularFile(manifestPath)) &&
        (await hashFile(manifestPath)) === writtenManifestHash
      ) {
        await unlink(manifestPath);
      }
    });
    // Ticket #46: roll back default-skill mutations through the bounded
    // journal FIRST (reverse write order via the journal's own loop),
    // preserving concurrent foreign changes via `RollbackDiagnostic`.
    // The non-skill portion of `rollbackInit` still runs after to
    // restore managed files + OpenCode config from their snapshots.
    await rollbackStep(rollbackFailures, "skills (journal)", async () => {
      const diagnostics = await skillJournal.rollback();
      if (diagnostics.length > 0) {
        const preserved = diagnostics.map((diagnostic) => ({
          path: relative(resolvedRoot, diagnostic.path),
          reason: diagnostic.reason,
        }));
        throw new PoiesisError("SKILL_ROLLBACK_INCOMPLETE", "Some default-skill mutations could not be rolled back", {
          preserved,
        });
      }
    });
    // The skill journal now owns the per-skill preimage backup lifecycle,
    // so the legacy `rollbackInit` call no longer needs to roll back
    // skills via `removeOwnedSkills`. Pass an empty skills array so the
    // non-skill rollback path still handles the rest of the init-owned
    // surface.
    rollbackFailures.push(...await rollbackInit(
      resolvedRoot,
      managedFiles,
      [],
      openCodeConfigPath,
      initialOpenCodeConfigSnapshot,
      writtenOpenCodeConfigHash,
    ));
    await rollbackStep(rollbackFailures, ".gitignore", async () => {
      await rollbackInitGitignore(gitignorePath, initialGitignoreSnapshot, writtenGitignoreHash);
    });
    await rollbackStep(rollbackFailures, "created directories", async () => {
      await removeCreatedInitDirectories(resolvedRoot, createdInitDirectories);
    });
    if (rollbackFailures.length > 0) {
      throw new PoiesisError("INIT_ROLLBACK_INCOMPLETE", "Initialization failed and rollback was incomplete", {
        initialError: errorDetails(error),
        rollbackFailures,
      });
    }
    throw error;
  }
}

function getAtPath(value: unknown, path: string[]): { exists: boolean; value?: unknown } {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return { exists: false };
    current = (current as JsonObject)[part];
  }
  return { exists: true, value: current };
}

function patchKey(patch: Pick<ConfigPatch, "file" | "path">): string {
  return `${patch.file}\0${patch.path.join("\0")}`;
}

export async function assertConfigPatchesOwned(root: string, patches: ConfigPatch[]): Promise<void> {
  for (const [file, filePatches] of groupPatchesByFile(patches)) {
    const path = ownedPath(root, file);
    if (!(await exists(path)) || !(await isRegularManagedFile(root, path))) {
      throw new PoiesisError("CONFIG_OWNERSHIP_LOST", "Managed config file is missing or not a regular file", { file });
    }
    const current = parseJsonc<JsonObject>(await readUtf8(path), path);
    for (const patch of filePatches) {
      const value = getAtPath(current, patch.path);
      if (!value.exists || !isDeepStrictEqual(value.value, patch.installed)) {
        throw new PoiesisError("CONFIG_OWNERSHIP_LOST", "Managed config value was changed", {
          file,
          path: patch.path,
        });
      }
    }
  }
}

async function reverseMatchingConfigPatches(
  root: string,
  patches: ConfigPatch[],
): Promise<{ reverted: ConfigPatch[]; preserved: ConfigPatch[] }> {
  const reverted: ConfigPatch[] = [];
  const preserved: ConfigPatch[] = [];
  for (const [file, filePatches] of groupPatchesByFile(patches)) {
    const path = ownedPath(root, file);
    if (!(await exists(path))) {
      reverted.push(...filePatches);
      continue;
    }
    if (!(await isRegularManagedFile(root, path))) {
      preserved.push(...filePatches);
      continue;
    }
    let content = await readUtf8(path);
    let changed = false;
    for (const patch of [...filePatches].reverse()) {
      const current = parseJsonc<JsonObject>(content, path);
      const value = getAtPath(current, patch.path);
      if (!value.exists || !isDeepStrictEqual(value.value, patch.installed)) {
        const alreadyRestored = patch.previousExists
          ? value.exists && isDeepStrictEqual(value.value, patch.previous)
          : !value.exists;
        if (alreadyRestored) {
          reverted.push(patch);
          continue;
        }
        preserved.push(patch);
        continue;
      }
      content = applyEdits(
        content,
        modify(content, patch.path, patch.previousExists ? patch.previous : undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }),
      );
      reverted.push(patch);
      changed = true;
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
      changed = true;
    }
    if (changed) await atomicWrite(path, content.endsWith("\n") ? content : `${content}\n`);
  }
  return { reverted, preserved };
}

function groupPatchesByFile(patches: ConfigPatch[]): Map<string, ConfigPatch[]> {
  const grouped = new Map<string, ConfigPatch[]>();
  for (const patch of patches) grouped.set(patch.file, [...(grouped.get(patch.file) ?? []), patch]);
  return grouped;
}



export async function resolveConfigForRoot(root: string, draft?: PoiesisConfig): Promise<ResolvedPoiesisConfig> {
  const raw = draft ?? (await loadConfig(root));
  assertResolvedConfig(raw);
  const entry = await autoResolveConfigDefaults(resolve(root), raw);
  return entry.config;
}

export async function resolveConfigRoot(cwd: string): Promise<string> {
  const commonDirResult = await run("git", ["rev-parse", "--git-common-dir"], { cwd, allowFailure: true });
  const resolvedCommonDir = commonDirResult.exitCode === 0
    ? resolve(isAbsolute(commonDirResult.stdout) ? commonDirResult.stdout : resolve(cwd, commonDirResult.stdout))
    : resolve(cwd);
  const parent = resolvedCommonDir.replace(/\/$/, "").replace(/\/[^/]+$/, "");
  if (parent === "" || parent === resolvedCommonDir) return resolve(cwd);
  const configPath = join(parent, ".poiesis", "config.jsonc");
  if (await exists(configPath)) return parent;
  return resolve(cwd);
}

export async function doctor(root: string): Promise<DoctorReport> {
  const resolvedRoot = resolve(root);
  const checks: DoctorCheck[] = [];
  let config: ResolvedPoiesisConfig | undefined;
  let manifest: Manifest | undefined;

  try {
    const rawConfig = await loadConfig(resolvedRoot);
    assertResolvedConfig(rawConfig);
    config = await resolveConfigForRoot(resolvedRoot, rawConfig);
    checks.push({ id: "config", status: "pass", message: "Poiesis config is valid" });
  } catch (error) {
    checks.push({ id: "config", status: "fail", message: "Poiesis config is invalid or missing", details: errorDetails(error) });
  }

  try {
    manifest = await loadManifest(resolvedRoot);
    if (config === undefined) {
      throw new PoiesisError("MANIFEST_AUTHORITY_INVALID", "Manifest authority cannot be checked without valid Poiesis config");
    }
    await assertManifestAuthority(resolvedRoot, manifest, config);
    checks.push({ id: "manifest", status: "pass", message: "Ownership manifest matches the installed adapter" });
  } catch (error) {
    checks.push({ id: "manifest", status: "fail", message: "Ownership manifest is invalid or unauthorized", details: errorDetails(error) });
  }

  if (manifest !== undefined) {
    try {
      await assertOwnershipReceipt(resolvedRoot, manifest);
      checks.push({ id: "receipt", status: "pass", message: "Ownership receipt matches this repository and manifest" });
    } catch (error) {
      checks.push({ id: "receipt", status: "fail", message: "Ownership receipt is missing or mismatched", details: errorDetails(error) });
    }
  }

  if (manifest !== undefined) {
    const failures: Array<Record<string, unknown>> = [];
    const warnings: Array<Record<string, unknown>> = [];
    const patchedConfigFiles = new Set(manifest.configPatches.map((patch) => patch.file));
    for (const file of manifest.files) {
      try {
        const path = ownedPath(resolvedRoot, file.path);
        if (!(await exists(path)) || !(await isRegularManagedFile(resolvedRoot, path))) failures.push({ path: file.path, reason: "missing or not a regular file" });
        else {
          const actual = await hashFile(path);
          if (actual !== file.hash) {
            const finding = { path: file.path, expected: file.hash, actual };
            if (patchedConfigFiles.has(file.path)) warnings.push({ ...finding, reason: "generated config has unrelated changes" });
            else failures.push(finding);
          }
        }
      } catch (error) {
        failures.push({ path: file.path, ...errorDetails(error) });
      }
    }
    checks.push({
      id: "hashes",
      status: failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
      message: failures.length > 0 ? "Managed file ownership has changed" : warnings.length > 0 ? "Managed files are healthy; generated config has foreign edits" : "All managed file hashes match",
      ...(failures.length > 0 || warnings.length > 0 ? { details: { failures, warnings } } : {}),
    });

    try {
      const defaults = await loadDefaultSkills();
      const failures: Array<Record<string, unknown>> = [];
      const warnings: Array<Record<string, unknown>> = [];
      for (const expected of defaults) {
        const skill = manifest.skills.find((candidate) => candidate.name === expected.name);
        if (skill === undefined) {
          failures.push({ name: expected.name, reason: "not recorded" });
          continue;
        }
        const expectedPath = relative(resolvedRoot, skillPath(resolvedRoot, skill.name));
        if (skill.source !== expected.source || skill.path !== expectedPath) {
          failures.push({ name: expected.name, reason: "provenance mismatch" });
          continue;
        }
        if (!skill.preexisting && skill.installedRevision !== expected.revision) {
          failures.push({ name: expected.name, reason: "installed revision is not pinned" });
          continue;
        }
        const path = ownedPath(resolvedRoot, skill.path);
        if (!(await exists(path))) {
          failures.push({ name: expected.name, reason: "directory missing" });
          continue;
        }
        const actual = await hashOwnedSkillDirectory(path);
        if (!skill.preexisting && (skill.hash === undefined || actual !== skill.hash)) {
          failures.push({ name: expected.name, reason: "owned directory hash changed" });
        } else if (skill.preexisting && skill.hash !== undefined && actual !== skill.hash) {
          warnings.push({ name: expected.name, reason: "preexisting user-owned directory changed" });
        }
      }
      checks.push({
        id: "skills",
        status: failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
        message: failures.length > 0 ? "Default skill installation is unhealthy" : "Default skills are available",
        ...(failures.length > 0 || warnings.length > 0 ? { details: { failures, warnings } } : {}),
      });
    } catch (error) {
      checks.push({ id: "skills", status: "fail", message: "Default skills could not be inspected", details: errorDetails(error) });
    }
  } else {
    checks.push({ id: "hashes", status: "fail", message: "Managed hashes cannot be checked without a manifest" });
    checks.push({ id: "skills", status: "fail", message: "Skills cannot be checked without a manifest" });
  }

  try {
    const installed = await verifyOpenCodeVersion(resolvedRoot);
    checks.push({ id: "opencode-version", status: "pass", message: "OpenCode version is supported", details: { installed } });
  } catch (error) {
    checks.push({ id: "opencode-version", status: "fail", message: "OpenCode version is unsupported or unavailable", details: errorDetails(error) });
  }

  if (config !== undefined) {
    try {
      await verifyModels(resolvedRoot, config);
      checks.push({ id: "models", status: "pass", message: "Configured reasoning and execution models are available" });
    } catch (error) {
      checks.push({ id: "models", status: "fail", message: "Configured model check failed", details: errorDetails(error) });
    }
  } else {
    checks.push({ id: "models", status: "fail", message: "Models cannot be checked without valid config" });
  }

  if (config !== undefined && manifest !== undefined) {
    try {
      await assertConfigPatchesOwned(resolvedRoot, manifest.configPatches);
      // Doctor projects the desired OpenCode config against the manifest's
      // recorded `poiesisVersion` so the strict authority check recognizes
      // every owned patch as installed by THIS package, even when the
      // current runtime image is newer than the recorded install.
      const desired = desiredOpenCodePatches(config, manifest.poiesisVersion);
      const recorded = new Map(manifest.configPatches.map((patch) => [patch.path.join("\0"), patch]));
      const mismatches = desired.filter((patch) => {
        const installed = recorded.get(patch.path.join("\0"));
        return installed === undefined || !isDeepStrictEqual(installed.installed, patch.value);
      });
      if (mismatches.length > 0) {
        throw new PoiesisError("OPENCODE_CONFIG_OUTDATED", "OpenCode config does not match the current adapter projection", {
          paths: mismatches.map((patch) => patch.path),
        });
      }
      checks.push({ id: "opencode-config", status: "pass", message: "OpenCode config patches are present and owned" });
    } catch (error) {
      checks.push({ id: "opencode-config", status: "fail", message: "OpenCode config projection is unhealthy", details: errorDetails(error) });
    }
  } else {
    checks.push({ id: "opencode-config", status: "fail", message: "OpenCode config cannot be checked without valid Poiesis config and manifest" });
  }

  try {
    await validateOpenCodeConfig(resolvedRoot);
    checks.push({ id: "opencode-schema", status: "pass", message: "OpenCode accepts the merged project config" });
  } catch (error) {
    checks.push({ id: "opencode-schema", status: "fail", message: "OpenCode rejected the merged project config", details: errorDetails(error) });
  }

  try {
    await verifyGitRepository(resolvedRoot);
    const version = await run("git", ["--version"], { cwd: resolvedRoot });
    checks.push({ id: "git", status: "pass", message: "Git repository is available", details: { version: version.stdout } });
  } catch (error) {
    checks.push({ id: "git", status: "fail", message: "Git repository check failed", details: errorDetails(error) });
  }

  if (config !== undefined) {
    try {
      const remote = await run("git", ["remote", "get-url", config.repository.remote], { cwd: resolvedRoot, allowFailure: true });
      if (remote.exitCode !== 0 || remote.stdout.length === 0) throw new PoiesisError("GIT_REMOTE_UNAVAILABLE", "Configured remote is unavailable");
      checks.push({ id: "git-remote", status: "pass", message: "Configured Git remote is available", details: { name: config.repository.remote, url: remote.stdout } });
    } catch (error) {
      checks.push({ id: "git-remote", status: "fail", message: "Configured Git remote check failed", details: errorDetails(error) });
    }
    try {
      await verifyGitRepository(resolvedRoot, config);
      checks.push({ id: "git-base", status: "pass", message: "Configured integration branch is available", details: { branch: config.repository.integrationBranch } });
    } catch (error) {
      checks.push({ id: "git-base", status: "fail", message: "Configured integration branch check failed", details: errorDetails(error) });
    }
    try {
      const mode = await verifyTracker(resolvedRoot, config);
      checks.push({
        id: "tracker",
        status: mode === "fixture" ? "warn" : "pass",
        message: mode === "fixture" ? "Test-only fixture tracker is configured" : "Tracker authentication and project are available",
        details: { provider: config.tracker.provider, project: config.tracker.project },
      });
    } catch (error) {
      checks.push({ id: "tracker", status: "fail", message: "Tracker authentication or project check failed", details: errorDetails(error) });
    }
    try {
      const mode = verifyDeliveryConfiguration(resolvedRoot, config);
      checks.push({
        id: "delivery",
        status: mode === "fixture" ? "warn" : "pass",
        message: mode === "fixture" ? "Test-only fixture delivery is configured" : "Preview, staging, and production adapters are valid",
        details: {
          preview: config.delivery.preview.adapter,
          staging: config.delivery.staging.adapter,
          production: config.delivery.production.adapter,
        },
      });
    } catch (error) {
      checks.push({ id: "delivery", status: "fail", message: "Delivery adapter configuration is invalid", details: errorDetails(error) });
    }
  } else {
    checks.push({ id: "git-remote", status: "fail", message: "Git remote cannot be checked without valid config" });
    checks.push({ id: "git-base", status: "fail", message: "Integration branch cannot be checked without valid config" });
    checks.push({ id: "tracker", status: "fail", message: "Tracker configuration is invalid or missing" });
    checks.push({ id: "delivery", status: "fail", message: "Delivery configuration is invalid or missing" });
  }

  return { root: resolvedRoot, ok: !checks.some((check) => check.status === "fail"), checks };
}

async function requireOwnedManagedFile(root: string, record: ManagedFile): Promise<void> {
  const path = ownedPath(root, record.path);
  if (!(await exists(path)) || !(await isRegularManagedFile(root, path))) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Managed file is missing or not a regular file", { path: record.path });
  }
  const actual = await hashFile(path);
  if (actual !== record.hash) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Refusing to update a modified managed file", {
      path: record.path,
      expected: record.hash,
      actual,
    });
  }
}

/**
 * Public entry point for the receipt-authenticated ordinary `update()`
 * transaction and the explicit 1.0.0 bootstrap. The implementation is
 * in `src/update-internal.ts`, which is NOT re-exported via `src/index.ts`,
 * so the security-sensitive fault-injection surface stays confined to the
 * repo and never appears in the packed `dist/index.d.ts` declaration.
 */
export async function update(root: string, options: MaintenanceOptions = {}): Promise<UpdateResult> {
  if (options.bootstrapLegacyOwnership) {
    return runBootstrapLegacyOwnershipTransaction(root, options, {});
  }
  return runUpdateTransaction(root, options, {});
}

async function snapshotFile(path: string): Promise<Buffer | null> {
  if (!(await exists(path))) return null;
  return readFile(path);
}

async function snapshotFileIfOwned(
  path: string,
  root: string,
  records: ManagedFile[],
): Promise<Buffer | null> {
  const relativePath = relative(root, path);
  const record = records.find((entry) => entry.path === relativePath);
  if (record === undefined) return null;
  if (!(await exists(path))) return null;
  return readFile(path);
}


async function listTree(root: string, directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    paths.push(relative(root, child));
    if (entry.isDirectory()) paths.push(...(await listTree(root, child)));
  }
  return paths;
}

function knownPoiesisPaths(manifest: Manifest): Set<string> {
  const known = new Set<string>([".poiesis", ".poiesis/manifest.json", ".poiesis/roles"]);
  for (const file of manifest.files) {
    if (!file.path.startsWith(".poiesis/")) continue;
    known.add(file.path);
    let parent = file.path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      known.add(parent);
    }
  }
  return known;
}

/**
 * Test-only deterministic fault-injection hooks used by
 * `runCapabilityInstallTransaction`. Each callback fires immediately
 * BEFORE the corresponding write step (or immediately AFTER for
 * `post*` hooks). Throwing from a hook simulates an I/O fault and
 * exercises the rollback path.
 *
 * The seam mirrors `UpdateBootstrapTransactionHooks` (ticket #46) and
 * is intentionally NOT part of the public `installAuthorizedCapability`
 * declaration or the package root re-exports. Tests import
 * `runCapabilityInstallTransaction` directly from this module and
 * supply hooks; production callers (CLI, library users) call the
 * public `installAuthorizedCapability(root, input)` wrapper which
 * delegates with empty hooks and never surfaces the seam.
 *
 * The interface declaration remains `export` so the source-internal
 * transaction runner can be type-checked against it; the public API
 * test asserts neither the interface nor any of its members leak
 * through `dist/index.d.ts`.
 */
export interface CapabilityInstallTransactionHooks {
  /**
   * Exposes the bounded in-memory journal to transaction tests after
   * the upfront receipt capture, before any other artifact is
   * captured. The journal's entries are read-only at this point.
   */
  onJournalReady?: (entries: readonly ArtifactJournalEntry[]) => void | Promise<void>;
  /**
   * Exposes the bounded in-memory journal to transaction tests after
   * every artifact (receipt, destination directory, manifest) has
   * been captured, before any write fires. Used by tests that need to
   * observe the journal's captured preimage backups (e.g. the
   * destination's `preimageBackup` path).
   */
  onCapturesReady?: (entries: readonly ArtifactJournalEntry[]) => void | Promise<void>;
  /**
   * Called immediately AFTER `installCapability` returns but BEFORE
   * the next transactional write (manifest write or receipt write).
   * Tests use this hook to land a concurrent foreign write to the
   * capability directory between the transaction's
   * `recordDirectoryWrite` binding and the next write. The bounded
   * journal's hash-gated rollback must preserve the foreign write
   * and report it via `RollbackDiagnostic` (reason
   * `identity-mismatch`).
   */
  postCapabilityInstall?: () => void | Promise<void>;
  /**
   * Optional pre-staged capability directory. When supplied, the
   * transaction routes `installCapability` through this directory
   * instead of running the network-bound `stageSkills` step. The
   * directory MUST mirror the layout `.agents/skills/<name>/...`
   * that `stageSkills` produces. Used by tests that exercise the
   * transactional install/rollback contract without contacting the
   * upstream registry. NOT part of the public surface.
   */
  preimageCapabilityDirectory?: string;
  /** Called immediately before atomic-writing the new `.poiesis/manifest.json`. */
  preManifestWrite?: () => void | Promise<void>;
  /** Called immediately AFTER atomic-writing the new `.poiesis/manifest.json`. */
  postManifestWrite?: () => void | Promise<void>;
  /** Called immediately before the receipt write (replace for capability install). */
  preReceiptReplace?: () => void | Promise<void>;
  /** Called immediately AFTER the receipt write (replace for capability install). */
  postReceiptReplace?: () => void | Promise<void>;
}

/**
 * Source-internal transaction runner for capability installation.
 *
 * This is the SINGLE implementation of the receipt-authenticated
 * capability install transaction. It accepts an optional
 * `CapabilityInstallTransactionHooks` parameter so the test suite
 * can drive deterministic preimage/journal/fault scenarios without
 * monkey-patching internal modules.
 *
 * The seam lives in this module; `src/index.ts` does NOT re-export
 * this function so the security-sensitive fault-injection surface
 * stays confined to the repo and never appears in the packed
 * `dist/index.d.ts` declaration. The public
 * `installAuthorizedCapability(root, input)` wrapper below is the
 * only entry point re-exported through the package root; it
 * delegates here with empty hooks.
 *
 * Mirrors the ticket #46 pattern: `runUpdateTransaction` is the
 * internal runner for `update()` (which is the public function with
 * no hooks). `runCapabilityInstallTransaction` is the internal
 * runner for `installAuthorizedCapability()` (which is the public
 * function with no hooks).
 */
export async function runCapabilityInstallTransaction(
  root: string,
  input: CapabilityInstallInput,
  hooks?: CapabilityInstallTransactionHooks,
): Promise<ManagedSkill> {
  const resolvedRoot = resolve(root);
  // Spec #104 / ticket #106: pre-mutation runtime identity guard.
  // `capability install` is not an upgrade channel, so a version
  // mismatch fails closed before any transaction capture / write /
  // receipt advance runs.
  await assertRuntimeVersionMatchesProject(resolvedRoot);
  const manifest = await loadManifest(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  await assertManifestAuthority(resolvedRoot, manifest, config);
  const receipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  const receiptPath = await ownershipReceiptLocation(resolvedRoot);
  // Ticket #47: capture every artifact the capability transaction
  // mutates into a bounded `ArtifactJournal` BEFORE any transaction
  // write. The journal owns the unified rollback path: it hash-gates
  // the destination against `transactionWrittenIdentity` (preserving
  // concurrent foreign writes via `RollbackDiagnostic` reason
  // `identity-mismatch`), restores the EXACT manifest preimage when
  // the on-disk file still matches the transaction-written bytes,
  // and restores the receipt preimage the same way. Successful
  // transactions call `commit()` which removes every journal-owned
  // preimage backup after every write has succeeded; cleanup failures
  // are swallowed inside `commit()` so a transient cleanup failure
  // cannot turn a committed capability install into a failure.
  //
  // The journal limit (4) covers the receipt (whole-file), the
  // manifest (whole-file, captured inside `installCapability`), the
  // destination directory (directory-mode, captured inside
  // `installCapability`), and one slot of headroom for any future
  // artifact.
  const journal = new ArtifactJournal(4);
  // Ticket #47: the journal captures the receipt upfront because the
  // receipt write happens AFTER `installCapability` returns. The
  // capability destination directory and the manifest are captured
  // INSIDE `installCapability` (when the journal is supplied) so the
  // capture is always immediately before the corresponding write —
  // a foreign writer that mutates either between capture and write is
  // preserved by the journal's reverse hash-gated rollback.
  await journal.capture(receiptPath, "whole-file");
  await hooks?.onJournalReady?.(journal.entries);
  try {
    // Ticket #47: widen the public `CapabilityMaintenanceOptions`
    // surface at the call site so the bounded journal seam is
    // threaded through `installCapability` without leaking through
    // `dist/index.d.ts`. The seam is widened through structural typing
    // (same pattern as `installDefaultSkills` for ticket #46): the
    // intermediate `capabilityOptions` variable carries the wider
    // type and is passed by reference, so TypeScript's excess-property
    // check applies to the variable, not the literal at the call site.
    const capabilityOptions: {
      journal: ArtifactJournal;
      preimageCapabilityDirectory?: string;
      onCapturesReady?: (entries: readonly ArtifactJournalEntry[]) => void | Promise<void>;
    } = {
      journal,
    };
    if (hooks?.preimageCapabilityDirectory !== undefined) {
      capabilityOptions.preimageCapabilityDirectory = hooks.preimageCapabilityDirectory;
    }
    if (hooks?.onCapturesReady !== undefined) {
      capabilityOptions.onCapturesReady = hooks.onCapturesReady;
    }
    const installed = await installCapability(resolvedRoot, input, capabilityOptions);
    await hooks?.postCapabilityInstall?.();
    const next = await loadManifest(resolvedRoot);
    const nextReceipt: OwnershipReceipt = {
      ...receipt,
      manifestDigest: hashContent(serializeManifest(next)),
      generation: receipt.generation + 1,
    };
    const nextReceiptBytes = `${JSON.stringify(nextReceipt, null, 2)}\n`;
    // Ticket #47: the manifest write goes through the journal's
    // hash-gated `replace` so a foreign writer landing between
    // capture and write surfaces as `RollbackDiagnostic` (reason
    // `identity-mismatch`). The manifest capture happens INSIDE
    // `installCapability` immediately before its hash-gated `replace`
    // (the journal's `expectedPreWriteIdentity` guard sees the exact
    // preimage bytes Poiesis owned at the start of the
    // transaction). The `installCapability` helper writes the manifest
    // through `journal.replace` when the journal is supplied, so this
    // `preManifestWrite` / `postManifestWrite` hook pair fires around
    // that hash-gated replace.
    await hooks?.preManifestWrite?.();
    // The manifest entry was already written by `installCapability`
    // through `journal.replace` (when the journal is supplied). Hook
    // consumers can observe the post-write state via the journal's
    // `transactionWrittenIdentity` on the manifest entry.
    await hooks?.postManifestWrite?.();
    // Ticket #47: the receipt write goes through the journal's
    // hash-gated `replace` so the post-write identity is bound to the
    // exact bytes Poiesis is about to write; a foreign writer that
    // lands between the receipt capture and this write is preserved
    // and reported as `identity-mismatch`. The receipt is captured
    // upfront (line above) so the journal's `expectedPreWriteIdentity`
    // guard sees the exact preimage bytes Poiesis owned at the start
    // of the transaction.
    const receiptEntry = journal.entries.find((candidate) => candidate.path === receiptPath);
    if (receiptEntry === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the receipt entry", { path: receiptPath });
    }
    await hooks?.preReceiptReplace?.();
    await journal.replace(receiptEntry, nextReceiptBytes);
    await hooks?.postReceiptReplace?.();
    await journal.commit();
    return installed;
  } catch (error) {
    // Ticket #47: fail-closed rollback through the bounded journal.
    // The journal walks its captured entries in reverse capture order
    // and, for every entry whose on-disk identity still matches the
    // recorded `transactionWrittenIdentity`, restores the preimage.
    // Foreign replacements that land between this transaction's last
    // write and the rollback are preserved on disk and surfaced via
    // `RollbackDiagnostic` (reason `identity-mismatch`).
    const diagnostics = await journal.rollback();
    if (diagnostics.length > 0) {
      if (error instanceof PoiesisError) {
        error.details.incompleteRollback = diagnostics;
      } else {
        throw new PoiesisError("ROLLBACK_INCOMPLETE", "Capability transaction failed and rollback was incomplete", {
          cause: error instanceof Error ? error.message : String(error),
          incompleteRollback: diagnostics,
        });
      }
    }
    throw error;
  }
}

/**
 * Public capability installation entry point. Exactly two
 * parameters: `(root, input)`. Delegates to
 * `runCapabilityInstallTransaction` with empty hooks so production
 * callers never see the test-only seam.
 *
 * Callers who need the test-only preimage / journal / fault hooks
 * MUST import `runCapabilityInstallTransaction` directly from
 * `src/maintenance.js` (the internal seam); they MUST NOT reach for
 * a hooks parameter on this public wrapper — none exists.
 */
export async function installAuthorizedCapability(
  root: string,
  input: CapabilityInstallInput,
): Promise<ManagedSkill> {
  return runCapabilityInstallTransaction(root, input);
}


/**
 * Options accepted by `updateFromConfig`. The `bootstrapLegacyOwnership`,
 * `skipSkills`, and `allowFixtureAdapters` keys are FORBIDDEN because
 * `poiesis update --config <path>` is a narrowly scoped transaction that does
 * not bootstrap legacy ownership, skip skills, or accept fixture adapters;
 * setting any of these to `true` throws `INCOMPATIBLE_UPDATE_OPTIONS` before
 * any side effect.
 *
 */
export interface UpdateConfigOptions {
  bootstrapLegacyOwnership?: boolean;
  skipSkills?: boolean;
  allowFixtureAdapters?: boolean;
}

/**
 * Public entry point for the authenticated `poiesis update --config <file>`
 * transaction. The implementation is in a sibling module that is not
 * re-exported via `src/index.ts`, so the security-sensitive fault-injection
 * surface stays confined to the repo and never appears in the packed
 * `dist/index.d.ts` declaration.
 */
export async function updateFromConfig(
  root: string,
  configPath: string,
  options: UpdateConfigOptions = {},
): Promise<UpdateResult> {
  return runUpdateConfigTransaction(root, configPath, options, {});
}

/**
 * Canonical user-facing model class identifiers. These are the only
 * values `setModel` (and the matching CLI subcommand) accept; every
 * other input is rejected fail-closed with `INVALID_MODEL_CLASS` before
 * any side effect. Mirrors the user-facing classes documented in
 * POIESIS_FOUNDATION_v1.1 §45 (User-facing model classes).
 */
export type ModelClassName = "reasoning" | "execution";

/**
 * `setModel` adds a structured `restart` notice to the standard
 * `UpdateResult` shape. The notice tells the operator that OpenCode
 * must be restarted for the new model configuration to take effect;
 * Poiesis intentionally does NOT start, stop, or signal OpenCode on
 * the operator's behalf (per ticket #56 constraint: "do not restart
 * OpenCode"). The `started` flag is a literal `false` so the field is
 * self-describing in the JSON payload — it is never set to `true`.
 */
export interface SetModelResult extends UpdateResult {
  restart: { notice: string; started: false };
}

const MODEL_ID_FORMAT = /^[^/]+\/.+$/;
const MODEL_INTERACTIVE_HINT =
  "use `poiesis model` on a TTY for the interactive selector, or `poiesis model set reasoning|execution <provider/model>` for the deterministic single-class set";

/**
 * Deterministic wrapper for `poiesis model set reasoning|execution <id>`.
 *
 * This is the THIN wrapper around `updateFromConfig` for ticket #56.
 * It performs exactly three steps and nothing else:
 *
 *   1. Validate `className` and `modelId` against the canonical format
 *      and probe the live OpenCode model inventory via `opencode models`.
 *      A missing class throws `INVALID_MODEL_CLASS`, a missing ID format
 *      throws `INVALID_MODEL_ID`, and an ID that is not in the live
 *      inventory throws `MODEL_UNAVAILABLE` — all BEFORE any byte is
 *      written and BEFORE the candidate config file is staged. There
 *      is no model substitution (ticket #48: "no substitute").
 *
 *   2. Load the installed Poiesis config, mutate ONLY the requested
 *      class field, and serialize the proposed candidate to a private
 *      temp file under the system temp directory.
 *
 *   3. Hand the candidate file to `updateFromConfig` and return its
 *      result plus the restart notice. Every transaction invariant
 *      (receipt auth, no-op detection, doctor gate, fail-closed
 *      rollback) stays the single source of truth — `setModel` adds
 *      NO second config writer.
 *
 * The temp file is unlinked in a `finally` so a foreign-writer race
 * or doctor-gate failure cannot leak the proposed candidate onto the
 * repository filesystem after the transaction settles.
 */
export async function setModel(
  root: string,
  className: ModelClassName,
  modelId: string,
): Promise<SetModelResult> {
  if (className !== "reasoning" && className !== "execution") {
    throw new PoiesisError("INVALID_MODEL_CLASS", `Unknown model class: ${className}`, { className });
  }
  if (typeof modelId !== "string" || !MODEL_ID_FORMAT.test(modelId)) {
    throw new PoiesisError(
      "INVALID_MODEL_ID",
      "Model ID must use provider/model format",
      { modelId },
    );
  }

  // Spec #104 / ticket #106: pre-mutation runtime identity guard.
  // `model set` is not an upgrade channel; the guard fails closed with
  // `RUNTIME_VERSION_MISMATCH` before the OpenCode inventory probe
  // (which itself can be expensive / slow / unavailable).
  await assertRuntimeVersionMatchesProject(resolve(root));

  // Inventory probe runs BEFORE any write. Reuses the same parser
  // `verifyModels` and `update --config` already use, so the
  // trim/blank/dedupe semantics stay consistent. The error shape
  // mirrors `verifyModels` so downstream tooling can reuse the same
  // matcher.
  const inventory = await run("opencode", ["models"], { cwd: root, allowFailure: true });
  if (inventory.exitCode !== 0) {
    throw new PoiesisError("MODEL_INVENTORY_UNAVAILABLE", "OpenCode model inventory is unavailable", {
      stderr: inventory.stderr,
    });
  }
  const available = parseOpenCodeModelInventory(inventory.stdout);
  if (!available.has(modelId)) {
    throw new PoiesisError("MODEL_UNAVAILABLE", "Configured OpenCode model is unavailable", {
      missing: [modelId],
    });
  }

  // Load the installed config, mutate ONLY the requested class, and
  // route the proposed candidate through `updateFromConfig`. The
  // wrapper MUST NOT add a second config writer — every other
  // transaction invariant is reused.
  const current = await loadConfig(root);
  const proposed: PoiesisConfig = {
    ...current,
    models: { ...current.models, [className]: modelId },
  };

  const tempDir = await mkdtemp(join(tmpdir(), "poiesis-model-set-"));
  const candidatePath = join(tempDir, "candidate-config.jsonc");
  try {
    await atomicWrite(candidatePath, serializeConfig(proposed));
    const result = await updateFromConfig(root, candidatePath);
    return {
      manifest: result.manifest,
      doctor: result.doctor,
      restart: {
        notice: "Restart OpenCode to apply the new model configuration. Poiesis did not restart OpenCode.",
        started: false,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function uninstall(root: string): Promise<UninstallResult> {
  const resolvedRoot = resolve(root);
  // Spec #104 / ticket #106: pre-mutation runtime identity guard.
  // Fails closed with `RUNTIME_VERSION_MISMATCH` before any other
  // authority / receipt / config / marker check runs.
  await assertRuntimeVersionMatchesProject(resolvedRoot);
  const manifest = await loadManifest(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  await assertManifestAuthority(resolvedRoot, manifest, config);
  const receipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  const result: UninstallResult = {
    complete: false,
    manifestRemoved: false,
    removed: [],
    revertedConfigPatches: 0,
    preserved: [],
  };

  const known = knownPoiesisPaths(manifest);
  for (const path of await listTree(resolvedRoot, poiesisPath(resolvedRoot))) {
    if (!known.has(path)) result.preserved.push({ path, reason: "unknown content under .poiesis" });
  }

  const wholeFileOwned = new Set<string>();
  for (const file of manifest.files) {
    try {
      await requireOwnedManagedFile(resolvedRoot, file);
      wholeFileOwned.add(file.path);
    } catch {
      // Missing files are already uninstalled; changed files are handled below.
    }
  }

  const configResult = await reverseMatchingConfigPatches(resolvedRoot, manifest.configPatches);
  result.revertedConfigPatches = configResult.reverted.length;
  for (const patch of configResult.preserved) {
    result.preserved.push({ path: `${patch.file}:${patch.path.join(".")}`, reason: "config value changed or missing" });
  }

  const configPatchFiles = new Set(manifest.configPatches.map((patch) => patch.file));
  const releasedDurable = new Set<string>();
  for (const file of manifest.files) {
    const path = ownedPath(resolvedRoot, file.path);
    if (!(await exists(path))) {
      result.removed.push(file.path);
      continue;
    }
    if (file.durable === true) {
      releasedDurable.add(file.path);
      continue;
    }
    if (configPatchFiles.has(file.path)) {
      const filePatches = manifest.configPatches.filter((patch) => patch.file === file.path);
      const allReverted = filePatches.every((patch) => configResult.reverted.includes(patch));
      if (wholeFileOwned.has(file.path) && allReverted) {
        await unlink(path);
        result.removed.push(file.path);
      } else {
        result.preserved.push({ path: file.path, reason: "generated config file changed or contains unreverted patches" });
      }
      continue;
    }
    if (!(await isRegularManagedFile(resolvedRoot, path))) {
      result.preserved.push({ path: file.path, reason: "managed path is not a regular file" });
      continue;
    }
    const actual = await hashFile(path);
    if (actual !== file.hash) {
      result.preserved.push({ path: file.path, reason: "managed file hash changed" });
      continue;
    }
    await unlink(path);
    result.removed.push(file.path);
  }

  const skillResult = await removeOwnedSkills(resolvedRoot, manifest.skills);
  result.removed.push(...skillResult.removed);
  result.preserved.push(...skillResult.preserved);

  if (result.preserved.length === 0) {
    const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
    const remaining = (await listTree(resolvedRoot, poiesisPath(resolvedRoot))).filter(
      (path) => path !== relative(resolvedRoot, manifestPath),
    );
    for (const path of remaining) {
      const details = await lstat(join(resolvedRoot, path));
      if (releasedDurable.has(path)) continue;
      if (!known.has(path) || !details.isDirectory()) {
        result.preserved.push({ path, reason: "content appeared during uninstall" });
      }
    }
  }

  if (result.preserved.length === 0) {
    const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
    if (await exists(manifestPath)) await unlink(manifestPath);
    result.removed.push(relative(resolvedRoot, manifestPath));
    result.manifestRemoved = true;
    for (const directory of [poiesisPath(resolvedRoot, "roles"), poiesisPath(resolvedRoot)]) {
      try {
        await rmdir(directory);
      } catch {
        // Only empty Poiesis directories are removable; parent/foreign directories survive.
      }
    }
    result.complete = true;
    await removeOwnershipReceipt(resolvedRoot);
  } else {
    const removed = new Set(result.removed);
    const changedConfigFiles = new Set(configResult.reverted.map((patch) => patch.file));
    const retained: Manifest = {
      ...manifest,
      files: manifest.files.filter(
        (file) => !removed.has(file.path) && !changedConfigFiles.has(file.path) && !releasedDurable.has(file.path),
      ),
      skills: manifest.skills.filter((skill) => !removed.has(skill.path)),
      configPatches: configResult.preserved,
    };
    await atomicWrite(poiesisPath(resolvedRoot, "manifest.json"), serializeManifest(retained));
    await replaceOwnershipReceipt(resolvedRoot, retained, receipt);
  }
  return result;
}

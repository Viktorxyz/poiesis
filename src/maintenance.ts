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
import { hashContent, hashDirectory, hashFile } from "./hash.js";
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
  restoreOwnershipReceipt,
  type OwnershipReceipt,
} from "./receipt.js";
import {
  loadManifest,
  serializeManifest,
  type ConfigPatch,
  type ManagedFile,
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
import { packageRoot, poiesisPath } from "./paths.js";
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

function assertResolvedConfig(config: PoiesisConfig): void {
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

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false;
  const parts = path.split(/[\\/]/);
  return !parts.includes("") && !parts.includes(".") && !parts.includes("..");
}

function ownedPath(root: string, path: string): string {
  if (!isSafeRelativePath(path)) {
    throw new PoiesisError("UNSAFE_MANAGED_PATH", "Manifest contains an unsafe managed path", { path });
  }
  const destination = resolve(root, path);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new PoiesisError("UNSAFE_MANAGED_PATH", "Managed path escapes the repository", { path });
  }
  return destination;
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

async function isRegularManagedFile(root: string, path: string): Promise<boolean> {
  await assertSafeParents(root, path);
  return isRegularFile(path);
}

async function packageVersion(): Promise<string> {
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

async function autoResolveConfigDefaults(
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
  if (trackerProvider === "github" && trackerProject.trim().length === 0 && remote !== undefined) {
    const remotes = await run("git", ["remote", "get-url", "--all", remote], { cwd: root });
    const url = remotes.stdout.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    if (url !== undefined) {
      const parsed = parseGitHubProject(url);
      if (parsed !== null) {
        trackerProject = parsed;
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

function parseGitHubProject(url: string): string | null {
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

async function verifyGitRepository(root: string, config?: ResolvedPoiesisConfig): Promise<void> {
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

async function verifyModels(root: string, config: ResolvedPoiesisConfig): Promise<void> {
  const result = await run("opencode", ["models"], { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) {
    throw new PoiesisError("MODEL_INVENTORY_UNAVAILABLE", "OpenCode model inventory is unavailable", {
      stderr: result.stderr,
    });
  }
  const available = new Set(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
  const missing = [config.models.reasoning, config.models.execution].filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new PoiesisError("MODEL_UNAVAILABLE", "Configured OpenCode model is unavailable", { missing });
  }
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

async function validateOpenCodeConfigPayload(content: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "poiesis-opencode-config-check-"));
  try {
    await atomicCreate(join(directory, "opencode.jsonc"), content);
    await validateOpenCodeConfig(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyTracker(root: string, config: ResolvedPoiesisConfig): Promise<"verified" | "fixture"> {
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

function verifyDeliveryConfiguration(root: string, config: ResolvedPoiesisConfig): "verified" | "fixture" {
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
  const openCodeConfigPresent = await assertOpenCodeConfigAvailable(
    resolvedRoot,
    openCodeConfigPath,
    resolvedConfig,
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
      managedSkills = await installDefaultSkills(resolvedRoot, [], {
        expectedPreexisting: initialSkills!,
        createdDirectories: createdInitDirectories,
      });
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
    configPatches = await applyOpenCodeConfig(resolvedRoot, resolvedConfigWithDefaults, openCodeConfigPath, {
      requireAvailable: true,
      expectedContent: initialOpenCodeConfigSnapshot,
      onWritten: (content) => {
        writtenOpenCodeConfigContent = content;
        writtenOpenCodeConfigHash = hashContent(content);
      },
    });
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
    await createOwnershipReceipt(resolvedRoot, manifest);
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
    return manifest;
  } catch (error) {
    const rollbackFailures: Array<Record<string, unknown>> = [];
    const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
    await rollbackStep(rollbackFailures, "ownership receipt", async () => {
      await removeOwnershipReceipt(resolvedRoot);
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
    rollbackFailures.push(...await rollbackInit(
      resolvedRoot,
      managedFiles,
      managedSkills,
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

async function assertConfigPatchesOwned(root: string, patches: ConfigPatch[]): Promise<void> {
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
      const desired = desiredOpenCodePatches(config);
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

async function validateLegacySkillIdentity(root: string, skill: Manifest["skills"][number]): Promise<string> {
  const destination = ownedPath(root, skill.path);
  if (skill.preexisting) return hashOwnedSkillDirectory(destination);
  if (skill.hash === undefined) {
    throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Owned legacy skill is missing a hash", { path: skill.path });
  }
  const legacyHash = await hashDirectory(destination);
  if (legacyHash !== skill.hash) {
    throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Owned legacy skill content does not match the 1.0.0 manifest", {
      path: skill.path,
      expected: skill.hash,
      actual: legacyHash,
    });
  }
  return hashOwnedSkillDirectory(destination);
}

async function validateLegacyInstallation(root: string, manifest: Manifest, config: ResolvedPoiesisConfig): Promise<void> {
  if (manifest.poiesisVersion !== "1.0.0") {
    throw new PoiesisError("LEGACY_BOOTSTRAP_UNSUPPORTED", "Legacy bootstrap only accepts public Poiesis 1.0.0 installations", {
      poiesisVersion: manifest.poiesisVersion,
    });
  }
  // Tolerant authority check: the public 1.0.0 predecessor retained the
  // obsolete `task: { explore: "allow" }` field on `poiesis-reviewer.permission`
  // which the strict current projection no longer emits. The bootstrap path
  // only accepts exact v1.0.0 predecessor projections; any drift still fails closed.
  await assertManifestAuthorityToleratingPredecessor(root, manifest, config, ["1.0.0"]);
  for (const file of manifest.files) {
    const path = ownedPath(root, file.path);
    if (!(await exists(path)) || !(await isRegularManagedFile(root, path))) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy managed file is missing or not a regular file", {
        path: file.path,
      });
    }
    const actual = await hashFile(path);
    if (actual !== file.hash) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy managed file does not match the 1.0.0 manifest", {
        path: file.path,
        expected: file.hash,
        actual,
      });
    }
  }
  const defaults = await loadDefaultSkills();
  const defaultNames = new Set(defaults.map((skill) => skill.name));
  for (const skill of manifest.skills) {
    if (!defaultNames.has(skill.name) && !skill.preexisting) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy manifest claims an unknown owned skill", {
        name: skill.name,
      });
    }
    await validateLegacySkillIdentity(root, skill);
  }
}

async function bootstrapLegacyOwnership(root: string, options: MaintenanceOptions): Promise<UpdateResult> {
  const resolvedRoot = resolve(root);
  if (await ownershipReceiptExists(resolvedRoot)) {
    throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Refusing to bootstrap over an existing ownership receipt");
  }
  const manifest = await loadManifest(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  await validateLegacyInstallation(resolvedRoot, manifest, config);
  await verifyGitRepository(resolvedRoot, config);
  await verifyOpenCodeVersion(resolvedRoot);

  const nextSkills = await Promise.all(
    manifest.skills.map(async (skill) => ({
      ...skill,
      hash: await validateLegacySkillIdentity(resolvedRoot, skill),
    })),
  );
  const materialized = await materializeFiles(config);
  const fileSnapshots = new Map<string, Buffer>();
  for (const file of materialized) {
    const path = join(resolvedRoot, file.path);
    if (await exists(path)) fileSnapshots.set(file.path, await readFile(path));
  }
  const openCodeConfig = manifest.configPatches[0]?.file;
  if (openCodeConfig === undefined) {
    throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy manifest does not identify an OpenCode config");
  }
  const openCodeConfigPath = join(resolvedRoot, openCodeConfig);
  const openCodeConfigSnapshot = await snapshotFileIfOwned(openCodeConfigPath, resolvedRoot, manifest.files);
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const manifestBackup = await snapshotFile(manifestPath);
  // Snapshot the exact preimage of `.gitignore` BEFORE the transaction so
  // a failure can restore it byte-for-byte. The transactional default-path
  // gitignore rule is appended inside the try block; this seam exists for
  // explicit 1.0.0 bootstrap because the predecessor init did not install
  // the new rule.
  const gitignoreSnapshot = await snapshotFile(join(resolvedRoot, ".gitignore"));
  let writtenGitignoreHash: string | undefined;
  try {
    const skills = options.skipSkills
      ? nextSkills
      : await installDefaultSkills(resolvedRoot, nextSkills, { replaceOwned: true });
    for (const file of materialized) await atomicWrite(join(resolvedRoot, file.path), file.content);
    // Transactionally append the default-path `.gitignore` rule. The
    // preimage snapshot above lets the rollback restore the exact bytes
    // if any later step fails.
    ({ writtenHash: writtenGitignoreHash } = await ensureDefaultPathGitignore(resolvedRoot, gitignoreSnapshot));
    const nextFiles = nextAdapterFiles(
      manifest,
      materialized.map((file) => ({
        path: file.path,
        kind: file.kind,
        hash: hashContent(file.content),
        durable: templateMappings.find((mapping) => mapping.destination === file.path)?.trackInProject === true,
      })),
    );
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, config, openCodeConfigPath);
    const configPatches = nextAdapterPatches(manifest, appliedPatches);
    if (openCodeConfigSnapshot !== null) {
      const nextRecord = nextFiles.findIndex((file) => file.path === openCodeConfig);
      if (nextRecord >= 0) nextFiles[nextRecord] = { ...nextFiles[nextRecord]!, hash: await hashFile(openCodeConfigPath) };
    }
    const next: Manifest = {
      schema: 1,
      poiesisVersion: await packageVersion(),
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
      files: nextFiles,
      skills,
      configPatches,
    };
    await atomicWrite(manifestPath, serializeManifest(next));
    await createOwnershipReceipt(resolvedRoot, next);
    const report = await doctor(resolvedRoot);
    if (!options.skipSkills && !report.ok) {
      throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Legacy ownership bootstrap did not pass doctor", { report });
    }
    return { manifest: next, doctor: report };
  } catch (error) {
    await restoreManifest(manifestPath, manifestBackup);
    await removeOwnershipReceipt(resolvedRoot);
    await restoreOpenCodeConfig(openCodeConfigPath, openCodeConfigSnapshot);
    await restoreMaterializedFiles(resolvedRoot, materialized, fileSnapshots);
    await rollbackDefaultPathGitignore(join(resolvedRoot, ".gitignore"), gitignoreSnapshot, writtenGitignoreHash);
    throw error;
  }
}

export async function update(root: string, options: MaintenanceOptions = {}): Promise<UpdateResult> {
  if (options.bootstrapLegacyOwnership) return bootstrapLegacyOwnership(root, options);
  const resolvedRoot = resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  // Receipt-first: authenticate the receipt against the on-disk manifest
  // BEFORE any authority check consumes manifest records. This binds the
  // trusted manifest digest and gates the migration tolerance on a known
  // predecessor provenance. A 1.0.0 manifest WITHOUT a receipt must use the
  // explicit --bootstrap-legacy-ownership path, not normal update.
  const receipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  // Tolerant authority check: accepts the strict current projection OR the
  // exact v1.0.1/1.0.2 predecessor projection (which retained the obsolete
  // `task: { explore: "allow" }` field on `poiesis-reviewer.permission` that
  // ticket #24 removed). 1.0.0 is intentionally excluded here: bootstrap is
  // the only legal migration for the public predecessor.
  await assertManifestAuthorityToleratingPredecessor(resolvedRoot, manifest, config, ["1.0.1", "1.0.2"]);
  await verifyGitRepository(resolvedRoot, config);
  await verifyOpenCodeVersion(resolvedRoot);

  const materialized = await materializeFiles(config);
  const records = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of materialized) {
    const record = records.get(file.path);
    if (record === undefined || record.kind !== file.kind) {
      throw new PoiesisError("FILE_OWNERSHIP_UNKNOWN", "Current manifest does not prove ownership of an update destination", {
        path: file.path,
      });
    }
    await requireOwnedManagedFile(resolvedRoot, record);
  }
  await assertConfigPatchesOwned(resolvedRoot, manifest.configPatches);

  const managedConfigFiles = [...new Set(manifest.configPatches.map((patch) => patch.file))];
  if (managedConfigFiles.length !== 1) {
    throw new PoiesisError("CONFIG_OWNERSHIP_INVALID", "Manifest must identify exactly one managed OpenCode config", {
      files: managedConfigFiles,
    });
  }
  const openCodeConfig = managedConfigFiles[0]!;
  const openCodeConfigPath = join(resolvedRoot, openCodeConfig);
  const openCodeConfigSnapshot = await snapshotFileIfOwned(openCodeConfigPath, resolvedRoot, manifest.files);
  const fileSnapshots = new Map<string, Buffer>();
  for (const file of materialized) {
    const path = join(resolvedRoot, file.path);
    if (await exists(path)) fileSnapshots.set(file.path, await readFile(path));
  }

  let manifestPath: string | undefined;
  let manifestBackup: Buffer | null = null;
  let nextReceipt: OwnershipReceipt | undefined;
  let skills = manifest.skills;
  // Snapshot the exact preimage of `.gitignore` BEFORE the transaction so
  // a failure can restore it byte-for-byte. The transactional default-path
  // gitignore rule is appended inside the try block; updateFromConfig is
  // intentionally unchanged and does not mutate `.gitignore`.
  const gitignoreSnapshot = await snapshotFile(join(resolvedRoot, ".gitignore"));
  let writtenGitignoreHash: string | undefined;
  try {
    skills = options.skipSkills
      ? manifest.skills
      : await installDefaultSkills(resolvedRoot, manifest.skills, { replaceOwned: true });
    for (const file of materialized) {
      await atomicWrite(join(resolvedRoot, file.path), file.content);
    }
    // Transactionally append the default-path `.gitignore` rule (and
    // nothing else). `ensureGitignore` is idempotent on existing lines
    // so a project that already has the rule is a no-op; the preimage
    // snapshot above records the exact bytes in either case so a failure
    // can restore them.
    ({ writtenHash: writtenGitignoreHash } = await ensureDefaultPathGitignore(resolvedRoot, gitignoreSnapshot));
    const nextFiles = nextAdapterFiles(
      manifest,
      materialized.map((file) => ({
        path: file.path,
        kind: file.kind,
        hash: hashContent(file.content),
        durable: templateMappings.find((mapping) => mapping.destination === file.path)?.trackInProject === true,
      })),
    );
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, config, openCodeConfigPath);
    const configPatches = nextAdapterPatches(manifest, appliedPatches);
    if (openCodeConfigSnapshot !== null) {
      const nextRecord = nextFiles.findIndex((file) => file.path === openCodeConfig);
      if (nextRecord >= 0) {
        nextFiles[nextRecord] = {
          ...nextFiles[nextRecord]!,
          hash: await hashFile(openCodeConfigPath),
        };
      }
    }
    const next: Manifest = {
      schema: 1,
      poiesisVersion: await packageVersion(),
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
      files: nextFiles,
      skills,
      configPatches,
    };
    manifestPath = poiesisPath(resolvedRoot, "manifest.json");
    manifestBackup = await snapshotFile(manifestPath);
    await atomicWrite(manifestPath, serializeManifest(next));
    nextReceipt = await replaceOwnershipReceipt(resolvedRoot, next, receipt);
    const report = await doctor(resolvedRoot);
    if (!options.skipSkills && !report.ok) {
      throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Poiesis update did not pass doctor", { report });
    }
    return { manifest: next, doctor: report };
  } catch (error) {
    if (manifestPath !== undefined) await restoreManifest(manifestPath, manifestBackup);
    await restoreOwnershipReceipt(resolvedRoot, receipt);
    await restoreOpenCodeConfig(openCodeConfigPath, openCodeConfigSnapshot);
    await restoreMaterializedFiles(resolvedRoot, materialized, fileSnapshots);
    await rollbackDefaultPathGitignore(join(resolvedRoot, ".gitignore"), gitignoreSnapshot, writtenGitignoreHash);
    throw error;
  }
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

async function restoreOpenCodeConfig(path: string, snapshot: Buffer | null): Promise<void> {
  if (snapshot === null) return;
  await atomicWrite(path, snapshot.toString("utf8").endsWith("\n") ? snapshot.toString("utf8") : `${snapshot.toString("utf8")}\n`);
}

async function restoreManifest(path: string, snapshot: Buffer | null): Promise<void> {
  if (snapshot === null) await rm(path, { force: true });
  else await atomicWrite(path, snapshot.toString("utf8").endsWith("\n") ? snapshot.toString("utf8") : `${snapshot.toString("utf8")}\n`);
}

async function restoreMaterializedFiles(
  root: string,
  materialized: MaterializedFile[],
  snapshots: Map<string, Buffer>,
): Promise<void> {
  for (const file of [...materialized].reverse()) {
    const path = join(root, file.path);
    const snapshot = snapshots.get(file.path);
    if (snapshot === undefined) {
      if (await exists(path)) await rm(path, { force: true });
    } else {
      const content = snapshot.toString("utf8");
      await atomicWrite(path, content.endsWith("\n") ? content : `${content}\n`);
    }
  }
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

export async function installAuthorizedCapability(root: string, input: CapabilityInstallInput) {
  const resolvedRoot = resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  await assertManifestAuthority(resolvedRoot, manifest, config);
  const receipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const manifestBackup = await snapshotFile(manifestPath);
  try {
    const installed = await installCapability(resolvedRoot, input);
    const next = await loadManifest(resolvedRoot);
    await replaceOwnershipReceipt(resolvedRoot, next, receipt);
    return installed;
  } catch (error) {
    await restoreManifest(manifestPath, manifestBackup);
    await restoreOwnershipReceipt(resolvedRoot, receipt);
    throw error;
  }
}

const POIESIS_CONFIG_RELATIVE_PATH = ".poiesis/config.jsonc";

/**
 * Test-only deterministic fault-injection hooks used by `updateFromConfig`. Each
 * callback fires immediately BEFORE the corresponding write step in the
 * transaction. Throwing simulates an I/O fault and exercises the rollback path.
 *
 * These hooks live behind the public options surface purely so tests can drive
 * deterministic failures without monkey-patching internal modules. Production
 * callers (CLI, library users) must leave them unset. The hooks do not change
 * production behavior when omitted: `updateFromConfig` short-circuits each
 * `?.()` call and writes via the real `atomicWrite` / `applyOpenCodeConfig` /
 * `replaceOwnershipReceipt` paths.
 */
export interface UpdateWriterHooks {
  /** Called immediately before atomic-writing the new `.poiesis/config.jsonc`. */
  prePoiesisConfigWrite?: () => void | Promise<void>;
  /** Called immediately before applying the OpenCode projection to the managed config. */
  preOpenCodeApply?: () => void | Promise<void>;
  /** Called immediately before atomic-writing the new `.poiesis/manifest.json`. */
  preManifestWrite?: () => void | Promise<void>;
  /** Called immediately before `replaceOwnershipReceipt` advances generation. */
  preReceiptReplace?: () => void | Promise<void>;
  /**
   * Called immediately AFTER `replaceOwnershipReceipt` returns and BEFORE
   * the doctor gate runs. This seam exists for fail-closed rollback tests
   * that need to inject foreign manifest or receipt bytes between the
   * transaction's last write and the doctor gate, so the rollback path
   * can prove it leaves foreign content intact.
   */
  postReceiptReplace?: () => void | Promise<void>;
  /**
   * Called immediately AFTER the atomic write of the new
   * `.poiesis/manifest.json` completes and BEFORE the transaction
   * observes the manifest (receipt replace, doctor gate, ownership
   * hashFile). This seam exists for fail-closed rollback tests that need
   * to inject a foreign replacement in the narrow window between our
   * write and any subsequent observation, so the rollback path can
   * prove it preserves the foreign bytes instead of rewinding the
   * manifest to our preimage.
   */
  postManifestWrite?: () => void | Promise<void>;
}

function assertCompatibleUpdateConfigOptions(options: UpdateConfigOptions): void {
  const incompatible: Array<string> = [];
  if (options.bootstrapLegacyOwnership === true) incompatible.push("bootstrapLegacyOwnership");
  if (options.skipSkills === true) incompatible.push("skipSkills");
  if (options.allowFixtureAdapters === true) incompatible.push("allowFixtureAdapters");
  if (incompatible.length > 0) {
    throw new PoiesisError("INCOMPATIBLE_UPDATE_OPTIONS", "update --config cannot combine with other update options", {
      incompatible,
    });
  }
}

/**
 * Options accepted by `updateFromConfig`. The `bootstrapLegacyOwnership`,
 * `skipSkills`, and `allowFixtureAdapters` keys are FORBIDDEN because
 * `poiesis update --config <path>` is a narrowly scoped transaction that does
 * not bootstrap legacy ownership, skip skills, or accept fixture adapters;
 * setting any of these to `true` throws `INCOMPATIBLE_UPDATE_OPTIONS` before
 * any side effect.
 *
 * The optional `writerHooks` field is reserved for deterministic test
 * fault injection and must remain unset in production.
 */
export interface UpdateConfigOptions {
  bootstrapLegacyOwnership?: boolean;
  skipSkills?: boolean;
  allowFixtureAdapters?: boolean;
  writerHooks?: UpdateWriterHooks;
}

async function assertPoiesisConfigOwnership(root: string, manifest: Manifest): Promise<{ content: Buffer; record: ManagedFile }> {
  const record = manifest.files.find((file) => file.path === POIESIS_CONFIG_RELATIVE_PATH);
  if (record === undefined) {
    throw new PoiesisError("FILE_OWNERSHIP_UNKNOWN", "Manifest does not prove ownership of the Poiesis config", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
    });
  }
  if (record.kind !== "generated") {
    throw new PoiesisError("FILE_OWNERSHIP_INVALID", "Manifest Poiesis config record must be generated", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
      kind: record.kind,
    });
  }
  const path = join(root, POIESIS_CONFIG_RELATIVE_PATH);
  if (!(await exists(path)) || !(await isRegularManagedFile(root, path))) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Poiesis config is missing or not a regular file", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
    });
  }
  const content = await readFile(path);
  if (hashContent(content) !== record.hash) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Poiesis config has been modified since the last receipt", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
      expected: record.hash,
      actual: hashContent(content),
    });
  }
  return { content, record };
}

async function identifyManagedOpenCodeConfig(manifest: Manifest): Promise<string> {
  const files = [...new Set(manifest.configPatches.map((patch) => patch.file))];
  if (files.length !== 1) {
    throw new PoiesisError("CONFIG_OWNERSHIP_INVALID", "Manifest must identify exactly one managed OpenCode config", {
      files,
    });
  }
  return files[0]!;
}

export async function updateFromConfig(
  root: string,
  configPath: string,
  options: UpdateConfigOptions = {},
): Promise<UpdateResult> {
  assertCompatibleUpdateConfigOptions(options);
  const resolvedRoot = resolve(root);
  const resolvedConfigPath = resolve(configPath);
  const writerHooks = options.writerHooks;

  // 1. Strictly parse, validate, and resolve the proposed config BEFORE any side effect.
  const proposedConfigRaw = await readUtf8(resolvedConfigPath);
  const proposedConfig = validateConfig(parseJsonc<unknown>(proposedConfigRaw, resolvedConfigPath), resolvedConfigPath);
  assertResolvedConfig(proposedConfig);

  // 1b. Pre-validate each delivery adapter so an unsupported adapter name fails
  //     fast with `UNKNOWN_DELIVERY_ADAPTER` before any receipt or write work.
  for (const target of ["preview", "staging", "production"] as const) {
    createDeliveryAdapter(proposedConfig.delivery[target], resolvedRoot);
  }

  // 2. Authenticate the trusted receipt FIRST, before any other ownership check
  //    consumes manifest records. This locks in the receipt's claim about the
  //    trusted manifest digest; subsequent authority and Poiesis-config checks
  //    operate against that trusted snapshot.
  const manifest = await loadManifest(resolvedRoot);
  const receipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  const currentConfig = await loadConfig(resolvedRoot);
  // Strict authority check: `update --config` is a narrowly scoped
  // transaction that does NOT recognize the v1.0.0/v1.0.1/v1.0.2 predecessor
  // projection. Predecessor tolerance is intentionally confined to receipt-
  // authenticated normal `update()` and explicit 1.0.0 bootstrap. A receipt-
  // bound predecessor manifest that reaches this path fails closed with
  // MANIFEST_AUTHORITY_INVALID before any write.
  await assertManifestAuthority(resolvedRoot, manifest, currentConfig);
  const { content: currentConfigBytes, record: currentConfigRecord } = await assertPoiesisConfigOwnership(resolvedRoot, manifest);
  await verifyGitRepository(resolvedRoot);
  await verifyOpenCodeVersion(resolvedRoot);
  const openCodeRelativePath = await identifyManagedOpenCodeConfig(manifest);
  const openCodeConfigPath = join(resolvedRoot, openCodeRelativePath);
  if (!(await exists(openCodeConfigPath)) || !(await isRegularManagedFile(resolvedRoot, openCodeConfigPath))) {
    throw new PoiesisError("CONFIG_OWNERSHIP_LOST", "Managed OpenCode config is missing or not a regular file", {
      file: openCodeRelativePath,
    });
  }
  // Verify each recorded patch is owned by checking its installed value on disk BEFORE writing.
  // `assertConfigPatchesOwned` also detects foreign tampering of the OpenCode config (unsafe/foreign
  // collisions are caught via `CONFIG_OWNERSHIP_LOST`).
  await assertConfigPatchesOwned(resolvedRoot, manifest.configPatches);

  // 3. Auto-discover default fields on the proposed config (without writing) so we can resolve fully.
  await autoResolveConfigDefaults(resolvedRoot, proposedConfig);

  // 4. Compute the new content + patch projection in memory for the no-op check.
  const newConfigContent = serializeConfig(proposedConfig);
  const newConfigHash = hashContent(newConfigContent);
  const openCodeConfigCurrentBytes = await readFile(openCodeConfigPath);
  const currentOpenCodeContentString = openCodeConfigCurrentBytes.toString("utf8");
  const currentOpenCodeContentHash = hashContent(openCodeConfigCurrentBytes);
  const currentOpenCodeJson = parseJsonc<JsonObject>(currentOpenCodeContentString, openCodeConfigPath);
  const openCodeManifestRecord = manifest.files.find((file) => file.path === openCodeRelativePath);

  // 5. No-op detection: comparing BYTE hashes of every state the transaction
  //    would touch is sufficient — when the Poiesis config bytes AND the OpenCode
  //    config bytes match their recorded manifest hashes, the proposed transaction
  //    cannot observably change anything. Do NOT advance generation; return the
  //    existing manifest unchanged.
  const poiesisConfigBytesMatch = newConfigHash === currentConfigRecord.hash;
  const openCodeBytesMatch =
    openCodeManifestRecord === undefined
      ? false
      : currentOpenCodeContentHash === openCodeManifestRecord.hash;
  if (poiesisConfigBytesMatch && openCodeBytesMatch) {
    const report = await doctor(resolvedRoot);
    return { manifest, doctor: report };
  }

  // 6. Snapshot everything we are about to mutate.
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const manifestBackup = await readFile(manifestPath);
  let openCodeWrittenHash: string | undefined;
  let poiesisConfigWrittenHash: string | undefined;
  let manifestWrittenHash: string | undefined;
  let nextReceipt: OwnershipReceipt | undefined;

  try {
    // 7. Write the new Poiesis config atomically.
    await writerHooks?.prePoiesisConfigWrite?.();
    await atomicWrite(join(resolvedRoot, POIESIS_CONFIG_RELATIVE_PATH), newConfigContent);
    poiesisConfigWrittenHash = await hashFile(join(resolvedRoot, POIESIS_CONFIG_RELATIVE_PATH));
    if (poiesisConfigWrittenHash !== newConfigHash) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "Poiesis config changed after write", {
        path: POIESIS_CONFIG_RELATIVE_PATH,
        expected: newConfigHash,
        actual: poiesisConfigWrittenHash,
      });
    }

    // 8. Apply the new OpenCode projection. We pass `requireAvailable: false` because
    //    (a) every recorded patch is already asserted owned above via
    //    `assertConfigPatchesOwned`, and (b) the desired patches only ever ADD or
    //    REPLACE values that the manifest already proves we own. Passing
    //    `requireAvailable: true` would re-run the reservation check used by
    //    `init()` and incorrectly refuse the update whenever the OpenCode config
    //    already contains a desired path. Concurrent writers between our
    //    snapshot and the atomic write are caught via the
    //    `expectedContent` snapshot that `applyOpenCodeConfig` enforces.
    await writerHooks?.preOpenCodeApply?.();
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, proposedConfig, openCodeConfigPath, {
      expectedContent: openCodeConfigCurrentBytes,
      onWritten: (content) => {
        openCodeWrittenHash = hashContent(content);
      },
    });
    if (openCodeWrittenHash === undefined) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config write did not record a final hash", {
        file: openCodeRelativePath,
      });
    }
    const onDiskOpenCodeHash = await hashFile(openCodeConfigPath);
    if (onDiskOpenCodeHash !== openCodeWrittenHash) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config changed after write", {
        file: openCodeRelativePath,
      });
    }

    // 9. Merge the prior `previous` provenance into the freshly applied patches so user-supplied
    //    values are preserved across updates.
    const mergedPatches = nextAdapterPatches(manifest, appliedPatches);

    // 10. Build the next manifest. The hash for the .poiesis/config.jsonc file is recomputed; the OpenCode
    //     config hash is taken from the on-disk write; every other file keeps its prior hash.
    const nextManifest: Manifest = {
      schema: 1,
      poiesisVersion: await packageVersion(),
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
      files: manifest.files.map((file) => {
        if (file.path === POIESIS_CONFIG_RELATIVE_PATH) {
          return { path: POIESIS_CONFIG_RELATIVE_PATH, kind: "generated", hash: newConfigHash, owned: true };
        }
        if (file.path === openCodeRelativePath) {
          return { ...file, hash: openCodeWrittenHash! };
        }
        return file;
      }),
      skills: manifest.skills,
      configPatches: mergedPatches,
    };
    await writerHooks?.preManifestWrite?.();
    // Serialize nextManifest exactly once; derive the post-write identity
    // from those exact bytes BEFORE write, and write those same bytes. A
    // foreign replacement in the write window cannot be adopted as our
    // identity, and the post-write `hashFile` re-read is removed.
    const nextManifestBytes = serializeManifest(nextManifest);
    const nextManifestHash = hashContent(nextManifestBytes);
    await atomicWrite(manifestPath, nextManifestBytes);
    manifestWrittenHash = nextManifestHash;
    await writerHooks?.postManifestWrite?.();

    // 11. Replace the ownership receipt, advancing generation by exactly ONE and binding to the new manifest digest.
    await writerHooks?.preReceiptReplace?.();
    nextReceipt = await replaceOwnershipReceipt(resolvedRoot, nextManifest, receipt);
    await writerHooks?.postReceiptReplace?.();

    // 12. Doctor gate: pass or roll back everything. The transaction is config-only
    //     so skills health is unrelated to the change under transaction; ignore
    //     `skills` check failures that pre-date this transaction by inspecting
    //     whether the manifest had a `skills` array that fully populated defaults.
    const report = await doctor(resolvedRoot);
    const skipSkillsGate = manifest.skills.length === 0;
    const gateFailure = report.checks.find((check) => check.status === "fail" && !(skipSkillsGate && check.id === "skills"));
    if (gateFailure !== undefined) {
      throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Poiesis update --config did not pass doctor", { report });
    }
    return { manifest: nextManifest, doctor: report };
  } catch (error) {
    // 13. Exact rollback: restore each mutated artifact only if its post-write hash still matches what we wrote.
    if ((await exists(openCodeConfigPath)) && openCodeWrittenHash !== undefined && (await hashFile(openCodeConfigPath)) === openCodeWrittenHash) {
      const backup = openCodeConfigCurrentBytes.toString("utf8");
      const normalized = backup.endsWith("\n") ? backup : `${backup}\n`;
      await atomicWrite(openCodeConfigPath, normalized);
    }
    const poiesisConfigPath = join(resolvedRoot, POIESIS_CONFIG_RELATIVE_PATH);
    if ((await exists(poiesisConfigPath)) && poiesisConfigWrittenHash !== undefined && (await hashFile(poiesisConfigPath)) === poiesisConfigWrittenHash) {
      const normalized = currentConfigBytes.toString("utf8");
      const endsWithNewline = normalized.endsWith("\n");
      await atomicWrite(poiesisConfigPath, endsWithNewline ? normalized : `${normalized}\n`);
    }
    // Manifest fail-closed rollback: restore the preimage only if the on-disk
    // manifest still matches the post-write identity we recorded above. A
    // foreign writer between our write and the rollback leaves the manifest
    // untouched.
    if (manifestWrittenHash !== undefined && (await exists(manifestPath)) && (await hashFile(manifestPath)) === manifestWrittenHash) {
      const normalized = manifestBackup.toString("utf8");
      const endsWithNewline = normalized.endsWith("\n");
      await atomicWrite(manifestPath, endsWithNewline ? normalized : `${normalized}\n`);
    }
    // Receipt fail-closed rollback: restore the preimage only if the on-disk
    // receipt still matches the post-write identity we last observed (nextReceipt
    // if we wrote it, else the pre-transaction receipt). A foreign writer
    // between our write and the rollback leaves the receipt untouched.
    const expectedReceiptHash = hashContent(`${JSON.stringify(nextReceipt ?? receipt, null, 2)}\n`);
    const onDiskReceiptPath = await ownershipReceiptLocation(resolvedRoot);
    if ((await exists(onDiskReceiptPath)) && hashContent(await readFile(onDiskReceiptPath)) === expectedReceiptHash) {
      await restoreOwnershipReceipt(resolvedRoot, receipt);
    }
    throw error;
  }
}

export async function uninstall(root: string): Promise<UninstallResult> {
  const resolvedRoot = resolve(root);
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

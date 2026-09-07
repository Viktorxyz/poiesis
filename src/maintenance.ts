import { isDeepStrictEqual } from "node:util";
import { lstat, readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { loadConfig, parseJsonc, serializeConfig, validateConfig, type PoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import { atomicWrite, exists, readUtf8 } from "./fs.js";
import { hashContent, hashDirectory, hashFile } from "./hash.js";
import {
  loadManifest,
  serializeManifest,
  type ConfigPatch,
  type ManagedFile,
  type Manifest,
} from "./manifest.js";
import {
  applyOpenCodeConfig,
  desiredOpenCodePatches,
  detectOpenCodeConfig,
  OPENCODE_ADAPTER_VERSION,
  SUPPORTED_OPENCODE_VERSION,
  validateOpenCodeConfig,
  verifyOpenCodeVersion,
} from "./opencode.js";
import { packageRoot, poiesisPath } from "./paths.js";
import { run } from "./process.js";
import {
  hashOwnedSkillDirectory,
  installDefaultSkills,
  loadDefaultSkills,
  removeOwnedSkills,
  skillPath,
} from "./skills.js";
import { readTemplate, templateMappings } from "./templates.js";
import { createDeliveryAdapter } from "./adapters.js";

export interface MaintenanceOptions {
  skipSkills?: boolean;
  allowFixtureAdapters?: boolean;
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

async function isRegularFile(path: string): Promise<boolean> {
  const details = await lstat(path);
  return details.isFile() && !details.isSymbolicLink();
}

async function assertSafeParents(root: string, destination: string): Promise<void> {
  const parts = relative(root, destination).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if ((await exists(current)) && (await lstat(current)).isSymbolicLink()) {
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

async function verifyGitRepository(root: string, config?: PoiesisConfig): Promise<void> {
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

async function verifyModels(root: string, config: PoiesisConfig): Promise<void> {
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

async function verifyTracker(root: string, config: PoiesisConfig): Promise<"verified" | "fixture"> {
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

function verifyDeliveryConfiguration(root: string, config: PoiesisConfig): "verified" | "fixture" {
  let fixture = false;
  for (const target of ["preview", "staging", "production"] as const) {
    const adapter = createDeliveryAdapter(config.delivery[target], root);
    if (adapter.kind === "fixture") fixture = true;
  }
  return fixture ? "fixture" : "verified";
}

async function assertInitDestinationsAbsent(root: string, files: MaterializedFile[]): Promise<void> {
  const poiesisDirectory = poiesisPath(root);
  if (await exists(poiesisDirectory)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Refusing to initialize over an unowned .poiesis path", {
      path: relative(root, poiesisDirectory),
    });
  }
  for (const file of files) {
    const destination = join(root, file.path);
    await assertSafeParents(root, destination);
    if (await exists(destination)) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "Refusing to overwrite a preexisting destination", {
        path: file.path,
      });
    }
  }
  const manifestPath = poiesisPath(root, "manifest.json");
  if (await exists(manifestPath)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "A Poiesis manifest already exists", {
      path: relative(root, manifestPath),
    });
  }
}

async function removeIfMatching(root: string, path: string, hash: string): Promise<boolean> {
  if (!(await exists(path)) || !(await isRegularManagedFile(root, path))) return false;
  if ((await hashFile(path)) !== hash) return false;
  await unlink(path);
  return true;
}

async function rollbackInit(
  root: string,
  files: ManagedFile[],
  skills: Manifest["skills"],
  patches: ConfigPatch[],
  openCodeConfigCreated: boolean,
): Promise<void> {
  try {
    const reversal = await reverseMatchingConfigPatches(root, patches);
    if (openCodeConfigCreated && reversal.preserved.length === 0) {
      const configPath = await detectOpenCodeConfig(root);
      if (await exists(configPath)) await unlink(configPath);
    }
  } catch {
    // A concurrent config change is foreign state and must survive a failed init.
  }
  await removeOwnedSkills(root, skills);
  for (const file of [...files].reverse()) {
    await removeIfMatching(root, ownedPath(root, file.path), file.hash);
  }
}

export async function init(root: string, config: PoiesisConfig, options: MaintenanceOptions = {}): Promise<Manifest> {
  const resolvedRoot = resolve(root);
  const resolvedConfig = validateConfig(config, "explicit init config");
  assertResolvedConfig(resolvedConfig);
  const files = await materializeFiles(resolvedConfig);
  await verifyGitRepository(resolvedRoot, resolvedConfig);
  await verifyOpenCodeVersion(resolvedRoot);
  await verifyModels(resolvedRoot, resolvedConfig);
  const trackerMode = await verifyTracker(resolvedRoot, resolvedConfig);
  const deliveryMode = verifyDeliveryConfiguration(resolvedRoot, resolvedConfig);
  if ((trackerMode === "fixture" || deliveryMode === "fixture") && !options.allowFixtureAdapters) {
    throw new PoiesisError(
      "FIXTURE_ADAPTER_NOT_AUTHORIZED",
      "Fixture adapters are test-only and require explicit allowFixtureAdapters authorization",
    );
  }
  await assertInitDestinationsAbsent(resolvedRoot, files);

  const openCodeConfigPath = await detectOpenCodeConfig(resolvedRoot);
  await assertSafeParents(resolvedRoot, openCodeConfigPath);
  if ((await exists(openCodeConfigPath)) && !(await isRegularFile(openCodeConfigPath))) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not a regular file", {
      path: relative(resolvedRoot, openCodeConfigPath),
    });
  }
  const openCodeConfigCreated = !(await exists(openCodeConfigPath));
  const managedFiles: ManagedFile[] = [];
  let managedSkills: Manifest["skills"] = [];
  let configPatches: ConfigPatch[] = [];
  let writtenManifestHash: string | undefined;

  try {
    if (!options.skipSkills) managedSkills = await installDefaultSkills(resolvedRoot);
    for (const file of files) {
      const destination = join(resolvedRoot, file.path);
      await atomicWrite(destination, file.content);
      managedFiles.push({ path: file.path, kind: file.kind, hash: hashContent(file.content), owned: true });
    }

    configPatches = await applyOpenCodeConfig(resolvedRoot, resolvedConfig);
    await validateOpenCodeConfig(resolvedRoot);
    if (openCodeConfigCreated) {
      managedFiles.push({
        path: relative(resolvedRoot, openCodeConfigPath),
        kind: "generated",
        hash: await hashFile(openCodeConfigPath),
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
      },
      files: managedFiles,
      skills: managedSkills,
      configPatches,
    };
    const manifestContent = serializeManifest(manifest);
    await atomicWrite(poiesisPath(resolvedRoot, "manifest.json"), manifestContent);
    writtenManifestHash = hashContent(manifestContent);
    if (!options.skipSkills) {
      const report = await doctor(resolvedRoot);
      if (!report.ok) {
        throw new PoiesisError("INIT_DOCTOR_FAILED", "Poiesis installation did not pass doctor", { report });
      }
    }
    return manifest;
  } catch (error) {
    const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
    if (
      writtenManifestHash !== undefined &&
      (await exists(manifestPath)) &&
      (await hashFile(manifestPath)) === writtenManifestHash
    ) {
      await unlink(manifestPath);
    }
    await rollbackInit(resolvedRoot, managedFiles, managedSkills, configPatches, openCodeConfigCreated);
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

function manifestConsistency(manifest: Manifest): string[] {
  const problems: string[] = [];
  const filePaths = new Set<string>();
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file.path)) problems.push(`unsafe file path: ${file.path}`);
    if (filePaths.has(file.path)) problems.push(`duplicate file path: ${file.path}`);
    filePaths.add(file.path);
  }
  const skillNames = new Set<string>();
  for (const skill of manifest.skills) {
    if (!isSafeRelativePath(skill.path)) problems.push(`unsafe skill path: ${skill.path}`);
    if (skillNames.has(skill.name)) problems.push(`duplicate skill: ${skill.name}`);
    skillNames.add(skill.name);
  }
  const patchPaths = new Set<string>();
  for (const patch of manifest.configPatches) {
    if (!isSafeRelativePath(patch.file)) problems.push(`unsafe config path: ${patch.file}`);
    const key = patchKey(patch);
    if (patchPaths.has(key)) problems.push(`duplicate config patch: ${patch.file}:${patch.path.join(".")}`);
    patchPaths.add(key);
  }
  return problems;
}

export async function doctor(root: string): Promise<DoctorReport> {
  const resolvedRoot = resolve(root);
  const checks: DoctorCheck[] = [];
  let config: PoiesisConfig | undefined;
  let manifest: Manifest | undefined;

  try {
    config = await loadConfig(resolvedRoot);
    assertResolvedConfig(config);
    checks.push({ id: "config", status: "pass", message: "Poiesis config is valid" });
  } catch (error) {
    checks.push({ id: "config", status: "fail", message: "Poiesis config is invalid or missing", details: errorDetails(error) });
  }

  try {
    manifest = await loadManifest(resolvedRoot);
    const problems = manifestConsistency(manifest);
    checks.push({
      id: "manifest",
      status: problems.length === 0 ? "pass" : "fail",
      message: problems.length === 0 ? "Ownership manifest is valid" : "Ownership manifest is inconsistent",
      ...(problems.length > 0 ? { details: { problems } } : {}),
    });
  } catch (error) {
    checks.push({ id: "manifest", status: "fail", message: "Ownership manifest is invalid or missing", details: errorDetails(error) });
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
        const actual = skill.preexisting ? await hashDirectory(path) : await hashOwnedSkillDirectory(path);
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

export async function update(root: string, options: MaintenanceOptions = {}): Promise<UpdateResult> {
  const resolvedRoot = resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  const manifestProblems = manifestConsistency(manifest);
  if (manifestProblems.length > 0) {
    throw new PoiesisError("MANIFEST_OWNERSHIP_INVALID", "Refusing to update from an inconsistent manifest", {
      problems: manifestProblems,
    });
  }
  const config = await loadConfig(resolvedRoot);
  assertResolvedConfig(config);
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
  const desiredPatchKeys = new Set(desiredOpenCodePatches(config).map((patch) => patch.path.join("\0")));
  const obsoletePatches = manifest.configPatches.filter((patch) => !desiredPatchKeys.has(patch.path.join("\0")));
  if (obsoletePatches.length > 0) {
    throw new PoiesisError("CONFIG_MIGRATION_REQUIRED", "Current adapter cannot safely remove obsolete config patches", {
      paths: obsoletePatches.map((patch) => patch.path),
    });
  }

  const skills = options.skipSkills
    ? manifest.skills
    : await installDefaultSkills(resolvedRoot, manifest.skills, { replaceOwned: true });

  const nextFiles = [...manifest.files];
  const fileSnapshots = new Map<string, Buffer>();
  for (const file of materialized) {
    const path = join(resolvedRoot, file.path);
    if (await exists(path)) {
      const bytes = await readFile(path);
      fileSnapshots.set(file.path, bytes);
    }
    await atomicWrite(path, file.content);
    const index = nextFiles.findIndex((record) => record.path === file.path);
    nextFiles[index] = { path: file.path, kind: file.kind, hash: hashContent(file.content), owned: true };
  }

  const managedConfigFiles = [...new Set(manifest.configPatches.map((patch) => patch.file))];
  if (managedConfigFiles.length !== 1) {
    throw new PoiesisError("CONFIG_OWNERSHIP_INVALID", "Manifest must identify exactly one managed OpenCode config", {
      files: managedConfigFiles,
    });
  }
  const openCodeConfig = managedConfigFiles[0]!;
  const openCodeConfigPath = join(resolvedRoot, openCodeConfig);
  const openCodeConfigSnapshot = await snapshotFileIfOwned(openCodeConfigPath, resolvedRoot, manifest.files);

  let manifestPath: string | undefined;
  let manifestBackup: Buffer | null = null;
  try {
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, config, openCodeConfigPath);
    const priorPatches = new Map(manifest.configPatches.map((patch) => [patchKey(patch), patch]));
    const configPatches = appliedPatches.map((patch) => {
      const prior = priorPatches.get(patchKey(patch));
      return prior === undefined
        ? patch
        : {
            file: patch.file,
            path: patch.path,
            previousExists: prior.previousExists,
            ...(prior.previousExists ? { previous: prior.previous } : {}),
            installed: patch.installed,
          };
    });
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
      },
      files: nextFiles,
      skills,
      configPatches,
    };
    manifestPath = poiesisPath(resolvedRoot, "manifest.json");
    manifestBackup = await snapshotFile(manifestPath);
    await atomicWrite(manifestPath, serializeManifest(next));
    const report = await doctor(resolvedRoot);
    if (!report.ok) {
      throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Poiesis update did not pass doctor", { report });
    }
    return { manifest: next, doctor: report };
  } catch (error) {
    if (manifestPath !== undefined) await restoreManifest(manifestPath, manifestBackup);
    await restoreOpenCodeConfig(openCodeConfigPath, openCodeConfigSnapshot);
    await restoreMaterializedFiles(resolvedRoot, materialized, fileSnapshots);
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

export async function uninstall(root: string): Promise<UninstallResult> {
  const resolvedRoot = resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  const manifestProblems = manifestConsistency(manifest);
  if (manifestProblems.length > 0) {
    throw new PoiesisError("MANIFEST_OWNERSHIP_INVALID", "Refusing to uninstall from an inconsistent manifest", {
      problems: manifestProblems,
    });
  }
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
  for (const file of manifest.files) {
    const path = ownedPath(resolvedRoot, file.path);
    if (!(await exists(path))) {
      result.removed.push(file.path);
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
  } else {
    const removed = new Set(result.removed);
    const changedConfigFiles = new Set(configResult.reverted.map((patch) => patch.file));
    const retained: Manifest = {
      ...manifest,
      files: manifest.files.filter((file) => !removed.has(file.path) && !changedConfigFiles.has(file.path)),
      skills: manifest.skills.filter((skill) => !removed.has(skill.path)),
      configPatches: configResult.preserved,
    };
    await atomicWrite(poiesisPath(resolvedRoot, "manifest.json"), serializeManifest(retained));
  }
  return result;
}

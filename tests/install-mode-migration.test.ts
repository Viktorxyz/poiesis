/**
 * Spec #190 / ticket #194 — the explicit migration of a released, mode-less
 * installation onto `private` / `team`, through the module-internal
 * transaction seam.
 *
 * The subject of this ticket is an installation a RELEASED Poiesis version
 * wrote BEFORE the sharing mode existed, so the fixture reproduces that release
 * rather than manufacturing a hand-edited manifest: a real `init`, then the
 * three facts a release actually had and Spec #190 removed —
 *
 *   - no `mode` and no managed ignore block on the manifest, and no `mode` in
 *     the local config;
 *   - `durable: true` on every canon / projection the template table used to
 *     track, and those files actually TRACKED and committed in the repository;
 *   - a `.gitignore` carrying the Author's own rules plus the loose Poiesis
 *     rules no manifest record ever claimed.
 *
 * The properties under test:
 *
 *   - BOTH modes are reachable only through the migration route, and each states
 *     one sharing policy in all three places it is recorded (config, manifest,
 *     block). `private` produces the visible managed policy and keeps every
 *     Poiesis artifact ignored; `team` additionally publishes ONLY the accepted
 *     declarative profile source;
 *   - the formerly tracked artifacts are removed from the Git INDEX and nothing
 *     else: worktree bytes survive byte-for-byte, every staged removal is
 *     reported, `HEAD` and the remote never move, and Poiesis never commits or
 *     pushes;
 *   - receipt identity is preserved (same installation, generation + 1) and the
 *     runtime identity is neither crossed nor rewritten;
 *   - existing modified / foreign / user content is preserved or blocks safely:
 *     an owned artifact the Author changed, a dirty index, an unsafe path, a
 *     contradicting or non-portable profile, and an already-migrated
 *     installation all fail closed with the offending path named and nothing
 *     written;
 *   - a failure after every write reverses every owned byte AND every staged
 *     index entry;
 *   - ordinary `update --config` still refuses an explicit mode against a
 *     mode-less manifest: the migration is a separate route, not a relaxation.
 */
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, update } from "../src/maintenance.js";
import {
  runInstallModeMigrationTransaction,
  type InstallModeMigrationHooks,
} from "../src/install-mode-migration-internal.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import {
  ownershipReceiptLocation,
  readOwnershipReceipt,
  replaceOwnershipReceipt,
} from "../src/receipt.js";
import { atomicWrite } from "../src/fs.js";
import { hashContent } from "../src/hash.js";
import { PoiesisError } from "../src/errors.js";
import { parseManagedIgnoreBlocks } from "../src/install-mode.js";
import {
  TEAM_PROFILE_CONFIG_PATH,
  TEAM_PROFILE_DIRECTORY,
  TEAM_PROFILE_SKILLS_LOCK_PATH,
} from "../src/team-profile.js";
import { parseJsonc, serializeConfig, type PoiesisConfig } from "../src/config.js";
import { runUpdateConfigTransaction } from "../src/update-config-internal.js";
import { run } from "../src/process.js";
import { templateMappings } from "../src/templates.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { asPredecessorManifest, rebindReceipt } from "./predecessor-migration-fixtures.js";
import { dispatchCli } from "../src/cli.js";

/**
 * The Author's own `.gitignore`, present before Poiesis ever ran, plus the loose
 * Poiesis rules a pre-Spec #190 release appended. Those loose rules are Poiesis
 * text that NO manifest record claims, so the migration must preserve them
 * byte-for-byte rather than clean them up on a guess.
 */
const RELEASED_GITIGNORE = [
  "node_modules/",
  "dist/",
  "",
  "# Poiesis-managed ignore rules (added by `poiesis init`)",
  ".poiesis/",
  ".poiesis/workspaces/",
  ...templateMappings.filter((mapping) => mapping.kind === "generated").map((mapping) => mapping.destination),
  "opencode.jsonc",
  "",
].join("\n");

/**
 * Everything a pre-Spec #190 release TRACKED: the Author's `.gitignore`, the
 * canon and generated projections `trackInProject` used to mean, and the OpenCode
 * config `init` created and the project committed.
 *
 * `.gitignore` is listed because the Author's own policy file was tracked, but
 * it is NOT a manifest record, so it is never an untracking candidate and only
 * appears in the byte-preservation assertions.
 */
const RELEASED_TRACKED_PATHS = [
  ".gitignore",
  ...templateMappings.filter((mapping) => mapping.trackInProject === true).map((mapping) => mapping.destination),
  "opencode.jsonc",
].sort();

/**
 * The delivery scripts `init` generated and recorded in `generatedScripts`. A
 * release committed them like any other project file, and the legacy ignore
 * rules never hid them, so they are tracked — and, unlike the Author's own
 * skills, they ARE manifest-attributable, which is why they are candidates.
 */
const RELEASED_GENERATED_SCRIPTS = ["preview", "staging", "production"].map(
  (target) => `scripts/poiesis-${target}.mjs`,
);

const DEFAULT_SKILL_NAMES = [
  "grilling",
  "grill-with-docs",
  "domain-modeling",
  "research",
  "codebase-design",
  "to-spec",
  "to-tickets",
  "code-review",
  "diagnosing-bugs",
  "test-driven-development",
  "verification-before-completion",
];

function portableConfig(mode: "private" | "team"): PoiesisConfig {
  const command = (target: string) => ({
    adapter: "command",
    command: ["node", `scripts/poiesis-${target}.mjs`, target, "{sha}"],
  });
  return {
    schema: 1,
    mode,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: "poiesis-tracker-fixture" },
    delivery: {
      preview: command("preview"),
      staging: command("staging"),
      production: command("production"),
    },
    verification: { commands: ["test -f README.md"] },
  };
}

/**
 * The manifest a pre-Spec #190 release recorded.
 *
 * Dropping `mode` and `ignoreBlock` is only half of that shape: authority
 * classifies project-tracked template files as `durable` exactly when the
 * manifest records no mode, so a manifest stripped of the mode keys while
 * keeping Spec #191's classification is a tampered one, not a released one.
 */
function asReleasedManifest(manifest: Manifest): Manifest {
  const { mode: _mode, ignoreBlock: _ignoreBlock, ...rest } = manifest;
  const durablePaths = new Set(
    templateMappings.filter((mapping) => mapping.trackInProject === true).map((mapping) => mapping.destination),
  );
  return {
    ...rest,
    files: manifest.files.map((file) =>
      file.durable === undefined && durablePaths.has(file.path) ? { ...file, durable: true } : file,
    ),
  } as Manifest;
}

async function seedAuthorSkills(root: string): Promise<void> {
  for (const name of DEFAULT_SKILL_NAMES) {
    const directory = join(root, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `# author skill ${name}\n`, "utf8");
  }
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await run("git", args, { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * Staged index changes as `<status> <path>` records.
 *
 * `--name-status -z` emits the status and the path as SEPARATE NUL-terminated
 * fields, so the capture is paired here rather than counted: an unpaired read
 * would report two records for one staged change and make a correct index-only
 * removal look like it touched twice as much as it did.
 */
async function stagedChanges(root: string): Promise<string[]> {
  const { stdout } = await git(root, ["diff", "--cached", "--name-status", "-z"]);
  const fields = stdout.split("\0").filter((record) => record.length > 0);
  const changes: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]!;
    if (!/^[A-Z][0-9]*$/.test(status)) continue;
    const path = fields[index + 1];
    if (path === undefined) continue;
    changes.push(`${status} ${path}`);
    index += 1;
  }
  return changes.sort();
}

async function trackedPaths(root: string): Promise<string[]> {
  const { stdout } = await git(root, ["ls-files"]);
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
}

async function ignored(root: string, path: string): Promise<boolean> {
  const result = await run("git", ["check-ignore", "-q", "--", path], { cwd: root, allowFailure: true });
  return result.exitCode === 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

interface SharingSnapshot {
  gitignore: Buffer;
  manifest: Buffer;
  config: Buffer;
  receipt: Buffer;
}

async function snapshot(root: string): Promise<SharingSnapshot> {
  return {
    gitignore: await readFile(join(root, ".gitignore")),
    manifest: await readFile(join(root, ".poiesis", "manifest.json")),
    config: await readFile(join(root, ".poiesis", "config.jsonc")),
    receipt: await readFile(await ownershipReceiptLocation(root)),
  };
}

function expectSharingStateUnchanged(
  before: SharingSnapshot,
  after: SharingSnapshot,
  staged: readonly string[],
  stagedBefore: readonly string[],
): void {
  expect(Buffer.compare(after.gitignore, before.gitignore), ".gitignore changed").toBe(0);
  expect(Buffer.compare(after.manifest, before.manifest), "manifest advanced").toBe(0);
  expect(Buffer.compare(after.config, before.config), "installed config changed").toBe(0);
  expect(Buffer.compare(after.receipt, before.receipt), "ownership receipt advanced").toBe(0);
  expect(staged, "the index changed").toEqual([...stagedBefore]);
}

describe("Spec #190 / ticket #194 - the explicit mode-less installation migration", () => {
  const repositories: TestRepository[] = [];
  let fake: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    fake = await installFakeOpenCode();
  });

  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });

  afterAll(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  /**
   * Install Poiesis, then rewrite the installation into the shape a RELEASED
   * pre-Spec #190 version left behind, and commit it the way that release's
   * Author would have.
   *
   * The receipt is rebound to the rewritten manifest, so the state the
   * transaction refuses or accepts is an AUTHENTICATED one and cannot be
   * dismissed as corruption.
   */
  const installReleasedModeLess = async (options: { trackArtifacts?: boolean } = {}): Promise<TestRepository> => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await seedAuthorSkills(repo.root);
    await init(repo.root, portableConfig("private"), { allowFixtureAdapters: true });

    // The local config a release wrote states no mode.
    const configPath = join(repo.root, ".poiesis", "config.jsonc");
    const { mode: _omitted, ...withoutMode } = parseJsonc<PoiesisConfig>(
      await readFile(configPath, "utf8"),
      configPath,
    );
    const configBytes = serializeConfig(withoutMode);

    await writeFile(join(repo.root, ".gitignore"), RELEASED_GITIGNORE, "utf8");
    const manifest = asReleasedManifest(await loadManifest(repo.root));
    manifest.files = manifest.files.map((file) =>
      file.path === ".poiesis/config.jsonc" ? { ...file, hash: hashContent(configBytes) } : file,
    );
    await atomicWrite(configPath, configBytes);
    await atomicWrite(join(repo.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await replaceOwnershipReceipt(repo.root, await loadManifest(repo.root), await readOwnershipReceipt(repo.root));

    if (options.trackArtifacts !== false) {
      // What a release TRACKED. `-f` is required because the release's own
      // ignore rules hide exactly these paths — which is the whole reason the
      // migration has an index-only removal at all.
      await git(repo.root, ["add", "--all"]);
      await git(repo.root, ["add", "--force", "--", ...RELEASED_TRACKED_PATHS]);
      await git(repo.root, ["commit", "--quiet", "-m", "release Poiesis installation"]);
    }
    return repo;
  };

  it("migrates a released mode-less installation to private: one visible policy, Poiesis artifacts untracked, nothing committed", async () => {
    const repo = await installReleasedModeLess();
    const root = repo.root;
    expect((await loadManifest(root)).mode).toBeUndefined();
    expect(parseManagedIgnoreBlocks(await readFile(join(root, ".gitignore"), "utf8"))).toEqual([]);
    for (const path of RELEASED_TRACKED_PATHS.filter((path) => path !== ".gitignore")) {
      expect(await trackedPaths(root), `${path} must start tracked`).toContain(path);
    }

    // Worktree bytes and the recorded identity, captured before the migration.
    const ownedBefore = new Map<string, Buffer>();
    for (const path of [...RELEASED_TRACKED_PATHS, ...RELEASED_GENERATED_SCRIPTS]) {
      if (path === ".gitignore") continue;
      ownedBefore.set(path, await readFile(join(root, path)));
    }
    const headBefore = (await git(root, ["rev-parse", "HEAD"])).stdout;
    const remoteBefore = (await git(root, ["rev-parse", "refs/remotes/origin/main"])).stdout;
    const receiptBefore = await readOwnershipReceipt(root);

    const result = await runInstallModeMigrationTransaction(root, "private", {});

    // Exactly ONE mode statement survives, identical in all three records.
    expect(result.mode).toBe("private");
    expect(result.manifest.mode).toBe("private");
    expect(result.manifest.ignoreBlock?.mode).toBe("private");
    const config = parseJsonc<{ mode?: string }>(
      await readFile(join(root, ".poiesis", "config.jsonc"), "utf8"),
      ".poiesis/config.jsonc",
    );
    expect(config.mode).toBe("private");

    // The block is APPENDED to the release's own bytes: the Author's rules and
    // the loose Poiesis rules no record claims are all still there.
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore.startsWith(RELEASED_GITIGNORE)).toBe(true);
    const blocks = parseManagedIgnoreBlocks(gitignore);
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.mode).toBe("private");
    expect(result.manifest.ignoreBlock?.hash).toBe(block.hash);
    expect(result.manifest.ignoreBlock?.fileCreated).toBe(false);
    expect(block.patterns).toContain(".poiesis/");
    for (const path of templateMappings.filter((mapping) => mapping.kind === "generated").map((mapping) => mapping.destination)) {
      expect(block.patterns, `${path} must be inside the private policy`).toContain(path);
    }
    expect(block.patterns).toContain("opencode.jsonc");
    // Private states no sharing intent and publishes nothing.
    expect(block.text).not.toContain("does NOT ignore");
    // The generated delivery scripts ARE manifest-attributable, so the policy
    // names them and the index-only removal takes effect for them too.
    for (const path of RELEASED_GENERATED_SCRIPTS) {
      expect(block.patterns, `${path} must be inside the private policy`).toContain(path);
    }
    // The Author's OWN skill directories are named by nothing and tracked by
    // nothing: a preexisting skill is the Author's, across a migration exactly
    // as across an install.
    for (const name of DEFAULT_SKILL_NAMES) {
      expect(block.patterns, `.agents/skills/${name} must stay the Author's own`).not.toContain(
        `.agents/skills/${name}`,
      );
      expect(result.untracked).not.toContain(`.agents/skills/${name}`);
      expect(await trackedPaths(root)).toContain(`.agents/skills/${name}/SKILL.md`);
      expect(await ignored(root, `.agents/skills/${name}/SKILL.md`)).toBe(false);
    }
    expect(await pathExists(join(root, TEAM_PROFILE_DIRECTORY))).toBe(false);

    // The policy is EFFECTIVE: every formerly tracked Poiesis artifact is
    // ignored, because it left the index, and every removal is reported.
    for (const path of [...RELEASED_TRACKED_PATHS, ...RELEASED_GENERATED_SCRIPTS].filter(
      (path) => path !== ".gitignore",
    )) {
      expect(await ignored(root, path), `${path} must be ignored`).toBe(true);
      expect(result.untracked, `${path} must be reported as untracked`).toContain(path);
    }
    expect([...result.untracked].sort()).toEqual(
      [...RELEASED_TRACKED_PATHS.filter((path) => path !== ".gitignore"), ...RELEASED_GENERATED_SCRIPTS].sort(),
    );
    const staged = await stagedChanges(root);
    expect(staged.length).toBe(result.untracked.length);
    expect(staged.every((record) => record.startsWith("D "))).toBe(true);

    // Worktree bytes survive the index-only removal, byte-for-byte.
    for (const [path, bytes] of ownedBefore) {
      expect(await readFile(join(root, path)), `${path} worktree bytes changed`).toEqual(bytes);
    }
    // Nothing was committed and nothing was pushed.
    expect((await git(root, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
    expect((await git(root, ["rev-parse", "refs/remotes/origin/main"])).stdout).toBe(remoteBefore);

    // Receipt identity is preserved and advanced by exactly one generation.
    const receiptAfter = await readOwnershipReceipt(root);
    expect(receiptAfter.installationId).toBe(receiptBefore.installationId);
    expect(receiptAfter.commonDir).toBe(receiptBefore.commonDir);
    expect(receiptAfter.workspace).toBe(receiptBefore.workspace);
    expect(receiptAfter.generation).toBe(receiptBefore.generation + 1);
    // Runtime identity is neither crossed nor rewritten.
    expect(result.manifest.poiesisVersion).toBe((await loadManifest(root)).poiesisVersion);
    // `durable` was a property of the mode-less shape; authority checks it.
    expect(result.manifest.files.some((file) => file.durable === true)).toBe(false);
    // The doctor gate ran, and the installation reports one mode everywhere.
    expect(result.doctor.checks.find((check) => check.id === "install-mode")).toMatchObject({ status: "pass" });
    expect(result.doctor.checks.find((check) => check.id === "manifest")).toMatchObject({ status: "pass" });
    expect(result.doctor.checks.find((check) => check.id === "receipt")).toMatchObject({ status: "pass" });
    expect(result.doctor.ok).toBe(true);
  }, 180_000);

  it("migrates a released mode-less installation to team, publishing only the accepted declarative profile source", async () => {
    const repo = await installReleasedModeLess();
    const root = repo.root;
    const result = await runInstallModeMigrationTransaction(root, "team", {});

    expect(result.mode).toBe("team");
    const block = parseManagedIgnoreBlocks(await readFile(join(root, ".gitignore"), "utf8"))[0]!;
    expect(block.mode).toBe("team");
    expect(block.text).toContain(`${TEAM_PROFILE_DIRECTORY}/`);
    expect(block.text).toContain("does NOT ignore");

    // The shareable profile exists, is portable, and states team.
    expect(result.createdProfileFiles).toEqual([TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_SKILLS_LOCK_PATH]);
    const profile = parseJsonc<{ mode?: string }>(
      await readFile(join(root, TEAM_PROFILE_CONFIG_PATH), "utf8"),
      TEAM_PROFILE_CONFIG_PATH,
    );
    expect(profile.mode).toBe("team");
    expect(await readFile(join(root, TEAM_PROFILE_CONFIG_PATH), "utf8")).not.toContain(repo.parent);
    expect(await pathExists(join(root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toBe(true);
    expect(result.doctor.checks.find((check) => check.id === "team-profile")).toMatchObject({ status: "pass" });

    // ONLY the declarative profile source became committable. Everything else
    // Poiesis owns is untracked and ignored.
    const stageable = (await git(root, ["add", "--dry-run", "--all"])).stdout
      .split("\n")
      .map((line) => line.trim().replace(/^add '/, "").replace(/'$/, ""))
      .filter((line) => line.length > 0)
      .sort();
    expect(stageable).toEqual([".gitignore", TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_SKILLS_LOCK_PATH].sort());
    for (const path of [".poiesis/manifest.json", "opencode.jsonc", ".opencode/agents/poiesis.md"]) {
      expect(await ignored(root, path), `${path} must stay untracked`).toBe(true);
    }
    // The same index-only removals as private, and still no commit.
    expect(result.untracked).toContain("opencode.jsonc");
    expect(await stagedChanges(root)).not.toEqual([]);
  }, 180_000);

  it("refuses an installation that already records a mode, and refuses an ordinary update --config mode against a mode-less one", async () => {
    const repo = await installReleasedModeLess();
    const root = repo.root;
    await runInstallModeMigrationTransaction(root, "private", {});
    const after = await snapshot(root);
    const stagedAfter = await stagedChanges(root);

    // A second migration is not a migration.
    const repeated = await runInstallModeMigrationTransaction(root, "team", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(repeated).toBeInstanceOf(PoiesisError);
    expect((repeated as PoiesisError).code).toBe("INSTALL_MODE_MIGRATION_UNSUPPORTED");
    expect((repeated as PoiesisError).details).toMatchObject({ path: ".poiesis/manifest.json", recorded: "private" });
    expectSharingStateUnchanged(after, await snapshot(root), await stagedChanges(root), stagedAfter);

    // And the migration route did not relax the ordinary route: on a fresh
    // mode-less installation, `update --config` with an explicit mode still
    // refuses, exactly as ticket #193 made it.
    const legacy = await installReleasedModeLess();
    const candidate = join(legacy.parent, "candidate-team.jsonc");
    await writeFile(candidate, serializeConfig(portableConfig("team")), "utf8");
    const refused = await runUpdateConfigTransaction(legacy.root, candidate, {}, {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PoiesisError);
    expect((refused as PoiesisError).code).toBe("INSTALL_MODE_TRANSITION_UNSUPPORTED");
    expect((await loadManifest(legacy.root)).mode).toBeUndefined();
    expect(await pathExists(join(legacy.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
  }, 240_000);

  it("blocks on an owned artifact the Author changed, and on a dirty index, naming the path and writing nothing", async () => {
    // An UNTRACKED owned artifact the Author edited: the index is clean, so the
    // refusal is about the bytes Poiesis can no longer recognise rather than
    // about an operation in flight.
    const changed = await installReleasedModeLess({ trackArtifacts: false });
    const changedPath = ".opencode/agents/poiesis.md";
    expect(await trackedPaths(changed.root)).not.toContain(changedPath);
    await writeFile(join(changed.root, changedPath), "# the Author edited this projection\n", "utf8");
    const before = await snapshot(changed.root);
    const stagedBefore = await stagedChanges(changed.root);

    const changedResult = await runInstallModeMigrationTransaction(changed.root, "private", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(changedResult).toBeInstanceOf(PoiesisError);
    expect((changedResult as PoiesisError).code).toBe("INSTALL_MODE_MIGRATION_OWNED_FILE_CHANGED");
    expect((changedResult as PoiesisError).details.path).toBe(changedPath);
    expectSharingStateUnchanged(before, await snapshot(changed.root), await stagedChanges(changed.root), stagedBefore);
    expect((await loadManifest(changed.root)).mode).toBeUndefined();

    // A staged edit on a TRACKED owned artifact: the Author has an operation in
    // flight, and an index-only removal would convert it into a staged
    // deletion, so the refusal is about the index.
    const dirty = await installReleasedModeLess();
    const dirtyPath = ".poiesis/roles/worker.md";
    expect(await trackedPaths(dirty.root)).toContain(dirtyPath);
    await writeFile(join(dirty.root, dirtyPath), "author staged edit\n", "utf8");
    // `-f` because the release's own ignore rules hide `.poiesis/`; what is
    // under test is the STAGED EDIT, not whether Git needed permission.
    await git(dirty.root, ["add", "--force", "--", dirtyPath]);
    const dirtyBefore = await snapshot(dirty.root);
    const dirtyStagedBefore = await stagedChanges(dirty.root);

    const dirtyResult = await runInstallModeMigrationTransaction(dirty.root, "private", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(dirtyResult).toBeInstanceOf(PoiesisError);
    expect((dirtyResult as PoiesisError).code).toBe("INSTALL_MODE_MIGRATION_DIRTY_INDEX");
    expect((dirtyResult as PoiesisError).details).toMatchObject({ path: dirtyPath, staged: true, unstaged: false });
    expectSharingStateUnchanged(dirtyBefore, await snapshot(dirty.root), await stagedChanges(dirty.root), dirtyStagedBefore);
    expect((await loadManifest(dirty.root)).mode).toBeUndefined();

    // The local generated config is the one owned file the migration rewrites,
    // so a hand edit to it is refused rather than silently re-baselined.
    const edited = await installReleasedModeLess();
    await writeFile(
      join(edited.root, ".poiesis", "config.jsonc"),
      `${await readFile(join(edited.root, ".poiesis", "config.jsonc"), "utf8")}\n// the Author edited this\n`,
      "utf8",
    );
    const editedBefore = await snapshot(edited.root);
    const editedStaged = await stagedChanges(edited.root);

    const editedResult = await runInstallModeMigrationTransaction(edited.root, "private", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(editedResult).toBeInstanceOf(PoiesisError);
    expect((editedResult as PoiesisError).code).toBe("FILE_OWNERSHIP_LOST");
    expect((editedResult as PoiesisError).details.path).toBe(".poiesis/config.jsonc");
    expectSharingStateUnchanged(
      editedBefore,
      await snapshot(edited.root),
      await stagedChanges(edited.root),
      editedStaged,
    );
  }, 240_000);

  it("fails closed on an unsafe path: a symlinked .gitignore, and a symlinked shared-profile parent", async () => {
    // A symlinked `.gitignore` is refused by name, without following it.
    const symlinked = await installReleasedModeLess();
    const outside = join(symlinked.parent, "author-gitignore");
    await writeFile(outside, RELEASED_GITIGNORE, "utf8");
    await rm(join(symlinked.root, ".gitignore"));
    await symlink(outside, join(symlinked.root, ".gitignore"));

    const gitignoreResult = await runInstallModeMigrationTransaction(symlinked.root, "private", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(gitignoreResult).toBeInstanceOf(PoiesisError);
    expect((gitignoreResult as PoiesisError).code).toBe("INSTALL_PATH_CONFLICT");
    expect((gitignoreResult as PoiesisError).details.path).toBe(".gitignore");
    expect(await readFile(outside, "utf8")).toBe(RELEASED_GITIGNORE);
    expect((await loadManifest(symlinked.root)).mode).toBeUndefined();

    // A symlinked profile parent would let the published source be written
    // outside the repository, so it is refused before a byte is written.
    const linkedProfile = await installReleasedModeLess();
    const profileOutside = join(linkedProfile.parent, "elsewhere");
    await mkdir(profileOutside, { recursive: true });
    await symlink(profileOutside, join(linkedProfile.root, TEAM_PROFILE_DIRECTORY));
    const before = await snapshot(linkedProfile.root);
    const stagedBefore = await stagedChanges(linkedProfile.root);

    const profileResult = await runInstallModeMigrationTransaction(linkedProfile.root, "team", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(profileResult).toBeInstanceOf(PoiesisError);
    expect((profileResult as PoiesisError).code).toBe("UNSAFE_MANAGED_PATH");
    expect((profileResult as PoiesisError).details.path).toBe(TEAM_PROFILE_DIRECTORY);
    expectSharingStateUnchanged(before, await snapshot(linkedProfile.root), await stagedChanges(linkedProfile.root), stagedBefore);
    expect(await readdirSafe(profileOutside)).toEqual([]);
  }, 240_000);

  it("refuses a team migration that would publish a contradicting or non-portable profile, writing nothing", async () => {
    // A contradicting committed profile is Author content, never overwritten.
    const contradicting = await installReleasedModeLess();
    const committed = `${JSON.stringify(
      { ...portableConfig("team"), models: { reasoning: "anthropic/claude-sonnet-4-5", execution: "minimax/MiniMax-M3" } },
      null,
      2,
    )}\n`;
    await mkdir(join(contradicting.root, TEAM_PROFILE_DIRECTORY), { recursive: true });
    await writeFile(join(contradicting.root, TEAM_PROFILE_CONFIG_PATH), committed, "utf8");
    await git(contradicting.root, ["add", "--force", "--", TEAM_PROFILE_CONFIG_PATH]);
    await git(contradicting.root, ["commit", "--quiet", "-m", "team profile"]);
    const contradictingBefore = await snapshot(contradicting.root);
    const contradictingStaged = await stagedChanges(contradicting.root);

    const contradictingResult = await runInstallModeMigrationTransaction(contradicting.root, "team", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(contradictingResult).toBeInstanceOf(PoiesisError);
    expect((contradictingResult as PoiesisError).code).toBe("TEAM_PROFILE_CONFLICT");
    expect((contradictingResult as PoiesisError).details.source).toBe(TEAM_PROFILE_CONFIG_PATH);
    expect(await readFile(join(contradicting.root, TEAM_PROFILE_CONFIG_PATH), "utf8")).toBe(committed);
    expect(await pathExists(join(contradicting.root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toBe(false);
    expectSharingStateUnchanged(
      contradictingBefore,
      await snapshot(contradicting.root),
      await stagedChanges(contradicting.root),
      contradictingStaged,
    );

    // A private install may legally hold a machine-specific policy; asking to
    // SHARE it is what the portability refusal is about.
    const machineSpecific = await createTestRepository();
    repositories.push(machineSpecific);
    await seedAuthorSkills(machineSpecific.root);
    await init(
      machineSpecific.root,
      portableConfig("private"),
      { allowFixtureAdapters: true },
    );
    // Rewrite the installed policy to an absolute delivery path and re-hash it,
    // the way a real installation would carry a machine-local delivery command.
    const configPath = join(machineSpecific.root, ".poiesis", "config.jsonc");
    const raw = parseJsonc<PoiesisConfig>(await readFile(configPath, "utf8"), configPath);
    const { mode: _omitted, ...rest } = raw;
    const bytes = serializeConfig({
      ...rest,
      delivery: {
        preview: { adapter: "command", command: ["node", `${machineSpecific.fixtures}/preview.mjs`, "{sha}"] },
        staging: { adapter: "command", command: ["node", `${machineSpecific.fixtures}/staging.mjs`, "{sha}"] },
        production: { adapter: "command", command: ["node", `${machineSpecific.fixtures}/production.mjs`, "{sha}"] },
      },
    } as PoiesisConfig);
    await atomicWrite(configPath, bytes);
    const manifest = asReleasedManifest(await loadManifest(machineSpecific.root));
    manifest.files = manifest.files.map((file) =>
      file.path === ".poiesis/config.jsonc" ? { ...file, hash: hashContent(bytes) } : file,
    );
    await atomicWrite(join(machineSpecific.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await replaceOwnershipReceipt(
      machineSpecific.root,
      await loadManifest(machineSpecific.root),
      await readOwnershipReceipt(machineSpecific.root),
    );
    await writeFile(join(machineSpecific.root, ".gitignore"), RELEASED_GITIGNORE, "utf8");
    await git(machineSpecific.root, ["add", "--all"]);
    await git(machineSpecific.root, ["add", "--force", "--", ...RELEASED_TRACKED_PATHS]);
    await git(machineSpecific.root, ["commit", "--quiet", "-m", "release Poiesis installation"]);
    const machineBefore = await snapshot(machineSpecific.root);
    const machineStaged = await stagedChanges(machineSpecific.root);

    const machineResult = await runInstallModeMigrationTransaction(machineSpecific.root, "team", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(machineResult).toBeInstanceOf(PoiesisError);
    expect((machineResult as PoiesisError).code).toBe("TEAM_PROFILE_NOT_PORTABLE");
    const offenders = (machineResult as PoiesisError).details.offenders as Array<{ path: string }>;
    expect(offenders.map((offender) => offender.path)).toContain("delivery.preview.command[1]");
    expect(await pathExists(join(machineSpecific.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
    expectSharingStateUnchanged(
      machineBefore,
      await snapshot(machineSpecific.root),
      await stagedChanges(machineSpecific.root),
      machineStaged,
    );
  }, 300_000);

  it("reverses every owned byte AND every staged index entry when a post-write step fails", async () => {
    const repo = await installReleasedModeLess();
    const root = repo.root;
    const before = await snapshot(root);
    const stagedBefore = await stagedChanges(root);
    const headBefore = (await git(root, ["rev-parse", "HEAD"])).stdout;
    const ownedBefore = new Map<string, Buffer>();
    for (const path of [...RELEASED_TRACKED_PATHS, ...RELEASED_GENERATED_SCRIPTS]) {
      if (path === ".gitignore") continue;
      ownedBefore.set(path, await readFile(join(root, path)));
    }

    const hooks: InstallModeMigrationHooks = {
      // Fires after the block, the profile, the config, the manifest, the
      // receipt, AND the index removals: the widest possible rollback surface.
      postIndexUntrack: () => {
        throw new Error("injected post-untrack fault");
      },
    };
    await expect(
      runInstallModeMigrationTransaction(root, "team", hooks),
    ).rejects.toThrow("injected post-untrack fault");

    expectSharingStateUnchanged(before, await snapshot(root), await stagedChanges(root), stagedBefore);
    // Every removed path is tracked again, so the index is exactly as it was.
    for (const path of ownedBefore.keys()) {
      expect(await trackedPaths(root), `${path} left the index`).toContain(path);
    }
    // And every worktree byte survived the removal and its reversal.
    for (const [path, bytes] of ownedBefore) {
      expect(await readFile(join(root, path)), `${path} worktree bytes changed`).toEqual(bytes);
    }
    expect((await git(root, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
    // No shared profile was left behind, and the installation is still mode-less.
    expect(await pathExists(join(root, TEAM_PROFILE_DIRECTORY))).toBe(false);
    expect((await loadManifest(root)).mode).toBeUndefined();
    // The block on disk is still the one the manifest claims: a rolled-back
    // migration leaves a usable installation, and a clean retry succeeds.
    const retry = await runInstallModeMigrationTransaction(root, "team", {});
    expect(retry.mode).toBe("team");
    expect((await loadManifest(root)).mode).toBe("team");
  }, 240_000);

  it("refuses to cross a runtime release: a predecessor-recorded installation is brought forward by update, not by a sharing decision", async () => {
    const repo = await installReleasedModeLess();
    // `asPredecessorManifest` writes the exact predecessor projection a released
    // 1.1.1 image recorded and rebinds nothing, so this is the released
    // predecessor state itself.
    await asPredecessorManifest(repo, "1.1.1", { keepReceipt: true });
    await rebindReceipt(repo);
    expect((await loadManifest(repo.root)).poiesisVersion).toBe("1.1.1");

    const result = await runInstallModeMigrationTransaction(repo.root, "private", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(PoiesisError);
    expect((result as PoiesisError).code).toBe("INSTALL_MODE_MIGRATION_VERSION_MISMATCH");
    expect((result as PoiesisError).details).toMatchObject({ path: ".poiesis/manifest.json", project: "1.1.1" });
    // The recorded runtime identity is untouched by the refusal.
    expect((await loadManifest(repo.root)).poiesisVersion).toBe("1.1.1");
    expect(await pathExists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
  }, 180_000);

  it("leaves a first-class installation behind: an ordinary update keeps the chosen mode and its block", async () => {
    const repo = await installReleasedModeLess();
    await runInstallModeMigrationTransaction(repo.root, "private", {});
    const blockHash = (await loadManifest(repo.root)).ignoreBlock?.hash;

    // A migrated installation is not a special case for any later lifecycle
    // step: the ordinary reconcile runs, keeps the mode it now states, and
    // leaves the block it owns untouched.
    const updated = await update(repo.root, { skipSkills: true });
    expect(updated.manifest.mode).toBe("private");
    expect(updated.manifest.ignoreBlock?.mode).toBe("private");
    expect(updated.manifest.ignoreBlock?.hash).toBe(blockHash);
    expect(updated.manifest.files.some((file) => file.durable === true)).toBe(false);
    expect(updated.doctor.checks.find((check) => check.id === "install-mode")).toMatchObject({ status: "pass" });
  }, 180_000);

  it("cannot be run from a linked worktree: the primary's receipt authority is not inherited", async () => {
    const repo = await installReleasedModeLess();
    const linked = join(repo.parent, "linked");
    await git(repo.root, ["worktree", "add", "--quiet", linked, "-b", "linked-probe"]);
    // Give the linked checkout the installation's own records, the way a copy of
    // this project would carry them, so the ONLY thing that can refuse is the
    // receipt: it binds a workspace real path and this one has none of its own.
    await mkdir(join(linked, ".poiesis"), { recursive: true });
    for (const file of ["manifest.json", "config.jsonc"]) {
      await writeFile(join(linked, ".poiesis", file), await readFile(join(repo.root, ".poiesis", file)));
    }
    const primaryBefore = await snapshot(repo.root);

    const result = await runInstallModeMigrationTransaction(linked, "private", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(PoiesisError);
    expect(["OWNERSHIP_RECEIPT_MISSING", "OWNERSHIP_RECEIPT_MISMATCH"]).toContain(
      (result as PoiesisError).code,
    );
    expect((await loadManifest(linked)).mode).toBeUndefined();
    expectSharingStateUnchanged(primaryBefore, await snapshot(repo.root), await stagedChanges(repo.root), []);
  }, 180_000);

  // The CLI surface, because the route itself is part of the ticket: an
  // operator reaches a mode-less installation through `poiesis migrate
  // install-mode --to …`, and through nothing else.
  describe("the migrate install-mode CLI route", () => {
    it("migrates through the CLI, accepts the product wording, and reports every staged removal", async () => {
      const privateRepo = await installReleasedModeLess();
      const privateEnvelope = await dispatchMigrate(["migrate", "install-mode", "--to", "private", "--cwd", privateRepo.root]);
      expect(privateEnvelope.error).toBeUndefined();
      const privateResult = privateEnvelope.envelope.result as {
        mode: string;
        untracked: string[];
        createdProfileFiles: string[];
      };
      expect(privateResult.mode).toBe("private");
      // Every staged removal is reported by the route an operator actually runs.
      expect(privateResult.untracked.length).toBeGreaterThan(0);
      expect(await stagedChanges(privateRepo.root)).toHaveLength(privateResult.untracked.length);
      expect(privateResult.createdProfileFiles).toEqual([]);

      // `shared` is the product wording for `team`, answered at the flag surface
      // exactly as `init`'s guided prompt answers it.
      const teamRepo = await installReleasedModeLess();
      const teamEnvelope = await dispatchMigrate(["migrate", "install-mode", "--to", "shared", "--cwd", teamRepo.root]);
      expect(teamEnvelope.error).toBeUndefined();
      const teamResult = teamEnvelope.envelope.result as { mode: string; createdProfileFiles: string[] };
      expect(teamResult.mode).toBe("team");
      expect(teamResult.createdProfileFiles).toEqual([TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_SKILLS_LOCK_PATH]);
      expect((await loadManifest(teamRepo.root)).mode).toBe("team");
    }, 300_000);

    it("fails closed on a missing, unsupported, or unrouted request without touching the installation", async () => {
      const repo = await installReleasedModeLess();
      const before = await snapshot(repo.root);
      const stagedBefore = await stagedChanges(repo.root);

      for (const argv of [
        ["migrate", "install-mode", "--cwd", repo.root],
        ["migrate", "install-mode", "--to", "somewhere-else", "--cwd", repo.root],
        ["migrate", "sharing-policy", "--to", "private", "--cwd", repo.root],
      ]) {
        const { error } = await dispatchMigrate(argv);
        expect(error, `${argv.join(" ")} must be refused`).toBeInstanceOf(PoiesisError);
      }
      expectSharingStateUnchanged(before, await snapshot(repo.root), await stagedChanges(repo.root), stagedBefore);
      expect((await loadManifest(repo.root)).mode).toBeUndefined();
    }, 180_000);
  });
});

/**
 * Dispatch the CLI with the structured envelope captured instead of printed.
 *
 * The route is what an operator runs, so it is driven through the real command
 * dispatcher: an assertion against the transaction runner would pass while the
 * shipped command rejected a perfectly good `--to`.
 */
async function dispatchMigrate(argv: string[]): Promise<{
  envelope: { result?: unknown; error?: unknown };
  error?: unknown;
}> {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let envelope: { result?: unknown; error?: unknown } = {};
  const capture = (chunk: unknown): boolean => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    try {
      const parsed = JSON.parse(text) as { result?: unknown; error?: unknown };
      envelope = { ...(parsed.result === undefined ? {} : { result: parsed.result }), ...(parsed.error === undefined ? {} : { error: parsed.error }) };
    } catch {
      // The restart/help text of an unrelated command; nothing to capture.
    }
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    await dispatchCli(argv);
    return { envelope };
  } catch (error) {
    return { envelope, error };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function readdirSafe(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}
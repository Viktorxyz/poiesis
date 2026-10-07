/**
 * Spec #190 / ticket #193 — explicit Private <-> Team transitions through the
 * real packaged CLI in real temporary Git repositories.
 *
 * Everything here drives `node <isolated package>/node_modules/.bin/poiesis`,
 * never `updateFromConfig` imported from source, because the properties under
 * test are properties of what an Author ends up with on disk, in `git status`,
 * and in the doctor report — a source-level assertion could pass while the
 * shipped binary relabelled a block it should have refused.
 *
 * The transition surface is deliberately the config an operator already hands
 * to `poiesis update --config`: `mode` is a field of that config, so stating a
 * different one IS the explicit request. There is no second command to learn.
 *
 * The properties:
 *
 *   - both modes coexist with a real project: the Author's own `.gitignore`
 *     bytes above and below the block survive a transition byte-for-byte, and
 *     Git still stages exactly the shareable profile plus the policy;
 *   - a transition changes ONLY what the manifest attributes to this
 *     installation — an Author's existing skill directories and an Author's
 *     own OpenCode config are never broadly ignored, claimed, or removed;
 *   - an already-committed shared profile is adopted when it is exactly
 *     compatible and refused when it contradicts, and a tracked OpenCode
 *     config blocks Team -> Private rather than silently exposing private
 *     policy in shared history;
 *   - malformed / duplicated / mislabelled / edited / symlinked policy states
 *     fail closed with the offending path in the result;
 *   - a failure after the writes rolls the transition back byte-for-byte.
 *
 * Every default skill directory is pre-created by this suite so `init` records
 * them all as `preexisting` and never reaches the network. That is not a
 * shortcut: it is exactly the state Spec #190 is most concerned with, because
 * a preexisting skill is the Author's own and must never enter the policy.
 */
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import { parseJsonc } from "../src/config.js";
import { parseManagedIgnoreBlocks, type ManagedIgnoreBlock } from "../src/install-mode.js";
import { TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_DIRECTORY, TEAM_PROFILE_SKILLS_LOCK_PATH } from "../src/team-profile.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import {
  buildIsolatedPackage,
  removeOwnedBuildRoot,
  type IsolatedPackageBuild,
} from "./isolated-package-build.js";

const REPO_ROOT = join(import.meta.dirname, "..");

let built: IsolatedPackageBuild | undefined;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function poiesis(root: string, ...args: string[]): Promise<CliResult> {
  if (!built) throw new Error("packaged CLI not built");
  const result = await run("node", [built.binPath, ...args, "--cwd", root], {
    cwd: root,
    allowFailure: true,
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function errorCode(result: CliResult): string {
  return (json(result.stderr).error as { code: string }).code;
}

function errorDetails(result: CliResult): Record<string, unknown> {
  return (json(result.stderr).error as { details?: Record<string, unknown> }).details ?? {};
}

async function stageablePaths(root: string): Promise<string[]> {
  const result = await run("git", ["add", "--dry-run", "--all"], { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) throw new Error(`git add --dry-run failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^add '/, "").replace(/'$/, ""))
    .sort();
}

async function ignored(root: string, path: string): Promise<boolean> {
  const result = await run("git", ["check-ignore", "-q", "--", path], { cwd: root, allowFailure: true });
  return result.exitCode === 0;
}

function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * Every curated default skill name. Pre-creating all of them is what keeps
 * `init` offline: `installDefaultSkills` only stages what is ABSENT, so a
 * directory the Author already had is recorded `preexisting: true` and never
 * enters the ignore policy.
 */
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

async function writeAuthorSkills(root: string): Promise<Map<string, Buffer>> {
  const snapshots = new Map<string, Buffer>();
  for (const name of DEFAULT_SKILL_NAMES) {
    const directory = join(root, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    const content = Buffer.from(`# author skill ${name}\n`, "utf8");
    await writeFile(join(directory, "SKILL.md"), content);
    snapshots.set(join(root, ".agents", "skills", name), content);
  }
  return snapshots;
}

/**
 * A project-relative Poiesis policy that is PORTABLE, so it can be shared.
 *
 * Every value here is deliberately project-relative: an absolute path is
 * exactly the machine leakage `TEAM_PROFILE_NOT_PORTABLE` refuses, and a
 * transition to `team` has to survive that check before it writes a byte.
 */
function policy(mode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const delivery = Object.fromEntries(
    ["preview", "staging", "production"].map((target) => [
      target,
      { adapter: "command", command: ["node", `scripts/poiesis-${target}.mjs`, target, "{sha}"] },
    ]),
  );
  return {
    schema: 1,
    mode,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: "poiesis-tracker-fixture" },
    delivery,
    verification: { commands: ["test -f README.md"] },
    ...overrides,
  };
}

async function writePolicy(repository: TestRepository, name: string, mode: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const configPath = join(repository.parent, name);
  await writeFile(configPath, `${JSON.stringify(policy(mode, overrides), null, 2)}\n`);
  return configPath;
}

/** The Author's own `.gitignore`, present BEFORE Poiesis ever runs. */
const AUTHOR_GITIGNORE = "node_modules/\ndist/\n";

async function readManifest(root: string): Promise<{
  mode?: string;
  files: Array<{ path: string; provenance?: string }>;
  skills: Array<{ name: string; path: string; preexisting: boolean }>;
  configPatches: Array<{ file: string }>;
  ignoreBlock?: { mode: string; hash: string; patterns: string[]; fileCreated: boolean };
}> {
  return json(await readFile(join(root, ".poiesis", "manifest.json"), "utf8")) as never;
}

async function readDoctorChecks(root: string): Promise<Array<{ id: string; status: string; details?: Record<string, unknown> }>> {
  const result = await poiesis(root, "doctor");
  expect(result.exitCode, result.stderr).toBe(0);
  return (json(result.stdout).result as { checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> }).checks;
}

/** The single block the installation owns, or `undefined` when there is none. */
async function readBlock(root: string): Promise<ManagedIgnoreBlock | undefined> {
  const content = await readFile(join(root, ".gitignore"), "utf8");
  return parseManagedIgnoreBlocks(content)[0];
}

/** Snapshot the whole `.gitignore`, the manifest, and the installed config. */
async function snapshotSharingState(root: string): Promise<{ gitignore: Buffer; manifest: Buffer; config: Buffer }> {
  return {
    gitignore: await readFile(join(root, ".gitignore")),
    manifest: await readFile(join(root, ".poiesis", "manifest.json")),
    config: await readFile(join(root, ".poiesis", "config.jsonc")),
  };
}

/** Assert a failed transition left all three owned sharing bytes untouched. */
function expectSharingStateUnchanged(
  before: Awaited<ReturnType<typeof snapshotSharingState>>,
  after: Awaited<ReturnType<typeof snapshotSharingState>>,
): void {
  expect(Buffer.compare(after.gitignore, before.gitignore), ".gitignore changed").toBe(0);
  expect(Buffer.compare(after.manifest, before.manifest), "manifest advanced").toBe(0);
  expect(Buffer.compare(after.config, before.config), "installed config changed").toBe(0);
}

beforeAll(async () => {
  built = await buildIsolatedPackage(REPO_ROOT);
}, 180_000);

afterAll(async () => {
  if (built) await removeOwnedBuildRoot(built.ownedRoot);
  built = undefined;
});

describe("Spec #190 / ticket #193 - explicit Private <-> Team transitions through the packaged CLI", () => {
  const repositories: TestRepository[] = [];
  const fakes: FakeOpenCodeEnvironment[] = [];

  const repository = async (): Promise<TestRepository> => {
    const created = await createTestRepository();
    repositories.push(created);
    return created;
  };

  const installFake = async (): Promise<FakeOpenCodeEnvironment> => {
    const fake = await installFakeOpenCode();
    fakes.push(fake);
    return fake;
  };

  afterEach(async () => {
    for (const fake of fakes.splice(0)) fake.restore();
  });

  afterAll(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("relabels the one managed block, publishes the shareable profile, and preserves the Author's own bytes", async () => {
    const repo = await repository();
    await installFake();
    const gitignorePath = join(repo.root, ".gitignore");
    await writeFile(gitignorePath, AUTHOR_GITIGNORE);

    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);

    // The Author adds a rule of their own AFTER the block — the other side of
    // the boundary a transition must not cross.
    const installed = await readFile(gitignorePath, "utf8");
    const withAuthorTail = `${installed}\ncoverage/\n`;
    await writeFile(gitignorePath, withAuthorTail);

    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    const result = await poiesis(repo.root, "update", "--config", teamConfig);
    expect(result.exitCode, result.stderr).toBe(0);

    // Bytes above and below the block survive byte-for-byte.
    const transitioned = await readFile(gitignorePath, "utf8");
    expect(transitioned.startsWith(AUTHOR_GITIGNORE)).toBe(true);
    expect(transitioned.endsWith("\ncoverage/\n")).toBe(true);

    // Exactly ONE block, now labelled for the requested mode, stating the
    // deliberate omission of the profile directory.
    expect(parseManagedIgnoreBlocks(transitioned)).toHaveLength(1);
    const block = parseManagedIgnoreBlocks(transitioned)[0]!;
    expect(block.mode).toBe("team");
    expect(block.text).toContain(`${TEAM_PROFILE_DIRECTORY}/`);
    expect(block.text).toContain("does NOT ignore");

    // The manifest and the installed config now agree with the block, and the
    // recorded identity is the block that is actually on disk.
    const manifest = await readManifest(repo.root);
    expect(manifest.mode).toBe("team");
    expect(manifest.ignoreBlock?.mode).toBe("team");
    expect(manifest.ignoreBlock?.hash).toBe(block.hash);
    expect(manifest.ignoreBlock?.fileCreated).toBe(false);
    const installedConfig = parseJsonc<{ mode?: string }>(
      await readFile(join(repo.root, ".poiesis", "config.jsonc"), "utf8"),
      ".poiesis/config.jsonc",
    );
    expect(installedConfig.mode).toBe("team");

    // The shareable profile exists and is portable; nothing else Poiesis owns
    // became committable.
    expect(await exists(join(repo.root, TEAM_PROFILE_CONFIG_PATH))).toBe(true);
    expect(await exists(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toBe(true);
    const profileText = await readFile(join(repo.root, TEAM_PROFILE_CONFIG_PATH), "utf8");
    expect(profileText).not.toContain(repo.parent);
    expect(parseJsonc<{ mode?: string }>(profileText, TEAM_PROFILE_CONFIG_PATH).mode).toBe("team");
    expect(await stageablePaths(repo.root)).toEqual(
      [".gitignore", TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_SKILLS_LOCK_PATH].sort(),
    );
    for (const path of [".opencode/agents/poiesis.md", "opencode.jsonc", ".poiesis/manifest.json"]) {
      expect(await ignored(repo.root, path), `${path} must stay untracked`).toBe(true);
    }
    // And the Author's own rules still work.
    for (const path of ["node_modules/x", "dist/x", "coverage/x"]) {
      expect(await ignored(repo.root, path), `${path} must stay ignored`).toBe(true);
    }

    const checks = await readDoctorChecks(repo.root);
    expect(checks.find((check) => check.id === "install-mode")).toMatchObject({ status: "pass" });
    expect(checks.find((check) => check.id === "install-mode")?.details).toMatchObject({ mode: "team" });
    expect(checks.find((check) => check.id === "team-profile")?.status).toBe("pass");
  }, 120_000);

  it("returns to private without deleting the shared profile the Author committed", async () => {
    const repo = await repository();
    await installFake();
    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    expect((await poiesis(repo.root, "init", "--config", teamConfig, "--allow-fixtures")).exitCode).toBe(0);
    const profileBefore = await readFile(join(repo.root, TEAM_PROFILE_CONFIG_PATH));
    const lockBefore = await readFile(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH));

    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    const result = await poiesis(repo.root, "update", "--config", privateConfig);
    expect(result.exitCode, result.stderr).toBe(0);

    // The block is private again and no longer claims to share anything.
    const block = await readBlock(repo.root);
    expect(block?.mode).toBe("private");
    expect(block?.text).not.toContain("does NOT ignore");
    expect(block?.text).not.toContain(TEAM_PROFILE_DIRECTORY);
    const manifest = await readManifest(repo.root);
    expect(manifest.mode).toBe("private");
    expect(manifest.ignoreBlock?.mode).toBe("private");
    expect(manifest.ignoreBlock?.hash).toBe(block?.hash);

    // The shared profile is Author content, not Poiesis ownership: it is
    // preserved byte-for-byte in BOTH directions.
    expect(await readFile(join(repo.root, TEAM_PROFILE_CONFIG_PATH))).toEqual(profileBefore);
    expect(await readFile(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toEqual(lockBefore);

    const checks = await readDoctorChecks(repo.root);
    expect(checks.find((check) => check.id === "install-mode")).toMatchObject({ status: "pass" });
  }, 120_000);

  it("adopts an already-committed shared profile that is exactly compatible, and writes none of it", async () => {
    const repo = await repository();
    await installFake();
    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);

    // A teammate already committed the profile, hand-formatted: reordered keys,
    // different indentation, a trailing comma, and a comment. Every one of
    // those is a LEGAL difference in JSONC and must not read as a conflict.
    const committed = [
      "{",
      "  // the team's shared Poiesis intelligence",
      `  "mode": "team",`,
      `  "models": { "reasoning": "openai/gpt-5.6-sol", "execution": "minimax/MiniMax-M3" },`,
      `  "repository": { "remote": "origin", "integrationBranch": "main" },`,
      `  "tracker": { "provider": "fixture", "project": "poiesis-tracker-fixture" },`,
      `  "delivery": {`,
      `    "preview": { "adapter": "command", "command": ["node", "scripts/poiesis-preview.mjs", "preview", "{sha}"] },`,
      `    "staging": { "adapter": "command", "command": ["node", "scripts/poiesis-staging.mjs", "staging", "{sha}"] },`,
      `    "production": { "adapter": "command", "command": ["node", "scripts/poiesis-production.mjs", "production", "{sha}"] },`,
      `  },`,
      `  "verification": { "commands": ["test -f README.md"] },`,
      "  " + `"schema": 1,`,
      "}",
      "",
    ].join("\n");
    const configAbsolute = join(repo.root, TEAM_PROFILE_CONFIG_PATH);
    await mkdir(join(configAbsolute, ".."), { recursive: true });
    await writeFile(configAbsolute, committed);
    await run("git", ["add", "--all"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "team profile"], { cwd: repo.root });

    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    const result = await poiesis(repo.root, "update", "--config", teamConfig);
    expect(result.exitCode, result.stderr).toBe(0);

    // Adopted, never rewritten: the committed bytes are still the committed
    // bytes, and the skill lock the run still needed was created beside it.
    expect(await readFile(configAbsolute, "utf8")).toBe(committed);
    expect(await exists(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toBe(true);
    expect((await readManifest(repo.root)).mode).toBe("team");
  }, 120_000);

  it("refuses a committed shared profile that contradicts the resolved configuration, and writes nothing", async () => {
    const repo = await repository();
    await installFake();
    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);

    const configAbsolute = join(repo.root, TEAM_PROFILE_CONFIG_PATH);
    await mkdir(join(configAbsolute, ".."), { recursive: true });
    const committed = `${JSON.stringify(
      {
        ...policy("team"),
        models: { reasoning: "anthropic/claude-sonnet-4-5", execution: "minimax/MiniMax-M3" },
      },
      null,
      2,
    )}\n`;
    await writeFile(configAbsolute, committed);
    const before = await snapshotSharingState(repo.root);

    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    const result = await poiesis(repo.root, "update", "--config", teamConfig);
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("TEAM_PROFILE_CONFLICT");
    expect(errorDetails(result).source).toBe(TEAM_PROFILE_CONFIG_PATH);

    expectSharingStateUnchanged(before, await snapshotSharingState(repo.root));
    // The contradicting profile is untouched and no lock was fabricated.
    expect(await readFile(configAbsolute, "utf8")).toBe(committed);
    expect(await exists(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toBe(false);
  }, 120_000);

  it("refuses Team -> Private while the OpenCode config is tracked", async () => {
    const repo = await repository();
    await installFake();
    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    expect((await poiesis(repo.root, "init", "--config", teamConfig, "--allow-fixtures")).exitCode).toBe(0);

    // The team committed the config, so patching it would put a generated
    // private-mode projection into shared history.
    await run("git", ["add", "-f", "opencode.jsonc"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "share opencode config"], { cwd: repo.root });
    const before = await snapshotSharingState(repo.root);

    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    const result = await poiesis(repo.root, "update", "--config", privateConfig);
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("OPENCODE_CONFIG_TRACKED_REFUSED");
    expect(errorDetails(result).path).toBe("opencode.jsonc");

    expectSharingStateUnchanged(before, await snapshotSharingState(repo.root));
    expect((await readManifest(repo.root)).mode).toBe("team");
  }, 120_000);

  it("never broadly ignores, claims, or removes an Author's existing skills or OpenCode config", async () => {
    const repo = await repository();
    await installFake();
    const skillSnapshots = await writeAuthorSkills(repo.root);
    // An Author-owned OpenCode config that is EXACTLY compatible: it states
    // no reserved path Poiesis needs, so `init` adopts it through config
    // patches alone and records no whole-file ownership over it.
    //
    // Deliberately UNTRACKED. A tracked config is shared project content, and
    // a private installation refuses to patch one at all — which is the rule
    // the Team -> Private transition re-checks. Adoption therefore applies to
    // the ordinary local case, which is where the "patched but never owned"
    // distinction has to hold.
    const authorConfig = `{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "anthropic/claude-sonnet-4-5"\n}\n`;
    await writeFile(join(repo.root, "opencode.jsonc"), authorConfig);

    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    const installed = await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures");
    expect(installed.exitCode, installed.stderr).toBe(0);

    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    const result = await poiesis(repo.root, "update", "--config", teamConfig);
    expect(result.exitCode, result.stderr).toBe(0);

    const manifest = await readManifest(repo.root);
    const block = await readBlock(repo.root);
    // Every skill is recorded as the Author's own, so the policy names none of
    // them and neither Git nor Poiesis claims them.
    expect(manifest.skills.length).toBe(DEFAULT_SKILL_NAMES.length);
    expect(manifest.skills.every((skill) => skill.preexisting)).toBe(true);
    expect(block?.patterns).not.toContain(".agents/skills/");
    for (const name of DEFAULT_SKILL_NAMES) {
      const relative = `.agents/skills/${name}`;
      expect(await ignored(repo.root, relative), `${relative} must stay the Author's own`).toBe(false);
      expect(exists(join(repo.root, relative, "SKILL.md"))).toBe(true);
      expect(await readFile(join(repo.root, relative, "SKILL.md"))).toEqual(skillSnapshots.get(join(repo.root, relative))!);
    }
    // The Author's OpenCode config is patched-but-not-owned: still on disk with
    // the Author's own value intact, still not ignored, still not a `files`
    // record.
    expect(parseJsonc<{ model?: string }>(await readFile(join(repo.root, "opencode.jsonc"), "utf8"), "opencode.jsonc").model)
      .toBe("anthropic/claude-sonnet-4-5");
    expect(await ignored(repo.root, "opencode.jsonc")).toBe(false);
    expect(block?.patterns).not.toContain("opencode.jsonc");
    expect(manifest.files.map((file) => file.path)).not.toContain("opencode.jsonc");
    // One patched file, however many individual property patches it carries.
    expect([...new Set(manifest.configPatches.map((patch) => patch.file))]).toEqual(["opencode.jsonc"]);
  }, 120_000);

  it("fails closed, naming the path, on an edited / duplicated / malformed / relabelled block", async () => {
    const repo = await repository();
    await installFake();
    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);
    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    const gitignorePath = join(repo.root, ".gitignore");
    const pristine = await readFile(gitignorePath, "utf8");

    const attempt = async (mutate: (content: string) => string, code: string): Promise<void> => {
      const edited = mutate(pristine);
      await writeFile(gitignorePath, edited);
      const before = await snapshotSharingState(repo.root);
      const result = await poiesis(repo.root, "update", "--config", teamConfig);
      expect(result.exitCode, `${code} should not have succeeded: ${result.stdout}`).not.toBe(0);
      expect(errorCode(result)).toBe(code);
      expect(errorDetails(result).path, `${code} must name the offending path`).toBe(".gitignore");
      expectSharingStateUnchanged(before, await snapshotSharingState(repo.root));
      expect((await readManifest(repo.root)).mode).toBe("private");
      // Nothing Poiesis would have written for the new mode exists.
      expect(await exists(join(repo.root, TEAM_PROFILE_CONFIG_PATH))).toBe(false);
      expect(await exists(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toBe(false);
      await writeFile(gitignorePath, pristine);
    };

    await attempt(
      (content) => content.replace("# <<< poiesis-managed-ignore mode=private <<<\n", "my-own-rule/\n# <<< poiesis-managed-ignore mode=private <<<\n"),
      "INSTALL_MODE_BLOCK_EDITED",
    );
    await attempt((content) => `${content}\n${content}`, "GITIGNORE_BLOCK_DUPLICATE");
    await attempt((content) => content.replace("# <<< poiesis-managed-ignore mode=private <<<", "# poiesis-managed-ignore mode=private"), "GITIGNORE_BLOCK_MALFORMED");
    await attempt(
      (content) => content.split("mode=private").join("mode=team"),
      "INSTALL_MODE_BLOCK_LABEL_CONFLICT",
    );
  }, 180_000);

  it("fails closed on a symlinked .gitignore without following it", async () => {
    const repo = await repository();
    await installFake();
    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);
    const teamConfig = await writePolicy(repo, "team.jsonc", "team");

    const outside = join(repo.parent, "author-gitignore");
    await writeFile(outside, "author-own-rule/\n");
    const gitignorePath = join(repo.root, ".gitignore");
    await rm(gitignorePath);
    await symlink(outside, gitignorePath);

    const result = await poiesis(repo.root, "update", "--config", teamConfig);
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("INSTALL_PATH_CONFLICT");
    expect(errorDetails(result).path).toBe(".gitignore");
    // The link target is untouched, and the installation is still private.
    expect(await readFile(outside, "utf8")).toBe("author-own-rule/\n");
    expect((await readManifest(repo.root)).mode).toBe("private");
    expect(await exists(join(repo.root, TEAM_PROFILE_CONFIG_PATH))).toBe(false);
  }, 120_000);

  it("refuses a transition that would publish a non-portable profile and writes nothing", async () => {
    const repo = await repository();
    await installFake();
    // The install itself is private, so a machine-specific tracker path is
    // perfectly legal — until the Author asks to SHARE it.
    const privateConfig = await writePolicy(repo, "private.jsonc", "private", {
      tracker: { provider: "fixture", project: join(repo.fixtures, "tracker") },
    });
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);
    const before = await snapshotSharingState(repo.root);

    const teamConfig = await writePolicy(repo, "team.jsonc", "team", {
      tracker: { provider: "fixture", project: join(repo.fixtures, "tracker") },
    });
    const result = await poiesis(repo.root, "update", "--config", teamConfig);
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("TEAM_PROFILE_NOT_PORTABLE");
    const offenders = errorDetails(result).offenders as Array<{ path: string; reason: string }>;
    expect(offenders.map((offender) => offender.path)).toContain("tracker.project");

    expectSharingStateUnchanged(before, await snapshotSharingState(repo.root));
    expect(await exists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
  }, 120_000);

  it("rolls a failed transition back byte-for-byte, leaving no profile behind", async () => {
    const repo = await repository();
    await installFake();
    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);
    const before = await snapshotSharingState(repo.root);

    // The transition writes `.poiesis/config.jsonc`, `opencode.jsonc`, and the
    // relabelled block, THEN creates the shared profile — and only then runs
    // the doctor gate. Letting the transaction's own preflight `debug config`
    // call through and failing the gate's proves the rollback reverses every
    // one of those writes, including removing files the run created.
    const previous = fakes.splice(0);
    for (const fake of previous) fake.restore();
    const failing = await installFakeOpenCode({
      failAfterDebugCalls: { file: join(repo.parent, "transition-debug-count.txt"), threshold: 1 },
    });
    fakes.push(failing);

    const teamConfig = await writePolicy(repo, "team.jsonc", "team");
    const result = await poiesis(repo.root, "update", "--config", teamConfig);
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("UPDATE_DOCTOR_FAILED");

    expectSharingStateUnchanged(before, await snapshotSharingState(repo.root));
    // The shared profile the run created is gone, and so is the directory it
    // had to make to hold it: a failed transition leaves no trace.
    expect(await exists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
    expect((await readManifest(repo.root)).mode).toBe("private");

    // A clean retry on the same repository succeeds, so the rollback left a
    // usable installation rather than a half-transitioned one.
    for (const fake of fakes.splice(0)) fake.restore();
    fakes.push(await installFake());
    expect((await poiesis(repo.root, "update", "--config", teamConfig)).exitCode).toBe(0);
    expect((await readManifest(repo.root)).mode).toBe("team");
  }, 180_000);

  it("never drops the installed mode when an unrelated config update omits it", async () => {
    const repo = await repository();
    await installFake();
    const privateConfig = await writePolicy(repo, "private.jsonc", "private");
    expect((await poiesis(repo.root, "init", "--config", privateConfig, "--allow-fixtures")).exitCode).toBe(0);

    // The Author changes one model and says nothing about sharing. A mode is
    // chosen once, explicitly; it is not re-picked every time a config is
    // edited, and an absent mode is never an instruction to forget it.
    const { mode: _omitted, ...withoutMode } = policy("private");
    const candidate = join(repo.parent, "candidate.jsonc");
    await writeFile(
      candidate,
      `${JSON.stringify(
        { ...withoutMode, models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3-alt" } },
        null,
        2,
      )}\n`,
    );

    const result = await poiesis(repo.root, "update", "--config", candidate);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(parseJsonc<{ mode?: string }>(await readFile(join(repo.root, ".poiesis", "config.jsonc"), "utf8"), ".poiesis/config.jsonc").mode)
      .toBe("private");
    const manifest = await readManifest(repo.root);
    expect(manifest.mode).toBe("private");
    expect((await readBlock(repo.root))?.mode).toBe("private");
    expect(await exists(join(repo.root, TEAM_PROFILE_CONFIG_PATH))).toBe(false);
  }, 120_000);
});
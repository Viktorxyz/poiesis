/**
 * Spec #190 / ticket #192 — the TEAM/shared installation through the real
 * packaged CLI in real temporary Git repositories.
 *
 * Everything here drives `node <isolated package>/node_modules/.bin/poiesis`,
 * never `init()` imported from source, because every property under test is a
 * property of what a team ends up able to COMMIT and what a fresh clone ends
 * up able to DISCOVER. A source-level assertion could pass while the shipped
 * binary still published a generated mirror or refused to hydrate.
 *
 * The properties:
 *
 *   - the committed-file matrix: after a team install, the exact set of paths
 *     `git add --all` would stage is the ignore policy plus the shareable
 *     profile — nothing else;
 *   - every artifact class the ticket keeps out of Git is out of Git,
 *     proven from the manifest itself rather than a hand-written list;
 *   - the profile carries no machine path and no credential;
 *   - a fresh clone holding ONLY the shared profile hydrates every ignored
 *     local projection, in conflict with nothing;
 *   - ordinary `opencode` discovers the hydrated projections from standard
 *     project-relative files, with no launcher and no environment setup;
 *   - Author-created shared content (an instruction override, the profile
 *     itself) is projected, never claimed, and never deleted;
 *   - a non-portable or contradicting profile fails closed with nothing
 *     written.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import { parseJsonc } from "../src/config.js";
import {
  TEAM_PROFILE_CONFIG_PATH,
  TEAM_PROFILE_DIRECTORY,
  TEAM_PROFILE_OVERRIDES_DIRECTORY,
  TEAM_PROFILE_SKILLS_LOCK_PATH,
  classifyTeamArtifact,
} from "../src/team-profile.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
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

/**
 * The exact committed-file matrix: every path Git WOULD stage, honouring the
 * installed ignore policy. `git add --dry-run` is the honest question — it is
 * what a team member's next `git add -A` actually does — rather than a
 * hand-rolled reimplementation of ignore semantics.
 */
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

/** `true` when Git would ignore `path` under the installed policy. */
async function ignored(root: string, path: string): Promise<boolean> {
  const result = await run("git", ["check-ignore", "-q", "--", path], { cwd: root, allowFailure: true });
  return result.exitCode === 0;
}

function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * The portable team configuration used throughout this suite.
 *
 * Every value is deliberately project-relative: the shareable profile is
 * committed, so an absolute path here would be exactly the machine leakage
 * Spec #190 forbids (and is what `TEAM_PROFILE_NOT_PORTABLE` refuses). The
 * delivery policy points at the delivery scripts `init` regenerates in every
 * clone, which is precisely why it is shareable at all; the fixture tracker
 * keeps tracker verification offline without touching the filesystem.
 */
function teamConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const delivery = Object.fromEntries(
    ["preview", "staging", "production"].map((target) => [
      target,
      { adapter: "command", command: ["node", `scripts/poiesis-${target}.mjs`, target, "{sha}"] },
    ]),
  );
  return {
    schema: 1,
    mode: "team",
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: "poiesis-tracker-fixture" },
    delivery,
    verification: { commands: ["test -f README.md"] },
    ...overrides,
  };
}

async function writeConfig(
  repository: TestRepository,
  overrides: Record<string, unknown> = {},
  name = "team.jsonc",
): Promise<string> {
  const configPath = join(repository.parent, name);
  await writeFile(configPath, `${JSON.stringify(teamConfig(overrides), null, 2)}\n`);
  return configPath;
}

async function commitAll(repository: TestRepository, message: string): Promise<void> {
  await run("git", ["add", "--all"], { cwd: repository.root });
  await run("git", ["commit", "--quiet", "-m", message], { cwd: repository.root });
  await run("git", ["push", "--quiet", "origin", "main"], { cwd: repository.root });
}

/** Clone the repository into a sibling directory and configure it like a teammate. */
async function freshClone(repository: TestRepository): Promise<TestRepository> {
  const root = join(repository.parent, `clone-${Math.random().toString(36).slice(2)}`);
  await run("git", ["clone", "--quiet", repository.remote, root], { cwd: repository.parent });
  await run("git", ["config", "user.name", "Poiesis Test"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis@example.test"], { cwd: root });
  return {
    parent: repository.parent,
    root,
    remote: repository.remote,
    fixtures: repository.fixtures,
    baseSha: (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout,
  };
}

/** Every artifact path this installation actually owns, read from the manifest. */
async function installedArtifacts(root: string): Promise<{ files: string[]; scripts: string[]; skills: string[] }> {
  const manifest = json(await readFile(join(root, ".poiesis", "manifest.json"), "utf8")) as {
    files: Array<{ path: string }>;
    generatedScripts?: Array<{ path: string }>;
    skills: Array<{ path: string; preexisting: boolean }>;
  };
  return {
    files: manifest.files.map((file) => file.path),
    scripts: (manifest.generatedScripts ?? []).map((script) => script.path),
    skills: manifest.skills.filter((skill) => !skill.preexisting).map((skill) => skill.path),
  };
}

/** The shareable files a team is expected to commit, plus the visible policy. */
const EXPECTED_COMMITTED = [
  ".gitignore",
  TEAM_PROFILE_CONFIG_PATH,
  TEAM_PROFILE_SKILLS_LOCK_PATH,
].sort();

beforeAll(async () => {
  built = await buildIsolatedPackage(REPO_ROOT);
}, 180_000);

afterAll(async () => {
  if (built) await removeOwnedBuildRoot(built.ownedRoot);
  built = undefined;
});

describe("Spec #190 / ticket #192 - team install commits the profile and nothing else", () => {
  const repositories: TestRepository[] = [];

  const repository = async (): Promise<TestRepository> => {
    const created = await createTestRepository();
    repositories.push(created);
    return created;
  };

  afterAll(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("stages exactly the ignore policy plus the shareable profile", async () => {
    const repo = await repository();
    const configPath = await writeConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode, result.stderr).toBe(0);

    // The whole committed-file matrix, in one assertion.
    expect(await stageablePaths(repo.root)).toEqual(EXPECTED_COMMITTED);

    // Every artifact this installation owns is invisible to Git — derived
    // from the manifest, so a NEW artifact class cannot slip through an
    // assertion that only lists the classes someone remembered.
    const artifacts = await installedArtifacts(repo.root);
    expect(artifacts.files.length).toBeGreaterThan(0);
    for (const path of [...artifacts.files, ...artifacts.scripts, ...artifacts.skills]) {
      expect(await ignored(repo.root, path), `${path} must stay untracked`).toBe(true);
      expect(classifyTeamArtifact(path)).not.toBe("shared-source");
    }

    // Local state that is not a manifest record is ignored too.
    for (const path of [".poiesis/workspaces", ".poiesis/cache"]) {
      expect(await ignored(repo.root, path), `${path} must stay untracked`).toBe(true);
    }

    // And the shareable profile is explicitly NOT ignored.
    for (const path of [TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_SKILLS_LOCK_PATH, `${TEAM_PROFILE_DIRECTORY}/overrides/poiesis-worker.md`]) {
      expect(await ignored(repo.root, path), `${path} must be shareable`).toBe(false);
    }
  }, 120_000);

  it("records mode, provenance, and no durable ownership over the mirrors", async () => {
    const repo = await repository();
    const configPath = await writeConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);

    const manifest = json(await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8")) as {
      mode: string;
      files: Array<{ path: string; kind: string; provenance?: string; durable?: boolean }>;
    };
    expect(manifest.mode).toBe("team");
    // Nothing Poiesis installs is project-tracked: the mirrors are regenerated
    // from the package plus the profile, so `uninstall` must still own them.
    expect(manifest.files.filter((file) => file.durable === true)).toEqual([]);
    // The shareable profile is Author content, so the manifest never claims it.
    expect(manifest.files.filter((file) => file.path.startsWith(`${TEAM_PROFILE_DIRECTORY}/`))).toEqual([]);
    expect(manifest.files.find((file) => file.path === ".poiesis/METHOD.md")?.provenance).toBe("package");
    expect(manifest.files.find((file) => file.path === ".opencode/agents/poiesis.md")?.provenance).toBe("projection");

    const doctor = await poiesis(repo.root, "doctor");
    expect(doctor.exitCode, doctor.stderr).toBe(0);
    const checks = (json(doctor.stdout).result as { checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> })
      .checks;
    const mode = checks.find((check) => check.id === "install-mode");
    expect(mode?.status).toBe("pass");
    expect((mode?.details as { mode: string }).mode).toBe("team");
    // Spec user story 9: doctor reports what is shared and what is local.
    const profile = checks.find((check) => check.id === "team-profile");
    expect(profile?.details).toMatchObject({
      directory: TEAM_PROFILE_DIRECTORY,
      config: TEAM_PROFILE_CONFIG_PATH,
      skillsLock: TEAM_PROFILE_SKILLS_LOCK_PATH,
      overrides: [],
    });
    expect((profile?.details as { installedMirrors: string[] }).installedMirrors.length).toBeGreaterThan(0);
  }, 120_000);

  it("commits only portable policy: no machine path, no credential, no local mirror", async () => {
    const repo = await repository();
    const configPath = await writeConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);

    const profileText = await readFile(join(repo.root, TEAM_PROFILE_CONFIG_PATH), "utf8");
    // No absolute path anywhere in the committed profile.
    expect(profileText).not.toMatch(/(?:^|[\s"])(?:\/(?:home|Users|tmp|var|opt)\/|[A-Za-z]:\\\\)/);
    expect(profileText).not.toContain(repo.parent);
    const profile = parseJsonc<Record<string, unknown>>(profileText, TEAM_PROFILE_CONFIG_PATH);
    expect(profile.mode).toBe("team");
    // Model choices and the safe policy are what the team actually shares.
    expect(profile.models).toEqual({ reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" });
    expect(profile.verification).toEqual({ commands: ["test -f README.md"] });

    // The lock carries source, locked revision, and integrity per selected skill.
    const lock = json(await readFile(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8")) as {
      schema: number;
      skills: Array<{ name: string; source: string; revision: string; integrity: string }>;
    };
    expect(lock.schema).toBe(1);
    expect(lock.skills.length).toBeGreaterThan(0);
    for (const skill of lock.skills) {
      expect(skill.source.length).toBeGreaterThan(0);
      expect(skill.revision.length).toBeGreaterThan(0);
      expect(skill.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    // The block states the profile omission rather than leaving it implied.
    const gitignore = await readFile(join(repo.root, ".gitignore"), "utf8");
    expect(gitignore.split("\n").filter((line) => line === "# >>> poiesis-managed-ignore mode=team >>>")).toHaveLength(1);
    expect(gitignore).toContain(`${TEAM_PROFILE_DIRECTORY}/`);
    expect(gitignore).toContain("does NOT ignore");
  }, 120_000);

  it("refuses to publish a non-portable profile and writes nothing", async () => {
    const repo = await repository();
    // A machine-specific absolute path is exactly what must never be
    // committed on the Author's behalf.
    const configPath = await writeConfig(repo, {
      tracker: { provider: "fixture", project: join(repo.fixtures, "tracker") },
    });
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("TEAM_PROFILE_NOT_PORTABLE");
    expect(await exists(join(repo.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
    expect(await stageablePaths(repo.root)).toEqual([]);
  }, 120_000);

  /**
   * Review B2: an absolute path is a leak wherever it appears in a command,
   * not only when the string STARTS with one. The anchoring bug was invisible
   * for a whole value-shaped field and fatal for the argv and shell fields a
   * real delivery/verification policy actually uses.
   *
   * Every case here is zero-write: the refusal must land while the repository
   * is still untouched.
   */
  const MID_STRING_LEAKS: ReadonlyArray<{ label: string; overrides: Record<string, unknown> }> = [
    {
      label: "a POSIX absolute path as a delivery command token",
      overrides: {
        delivery: {
          preview: { adapter: "command", command: ["node", "/home/alice/bin/deploy.mjs", "preview", "{sha}"] },
          staging: { adapter: "command", command: ["node", "scripts/poiesis-staging.mjs", "staging", "{sha}"] },
          production: { adapter: "command", command: ["node", "scripts/poiesis-production.mjs", "production", "{sha}"] },
        },
      },
    },
    {
      label: "a POSIX absolute path mid-shell-string in a verification command",
      overrides: { verification: { commands: ["cd /home/alice/project && pnpm check"] } },
    },
    {
      label: "a Windows drive-absolute path as a delivery command token",
      overrides: {
        delivery: {
          preview: { adapter: "command", command: ["node", "C:\\Users\\alice\\deploy.mjs", "preview", "{sha}"] },
          staging: { adapter: "command", command: ["node", "scripts/poiesis-staging.mjs", "staging", "{sha}"] },
          production: { adapter: "command", command: ["node", "scripts/poiesis-production.mjs", "production", "{sha}"] },
        },
      },
    },
    {
      label: "a Windows UNC path in a verification command",
      overrides: { verification: { commands: ["\\\\build-server\\share\\check.ps1"] } },
    },
    {
      label: "a home-relative path in a verification command",
      overrides: { verification: { commands: ["~/bin/check"] } },
    },
    {
      label: "an absolute path attached to a flag in a delivery command",
      overrides: {
        delivery: {
          preview: { adapter: "command", command: ["deploy", "--config=/home/alice/deploy.json", "{sha}"] },
          staging: { adapter: "command", command: ["node", "scripts/poiesis-staging.mjs", "staging", "{sha}"] },
          production: { adapter: "command", command: ["node", "scripts/poiesis-production.mjs", "production", "{sha}"] },
        },
      },
    },
  ];

  it.each(MID_STRING_LEAKS)("refuses $label without writing anything", async ({ overrides }) => {
    const repo = await repository();
    const configPath = await writeConfig(repo, overrides);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode, result.stdout).not.toBe(0);
    expect(errorCode(result)).toBe("TEAM_PROFILE_NOT_PORTABLE");
    expect(await exists(join(repo.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
    expect(await stageablePaths(repo.root)).toEqual([]);
  }, 120_000);

  /**
   * Review B2a: a shell metacharacter binds TIGHTER than whitespace, so the
   * path token can sit mid-string with no character at all between the
   * metacharacter and the path. A boundary set made only of whitespace and
   * ASCII punctuation leaves every one of those a one-character blind spot —
   * the same class of bug as string anchoring, which this rule exists to fix.
   *
   * Zero-write, exactly like the matrix above: the refusal must land while the
   * repository is still untouched.
   */
  const METACHARACTER_BOUNDARY_LEAKS: ReadonlyArray<{ label: string; overrides: Record<string, unknown> }> = [
    {
      label: "a POSIX path behind a stderr redirection in a verification command",
      overrides: { verification: { commands: ["pnpm test 2>/home/alice/logs/t.log"] } },
    },
    {
      label: "a POSIX path behind a stdout redirection in a verification command",
      overrides: { verification: { commands: ["pnpm build >/home/alice/artifacts/out.txt"] } },
    },
    {
      label: "a POSIX path behind an input redirection in a verification command",
      overrides: { verification: { commands: ["sort </home/alice/names.txt"] } },
    },
    {
      label: "a POSIX absolute binary in command substitution in a verification command",
      overrides: { verification: { commands: ["diff <(cat README.md) <(`/home/alice/bin/render.sh`)"] } },
    },
    {
      label: "a POSIX path inside a brace expansion in a verification command",
      overrides: { verification: { commands: ["rsync -a src/ {/home/alice/stage}"] } },
    },
    {
      label: "a POSIX path as a later member of a brace list in a verification command",
      overrides: { verification: { commands: ["ls -d {,/home/alice/bin}"] } },
    },
    {
      label: "a POSIX path attached to a closing brace in a verification command",
      overrides: { verification: { commands: ["echo ok >{/home/alice/out}/done.txt"] } },
    },
  ];

  it.each(METACHARACTER_BOUNDARY_LEAKS)("refuses $label without writing anything", async ({ overrides }) => {
    const repo = await repository();
    const configPath = await writeConfig(repo, overrides);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode, result.stdout).not.toBe(0);
    expect(errorCode(result)).toBe("TEAM_PROFILE_NOT_PORTABLE");
    expect(await exists(join(repo.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
    expect(await stageablePaths(repo.root)).toEqual([]);
  }, 120_000);

  it("accepts the shapes that legitimately contain a slash", async () => {
    // Review B2a's other half. Widening the boundary set with shell
    // metacharacters must not swallow portable shell: relative redirection
    // targets and process substitution are exactly the constructs that put a
    // metacharacter adjacent to an argument, and none of them is a machine
    // path. A rule coarse enough to refuse these is the same failure mode in
    // the opposite direction.
    const repo = await repository();
    const configPath = await writeConfig(repo, {
      // Both model ids are `<provider>/<model>`, and the execution id is the
      // deeper, multi-segment shape that a naive "contains a slash" rule
      // would have refused.
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3-alt" },
      verification: {
        commands: [
          "pnpm check",
          "git ls-remote https://example.test/o/r.git",
          "git clone git+ssh://git@example.test/o/r.git ./vendor-r",
          "echo done > out.txt",
          "cmp <(printf a) <(printf b)",
          "ls -d {src,test}",
        ],
      },
    });
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode, result.stderr).toBe(0);
    const profileText = await readFile(join(repo.root, TEAM_PROFILE_CONFIG_PATH), "utf8");
    expect(profileText).toContain("openai/gpt-5.6-sol");
    expect(profileText).toContain("minimax/MiniMax-M3-alt");
    expect(profileText).toContain("https://example.test/o/r.git");
    expect(profileText).toContain("git+ssh://git@example.test/o/r.git");
    expect(profileText).toContain("echo done > out.txt");
    expect(profileText).toContain("cmp <(printf a) <(printf b)");
    expect(profileText).toContain("ls -d {src,test}");
  }, 120_000);
});

describe("Spec #190 / ticket #192 - a fresh clone hydrates from the shared profile alone", () => {
  const repositories: TestRepository[] = [];

  const repository = async (): Promise<TestRepository> => {
    const created = await createTestRepository();
    repositories.push(created);
    return created;
  };

  afterAll(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  /**
   * One team installation, committed and published. Every clone test starts
   * from this exact shared state — a repository whose only Poiesis files are
   * the ones a teammate would receive.
   */
  async function publishedTeam(): Promise<{ author: TestRepository; clones: TestRepository[] }> {
    const author = await repository();
    // A project-created instruction override: Author content that must be
    // shared, projected, and never claimed as disposable output.
    await mkdir(join(author.root, TEAM_PROFILE_OVERRIDES_DIRECTORY), { recursive: true });
    await writeFile(
      join(author.root, TEAM_PROFILE_OVERRIDES_DIRECTORY, "poiesis-worker.md"),
      "---\ndescription: project's worker\n---\n\nProject instruction override.\n",
    );
    const configPath = await writeConfig(author);
    const result = await poiesis(author.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode, result.stderr).toBe(0);
    await commitAll(author, "team: share the Poiesis profile");
    return { author, clones: [] };
  }

  it("hydrates every ignored local projection with nothing but the shared profile", async () => {
    const { author } = await publishedTeam();
    const clone = await freshClone(author);

    // The clone really does contain ONLY shared files before hydration.
    expect(await exists(join(clone.root, ".poiesis"))).toBe(false);
    expect(await exists(join(clone.root, ".opencode", "agents"))).toBe(false);
    expect(await exists(join(clone.root, "opencode.jsonc"))).toBe(false);
    expect(await exists(join(clone.root, "scripts"))).toBe(false);
    expect(await exists(join(clone.root, TEAM_PROFILE_CONFIG_PATH))).toBe(true);
    expect(await exists(join(clone.root, ".gitignore"))).toBe(true);

    // Hydration is ordinary `poiesis init` against the committed profile.
    // No launcher, no environment variable, no `.git/info/exclude`.
    const profileBefore = await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8");
    const lockBefore = await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8");
    const overrideBefore = await readFile(join(clone.root, TEAM_PROFILE_OVERRIDES_DIRECTORY, "poiesis-worker.md"), "utf8");
    // Hydration never reaches into Git's private exclude file.
    const excludeBefore = await readFile(join(clone.root, ".git", "info", "exclude"), "utf8");

    const result = await poiesis(
      clone.root,
      "init",
      "--config",
      join(clone.root, TEAM_PROFILE_CONFIG_PATH),
      "--allow-fixtures",
    );
    expect(result.exitCode, result.stderr).toBe(0);

    // The committed shared profile was ADOPTED, not rewritten.
    expect(await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8")).toBe(profileBefore);
    expect(await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8")).toBe(lockBefore);

    // Every local projection the Author's machine had now exists here too.
    const artifacts = await installedArtifacts(clone.root);
    for (const path of [...artifacts.files, ...artifacts.scripts, ...artifacts.skills]) {
      expect(await exists(join(clone.root, path)), `${path} must be hydrated`).toBe(true);
      expect(await ignored(clone.root, path), `${path} must stay untracked`).toBe(true);
    }
    expect(await exists(join(clone.root, ".poiesis", "manifest.json"))).toBe(true);

    // The cloned `.gitignore` already carried the team's block, so hydration
    // reconciled it in place rather than treating it as an installation
    // conflict — and the clone still stages nothing new.
    const gitignore = await readFile(join(clone.root, ".gitignore"), "utf8");
    expect(gitignore.split("\n").filter((line) => line === "# >>> poiesis-managed-ignore mode=team >>>")).toHaveLength(1);
    expect(await stageablePaths(clone.root)).toEqual([]);

    // No hidden activation mechanism and no project-script mutation: Poiesis
    // touches neither Git's private exclude file nor the project manifest.
    expect(await readFile(join(clone.root, ".git", "info", "exclude"), "utf8")).toBe(excludeBefore);
    expect(await exists(join(clone.root, "package.json"))).toBe(false);
  }, 180_000);

  it("keeps ordinary OpenCode discovery working from the hydrated projections", async () => {
    const { author } = await publishedTeam();
    const clone = await freshClone(author);
    const result = await poiesis(
      clone.root,
      "init",
      "--config",
      join(clone.root, TEAM_PROFILE_CONFIG_PATH),
      "--allow-fixtures",
    );
    expect(result.exitCode, result.stderr).toBe(0);

    // Standard project-relative discovery: no launcher, no env var.
    const agents = join(clone.root, ".opencode", "agents");
    for (const name of [
      "poiesis.md",
      "poiesis-planner.md",
      "poiesis-worker.md",
      "poiesis-research.md",
      "poiesis-reviewer.md",
      "poiesis-final-reviewer.md",
    ]) {
      expect(await exists(join(agents, name)), `${name} must be discoverable on disk`).toBe(true);
    }
    const projectConfig = parseJsonc<{ default_agent?: string; agent?: Record<string, unknown> }>(
      await readFile(join(clone.root, "opencode.jsonc"), "utf8"),
      "opencode.jsonc",
    );
    expect(projectConfig.default_agent).toBe("poiesis");
    expect(Object.keys(projectConfig.agent ?? {})).toContain("poiesis");

    // The project's own instruction override really reached the projection:
    // shared source, applied to the generated mirror, and still untracked.
    expect(await readFile(join(agents, "poiesis-worker.md"), "utf8")).toContain("Project instruction override.");
    expect(await ignored(clone.root, ".opencode/agents/poiesis-worker.md")).toBe(true);
    expect(await ignored(clone.root, TEAM_PROFILE_OVERRIDES_DIRECTORY + "/poiesis-worker.md")).toBe(false);
  }, 180_000);

  it("refuses to hydrate from a configuration the committed profile contradicts", async () => {
    const { author } = await publishedTeam();
    const clone = await freshClone(author);
    const before = await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8");

    // A teammate's local config that disagrees with the team's committed
    // intelligence. Hydrating local projections from it would leave the team
    // silently disagreeing with itself.
    const localConfigPath = join(clone.parent, "disagreeing.jsonc");
    await writeFile(
      localConfigPath,
      `${JSON.stringify(teamConfig({ models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3-alt" } }), null, 2)}\n`,
    );
    const result = await poiesis(clone.root, "init", "--config", localConfigPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("TEAM_PROFILE_CONFLICT");
    // Fail closed before any write: committed project intelligence and the
    // clone's working tree are exactly as they were.
    expect(await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8")).toBe(before);
    expect(await exists(join(clone.root, ".poiesis"))).toBe(false);
    expect(await exists(join(clone.root, ".opencode", "agents"))).toBe(false);
    expect(await exists(join(clone.root, ".gitignore"))).toBe(true);
  }, 180_000);

  it("hydrates when the committed skill lock disagrees with this machine, and reports the drift", async () => {
    // Review B1. The lock records what the TEAM agreed on, so a teammate on a
    // newer package legitimately resolves different revisions and digests for
    // the same skills. That is team state to report, not an installation
    // contradiction: refusing hydration made `doctor`'s drift warning
    // unreachable and turned an informational check into a blocker.
    const { author } = await publishedTeam();

    // The team's committed lock names a revision and integrity this machine
    // does not have, plus one skill the machine never installed at all.
    const lock = json(await readFile(join(author.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8")) as {
      schema: number;
      skills: Array<{ name: string; source: string; revision: string; integrity: string }>;
    };
    const drifted = {
      schema: lock.schema,
      skills: [
        {
          name: lock.skills[0]!.name,
          source: lock.skills[0]!.source,
          revision: "0f1e2d3c4b5a69788796a5b4c3d2e1f0fedcba98",
          integrity: `sha256:${"d".repeat(64)}`,
        },
        ...lock.skills.slice(1),
        { name: "team-only-skill", source: "example/skills", revision: "1111111111", integrity: `sha256:${"e".repeat(64)}` },
      ],
    };
    const driftedText = `${JSON.stringify(drifted, null, 2)}\n`;
    await writeFile(join(author.root, TEAM_PROFILE_SKILLS_LOCK_PATH), driftedText);
    await commitAll(author, "team: pin a different skill revision");

    const clone = await freshClone(author);
    const committedLock = await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8");
    expect(committedLock).toBe(driftedText);

    // Hydration SUCCEEDS despite the drift.
    const result = await poiesis(
      clone.root,
      "init",
      "--config",
      join(clone.root, TEAM_PROFILE_CONFIG_PATH),
      "--allow-fixtures",
    );
    expect(result.exitCode, result.stderr).toBe(0);

    // The committed lock survives byte-for-byte: drift is reported, never
    // repaired, because rewriting it would destroy the team's selection.
    expect(await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8")).toBe(committedLock);
    expect(await exists(join(clone.root, ".poiesis", "manifest.json"))).toBe(true);
    expect(await ignored(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH)).toBe(false);

    // `doctor` reports the drift as a warning, naming both skills.
    const doctor = await poiesis(clone.root, "doctor");
    expect(doctor.exitCode, doctor.stderr).toBe(0);
    const checks = (
      json(doctor.stdout).result as { checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> }
    ).checks;
    const profile = checks.find((check) => check.id === "team-profile");
    expect(profile?.status).toBe("warn");
    const drift = (profile?.details as { skillLockDrift: Array<{ name: string }> }).skillLockDrift;
    expect(drift.map((entry) => entry.name).sort()).toEqual([lock.skills[0]!.name, "team-only-skill"].sort());
  }, 180_000);

  it("hydrates from a hand-formatted shared profile and leaves every committed byte alone", async () => {
    // Review B2b. `config.jsonc` is hand-editable JSONC, so a comment,
    // reordered keys, four-space indent, or a trailing comma are all LEGAL
    // differences. Adoption decides on PARSED SEMANTICS — which
    // `assertTeamProfileAdoptable` already proved before the transaction
    // opened — and the transaction's own re-check compares against the digest
    // it observed at entry. Byte-comparing committed JSONC to a
    // reserialization refused every hand-formatted profile and made the
    // semantic check unreachable.
    const { author } = await publishedTeam();

    // Reformatted FROM the machine-rendered profile, so semantic equality is
    // exact by construction and the only variable under test is the BYTES.
    const rendered = await readFile(join(author.root, TEAM_PROFILE_CONFIG_PATH), "utf8");
    const parsed = parseJsonc<Record<string, unknown>>(rendered, TEAM_PROFILE_CONFIG_PATH);
    const reordered: Record<string, unknown> = {
      mode: parsed.mode,
      schema: parsed.schema,
      verification: parsed.verification,
      delivery: parsed.delivery,
      models: parsed.models,
      tracker: parsed.tracker,
      repository: parsed.repository,
    };
    const lines = JSON.stringify(reordered, null, 4).split("\n");
    const closingBrace = lines.pop()!;
    lines[lines.length - 1] = `${lines[lines.length - 1]},`;
    const handFormatted = [
      "// Team Poiesis profile.",
      "// Hand-edited by the team. Comments, reordered keys, four-space indent,",
      "// and a trailing comma are all legal JSONC and must never read as a conflict.",
      ...lines,
      closingBrace,
      "",
    ].join("\n");
    // The premise: what is committed is NOT the machine rendering.
    expect(handFormatted).not.toBe(rendered);
    expect(handFormatted).toContain("// Team Poiesis profile.");
    expect(handFormatted).toContain(",\n}");
    await writeFile(join(author.root, TEAM_PROFILE_CONFIG_PATH), handFormatted);
    await commitAll(author, "team: hand-format the shared profile");

    const clone = await freshClone(author);
    expect(await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8")).toBe(handFormatted);

    // Hydration SUCCEEDS. The semantic precondition still holds — this
    // profile states exactly what the clone resolves — and nothing about the
    // formatting reaches that decision.
    const result = await poiesis(
      clone.root,
      "init",
      "--config",
      join(clone.root, TEAM_PROFILE_CONFIG_PATH),
      "--allow-fixtures",
    );
    expect(result.exitCode, result.stderr).toBe(0);

    // Hand-edited Author content is adopted, never rewritten: bytes, comments,
    // key order, indent, and trailing comma all survive byte-for-byte.
    expect(await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8")).toBe(handFormatted);
    expect(await ignored(clone.root, TEAM_PROFILE_CONFIG_PATH)).toBe(false);
    const lockAfter = await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8");
    expect(await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8")).toBe(lockAfter);
    // ...and hydration really happened: the local projections exist.
    expect(await exists(join(clone.root, ".poiesis", "manifest.json"))).toBe(true);
    expect(await exists(join(clone.root, ".opencode", "agents", "poiesis-worker.md"))).toBe(true);
  }, 180_000);

  it("uninstall removes the local mirrors and preserves the shared profile", async () => {
    const { author } = await publishedTeam();
    const clone = await freshClone(author);
    expect(
      (
        await poiesis(clone.root, "init", "--config", join(clone.root, TEAM_PROFILE_CONFIG_PATH), "--allow-fixtures")
      ).exitCode,
    ).toBe(0);

    const profileBefore = await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8");
    const lockBefore = await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8");
    const overrideBefore = await readFile(join(clone.root, TEAM_PROFILE_OVERRIDES_DIRECTORY, "poiesis-worker.md"), "utf8");
    const excludeBefore = await readFile(join(clone.root, ".git", "info", "exclude"), "utf8");

    const uninstall = await poiesis(clone.root, "uninstall");
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    const uninstalled = json(uninstall.stdout).result as { complete: boolean; removed: string[] };
    expect(uninstalled.complete).toBe(true);

    // Local mirrors are gone...
    expect(uninstalled.removed).toContain(".poiesis/METHOD.md");
    expect(uninstalled.removed).toContain(".opencode/agents/poiesis.md");
    expect(await exists(join(clone.root, ".poiesis", "manifest.json"))).toBe(false);
    // ...and the project's shared intelligence survives byte-for-byte, with
    // the policy that hid the mirrors reversed like any other installation.
    expect(await readFile(join(clone.root, TEAM_PROFILE_CONFIG_PATH), "utf8")).toBe(profileBefore);
    expect(await readFile(join(clone.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8")).toBe(lockBefore);
    expect(await readFile(join(clone.root, TEAM_PROFILE_OVERRIDES_DIRECTORY, "poiesis-worker.md"), "utf8")).toBe(
      overrideBefore,
    );
    // The clone's `.gitignore` was COMMITTED by the team, so uninstall
    // reverses exactly the Poiesis block out of it and leaves the file the
    // team published.
    const gitignore = await readFile(join(clone.root, ".gitignore"), "utf8");
    expect(gitignore).not.toContain("poiesis-managed-ignore");
    expect(await readFile(join(clone.root, ".git", "info", "exclude"), "utf8")).toBe(excludeBefore);
  }, 180_000);
});

describe("Spec #190 / ticket #192 - the sharing classification matrix", () => {
  /**
   * The regression matrix. Every artifact class Poiesis can produce is named
   * with its expected class, so a NEW class that is neither listed nor
   * covered fails here rather than becoming trackable by omission.
   *
   * `shared-source` is asserted for the profile and for nothing else: that is
   * the whole sharing policy in one table.
   */
  const MATRIX: ReadonlyArray<readonly [string, string]> = [
    [TEAM_PROFILE_CONFIG_PATH, "shared-source"],
    [TEAM_PROFILE_SKILLS_LOCK_PATH, "shared-source"],
    [`${TEAM_PROFILE_DIRECTORY}/overrides/poiesis-worker.md`, "shared-source"],
    // Package-supplied canon and the local resolved config are mirrors.
    [".poiesis/PHILOSOPHY.md", "local-mirror"],
    [".poiesis/METHOD.md", "local-mirror"],
    [".poiesis/roles/poiesis.md", "local-mirror"],
    [".poiesis/config.jsonc", "local-mirror"],
    // Generated OpenCode projections and config.
    [".opencode/agents/poiesis.md", "local-mirror"],
    ["opencode.jsonc", "local-mirror"],
    ["scripts/poiesis-preview.mjs", "local-mirror"],
    [".agents/skills/diagnosing-bugs", "local-mirror"],
    // Machine-local state.
    [".poiesis/manifest.json", "local-state"],
    [".poiesis/receipt.json", "local-state"],
    [".poiesis/cache/repository-intelligence", "local-state"],
    [".poiesis/workspaces/190-demo", "local-state"],
    [".poiesis/runtime/delivery", "local-state"],
    [".poiesis/tmp", "local-state"],
  ];

  it.each(MATRIX)("classifies %s as %s", (path, expected) => {
    expect(classifyTeamArtifact(path)).toBe(expected);
  });

  it("treats the profile directory itself as shareable and nothing else as such", () => {
    expect(classifyTeamArtifact(TEAM_PROFILE_DIRECTORY)).toBe("shared-source");
    // A sibling under the same OpenCode root is the Author's own content.
    expect(classifyTeamArtifact(".opencode/agents/my-agent.md")).toBe("local-mirror");
    expect(classifyTeamArtifact(".opencode/poiesis-extra.md")).not.toBe("shared-source");
  });
});
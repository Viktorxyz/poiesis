/**
 * Spec #190 / ticket #191 — a PRIVATE/local Poiesis installation through
 * the real packaged CLI in a real temporary Git repository.
 *
 * Everything here drives `node <packageRoot>/node_modules/.bin/poiesis`,
 * not `init()` imported from source. That distinction is the whole point:
 * the properties under test are properties of what an Author ends up with
 * on disk and in `git status`, and a source-level helper could satisfy an
 * internal assertion while the shipped binary still leaked files, touched
 * `package.json`, or wrote an unreversible `.gitignore`.
 *
 * The properties:
 *
 *   - `git status` after a private install shows EXACTLY ONE thing: the
 *     marked `.gitignore` block's file. Nothing else Poiesis owns is
 *     visible to Git.
 *   - `package.json` is byte-identical to what the Author had. Poiesis
 *     installs no project script.
 *   - Ordinary OpenCode discovery still works: the projections sit at the
 *     normal project-relative paths, so `opencode` finds them with no
 *     launcher and no environment setup.
 *   - The ignore block is uniquely delimited, mode-labelled, and
 *     idempotent — a reinstall after uninstall reproduces it exactly.
 *   - Malformed / duplicate / symlinked paths fail closed and leave the
 *     Author's own bytes untouched.
 *   - A post-write failure rolls the block back byte-for-byte, including
 *     the case where `.gitignore` did not exist before.
 *   - `uninstall` removes unchanged owned artifacts and the exact
 *     unchanged block, and preserves + reports a block the Author edited.
 */
import { lstat, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import { parseJsonc } from "../src/config.js";
import { ownershipReceiptExists } from "../src/receipt.js";
import { parseManagedIgnoreBlocks } from "../src/install-mode.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import {
  buildIsolatedPackage,
  removeOwnedBuildRoot,
  type IsolatedPackageBuild,
} from "./isolated-package-build.js";

const REPO_ROOT = join(import.meta.dirname, "..");

/** The one file Git is allowed to see after a private installation. */
const VISIBLE_AFTER_PRIVATE_INIT = [".gitignore"];

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

/** The typed error code a failed CLI invocation reported on stderr. */
function errorCode(result: CliResult): string {
  return (json(result.stderr).error as { code: string }).code;
}

async function gitStatus(root: string): Promise<string[]> {
  const result = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^.. /, ""));
}

function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * The Author-owned `package.json` an ordinary project has, including a
 * script of their own. Poiesis must return it byte-for-byte.
 */
const AUTHOR_PACKAGE_JSON = `{
  "name": "author-project",
  "version": "0.1.0",
  "scripts": {
    "build": "tsc",
    "test": "node --test"
  }
}
`;

async function writeAuthorProject(repository: TestRepository): Promise<void> {
  await writeFile(join(repository.root, "package.json"), AUTHOR_PACKAGE_JSON);
  // A real project has its own manifest tracked; an untracked one would be
  // visible to Git for reasons that have nothing to do with Poiesis.
  await run("git", ["add", "package.json"], { cwd: repository.root });
  await run("git", ["commit", "--quiet", "-m", "author manifest"], { cwd: repository.root });
}

/** A `--config` file for a private, fixture-adapter installation. */
async function writeInstallConfig(repository: TestRepository, overrides: Record<string, unknown> = {}): Promise<string> {
  const configPath = join(repository.parent, `poiesis-install-${Math.random().toString(36).slice(2)}.jsonc`);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schema: 1,
        mode: "private",
        models: {
          reasoning: "openai/gpt-5.6-sol",
          execution: "minimax/MiniMax-M3",
        },
        repository: { remote: "origin", integrationBranch: "main" },
        tracker: { provider: "fixture", project: join(repository.fixtures, "tracker") },
        delivery: {
          preview: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
          staging: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
          production: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
        },
        verification: { commands: ["test -f README.md"] },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

function blockStart(mode: string): string {
  return `# >>> poiesis-managed-ignore mode=${mode} >>>`;
}

function blockEnd(mode: string): string {
  return `# <<< poiesis-managed-ignore mode=${mode} <<<`;
}

beforeAll(async () => {
  built = await buildIsolatedPackage(REPO_ROOT);
}, 120_000);

afterAll(async () => {
  if (built) await removeOwnedBuildRoot(built.ownedRoot);
  built = undefined;
});

describe("Spec #190 / ticket #191 - private installation through the packaged CLI", () => {
  const repositories: TestRepository[] = [];
  let fake: FakeOpenCodeEnvironment | undefined;

  const repository = async (): Promise<TestRepository> => {
    const created = await createTestRepository();
    repositories.push(created);
    return created;
  };

  afterAll(async () => {
    fake?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("leaves only the marked .gitignore block visible to Git and never touches package.json", async () => {
    const repo = await repository();
    await writeAuthorProject(repo);
    const packageJsonBefore = await readFile(join(repo.root, "package.json"));

    const configPath = await writeInstallConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode, result.stderr).toBe(0);

    // The single visible surface, and nothing else.
    expect(await gitStatus(repo.root)).toEqual(VISIBLE_AFTER_PRIVATE_INIT);

    // package.json is exactly what the Author wrote.
    expect(await readFile(join(repo.root, "package.json"))).toEqual(packageJsonBefore);
    const installed = json(await readFile(join(repo.root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(installed.scripts).not.toHaveProperty("poiesis");

    // The visible file really is the policy, and it is ONE block.
    const gitignore = await readFile(join(repo.root, ".gitignore"), "utf8");
    expect(gitignore.split("\n").filter((line) => line === blockStart("private"))).toHaveLength(1);
    expect(gitignore.split("\n").filter((line) => line === blockEnd("private"))).toHaveLength(1);
    expect(gitignore).toContain(".poiesis/");
    expect(gitignore).toContain(".opencode/agents/poiesis.md");
    // The canonical artifacts really are on disk — hidden, not absent.
    expect(await exists(join(repo.root, ".poiesis", "METHOD.md"))).toBe(true);
    expect(await exists(join(repo.root, ".poiesis", "manifest.json"))).toBe(true);
    expect(await exists(join(repo.root, "scripts", "poiesis-preview.mjs"))).toBe(true);
  }, 90_000);

  it("keeps ordinary OpenCode discovery working from standard project-relative paths", async () => {
    const repo = await repository();
    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);

    // No launcher, no env var, no Git-common root: the projections are at
    // the paths OpenCode already scans in the project directory.
    const agents = join(repo.root, ".opencode", "agents");
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
      await readFile(join(repo.root, "opencode.jsonc"), "utf8"),
      "opencode.jsonc",
    );
    expect(projectConfig.default_agent).toBe("poiesis");
    expect(Object.keys(projectConfig.agent ?? {})).toContain("poiesis");

    // And Git still sees only the policy file.
    expect(await gitStatus(repo.root)).toEqual(VISIBLE_AFTER_PRIVATE_INIT);
  }, 90_000);

  it("requires an explicit mode for a non-interactive init", async () => {
    const repo = await repository();
    const configPath = await writeInstallConfig(repo, { mode: undefined });
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("INVALID_INSTALL_MODE");
    // Fail closed BEFORE touching the repository.
    expect(await exists(join(repo.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
  }, 90_000);

  it("records the mode, provenance, digests, and exact ignore-block ownership in the manifest", async () => {
    const repo = await repository();
    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);

    const manifest = json(await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8")) as {
      mode: string;
      files: Array<{ path: string; kind: string; hash: string; provenance?: string }>;
      configPatches: unknown[];
      ignoreBlock: { path: string; mode: string; hash: string; patterns: string[]; fileCreated: boolean; owned: boolean };
    };
    expect(manifest.mode).toBe("private");
    expect(manifest.ignoreBlock.path).toBe(".gitignore");
    expect(manifest.ignoreBlock.mode).toBe("private");
    expect(manifest.ignoreBlock.owned).toBe(true);
    expect(manifest.ignoreBlock.fileCreated).toBe(true);
    expect(manifest.ignoreBlock.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.ignoreBlock.patterns).toContain(".poiesis/");
    // Artifact class, provenance, and digest are all recorded, and the
    // reversible bounded patches are still there.
    const method = manifest.files.find((file) => file.path === ".poiesis/METHOD.md");
    expect(method?.kind).toBe("canonical");
    expect(method?.provenance).toBe("package");
    expect(method?.hash).toMatch(/^[a-f0-9]{64}$/);
    const projection = manifest.files.find((file) => file.path === ".opencode/agents/poiesis.md");
    expect(projection?.kind).toBe("generated");
    expect(projection?.provenance).toBe("projection");
    expect(manifest.configPatches.length).toBeGreaterThan(0);

    // `doctor` reports the mode and that Poiesis still owns its block.
    const doctor = await poiesis(repo.root, "doctor");
    expect(doctor.exitCode, doctor.stderr).toBe(0);
    const checks = (json(doctor.stdout).result as { checks: Array<{ id: string; status: string; details?: unknown }> })
      .checks;
    const mode = checks.find((check) => check.id === "install-mode");
    expect(mode?.status).toBe("pass");
    expect((mode?.details as { mode: string }).mode).toBe("private");
  }, 90_000);

  it("is idempotent: uninstall then reinstall reproduces the exact same block", async () => {
    const repo = await repository();
    const firstConfig = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", firstConfig, "--allow-fixtures")).exitCode).toBe(0);
    const first = await readFile(join(repo.root, ".gitignore"), "utf8");

    const uninstall = await poiesis(repo.root, "uninstall");
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect((json(uninstall.stdout).result as { complete: boolean }).complete).toBe(true);
    // Poiesis created the file and the block was its only content, so the
    // file is gone too.
    expect(await exists(join(repo.root, ".gitignore"))).toBe(false);
    expect(await gitStatus(repo.root)).toEqual([]);

    const secondConfig = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", secondConfig, "--allow-fixtures")).exitCode).toBe(0);
    expect(await readFile(join(repo.root, ".gitignore"), "utf8")).toBe(first);
  }, 120_000);

  it("fails closed on a duplicate block without changing a single byte", async () => {
    const repo = await repository();
    const block = [blockStart("private"), ".poiesis/", blockEnd("private")].join("\n");
    const gitignorePath = join(repo.root, ".gitignore");
    const before = `node_modules\n\n${block}\n\n${block}\n`;
    await writeFile(gitignorePath, before);

    const configPath = await writeInstallConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("GITIGNORE_BLOCK_DUPLICATE");
    expect(await readFile(gitignorePath, "utf8")).toBe(before);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
  }, 90_000);

  it("fails closed on a malformed block without changing a single byte", async () => {
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    // An opening delimiter that is never closed: exactly one policy is
    // required, and an unterminated one is not a policy.
    const before = `node_modules\n${blockStart("private")}\n.poiesis/\n`;
    await writeFile(gitignorePath, before);

    const configPath = await writeInstallConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("GITIGNORE_BLOCK_MALFORMED");
    expect(await readFile(gitignorePath, "utf8")).toBe(before);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
  }, 90_000);

  it("refuses to relabel an existing block recorded under a different mode", async () => {
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    const before = `${blockStart("team")}\n.poiesis/\n${blockEnd("team")}\n`;
    await writeFile(gitignorePath, before);

    const configPath = await writeInstallConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("GITIGNORE_BLOCK_CONFLICT");
    expect(await readFile(gitignorePath, "utf8")).toBe(before);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
  }, 90_000);

  it("fails closed on a symlinked .gitignore without following it", async () => {
    const repo = await repository();
    const target = join(repo.parent, "outside-gitignore");
    await writeFile(target, "node_modules\n");
    const gitignorePath = join(repo.root, ".gitignore");
    await symlink(target, gitignorePath);

    const configPath = await writeInstallConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("INSTALL_PATH_CONFLICT");
    // The link target outside the repository is untouched.
    expect(await readFile(target, "utf8")).toBe("node_modules\n");
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
  }, 90_000);

  it("refuses to patch a TRACKED OpenCode configuration", async () => {
    const repo = await repository();
    const configPath = join(repo.root, "opencode.jsonc");
    await writeFile(configPath, '{\n  "share": "disabled"\n}\n');
    await run("git", ["add", "opencode.jsonc"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "track opencode config"], { cwd: repo.root });

    const installConfig = await writeInstallConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", installConfig, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("OPENCODE_CONFIG_TRACKED_REFUSED");
    // The Author's tracked config is byte-identical, still tracked, and the
    // working tree is untouched — the refusal fired before any write.
    expect(await readFile(configPath, "utf8")).toBe('{\n  "share": "disabled"\n}\n');
    expect(await gitStatus(repo.root)).toEqual([]);
    expect(await exists(join(repo.root, ".gitignore"))).toBe(false);
  }, 90_000);

  it("rolls the ignore block back byte-for-byte when a post-write step fails", async () => {
    const repo = await repository();
    await writeAuthorProject(repo);
    const packageJsonBefore = await readFile(join(repo.root, "package.json"));

    // init probes `opencode debug config` once inside the transaction
    // (`validateOpenCodeConfigPayload`) and once more inside the doctor
    // gate AFTER the block was written. Letting the first through and
    // failing the second exercises the rollback on a real transaction.
    fake?.restore();
    fake = await installFakeOpenCode({
      failAfterDebugCalls: { file: join(repo.parent, "debug-count.txt"), threshold: 1 },
    });

    const configPath = await writeInstallConfig(repo);
    const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(result.exitCode).not.toBe(0);
    expect(errorCode(result)).toBe("INIT_DOCTOR_FAILED");

    // `.gitignore` did not exist before and must not exist after.
    expect(await exists(join(repo.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repo.root, ".opencode"))).toBe(false);
    expect(await exists(join(repo.root, "opencode.jsonc"))).toBe(false);
    for (const target of ["preview", "staging", "production"]) {
      expect(await exists(join(repo.root, "scripts", `poiesis-${target}.mjs`))).toBe(false);
    }
    expect(await readFile(join(repo.root, "package.json"))).toEqual(packageJsonBefore);
    expect(await gitStatus(repo.root)).toEqual([]);

    // A clean retry succeeds, so the rollback left nothing behind.
    fake?.restore();
    fake = await installFakeOpenCode();
    const retry = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
    expect(retry.exitCode, retry.stderr).toBe(0);
    expect(await gitStatus(repo.root)).toEqual(VISIBLE_AFTER_PRIVATE_INIT);
  }, 120_000);

  it("preserves and reports an ignore block the Author edited", async () => {
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    const existing = "node_modules\n";
    await writeFile(gitignorePath, existing);

    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);
    const installed = await readFile(gitignorePath, "utf8");
    expect(installed.startsWith(existing)).toBe(true);
    expect(await gitStatus(repo.root)).toEqual([".gitignore"]);

    // The Author adds their own rule INSIDE the block.
    const edited = installed.replace(
      `${blockEnd("private")}\n`,
      `my-own-rule/\n${blockEnd("private")}\n`,
    );
    await writeFile(gitignorePath, edited);

    const uninstall = await poiesis(repo.root, "uninstall");
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    const result = json(uninstall.stdout).result as {
      complete: boolean;
      preserved: Array<{ path: string; reason: string }>;
    };
    expect(result.complete).toBe(false);
    expect(result.preserved).toContainEqual({
      path: ".gitignore",
      reason: "Poiesis-managed ignore block changed after installation",
    });
    // The Author's own content survives byte-for-byte.
    expect(await readFile(gitignorePath, "utf8")).toBe(edited);
  }, 120_000);

  it("completes on a second uninstall after a partial run already reversed the ignore block", async () => {
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);

    // Foreign content under the Poiesis root: uninstall must preserve and
    // report it, which is exactly what makes this run PARTIAL.
    const foreign = join(repo.root, ".poiesis", "notes.txt");
    await writeFile(foreign, "the Author's own notes\n");

    const first = await poiesis(repo.root, "uninstall");
    expect(first.exitCode, first.stderr).toBe(0);
    const firstResult = json(first.stdout).result as {
      complete: boolean;
      preserved: Array<{ path: string; reason: string }>;
      removed: string[];
    };
    expect(firstResult.complete).toBe(false);
    expect(firstResult.preserved.some((entry) => entry.path === ".poiesis/notes.txt")).toBe(true);
    expect(firstResult.preserved.some((entry) => entry.path === ".gitignore")).toBe(false);
    // This run DID reverse the exact block: Poiesis created `.gitignore`,
    // the block was its only content, so the file is gone.
    expect(firstResult.removed).toContain(".gitignore");
    expect(await exists(gitignorePath)).toBe(false);

    // The retained manifest must not keep claiming ownership of a block it
    // already cut out — that stale record is what made completion
    // unreachable.
    const retainedManifest = json(
      await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8"),
    ) as { ignoreBlock?: unknown; generatedScripts?: unknown; files: unknown[]; skills: unknown[] };
    expect(retainedManifest.ignoreBlock).toBeUndefined();
    expect(retainedManifest.generatedScripts).toBeUndefined();
    expect(retainedManifest.files).toEqual([]);
    expect(retainedManifest.skills).toEqual([]);

    // The Author resolves the one thing that was actually in the way.
    await rm(foreign, { force: true });

    const second = await poiesis(repo.root, "uninstall");
    expect(second.exitCode, second.stderr).toBe(0);
    const secondResult = json(second.stdout).result as {
      complete: boolean;
      manifestRemoved: boolean;
      preserved: Array<{ path: string; reason: string }>;
      removed: string[];
    };
    expect(secondResult.complete).toBe(true);
    expect(secondResult.manifestRemoved).toBe(true);
    // The already-reversed block is not resurrected as preserved content.
    expect(secondResult.preserved.some((entry) => entry.path === ".gitignore")).toBe(false);
    expect(secondResult.preserved).toEqual([]);
    expect(await exists(join(repo.root, ".poiesis", "manifest.json"))).toBe(false);
    expect(await ownershipReceiptExists(repo.root)).toBe(false);
    expect(await gitStatus(repo.root)).toEqual([]);
  }, 120_000);

  it("completes once the managed block is PROVABLY absent, and leaves the Author's own bytes untouched", async () => {
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    const authorsOwn = "# the Author's own policy\nnode_modules\ndist\n";
    await writeFile(gitignorePath, authorsOwn);

    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);
    const installed = await readFile(gitignorePath, "utf8");
    expect(installed.startsWith(authorsOwn)).toBe(true);

    // Force a PARTIAL uninstall with an UNRESOLVED block, so the retained
    // manifest genuinely still claims it — this is the state B1b starts from.
    await writeFile(join(repo.root, ".poiesis", "notes.txt"), "the Author's own notes\n");
    await writeFile(
      gitignorePath,
      installed.replace(`${blockEnd("private")}\n`, `my-own-rule/\n${blockEnd("private")}\n`),
    );
    const first = await poiesis(repo.root, "uninstall");
    expect(first.exitCode, first.stderr).toBe(0);
    const firstResult = json(first.stdout).result as { complete: boolean };
    expect(firstResult.complete).toBe(false);
    const retainedManifest = json(
      await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8"),
    ) as { ignoreBlock?: { path: string; hash: string } };
    expect(retainedManifest.ignoreBlock?.path).toBe(".gitignore");

    // The Author removes the Poiesis block out of band. The block is now
    // provably absent, but the surrounding pre-existing bytes must survive.
    const edited = await readFile(gitignorePath, "utf8");
    const [block] = parseManagedIgnoreBlocks(edited);
    if (block === undefined) throw new Error("the installed block must be locatable");
    const lines = edited.split("\n");
    lines.splice(block.startIndex, block.endIndex - block.startIndex + 1);
    if (block.startIndex > 0 && lines[block.startIndex - 1]?.trim() === "") {
      lines.splice(block.startIndex - 1, 1);
    }
    await writeFile(gitignorePath, lines.join("\n"));
    expect(await readFile(gitignorePath, "utf8")).toBe(authorsOwn);

    // The Author clears the one thing that was actually in the way.
    await rm(join(repo.root, ".poiesis", "notes.txt"), { force: true });

    const second = await poiesis(repo.root, "uninstall");
    expect(second.exitCode, second.stderr).toBe(0);
    const secondResult = json(second.stdout).result as {
      complete: boolean;
      manifestRemoved: boolean;
      preserved: Array<{ path: string; reason: string }>;
      removed: string[];
    };
    // Provable absence is resolution, not preserved content.
    expect(secondResult.complete).toBe(true);
    expect(secondResult.manifestRemoved).toBe(true);
    expect(secondResult.preserved).toEqual([]);
    expect(secondResult.removed).toContain(".poiesis/manifest.json");
    expect(await exists(join(repo.root, ".poiesis", "manifest.json"))).toBe(false);
    expect(await ownershipReceiptExists(repo.root)).toBe(false);
    // The Author's own policy file is byte-for-byte what they left behind.
    expect(await readFile(gitignorePath, "utf8")).toBe(authorsOwn);
    expect(await gitStatus(repo.root)).toEqual([".gitignore"]);
  }, 120_000);

  it("keeps ignore-block authority over a DANGLING .gitignore symlink and preserves it", async () => {
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);

    // Force a PARTIAL uninstall with an UNRESOLVED block, so the retained
    // manifest genuinely still claims the policy this run cannot act on.
    await writeFile(join(repo.root, ".poiesis", "notes.txt"), "the Author's own notes\n");
    const installed = await readFile(gitignorePath, "utf8");
    await writeFile(
      gitignorePath,
      installed.replace(`${blockEnd("private")}\n`, `my-own-rule/\n${blockEnd("private")}\n`),
    );
    await rm(gitignorePath, { force: true });
    // A dangling symlink: a directory entry that EXISTS but resolves to
    // nothing. A symlink-following probe would call it absent and drop
    // Poiesis's authority over it.
    await symlink(join(repo.parent, "nothing-here"), gitignorePath);

    const result = await poiesis(repo.root, "uninstall");
    expect(result.exitCode, result.stderr).toBe(0);
    const uninstalled = json(result.stdout).result as {
      complete: boolean;
      preserved: Array<{ path: string; reason: string }>;
      removed: string[];
    };
    expect(uninstalled.complete).toBe(false);
    expect(
      uninstalled.preserved.some(
        (entry) => entry.path === ".gitignore" && /not a regular file/.test(entry.reason),
      ),
      `expected .gitignore reported unsafe/nonregular, got ${JSON.stringify(uninstalled.preserved)}`,
    ).toBe(true);
    expect(uninstalled.removed).not.toContain(".gitignore");

    // The symlink itself survives untouched...
    // `isSymbolicLink` lives on the Stats prototype, so assert the call, not
    // the property: a dangling link must still BE a symlink on disk.
    expect((await lstat(gitignorePath)).isSymbolicLink()).toBe(true);
    expect(await readlink(gitignorePath)).toBe(join(repo.parent, "nothing-here"));
    // ...and the retained manifest still claims the block.
    const retainedManifest = json(
      await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8"),
    ) as { ignoreBlock?: { path: string; hash: string } };
    expect(retainedManifest.ignoreBlock?.path).toBe(".gitignore");
    expect(retainedManifest.ignoreBlock?.hash).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it("retains the ignore-block record while the block is unresolved across a partial uninstall", async () => {
    // The other half of the same invariant: pruning is conditional on THIS
    // run having reversed the block. An edited block stays owned, stays
    // reported, and keeps Poiesis's authority over it.
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);

    await writeFile(join(repo.root, ".poiesis", "notes.txt"), "the Author's own notes\n");
    // Edit the block so it is genuinely UNRESOLVED: Poiesis must keep
    // claiming it rather than pruning a record it could not act on.
    const installed = await readFile(gitignorePath, "utf8");
    await writeFile(
      gitignorePath,
      installed.replace(`${blockEnd("private")}\n`, `my-own-rule/\n${blockEnd("private")}\n`),
    );

    const first = await poiesis(repo.root, "uninstall");
    expect(first.exitCode, first.stderr).toBe(0);
    const firstResult = json(first.stdout).result as {
      complete: boolean;
      preserved: Array<{ path: string; reason: string }>;
    };
    expect(firstResult.complete).toBe(false);
    expect(firstResult.preserved).toContainEqual({
      path: ".gitignore",
      reason: "Poiesis-managed ignore block changed after installation",
    });
    const retainedManifest = json(
      await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8"),
    ) as { ignoreBlock?: { path: string; hash: string } };
    expect(retainedManifest.ignoreBlock?.path).toBe(".gitignore");
    expect(retainedManifest.ignoreBlock?.hash).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it("restores a pre-existing .gitignore exactly when the block is unchanged", async () => {
    const repo = await repository();
    const gitignorePath = join(repo.root, ".gitignore");
    const existing = "# the Author's own policy\nnode_modules\ndist\n";
    await writeFile(gitignorePath, existing);

    const configPath = await writeInstallConfig(repo);
    expect((await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures")).exitCode).toBe(0);
    expect((await readFile(gitignorePath, "utf8")).startsWith(existing)).toBe(true);

    const uninstall = await poiesis(repo.root, "uninstall");
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    const result = json(uninstall.stdout).result as { complete: boolean; removed: string[] };
    expect(result.complete).toBe(true);
    // The Author's file came back exactly as it was — no leftover blank
    // line, no leftover block.
    expect(await readFile(gitignorePath, "utf8")).toBe(existing);
    expect(result.removed).toContain(".gitignore (Poiesis-managed ignore block)");
  }, 120_000);
});

describe("Spec #190 / ticket #191 - the interactive mode question comes first", () => {
  it("asks Private/local versus Team/shared before any other configuration question", async () => {
    const { runInteractiveInit } = await import("../src/init-interactive.js");
    const repo = await createTestRepository();
    try {
      const asked: string[] = [];
      const stderr: string[] = [];
      await expect(
        runInteractiveInit({
          root: repo.root,
          io: {
            isTTY: true,
            writeStderr: (line) => { stderr.push(line); },
            promptLine: async (prompt) => {
              asked.push(prompt);
              // Answer the mode question only; every later question fails
              // the flow, which is exactly how we observe the ordering.
              if (prompt.includes("private|team")) return "private";
              return "";
            },
            listOpenCodeModels: async () => [],
            runModelSelector: async () => {
              throw new Error(`model selector reached after: ${asked.join(" | ")}`);
            },
            probeTrackerAuth: async () => ({ available: true }),
          },
        }),
      ).rejects.toThrow(/model selector|models/);
      expect(asked[0]).toContain("private|team");
      expect(stderr.join("\n")).toContain("private/local");
    } finally {
      await rm(repo.parent, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses an unrecognised mode answer instead of defaulting to private", async () => {
    const { runInteractiveInit } = await import("../src/init-interactive.js");
    const repo = await createTestRepository();
    try {
      await expect(
        runInteractiveInit({
          root: repo.root,
          io: {
            isTTY: true,
            writeStderr: () => undefined,
            promptLine: async (prompt) => (prompt.includes("private|team") ? "maybe later" : ""),
            listOpenCodeModels: async () => [],
            runModelSelector: async () => "openai/gpt-5.6-sol",
            probeTrackerAuth: async () => ({ available: true }),
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_INSTALL_MODE" });
    } finally {
      await rm(repo.parent, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("Spec #190 / ticket #191 - the guide never infers a mode for a template draft", () => {
  it("the shipped config template states a mode explicitly", async () => {
    const template = await readFile(join(REPO_ROOT, "POIESIS_CONFIG_TEMPLATE.jsonc"), "utf8");
    expect(template).toContain('"mode"');
  });

  it("team is an accepted value that refuses to install rather than installing private semantics", async () => {
    const repo = await createTestRepository();
    try {
      const configPath = join(repo.parent, "team-install.jsonc");
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            schema: 1,
            mode: "team",
            models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
            repository: { remote: "origin", integrationBranch: "main" },
            tracker: { provider: "fixture", project: join(repo.fixtures, "tracker") },
            delivery: {
              preview: { adapter: "fixture", path: join(repo.fixtures, "delivery") },
              staging: { adapter: "fixture", path: join(repo.fixtures, "delivery") },
              production: { adapter: "fixture", path: join(repo.fixtures, "delivery") },
            },
            verification: { commands: ["test -f README.md"] },
          },
          null,
          2,
        )}\n`,
      );
      const result = await poiesis(repo.root, "init", "--config", configPath, "--allow-fixtures");
      expect(result.exitCode).not.toBe(0);
      expect(errorCode(result)).toBe("INSTALL_MODE_UNSUPPORTED");
      expect(await exists(join(repo.root, ".poiesis"))).toBe(false);
    } finally {
      await rm(repo.parent, { recursive: true, force: true });
    }
  }, 90_000);
});

/**
 * Spec #190 / ticket #195 — ordinary `uninstall`, and the ONE confirmed
 * operation that destroys Local tracker history.
 *
 * The properties under test are the ones a user can lose data to, so each case
 * states the failure it forecloses:
 *
 *   - COMPLETE. An ordinary uninstall removes every artifact it can attribute
 *     to the installation — projections, skills, cache, delivery runtime,
 *     verification receipts, a stale mutation lock, abandoned atomic-write
 *     temporaries, and safe inactive owned workspaces — and completes.
 *   - TRACKER-PRESERVING. The recorded Local tracker history is the Author's own
 *     work. It is REPORTED as retained user data and it never makes an otherwise
 *     complete runtime uninstall incomplete.
 *   - PARTIAL and REPEATED. A partial uninstall keeps the minimum authority it
 *     needs to finish, and running it again finishes the job.
 *   - PRESERVING. A shared profile the Author created, an adopted file, a
 *     modified artifact, foreign content, and an active or unsafe workspace all
 *     survive byte-for-byte with a path-specific reason.
 *   - DESTRUCTIVE PURGE. `--purge-history` deletes ONLY a validated,
 *     repository-bound Local tracker store; it works against a tracker-only
 *     remainder; and it refuses a symlink, an unknown entry, foreign content,
 *     a held lock, or a repository-identity mismatch WITHOUT deleting anything.
 *   - NEVER A TARGET. Git history, refs, remotes, release and deployment state
 *     are not in the store and must survive every one of these operations.
 *
 * The purge is driven both through the library (where the validated-removal
 * contract is directly observable) and through the CLI flag surface (where the
 * confirmation requirement is), because the confirmation lives in exactly one of
 * them and neither alone proves the pair.
 */
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import { init, uninstall, type UninstallResult } from "../src/maintenance.js";
import { ownershipReceiptExists, ownershipReceiptLocation, readOwnershipReceipt } from "../src/receipt.js";
import { workspacePrepare } from "../src/git.js";
import {
  LOCAL_TRACKER_STORE_DIRECTORY,
  createLocalTrackerAdapter,
  purgeValidatedLocalTrackerHistory,
  resolveLocalTrackerStoreLocation,
  type LocalTrackerStoreLocation,
} from "../src/local-tracker.js";
import { exists } from "../src/fs.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const repositories: TestRepository[] = [];
let fake: FakeOpenCodeEnvironment | undefined;

afterEach(async () => {
  fake?.restore();
  fake = undefined;
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

/**
 * A private/local installation whose tracker IS the real Local tracker, so the
 * retained history under test is a genuine store the runtime wrote rather than
 * a fixture file that happens to sit in the right place.
 */
async function installedRepository(options: { local?: boolean } = {}): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  fake = await installFakeOpenCode();
  await init(repository.root, testConfig(repository, {}), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
  if (options.local === true) {
    // `init` records a fixture tracker; the Local store is created lazily by
    // the first mutation, exactly as it is in a real `provider: "local"`
    // installation.
    const adapter = createLocalTrackerAdapter(repository.root);
    await adapter.createSpec({ title: "Recorded Spec", body: "the Author's own recorded work" });
  }
  return repository;
}

async function storeLocation(repository: TestRepository): Promise<LocalTrackerStoreLocation> {
  return await resolveLocalTrackerStoreLocation(repository.root);
}

function reasonFor(result: UninstallResult, path: string): string | undefined {
  return [...result.preserved, ...result.retained].find((entry) => entry.path === path)?.reason;
}

describe("Spec #190 / ticket #195 - an ordinary uninstall removes every attributable artifact", () => {
  it("completes and removes the projections, delivery runtime, receipts, lock, and temporary state", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);

    // A verification receipt minted by THIS installation, plus a stale mutation
    // lock and an abandoned atomic-write temporary of an owned path.
    const receiptPath = await readOwnershipReceipt(repository.root);
    expect(receiptPath.installationId).toMatch(/^[0-9a-f-]{36}$/);
    const receiptsDirectory = join(location.gitCommonDir, "poiesis-verification-receipts-v1");
    await mkdir(receiptsDirectory, { recursive: true, mode: 0o700 });
    const ownedReceipt = join(receiptsDirectory, `${randomUUID()}.json`);
    await writeFile(
      ownedReceipt,
      `${JSON.stringify({ schema: 1, id: "x", installationId: receiptPath.installationId, digest: "y" })}\n`,
    );
    // A receipt that belongs to a DIFFERENT installation of the same repository.
    const foreignReceipt = join(receiptsDirectory, `${randomUUID()}.json`);
    await writeFile(
      foreignReceipt,
      `${JSON.stringify({ schema: 1, id: "z", installationId: "someone-elses-installation", digest: "w" })}\n`,
    );

    // The EXACT lock path this workspace's receipt names, because that is the
    // only path `uninstall` may reclaim.
    const lockPath = `${await ownershipReceiptLocation(repository.root)}.mutation.lock`;
    // `<pid>:<uuid>` with a pid that cannot be running: the one classification
    // uninstall may reclaim.
    await writeFile(lockPath, "2147483646:00000000-0000-4000-8000-000000000000\n");

    const abandonedTemporary = join(repository.root, ".poiesis", `manifest.json.${randomUUID()}.tmp`);
    await writeFile(abandonedTemporary, "half-written\n");

    const result = await uninstall(repository.root);

    expect(result.complete, JSON.stringify(result.preserved)).toBe(true);
    expect(result.manifestRemoved).toBe(true);
    expect(result.preserved).toEqual([]);

    // Derived runtime state is gone.
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    // This installation's verification receipt is gone; the other
    // installation's is KEPT (retained, not preserved — it is somebody else's
    // evidence, not cleanup this installation still owes).
    expect(await exists(ownedReceipt)).toBe(false);
    expect(await exists(foreignReceipt)).toBe(true);
    expect(result.retained.some((entry) => entry.path === foreignReceipt)).toBe(true);
    // The stale mutation lock is reclaimed.
    expect(await exists(lockPath)).toBe(false);
    // Abandoned temporary state of an owned path is gone.
    expect(await exists(abandonedTemporary)).toBe(false);
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
  }, 60_000);

  it("preserves a LIVE mutation lock instead of reclaiming it, and reports why", async () => {
    const repository = await installedRepository();
    // This process IS alive, so the lock is live and must survive.
    const lockPath = `${await ownershipReceiptLocation(repository.root)}.mutation.lock`;
    await writeFile(lockPath, `${process.pid}:${randomUUID()}\n`);

    const result = await uninstall(repository.root);
    expect(result.complete).toBe(false);
    expect(await exists(lockPath)).toBe(true);
    expect(reasonFor(result, "workspace mutation lock")).toMatch(/running|active/i);
  }, 60_000);

  it("preserves a mutation lock whose bytes are not a Poiesis lock token", async () => {
    const repository = await installedRepository();
    const lockPath = `${await ownershipReceiptLocation(repository.root)}.mutation.lock`;
    await writeFile(lockPath, "not a poiesis lock token\n");

    const result = await uninstall(repository.root);
    expect(result.complete).toBe(false);
    expect(await exists(lockPath)).toBe(true);
    expect(reasonFor(result, "workspace mutation lock")).toMatch(/not a Poiesis mutation lock/i);
  }, 60_000);

  it("preserves a foreign entry, a modified artifact, and an adopted file with path-specific reasons", async () => {
    const repository = await installedRepository();
    // Foreign content directly under the Poiesis root.
    await writeFile(join(repository.root, ".poiesis", "notes.txt"), "the Author's own notes\n");
    // A generated artifact the Author edited: it must not be deleted on the
    // strength of a digest that no longer describes its bytes.
    const rolePath = join(repository.root, ".poiesis", "roles", "worker.md");
    const editedRole = "the Author's own edit\n";
    await writeFile(rolePath, editedRole);

    const result = await uninstall(repository.root);
    expect(result.complete).toBe(false);
    expect(await readFile(rolePath, "utf8")).toBe(editedRole);
    expect(reasonFor(result, ".poiesis/notes.txt")).toBe("unknown content under .poiesis");
    expect(result.preserved.some((entry) => entry.path === ".poiesis/roles/worker.md")).toBe(true);
  }, 60_000);

  it("is REPEATED: a partial uninstall keeps the authority it needs and a later run finishes", async () => {
    const repository = await installedRepository();
    const foreign = join(repository.root, ".poiesis", "notes.txt");
    await writeFile(foreign, "the Author's own notes\n");

    const first = await uninstall(repository.root);
    expect(first.complete).toBe(false);
    // The minimum authority survives: the manifest still authenticates, so the
    // next run can act rather than report an unowned installation.
    expect(await ownershipReceiptExists(repository.root)).toBe(true);
    expect(await exists(join(repository.root, ".poiesis", "manifest.json"))).toBe(true);

    await rm(foreign, { force: true });
    const second = await uninstall(repository.root);
    expect(second.complete, JSON.stringify(second.preserved)).toBe(true);
    expect(second.manifestRemoved).toBe(true);
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
  }, 60_000);
});

describe("Spec #190 / ticket #195 - Local tracker history is retained USER DATA", () => {
  it("reports the recorded history without making a complete runtime uninstall incomplete", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    expect(await exists(location.storePath)).toBe(true);

    const result = await uninstall(repository.root);

    // The runtime uninstall is genuinely complete...
    expect(result.complete, JSON.stringify(result.preserved)).toBe(true);
    expect(result.manifestRemoved).toBe(true);
    // ...and the recorded history is REPORTED, not silently dropped and not
    // counted as unresolved Poiesis state.
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]!.path).toBe(location.directory);
    expect(result.retained[0]!.reason).toMatch(/retained as user data/i);
    expect(result.preserved).toEqual([]);
    // The bytes are still there, byte-for-byte.
    expect(await readFile(location.storePath, "utf8")).toContain("Recorded Spec");
  }, 60_000);

  it("does not report retained history for a repository that recorded none", async () => {
    const repository = await installedRepository();
    const result = await uninstall(repository.root);
    expect(result.complete).toBe(true);
    expect(result.retained).toEqual([]);
  }, 60_000);
});

describe("Spec #190 / ticket #195 - the explicit, confirmed Local tracker history purge", () => {
  it("removes ONLY a validated, repository-bound store and never any Git history", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    const headBefore = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout;
    const refsBefore = (await run("git", ["for-each-ref", "--format=%(refname)"], { cwd: repository.root })).stdout;
    const logBefore = (await run("git", ["log", "--format=%H"], { cwd: repository.root })).stdout;

    const result = await uninstall(repository.root, { purgeHistory: true });

    expect(result.historyPurge.requested).toBe(true);
    expect(result.historyPurge.purged, result.historyPurge.reason ?? "").toBe(true);
    expect(await exists(location.directory)).toBe(false);
    // Retained user data that was destroyed is no longer reported as retained.
    expect(result.retained).toEqual([]);
    // The runtime uninstall still completed.
    expect(result.complete).toBe(true);

    // Git history, refs, and the remote are untouched.
    expect((await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout).toBe(headBefore);
    expect((await run("git", ["for-each-ref", "--format=%(refname)"], { cwd: repository.root })).stdout).toBe(refsBefore);
    expect((await run("git", ["log", "--format=%H"], { cwd: repository.root })).stdout).toBe(logBefore);
    expect((await run("git", ["remote", "-v"], { cwd: repository.root })).stdout).toContain("origin");
  }, 60_000);

  it("works against a TRACKER-ONLY REMAINDER: nothing installed, history still purgeable", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    expect((await uninstall(repository.root)).complete).toBe(true);
    // The runtime is gone; only user data remains.
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await exists(location.storePath)).toBe(true);

    const result = await uninstall(repository.root, { purgeHistory: true });
    expect(result.complete).toBe(true);
    expect(result.historyPurge.purged, result.historyPurge.reason ?? "").toBe(true);
    expect(await exists(location.directory)).toBe(false);
  }, 60_000);

  it("is idempotent: purging an already-purged remainder reports nothing to purge", async () => {
    const repository = await installedRepository({ local: true });
    expect((await uninstall(repository.root, { purgeHistory: true })).historyPurge.purged).toBe(true);
    const again = await uninstall(repository.root, { purgeHistory: true });
    expect(again.historyPurge.purged).toBe(false);
    expect(again.historyPurge.reason).toMatch(/no Local tracker store/i);
    expect(again.complete).toBe(true);
  }, 60_000);

  it("refuses a SYMLINKED store directory without deleting anything", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    const real = join(repository.parent, "real-store");
    await rm(location.directory, { recursive: true, force: true });
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "store.json"), `${JSON.stringify({ schema: 1, provider: "poiesis-local", nextId: 1, items: {} })}\n`);
    await symlink(real, location.directory);

    const result = await uninstall(repository.root, { purgeHistory: true });
    expect(result.historyPurge.purged).toBe(false);
    expect(result.historyPurge.reason).toMatch(/symlink/i);
    // The bytes the symlink points at survive, and the link itself survives.
    expect(await readFile(join(real, "store.json"), "utf8")).toContain("poiesis-local");
    expect((await lstat(location.directory)).isSymbolicLink()).toBe(true);
  }, 60_000);

  it("refuses an UNKNOWN ENTRY without deleting anything", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    const unknown = join(location.directory, "somebody-elses-notes.txt");
    await writeFile(unknown, "not this store layout\n");

    const result = await uninstall(repository.root, { purgeHistory: true });
    expect(result.historyPurge.purged).toBe(false);
    expect(result.historyPurge.reason).toMatch(/never issues/i);
    // No partial broad deletion: BOTH the foreign entry and the validated
    // document are still there.
    expect(await exists(unknown)).toBe(true);
    expect(await exists(location.storePath)).toBe(true);
  }, 60_000);

  it("refuses FOREIGN CONTENT without deleting anything", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    // Valid JSON, wrong provider: somebody else's document under a Poiesis name.
    await writeFile(
      location.storePath,
      `${JSON.stringify({ schema: 1, provider: "some-other-tool", nextId: 2, items: {} }, null, 2)}\n`,
    );

    const result = await uninstall(repository.root, { purgeHistory: true });
    expect(result.historyPurge.purged).toBe(false);
    expect(result.historyPurge.reason).toMatch(/not written by the local tracker/i);
    expect(await exists(location.storePath)).toBe(true);
    expect(await exists(location.directory)).toBe(true);
  }, 60_000);

  it("refuses a HELD store lock instead of destroying the store under a writer", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    await writeFile(location.lockPath, `${JSON.stringify({ version: 1, token: "t", pid: process.pid, acquiredAt: Date.now() })}\n`);

    const result = await uninstall(repository.root, { purgeHistory: true });
    expect(result.historyPurge.purged).toBe(false);
    expect(result.historyPurge.reason).toMatch(/store lock is present/i);
    expect(await exists(location.storePath)).toBe(true);
  }, 60_000);

  it("refuses a REPOSITORY-IDENTITY MISMATCH without deleting anything", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    // A second clone of the same remote: its own Git common directory, and so
    // its own canonical store path. Pointing this repository's store path at a
    // directory that does not resolve to THIS repository's canonical location
    // must be refused rather than deleted on the strength of the name.
    const sibling = await createTestRepository();
    repositories.push(sibling);
    const siblingLocation = await resolveLocalTrackerStoreLocation(sibling.root);

    // The store directory is a real directory, but it is the SIBLING's.
    await rm(location.directory, { recursive: true, force: true });
    await mkdir(siblingLocation.directory, { recursive: true });
    await writeFile(
      join(siblingLocation.directory, "store.json"),
      `${JSON.stringify({ schema: 1, provider: "poiesis-local", nextId: 1, items: {} })}\n`,
    );
    await symlink(siblingLocation.directory, location.directory);

    await expect(purgeValidatedLocalTrackerHistory(repository.root)).rejects.toMatchObject({
      code: "LOCAL_TRACKER_STORE_UNSAFE",
    });
    // The sibling repository's history is intact.
    expect(await exists(join(siblingLocation.directory, "store.json"))).toBe(true);
    expect((await readdir(siblingLocation.directory)).sort()).toEqual(["store.json"]);
  }, 60_000);

  it("reports a refusal without throwing, so the runtime uninstall that succeeded is still reported", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    await writeFile(join(location.directory, "not-ours.txt"), "foreign\n");

    const result = await uninstall(repository.root, { purgeHistory: true });
    // The runtime teardown completed...
    expect(result.complete).toBe(true);
    expect(result.manifestRemoved).toBe(true);
    // ...and the refusal is reported beside it rather than replacing it.
    expect(result.historyPurge.requested).toBe(true);
    expect(result.historyPurge.purged).toBe(false);
    expect(result.historyPurge.path).toBe(location.directory);
  }, 60_000);
});

describe("Spec #190 / ticket #195 - owned workspaces", () => {
  it("removes a safe INACTIVE owned workspace and leaves a dirty one with a path-specific reason", async () => {
    const repository = await installedRepository();
    const inactive = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/spec-inactive",
      specId: "spec-inactive",
    });
    const active = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/spec-active",
      specId: "spec-active",
    });
    // The active one carries the Author's uncommitted work.
    await writeFile(join(active.path, "work-in-progress.txt"), "not finished\n");

    const result = await uninstall(repository.root);

    expect(await exists(inactive.path), "a safe inactive owned workspace must be removed").toBe(false);
    expect(await exists(active.path), "a dirty owned workspace must survive").toBe(true);
    const reason = reasonFor(result, active.path);
    expect(reason).toMatch(/uncommitted|staged|untracked/i);
    expect(result.complete).toBe(false);

    // The branch a removed workspace was on is Git history, not Poiesis state.
    const refs = (await run("git", ["for-each-ref", "--format=%(refname)"], { cwd: repository.root })).stdout;
    expect(refs).toContain("refs/heads/poiesis/spec-inactive");
  }, 90_000);

  it("preserves an UNSAFE owned workspace: a marker for a path that is not a registered worktree", async () => {
    const repository = await installedRepository();
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/spec-unsafe",
      specId: "spec-unsafe",
    });
    // Deregister the worktree behind Poiesis's back, leaving the marker and the
    // directory on disk.
    await rm(join(repository.root, ".git", "worktrees"), { recursive: true, force: true });
    expect(await exists(workspace.path)).toBe(true);

    const result = await uninstall(repository.root);
    expect(await exists(workspace.path)).toBe(true);
    expect(reasonFor(result, workspace.path)).toMatch(/not registered as a Git worktree/i);
    expect(result.complete).toBe(false);
  }, 90_000);

  it("preserves a foreign directory under the owned workspace container", async () => {
    const repository = await installedRepository();
    const container = join(repository.root, ".poiesis", "workspaces");
    await mkdir(container, { recursive: true, mode: 0o700 });
    await writeFile(join(container, "my-own-notes.txt"), "the Author's own\n");

    const result = await uninstall(repository.root);
    expect(await readFile(join(container, "my-own-notes.txt"), "utf8")).toBe("the Author's own\n");
    expect(
      result.preserved.some(
        (entry) => entry.path === ".poiesis/workspaces/my-own-notes.txt" && /foreign content/.test(entry.reason),
      ),
      JSON.stringify(result.preserved),
    ).toBe(true);
  }, 60_000);
});

describe("Spec #190 / ticket #195 - the purge confirmation lives only at the CLI surface", () => {
  it("refuses `uninstall --yes` without `--purge-history`", async () => {
    const repository = await installedRepository();
    const { commandUninstall } = await import("../src/cli.js");
    await expect(commandUninstall(["--cwd", repository.root, "--yes"])).rejects.toMatchObject({
      code: "INCOMPATIBLE_UNINSTALL_OPTIONS",
    });
  }, 60_000);

  it("refuses `--purge-history` without a TTY and without `--yes`, before touching anything", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    const { commandUninstall } = await import("../src/cli.js");
    // Vitest's stdin is not a TTY, which is exactly the non-interactive case.
    expect(process.stdin.isTTY).not.toBe(true);

    await expect(commandUninstall(["--cwd", repository.root, "--purge-history"])).rejects.toMatchObject({
      code: "PURGE_HISTORY_CONFIRMATION_REQUIRED",
    });
    // Nothing was touched: the installation AND the history are intact.
    expect(await exists(join(repository.root, ".poiesis", "manifest.json"))).toBe(true);
    expect(await exists(location.storePath)).toBe(true);
  }, 60_000);

  it("`--purge-history --yes` is the explicit non-interactive confirmation", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    const { commandUninstall } = await import("../src/cli.js");

    await commandUninstall(["--cwd", repository.root, "--purge-history", "--yes"]);

    expect(await exists(location.directory)).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 60_000);

  it("declines an interactive answer that is not the exact confirmation word", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    const { confirmLocalTrackerHistoryPurge, PURGE_HISTORY_CONFIRMATION_WORD } = await import("../src/cli.js");

    for (const answer of ["y", "yes", "", ` ${PURGE_HISTORY_CONFIRMATION_WORD}!`]) {
      await expect(
        confirmLocalTrackerHistoryPurge(repository.root, {
          isTTY: true,
          promptLine: async () => answer,
        }),
      ).rejects.toMatchObject({ code: "PURGE_HISTORY_DECLINED" });
    }
    expect(await exists(location.storePath)).toBe(true);
  }, 60_000);

  it("accepts the exact confirmation word and refuses a cancelled prompt", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    const { confirmLocalTrackerHistoryPurge, PURGE_HISTORY_CONFIRMATION_WORD } = await import("../src/cli.js");

    await expect(
      confirmLocalTrackerHistoryPurge(repository.root, {
        isTTY: true,
        promptLine: async () => `  ${PURGE_HISTORY_CONFIRMATION_WORD}  `,
      }),
    ).resolves.toBeUndefined();

    const { PoiesisError } = await import("../src/errors.js");
    await expect(
      confirmLocalTrackerHistoryPurge(repository.root, {
        isTTY: true,
        promptLine: async () => {
          throw new PoiesisError("PURGE_HISTORY_CANCELLED", "closed", {}, 130);
        },
      }),
    ).rejects.toMatchObject({ code: "PURGE_HISTORY_CANCELLED" });
    expect(await exists(location.storePath)).toBe(true);
  }, 60_000);
});

describe("Spec #190 / ticket #195 - the store layout is the canonical repository-bound directory", () => {
  it("resolves the store beside Git's objects, never inside the working tree", async () => {
    const repository = await installedRepository({ local: true });
    const location = await storeLocation(repository);
    expect(basenameOf(location.directory)).toBe(LOCAL_TRACKER_STORE_DIRECTORY);
    // Beside Git's objects: inside this repository's Git common directory,
    // never inside the working tree Git tracks.
    expect(location.directory.startsWith(`${location.gitCommonDir}/`)).toBe(true);
    expect(location.gitCommonDir).toContain("/.git");
    expect(existsSync(join(repository.root, ".poiesis", LOCAL_TRACKER_STORE_DIRECTORY))).toBe(false);
    // And therefore invisible to `git status`.
    const status = (await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repository.root })).stdout;
    expect(status).not.toContain(LOCAL_TRACKER_STORE_DIRECTORY);
  }, 60_000);
});

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1]!;
}
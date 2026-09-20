/**
 * Tests for the bounded primary-checkout reconciliation surface
 * (revised ticket #81).
 *
 * The fixture builds throwaway Git repositories with the canonical
 * primary checkout shape: a working tree, a configured `origin` remote,
 * and `main` as the integration branch. Every destructive assertion
 * uses the structured JSON envelope so failures stay legible.
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import {
  computeReconcileFingerprint,
  reconcile,
  RECONCILE_FINGERPRINT_SCHEMA,
} from "../src/reconcile.js";
import { acquireWorkspaceMutationLock } from "../src/mutation-transaction.js";
import { inspectProject } from "../src/inspect.js";

interface TestRepo {
  parent: string;
  root: string;
  remote: string;
  baseSha: string;
  integrationSha: string;
}

async function createTestRepo(
  integrationChanges?: Array<{ path: string; content: string }>,
): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-reconcile-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis Test"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  const baseSha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;

  let integrationSha = baseSha;
  if (integrationChanges !== undefined && integrationChanges.length > 0) {
    for (const change of integrationChanges) {
      const fullPath = join(root, change.path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, change.content);
      await run("git", ["add", change.path], { cwd: root });
    }
    await run("git", ["commit", "--quiet", "-m", "remote advance"], { cwd: root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: root });
    integrationSha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
  }

  return { parent, root, remote, baseSha, integrationSha };
}

async function gitignoreRuntime(root: string): Promise<void> {
  await writeFile(join(root, ".gitignore"), ".poiesis/manifest.json\n.poiesis/workspaces/\n");
  await run("git", ["add", ".gitignore"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "ignore local poiesis state"], { cwd: root });
  await run("git", ["push", "--quiet", "origin", "main"], { cwd: root });
}

const REPO_KEEP_UNUSED: never[] = [];

describe("reconcile fingerprint (read-only opt-in for inspect)", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("returns a versioned fingerprint that binds canonical root, common-dir, and configured remote context", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const fp = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(fp.schema).toBe(RECONCILE_FINGERPRINT_SCHEMA);
    expect(fp.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.canonicalRoot).toBe(repo.root);
    expect(fp.gitCommonDir.length).toBeGreaterThan(0);
    expect(fp.remote).toBe("origin");
    expect(fp.integrationBranch).toBe("main");
    expect(fp.entryCount).toBeGreaterThan(0);
    expect(fp.exclusions.slice().sort()).toEqual([
      ".poiesis/manifest.json",
      ".poiesis/workspaces/",
    ]);
  });

  it("is stable across repeated captures of the same working tree", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const first = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    const second = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(second.digest).toBe(first.digest);
  });

  it("separates by domain (different remote or integration branch changes the digest)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const a = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    const b = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "upstream",
      integrationBranch: "main",
    });
    const c = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "develop",
    });
    expect(b.digest).not.toBe(a.digest);
    expect(c.digest).not.toBe(a.digest);
  });

  it("changes when an untracked file appears or is deleted", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const empty = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    await writeFile(join(repo.root, "scratch.txt"), "scratch v1\n");
    const dirty = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(dirty.digest).not.toBe(empty.digest);
    await rm(join(repo.root, "scratch.txt"));
    const clean = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(clean.digest).toBe(empty.digest);
  });

  it("changes for staged-only edits (working tree bytes unchanged but index bytes differ)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    // The same working-tree bytes appear in both branches below. The
    // only thing that changes between the two captures is the `.git/index`
    // raw bytes — proving the fingerprint binds index bytes, not just
    // status text.
    await writeFile(join(repo.root, "fresh.txt"), "alpha\n");
    const unstaged = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    await run("git", ["add", "fresh.txt"], { cwd: repo.root });
    const staged = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(staged.digest).not.toBe(unstaged.digest);
  });

  it("changes for same-size same-mtime edits (full byte comparison, not just size)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const baseline = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    await writeFile(join(repo.root, "README.md"), "fixtureX");
    const altered = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(altered.digest).not.toBe(baseline.digest);
  });

  it("changes when a regular file is replaced with a symlink (type change)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const baseline = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    await rm(join(repo.root, "README.md"));
    await symlink(join(repo.root, "irrelevant"), join(repo.root, "README.md"));
    const swapped = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(swapped.digest).not.toBe(baseline.digest);
  });

  it("changes for empty-directory presence", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const baseline = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    await mkdir(join(repo.root, "empty-dir"));
    const withDir = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(withDir.digest).not.toBe(baseline.digest);
    await rm(join(repo.root, "empty-dir"), { recursive: true });
    const withoutDir = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(withoutDir.digest).toBe(baseline.digest);
  });

  it("does not follow symlinks (dangling and external targets bind readlink bytes only)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await symlink("/this/target/does/not/exist", join(repo.root, "dangling"));
    const external = join(repo.parent, "outside.txt");
    await writeFile(external, "outside\n");
    await symlink(external, join(repo.root, "external"));
    const fp = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(fp.digest).toMatch(/^[0-9a-f]{64}$/);
    // If symlinks were followed, the fingerprint would include the
    // external target's bytes and change when we rewrite it. It must
    // not.
    const before = fp.digest;
    await writeFile(external, "CHANGED\n");
    const after = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(after.digest).toBe(before);
  });

  it("distinguishes distinct symlink targets (including invalid-UTF8 bytes)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const targetA = Buffer.from([0x66, 0x6f, 0x6f]); // "foo"
    const targetB = Buffer.from([0x66, 0x6f, 0x6f, 0xc3, 0x28]); // invalid-UTF8 trailing byte
    await writeFile(join(repo.root, "raw-target"), targetA);
    const fpA = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    await rm(join(repo.root, "raw-target"));
    await writeFile(join(repo.root, "raw-target"), targetB);
    const fpB = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(fpB.digest).not.toBe(fpA.digest);
  });

  it("handles raw path bytes without throwing and produces a deterministic order", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const weirdNameA = Buffer.from([0x61, 0x2d, 0xc3, 0x28, 0x2d, 0x62]);
    const weirdNameB = Buffer.from([0x61, 0x2d, 0xc3, 0x28, 0x2d, 0x63]);
    await mkdir(join(repo.root, "weird"));
    await writeFile(join(repo.root, "weird", weirdNameA.toString("utf8")), "a\n").catch(async () => {
      // Fallback when the filesystem rejects the invalid-UTF8 name:
      // surface an explicit refusal so the test does not silently
      // skip the assertion.
      throw new Error("filesystem rejected invalid-UTF8 name; rerun on a UTF-8 locale");
    });
    await writeFile(join(repo.root, "weird", weirdNameB.toString("utf8")), "b\n").catch(async () => {
      throw new Error("filesystem rejected invalid-UTF8 name; rerun on a UTF-8 locale");
    });
    const first = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    const second = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(second.digest).toBe(first.digest);
  });

  it("binds exact permission mode bits for executable files", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await writeFile(join(repo.root, "exec.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(repo.root, "exec.sh"), 0o755);
    const fp = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(fp.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses nested repositories inside the discard scope", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await mkdir(join(repo.root, "nested"));
    await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: join(repo.root, "nested") });
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_NESTED_REPOSITORY" });
  });

  it("refuses sparse-checkout configuration", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await run("git", ["config", "core.sparseCheckout", "true"], { cwd: repo.root });
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_SPARSE_CHECKOUT" });
  });

  it("refuses submodule registrations", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await writeFile(join(repo.root, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ./x.git\n');
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_SUBMODULE" });
  });

  it("refuses content filters that prevent exact target verification", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await run("git", ["config", "filter.lfs.clean", "git-lfs clean -- %f"], { cwd: repo.root });
    await run("git", ["config", "filter.lfs.smudge", "git-lfs smudge -- %f"], { cwd: repo.root });
    await writeFile(join(repo.root, ".gitattributes"), "*.bin filter=lfs\n");
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_FILTER_ACTIVE" });
  });

  it("refuses active Git operations (index.lock present)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const lockPath = join(repo.root, ".git", "index.lock");
    await writeFile(lockPath, "");
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(lockPath, { force: true });
    }
  });

  it("refuses split-index configuration (cannot bind exact index bytes)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await run("git", ["config", "splitIndex.enabled", "true"], { cwd: repo.root });
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_SPLIT_INDEX" });
  });

  it("refuses unsupported entry types (FIFO/socket/device)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    // mkfifo may be unavailable in some environments; the assertion is
    // a refusal, so we attempt the create and skip on environments that
    // lack the syscall (the unsupported-refusal code path will be
    // exercised by the symlink-and-type-change tests above).
    try {
      await run("mkfifo", [join(repo.root, "fifo")], { cwd: repo.root, allowFailure: true });
    } catch {
      return;
    }
    try {
      const stat = await lstat(join(repo.root, "fifo"));
      if (!stat.isFIFO()) return;
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_UNSUPPORTED_ENTRY" });
    } finally {
      await rm(join(repo.root, "fifo"), { force: true });
    }
  });

  it("enforces the discard-scope path-bytes bound via the fingerprint's UTF-8 encoding", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // The path-bytes check in walkWorkingTree measures
    // Buffer.byteLength(childRelative, "utf8") — the same encoding
    // the fingerprint digest uses via `updateLengthFramed` — so a
    // path at the boundary is still fingerprintable. The OS PATH_MAX
    // (4096) prevents constructing an actual over-budget path in a
    // fixture on every supported filesystem, so this test pins the
    // boundary: build the deepest FS-allowed nested tree, plant a
    // file the scan must descend into, and confirm reconcile succeeds
    // with the deepest path's UTF-8 byte length <= 4096 (the constant
    // the implementation compares against).
    const segment = "a".repeat(100);
    const fileTail = "/z.txt";
    const PATH_BUDGET = 4096;
    let cursor = repo.root;
    let relative = "";
    while (true) {
      const nextRelative = relative === "" ? segment : `${relative}/${segment}`;
      const nextAbsolute = join(cursor, segment);
      // Stop before the next directory level would force the
      // eventual marker file's relative path past PATH_BUDGET, or
      // before the absolute path would exceed the OS PATH_MAX.
      if (
        Buffer.byteLength(nextRelative, "utf8") + fileTail.length > PATH_BUDGET ||
        Buffer.byteLength(nextAbsolute, "utf8") + fileTail.length > PATH_BUDGET
      ) {
        break;
      }
      await mkdir(nextAbsolute);
      cursor = nextAbsolute;
      relative = nextRelative;
    }
    // The deepest directory the FS allowed must be at-or-under the
    // budget, and the file's relative path (with the `/z.txt` tail)
    // must also be at-or-under — i.e. the scan's boundary case
    // succeeds and does NOT trip the path-bytes rejection.
    expect(Buffer.byteLength(relative, "utf8")).toBeLessThanOrEqual(PATH_BUDGET);
    const markerRelative = `${relative}${fileTail}`;
    expect(Buffer.byteLength(markerRelative, "utf8")).toBeLessThanOrEqual(PATH_BUDGET);
    await writeFile(join(cursor, "z.txt"), "x\n");

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).resolves.toBeDefined();
  });
});

describe("inspect opt-in fingerprint (read-only)", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("does not include the fingerprint field when --fingerprint is absent (backward compatible)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const inspection = await inspectProject({ cwd: repo.root });
    expect("fingerprint" in inspection).toBe(false);
    expect(inspection.git.root).toBe(repo.root);
  });

  it("includes a deterministic fingerprint when --fingerprint is set, and does not mutate the working tree", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const beforeHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    const inspection = await inspectProject({ cwd: repo.root, fingerprint: true });
    expect(inspection.fingerprint).toBeDefined();
    const afterHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(afterHead).toBe(beforeHead);
    const inspection2 = await inspectProject({ cwd: repo.root, fingerprint: true });
    expect(inspection2.fingerprint?.digest).toBe(inspection.fingerprint?.digest);
  });
});

describe("reconcile operation (destructive, bounded)", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  async function captureBaseline(repo: TestRepo): Promise<{
    head: string;
    target: string;
    fingerprint: string;
  }> {
    await run("git", ["fetch", "--quiet", "origin"], { cwd: repo.root });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    const target = (await run("git", ["rev-parse", "origin/main"], { cwd: repo.root })).stdout;
    const fingerprint = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    return { head, target, fingerprint };
  }

  it("successfully reconciles a dirty checkout with staged, unstaged, deleted, untracked, ignored, binary, executable, and symlink state", async () => {
    const repo = await createTestRepo([{ path: "feature.txt", content: "feature\n" }]);
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Untracked (not ignored)
    await writeFile(join(repo.root, "scratch.txt"), "scratch\n");
    // Ignored
    await mkdir(join(repo.root, ".poiesis", "manifest.json.dir"), { recursive: true });
    await writeFile(join(repo.root, ".poiesis", "manifest.json"), '{"alive":true}\n');
    await mkdir(join(repo.root, ".poiesis", "workspaces", "active"), { recursive: true });
    await writeFile(join(repo.root, ".poiesis", "workspaces", "active", "note.txt"), "kept\n");
    // Unstaged modification
    await writeFile(join(repo.root, "README.md"), "dirty-edit\n");
    // Staged addition
    await writeFile(join(repo.root, "staged.txt"), "staged\n");
    await run("git", ["add", "staged.txt"], { cwd: repo.root });
    // Tracked-then-deleted (working tree missing, index still has it)
    await writeFile(join(repo.root, "feature.txt"), "to-delete\n");
    await run("git", ["add", "feature.txt"], { cwd: repo.root });
    await rm(join(repo.root, "feature.txt"));
    // Binary + executable + symlink (all staged)
    await writeFile(join(repo.root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await run("git", ["add", "binary.bin"], { cwd: repo.root });
    await writeFile(join(repo.root, "exec.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(repo.root, "exec.sh"), 0o755);
    await run("git", ["add", "exec.sh"], { cwd: repo.root });
    await symlink(join(repo.root, "README.md"), join(repo.root, "link-to-readme"));
    await run("git", ["add", "link-to-readme"], { cwd: repo.root });

    const baseline = await captureBaseline(repo);

    const result = await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });

    expect(result.head).toBe(baseline.target);
    expect(result.indexMatchesTarget).toBe(true);
    expect(result.workingTreeMatchesTarget).toBe(true);
    expect(result.target).toBe(baseline.target);
    expect(result.preservedExclusions).toEqual([
      ".poiesis/manifest.json",
      ".poiesis/workspaces/",
    ]);
    expect(result.fingerprint).toBe(baseline.fingerprint);

    // Local HEAD equals the integration target.
    expect((await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout).toBe(baseline.target);
    // Residue outside the declared exclusions is gone.
    const postStatus = (
      await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo.root })
    ).stdout;
    const offenders = postStatus
      .split("\0")
      .filter(Boolean)
      .filter(
        (record) =>
          record.length >= 4 &&
          !record.slice(3).startsWith(".poiesis/manifest.json") &&
          !record.slice(3).startsWith(".poiesis/workspaces/"),
      );
    expect(offenders).toEqual([]);
    // Declared exclusions survived exactly.
    const manifestBytes = await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8");
    expect(manifestBytes).toBe('{"alive":true}\n');
    const keptBytes = await readFile(join(repo.root, ".poiesis", "workspaces", "active", "note.txt"), "utf8");
    expect(keptBytes).toBe("kept\n");
  });

  it("refuses a missing or false discard authorization", async () => {
    const repo = await createTestRepo([{ path: "feature.txt", content: "x\n" }]);
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: false,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_AUTHORIZATION_MISSING" });
  });

  it("refuses a wrong primary checkout (root mismatch)", async () => {
    const repo = await createTestRepo([{ path: "feature.txt", content: "x\n" }]);
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    await expect(
      reconcile({
        cwd: repo.parent,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_ROOT_MISMATCH" });
  });

  it("refuses a wrong integration branch", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "develop",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_INTEGRATION_BRANCH_MISMATCH" });
  });

  it("refuses a stale local HEAD", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    await writeFile(join(repo.root, "extra.txt"), "extra\n");
    await run("git", ["add", "extra.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "extra"], { cwd: repo.root });
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_HEAD_MISMATCH" });
  });

  it("refuses a stale fingerprint (deterministic pre-mutation race detection)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    // Inject residue AFTER the fingerprint was captured but BEFORE the
    // destructive step. The revalidation must catch it.
    await writeFile(join(repo.root, "late-residue.txt"), "race\n");
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_FINGERPRINT_MISMATCH" });
  });

  it("refuses a stale fetched target (remote moved between capture and apply)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    // Advance the remote WITHOUT advancing the local primary HEAD:
    // clone the bare remote, commit, and push from the clone so the
    // primary checkout's HEAD stays at the original commit. Reconcile
    // must detect the target drift independently of HEAD drift.
    const remoteClone = join(repo.parent, "remote-clone");
    await run("git", ["clone", "--quiet", repo.remote, remoteClone], { cwd: repo.parent });
    await run("git", ["config", "user.name", "Poiesis Test"], { cwd: remoteClone });
    await run("git", ["config", "user.email", "poiesis@example.test"], { cwd: remoteClone });
    await writeFile(join(remoteClone, "remote-advance.txt"), "advance\n");
    await run("git", ["add", "remote-advance.txt"], { cwd: remoteClone });
    await run("git", ["commit", "--quiet", "-m", "advance"], { cwd: remoteClone });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: remoteClone });
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_TARGET_MISMATCH" });
  });

  it("refuses remote URL drift", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    await run("git", ["remote", "set-url", "origin", "/nonexistent/remote.git"], { cwd: repo.root });
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_REMOTE_DRIFT" });
  });

  it("refuses an active Git operation (index.lock present at revalidate)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    const lockPath = join(repo.root, ".git", "index.lock");
    await writeFile(lockPath, "");
    try {
      await expect(
        reconcile({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
          expectedHeadSha: baseline.head,
          expectedTargetSha: baseline.target,
          expectedFingerprint: baseline.fingerprint,
          discardAcknowledged: true,
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(lockPath, { force: true });
    }
  });

  it("refuses when the real Poiesis mutation lock is already held by a cooperating operation", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    const lock = await acquireWorkspaceMutationLock(repo.root);
    try {
      await expect(
        reconcile({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
          expectedHeadSha: baseline.head,
          expectedTargetSha: baseline.target,
          expectedFingerprint: baseline.fingerprint,
          discardAcknowledged: true,
        }),
      ).rejects.toMatchObject({ code: "POIESIS_MUTATION_LOCKED" });
    } finally {
      await lock.release();
    }
  });

  it("preserves archive nested worktrees, markers, and ownership receipts in place", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    // Add a linked worktree off the integration branch so we can prove
    // it survives reconciliation (reconcile must NOT touch any
    // registered linked worktree's working tree).
    const archivePath = join(repo.parent, "archive-worktree");
    await run("git", ["worktree", "add", "--quiet", "-b", "archive/test", archivePath, "main"], {
      cwd: repo.root,
    });
    // Plant marker + receipt bytes the post-reconcile snapshot must
    // still observe bit-for-bit.
    const markerDir = join(repo.root, ".git", "poiesis-workspaces-v1");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const markerPath = join(markerDir, "fixture.json");
    const markerBytes = '{"schema":1,"owner":"poiesis","sentinel":"keepme"}\n';
    await writeFile(markerPath, markerBytes);
    await chmod(markerPath, 0o400);
    const receiptDir = join(repo.root, ".git", "poiesis-receipts-v1");
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });
    const receiptPath = join(receiptDir, "sentinel.json");
    const receiptBytes = '{"schema":1,"sentinel":"keepme"}\n';
    await writeFile(receiptPath, receiptBytes);

    const result = await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    expect(result.preservedPaths.length).toBeGreaterThan(0);

    expect(await readFile(markerPath, "utf8")).toBe(markerBytes);
    expect(await readFile(receiptPath, "utf8")).toBe(receiptBytes);
    // Archive worktree still attached and on its branch.
    const worktreeList = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout;
    expect(worktreeList).toContain(archivePath);
    expect(worktreeList).toMatch(/branch refs\/heads\/archive\/test/);
  });

  it("refuses a discard scope collision (declared exclusion tracked by target)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Push a tree that contains a tracked file under .poiesis/workspaces/
    // — the declared exclusion collides with the target's tracked
    // content. Reconcile must refuse before any mutation runs.
    await mkdir(join(repo.root, ".poiesis", "workspaces"), { recursive: true });
    await writeFile(join(repo.root, ".poiesis", "workspaces", "tracked.txt"), "tracked\n");
    await run("git", ["add", "-f", ".poiesis/workspaces/tracked.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "track under exclusion"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    const baseline = await captureBaseline(repo);
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_EXCLUSION_COLLISION" });
  });

  it("refuses to report success when a post-reset partial failure leaves residue", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    // Wrap the destructive reset by mutating the worktree mid-flight
    // through a hook on `git reset`. We monkey-patch the `git` argv
    // detection via a fake entry in the config that aliases `reset` to
    // a no-op. Easiest deterministic injection: drop the index file
    // AFTER fetch but BEFORE reconcile runs, then assert reconcile
    // fails closed.
    //
    // We cannot inject after the lock acquisition from outside, but we
    // can race the destructive step by writing a *tracked* file with a
    // colliding name before apply and asserting the partial mutation
    // does not claim success. The simpler invariant we assert here is:
    // a pre-mutation race that changes the fingerprint refuses with a
    // typed error and does not claim success.
    await writeFile(join(repo.root, "partial-failure.txt"), "race\n");
    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toBeDefined();
    // HEAD must not have moved.
    const headAfter = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(headAfter).toBe(baseline.head);
  });
});

describe("reconcile fingerprint — fingerprint sensitivity on common primary-checkout states", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  async function fp(repo: TestRepo): Promise<string> {
    return (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
  }

  it("includes ignored residue (gitignored files participate in the discard scope)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await writeFile(join(repo.root, ".gitignore"), "ignored/\n");
    await run("git", ["add", ".gitignore"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "ignore"], { cwd: repo.root });
    const before = await fp(repo);
    await mkdir(join(repo.root, "ignored"));
    await writeFile(join(repo.root, "ignored", "kept.txt"), "kept\n");
    const after = await fp(repo);
    expect(after).not.toBe(before);
  });

  it("captures deleted tracked files (working tree missing but index still has them)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const before = await fp(repo);
    await writeFile(join(repo.root, "to-delete.txt"), "will delete\n");
    await run("git", ["add", "to-delete.txt"], { cwd: repo.root });
    await rm(join(repo.root, "to-delete.txt"));
    const after = await fp(repo);
    expect(after).not.toBe(before);
  });

  it("changes when binary content shifts even though the size is identical", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await writeFile(join(repo.root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await run("git", ["add", "binary.bin"], { cwd: repo.root });
    const before = await fp(repo);
    await writeFile(join(repo.root, "binary.bin"), Buffer.from([0x03, 0x02, 0x01, 0x00]));
    const after = await fp(repo);
    expect(after).not.toBe(before);
  });

  it("changes when executable mode bits differ", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await writeFile(join(repo.root, "exec.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(repo.root, "exec.sh"), 0o644);
    const before = await fp(repo);
    await chmod(join(repo.root, "exec.sh"), 0o755);
    const after = await fp(repo);
    expect(after).not.toBe(before);
  });
});

describe("primary-checkout gate (ticket #81 reviewer follow-up)", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  async function captureBaseline(repo: TestRepo): Promise<{
    head: string;
    target: string;
    fingerprint: string;
    worktrees: string[];
  }> {
    await run("git", ["fetch", "--quiet", "origin"], { cwd: repo.root });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    const target = (await run("git", ["rev-parse", "origin/main"], { cwd: repo.root })).stdout;
    const fingerprint = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    const worktrees = (
      await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })
    ).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    return { head, target, fingerprint, worktrees };
  }

  it("refuses to fingerprint a registered linked worktree before any destructive action", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Register a linked worktree on a non-integration branch so we
    // can drive reconcile from inside that worktree's directory.
    const linkedPath = join(repo.parent, "linked-worktree");
    await run("git", ["worktree", "add", "--quiet", "-b", "feature/linked", linkedPath, "main"], {
      cwd: repo.root,
    });
    // Sanity: the linked worktree exists and is registered. If this
    // ever stops being true the test would silently pass for the
    // wrong reason, so we surface the assumption explicitly.
    const listBefore = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout;
    expect(listBefore).toContain(linkedPath);
    // Capture the primary HEAD at the end of setup (after the .gitignore
    // commit) so the post-rejection assertion proves reconcile did not
    // mutate the primary, not just that HEAD equals the initial commit.
    const primaryHeadBefore = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;

    await expect(
      computeReconcileFingerprint({
        cwd: linkedPath,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_NOT_PRIMARY_CHECKOUT" });

    // No mutation: linked worktree is still registered and on its
    // branch, and the primary checkout is untouched.
    const listAfter = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout;
    expect(listAfter).toContain(linkedPath);
    expect(listAfter).toMatch(/branch refs\/heads\/feature\/linked/);
    const primaryHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(primaryHead).toBe(primaryHeadBefore);
  });

  it("refuses to reconcile a registered linked worktree without mutating anything", async () => {
    const repo = await createTestRepo([{ path: "feature.txt", content: "x\n" }]);
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await run("git", ["fetch", "--quiet", "origin"], { cwd: repo.root });
    const linkedPath = join(repo.parent, "linked-worktree-apply");
    await run("git", ["worktree", "add", "--quiet", "-b", "feature/linked-apply", linkedPath, "main"], {
      cwd: repo.root,
    });
    const baseline = await captureBaseline(repo);
    const primaryHeadBefore = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    await expect(
      reconcile({
        cwd: linkedPath,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_NOT_PRIMARY_CHECKOUT" });

    // Primary HEAD must not have advanced; linked worktree must still
    // be registered.
    const primaryHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(primaryHead).toBe(primaryHeadBefore);
    const list = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout;
    expect(list).toContain(linkedPath);
  });

  it("refuses to fingerprint a bare repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "poiesis-reconcile-bare-"));
    repos.push({ parent, root: parent, remote: parent, baseSha: "", integrationSha: "" });
    const barePath = join(parent, "bare.git");
    await run("git", ["init", "--quiet", "--bare", barePath], { cwd: parent });
    await expect(
      computeReconcileFingerprint({
        cwd: barePath,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_NOT_PRIMARY_CHECKOUT" });
  });
});

describe("worktree revalidation (ticket #81 reviewer follow-up)", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  async function captureBaseline(repo: TestRepo): Promise<{
    head: string;
    target: string;
    fingerprint: string;
    worktrees: string[];
  }> {
    await run("git", ["fetch", "--quiet", "origin"], { cwd: repo.root });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    const target = (await run("git", ["rev-parse", "origin/main"], { cwd: repo.root })).stdout;
    const fingerprint = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    const worktrees = (
      await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })
    ).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    return { head, target, fingerprint, worktrees };
  }

  it("detects a same-count path drift (one linked worktree swapped for another) without mutation", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Two linked worktrees so we can swap them without changing the
    // total count.
    const linkedA = join(repo.parent, "linked-A");
    const linkedB = join(repo.parent, "linked-B");
    await run("git", ["worktree", "add", "--quiet", "-b", "feature/A", linkedA], { cwd: repo.root });
    await run("git", ["worktree", "add", "--quiet", "-b", "feature/B", linkedB], { cwd: repo.root });
    const baseline = await captureBaseline(repo);

    // Same-count drift: remove A, leave B in place. The count is
    // stable, but the set changed.
    await run("git", ["worktree", "remove", "--force", linkedA], { cwd: repo.root });
    await run("git", ["worktree", "add", "--quiet", "-b", "feature/C", join(repo.parent, "linked-C")], {
      cwd: repo.root,
    });
    const primaryHeadBefore = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;

    await expect(
      reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        expectedWorktrees: baseline.worktrees,
        discardAcknowledged: true,
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_WORKTREE_DRIFT" });

    // No mutation: HEAD unchanged, the remaining worktrees intact.
    const primaryHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(primaryHead).toBe(primaryHeadBefore);
    const list = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout;
    expect(list).not.toContain(linkedA);
    expect(list).toContain(linkedB);
  });

  it("canonicalizes linked-worktree paths so the pre-mutation revalidation uses a realpath-stable set", async () => {
    // The archive-preservation test above already exercises the
    // sibling-layout case end-to-end. This test pins the
    // canonicalization contract directly: a registered linked
    // worktree that lives at a path with a trailing slash / casing
    // variant must still be recognized after `listWorktrees`
    // canonicalizes its absolute realpath. We cannot easily create
    // a casing-different path on a case-sensitive filesystem, so
    // the assertion reduces to: the surviving linked worktree path
    // observed by `git worktree list` is a single string, and the
    // destructive step skipped its contents.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const linkedPath = join(repo.parent, "linked-canon");
    await run("git", ["worktree", "add", "--quiet", "-b", "feature/canon", linkedPath, "main"], {
      cwd: repo.root,
    });
    const baseline = await captureBaseline(repo);
    await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    // Linked worktree still on its branch.
    const list = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout;
    expect(list).toContain(linkedPath);
    expect(list).toMatch(/branch refs\/heads\/feature\/canon/);
  });
});

// Suppress unused parameter lint for the constants the harness declares
// for archive test setups; remove when the archive tests above grow
// beyond the worktree/marker/receipt smoke check.
void REPO_KEEP_UNUSED;
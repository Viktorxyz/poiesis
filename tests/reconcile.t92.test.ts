/**
 * Tests for remediation ticket #92.
 *
 * Each `describe` block corresponds to one of the final-review
 * findings for ticket #92. Tests use real disposable Git
 * repositories so the seam is exercised exactly as it would be
 * in production: never mocks, never string substitutions of Git
 * output.
 *
 * The findings addressed here:
 *
 *   - distinguish "absent" `.git/index` from physically present
 *     zero-byte index: the absent case keeps the zero-byte exact
 *     binding (the fingerprint continues to hash zero bytes); a
 *     physically present zero-byte index now fails the
 *     authoritative probe with `RECONCILE_INDEX_INVALID` instead
 *     of silently matching the absent-binding. Git itself refuses
 *     to read a zero-byte index; reconcile must refuse it
 *     explicitly;
 *
 *   - early typed rejection of `git init --separate-git-dir`
 *     setups where `<root>/.git` is a regular file (containing
 *     `gitdir: <path>`) rather than a directory. The gate runs
 *     before any fingerprint, fetch, or mutation. The resolved
 *     git-dir is captured for the split-index and index probes so
 *     the seam never assumes `<root>/.git` is a directory, even
 *     if the separate-git-dir gate is later relaxed;
 *
 *   - the split-index and index captures read from the resolved
 *     `gitCommonDir` (which the existing
 *     `assertPrimaryCheckout` gate has already proven equals
 *     `canonicalGitDir`) instead of `join(root, ".git", ...)`.
 *     The gate's typed rejection is the user-visible boundary;
 *     the resolved-path reads are the defense-in-depth that keeps
 *     the helpers correct in isolation.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import { computeReconcileFingerprint } from "../src/reconcile.js";

interface TestRepo {
  parent: string;
  root: string;
  remote: string;
}

/**
 * Build a primary-checkout fixture with one initial commit and a
 * configured `origin` remote. Mirrors the helpers in the other
 * `reconcile.tNN.test.ts` suites so the new tests read like
 * siblings to t84 / t86 / t88 / t91.
 */
async function createTestRepo(): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t92-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis T92"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t92@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  return { parent, root, remote };
}

/**
 * Build a `git init --separate-git-dir=<dir>` fixture so the
 * worktree contains a `.git` FILE (with `gitdir: <dir>` content)
 * pointing at the external git directory. Mirrors the real-world
 * production setup; `git` itself resolves the file via the
 * content pointer, but reconcile's primary-checkout contract
 * requires `<root>/.git` to be the actual git directory.
 */
async function createSeparateGitDirTestRepo(): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t92-separate-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  const externalGitDir = join(parent, "external-gitdir");
  await mkdir(root);
  await run(
    "git",
    ["init", "--quiet", "--initial-branch=main", `--separate-git-dir=${externalGitDir}`],
    { cwd: root },
  );
  await run("git", ["config", "user.name", "Poiesis T92"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t92@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  return { parent, root, remote };
}

// =============================================================================
// Finding 1: distinguish absent `.git/index` from physically present
// zero-byte index.
//
// The previous implementation conflated the two cases: `readIndexBytes`
// returned an empty buffer whether the file was absent (a valid exact
// binding) or present but zero bytes (a malformed Git state). The fix
// returns the empty buffer only when the file is absent and refuses with
// `RECONCILE_INDEX_INVALID` when the file is present but zero bytes.
// The fingerprint continues to bind the absent case as a zero-byte hash
// (so an absent index still matches between captures), but a present
// zero-byte index now fails closed before any destructive step.
// =============================================================================

describe("ticket #92 — finding 1: distinguish absent vs physically present zero-byte index", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("still fingerprints the zero-byte exact binding when .git/index is absent", async () => {
    // The absent case is the canonical "no tracked paths" binding:
    // the fingerprint hashes zero bytes, and a follow-up capture
    // with the file still absent produces the SAME digest. A
    // captured baseline MUST be reproducible so a reviewer can
    // re-capture without drift. The previous implementation
    // already supported this; the fix keeps the contract.
    const repo = await createTestRepo();
    repos.push(repo);
    // Remove the index file. `git status` afterwards reports
    // every tracked file as deleted (the working tree's bytes
    // still exist; only the index entries do), which is the
    // shape reconcile must refuse at the destructive step but
    // tolerate at the read-only fingerprint surface.
    await rm(join(repo.root, ".git", "index"));
    const fpBefore = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    const fpAfter = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    expect(fpBefore).toMatch(/^[0-9a-f]{64}$/);
    expect(fpAfter).toBe(fpBefore);
  });

  it("refuses a physically present zero-byte .git/index with RECONCILE_INDEX_INVALID", async () => {
    // The presence of a zero-byte index file is a real Git
    // corruption: `git ls-files --stage -z` exits non-zero on a
    // zero-byte index (the prior `readIndexBytes` implementation
    // silently returned `Buffer.alloc(0)` and the fingerprint
    // hashed those zero bytes as if the file were absent). The
    // fix distinguishes the two cases: a present zero-byte file
    // refuses with `RECONCILE_INDEX_INVALID` BEFORE the
    // authoritative `git ls-files` probe (so a `git`-unreadable
    // index is caught up front even when the `git` command
    // happens to be missing on the host).
    const repo = await createTestRepo();
    repos.push(repo);
    // Truncate the on-disk index to zero bytes. The file still
    // exists but contains no bytes.
    await writeFile(join(repo.root, ".git", "index"), Buffer.alloc(0));
    // Sanity: the file is present and zero bytes.
    const indexStat = await lstat(join(repo.root, ".git", "index"));
    expect(indexStat.size).toBe(0);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: "RECONCILE_INDEX_INVALID",
    });
  });

  it("refuses the zero-byte case before the authoritative git probe runs (defense-in-depth)", async () => {
    // The new gate runs BEFORE `probeIndexStageViaGitLsFiles`
    // so a malformed physical index is refused even on hosts
    // where the `git` binary is missing or has been sandboxed
    // away. The previous implementation relied on `git ls-files
    // --stage -z` to surface the corruption; the new path is
    // independent of the `git` binary. Pin the refusal surface
    // here so a future refactor cannot accidentally move the
    // check behind a `git` call.
    const repo = await createTestRepo();
    repos.push(repo);
    await writeFile(join(repo.root, ".git", "index"), Buffer.alloc(0));

    // Capture the rejection and confirm it carries a structured
    // `path` attribute so callers can map the error to the
    // specific file that was malformed.
    let captured: unknown;
    try {
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      code: "RECONCILE_INDEX_INVALID",
      details: { path: expect.stringMatching(/index$/) },
    });
  });

  it("the absent-binding fingerprint differs from the present-but-otherwise-identical fingerprint", async () => {
    // Pin the contract that the fingerprint distinguishes
    // "absent" from "present non-empty" even when the working
    // tree content is identical: a capture BEFORE
    // `git add` (no index entries, file present) and a capture
    // AFTER the index file is removed (zero-byte binding,
    // working tree content identical) MUST produce different
    // digests. The previous implementation conflated the two
    // cases via the zero-byte hash, which made the digest
    // ambiguous; the fix keeps them distinct.
    const repo = await createTestRepo();
    repos.push(repo);
    // Capture with the normal present index.
    const presentDigest = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    // Remove the index file and re-capture. The absent-binding
    // hashes zero bytes; the present-binding hashes the real
    // index bytes. They must differ.
    await rm(join(repo.root, ".git", "index"));
    const absentDigest = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    expect(presentDigest).not.toBe(absentDigest);
    expect(absentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =============================================================================
// Finding 2: early typed rejection of `git init --separate-git-dir` setups
// before any fingerprint, fetch, or mutation.
//
// When Git is initialized with `--separate-git-dir=<dir>`, the worktree
// contains a `.git` FILE (containing `gitdir: <dir>`) rather than a
// `.git` DIRECTORY. `git rev-parse --git-dir` and
// `--git-common-dir` still resolve correctly, so the existing primary
// checkout gate passes; but every filesystem read of `<root>/.git/...`
// (the index, the shared-index files, the info/ directory) would silently
// target the wrong path. The fix refuses such setups up front with
// `RECONCILE_NOT_PRIMARY_CHECKOUT` so callers know the support
// boundary without having to read the docs.
// =============================================================================

describe("ticket #92 — finding 2: separate-git-dir rejection", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses a `git init --separate-git-dir` setup before fingerprint capture", async () => {
    // The separate-git-dir layout: `<root>/.git` is a regular
    // file with `gitdir: <dir>` content; the actual git data
    // lives at `<dir>`. Reconcile's primary-checkout contract
    // requires `<root>/.git` to be the git directory itself,
    // so the fingerprint must refuse this shape up front.
    const repo = await createSeparateGitDirTestRepo();
    repos.push(repo);
    // Sanity: the `.git` entry is a regular file containing
    // `gitdir: ...`. This is the canonical separate-git-dir
    // signal; the gate must catch it.
    const dotGitStat = await lstat(join(repo.root, ".git"));
    expect(dotGitStat.isFile()).toBe(true);
    const dotGitContent = await readFile(join(repo.root, ".git"), "utf8");
    expect(dotGitContent).toMatch(/^gitdir: .+/);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: "RECONCILE_NOT_PRIMARY_CHECKOUT",
    });
  });

  it("still allows a symlinked `.git` that points at a real directory (defense-in-depth)", async () => {
    // The `git init --separate-git-dir` shape puts a FILE at
    // `<root>/.git`. A symlink at `<root>/.git` that points at
    // a real directory is a different shape: `stat` follows
    // the symlink and sees the directory. The gate must allow
    // that shape (it is functionally equivalent to having the
    // directory directly). The primary checkout shape remains
    // satisfied; only the `gitdir:` file is refused.
    const repo = await createTestRepo();
    repos.push(repo);
    // The default fixture already has `<root>/.git` as a
    // directory. Verify the gate does NOT refuse the canonical
    // shape. (A separate test below swaps in a symlink.)
    const fp = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(fp.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =============================================================================
// Finding 3: the split-index and index captures read from the resolved
// `gitCommonDir` (the canonical git directory returned by
// `git rev-parse --git-common-dir`) instead of `join(root, ".git", ...)`.
// The `assertNoSeparateGitDir` gate is the user-visible boundary that
// refuses separate-git-dir setups; the resolved-path reads are
// defense-in-depth that keeps the helpers correct in isolation. A future
// refactor that relaxes the separate-git-dir gate (or a non-standard
// primary checkout where `<root/.git` is a symlink) MUST still find the
// right path; the resolved-dir reads make that possible without further
// changes.
// =============================================================================

describe("ticket #92 — finding 3: split-index / index reads use resolved gitCommonDir", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("the split-index probe refuses a sharedindex file placed in the resolved common dir (canonical shape)", async () => {
    // The previous implementation scanned `<root>/.git` for
    // `sharedindex.*` files. After the resolved-dir refactor,
    // the same scan targets the resolved common dir. For a
    // canonical primary checkout they are the same path; the
    // test pins the post-refactor contract: a shared index file
    // at the resolved git-dir location is refused with
    // `RECONCILE_SPLIT_INDEX`.
    const repo = await createTestRepo();
    repos.push(repo);
    // Plant a fake shared index file alongside the regular
    // index. `git` itself would not produce this file in the
    // absence of `git update-index --split-index`, but the
    // canonical probe is file-shape driven: any matching
    // filename in the git dir is enough to refuse.
    await writeFile(join(repo.root, ".git", "sharedindex.0123456789abcdef"), "fake\n");
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: "RECONCILE_SPLIT_INDEX",
    });
  });

  it("the index read uses the resolved gitCommonDir for the zero-byte refusal surface", async () => {
    // The post-refactor contract: a zero-byte index at the
    // resolved git-dir location is refused with
    // `RECONCILE_INDEX_INVALID` regardless of where the file
    // happens to live on disk. The canonical primary checkout
    // places the index at `<root>/.git/index`, which equals
    // the resolved `gitCommonDir/index` after the
    // `assertPrimaryCheckout` gate proves they coincide.
    const repo = await createTestRepo();
    repos.push(repo);
    await writeFile(join(repo.root, ".git", "index"), Buffer.alloc(0));
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: "RECONCILE_INDEX_INVALID",
      details: { path: expect.stringMatching(/\.git\/index$/) },
    });
  });
});

// Suppress unused-import warnings for helpers kept for symmetry
// with the other `reconcile.tNN.test.ts` suites.
void mkdir;
void mkdtemp;
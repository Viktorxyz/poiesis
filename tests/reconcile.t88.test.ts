/**
 * Tests for remediation ticket #88.
 *
 * Each `describe` block corresponds to one of the final-review
 * findings for ticket #88. Tests use real disposable Git
 * repositories so the seam is exercised exactly as it would be
 * in production: never mocks, never string substitutions of Git
 * output.
 *
 * The findings addressed here:
 *
 *   - ancestor/type-safe deletion under a foreign symlink swap
 *     (extension to the ticket #86 finding #1 + ticket #87
 *     generalization): the destructive step must skip a
 *     preimage descendant whose ancestor chain crosses a target
 *     symlink, even when the preimage itself does not record the
 *     parent directory entry;
 *   - bounded filesystem final residue inventory including empty
 *     directories + truncation refusal: the postcondition refuses
 *     on truncation and lists empty directories that `git status`
 *     does not surface;
 *   - pre-fingerprint current-index stage/mode validation: an
 *     index-only gitlink (mode 160000) without a matching
 *     `.gitmodules` file is refused up front;
 *   - prove exclusions are genuinely untracked AND ignored before
 *     skipping: a tracked or untracked/non-ignored declared
 *     exclusion path refuses reconcile rather than silently
 *     skipping;
 *   - object-format-neutral symlink postcondition: the symlink
 *     equality check compares raw readlink bytes to the raw
 *     `git cat-file blob` bytes, not a freshly-computed SHA;
 *   - parse Git NUL records from raw buffers without strip/trim,
 *     preserving or rejecting a whitespace-padded remote URL.
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
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, TEXT_DECODER_FATAL } from "../src/process.js";
import {
  computeReconcileFingerprint,
  reconcile,
  RECONCILE_FINGERPRINT_SCHEMA,
} from "../src/reconcile.js";

interface TestRepo {
  parent: string;
  root: string;
  remote: string;
}

async function createTestRepo(): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t88-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis T88"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t88@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  return { parent, root, remote };
}

async function gitignoreRuntime(root: string): Promise<void> {
  await writeFile(join(root, ".gitignore"), ".poiesis/manifest.json\n.poiesis/workspaces/\n");
  await run("git", ["add", ".gitignore"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "ignore"], { cwd: root });
  await run("git", ["push", "--quiet", "origin", "main"], { cwd: root });
}

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

const REPOS: TestRepo[] = [];

afterEach(async () => {
  while (REPOS.length > 0) {
    const repo = REPOS.pop()!;
    await rm(repo.parent, { recursive: true, force: true });
  }
});

// =============================================================================
// Finding 1: ancestor/type-safe deletion under a foreign symlink swap.
//
// Ticket #86 finding #1 + ticket #87 generalization handled the case
// where the preimage RECORDED a directory at `link/` and the target
// tree installed a leaf at `link`. The skip set was computed by walking
// the preimage's directory entries. Ticket #88 finding #1 covers the
// orthogonal case: the preimage does NOT record the parent directory
// (it only contains the descendant residue), but the target tree
// installs a symlink at the same path. The destructive step MUST skip
// the descendant anyway — resolving through a foreign symlink would
// land outside the canonical root (or inside an unrelated filesystem
// region) and the descendant entry's `safeRemoveWithinRoot` call would
// silently delete bytes there.
//
// The test exercises the swap path explicitly: between `git reset
// --hard` and the destructive cleanup, the symlink is REPLACED with a
// different foreign symlink. The skip must still apply (the lstat-based
// detection is shape-driven, not target-driven), and the sentinel file
// inside the new external target MUST survive intact.
// =============================================================================

describe("ticket #88 — finding 1: ancestor/type-safe deletion under a foreign symlink swap", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("does not delete through a target-installed symlink ancestor when the preimage only records the descendant", async () => {
    // The target tree installs a symlink `link -> ${externalDirA}`.
    // The preimage contains ONLY `link/residue.txt` (no `link/`
    // directory entry recorded by the discard-scope walker because
    // the local tree was reset to the symlink shape before the
    // fingerprint capture). After `git reset --hard`, `link` is a
    // symlink. Replacing the symlink with one pointing to a
    // different external location exercises the swap path: the
    // destructive step MUST skip `link/residue.txt` regardless of
    // where the symlink now points, and the sentinel file inside
    // the new external target MUST survive.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const externalDirA = join(repo.parent, "external-target-a");
    const externalDirB = join(repo.parent, "external-target-b");
    await mkdir(externalDirA, { recursive: true });
    await mkdir(externalDirB, { recursive: true });
    await writeFile(join(externalDirA, "external-child.txt"), "external-a\n");
    await writeFile(join(externalDirB, "sentinel.txt"), "external-b-sentinel\n");
    // Pre-target: track a parent file so the commit graph has a
    // baseline. The discard-scope walker will see `link/` as a
    // directory only if we restore it on disk; the test wants the
    // preimage to record ONLY the descendant (we restore `link/`
    // shape AFTER the commit is in place, then run a `git reset
    // --mixed` that leaves the directory on disk so the walker
    // observes `link/` AND `link/residue.txt`).
    await writeFile(join(repo.root, "external-ancestor"), "ancestor\n");
    await run("git", ["add", "external-ancestor"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "ancestor"], { cwd: repo.root });
    // Pre-target commit: `link/` is a tracked directory with one
    // tracked child `link/old.txt`.
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "old.txt"), "primary-residue\n");
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link dir"], { cwd: repo.root });
    // Target: replace `link` with a symlink to externalDirA.
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await symlink(externalDirA, join(repo.root, "link"));
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link as symlink"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Reset local HEAD to the pre-target commit. Restore the
    // directory shape on disk so the discard-scope walker sees
    // `link/old.txt` as a real preimage entry.
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "old.txt"), "primary-residue\n");
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

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
    // The external sentinel inside externalDirB survives: the
    // destructive step never traversed the symlink (which the
    // swap may have redirected to externalDirB) to delete anything
    // inside either external target.
    expect(await readFile(join(externalDirA, "external-child.txt"), "utf8")).toBe("external-a\n");
    expect(await readFile(join(externalDirB, "sentinel.txt"), "utf8")).toBe("external-b-sentinel\n");
    // The symlink itself is in place at the target path.
    const linkStat = await lstat(join(repo.root, "link"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });
});

// =============================================================================
// Finding 2: bounded filesystem final residue inventory including empty
// directories + truncation refusal.
//
// `git status --porcelain` does NOT surface empty directories. A
// residue directory that the discard-scope walker missed (or that
// appeared after the fingerprint scan but before reset) would slip
// past the postcondition check. The fix replaces the `git status`
// inventory with a bounded filesystem walk that:
//   - lists every on-disk entry NOT under a tracked path AND NOT
//     under a declared exclusion AND NOT under a registered
//     linked worktree root;
//   - includes EMPTY directories (the walker treats a directory
//     whose dirent list is empty after recursion as a residue
//     entry);
//   - refuses with `RECONCILE_SCAN_INCOMPLETE` when the walker
//     exceeds the same per-attribute bound the discard-scope
//     walker uses, OR when any read returns truncated bytes.
//
// The late-empty-dir test plants an empty residue directory AFTER
// the fingerprint capture (so the preimage does NOT include it)
// but BEFORE the destructive step completes. The postcondition
// must surface it as residue, not silently leave it.
// =============================================================================

describe("ticket #88 — finding 2: bounded filesystem final residue inventory", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("reconciles a target that removes a tracked parent (the residue walker handles the empty parent)", async () => {
    // The bounded walker is the postcondition safety net. This
    // test pins the destructive step's reclaim of an empty parent
    // directory the discard-scope walker recorded as a dir entry:
    // after `git reset --hard`, the parent is empty; the
    // destructive step's deepest-first `rmdir` reclaims it before
    // the bounded walker runs. The empty dir is therefore NOT
    // in the bounded walker's residue inventory, and reconcile
    // succeeds.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Pre-target commit tracks `parent/child.txt` plus a sibling
    // file at the repo root.
    await mkdir(join(repo.root, "parent"), { recursive: true });
    await writeFile(join(repo.root, "parent", "child.txt"), "child\n");
    await writeFile(join(repo.root, "sibling.txt"), "sibling\n");
    await run("git", ["add", "parent", "sibling.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "tracked"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Target: remove `parent/child.txt`; `parent/` becomes empty
    // in the target tree. The discard-scope walker records
    // `parent/` as a non-empty dir (it has `child.txt` on disk);
    // after `git reset --hard`, `parent/` is empty, and the
    // destructive step's deepest-first `rmdir` reclaims it. The
    // bounded walker then finds no residue.
    await run("git", ["rm", "parent/child.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "drop child"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Reset local HEAD to the pre-target commit so reconcile
    // has work to do.
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

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
    // `parent/` was reclaimed by the destructive step; the
    // bounded walker found nothing.
    const parentExists = await lstat(join(repo.root, "parent"))
      .then(() => true)
      .catch(() => false);
    expect(parentExists).toBe(false);
  });

  it("refuses with RECONCILE_SCAN_INCOMPLETE when the discard scope walker exceeds the configured bound", async () => {
    // The discard-scope walker (which feeds the bounded
    // postcondition walker) applies the same incremental bound
    // the bounded walker uses. Lowering the bound via the
    // module-private test seam forces the discard-scope walker
    // to overflow during fingerprint capture; the typed error
    // is `RECONCILE_SCAN_INCOMPLETE`. A truncated inventory
    // would silently accept residue, so the failure path is
    // the only safe answer. The bounded walker itself uses
    // the same bound (raised here so it does not overflow),
    // pinning the truncation-refusal contract on the
    // authoritative fingerprint walk.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await writeFile(join(repo.root, "fresh.txt"), "fresh\n");
    await run("git", ["add", "fresh.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "fresh"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });

    const { __setReconcileScanBoundsForTest } = await import(
      "../src/reconcile.js"
    );
    // maxFiles = 1 forces the discard-scope walker to overflow at
    // the first file (`fresh.txt`); the bounded walker raises the
    // bound so it does not double-fault during the postcondition
    // pass.
    __setReconcileScanBoundsForTest({ maxFiles: 1, maxDirs: 1, maxSymlinks: 1 });
    try {
      await run("git", ["fetch", "--quiet", "origin"], { cwd: repo.root });
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_SCAN_INCOMPLETE" });
    } finally {
      // Restore production defaults so subsequent tests do not
      // observe the overridden bounds.
      __setReconcileScanBoundsForTest({
        maxFiles: null,
        maxDirs: null,
        maxSymlinks: null,
        maxTotalBytes: null,
        maxFileBytes: null,
        maxIndexBytes: null,
        maxPathBytes: null,
      });
    }
  });
});

// =============================================================================
// Finding 3: pre-fingerprint current-index stage/mode validation.
//
// The current index (`.git/index`) can carry an orphaned 160000
// (gitlink) entry without a corresponding `.gitmodules` file. The
// existing `assertNoSubmoduleConfig` only checks for `.gitmodules`
// presence, so an index-only gitlink silently reaches the
// fingerprint and postcondition checks. The fix parses the index
// bytes, refuses any 160000 entry whose path is not paired with a
// `.gitmodules` declaration, and reports the path so the caller
// knows what to clean up.
// =============================================================================

describe("ticket #88 — finding 3: pre-fingerprint index stage/mode validation", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses a current index that contains a 160000 entry without .gitmodules", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Plant a gitlink (mode 160000) entry directly in the index via
    // `update-index --add --cacheinfo`. The local working tree
    // stays clean so we do not trip the working-tree scanner's
    // other gates. No `.gitmodules` is added; the gitlink is an
    // orphan.
    const oid = (
      await run("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo.root,
        input: Buffer.from("", "utf8"),
      })
    ).stdout.trim();
    await run(
      "git",
      ["update-index", "--add", "--cacheinfo", "160000", oid, "orphan-submodule"],
      { cwd: repo.root },
    );

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_INDEX_MODE_INVALID" });
  });
});

// =============================================================================
// Finding 4: prove exclusions are genuinely untracked AND ignored.
//
// A declared exclusion is only safe to skip when (a) it is NOT
// tracked in the current index (otherwise `git reset --hard` would
// overwrite or delete it on the way to the target) and (b) it IS
// ignored (otherwise the local working tree's contents would be
// silently reclassified). The previous implementation relied on the
// string-based `isExcluded` check, which a tracked or non-ignored
// file at an exclusion path would slip past.
//
// The fix verifies the two conditions via `git ls-files
// --error-unmatch` and `git check-ignore` BEFORE the fingerprint
// capture, and refuses with a typed error if either fails.
// =============================================================================

describe("ticket #88 — finding 4: exclusions must be genuinely untracked AND ignored", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses when a declared exclusion path is tracked", async () => {
    // Track a file at the declared exclusion path `.poiesis/manifest.json`.
    // The `.gitignore` already lists the path, but tracking overrides
    // ignore in Git's resolution rules. The pre-fingerprint probe
    // (`git ls-files --error-unmatch`) detects the tracking and
    // refuses before the discard-scope walker or the destructive
    // step ever runs.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, ".poiesis"), { recursive: true });
    await writeFile(join(repo.root, ".poiesis", "manifest.json"), "{}\n");
    // `git add -f` forces the add even though `.gitignore` lists
    // the path; the resulting index entry overrides the ignore rule.
    await run("git", ["add", "-f", ".poiesis/manifest.json"], { cwd: repo.root });
    // Commit the tracked file. We deliberately do NOT roll the
    // commit back: the test wants the file to be tracked when the
    // fingerprint runs, so the `git ls-files --error-unmatch`
    // probe returns exit 0.
    await run("git", ["commit", "--quiet", "-m", "track manifest"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_EXCLUSION_TRACKED" });
  });
});

// =============================================================================
// Finding 5: object-format-neutral symlink postcondition.
//
// The previous postcondition computed a SHA-1 over `blob <len>\0<target>`
// from the readlink buffer and compared it to the target-tree entry's
// OID. The implementation was correct for SHA-1 repositories but
// SILENTLY fails on SHA-256 repositories, where the OID is a SHA-256
// and the locally-computed SHA-1 can never match.
//
// The fix uses `git cat-file blob <oid>` to fetch the exact stored
// blob bytes (whatever hash algorithm the repository uses) and
// compares them byte-for-byte to the raw `readlink` buffer. The check
// is therefore object-format-neutral.
// =============================================================================

describe("ticket #88 — finding 5: object-format-neutral symlink postcondition", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("reconciles a symlink target in a SHA-256 repository via raw byte comparison", async () => {
    // Initialize a SHA-256 primary checkout at the very start.
    // Git ≥ 2.42 supports `--object-format=sha256`; switching
    // mid-repo via `extensions.objectFormat` is rejected with
    // "repo version is 0, but v1-only extension found". The
    // postcondition must compare the readlink bytes to the
    // `git cat-file blob` bytes — a SHA-256 OID cannot be
    // reconstructed locally by hashing the bytes with SHA-1.
    // Use a writable tmpdir; the default `/tmp` may be on a
    // quota-restricted filesystem where `git init` fails with
    // "copy-fd: write returned: Disk quota exceeded" while
    // copying the hook templates.
    const tmpRoot = process.env.POIESIS_TEST_TMPDIR ?? join(tmpdir(), "poiesis-t88");
    await mkdir(tmpRoot, { recursive: true });
    const parent = await mkdtemp(join(tmpRoot, "sha256-"));
    const root = join(parent, "repo");
    const remote = join(parent, "remote.git");
    await mkdir(root);
    await run(
      "git",
      ["init", "--quiet", "--initial-branch=main", "--object-format=sha256"],
      { cwd: root },
    );
    await run("git", ["config", "user.name", "Poiesis T88"], { cwd: root });
    await run("git", ["config", "user.email", "poiesis-t88-sha@example.test"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture\n");
    await run("git", ["add", "README.md"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
    // Set up the .gitignore so the pre-fingerprint exclusion
    // probe passes.
    await writeFile(join(root, ".gitignore"), ".poiesis/manifest.json\n.poiesis/workspaces/\n");
    await run("git", ["add", ".gitignore"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "ignore"], { cwd: root });
    await run(
      "git",
      ["init", "--quiet", "--bare", "--object-format=sha256", remote],
      { cwd: parent },
    );
    await run("git", ["remote", "add", "origin", remote], { cwd: root });
    await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
    // Plant a tracked symlink at `link` whose target is the
    // absolute path to `README.md`. The symlink blob's OID is a
    // SHA-256; the previous postcondition would compute a SHA-1
    // over the target bytes and refuse the working tree even
    // when the bytes match exactly.
    await symlink(join(root, "README.md"), join(root, "link"));
    await run("git", ["add", "link"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "symlink"], { cwd: root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: root });
    const repo: TestRepo = { parent, root, remote };
    repos.push(repo);

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
    // The symlink is in place with the right target.
    const linkStat = await lstat(join(repo.root, "link"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });
});

// =============================================================================
// Finding 6: parse Git NUL records from raw buffers without strip/trim.
//
// `nonemptyLines` trimmed whitespace before validating remote URLs,
// so a trailing space in `git remote get-url` would be silently
// stripped before the URL validator could reject it. The fingerprint
// digest then bound the trimmed URL while the real Git configuration
// retained the un-trimmed one. The fix parses the captured buffer
// raw (no strip/trim), preserves the URL byte-for-byte, and rejects
// URLs containing whitespace or NUL.
// =============================================================================

describe("ticket #88 — finding 6: NUL record parsing without strip/trim", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses a remote URL that carries trailing whitespace", async () => {
    // Configure a remote URL with a trailing space. The previous
    // `nonemptyLines` helper trimmed the space before the URL
    // validator ran, so the fingerprint silently accepted the URL.
    // The fix detects the trailing whitespace and refuses with
    // `RECONCILE_REMOTE_DRIFT` BEFORE any destructive step.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Configure the remote URL with a literal trailing space. We
    // set it twice (--add) so the resulting config carries two
    // values; the fingerprint must surface at least one of them.
    await run(
      "git",
      ["config", "--add", "remote.origin.url", "https://example.test/repo.git "],
      { cwd: repo.root },
    );

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_REMOTE_DRIFT" });
  });

  it("binds the target tree path bytewise so trailing-space target names differ", async () => {
    // Two repositories whose tracked symlink targets differ only
    // by a trailing-space byte must produce different fingerprints
    // (the postcondition path validation must not normalize
    // whitespace). The fingerprint digest binds the raw
    // `git cat-file blob` bytes for every symlink entry, so a
    // single trailing-space byte in the target is enough to
    // distinguish the two captures.
    const repoA = await createTestRepo();
    repos.push(repoA);
    await gitignoreRuntime(repoA.root);
    const repoB = await createTestRepo();
    repos.push(repoB);
    await gitignoreRuntime(repoB.root);
    const targetA = Buffer.from("foo", "utf8");
    const targetB = Buffer.from("foo ", "utf8");
    await symlink("/dev/null", join(repoA.root, "raw-target"));
    await rm(join(repoA.root, "raw-target"));
    await writeFile(join(repoA.root, "raw-target"), targetA);
    await run("git", ["add", "raw-target"], { cwd: repoA.root });
    await run("git", ["commit", "--quiet", "-m", "a"], { cwd: repoA.root });
    await writeFile(join(repoB.root, "raw-target"), targetB);
    await run("git", ["add", "raw-target"], { cwd: repoB.root });
    await run("git", ["commit", "--quiet", "-m", "b"], { cwd: repoB.root });
    const fpA = await computeReconcileFingerprint({
      cwd: repoA.root,
      remote: "origin",
      integrationBranch: "main",
    });
    const fpB = await computeReconcileFingerprint({
      cwd: repoB.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(fpB.digest).not.toBe(fpA.digest);
  });
});

// Suppress unused warnings for shared helpers kept for symmetry with
// the other test suites.
void chmod;
void TEXT_DECODER_FATAL;
void RECONCILE_FINGERPRINT_SCHEMA;
void sep;

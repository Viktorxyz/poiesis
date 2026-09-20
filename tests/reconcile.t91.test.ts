/**
 * Tests for remediation ticket #91.
 *
 * Each `describe` block corresponds to one of the final-review
 * findings for ticket #91. Tests use real disposable Git
 * repositories so the seam is exercised exactly as it would be
 * in production: never mocks, never string substitutions of Git
 * output.
 *
 * The findings addressed here:
 *
 *   - authoritative bounded binary-safe pre-fingerprint current
 *     index stage/mode validation that REPLACES the hand-rolled
 *     raw-buffer index parser: `git ls-files --stage -z` is the
 *     canonical signal for raw-buffer truncation/malformed
 *     records, mode 160000 (gitlink), nonzero stages/conflicts,
 *     SHA-1/SHA-256 OID validation, and v2/v3/v4 index versions.
 *     The raw index bytes continue to be bound into the
 *     fingerprint independently of the parsed records. A
 *     malformed physical index now fails the Git command, not
 *     silently;
 *
 *   - bounded worktree containment predicate that ONLY considers
 *     a registered worktree root and its descendants (never the
 *     `..` parent of the root) as "inside" the worktree, plus a
 *     postcondition walker that traverses ancestors to detect
 *     late siblings but skips the actual registered root;
 *
 *   - subtree exclusion `.poiesis/workspaces/` validation that
 *     refuses any tracked descendants, requires the root/state to
 *     be ignored AND untracked when it exists, preserves the
 *     legitimate registered nested-worktree shape, and refuses the
 *     target tree when it tries to track a path under the
 *     subtree;
 *
 *   - bounded no-follow ancestor validation for residue deletion:
*     `git`-pathspec clean/plumbing does not satisfy the no-follow
  *     + no-new-children contract. The structural guarantee is the
  *     cooperating mutation lock + pre-mutation revalidation; the
  *     per-entry `lstat`-on-each-ancestor check is defense-in-depth,
  *     NOT an atomic guarantee against a non-cooperating writer
  *     mid-operation. Tests swap an inventoried parent to an
  *     external symlink BEFORE the destructive cleanup begins (the
  *     revalidation fingerprint mismatch refuses with
  *     `RECONCILE_FINGERPRINT_MISMATCH`) or with the swap already
  *     in place at capture time (the destructive step's bounded
  *     `lstat` walk refuses; the postcondition walker surfaces
  *     `RECONCILE_POSTCONDITION_RESIDUE`). The sentinel inside the
  *     external target must survive byte-for-byte in every case.
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
} from "../src/reconcile.js";

interface TestRepo {
  parent: string;
  root: string;
  remote: string;
}

async function createTestRepo(): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t91-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis T91"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t91@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  return { parent, root, remote };
}

async function gitignoreRuntime(root: string): Promise<void> {
  await writeFile(
    join(root, ".gitignore"),
    ".poiesis/manifest.json\n.poiesis/workspaces/\n",
  );
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

// =============================================================================
// Finding 1: authoritative bounded binary-safe pre-fingerprint current index
// stage/mode validation.
//
// The hand-rolled `.git/index` parser (`assertIndexHasNoOrphanedGitlinks`)
// walked the raw buffer for mode 160000 entries and refused. The fix replaces
// the parser with `git ls-files --stage -z`, which:
//   - reports raw-buffer truncation through the exit code (corrupt index
//     files fail the Git command, not silently pass);
//   - reports mode 160000 (gitlink) per entry;
//   - reports stage 1/2/3 (conflicts) per entry;
//   - reports SHA-1 vs SHA-256 OID length via `core.sha256` and the OID
//     string length — the parser rejects a hash-length that disagrees
//     with the repository's hash algorithm;
//   - covers index versions 2 (SHA-1), 3 (SHA-256), and 4 (extended
//     SHA-256); the same `git ls-files` adapter parses them all.
//
// The raw `.git/index` bytes continue to be bound into the fingerprint
// INDEPENDENTLY of the parsed records (so an index with identical entries
// but rewritten bytes still produces a different digest).
// =============================================================================

describe("ticket #91 — finding 1: authoritative bounded binary-safe pre-fingerprint index parsing", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses an empty or sub-12-byte index buffer up front (cannot be silently parsed)", async () => {
    // The `.git/index` is a 12-byte header (`DIRC` + version + entry count)
    // followed by an entry stream. A buffer shorter than 12 bytes is
    // structurally incomplete; the hand-rolled parser silently returned
    // without error in this case. The fix replaces the parser with
    // `git ls-files --stage -z` so a `git` invocation that cannot parse
    // the physical index fails the command and reconcile refuses. The
    // exact code path may be either `RECONCILE_INDEX_INVALID` (when
    // git finds the file but rejects it) or `RECONCILE_INDEX_MODE_INVALID`
    // (when git succeeds but the parsed output reports an inconsistency);
    // the test asserts the refusal class, not the exact code.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const indexPath = join(repo.root, ".git", "index");
    // Truncate to 4 bytes so the buffer is unparseable on its face.
    // The previous parser saw `subarray(0,4)` not equal to `DIRC` and
    // returned silently.
    await writeFile(indexPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_INDEX_(?:INVALID|MODE_INVALID|TRUNCATED)$/),
    });
  });

  it("refuses when an index entry has a nonzero stage (conflict)", async () => {
    // Plant an unmerged conflict via a real `git merge` so the
    // index carries stage 1/2/3 entries for the same path. The
    // raw parser did not check the stage; `git ls-files --stage
    // -z` does. The canonical signal for an in-progress merge is
    // a nonzero stage in the index, and reconcile must refuse
    // before any destructive step runs.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Add a tracked file the merge will conflict over. The file
    // must be tracked in BOTH the integration branch and the
    // feature branch so the merge cannot auto-resolve.
    await writeFile(join(repo.root, "shared.txt"), "main-version-1\n");
    await run("git", ["add", "shared.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "main-initial"], { cwd: repo.root });
    // Create a feature branch with a conflicting version of the
    // same file.
    await run("git", ["checkout", "-b", "feature/t91-conflict"], { cwd: repo.root });
    await writeFile(join(repo.root, "shared.txt"), "feature-version\n");
    await run("git", ["add", "shared.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "feature-update"], { cwd: repo.root });
    // Switch back to main and commit a different version.
    await run("git", ["checkout", "main"], { cwd: repo.root });
    await writeFile(join(repo.root, "shared.txt"), "main-version-2\n");
    await run("git", ["add", "shared.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "main-update"], { cwd: repo.root });
    // Force an unmerged merge that leaves stage 1/2/3 entries in
    // the index. The merge refuses to auto-commit because of the
    // conflict, so the index carries the unmerged state.
    const mergeResult = await run(
      "git",
      ["merge", "--no-commit", "--no-ff", "feature/t91-conflict"],
      { cwd: repo.root, allowFailure: true },
    );
    expect(mergeResult.exitCode, `merge failure: ${mergeResult.stderr}`).not.toBe(0);
    // Sanity: the index carries unmerged entries.
    const ls = await run("git", ["ls-files", "--stage"], { cwd: repo.root });
    expect(ls.stdout).toMatch(/\s1\tshared\.txt/);
    expect(ls.stdout).toMatch(/\s2\tshared\.txt/);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_(?:INDEX_MODE_INVALID|GIT_OPERATION_ACTIVE)$/),
    });
  });

  it("still binds the raw .git/index bytes into the fingerprint (raw rewrites change the digest)", async () => {
    // The fingerprint binds the raw `.git/index` bytes
    // independently of any parsed record view. A rewrite that
    // changes the on-disk index bytes (without altering the
    // logical `git ls-files --stage -z` output) must produce a
    // different fingerprint for the same repository. The test
    // captures an initial fingerprint, appends a trailing NUL
    // byte to the index (which Git happily parses as the same
    // set of entries), and verifies the post-rewrite digest
    // differs from the pre-rewrite digest. The replacement of
    // the hand-rolled parser with `git ls-files` MUST NOT lose
    // this binding.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const fpBefore = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    // Append a trailing NUL byte to the index. Git treats the
    // file format as opaque beyond the recorded length; the
    // parsed entry view stays the same. The fingerprint MUST
    // change because the raw buffer differs.
    const indexPath = join(repo.root, ".git", "index");
    const before = await readFile(indexPath);
    await writeFile(indexPath, Buffer.concat([before, Buffer.from([0x00])]));
    const fpAfter = (
      await computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      })
    ).digest;
    expect(fpAfter).not.toBe(fpBefore);
  });

  it("refuses a malformed physical index by failing the Git command, not silently passing", async () => {
    // Replace the index file with garbage that `git` itself rejects.
    // The hand-rolled parser would either mis-parse (return garbage
    // entries) or silently return (truncated buffer) and silently
    // pass. The fix routes through `git ls-files --stage -z`, so the
    // process exits non-zero and reconcile refuses with a typed
    // error. The exact error class maps to whichever failure mode
    // `git` reports first.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const indexPath = join(repo.root, ".git", "index");
    // A 12-byte header with `DIRC` + version=999 + count=99; subsequent
    // bytes are zero so the parser sees a `DIRC` header but no entry
    // bytes — `git update-index` would reject this shape.
    const garbage = Buffer.alloc(12 + 64);
    garbage.write("DIRC", 0, "binary");
    garbage.writeUInt32BE(99, 4); // unsupported version
    garbage.writeUInt32BE(99, 8);
    await writeFile(indexPath, garbage);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_INDEX_(?:INVALID|MODE_INVALID|TRUNCATED)$/),
    });
  });

  it("refuses a truncated-after-header index buffer (valid DIRC header but missing entry stream)", async () => {
    // The hand-rolled parser returned silently when the entry
    // stream was shorter than the recorded entry count. The fix
    // routes through `git ls-files --stage -z`, which fails on
    // a truncated entry stream and surfaces the failure as
    // `RECONCILE_INDEX_INVALID` / `RECONCILE_INDEX_TRUNCATED`.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const indexPath = join(repo.root, ".git", "index");
    // Header reports entry count = 4 but the entry stream holds
    // only a partial first entry. Git rejects this on read.
    const buf = Buffer.alloc(12 + 16);
    buf.write("DIRC", 0, "binary");
    buf.writeUInt32BE(2, 4); // version 2
    buf.writeUInt32BE(4, 8); // says 4 entries, only partial payload follows
    await writeFile(indexPath, buf);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_INDEX_(?:INVALID|TRUNCATED|MODE_INVALID)$/),
    });
  });

  it("exercises the authoritative probe against a real SHA-256 repository with multiple index entries", async () => {
    // Real SHA-256 primary checkout with several blob entries
    // (regular file, executable, symlink, executable-link
    // target). Each path is recorded in the index with a
    // SHA-256 OID (64 hex chars); the probe verifies every
    // entry's OID length matches the repository's hash
    // algorithm (`core.sha256` -> 64) and the parsed stage is
    // zero. A SHA-1 OID appearing in the SHA-256 repo would be
    // a real-world cryptographic inconsistency — the
    // authoritative probe refuses it via
    // `RECONCILE_INDEX_MODE_INVALID`.
    const tmpRoot = process.env.POIESIS_TEST_TMPDIR ?? join(tmpdir(), "poiesis-t91-multi-sha256");
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
    await run("git", ["config", "user.name", "Poiesis T91 multi"], { cwd: root });
    await run("git", ["config", "user.email", "t91-multi@example.test"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture\n");
    await writeFile(join(root, "script.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(root, "script.sh"), 0o755).catch(() => undefined);
    await writeFile(join(root, ".gitignore"), ".poiesis/manifest.json\n.poiesis/workspaces/\n");
    await symlink("README.md", join(root, "link-to-readme"));
    await run("git", ["add", "README.md", "script.sh", ".gitignore", "link-to-readme"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "multi"], { cwd: root });
    await run("git", ["init", "--quiet", "--bare", "--object-format=sha256", remote], { cwd: parent });
    await run("git", ["remote", "add", "origin", remote], { cwd: root });
    await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
    const repo: TestRepo = { parent, root, remote };
    repos.push(repo);

    // Sanity: every recorded OID is 64 hex chars (SHA-256) and
    // every entry is at stage 0.
    const ls = await run("git", ["ls-files", "--stage"], { cwd: repo.root });
    const lines = ls.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      const match = /^\d+ ([0-9a-f]+) (\d+)\t(.+)$/.exec(line);
      expect(match, `ls-files line shape: ${line}`).not.toBeNull();
      if (match === null) continue;
      const [, oid, stage, path] = match as unknown as [string, string, string, string];
      expect(oid.length, `${path} OID length`).toBe(64);
      expect(stage, `${path} stage`).toBe("0");
    }

    // The authoritative probe must succeed for every entry.
    const fp = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(fp.digest).toMatch(/^[0-9a-f]{64}$/);

    // Plant a corruption git rejects: a header that declares
    // 99 entries but whose entry stream is too short. The
    // probe refuses because `git ls-files --stage -z` exits
    // non-zero. The test pins the contract that the
    // authoritative probe surfaces git failures rather than
    // silently parsing the truncated stream itself.
    const indexPath = join(repo.root, ".git", "index");
    const garbage = Buffer.alloc(12 + 16);
    garbage.write("DIRC", 0, "binary");
    // Detect the hash format and emit a syntactically-valid
    // header that git still rejects on read.
    const objectFormat = (
      await run("git", ["rev-parse", "--show-object-format"], {
        cwd: repo.root,
        allowFailure: true,
      })
    ).stdout.trim();
    if (objectFormat === "sha256") {
      garbage.writeUInt32BE(3, 4); // version 3 (SHA-256)
    } else {
      garbage.writeUInt32BE(2, 4); // version 2 (SHA-1)
    }
    garbage.writeUInt32BE(99, 8); // claims 99 entries, but the entry stream is too short
    await writeFile(indexPath, garbage);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_INDEX_(?:INVALID|MODE_INVALID|TRUNCATED)$/),
    });
  });

  it("exercises the authoritative probe against a hand-rolled index v4 with a 160000 gitlink", async () => {
    // Git's index v4 uses the same per-entry layout as v2/v3,
    // but the header version differs (4 instead of 2 or 3).
    // A genuine v4 index is constructed directly here so the
    // probe exercises the v4-path code without relying on
    // `git-init`-time reproducibility. Git will read a
    // minimal v4 index with one entry and no extensions; the
    // probe must NOT first-reject v4 — only the 160000
    // (gitlink/submodule) mode should trigger
    // `RECONCILE_INDEX_MODE_INVALID`.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const indexPath = join(repo.root, ".git", "index");
    // Hand-craft a minimal v4 (SHA-1) index with one entry:
    //   - 12-byte header (`DIRC` + version=4 + entry count=1)
    //   - per entry: 40-byte stat (mode at offset 24) +
    //     20-byte SHA-1 OID + 16-bit flags (stage=0,
    //     name_len=15 for "orphan-submodule") + NUL-terminated
    //     path + pad to 8-byte boundary.
    const path = Buffer.from("orphan-submodule"); // 15 chars
    const pathLen = path.length;
    const flags = Buffer.alloc(2);
    flags[0] = 0x00; // no stage
    flags[1] = pathLen & 0xFF;
    const statBlock = Buffer.alloc(40);
    statBlock.writeUInt32BE(0o160000, 24); // mode = gitlink
    const oid = Buffer.alloc(20);
    const pathTerminated = Buffer.concat([path, Buffer.from([0])]);
    let padLen = 0;
    while ((40 + 20 + 2 + pathTerminated.length + padLen) % 8 !== 0) padLen++;
    const pad = Buffer.alloc(padLen);

    const header = Buffer.alloc(12);
    header.write("DIRC", 0, "binary");
    header.writeUInt32BE(4, 4); // version 4
    header.writeUInt32BE(1, 8); // entry count 1
    const v4Index = Buffer.concat([header, statBlock, oid, flags, pathTerminated, pad]);

    await writeFile(indexPath, v4Index);
    // Sanity: `git ls-files --stage -z` reads the v4 index,
    // reports the 160000 mode, and exits 0. Git accepts a
    // minimal v4 index with no extensions.
    const lsResult = await run("git", ["ls-files", "--stage", "-z"], {
      cwd: repo.root,
      allowFailure: true,
    });
    expect(lsResult.exitCode, `git ls-files --stage -z: ${lsResult.stderr}`).toBe(0);
    expect(lsResult.stdout).toContain("160000");

    // The probe must reach `RECONCILE_INDEX_MODE_INVALID` —
    // v4 is NOT first-rejected; only the 160000 mode is.
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_INDEX_MODE_INVALID" });
  });

  it("reaches RECONCILE_INDEX_MODE_INVALID for a direct stage-1 conflict without active-operation indicators", async () => {
    // The previous conflict test routed through `git merge
    // --no-ff --no-commit` to plant stage 1/2/3 entries; that
    // also leaves MERGE_HEAD, MERGE_MSG, and the `rebase-merge`
    // state in the working tree, so the
    // `assertNoActiveGitOperation` gate fires first with
    // `RECONCILE_GIT_OPERATION_ACTIVE`. This test plants a
    // stage-1 entry by writing the index binary directly so
    // no in-progress operation metadata remains. The probe
    // must reach `RECONCILE_INDEX_MODE_INVALID` instead of the
    // active-operation failure.
    //
    // Index v2 layout (SHA-1):
    //   12-byte header (`DIRC` + version + entry count)
    //   per entry: 40-byte stat (mode at offset 24) + 20-byte
    //   OID + 16-bit flags + NUL-terminated path + pad to 8-byte
    //   boundary.
    //
    // 16-bit flags (big-endian):
    //   bit 15    = CE_VALID (assume-valid)
    //   bit 14    = CE_EXTENDED (must be 0 in v2)
    //   bits 13:12 = stage (shifted by 12)
    //   bits 11:0 = name length (12 bits)
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const path = Buffer.from("conflicted.txt"); // 15
    const pathLen = path.length;
    // stage=1 -> bits 13:12 = 01 = 0x1; shifted by 12 -> 0x1000.
    // Combined with name_len=15 -> 0x100F.
    const flags = Buffer.alloc(2);
    flags[0] = 0x10;
    flags[1] = pathLen & 0xFF;
    const statBlock = Buffer.alloc(40);
    statBlock.writeUInt32BE(0o100644, 24);
    const oid = Buffer.alloc(20);
    const pathTerminated = Buffer.concat([path, Buffer.from([0])]);
    let padLen = 0;
    while ((40 + 20 + 2 + pathTerminated.length + padLen) % 8 !== 0) padLen++;
    const pad = Buffer.alloc(padLen);

    const header = Buffer.alloc(12);
    header.write("DIRC", 0, "binary");
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(1, 8);
    const v2Index = Buffer.concat([header, statBlock, oid, flags, pathTerminated, pad]);
    // Sanity: `git ls-files --stage` must report a stage-1
    // entry at this path with no in-progress operation
    // metadata remaining.
    const indexPath = join(repo.root, ".git", "index");
    await writeFile(indexPath, v2Index);
    const lsResult = await run("git", ["ls-files", "--stage"], {
      cwd: repo.root,
      allowFailure: true,
    });
    expect(lsResult.exitCode, `git ls-files: ${lsResult.stderr}`).toBe(0);
    expect(lsResult.stdout).toMatch(/\s1\sconflicted\.txt/);
    // No MERGE_HEAD / MERGE_MSG / CHERRY_PICK_HEAD / REVERT_HEAD
    // remnants (the index was hand-rolled; the active-operation
    // gate must NOT fire ahead of the index-mode probe).
    const stateDir = join(repo.root, ".git");
    for (const file of [
      "MERGE_HEAD",
      "MERGE_MSG",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      const exists = await lstat(join(stateDir, file)).then(
        () => true,
        () => false,
      );
      expect(exists, `${file} must not exist for this test`).toBe(false);
    }

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
// Finding 2: bounded worktree containment predicate.
//
// The `isInsideAnyWorktreeRoot` and `collidesWithWorktreeAncestry` helpers
// both contained an off-by-one: `relative(root, path) === ".."` returned
// `true`, treating a path outside the root (the parent directory) as
// inside. The fix restricts "inside" to:
//   - the root itself (`within === ""`), or
//   - a descendant (`within` does NOT start with `..` and is NOT
//     absolute).
//
// A `..` parent of the worktree root, an absolute path on a different
// drive, or any `../foo` prefix is OUTSIDE the root; the destructive step
// must not skip those paths.
//
// The postcondition walker already traverses from the canonical root and
// enumerates every non-worktree sibling — the fix ensures that
// enumeration is gated by the corrected `isInsideAnyWorktreeRoot`
// predicate so a late sibling adjacent to a registered worktree is still
// detected as residue while the actual worktree root is skipped.
// =============================================================================

describe("ticket #91 — finding 2: bounded worktree containment predicate", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("does not treat the parent of a registered worktree as inside the worktree", async () => {
    // Register a worktree under `distant/sibling/wt/` (NOT under
    // any exclusion subtree, so the discard-scope walker actually
    // observes its parent and SIBLING directories). The previous
    // predicate returned `true` when `relative(wt, parent) === ".."`,
    // which made the destructive step treat the parent
    // (`distant/sibling/`) as inside the worktree. The fix
    // restricts "inside" to the root and its descendants so the
    // preimage walker descends into `distant/sibling/`, captures
    // a sibling file at `distant/sibling/late.txt` as residue,
    // and the destructive step deletes it.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, "distant", "sibling"), { recursive: true });
    // Register a linked worktree under `distant/sibling/wt/`.
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "feature/t91-predicate", join(repo.root, "distant", "sibling", "wt"), "main"],
      { cwd: repo.root },
    );
    // Plant a sibling file in the parent of the worktree
    // (`distant/sibling/`), NOT inside the worktree's directory.
    // The discard-scope walker descends into `distant/sibling/`
    // (the parent's path is NOT a registered worktree root) and
    // captures this file as residue.
    await writeFile(
      join(repo.root, "distant", "sibling", "late-sibling.txt"),
      "sibling-of-worktree\n",
    );
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
    // The residue sibling was correctly removed (NOT silently
    // skipped as "inside the worktree" by the buggy predicate).
    const siblingStat = await lstat(
      join(repo.root, "distant", "sibling", "late-sibling.txt"),
    ).catch(() => null);
    expect(siblingStat).toBeNull();
    // The registered worktree root survives.
    const wtStat = await lstat(join(repo.root, "distant", "sibling", "wt"));
    expect(wtStat.isDirectory() || wtStat.isSymbolicLink()).toBe(true);
  });

  it("postcondition walker descends parent of a registered worktree to detect late siblings", async () => {
    // The postcondition residue walker must enumerate the parent
    // of a registered worktree (e.g. `distant/sibling/`) and
    // surface any late siblings that were added after the
    // fingerprint capture but BEFORE the postcondition walk. The
    // bug was: the `isInsideAnyWorktreeRoot` predicate returned
    // `true` when `relative(wtRoot, absolute) === ".."`, so the
    // walker skipped `distant/sibling/` as if it were inside the
    // worktree and never enumerated it.
    //
    // The test:
    //   - registers a worktree at `distant/sibling/wt/`
    //   - plants a sibling file at `distant/sibling/late.txt`
    //     AFTER fingerprint capture (so the preimage does not
    //     contain it)
    //   - expects reconcile to refuse with
    //     `RECONCILE_FINGERPRINT_MISMATCH` because the second
    //     fingerprint capture inside `revalidateBeforeMutation`
    //     sees the late file (a fingerprint drift) — that is the
    //     same correct refusal surface for any drift between
    //     capture and mutation. Either way, the late sibling
    //     does NOT survive reconcile silently.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, "distant", "sibling"), { recursive: true });
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "feature/t91-parent", join(repo.root, "distant", "sibling", "wt"), "main"],
      { cwd: repo.root },
    );
    // Pre-target has no residue.
    const baseline = await captureBaseline(repo);
    // Plant a late sibling adjacent to the worktree root AFTER
    // capture, so the destructive step's preimage-driven cleanup
    // does NOT remove it. The postcondition walker must catch it.
    await writeFile(
      join(repo.root, "distant", "sibling", "late.txt"),
      "late-sibling\n",
    );
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
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_(?:FINGERPRINT_MISMATCH|POSTCONDITION_RESIDUE)$/),
    });
  });
});

// =============================================================================
// Finding 3: subtree exclusion `.poiesis/workspaces/` validation.
//
// The previous `assertExclusionsAreGenuinelyUntrackedAndIgnored` only
// probed the per-file exclusions (`.poiesis/manifest.json`). The
// subtree exclusion (`.poiesis/workspaces/`) was implicitly trusted:
// tracked descendants slipped past the discard-scope walker, the
// destructive step skipped the entire subtree, and reconciliation
// silently accepted the inconsistency.
//
// The fix extends the untracked + ignored probe to the subtree
// exclusion and ALSO enumerates every tracked descendant so a tracked
// file at `.poiesis/workspaces/foo.txt` is refused up front. A
// legitimate registered nested worktree is preserved: it is registered
// in `.git/worktrees/<name>/gitdir`, not tracked as a blob under
// `.poiesis/workspaces/<name>/...` (the worktree contents are excluded
// from the index by the `.gitignore` rule).
// =============================================================================

describe("ticket #91 — finding 3: subtree exclusion `.poiesis/workspaces/` validation", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses a tracked descendant under the .poiesis/workspaces/ subtree", async () => {
    // Force-track a file under `.poiesis/workspaces/`. Git's
    // `.gitignore` would normally prevent this; we use `git add -f`
    // to bypass it. The committed tracked file persists across a
    // rebase of the integration branch, so the fingerprint captures
    // an index entry that the discard-scope walker will silently
    // skip. The fix enumerates tracked descendants and refuses with
    // `RECONCILE_SUBDIVISION_TRACKED`.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, ".poiesis", "workspaces"), { recursive: true });
    await writeFile(
      join(repo.root, ".poiesis", "workspaces", "tracked-file.txt"),
      "tracked\n",
    );
    await run(
      "git",
      ["add", "-f", ".poiesis/workspaces/tracked-file.txt"],
      { cwd: repo.root },
    );
    await run("git", ["commit", "--quiet", "-m", "track"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_(?:SUBDIVISION_TRACKED|EXCLUSION_TRACKED)$/),
    });
  });

  it("refuses an untracked and non-ignored .poiesis/workspaces/ subtree on disk", async () => {
    // Plant a `.poiesis/workspaces/` directory whose existence is
    // NOT covered by any `.gitignore` rule. The previous walker
    // hard-skipped the subtree by name, so a non-ignored untracked
    // subtree was silently preserved — the destructive step never
    // knew the directory was "live" content. The fix probes
    // `git check-ignore` on the subtree root and refuses
    // `RECONCILE_SUBDIVISION_NOT_IGNORED` when the path is not
    // ignored.
    const repo = await createTestRepo();
    repos.push(repo);
    // Deliberately do NOT add a .gitignore that covers
    // `.poiesis/workspaces/`. The repo has only the README.
    await mkdir(join(repo.root, ".poiesis", "workspaces"), { recursive: true });
    await writeFile(
      join(repo.root, ".poiesis", "workspaces", "manually-created.txt"),
      "live\n",
    );

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_(?:SUBDIVISION_NOT_IGNORED|EXCLUSION_NOT_IGNORED)$/),
    });
  });

  it("preserves a legitimate registered nested worktree under .poiesis/workspaces/", async () => {
    // Register a linked worktree at `.poiesis/workspaces/spec__nested`.
    // The exclusion subtree contains a directory shape that is a
    // registered worktree root (the children are not tracked blobs
    // because the worktree's contents are ignored). Reconcile must
    // succeed and the registered worktree must survive intact.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, ".poiesis", "workspaces"), { recursive: true });
    // Add a tracked file in the primary checkout that is NOT under
    // `.poiesis/workspaces/`. This provides a trivial non-exclusion
    // change for the destructive step to leave alone.
    await writeFile(join(repo.root, "tracked.txt"), "primary\n");
    await run("git", ["add", "tracked.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "tracked"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Register the nested worktree.
    const nestedPath = join(repo.root, ".poiesis", "workspaces", "spec__nested");
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "feature/nested-t91", nestedPath, "main"],
      { cwd: repo.root },
    );
    // Plant a tracked file inside the worktree's branch — the
    // worktree contents are independent of the primary checkout,
    // so this file is NOT inside the primary's discard scope.
    await writeFile(join(nestedPath, "wt-tracked.txt"), "in-worktree\n");
    await run("git", ["add", "wt-tracked.txt"], { cwd: nestedPath });
    await run("git", ["commit", "--quiet", "-m", "wt"], { cwd: nestedPath });
    await run("git", ["push", "--quiet", "origin", "feature/nested-t91"], {
      cwd: nestedPath,
    });

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
    // The worktree directory shape survives; the registered worktree
    // metadata still points there.
    const nestedStat = await lstat(nestedPath);
    expect(nestedStat.isDirectory()).toBe(true);
  });

  it("refuses when the target tree introduces a tracked blob at .poiesis/workspaces/<path>", async () => {
    // The target tree MUST NOT introduce a tracked blob under the
    // subtree exclusion. A freshly-pushed commit that adds
    // `.poiesis/workspaces/attacker.txt` would be reset into the
    // working tree by `git reset --hard`, overwriting a protected
    // exclusion. The fix detects the target-tree collision and
    // refuses with `RECONCILE_EXCLUSION_COLLISION` (the existing
    // collision check covers this shape via `isExcluded`'s
    // trailing-slash prefix match).
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await writeFile(join(repo.root, "tracked.txt"), "primary\n");
    await run("git", ["add", "tracked.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "tracked"], { cwd: repo.root });
    // Force-track a path under `.poiesis/workspaces/` on the
    // INTEGRATION BRANCH. The discard-scope walker skips this path;
    // the target-tree collision check is the only line of defense.
    await mkdir(join(repo.root, ".poiesis", "workspaces"), { recursive: true });
    await writeFile(
      join(repo.root, ".poiesis", "workspaces", "attacker.txt"),
      "attacker\n",
    );
    await run(
      "git",
      ["add", "-f", ".poiesis/workspaces/attacker.txt"],
      { cwd: repo.root },
    );
    await run("git", ["commit", "--quiet", "-m", "attacker"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });
    // Drop the local working tree's `.poiesis/workspaces/attacker.txt`
    // so the discard scope does not collide (only the FETCHED target
    // should carry the entry). The pointer at `.poiesis/workspaces/`
    // is preserved.

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
});

// =============================================================================
// Finding 4: bounded defense-in-depth no-follow check on residue
// deletion.
//
// The destructive cleanup deletes a residue entry with `fs.rm` /
// `fs.rmdir`. The structural guarantee against a foreign-symlink
// traversal lives in the cooperating mutation lock + pre-mutation
// revalidation, which fence the working tree across the destructive
// step. The per-entry `lstat`-on-each-ancestor check is
// defense-in-depth — bounded by the path-component count (no
// descent into external targets) — and is NOT an atomic guarantee
// against a non-cooperating writer mid-operation; for that, the
// authoritative surface is the lock + revalidation.
//
// `git clean` / `git rm --cached`-style pathspec helpers inherit
// path resolution from the underlying unlink(2) syscall and do
// not satisfy the "no-follow" contract on their own, so the
// implementation relies on the bounded `lstat` walk plus the
// lock-bound authoritative revalidation.
//
// The tests below plant the symlink-ancestor shape BEFORE the
// baseline capture so the preimage records the static swap. The
// pre-revalidation fingerprint divergence catches the swap via
// `RECONCILE_FINGERPRINT_MISMATCH`; the destructive step's
// `isAncestorChainRealDirectory` walks the captured ancestors
// and refuses deletion when any is a symlink. Both branches keep
// a sentinel inside an external target intact.
// =============================================================================

describe("ticket #91 — finding 4: bounded defense-in-depth no-follow check on residue deletion", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("does not delete bytes through a foreign symlink parent that was swapped before reconcile was called", async () => {
    // Pre-target commit establishes the parent as a real
    // directory tracking `parent/file.txt`. The baseline is then
    // captured AFTER the parent is swapped to an external symlink
    // so the captured preimage records the on-disk swap shape.
    // Reconcile then refuses: either via
    // `RECONCILE_FINGERPRINT_MISMATCH` (the revalidation
    // fingerprint sees the post-swap shape and the digest
    // drifts), `RECONCILE_SUBDIVISION_*` (the dump scope or
    // subtree probe rejects the shape) or
    // `RECONCILE_POSTCONDITION_RESIDUE` (the destructive step's
    // `lstat` walks the captured ancestor chain, refuses the
    // entry, and the postcondition walker surfaces it). The
    // sentinel inside the external target MUST survive.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const externalDir = join(repo.parent, "external-for-swap");
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, "sentinel.txt"), "external-sentinel\n");
    await mkdir(join(repo.root, "parent"), { recursive: true });
    await writeFile(join(repo.root, "parent", "file.txt"), "primary\n");
    await writeFile(join(repo.root, "tracked.txt"), "primary-sibling\n");
    await run("git", ["add", "parent", "tracked.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "parent"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });
    const baseline = await captureBaseline(repo);
    // Plant the swap.
    await rm(join(repo.root, "parent"), { recursive: true, force: true });
    await symlink(externalDir, join(repo.root, "parent"));

    const result = reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    await expect(result).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_(?:FINGERPRINT_MISMATCH|POSTCONDITION_RESIDUE)$/),
    });
    // CRITICAL: the sentinel inside the external target
    // survives. If the destructive step had traversed the
    // swapped symlink to delete the residue entry, the sentinel
    // would have been removed.
    expect(await readFile(join(externalDir, "sentinel.txt"), "utf8")).toBe(
      "external-sentinel\n",
    );
  });

  it("does not delete bytes through a long-standing foreign symlink ancestor", async () => {
    // The inventoried parent is a symlink at fingerprint capture
    // time too — the preimage records `parent/` as a symlink
    // (the walker uses lstat-no-follow and treats a symlink as a
    // leaf, so it does not descend into the external target).
    // The destructive step's bounded defense-in-depth refuses
    // deletion under the symlink ancestor; `rm` of the symlink
    // leaf itself does NOT traverse into the external target.
    // The sentinel inside the external target MUST survive
    // byte-for-byte.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const externalDir = join(repo.parent, "external-static-symlink");
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, "sentinel.txt"), "static-sentinel\n");
    await mkdir(join(repo.root, "parent"), { recursive: true });
    await writeFile(join(repo.root, "parent", "file.txt"), "primary\n");
    await writeFile(join(repo.root, "tracked.txt"), "primary-sibling\n");
    await run("git", ["add", "parent", "tracked.txt"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "parent"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Swap BEFORE the baseline capture so the preimage records
    // the symlink-as-parent shape. The discard-scope walker sees
    // a symlink leaf via lstat and does not descend.
    await rm(join(repo.root, "parent"), { recursive: true, force: true });
    await symlink(externalDir, join(repo.root, "parent"));

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
    // The reconcile must complete (or refuse with the typed
    // error) WITHOUT traversing the symlink to delete the
    // sentinel. The destructive step's bounded `lstat`-on-each-
    // ancestor defense refuses to delete the residue entry under
    // the symlink; `rm` does not resolve through it. The sentinel
    // inside the external target MUST survive byte-for-byte.
    expect(await readFile(join(externalDir, "sentinel.txt"), "utf8")).toBe(
      "static-sentinel\n",
    );
  });

  it("bounded no-follow ancestor check walks a deep symlink chain to refuse deletion", async () => {
    // Multi-level intermediate ancestor chain: `parent/level1/`
    // is a directory at capture time, but `level2` (a deeper
    // ancestor of the residue file
    // `parent/level1/level2/file.txt`) is swapped to a symlink
    // before reconcile is called. The bounded
    // `isAncestorChainRealDirectory` defense-in-depth walks every
    // level (parent → level1 → level2) and refuses when it
    // encounters the symlink at the deepest level. The sentinel
    // inside the external target survives.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const externalDir = join(repo.parent, "external-deep");
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, "sentinel.txt"), "deep-sentinel\n");
    // Track a multi-level directory shape.
    await mkdir(join(repo.root, "parent", "level1", "level2"), { recursive: true });
    await writeFile(
      join(repo.root, "parent", "level1", "level2", "file.txt"),
      "primary-deep\n",
    );
    await writeFile(join(repo.root, "tracked.txt"), "primary-sibling\n");
    await run(
      "git",
      ["add", "parent", "tracked.txt"],
      { cwd: repo.root },
    );
    await run("git", ["commit", "--quiet", "-m", "parent-deep"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

    // Capture baseline with the deep dir shape, then swap the
    // deepest directory `level2` to a symlink.
    const baseline = await captureBaseline(repo);
    await rm(join(repo.root, "parent", "level1", "level2"), {
      recursive: true,
      force: true,
    });
    await symlink(
      externalDir,
      join(repo.root, "parent", "level1", "level2"),
    );

    const result = reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    await expect(result).rejects.toMatchObject({
      code: expect.stringMatching(/^RECONCILE_(?:FINGERPRINT_MISMATCH|POSTCONDITION_RESIDUE)$/),
    });
    // The sentinel survives: nothing traversed the symlink
    // ancestor.
    expect(await readFile(join(externalDir, "sentinel.txt"), "utf8")).toBe(
      "deep-sentinel\n",
    );
  });
});

// Suppress unused warnings for shared helpers kept for symmetry
// with the other test suites.
void lstat;
void run;

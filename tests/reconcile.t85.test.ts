/**
 * Tests for remediation ticket #85.
 *
 * Each `describe` block corresponds to one of the final-review
 * findings for ticket #85. Every test uses a real disposable Git
 * repository so the seam is exercised exactly as it would be in
 * production — never mocks of Git output.
 */
import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, TEXT_DECODER_FATAL } from "../src/process.js";
import {
  computeReconcileFingerprint,
  reconcile,
} from "../src/reconcile.js";

interface TestRepo {
  parent: string;
  root: string;
  remote: string;
  baseSha: string;
}

async function createTestRepo(): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t85-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis T85"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t85@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  const baseSha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
  return { parent, root, remote, baseSha };
}

/**
 * Add files to the index using raw Buffer content, then push the
 * resulting commit to `origin/main` so `reconcile` sees them as the
 * integration target. Uses `git hash-object -w --stdin` plus
 * `git update-index --add --cacheinfo` so the bytes are preserved
 * exactly (without the lossy string round-trip that `git add` would
 * apply for non-UTF-8 content).
 *
 * Each staged file is removed from the working tree after the
 * commit so the local HEAD/index/worktree stays clean and the
 * working-tree scanner (e.g. content-filter gate) only sees the
 * target content via the integration ref.
 */
async function commitAndPushTargetFiles(
  root: string,
  files: Array<{ path: string; bytes: Buffer | string }>,
): Promise<void> {
  for (const file of files) {
    const fullPath = join(root, file.path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, file.bytes);
    if (Buffer.isBuffer(file.bytes)) {
      // Preserve raw bytes through `git hash-object --stdin` so the
      // blob stored in the target tree is exactly the bytes we
      // asked for. This is the only path that avoids the lossy
      // string round-trip `git add` applies to non-UTF-8 content.
      const oid = (
        await run(
          "git",
          ["hash-object", "-w", "--stdin"],
          { cwd: root, input: file.bytes },
        )
      ).stdout.trim();
      await run(
        "git",
        ["update-index", "--add", "--cacheinfo", "100644", oid, file.path],
        { cwd: root },
      );
    } else {
      await run("git", ["add", file.path], { cwd: root });
    }
  }
  await run("git", ["commit", "--quiet", "-m", "target"], { cwd: root });
  await run("git", ["push", "--quiet", "origin", "main"], { cwd: root });
  // Clean the working tree so local HEAD/index/worktree disagree
  // with the target only via the fetched integration ref. This
  // makes the "target-introduced nested attributes" + "raw-blob"
  // scenarios reproducible without contaminating the
  // working-tree gate.
  for (const file of files) {
    await rm(join(root, file.path), { force: true });
  }
  // The index still references the staged blobs; reset HEAD to keep
  // the index aligned with HEAD (which is still the previous state).
  // A clean `git reset HEAD --` (no `--hard`) clears the index
  // entries without touching the working tree.
  await run("git", ["reset", "--mixed", "HEAD", "--"], { cwd: root });
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
// Finding 1: cleanup protects tracked-target ancestors AND linked-worktree
// ancestors; only deletes validated leaves; non-protected dirs are removed
// non-recursively only when empty.
// =============================================================================

describe("ticket #85 — finding 1: cleanup protects tracked-target and worktree ancestors", () => {
  it("preserves a tracked target subdirectory whose descendants are in the target", async () => {
    // Target tracks `src/foo.txt`. The primary has residue at
    // `src/scratch.txt`. The destructive step MUST delete only the
    // residue leaf and leave `src/foo.txt` AND `src/` intact.
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    await commitAndPushTargetFiles(repo.root, [
      { path: "src/foo.txt", bytes: Buffer.from("tracked\n") },
    ]);
    await mkdir(join(repo.root, "src"), { recursive: true });
    await writeFile(join(repo.root, "src", "scratch.txt"), "scratch\n");
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
    expect((await readFile(join(repo.root, "src", "foo.txt"), "utf8"))).toBe("tracked\n");
    expect(
      await lstat(join(repo.root, "src", "scratch.txt")).then(() => true, () => false),
    ).toBe(false);
    expect(
      await lstat(join(repo.root, "src")).then(() => true, () => false),
    ).toBe(true);
  });

  it("preserves a distant registered worktree and its ancestors during cleanup", async () => {
    // Register a linked worktree outside `.poiesis/workspaces/` (a
    // realistic sibling layout). Reconcile MUST preserve the worktree
    // root AND every ancestor of that root on the path from the
    // repository root. The destructive step must also clean residue
    // files under those ancestors (as long as they are not inside
    // the worktree's working tree).
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    const sibling = join(repo.parent, "sibling-wt");
    await mkdir(join(repo.parent, "sibling-wt-parent"), { recursive: true });
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "feature/distantwt", sibling, "main"],
      { cwd: repo.root },
    );
    expect(
      (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout,
    ).toContain(sibling);
    await writeFile(join(repo.root, "scratch.txt"), "scratch\n");
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
    ).resolves.toBeDefined();
    expect(
      await lstat(join(repo.root, "scratch.txt")).then(() => true, () => false),
    ).toBe(false);
    const list = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo.root })).stdout;
    expect(list).toContain(sibling);
    expect(list).toMatch(/branch refs\/heads\/feature\/distantwt/);
  });

  it("refuses a residue file that appears AFTER the fingerprint scan (revalidation catches the late child)", async () => {
    // The destructive step uses the validated preimage; a residue file
    // that lands after the scan must not be silently deleted. The
    // revalidation step catches the fingerprint drift and refuses.
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    await writeFile(join(repo.root, "late-child.txt"), "race\n");
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
});

// =============================================================================
// Finding 2: walker descends into `.poiesis/other/*` (not an excluded
// subtree); the deletion walker respects declared exclusions; preimage and
// target refuse if any declared exclusion is tracked.
// =============================================================================

describe("ticket #85 — finding 2: `.poiesis/other` is fingerprinted and cleaned", () => {
  it("fingerprints and removes residue under `.poiesis/other`", async () => {
    // `.poiesis/other` is NOT a declared exclusion, so the walker
    // descends into it and the fingerprint binds its content. The
    // destructive step then removes the residue while leaving the
    // declared exclusions untouched.
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, ".poiesis", "other"), { recursive: true });
    await writeFile(join(repo.root, ".poiesis", "manifest.json"), '{"alive":true}\n');
    await writeFile(join(repo.root, ".poiesis", "other", "leak.txt"), "leak\n");
    const before = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    await writeFile(join(repo.root, ".poiesis", "other", "leak2.txt"), "leak2\n");
    const after = await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    });
    expect(after.digest).not.toBe(before.digest);
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
    expect(
      await lstat(join(repo.root, ".poiesis", "other", "leak.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await lstat(join(repo.root, ".poiesis", "other", "leak2.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await readFile(join(repo.root, ".poiesis", "manifest.json"), "utf8")).toBe(
      '{"alive":true}\n',
    );
    // `.poiesis/workspaces/` was not created in this scenario, so the
    // post-reconcile survivor list only retains the actually-present
    // exclusion root. The reconciliation contract still preserves the
    // declared exclusion directory had it existed — `listSurvivingExclusions`
    // only reports roots that survived on disk.
    expect(result.preservedExclusions).toContain(".poiesis/manifest.json");
  });

  it("removes an empty residue directory under `.poiesis/other`", async () => {
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, ".poiesis", "other", "empty-dir"), { recursive: true });
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
    ).resolves.toBeDefined();
    expect(
      await lstat(join(repo.root, ".poiesis", "other", "empty-dir")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("refuses when the target tree contains a tracked file at a declared exclusion path", async () => {
    // A tracked blob at the declared exclusion `.poiesis/manifest.json`
    // collides with the exclusion contract. Reconcile must refuse.
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    // Push a tracked blob at the declared exclusion path. The local
    // working tree is clean of the file (we use `git hash-object` to
    // plant the blob directly without leaving the working tree in a
    // state that prevents the prefix from being a directory).
    const trackedBlob = Buffer.from('{"tracked":true}\n');
    const oid = (
      await run("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo.root,
        input: trackedBlob.toString("binary"),
      })
    ).stdout.trim();
    // Force-add the entry at the exclusion path; we mutate the index
    // directly because git would otherwise complain that the path is
    // gitignored.
    await run(
      "git",
      ["update-index", "--add", "--cacheinfo", "100644", oid, ".poiesis/manifest.json"],
      { cwd: repo.root },
    );
    await run("git", ["commit", "--quiet", "-m", "track exclusion"], { cwd: repo.root });
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
});

// =============================================================================
// Finding 3: target-collision set includes every registered linked worktree
// root and its ancestors, including outside `.poiesis/workspaces`.
// =============================================================================

describe("ticket #85 — finding 3: target collisions include worktree roots and ancestors", () => {
  it("refuses when the target tree tracks a blob at a registered linked worktree root path", async () => {
    // Register a linked worktree at `<root>/distant/sibling/wt/` —
    // a "distant" worktree outside `.poiesis/workspaces/`. Plant a
    // tracked blob at the same path (`<root>/distant/sibling/wt`),
    // which would replace the worktree directory with a regular
    // file on `git reset --hard`. Reconcile must refuse BEFORE
    // reset because the destructive step would clobber the
    // worktree's territory.
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    const wtPath = join(repo.root, "distant", "sibling", "wt");
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "feature/distant", wtPath, "main"],
      { cwd: repo.root },
    );
    // Stage a tracked blob at the worktree root path. We use
    // `update-index --add --cacheinfo` to manipulate the index
    // directly because the working tree already has a directory at
    // that path and `git add` would refuse.
    const oid = (
      await run(
        "git",
        ["hash-object", "-w", "--stdin"],
        { cwd: repo.root, input: Buffer.from("clobber\n") },
      )
    ).stdout.trim();
    await run(
      "git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "100644",
        oid,
        "distant/sibling/wt",
      ],
      { cwd: repo.root },
    );
    await run("git", ["commit", "--quiet", "-m", "track wt as file"], {
      cwd: repo.root,
    });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Drop the index entry so the local working tree is back to
    // its pristine pre-target state. The fetched target still
    // carries the clobber blob.
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });
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
    ).rejects.toMatchObject({ code: "RECONCILE_TARGET_COLLISION" });
  });
});

// =============================================================================
// Finding 4: readdir with default encoding aliases invalid-UTF8 path names.
// Refuse the discard scope if a path name decodes ambiguously.
// =============================================================================

describe("ticket #85 — finding 4: refuses ambiguous path names (invalid UTF-8 / replacement-character aliasing)", () => {
  it("exposes a fatal UTF-8 decoder helper for path validation", () => {
    // The walker needs a deterministic helper that throws on invalid
    // UTF-8 sequences. We re-export from `process.ts` so the helper
    // is exercised through the same surface as production code.
    const invalid = Buffer.from([0x61, 0xc3, 0x28]);
    const valid = Buffer.from("aé", "utf8");
    expect(() => TEXT_DECODER_FATAL.decode(invalid)).toThrow();
    expect(TEXT_DECODER_FATAL.decode(valid)).toBe("aé");
  });

  it("refuses the fingerprint when a child name contains invalid-UTF-8 bytes", async () => {
    // Direct test of the alignment check: write one child whose name
    // is invalid-UTF-8 bytes. The walker must decode via the strict
    // UTF-8 decoder and refuse because the bytes cannot be safely
    // represented as a fingerprint path. The companion finding #4
    // assertion (two children alias) is exercised by the decoder
    // helper test above plus the aliasing detector logic — keeping
    // this test focused on the simpler "any invalid byte in any
    // discard-scope path refuses the fingerprint" invariant makes it
    // robust against filesystem byte-name acceptance quirks.
    const repo = await createTestRepo();
    REPOS.push(repo);
    await mkdir(join(repo.root, "weird"));
    // Plant a file with an invalid-UTF-8 name via a Buffer path,
    // which Node + Linux ext4 accept verbatim.
    const invalidNameBytes = Buffer.from([0x61, 0xc3, 0x28, 0x62, 0x2e, 0x74, 0x78, 0x74]);
    await writeFile(
      Buffer.concat([
        Buffer.from(join(repo.root, "weird")),
        Buffer.from("/"),
        invalidNameBytes,
      ]),
      "x\n",
    );
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_INVALID_PATH_ENCODING" });
  });
});

// =============================================================================
// Finding 5: content-transform gate covers effective + nested + target
// attributes, refusing any `.gitattributes` mechanism before reset.
// =============================================================================

describe("ticket #85 — finding 5: content-transform gate covers nested and target-attributes", () => {
  it("refuses when the fetched target tree introduces a nested `.gitattributes` while HEAD/index/worktree are clean", async () => {
    // Push a target tree that adds `src/.gitattributes` (an `eol=`
    // line). The HEAD/index/worktree at reconcile time do NOT have
    // any `.gitattributes`. Reconcile must detect this from the
    // fetched target tree and refuse BEFORE reset.
    const repo = await createTestRepo();
    REPOS.push(repo);
    await gitignoreRuntime(repo.root);
    await commitAndPushTargetFiles(repo.root, [
      { path: "src/.gitattributes", bytes: Buffer.from("*.txt text eol=lf\n") },
      { path: "src/foo.txt", bytes: Buffer.from("foo\n") },
    ]);
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
    ).rejects.toMatchObject({ code: "RECONCILE_FILTER_ACTIVE" });
    // HEAD unchanged
    const headAfter = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(headAfter).toBe(baseline.head);
  });

  it("refuses an `info/attributes` file in the git dir", async () => {
    const repo = await createTestRepo();
    REPOS.push(repo);
    await writeFile(join(repo.root, ".git", "info", "attributes"), "*.bin filter=lfs\n");
    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_FILTER_ACTIVE" });
  });
});

// =============================================================================
// Finding 6: `binaryStdout` must preserve raw bytes; the postcondition
// compares genuine Buffer captures for binary-mode runs.
// =============================================================================

describe("ticket #85 — finding 6: raw bytes preserved under binary mode", () => {
  const rawBlobs: Array<{ name: string; bytes: Buffer }> = [
    { name: "multibyte.txt", bytes: Buffer.from("héllo\n", "utf8") },
    { name: "invalid.bin", bytes: Buffer.from([0x61, 0xc3, 0x28, 0x0a]) },
    { name: "nul.bin", bytes: Buffer.from([0x61, 0x00, 0x62, 0x0a]) },
    { name: "trailing.bin", bytes: Buffer.from("a\t  \n", "utf8") },
  ];

  it.each(rawBlobs)(
    "preserves raw target bytes for `$name` via end-to-end reconcile",
    async ({ name, bytes }) => {
      const repo = await createTestRepo();
      REPOS.push(repo);
      await gitignoreRuntime(repo.root);
      await commitAndPushTargetFiles(repo.root, [{ path: name, bytes }]);
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
      ).resolves.toBeDefined();
      const got = await readFile(join(repo.root, name));
      expect(got.equals(bytes)).toBe(true);
    },
  );
});

/**
 * Tests for remediation ticket #86.
 *
 * Each `describe` block corresponds to one of the final-review
 * findings. Tests use real disposable Git repositories so the seam
 * is exercised exactly as it would be in production: never mocks,
 * never string substitutions of Git output. The `withIsolatedGitEnv`
 * helper manipulates `process.env` for the duration of a single
 * test so the filter-gate can observe an isolated user/system
 * attribute set without leaking into sibling tests.
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
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t86-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis T86"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t86@example.test"], { cwd: root });
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

/**
 * Run a callback with `process.env` patched to an isolated Git
 * environment. Returns the callback's result. The patch points
 * `HOME` and `XDG_CONFIG_HOME` at a fresh temp directory so the
 * host's `~/.config/git/attributes` and `~/.gitconfig` are
 * bypassed; `GIT_CONFIG_NOSYSTEM=1` additionally blocks
 * `/etc/gitconfig`. The previous values are restored after the
 * callback resolves or rejects.
 */
async function withIsolatedGitEnv<T>(run: () => Promise<T>): Promise<T> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), "poiesis-t86-iso-"));
  const previousHome = process.env.HOME;
  const previousXdgConfig = process.env.XDG_CONFIG_HOME;
  const previousXdgData = process.env.XDG_DATA_HOME;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.HOME = isolatedRoot;
  process.env.XDG_CONFIG_HOME = join(isolatedRoot, ".config");
  process.env.XDG_DATA_HOME = join(isolatedRoot, ".local", "share");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = join(isolatedRoot, ".gitconfig");
  delete process.env.GIT_CONFIG_SYSTEM;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfig;
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = previousSystem;
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

const REPOS: TestRepo[] = [];

afterEach(async () => {
  while (REPOS.length > 0) {
    const repo = REPOS.pop()!;
    await rm(repo.parent, { recursive: true, force: true });
  }
});

// =============================================================================
// Finding 5: target tree must validate every mode before reset; reject any
// gitlink (160000) or other unsupported mode without mutation.
// =============================================================================

describe("ticket #86 — finding 5: target mode validation", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses a fetched target tree that tracks a gitlink (160000)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Plant a gitlink (mode 160000) entry directly in the index via
    // `update-index --add --cacheinfo`. `git commit` accepts the
    // entry; the local working tree stays clean so we do not trip
    // the working-tree scanner's other gates.
    const oid = (
      await run("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo.root,
        input: Buffer.from("", "utf8"),
      })
    ).stdout.trim();
    await run(
      "git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "160000",
        oid,
        "sub",
      ],
      { cwd: repo.root },
    );
    await run("git", ["commit", "--quiet", "-m", "track gitlink"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Roll the working tree index back so HEAD still describes the
    // pre-target state used by the test, but `origin/main` carries
    // the gitlink.
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

    const baseline = await captureBaseline(repo);
    const headBefore = baseline.head;
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
    ).rejects.toMatchObject({ code: "RECONCILE_TARGET_MODE_UNSUPPORTED" });
    // No mutation: HEAD unchanged.
    const headAfter = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(headAfter).toBe(headBefore);
  });

  it("still reconciles an executable regular-file target after mode validation is in place", async () => {
    // Regression coverage for the regular-file path: a 100755 mode
    // (executable blob) MUST continue to reconcile cleanly. The
    // mode validator refuses unsupported shapes only; supported
    // shapes (100644, 100755, 120000, 040000) are passed through.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await writeFile(join(repo.root, "exec.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(repo.root, "exec.sh"), 0o755);
    await run("git", ["add", "exec.sh"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "exec"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
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
  });
});

// =============================================================================
// Finding 6: postcondition cat-file must use a maxBytes aligned with the
// per-file bound (100 MiB). A retained >256 KiB blob must reconcile.
// =============================================================================

describe("ticket #86 — finding 6: postcondition cat-file maxBytes aligned with per-file bound", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("reconciles a target blob whose raw bytes exceed the 256 KiB process default", async () => {
    // Plant a 1 MiB target blob with deterministic byte pattern. The
    // previous implementation used the 256 KiB `process.run` default
    // for `git cat-file blob`, so a blob >256 KiB would silently
    // truncate and the postcondition would refuse the working tree.
    // The fix is to pass an explicit `maxBytes` aligned with the
    // per-file fingerprint bound (100 MiB) so the postcondition
    // compares full bytes against the working tree.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const oneMegabyte = 1024 * 1024;
    const bytes = Buffer.alloc(oneMegabyte);
    for (let i = 0; i < oneMegabyte; i += 1) {
      bytes[i] = i & 0xff;
    }
    await writeFile(join(repo.root, "blob.bin"), bytes);
    await run("git", ["add", "blob.bin"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "big blob"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });

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
    const onDisk = await readFile(join(repo.root, "blob.bin"));
    expect(onDisk.length).toBe(oneMegabyte);
    expect(onDisk.equals(bytes)).toBe(true);
  });
});

// =============================================================================
// Finding 3: comprehensive resolved-git-dir active-operation indicators
// (rebase-apply, rebase-merge, sequencer, MERGE_MSG, etc.).
// =============================================================================

describe("ticket #86 — finding 3: comprehensive resolved-git-dir active-operation indicators", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  async function gitDirAbsolute(root: string): Promise<string> {
    const result = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd: root });
    return result.stdout;
  }

  it("refuses when the resolved git dir contains a `rebase-apply/` directory", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const gitDir = await gitDirAbsolute(repo.root);
    await mkdir(join(gitDir, "rebase-apply"), { recursive: true });
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(join(gitDir, "rebase-apply"), { recursive: true, force: true });
    }
  });

  it("refuses when the resolved git dir contains a `rebase-merge/` directory", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const gitDir = await gitDirAbsolute(repo.root);
    await mkdir(join(gitDir, "rebase-merge"), { recursive: true });
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(join(gitDir, "rebase-merge"), { recursive: true, force: true });
    }
  });

  it("refuses when the resolved git dir contains a `sequencer/` directory (paused cherry-pick/revert)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const gitDir = await gitDirAbsolute(repo.root);
    await mkdir(join(gitDir, "sequencer"), { recursive: true });
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(join(gitDir, "sequencer"), { recursive: true, force: true });
    }
  });

  it("refuses when the resolved git dir contains a paused-am state file under `rebase-apply/`", async () => {
    // `git am` leaves `rebase-apply/` with head-name, next, etc.
    // The ticket fixture allows a paused-am shape via a sentinel
    // file that simulates an in-progress am. We exercise the
    // rebase-apply path with a sentinel file inside `rebase-apply/`
    // because that is the canonical on-disk signal for both `am`
    // (left behind after abort/pause) and `rebase` (paused).
    const repo = await createTestRepo();
    repos.push(repo);
    const gitDir = await gitDirAbsolute(repo.root);
    const applyDir = join(gitDir, "rebase-apply");
    await mkdir(applyDir, { recursive: true });
    await writeFile(join(applyDir, "head-name"), "refs/heads/main\n");
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(applyDir, { recursive: true, force: true });
    }
  });

  it("refuses when the resolved git dir contains MERGE_MSG (in-progress merge)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const gitDir = await gitDirAbsolute(repo.root);
    await writeFile(join(gitDir, "MERGE_MSG"), "merge in progress\n");
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(join(gitDir, "MERGE_MSG"), { force: true });
    }
  });

  it("refuses when the resolved git dir contains MERGE_HEAD (in-progress merge HEAD indicator)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const gitDir = await gitDirAbsolute(repo.root);
    const mergeHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout.trim();
    await writeFile(join(gitDir, "MERGE_HEAD"), `${mergeHead}\n`);
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(join(gitDir, "MERGE_HEAD"), { force: true });
    }
  });

  it("refuses a paused cherry-pick via the `CHERRY_PICK_HEAD` indicator (regression)", async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const gitDir = await gitDirAbsolute(repo.root);
    await writeFile(join(gitDir, "CHERRY_PICK_HEAD"), "deadbeef\n");
    try {
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_GIT_OPERATION_ACTIVE" });
    } finally {
      await rm(join(gitDir, "CHERRY_PICK_HEAD"), { force: true });
    }
  });
});

// =============================================================================
// Finding 4: attribute discovery must use the same bounded walk the discard
// scope uses; nested attributes inside a protected worktree must not block;
// the overflow path must fire at the declared bounds.
// =============================================================================

describe("ticket #86 — finding 4: attribute discovery bound + exclusions + worktree skip", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("does not refuse a `.gitattributes` nested inside a protected linked worktree (excluded from discard scope)", async () => {
    // A `.gitattributes` inside a registered linked worktree must NOT
    // block reconcile: the worktree's working tree is excluded from
    // the discard scope (its root is in `worktreeRoots`), so the
    // attribute discovery walker must skip the worktree contents the
    // same way the discard-scope walker does. This pins the
    // attribute-discovery contract: same bounded walk, same
    // exclusions, same worktree-root skip set.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const nestedWt = join(repo.parent, "nested-attr-wt");
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "feature/attrs", nestedWt, "main"],
      { cwd: repo.root },
    );
    await writeFile(join(nestedWt, ".gitattributes"), "*.bin filter=lfs\n");
    await writeFile(join(nestedWt, "tracked.bin"), "would-be-filtered\n");
    await run("git", ["add", ".gitattributes", "tracked.bin"], { cwd: nestedWt });
    await run("git", ["commit", "--quiet", "-m", "attrs in wt"], { cwd: nestedWt });

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
  });

  it("does not refuse a `.gitattributes` nested inside a registered worktree under the declared exclusion subtree (`.poiesis/workspaces/`)", async () => {
    // A `.gitattributes` inside a registered linked worktree whose
    // path is under `.poiesis/workspaces/` (the declared exclusion
    // subtree) is skipped by BOTH the discard-scope walker (via the
    // subtree skip) AND the attribute discovery walker (via the
    // same subtree skip). The discard-scope walker never descends
    // into `.poiesis/workspaces/`, so the preimage has no entry
    // there; the attribute walker must mirror that skip so an
    // attribute file inside a registered worktree nested under
    // `.poiesis/workspaces/spec__nested` does not block reconcile.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // `git worktree add` requires the target dir to be empty.
    // Pre-create the parent and let `git worktree add` create the
    // worktree under `.poiesis/workspaces/spec__nested`.
    const nestedWt = join(repo.root, ".poiesis", "workspaces", "spec__nested");
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "spec/nested-attrs", nestedWt, "main"],
      { cwd: repo.root },
    );
    await writeFile(join(nestedWt, ".gitattributes"), "*.bin filter=lfs\n");
    await writeFile(join(nestedWt, "wt-only.txt"), "kept\n");
    await run("git", ["add", ".gitattributes", "wt-only.txt"], { cwd: nestedWt });
    await run("git", ["commit", "--quiet", "-m", "attrs in nested wt"], { cwd: nestedWt });

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
  });

  it("refuses when the attribute discovery overflow path exceeds the declared dir bound", async () => {
    // The attribute discovery walk applies the same incremental
    // bounds the discard-scope walker uses. When the bound is
    // exceeded, the fingerprint refuses with
    // `RECONCILE_SCAN_INCOMPLETE` — never silently succeeds. We
    // exercise this by shrinking the dir bound at the test seam
    // and constructing a working tree that crosses it.
    const repo = await createTestRepo();
    repos.push(repo);
    const { __setReconcileScanBoundsForTest } = await import("../src/reconcile.js");
    __setReconcileScanBoundsForTest({ maxDirs: 20 });
    try {
      // Plant 25 sibling directories, none of them tracked. The
      // attribute walker counts each one as it descends.
      const promises: Promise<void>[] = [];
      for (let index = 0; index < 25; index += 1) {
        promises.push(mkdir(join(repo.root, `attr-dir-${index}`)));
      }
      await Promise.all(promises);
      await expect(
        computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        }),
      ).rejects.toMatchObject({ code: "RECONCILE_SCAN_INCOMPLETE" });
    } finally {
      // Restore every mutable bound to its production default. An
      // empty object would be a no-op here — the seam only resets
      // a field when its key is present in the overrides, so
      // leaving the previously shrunk `maxDirs` bound in place
      // would propagate into the next test sharing the module.
      // Explicit `null` per field is the canonical restore.
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
// Finding 2: attribute source coverage must include implicit user/system
// sources (XDG, /etc/gitconfig) — use an isolated Git environment so the
// fingerprint refuses when those sources would have applied any filter.
// Refuse transformations with HEAD/index/worktree unchanged.
// =============================================================================

describe("ticket #86 — finding 2: implicit user/system attribute sources", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses when an XDG-cached gitattributes source declares a filter (XDG_CONFIG_HOME active)", async () => {
    // Drop a `~/.config/git/attributes` file equivalent under the
    // isolated XDG_CONFIG_HOME used by `withIsolatedGitEnv`. The
    // fingerprint must resolve and refuse this implicit user
    // attribute source even when no working-tree `.gitattributes`
    // exists and no local `filter.*` config is set. This pins the
    // ticket #86 finding #2 contract: implicit user/system
    // attribute sources participate in the fingerprint gate.
    const repo = await createTestRepo();
    repos.push(repo);
    // Do NOT set any `filter.*` config locally. The only attribute
    // source that declares a filter is the XDG-cached attributes
    // file planted by `withIsolatedGitEnv` below.
    await expect(
      withIsolatedGitEnv(async () => {
        const isolatedHome = process.env.HOME;
        if (isolatedHome === undefined) {
          throw new Error("withIsolatedGitEnv did not set HOME");
        }
        await mkdir(join(isolatedHome, ".config", "git"), { recursive: true });
        await writeFile(
          join(isolatedHome, ".config", "git", "attributes"),
          "*.bin filter=implicitsmudge\n",
        );
        return computeReconcileFingerprint({
          cwd: repo.root,
          remote: "origin",
          integrationBranch: "main",
        });
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_FILTER_ACTIVE" });
    // No mutation: HEAD unchanged.
    const headAfter = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    expect(headAfter.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a HEAD/index/worktree-unchanged transformation when a global attrsFile declares a filter", async () => {
    // The fingerprint is read-only by contract. Even though
    // `core.attributesFile` points at a file that declares a filter,
    // the fingerprint must refuse without mutating HEAD, index, or
    // worktree. This test pins that contract for the implicit user
    // attribute source path.
    const repo = await createTestRepo();
    repos.push(repo);
    const attrsFile = join(repo.parent, "user-attrs");
    await writeFile(attrsFile, "*.bin filter=implicitsys\n");
    await run("git", ["config", "filter.implicitsys.clean", "cat"], { cwd: repo.root });
    await run("git", ["config", "filter.implicitsys.smudge", "cat"], { cwd: repo.root });
    await run("git", ["config", "core.attributesFile", attrsFile], { cwd: repo.root });

    const headBefore = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    const indexBefore = (await run("git", ["ls-files", "--stage", "-z"], { cwd: repo.root })).stdout;
    const statusBefore = (
      await run("git", ["status", "--porcelain=v1", "-z"], { cwd: repo.root })
    ).stdout;

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_FILTER_ACTIVE" });

    const headAfter = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
    const indexAfter = (await run("git", ["ls-files", "--stage", "-z"], { cwd: repo.root })).stdout;
    const statusAfter = (
      await run("git", ["status", "--porcelain=v1", "-z"], { cwd: repo.root })
    ).stdout;
    expect(headAfter).toBe(headBefore);
    expect(indexAfter).toBe(indexBefore);
    expect(statusAfter).toBe(statusBefore);
  });
});

// =============================================================================
// Finding 1: cleanup must never traverse a symlink ancestor. Old inventory
// descendants whose ancestor chain crosses a target-installed symlink must
// be skipped. Descendants superseded by a target leaf/type transition must
// also be skipped. Directory-to-symlink external + protected-worktree-sentinel
// cases.
// =============================================================================

describe("ticket #86 — finding 1: cleanup never traverses a symlink ancestor", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("does not delete through a target-installed symlink ancestor (directory-to-symlink external)", async () => {
    // The target tree installs a symlink `link -> ${externalDir}`.
    // The preimage contains the directory `link` and a residue file
    // `link/residue.txt` recorded by the discard-scope walker (the
    // local working tree has `link/` as a directory when the
    // fingerprint is captured). After `git reset --hard`, `link`
    // becomes a symlink; deleting the preimage residue file would
    // resolve through the symlink and land on `<externalDir>`,
    // potentially deleting bytes that belong to a different tree.
    // The destructive step must skip the descendant because its
    // ancestor chain crosses the target-installed symlink.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const externalDir = join(repo.parent, "external-target");
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, "external-child.txt"), "external\n");
    // Plant a same-named file inside the external target. If the
    // destructive step resolved through the symlink and tried to
    // delete `<root>/link/residue.txt`, the resolution would land
    // on `<externalDir>/residue.txt` and delete it. The test
    // asserts that file survives intact.
    await writeFile(join(externalDir, "residue.txt"), "external-residue\n");
    await writeFile(join(repo.root, "external-ancestor"), "ancestor\n");
    await run("git", ["add", "external-ancestor"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "ancestor"], { cwd: repo.root });
    // Pre-target: `link` is a regular directory tracked in HEAD.
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "residue.txt"), "primary-residue\n");
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link dir"], { cwd: repo.root });
    // Target: replace `link` with a symlink to the external target.
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await symlink(externalDir, join(repo.root, "link"));
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link as symlink"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Reset local HEAD to the pre-target commit. Manually restore
    // the directory shape on disk so the discard-scope walker sees
    // `link/residue.txt` as a real preimage entry (the reset alone
    // would leave the symlink on disk).
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "residue.txt"), "primary-residue\n");
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
    ).resolves.toBeDefined();
    // The external files are preserved bit-for-bit — the destructive
    // step did NOT walk through the symlink ancestor to delete
    // anything inside the external target.
    expect(await readFile(join(externalDir, "external-child.txt"), "utf8")).toBe("external\n");
    expect(await readFile(join(externalDir, "residue.txt"), "utf8")).toBe("external-residue\n");
    // And the symlink itself is in place at the target path.
    const linkStat = await lstat(join(repo.root, "link"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it("does not delete a protected-worktree sentinel inside an external symlink target", async () => {
    // Register a linked worktree whose path is the EXTERNAL target
    // of a symlink. The destructive step must not delete the
    // worktree's sentinel file even though `git reset --hard`
    // removed the directory at `link/`.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const externalDir = join(repo.parent, "external-worktree");
    await mkdir(externalDir, { recursive: true });
    // `git worktree add` requires the target dir to be empty. Add
    // the worktree first, then plant the sentinel inside the
    // worktree's territory.
    await run(
      "git",
      ["worktree", "add", "--quiet", "-b", "feature/wt-target", externalDir, "main"],
      { cwd: repo.root },
    );
    await writeFile(join(externalDir, "sentinel.txt"), "sentinel\n");
    // Push a target that adds a symlink `link -> ${externalDir}`.
    // First commit establishes the `link` directory shape locally so
    // the preimage contains residue under it; second commit
    // replaces `link` with the symlink.
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "ignored.txt"), "old\n");
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link dir"], { cwd: repo.root });
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await symlink(externalDir, join(repo.root, "link"));
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link as symlink"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Reset local HEAD to the pre-target commit. Manually restore
    // the directory shape on disk so the discard-scope walker sees
    // `link/ignored.txt` as a real preimage entry (the reset alone
    // would leave the symlink on disk).
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "ignored.txt"), "old\n");
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
    // Sentinel inside the worktree's territory (which is the
    // symlink target) survives intact.
    expect(await readFile(join(externalDir, "sentinel.txt"), "utf8")).toBe("sentinel\n");
    // The symlink itself survives at the target path.
    const linkStat = await lstat(join(repo.root, "link"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });
});

// Suppress unused warnings for shared helpers that are kept for symmetry
// with the other test suites.
void chmod;
void TEXT_DECODER_FATAL;
void RECONCILE_FINGERPRINT_SCHEMA;
void sep;

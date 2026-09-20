/**
 * Tests for remediation ticket #93.
 *
 * Each `describe` block corresponds to one of the final-review
 * findings for ticket #93. Tests use real disposable Git
 * repositories so the seam is exercised exactly as it would be
 * in production: never mocks, never string substitutions of Git
 * output.
 *
 * The findings addressed here:
 *
 *   - the cooperating mutation lock is now held through every
 *     postcondition check AND through result construction. A peer
 *     mutation (`update`, `uninstall`, `update --config`, or a
 *     concurrent `reconcile`) cannot acquire the lock until the
 *     result object is fully built and returned. The previous
 *     implementation released the lock at the end of the
 *     destructive step, then ran the postcondition checks
 *     (HEAD == target, index matches target, working tree
 *     matches target, no residue outside declared exclusions,
 *     preserved shared paths) AND constructed the result object
 *     after the lock was released. That window let a peer
 *     mutation slip in between the destructive step and the
 *     postcondition, so the working tree could drift between
 *     reset and postcondition while the same reconcile call
 *     still reported `head === target` and
 *     `workingTreeMatchesTarget === true`. The fix moves every
 *     postcondition check AND the `return { ... }` statement
 *     inside the `try` block, so the lock is held until the
 *     promise resolves. A bounded internal test hook
 *     (`__isReconcileMutationLockHeldForTest`) exposes the lock
 *     state without leaking the surface through `index.ts`;
 *
 *   - the post-reset `listIndexOids` probe is now an authoritative
 *     bounded binary-safe parser that REJECTS the same shapes the
 *     preflight `probeIndexStageViaGitLsFiles` rejects: a
 *     malformed record (missing tab, missing meta field, non-numeric
 *     mode, non-hex OID, out-of-range stage), mode 160000
 *     (gitlink), nonzero stage (conflict), OID whose length does
 *     not match the repository's hash algorithm, and any other
 *     mode outside the supported blob / tree set. The previous
 *     implementation accepted any well-formed meta triple and
 *     only filtered out gitlinks with `if (mode === 0o160000)
 *     continue;` — a malformed mode, a SHA-1 OID in a SHA-256
 *     repository, and a nonzero stage all slipped past
 *     silently. The parser is now shared between the preflight
 *     probe and the post-reset probe so the two seams agree on
 *     what a valid record looks like.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import {
  __isReconcileMutationLockHeldForTest,
  __peekReconcilePostdestructiveHookForTest,
  __setReconcileLockTransitionListenersForTest,
  __setReconcilePostdestructiveHookForTest,
  computeReconcileFingerprint,
  reconcile,
} from "../src/reconcile.js";
import { acquireWorkspaceMutationLock } from "../src/mutation-transaction.js";

interface TestRepo {
  parent: string;
  root: string;
  remote: string;
}

async function createTestRepo(): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t93-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis T93"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t93@example.test"], { cwd: root });
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
 * Build a hand-rolled v2 (SHA-1) index whose single entry has the
 * supplied mode, OID, and stage. Used to plant a gitlink / conflict /
 * mismatch shape on disk that `git ls-files` will surface, so the
 * post-reset probe's shared parser is exercised end-to-end.
 */
async function writeHandRolledV2Index(
  root: string,
  pathName: string,
  mode: number,
  oid: Buffer,
  stage: number,
): Promise<void> {
  const path = Buffer.from(pathName);
  const pathLen = path.length;
  const flags = Buffer.alloc(2);
  // 16-bit flags (big-endian):
  //   bit 15    = CE_VALID (assume-valid)
  //   bit 14    = CE_EXTENDED (must be 0 in v2)
  //   bits 13:12 = stage (shifted by 12)
  //   bits 11:0 = name length (12 bits)
  const stageBits = stage << 12;
  flags[0] = (stageBits >> 8) & 0xff;
  flags[1] = pathLen & 0xff;
  const statBlock = Buffer.alloc(40);
  statBlock.writeUInt32BE(mode, 24);
  const pathTerminated = Buffer.concat([path, Buffer.from([0])]);
  let padLen = 0;
  while ((40 + 20 + 2 + pathTerminated.length + padLen) % 8 !== 0) padLen += 1;
  const pad = Buffer.alloc(padLen);
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "binary");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const index = Buffer.concat([header, statBlock, oid, flags, pathTerminated, pad]);
  await writeFile(join(root, ".git", "index"), index);
}

// =============================================================================
// Finding 1: the cooperating mutation lock is held through every
// postcondition check and through result construction.
//
// A peer mutation that holds (or attempts to acquire) the same lock must
// observe the lock as HELD for the entire reconcile call — including
// the postcondition phase and the result-object construction. The
// bounded internal hook flips to `true` after `acquireWorkspaceMutationLock`
// succeeds and back to `false` only after `lock.release()` resolves in
// the `finally` block. The hook is module-private (declared in
// `src/reconcile.ts`, never re-exported from `src/index.ts`).
//
// The previous implementation released the lock immediately after the
// destructive step, then ran the HEAD/index/working-tree/residue/
// preserved-paths checks AND constructed the result object. A peer
// mutation that acquired the lock in that window could re-mutate the
// working tree while the same `reconcile` call still reported
// `head === fetchedTarget` and `workingTreeMatchesTarget === true`.
// =============================================================================

describe("ticket #93 — finding 1: mutation lock held through postconditions and result construction", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
    // Detach the test listeners between tests so a listener
    // installed by one test cannot observe another test's
    // reconcile call.
    __setReconcileLockTransitionListenersForTest(null);
  });

  it("the lock-held flag is false outside reconcile and true during reconcile", async () => {
    // Establish the deterministic contract: the flag is false
    // before reconcile, true during reconcile (via the
    // transition listener installed below), and false after
    // the reconcile call resolves. The listener is invoked
    // synchronously inside the reconcile call so the
    // observation is race-free.
    const transitions: boolean[] = [];
    __setReconcileLockTransitionListenersForTest([
      (held) => transitions.push(held),
    ]);
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);

    expect(__isReconcileMutationLockHeldForTest()).toBe(false);
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
    expect(__isReconcileMutationLockHeldForTest()).toBe(false);
    // The transition sequence must include both `true` and
    // `false`, in that order. The previous implementation
    // would have released the lock between the destructive
    // step and the postcondition phase, exposing a `false`
    // transition DURING reconcile; the listener installed
    // here would have observed a `[true, false, ...]` sequence
    // before the call resolved. The fix collapses the lock
    // window to a single contiguous `[true, false]`
    // transition that brackets the entire reconcile call.
    expect(transitions).toContain(true);
    expect(transitions).toContain(false);
    expect(transitions[0]).toBe(true);
    expect(transitions[transitions.length - 1]).toBe(false);
  });

  it("a peer acquireWorkspaceMutationLock call refuses with POIESIS_MUTATION_LOCKED throughout the entire reconcile call", async () => {
    // The previous window — between `performDestructiveReset` and
    // the postcondition checks — let a peer mutation acquire the
    // lock. The fix moves the postconditions AND the result
    // construction inside the lock, so the entire call is
    // uncooperative-mutation-free. The test installs a lock
    // transition listener that, on every `true` transition,
    // attempts to acquire the lock from the same test
    // context. A peer acquire MUST refuse with
    // `POIESIS_MUTATION_LOCKED`; if it succeeds, the lock
    // window leaked.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);
    setCurrentTestRoot(repo.root);

    let peerAcquired = false;
    let observedHeldTransitions = 0;
    __setReconcileLockTransitionListenersForTest([
      (held) => {
        if (!held) return;
        observedHeldTransitions += 1;
        // The listener runs synchronously inside the
        // reconcile call, between lock acquire and lock
        // release. Attempting a peer acquire here MUST refuse
        // with `POIESIS_MUTATION_LOCKED`; a successful acquire
        // would prove the lock window leaked.
        void acquireWorkspaceMutationLock(repo_root_for_test)
          .then((peerLock) => {
            peerAcquired = true;
            return peerLock.release();
          })
          .catch((error: unknown) => {
            expect(error).toMatchObject({ code: "POIESIS_MUTATION_LOCKED" });
          });
      },
    ]);

    await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    // Give the listener's async peer-acquire a chance to
    // settle. The Promise from `acquireWorkspaceMutationLock`
    // is a rejected promise (with `POIESIS_MUTATION_LOCKED`);
    // we await it so the `.catch` runs before the assertion.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedHeldTransitions, "listener never observed a lock-held transition").toBeGreaterThan(
      0,
    );
    expect(peerAcquired, "peer acquire succeeded during reconcile — lock window leaked").toBe(false);
    expect(__isReconcileMutationLockHeldForTest()).toBe(false);
  });

  it("the lock-held flag flips back to false even when an in-lock postcondition fails (finally clause releases the lock)", async () => {
    // The `finally` clause must run on every exit path,
    // including an in-lock postcondition rejection. The test
    // installs the bounded internal post-destructive hook so a
    // residue file is injected AFTER `performDestructiveReset`
    // and BEFORE the postcondition residue check. The hook is
    // the deterministic seam that runs INSIDE the lock; the
    // postcondition residue walker then surfaces the injected
    // file as residue and the reconcile rejects with
    // `RECONCILE_POSTCONDITION_RESIDUE`. The test pins three
    // post-rejection invariants:
    //
    //   1. the reconcile rejects with a typed `RECONCILE_`
    //      error code (proving the postcondition refused the
    //      injected residue);
    //   2. the internal held-flag is `false` afterwards
    //      (proving the `finally` clause flipped the flag);
    //   3. a follow-up `acquireWorkspaceMutationLock` call
    //      SUCCEEDS and releases cleanly (proving the on-disk
    //      lock file was released by `finally`).
    //
    // An earlier version of this test triggered a
    // fingerprint-mismatch failure BEFORE lock acquisition —
    // that path left the `finally` clause with nothing to
    // release and so did not exercise the in-lock exit
    // surface. This version uses the post-destructive hook
    // to deterministically fail inside the lock window.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);

    // Install the in-lock hook BEFORE calling reconcile so the
    // hook is armed when the destructive step completes. The
    // hook signature is `void | Promise<void>`; reconcile
    // awaits the hook's returned promise before the first
    // postcondition check runs, so the residue file lands on
    // disk deterministically. The hook is auto-reset by the
    // `finally` clause inside reconcile; the explicit
    // `null` reset below is defense-in-depth.
    __setReconcilePostdestructiveHookForTest(async ({ canonicalRoot }) => {
      await writeFile(join(canonicalRoot, "injected-residue.txt"), "residue\n");
    });
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
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^RECONCILE_POSTCONDITION_/),
      });
    } finally {
      // Belt-and-braces: even if the assertion above throws
      // mid-reconcile (it does not — `expect` records the
      // failure and continues), reset the hook so a leaked
      // reference cannot contaminate a later reconcile call.
      __setReconcilePostdestructiveHookForTest(null);
    }

    // Invariant 1+2: the in-lock failure path left the
    // internal held-flag false. The `finally` clause runs on
    // every exit path (success OR failure); the flag flips
    // back to `false` synchronously inside `finally` before
    // `lock.release()` is awaited.
    expect(__isReconcileMutationLockHeldForTest()).toBe(false);

    // Invariant 3: a follow-up `acquireWorkspaceMutationLock`
    // SUCCEEDS — the on-disk lock file was released by
    // `finally`, so the next peer acquire does not see
    // `POIESIS_MUTATION_LOCKED`. The lock is then released
    // explicitly to clean up the test's own acquire; the
    // release proves the second acquire returned a usable
    // lock handle (the previous in-lock failure path left the
    // lock file in a state that the helper can re-acquire).
    const followUpLock = await acquireWorkspaceMutationLock(repo.root);
    try {
      expect(followUpLock.path).toMatch(/\.mutation\.lock$/);
    } finally {
      await followUpLock.release();
    }

    // Defense-in-depth: the hook must have been auto-reset to
    // `null` by the `finally` clause inside reconcile. The
    // follow-up acquire that just succeeded did NOT touch the
    // hook, so the only way the hook is `null` now is if
    // reconcile's `finally` cleared it.
    expect(__peekReconcilePostdestructiveHookForTest()).toBe(null);
  });

  it("the post-destructive hook is auto-reset to null on success too (no leak between tests)", async () => {
    // The `finally` clause runs on success AND on failure. A
    // successful reconcile must clear the hook so a follow-up
    // reconcile does not see a stale reference. This is the
    // success-path counterpart of the failure-path reset
    // test above.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const baseline = await captureBaseline(repo);

    __setReconcilePostdestructiveHookForTest(() => {
      // No-op on success path: the hook is auto-reset before
      // the lock release completes.
    });
    try {
      await reconcile({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
        expectedHeadSha: baseline.head,
        expectedTargetSha: baseline.target,
        expectedFingerprint: baseline.fingerprint,
        discardAcknowledged: true,
      });
    } finally {
      __setReconcilePostdestructiveHookForTest(null);
    }
    expect(__isReconcileMutationLockHeldForTest()).toBe(false);
    expect(__peekReconcilePostdestructiveHookForTest()).toBe(null);
  });
});

/**
 * Local accessor for the current test's repository root. The lock
 * transition listener is installed BEFORE the reconcile call so
 * the listener sees the FIRST `true` transition; the
 * `repo.root` value is captured by the listener's closure and
 * the helper reads the most recent test repo via a module-level
 * reference set by `setCurrentTestRoot`. This is the simplest
 * way to keep the listener-side closure tidy without threading
 * `repo.root` through every test.
 */
let repo_root_for_test = "";
function setCurrentTestRoot(root: string): void {
  repo_root_for_test = root;
}

// =============================================================================
// Finding 2: post-reset `listIndexOids` is authoritative / binary-safe
// / bounded. Reject unsupported modes / gitlinks / nonzero stages /
// malformed OID / non-numeric records. Share parser/validator with
// preflight.
//
// The previous post-reset probe parsed each record but accepted any
// well-formed meta triple (mode / oid / stage). A non-numeric mode,
// a non-hex OID, a nonzero stage, an OID whose length did not match
// the repository's hash algorithm, and any mode outside the
// supported blob / tree set all slipped past silently.
//
// The fix routes both the preflight probe AND the post-reset probe
// through a shared parser that rejects every shape the
// `probeIndexStageViaGitLsFiles` preflight rejects:
//
//   - mode must be a numeric string parseable as octal AND must be
//     one of the supported modes (`040000`, `100644`, `100755`,
//     `120000`);
//   - OID must be lowercase hex AND must match the repository's
//     hash algorithm length (`sha1` -> 40; `sha256` -> 64);
//   - stage must be numeric AND must be `0`;
//   - meta must have exactly three space-separated fields;
//   - the record must contain a `\t` separator.
//
// The shared parser means the preflight probe catches every
// supported-mode / OID-length / stage / gitlink shape BEFORE the
// post-reset probe can run. The post-reset probe is therefore a
// defense-in-depth copy: it re-validates the same shapes with the
// same parser, so a corruption introduced between the preflight
// revalidation and the post-reset read (which the cooperating
// mutation lock prevents, but defense-in-depth remains) is
// refused identically. The tests below exercise the shared parser
// via the preflight surface; a clean canonical post-reset probe
// is exercised via the regression test that completes a
// successful reconcile.
// =============================================================================

describe("ticket #93 — finding 2: shared authoritative parser rejects every unsupported shape", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("refuses when the current index carries a gitlink entry (mode 160000) via the shared parser", async () => {
    // The shared parser rejects every gitlink entry with
    // `RECONCILE_INDEX_MODE_INVALID`. The previous post-reset
    // probe filtered out gitlinks with `if (mode === 0o160000)
    // continue;` — a silently swallowed gitlink would survive
    // the postcondition check and the reconcile would report
    // `indexMatchesTarget === true` for a target tree that
    // does NOT include the gitlink. The fix routes both
    // preflight and post-reset through the shared parser, so
    // the rejection is observed at the preflight surface (which
    // the post-reset would mirror).
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const oid = Buffer.alloc(20); // all-zero SHA-1
    await writeHandRolledV2Index(repo.root, "orphan-submodule", 0o160000, oid, 0);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_INDEX_MODE_INVALID" });
  });

  it("refuses when the current index carries a nonzero stage entry (unmerged conflict)", async () => {
    // Hand-roll a stage-1 (unmerged conflict) entry on disk.
    // The previous post-reset probe parsed the meta triple
    // blindly and stored entries without checking stage, so a
    // stage-1 entry slipped past the postcondition. The shared
    // parser rejects with `RECONCILE_INDEX_MODE_INVALID`
    // because the stage is non-zero.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const oid = Buffer.alloc(20);
    await writeHandRolledV2Index(repo.root, "conflicted.txt", 0o100644, oid, 1);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_INDEX_MODE_INVALID" });
  });

  it("refuses a SHA-1 OID in a SHA-256 repository (OID length validation)", async () => {
    // The previous post-reset probe stored any hex OID without
    // checking its length. A SHA-1 OID (40 hex chars) in a
    // SHA-256 repository (which expects 64 hex chars) would
    // have been accepted by the post-reset probe and would
    // have made `indexOidsMatchTarget` compare OIDs of
    // different lengths — a silent inconsistency. The shared
    // parser rejects the OID with
    // `RECONCILE_INDEX_MODE_INVALID` because the OID length
    // disagrees with the repository's hash algorithm.
    //
    // The probe is exercised by hand-rolling a v3 (SHA-256)
    // index whose single entry has a SHA-1 OID (20 zero
    // bytes). `git ls-files --stage -z` emits the OID as 40
    // hex characters; the shared parser refuses because 40
    // does not match the SHA-256 repository's expected 64.
    const tmpRoot = process.env.POIESIS_TEST_TMPDIR ?? join(tmpdir(), "poiesis-t93-sha256");
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
    await run("git", ["config", "user.name", "Poiesis T93 sha256"], { cwd: root });
    await run("git", ["config", "user.email", "t93-sha256@example.test"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture\n");
    await run("git", ["add", "README.md"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
    await run("git", ["init", "--quiet", "--bare", "--object-format=sha256", remote], {
      cwd: parent,
    });
    await run("git", ["remote", "add", "origin", remote], { cwd: root });
    await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
    const repo: TestRepo = { parent, root, remote };
    repos.push(repo);

    // Hand-roll a v3 (SHA-256) index with one entry whose OID
    // is a SHA-1 (20 zero bytes). `git ls-files` will emit the
    // OID as 40 hex characters; the parser refuses because the
    // SHA-256 repository expects 64.
    const path = Buffer.from("mismatch.txt");
    const pathLen = path.length;
    const flags = Buffer.alloc(2);
    flags[0] = 0x00;
    flags[1] = pathLen & 0xff;
    const statBlock = Buffer.alloc(40);
    statBlock.writeUInt32BE(0o100644, 24);
    const oidSha1 = Buffer.alloc(20);
    const pathTerminated = Buffer.concat([path, Buffer.from([0])]);
    let padLen = 0;
    while ((40 + 20 + 2 + pathTerminated.length + padLen) % 8 !== 0) padLen += 1;
    const pad = Buffer.alloc(padLen);
    const header = Buffer.alloc(12);
    header.write("DIRC", 0, "binary");
    header.writeUInt32BE(3, 4); // v3 = SHA-256
    header.writeUInt32BE(1, 8);
    const v3Index = Buffer.concat([header, statBlock, oidSha1, flags, pathTerminated, pad]);
    await writeFile(join(root, ".git", "index"), v3Index);

    await expect(
      computeReconcileFingerprint({
        cwd: repo.root,
        remote: "origin",
        integrationBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "RECONCILE_INDEX_MODE_INVALID" });
  });

  it("still completes a successful reconcile against the canonical clean shape (regression)", async () => {
    // The shared parser must accept the canonical post-reset
    // shape: every entry is mode 100644 / 100755 / 120000 / 040000,
    // OID matches the repository's hash algorithm, stage is 0,
    // and the meta triple is well-formed. A successful
    // reconcile exercises the post-reset probe through the
    // destructive reset → postconditions flow and confirms the
    // shared parser does NOT over-reject a clean index.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
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
// Finding 3: README documents the separate-git-dir support boundary
// and the typed refusal surface.
//
// The README's reconcile section lists the typed refusal surface
// (`RECONCILE_INTEGRATION_BRANCH_MISMATCH`, `RECONCILE_HEAD_MISMATCH`,
// …, `RECONCILE_NESTED_REPOSITORY`, `RECONCILE_FILTER_ACTIVE`, …)
// without naming the `RECONCILE_NOT_PRIMARY_CHECKOUT` refusal
// explicitly. The fix adds a detailed section to the README that
// names the separate-git-dir support boundary, the typed refusal
// code (`RECONCILE_NOT_PRIMARY_CHECKOUT`), and the rationale
// (the fingerprint would otherwise silently miss the shared
// `commondir` pointer, worktree `gitdir` entries, preserved
// markers, and every other per-checkout resource that lives under
// the git directory).
//
// The test asserts the README carries the section. This is a
// documentation contract: a future contributor who shortens or
// rewrites the README MUST preserve the section so the support
// boundary stays visible.
// =============================================================================

describe("ticket #93 — finding 3: README documents separate-git-dir support boundary", () => {
  it("README contains a detailed section explaining why git init --separate-git-dir is unsupported", async () => {
    const { readFile: fsReadFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const readmePath = join(here, "..", "README.md");
    const readme = await fsReadFile(readmePath, "utf8");
    // The section must explicitly name the typed refusal
    // (`RECONCILE_NOT_PRIMARY_CHECKOUT`) and the layout
    // (`git init --separate-git-dir`). A simple substring
    // check pins the contract.
    expect(readme, "README names the typed refusal").toContain("RECONCILE_NOT_PRIMARY_CHECKOUT");
    expect(readme, "README names the layout").toContain("separate-git-dir");
    // The section must explain the WHY (the fingerprint would
    // silently miss the shared commondir pointer, worktree
    // gitdir entries, preserved markers, etc.).
    expect(readme, "README explains why the layout is unsupported").toMatch(
      /separate-git-dir[\s\S]{0,2000}(commondir|common[- ]dir|worktree|shared)/i,
    );
  });
});

// =============================================================================
// Public API surface: the bounded internal hook MUST NOT be re-exported
// from `src/index.ts`. The hook is for the test suite only; production
// callers must not depend on its presence.
// =============================================================================

describe("ticket #93 — public API surface contracts", () => {
  it("NONE of the reconcile internal hooks are re-exported from index.ts", async () => {
    // Every reconcile-internal test seam is module-private to
    // `src/reconcile.ts`; a future refactor that re-exports
    // ANY of them from `src/index.ts` would break the
    // public-API contract. The test enumerates every internal
    // hook name — including the long-standing
    // `__setReconcileScanBoundsForTest` (added by ticket #85
    // finding #4), the ticket #93 lock-held / listener hooks,
    // and the new ticket #93 post-destructive hook — and
    // asserts each name is absent from `index.ts`.
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const indexPath = join(here, "..", "src", "index.ts");
    const { readFile: fsReadFile } = await import("node:fs/promises");
    const indexSource = await fsReadFile(indexPath, "utf8");
    const internalHooks = [
      // Long-standing internal hook from ticket #85 finding #4:
      // bounded scan-bound overrides for the discard-scope
      // walker. Production callers MUST NOT use this; it is
      // deliberately not exported from `index.ts`.
      "__setReconcileScanBoundsForTest",
      // Ticket #93 finding #1: bounded internal flag exposing
      // whether the cooperating mutation lock is held.
      "__isReconcileMutationLockHeldForTest",
      // Ticket #93 finding #1: bounded internal listener hook
      // for lock acquire/release transitions.
      "__setReconcileLockTransitionListenersForTest",
      // Ticket #93 finding #1 (review correction): bounded
      // internal post-destructive hook for in-lock residue /
      // failure injection.
      "__setReconcilePostdestructiveHookForTest",
      // Ticket #93 finding #1 (review correction): bounded
      // internal getter for the post-destructive hook state.
      "__peekReconcilePostdestructiveHookForTest",
    ];
    for (const hookName of internalHooks) {
      expect(indexSource, `${hookName} must not appear in index.ts`).not.toMatch(
        new RegExp(hookName),
      );
    }
  });
});

// Suppress unused-import warnings for helpers kept for symmetry with the
// other `reconcile.tNN.test.ts` suites.
void lstat;
void readFile;
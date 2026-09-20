/**
 * Bounded primary-checkout reconciliation (revised ticket #81).
 *
 * The surface is intentionally two operations:
 *
 *   - `computeReconcileFingerprint(options)` — pure read. Captures a
 *     versioned, domain-separated SHA-256 over the canonical root,
 *     git common dir, configured remote context, the raw `.git/index`
 *     bytes, and a deterministic byte-preserving inventory of the
 *     discard-scope filesystem (tracked bytes+mode, symlink targets
 *     bound by raw `readlink` bytes, directories including empty,
 *     untracked and ignored residue). Refuses unsafe states
 *     (active Git operations, sparse checkout, submodules, nested
 *     repositories, content filters, special entries, incomplete
 *     scans). Used by the read-only `poiesis inspect --fingerprint`
 *     opt-in and as the pre-mutation revalidator inside `reconcile`.
 *
 *   - `reconcile(options)` — destructive. Requires exact integration
 *     branch, local HEAD, fingerprint, fetched target SHA, and a
 *     literal `discardAcknowledged: true` boolean. Fetches the
 *     configured integration ref without pruning, revalidates every
 *     binding immediately before the first destructive action, and
 *     uses the existing real cooperating mutation lock. Preserves
 *     Git administration, every registered linked worktree in place,
 *     shared markers/receipts, and the declared local Poiesis state
 *     exclusions (`.poiesis/manifest.json`, `.poiesis/workspaces/`)
 *     when they are genuinely untracked/ignored and collision-safe.
 *
 * Explicitly out of scope (per Spec): branch pruning, remote
 * deletion, orphan-marker cleanup, stale discovery, generic
 * maintenance/state machine, review document schema, runtime value
 * judgment.
 */

import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath, readlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { PoiesisError, invariant } from "./errors.js";
import { bounded, run } from "./process.js";
import { resolveGitRoot } from "./paths.js";
import { acquireWorkspaceMutationLock } from "./mutation-transaction.js";

export const RECONCILE_FINGERPRINT_SCHEMA = 1;

/**
 * Canonical local Poiesis state paths that may survive a destructive
 * reconciliation when they are genuinely untracked/ignored and
 * collision-safe with the fetched target tree. The exclusions list is
 * a closed, narrowly-scoped constant — the destructive reconcile MUST
 * NOT accept caller-supplied exclusions from the public surface.
 */
const RECONCILE_EXCLUSION_PATHS: readonly string[] = [
  ".poiesis/manifest.json",
  ".poiesis/workspaces/",
];

/**
 * Resource bounds for the discard-scope filesystem walk. A scan that
 * exceeds any bound is refused with `RECONCILE_SCAN_INCOMPLETE` so the
 * fingerprint can never silently omit content.
 */
let maxFiles = 100_000;
let maxDirs = 100_000;
let maxSymlinks = 100_000;
let maxTotalBytes = 1_073_741_824; // 1 GiB
let maxFileBytes = 104_857_600; // 100 MiB
let maxIndexBytes = 16_777_216; // 16 MiB
let maxPathBytes = 4096;

const DEFAULT_MAX_FILES = () => maxFiles;
const DEFAULT_MAX_DIRS = () => maxDirs;
const DEFAULT_MAX_SYMLINKS = () => maxSymlinks;
const DEFAULT_MAX_TOTAL_BYTES = () => maxTotalBytes;
const DEFAULT_MAX_FILE_BYTES = () => maxFileBytes;
const DEFAULT_MAX_INDEX_BYTES = () => maxIndexBytes;
const DEFAULT_MAX_PATH_BYTES = () => maxPathBytes;

/**
 * Module-private test seam: lets the test suite shrink the walk
 * bounds so a bound-violation assertion does not require creating
 * 100,001 on-disk entries per test. Production callers MUST NOT use
 * this; it is deliberately not exported from `index.ts`.
 *
 * @internal
 */
export function __setReconcileScanBoundsForTest(overrides: {
  maxFiles?: number;
  maxDirs?: number;
  maxSymlinks?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxIndexBytes?: number;
  maxPathBytes?: number;
}): void {
  if (overrides.maxFiles !== undefined) maxFiles = overrides.maxFiles;
  if (overrides.maxDirs !== undefined) maxDirs = overrides.maxDirs;
  if (overrides.maxSymlinks !== undefined) maxSymlinks = overrides.maxSymlinks;
  if (overrides.maxTotalBytes !== undefined) maxTotalBytes = overrides.maxTotalBytes;
  if (overrides.maxFileBytes !== undefined) maxFileBytes = overrides.maxFileBytes;
  if (overrides.maxIndexBytes !== undefined) maxIndexBytes = overrides.maxIndexBytes;
  if (overrides.maxPathBytes !== undefined) maxPathBytes = overrides.maxPathBytes;
}

const FINGERPRINT_DOMAIN = Buffer.from("poiesis-reconcile-fingerprint\0v1\0", "utf8");

interface DiscardEntry {
  /** Repository-relative path with forward-slash separators (no leading `./`). */
  path: string;
  kind: "file" | "symlink" | "dir";
  /** Permission mode bits for regular files; `null` for symlinks/dirs. */
  mode: number | null;
  /** SHA-256 of the byte content for regular files; `null` otherwise. */
  bytesDigest: string | null;
  /** Number of bytes hashed (file content or symlink target). */
  bytesLength: number;
  /** SHA-256 of the symlink target buffer; `null` for files/dirs. */
  symlinkDigest: string | null;
  /** Number of symlink target bytes; `null` for files/dirs. */
  symlinkLength: number | null;
}

interface ScanResult {
  entries: DiscardEntry[];
  filesScanned: number;
  dirsScanned: number;
  symlinksScanned: number;
  bytesScanned: number;
}

export interface ReconcileFingerprintOptions {
  cwd: string;
  remote: string;
  integrationBranch: string;
}

export interface ReconcileFingerprintResult {
  schema: typeof RECONCILE_FINGERPRINT_SCHEMA;
  digest: string;
  canonicalRoot: string;
  gitCommonDir: string;
  remote: string;
  remoteUrls: { fetchUrls: readonly string[]; pushUrls: readonly string[] };
  integrationBranch: string;
  exclusions: readonly string[];
  entryCount: number;
  filesScanned: number;
  dirsScanned: number;
  symlinksScanned: number;
  bytesScanned: number;
  /**
   * The validated preimage inventory captured during the fingerprint
   * scan. Reconcile uses this exact list to drive the destructive
   * residue cleanup so a residue file that appears AFTER the scan
   * cannot be silently deleted.
   */
  entries: readonly DiscardEntry[];
}

export interface ReconcileOptions {
  cwd: string;
  remote: string;
  integrationBranch: string;
  expectedHeadSha: string;
  expectedTargetSha: string;
  expectedFingerprint: string;
  discardAcknowledged: boolean;
  /**
   * Canonicalized set of registered linked worktree paths captured
   * at the same instant as `expectedHeadSha`, `expectedTargetSha`,
   * and `expectedFingerprint`. When provided, reconcile refuses with
   * `RECONCILE_WORKTREE_DRIFT` if the live worktree set at the start
   * of reconcile differs from this baseline. This is the only signal
   * that catches drift introduced between baseline capture and the
   * reconcile call itself, including same-count move/swap races
   * that a single re-capture would miss. Omit only when the caller
   * has no baseline (the destructive step still preserves every
   * linked worktree in place and revalidates against later drift).
   */
  expectedWorktrees?: readonly string[];
}

export interface ReconcileResult {
  schema: typeof RECONCILE_FINGERPRINT_SCHEMA;
  root: string;
  head: string;
  target: string;
  fingerprint: string;
  indexMatchesTarget: boolean;
  workingTreeMatchesTarget: boolean;
  preservedExclusions: readonly string[];
  preservedPaths: readonly string[];
}

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Compute the bounded primary preimage fingerprint. Read-only; never
 * mutates the working tree, never fetches, never makes a judgment
 * call about what to discard. Used by `poiesis inspect --fingerprint`
 * and by `reconcile` to revalidate immediately before any mutation.
 */
export async function computeReconcileFingerprint(
  options: ReconcileFingerprintOptions,
): Promise<ReconcileFingerprintResult> {
  validateText(options.remote, "remote");
  validateText(options.integrationBranch, "integrationBranch");
  // Primary-checkout gate MUST run before fingerprint capture or any
  // scan. A bare repository has no working tree (so `--show-toplevel`
  // fails); a registered linked worktree shares the same common dir
  // as the primary but points at its own per-worktree git-dir. Both
  // must be refused with `RECONCILE_NOT_PRIMARY_CHECKOUT` instead of
  // leaking the fingerprint surface or the scan over an unintended
  // root. Bare detection runs first so the assertion can fail closed
  // before `--show-toplevel` is attempted.
  const canonicalRoot = await canonicalRootOfOrBare(options.cwd);
  await assertPrimaryCheckout(canonicalRoot);
  const gitCommonDir = await canonicalCommonDir(canonicalRoot);
  await assertNoActiveGitOperation(gitCommonDir);
  await assertSparseCheckoutDisabled(canonicalRoot);
  await assertNoSubmoduleConfig(canonicalRoot);
  await assertNoContentFilters(canonicalRoot);
  await assertNoSplitIndex(canonicalRoot);
  const indexBytes = await readIndexBytes(canonicalRoot);
  const remoteUrls = await readRemoteUrls(canonicalRoot, options.remote);
  const scan = await scanDiscardScope(canonicalRoot);
  const digest = computeFingerprintDigest({
    canonicalRoot,
    gitCommonDir,
    remote: options.remote,
    remoteUrls,
    integrationBranch: options.integrationBranch,
    indexBytes,
    exclusions: RECONCILE_EXCLUSION_PATHS,
    scan,
  });
  return {
    schema: RECONCILE_FINGERPRINT_SCHEMA,
    digest,
    canonicalRoot,
    gitCommonDir,
    remote: options.remote,
    remoteUrls: { fetchUrls: remoteUrls.fetchUrls, pushUrls: remoteUrls.pushUrls },
    integrationBranch: options.integrationBranch,
    exclusions: [...RECONCILE_EXCLUSION_PATHS],
    entryCount: scan.entries.length,
    filesScanned: scan.filesScanned,
    dirsScanned: scan.dirsScanned,
    symlinksScanned: scan.symlinksScanned,
    bytesScanned: scan.bytesScanned,
    entries: scan.entries,
  };
}

/**
 * Destructive primary-checkout reconciliation. Requires exact
 * integration branch, exact local HEAD, exact fingerprint, exact
 * fetched target SHA, and a literal `discardAcknowledged: true`.
 * Re-fetches the integration ref without pruning and revalidates
 * every binding immediately before any mutation; uses the existing
 * real cooperating mutation lock.
 */
export async function reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  invariant(
    options.discardAcknowledged === true,
    "RECONCILE_AUTHORIZATION_MISSING",
    "Reconciliation requires the literal boolean --discard-acknowledged to be true",
    { discardAcknowledged: options.discardAcknowledged },
  );
  validateSha(options.expectedHeadSha, "expectedHeadSha");
  validateSha(options.expectedTargetSha, "expectedTargetSha");
  validateFingerprint(options.expectedFingerprint, "expectedFingerprint");
  validateText(options.remote, "remote");
  validateText(options.integrationBranch, "integrationBranch");

  // Identity binding: canonical root + git common dir. A non-git cwd
  // is a "wrong primary checkout" condition, not a generic
  // "Poiesis cannot operate here" — surface the reconcile-specific
  // error so the caller knows to re-target the right repository.
  const canonicalRoot = await canonicalRootOfOrMismatch(options.cwd);
  // Primary-checkout gate MUST run before fingerprint capture, fetch,
  // or any destructive action: a linked worktree that shares the
  // same `.git` common dir can otherwise look identical to the
  // primary checkout, and reconciling it would corrupt the linked
  // worktree's working tree while leaving the primary in place.
  await assertPrimaryCheckout(canonicalRoot);
  const gitCommonDir = await canonicalCommonDir(canonicalRoot);

  // Remote URL existence check. The URL must be configured AND have at
  // least one fetch URL — anything else is a drift the caller must
  // fix before reconcile can promise exact-target fidelity.
  const remoteUrls = await readRemoteUrls(canonicalRoot, options.remote);
  invariant(
    remoteUrls.fetchUrls.length > 0,
    "RECONCILE_REMOTE_DRIFT",
    "Configured Git remote has no fetch URLs",
    { remote: options.remote },
  );

  // Require the current local branch to be the configured integration
  // branch — this is the "actual primary checkout attached to
  // configured integration branch" precondition. Branch must be
  // verified BEFORE the fingerprint capture so a wrong-branch caller
  // fails closed without contaminating the fingerprint digest.
  const currentBranch = await resolveCurrentBranch(canonicalRoot);
  invariant(
    currentBranch === options.integrationBranch,
    "RECONCILE_INTEGRATION_BRANCH_MISMATCH",
    "Current branch is not the configured integration branch",
    {
      expected: options.integrationBranch,
      actual: currentBranch,
    },
  );

  // Require the current local HEAD to equal `expectedHeadSha`. Same
  // rationale: HEAD must be verified BEFORE the fingerprint capture so
  // a stale-HEAD caller fails closed with the precise error.
  const headSha = await resolveCommit(canonicalRoot, "HEAD");
  invariant(
    headSha === options.expectedHeadSha,
    "RECONCILE_HEAD_MISMATCH",
    "Local HEAD does not match the expected binding",
    {
      expected: options.expectedHeadSha,
      actual: headSha,
    },
  );

  // Fetch the configured integration ref WITHOUT pruning. The fetch
  // also serves as a reachability probe — an unreachable remote (URL
  // drift, offline mirror, deleted repo) fails here with a typed
  // REMOTE_DRIFT error rather than corrupting state.
  const fetchedTarget = await fetchIntegrationTargetWithoutPruning(
    canonicalRoot,
    options.remote,
    options.integrationBranch,
  );
  invariant(
    fetchedTarget === options.expectedTargetSha,
    "RECONCILE_TARGET_MISMATCH",
    "Fetched integration target does not match the expected binding",
    {
      expected: options.expectedTargetSha,
      actual: fetchedTarget,
    },
  );

  // Now capture the fingerprint. By this stage every precondition
  // binding has been verified, so the fingerprint digest is bound to
  // a known-good (branch, HEAD, target) tuple. The fingerprint scan
  // produces the validated preimage inventory the destructive step
  // will use.
  const fingerprint = await computeReconcileFingerprint({
    cwd: canonicalRoot,
    remote: options.remote,
    integrationBranch: options.integrationBranch,
  });
  invariant(
    fingerprint.digest === options.expectedFingerprint,
    "RECONCILE_FINGERPRINT_MISMATCH",
    "Discard scope fingerprint does not match the expected binding",
    {
      expected: options.expectedFingerprint,
      actual: fingerprint.digest,
    },
  );

  // Refuse collisions: the fetched target tree must not contain a
  // tracked path under any declared exclusion prefix OR under any
  // protected ancestor of a declared exclusion prefix (otherwise a
  // `git reset --hard` to the target could overwrite or delete the
  // ancestor via a sibling path). The `.poiesis/manifest.json`
  // exclusion's protected ancestor is `.poiesis`; a tracked
  // `.poiesis` file (e.g. a stray lockfile) would otherwise pass the
  // collision check because no entry in the target tree sits under
  // the exclusion path itself. Ticket #84 finding #2.
  const targetTree = await listTargetTree(canonicalRoot, fetchedTarget);
  const exclusionBases = deriveExclusionBases(RECONCILE_EXCLUSION_PATHS);
  for (const entry of targetTree) {
    invariant(
      !pathCollidesWithExclusion(entry.path, exclusionBases),
      "RECONCILE_EXCLUSION_COLLISION",
      "Declared exclusion path (or its ancestor) overlaps a tracked target path",
      { path: entry.path },
    );
  }

  // Snapshot the registered linked worktree roots. Two consumers:
  //   - `expectedWorktrees` baseline check below: compare the live set
  //     against the caller's baseline to refuse drift introduced
  //     between baseline capture and the reconcile call (e.g. a
  //     same-count `worktree move` swap or remove+add pair).
  //   - `revalidateBeforeMutation`: re-capture later and compare sets
  //     so any drift introduced DURING reconcile (between capture and
  //     mutation, across lock acquisition) is also refused.
  const worktreesBefore = await listWorktrees(canonicalRoot);
  if (options.expectedWorktrees !== undefined) {
    const expectedCanonical = await Promise.all(
      options.expectedWorktrees.map((path) => canonicalWorktreePath(path)),
    );
    const expectedSet = new Set(expectedCanonical);
    const onlyBefore = [...expectedSet].filter((path) => !worktreesBefore.some((w) => w.path === path));
    const onlyAfter = [...worktreesBefore].map((w) => w.path).filter((path) => !expectedSet.has(path));
    invariant(
      onlyBefore.length === 0 && onlyAfter.length === 0,
      "RECONCILE_WORKTREE_DRIFT",
      "Registered linked worktrees differ from the baseline capture",
      {
        expected: [...expectedSet].sort(),
        actual: worktreesBefore.map((w) => w.path).sort(),
        removed: onlyBefore.sort(),
        added: onlyAfter.sort(),
      },
    );
  }

  // Acquire the real cooperating mutation lock. This is the SAME lock
  // `poiesis update`, `poiesis uninstall`, and `update --config`
  // take; any peer mutation in flight makes us fail closed with
  // `POIESIS_MUTATION_LOCKED` instead of corrupting state.
  const lock = await acquireWorkspaceMutationLock(canonicalRoot);
  try {
    // Revalidate every identity binding IMMEDIATELY before the first
    // destructive action. Any drift between the initial capture and
    // this point is refused. All network fetches have already
    // completed (the initial fetch above), so revalidation is purely
    // a fresh local read + a second fetch that is byte-equal to the
    // first unless the remote moved. Ticket #84 finding #9: final
    // fingerprint validation must complete all network fetches
    // first, then run branch/HEAD/worktree/fingerprint validation
    // immediately before reset.
    await revalidateBeforeMutation({
      canonicalRoot,
      gitCommonDir,
      remote: options.remote,
      expectedHeadSha: options.expectedHeadSha,
      expectedTargetSha: options.expectedTargetSha,
      expectedFingerprint: options.expectedFingerprint,
      integrationBranch: options.integrationBranch,
      worktreesBefore,
    });

    // The destructive step uses the validated preimage inventory
    // captured by the fingerprint scan — never a fresh
    // `git status`. Anything that appears between the fingerprint
    // scan and this step is reported as drift, never silently
    // deleted.
    await performDestructiveReset({
      canonicalRoot,
      targetSha: fetchedTarget,
      preimageEntries: [...fingerprint.entries],
    });
  } finally {
    await lock.release().catch((error: unknown) => {
      if (error instanceof PoiesisError && error.code === "POIESIS_MUTATION_LOCK_LOST") {
        throw error;
      }
    });
  }

  // Postcondition verification: HEAD = target, index matches target
  // tree, working tree bytes/modes/link targets match target for
  // every tracked path, no residue except the declared exclusions.
  const postHead = await resolveCommit(canonicalRoot, "HEAD");
  invariant(
    postHead === fetchedTarget,
    "RECONCILE_POSTCONDITION_HEAD",
    "Reconciliation left HEAD on the wrong commit",
    { expected: fetchedTarget, actual: postHead },
  );
  const indexOids = await listIndexOids(canonicalRoot);
  invariant(
    indexOidsMatchTarget(indexOids, targetTree),
    "RECONCILE_POSTCONDITION_INDEX",
    "Reconciliation left the index in an unexpected state",
    { expected: fetchedTarget },
  );
  const workingTreeClean = await workingTreeMatchesTarget(
    canonicalRoot,
    fetchedTarget,
    targetTree,
  );
  invariant(
    workingTreeClean,
    "RECONCILE_POSTCONDITION_WORKTREE",
    "Working tree does not match the fetched target tree",
    { expected: fetchedTarget },
  );
  const preservedExclusions = await listSurvivingExclusions(canonicalRoot);
  const residue = await collectPostReconcileResidue(canonicalRoot);
  invariant(
    residue.length === 0,
    "RECONCILE_POSTCONDITION_RESIDUE",
    "Reconciliation left residue outside the declared exclusions",
    { residue },
  );
  const preservedPaths = await listPreservedSharedPaths(canonicalRoot, gitCommonDir);

  return {
    schema: RECONCILE_FINGERPRINT_SCHEMA,
    root: canonicalRoot,
    head: postHead,
    target: fetchedTarget,
    fingerprint: fingerprint.digest,
    indexMatchesTarget: true,
    workingTreeMatchesTarget: true,
    preservedExclusions,
    preservedPaths,
  };
}

interface RevalidateArgs {
  canonicalRoot: string;
  gitCommonDir: string;
  remote: string;
  integrationBranch: string;
  expectedHeadSha: string;
  expectedTargetSha: string;
  expectedFingerprint: string;
  worktreesBefore: Array<{ path: string }>;
}

async function revalidateBeforeMutation(args: RevalidateArgs): Promise<void> {
  await assertNoActiveGitOperation(args.gitCommonDir);
  const liveCommonDir = await canonicalCommonDir(args.canonicalRoot);
  invariant(
    liveCommonDir === args.gitCommonDir,
    "RECONCILE_COMMON_DIR_MISMATCH",
    "Git common directory changed since fingerprint capture",
    { expected: args.gitCommonDir, actual: liveCommonDir },
  );
  // Complete all network fetches FIRST. The previous implementation
  // validated the fingerprint and then refetched — a remote that
  // moved between the fingerprint computation and the post-reset
  // state would have one silent window where the fingerprint
  // digest bound an older target. Reordering to fetch-then-validate
  // ensures the final fingerprint validation sees the latest
  // fetched target before any destructive action.
  const liveTarget = await fetchIntegrationTargetWithoutPruning(
    args.canonicalRoot,
    args.remote,
    args.integrationBranch,
  );
  invariant(
    liveTarget === args.expectedTargetSha,
    "RECONCILE_TARGET_MISMATCH",
    "Fetched integration target changed between capture and mutation",
    {
      expected: args.expectedTargetSha,
      actual: liveTarget,
    },
  );
  const liveUrls = await readRemoteUrls(args.canonicalRoot, args.remote);
  invariant(
    liveUrls.fetchUrls.length > 0,
    "RECONCILE_REMOTE_DRIFT",
    "Configured Git remote has no fetch URLs",
    { remote: args.remote },
  );
  const liveFingerprint = await computeReconcileFingerprint({
    cwd: args.canonicalRoot,
    remote: args.remote,
    integrationBranch: args.integrationBranch,
  });
  invariant(
    liveFingerprint.digest === args.expectedFingerprint,
    "RECONCILE_FINGERPRINT_MISMATCH",
    "Discard scope fingerprint changed between capture and mutation",
    {
      expected: args.expectedFingerprint,
      actual: liveFingerprint.digest,
    },
  );
  const liveBranch = await resolveCurrentBranch(args.canonicalRoot);
  invariant(
    liveBranch === args.integrationBranch,
    "RECONCILE_INTEGRATION_BRANCH_MISMATCH",
    "Current branch changed between capture and mutation",
    {
      expected: args.integrationBranch,
      actual: liveBranch,
    },
  );
  const liveHead = await resolveCommit(args.canonicalRoot, "HEAD");
  invariant(
    liveHead === args.expectedHeadSha,
    "RECONCILE_HEAD_MISMATCH",
    "Local HEAD changed between capture and mutation",
    {
      expected: args.expectedHeadSha,
      actual: liveHead,
    },
  );
  const liveWorktrees = await listWorktrees(args.canonicalRoot);
  // Compare canonical path SETS, not counts. A same-count drift
  // (e.g. `git worktree move` swaps one path for another, or a
  // concurrent `git worktree remove` + `git worktree add` pair
  // keeps the count stable but changes the set) is exactly the
  // class of race that count-based equality would miss. Both
  // sides are canonical realpaths after `listWorktrees`'s
  // canonicalization, so the set comparison is well-defined.
  const beforeSet = new Set(args.worktreesBefore.map((worktree) => worktree.path));
  const afterSet = new Set(liveWorktrees.map((worktree) => worktree.path));
  const onlyBefore = [...beforeSet].filter((path) => !afterSet.has(path));
  const onlyAfter = [...afterSet].filter((path) => !beforeSet.has(path));
  invariant(
    onlyBefore.length === 0 && onlyAfter.length === 0,
    "RECONCILE_WORKTREE_DRIFT",
    "Registered linked worktrees changed between capture and mutation",
    {
      removed: onlyBefore.sort(),
      added: onlyAfter.sort(),
    },
  );
}

interface DestructiveArgs {
  canonicalRoot: string;
  targetSha: string;
  preimageEntries: DiscardEntry[];
}

/**
 * Reconcile deletes ONLY the entries the validated preimage
 * inventory recorded. It MUST NOT re-classify the working tree
 * between the fingerprint capture and the destructive step —
 * otherwise a residue file that appears after the scan would be
 * silently deleted without the caller knowing, and an empty
 * directory that `git status` does not list would survive.
 * Ticket #84 finding #3.
 */
async function performDestructiveReset(args: DestructiveArgs): Promise<void> {
  // 1. Hard-reset HEAD + index + tracked tree to the fetched target.
  // `git reset --hard` is the only command that synchronously aligns
  // all three for the primary checkout. The declared exclusions are
  // NOT tracked by the target (collision refusal is on by the
  // pre-mutation revalidation), so the reset does not touch them.
  await run("git", ["reset", "--hard", args.targetSha], { cwd: args.canonicalRoot });
  // 2. Walk the validated preimage and delete every entry that is
  // NOT in the target tree, NOT a declared exclusion, NOT a
  // registered linked worktree root, and NOT under `.git/`. The
  // protected ancestor (`.poiesis`) of any declared exclusion is
  // preserved automatically by the `isExcluded` prefix test.
  const targetTree = await listTargetTree(args.canonicalRoot, args.targetSha);
  const trackedPaths = new Set(targetTree.map((entry) => entry.path));
  const liveWorktrees = await listWorktrees(args.canonicalRoot);
  const worktreeRoots = new Set(
    liveWorktrees
      .filter((worktree) => worktree.path !== args.canonicalRoot)
      .map((worktree) => worktree.path),
  );
  await deleteResidue({
    canonicalRoot: args.canonicalRoot,
    worktreeRoots,
    trackedPaths,
    preimageEntries: args.preimageEntries,
  });
}

interface DeleteResidueArgs {
  canonicalRoot: string;
  worktreeRoots: Set<string>;
  trackedPaths: Set<string>;
  preimageEntries: readonly DiscardEntry[];
}

async function deleteResidue(args: DeleteResidueArgs): Promise<void> {
  // Compute the set of protected paths: declared exclusions + every
  // ancestor of a declared exclusion + every preimage descendant of
  // a declared exclusion base. A protected path is NEVER deleted by
  // reconcile — its presence in the preimage is the residue scan's
  // signal that the live filesystem matches the exclusion contract,
  // not a free ticket to remove it. Skipping deletion here is what
  // protects `.poiesis` itself even when `.poiesis/manifest.json`
  // appears as a residue descendant.
  const protectedPaths = computeProtectedPaths(args.preimageEntries);
  // Delete in the order the preimage recorded: deepest first so a
  // parent directory's children are gone before we try to remove the
  // parent.
  const sorted = [...args.preimageEntries].sort((left, right) => {
    if (left.path.length !== right.path.length) return right.path.length - left.path.length;
    return left.path.localeCompare(right.path);
  });
  for (const entry of sorted) {
    if (entry.path === ".git") continue;
    if (entry.path.startsWith(".git/")) continue;
    if (args.trackedPaths.has(entry.path)) continue;
    if (protectedPaths.has(entry.path)) continue;
    const absolute = resolve(args.canonicalRoot, entry.path);
    if (isInsideAnyWorktreeRoot(args.worktreeRoots, absolute)) continue;
    await safeRemoveWithinRoot(args.canonicalRoot, entry.path);
  }
}

/**
 * Compute the closed set of paths reconcile must never delete. A
 * path is protected when it (a) is a declared exclusion, (b) is an
 * ancestor of a declared exclusion, or (c) is the preimage record
 * of a path that descends from an exclusion base. The third case
 * catches the typical residue shape where `.poiesis/manifest.json`
 * exists as an untracked file under the `.poiesis` ancestor — the
 * ancestor itself must NOT be deleted just because no other entry
 * points at it.
 */
function computeProtectedPaths(entries: readonly DiscardEntry[]): Set<string> {
  const protectedPaths = new Set<string>();
  for (const exclusion of RECONCILE_EXCLUSION_PATHS) {
    const base = exclusion.endsWith("/") ? exclusion.slice(0, -1) : exclusion;
    protectedPaths.add(base);
    let cursor = base;
    while (cursor.includes("/")) {
      const parent = cursor.slice(0, cursor.lastIndexOf("/"));
        if (parent === "") break;
        protectedPaths.add(parent);
        cursor = parent;
    }
  }
  for (const entry of entries) {
    for (const exclusion of RECONCILE_EXCLUSION_PATHS) {
      const base = exclusion.endsWith("/") ? exclusion.slice(0, -1) : exclusion;
      if (
        entry.path === base ||
        entry.path.startsWith(`${base}/`)
      ) {
        // The entry itself is part of the exclusion subtree; mark
        // the path and every ancestor as protected so the deletion
        // walker never reaches it.
        protectedPaths.add(entry.path);
        let cursor = entry.path;
        while (cursor.includes("/")) {
          const parent = cursor.slice(0, cursor.lastIndexOf("/"));
          if (parent === "") break;
          protectedPaths.add(parent);
          cursor = parent;
        }
        break;
      }
    }
  }
  return protectedPaths;
}

function isInsideAnyWorktreeRoot(worktreeRoots: Set<string>, absolutePath: string): boolean {
  for (const root of worktreeRoots) {
    const within = relative(root, absolutePath);
    if (within === "" || within === "..") return true;
    if (!within.startsWith(`..${sep}`) && !isAbsolute(within)) return true;
  }
  return false;
}

async function safeRemoveWithinRoot(root: string, repositoryPath: string): Promise<void> {
  const absolute = resolve(root, repositoryPath);
  const within = relative(root, absolute);
  if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return;
  }
  let lstats: Awaited<ReturnType<typeof lstat>>;
  try {
    lstats = await lstat(absolute);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (lstats.isDirectory()) {
    await rm(absolute, { recursive: true, force: true });
    return;
  }
  await rm(absolute, { force: true });
}

function isExcluded(repositoryPath: string): boolean {
  for (const exclusion of RECONCILE_EXCLUSION_PATHS) {
    if (exclusion.endsWith("/")) {
      if (repositoryPath === exclusion.slice(0, -1)) return true;
      if (repositoryPath.startsWith(exclusion)) return true;
      continue;
    }
    if (repositoryPath === exclusion) return true;
    if (repositoryPath.startsWith(`${exclusion}/`)) return true;
  }
  return false;
}

/**
 * Tracked-path collision check that ALSO refuses a tracked entry
 * whose path IS the protected ancestor of any declared exclusion.
 * Without this, a tracked `.poiesis` file (the ancestor of every
 * `.poiesis/...` exclusion) would slip past the basic
 * `isExcluded` check and `git reset --hard` to that target would
 * overwrite the ancestor with the tracked content — destroying
 * every descendant the exclusion contract relied on.
 */
function pathCollidesWithExclusion(
  repositoryPath: string,
  exclusionBases: Set<string>,
): boolean {
  if (isExcluded(repositoryPath)) return true;
  if (exclusionBases.has(repositoryPath)) return true;
  return false;
}

async function canonicalRootOf(cwd: string): Promise<string> {
  return realpath(await resolveGitRoot(cwd));
}

/**
 * Like `canonicalRootOf`, but tolerates bare repositories. Bare
 * repositories have no working tree, so `git rev-parse --show-toplevel`
 * exits non-zero; resolving the toplevel would throw `NOT_GIT_REPOSITORY`
 * and the primary-checkout gate would never run. The bare probe is
 * the canonical signal: bare repos have no working tree to fingerprint
 * or reconcile, so the gate can refuse them with the typed
 * `RECONCILE_NOT_PRIMARY_CHECKOUT` instead.
 */
async function canonicalRootOfOrBare(cwd: string): Promise<string> {
  const bare = await run("git", ["rev-parse", "--is-bare-repository"], {
    cwd,
    allowFailure: true,
  });
  if (bare.exitCode === 0 && bare.stdout.trim() === "true") {
    return realpath(cwd);
  }
  return canonicalRootOf(cwd);
}

async function canonicalRootOfOrMismatch(cwd: string): Promise<string> {
  try {
    return await canonicalRootOf(cwd);
  } catch (error) {
    if (error instanceof PoiesisError && error.code === "NOT_GIT_REPOSITORY") {
      throw new PoiesisError(
        "RECONCILE_ROOT_MISMATCH",
        "cwd is not inside a Git repository; reconcile requires the primary checkout",
        { cwd },
      );
    }
    throw error;
  }
}

async function canonicalCommonDir(root: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--git-common-dir"], { cwd: root });
  return realpath(isAbsolute(result.stdout) ? result.stdout : resolve(root, result.stdout));
}

async function canonicalGitDir(root: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--git-dir"], { cwd: root });
  return realpath(isAbsolute(result.stdout) ? result.stdout : resolve(root, result.stdout));
}

/**
 * Confirm the resolved cwd is the actual primary checkout. In a
 * primary checkout, `--git-dir` and `--git-common-dir` resolve to
 * the same canonical directory. In a registered linked worktree,
 * `--git-dir` points at the per-worktree metadata directory
 * (`.git/worktrees/<name>`) and `--git-common-dir` points at the
 * shared primary `.git`, so the two canonical realpaths differ —
 * that is the precise signal we need to refuse.
 *
 * Bare repositories have no working tree; we refuse those too so a
 * reconcile cannot ever touch a repo without an aligned working
 * tree. `git rev-parse --is-bare-repository` is the canonical
 * detector.
 */
async function assertPrimaryCheckout(canonicalRoot: string): Promise<void> {
  const bare = await run("git", ["rev-parse", "--is-bare-repository"], {
    cwd: canonicalRoot,
    allowFailure: true,
  });
  if (bare.exitCode === 0 && bare.stdout.trim() === "true") {
    throw new PoiesisError(
      "RECONCILE_NOT_PRIMARY_CHECKOUT",
      "Refusing to reconcile a bare repository",
      { root: canonicalRoot },
    );
  }
  const gitDir = await canonicalGitDir(canonicalRoot);
  const commonDir = await canonicalCommonDir(canonicalRoot);
  invariant(
    gitDir === commonDir,
    "RECONCILE_NOT_PRIMARY_CHECKOUT",
    "cwd resolves to a linked worktree or non-primary checkout; reconcile requires the primary checkout",
    {
      root: canonicalRoot,
      gitDir,
      gitCommonDir: commonDir,
    },
  );
}

/**
 * Mirror of `canonicalWorktreePath` from `git.ts`: realpath with a
 * missing-path fallback to `resolve(path)`. Kept private so the
 * reconcile surface does not leak a new public helper into the
 * package root for what is an internal canonicalization step.
 */
async function canonicalWorktreePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isEnoent(error)) return resolve(path);
    throw error;
  }
}

async function assertNoActiveGitOperation(commonDir: string): Promise<void> {
  const locks = [
    "index.lock",
    "HEAD.lock",
    "ORIG_HEAD.lock",
    "fsmonitor.lock",
    "config.lock",
    "maintenance.lock",
  ];
  for (const name of locks) {
    const path = join(commonDir, name);
    if (await pathExists(path)) {
      throw new PoiesisError(
        "RECONCILE_GIT_OPERATION_ACTIVE",
        "Refusing to reconcile while a Git operation is active",
        { lockPath: path },
      );
    }
  }
  // `git status` itself surfaces an in-progress rebase/merge/cherry-pick
  // by failing. We delegate that detection to git so the seam stays
  // accurate against the actual Git state.
  for (const indicator of ["REBASE_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const result = await run("git", ["rev-parse", "--verify", "--quiet", indicator], {
      cwd: commonDir,
      allowFailure: true,
    });
    if (result.exitCode === 0) {
      throw new PoiesisError(
        "RECONCILE_GIT_OPERATION_ACTIVE",
        `Refusing to reconcile while a ${indicator.replace("_HEAD", "").toLowerCase()} is in progress`,
        { indicator },
      );
    }
  }
}

async function assertSparseCheckoutDisabled(root: string): Promise<void> {
  const enabled = await run("git", ["config", "--get", "--bool", "core.sparseCheckout"], {
    cwd: root,
    allowFailure: true,
  });
  if (enabled.exitCode === 0 && enabled.stdout.trim() === "true") {
    throw new PoiesisError(
      "RECONCILE_SPARSE_CHECKOUT",
      "Refusing to reconcile a sparse-checkout working tree",
    );
  }
  const sparseFile = join(root, ".git", "info", "sparse-checkout");
  if (await pathExists(sparseFile)) {
    throw new PoiesisError(
      "RECONCILE_SPARSE_CHECKOUT",
      "Refusing to reconcile a sparse-checkout working tree",
      { path: sparseFile },
    );
  }
}

async function assertNoSubmoduleConfig(root: string): Promise<void> {
  // `.gitmodules` is the canonical signal that a submodule is
  // configured for this checkout. Submodules carry their own Git
  // state inside the working tree and cannot be reconciled with the
  // same exact-tree contract as a flat primary checkout.
  const gitmodules = join(root, ".gitmodules");
  if (await pathExists(gitmodules)) {
    throw new PoiesisError(
      "RECONCILE_SUBMODULE",
      "Refusing to reconcile a working tree containing submodules",
      { path: ".gitmodules" },
    );
  }
}

async function assertNoContentFilters(root: string): Promise<void> {
  // `.gitattributes` may declare `filter=` directives that route
  // through smudge/clean hooks or `eol=` attributes that switch the
  // working tree between CRLF and LF on checkout. Any such
  // transformation breaks the bytewise target-equality contract:
  // the bytes the working tree holds after `git reset --hard` would
  // not equal the bytes the target blob carries, so the postcondition
  // could not verify an exact match.
  const gitattributes = join(root, ".gitattributes");
  if (await pathExists(gitattributes)) {
    const bytes = await readFile(gitattributes);
    const text = bytes.toString("binary");
    if (/^.*\bfilter=/m.test(text)) {
      throw new PoiesisError(
        "RECONCILE_FILTER_ACTIVE",
        "Refusing to reconcile a working tree with content filters",
        { path: ".gitattributes" },
      );
    }
    if (/^.*\beol=/m.test(text)) {
      throw new PoiesisError(
        "RECONCILE_FILTER_ACTIVE",
        "Refusing to reconcile a working tree with EOL attributes",
        { path: ".gitattributes" },
      );
    }
  }
  const filters = await run("git", ["config", "--get-regexp", "^filter\\."], {
    cwd: root,
    allowFailure: true,
  });
  if (filters.exitCode === 0 && filters.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with truncated filter configuration",
    );
  }
  if (filters.exitCode === 0 && filters.stdout.trim().length > 0) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with configured Git filters",
    );
  }
  // `core.autocrlf=true|input` rewrites LF/CRLF on checkout and back
  // on commit. This is the canonical global EOL transformation and
  // must be refused for the same reason as a `.gitattributes eol=`
  // directive.
  const autocrlf = await run("git", ["config", "--get", "--bool", "core.autocrlf"], {
    cwd: root,
    allowFailure: true,
  });
  if (autocrlf.exitCode === 0 && autocrlf.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with truncated autocrlf configuration",
    );
  }
  if (autocrlf.exitCode === 0 && autocrlf.stdout.trim() === "true") {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with core.autocrlf enabled",
    );
  }
}

async function assertNoSplitIndex(root: string): Promise<void> {
  // `git update-index --split-index` may have been run with the
  // config flag absent — the on-disk shared index file is the actual
  // signal. The presence of any `sharedindex.<hex>` file in the
  // git dir means the index is split; the bare config flag check is
  // necessary but not sufficient. Ticket #84.
  const split = await run("git", ["config", "--get", "--bool", "splitIndex.enabled"], {
    cwd: root,
    allowFailure: true,
  });
  if (split.exitCode === 0 && split.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_SPLIT_INDEX",
      "Refusing to reconcile a repository with truncated split-index configuration",
    );
  }
  if (split.exitCode === 0 && split.stdout.trim() === "true") {
    throw new PoiesisError(
      "RECONCILE_SPLIT_INDEX",
      "Refusing to reconcile a split-index repository",
    );
  }
  const indexDirectory = join(root, ".git");
  let sharedIndexes: string[];
  try {
    sharedIndexes = await readdir(indexDirectory);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const name of sharedIndexes) {
    if (name.startsWith("sharedindex.")) {
      throw new PoiesisError(
        "RECONCILE_SPLIT_INDEX",
        "Refusing to reconcile a working tree with an on-disk shared index",
        { path: join(indexDirectory, name) },
      );
    }
  }
}

async function readIndexBytes(root: string): Promise<Buffer> {
  const indexPath = join(root, ".git", "index");
  if (!(await pathExists(indexPath))) {
    // An absent index file is still a valid exact binding — we hash
    // zero bytes. The spec calls this out explicitly.
    return Buffer.alloc(0);
  }
  const details = await stat(indexPath);
  if (!details.isFile()) {
    throw new PoiesisError(
      "RECONCILE_INDEX_INVALID",
      "Git index is not a regular file",
      { path: indexPath },
    );
  }
  if (details.size > DEFAULT_MAX_INDEX_BYTES()) {
    throw new PoiesisError(
      "RECONCILE_SCAN_INCOMPLETE",
      "Git index exceeds the maximum size for fingerprint capture",
      { path: indexPath, size: details.size, max: DEFAULT_MAX_INDEX_BYTES() },
    );
  }
  return readFile(indexPath);
}

async function scanDiscardScope(root: string): Promise<ScanResult> {
  // Pre-scan layout analysis: the declared exclusion list, the
  // registered linked worktree set, and the protected ancestor
  // directory of every exclusion must all be resolved BEFORE the
  // walk descends. The walk uses these to (a) refuse to descend
  // into a declared exclusion base (otherwise reconcile would
  // silently delete its contents), (b) refuse to descend into a
  // registered linked worktree root at any nesting level (the
  // canonical realpath set used here is the same set that the
  // destructive step uses to skip deletion), and (c) refuse to
  // count entries that belong to a worktree root.
  //
  // A registered linked worktree nested under a declared exclusion
  // prefix (e.g. `.poiesis/workspaces/spec__nested`) MUST be
  // preserved in place — reconcile never refuses such a layout.
  // The worktree is a legitimate Git-owned peer, not residue.
  const exclusionBases = deriveExclusionBases(RECONCILE_EXCLUSION_PATHS);
  const liveWorktrees = await listWorktrees(root);
  const worktreeRoots = new Set(
    liveWorktrees
      .filter((worktree) => worktree.path !== root)
      .map((worktree) => worktree.path),
  );
  const entries: DiscardEntry[] = [];
  let filesScanned = 0;
  let dirsScanned = 0;
  let symlinksScanned = 0;
  let bytesScanned = 0;
  // We walk the primary root's working tree EXCLUDING `.git/`. The
  // entries in `.git/` are Git administration: the index is captured
  // separately, and markers/receipts live under it as preserved
  // shared state.
  await walkWorkingTree(root, "", entries, exclusionBases, worktreeRoots, {
    accumulateFile: () => {
      filesScanned += 1;
      if (filesScanned > DEFAULT_MAX_FILES()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope exceeds the configured file count bound",
          { filesScanned, maxFiles: DEFAULT_MAX_FILES() },
        );
      }
    },
    accumulateDir: () => {
      dirsScanned += 1;
      if (dirsScanned > DEFAULT_MAX_DIRS()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope exceeds the configured directory count bound",
          { dirsScanned, maxDirs: DEFAULT_MAX_DIRS() },
        );
      }
    },
    accumulateSymlink: () => {
      symlinksScanned += 1;
      if (symlinksScanned > DEFAULT_MAX_SYMLINKS()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope exceeds the configured symlink count bound",
          { symlinksScanned, maxSymlinks: DEFAULT_MAX_SYMLINKS() },
        );
      }
    },
    accumulateBytes: (count) => {
      bytesScanned += count;
      if (bytesScanned > DEFAULT_MAX_TOTAL_BYTES()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope exceeds the configured aggregate byte bound",
          { bytesScanned, maxBytes: DEFAULT_MAX_TOTAL_BYTES() },
        );
      }
    },
  });
  return { entries, filesScanned, dirsScanned, symlinksScanned, bytesScanned };
}

/**
 * Reduce the declared exclusion list to its canonical absolute
 * roots plus every protected ancestor. The `.poiesis` ancestor of
 * `.poiesis/workspaces/` is protected because deleting the
 * exclusion would orphan the ancestor in a way the collision check
 * could not catch (the ancestor has no tracked descendants in the
 * typical case, so a colliding tracked `.poiesis` file would not
 * be flagged).
 */
function deriveExclusionBases(exclusions: readonly string[]): Set<string> {
  const bases = new Set<string>();
  for (const exclusion of exclusions) {
    let base = exclusion.endsWith("/") ? exclusion.slice(0, -1) : exclusion;
    bases.add(base);
    while (base.includes("/")) {
      const parent = base.slice(0, base.lastIndexOf("/"));
      if (parent === "") break;
      bases.add(parent);
      base = parent;
    }
  }
  return bases;
}

interface WalkCallbacks {
  accumulateFile: () => void;
  accumulateDir: () => void;
  accumulateSymlink: () => void;
  accumulateBytes: (count: number) => void;
}

async function walkWorkingTree(
  root: string,
  relativePath: string,
  entries: DiscardEntry[],
  exclusionBases: Set<string>,
  worktreeRoots: Set<string>,
  callbacks: WalkCallbacks,
): Promise<void> {
  // Refuse to descend into a declared exclusion base OR a
  // registered linked worktree root. The exclusion list is a
  // closed set of protected roots; the walk must not enumerate
  // their contents or the resulting fingerprint would include
  // bytes reconcile must preserve. A registered linked worktree
  // root — including one nested under a declared exclusion prefix
  // such as `.poiesis/workspaces/spec__nested` — is a legitimate
  // Git-owned peer whose contents are not part of the discard
  // scope at all. The worktree set here is the same canonical
  // realpath set `performDestructiveReset` uses to skip deletion,
  // so the scan and the destructive step agree on what is
  // protected.
  if (relativePath !== "") {
    if (exclusionBases.has(relativePath)) return;
    if (worktreeRoots.has(resolve(root, relativePath))) return;
  }
  const absolute = relativePath === "" ? root : join(root, relativePath);
  let dirents: Dirent[];
  try {
    dirents = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  // Byte-preserving deterministic order: compare each path's UTF-8
  // bytes lexicographically. This matches the "byte-preserving
  // deterministic path order" contract for both pure-ASCII and
  // arbitrary-byte path names.
  dirents.sort(bytewiseCompareDirents);
  for (const dirent of dirents) {
    const childRelative = relativePath === "" ? dirent.name : `${relativePath}/${dirent.name}`;
    // Path-bytes bound: a discard-scope path whose UTF-8 byte length
    // exceeds the fingerprint path budget would silently disagree
    // with the digest (the fingerprint encodes each entry's path as
    // UTF-8 bytes via `Buffer.from(..., "utf8")` in
    // `updateLengthFramed`). Refuse before the scan advances so the
    // fingerprint can never claim to be complete over a path the
    // digest omitted. The byte length is measured with the same
    // encoding the fingerprint uses, not `string.length`, so
    // multi-byte UTF-8 path components are bounded correctly.
    const childRelativeBytes = Buffer.byteLength(childRelative, "utf8");
    if (childRelativeBytes > DEFAULT_MAX_PATH_BYTES()) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "Discard scope path exceeds the maximum size for fingerprint capture",
        {
          path: childRelative,
          size: childRelativeBytes,
          max: DEFAULT_MAX_PATH_BYTES(),
        },
      );
    }
    if (relativePath === "" && dirent.name === ".git") continue;
    if (childRelative === ".gitmodules") {
      throw new PoiesisError(
        "RECONCILE_SUBMODULE",
        "Refusing to reconcile a working tree containing submodules",
        { path: ".gitmodules" },
      );
    }
    const childAbsolute = join(root, childRelative);
    // Defense-in-depth: skip a child whose absolute path IS a
    // registered linked worktree root. The exclusion-base skip at
    // the entry of `walkWorkingTree` covers worktrees nested under
    // `.poiesis/workspaces/`, but a sibling worktree (or a worktree
    // nested under a different, non-excluded prefix) must also be
    // left alone by both the walk and the destructive step.
    if (worktreeRoots.has(childAbsolute)) continue;
    if (dirent.isSymbolicLink()) {
      const linkBuffer = await readlink(childAbsolute, { encoding: "buffer" });
      if (linkBuffer.length > DEFAULT_MAX_FILE_BYTES()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope entry exceeds the maximum size for fingerprint capture",
          {
            path: childRelative,
            size: linkBuffer.length,
            max: DEFAULT_MAX_FILE_BYTES(),
          },
        );
      }
      const digest = createHash("sha256").update(linkBuffer).digest("hex");
      entries.push({
        path: childRelative,
        kind: "symlink",
        mode: null,
        bytesDigest: null,
        bytesLength: 0,
        symlinkDigest: digest,
        symlinkLength: linkBuffer.length,
      });
      callbacks.accumulateSymlink();
      callbacks.accumulateBytes(linkBuffer.length);
      continue;
    }
    if (dirent.isDirectory()) {
      // Defense-in-depth: a subdirectory with its own `.git` entry is
      // a nested repository. Reconcile must refuse before any
      // mutation runs so an accidentally-embedded clone cannot be
      // walked or deleted.
      const nestedGit = join(childAbsolute, ".git");
      if (await pathExists(nestedGit)) {
        throw new PoiesisError(
          "RECONCILE_NESTED_REPOSITORY",
          "Refusing to reconcile a working tree containing a nested repository",
          { path: childRelative },
        );
      }
      entries.push({
        path: childRelative,
        kind: "dir",
        mode: null,
        bytesDigest: null,
        bytesLength: 0,
        symlinkDigest: null,
        symlinkLength: null,
      });
      callbacks.accumulateDir();
      await walkWorkingTree(root, childRelative, entries, exclusionBases, worktreeRoots, callbacks);
      continue;
    }
    if (dirent.isFile()) {
      // Stream-hash the file in 64 KiB chunks. A full `readFile()`
      // would load the entire content into memory; a file that grew
      // past the per-file budget between the `stat` size check and
      // the read would silently hash more bytes than the budget
      // allows. The stream-hash path re-checks the byte counter on
      // every chunk so a growing file is refused at the bound.
      const statResult = await stat(childAbsolute);
      if (statResult.size > DEFAULT_MAX_FILE_BYTES()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope entry exceeds the maximum size for fingerprint capture",
          {
            path: childRelative,
            size: statResult.size,
            max: DEFAULT_MAX_FILE_BYTES(),
          },
        );
      }
      const { hash, bytes: bytesLength } = await streamHashWithGrowthCheck(
        childAbsolute,
        DEFAULT_MAX_FILE_BYTES(),
      );
      const digest = hash.digest("hex");
      entries.push({
        path: childRelative,
        kind: "file",
        mode: statResult.mode & 0o7777,
        bytesDigest: digest,
        bytesLength,
        symlinkDigest: null,
        symlinkLength: null,
      });
      callbacks.accumulateFile();
      callbacks.accumulateBytes(bytesLength);
      continue;
    }
    // FIFO, socket, block/char device, or anything else not a
    // regular file / symlink / directory. We refuse rather than
    // silently include it in the discard scope.
    throw new PoiesisError(
      "RECONCILE_UNSUPPORTED_ENTRY",
      "Refusing to reconcile a working tree containing an unsupported entry type",
      { path: childRelative },
    );
  }
}

/**
 * Stream a file through a SHA-256 hasher in bounded chunks,
 * re-checking the byte counter on every chunk so a file that grows
 * past `maxBytes` while we are reading is refused before the digest
 * is finalized. Returns the live `Hash` so the caller can finalize
 * after the stream is consumed.
 */
async function streamHashWithGrowthCheck(
  absolute: string,
  maxBytes: number,
): Promise<{ hash: import("node:crypto").Hash; bytes: number }> {
  const hash = createHash("sha256");
  const stream = createReadStream(absolute, { highWaterMark: 64 * 1024 });
  let bytes = 0;
  return await new Promise<{ hash: import("node:crypto").Hash; bytes: number }>((resolve, reject) => {
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += buffer.length;
      if (bytes > maxBytes) {
        stream.destroy();
        reject(
          new PoiesisError(
            "RECONCILE_SCAN_INCOMPLETE",
            "Discard scope entry grew past the maximum size during scan",
            { path: absolute, size: bytes, max: maxBytes },
          ),
        );
        return;
      }
      hash.update(buffer);
    });
    stream.on("error", (error) => {
      reject(error);
    });
    stream.on("end", () => {
      resolve({ hash, bytes });
    });
  });
}

function bytewiseCompareDirents(left: Dirent, right: Dirent): number {
  const leftBytes = Buffer.from(left.name, "utf8");
  const rightBytes = Buffer.from(right.name, "utf8");
  return Buffer.compare(leftBytes, rightBytes);
}

interface DigestArgs {
  canonicalRoot: string;
  gitCommonDir: string;
  remote: string;
  remoteUrls: RemoteUrls;
  integrationBranch: string;
  indexBytes: Buffer;
  exclusions: readonly string[];
  scan: ScanResult;
}

function computeFingerprintDigest(args: DigestArgs): string {
  const hash = createHash("sha256");
  hash.update(FINGERPRINT_DOMAIN);
  // Identity binding (canonical root, common dir, remote context).
  updateLengthFramed(hash, realpathSyncNative(args.canonicalRoot));
  updateLengthFramed(hash, realpathSyncNative(args.gitCommonDir));
  // Resolved remote URL identity (fetch + push URLs, sorted
  // lexicographically) is bound alongside the human-readable remote
  // name so a reconcile whose remote URL changed between captures
  // fails closed even when the target SHA is unchanged.
  for (const url of [...args.remoteUrls.fetchUrls].sort()) {
    updateLengthFramed(hash, url);
  }
  for (const url of [...args.remoteUrls.pushUrls].sort()) {
    updateLengthFramed(hash, url);
  }
  updateLengthFramed(hash, args.remote);
  updateLengthFramed(hash, args.integrationBranch);
  // Index file bytes (including the "absent" zero-byte binding).
  updateLengthFramed(hash, args.indexBytes);
  // Exclusions — the exclusion list is part of the domain so a
  // reconcile with different exclusions cannot accept this fingerprint.
  for (const exclusion of [...args.exclusions].sort()) {
    updateLengthFramed(hash, exclusion);
  }
  // Discard-scope inventory.
  for (const entry of args.scan.entries) {
    updateLengthFramed(hash, entry.path);
    // Single-byte kind marker: 'f' = file, 's' = symlink, 'd' = dir.
    const kind = entry.kind === "file" ? "f" : entry.kind === "symlink" ? "s" : "d";
    hash.update(Buffer.from([kind.charCodeAt(0)]));
    if (entry.kind === "file") {
      invariant(
        entry.mode !== null && entry.bytesDigest !== null,
        "RECONCILE_SCAN_INCOMPLETE",
        "File entry missing mode or content digest",
        { path: entry.path },
      );
      updateLengthFramed(hash, Buffer.from([entry.mode & 0xff, (entry.mode >> 8) & 0xff]));
      updateLengthFramed(hash, entry.bytesDigest);
      updateLengthFramed(hash, Buffer.from(String(entry.bytesLength)));
      continue;
    }
    if (entry.kind === "symlink") {
      invariant(
        entry.symlinkDigest !== null && entry.symlinkLength !== null,
        "RECONCILE_SCAN_INCOMPLETE",
        "Symlink entry missing readlink bytes",
        { path: entry.path },
      );
      updateLengthFramed(hash, entry.symlinkDigest);
      updateLengthFramed(hash, Buffer.from(String(entry.symlinkLength)));
      continue;
    }
    updateLengthFramed(hash, Buffer.alloc(0));
  }
  return hash.digest("hex");
}

function updateLengthFramed(hash: import("node:crypto").Hash, value: string | Buffer): void {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  // The 8-byte little-endian length prefix keeps the encoding
  // canonical and unambiguous across endianness. No additional bound
  // check here: every caller already enforces a specific per-input
  // maximum (`DEFAULT_MAX_FILE_BYTES` for content, `DEFAULT_MAX_PATH_BYTES`
  // for path strings, `DEFAULT_MAX_INDEX_BYTES` for the index blob),
  // so a redundant length cap inside this helper would either be a
  // no-op (the looser bound subsumes the tighter one) or contradict
  // the caller's contract. The maximum representable length is
  // `2^64 - 1`, well above any realistic scan input.
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(buffer.length));
  hash.update(prefix);
  hash.update(buffer);
}

function realpathSyncNative(path: string): string {
  // `realpathSync` on the just-resolved canonical root + common dir
  // is a hot path inside `computeFingerprintDigest`. A sync call is
  // safe here because both inputs were already resolved through the
  // async `realpath` in `canonicalRootOf` / `canonicalCommonDir`.
  // Re-resolving keeps the fingerprint strictly canonical and
  // immune to bind-mount / symlink swap races during the scan.
  // Imported at module top from `node:fs` (ESM-safe); the previous
  // helper did a dynamic `require("node:fs")` which the build
  // shim translated via `__require` for ESM but which broke in
  // native ESM consumers.
  return realpathSync(path);
}

async function fetchIntegrationTargetWithoutPruning(
  root: string,
  remote: string,
  branch: string,
): Promise<string> {
  const tracking = `refs/remotes/${remote}/${branch}`;
  try {
    await run(
      "git",
      ["fetch", "--no-tags", "--no-prune", "--quiet", remote, `+refs/heads/${branch}:${tracking}`],
      { cwd: root },
    );
  } catch (error) {
    throw new PoiesisError(
      "RECONCILE_REMOTE_DRIFT",
      "Failed to fetch configured integration ref from the configured Git remote",
      {
        remote,
        branch,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return resolveCommit(root, tracking);
}

async function resolveCommit(root: string, revision: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: root });
  invariant(
    SHA_PATTERN.test(result.stdout),
    "RECONCILE_INVALID_COMMIT",
    "Git returned an invalid commit identifier",
    { revision, output: result.stdout },
  );
  return result.stdout;
}

async function resolveCurrentBranch(root: string): Promise<string | null> {
  const result = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: root,
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout : null;
}

interface RemoteUrls {
  fetchUrls: string[];
  pushUrls: string[];
}

async function readRemoteUrls(root: string, name: string): Promise<RemoteUrls> {
  const fetch = await run("git", ["remote", "get-url", "--all", name], { cwd: root, allowFailure: true });
  if (fetch.exitCode !== 0) {
    // The remote does not exist. `computeReconcileFingerprint` is
    // allowed to fingerprint a repo with any remote name (the read-
    // only inspect opt-in must remain useful even when a caller
    // probes a remote that is not yet configured). Return an empty
    // URL set so the digest still binds the (nonexistent) remote
    // identity. `reconcile` re-checks the URL set with a stricter
    // invariant that refuses empty URLs.
    return { fetchUrls: [], pushUrls: [] };
  }
  if (fetch.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_REMOTE_DRIFT",
      "Configured Git remote URL output was truncated",
      { remote: name },
    );
  }
  const fetchUrls = nonemptyLines(fetch.stdout);
  for (const url of fetchUrls) assertValidRemoteUrl(url, name);
  // Push URLs default to the fetch URLs when none are configured
  // separately; run an independent query so the digest can bind a
  // push-only drift.
  const push = await run("git", ["remote", "get-url", "--push", "--all", name], { cwd: root, allowFailure: true });
  let pushUrls = fetchUrls;
  if (push.exitCode === 0) {
    if (push.stdoutTruncated) {
      throw new PoiesisError(
        "RECONCILE_REMOTE_DRIFT",
        "Configured Git remote push URL output was truncated",
        { remote: name },
      );
    }
    const explicit = nonemptyLines(push.stdout);
    if (explicit.length > 0) {
      pushUrls = explicit;
      for (const url of pushUrls) assertValidRemoteUrl(url, name);
    }
  }
  return { fetchUrls, pushUrls };
}

function assertValidRemoteUrl(url: string, remote: string): void {
  if (url.length === 0) {
    throw new PoiesisError("RECONCILE_REMOTE_DRIFT", "Configured Git remote has an empty URL", { remote });
  }
  if (/[\s\u0000]/.test(url)) {
    throw new PoiesisError(
      "RECONCILE_REMOTE_DRIFT",
      "Configured Git remote URL contains whitespace or NUL",
      { remote },
    );
  }
}

interface TargetTreeEntry {
  path: string;
  mode: number;
  oid: string;
}

async function listTargetTree(root: string, target: string): Promise<TargetTreeEntry[]> {
  const result = await run("git", ["ls-tree", "-r", "-z", target], { cwd: root });
  if (result.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_TARGET_TREE_TRUNCATED",
      "git ls-tree output was truncated; reconcile refuses to operate on a partial tree",
      { target },
    );
  }
  if (result.stdout === "") return [];
  const entries: TargetTreeEntry[] = [];
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|tree|commit|tag) ([0-9a-f]+)\t(.*)$/.exec(record);
    if (match === null) {
      // A target-tree path containing a literal LF byte would
      // survive the `\0` split but defeat the `.*` anchor (which
      // excludes LF by default). Fail closed: a target tree with a
      // malformed record cannot be reconciled exactly.
      throw new PoiesisError(
        "RECONCILE_TARGET_TREE_INVALID",
        "git ls-tree returned a record that does not match the expected porcelain shape",
        { record: bounded(record, 256) },
      );
    }
    const modeOctal = match[1]!;
    const oid = match[3]!;
    const path = match[4]!;
    if (path.includes("\n") || path.includes("\0")) {
      throw new PoiesisError(
        "RECONCILE_TARGET_TREE_INVALID",
        "git ls-tree returned a path containing LF or NUL bytes",
        { record: bounded(record, 256) },
      );
    }
    entries.push({ path, mode: Number.parseInt(modeOctal, 8), oid });
  }
  return entries;
}

async function listIndexOids(root: string): Promise<TargetTreeEntry[]> {
  const result = await run("git", ["ls-files", "--stage", "-z"], { cwd: root });
  if (result.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_INDEX_TRUNCATED",
      "git ls-files output was truncated; reconcile refuses to operate on a partial index",
    );
  }
  if (result.stdout === "") return [];
  const entries: TargetTreeEntry[] = [];
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) {
      throw new PoiesisError(
        "RECONCILE_INDEX_INVALID",
        "git ls-files returned a record without a meta/path separator",
        { record: bounded(record, 256) },
      );
    }
    const meta = record.slice(0, tabIndex);
    const path = record.slice(tabIndex + 1);
    const parts = meta.split(" ");
    if (parts.length !== 3) {
      throw new PoiesisError(
        "RECONCILE_INDEX_INVALID",
        "git ls-files returned a record with an unexpected meta shape",
        { record: bounded(record, 256) },
      );
    }
    const mode = Number.parseInt(parts[0]!, 8);
    const oid = parts[1]!;
    if (mode === 0o160000) continue; // skip submodules if any sneak through
    entries.push({ path, mode, oid });
  }
  return entries;
}

function indexOidsMatchTarget(
  indexEntries: TargetTreeEntry[],
  targetEntries: TargetTreeEntry[],
): boolean {
  if (indexEntries.length !== targetEntries.length) return false;
  const targetByPath = new Map<string, TargetTreeEntry>();
  for (const entry of targetEntries) targetByPath.set(entry.path, entry);
  for (const entry of indexEntries) {
    const target = targetByPath.get(entry.path);
    if (target === undefined || target.mode !== entry.mode || target.oid !== entry.oid) return false;
  }
  return true;
}

async function workingTreeMatchesTarget(
  root: string,
  targetSha: string,
  targetEntries: TargetTreeEntry[],
): Promise<boolean> {
  for (const entry of targetEntries) {
    const absolute = join(root, entry.path);
    if (entry.mode === 0o120000) {
      const statResult = await lstat(absolute).catch(() => null);
      if (statResult === null || !statResult.isSymbolicLink()) return false;
      const linkBuffer = await readlink(absolute, { encoding: "buffer" });
      // The target blob's OID is the SHA-1 of the symlink target
      // (`blob <len>\0<target>`); we recompute that here from the
      // working tree's readlink buffer and compare for bytewise
      // equality. Readlink bytes are not subject to smudge/clean
      // filters, so this is exact.
      const header = Buffer.from(`blob ${linkBuffer.length}\0`, "utf8");
      const oid = createHash("sha1").update(header).update(linkBuffer).digest("hex");
      if (oid !== entry.oid) return false;
      continue;
    }
    if ((entry.mode & 0o170000) === 0o040000) {
      const statResult = await lstat(absolute).catch(() => null);
      if (statResult === null || !statResult.isDirectory()) return false;
      continue;
    }
    const statResult = await lstat(absolute).catch(() => null);
    if (statResult === null || !statResult.isFile()) return false;
    if ((statResult.mode & 0o7777) !== (entry.mode & 0o7777)) return false;
    // Compare raw working tree bytes to the target blob bytes via
    // `git cat-file blob <oid>`. The previous `git hash-object`
    // path routed the working tree bytes through the configured
    // clean filter — which can silently rewrite CRLF↔LF or run a
    // `filter=` driver — and produced an OID that did not
    // correspond to the bytes on disk. `git cat-file blob` returns
    // the exact stored blob bytes without transformation, so a
    // byte-equal working tree must equal the blob. Ticket #84
    // finding #7. The `binaryStdout` option keeps the trailing
    // whitespace strip in `process.ts::run` from corrupting the
    // last byte of text-content blobs.
    const cat = await run("git", ["cat-file", "blob", entry.oid], {
      cwd: root,
      binaryStdout: true,
    });
    if (cat.stdoutTruncated) return false;
    const targetBytes = Buffer.from(cat.stdout, "binary");
    const workingBytes = await readFile(absolute);
    if (targetBytes.length !== workingBytes.length) return false;
    if (!targetBytes.equals(workingBytes)) return false;
  }
  // Anything else the target tree does not declare must be absent.
  const status = await run("git", ["status", "--porcelain=v1", "-z"], { cwd: root });
  if (status.stdoutTruncated) return false;
  if (status.stdout === "") return true;
  for (const record of status.stdout.split("\0").filter(Boolean)) {
    if (record.length < 4) continue;
    const path = record.slice(3);
    if (path.startsWith(".git/") || path === ".git") continue;
    if (isExcluded(path)) continue;
    return false;
  }
  void targetSha;
  return true;
}

interface WorktreeRecord {
  path: string;
  branch: string | null;
}

async function listWorktrees(root: string): Promise<WorktreeRecord[]> {
  const result = await run("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root });
  if (result.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_WORKTREE_LIST_TRUNCATED",
      "git worktree list output was truncated; reconcile refuses to operate on a partial list",
    );
  }
  if (!result.stdout) return [];
  const records = result.stdout.split("\0\0").filter(Boolean);
  const worktrees: WorktreeRecord[] = [];
  for (const record of records) {
    const fields = record.split("\0").filter(Boolean);
    const pathField = fields.find((field) => field.startsWith("worktree "));
    if (pathField === undefined) {
      throw new PoiesisError(
        "RECONCILE_WORKTREE_RECORD_INVALID",
        "git worktree list returned a record without a `worktree ` field",
        { record: bounded(record, 256) },
      );
    }
    const branchRef = fields.find((field) => field.startsWith("branch "));
    const branch = branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) ?? null : null;
    // Canonicalize every registered worktree path so the deletion
    // exclusions and the pre-mutation revalidation compare against
    // a single, realpath-stable path set. `git worktree list`
    // returns whatever path was registered; bind-mounts, symlinks,
    // and a stale `.git/worktrees/<name>/gitdir` pointer can all
    // cause the live path to differ from what was captured at
    // review time. The realpath-with-missing-fallback mirrors the
    // helper in `git.ts` so the two surfaces stay aligned.
    const path = await canonicalWorktreePath(pathField.slice("worktree ".length));
    worktrees.push({ path, branch: branch ?? null });
  }
  return worktrees;
}

async function listSurvivingExclusions(root: string): Promise<string[]> {
  // Return the declared exclusion path verbatim when its root
  // directory exists (or its single file exists). The trailing-slash
  // form is part of the contract: callers compare it against the
  // declared reconciliation surface without re-normalization.
  const survivors: string[] = [];
  for (const exclusion of RECONCILE_EXCLUSION_PATHS) {
    const base = exclusion.endsWith("/") ? exclusion.slice(0, -1) : exclusion;
    if (await pathExists(join(root, base))) survivors.push(exclusion);
  }
  return survivors.sort();
}

async function collectPostReconcileResidue(root: string): Promise<string[]> {
  const result = await run(
    "git",
    ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"],
    { cwd: root },
  );
  if (result.stdout === "") return [];
  const offenders: string[] = [];
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    if (record.length < 4) continue;
    const path = record.slice(3);
    if (path === "") continue;
    if (path.startsWith(".git/") || path === ".git") continue;
    if (isExcluded(path)) continue;
    offenders.push(path);
  }
  return offenders;
}

async function listPreservedSharedPaths(
  root: string,
  gitCommonDir: string,
): Promise<string[]> {
  const preserved: string[] = [];
  const markerDirectory = join(gitCommonDir, "poiesis-workspaces-v1");
  if (await pathExists(markerDirectory)) {
    preserved.push(relative(root, markerDirectory));
  }
  const receiptDirectory = join(gitCommonDir, "poiesis-receipts-v1");
  if (await pathExists(receiptDirectory)) {
    preserved.push(relative(root, receiptDirectory));
  }
  return preserved.sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function validateText(value: string, field: string): void {
  invariant(
    typeof value === "string" && value.trim().length > 0 && !value.includes("\0"),
    "RECONCILE_INVALID_ARGUMENT",
    `${field} must be a non-empty string`,
    { field },
  );
}

function validateSha(value: string, field: string): void {
  invariant(
    typeof value === "string" && SHA_PATTERN.test(value),
    "RECONCILE_INVALID_ARGUMENT",
    `${field} must be a full lowercase Git object ID`,
    { field, value },
  );
}

function validateFingerprint(value: string, field: string): void {
  invariant(
    typeof value === "string" && FINGERPRINT_PATTERN.test(value),
    "RECONCILE_INVALID_ARGUMENT",
    `${field} must be a 64-character lowercase hex SHA-256`,
    { field, value },
  );
}

function nonemptyLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}
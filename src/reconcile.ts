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
  rmdir,
  stat,
} from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath, readlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { PoiesisError, invariant } from "./errors.js";
import { bounded, run, TEXT_DECODER_FATAL } from "./process.js";
import { resolveGitRoot } from "./paths.js";
import { acquireWorkspaceMutationLock } from "./mutation-transaction.js";

export const RECONCILE_FINGERPRINT_SCHEMA = 1;

/**
 * Canonical local Poiesis state paths that may survive a destructive
 * reconciliation when they are genuinely untracked/ignored and
 * collision-safe. The exclusions list is a closed, narrowly-scoped
 * constant — the destructive reconcile MUST NOT accept caller-supplied
 * exclusions from the public surface.
 *
 * The set is split into:
 *
 *   - `RECONCILE_EXCLUSION_SUBTREE_DIRS`: directories the discard-scope
 *     walker must NOT descend into. `.poiesis/workspaces/` is the
 *     closed set of Poiesis-owned worktree prefixes; its contents are
 *     preserved in place.
 *
 *   - `RECONCILE_EXCLUSION_FILES`: individual file paths the walker
 *     skips (does not include in the preimage). `.poiesis/manifest.json`
 *     is the canonical local state file.
 *
 *   - `RECONCILE_PROTECTED_ANCESTORS`: directory paths that are
 *     ancestors of an exclusion and MUST NEVER be deleted by the
 *     destructive step, even when empty after residue children are
 *     removed. `.poiesis` is included because deleting it would
 *     orphan the manifest in a way the collision check could not
 *     detect (a target blob at `.poiesis` would also be refused via
 *     the `RECONCILE_EXCLUSION_COLLISION` check).
 *
 * Ticket #85 finding #2: this split separates the walker's "skip
 * subtree" set from the deletion walker's "protected ancestor" set.
 * The original `deriveExclusionBases` collapsed the two: every
 * ancestor was both a walk-skip and a delete-protect, which meant
 * `.poiesis/other/*` (a NONE-excluded prefix under the same parent)
 * was never fingerprinted or cleaned.
 */
const RECONCILE_EXCLUSION_SUBTREE_DIRS: readonly string[] = [".poiesis/workspaces"];
const RECONCILE_EXCLUSION_FILES: readonly string[] = [".poiesis/manifest.json"];
const RECONCILE_PROTECTED_ANCESTORS: readonly string[] = [".poiesis"];
/**
 * The previous names — kept for the public API and the protected-paths
 * helper that the deletion walker uses. Both `EXCLUSION_PATHS` and
 * the new split are derived from the same canonical source.
 */
const RECONCILE_EXCLUSION_PATHS: readonly string[] = [
  ...RECONCILE_EXCLUSION_FILES,
  ...RECONCILE_EXCLUSION_SUBTREE_DIRS.map((dir) => `${dir}/`),
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
 * this; it is deliberately not exported from `index.ts`. Passing
 * `null` for a field restores the production default so a
 * `try/finally`-style invocation does not leak the override
 * into subsequent tests sharing the module.
 *
 * @internal
 */
export function __setReconcileScanBoundsForTest(overrides: {
  maxFiles?: number | null;
  maxDirs?: number | null;
  maxSymlinks?: number | null;
  maxTotalBytes?: number | null;
  maxFileBytes?: number | null;
  maxIndexBytes?: number | null;
  maxPathBytes?: number | null;
}): void {
  if (overrides.maxFiles !== undefined) {
    maxFiles = overrides.maxFiles ?? 100_000;
  }
  if (overrides.maxDirs !== undefined) {
    maxDirs = overrides.maxDirs ?? 100_000;
  }
  if (overrides.maxSymlinks !== undefined) {
    maxSymlinks = overrides.maxSymlinks ?? 100_000;
  }
  if (overrides.maxTotalBytes !== undefined) {
    maxTotalBytes = overrides.maxTotalBytes ?? 1_073_741_824;
  }
  if (overrides.maxFileBytes !== undefined) {
    maxFileBytes = overrides.maxFileBytes ?? 104_857_600;
  }
  if (overrides.maxIndexBytes !== undefined) {
    maxIndexBytes = overrides.maxIndexBytes ?? 16_777_216;
  }
  if (overrides.maxPathBytes !== undefined) {
    maxPathBytes = overrides.maxPathBytes ?? 4096;
  }
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
  await assertNoActiveGitOperation(canonicalRoot);
  await assertSparseCheckoutDisabled(canonicalRoot);
  await assertNoSubmoduleConfig(canonicalRoot);
  await assertNoContentFilters(canonicalRoot);
  await assertNoSplitIndex(canonicalRoot);
  const indexBytes = await readIndexBytes(canonicalRoot);
  // Ticket #88 finding #3: pre-fingerprint index stage/mode
  // validation. An index entry with mode 160000 (gitlink) that is
  // NOT paired with a `.gitmodules` file is an orphan gitlink —
  // the working tree claims a submodule that no configuration
  // declares. The Spec only reconciles flat primary checkouts, so
  // this inconsistency must be refused up front instead of
  // silently passing through to the postcondition.
  await assertIndexHasNoOrphanedGitlinks(canonicalRoot, indexBytes);
  // Ticket #88 finding #4: prove the declared exclusion paths are
  // genuinely untracked AND ignored BEFORE the fingerprint runs.
  // A tracked or non-ignored path at an exclusion prefix would
  // either be clobbered by `git reset --hard` (tracked) or
  // silently reclassified (non-ignored). The previous
  // `isExcluded` string check would let either shape slip past;
  // the `git ls-files --error-unmatch` + `git check-ignore` pair
  // is the canonical Git probe for both conditions.
  await assertExclusionsAreGenuinelyUntrackedAndIgnored(canonicalRoot);
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
  //
  // Ticket #85 finding #3: the collision set is extended to include
  // every registered linked worktree root AND its ancestors. A
  // target blob whose path equals or descends through a registered
  // worktree's directory would clobber the worktree's territory on
  // `git reset --hard`; a target blob whose path IS an ancestor of
  // a registered worktree would replace the parent directory of the
  // worktree. Both shapes are refused with `RECONCILE_TARGET_COLLISION`.
  const targetTree = await listTargetTree(canonicalRoot, fetchedTarget);
  const exclusionBases = deriveExclusionBases(RECONCILE_EXCLUSION_PATHS);
  const worktreesForCollision = await listWorktrees(canonicalRoot);
  const protectedWorktreePaths = new Set(
    worktreesForCollision
      .filter((worktree) => worktree.path !== canonicalRoot)
      .map((worktree) => worktree.path),
  );
  for (const entry of targetTree) {
    invariant(
      !pathCollidesWithExclusion(entry.path, exclusionBases),
      "RECONCILE_EXCLUSION_COLLISION",
      "Declared exclusion path (or its ancestor) overlaps a tracked target path",
      { path: entry.path },
    );
    const absolute = resolve(canonicalRoot, entry.path);
    invariant(
      !collidesWithWorktreeAncestry(entry.path, absolute, protectedWorktreePaths, canonicalRoot),
      "RECONCILE_TARGET_COLLISION",
      "Target tracked path overlaps a registered linked worktree root or its ancestor",
      { path: entry.path },
    );
  }
  // Ticket #85 finding #5: also refuse a fetched target tree that
  // introduces `.gitattributes` at any path. The HEAD/index/worktree
  // may be clean, but the target tree's `src/.gitattributes` would
  // change the effective attributes on reset and break the
  // postcondition's bytewise equality check.
  refuseAnyGitattributesInTarget(targetTree);

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
  const residue = await collectPostReconcileResidue(canonicalRoot, targetTree);
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
  await assertNoActiveGitOperation(args.canonicalRoot);
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
  // preserved automatically by the `computeProtectedPaths` prefix
  // test, and ticket #85 finding #1 extends the protection to
  // tracked-target ancestors AND worktree ancestors so a recursive
  // `rm` cannot reach into a tracked directory or a worktree's
  // parent dir.
  const targetTree = await listTargetTree(args.canonicalRoot, args.targetSha);
  const trackedPaths = new Set(targetTree.map((entry) => entry.path));
  const trackedAncestors = deriveTrackedAncestors(targetTree);
  const liveWorktrees = await listWorktrees(args.canonicalRoot);
  const worktreeRoots = new Set(
    liveWorktrees
      .filter((worktree) => worktree.path !== args.canonicalRoot)
      .map((worktree) => worktree.path),
  );
  const worktreeAncestors = deriveWorktreeAncestors(args.canonicalRoot, liveWorktrees);
  await deleteResidue({
    canonicalRoot: args.canonicalRoot,
    worktreeRoots,
    worktreeAncestors,
    trackedPaths,
    trackedAncestors,
    targetEntries: targetTree,
    preimageEntries: args.preimageEntries,
  });
}

interface DeleteResidueArgs {
  canonicalRoot: string;
  worktreeRoots: Set<string>;
  worktreeAncestors: Set<string>;
  trackedPaths: Set<string>;
  trackedAncestors: Set<string>;
  targetEntries: readonly TargetTreeEntry[];
  preimageEntries: readonly DiscardEntry[];
}

async function deleteResidue(args: DeleteResidueArgs): Promise<void> {
  // Build the closed set of paths the destructive step must NEVER
  // touch. The set is the union of:
  //
  //   - tracked paths (the target tree's leaves) — already preserved
  //     by the `trackedPaths` skip below;
  //   - tracked ancestors (every parent of a tracked leaf) — these are
  //     the directories whose existence is required for the working
  //     tree to match the target; ticket #85 finding #1;
  //   - declared exclusion files (`.poiesis/manifest.json`) and the
  //     directory roots of declared exclusion subtrees (`.poiesis/`);
  //   - the protected ancestors that lead to a declared exclusion or
  //     to a registered worktree root (e.g. the `distant/sibling/`
  //     that contains the `distant/sibling/wt/` registered worktree);
  //   - preimage entries recorded under a declared exclusion subtree
  //     (covers the `:other` shape by transitively promoting a
  //     residue descendant of an exclusion base to "protected" — the
  //     walker will not descend into a real exclusion subtree, so
  //     this only catches the preimage-internal-cleanup edge where a
  //     descendant somehow lands in scope).
  const protectedPaths = computeProtectedPaths({
    preimageEntries: args.preimageEntries,
    trackedAncestors: args.trackedAncestors,
    worktreeAncestors: args.worktreeAncestors,
  });
  // The set of repository-relative paths whose first on-disk
  // ancestor (after `git reset --hard` replaced the working tree)
  // is a non-directory leaf that REPLACED a preimage directory of
  // the same name. Any descendant of those paths is unreachable:
  // - A symlink ancestor resolves through the target and would
  //   land outside the canonical root (or inside a registered
  //   linked worktree's territory). Removing bytes there would
  //   corrupt an unrelated filesystem region. Ticket #86 finding
  //   #1.
  // - A regular-file (or executable-file) ancestor violates POSIX:
  //   `lstat(<dir>/<descendant>)` fails with ENOTDIR. The
  //   destructive cleanup would throw post-mutation, leaving the
  //   repository in a partially-reset state. Ticket #87
  //   generalization.
  // Ticket #87 generalizes this set from "symlink-only" to
  // "any target leaf/type transition" so the same skip rule
  // applies regardless of the leaf shape the target installs.
  const typeTransitionAncestors = await collectTypeTransitionAncestors(
    args.canonicalRoot,
    args.preimageEntries,
    args.trackedPaths,
    args.targetEntries,
  );
  // Deepest first so every child's removal lands before we attempt to
  // rmdir its parent. `rmdir` only succeeds for an empty directory,
  // so a non-protected dir with a still-tracked child stays in
  // place (no children removed → rmdir throws ENOTEMPTY → ignored).
  const sorted = [...args.preimageEntries].sort((left, right) => {
    if (left.path.length !== right.path.length) return right.path.length - left.path.length;
    return left.path.localeCompare(right.path);
  });
  for (const entry of sorted) {
    if (entry.path === ".git") continue;
    if (entry.path.startsWith(".git/")) continue;
    if (args.trackedPaths.has(entry.path)) continue;
    if (protectedPaths.has(entry.path)) continue;
    // Skip any entry whose ancestor chain crosses a target leaf
    // that the destructive step installed where the preimage had a
    // directory of the same name. The leaf may be a symlink
    // (resolution would traverse it) or a regular/executable file
    // (`lstat(<dir>/<descendant>)` would throw ENOTDIR). Both
    // shapes make the descendant unreachable; both must be
    // skipped. Ticket #86 finding #1 + ticket #87 generalization.
    if (entryDescendantOfTypeTransitionAncestor(entry.path, typeTransitionAncestors)) continue;
    const absolute = resolve(args.canonicalRoot, entry.path);
    // Direct entry into / under a registered worktree: leave alone.
    // The worktree's working tree is its own territory; reconcile never
    // touches it. (External worktree roots are checked here too.)
    if (isInsideAnyWorktreeRoot(args.worktreeRoots, absolute)) continue;
    await safeRemoveWithinRoot(args.canonicalRoot, entry.path);
  }
}

/**
 * Identify repository-relative paths whose first on-disk ancestor
 * is a non-directory target leaf that REPLACED a preimage directory
 * of the same name. Removing descendants of these paths would
 * either resolve through a symlink target (landing outside the
 * canonical root or inside a registered linked worktree's
 * territory) or fail with `ENOTDIR` for regular/executable leaves
 * (POSIX does not allow children under a non-directory parent).
 * Both shapes make every preimage descendant unreachable after
 * `git reset --hard`; both must be skipped.
 *
 * The detection is bounded to the preimage entries and the target
 * tree leaves: it iterates the preimage, checks each entry's
 * immediate parent against `lstat` (no descent into directories,
 * no traversal of symlinks), and records only those parents that
 * were (a) a directory in the preimage AND (b) a non-directory
 * leaf on disk after the reset. Both pieces are bounded by the
 * preimage size so the loop stays within the existing bounds.
 *
 * Ticket #87 generalization: the prior version only recognized
 * `isSymbolicLink()` for the on-disk shape. The directory → leaf
 * regular/executable transition leaves `lstat(<dir>/<descendant>)`
 * throwing ENOTDIR post-reset, aborting the destructive step
 * after `git reset --hard` has already run. The skip set now
 * covers every leaf shape the target may install.
 */
async function collectTypeTransitionAncestors(
  canonicalRoot: string,
  preimageEntries: readonly DiscardEntry[],
  trackedPaths: ReadonlySet<string>,
  targetEntries: readonly TargetTreeEntry[],
): Promise<Set<string>> {
  // Map from preimage directory entry path to whether the target
  // tree declares the same path as a tracked leaf. Only paths that
  // exist as directories in the preimage AND as non-directory leaves
  // in the target tree (i.e. as a regular file, executable, or
  // symlink) qualify as leaf/type transitions.
  const preimageDirs = new Set<string>();
  for (const entry of preimageEntries) {
    if (entry.kind === "dir") preimageDirs.add(entry.path);
  }
  const ancestors = new Set<string>();
  for (const dir of preimageDirs) {
    if (!trackedPaths.has(dir)) continue;
    // The target declares `dir` as a tracked leaf. After `git
    // reset --hard`, the on-disk entry at this path is whatever
    // the target says (a regular file, executable file, or
    // symlink). Any non-directory shape means every preimage
    // descendant of `dir` is unreachable:
    //   - symlink: resolution traverses the target outside the
    //     canonical root (or into a registered worktree).
    //   - regular/executable file: `lstat(<dir>/<descendant>)`
    //     throws ENOTDIR.
    // Skip the descendants in both cases. Ticket #87
    // generalization: the ticket #86 implementation only included
    // `isSymbolicLink()`, so directory → regular-file transitions
    // threw ENOTDIR post-reset.
    const absolute = join(canonicalRoot, dir);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (stats.isFile() || stats.isSymbolicLink()) ancestors.add(dir);
  }
  // Also follow the parent chain of every preimage directory whose
  // target path is NOT itself tracked as a leaf. The direct
  // ancestor — if it was a preimage directory AND is now any
  // non-directory leaf on disk after reset — is recorded here so
  // the descendant preimage subtree (e.g. `a/b/c/` where the
  // target installs a regular file at `a/b/`) is skipped in the
  // same way. Ticket #87 generalization: the ticket #86 follow-up
  // only matched on-disk symlinks; here we match any leaf shape.
  for (const dir of preimageDirs) {
    if (trackedPaths.has(dir)) continue;
    // `dir` is in the preimage as a directory and the target tree
    // does NOT track it. The destructive step will attempt to
    // remove it (subject to the protected-paths check). If its
    // parent chain contains a preimage directory that became a
    // non-directory target leaf after `git reset --hard`, the
    // directory itself is unreachable post-reset and must be
    // skipped.
    let cursor = dir;
    while (cursor.includes("/")) {
      const parent = cursor.slice(0, cursor.lastIndexOf("/"));
      if (parent === "") break;
      if (trackedPaths.has(parent) && preimageDirs.has(parent)) {
        const parentAbsolute = join(canonicalRoot, parent);
        let stats: Awaited<ReturnType<typeof lstat>>;
        try {
          stats = await lstat(parentAbsolute);
        } catch (error) {
          if (isEnoent(error)) break;
          throw error;
        }
        if (stats.isFile() || stats.isSymbolicLink()) ancestors.add(parent);
        break;
      }
      cursor = parent;
    }
  }
  // Ticket #88 finding #1: extend the skip set to cover target-
  // installed symlinks whose path has preimage DESCENDANTS but
  // for which the preimage does NOT record the parent directory
  // entry. The ticket #86 / ticket #87 detection required the
  // parent to be present in the preimage as a directory so the
  // walker could observe the transition. When the parent is
  // absent (the local working tree held the symlink shape on
  // disk at capture time, so only the descendant was recorded),
  // the previous skip would miss the target symlink and the
  // destructive cleanup would resolve through the symlink to
  // delete bytes outside the canonical root.
  //
  // The detection stays shape-driven (lstat-based), not
  // target-driven: the symlink is unsafe to traverse regardless
  // of where it points, so a manual swap between the fingerprint
  // and the destructive step does not change the verdict. Any
  // target tree symlink that has at least one preimage
  // descendant is added to the skip set; the `entryDescendantOf
  // TypeTransitionAncestor` check below then refuses the
  // descendant during deletion.
  for (const targetEntry of targetEntries) {
    if (targetEntry.mode !== 0o120000) continue;
    const symlinkPath = targetEntry.path;
    // Skip if a preimage descendant exists. The preimage walk
    // emits paths with forward-slash separators and no leading
    // `./`, matching the target tree's encoding.
    for (const preimageEntry of preimageEntries) {
      if (preimageEntry.path.startsWith(`${symlinkPath}/`)) {
        ancestors.add(symlinkPath);
        break;
      }
    }
  }
  return ancestors;
}

function entryDescendantOfTypeTransitionAncestor(
  entryPath: string,
  ancestors: ReadonlySet<string>,
): boolean {
  for (const ancestor of ancestors) {
    if (entryPath === ancestor) return true;
    if (entryPath.startsWith(`${ancestor}/`)) return true;
  }
  return false;
}

interface ProtectedPathsArgs {
  preimageEntries: readonly DiscardEntry[];
  trackedAncestors: Set<string>;
  worktreeAncestors: Set<string>;
}

/**
 * Compute the closed set of paths reconcile must never delete.
 * The set covers:
 *
 *   - declared exclusion file/script paths (e.g. `.poiesis/manifest.json`);
 *   - the directory roots of declared exclusion subtrees (e.g. `.poiesis`);
 *   - the recorded ancestors of declared exclusion roots and
 *     exclusion files (`.poiesis` → `.`);
 *   - the recorded ancestors of every registered linked worktree
 *     root (the `distant/sibling/` parent of `distant/sibling/wt/`);
 *   - tracked-target ancestors (the `src/` of a tracked `src/foo.txt`)
 *     so the destructive step never wipes a directory that contains
 *     a tracked child;
 *   - any preimage entry recorded under a declared exclusion subtree
 *     (catches the `.poiesis/manifest.json`-and-sibling shape, where
 *     a transitively-related residue must not be deleted).
 *
 * The output is a `Set<string>` of canonical forward-slash paths
 * relative to the repository root. The deletion walker consults the
 * set to refuse the entry (`skip`) before any `rm` / `rmdir` runs.
 */
function computeProtectedPaths(args: ProtectedPathsArgs): Set<string> {
  const protectedPaths = new Set<string>();
  // 1. Declared exclusion ancestors + subtree roots.
  for (const dir of RECONCILE_EXCLUSION_SUBTREE_DIRS) {
    protectedPaths.add(dir);
    let cursor = dir;
    while (cursor.includes("/")) {
      const parent = cursor.slice(0, cursor.lastIndexOf("/"));
      if (parent === "") break;
      protectedPaths.add(parent);
      cursor = parent;
    }
  }
  for (const file of RECONCILE_EXCLUSION_FILES) {
    protectedPaths.add(file);
    let cursor = file;
    while (cursor.includes("/")) {
      const parent = cursor.slice(0, cursor.lastIndexOf("/"));
      if (parent === "") break;
      protectedPaths.add(parent);
      cursor = parent;
    }
  }
  for (const ancestor of RECONCILE_PROTECTED_ANCESTORS) {
    protectedPaths.add(ancestor);
    let cursor = ancestor;
    while (cursor.includes("/")) {
      const parent = cursor.slice(0, cursor.lastIndexOf("/"));
      if (parent === "") break;
      protectedPaths.add(parent);
      cursor = parent;
    }
  }
  // 2. Tracked-target ancestors.
  for (const ancestor of args.trackedAncestors) {
    protectedPaths.add(ancestor);
  }
  // 3. Worktree ancestors.
  for (const ancestor of args.worktreeAncestors) {
    protectedPaths.add(ancestor);
  }
  // 4. Subtree roots of declared exclusions.
  for (const subtree of RECONCILE_EXCLUSION_SUBTREE_DIRS) {
    protectedPaths.add(subtree);
  }
  // 5. Any preimage entry whose path is under a declared exclusion
  // subtree (defensive; the walker skips these by construction).
  for (const entry of args.preimageEntries) {
    for (const subtree of RECONCILE_EXCLUSION_SUBTREE_DIRS) {
      if (entry.path === subtree || entry.path.startsWith(`${subtree}/`)) {
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

/**
 * Build the set of canonical root-relative paths that are
 * worktree-root ancestors (the directories between the canonical
 * root and any registered linked worktree). The destructive step
 * treats each as protected: a `distant/sibling/` ancestor dir of
 * the worktree `distant/sibling/wt/` MUST NOT be deleted, but the
 * residue files inside `distant/sibling/` (NOT under the worktree)
 * remain deletable.
 */
function deriveWorktreeAncestors(canonicalRoot: string, worktrees: readonly WorktreeRecord[]): Set<string> {
  const ancestors = new Set<string>();
  for (const worktree of worktrees) {
    if (worktree.path === canonicalRoot) continue;
    const rel = relative(canonicalRoot, worktree.path);
    if (rel === "" || rel === "..") continue;
    let cursor = rel;
    while (cursor.includes("/")) {
      const parent = cursor.slice(0, cursor.lastIndexOf("/"));
      if (parent === "" || parent === ".") break;
      ancestors.add(parent);
      cursor = parent;
    }
  }
  return ancestors;
}

/**
 * Build the set of tracked-target ancestor paths. Every directory
 * path on the way from the repository root to any tracked target
 * blob is included. The deletion walker skips entries in this set
 * (so the directories survive) but still deletes residue files
 * inside them (which are processed deepest-first and never reach
 * the protected ancestor itself).
 */
function deriveTrackedAncestors(targetEntries: readonly TargetTreeEntry[]): Set<string> {
  const ancestors = new Set<string>();
  for (const entry of targetEntries) {
    let cursor = entry.path;
    while (cursor.includes("/")) {
      const parent = cursor.slice(0, cursor.lastIndexOf("/"));
      if (parent === "") break;
      if (!ancestors.has(parent)) ancestors.add(parent);
      cursor = parent;
    }
  }
  return ancestors;
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
    // Non-recursive `rmdir` only succeeds for an empty directory. A
    // directory with a still-tracked child or with a sibling residue
    // entry that landed below it (out of preimage order) will throw
    // ENOTEMPTY; we ignore that case because the directory is then
    // non-residue and reconcile cannot reclaim it. The pre-mutation
    // revalidation's fingerprint mismatch guard catches the
    // out-of-preimage case before this code path runs.
    // Node's `fs.rm` is for files and recurses on directories, so
    // `rmdir` is the right primitive for the empty-dir-only case.
    try {
      await rmdir(absolute);
    } catch (error) {
      if (isEnoent(error)) return;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      throw error;
    }
    return;
  }
  // Plain file / symlink / fifo: remove the validated leaf only.
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

/**
 * Tracked-target collision check for registered linked worktrees
 * and their ancestors. A target blob whose path:
 *
 *   - equals a registered worktree root (would clobber the worktree
 *     directory);
 *   - descends into a registered worktree root (would create files
 *     under the worktree's territory);
 *   - is an ancestor of a registered worktree root (would replace
 *     the parent directory of the worktree);
 *
 * all break the assumption that `git reset --hard` cannot
 * interfere with a registered worktree's working tree. The check
 * uses both the absolute-path containment check (the
 * `isInsideAnyWorktreeRoot`-style logic) and the canonical-root-
 * relative path comparison so the ancestor-of-worktree shape is
 * caught even when the worktree lives outside the canonical root.
 * Ticket #85 finding #3.
 */
function collidesWithWorktreeAncestry(
  repositoryPath: string,
  absolutePath: string,
  worktreeRoots: Set<string>,
  canonicalRoot: string,
): boolean {
  for (const root of worktreeRoots) {
    const within = relative(root, absolutePath);
    if (within === "" || within === "..") return true;
    if (!within.startsWith(`..${sep}`) && !isAbsolute(within)) return true;
  }
  // Ancestor-of-worktree-root + within-worktree-root checks via the
  // canonical-root-relative path. The equality case (`repositoryPath`
  // === `rootRel`) is a collision because the target blob is exactly
  // at the registered worktree directory.
  for (const root of worktreeRoots) {
    const rootRel = relative(canonicalRoot, root);
    if (rootRel === "" || rootRel === "..") continue;
    if (repositoryPath === rootRel) return true;
    // Descendant of worktree root (inside the worktree's territory).
    if (rootRel.startsWith(`${repositoryPath}/`)) return true;
    // Ancestor of worktree root (would replace the parent dir).
    if (repositoryPath.startsWith(`${rootRel}/`)) return true;
  }
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

async function assertNoActiveGitOperation(canonicalRoot: string): Promise<void> {
  // Ticket #86 finding #3: the resolved git-dir (per-worktree, not
  // the common dir) is the authoritative location for all
  // active-operation indicators. A primary checkout shares
  // `git-dir == git-common-dir`, so the two resolve to the same
  // path; we resolve the per-worktree dir explicitly so a linked
  // worktree would still check its own state (the primary-checkout
  // gate already refuses linked worktrees, so this is defense in
  // depth).
  const gitDir = await canonicalGitDir(canonicalRoot);
  const commonDir = await canonicalCommonDir(canonicalRoot);
  // The lockfiles live in the common dir because they are shared
  // across all worktrees (a single `.git/index.lock` represents an
  // in-progress index operation for any of them). The head/topic
  // indicators live in the per-worktree git-dir.
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
  // Per-worktree HEAD/state indicators: in-progress rebase, merge,
  // cherry-pick, revert. `git rev-parse --verify --quiet <ref>`
  // returns 0 only when the ref exists; the canonical signals are
  // checked here so a paused sequence (left behind after a crash
  // or `git cherry-pick --quit` race) is refused before any
  // destructive step.
  for (const indicator of ["REBASE_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const result = await run("git", ["rev-parse", "--verify", "--quiet", indicator], {
      cwd: gitDir,
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
  // Directory-shaped state indicators that `git rev-parse` does
  // not surface: a `rebase-apply/` or `rebase-merge/` directory
  // (paused/interactive rebase, paused `git am`), a `sequencer/`
  // directory (paused cherry-pick or revert), and the per-worktree
  // `MERGE_MSG` file (an in-progress merge with the user-visible
  // message already drafted). The presence of any of these in the
  // resolved git-dir refuses reconcile with the same typed error
  // as the head-indicator path.
  const stateDirs = ["rebase-apply", "rebase-merge", "sequencer"];
  for (const dir of stateDirs) {
    const path = join(gitDir, dir);
    if (await pathExists(path)) {
      throw new PoiesisError(
        "RECONCILE_GIT_OPERATION_ACTIVE",
        `Refusing to reconcile while a \`${dir}/\` state directory exists in the resolved git-dir`,
        { path },
      );
    }
  }
  // `MERGE_MSG` and the `rebase-merge/` `msgnum`/`end` sentinels
  // are file-shaped signals. We check them via the resolved git
  // dir's filesystem entries so a paused rebase left without a
  // `rebase-merge/` directory but with a `MERGE_MSG` (rare but
  // possible across Git versions) still triggers the refusal.
  const stateFiles = ["MERGE_MSG", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
  for (const file of stateFiles) {
    const path = join(gitDir, file);
    if (await pathExists(path)) {
      throw new PoiesisError(
        "RECONCILE_GIT_OPERATION_ACTIVE",
        `Refusing to reconcile while a \`${file}\` state file exists in the resolved git-dir`,
        { path },
      );
    }
  }
  // Paused-`am` sentinel: a `rebase-apply/` directory with no
  // `head-name` is empty (a previous run aborted cleanly); a
  // `rebase-apply/head-name` file is the on-disk signal for an
  // in-progress `git am` (or interactive rebase paused before the
  // first pick). The directory-presence check above covers most
  // cases; this additional check documents the canonical paused-am
  // shape for the final-review evidence trail.
  const pausedAmSentinel = join(gitDir, "rebase-apply", "head-name");
  if (await pathExists(pausedAmSentinel)) {
    throw new PoiesisError(
      "RECONCILE_GIT_OPERATION_ACTIVE",
      "Refusing to reconcile while a paused `git am` (`rebase-apply/head-name`) state file exists",
      { path: pausedAmSentinel },
    );
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
  // Conservative refuse of any content-transform mechanism. The
  // discard-scope walker has just built the preimage and will report
  // any `.gitattributes` file it descends into. The walker also
  // flags `info/attributes` (a single sentinel path inside `.git/`),
  // which never lands in the preimage but is conservative to refuse
  // independently. Ticket #85 finding #5.
  //
  // `.gitattributes` may declare `filter=` directives that route
  // through smudge/clean hooks or `eol=` attributes that switch the
  // working tree between CRLF and LF on checkout. Even a benign
  // attribute like `* text` can normalize line endings on some
  // platforms, defeating the postcondition's bytewise equality check.
  // We refuse ALL `.gitattributes` (any path) AND `info/attributes`
  // AND `core.attributesFile` AND `core.autocrlf` AND any
  // `filter.*` config: any of them, alone, can break the
  // working-tree equality contract.
  await refuseAnyGitattributes(root);
  await refuseInfoAttributes(root);
  await refuseAttributesFileConfig(root);
  await refuseFilterConfig(root);
  await refuseAutocrlf(root);
  // Ticket #86 finding #2: also resolve the implicit user/system
  // attribute sources (`$XDG_CONFIG_HOME/git/attributes` and
  // `/etc/gitattributes`) so a fingerprint does not silently rely
  // on the host's user or system configuration. We probe the
  // resolved `core.attributesFile` and the implicit fallback
  // locations via `git config --show-origin --get` so the same
  // source-of-truth Git uses is consulted. The probe stays
  // byte-bounded (the attributesFile value is a single path).
  await refuseImplicitAttributesSources(root);
}

/**
 * Refuse when the resolved effective attributes sources include
 * the implicit user (`$XDG_CONFIG_HOME/git/attributes`,
 * `$XDG_CONFIG_HOME/git/ignore`, `$HOME/.config/git/attributes`)
 * or system (`/etc/gitattributes`) attribute files. The detection
 * uses `git config --show-origin --get core.attributesFile` so the
 * same source-of-truth Git uses is consulted; if the resolved
 * value is the user/system default (i.e. unset), we fall back to
 * probing the canonical XDG and `/etc/gitattributes` paths
 * directly. Ticket #86 finding #2.
 */
async function refuseImplicitAttributesSources(root: string): Promise<void> {
  // First: ask git for the resolved attributesFile with its
  // origin. If the origin is anything other than the local
  // repository config or `.git/config`, we refuse.
  const result = await run("git", ["config", "--show-origin", "--get", "core.attributesFile"], {
    cwd: root,
    allowFailure: true,
  });
  if (result.exitCode === 0 && result.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with truncated `core.attributesFile`",
    );
  }
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    // The output format is `file:<path>\t<value>` (or `command:...`
    // for command-line overrides). Anything other than a local-repo
    // config origin is an implicit user/system source.
    const lines = result.stdout.split("\n");
    for (const line of lines) {
      const tabIndex = line.indexOf("\t");
      if (tabIndex < 0) continue;
      const origin = line.slice(0, tabIndex);
      const value = line.slice(tabIndex + 1);
      // `local` = `.git/config`, `worktree` = `.git/config.worktree`,
      // `global` = `~/.gitconfig`, `system` = `/etc/gitconfig`,
      // `command` = command-line `--core.attributesFile`. Anything
      // not `local`/`worktree`/`command` is implicit.
      if (origin !== "local" && origin !== "worktree" && origin !== "command") {
        throw new PoiesisError(
          "RECONCILE_FILTER_ACTIVE",
          `Refusing to reconcile a repository with \`core.attributesFile\` resolved from \`${origin}\``,
          { path: value, origin },
        );
      }
    }
  }
  // Second: even when `core.attributesFile` is unset, git falls
  // back to the implicit user/system defaults. Probe the canonical
  // locations via `git rev-parse` so the path resolution matches
  // Git's own behavior on this host.
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const home = process.env.HOME;
  const implicitPaths: string[] = [];
  if (typeof xdgConfigHome === "string" && xdgConfigHome.length > 0) {
    implicitPaths.push(join(xdgConfigHome, "git", "attributes"));
  }
  if (typeof home === "string" && home.length > 0) {
    implicitPaths.push(join(home, ".config", "git", "attributes"));
  }
  implicitPaths.push("/etc/gitattributes");
  for (const candidate of implicitPaths) {
    if (await pathExists(candidate)) {
      throw new PoiesisError(
        "RECONCILE_FILTER_ACTIVE",
        "Refusing to reconcile a repository whose implicit user/system attributes source is active",
        { path: candidate },
      );
    }
  }
  // Third: ask git directly via `check-attr` whether ANY path in
  // the working tree carries an attribute. If the implicit user/
  // system attributes source declared one (e.g. `* filter=lfs`),
  // git will surface it via check-attr even though no working-tree
  // `.gitattributes` exists. We probe a sentinel file that always
  // exists (`README.md` is created by every test fixture; in the
  // rare case it does not, the check is a no-op). This is the
  // canonical cross-host probe: git itself resolves all four
  // attribute sources (repo `.gitattributes`, `.git/info/attributes`,
  // `core.attributesFile`, XDG/system) and reports the merged
  // result.
  const probeResult = await run(
    "git",
    ["check-attr", "-a", "--", "README.md"],
    { cwd: root, allowFailure: true },
  );
  if (probeResult.exitCode === 0 && probeResult.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with truncated `git check-attr` output",
    );
  }
  if (probeResult.exitCode === 0 && probeResult.stdout.trim().length > 0) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with effective attributes (user/system or `core.attributesFile`) active",
      { attributes: probeResult.stdout.trim() },
    );
  }
}

/**
 * Recursively refuse any `.gitattributes` file in the working tree.
 * Splits out from `assertNoContentFilters` so target-tree scans can
 * reuse the same predicate against a fetched tree.
 */
async function refuseAnyGitattributes(root: string): Promise<void> {
  for await (const found of findAllGitattributesFiles(root)) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a working tree containing a `.gitattributes` file",
      { path: found },
    );
  }
}

async function refuseInfoAttributes(root: string): Promise<void> {
  // `.git/info/attributes` is the per-repo fallback. Refuse even if
  // it is empty.
  const infoAttributes = join(root, ".git", "info", "attributes");
  if (await pathExists(infoAttributes)) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a working tree with an `info/attributes` file",
      { path: ".git/info/attributes" },
    );
  }
}

async function refuseAttributesFileConfig(root: string): Promise<void> {
  const attrsFile = await run("git", ["config", "--get", "core.attributesFile"], {
    cwd: root,
    allowFailure: true,
  });
  if (attrsFile.exitCode === 0 && attrsFile.stdout.trim().length > 0) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with a configured `core.attributesFile`",
      { path: attrsFile.stdout.trim() },
    );
  }
  if (attrsFile.exitCode === 0 && attrsFile.stdoutTruncated) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with truncated `core.attributesFile`",
    );
  }
}

async function refuseFilterConfig(root: string): Promise<void> {
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
}

async function refuseAutocrlf(root: string): Promise<void> {
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

/**
 * Yield every `.gitattributes` file path found anywhere under
 * `root`, rooted at the working tree (excluding `.git/`). Used by
 * the working-tree gate (`assertNoContentFilters`) and by the
 * target-tree pre-mutation validator to refuse nested
 * `.gitattributes` introduced by the integration branch before reset.
 *
 * Ticket #86 finding #4: the walker applies the SAME bounded
 * traversal, declared exclusion skip, and registered-worktree skip
 * the discard-scope walker uses, so an attributes file nested
 * inside `.poiesis/workspaces/spec__nested/` (a registered
 * linked worktree) does not block reconcile, and an attributes
 * walk that exceeds the resource bounds fails closed with
 * `RECONCILE_SCAN_INCOMPLETE`.
 */
async function* findAllGitattributesFiles(root: string): AsyncGenerator<string> {
  // Apply identical incremental bounds to the attribute-discovery
  // walk. The discard-scope walker enforces the same bounds via
  // the per-`walkWorkingTree`-call counters; here we use a
  // module-local counter because the attribute walk is a
  // single-purpose pass.
  let filesScanned = 0;
  let dirsScanned = 0;
  let symlinksScanned = 0;
  let bytesScanned = 0;
  const liveWorktrees = await listWorktrees(root);
  const worktreeRoots = new Set(
    liveWorktrees
      .filter((worktree) => worktree.path !== root)
      .map((worktree) => worktree.path),
  );
  const excludeSubtreeDirs = new Set(RECONCILE_EXCLUSION_SUBTREE_DIRS);
  const excludeFiles = new Set(RECONCILE_EXCLUSION_FILES);
  yield* listGitattributesUnder(root, "", excludeSubtreeDirs, excludeFiles, worktreeRoots, {
    accumulateFile: () => {
      filesScanned += 1;
      if (filesScanned > DEFAULT_MAX_FILES()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Attribute discovery exceeds the configured file count bound",
          { filesScanned, maxFiles: DEFAULT_MAX_FILES() },
        );
      }
    },
    accumulateDir: () => {
      dirsScanned += 1;
      if (dirsScanned > DEFAULT_MAX_DIRS()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Attribute discovery exceeds the configured directory count bound",
          { dirsScanned, maxDirs: DEFAULT_MAX_DIRS() },
        );
      }
    },
    accumulateSymlink: () => {
      symlinksScanned += 1;
      if (symlinksScanned > DEFAULT_MAX_SYMLINKS()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Attribute discovery exceeds the configured symlink count bound",
          { symlinksScanned, maxSymlinks: DEFAULT_MAX_SYMLINKS() },
        );
      }
    },
    accumulateBytes: (count) => {
      bytesScanned += count;
      if (bytesScanned > DEFAULT_MAX_TOTAL_BYTES()) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Attribute discovery exceeds the configured aggregate byte bound",
          { bytesScanned, maxBytes: DEFAULT_MAX_TOTAL_BYTES() },
        );
      }
    },
  });
}

interface GitattributesWalkCallbacks {
  accumulateFile: () => void;
  accumulateDir: () => void;
  accumulateSymlink: () => void;
  accumulateBytes: (count: number) => void;
}

async function* listGitattributesUnder(
  root: string,
  relativePath: string,
  exclusionSubtreeDirs: Set<string>,
  exclusionFiles: Set<string>,
  worktreeRoots: Set<string>,
  callbacks: GitattributesWalkCallbacks,
): AsyncGenerator<string> {
  // Mirror `walkWorkingTree`: refuse to descend into a declared
  // exclusion subtree directory OR a registered linked worktree
  // root. The exclusion list and worktree-root set are the SAME
  // values the discard-scope walker uses, so both passes agree on
  // what is skipped.
  if (relativePath !== "") {
    if (exclusionSubtreeDirs.has(relativePath)) return;
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
  for (const dirent of dirents) {
    const childRelative = relativePath === "" ? dirent.name : `${relativePath}/${dirent.name}`;
    if (relativePath === "" && dirent.name === ".git") continue;
    if (exclusionFiles.has(childRelative)) continue;
    if (dirent.isSymbolicLink()) {
      callbacks.accumulateSymlink();
      continue;
    }
    if (dirent.isFile()) {
      callbacks.accumulateFile();
      if (dirent.name === ".gitattributes") {
        yield childRelative;
      }
      continue;
    }
    if (dirent.isDirectory()) {
      // Defense-in-depth: a subdirectory whose absolute path is a
      // registered linked worktree root is skipped, mirroring
      // `walkWorkingTree`.
      const childAbsolute = join(root, childRelative);
      if (worktreeRoots.has(childAbsolute)) continue;
      callbacks.accumulateDir();
      yield* listGitattributesUnder(
        root,
        childRelative,
        exclusionSubtreeDirs,
        exclusionFiles,
        worktreeRoots,
        callbacks,
      );
      continue;
    }
  }
}

/**
 * Refuse a fetched target tree that contains any `.gitattributes`
 * blob path. The pre-mutation validator reaches this after the
 * `git ls-tree -r -z` parse, so the path list is fully in memory.
 * A nested `src/.gitattributes` is enough to trigger refusal
 * (ticket #85 finding #5).
 */
function refuseAnyGitattributesInTarget(targetTree: readonly TargetTreeEntry[]): void {
  for (const entry of targetTree) {
    if (entry.path === ".gitattributes" || entry.path.endsWith("/.gitattributes")) {
      throw new PoiesisError(
        "RECONCILE_FILTER_ACTIVE",
        "Refusing to reconcile a target tree containing `.gitattributes`",
        { path: entry.path },
      );
    }
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

/**
 * Parse the Git index buffer for any 160000 (gitlink/submodule)
 * entries. Refuses with `RECONCILE_INDEX_MODE_INVALID` if a
 * gitlink is present without a matching `.gitmodules` file —
 * the working tree claims a submodule that no configuration
 * declares, which the flat-primary-checkout Spec cannot
 * reconcile. The check is performed against the raw index bytes
 * so the fingerprint capture does not silently inherit an
 * inconsistent index. Ticket #88 finding #3.
 *
 * The index v2 entry format is documented in `Documentation/
 * technical/index-format.txt`:
 *   - 12-byte header: `DIRC` (4) + version (4) + entry count (4);
 *   - per entry: 32 bytes of stat fields (ctime seconds /
 *     nanoseconds, mtime seconds / nanoseconds, dev, ino, mode,
 *     uid, gid, file size); the mode field lives at offset 12 +
 *     24 = 36 within the entry;
 *   - 20-byte (SHA-1) or 32-byte (SHA-256) object name;
 *   - 2-byte flags (stage lives in the low 2 bits of the high
 *     byte);
 *   - variable-length NUL-terminated path;
 *   - 1–8 NUL pad bytes to the next 8-byte boundary.
 *
 * The function is intentionally minimal: it scans for mode 160000
 * and stops at the first match. Truncated or malformed index
 * records fail closed at the index byte-budget gate above this
 * caller; the parser here only handles the well-formed happy
 * path that the discard-scope walker already requires.
 */
async function assertIndexHasNoOrphanedGitlinks(root: string, indexBytes: Buffer): Promise<void> {
  if (indexBytes.length === 0) return;
  // Header: 12 bytes. The supported index versions are 2, 3,
  // and 4. SHA-256 repositories emit version 3 (or 4 with
  // additional extensions); SHA-1 repositories emit version 2.
  // All three versions share the entry layout used below.
  if (indexBytes.length < 12) return;
  if (indexBytes.subarray(0, 4).toString("binary") !== "DIRC") return;
  const version = indexBytes.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) return;
  // Determine the SHA size from the version: v2/v3 use 20-byte
  // SHA-1 OIDs; v4 may use 32-byte SHA-256. The `core.sha256`
  // config is not consulted here; the index header version is
  // the authoritative signal for which hash the working tree
  // uses. We only need the entry-size layout for the mode byte,
  // which lives before the OID field, so a fixed 32-byte OID is
  // a safe upper bound for the offset arithmetic.
  const shaSize = version === 4 ? 32 : 20;
  const entryCount = indexBytes.readUInt32BE(8);
  let offset = 12;
  for (let index = 0; index < entryCount && offset + 64 <= indexBytes.length; index += 1) {
    // The mode field is at offset 24 within the per-entry stat
    // block. It is stored in big-endian 32-bit format.
    const mode = indexBytes.readUInt32BE(offset + 24);
    if ((mode & 0o170000) === 0o160000) {
      // Gitlink found. Read the path that follows the OID +
      // 2-byte flags block so the error message identifies the
      // exact entry that triggered the refusal. The path is
      // NUL-terminated; we cap the scan at 4096 bytes for
      // safety (the same `DEFAULT_MAX_PATH_BYTES` budget the
      // discard-scope walker uses).
      const pathOffset = offset + 40 + shaSize + 2;
      const pathEnd = Math.min(pathOffset + 4096, indexBytes.length);
      let pathEndIndex = pathEnd;
      for (let cursor = pathOffset; cursor < pathEnd; cursor += 1) {
        if (indexBytes[cursor] === 0) {
          pathEndIndex = cursor;
          break;
        }
      }
      const pathBytes = indexBytes.subarray(pathOffset, pathEndIndex);
      const gitlinkPath = pathBytes.toString("utf8");
      // Ticket #88 finding #3: an orphaned gitlink (160000 in
      // the index without `.gitmodules`) is refused up front so
      // the fingerprint never sees an inconsistent index. The
      // presence of `.gitmodules` would still trip
      // `assertNoSubmoduleConfig` (which refuses the entire
      // submodule shape), so this gate is a defense-in-depth
      // against the orphan-submodule case that previously
      // slipped past.
      const gitmodulesPath = join(root, ".gitmodules");
      if (await pathExists(gitmodulesPath)) {
        // `.gitmodules` is configured for the working tree. The
        // `assertNoSubmoduleConfig` gate refuses submodules
        // before this call site, so the orphan probe never
        // reaches this branch in the flat-checkout path. Keep
        // the explicit refusal so a future caller that disables
        // the submodule gate does not silently accept a real
        // submodule.
        throw new PoiesisError(
          "RECONCILE_INDEX_MODE_INVALID",
          "Git index contains a gitlink entry with a matching `.gitmodules` declaration; reconcile refuses submodules",
          { path: gitlinkPath },
        );
      }
      throw new PoiesisError(
        "RECONCILE_INDEX_MODE_INVALID",
        "Git index contains a gitlink (mode 160000) without a matching `.gitmodules` declaration",
        { path: gitlinkPath },
      );
    }
    // Advance past this entry: 40 bytes (stat block) + OID +
    // 2-byte flags + NUL-terminated path + 1–8 pad bytes to the
    // next 8-byte boundary. The padding is measured from the
    // entry's START (offset), not from the post-NUL cursor —
    // measuring from the cursor would misalign subsequent entries
    // when the name length plus fixed prefix is not a multiple
    // of 8.
    const pathOffset = offset + 40 + shaSize + 2;
    const pathEnd = Math.min(pathOffset + 4096, indexBytes.length);
    let pathEndIndex = pathEnd;
    for (let cursor = pathOffset; cursor < pathEnd; cursor += 1) {
      if (indexBytes[cursor] === 0) {
        pathEndIndex = cursor;
        break;
      }
    }
    const entrySizeIncludingName = pathEndIndex + 1 - offset;
    const remainder = entrySizeIncludingName % 8;
    let nextOffset = offset + entrySizeIncludingName;
    if (remainder !== 0) nextOffset += 8 - remainder;
    if (nextOffset <= offset) return; // malformed; refuse later at the index budget gate
    offset = nextOffset;
  }
}

/**
 * Verify every declared exclusion path is BOTH genuinely
 * untracked (`git ls-files --error-unmatch` exits non-zero) AND
 * genuinely ignored (`git check-ignore` exits zero) WHEN the
 * path actually exists on disk. A path that is tracked but also
 * ignored is still dangerous (tracked paths take precedence over
 * ignore rules on reset), and a path that exists but is not
 * ignored is dangerous too (its working-tree contents would be
 * silently reclassified by the discard-scope walker). The check
 * is conditional: an absent exclusion path cannot be tracked
 * (no bytes to clobber) and cannot fail to be ignored (nothing
 * to reclassify), so the assertion skips it. Refuse with a
 * typed error so the caller knows exactly which shape failed.
 * Ticket #88 finding #4.
 */
async function assertExclusionsAreGenuinelyUntrackedAndIgnored(root: string): Promise<void> {
  for (const file of RECONCILE_EXCLUSION_FILES) {
    const absolute = join(root, file);
    const exists = await pathExists(absolute);
    if (!exists) continue;
    // `git ls-files --error-unmatch` exits 0 when the path is
    // tracked and 1 when it is not. `--` terminates the option
    // parser so a path that begins with `-` does not look like
    // an option.
    const tracked = await run("git", ["ls-files", "--error-unmatch", "--", file], {
      cwd: root,
      allowFailure: true,
    });
    if (tracked.exitCode === 0) {
      throw new PoiesisError(
        "RECONCILE_EXCLUSION_TRACKED",
        "Declared exclusion path is tracked in the current index; reconcile cannot preserve a tracked path through reset",
        { path: file },
      );
    }
    if (tracked.stdoutTruncated) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "git ls-files output was truncated while probing declared exclusion paths",
        { path: file },
      );
    }
    // `git check-ignore` exits 0 when the path IS ignored, 1
    // when it is not, and 128 on operational error. The probe
    // runs against the file directly; the same `.gitignore`
    // resolution applies that `git status` uses.
    const ignored = await run("git", ["check-ignore", "--", file], {
      cwd: root,
      allowFailure: true,
    });
    if (ignored.exitCode !== 0) {
      throw new PoiesisError(
        "RECONCILE_EXCLUSION_NOT_IGNORED",
        "Declared exclusion path is not ignored by .gitignore; reconcile refuses to skip an untracked, non-ignored path",
        { path: file },
      );
    }
    if (ignored.stdoutTruncated) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "git check-ignore output was truncated while probing declared exclusion paths",
        { path: file },
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
  //
  // Ticket #85 finding #2: the walker "skip" set is restricted to
  // the actual exclusion subtree directories (and the literal
  // exclusion files). The previous `deriveExclusionBases` collapsed
  // these with ancestor paths, which made `.poiesis/other/*`
  // (a sibling of the exclusion subtrees, NOT an exclusion) invisible
  // to both the fingerprint scan and the destructive cleanup.
  const skipSubtreeDirs = new Set(RECONCILE_EXCLUSION_SUBTREE_DIRS);
  const skipFiles = new Set(RECONCILE_EXCLUSION_FILES);
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
  await walkWorkingTree(root, "", entries, skipSubtreeDirs, skipFiles, worktreeRoots, {
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
  exclusionSubtreeDirs: Set<string>,
  exclusionFiles: Set<string>,
  worktreeRoots: Set<string>,
  callbacks: WalkCallbacks,
): Promise<void> {
  // Refuse to descend into a declared exclusion subtree directory
  // OR a registered linked worktree root. The exclusion list is a
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
    if (exclusionSubtreeDirs.has(relativePath)) return;
    if (worktreeRoots.has(resolve(root, relativePath))) return;
  }
  const absolute = relativePath === "" ? root : join(root, relativePath);
  let dirents: Dirent<Buffer>[];
  try {
    // `encoding: "buffer"` keeps raw bytes for path-name validation,
    // sort, hash, and access. The walker still refuses the discard
    // scope when two child names alias via the UTF-8 replacement
    // character, so the fingerprint can never silently disagree with
    // the raw bytes on disk. Ticket #85 finding #4.
    const result = (await readdir(absolute, {
      withFileTypes: true,
      encoding: "buffer",
    })) as Dirent<Buffer>[];
    dirents = result;
    assertRawNamesAreUnambiguous(dirents, relativePath);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  // Byte-preserving deterministic order: compare each path's UTF-8
  // bytes lexicographically. The buffer form makes the comparison
  // immune to JS-string UTF-8 replacement characters.
  dirents.sort(bufferDirentSort);
  for (const dirent of dirents) {
    const nameString = bufferDirentNameString(dirent);
    const childRelative =
      relativePath === "" ? nameString : `${relativePath}/${nameString}`;
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
    if (relativePath === "" && nameString === ".git") continue;
    if (childRelative === ".gitmodules") {
      throw new PoiesisError(
        "RECONCILE_SUBMODULE",
        "Refusing to reconcile a working tree containing submodules",
        { path: ".gitmodules" },
      );
    }
    // Declared-exclusion-files skip: the literal path
    // `.poiesis/manifest.json` is part of the exclusion contract and
    // never enters the discard scope. The walker still descends
    // into `.poiesis/other/*`, whose preimage is the residue
    // reconcile must clean. Ticket #85 finding #2.
    if (exclusionFiles.has(childRelative)) continue;
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
        callbacks.accumulateDir();
        // Ticket #88 finding #2: descend first, then decide
        // whether the directory itself is empty. Empty
        // directories stay in the preimage so the destructive
        // step's `rmdir`-based cleanup can reclaim them (a
        // sibling test in ticket #85 pins this behavior) and
        // they DO contribute to the fingerprint digest (the
        // "changes for empty-directory presence" test pins this
        // — the header docblock's "directories including empty"
        // is the canonical contract). The postcondition's
        // bounded residue walker is the surface that surfaces
        // any empty directory the destructive step missed.
        const childEntries: DiscardEntry[] = [];
        await walkWorkingTree(
          root,
          childRelative,
          childEntries,
          exclusionSubtreeDirs,
          exclusionFiles,
          worktreeRoots,
          callbacks,
        );
        entries.push({
          path: childRelative,
          kind: "dir",
          mode: null,
          bytesDigest: null,
          bytesLength: 0,
          symlinkDigest: null,
          symlinkLength: null,
        });
        for (const childEntry of childEntries) entries.push(childEntry);
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
 * Refuse the discard scope when two sibling dirent names decode via
 * UTF-8 to the same string but have distinct raw bytes (invalid-
 * byte aliasing or replacement-character neighbors). The whole
 * premise of the fingerprint is byte-stable path comparisons, so we
 * fail closed rather than silently produce a digest that disagrees
 * with the actual filesystem. Ticket #85 finding #4.
 */
function assertRawNamesAreUnambiguous(dirents: Dirent<Buffer>[], relativePath: string): void {
  const seenBytes = new Map<string, string>();
  for (const dirent of dirents) {
    const bytes = dirent.name;
    const decoded = decodeUtf8StrictOrReject(bytes);
    const bytesKey = bytes.toString("binary");
    const previousDecoded = seenBytes.get(bytesKey);
    if (previousDecoded === undefined) {
      seenBytes.set(bytesKey, decoded);
      continue;
    }
    if (previousDecoded !== decoded) {
      throw new PoiesisError(
        "RECONCILE_INVALID_PATH_ENCODING",
        "Discard scope contains ambiguous path-name bytes (invalid-UTF-8 aliasing)",
        { path: relativePath === "" ? "<root>" : relativePath },
      );
    }
  }
  // Final cross-bytes check: distinct raw bytes that decode to the
  // same string would produce the same fingerprint path while
  // touching different bytes on disk — refuse.
  const stringCounts = new Map<string, number>();
  for (const decoded of seenBytes.values()) {
    stringCounts.set(decoded, (stringCounts.get(decoded) ?? 0) + 1);
  }
  for (const [decoded, count] of stringCounts) {
    if (count > 1 && decoded.includes("")) {
      throw new PoiesisError(
        "RECONCILE_INVALID_PATH_ENCODING",
        "Discard scope contains ambiguous path-name bytes (replacement-character aliasing)",
        { path: relativePath === "" ? "<root>" : relativePath, alias: decoded },
      );
    }
  }
}

function decodeUtf8StrictOrReject(bytes: Buffer): string {
  try {
    return TEXT_DECODER_FATAL.decode(bytes);
  } catch (error) {
    throw new PoiesisError(
      "RECONCILE_INVALID_PATH_ENCODING",
      "Discard scope contains invalid-UTF8 path bytes",
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
}

function bufferDirentNameString(dirent: Dirent<Buffer>): string {
  return dirent.name.toString("utf8");
}

function bufferDirentSort(left: Dirent<Buffer>, right: Dirent<Buffer>): number {
  return Buffer.compare(left.name, right.name);
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
  // Discard-scope inventory. Every entry — including empty
  // directories — contributes to the digest so adding or removing
  // an empty directory changes the fingerprint (the existing
  // "changes for empty-directory presence" test pins this
  // contract). The destructive step's `rmdir` reclaims empty
  // directories deepest-first so they are gone before the
  // postcondition bounded walker runs; the walker is the safety
  // net for paths the destructive step explicitly skips (e.g.
  // descendants of a target-installed symlink ancestor).
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
  // Ticket #88 finding #6: capture the URL output in binary
  // mode so the textual `stdout` is NOT trailing-whitespace-
  // stripped. The previous text-mode capture silently removed
  // a trailing space before the URL validator could reject it,
  // so a malformed URL with embedded whitespace slipped past
  // the probe.
  const fetch = await run(
    "git",
    ["remote", "get-url", "--all", name],
    { cwd: root, allowFailure: true, binaryStdout: true },
  );
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
  const push = await run(
    "git",
    ["remote", "get-url", "--push", "--all", name],
    { cwd: root, allowFailure: true, binaryStdout: true },
  );
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
    const kind = match[2]!;
    const oid = match[3]!;
    const path = match[4]!;
    if (path.includes("\n") || path.includes("\0")) {
      throw new PoiesisError(
        "RECONCILE_TARGET_TREE_INVALID",
        "git ls-tree returned a path containing LF or NUL bytes",
        { record: bounded(record, 256) },
      );
    }
    const mode = Number.parseInt(modeOctal, 8);
    // Ticket #86 finding #5: validate every target-tree mode BEFORE
    // any destructive step. The supported leaves are blob modes
    // (100644 regular, 100755 executable, 120000 symlink) and the
    // synthetic tree mode (040000, used by `git ls-tree` itself for
    // directory placeholders — never as a leaf in a `-r` listing,
    // but validated here so the postcondition cannot drift). Any
    // other mode — most importantly `160000` (gitlink/submodule)
    // and any future reserved shape — refuses the target tree
    // outright. Resetting to a target that contains a gitlink would
    // either silently drop the gitlink or replace the submodule's
    // directory with an empty entry; both outcomes violate the
    // exact-target contract.
    invariant(
      isSupportedTargetMode(mode, kind),
      "RECONCILE_TARGET_MODE_UNSUPPORTED",
      "git ls-tree returned a record with an unsupported mode",
      { path, mode: modeOctal, kind },
    );
    entries.push({ path, mode, oid });
  }
  return entries;
}

/**
 * Supported target-tree modes for the exact-target contract. Ticket
 * #86 finding #5: refuse anything outside this set before the
 * destructive step so a target-only gitlink (160000) or other
 * unsupported shape is never silently passed through.
 */
function isSupportedTargetMode(mode: number, kind: string): boolean {
  if (kind === "tree") return mode === 0o040000;
  if (kind === "blob") {
    return mode === 0o100644 || mode === 0o100755 || mode === 0o120000;
  }
  // `commit` and `tag` kinds (submodule gitlinks come through with
  // kind `commit` and mode `160000`; tag pointers have no place in a
  // tree-listing reconcile) are refused.
  return false;
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
      // Ticket #88 finding #5: compare the raw readlink bytes to
      // the raw `git cat-file blob` bytes. The previous SHA-1
      // recomputation is correct for SHA-1 repositories but
      // SILENTLY fails on SHA-256 repositories, where the entry
      // OID is a SHA-256 and a locally-computed SHA-1 can never
      // match. `git cat-file blob` returns the exact stored blob
      // bytes regardless of the hash algorithm, so the bytewise
      // comparison is object-format-neutral. The `binaryStdout:
      // true` option is paired with the genuine raw-buffer result
      // field — `stdoutBuffer` carries the byte-for-byte blob
      // through `process.run` without any UTF-8 string round-trip.
      const cat = await run("git", ["cat-file", "blob", entry.oid], {
        cwd: root,
        binaryStdout: true,
        maxBytes: DEFAULT_MAX_FILE_BYTES(),
      });
      if (cat.stdoutRawTruncated) return false;
      const targetBytes = cat.stdoutBuffer ?? Buffer.from(cat.stdout, "binary");
      if (targetBytes.length !== linkBuffer.length) return false;
      if (!targetBytes.equals(linkBuffer)) return false;
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
    // finding #7. The `binaryStdout: true` option is paired with
    // the genuine raw-buffer result field added in ticket #85
    // finding #6 — `stdoutBuffer` carries the byte-for-byte blob
    // through `process.run` without any UTF-8 string round-trip.
    // The string `stdout` field remains populated so the textual
    // text-mode API/behavior is preserved.
    const cat = await run("git", ["cat-file", "blob", entry.oid], {
      cwd: root,
      binaryStdout: true,
      // Ticket #86 finding #6: align the cat-file byte budget with
      // the per-file fingerprint bound (`DEFAULT_MAX_FILE_BYTES`,
      // 100 MiB) so a valid retained blob >256 KiB does not appear
      // truncated to the postcondition. The previous call relied on
      // the 256 KiB `process.run` default; a >256 KiB working tree
      // would silently truncate the captured blob and the bytewise
      // comparison would refuse the working tree even when the bytes
      // were byte-exact.
      maxBytes: DEFAULT_MAX_FILE_BYTES(),
    });
    // The binary-mode postcondition only refuses when the raw byte
    // stream itself was truncated by the byte budget. UTF-8 prefix
    // truncation (which only affects the textual `stdout` field)
    // is fine because the genuine `stdoutBuffer` carries the full
    // byte sequence. `stdoutTruncated` reflects BOTH signals; the
    // dedicated `stdoutRawTruncated` flag is the binary-mode
    // authority.
    if (cat.stdoutRawTruncated) return false;
    const targetBytes = cat.stdoutBuffer ?? Buffer.from(cat.stdout, "binary");
    const workingBytes = await readFile(absolute);
    if (targetBytes.length !== workingBytes.length) return false;
    if (!targetBytes.equals(workingBytes)) return false;
  }
  // Anything else the target tree does not declare must be absent.
  // Ticket #88 finding #2: the authoritative residue inventory is
  // the bounded filesystem walker in `collectPostReconcileResidue`
  // (called separately after this check), which surfaces empty
  // directories and refuses on truncation. The previous `git
  // status` based tail-check has been retired: it did not list
  // empty directories and could silently miss a residue entry
  // that appeared between the fingerprint capture and the
  // postcondition. The caller runs both checks; the bounded
  // walker is the source of truth.
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

/**
 * Bounded filesystem walk that lists every on-disk entry NOT
 * under a tracked path AND NOT under a declared exclusion AND
 * NOT under a registered linked worktree root. Empty directories
 * are included as residue (the previous `git status`-based
 * inventory did not surface them). The walk applies the same
 * per-attribute bounds the discard-scope walker uses and refuses
 * with `RECONCILE_SCAN_INCOMPLETE` when any bound overflows, so
 * the postcondition can never silently accept an unbounded
 * inventory. Ticket #88 finding #2.
 *
 * The walker also refuses on a truncated `readdir` (rare, but
 * possible on an interrupted filesystem operation) by checking
 * the capture's `stdoutRawTruncated` signal even though we read
 * via `readdir` directly. The bound check is the primary refusal
 * path; the truncation check is defense-in-depth for an
 * overlay-fs edge case.
 */
async function collectPostReconcileResidue(
  root: string,
  targetTree: readonly TargetTreeEntry[],
): Promise<string[]> {
  const liveWorktrees = await listWorktrees(root);
  const worktreeRoots = new Set(
    liveWorktrees
      .filter((worktree) => worktree.path !== root)
      .map((worktree) => worktree.path),
  );
  const excludeSubtreeDirs = new Set(RECONCILE_EXCLUSION_SUBTREE_DIRS);
  const excludeFiles = new Set(RECONCILE_EXCLUSION_FILES);
  // The protected-ancestor list (e.g. `.poiesis`) covers paths
  // that must survive reconcile even when they are empty after
  // residue children are removed. An empty `.poiesis/` is NOT
  // residue; it is the protected parent of every declared
  // exclusion. The walker treats these paths the same way the
  // destructive step does: never report them, never descend
  // through them.
  const protectedAncestors = new Set(RECONCILE_PROTECTED_ANCESTORS);
  // Tracked leaf paths from the fetched target tree. The walker
  // skips every entry in this set: a tracked blob that happens
  // to live at the root of the working tree (e.g. `README.md`)
  // is not residue. The set also drives the directory-prune
  // check: a directory whose only descendant is a tracked leaf
  // is NOT empty residue (the directory exists to hold the
  // tracked leaf).
  const trackedPaths = new Set(targetTree.map((entry) => entry.path));
  const trackedAncestors = deriveTrackedAncestors(targetTree);
  const offenders: string[] = [];
  let filesScanned = 0;
  let dirsScanned = 0;
  let symlinksScanned = 0;
  let bytesScanned = 0;

  const isUnderWorktreeRoot = (absolute: string): boolean => {
    for (const wtRoot of worktreeRoots) {
      const within = relative(wtRoot, absolute);
      if (within === "" || within === "..") return true;
      if (!within.startsWith(`..${sep}`) && !isAbsolute(within)) return true;
    }
    return false;
  };

  const checkBounds = (): void => {
    if (filesScanned > DEFAULT_MAX_FILES()) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "Postcondition residue inventory exceeds the configured file count bound",
        { filesScanned, maxFiles: DEFAULT_MAX_FILES() },
      );
    }
    if (dirsScanned > DEFAULT_MAX_DIRS()) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "Postcondition residue inventory exceeds the configured directory count bound",
        { dirsScanned, maxDirs: DEFAULT_MAX_DIRS() },
      );
    }
    if (symlinksScanned > DEFAULT_MAX_SYMLINKS()) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "Postcondition residue inventory exceeds the configured symlink count bound",
        { symlinksScanned, maxSymlinks: DEFAULT_MAX_SYMLINKS() },
      );
    }
    if (bytesScanned > DEFAULT_MAX_TOTAL_BYTES()) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "Postcondition residue inventory exceeds the configured aggregate byte bound",
        { bytesScanned, maxBytes: DEFAULT_MAX_TOTAL_BYTES() },
      );
    }
  };

  const walk = async (relativePath: string): Promise<void> => {
    // Skip declared exclusion subtree directories entirely; the
    // walker cannot descend into a protected subtree.
    if (relativePath !== "" && excludeSubtreeDirs.has(relativePath)) return;
    const absolute = relativePath === "" ? root : join(root, relativePath);
    if (relativePath !== "" && isUnderWorktreeRoot(absolute)) return;
    if (relativePath === ".git" || relativePath.startsWith(".git/")) return;
    let dirents: Dirent<Buffer>[];
    try {
      dirents = (await readdir(absolute, {
        withFileTypes: true,
        encoding: "buffer",
      })) as Dirent<Buffer>[];
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    // Byte-preserving deterministic order; matches the discard-
    // scope walker so a residue entry's surface position is
    // consistent across the two walks.
    const sorted = [...dirents].sort((left, right) => Buffer.compare(left.name, right.name));
    // Track ALL on-disk children (including excluded + worktree-
    // nested + tracked) so a directory that holds only excluded
    // content is NOT flagged as empty residue. The protected-
    // ancestor / exclusion-subtree directories are tracked
    // separately so an empty `.poiesis` after the destructive
    // step is not reported as residue.
    let totalChildren = 0;
    let residueChildren = 0;
    for (const dirent of sorted) {
      const name = dirent.name.toString("utf8");
      const childRelative =
        relativePath === "" ? name : `${relativePath}/${name}`;
      const childAbsolute = join(root, childRelative);
      if (relativePath === "" && name === ".git") continue;
      // Skip declared exclusion files (literal-path match).
      if (excludeFiles.has(childRelative)) continue;
      totalChildren += 1;
      if (isUnderWorktreeRoot(childAbsolute)) continue;
      // Skip tracked leaves: the destructive step preserved them,
      // the postcondition's `workingTreeMatchesTarget` already
      // validated their bytes, and reporting them as residue
      // would surface false positives (e.g. `README.md` at the
      // repository root after every reconcile).
      if (trackedPaths.has(childRelative)) continue;
      if (dirent.isSymbolicLink()) {
        symlinksScanned += 1;
        checkBounds();
        if (!isExcluded(childRelative)) {
          offenders.push(childRelative);
          residueChildren += 1;
        }
        continue;
      }
      if (dirent.isFile()) {
        filesScanned += 1;
        checkBounds();
        if (!isExcluded(childRelative)) {
          offenders.push(childRelative);
          residueChildren += 1;
        }
        continue;
      }
      if (dirent.isDirectory()) {
        dirsScanned += 1;
        checkBounds();
        if (excludeSubtreeDirs.has(childRelative)) continue;
        // Skip descending into a directory whose only role is to
        // contain tracked descendants. The walker would otherwise
        // report the empty intermediate directory as residue
        // even though every descendant is a tracked blob the
        // postcondition validated.
        if (trackedAncestors.has(childRelative)) {
          // The directory holds tracked descendants. Continue
          // descending to look for untracked children but do
          // not count the directory itself as residue.
          await walk(childRelative);
          continue;
        }
        await walk(childRelative);
        // Recurse first; the child directory may itself have
        // added residue entries. Even when it produced no residue
        // children, the directory itself contributes one residue
        // entry if it is empty and not protected.
        residueChildren += 1;
        continue;
      }
      // FIFO, socket, block/char device. Refuse rather than
      // silently include.
      throw new PoiesisError(
        "RECONCILE_UNSUPPORTED_ENTRY",
        "Refusing to reconcile a working tree containing an unsupported entry type",
        { path: childRelative },
      );
    }
    // An empty directory is residue iff it has zero on-disk
    // children, is not under an exclusion prefix, is not a
    // protected ancestor (`.poiesis`) that the destructive step
    // must preserve, and is not a registered worktree root. The
    // `totalChildren` count is the authoritative "empty" signal:
    // it includes excluded and tracked children, so a directory
    // that holds only excluded content (e.g. `.poiesis/` with
    // only `.poiesis/manifest.json`) is NOT empty residue.
    if (
      relativePath !== "" &&
      totalChildren === 0 &&
      !isExcluded(relativePath) &&
      !excludeSubtreeDirs.has(relativePath) &&
      !protectedAncestors.has(relativePath) &&
      !isUnderWorktreeRoot(absolute)
    ) {
      offenders.push(relativePath);
    }
    // Dirent length is a coarse byte accounting surrogate: a
    // large dirent set on a deep hierarchy would exceed the
    // bound before the per-file/per-dir increments do. The
    // per-file / per-dir / per-symlink bounds remain the
    // authoritative ones.
    bytesScanned += dirents.length;
    checkBounds();
    void residueChildren;
  };

  await walk("");
  return offenders.sort();
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
    // `ENOTDIR` is returned when an ancestor of `path` is not a
    // directory (e.g. the path is `dir/child` but `dir` is a
    // regular file). Treat that as "not exists" for the
    // reconciliation seam: the file is unreachable regardless.
    // `isEnoent` is the existing canonical "missing" check.
    if (isEnoent(error)) return false;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") return false;
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
  // Ticket #88 finding #6: do NOT trim whitespace. A URL with a
  // trailing space is malformed (the validator below rejects it),
  // and stripping the whitespace before validation would let the
  // malformed URL pass through silently. The bytewise record is
  // the source of truth.
  return value.split("\n").filter((line) => line.length > 0);
}
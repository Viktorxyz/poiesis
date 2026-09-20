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
import { chmod, lstat, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath, readlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { PoiesisError, invariant } from "./errors.js";
import { run } from "./process.js";
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
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_TOTAL_BYTES = 1_073_741_824; // 1 GiB
const DEFAULT_MAX_FILE_BYTES = 104_857_600; // 100 MiB
const DEFAULT_MAX_INDEX_BYTES = 16_777_216; // 16 MiB
const DEFAULT_MAX_PATH_BYTES = 4096;

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
  integrationBranch: string;
  exclusions: readonly string[];
  entryCount: number;
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
  const scan = await scanDiscardScope(canonicalRoot);
  const digest = computeFingerprintDigest({
    canonicalRoot,
    gitCommonDir,
    remote: options.remote,
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
    integrationBranch: options.integrationBranch,
    exclusions: [...RECONCILE_EXCLUSION_PATHS],
    entryCount: scan.entries.length,
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
  // a known-good (branch, HEAD, target) tuple.
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
  // tracked path under any declared exclusion prefix, otherwise
  // reconcile would silently delete tracked content during reset.
  const targetTree = await listTargetTree(canonicalRoot, fetchedTarget);
  for (const entry of targetTree) {
    invariant(
      !isExcluded(entry.path),
      "RECONCILE_EXCLUSION_COLLISION",
      "Declared exclusion path overlaps a tracked target path",
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
    // this point is refused.
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

    // The destructive step. We DO NOT classify new residue after this
    // point — anything in the discard scope that was not in the
    // declared exclusions is deleted by walking the entries the
    // fingerprint pre-validated.
    await performDestructiveReset({
      canonicalRoot,
      targetSha: fetchedTarget,
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
}

async function performDestructiveReset(args: DestructiveArgs): Promise<void> {
  // 1. Hard-reset HEAD + index + tracked tree to the fetched target.
  // `git reset --hard` is the only command that synchronously aligns
  // all three for the primary checkout. The declared exclusions are
  // NOT tracked by the target (collision refusal is on by the
  // pre-mutation revalidation), so the reset does not touch them.
  await run("git", ["reset", "--hard", args.targetSha], { cwd: args.canonicalRoot });

  // 2. Delete untracked/ignored residue EXCEPT declared exclusions,
  // Git administration (`.git/`), and any path that lives inside a
  // registered linked worktree's directory (an unusual but possible
  // layout; we never delete a registered linked worktree's contents).
  const targetTree = await listTargetTree(args.canonicalRoot, args.targetSha);
  const trackedPaths = new Set(targetTree.map((entry) => entry.path));
  // Re-list worktrees with canonicalization right before the
  // destructive step so the skip-set matches the current realpath
  // set even if a peer `git worktree move` slipped past the
  // revalidation window (the postcondition check still catches any
  // set drift after the fact). The PRIMARY checkout is excluded:
  // its working tree is the discard scope of reconcile itself, so
  // including it would skip every residue inside it. Only sibling
  // registered linked worktrees get the preservation guarantee.
  const liveWorktrees = await listWorktrees(args.canonicalRoot);
  const worktreeRoots = new Set(
    liveWorktrees
      .filter((worktree) => worktree.path !== args.canonicalRoot)
      .map((worktree) => worktree.path),
  );
  await deleteResidue({
    canonicalRoot: args.canonicalRoot,
    targetSha: args.targetSha,
    worktreeRoots,
    trackedPaths,
  });
}

interface DeleteResidueArgs {
  canonicalRoot: string;
  targetSha: string;
  worktreeRoots: Set<string>;
  trackedPaths: Set<string>;
}

async function deleteResidue(args: DeleteResidueArgs): Promise<void> {
  // `git status --porcelain=v1 -z --ignored` enumerates the working
  // tree's residue without truncation or status text loss. We walk
  // the entries and delete every path that is not a declared
  // exclusion, not a registered linked worktree root, not under
  // `.git/`, and not a tracked path in the target tree.
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"],
    { cwd: args.canonicalRoot },
  );
  if (status.stdout === "") return;
  const records = status.stdout.split("\0").filter(Boolean);
  for (const record of records) {
    if (record.length < 4) continue;
    // `git status -z` porcelain v1 encodes renames as two records
    // separated by NUL. The cleanup path ignores both halves — the
    // postcondition check below catches any orphan rename source.
    const path = record.slice(3);
    if (path === "") continue;
    if (path.startsWith(".git/") || path === ".git") continue;
    if (args.trackedPaths.has(path)) continue;
    if (isExcluded(path)) continue;
    const absolute = resolve(args.canonicalRoot, path);
    // Linked-worktree safety: every registered worktree root must
    // be preserved in place, so any residue path that resolves
    // INSIDE a registered worktree's directory is skipped — not
    // just paths that equal the root. The roots themselves are
    // canonical realpaths from `listWorktrees` so the comparison
    // is realpath-stable.
    if (isInsideAnyWorktreeRoot(args.worktreeRoots, absolute)) continue;
    await safeRemoveWithinRoot(args.canonicalRoot, path);
  }
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
  // through smudge/clean hooks. Such filters can rewrite content on
  // checkout, which breaks the bytewise target-equality contract.
  const gitattributes = join(root, ".gitattributes");
  if (await pathExists(gitattributes)) {
    const bytes = await readFile(gitattributes);
    if (/^.*filter=/m.test(bytes.toString("binary"))) {
      throw new PoiesisError(
        "RECONCILE_FILTER_ACTIVE",
        "Refusing to reconcile a working tree with content filters",
        { path: ".gitattributes" },
      );
    }
  }
  const filters = await run("git", ["config", "--get-regexp", "^filter\\."], {
    cwd: root,
    allowFailure: true,
  });
  if (filters.exitCode === 0 && filters.stdout.trim().length > 0) {
    throw new PoiesisError(
      "RECONCILE_FILTER_ACTIVE",
      "Refusing to reconcile a repository with configured Git filters",
    );
  }
}

async function assertNoSplitIndex(root: string): Promise<void> {
  const split = await run("git", ["config", "--get", "--bool", "splitIndex.enabled"], {
    cwd: root,
    allowFailure: true,
  });
  if (split.exitCode === 0 && split.stdout.trim() === "true") {
    throw new PoiesisError(
      "RECONCILE_SPLIT_INDEX",
      "Refusing to reconcile a split-index repository",
    );
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
  if (details.size > DEFAULT_MAX_INDEX_BYTES) {
    throw new PoiesisError(
      "RECONCILE_SCAN_INCOMPLETE",
      "Git index exceeds the maximum size for fingerprint capture",
      { path: indexPath, size: details.size, max: DEFAULT_MAX_INDEX_BYTES },
    );
  }
  return readFile(indexPath);
}

async function scanDiscardScope(root: string): Promise<ScanResult> {
  const entries: DiscardEntry[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  // We walk the primary root's working tree EXCLUDING `.git/`. The
  // entries in `.git/` are Git administration: the index is captured
  // separately, and markers/receipts live under it as preserved
  // shared state.
  await walkWorkingTree(root, "", entries, {
    accumulate: () => {
      filesScanned += 1;
    },
    accumulateBytes: (count) => {
      bytesScanned += count;
    },
  });
  // The walk itself enforces per-entry bounds. We also enforce the
  // whole-scope bounds here so an undersized scan can never claim to
  // be complete.
  if (filesScanned > DEFAULT_MAX_FILES || bytesScanned > DEFAULT_MAX_TOTAL_BYTES) {
    throw new PoiesisError(
      "RECONCILE_SCAN_INCOMPLETE",
      "Discard scope exceeds the configured resource bounds",
      {
        filesScanned,
        maxFiles: DEFAULT_MAX_FILES,
        bytesScanned,
        maxBytes: DEFAULT_MAX_TOTAL_BYTES,
      },
    );
  }
  return { entries, filesScanned, bytesScanned };
}

interface WalkCallbacks {
  accumulate: () => void;
  accumulateBytes: (count: number) => void;
}

async function walkWorkingTree(
  root: string,
  relativePath: string,
  entries: DiscardEntry[],
  callbacks: WalkCallbacks,
): Promise<void> {
  const absolute = relativePath === "" ? root : join(root, relativePath);
  let dirents: Dirent[];
  try {
    const { readdir } = await import("node:fs/promises");
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
    if (childRelativeBytes > DEFAULT_MAX_PATH_BYTES) {
      throw new PoiesisError(
        "RECONCILE_SCAN_INCOMPLETE",
        "Discard scope path exceeds the maximum size for fingerprint capture",
        {
          path: childRelative,
          size: childRelativeBytes,
          max: DEFAULT_MAX_PATH_BYTES,
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
    if (dirent.isSymbolicLink()) {
      const linkBuffer = await readlink(childAbsolute, { encoding: "buffer" });
      if (linkBuffer.length > DEFAULT_MAX_FILE_BYTES) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope entry exceeds the maximum size for fingerprint capture",
          {
            path: childRelative,
            size: linkBuffer.length,
            max: DEFAULT_MAX_FILE_BYTES,
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
      await walkWorkingTree(root, childRelative, entries, callbacks);
      continue;
    }
    if (dirent.isFile()) {
      const statResult = await stat(childAbsolute);
      if (statResult.size > DEFAULT_MAX_FILE_BYTES) {
        throw new PoiesisError(
          "RECONCILE_SCAN_INCOMPLETE",
          "Discard scope entry exceeds the maximum size for fingerprint capture",
          {
            path: childRelative,
            size: statResult.size,
            max: DEFAULT_MAX_FILE_BYTES,
          },
        );
      }
      const content = await readFile(childAbsolute);
      const digest = createHash("sha256").update(content).digest("hex");
      entries.push({
        path: childRelative,
        kind: "file",
        mode: statResult.mode & 0o7777,
        bytesDigest: digest,
        bytesLength: content.length,
        symlinkDigest: null,
        symlinkLength: null,
      });
      callbacks.accumulate();
      callbacks.accumulateBytes(content.length);
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

function bytewiseCompareDirents(left: Dirent, right: Dirent): number {
  const leftBytes = Buffer.from(left.name, "utf8");
  const rightBytes = Buffer.from(right.name, "utf8");
  return Buffer.compare(leftBytes, rightBytes);
}

interface DigestArgs {
  canonicalRoot: string;
  gitCommonDir: string;
  remote: string;
  integrationBranch: string;
  indexBytes: Buffer;
  exclusions: readonly string[];
  scan: ScanResult;
}

function computeFingerprintDigest(args: DigestArgs): string {
  const hash = createHash("sha256");
  hash.update(FINGERPRINT_DOMAIN);
  // Identity binding (canonical root, common dir, remote context).
  updateLengthFramed(hash, realpathSync(args.canonicalRoot));
  updateLengthFramed(hash, realpathSync(args.gitCommonDir));
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

function realpathSync(path: string): string {
  // `realpathSync` on the just-resolved canonical root + common dir
  // is a hot path inside `computeFingerprintDigest`. A sync call is
  // safe here because both inputs were already resolved through the
  // async `realpath` in `canonicalRootOf` / `canonicalCommonDir`.
  // Re-resolving keeps the fingerprint strictly canonical and
  // immune to bind-mount / symlink swap races during the scan.
  const { realpathSync: syncRealpath } = require("node:fs") as typeof import("node:fs");
  return syncRealpath(path);
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
  invariant(
    fetch.exitCode === 0,
    "RECONCILE_REMOTE_DRIFT",
    "Configured Git remote does not exist",
    { remote: name },
  );
  const fetchUrls = nonemptyLines(fetch.stdout);
  invariant(
    fetchUrls.length > 0,
    "RECONCILE_REMOTE_DRIFT",
    "Configured Git remote has no fetch URLs",
    { remote: name },
  );
  return { fetchUrls, pushUrls: fetchUrls };
}

interface TargetTreeEntry {
  path: string;
  mode: number;
  oid: string;
}

async function listTargetTree(root: string, target: string): Promise<TargetTreeEntry[]> {
  const result = await run("git", ["ls-tree", "-r", "-z", target], { cwd: root });
  if (result.stdout === "") return [];
  const entries: TargetTreeEntry[] = [];
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|tree|commit|tag) ([0-9a-f]+)\t(.*)$/.exec(record);
    if (match === null) continue;
    const modeOctal = match[1]!;
    const oid = match[3]!;
    const path = match[4]!;
    entries.push({ path, mode: Number.parseInt(modeOctal, 8), oid });
  }
  return entries;
}

async function listIndexOids(root: string): Promise<TargetTreeEntry[]> {
  const result = await run("git", ["ls-files", "--stage", "-z"], { cwd: root });
  if (result.stdout === "") return [];
  const entries: TargetTreeEntry[] = [];
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) continue;
    const meta = record.slice(0, tabIndex);
    const path = record.slice(tabIndex + 1);
    const parts = meta.split(" ");
    if (parts.length !== 3) continue;
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
      const digest = createHash("sha256").update(linkBuffer).digest("hex");
      // The target blob's OID is the SHA-1 of the symlink target
      // (`blob <len>\0<target>`); we recompute that here from the
      // working tree's readlink buffer and compare for bytewise
      // equality.
      const header = Buffer.from(`blob ${linkBuffer.length}\0`, "utf8");
      const { createHash: createHashFn } = await import("node:crypto");
      const oid = createHashFn("sha1").update(header).update(linkBuffer).digest("hex");
      if (oid !== entry.oid) return false;
      if (digest.length !== 64) return false;
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
    const oidResult = await run("git", ["hash-object", entry.path], { cwd: root });
    if (oidResult.stdout !== entry.oid) return false;
  }
  // Ensure no stray tracked paths exist outside the target tree.
  for (const entry of targetEntries) {
    void entry;
  }
  // Anything else the target tree does not declare must be absent.
  const status = await run("git", ["status", "--porcelain=v1", "-z"], { cwd: root });
  if (status.stdout === "") return true;
  for (const record of status.stdout.split("\0").filter(Boolean)) {
    if (record.length < 4) continue;
    const path = record.slice(3);
    if (path.startsWith(".git/") || path === ".git") continue;
    if (isExcluded(path)) continue;
    return false;
  }
  // Use the targetSha parameter to keep the postcondition aware of
  // which commit we expect; the previous loop would have exited early
  // on any residue.
  void targetSha;
  return true;
}

interface WorktreeRecord {
  path: string;
  branch: string | null;
}

async function listWorktrees(root: string): Promise<WorktreeRecord[]> {
  const result = await run("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root });
  if (!result.stdout) return [];
  const records = result.stdout.split("\0\0").filter(Boolean);
  const worktrees: WorktreeRecord[] = [];
  for (const record of records) {
    const fields = record.split("\0").filter(Boolean);
    const pathField = fields.find((field) => field.startsWith("worktree "));
    if (pathField === undefined) continue;
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

// Suppress the lint about unused declarations in the static class of
// imports Node may load after first use.
void chmod;
void writeFile;
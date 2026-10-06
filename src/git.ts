import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { PoiesisError, invariant } from "./errors.js";
import { bounded, boundedOutput, DEFAULT_VERIFY_TIMEOUT_MS, run, type RunResult } from "./process.js";
import { runManagedShellCommand } from "./managed-shell.js";
import { exists } from "./fs.js";
import { poiesisPath, resolveGitRoot } from "./paths.js";
import { loadManifest, type Manifest } from "./manifest.js";
import { assertOwnershipReceipt, type OwnershipReceipt } from "./receipt.js";
import {
  createVerificationReceipt,
  resolveLiveVerificationPlan,
  resolveVerificationReceipt,
  verificationEvidenceFrom,
  type VerificationCommandClassification,
  type VerificationCommandEvidenceV1,
  type VerificationEvidence,
} from "./verification-receipt.js";
import {
  validateProofEvidence,
  validatePublishEvidence,
  validateStagingEvidence,
  validateIntegrationEvidence,
  type IntegrationEvidence,
  type PublishEvidence,
  type PublishProvider,
} from "./evidence.js";
import type { ProofPayload, StagingPayload } from "./adapters.js";

const MARKER_DIRECTORY = "poiesis-workspaces-v1";
const DEFAULT_OUTPUT_LIMIT = 8_000;
const MAX_OUTPUT_LIMIT = 64_000;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitRemote {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
}

export interface GitBranch {
  name: string;
  sha: string;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
}

export interface InspectOptions {
  cwd: string;
  remote?: string;
  integrationBranch?: string;
  outputLimit?: number;
}

export interface InspectResult {
  root: string;
  gitCommonDir: string;
  head: string | null;
  branch: string | null;
  clean: boolean;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  branches: GitBranch[];
  remotes: GitRemote[];
  worktrees: GitWorktree[];
  integrationBase: string | null;
}

export interface WorkspacePrepareOptions {
  cwd: string;
  remote: string;
  integrationBranch: string;
  branch: string;
  workspacePath?: string;
  specId: string;
}

export interface WorkspaceIdentity {
  root: string;
  path: string;
  branch: string;
  specId: string;
  ownershipId: string;
  markerPath: string;
  remote: string;
  integrationBranch: string;
  baseSha: string;
  headSha: string;
}

export interface AcceptedReviewEvidence {
  verdict: "PASS";
  reviewerIdentity: string;
  evidence: string;
}

export interface CheckpointOptions {
  cwd: string;
  ownershipId?: string;
  paths: string[];
  message: string;
  review: AcceptedReviewEvidence;
  author?: GitIdentity;
}

export interface CheckpointResult {
  sha: string;
  branch: string;
  paths: string[];
  review: AcceptedReviewEvidence;
}

export interface VerifyOptions {
  cwd: string;
  candidateSha: string;
  commands: string[];
  /**
   * Spec #168 / ticket #169 — the Poiesis ownership identity of the
   * candidate workspace. When supplied, the shared lifecycle authority
   * must resolve a marker with exactly this ownership id or fail closed
   * with `WORKSPACE_OWNERSHIP_ID_MISMATCH`.
   */
  ownershipId?: string;
  timeoutMs?: number;
  outputLimit?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Spec #168 / ticket #176 — the caller's cancellation intent.
   *
   * The CLI dispatch owns one invocation-scoped controller and passes it here,
   * so an operator's SIGINT/SIGTERM settles the managed commands instead of
   * cutting the process off. A library caller may supply its own signal, or
   * none at all: nothing is installed on its behalf and its own cancellation
   * stays exactly as it declared it.
   */
  signal?: AbortSignal;
}

export interface VerifyCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface VerifyResult {
  candidateSha: string;
  cleanBefore: true;
  cleanAfter: true;
  commands: VerifyCommandResult[];
  /**
   * Spec #168 / ticket #171 — the runtime-owned whole-change Verify evidence.
   *
   * A proof-scope Verify persists an immutable `VerificationReceiptV1` under
   * the repository's shared Git common directory and returns the reference a
   * caller forwards in `--proof`. `null` ONLY on the non-project-bound
   * compatibility surface (a repository that never installed Poiesis), where
   * there is no runtime / installation identity to bind a receipt to and no
   * Publish can follow.
   */
  verification: VerificationEvidence | null;
}

export interface PublishOptions {
  cwd: string;
  ownershipId?: string;
  remote: string;
  integrationBranch: string;
  candidateSha: string;
  candidateTree: string;
  provider: PublishProvider;
  project: string;
  title: string;
  body: string;
  proof: ProofPayload;
  command?: readonly string[];
  commandCwd?: string;
  commandEnv?: Record<string, string>;
}

export interface PublishResult {
  evidence: PublishEvidence;
  provider: PublishProvider;
  candidateSha: string;
  candidateTree: string;
  verified: true;
  branch: string;
  remoteRef: string;
  publishedHeadSha: string;
  requestId: string | null;
  requestUrl: string | null;
  action: "created" | "updated" | "pushed";
}

export interface IntegrateOptions {
  cwd: string;
  ownershipId?: string;
  remote: string;
  integrationBranch: string;
  expectedBaseSha: string;
  candidateSha: string;
  candidateTree: string;
  message: string;
  proof: ProofPayload;
  staging: StagingPayload;
  authorAcceptance: string;
  author?: GitIdentity;
  postIntegrationCommands?: string[];
  outputLimit?: number;
  env?: NodeJS.ProcessEnv;
}

export interface IntegrateResult {
  baseSha: string;
  candidateSha: string;
  candidateTree: string;
  integratedSha: string;
  integratedTree: string;
  remoteRef: string;
  postIntegrationVerification: VerifyResult | null;
  integration: IntegrationEvidence;
}

export interface WorkspaceCleanupOptions {
  cwd: string;
  ownershipId?: string;
  expectedHeadSha?: string;
  deliveredSha?: string;
}

export interface WorkspaceCleanupResult {
  path: string;
  branch: string;
  headSha: string;
  markerPath: string;
  delivery: "integrated-tree";
}

export interface OwnershipMarker {
  schema: 1;
  owner: "poiesis";
  ownershipId: string;
  specId: string;
  repositoryRoot: string;
  workspacePath: string;
  branch: string;
  remote: string;
  integrationBranch: string;
  baseSha: string;
}

/**
 * Spec #168 / ticket #169 — the shared lifecycle authority result.
 *
 * Every project-bound lifecycle operation on a prepared, Poiesis-owned
 * candidate workspace resolves its authoritative manifest / config / runtime
 * identity through the PRIMARY receipt-authenticated installation, never
 * through the candidate's own generated `.poiesis/config.jsonc` (which is
 * stale the moment the workspace is prepared and may even be committed into
 * the candidate tree).
 *
 * `candidateRoot` is the canonical workspace the command executes in; every
 * other field is the PRIMARY installation's authority. `marker` is `null`
 * exactly when `candidateRoot` IS the primary checkout — the primary owns no
 * Poiesis workspace marker, which is the pre-existing primary-checkout
 * compatibility surface.
 */
export interface LifecycleAuthority {
  /** Canonical workspace the command executes in. */
  candidateRoot: string;
  /** Canonical shared Git common directory of the repository. */
  commonDir: string;
  /** Absolute path of the immutable ownership marker, or `null` on the primary checkout. */
  markerPath: string | null;
  /** The immutable ownership marker record, or `null` on the primary checkout. */
  marker: OwnershipMarker | null;
  /** Canonical primary checkout that owns the installation. */
  primaryRoot: string;
  /** Receipt-authenticated ownership receipt of the PRIMARY installation. */
  receipt: OwnershipReceipt;
  /** Receipt-authenticated manifest of the PRIMARY installation. */
  manifest: Manifest;
  /** Runtime identity the PRIMARY installation is bound to. */
  runtime: string;
}

/** A `LifecycleAuthority` that is proven to own a Poiesis candidate workspace. */
interface OwnedCandidateAuthority extends LifecycleAuthority {
  markerPath: string;
  marker: OwnershipMarker;
}

/**
 * Spec #168 / ticket #172 — the observable, read-only state of a workspace
 * a check ran against. Every field is evidence: `null` means "could not be
 * proven", never "absent".
 */
export interface WorktreeStateFingerprint {
  /** Canonical workspace the reading was taken from. */
  root: string;
  head: string | null;
  tree: string | null;
  dirty: boolean;
  changedFiles: string[];
  /**
   * The changed-path LIST was bounded for evidence. A different fact from
   * {@link statusCaptureTruncated}: everything below was read, and only this
   * list was shortened.
   */
  changedFilesTruncated: boolean;
  /**
   * Spec #168 / ticket #179 — the status BYTES themselves were cut short by the
   * process runner's capture bound, so the workspace was not read whole and
   * more changed paths exist beyond this reading than the list can show.
   *
   * This is the only field of the three that means "state nobody observed".
   * `changedFiles` and `pathDigests` below are derived exclusively from whole
   * porcelain records, so neither can contain a path the bound cut in half.
   */
  statusCaptureTruncated: boolean;
  /**
   * Bounded per-path content digests for the changed paths.
   *
   * Without these, editing the CONTENTS of an already-dirty file leaves
   * `head`, `tree`, `dirty`, and `changedFiles` all identical, so a changed
   * state would be indistinguishable from an unchanged one.
   */
  pathDigests: WorktreePathDigest[];
  /**
   * The digest LIST was bounded by its own path count, not by how much of the
   * status was read.
   */
  pathDigestsTruncated: boolean;
}

/**
 * One changed path's content digest.
 *
 * `blob` is Git's own object id for the path's CURRENT worktree contents —
 * the same digest family Git already stores in the index, trees, and the
 * #171 verification receipt's `candidateTree`. It is a content digest, not
 * content: it reveals no file bytes and no secret, and it is stable for
 * identical bytes and different for different bytes.
 *
 * `absent` marks a changed path that no longer exists on disk (a deletion).
 * It is deliberately NOT a valid object id, so a deleted path can never
 * collide with a present one and two distinct states cannot collapse into one
 * fingerprint input.
 */
export interface WorktreePathDigest {
  path: string;
  blob: string;
}

/**
 * How many changed paths get a content digest.
 *
 * Bounded on purpose: each digest costs one Git invocation, and a state
 * fingerprint is evidence, not an exhaustive manifest. Beyond this bound the
 * digests are partial and `pathDigestsTruncated` says so, so a caller can
 * tell "unchanged" from "not fully observed".
 */
const MAX_PATH_DIGESTS = 16;

/** Digest recorded for a changed path that does not exist on disk. */
const ABSENT_PATH_DIGEST = "absent";

/**
 * Read one changed path's content digest.
 *
 * `--no-filters` keeps the digest a pure function of the bytes on disk, so a
 * `.gitattributes` clean/smudge filter can never make the fingerprint depend
 * on the local Git configuration. The path is passed after `--`, so a
 * repository-supplied path can never be read as an option. A path Git
 * refuses (deleted, unreadable) records the explicit `absent` sentinel rather
 * than an empty string, which would collide with other states.
 */
async function readPathContentDigest(root: string, path: string): Promise<string> {
  const result = await run("git", ["hash-object", "--no-filters", "--", path], {
    cwd: root,
    allowFailure: true,
  });
  const blob = result.exitCode === 0 ? result.stdout.trim() : "";
  return SHA_PATTERN.test(blob) ? blob : ABSENT_PATH_DIGEST;
}

export async function inspect(options: InspectOptions): Promise<InspectResult> {
  const root = await canonicalGitRoot(options.cwd);
  const commonDir = await gitCommonDir(root);
  const outputLimit = normalizeOutputLimit(options.outputLimit);
  const headResult = await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    allowFailure: true,
  });
  const branchResult = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: root,
    allowFailure: true,
  });
  const status = await gitStatus(root);
  const branchList = await run(
    "git",
    ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"],
    { cwd: root },
  );
  const remoteList = await run("git", ["remote"], { cwd: root });
  const remotes: GitRemote[] = [];
  for (const name of nonemptyLines(remoteList.stdout)) {
    const fetchUrls = await run("git", ["remote", "get-url", "--all", name], { cwd: root });
    const pushUrls = await run("git", ["remote", "get-url", "--push", "--all", name], { cwd: root });
    remotes.push({
      name,
      fetchUrls: nonemptyLines(fetchUrls.stdout),
      pushUrls: nonemptyLines(pushUrls.stdout),
    });
  }

  let integrationBase: string | null = null;
  if (options.remote !== undefined || options.integrationBranch !== undefined) {
    invariant(
      options.remote !== undefined && options.integrationBranch !== undefined,
      "INCOMPLETE_INTEGRATION_TARGET",
      "Both remote and integrationBranch are required to inspect an integration base",
    );
    await validateRemote(root, options.remote);
    await validateBranchName(root, options.integrationBranch);
    const reference = remoteTrackingRef(options.remote, options.integrationBranch);
    const resolved = await run("git", ["rev-parse", "--verify", `${reference}^{commit}`], {
      cwd: root,
      allowFailure: true,
    });
    integrationBase = resolved.exitCode === 0 && SHA_PATTERN.test(resolved.stdout) ? resolved.stdout : null;
  }

  const changedFiles = parseStatusPaths(status);
  return {
    root,
    gitCommonDir: commonDir,
    head: headResult.exitCode === 0 && SHA_PATTERN.test(headResult.stdout) ? headResult.stdout : null,
    branch: branchResult.exitCode === 0 ? branchResult.stdout : null,
    clean: status.length === 0,
    changedFiles: changedFiles.slice(0, outputLimit),
    changedFilesTruncated: changedFiles.length > outputLimit,
    branches: nonemptyLines(branchList.stdout).map((line) => {
      const separator = line.indexOf("\0");
      invariant(separator > 0, "INVALID_GIT_OUTPUT", "Git returned an invalid branch record", {
        record: bounded(line),
      });
      return { name: line.slice(0, separator), sha: line.slice(separator + 1) };
    }),
    remotes,
    worktrees: await listWorktrees(root),
    integrationBase,
  };
}

export async function workspacePrepare(options: WorkspacePrepareOptions): Promise<WorkspaceIdentity> {
  validateText(options.specId, "specId");
  const root = await canonicalGitRoot(options.cwd);
  // Spec #104 / ticket #106: pre-mutation runtime identity guard. The
  // shared seam in `maintenance.ts` is reached via a delayed dynamic
  // import to avoid a top-level circular import between this module and
  // `maintenance.ts`. The guard fails closed with `RUNTIME_VERSION_MISMATCH`
  // before any ownership marker / branch / worktree side effect runs.
  await (await import("./maintenance.js")).assertRuntimeVersionMatchesProject(root);
  await validateRemote(root, options.remote);
  await validateBranchName(root, options.integrationBranch);
  await validateBranchName(root, options.branch);
  invariant(
    options.branch !== options.integrationBranch,
    "INTEGRATION_BRANCH_FORBIDDEN",
    "The Poiesis change branch must differ from the integration branch",
    { branch: options.branch },
  );

  const baseSha = await fetchIntegrationBase(root, options.remote, options.integrationBranch);
  const workspacePath = options.workspacePath !== undefined
    ? await canonicalProspectivePath(options.workspacePath)
    : await deriveDefaultWorkspacePath(root, options.specId, options.branch);
  const commonDir = await gitCommonDir(root);
  const markers = await readMarkers(commonDir);
  invariant(
    !markers.some(({ marker }) => marker.specId === options.specId),
    "SPEC_WORKSPACE_COLLISION",
    "A Poiesis workspace already exists for this Spec",
    { specId: options.specId },
  );
  invariant(
    !markers.some(({ marker }) => marker.branch === options.branch || marker.workspacePath === workspacePath),
    "OWNED_WORKSPACE_COLLISION",
    "The requested branch or path belongs to another Poiesis workspace",
    { branch: options.branch, workspacePath },
  );
  invariant(!(await pathExists(workspacePath)), "WORKSPACE_PATH_COLLISION", "Workspace path already exists", {
    workspacePath,
  });

  const branchExists = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`], {
    cwd: root,
    allowFailure: true,
  });
  invariant(branchExists.exitCode !== 0, "BRANCH_COLLISION", "Local branch already exists", {
    branch: options.branch,
  });
  const remoteBranch = await lsRemoteHead(root, options.remote, options.branch);
  invariant(remoteBranch === null, "REMOTE_BRANCH_COLLISION", "Remote branch already exists", {
    branch: options.branch,
    sha: remoteBranch,
  });

  const worktrees = await listWorktrees(root);
  // The primary checkout (root) is always listed by `git worktree list`.
  // A default-path workspace is intentionally nested inside
  // `<root>/.poiesis/workspaces/`, so we must not treat that nesting
  // as a worktree collision against the primary checkout. The nested
  // area is reserved for Poiesis; only non-primary worktrees that
  // overlap the workspace path are real collisions.
  const nestedInProjectWorkspaces = isWithin(
    join(root, ".poiesis", "workspaces"),
    workspacePath,
  );
  invariant(
    !worktrees.some(
      (worktree) =>
        worktree.branch === options.branch ||
        worktree.path === workspacePath ||
        (!nestedInProjectWorkspaces && isWithin(worktree.path, workspacePath)) ||
        isWithin(workspacePath, worktree.path),
    ),
    "WORKTREE_COLLISION",
    "Requested workspace collides with an existing Git worktree",
    { branch: options.branch, workspacePath },
  );

  const ownershipId = randomUUID();
  const marker: OwnershipMarker = {
    schema: 1,
    owner: "poiesis",
    ownershipId,
    specId: options.specId,
    repositoryRoot: root,
    workspacePath,
    branch: options.branch,
    remote: options.remote,
    integrationBranch: options.integrationBranch,
    baseSha,
  };
  const markerPath = await createMarker(commonDir, marker);
  try {
    await run(
      "git",
      ["worktree", "add", "--no-track", "-b", options.branch, workspacePath, baseSha],
      { cwd: root },
    );
    const createdRoot = await canonicalGitRoot(workspacePath);
    invariant(createdRoot === workspacePath, "WORKSPACE_PATH_MISMATCH", "Git created the worktree at an unexpected path", {
      expected: workspacePath,
      actual: createdRoot,
    });
    const state = await assertExactClean(workspacePath, baseSha);
    const branch = await currentBranch(workspacePath);
    invariant(branch === options.branch, "WORKSPACE_BRANCH_MISMATCH", "Git created an unexpected workspace branch", {
      expected: options.branch,
      actual: branch,
    });
    return {
      root,
      path: workspacePath,
      branch: options.branch,
      specId: options.specId,
      ownershipId,
      markerPath,
      remote: options.remote,
      integrationBranch: options.integrationBranch,
      baseSha,
      headSha: state.sha,
    };
  } catch (error) {
    let pathPresent = await pathExists(workspacePath);
    if (pathPresent) {
      const candidateRoot = await canonicalGitRoot(workspacePath).catch(() => null);
      const candidateCommonDir =
        candidateRoot === null ? null : await gitCommonDir(candidateRoot).catch(() => null);
      const candidateHead =
        candidateRoot === null ? null : await resolveCommit(candidateRoot, "HEAD").catch(() => null);
      const status = candidateRoot === null ? ["unknown"] : await gitStatus(candidateRoot).catch(() => ["unknown"]);
      if (candidateRoot === workspacePath && candidateCommonDir === commonDir && candidateHead === baseSha && status.length === 0) {
        const removed = await run("git", ["worktree", "remove", workspacePath], {
          cwd: root,
          allowFailure: true,
        });
        pathPresent = removed.exitCode !== 0;
      }
    }
    const branchRef = `refs/heads/${options.branch}`;
    const branchSha = await run("git", ["rev-parse", "--verify", `${branchRef}^{commit}`], {
      cwd: root,
      allowFailure: true,
    });
    let branchPresent = branchSha.exitCode === 0;
    if (!pathPresent && branchPresent && branchSha.stdout === baseSha) {
      const deleted = await run("git", ["update-ref", "-d", branchRef, baseSha], {
        cwd: root,
        allowFailure: true,
      });
      branchPresent = deleted.exitCode !== 0;
    }
    const rolledBack = !pathPresent && !branchPresent;
    if (rolledBack) await rm(markerPath, { force: true });
    throw error;
  }
}

export async function checkpoint(options: CheckpointOptions): Promise<CheckpointResult> {
  validateAcceptedReview(options.review);
  validateText(options.message, "message");
  // Spec #168 / ticket #169: the shared lifecycle authority. The immutable
  // ownership marker identifies the PRIMARY checkout that owns this
  // workspace; the manifest / receipt / runtime identity all come from
  // there, never from the candidate's own generated config. The staging
  // and commit still happen in the candidate workspace itself.
  const owned = await resolveOwnedCandidateAuthority(options.cwd, options.ownershipId);
  const branch = await assertOwnedBranch(owned);
  const paths = normalizeExplicitPaths(owned.candidateRoot, options.paths);
  const statusBefore = await gitStatus(owned.candidateRoot);
  invariant(statusBefore.length > 0, "NO_CHECKPOINT_CHANGES", "Workspace contains no changes to checkpoint");
  const stagedBefore = await run("git", ["diff", "--cached", "--quiet", "--exit-code"], {
    cwd: owned.candidateRoot,
    allowFailure: true,
  });
  invariant(stagedBefore.exitCode === 0, "PREEXISTING_STAGED_CHANGES", "Refusing to mix preexisting staged changes into a checkpoint");
  const changedPaths = parseStatusPaths(statusBefore);
  invariant(
    changedPaths.every((changedPath) => paths.some((path) => pathCovers(path, changedPath))),
    "DIRTY_CHECKPOINT_RESIDUE",
    "Refusing to checkpoint with unstaged or untracked residue",
    { changedPaths, allowed: paths },
  );
  await run("git", ["add", "--", ...paths], { cwd: owned.candidateRoot });
  const residueAfterStage = parseStatusPaths(await gitStatus(owned.candidateRoot));
  invariant(
    residueAfterStage.every((changedPath) => paths.some((path) => pathCovers(path, changedPath))),
    "CHECKPOINT_PATH_ESCAPE",
    "Staging introduced paths outside the accepted set",
    { staged: residueAfterStage, allowed: paths },
  );
  const stagedNames = (
    await run("git", ["diff", "--cached", "--name-only", "-z", "--", ...paths], { cwd: owned.candidateRoot })
  ).stdout.split("\0").filter(Boolean);
  invariant(stagedNames.length > 0, "NO_CHECKPOINT_CHANGES", "Explicit checkpoint paths contain no changes", { paths });
  try {
    const commitEnvironment = {
      ...identityEnvironment(options.author),
      POIESIS_CHECKPOINT: "1",
    };
    const commit = await run("git", ["commit", "-m", options.message], {
      cwd: owned.candidateRoot,
      allowFailure: true,
      env: commitEnvironment,
    });
    if (commit.exitCode !== 0) {
      throw new PoiesisError("CHECKPOINT_COMMIT_FAILED", "Git could not create the accepted checkpoint", {
        exitCode: commit.exitCode,
        stdout: bounded(commit.stdout),
        stderr: bounded(commit.stderr),
      });
    }
    const sha = await resolveCommit(owned.candidateRoot, "HEAD");
    const postStatus = parseStatusPaths(await gitStatus(owned.candidateRoot));
    invariant(postStatus.length === 0, "POST_CHECKPOINT_RESIDUE", "Checkpoint created additional unstaged residue", {
      postStatus,
    });
    return { sha, branch, paths: stagedNames, review: options.review };
  } finally {
    await run("git", ["reset", "--mixed", "HEAD", "--", ...paths], { cwd: owned.candidateRoot, allowFailure: true });
  }
}

export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  validateSha(options.candidateSha, "candidateSha");
  invariant(options.commands.length > 0, "NO_VERIFICATION_COMMANDS", "At least one verification command is required");
  for (const command of options.commands) validateText(command, "verification command");
  // Spec #168 / ticket #169: resolve the shared lifecycle authority BEFORE
  // any command runs. The manifest / receipt / runtime identity come from
  // the PRIMARY receipt-authenticated installation, so a stale or
  // candidate-tracked generated config can never be lifecycle authority.
  // The commands themselves still execute in the exact candidate workspace.
  const authority = await resolveVerifyAuthority(options.cwd, options.ownershipId);
  const outcome = await runVerification(options, options.cwd, options.ownershipId ?? null);
  // Spec #168 / ticket #171: proof-scope Verify issues the runtime-owned
  // receipt that Publish later resolves. A failed run still records its real
  // evidence (outcome `failed`, per-command classification), because a receipt
  // that could only ever say "verified" would be a constant, not evidence.
  // The compatibility surface — a repository that never installed Poiesis —
  // has no installation identity to bind and therefore issues no receipt.
  let verification: VerificationEvidence | null = null;
  let receiptFailure: unknown = null;
  // Spec #168 / ticket #176: a cancelled Verify did not complete the plan, so
  // it must not mint an authoritative receipt. A receipt is Publish's proof
  // that the exact candidate was verified; one issued for a plan that was cut
  // short would say something the run never established. The cancellation is
  // therefore the reported outcome, and nothing is persisted for it.
  if (authority !== null && !outcome.cancelled) {
    try {
      verification = verificationEvidenceFrom(
        await createVerificationReceipt({
          authority,
          ...outcome.execution,
        }),
      );
    } catch (error) {
      receiptFailure = error;
    }
  }
  // The verification failure is the operator's actionable error and is never
  // masked by a secondary receipt-storage failure. When a receipt WAS issued
  // for the failed run, its reference rides along in the error details so the
  // operator (and a later Publish attempt) can see the real evidence instead of
  // a bare exit code.
  if (outcome.failure !== null) {
    if (verification !== null && outcome.failure instanceof PoiesisError) {
      outcome.failure.details.verification = verification;
    }
    throw outcome.failure;
  }
  if (receiptFailure !== null) throw receiptFailure;
  return { ...outcome.result, verification };
}

/**
 * Spec #168 / ticket #171 — one completed Verify execution: the public result
 * plus the complete, receipt-bound evidence the issuer records.
 */
interface VerificationOutcome {
  result: VerifyResult;
  execution: {
    candidateSha: string;
    candidateTree: string;
    plan: string[];
    timeoutMs: number;
    outputLimit: number;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    commands: VerificationCommandEvidenceV1[];
    cleanAfter: boolean;
    outcome: "verified" | "failed";
  };
  /** The deterministic failure of a completed run, or `null` when it passed. */
  failure: unknown | null;
  /**
   * Spec #168 / ticket #176 — the run ended because the caller cancelled it,
   * so the plan did not complete and no receipt may be issued for it.
   */
  cancelled: boolean;
}

/**
 * Spec #168 / ticket #169 — the verification body, split out so
 * `integrate`'s post-integration verification can run the SAME commands
 * against its temporary detached worktree. That worktree is not itself a
 * Poiesis-owned workspace and therefore cannot resolve an authority of its
 * own; `integrate` already resolved and authenticated the candidate's
 * authority before the integration side effects ran. Keeping the bypass
 * module-private (instead of a public `VerifyOptions` field) means no
 * external caller can hand `verify` a forged authority and skip the
 * ownership / receipt / runtime identity boundary.
 *
 * Spec #168 / ticket #171: the body returns its full per-command evidence and
 * the deterministic failure instead of throwing mid-loop, so the caller can
 * persist a faithful receipt for a run that FAILED. Pre-flight failures
 * (unresolvable candidate, dirty before) still throw: they never reached a
 * deterministic execution and no receipt exists for them.
 */
async function runVerification(
  options: VerifyOptions,
  cwd: string,
  workspaceOwnershipId: string | null,
): Promise<VerificationOutcome> {
  const root = await canonicalGitRoot(cwd);
  const candidateSha = await resolveExpectedCommit(root, options.candidateSha, "candidateSha");
  await assertExactClean(root, candidateSha);
  const outputLimit = normalizeOutputLimit(options.outputLimit);
  const startedAtMs = Date.now();
  const results: VerifyCommandResult[] = [];
  const commands: VerificationCommandEvidenceV1[] = [];
  let failed: VerifyCommandResult | null = null;

  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  // run() only rejects after it has terminated the spawned process tree
  // (see process.ts settle()). The workspace state is therefore safe to
  // observe immediately after a rejection, so the exact-SHA clean-after
  // check below can run unconditionally.
  let runError: unknown = null;
  for (const command of options.commands) {
    const commandStartedAtMs = Date.now();
    let result: RunResult;
    try {
      // Spec #168 / ticket #176: the plan runs through the one managed
      // command-processor + strong-containment seam shared with focused checks,
      // so a verification command can never drift onto a different interpreter
      // or run outside the boundary Poiesis claims for arbitrary command text.
      result = await runManagedShellCommand({
        cwd: root,
        command,
        allowFailure: true,
        timeoutMs,
        // Spec #168 / ticket #183: the same evidence limit this Verify applies
        // to the receipt it is about to write, declared to the runner as well.
        // A command that ends in a typed rejection has no settled result, so the
        // runner's error details are the only copy of its output — and an
        // envelope that bounded below the requested limit would make a larger
        // requested limit unreachable for exactly the commands that failed.
        outputLimit,
        // Spec #168 / ticket #170: verification commands run under a
        // transient managed process lease, so a verify command that leaks
        // a background descendant is cleaned before the exact-SHA
        // clean-after check observes the workspace. The lease names this
        // operation and, when the caller proved one, the workspace that
        // owns it; it is in-memory only and never persisted.
        operationId: "poiesis-verify",
        ...(workspaceOwnershipId === null ? {} : { workspaceId: workspaceOwnershipId }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      runError = error;
      // Spec #168 / ticket #171: the timed-out / unspawnable command is still
      // recorded, with the classification the runner actually reported, so a
      // receipt never silently drops the command that ended the run.
      commands.push(failedCommandEvidence(command, error, commandStartedAtMs, timeoutMs, outputLimit));
      break;
    }
    const evidence = {
      command,
      exitCode: result.exitCode,
      stdout: bounded(result.stdout, outputLimit),
      stderr: bounded(result.stderr, outputLimit),
    };
    results.push(evidence);
    const stdoutTruncated = result.stdoutTruncated || evidence.stdout !== result.stdout;
    const stderrTruncated = result.stderrTruncated || evidence.stderr !== result.stderr;
    commands.push({
      command,
      status: result.exitCode === 0 ? "passed" : "failed",
      classification: result.exitCode === 0 ? "passed" : "command-failed",
      exitCode: result.exitCode,
      signal: result.signal,
      startedAt: new Date(commandStartedAtMs).toISOString(),
      endedAt: new Date(commandStartedAtMs + result.durationMs).toISOString(),
      durationMs: result.durationMs,
      timeoutMs,
      timedOut: result.timedOut,
      stdout: evidence.stdout,
      stderr: evidence.stderr,
      stdoutTruncated,
      stderrTruncated,
      outputTruncated: stdoutTruncated || stderrTruncated,
    });
    if (result.exitCode !== 0) {
      failed = evidence;
      break;
    }
  }

  // Exact-SHA clean-after must always run, even after a run() rejection or a
  // non-zero exit. The verify invocation is the only writer of the candidate
  // workspace, so any residue is the deterministic footprint of the verify
  // command. A non-empty residue fails closed with DIRTY_CANDIDATE
  // regardless of how the loop ended; otherwise the original COMMAND_TIMEOUT
  // or VERIFICATION_FAILED is preserved unchanged.
  let dirtyStatus: string[] | null = null;
  try {
    await assertExactClean(root, candidateSha);
  } catch (cleanError) {
    if (cleanError instanceof PoiesisError && cleanError.code === "DIRTY_CANDIDATE") {
      const status = cleanError.details.status;
      dirtyStatus = Array.isArray(status) ? (status as string[]) : [];
    } else {
      throw cleanError;
    }
  }
  const endedAtMs = Date.now();
  const cleanAfter = dirtyStatus === null;
  const verified = cleanAfter && runError === null && failed === null;
  const execution: VerificationOutcome["execution"] = {
    candidateSha,
    candidateTree: await resolveTree(root, candidateSha),
    plan: [...options.commands],
    timeoutMs,
    outputLimit,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    commands,
    cleanAfter,
    outcome: verified ? "verified" : "failed",
  };

  let failure: unknown | null = null;
  // Spec #168 / ticket #176: a Verify is cancelled when it did not complete AND
  // the caller declared cancellation. Both facts are needed: the runner's own
  // `COMMAND_CANCELLED` proves it for a plain cancellation, but a cleanup
  // failure outranks that rejection and would otherwise hide a cancelled,
  // incomplete run behind a receipt it must never get.
  const callerCancelled = options.signal?.aborted === true;
  const runCancelled =
    runError instanceof PoiesisError && runError.code === "COMMAND_CANCELLED" && runError.exitCode === 130;
  const cancelled = !verified && (callerCancelled || runCancelled);
  if (dirtyStatus !== null) {
    failure = new PoiesisError(
      "DIRTY_CANDIDATE",
      "Verify invocation left the exact candidate workspace dirty",
      {
        candidateSha,
        commands: results,
        runError: runError === null ? null : errorForEvidence(runError),
        status: dirtyStatus.map(statusEntryForEvidence),
      },
    );
  } else if (runError !== null) {
    failure = runError;
  } else if (failed !== null) {
    failure = new PoiesisError("VERIFICATION_FAILED", "A configured verification command failed", {
      candidateSha,
      failed,
      commands: results,
    });
  }
  return {
    result: { candidateSha, cleanBefore: true, cleanAfter: true, commands: results, verification: null },
    execution,
    failure,
    cancelled,
  };
}

/**
 * Spec #168 / ticket #171 — the per-command record for a command whose runner
 * never produced a settled `RunResult`. The typed `COMMAND_TIMEOUT` /
 * `COMMAND_CANCELLED` errors carry the executor's own duration and truncation
 * fidelity, so a timed-out command is recorded as a timeout rather than being
 * dropped from the receipt.
 *
 * Spec #168 / ticket #183 — the runner's envelope bound and this record's own
 * `outputLimit` are BOTH facts about truncation, and a command that never
 * settled has no `RunResult` to compare against. So the record ORs the runner's
 * reported flag with the fact that its own bound is what shortened the text: a
 * receipt that held 500 bytes of 7,000 and claimed complete output is exactly
 * the false evidence Publish later reads.
 */
function failedCommandEvidence(
  command: string,
  error: unknown,
  startedAtMs: number,
  timeoutMs: number,
  outputLimit: number,
): VerificationCommandEvidenceV1 {
  const details = error instanceof PoiesisError ? error.details : {};
  const timedOut = error instanceof PoiesisError && error.code === "COMMAND_TIMEOUT";
  // A timeout is its own classification; every other rejection means the runner
  // never produced a settled result for this command.
  const classification: VerificationCommandClassification = timedOut ? "timeout" : "spawn-error";
  const durationMs = typeof details.durationMs === "number" ? details.durationMs : Math.max(0, Date.now() - startedAtMs);
  const stdoutBound = boundedOutput(typeof details.stdout === "string" ? details.stdout : "", outputLimit);
  const stderrBound = boundedOutput(typeof details.stderr === "string" ? details.stderr : "", outputLimit);
  const stdoutTruncated = details.stdoutTruncated === true || stdoutBound.clipped;
  const stderrTruncated = details.stderrTruncated === true || stderrBound.clipped;
  return {
    command,
    status: "failed",
    classification,
    exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
    signal: typeof details.signal === "string" ? details.signal : null,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(startedAtMs + durationMs).toISOString(),
    durationMs,
    timeoutMs,
    timedOut,
    stdout: stdoutBound.text,
    stderr: stderrBound.text,
    stdoutTruncated,
    stderrTruncated,
    outputTruncated: stdoutTruncated || stderrTruncated,
  };
}

export async function publish(options: PublishOptions): Promise<PublishResult> {
  validateText(options.project, "project");
  validateText(options.title, "title");
  validateText(options.body, "body");
  validateSha(options.candidateSha, "candidateSha");
  // Spec #168 / ticket #169: the shared lifecycle authority. Validates the
  // immutable ownership marker, then the PRIMARY receipt-authenticated
  // manifest / receipt / runtime identity, before any push or
  // change-request side effect.
  const owned = await resolveOwnedCandidateAuthority(options.cwd, options.ownershipId);
  const branch = await assertOwnedBranch(owned);
  invariant(options.remote === owned.marker.remote, "WORKSPACE_REMOTE_MISMATCH", "Publish remote does not match workspace ownership", {
    expected: owned.marker.remote,
    actual: options.remote,
  });
  invariant(
    options.integrationBranch === owned.marker.integrationBranch,
    "WORKSPACE_INTEGRATION_BRANCH_MISMATCH",
    "Publish target does not match workspace ownership",
    { expected: owned.marker.integrationBranch, actual: options.integrationBranch },
  );
  await validateRemote(owned.candidateRoot, options.remote);
  await validateBranchName(owned.candidateRoot, options.integrationBranch);
  const candidateSha = await resolveExpectedCommit(owned.candidateRoot, options.candidateSha, "candidateSha");
  await assertExactClean(owned.candidateRoot, candidateSha);
  const candidateTree = await resolveTree(owned.candidateRoot, candidateSha);
  invariant(candidateTree === options.candidateTree, "CANDIDATE_TREE_MISMATCH", "Provided candidate tree does not match repository", {
    expected: candidateTree,
    provided: options.candidateTree,
  });
  validateProofEvidence(options.proof, candidateSha, candidateTree);
  // Spec #168 / ticket #171: resolve the runtime-owned verification receipt.
  // `proof.verified` is a claim; the stored receipt is the evidence. Publish
  // reads the receipt the caller named and revalidates EVERY binding against
  // live authority, the live verification plan of the PRIMARY installation,
  // and the live candidate BEFORE any push happens.
  const receipt = await resolveVerificationReceipt({
    authority: owned,
    reference: options.proof.verification,
    candidateSha,
    candidateTree,
    plan: await resolveLiveVerificationPlan(owned.primaryRoot),
  });

  const remoteRef = `refs/heads/${branch}`;
  const expectedRemote = await lsRemoteHead(owned.candidateRoot, options.remote, branch);
  if (expectedRemote !== null) {
    const localIsAncestor = await run(
      "git",
      ["merge-base", "--is-ancestor", expectedRemote, candidateSha],
      { cwd: owned.candidateRoot, allowFailure: true },
    );
    if (localIsAncestor.exitCode !== 0) {
      throw new PoiesisError(
        "PUBLISHED_BRANCH_DIVERGED",
        "Remote change branch contains work that is not an ancestor of the local candidate; refusing to overwrite",
        { remote: options.remote, branch, remoteHead: expectedRemote, candidateSha },
      );
    }
  }
  await run("git", ["push", "--porcelain", options.remote, `${candidateSha}:${remoteRef}`], { cwd: owned.candidateRoot });
  const publishedSha = await lsRemoteHead(owned.candidateRoot, options.remote, branch);
  invariant(publishedSha === candidateSha, "PUBLISHED_SHA_MISMATCH", "Remote branch does not identify the exact candidate", {
    expected: candidateSha,
    actual: publishedSha,
  });
  await assertExactClean(owned.candidateRoot, candidateSha);

  let providerCompletion: ProviderCompletion;
  if (options.provider === "fixture") {
    providerCompletion = {
      requestId: null,
      requestUrl: null,
      action: expectedRemote === null ? "pushed" : "updated",
    };
  } else if (options.provider === "github") {
    providerCompletion = await publishGitHub(options, branch, candidateSha, remoteRef, owned.candidateRoot, expectedRemote === null);
  } else if (options.provider === "gitlab") {
    providerCompletion = await publishGitLab(options, branch, candidateSha, remoteRef, owned.candidateRoot, expectedRemote === null);
  } else {
    providerCompletion = await publishCommand(
      options,
      branch,
      candidateSha,
      remoteRef,
      owned.candidateRoot,
      expectedRemote === null,
    );
  }

  const evidence: PublishEvidence = {
    candidateSha,
    candidateTree,
    verified: true,
    branch,
    remoteRef,
    publishedHeadSha: publishedSha,
    provider: options.provider,
    action: providerCompletion.action,
    changeRequest: {
      id: providerCompletion.requestId,
      url: providerCompletion.requestUrl,
    },
    // The receipt identity is re-derived from the STORED document Publish just
    // resolved, so the evidence a caller forwards to Preview names exactly
    // what this process proved.
    verification: verificationEvidenceFrom(receipt),
  };
  validatePublishEvidence(evidence, candidateSha, candidateTree, branch, remoteRef);

  return {
    evidence,
    provider: options.provider,
    candidateSha,
    candidateTree,
    verified: true,
    branch,
    remoteRef,
    publishedHeadSha: publishedSha,
    requestId: providerCompletion.requestId,
    requestUrl: providerCompletion.requestUrl,
    action: providerCompletion.action,
  };
}

interface ProviderCompletion {
  requestId: string | null;
  requestUrl: string | null;
  action: "created" | "updated" | "pushed";
}

export async function integrate(options: IntegrateOptions): Promise<IntegrateResult> {
  validateSha(options.expectedBaseSha, "expectedBaseSha");
  validateSha(options.candidateSha, "candidateSha");
  validateText(options.message, "message");
  validateText(options.authorAcceptance, "authorAcceptance");
  // Spec #168 / ticket #169: the shared lifecycle authority resolves the
  // immutable ownership marker plus the PRIMARY receipt-authenticated
  // manifest / receipt / runtime identity before any commit-tree /
  // fetch-base / push integration side effect.
  const owned = await resolveOwnedCandidateAuthority(options.cwd, options.ownershipId);
  await assertOwnedBranch(owned);
  invariant(options.remote === owned.marker.remote, "WORKSPACE_REMOTE_MISMATCH", "Integration remote does not match workspace ownership");
  invariant(
    options.integrationBranch === owned.marker.integrationBranch,
    "WORKSPACE_INTEGRATION_BRANCH_MISMATCH",
    "Integration branch does not match workspace ownership",
  );
  await validateRemote(owned.candidateRoot, options.remote);
  await validateBranchName(owned.candidateRoot, options.integrationBranch);
  const expectedBaseSha = await resolveExpectedCommit(owned.candidateRoot, options.expectedBaseSha, "expectedBaseSha");
  const candidateSha = await resolveExpectedCommit(owned.candidateRoot, options.candidateSha, "candidateSha");
  await assertExactClean(owned.candidateRoot, candidateSha);
  const candidateTree = await resolveTree(owned.candidateRoot, candidateSha);
  invariant(candidateTree === options.candidateTree, "CANDIDATE_TREE_MISMATCH", "Provided candidate tree does not match repository", {
    expected: candidateTree,
    provided: options.candidateTree,
  });
  validateProofEvidence(options.proof, candidateSha, candidateTree);
  validateStagingEvidence(options.staging, candidateSha, candidateTree);

  const fetchedBase = await fetchIntegrationBase(owned.candidateRoot, options.remote, options.integrationBranch);
  invariant(fetchedBase === expectedBaseSha, "STALE_INTEGRATION_BASE", "Remote integration base changed", {
    expected: expectedBaseSha,
    actual: fetchedBase,
  });
  const basedOnExpected = await run("git", ["merge-base", "--is-ancestor", expectedBaseSha, candidateSha], {
    cwd: owned.candidateRoot,
    allowFailure: true,
  });
  invariant(
    basedOnExpected.exitCode === 0,
    "CANDIDATE_BASE_MISMATCH",
    "Candidate is not based on the expected integration commit",
    { expectedBaseSha, candidateSha },
  );

  const publishedCandidate = await lsRemoteHead(owned.candidateRoot, options.remote, owned.marker.branch);
  invariant(
    publishedCandidate === candidateSha,
    "CANDIDATE_NOT_PUBLISHED",
    "Integration requires the exact proven candidate on the published change branch",
    { expected: candidateSha, actual: publishedCandidate },
  );
  const baseTree = await resolveTree(owned.candidateRoot, expectedBaseSha);
  invariant(candidateTree !== baseTree, "EMPTY_INTEGRATION", "Candidate tree is identical to the integration base");
  const commitEnvironment = identityEnvironment(options.author);
  const commit = await run("git", ["commit-tree", candidateTree, "-p", expectedBaseSha], {
    cwd: owned.candidateRoot,
    input: `${options.message}\n`,
    ...(commitEnvironment === undefined ? {} : { env: commitEnvironment }),
  });
  const integratedSha = commit.stdout;
  validateSha(integratedSha, "integratedSha");
  const integratedTree = await resolveTree(owned.candidateRoot, integratedSha);
  invariant(integratedTree === candidateTree, "INTEGRATED_TREE_MISMATCH", "Squash integration tree differs from candidate", {
    candidateTree,
    integratedTree,
  });

  await assertExactClean(owned.candidateRoot, candidateSha);
  let postIntegrationVerification: VerifyResult | null = null;
  if (options.postIntegrationCommands !== undefined && options.postIntegrationCommands.length > 0) {
    postIntegrationVerification = await verifyIntegratedCommit(
      owned,
      integratedSha,
      options.postIntegrationCommands,
      options.outputLimit,
      options.env,
    );
  }

  const remoteRef = `refs/heads/${options.integrationBranch}`;
  const remoteIntegrationHead = await lsRemoteHead(owned.candidateRoot, options.remote, options.integrationBranch);
  invariant(
    remoteIntegrationHead === expectedBaseSha,
    "INTEGRATION_BASE_DIVERGED",
    "Refusing to integrate: remote integration branch moved off the expected base",
    { expected: expectedBaseSha, actual: remoteIntegrationHead },
  );
  await run("git", ["push", "--porcelain", options.remote, `${integratedSha}:${remoteRef}`], { cwd: owned.candidateRoot });
  const remoteHead = await lsRemoteHead(owned.candidateRoot, options.remote, options.integrationBranch);
  invariant(remoteHead === integratedSha, "INTEGRATION_SHA_MISMATCH", "Remote integration branch has an unexpected revision", {
    expected: integratedSha,
    actual: remoteHead,
  });
  invariant((await resolveTree(owned.candidateRoot, integratedSha)) === candidateTree, "INTEGRATED_TREE_MISMATCH", "Integrated content changed unexpectedly");
  await assertExactClean(owned.candidateRoot, candidateSha);

  const integration: IntegrationEvidence = {
    candidateSha,
    candidateTree,
    integrationSha: integratedSha,
    integrationTree: integratedTree,
    contentMatchesCandidate: true,
  };
  validateIntegrationEvidence(integration, candidateSha, candidateTree);

  return {
    baseSha: expectedBaseSha,
    candidateSha,
    candidateTree,
    integratedSha,
    integratedTree,
    remoteRef,
    postIntegrationVerification,
    integration,
  };
}

export async function workspaceCleanup(options: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult> {
  // Spec #168 / ticket #169: the shared lifecycle authority resolves the
  // immutable ownership marker plus the PRIMARY receipt-authenticated
  // manifest / receipt / runtime identity before any branch / marker /
  // worktree teardown runs.
  const owned = await resolveOwnedCandidateAuthority(options.cwd, options.ownershipId);
  invariant(
    owned.marker.branch !== owned.marker.integrationBranch,
    "INTEGRATION_WORKSPACE_CLEANUP_FORBIDDEN",
    "Refusing to clean an integration branch workspace",
  );
  const branch = await assertOwnedBranch(owned);
  const headSha = await resolveCommit(owned.candidateRoot, "HEAD");
  if (options.expectedHeadSha !== undefined) {
    const expected = await resolveExpectedCommit(owned.candidateRoot, options.expectedHeadSha, "expectedHeadSha");
    invariant(headSha === expected, "WORKSPACE_HEAD_MISMATCH", "Workspace HEAD changed before cleanup", {
      expected,
      actual: headSha,
    });
  }
  const status = await gitStatus(owned.candidateRoot);
  invariant(status.length === 0, "DIRTY_WORKSPACE_CLEANUP_FORBIDDEN", "Refusing to clean a dirty or untracked workspace", {
    status: status.map(statusEntryForEvidence),
  });

  let delivery: WorkspaceCleanupResult["delivery"] | null = null;
  if (options.deliveredSha !== undefined) {
    validateSha(options.deliveredSha, "deliveredSha");
    const deliveredSha = await resolveExpectedCommit(owned.candidateRoot, options.deliveredSha, "deliveredSha");
    const fetchedIntegration = await fetchIntegrationBase(
      owned.candidateRoot,
      owned.marker.remote,
      owned.marker.integrationBranch,
    );
    const deliveredIsRemote = await run("git", ["merge-base", "--is-ancestor", deliveredSha, fetchedIntegration], {
      cwd: owned.candidateRoot,
      allowFailure: true,
    });
    const sameTree = (await resolveTree(owned.candidateRoot, deliveredSha)) === (await resolveTree(owned.candidateRoot, headSha));
    if (deliveredIsRemote.exitCode === 0 && sameTree) delivery = "integrated-tree";
  }
  invariant(
    delivery !== null,
    "UNDELIVERED_COMMITS",
    "Refusing to clean a workspace with unique undelivered commits",
    { branch, headSha },
  );

  const publishedHead = await lsRemoteHead(owned.candidateRoot, owned.marker.remote, branch);
  if (publishedHead !== null) {
    invariant(publishedHead === headSha, "REMOTE_BRANCH_CHANGED", "Published change branch changed before cleanup", {
      expected: headSha,
      actual: publishedHead,
    });
    const remoteRef = `refs/heads/${branch}`;
    await run("git", ["push", "--porcelain", owned.marker.remote, `:${remoteRef}`], { cwd: owned.candidateRoot });
    const verifyGone = await lsRemoteHead(owned.candidateRoot, owned.marker.remote, branch);
    invariant(
      verifyGone === null,
      "REMOTE_BRANCH_NOT_DELETED",
      "Remote change branch could not be removed",
      { branch, remote: owned.marker.remote, actual: verifyGone },
    );
  }

  await run("git", ["worktree", "remove", owned.candidateRoot], { cwd: owned.primaryRoot });
  const deleteRef = await run("git", ["update-ref", "-d", `refs/heads/${branch}`, headSha], {
    cwd: owned.primaryRoot,
    allowFailure: true,
  });
  invariant(deleteRef.exitCode === 0, "BRANCH_DELETE_FAILED", "Workspace was removed but its branch changed concurrently", {
    branch,
    headSha,
    stderr: bounded(deleteRef.stderr),
    markerPath: owned.markerPath,
  });
  await rm(owned.markerPath);
  return { path: owned.candidateRoot, branch, headSha, markerPath: owned.markerPath, delivery };
}

async function publishGitHub(
  options: PublishOptions,
  branch: string,
  candidateSha: string,
  remoteRef: string,
  cwd: string,
  _expectedBranchWasMissing: boolean,
): Promise<ProviderCompletion> {
  const listed = await run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      options.project,
      "--state",
      "open",
      "--head",
      branch,
      "--base",
      options.integrationBranch,
      "--json",
      "number,url,headRefOid,headRepository",
      "--limit",
      "100",
    ],
    { cwd },
  );
  const requests = parseJsonArray(listed.stdout, "GitHub pull request list");
  invariant(requests.length <= 1, "MULTIPLE_CHANGE_REQUESTS", "Multiple open pull requests match this branch and target");
  if (requests.length === 1) {
    const request = requests[0];
    const number = jsonIdentifier(request, "number", "GitHub pull request");
    invariant(
      jsonString(request, "headRefOid") === candidateSha,
      "CHANGE_REQUEST_OWNERSHIP_MISMATCH",
      "Existing GitHub pull request points at a different candidate",
      { expected: candidateSha, actual: jsonString(request, "headRefOid") },
    );
    assertHeadRepositoryOwnership(request, options.project);
    await run(
      "gh",
      [
        "pr",
        "edit",
        number,
        "--repo",
        options.project,
        "--base",
        options.integrationBranch,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      { cwd },
    );
    const verified = await verifyGitHubPullRequest(options, branch, candidateSha, cwd);
    invariant(
      verified !== null,
      "PUBLISH_PROVIDER_INCOMPLETE",
      "GitHub pull request edit did not produce a verifiable provider state",
      { number, project: options.project, branch },
    );
    return {
      requestId: number,
      requestUrl: jsonString(verified, "url") ?? null,
      action: "updated",
    };
  }
  const created = await run(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      options.project,
      "--head",
      branch,
      "--base",
      options.integrationBranch,
      "--title",
      options.title,
      "--body",
      options.body,
    ],
    { cwd },
  );
  const verified = await verifyGitHubPullRequest(options, branch, candidateSha, cwd);
  invariant(
    verified !== null,
    "PUBLISH_PROVIDER_INCOMPLETE",
    "GitHub pull request create did not produce a verifiable provider state",
    { project: options.project, branch, ghOutput: bounded(created.stdout) },
  );
  const verifiedNumber = jsonIdentifier(verified, "number", "GitHub pull request");
  return {
    requestId: verifiedNumber,
    requestUrl: jsonString(verified, "url") ?? extractUrl(created.stdout),
    action: "created",
  };
}

async function verifyGitHubPullRequest(
  options: PublishOptions,
  branch: string,
  candidateSha: string,
  cwd: string,
): Promise<Record<string, unknown> | null> {
  const listed = await run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      options.project,
      "--state",
      "open",
      "--head",
      branch,
      "--base",
      options.integrationBranch,
      "--json",
      "number,url,headRefOid,headRepository",
      "--limit",
      "100",
    ],
    { cwd },
  );
  const requests = parseJsonArray(listed.stdout, "GitHub pull request list");
  const matched = requests.find((entry) => jsonString(entry, "headRefOid") === candidateSha);
  if (matched === undefined) return null;
  if (!isJsonRecord(matched)) return null;
  // Ticket #77 — apply the same headRepository ownership check the
  // initial existing-PR lookup applies, so a final response whose
  // headRefOid matches the candidate but whose headRepository points
  // at a different non-empty repo fails closed instead of being
  // accepted purely on SHA match.
  assertHeadRepositoryOwnership(matched, options.project);
  return matched;
}

function assertHeadRepositoryOwnership(record: unknown, project: string): void {
  const headRepositoryRecord = isJsonRecord(record) && isJsonRecord(record.headRepository)
    ? record.headRepository
    : undefined;
  // gh pr list omits the headRepository object entirely (or returns
  // nameWithOwner as "") for same-repo PRs. Treat both as matching
  // the configured project; only fail closed when nameWithOwner is
  // present and differs from the configured project.
  const headRepository = headRepositoryRecord === undefined
    ? undefined
    : jsonString(headRepositoryRecord, "nameWithOwner");
  invariant(
    headRepository === undefined ||
      headRepository === "" ||
      headRepository === project,
    "CHANGE_REQUEST_OWNERSHIP_MISMATCH",
    "GitHub pull request comes from a different repository",
    { expected: project, actual: headRepository },
  );
}

async function publishGitLab(
  options: PublishOptions,
  branch: string,
  candidateSha: string,
  remoteRef: string,
  cwd: string,
  _expectedBranchWasMissing: boolean,
): Promise<ProviderCompletion> {
  const listed = await run(
    "glab",
    [
      "mr",
      "list",
      "--repo",
      options.project,
      "--source-branch",
      branch,
      "--target-branch",
      options.integrationBranch,
      "--output",
      "json",
    ],
    { cwd },
  );
  const requests = parseJsonArray(listed.stdout, "GitLab merge request list");
  invariant(requests.length <= 1, "MULTIPLE_CHANGE_REQUESTS", "Multiple open merge requests match this branch and target");
  if (requests.length === 1) {
    const request = requests[0];
    const headSha = jsonString(request, "sha") ?? jsonString(request, "head_sha");
    invariant(
      headSha === undefined || headSha === candidateSha,
      "CHANGE_REQUEST_OWNERSHIP_MISMATCH",
      "Existing GitLab merge request points at a different candidate",
      { expected: candidateSha, actual: headSha },
    );
    const iid = jsonIdentifier(request, "iid", "GitLab merge request");
    await run(
      "glab",
      [
        "mr",
        "update",
        iid,
        "--repo",
        options.project,
        "--target-branch",
        options.integrationBranch,
        "--title",
        options.title,
        "--description",
        options.body,
      ],
      { cwd },
    );
    const verified = await verifyGitLabMergeRequest(options, branch, candidateSha, cwd);
    invariant(
      verified !== null,
      "PUBLISH_PROVIDER_INCOMPLETE",
      "GitLab merge request update did not produce a verifiable provider state",
      { iid, project: options.project, branch },
    );
    return {
      requestId: iid,
      requestUrl: jsonString(verified, "web_url") ?? jsonString(verified, "webUrl") ?? null,
      action: "updated",
    };
  }
  const created = await run(
    "glab",
    [
      "mr",
      "create",
      "--repo",
      options.project,
      "--source-branch",
      branch,
      "--target-branch",
      options.integrationBranch,
      "--title",
      options.title,
      "--description",
      options.body,
      "--yes",
    ],
    { cwd },
  );
  const verified = await verifyGitLabMergeRequest(options, branch, candidateSha, cwd);
  invariant(
    verified !== null,
    "PUBLISH_PROVIDER_INCOMPLETE",
    "GitLab merge request create did not produce a verifiable provider state",
    { project: options.project, branch, glabOutput: bounded(created.stdout) },
  );
  const verifiedIid = jsonIdentifier(verified, "iid", "GitLab merge request");
  return {
    requestId: verifiedIid,
    requestUrl: jsonString(verified, "web_url") ?? jsonString(verified, "webUrl") ?? extractUrl(created.stdout),
    action: "created",
  };
}

async function verifyGitLabMergeRequest(
  options: PublishOptions,
  branch: string,
  candidateSha: string,
  cwd: string,
): Promise<Record<string, unknown> | null> {
  const listed = await run(
    "glab",
    [
      "mr",
      "list",
      "--repo",
      options.project,
      "--source-branch",
      branch,
      "--target-branch",
      options.integrationBranch,
      "--output",
      "json",
    ],
    { cwd },
  );
  const requests = parseJsonArray(listed.stdout, "GitLab merge request list");
  const matched = requests.find((entry) => {
    const headSha = jsonString(entry, "sha") ?? jsonString(entry, "head_sha");
    return headSha === undefined || headSha === candidateSha;
  });
  if (matched === undefined) return null;
  if (!isJsonRecord(matched)) return null;
  return matched;
}

async function publishCommand(
  options: PublishOptions,
  branch: string,
  candidateSha: string,
  remoteRef: string,
  cwd: string,
  expectedBranchWasMissing: boolean,
): Promise<ProviderCompletion> {
  invariant(
    options.command !== undefined && options.command.length > 0,
    "INVALID_PUBLISH_COMMAND",
    "Publish command provider requires a non-empty command argv",
    { provider: options.provider },
  );
  const argv = options.command;
  const executable = argv[0]!;
  const args = argv.slice(1);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.commandEnv ?? {}),
    POIESIS_CANDIDATE_SHA: candidateSha,
    POIESIS_CANDIDATE_TREE: options.candidateTree,
    POIESIS_BRANCH: branch,
    POIESIS_REMOTE_REF: remoteRef,
    POIESIS_PUBLISH_PROJECT: options.project,
    POIESIS_PUBLISH_TITLE: options.title,
    POIESIS_PUBLISH_BODY: options.body,
    POIESIS_PUBLISH_INTEGRATION_BRANCH: options.integrationBranch,
    POIESIS_PUBLISH_REMOTE: options.remote,
    POIESIS_PUBLISH_PROVIDER: options.provider,
  };
  const commandCwd = options.commandCwd ?? cwd;
  const result = await run(executable, args, { cwd: commandCwd, env });
  const output = parsePublishCommandOutput(result.stdout);
  const requestId = typeof output.id === "string" && output.id.length > 0 ? output.id : null;
  const requestUrl = typeof output.url === "string" && output.url.length > 0 ? output.url : null;
  invariant(
    output.candidateSha === undefined || output.candidateSha === candidateSha,
    "PUBLISH_COMMAND_CANDIDATE_MISMATCH",
    "Publish command reported a different candidate SHA",
    { expected: candidateSha, actual: output.candidateSha },
  );
  invariant(
    output.candidateTree === undefined || output.candidateTree === options.candidateTree,
    "PUBLISH_COMMAND_TREE_MISMATCH",
    "Publish command reported a different candidate tree",
    { expected: options.candidateTree, actual: output.candidateTree },
  );
  invariant(
    output.verified === true,
    "PUBLISH_PROVIDER_INCOMPLETE",
    "Publish command must report verified: true after provider completion",
    { exitCode: result.exitCode, output: bounded(result.stdout) },
  );
  const action = output.action === "created" || output.action === "updated"
    ? output.action
    : expectedBranchWasMissing
      ? "created"
      : "updated";
  return { requestId, requestUrl, action };
}

function parsePublishCommandOutput(stdout: string): {
  id?: string;
  url?: string;
  candidateSha?: string;
  candidateTree?: string;
  verified?: boolean;
  action?: "created" | "updated";
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new PoiesisError("INVALID_PUBLISH_COMMAND_OUTPUT", "Publish command output was not valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
      output: bounded(stdout),
    });
  }
  invariant(isJsonRecord(parsed), "INVALID_PUBLISH_COMMAND_OUTPUT", "Publish command output must be a JSON object");
  return parsed as {
    id?: string;
    url?: string;
    candidateSha?: string;
    candidateTree?: string;
    verified?: boolean;
    action?: "created" | "updated";
  };
}

async function verifyIntegratedCommit(
  owned: OwnedCandidateAuthority,
  integratedSha: string,
  commands: string[],
  outputLimit: number | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<VerifyResult> {
  const repositoryRoot = owned.primaryRoot;
  const path = join(tmpdir(), `poiesis-integrate-${randomUUID()}`);
  invariant(!(await pathExists(path)), "TEMPORARY_WORKTREE_COLLISION", "Temporary integration worktree path exists", {
    path,
  });
  await run("git", ["worktree", "add", "--detach", path, integratedSha], { cwd: repositoryRoot });
  let outcome: VerificationOutcome | null = null;
  let failure: unknown;
  try {
    // Spec #168 / ticket #169: the temporary detached worktree is not a
    // Poiesis-owned workspace, so it cannot resolve an authority of its
    // own. `integrate` already resolved and authenticated the candidate's
    // authority before the integration side effects ran; the commands
    // still execute in the temporary worktree.
    //
    // Spec #168 / ticket #171: post-integration verification is NOT
    // proof scope — it proves the integrated revision inside a throwaway
    // worktree, not the candidate — so it issues no verification receipt.
    const verifyOptions: VerifyOptions = { cwd: path, candidateSha: integratedSha, commands };
    if (outputLimit !== undefined) verifyOptions.outputLimit = outputLimit;
    if (env !== undefined) verifyOptions.env = env;
    outcome = await runVerification(verifyOptions, path, owned.marker.ownershipId);
    failure = outcome.failure;
  } catch (error) {
    failure = error;
  }

  const status = await gitStatus(path).catch(() => ["unknown"]);
  if (status.length !== 0) {
    throw new PoiesisError(
      "POST_INTEGRATION_WORKTREE_DIRTY",
      "Post-integration verification changed the temporary worktree; it was retained for inspection",
      { path, status: status.map(statusEntryForEvidence), failure: errorForEvidence(failure) },
    );
  }
  await run("git", ["worktree", "remove", path], { cwd: repositoryRoot });
  if (failure !== undefined && failure !== null) throw failure;
  invariant(outcome !== null, "POST_INTEGRATION_VERIFY_FAILED", "Post-integration verification returned no result");
  return outcome.result;
}

async function canonicalGitRoot(cwd: string): Promise<string> {
  return realpath(await resolveGitRoot(cwd));
}

async function gitCommonDir(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--git-common-dir"], { cwd });
  return realpath(isAbsolute(result.stdout) ? result.stdout : resolve(cwd, result.stdout));
}

/**
 * The canonical per-worktree Git directory. For the primary checkout this is
 * the shared common directory; for every linked worktree it is a private
 * `<commonDir>/worktrees/<name>`. Spec #168 / ticket #169 uses the
 * distinction to tell a Poiesis-owned candidate apart from foreign linked
 * work that must not inherit the primary installation's authority.
 */
async function gitDir(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd });
  return realpath(result.stdout);
}

async function fetchIntegrationBase(root: string, remote: string, integrationBranch: string): Promise<string> {
  await validateRemote(root, remote);
  await validateBranchName(root, integrationBranch);
  const trackingRef = remoteTrackingRef(remote, integrationBranch);
  await run(
    "git",
    ["fetch", "--no-tags", remote, `+refs/heads/${integrationBranch}:${trackingRef}`],
    { cwd: root },
  );
  return resolveCommit(root, trackingRef);
}

async function validateRemote(root: string, remote: string): Promise<void> {
  validateText(remote, "remote");
  invariant(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) &&
      !remote.includes("..") &&
      !remote.includes("//") &&
      !remote.endsWith("/") &&
      !remote.endsWith("."),
    "INVALID_REMOTE_NAME",
    "Remote name is not safe for deterministic Git operations",
    { remote },
  );
  const result = await run("git", ["remote", "get-url", remote], { cwd: root, allowFailure: true });
  invariant(result.exitCode === 0, "REMOTE_NOT_FOUND", "Configured Git remote does not exist", { remote });
}

async function validateBranchName(root: string, branch: string): Promise<void> {
  validateText(branch, "branch");
  const result = await run("git", ["check-ref-format", "--branch", branch], { cwd: root, allowFailure: true });
  invariant(result.exitCode === 0, "INVALID_BRANCH_NAME", "Invalid Git branch name", { branch });
}

function remoteTrackingRef(remote: string, branch: string): string {
  return `refs/remotes/${remote}/${branch}`;
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd });
  invariant(SHA_PATTERN.test(result.stdout), "INVALID_COMMIT_ID", "Git returned an invalid commit identifier", {
    revision,
    output: bounded(result.stdout),
  });
  return result.stdout;
}

async function resolveExpectedCommit(cwd: string, expected: string, field: string): Promise<string> {
  validateSha(expected, field);
  const resolved = await resolveCommit(cwd, expected);
  invariant(resolved === expected, "COMMIT_ID_MISMATCH", `${field} does not resolve exactly`, {
    expected,
    resolved,
  });
  return resolved;
}

export async function resolveTree(cwd: string, commit: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--verify", `${commit}^{tree}`], { cwd });
  invariant(SHA_PATTERN.test(result.stdout), "INVALID_TREE_ID", "Git returned an invalid tree identifier", {
    commit,
    output: bounded(result.stdout),
  });
  return result.stdout;
}

async function assertExactClean(cwd: string, expectedSha: string): Promise<{ sha: string }> {
  const sha = await resolveCommit(cwd, "HEAD");
  const status = await gitStatus(cwd);
  invariant(sha === expectedSha, "CANDIDATE_SHA_MISMATCH", "Workspace HEAD is not the expected exact candidate", {
    expected: expectedSha,
    actual: sha,
  });
  invariant(status.length === 0, "DIRTY_CANDIDATE", "Exact candidate workspace is not clean", {
    candidateSha: expectedSha,
    status: status.map(statusEntryForEvidence),
  });
  return { sha };
}

/**
 * Spec #168 / ticket #172 — the READ-ONLY workspace state fingerprint.
 *
 * A focused check records the state it ran against so an unchanged failure
 * is recognizable as unchanged. That reading deliberately reuses this
 * module's own `gitStatus` / `parseStatusPaths` porcelain semantics and its
 * own `normalizeOutputLimit` bound, rather than opening a second, subtly
 * different definition of "clean": the focused fingerprint and the exact
 * clean-candidate proof check must never disagree about the same tree.
 *
 * Read-only and unprivileged by construction: it resolves nothing, mutates
 * nothing, and asserts nothing. An unreadable HEAD or tree is reported as
 * `null` (state that cannot be proven) instead of throwing, because a
 * fingerprint is evidence, not a gate.
 */
export async function readWorktreeState(cwd: string, outputLimit?: number): Promise<WorktreeStateFingerprint> {
  const limit = normalizeOutputLimit(outputLimit);
  const root = await canonicalGitRoot(cwd);
  const headResult = await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    allowFailure: true,
  });
  const head = headResult.exitCode === 0 && SHA_PATTERN.test(headResult.stdout) ? headResult.stdout : null;
  // Spec #168 / ticket #179: the capture's own completeness is read alongside
  // its records, and the records themselves are whole ones only. A fingerprint
  // is evidence, not a gate, so an incomplete read is REPORTED rather than
  // thrown — it simply must never be reportable as a complete one.
  const capture = await captureGitStatus(root);
  const entries = capture.entries;
  const paths = parseStatusPaths(entries);
  const tree = head === null ? null : await resolveTree(root, head).catch(() => null);

  // Sorted and de-duplicated so the digest list — and therefore the state
  // fingerprint derived from it — is a deterministic function of the tree,
  // never of Git's status ordering or of a rename's dual paths.
  const digestPaths = [...new Set(paths)].sort().slice(0, MAX_PATH_DIGESTS);
  const pathDigests: WorktreePathDigest[] = [];
  for (const path of digestPaths) {
    pathDigests.push({ path, blob: await readPathContentDigest(root, path) });
  }

  return {
    root,
    head,
    tree,
    dirty: entries.length > 0,
    changedFiles: paths.slice(0, limit),
    changedFilesTruncated: paths.length > limit,
    statusCaptureTruncated: capture.truncated,
    pathDigests,
    pathDigestsTruncated: paths.length > digestPaths.length,
  };
}

async function currentBranch(cwd: string): Promise<string | null> {
  const result = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout : null;
}

async function assertOwnedBranch(owned: OwnedCandidateAuthority): Promise<string> {
  const branch = await currentBranch(owned.candidateRoot);
  invariant(branch !== null, "DETACHED_OWNED_WORKSPACE", "Owned workspace is unexpectedly detached", {
    path: owned.candidateRoot,
  });
  invariant(branch === owned.marker.branch, "OWNED_BRANCH_MISMATCH", "Owned workspace branch differs from its immutable marker", {
    expected: owned.marker.branch,
    actual: branch,
  });
  invariant(
    branch !== owned.marker.integrationBranch,
    "INTEGRATION_BRANCH_FORBIDDEN",
    "Poiesis-owned change workspace cannot use the integration branch",
  );
  const worktree = (await listWorktrees(owned.candidateRoot)).find((entry) => entry.path === owned.candidateRoot);
  invariant(worktree !== undefined, "WORKTREE_NOT_REGISTERED", "Owned workspace is not registered with Git");
  invariant(worktree.branch === branch, "WORKTREE_BRANCH_MISMATCH", "Registered worktree branch differs from ownership marker");
  return branch;
}

/**
 * Spec #168 / ticket #169 — the SINGLE shared lifecycle authority seam.
 *
 * Resolves, for any project-bound lifecycle operation, the canonical
 * candidate workspace together with the PRIMARY receipt-authenticated
 * installation that owns it: the immutable ownership marker, the primary
 * repository root, the primary ownership receipt, the receipt-authenticated
 * primary manifest, and the runtime identity those two bind together.
 *
 * Everything fails closed with a typed diagnostic:
 *   - no single marker owns this workspace, or more than one does
 *     (`WORKSPACE_OWNERSHIP_UNKNOWN`);
 *   - an ownership id was claimed but does not match the marker
 *     (`WORKSPACE_OWNERSHIP_ID_MISMATCH`);
 *   - the marker names the primary checkout (`PRIMARY_CHECKOUT_OWNERSHIP_INVALID`)
 *     or a different Git repository (`WORKSPACE_REPOSITORY_MISMATCH`);
 *   - a linked worktree that Poiesis does not own (`WORKSPACE_OWNERSHIP_UNKNOWN`);
 *   - the primary receipt is missing or does not match the primary manifest
 *     (`OWNERSHIP_RECEIPT_MISSING` / `OWNERSHIP_RECEIPT_MISMATCH`);
 *   - the executing runtime does not equal the primary manifest's recorded
 *     version (`RUNTIME_VERSION_MISMATCH`).
 *
 * The primary checkout is the one compatibility surface: it owns no
 * Poiesis workspace marker, so `marker` / `markerPath` are `null` and the
 * primary is its own authority.
 */
export async function resolveLifecycleAuthority(
  cwd: string,
  ownershipId?: string,
): Promise<LifecycleAuthority> {
  const candidateRoot = await canonicalGitRoot(cwd);
  const commonDir = await gitCommonDir(candidateRoot);
  const matches = (await readMarkers(commonDir)).filter(({ marker }) => marker.workspacePath === candidateRoot);
  invariant(
    matches.length <= 1,
    "WORKSPACE_OWNERSHIP_UNKNOWN",
    "Cannot prove Poiesis owns this workspace",
    { path: candidateRoot, matches: matches.length },
  );

  let markerPath: string | null = null;
  let marker: OwnershipMarker | null = null;
  let primaryRoot = candidateRoot;
  if (matches.length === 1) {
    const owned = matches[0]!;
    invariant(
      owned.marker.repositoryRoot !== candidateRoot,
      "PRIMARY_CHECKOUT_OWNERSHIP_INVALID",
      "Ownership marker points at the primary checkout",
    );
    invariant(
      (await gitCommonDir(owned.marker.repositoryRoot)) === commonDir,
      "WORKSPACE_REPOSITORY_MISMATCH",
      "Ownership marker belongs to a different Git repository",
    );
    primaryRoot = await canonicalExistingPath(owned.marker.repositoryRoot);
    const primaryGitDir = await gitDir(primaryRoot);
    invariant(
      primaryGitDir === commonDir,
      "WORKSPACE_REPOSITORY_MISMATCH",
      "Ownership marker no longer names this repository's primary checkout",
      { expected: commonDir, actual: primaryGitDir },
    );
    if (ownershipId !== undefined) {
      invariant(
        owned.marker.ownershipId === ownershipId,
        "WORKSPACE_OWNERSHIP_ID_MISMATCH",
        "Workspace ownership identity does not match",
      );
    }
    markerPath = owned.markerPath;
    marker = owned.marker;
  } else {
    // No marker owns this workspace. A claimed ownership identity can
    // never be satisfied, and a linked worktree Poiesis does not own is
    // foreign work that must never inherit the primary's authority.
    invariant(
      ownershipId === undefined,
      "WORKSPACE_OWNERSHIP_UNKNOWN",
      "Cannot prove Poiesis owns this workspace",
      { path: candidateRoot, matches: 0 },
    );
    invariant(
      (await gitDir(candidateRoot)) === commonDir,
      "WORKSPACE_OWNERSHIP_UNKNOWN",
      "Cannot prove Poiesis owns this workspace",
      { path: candidateRoot, matches: 0, reason: "foreign-worktree" },
    );
  }

  // Runtime identity first: the absent-manifest branch of the shared guard
  // is the fail-closed diagnostic for an uninstalled primary and must stay
  // the surfaced code.
  await (await import("./maintenance.js")).assertRuntimeVersionMatchesProject(primaryRoot);
  const manifest = await loadManifest(primaryRoot);
  const receipt = await assertOwnershipReceipt(primaryRoot, manifest);
  return {
    candidateRoot,
    commonDir,
    markerPath,
    marker,
    primaryRoot,
    receipt,
    manifest,
    runtime: manifest.poiesisVersion,
  };
}

/**
 * Spec #168 / ticket #169 — the owned-candidate form of the shared
 * authority. `checkpoint` / `publish` / `integrate` / `workspace cleanup`
 * mutate a Poiesis-prepared workspace and therefore additionally require a
 * proven ownership marker.
 */
async function resolveOwnedCandidateAuthority(
  cwd: string,
  ownershipId?: string,
): Promise<OwnedCandidateAuthority> {
  const authority = await resolveLifecycleAuthority(cwd, ownershipId);
  invariant(
    authority.marker !== null && authority.markerPath !== null,
    "WORKSPACE_OWNERSHIP_UNKNOWN",
    "Cannot prove Poiesis owns this workspace",
    { path: authority.candidateRoot, matches: 0 },
  );
  return {
    ...authority,
    markerPath: authority.markerPath,
    marker: authority.marker,
  };
}

/**
 * Spec #168 / ticket #169 — `verify`'s authority resolution.
 *
 * `verify` is not a project-bound mutation, so a repository that never
 * installed Poiesis stays a valid, non-project-bound verification surface.
 * As soon as Poiesis IS involved — an owned candidate workspace, an
 * installed primary checkout, a claimed ownership id, or foreign linked
 * work — the strict shared resolver runs and fails closed on wrong
 * ownership, missing receipts, foreign workspaces, and mismatched runtime
 * identity.
 */
async function resolveVerifyAuthority(cwd: string, ownershipId?: string): Promise<LifecycleAuthority | null> {
  const candidateRoot = await canonicalGitRoot(cwd);
  const commonDir = await gitCommonDir(candidateRoot);
  const owned = (await readMarkers(commonDir)).some(({ marker }) => marker.workspacePath === candidateRoot);
  const installed = await exists(poiesisPath(candidateRoot, "manifest.json"));
  const nonProjectBound =
    ownershipId === undefined &&
    !owned &&
    !installed &&
    (await gitDir(candidateRoot)) === commonDir;
  return nonProjectBound ? null : resolveLifecycleAuthority(candidateRoot, ownershipId);
}

async function createMarker(commonDir: string, marker: OwnershipMarker): Promise<string> {
  const directory = join(commonDir, MARKER_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const markerPath = join(directory, `${hashMarkerKey(marker.specId)}.json`);
  let handle;
  try {
    handle = await open(markerPath, "wx", 0o400);
  } catch (error) {
    throw new PoiesisError("OWNERSHIP_MARKER_COLLISION", "Immutable workspace ownership marker already exists", {
      markerPath,
      cause: errorForEvidence(error),
    });
  }
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(markerPath, 0o400);
  return markerPath;
}

async function readMarkers(commonDir: string): Promise<Array<{ markerPath: string; marker: OwnershipMarker }>> {
  const directory = join(commonDir, MARKER_DIRECTORY);
  if (!(await pathExists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const markers: Array<{ markerPath: string; marker: OwnershipMarker }> = [];
  for (const entry of entries) {
    const markerPath = join(directory, entry.name);
    invariant(entry.isFile() && entry.name.endsWith(".json"), "UNKNOWN_OWNERSHIP_STATE", "Unknown entry in ownership marker directory", {
      markerPath,
    });
    let value: unknown;
    try {
      value = JSON.parse(await readFile(markerPath, "utf8"));
    } catch (error) {
      throw new PoiesisError("INVALID_OWNERSHIP_MARKER", "Cannot read immutable workspace ownership marker", {
        markerPath,
        cause: errorForEvidence(error),
      });
    }
    invariant(isOwnershipMarker(value), "INVALID_OWNERSHIP_MARKER", "Workspace ownership marker is invalid", {
      markerPath,
    });
    invariant(
      entry.name === `${hashMarkerKey(value.specId)}.json`,
      "INVALID_OWNERSHIP_MARKER",
      "Workspace ownership marker name does not match its Spec",
      { markerPath },
    );
    markers.push({ markerPath, marker: value });
  }
  return markers;
}

function isOwnershipMarker(value: unknown): value is OwnershipMarker {
  if (!isJsonRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "baseSha",
    "branch",
    "integrationBranch",
    "owner",
    "ownershipId",
    "remote",
    "repositoryRoot",
    "schema",
    "specId",
    "workspacePath",
  ].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    value.schema === 1 &&
    value.owner === "poiesis" &&
    typeof value.ownershipId === "string" &&
    value.ownershipId.length > 0 &&
    typeof value.specId === "string" &&
    value.specId.length > 0 &&
    typeof value.repositoryRoot === "string" &&
    isAbsolute(value.repositoryRoot) &&
    typeof value.workspacePath === "string" &&
    isAbsolute(value.workspacePath) &&
    typeof value.branch === "string" &&
    value.branch.length > 0 &&
    typeof value.remote === "string" &&
    value.remote.length > 0 &&
    typeof value.integrationBranch === "string" &&
    value.integrationBranch.length > 0 &&
    typeof value.baseSha === "string" &&
    SHA_PATTERN.test(value.baseSha)
  );
}

async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  const result = await run("git", ["worktree", "list", "--porcelain", "-z"], { cwd });
  if (!result.stdout) return [];
  const records = result.stdout.split("\0\0").filter(Boolean);
  const worktrees: GitWorktree[] = [];
  for (const record of records) {
    const fields = record.split("\0").filter(Boolean);
    const pathField = fields.find((field) => field.startsWith("worktree "));
    invariant(pathField !== undefined, "INVALID_GIT_OUTPUT", "Git returned an invalid worktree record", {
      record: bounded(record),
    });
    const head = fieldValue(fields, "HEAD ");
    const branchRef = fieldValue(fields, "branch ");
    worktrees.push({
      path: await canonicalWorktreePath(pathField.slice("worktree ".length)),
      head: head && SHA_PATTERN.test(head) ? head : null,
      branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null,
      bare: fields.includes("bare"),
      detached: fields.includes("detached"),
      locked: flagValue(fields, "locked"),
      prunable: flagValue(fields, "prunable"),
    });
  }
  return worktrees;
}

function fieldValue(fields: string[], prefix: string): string | null {
  const field = fields.find((candidate) => candidate.startsWith(prefix));
  return field === undefined ? null : field.slice(prefix.length);
}

function flagValue(fields: string[], flag: string): string | null {
  const field = fields.find((candidate) => candidate === flag || candidate.startsWith(`${flag} `));
  if (field === undefined) return null;
  return field === flag ? "" : field.slice(flag.length + 1);
}

/**
 * Spec #168 / ticket #179 — one status capture, and whether it was read WHOLE.
 *
 * The process runner bounds every capture it takes, so once a worktree's
 * porcelain status exceeds that bound the reader sees only its prefix, and the
 * bound can stop part-way through a record. That makes two different facts that
 * must never be conflated:
 *
 *   - the CAPTURE was cut short (`truncated`) — there is workspace state
 *     nobody read, so the observation cannot be reported as a complete one;
 *   - a complete capture whose path list was then bounded for evidence, which
 *     is `readWorktreeState`'s `changedFilesTruncated` / `pathDigestsTruncated`
 *     and says nothing about how much of the worktree was read.
 *
 * `entries` therefore holds COMPLETE records only (see `captureGitStatus` for
 * how the final unterminated record is told apart from a cut one). A record the
 * bound cut through is discarded instead of parsed, because half a porcelain
 * record is not a change: its path is a prefix of a real path that does not
 * exist on disk, and reporting it would put a content digest on a file the
 * worktree does not contain.
 */
export interface GitStatusCapture {
  entries: string[];
  truncated: boolean;
}

async function captureGitStatus(cwd: string): Promise<GitStatusCapture> {
  const result = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (!result.stdout) return { entries: [], truncated: result.stdoutTruncated };
  // `-z` porcelain terminates every record with NUL EXCEPT the last one, so the
  // trailing segment is that final whole record when the capture was read to
  // the end of the stream, and a record the capture stopped inside when the
  // runner reported output remaining. Only the second is incomplete, and it is
  // discarded rather than parsed: half a porcelain record is not a change.
  const records = result.stdout.split("\0");
  const trailing = records.pop() ?? "";
  const truncated = result.stdoutTruncated;
  const whole = records.filter((record) => record.length > 0);
  if (!truncated && trailing.length > 0) whole.push(trailing);
  return { entries: parseStatusRecords(whole, truncated), truncated };
}

/**
 * Pair up the whole records of a `-z` porcelain capture.
 *
 * A rename or copy is TWO NUL-terminated fields — the destination then the
 * source — and the bound can stop between them. An incomplete capture is the
 * only thing that explains a missing source field, so there the half-read
 * record is dropped rather than reported as a change whose source was
 * reconstructed from the bytes that happened to arrive. A COMPLETE capture
 * missing the field is Git's own invalid output and still fails closed.
 */
function parseStatusRecords(records: string[], truncated: boolean): string[] {
  const entries: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    if (entry === undefined) continue;
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const source = records[index + 1];
      if (source === undefined && truncated) break;
      invariant(source !== undefined, "INVALID_GIT_OUTPUT", "Git omitted a rename/copy source path");
      entries.push(`${entry}\0${source}`);
      index += 1;
    } else {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * The status read every clean/dirty authority shares: `inspect`, `checkpoint`,
 * the exact-candidate clean assertions, workspace cleanup, and the temporary
 * post-integration worktree.
 *
 * Spec #168 / ticket #179 — this is deliberately the WHOLE-RECORDS half of
 * {@link captureGitStatus} and it deliberately keeps its `string[]` signature,
 * because those callers ask "is anything changed?" and a single whole record
 * already proves "yes"; a capture bounded at 256KiB can never hold fewer than
 * one whole record, so a bounded read can never report a dirty tree as clean.
 * What it can no longer do is turn the bound's last fragment into a claim: the
 * fragment is a path prefix that does not exist on disk, and matching it as
 * checkpoint residue or reporting it as a changed file would be a statement
 * about the worktree that the worktree contradicts. Callers that must know
 * whether the workspace was read WHOLE — the state fingerprint — read the
 * detailed capture instead.
 */
async function gitStatus(cwd: string): Promise<string[]> {
  return (await captureGitStatus(cwd)).entries;
}

function parseStatusPaths(entries: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    const [destination, source] = entry.split("\0", 2);
    if (destination !== undefined) paths.push(destination.slice(3));
    if (source !== undefined) paths.push(source);
  }
  return paths;
}

function statusEntryForEvidence(entry: string): string {
  return bounded(entry, 1_000);
}

function pathCovers(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function normalizeExplicitPaths(root: string, paths: string[]): string[] {
  invariant(paths.length > 0, "NO_CHECKPOINT_PATHS", "Checkpoint requires at least one explicit path");
  const normalized = paths.map((path) => {
    validateText(path, "checkpoint path");
    invariant(!isAbsolute(path), "INVALID_CHECKPOINT_PATH", "Checkpoint paths must be repository-relative", { path });
    const absolute = resolve(root, path);
    const repositoryRelative = relative(root, absolute);
    invariant(
      repositoryRelative !== "" &&
        repositoryRelative !== ".git" &&
        !repositoryRelative.startsWith(`.git${sep}`) &&
        repositoryRelative !== ".." &&
        !repositoryRelative.startsWith(`..${sep}`) &&
        !isAbsolute(repositoryRelative),
      "INVALID_CHECKPOINT_PATH",
      "Checkpoint path must identify tracked project content inside the repository",
      { path },
    );
    return repositoryRelative;
  });
  return [...new Set(normalized)].sort();
}

async function canonicalProspectivePath(path: string): Promise<string> {
  invariant(isAbsolute(path), "WORKSPACE_PATH_NOT_ABSOLUTE", "Workspace path must be absolute", { path });
  const parent = await canonicalExistingPath(dirname(path));
  const candidate = join(parent, basename(path));
  invariant(candidate !== parent, "INVALID_WORKSPACE_PATH", "Workspace path must name a child of an existing directory");
  return candidate;
}

async function canonicalExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new PoiesisError("PATH_NOT_RESOLVABLE", "Cannot resolve filesystem path", {
      path,
      cause: errorForEvidence(error),
    });
  }
}

async function canonicalWorktreePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isJsonRecord(error) && error.code === "ENOENT") return resolve(path);
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isJsonRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function lsRemoteHead(cwd: string, remote: string, branch: string): Promise<string | null> {
  const result = await run("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], { cwd });
  if (!result.stdout) return null;
  const records = nonemptyLines(result.stdout);
  invariant(records.length === 1, "INVALID_REMOTE_REF", "Remote returned multiple exact branch heads", { branch });
  const sha = records[0]?.split(/\s+/, 1)[0];
  invariant(sha !== undefined && SHA_PATTERN.test(sha), "INVALID_REMOTE_REF", "Remote returned an invalid branch head", {
    branch,
    output: bounded(result.stdout),
  });
  return sha;
}

function identityEnvironment(identity: GitIdentity | undefined): NodeJS.ProcessEnv | undefined {
  if (identity === undefined) return undefined;
  validateText(identity.name, "Git identity name");
  validateText(identity.email, "Git identity email");
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

function validateAcceptedReview(review: AcceptedReviewEvidence): void {
  invariant(review.verdict === "PASS", "CHECKPOINT_REVIEW_NOT_ACCEPTED", "Checkpoint requires an accepted PASS review");
  validateText(review.reviewerIdentity, "reviewerIdentity");
  validateText(review.evidence, "review evidence");
}

function validateText(value: string, field: string): void {
  invariant(value.trim().length > 0 && !value.includes("\0"), "INVALID_ARGUMENT", `${field} must be non-empty`, {
    field,
  });
}

function validateSha(value: string, field: string): void {
  invariant(SHA_PATTERN.test(value), "INVALID_COMMIT_ID", `${field} must be a full lowercase Git object ID`, {
    field,
    value,
  });
}

function normalizeOutputLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OUTPUT_LIMIT;
  invariant(
    Number.isSafeInteger(value) && value > 0 && value <= MAX_OUTPUT_LIMIT,
    "INVALID_OUTPUT_LIMIT",
    `Output limit must be between 1 and ${MAX_OUTPUT_LIMIT}`,
    { value },
  );
  return value;
}

function hashMarkerKey(specId: string): string {
  return createHash("sha256").update(specId).digest("hex");
}

function nonemptyLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseJsonArray(value: string, source: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new PoiesisError("INVALID_PROVIDER_OUTPUT", `${source} was not valid JSON`, {
      output: bounded(value),
      cause: errorForEvidence(error),
    });
  }
  invariant(Array.isArray(parsed), "INVALID_PROVIDER_OUTPUT", `${source} was not a JSON array`);
  return parsed;
}

function jsonIdentifier(value: unknown, key: string, source: string): string {
  invariant(isJsonRecord(value), "INVALID_PROVIDER_OUTPUT", `${source} entry was not an object`);
  const identifier = value[key];
  invariant(
    (typeof identifier === "string" && identifier.length > 0) ||
      (typeof identifier === "number" && Number.isSafeInteger(identifier)),
    "INVALID_PROVIDER_OUTPUT",
    `${source} entry has no valid ${key}`,
  );
  return String(identifier);
}

function jsonString(value: unknown, key: string): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  return typeof value[key] === "string" ? value[key] : undefined;
}

function extractUrl(value: string): string | null {
  const match = value.match(/https:\/\/[^\s]+/g);
  return match?.at(-1)?.replace(/[),.;]+$/, "") ?? null;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorForEvidence(error: unknown): string | null {
  if (error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

async function assertSafeManagedParentChain(root: string, components: string[]): Promise<void> {
  // lstat-style no-follow validation: walk each existing component of
  // the managed parent chain under `root` and refuse to follow any
  // symlink or treat a non-directory as a directory. mkdir(..., {
  // recursive: true }) would otherwise follow an attacker-placed
  // symlink at any level and create the workspace at an external
  // target. Missing components are fine — they will be created by the
  // caller and re-validated.
  let current = root;
  for (const part of components) {
    current = join(current, part);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isJsonRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new PoiesisError(
        "WORKSPACE_PARENT_UNSAFE",
        "Refusing to traverse a symlinked workspace parent",
        { path: relative(root, current) },
      );
    }
    if (!stat.isDirectory()) {
      throw new PoiesisError(
        "WORKSPACE_PARENT_UNSAFE",
        "Workspace parent must be a regular directory",
        { path: relative(root, current) },
      );
    }
  }
}

/**
 * Resolve the in-project workspace directory used when `workspace prepare`
 * is invoked without an explicit `--path`. The directory lives under
 * `<root>/.poiesis/workspaces/<derived-id>` so the workspace stays inside
 * the harness-readable project root, never under `/tmp` or another
 * external location that the harness cannot access. The returned path
 * is treated like any other candidate workspace path: the marker, base,
 * checkpoint, publish, cleanup, and rollback semantics are unchanged.
 *
 * The parent chain `<root>/.poiesis` and `<root>/.poiesis/workspaces`
 * is validated with lstat-style no-follow semantics before any
 * mkdir/realpath/write. A hostile symlink at any of these components
 * would otherwise be followed by mkdir and let the default path
 * escape the project root and mutate an external target.
 */
export async function deriveDefaultWorkspacePath(
  root: string,
  specId: string,
  branch: string,
): Promise<string> {
  validateText(specId, "specId");
  validateText(branch, "branch");
  const branchLeaf = branch.split("/").pop() ?? branch;
  const safeSpec = sanitizeWorkspaceIdSegment(specId, "specId");
  const safeBranch = sanitizeWorkspaceIdSegment(branchLeaf, "branch");
  const directory = join(root, ".poiesis", "workspaces", `${safeSpec}__${safeBranch}`);
  // Defence-in-depth: even after sanitization the result must stay
  // inside the repository root. `relative` returns ".." or an absolute
  // path when the candidate escapes the root, which would indicate a
  // sanitization bug rather than user input.
  const inside = relative(root, directory);
  invariant(
    !isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`),
    "WORKSPACE_ID_TRAVERSAL_FORBIDDEN",
    "Derived workspace id escapes the repository root",
    { inside, specId, branch },
  );
  // Validate the parent chain with lstat-style no-follow semantics
  // before any mkdir/realpath/write. A hostile symlink at `.poiesis`
  // or `.poiesis/workspaces` would otherwise be followed by mkdir
  // and let the default path escape the project root.
  await assertSafeManagedParentChain(root, [".poiesis", "workspaces"]);
  // `git worktree add` requires the parent directory to exist. The
  // nested `.poiesis/workspaces/` area is gitignored so this directory
  // never appears as foreign work in the primary checkout.
  await mkdir(join(root, ".poiesis", "workspaces"), { recursive: true, mode: 0o700 });
  // Re-validate the parent chain after mkdir to close the
  // validate-mutate-create TOCTOU window (a concurrent attacker could
  // swap a regular directory for a symlink between the two checks).
  await assertSafeManagedParentChain(root, [".poiesis", "workspaces"]);
  return directory;
}

function sanitizeWorkspaceIdSegment(value: string, field: string): string {
  invariant(!value.includes("\0"), "INVALID_ARGUMENT", `${field} must not contain null bytes`, { field });
  invariant(
    !value.includes("..") && !value.includes("/") && !value.includes(sep) && !value.includes("\\"),
    "WORKSPACE_ID_TRAVERSAL_FORBIDDEN",
    `${field} cannot contain traversal segments`,
    { field, value },
  );
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-");
  invariant(
    safe.length > 0 && safe !== "." && safe !== "..",
    "WORKSPACE_ID_INVALID",
    `${field} cannot be sanitized to a usable identifier`,
    { field, value },
  );
  return safe;
}

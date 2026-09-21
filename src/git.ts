import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { PoiesisError, invariant } from "./errors.js";
import { bounded, DEFAULT_VERIFY_TIMEOUT_MS, run, type RunResult } from "./process.js";
import { resolveGitRoot } from "./paths.js";
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
  timeoutMs?: number;
  outputLimit?: number;
  env?: NodeJS.ProcessEnv;
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

interface OwnershipMarker {
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

interface OwnedWorkspace {
  root: string;
  commonDir: string;
  markerPath: string;
  marker: OwnershipMarker;
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
  const owned = await resolveOwnedWorkspace(options.cwd, options.ownershipId);
  // Spec #104 / ticket #106: pre-mutation runtime identity guard.
  // The receipt-authenticated manifest lives under the primary
  // checkout that owns this workspace (`owned.marker.repositoryRoot`).
  // The dynamic import keeps the top-level module graph acyclic.
  await (await import("./maintenance.js")).assertRuntimeVersionMatchesProject(owned.marker.repositoryRoot);
  const branch = await assertOwnedBranch(owned);
  const paths = normalizeExplicitPaths(owned.root, options.paths);
  const statusBefore = await gitStatus(owned.root);
  invariant(statusBefore.length > 0, "NO_CHECKPOINT_CHANGES", "Workspace contains no changes to checkpoint");
  const stagedBefore = await run("git", ["diff", "--cached", "--quiet", "--exit-code"], {
    cwd: owned.root,
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
  await run("git", ["add", "--", ...paths], { cwd: owned.root });
  const residueAfterStage = parseStatusPaths(await gitStatus(owned.root));
  invariant(
    residueAfterStage.every((changedPath) => paths.some((path) => pathCovers(path, changedPath))),
    "CHECKPOINT_PATH_ESCAPE",
    "Staging introduced paths outside the accepted set",
    { staged: residueAfterStage, allowed: paths },
  );
  const stagedNames = (
    await run("git", ["diff", "--cached", "--name-only", "-z", "--", ...paths], { cwd: owned.root })
  ).stdout.split("\0").filter(Boolean);
  invariant(stagedNames.length > 0, "NO_CHECKPOINT_CHANGES", "Explicit checkpoint paths contain no changes", { paths });
  try {
    const commitEnvironment = {
      ...identityEnvironment(options.author),
      POIESIS_CHECKPOINT: "1",
    };
    const commit = await run("git", ["commit", "-m", options.message], {
      cwd: owned.root,
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
    const sha = await resolveCommit(owned.root, "HEAD");
    const postStatus = parseStatusPaths(await gitStatus(owned.root));
    invariant(postStatus.length === 0, "POST_CHECKPOINT_RESIDUE", "Checkpoint created additional unstaged residue", {
      postStatus,
    });
    return { sha, branch, paths: stagedNames, review: options.review };
  } finally {
    await run("git", ["reset", "--mixed", "HEAD", "--", ...paths], { cwd: owned.root, allowFailure: true });
  }
}

export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  validateSha(options.candidateSha, "candidateSha");
  invariant(options.commands.length > 0, "NO_VERIFICATION_COMMANDS", "At least one verification command is required");
  for (const command of options.commands) validateText(command, "verification command");
  const root = await canonicalGitRoot(options.cwd);
  const candidateSha = await resolveExpectedCommit(root, options.candidateSha, "candidateSha");
  await assertExactClean(root, candidateSha);
  const outputLimit = normalizeOutputLimit(options.outputLimit);
  const results: VerifyCommandResult[] = [];
  let failed: VerifyCommandResult | null = null;

  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  // run() only rejects after it has terminated the spawned process tree
  // (see process.ts settle()). The workspace state is therefore safe to
  // observe immediately after a rejection, so the exact-SHA clean-after
  // check below can run unconditionally.
  let runError: unknown = null;
  for (const command of options.commands) {
    let result: RunResult;
    try {
      result = await run("/bin/sh", ["-c", command], {
        cwd: root,
        allowFailure: true,
        timeoutMs,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      runError = error;
      break;
    }
    const evidence = {
      command,
      exitCode: result.exitCode,
      stdout: bounded(result.stdout, outputLimit),
      stderr: bounded(result.stderr, outputLimit),
    };
    results.push(evidence);
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

  if (dirtyStatus !== null) {
    throw new PoiesisError(
      "DIRTY_CANDIDATE",
      "Verify invocation left the exact candidate workspace dirty",
      {
        candidateSha,
        commands: results,
        runError: runError === null ? null : errorForEvidence(runError),
        status: dirtyStatus.map(statusEntryForEvidence),
      },
    );
  }

  if (runError !== null) throw runError;
  if (failed !== null) {
    throw new PoiesisError("VERIFICATION_FAILED", "A configured verification command failed", {
      candidateSha,
      failed,
      commands: results,
    });
  }
  return { candidateSha, cleanBefore: true, cleanAfter: true, commands: results };
}

export async function publish(options: PublishOptions): Promise<PublishResult> {
  validateText(options.project, "project");
  validateText(options.title, "title");
  validateText(options.body, "body");
  validateSha(options.candidateSha, "candidateSha");
  const owned = await resolveOwnedWorkspace(options.cwd, options.ownershipId);
  // Spec #104 / ticket #106: pre-mutation runtime identity guard.
  // Validates the running package equals the durable
  // `manifest.poiesisVersion` before any push / change-request side
  // effect. The receipt-authenticated manifest lives under the primary
  // checkout that owns this workspace.
  await (await import("./maintenance.js")).assertRuntimeVersionMatchesProject(owned.marker.repositoryRoot);
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
  await validateRemote(owned.root, options.remote);
  await validateBranchName(owned.root, options.integrationBranch);
  const candidateSha = await resolveExpectedCommit(owned.root, options.candidateSha, "candidateSha");
  await assertExactClean(owned.root, candidateSha);
  const candidateTree = await resolveTree(owned.root, candidateSha);
  invariant(candidateTree === options.candidateTree, "CANDIDATE_TREE_MISMATCH", "Provided candidate tree does not match repository", {
    expected: candidateTree,
    provided: options.candidateTree,
  });
  validateProofEvidence(options.proof, candidateSha, candidateTree);

  const remoteRef = `refs/heads/${branch}`;
  const expectedRemote = await lsRemoteHead(owned.root, options.remote, branch);
  if (expectedRemote !== null) {
    const localIsAncestor = await run(
      "git",
      ["merge-base", "--is-ancestor", expectedRemote, candidateSha],
      { cwd: owned.root, allowFailure: true },
    );
    if (localIsAncestor.exitCode !== 0) {
      throw new PoiesisError(
        "PUBLISHED_BRANCH_DIVERGED",
        "Remote change branch contains work that is not an ancestor of the local candidate; refusing to overwrite",
        { remote: options.remote, branch, remoteHead: expectedRemote, candidateSha },
      );
    }
  }
  await run("git", ["push", "--porcelain", options.remote, `${candidateSha}:${remoteRef}`], { cwd: owned.root });
  const publishedSha = await lsRemoteHead(owned.root, options.remote, branch);
  invariant(publishedSha === candidateSha, "PUBLISHED_SHA_MISMATCH", "Remote branch does not identify the exact candidate", {
    expected: candidateSha,
    actual: publishedSha,
  });
  await assertExactClean(owned.root, candidateSha);

  let providerCompletion: ProviderCompletion;
  if (options.provider === "fixture") {
    providerCompletion = {
      requestId: null,
      requestUrl: null,
      action: expectedRemote === null ? "pushed" : "updated",
    };
  } else if (options.provider === "github") {
    providerCompletion = await publishGitHub(options, branch, candidateSha, remoteRef, owned.root, expectedRemote === null);
  } else if (options.provider === "gitlab") {
    providerCompletion = await publishGitLab(options, branch, candidateSha, remoteRef, owned.root, expectedRemote === null);
  } else {
    providerCompletion = await publishCommand(
      options,
      branch,
      candidateSha,
      remoteRef,
      owned.root,
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
  const owned = await resolveOwnedWorkspace(options.cwd, options.ownershipId);
  // Spec #104 / ticket #106: pre-mutation runtime identity guard.
  // Validates the running package equals the durable
  // `manifest.poiesisVersion` before any
  // commit-tree / fetch-base / push integration side effect.
  await (await import("./maintenance.js")).assertRuntimeVersionMatchesProject(owned.marker.repositoryRoot);
  await assertOwnedBranch(owned);
  invariant(options.remote === owned.marker.remote, "WORKSPACE_REMOTE_MISMATCH", "Integration remote does not match workspace ownership");
  invariant(
    options.integrationBranch === owned.marker.integrationBranch,
    "WORKSPACE_INTEGRATION_BRANCH_MISMATCH",
    "Integration branch does not match workspace ownership",
  );
  await validateRemote(owned.root, options.remote);
  await validateBranchName(owned.root, options.integrationBranch);
  const expectedBaseSha = await resolveExpectedCommit(owned.root, options.expectedBaseSha, "expectedBaseSha");
  const candidateSha = await resolveExpectedCommit(owned.root, options.candidateSha, "candidateSha");
  await assertExactClean(owned.root, candidateSha);
  const candidateTree = await resolveTree(owned.root, candidateSha);
  invariant(candidateTree === options.candidateTree, "CANDIDATE_TREE_MISMATCH", "Provided candidate tree does not match repository", {
    expected: candidateTree,
    provided: options.candidateTree,
  });
  validateProofEvidence(options.proof, candidateSha, candidateTree);
  validateStagingEvidence(options.staging, candidateSha, candidateTree);

  const fetchedBase = await fetchIntegrationBase(owned.root, options.remote, options.integrationBranch);
  invariant(fetchedBase === expectedBaseSha, "STALE_INTEGRATION_BASE", "Remote integration base changed", {
    expected: expectedBaseSha,
    actual: fetchedBase,
  });
  const basedOnExpected = await run("git", ["merge-base", "--is-ancestor", expectedBaseSha, candidateSha], {
    cwd: owned.root,
    allowFailure: true,
  });
  invariant(
    basedOnExpected.exitCode === 0,
    "CANDIDATE_BASE_MISMATCH",
    "Candidate is not based on the expected integration commit",
    { expectedBaseSha, candidateSha },
  );

  const publishedCandidate = await lsRemoteHead(owned.root, options.remote, owned.marker.branch);
  invariant(
    publishedCandidate === candidateSha,
    "CANDIDATE_NOT_PUBLISHED",
    "Integration requires the exact proven candidate on the published change branch",
    { expected: candidateSha, actual: publishedCandidate },
  );
  const baseTree = await resolveTree(owned.root, expectedBaseSha);
  invariant(candidateTree !== baseTree, "EMPTY_INTEGRATION", "Candidate tree is identical to the integration base");
  const commitEnvironment = identityEnvironment(options.author);
  const commit = await run("git", ["commit-tree", candidateTree, "-p", expectedBaseSha], {
    cwd: owned.root,
    input: `${options.message}\n`,
    ...(commitEnvironment === undefined ? {} : { env: commitEnvironment }),
  });
  const integratedSha = commit.stdout;
  validateSha(integratedSha, "integratedSha");
  const integratedTree = await resolveTree(owned.root, integratedSha);
  invariant(integratedTree === candidateTree, "INTEGRATED_TREE_MISMATCH", "Squash integration tree differs from candidate", {
    candidateTree,
    integratedTree,
  });

  await assertExactClean(owned.root, candidateSha);
  let postIntegrationVerification: VerifyResult | null = null;
  if (options.postIntegrationCommands !== undefined && options.postIntegrationCommands.length > 0) {
    postIntegrationVerification = await verifyIntegratedCommit(
      owned.root,
      integratedSha,
      options.postIntegrationCommands,
      options.outputLimit,
      options.env,
    );
  }

  const remoteRef = `refs/heads/${options.integrationBranch}`;
  const remoteIntegrationHead = await lsRemoteHead(owned.root, options.remote, options.integrationBranch);
  invariant(
    remoteIntegrationHead === expectedBaseSha,
    "INTEGRATION_BASE_DIVERGED",
    "Refusing to integrate: remote integration branch moved off the expected base",
    { expected: expectedBaseSha, actual: remoteIntegrationHead },
  );
  await run("git", ["push", "--porcelain", options.remote, `${integratedSha}:${remoteRef}`], { cwd: owned.root });
  const remoteHead = await lsRemoteHead(owned.root, options.remote, options.integrationBranch);
  invariant(remoteHead === integratedSha, "INTEGRATION_SHA_MISMATCH", "Remote integration branch has an unexpected revision", {
    expected: integratedSha,
    actual: remoteHead,
  });
  invariant((await resolveTree(owned.root, integratedSha)) === candidateTree, "INTEGRATED_TREE_MISMATCH", "Integrated content changed unexpectedly");
  await assertExactClean(owned.root, candidateSha);

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
  const owned = await resolveOwnedWorkspace(options.cwd, options.ownershipId);
  // Spec #104 / ticket #106: pre-mutation runtime identity guard.
  // `workspace cleanup` is the owned-cleanup surface; the running
  // package must equal the durable `manifest.poiesisVersion` before
  // any branch / marker / worktree teardown runs.
  await (await import("./maintenance.js")).assertRuntimeVersionMatchesProject(owned.marker.repositoryRoot);
  invariant(
    owned.marker.branch !== owned.marker.integrationBranch,
    "INTEGRATION_WORKSPACE_CLEANUP_FORBIDDEN",
    "Refusing to clean an integration branch workspace",
  );
  const branch = await assertOwnedBranch(owned);
  const headSha = await resolveCommit(owned.root, "HEAD");
  if (options.expectedHeadSha !== undefined) {
    const expected = await resolveExpectedCommit(owned.root, options.expectedHeadSha, "expectedHeadSha");
    invariant(headSha === expected, "WORKSPACE_HEAD_MISMATCH", "Workspace HEAD changed before cleanup", {
      expected,
      actual: headSha,
    });
  }
  const status = await gitStatus(owned.root);
  invariant(status.length === 0, "DIRTY_WORKSPACE_CLEANUP_FORBIDDEN", "Refusing to clean a dirty or untracked workspace", {
    status: status.map(statusEntryForEvidence),
  });

  let delivery: WorkspaceCleanupResult["delivery"] | null = null;
  if (options.deliveredSha !== undefined) {
    validateSha(options.deliveredSha, "deliveredSha");
    const deliveredSha = await resolveExpectedCommit(owned.root, options.deliveredSha, "deliveredSha");
    const fetchedIntegration = await fetchIntegrationBase(
      owned.root,
      owned.marker.remote,
      owned.marker.integrationBranch,
    );
    const deliveredIsRemote = await run("git", ["merge-base", "--is-ancestor", deliveredSha, fetchedIntegration], {
      cwd: owned.root,
      allowFailure: true,
    });
    const sameTree = (await resolveTree(owned.root, deliveredSha)) === (await resolveTree(owned.root, headSha));
    if (deliveredIsRemote.exitCode === 0 && sameTree) delivery = "integrated-tree";
  }
  invariant(
    delivery !== null,
    "UNDELIVERED_COMMITS",
    "Refusing to clean a workspace with unique undelivered commits",
    { branch, headSha },
  );

  const publishedHead = await lsRemoteHead(owned.root, owned.marker.remote, branch);
  if (publishedHead !== null) {
    invariant(publishedHead === headSha, "REMOTE_BRANCH_CHANGED", "Published change branch changed before cleanup", {
      expected: headSha,
      actual: publishedHead,
    });
    const remoteRef = `refs/heads/${branch}`;
    await run("git", ["push", "--porcelain", owned.marker.remote, `:${remoteRef}`], { cwd: owned.root });
    const verifyGone = await lsRemoteHead(owned.root, owned.marker.remote, branch);
    invariant(
      verifyGone === null,
      "REMOTE_BRANCH_NOT_DELETED",
      "Remote change branch could not be removed",
      { branch, remote: owned.marker.remote, actual: verifyGone },
    );
  }

  await run("git", ["worktree", "remove", owned.root], { cwd: owned.marker.repositoryRoot });
  const deleteRef = await run("git", ["update-ref", "-d", `refs/heads/${branch}`, headSha], {
    cwd: owned.marker.repositoryRoot,
    allowFailure: true,
  });
  invariant(deleteRef.exitCode === 0, "BRANCH_DELETE_FAILED", "Workspace was removed but its branch changed concurrently", {
    branch,
    headSha,
    stderr: bounded(deleteRef.stderr),
    markerPath: owned.markerPath,
  });
  await rm(owned.markerPath);
  return { path: owned.root, branch, headSha, markerPath: owned.markerPath, delivery };
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
  repositoryRoot: string,
  integratedSha: string,
  commands: string[],
  outputLimit: number | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<VerifyResult> {
  const path = join(tmpdir(), `poiesis-integrate-${randomUUID()}`);
  invariant(!(await pathExists(path)), "TEMPORARY_WORKTREE_COLLISION", "Temporary integration worktree path exists", {
    path,
  });
  await run("git", ["worktree", "add", "--detach", path, integratedSha], { cwd: repositoryRoot });
  let result: VerifyResult | null = null;
  let failure: unknown;
  try {
    const verifyOptions: VerifyOptions = { cwd: path, candidateSha: integratedSha, commands };
    if (outputLimit !== undefined) verifyOptions.outputLimit = outputLimit;
    if (env !== undefined) verifyOptions.env = env;
    result = await verify(verifyOptions);
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
  if (failure !== undefined) throw failure;
  invariant(result !== null, "POST_INTEGRATION_VERIFY_FAILED", "Post-integration verification returned no result");
  return result;
}

async function canonicalGitRoot(cwd: string): Promise<string> {
  return realpath(await resolveGitRoot(cwd));
}

async function gitCommonDir(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--git-common-dir"], { cwd });
  return realpath(isAbsolute(result.stdout) ? result.stdout : resolve(cwd, result.stdout));
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

async function currentBranch(cwd: string): Promise<string | null> {
  const result = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout : null;
}

async function assertOwnedBranch(owned: OwnedWorkspace): Promise<string> {
  const branch = await currentBranch(owned.root);
  invariant(branch !== null, "DETACHED_OWNED_WORKSPACE", "Owned workspace is unexpectedly detached", {
    path: owned.root,
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
  const worktree = (await listWorktrees(owned.root)).find((entry) => entry.path === owned.root);
  invariant(worktree !== undefined, "WORKTREE_NOT_REGISTERED", "Owned workspace is not registered with Git");
  invariant(worktree.branch === branch, "WORKTREE_BRANCH_MISMATCH", "Registered worktree branch differs from ownership marker");
  return branch;
}

async function resolveOwnedWorkspace(cwd: string, ownershipId?: string): Promise<OwnedWorkspace> {
  const root = await canonicalGitRoot(cwd);
  const commonDir = await gitCommonDir(root);
  const matches = (await readMarkers(commonDir)).filter(({ marker }) => marker.workspacePath === root);
  invariant(matches.length === 1, "WORKSPACE_OWNERSHIP_UNKNOWN", "Cannot prove Poiesis owns this workspace", {
    path: root,
    matches: matches.length,
  });
  const owned = matches[0];
  invariant(owned !== undefined, "WORKSPACE_OWNERSHIP_UNKNOWN", "Cannot resolve workspace ownership");
  invariant(owned.marker.repositoryRoot !== root, "PRIMARY_CHECKOUT_OWNERSHIP_INVALID", "Ownership marker points at the primary checkout");
  invariant(
    (await gitCommonDir(owned.marker.repositoryRoot)) === commonDir,
    "WORKSPACE_REPOSITORY_MISMATCH",
    "Ownership marker belongs to a different Git repository",
  );
  if (ownershipId !== undefined) {
    invariant(
      owned.marker.ownershipId === ownershipId,
      "WORKSPACE_OWNERSHIP_ID_MISMATCH",
      "Workspace ownership identity does not match",
    );
  }
  return { root, commonDir, markerPath: owned.markerPath, marker: owned.marker };
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

async function gitStatus(cwd: string): Promise<string[]> {
  const result = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (!result.stdout) return [];
  const parts = result.stdout.split("\0").filter(Boolean);
  const entries: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry === undefined) continue;
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const source = parts[index + 1];
      invariant(source !== undefined, "INVALID_GIT_OUTPUT", "Git omitted a rename/copy source path");
      entries.push(`${entry}\0${source}`);
      index += 1;
    } else {
      entries.push(entry);
    }
  }
  return entries;
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

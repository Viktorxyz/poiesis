import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ticket #74 — wrap `run` in a vi.fn so the GitHub-provider tests can
// intercept `gh` calls while letting real git operations continue. The
// factory stashes the real runner on `globalThis` so re-imports after
// the (hoisted) `vi.mock` resolves can reach the un-wrapped impl; tests
// reset the mock implementation per `beforeEach`.
vi.mock("../src/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process.js")>();
  (globalThis as unknown as { __poiesisRealRun?: typeof actual.run }).__poiesisRealRun = actual.run;
  return {
    ...actual,
    run: vi.fn(actual.run),
  };
});

import { checkpoint, integrate, publish, resolveTree, verify, workspaceCleanup, workspacePrepare } from "../src/git.js";
import { createFixtureDeliveryAdapter } from "../src/adapters.js";
import { run, type RunResult } from "../src/process.js";
import { createTestRepository, proofShell, publishEvidence, type TestRepository } from "./helpers.js";

async function candidateTree(repository: TestRepository, sha: string): Promise<string> {
  return resolveTree(repository.root, sha);
}

describe("deterministic Git lifecycle", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("isolates dirty foreign work, preserves content through squash, and refuses rewrite attempts", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(join(repository.root, "foreign.txt"), "uncommitted user work\n");
    const workspacePath = join(repository.parent, "workspace");
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/spec-1",
      workspacePath,
      specId: "1",
    });
    expect(await readFile(join(repository.root, "foreign.txt"), "utf8")).toBe("uncommitted user work\n");

    await writeFile(join(workspace.path, "feature.txt"), "accepted feature\n");
    const before = workspace.headSha;
    await expect(
      checkpoint({
        cwd: workspace.path,
        paths: ["feature.txt"],
        message: "ticket 1",
        review: { verdict: "FAIL", reviewerIdentity: "review-1", evidence: "finding" } as never,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_REVIEW_NOT_ACCEPTED" });
    expect((await run("git", ["rev-parse", "HEAD"], { cwd: workspace.path })).stdout).toBe(before);

    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket 1",
      review: { verdict: "PASS", reviewerIdentity: "review-2", evidence: "no findings" },
    });
    const treeA = await candidateTree(repository, accepted.sha);
    await verify({ cwd: workspace.path, candidateSha: accepted.sha, commands: ["test -f feature.txt"] });
    expect((await run("git", ["ls-remote", "--heads", "origin", "refs/heads/poiesis/spec-1"], { cwd: workspace.path })).stdout).toBe("");

    await publish({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: accepted.sha,
      candidateTree: treeA,
      provider: "fixture",
      project: repository.fixtures,
      title: "Spec 1",
      body: "body",
      proof: proofShell(accepted.sha, treeA),
    });
    await expect(
      publish({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: accepted.sha,
        candidateTree: treeA,
        provider: "fixture",
        project: repository.fixtures,
        title: "Spec 1 rerun",
        body: "body",
        proof: proofShell(accepted.sha, treeA),
      }),
    ).resolves.toMatchObject({ action: "updated" });

    const delivery = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const preview = await delivery.preview({ sha: accepted.sha, candidateTree: treeA, proof: proofShell(accepted.sha, treeA), publish: publishEvidence(accepted.sha, treeA, "poiesis/spec-1"), remote: "origin" });
    const staging = await delivery.promote({
      sha: accepted.sha,
      target: "staging",
      candidateTree: treeA,
      identity: preview,
    });
    await expect(
      integrate({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        expectedBaseSha: workspace.baseSha,
        candidateSha: accepted.sha,
        candidateTree: treeA,
        message: "Spec 1: stale staging",
        proof: proofShell(accepted.sha, treeA),
        staging: { ...staging, candidateSha: workspace.baseSha },
        authorAcceptance: "Yes, this is what I wanted.",
      }),
    ).rejects.toMatchObject({ code: "STAGING_IDENTITY_MISMATCH" });
    const integrated = await integrate({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      expectedBaseSha: workspace.baseSha,
      candidateSha: accepted.sha,
      candidateTree: treeA,
      message: "Spec 1: accepted feature",
      proof: proofShell(accepted.sha, treeA),
      staging,
      authorAcceptance: "Yes, this is what I wanted.",
      postIntegrationCommands: ["test -f feature.txt"],
    });
    expect(integrated.integratedSha).not.toBe(accepted.sha);
    expect(integrated.integratedTree).toBe(integrated.candidateTree);
    expect(integrated.integration).toEqual({
      candidateSha: accepted.sha,
      candidateTree: treeA,
      integrationSha: integrated.integratedSha,
      integrationTree: integrated.integratedTree,
      contentMatchesCandidate: true,
    });
    const parents = (await run("git", ["rev-list", "--parents", "-n", "1", integrated.integratedSha], { cwd: workspace.path })).stdout.split(" ");
    expect(parents).toHaveLength(2);

    await expect(workspaceCleanup({ cwd: workspace.path })).rejects.toMatchObject({ code: "UNDELIVERED_COMMITS" });
    const cleaned = await workspaceCleanup({ cwd: workspace.path, deliveredSha: integrated.integratedSha });
    expect(cleaned.delivery).toBe("integrated-tree");
    expect((await run("git", ["ls-remote", "--heads", "origin", "refs/heads/poiesis/spec-1"], { cwd: repository.root })).stdout).toBe("");
  }, 30_000);

  it("rejects Proof from an older same-tree commit without publishing", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/proof-binding",
      workspacePath: join(repository.parent, "proof-binding-workspace"),
      specId: "proof-binding",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      paths: ["feature.txt"],
      message: "accepted candidate",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await candidateTree(repository, accepted.sha);
    await run("git", ["commit", "--quiet", "--allow-empty", "-m", "unreviewed same-tree candidate"], { cwd: workspace.path });
    const newerSha = (await run("git", ["rev-parse", "HEAD"], { cwd: workspace.path })).stdout;

    await expect(
      publish({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: newerSha,
        candidateTree: tree,
        provider: "fixture",
        project: repository.fixtures,
        title: "stale proof",
        body: "body",
        proof: proofShell(accepted.sha, tree),
      }),
    ).rejects.toMatchObject({ code: "PROOF_IDENTITY_MISMATCH" });
    expect((await run("git", ["ls-remote", "--heads", "origin", "refs/heads/poiesis/proof-binding"], { cwd: workspace.path })).stdout).toBe("");
  }, 30_000);

  it("fails closed on branch, worktree, and dirty cleanup collisions", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const workspacePath = join(repository.parent, "collision-workspace");
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/collision",
      workspacePath,
      specId: "collision",
    });
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch: "poiesis/collision",
        workspacePath: join(repository.parent, "other-workspace"),
        specId: "other",
      }),
    ).rejects.toMatchObject({ code: "OWNED_WORKSPACE_COLLISION" });
    await writeFile(join(workspace.path, "dirty.txt"), "keep\n");
    await expect(
      workspaceCleanup({ cwd: workspace.path, deliveredSha: repository.baseSha }),
    ).rejects.toMatchObject({ code: "DIRTY_WORKSPACE_CLEANUP_FORBIDDEN" });
    expect(await readFile(join(workspace.path, "dirty.txt"), "utf8")).toBe("keep\n");
  }, 30_000);

  it("rejects a stale integration base", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/stale",
      workspacePath: join(repository.parent, "stale-workspace"),
      specId: "stale",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const candidate = await checkpoint({
      cwd: workspace.path,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const treeB = await candidateTree(repository, candidate.sha);
    await publish({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: candidate.sha,
      candidateTree: treeB,
      provider: "fixture",
      project: repository.fixtures,
      title: "stale",
      body: "stale",
      proof: proofShell(candidate.sha, treeB),
    });

    const delivery = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const preview = await delivery.preview({ sha: candidate.sha, candidateTree: treeB, proof: proofShell(candidate.sha, treeB), publish: publishEvidence(candidate.sha, treeB, "poiesis/stale"), remote: "origin" });
    const staging = await delivery.promote({ sha: candidate.sha, target: "staging", candidateTree: treeB, identity: preview });

    await writeFile(join(repository.root, "base-change.txt"), "new base\n");
    await run("git", ["add", "base-change.txt"], { cwd: repository.root });
    await run("git", ["commit", "--quiet", "-m", "advance base"], { cwd: repository.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repository.root });
    await expect(
      integrate({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        expectedBaseSha: workspace.baseSha,
        candidateSha: candidate.sha,
        candidateTree: treeB,
        message: "stale",
        proof: proofShell(candidate.sha, treeB),
        staging,
        authorAcceptance: "accepted",
      }),
    ).rejects.toMatchObject({ code: "STALE_INTEGRATION_BASE" });
  }, 30_000);

  it("accepts fast-forward republish of the same change branch and refuses divergence", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/spec-2",
      workspacePath: join(repository.parent, "spec-2-workspace"),
      specId: "spec-2",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature v1\n");
    const acceptedV1 = await checkpoint({
      cwd: workspace.path,
      paths: ["feature.txt"],
      message: "ticket v1",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const treeV1 = await candidateTree(repository, acceptedV1.sha);
    const first = await publish({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: acceptedV1.sha,
      candidateTree: treeV1,
      provider: "fixture",
      project: repository.fixtures,
      title: "Spec 2 v1",
      body: "body",
      proof: proofShell(acceptedV1.sha, treeV1),
    });
    expect(first.action).toBe("pushed");

    await writeFile(join(workspace.path, "feature.txt"), "feature v2\n");
    const acceptedV2 = await checkpoint({
      cwd: workspace.path,
      paths: ["feature.txt"],
      message: "ticket v2",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const treeV2 = await candidateTree(repository, acceptedV2.sha);
    const fastForward = await publish({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: acceptedV2.sha,
      candidateTree: treeV2,
      provider: "fixture",
      project: repository.fixtures,
      title: "Spec 2 v2",
      body: "body",
      proof: proofShell(acceptedV2.sha, treeV2),
    });
    expect(fastForward.action).toBe("updated");

    const divergenceWorkspacePath = join(repository.parent, "spec-2-divergence-workspace");
    const divergenceWorkspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/spec-2-divergence",
      workspacePath: divergenceWorkspacePath,
      specId: "spec-2-divergence",
    });
    await run("git", ["fetch", "--quiet", "origin", acceptedV2.sha], { cwd: divergenceWorkspace.path });
    await run("git", ["reset", "--hard", acceptedV2.sha], { cwd: divergenceWorkspace.path, allowFailure: true });
    await writeFile(join(divergenceWorkspace.path, "feature.txt"), "foreign edit on remote\n");
    await run("git", ["add", "feature.txt"], { cwd: divergenceWorkspace.path });
    await run("git", ["commit", "--quiet", "-m", "foreign edit"], { cwd: divergenceWorkspace.path });
    const divergenceHead = (await run("git", ["rev-parse", "HEAD"], { cwd: divergenceWorkspace.path })).stdout;
    await run("git", ["push", "--quiet", "origin", `${divergenceHead}:refs/heads/poiesis/spec-2`], {
      cwd: divergenceWorkspace.path,
    });
    await expect(
      publish({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: acceptedV2.sha,
        candidateTree: treeV2,
        provider: "fixture",
        project: repository.fixtures,
        title: "Spec 2 rerun",
        body: "body",
        proof: proofShell(acceptedV2.sha, treeV2),
      }),
    ).rejects.toMatchObject({ code: "PUBLISHED_BRANCH_DIVERGED" });
  }, 30_000);

  it("accepts a default-path workspace on a normal branch (poiesis/greeting-command) and the primary checkout stays clean through prepare/cleanup", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // A normal-branch flow (no full Poiesis init) still needs the
    // `.poiesis/workspaces/` ignore rule so the nested workspace area
    // never appears as foreign work. The transactional gitignore seam
    // installed by `poiesis init` or `poiesis update --bootstrap-legacy-ownership`
    // provides this contract; mirror it here so the test exercises the
    // post-install state.
    await writeFile(
      join(repository.root, ".gitignore"),
      ".poiesis/manifest.json\n.poiesis/workspaces/\n",
    );
    await run("git", ["add", ".gitignore"], { cwd: repository.root });
    await run("git", ["commit", "--quiet", "-m", "gitignore"], { cwd: repository.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repository.root });

    // Add an unrelated foreign file so we can prove that default-path
    // prepare/cleanup do not introduce any new foreign work.
    await writeFile(join(repository.root, "foreign.txt"), "uncommitted user work\n");
    const beforeStatus = (await run("git", ["status", "--porcelain"], { cwd: repository.root })).stdout;
    expect(beforeStatus.trim()).toBe("?? foreign.txt");

    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/greeting-command",
      specId: "spec-greeting-command",
    });
    // The default path lives inside the project root so the harness can
    // read it without external_directory escalation.
    expect(workspace.path.startsWith(join(repository.root, ".poiesis", "workspaces"))).toBe(true);
    expect(workspace.branch).toBe("poiesis/greeting-command");

    // The nested default-path workspace area must NOT appear as foreign
    // work in the primary checkout. `?? foreign.txt` is the only line.
    const midStatus = (await run("git", ["status", "--porcelain"], { cwd: repository.root })).stdout;
    expect(midStatus.trim()).toBe("?? foreign.txt");

    // Clean up via the owned-workspace seam so the marker and worktree go
    // away. We need a delivered SHA to satisfy UNDELIVERED_COMMITS, so
    // promote through integrate using the existing fixture adapter.
    await writeFile(join(workspace.path, "greeting.txt"), "hello\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["greeting.txt"],
      message: "greeting ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    await publish({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: accepted.sha,
      candidateTree: tree,
      provider: "fixture",
      project: repository.fixtures,
      title: "Greeting command",
      body: "body",
      proof: proofShell(accepted.sha, tree),
    });
    const delivery = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const preview = await delivery.preview({ sha: accepted.sha, candidateTree: tree, proof: proofShell(accepted.sha, tree), publish: publishEvidence(accepted.sha, tree, "poiesis/greeting-command"), remote: "origin" });
    const staging = await delivery.promote({
      sha: accepted.sha,
      target: "staging",
      candidateTree: tree,
      identity: preview,
    });
    const integrated = await integrate({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      expectedBaseSha: workspace.baseSha,
      candidateSha: accepted.sha,
      candidateTree: tree,
      message: "default-path integrate",
      proof: proofShell(accepted.sha, tree),
      staging,
      authorAcceptance: "accepted",
    });
    const cleaned = await workspaceCleanup({
      cwd: workspace.path,
      deliveredSha: integrated.integratedSha,
    });
    expect(cleaned.delivery).toBe("integrated-tree");
    expect(cleaned.path).toBe(workspace.path);

    // After cleanup the primary checkout is back to the original
    // foreign-file-only status. No default-path residue leaks.
    const afterStatus = (await run("git", ["status", "--porcelain"], { cwd: repository.root })).stdout;
    expect(afterStatus.trim()).toBe("?? foreign.txt");
  }, 30_000);
});

// Ticket #74 — `gh pr list --json headRepository` may omit `nameWithOwner`
// (or omit the whole `headRepository` field) for same-repo PRs. The former
// failed closed with CHANGE_REQUEST_OWNERSHIP_MISMATCH against actual "",
// breaking legitimate re-publishes. These tests go through the real
// `publish()` flow with the GitHub provider and feed the `gh` responses
// via the `process.js` mock. Real git operations (push, ls-remote, etc.)
// continue to use the un-wrapped runner.
describe("GitHub provider headRepository handling", () => {
  const repositories: TestRepository[] = [];
  // ghResponse.queue holds the queued responses for each `gh` call. They
  // are consumed in order: list → create/edit → list (verify).
  let ghResponseQueue: RunResult[] = [];
  let realRun: typeof run;

  afterEach(async () => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockImplementation(realRun);
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  beforeEach(() => {
    const stash = (globalThis as unknown as { __poiesisRealRun?: typeof run }).__poiesisRealRun;
    if (stash === undefined) throw new Error("process.js mock factory did not stash the real runner");
    realRun = stash;
    ghResponseQueue = [];
    vi.mocked(run).mockReset();
    vi.mocked(run).mockImplementation(async (command, args, options) => {
      if (command === "gh") {
        const next = ghResponseQueue.shift();
        if (next === undefined) {
          throw new Error(`Unexpected gh call: gh ${args.join(" ")}`);
        }
        return next;
      }
      return await realRun(command, args, options);
    });
  });

  function ghResult(stdout: string, exitCode = 0): RunResult {
    return {
      command: "gh",
      args: [],
      exitCode,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      signal: null,
      durationMs: 0,
    };
  }

  // gh pr list returning a single PR with the given headRefOid and an
  // explicit headRepository payload. Pass `null` for `headRepository` to
  // produce JSON where the field is present with value `null`; pass
  // `undefined` to omit the field entirely.
  function ghListEntry(candidateSha: string, headRepository: unknown): RunResult {
    const entry: Record<string, unknown> = {
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      headRefOid: candidateSha,
    };
    if (headRepository !== undefined) entry.headRepository = headRepository;
    return ghResult(JSON.stringify([entry]));
  }

  function ghListEmpty(): RunResult {
    return ghResult("[]");
  }

  function ghPrCreateResponse(): RunResult {
    // `gh pr create` writes the new PR URL to stdout.
    return ghResult("https://github.com/owner/repo/pull/7\n");
  }

  function ghPrEditResponse(): RunResult {
    return ghResult("");
  }

  async function createWorkspaceWithCheckpoint(
    repository: TestRepository,
    specId: string,
  ): Promise<{ workspacePath: string; ownershipId: string; sha: string; tree: string }> {
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: `poiesis/${specId}`,
      workspacePath: join(repository.parent, `${specId}-workspace`),
      specId,
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await candidateTree(repository, accepted.sha);
    return {
      workspacePath: workspace.path,
      ownershipId: workspace.ownershipId,
      sha: accepted.sha,
      tree,
    };
  }

  it("treats an empty headRepository.nameWithOwner as matching options.project on republish", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const project = "owner/repo";
    const { workspacePath, ownershipId, sha, tree } = await createWorkspaceWithCheckpoint(repository, "gh-empty-headrepo");

    // First publish: gh has no PR yet → create one, then verify.
    ghResponseQueue.push(
      ghListEmpty(),
      ghPrCreateResponse(),
      ghListEntry(sha, { nameWithOwner: "" }),
    );
    const first = await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec",
      body: "body",
      proof: proofShell(sha, tree),
    });
    expect(first.action).toBe("created");

    // Second publish: gh now reports the PR with matching headRefOid but
    // an empty nameWithOwner. Before the fix this threw
    // CHANGE_REQUEST_OWNERSHIP_MISMATCH with actual "".
    ghResponseQueue.push(
      ghListEntry(sha, { nameWithOwner: "" }),
      ghPrEditResponse(),
      ghListEntry(sha, { nameWithOwner: "" }),
    );
    const second = await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec v2",
      body: "body",
      proof: proofShell(sha, tree),
    });
    expect(second.action).toBe("updated");
  }, 30_000);

  it("treats a missing headRepository field as matching options.project on republish", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const project = "owner/repo";
    const { workspacePath, ownershipId, sha, tree } = await createWorkspaceWithCheckpoint(repository, "gh-missing-headrepo");

    ghResponseQueue.push(
      ghListEmpty(),
      ghPrCreateResponse(),
      ghListEntry(sha, undefined),
    );
    await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec",
      body: "body",
      proof: proofShell(sha, tree),
    });

    // Second publish: headRepository field absent entirely.
    ghResponseQueue.push(
      ghListEntry(sha, undefined),
      ghPrEditResponse(),
      ghListEntry(sha, undefined),
    );
    const second = await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec v2",
      body: "body",
      proof: proofShell(sha, tree),
    });
    expect(second.action).toBe("updated");
  }, 30_000);

  it("still fails closed when headRepository.nameWithOwner differs from options.project", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const project = "owner/repo";
    const { workspacePath, ownershipId, sha, tree } = await createWorkspaceWithCheckpoint(repository, "gh-mismatch-headrepo");

    ghResponseQueue.push(
      ghListEmpty(),
      ghPrCreateResponse(),
      ghListEntry(sha, { nameWithOwner: "owner/repo" }),
    );
    await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec",
      body: "body",
      proof: proofShell(sha, tree),
    });

    // Second publish: gh returns a PR that points at a fork. Still mismatch.
    ghResponseQueue.push(ghListEntry(sha, { nameWithOwner: "fork/repo" }));
    await expect(
      publish({
        cwd: workspacePath,
        ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "github",
        project,
        title: "Spec v2",
        body: "body",
        proof: proofShell(sha, tree),
      }),
    ).rejects.toMatchObject({ code: "CHANGE_REQUEST_OWNERSHIP_MISMATCH" });
  }, 30_000);

  // Ticket #77 — verifyGitHubPullRequest must apply the same
  // headRepository ownership check as the initial existing-PR lookup.
  // The first final response (after `gh pr create`) only matching the
  // candidate SHA but reporting a different non-empty
  // headRepository.nameWithOwner must fail closed with
  // CHANGE_REQUEST_OWNERSHIP_MISMATCH, the same code already produced
  // by the initial-list lookup path.
  it("fails closed on mismatched headRepository in final verify response after gh pr create", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const project = "owner/repo";
    const { workspacePath, ownershipId, sha, tree } = await createWorkspaceWithCheckpoint(repository, "gh-create-verify-headrepo");

    // Initial list: no PR yet. gh pr create runs. The final verify
    // `gh pr list` reports a PR whose headRefOid matches the candidate
    // SHA but whose headRepository.nameWithOwner points at a fork.
    ghResponseQueue.push(
      ghListEmpty(),
      ghPrCreateResponse(),
      ghListEntry(sha, { nameWithOwner: "fork/repo" }),
    );
    await expect(
      publish({
        cwd: workspacePath,
        ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "github",
        project,
        title: "Spec",
        body: "body",
        proof: proofShell(sha, tree),
      }),
    ).rejects.toMatchObject({ code: "CHANGE_REQUEST_OWNERSHIP_MISMATCH" });
  }, 30_000);

  // Ticket #77 — same ownership check must run on the final verify
  // response after `gh pr edit`. The initial existing-PR lookup
  // accepts a same-repo PR and lets `gh pr edit` run; the final
  // verify must still close the door on a post-edit report from a
  // different repository.
  it("fails closed on mismatched headRepository in final verify response after gh pr edit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const project = "owner/repo";
    const { workspacePath, ownershipId, sha, tree } = await createWorkspaceWithCheckpoint(repository, "gh-edit-verify-headrepo");

    // First publish: everything matches.
    ghResponseQueue.push(
      ghListEmpty(),
      ghPrCreateResponse(),
      ghListEntry(sha, { nameWithOwner: "owner/repo" }),
    );
    await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec",
      body: "body",
      proof: proofShell(sha, tree),
    });

    // Second publish: initial list matches a same-repo PR, gh pr edit
    // runs, then the final verify `gh pr list` returns a PR whose
    // headRefOid matches the candidate SHA but whose
    // headRepository.nameWithOwner now points at a fork.
    ghResponseQueue.push(
      ghListEntry(sha, { nameWithOwner: "owner/repo" }),
      ghPrEditResponse(),
      ghListEntry(sha, { nameWithOwner: "fork/repo" }),
    );
    await expect(
      publish({
        cwd: workspacePath,
        ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "github",
        project,
        title: "Spec v2",
        body: "body",
        proof: proofShell(sha, tree),
      }),
    ).rejects.toMatchObject({ code: "CHANGE_REQUEST_OWNERSHIP_MISMATCH" });
  }, 30_000);

  // Ticket #77 — same/missing/empty headRepository.nameWithOwner on
  // the final verify response must still pass after the new check is
  // wired in. These guard against accidentally closing the door on
  // legitimate same-repo reports on either the create or edit path.
  it("still accepts matching/missing/empty headRepository on final verify after gh pr create and edit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const project = "owner/repo";
    const { workspacePath, ownershipId, sha, tree } = await createWorkspaceWithCheckpoint(repository, "gh-verify-headrepo-same");

    // Create path: final verify returns a same-repo PR.
    ghResponseQueue.push(
      ghListEmpty(),
      ghPrCreateResponse(),
      ghListEntry(sha, { nameWithOwner: "owner/repo" }),
    );
    await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec",
      body: "body",
      proof: proofShell(sha, tree),
    });

    // Edit path, empty nameWithOwner on the final verify.
    ghResponseQueue.push(
      ghListEntry(sha, { nameWithOwner: "owner/repo" }),
      ghPrEditResponse(),
      ghListEntry(sha, { nameWithOwner: "" }),
    );
    const second = await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec v2",
      body: "body",
      proof: proofShell(sha, tree),
    });
    expect(second.action).toBe("updated");

    // Edit path, missing headRepository field on the final verify.
    ghResponseQueue.push(
      ghListEntry(sha, { nameWithOwner: "owner/repo" }),
      ghPrEditResponse(),
      ghListEntry(sha, undefined),
    );
    const third = await publish({
      cwd: workspacePath,
      ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "github",
      project,
      title: "Spec v3",
      body: "body",
      proof: proofShell(sha, tree),
    });
    expect(third.action).toBe("updated");
  }, 30_000);
});

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpoint, integrate, publish, resolveTree, verify, workspaceCleanup, workspacePrepare } from "../src/git.js";
import { createFixtureDeliveryAdapter } from "../src/adapters.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, stagingShell, type TestRepository } from "./helpers.js";

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
    ).rejects.toMatchObject({ code: "PUBLISHED_BRANCH_EXISTS" });

    const delivery = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const preview = await delivery.preview({ sha: accepted.sha, candidateTree: treeA, proof: proofShell(accepted.sha, treeA) });
    const staging = await delivery.promote({
      sha: accepted.sha,
      target: "staging",
      candidateTree: treeA,
      identity: preview,
      staging: stagingShell(accepted.sha, treeA),
    });
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
      staging: { ...stagingShell(accepted.sha, treeA), verified: true, artifactIdentity: staging.id! },
      authorAcceptance: "Yes, this is what I wanted.",
      postIntegrationCommands: ["test -f feature.txt"],
    });
    expect(integrated.integratedSha).not.toBe(accepted.sha);
    expect(integrated.integratedTree).toBe(integrated.candidateTree);
    const parents = (await run("git", ["rev-list", "--parents", "-n", "1", integrated.integratedSha], { cwd: workspace.path })).stdout.split(" ");
    expect(parents).toHaveLength(2);

    await expect(workspaceCleanup({ cwd: workspace.path })).rejects.toMatchObject({ code: "UNDELIVERED_COMMITS" });
    const cleaned = await workspaceCleanup({ cwd: workspace.path, deliveredSha: integrated.integratedSha });
    expect(cleaned.delivery).toBe("integrated-tree");
    expect((await run("git", ["ls-remote", "--heads", "origin", "refs/heads/poiesis/spec-1"], { cwd: repository.root })).stdout).toBe("");
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
        staging: { ...stagingShell(candidate.sha, treeB), verified: true },
        authorAcceptance: "accepted",
      }),
    ).rejects.toMatchObject({ code: "STALE_INTEGRATION_BASE" });
  }, 30_000);
});

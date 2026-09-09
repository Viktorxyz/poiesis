import { access, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureDeliveryAdapter, createFixtureTrackerAdapter } from "../src/adapters.js";
import { resolveTree } from "../src/git.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, type TestRepository } from "./helpers.js";

describe("tracker and delivery adapters", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("preserves Spec relationships and Replan history", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const tracker = createFixtureTrackerAdapter(repository.fixtures, repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "Canonical decisions" });
    const first = await tracker.createTicket({
      title: "Slice one",
      body: "Acceptance",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    const replacement = await tracker.createTicket({
      title: "Replacement",
      body: "Replanned acceptance",
      parentSpecId: spec.id,
      dependencyText: `supersedes ${first.id}`,
    });
    await tracker.commentSpec(spec.id, "Replan: evidence invalidated the prior assumption.");
    const superseded = await tracker.supersedeTicket(first.id, {
      reason: "Design evidence changed",
      replacementIds: [replacement.id],
    });
    expect(superseded.state).toBe("superseded");
    expect(superseded.parentSpecId).toBe(spec.id);
    expect(superseded.supersededBy).toEqual([replacement.id]);
  });

  it("requires content-equal Proof for Preview and explicit Production authorization", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    await expect(adapter.preview({ sha: "a".repeat(40), candidateTree: tree, proof: proofShell("a".repeat(40), tree) })).rejects.toMatchObject({ code: "DELIVERY_CANDIDATE_NOT_FOUND" });
    await expect(adapter.preview({ sha, candidateTree: "c".repeat(40), proof: proofShell(sha, "c".repeat(40)) })).rejects.toMatchObject({ code: "CANDIDATE_TREE_MISMATCH" });
    await expect(adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, "c".repeat(40)) })).rejects.toThrow();
    await run("git", ["commit", "--quiet", "--allow-empty", "-m", "same tree"], { cwd: repository.root });
    const sameTreeSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout;
    await expect(adapter.preview({ sha: sameTreeSha, candidateTree: tree, proof: proofShell(sha, tree) })).rejects.toMatchObject({ code: "PROOF_IDENTITY_MISMATCH" });
    const preview = await adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree) });
    const staging = await adapter.promote({
      sha,
      target: "staging",
      candidateTree: tree,
      identity: preview,
    });
    expect(staging.id).toBe(`fixture:staging:${sha}`);
    expect(staging).toMatchObject({ candidateSha: sha, candidateTree: tree, target: "staging", verified: true });
    const integration = { candidateSha: sha, candidateTree: tree, integrationSha: sha, integrationTree: tree, contentMatchesCandidate: true as const };
    const authorization = {
      candidateSha: sha,
      candidateTree: tree,
      stagingArtifactIdentity: staging.artifactIdentity,
      integrationSha: sha,
      authorIdentity: "author-session",
      approved: true as const,
    };
    await expect(
      adapter.promote({
        sha,
        target: "production",
        identity: staging,
        candidateTree: tree,
        productionAuthorization: undefined as never,
        integrationRemote: "origin",
        integrationBranch: "main",
        proof: proofShell(sha, tree),
        integration,
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_AUTHORIZATION_REQUIRED" });
    await expect(
      adapter.promote({
        sha,
        target: "production",
        candidateTree: tree,
        identity: preview,
        productionAuthorization: authorization,
        integrationRemote: "origin",
        integrationBranch: "main",
        proof: proofShell(sha, tree),
        integration,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_SOURCE_TARGET_MISMATCH" });
    await expect(
      adapter.promote({
        sha: sameTreeSha,
        target: "production",
        candidateTree: tree,
        identity: { ...staging, sha: sameTreeSha, candidateSha: sameTreeSha },
        productionAuthorization: { ...authorization, candidateSha: sameTreeSha, integrationSha: sameTreeSha },
        integrationRemote: "origin",
        integrationBranch: "main",
        proof: proofShell(sameTreeSha, tree),
        integration: { ...integration, candidateSha: sameTreeSha, integrationSha: sameTreeSha },
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_INTEGRATION_HEAD_MISMATCH" });
    await expect(
      adapter.promote({
        sha,
        target: "production",
        candidateTree: tree,
        identity: staging,
        productionAuthorization: { ...authorization, stagingArtifactIdentity: "another-artifact" },
        integrationRemote: "origin",
        integrationBranch: "main",
        proof: proofShell(sha, tree),
        integration,
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_AUTHORIZATION_STAGING_MISMATCH" });
    const production = await adapter.promote({
      sha,
      target: "production",
      candidateTree: tree,
      identity: staging,
      productionAuthorization: authorization,
      integrationRemote: "origin",
      integrationBranch: "main",
      proof: proofShell(sha, tree),
      integration,
    });
    expect(production.sha).toBe(sha);
  });

  it("verifies the canonical integration commit tree before Production", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const preview = await adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree) });
    const staging = await adapter.promote({ sha, target: "staging", candidateTree: tree, identity: preview });

    await writeFile(`${repository.root}/README.md`, "different integration tree\n");
    await run("git", ["add", "README.md"], { cwd: repository.root });
    await run("git", ["commit", "--quiet", "-m", "different integration tree"], { cwd: repository.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repository.root });
    const integrationSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout;

    await expect(adapter.promote({
      sha,
      target: "production",
      candidateTree: tree,
      identity: staging,
      productionAuthorization: {
        candidateSha: sha,
        candidateTree: tree,
        stagingArtifactIdentity: staging.artifactIdentity,
        integrationSha,
        authorIdentity: "author-session",
        approved: true,
      },
      integrationRemote: "origin",
      integrationBranch: "main",
      proof: proofShell(sha, tree),
      integration: { candidateSha: sha, candidateTree: tree, integrationSha, integrationTree: tree, contentMatchesCandidate: true },
    })).rejects.toMatchObject({ code: "PRODUCTION_INTEGRATION_TREE_MISMATCH" });
    await expect(access(`${repository.fixtures}/production`)).rejects.toThrow();
  });
});

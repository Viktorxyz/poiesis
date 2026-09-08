import { rm } from "node:fs/promises";
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
    await expect(
      adapter.promote({ sha, target: "production", identity: staging, candidateTree: tree } as never),
    ).rejects.toMatchObject({ code: "PRODUCTION_AUTHORIZATION_REQUIRED" });
    await expect(
      adapter.promote({
        sha,
        target: "production",
        candidateTree: tree,
        identity: preview,
        productionAuthorization: "Author said yes",
        proof: proofShell(sha, tree),
        integration: { candidateSha: sha, candidateTree: tree, integrationSha: sha, integrationTree: tree, contentMatchesCandidate: true },
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_SOURCE_TARGET_MISMATCH" });
    const production = await adapter.promote({
      sha,
      target: "production",
      candidateTree: tree,
      identity: staging,
      productionAuthorization: "Author said yes",
      proof: proofShell(sha, tree),
      integration: { candidateSha: sha, candidateTree: tree, integrationSha: sha, integrationTree: tree, contentMatchesCandidate: true },
    });
    expect(production.sha).toBe(sha);
  });
});

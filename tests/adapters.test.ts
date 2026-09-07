import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureDeliveryAdapter, createFixtureTrackerAdapter } from "../src/adapters.js";
import { createTestRepository, proofShell, stagingShell, type TestRepository } from "./helpers.js";

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
    const sha = "a".repeat(40);
    const tree = "b".repeat(40);
    await expect(adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, "c".repeat(40)) })).rejects.toThrow();
    const preview = await adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree) });
    const staging = await adapter.promote({
      sha,
      target: "staging",
      candidateTree: tree,
      identity: preview,
      staging: stagingShell(sha, tree),
    });
    expect(staging.id).toBe(`artifact:${sha}`);
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
        staging: { artifactIdentity: "staging-artifact", verified: true, candidateTree: tree },
        integration: { candidateTree: tree, integrationSha: "c".repeat(40), integrationTree: tree, contentMatchesCandidate: true },
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_STAGING_IDENTITY_MISMATCH" });
    const production = await adapter.promote({
      sha,
      target: "production",
      candidateTree: tree,
      identity: staging,
      productionAuthorization: "Author said yes",
      proof: proofShell(sha, tree),
      staging: stagingShell(sha, tree),
      integration: { candidateTree: tree, integrationSha: "c".repeat(40), integrationTree: tree, contentMatchesCandidate: true },
    });
    expect(production.sha).toBe(sha);
  });
});

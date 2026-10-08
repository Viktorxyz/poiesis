/**
 * Spec #139 / ticket #188 — `createFixtureDeliveryAdapter` is a PACKAGE-PUBLIC
 * factory, so the adapter it returns carries the delivery authority guard: these
 * tests drive `preview` / `promote` on the adapter a consumer gets, and that
 * adapter is only permitted to run in an installation Poiesis actually owns.
 * The repository is therefore installed (manifest + configured `delivery`) with
 * `skipSkills` / `allowFixtureAdapters` so the delivery-evidence contract under
 * test stays fast. The refusal half of the same contract — a deferred install
 * refused through this very factory, before any remote revalidation, subprocess,
 * filesystem artifact, or evidence — is pinned in
 * `tests/deferred-delivery-lifecycle.test.ts`.
 */
import { access, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureDeliveryAdapter, createFixtureTrackerAdapter } from "../src/adapters.js";
import { resolveTree } from "../src/git.js";
import { init } from "../src/maintenance.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

async function installedTestRepository(repositories: TestRepository[]): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
  return repository;
}

describe("tracker and delivery adapters", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  beforeEach(async () => {
    env = await installFakeOpenCode();
  });
  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("preserves Spec relationships and Replan history", async () => {
    const repository = await installedTestRepository(repositories);
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
    const repository = await installedTestRepository(repositories);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/adapters-test";
    await run("git", ["push", "--quiet", "origin", `${sha}:refs/heads/${branch}`], { cwd: repository.root });
    const publish = publishEvidence(sha, tree, branch);
    await expect(adapter.preview({ sha: "a".repeat(40), candidateTree: tree, proof: proofShell("a".repeat(40), tree), publish, remote: "origin" })).rejects.toMatchObject({ code: "DELIVERY_CANDIDATE_NOT_FOUND" });
    await expect(adapter.preview({ sha, candidateTree: "c".repeat(40), proof: proofShell(sha, "c".repeat(40)), publish, remote: "origin" })).rejects.toMatchObject({ code: "CANDIDATE_TREE_MISMATCH" });
    await expect(adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, "c".repeat(40)), publish, remote: "origin" })).rejects.toThrow();
    await run("git", ["commit", "--quiet", "--allow-empty", "-m", "same tree"], { cwd: repository.root });
    const sameTreeSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout;
    await expect(adapter.preview({ sha: sameTreeSha, candidateTree: tree, proof: proofShell(sha, tree), publish, remote: "origin" })).rejects.toMatchObject({ code: "PROOF_IDENTITY_MISMATCH" });
    const preview = await adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree), publish, remote: "origin" });
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
    const repository = await installedTestRepository(repositories);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/adapters-integration";
    await run("git", ["push", "--quiet", "origin", `${sha}:refs/heads/${branch}`], { cwd: repository.root });
    const preview = await adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree), publish: publishEvidence(sha, tree, branch), remote: "origin" });
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

import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProject } from "../src/inspect.js";
import {
  validateIntegrationEvidence,
  validateProductionAuthorization,
  validateProofEvidence,
  validateStagingEvidence,
  type ProofEvidence,
  type StagingEvidence,
} from "../src/evidence.js";
import { createCommandDeliveryAdapter } from "../src/adapters.js";
import { resolveTree } from "../src/git.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell } from "./helpers.js";

const fixtures: string[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop()!;
    await rm(path, { recursive: true, force: true });
  }
});

async function createInspectRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-inspect-"));
  fixtures.push(parent);
  const root = join(parent, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.test"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fixture", version: "0.0.0", scripts: { test: "true" },
    dependencies: { react: "*", hono: "*" },
  }));
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await run("git", ["add", "package.json"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  return root;
}

describe("inspect", () => {
  it("resolves from a nested working directory and reports project facts", async () => {
    const root = await createInspectRepo();
    const inspection = await inspectProject(join(root, "src"));
    expect(inspection.git.root).toBe(root);
    expect(inspection.languages).toContain("TypeScript");
    expect(inspection.frameworks).toContain("react");
    expect(inspection.frameworks).toContain("hono");
    expect(inspection.scripts.test).toBe("true");
    expect(inspection.poiesis.installed).toBe(false);
  });
});

describe("evidence validation", () => {
  const tree = "b".repeat(40);
  const proof = (sha: string): ProofEvidence => ({
    candidateSha: sha,
    candidateTree: tree,
    verified: true,
    specReview: { verdict: "PASS", reviewerIdentity: "spec-reviewer" },
    standardsReview: { verdict: "PASS", reviewerIdentity: "standards-reviewer" },
  });

  it("rejects Proof belonging to a different candidate", () => {
    expect(() => validateProofEvidence(proof("a".repeat(40)), "b".repeat(40), tree)).toThrow(/different candidate/);
    expect(() => validateProofEvidence(proof("a".repeat(40)), "a".repeat(40), "c".repeat(40))).toThrow(/different candidate tree/);
  });

  it("rejects incomplete Proof and missing reviewer identity", () => {
    expect(() => validateProofEvidence({ ...proof("a".repeat(40)), verified: false } as unknown as ProofEvidence, "a".repeat(40), tree)).toThrow(/verification has not passed/);
    expect(() => validateProofEvidence({ ...proof("a".repeat(40)), specReview: { verdict: "PASS", reviewerIdentity: " " } }, "a".repeat(40), tree)).toThrow(/identity is required/);
    expect(() => validateProofEvidence(null as unknown as ProofEvidence, "a".repeat(40), tree)).toThrow(/must be an object/);
  });

  it("rejects Staging identity mismatch and unverified staging", () => {
    const sha = "a".repeat(40);
    expect(() => validateStagingEvidence({ candidateSha: sha, candidateTree: tree, target: "staging", verified: true, artifactIdentity: "" } satisfies StagingEvidence, sha, tree)).toThrow(/Staging artifact identity is required/);
    expect(() => validateStagingEvidence({ candidateSha: sha, candidateTree: tree, target: "staging", verified: false, artifactIdentity: "x" } as unknown as StagingEvidence, sha, tree)).toThrow(/verification has not passed/);
    expect(() => validateStagingEvidence({ candidateSha: "c".repeat(40), candidateTree: tree, target: "staging", verified: true, artifactIdentity: "x" }, sha, tree)).toThrow(/different candidate/);
    expect(() => validateStagingEvidence({ candidateSha: sha, candidateTree: "c".repeat(40), target: "staging", verified: true, artifactIdentity: "x" }, sha, tree)).toThrow(/different candidate tree/);
  });

  it("rejects Integration evidence that does not prove content equality", () => {
    const candidateSha = "a".repeat(40);
    const candidateTree = "a".repeat(40);
    expect(() => validateIntegrationEvidence({ candidateSha, candidateTree: "b".repeat(40), integrationSha: "c".repeat(40), integrationTree: "b".repeat(40), contentMatchesCandidate: true }, candidateSha, candidateTree)).toThrow(/does not match the accepted candidate tree/);
    expect(() => validateIntegrationEvidence({ candidateSha, candidateTree, integrationSha: "not-a-sha", integrationTree: candidateTree, contentMatchesCandidate: true }, candidateSha, candidateTree)).toThrow(/Exact integrated revision is required/);
    expect(() => validateIntegrationEvidence({ candidateSha, candidateTree, integrationSha: "c".repeat(40), integrationTree: "d".repeat(40), contentMatchesCandidate: true }, candidateSha, candidateTree)).toThrow(/Integrated tree does not match/);
    expect(() => validateIntegrationEvidence({ candidateSha, candidateTree, integrationSha: "c".repeat(40), integrationTree: candidateTree, contentMatchesCandidate: false } as never, candidateSha, candidateTree)).toThrow(/Integrated content has not been proven/);
    expect(() => validateIntegrationEvidence({ candidateSha: "z".repeat(40), candidateTree, integrationSha: "c".repeat(40), integrationTree: candidateTree, contentMatchesCandidate: true }, candidateSha, candidateTree)).toThrow(/different candidate/);
    expect(() => validateIntegrationEvidence(null as never, candidateSha, candidateTree)).toThrow(/must be an object/);
  });

  it("binds Production authorization to candidate, Staging, and integration identities", () => {
    const candidateSha = "a".repeat(40);
    const candidateTree = "b".repeat(40);
    const staging = { candidateSha, candidateTree, target: "staging" as const, artifactIdentity: "artifact", verified: true as const };
    const integration = { candidateSha, candidateTree, integrationSha: "c".repeat(40), integrationTree: candidateTree, contentMatchesCandidate: true as const };
    const authorization = {
      candidateSha,
      candidateTree,
      stagingArtifactIdentity: staging.artifactIdentity,
      integrationSha: integration.integrationSha,
      authorIdentity: "author-session",
      approved: true as const,
    };
    expect(() => validateProductionAuthorization(authorization, candidateSha, candidateTree, staging, integration)).not.toThrow();
    expect(() => validateProductionAuthorization({ ...authorization, candidateSha: "d".repeat(40) }, candidateSha, candidateTree, staging, integration)).toThrow(/different candidate/);
    expect(() => validateProductionAuthorization({ ...authorization, stagingArtifactIdentity: "other" }, candidateSha, candidateTree, staging, integration)).toThrow(/different Staging artifact/);
    expect(() => validateProductionAuthorization({ ...authorization, integrationSha: "e".repeat(40) }, candidateSha, candidateTree, staging, integration)).toThrow(/different integration revision/);
    expect(() => validateProductionAuthorization({ ...authorization, authorIdentity: " " }, candidateSha, candidateTree, staging, integration)).toThrow(/Author identity/);
  });
});

describe("CommandDeliveryAdapter", () => {
  it("substitutes {sha} and {target} and forwards candidate identity to the delivery command", async () => {
    const repository = await createTestRepository();
    fixtures.push(repository.parent);
    const parent = repository.parent;
    const root = repository.root;
    const sha = repository.baseSha;
    const tree = await resolveTree(root, sha);
    const receiptScript = join(parent, "delivery-receipt.sh");
    await writeFile(receiptScript, "#!/bin/sh\ncat <<JSON\n{\"status\":\"created\",\"url\":\"https://example.com/$POIESIS_DELIVERY_TARGET/$POIESIS_CANDIDATE_SHA\",\"artifactIdentity\":\"https://example.com/$POIESIS_DELIVERY_TARGET/$POIESIS_CANDIDATE_SHA\",\"sha\":\"$POIESIS_CANDIDATE_SHA\",\"candidateTree\":\"$POIESIS_CANDIDATE_TREE\",\"target\":\"$POIESIS_DELIVERY_TARGET\",\"verified\":true}\nJSON\n");
    await chmod(receiptScript, 0o755);
    const adapter = createCommandDeliveryAdapter(
      { adapter: "command", command: [receiptScript, "deploy", "{target}", "{sha}"] },
      root,
    );
    const preview = await adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree) });
    expect(preview.url).toBe(`https://example.com/preview/${sha}`);
    expect(preview.artifactIdentity).toBe(preview.url);
  });

  it("rejects incomplete or inconsistent command receipts", async () => {
    const repository = await createTestRepository();
    fixtures.push(repository.parent);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const receiptScript = join(repository.parent, "incomplete-delivery-receipt.sh");
    await writeFile(receiptScript, "#!/bin/sh\ncat <<JSON\n{\"id\":\"artifact-$POIESIS_CANDIDATE_SHA\",\"artifactIdentity\":\"artifact-$POIESIS_CANDIDATE_SHA\",\"sha\":\"$POIESIS_CANDIDATE_SHA\",\"target\":\"$POIESIS_DELIVERY_TARGET\",\"verified\":true}\nJSON\n");
    await chmod(receiptScript, 0o755);
    const adapter = createCommandDeliveryAdapter(
      { adapter: "command", command: [receiptScript, "{target}", "{sha}"] },
      repository.root,
    );

    await expect(adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree) })).rejects.toMatchObject({
      code: "DELIVERY_TREE_MISMATCH",
    });

    await writeFile(receiptScript, "#!/bin/sh\ncat <<JSON\n{\"id\":\"artifact-$POIESIS_CANDIDATE_SHA\",\"artifactIdentity\":\"different-artifact\",\"sha\":\"$POIESIS_CANDIDATE_SHA\",\"candidateTree\":\"$POIESIS_CANDIDATE_TREE\",\"target\":\"$POIESIS_DELIVERY_TARGET\",\"verified\":true}\nJSON\n");
    await expect(adapter.preview({ sha, candidateTree: tree, proof: proofShell(sha, tree) })).rejects.toMatchObject({
      code: "DELIVERY_ARTIFACT_IDENTITY_MISMATCH",
    });
  });

  it("never invokes the Production command for invalid authorization or integration evidence", async () => {
    const repository = await createTestRepository();
    fixtures.push(repository.parent);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const sentinel = join(repository.parent, "production-invoked");
    const command = join(repository.parent, "production-command.sh");
    await writeFile(command, `#!/bin/sh\ntouch "${sentinel}"\nexit 70\n`);
    await chmod(command, 0o755);
    const adapter = createCommandDeliveryAdapter({ adapter: "command", command: [command, "{target}", "{sha}"] }, repository.root);
    const staging = {
      sha,
      candidateSha: sha,
      candidateTree: tree,
      target: "staging" as const,
      artifactIdentity: "staging-artifact",
      verified: true as const,
      id: "staging-artifact",
    };
    const integration = { candidateSha: sha, candidateTree: tree, integrationSha: sha, integrationTree: tree, contentMatchesCandidate: true as const };
    const authorization = {
      candidateSha: sha,
      candidateTree: tree,
      stagingArtifactIdentity: staging.artifactIdentity,
      integrationSha: sha,
      authorIdentity: "author-session",
      approved: true as const,
    };
    const valid = {
      sha,
      target: "production" as const,
      candidateTree: tree,
      identity: staging,
      productionAuthorization: authorization,
      integrationRemote: "origin",
      integrationBranch: "main",
      proof: proofShell(sha, tree),
      integration,
    };

    await expect(adapter.promote({ ...valid, productionAuthorization: undefined as never })).rejects.toMatchObject({ code: "PRODUCTION_AUTHORIZATION_REQUIRED" });
    await expect(adapter.promote({ ...valid, integrationRemote: "--append" })).rejects.toMatchObject({ code: "INVALID_REMOTE_NAME" });
    await expect(adapter.promote({ ...valid, integrationBranch: "--bad" })).rejects.toMatchObject({ code: "INVALID_BRANCH_NAME" });
    await run("git", ["commit", "--quiet", "--allow-empty", "-m", "same tree"], { cwd: repository.root });
    const staleIntegrationSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout;
    await expect(adapter.promote({
      ...valid,
      integration: { ...integration, integrationSha: staleIntegrationSha },
      productionAuthorization: { ...authorization, integrationSha: staleIntegrationSha },
    })).rejects.toMatchObject({ code: "PRODUCTION_INTEGRATION_HEAD_MISMATCH" });

    await writeFile(join(repository.root, "README.md"), "different integration tree\n");
    await run("git", ["add", "README.md"], { cwd: repository.root });
    await run("git", ["commit", "--quiet", "-m", "different integration tree"], { cwd: repository.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repository.root });
    const differentTreeSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout;
    await expect(adapter.promote({
      ...valid,
      integration: { ...integration, integrationSha: differentTreeSha },
      productionAuthorization: { ...authorization, integrationSha: differentTreeSha },
    })).rejects.toMatchObject({ code: "PRODUCTION_INTEGRATION_TREE_MISMATCH" });
    await expect(access(sentinel)).rejects.toThrow();
  });
});

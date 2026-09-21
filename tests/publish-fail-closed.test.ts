import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publish, resolveTree, workspacePrepare, checkpoint } from "../src/git.js";
import { init } from "../src/maintenance.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/**
 * Publish fail-closed behavior.
 *
 * Ticket #39 acceptance criterion: "Any rejected Publish or Preview is
 * fail-closed." This file exercises the Publish path specifically.
 *
 * Each test proves a single invariant: when Publish is rejected for a
 * deterministic reason, the runtime throws a PoiesisError rather than
 * returning a successful PublishResult. Poiesis uses the thrown error
 * code to detect that no Preview identity exists; if Publish ever
 * returned a successful result without verifying the contract, Poiesis
 * could believe a Preview had been created when it had not.
 */

const repositories: TestRepository[] = [];
let env: FakeOpenCodeEnvironment | undefined;

/**
 * Spec #104 / ticket #110: guarded Git lifecycle mutations cross the
 * runtime identity boundary; the shared guard fails closed on an
 * absent manifest. The publish-fail-closed tests exercise
 * `workspacePrepare` + `checkpoint` + `publish`, all of which are
 * guarded; they must install Poiesis first so the guard's
 * manifest-match branch succeeds. The init uses `skipSkills: true`
 * and `allowFixtureAdapters: true` to keep the lifecycle tests fast.
 */
async function installedTestRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
  return repository;
}

beforeEach(async () => {
  env = await installFakeOpenCode();
});

afterEach(async () => {
  env?.restore();
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

describe("publish fail-closed invariants", () => {
  it("rejects Publish with a malformed proof missing specReview identity", async () => {
    const repository = await installedTestRepository();
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/failclosed-publish-proof",
      workspacePath: join(repository.parent, "workspace"),
      specId: "1",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    const brokenProof = {
      candidateSha: accepted.sha,
      candidateTree: tree,
      verified: true as const,
      specReview: { verdict: "PASS" as const, reviewerIdentity: "" },
      standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards" },
    };
    await expect(
      publish({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: accepted.sha,
        candidateTree: tree,
        provider: "fixture",
        project: repository.fixtures,
        title: "ticket",
        body: "body",
        proof: brokenProof,
      }),
    ).rejects.toMatchObject({ code: "PROOF_REVIEW_IDENTITY_MISSING" });
  });

  it("rejects Publish with a proof carrying a different candidate identity than the candidate SHA", async () => {
    const repository = await installedTestRepository();
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/failclosed-publish-mismatch",
      workspacePath: join(repository.parent, "workspace2"),
      specId: "2",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    const brokenProof = {
      candidateSha: "a".repeat(40),
      candidateTree: tree,
      verified: true as const,
      specReview: { verdict: "PASS" as const, reviewerIdentity: "spec" },
      standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards" },
    };
    await expect(
      publish({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: accepted.sha,
        candidateTree: tree,
        provider: "fixture",
        project: repository.fixtures,
        title: "ticket",
        body: "body",
        proof: brokenProof,
      }),
    ).rejects.toMatchObject({ code: "PROOF_IDENTITY_MISMATCH" });
  });

  it("rejects Publish when the proof is not yet verified (verified:false)", async () => {
    const repository = await installedTestRepository();
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/failclosed-publish-unverified",
      workspacePath: join(repository.parent, "workspace3"),
      specId: "3",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    const brokenProof = {
      candidateSha: accepted.sha,
      candidateTree: tree,
      verified: false as unknown as true,
      specReview: { verdict: "PASS" as const, reviewerIdentity: "spec" },
      standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards" },
    };
    await expect(
      publish({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: accepted.sha,
        candidateTree: tree,
        provider: "fixture",
        project: repository.fixtures,
        title: "ticket",
        body: "body",
        proof: brokenProof,
      }),
    ).rejects.toMatchObject({ code: "PROOF_INCOMPLETE" });
  });

  it("rejects Publish with a proof whose standardsReview verdict is not PASS", async () => {
    const repository = await installedTestRepository();
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/failclosed-publish-standards",
      workspacePath: join(repository.parent, "workspace4"),
      specId: "4",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    const brokenProof = {
      candidateSha: accepted.sha,
      candidateTree: tree,
      verified: true as const,
      specReview: { verdict: "PASS" as const, reviewerIdentity: "spec" },
      standardsReview: { verdict: "FAIL" as unknown as "PASS", reviewerIdentity: "standards" },
    };
    await expect(
      publish({
        cwd: workspace.path,
        ownershipId: workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: accepted.sha,
        candidateTree: tree,
        provider: "fixture",
        project: repository.fixtures,
        title: "ticket",
        body: "body",
        proof: brokenProof,
      }),
    ).rejects.toMatchObject({ code: "PROOF_REVIEW_FAILED" });
  });

  it("succeeds once the canonical identity-bound proof is supplied", async () => {
    const repository = await installedTestRepository();
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/failclosed-publish-happy",
      workspacePath: join(repository.parent, "workspace5"),
      specId: "5",
    });
    await writeFile(join(workspace.path, "feature.txt"), "feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    const result = await publish({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: accepted.sha,
      candidateTree: tree,
      provider: "fixture",
      project: repository.fixtures,
      title: "ticket",
      body: "body",
      proof: proofShell(accepted.sha, tree),
    });
    expect(result.candidateSha).toBe(accepted.sha);
    expect(result.action).toBe("pushed");
  });
});

void run;

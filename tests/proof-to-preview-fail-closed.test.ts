import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewDelivery } from "../src/adapters.js";
import { init } from "../src/maintenance.js";
import { resolveTree } from "../src/git.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/**
 * Spec #104 / ticket #110: `previewDelivery` is guarded; the shared
 * runtime identity guard fires before the adapter makes a remote
 * call. The proof-to-preview tests must install Poiesis first so the
 * guard's manifest-match branch succeeds. The init uses
 * `skipSkills: true` and `allowFixtureAdapters: true` to keep the
 * preview tests fast.
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

/**
 * Fail-closed Preview behavior.
 *
 * Ticket #39 acceptance criterion: any rejected Publish or Preview is
 * fail-closed; Poiesis must not claim that a Preview exists or ask for
 * Author validation until the deterministic operation succeeds and
 * returns a concrete Preview identity.
 *
 * Ticket #49 acceptance criterion: Preview must consume the same
 * canonical, candidate-bound Publish evidence that drove the successful
 * Publish operation. These tests exercise the runtime invariants that
 * make that contract enforceable alongside the proof-only fail-closed
 * invariants inherited from ticket #39.
 *
 * These tests exercise the runtime invariants that make that contract
 * enforceable.
 */

const repositories: TestRepository[] = [];
const scratchDirs: string[] = [];
let env: FakeOpenCodeEnvironment | undefined;

beforeEach(async () => {
  env = await installFakeOpenCode();
});

afterEach(async () => {
  env?.restore();
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeDeliveryScript(fixturesDir: string, body: string): Promise<string> {
  const scriptPath = join(fixturesDir, "delivery.mjs");
  await writeFile(scriptPath, body, "utf8");
  return scriptPath;
}

async function publishBaseSha(repository: TestRepository, branch: string): Promise<void> {
  await run("git", ["push", "--quiet", "origin", `${repository.baseSha}:refs/heads/${branch}`], {
    cwd: repository.root,
  });
}

describe("preview fail-closed invariants", () => {
  it("rejects a delivery command that returns verified:false", async () => {
    const repository = await installedTestRepository();
    const fixtures = await mkdtemp(join(tmpdir(), "poiesis-failclosed-1-"));
    scratchDirs.push(fixtures);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/failclosed-verified-false";
    await publishBaseSha(repository, branch);
    const script = await writeDeliveryScript(
      fixtures,
      "#!/usr/bin/env node\nconst [sha, target] = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({ sha, candidateTree: process.env.POIESIS_CANDIDATE_TREE, target, verified: false, artifactIdentity: \"should-be-rejected\", id: \"should-be-rejected\" }) + \"\\n\");",
    );
    await expect(
      previewDelivery(
        {
          adapter: "command",
          command: ["node", script, "{sha}", "{target}"],
        },
        { sha, candidateTree: tree, proof: proofShell(sha, tree), publish: publishEvidence(sha, tree, branch), remote: "origin" },
        repository.root,
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_VERIFICATION_FAILED" });
  });

  it("rejects a delivery command that does not return a concrete artifactIdentity", async () => {
    const repository = await installedTestRepository();
    const fixtures = await mkdtemp(join(tmpdir(), "poiesis-failclosed-2-"));
    scratchDirs.push(fixtures);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/failclosed-no-artifact";
    await publishBaseSha(repository, branch);
    const script = await writeDeliveryScript(
      fixtures,
      "#!/usr/bin/env node\nconst [sha, target] = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({ sha, candidateTree: process.env.POIESIS_CANDIDATE_TREE, target, verified: true, id: \"only-id\" }) + \"\\n\");",
    );
    await expect(
      previewDelivery(
        {
          adapter: "command",
          command: ["node", script, "{sha}", "{target}"],
        },
        { sha, candidateTree: tree, proof: proofShell(sha, tree), publish: publishEvidence(sha, tree, branch), remote: "origin" },
        repository.root,
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_ARTIFACT_IDENTITY_MISSING" });
  });

  it("fails closed (no Preview identity returned) when the delivery command exits non-zero", async () => {
    const repository = await installedTestRepository();
    const fixtures = await mkdtemp(join(tmpdir(), "poiesis-failclosed-3-"));
    scratchDirs.push(fixtures);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/failclosed-delivery-exit";
    await publishBaseSha(repository, branch);
    const script = await writeDeliveryScript(
      fixtures,
      "#!/usr/bin/env node\nprocess.stderr.write(\"preview infrastructure unavailable\\n\");\nprocess.exit(2);",
    );
    await expect(
      previewDelivery(
        {
          adapter: "command",
          command: ["node", script, "{sha}", "{target}"],
        },
        { sha, candidateTree: tree, proof: proofShell(sha, tree), publish: publishEvidence(sha, tree, branch), remote: "origin" },
        repository.root,
      ),
    ).rejects.toThrow();
  });

  it("fails closed when the candidate SHA is not in the repository", async () => {
    const repository = await installedTestRepository();
    const tree = await resolveTree(repository.root, repository.baseSha);
    const fakeSha = "f".repeat(40);
    await expect(
      previewDelivery(
        {
          adapter: "command",
          command: ["node", "/nonexistent", "{sha}", "{target}"],
        },
        { sha: fakeSha, candidateTree: tree, proof: proofShell(fakeSha, tree), publish: publishEvidence(fakeSha, tree, "poiesis/failclosed-missing"), remote: "origin" },
        repository.root,
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_CANDIDATE_NOT_FOUND" });
  });

  it("fails closed when the supplied proof is missing the specReview identity", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/failclosed-no-spec-identity";
    await publishBaseSha(repository, branch);
    const brokenProof = {
      candidateSha: sha,
      candidateTree: tree,
      verified: true as const,
      specReview: { verdict: "PASS" as const, reviewerIdentity: "" },
      standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards" },
    };
    await expect(
      previewDelivery(
        {
          adapter: "command",
          command: ["node", "/nonexistent", "{sha}", "{target}"],
        },
        { sha, candidateTree: tree, proof: brokenProof, publish: publishEvidence(sha, tree, branch), remote: "origin" },
        repository.root,
      ),
    ).rejects.toMatchObject({ code: "PROOF_REVIEW_IDENTITY_MISSING" });
  });

  it("fails closed when the supplied proof lacks a passed Standards Review verdict", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/failclosed-standards-fail";
    await publishBaseSha(repository, branch);
    const brokenProof = {
      candidateSha: sha,
      candidateTree: tree,
      verified: true as const,
      specReview: { verdict: "PASS" as const, reviewerIdentity: "spec" },
      standardsReview: { verdict: "FAIL" as unknown as "PASS", reviewerIdentity: "standards" },
    };
    await expect(
      previewDelivery(
        {
          adapter: "command",
          command: ["node", "/nonexistent", "{sha}", "{target}"],
        },
        { sha, candidateTree: tree, proof: brokenProof, publish: publishEvidence(sha, tree, branch), remote: "origin" },
        repository.root,
      ),
    ).rejects.toMatchObject({ code: "PROOF_REVIEW_FAILED" });
  });

  it("fails closed when the supplied proof carries a different candidate identity than the candidate SHA", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/failclosed-proof-mismatch";
    await publishBaseSha(repository, branch);
    const brokenProof = {
      candidateSha: "a".repeat(40),
      candidateTree: tree,
      verified: true as const,
      specReview: { verdict: "PASS" as const, reviewerIdentity: "spec" },
      standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards" },
    };
    await expect(
      previewDelivery(
        {
          adapter: "command",
          command: ["node", "/nonexistent", "{sha}", "{target}"],
        },
        { sha, candidateTree: tree, proof: brokenProof, publish: publishEvidence(sha, tree, branch), remote: "origin" },
        repository.root,
      ),
    ).rejects.toMatchObject({ code: "PROOF_IDENTITY_MISMATCH" });
  });

  it("returns a concrete Preview identity only when every required field is verified and present", async () => {
    const repository = await installedTestRepository();
    const fixtures = await mkdtemp(join(tmpdir(), "poiesis-failclosed-ok-"));
    scratchDirs.push(fixtures);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/failclosed-ok";
    await publishBaseSha(repository, branch);
    const identity = "https://preview.example/" + sha;
    const script = await writeDeliveryScript(
      fixtures,
      "#!/usr/bin/env node\nconst [sha, target] = process.argv.slice(2);\nconst id = \"https://preview.example/\" + sha;\nprocess.stdout.write(JSON.stringify({ sha, candidateTree: process.env.POIESIS_CANDIDATE_TREE, target, verified: true, url: id, artifactIdentity: id }) + \"\\n\");",
    );
    const preview = await previewDelivery(
      {
        adapter: "command",
        command: ["node", script, "{sha}", "{target}"],
      },
      { sha, candidateTree: tree, proof: proofShell(sha, tree), publish: publishEvidence(sha, tree, branch), remote: "origin" },
      repository.root,
    );
    expect(preview.sha).toBe(sha);
    expect(preview.candidateTree).toBe(tree);
    expect(preview.verified).toBe(true);
    expect(preview.target).toBe("preview");
    expect(preview.artifactIdentity).toBe(identity);
    expect(preview.url).toBe(identity);
  });
});

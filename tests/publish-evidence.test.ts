import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publish, resolveTree, workspacePrepare, checkpoint, type PublishResult } from "../src/git.js";
import { run } from "../src/process.js";
import {
  validatePublishEvidence,
  type PublishEvidence,
} from "../src/evidence.js";
import { createTestRepository, proofShell, testConfig, type TestRepository } from "./helpers.js";
import { init } from "../src/maintenance.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/**
 * Ticket #48 — Emit candidate-bound Publish evidence.
 *
 * Acceptance criteria:
 *   1. Schema identity binding — the publish result carries
 *      `evidence: PublishEvidence` whose `candidateSha`,
 *      `candidateTree`, and `verified: true` are bound to the same
 *      exact clean candidate.
 *   2. Exact local SHA/tree validation — already enforced upstream by
 *      `validateProofEvidence` and the local `assertExactClean`
 *      invariants. Re-asserted here through the new evidence schema.
 *   3. Exact change-ref push and remote-head verification — the
 *      evidence reports `branch`, `remoteRef`, and `publishedHeadSha`
 *      and the `publishedHeadSha` equals the accepted `candidateSha`.
 *   4. Provider completion before evidence return — fixture, command,
 *      GitHub, and GitLab providers all surface `verified: true` only
 *      after the provider call returns and the change request is
 *      observable. Provider failures throw before any `PublishResult`
 *      is returned.
 *   5. Fail-closed no-success evidence on push/mismatch/provider
 *      failures — push errors, identity mismatches, and provider
 *      command failures all reject before the evidence is constructed
 *      and never produce a `PublishResult`.
 *   6. Fixture/command/GitHub/GitLab parity without durable parallel
 *      workflow state — every supported provider emits the same
 *      `PublishEvidence` shape. The fixture provider skips the
 *      external change-request step (and reports `action: "pushed"` on
 *      the first call and `action: "updated"` on the fast-forward
 *      rerun), but the evidence schema is identical across providers.
 *
 * Public behavior preservation: existing PublishResult consumers that
 * read `candidateSha`, `branch`, `remoteRef`, `requestId`,
 * `requestUrl`, and `action` continue to work; the new fields and
 * the nested `evidence` object are additive.
 */

const repositories: TestRepository[] = [];
const scratchDirs: string[] = [];
let env: FakeOpenCodeEnvironment | undefined;

/**
 * Spec #104 / ticket #110: guarded Git lifecycle mutations cross the
 * runtime identity boundary; the shared guard fails closed on an
 * absent manifest. The publish-evidence tests exercise
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
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshWorkspace(
  repository: TestRepository,
  specId: string,
  branch: string,
): Promise<{ workspacePath: string; sha: string; tree: string }> {
  const workspacePath = join(repository.parent, `${specId}-workspace`);
  const workspace = await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch,
    workspacePath,
    specId,
  });
  await writeFile(join(workspace.path, "feature.txt"), "feature\n");
  const accepted = await checkpoint({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    paths: ["feature.txt"],
    message: `ticket #48 ${specId}`,
    review: { verdict: "PASS", reviewerIdentity: "reviewer", evidence: "pass" },
  });
  const tree = await resolveTree(repository.root, accepted.sha);
  return { workspacePath: workspace.path, sha: accepted.sha, tree };
}

function assertCommonEvidenceContract(
  result: PublishResult,
  expectedSha: string,
  expectedTree: string,
  expectedBranch: string,
): void {
  expect(result.candidateSha).toBe(expectedSha);
  expect(result.candidateTree).toBe(expectedTree);
  expect(result.verified).toBe(true);
  expect(result.branch).toBe(expectedBranch);
  expect(result.remoteRef).toBe(`refs/heads/${expectedBranch}`);
  expect(result.publishedHeadSha).toBe(expectedSha);
  expect(result.evidence).toEqual({
    candidateSha: expectedSha,
    candidateTree: expectedTree,
    verified: true,
    branch: expectedBranch,
    remoteRef: `refs/heads/${expectedBranch}`,
    publishedHeadSha: expectedSha,
    provider: result.provider,
    action: result.action,
    changeRequest: {
      id: result.requestId,
      url: result.requestUrl,
    },
  });
  validatePublishEvidence(result.evidence, expectedSha, expectedTree, expectedBranch, `refs/heads/${expectedBranch}`);
}

describe("ticket #48 — fixture publish emits candidate-bound evidence", () => {
  it("emits identity-bound evidence with verified:true for the first publish", async () => {
    const repository = await installedTestRepository();
    const { workspacePath, sha, tree } = await freshWorkspace(
      repository,
      "fixture-first",
      "poiesis/fixture-first",
    );
    const result = await publish({
      cwd: workspacePath,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "fixture",
      project: repository.fixtures,
      title: "fixture first",
      body: "body",
      proof: proofShell(sha, tree),
    });
    expect(result.provider).toBe("fixture");
    expect(result.action).toBe("pushed");
    expect(result.requestId).toBeNull();
    expect(result.requestUrl).toBeNull();
    assertCommonEvidenceContract(result, sha, tree, "poiesis/fixture-first");
  });

  it("emits identity-bound evidence with action:updated on a fast-forward republish", async () => {
    const repository = await installedTestRepository();
    const branch = "poiesis/fixture-ff";
    const { workspacePath, sha, tree } = await freshWorkspace(repository, "fixture-ff", branch);
    const first = await publish({
      cwd: workspacePath,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "fixture",
      project: repository.fixtures,
      title: "fixture ff",
      body: "body",
      proof: proofShell(sha, tree),
    });
    expect(first.action).toBe("pushed");

    await writeFile(join(workspacePath, "feature.txt"), "feature v2\n");
    const second = await checkpoint({
      cwd: workspacePath,
      paths: ["feature.txt"],
      message: "fixture ff v2",
      review: { verdict: "PASS", reviewerIdentity: "reviewer", evidence: "pass" },
    });
    const tree2 = await resolveTree(repository.root, second.sha);
    const republished = await publish({
      cwd: workspacePath,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: second.sha,
      candidateTree: tree2,
      provider: "fixture",
      project: repository.fixtures,
      title: "fixture ff v2",
      body: "body",
      proof: proofShell(second.sha, tree2),
    });
    expect(republished.action).toBe("updated");
    expect(republished.publishedHeadSha).toBe(second.sha);
    expect(republished.evidence.action).toBe("updated");
  });
});

describe("ticket #48 — command publish emits candidate-bound evidence", () => {
  it("emits identity-bound evidence when the command provider reports verified:true", async () => {
    const repository = await installedTestRepository();
    const { workspacePath, sha, tree } = await freshWorkspace(
      repository,
      "command-ok",
      "poiesis/command-ok",
    );
    const scratch = await mkdtemp(join(tmpdir(), "poiesis-t48-cmd-"));
    scratchDirs.push(scratch);
    const script = join(scratch, "publish.sh");
    await writeFile(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${POIESIS_PUBLISH_PROVIDER}" != "command" ]; then exit 11; fi
if [ "\${POIESIS_CANDIDATE_SHA}" != "${sha}" ]; then exit 12; fi
if [ "\${POIESIS_CANDIDATE_TREE}" != "${tree}" ]; then exit 13; fi
if [ "\${POIESIS_REMOTE_REF}" != "refs/heads/poiesis/command-ok" ]; then exit 14; fi
printf '{"id":"42","url":"https://example.test/pr/42","verified":true,"action":"created"}\n'
`,
    );
    await chmod(script, 0o755);

    const result = await publish({
      cwd: workspacePath,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: sha,
      candidateTree: tree,
      provider: "command",
      project: repository.fixtures,
      title: "command ok",
      body: "body",
      proof: proofShell(sha, tree),
      command: [script],
    });
    expect(result.provider).toBe("command");
    expect(result.requestId).toBe("42");
    expect(result.requestUrl).toBe("https://example.test/pr/42");
    expect(result.action).toBe("created");
    assertCommonEvidenceContract(result, sha, tree, "poiesis/command-ok");
    expect(result.evidence.changeRequest).toEqual({ id: "42", url: "https://example.test/pr/42" });
  });

  it("rejects before evidence is returned when the command provider omits verified:true", async () => {
    const repository = await installedTestRepository();
    const { workspacePath, sha, tree } = await freshWorkspace(
      repository,
      "command-unverified",
      "poiesis/command-unverified",
    );
    const scratch = await mkdtemp(join(tmpdir(), "poiesis-t48-cmd-bad-"));
    scratchDirs.push(scratch);
    const script = join(scratch, "publish.sh");
    await writeFile(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"id":"x","url":"https://example.test/pr/x"}\n'
`,
    );
    await chmod(script, 0o755);

    await expect(
      publish({
        cwd: workspacePath,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "command",
        project: repository.fixtures,
        title: "command unverified",
        body: "body",
        proof: proofShell(sha, tree),
        command: [script],
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_PROVIDER_INCOMPLETE" });
  });

  it("rejects before evidence is returned when the command provider reports a different candidate", async () => {
    const repository = await installedTestRepository();
    const { workspacePath, sha, tree } = await freshWorkspace(
      repository,
      "command-wrong-sha",
      "poiesis/command-wrong-sha",
    );
    const scratch = await mkdtemp(join(tmpdir(), "poiesis-t48-cmd-wrong-"));
    scratchDirs.push(scratch);
    const script = join(scratch, "publish.sh");
    await writeFile(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"id":"x","url":"https://example.test/pr/x","verified":true,"candidateSha":"0000000000000000000000000000000000000000"}\n'
`,
    );
    await chmod(script, 0o755);

    await expect(
      publish({
        cwd: workspacePath,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "command",
        project: repository.fixtures,
        title: "command wrong sha",
        body: "body",
        proof: proofShell(sha, tree),
        command: [script],
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_COMMAND_CANDIDATE_MISMATCH" });
  });

  it("rejects with INVALID_PUBLISH_COMMAND when the command provider has no argv", async () => {
    const repository = await installedTestRepository();
    const { workspacePath, sha, tree } = await freshWorkspace(
      repository,
      "command-missing",
      "poiesis/command-missing",
    );

    await expect(
      publish({
        cwd: workspacePath,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "command",
        project: repository.fixtures,
        title: "command missing",
        body: "body",
        proof: proofShell(sha, tree),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PUBLISH_COMMAND" });
  });
});

describe("ticket #48 — publish evidence fails closed", () => {
  it("rejects Publish with no success evidence when the candidate tree does not match", async () => {
    const repository = await installedTestRepository();
    const { workspacePath, sha, tree } = await freshWorkspace(
      repository,
      "tree-mismatch",
      "poiesis/tree-mismatch",
    );
    const wrongTree = "f".repeat(40);
    await expect(
      publish({
        cwd: workspacePath,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: wrongTree,
        provider: "fixture",
        project: repository.fixtures,
        title: "wrong tree",
        body: "body",
        proof: proofShell(sha, tree),
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_TREE_MISMATCH" });
  });

  it("rejects Publish with no success evidence when the proof candidate SHA does not match", async () => {
    const repository = await installedTestRepository();
    const { workspacePath, sha, tree } = await freshWorkspace(
      repository,
      "proof-mismatch",
      "poiesis/proof-mismatch",
    );
    const wrongSha = "a".repeat(40);
    await expect(
      publish({
        cwd: workspacePath,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "fixture",
        project: repository.fixtures,
        title: "wrong proof",
        body: "body",
        proof: proofShell(wrongSha, tree),
      }),
    ).rejects.toMatchObject({ code: "PROOF_IDENTITY_MISMATCH" });
  });

  it("rejects Publish with no success evidence when the remote branch diverges", async () => {
    const repository = await installedTestRepository();
    const branch = "poiesis/diverged-evidence";
    const { workspacePath, sha, tree } = await freshWorkspace(repository, "diverged-evidence", branch);

    // Stage the divergence using a separate (non-Poiesis) worktree at
    // the remote change-branch tip. We cannot use workspacePrepare
    // again on the same branch because Poiesis-owned branch names are
    // reserved for one workspace; instead we fetch the original
    // candidate into a temporary worktree, push a foreign commit, and
    // then expect the next publish to refuse the divergence.
    const divergencePath = join(repository.parent, "divergence-workspace");
    await mkdir(divergencePath, { recursive: true });
    scratchDirs.push(divergencePath);
    await run("git", ["worktree", "add", "--detach", divergencePath, sha], {
      cwd: repository.root,
    });
    await writeFile(join(divergencePath, "feature.txt"), "foreign edit\n");
    await run("git", ["add", "feature.txt"], { cwd: divergencePath });
    await run("git", ["commit", "--quiet", "-m", "foreign edit"], { cwd: divergencePath });
    const foreignHead = (await run("git", ["rev-parse", "HEAD"], { cwd: divergencePath })).stdout;
    await run("git", ["push", "--quiet", "origin", `${foreignHead}:refs/heads/${branch}`], {
      cwd: divergencePath,
    });

    await expect(
      publish({
        cwd: workspacePath,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: sha,
        candidateTree: tree,
        provider: "fixture",
        project: repository.fixtures,
        title: "diverged",
        body: "body",
        proof: proofShell(sha, tree),
      }),
    ).rejects.toMatchObject({ code: "PUBLISHED_BRANCH_DIVERGED" });
  });
});

describe("ticket #48 — PublishEvidence validator", () => {
  function buildEvidence(overrides: Partial<PublishEvidence> = {}): PublishEvidence {
    return {
      candidateSha: "1".repeat(40),
      candidateTree: "2".repeat(40),
      verified: true,
      branch: "poiesis/validator",
      remoteRef: "refs/heads/poiesis/validator",
      publishedHeadSha: "1".repeat(40),
      provider: "fixture",
      action: "pushed",
      changeRequest: { id: null, url: null },
      ...overrides,
    };
  }

  it("accepts a canonical identity-bound evidence object", () => {
    expect(() =>
      validatePublishEvidence(buildEvidence(), "1".repeat(40), "2".repeat(40), "poiesis/validator", "refs/heads/poiesis/validator"),
    ).not.toThrow();
  });

  it("rejects evidence whose candidateSha does not match", () => {
    expect(() =>
      validatePublishEvidence(
        buildEvidence({ candidateSha: "9".repeat(40) }),
        "1".repeat(40),
        "2".repeat(40),
        "poiesis/validator",
        "refs/heads/poiesis/validator",
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_IDENTITY_MISMATCH" }));
  });

  it("rejects evidence whose candidateTree does not match", () => {
    expect(() =>
      validatePublishEvidence(
        buildEvidence({ candidateTree: "9".repeat(40) }),
        "1".repeat(40),
        "2".repeat(40),
        "poiesis/validator",
        "refs/heads/poiesis/validator",
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_TREE_MISMATCH" }));
  });

  it("rejects evidence that is not verified", () => {
    expect(() =>
      validatePublishEvidence(
        buildEvidence({ verified: false as unknown as true }),
        "1".repeat(40),
        "2".repeat(40),
        "poiesis/validator",
        "refs/heads/poiesis/validator",
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_NOT_VERIFIED" }));
  });

  it("rejects evidence whose publishedHeadSha diverges from the candidate", () => {
    expect(() =>
      validatePublishEvidence(
        buildEvidence({ publishedHeadSha: "9".repeat(40) }),
        "1".repeat(40),
        "2".repeat(40),
        "poiesis/validator",
        "refs/heads/poiesis/validator",
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_HEAD_MISMATCH" }));
  });

  it("rejects evidence whose remoteRef does not match the change ref", () => {
    expect(() =>
      validatePublishEvidence(
        buildEvidence({ remoteRef: "refs/heads/something-else" }),
        "1".repeat(40),
        "2".repeat(40),
        "poiesis/validator",
        "refs/heads/poiesis/validator",
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_REMOTE_REF_MISMATCH" }));
  });

  it("rejects evidence with an unknown action", () => {
    expect(() =>
      validatePublishEvidence(
        buildEvidence({ action: "closed" as unknown as "pushed" }),
        "1".repeat(40),
        "2".repeat(40),
        "poiesis/validator",
        "refs/heads/poiesis/validator",
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_ACTION_INVALID" }));
  });
});

void run;

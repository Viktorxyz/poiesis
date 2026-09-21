import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFixtureDeliveryAdapter,
  previewDelivery,
} from "../src/adapters.js";
import { validatePreviewPublishEvidence, type PublishEvidence } from "../src/evidence.js";
import { init } from "../src/maintenance.js";
import { resolveTree } from "../src/git.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/**
 * Spec #104 / ticket #110: `previewDelivery` is guarded; the shared
 * runtime identity guard fires before the adapter makes a remote
 * call. The publish-evidence-before-preview tests must install Poiesis
 * first so the guard's manifest-match branch succeeds. The init uses
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
 * Ticket #49 — Require Publish evidence before Preview.
 *
 * Acceptance criteria:
 *   1. Canonical Proof plus matching successful Publish evidence must
 *      be present in both the CLI and the public Preview API before
 *      the adapter is invoked. A Preview call that omits Publish
 *      evidence, or supplies a malformed/incomplete/fabricated
 *      substitute, must fail closed before any adapter or downstream
 *      command is contacted.
 *   2. Reject missing/malformed/wrong-target/cross-identity/
 *      provider/failed/fabricated/stale evidence at every relevant
 *      surface — the public API, the CLI dispatch, the validator
 *      helper, and the CLI HELP — so the contract cannot be
 *      silently bypassed by a tampered dispatch or a missing field.
 *   3. Revalidate local SHA/tree and configured remote change-branch
 *      head on every Preview call so that a force-pushed, rebased,
 *      or rebased-upstream change branch cannot back-date a Preview
 *      claim; the revalidation reuses the canonical identity-bound
 *      `publishedHeadSha` field.
 *   4. Preserve the exact happy-path identities: the same canonical
 *      `candidateSha`, `candidateTree`, branch, remote ref, and
 *      published head SHA from Publish must continue through to the
 *      Preview adapter, and the adapter must return a concrete
 *      Preview identity (`id`, `url`, and/or `artifact`) whose
 *      `artifactIdentity` is present and verifiable.
 *   5. No proof-only bypass and no false Preview claim — supplying a
 *      valid Proof but no Publish evidence (or an invalid Publish
 *      evidence) must reject before any Preview identity is emitted.
 *
 * Public API preservation: the public Preview API and CLI signature
 * gain an additive required `publish: PublishEvidence` payload
 * (carrying the same canonical identity-bound fields as the
 * `PublishResult.evidence` published by ticket #48) and an additive
 * required `remote: string` argument (sourced from the Poiesis config
 * in the CLI). Existing required `candidateSha`/`candidateTree`/`proof`
 * arguments are unchanged. The change is additive and does not
 * re-shape the Preview adapter invariants established by ticket #39.
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

async function publishBaseSha(repository: TestRepository, branch: string): Promise<void> {
  await run("git", ["push", "--quiet", "origin", `${repository.baseSha}:refs/heads/${branch}`], {
    cwd: repository.root,
  });
}

async function writeDeliveryScript(fixturesDir: string, body: string): Promise<string> {
  const scriptPath = join(fixturesDir, "delivery.mjs");
  await writeFile(scriptPath, body, "utf8");
  return scriptPath;
}

describe("ticket #49 — Publish evidence is required before Preview", () => {
  it("happy path: returns a concrete Preview identity when Proof and matching Publish evidence are both valid", async () => {
    const repository = await installedTestRepository();
    const branch = "poiesis/t49-happy";
    await publishBaseSha(repository, branch);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const fixtures = await mkdtemp(join(tmpdir(), "poiesis-t49-happy-"));
    scratchDirs.push(fixtures);
    const identity = `https://preview.example/${sha}`;
    const script = await writeDeliveryScript(
      fixtures,
      "#!/usr/bin/env node\nconst [sha, target] = process.argv.slice(2);\nconst id = `https://preview.example/${sha}`;\nprocess.stdout.write(JSON.stringify({ sha, candidateTree: process.env.POIESIS_CANDIDATE_TREE, target, verified: true, url: id, artifactIdentity: id }) + \"\\n\");",
    );
    const preview = await previewDelivery(
      { adapter: "command", command: ["node", script, "{sha}", "{target}"] },
      { sha, candidateTree: tree, proof: proofShell(sha, tree), publish: publishEvidence(sha, tree, branch), remote: "origin" },
      repository.root,
    );
    expect(preview.sha).toBe(sha);
    expect(preview.candidateTree).toBe(tree);
    expect(preview.candidateSha).toBe(sha);
    expect(preview.target).toBe("preview");
    expect(preview.verified).toBe(true);
    expect(preview.artifactIdentity).toBe(identity);
    expect(preview.url).toBe(identity);
    expect(preview.id ?? preview.artifact ?? preview.url).toBeDefined();
  });

  it("rejects Preview when Publish evidence is omitted (no proof-only bypass)", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        remote: "origin",
        publish: undefined as unknown as PublishEvidence,
      }),
    ).rejects.toThrow();
  });

  it("rejects Preview when Publish evidence belongs to a different candidate (cross-identity)", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-cross-identity";
    await publishBaseSha(repository, branch);
    const foreignSha = "f".repeat(40);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: { ...publishEvidence(foreignSha, tree, branch), candidateSha: foreignSha },
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_IDENTITY_MISMATCH" });
  });

  it("rejects Preview when Publish evidence carries a different tree (cross-identity)", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-cross-tree";
    await publishBaseSha(repository, branch);
    const wrongTree = "e".repeat(40);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: { ...publishEvidence(sha, tree, branch), candidateTree: wrongTree },
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_TREE_MISMATCH" });
  });

  it("rejects Preview when Publish evidence is not verified (failed/published=false substitute)", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-unverified";
    await publishBaseSha(repository, branch);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: { ...publishEvidence(sha, tree, branch), verified: false as unknown as true },
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_NOT_VERIFIED" });
  });

  it("rejects Preview when Publish evidence uses a non-success action (failed/closed)", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-action-closed";
    await publishBaseSha(repository, branch);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: { ...publishEvidence(sha, tree, branch), action: "closed" as unknown as "pushed" },
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_ACTION_INVALID" });
  });

  it("rejects Preview when Publish evidence names an unsupported provider", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-fake-provider";
    await publishBaseSha(repository, branch);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: { ...publishEvidence(sha, tree, branch), provider: "fabricated" as unknown as "fixture" },
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_PROVIDER_INVALID" });
  });

  it("rejects Preview when Publish evidence changeRequest block is missing (fabricated)", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-no-change-request";
    await publishBaseSha(repository, branch);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const evidence: Record<string, unknown> = { ...publishEvidence(sha, tree, branch) };
    delete evidence.changeRequest;
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: evidence as unknown as PublishEvidence,
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PUBLISH_EVIDENCE" });
  });

  it("rejects Preview when Publish evidence is not an object (malformed)", () => {
    expect(() =>
      validatePreviewPublishEvidence(
        null as unknown as PublishEvidence,
        "1".repeat(40),
        "2".repeat(40),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_PUBLISH_EVIDENCE" }));
  });

  it("rejects Preview when Publish evidence is missing the candidate-bound proof (verified:false)", () => {
    expect(() =>
      validatePreviewPublishEvidence(
        {
          candidateSha: "1".repeat(40),
          candidateTree: "2".repeat(40),
          verified: false as unknown as true,
          branch: "poiesis/validator",
          remoteRef: "refs/heads/poiesis/validator",
          publishedHeadSha: "1".repeat(40),
          provider: "fixture",
          action: "pushed",
          changeRequest: { id: null, url: null },
        },
        "1".repeat(40),
        "2".repeat(40),
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_NOT_VERIFIED" }));
  });

  it("rejects Preview when Publish evidence's remoteRef is inconsistent with its branch (wrong-target)", () => {
    expect(() =>
      validatePreviewPublishEvidence(
        {
          candidateSha: "1".repeat(40),
          candidateTree: "2".repeat(40),
          verified: true,
          branch: "poiesis/validator",
          remoteRef: "refs/heads/some-other-branch",
          publishedHeadSha: "1".repeat(40),
          provider: "fixture",
          action: "pushed",
          changeRequest: { id: null, url: null },
        },
        "1".repeat(40),
        "2".repeat(40),
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_REMOTE_REF_INCONSISTENT" }));
  });

  it("rejects Preview when Publish evidence reports a different publishedHeadSha than the candidate", () => {
    expect(() =>
      validatePreviewPublishEvidence(
        {
          candidateSha: "1".repeat(40),
          candidateTree: "2".repeat(40),
          verified: true,
          branch: "poiesis/validator",
          remoteRef: "refs/heads/poiesis/validator",
          publishedHeadSha: "9".repeat(40),
          provider: "fixture",
          action: "pushed",
          changeRequest: { id: null, url: null },
        },
        "1".repeat(40),
        "2".repeat(40),
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_HEAD_MISMATCH" }));
  });

  it("rejects Preview when Publish evidence carries an empty/whitespace branch (wrong-target/malformed)", () => {
    expect(() =>
      validatePreviewPublishEvidence(
        {
          candidateSha: "1".repeat(40),
          candidateTree: "2".repeat(40),
          verified: true,
          branch: "   ",
          remoteRef: "refs/heads/   ",
          publishedHeadSha: "1".repeat(40),
          provider: "fixture",
          action: "pushed",
          changeRequest: { id: null, url: null },
        },
        "1".repeat(40),
        "2".repeat(40),
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_BRANCH_MISSING" }));
  });

  it("rejects Preview when the configured remote change-branch head has moved off the published head (stale)", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-stale-remote-head";
    await publishBaseSha(repository, branch);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    // Advance the remote change-branch head with a foreign commit so the
    // revalidation in the Preview adapter must reject the stale evidence.
    await run("git", ["commit", "--quiet", "--allow-empty", "-m", "foreign upstream move"], {
      cwd: repository.root,
    });
    const foreignHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout;
    await run("git", ["push", "--quiet", "origin", `${foreignHead}:refs/heads/${branch}`], {
      cwd: repository.root,
    });
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: publishEvidence(sha, tree, branch),
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_EVIDENCE_STALE" });
  });

  it("rejects Preview when the configured remote does not exist", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-remote-missing";
    await publishBaseSha(repository, branch);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: publishEvidence(sha, tree, branch),
        remote: "not-a-real-remote",
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_REMOTE_NOT_FOUND" });
  });

  it("rejects Preview when the configured remote uses an unsafe Git remote name", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const branch = "poiesis/t49-unsafe-remote";
    await publishBaseSha(repository, branch);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: publishEvidence(sha, tree, branch),
        remote: "--upload-pack=evil",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REMOTE_NAME" });
  });

  it("rejects Preview when the Publish evidence change-branch name is invalid", async () => {
    const repository = await installedTestRepository();
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const adapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    await expect(
      adapter.preview({
        sha,
        candidateTree: tree,
        proof: proofShell(sha, tree),
        publish: publishEvidence(sha, tree, "-bad..branch"),
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_BRANCH_INVALID" });
  });

  it("preserves the exact happy-path identities through the Preview adapter", async () => {
    const repository = await installedTestRepository();
    const branch = "poiesis/t49-identity-preserve";
    await publishBaseSha(repository, branch);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const fixtures = await mkdtemp(join(tmpdir(), "poiesis-t49-identity-"));
    scratchDirs.push(fixtures);
    const script = await writeDeliveryScript(
      fixtures,
      "#!/usr/bin/env node\nconst [sha, target] = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({ sha, candidateTree: process.env.POIESIS_CANDIDATE_TREE, target, verified: true, url: `https://preview/${sha}`, artifactIdentity: `https://preview/${sha}` }) + \"\\n\");",
    );
    const preview = await previewDelivery(
      { adapter: "command", command: ["node", script, "{sha}", "{target}"] },
      { sha, candidateTree: tree, proof: proofShell(sha, tree), publish: publishEvidence(sha, tree, branch), remote: "origin" },
      repository.root,
    );
    expect(preview.sha).toBe(sha);
    expect(preview.candidateSha).toBe(sha);
    expect(preview.candidateTree).toBe(tree);
    expect(preview.verified).toBe(true);
    expect(preview.target).toBe("preview");
    expect(preview.artifactIdentity).toBe(`https://preview/${sha}`);
    expect(preview.url).toBe(`https://preview/${sha}`);
    expect(preview.status).toBeTruthy();
  });

  it("validates a canonical Publish evidence object via validatePreviewPublishEvidence", () => {
    expect(() =>
      validatePreviewPublishEvidence(
        publishEvidence("1".repeat(40), "2".repeat(40), "poiesis/canonical"),
        "1".repeat(40),
        "2".repeat(40),
      ),
    ).not.toThrow();
  });

  it("rejects when the Publish evidence has a non-string changeRequest id", () => {
    expect(() =>
      validatePreviewPublishEvidence(
        {
          candidateSha: "1".repeat(40),
          candidateTree: "2".repeat(40),
          verified: true,
          branch: "poiesis/canonical",
          remoteRef: "refs/heads/poiesis/canonical",
          publishedHeadSha: "1".repeat(40),
          provider: "fixture",
          action: "pushed",
          changeRequest: { id: 42 as unknown as string, url: null },
        },
        "1".repeat(40),
        "2".repeat(40),
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_REQUEST_ID_INVALID" }));
  });
});
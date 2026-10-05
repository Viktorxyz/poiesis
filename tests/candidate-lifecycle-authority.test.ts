/**
 * Spec #168 / ticket #169 — candidate workspace lifecycle authority.
 *
 * A prepared, Poiesis-owned candidate workspace must resolve its
 * authoritative lifecycle manifest / config / runtime identity through the
 * PRIMARY receipt-authenticated installation, never through the candidate's
 * own generated `.poiesis/config.jsonc` (which is stale the moment the
 * candidate is prepared and may even be committed into the candidate tree).
 *
 * The shared seam under test is `resolveLifecycleAuthority` in `src/git.ts`:
 *
 *   - it returns the canonical candidate workspace, the immutable ownership
 *     marker, the primary repository root, the primary ownership receipt, the
 *     receipt-authenticated manifest, and the runtime identity;
 *   - `verify` and the delivery (`preview` / `promote`) operations consume that
 *     authority, while the verification commands still execute against the
 *     exact candidate workspace;
 *   - wrong ownership, a missing primary receipt, a foreign (unowned)
 *     workspace, and a mismatched runtime identity all fail closed with typed
 *     diagnostics.
 *
 * Compatibility is part of the contract: the primary checkout still resolves
 * as its own authority (with no ownership marker), and a plain repository
 * that never installed Poiesis keeps running `verify` as a non-project-bound
 * read-only surface.
 */
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpoint,
  resolveLifecycleAuthority,
  resolveTree,
  verify,
  workspacePrepare,
} from "../src/git.js";
import { previewDelivery, promoteDelivery } from "../src/adapters.js";
import { init, packageVersion, setRuntimePackageVersionOverrideForTest } from "../src/maintenance.js";
import { serializeConfig } from "../src/config.js";
import { loadManifest } from "../src/manifest.js";
import { manifestDigest, removeOwnershipReceipt } from "../src/receipt.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, type TestRepository, verifiedProof } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const repositories: TestRepository[] = [];
let env: FakeOpenCodeEnvironment | undefined;

beforeEach(async () => {
  env = await installFakeOpenCode();
});

afterEach(async () => {
  env?.restore();
  setRuntimePackageVersionOverrideForTest(null);
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

/**
 * The PRIMARY installation records an identifiable verification command so
 * the test can prove which installation's config was consulted. The
 * candidate's own generated config records a different, deliberately
 * failing command so using it as lifecycle authority is observable.
 */
function primaryConfig(repository: TestRepository) {
  return {
    ...testConfig(repository),
    verification: { commands: ["printf primary-installation-authority"] },
  };
}

async function installedRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await init(repository.root, primaryConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
  return repository;
}

/**
 * Prepare an owned candidate workspace that carries a STALE, candidate-tracked
 * generated config: `.poiesis/config.jsonc` is committed into the candidate
 * tree with a different verification command and a different repository
 * target. Any lifecycle authority read from the candidate would surface those
 * stale facts; the primary installation must never see them.
 */
async function ownedCandidateWithStaleGeneratedConfig(
  repository: TestRepository,
  specId: string,
): Promise<{ path: string; ownershipId: string; markerPath: string; branch: string; sha: string; tree: string }> {
  const workspace = await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch: `poiesis/${specId}`,
    specId,
  });
  await mkdir(join(workspace.path, ".poiesis"), { recursive: true });
  const stale = {
    ...testConfig(repository),
    repository: { remote: "stale-candidate-remote", integrationBranch: "stale-candidate-branch" },
    verification: { commands: ["printf candidate-stale-config", "exit 9"] },
  };
  await writeFile(join(workspace.path, ".poiesis", "config.jsonc"), serializeConfig(stale), "utf8");
  const accepted = await checkpoint({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    paths: [".poiesis/config.jsonc"],
    message: "ticket: stale generated config",
    review: { verdict: "PASS", reviewerIdentity: "review", evidence: "accepted" },
  });
  const tree = await resolveTree(repository.root, accepted.sha);
  return {
    path: workspace.path,
    ownershipId: workspace.ownershipId,
    markerPath: workspace.markerPath,
    branch: workspace.branch,
    sha: accepted.sha,
    tree,
  };
}

async function publishCandidate(
  repository: TestRepository,
  candidate: { path: string; ownershipId: string; branch: string; sha: string; tree: string },
): Promise<void> {
  const { publish } = await import("../src/git.js");
  await publish({
    cwd: candidate.path,
    ownershipId: candidate.ownershipId,
    remote: "origin",
    integrationBranch: "main",
    candidateSha: candidate.sha,
    candidateTree: candidate.tree,
    provider: "fixture",
    project: repository.fixtures,
    title: "Candidate",
    body: "body",
    proof: await verifiedProof({ cwd: candidate.path, ownershipId: candidate.ownershipId, candidateSha: candidate.sha, candidateTree: candidate.tree }),
  });
}

describe("candidate lifecycle authority (Spec #168 / ticket #169)", () => {
  it("resolves the full shared authority for an owned candidate whose generated config is stale and candidate-tracked", async () => {
    const repository = await installedRepository();
    const candidate = await ownedCandidateWithStaleGeneratedConfig(repository, "spec-authority");

    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    // Canonical candidate workspace + immutable ownership marker.
    expect(authority.candidateRoot).toBe(await realpath(candidate.path));
    expect(authority.markerPath).toBe(candidate.markerPath);
    expect(authority.marker?.ownershipId).toBe(candidate.ownershipId);
    expect(authority.marker?.workspacePath).toBe(authority.candidateRoot);

    // Primary repository root.
    expect(authority.primaryRoot).toBe(await realpath(repository.root));

    // Receipt-authenticated manifest + ownership receipt of the PRIMARY
    // installation (the candidate has neither on disk).
    const primaryManifest = await loadManifest(repository.root);
    expect(authority.manifest).toEqual(primaryManifest);
    expect(authority.receipt.workspace).toBe(authority.primaryRoot);
    expect(authority.receipt.manifestDigest).toBe(manifestDigest(primaryManifest));

    // Runtime identity.
    expect(authority.runtime).toBe(await packageVersion());
    expect(authority.runtime).toBe(primaryManifest.poiesisVersion);

    // The candidate's own generated config was never consulted as authority.
    expect(authority.manifest.poiesisVersion).not.toBe("stale");
  }, 60_000);

  it("verify executes against the exact candidate workspace while the authority comes from the primary installation", async () => {
    const repository = await installedRepository();
    const candidate = await ownedCandidateWithStaleGeneratedConfig(repository, "spec-verify");

    const result = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: ["pwd", "test -f .poiesis/config.jsonc"],
    });

    expect(result).toMatchObject({ candidateSha: candidate.sha, cleanBefore: true, cleanAfter: true });
    expect(result.commands[0]?.stdout.trim()).toBe(await realpath(candidate.path));
    expect(result.commands[1]?.exitCode).toBe(0);
  }, 60_000);

  it("delivery operations from an owned candidate use the primary installation authority", async () => {
    const repository = await installedRepository();
    const candidate = await ownedCandidateWithStaleGeneratedConfig(repository, "spec-delivery");
    await publishCandidate(repository, candidate);
    const delivery = { adapter: "fixture" as const, path: join(repository.fixtures, "delivery") };

    // The candidate workspace carries NO `.poiesis/manifest.json` and no
    // authoritative config: every lifecycle fact must come from the primary.
    const preview = await previewDelivery(
      delivery,
      {
        sha: candidate.sha,
        candidateTree: candidate.tree,
        proof: proofShell(candidate.sha, candidate.tree),
        publish: publishEvidence(candidate.sha, candidate.tree, candidate.branch),
        remote: "origin",
      },
      candidate.path,
    );
    expect(preview).toMatchObject({ target: "preview", verified: true, candidateSha: candidate.sha });

    const staging = await promoteDelivery(
      delivery,
      { sha: candidate.sha, target: "staging", candidateTree: candidate.tree, identity: preview },
      candidate.path,
    );
    expect(staging).toMatchObject({ target: "staging", verified: true, candidateSha: candidate.sha });
  }, 60_000);

  it("fails closed on a wrong ownership id", async () => {
    const repository = await installedRepository();
    const candidate = await ownedCandidateWithStaleGeneratedConfig(repository, "spec-wrong-owner");

    await expect(
      resolveLifecycleAuthority(candidate.path, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "WORKSPACE_OWNERSHIP_ID_MISMATCH" });
  }, 60_000);

  it("fails closed when the primary ownership receipt is missing", async () => {
    const repository = await installedRepository();
    const candidate = await ownedCandidateWithStaleGeneratedConfig(repository, "spec-missing-receipt");
    await removeOwnershipReceipt(repository.root);

    await expect(
      resolveLifecycleAuthority(candidate.path, candidate.ownershipId),
    ).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_MISSING" });
  }, 60_000);

  it("fails closed on a mismatched runtime identity", async () => {
    const repository = await installedRepository();
    const candidate = await ownedCandidateWithStaleGeneratedConfig(repository, "spec-runtime-mismatch");
    const manifest = await loadManifest(repository.root);
    setRuntimePackageVersionOverrideForTest("9.9.9-different");

    await expect(
      resolveLifecycleAuthority(candidate.path, candidate.ownershipId),
    ).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: manifest.poiesisVersion, runtime: "9.9.9-different" },
    });
  }, 60_000);

  it("fails closed on a foreign workspace that Poiesis does not own", async () => {
    const repository = await installedRepository();
    const foreign = join(repository.parent, "foreign-worktree");
    await run("git", ["worktree", "add", "--detach", "--quiet", foreign, repository.baseSha], {
      cwd: repository.root,
    });

    await expect(resolveLifecycleAuthority(foreign)).rejects.toMatchObject({
      code: "WORKSPACE_OWNERSHIP_UNKNOWN",
    });
    await expect(verify({ cwd: foreign, candidateSha: repository.baseSha, commands: ["true"] })).rejects.toMatchObject({
      code: "WORKSPACE_OWNERSHIP_UNKNOWN",
    });
  }, 60_000);

  it("preserves primary-checkout compatibility (no ownership marker, primary is its own authority)", async () => {
    const repository = await installedRepository();
    const authority = await resolveLifecycleAuthority(repository.root);
    expect(authority.candidateRoot).toBe(await realpath(repository.root));
    expect(authority.primaryRoot).toBe(authority.candidateRoot);
    expect(authority.marker).toBeNull();
    expect(authority.markerPath).toBeNull();
    expect(authority.manifest.poiesisVersion).toBe(await packageVersion());
  }, 60_000);
});

/**
 * The CLI dispatch is where a candidate-tracked generated config would
 * otherwise become lifecycle authority: `poiesis verify` reads the
 * verification commands out of a Poiesis config before handing them to
 * `verify`. Both facts must come from the PRIMARY installation.
 */
describe("CLI verify resolves the primary installation authority", () => {
  function captureStdout(): { chunks: string[]; restore: () => void } {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    return { chunks, restore: () => { process.stdout.write = original; } };
  }

  it("runs the PRIMARY verification commands for an owned candidate whose generated config is stale and candidate-tracked", async () => {
    const repository = await installedRepository();
    const candidate = await ownedCandidateWithStaleGeneratedConfig(repository, "spec-cli-verify");
    const { commandVerify } = await import("../src/cli.js");

    const capture = captureStdout();
    try {
      await commandVerify(["--sha", candidate.sha, "--cwd", candidate.path]);
    } finally {
      capture.restore();
    }
    const payload = JSON.parse(capture.chunks.join("")) as {
      ok: boolean;
      result: { commands: Array<{ command: string; exitCode: number | null; stdout: string }> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.result.commands.map((command) => command.command)).toEqual([
      "printf primary-installation-authority",
    ]);
  }, 60_000);

  it("fails closed on a foreign workspace that Poiesis does not own", async () => {
    const repository = await installedRepository();
    const foreign = join(repository.parent, "foreign-cli-worktree");
    await run("git", ["worktree", "add", "--detach", "--quiet", foreign, repository.baseSha], {
      cwd: repository.root,
    });
    const { commandVerify } = await import("../src/cli.js");

    await expect(
      commandVerify(["--sha", repository.baseSha, "--cwd", foreign]),
    ).rejects.toMatchObject({ code: "WORKSPACE_OWNERSHIP_UNKNOWN" });
  }, 60_000);
});
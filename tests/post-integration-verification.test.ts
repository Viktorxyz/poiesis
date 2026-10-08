/**
 * Spec #168 / ticket #174 — post-integration verification is opt-in, never a
 * fallback for the full verification plan.
 *
 * Spec #168 moved whole-change verification into a single runtime-owned proof
 * that runs ONCE, in the owned candidate, before Publish. Integration
 * re-verifying the integrated revision afterwards was the last place the
 * configured full plan (`verification.commands`) still ran a second time — the
 * redundancy this whole Spec exists to remove. It was wired through
 * `poiesis integrate` as `postIntegrationCommands ?? verification.commands`,
 * so a project that had simply never configured `postIntegrationCommands` paid
 * for a full second verification on every integration with no way to opt out.
 *
 * The contract this file pins:
 *
 *   1. `verification.postIntegrationCommands`, when configured, still runs
 *      exactly as configured and its result is reported.
 *   2. When it is ABSENT, integration runs NOTHING: `postIntegrationVerification`
 *      is `null`, and the configured full plan is not silently substituted.
 *   3. When it is absent, integration still proves EXACT IDENTITY: the
 *      integrated commit's tree is the candidate tree byte-for-byte, and the
 *      published integration ref is the integrated commit — proven by Git, not
 *      by re-running commands.
 *   4. The full plan was not run: the observable is the absent result together
 *      with an identity proof, and the plan's own commands are visible in the
 *      config the CLI resolved.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureDeliveryAdapter } from "../src/adapters.js";
import { commandIntegrate } from "../src/cli.js";
import { checkpoint, publish, resolveTree, workspacePrepare } from "../src/git.js";
import { init, packageVersion } from "../src/maintenance.js";
import { run } from "../src/process.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, describeManagedExecution, proofShell, testConfig, verifiedProof, type TestRepository } from "./helpers.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

async function installFakeUv(): Promise<FakeUvEnvironment> {
  const { chmod, mkdir, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-174c-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    parent,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function captureStdout<T>(operation: () => Promise<T>): Promise<{ value: T; stdout: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = await operation();
    return { value, stdout: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

interface IntegratedCandidate {
  repository: TestRepository;
  workspacePath: string;
  ownershipId: string;
  baseSha: string;
  sha: string;
  tree: string;
  staging: unknown;
}

async function stagePublishedCandidate(
  repositories: TestRepository[],
  verification: { commands: string[]; postIntegrationCommands?: string[] },
): Promise<IntegratedCandidate> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await init(repository.root, { ...testConfig(repository), verification }, { skipSkills: true, allowFixtureAdapters: true });
  const workspace = await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch: "poiesis/spec-1",
    workspacePath: join(repository.parent, "workspace"),
    specId: "1",
  });
  await writeFile(join(workspace.path, "feature.txt"), "accepted feature\n");
  const accepted = await checkpoint({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    paths: ["feature.txt"],
    message: "ticket 1",
    review: { verdict: "PASS", reviewerIdentity: "review-1", evidence: "no findings" },
  });
  const tree = await resolveTree(repository.root, accepted.sha);
  await publish({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    remote: "origin",
    integrationBranch: "main",
    candidateSha: accepted.sha,
    candidateTree: tree,
    provider: "fixture",
    project: repository.fixtures,
    title: "Spec 1",
    body: "body",
    proof: await verifiedProof({ cwd: workspace.path, ownershipId: workspace.ownershipId, candidateSha: accepted.sha, candidateTree: tree }),
  });
  const delivery = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
  const preview = await delivery.preview({
    sha: accepted.sha,
    candidateTree: tree,
    proof: proofShell(accepted.sha, tree),
    publish: {
      candidateSha: accepted.sha,
      candidateTree: tree,
      verified: true as const,
      branch: "poiesis/spec-1",
      remoteRef: "refs/heads/poiesis/spec-1",
      publishedHeadSha: accepted.sha,
      provider: "fixture" as const,
      action: "pushed" as const,
      changeRequest: { id: null, url: null },
      verification: {
        receiptId: "receipt-e2e",
        receiptDigest: "a".repeat(64),
        runtime: "poiesis-test-runtime",
        candidateSha: accepted.sha,
        candidateTree: tree,
        verificationPlanDigest: "b".repeat(64),
      },
    },
    remote: "origin",
  });
  const staging = await delivery.promote({
    sha: accepted.sha,
    target: "staging",
    candidateTree: tree,
    identity: preview,
  });
  return {
    repository,
    workspacePath: workspace.path,
    ownershipId: workspace.ownershipId,
    baseSha: workspace.baseSha,
    sha: accepted.sha,
    tree,
    staging,
  };
}

interface IntegrateEnvelope {
  ok: boolean;
  operation: string;
  result: {
    integratedSha: string;
    integratedTree: string;
    candidateTree: string;
    remoteRef: string;
    postIntegrationVerification: {
      cleanBefore: true;
      cleanAfter: true;
      commands: Array<{ command: string; exitCode: number }>;
      verification: unknown;
    } | null;
    integration: {
      candidateSha: string;
      candidateTree: string;
      integrationSha: string;
      integrationTree: string;
      contentMatchesCandidate: boolean;
    };
  };
}

async function integrateThroughCli(candidate: IntegratedCandidate): Promise<IntegrateEnvelope> {
  const { stdout } = await captureStdout(() =>
    commandIntegrate([
      "--sha", candidate.sha,
      "--base", candidate.baseSha,
      "--candidate-tree", candidate.tree,
      "--proof", JSON.stringify(proofShell(candidate.sha, candidate.tree)),
      "--staging", JSON.stringify(candidate.staging),
      "--message", "Spec 1: accepted feature",
      "--acceptance", "Yes, this is what I wanted.",
      "--ownership-id", candidate.ownershipId,
      "--cwd", candidate.workspacePath,
    ]),
  );
  return JSON.parse(stdout) as IntegrateEnvelope;
}

describeManagedExecution("Spec #168 / ticket #174 — post-integration verification is opt-in", () => {
  let opencode: FakeOpenCodeEnvironment;
  let uv: FakeUvEnvironment;
  const repositories: TestRepository[] = [];

  beforeEach(async () => {
    opencode = await installFakeOpenCode();
    uv = await installFakeUv();
  });

  afterEach(async () => {
    uv.restore();
    opencode.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("runs the configured postIntegrationCommands exactly as written", async () => {
    const candidate = await stagePublishedCandidate(repositories, {
      commands: ["test -f README.md"],
      postIntegrationCommands: ["test -f feature.txt"],
    });

    const envelope = await integrateThroughCli(candidate);

    expect(envelope.ok).toBe(true);
    expect(envelope.operation).toBe("integrate");
    const verification = envelope.result.postIntegrationVerification;
    expect(verification).not.toBeNull();
    expect(verification?.cleanBefore).toBe(true);
    expect(verification?.cleanAfter).toBe(true);
    expect(verification?.commands.map((entry) => entry.command)).toEqual(["test -f feature.txt"]);
    expect(verification?.commands.map((entry) => entry.exitCode)).toEqual([0]);
    // Post-integration verification is not proof scope: it mints no receipt.
    expect(verification?.verification).toBeNull();
  }, 60_000);

  it("does NOT fall back to verification.commands when postIntegrationCommands is absent, and proves exact identity instead", async () => {
    const candidate = await stagePublishedCandidate(repositories, { commands: ["test -f README.md"] });

    // The config the CLI resolves really does carry the full plan, so the only
    // reason nothing runs is that the plan is no longer a fallback.
    const configText = await readFile(join(candidate.repository.root, ".poiesis", "config.jsonc"), "utf8");
    expect(configText).toContain("test -f README.md");
    expect(configText).not.toContain("postIntegrationCommands");

    const envelope = await integrateThroughCli(candidate);

    expect(envelope.ok).toBe(true);
    expect(envelope.result.postIntegrationVerification).toBeNull();
    // Exact identity validation replaces the redundant re-verification.
    expect(envelope.result.integration).toEqual({
      candidateSha: candidate.sha,
      candidateTree: candidate.tree,
      integrationSha: envelope.result.integratedSha,
      integrationTree: candidate.tree,
      contentMatchesCandidate: true,
    });
    expect(envelope.result.integratedTree).toBe(envelope.result.candidateTree);
    // Git, not a command, proves the published integration ref and its content.
    const remoteHead = (
      await run("git", ["rev-parse", "refs/heads/main"], { cwd: candidate.repository.remote })
    ).stdout;
    expect(remoteHead).toBe(envelope.result.integratedSha);
    const remoteTree = (
      await run("git", ["rev-parse", "refs/heads/main^{tree}"], { cwd: candidate.repository.remote })
    ).stdout;
    expect(remoteTree).toBe(candidate.tree);
  }, 60_000);

  it("keeps the full plan out of integration even when the runtime is the same image that verified the candidate", async () => {
    const candidate = await stagePublishedCandidate(repositories, { commands: ["test -f README.md", "test -f feature.txt"] });
    // The live plan is exactly what proof consumed before Publish; integration
    // must not run it again.
    const envelope = await integrateThroughCli(candidate);
    expect(envelope.result.postIntegrationVerification).toBeNull();
    expect(await packageVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 60_000);
});
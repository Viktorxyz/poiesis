import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process.js";
import { resolveLifecycleAuthority, verify } from "../src/git.js";
import { resolveLiveVerificationPlan, type VerificationEvidence } from "../src/verification-receipt.js";
import type { ProofPayload } from "../src/adapters.js";
import type { PoiesisConfig } from "../src/config.js";

export interface TestRepository {
  parent: string;
  root: string;
  remote: string;
  fixtures: string;
  baseSha: string;
}

export async function createTestRepository(): Promise<TestRepository> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-test-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  const fixtures = join(parent, "fixtures");
  await mkdir(root);
  await mkdir(fixtures);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis Test"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  const baseSha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
  return { parent, root, remote, fixtures, baseSha };
}

export interface TestConfigOptions {
  /**
   * Spec #138: drop the `tracker` and `delivery` blocks so the test exercises
   * the fresh-project path where those facts are INFERRED or DEFAULTED rather
   * than supplied. Defaults to supplying them, which is what the rest of the
   * suite depends on.
   */
  withTracker?: boolean;
  withDelivery?: boolean;
}

export function testConfig(
  repository: TestRepository,
  options: TestConfigOptions = {},
): PoiesisConfig {
  const withTracker = options.withTracker ?? true;
  const withDelivery = options.withDelivery ?? true;
  return {
    schema: 1,
    models: {
      reasoning: "openai/gpt-5.6-sol",
      execution: "minimax/MiniMax-M3",
    },
    repository: { remote: "origin", integrationBranch: "main" },
    ...(withTracker
      ? { tracker: { provider: "fixture" as const, project: join(repository.fixtures, "tracker") } }
      : {}),
    ...(withDelivery
      ? {
          delivery: {
            preview: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
            staging: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
            production: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
          },
        }
      : {}),
    verification: { commands: ["test -f README.md"] },
  };
}

export const proof = (sha: string, tree: string) => ({
  candidateSha: sha,
  candidateTree: tree,
  verified: true as const,
  specReview: { verdict: "PASS" as const, reviewerIdentity: "spec-review-session" },
  standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards-review-session" },
});

export const proofShell = (sha: string, tree: string) => ({
  candidateSha: sha,
  candidateTree: tree,
  verified: true as const,
  specReview: { verdict: "PASS" as const, reviewerIdentity: "spec-review-session" },
  standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards-review-session" },
});

export const publishEvidence = (sha: string, tree: string, branch: string) => ({
  candidateSha: sha,
  candidateTree: tree,
  verified: true as const,
  branch,
  remoteRef: `refs/heads/${branch}`,
  publishedHeadSha: sha,
  provider: "fixture" as const,
  action: "pushed" as const,
  changeRequest: { id: null, url: null },
  // Spec #168 / ticket #171: Publish evidence carries the identity of the
  // verification receipt Publish resolved. Preview validates this reference
  // structurally; the receipt itself was already resolved against live
  // authority by Publish.
  verification: verificationReference(sha, tree),
});

/** A structurally valid receipt reference for evidence fixtures. */
export const verificationReference = (sha: string, tree: string): VerificationEvidence => ({
  receiptId: `receipt-${sha.slice(0, 12)}`,
  receiptDigest: "a".repeat(64),
  runtime: "poiesis-test-runtime",
  candidateSha: sha,
  candidateTree: tree,
  verificationPlanDigest: "b".repeat(64),
});

/**
 * Spec #168 / ticket #171: the PRIMARY installation's live verification plan,
 * resolved exactly the way Publish resolves it.
 */
export async function liveVerificationPlan(cwd: string, ownershipId?: string): Promise<string[]> {
  const authority = await resolveLifecycleAuthority(cwd, ownershipId);
  return resolveLiveVerificationPlan(authority.primaryRoot);
}

export interface VerifiedProofInput {
  cwd: string;
  ownershipId?: string;
  candidateSha: string;
  candidateTree: string;
  /**
   * Verify commands. Defaults to the installation's live plan, which is what
   * Publish validates the receipt against; pass an explicit list only when the
   * test deliberately verifies off-plan.
   */
  verificationCommands?: readonly string[];
}

/**
 * Spec #168 / ticket #171: run the candidate's verification and return the
 * proof a caller must forward, carrying the runtime-owned receipt reference
 * Publish resolves. Replaces the old `proofShell(...)` shape for every
 * operation that consumes a proof after Verify.
 */
export async function verifiedProof(input: VerifiedProofInput): Promise<ProofPayload> {
  const commands = input.verificationCommands ?? (await liveVerificationPlan(input.cwd, input.ownershipId));
  const result = await verify({
    cwd: input.cwd,
    candidateSha: input.candidateSha,
    commands: [...commands],
    ...(input.ownershipId === undefined ? {} : { ownershipId: input.ownershipId }),
  });
  if (result.verification === null) {
    throw new Error("Verify issued no verification receipt; publish cannot be proven");
  }
  return { ...proofShell(input.candidateSha, input.candidateTree), verification: result.verification };
}

export const integration = (candidateTree: string, integrationSha: string, integrationTree: string) => ({
  candidateTree,
  integrationSha,
  integrationTree,
  contentMatchesCandidate: true as const,
});

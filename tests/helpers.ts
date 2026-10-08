import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { resolveContainmentCapability } from "../src/containment.js";
import { run } from "../src/process.js";
import { resolveLifecycleAuthority, verify } from "../src/git.js";
import { resolveLiveVerificationPlan, type VerificationEvidence } from "../src/verification-receipt.js";
import type { ProofPayload } from "../src/adapters.js";
import type { PoiesisConfig } from "../src/config.js";

/**
 * Spec #168 / ticket #176 — whether THIS host can strongly contain a managed
 * shell command.
 *
 * `verify`, `check`, and post-integration commands execute caller-supplied
 * command TEXT, so they refuse with `PROCESS_CONTAINMENT_UNAVAILABLE` before
 * spawning anything on a host with no delegated cgroup v2 subtree — Windows,
 * macOS, and non-delegated Linux. A test that drives one of those paths is
 * therefore testing the HOST's capability, not the code, and must skip rather
 * than fail there.
 *
 * The corollary is as important: pure resolver, refusal, evidence, and
 * control-flow assertions must NOT gate on it. Those prove the fail-closed
 * contract and have to run on every host, including the ones that cannot contain
 * anything — that is precisely where they carry their weight.
 */
export function strongContainmentAvailable(): boolean {
  return resolveContainmentCapability().available;
}

/** The per-test options these suites actually pass alongside a gated case. */
export interface ManagedExecutionOptions {
  timeout?: number;
  retry?: number;
}

/**
 * The ONE shared capability gate, in its two forms.
 *
 * Both read the same predicate, so every skip carries the same reason and no
 * suite can quietly introduce a second, looser gate. Use `describeManagedExecution`
 * when every case in a suite needs a real managed command, and
 * `itManagedExecution` for the individual cases inside a suite whose other cases
 * are pure.
 */
export function describeManagedExecution(name: string, fn: () => void): void {
  describe.skipIf(!strongContainmentAvailable())(name, fn);
}

export function itManagedExecution(
  name: string,
  fn: () => void | Promise<void>,
  options?: ManagedExecutionOptions,
): void;
export function itManagedExecution(
  name: string,
  options: ManagedExecutionOptions,
  fn: () => void | Promise<void>,
): void;
export function itManagedExecution(
  name: string,
  fn: () => void | Promise<void>,
  timeout: number,
): void;
export function itManagedExecution(name: string, ...rest: unknown[]): void {
  (it.skipIf(!strongContainmentAvailable()) as (...args: unknown[]) => void)(name, ...rest);
}

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
    // Spec #190 / ticket #191: `init` requires an explicit installation
    // mode. The suite installs private mode, which is the mode the
    // behaviour under test actually asserts.
    mode: "private",
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

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process.js";
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

export function testConfig(repository: TestRepository): PoiesisConfig {
  return {
    schema: 1,
    models: {
      reasoning: "openai/gpt-5.6-sol",
      execution: "minimax/MiniMax-M3",
    },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: join(repository.fixtures, "tracker") },
    delivery: {
      preview: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
      staging: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
      production: { adapter: "fixture", path: join(repository.fixtures, "delivery") },
    },
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

export const proofShell = (_sha: string, tree: string) => ({
  verified: true as const,
  specReview: { verdict: "PASS" as const, reviewerIdentity: "spec-review-session" },
  standardsReview: { verdict: "PASS" as const, reviewerIdentity: "standards-review-session" },
  candidateTree: tree,
});

export const stagingShell = (_sha: string, tree: string) => ({
  artifactIdentity: `artifact:${_sha}`,
  verified: true as const,
  candidateTree: tree,
});

export const integration = (candidateTree: string, integrationSha: string, integrationTree: string) => ({
  candidateTree,
  integrationSha,
  integrationTree,
  contentMatchesCandidate: true as const,
});

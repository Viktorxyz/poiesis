import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/process.js";

/**
 * Canonical package guidance for the proof object required by Publish and
 * Preview.
 *
 * The runtime already validates the ProofEvidence shape in
 * \`src/evidence.ts::validateProofEvidence\` (candidateSha, candidateTree,
 * verified: true, specReview { verdict: PASS, reviewerIdentity },
 * standardsReview { verdict: PASS, reviewerIdentity }). This file proves
 * the user-visible package guidance agrees with that runtime contract.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

const PROOF_SHAPE_PHRASINGS: readonly string[] = [
  "candidateSha",
  "candidateTree",
  "verified: true",
  "specReview",
  "verdict: PASS",
  "reviewerIdentity",
  "standardsReview",
];

const ORDERING_PHRASING = "Preview only after Publish succeeds";
const PROOF_ORDERING_PHRASING = "Publish only after Verify, Spec Review, and Standards Review pass";
const FAIL_CLOSED_PHRASING = "concrete Preview identity";
const FAIL_CLOSED_NO_FALSE_PREVIEW = "Poiesis must not claim that a Preview exists";
const FAIL_CLOSED_NO_AUTHOR_VALIDATION = "ask for Author validation until";

interface BuiltBin {
  binPath: string;
  cliPath: string;
  repoRoot: string;
  installDir: string;
}

let built: BuiltBin | undefined;

beforeAll(async () => {
  const repoRoot = join(import.meta.dirname, "..");
  // Use a dedicated out-dir under the repo to avoid colliding with the
  // \`dist\` directory owned by \`tests/cli-bin.test.ts\`. The CLI's real
  // behaviour is independent of where the bundled file lives; what we need
  // here is the rendered HELP text and the bundled binary's --version.
  const outDir = "dist-proof-to-preview";
  await run(
    "node",
    [
      "node_modules/tsup/dist/cli-default.js",
      "src/cli.ts",
      "--format",
      "esm",
      "--clean",
      "--no-dts",
      "--out-dir",
      outDir,
    ],
    { cwd: repoRoot, timeoutMs: 60_000 },
  );
  const cliPath = join(repoRoot, outDir, "cli.js");
  if (!existsSync(cliPath)) throw new Error("tsup did not produce dist/cli.js");

  const installDir = await mkdtemp(join(tmpdir(), "poiesis-proof-to-preview-"));
  const consumerBinDir = join(installDir, "node_modules", ".bin");
  const consumerNodeModules = join(installDir, "node_modules");
  await mkdir(consumerBinDir, { recursive: true });
  await symlink(join(repoRoot, "node_modules"), join(consumerNodeModules, "poiesis-cli"));
  const binPath = join(consumerBinDir, "poiesis");
  await symlink(cliPath, binPath);

  built = { binPath, cliPath, repoRoot, installDir };
}, 60_000);

afterAll(async () => {
  if (built) {
    await rm(built.installDir, { recursive: true, force: true });
    // Only remove the dedicated out-dir; never touch dist/.
    await rm(join(built.repoRoot, "dist-proof-to-preview"), { recursive: true, force: true });
  }
  built = undefined;
});

async function packageHelp(): Promise<string> {
  if (!built) throw new Error("bin not built");
  const result = await run("node", [built.binPath, "--help"], { cwd: built.installDir });
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

function extractHelpBlock(source: string): string {
  const helpMatch = source.match(/const HELP = \`([\s\S]*?)\`;\s*$/m);
  expect(helpMatch, "src/cli.ts must contain a const HELP = template literal").not.toBeNull();
  return helpMatch![1]!;
}

describe("proof-to-preview package guidance", () => {
  it("CLI HELP names the canonical proof fields required by Publish and Preview", async () => {
    const help = await packageHelp();
    for (const field of PROOF_SHAPE_PHRASINGS) {
      expect(help, "CLI HELP must name the proof field: " + field).toContain(field);
    }
  });

  it("CLI HELP states that Publish only accepts an identity-bound proof", async () => {
    const help = await packageHelp();
    expect(help).toContain("--proof");
    expect(help).toMatch(/identity-bound proof|identity bound proof/i);
  });

  it("CLI HELP states that Preview only runs after Publish succeeds", async () => {
    const help = await packageHelp();
    expect(help).toContain(ORDERING_PHRASING);
  });

  it("CLI HELP states that Publish only runs after Verify, Spec Review, and Standards Review pass for the same candidate", async () => {
    const help = await packageHelp();
    expect(help).toContain(PROOF_ORDERING_PHRASING);
  });

  it("CLI HELP is fail-closed: Poiesis must not claim that a Preview exists without a concrete Preview identity", async () => {
    const help = await packageHelp();
    expect(help).toContain(FAIL_CLOSED_NO_FALSE_PREVIEW);
    expect(help).toContain(FAIL_CLOSED_PHRASING);
    expect(help).toContain(FAIL_CLOSED_NO_AUTHOR_VALIDATION);
  });

  it("POIESIS_METHOD.md names the canonical proof fields required by Publish and Preview", async () => {
    const method = await readRepoFile("POIESIS_METHOD.md");
    for (const field of PROOF_SHAPE_PHRASINGS) {
      expect(method, "POIESIS_METHOD.md must name the proof field: " + field).toContain(field);
    }
  });

  it("POIESIS_METHOD.md states that Preview only runs after Publish succeeds", async () => {
    const method = await readRepoFile("POIESIS_METHOD.md");
    expect(method).toContain(ORDERING_PHRASING);
  });

  it("POIESIS_METHOD.md states that Publish only runs after Verify, Spec Review, and Standards Review pass", async () => {
    const method = await readRepoFile("POIESIS_METHOD.md");
    expect(method).toContain(PROOF_ORDERING_PHRASING);
  });

  it("POIESIS_METHOD.md is fail-closed: Poiesis must not claim that a Preview exists without a concrete Preview identity", async () => {
    const method = await readRepoFile("POIESIS_METHOD.md");
    expect(method).toContain(FAIL_CLOSED_NO_FALSE_PREVIEW);
    expect(method).toContain(FAIL_CLOSED_PHRASING);
    expect(method).toContain(FAIL_CLOSED_NO_AUTHOR_VALIDATION);
  });

  it("POIESIS_ROLE_POIESIS.md names the canonical proof fields required by Publish and Preview", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    for (const field of PROOF_SHAPE_PHRASINGS) {
      expect(role, "POIESIS_ROLE_POIESIS.md must name the proof field: " + field).toContain(field);
    }
  });

  it("POIESIS_ROLE_POIESIS.md states that Preview only runs after Publish succeeds", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    expect(role).toContain(ORDERING_PHRASING);
  });

  it("POIESIS_ROLE_POIESIS.md is fail-closed: Poiesis must not claim that a Preview exists without a concrete Preview identity", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    expect(role).toContain(FAIL_CLOSED_NO_FALSE_PREVIEW);
    expect(role).toContain(FAIL_CLOSED_PHRASING);
    expect(role).toContain(FAIL_CLOSED_NO_AUTHOR_VALIDATION);
  });

  it("OPENCODE_AGENT_POIESIS.md (installed/generated projection) names the canonical proof fields required by Publish and Preview", async () => {
    const agentDoc = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
    for (const field of PROOF_SHAPE_PHRASINGS) {
      expect(agentDoc, "OPENCODE_AGENT_POIESIS.md must name the proof field: " + field).toContain(field);
    }
  });

  it("OPENCODE_AGENT_POIESIS.md states that Preview only runs after Publish succeeds", async () => {
    const agentDoc = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
    expect(agentDoc).toContain(ORDERING_PHRASING);
  });

  it("OPENCODE_AGENT_POIESIS.md is fail-closed: Poiesis must not claim that a Preview exists without a concrete Preview identity", async () => {
    const agentDoc = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
    expect(agentDoc).toContain(FAIL_CLOSED_NO_FALSE_PREVIEW);
    expect(agentDoc).toContain(FAIL_CLOSED_PHRASING);
    expect(agentDoc).toContain(FAIL_CLOSED_NO_AUTHOR_VALIDATION);
  });

  it("src/cli.ts HELP lists the publish form before the preview form", async () => {
    const cliTs = await readRepoFile("src/cli.ts");
    const help = extractHelpBlock(cliTs);
    const publishIdx = help.indexOf("poiesis publish --sha <sha> --candidate-tree <tree> --proof <json>");
    const previewIdx = help.indexOf("poiesis preview --sha <sha> --candidate-tree <tree> --proof <json> --publish <json>");
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    expect(previewIdx).toBeGreaterThan(publishIdx);
  });

  it("OPENCODE_AGENT_POIESIS.md and the ROLE doc both teach the agent not to invent a Preview without a concrete identity", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    const agentDoc = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
    expect(role).toMatch(/not claim.*Preview|no false.*Preview/i);
    expect(agentDoc).toMatch(/not claim.*Preview|no false.*Preview/i);
  });
});

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProject } from "../src/inspect.js";
import {
  validateIntegrationEvidence,
  validateProofEvidence,
  validateStagingEvidence,
  type ProofEvidence,
  type StagingEvidence,
} from "../src/evidence.js";
import { createCommandDeliveryAdapter } from "../src/adapters.js";
import { run } from "../src/process.js";
import { atomicCreate } from "../src/fs.js";
import { ensureGitignore } from "../src/templates.js";
import { proofShell } from "./helpers.js";

const fixtures: string[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop()!;
    await rm(path, { recursive: true, force: true });
  }
});

async function createInspectRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-inspect-"));
  fixtures.push(parent);
  const root = join(parent, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.test"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fixture", version: "0.0.0", scripts: { test: "true" },
    dependencies: { react: "*", hono: "*" },
  }));
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await run("git", ["add", "package.json"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  return root;
}

describe("inspect", () => {
  it("resolves from a nested working directory and reports project facts", async () => {
    const root = await createInspectRepo();
    const inspection = await inspectProject(join(root, "src"));
    expect(inspection.git.root).toBe(root);
    expect(inspection.languages).toContain("TypeScript");
    expect(inspection.frameworks).toContain("react");
    expect(inspection.frameworks).toContain("hono");
    expect(inspection.scripts.test).toBe("true");
    expect(inspection.poiesis.installed).toBe(false);
  });
});

describe("filesystem ownership receipts", () => {
  it("does not report a no-op Git ignore update as authored", async () => {
    const root = await mkdtemp(join(tmpdir(), "poiesis-gitignore-"));
    fixtures.push(root);
    const path = join(root, ".gitignore");
    const snapshot = Buffer.from("present\n");
    await writeFile(path, snapshot);

    expect(await ensureGitignore(root, ["present"], snapshot)).toBeUndefined();
    expect(await readFile(path)).toEqual(snapshot);
  });

  it("removes its temporary file when no-replace publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "poiesis-atomic-create-"));
    fixtures.push(root);
    const path = join(root, "owned.txt");
    await writeFile(path, "foreign\n");

    await expect(atomicCreate(path, "managed\n")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("foreign\n");
    expect(await readdir(root)).toEqual(["owned.txt"]);
  });
});

describe("skill directory publication", () => {
  it("copies into a missing destination and refuses a preexisting directory", async () => {
    const { cp } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "poiesis-skill-cp-"));
    fixtures.push(root);
    const source = join(root, "source");
    const missing = join(root, "missing");
    const existing = join(root, "existing");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "owned\n");
    await mkdir(existing);
    await writeFile(join(existing, "foreign.md"), "keep\n");

    await cp(source, missing, { recursive: true, errorOnExist: true, force: false });
    expect(await readFile(join(missing, "SKILL.md"), "utf8")).toBe("owned\n");
    await expect(cp(source, existing, { recursive: true, errorOnExist: true, force: false })).rejects.toMatchObject({
      code: "ERR_FS_CP_EEXIST",
    });
    expect(await readFile(join(existing, "foreign.md"), "utf8")).toBe("keep\n");
  });
});

describe("evidence validation", () => {
  const tree = "b".repeat(40);
  const proof = (sha: string): ProofEvidence => ({
    candidateSha: sha,
    candidateTree: tree,
    verified: true,
    specReview: { verdict: "PASS", reviewerIdentity: "spec-reviewer" },
    standardsReview: { verdict: "PASS", reviewerIdentity: "standards-reviewer" },
  });

  it("rejects Proof belonging to a different candidate", () => {
    expect(() => validateProofEvidence(proof("a".repeat(40)), "b".repeat(40))).toThrow(/different candidate/);
  });

  it("rejects incomplete Proof and missing reviewer identity", () => {
    expect(() => validateProofEvidence({ ...proof("a".repeat(40)), verified: false } as unknown as ProofEvidence, "a".repeat(40))).toThrow(/verification has not passed/);
    expect(() => validateProofEvidence({ ...proof("a".repeat(40)), specReview: { verdict: "PASS", reviewerIdentity: " " } }, "a".repeat(40))).toThrow(/identity is required/);
  });

  it("rejects Staging identity mismatch and unverified staging", () => {
    const sha = "a".repeat(40);
    expect(() => validateStagingEvidence({ candidateSha: sha, candidateTree: tree, verified: true, artifactIdentity: "" } satisfies StagingEvidence, sha)).toThrow(/Staging artifact identity is required/);
    expect(() => validateStagingEvidence({ candidateSha: sha, candidateTree: tree, verified: false, artifactIdentity: "x" } as unknown as StagingEvidence, sha)).toThrow(/verification has not passed/);
  });

  it("rejects Integration evidence that does not prove content equality", () => {
    const candidateSha = "a".repeat(40);
    const candidateTree = "a".repeat(40);
    expect(() => validateIntegrationEvidence({ candidateSha, candidateTree: "b".repeat(40), integrationSha: "c".repeat(40), integrationTree: "b".repeat(40), contentMatchesCandidate: true }, candidateSha, candidateTree)).toThrow(/does not match the accepted candidate tree/);
    expect(() => validateIntegrationEvidence({ candidateSha, candidateTree, integrationSha: "not-a-sha", integrationTree: candidateTree, contentMatchesCandidate: true }, candidateSha, candidateTree)).toThrow(/Exact integrated revision is required/);
    expect(() => validateIntegrationEvidence({ candidateSha, candidateTree, integrationSha: "c".repeat(40), integrationTree: candidateTree, contentMatchesCandidate: false } as never, candidateSha, candidateTree)).toThrow(/Integrated content has not been proven/);
    expect(() => validateIntegrationEvidence({ candidateSha: "z".repeat(40), candidateTree, integrationSha: "c".repeat(40), integrationTree: candidateTree, contentMatchesCandidate: true }, candidateSha, candidateTree)).toThrow(/different candidate/);
  });
});

describe("CommandDeliveryAdapter", () => {
  it("substitutes {sha} and {target} and forwards candidate identity to the delivery command", async () => {
    const parent = await mkdtemp(join(tmpdir(), "poiesis-delivery-"));
    fixtures.push(parent);
    const root = join(parent, "repo");
    await mkdir(root, { recursive: true });
    const sha = "d".repeat(40);
    const receiptScript = join(parent, "delivery-receipt.sh");
    await writeFile(receiptScript, "#!/bin/sh\ncat <<JSON\n{\"status\":\"created\",\"url\":\"https://example.com/$POIESIS_DELIVERY_TARGET/$POIESIS_CANDIDATE_SHA\",\"id\":\"sha-$POIESIS_CANDIDATE_SHA-target-$POIESIS_DELIVERY_TARGET\",\"sha\":\"$POIESIS_CANDIDATE_SHA\",\"target\":\"$POIESIS_DELIVERY_TARGET\",\"verified\":true}\nJSON\n");
    await chmod(receiptScript, 0o755);
    const adapter = createCommandDeliveryAdapter(
      { adapter: "command", command: [receiptScript, "deploy", "{target}", "{sha}"] },
      root,
    );
    const preview = await adapter.preview({ sha, candidateTree: sha, proof: proofShell(sha, sha) });
    expect(preview.url).toBe(`https://example.com/preview/${sha}`);
    expect(preview.id).toContain(sha);
  });
});

/**
 * Spec #139 / ticket #157 — a delivery mutation's guards belong to the
 * PRIMARY checkout's installation; the delivery itself belongs to the
 * worktree it was invoked in.
 *
 * The defect this pins is an authority split, and it is silent. Poiesis
 * installs into the primary checkout, so a linked worktree of the same clone
 * carries no `.poiesis/manifest.json` and no `.poiesis/config.jsonc` of its
 * own. `previewDelivery` / `promoteDelivery` used to run their runtime-identity,
 * installed-state, and delivery-policy guards against the root they were
 * handed, so a legitimate Preview or promotion launched from a linked worktree
 * read the WORKTREE's absence of an install and refused — with
 * `RUNTIME_VERSION_MISMATCH` or `CONFIG_NOT_INSTALLED` naming a managed path
 * the Author never had. The library seam and the `poiesis` CLI disagreed with
 * each other about the same operation, because only the CLI resolved the
 * installation root.
 *
 * The contract these tests hold:
 *
 *   1. AUTHORITY IS DERIVED, NOT SUPPLIED. The delivery seams derive the
 *      installation root structurally, from Git's own two-path report, and no
 *      caller can pass an authority in. A configured linked worktree therefore
 *      previews and promotes against the PRIMARY install: its guards read the
 *      primary's manifest version, installed config, and delivery block, and a
 *      worktree with no Poiesis state of its own is not an uninstalled
 *      project.
 *   2. EXECUTION STAYS WHERE IT WAS INVOKED. The candidate is resolved and
 *      the delivery command runs with its working directory in the worktree the
 *      caller named, so the worktree's own candidate and evidence are the ones
 *      the operation is about.
 *   3. THE LIBRARY AND THE CLI AGREE. The same operation, from the same
 *      worktree, through either surface, produces the same identities and the
 *      same execution directory.
 *
 * The "guards read the primary" half of the claim is proved by DECOYS rather
 * than by a bare worktree alone: a worktree that carries its own
 * version-matching manifest and an explicitly DEFERRED config is the trap, and
 * the test first shows the trap refuses on its own before showing that the
 * real operation is governed by the primary instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  previewDelivery,
  promoteDelivery,
  type DeliveryIdentity,
  type PreviewDeliveryInput,
  type PreviewDeliveryResult,
  type ProductionPromotionInput,
  type StagingPromotionInput,
} from "../src/adapters.js";
import { commandPreview, commandPromote } from "../src/cli.js";
import { resolveTree } from "../src/git.js";
import { assertDeliveryPolicyAllows } from "../src/lifecycle-policy.js";
import { init, resolveInstallationRoot } from "../src/maintenance.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const CHANGE_BRANCH = "poiesis/linked-change";
const WORKTREE_BRANCH = "poiesis/linked-worktree";

/** One delivery subprocess, as the probe recorded it. */
interface DeliveryRun {
  target: string;
  cwd: string;
  sha: string;
  candidateTree: string;
  artifactIdentity: string;
}

interface LinkedDeliveryFixture {
  repository: TestRepository;
  /** The linked worktree of the same clone: no `.poiesis` state of its own. */
  worktree: string;
  changeBranch: string;
  sha: string;
  tree: string;
  delivery: { adapter: "command"; command: string[] };
  logPath: string;
}

/**
 * The delivery probe. It answers the delivery receipt schema, mints a
 * target-specific artifact identity, and RECORDS its own working directory —
 * so "executed in the linked worktree" is evidence rather than an assumption
 * about which root the adapter resolved. Production echoes the verified
 * Staging identity it is given, which is the one thing the production adapter
 * requires it to preserve.
 */
function probeScript(logPath: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    "const [, , sha, target] = process.argv;",
    "const source = process.env.POIESIS_DELIVERY_IDENTITY;",
    'const artifactIdentity = target === "production" ? JSON.parse(source).artifactIdentity : `artifact-${target}-${sha}`;',
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ target, cwd: process.cwd(), sha, candidateTree: process.env.POIESIS_CANDIDATE_TREE, artifactIdentity }) + "\\n");`,
    'process.stdout.write(JSON.stringify({ sha, candidateTree: process.env.POIESIS_CANDIDATE_TREE, target, verified: true, artifactIdentity, artifact: artifactIdentity }) + "\\n");',
  ].join("\n");
}

async function configuredInstall(): Promise<LinkedDeliveryFixture> {
  const repository = await createTestRepository();
  repositories.push(repository);
  const script = join(repository.parent, "poiesis-delivery-probe.mjs");
  const logPath = join(repository.parent, "delivery-runs.jsonl");
  await writeFile(script, probeScript(logPath), "utf8");
  const delivery = { adapter: "command" as const, command: ["node", script, "{sha}", "{target}"] };
  // The Publish evidence the preview revalidates against the remote.
  await run("git", ["push", "--quiet", "origin", `${repository.baseSha}:refs/heads/${CHANGE_BRANCH}`], {
    cwd: repository.root,
  });
  await init(
    repository.root,
    { ...testConfig(repository), delivery: { preview: delivery, staging: delivery, production: delivery } },
    { skipSkills: true, allowFixtureAdapters: true },
  );
  const worktree = join(repository.parent, "linked");
  await run("git", ["worktree", "add", "--quiet", "--no-track", "-b", WORKTREE_BRANCH, worktree], {
    cwd: repository.root,
  });
  return {
    repository,
    worktree,
    changeBranch: CHANGE_BRANCH,
    sha: repository.baseSha,
    tree: await resolveTree(repository.root, repository.baseSha),
    delivery,
    logPath,
  };
}

function deliveryRuns(fixture: LinkedDeliveryFixture): DeliveryRun[] {
  if (!existsSync(fixture.logPath)) return [];
  return readFileSync(fixture.logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DeliveryRun);
}

/**
 * The recorded working directory is the child's, so it is compared through
 * `realpath`: a temp directory that is itself a symlink must not turn a
 * correct execution directory into a false failure.
 */
async function expectRunInside(root: string, run: DeliveryRun, label: string): Promise<void> {
  expect(await realpath(run.cwd), `${label} must execute in ${root}`).toBe(await realpath(root));
}

function previewInput(fixture: LinkedDeliveryFixture): PreviewDeliveryInput {
  return {
    sha: fixture.sha,
    candidateTree: fixture.tree,
    proof: proofShell(fixture.sha, fixture.tree),
    publish: publishEvidence(fixture.sha, fixture.tree, fixture.changeBranch),
    remote: "origin",
  };
}

function stagingInput(fixture: LinkedDeliveryFixture, identity: DeliveryIdentity): StagingPromotionInput {
  return { sha: fixture.sha, target: "staging", candidateTree: fixture.tree, identity };
}

function productionInput(fixture: LinkedDeliveryFixture, identity: DeliveryIdentity): ProductionPromotionInput {
  return {
    sha: fixture.sha,
    target: "production",
    candidateTree: fixture.tree,
    identity,
    productionAuthorization: {
      candidateSha: fixture.sha,
      candidateTree: fixture.tree,
      stagingArtifactIdentity: identity.artifactIdentity,
      integrationSha: fixture.sha,
      authorIdentity: "author-157",
      approved: true,
    },
    integrationRemote: "origin",
    integrationBranch: "main",
    proof: proofShell(fixture.sha, fixture.tree),
    integration: {
      candidateSha: fixture.sha,
      candidateTree: fixture.tree,
      integrationSha: fixture.sha,
      integrationTree: fixture.tree,
      contentMatchesCandidate: true,
    },
  };
}

/** The full Preview -> Staging -> Production chain from one root. */
async function deliverChain(
  root: string,
  fixture: LinkedDeliveryFixture,
): Promise<{ preview: PreviewDeliveryResult; staging: DeliveryIdentity; runs: DeliveryRun[] }> {
  const preview = await previewDelivery(fixture.delivery, previewInput(fixture), root);
  const staging = await promoteDelivery(fixture.delivery, stagingInput(fixture, preview), root);
  await promoteDelivery(fixture.delivery, productionInput(fixture, staging), root);
  return { preview, staging, runs: deliveryRuns(fixture) };
}

const repositories: TestRepository[] = [];
let env: FakeOpenCodeEnvironment | undefined;

beforeEach(async () => {
  env = await installFakeOpenCode();
});

afterEach(async () => {
  env?.restore();
  await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
});

describe("a configured linked worktree is guarded by the primary install and delivers inside the worktree", () => {
  it("previews from the linked worktree instead of refusing an install it does not carry", async () => {
    const fixture = await configuredInstall();
    // Precondition: the worktree is a linked worktree of the primary install,
    // and it carries none of the primary's managed Poiesis state.
    expect(await resolveInstallationRoot(fixture.worktree)).toBe(resolve(fixture.repository.root));
    expect(existsSync(join(fixture.worktree, ".poiesis", "manifest.json"))).toBe(false);
    expect(existsSync(join(fixture.worktree, ".poiesis", "config.jsonc"))).toBe(false);

    const preview = await previewDelivery(fixture.delivery, previewInput(fixture), fixture.worktree);

    expect(preview).toMatchObject({
      sha: fixture.sha,
      candidateSha: fixture.sha,
      candidateTree: fixture.tree,
      target: "preview",
      verified: true,
      artifactIdentity: `artifact-preview-${fixture.sha}`,
    });
    const runs = deliveryRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      target: "preview",
      sha: fixture.sha,
      candidateTree: fixture.tree,
      artifactIdentity: `artifact-preview-${fixture.sha}`,
    });
    await expectRunInside(fixture.worktree, runs[0]!, "the Preview delivery command");
  }, 120_000);

  it("promotes to staging from the linked worktree and preserves the Preview identity", async () => {
    const fixture = await configuredInstall();
    const preview = await previewDelivery(fixture.delivery, previewInput(fixture), fixture.worktree);

    const staging = await promoteDelivery(fixture.delivery, stagingInput(fixture, preview), fixture.worktree);

    expect(staging).toMatchObject({
      sha: fixture.sha,
      candidateSha: fixture.sha,
      candidateTree: fixture.tree,
      target: "staging",
      verified: true,
      artifactIdentity: `artifact-staging-${fixture.sha}`,
    });
    const runs = deliveryRuns(fixture);
    expect(runs.map((entry) => entry.target)).toEqual(["preview", "staging"]);
    await expectRunInside(fixture.worktree, runs[1]!, "the Staging delivery command");
  }, 120_000);

  it("promotes to production from the linked worktree and preserves the Staging artifact", async () => {
    const fixture = await configuredInstall();
    const preview = await previewDelivery(fixture.delivery, previewInput(fixture), fixture.worktree);
    const staging = await promoteDelivery(fixture.delivery, stagingInput(fixture, preview), fixture.worktree);

    const production = await promoteDelivery(fixture.delivery, productionInput(fixture, staging), fixture.worktree);

    expect(production).toMatchObject({
      sha: fixture.sha,
      candidateSha: fixture.sha,
      candidateTree: fixture.tree,
      target: "production",
      verified: true,
      // Production must carry the verified Staging artifact forward.
      artifactIdentity: staging.artifactIdentity,
    });
    const runs = deliveryRuns(fixture);
    expect(runs.map((entry) => entry.target)).toEqual(["preview", "staging", "production"]);
    await expectRunInside(fixture.worktree, runs[2]!, "the Production delivery command");
  }, 120_000);

  it("still guards and delivers in the primary checkout when the primary is the root", async () => {
    const fixture = await configuredInstall();
    const { preview, runs } = await deliverChain(fixture.repository.root, fixture);

    expect(preview.target).toBe("preview");
    expect(runs.map((entry) => entry.target)).toEqual(["preview", "staging", "production"]);
    expect(runs.map((entry) => entry.artifactIdentity)).toEqual([
      `artifact-preview-${fixture.sha}`,
      `artifact-staging-${fixture.sha}`,
      `artifact-staging-${fixture.sha}`,
    ]);
    for (const entry of runs) await expectRunInside(fixture.repository.root, entry, "the primary delivery command");
  }, 120_000);
});

/**
 * The authority claim, proved against a trap rather than against a bare
 * worktree. A linked worktree that carries its OWN version-matching manifest
 * and an explicitly DEFERRED installed config is exactly the shape that makes
 * "which install governs?" observable: read the worktree and the operation is
 * blocked, read the primary and it is configured. The primary installation is
 * the authority every linked worktree of the clone shares.
 */
describe("a linked worktree's own install never displaces the primary installation as the authority", () => {
  it("is governed by the configured primary even when the worktree declares a deferred install", async () => {
    const fixture = await configuredInstall();
    const decoy = join(fixture.worktree, ".poiesis");
    await mkdir(decoy, { recursive: true });
    await writeFile(
      join(decoy, "manifest.json"),
      await readFile(join(fixture.repository.root, ".poiesis", "manifest.json"), "utf8"),
      "utf8",
    );
    const installed = JSON.parse(
      await readFile(join(fixture.repository.root, ".poiesis", "config.jsonc"), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      join(decoy, "config.jsonc"),
      JSON.stringify({ ...installed, delivery: { mode: "deferred" } }),
      "utf8",
    );

    // The trap refuses on its own, so a later success cannot be explained by
    // the worktree's deferral being invisible.
    await expect(assertDeliveryPolicyAllows(fixture.worktree, "poiesis preview")).rejects.toMatchObject({
      code: "DELIVERY_DEFERRED",
    });

    const preview = await previewDelivery(fixture.delivery, previewInput(fixture), fixture.worktree);

    expect(preview).toMatchObject({ target: "preview", verified: true, artifactIdentity: `artifact-preview-${fixture.sha}` });
    const runs = deliveryRuns(fixture);
    expect(runs).toHaveLength(1);
    await expectRunInside(fixture.worktree, runs[0]!, "the Preview delivery command");
  }, 120_000);
});

describe("the delivery library seam and the poiesis CLI decide alike", () => {
  it("produces the same identities and the same execution directory from the linked worktree", async () => {
    const fixture = await configuredInstall();
    const { preview, staging, runs: libraryRuns } = await deliverChain(fixture.worktree, fixture);

    const candidate = ["--sha", fixture.sha, "--candidate-tree", fixture.tree, "--cwd", fixture.worktree];
    // The CLI prints a success envelope per command; the delivery identities
    // under test are read from the probe log, so the envelope is only noise.
    const envelope = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await commandPreview([
        ...candidate,
        "--proof",
        JSON.stringify(proofShell(fixture.sha, fixture.tree)),
        "--publish",
        JSON.stringify(publishEvidence(fixture.sha, fixture.tree, fixture.changeBranch)),
      ]);
      // The CLI consumes the operation-produced receipts, exactly as an
      // operator would hand them over.
      await commandPromote([...candidate, "--target", "staging", "--identity", JSON.stringify(preview)]);
      await commandPromote([
        ...candidate,
        "--target",
        "production",
        "--identity",
        JSON.stringify(staging),
        "--authorization",
        JSON.stringify(productionInput(fixture, staging).productionAuthorization),
        "--proof",
        JSON.stringify(proofShell(fixture.sha, fixture.tree)),
        "--integration",
        JSON.stringify(productionInput(fixture, staging).integration),
      ]);
    } finally {
      envelope.mockRestore();
    }

    const allRuns = deliveryRuns(fixture);
    expect(allRuns.map((entry) => entry.target)).toEqual([
      "preview",
      "staging",
      "production",
      "preview",
      "staging",
      "production",
    ]);
    // The CLI's deliveries are the same artifacts the library produced for the
    // same candidate, and the same execution directory the library used.
    expect(allRuns.slice(3).map((entry) => entry.artifactIdentity)).toEqual(
      libraryRuns.map((entry) => entry.artifactIdentity),
    );
    for (const entry of allRuns) await expectRunInside(fixture.worktree, entry, "a CLI delivery command");
  }, 180_000);
});

describe("COMPATIBILITY documents the installation authority a linked worktree shares", () => {
  const compatibility = readFileSync(join(REPO_ROOT, "COMPATIBILITY.md"), "utf8");

  it("states that the primary checkout owns the installation and every linked worktree shares it", () => {
    expect(compatibility).toContain("### Installation authority and linked worktrees");
    expect(compatibility).toContain("Poiesis installs into the PRIMARY checkout of a clone");
    expect(compatibility).toContain("that installation is the authority for every guarded operation in every linked worktree");
  });

  it("states that the authority is derived structurally and never supplied by a caller", () => {
    expect(compatibility).toContain("No caller supplies an authority root");
    expect(compatibility).toContain("--absolute-git-dir --git-common-dir");
  });

  it("states that the guards read the primary while delivery executes in the invoked worktree", () => {
    expect(compatibility).toContain("the delivery command runs in the linked worktree");
    expect(compatibility).toContain("The `poiesis` CLI and the library seam reach the same decision");
  });

  it("states the portable POSIX/Windows common-directory path semantics", () => {
    expect(compatibility).toContain("/srv/primary/.git");
    expect(compatibility).toContain("C:\\primary\\.git");
    expect(compatibility).toContain("a Windows path has no `/` in it");
  });
});

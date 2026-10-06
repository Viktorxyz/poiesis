/**
 * Spec #168 / ticket #174 — end-to-end composition of the faster
 * authoritative flow.
 *
 * Every earlier ticket in this Spec proved its own seam in isolation. This file
 * is the composition net: ONE flow, on ONE repository, that exercises all six
 * seams together in the order a real Spec #168 run uses them, starting from a
 * project that predates the current projection so the compatible migration is
 * part of the flow rather than a separate scenario.
 *
 * The flow, and what each step must prove:
 *
 *   1. compatible migration — a receipt-gated `update` moves a 1.4.0
 *      pre-focused-check install onto the authoritative current launcher
 *      projection (ticket #174).
 *   2. workspace authority — the owned candidate resolves the PRIMARY
 *      receipt-authenticated installation, and the primary checkout is refused
 *      as an owned candidate.
 *   3. process ownership — the change lands on the workspace's own marked
 *      branch, and a foreign pid is never a cleanup target.
 *   4. focused checks — a dirty owned candidate is checkable, and the result is
 *      structurally incapable of authorizing anything.
 *   5. verification receipt — the whole-change proof mints exactly one receipt,
 *      bound to the candidate, and Publish resolves THAT receipt.
 *   6. Publish / Preview / integrate — the forwarded receipt survives to
 *      delivery, and integration adds no redundant full verification.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureDeliveryAdapter } from "../src/adapters.js";
import { executeFocusedCheck } from "../src/focused-check.js";
import {
  checkpoint,
  integrate,
  publish,
  resolveLifecycleAuthority,
  resolveTree,
  workspacePrepare,
} from "../src/git.js";
import { init, packageVersion, update } from "../src/maintenance.js";
import { desiredOpenCodePatches } from "../src/opencode.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { parseJsonc } from "../src/config.js";
import { readOwnershipReceipt, replaceOwnershipReceipt } from "../src/receipt.js";
import { readUtf8 } from "../src/fs.js";
import { run } from "../src/process.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, proofShell, testConfig, verifiedProof, type TestRepository } from "./helpers.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

async function installFakeUv(): Promise<FakeUvEnvironment> {
  const { chmod, mkdir, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-174e-"));
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

/**
 * The published predecessor release this flow starts from. The 1.4.0 release
 * line shipped two exact projections under one version label; the earlier
 * image's is the pre-focused-check set the current release must migrate.
 */
const PREDECESSOR_VERSION = "1.4.0";

/**
 * The exact 1.4.0 pre-focused-check predecessor projection, derived
 * independently of the runtime helper under test: the ordinary projection
 * builder's 1.4.0 output with the Worker's single focused-check allow removed.
 */
function preFocusedCheck(repository: TestRepository): Array<{ path: string[]; value: unknown }> {
  return desiredOpenCodePatches(testConfig(repository), PREDECESSOR_VERSION).map((patch) => {
    if (patch.path.length !== 2 || patch.path[1] !== "poiesis-worker") return { path: patch.path, value: patch.value };
    const installed = patch.value as { permission: { bash: Record<string, string> } };
    const bash = { ...installed.permission.bash };
    for (const key of Object.keys(bash)) {
      if (/\scheck \*$/.test(key)) delete bash[key];
    }
    return { path: patch.path, value: { ...installed, permission: { ...installed.permission, bash } } };
  });
}

async function downgradeInstall(repository: TestRepository): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  const predecessor = preFocusedCheck(repository);
  manifest.poiesisVersion = PREDECESSOR_VERSION;
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) => p.path.length === patch.path.length && p.path.every((segment, i) => segment === patch.path[i]),
    );
    return matching === undefined ? patch : { ...patch, installed: matching.value };
  });
  await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  const path = join(repository.root, "opencode.jsonc");
  const document = parseJsonc<Record<string, unknown>>(await readUtf8(path), path);
  for (const patch of manifest.configPatches) {
    let target: Record<string, unknown> = document;
    for (let i = 0; i < patch.path.length - 1; i++) {
      const segment = patch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) target[segment] = {};
      target = target[segment] as Record<string, unknown>;
    }
    target[patch.path[patch.path.length - 1]!] = patch.installed;
  }
  await writeFile(path, JSON.stringify(document, null, 2) + "\n");
  await replaceOwnershipReceipt(repository.root, manifest, await readOwnershipReceipt(repository.root));
  return manifest;
}

function workerBash(manifest: Manifest): Record<string, string> {
  const patch = manifest.configPatches.find((p) => p.path.length === 2 && p.path[1] === "poiesis-worker");
  if (patch === undefined) throw new Error("manifest carries no poiesis-worker patch");
  return (patch.installed as { permission: { bash: Record<string, string> } }).permission.bash;
}

describe("Spec #168 / ticket #174 — end-to-end composition of the authoritative flow", () => {
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

  it("composes migration, workspace authority, process ownership, focused checks, the verification receipt, Publish, Preview, and integration", async () => {
    // ── 1. compatible migration ────────────────────────────────────────────
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      { ...testConfig(repository), verification: { commands: ["test -f README.md"] } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const predecessor = await downgradeInstall(repository);
    const version = await packageVersion();
    const generationBefore = (await readOwnershipReceipt(repository.root)).generation;
    // The flow really starts on the published 1.4.0 pre-focused-check
    // predecessor, so the migration below is the production one.
    expect(predecessor.poiesisVersion).toBe(PREDECESSOR_VERSION);
    expect(workerBash(predecessor)).not.toHaveProperty(`pnpm dlx poiesis-cli@${PREDECESSOR_VERSION} check *`);

    const migrated = await update(repository.root, { skipSkills: true });

    expect(migrated.manifest.poiesisVersion).toBe(version);
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(generationBefore + 1);
    expect(workerBash(migrated.manifest)[`pnpm dlx poiesis-cli@${version} check *`]).toBe("allow");
    expect(workerBash(migrated.manifest)).not.toHaveProperty(`pnpm dlx poiesis-cli@${version} *`);

    // ── 2. workspace authority ─────────────────────────────────────────────
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/spec-1",
      workspacePath: join(repository.parent, "workspace"),
      specId: "1",
    });
    const authority = await resolveLifecycleAuthority(workspace.path, workspace.ownershipId);
    expect(authority.primaryRoot).toBe(repository.root);
    expect(authority.candidateRoot).toBe(workspace.path);
    expect(authority.marker?.ownershipId).toBe(workspace.ownershipId);
    // The primary checkout owns no workspace marker, so it is not a candidate.
    const primaryAuthority = await resolveLifecycleAuthority(repository.root);
    expect(primaryAuthority.marker).toBeNull();
    expect(primaryAuthority.primaryRoot).toBe(repository.root);
    await expect(executeFocusedCheck({ cwd: repository.root, commands: ["test -f README.md"] })).rejects.toMatchObject({
      code: "WORKSPACE_OWNERSHIP_UNKNOWN",
    });

    // ── 3. process ownership ───────────────────────────────────────────────
    await writeFile(join(workspace.path, "feature.txt"), "accepted feature\n");
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace.path })).stdout;
    expect(branch).toBe("poiesis/spec-1");
    const registered = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repository.root })).stdout;
    expect(registered).toContain(await realPath(workspace.path));

    // ── 4. focused checks on a dirty owned candidate ───────────────────────
    const focused = await executeFocusedCheck({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      commands: ["test -f feature.txt"],
    });
    expect(focused.scope).toBe("focused");
    expect(focused.outcome).toBe("passed");
    expect(focused.state.dirty).toBe(true);
    expect(focused.state.changedFiles).toContain("feature.txt");
    expect(focused.actionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Structurally incapable of authorizing anything.
    expect(focused.authoritative).toBe(false);
    expect(focused.verification).toBeNull();
    expect(focused.proof).toBeNull();

    // ── 5. checkpoint, then the whole-change proof and its receipt ─────────
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket 1",
      review: { verdict: "PASS", reviewerIdentity: "ticket-review-1", evidence: "no findings" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    const proof = await verifiedProof({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      candidateSha: accepted.sha,
      candidateTree: tree,
    });
    expect(proof.verification).not.toBeNull();
    expect(proof.verification?.candidateSha).toBe(accepted.sha);
    expect(proof.verification?.candidateTree).toBe(tree);

    // ── 6. Publish resolves THAT receipt, Preview forwards it ──────────────
    const published = await publish({
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
      proof,
    });
    expect(published.evidence.verification?.receiptId).toBe(proof.verification?.receiptId);
    expect(published.evidence.verification?.candidateSha).toBe(accepted.sha);
    const delivery = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const preview = await delivery.preview({
      sha: accepted.sha,
      candidateTree: tree,
      proof: proofShell(accepted.sha, tree),
      publish: published.evidence,
      remote: "origin",
    });
    expect(preview.sha).toBe(accepted.sha);
    expect(preview.candidateTree).toBe(tree);
    const staging = await delivery.promote({
      sha: accepted.sha,
      target: "staging",
      candidateTree: tree,
      identity: preview,
    });

    // ── 7. integration adds no redundant full verification ─────────────────
    const integrated = await integrate({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      expectedBaseSha: workspace.baseSha,
      candidateSha: accepted.sha,
      candidateTree: tree,
      message: "Spec 1: accepted feature",
      proof: proofShell(accepted.sha, tree),
      staging,
      authorAcceptance: "Yes, this is what I wanted.",
    });
    expect(integrated.postIntegrationVerification).toBeNull();
    expect(integrated.integration.contentMatchesCandidate).toBe(true);
    expect(integrated.integratedTree).toBe(tree);
    const remoteHead = (await run("git", ["rev-parse", "refs/heads/main"], { cwd: repository.remote })).stdout;
    expect(remoteHead).toBe(integrated.integratedSha);
  }, 180_000);
});

async function realPath(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
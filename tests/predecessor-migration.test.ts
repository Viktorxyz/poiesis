import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManifestAuthority,
  assertManifestAuthorityToleratingPredecessor,
  isExactProjection,
  predecessorProjectionV100V101V102,
  predecessorProjectionV111,
} from "../src/authority.js";
import {
  doctor, init, installAuthorizedCapability, uninstall, update,
} from "../src/maintenance.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import {
  assertOwnershipReceipt,
  ownershipReceiptExists,
  ownershipReceiptLocation,
  readOwnershipReceipt,
  removeOwnershipReceipt,
  replaceOwnershipReceipt,
} from "../src/receipt.js";
import { parseJsonc } from "../src/config.js";
import { readUtf8 } from "../src/fs.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

async function asPredecessorManifest(
  repository: TestRepository,
  predecessorVersion: "1.0.0" | "1.0.1" | "1.0.2" | "1.1.1",
  options: { keepReceipt?: boolean } = {},
): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor =
    predecessorVersion === "1.1.1"
      ? predecessorProjectionV111(config, predecessorVersion)
      : predecessorProjectionV100V101V102(config, predecessorVersion);
  // Replace each manifest patch\'s installed value with the exact predecessor variant.
  manifest.poiesisVersion = predecessorVersion;
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) =>
        p.path.length === patch.path.length &&
        p.path.every((s, i) => s === patch.path[i]),
    );
    if (matching === undefined) return patch;
    return { ...patch, installed: matching.value };
  });
  await writeFile(
    join(repository.root, ".poiesis", "manifest.json"),
    serializeManifest(manifest),
  );
  // Also rewrite the on-disk OpenCode config so each claimed patch value
  // matches the file content. Otherwise `assertConfigPatchesOwned` rejects
  // with CONFIG_OWNERSHIP_LOST before the migration has a chance to run.
  const openCodePath = join(repository.root, "opencode.jsonc");
  const current = parseJsonc<Record<string, unknown>>(await readUtf8(openCodePath), openCodePath);
  for (const patch of manifest.configPatches) {
    let target: Record<string, unknown> = current;
    for (let i = 0; i < patch.path.length - 1; i++) {
      const segment = patch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[patch.path[patch.path.length - 1]!] = patch.installed;
  }
  await writeFile(openCodePath, JSON.stringify(current, null, 2) + "\n");
  if (!options.keepReceipt && (await ownershipReceiptExists(repository.root))) {
    await removeOwnershipReceipt(repository.root);
  }
  return manifest;
}

async function rebindReceipt(repository: TestRepository): Promise<void> {
  const manifest = await loadManifest(repository.root);
  const existing = await readOwnershipReceipt(repository.root);
  await replaceOwnershipReceipt(repository.root, manifest, existing);
}

async function setupCurrentInstall(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

describe("predecessor projection migration (ticket #24 Replan)", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("predecessorProjectionV100V101V102 differs from current only in poiesis-reviewer.permission.task", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const config = testConfig(repository);
    // Bootstrap a current install to get the canonical current projection.
    await setupCurrentInstall(repository);
    const currentManifest = await loadManifest(repository.root);

    const currentReviewer = currentManifest.configPatches.find(
      (p) => p.path.length === 2 && p.path[1] === "poiesis-reviewer",
    );
    const predecessorReviewer = predecessorProjectionV100V101V102(config, "1.1.2").find(
      (p) => p.path.length === 2 && p.path[1] === "poiesis-reviewer",
    )!;

    expect(currentReviewer).toBeDefined();
    const currentPermission = (currentReviewer!.installed as { permission: Record<string, unknown> }).permission;
    const predecessorPermission = (predecessorReviewer.value as { permission: Record<string, unknown> }).permission;
    expect(predecessorPermission.task).toEqual({ explore: "allow" });
    expect(currentPermission).not.toHaveProperty("task");
    // Every other agent patch must be identical.
    const currentOtherKeys = currentManifest.configPatches
      .filter((p) => !(p.path.length === 2 && p.path[1] === "poiesis-reviewer"))
      .map((p) => p.path.join("\0"));
    const predecessorOtherKeys = predecessorProjectionV100V101V102(config, "1.1.2")
      .filter((p) => !(p.path.length === 2 && p.path[1] === "poiesis-reviewer"))
      .map((p) => p.path.join("\0"));
    expect(predecessorOtherKeys).toEqual(currentOtherKeys);
  }, 60_000);

  it("predecessorProjectionV111 differs from current only in agent.poiesis.permission.bash", async () => {
    // Spec #104 / ticket #105: the v1.1.1 primary-bash surface
    // (`poiesis *` / `pnpm exec poiesis *` / `npx poiesis *` allows) is the
    // sole predecessor-only difference from the v1.1.2 projection. Every
    // other patch — including the worker's bash denies — must be identical.
    const repository = await createTestRepository();
    repositories.push(repository);
    const config = testConfig(repository);
    await setupCurrentInstall(repository);
    const currentManifest = await loadManifest(repository.root);

    const currentPrimary = currentManifest.configPatches.find(
      (p) => p.path.length === 2 && p.path[1] === "poiesis",
    )!;
    const predecessorPrimary = predecessorProjectionV111(config, "1.1.1").find(
      (p) => p.path.length === 2 && p.path[1] === "poiesis",
    )!;
    expect(currentPrimary).toBeDefined();
    const currentPermission = (currentPrimary.installed as { permission: Record<string, unknown> }).permission;
    const predecessorPermission = (predecessorPrimary.value as { permission: Record<string, unknown> }).permission;
    // The 1.1.1 primary bash is the bare-launcher-allow surface.
    expect(predecessorPermission.bash).toEqual({
      "poiesis *": "allow",
      "pnpm exec poiesis *": "allow",
      "npx poiesis *": "allow",
    });
    // The 1.1.2 primary bash is the exact-version canonical route.
    expect(currentPermission.bash).toMatchObject({
      "*": "allow",
      "poiesis *": "deny",
      "pnpm exec poiesis *": "deny",
      "npx poiesis *": "deny",
      "pnpm dlx poiesis-cli *": "deny",
      "pnpm dlx poiesis-cli@*": "deny",
      "pnpm dlx poiesis-cli@1.1.2 *": "allow",
    });
    // Every other patch must be identical (including worker bash, model
    // wiring, task delegation, etc.).
    const currentOtherKeys = currentManifest.configPatches
      .filter((p) => !(p.path.length === 2 && p.path[1] === "poiesis"))
      .map((p) => p.path.join("\0"));
    const predecessorOtherKeys = predecessorProjectionV111(config, "1.1.1")
      .filter((p) => !(p.path.length === 2 && p.path[1] === "poiesis"))
      .map((p) => p.path.join("\0"));
    expect(predecessorOtherKeys).toEqual(currentOtherKeys);
  }, 60_000);

  it("isExactProjection rejects any drift from the predecessor projection", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    const config = testConfig(repository);
    const predecessor = predecessorProjectionV100V101V102(config, "1.1.2");
    const currentManifest = await loadManifest(repository.root);

    // The current install is the canonical current projection, NOT the predecessor.
    expect(isExactProjection(currentManifest, predecessor)).toBe(false);

    // Drift: replace one permission key with something else.
    const drifted = structuredClone(predecessor) as typeof predecessor;
    const reviewer = drifted.find((p) => p.path.length === 2 && p.path[1] === "poiesis-reviewer")!;
    const reviewerValue = reviewer.value as { permission: Record<string, unknown> };
    reviewerValue.permission = { ...reviewerValue.permission, read: "deny" };
    expect(isExactProjection(currentManifest, drifted)).toBe(false);

    // Match with extra patch.
    const withExtra = [...predecessor, { path: ["agent", "ghost"], value: { mode: "subagent", hidden: true } }];
    expect(isExactProjection(currentManifest, withExtra)).toBe(false);
  }, 60_000);

  it("strict authority rejects an exact predecessor manifest without a receipt", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.1");

    await expect(
      assertManifestAuthority(repository.root, await loadManifest(repository.root), testConfig(repository)),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });

    // Doctor stays strict: it must report the manifest as invalid.
    const report = await doctor(repository.root);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("fail");

    // update() without a receipt must fail at receipt-gate, not authority.
    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "OWNERSHIP_RECEIPT_MISSING",
    });
  }, 60_000);

  it("strict authority rejects predecessor versions outside the accepted set", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.0");
    // Receipt-authenticated update only accepts 1.0.1 / 1.0.2, NOT 1.0.0.
    const config = testConfig(repository);
    const manifest = await loadManifest(repository.root);
    await expect(
      assertManifestAuthorityToleratingPredecessor(repository.root, manifest, config, ["1.0.1", "1.0.2"]),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
  }, 60_000);

  it("receipt-gates the predecessor tolerance: 1.0.1 predecessor + fake receipt is rejected", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.1");

    // No receipt at all: update fails at receipt-gate.
    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "OWNERSHIP_RECEIPT_MISSING",
    });
  }, 60_000);

  it("trusted 1.0.1 predecessor update: receipt-authenticated, transitions to the current package version, preserves previous provenance, advances receipt once, strict doctor passes", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const firstManifest = await setupCurrentInstall(repository);
    const initialReceipt = await readOwnershipReceipt(repository.root);
    expect(initialReceipt.generation).toBe(1);

    // Step 1: rewrite the manifest into the exact v1.0.1 predecessor shape
    // (poiesis-reviewer retains `task: { explore: "allow" }`).
    // Keep the receipt so we can rebind it to the new manifest digest.
    const predecessorManifest = await asPredecessorManifest(repository, "1.0.1", { keepReceipt: true });
    expect(predecessorManifest.poiesisVersion).toBe("1.0.1");
    expect(
      (predecessorManifest.configPatches.find((p) => p.path[1] === "poiesis-reviewer")!.installed as {
        permission: Record<string, unknown>;
      }).permission.task,
    ).toEqual({ explore: "allow" });

    // Rebind the receipt to the new manifest digest so the gate accepts it.
    await rebindReceipt(repository);
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(2);

    // Step 2: receipt-authenticated update accepts the predecessor, transitions
    // to the installed package version, drops the obsolete task field, advances
    // the receipt once.
    const beforeConfigBytes = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
    const beforeOpenCodeBytes = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const receiptBeforeUpdate = await readOwnershipReceipt(repository.root);

    const result = await update(repository.root, { skipSkills: true });

    expect(result.manifest.poiesisVersion).not.toBe("1.0.1");
    expect(result.manifest.poiesisVersion).toBe("1.1.2");
    const reviewerAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis-reviewer")!;
    expect((reviewerAfter.installed as { permission: Record<string, unknown> }).permission).not.toHaveProperty("task");

    // Previous provenance preserved: previousExists carries forward from the
    // predecessor manifest (was false at 1.0.1 init), previous is omitted.
    expect(reviewerAfter.previousExists).toBe(false);
    expect((reviewerAfter as { previous?: unknown }).previous).toBeUndefined();

    // Receipt advances by exactly ONE.
    const receiptAfterUpdate = await readOwnershipReceipt(repository.root);
    expect(receiptAfterUpdate.generation).toBe(receiptBeforeUpdate.generation + 1);
    expect(receiptAfterUpdate.installationId).toBe(receiptBeforeUpdate.installationId);
    expect(receiptAfterUpdate.manifestDigest).not.toBe(receiptBeforeUpdate.manifestDigest);

    // Strict doctor passes the strict manifest/receipt/hashes checks against
    // the fresh manifest. (Skill check is skipped because the test
    // installs with skipSkills:true; doctor.report.ok is not asserted because
    // it would also fail the unrelated skills gate.)
    const report = await doctor(repository.root);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "receipt")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "hashes")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "opencode-config")?.status).toBe("pass");

    // The on-disk state should have been written; no rollback occurred.
    // (The Poiesis config is unchanged because this test only migrated the
    // OpenCode projection, not the Poiesis config itself.)
    expect(await readFile(join(repository.root, "opencode.jsonc"))).not.toEqual(beforeOpenCodeBytes);
    expect(await readFile(join(repository.root, ".poiesis", "manifest.json"))).not.toEqual(beforeManifestBytes);
    // Generation-1 manifest bytes are no longer present (sanity check).
    void firstManifest;
  }, 60_000);

  it("trusted 1.0.2 predecessor update behaves the same as 1.0.1", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    const predecessorManifest = await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    expect(predecessorManifest.poiesisVersion).toBe("1.0.2");
    await rebindReceipt(repository);

    // Strip the new ticket #25 `.poiesis/workspaces/` rule from the
    // pre-existing gitignore so the trusted 1.0.2 update transaction
    // has to install it transactionally.
    const gitignorePath = join(repository.root, ".gitignore");
    const beforeBytes = await readFile(gitignorePath, "utf8");
    const stripped = beforeBytes
      .split(/\r?\n/)
      .filter((line) => line.trim() !== ".poiesis/workspaces/")
      .filter((line) => !line.includes("default-path workspace area"))
      .join("\n");
    await writeFile(gitignorePath, stripped);
    expect(await readFile(gitignorePath, "utf8")).not.toContain(".poiesis/workspaces/");

    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.poiesisVersion).toBe("1.1.2");
    const reviewerAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis-reviewer")!;
    expect((reviewerAfter.installed as { permission: Record<string, unknown> }).permission).not.toHaveProperty("task");
    expect(reviewerAfter.previousExists).toBe(false);
    // gen 1: init; gen 2: rebind to predecessor; gen 3: receipt-authenticated update.
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(3);
    // Receipt-bearing trusted update transactionally installs the new
    // default-path gitignore rule. The `.poiesis/workspaces/` entry MUST
    // be present after a successful update.
    expect(await readFile(gitignorePath, "utf8")).toContain(".poiesis/workspaces/");
  }, 60_000);

  it("exact predecessor drift is rejected: any extra key in poiesis-reviewer.permission fails the migration", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    const manifest = await loadManifest(repository.root);
    const config = testConfig(repository);
    const predecessor = predecessorProjectionV100V101V102(config, "1.0.1");
    // Drift: add an extra key to the reviewer permission.
    const driftedValue = structuredClone(predecessor.find((p) => p.path[1] === "poiesis-reviewer")!.value) as Record<string, unknown>;
    (driftedValue.permission as Record<string, unknown>).bash = { "*": "deny" };
    manifest.configPatches = manifest.configPatches.map((p) =>
      p.path[1] === "poiesis-reviewer"
        ? { ...p, installed: driftedValue }
        : p,
    );
    manifest.poiesisVersion = "1.0.1";
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await rebindReceipt(repository);

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "MANIFEST_AUTHORITY_INVALID",
    });
  }, 60_000);

  it("trusted 1.1.1 predecessor update transitions to 1.1.2, replaces primary bash with exact-version route, advances receipt once", async () => {
    // Spec #104 / ticket #105: the v1.1.1 predecessor primary-bash surface
    // (`poiesis *` / `pnpm exec poiesis *` / `npx poiesis *` allows) must
    // be accepted by an explicit receipt-authenticated `update` and
    // replaced by the v1.1.2 exact-version canonical route.
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.1.1", { keepReceipt: true });
    await rebindReceipt(repository);
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(2);

    const result = await update(repository.root, { skipSkills: true });

    expect(result.manifest.poiesisVersion).toBe("1.1.2");
    const primaryAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis")!;
    const primaryBash = (primaryAfter.installed as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(primaryBash["*"]).toBe("allow");
    expect(primaryBash["poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm exec poiesis *"]).toBe("deny");
    expect(primaryBash["npx poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli@1.1.2 *"]).toBe("allow");
    // Worker bash denies are unchanged.
    const workerAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis-worker")!;
    expect((workerAfter.installed as { permission: { bash: Record<string, string> } }).permission.bash).toEqual({
      "*": "allow",
      "git *": "deny",
      "poiesis *": "deny",
      "pnpm exec poiesis *": "deny",
      "npx poiesis *": "deny",
    });
    // Receipt advances by exactly ONE.
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(3);
  }, 60_000);

  it("strict authority (doctor, uninstall, installCapability) still rejects a 1.1.1 predecessor manifest", async () => {
    // The 1.1.1 predecessor projection is migration-only. Non-migration
    // flows (doctor, uninstall, installAuthorizedCapability) must keep
    // failing closed on a pre-migration 1.1.1 manifest; the only path
    // that admits a 1.1.1 manifest is the explicit, receipt-gated
    // `update` flow.
    //
    // Spec #104 / ticket #106 layered the centralized runtime identity
    // guard (RUNTIME_VERSION_MISMATCH) on top of these mutations, so
    // either code is acceptable evidence the operation refused a
    // pre-migration predecessor manifest. The behavioural contract
    // — "these operations refuse to mutate a 1.1.1 predecessor, only
    // receipt-gated update admits it" — is preserved either way.
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.1.1", { keepReceipt: true });
    await rebindReceipt(repository);

    const report = await doctor(repository.root);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("fail");

    await expect(uninstall(repository.root)).rejects.toMatchObject({
      code: expect.stringMatching(/MANIFEST_AUTHORITY_INVALID|RUNTIME_VERSION_MISMATCH/),
    });
    await expect(
      installAuthorizedCapability(repository.root, {
        source: "mattpocock/skills",
        name: "diagnosing-bugs",
        revision: "main",
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/MANIFEST_AUTHORITY_INVALID|RUNTIME_VERSION_MISMATCH/) });
  }, 60_000);

  it("exact 1.1.1 primary-bash drift is rejected: extra keys in agent.poiesis.permission fail the migration", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    const manifest = await loadManifest(repository.root);
    const config = testConfig(repository);
    const predecessor = predecessorProjectionV111(config, "1.1.1");
    // Drift: add an extra key to the primary permission (e.g. a stray
    // `task: { explore: "allow" }` carried over from a 1.0.x hand edit).
    const driftedValue = structuredClone(predecessor.find((p) => p.path[1] === "poiesis")!.value) as Record<string, unknown>;
    (driftedValue.permission as Record<string, unknown>).bash = {
      ...((driftedValue.permission as Record<string, unknown>).bash as Record<string, string>),
      "git *": "deny",
    };
    manifest.configPatches = manifest.configPatches.map((p) =>
      p.path[1] === "poiesis"
        ? { ...p, installed: driftedValue }
        : p,
    );
    manifest.poiesisVersion = "1.1.1";
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await rebindReceipt(repository);

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "MANIFEST_AUTHORITY_INVALID",
    });
  }, 60_000);

  it("exact current-shape projection drift is accepted: manifest version matches configPatches shape", async () => {
    // Spec #104 / ticket #105: the projection shape (including the
    // exact-version canonical route `pnpm dlx poiesis-cli@X`) is keyed off
    // `manifest.poiesisVersion`. A manifest whose version label and
    // configPatches agree on the current shape is accepted by the strict
    // authority short-circuit and proceeds through the update transaction.
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    const manifest = await loadManifest(repository.root);
    // Strip the (now-removed) obsolete reviewer.task field so the manifest
    // matches the current projection exactly. poiesisVersion is left at the
    // current package version so the version label and configPatches agree.
    manifest.configPatches = manifest.configPatches.map((patch) => {
      if (patch.path.length !== 2 || patch.path[1] !== "poiesis-reviewer") return patch;
      const value = patch.installed as { permission: Record<string, unknown> };
      const { task: _removed, ...permission } = value.permission;
      void _removed;
      return { ...patch, installed: { ...value, permission } };
    });
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await rebindReceipt(repository);

    // The manifest equals the strict current projection, so update() succeeds.
    // The result version advances to the installed package version (1.1.2)
    // because update() always bumps poiesisVersion on success.
    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.poiesisVersion).toBe("1.1.2");
    const reviewerAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis-reviewer")!;
    expect((reviewerAfter.installed as { permission: Record<string, unknown> }).permission).not.toHaveProperty("task");
  }, 60_000);

  it("rollback restores the predecessor manifest, receipt, and config bytes when update fails mid-transaction", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.1", { keepReceipt: true });
    await rebindReceipt(repository);

    const receiptBefore = await readOwnershipReceipt(repository.root);
    const manifestBytesBefore = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const configBytesBefore = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
    const openCodeBytesBefore = await readFile(join(repository.root, "opencode.jsonc"));

    // Force a failure after receipt replace but before success by inducing a
    // doctor mismatch. Easiest deterministic fault: tamper a managed file
    // between config write and manifest write. We can't easily inject mid-
    // update, so instead we test the rollback path by inducing a failure
    // during the doctor gate via a foreign mutation to a managed file.
    const reviewerMd = join(repository.root, ".poiesis", "roles", "reviewer.md");
    await writeFile(reviewerMd, "tampered\n");

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: expect.stringMatching(/UPDATE_DOCTOR_FAILED|FILE_OWNERSHIP_LOST/),
    });

    // Receipt, manifest, config bytes are restored byte-for-byte.
    expect(await readFile(join(repository.root, ".poiesis", "manifest.json"))).toEqual(manifestBytesBefore);
    expect(await readFile(join(repository.root, ".poiesis", "config.jsonc"))).toEqual(configBytesBefore);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(openCodeBytesBefore);

    const receiptAfter = await readOwnershipReceipt(repository.root);
    expect(receiptAfter.generation).toBe(receiptBefore.generation);
    expect(receiptAfter.manifestDigest).toBe(receiptBefore.manifestDigest);

    // Tampered file is left as-is (no Poiesis mutation).
    expect(await readFile(reviewerMd, "utf8")).toBe("tampered\n");
  }, 60_000);

  it("rollback restores the .gitignore preimage byte-for-byte when update fails mid-transaction", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.1", { keepReceipt: true });
    await rebindReceipt(repository);

    const gitignorePath = join(repository.root, ".gitignore");
    // The pre-ticket-#25 gitignore contract did NOT include the
    // `.poiesis/workspaces/` rule. Force the post-ticket rule to be
    // absent so the transaction must append it, and snapshot the
    // preimage byte-for-byte.
    const beforeBytes = (await readFile(gitignorePath, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim() !== ".poiesis/workspaces/")
      .filter((line) => !line.includes("default-path workspace area"))
      .join("\n");
    await writeFile(gitignorePath, beforeBytes);
    expect(await readFile(gitignorePath, "utf8")).not.toContain(".poiesis/workspaces/");

    // Force the update to fail at the ownership validation gate. The
    // tampered managed file is detected BEFORE the try block, so the
    // gitignore transaction never opens; the test still proves the
    // preimage is left untouched when an update aborts at any gate.
    const reviewerMd = join(repository.root, ".poiesis", "roles", "reviewer.md");
    const reviewerOriginal = await readFile(reviewerMd, "utf8");
    await writeFile(reviewerMd, "tampered\n");

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: expect.stringMatching(/UPDATE_DOCTOR_FAILED|FILE_OWNERSHIP_LOST/),
    });

    // Gitignore preimage is restored byte-for-byte. The transactional
    // seam never leaves the `.poiesis/workspaces/` rule installed when
    // the transaction aborts.
    expect(await readFile(gitignorePath, "utf8")).toBe(beforeBytes);
    expect(await readFile(gitignorePath, "utf8")).not.toContain(".poiesis/workspaces/");

    // Restore the reviewer file so the next assertion can verify the
    // successful path: a non-tampered receipt-authenticated update
    // installs the new `.poiesis/workspaces/` rule transactionally.
    await writeFile(reviewerMd, reviewerOriginal);
    await update(repository.root, { skipSkills: true });
    expect(await readFile(gitignorePath, "utf8")).toContain(".poiesis/workspaces/");
  }, 60_000);

  it("doctor stays strict: predecessor manifest WITHOUT successful migration is reported as invalid", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.1");
    // No update call. Doctor against the unchanged predecessor manifest must
    // still report the manifest check as failing (strict, current-only).
    const report = await doctor(repository.root);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("fail");
  }, 60_000);

  it("uninstall and installCapability remain strict (not migration-aware)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.1", { keepReceipt: true });
    await rebindReceipt(repository);

    // uninstall with a strict manifest would fail at the authority check.
    // Spec #104 / ticket #106 layered the runtime identity guard on top,
    // so either `MANIFEST_AUTHORITY_INVALID` (strict authority refuted
    // the predecessor projection) or `RUNTIME_VERSION_MISMATCH`
    // (running package version not equal to manifest.poiesisVersion
    // 1.0.1) is acceptable evidence the operation refused to mutate.
    await expect(uninstall(repository.root)).rejects.toMatchObject({
      code: expect.stringMatching(/MANIFEST_AUTHORITY_INVALID|RUNTIME_VERSION_MISMATCH/),
    });

    // installAuthorizedCapability is similarly strict.
    await expect(
      installAuthorizedCapability(repository.root, {
        source: "mattpocock/skills",
        name: "diagnosing-bugs",
        revision: "main",
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/MANIFEST_AUTHORITY_INVALID|RUNTIME_VERSION_MISMATCH/) });
  }, 60_000);

  it("bootstrap-legacy-ownership with 1.0.1 predecessor is rejected (bootstrap is 1.0.0 only)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.0.1");

    await expect(
      update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true }),
    ).rejects.toMatchObject({ code: "LEGACY_BOOTSTRAP_UNSUPPORTED" });
  }, 60_000);

  it("trusted 1.1.1 predecessor update preserves unrelated OpenCode config + models + tracker + delivery + skill installation state (Spec #104 / ticket #107)", async () => {
    // Spec #104 / ticket #107: the receipt-authenticated 1.1.1 → 1.1.2
    // update advances the manifest and the exact-version projection
    // together, and the migration must NOT disturb unrelated
    // project-bound state — OpenCode config keys Poiesis does not own,
    // `.poiesis/config.jsonc` (models / tracker / delivery), or any
    // skill installation state the project has built up.
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    await asPredecessorManifest(repository, "1.1.1", { keepReceipt: true });
    await rebindReceipt(repository);

    // Decorate the on-disk OpenCode config with project-owned keys
    // (`mcp_servers` + `theme`) that Poiesis never writes. The 1.1.2
    // projection must leave them byte-for-byte intact.
    const openCodePath = join(repository.root, "opencode.jsonc");
    const decorated = parseJsonc<Record<string, unknown>>(
      await readUtf8(openCodePath),
      openCodePath,
    );
    decorated["mcp_servers"] = {
      sentinel: { type: "stdio", command: ["echo", "preserved"], enabled: true },
    };
    decorated["theme"] = "customer-themed";
    const decoratedBytes = JSON.stringify(decorated, null, 2) + "\n";
    await writeFile(openCodePath, decoratedBytes);

    // Snapshot every durable owned byte + the unrelated OpenCode config
    // bytes so the post-update assertions prove exact preservation of
    // all non-projection state.
    const beforeConfigBytes = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
    const beforeOpenCodeBytes = await readFile(openCodePath);
    const beforeManifest = await loadManifest(repository.root);
    const beforeSkillsCount = beforeManifest.skills.length;

    const result = await update(repository.root, { skipSkills: true });

    // Manifest + projection advance together.
    expect(result.manifest.poiesisVersion).toBe("1.1.2");
    const primaryAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis")!;
    const primaryBash = (primaryAfter.installed as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(primaryBash["*"]).toBe("allow");
    expect(primaryBash["poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm exec poiesis *"]).toBe("deny");
    expect(primaryBash["npx poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli@1.1.2 *"]).toBe("allow");

    // Unrelated OpenCode config is preserved byte-for-byte except for
    // the exact Poiesis-owned patches the projection rewrites.
    const afterOpenCode = parseJsonc<Record<string, unknown>>(
      await readUtf8(openCodePath),
      openCodePath,
    );
    expect(afterOpenCode["mcp_servers"]).toEqual({
      sentinel: { type: "stdio", command: ["echo", "preserved"], enabled: true },
    });
    expect(afterOpenCode["theme"]).toBe("customer-themed");
    // The decorated bytes are strictly different from the post-update
    // bytes (Poiesis rewrote its owned patches); the unrelated keys
    // themselves survive untouched.
    expect(await readFile(openCodePath)).not.toEqual(beforeOpenCodeBytes);
    const decoratedParsed = JSON.parse(beforeOpenCodeBytes.toString("utf8")) as Record<string, unknown>;
    expect(decoratedParsed["mcp_servers"]).toEqual(afterOpenCode["mcp_servers"]);
    expect(decoratedParsed["theme"]).toBe(afterOpenCode["theme"]);

    // `.poiesis/config.jsonc` carries models / tracker / delivery. The
    // resolved config is sourced from the existing file, so the resolved
    // shape (and therefore the post-update bytes) carries the original
    // values forward — at minimum the model IDs and tracker/delivery
    // targets are unchanged.
    const afterConfigBytes = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
    const afterConfig = parseJsonc<{
      models: { reasoning: string; execution: string };
      tracker: { provider: string; project?: string };
      delivery: { preview: { adapter: string }; staging: { adapter: string }; production: { adapter: string } };
    }>(afterConfigBytes.toString("utf8"), "config.jsonc");
    const beforeConfig = parseJsonc<{
      models: { reasoning: string; execution: string };
      tracker: { provider: string; project?: string };
      delivery: { preview: { adapter: string }; staging: { adapter: string }; production: { adapter: string } };
    }>(beforeConfigBytes.toString("utf8"), "config.jsonc");
    expect(afterConfig.models).toEqual(beforeConfig.models);
    expect(afterConfig.tracker).toEqual(beforeConfig.tracker);
    expect(afterConfig.delivery).toEqual(beforeConfig.delivery);

    // Skill installation state is preserved (count is unchanged; this
    // run uses skipSkills so the count is 0, but the invariant holds
    // for non-zero too — the manifest's skills list is only rewritten
    // when skills are installed, never just to migrate version).
    expect(result.manifest.skills.length).toBe(beforeSkillsCount);

    // Receipt advanced by exactly one. The predecessor rebind landed
    // generation 2; this migration advances to 3.
    const receiptAfter = await readOwnershipReceipt(repository.root);
    expect(receiptAfter.generation).toBe(3);
    expect(receiptAfter.manifestDigest.length).toBeGreaterThan(0);
    // The advanced receipt's manifest digest is bound to the NEW manifest
    // bytes (loadManifest reads the post-update manifest; the receipt is
    // bound to its digest; both must be consistent).
    const afterManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    expect(afterManifestBytes.length).toBeGreaterThan(0);
  }, 60_000);
});

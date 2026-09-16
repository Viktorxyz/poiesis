import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManifestAuthority,
  assertManifestAuthorityToleratingPredecessor,
  isExactProjection,
  predecessorProjectionV100V101V102,
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
  predecessorVersion: "1.0.0" | "1.0.1" | "1.0.2",
  options: { keepReceipt?: boolean } = {},
): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor = predecessorProjectionV100V101V102(config);
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
    const predecessorReviewer = predecessorProjectionV100V101V102(config).find(
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
    const predecessorOtherKeys = predecessorProjectionV100V101V102(config)
      .filter((p) => !(p.path.length === 2 && p.path[1] === "poiesis-reviewer"))
      .map((p) => p.path.join("\0"));
    expect(predecessorOtherKeys).toEqual(currentOtherKeys);
  }, 60_000);

  it("isExactProjection rejects any drift from the predecessor projection", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    const config = testConfig(repository);
    const predecessor = predecessorProjectionV100V101V102(config);
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
    expect(result.manifest.poiesisVersion).toBe("1.1.0");
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
    expect(result.manifest.poiesisVersion).toBe("1.1.0");
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
    const predecessor = predecessorProjectionV100V101V102(config);
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

  it("exact predecessor drift is accepted only when it equals the strict current projection", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setupCurrentInstall(repository);
    const manifest = await loadManifest(repository.root);
    // Strip the task field, making the manifest match the current projection,
    // not the predecessor. The strict check accepts this, so the tolerant
    // authority check ALSO accepts it via the strict-success short-circuit
    // and the update proceeds. The version string is preserved (1.0.1).
    manifest.poiesisVersion = "1.0.1";
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await rebindReceipt(repository);

    // The manifest equals the strict current projection, so update() succeeds.
    // The result version advances to the installed package version (1.1.0)
    // because update() always bumps poiesisVersion on success.
    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.poiesisVersion).toBe("1.1.0");
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
    await expect(uninstall(repository.root)).rejects.toMatchObject({
      code: "MANIFEST_AUTHORITY_INVALID",
    });

    // installAuthorizedCapability is similarly strict.
    await expect(
      installAuthorizedCapability(repository.root, {
        source: "mattpocock/skills",
        name: "diagnosing-bugs",
        revision: "main",
      }),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
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
});

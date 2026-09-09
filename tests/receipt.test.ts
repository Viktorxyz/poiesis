import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, init, uninstall, update } from "../src/maintenance.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import { ownershipReceiptLocation, readOwnershipReceipt, removeOwnershipReceipt } from "../src/receipt.js";
import { exists } from "../src/fs.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

describe("ownership receipts", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  async function install(repository: TestRepository) {
    return init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
  }

  it("creates a receipt on init and keeps it through update and complete uninstall", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const created = await readOwnershipReceipt(repository.root);
    expect(created.generation).toBe(1);
    expect(await doctor(repository.root).then((report) => report.checks.find((check) => check.id === "receipt")?.status)).toBe("pass");

    await update(repository.root, { skipSkills: true });
    const updated = await readOwnershipReceipt(repository.root);
    expect(updated.installationId).toBe(created.installationId);
    expect(updated.generation).toBe(2);

    await removeOwnershipReceipt(repository.root);
    expect(await exists(await ownershipReceiptLocation(repository.root))).toBe(false);
  }, 30_000);

  it("retains a bound receipt after partial uninstall", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await writeFile(join(repository.root, ".poiesis", "foreign.txt"), "keep\n");
    const before = await readOwnershipReceipt(repository.root);
    const result = await uninstall(repository.root);
    expect(result.complete).toBe(false);
    const after = await readOwnershipReceipt(repository.root);
    expect(after.installationId).toBe(before.installationId);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.manifestDigest).not.toBe(before.manifestDigest);
  }, 30_000);

  it("rejects a missing receipt before update mutation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const role = join(repository.root, ".poiesis", "roles", "worker.md");
    const original = await readFile(role, "utf8");
    await rm(await ownershipReceiptLocation(repository.root));
    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_MISSING" });
    expect(await readFile(role, "utf8")).toBe(original);
  }, 30_000);

  it("rejects a copied or stale receipt before mutation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const path = await ownershipReceiptLocation(repository.root);
    const originalReceipt = await readFile(path, "utf8");
    const role = join(repository.root, ".poiesis", "roles", "worker.md");
    const originalRole = await readFile(role, "utf8");

    const parsed = JSON.parse(originalReceipt);
    parsed.commonDir = "/tmp/not-this-repository";
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_MISMATCH" });

    await writeFile(path, originalReceipt);
    const manifest = await loadManifest(repository.root);
    manifest.files[0]!.hash = "a".repeat(64);
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await expect(uninstall(repository.root)).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_MISMATCH" });
    expect(await readFile(role, "utf8")).toBe(originalRole);
  }, 30_000);
});

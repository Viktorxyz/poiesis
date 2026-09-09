import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, init, uninstall, update } from "../src/maintenance.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import { ownershipReceiptExists, readOwnershipReceipt, removeOwnershipReceipt } from "../src/receipt.js";
import { run } from "../src/process.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

async function asLegacy1000(root: string): Promise<void> {
  const manifest = await loadManifest(root);
  manifest.poiesisVersion = "1.0.0";
  await writeFile(join(root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  if (await ownershipReceiptExists(root)) await removeOwnershipReceipt(root);
}

describe("legacy 1.0.0 ownership bootstrap", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("refuses ordinary update, then bootstraps an explicit 1.0.0 install", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    await asLegacy1000(repository.root);

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_MISSING" });
    expect(await ownershipReceiptExists(repository.root)).toBe(false);

    const result = await update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true });
    expect(result.manifest.poiesisVersion).not.toBe("1.0.0");
    const receipt = await readOwnershipReceipt(repository.root);
    expect(receipt.generation).toBe(1);
    expect(await doctor(repository.root).then((report) => report.checks.find((check) => check.id === "receipt")?.status)).toBe("pass");

    await update(repository.root, { skipSkills: true });
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(2);
    const removed = await uninstall(repository.root);
    expect(removed.complete).toBe(true);
  }, 60_000);

  it("bootstraps a real poiesis-cli@1.0.0 installation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const configPath = join(repository.parent, "legacy-config.jsonc");
    await writeFile(configPath, `${JSON.stringify(testConfig(repository), null, 2)}\n`);
    const installed = await run(
      "pnpm",
      ["dlx", "poiesis-cli@1.0.0", "init", "--config", configPath, "--allow-fixtures", "--cwd", repository.root],
      { cwd: repository.root, allowFailure: true },
    );
    expect(installed.exitCode, installed.stderr || installed.stdout).toBe(0);
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_MISSING" });
    const result = await update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true });
    expect(result.manifest.poiesisVersion).not.toBe("1.0.0");
    expect(await readOwnershipReceipt(repository.root).then((receipt) => receipt.generation)).toBe(1);
    expect(await doctor(repository.root).then((report) => report.checks.find((check) => check.id === "receipt")?.status)).toBe("pass");
  }, 180_000);

  it("rejects bootstrap when a receipt already exists or the install is not 1.0.0", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    await expect(update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true })).rejects.toMatchObject({
      code: "LEGACY_BOOTSTRAP_REJECTED",
    });
    await removeOwnershipReceipt(repository.root);
    await expect(update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true })).rejects.toMatchObject({
      code: "LEGACY_BOOTSTRAP_UNSUPPORTED",
    });
  }, 30_000);

  it("rejects a changed legacy file without mutating it", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    await asLegacy1000(repository.root);
    const role = join(repository.root, ".poiesis", "roles", "worker.md");
    const original = await readFile(role, "utf8");
    await writeFile(role, "tampered\n");
    await expect(update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true })).rejects.toMatchObject({
      code: "LEGACY_BOOTSTRAP_REJECTED",
    });
    expect(await readFile(role, "utf8")).toBe("tampered\n");
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
    expect(original).not.toBe("tampered\n");
  }, 30_000);

  it("rejects foreign path claims and extra owned skills before mutation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    await asLegacy1000(repository.root);
    const manifest = await loadManifest(repository.root);
    manifest.files.push({ path: "README.md", kind: "canonical", hash: "a".repeat(64), owned: true, durable: true });
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await expect(update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true })).rejects.toMatchObject({
      code: "MANIFEST_AUTHORITY_INVALID",
    });
    expect(await ownershipReceiptExists(repository.root)).toBe(false);

    const clean = await loadManifest(repository.root);
    clean.files = clean.files.filter((file) => file.path !== "README.md");
    clean.poiesisVersion = "1.0.0";
    clean.skills.push({
      source: "evil/skills",
      name: "pwn",
      path: ".agents/skills/pwn",
      preexisting: false,
      installedRevision: "x",
      hash: "a".repeat(64),
    });
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(clean));
    await expect(update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true })).rejects.toMatchObject({
      code: "LEGACY_BOOTSTRAP_REJECTED",
    });
  }, 30_000);
});

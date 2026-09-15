import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, init, uninstall, update } from "../src/maintenance.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import { ownershipReceiptExists, readOwnershipReceipt, removeOwnershipReceipt } from "../src/receipt.js";
import { run } from "../src/process.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode } from "./fake-opencode.js";

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

    // Synthetic 1.0.0 legacy init wrote the pre-ticket #25 `.gitignore`
    // contract, which did NOT include `.poiesis/workspaces/`. Strip the
    // new rule so the bootstrap transaction has to install it.
    const gitignorePath = join(repository.root, ".gitignore");
    const beforeBytes = await readFile(gitignorePath);
    const stripped = beforeBytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== ".poiesis/workspaces/")
      .filter((line) => !line.includes("default-path workspace area"))
      .join("\n");
    await writeFile(gitignorePath, stripped);
    expect((await readFile(gitignorePath, "utf8"))).not.toContain(".poiesis/workspaces/");

    const result = await update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true });
    expect(result.manifest.poiesisVersion).not.toBe("1.0.0");
    const receipt = await readOwnershipReceipt(repository.root);
    expect(receipt.generation).toBe(1);
    expect(await doctor(repository.root).then((report) => report.checks.find((check) => check.id === "receipt")?.status)).toBe("pass");

    // After bootstrap, the transactional gitignore seam installed the
    // `.poiesis/workspaces/` rule so the default-path workspace area
    // never appears as foreign work in the primary checkout.
    const afterBootstrap = await readFile(gitignorePath, "utf8");
    expect(afterBootstrap).toContain(".poiesis/workspaces/");

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
    // The legacy poiesis-cli@1.0.0 init bundles SUPPORTED_OPENCODE_VERSION = "1.18.29"
    // and fails closed against any other version. To exercise the real
    // published legacy package on a host whose OpenCode is a later
    // adapter-version-1 tag (e.g. 1.18.30), inject a fixture-local fake
    // OpenCode that advertises 1.18.29 onto PATH for the duration of the
    // legacy init. After the legacy init returns we restore PATH so the
    // current compatible runtime that follows (update and doctor) runs
    // against the real host OpenCode.
    const fakeEnv = await installFakeOpenCode("1.18.29");
    let installed;
    try {
      installed = await run(
        "pnpm",
        ["dlx", "poiesis-cli@1.0.0", "init", "--config", configPath, "--allow-fixtures", "--cwd", repository.root],
        { cwd: repository.root, allowFailure: true },
      );
    } finally {
      fakeEnv.restore();
    }
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

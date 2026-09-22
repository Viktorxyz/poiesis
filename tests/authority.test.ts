import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertManifestAuthority } from "../src/authority.js";
import { CERTIFIED_OPENCODE_VERSIONS } from "../src/opencode.js";
import { doctor, init, uninstall, update } from "../src/maintenance.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { atomicWrite, exists } from "../src/fs.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

async function installed(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
}

async function rewrite(repository: TestRepository, mutate: (manifest: Manifest) => void): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  mutate(manifest);
  await atomicWrite(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  return manifest;
}

describe("manifest authority", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("accepts an adapter-generated manifest", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installed(repository);
    const report = await doctor(repository.root);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("pass");
  }, 60_000);

  it.each([
    [
      "README claim",
      (manifest: Manifest) => {
        manifest.files.push({
          path: "README.md",
          kind: "canonical",
          hash: "a".repeat(64),
          owned: true,
          durable: true,
        });
      },
    ],
    [
      ".git claim",
      (manifest: Manifest) => {
        manifest.files.push({ path: ".git/HEAD", kind: "generated", hash: "a".repeat(64), owned: true });
      },
    ],
    [
      "package.json patch",
      (manifest: Manifest) => {
        manifest.configPatches.push({
          file: "package.json",
          path: ["scripts", "test"],
          previousExists: false,
          installed: "true",
        });
      },
    ],
    [
      "wrong OpenCode filename",
      (manifest: Manifest) => {
        for (const patch of manifest.configPatches) patch.file = "opencode.config.json";
      },
    ],
    [
      "extra patch",
      (manifest: Manifest) => {
        manifest.configPatches.push({
          file: manifest.configPatches[0]!.file,
          path: ["theme"],
          previousExists: false,
          installed: "system",
        });
      },
    ],
    [
      "extra skill",
      (manifest: Manifest) => {
        manifest.skills.push({
          source: "evil/skills",
          name: "pwn",
          path: ".git",
          preexisting: false,
          installedRevision: "x",
          hash: "a".repeat(64),
        });
      },
    ],
    [
      "invalid durable metadata",
      (manifest: Manifest) => {
        const config = manifest.files.find((file) => file.path === ".poiesis/config.jsonc");
        if (config !== undefined) config.durable = true;
      },
    ],
    [
      "invalid kind metadata",
      (manifest: Manifest) => {
        const role = manifest.files.find((file) => file.path === ".poiesis/roles/worker.md");
        if (role !== undefined) role.kind = "generated";
      },
    ],
    [
      "unsupported adapter version",
      (manifest: Manifest) => {
        manifest.adapter.adapterVersion = "0";
      },
    ],
  ])("rejects %s before side effects", async (_name, mutate) => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installed(repository);
    const original = await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8");
    await rewrite(repository, mutate);

    const report = await doctor(repository.root);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("fail");
    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: expect.stringMatching(/MANIFEST_AUTHORITY_INVALID|MANIFEST_MIGRATION_REQUIRED|OWNERSHIP_RECEIPT_MISMATCH/),
    });
    await expect(uninstall(repository.root)).rejects.toMatchObject({
      code: expect.stringMatching(/MANIFEST_AUTHORITY_INVALID|MANIFEST_MIGRATION_REQUIRED/),
    });
    expect(await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8")).toBe(original);
    expect(await exists(join(repository.root, ".poiesis", "manifest.json"))).toBe(true);
  }, 90_000);
});


describe("manifest authority adapter contract (ticket #33)", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("rejects explicit supportedVersions that is empty", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installed(repository);
    const manifest = await loadManifest(repository.root);
    manifest.adapter.supportedVersions = [];
    await expect(
      assertManifestAuthority(repository.root, manifest, testConfig(repository)),
    ).rejects.toMatchObject({ code: "MANIFEST_MIGRATION_REQUIRED" });
  }, 30_000);

  it("rejects supportedVersion that is not included in supportedVersions (contradictory)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installed(repository);
    const manifest = await loadManifest(repository.root);
    // Initial supportedVersion is the first entry of CERTIFIED_OPENCODE_VERSIONS.
    const supportedVersion = manifest.adapter.supportedVersion;
    const otherSupported = CERTIFIED_OPENCODE_VERSIONS.find((v) => v !== supportedVersion);
    expect(otherSupported).toBeDefined();
    manifest.adapter.supportedVersions = [otherSupported!];
    await expect(
      assertManifestAuthority(repository.root, manifest, testConfig(repository)),
    ).rejects.toMatchObject({ code: "MANIFEST_MIGRATION_REQUIRED" });
  }, 30_000);

  it("rejects supportedVersions containing a version not in the supported set (unsupported)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installed(repository);
    const manifest = await loadManifest(repository.root);
    manifest.adapter.supportedVersion = CERTIFIED_OPENCODE_VERSIONS[0]!;
    manifest.adapter.supportedVersions = [...CERTIFIED_OPENCODE_VERSIONS, "9.9.9-not-supported"];
    await expect(
      assertManifestAuthority(repository.root, manifest, testConfig(repository)),
    ).rejects.toMatchObject({ code: "MANIFEST_MIGRATION_REQUIRED" });
  }, 30_000);

  it("accepts a legacy manifest (no supportedVersions) when supportedVersion is valid", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installed(repository);
    const manifest = await loadManifest(repository.root);
    // Strip supportedVersions entirely (legacy shape).
    delete manifest.adapter.supportedVersions;
    expect(manifest.adapter.supportedVersions).toBeUndefined();
    expect(CERTIFIED_OPENCODE_VERSIONS).toContain(manifest.adapter.supportedVersion);
    await expect(
      assertManifestAuthority(repository.root, manifest, testConfig(repository)),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("accepts a current manifest when supportedVersion is included in supportedVersions and all are supported", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installed(repository);
    const manifest = await loadManifest(repository.root);
    manifest.adapter.supportedVersion = CERTIFIED_OPENCODE_VERSIONS[0]!;
    manifest.adapter.supportedVersions = [...CERTIFIED_OPENCODE_VERSIONS];
    await expect(
      assertManifestAuthority(repository.root, manifest, testConfig(repository)),
    ).resolves.toBeUndefined();
  }, 30_000);
});

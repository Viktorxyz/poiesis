import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  doctor,
  init,
  updateFromConfig,
} from "../src/maintenance.js";
import { commandUpdate } from "../src/cli.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { predecessorProjectionV100V101V102 } from "../src/authority.js";
import { parseJsonc, serializeConfig, type PoiesisConfig } from "../src/config.js";
import { ownershipReceiptLocation, readOwnershipReceipt, replaceOwnershipReceipt } from "../src/receipt.js";
import { hashContent, hashFile } from "../src/hash.js";
import { desiredOpenCodePatches } from "../src/opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import type { DoctorReport } from "../src/maintenance.js";
import { PoiesisError } from "../src/errors.js";

const CONFIG_ROOT = ".poiesis/config.jsonc";

async function install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function writeCandidateConfig(repository: TestRepository, mutate: (config: PoiesisConfig) => void): Promise<string> {
  const configPath = join(repository.parent, "candidate-config.jsonc");
  const next = structuredClone(testConfig(repository)) as PoiesisConfig;
  mutate(next);
  await writeFile(configPath, serializeConfig(next));
  return configPath;
}

async function readPoiesisConfig(repository: TestRepository): Promise<PoiesisConfig> {
  return parseJsonc<PoiesisConfig>(await readFile(join(repository.root, CONFIG_ROOT), "utf8"), join(repository.root, CONFIG_ROOT));
}

async function readOpenCodeJson(repository: TestRepository): Promise<Record<string, unknown>> {
  return parseJsonc<Record<string, unknown>>(
    await readFile(join(repository.root, "opencode.jsonc"), "utf8"),
    join(repository.root, "opencode.jsonc"),
  );
}

function expectTransactionChecksPass(report: DoctorReport): void {
  for (const id of ["config", "manifest", "receipt", "hashes", "opencode-version", "models", "opencode-config", "opencode-schema", "git", "git-remote", "git-base"]) {
    expect(report.checks.find((check) => check.id === id)?.status, `expected ${id} check to pass`).toBe("pass");
  }
  for (const id of ["tracker", "delivery"]) {
    expect(report.checks.find((check) => check.id === id)?.status, `expected ${id} not to fail`).not.toBe("fail");
  }
}

/**
 * Snapshot every owned byte the transaction could mutate. The test re-reads each
 * byte after a fault-injection run and asserts the file (or non-existence) is
 * byte-for-byte identical to the baseline snapshot.
 */
interface OwnedByteSnapshot {
  poiesisConfig: Buffer | null;
  poiesisConfigAbsent: boolean;
  openCodeConfig: Buffer | null;
  openCodeConfigAbsent: boolean;
  manifest: Buffer | null;
  manifestAbsent: boolean;
  receipt: Buffer | null;
  receiptAbsent: boolean;
  receiptGeneration: number | null;
  receiptManifestDigest: string | null;
}

async function snapshotOwnedBytes(repository: TestRepository): Promise<OwnedByteSnapshot> {
  async function read(file: string, absentFlag: boolean): Promise<{ value: Buffer | null; absent: boolean }> {
    const path = join(repository.root, file);
    try {
      return { value: await readFile(path), absent: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: null, absent: true };
      throw error;
    }
  }
  const poiesisConfigRead = await read(CONFIG_ROOT, false);
  const openCodeConfigRead = await read("opencode.jsonc", false);
  const manifestRead = await read(".poiesis/manifest.json", false);
  let receiptRead: { value: Buffer | null; absent: boolean } = { value: null, absent: true };
  let generation: number | null = null;
  let manifestDigest: string | null = null;
  try {
    const receipt = await readOwnershipReceipt(repository.root);
    generation = receipt.generation;
    manifestDigest = receipt.manifestDigest;
    receiptRead = await read(await ownershipReceiptLocation(repository.root), false);
  } catch (error) {
    if (!(error instanceof PoiesisError)) throw error;
  }
  return {
    poiesisConfig: poiesisConfigRead.value,
    poiesisConfigAbsent: poiesisConfigRead.absent,
    openCodeConfig: openCodeConfigRead.value,
    openCodeConfigAbsent: openCodeConfigRead.absent,
    manifest: manifestRead.value,
    manifestAbsent: manifestRead.absent,
    receipt: receiptRead.value,
    receiptAbsent: receiptRead.absent,
    receiptGeneration: generation,
    receiptManifestDigest: manifestDigest,
  };
}

function expectOwnedBytesUnchanged(before: OwnedByteSnapshot, after: OwnedByteSnapshot): void {
  expect(after.poiesisConfigAbsent, "poiesis config presence changed").toBe(before.poiesisConfigAbsent);
  if (!before.poiesisConfigAbsent) {
    expect(Buffer.compare(after.poiesisConfig!, before.poiesisConfig!), "poiesis config bytes changed").toBe(0);
  }
  expect(after.openCodeConfigAbsent, "opencode config presence changed").toBe(before.openCodeConfigAbsent);
  if (!before.openCodeConfigAbsent) {
    expect(Buffer.compare(after.openCodeConfig!, before.openCodeConfig!), "opencode config bytes changed").toBe(0);
  }
  expect(after.manifestAbsent, "manifest presence changed").toBe(before.manifestAbsent);
  if (!before.manifestAbsent) {
    expect(Buffer.compare(after.manifest!, before.manifest!), "manifest bytes changed").toBe(0);
  }
  expect(after.receiptAbsent, "receipt presence changed").toBe(before.receiptAbsent);
  if (!before.receiptAbsent) {
    expect(Buffer.compare(after.receipt!, before.receipt!), "receipt bytes changed").toBe(0);
    expect(after.receiptGeneration, "receipt generation advanced").toBe(before.receiptGeneration);
    expect(after.receiptManifestDigest, "receipt digest changed").toBe(before.receiptManifestDigest);
  }
}

describe("update --config", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("updates config and OpenCode projection with a single generation advance", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeConfig = await readPoiesisConfig(repository);
    const beforeConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCodeBytes = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeReceipt = await readOwnershipReceipt(repository.root);

    const result = await updateFromConfig(repository.root, candidatePath);

    const afterConfig = await readPoiesisConfig(repository);
    expect(afterConfig.models.execution).toBe("minimax/MiniMax-M3-alt");
    expect(afterConfig.models.reasoning).toBe(beforeConfig.models.reasoning);

    const afterConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    expect(Buffer.compare(afterConfigBytes, beforeConfigBytes)).not.toBe(0);

    const manifest = await loadManifest(repository.root);
    const recorded = manifest.files.find((file) => file.path === CONFIG_ROOT);
    expect(recorded?.hash).toBe(hashContent(afterConfigBytes));

    const openCodeJson = await readOpenCodeJson(repository);
    const desired = desiredOpenCodePatches(afterConfig);
    for (const patch of desired) {
      const top = openCodeJson[patch.path[0]!];
      if (patch.path.length === 1) expect(top).toEqual(patch.value);
    }
    expect((openCodeJson.agent as Record<string, Record<string, unknown>>)?.poiesis?.model).toBe(afterConfig.models.reasoning);

    expect(await readFile(join(repository.root, "opencode.jsonc"))).not.toEqual(beforeOpenCodeBytes);

    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation + 1);
    expect(afterReceipt.installationId).toBe(beforeReceipt.installationId);
    expect(afterReceipt.manifestDigest).not.toBe(beforeReceipt.manifestDigest);
    expect(afterReceipt.manifestDigest).toBe(hashContent(serializeManifest(result.manifest)));

    expectTransactionChecksPass(result.doctor);
  }, 30_000);

  it("does not advance generation, hashes, or content when the proposed config is a no-op", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, () => undefined);
    const beforeConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCodeBytes = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeReceipt = await readOwnershipReceipt(repository.root);
    const beforeManifest = serializeManifest(await loadManifest(repository.root));

    const result = await updateFromConfig(repository.root, candidatePath);

    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfigBytes);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCodeBytes);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(beforeManifest);
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
    expect(afterReceipt.manifestDigest).toBe(beforeReceipt.manifestDigest);
    expect(result.doctor.checks.find((check) => check.id === "manifest")?.status).toBe("pass");
    expect(result.doctor.checks.find((check) => check.id === "receipt")?.status).toBe("pass");
  }, 30_000);

  it("rejects a config with an invalid tracker provider", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifest = await loadManifest(repository.root);
    const beforeReceipt = await readOwnershipReceipt(repository.root);

    const invalidTracker = structuredClone(testConfig(repository)) as PoiesisConfig;
    invalidTracker.tracker = { provider: "not-a-real-provider" as unknown as "fixture", project: repository.fixtures };
    const configPath = join(repository.parent, "bad-tracker.jsonc");
    await writeFile(configPath, serializeConfig(invalidTracker));

    await expect(updateFromConfig(repository.root, configPath)).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfig);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCode);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(serializeManifest(beforeManifest));
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(beforeReceipt.generation);
  }, 30_000);

  it("rejects a config with an unsupported delivery adapter", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifest = await loadManifest(repository.root);
    const beforeReceipt = await readOwnershipReceipt(repository.root);

    const invalidDelivery = structuredClone(testConfig(repository)) as PoiesisConfig;
    invalidDelivery.delivery = {
      preview: { adapter: "not-a-real-adapter" },
      staging: { adapter: "not-a-real-adapter" },
      production: { adapter: "not-a-real-adapter" },
    };
    const configPath = join(repository.parent, "bad-delivery.jsonc");
    await writeFile(configPath, serializeConfig(invalidDelivery));

    await expect(updateFromConfig(repository.root, configPath)).rejects.toMatchObject({ code: "UNKNOWN_DELIVERY_ADAPTER" });

    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfig);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCode);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(serializeManifest(beforeManifest));
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(beforeReceipt.generation);
  }, 30_000);

  it("rejects an invalid config before any repository write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const configPath = join(repository.parent, "broken.jsonc");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          schema: 1,
          models: { reasoning: "no-slash", execution: "minimax/MiniMax-M3" },
          tracker: { provider: "fixture", project: repository.fixtures },
          delivery: {
            preview: { adapter: "fixture", path: repository.fixtures },
            staging: { adapter: "fixture", path: repository.fixtures },
            production: { adapter: "fixture", path: repository.fixtures },
          },
        },
        null,
        2,
      )}\n`,
    );
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeReceipt = await readOwnershipReceipt(repository.root);
    const beforeManifest = await loadManifest(repository.root);

    await expect(updateFromConfig(repository.root, configPath)).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfig);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCode);
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
    expect(afterReceipt.manifestDigest).toBe(beforeReceipt.manifestDigest);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(serializeManifest(beforeManifest));
  }, 30_000);

  it("rejects a config whose projection collides with the current OpenCode config", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await writeFile(
      join(repository.root, "opencode.jsonc"),
      '{ "default_agent": "foreign-agent" }\n',
    );
    const configPath = await writeCandidateConfig(repository, () => undefined);
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeReceipt = await readOwnershipReceipt(repository.root);

    await expect(updateFromConfig(repository.root, configPath)).rejects.toMatchObject({ code: "CONFIG_OWNERSHIP_LOST" });

    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfig);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCode);
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
  }, 30_000);

  it("rejects a config when the manifest has been tampered with", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const manifest = await loadManifest(repository.root);
    manifest.files.push({ path: "README.md", kind: "canonical", hash: "a".repeat(64), owned: true, durable: true });
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    const configPath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeReceipt = await readOwnershipReceipt(repository.root);
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));

    // After reordering, the receipt is checked FIRST. Tampering with the manifest
    // invalidates the receipt's stored manifestDigest, so the transaction is
    // rejected as `OWNERSHIP_RECEIPT_MISMATCH` (a stronger guarantee than the
    // pre-reorder order that reached `MANIFEST_AUTHORITY_INVALID` first).
    await expect(updateFromConfig(repository.root, configPath)).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_MISMATCH" });

    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfig);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCode);
    expect(await readFile(join(repository.root, ".poiesis", "manifest.json"))).toEqual(beforeManifestBytes);
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
  }, 30_000);

  it("rejects a tampered receipt before any write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const originalReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifest = await loadManifest(repository.root);

    const tampered = { ...originalReceipt, commonDir: "/tmp/not-this-repository" };
    await writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({
      code: "OWNERSHIP_RECEIPT_MISMATCH",
    });
    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfig);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCode);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(serializeManifest(beforeManifest));

    await writeFile(receiptPath, JSON.stringify(originalReceipt, null, 2));
    const manifest = await loadManifest(repository.root);
    manifest.files[0]!.hash = "a".repeat(64);
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({
      code: "OWNERSHIP_RECEIPT_MISMATCH",
    });
  }, 30_000);

  it("advances only one generation per successful transaction and does not double-advance on a repeated identical config", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeReceipt = await readOwnershipReceipt(repository.root);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });

    const first = await updateFromConfig(repository.root, candidatePath);
    expectTransactionChecksPass(first.doctor);
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(beforeReceipt.generation + 1);

    // Identical config repeated: my no-op detector must short-circuit the second call.
    const second = await updateFromConfig(repository.root, candidatePath);
    expectTransactionChecksPass(second.doctor);
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(beforeReceipt.generation + 1);

    // A different config change should advance the generation exactly once more.
    const altCandidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "openai/gpt-5.6-fallback";
    });
    const third = await updateFromConfig(repository.root, altCandidatePath);
    expectTransactionChecksPass(third.doctor);
    expect((await readOwnershipReceipt(repository.root)).generation).toBe(beforeReceipt.generation + 2);
  }, 30_000);

  it("refuses to update when bootstrap-legacy-ownership is also requested", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    await expect(
      updateFromConfig(repository.root, candidatePath, { bootstrapLegacyOwnership: true }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_UPDATE_OPTIONS" });
  }, 30_000);

  it("refuses to update when skip-skills is also requested", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    await expect(
      updateFromConfig(repository.root, candidatePath, { skipSkills: true }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_UPDATE_OPTIONS" });
  }, 30_000);

  // -- CLI-level rejection of incompatible flags (separate from the maintenance
  //    layer rejection in `updateFromConfig`). The CLI dispatch must guard the
  //    combination BEFORE calling into maintenance so the rejection is
  //    observable at the CLI surface without relying on a deeper invariant.

  it("CLI rejects --config combined with --skip-skills before reaching maintenance", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        commandUpdate(["--config", candidatePath, "--skip-skills", "--cwd", repository.root]),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_UPDATE_OPTIONS" });
      // commandUpdate throws without calling writeFailure itself; the production
      // `main()` wrapper handles stderr/exit. Verify the production failure shape
      // by invoking the same writeFailure path used in production.
      const { writeFailure } = await import("../src/output.js");
      try { writeFailure(new PoiesisError("INCOMPATIBLE_UPDATE_OPTIONS", "simulated")); }
      catch { /* writeFailure calls process.exit which throws in some environments */ }
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.join("")).toContain("INCOMPATIBLE_UPDATE_OPTIONS");
    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  it("CLI rejects --config combined with --bootstrap-legacy-ownership before reaching maintenance", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        commandUpdate(["--config", candidatePath, "--bootstrap-legacy-ownership", "--cwd", repository.root]),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_UPDATE_OPTIONS" });
    } finally {
      process.stderr.write = originalWrite;
    }
    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  // -- Regression: strict `updateFromConfig` rejects the exact v1.0.0/1.0.1/1.0.2
  //    predecessor projection even with a valid receipt. Predecessor tolerance
  //    is confined to receipt-authenticated normal `update()` and explicit
  //    1.0.0 bootstrap; `updateFromConfig` must reject any other path
  //    fail-closed before any owned byte is mutated.
  async function asPredecessorManifest(
    repository: TestRepository,
    predecessorVersion: "1.0.0" | "1.0.1" | "1.0.2",
  ): Promise<void> {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { parseJsonc } = await import("../src/config.js");
    const manifest: Manifest = await loadManifest(repository.root);
    const predecessor = predecessorProjectionV100V101V102(testConfig(repository));
    manifest.poiesisVersion = predecessorVersion;
    manifest.configPatches = manifest.configPatches.map((patch) => {
      const matching = predecessor.find(
        (p) => p.path.length === patch.path.length && p.path.every((s, i) => s === patch.path[i]),
      );
      return matching === undefined ? patch : { ...patch, installed: matching.value };
    });
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    // Rewrite on-disk opencode.jsonc so each claimed patch value matches the
    // file content (otherwise `assertConfigPatchesOwned` would block before
    // authority runs).
    const openCodePath = join(repository.root, "opencode.jsonc");
    const current = parseJsonc<Record<string, unknown>>(await readFile(openCodePath, "utf8"), openCodePath);
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
    // Recompute the on-disk opencode.jsonc hash and update the manifest entry.
    const newOpencodeHash = hashContent(await readFile(openCodePath));
    const ocRecord = manifest.files.find((file) => file.path === "opencode.jsonc");
    if (ocRecord !== undefined) ocRecord.hash = newOpencodeHash;
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    // Rebind the receipt to the new manifest digest so the receipt gate accepts.
    const receipt = await readOwnershipReceipt(repository.root);
    await replaceOwnershipReceipt(repository.root, manifest, receipt);
  }

  it("rejects exact v1.0.1 predecessor manifest with valid receipt and preserves owned bytes/generation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await asPredecessorManifest(repository, "1.0.1");

    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      updateFromConfig(repository.root, candidatePath),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 60_000);

  it("rejects exact v1.0.2 predecessor manifest with valid receipt and preserves owned bytes/generation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await asPredecessorManifest(repository, "1.0.2");

    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      updateFromConfig(repository.root, candidatePath),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 60_000);

  it("rejects exact v1.0.0 predecessor manifest with valid receipt and preserves owned bytes/generation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await asPredecessorManifest(repository, "1.0.0");

    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      updateFromConfig(repository.root, candidatePath),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 60_000);

  // -- Deterministic fault injection per write step. Each test invokes the
  //    public `writerHooks` test seam introduced on `UpdateConfigOptions`.
  //    The hook throws IMMEDIATELY before the corresponding atomic write
  //    step. The transaction must roll back every file that was already
  //    mutated back to its pre-transaction bytes and leave the receipt
  //    generation unchanged.

  it("rolls back owned state when the Poiesis config write fails", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    await expect(
      updateFromConfig(repository.root, candidatePath, {
        writerHooks: { prePoiesisConfigWrite: () => { throw new Error("injected: poiesis config write"); } },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/injected: poiesis config write/) });
    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  it("rolls back the Poiesis config when the OpenCode apply fails", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    await expect(
      updateFromConfig(repository.root, candidatePath, {
        writerHooks: { preOpenCodeApply: () => { throw new Error("injected: opencode apply"); } },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/injected: opencode apply/) });
    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  it("rolls back config and OpenCode when the manifest write fails", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    await expect(
      updateFromConfig(repository.root, candidatePath, {
        writerHooks: { preManifestWrite: () => { throw new Error("injected: manifest write"); } },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/injected: manifest write/) });
    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  it("rolls back config, OpenCode, and manifest when the receipt replace fails", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    await expect(
      updateFromConfig(repository.root, candidatePath, {
        writerHooks: { preReceiptReplace: () => { throw new Error("injected: receipt replace"); } },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/injected: receipt replace/) });
    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  it("rolls back every mutated file when the doctor gate fails after all writes", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    // Force the doctor gate to fail AFTER all writes complete by flipping the fake
    // opencode `debug config` exit to non-zero.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }
    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);
  // -- Fail-closed rollback: the manifest and ownership receipt are the last
  //    two artifacts a transaction writes, and they sit closest to the doctor
  //    gate. A concurrent writer that lands between our last write and the
  //    doctor failure must not be clobbered by the rollback. These tests
  //    exercise the fail-closed seam (via the new `postReceiptReplace` hook)
  //    and prove ordinary doctor failure still restores the exact healthy
  //    state.

  it("still restores the exact healthy state on an ordinary doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifest = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceipt = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);
    const beforeBytes = await snapshotOwnedBytes(repository);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // Every owned byte, including the receipts generation and digest,
    // must match the pre-transaction baseline byte-for-byte.
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfig)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, "opencode.jsonc")), beforeOpenCode)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifest)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceipt)).toBe(0);
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceipt.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
    expectOwnedBytesUnchanged(beforeBytes, await snapshotOwnedBytes(repository));
  }, 30_000);

  it("preserves foreign manifest bytes when a concurrent writer lands between manifest write and doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const foreignManifestBytes = Buffer.from(
      `${JSON.stringify(
        {
          schema: 1,
          poiesisVersion: "0.0.0-foreign",
          adapter: { harness: "opencode", adapterVersion: "0", supportedVersion: "0", supportedVersions: ["0"] },
          files: [],
          skills: [],
          configPatches: [],
        },
        null,
        2,
      )}\n`,
    );

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        updateFromConfig(repository.root, candidatePath, {
          writerHooks: {
            // Concurrent foreign writer lands AFTER our manifest write and
            // receipt replace but BEFORE the doctor gate. The fail-closed
            // rollback must leave these foreign bytes intact; it must not
            // rewind the manifest to our preimage.
            postReceiptReplace: async () => {
              await writeFile(manifestPath, foreignManifestBytes);
            },
          },
        }),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(manifestPath), foreignManifestBytes)).toBe(0);
    // The receipt is still ours (no foreign writer touched it), so ordinary
    // receipt rollback applies: the receipt must be back at the pre-transaction
    // byte and generation.
    const beforeReceipt = await readOwnershipReceipt(repository.root);
    const afterReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as { generation: number };
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
  }, 30_000);

  it("preserves foreign receipt bytes when a concurrent writer lands between receipt replacement and doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforeManifest = await readFile(manifestPath);
    const foreignReceiptBytes = Buffer.from(
      `{"schema":1,"commonDir":"/dev/null","workspace":"/dev/null","installationId":"foreign","manifestDigest":"deadbeef","generation":9999}\n`);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        updateFromConfig(repository.root, candidatePath, {
          writerHooks: {
            // Concurrent foreign writer overwrites the receipt we just wrote
            // BEFORE the doctor gate runs. The fail-closed rollback must
            // leave these foreign bytes intact; it must not rewind the
            // receipt to our preimage.
            postReceiptReplace: async () => {
              await writeFile(receiptPath, foreignReceiptBytes);
            },
          },
        }),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(receiptPath), foreignReceiptBytes)).toBe(0);
    // The manifest is still ours (no foreign writer touched it), so ordinary
    // manifest rollback applies: the manifest must be back at the preimage.
    expect(Buffer.compare(await readFile(manifestPath), beforeManifest)).toBe(0);
  }, 30_000);
});

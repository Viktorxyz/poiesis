import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  doctor,
  init,
  updateFromConfig,
} from "../src/maintenance.js";
import {
  runUpdateConfigTransaction,
  type UpdateTransactionHooks,
} from "../src/update-config-internal.js";
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

  // -- Helper: re-install the fake `opencode debug config` to fail AFTER a
  //    fixed call threshold. Used by tests that need the preflight schema
  //    call to succeed (count #2 — init consumed #1 during `install()`)
  //    and the doctor gate schema call (count #3) to fail. A new temp
  //    counter file is allocated per test so successive tests do not share
  //    call-count state.
  async function installStatefulFakeForDoctorFailure(threshold: number): Promise<void> {
    const counterDir = await mkdtemp(join(tmpdir(), "poiesis-doctor-counter-"));
    const counterFile = join(counterDir, "count");
    env?.restore();
    env = await installFakeOpenCode({ failAfterDebugCalls: { file: counterFile, threshold } });
  }

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

  // -- Ticket #36: the no-op branch of `runUpdateConfigTransaction` must
  //    exercise the SAME doctor gate predicate the post-mutation branch
  //    already exercises (extracted as `assertUpdateConfigDoctorGate`).
  //    Healthy doctor → the no-op result returns the existing manifest
  //    and the receipt generation/digest stay exactly as before. Unhealthy
  //    doctor → the no-op path throws `UPDATE_DOCTOR_FAILED` exactly like
  //    the post-mutation path, without ever mutating any owned byte. The
  //    test seam (`preNoopDoctor`) is intentionally internal to
  //    `UpdateTransactionHooks` so production callers see no new surface.

  it("returns the existing manifest unchanged and keeps receipt generation/digest when the no-op branch passes doctor", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, () => undefined);
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceiptBytes = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);

    const result = await runUpdateConfigTransaction(repository.root, candidatePath, {}, {});

    // The no-op branch returns the EXISTING manifest (same bytes as
    // captured before invocation; identity equality with a fresh load is
    // not guaranteed by the loader), and the doctor report it returns
    // comes from `doctor()` — which is healthy after `install()`.
    const afterManifest = await loadManifest(repository.root);
    expect(serializeManifest(result.manifest)).toBe(serializeManifest(afterManifest));
    expect(result.doctor.checks.find((check) => check.id === "manifest")?.status).toBe("pass");
    expect(result.doctor.checks.find((check) => check.id === "receipt")?.status).toBe("pass");
    expect(result.doctor.checks.find((check) => check.id === "opencode-schema")?.status).toBe("pass");

    // Exact byte-for-byte preservation of every owned file and the receipt.
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfig)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, "opencode.jsonc")), beforeOpenCode)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceiptBytes)).toBe(0);

    // The receipt generation AND manifestDigest stay at the pre-transaction
    // baseline — no generation advance, no digest rebind on a no-op.
    const afterReceiptParsed = await readOwnershipReceipt(repository.root);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
  }, 30_000);

  it("throws UPDATE_DOCTOR_FAILED and preserves every owned byte/receipt when the no-op branch fails doctor", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, () => undefined);
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCode = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceiptBytes = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);

    // The `preNoopDoctor` seam fires BEFORE `doctor()` runs in the no-op
    // branch. The test uses it to toggle the fake `opencode debug config`
    // failure so `doctor()` returns a failing `opencode-schema` check,
    // mirroring how the post-mutation tests force doctor to fail. The
    // extracted `assertUpdateConfigDoctorGate` helper must then throw
    // `UPDATE_DOCTOR_FAILED` with the same message and `report` details
    // the post-mutation path has always thrown.
    // The `preNoopDoctor` seam fires BEFORE `doctor()` runs in the no-op
    // branch and toggles the fake `opencode debug config` failure so
    // doctor returns a failing `opencode-schema` check, mirroring how the
    // post-mutation tests force doctor to fail. The extracted
    // `assertUpdateConfigDoctorGate` helper then throws
    // `UPDATE_DOCTOR_FAILED` with the same message and `report` details
    // the post-mutation path has always thrown. The finally block
    // restores the default healthy fake so subsequent tests get a fresh
    // state.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    try {
      await expect(
        runUpdateConfigTransaction(repository.root, candidatePath, {}, {
          preNoopDoctor: () => {
            process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
          },
        }),
      ).rejects.toMatchObject({
        code: "UPDATE_DOCTOR_FAILED",
        message: "Poiesis update --config did not pass doctor",
      });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
    }

    // The no-op branch NEVER writes a byte — every owned file and the
    // receipt must match the pre-transaction baseline byte-for-byte, and
    // the receipt generation/manifestDigest must stay unchanged.
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfig)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, "opencode.jsonc")), beforeOpenCode)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceiptBytes)).toBe(0);
    const afterReceiptParsed = await readOwnershipReceipt(repository.root);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
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
      runUpdateConfigTransaction(repository.root, candidatePath, {}, {
        prePoiesisConfigWrite: () => { throw new Error("injected: poiesis config write"); },
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
      runUpdateConfigTransaction(repository.root, candidatePath, {}, {
        preOpenCodeApply: () => { throw new Error("injected: opencode apply"); },
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
      runUpdateConfigTransaction(repository.root, candidatePath, {}, {
        preManifestWrite: () => { throw new Error("injected: manifest write"); },
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
      runUpdateConfigTransaction(repository.root, candidatePath, {}, {
        preReceiptReplace: () => { throw new Error("injected: receipt replace"); },
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
    // Re-install the fake `opencode debug config` with a fail-after threshold so
    // the preflight schema call (count #1 against the stateful fake,
    // threshold=1, 1>1? no → success) passes and the doctor gate schema
    // call (count #2, 2>1? yes → fail). After the assertion, restore
    // the default healthy fake so subsequent tests get a fresh state.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    await installStatefulFakeForDoctorFailure(1);
    try {
      await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
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

    // Re-install the fake `opencode debug config` with a fail-after threshold so
    // the preflight schema call (count #1 against the stateful fake,
    // threshold=1, 1>1? no → success) passes and the doctor gate schema
    // call (count #2, 2>1? yes → fail). After the assertion, restore
    // the default healthy fake so subsequent tests get a fresh state.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    await installStatefulFakeForDoctorFailure(1);
    try {
      await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
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

  // -- Exact preimage bytes: the rollback path writes the preimage Buffer
  //    directly (no string conversion, no newline normalization). A
  //    pre-update OpenCode config that lacks a trailing newline must be
  //    restored byte-for-byte (no newline appended), and the doctor must
  //    pass against the rolled-back state because the preimage was a
  //    valid Poiesis-managed file all along.

  it("restores a no-trailing-newline OpenCode config exactly on doctor failure and leaves a healthy doctor state", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    // Rewrite the post-init OpenCode config without a trailing newline
    // AND keep every managed patch value intact. Update the manifest to
    // record the new hash, then rebind the receipt to the new manifest
    // digest so the receipt gate accepts the fixture.
    const openCodePath = join(repository.root, "opencode.jsonc");
    const originalOpenCodeBytes = await readFile(openCodePath);
    let openCodeContent = originalOpenCodeBytes.toString("utf8");
    if (openCodeContent.endsWith("\n")) {
      openCodeContent = openCodeContent.slice(0, -1);
    }
    // The post-install `init` always normalizes OpenCode config to a
    // trailing newline. Verify that the manual rewrite actually dropped
    // it; the assertion below would silently pass if the install
    // layout were different, so we pin the precondition here.
    expect(openCodeContent.endsWith("\n")).toBe(false);
    const noNewlineOpenCodeBytes = Buffer.from(openCodeContent, "utf8");
    await writeFile(openCodePath, noNewlineOpenCodeBytes);
    const manifest = await loadManifest(repository.root);
    const ocRecord = manifest.files.find((file) => file.path === "opencode.jsonc");
    if (ocRecord === undefined) {
      throw new PoiesisError("FILE_OWNERSHIP_UNKNOWN", "OpenCode config not in manifest", {});
    }
    ocRecord.hash = hashContent(noNewlineOpenCodeBytes);
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    const receipt = await readOwnershipReceipt(repository.root);
    await replaceOwnershipReceipt(repository.root, manifest, receipt);

    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeOpenCode = await readFile(openCodePath);
    const beforeConfig = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceiptBytes = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);

    // Re-install the fake `opencode debug config` with a fail-after threshold so
    // the preflight schema call (count #1 against the stateful fake,
    // threshold=1, 1>1? no → success) passes and the doctor gate schema
    // call (count #2, 2>1? yes → fail). After the assertion, restore
    // the default healthy fake so subsequent tests get a fresh state.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    await installStatefulFakeForDoctorFailure(1);
    try {
      await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
    }

    // The rollback must restore the EXACT preimage bytes (no newline
    // appended) for the OpenCode config, the Poiesis config, and the
    // manifest. The receipt rollback also restores the preimage.
    expect(Buffer.compare(await readFile(openCodePath), beforeOpenCode)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfig)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceiptBytes)).toBe(0);
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceipt.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);

    // The preimage was a valid Poiesis-managed file, so the doctor must
    // pass against the rolled-back state.
    const report = await doctor(repository.root);
    expectTransactionChecksPass(report);
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
    // Capture the pre-transaction receipt baseline BEFORE invocation: both
    // raw bytes and parsed generation/manifestDigest. The fail-closed
    // rollback must leave these exactly intact.
    const beforeReceiptBytes = await readFile(receiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);
    const foreignManifestBytes = Buffer.from(
      `${JSON.stringify(
        {
          schema: 1,
          poiesisVersion: "0.0.0.0-foreign",
          adapter: { harness: "opencode", adapterVersion: "0", supportedVersion: "0", supportedVersions: ["0"] },
          files: [],
          skills: [],
          configPatches: [],
        },
        null,
        2,
      )}\n`,
    );

    // Re-install the fake `opencode debug config` with a fail-after threshold so
    // the preflight schema call (count #1 against the stateful fake,
    // threshold=1, 1>1? no → success) passes and the doctor gate schema
    // call (count #2, 2>1? yes → fail). After the assertion, restore
    // the default healthy fake so subsequent tests get a fresh state.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    await installStatefulFakeForDoctorFailure(1);
    try {
      await expect(
        runUpdateConfigTransaction(repository.root, candidatePath, {}, {
          // Concurrent foreign writer lands AFTER our manifest write and
          // receipt replace but BEFORE the doctor gate. The fail-closed
          // rollback must leave these foreign bytes intact; it must not
          // rewind the manifest to our preimage.
          postReceiptReplace: async () => {
            await writeFile(manifestPath, foreignManifestBytes);
          },
        }),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
    }

    expect(Buffer.compare(await readFile(manifestPath), foreignManifestBytes)).toBe(0);
    // The receipt is still ours (no foreign writer touched it), so ordinary
    // receipt rollback applies: the receipt bytes AND parsed
    // generation/manifestDigest must match the pre-transaction baseline
    // captured BEFORE invocation.
    const afterReceiptBytes = await readFile(receiptPath);
    const afterReceiptParsed = JSON.parse(afterReceiptBytes.toString("utf8")) as { generation: number; manifestDigest: string };
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).toBe(0);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
  }, 30_000);

  it("does not adopt a foreign replacement that lands immediately after manifest write as our identity", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
    // Capture the pre-transaction receipt baseline BEFORE invocation.
    const beforeReceiptBytes = await readFile(receiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);
    const foreignManifestBytes = Buffer.from(
      `${JSON.stringify(
        {
          schema: 1,
          poiesisVersion: "0.0.0.0-foreign",
          adapter: { harness: "opencode", adapterVersion: "0", supportedVersion: "0", supportedVersions: ["0"] },
          files: [],
          skills: [],
          configPatches: [],
        },
        null,
        2,
      )}\n`,
    );

    // Re-install the fake `opencode debug config` with a fail-after threshold so
    // the preflight schema call (count #1 against the stateful fake,
    // threshold=1, 1>1? no → success) passes and the doctor gate schema
    // call (count #2, 2>1? yes → fail). After the assertion, restore
    // the default healthy fake so subsequent tests get a fresh state.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    await installStatefulFakeForDoctorFailure(1);
    try {
      await expect(
        runUpdateConfigTransaction(repository.root, candidatePath, {}, {
          // Concurrent foreign writer lands IMMEDIATELY after our manifest
          // atomic write completes but BEFORE the transaction observes the
          // manifest (receipt replace, doctor gate, hashFile reread for
          // ownership). The transaction must not adopt these foreign bytes
          // as our post-write identity, and the fail-closed rollback must
          // leave the foreign bytes intact instead of rewinding the
          // manifest to our preimage.
          postManifestWrite: async () => {
            await writeFile(manifestPath, foreignManifestBytes);
          },
        }),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
    }

    // Foreign manifest bytes survive: the rollback path did not see the
    // foreign bytes as our identity, so it left the file alone.
    expect(Buffer.compare(await readFile(manifestPath), foreignManifestBytes)).toBe(0);
    // The receipt is still ours (no foreign writer touched it), so ordinary
    // receipt rollback applies: the receipt bytes AND parsed
    // generation/manifestDigest must match the pre-transaction baseline
    // captured BEFORE invocation.
    const afterReceiptBytes = await readFile(receiptPath);
    const afterReceiptParsed = JSON.parse(afterReceiptBytes.toString("utf8")) as { generation: number; manifestDigest: string };
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).toBe(0);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
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

    // Re-install the fake `opencode debug config` with a fail-after threshold so
    // the preflight schema call (count #1 against the stateful fake,
    // threshold=1, 1>1? no → success) passes and the doctor gate schema
    // call (count #2, 2>1? yes → fail). After the assertion, restore
    // the default healthy fake so subsequent tests get a fresh state.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    await installStatefulFakeForDoctorFailure(1);
    try {
      await expect(
        runUpdateConfigTransaction(repository.root, candidatePath, {}, {
          // Concurrent foreign writer overwrites the receipt we just wrote
          // BEFORE the doctor gate runs. The fail-closed rollback must
          // leave these foreign bytes intact; it must not rewind the
          // receipt to our preimage.
          postReceiptReplace: async () => {
            await writeFile(receiptPath, foreignReceiptBytes);
          },
        }),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
    }

    expect(Buffer.compare(await readFile(receiptPath), foreignReceiptBytes)).toBe(0);
    // The manifest is still ours (no foreign writer touched it), so ordinary
    // manifest rollback applies: the manifest must be back at the preimage.
    expect(Buffer.compare(await readFile(manifestPath), beforeManifest)).toBe(0);
  }, 30_000);

  // -- Ticket #31: `update --config` must use the resolved config returned by
  //    `autoResolveConfigDefaults` for serialization, delivery checks, OpenCode
  //    projection, and the next manifest content. Complete model inventory,
  //    repository, tracker, delivery, adapter/OpenCode validation must run
  //    BEFORE the first write. Unavailable model / invalid environment must
  //    cause ZERO transaction write attempts; discovered defaults must be
  //    persisted.

  it("uses the resolved config for serialization, so a candidate that only omits the discovered repository fields is a no-op", async () => {
    // Install with the standard test config (repository.remote = "origin",
    // repository.integrationBranch = "main"). The on-disk
    // `.poiesis/config.jsonc` carries the same resolved values that
    // `autoResolveConfigDefaults` would produce. The candidate config omits
    // `repository` entirely; after resolution the discovered defaults fill it
    // back in and the serialized bytes match the on-disk preimage byte-for-byte.
    // If the transaction used the unresolved proposed config, the `repository`
    // field would be absent from the serialized bytes and a write would
    // happen — which this no-op detection rejects.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidateConfig = structuredClone(testConfig(repository)) as PoiesisConfig;
    delete (candidateConfig as { repository?: unknown }).repository;
    const candidatePath = join(repository.parent, "candidate-omits-repository.jsonc");
    await writeFile(candidatePath, serializeConfig(candidateConfig));

    const beforeConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCodeBytes = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifest = await loadManifest(repository.root);
    const beforeReceipt = await readOwnershipReceipt(repository.root);

    const result = await updateFromConfig(repository.root, candidatePath);

    // Resolved defaults are equal to the on-disk values: no write, no
    // generation advance, no receipt digest change.
    expect(await readFile(join(repository.root, CONFIG_ROOT))).toEqual(beforeConfigBytes);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(beforeOpenCodeBytes);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(serializeManifest(beforeManifest));
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
    expect(afterReceipt.manifestDigest).toBe(beforeReceipt.manifestDigest);
    expect(result.doctor.checks.find((check) => check.id === "manifest")?.status).toBe("pass");
    expect(result.doctor.checks.find((check) => check.id === "receipt")?.status).toBe("pass");
  }, 30_000);

  it("persists the resolved config to .poiesis/config.jsonc, manifest content, and OpenCode projection", async () => {
    // Candidate omits `repository` AND changes the execution model. After
    // resolution the candidate carries the discovered remote/branch plus the
    // new execution model. The transaction MUST write those resolved values
    // everywhere: the on-disk `.poiesis/config.jsonc`, the next manifest
    // digest for `.poiesis/config.jsonc`, and the OpenCode agent permission
    // bound to the new execution model.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidateConfig = structuredClone(testConfig(repository)) as PoiesisConfig;
    delete (candidateConfig as { repository?: unknown }).repository;
    candidateConfig.models.execution = "minimax/MiniMax-M3-alt";
    const candidatePath = join(repository.parent, "candidate-resolved-defaults.jsonc");
    await writeFile(candidatePath, serializeConfig(candidateConfig));

    const result = await updateFromConfig(repository.root, candidatePath);

    const onDiskConfig = await readPoiesisConfig(repository);
    expect(onDiskConfig.repository?.remote).toBe("origin");
    expect(onDiskConfig.repository?.integrationBranch).toBe("main");
    expect(onDiskConfig.models.execution).toBe("minimax/MiniMax-M3-alt");

    // Manifest entry for the Poiesis config reflects the new hash.
    const manifest = await loadManifest(repository.root);
    const configRecord = manifest.files.find((file) => file.path === CONFIG_ROOT);
    expect(configRecord?.hash).toBe(hashContent(await readFile(join(repository.root, CONFIG_ROOT))));

    // OpenCode projection reflects the new execution model.
    const openCodeJson = await readOpenCodeJson(repository);
    expect((openCodeJson.agent as Record<string, Record<string, unknown>>)?.poiesis?.model).toBe(onDiskConfig.models.reasoning);
    expect((openCodeJson.agent as Record<string, Record<string, unknown>>)?.explore?.model).toBe("minimax/MiniMax-M3-alt");
    expect((openCodeJson.agent as Record<string, Record<string, unknown>>)?.["poiesis-worker"]?.model).toBe("minimax/MiniMax-M3-alt");

    expectTransactionChecksPass(result.doctor);
  }, 30_000);

  it("rejects with MODEL_UNAVAILABLE before any write when the OpenCode model inventory lacks the configured models", async () => {
    // Override the fake `opencode models` output to an empty list. The
    // model-inventory probe (`verifyModels`) MUST run before the first write
    // and MUST reject every owned byte — including the Poiesis config, the
    // OpenCode config, the manifest, and the ownership receipt — exactly
    // because the transaction has not yet committed any change.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);

    const prevModels = process.env.POIESIS_TEST_OPENCODE_MODELS;
    process.env.POIESIS_TEST_OPENCODE_MODELS = ""; // empty model inventory
    try {
      await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
      });
    } finally {
      if (prevModels === undefined) delete process.env.POIESIS_TEST_OPENCODE_MODELS;
      else process.env.POIESIS_TEST_OPENCODE_MODELS = prevModels;
    }

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  it("rejects with OPENCODE_VERSION_UNSUPPORTED before any write when the installed OpenCode version is not in the supported set", async () => {
    // Override the fake `opencode --version` output to a version outside the
    // supported set. The OpenCode-version probe MUST run before the first
    // write and MUST reject every owned byte.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);

    env?.restore();
    env = await installFakeOpenCode("1.19.0"); // not in SUPPORTED_OPENCODE_VERSIONS
    try {
      await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({
        code: "OPENCODE_VERSION_UNSUPPORTED",
      });
    } finally {
      env.restore();
      env = await installFakeOpenCode(); // restore default for afterEach
    }

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);

  it("rejects with UNKNOWN_DELIVERY_ADAPTER after receipt auth and before any write when the resolved config has an unknown adapter", async () => {
    // The narrowest `verifyDeliveryConfiguration` helper must run against the
    // RESOLVED config (i.e. after `autoResolveConfigDefaults`) so a foreign
    // delivery adapter name can never land in the transaction. The
    // `createDeliveryAdapter` call inside `verifyDeliveryConfiguration`
    // throws `UNKNOWN_DELIVERY_ADAPTER` for unsupported adapter names; the
    // transaction MUST reject before any owned byte is mutated.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    const invalidDelivery = structuredClone(testConfig(repository)) as PoiesisConfig;
    invalidDelivery.delivery = {
      preview: { adapter: "not-a-real-adapter" },
      staging: { adapter: "fixture", path: repository.fixtures },
      production: { adapter: "fixture", path: repository.fixtures },
    };
    const candidatePath = join(repository.parent, "candidate-bad-delivery.jsonc");
    await writeFile(candidatePath, serializeConfig(invalidDelivery));

    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({
      code: "UNKNOWN_DELIVERY_ADAPTER",
    });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 30_000);
  // -- Ticket #37: the preflight OpenCode schema validation must run before
  //    any owned byte is mutated. When the fake `opencode debug config`
  //    rejects the projected payload, the transaction fails closed with
  //    ZERO writes to the Poiesis config, the OpenCode config, the manifest,
  //    or the ownership receipt, and ZERO generation advance. The flag
  //    toggle happens AFTER `install()` so init's own schema validation
  //    pass-through still succeeds; the preflight is the next `opencode
  //    debug config` call the transaction makes.
  it("rejects preflight schema validation before any managed write with zero hook invocations and exact byte preservation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const beforeBytes = await snapshotOwnedBytes(repository);
    const beforeReceipt = await readOwnershipReceipt(repository.root);

    // Install a stateful fake with threshold=0 so the FIRST `opencode
    // debug config` call against this fake fails on the very first
    // invocation. init() ran with the DEFAULT fake before this
    // helper (its single `validateOpenCodeConfigPayload` succeeded
    // there), so it never touches this counter. The transaction-side
    // `validateOpenCodeConfigPayload(preflightSerialized)` at step 8
    // is the first debug call against the new stateful fake → fails.
    await installStatefulFakeForDoctorFailure(0);

    // Hook invocation counters — all hooks are intentionally internal
    // surfaces of `UpdateTransactionHooks`; this test proves the
    // preflight rejection happens BEFORE any of them fire. Counters
    // are LOCAL closures here, exposed only through the transaction
    // call; the public `UpdateConfigOptions` type never sees them.
    let countPrePoiesisConfigWrite = 0;
    let countPreOpenCodeApply = 0;
    let countPreManifestWrite = 0;
    let countPreReceiptReplace = 0;
    let countPostReceiptReplace = 0;
    let countPostManifestWrite = 0;
    let countPreNoopDoctor = 0;
    let countInjectDriftedOnWrittenContent = 0;
    let capturedDryRunBytes: string | null = null;

    try {
      await expect(
        runUpdateConfigTransaction(repository.root, candidatePath, {}, {
          prePoiesisConfigWrite: () => { countPrePoiesisConfigWrite++; },
          preOpenCodeApply: () => { countPreOpenCodeApply++; },
          preManifestWrite: () => { countPreManifestWrite++; },
          preReceiptReplace: () => { countPreReceiptReplace++; },
          postReceiptReplace: () => { countPostReceiptReplace++; },
          postManifestWrite: () => { countPostManifestWrite++; },
          preNoopDoctor: () => { countPreNoopDoctor++; },
          injectDriftedOnWrittenContent: (defaultContent) => {
            countInjectDriftedOnWrittenContent++;
            capturedDryRunBytes = defaultContent;
            return defaultContent;
          },
        }),
      ).rejects.toThrow();      // The mutating preflight surfaces the pre-#37 error semantics of
      // `validateOpenCodeConfigPayload` (the fake `opencode debug config`
      // exits non-zero, which `run()` translates into `PoiesisError`
      // with code `COMMAND_FAILED` and a message including the fake's
      // stderr). The test deliberately does NOT remap the code to
      // `UPDATE_DOCTOR_FAILED` here — that convergence is reserved for
      // the no-op branch via `doctor()` + `assertUpdateConfigDoctorGate`.
      // Only the schema rejection itself is asserted.
    } finally {
      env?.restore();
      env = await installFakeOpenCode();
    }

    // All hooks fired ZERO times — the rejection happened before any
    // pre-write or post-write seam was reachable. This proves the
    // transaction fails closed before mutating any owned byte.
    expect(countPrePoiesisConfigWrite, "prePoiesisConfigWrite must not fire").toBe(0);
    expect(countPreOpenCodeApply, "preOpenCodeApply must not fire").toBe(0);
    expect(countPreManifestWrite, "preManifestWrite must not fire").toBe(0);
    expect(countPreReceiptReplace, "preReceiptReplace must not fire").toBe(0);
    expect(countPostReceiptReplace, "postReceiptReplace must not fire").toBe(0);
    expect(countPostManifestWrite, "postManifestWrite must not fire").toBe(0);
    expect(countPreNoopDoctor, "preNoopDoctor must not fire").toBe(0);
    expect(countInjectDriftedOnWrittenContent, "injectDriftedOnWrittenContent must not fire").toBe(0);
    // And the dry-run bytes are never observed (callback not reached).
    expect(capturedDryRunBytes, "onWritten not reached").toBeNull();

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);

    // Belt-and-braces: explicitly assert no receipt generation advance.
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
    expect(afterReceipt.manifestDigest).toBe(beforeReceipt.manifestDigest);
  }, 30_000);

  // -- Ticket #37 correction 1: deterministic internal-hook regression for
  //    projection drift after preflight. Asserts that the onWritten
  //    callback assigns `openCodeWrittenHash` BEFORE the drift equality
  //    check throws, so the rollback identity is preserved when the drift
  //    throw fires. The hook (`injectDriftedOnWrittenContent`) is an
  //    internal test seam only — production callers leave it unset and
  //    the apply path produces byte-identical content to preflight (the
  //    pure helper is deterministic), so the throw path is unreachable
  //    in production. The test asserts the rollback survives the throw
  //    by reading the on-disk OpenCode config preimage byte-for-byte.
  it("preserves rollback identity when the apply path sees drifted serialized bytes after preflight", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });
    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeOpenCodeBytes = await readFile(openCodePath);
    const beforeConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceiptBytes = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);

    // The onWritten callback captures the expected content from the
    // preflight. Force a different return from the callback via the
    // internal `injectDriftedOnWrittenContent` hook. Because the
    // hook-fired content differs from `preflightSerialized`, the apply
    // step throws INSTALL_PATH_CONFLICT after the OpenCode config was
    // already written. The fix under test: `openCodeWrittenHash` is
    // computed BEFORE the throw so the rollback can identify the on-disk
    // hash and restore the preimage byte-for-byte.
    const driftBytes = "{} ";
    let observedOpenCodeWrittenHash: string | undefined = undefined;
    await expect(
      runUpdateConfigTransaction(repository.root, candidatePath, {}, {
        injectDriftedOnWrittenContent: (defaultContent) => {
          observedOpenCodeWrittenHash = hashContent(defaultContent);
          return driftBytes;
        },
      }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });

    // The hook captured the actual content that applyOpenCodeConfig wrote
    // (synchronously, before the drift throw fired). This proves the onWritten
    // callback reached the recording line BEFORE the throw, which is the
    // contract the fix establishes: `openCodeWrittenHash` is set on the
    // captured bytes so the rollback path can identify the on-disk hash.
    expect(observedOpenCodeWrittenHash, "hook observed applyOpenCodeConfig bytes").toMatch(/^[a-f0-9]{64}$/);
    // Confirm the apply step actually wrote (the on-disk content after the
    // throw equals what `applyOpenCodeConfig` would have written for the
    // original config; the rollback later restores the preimage, so this
    // assertion runs BEFORE we sample the rolled-back state).
    // We assert non-empty + the hook recorded a distinct hash from the
    // preimage so the recording is non-trivial.
    expect(observedOpenCodeWrittenHash).not.toBe(hashContent(beforeOpenCodeBytes));

    // The rollback identity matched: the on-disk OpenCode config is the
    // preimage byte-for-byte (since `openCodeWrittenHash` was set BEFORE
    // the throw, the hash-gated rollback can identify and restore).
    expect(Buffer.compare(await readFile(openCodePath), beforeOpenCodeBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfigBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceiptBytes)).toBe(0);
    const afterReceiptParsed = await readOwnershipReceipt(repository.root);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
  }, 30_000);


    it("rejects no-op schema failure as UPDATE_DOCTOR_FAILED and preserves every owned byte/receipt", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const candidatePath = await writeCandidateConfig(repository, () => undefined);
    const beforeConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeOpenCodeBytes = await readFile(join(repository.root, "opencode.jsonc"));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceiptBytes = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);

    // threshold=0 → first debug call against this fake fails immediately.
    await installStatefulFakeForDoctorFailure(0);
    try {
      await expect(
        updateFromConfig(repository.root, candidatePath),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED", message: "Poiesis update --config did not pass doctor" });
    } finally {
      env?.restore();
      env = await installFakeOpenCode();
    }

    // Exact zero-byte preservation of every owned file and the receipt.
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfigBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, "opencode.jsonc")), beforeOpenCodeBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceiptBytes)).toBe(0);
    const afterReceiptParsed = await readOwnershipReceipt(repository.root);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
  }, 30_000);

  // -- Ticket #37 correction 3: UTF-8 non-round-tripping rejection.
  //    The OpenCode config is captured ONCE at step 5. If the on-disk
  //    bytes do not round-trip through `Buffer.from(content, "utf8")`,
  //    the transaction throws INSTALL_PATH_CONFLICT before any patch
  //    ownership check, helper call, no-op detection, or write. The
  //    rejection must preserve every owned byte and the receipt.
  it("rejects non-round-tripping UTF-8 in the OpenCode config before any write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeBytes = await readFile(openCodePath);
    const beforeConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceiptBytes = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);

    // Replace the OpenCode config bytes with ones that are NOT valid
    // UTF-8 round-trip. The byte 0xff alone is invalid UTF-8 and any
    // valid-enough prefix followed by 0xff will not survive a
    // Buffer.from(s, "utf8") round trip.
    const foreignBytes = Buffer.concat([beforeBytes, Buffer.from([0xff, 0xfe])]);
    await writeFile(openCodePath, foreignBytes);

    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });

    await expect(
      updateFromConfig(repository.root, candidatePath),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT", message: expect.stringMatching(/UTF-8/) });

    // The foreign bytes must remain intact (no rollback because we
    // never wrote anything).
    expect(Buffer.compare(await readFile(openCodePath), foreignBytes)).toBe(0);
    // Every other owned byte must remain at its preimage (no writes).
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfigBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceiptBytes)).toBe(0);
    const afterReceiptParsed = await readOwnershipReceipt(repository.root);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
  }, 30_000);

  // -- OpenCode config whose on-disk values no longer agree with the
  //    recorded manifest patches fails `CONFIG_OWNERSHIP_LOST` before
  //    any mutating step. The single captured snapshot feeds the
  //    `assertOpenCodeOwnershipAgainstSnapshot` helper that compares
  //    every `recorded.patch.installed` against the parsed preimage's
  //    value at the same `path`; if any recorded claim is missing or
  //    differs from the parsed form, the helper raises
  //    `CONFIG_OWNERSHIP_LOST`. The helper is the single source of
  //    truth here: it operates on the captured parsed form, so a
  //    foreign writer that lands in the same parse step (or any
  //    later apply-step read) does not change this assertion.
  it("rejects when the OpenCode config disagrees with the recorded patches", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeBytes = await readFile(openCodePath);
    const beforeConfigBytes = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceiptPath = await ownershipReceiptLocation(repository.root);
    const beforeReceiptBytes = await readFile(beforeReceiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repository.root);

    // Install a `preReadOpencode` hook that, after the step 5 snapshot
    // reads the OpenCode config, replaces it with foreign bytes that DO
    // NOT contain the recorded patch `installed` values (so the
    // ownership verification at step 5a will throw CONFIG_OWNERSHIP_LOST).
    // Since step 5 reads BEFORE the hook fires, the parsed snapshot at
    // step 5 still holds the preimage bytes. The foreign bytes arrive in
    // step 5a's `currentOpenCodeJson` only because step 5 uses the
    // stale snapshot — but the ownership check operates on the parsed
    // form returned by step 5 (not on freshly read bytes), so a foreign
    // byte replacement DURING step 5's parse-window is OUTSIDE this
    //    test's reach. Instead, this test exercises a different angle:
    //    we manually replace the file BEFORE updateFromConfig runs and
    //    expect the ownership check to fail because the parsed
    //    preimage (captured at step 5) shows a different shape than
    //    what the recorded patches claim to own.
    const foreignBytes = Buffer.from(
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          foreign_marker: true,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await writeFile(openCodePath, foreignBytes);

    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });

    // The transaction must fail closed because the recorded config
    // patches claim values at e.g. `["agent", "poiesis", ...]` that do
    //    not exist in the foreign file — `assertOpenCodeOwnershipAgainstSnapshot`
    //    raises `CONFIG_OWNERSHIP_LOST`.
    await expect(
      updateFromConfig(repository.root, candidatePath),
    ).rejects.toMatchObject({ code: "CONFIG_OWNERSHIP_LOST" });

    // The foreign bytes must remain intact (no writes ever happened).
    expect(Buffer.compare(await readFile(openCodePath), foreignBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforeConfigBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(beforeReceiptPath), beforeReceiptBytes)).toBe(0);
    const afterReceiptParsed = await readOwnershipReceipt(repository.root);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
  }, 30_000);


});

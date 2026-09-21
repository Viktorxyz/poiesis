/**
 * Ticket #30 -- Ordinary `update()` and explicit 1.0.0 bootstrap rollback
 * hardening.
 *
 * Ticket #32 -- Next-manifest OpenCode file hash binding to the
 * `applyOpenCodeConfig` callback's exact transaction-written bytes
 * (never a later mutable-path reread), with a defensive pre-materialize
 * identity check that fails closed on any post-write foreign
 * replacement.
 *
 * The deterministic fault-injection tests below exercise the
 * `runUpdateTransaction` and `runBootstrapLegacyOwnershipTransaction`
 * seams introduced in `src/update-internal.ts`. Every test asserts
 * one of the following post-b invariants:
 *
 *   1. Ordinary later failure with no interference restores exact
 *      bytes/existence/generation/digest for every artifact this
 *      invocation writes (materialized managed files, OpenCode config,
 *      manifest, receipt, transactional `.gitignore`).
 *
 *   2. A concurrent foreign replacement that lands between this
 *      transaction's last write and the rollback is preserved
 *      unchanged. The transaction must not adopt foreign bytes as its
 *      own post-write identity, and the rollback path must not
 *      overwrite foreign bytes with the preimage.
 *
 *   3. Bootstrap parity: the explicit 1.0.0 bootstrap path restores
 *      the same invariants and preserves the same foreign writes.
 *
 *   4. (#32) The next manifest's OpenCode file hash is bound to the
 *      EXACT bytes captured by `applyOpenCodeConfig`'s `onWritten`
 *      callback (never a later mutable-path reread). A post-write
 *      foreign replacement that lands between the callback and
 *      manifest/receipt materialization fails closed with
 *      `OPENCODE_CONFIG_CHANGED`; the no-interference happy path
 *      records the exact callback bytes in the new manifest. The
 *      rollback path preserves the foreign OpenCode replacement
 *      (hash-gated against the captured callback identity) and only
 *      restores the transaction-owned preimage when the on-disk bytes
 *      still match the transaction's writes.
 *
 * The seam lives in `src/update-internal.ts`, which is NOT re-exported
 * by `src/index.ts` and therefore does not appear in the packed
 * `dist/index.d.ts`. Tests import the seam symbols directly.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  init,
  update,
  doctor,
} from "../src/maintenance.js";
import {
  runUpdateTransaction,
  runBootstrapLegacyOwnershipTransaction,
  type UpdateBootstrapTransactionHooks,
} from "../src/update-internal.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import {
  ownershipReceiptLocation,
  readOwnershipReceipt,
} from "../src/receipt.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import type { DoctorReport } from "../src/maintenance.js";
import { PoiesisError } from "../src/errors.js";
import { hashContent } from "../src/hash.js";

interface OwnedByteSnapshot {
  materializedFiles: Map<string, { content: Buffer; absent: boolean }>;
  openCodeConfig: { content: Buffer; absent: boolean };
  manifest: { content: Buffer; absent: boolean };
  receipt: { content: Buffer; absent: boolean };
  receiptGeneration: number | null;
  receiptManifestDigest: string | null;
  gitignore: { content: Buffer; absent: boolean };
}

async function readSnapshot(path: string): Promise<{ content: Buffer; absent: boolean }> {
  try {
    return { content: await readFile(path), absent: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: Buffer.alloc(0), absent: true };
    throw error;
  }
}

async function snapshotOwnedBytes(repository: TestRepository, materializedPaths: string[]): Promise<OwnedByteSnapshot> {
  const materializedFiles = new Map<string, { content: Buffer; absent: boolean }>();
  for (const filePath of materializedPaths) {
    materializedFiles.set(filePath, await readSnapshot(join(repository.root, filePath)));
  }
  const openCodeConfig = await readSnapshot(join(repository.root, "opencode.jsonc"));
  const manifest = await readSnapshot(join(repository.root, ".poiesis", "manifest.json"));
  let receipt: { content: Buffer; absent: boolean };
  let receiptGeneration: number | null = null;
  let receiptManifestDigest: string | null = null;
  let receiptLocation: string | null = null;
  try {
    receiptLocation = await ownershipReceiptLocation(repository.root);
  } catch {
    receiptLocation = null;
  }
  if (receiptLocation === null) {
    receipt = { content: Buffer.alloc(0), absent: true };
  } else {
    receipt = await readSnapshot(receiptLocation);
    if (!receipt.absent) {
      try {
        const parsed = await readOwnershipReceipt(repository.root);
        receiptGeneration = parsed.generation;
        receiptManifestDigest = parsed.manifestDigest;
      } catch (error) {
        if (!(error instanceof PoiesisError)) throw error;
      }
    }
  }
  const gitignore = await readSnapshot(join(repository.root, ".gitignore"));
  return {
    materializedFiles,
    openCodeConfig,
    manifest,
    receipt,
    receiptGeneration,
    receiptManifestDigest,
    gitignore,
  };
}

function expectOwnedBytesUnchanged(before: OwnedByteSnapshot, after: OwnedByteSnapshot): void {
  for (const [path, beforeEntry] of before.materializedFiles) {
    const afterEntry = after.materializedFiles.get(path);
    expect(afterEntry, `materialized file ${path} missing from snapshot`).toBeDefined();
    if (beforeEntry.absent) {
      expect(afterEntry!.absent, `materialized file ${path} was absent before, must remain absent`).toBe(true);
    } else {
      expect(afterEntry!.absent, `materialized file ${path} was present before, must remain present`).toBe(false);
      expect(Buffer.compare(afterEntry!.content, beforeEntry.content), `materialized file ${path} bytes changed`).toBe(0);
    }
  }
  expect(after.openCodeConfig.absent, "opencode config presence changed").toBe(before.openCodeConfig.absent);
  if (!before.openCodeConfig.absent) {
    expect(Buffer.compare(after.openCodeConfig.content, before.openCodeConfig.content), "opencode config bytes changed").toBe(0);
  }
  expect(after.manifest.absent, "manifest presence changed").toBe(before.manifest.absent);
  if (!before.manifest.absent) {
    expect(Buffer.compare(after.manifest.content, before.manifest.content), "manifest bytes changed").toBe(0);
  }
  expect(after.receipt.absent, "receipt presence changed").toBe(before.receipt.absent);
  if (!before.receipt.absent) {
    expect(Buffer.compare(after.receipt.content, before.receipt.content), "receipt bytes changed").toBe(0);
    expect(after.receiptGeneration, "receipt generation advanced").toBe(before.receiptGeneration);
    expect(after.receiptManifestDigest, "receipt manifest digest changed").toBe(before.receiptManifestDigest);
  }
  expect(after.gitignore.absent, "gitignore presence changed").toBe(before.gitignore.absent);
  if (!before.gitignore.absent) {
    expect(Buffer.compare(after.gitignore.content, before.gitignore.content), "gitignore bytes changed").toBe(0);
  }
}

const MATERIALIZED_PATHS = [
  ".poiesis/config.jsonc",
  ".poiesis/poiesis.md",
  ".poiesis/poiesis-config.jsonc",
  ".poiesis/roles/planner.md",
  ".poiesis/roles/poiesis.md",
  ".poiesis/roles/researcher.md",
  ".poiesis/roles/reviewer.md",
  ".poiesis/roles/worker.md",
];

async function install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function asPredecessorManifest(
  repository: TestRepository,
  predecessorVersion: "1.0.0" | "1.0.1" | "1.0.2",
  options: { keepReceipt?: boolean } = {},
): Promise<void> {
  const { predecessorProjectionV100V101V102 } = await import("../src/authority.js");
  const { parseJsonc } = await import("../src/config.js");
  const { readUtf8 } = await import("../src/fs.js");
  const { ownershipReceiptExists, removeOwnershipReceipt } = await import("../src/receipt.js");
  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor = predecessorProjectionV100V101V102(config, predecessorVersion);
  manifest.poiesisVersion = predecessorVersion;
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) => p.path.length === patch.path.length && p.path.every((s, i) => s === patch.path[i]),
    );
    if (matching === undefined) return patch;
    return { ...patch, installed: matching.value };
  });
  await writeFile(
    join(repository.root, ".poiesis", "manifest.json"),
    serializeManifest(manifest),
  );
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
}

async function rebindReceipt(repository: TestRepository): Promise<void> {
  const { replaceOwnershipReceipt } = await import("../src/receipt.js");
  const manifest = await loadManifest(repository.root);
  const existing = await readOwnershipReceipt(repository.root);
  await replaceOwnershipReceipt(repository.root, manifest, existing);
}

/**
 * Spec #104 / ticket #105: rewrite a manifest into the exact v1.0.0
 * predecessor shape (legacy bare-launcher primary bash + obsolete
 * reviewer.task) so the explicit `bootstrap-legacy-ownership` path
 * can admit it via `assertManifestAuthorityToleratingPredecessor`'s
 * 1.0.0 predecessor projection. The legacy primary-bash surface and
 * the reviewer.task field were both part of the v1.0.x contract; the
 * v1.1.2 contract removes both, so a real 1.0.0 install must match
 * the v100 predecessor projection exactly to be admitted.
 */
async function asLegacy1000Projection(
  repository: TestRepository,
  options: { openCodeRelativePath?: string } = {},
): Promise<void> {
  const openCodeRelativePath = options.openCodeRelativePath ?? "opencode.jsonc";
  const { predecessorProjectionV100 } = await import("../src/authority.js");
  const fs = await import("node:fs/promises");
  const manifest = await loadManifest(repository.root);
  // Read the live OpenCode config off disk so the predecessor
  // projection is keyed off the same reasoning/execution models the
  // manifest already records (testConfig() models differ slightly per
  // repo when overridden).
  const openCodePath = join(repository.root, openCodeRelativePath);
  const openCodeBytes = await fs.readFile(openCodePath, "utf8");
  const openCodeConfig = JSON.parse(openCodeBytes) as {
    agent?: Record<string, Record<string, unknown>>;
  };
  const reasoningModel = openCodeConfig.agent?.poiesis?.model as string | undefined;
  const executionModel = openCodeConfig.agent?.poiesis?.permission
    ? ((openCodeConfig.agent["poiesis-worker"]?.model as string | undefined) ?? reasoningModel)
    : undefined;
  if (reasoningModel === undefined || executionModel === undefined) {
    throw new Error("asLegacy1000Projection fixture requires a live OpenCode config with primary + worker model wiring");
  }
  const fixtureConfig = {
    schema: 1 as const,
    models: { reasoning: reasoningModel, execution: executionModel },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "github" as const, project: "owner/repo" },
    delivery: {
      preview: { adapter: "command", command: ["scripts/poiesis-preview.sh", "{sha}"] },
      staging: { adapter: "command", command: ["scripts/poiesis-staging.sh", "{sha}"] },
      production: { adapter: "command", command: ["scripts/poiesis-production.sh", "{sha}"] },
    },
    verification: { commands: ["test -f README.md"] },
  };
  const predecessor = predecessorProjectionV100(fixtureConfig, "1.0.0");
  manifest.poiesisVersion = "1.0.0";
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) => p.path.length === patch.path.length && p.path.every((s, i) => s === patch.path[i]),
    );
    if (matching === undefined) return patch;
    return { ...patch, installed: matching.value };
  });
  // Rewrite the on-disk OpenCode config so the manifest's recorded
  // configPatches match the live file (otherwise the snapshot-config-
  // patch ownership check inside the bootstrap transaction rejects with
  // `CONFIG_OWNERSHIP_LOST`). Also recompute the manifest.files[] hash
  // for that file so the file-hash verification inside the bootstrap
  // transaction passes.
  const current = JSON.parse(openCodeBytes) as Record<string, unknown>;
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
  const rewrittenOpenCodeBytes = JSON.stringify(current, null, 2) + "\n";
  await writeFile(openCodePath, rewrittenOpenCodeBytes);
  manifest.files = manifest.files.map((file) =>
    file.path === openCodeRelativePath ? { ...file, hash: hashContent(rewrittenOpenCodeBytes) } : file,
  );
  await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  const { removeOwnershipReceipt } = await import("../src/receipt.js");
  await removeOwnershipReceipt(repository.root);
}

async function stripNewGitignoreRule(repository: TestRepository): Promise<Buffer> {
  const gitignorePath = join(repository.root, ".gitignore");
  const before = await readFile(gitignorePath, "utf8");
  const stripped = before
    .split(/\r?\n/)
    .filter((line) => line.trim() !== ".poiesis/workspaces/")
    .filter((line) => !line.includes("default-path workspace area"))
    .join("\\n");
  await writeFile(gitignorePath, stripped);
  return readFile(gitignorePath);
}


async function seedDefaultSkillDirectoriesAsPreexisting(repository: TestRepository): Promise<void> {
  // Pre-create each default skill directory with a sentinel SKILL.md so
  // `installDefaultSkills` treats them as preexisting and skips the
  // network-bound `npx` install step. The transaction still calls the
  // doctor gate at the end, which is the seam the tests use to force
  // a post-write failure.
  const defaultNames = [
    "grilling",
    "grill-with-docs",
    "domain-modeling",
    "research",
    "codebase-design",
    "to-spec",
    "to-tickets",
    "code-review",
    "diagnosing-bugs",
    "test-driven-development",
    "verification-before-completion",
  ];
  const { mkdir } = await import("node:fs/promises");
  for (const name of defaultNames) {
    const dir = join(repository.root, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `# ${name}\nseeded by update-bootstrap-rollback.test\n`);
  }
}

function expectReportPasses(report: DoctorReport): void {
  for (const id of ["config", "manifest", "receipt", "hashes", "opencode-version", "models", "opencode-config", "opencode-schema", "git", "git-remote", "git-base"]) {
    expect(report.checks.find((check) => check.id === id)?.status, `expected ${id} check to pass`).toBe("pass");
  }
  for (const id of ["tracker", "delivery"]) {
    expect(report.checks.find((check) => check.id === id)?.status, `expected ${id} not to fail`).not.toBe("fail");
  }
}

describe("ordinary update rollback hardening (ticket #30)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("ordinary update rollback restores exact bytes/existence/generation/digest for every artifact on post-write doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const beforeBytes = await snapshotOwnedBytes(repository, MATERIALIZED_PATHS);
    expect(beforeBytes.receiptGeneration).not.toBeNull();
    expect(beforeBytes.receiptManifestDigest).not.toBeNull();

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(update(repository.root, {})).rejects.toMatchObject({
        code: "UPDATE_DOCTOR_FAILED",
      });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    const afterBytes = await snapshotOwnedBytes(repository, MATERIALIZED_PATHS);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
  }, 60_000);

  it("ordinary update rollback preserves foreign materialized file bytes when a concurrent writer lands after material file write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const foreignReviewerBytes = Buffer.from("# foreign reviewer\\n");

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(
          repository.root,
          {},
          {
            postMaterializedFileWrite: async (path: string) => {
              if (path === ".poiesis/roles/reviewer.md") {
                await writeFile(join(repository.root, path), foreignReviewerBytes);
              }
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis/roles/reviewer.md")), foreignReviewerBytes)).toBe(0);
  }, 60_000);

  it("ordinary update rollback derives the materialized-file written identity from hashContent(file.content) BEFORE atomicWrite (no post-write path reread)", async () => {
    // Regression for the pre-write identity contract: the rollback must
    // compare against `hashContent(file.content)` (a pure function of
    // the in-memory transaction bytes), NOT against `hashFile(destination)`
    // (which would be a post-write reread and could be corrupted by the
    // post-write foreign writer). The post-hook fires AFTER atomicWrite
    // and overwrites our bytes with foreign bytes; the rollback must see
    // current=foreign vs identity=our-bytes (precomputed) and SKIP rather
    // than restore the preimage.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await stripNewGitignoreRule(repository);

    const foreignReviewerBytes = Buffer.from("# IMMEDIATE POST-WRITE RACE foreign reviewer\n");
    const preimageReviewerBytes = await readFile(join(repository.root, ".poiesis/roles/reviewer.md"));

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(
          repository.root,
          {},
          {
            postMaterializedFileWrite: async (path: string) => {
              if (path === ".poiesis/roles/reviewer.md") {
                // The atomicWrite above just landed our bytes on disk.
                // This hook races with the rollback by overwriting those
                // bytes with foreign bytes. The rollback's identity is
                // `hashContent(file.content)` (our bytes) so the comparison
                // current=foreign vs identity=our-bytes fails and the
                // rollback MUST skip restoration.
                await writeFile(join(repository.root, path), foreignReviewerBytes);
              }
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // The foreign bytes (which match the post-hook's overwrite) must
    // survive on disk. If the production code used a post-write path
    // reread (hashFile(destination)) for the identity, the identity
    // would equal the foreign bytes' hash and the rollback would
    // restore the preimage, failing this assertion.
    const onDisk = await readFile(join(repository.root, ".poiesis/roles/reviewer.md"));
    expect(Buffer.compare(onDisk, foreignReviewerBytes), "post-write race was not preserved: identity was derived from disk instead of content").toBe(0);
    expect(Buffer.compare(onDisk, preimageReviewerBytes), "preimage bytes leaked into the post-write state").not.toBe(0);
  }, 60_000);

  it("ordinary update rollback restores a non-canonical receipt preimage byte-for-byte (different whitespace, no trailing newline)", async () => {
    // The receipt schema parser accepts any valid JSON regardless of
    // whitespace. A receipt written by an external tool (or pre-ticket
    // Poiesis) may use 4-space indent or omit the trailing newline that
    // `writeReceipt` adds. The rollback must restore the EXACT preimage
    // Buffer via atomicWrite, not re-serialize from the parsed object
    // (which would normalize whitespace and append a newline).
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await stripNewGitignoreRule(repository);

    const receiptPath = await ownershipReceiptLocation(repository.root);
    // First, read the receipt that matches the current manifest so we know
    // the correct `manifestDigest`. The schema reader accepts whitespace-
    // canonical JSON regardless of formatting.
    const originalParsed = await readOwnershipReceipt(repository.root);
    // Non-canonical receipt: 4-space indent, tab between key/colon,
    // no trailing newline, key reorder. JSON.parse tolerates all of these.
    // The `manifestDigest` MUST match the current manifest so the
    // ordinary `update` path authenticates the receipt.
    const nonCanonicalReceipt = Buffer.from(
      `{
    "schema": 1,
    "commonDir": "${originalParsed.commonDir}",
    "workspace": "${originalParsed.workspace}",
    "installationId": "${originalParsed.installationId}",
    "manifestDigest": "${originalParsed.manifestDigest}",
    "generation": ${originalParsed.generation}
}`,
      "utf8",
    );
    // Sanity: the schema reader accepts this exact preimage before
    // the transaction runs.
    await writeFile(receiptPath, nonCanonicalReceipt);
    const parsed = await readOwnershipReceipt(repository.root);
    expect(parsed.generation).toBe(originalParsed.generation);
    expect(parsed.manifestDigest).toBe(originalParsed.manifestDigest);

    // The preimage we just wrote must match `receiptSnapshot` byte-for-byte.
    const preimageSnapshot = await readFile(receiptPath);
    expect(Buffer.compare(preimageSnapshot, nonCanonicalReceipt)).toBe(0);

    // The ordinary `update` transaction advances generation, writes the
    // canonical manifest/receipt, and trips the doctor gate. The receipt
    // rollback must then restore the non-canonical preimage (the bytes
    // Poiesis did not author) byte-for-byte. We use the internal
    // `runUpdateTransaction` seam (with an empty hooks object) so the
    // production path executes with `skipSkills: undefined`, which lets
    // the doctor gate run.
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(runUpdateTransaction(repository.root, {}, {})).rejects.toMatchObject({
        code: "UPDATE_DOCTOR_FAILED",
      });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    const afterBytes = await readFile(receiptPath);
    // Byte-exact restoration: the non-canonical preimage must be
    // on disk after rollback. NOT the canonical writeReceipt
    // serialization (`${JSON.stringify(receipt, null, 2)}\n`).
    expect(Buffer.compare(afterBytes, nonCanonicalReceipt), "non-canonical receipt preimage was not restored byte-for-byte").toBe(0);
    // Sanity: the canonical serialization differs from the preimage.
    expect(Buffer.compare(afterBytes, Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`))).not.toBe(0);
  }, 60_000);

  it("ordinary update rollback preserves foreign OpenCode config bytes when a concurrent writer lands after applyOpenCodeConfig", async () => {
    // The transaction's defensive fail-closed check fires immediately
    // after the postOpenCodeApply hook and rejects any post-write foreign
    // replacement before the manifest is materialized. The error code
    // is therefore OPENCODE_CONFIG_CHANGED (not UPDATE_DOCTOR_FAILED);
    // the rollback path is exercised in the same way and still
    // preserves the foreign OpenCode bytes by hash-gating against the
    // captured callback identity.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeManifest = await readFile(manifestPath);
    const foreignOpenCodeBytes = Buffer.from('{ "default_agent": "foreign-agent" }\n');

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(
          repository.root,
          {},
          {
            postOpenCodeApply: async () => {
              await writeFile(openCodePath, foreignOpenCodeBytes);
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "OPENCODE_CONFIG_CHANGED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // Foreign OpenCode bytes survive: the transaction's hash-gate
    // compares current bytes against the callback's openCodeWrittenHash
    // and the comparison fails, so the rollback path skips the OpenCode
    // restore step entirely.
    expect(Buffer.compare(await readFile(openCodePath), foreignOpenCodeBytes)).toBe(0);
    // The manifest was never written (the transaction failed closed
    // before atomicWrite ran), so the manifest is byte-exact to the
    // preimage captured before the transaction started.
    expect(Buffer.compare(await readFile(manifestPath), beforeManifest)).toBe(0);
  }, 60_000);

  it("ordinary update rollback preserves foreign manifest bytes when a concurrent writer lands after manifest write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
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
      )}\\n`,
    );

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(
          repository.root,
          {},
          {
            postManifestWrite: async () => {
              await writeFile(manifestPath, foreignManifestBytes);
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(manifestPath), foreignManifestBytes)).toBe(0);
    const afterReceiptBytes = await readFile(receiptPath);
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).toBe(0);
    const afterReceiptParsed = JSON.parse(afterReceiptBytes.toString("utf8")) as { generation: number; manifestDigest: string };
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);
    expect(afterReceiptParsed.manifestDigest).toBe(beforeReceiptParsed.manifestDigest);
  }, 60_000);

  it("ordinary update rollback preserves foreign receipt bytes when a concurrent writer lands after receipt replace", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforeManifestBytes = await readFile(manifestPath);
    const foreignReceiptBytes = Buffer.from(
      `{"schema":1,"commonDir":"/dev/null","workspace":"/dev/null","installationId":"foreign","manifestDigest":"deadbeef","generation":9999}\\n`,
    );

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(
          repository.root,
          {},
          {
            postReceiptReplace: async () => {
              await writeFile(receiptPath, foreignReceiptBytes);
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(receiptPath), foreignReceiptBytes)).toBe(0);
    expect(Buffer.compare(await readFile(manifestPath), beforeManifestBytes)).toBe(0);
  }, 60_000);

  it("ordinary update rollback preserves foreign .gitignore bytes when a concurrent writer lands after gitignore ensure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const gitignorePath = join(repository.root, ".gitignore");
    const foreignGitignoreBytes = Buffer.from("# foreign gitignore override\\nforeign line\\n");

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(
          repository.root,
          {},
          {
            postDefaultPathGitignoreEnsure: async () => {
              await writeFile(gitignorePath, foreignGitignoreBytes);
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(gitignorePath), foreignGitignoreBytes)).toBe(0);
  }, 60_000);
});

describe("explicit 1.0.0 bootstrap rollback hardening (ticket #30)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("bootstrap rollback restores exact bytes/existence/generation=1/digest for every artifact on post-write doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000Projection(repository);
    await stripNewGitignoreRule(repository);

    const beforeBytes = await snapshotOwnedBytes(repository, MATERIALIZED_PATHS);
    expect(beforeBytes.receipt.absent).toBe(true);
    expect(beforeBytes.receiptGeneration).toBeNull();
    expect(beforeBytes.receiptManifestDigest).toBeNull();

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        update(repository.root, { bootstrapLegacyOwnership: true }),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    const afterBytes = await snapshotOwnedBytes(repository, MATERIALIZED_PATHS);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes);
    expect(afterBytes.receipt.absent).toBe(true);
    expect(afterBytes.receiptGeneration).toBeNull();
    expect(afterBytes.receiptManifestDigest).toBeNull();
  }, 60_000);

  it("bootstrap rollback preserves foreign materialized file bytes when a concurrent writer lands after material file write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000Projection(repository);
    await stripNewGitignoreRule(repository);

    const foreignReviewerBytes = Buffer.from("# foreign bootstrap reviewer\\n");

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runBootstrapLegacyOwnershipTransaction(
          repository.root,
          {},
          {
            postMaterializedFileWrite: async (path: string) => {
              if (path === ".poiesis/roles/reviewer.md") {
                await writeFile(join(repository.root, path), foreignReviewerBytes);
              }
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis/roles/reviewer.md")), foreignReviewerBytes)).toBe(0);
  }, 60_000);

  it("bootstrap rollback preserves foreign receipt bytes when a concurrent writer lands after createOwnershipReceipt", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000Projection(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforeManifestBytes = await readFile(manifestPath);
    const foreignReceiptBytes = Buffer.from(
      `{"schema":1,"commonDir":"/dev/null","workspace":"/dev/null","installationId":"foreign","manifestDigest":"deadbeef","generation":42}\\n`,
    );

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runBootstrapLegacyOwnershipTransaction(
          repository.root,
          {},
          {
            postReceiptReplace: async () => {
              await writeFile(receiptPath, foreignReceiptBytes);
            },
          } satisfies UpdateBootstrapTransactionHooks,
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    expect(Buffer.compare(await readFile(receiptPath), foreignReceiptBytes)).toBe(0);
    expect(Buffer.compare(await readFile(manifestPath), beforeManifestBytes)).toBe(0);
  }, 60_000);

  it("bootstrap happy path still installs the new rule and writes generation=1 receipt, then a follow-up ordinary update advances receipt to generation=2", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000Projection(repository);
    await stripNewGitignoreRule(repository);

    const result = await runBootstrapLegacyOwnershipTransaction(repository.root, {}, {});
    expect(result.manifest.poiesisVersion).not.toBe("1.0.0");
    const receiptAfterBootstrap = await readOwnershipReceipt(repository.root);
    expect(receiptAfterBootstrap.generation).toBe(1);

    const report = await doctor(repository.root);
    expectReportPasses(report);

    const result2 = await runUpdateTransaction(repository.root, {}, {});
    expect(result2.manifest.poiesisVersion).not.toBe("1.0.0");
    const receiptAfterUpdate = await readOwnershipReceipt(repository.root);
    expect(receiptAfterUpdate.generation).toBe(2);
    // The ordinary update advances generation even when the manifest
    // is byte-identical to the bootstrap manifest (no skills update).
    expect(receiptAfterUpdate.generation).toBe(receiptAfterBootstrap.generation + 1);
  }, 60_000);
});

describe("ticket #32 -- next-manifest OpenCode hash bound to applyOpenCodeConfig callback bytes", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("ordinary update fails closed when a concurrent writer replaces the OpenCode config between callback and manifest materialization", async () => {
    // Race the transaction between `applyOpenCodeConfig` (which calls the
    // `onWritten` callback with the exact bytes it wrote) and the
    // manifest materialization step. A concurrent writer that replaces
    // the file in this window must be detected by the defensive
    // identity check and must fail closed; the transaction must NOT
    // adopt the foreign bytes as its own identity, and the manifest
    // must NEVER be written (a brief moment of the wrong hash would be
    // a rollback hazard).
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeManifest = await readFile(manifestPath);
    const beforeOpenCode = await readFile(openCodePath);
    const foreignOpenCodeBytes = Buffer.from('{ "default_agent": "foreign-agent", "agent": {} }\n');

    await expect(
      runUpdateTransaction(
        repository.root,
        {},
        {
          postOpenCodeApply: async () => {
            // Simulate a concurrent writer that replaces the OpenCode
            // config AFTER applyOpenCodeConfig returned (and after the
            // onWritten callback fired) but BEFORE the defensive
            // identity check runs.
            await writeFile(openCodePath, foreignOpenCodeBytes);
          },
        } satisfies UpdateBootstrapTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "OPENCODE_CONFIG_CHANGED" });

    // The defensive check fires BEFORE manifest materialization, so the
    // manifest is never written. The manifest on disk must therefore
    // remain byte-exact to the preimage captured before the transaction
    // started. A production code path that re-reads the file to derive
    // the next manifest's OpenCode hash would have written the manifest
    // with the foreign bytes' hash first, and the rollback would have
    // had to restore it; here the manifest never moves.
    const afterManifest = await readFile(manifestPath);
    expect(Buffer.compare(afterManifest, beforeManifest), "manifest was written before the fail-closed check").toBe(0);
    // The pre-opencode write was the legitimate transaction-owned bytes;
    // the foreign write is preserved untouched by the rollback because
    // the hash-gate compares current bytes against the callback's
    // openCodeWrittenHash and the comparison fails.
    expect(Buffer.compare(await readFile(openCodePath), foreignOpenCodeBytes), "foreign opencode bytes were overwritten by the rollback").toBe(0);
    expect(Buffer.compare(await readFile(openCodePath), beforeOpenCode), "foreign opencode bytes were overwritten by the rollback").not.toBe(0);
  }, 60_000);

  it("ordinary update records the EXACT applyOpenCodeConfig callback bytes in the next manifest's OpenCode file hash (no race, no-interference happy path)", async () => {
    // No concurrent writer replaces the OpenCode config between the
    // callback and manifest materialization. The next manifest's
    // OpenCode file hash MUST equal the hash of the file's current
    // bytes (which are the transaction's own callback bytes) and NOT
    // the pre-write file's bytes (a mis-binding bug that would cause
    // the doctor hash check to fail immediately after the update).
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const openCodePath = join(repository.root, "opencode.jsonc");
    const result = await runUpdateTransaction(repository.root, {}, {});

    const openCodeRecord = result.manifest.files.find((file) => file.path === "opencode.jsonc");
    expect(openCodeRecord, "manifest records the OpenCode config").toBeDefined();
    const currentOpenCodeBytes = await readFile(openCodePath);
    expect(
      openCodeRecord!.hash,
      "manifest OpenCode hash equals the on-disk hash (callback bytes are exactly the bytes on disk)",
    ).toBe(hashContent(currentOpenCodeBytes));
    // Doctor must pass: this proves the hash binding is consistent
    // with the actual file state, not just internally self-consistent.
    expect(result.doctor.ok, "doctor must pass after a no-interference update").toBe(true);
  }, 60_000);

  it("bootstrap fails closed when a concurrent writer replaces the OpenCode config between callback and manifest materialization", async () => {
    // Bootstrap parity with the ordinary update race test: a concurrent
    // OpenCode replacement between the applyOpenCodeConfig callback and
    // manifest materialization must fail closed with
    // OPENCODE_CONFIG_CHANGED. The manifest must NEVER be written with
    // the foreign bytes' hash; the foreign write survives untouched.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000Projection(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeManifest = await readFile(manifestPath);
    const foreignOpenCodeBytes = Buffer.from('{ "default_agent": "foreign-agent", "agent": {} }\n');

    await expect(
      runBootstrapLegacyOwnershipTransaction(
        repository.root,
        {},
        {
          postOpenCodeApply: async () => {
            await writeFile(openCodePath, foreignOpenCodeBytes);
          },
        } satisfies UpdateBootstrapTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "OPENCODE_CONFIG_CHANGED" });

    const afterManifest = await readFile(manifestPath);
    expect(Buffer.compare(afterManifest, beforeManifest), "bootstrap manifest was written before the fail-closed check").toBe(0);
    expect(Buffer.compare(await readFile(openCodePath), foreignOpenCodeBytes), "foreign opencode bytes were overwritten by the bootstrap rollback").toBe(0);
    // Bootstrap has no receipt at the start and the transaction never
    // reached createOwnershipReceipt; the receipt therefore remains
    // absent and the legacy 1.0.0 manifest survives unchanged.
    const { ownershipReceiptExists } = await import("../src/receipt.js");
    expect(await ownershipReceiptExists(repository.root), "bootstrap receipt must remain absent after a fail-closed race").toBe(false);
  }, 60_000);

  it("bootstrap records the EXACT applyOpenCodeConfig callback bytes in the next manifest's OpenCode file hash (no race, no-interference happy path)", async () => {
    // Bootstrap parity with the ordinary update no-interference test:
    // the next manifest's OpenCode file hash MUST equal the hash of
    // the file's current bytes (the transaction's own callback bytes).
    // Doctor must pass to prove the binding is consistent with reality.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000Projection(repository);
    await stripNewGitignoreRule(repository);

    const openCodePath = join(repository.root, "opencode.jsonc");
    const result = await runBootstrapLegacyOwnershipTransaction(repository.root, {}, {});

    const openCodeRecord = result.manifest.files.find((file) => file.path === "opencode.jsonc");
    expect(openCodeRecord, "bootstrap manifest records the OpenCode config").toBeDefined();
    const currentOpenCodeBytes = await readFile(openCodePath);
    expect(
      openCodeRecord!.hash,
      "bootstrap manifest OpenCode hash equals the on-disk hash",
    ).toBe(hashContent(currentOpenCodeBytes));
    expect(result.doctor.ok, "doctor must pass after a no-interference bootstrap").toBe(true);
    // Generation 1 receipt is created and bound to the new manifest digest.
    const receipt = await readOwnershipReceipt(repository.root);
    expect(receipt.generation).toBe(1);
    expect(receipt.manifestDigest).toBe(hashContent(serializeManifest(result.manifest)));
  }, 60_000);

  it("ordinary update rollback restores the EXACT preimage OpenCode config on a post-write doctor failure with no foreign writer", async () => {
    // Defends the symmetric case of the rollback contract: when no
    // concurrent writer races the transaction, the on-disk OpenCode
    // config still matches the callback's openCodeWrittenHash at
    // rollback time. The rollback must therefore restore the EXACT
    // preimage bytes (byte-for-byte, no newline normalization) instead
    // of leaving the transaction-owned post-write bytes in place. The
    // post-write foreign replacement case is covered separately by the
    // fail-closed test above; this test pins down the no-interference
    // doctor-failure rollback path.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeOpenCode = await readFile(openCodePath);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(runUpdateTransaction(repository.root, {}, {})).rejects.toMatchObject({
        code: "UPDATE_DOCTOR_FAILED",
      });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // No concurrent writer races the rollback, so the on-disk bytes
    // still match the transaction's openCodeWrittenHash and the
    // rollback restores the EXACT preimage (byte-for-byte, no
    // newline normalization).
    const afterOpenCode = await readFile(openCodePath);
    expect(Buffer.compare(afterOpenCode, beforeOpenCode), "opencode preimage was not restored byte-for-byte").toBe(0);
  }, 60_000);
});

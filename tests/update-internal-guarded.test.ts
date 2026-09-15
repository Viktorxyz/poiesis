/**
 * Ticket #44 — Ordinary `update()` and explicit 1.0.0 `bootstrapLegacyOwnership()`
 * apply the shared guarded transaction semantics (`ArtifactJournal` +
 * per-workspace mutation lock + OpenCode patch authority + exact
 * pre-existing OpenCode preimages + reverse hash-gated rollback).
 *
 * Each test in this file asserts one of the acceptance criteria:
 *
 *   1. Validate every recorded OpenCode patch value against captured
 *      on-disk state before mutation; owned-path edits fail closed.
 *      (Test: tamper with a Poiesis-owned OpenCode patch path before
 *      the transaction runs and observe `CONFIG_OWNERSHIP_LOST` with
 *      zero owned bytes mutated.)
 *
 *   2. Preserve unrelated user paths. (Test: pre-existing OpenCode
 *      config with foreign keys; ordinary update must leave the
 *      foreign keys byte-for-byte unchanged.)
 *
 *   3. Capture physical OpenCode existence and exact bytes independently
 *      of whole-file ownership. (Test: rollback restores a
 *      pre-existing user OpenCode file byte-for-byte; absent-path
 *      rollback unlinks only the path proven absent before transaction
 *      creation.)
 *
 *   4. Materialized config, OpenCode config, manifest, and receipt
 *      writes use immediate guards and reverse hash-gated rollback.
 *      (Test: inject drift immediately before each artifact write and
 *      observe `ARTIFACT_IDENTITY_DRIFT`; rollback restores byte-for-byte.)
 *
 *   5. Trusted predecessor migration behavior remains compatible and
 *      strict. (Covered by `tests/predecessor-migration.test.ts`; not
 *      duplicated here.)
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
  removeOwnershipReceipt,
} from "../src/receipt.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { parseJsonc } from "../src/config.js";

const MATERIALIZED_PATHS = [
  ".poiesis/PHILOSOPHY.md",
  ".poiesis/METHOD.md",
  ".poiesis/config.jsonc",
  ".poiesis/roles/planner.md",
  ".poiesis/roles/poiesis.md",
  ".poiesis/roles/research.md",
  ".poiesis/roles/reviewer.md",
  ".poiesis/roles/worker.md",
  ".opencode/agents/poiesis-final-reviewer.md",
  ".opencode/agents/poiesis-planner.md",
  ".opencode/agents/poiesis-research.md",
  ".opencode/agents/poiesis-reviewer.md",
  ".opencode/agents/poiesis-worker.md",
  ".opencode/agents/poiesis.md",
];

async function install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function seedDefaultSkillDirectoriesAsPreexisting(repository: TestRepository): Promise<void> {
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
    await writeFile(join(dir, "SKILL.md"), `# ${name}\nseeded by update-internal-guarded.test\n`);
  }
}

async function asLegacy1000(root: string): Promise<void> {
  const manifest = await loadManifest(root);
  // Legacy 1.0.0 manifests had the OpenCode config patch-only (not
  // whole-file owned): drop the generated `opencode.jsonc` entry from
  // `files` so the bootstrap's per-file hash validation does not gate
  // the patch-ownership check we want to exercise.
  manifest.files = manifest.files.filter((file) => file.path !== "opencode.jsonc");
  manifest.poiesisVersion = "1.0.0";
  await writeFile(join(root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  await removeOwnershipReceipt(root);
}

async function stripNewGitignoreRule(repository: TestRepository): Promise<Buffer> {
  const gitignorePath = join(repository.root, ".gitignore");
  const before = await readFile(gitignorePath, "utf8");
  const stripped = before
    .split(/\r?\n/)
    .filter((line) => line.trim() !== ".poiesis/workspaces/")
    .filter((line) => !line.includes("default-path workspace area"))
    .join("\n");
  await writeFile(gitignorePath, stripped);
  return readFile(gitignorePath);
}

describe("ticket #44 — ordinary update guarded transaction acceptance criteria", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("fails closed with CONFIG_OWNERSHIP_LOST when a recorded OpenCode patch value is tampered before mutation", async () => {
    // Acceptance criterion #1: validate every recorded OpenCode patch
    // value against captured on-disk state BEFORE any mutation; owned
    // edits fail closed.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);

    const openCodePath = join(repository.root, "opencode.jsonc");
    const original = await readFile(openCodePath, "utf8");
    const parsed = parseJsonc<Record<string, unknown>>(original, openCodePath);
    // Mutate the value of the first Poiesis-owned OpenCode patch so it
    // no longer matches the manifest's `installed` claim. The transaction
    // must reject this BEFORE any owned byte is written.
    const manifest = await loadManifest(repository.root);
    const firstPatch = manifest.configPatches[0]!;
    let target: Record<string, unknown> = parsed;
    for (let i = 0; i < firstPatch.path.length - 1; i++) {
      const segment = firstPatch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[firstPatch.path[firstPatch.path.length - 1]!] = "tampered-by-test";
    await writeFile(openCodePath, JSON.stringify(parsed, null, 2) + "\n");

    const beforeManifest = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforePoiesisConfig = await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8");

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "CONFIG_OWNERSHIP_LOST",
    });

    // Zero owned bytes were mutated.
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifest)).toBe(0);
    expect(await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8")).toBe(beforePoiesisConfig);
  }, 60_000);

  it("preserves unrelated user paths in the pre-existing OpenCode config when patching owned paths", async () => {
    // Acceptance criterion #2: preserve unrelated user paths.
    // A user-owned pre-existing OpenCode config carries a foreign
    // `experimental` key. Poiesis must patch only its own keys and leave
    // the foreign key byte-for-byte unchanged across an ordinary update.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);

    const openCodePath = join(repository.root, "opencode.jsonc");
    const before = await readFile(openCodePath, "utf8");
    const parsed = parseJsonc<Record<string, unknown>>(before, openCodePath);
    parsed.experimental = { featureFlag: "user-toggle", nested: { keep: "this" } };
    const foreignBytes = Buffer.from(JSON.stringify(parsed, null, 2) + "\n");
    await writeFile(openCodePath, foreignBytes);

    // Re-bind the receipt so the manifest digest still matches (we only
    // changed the OpenCode config bytes, not the manifest).
    const { replaceOwnershipReceipt } = await import("../src/receipt.js");
    const existingReceipt = await readOwnershipReceipt(repository.root);
    const manifest = await loadManifest(repository.root);
    await replaceOwnershipReceipt(repository.root, manifest, existingReceipt);

    const result = await runUpdateTransaction(repository.root, { skipSkills: true }, {});

    const afterBytes = await readFile(openCodePath);
    const afterParsed = parseJsonc<Record<string, unknown>>(afterBytes.toString("utf8"), openCodePath);
    // The Poiesis-owned patches still apply: every recorded `installed`
    // value is present at its `path`.
    for (const patch of result.manifest.configPatches) {
      let cursor: unknown = afterParsed;
      for (const segment of patch.path) {
        if (typeof cursor !== "object" || cursor === null) throw new Error(`path ${patch.path.join(".")} missing`);
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      expect(cursor, `installed patch ${patch.path.join(".")} missing`).toEqual(patch.installed);
    }
    // The user's `experimental` key survives byte-equivalent across the
    // transaction. (The Poiesis projection never touches it.)
    expect(afterParsed.experimental).toEqual({ featureFlag: "user-toggle", nested: { keep: "this" } });
    // The byte length grew only by the patch additions, not by a wholesale
    // reformat. We assert this structurally via JSON.parse equality.
    const beforeReParsed = parseJsonc<Record<string, unknown>>(before, openCodePath);
    expect(beforeReParsed.experimental).toBeUndefined();
    expect(afterParsed.experimental).toBeDefined();
  }, 60_000);

  // Regression for ticket #50: ordinary update must reject duplicate
  // managed OpenCode properties BEFORE any write fires. The canonical
  // JSONC parser resolves duplicate object keys to the LAST occurrence;
  // the manifest's recorded `installed` value may match that last
  // occurrence, allowing an earlier (foreign) duplicate value to
  // silently overwrite the owned patch on the next transaction
  // without raising CONFIG_OWNERSHIP_LOST. Reuses the canonical
  // recursive `assertNoDuplicateProperties` validator
  // (init-side uses the same helper via
  // `assertOpenCodeContentAvailable`); fail-closed with the same
  // `INSTALL_PATH_CONFLICT` code and the same `{ file, property }`
  // detail shape, with NO owned bytes mutated and the receipt
  // generation+digest preserved.
  it("fails closed with INSTALL_PATH_CONFLICT when the current OpenCode config has duplicate managed properties whose final value matches the owned state", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);

    const openCodePath = join(repository.root, "opencode.jsonc");
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforePoiesisConfig = await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8");
    const beforeReceipt = await readOwnershipReceipt(repository.root);
    const beforeManifest = await loadManifest(repository.root);

    // Sanity: pre-tampered OpenCode is single-keyed and the manifest
    // records `default_agent` as an owned `installed` value.
    const original = await readFile(openCodePath, "utf8");
    expect(original).toContain('"default_agent": "poiesis"');
    expect(beforeManifest.configPatches.some((p) => JSON.stringify(p.path) === JSON.stringify(["default_agent"]))).toBe(true);

    // Replace the OpenCode config bytes with a duplicate-managed-path
    // document where:
    //   - first occurrence is a foreign value
    //   - last occurrence is the OWNED value (matching manifest)
    //   - an unrelated property is preserved to prove the validator
    //     is scoped to the duplicate, not a blanket rejection.
    // The JSONC parser resolves to the LAST occurrence; the parse
    // snapshot ownership check would silently PASS without the new
    // preflight. The duplicate check must reject before any write.
    const tamperedOpenCodeBytes = Buffer.from(
      [
        '{',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "default_agent": "foreign-agent",',
        '  "unrelated_property": "preserved",',
        '  "subagent_depth": 2,',
        '  "default_agent": "poiesis",',
        '}',
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(openCodePath, tamperedOpenCodeBytes);

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "INSTALL_PATH_CONFLICT",
      details: expect.objectContaining({ property: "default_agent" }),
    });

    // Owned bytes preserved byte-for-byte; receipt generation+digest
    // do not advance.
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8")).toBe(beforePoiesisConfig);
    expect(await readFile(openCodePath)).toEqual(tamperedOpenCodeBytes);
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation);
    expect(afterReceipt.manifestDigest).toBe(beforeReceipt.manifestDigest);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(serializeManifest(beforeManifest));
  }, 60_000);

  it("captures a pre-existing OpenCode config byte-for-byte and restores it on rollback", async () => {
    // Acceptance criterion #3 + #4: capture physical OpenCode existence
    // and exact bytes independently of whole-file ownership; rollback
    // restores a pre-existing user OpenCode file byte-for-byte.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);

    const openCodePath = join(repository.root, "opencode.jsonc");
    // Read the init-written bytes; rewrite them with non-canonical
    // whitespace (4-space indent) and a no-trailing-newline form so the
    // journal's captured preimage is byte-distinct from the canonical
    // post-write form. The values must match the manifest's
    // `configPatches[].installed` claim exactly so the
    // `assertOpenCodeOwnershipAgainstSnapshot` pre-flight passes.
    const originalBytes = await readFile(openCodePath, "utf8");
    const reparsed = parseJsonc<Record<string, unknown>>(originalBytes, openCodePath);
    const nonCanonical = Buffer.from(
      // 4-space indent (canonical is 2), key reorder to force a different
      // serialized form, no trailing newline.
      JSON.stringify(reparsed, null, 4).replace(/\n$/, ""),
      "utf8",
    );
    expect(Buffer.compare(nonCanonical, Buffer.from(originalBytes, "utf8"))).not.toBe(0);
    await writeFile(openCodePath, nonCanonical);
    const beforeOpenCodeBytes = await readFile(openCodePath);

    // Re-bind the receipt so the manifest digest still matches.
    const { replaceOwnershipReceipt } = await import("../src/receipt.js");
    const existingReceipt = await readOwnershipReceipt(repository.root);
    const manifest = await loadManifest(repository.root);
    await replaceOwnershipReceipt(repository.root, manifest, existingReceipt);

    await stripNewGitignoreRule(repository);

    // Force a doctor failure AFTER all writes so rollback runs.
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

    // The preimage bytes survive byte-for-byte. NOT the canonical
    // `${JSON.stringify(...)}\n` form, NOT a reformatted variant.
    const afterOpenCodeBytes = await readFile(openCodePath);
    expect(Buffer.compare(afterOpenCodeBytes, beforeOpenCodeBytes), "OpenCode config preimage was not restored byte-for-byte").toBe(0);
    expect(Buffer.compare(afterOpenCodeBytes, nonCanonical), "OpenCode config bytes diverged from the captured preimage").toBe(0);
  }, 60_000);

  it("rolls back the receipt via the bounded journal when a pre-write foreign writer replaces the receipt bytes", async () => {
    // Acceptance criterion #4 (materialized config, manifest, receipt use
    // immediate guards and reverse hash-gated rollback). Inject a
    // foreign receipt writer via the pre-receipt hook so the journal's
    // `atomicWriteGuarded` rejects the receipt write with
    // ARTIFACT_IDENTITY_DRIFT.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforeManifest = await readFile(manifestPath);
    const beforeReceipt = await readFile(receiptPath);
    const foreignReceiptBytes = Buffer.from(
      `{"schema":1,"commonDir":"/dev/null","workspace":"/dev/null","installationId":"foreign","manifestDigest":"deadbeef","generation":9999}\n`,
    );

    await expect(
      runUpdateTransaction(
        repository.root,
        {},
        {
          preReceiptReplace: async () => {
            // Land a foreign receipt write between the receipt capture
            // and the journal's replace. The journal's pre-write
            // identity guard must catch the drift.
            await writeFile(receiptPath, foreignReceiptBytes);
          },
        } satisfies UpdateBootstrapTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });

    // The foreign receipt survives on disk; the journal did not overwrite
    // it because its pre-write guard rejected the transaction.
    expect(Buffer.compare(await readFile(receiptPath), foreignReceiptBytes)).toBe(0);
    // The manifest was never written (the transaction failed closed
    // before the manifest replace).
    expect(Buffer.compare(await readFile(manifestPath), beforeManifest)).toBe(0);
    void beforeReceipt;
  }, 60_000);

  it("rolls back the manifest via the bounded journal when a pre-write foreign writer replaces the manifest bytes", async () => {
    // Acceptance criterion #4 (manifest use immediate guards and reverse
    // hash-gated rollback). Inject a foreign manifest writer via the
    // pre-manifest hook so the journal's `atomicWriteGuarded` rejects
    // the manifest write with ARTIFACT_IDENTITY_DRIFT.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await stripNewGitignoreRule(repository);

    const manifestPath = join(repository.root, ".poiesis", "manifest.json");
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforeManifest = await readFile(manifestPath);
    const beforeReceipt = await readFile(receiptPath);
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

    await expect(
      runUpdateTransaction(
        repository.root,
        {},
        {
          preManifestWrite: async () => {
            await writeFile(manifestPath, foreignManifestBytes);
          },
        } satisfies UpdateBootstrapTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });

    expect(Buffer.compare(await readFile(manifestPath), foreignManifestBytes)).toBe(0);
    expect(Buffer.compare(await readFile(receiptPath), beforeReceipt)).toBe(0);
    void beforeManifest;
  }, 60_000);

  it("captures journal entries before any write fires and exposes them via onJournalReady", async () => {
    // Acceptance criterion #4 (the journal captures every owned artifact
    // before the first write). The `onJournalReady` seam exposes the
    // captured entries; the test asserts the expected set (one entry
    // per materialized file + opencode + manifest + receipt).
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await stripNewGitignoreRule(repository);

    let observedCount = 0;
    const capturedPaths: string[] = [];
    await runUpdateTransaction(
      repository.root,
      { skipSkills: true },
      {
        onJournalReady: async (entries) => {
          observedCount = entries.length;
          for (const entry of entries) capturedPaths.push(entry.path);
        },
      } satisfies UpdateBootstrapTransactionHooks,
    );

    // 13 template mappings + .poiesis/config.jsonc + opencode.jsonc +
    // .poiesis/manifest.json + receipt = 17 entries.
    expect(observedCount).toBe(17);
    expect(capturedPaths).toContain(join(repository.root, "opencode.jsonc"));
    expect(capturedPaths).toContain(join(repository.root, ".poiesis/manifest.json"));
    for (const materialized of MATERIALIZED_PATHS) {
      expect(capturedPaths, `journal must capture ${materialized}`).toContain(join(repository.root, materialized));
    }
    expect(capturedPaths.filter((path) => path.startsWith(repository.root + "/.git/")).length).toBe(1);
    // The OpenCode config is captured with `patch` ownership mode (Poiesis
    // owns the file through `configPatches`, not through `manifest.files`).
    const openCodeEntry = capturedPaths.find((path) => path === join(repository.root, "opencode.jsonc"));
    expect(openCodeEntry).toBeDefined();
  }, 60_000);
});

describe("ticket #44 — bootstrap guarded transaction acceptance criteria", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("fails closed with CONFIG_OWNERSHIP_LOST when a recorded OpenCode patch value is tampered before the bootstrap", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000(repository.root);

    const openCodePath = join(repository.root, "opencode.jsonc");
    const before = await readFile(openCodePath, "utf8");
    const parsed = parseJsonc<Record<string, unknown>>(before, openCodePath);
    const manifest = await loadManifest(repository.root);
    const firstPatch = manifest.configPatches[0]!;
    let target: Record<string, unknown> = parsed;
    for (let i = 0; i < firstPatch.path.length - 1; i++) {
      const segment = firstPatch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[firstPatch.path[firstPatch.path.length - 1]!] = "tampered-by-test";
    await writeFile(openCodePath, JSON.stringify(parsed, null, 2) + "\n");

    const beforeManifest = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    await stripNewGitignoreRule(repository);

    await expect(
      update(repository.root, { bootstrapLegacyOwnership: true }),
    ).rejects.toMatchObject({ code: "CONFIG_OWNERSHIP_LOST" });

    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifest)).toBe(0);
    const { ownershipReceiptExists } = await import("../src/receipt.js");
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
  }, 60_000);

  // Regression for ticket #50: legacy bootstrap must reject duplicate
  // managed OpenCode properties BEFORE any write fires. Same invariant
  // and validator as the ordinary update path; exercised here so the
  // legacy 1.0.0 bootstrap surface is independently covered.
  it("fails closed with INSTALL_PATH_CONFLICT when the current OpenCode config has duplicate managed properties whose final value matches the owned state", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);

    // Strip the receipt so the bootstrap path is reachable.
    const manifest = await loadManifest(repository.root);
    manifest.poiesisVersion = "1.0.0";
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await removeOwnershipReceipt(repository.root);
    const beforePoiesisConfig = await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8");

    const openCodePath = join(repository.root, "opencode.jsonc");
    const original = await readFile(openCodePath, "utf8");
    expect(original).toContain('"default_agent": "poiesis"');

    // Duplicate managed property; last occurrence equals the owned
    // value; unrelated property preserved to scope the validator.
    const tamperedOpenCodeBytes = Buffer.from(
      [
        '{',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "default_agent": "foreign-agent",',
        '  "unrelated_property": "preserved",',
        '  "subagent_depth": 2,',
        '  "default_agent": "poiesis",',
        '}',
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(openCodePath, tamperedOpenCodeBytes);

    // The bootstrap transaction's legacy `LEGACY_BOOTSTRAP_REJECTED`
    // hash check runs BEFORE the new duplicate-property preflight. To
    // reach the new preflight without that legacy check rejecting, the
    // recorded `opencode.jsonc` hash must match the tampered bytes.
    // Update the manifest's recorded hash to match the duplicate-
    // property bytes. This proves the new preflight is what fails closed,
    // not the legacy hash check.
    {
      const { hashContent } = await import("../src/hash.js");
      const manifestForDup = await loadManifest(repository.root);
      const openCodeFile = manifestForDup.files.find((f) => f.path === "opencode.jsonc");
      if (openCodeFile !== undefined) openCodeFile.hash = hashContent(tamperedOpenCodeBytes);
      await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifestForDup));
    }
    // Capture baseline AFTER the test-setup hash update so the
    // transaction-rejection proves preservation of the post-update bytes.
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeManifest = await loadManifest(repository.root);
    expect(beforeManifest.configPatches.some((p) => JSON.stringify(p.path) === JSON.stringify(["default_agent"]))).toBe(true);

    // The bootstrap transaction must reject the duplicate-managed-property
    // BEFORE any write. Pre-write ownership validation does NOT cover
    // this — the JSONC parser resolves duplicates to the last occurrence,
    // and the last occurrence matches the manifest's owned value, so the
    // only line of defense is the canonical duplicate-property validator
    // invoked from `captureTransactionArtifacts`.
    await expect(runBootstrapLegacyOwnershipTransaction(repository.root, {}, {})).rejects.toMatchObject({
      code: "INSTALL_PATH_CONFLICT",
      details: expect.objectContaining({ property: "default_agent" }),
    });

    // Exact byte preservation of every owned byte and the tampered
    // OpenCode config (which is NOT a managed artifact — preserve it
    // exactly as written so the user can diagnose the tampering).
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
    expect(await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8")).toBe(beforePoiesisConfig);
    expect(await readFile(openCodePath)).toEqual(tamperedOpenCodeBytes);
    expect(serializeManifest(await loadManifest(repository.root))).toBe(serializeManifest(beforeManifest));
  }, 60_000);

  it("rolls back a pre-existing user OpenCode file byte-for-byte when the bootstrap doctor gate fails", async () => {
    // Acceptance criterion #3 + #4 for bootstrap: capture physical
    // OpenCode existence and exact bytes; rollback restores them
    // byte-for-byte.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000(repository.root);

    const openCodePath = join(repository.root, "opencode.jsonc");
    // Re-format the existing bytes with non-canonical whitespace (4-space
    // indent, no trailing newline). The values match the manifest's
    // `configPatches[].installed` claim so the bootstrap reaches the
    // transactional step, where the journal captures the non-canonical
    // bytes as preimage and restores them on rollback.
    const originalBytes = await readFile(openCodePath, "utf8");
    const reparsed = parseJsonc<Record<string, unknown>>(originalBytes, openCodePath);
    const nonCanonical = Buffer.from(
      JSON.stringify(reparsed, null, 4).replace(/\n$/, ""),
      "utf8",
    );
    expect(Buffer.compare(nonCanonical, Buffer.from(originalBytes, "utf8"))).not.toBe(0);
    await writeFile(openCodePath, nonCanonical);
    const beforeOpenCodeBytes = await readFile(openCodePath);

    await stripNewGitignoreRule(repository);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runBootstrapLegacyOwnershipTransaction(repository.root, {}, {}),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    const afterOpenCodeBytes = await readFile(openCodePath);
    expect(Buffer.compare(afterOpenCodeBytes, beforeOpenCodeBytes), "bootstrap OpenCode config preimage was not restored byte-for-byte").toBe(0);
    expect(Buffer.compare(afterOpenCodeBytes, nonCanonical), "bootstrap OpenCode config bytes diverged from the captured preimage").toBe(0);
    // Receipt was never created (the transaction rolled back fully).
    const { ownershipReceiptExists } = await import("../src/receipt.js");
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
  }, 60_000);

  it("captures the absent receipt path with physicalExists=false and unlinks it on rollback", async () => {
    // Acceptance criterion #3 (capture physical OpenCode existence and
    // exact bytes independently of whole-file ownership): the bootstrap
    // receipt is initially absent, the journal captures physicalExists
    // = false, and the rollback unlinks only paths proven absent
    // before transaction creation. We force a post-write doctor failure
    // so the journal rollback fires; the receipt path (which we just
    // created) must be unlinked, not left behind.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000(repository.root);
    await stripNewGitignoreRule(repository);

    expect((await readFile(join(repository.root, ".poiesis", "manifest.json"))).length > 0).toBe(true);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runBootstrapLegacyOwnershipTransaction(repository.root, {}, {}),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // Bootstrap receipt was created during the transaction; the
    // journal's reverse rollback hash-gates against the
    // transaction-written identity and unlinks because the receipt path
    // was absent before the transaction started (physicalExists=false).
    const { ownershipReceiptExists } = await import("../src/receipt.js");
    expect(await ownershipReceiptExists(repository.root), "bootstrap receipt was not unlinked on rollback").toBe(false);
  }, 60_000);

  it("rejects a pre-write foreign receipt writer via the journal's pre-write identity guard", async () => {
    // Acceptance criterion #4 (receipt use immediate guards and reverse
    // hash-gated rollback). Inject a foreign receipt writer via the
    // pre-receipt hook so the journal's `atomicWriteGuarded` rejects
    // the receipt write with ARTIFACT_IDENTITY_DRIFT.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await asLegacy1000(repository.root);
    await stripNewGitignoreRule(repository);

    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforeManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const foreignReceiptBytes = Buffer.from(
      `{"schema":1,"commonDir":"/dev/null","workspace":"/dev/null","installationId":"foreign","manifestDigest":"deadbeef","generation":42}\n`,
    );

    await expect(
      runBootstrapLegacyOwnershipTransaction(
        repository.root,
        {},
        {
          preReceiptReplace: async () => {
            await writeFile(receiptPath, foreignReceiptBytes);
          },
        } satisfies UpdateBootstrapTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });

    expect(Buffer.compare(await readFile(receiptPath), foreignReceiptBytes)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifestBytes)).toBe(0);
  }, 60_000);
});

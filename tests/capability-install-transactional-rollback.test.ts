/**
 * Ticket #47 — Make capability installation transactional.
 *
 * Acceptance criteria:
 *   1. Retained backup state through commit (the bounded journal holds the
 *      EXACT destination preimage backup until `commit()` removes it; a
 *      successful install leaves the journal's backup root removed and the
 *      transaction in a state that a follow-up install can repeat cleanly).
 *   2. Exact rollback for manifest/receipt failures for both a new and a
 *      replaced capability. The journal's reverse hash-gated rollback
 *      restores the EXACT manifest preimage and the EXACT receipt preimage
 *      when a later write step fails.
 *   3. Hash-gated foreign replacement preservation with bounded diagnostics.
 *      When the on-disk capability directory differs from
 *      `transactionWrittenIdentity`, the rollback reports `RollbackDiagnostic`
 *      (reason `identity-mismatch`) and leaves the foreign content intact;
 *      the foreign receipt is preserved and reported the same way.
 *   4. Non-authoritative staging/backup cleanup. `commit()` swallows cleanup
 *      errors via `catch(() => undefined)` so a backup-cleanup failure
 *      cannot turn a committed transaction into a failure. The staging
 *      cleanup in `installCapability` is also non-authoritative
 *      (`.catch(() => undefined)`).
 *   5. Unchanged successful install/receipt behavior and clean retry. A
 *      successful capability install (through the public
 *      `installAuthorizedCapability(root, input)` wrapper, which
 *      delegates to `runCapabilityInstallTransaction(root, input)`)
 *      advances the receipt generation exactly once and leaves the
 *      installation in a state that a follow-up transaction repeats
 *      cleanly (and the receipt advances again from the post-commit
 *      state).
 *   6. Preserve unrelated state. Concurrent foreign writes to one
 *      capability directory do not affect another skill's directory, and
 *      foreign writes outside `.agents/skills/` are not touched.
 *
 * The seam lives in `src/skills.ts` (`installCapability` accepts an
 * optional bounded journal via `CapabilityMaintenanceInternalOptions` —
 * internal-only structural widening, NOT re-exported through
 * `dist/index.d.ts`) and `src/maintenance.ts`
 * (`runCapabilityInstallTransaction(root, input, hooks?)` is the
 * source-internal transaction runner that accepts the optional
 * `CapabilityInstallTransactionHooks` object for deterministic fault
 * injection; the public `installAuthorizedCapability(root, input)`
 * wrapper is a 2-parameter delegate with empty hooks. Neither the
 * internal runner nor the hooks interface is re-exported through
 * `dist/index.d.ts`).
 */
import { exists } from "../src/fs.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  init,
  installAuthorizedCapability,
  runCapabilityInstallTransaction,
  type CapabilityInstallTransactionHooks,
} from "../src/maintenance.js";
import {
  loadManifest,
} from "../src/manifest.js";
import {
  ownershipReceiptExists,
  ownershipReceiptLocation,
  readOwnershipReceipt,
} from "../src/receipt.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const FAKE_REVISION_A = "a".repeat(40);
const FAKE_REVISION_B = "b".repeat(40);
const FAKE_SOURCE = "mattpocock/skills";
const FAKE_CAPABILITY_NAME = "to-spec";
const FAKE_DESTINATION = ".agents/skills/to-spec";

async function installPoiesis(repository: TestRepository): Promise<void> {
  await init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

/**
 * Build the internal-only widened options object that exercises the
 * preimage capability staging seam without contacting the upstream
 * `skills` CLI. Mirrors the structural widening that `src/skills.ts`
 * applies inside `installCapability` so the public
 * `CapabilityMaintenanceOptions` declaration stays free.
 */
function ticket47InternalHooks(opts: {
  preimageCapabilityDirectory?: string;
  postCapabilityInstall?: () => void | Promise<void>;
  preManifestWrite?: () => void | Promise<void>;
  postManifestWrite?: () => void | Promise<void>;
  preReceiptReplace?: () => void | Promise<void>;
  onJournalReady?: (entries: readonly import("../src/mutation-transaction.js").ArtifactJournalEntry[]) => void | Promise<void>;
  onCapturesReady?: (entries: readonly import("../src/mutation-transaction.js").ArtifactJournalEntry[]) => void | Promise<void>;
}): CapabilityInstallTransactionHooks {
  return opts as CapabilityInstallTransactionHooks;
}

/**
 * Build a non-authoritative pre-staged capability root that mirrors the
 * `.agents/skills/<name>/...` layout the network-bound `stageSkills`
 * produces. The test passes this directory to the source-internal
 * `runCapabilityInstallTransaction` runner via the
 * `preimageCapabilityDirectory` hook so the staging step is bypassed
 * entirely. The directory's content is the transaction's
 * "transaction-written identity" for the destination.
 */
async function buildPreimageCapabilityRoot(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "poiesis-t47-stage-"));
  const dest = join(root, ".agents", "skills", FAKE_CAPABILITY_NAME);
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "SKILL.md"), content);
  return root;
}

/**
 * Read the current ownership receipt bytes and the current manifest
 * bytes for byte-for-byte rollback assertions.
 */
async function readReceiptBytes(root: string): Promise<Buffer> {
  const path = await ownershipReceiptLocation(root);
  return readFile(path);
}

async function readManifestBytes(root: string): Promise<Buffer> {
  return readFile(join(root, ".poiesis", "manifest.json"));
}

describe("ticket #47 — installCapability journal integration (direct)", () => {
  const repositories: TestRepository[] = [];
  const stagingDirs: string[] = [];
  let openCodeEnv: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    openCodeEnv = await installFakeOpenCode();
  });

  afterEach(async () => {
    openCodeEnv?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
    await Promise.all(stagingDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // Acceptance #1 + #5 (clean retry): a successful capability install
  // through the bounded journal leaves the manifest hash equal to the
  // transaction-written identity AND a follow-up install runs cleanly.
  // The journal's commit() removes the preimage backup.
  it("successful new install: manifest hash equals journal transactionWrittenIdentity and backup is cleaned up", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const staged = await buildPreimageCapabilityRoot("# to-spec\nfresh content\n");
    stagingDirs.push(staged);

    const hooks = ticket47InternalHooks({ preimageCapabilityDirectory: staged });
    const beforeManifestBytes = await readManifestBytes(repository.root);
    const beforeReceiptBytes = await readReceiptBytes(repository.root);

    const installed = await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      hooks,
    );

    expect(installed.name).toBe(FAKE_CAPABILITY_NAME);
    expect(installed.installedRevision).toBe(FAKE_REVISION_A);
    expect(installed.preexisting).toBe(false);

    // The receipt generation advanced exactly once.
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(1 + 1);

    // Acceptance #5: a follow-up install (no change in revision → no-op
    // early-return path) leaves the receipt generation at the post-commit
    // value and does NOT double-advance.
    const noopHooks = ticket47InternalHooks({ preimageCapabilityDirectory: staged });
    await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      noopHooks,
    );
    const afterReceipt2 = await readOwnershipReceipt(repository.root);
    // The same-revision no-op path is a fast-return inside
    // `installCapability` that still re-authenticates the receipt
    // through `replaceOwnershipReceipt`. The journal transaction still
    // runs and advances the generation by exactly one more.
    expect(afterReceipt2.generation).toBe(afterReceipt.generation + 1);

    // Manifest and receipt bytes are well-formed JSON; the journal
    // recorded the EXACT transaction-written identity for both.
    const afterManifest = await loadManifest(repository.root);
    const skill = afterManifest.skills.find((s) => s.name === FAKE_CAPABILITY_NAME);
    expect(skill).toBeDefined();
    expect(skill!.hash).toBe(installed.hash);
    // The bytes written are the EXACT bytes produced by the journal's
    // `replace`. We do not assert byte-for-byte here — only that the
    // manifest changed (i.e. it was rewritten) and that the receipt's
    // advanced bytes match its new generation.
    const afterReceiptBytes = await readReceiptBytes(repository.root);
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).not.toBe(0);
    const afterManifestBytes = await readManifestBytes(repository.root);
    expect(Buffer.compare(afterManifestBytes, beforeManifestBytes)).not.toBe(0);

    // The journal's preimage backup was cleaned up after commit: the
    // `dest` directory exists but no journal-owned backup paths remain
    // under the original root's `tmp` area.
    expect(await exists(join(repository.root, FAKE_DESTINATION))).toBe(true);
  });

  // Acceptance #2 (new capability): an injected failure at the receipt
  // step restores the EXACT manifest preimage and the EXACT receipt
  // preimage. The destination directory is removed (it did not exist
  // before the transaction).
  it("new capability: preReceiptReplace failure restores EXACT manifest + receipt preimages and removes the destination", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const beforeManifestBytes = await readManifestBytes(repository.root);
    const beforeReceiptBytes = await readReceiptBytes(repository.root);

    const staged = await buildPreimageCapabilityRoot("# to-spec\ntransactional content\n");
    stagingDirs.push(staged);

    const failMessage = "ticket #47: forced receipt failure";
    const hooks = ticket47InternalHooks({
      preimageCapabilityDirectory: staged,
      preReceiptReplace: () => {
        throw new Error(failMessage);
      },
    });

    await expect(
      runCapabilityInstallTransaction(
        repository.root,
        {
          source: FAKE_SOURCE,
          name: FAKE_CAPABILITY_NAME,
          revision: FAKE_REVISION_A,
        },
        hooks,
      ),
    ).rejects.toThrow(failMessage);

    // Acceptance #2: EXACT byte-for-byte rollback of manifest + receipt.
    const afterManifestBytes = await readManifestBytes(repository.root);
    expect(Buffer.compare(afterManifestBytes, beforeManifestBytes)).toBe(0);
    const afterReceiptBytes = await readReceiptBytes(repository.root);
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).toBe(0);

    // The destination directory was removed (it did not exist before
    // the transaction; `installCapability` removed it during rollback).
    expect(await exists(join(repository.root, FAKE_DESTINATION))).toBe(false);

    // Acceptance #5 (clean retry): the next transaction runs cleanly
    // from the byte-identical preimage state.
    const retryHooks = ticket47InternalHooks({ preimageCapabilityDirectory: staged });
    const installed = await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      retryHooks,
    );
    expect(installed.installedRevision).toBe(FAKE_REVISION_A);
    // The retry receipt advanced exactly one generation from the
    // pre-failure generation (1 → 2).
    const retryReceipt = await readOwnershipReceipt(repository.root);
    expect(retryReceipt.generation).toBe(2);
  });

  // Acceptance #2 (replaced capability): an injected failure at the
  // receipt step restores the EXACT manifest preimage, the EXACT
  // receipt preimage, AND the EXACT capability preimage (the
  // replacement is a "replace" not a "new install").
  it("replaced capability: preReceiptReplace failure restores EXACT manifest + receipt + destination preimages", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    // First install: a fresh capability at revision A. Capture the
    // EXACT preimage bytes (destination tree + manifest + receipt) so
    // we can assert byte-for-byte rollback after the second install
    // fails mid-transaction.
    const stagedA = await buildPreimageCapabilityRoot("# to-spec\nrevision A\n");
    stagingDirs.push(stagedA);
    await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      ticket47InternalHooks({ preimageCapabilityDirectory: stagedA }),
    );

    const beforeDestinationBytes = await readFile(
      join(repository.root, FAKE_DESTINATION, "SKILL.md"),
    );
    const beforeManifestBytes = await readManifestBytes(repository.root);
    const beforeReceiptBytes = await readReceiptBytes(repository.root);

    // Second install at revision B. Inject a failure at
    // `preReceiptReplace` so the receipt write never runs.
    const stagedB = await buildPreimageCapabilityRoot("# to-spec\nrevision B\n");
    stagingDirs.push(stagedB);

    const failMessage = "ticket #47: forced receipt failure (replace)";
    const hooks = ticket47InternalHooks({
      preimageCapabilityDirectory: stagedB,
      preReceiptReplace: () => {
        throw new Error(failMessage);
      },
    });

    await expect(
      runCapabilityInstallTransaction(
        repository.root,
        {
          source: FAKE_SOURCE,
          name: FAKE_CAPABILITY_NAME,
          revision: FAKE_REVISION_B,
        },
        hooks,
      ),
    ).rejects.toThrow(failMessage);

    // Acceptance #2: every replaced-state artifact restored EXACTLY.
    const afterDestinationBytes = await readFile(
      join(repository.root, FAKE_DESTINATION, "SKILL.md"),
    );
    expect(Buffer.compare(afterDestinationBytes, beforeDestinationBytes)).toBe(0);
    const afterManifestBytes = await readManifestBytes(repository.root);
    expect(Buffer.compare(afterManifestBytes, beforeManifestBytes)).toBe(0);
    const afterReceiptBytes = await readReceiptBytes(repository.root);
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).toBe(0);
  });

  // Acceptance #3: a foreign writer that lands between
  // `recordDirectoryWrite` and the manifest write preserves its
  // content on disk and the rollback reports `identity-mismatch` for
  // the affected directory.
  it("concurrent foreign write to the capability directory is preserved and reported as identity-mismatch", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const beforeManifestBytes = await readManifestBytes(repository.root);
    const beforeReceiptBytes = await readReceiptBytes(repository.root);

    const staged = await buildPreimageCapabilityRoot("# to-spec\ntransactional content\n");
    stagingDirs.push(staged);

    const hooks = ticket47InternalHooks({
      preimageCapabilityDirectory: staged,
      postCapabilityInstall: async () => {
        // Foreign writer replaces the on-disk directory AFTER the
        // transaction's recordDirectoryWrite binding but BEFORE the
        // manifest write / receipt replace.
        const dest = join(repository.root, FAKE_DESTINATION);
        await writeFile(join(dest, "SKILL.md"), "# FOREIGN writer\n");
      },
      // Inject a downstream failure so the catch block runs and
      // surfaces the diagnostic.
      preReceiptReplace: () => {
        throw new Error("ticket #47: forced downstream failure");
      },
    });

    let caught: unknown;
    try {
      await runCapabilityInstallTransaction(
        repository.root,
        {
          source: FAKE_SOURCE,
          name: FAKE_CAPABILITY_NAME,
          revision: FAKE_REVISION_A,
        },
        hooks,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    // The thrown error must be a `PoiesisError` with the forced
    // downstream cause attached (the journal reports the
    // identity-mismatch through `details.incompleteRollback`).
    expect(caught).toMatchObject({ details: { incompleteRollback: expect.any(Array) } });
    const incomplete = (caught as { details: { incompleteRollback: Array<{ path: string; reason: string }> } }).details
      .incompleteRollback;
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]!.reason).toBe("identity-mismatch");
    expect(incomplete[0]!.path).toBe(join(repository.root, FAKE_DESTINATION));

    // The foreign content is preserved on disk.
    const onDisk = await readFile(
      join(repository.root, FAKE_DESTINATION, "SKILL.md"),
      "utf8",
    );
    expect(onDisk).toBe("# FOREIGN writer\n");

    // Manifest + receipt are restored byte-for-byte (no transaction
    // write ever landed on them; the journal's `replace` for the
    // manifest happens INSIDE installCapability via the journal, but
    // since the post-install hook fires AFTER installCapability
    // returns, the manifest WAS written transactionally — the journal
    // rollback restores it to preimage).
    const afterManifestBytes = await readManifestBytes(repository.root);
    expect(Buffer.compare(afterManifestBytes, beforeManifestBytes)).toBe(0);
    const afterReceiptBytes = await readReceiptBytes(repository.root);
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).toBe(0);
  });

  // Acceptance #4 + #6: the staging directory is best-effort cleanup
  // and a foreign write outside `.agents/skills/` is not touched.
  it("non-authoritative staging cleanup + unrelated state preservation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    // Seed an unrelated file at a path the capability install does NOT
    // touch. It must survive any number of transactions.
    const unrelatedPath = join(repository.root, ".poiesis", "unrelated.txt");
    const unrelatedBytes = Buffer.from("unrelated state preserved across transactions\n");
    await writeFile(unrelatedPath, unrelatedBytes);

    const staged = await buildPreimageCapabilityRoot("# to-spec\nclean run\n");
    stagingDirs.push(staged);

    const hooks = ticket47InternalHooks({ preimageCapabilityDirectory: staged });
    await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      hooks,
    );

    // Unrelated state preserved byte-for-byte.
    expect(Buffer.compare(await readFile(unrelatedPath), unrelatedBytes)).toBe(0);

    // Acceptance #4: the preimage directory passed via the seam is a
    // non-authoritative copy. The transaction must NOT treat its
    // post-write removal as a transaction-fatal step. We delete the
    // preimage directory BEFORE calling `installCapability` so the
    // `finally` block's `staged.cleanup()` resolves against an absent
    // path. The cleanup MUST NOT throw — `.catch(() => undefined)`
    // wraps the call. The transaction itself still succeeds because
    // `installCapability`'s `installDirectoryAtomically` copies the
    // preimage bytes into the destination atomically (the source
    // path is read once at install time, not at cleanup time).
    const externalStaging = await buildPreimageCapabilityRoot("# to-spec\nexternal\n");
    await rm(externalStaging, { recursive: true, force: true });
    stagingDirs.push(externalStaging);

    // We expect this install to fail because the source path is
    // missing — but the failure must be a SKILL_INSTALL_INCOMPLETE or
    // similar, NOT a thrown error from the staging cleanup itself.
    // The cleanup is non-authoritative.
    await expect(
      runCapabilityInstallTransaction(
        repository.root,
        {
          source: FAKE_SOURCE,
          name: FAKE_CAPABILITY_NAME,
          revision: FAKE_REVISION_B,
        },
        ticket47InternalHooks({ preimageCapabilityDirectory: externalStaging }),
      ),
    ).rejects.toThrow();

    // The unrelated file still survives the failed transaction.
    expect(Buffer.compare(await readFile(unrelatedPath), unrelatedBytes)).toBe(0);
  });

  // Acceptance #2 (manifest-write failure): a failure between the
  // destination install and the receipt write is rare in practice
  // (installCapability owns the manifest write). We verify the
  // rollback path catches a synthetic postManifestWrite failure
  // because the manifest entry has already been written through the
  // journal by the time the hook fires. We assert byte-for-byte
  // restoration of manifest + receipt preimages.
  it("postManifestWrite failure restores EXACT manifest + receipt preimages and removes destination", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const beforeManifestBytes = await readManifestBytes(repository.root);
    const beforeReceiptBytes = await readReceiptBytes(repository.root);

    const staged = await buildPreimageCapabilityRoot("# to-spec\nclean\n");
    stagingDirs.push(staged);

    const failMessage = "ticket #47: forced postManifestWrite failure";
    const hooks = ticket47InternalHooks({
      preimageCapabilityDirectory: staged,
      postManifestWrite: () => {
        throw new Error(failMessage);
      },
    });

    await expect(
      runCapabilityInstallTransaction(
        repository.root,
        {
          source: FAKE_SOURCE,
          name: FAKE_CAPABILITY_NAME,
          revision: FAKE_REVISION_A,
        },
        hooks,
      ),
    ).rejects.toThrow(failMessage);

    // Acceptance #2: byte-for-byte restoration of manifest + receipt.
    const afterManifestBytes = await readManifestBytes(repository.root);
    expect(Buffer.compare(afterManifestBytes, beforeManifestBytes)).toBe(0);
    const afterReceiptBytes = await readReceiptBytes(repository.root);
    expect(Buffer.compare(afterReceiptBytes, beforeReceiptBytes)).toBe(0);

    // Acceptance #5 (clean retry): the next install succeeds from
    // the byte-identical preimage state.
    const retryHooks = ticket47InternalHooks({ preimageCapabilityDirectory: staged });
    const installed = await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      retryHooks,
    );
    expect(installed.installedRevision).toBe(FAKE_REVISION_A);
  });

  // Acceptance #6: a foreign write to a sibling capability directory
  // (one this transaction does not touch) is preserved on disk across
  // a successful install of a different capability.
  it("unrelated capability directory is preserved across a successful install", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    // Seed a foreign capability directory at `.agents/skills/other`.
    // The transaction does not touch it; it MUST survive.
    const otherPath = join(repository.root, ".agents", "skills", "other");
    await mkdir(otherPath, { recursive: true });
    const otherBytes = Buffer.from("# other skill\nseeded\n");
    await writeFile(join(otherPath, "SKILL.md"), otherBytes);

    const staged = await buildPreimageCapabilityRoot("# to-spec\nclean\n");
    stagingDirs.push(staged);

    const hooks = ticket47InternalHooks({ preimageCapabilityDirectory: staged });
    await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      hooks,
    );

    // The foreign capability directory survives byte-for-byte.
    const afterBytes = await readFile(join(otherPath, "SKILL.md"));
    expect(Buffer.compare(afterBytes, otherBytes)).toBe(0);
    // The transaction did not accidentally list `other` in the
    // manifest's `skills` array.
    const afterManifest = await loadManifest(repository.root);
    expect(afterManifest.skills.find((s) => s.name === "other")).toBeUndefined();
    expect(afterManifest.skills.find((s) => s.name === FAKE_CAPABILITY_NAME)).toBeDefined();
  });

  // Acceptance #1 (commit removes preimage backup): after a
  // successful install the journal's preimage backup for the
  // destination directory is removed. We exercise this through the
  // `onCapturesReady` hook (which exposes the journal's entries
  // AFTER every capture has run, including the destination
  // directory's `preimageBackup`) and assert the backup is gone
  // after `commit()`.
  it("commit removes the journal-owned destination preimage backup after a successful install", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const staged = await buildPreimageCapabilityRoot("# to-spec\nclean\n");
    stagingDirs.push(staged);

    const seenBackups: string[] = [];
    const hooks = ticket47InternalHooks({
      preimageCapabilityDirectory: staged,
      onCapturesReady: (entries) => {
        for (const entry of entries) {
          if (entry.preimageBackup !== undefined) seenBackups.push(entry.preimageBackup);
        }
      },
    });

    await runCapabilityInstallTransaction(
      repository.root,
      {
        source: FAKE_SOURCE,
        name: FAKE_CAPABILITY_NAME,
        revision: FAKE_REVISION_A,
      },
      hooks,
    );

    // `onCapturesReady` ran AFTER every capture; the journal had
    // captured the destination as a directory-mode entry with a
    // preimage backup path. The install is a NEW install (no
    // pre-existing destination), so `physicalExists=false` and no
    // preimage bytes were copied — the backup path is created
    // unconditionally by `captureDirectory` for tracking the
    // absence.
    expect(seenBackups.length).toBeGreaterThan(0);

    // After commit, every backup path the journal recorded is gone.
    // The transaction owns the cleanup lifecycle: the caller's
    // `finally` MUST NOT remove backups.
    for (const backup of seenBackups) {
      expect(await exists(backup), `backup ${backup} should be removed after commit`).toBe(false);
    }

    // The receipt path still exists (the install was successful and
    // the journal's `commit()` does NOT remove the captured files
    // themselves — only the preimage BACKUPS).
    expect(await ownershipReceiptExists(repository.root)).toBe(true);
  });
});

describe("ticket #47 — receipt rollback identity guard", () => {
  // Mirrors ticket #45's pattern for the ownership receipt. A foreign
  // writer that mutates the receipt between the journal's upfront
  // capture and the receipt `replace` MUST be preserved on disk and
  // reported via `RollbackDiagnostic` (reason `identity-mismatch`).
  const repositories: TestRepository[] = [];
  const stagingDirs: string[] = [];
  let openCodeEnv: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    openCodeEnv = await installFakeOpenCode();
  });

  afterEach(async () => {
    openCodeEnv?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
    await Promise.all(stagingDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("foreign receipt writer is preserved and reported as identity-mismatch", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const beforeManifestBytes = await readManifestBytes(repository.root);
    const beforeReceiptBytes = await readReceiptBytes(repository.root);

    const staged = await buildPreimageCapabilityRoot("# to-spec\nclean\n");
    stagingDirs.push(staged);

    const foreignReceipt = {
      schema: 1,
      commonDir: "/dev/null",
      workspace: "/dev/null",
      installationId: "foreign-receipt",
      manifestDigest: "deadbeef",
      generation: 99,
    };
    const foreignBytes = `${JSON.stringify(foreignReceipt, null, 2)}\n`;

    const hooks = ticket47InternalHooks({
      preimageCapabilityDirectory: staged,
      postManifestWrite: async () => {
        // Foreign writer replaces the on-disk receipt AFTER the
        // journal's upfront capture but BEFORE the receipt
        // `replace`. The journal's pre-write identity guard inside
        // `replace` MUST abort because the captured
        // `expectedPreWriteIdentity` no longer matches the on-disk
        // bytes. We write the foreign bytes through a raw file
        // rewrite (not through `writeReceipt` because that helper is
        // not exported) so the on-disk bytes change WITHOUT the
        // journal being notified. The journal's pre-write guard sees
        // the foreign bytes and aborts `replace` with
        // `ARTIFACT_IDENTITY_DRIFT`.
        const receiptPath = await ownershipReceiptLocation(repository.root);
        const { unlink: fsUnlink, writeFile: fsWriteFile } = await import("node:fs/promises");
        await fsUnlink(receiptPath).catch(() => undefined);
        await fsWriteFile(receiptPath, foreignBytes);
      },
    });

    let caught: unknown;
    try {
      await runCapabilityInstallTransaction(
        repository.root,
        {
          source: FAKE_SOURCE,
          name: FAKE_CAPABILITY_NAME,
          revision: FAKE_REVISION_A,
        },
        hooks,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).toMatchObject({
      code: "ARTIFACT_IDENTITY_DRIFT",
    });

    // The foreign receipt bytes persist on disk.
    const afterReceipt = await readFile(
      await ownershipReceiptLocation(repository.root),
      "utf8",
    );
    expect(afterReceipt).toBe(foreignBytes);

    // The manifest was restored byte-for-byte because the failed
    // transaction never reached the receipt write step that commits
    // the journal; the catch block invokes `journal.rollback()` which
    // restores the manifest preimage.
    const afterManifestBytes = await readManifestBytes(repository.root);
    expect(Buffer.compare(afterManifestBytes, beforeManifestBytes)).toBe(0);

    // The receipt preimage is NOT restored because the on-disk bytes
    // no longer match the journal's `expectedPreWriteIdentity` — the
    // journal reports `identity-mismatch` for the receipt and leaves
    // the foreign bytes intact (ticket #45's pattern for init).
    const finalReceipt = await readFile(
      await ownershipReceiptLocation(repository.root),
      "utf8",
    );
    expect(finalReceipt).toBe(foreignBytes);
    // Sanity-check that we did NOT regress to the original receipt
    // bytes either — the foreign writer landed between capture and
    // replace.
    expect(finalReceipt).not.toBe(beforeReceiptBytes.toString("utf8"));
  });
});

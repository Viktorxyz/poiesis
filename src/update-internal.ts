/**
 * Module-internal transaction dependency seam for ordinary `update()` and
 * explicit 1.0.0 `bootstrapLegacyOwnership()`.
 *
 * This file is the SINGLE implementation of the receipt-authenticated
 * ordinary `update()` transaction and the explicit 1.0.0 bootstrap
 * transaction. It accepts a `hooks` parameter so the test suite can
 * drive deterministic failure cases (rollback, foreign-write preservation)
 * without monkey-patching internal modules.
 *
 * The seam lives in a sibling module that `src/index.ts` does NOT
 * import, so the security-sensitive fault-injection surface stays
 * confined to the repo and never appears in the packed
 * `dist/index.d.ts` declaration. The public `update` (in `maintenance.ts`)
 * is a thin wrapper that dispatches to one of these transaction runners
 * with an empty hooks object; production callers (CLI, library users)
 * get the real transaction with no test seam in scope.
 *
 * The public `MaintenanceOptions` type intentionally does NOT expose any
 * hook field; the fault-injection surface is confined to this internal
 * file. Tests import `UpdateBootstrapTransactionHooks`,
 * `runUpdateTransaction`, and `runBootstrapLegacyOwnershipTransaction`
 * directly from this internal module.
 *
 * Maintenance helpers (`doctor`, `packageVersion`, `resolveConfigForRoot`,
 * `verifyGitRepository`, `isRegularManagedFile`) are NOT imported at
 * module load time: they are reached through delayed dynamic `await
 * import("./maintenance.js")` calls so this module can be loaded without
 * pulling `maintenance.ts` into the same load cycle. The types
 * `MaintenanceOptions` and `UpdateResult` are imported via `import type`
 * and erased at compile time, so they contribute nothing to runtime.
 *
 * Ticket #44: both runners share the bounded `ArtifactJournal` and the
 * exclusive per-workspace mutation lock introduced for `update --config`
 * (ticket #43). Every owned write goes through `journal.replace`, which
 * runs the immediate pre-write identity guard (re-checks
 * `expectedPreWriteIdentity` against the on-disk file immediately before
 * the rename) and the reverse hash-gated rollback. The OpenCode config
 * is captured into the journal as a `patch`-mode entry so its physical
 * existence and exact preimage are recorded independently of whole-file
 * manifest ownership; the actual write still uses `applyOpenCodeConfig`
 * (which carries its own `expectedContent` pre-write guard and the
 * `onWritten` callback that binds `transactionWrittenIdentity`). The
 * transactional `.gitignore` rule keeps its own hash-gated atomic update
 * + rollback helper because it is not a Poiesis-owned artifact under
 * the journal's contract.
 */
import { exists, atomicWrite } from "./fs.js";
import { readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PoiesisError } from "./errors.js";
import { hashContent } from "./hash.js";
import { loadManifest, serializeManifest, type Manifest } from "./manifest.js";
import { applyOpenCodeConfig, OPENCODE_ADAPTER_VERSION, SUPPORTED_OPENCODE_VERSION, SUPPORTED_OPENCODE_VERSIONS, verifyOpenCodeVersion } from "./opencode.js";
import { assertOpenCodeOwnershipAgainstSnapshot } from "./opencode-preflight.js";
import { ownedPath, poiesisPath } from "./paths.js";
import { parseJsonc } from "./config.js";
import {
  acquireWorkspaceMutationLock,
  ArtifactJournal,
  type ArtifactJournalEntry,
} from "./mutation-transaction.js";
import {
  assertOwnershipReceipt,
  ownershipReceiptLocation,
  type OwnershipReceipt,
} from "./receipt.js";
import { installDefaultSkills } from "./skills.js";
import { templateMappings } from "./templates.js";
import { assertManifestAuthorityToleratingPredecessor, nextAdapterFiles, nextAdapterPatches } from "./authority.js";
import type { DoctorReport, MaintenanceOptions, UpdateResult } from "./maintenance.js";

type JsonObject = Record<string, unknown>;

/**
 * Journal artifact limit. 13 template mappings + `.poiesis/config.jsonc`
 * + opencode config + manifest + receipt + 11 default skill directories
 * = 28 artifacts in the worst case (ticket #46); 32 leaves comfortable
 * headroom for future Poiesis-managed files.
 */
const TRANSACTION_JOURNAL_LIMIT = 32;

/**
 * Post-transaction doctor gate predicate shared by the ordinary `update`
 * and the explicit 1.0.0 legacy bootstrap transaction. `skipSkills` may
 * exempt only the skill-related doctor check needed by test/internal
 * flows; every other doctor failure throws `UPDATE_DOCTOR_FAILED` to
 * drive the bounded journal's reverse hash-gated rollback.
 *
 * Mirrors the no-op / non-no-op gate in
 * `src/update-config-internal.ts::assertUpdateConfigDoctorGate` so the
 * three transaction surfaces share the same fail-closed semantics for
 * non-skill doctor failures regardless of `skipSkills`.
 */
function assertUpdateDoctorGate(report: DoctorReport, skipSkills: boolean): void {
  const gateFailure = report.checks.find(
    (check) => check.status === "fail" && !(skipSkills && check.id === "skills"),
  );
  if (gateFailure !== undefined) {
    throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Poiesis update did not pass doctor", { report });
  }
}

const POIESIS_DEFAULT_PATH_GITIGNORE_HEADER =
  "# Hide the default-path workspace area (Poiesis-managed local state; transactional update/bootstrap line)";
const POIESIS_DEFAULT_PATH_GITIGNORE_PATTERN = ".poiesis/workspaces/";

/**
 * Captured state for the transactional `.gitignore` rule so the
 * rollback path can restore the EXACT preimage byte-for-byte. The
 * journal does NOT cover the gitignore because the file is not a
 * Poiesis-owned artifact under the journal's contract.
 */
interface GitignoreTransactionState {
  snapshot: Buffer | null;
  writtenHash: string | undefined;
}

/**
 * Test-only deterministic fault-injection hooks used by
 * `runUpdateTransaction` and `runBootstrapLegacyOwnershipTransaction`.
 * Each callback fires immediately BEFORE the corresponding write step
 * (or immediately AFTER for `post*` hooks). Throwing from a hook
 * simulates an I/O fault and exercises the rollback path.
 *
 * The seam is intentionally not exposed via `MaintenanceOptions` and is
 * not part of the packed public surface. Tests import
 * `UpdateBootstrapTransactionHooks` and the transaction runners
 * directly from this internal module.
 */
export interface UpdateBootstrapTransactionHooks {
  /**
   * Exposes the bounded in-memory journal to transaction tests after
   * every artifact has been captured and validated, before any write
   * fires. The journal's entries are read-only at this point.
   */
  onJournalReady?: (entries: readonly ArtifactJournalEntry[]) => void | Promise<void>;
  /** Called immediately before `installDefaultSkills` runs. */
  preSkillsInstall?: () => void | Promise<void>;
  /**
   * Called immediately AFTER `installDefaultSkills` returns but BEFORE
   * any further transactional write. Tests use this hook to land a
   * concurrent foreign write to a skill directory between the
   * transaction's recordDirectoryWrite binding and the next write.
   * The bounded journal's hash-gated rollback must preserve the
   * foreign write and report it via `RollbackDiagnostic` (reason
   * `identity-mismatch`). Ticket #46.
   */
  postSkillsInstall?: () => void | Promise<void>;
/**
   * Optional pre-staged skill directory. When supplied, the update and
   * bootstrap transactions route `installDefaultSkills` through this
   * directory instead of running the network-bound `stageSkills` step.
   * The directory MUST mirror the layout `.agents/skills/<name>/...`
   * that `stageSkills` produces. Used by tests that exercise the
   * transactional install/rollback contract without contacting the
   * upstream registry. NOT part of the public surface.
   */
  preimageSkillDirectory?: string;
  /**
   * Called immediately BEFORE the atomic write of each materialized file.
   * Receives the relative path of the file about to be written. The
   * transaction's pre-write identity is `hashContent(file.content)`; if
   * the hook mutates the on-disk file before our `atomic.write` runs,
   * the rollback still restores the original preimage because the
   * identity hash matches only what THIS transaction writes.
   */
  preMaterializedFileWrite?: (path: string) => void | Promise<void>;
  /** Called immediately AFTER each materialized file atomic write completes. */
  postMaterializedFileWrite?: (path: string) => void | Promise<void>;
  /** Called immediately before the new OpenCode projection is applied. */
  preOpenCodeApply?: () => void | Promise<void>;
  /** Called immediately AFTER the new OpenCode projection has been written. */
  postOpenCodeApply?: () => void | Promise<void>;
  /** Called immediately before the default-path `.gitignore` rule is appended. */
  preDefaultPathGitignoreEnsure?: () => void | Promise<void>;
  /** Called immediately AFTER the default-path `.gitignore` rule has been appended. */
  postDefaultPathGitignoreEnsure?: () => void | Promise<void>;
  /** Called immediately before atomic-writing the new `.poiesis/manifest.json`. */
  preManifestWrite?: () => void | Promise<void>;
  /** Called immediately AFTER atomic-writing the new `.poiesis/manifest.json`. */
  postManifestWrite?: () => void | Promise<void>;
  /** Called immediately before the receipt write (replace for update, create for bootstrap). */
  preReceiptReplace?: () => void | Promise<void>;
  /** Called immediately AFTER the receipt write (replace for update, create for bootstrap). */
  postReceiptReplace?: () => void | Promise<void>;
}

async function ensureDefaultPathGitignore(
  root: string,
  expected: Buffer | null,
): Promise<{ writtenHash: string | undefined }> {
  const path = join(root, ".gitignore");
  let content = "";
  if (await exists(path)) {
    content = (await readFile(path)).toString("utf8");
  }
  const lines = content.split(/\r?\n/);
  const headerPresent = lines.includes(POIESIS_DEFAULT_PATH_GITIGNORE_HEADER);
  const patternPresent = lines.includes(POIESIS_DEFAULT_PATH_GITIGNORE_PATTERN);
  if (headerPresent && patternPresent) return { writtenHash: undefined };
  const merged = [...lines];
  if (merged.length > 0 && merged[merged.length - 1] === "") merged.pop();
  merged.push(POIESIS_DEFAULT_PATH_GITIGNORE_HEADER);
  merged.push(POIESIS_DEFAULT_PATH_GITIGNORE_PATTERN);
  const next = merged.join("\n") + "\n";
  if (expected !== null && Buffer.compare(Buffer.from(content, "utf8"), expected) !== 0) {
    throw new PoiesisError("POIESIS_GITIGNORE_CHANGED", "Gitignore changed before default-path ensure");
  }
  await atomicWrite(path, next);
  return { writtenHash: hashContent(next) };
}

async function rollbackDefaultPathGitignore(
  path: string,
  snapshot: Buffer | null,
  writtenHash: string | undefined,
): Promise<void> {
  if (writtenHash === undefined) return;
  if (!(await exists(path))) return;
  const current = await readFile(path);
  if (hashContent(current) !== writtenHash) return;
  if (snapshot === null) {
    await unlink(path);
    return;
  }
  await atomicWrite(path, snapshot);
}

async function snapshotFile(path: string): Promise<Buffer | null> {
  if (!(await exists(path))) return null;
  return readFile(path);
}

/**
 * Capture every artifact the transaction will mutate into a bounded
 * `ArtifactJournal` and validate the OpenCode `configPatches` against
 * the captured on-disk JSON. The journal is built in the exact write
 * order of the transaction so its reverse-order rollback equals reverse
 * write order. Validation MUST run before capture: a recorded patch
 * that disagrees with the captured snapshot is a fail-closed ownership
 * violation and must abort before the journal commits to any state.
 */
async function captureTransactionArtifacts(args: {
  resolvedRoot: string;
  materialized: ReadonlyArray<{ path: string; kind: "canonical" | "generated" }>;
  openCodeConfigRelativePath: string;
  openCodeConfigCurrentBytes: Buffer | null;
  openCodeConfigPatches: Manifest["configPatches"];
  receiptPath: string;
  journalLimit: number;
}): Promise<ArtifactJournal> {
  const journal = new ArtifactJournal(args.journalLimit);
  for (const file of args.materialized) {
    await journal.capture(join(args.resolvedRoot, file.path), "whole-file");
  }
  await journal.capture(join(args.resolvedRoot, args.openCodeConfigRelativePath), "patch");
  await journal.capture(join(args.resolvedRoot, ".poiesis/manifest.json"), "whole-file");
  await journal.capture(args.receiptPath, "whole-file");
  // Validate every recorded OpenCode patch against the captured on-disk
  // JSON snapshot. Replaces the disk re-read that the maintenance helper
  // `assertConfigPatchesOwned` previously performed for the OpenCode
  // config path. Throws `CONFIG_OWNERSHIP_LOST` on first mismatch —
  // before any helper call, any capture, and any schema validation.
  // Production callers will only ever need this check when a malicious
  // or out-of-band writer has tampered with the OpenCode config between
  // the last receipt and the current transaction; the check fails
  // closed without mutating any owned byte.
  if (args.openCodeConfigCurrentBytes !== null) {
    const openCodeConfigPath = join(args.resolvedRoot, args.openCodeConfigRelativePath);
    const openCodeConfigParsed = parseJsonc<JsonObject>(
      args.openCodeConfigCurrentBytes.toString("utf8"),
      openCodeConfigPath,
    );
    assertOpenCodeOwnershipAgainstSnapshot({
      root: args.resolvedRoot,
      configPath: openCodeConfigPath,
      parsedSnapshot: openCodeConfigParsed,
      patches: args.openCodeConfigPatches,
    });
  }
  return journal;
}

/**
 * Common body for both transaction runners: acquire the exclusive
 * per-workspace mutation lock, run the inner transaction, and release
 * the lock in `finally`. The release-error policy mirrors
 * `runUpdateConfigTransaction`: if `release()` throws and no
 * transaction error is in flight, the release error is the rethrown
 * value; if a transaction error is already in flight, the release
 * message is attached to `PoiesisError.details.lockRelease` and the
 * transaction error is rethrown unchanged.
 */
async function withWorkspaceMutationLock<T extends UpdateResult>(
  root: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = await acquireWorkspaceMutationLock(resolve(root));
  let transactionError: unknown;
  try {
    return await run();
  } catch (error) {
    transactionError = error;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      if (transactionError === undefined) throw releaseError;
      if (transactionError instanceof PoiesisError) {
        transactionError.details.lockRelease = releaseError instanceof Error ? releaseError.message : String(releaseError);
      }
    }
  }
}

/**
 * Module-internal transaction runner for the receipt-authenticated
 * ordinary `update()` path. The function is the single implementation
 * of the ordinary `update` transaction and accepts a `hooks` parameter
 * that is intentionally NOT exposed via `MaintenanceOptions` (and
 * therefore not in the packed `dist/index.d.ts`).
 *
 * Tests use this runner to drive deterministic failure cases without
 * monkey-patching internal modules. Production callers (CLI, library
 * users) MUST NOT supply hooks; the public `update` always passes an
 * empty hooks object when the bootstrap flag is not set, so the hooks
 * do not change production behavior when omitted.
 */
export async function runUpdateTransaction(
  root: string,
  options: MaintenanceOptions,
  hooks: UpdateBootstrapTransactionHooks,
): Promise<UpdateResult> {
  return withWorkspaceMutationLock(root, () => runLockedUpdateTransaction(root, options, hooks));
}

async function runLockedUpdateTransaction(
  root: string,
  options: MaintenanceOptions,
  hooks: UpdateBootstrapTransactionHooks,
): Promise<UpdateResult> {
  const { doctor, isRegularManagedFile, packageVersion, resolveConfigForRoot, verifyGitRepository } = await import("./maintenance.js");

  const resolvedRoot = resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  // Receipt-first: authenticate the receipt against the on-disk manifest
  // BEFORE any authority check consumes manifest records. This binds the
  // trusted manifest digest and gates the migration tolerance on a known
  // predecessor provenance. A 1.0.0 manifest WITHOUT a receipt must use the
  // explicit --bootstrap-legacy-ownership path, not normal update.
  const receipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  // Tolerant authority check: accepts the strict current projection OR the
  // exact v1.0.1/1.0.2 predecessor projection.
  await assertManifestAuthorityToleratingPredecessor(resolvedRoot, manifest, config, ["1.0.1", "1.0.2"]);
  await verifyGitRepository(resolvedRoot, config);
  await verifyOpenCodeVersion(resolvedRoot);

  // Compute the materialized file list. We need this both to validate
  // ownership of each destination and to enumerate the files we will
  // write inside the transaction. The pre-write identity of each file is
  // `hashContent(file.content)` and is captured BEFORE `atomicWrite`
  // runs so the rollback comparison is a function of what we wrote,
  // not what the kernel happened to leave on disk afterwards.
  const { readTemplate } = await import("./templates.js");
  const { serializeConfig } = await import("./config.js");
  const materialized: Array<{ path: string; kind: "canonical" | "generated"; content: string }> = [];
  for (const mapping of templateMappings) {
    materialized.push({ path: mapping.destination, kind: mapping.kind, content: await readTemplate(mapping.source) });
  }
  materialized.push({ path: ".poiesis/config.jsonc", kind: "generated", content: serializeConfig(config) });

  const records = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of materialized) {
    const record = records.get(file.path);
    if (record === undefined || record.kind !== file.kind) {
      throw new PoiesisError("FILE_OWNERSHIP_UNKNOWN", "Current manifest does not prove ownership of an update destination", { path: file.path });
    }
    const destination = join(resolvedRoot, file.path);
    if (!(await exists(destination)) || !(await isRegularManagedFile(resolvedRoot, destination))) {
      throw new PoiesisError("FILE_OWNERSHIP_LOST", "Managed file is missing or modified", { path: file.path });
    }
    const actual = hashContent(await readFile(destination));
    if (actual !== record.hash) {
      throw new PoiesisError("FILE_OWNERSHIP_LOST", "Managed file is missing or modified", { path: file.path });
    }
  }
  await assertOwnershipReceipt(resolvedRoot, manifest);

  const managedConfigFiles = [...new Set(manifest.configPatches.map((patch) => patch.file))];
  if (managedConfigFiles.length !== 1) {
    throw new PoiesisError("CONFIG_OWNERSHIP_INVALID", "Manifest must identify exactly one managed OpenCode config");
  }
  const openCodeConfig = managedConfigFiles[0]!;
  const openCodeConfigPath = join(resolvedRoot, openCodeConfig);
  const openCodeConfigCurrentBytes = await readFile(openCodeConfigPath);
  if (!Buffer.from(openCodeConfigCurrentBytes.toString("utf8"), "utf8").equals(openCodeConfigCurrentBytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not valid UTF-8", {
      file: openCodeConfig,
    });
  }

  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const receiptPath = await ownershipReceiptLocation(resolvedRoot);
  const journal = await captureTransactionArtifacts({
    resolvedRoot,
    materialized,
    openCodeConfigRelativePath: openCodeConfig,
    openCodeConfigCurrentBytes,
    openCodeConfigPatches: manifest.configPatches,
    receiptPath,
    journalLimit: TRANSACTION_JOURNAL_LIMIT,
  });
  await hooks?.onJournalReady?.(journal.entries);

  // Gitignore state is captured at the write site and used by the catch
  // block's rollback. Declared here so the catch block can close over
  // the locals without re-reading the file.
  let gitignore: GitignoreTransactionState = { snapshot: null, writtenHash: undefined };

  try {
    await hooks?.preSkillsInstall?.();
    // Ticket #46: pass the bounded journal into installDefaultSkills so
    // every default-skill preimage hash and transaction-written hash is
    // captured into the same journal that owns every other owned
    // artifact. The journal's `rollback()` is then the single source of
    // truth for reverse hash-gated restoration: it preserves
    // concurrent foreign writes and reports them via
    // `RollbackDiagnostic` (reason `identity-mismatch`).
    const skillOptions: { replaceOwned: boolean; journal: ArtifactJournal; preimageSkillDirectory?: string } = {
      replaceOwned: true,
      journal,
    };
    if (hooks?.preimageSkillDirectory !== undefined) {
      skillOptions.preimageSkillDirectory = hooks.preimageSkillDirectory;
    }
    const skills = options.skipSkills
      ? manifest.skills
      : await installDefaultSkills(resolvedRoot, manifest.skills, skillOptions);
    await hooks?.postSkillsInstall?.();

    // 1. Materialized managed files: each file goes through `journal.replace`
    //    so the immediate pre-write identity guard and the reverse
    //    hash-gated rollback apply uniformly. The preimage captured by
    //    `journal.capture` is the EXACT preimage bytes; the rollback
    //    restores them byte-for-byte.
    for (const file of materialized) {
      const destination = join(resolvedRoot, file.path);
      const entry = journal.entries.find((candidate) => candidate.path === destination);
      if (entry === undefined) {
        throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the materialized file entry", { path: file.path });
      }
      await hooks?.preMaterializedFileWrite?.(file.path);
      await journal.replace(entry, file.content);
      await hooks?.postMaterializedFileWrite?.(file.path);
    }

    // 2. Transactional `.gitignore` rule: keep the existing hash-gated
    //    helper because the file is NOT a Poiesis-owned artifact under
    //    the journal's contract — the rule is appended to whatever the
    //    user has on disk.
    gitignore = { snapshot: await snapshotFile(join(resolvedRoot, ".gitignore")), writtenHash: undefined };
    await hooks?.preDefaultPathGitignoreEnsure?.();
    const result = await ensureDefaultPathGitignore(resolvedRoot, gitignore.snapshot);
    gitignore = { snapshot: gitignore.snapshot, writtenHash: result.writtenHash };
    await hooks?.postDefaultPathGitignoreEnsure?.();

    // 3. OpenCode config: captured as `patch`-mode entry so physical
    //    existence and exact preimage are recorded independently of
    //    whole-file ownership. The actual write uses `applyOpenCodeConfig`
    //    because it owns the projection logic AND carries its own
    //    `expectedContent` pre-write guard. The `onWritten` callback
    //    binds `transactionWrittenIdentity` to the bytes we just wrote,
    //    so `journal.rollback` hash-gates against the transaction's own
    //    bytes (preserves any foreign replacement that races between
    //    the apply and the rollback).
    const openCodeEntry = journal.entries.find((candidate) => candidate.path === openCodeConfigPath);
    if (openCodeEntry === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the OpenCode config entry", { path: openCodeConfig });
    }
    await hooks?.preOpenCodeApply?.();
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, config, openCodeConfigPath, {
      expectedContent: openCodeConfigCurrentBytes,
      onWritten: (content: string) => {
        openCodeEntry.transactionWrittenIdentity = { exists: true, kind: "file", hash: hashContent(content) };
      },
    });
    await hooks?.postOpenCodeApply?.();
    // Defensive fail-closed check (unchanged from #32): confirm the
    // on-disk OpenCode config still matches the exact bytes captured by
    // the onWritten callback before any manifest/receipt materialization.
    // A concurrent replacement that lands between the callback and this
    // check would otherwise produce a manifest hash derived from foreign
    // bytes; the check rejects here so the next manifest's OpenCode
    // record is always derived from this transaction's callback bytes
    // (never a later mutable-path reread).
    if (openCodeEntry.transactionWrittenIdentity !== undefined && (await exists(openCodeConfigPath))) {
      const currentOpenCodeBytes = await readFile(openCodeConfigPath);
      const expectedOpenCodeHash = openCodeEntry.transactionWrittenIdentity.hash;
      if (expectedOpenCodeHash !== undefined && hashContent(currentOpenCodeBytes) !== expectedOpenCodeHash) {
        throw new PoiesisError(
          "OPENCODE_CONFIG_CHANGED",
          "OpenCode config changed between transaction write and manifest materialization",
          { path: openCodeConfig },
        );
      }
    }
    const configPatches = nextAdapterPatches(manifest, appliedPatches);
    const nextFiles = nextAdapterFiles(
      manifest,
      materialized.map((file) => ({
        path: file.path,
        kind: file.kind,
        hash: hashContent(file.content),
        durable: templateMappings.find((mapping) => mapping.destination === file.path)?.trackInProject === true,
      })),
    );
    if (openCodeEntry.transactionWrittenIdentity?.hash !== undefined) {
      const nextRecord = nextFiles.findIndex((file) => file.path === openCodeConfig);
      if (nextRecord >= 0) {
        // Bind the next manifest's OpenCode file hash to the EXACT
        // transaction-written bytes captured by the onWritten callback.
        // Never re-read the mutable path: the defensive check above has
        // already failed closed on any post-write foreign replacement;
        // this branch only executes when the file still matches our
        // callback bytes.
        nextFiles[nextRecord] = {
          ...nextFiles[nextRecord]!,
          hash: openCodeEntry.transactionWrittenIdentity.hash,
        };
      }
    }
    const next: Manifest = {
      schema: 1,
      poiesisVersion: await packageVersion(),
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
      files: nextFiles,
      skills,
      configPatches,
    };
    // Serialize next once and derive its post-write identity from those
    // exact bytes. A foreign replacement in the write window cannot be
    // adopted as our identity.
    const nextManifestBytes = serializeManifest(next);
    const nextManifestHash = hashContent(nextManifestBytes);
    const manifestEntry = journal.entries.find((candidate) => candidate.path === manifestPath);
    if (manifestEntry === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the manifest entry", { path: ".poiesis/manifest.json" });
    }
    await hooks?.preManifestWrite?.();
    await journal.replace(manifestEntry, nextManifestBytes);
    await hooks?.postManifestWrite?.();

    // Advance generation by exactly ONE and bind to the new manifest digest.
    // The receipt's exact written bytes match `writeReceipt`'s canonical
    // serialization (see `./receipt.ts`); they are derived from the
    // advanced receipt object BEFORE `journal.replace` so the
    // `transactionWrittenIdentity` recorded by the journal equals the
    // bytes on disk.
    const nextReceipt: OwnershipReceipt = {
      ...receipt,
      manifestDigest: nextManifestHash,
      generation: receipt.generation + 1,
    };
    const nextReceiptBytes = `${JSON.stringify(nextReceipt, null, 2)}\n`;
    const receiptEntry = journal.entries.find((candidate) => candidate.path === receiptPath);
    if (receiptEntry === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the receipt entry", { path: receiptPath });
    }
    await hooks?.preReceiptReplace?.();
    await journal.replace(receiptEntry, nextReceiptBytes);
    await hooks?.postReceiptReplace?.();

    const report = await doctor(resolvedRoot);
    assertUpdateDoctorGate(report, options.skipSkills === true);
    // Ticket #46: the bounded journal's `commit()` removes every
    // journal-owned directory preimage backup AFTER every transaction
    // write has succeeded. Failures are swallowed inside `commit()`, so
    // a cleanup failure cannot turn a committed update into a failure.
    await journal.commit();
    return { manifest: next, doctor: report };
  } catch (error) {
    // Fail-closed rollback: the bounded journal drives every owned
    // artifact's reverse hash-gated restoration in reverse write order.
    // Foreign replacements that land between this transaction's last
    // write and the rollback are preserved and reported explicitly.
    const diagnostics = await journal.rollback();
    // 5. Transactional `.gitignore` (last shared helper, byte-exact already).
    await rollbackDefaultPathGitignore(join(resolvedRoot, ".gitignore"), gitignore.snapshot, gitignore.writtenHash);
    if (diagnostics.length > 0) {
      if (error instanceof PoiesisError) {
        error.details.incompleteRollback = diagnostics;
      } else {
        throw new PoiesisError("ROLLBACK_INCOMPLETE", "Transaction failed and rollback was incomplete", {
          cause: error instanceof Error ? error.message : String(error),
          incompleteRollback: diagnostics,
        });
      }
    }
    throw error;
  }
}

/**
 * Module-internal transaction runner for the explicit 1.0.0
 * `bootstrapLegacyOwnership()` path. The function is the single
 * implementation of the explicit 1.0.0 bootstrap transaction and
 * accepts a `hooks` parameter that is intentionally NOT exposed via
 * `MaintenanceOptions` (and therefore not in the packed
 * `dist/index.d.ts`).
 *
 * The bootstrap path runs when `MaintenanceOptions.bootstrapLegacyOwnership`
 * is set: it demotes a 1.0.0 install (no receipt, manual managed files)
 * to a current-shape Poiesis 1.0.3 install with a generation=1 receipt
 * and the new default-path `.gitignore` rule.
 */
export async function runBootstrapLegacyOwnershipTransaction(
  root: string,
  options: MaintenanceOptions,
  hooks: UpdateBootstrapTransactionHooks,
): Promise<UpdateResult> {
  return withWorkspaceMutationLock(root, () => runLockedBootstrapLegacyOwnershipTransaction(root, options, hooks));
}

async function runLockedBootstrapLegacyOwnershipTransaction(
  root: string,
  options: MaintenanceOptions,
  hooks: UpdateBootstrapTransactionHooks,
): Promise<UpdateResult> {
  const { doctor, isRegularManagedFile, packageVersion, resolveConfigForRoot, verifyGitRepository } = await import("./maintenance.js");
  const { ownershipReceiptExists, buildOwnershipReceipt } = await import("./receipt.js");
  const { hashOwnedSkillDirectory, loadDefaultSkills } = await import("./skills.js");
  const { hashDirectory } = await import("./hash.js");

  const resolvedRoot = resolve(root);
  if (await ownershipReceiptExists(resolvedRoot)) {
    throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Refusing to bootstrap over an existing ownership receipt");
  }
  const manifest = await loadManifest(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  if (manifest.poiesisVersion !== "1.0.0") {
    throw new PoiesisError("LEGACY_BOOTSTRAP_UNSUPPORTED", "Legacy bootstrap only accepts public Poiesis 1.0.0 installations", { poiesisVersion: manifest.poiesisVersion });
  }
  await assertManifestAuthorityToleratingPredecessor(resolvedRoot, manifest, config, ["1.0.0"]);
  for (const file of manifest.files) {
    const destination = ownedPath(resolvedRoot, file.path);
    if (!(await exists(destination)) || !(await isRegularManagedFile(resolvedRoot, destination))) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy managed file is missing or not a regular file", { path: file.path });
    }
    const actual = hashContent(await readFile(destination));
    if (actual !== file.hash) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy managed file does not match the 1.0.0 manifest", { path: file.path });
    }
  }
  await verifyGitRepository(resolvedRoot, config);
  await verifyOpenCodeVersion(resolvedRoot);

  const { readTemplate } = await import("./templates.js");
  const { serializeConfig } = await import("./config.js");
  const materialized: Array<{ path: string; kind: "canonical" | "generated"; content: string }> = [];
  for (const mapping of templateMappings) {
    materialized.push({ path: mapping.destination, kind: mapping.kind, content: await readTemplate(mapping.source) });
  }
  materialized.push({ path: ".poiesis/config.jsonc", kind: "generated", content: serializeConfig(config) });

  // Validate each legacy skill claim. The legacy validation logic
  // mirrors `validateLegacySkillIdentity` in `maintenance.ts` (ticket
  // #25): each owned legacy skill must have a hash that matches its
  // on-disk directory; preexisting skills must hash to the same value.
  // Skill paths are validated through the canonical `ownedPath` helper
  // exported from `./paths.ts` so the two modules never diverge.
  const defaults = await loadDefaultSkills();
  const defaultNames = new Set(defaults.map((skill) => skill.name));
  async function validateSkill(root: string, skill: Manifest["skills"][number]): Promise<string> {
    const destination = ownedPath(root, skill.path);
    if (skill.preexisting) return hashOwnedSkillDirectory(destination);
    if (skill.hash === undefined) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Owned legacy skill is missing a hash", { path: skill.path });
    }
    const legacyHash = await hashDirectory(destination);
    if (legacyHash !== skill.hash) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Owned legacy skill content does not match the 1.0.0 manifest", {
        path: skill.path,
        expected: skill.hash,
        actual: legacyHash,
      });
    }
    return hashOwnedSkillDirectory(destination);
  }
  for (const skill of manifest.skills) {
    if (!defaultNames.has(skill.name) && !skill.preexisting) {
      throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy manifest claims an unknown owned skill", {
        name: skill.name,
      });
    }
    await validateSkill(resolvedRoot, skill);
  }
  const nextSkills = await Promise.all(
    manifest.skills.map(async (skill) => ({
      ...skill,
      hash: await validateSkill(resolvedRoot, skill),
    })),
  );

  const openCodeConfig = manifest.configPatches[0]?.file;
  if (openCodeConfig === undefined) {
    throw new PoiesisError("LEGACY_BOOTSTRAP_REJECTED", "Legacy manifest does not identify an OpenCode config");
  }
  const openCodeConfigPath = join(resolvedRoot, openCodeConfig);
  // Capture the OpenCode config bytes unconditionally: a 1.0.0 install
  // always created the file (the legacy init wrote it), but the journal
  // needs the physical preimage to drive the exact-bytes rollback path.
  // The read may ENOENT for an exotic install; treat that as "absent"
  // and skip the patch-ownership validation step.
  let openCodeConfigCurrentBytes: Buffer | null = null;
  if (await exists(openCodeConfigPath)) {
    openCodeConfigCurrentBytes = await readFile(openCodeConfigPath);
    if (!Buffer.from(openCodeConfigCurrentBytes.toString("utf8"), "utf8").equals(openCodeConfigCurrentBytes)) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not valid UTF-8", {
        file: openCodeConfig,
      });
    }
  }

  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const receiptPath = await ownershipReceiptLocation(resolvedRoot);
  // Bootstrap preimage snapshots are required by the journal to
  // restore byte-for-byte on rollback. The receipt snapshot is
  // intentionally captured as `null` (path is initially absent); the
  // journal records `physicalExists: false` and the rollback removes
  // the file only on a transaction-written-identity match.
  const journal = await captureTransactionArtifacts({
    resolvedRoot,
    materialized,
    openCodeConfigRelativePath: openCodeConfig,
    openCodeConfigCurrentBytes,
    openCodeConfigPatches: openCodeConfigCurrentBytes === null ? [] : manifest.configPatches,
    receiptPath,
    journalLimit: TRANSACTION_JOURNAL_LIMIT,
  });
  await hooks?.onJournalReady?.(journal.entries);

  let gitignore: GitignoreTransactionState = { snapshot: null, writtenHash: undefined };

  try {
    await hooks?.preSkillsInstall?.();
    // Ticket #46: pass the bounded journal into installDefaultSkills so
    // every default-skill preimage hash and transaction-written hash is
    // captured into the same journal that owns every other owned
    // artifact. The journal's `rollback()` is then the single source of
    // truth for reverse hash-gated restoration, preserving concurrent
    // foreign writes and reporting them via `RollbackDiagnostic`.
    const skillOptions: { replaceOwned: boolean; journal: ArtifactJournal; preimageSkillDirectory?: string } = {
      replaceOwned: true,
      journal,
    };
    if (hooks?.preimageSkillDirectory !== undefined) {
      skillOptions.preimageSkillDirectory = hooks.preimageSkillDirectory;
    }
    const skills = options.skipSkills
      ? nextSkills
      : await installDefaultSkills(resolvedRoot, nextSkills, skillOptions);
    await hooks?.postSkillsInstall?.();

    for (const file of materialized) {
      const destination = join(resolvedRoot, file.path);
      const entry = journal.entries.find((candidate) => candidate.path === destination);
      if (entry === undefined) {
        throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the materialized file entry", { path: file.path });
      }
      await hooks?.preMaterializedFileWrite?.(file.path);
      await journal.replace(entry, file.content);
      await hooks?.postMaterializedFileWrite?.(file.path);
    }

    gitignore = { snapshot: await snapshotFile(join(resolvedRoot, ".gitignore")), writtenHash: undefined };
    await hooks?.preDefaultPathGitignoreEnsure?.();
    const result = await ensureDefaultPathGitignore(resolvedRoot, gitignore.snapshot);
    gitignore = { snapshot: gitignore.snapshot, writtenHash: result.writtenHash };
    await hooks?.postDefaultPathGitignoreEnsure?.();

    const openCodeEntry = journal.entries.find((candidate) => candidate.path === openCodeConfigPath);
    if (openCodeEntry === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the OpenCode config entry", { path: openCodeConfig });
    }
    await hooks?.preOpenCodeApply?.();
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, config, openCodeConfigPath, {
      ...(openCodeConfigCurrentBytes !== null ? { expectedContent: openCodeConfigCurrentBytes } : {}),
      onWritten: (content: string) => {
        openCodeEntry.transactionWrittenIdentity = { exists: true, kind: "file", hash: hashContent(content) };
      },
    });
    await hooks?.postOpenCodeApply?.();
    // Defensive fail-closed check (bootstrap parity with ordinary update):
    // confirm the on-disk OpenCode config still matches the exact bytes
    // captured by the onWritten callback before any manifest/receipt
    // materialization.
    if (openCodeEntry.transactionWrittenIdentity !== undefined && (await exists(openCodeConfigPath))) {
      const currentOpenCodeBytes = await readFile(openCodeConfigPath);
      const expectedOpenCodeHash = openCodeEntry.transactionWrittenIdentity.hash;
      if (expectedOpenCodeHash !== undefined && hashContent(currentOpenCodeBytes) !== expectedOpenCodeHash) {
        throw new PoiesisError(
          "OPENCODE_CONFIG_CHANGED",
          "OpenCode config changed between transaction write and manifest materialization",
          { path: openCodeConfig },
        );
      }
    }
    const configPatches = nextAdapterPatches(manifest, appliedPatches);
    const nextFiles = nextAdapterFiles(
      manifest,
      materialized.map((file) => ({
        path: file.path,
        kind: file.kind,
        hash: hashContent(file.content),
        durable: templateMappings.find((mapping) => mapping.destination === file.path)?.trackInProject === true,
      })),
    );
    if (openCodeEntry.transactionWrittenIdentity?.hash !== undefined) {
      const nextRecord = nextFiles.findIndex((file) => file.path === openCodeConfig);
      if (nextRecord >= 0) {
        nextFiles[nextRecord] = { ...nextFiles[nextRecord]!, hash: openCodeEntry.transactionWrittenIdentity.hash };
      }
    }
    const next: Manifest = {
      schema: 1,
      poiesisVersion: await packageVersion(),
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
      files: nextFiles,
      skills,
      configPatches,
    };
    const nextManifestBytes = serializeManifest(next);
    const nextManifestHash = hashContent(nextManifestBytes);
    const manifestEntry = journal.entries.find((candidate) => candidate.path === manifestPath);
    if (manifestEntry === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the manifest entry", { path: ".poiesis/manifest.json" });
    }
    await hooks?.preManifestWrite?.();
    await journal.replace(manifestEntry, nextManifestBytes);
    await hooks?.postManifestWrite?.();

    // Bootstrap creates the receipt; generation=1, bound to the new
    // manifest digest. The bytes passed to `journal.replace` mirror the
    // canonical `${JSON.stringify(nextReceipt, null, 2)}\n` serialization
    // that `writeReceipt` emits in `src/receipt.ts`. The journal's
    // pre-write identity guard (`expectedPreWriteIdentity` captured as
    // `{ exists: false, kind: "absent" }` because the receipt path is
    // initially absent) catches any foreign receipt that races the
    // transaction before this write.
    const nextReceipt = await buildOwnershipReceipt(resolvedRoot, next);
    const nextReceiptBytes = `${JSON.stringify(nextReceipt, null, 2)}\n`;
    const receiptEntry = journal.entries.find((candidate) => candidate.path === receiptPath);
    if (receiptEntry === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the receipt entry", { path: receiptPath });
    }
    await hooks?.preReceiptReplace?.();
    await journal.replace(receiptEntry, nextReceiptBytes);
    await hooks?.postReceiptReplace?.();

    const report = await doctor(resolvedRoot);
    assertUpdateDoctorGate(report, options.skipSkills === true);
    // Ticket #46: commit the bounded journal after every transaction
    // write has succeeded so the journal-owned directory preimage
    // backups are removed only after commit. `commit()` swallows its
    // own cleanup failures so they cannot turn a committed bootstrap
    // into a failure.
    await journal.commit();
    return { manifest: next, doctor: report };
  } catch (error) {
    // Fail-closed rollback: the bounded journal drives every owned
    // artifact's reverse hash-gated restoration in reverse write order.
    // The transactional `.gitignore` rule retains its own hash-gated
    // rollback (NOT in the journal) because the file is not a
    // Poiesis-owned artifact.
    const diagnostics = await journal.rollback();
    await rollbackDefaultPathGitignore(join(resolvedRoot, ".gitignore"), gitignore.snapshot, gitignore.writtenHash);
    if (diagnostics.length > 0) {
      if (error instanceof PoiesisError) {
        error.details.incompleteRollback = diagnostics;
      } else {
        throw new PoiesisError("ROLLBACK_INCOMPLETE", "Transaction failed and rollback was incomplete", {
          cause: error instanceof Error ? error.message : String(error),
          incompleteRollback: diagnostics,
        });
      }
    }
    throw error;
  }
}

// Re-export the maintenance types we need so callers of this internal
// module don't have to import maintenance.js (which would defeat the
// purpose of keeping the fault-injection seam outside the package root).
export type { MaintenanceOptions, UpdateResult };

/**
 * Spec #190 / ticket #194 — the module-internal transaction dependency seam
 * for the explicit installation-mode MIGRATION.
 *
 * This file is the SINGLE implementation of the authenticated
 * `poiesis migrate install-mode --to private|team` transaction. It accepts a
 * `hooks` parameter so the test suite can drive deterministic failure cases
 * (rollback of both the owned bytes and the index-only removals, foreign-write
 * preservation, drift detection) without monkey-patching internal modules.
 *
 * The function is NOT re-exported via the package's public `dist/index.d.ts`
 * surface: it lives in a module `src/index.ts` does not import. The public
 * `migrateInstallMode` (in `maintenance.ts`) is a thin wrapper that calls
 * `runInstallModeMigrationTransaction` with an empty hooks object, so
 * production callers (CLI, library users) get the real transaction with no test
 * seam in scope — the same arrangement `updateFromConfig` uses.
 *
 * Step layout:
 *   1. authenticate the receipt, then the released manifest shape   (no writes)
 *   2. refuse anything that is not a mode-less installation          (no writes)
 *   3. resolve the installed configuration with the chosen mode     (no writes)
 *   4. plan: block, config, shared profile, index-only removals      (no writes)
 *   5. capture every artifact the plan will write into the journal   (no writes)
 *   6. write `.gitignore`, the shared profile, the local config, the
 *      manifest, and the receipt, then remove the planned paths from the
 *      Git INDEX, then run the doctor gate — rolling all of it back on any
 *      failure
 *
 * Deliberately NOT part of this transaction:
 *
 *   - the OpenCode projection. The chosen mode does not appear in it, so a
 *     migration never rewrites a file the Author's harness reads and never
 *     needs the live model / tracker / delivery probes an `update --config`
 *     reconcile does. The final doctor gate still reports their health.
 *   - `manifest.poiesisVersion`. A migration is not a release crossing; the
 *     recorded runtime identity rides through untouched, so the runtime
 *     identity boundary keeps exactly the meaning it has for every other
 *     guarded surface (`poiesis update` remains the version-crossing route).
 *   - any commit, push, or remote write. The index removals are left STAGED.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PoiesisError } from "./errors.js";
import { hashContent } from "./hash.js";
import { assertManifestAuthority } from "./authority.js";
import { GITIGNORE_RELATIVE_PATH } from "./install-mode.js";
import {
  assertMigrationCaptureIdentity,
  planInstallModeMigration,
  restoreTrackedPaths,
  untrackMigrationPaths,
  type InstallModeMigrationPlan,
} from "./install-mode-migration.js";
import {
  ensureTransitionProfileParents,
  removeEmptyTransitionDirectories,
} from "./install-mode-transition.js";
import { loadManifest, manifestSchema, serializeManifest, type Manifest } from "./manifest.js";
import { assertOwnershipReceipt, ownershipReceiptLocation, type OwnershipReceipt } from "./receipt.js";
import { poiesisPath } from "./paths.js";
import { POIESIS_GENERATED_AGENT_PATHS } from "./templates.js";
import {
  acquireWorkspaceMutationLock,
  ArtifactJournal,
  type ArtifactJournalEntry,
} from "./mutation-transaction.js";
import type { InstallMode } from "./install-mode.js";
// `DoctorReport` is imported as a TYPE ONLY and erased at compile time, so this
// module contributes nothing at runtime to the maintenance load cycle. The
// helpers themselves are reached through a delayed dynamic import, exactly as
// `update-config-internal.ts` does.
import type { DoctorReport } from "./maintenance.js";

const POIESIS_CONFIG_RELATIVE_PATH = ".poiesis/config.jsonc";

/**
 * Journal artifact limit: `.gitignore`, the local config, up to two shared
 * profile files, the manifest, and the receipt. Captured in EXACT write order,
 * so the journal's reverse-order rollback is reverse write order.
 */
const MIGRATION_JOURNAL_LIMIT = 8;

export interface InstallModeMigrationResult {
  manifest: Manifest;
  doctor: DoctorReport;
  /** Sharing mode the installation now states, identical across config, manifest, and block. */
  mode: InstallMode;
  /**
   * Project-relative paths removed from the Git INDEX by this migration. Every
   * one is manifest-proven, byte-identical to what the manifest recorded, and
   * left staged for the Author; the worktree copies are untouched and Poiesis
   * neither committed nor pushed anything.
   */
  untracked: string[];
  /** Shared profile files this migration created. */
  createdProfileFiles: string[];
  /** Shared profile files adopted untouched, for reporting. */
  adoptedProfileFiles: string[];
}

/**
 * Test-only deterministic fault-injection hooks. Each callback fires
 * immediately BEFORE the corresponding write step, or immediately AFTER for the
 * `post*` seams. Throwing simulates an I/O fault and exercises the rollback.
 *
 * The seam is intentionally not exposed through the public
 * `migrateInstallMode` options and is not part of the packed public surface.
 */
export interface InstallModeMigrationHooks {
  /** Exposes the bounded in-memory journal after every artifact is captured. */
  onJournalReady?: (entries: readonly ArtifactJournalEntry[]) => void | Promise<void>;
  /** Called immediately before the managed `.gitignore` block is appended. */
  preGitignoreWrite?: () => void | Promise<void>;
  /** Called immediately AFTER the block is appended. */
  postGitignoreWrite?: () => void | Promise<void>;
  /** Called immediately AFTER every shared profile file is created. */
  postProfileWrite?: () => void | Promise<void>;
  /** Called immediately AFTER the mode-carrying local config is written. */
  postConfigWrite?: () => void | Promise<void>;
  /**
   * Called immediately BEFORE the first index-only removal. Tests use this to
   * make the index disagree with what the plan proved, so the removal fails.
   */
  preIndexUntrack?: () => void | Promise<void>;
  /**
   * Called immediately AFTER the index-only removals and BEFORE the doctor
   * gate. Throwing here is the deterministic way to prove the rollback puts
   * every index entry back while the owned bytes revert.
   */
  postIndexUntrack?: () => void | Promise<void>;
  /** Called immediately AFTER the manifest is advanced. */
  postManifestWrite?: () => void | Promise<void>;
  /** Called immediately AFTER the receipt is advanced. */
  postReceiptReplace?: () => void | Promise<void>;
  /**
   * Called immediately BEFORE the doctor gate. Producing an unhealthy report
   * here proves every owned byte AND every staged removal is reversed, because
   * both were already applied.
   */
  preDoctorGate?: () => void | Promise<void>;
}

/**
 * The next manifest.
 *
 * Built explicitly, and normalized through `manifestSchema` before it is
 * serialized, for one reason that is easy to lose: the ownership receipt binds
 * the digest of `serializeManifest(loadManifest(bytes))`, and `manifestSchema` is
 * a strict object whose parse reorders keys into schema order. A legacy manifest
 * carries no `mode` / `ignoreBlock` keys at all, so adding them through a
 * spread would serialize them AFTER `generatedScripts` and make the digest
 * recorded here disagree with the manifest the next reader loads. The parse is
 * the canonical normalization, not a validation step.
 *
 * `durable` is deliberately DROPPED from every record: it means "the project
 * tracks this artifact on purpose", which was true of a mode-less installation
 * and is true of neither installable mode. Authority checks exactly this
 * classification, so retaining it would make the migrated manifest
 * unauthorized for `doctor`, `update`, and `uninstall`.
 */
function nextMigrationManifest(args: {
  manifest: Manifest;
  plan: InstallModeMigrationPlan;
  configHash: string;
}): Manifest {
  return manifestSchema.parse({
    ...args.manifest,
    schema: 1,
    files: args.manifest.files.map((file) => {
      if (file.path === POIESIS_CONFIG_RELATIVE_PATH) {
        return {
          path: POIESIS_CONFIG_RELATIVE_PATH,
          kind: "generated",
          hash: args.configHash,
          owned: true,
          provenance: "config",
        };
      }
      const { durable: _released, ...rest } = file;
      return rest;
    }),
    mode: args.plan.to,
    ignoreBlock: args.plan.record,
  });
}

/**
 * The local generated config is the ONE owned file this migration rewrites
 * without otherwise reproducing it, so its ownership is proved the way
 * `update --config` proves it: the manifest must record it, as a generated file,
 * and its bytes must still be what Poiesis installed.
 *
 * Without this, a hand-edited config would be read, resolved, and written back
 * with the mode added — silently re-baselining ownership onto content Poiesis
 * no longer recognises, which is exactly what an explicit refusal is for.
 */
async function assertLocalConfigOwnership(root: string, manifest: Manifest): Promise<void> {
  const record = manifest.files.find((file) => file.path === POIESIS_CONFIG_RELATIVE_PATH);
  if (record === undefined) {
    throw new PoiesisError("FILE_OWNERSHIP_UNKNOWN", "Manifest does not prove ownership of the Poiesis config", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
    });
  }
  if (record.kind !== "generated") {
    throw new PoiesisError("FILE_OWNERSHIP_INVALID", "Manifest Poiesis config record must be generated", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
      kind: record.kind,
    });
  }
  const bytes = await readFile(poiesisPath(root, "config.jsonc"));
  const actual = hashContent(bytes);
  if (actual !== record.hash) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Poiesis config has been modified since the last receipt", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
      expected: record.hash,
      actual,
    });
  }
}

/**
 * Doctor gate predicate.
 *
 * Identical in shape to the update gates: a FAIL is the transaction's problem
 * and reverses every byte it wrote and every index entry it removed. `warn` is
 * not a gate — a team profile whose committed lock has drifted is reported, not
 * blocked — and the `skills` check is skipped only when the pre-migration
 * manifest carried no skills at all, which is a pre-existing condition this
 * transaction does not introduce.
 */
function assertMigrationDoctorGate(report: DoctorReport, manifest: Manifest): void {
  const skipSkillsGate = manifest.skills.length === 0;
  const gateFailure = report.checks.find(
    (check) => check.status === "fail" && !(skipSkillsGate && check.id === "skills"),
  );
  if (gateFailure !== undefined) {
    throw new PoiesisError(
      "INSTALL_MODE_MIGRATION_DOCTOR_FAILED",
      "Poiesis installation-mode migration did not pass doctor",
      { report },
    );
  }
}

async function runLockedInstallModeMigration(
  root: string,
  to: InstallMode,
  hooks: InstallModeMigrationHooks,
): Promise<InstallModeMigrationResult> {
  // Delayed dynamic import: maintenance helpers are pulled in only after the
  // top-level load completes, avoiding a runtime circular import back into
  // `maintenance.ts` (which exposes the public wrapper for this transaction).
  const {
    assertOpenCodeConfigNotTracked,
    assertRuntimeVersionMatchesProject,
    doctor,
    isRegularManagedFile,
    packageVersion,
    resolveConfigForRoot,
    verifyGitRepository,
  } = await import("./maintenance.js");

  const resolvedRoot = resolve(root);
  // Receipt-first. The receipt binds this workspace's real path, this
  // repository's common dir, and the trusted manifest digest, so a linked
  // worktree or a prepared candidate workspace that Poiesis does not own cannot
  // reach this transaction at all: its own receipt path is a different file and
  // is absent.
  const manifest = await loadManifest(resolvedRoot);
  const receipt: OwnershipReceipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  // A migration does not cross a runtime release, so the recorded runtime
  // identity must already be the one running. Reported through the migration's
  // own code first, because the crossing route is a command an operator has to
  // be told about: an installation recorded by another release is brought
  // forward by `poiesis update`, exactly as every other guarded lifecycle
  // surface requires, and never silently by a sharing-policy decision.
  const runtime = await packageVersion();
  if (manifest.poiesisVersion !== runtime) {
    throw new PoiesisError(
      "INSTALL_MODE_MIGRATION_VERSION_MISMATCH",
      `This Poiesis installation records runtime ${manifest.poiesisVersion} and is being migrated by ${runtime}. Run \`poiesis update\` to cross the release first; the migration is a sharing decision, not a version crossing`,
      { path: ".poiesis/manifest.json", project: manifest.poiesisVersion, runtime },
    );
  }
  // The canonical shared guard still runs, so the rule stays uniform with every
  // other project-bound lifecycle surface.
  await assertRuntimeVersionMatchesProject(resolvedRoot);
  const config = await resolveConfigForRoot(resolvedRoot);
  // Strict authority over the manifest's OWN recorded version: the shape a
  // released image wrote. A predecessor projection is admitted only by the
  // receipt-gated `update`, so a drifted manifest is refused here by name
  // instead of being migrated on the strength of a shape nothing claims.
  await assertManifestAuthority(resolvedRoot, manifest, config);
  await assertLocalConfigOwnership(resolvedRoot, manifest);
  await verifyGitRepository(resolvedRoot, config);

  // 4. Plan. Every refusal the migration can raise is raised here, before the
  //    caller's first write: an installation that already states a mode, a
  //    symlinked / non-UTF-8 / already-blocked `.gitignore`, an owned artifact
  //    whose bytes or index state changed, a non-portable or contradicting
  //    shared profile.
  const plan = await planInstallModeMigration({
    root: resolvedRoot,
    manifest,
    to,
    resolvedConfig: config,
    generatedAgentPaths: POIESIS_GENERATED_AGENT_PATHS,
  });

  // A private installation must not leave the generated projections invisible to
  // ordinary OpenCode, which is why patching a TRACKED config is refused. This
  // migration is the one surface that can legitimately resolve that condition:
  // when the config is a manifest-proven artifact of THIS installation, the plan
  // removes it from the index while keeping every worktree byte, which is
  // exactly the local-config state a private install requires. A config Poiesis
  // only patches (the Author already had it) is never untracked, so the guard
  // still refuses it.
  if (plan.to === "private" && !plan.untracksOpenCodeConfig) {
    const patched = manifest.configPatches[0]?.file;
    if (patched !== undefined) {
      const path = join(resolvedRoot, patched);
      if (await isRegularManagedFile(resolvedRoot, path)) {
        await assertOpenCodeConfigNotTracked(resolvedRoot, path, "private");
      }
    }
  }

  const configPath = poiesisPath(resolvedRoot, "config.jsonc");
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const receiptPath = await ownershipReceiptLocation(resolvedRoot);
  const nextConfigHash = hashContent(plan.configContent);
  const nextManifest = nextMigrationManifest({ manifest, plan, configHash: nextConfigHash });

  // 5. Capture every artifact in EXACT write order.
  const journal = new ArtifactJournal(MIGRATION_JOURNAL_LIMIT);
  const gitignoreArtifact = await journal.capture(join(resolvedRoot, GITIGNORE_RELATIVE_PATH), "whole-file");
  const profileArtifacts: Array<{ path: string; entry: ArtifactJournalEntry }> = [];
  for (const file of plan.createProfileFiles) {
    profileArtifacts.push({
      path: file.path,
      entry: await journal.capture(join(resolvedRoot, file.path), "whole-file"),
    });
  }
  const configArtifact = await journal.capture(configPath, "whole-file");
  const manifestArtifact = await journal.capture(manifestPath, "whole-file");
  const receiptArtifact = await journal.capture(receiptPath, "whole-file");
  // Bind the plan to what the journal actually captured: the `.gitignore` must
  // still be the content the block was appended to, and a shared profile the
  // plan decided to create must still be absent.
  assertMigrationCaptureIdentity(plan, {
    gitignorePreimage: gitignoreArtifact.preimage,
    profileCaptures: profileArtifacts.map((artifact) => ({
      path: artifact.path,
      physicalExists: artifact.entry.physicalExists,
    })),
  });
  if (configArtifact.preimage === undefined) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Poiesis config is missing or not a regular file", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
    });
  }
  await hooks.onJournalReady?.(journal.entries);
  // The shared profile's parent directory is not a journal entry (the journal
  // owns file preimages), so the migration records which directories it created
  // and the catch block removes the ones still empty.
  const createdProfileDirectories =
    plan.createProfileFiles.length === 0 ? [] : await ensureTransitionProfileParents(resolvedRoot);

  const stagedRemovals: typeof plan.untrack = [];
  try {
    // 6a. Append the ONE managed block. The plan already proved it preserves
    //     every pre-existing byte of `.gitignore`; the journal's pre-write
    //     identity guard closes the window between that proof and this write.
    await hooks.preGitignoreWrite?.();
    await journal.replace(gitignoreArtifact, plan.gitignoreContent);
    await hooks.postGitignoreWrite?.();

    // 6b. Shared profile files, created only where they are absent, so a
    //     migration never overwrites Author-committed project intelligence.
    for (const profile of plan.createProfileFiles) {
      const artifact = profileArtifacts.find((candidate) => candidate.path === profile.path);
      if (artifact === undefined) {
        throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the shared profile entry", {
          path: profile.path,
        });
      }
      await journal.replace(artifact.entry, profile.content);
    }
    await hooks.postProfileWrite?.();

    // 6c. The local config gains the chosen mode, so the installation states
    //     one sharing policy in all three places it is recorded.
    await journal.replace(configArtifact, plan.configContent);
    await hooks.postConfigWrite?.();

    // 6d. Advance the manifest, then the receipt. Receipt identity is preserved:
    //     same installation id, same workspace, same common dir, generation
    //     advanced by exactly ONE and re-bound to the new manifest digest.
    const nextManifestBytes = serializeManifest(nextManifest);
    const nextManifestHash = hashContent(nextManifestBytes);
    await journal.replace(manifestArtifact, nextManifestBytes);
    await hooks.postManifestWrite?.();

    const nextReceipt: OwnershipReceipt = {
      ...receipt,
      manifestDigest: nextManifestHash,
      generation: receipt.generation + 1,
    };
    await journal.replace(receiptArtifact, `${JSON.stringify(nextReceipt, null, 2)}\n`);
    await hooks.postReceiptReplace?.();

    // 6e. Index-only removals, LAST: Git ignores only affect untracked files, so
    //     this is the step that makes the new policy effective for an artifact a
    //     released installation used to track. `git rm --cached` keeps every
    //     worktree byte, leaves the removal STAGED, and never commits or pushes.
    //     The helper restores whatever it already removed if one removal fails.
    await hooks.preIndexUntrack?.();
    if (plan.untrack.length > 0) {
      await untrackMigrationPaths(resolvedRoot, plan.untrack);
      stagedRemovals.push(...plan.untrack);
    }
    await hooks.postIndexUntrack?.();

    // 6f. Doctor gate: pass, or roll back every owned byte AND every staged
    //     index entry.
    await hooks.preDoctorGate?.();
    const report = await doctor(resolvedRoot);
    assertMigrationDoctorGate(report, manifest);
    await journal.commit();
    return {
      manifest: nextManifest,
      doctor: report,
      mode: plan.to,
      untracked: plan.untrack.map((removal) => removal.path),
      createdProfileFiles: plan.createProfileFiles.map((file) => file.path),
      adoptedProfileFiles: [...plan.adoptProfileFiles],
    };
  } catch (error) {
    // 7. Fail-closed rollback. The index is the most recent mutation, so it is
    //    reversed first and in reverse order; then the journal restores (or
    //    removes) every FILE this migration touched, `.gitignore` included; then
    //    a parent directory it created for the shared profile is removed —
    //    deepest first, and only while still empty, so a rollback can never
    //    delete project structure on the strength of a bookkeeping list.
    const indexFailures: string[] = [];
    try {
      await restoreTrackedPaths(resolvedRoot, [...stagedRemovals].reverse());
    } catch (restoreError) {
      indexFailures.push(errorMessage(restoreError));
    }
    const diagnostics = await journal.rollback();
    await removeEmptyTransitionDirectories(resolvedRoot, createdProfileDirectories);
    if (diagnostics.length > 0 || indexFailures.length > 0) {
      if (error instanceof PoiesisError) {
        error.details.incompleteRollback = diagnostics;
        if (indexFailures.length > 0) error.details.incompleteIndexRollback = indexFailures;
      } else {
        throw new PoiesisError("ROLLBACK_INCOMPLETE", "Migration failed and rollback was incomplete", {
          cause: error instanceof Error ? error.message : String(error),
          incompleteRollback: diagnostics,
          incompleteIndexRollback: indexFailures,
        });
      }
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof PoiesisError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The single implementation of the authenticated migration transaction.
 * Production callers MUST NOT supply hooks; the public `migrateInstallMode`
 * always passes an empty hooks object.
 */
export async function runInstallModeMigrationTransaction(
  root: string,
  to: InstallMode,
  hooks: InstallModeMigrationHooks = {},
): Promise<InstallModeMigrationResult> {
  const lock = await acquireWorkspaceMutationLock(resolve(root));
  let transactionError: unknown;
  try {
    return await runLockedInstallModeMigration(root, to, hooks);
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
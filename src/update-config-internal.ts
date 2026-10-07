/**
 * Module-internal transaction dependency seam for `update --config`.
 *
 * This file is the SINGLE implementation of the authenticated
 * `poiesis update --config <file>` transaction. It accepts a `hooks`
 * parameter so the test suite can drive deterministic failure cases
 * (rollback, foreign-write preservation, drift detection) without
 * monkey-patching internal modules.
 *
 * The function is NOT re-exported via the package's public
 * `dist/index.d.ts` surface: it lives in a module that `src/index.ts`
 * does not import. The public `updateFromConfig` (in `maintenance.ts`)
 * is a thin wrapper that calls `runUpdateConfigTransaction` with an
 * empty hooks object, so production callers (CLI, library users) get
 * the real transaction with no test seam in scope.
 *
 * The public `UpdateConfigOptions` type intentionally does NOT expose
 * any hook field; the security-sensitive fault injection surface is
 * confined to this internal file.
 *
 * Spec #190 / ticket #191 — this transaction no longer touches
 * `package.json` at all. Invoking Poiesis must not require a project
 * manifest mutation, so the `scripts.poiesis` reconcile this file used to
 * perform (and its whole snapshot + written-hash rollback apparatus) is
 * gone. That makes a config no-op a genuine whole-project no-op again:
 * `setModel` reaching an already-current value now returns without any
 * second surface to reconcile, and the journal drives the only writes.
 *
 * Spec #190 / ticket #193 — this transaction is ALSO the explicit
 * `Private <-> Team` transition surface. `mode` is part of the config an
 * operator hands to `poiesis update --config`, so stating a different one
 * IS the explicit request, and there is no second command to learn and no
 * hidden activation to discover. Two rules make that coherent:
 *
 *   - a config that OMITS `mode` never drops the installed one. An install
 *     that chose a sharing policy keeps it through an unrelated config
 *     update, so `.poiesis/config.jsonc` can never silently disagree with
 *     the manifest and the block it was written with;
 *   - a config that STATES a different `mode` transitions the whole sharing
 *     surface — the one managed `.gitignore` block and, going to `team`, the
 *     shareable project profile — inside THIS transaction, so it is receipt
 *     authenticated, journal-captured, doctor-gated, and rolled back by the
 *     same machinery as every other owned byte. Planning lives in
 *     `src/install-mode-transition.ts` and is read-only; this file owns the
 *     writes.
 */
import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, parseJsonc, serializeConfig, validateConfig, type PoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import { exists, readUtf8 } from "./fs.js";
import { hashContent } from "./hash.js";
import { assertManifestAuthority, nextAdapterPatches } from "./authority.js";
import {
  assertTransitionCaptureIdentity,
  ensureTransitionProfileParents,
  planInstallModeTransition,
  removeEmptyTransitionDirectories,
  type InstallModeTransitionPlan,
} from "./install-mode-transition.js";
import { GITIGNORE_RELATIVE_PATH } from "./install-mode.js";
import {
  assertOwnershipReceipt,
  ownershipReceiptLocation,
  type OwnershipReceipt,
} from "./receipt.js";
import { loadManifest, serializeManifest, type ManagedFile, type Manifest } from "./manifest.js";
import { POIESIS_GENERATED_AGENT_PATHS } from "./templates.js";
import {
  desiredOpenCodePatches,
  OPENCODE_ADAPTER_VERSION,
  CERTIFIED_OPENCODE_VERSION,
  CERTIFIED_OPENCODE_VERSIONS,
} from "./opencode.js";
import { assertNoDuplicateProperties } from "./opencode-config-validator.js";
import { assertOpenCodeOwnershipAgainstSnapshot, projectOpenCodePayload } from "./opencode-preflight.js";
import { poiesisPath } from "./paths.js";
import type { ConfigPatch } from "./manifest.js";
import type { ResolvedPoiesisConfig } from "./config.js";
import type { DoctorReport, UpdateResult } from "./maintenance.js";
import {
  acquireWorkspaceMutationLock,
  ArtifactJournal,
  type ArtifactJournalEntry,
} from "./mutation-transaction.js";
// Maintenance helpers are accessed via delayed dynamic import inside
// `runUpdateConfigTransaction` to avoid a top-level runtime circular
// import between this module and `maintenance.ts`. Only the types
// `MaintenanceOptions` / `UpdateResult` are statically imported (via
// `import type`) and erased at compile time, so they contribute nothing
// to runtime.

type JsonObject = Record<string, unknown>;

const POIESIS_CONFIG_RELATIVE_PATH = ".poiesis/config.jsonc";

/**
 * Test-only deterministic fault-injection hooks used by `runUpdateConfigTransaction`.
 * Each callback fires immediately BEFORE the corresponding write step (or
 * immediately AFTER for `postManifestWrite` / `postReceiptReplace`). Throwing
 * from a hook simulates an I/O fault and exercises the rollback path.
 *
 * The seam is intentionally not exposed via `UpdateConfigOptions` and is not
 * part of the packed public surface. Tests import `UpdateTransactionHooks`
 * and `runUpdateConfigTransaction` directly from this internal module.
 */
export interface UpdateTransactionHooks {
  /** Called after the exclusive per-workspace mutation lock is acquired. */
  postLockAcquired?: () => void | Promise<void>;
  /** Exposes the bounded in-memory journal to transaction tests. */
  onJournalReady?: (entries: readonly ArtifactJournalEntry[]) => void | Promise<void>;
  /** Called immediately before atomic-writing the new `.poiesis/config.jsonc`. */
  prePoiesisConfigWrite?: () => void | Promise<void>;
  /** Called immediately after writing the new Poiesis config. */
  postPoiesisConfigWrite?: () => void | Promise<void>;
  /** Called immediately before applying the OpenCode projection to the managed config. */
  preOpenCodeApply?: () => void | Promise<void>;
  /** Called immediately after writing the new OpenCode config. */
  postOpenCodeApply?: () => void | Promise<void>;
  /** Called immediately before atomic-writing the new `.poiesis/manifest.json`. */
  preManifestWrite?: () => void | Promise<void>;
  /** Called immediately before `replaceOwnershipReceipt` advances generation. */
  preReceiptReplace?: () => void | Promise<void>;
  /**
   * Called immediately AFTER `replaceOwnershipReceipt` returns and BEFORE
   * the doctor gate runs. This seam exists for fail-closed rollback tests
   * that need to inject foreign manifest or receipt bytes between the
   * transaction's last write and the doctor gate, so the rollback path
   * can prove it leaves foreign content intact.
   */
  postReceiptReplace?: () => void | Promise<void>;
  /**
   * Called immediately AFTER the atomic write of the new
   * `.poiesis/manifest.json` completes and BEFORE the transaction
   * observes the manifest (receipt replace, doctor gate, ownership
   * hashFile). This seam exists for fail-closed rollback tests that need
   * to inject a foreign replacement in the narrow window between our
   * write and any subsequent observation, so the rollback path can
   * prove it preserves the foreign bytes instead of rewinding the
   * manifest to our preimage.
   */
  postManifestWrite?: () => void | Promise<void>;
  /**
   * Called immediately BEFORE `doctor()` in the no-op branch — after
   * the byte-hash match short-circuit AND before the extracted
   * `assertUpdateConfigDoctorGate` helper runs. This seam exists for
   * tests that need to deterministically make the no-op doctor
   * unhealthy (e.g. by toggling a `POIESIS_TEST_OPENCODE_FAIL`
   * environment variable that the fake `opencode debug config` script
   * honours) so the helper can prove it throws `UPDATE_DOCTOR_FAILED`
   * in the no-op path without ever mutating any owned byte, mirroring
   * the post-mutation fail-closed rollback. Production callers leave
   * this hook unset; the seam is internal to `UpdateTransactionHooks`
   * and intentionally NOT re-exported via `dist/index.d.ts`.
   */
  preNoopDoctor?: () => void | Promise<void>;
  /**
   * @internal test seam ONLY. Forces the OpenCode `onWritten` callback
   * to receive a different content than `preflightSerialized`, simulating
   * projection drift after preflight. Used by the rollback-identity
   * regression test to exercise the drift throw path deterministically.
   * Production callers leave this unset; the seam is internal to
   * `UpdateTransactionHooks` and intentionally NOT re-exported via
   * `dist/index.d.ts`.
   */
  injectDriftedOnWrittenContent?: (defaultContent: string) => string;
  /**
   * Spec #190 / ticket #193 — fires immediately BEFORE the transition
   * writes its first byte (the relabelled `.gitignore` block). Tests that
   * need a concurrent writer to land inside the transaction's window use
   * this to prove the bounded journal detects the replacement and preserves
   * the foreign bytes. Production callers leave it unset.
   */
  preModeTransitionApply?: () => void | Promise<void>;
  /**
   * Spec #190 / ticket #193 — fires immediately AFTER the `.gitignore` block
   * is written and BEFORE the shared profile files are created. A test that
   * makes the profile appear here exercises "this file was replaced while
   * the transaction ran" against a file the journal captured as ABSENT.
   */
  postModeTransitionGitignore?: () => void | Promise<void>;
  /**
   * Spec #190 / ticket #193 — fires immediately AFTER every transition
   * write completes and BEFORE the manifest is advanced. Throwing here is
   * the deterministic way to prove the rollback restores the relabelled
   * `.gitignore` byte-for-byte and removes the profile files this run
   * created, while the manifest and receipt never advance.
   */
  postModeTransitionApply?: () => void | Promise<void>;
}

/**
 * Local mirror of the public `UpdateConfigOptions` type. The public
 * interface (in `maintenance.ts`) is the only type re-exported via
 * `dist/index.d.ts`; this mirror is used by the internal transaction
 * runner so the public surface stays narrow.
 */
export interface UpdateConfigOptions {
  bootstrapLegacyOwnership?: boolean;
  skipSkills?: boolean;
  allowFixtureAdapters?: boolean;
}

function assertCompatibleUpdateConfigOptions(options: UpdateConfigOptions): void {
  const incompatible: Array<string> = [];
  if (options.bootstrapLegacyOwnership === true) incompatible.push("bootstrapLegacyOwnership");
  if (options.skipSkills === true) incompatible.push("skipSkills");
  if (options.allowFixtureAdapters === true) incompatible.push("allowFixtureAdapters");
  if (incompatible.length > 0) {
    throw new PoiesisError("INCOMPATIBLE_UPDATE_OPTIONS", "update --config cannot combine with other update options", {
      incompatible,
    });
  }
}

/**
 * Inline copy of the lstat-and-validate step from `isRegularManagedFile`
 * in `maintenance.ts`. Used by `assertPoiesisConfigOwnership` to avoid
 * pulling maintenance into this module's load cycle.
 */
async function isRegularFileNoFollow(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertPoiesisConfigOwnership(root: string, manifest: Manifest): Promise<{ content: Buffer; record: ManagedFile }> {
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
  const path = join(root, POIESIS_CONFIG_RELATIVE_PATH);
  if (!(await exists(path)) || !(await isRegularFileNoFollow(path))) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Poiesis config is missing or not a regular file", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
    });
  }
  const content = await readFile(path);
  if (hashContent(content) !== record.hash) {
    throw new PoiesisError("FILE_OWNERSHIP_LOST", "Poiesis config has been modified since the last receipt", {
      path: POIESIS_CONFIG_RELATIVE_PATH,
      expected: record.hash,
      actual: hashContent(content),
    });
  }
  return { content, record };
}

async function identifyManagedOpenCodeConfig(manifest: Manifest): Promise<{ relativePath: string; configPatches: ConfigPatch[] }> {
  const files = [...new Set(manifest.configPatches.map((patch) => patch.file))];
  if (files.length !== 1) {
    throw new PoiesisError("CONFIG_OWNERSHIP_INVALID", "Manifest must identify exactly one managed OpenCode config", {
      files,
    });
  }
  return { relativePath: files[0]!, configPatches: manifest.configPatches };
}

/**
 * Doctor gate predicate shared by the no-op branch and the
 * post-mutation branch of `runUpdateConfigTransaction`. The transaction
 * is config-only, so `skills` health is unrelated to the change under
 * transaction; a `skills` check failure is ignored ONLY when the
 * pre-transaction manifest had a `skills` array of length zero
 * (i.e. defaults were never populated by an `init` run that included
 * skills). Every other doctor failure throws `UPDATE_DOCTOR_FAILED`
 * with the existing message and the full report, regardless of which
 * branch invoked the helper — so the no-op path now fails closed
 * identically to the post-mutation path.
 */
function assertUpdateConfigDoctorGate(report: DoctorReport, manifest: Manifest): void {
  const skipSkillsGate = manifest.skills.length === 0;
  const gateFailure = report.checks.find((check) => check.status === "fail" && !(skipSkillsGate && check.id === "skills"));
  if (gateFailure !== undefined) {
    throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Poiesis update --config did not pass doctor", { report });
  }
}

/**
 * Adapter-fixture invariant for `update --config`. Mirrors
 * `maintenance.ts::init` which requires `--allow-fixtures` to introduce
 * a fixture tracker or fixture delivery; the same contract applies to
 * any `update --config` that would introduce or alter the fixture
 * tracker/delivery. The only escape is a byte-equal no-op update where
 * the proposed config matches the current installed config — that path
 * returns the existing manifest unchanged and is what canonical
 * no-op tests already exercise. Any non-no-op proposed config that
 * contains `provider: "fixture"` for tracker OR `adapter: "fixture"`
 * for any delivery target fails closed BEFORE any write.
 *
 * `update --config` rejects the `allowFixtureAdapters` option up front,
 * so this invariant is the only line of defense against an introduced
 * or altered fixture configuration in this transaction.
 */
function detectFixtureAdapter(config: { tracker?: { provider: string; project?: string | undefined } | undefined; delivery?: Record<string, { adapter: string; path?: string | undefined }> | undefined }): { fixture: boolean; targets: string[]; signature: string } {
  const targets: string[] = [];
  const parts: string[] = [];
  if (config.tracker?.provider === "fixture") {
    targets.push("tracker");
    parts.push(`tracker=${config.tracker.provider}:${config.tracker.project ?? ""}`);
  }
  for (const target of ["preview", "staging", "production"] as const) {
    const adapter = config.delivery?.[target];
    if (adapter?.adapter === "fixture") {
      targets.push(`delivery.${target}`);
      parts.push(`delivery.${target}=${adapter.adapter}:${adapter.path ?? ""}`);
    }
  }
  return { fixture: targets.length > 0, targets, signature: parts.join("|") };
}

function assertUpdateConfigNoFixtureIntroduceOrAlter(
  proposed: ResolvedPoiesisConfig,
  current: { tracker?: { provider: string; project?: string | undefined } | undefined; delivery?: Record<string, { adapter: string; path?: string | undefined }> | undefined },
  poiesisConfigBytesMatch: boolean,
  openCodeBytesMatch: boolean,
): void {
  // The no-op escape: if the proposed config bytes match the current
  // installed bytes for both the Poiesis config and the OpenCode
  // projection, the transaction is a no-op (no writes occur). Canonical
  // no-op behavior must remain so already-installed fixture
  // configurations can be re-asserted by an identical config.
  if (poiesisConfigBytesMatch && openCodeBytesMatch) return;

  const proposedFixture = detectFixtureAdapter(proposed);
  const currentFixture = detectFixtureAdapter(current);

  // Introduction: proposed has fixture, current does not.
  const introduction = proposedFixture.fixture && !currentFixture.fixture;
  // Alteration: both have fixture, but their fixture-specific fields
  // (provider + project for tracker; adapter + path per delivery
  // target) differ. Changing non-fixture fields while leaving the
  // fixture signature byte-equal is permitted (canonical test
  // consumers update other fields freely).
  const alteration = proposedFixture.fixture && currentFixture.fixture
    && proposedFixture.signature !== currentFixture.signature;

  if (introduction || alteration) {
    throw new PoiesisError(
      "FIXTURE_ADAPTER_NOT_AUTHORIZED",
      "update --config cannot introduce or alter fixture tracker/delivery without explicit allow-fixtures authorization",
      {
        proposedFixtureTargets: proposedFixture.targets,
        currentFixtureTargets: currentFixture.targets,
        introduced: introduction,
        altered: alteration,
      },
    );
  }
}

/**
 * Module-internal transaction dependency seam for `updateFromConfig`. The
 * function is the single implementation of the authenticated `update --config`
 * transaction and accepts a `hooks` parameter that is intentionally NOT exposed
 * via `UpdateConfigOptions` (and therefore not in the packed `dist/index.d.ts`).
 *
 * Tests use the public `runUpdateConfigTransaction` re-export below to drive
 * deterministic failure cases without monkey-patching internal modules.
 * Production callers (CLI, library users) MUST NOT supply hooks; the public
 * `updateFromConfig` always passes an empty hooks object, so the hooks do not
 * change production behavior when omitted (each hook is short-circuited via
 * optional chaining and the real `atomicWrite` / `applyOpenCodeConfig` /
 * `replaceOwnershipReceipt` paths run).
 *
 * Step layout:
 *   1. parse + validate + assertResolvedConfig       (no I/O writes)
 *   2. ownership / auth / git / opencode-version      (no I/O writes)
 *   3. auto-discover defaults                         (no I/O writes)
 *   4. env validation: git / models / tracker / ...  (no I/O writes)
 *   5. snapshot all bytes we will compare against     (read; no writes)
 *   6. pure preflight projection (projectOpenCodePayload) — pure, no debug call
 *   7. no-op detection + doctor gate (no writes until doctor passes)
 *   8. validateOpenCodeConfigPayload(preflightSerialized) — first debug call
 *      against the same fixture/threshold state used by `doctor()`; rejection
 *      surfaces as `UPDATE_DOCTOR_FAILED` (the same code doctor gate throws)
 *   9. snapshot manifest preimage (read; used by fail-closed rollback below)
 *   10. atomicWrite(.poiesis/config.jsonc)
 *   11. applyOpenCodeConfig (writes opencode.jsonc, calls onWritten bytes)
 *   12. compute next manifest, atomicWrite(manifest.json)
 *   13. replaceOwnershipReceipt
 *   14. doctor gate (final) → UPDATE_DOCTOR_FAILED on fail, else return result
 *
 * Step 8 is the new preflight schema call placed AFTER the no-op doctor
 * branch and BEFORE any mutating snapshot/write, per ticket #37 correction 2.
 * The no-op path deliberately relies on `doctor()` to detect the schema
 * failure (which yields the same `UPDATE_DOCTOR_FAILED` code via the
 * `assertUpdateConfigDoctorGate` predicate below). Both paths therefore
 * converge on `UPDATE_DOCTOR_FAILED` for production callers.
 */
async function runLockedUpdateConfigTransaction(
  root: string,
  configPath: string,
  options: UpdateConfigOptions,
  hooks: UpdateTransactionHooks,
): Promise<UpdateResult> {
  // Delayed dynamic import: pulls maintenance helpers in only after the
  // top-level load completes, avoiding a runtime circular import back
  // into `maintenance.ts`. Types only (`UpdateResult`) are imported
  // statically and erased at compile time.
  const {
    assertOpenCodeConfigNotTracked,
    assertResolvedConfig,
    autoResolveConfigDefaults,
    doctor,
    isRegularManagedFile,
    packageVersion,
    validateOpenCodeConfigPayload,
    verifyDeliveryConfiguration,
    verifyGitRepository,
    verifyModels,
    verifyTracker,
  } = await import("./maintenance.js");

  assertCompatibleUpdateConfigOptions(options);
  const resolvedRoot = resolve(root);
  const resolvedConfigPath = resolve(configPath);

  // 1. Strictly parse, validate, and resolve the proposed config BEFORE any side effect.
  const proposedConfigRaw = await readUtf8(resolvedConfigPath);
  const proposedConfig = validateConfig(parseJsonc<unknown>(proposedConfigRaw, resolvedConfigPath), resolvedConfigPath);
  assertResolvedConfig(proposedConfig);

  // 2. Authenticate the trusted receipt FIRST, before any other ownership check
  //    consumes manifest records. This locks in the receipt's claim about the
  //    trusted manifest digest; subsequent authority and Poiesis-config checks
  //    operate against that trusted snapshot.
  const manifest = await loadManifest(resolvedRoot);
  const receipt = await assertOwnershipReceipt(resolvedRoot, manifest);
  const currentConfig = await loadConfig(resolvedRoot);
  // Strict authority check: `update --config` is a narrowly scoped
  // transaction that does NOT recognize the v1.0.0/v1.0.1/v1.0.2 predecessor
  // projection. Predecessor tolerance is intentionally confined to receipt-
  // authenticated normal `update()` and explicit 1.0.0 bootstrap. A receipt-
  // bound predecessor manifest that reaches this path fails closed with
  // MANIFEST_AUTHORITY_INVALID before any write.
  await assertManifestAuthority(resolvedRoot, manifest, currentConfig);
  const { content: currentConfigBytes } = await assertPoiesisConfigOwnership(resolvedRoot, manifest);
  await verifyGitRepository(resolvedRoot);
  // The transaction's actual capability probes (`models` via
  // `verifyModels`, V1 schema via `validateOpenCodeConfigPayload`) run
  // below. A blanket `--version` probe here was redundant and is
  // removed; the certified-set flag is informational metadata, not
  // a safety boundary, and no operation in this transaction depends
  // on it.
  const { relativePath: openCodeRelativePath, configPatches: openCodeConfigPatches } = await identifyManagedOpenCodeConfig(manifest);
  const openCodeConfigPath = join(resolvedRoot, openCodeRelativePath);
  if (!(await exists(openCodeConfigPath)) || !(await isRegularFileNoFollow(openCodeConfigPath))) {
    throw new PoiesisError("CONFIG_OWNERSHIP_LOST", "Managed OpenCode config is missing or not a regular file", {
      file: openCodeRelativePath,
    });
  }

  // 3. Auto-discover default fields on the proposed config (without writing) so we
  //    can resolve fully. The returned `ResolvedPoiesisConfig` carries the
  //    discovered repository remote, integration branch, tracker project, and
  //    verification commands; it is the value used for every downstream step
  //    (delivery check, OpenCode projection, serialization, and next manifest
  //    content). Discovered defaults are persisted because this is the value
  //    that is written to `.poiesis/config.jsonc`, projected onto the OpenCode
  //    config, and baked into the new manifest entry.
  const { config: autoResolvedConfig } = await autoResolveConfigDefaults(resolvedRoot, proposedConfig);
  // Spec #190 / ticket #193 — the installed mode is CARRIED FORWARD when the
  // proposed config omits it. `mode` is optional in the schema so every
  // pre-Spec #190 config still parses, which means an unrelated config update
  // could otherwise write a config that no longer states the sharing mode its
  // manifest and its `.gitignore` block were written with. The Author picks a
  // mode once, explicitly; they do not re-pick it every time they change a
  // model id. Only an EXPLICIT different mode transitions the installation.
  const effectiveMode = autoResolvedConfig.mode ?? manifest.mode;
  const resolvedConfigWithDefaults: ResolvedPoiesisConfig = {
    ...autoResolvedConfig,
    ...(effectiveMode === undefined ? {} : { mode: effectiveMode }),
  };

  // 4. Complete environment validation BEFORE the first write. The narrowest
  //    internal helpers from `init` are reused so a missing model, an
  //    unreachable tracker, or an unsupported delivery adapter fails closed
  //    with the same error code the doctor gate would later report, and
  //    without ever touching the Poiesis config, the OpenCode config, the
  //    manifest, or the ownership receipt. `verifyGitRepository` is called
  //    with the resolved config so the discovered remote and integration
  //    branch are validated against the live Git state. `verifyModels` runs
  //    the same model-inventory probe the doctor gate would run, against the
  //    resolved reasoning and execution models. `verifyTracker` and
  //    `verifyDeliveryConfiguration` cover the same ground the doctor gate
  //    covers for `tracker` and `delivery`; their return values are
  //    intentionally discarded because the `update --config` surface rejects
  //    `allowFixtureAdapters` up front via `assertCompatibleUpdateConfigOptions`,
  //    but the call still validates the resolved adapter names and the live
  //    tracker reachability so a foreign tracker change cannot land in the
  //    transaction before the first write.
  await verifyGitRepository(resolvedRoot, resolvedConfigWithDefaults);
  await verifyModels(resolvedRoot, resolvedConfigWithDefaults);
  await verifyTracker(resolvedRoot, resolvedConfigWithDefaults);
  verifyDeliveryConfiguration(resolvedRoot, resolvedConfigWithDefaults);

  // 5. Snapshot everything we are about to mutate. The OpenCode config bytes
  //    are read ONCE here; the parsed form is reused for (a) manifest patch
  //    ownership validation below, (b) the pure preflight projection, and
  //    (c) the apply step's `expectedContent` byte identity. This eliminates
  //    the disk re-read that `assertConfigPatchesOwned` previously performed
  //    for the OpenCode config. We also reject non-round-tripping UTF-8 so
  //    the helper's parse-once contract holds at every downstream step.
  const newConfigContent = serializeConfig(resolvedConfigWithDefaults);
  const newConfigHash = hashContent(newConfigContent);
  const openCodeConfigCurrentBytes = await readFile(openCodeConfigPath);
  if (!Buffer.from(openCodeConfigCurrentBytes.toString("utf8"), "utf8").equals(openCodeConfigCurrentBytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config is not valid UTF-8", {
      file: openCodeRelativePath,
    });
  }
  const currentOpenCodeContentString = openCodeConfigCurrentBytes.toString("utf8");
  // Reject duplicate managed properties in the CURRENT OpenCode config
  // bytes BEFORE the parse-snapshot ownership check, no-op detection,
  // projection, or any writes. The canonical JSONC parser resolves
  // duplicate object keys to the LAST occurrence; the manifest's
  // recorded `installed` value may match that last occurrence, allowing
  // an earlier (foreign) duplicate value to silently overwrite the
  // owned patch on the next transaction without raising
  // CONFIG_OWNERSHIP_LOST. Reuses the existing
  // `assertNoDuplicateProperties` canonical validator (init-side uses
  // the same helper via `assertOpenCodeContentAvailable`); fail-closed
  // with the same `INSTALL_PATH_CONFLICT` code and the same `property`
  // detail shape.
  assertNoDuplicateProperties(currentOpenCodeContentString, openCodeConfigPath);
  const currentOpenCodeJson = parseJsonc<JsonObject>(currentOpenCodeContentString, openCodeConfigPath);

  // 5a. Validate every recorded config patch for the OpenCode config against
  //     the SINGLE parsed snapshot captured in step 5. Replaces the disk
  //     re-read that the maintenance helper `assertConfigPatchesOwned`
  //     previously performed for the OpenCode config path. Throws
  //     `CONFIG_OWNERSHIP_LOST` on first mismatch — before any helper call,
  //     any no-op branch, and any schema validation. Production callers will
  //     only ever need this check when a malicious or out-of-band writer has
  //     tampered with the OpenCode config between the last receipt and the
  //     current transaction.
  assertOpenCodeOwnershipAgainstSnapshot({
    root: resolvedRoot,
    configPath: openCodeConfigPath,
    parsedSnapshot: currentOpenCodeJson,
    patches: openCodeConfigPatches,
  });

  // 6. Pure preflight projection. The pure helper runs once here with the
  //    current snapshot and the resolved `desiredOpenCodePatches`; the apply
  //    step (step 10) calls the SAME helper with the SAME inputs, so the
  //    `serialized` returned here equals what `applyOpenCodeConfig` will
  //    attempt to atomicWrite. No filesystem work happens here — this is a
  //    pure function call. Specifically: NO `opencode debug config`
  //    invocation at this step (the pure projection does not need a debug
  //    probe). The schema validation is moved to step 8 below. The
  //    exact-version canonical route `pnpm dlx poiesis-cli@X` is sourced
  //    from `await packageVersion()` (the new package version this
  //    transaction is installing) so the projected OpenCode config always
  //    matches the package on disk after a successful apply.
  const nextPoiesisVersion = await packageVersion();
  const desiredOpenCodeProjectionPatches = desiredOpenCodePatches(resolvedConfigWithDefaults, nextPoiesisVersion);
  const { serialized: preflightSerialized, configPatches: projectedOpenCodePatches } = projectOpenCodePayload({
    root: resolvedRoot,
    configPath: openCodeConfigPath,
    currentContent: currentOpenCodeContentString,
    patches: desiredOpenCodeProjectionPatches,
  });

  // 6a. Spec #190 / ticket #193 — decide whether an EXPLICIT sharing mode was
  // requested, and refuse the request this transaction cannot honour.
  //
  // Read the candidate's OWN mode rather than the carry-forwarded one. The
  // candidate is what the Author said; `effectiveMode` is what this run will
  // write, and conflating the two is what previously let a config land that
  // the manifest and the `.gitignore` block never agreed with.
  //
  // An EXPLICIT mode against an installation that records none is refused, not
  // absorbed. A pre-Spec #190 manifest states no mode, owns no block, and has
  // no shared profile, so writing `mode` into `.poiesis/config.jsonc` here
  // would leave the installation stating three different things: a mode in the
  // config, no mode in the manifest, and a block that names no sharing policy
  // at all. The next reader would have to guess which one was meant, and
  // `uninstall` would have a config mode with nothing to reverse. Giving that
  // installation a mode is a migration decision with its own authority
  // questions, so this refuses and names what is missing instead — the same
  // `INSTALL_MODE_TRANSITION_UNSUPPORTED` the planner raises for an
  // unblockable installation, because it is the same condition seen from the
  // cheaper side.
  //
  // The omission case is untouched: a candidate that says nothing about
  // sharing is an ordinary config update, and `effectiveMode` stays undefined
  // so a legacy installation keeps behaving exactly as it did.
  const requestedMode = autoResolvedConfig.mode;
  const installedMode = manifest.mode;
  const transitionRequested = requestedMode !== undefined && requestedMode !== installedMode;
  if (transitionRequested && installedMode === undefined) {
    throw new PoiesisError(
      "INSTALL_MODE_TRANSITION_UNSUPPORTED",
      `This Poiesis installation records no sharing mode, so \`${requestedMode}\` cannot be applied to it. Re-install with \`poiesis init\` and choose private or team, or omit \`mode\` from this config to update the installation without changing how it shares`,
      { path: ".poiesis/manifest.json", requested: requestedMode, recorded: null },
    );
  }
  //
  // Going to `private` re-runs the tracked-OpenCode-config guard `init`
  // applies, and it runs HERE rather than with the rest of the plan because it
  // is the cheapest possible statement of the rule and the one that decides
  // whether this transition is coherent at all: a private installation must
  // not leave the generated projections invisible to ordinary OpenCode, and
  // patching a tracked config would put that generated edit into shared
  // project history. A team installation that has since committed its config
  // therefore cannot quietly become private. The check belongs to the TARGET
  // mode, not to the act of installation, which is why it is reused here.
  if (transitionRequested && requestedMode === "private") {
    await assertOpenCodeConfigNotTracked(resolvedRoot, openCodeConfigPath, "private");
  }

  // 7. No-op detection compares both captured serialized files directly with
  //    the complete intended payloads. A pre-existing OpenCode config is owned
  //    only through manifest config patches, so it deliberately has no
  //    whole-file manifest record to consult here. Direct byte equality keeps
  //    that patch-only ownership intact while recognizing that the projection
  //    would write exactly the bytes already on disk. Do NOT advance generation;
  //    return the existing manifest unchanged.
  const poiesisConfigBytesMatch = currentConfigBytes.equals(Buffer.from(newConfigContent, "utf8"));
  const openCodeBytesMatch = openCodeConfigCurrentBytes.equals(Buffer.from(preflightSerialized, "utf8"));
  // Adapter-fixture invariant. Must run AFTER the bytes are computed
  // (so the no-op escape can be honored) but BEFORE the no-op branch
  // returns — fail closed before any mutation, and before any
  // no-op doctor gate that would otherwise silently let a fixture
  // config through. The byte-equal comparison above is reused as
  // the only escape (an already-installed fixture configuration
  // may be re-asserted by an identical config; any non-no-op
  // proposed config containing `adapter: "fixture"` is rejected).
  assertUpdateConfigNoFixtureIntroduceOrAlter(
    resolvedConfigWithDefaults,
    currentConfig,
    poiesisConfigBytesMatch,
    openCodeBytesMatch,
  );
  // Spec #190 / ticket #193 — a pending mode transition is never a no-op, even
  // if the config and OpenCode projection happen to serialize identically. The
  // `.gitignore` block and the manifest still have to advance, so returning the
  // existing manifest here would leave the installation stating two different
  // sharing modes at once.
  if (poiesisConfigBytesMatch && openCodeBytesMatch && !transitionRequested) {
    // No-op doctor gate. The `preNoopDoctor` seam fires BEFORE `doctor()`
    // so tests can deterministically fail the gate (e.g. by toggling a
    // doctor-failure environment variable) and prove the extracted
    // helper throws `UPDATE_DOCTOR_FAILED` without ever mutating any
    // owned byte. Production callers leave the seam unset, so it is a
    // no-op and doctor runs exactly as before. Note: in this branch, the
    // `opencode-schema` check happens through `doctor()` → which calls the
    // same `validateOpenCodeConfig` (debug config), so the no-op path and
    // the non-no-op path converge on the same `UPDATE_DOCTOR_FAILED` code
    // on schema rejection.
    await hooks?.preNoopDoctor?.();
    // Spec #190 / ticket #191: this is now a genuine whole-project no-op.
    // `package.json` is no longer an artifact Poiesis mutates at all, so a
    // config no-op has nothing left to reconcile.
    const report = await doctor(resolvedRoot);
    assertUpdateConfigDoctorGate(report, manifest);
    return { manifest, doctor: report };
  }

  // 8. Validate the projected (post-write) OpenCode config payload against the
  //    OpenCode schema. Runs an `opencode debug config` invocation against a
  //    temp directory that contains exactly the preflight's serialized bytes
  //    (deterministic for the current input), via the maintenance helper
  //    `validateOpenCodeConfigPayload` directly with its pre-#37 error
  //    semantics. This is the FIRST debug call the transaction makes after
  //    `init`'s validateOpenCodeConfigPayload; the threshold-counter stateful
  //    fake uses this ordering to delay the failure beyond `init` (`init`
  //    consumes call #1; this step consumes call #2; doctor gate consumes
  //    call #3). The call is unconditional for non-no-op candidates — the
  //    no-op branch above already returned. The no-op branch is the only
  //    path that surfaces OpenCode schema failures as `UPDATE_DOCTOR_FAILED`
  //    (via doctor gate); the mutating preflight here preserves
  //    `validateOpenCodeConfigPayload`'s preexisting error code on rejection.
  await validateOpenCodeConfigPayload(preflightSerialized);

  // 8a. Spec #190 / ticket #193 — plan the explicit Private <-> Team
  // transition. Deliberately the LAST read-only step before the journal opens:
  // planning and capturing are separate observations, and the narrower the gap
  // between them, the less state the plan can be stale about. Everything the
  // transition refuses — an edited / missing / mislabelled / duplicated /
  // malformed block, a non-portable profile, a contradicting committed profile
  // — surfaces from this read-only step with the offending path in its details.
  const transition: InstallModeTransitionPlan | undefined = transitionRequested
    ? await planInstallModeTransition({
        root: resolvedRoot,
        manifest,
        to: requestedMode!,
        resolvedConfig: resolvedConfigWithDefaults,
        generatedAgentPaths: POIESIS_GENERATED_AGENT_PATHS,
      })
    : undefined;

  // 9. Snapshot the manifest preimage for fail-closed rollback. Reading the
  //    manifest is the last read-only step; everything from step 10 onward
  //    mutates owned bytes. The snapshot read happens AFTER the schema
  //    validation so the rollback target is never captured for a transaction
  //    that fails before the first write (nothing has changed yet, so a
  //    rollback preimage would be unnecessary).
  const poiesisConfigPath = join(resolvedRoot, POIESIS_CONFIG_RELATIVE_PATH);
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const receiptPath = await ownershipReceiptLocation(resolvedRoot);
  // Spec #190 / ticket #193 — the limit covers the transition surface too:
  // poiesis config, OpenCode config, `.gitignore`, up to two shared profile
  // files, the manifest, and the receipt. Captured in EXACT write order, so
  // the journal's reverse-order rollback is reverse write order and the
  // shared profile files a failed transition created are removed rather than
  // left behind next to a manifest that never advanced.
  const journal = new ArtifactJournal(8);
  const poiesisConfigArtifact = await journal.capture(poiesisConfigPath, "whole-file");
  const openCodeArtifact = await journal.capture(
    openCodeConfigPath,
    manifest.files.some((file) => file.path === openCodeRelativePath) ? "whole-file" : "patch",
  );
  const gitignoreArtifact = transition === undefined
    ? undefined
    : await journal.capture(join(resolvedRoot, GITIGNORE_RELATIVE_PATH), "whole-file");
  const profileArtifacts: Array<{ path: string; entry: ArtifactJournalEntry }> = [];
  for (const file of transition?.createProfileFiles ?? []) {
    profileArtifacts.push({ path: file.path, entry: await journal.capture(join(resolvedRoot, file.path), "whole-file") });
  }
  const manifestArtifact = await journal.capture(manifestPath, "whole-file");
  const receiptArtifact = await journal.capture(receiptPath, "whole-file");
  if (transition !== undefined && gitignoreArtifact !== undefined) {
    // Bind the plan to what the journal actually captured: the `.gitignore`
    // must still be the content the splice was rendered from, and a shared
    // profile the plan decided to create must still be absent. Without this,
    // a writer that lands in the window between planning and capturing would
    // be silently overwritten by a decision made about different bytes.
    assertTransitionCaptureIdentity(transition, {
      gitignorePreimage: gitignoreArtifact.preimage,
      profileCaptures: profileArtifacts.map((artifact) => ({
        path: artifact.path,
        physicalExists: artifact.entry.physicalExists,
      })),
    });
  }
  // The profile's parent directory is not a journal entry (the journal owns
  // file preimages), so the transition records which directories it created
  // and the catch block removes the ones still empty. Deliberated LAST, between
  // the drift check and the `try`, so the catch block is guaranteed to be
  // reachable for anything that can leave one behind.
  const expectedSnapshots: Array<[ArtifactJournalEntry, Buffer]> = [
    [poiesisConfigArtifact, currentConfigBytes],
    [openCodeArtifact, openCodeConfigCurrentBytes],
  ];
  for (const [artifact, expected] of expectedSnapshots) {
    if (artifact.preimage === undefined || !artifact.preimage.equals(expected)) {
      throw new PoiesisError("ARTIFACT_IDENTITY_DRIFT", "Artifact changed while preparing the transaction journal", {
        path: artifact.path,
      });
    }
  }
  await hooks.onJournalReady?.(journal.entries);
  const createdProfileDirectories =
    transition === undefined || transition.createProfileFiles.length === 0
      ? []
      : await ensureTransitionProfileParents(resolvedRoot);

  // Spec #133 / ticket #137: the Author-owned `package.json` state.
  // Declared here (before the try) so the catch block can close over the
  // locals, and so a throw from a post-write step still leaves the
  // rollback identity bound. Same snapshot + written-hash-gated contract

  try {
    // 10. Write the new Poiesis config atomically.
    await hooks?.prePoiesisConfigWrite?.();
    await journal.replace(poiesisConfigArtifact, newConfigContent);
    await hooks.postPoiesisConfigWrite?.();

    // 11. Write the already validated, deterministic OpenCode projection
    //     through the same journal guard used for every other artifact.
    await hooks?.preOpenCodeApply?.();
    await journal.replace(openCodeArtifact, preflightSerialized);
    await hooks.postOpenCodeApply?.();
    const driftOverride = hooks.injectDriftedOnWrittenContent?.(preflightSerialized);
    if (driftOverride !== undefined && driftOverride !== preflightSerialized) {
      throw new PoiesisError(
        "INSTALL_PATH_CONFLICT",
        "OpenCode config projection drifted between preflight and apply",
        { file: openCodeRelativePath },
      );
    }
    const appliedPatches = projectedOpenCodePatches;
    const openCodeWrittenHash = hashContent(preflightSerialized);

    // 11b. Spec #190 / ticket #193 — apply the planned transition through the
    //      same bounded journal every other owned byte uses. `.gitignore` is
    //      spliced, not rewritten: the plan already proved the recorded block
    //      is unchanged and produced content that preserves every byte outside
    //      it, and the journal's pre-write identity guard closes the window
    //      between that proof and this write against a concurrent writer.
    if (transition !== undefined) {
      await hooks?.preModeTransitionApply?.();
      if (gitignoreArtifact !== undefined) {
        await journal.replace(gitignoreArtifact, transition.gitignoreContent);
      }
      await hooks?.postModeTransitionGitignore?.();
      // Shared profile files are created only where they are absent, so a
      // transition never overwrites Author-committed project intelligence.
      for (const profile of transition.createProfileFiles) {
        const artifact = profileArtifacts.find((candidate) => candidate.path === profile.path);
        if (artifact === undefined) {
          throw new PoiesisError("ARTIFACT_JOURNAL_MISSING", "Journal does not contain the shared profile entry", {
            path: profile.path,
          });
        }
        await journal.replace(artifact.entry, profile.content);
      }
      await hooks?.postModeTransitionApply?.();
    }

    // 12. Merge the prior `previous` provenance into the freshly applied patches so user-supplied
    //     values are preserved across updates.
    const mergedPatches = nextAdapterPatches(manifest, appliedPatches);

    // 13. Build the next manifest. The hash for the .poiesis/config.jsonc file is recomputed; the OpenCode
    //     config hash is taken from the on-disk write; every other file keeps its prior hash. Use the
    //     same `nextPoiesisVersion` captured at step 6 so the manifest's recorded version exactly
    //     matches the version baked into the OpenCode config bash projection.
    const nextManifest: Manifest = {
      // Spec #190 / ticket #191: an update reconciles the installation; it
      // never re-decides its sharing mode. `mode` and the exact
      // `.gitignore` block ownership ride through unchanged.
      ...manifest,
      schema: 1,
      poiesisVersion: nextPoiesisVersion,
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: CERTIFIED_OPENCODE_VERSION,
        supportedVersions: [...CERTIFIED_OPENCODE_VERSIONS],
      },
      files: manifest.files.map((file) => {
        if (file.path === POIESIS_CONFIG_RELATIVE_PATH) {
          // Key order matches `managedFileSchema` exactly. `manifestSchema`
          // is a strict object, so a round-trip through `loadManifest`
          // normalises key order; a literal built in a different order would
          // serialize to different bytes and break the receipt digest.
          return {
            path: POIESIS_CONFIG_RELATIVE_PATH,
            kind: "generated",
            hash: newConfigHash,
            owned: true,
            provenance: "config",
          };
        }
        if (file.path === openCodeRelativePath) {
          return { ...file, hash: openCodeWrittenHash! };
        }
        return file;
      }),
      skills: manifest.skills,
      configPatches: mergedPatches,
      // Spec #190 / ticket #193 — an EXPLICIT mode change is the one thing an
      // `update --config` may decide about sharing. Both keys already exist on
      // the manifest the spread above carried (the planner refuses without
      // them), so overriding them in place adds no new key and therefore
      // cannot shift the canonical serialization key order the receipt digest
      // is computed over. `ignoreBlock.hash` is the hash of the block this run
      // actually wrote, so `uninstall` reverses exactly these bytes.
      ...(transition === undefined ? {} : { mode: transition.to, ignoreBlock: transition.record }),
    };
    await hooks?.preManifestWrite?.();
    // Serialize nextManifest exactly once; derive the post-write identity
    // from those exact bytes BEFORE write, and write those same bytes. A
    // foreign replacement in the write window cannot be adopted as our
    // identity, and the post-write `hashFile` re-read is removed.
    const nextManifestBytes = serializeManifest(nextManifest);
    const nextManifestHash = hashContent(nextManifestBytes);
    await journal.replace(manifestArtifact, nextManifestBytes);
    await hooks?.postManifestWrite?.();

    // 14. Replace the ownership receipt, advancing generation by exactly ONE and binding to the new manifest digest.
    await hooks?.preReceiptReplace?.();
    const nextReceipt: OwnershipReceipt = {
      ...receipt,
      manifestDigest: nextManifestHash,
      generation: receipt.generation + 1,
    };
    await journal.replace(receiptArtifact, `${JSON.stringify(nextReceipt, null, 2)}\n`);
    await hooks?.postReceiptReplace?.();

    // 15. Doctor gate: pass or roll back everything. The transaction is config-only
    //     so skills health is unrelated to the change under transaction; ignore
    //     `skills` check failures that pre-date this transaction by inspecting
    //     whether the manifest had a `skills` array that fully populated defaults.
    const report = await doctor(resolvedRoot);
    assertUpdateConfigDoctorGate(report, manifest);
    return { manifest: nextManifest, doctor: report };
  } catch (error) {
    // 16. Exact rollback is journal-driven and always runs in reverse write
    //     order. Foreign replacements are preserved and reported explicitly.
    const diagnostics = await journal.rollback();
    // Spec #190 / ticket #193 — the journal restored (or removed) every FILE
    //     the transition touched, `.gitignore` included. A parent directory it
    //     created for the shared profile is not a journal entry, so it is
    //     removed here — deepest first, and only while still empty, which is
    //     why a rollback can never delete project structure on the strength of
    //     a bookkeeping list. Never able to fail the transaction it is undoing.
    await removeEmptyTransitionDirectories(resolvedRoot, createdProfileDirectories);
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

export async function runUpdateConfigTransaction(
  root: string,
  configPath: string,
  options: UpdateConfigOptions,
  hooks: UpdateTransactionHooks,
): Promise<UpdateResult> {
  assertCompatibleUpdateConfigOptions(options);
  const lock = await acquireWorkspaceMutationLock(resolve(root));
  let transactionError: unknown;
  try {
    await hooks.postLockAcquired?.();
    return await runLockedUpdateConfigTransaction(root, configPath, options, hooks);
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

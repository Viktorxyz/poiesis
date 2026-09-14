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
 */
import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, parseJsonc, serializeConfig, validateConfig, type PoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import { atomicWrite, exists, readUtf8 } from "./fs.js";
import { hashContent, hashFile } from "./hash.js";
import { assertManifestAuthority, nextAdapterPatches } from "./authority.js";
import {
  assertOwnershipReceipt,
  ownershipReceiptLocation,
  replaceOwnershipReceipt,
  restoreOwnershipReceipt,
  type OwnershipReceipt,
} from "./receipt.js";
import { loadManifest, serializeManifest, type ManagedFile, type Manifest } from "./manifest.js";
import {
  applyOpenCodeConfig,
  desiredOpenCodePatches,
  OPENCODE_ADAPTER_VERSION,
  SUPPORTED_OPENCODE_VERSION,
  SUPPORTED_OPENCODE_VERSIONS,
  verifyOpenCodeVersion,
} from "./opencode.js";
import { assertOpenCodeOwnershipAgainstSnapshot, projectOpenCodePayload } from "./opencode-preflight.js";
import { poiesisPath } from "./paths.js";
import { createDeliveryAdapter } from "./adapters.js";
import type { ConfigPatch } from "./manifest.js";
import type { DoctorReport, UpdateResult } from "./maintenance.js";
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
  /** Called immediately before atomic-writing the new `.poiesis/config.jsonc`. */
  prePoiesisConfigWrite?: () => void | Promise<void>;
  /** Called immediately before applying the OpenCode projection to the managed config. */
  preOpenCodeApply?: () => void | Promise<void>;
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
  const details = await lstat(path);
  return details.isFile() && !details.isSymbolicLink();
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
export async function runUpdateConfigTransaction(
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
  await verifyOpenCodeVersion(resolvedRoot);
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
  const { config: resolvedConfigWithDefaults } = await autoResolveConfigDefaults(resolvedRoot, proposedConfig);

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
  //    probe). The schema validation is moved to step 8 below.
  const desiredOpenCodeProjectionPatches = desiredOpenCodePatches(resolvedConfigWithDefaults);
  const { serialized: preflightSerialized } = projectOpenCodePayload({
    root: resolvedRoot,
    configPath: openCodeConfigPath,
    currentContent: currentOpenCodeContentString,
    patches: desiredOpenCodeProjectionPatches,
  });

  // 7. No-op detection compares both captured serialized files directly with
  //    the complete intended payloads. A pre-existing OpenCode config is owned
  //    only through manifest config patches, so it deliberately has no
  //    whole-file manifest record to consult here. Direct byte equality keeps
  //    that patch-only ownership intact while recognizing that the projection
  //    would write exactly the bytes already on disk. Do NOT advance generation;
  //    return the existing manifest unchanged.
  const poiesisConfigBytesMatch = currentConfigBytes.equals(Buffer.from(newConfigContent, "utf8"));
  const openCodeBytesMatch = openCodeConfigCurrentBytes.equals(Buffer.from(preflightSerialized, "utf8"));
  if (poiesisConfigBytesMatch && openCodeBytesMatch) {
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

  // 9. Snapshot the manifest preimage for fail-closed rollback. Reading the
  //    manifest is the last read-only step; everything from step 10 onward
  //    mutates owned bytes. The snapshot read happens AFTER the schema
  //    validation so the rollback target is never captured for a transaction
  //    that fails before the first write (nothing has changed yet, so a
  //    rollback preimage would be unnecessary).
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const manifestBackup = await readFile(manifestPath);
  let openCodeWrittenHash: string | undefined;
  let poiesisConfigWrittenHash: string | undefined;
  let manifestWrittenHash: string | undefined;
  let nextReceipt: OwnershipReceipt | undefined;

  try {
    // 10. Write the new Poiesis config atomically.
    await hooks?.prePoiesisConfigWrite?.();
    await atomicWrite(join(resolvedRoot, POIESIS_CONFIG_RELATIVE_PATH), newConfigContent);
    poiesisConfigWrittenHash = await hashFile(join(resolvedRoot, POIESIS_CONFIG_RELATIVE_PATH));
    if (poiesisConfigWrittenHash !== newConfigHash) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "Poiesis config changed after write", {
        path: POIESIS_CONFIG_RELATIVE_PATH,
        expected: newConfigHash,
        actual: poiesisConfigWrittenHash,
      });
    }

    // 11. Apply the new OpenCode projection. `applyOpenCodeConfig` internally
    //    (a) reads the file, (b) checks expectedContent byte-identity, (c)
    //    re-reads the file immediately before `atomicWrite` (the strengthened
    //    TOCTOU guard inside `applyOpenCodeConfig`), and (d) calls
    //    `onWritten(content)` after the atomic write. We pass
    //    `expectedContent: openCodeConfigCurrentBytes` so any concurrent
    //    foreign write that landed between step 5 and step 11 is caught by
    //    BOTH the head-of-function check and the pre-write TOCTOU check. The
    //    `onWritten` callback's projection-drift equality check uses the
    //    preflight's serialized bytes as the expected value (drift is
    //    impossible under the current pure helper, but the check is
    //    defensive — see step 11b below). The `onWritten` callback records
    //    `openCodeWrittenHash` BEFORE the equality check so the rollback
    //    path retains rollback identity even when the drift throw occurs
    //    (the bytes were deterministically written, so they are still safe
    //    to identify for restoration).
    await hooks?.preOpenCodeApply?.();
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, resolvedConfigWithDefaults, openCodeConfigPath, {
      expectedContent: openCodeConfigCurrentBytes,
      onWritten: (content) => {
        // 11b. Drift handling. Assign `openCodeWrittenHash` FIRST so that
        //      even when the throw below fires, `openCodeWrittenHash`
        //      captures the exact bytes applyOpenCodeConfig wrote; the
        //      rollback path can therefore identify the on-disk hash and
        //      restore the preimage byte-for-byte. Note that drift between
        //      preflight and apply is impossible today (both paths call
        //      the same pure helper with the same inputs) — the equality
        //      check is a defensive guard that retains rollback identity
        //      even if a future refactor introduces non-determinism.
        //      The `injectDriftedOnWrittenContent` hook is an internal
        //      test seam that lets the drift-regression test force this
        //      branch deterministically without monkey-patching.
        const driftOverride = hooks?.injectDriftedOnWrittenContent?.(content);
        openCodeWrittenHash = hashContent(content);
        const expected = driftOverride ?? preflightSerialized;
        if (content !== expected) {
          throw new PoiesisError(
            "INSTALL_PATH_CONFLICT",
            "OpenCode config projection drifted between preflight and apply",
            { file: openCodeRelativePath },
          );
        }
      },
    });
    if (openCodeWrittenHash === undefined) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config write did not record a final hash", {
        file: openCodeRelativePath,
      });
    }
    const onDiskOpenCodeHash = await hashFile(openCodeConfigPath);
    if (onDiskOpenCodeHash !== openCodeWrittenHash) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config changed after write", {
        file: openCodeRelativePath,
      });
    }

    // 12. Merge the prior `previous` provenance into the freshly applied patches so user-supplied
    //     values are preserved across updates.
    const mergedPatches = nextAdapterPatches(manifest, appliedPatches);

    // 13. Build the next manifest. The hash for the .poiesis/config.jsonc file is recomputed; the OpenCode
    //     config hash is taken from the on-disk write; every other file keeps its prior hash.
    const nextManifest: Manifest = {
      schema: 1,
      poiesisVersion: await packageVersion(),
      adapter: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
      files: manifest.files.map((file) => {
        if (file.path === POIESIS_CONFIG_RELATIVE_PATH) {
          return { path: POIESIS_CONFIG_RELATIVE_PATH, kind: "generated", hash: newConfigHash, owned: true };
        }
        if (file.path === openCodeRelativePath) {
          return { ...file, hash: openCodeWrittenHash! };
        }
        return file;
      }),
      skills: manifest.skills,
      configPatches: mergedPatches,
    };
    await hooks?.preManifestWrite?.();
    // Serialize nextManifest exactly once; derive the post-write identity
    // from those exact bytes BEFORE write, and write those same bytes. A
    // foreign replacement in the write window cannot be adopted as our
    // identity, and the post-write `hashFile` re-read is removed.
    const nextManifestBytes = serializeManifest(nextManifest);
    const nextManifestHash = hashContent(nextManifestBytes);
    await atomicWrite(manifestPath, nextManifestBytes);
    manifestWrittenHash = nextManifestHash;
    await hooks?.postManifestWrite?.();

    // 14. Replace the ownership receipt, advancing generation by exactly ONE and binding to the new manifest digest.
    await hooks?.preReceiptReplace?.();
    nextReceipt = await replaceOwnershipReceipt(resolvedRoot, nextManifest, receipt);
    await hooks?.postReceiptReplace?.();

    // 15. Doctor gate: pass or roll back everything. The transaction is config-only
    //     so skills health is unrelated to the change under transaction; ignore
    //     `skills` check failures that pre-date this transaction by inspecting
    //     whether the manifest had a `skills` array that fully populated defaults.
    const report = await doctor(resolvedRoot);
    assertUpdateConfigDoctorGate(report, manifest);
    return { manifest: nextManifest, doctor: report };
  } catch (error) {
    // 16. Exact rollback: restore each mutated artifact only if its post-write
    //     hash still matches what we wrote, AND restore the EXACT preimage
    //     bytes (no newline normalization, no lossy string conversions). The
    //     preimage is a Buffer; we pass it to `atomicWrite` as raw bytes so
    //     a no-newline preimage restores to a no-newline file. The fail-closed
    //     hash gate from #10/#11 still preserves foreign writes that landed
    //     between our last write and the rollback. The drift-throw path
    //     retains rollback identity because `openCodeWrittenHash` is set
    //     before the equality check throws (see step 11b).
    if ((await exists(openCodeConfigPath)) && openCodeWrittenHash !== undefined && (await hashFile(openCodeConfigPath)) === openCodeWrittenHash) {
      await atomicWrite(openCodeConfigPath, openCodeConfigCurrentBytes);
    }
    const poiesisConfigPath = join(resolvedRoot, POIESIS_CONFIG_RELATIVE_PATH);
    if ((await exists(poiesisConfigPath)) && poiesisConfigWrittenHash !== undefined && (await hashFile(poiesisConfigPath)) === poiesisConfigWrittenHash) {
      await atomicWrite(poiesisConfigPath, currentConfigBytes);
    }
    // Manifest fail-closed rollback: restore the preimage only if the on-disk
    // manifest still matches the post-write identity we recorded above. A
    // foreign writer between our write and the rollback leaves the manifest
    // untouched.
    if (manifestWrittenHash !== undefined && (await exists(manifestPath)) && (await hashFile(manifestPath)) === manifestWrittenHash) {
      await atomicWrite(manifestPath, manifestBackup);
    }
    // Receipt fail-closed rollback: restore the preimage only if the on-disk
    // receipt still matches the post-write identity we last observed (nextReceipt
    // if we wrote it, else the pre-transaction receipt). A foreign writer
    // between our write and the rollback leaves the receipt untouched.
    const expectedReceiptHash = hashContent(`${JSON.stringify(nextReceipt ?? receipt, null, 2)}\n`);
    const onDiskReceiptPath = await ownershipReceiptLocation(resolvedRoot);
    if ((await exists(onDiskReceiptPath)) && hashContent(await readFile(onDiskReceiptPath)) === expectedReceiptHash) {
      await restoreOwnershipReceipt(resolvedRoot, receipt);
    }
    throw error;
  }
}

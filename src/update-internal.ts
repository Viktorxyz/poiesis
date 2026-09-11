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
 */
import { exists, atomicWrite } from "./fs.js";
import { readFile, unlink } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { PoiesisError } from "./errors.js";
import { hashContent } from "./hash.js";
import { loadManifest, serializeManifest, type Manifest } from "./manifest.js";
import { applyOpenCodeConfig, OPENCODE_ADAPTER_VERSION, SUPPORTED_OPENCODE_VERSION, SUPPORTED_OPENCODE_VERSIONS, verifyOpenCodeVersion } from "./opencode.js";
import { ownedPath, poiesisPath } from "./paths.js";
import {
  assertOwnershipReceipt,
  ownershipReceiptLocation,
  replaceOwnershipReceipt,
  removeOwnershipReceipt,
  createOwnershipReceipt,
  type OwnershipReceipt,
} from "./receipt.js";
import { installDefaultSkills } from "./skills.js";
import { templateMappings } from "./templates.js";
import { assertManifestAuthorityToleratingPredecessor, nextAdapterFiles, nextAdapterPatches } from "./authority.js";
import type { MaintenanceOptions, UpdateResult } from "./maintenance.js";

const POIESIS_DEFAULT_PATH_GITIGNORE_HEADER =
  "# Hide the default-path workspace area (Poiesis-managed local state; transactional update/bootstrap line)";
const POIESIS_DEFAULT_PATH_GITIGNORE_PATTERN = ".poiesis/workspaces/";
const POIESIS_DEFAULT_PATH_GITIGNORE_RULES: readonly string[] = [
  POIESIS_DEFAULT_PATH_GITIGNORE_HEADER,
  POIESIS_DEFAULT_PATH_GITIGNORE_PATTERN,
];

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
  /** Called immediately before `installDefaultSkills` runs. */
  preSkillsInstall?: () => void | Promise<void>;
  /**
   * Called immediately BEFORE the atomic write of each materialized file.
   * Receives the relative path of the file about to be written. The
   * transaction's pre-write identity is `hashContent(file.content)`; if
   * the hook mutates the on-disk file before our `atomicWrite` runs,
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

async function snapshotFileIfOwned(
  path: string,
  root: string,
  records: Manifest["files"],
): Promise<Buffer | null> {
  const relativePath = relative(root, path);
  const record = records.find((entry) => entry.path === relativePath);
  if (record === undefined) return null;
  if (!(await exists(path))) return null;
  return readFile(path);
}

async function readMaterializedFilesIntoSnapshot(
  root: string,
  paths: string[],
): Promise<Map<string, Buffer>> {
  const snapshots = new Map<string, Buffer>();
  for (const filePath of paths) {
    const path = join(root, filePath);
    if (await exists(path)) snapshots.set(filePath, await readFile(path));
  }
  return snapshots;
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
  const openCodeConfigSnapshot = await snapshotFileIfOwned(openCodeConfigPath, resolvedRoot, manifest.files);
  const openCodeConfigCurrentBytes = await readFile(openCodeConfigPath);
  const fileSnapshots = await readMaterializedFilesIntoSnapshot(
    resolvedRoot,
    materialized.map((file) => file.path),
  );

  // Preimage snapshots for the transactional artifacts.
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const manifestBackup = await snapshotFile(manifestPath);
  const gitignoreSnapshot = await snapshotFile(join(resolvedRoot, ".gitignore"));
  const receiptSnapshot = await snapshotFile(await ownershipReceiptLocation(resolvedRoot));

  // Pre-write identity for each artifact (captured BEFORE the write so a
  // foreign replacement in the write window cannot be adopted as ours).
  let materializedWrittenHashes: Map<string, string | undefined> = new Map();
  let openCodeWrittenHash: string | undefined;
  let gitignoreWrittenHash: string | undefined;
  let manifestWrittenHash: string | undefined;
  let receiptWrittenBytes: Buffer | undefined;
  let nextReceipt: OwnershipReceipt | undefined;

  let skills = manifest.skills;

  try {
    await hooks?.preSkillsInstall?.();
    skills = options.skipSkills
      ? manifest.skills
      : await installDefaultSkills(resolvedRoot, manifest.skills, { replaceOwned: true });

    for (const file of materialized) {
      const destination = join(resolvedRoot, file.path);
      const writtenHash = hashContent(file.content);
      materializedWrittenHashes.set(file.path, writtenHash);
      await hooks?.preMaterializedFileWrite?.(file.path);
      await atomicWrite(destination, file.content);
      await hooks?.postMaterializedFileWrite?.(file.path);
    }

    await hooks?.preDefaultPathGitignoreEnsure?.();
    ({ writtenHash: gitignoreWrittenHash } = await ensureDefaultPathGitignore(resolvedRoot, gitignoreSnapshot));
    await hooks?.postDefaultPathGitignoreEnsure?.();

    const nextFiles = nextAdapterFiles(
      manifest,
      materialized.map((file) => ({
        path: file.path,
        kind: file.kind,
        hash: hashContent(file.content),
        durable: templateMappings.find((mapping) => mapping.destination === file.path)?.trackInProject === true,
      })),
    );
    await hooks?.preOpenCodeApply?.();
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, config, openCodeConfigPath, {
      expectedContent: openCodeConfigCurrentBytes,
      onWritten: (content: string) => {
        openCodeWrittenHash = hashContent(content);
      },
    });
    await hooks?.postOpenCodeApply?.();
    const configPatches = nextAdapterPatches(manifest, appliedPatches);
    if (openCodeConfigSnapshot !== null) {
      const nextRecord = nextFiles.findIndex((file) => file.path === openCodeConfig);
      if (nextRecord >= 0) {
        nextFiles[nextRecord] = {
          ...nextFiles[nextRecord]!,
          hash: hashContent(await readFile(openCodeConfigPath)),
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
    await hooks?.preManifestWrite?.();
    await atomicWrite(manifestPath, nextManifestBytes);
    manifestWrittenHash = nextManifestHash;
    await hooks?.postManifestWrite?.();

    await hooks?.preReceiptReplace?.();
    nextReceipt = await replaceOwnershipReceipt(resolvedRoot, next, receipt);
    // The receipt's exact written bytes match `writeReceipt`'s canonical
    // serialization (see `./receipt.ts`). Capture them BEFORE the doctor
    // gate so the rollback hash-gate compares against this in-memory
    // identity rather than re-reading the receipt.
    receiptWrittenBytes = Buffer.from(`${JSON.stringify(nextReceipt, null, 2)}\n`);
    await hooks?.postReceiptReplace?.();

    const report = await doctor(resolvedRoot);
    if (!options.skipSkills && !report.ok) {
      throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Poiesis update did not pass doctor", { report });
    }
    return { manifest: next, doctor: report };
  } catch (error) {
    // Fail-closed rollback: restore each mutated artifact only if its
    // post-write identity still matches what THIS transaction wrote, AND
    // restore the EXACT preimage bytes (no newline normalization, no lossy
    // string conversions). Each branch is hash-gated against the captured
    // identity; a concurrent foreign replacement that lands between this
    // transaction's last write and the rollback is left intact because
    // the comparison simply fails.
    // 1. Receipt (last write before the doctor gate). Restore raw
    //    preimage Buffer via atomicWrite so a no-final-newline or
    //    differently-indented preimage is restored byte-for-byte. For
    //    bootstrap the preimage is null and the receipt is removed iff
    //    the on-disk file is still the one we wrote.
    const receiptPath = await ownershipReceiptLocation(resolvedRoot);
    if (receiptWrittenBytes !== undefined && (await exists(receiptPath))) {
      const currentReceipt = await readFile(receiptPath);
      if (hashContent(currentReceipt) === hashContent(receiptWrittenBytes)) {
        if (receiptSnapshot === null) {
          await removeOwnershipReceipt(resolvedRoot);
        } else {
          await atomicWrite(receiptPath, receiptSnapshot);
        }
      }
    }
    // 2. Manifest (second to last write before the doctor gate).
    if (manifestWrittenHash !== undefined && (await exists(manifestPath))) {
      const currentManifest = await readFile(manifestPath);
      if (hashContent(currentManifest) === manifestWrittenHash) {
        if (manifestBackup === null) {
          await unlink(manifestPath);
        } else {
          await atomicWrite(manifestPath, manifestBackup);
        }
      }
    }
    // 3. OpenCode config (third to last write before the doctor gate).
    if (openCodeWrittenHash !== undefined && (await exists(openCodeConfigPath))) {
      const currentOpenCode = await readFile(openCodeConfigPath);
      if (hashContent(currentOpenCode) === openCodeWrittenHash) {
        if (openCodeConfigSnapshot === null) {
          await unlink(openCodeConfigPath);
        } else {
          await atomicWrite(openCodeConfigPath, openCodeConfigSnapshot);
        }
      }
    }
    // 4. Materialized managed files (in reverse write order). Pre-write
    //    identity was captured as `hashContent(file.content)` above, so
    //    the comparison is a pure function of the bytes we wrote.
    for (const file of [...materialized].reverse()) {
      const destination = join(resolvedRoot, file.path);
      const snapshot = fileSnapshots.get(file.path);
      const writtenHash = materializedWrittenHashes.get(file.path);
      if (writtenHash === undefined) continue;
      if (!(await exists(destination))) continue;
      const currentMaterial = await readFile(destination);
      if (hashContent(currentMaterial) !== writtenHash) continue;
      if (snapshot === undefined) {
        await unlink(destination);
      } else {
        await atomicWrite(destination, snapshot);
      }
    }
    // 5. Transactional `.gitignore` (last shared helper, byte-exact already).
    await rollbackDefaultPathGitignore(join(resolvedRoot, ".gitignore"), gitignoreSnapshot, gitignoreWrittenHash);
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
  const { doctor, isRegularManagedFile, packageVersion, resolveConfigForRoot, verifyGitRepository } = await import("./maintenance.js");
  const { ownershipReceiptExists } = await import("./receipt.js");
  const { hashOwnedSkillDirectory } = await import("./skills.js");
  const { hashDirectory } = await import("./hash.js");
  const { loadDefaultSkills } = await import("./skills.js");

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
  const openCodeConfigSnapshot = await snapshotFileIfOwned(openCodeConfigPath, resolvedRoot, manifest.files);
  const openCodeConfigCurrentBytes = openCodeConfigSnapshot === null ? null : openCodeConfigSnapshot;
  const fileSnapshots = await readMaterializedFilesIntoSnapshot(
    resolvedRoot,
    materialized.map((file) => file.path),
  );

  // Preimage snapshots for the transactional artifacts. The bootstrap
  // entry assumes no receipt; if the user pre-seeded one we still take
  // a Buffer snapshot so the rollback can detect a foreign receipt that
  // appeared after our `createOwnershipReceipt`.
  const manifestPath = poiesisPath(resolvedRoot, "manifest.json");
  const manifestBackup = await snapshotFile(manifestPath);
  const gitignoreSnapshot = await snapshotFile(join(resolvedRoot, ".gitignore"));
  const receiptSnapshot = await snapshotFile(await ownershipReceiptLocation(resolvedRoot));

  // Pre-write identity for each artifact.
  let materializedWrittenHashes: Map<string, string | undefined> = new Map();
  let openCodeWrittenHash: string | undefined;
  let gitignoreWrittenHash: string | undefined;
  let manifestWrittenHash: string | undefined;
  let receiptWrittenBytes: Buffer | undefined;
  let nextReceipt: OwnershipReceipt | undefined;

  try {
    await hooks?.preSkillsInstall?.();
    const skills = options.skipSkills
      ? nextSkills
      : await installDefaultSkills(resolvedRoot, nextSkills, { replaceOwned: true });

    for (const file of materialized) {
      const destination = join(resolvedRoot, file.path);
      const writtenHash = hashContent(file.content);
      materializedWrittenHashes.set(file.path, writtenHash);
      await hooks?.preMaterializedFileWrite?.(file.path);
      await atomicWrite(destination, file.content);
      await hooks?.postMaterializedFileWrite?.(file.path);
    }

    await hooks?.preDefaultPathGitignoreEnsure?.();
    ({ writtenHash: gitignoreWrittenHash } = await ensureDefaultPathGitignore(resolvedRoot, gitignoreSnapshot));
    await hooks?.postDefaultPathGitignoreEnsure?.();

    const nextFiles = nextAdapterFiles(
      manifest,
      materialized.map((file) => ({
        path: file.path,
        kind: file.kind,
        hash: hashContent(file.content),
        durable: templateMappings.find((mapping) => mapping.destination === file.path)?.trackInProject === true,
      })),
    );
    await hooks?.preOpenCodeApply?.();
    const appliedPatches = await applyOpenCodeConfig(resolvedRoot, config, openCodeConfigPath, {
      ...(openCodeConfigCurrentBytes !== null ? { expectedContent: openCodeConfigCurrentBytes } : {}),
      onWritten: (content: string) => {
        openCodeWrittenHash = hashContent(content);
      },
    });
    await hooks?.postOpenCodeApply?.();
    const configPatches = nextAdapterPatches(manifest, appliedPatches);
    if (openCodeConfigSnapshot !== null) {
      const nextRecord = nextFiles.findIndex((file) => file.path === openCodeConfig);
      if (nextRecord >= 0) {
        nextFiles[nextRecord] = { ...nextFiles[nextRecord]!, hash: hashContent(await readFile(openCodeConfigPath)) };
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
    await hooks?.preManifestWrite?.();
    await atomicWrite(manifestPath, nextManifestBytes);
    manifestWrittenHash = nextManifestHash;
    await hooks?.postManifestWrite?.();

    await hooks?.preReceiptReplace?.();
    nextReceipt = await createOwnershipReceipt(resolvedRoot, next);
    receiptWrittenBytes = Buffer.from(`${JSON.stringify(nextReceipt, null, 2)}\n`);
    await hooks?.postReceiptReplace?.();

    const report = await doctor(resolvedRoot);
    if (!options.skipSkills && !report.ok) {
      throw new PoiesisError("UPDATE_DOCTOR_FAILED", "Poiesis update did not pass doctor", { report });
    }
    return { manifest: next, doctor: report };
  } catch (error) {
    // Bootstrap rollback: a newly created receipt is removed only if it
    // still matches what THIS transaction wrote (preserves foreign
    // receipt bytes). The manifest, OpenCode config, and materialized
    // files use the same hash-gated preimage restoration as the
    // ordinary `update` path.
    const receiptPath = await ownershipReceiptLocation(resolvedRoot);
    if (receiptWrittenBytes !== undefined && (await exists(receiptPath))) {
      const currentReceipt = await readFile(receiptPath);
      if (hashContent(currentReceipt) === hashContent(receiptWrittenBytes)) {
        if (receiptSnapshot === null) {
          await removeOwnershipReceipt(resolvedRoot);
        } else {
          // Defensive: a foreign receipt appeared between preimage
          // capture and `createOwnershipReceipt`. The hash gate above
          // would have prevented us from reaching this branch, so this
          // path is unreachable in practice; keep it for symmetry.
          await atomicWrite(receiptPath, receiptSnapshot);
        }
      }
    }
    if (manifestWrittenHash !== undefined && (await exists(manifestPath))) {
      const currentManifest = await readFile(manifestPath);
      if (hashContent(currentManifest) === manifestWrittenHash) {
        if (manifestBackup === null) {
          await unlink(manifestPath);
        } else {
          await atomicWrite(manifestPath, manifestBackup);
        }
      }
    }
    if (openCodeWrittenHash !== undefined && (await exists(openCodeConfigPath))) {
      const currentOpenCode = await readFile(openCodeConfigPath);
      if (hashContent(currentOpenCode) === openCodeWrittenHash) {
        if (openCodeConfigSnapshot === null) {
          await unlink(openCodeConfigPath);
        } else {
          await atomicWrite(openCodeConfigPath, openCodeConfigSnapshot);
        }
      }
    }
    for (const file of [...materialized].reverse()) {
      const destination = join(resolvedRoot, file.path);
      const snapshot = fileSnapshots.get(file.path);
      const writtenHash = materializedWrittenHashes.get(file.path);
      if (writtenHash === undefined) continue;
      if (!(await exists(destination))) continue;
      const currentMaterial = await readFile(destination);
      if (hashContent(currentMaterial) !== writtenHash) continue;
      if (snapshot === undefined) {
        await unlink(destination);
      } else {
        await atomicWrite(destination, snapshot);
      }
    }
    await rollbackDefaultPathGitignore(join(resolvedRoot, ".gitignore"), gitignoreSnapshot, gitignoreWrittenHash);
    throw error;
  }
}

// Re-export the maintenance types we need so callers of this internal
// module don't have to import maintenance.js (which would defeat the
// purpose of keeping the fault-injection seam outside the package root).
export type { MaintenanceOptions, UpdateResult };

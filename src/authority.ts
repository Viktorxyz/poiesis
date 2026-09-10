import { isDeepStrictEqual } from "node:util";
import { relative } from "node:path";
import { PoiesisError } from "./errors.js";
import type { PoiesisConfig } from "./config.js";
import {
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_CONFIG_RELATIVE_PATHS,
  SUPPORTED_OPENCODE_VERSIONS,
  SUPPORTED_OPENCODE_VERSION,
  desiredOpenCodePatches,
  isSupportedOpenCodeVersion,
} from "./opencode.js";
import { loadDefaultSkills, skillPath, SKILLS_DIRECTORY } from "./skills.js";
import { templateMappings } from "./templates.js";
import type { ConfigPatch, ManagedFile, Manifest, ManagedSkill } from "./manifest.js";

function manifestSupportedVersions(manifest: Manifest): readonly string[] {
  return manifest.adapter.supportedVersions ?? [manifest.adapter.supportedVersion];
}

function isSupportedAdapterContract(manifest: Manifest): boolean {
  return manifestSupportedVersions(manifest).every(isSupportedOpenCodeVersion);
}

function patchKey(file: string, path: readonly string[]): string {
  return `${file}\0${path.join("\0")}`;
}

function expectedManagedFiles(): Array<{ path: string; kind: ManagedFile["kind"]; durable: boolean }> {
  return [
    ...templateMappings.map((mapping) => ({
      path: mapping.destination,
      kind: mapping.kind,
      durable: mapping.trackInProject === true,
    })),
    { path: ".poiesis/config.jsonc", kind: "generated", durable: false },
  ];
}

function isRecognizedOpenCodeConfig(path: string): boolean {
  return (OPENCODE_CONFIG_RELATIVE_PATHS as readonly string[]).includes(path);
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new PoiesisError(code, message, details);
}

async function assertManifestAuthorityImpl(
  root: string,
  manifest: Manifest,
  desired: ReadonlyArray<{ path: readonly string[]; value: unknown }>,
): Promise<void> {
  if (manifest.schema !== 1) {
    fail("MANIFEST_MIGRATION_REQUIRED", "Manifest schema is not supported by this adapter", {
      schema: manifest.schema,
      supported: 1,
    });
  }
  if (
    manifest.adapter.harness !== "opencode" ||
    manifest.adapter.adapterVersion !== OPENCODE_ADAPTER_VERSION ||
    !isSupportedAdapterContract(manifest)
  ) {
    fail("MANIFEST_MIGRATION_REQUIRED", "Manifest adapter contract is not supported by this installation", {
      adapter: manifest.adapter,
      supported: {
        harness: "opencode",
        adapterVersion: OPENCODE_ADAPTER_VERSION,
        supportedVersion: SUPPORTED_OPENCODE_VERSION,
        supportedVersions: [...SUPPORTED_OPENCODE_VERSIONS],
      },
    });
  }

  const expectedFiles = expectedManagedFiles();
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  const seenFiles = new Set<string>();
  let generatedConfigPath: string | undefined;

  for (const file of manifest.files) {
    if (seenFiles.has(file.path)) fail("MANIFEST_AUTHORITY_INVALID", "Manifest contains a duplicate managed file", { path: file.path });
    seenFiles.add(file.path);
    const expected = expectedByPath.get(file.path);
    if (expected !== undefined) {
      if (file.kind !== expected.kind || (file.durable === true) !== expected.durable) {
        fail("MANIFEST_AUTHORITY_INVALID", "Managed file metadata does not match the installed adapter", {
          path: file.path,
          kind: file.kind,
          durable: file.durable,
          expected,
        });
      }
      continue;
    }
    if (!isRecognizedOpenCodeConfig(file.path) || file.kind !== "generated" || file.durable === true) {
      fail("MANIFEST_AUTHORITY_INVALID", "Manifest claims a path the installed adapter does not own", { path: file.path });
    }
    if (generatedConfigPath !== undefined && generatedConfigPath !== file.path) {
      fail("MANIFEST_AUTHORITY_INVALID", "Manifest claims more than one OpenCode config file", {
        files: [generatedConfigPath, file.path],
      });
    }
    generatedConfigPath = file.path;
  }

  for (const expected of expectedFiles) {
    if (!seenFiles.has(expected.path)) {
      fail("MANIFEST_AUTHORITY_INVALID", "Manifest is missing a required adapter-managed file", { path: expected.path });
    }
  }

  const desiredKeys = new Map(desired.map((patch) => [patch.path.join("\0"), patch]));
  const seenPatches = new Set<string>();
  let patchFile: string | undefined;

  for (const patch of manifest.configPatches) {
    const key = patchKey(patch.file, patch.path);
    if (seenPatches.has(key)) {
      fail("MANIFEST_AUTHORITY_INVALID", "Manifest contains a duplicate config patch", {
        file: patch.file,
        path: patch.path,
      });
    }
    seenPatches.add(key);
    if (!isRecognizedOpenCodeConfig(patch.file)) {
      fail("MANIFEST_AUTHORITY_INVALID", "Config patch file is not a recognized OpenCode config", { file: patch.file });
    }
    if (patchFile !== undefined && patchFile !== patch.file) {
      fail("MANIFEST_AUTHORITY_INVALID", "Config patches must target exactly one OpenCode config file", {
        files: [patchFile, patch.file],
      });
    }
    patchFile = patch.file;
    const expected = desiredKeys.get(patch.path.join("\0"));
    if (expected === undefined) {
      fail("MANIFEST_AUTHORITY_INVALID", "Manifest contains an unexpected config patch", {
        file: patch.file,
        path: patch.path,
      });
    }
    if (!isDeepStrictEqual(patch.installed, expected.value)) {
      fail("MANIFEST_AUTHORITY_INVALID", "Installed config patch does not match the current adapter projection", {
        file: patch.file,
        path: patch.path,
      });
    }
  }

  if (patchFile === undefined) {
    fail("MANIFEST_AUTHORITY_INVALID", "Manifest does not identify the OpenCode config file");
  }
  if (generatedConfigPath !== undefined && generatedConfigPath !== patchFile) {
    fail("MANIFEST_AUTHORITY_INVALID", "Generated OpenCode config file does not match config patches", {
      file: generatedConfigPath,
      patches: patchFile,
    });
  }
  for (const desiredPatch of desired) {
    if (!seenPatches.has(patchKey(patchFile, desiredPatch.path))) {
      fail("MANIFEST_AUTHORITY_INVALID", "Manifest is missing a required adapter config patch", {
        file: patchFile,
        path: desiredPatch.path,
      });
    }
  }

  const defaults = await loadDefaultSkills();
  const defaultsByName = new Map(defaults.map((skill) => [skill.name, skill]));
  const seenSkills = new Set<string>();
  for (const skill of manifest.skills) {
    if (seenSkills.has(skill.name)) {
      fail("MANIFEST_AUTHORITY_INVALID", "Manifest contains a duplicate skill", { name: skill.name });
    }
    seenSkills.add(skill.name);
    const expectedPath = relative(root, skillPath(root, skill.name));
    if (skill.path !== expectedPath || !skill.path.startsWith(`${SKILLS_DIRECTORY}/`)) {
      fail("MANIFEST_AUTHORITY_INVALID", "Skill path is not the adapter skill destination", {
        name: skill.name,
        path: skill.path,
        expected: expectedPath,
      });
    }
    const defaultSkill = defaultsByName.get(skill.name);
    if (defaultSkill !== undefined && skill.source !== defaultSkill.source) {
      fail("MANIFEST_AUTHORITY_INVALID", "Default skill source does not match the installed adapter", {
        name: skill.name,
        source: skill.source,
        expected: defaultSkill.source,
      });
    }
  }
}


/**
 * The exact v1.0.0/v1.0.1/v1.0.2 predecessor config patches for the OpenCode
 * adapter. Differs from the current projection ONLY in the `poiesis-reviewer`
 * permission, which retains the obsolete `task: { explore: "allow" }` field
 * that ticket #24 removed from runtime installations.
 *
 * Kept intentionally narrow: this is a migration-only exact predecessor
 * projection, not a general historical-normalization helper. New patches
 * must NOT be added here without an explicit ticket and migration contract.
 */
export function predecessorProjectionV100V101V102(
  config: PoiesisConfig,
): Array<{ path: string[]; value: unknown }> {
  return desiredOpenCodePatches(config).map((patch) => {
    if (
      patch.path.length === 2 &&
      patch.path[0] === "agent" &&
      patch.path[1] === "poiesis-reviewer"
    ) {
      const installed = patch.value as Record<string, unknown>;
      const permission = {
        ...(installed.permission as Record<string, unknown>),
        task: { explore: "allow" },
      };
      return { ...patch, value: { ...installed, permission } };
    }
    return patch;
  });
}

/**
 * Returns true if `manifest.configPatches` exactly matches the given projection:
 * same length, same `(file, path)` keys, and `isDeepStrictEqual` values.
 * Used to verify that a predecessor manifest is byte-for-byte the v1.0.0/1.0.1/1.0.2
 * projection (no drift, no extra patches).
 */
export function isExactProjection(manifest: Manifest, patches: ReadonlyArray<{ path: readonly string[]; value: unknown }>): boolean {
  if (manifest.configPatches.length !== patches.length) return false;
  for (const expected of patches) {
    const actual = manifest.configPatches.find(
      (p) =>
        p.path.length === expected.path.length &&
        p.path.every((segment, i) => segment === expected.path[i]),
    );
    if (actual === undefined) return false;
    if (!isDeepStrictEqual(actual.installed, expected.value)) return false;
  }
  return true;
}

/**
 * Authority check that, in addition to the strict current-only projection,
 * also accepts the exact v1.0.0/v1.0.1/v1.0.2 predecessor projection (which
 * retained `poiesis-reviewer.permission.task = { explore: "allow" }`).
 *
 * Use this ONLY after authenticating the receipt: the receipt binds the
 * trusted manifest digest, this function then proves the manifest's projection
 * matches either the current exact or the predecessor exact projection.
 *
 * Callers MUST pass the explicit predecessor version set they accept. The
 * default accepts all three v1.0.0/1.0.1/1.0.2 versions, but bootstrap and
 * update paths use different subsets per ticket #24 Replan:
 *   - receipt-authenticated update: `["1.0.1", "1.0.2"]`
 *   - bootstrap legacy ownership: `["1.0.0"]` (the version is already pinned
 *     by `validateLegacyInstallation`, so this is defense-in-depth)
 *
 * If the manifest matches neither projection, the original strict failure
 * is rethrown unchanged so callers see the same diagnostic.
 */
export async function assertManifestAuthorityToleratingPredecessor(
  root: string,
  manifest: Manifest,
  config: PoiesisConfig,
  acceptedPredecessorVersions: ReadonlyArray<"1.0.0" | "1.0.1" | "1.0.2"> = ["1.0.0", "1.0.1", "1.0.2"],
): Promise<void> {
  try {
    await assertManifestAuthorityImpl(root, manifest, desiredOpenCodePatches(config));
    return;
  } catch (strictError) {
    if (!(strictError instanceof PoiesisError) || strictError.code !== "MANIFEST_AUTHORITY_INVALID") {
      throw strictError;
    }
  }
  const isPredecessorVersion = (acceptedPredecessorVersions as ReadonlyArray<string>).includes(manifest.poiesisVersion);
  if (!isPredecessorVersion) {
    await assertManifestAuthorityImpl(root, manifest, desiredOpenCodePatches(config));
    return;
  }
  const predecessor = predecessorProjectionV100V101V102(config);
  if (!isExactProjection(manifest, predecessor)) {
    await assertManifestAuthorityImpl(root, manifest, desiredOpenCodePatches(config));
    return;
  }
  await assertManifestAuthorityImpl(root, manifest, predecessor);
}

/**
 * Strict current-only authority check. This function is the single source of
 * truth for non-migration flows (init, installCapability, uninstall, doctor).
 * Migration flows (update with receipt, bootstrap-legacy) delegate to
 * `assertManifestAuthorityToleratingPredecessor` instead.
 */
export async function assertManifestAuthority(root: string, manifest: Manifest, config: PoiesisConfig): Promise<void> {
  await assertManifestAuthorityImpl(root, manifest, desiredOpenCodePatches(config));
}

export function nextAdapterFiles(manifest: Manifest, materialized: Array<{ path: string; kind: ManagedFile["kind"]; hash: string; durable?: boolean }>): ManagedFile[] {
  const generatedConfig = manifest.files.find(
    (file) => isRecognizedOpenCodeConfig(file.path) && !materialized.some((candidate) => candidate.path === file.path),
  );
  return [
    ...materialized.map((file) => ({
      path: file.path,
      kind: file.kind,
      hash: file.hash,
      owned: true as const,
      ...(file.durable === true ? { durable: true } : {}),
    })),
    ...(generatedConfig === undefined ? [] : [generatedConfig]),
  ];
}

export function nextAdapterPatches(manifest: Manifest, applied: ConfigPatch[]): ConfigPatch[] {
  const prior = new Map(manifest.configPatches.map((patch) => [patchKey(patch.file, patch.path), patch]));
  return applied.map((patch) => {
    const existing = prior.get(patchKey(patch.file, patch.path));
    return existing === undefined
      ? patch
      : {
          file: patch.file,
          path: patch.path,
          previousExists: existing.previousExists,
          ...(existing.previousExists ? { previous: existing.previous } : {}),
          installed: patch.installed,
        };
  });
}

export function nextAdapterSkills(manifest: Manifest, installed: ManagedSkill[]): ManagedSkill[] {
  const defaults = new Set(installed.map((skill) => skill.name));
  return [...installed, ...manifest.skills.filter((skill) => !defaults.has(skill.name))];
}

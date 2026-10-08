import { isDeepStrictEqual } from "node:util";
import { relative } from "node:path";
import { PoiesisError } from "./errors.js";
import type { PoiesisConfig } from "./config.js";
import {
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_CONFIG_RELATIVE_PATHS,
  CERTIFIED_OPENCODE_VERSIONS,
  CERTIFIED_OPENCODE_VERSION,
  desiredOpenCodePatches,
  isCertifiedOpenCodeVersion,
  workerFocusedCheckAllowKey,
} from "./opencode.js";
import { loadDefaultSkills, skillPath, SKILLS_DIRECTORY } from "./skills.js";
import { templateMappings } from "./templates.js";
import type { ConfigPatch, ManagedFile, Manifest, ManagedSkill } from "./manifest.js";

function isSupportedAdapterContract(manifest: Manifest): boolean {
  const explicit = manifest.adapter.supportedVersions;
  if (explicit !== undefined) {
    if (explicit.length === 0) return false;
    if (!explicit.every(isCertifiedOpenCodeVersion)) return false;
    if (!explicit.includes(manifest.adapter.supportedVersion)) return false;
    return true;
  }
  return isCertifiedOpenCodeVersion(manifest.adapter.supportedVersion);
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
        supportedVersion: CERTIFIED_OPENCODE_VERSION,
        supportedVersions: [...CERTIFIED_OPENCODE_VERSIONS],
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
 * adapter. Differs from the current projection in THREE fields:
 *   - `agent.poiesis.permission.bash` retains the bare-launcher-allow
 *     surface (`poiesis *` / `pnpm exec poiesis *` / `npx poiesis *`)
 *     that v1.0.x shipped; the v1.1.2 surface denies these and allows
 *     only the exact-version `pnpm dlx poiesis-cli@<X>` route.
 *   - `agent.poiesis-worker.permission.bash` retains the pre-#113 Worker
 *     deny surface (`git *` / `poiesis *` / `pnpm exec poiesis *` /
 *     `npx poiesis *`); v1.1.2 (Spec #104 / ticket #113) additionally
 *     denies `pnpm dlx poiesis-cli *` and `pnpm dlx poiesis-cli@*` so the
 *     Worker broad `*` allow cannot invoke the same authorized primary
 *     canonical route through `pnpm dlx`.
 *   - `agent.poiesis-reviewer.permission.task` retains the obsolete
 *     `{ explore: "allow" }` field that ticket #24 removed from runtime
 *     installations.
 *
 * Kept intentionally narrow: this is a migration-only exact predecessor
 * projection, not a general historical-normalization helper. New patches
 * must NOT be added here without an explicit ticket and migration contract.
 */
export function predecessorProjectionV100V101V102(
  config: PoiesisConfig,
  poiesisVersion: string,
): Array<{ path: string[]; value: unknown }> {
  const legacyPrimaryBash: Record<string, string> = {
    "poiesis *": "allow",
    "pnpm exec poiesis *": "allow",
    "npx poiesis *": "allow",
  };
  const legacyWorkerBash: Record<string, string> = {
    "*": "allow",
    "git *": "deny",
    "poiesis *": "deny",
    "pnpm exec poiesis *": "deny",
    "npx poiesis *": "deny",
  };
  return desiredOpenCodePatches(config, poiesisVersion).map((patch) => {
    if (patch.path.length === 2 && patch.path[0] === "agent") {
      if (patch.path[1] === "poiesis") {
        const installed = patch.value as Record<string, unknown>;
        const permission = {
          ...(installed.permission as Record<string, unknown>),
          bash: legacyPrimaryBash,
        };
        return { ...patch, value: { ...installed, permission } };
      }
      if (patch.path[1] === "poiesis-worker") {
        const installed = patch.value as Record<string, unknown>;
        const permission = {
          ...(installed.permission as Record<string, unknown>),
          bash: legacyWorkerBash,
        };
        return { ...patch, value: { ...installed, permission } };
      }
      if (patch.path[1] === "poiesis-reviewer") {
        const installed = patch.value as Record<string, unknown>;
        // Spec #120 / ticket #123 — the 1.0.x predecessor projection
        // had NO bash surface for the ticket Reviewer; strip the
        // v1.2 narrow Repository Intelligence bash surface so the
        // projection stays byte-for-byte equivalent to what the
        // legacy 1.0.0 / 1.0.1 / 1.0.2 install actually wrote to
        // disk.
        const permission = { ...(installed.permission as Record<string, unknown>) };
        delete permission.bash;
        permission.task = { explore: "allow" };
        return { ...patch, value: { ...installed, permission } };
      }
      // Spec #120 / ticket #123 — the 1.0.x predecessor projection
      // had NO bash surface for the planner / final-reviewer /
      // research subagents. A predecessor manifest that matches the
      // 1.0.x shape therefore must not carry the v1.2 narrow
      // Repository Intelligence bash surface for those agents. Strip
      // the bash key from every non-primary/non-worker/reviewer agent
      // so the predecessor projection stays byte-for-byte equivalent
      // to what the legacy 1.0.0 / 1.0.1 / 1.0.2 install actually
      // wrote to disk.
      if (
        patch.path[1] === "poiesis-planner" ||
        patch.path[1] === "poiesis-final-reviewer" ||
        patch.path[1] === "poiesis-research"
      ) {
        const installed = patch.value as Record<string, unknown>;
        const permission = { ...(installed.permission as Record<string, unknown>) };
        delete permission.bash;
        return { ...patch, value: { ...installed, permission } };
      }
    }
    return patch;
  });
}

/**
 * The exact v1.0.0 predecessor projection for the OpenCode adapter.
 * Differs from the current projection in the SAME three fields as
 * `predecessorProjectionV100V101V102` (primary-bash, worker-bash, and
 * reviewer.task); kept as a distinct helper for clarity at the only
 * call site that distinguishes 1.0.0 from the wider 1.0.x family — the
 * explicit `update --bootstrap-legacy-ownership` path, which is
 * 1.0.0-only. The default authority flow (doctor, uninstall,
 * installCapability) and ordinary receipt-authenticated update do NOT
 * consult this helper.
 *
 * Kept intentionally narrow: this is a migration-only exact predecessor
 * projection, not a general historical-normalization helper.
 */
export function predecessorProjectionV100(
  config: PoiesisConfig,
  poiesisVersion: string,
): Array<{ path: string[]; value: unknown }> {
  return predecessorProjectionV100V101V102(config, poiesisVersion);
}

/**
 * The exact v1.1.1 predecessor primary bash projection. v1.1.1 was the last
 * release that exposed the bare `poiesis`, `pnpm exec poiesis`, and
 * `npx poiesis` launchers as the canonical Poiesis routes under the
 * primary agent's `permission.bash`. v1.1.2 (spec #104 / ticket #105)
 * replaces that surface with a broad ordinary shell plus ordered ambiguous
 * launcher denies plus an exact-version `pnpm dlx poiesis-cli@X` allow
 * last. This helper returns the 1.1.1 projection so an existing 1.1.1
 * manifest (verified by a trusted ownership receipt) can be accepted by
 * `assertManifestAuthorityToleratingPredecessor` and then transitioned to
 * 1.1.2 by an explicit `update`.
 *
 * Differs from the current projection in TWO fields:
 *   - `agent.poiesis.permission.bash` retains the v1.1.1
 *     bare-launcher-allow surface.
 *   - `agent.poiesis-worker.permission.bash` retains the pre-#113
 *     Worker deny surface; v1.1.2 (Spec #104 / ticket #113) additionally
 *     denies `pnpm dlx poiesis-cli *` and `pnpm dlx poiesis-cli@*` so
 *     the Worker broad `*` allow cannot invoke the same authorized
 *     primary canonical route through `pnpm dlx`.
 *
 * Kept intentionally narrow.
 */
export function predecessorProjectionV111(
  config: PoiesisConfig,
  poiesisVersion: string,
): Array<{ path: string[]; value: unknown }> {
  const v111PrimaryBash: Record<string, string> = {
    "poiesis *": "allow",
    "pnpm exec poiesis *": "allow",
    "npx poiesis *": "allow",
  };
  const legacyWorkerBash: Record<string, string> = {
    "*": "allow",
    "git *": "deny",
    "poiesis *": "deny",
    "pnpm exec poiesis *": "deny",
    "npx poiesis *": "deny",
  };
  return desiredOpenCodePatches(config, poiesisVersion).map((patch) => {
    if (patch.path.length === 2 && patch.path[0] === "agent") {
      if (patch.path[1] === "poiesis") {
        const installed = patch.value as Record<string, unknown>;
        const permission = {
          ...(installed.permission as Record<string, unknown>),
          bash: v111PrimaryBash,
        };
        return { ...patch, value: { ...installed, permission } };
      }
      if (patch.path[1] === "poiesis-worker") {
        const installed = patch.value as Record<string, unknown>;
        const permission = {
          ...(installed.permission as Record<string, unknown>),
          bash: legacyWorkerBash,
        };
        return { ...patch, value: { ...installed, permission } };
      }
    }
    return patch;
  });
}

/**
 * The exact v1.1.3 / v1.1.4 predecessor projection for the OpenCode
 * adapter. Differs from the current projection in THREE fields:
 *
 *   - `agent.poiesis-worker.permission.bash` retains the pre-#123
 *     Worker deny surface (`*` allow + `git *` / `poiesis *` /
 *     `pnpm exec poiesis *` / `npx poiesis *` /
 *     `pnpm dlx poiesis-cli *` / `pnpm dlx poiesis-cli@*` denies);
 *     Spec #120 / ticket #123 appended the four Repository
 *     Intelligence additive allows (status / query / path / explain)
 *     AFTER the `pnpm dlx poiesis-cli@*` deny so the v1.2 Worker
 *     bash surface is a strict superset of the 1.1.3 / 1.1.4 surface.
 *     The 1.1.3 / 1.1.4 install never shipped the Repository
 *     Intelligence additive allows.
 *   - `agent.poiesis-planner.permission.bash` is STRIPPED entirely:
 *     the 1.1.3 / 1.1.4 Planner carried no bash surface; the v1.2
 *     Planner gained the narrow Repository Intelligence bash
 *     surface (tickets #121 / #123).
 *   - `agent.poiesis-reviewer.permission.bash` is STRIPPED entirely:
 *     the 1.1.3 / 1.1.4 Ticket Reviewer carried no bash surface;
 *     the v1.2 Ticket Reviewer gained the narrow Repository
 *     Intelligence bash surface (ticket #123).
 *   - `agent.poiesis-final-reviewer.permission.bash` is STRIPPED
 *     entirely: the 1.1.3 / 1.1.4 Final Reviewer carried no bash
 *     surface; the v1.2 Final Reviewer gained the narrow Repository
 *     Intelligence bash surface (ticket #123).
 *
 * The primary bash surface (`agent.poiesis.permission.bash`) and the
 * Specialist `poiesis-research` permission are UNCHANGED between the
 * 1.1.3 / 1.1.4 install and the current 1.2.x projection because the
 * exact-version canonical route `pnpm dlx poiesis-cli@<X>` already
 * shipped in 1.1.3 / 1.1.4 (the v1.1.2 / Spec #104 / ticket #105
 * primary-bash refactor) and Research already carried no bash
 * surface in 1.1.3 / 1.1.4. The helper therefore only mutates the
 * four fields listed above.
 *
 * The `poiesisVersion` parameter MUST equal `"1.1.3"` or `"1.1.4"`.
 * It drives the exact-version allow key
 * `pnpm dlx poiesis-cli@<poiesisVersion> *` on the primary agent;
 * `desiredOpenCodePatches` already produces the correct primary
 * surface for either value because the exact-version canonical route
 * was introduced in v1.1.2 and unchanged in 1.1.3 / 1.1.4. Passing
 * any other value is undefined behavior (the helper makes no
 * structural promise; the authority gate that uses it rejects
 * non-1.1.3 / non-1.1.4 predecessors upstream).
 *
 * Kept intentionally narrow: this is a migration-only exact
 * predecessor projection, not a general historical-normalization
 * helper. New patches must NOT be added here without an explicit
 * ticket and migration contract.
 */
export function predecessorProjectionV113V114(
  config: PoiesisConfig,
  poiesisVersion: "1.1.3" | "1.1.4",
): Array<{ path: string[]; value: unknown }> {
  const v113V114WorkerBash: Record<string, string> = {
    "*": "allow",
    "git *": "deny",
    "poiesis *": "deny",
    "pnpm exec poiesis *": "deny",
    "npx poiesis *": "deny",
    "pnpm dlx poiesis-cli *": "deny",
    "pnpm dlx poiesis-cli@*": "deny",
  };
  return desiredOpenCodePatches(config, poiesisVersion).map((patch) => {
    if (patch.path.length === 2 && patch.path[0] === "agent") {
      if (patch.path[1] === "poiesis-worker") {
        const installed = patch.value as Record<string, unknown>;
        const permission = {
          ...(installed.permission as Record<string, unknown>),
          bash: v113V114WorkerBash,
        };
        return { ...patch, value: { ...installed, permission } };
      }
      // Spec #131 / ticket #132 — the 1.1.3 / 1.1.4 install carried
      // NO bash surface for the Planner / Ticket Reviewer / Final
      // Reviewer Specialist agents. The v1.2 narrow Repository
      // Intelligence bash surface (Spec #120 / tickets #121 / #123)
      // is a post-1.1.4 additive. Strip the `permission.bash` key
      // from those three agents so the predecessor projection stays
      // byte-for-byte equivalent to what the legacy 1.1.3 / 1.1.4
      // install actually wrote to disk. The Ticket Reviewer's
      // `permission.task = { explore: "allow" }` (which the
      // 1.0.x predecessor projection strips — Spec #120 / ticket
      // #123) is absent from the v1.1.3 / 1.1.4 projection AND the
      // current projection, so no task key needs to be re-added.
      if (
        patch.path[1] === "poiesis-planner" ||
        patch.path[1] === "poiesis-reviewer" ||
        patch.path[1] === "poiesis-final-reviewer"
      ) {
        const installed = patch.value as Record<string, unknown>;
        const permission = { ...(installed.permission as Record<string, unknown>) };
        delete permission.bash;
        return { ...patch, value: { ...installed, permission } };
      }
    }
    return patch;
  });
}

/**
 * Spec #168 / ticket #174 — the exact pre-focused-check predecessor
 * projection for the OpenCode adapter.
 *
 * Ticket #173 added ONE narrow allow — the Worker's
 * `pnpm dlx poiesis-cli@<version> check *` focused-check route — inside the
 * `1.4.0` release line WITHOUT bumping `manifest.poiesisVersion`. A project
 * installed by the EARLIER image of that line therefore records
 * `poiesisVersion = "1.4.0"` and a `configPatches` set that no longer equals
 * `desiredOpenCodePatches(config, "1.4.0")`. Without this projection that
 * manifest is admitted by NEITHER the strict gate NOR any accepted
 * predecessor, so the only migration boundary — the receipt-authenticated
 * `update` — fails closed with `MANIFEST_AUTHORITY_INVALID` and an
 * already-installed project can never reach the faster authoritative flow.
 *
 * The projection is keyed off the SUPPLIED `poiesisVersion`, which is the
 * predecessor release itself (`"1.4.0"`), never the running runtime. For that
 * version it differs from that version's own strict projection in exactly ONE
 * field:
 *   - `agent.poiesis-worker.permission.bash` omits the single focused-check
 *     allow key.
 *
 * Everything else — the primary's exact-version canonical route, the ordered
 * launcher denies, the Repository Intelligence additive allows, the Specialist
 * bash surfaces, and every model / task wiring — is UNCHANGED. In particular
 * the projection stays fail-closed on launcher identity: the migration
 * restores the current projection and grants no broad `…@<version> *`,
 * `@latest`, or unversioned route.
 *
 * The removed key is derived through `workerFocusedCheckAllowKey`, the same
 * builder the current projection uses, so this helper can only ever delete a
 * key the current projection still emits. If a future release drops that
 * allow, the deletion is a no-op and this projection simply collapses onto the
 * current one, which the gate already admitted before it ever reaches here.
 *
 * Kept intentionally narrow: this is a migration-only exact predecessor
 * projection, not a general historical-normalization helper. New patches must
 * NOT be added here without an explicit ticket and migration contract.
 */
export function predecessorProjectionPreFocusedCheck(
  config: PoiesisConfig,
  poiesisVersion: string,
): Array<{ path: string[]; value: unknown }> {
  const focusedCheckAllow = workerFocusedCheckAllowKey(poiesisVersion);
  return desiredOpenCodePatches(config, poiesisVersion).map((patch) => {
    if (patch.path.length === 2 && patch.path[0] === "agent" && patch.path[1] === "poiesis-worker") {
      const installed = patch.value as Record<string, unknown>;
      const permission = installed.permission as Record<string, unknown> & { bash: Record<string, string> };
      const bash = { ...permission.bash };
      delete bash[focusedCheckAllow];
      return { ...patch, value: { ...installed, permission: { ...permission, bash } } };
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
 * also accepts the exact v1.0.0/v1.0.1/v1.0.2 predecessor projection
 * (which retained `poiesis-reviewer.permission.task = { explore: "allow" }`
 * and the pre-#113 Worker bash surface) and, when explicitly accepted,
 * the exact v1.1.1 predecessor primary-bash + pre-#113 Worker bash
 * projection and the exact v1.1.3 / v1.1.4 predecessor projection
 * (which stripped the v1.2 narrow Repository Intelligence bash
 * surface from the Specialist agents).
 *
 * Use this ONLY after authenticating the receipt: the receipt binds the
 * trusted manifest digest, this function then proves the manifest's projection
 * matches either the current exact or one of the accepted predecessor exact
 * projections.
 *
 * Callers MUST pass the explicit predecessor version set they accept. The
 * default accepts the three v1.0.0/1.0.1/1.0.2 versions, but bootstrap and
 * update paths use different subsets per ticket #24 Replan:
 *   - receipt-authenticated update: `["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4", "1.4.0"]`
 *     (1.1.1 is accepted only here, on explicit `update`, because the
 *     primary-bash surface changed in 1.1.2 and any pre-existing 1.1.1
 *     install must be transitioned through the receipt-gated update path;
 *     1.1.3 / 1.1.4 are accepted for the same reason — the v1.2
 *     Specialist bash surface is a post-1.1.4 additive, so any
 *     pre-existing 1.1.3 / 1.1.4 install must be transitioned through
 *     the receipt-gated update path)
 *   - bootstrap legacy ownership: `["1.0.0"]` (the version is already pinned
 *     by `validateLegacyInstallation`, so this is defense-in-depth)
 *
 * `"1.4.0"` is accepted by the receipt-gated `update` as the PUBLISHED
 * PREDECESSOR of the current release: ticket #173's narrow focused-check
 * allow changed the exact 1.4.0 projection WITHOUT bumping the release
 * version, so a project installed by the earlier 1.4.0 image records
 * `poiesisVersion = "1.4.0"` with a pre-focused-check `configPatches` set.
 * Only that exact set is admitted, and only the receipt-gated `update` may
 * transition it onto the current projection; `doctor`, `uninstall`,
 * `installCapability`, and the explicit `updateFromConfig` remain
 * current-projection-only.
 *
 * If the manifest matches neither projection, the original strict failure
 * is rethrown unchanged so callers see the same diagnostic.
 */
export async function assertManifestAuthorityToleratingPredecessor(
  root: string,
  manifest: Manifest,
  config: PoiesisConfig,
  acceptedPredecessorVersions: ReadonlyArray<"1.0.0" | "1.0.1" | "1.0.2" | "1.1.1" | "1.1.3" | "1.1.4" | "1.4.0"> = [
    "1.0.0",
    "1.0.1",
    "1.0.2",
  ],
): Promise<void> {
  // Spec #104 / ticket #105: the exact-version canonical route
  // `pnpm dlx poiesis-cli@<X>` derives from the manifest's recorded
  // `poiesisVersion`, so the strict current projection is keyed off the
  // manifest's own version rather than the runtime's package version.
  // This keeps doctor / uninstall / installCapability authority stable
  // across patch bumps of the runtime image.
  const currentPatches = desiredOpenCodePatches(config, manifest.poiesisVersion);
  try {
    await assertManifestAuthorityImpl(root, manifest, currentPatches);
    return;
  } catch (strictError) {
    if (!(strictError instanceof PoiesisError) || strictError.code !== "MANIFEST_AUTHORITY_INVALID") {
      throw strictError;
    }
  }
  const isPredecessorVersion = (acceptedPredecessorVersions as ReadonlyArray<string>).includes(manifest.poiesisVersion);
  if (!isPredecessorVersion) {
    await assertManifestAuthorityImpl(root, manifest, currentPatches);
    return;
  }
  // 1.1.1 predecessor projection: primary-bash AND pre-#113 worker-bash
  // both differ from current.
  if (manifest.poiesisVersion === "1.1.1") {
    const predecessor = predecessorProjectionV111(config, manifest.poiesisVersion);
    if (isExactProjection(manifest, predecessor)) {
      await assertManifestAuthorityImpl(root, manifest, predecessor);
      return;
    }
  }
  // Spec #131 / ticket #132 — 1.1.3 / 1.1.4 predecessor projection:
  // Worker bash carries the pre-#123 surface (no Repository
  // Intelligence additive allows) and the Specialist agents
  // (Planner / Ticket Reviewer / Final Reviewer) carry NO `bash`
  // key at all. The primary bash surface and the `poiesis-research`
  // permission are unchanged from the current projection because
  // the exact-version canonical route `pnpm dlx poiesis-cli@<X>`
  // already shipped in 1.1.3 / 1.1.4. Both predecessor versions
  // share the same surface; the supplied `poiesisVersion` parameter
  // drives only the exact-version allow key.
  if (manifest.poiesisVersion === "1.1.3" || manifest.poiesisVersion === "1.1.4") {
    const predecessor = predecessorProjectionV113V114(config, manifest.poiesisVersion);
    if (isExactProjection(manifest, predecessor)) {
      await assertManifestAuthorityImpl(root, manifest, predecessor);
      return;
    }
  }
  // Spec #168 / ticket #174 — the pre-focused-check predecessor, which is the
  // PUBLISHED PREDECESSOR release `1.4.0`. Ticket #173 changed the exact 1.4.0
  // projection without a version bump, so an install made by the earlier
  // 1.4.0 image records `poiesisVersion = "1.4.0"` with one allow key missing.
  // This branch is reached ONLY for `poiesisVersion === "1.4.0"` and ONLY after
  // the receipt already authenticated the manifest digest.
  //
  // It deliberately does NOT fall through to the legacy 1.0.x projection
  // when the manifest does not match exactly: a 1.4.0 manifest can never
  // legitimately carry the 1.0.x surface, so continuing would only widen
  // what an accepted version admits. A non-matching 1.4.0 manifest is drift
  // and is rethrown by the strict check below.
  if (manifest.poiesisVersion === "1.4.0") {
    const predecessor = predecessorProjectionPreFocusedCheck(config, manifest.poiesisVersion);
    if (isExactProjection(manifest, predecessor)) {
      await assertManifestAuthorityImpl(root, manifest, predecessor);
      return;
    }
    await assertManifestAuthorityImpl(root, manifest, currentPatches);
    return;
  }
  // v1.0.0 predecessor projection: primary-bash, worker-bash, AND
  // reviewer.task all differ from current. Only the explicit
  // bootstrap-legacy-ownership path uses this predecessor (the
  // accepted-predecessor set is `["1.0.0"]` in that path), so a 1.0.0
  // manifest that drifts from the current projection shape is admitted
  // only here and never by the ordinary receipt-authenticated update
  // path.
  if (manifest.poiesisVersion === "1.0.0") {
    const v100Predecessor = predecessorProjectionV100(config, manifest.poiesisVersion);
    if (isExactProjection(manifest, v100Predecessor)) {
      await assertManifestAuthorityImpl(root, manifest, v100Predecessor);
      return;
    }
  }
  // v1.0.0 / v1.0.1 / v1.0.2 predecessor projection: poiesis-reviewer.permission.task differs.
  const legacyPredecessor = predecessorProjectionV100V101V102(config, manifest.poiesisVersion);
  if (!isExactProjection(manifest, legacyPredecessor)) {
    await assertManifestAuthorityImpl(root, manifest, currentPatches);
    return;
  }
  await assertManifestAuthorityImpl(root, manifest, legacyPredecessor);
}

/**
 * Strict current-only authority check. This function is the single source of
 * truth for non-migration flows (init, installCapability, uninstall, doctor).
 * Migration flows (update with receipt, bootstrap-legacy) delegate to
 * `assertManifestAuthorityToleratingPredecessor` instead. The current
 * projection is keyed off the manifest's own `poiesisVersion` so a strict
 * authority check recognizes the exact-version canonical route
 * `pnpm dlx poiesis-cli@<X>` that THIS manifest records, independent of
 * the runtime image.
 */
export async function assertManifestAuthority(root: string, manifest: Manifest, config: PoiesisConfig): Promise<void> {
  await assertManifestAuthorityImpl(root, manifest, desiredOpenCodePatches(config, manifest.poiesisVersion));
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

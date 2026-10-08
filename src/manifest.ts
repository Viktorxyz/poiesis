import { z } from "zod";
import { readUtf8 } from "./fs.js";
import { parseJsonc } from "./config.js";
import { PoiesisError } from "./errors.js";
import { poiesisPath } from "./paths.js";

const managedFileSchema = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["generated", "canonical"]),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  owned: z.literal(true),
  /** Durable project-tracked files remain tracked in the consumer repository. */
  durable: z.boolean().optional(),
  /**
   * Spec #190 / ticket #191 — where this artifact came from, so a reader
   * can classify it without re-deriving the template table:
   * `package` is package-supplied canon copied verbatim, `projection` is
   * a generated OpenCode agent projection of that canon, and `config` is
   * the OpenCode configuration document Poiesis created.
   */
  provenance: z.enum(["package", "projection", "config"]).optional(),
});

/**
 * Spec #190 / ticket #191 — exact ownership of the ONE `.gitignore`
 * block this installation inserted.
 *
 * `hash` is the identity `uninstall` reverses against: the exact block
 * text at install time. `fileCreated` records whether the file existed
 * before this installation, so removal of a now-empty file deletes it
 * while removal from a pre-existing file restores the Author's original
 * content untouched.
 */
/**
 * Spec #190 / ticket #191 — delivery scripts this installation generated.
 *
 * They are deliberately NOT `files` records: Spec #138 makes them ordinary
 * project files the Author may edit freely, so they must never fail a
 * doctor hash check. But in a private installation they are Poiesis-owned
 * generated artifacts, so uninstall must still be able to recognise an
 * UNCHANGED one and remove it while preserving and reporting an edited one.
 */
const generatedScriptSchema = z.strictObject({
  path: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

const ignoreBlockSchema = z.strictObject({
  path: z.literal(".gitignore"),
  mode: z.enum(["private", "team"]),
  patterns: z.array(z.string().min(1)).min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  fileCreated: z.boolean(),
  owned: z.literal(true),
});

const skillSchema = z.strictObject({
  source: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  preexisting: z.boolean(),
  installedRevision: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const configPatchSchema = z.strictObject({
  file: z.string().min(1),
  path: z.array(z.string()).min(1),
  previousExists: z.boolean(),
  previous: z.unknown().optional(),
  installed: z.unknown(),
});

export const manifestSchema = z.strictObject({
  schema: z.literal(1),
  poiesisVersion: z.string().min(1),
  adapter: z.strictObject({
    harness: z.literal("opencode"),
    adapterVersion: z.string().min(1),
    supportedVersion: z.string().min(1),
    /**
     * Optional explicit set of OpenCode versions the manifest was authored
     * against. Absent on legacy manifests; when present every entry must
     * be a member of the adapter-version-1 supported set. Authority also
     * accepts a manifest whose `supportedVersion` alone is a member of the
     * supported set so pre-supported-set manifests remain valid under the
     * current runtime.
     */
    supportedVersions: z.array(z.string().min(1)).optional(),
  }),
  files: z.array(managedFileSchema),
  skills: z.array(skillSchema),
  configPatches: z.array(configPatchSchema),
  /**
   * Spec #190 / ticket #191 — the installation mode, recorded so doctor,
   * update, and uninstall can report it and so a later mode change is an
   * explicit decision rather than an inference. Absent on manifests
   * written before the mode existed; those installs keep their legacy
   * shape and are never relabelled silently.
   */
  mode: z.enum(["private", "team"]).optional(),
  /** Exact ownership of the managed `.gitignore` block. */
  ignoreBlock: ignoreBlockSchema.optional(),
  /** Delivery scripts this installation generated, with their installed digest. */
  generatedScripts: z.array(generatedScriptSchema).optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManagedFile = z.infer<typeof managedFileSchema>;
export type ManagedSkill = z.infer<typeof skillSchema>;
export type ConfigPatch = z.infer<typeof configPatchSchema>;
export type IgnoreBlockRecord = z.infer<typeof ignoreBlockSchema>;
export type GeneratedScriptRecord = z.infer<typeof generatedScriptSchema>;

export async function loadManifest(root: string): Promise<Manifest> {
  const path = poiesisPath(root, "manifest.json");
  const value = parseJsonc<unknown>(await readUtf8(path), path);
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    throw new PoiesisError("INVALID_MANIFEST", `Invalid Poiesis manifest in ${path}`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

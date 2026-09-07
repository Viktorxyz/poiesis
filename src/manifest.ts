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
  }),
  files: z.array(managedFileSchema),
  skills: z.array(skillSchema),
  configPatches: z.array(configPatchSchema),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManagedFile = z.infer<typeof managedFileSchema>;
export type ManagedSkill = z.infer<typeof skillSchema>;
export type ConfigPatch = z.infer<typeof configPatchSchema>;

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

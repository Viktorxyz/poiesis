import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { predecessorProjectionV100, predecessorProjectionV100V101V102 } from "../src/authority.js";
import { hashContent } from "../src/hash.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { removeOwnershipReceipt } from "../src/receipt.js";

export type LegacyVersion = "1.0.0" | "1.0.1" | "1.0.2";

/**
 * Spec #104 / ticket #105: rewrite a manifest AND the on-disk
 * OpenCode config into the exact legacy (1.0.x) predecessor projection
 * so the explicit `bootstrap-legacy-ownership` path (1.0.0) or the
 * receipt-authenticated update path (1.0.1 / 1.0.2) admits the
 * manifest through `assertManifestAuthorityToleratingPredecessor`.
 *
 * Pre-ticket, the test fixture only flipped `manifest.poiesisVersion`
 * while leaving `configPatches` in their 1.1.2 shape. That worked when
 * `desiredOpenCodePatches` ignored the version string. After the
 * runtime identity boundary binds the primary bash to
 * `pnpm dlx poiesis-cli@<X>`, an internally-inconsistent manifest
 * (1.0.0 version label + 1.1.2-shape configPatches) is rejected by the
 * strict authority check, so the predecessor projection must be
 * installed in full: legacy primary bash + (for 1.0.x) obsolete
 * reviewer.task.
 *
 * The fixture reads the live OpenCode config off disk so the
 * predecessor projection is keyed off the same reasoning/execution
 * models the manifest already records, then rewrites the on-disk
 * bytes AND updates the manifest.files[] entry for `opencode.jsonc`
 * so the bootstrap transaction's three ownership checks (authority,
 * file-hash, snapshot-config-patches) all pass.
 */
export async function asLegacyProjection(
  root: string,
  predecessorVersion: LegacyVersion,
  options: { keepReceipt?: boolean; openCodeRelativePath?: string } = {},
): Promise<Manifest> {
  const openCodeRelativePath = options.openCodeRelativePath ?? "opencode.jsonc";
  const fixtureConfig = await fixtureConfigForOpenCode(root, openCodeRelativePath);
  const predecessor =
    predecessorVersion === "1.0.0"
      ? predecessorProjectionV100(fixtureConfig, "1.0.0")
      : predecessorProjectionV100V101V102(fixtureConfig, predecessorVersion);
  const manifest = await loadManifest(root);
  const openCodePath = join(root, openCodeRelativePath);
  const openCodeBytes = await readFile(openCodePath, "utf8");
  manifest.poiesisVersion = predecessorVersion;
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (entry) => entry.path.length === patch.path.length && entry.path.every((s, i) => s === patch.path[i]),
    );
    if (matching === undefined) return patch;
    return { ...patch, installed: matching.value };
  });
  const current = JSON.parse(openCodeBytes) as Record<string, unknown>;
  for (const patch of manifest.configPatches) {
    let target: Record<string, unknown> = current;
    for (let i = 0; i < patch.path.length - 1; i++) {
      const segment = patch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[patch.path[patch.path.length - 1]!] = patch.installed;
  }
  const rewrittenOpenCodeBytes = JSON.stringify(current, null, 2) + "\n";
  await writeFile(openCodePath, rewrittenOpenCodeBytes);
  manifest.files = manifest.files.map((file) =>
    file.path === openCodeRelativePath ? { ...file, hash: hashContent(rewrittenOpenCodeBytes) } : file,
  );
  await writeFile(join(root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  if (!options.keepReceipt) {
    await removeOwnershipReceipt(root);
  }
  return manifest;
}

async function fixtureConfigForOpenCode(
  root: string,
  openCodeRelativePath: string,
): Promise<{
  schema: 1;
  models: { reasoning: string; execution: string };
  repository: { remote: string; integrationBranch: string };
  tracker: { provider: "github"; project: string };
  delivery: {
    preview: { adapter: "command"; command: string[] };
    staging: { adapter: "command"; command: string[] };
    production: { adapter: "command"; command: string[] };
  };
  verification: { commands: string[] };
}> {
  const openCodePath = join(root, openCodeRelativePath);
  const openCodeConfig = JSON.parse(await readFile(openCodePath, "utf8")) as {
    agent?: Record<string, Record<string, unknown>>;
  };
  const reasoningModel = openCodeConfig.agent?.poiesis?.model;
  const executionModel = openCodeConfig.agent?.["poiesis-worker"]?.model;
  if (typeof reasoningModel !== "string" || typeof executionModel !== "string") {
    throw new Error("asLegacyProjection fixture requires a live OpenCode config with primary + worker model wiring");
  }
  return {
    schema: 1,
    models: { reasoning: reasoningModel, execution: executionModel },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "github", project: "owner/repo" },
    delivery: {
      preview: { adapter: "command", command: ["scripts/poiesis-preview.sh", "{sha}"] },
      staging: { adapter: "command", command: ["scripts/poiesis-staging.sh", "{sha}"] },
      production: { adapter: "command", command: ["scripts/poiesis-production.sh", "{sha}"] },
    },
    verification: { commands: ["test -f README.md"] },
  };
}

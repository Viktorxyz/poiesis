import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  predecessorProjectionV100V101V102,
  predecessorProjectionV111,
} from "../src/authority.js";
import { init } from "../src/maintenance.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { parseJsonc } from "../src/config.js";
import { readUtf8 } from "../src/fs.js";
import {
  ownershipReceiptExists,
  readOwnershipReceipt,
  removeOwnershipReceipt,
  replaceOwnershipReceipt,
} from "../src/receipt.js";
import type { TestRepository } from "./helpers.js";
import { testConfig } from "./helpers.js";

/**
 * Shared predecessor-migration fixtures used by ticket-level tests
 * exercising the receipt-authenticated 1.0.x → 1.1.2 and
 * 1.1.1 → 1.1.2 update path. Extracted from `predecessor-migration.test.ts`
 * so additional tickets (e.g. ticket #109 — Realize convergence role
 * guidance) can reuse them without copying the helper bodies.
 */
export async function asPredecessorManifest(
  repository: TestRepository,
  predecessorVersion: "1.0.0" | "1.0.1" | "1.0.2" | "1.1.1",
  options: { keepReceipt?: boolean } = {},
): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor =
    predecessorVersion === "1.1.1"
      ? predecessorProjectionV111(config, predecessorVersion)
      : predecessorProjectionV100V101V102(config, predecessorVersion);
  manifest.poiesisVersion = predecessorVersion;
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) =>
        p.path.length === patch.path.length &&
        p.path.every((s, i) => s === patch.path[i]),
    );
    if (matching === undefined) return patch;
    return { ...patch, installed: matching.value };
  });
  await writeFile(
    join(repository.root, ".poiesis", "manifest.json"),
    serializeManifest(manifest),
  );
  const openCodePath = join(repository.root, "opencode.jsonc");
  const current = parseJsonc<Record<string, unknown>>(await readUtf8(openCodePath), openCodePath);
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
  await writeFile(openCodePath, JSON.stringify(current, null, 2) + "\n");
  if (!options.keepReceipt && (await ownershipReceiptExists(repository.root))) {
    await removeOwnershipReceipt(repository.root);
  }
  return manifest;
}

export async function rebindReceipt(repository: TestRepository): Promise<void> {
  const manifest = await loadManifest(repository.root);
  const existing = await readOwnershipReceipt(repository.root);
  await replaceOwnershipReceipt(repository.root, manifest, existing);
}

export async function setupCurrentInstall(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}
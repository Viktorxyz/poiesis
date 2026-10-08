/**
 * Spec #139 / ticket #162 — ownership of the generated delivery runtime.
 *
 * A generated delivery target records its artifact under
 * `.poiesis/runtime/delivery/<target>/<sha>/delivery.json`. That is DERIVED
 * state: it is reproducible from the next run, it is not project truth, and
 * it is never a manifest record. Its exact ownership is what this module
 * states once, so the ignore rule, the generated script, the uninstall
 * walker, and the removal path can never disagree:
 *
 *   - `.poiesis/runtime/` is the CONTAINER. Poiesis owns exactly ONE entry
 *     inside it: `delivery/`. Every other sibling is FOREIGN and is never
 *     deleted.
 *   - The ignore rule is `.poiesis/runtime/delivery/` — the owned subtree,
 *     never the whole container. Ignoring the container would hide state
 *     Poiesis does not own and cannot restore.
 *   - Removal is validated before it is destructive. A symlinked container,
 *     a symlinked `delivery` root, or a symlink at ANY depth inside the
 *     owned subtree is refused, so no traversal and no `rm --recursive`
 *     ever follows a link out of the project.
 *
 * This is the same validated owned-subtree removal contract
 * `repository-intelligence.ts::removeValidatedRepositoryIntelligenceCache`
 * established for `.poiesis/cache/repository-intelligence/`: validate,
 * partition owned from foreign, remove only the owned entry, and remove an
 * empty parent only through `rmdir`.
 *
 * Nothing here is re-exported from `src/index.ts`: the layout, the ignore
 * rule, and the destructive seam stay module-internal (ticket #162 keeps the
 * public API unchanged).
 */
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, relative } from "node:path";
import { PoiesisError } from "./errors.js";

/** The Poiesis-owned runtime container, relative to the project root. */
export const DELIVERY_RUNTIME_CONTAINER = ".poiesis/runtime";

/** The single Poiesis-owned entry inside the container. */
export const DELIVERY_RUNTIME_OWNED_ENTRY = "delivery";

/** The Poiesis-owned runtime subtree, relative to the project root. */
export const DELIVERY_RUNTIME_RELATIVE = `${DELIVERY_RUNTIME_CONTAINER}/${DELIVERY_RUNTIME_OWNED_ENTRY}`;

/**
 * The exact `.gitignore` rule for the owned subtree. The trailing slash
 * scopes the rule to the directory Poiesis owns; the container itself is
 * deliberately NOT ignored.
 */
export const DELIVERY_RUNTIME_IGNORE_RULE = `${DELIVERY_RUNTIME_RELATIVE}/`;

export interface DeliveryRuntimeRemovalResult {
  /** `true` when the owned `delivery/` subtree was removed. */
  removed: boolean;
  /** Names of the container's entries Poiesis does not own, left intact. */
  foreignPreserved: string[];
}

/**
 * `lstat` that maps absence to `null` instead of throwing. Every caller in
 * this module needs the ENOENT case as an ordinary outcome, and using
 * `lstat` (never `stat`) is what keeps a symlink observable as a symlink
 * rather than as whatever it points at.
 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Recursive walk that refuses ANY symlink under the owned subtree, at any
 * depth, whether it is a directory or a plain entry. Stops at the first
 * violation so the caller never reaches the destructive `rm`.
 */
async function assertNoSymlinkedDeliveryRuntimeEntry(root: string, directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    const details = await lstat(child);
    if (details.isSymbolicLink()) {
      throw new PoiesisError(
        "DELIVERY_RUNTIME_UNSAFE",
        "Refusing to traverse a symlinked delivery runtime entry",
        { path: relative(root, child) },
      );
    }
    if (details.isDirectory()) await assertNoSymlinkedDeliveryRuntimeEntry(root, child);
  }
}

/**
 * Remove the Poiesis-owned generated delivery runtime for a clean uninstall.
 *
 *   1. An absent container is a successful no-op.
 *   2. A symlinked container, or a container that is not a directory, is
 *      refused (`DELIVERY_RUNTIME_UNSAFE` / `DELIVERY_RUNTIME_UNOWNED`)
 *      without being traversed.
 *   3. Every top-level entry other than `delivery` is reported as
 *      `foreignPreserved` and left byte-for-byte intact.
 *   4. The owned `delivery/` entry must itself be a real directory; a
 *      symlink there is refused because it is the recursive-removal target.
 *   5. The owned subtree is walked for symlinks BEFORE the removal, so a
 *      buried link can never be followed out of the project.
 *   6. Only after that validation is the owned subtree removed, and the
 *      container is `rmdir`-ed only when no foreign entry remains.
 */
export async function removeValidatedDeliveryRuntime(root: string): Promise<DeliveryRuntimeRemovalResult> {
  const container = join(root, DELIVERY_RUNTIME_CONTAINER);
  const containerDetails = await lstatOrNull(container);
  if (containerDetails === null) return { removed: false, foreignPreserved: [] };
  if (containerDetails.isSymbolicLink()) {
    throw new PoiesisError(
      "DELIVERY_RUNTIME_UNSAFE",
      "Refusing to remove a symlinked Poiesis runtime container",
      { path: DELIVERY_RUNTIME_CONTAINER },
    );
  }
  if (!containerDetails.isDirectory()) {
    throw new PoiesisError(
      "DELIVERY_RUNTIME_UNOWNED",
      "Refusing to remove a non-directory Poiesis runtime container",
      { path: DELIVERY_RUNTIME_CONTAINER },
    );
  }

  const foreignPreserved: string[] = [];
  for (const entry of await readdir(container, { withFileTypes: true })) {
    if (entry.name !== DELIVERY_RUNTIME_OWNED_ENTRY) foreignPreserved.push(entry.name);
  }

  const ownedDir = join(container, DELIVERY_RUNTIME_OWNED_ENTRY);
  const ownedDetails = await lstatOrNull(ownedDir);
  if (ownedDetails === null) return { removed: false, foreignPreserved };
  if (ownedDetails.isSymbolicLink() || !ownedDetails.isDirectory()) {
    throw new PoiesisError(
      "DELIVERY_RUNTIME_UNOWNED",
      "Refusing to remove a non-owned Poiesis runtime entry",
      { path: DELIVERY_RUNTIME_RELATIVE, ownedEntry: DELIVERY_RUNTIME_OWNED_ENTRY },
    );
  }
  await assertNoSymlinkedDeliveryRuntimeEntry(root, ownedDir);
  await rm(ownedDir, { recursive: true, force: true });

  // Only remove the container when it is empty AND nothing foreign was
  // reported. `rmdir` never deletes a non-empty directory, so a sibling
  // that raced in after the partition is preserved rather than deleted.
  if (foreignPreserved.length === 0) {
    try {
      const remaining = await readdir(container);
      if (remaining.length === 0) await rmdir(container);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Best-effort parent cleanup; the owned removal already succeeded.
      // ENOENT means a concurrent uninstall removed the container between
      // our `rm` and our `rmdir`, which is harmless.
      if (code !== "ENOENT") throw error;
    }
  }
  return { removed: true, foreignPreserved };
}

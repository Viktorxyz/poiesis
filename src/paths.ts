import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";
import { PoiesisError } from "./errors.js";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function resolveGitRoot(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (result.exitCode !== 0 || !result.stdout) {
    throw new PoiesisError("NOT_GIT_REPOSITORY", "Poiesis requires a Git repository", { cwd });
  }
  return resolve(result.stdout);
}

export function poiesisPath(root: string, ...parts: string[]): string {
  return join(root, ".poiesis", ...parts);
}

/**
 * Reject paths that could escape the project root or be misinterpreted by
 * downstream tooling. This is the canonical safe-path helper; both the
 * public `MaintenanceOptions` surface and the internal update transaction
 * seam resolve paths through this helper so the two modules never diverge
 * on what counts as "safe".
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false;
  const parts = path.split(/[\\/]/);
  return !parts.includes("") && !parts.includes(".") && !parts.includes("..");
}

/**
 * Resolve a manifest-relative path to its absolute on-disk location, asserting
 * the path stays inside the project root. Throws `UNSAFE_MANAGED_PATH` for
 * any path that escapes the root or fails `isSafeRelativePath`. Extracted to
 * this leaf module so the receipt-aware `update` transaction seam does not
 * need a top-level circular import back into `maintenance.ts`.
 */
export function ownedPath(root: string, path: string): string {
  if (!isSafeRelativePath(path)) {
    throw new PoiesisError("UNSAFE_MANAGED_PATH", "Manifest contains an unsafe managed path", { path });
  }
  const destination = resolve(root, path);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new PoiesisError("UNSAFE_MANAGED_PATH", "Managed path escapes the repository", { path });
  }
  return destination;
}

import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { exists } from "./fs.js";
import { PoiesisError } from "./errors.js";
import { run } from "./process.js";

/**
 * Spec #120 / ticket #121 — Repository Intelligence runtime seam.
 *
 * Poiesis v1.2 introduces a harness-neutral concept of Repository
 * Intelligence: a rebuildable, non-canonical, deterministic
 * representation of repository structure used to reduce broad source
 * rediscovery. Graphify is the v1.2 default engine, pinned to an exact
 * version and run through `uvx` so Poiesis owns neither a global
 * Graphify install nor a global Python interpreter.
 *
 * `uv` itself is a STANDARD Poiesis requirement as of v1.2, not an
 * optional optimization. Ticket #121 establishes the runtime boundary
 * and local-state ownership for this capability:
 *
 *   1. The cache directory `.poiesis/cache/` is Poiesis-owned local
 *      state; it is ignored by the repository's `.gitignore` and is
 *      never recorded as a manifest file (so it never enters Proof or
 *      durable identity).
 *   2. Every cache path is validated as inside the resolved repo root
 *      and free of symlinks; symlinked cache content is rejected with
 *      `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE`.
 *   3. Uninstall only removes the validated owned cache; foreign
 *      content under `.poiesis/cache/` (a directory the Poiesis runtime
 *      does not own) is preserved and reported via
 *      `foreignPreserved` so an operator can inspect it before deletion.
 *   4. `poiesis repository status` reports the mechanical state without
 *      downloading anything; the status command MUST NOT spawn a
 *      subprocess other than `uv --version` and MUST NOT touch the
 *      network.
 *   5. `uv` is a standard requirement. `init` fails closed with the
 *      typed `REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING` error before
 *      any canonical mutation when `uv` is unavailable; `doctor`
 *      reports the same condition as `fail` (not `warn`); `update`
 *      inherits the failure through the existing
 *      `UPDATE_DOCTOR_FAILED` transaction gate. No Author question is
 *      ever asked. Runtime repository operations may later return a
 *      typed fallback (already covered by the existing `Status.reason`
 *      surface) when a previously working dependency disappears.
 *
 * The module is intentionally minimal: query / path / explain runtime
 * paths belong to later tickets (#122, #123, #124). This ticket only
 * owns the cache boundary, the status surface, the `uv` requirement
 * gate, and the ownership / uninstall hooks that other tickets will
 * compose against.
 */

/**
 * Exact Graphify engine identity. Per Spec #120, Poiesis v1.2 pins a
 * specific Graphify version so `update` can move the pin by invalidating
 * the derived cache instead of inventing a graph migration subsystem.
 */
export const REPOSITORY_INTELLIGENCE_ENGINE = "graphify";

/**
 * Spec #120 / ticket #121 — exact Graphify version pin. Update will
 * invalidate the derived cache when this pin changes (later ticket).
 */
export const GRAPHIFY_VERSION = "0.9.70";

/**
 * Canonical `uvx --from` package identifier. This is the single
 * authority for which exact Graphify version Poiesis will run; do NOT
 * introduce a separate runtime-version seam that could drift.
 */
export const GRAPHIFY_PACKAGE = `graphifyy==${GRAPHIFY_VERSION}`;

/**
 * Required Python interpreter version for `uvx`. Mirrors the engine
 * pin so the runtime never depends on a system-wide Python.
 */
export const GRAPHIFY_PYTHON = "3.12";

/**
 * Schema version for the local `state.json` envelope. Bump only when
 * the envelope shape changes in an incompatible way.
 */
export const REPOSITORY_INTELLIGENCE_STATE_SCHEMA = 1;

/**
 * Local-state relative path for the Repository Intelligence cache. The
 * cache is ignored via the Poiesis-managed `.gitignore` block added by
 * `poiesis init`.
 */
export const REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY = ".poiesis/cache/";

/**
 * Local-state relative path for the `state.json` envelope. Lives under
 * the cache directory; never recorded in the durable manifest.
 */
export const REPOSITORY_INTELLIGENCE_STATE_RELATIVE_PATH =
  ".poiesis/cache/repository-intelligence/state.json";

/**
 * Local-state relative path for the Graphify working directory.
 */
export const REPOSITORY_INTELLIGENCE_GRAPHIFY_RELATIVE_PATH =
  ".poiesis/cache/repository-intelligence/graphify";

/**
 * Local-state relative path for the `graphify` data directory under
 * the cache. Mirrors the Spec #120 §11 environment variable
 * `GRAPHIFY_OUT=<workspace-root>/.poiesis/cache/repository-intelligence/graphify`.
 */
export const REPOSITORY_INTELLIGENCE_CACHE_RELATIVE_DIRECTORY =
  ".poiesis/cache/repository-intelligence/";

export interface RepositoryIntelligenceState {
  schema: 1;
  engine: "graphify";
  engineVersion: string;
  mode: "code-only";
}

export interface RepositoryIntelligenceStatus {
  /**
   * Whether the runtime is wired and ready to launch a `uvx`-pinned
   * Graphify command. `false` whenever `uv` is unavailable or the
   * pinned Graphify version is unknown to this runtime.
   */
  enabled: boolean;
  engine: "graphify";
  engineVersion: string;
  uvAvailable: boolean;
  /**
   * Whether a cache directory exists at all (`.poiesis/cache/`).
   */
  cachePresent: boolean;
  /**
   * Whether the existing cache is owned by Poiesis and the engine
   * stamp matches the currently pinned Graphify version. A cache that
   * is stale or unowned is still `cachePresent: true`; this flag
   * tells callers whether a query can run without first purging.
   */
  cacheValid: boolean;
  /**
   * Mechanical reason code. Stable, machine-readable, and
   * suitable for `doctor` / status UI rendering. One of:
   *   `uv-unavailable`  — uv is not on PATH;
   *   `cache-absent`    — uv is available but no cache exists yet;
   *   `engine-version-mismatch` — cache exists for a different Graphify pin;
   *   `cache-invalid`   — cache exists but is structurally unsafe;
   *   `ready`           — uv available and cache present + valid.
   */
  reason:
    | "uv-unavailable"
    | "cache-absent"
    | "engine-version-mismatch"
    | "cache-invalid"
    | "ready";
}

export interface RepositoryIntelligenceCacheValidation {
  root: string;
  /**
   * Absolute paths inside the cache that are owned by Poiesis. Owned
   * entries are inside the resolved repo root and are not symlinks.
   */
  owned: true;
  /**
   * Per-entry ownership records. Each entry is a regular file or
   * directory that lives strictly inside `root`.
   */
  entries: string[];
}

export interface RepositoryIntelligenceRemovalResult {
  /**
   * Whether the owned cache was removed. `false` means the cache was
   * already absent (no-op) or no validated owned cache existed.
   */
  removed: boolean;
  /**
   * Paths inside the cache that the validator rejected (symlinks or
   * paths that escape the cache root). The validator refused to delete
   * the cache while these were present, so they were preserved.
   */
  preserved: string[];
  /**
   * Top-level entries under `.poiesis/cache/` that are not owned by
   * the Poiesis runtime. These survive the uninstall because the
   * validator only removes the Poiesis-owned subdirectory.
   */
  foreignPreserved: string[];
}

/**
 * Resolve the absolute cache directory (`<root>/.poiesis/cache`) for
 * Repository Intelligence. The directory may not exist on disk; this
 * helper only normalizes the path.
 */
export function repositoryIntelligenceCachePath(root: string): string {
  return resolve(root, REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY);
}

/**
 * Resolve the absolute path of the `state.json` envelope.
 */
export function repositoryIntelligenceStatePath(root: string): string {
  return resolve(root, REPOSITORY_INTELLIGENCE_STATE_RELATIVE_PATH);
}

/**
 * Resolve the absolute path of the Graphify working directory inside
 * the cache (the directory pointed at by `GRAPHIFY_OUT`).
 */
export function repositoryIntelligenceGraphifyPath(root: string): string {
  return resolve(root, REPOSITORY_INTELLIGENCE_GRAPHIFY_RELATIVE_PATH);
}

/**
 * Bounded-path predicate: a string is "inside" the Poiesis cache
 * directory iff it is a safe relative path (no absolute, no `.` or
 * `..`, no NULs) and either equals the cache root `.poiesis/cache` or
 * starts with the cache-root prefix `.poiesis/cache/`. The harness may
 * pass this predicate any candidate path; rejected paths must NEVER be
 * normalized into the cache.
 */
export function isCachePathInside(_root: string, candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (isAbsolute(candidate)) return false;
  // Normalize a trailing slash so `.poiesis/cache/` and `.poiesis/cache`
  // both pass the equality check. The prefix form below uses the
  // constant WITHOUT the trailing slash so `.poiesis/cache-evil/` does
  // NOT match.
  const prefix = REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY.replace(/\/+$/, "");
  const normalized = candidate.replace(/\/+$/, "");
  const segments = normalized.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  if (normalized === prefix) return true;
  return normalized.startsWith(`${prefix}/`);
}

/**
 * Probe whether `uv` is available on the current `PATH`. This is the
 * single canonical `uv`-presence seam for Spec #120. The probe runs
 * `uv --version` with `allowFailure: true` so a missing `uv` returns a
 * typed `false` instead of throwing. The probe NEVER downloads
 * anything; an unavailable `uv` is reported, not silently installed.
 *
 * The probe accepts an explicit override for deterministic tests; the
 * default uses `process.env.PATH` exactly as `run()` does.
 */
export async function probeUvAvailability(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const result = await run("uv", ["--version"], { cwd: process.cwd(), env, allowFailure: true, timeoutMs: 5_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Assert that `uv` is available on PATH. This is the canonical
 * fail-closed seam `init` and the doctor surface call BEFORE any
 * canonical mutation; a missing `uv` throws the typed
 * `REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING` error so the operator
 * gets a single actionable requirement message ("install `uv`") rather
 * than a generic command-failure cascade later in the lifecycle.
 *
 * `uv` is a STANDARD Poiesis v1.2 requirement because the exact-pin
 * `uvx --python 3.12 --from graphifyy==<X> graphify ...` runner is the
 * only supported way to launch Graphify; there is no global Graphify
 * install path, no Python-vendoring path, and no documented fallback
 * for fresh installations. Author visibility is preserved: the
 * message names the missing dependency, the install entry point
 * (https://docs.astral.sh/uv/), and the Poiesis command that can be
 * retried once `uv` is installed. No Author question is asked; no
 * fallback flag is offered; the install either succeeds or refuses
 * before mutation.
 *
 * Runtime repository operations (later tickets #122, #123, #124) may
 * still return a typed `Status.reason: "uv-unavailable"` fallback when
 * a previously working dependency disappears — the requirement is on
 * fresh installation / update transactions, not on every transient
 * query call.
 */
export async function assertUvRequirement(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (await probeUvAvailability(env)) return;
  throw new PoiesisError(
    "REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING",
    "Poiesis v1.2 requires `uv` on PATH (it is the exact-version runtime that launches Graphify); install `uv` from https://docs.astral.sh/uv/ and re-run the same `poiesis` command",
    {
      requirement: "uv",
      python: GRAPHIFY_PYTHON,
      engine: REPOSITORY_INTELLIGENCE_ENGINE,
      engineVersion: GRAPHIFY_VERSION,
      hint: "missing-binary",
    },
  );
}

/**
 * Read and validate the local `state.json` envelope. Returns `undefined`
 * when the file is absent. Throws `REPOSITORY_INTELLIGENCE_STATE_INVALID`
 * when the file is present but malformed or carries an unsupported
 * schema / engine.
 */
export async function readRepositoryIntelligenceState(root: string): Promise<RepositoryIntelligenceState | undefined> {
  const statePath = repositoryIntelligenceStatePath(root);
  if (!(await exists(statePath))) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_STATE_INVALID",
      "Repository Intelligence state.json is not valid JSON",
      { path: relative(root, statePath), cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { schema?: unknown }).schema !== REPOSITORY_INTELLIGENCE_STATE_SCHEMA ||
    (raw as { engine?: unknown }).engine !== REPOSITORY_INTELLIGENCE_ENGINE ||
    typeof (raw as { engineVersion?: unknown }).engineVersion !== "string" ||
    (raw as { engineVersion: string }).engineVersion.length === 0 ||
    (raw as { mode?: unknown }).mode !== "code-only"
  ) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_STATE_INVALID",
      "Repository Intelligence state.json is malformed or carries an unsupported schema",
      { path: relative(root, statePath) },
    );
  }
  return raw as RepositoryIntelligenceState;
}

/**
 * Atomically write the local `state.json` envelope. Creates the
 * `repository-intelligence/` directory if it does not exist. The file
 * is written with restrictive permissions (0o600) so foreign users on
 * a shared host cannot read the local-cache stamp.
 */
export async function writeRepositoryIntelligenceState(
  root: string,
  state: RepositoryIntelligenceState,
): Promise<void> {
  const statePath = repositoryIntelligenceStatePath(root);
  await mkdir(join(statePath, ".."), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Resolve the runtime status without touching the network. `uv` is
 * probed once via `uv --version`; the cache directory is checked via
 * `lstat` (not `stat`) so a symlinked cache is reported as invalid
 * rather than silently followed.
 */
export async function repositoryIntelligenceStatus(root: string): Promise<RepositoryIntelligenceStatus> {
  const uvAvailable = await probeUvAvailability();
  const cache = repositoryIntelligenceCachePath(root);
  if (!(await exists(cache))) {
    return {
      enabled: uvAvailable,
      engine: "graphify",
      engineVersion: GRAPHIFY_VERSION,
      uvAvailable,
      cachePresent: false,
      cacheValid: false,
      reason: uvAvailable ? "cache-absent" : "uv-unavailable",
    };
  }
  let present = true;
  let valid = true;
  let reason: RepositoryIntelligenceStatus["reason"] = "ready";
  if (!uvAvailable) {
    valid = false;
    reason = "uv-unavailable";
  } else {
    try {
      const details = await lstat(cache);
      if (details.isSymbolicLink()) {
        valid = false;
        reason = "cache-invalid";
      } else {
        const state = await readRepositoryIntelligenceState(root);
        if (state === undefined) {
          valid = false;
          reason = "cache-invalid";
        } else if (state.engineVersion !== GRAPHIFY_VERSION) {
          valid = false;
          reason = "engine-version-mismatch";
        }
      }
    } catch {
      valid = false;
      reason = "cache-invalid";
    }
  }
  return {
    enabled: uvAvailable,
    engine: "graphify",
    engineVersion: GRAPHIFY_VERSION,
    uvAvailable,
    cachePresent: present,
    cacheValid: valid,
    reason,
  };
}

/**
 * Purge the entire `.poiesis/cache/` tree. Use only when the caller
 * has explicitly authorized a rebuild (e.g. an engine-version
 * mismatch); do not call this from read-only paths.
 *
 * Safety contract:
 *
 *   1. The cache root itself must NOT be a symbolic link (the
 *      validator refuses symlinked roots via `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE`).
 *   2. The validator walks the cache tree with `lstat` BEFORE the
 *      deletion: every visited directory and file must be a regular
 *      non-symlink entry. A symlinked subdirectory or a symlinked
 *      file inside the cache refuses the purge so the destructive
 *      path can never reach a symlink target. (Node's `rm({ recursive:
 *      true })` would unlink the symlink itself rather than follow it,
 *      but refusing up-front keeps the seam honest and matches the
 *      `validateRepositoryIntelligenceCache` contract exactly.)
 *   3. The purge is bounded to the resolved cache root; foreign
 *      siblings outside `.poiesis/cache/` are never enumerated, and
 *      no path outside the cache can be passed to this helper.
 */
export async function purgeRepositoryIntelligenceCache(root: string): Promise<void> {
  const cache = repositoryIntelligenceCachePath(root);
  if (!(await exists(cache))) return;
  // Validate the cache tree up front. The validator refuses any
  // symlinked entry with `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE`, so
  // a subsequent `rm({ recursive: true })` cannot delete a symlink
  // target by accident.
  await validateRepositoryIntelligenceCache(root, cache);
  await rm(cache, { recursive: true, force: true });
}

/**
 * Validate that the candidate cache directory is owned by Poiesis.
 *
 * Ownership rules:
 *   1. `candidate` must resolve to a path strictly inside the
 *      Poiesis cache directory (`.poiesis/cache/`) for the repo.
 *   2. The cache directory itself, and every directory under it that
 *      the runtime would walk during refresh, must NOT be a symbolic
 *      link. The runtime uses `lstat` so symlinks are reported
 *      rather than followed; an attacker cannot redirect the cache
 *      into `/etc` or another worktree by replacing a managed
 *      subdirectory with a symlink.
 *   3. The cache must not contain any entry whose name is `.` or `..`,
 *      and no entry whose absolute path escapes the cache root.
 *
 * Throws `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE` for any violation.
 * The validator returns the owned entry list so the caller can reuse
 * it without re-traversing the tree.
 */
export async function validateRepositoryIntelligenceCache(
  root: string,
  candidate: string,
): Promise<RepositoryIntelligenceCacheValidation> {
  const cache = repositoryIntelligenceCachePath(root);
  const resolvedCache = resolve(root, candidate);
  // The validator accepts either the relative cache-root form
  // (`.poiesis/cache`) or any path strictly under the cache. Paths
  // outside the cache or paths that escape the cache root are
  // refused with `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE` so an
  // attacker cannot trick the runtime into deleting content outside
  // the Poiesis-owned cache directory.
  const candidateRelative = relative(root, resolvedCache).replace(/\\/g, "/");
  if (!isCachePathInside(root, candidateRelative) || !candidateRelative.startsWith(".poiesis/cache")) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Refusing to operate on a cache path outside the Poiesis-owned cache directory",
      { candidate, expected: relative(root, cache) },
    );
  }
  if (!(await exists(resolvedCache))) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Cache directory does not exist",
      { path: relative(root, resolvedCache) },
    );
  }
  const details = await lstat(resolvedCache);
  if (details.isSymbolicLink()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Cache directory is a symbolic link",
      { path: relative(root, resolvedCache) },
    );
  }
  if (!details.isDirectory()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Cache path is not a directory",
      { path: relative(root, resolvedCache) },
    );
  }
  // Only validate the Poiesis-owned subdirectory
  // (`.poiesis/cache/repository-intelligence/`). Foreign sibling
  // entries under `.poiesis/cache/` are deliberately not walked by
  // the validator: the runtime only authors the owned subdirectory,
  // and `removeValidatedRepositoryIntelligenceCache` preserves any
  // sibling by construction. Walking siblings here would reject
  // legitimate foreign content (e.g. an operator's manual
  // `.poiesis/cache/staging/`).
  const ownedDir = join(resolvedCache, "repository-intelligence");
  const ownedEntries: string[] = [];
  if (await exists(ownedDir)) {
    await assertSafeCacheTree(root, ownedDir, ownedEntries);
  }
  return { root: resolvedCache, owned: true, entries: ownedEntries };
}

/**
 * Recursive walk that asserts no symlinked managed subdirectory or
 * escape exists under the cache root. Each visited regular directory
 * is appended to `owned`. Stops at the first violation.
 */
async function assertSafeCacheTree(repoRoot: string, directory: string, owned: string[]): Promise<void> {
  const details = await lstat(directory);
  if (details.isSymbolicLink()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Refusing to traverse a symlinked cache subdirectory",
      { path: relative(repoRoot, directory) },
    );
  }
  if (!details.isDirectory()) return;
  owned.push(relative(repoRoot, directory));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    const childLstat = await lstat(child);
    if (childLstat.isSymbolicLink()) {
      throw new PoiesisError(
        "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
        "Refusing to traverse a symlinked cache entry",
        { path: relative(repoRoot, child) },
      );
    }
    if (childLstat.isDirectory()) {
      await assertSafeCacheTree(repoRoot, child, owned);
    } else {
      owned.push(relative(repoRoot, child));
    }
  }
}

/**
 * Remove the Poiesis-owned Repository Intelligence cache for a clean
 * uninstall. The function:
 *
 *   1. Validates the cache with `validateRepositoryIntelligenceCache`;
 *      a symlinked cache or a cache containing a symlink-managed
 *      subdirectory rejects the call with
 *      `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE`.
 *   2. Identifies the top-level entries of `.poiesis/cache/`. The
 *      Poiesis-owned entry is the `repository-intelligence` directory;
 *      every other top-level entry is reported as `foreignPreserved`
 *      and left intact. The runtime only ever authors the
 *      `repository-intelligence/` subdirectory, so any sibling under
 *      `.poiesis/cache/` is foreign by construction.
 *   3. Removes ONLY the owned `repository-intelligence/` subdirectory.
 *      The parent `.poiesis/cache/` is preserved when foreign content
 *      exists; when the cache contains only Poiesis-owned entries, the
 *      entire cache directory is removed (cleanup of empty parent).
 *
 * The Poiesis runtime does NOT track ownership of foreign cache
 * content; refusing to delete it is the safer default and matches
 * the Spec #120 §35 fallback invariant ("deleting the cache must only
 * make the next query slower or force fallback").
 */
export async function removeValidatedRepositoryIntelligenceCache(
  root: string,
): Promise<RepositoryIntelligenceRemovalResult> {
  const cache = repositoryIntelligenceCachePath(root);
  if (!(await exists(cache))) {
    return { removed: false, preserved: [], foreignPreserved: [] };
  }
  const cacheDetails = await lstat(cache);
  if (cacheDetails.isSymbolicLink()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Refusing to remove a symlinked Poiesis cache",
      { path: relative(root, cache) },
    );
  }
  if (!cacheDetails.isDirectory()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNOWNED",
      "Refusing to remove a non-directory Poiesis cache path",
      { path: relative(root, cache) },
    );
  }
  const topLevel = await readdir(cache, { withFileTypes: true });
  const foreignPreserved: string[] = [];
  for (const entry of topLevel) {
    if (entry.name !== "repository-intelligence") {
      foreignPreserved.push(entry.name);
    }
  }
  const ownedDir = join(cache, "repository-intelligence");
  if (!(await exists(ownedDir))) {
    return { removed: false, preserved: [], foreignPreserved };
  }
  const validation = await validateRepositoryIntelligenceCache(root, cache);
  // Validate the owned subdirectory is itself a non-symlink directory
  // before recursive removal. The validator already walks every
  // subentry, but the removal uses `rm(..., { recursive: true })`
  // which would follow a symlinked root; refuse non-directory / symlink
  // entries at the top level to keep the seam identical to validate.
  const ownedDirDetails = await lstat(ownedDir);
  if (ownedDirDetails.isSymbolicLink() || !ownedDirDetails.isDirectory()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNOWNED",
      "Refusing to remove a non-owned Poiesis cache entry",
      { path: relative(root, ownedDir), ownedEntries: validation.entries },
    );
  }
  await rm(ownedDir, { recursive: true, force: true });
  // Only remove the cache root when no foreign content remains.
  // Use `rmdir` so we never delete a non-empty directory by mistake;
  // an empty cache directory is a safe cleanup target and the
  // Poiesis uninstall path itself walks `.poiesis/` via `rmdir` to
  // avoid touching foreign siblings.
  if (foreignPreserved.length === 0) {
    try {
      const remaining = await readdir(cache);
      if (remaining.length === 0) await rmdir(cache);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Best-effort parent cleanup; the owned removal already
      // succeeded. ENOENT means a concurrent uninstall removed the
      // cache between our `rm` and our `rmdir`, which is harmless.
      if (code !== "ENOENT") throw error;
    }
  }
  return { removed: true, preserved: [], foreignPreserved };
}

/**
 * Library seam: write the canonical owned `state.json` envelope for a
 * freshly built cache. The runtime refresh path uses this helper so the
 * stamp is identical to what `readRepositoryIntelligenceState` expects.
 */
export async function stampRepositoryIntelligenceCache(root: string): Promise<void> {
  await writeRepositoryIntelligenceState(root, {
    schema: REPOSITORY_INTELLIGENCE_STATE_SCHEMA,
    engine: "graphify",
    engineVersion: GRAPHIFY_VERSION,
    mode: "code-only",
  });
}

// Internal helper used by the doctor surface to surface the same
// mechanical "uv missing" message without leaking the cache-path
// resolution to maintenance. Exported as a single pure helper so the
// existing `doctor` flow can construct the typed check without a
// runtime dependency on `repository-intelligence.ts` for status reads.
export function describeRepositoryIntelligenceState(
  uvAvailable: boolean,
  state: RepositoryIntelligenceState | undefined,
): RepositoryIntelligenceStatus["reason"] {
  if (!uvAvailable) return "uv-unavailable";
  if (state === undefined) return "cache-absent";
  if (state.engineVersion !== GRAPHIFY_VERSION) return "engine-version-mismatch";
  return "ready";
}

// Convenience for tests and call sites that need the default cache
// root expressed as a gitignore-friendly relative directory. Exported
// so the init gitignore block can include it without hard-coding the
// string in a different module.
export const REPOSITORY_INTELLIGENCE_GITIGNORE_LINE = REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY;

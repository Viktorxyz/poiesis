import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
 * Local-state relative path for the `graphify` working directory.
 *
 * As of ticket #122 the cache uses an immutable generation directory
 * layout: each successful refresh produces a new
 * `<cache>/repository-intelligence/generations/<uuid>/` directory and
 * commits it via the `state.json` `activeGeneration` pointer. The
 * legacy single-graph path above is RETIRED — kept only as the
 * gitignore line so an install that already has the line in
 * `.gitignore` does not need to be re-initialized. New writes go
 * through the generation directory; old directories are GC'd after a
 * successful activation.
 */
export const REPOSITORY_INTELLIGENCE_GRAPHIFY_RELATIVE_PATH =
  ".poiesis/cache/repository-intelligence/graphify";

/**
 * Local-state relative path for the immutable generation directory.
 * Each successful refresh creates a fresh `<uuid>/` subdirectory
 * here, runs the extract / update into it, validates the resulting
 * graph.json, then commits the generation by atomically rewriting
 * `state.json` with the new `activeGeneration` field. The previous
 * active generation is preserved until best-effort GC after the
 * activation succeeds.
 */
export const REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY =
  ".poiesis/cache/repository-intelligence/generations";

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
  /**
   * Ticket #122 — additive optional fields. The strict reader
   * accepts missing values so legacy state.json (written before this
   * ticket) keeps working; the writer always stamps the current
   * fields so a fresh stamp carries both.
   *
   * `repoRoot` is the resolved git root the stamp was produced for.
   * The query path treats a missing / mismatched `repoRoot` as a
   * rebuild trigger so a state.json inherited from a different work
   * tree cannot survive into this repo.
   *
   * `activeGeneration` is the basename of the immutable generation
   * directory inside `.poiesis/cache/repository-intelligence/generations/`
   * that the runtime must query. A missing / empty value is treated
   * as a generation-pointer rebuild trigger; the next query creates a
   * new generation and commits it.
   */
  repoRoot?: string;
  activeGeneration?: string;
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
 * Resolve the absolute path of the legacy Graphify working directory
 * inside the cache. RETIRED as of ticket #122 — kept as a pure path
 * helper so the gitignore line + uninstall / purge code paths can
 * still resolve the historical location. New writes go through the
 * generation directory; the legacy path is no longer produced.
 */
export function repositoryIntelligenceGraphifyPath(root: string): string {
  return resolve(root, REPOSITORY_INTELLIGENCE_GRAPHIFY_RELATIVE_PATH);
}

/**
 * Resolve the absolute path of the immutable generation directory
 * `<root>/.poiesis/cache/repository-intelligence/generations`. The
 * directory may not exist on disk; this helper only normalizes the
 * path.
 */
export function repositoryIntelligenceGenerationsPath(root: string): string {
  return resolve(root, REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY);
}

/**
 * Resolve the absolute path of a specific generation directory inside
 * the generations root. `generationId` is the basename of the
 * directory (no path separators, no `.` or `..`); rejected ids throw
 * `REPOSITORY_INTELLIGENCE_GENERATION_INVALID` so the runtime cannot
 * be tricked into reading or removing an entry outside the
 * generations root.
 */
export function repositoryIntelligenceGenerationPath(root: string, generationId: string): string {
  if (typeof generationId !== "string" || generationId.length === 0) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GENERATION_INVALID",
      "Generation id must be a non-empty string",
      { generationId },
    );
  }
  if (generationId.includes("/") || generationId.includes("\\") || generationId.includes("\u0000")) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GENERATION_INVALID",
      "Generation id must not contain path separators or NUL bytes",
      { generationId },
    );
  }
  if (generationId === "." || generationId === "..") {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GENERATION_INVALID",
      "Generation id must not be `.` or `..`",
      { generationId },
    );
  }
  return join(repositoryIntelligenceGenerationsPath(root), generationId);
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
 *
 * Ticket #122: `repoRoot` and `activeGeneration` are accepted as
 * OPTIONAL fields. The strict reader ignores any unknown key, so a
 * legacy state.json (written before this ticket) keeps loading; the
 * query path treats missing / mismatched values as rebuild triggers
 * so a fresh stamp carries the new fields automatically.
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
  const candidate = raw as Record<string, unknown>;
  const repoRoot = typeof candidate.repoRoot === "string" ? candidate.repoRoot : undefined;
  const activeGeneration =
    typeof candidate.activeGeneration === "string" && candidate.activeGeneration.length > 0
      ? candidate.activeGeneration
      : undefined;
  return {
    schema: REPOSITORY_INTELLIGENCE_STATE_SCHEMA,
    engine: "graphify",
    engineVersion: (raw as { engineVersion: string }).engineVersion,
    mode: "code-only",
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(activeGeneration === undefined ? {} : { activeGeneration }),
  };
}

/**
 * Atomically write the local `state.json` envelope. Creates the
 * `repository-intelligence/` directory if it does not exist. The file
 * is written with restrictive permissions (0o600) so foreign users on
 * a shared host cannot read the local-cache stamp.
 *
 * The write is atomic: the file is staged as `state.json.tmp` and
 * renamed over the canonical path. `rename(2)` is atomic on the same
 * filesystem, so a concurrent reader either sees the old stamp or the
 * new stamp — never a half-written file. This is the only atomicity
 * guarantee the activation step needs: the active-generation pointer
 * flips in a single observable instant.
 */
export async function writeRepositoryIntelligenceState(
  root: string,
  state: RepositoryIntelligenceState,
): Promise<void> {
  const statePath = repositoryIntelligenceStatePath(root);
  await mkdir(join(statePath, ".."), { recursive: true });
  const stagingPath = `${statePath}.tmp`;
  await writeFile(stagingPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(stagingPath, statePath);
}

/**
 * Resolve the runtime status without touching the network. `uv` is
 * probed once via `uv --version`; the cache directory is checked via
 * `lstat` (not `stat`) so a symlinked cache is reported as invalid
 * rather than silently followed.
 *
 * Ticket #122: the status also verifies that the
 * `state.json.activeGeneration` pointer resolves to a directory
 * inside the generations root. A missing or symlinked generation
 * marks the cache as `engine-version-mismatch` so the next query
 * rebuilds without manual intervention.
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
        } else if (typeof state.activeGeneration !== "string" || state.activeGeneration.length === 0) {
          // Legacy state.json (or a state.json written by a future
          // Poiesis that did not stamp the generation pointer). The
          // next query rebuilds.
          valid = false;
          reason = "engine-version-mismatch";
        } else {
          const generationPath = repositoryIntelligenceGenerationPath(root, state.activeGeneration);
          if (!(await exists(generationPath))) {
            valid = false;
            reason = "engine-version-mismatch";
          } else {
            const genDetails = await lstat(generationPath);
            if (genDetails.isSymbolicLink() || !genDetails.isDirectory()) {
              valid = false;
              reason = "engine-version-mismatch";
            }
          }
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

/**
 * Spec #120 / ticket #122 — `poiesis repository query --question`.
 *
 * End-to-end runtime seam that wires a single invocation of Graphify
 * against the Poiesis-owned local cache. The contract is fixed:
 *
 *   1. Every invocation serializes refresh per repo (process-local lock
 *      + best-effort file lock inside the cache; no concurrent refresh
 *      for the same repo root).
 *   2. Refresh builds into an IMMUTABLE generation directory
 *      `.poiesis/cache/repository-intelligence/generations/<uuid>/`.
 *      The previous active generation is left in place; the runtime
 *      never mutates a generation after it has been committed.
 *   3. The staged generation's `graph.json` (and every other graphify
 *      output) is validated (parseable JSON, contains `nodes` and
 *      `edges`, not empty) before activation.
 *   4. Activation is an atomic rewrite of `state.json` (temp file +
 *      rename). The new state carries the new `activeGeneration`
 *      pointer; the runtime never `rm`s the previous active generation
 *      before commit, so a crash mid-activation leaves the previous
 *      generation queryable.
 *   5. Initial / engine-version / mode / root-mismatch refreshes run
 *      a true full `graphify extract <root> --code-only --no-cluster`
 *      into an EMPTY generation (no seeding of prior output).
 *   6. Incremental refreshes clone the COMPLETE validated active
 *      generation (every graphify output, not just graph.json) into
 *      a new generation, then run `graphify update <root>` (no
 *      `--force`, no `--no-viz` since it is not a valid `update` flag)
 *      so graphify merges new code into the seeded baseline.
 *   7. Only after activation does the runner execute `graphify query
 *      <question> --budget <N> --graph <active-graph>` against the
 *      generation selected by the NEWLY committed state.
 *   8. A failed refresh NEVER queries the old active graph. The
 *      fallback envelope surfaces `reason` and `detail` so the CLI
 *      can render a typed message without throwing.
 *   9. The refresh runner runs with a 10-minute timeout, byte-bounded
 *      stdout/stderr capture, and exactly ONE attempt (no retries, no
 *      `--force`).
 *  10. The runner env is sanitized: every known model-provider
 *      credential prefix and every generic *_API_KEY / *_TOKEN /
 *      *_SECRET / *_PASSWORD / *_CREDENTIALS suffix is stripped, plus
 *      tracker credentials (GH_*, GITHUB_*, GITLAB_*, GL_*) and the
 *      POIESIS_* namespace (to prevent nested recursion).
 *  11. Operational failures (uv-unavailable, refresh-failed,
 *      refresh-timeout, graph-invalid, graph-empty, query-failed,
 *      query-timeout) return a typed non-blocking fallback envelope.
 *      Unsafe paths (symlinked cache, missing cache directory,
 *      traversal, invalid generation id) and invalid args (empty /
 *      oversized / NUL-bearing question) hard-fail with a typed
 *      `PoiesisError` because the caller asked for something that
 *      cannot be served.
 *  12. Garbage collection of stale generations runs best-effort AFTER
 *      a successful activation. A GC failure must never invalidate
 *      the just-committed state; the next successful activation will
 *      retry.
 *
 * Spec #120 / ticket #123 extends the same contract to
 * `poiesis repository path --from --to` and
 * `poiesis repository explain --node`. The three operations share the
 * exact same refresh / lock / validation / activation pipeline; only
 * the post-refresh graphify invocation, the input validators, the
 * output envelope, and the operation label differ. Poiesis named flags
 * (`--from`, `--to`, `--node`) translate to Graphify positional args
 * plus the explicit `--graph <active>` pointer so the runtime owns
 * every CLI argv shape.
 */

/**
 * Fixed 10-minute refresh budget. Per Spec #120 / ticket #122 the
 * runtime owns the timeout — callers cannot extend or shorten it
 * because doing so would let one query monopolize the box or hide a
 * runaway extract.
 */
export const REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS = 10 * 60_000;

/**
 * Fixed query budget (in Graphify tokens) for `graphify query`. The
 * pin matches Graphify 0.9.70's documented default (2000) and is
 * encoded explicitly so the runtime cannot drift to a different
 * answer-shape per query. The value is passed via `--budget
 * REPOSITORY_INTELLIGENCE_QUERY_BUDGET_TOKENS` on every query
 * invocation.
 */
export const REPOSITORY_INTELLIGENCE_QUERY_BUDGET_TOKENS = 2000;

/**
 * Bounded query timeout for the `graphify query` invocation. The
 * refresh budget is 10 minutes; the query budget is short because the
 * active graph is already loaded and the BFS-over-graph.json call is
 * bounded by `--budget` and the graph size.
 */
export const REPOSITORY_INTELLIGENCE_QUERY_TIMEOUT_MS = 30_000;

/**
 * Bounded input length for `--question`. Graphify parses the question
 * into a single string and forwards it to its BFS traversal; a 4 KiB
 * cap is generous for natural-language prompts and refuses buffer
 * abuse.
 */
export const REPOSITORY_INTELLIGENCE_QUESTION_MAX_LENGTH = 4096;

/**
 * Spec #120 / ticket #123 — bounded input length for `path --from`,
 * `path --to`, and `explain --node`. Graphify resolves each identifier
 * against the active graph's nodes; a 512-byte cap is generous for a
 * fully-qualified symbol path and refuses buffer abuse.
 */
export const REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH = 512;

/**
 * Spec #120 / ticket #123 — bounded timeout (ms) for the
 * `graphify path` / `graphify explain` post-refresh invocation.
 * Identical to the query timeout because all three BFS-over-graph
 * calls share the same bounded-by-`--budget` / graph-size shape.
 */
export const REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS = 30_000;

/**
 * Sanitization allow-list: environment variables that Poiesis is
 * willing to forward to the `uvx graphify` child process. Every other
 * variable is dropped so a poisoned parent shell cannot leak model
 * credentials, tracker tokens, or nested Poiesis recursion state into
 * the subprocess.
 */
const SANITIZED_ENV_ALLOWLIST = new Set([
  "PATH",
  "Path", // Windows spelling
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "XDG_CACHE_HOME",
  "SHELL",
]);

/**
 * Hard-deny prefixes: every env var whose name starts with one of
 * these is dropped regardless of allow-list membership. Covers every
 * documented model-provider credential, the tracker credentials that
 * should never reach an extraction process, and the POIESIS namespace
 * so a runtime recursion (e.g. `POIESIS_DEBUG=1`) cannot leak into the
 * child.
 */
const SANITIZED_ENV_DENY_PREFIXES = [
  "OPENAI_",
  "ANTHROPIC_",
  "AZURE_",
  "GOOGLE_",
  "GEMINI_",
  "COHERE_",
  "MISTRAL_",
  "GROQ_",
  "REPLICATE_",
  "HUGGINGFACE_",
  "HF_",
  "AWS_",
  "GH_",
  "GITHUB_",
  "GITLAB_",
  "GL_",
  "POIESIS_",
];

/**
 * Hard-deny suffixes: generic credential patterns. The model-provider
 * prefixes above cover the documented names; these catch custom
 * vendor prefixes that follow the conventional naming.
 */
const SANITIZED_ENV_DENY_SUFFIXES = [
  "_API_KEY",
  "_APIKEY",
  "_API_TOKEN",
  "_TOKEN",
  "_SECRET",
  "_SECRET_KEY",
  "_PASSWORD",
  "_PASSWD",
  "_CREDENTIALS",
  "_CREDENTIAL",
  "_PRIVATE_KEY",
  "_ACCESS_KEY",
];

/**
 * Produce a sanitized replacement environment for `uvx graphify`. The
 * returned object is a fresh copy: mutating it never mutates the
 * input, and the input is never mutated. The runtime owns this seam so
 * the credential-stripping rules cannot drift between call sites.
 */
export function sanitizeGraphifyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (SANITIZED_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (SANITIZED_ENV_DENY_SUFFIXES.some((suffix) => key.endsWith(suffix))) continue;
    if (!SANITIZED_ENV_ALLOWLIST.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Subprocess runner seam. The default implementation runs
 * `uvx --python <pin> --from <pkg> graphify <args>` through
 * `process.run`; tests inject a fake to drive deterministic outcomes
 * without spawning a real `uvx` child.
 */
export interface GraphifyRunnerRequest {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes?: number;
}

export interface GraphifyRunnerSuccess {
  ok: true;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  /**
   * Test-only hook. The default runner ignores this field; fake
   * runners use it to write a canned `graph.json` to `GRAPHIFY_OUT`
   * inside the runner's env so the runtime's validation path can
   * exercise both success and failure shapes. Production callers MUST
   * leave this undefined.
   */
  post?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

export interface GraphifyRunnerError {
  ok: false;
  code:
    | "GRAPHIFY_NOT_INSTALLED"
    | "GRAPHIFY_TIMEOUT"
    | "GRAPHIFY_IO_ERROR"
    | "GRAPHIFY_FAILED"
    | "GRAPHIFY_INVALID_INVOCATION";
  message: string;
  detail: Record<string, unknown>;
}

export type GraphifyRunnerResult = GraphifyRunnerSuccess | GraphifyRunnerError;

export type GraphifyRunner = (request: GraphifyRunnerRequest) => Promise<GraphifyRunnerResult>;

/**
 * Build the exact `uvx` argv for a Graphify invocation. The launcher
 * shape is fixed by Spec #120: `uvx --python <pin> --from
 * graphifyy==<pin> graphify <subcommand-and-flags>`. Centralizing it
 * here means the only place the launcher argv can drift is this
 * function, and the test suite can assert against the literal argv.
 */
export function buildGraphifyInvocation(args: string[]): { command: string; args: string[] } {
  return {
    command: "uvx",
    args: ["--python", GRAPHIFY_PYTHON, "--from", GRAPHIFY_PACKAGE, "graphify", ...args],
  };
}

/**
 * Default `uvx graphify` runner. The runner takes the sanitized env,
 * the bounded timeout, and the byte cap, and translates `process.run`
 * failures into the typed `GraphifyRunnerError` envelope the runtime
 * expects.
 */
export const defaultGraphifyRunner: GraphifyRunner = async (request) => {
  const { command, args } = buildGraphifyInvocation(request.args);
  try {
    const result = await run(command, args, {
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
      allowFailure: true,
    });
    if (result.timedOut) {
      return {
        ok: false,
        code: "GRAPHIFY_TIMEOUT",
        message: `${command} exceeded ${request.timeoutMs}ms timeout`,
        detail: {
          args: request.args,
          timeoutMs: request.timeoutMs,
          durationMs: result.durationMs,
          stderr: result.stderr.slice(0, 8_000),
        },
      };
    }
    if (result.exitCode === 0) {
      return {
        ok: true,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        durationMs: result.durationMs,
      };
    }
    return {
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: `${command} exited with code ${result.exitCode}`,
      detail: {
        args: request.args,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stderr: result.stderr.slice(0, 8_000),
      },
    };
  } catch (error) {
    // `process.run` only throws on infrastructure / spawn failures
    // (e.g. `uvx` not on PATH). Translate to the typed envelope so
    // the runtime can surface `uv-unavailable` without inspecting
    // Node errors.
    const err = error as NodeJS.ErrnoException;
    return {
      ok: false,
      code: err.code === "ENOENT" ? "GRAPHIFY_NOT_INSTALLED" : "GRAPHIFY_IO_ERROR",
      message: err.message || `${command} failed to start`,
      detail: { args: request.args, code: err.code ?? "UNKNOWN" },
    };
  }
};

export type RepositoryIntelligenceRefreshKind =
  | "none"
  | "initial-extract"
  | "incremental-update"
  | "engine-version-mismatch"
  | "mode-mismatch"
  | "root-mismatch";

export interface RepositoryIntelligenceRefresh {
  action: "rebuilt";
  kind: RepositoryIntelligenceRefreshKind;
  durationMs: number;
}

export interface RepositoryIntelligenceQuerySuccess {
  ok: true;
  operation: "repository.query";
  engine: "graphify";
  engineVersion: string;
  graphPath: string;
  refresh: RepositoryIntelligenceRefresh;
  answer: string;
  truncated: boolean;
}

export type RepositoryIntelligenceQueryReason =
  | "uv-unavailable"
  | "refresh-failed"
  | "refresh-timeout"
  | "graph-invalid"
  | "graph-empty"
  | "query-failed"
  | "query-timeout";

export interface RepositoryIntelligenceQueryFallback {
  ok: false;
  operation: "repository.query";
  engine: "graphify";
  engineVersion: string;
  reason: RepositoryIntelligenceQueryReason;
  message: string;
  detail: Record<string, unknown>;
}

export type RepositoryIntelligenceQueryOutcome =
  | RepositoryIntelligenceQuerySuccess
  | RepositoryIntelligenceQueryFallback;

export interface RepositoryIntelligenceQueryOptions {
  question: string;
  /**
   * Override the subprocess runner. Default: `defaultGraphifyRunner`,
   * which spawns the real `uvx` against the pinned Graphify package.
   * Production callers (the CLI dispatcher) leave this undefined; the
   * test seam injects a deterministic fake.
   */
  runner?: GraphifyRunner;
  /**
   * Process env to derive the sanitized env from. Default:
   * `process.env`. Exposed for deterministic tests; production callers
   * leave this undefined.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Refresh timeout override. The runtime always clamps to
   * `REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS`; the override exists
   * so the test seam can prove the clamp behavior without depending
   * on the constant's value.
   */
  refreshTimeoutMs?: number;
}

/**
 * Spec #120 / ticket #123 — `poiesis repository path --from <node>
 * --to <node>`.
 *
 * The Poiesis CLI accepts named flags (`--from`, `--to`) for ergonomic
 * shell parsing; the runtime translates them to Graphify's positional
 * `<from> <to>` invocation plus the explicit `--graph <active>` pointer.
 * The post-refresh invocation runs `graphify path <from> <to> --graph
 * <active>` so the BFS-over-graph traversal operates against the
 * committed generation — never a stale or in-progress directory.
 */
export interface RepositoryIntelligencePathSuccess {
  ok: true;
  operation: "repository.path";
  engine: "graphify";
  engineVersion: string;
  graphPath: string;
  from: string;
  to: string;
  refresh: RepositoryIntelligenceRefresh;
  answer: string;
  truncated: boolean;
}

export type RepositoryIntelligencePathReason =
  | "uv-unavailable"
  | "refresh-failed"
  | "refresh-timeout"
  | "graph-invalid"
  | "graph-empty"
  | "path-failed"
  | "path-timeout";

export interface RepositoryIntelligencePathFallback {
  ok: false;
  operation: "repository.path";
  engine: "graphify";
  engineVersion: string;
  reason: RepositoryIntelligencePathReason;
  message: string;
  detail: Record<string, unknown>;
}

export type RepositoryIntelligencePathOutcome =
  | RepositoryIntelligencePathSuccess
  | RepositoryIntelligencePathFallback;

export interface RepositoryIntelligencePathOptions {
  from: string;
  to: string;
  /**
   * Override the subprocess runner. Same contract as the query
   * option; production callers leave this undefined.
   */
  runner?: GraphifyRunner;
  /**
   * Process env to derive the sanitized env from. Same contract as
   * the query option; production callers leave this undefined.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spec #120 / ticket #123 — `poiesis repository explain --node <node>`.
 *
 * The Poiesis CLI accepts the named `--node` flag; the runtime
 * translates it to Graphify's positional invocation
 * `graphify explain <node> --graph <active>` so the BFS traversal
 * operates against the committed generation.
 */
export interface RepositoryIntelligenceExplainSuccess {
  ok: true;
  operation: "repository.explain";
  engine: "graphify";
  engineVersion: string;
  graphPath: string;
  node: string;
  refresh: RepositoryIntelligenceRefresh;
  answer: string;
  truncated: boolean;
}

export type RepositoryIntelligenceExplainReason =
  | "uv-unavailable"
  | "refresh-failed"
  | "refresh-timeout"
  | "graph-invalid"
  | "graph-empty"
  | "explain-failed"
  | "explain-timeout";

export interface RepositoryIntelligenceExplainFallback {
  ok: false;
  operation: "repository.explain";
  engine: "graphify";
  engineVersion: string;
  reason: RepositoryIntelligenceExplainReason;
  message: string;
  detail: Record<string, unknown>;
}

export type RepositoryIntelligenceExplainOutcome =
  | RepositoryIntelligenceExplainSuccess
  | RepositoryIntelligenceExplainFallback;

export interface RepositoryIntelligenceExplainOptions {
  node: string;
  /**
   * Override the subprocess runner. Same contract as the query
   * option; production callers leave this undefined.
   */
  runner?: GraphifyRunner;
  /**
   * Process env to derive the sanitized env from. Same contract as
   * the query option; production callers leave this undefined.
   */
  env?: NodeJS.ProcessEnv;
}

interface RefreshDecision {
  action: "rebuilt";
  kind: RepositoryIntelligenceRefreshKind;
  /**
   * Identifier of the prior active generation, used as the source
   * for incremental cloning. Empty string when the kind requires
   * a full extract (no prior generation is trusted).
   */
  priorGenerationId: string;
}

const LOCK_FILENAME = ".refresh.lock";
const LOCK_GUARD_FILENAME = ".refresh.lock.guard";
const GENERATION_PREFIX = "generation-";
const QUESTION_MAX_LENGTH = REPOSITORY_INTELLIGENCE_QUESTION_MAX_LENGTH;
const REFRESH_MAX_BYTES = 32 * 1024 * 1024;
const QUERY_MAX_BYTES = 4 * 1024 * 1024;

// Per-iteration guard wait when polling for an externally-held guard.
// Each iteration of the outer acquire / release loop sleeps this long
// when the guard exists; the loop itself is bounded by the caller's
// `timeoutMs` so a stuck guard cannot hang the caller forever.
const REFRESH_GUARD_POLL_INTERVAL_MS = 50;

// Bounded wait when a release closure tries to reacquire the guard.
// Release holds the guard only for the re-read / exact-token-match /
// unlink critical section, so a stuck guard here almost always means
// a crashed holder and the runtime refuses to auto-clear it (the
// operator must intervene manually per Spec #120 / ticket #127).
const REFRESH_RELEASE_GUARD_TIMEOUT_MS = 5_000;

/**
 * Spec #120 / ticket #127 — refresh lock envelope.
 *
 * The canonical lock file is a JSON object stamped with:
 *
 *   - `version`: a literal `1` so future tickets can evolve the shape;
 *     a malformed or unknown envelope is collapsed to `null` by
 *     `readCanonicalLockSnapshot` and is NEVER reclaimed by the
 *     runtime — the acquire path fails closed with
 *     `REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT` and recovery is
 *     the operator's responsibility;
 *   - `token`: a random UUID v4 unique to this acquisition. The token
 *     is the identity-safe ownership proof; every check below
 *     compares against `token`, never against the PID, so PID
 *     recycling cannot inherit another process's lock;
 *   - `pid`: the process that wrote the lock. PID liveness is a
 *     stale hint, never the identity check;
 *   - `acquiredAt`: millisecond wall-clock at write time, kept for
 *     operator forensics only.
 *
 * Every mutation of the canonical lock — acquisition, stale
 * reclamation, and release — is performed UNDER a sibling guard file
 * (`.refresh.lock.guard`). The guard serializes all canonical-lock
 * mutation: every contender for the canonical `writeFile(path, ...,
 * { flag: "wx" })` slot first acquires the guard with `wx`, performs
 * its read-decide-write critical section while holding the guard, and
 * releases the guard in a `finally`. The guard is short-lived
 * (microseconds to a few milliseconds); a stuck guard means a crashed
 * holder and the runtime fails closed with a bounded wait, leaving
 * recovery to the operator.
 */
const REFRESH_LOCK_CONTENT_VERSION = 1;

interface RefreshLockContent {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: number;
}

/**
 * Spec #120 / ticket #127 — refresh lock guard envelope.
 *
 * The guard's JSON shape mirrors the lock envelope; the runtime never
 * parses it, but the file's existence at the canonical guard path is
 * the only serialization signal that matters. A unique UUID token is
 * stamped so two holders can never confuse their critical sections.
 */
interface RefreshGuardContent {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: number;
}

function lockPath(root: string): string {
  return resolve(root, ".poiesis/cache/repository-intelligence", LOCK_FILENAME);
}

function lockGuardPath(root: string): string {
  return resolve(root, ".poiesis/cache/repository-intelligence", LOCK_GUARD_FILENAME);
}

/**
 * Build the typed non-blocking fallback envelope. Centralized so the
 * `operation` / `engine` / `engineVersion` fields stay identical to
 * the success envelope and the CLI can render both through the same
 * writer.
 */
function toQueryFallback(
  reason: RepositoryIntelligenceQueryReason,
  message: string,
  detail: Record<string, unknown>,
): RepositoryIntelligenceQueryFallback {
  return {
    ok: false,
    operation: "repository.query",
    engine: "graphify",
    engineVersion: GRAPHIFY_VERSION,
    reason,
    message,
    detail,
  };
}

function refreshTimeoutMs(options: RepositoryIntelligenceQueryOptions): number {
  // Caller cannot extend or shorten the budget; clamp to the constant
  // so a future ticket cannot accidentally widen this seam.
  return REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS;
}

/**
 * Spec #120 / ticket #127 — refresh lock identity-safe protocol.
 *
 * The previous implementation used unconditional `unlink(path)` after
 * a PID-liveness check, which left two windows where a contender
 * could erase a live lock it did not own:
 *
 *   1. Two stale reclaimers could each read the same stale file,
 *      decide "stale", and each call `unlink(path)`. The first unlink
 *      removes the stale file; the second unlink then removes the
 *      freshly-acquired live lock the first contender had just
 *      written — opening a window where no lock guards the canonical
 *      path.
 *
 *   2. The release closure called `unlink(path)` without an identity
 *      check. A delayed "old release" (queued before the holder's PID
 *      died or before the lock was replaced by a legitimate stale
 *      reclaimer) could remove the replacement lock and leave the
 *      canonical path empty.
 *
 * The first review pass attempted a `rename(path, sidecar)` capture
 * with a `rename(sidecar, path)` restore on token mismatch. That
 * protocol was withdrawn because the conditional restore could
 * overwrite a legitimate foreign lock installed between the capture
 * and the restore — displacement is equivalent to removal.
 *
 * The current fix is identity-safe end-to-end, built on a fixed
 * `.refresh.lock.guard` file acquired atomically with `writeFile(path,
 * payload, { flag: "wx", mode: 0o600 })`. POSIX `wx` is atomic on the
 * same filesystem: exactly ONE contender's `wx` succeeds; everyone
 * else observes `EEXIST` and waits. The guard is short-lived
 * (microseconds to a few milliseconds). Every canonical-lock mutation
 * — acquire, stale reclaim, release — runs UNDER the guard:
 *
 *   - Acquire (canonical absent): under the guard, `wx` a fresh UUID
 *     token at the canonical path. On success the caller owns the
 *     lock. On the rare `EEXIST` (pre-guard contender slipped in) the
 *     caller retries the loop.
 *
 *   - Acquire (canonical present, snapshot stale): under the guard,
 *     re-read canonical; if the second read confirms the EXACT
 *     observed token + PID, `unlink(canonical)` then `wx` with our
 *     fresh UUID token. If the second read sees a DIFFERENT token
 *     (state changed under us, defensive against external observers),
 *     refuse to mutate and let the outer loop retry. The unlink is
 *     exact-observation-only — we never unlink a token we did not
 *     observe.
 *
 *   - Acquire (canonical present, snapshot live): leave alone. The
 *     outer loop sleeps briefly and retries until the bounded wait
 *     expires.
 *
 *   - Acquire (canonical present, malformed envelope): fail closed.
 *     `readCanonicalLockSnapshot` collapses a malformed blob (bad
 *     JSON or an envelope with the wrong shape) to `null` rather than
 *     throwing, so the caller cannot distinguish "absent" from
 *     "malformed" by the snapshot alone. Under the guard the function
 *     attempts `wx` against the canonical path; the malformed blob is
 *     still on disk, so `wx` returns `EEXIST` and
 *     `tryAcquireUnderGuard` returns `false`. The outer loop retries
 *     the same shape forever until the bounded wait expires and the
 *     runtime surfaces `REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT`.
 *     The malformed blob is NEVER unlinked by this protocol —
 *     clearing it is the operator's responsibility (the runtime
 *     refuses to guess which unknown bytes are stale vs. a foreign
 *     lock it does not own).
 *
 *   - Release: under the guard, re-read canonical. If the observed
 *     token matches our identity, `unlink(canonical)`. If the token
 *     does NOT match (canonical was replaced by a foreign lock) the
 *     release is a strict no-op: the foreign lock is preserved
 *     verbatim at the canonical path, and the release NEVER
 *     overwrites a foreign lock.
 *
 *   - The lock file carries a unique UUID ownership token stamped by
 *     the writer. Every atomic check above compares against `token`,
 *     never against the PID; PID recycling cannot inherit another
 *     process's lock.
 *
 *   - Acquisition is bounded by
 *     `REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS` so a wedged
 *     neighbor cannot hang the caller indefinitely; on timeout the
 *     runtime surfaces the typed
 *     `REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT` error. A stuck
 *     guard is the same boundary: the acquire loop polls the guard
 *     with `REFRESH_GUARD_POLL_INTERVAL_MS` per iteration and the
 *     release path uses the bounded `REFRESH_RELEASE_GUARD_TIMEOUT_MS`
 *     wait. The runtime NEVER auto-reclaims a stuck guard — recovery
 *     is the operator's responsibility.
 *
 *   - There is NO `rename(2)` capture / sidecar / restore path in
 *     this protocol. Every canonical-lock mutation under the guard is
 *     a direct read-decide-write against the canonical path with
 *     `wx`, so the only files that ever appear under the cache's
 *     refresh-lock directory are `.refresh.lock` (the canonical
 *     envelope) and `.refresh.lock.guard` (the short-lived guard).
 *
 * Bounded residual failure modes actually observed by this protocol:
 *
 *   - Lost `unlink`: if the exact-observed-token `unlink` itself
 *     fails (e.g. concurrent external observer between the snapshot
 *     read and the unlink), the `.catch(() => undefined)` absorbs
 *     the error and the subsequent `wx` either succeeds (the path
 *     is now free) or returns `false` on `EEXIST` (a contender
 *     already wrote under us) and the outer loop retries against the
 *     new state.
 *
 *   - Stale-reclaimer race under guard: the second-read verify in
 *     `tryAcquireUnderGuard` only unlinks when `verify.token ===
 *     snapshot.token` AND `verify.pid === snapshot.pid`. If the
 *     canonical state changed between the two reads, the function
 *     returns `false` and the outer loop retries — no foreign lock
 *     is ever displaced by a stale reclaimer.
 *
 *   - Release against foreign lock: `releaseUnderGuard` re-reads
 *     canonical and unlinks only when `snapshot.token === lockToken`.
 *     A token mismatch is a strict no-op; a foreign lock is preserved
 *     verbatim at the canonical path with no overwrite and no
 *     captured-sidecar artifact.
 *
 *   - Stuck guard (acquire): every waiter observes `EEXIST`, sleeps
 *     `REFRESH_GUARD_POLL_INTERVAL_MS`, and ultimately fails closed
 *     with `REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT`. The
 *     stuck guard file is left on disk for the operator to clear.
 *
 *   - Stuck guard (release): `releaseRefreshLockAtomic` returns
 *     without mutating canonical if the guard cannot be acquired
 *     within `REFRESH_RELEASE_GUARD_TIMEOUT_MS`. A stuck release
 *     guard leaves the canonical file alone — the next acquire
 *     cycle either reclaims (if the holder PID is now dead) or
 *     fails closed with the same typed error. No automatic
 *     recursive reclamation.
 */
function formatRefreshLockContent(token: string): string {
  const content: RefreshLockContent = {
    version: REFRESH_LOCK_CONTENT_VERSION,
    token,
    pid: process.pid,
    acquiredAt: Date.now(),
  };
  return JSON.stringify(content);
}

function formatRefreshGuardContent(token: string): string {
  const content: RefreshGuardContent = {
    version: REFRESH_LOCK_CONTENT_VERSION,
    token,
    pid: process.pid,
    acquiredAt: Date.now(),
  };
  return JSON.stringify(content);
}

function parseRefreshLockContent(raw: string): RefreshLockContent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RefreshLockContent>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== REFRESH_LOCK_CONTENT_VERSION ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.acquiredAt !== "number"
    ) {
      return null;
    }
    return parsed as RefreshLockContent;
  } catch {
    /* fall through */
  }
  return null;
}

async function readCanonicalLockSnapshot(canonicalPath: string): Promise<RefreshLockContent | null> {
  try {
    const raw = await readFile(canonicalPath, "utf8");
    return parseRefreshLockContent(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // Foreign / unexpected format: surface the error so the caller
    // does not silently retry against a poisoned cache. The runtime
    // refuses to overwrite an unknown file at the canonical path.
    throw error;
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `process.kill(pid, 0)` resolves false only when the OS reports
    // "no such process" (ESRCH). Any other error (EPERM, etc.) means
    // the process exists but we cannot signal it; treat as alive so
    // we never delete a lock that another process may legitimately
    // own.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Acquire the canonical-lock guard file with a bounded wait. The
 * guard is acquired via `writeFile(guardPath, myPayload, { flag:
 * "wx" })`; only ONE contender's `wx` succeeds. The function returns
 * `true` on acquired / `false` on bounded timeout. The runtime never
 * auto-reclaims the guard — a stuck guard means a crashed holder and
 * recovery is the operator's responsibility per Spec #120 / ticket
 * #127.
 */
async function acquireRefreshGuard(
  root: string,
  myToken: string,
  timeoutMs: number,
): Promise<boolean> {
  const path = lockGuardPath(root);
  await mkdir(resolve(path, ".."), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const payload = formatRefreshGuardContent(myToken);
  while (true) {
    try {
      await writeFile(path, payload, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolveSleep) =>
        setTimeout(resolveSleep, REFRESH_GUARD_POLL_INTERVAL_MS),
      );
    }
  }
}

async function releaseRefreshGuard(root: string): Promise<void> {
  await unlink(lockGuardPath(root)).catch(() => undefined);
}

/**
 * Acquire the canonical refresh lock while the guard is held.
 * Returns `true` when the caller now owns the canonical lock,
 * `false` when the canonical is held by a foreign live process and
 * the caller must wait.
 *
 * Critical section contract:
 *
 *   - Canonical absent → `wx` with our token. On success, the
 *     caller now owns the canonical lock. On `EEXIST` (extremely
 *     rare; would mean a pre-guard contender wrote under us) the
 *     caller retries.
 *
 *   - Canonical present, exact observed stale token → unlink the
 *     exact observed stale token, then `wx` with our token. On
 *     `EEXIST` (pre-guard contender wrote under us) the caller
 *     retries.
 *
 *   - Canonical present, second read sees a DIFFERENT token →
 *     defensive retry; we never unlink the wrong token.
 *
 *   - Canonical present, live PID → leave alone. Caller retries
 *     after a bounded sleep.
 *
 *   - Canonical present, malformed envelope → fail closed.
 *     `readCanonicalLockSnapshot` collapses a malformed blob (bad
 *     JSON or an envelope with the wrong shape) to `null`, so the
 *     caller cannot distinguish "absent" from "malformed" by the
 *     snapshot alone. The function attempts `wx` against the
 *     canonical path; the malformed blob is still on disk, so `wx`
 *     returns `EEXIST` and the function returns `false`. The
 *     malformed blob is NEVER unlinked — clearing it is the
 *     operator's responsibility.
 */
async function tryAcquireUnderGuard(
  root: string,
  canonicalPath: string,
  lockToken: string,
): Promise<boolean> {
  const snapshot = await readCanonicalLockSnapshot(canonicalPath);
  if (snapshot === null) {
    try {
      await writeFile(canonicalPath, formatRefreshLockContent(lockToken), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
  // Canonical exists. Decide under the guard.
  const alive = await isPidAlive(snapshot.pid);
  if (alive) {
    // Live foreign lock. Do NOT mutate it.
    return false;
  }
  // Stale according to the snapshot. Re-verify under the guard so we
  // never unlink the wrong token if the canonical changed between
  // the first read and this one (defensive against external
  // observers; while we hold the guard the only writer is us).
  const verify = await readCanonicalLockSnapshot(canonicalPath);
  if (
    verify === null ||
    verify.token !== snapshot.token ||
    verify.pid !== snapshot.pid
  ) {
    // State changed; refuse to mutate. Caller retries after a bounded
    // sleep.
    return false;
  }
  // Exact observed stale token. Unlink it.
  await unlink(canonicalPath).catch(() => undefined);
  try {
    await writeFile(canonicalPath, formatRefreshLockContent(lockToken), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Release the canonical refresh lock while the guard is held. The
 * release re-reads canonical under the guard and unlinks ONLY when
 * the observed token matches the releaser's identity. If the canonical
 * is a foreign lock (token mismatch) the release is a strict no-op:
 * the foreign lock is preserved at the canonical path. The release
 * never overwrites a foreign lock.
 */
async function releaseUnderGuard(
  root: string,
  canonicalPath: string,
  lockToken: string,
): Promise<void> {
  const snapshot = await readCanonicalLockSnapshot(canonicalPath);
  if (snapshot === null) {
    // Canonical already empty. Nothing to do.
    return;
  }
  if (snapshot.token !== lockToken) {
    // Foreign lock. Leave it alone — never unlink a foreign token,
    // never overwrite.
    return;
  }
  // Our exact token. Safe to unlink.
  await unlink(canonicalPath).catch(() => undefined);
}

/**
 * Release the canonical lock under the guard. The release closure
 * returned by `acquireRefreshLockWithTimeout` calls this on
 * invocation. The function:
 *
 *   1. Acquires the guard with a bounded wait
 *      (`REFRESH_RELEASE_GUARD_TIMEOUT_MS`).
 *
 *   2. Under the guard, runs `releaseUnderGuard` (re-reads
 *      canonical; only unlinks when the observed token matches the
 *      releaser's identity).
 *
 *   3. Releases the guard in `finally`.
 *
 * If the guard cannot be acquired within the bounded release wait,
 * the function returns without mutating the canonical file. The
 * rationale: a stuck guard here almost always means a crashed
 * holder, and Spec #120 / ticket #127 forbids automatic recursive
 * reclamation. The next acquirer will observe the lock and either
 * reclaim (if the holder's PID is now dead) or wait (if the
 * holder is alive). The operator can manually clear the derived
 * cache if a recovery is needed.
 */
async function releaseRefreshLockAtomic(
  root: string,
  canonicalPath: string,
  lockToken: string,
): Promise<void> {
  const guardToken = randomUUID();
  const gotGuard = await acquireRefreshGuard(
    root,
    guardToken,
    REFRESH_RELEASE_GUARD_TIMEOUT_MS,
  );
  if (!gotGuard) {
    // Stuck guard — refuse to mutate. Per Spec #120 / ticket #127
    // the runtime never auto-reclaims the guard. The next acquire
    // cycle will either succeed (operator cleared the guard) or
    // fail closed with the same typed error.
    return;
  }
  try {
    await releaseUnderGuard(root, canonicalPath, lockToken);
  } finally {
    await releaseRefreshGuard(root);
  }
}

/**
 * Acquire the per-repo refresh lock with a bounded wait. The wait
 * is capped at `timeoutMs` so a wedged guard cannot hang the caller
 * indefinitely. On timeout, the helper throws the typed
 * `REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT` error.
 *
 * The acquisition path is:
 *
 *   1. Loop until deadline. Per iteration:
 *
 *      a. Acquire the guard with a bounded per-iteration wait
 *         (`REFRESH_GUARD_POLL_INTERVAL_MS` or the remaining budget,
 *         whichever is smaller). If the guard cannot be acquired,
 *         sleep briefly and retry.
 *
 *      b. Under the guard, run the read-decide-write critical
 *         section via `tryAcquireUnderGuard`. The critical section
 *         never overwrites: it only `wx`-s a new unique token after
 *         verifying the canonical is absent OR an exact observed
 *         stale token. The guard is released in `finally`.
 *
 *      c. If the critical section succeeded, return the release
 *         closure. If it observed a live foreign lock, sleep briefly
 *          and retry.
 *
 *   2. The release closure runs `releaseRefreshLockAtomic` under the
 *      guard and only unlinks when the canonical token matches the
 *      releaser's identity; a foreign lock is preserved verbatim.
 *
 * The export of this helper is intentional: ticket #127's
 * deterministic concurrency tests bound the wait at short values
 * (e.g. 300 ms) so the test can observe the contention without
 * waiting for the production 10-minute budget. Production callers go
 * through `acquireRefreshLock`, which forwards the production
 * constant.
 */
export async function acquireRefreshLockWithTimeout(
  root: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const canonicalPath = lockPath(root);
  await mkdir(resolve(canonicalPath, ".."), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const lockToken = randomUUID();

  while (true) {
    if (Date.now() >= deadline) {
      throw new PoiesisError(
        "REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT",
        "Refresh lock could not be acquired within the bounded wait",
        { path: relative(root, canonicalPath), timeoutMs },
      );
    }
    const remainingMs = deadline - Date.now();
    const guardDeadline = Math.min(REFRESH_GUARD_POLL_INTERVAL_MS, remainingMs);
    const guardToken = randomUUID();
    const gotGuard = await acquireRefreshGuard(root, guardToken, guardDeadline);
    if (!gotGuard) {
      // Guard not acquired in this iteration. Sleep briefly and
      // retry until the outer deadline.
      const sleepMs = Math.min(REFRESH_GUARD_POLL_INTERVAL_MS, remainingMs);
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, sleepMs));
      continue;
    }
    try {
      const acquired = await tryAcquireUnderGuard(root, canonicalPath, lockToken);
      if (acquired) {
        return async () => {
          await releaseRefreshLockAtomic(root, canonicalPath, lockToken);
        };
      }
    } finally {
      await releaseRefreshGuard(root);
    }
    // Critical section observed a live foreign lock or a state
    // change. Sleep briefly and retry until the outer deadline.
    const remainingMs2 = deadline - Date.now();
    const sleepMs2 = Math.min(REFRESH_GUARD_POLL_INTERVAL_MS, remainingMs2);
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, sleepMs2));
  }
}

/**
 * Acquire the per-repo refresh lock using the production timeout
 * (`REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS`). See
 * `acquireRefreshLockWithTimeout` for the full protocol description.
 */
export async function acquireRefreshLock(root: string): Promise<() => Promise<void>> {
  return acquireRefreshLockWithTimeout(root, REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS);
}

/**
 * Read `state.json` without enforcing the strict `mode === "code-only"`
 * invariant. Used by `decideRefresh` to classify WHICH invariant
 * forced a rebuild so the operator sees a precise kind label instead
 * of a generic "engine-version-mismatch". The strict reader remains
 * the authority for the doctor / status surface.
 */
async function readRelaxedRepositoryIntelligenceState(
  root: string,
): Promise<(RepositoryIntelligenceState & { repoRoot?: string }) | undefined> {
  const statePath = repositoryIntelligenceStatePath(root);
  if (!(await exists(statePath))) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Partial<RepositoryIntelligenceState> & { repoRoot?: unknown };
  if (
    candidate.schema !== REPOSITORY_INTELLIGENCE_STATE_SCHEMA ||
    candidate.engine !== REPOSITORY_INTELLIGENCE_ENGINE ||
    typeof candidate.engineVersion !== "string" ||
    candidate.engineVersion.length === 0
  ) {
    return undefined;
  }
  return candidate as RepositoryIntelligenceState & { repoRoot?: string };
}

/**
 * Decide what kind of refresh the runtime must perform. Per
 * Spec #120 / ticket #122 every query serializes a refresh — there is
 * no "reuse" path that skips the Graphify invocation. The decision
 * picks between:
 *
 *   - `initial-extract`: no state.json (or no trusted state.json).
 *     The runtime runs `graphify extract <root> --code-only
 *     --no-cluster --out <new>` into an empty generation.
 *
 *   - `engine-version-mismatch` / `mode-mismatch` / `root-mismatch`:
 *     a prior state.json exists but violates one of the invariants.
 *     The runtime does NOT trust the prior generation's contents
 *     (it could be poisoned or from a different repo), so it runs a
 *     true full extract into an empty generation just like the
 *     initial case. The `kind` label carries the specific mismatch
 *     for operator visibility.
 *
 *   - `incremental-update`: the prior state.json is fully valid
 *     AND `activeGeneration` resolves to a real, non-symlink
 *     directory with a parseable `graph.json`. The runtime clones
 *     the COMPLETE prior generation into a new generation (every
 *     graphify output, not just `graph.json`) and then runs
 *     `graphify update <root> --out <new>` so Graphify merges
 *     freshly-extracted code into the cloned baseline.
 *
 * The decision NEVER returns `action: "reused"`. Every invocation
 * must hit the Graphify runner at least once.
 */
async function decideRefresh(root: string): Promise<RefreshDecision> {
  const state = await readRelaxedRepositoryIntelligenceState(root);
  if (state === undefined) {
    return { action: "rebuilt", kind: "initial-extract", priorGenerationId: "" };
  }
  if (state.engineVersion !== GRAPHIFY_VERSION) {
    return { action: "rebuilt", kind: "engine-version-mismatch", priorGenerationId: "" };
  }
  if (state.mode !== "code-only") {
    return { action: "rebuilt", kind: "mode-mismatch", priorGenerationId: "" };
  }
  if (typeof state.repoRoot !== "string" || state.repoRoot !== root) {
    return { action: "rebuilt", kind: "root-mismatch", priorGenerationId: "" };
  }
  if (typeof state.activeGeneration !== "string" || state.activeGeneration.length === 0) {
    return { action: "rebuilt", kind: "root-mismatch", priorGenerationId: "" };
  }
  let generationPath: string;
  try {
    generationPath = repositoryIntelligenceGenerationPath(root, state.activeGeneration);
  } catch {
    return { action: "rebuilt", kind: "root-mismatch", priorGenerationId: "" };
  }
  if (!(await exists(generationPath))) {
    return { action: "rebuilt", kind: "root-mismatch", priorGenerationId: "" };
  }
  const genDetails = await lstat(generationPath);
  if (genDetails.isSymbolicLink() || !genDetails.isDirectory()) {
    return { action: "rebuilt", kind: "root-mismatch", priorGenerationId: "" };
  }
  const graphJson = join(generationPath, "graph.json");
  if (!(await exists(graphJson))) {
    return { action: "rebuilt", kind: "root-mismatch", priorGenerationId: "" };
  }
  const graphDetails = await lstat(graphJson);
  if (graphDetails.isSymbolicLink() || !graphDetails.isFile()) {
    return { action: "rebuilt", kind: "root-mismatch", priorGenerationId: "" };
  }
  return { action: "rebuilt", kind: "incremental-update", priorGenerationId: state.activeGeneration };
}

/**
 * Validate a `graph.json` produced by Graphify's `update --no-cluster`
 * extraction. The shape we accept is intentionally narrow: a JSON
 * object with `nodes` and `edges` arrays. The runtime does NOT parse
 * every graph.json field because the Graphify schema can grow new
 * optional metadata between minor versions; we only assert the two
 * fields the BFS query needs.
 */
async function readAndValidateStagedGraph(stagedGraphJson: string): Promise<void> {
  if (!(await exists(stagedGraphJson))) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GRAPH_INVALID",
      "Staged graph.json was not produced by the Graphify refresh",
      { path: stagedGraphJson },
    );
  }
  const details = await lstat(stagedGraphJson);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GRAPH_INVALID",
      "Staged graph.json is not a regular file",
      { path: stagedGraphJson },
    );
  }
  let parsed: unknown;
  try {
    const raw = await readFile(stagedGraphJson, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GRAPH_INVALID",
      "Staged graph.json is not parseable JSON",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { nodes?: unknown }).nodes) ||
    !Array.isArray((parsed as { edges?: unknown }).edges)
  ) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GRAPH_INVALID",
      "Staged graph.json is missing nodes/edges arrays",
      {},
    );
  }
  const nodes = (parsed as { nodes: unknown[] }).nodes;
  const edges = (parsed as { edges: unknown[] }).edges;
  if (nodes.length === 0 && edges.length === 0) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_GRAPH_EMPTY",
      "Staged graph.json contains no nodes and no edges",
      { nodes: 0, edges: 0 },
    );
  }
}

/**
 * Build a fresh stamped state envelope that captures the resolved
 * repo root AND the freshly committed generation id. The stamp is
 * written AFTER the generation directory is built and validated;
 * `writeRepositoryIntelligenceState` itself does the atomic
 * temp-file-then-rename dance so a crash mid-write leaves the
 * previous stamp in place.
 */
async function stampRepositoryIntelligenceCacheForRoot(
  root: string,
  generationId: string,
): Promise<void> {
  await writeRepositoryIntelligenceState(root, {
    schema: REPOSITORY_INTELLIGENCE_STATE_SCHEMA,
    engine: "graphify",
    engineVersion: GRAPHIFY_VERSION,
    mode: "code-only",
    repoRoot: root,
    activeGeneration: generationId,
  });
}

/**
 * Best-effort garbage collection of stale generation directories
 * inside the generations root. A failure is intentionally swallowed:
 * the GC is opportunistic, and the next successful activation will
 * retry. The runtime MUST NOT refuse to commit a new generation
 * because the GC of a previous one failed.
 *
 * `keepGenerationId` is preserved verbatim; every other generation
 * directory under the generations root is removed.
 */
async function garbageCollectGenerations(
  root: string,
  keepGenerationId: string,
): Promise<void> {
  const generationsRoot = repositoryIntelligenceGenerationsPath(root);
  if (!(await exists(generationsRoot))) return;
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === keepGenerationId) continue;
    const entryPath = join(generationsRoot, entry.name);
    try {
      const details = await lstat(entryPath);
      if (details.isSymbolicLink()) continue;
      await rm(entryPath, { recursive: true, force: true });
    } catch {
      // Best-effort: keep going even if one entry refuses to delete.
    }
  }
}

/**
 * Recursively copy the contents of `src` into `dst`. Both must be
 * directories. Symlinks are NOT followed: the source path is read
 * with `lstat` and the destination is created with the same
 * regular-file / directory shape so a poisoned source cannot inject
 * a symlink into the staging tree.
 */
async function copyDirectoryContents(src: string, dst: string): Promise<void> {
  const details = await lstat(src);
  if (details.isSymbolicLink()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Refusing to clone a symlinked source directory",
      { path: src },
    );
  }
  if (!details.isDirectory()) {
    throw new PoiesisError(
      "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      "Refusing to clone a non-directory source",
      { path: src },
    );
  }
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const srcChild = join(src, entry.name);
    const dstChild = join(dst, entry.name);
    const childLstat = await lstat(srcChild);
    if (childLstat.isSymbolicLink()) {
      throw new PoiesisError(
        "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
        "Refusing to clone a symlinked source entry",
        { path: srcChild },
      );
    }
    if (childLstat.isDirectory()) {
      await copyDirectoryContents(srcChild, dstChild);
    } else if (childLstat.isFile()) {
      await mkdir(join(dstChild, ".."), { recursive: true });
      const raw = await readFile(srcChild);
      await writeFile(dstChild, raw);
    }
  }
}

/**
 * Validate the `--question` argument. Empty, whitespace-only, NUL-bearing,
 * and over-length prompts are hard-fail typed errors because the caller
 * asked for something the runtime cannot serve. Operational failures
 * (uvx crashes, timeouts) come later as soft fallbacks.
 */
function validateQuestion(question: string): void {
  if (typeof question !== "string") {
    throw new PoiesisError("MISSING_ARGUMENT", "Missing required --question", { key: "question" });
  }
  if (question.trim().length === 0) {
    throw new PoiesisError("MISSING_ARGUMENT", "Missing required --question", { key: "question" });
  }
  if (question.length > QUESTION_MAX_LENGTH) {
    throw new PoiesisError(
      "INVALID_ARGUMENT",
      `--question exceeds ${QUESTION_MAX_LENGTH} bytes`,
      { length: question.length, maxLength: QUESTION_MAX_LENGTH },
    );
  }
  if (question.includes("\u0000")) {
    throw new PoiesisError("INVALID_ARGUMENT", "--question contains a NUL byte", {});
  }
}

/**
 * Spec #120 / ticket #123 — validate a graphify identifier argument
 * (`--from`, `--to`, `--node`). Mirrors `validateQuestion`'s contract:
 * empty / whitespace-only / NUL-bearing / over-length identifiers are
 * hard-fail typed errors because the caller asked for something the
 * runtime cannot serve. The runtime accepts a non-empty trimmed
 * identifier of any byte content (Graphify's identifier parser is the
 * authority on what constitutes a valid node); this validator only
 * enforces Poiesis-side bounds.
 */
function validateNodeIdentifier(value: string, key: "from" | "to" | "node"): void {
  if (typeof value !== "string") {
    throw new PoiesisError("MISSING_ARGUMENT", `Missing required --${key}`, { key });
  }
  if (value.trim().length === 0) {
    throw new PoiesisError("MISSING_ARGUMENT", `Missing required --${key}`, { key });
  }
  if (value.length > REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH) {
    throw new PoiesisError(
      "INVALID_ARGUMENT",
      `--${key} exceeds ${REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH} bytes`,
      { key, length: value.length, maxLength: REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH },
    );
  }
  if (value.includes("\u0000")) {
    throw new PoiesisError("INVALID_ARGUMENT", `--${key} contains a NUL byte`, { key });
  }
}

/**
 * Spec #120 / tickets #121 / #122 / #123 — common refresh setup for
 * the three `poiesis repository <query|path|explain>` runtime entry
 * points. Performs, in order:
 *
 *   1. Symlink-safe ownership validation of the existing cache
 *      directory (hard-fails with `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE`
 *      on a poisoned cache; the entry points surface this as a typed
 *      `PoiesisError`).
 *   2. `uv` availability probe. A missing `uv` returns a typed
 *      `uv-unavailable` setup error so the entry point can translate
 *      it to its operation-specific fallback envelope without
 *      spawning a subprocess.
 *   3. Sanitization of the runner environment (model / tracker /
 *      POIESIS credentials stripped).
 *   4. Per-repo refresh lock acquisition so two concurrent invocations
 *      on the same repo never race the immutable-generation commit.
 *
 * Returns the ready-to-use runtime context on success, or a typed
 * `uv-unavailable` setup error on uv-missing. The `release` callback
 * MUST be awaited in the caller's `finally` to keep the lock lifetime
 * bounded by the operation's actual duration.
 */
interface RepositoryIntelligenceRefreshContext {
  ok: true;
  release: () => Promise<void>;
  runner: GraphifyRunner;
  sanitizedEnv: NodeJS.ProcessEnv;
}

interface RepositoryIntelligenceRefreshContextError {
  ok: false;
  reason: "uv-unavailable";
  message: string;
  detail: Record<string, unknown>;
}

async function prepareRefreshContext(
  root: string,
  env: NodeJS.ProcessEnv | undefined,
  runner: GraphifyRunner | undefined,
): Promise<RepositoryIntelligenceRefreshContext | RepositoryIntelligenceRefreshContextError> {
  // Defensive cache safety: refuse to run when the cache directory
  // is a symlink or escapes the cache root. `validateRepositoryIntelligenceCache`
  // is the canonical ownership check; the runtime runs it BEFORE any
  // subprocess to fail closed.
  const cacheRoot = repositoryIntelligenceCachePath(root);
  if (await exists(cacheRoot)) {
    await validateRepositoryIntelligenceCache(root, cacheRoot);
  }
  if (!(await probeUvAvailability(env))) {
    return {
      ok: false,
      reason: "uv-unavailable",
      message:
        "Poiesis v1.2 requires `uv` on PATH to launch the pinned Graphify engine; install `uv` from https://docs.astral.sh/uv/",
      detail: { requirement: "uv", hint: "missing-binary" },
    };
  }
  const resolvedRunner = runner ?? defaultGraphifyRunner;
  const envSource = env ?? process.env;
  const sanitizedEnv = sanitizeGraphifyEnvironment(envSource);
  const release = await acquireRefreshLock(root);
  return { ok: true, release, runner: resolvedRunner, sanitizedEnv };
}

/**
 * Top-level query entry point. The function NEVER throws on operational
 * failures (uvx missing, refresh crash, query crash, timeout,
 * graph-invalid, graph-empty) — those return a typed fallback envelope.
 * Hard failures are limited to argument-validation errors and unsafe
 * cache paths.
 */
export async function queryRepositoryIntelligence(
  root: string,
  options: RepositoryIntelligenceQueryOptions,
): Promise<RepositoryIntelligenceQueryOutcome> {
  validateQuestion(options.question);
  const ctx = await prepareRefreshContext(root, options.env, options.runner);
  if (!ctx.ok) {
    return toQueryFallback(ctx.reason, ctx.message, ctx.detail);
  }
  try {
    // Decide the refresh kind. Every query serializes a refresh
    // (per Spec #120 / ticket #122); there is no "reuse" path that
    // skips Graphify.
    const decision = await decideRefresh(root);
    const refreshResult = await performRefresh(root, decision, ctx.runner, ctx.sanitizedEnv);
    if (!refreshResult.ok) {
      return toQueryFallback(refreshResult.reason, refreshResult.message, refreshResult.detail);
    }
    const queryResult = await performQuery(root, refreshResult.graphPath, options.question, ctx.runner, ctx.sanitizedEnv);
    if (!queryResult.ok) {
      return toQueryFallback(queryResult.reason, queryResult.message, queryResult.detail);
    }
    return {
      ok: true,
      operation: "repository.query",
      engine: "graphify",
      engineVersion: GRAPHIFY_VERSION,
      graphPath: refreshResult.graphPath,
      refresh: { action: "rebuilt", kind: refreshResult.kind, durationMs: refreshResult.durationMs },
      answer: queryResult.answer,
      truncated: queryResult.truncated,
    };
  } catch (error) {
    if (error instanceof PoiesisError && error.code === "REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT") {
      return toQueryFallback("refresh-failed", error.message, error.details);
    }
    throw error;
  } finally {
    await ctx.release();
  }
}

/**
 * Spec #120 / ticket #123 — top-level `poiesis repository path
 * --from <node> --to <node>` entry point. Mirrors the query entry
 * point's refresh + lock + cache-validation pipeline; the only
 * differences are:
 *
 *   - `--from` / `--to` are validated by `validateNodeIdentifier`
 *     against `REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH` bytes;
 *   - the post-refresh graphify invocation runs `graphify path
 *     <from> <to> --graph <active>` (Graphify's positional API);
 *   - the success / fallback envelopes carry `from` / `to` /
 *     `path-failed` / `path-timeout` labels instead of the query
 *     labels so the CLI can render the right typed message.
 *
 * Operational failures (uvx missing, refresh crash, path crash,
 * timeout, graph-invalid, graph-empty) return the typed
 * `path-failed` / `path-timeout` fallback envelope; the function
 * NEVER throws on operational failures. Hard failures are limited
 * to argument-validation errors and unsafe cache paths.
 */
export async function pathRepositoryIntelligence(
  root: string,
  options: RepositoryIntelligencePathOptions,
): Promise<RepositoryIntelligencePathOutcome> {
  validateNodeIdentifier(options.from, "from");
  validateNodeIdentifier(options.to, "to");
  const ctx = await prepareRefreshContext(root, options.env, options.runner);
  if (!ctx.ok) {
    return toPathFallback(ctx.reason, ctx.message, ctx.detail);
  }
  try {
    const decision = await decideRefresh(root);
    const refreshResult = await performRefresh(root, decision, ctx.runner, ctx.sanitizedEnv);
    if (!refreshResult.ok) {
      return toPathFallback(refreshResult.reason, refreshResult.message, refreshResult.detail);
    }
    const pathResult = await performPath(root, refreshResult.graphPath, options.from, options.to, ctx.runner, ctx.sanitizedEnv);
    if (!pathResult.ok) {
      return toPathFallback(pathResult.reason, pathResult.message, pathResult.detail);
    }
    return {
      ok: true,
      operation: "repository.path",
      engine: "graphify",
      engineVersion: GRAPHIFY_VERSION,
      graphPath: refreshResult.graphPath,
      from: options.from,
      to: options.to,
      refresh: { action: "rebuilt", kind: refreshResult.kind, durationMs: refreshResult.durationMs },
      answer: pathResult.answer,
      truncated: pathResult.truncated,
    };
  } catch (error) {
    if (error instanceof PoiesisError && error.code === "REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT") {
      return toPathFallback("refresh-failed", error.message, error.details);
    }
    throw error;
  } finally {
    await ctx.release();
  }
}

/**
 * Spec #120 / ticket #123 — top-level `poiesis repository explain
 * --node <node>` entry point. Mirrors the query entry point's
 * refresh + lock + cache-validation pipeline; the only differences
 * are:
 *
 *   - `--node` is validated by `validateNodeIdentifier` against
 *     `REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH` bytes;
 *   - the post-refresh graphify invocation runs `graphify explain
 *     <node> --graph <active>` (Graphify's positional API);
 *   - the success / fallback envelopes carry `node` /
 *     `explain-failed` / `explain-timeout` labels instead of the
 *     query labels so the CLI can render the right typed message.
 *
 * Operational failures (uvx missing, refresh crash, explain crash,
 * timeout, graph-invalid, graph-empty) return the typed
 * `explain-failed` / `explain-timeout` fallback envelope; the
 * function NEVER throws on operational failures. Hard failures are
 * limited to argument-validation errors and unsafe cache paths.
 */
export async function explainRepositoryIntelligence(
  root: string,
  options: RepositoryIntelligenceExplainOptions,
): Promise<RepositoryIntelligenceExplainOutcome> {
  validateNodeIdentifier(options.node, "node");
  const ctx = await prepareRefreshContext(root, options.env, options.runner);
  if (!ctx.ok) {
    return toExplainFallback(ctx.reason, ctx.message, ctx.detail);
  }
  try {
    const decision = await decideRefresh(root);
    const refreshResult = await performRefresh(root, decision, ctx.runner, ctx.sanitizedEnv);
    if (!refreshResult.ok) {
      return toExplainFallback(refreshResult.reason, refreshResult.message, refreshResult.detail);
    }
    const explainResult = await performExplain(root, refreshResult.graphPath, options.node, ctx.runner, ctx.sanitizedEnv);
    if (!explainResult.ok) {
      return toExplainFallback(explainResult.reason, explainResult.message, explainResult.detail);
    }
    return {
      ok: true,
      operation: "repository.explain",
      engine: "graphify",
      engineVersion: GRAPHIFY_VERSION,
      graphPath: refreshResult.graphPath,
      node: options.node,
      refresh: { action: "rebuilt", kind: refreshResult.kind, durationMs: refreshResult.durationMs },
      answer: explainResult.answer,
      truncated: explainResult.truncated,
    };
  } catch (error) {
    if (error instanceof PoiesisError && error.code === "REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT") {
      return toExplainFallback("refresh-failed", error.message, error.details);
    }
    throw error;
  } finally {
    await ctx.release();
  }
}

/**
 * Spec #120 / ticket #123 — centralize the typed non-blocking
 * fallback envelope for `repository.path`. Mirrors `toQueryFallback`'s
 * shape so the CLI dispatcher can render both envelopes through the
 * same writer.
 */
function toPathFallback(
  reason: RepositoryIntelligencePathReason,
  message: string,
  detail: Record<string, unknown>,
): RepositoryIntelligencePathFallback {
  return {
    ok: false,
    operation: "repository.path",
    engine: "graphify",
    engineVersion: GRAPHIFY_VERSION,
    reason,
    message,
    detail,
  };
}

/**
 * Spec #120 / ticket #123 — centralize the typed non-blocking
 * fallback envelope for `repository.explain`. Mirrors
 * `toQueryFallback`'s shape so the CLI dispatcher can render both
 * envelopes through the same writer.
 */
function toExplainFallback(
  reason: RepositoryIntelligenceExplainReason,
  message: string,
  detail: Record<string, unknown>,
): RepositoryIntelligenceExplainFallback {
  return {
    ok: false,
    operation: "repository.explain",
    engine: "graphify",
    engineVersion: GRAPHIFY_VERSION,
    reason,
    message,
    detail,
  };
}

interface RefreshSuccess {
  ok: true;
  graphPath: string;
  kind: RepositoryIntelligenceRefreshKind;
  durationMs: number;
}

interface RefreshFailure {
  ok: false;
  reason: "refresh-failed" | "refresh-timeout" | "graph-invalid" | "graph-empty";
  message: string;
  detail: Record<string, unknown>;
}

type RefreshResult = RefreshSuccess | RefreshFailure;

/**
 * Perform an immutable-generation refresh:
 *
 *   1. Allocate a fresh `<cache>/repository-intelligence/generations/<uuid>/`
 *      directory. This directory is the immutable generation the
 *      runtime will commit once the build + validate sequence
 *      succeeds.
 *   2. If the refresh kind is `incremental-update`, copy the COMPLETE
 *      active generation's contents into the new generation so
 *      `graphify update <root>` merges into a baseline. Initial
 *      extract and every mismatch kind run with an empty generation
 *      so the build is a true full extract.
 *   3. Run `graphify extract <root> --code-only --no-cluster --out
 *      <generation>` for initial / mismatch, or `graphify update
 *      <root> --out <generation>` for incremental. The `--out` flag
 *      tells Graphify where to write its output; the runtime does
 *      NOT pass `--force` (no override of stale graphs by force) and
 *      does NOT pass `--no-viz` to `update` (it is not a valid
 *      `update` flag in 0.9.70).
 *   4. Validate the generation's `graph.json` (parseable JSON,
 *      `nodes` and `edges` arrays, not both empty). On validation
 *      failure, remove the in-progress generation directory and
 *      return a typed fallback. The previous active generation (if
 *      any) is untouched.
 *   5. Atomically commit the new generation by rewriting
 *      `state.json` (temp + rename) with the new `activeGeneration`
 *      pointer. A failure here leaves the previous stamp + previous
 *      active generation in place; the in-progress generation is left
 *      on disk and will be GC'd by the next successful activation.
 *   6. Best-effort GC of every other generation directory under
 *      the generations root. GC failures are swallowed; they do not
 *      invalidate the just-committed state.
 *
 * The query step then reads `state.json` and queries the generation
 * selected by the NEWLY committed state pointer; a failed activation
 * never reaches the query step (the orchestrator returns a typed
 * fallback envelope).
 */
async function performRefresh(
  root: string,
  decision: RefreshDecision,
  runner: GraphifyRunner,
  sanitizedEnv: NodeJS.ProcessEnv,
): Promise<RefreshResult> {
  const startedAt = Date.now();
  const generationsRoot = repositoryIntelligenceGenerationsPath(root);
  await mkdir(generationsRoot, { recursive: true });
  const generationId = `${GENERATION_PREFIX}${randomUUID()}`;
  const generationPath = join(generationsRoot, generationId);
  await mkdir(generationPath, { recursive: true });

  // For incremental refresh, clone the COMPLETE validated active
  // generation contents into the new generation so `graphify update`
  // merges into a baseline. Copying only `graph.json` is insufficient
  // — the seed must include every graphify output that the new
  // generation should preserve (graph.html, .graphify_analysis.json,
  // .graphify_labels.json, …) so update reads the same baseline it
  // would have read if the previous generation was the working
  // directory.
  if (decision.kind === "incremental-update" && decision.priorGenerationId !== "") {
    const activeGenerationPath = repositoryIntelligenceGenerationPath(root, decision.priorGenerationId);
    try {
      await copyDirectoryContents(activeGenerationPath, generationPath);
    } catch (error) {
      await rm(generationPath, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: "refresh-failed",
        message: "Failed to clone the active generation contents into the new generation",
        detail: { cause: message, from: relative(root, activeGenerationPath) },
      };
    }
  }

  // Build argv. `--out <generationPath>` keeps the output inside the
  // owned generations root; `--code-only` and `--no-cluster` ensure
  // the extract stays code-only and never invokes an LLM. We pass
  // `--out` explicitly so the argv alone documents the contract.
  // `GRAPHIFY_OUT` is also set in the env so any tool that reads it
  // (and the test seam, which inspects `env.GRAPHIFY_OUT` to write
  // canned output) agrees with the `--out` flag.
  const refreshArgs: string[] =
    decision.kind === "incremental-update"
      ? ["update", root, "--out", generationPath]
      : ["extract", root, "--code-only", "--no-cluster", "--out", generationPath];

  const refreshResult = await runner({
    args: refreshArgs,
    cwd: root,
    env: { ...sanitizedEnv, GRAPHIFY_OUT: generationPath },
    timeoutMs: REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS,
    maxBytes: REFRESH_MAX_BYTES,
  });
  // NOTE: the runner's contract is that it ALREADY invokes any
  // `post` callback on the response before returning (the default
  // runner ignores the field; fake runners use it to simulate
  // graphify's side-effects). The runtime does NOT invoke `post`
  // itself — calling it here would double-invoke the side-effects
  // and break tests that count `post` calls.
  void sanitizedEnv;
  if (!refreshResult.ok) {
    await rm(generationPath, { recursive: true, force: true }).catch(() => undefined);
    if (refreshResult.code === "GRAPHIFY_TIMEOUT") {
      return {
        ok: false,
        reason: "refresh-timeout",
        message: refreshResult.message,
        detail: refreshResult.detail,
      };
    }
    if (refreshResult.code === "GRAPHIFY_NOT_INSTALLED") {
      return {
        ok: false,
        reason: "refresh-failed",
        message: refreshResult.message,
        detail: { ...refreshResult.detail, hint: "missing-binary" },
      };
    }
    return {
      ok: false,
      reason: "refresh-failed",
      message: refreshResult.message,
      detail: refreshResult.detail,
    };
  }

  // Validate the just-built generation's `graph.json`. A failure
  // here removes the in-progress generation (the previous active
  // generation, if any, is untouched) and surfaces the typed reason.
  const stagedGraphJson = join(generationPath, "graph.json");
  try {
    await readAndValidateStagedGraph(stagedGraphJson);
  } catch (error) {
    await rm(generationPath, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof PoiesisError && error.code === "REPOSITORY_INTELLIGENCE_GRAPH_EMPTY") {
      return {
        ok: false,
        reason: "graph-empty",
        message: error.message,
        detail: error.details,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "graph-invalid",
      message,
      detail: error instanceof PoiesisError ? error.details : { cause: message },
    };
  }

  // Atomic activation: rewrite `state.json` so the new generation
  // is the active one. The previous active generation is NOT removed
  // — it is preserved until best-effort GC after this commit
  // succeeds. A failure of the commit leaves the previous stamp in
  // place; the in-progress generation is left on disk and the next
  // successful activation will GC it.
  try {
    await stampRepositoryIntelligenceCacheForRoot(root, generationId);
  } catch (error) {
    await rm(generationPath, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      reason: "refresh-failed",
      message: "Atomic state.json commit failed; the previous active generation is unchanged",
      detail: { cause: error instanceof Error ? error.message : String(error) },
    };
  }

  // Best-effort GC of stale generations. The just-committed
  // generation is preserved; every other generation directory under
  // the generations root is removed. GC failures are intentionally
  // swallowed so they cannot invalidate the just-committed state.
  await garbageCollectGenerations(root, generationId).catch(() => undefined);

  return {
    ok: true,
    graphPath: stagedGraphJson,
    kind: decision.kind,
    durationMs: Date.now() - startedAt,
  };
}

interface QuerySuccess {
  ok: true;
  answer: string;
  truncated: boolean;
}

interface QueryFailure {
  ok: false;
  reason: "query-failed" | "query-timeout";
  message: string;
  detail: Record<string, unknown>;
}

type QueryResult = QuerySuccess | QueryFailure;

/**
 * Run `graphify query <question> --budget <N> --graph <active>` and
 * surface the answer. The query target is the active generation's
 * `graph.json` selected by the just-committed (or reused) state
 * pointer — never a partial / in-progress generation. The fixed
 * `--budget` argument matches Graphify 0.9.70's documented default
 * (2000) and is encoded explicitly so the runtime cannot drift to a
 * different answer-shape per query.
 */
async function performQuery(
  root: string,
  graphPath: string,
  question: string,
  runner: GraphifyRunner,
  sanitizedEnv: NodeJS.ProcessEnv,
): Promise<QueryResult> {
  const queryResult = await runner({
    args: [
      "query",
      question,
      "--budget",
      String(REPOSITORY_INTELLIGENCE_QUERY_BUDGET_TOKENS),
      "--graph",
      graphPath,
    ],
    cwd: root,
    env: sanitizedEnv,
    timeoutMs: REPOSITORY_INTELLIGENCE_QUERY_TIMEOUT_MS,
    maxBytes: QUERY_MAX_BYTES,
  });
  if (!queryResult.ok) {
    if (queryResult.code === "GRAPHIFY_TIMEOUT") {
      return {
        ok: false,
        reason: "query-timeout",
        message: queryResult.message,
        detail: queryResult.detail,
      };
    }
    return {
      ok: false,
      reason: "query-failed",
      message: queryResult.message,
      detail: queryResult.detail,
    };
  }
  if (queryResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "query-failed",
      message: `graphify query exited with code ${queryResult.exitCode}`,
      detail: { exitCode: queryResult.exitCode, stderr: queryResult.stderr.slice(0, 8_000) },
    };
  }
  return {
    ok: true,
    answer: queryResult.stdout,
    truncated: queryResult.stdoutTruncated,
  };
}

interface NodeSuccess {
  ok: true;
  answer: string;
  truncated: boolean;
}

interface NodeFailure {
  ok: false;
  reason: "path-failed" | "path-timeout";
  message: string;
  detail: Record<string, unknown>;
}

type PathResult = NodeSuccess | NodeFailure;

/**
 * Spec #120 / ticket #123 — run `graphify path <from> <to> --graph
 * <active>` and surface the answer. Poiesis named flags translate to
 * Graphify positional args plus the explicit `--graph` pointer. The
 * path target is the active generation's `graph.json` selected by
 * the just-committed (or reused) state pointer — never a partial /
 * in-progress generation. A non-zero exit code or runner error
 * surfaces as the typed `path-failed` / `path-timeout` fallback that
 * `pathRepositoryIntelligence` translates to its operation-specific
 * envelope.
 */
async function performPath(
  root: string,
  graphPath: string,
  from: string,
  to: string,
  runner: GraphifyRunner,
  sanitizedEnv: NodeJS.ProcessEnv,
): Promise<PathResult> {
  const pathResult = await runner({
    args: ["path", from, to, "--graph", graphPath],
    cwd: root,
    env: sanitizedEnv,
    timeoutMs: REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS,
    maxBytes: QUERY_MAX_BYTES,
  });
  if (!pathResult.ok) {
    if (pathResult.code === "GRAPHIFY_TIMEOUT") {
      return {
        ok: false,
        reason: "path-timeout",
        message: pathResult.message,
        detail: pathResult.detail,
      };
    }
    return {
      ok: false,
      reason: "path-failed",
      message: pathResult.message,
      detail: pathResult.detail,
    };
  }
  if (pathResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "path-failed",
      message: `graphify path exited with code ${pathResult.exitCode}`,
      detail: { exitCode: pathResult.exitCode, stderr: pathResult.stderr.slice(0, 8_000) },
    };
  }
  return {
    ok: true,
    answer: pathResult.stdout,
    truncated: pathResult.stdoutTruncated,
  };
}

interface ExplainSuccess {
  ok: true;
  answer: string;
  truncated: boolean;
}

interface ExplainFailure {
  ok: false;
  reason: "explain-failed" | "explain-timeout";
  message: string;
  detail: Record<string, unknown>;
}

type ExplainResult = ExplainSuccess | ExplainFailure;

/**
 * Spec #120 / ticket #123 — run `graphify explain <node> --graph
 * <active>` and surface the answer. Poiesis named flags translate
 * to Graphify positional args plus the explicit `--graph` pointer.
 * The explain target is the active generation's `graph.json`
 * selected by the just-committed (or reused) state pointer — never a
 * partial / in-progress generation. A non-zero exit code or runner
 * error surfaces as the typed `explain-failed` / `explain-timeout`
 * fallback that `explainRepositoryIntelligence` translates to its
 * operation-specific envelope.
 */
async function performExplain(
  root: string,
  graphPath: string,
  node: string,
  runner: GraphifyRunner,
  sanitizedEnv: NodeJS.ProcessEnv,
): Promise<ExplainResult> {
  const explainResult = await runner({
    args: ["explain", node, "--graph", graphPath],
    cwd: root,
    env: sanitizedEnv,
    timeoutMs: REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS,
    maxBytes: QUERY_MAX_BYTES,
  });
  if (!explainResult.ok) {
    if (explainResult.code === "GRAPHIFY_TIMEOUT") {
      return {
        ok: false,
        reason: "explain-timeout",
        message: explainResult.message,
        detail: explainResult.detail,
      };
    }
    return {
      ok: false,
      reason: "explain-failed",
      message: explainResult.message,
      detail: explainResult.detail,
    };
  }
  if (explainResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "explain-failed",
      message: `graphify explain exited with code ${explainResult.exitCode}`,
      detail: { exitCode: explainResult.exitCode, stderr: explainResult.stderr.slice(0, 8_000) },
    };
  }
  return {
    ok: true,
    answer: explainResult.stdout,
    truncated: explainResult.stdoutTruncated,
  };
}

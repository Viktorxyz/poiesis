import { loadManifest } from "./manifest.js";
import { exists } from "./fs.js";
import { PoiesisError } from "./errors.js";
import { poiesisPath } from "./paths.js";

/**
 * Spec #203 / ticket #204 — is a newer Poiesis published?
 *
 * This module owns the whole decision and nothing else owns any part of it:
 * the durable installed version, the single registry lookup, the numeric
 * comparison, the fail-open network policy, and the shape of the one
 * copy-paste command the Author may choose to run. The CLI dispatcher stays a
 * thin shell over `latestReport`.
 *
 * Three properties are deliberate and load-bearing.
 *
 *   1. It is READ-ONLY. Nothing is written, nothing is reconciled, nothing is
 *      restarted. The report is an input to an Author decision, never the
 *      decision itself — so it deliberately has no path that mutates.
 *   2. It reports the DURABLE installed version (`manifest.poiesisVersion`),
 *      not the running package version. The running package version is not an
 *      input at all, which is why this operation is exempt from the runtime
 *      identity boundary: an Author whose runtime is stale is precisely the
 *      Author who must be able to hear that a newer release exists.
 *   3. It fails OPEN on the network and on an unorderable version, and
 *      closed on everything else. A missing registry answer — or a version on
 *      either side that is not a plain numeric `X.Y.Z` — means "no notice",
 *      never "block the Author's session": the comparison is advisory, so a
 *      registry that is unreachable and a version this rule will not order are
 *      the same situation to the Author, and either may only make the report
 *      quieter. The single fail-closed case is a project that is not installed,
 *      where there is no installed version to report and a silent success
 *      would be a fabricated answer.
 */

/**
 * The ONE registry document this operation reads.
 *
 * The `/latest` endpoint is the abbreviated publish metadata for exactly one
 * version, so it is the smallest document that answers the question.
 */
export const NPM_LATEST_LOOKUP_URL = "https://registry.npmjs.org/poiesis-cli/latest";

/**
 * The whole-network bound for the single lookup.
 *
 * The report is advisory and is produced on the Author's critical path — the
 * first reply of a session. A registry that is slow must cost three seconds,
 * not an unbounded wait, which is also what keeps the fail-open policy
 * reachable in practice instead of theoretically.
 */
export const NPM_LATEST_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * The single copy-paste update command.
 *
 * `--config.dlx-cache-max-age=0` is required, not cosmetic: without it pnpm
 * may serve a `dlx` entry up to 1440 minutes old, so the command the Author
 * copies would report having updated while running the version they already
 * had. The version is pinned to the exact published version, never `@latest`,
 * so the command the Author runs is the one this report described.
 */
export const UPDATE_COMMAND_TEMPLATE = "pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@{latest} update";

/** Whether the registry answered with a comparable `X.Y.Z` version. */
export type LatestLookupStatus = "ok" | "unavailable";

/**
 * The injected published-version lookup.
 *
 * Resolves the published version, or `null` when the registry could not
 * answer. Every failure mode — unreachable host, non-2xx, timeout, unparsable
 * body, absent version — is the same answer here, so a test never has to
 * reproduce the network to exercise the policy that follows.
 */
export type LatestVersionLookup = () => Promise<string | null>;

export interface LatestReport {
  /** The durable installed version: `manifest.poiesisVersion`. */
  installed: string;
  /**
   * The published version, or `null` when the registry could not answer or
   * answered with something this report cannot order.
   */
  latest: string | null;
  /** True only when a newer version is published. */
  newerAvailable: boolean;
  /** Present exactly when `newerAvailable` is true. */
  updateCommand?: string;
  /**
   * Whether the registry answered with a version this report could compare.
   * `unavailable` is the whole fail-open class: no answer, and equally no
   * comparable answer.
   */
  lookup: LatestLookupStatus;
}

export interface LatestOptions {
  /** Injected for tests; production uses the single registry GET. */
  readonly lookup?: LatestVersionLookup;
}

/**
 * The one copy-paste command for a published version.
 *
 * The value interpolated here is always one that already passed the strict
 * numeric `X.Y.Z` check, because that check gates the whole reported-version
 * envelope, `updateCommand` included: a published version carrying anything
 * else produces no command at all. So the string the Author pastes is built
 * from digits and dots and can carry no shell metacharacter from a registry
 * response.
 */
export function updateCommandFor(latest: string): string {
  return UPDATE_COMMAND_TEMPLATE.replace("{latest}", () => latest);
}

/**
 * The production lookup: ONE GET, ONE attempt, ~3s, no retry.
 *
 * The request carries no project identity of any kind — no credential, no
 * `Authorization`, no `Referer`, no user agent naming the repository — because
 * the question is about a public package, and an Author's project must not
 * become observable input to a third-party registry call. It is also not the
 * Linear transport: that adapter's capture, retry, and pagination ceilings
 * belong to a different provider with different failure semantics, and
 * borrowing them would import credentials into a request that needs none.
 */
export async function lookupPublishedLatestVersion(): Promise<string | null> {
  const response = await fetch(NPM_LATEST_LOOKUP_URL, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(NPM_LATEST_LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry responded ${response.status}`);
  const body = (await response.json()) as unknown;
  const version =
    typeof body === "object" && body !== null && "version" in body
      ? (body as { version: unknown }).version
      : undefined;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("npm registry response carried no version");
  }
  return version;
}

/**
 * The report for `root`.
 *
 * Fails closed ONLY for a project that is not installed, and decides that
 * BEFORE the lookup: an uninstalled project has no installed version, so there
 * is nothing to compare and nothing useful to say.
 */
export async function latestReport(root: string, options: LatestOptions = {}): Promise<LatestReport> {
  const manifestPath = poiesisPath(root, "manifest.json");
  if (!(await exists(manifestPath))) {
    throw new PoiesisError(
      "POIESIS_NOT_INSTALLED",
      "`poiesis latest` compares an installed version against the published one, and this project is not installed (no manifest)",
      { root, path: manifestPath, operation: "latest" },
    );
  }
  const installed = (await loadManifest(root)).poiesisVersion;

  const lookup = options.lookup ?? lookupPublishedLatestVersion;
  let latest: string | null = null;
  try {
    latest = await lookup();
  } catch {
    // Fail OPEN. The comparison is advisory, so an unreachable or malformed
    // registry answer may only make the report quieter — the Author's session
    // continues, no notice is appended, and nothing is reported as broken.
    return { installed, latest: null, newerAvailable: false, lookup: "unavailable" };
  }
  if (typeof latest !== "string" || latest.trim().length === 0) {
    return { installed, latest: null, newerAvailable: false, lookup: "unavailable" };
  }

  const ordering = compareNumericVersions(installed, latest);
  // `compareNumericVersions` is ordered `installed` against `latest`, so a
  // NEGATIVE ordering is the one that means the Author is behind.
  //
  // A `null` ordering means one side is not a plain numeric `X.Y.Z`, and that
  // is classified exactly like an unreachable registry: there is no comparable
  // published version, so the report carries no version to act on. Reporting
  // the raw string under `lookup: "ok"` would advertise a comparison that this
  // rule deliberately refused to make, and would hand the Author a version it
  // cannot order — the precise failure the numeric rule exists to prevent.
  if (ordering === null) {
    return { installed, latest: null, newerAvailable: false, lookup: "unavailable" };
  }
  const newerAvailable = ordering < 0;
  return {
    installed,
    latest,
    newerAvailable,
    ...(newerAvailable ? { updateCommand: updateCommandFor(latest) } : {}),
    lookup: "ok",
  };
}

/**
 * Numeric X.Y.Z comparison: positive when `a` is newer than `b`, negative
 * when it is older, `0` when equal, and `null` when either side is not a
 * plain numeric `X.Y.Z` triple.
 *
 * `null` is a real answer, not a fallback. A pre-release or a build-metadata
 * version does not order against a plain release under this rule, and guessing
 * an order for one would turn a prerelease of a future version into an update
 * notice the Author cannot act on correctly. Such a pair simply produces no
 * notice.
 *
 * Components compare NUMERICALLY: `1.10.0` is newer than `1.9.0`. A
 * string comparison gets that backwards, and a wrong "you are up to date" is
 * the exact failure this report exists to avoid.
 */
export function compareNumericVersions(a: string, b: string): number | null {
  const left = numericVersionParts(a);
  const right = numericVersionParts(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! > right[index]!) return 1;
    if (left[index]! < right[index]!) return -1;
  }
  return 0;
}

function numericVersionParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
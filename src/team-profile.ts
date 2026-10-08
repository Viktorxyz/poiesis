/**
 * Spec #190 / ticket #192 — the Team/shared declarative project profile.
 *
 * Spec #190 asks for a choice the Author makes explicitly: keep Poiesis
 * private to this clone, or share only the useful project-specific
 * intelligence with the team. This module owns everything that difference
 * needs, and nothing else:
 *
 *  1. **Where shareable source lives.** `${TEAM_PROFILE_DIRECTORY}` — a
 *     project-relative directory OUTSIDE `.poiesis/` and outside the
 *     generated OpenCode projections. That placement is load-bearing three
 *     times over, so it is worth stating plainly:
 *
 *       - `.poiesis/` is ignored wholesale by the one managed `.gitignore`
 *         block. Git cannot re-include a file whose parent directory is
 *         excluded, so a profile nested under `.poiesis/` would need the
 *         block to abandon its wildcard and enumerate every local path —
 *         exactly the drift risk Spec #190 forbids.
 *       - `uninstall` treats unknown content under `.poiesis/` as
 *         preserved-and-reported, so a profile there would make every team
 *         uninstall permanently incomplete.
 *       - Spec #190 classifies package-supplied canon as IGNORED in both
 *         modes. A profile is not package canon; it is Author-created
 *         project intelligence, and it has to sit somewhere the ignore
 *         block never names.
 *
 *  2. **What may enter it.** `teamProfileConfig` is a closed projection of
 *     the resolved config — models, repository/tracker policy, delivery
 *     policy, verification policy — and `assertTeamProfilePortable` fails
 *     closed on anything machine-specific or credential-shaped. The profile
 *     is committed to a team repository; writing an absolute path or a token
 *     into it would be a disclosure the Author never made.
 *
 *  3. **Hydration.** The profile is a valid `PoiesisConfig`, so a fresh
 *     clone hydrates with plain `poiesis init --config
 *     .opencode/poiesis/config.jsonc`. There is no launcher, no environment
 *     variable, and no hidden activation: the ignored projections the command
 *     regenerates are the same ones ordinary OpenCode already discovers.
 *
 * The profile is deliberately NOT recorded in the manifest. Manifest records
 * are Poiesis ownership claims that `uninstall` acts on and that `doctor`
 * hash-checks; shared Author content is none of those things. Leaving it
 * unrecorded is how "Author-created shared profile content is not disposable
 * generated output" becomes mechanical rather than aspirational.
 */
import { isDeepStrictEqual } from "node:util";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFERRED_DELIVERY_MODE,
  deliveryExtensionKeys,
  isDeferredDelivery,
  parseJsonc,
  trackerExtensionKeys,
  validateConfig,
  type PoiesisConfig,
  type ResolvedPoiesisConfig,
} from "./config.js";
import { PoiesisError } from "./errors.js";
import { readUtf8 } from "./fs.js";
import { hashContent, hashFile } from "./hash.js";
import type { ManagedSkill } from "./manifest.js";

/** Project-relative root of the shareable profile. */
export const TEAM_PROFILE_DIRECTORY = ".opencode/poiesis";
/**
 * The shareable project configuration. It is a complete `PoiesisConfig`, so
 * it doubles as the hydration input for a fresh clone.
 */
export const TEAM_PROFILE_CONFIG_PATH = `${TEAM_PROFILE_DIRECTORY}/config.jsonc`;
/** Selected skills with their locked source, revision, and integrity. */
export const TEAM_PROFILE_SKILLS_LOCK_PATH = `${TEAM_PROFILE_DIRECTORY}/skills.lock.json`;
/** Project-created instruction / role overrides, applied at hydration. */
export const TEAM_PROFILE_OVERRIDES_DIRECTORY = `${TEAM_PROFILE_DIRECTORY}/overrides`;

/**
 * Spec #190 — how one artifact class is treated under Team/shared.
 *
 * `shared-source` is the only class Git is meant to see. The other two are
 * closed lists, so a new artifact cannot become trackable by omission: a
 * path is shareable only if it sits under the profile directory, and
 * everything else is either a mirror regenerated from package plus profile
 * or local state that never leaves the machine.
 */
export type TeamArtifactClass = "shared-source" | "local-mirror" | "local-state";

/**
 * Poiesis-owned local state under `.poiesis/`: never shareable, and the
 * ignore block already covers the whole root. Listed so `classifyTeamArtifact`
 * can tell a mirror from machine state without re-deriving the table.
 */
const TEAM_LOCAL_STATE_RELATIVE_PATHS: readonly string[] = [
  ".poiesis/manifest.json",
  ".poiesis/receipt.json",
  ".poiesis/cache",
  ".poiesis/workspaces",
  ".poiesis/runtime",
  ".poiesis/tmp",
  ".poiesis/logs",
  ".poiesis/locks",
];

function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The closed sharing classification for one project-relative path. */
export function classifyTeamArtifact(path: string): TeamArtifactClass {
  if (isAtOrUnder(path, TEAM_PROFILE_DIRECTORY)) return "shared-source";
  for (const state of TEAM_LOCAL_STATE_RELATIVE_PATHS) {
    if (isAtOrUnder(path, state)) return "local-state";
  }
  return "local-mirror";
}

/**
 * The portable projection of the resolved configuration.
 *
 * Deliberately explicit rather than a spread: this object is committed to a
 * team repository, so the set of fields it can carry must be readable in one
 * place. Anything absent here is not shared, which is the safe default.
 */
export function teamProfileConfig(config: ResolvedPoiesisConfig): PoiesisConfig {
  return {
    schema: 1,
    // Carried so the profile is self-describing AND so
    // `poiesis init --config .opencode/poiesis/config.jsonc` needs no other
    // input to hydrate a fresh clone.
    mode: "team",
    models: {
      reasoning: config.models.reasoning,
      execution: config.models.execution,
      ...(config.models.roles === undefined ? {} : { roles: { ...config.models.roles } }),
    },
    repository: {
      remote: config.repository.remote,
      integrationBranch: config.repository.integrationBranch,
    },
    tracker: profileTracker(config.tracker),
    delivery: profileDelivery(config.delivery),
    verification: {
      commands: [...config.verification.commands],
      ...(config.verification.postIntegrationCommands === undefined
        ? {}
        : { postIntegrationCommands: [...config.verification.postIntegrationCommands] }),
    },
  };
}

/**
 * Spec #139 / ticket #144 — the tracker a team shares is the block that
 * provider needs, not a forge block with a missing coordinate.
 *
 * `local` has no repository coordinate at all and `linear` carries a team,
 * so the projection follows the same shape `init` writes: extension keys
 * first, the coordinates this provider owns last. Spreading the resolved
 * block instead would publish `project: undefined` for `local` and drop the
 * Linear team, and a fresh clone would then hydrate a profile it cannot
 * satisfy.
 */
function profileTracker(tracker: ResolvedPoiesisConfig["tracker"]): PoiesisConfig["tracker"] {
  const extensions = trackerExtensionKeys(tracker);
  if (tracker.provider === "local") return { ...extensions, provider: "local" };
  if (tracker.provider === "linear") {
    return {
      ...extensions,
      provider: "linear",
      team: tracker.team,
      ...(tracker.project === undefined ? {} : { project: tracker.project }),
    };
  }
  return { ...extensions, provider: tracker.provider, project: tracker.project };
}

/**
 * Spec #139 / ticket #140 — a deferred install shares `{ mode: "deferred" }`
 * verbatim. Recording three command targets the installation never had would
 * publish a delivery policy nobody chose, and the profile is committed, so the
 * error would outlive the machine that made it.
 *
 * Spec #139 / ticket #153/#154 — the outer `delivery` extension keys are
 * carried the same way `profileTracker` carries the tracker ones: from the
 * shared `deliveryExtensionKeys` partition, extensions FIRST and the fields
 * Poiesis owns LAST, so an extension can never supply, replace, nor complete a
 * marker or a target. Dropping them here would delete a key the Author's own
 * config carries on the next managed rewrite of the committed profile — the
 * one place a silent deletion outlives the machine that made it.
 */
function profileDelivery(delivery: ResolvedPoiesisConfig["delivery"]): PoiesisConfig["delivery"] {
  const extensions = deliveryExtensionKeys(delivery);
  if (isDeferredDelivery(delivery)) return { ...extensions, mode: DEFERRED_DELIVERY_MODE };
  return {
    ...extensions,
    preview: delivery.preview,
    staging: delivery.staging,
    production: delivery.production,
  };
}

/**
 * Machine-specific and credential-shaped values. The path rules are what
 * keeps a clone portable; the credential rules are what keeps a committed
 * profile from becoming a disclosure. Both fail closed — a refusal names the
 * field so the Author can fix the policy instead of guessing.
 *
 * The absolute-path rule is deliberately TOKEN-based rather than anchored to
 * the start of the string, because the fields that carry machine paths most
 * often carry them mid-string: `["node", "/home/alice/bin/deploy.mjs", "{sha}"]`
 * or `"cd /home/alice/project && pnpm check"`. An anchored rule passed both
 * straight through, so the leak it exists to prevent was one shell token away.
 *
 * A token starts at a boundary that cannot be part of a longer word, and the
 * two shapes that legitimately contain `/` are excluded:
 *
 *   - a URL scheme (`https://…`, `git+ssh://…`) — `//` after the colon is a
 *     scheme, not a POSIX root, and remote URLs are project-relative by nature;
 *   - a bare `provider/model` identifier (`openai/gpt-5.6-sol`), where `/` is
 *     an inner separator with no root at all, and `/` at a token start means
 *     an actual path.
 *
 * `C:\…` and `\\server\share` are matched at the token start because a drive
 * letter and a UNC prefix are themselves unambiguous.
 *
 * The boundary set is deliberately generous about SHELL metacharacters,
 * because a metacharacter is exactly the character that puts a path token
 * mid-string with no space in front of it. A redirection operator binds
 * tighter than whitespace — `pnpm test 2>/home/alice/logs/t.log` has no
 * character between `2>` and the path at all — and brace expansion and
 * glob classes put one directly against the path the same way
 * (`rsync -a src/ {/home/alice/stage}`, `` `/home/alice/bin/prepare` ``).
 * A boundary set made only of whitespace and ASCII punctuation left every
 * one of those a one-character blind spot, which is the same class of bug as
 * the anchoring this rule exists to fix.
 *
 * Nothing in the widened set can open a portable shape: a URL scheme is
 * preceded by a letter or `:`, and a `provider/model` identifier by a word
 * character, so adding shell metacharacters removes only false negatives.
 */
const ABSOLUTE_PATH_TOKEN_PATTERN =
  /(?:^|[\s"'`=:,;|&()<>{}[\]])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|~\/)(?!\/)/;
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/i,
];

function profileStringLeaves(value: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => profileStringLeaves(entry, `${path}[${index}]`, out));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) profileStringLeaves(entry, path === "" ? key : `${path}.${key}`, out);
  }
}

/**
 * Fail closed before a single profile byte is written when the projected
 * configuration is not portable.
 *
 * Called on the projected profile, not on the raw config, so it describes
 * exactly what would be committed rather than what the Author happens to
 * have locally.
 */
export function assertTeamProfilePortable(config: PoiesisConfig, source: string): void {
  const leaves: Array<{ path: string; value: string }> = [];
  profileStringLeaves(config, "", leaves);
  const offenders: Array<{ path: string; reason: string }> = [];
  for (const leaf of leaves) {
    if (ABSOLUTE_PATH_TOKEN_PATTERN.test(leaf.value)) {
      offenders.push({ path: leaf.path, reason: "machine-specific absolute path" });
      continue;
    }
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(leaf.value))) {
      offenders.push({ path: leaf.path, reason: "credential-shaped value" });
    }
  }
  if (offenders.length === 0) return;
  throw new PoiesisError(
    "TEAM_PROFILE_NOT_PORTABLE",
    `The shared Poiesis profile would carry values that must not be committed (${offenders
      .map((offender) => `${offender.path}: ${offender.reason}`)
      .join("; ")}). Use project-relative delivery commands and reference credentials through your environment.`,
    { source, offenders },
  );
}

const lockedSkillSchema = z.strictObject({
  name: z.string().min(1),
  source: z.string().min(1),
  revision: z.string().min(1),
  integrity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export const teamSkillsLockSchema = z.strictObject({
  schema: z.literal(1),
  skills: z.array(lockedSkillSchema),
});

export type TeamSkillsLock = z.infer<typeof teamSkillsLockSchema>;

/**
 * Render the shared skill selection.
 *
 * Only skills THIS installation installed appear: a preexisting skill is the
 * Author's own and Poiesis has no provenance to lock. `integrity` is the
 * owned-skill directory digest, so a teammate can see exactly what the team
 * agreed to install rather than a bare name.
 */
export function renderTeamSkillsLock(skills: readonly ManagedSkill[]): string {
  const locked = skills
    .filter((skill) => !skill.preexisting && skill.hash !== undefined)
    .map((skill) => ({
      name: skill.name,
      source: skill.source,
      revision: skill.installedRevision,
      integrity: `sha256:${skill.hash}`,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return `${JSON.stringify({ schema: 1, skills: locked }, null, 2)}\n`;
}

/** Fail-closed parse of a committed skill lock. */
export function parseTeamSkillsLock(content: string, source: string): TeamSkillsLock {
  const parsed = parseJsonc<unknown>(content, source);
  const result = teamSkillsLockSchema.safeParse(parsed);
  if (!result.success) {
    throw new PoiesisError("TEAM_SKILLS_LOCK_INVALID", `Invalid shared Poiesis skill lock in ${source}`, {
      source,
      issues: result.error.issues,
    });
  }
  return result.data;
}

/**
 * Locked skills whose installed revision or integrity no longer matches.
 *
 * Reported, never repaired: a teammate running a newer package legitimately
 * gets a different revision for the same skill, and silently rewriting the
 * committed lock would destroy the team's recorded selection on their behalf.
 */
export function driftedLockedSkills(
  lock: TeamSkillsLock,
  installed: readonly ManagedSkill[],
): Array<{ name: string; locked: string; installed: string | null }> {
  const byName = new Map(installed.map((skill) => [skill.name, skill]));
  const drift: Array<{ name: string; locked: string; installed: string | null }> = [];
  for (const entry of lock.skills) {
    const skill = byName.get(entry.name);
    const actual = skill === undefined || skill.hash === undefined
      ? null
      : `sha256:${skill.hash}@${skill.installedRevision}`;
    const expected = `${entry.integrity}@${entry.revision}`;
    if (actual !== expected) drift.push({ name: entry.name, locked: expected, installed: actual });
  }
  return drift;
}

export interface TeamOverride {
  /** Profile-relative source, for reporting. */
  source: string;
  /** The generated projection this override replaces. */
  destination: string;
  content: string;
}

/**
 * Read the project-created instruction / role overrides.
 *
 * Only names that match a generated Poiesis projection are applied. An
 * override for any other agent is Author content Poiesis does not own: it is
 * left untouched and unreported rather than turned into a projection the
 * manifest could not claim.
 *
 * An override that WOULD be applied but is not a regular file — a symlink, a
 * directory — fails closed. Projecting Author bytes through a link is how a
 * shared profile reads something outside the repository.
 */
export async function readTeamOverrides(
  root: string,
  projectionDestinations: readonly string[],
): Promise<TeamOverride[]> {
  const directory = join(root, TEAM_PROFILE_OVERRIDES_DIRECTORY);
  if (!(await pathEntryExists(directory))) return [];
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new PoiesisError(
      "TEAM_OVERRIDE_UNSAFE",
      `The shared override directory is not a real directory; refusing to read it`,
      { path: TEAM_PROFILE_OVERRIDES_DIRECTORY },
    );
  }
  const byName = new Map(projectionDestinations.map((destination) => [destination.split("/").pop()!, destination]));
  const entries = await readdir(directory, { withFileTypes: true });
  const overrides: TeamOverride[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.name.endsWith(".md")) continue;
    const destination = byName.get(entry.name);
    if (destination === undefined) continue;
    const path = join(directory, entry.name);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new PoiesisError(
        "TEAM_OVERRIDE_UNSAFE",
        `A shared Poiesis override is not a regular file; refusing to project it`,
        { path: `${TEAM_PROFILE_OVERRIDES_DIRECTORY}/${entry.name}` },
      );
    }
    overrides.push({
      source: `${TEAM_PROFILE_OVERRIDES_DIRECTORY}/${entry.name}`,
      destination,
      content: await readUtf8(path),
    });
  }
  return overrides;
}

/**
 * Ticket #197 — the identity of the shared override SET, not of one file.
 *
 * A set digest rather than per-file digests because the interesting race is
 * not only "this file was edited" but also "an override was added or removed
 * between the read and the write": the second case has no file to hash, and a
 * per-file guard would miss it. Entries are sorted so directory enumeration
 * order cannot make the identity flap.
 */
export function teamOverrideSetDigest(overrides: readonly TeamOverride[]): string {
  const entries = overrides
    .map((override) => `${override.source} ${hashContent(override.content)}`)
    .sort();
  return hashContent(entries.join("\n"));
}

/**
 * Ticket #197 — refuse to project a shared override set this transaction did
 * not read.
 *
 * The analogue of init's `adoptedProfileHash` guard, and the same question it
 * asks: not "does the file still equal what I would have written" but "is the
 * source still the source I planned from". A teammate pulling a new override,
 * or a background process replacing one, between the read and the first
 * projection write must fail closed rather than project stale bytes and
 * re-baseline manifest ownership onto them.
 *
 * Re-reads through `readTeamOverrides`, so the re-validation applies exactly
 * the same unsafe-source refusal the initial read did — one seam, one verdict.
 */
export async function assertTeamOverridesUnchanged(args: {
  root: string;
  projectionDestinations: readonly string[];
  observed: readonly TeamOverride[];
}): Promise<void> {
  const current = await readTeamOverrides(args.root, args.projectionDestinations);
  const before = teamOverrideSetDigest(args.observed);
  const after = teamOverrideSetDigest(current);
  if (before === after) return;
  throw new PoiesisError(
    "TEAM_OVERRIDE_CONFLICT",
    `The shared Poiesis overrides changed during the update; refusing to project stale project content`,
    {
      overrides: current.map((override) => override.source),
      observedDigest: before,
      currentDigest: after,
    },
  );
}

/**
 * Adoption decision for a profile that is already on disk.
 *
 * Byte equality is deliberately NOT the test: the profile is hand-editable
 * JSONC, and a comment or key order must not read as a conflict. Semantic
 * equality is the test, and anything else is a `TEAM_PROFILE_CONFLICT`
 * raised before a single byte is written — hydrating local projections from a
 * configuration the committed profile contradicts is the one outcome that
 * would leave the team silently disagreeing with itself.
 */
export function assertTeamProfileAdoptable(args: {
  existing: PoiesisConfig;
  wanted: PoiesisConfig;
  source: string;
}): void {
  if (isDeepStrictEqual(args.existing, args.wanted)) return;
  throw new PoiesisError(
    "TEAM_PROFILE_CONFLICT",
    `The shared Poiesis profile at ${args.source} already states a different configuration. Hydrate with \`poiesis init --config ${args.source}\`, or edit the profile itself — Poiesis will not silently replace committed project intelligence.`,
    { source: args.source },
  );
}

/**
 * The digest of a profile file's current on-disk bytes, or `undefined` when
 * it is absent.
 *
 * Used as the pre-transaction observation a caller compares against later, so
 * "this file was replaced while the transaction ran" is distinguishable from
 * "this file differs from what I would have written". The second question has
 * no business deciding adoption of author-created source at all — see
 * `assertTeamProfileAdoptable` for the one case where it legitimately does.
 */
export async function teamProfileFileHash(root: string, path: string): Promise<string | undefined> {
  const absolute = join(root, path);
  if (!(await pathEntryExists(absolute))) return undefined;
  if (!(await isRegularFile(absolute))) {
    throw new PoiesisError(
      "TEAM_PROFILE_UNSAFE",
      `The shared Poiesis profile is not a regular file; refusing to adopt or replace it`,
      { path },
    );
  }
  return hashFile(absolute);
}

async function isRegularFile(path: string): Promise<boolean> {
  const details = await lstat(path);
  return details.isFile() && !details.isSymbolicLink();
}

/** Read and validate an on-disk shared profile, or `null` when absent. */
export async function readTeamProfileConfig(root: string): Promise<PoiesisConfig | null> {
  const path = join(root, TEAM_PROFILE_CONFIG_PATH);
  if (!(await pathEntryExists(path))) return null;
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new PoiesisError(
      "TEAM_PROFILE_UNSAFE",
      `The shared Poiesis profile is not a regular file; refusing to adopt or replace it`,
      { path: TEAM_PROFILE_CONFIG_PATH },
    );
  }
  return validateConfig(parseJsonc(await readUtf8(path), TEAM_PROFILE_CONFIG_PATH), TEAM_PROFILE_CONFIG_PATH);
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
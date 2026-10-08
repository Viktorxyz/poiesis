/**
 * Spec #190 / ticket #194 — the explicit migration of a RELEASED, mode-less
 * installation onto an explicit sharing mode.
 *
 * Tickets #191-#193 gave Poiesis two modes, the ONE managed `.gitignore`
 * block that states them, and the `private <-> team` TRANSITION between two
 * installations that already chose one. None of them can reach the
 * installation this ticket is about: one a RELEASED Poiesis version wrote
 * before the mode existed. Such an installation records no `mode`, owns no
 * managed block, states no sharing policy anywhere, and — this is the part
 * that makes it different from every other case — used to TRACK the canon and
 * generated projections it wrote, because `trackInProject` meant exactly that
 * before Spec #190.
 *
 * The rules this module exists to make mechanical:
 *
 *  1. **A migration is explicit and separate.** It is requested by naming the
 *     target mode on a dedicated lifecycle route
 *     (`poiesis migrate install-mode --to private|team`). Ordinary
 *     `update --config` keeps refusing an explicit mode against a mode-less
 *     manifest: a reconcile must never re-decide a sharing policy, and an
 *     unrelated config update must never become a migration. Nothing here is
 *     ever a side effect of `update`, `init`, `doctor`, or `uninstall`.
 *
 *  2. **It touches only what the manifest can attribute.** The block is
 *     rendered from `manifest.files`, `manifest.skills`,
 *     `manifest.generatedScripts`, and the recognized OpenCode config record —
 *     the same closed classification `init` writes and a transition rebuilds.
 *     A path Poiesis cannot attribute never enters the policy, so choosing a
 *     mode can never widen the ignore list over Author content.
 *
 *  3. **Bytes the manifest cannot attribute are PRESERVED, not cleaned up.** A
 *     pre-Spec #190 `.gitignore` carries loose Poiesis-authored rules that no
 *     manifest record claims, and the Author's own rules above and below them.
 *     The block is APPENDED and every other byte survives; the legacy rules
 *     stay as ordinary text, because removing text no ownership record covers
 *     is exactly the deletion this surface must never perform. Poiesis claims
 *     the block it writes and nothing else.
 *
 *  4. **Tracking is the one thing the new policy cannot do alone.** Git ignores
 *     only affect UNTRACKED files, so naming a formerly tracked artifact in the
 *     block changes nothing until its index entry is gone — and a released
 *     installation DID track the canon, the generated projections, the delivery
 *     scripts it generated, and the skills it installed. Untracking is therefore
 *     part of the migration, and it is deliberately the narrowest possible shape:
 *       - only a path the manifest proves this installation owns is a
 *         candidate — never a scan, never a wildcard, never a guess — and the
 *         candidates are exactly the three sources the ignore classification is
 *         built from (`files`, `generatedScripts`, and the non-preexisting
 *         `skills`), so "the block names it" and "the manifest can prove it"
 *         cannot disagree;
 *       - a candidate whose bytes no longer match the recorded digest, or whose
 *         index entry carries a staged or unstaged change, BLOCKS the whole
 *         migration by name instead of being untracked on Poiesis's judgement;
 *       - the removal is index-only (`git rm --cached`): the worktree bytes the
 *         Author sees and OpenCode reads are never touched;
 *       - an installed skill directory the Author ALREADY had is never a
 *         candidate: it is not named by the block, so it can never enter this
 *         surface;
 *       - every removal is reported, and Poiesis NEVER commits and NEVER
 *         pushes — the Author reviews and commits the staged result themselves;
 *       - a failed migration restores every index entry it removed, so a
 *         refusal or a rollback leaves the repository exactly as it was.
 *
 *  5. **Team adds published source and nothing else.** `team` additionally
 *     creates (or adopts, untouched) the declarative project profile, after
 *     proving the resolved configuration is portable and that any committed
 *     profile agrees with it. A contradicting profile is refused before a
 *     single byte is written.
 *
 * Every function here is read-only. The caller owns the writes, the journal,
 * the index mutations, the rollback, and the doctor gate, so this module cannot
 * become a second transaction.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeConfig, type ResolvedPoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import { hashContent } from "./hash.js";
import {
  GITIGNORE_RELATIVE_PATH,
  managedIgnoreBlockLines,
  parseManagedIgnoreBlocks,
  renderManagedIgnoreBlock,
  type InstallMode,
  type ManagedIgnoreBlock,
  type ManagedIgnoreContext,
} from "./install-mode.js";
import type { IgnoreBlockRecord, Manifest } from "./manifest.js";
import { OPENCODE_CONFIG_RELATIVE_PATHS } from "./opencode.js";
import { ownedPath } from "./paths.js";
import { run } from "./process.js";
import {
  TEAM_PROFILE_CONFIG_PATH,
  TEAM_PROFILE_SKILLS_LOCK_PATH,
  assertTeamProfileAdoptable,
  assertTeamProfilePortable,
  readTeamProfileConfig,
  renderTeamSkillsLock,
  teamProfileConfig,
} from "./team-profile.js";
import { assertNoSymlinkedParents } from "./install-mode-transition.js";
import { hashOwnedSkillDirectory } from "./skills.js";

/** Where the installed sharing mode lives, for a path-specific refusal. */
const MANIFEST_RELATIVE_PATH = ".poiesis/manifest.json";

/** One index entry the migration removed and must be able to put back. */
export interface MigrationIndexEntry {
  /** Project-relative path. */
  path: string;
  /** Index file mode, exactly as Git recorded it (`100644`, `100755`, ...). */
  mode: string;
  /** Index blob object id, exactly as Git recorded it. */
  object: string;
}

export interface MigrationProfileFile {
  /** Project-relative path. */
  path: string;
  /** Exact bytes the transaction writes. */
  content: string;
}

/** One formerly tracked artifact the migration removes from the INDEX. */
export interface MigrationUntrack {
  /** Project-relative path. */
  path: string;
  /** Whether the artifact is a single file or an installed skill directory. */
  kind: "file" | "directory";
  /**
   * Every index entry the removal deletes, captured in the order Git listed
   * them. A directory removal deletes one entry per tracked file inside it, so
   * the restoration is per entry rather than per artifact.
   */
  entries: MigrationIndexEntry[];
}

export interface InstallModeMigrationPlan {
  /** The mode the Author explicitly asked for. */
  to: InstallMode;
  /** The mode-less installation being migrated, for reporting. */
  from: null;
  /**
   * `sha256` of the exact `.gitignore` bytes this plan was rendered from, or
   * `null` when the file was absent. `assertMigrationCaptureIdentity` binds the
   * plan to what the transaction's journal actually captured, so a file that
   * changed between planning and capturing can never be rewritten from a plan
   * computed against content that no longer exists.
   */
  observedGitignoreHash: string | null;
  /** `.gitignore` exactly as it will be after the migration. */
  gitignoreContent: string;
  /** The ONE managed block exactly as it will be after the migration. */
  block: ManagedIgnoreBlock;
  /** The manifest `ignoreBlock` record the migration installs. */
  record: IgnoreBlockRecord;
  /** `.poiesis/config.jsonc` exactly as it will be after the migration. */
  configContent: string;
  /** Shared profile files to CREATE (they are absent right now). */
  createProfileFiles: MigrationProfileFile[];
  /** Shared profile files ADOPTED untouched, for reporting. */
  adoptProfileFiles: string[];
  /** Index-only removals this migration will stage, in application order. */
  untrack: MigrationUntrack[];
  /**
   * Whether the OpenCode config is one of the index-only removals, i.e. whether
   * this migration itself is what makes a formerly tracked config local.
   */
  untracksOpenCodeConfig: boolean;
  /** The recognized OpenCode config this installation patches. */
  openCodeConfigRelativePath: string | null;
}

function unsupported(message: string, details: Record<string, unknown>): PoiesisError {
  return new PoiesisError("INSTALL_MODE_MIGRATION_UNSUPPORTED", message, details);
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

function isRecognizedOpenCodeConfigPath(path: string): boolean {
  return (OPENCODE_CONFIG_RELATIVE_PATHS as readonly string[]).includes(path);
}

/**
 * The sharing classification a migration publishes, derived ONLY from what the
 * manifest attributes to this installation.
 *
 * Structurally the same closed classification `init` writes and a transition
 * rebuilds, with exactly one difference forced by the migration's subject: a
 * pre-Spec #190 manifest carries no `provenance` on its file records, so
 * "Poiesis created the OpenCode config" can only be answered by the presence of
 * a whole-file record for a recognized config path. That is still manifest
 * evidence — a patched-but-never-owned config the Author already had records
 * nothing and therefore stays outside the policy, across a migration exactly as
 * across an install.
 *
 * Delivery scripts come from `generatedScripts`, never from a scan. A
 * mode-less manifest has no `generatedScripts` record, so a legacy installation's
 * `scripts/poiesis-*.mjs` files stay TRACKED and outside the policy: Poiesis has
 * no provenance record for them, and neither ignoring nor untracking a path it
 * cannot attribute would be safe.
 */
function managedIgnoreContextFromManifest(args: {
  manifest: Manifest;
  generatedAgentPaths: readonly string[];
  mode: InstallMode;
}): ManagedIgnoreContext {
  const { manifest } = args;
  const createdOpenCodeConfigPath = manifest.files.find(
    (file) => isRecognizedOpenCodeConfigPath(file.path) && !file.path.startsWith(".poiesis/"),
  )?.path;
  return {
    mode: args.mode,
    generatedAgentPaths: args.generatedAgentPaths,
    createdOpenCodeConfigPath,
    generatedDeliveryScripts: (manifest.generatedScripts ?? []).map((record) => record.path),
    installedSkillPaths: manifest.skills
      .filter((skill) => !skill.preexisting)
      .map((skill) => skill.path),
  };
}

/** The mode-carrying configuration the migration writes and publishes from. */
export function migrationConfigWithMode(
  resolved: ResolvedPoiesisConfig,
  mode: InstallMode,
): ResolvedPoiesisConfig {
  // Key order matches `configSchema` exactly and is built explicitly rather than
  // spread, so the serialized bytes an operator reviews read the way the schema
  // declares them and do not depend on where `mode` happened to be absent from
  // the legacy config.
  return {
    schema: 1,
    mode,
    models: resolved.models,
    repository: resolved.repository,
    tracker: resolved.tracker,
    delivery: resolved.delivery,
    verification: resolved.verification,
  };
}

interface IndexProbe {
  /** At least one index entry exists for the path. */
  tracked: boolean;
  /** Every stage-0 index entry exactly as Git recorded it. */
  entries: MigrationIndexEntry[];
  /** The worktree copy differs from the index copy. */
  worktreeDiffers: boolean;
  /** The index copy differs from `HEAD`. */
  indexDiffers: boolean;
}

async function probeIndexEntries(root: string, path: string): Promise<IndexProbe> {
  const stage = await run("git", ["ls-files", "--stage", "-z", "--", path], {
    cwd: root,
    allowFailure: true,
  });
  if (stage.exitCode !== 0) {
    throw new PoiesisError(
      "INSTALL_MODE_MIGRATION_GIT_PROBE_FAILED",
      `Poiesis could not read the Git index entries for ${path}`,
      { path, stderr: stage.stderr },
    );
  }
  const entries: MigrationIndexEntry[] = [];
  for (const line of stage.stdout.split("\0")) {
    if (line.length === 0) continue;
    // `<mode> SP <object> SP <stage> TAB <path>`; the NUL-terminated form is
    // used precisely so a path with unusual characters is never re-parsed.
    const match = /^(\d{6}) ([0-9a-f]{40,64}) 0\t(.*)$/.exec(line);
    if (match === null) {
      throw new PoiesisError(
        "INSTALL_MODE_MIGRATION_GIT_PROBE_FAILED",
        "Poiesis could not parse a Git index entry",
        { path, entry: line },
      );
    }
    entries.push({ path: match[3]!, mode: match[1]!, object: match[2]! });
  }
  const [worktree, index] = await Promise.all([
    run("git", ["diff", "--name-only", "-z", "--", path], { cwd: root, allowFailure: true }),
    run("git", ["diff", "--cached", "--name-only", "-z", "--", path], { cwd: root, allowFailure: true }),
  ]);
  for (const [label, result] of [["worktree", worktree], ["index", index]] as const) {
    if (result.exitCode !== 0) {
      throw new PoiesisError(
        "INSTALL_MODE_MIGRATION_GIT_PROBE_FAILED",
        `Poiesis could not read the ${label} state of ${path}`,
        { path, state: label, stderr: result.stderr },
      );
    }
  }
  return {
    tracked: entries.length > 0,
    entries,
    worktreeDiffers: worktree.stdout.length > 0,
    indexDiffers: index.stdout.length > 0,
  };
}

/**
 * One artifact the manifest attributes to this installation and the new policy
 * will hide.
 *
 * The three sources are exactly the three the ignore classification itself is
 * built from, so "the block names it" and "the manifest can prove it" can never
 * disagree: canon / projections / the created OpenCode config from `files`, the
 * generated delivery scripts from `generatedScripts`, and the installed default
 * skills from `skills`. A PREEXISTING skill is absent by construction — a skill
 * directory the Author already had is theirs, is never named by the block, and
 * therefore can never be a candidate here.
 */
interface MigrationCandidate {
  path: string;
  kind: "file" | "directory";
  /** The digest the manifest recorded for this artifact. */
  expectedHash: string;
}

function migrationCandidates(manifest: Manifest): MigrationCandidate[] {
  const candidates: MigrationCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: MigrationCandidate): void => {
    if (seen.has(candidate.path)) return;
    seen.add(candidate.path);
    candidates.push(candidate);
  };
  // The canonical canon under `.poiesis/` is a candidate like any other: the
  // block's `.poiesis/` rule hides that whole root, and those records are
  // exactly the artifacts a pre-Spec #190 install used to track.
  for (const file of manifest.files) add({ path: file.path, kind: "file", expectedHash: file.hash });
  for (const script of manifest.generatedScripts ?? []) {
    add({ path: script.path, kind: "file", expectedHash: script.hash });
  }
  for (const skill of manifest.skills) {
    if (skill.preexisting) continue;
    if (skill.hash === undefined) {
      throw new PoiesisError(
        "INSTALL_MODE_MIGRATION_OWNED_FILE_CHANGED",
        `Refusing to migrate ${skill.path}: Poiesis recorded no installed digest for the skill directory it installed, so its contents cannot be proved unchanged`,
        { path: skill.path },
      );
    }
    add({ path: skill.path, kind: "directory", expectedHash: skill.hash });
  }
  return candidates;
}

/**
 * Decide which formerly TRACKED artifacts this migration removes from the index.
 *
 * A candidate is a path the manifest proves this installation owns AND the new
 * policy will hide. Every refusal happens here, before the caller's first
 * write, and every refusal names the path that is wrong:
 *
 *   - an uncommitted staged or unstaged change is an operation the Author owns,
 *     and an index-only removal would convert it into a staged deletion — so
 *     that is checked FIRST, because it is the fact that actually decides what
 *     would be destroyed;
 *   - bytes that no longer match the recorded digest are the Author's edit, and
 *     Poiesis will not decide on their behalf whether a project keeps tracking
 *     it — which is also the only way a file that is not tracked at all reaches
 *     this refusal;
 *   - an unsafe path (one that escapes the repository, or one that is not the
 *     exact kind of entry the manifest recorded) is refused by name.
 *
 * A path that is not tracked needs nothing beyond those checks: the policy
 * already governs it.
 */
async function planIndexUntracking(args: {
  root: string;
  manifest: Manifest;
}): Promise<{ untrack: MigrationUntrack[]; openCodeConfigRelativePath: string | null }> {
  const untrack: MigrationUntrack[] = [];
  const openCodeConfigPath = args.manifest.files.find((file) =>
    isRecognizedOpenCodeConfigPath(file.path),
  )?.path;
  for (const candidate of migrationCandidates(args.manifest)) {
    // `ownedPath` refuses an absolute / escaping / dotted path by name.
    const absolute = ownedPath(args.root, candidate.path);
    if (!(await pathEntryExists(absolute))) {
      throw new PoiesisError(
        "FILE_OWNERSHIP_LOST",
        candidate.kind === "directory"
          ? "Managed skill directory is missing"
          : "Managed file is missing or not a regular file",
        { path: candidate.path },
      );
    }
    const details = await lstat(absolute);
    const wrongKind =
      candidate.kind === "directory"
        ? !details.isDirectory() || details.isSymbolicLink()
        : !details.isFile() || details.isSymbolicLink();
    if (wrongKind) {
      throw new PoiesisError(
        "UNSAFE_MANAGED_PATH",
        candidate.kind === "directory"
          ? "Managed skill path is not a real directory"
          : "Managed path is not a regular file",
        { path: candidate.path },
      );
    }
    const probe = await probeIndexEntries(args.root, candidate.path);
    if (probe.tracked && (probe.indexDiffers || probe.worktreeDiffers)) {
      throw new PoiesisError(
        "INSTALL_MODE_MIGRATION_DIRTY_INDEX",
        `Refusing to untrack ${candidate.path}: it has uncommitted changes in the Git index or worktree. Commit, restore, or untrack it yourself, then re-run the migration`,
        { path: candidate.path, staged: probe.indexDiffers, unstaged: probe.worktreeDiffers },
      );
    }
    const actual =
      candidate.kind === "directory"
        ? await hashOwnedSkillDirectory(absolute)
        : hashContent(await readFile(absolute));
    if (actual !== candidate.expectedHash) {
      throw new PoiesisError(
        "INSTALL_MODE_MIGRATION_OWNED_FILE_CHANGED",
        `Refusing to migrate ${candidate.path}: it changed after Poiesis installed it, so what the project shares for it is no longer Poiesis's decision. Restore it, or accept the change in the manifest yourself, then re-run the migration`,
        { path: candidate.path, expected: candidate.expectedHash },
      );
    }
    if (!probe.tracked) continue;
    untrack.push({ path: candidate.path, kind: candidate.kind, entries: probe.entries });
  }
  return { untrack, openCodeConfigRelativePath: openCodeConfigPath ?? null };
}

/**
 * Plan one explicit mode-less → `private` / `team` migration. Read-only: it
 * inspects the installed config, the `.gitignore`, the Git index, and (when the
 * target is `team`) the shared profile, and returns exactly what the caller must
 * write or stage.
 */
export async function planInstallModeMigration(args: {
  root: string;
  manifest: Manifest;
  /** The mode the Author explicitly asked for. */
  to: InstallMode;
  /** The installed configuration with defaults already resolved. */
  resolvedConfig: ResolvedPoiesisConfig;
  /** Generated OpenCode agent projections, from the template table. */
  generatedAgentPaths: readonly string[];
}): Promise<InstallModeMigrationPlan> {
  // A pre-Spec #190 installation records neither a mode nor a block. An
  // installation that DOES record one is a TRANSITION, not a migration: it
  // already made the sharing decision, and the route that may revise it is the
  // one `update --config` owns.
  if (args.manifest.mode !== undefined || args.manifest.ignoreBlock !== undefined) {
    throw unsupported(
      "This Poiesis installation already records a sharing mode, so it does not need a migration; state the other mode in a config handed to `poiesis update --config` to change how it shares",
      {
        path: MANIFEST_RELATIVE_PATH,
        recorded: args.manifest.mode ?? null,
        requested: args.to,
      },
    );
  }

  const gitignorePath = join(args.root, GITIGNORE_RELATIVE_PATH);
  await assertNoSymlinkedParents(args.root, gitignorePath);
  const gitignorePresent = await pathEntryExists(gitignorePath);
  let existingContent: string | null = null;
  if (gitignorePresent) {
    const details = await lstat(gitignorePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore is not a regular file", {
        path: GITIGNORE_RELATIVE_PATH,
      });
    }
    const bytes = await readFile(gitignorePath);
    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
      throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore is not valid UTF-8", {
        path: GITIGNORE_RELATIVE_PATH,
      });
    }
    existingContent = bytes.toString("utf8");
  }
  // Malformed and duplicated blocks are refused here by the shared parser, which
  // already raises `GITIGNORE_BLOCK_MALFORMED` / `GITIGNORE_BLOCK_DUPLICATE`
  // with `.gitignore` as the named path.
  const [existingBlock] = parseManagedIgnoreBlocks(existingContent ?? "");
  if (existingBlock !== undefined) {
    // A managed block the manifest does not claim is a contradiction: Poiesis
    // would have to either adopt a block whose exact identity nothing records
    // (and could therefore never reverse) or write a second one beside it.
    throw unsupported(
      "`.gitignore` already carries a Poiesis-managed ignore block that this installation's manifest does not claim, so the sharing policy cannot be migrated onto it",
      { path: GITIGNORE_RELATIVE_PATH, labelled: existingBlock.mode, requested: args.to },
    );
  }

  // Render the managed block from the manifest-attributable classification and
  // APPEND it. Every pre-existing byte survives: the Author's own rules, the
  // legacy loose Poiesis rules no manifest record claims, and the file's exact
  // trailing whitespace. The separator is added only when the file does not
  // already end in a newline, so the Author's file is never reflowed.
  const body = managedIgnoreBlockLines(
    managedIgnoreContextFromManifest({
      manifest: args.manifest,
      generatedAgentPaths: args.generatedAgentPaths,
      mode: args.to,
    }),
  );
  const rendered = renderManagedIgnoreBlock(args.to, body);
  const gitignoreContent =
    existingContent === null || existingContent.length === 0
      ? rendered
      : `${existingContent}${existingContent.endsWith("\n") ? "" : "\n"}${rendered}`;
  const [block] = parseManagedIgnoreBlocks(gitignoreContent);
  if (block === undefined || block.mode !== args.to) {
    throw unsupported("Poiesis could not state the requested sharing mode in its ignore block", {
      path: GITIGNORE_RELATIVE_PATH,
      mode: args.to,
    });
  }

  const { untrack, openCodeConfigRelativePath } = await planIndexUntracking({
    root: args.root,
    manifest: args.manifest,
  });

  const createProfileFiles: MigrationProfileFile[] = [];
  const adoptProfileFiles: string[] = [];
  const resolvedWithMode = migrationConfigWithMode(args.resolvedConfig, args.to);
  if (args.to === "team") {
    // The profile is committed to a team repository, so it is validated BEFORE
    // anything is written: a machine path or a credential in the resolved policy
    // is refused while the repository is still untouched.
    const wanted = teamProfileConfig(resolvedWithMode);
    assertTeamProfilePortable(wanted, "shared Poiesis profile");

    const configAbsolute = join(args.root, TEAM_PROFILE_CONFIG_PATH);
    await assertNoSymlinkedParents(args.root, configAbsolute);
    // `readTeamProfileConfig` raises `TEAM_PROFILE_UNSAFE` for anything that is
    // not a regular file, so a symlinked profile fails closed by name rather
    // than being adopted or replaced.
    const adopted = await readTeamProfileConfig(args.root);
    if (adopted === null) {
      createProfileFiles.push({ path: TEAM_PROFILE_CONFIG_PATH, content: serializeConfig(wanted) });
    } else {
      // Adoption is SEMANTIC: `config.jsonc` is hand-editable JSONC, so a
      // comment or reordered keys is a legal difference, while a profile that
      // states a different configuration is a contradiction and is refused
      // untouched.
      assertTeamProfileAdoptable({ existing: adopted, wanted, source: TEAM_PROFILE_CONFIG_PATH });
      adoptProfileFiles.push(TEAM_PROFILE_CONFIG_PATH);
    }

    const lockAbsolute = join(args.root, TEAM_PROFILE_SKILLS_LOCK_PATH);
    await assertNoSymlinkedParents(args.root, lockAbsolute);
    if (!(await pathEntryExists(lockAbsolute))) {
      createProfileFiles.push({
        path: TEAM_PROFILE_SKILLS_LOCK_PATH,
        content: renderTeamSkillsLock(args.manifest.skills),
      });
    } else {
      const lockDetails = await lstat(lockAbsolute);
      if (!lockDetails.isFile() || lockDetails.isSymbolicLink()) {
        throw new PoiesisError(
          "TEAM_PROFILE_UNSAFE",
          "The shared Poiesis skill lock is not a regular file; refusing to adopt or replace it",
          { path: TEAM_PROFILE_SKILLS_LOCK_PATH },
        );
      }
      // The lock records the selection the TEAM agreed on. It is adopted
      // unconditionally: revision drift is legitimate team state that `doctor`
      // reports, never something a migration rewrites.
      adoptProfileFiles.push(TEAM_PROFILE_SKILLS_LOCK_PATH);
    }
  }

  return {
    to: args.to,
    from: null,
    observedGitignoreHash: existingContent === null ? null : hashContent(existingContent),
    gitignoreContent,
    block,
    record: {
      path: GITIGNORE_RELATIVE_PATH,
      mode: args.to,
      patterns: [...block.patterns],
      hash: block.hash,
      // The block is APPENDED to whatever was there, so Poiesis created the file
      // only when it did not exist at all. `uninstall` keeps deciding on exactly
      // the same grounds it did before.
      fileCreated: existingContent === null || existingContent.length === 0,
      owned: true,
    },
    configContent: serializeConfig(resolvedWithMode),
    createProfileFiles,
    adoptProfileFiles,
    untrack,
    untracksOpenCodeConfig:
      openCodeConfigRelativePath !== null &&
      untrack.some((candidate) => candidate.path === openCodeConfigRelativePath),
    openCodeConfigRelativePath,
  };
}

/**
 * Bind a plan to the bytes the transaction's bounded journal actually captured.
 *
 * Planning and capturing are separate observations, and a migration may only
 * act on the state it planned against:
 *
 *   - `.gitignore` must still be exactly the content the plan appended to, or
 *     absent exactly when the plan said it was absent. Rewriting a file that
 *     appeared in between would splice a block into content nothing was planned
 *     against.
 *   - a shared profile the plan decided to CREATE must still be absent. If it
 *     appeared in between, the adoption decision was made about content that is
 *     no longer there, and creating over it would overwrite Author-committed
 *     project intelligence.
 *
 * Pure and synchronous, and raised `ARTIFACT_IDENTITY_DRIFT` naming the
 * offending path — the same code and shape the journal's own pre-write identity
 * guard uses.
 */
export function assertMigrationCaptureIdentity(
  plan: InstallModeMigrationPlan,
  captured: {
    /** Preimage the journal captured for `.gitignore`, or `undefined` when absent. */
    gitignorePreimage: Buffer | undefined;
    /** What the journal captured for each profile file the plan would create. */
    profileCaptures: ReadonlyArray<{ path: string; physicalExists: boolean }>;
  },
): void {
  const observed =
    captured.gitignorePreimage === undefined ? null : hashContent(captured.gitignorePreimage);
  if (observed !== plan.observedGitignoreHash) {
    throw new PoiesisError(
      "ARTIFACT_IDENTITY_DRIFT",
      "Git ignore changed while planning the Poiesis installation-mode migration",
      { path: GITIGNORE_RELATIVE_PATH },
    );
  }
  for (const capture of captured.profileCaptures) {
    if (capture.physicalExists) {
      throw new PoiesisError(
        "ARTIFACT_IDENTITY_DRIFT",
        "The shared Poiesis profile appeared while planning the installation-mode migration",
        { path: capture.path },
      );
    }
  }
}

/**
 * Remove exactly the planned paths from the Git INDEX, and nothing else.
 *
 * `git rm --cached` leaves every worktree byte in place, so the artifacts stay
 * readable by the Author and discoverable by ordinary OpenCode; only the
 * repository stops treating them as shared project content. An installed skill
 * directory is removed recursively for the same reason and by the same rule.
 * Poiesis never commits and never pushes — the removals are left STAGED for the
 * Author.
 *
 * The captured index entries are what makes this reversible: a failure part way
 * through restores every removal this call already applied before rethrowing,
 * so the index is never left half-migrated.
 */
export async function untrackMigrationPaths(
  root: string,
  removals: readonly MigrationUntrack[],
): Promise<void> {
  const applied: MigrationUntrack[] = [];
  for (const removal of removals) {
    const result = await run(
      "git",
      ["rm", "--cached", "--quiet", ...(removal.kind === "directory" ? ["--recursive"] : []), "--", removal.path],
      { cwd: root, allowFailure: true },
    );
    if (result.exitCode !== 0) {
      await restoreTrackedPaths(root, [...applied].reverse());
      throw new PoiesisError(
        "INSTALL_MODE_MIGRATION_UNTRACK_FAILED",
        `Poiesis could not remove ${removal.path} from the Git index without deleting it from disk`,
        { path: removal.path, stderr: result.stderr, restored: applied.map((entry) => entry.path) },
      );
    }
    applied.push(removal);
  }
}

/**
 * Put index entries back EXACTLY as Git recorded them.
 *
 * `--cacheinfo` restores the recorded mode and blob id and never touches the
 * worktree, so a rolled-back migration leaves both the index and the files
 * exactly as the Author's repository had them.
 */
export async function restoreTrackedPaths(
  root: string,
  entries: readonly MigrationUntrack[],
): Promise<void> {
  // Reverse order, and per INDEX ENTRY rather than per artifact: a skill
  // directory removal deletes one entry per tracked file inside it, and only the
  // recorded mode + blob id restore each of them exactly.
  for (const removal of [...entries].reverse()) {
    for (const entry of [...removal.entries].reverse()) {
      const result = await run(
        "git",
        ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.object},${entry.path}`],
        { cwd: root, allowFailure: true },
      );
      if (result.exitCode !== 0) {
        throw new PoiesisError(
          "ROLLBACK_INCOMPLETE",
          `Poiesis could not restore the Git index entry for ${entry.path}`,
          { path: entry.path, artifact: removal.path, stderr: result.stderr },
        );
      }
    }
  }
}
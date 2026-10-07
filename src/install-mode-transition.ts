/**
 * Spec #190 / ticket #193 — the explicit Private <-> Team transition.
 *
 * Tickets #191 and #192 gave Poiesis two modes and the ONE managed
 * `.gitignore` block that states them. What neither could settle is what
 * happens to an installation that already EXISTS when the Author changes
 * their mind, which is the ordinary case: the sharing decision is made once
 * and then revised.
 *
 * This module is the whole answer, and it is deliberately narrow:
 *
 *  1. **A transition is explicit.** It is requested by stating a different
 *     `mode` in the config an operator hands to `poiesis update --config`.
 *     Nothing here infers a mode, and nothing here runs as a side effect of
 *     an ordinary `update` — a reconcile must never re-decide a sharing
 *     policy the Author already chose.
 *
 *  2. **It touches only what the manifest can attribute.** Every line the
 *     transitioned block states is derived from `manifest.files`,
 *     `manifest.skills`, `manifest.generatedScripts`, and the recorded
 *     `ignoreBlock` record. That is what makes "existing skills and foreign
 *     files are never broadly ignored, claimed, or removed" mechanical: a
 *     path Poiesis cannot attribute has no route into the policy at all, so
 *     a mode change cannot widen the ignore list over Author content the way
 *     a caller-supplied list could.
 *
 *  3. **Only an UNCHANGED policy may be relabelled.** The block is Poiesis's
 *     own, but an Author who edited inside it has expressed something Poiesis
 *     no longer recognises. Relabelling would rewrite their edit under a
 *     label they never chose, so an edited, missing, relabelled, duplicated,
 *     or malformed block fails closed instead — always naming the path that
 *     is wrong.
 *
 *  4. **Bytes outside the block are untouchable.** The transition splices a
 *     freshly rendered block over the recorded one and leaves every other
 *     byte of `.gitignore` — the Author's own rules above it, below it, and
 *     the file's trailing newline — exactly as it was.
 *
 *  5. **The shared profile is Author content, not Poiesis ownership.**
 *     Going private -> team CREATES the profile files when they are absent
 *     and ADOPTS them untouched when they are already committed. Going
 *     team -> private removes nothing: the profile was never a manifest
 *     record, so it was never Poiesis's to delete.
 *
 * Every function here is read-only. The caller owns the writes, the journal,
 * and the rollback, so this module cannot become a second transaction.
 */
import { lstat, mkdir, readFile, rmdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
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
import {
  TEAM_PROFILE_CONFIG_PATH,
  TEAM_PROFILE_SKILLS_LOCK_PATH,
  assertTeamProfileAdoptable,
  assertTeamProfilePortable,
  readTeamProfileConfig,
  renderTeamSkillsLock,
  teamProfileConfig,
} from "./team-profile.js";

/** Where the installed sharing mode lives, for a path-specific refusal. */
const MANIFEST_RELATIVE_PATH = ".poiesis/manifest.json";

/**
 * A project-relative path is safe to touch only when no parent on the way to
 * it is a symlink.
 *
 * Local rather than imported so this module stays free of a `maintenance.ts`
 * edge: `update-config-internal.ts` imports it, and that module deliberately
 * reaches maintenance helpers through a delayed dynamic import. A symlinked
 * parent would let a transition write through a link to somewhere outside
 * the repository, which is the one shape a byte-preserving rewrite must never
 * have.
 */
async function assertNoSymlinkedParents(root: string, destination: string): Promise<void> {
  const parts = relative(root, destination).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const details = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (details === undefined) continue;
    if (details.isSymbolicLink()) {
      throw new PoiesisError("UNSAFE_MANAGED_PATH", "Refusing to traverse a symlinked managed parent", {
        path: relative(root, current),
      });
    }
  }
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

/**
 * Spec #190 / ticket #193 — the sharing classification a transition publishes,
 * derived ONLY from what the manifest attributes to this installation.
 *
 * This is the same closed classification `init` writes, reconstructed from
 * recorded provenance instead of from what a run happens to have done:
 *
 *   - the OpenCode config is named only when the manifest carries a
 *     `files` record for it. A config the Author already had is owned
 *     through `configPatches` alone and therefore has no record, so it stays
 *     outside the policy — across a transition exactly as across an install;
 *   - delivery scripts come from `generatedScripts`, never from a scan;
 *   - skills come from `skills` and exclude every `preexisting` entry,
 *     because a skill directory the Author had is theirs.
 *
 * There is deliberately no "and anything else that looks like Poiesis"
 * fallback. A path that is not attributable does not enter the block.
 *
 * Module-local on purpose: the classification is only ever consumed as part of
 * a plan, and a separately callable classifier would let a caller build an
 * ignore policy from a manifest without the block, block-identity, and
 * portability checks `planInstallModeTransition` performs first.
 */
function managedIgnoreContextFromManifest(args: {
  manifest: Manifest;
  generatedAgentPaths: readonly string[];
}): ManagedIgnoreContext {
  const { manifest } = args;
  const managedOpenCodeConfig = new Set(
    manifest.configPatches.map((patch) => patch.file),
  );
  const createdOpenCodeConfigPath = manifest.files.find(
    (file) =>
      file.provenance === "config" &&
      !file.path.startsWith(".poiesis/") &&
      managedOpenCodeConfig.has(file.path),
  )?.path;
  return {
    // `ManagedIgnoreContext` carries a mode because the block it produces must
    // name one. This value is a placeholder: `planInstallModeTransition`
    // overrides it with the requested mode before rendering, so the mode that
    // actually reaches the file is never inferred from the manifest.
    mode: manifest.mode ?? "private",
    generatedAgentPaths: args.generatedAgentPaths,
    createdOpenCodeConfigPath,
    generatedDeliveryScripts: (manifest.generatedScripts ?? []).map((record) => record.path),
    installedSkillPaths: manifest.skills
      .filter((skill) => !skill.preexisting)
      .map((skill) => skill.path),
  };
}

/** One shared profile file a transition would create because it is absent. */
export interface TransitionProfileFile {
  /** Project-relative path. */
  path: string;
  /** Exact bytes the transaction writes. */
  content: string;
}

export interface InstallModeTransitionPlan {
  /** The mode the installation is leaving. */
  from: InstallMode;
  /** The mode the Author explicitly asked for. */
  to: InstallMode;
  /**
   * `sha256` of the exact `.gitignore` bytes this plan was rendered from.
   *
   * The plan is a statement about one specific file. `assertTransitionCaptureIdentity`
   * binds it to the bytes the transaction's journal actually captured, so a
   * file that changed between planning and capturing can never be rewritten
   * from a plan computed against content that no longer exists.
   */
  observedGitignoreHash: string;
  /** `.gitignore` exactly as it will be after the transition. */
  gitignoreContent: string;
  /** The one managed block exactly as it will be after the transition. */
  block: ManagedIgnoreBlock;
  /** The manifest `ignoreBlock` record the transition installs. */
  record: IgnoreBlockRecord;
  /** Shared profile files to CREATE (they are absent right now). */
  createProfileFiles: TransitionProfileFile[];
  /** Shared profile files ADOPTED untouched, for reporting. */
  adoptProfileFiles: string[];
}

function unsupported(message: string, details: Record<string, unknown>): PoiesisError {
  return new PoiesisError("INSTALL_MODE_TRANSITION_UNSUPPORTED", message, details);
}

/**
 * Plan one explicit `Private <-> Team` transition. Read-only: it inspects the
 * `.gitignore` block and, when the target mode is `team`, the shared profile,
 * and returns exactly what the caller must write. Every refusal is raised
 * here, before the caller's first write, and every refusal names the path
 * that is wrong.
 */
export async function planInstallModeTransition(args: {
  root: string;
  manifest: Manifest;
  /** The mode the Author explicitly asked for. */
  to: InstallMode;
  /** The configuration this transition is publishing, defaults already resolved. */
  resolvedConfig: ResolvedPoiesisConfig;
  /** Generated OpenCode agent projections, from the template table. */
  generatedAgentPaths: readonly string[];
}): Promise<InstallModeTransitionPlan> {
  const record = args.manifest.ignoreBlock;
  const from = args.manifest.mode;
  // A pre-Spec #190 installation records neither a mode nor a block. Relabelling
  // one into existence would be a migration, which is a different decision with
  // different consequences — so this refuses and names what is missing.
  if (from === undefined || record === undefined) {
    throw unsupported(
      "This Poiesis installation records no sharing mode, so its mode cannot be transitioned; re-install it with `poiesis init` and choose private or team",
      { path: MANIFEST_RELATIVE_PATH, mode: from ?? null, ignoreBlock: record === undefined ? null : record.path },
    );
  }
  if (record.path !== GITIGNORE_RELATIVE_PATH) {
    throw unsupported("The recorded Poiesis ignore block is not `.gitignore`", {
      path: record.path,
      mode: from,
    });
  }

  const gitignorePath = join(args.root, GITIGNORE_RELATIVE_PATH);
  await assertNoSymlinkedParents(args.root, gitignorePath);
  if (!(await pathEntryExists(gitignorePath))) {
    throw unsupported("The Poiesis-managed ignore block is missing, so the sharing mode cannot be transitioned", {
      path: GITIGNORE_RELATIVE_PATH,
      mode: from,
    });
  }
  const details = await lstat(gitignorePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore path is not a regular file", {
      path: GITIGNORE_RELATIVE_PATH,
    });
  }
  const bytes = await readFile(gitignorePath);
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore is not valid UTF-8", {
      path: GITIGNORE_RELATIVE_PATH,
    });
  }
  const content = bytes.toString("utf8");
  // Malformed and duplicated blocks are refused here by the shared parser,
  // which already raises `GITIGNORE_BLOCK_MALFORMED` /
  // `GITIGNORE_BLOCK_DUPLICATE` with `.gitignore` as the named path.
  const [block] = parseManagedIgnoreBlocks(content);
  if (block === undefined) {
    throw unsupported("`.gitignore` states no Poiesis-managed ignore block", {
      path: GITIGNORE_RELATIVE_PATH,
      mode: from,
    });
  }
  if (block.mode !== from) {
    throw new PoiesisError(
      "INSTALL_MODE_BLOCK_LABEL_CONFLICT",
      `The Poiesis ignore block is labelled mode="${block.mode}" but the manifest records mode="${from}"`,
      { path: GITIGNORE_RELATIVE_PATH, recorded: from, labelled: block.mode },
    );
  }
  if (block.hash !== record.hash) {
    throw new PoiesisError(
      "INSTALL_MODE_BLOCK_EDITED",
      "The Poiesis-managed ignore block changed after it was installed; repair or revert it before changing the sharing mode",
      { path: GITIGNORE_RELATIVE_PATH, mode: from, expected: record.hash, actual: block.hash },
    );
  }

  // Render the transitioned block from the manifest-attributable
  // classification, then splice it over the recorded block. Everything
  // outside `[startIndex, endIndex]` — the Author's own rules and the file's
  // trailing newline — is carried through untouched.
  const body = managedIgnoreBlockLines({
    ...managedIgnoreContextFromManifest({ manifest: args.manifest, generatedAgentPaths: args.generatedAgentPaths }),
    mode: args.to,
  });
  const rendered = renderManagedIgnoreBlock(args.to, body);
  const replacement = (rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered).split("\n");
  const lines = content.split("\n");
  lines.splice(block.startIndex, block.endIndex - block.startIndex + 1, ...replacement);
  const gitignoreContent = lines.join("\n");
  const [nextBlock] = parseManagedIgnoreBlocks(gitignoreContent);
  if (nextBlock === undefined || nextBlock.mode !== args.to) {
    throw unsupported("Poiesis could not state the requested sharing mode in its ignore block", {
      path: GITIGNORE_RELATIVE_PATH,
      mode: args.to,
    });
  }

  const createProfileFiles: TransitionProfileFile[] = [];
  const adoptProfileFiles: string[] = [];
  if (args.to === "team") {
    // The profile is committed to a team repository, so it is validated
    // BEFORE anything is written: a machine path or a credential in the
    // resolved policy is refused while the repository is still untouched.
    const wanted = teamProfileConfig(args.resolvedConfig);
    assertTeamProfilePortable(wanted, "shared Poiesis profile");

    const configAbsolute = join(args.root, TEAM_PROFILE_CONFIG_PATH);
    await assertNoSymlinkedParents(args.root, configAbsolute);
    // `readTeamProfileConfig` raises `TEAM_PROFILE_UNSAFE` for anything that
    // is not a regular file, so a symlinked profile fails closed by name
    // rather than being adopted or replaced.
    const adopted = await readTeamProfileConfig(args.root);
    if (adopted === null) {
      createProfileFiles.push({ path: TEAM_PROFILE_CONFIG_PATH, content: serializeConfig(wanted) });
    } else {
      // Adoption is SEMANTIC. `config.jsonc` is hand-editable JSONC, so a
      // comment, reordered keys, or different formatting is a legal
      // difference; a profile that actually states a different
      // configuration is a contradiction and is refused untouched.
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
      // unconditionally: revision drift is legitimate team state that
      // `doctor` reports, never something a transition rewrites.
      adoptProfileFiles.push(TEAM_PROFILE_SKILLS_LOCK_PATH);
    }
  }

  return {
    from,
    to: args.to,
    observedGitignoreHash: hashContent(content),
    gitignoreContent,
    block: nextBlock,
    // `fileCreated` records whether THIS installation created `.gitignore`,
    // and a transition never creates or deletes the file itself — so the
    // original fact rides through unchanged and `uninstall` keeps deciding
    // whether to remove a now-empty file on the same grounds it did before.
    record: {
      path: GITIGNORE_RELATIVE_PATH,
      mode: args.to,
      patterns: [...nextBlock.patterns],
      hash: nextBlock.hash,
      fileCreated: record.fileCreated,
      owned: true,
    },
    createProfileFiles,
    adoptProfileFiles,
  };
}

/**
 * Bind a plan to the bytes the transaction's bounded journal actually captured.
 *
 * Both checks exist because planning and capturing are separate observations,
 * and a transition may only act on the state it planned against:
 *
 *   - `.gitignore` must still be the exact content the plan rendered from.
 *     Writing a splice computed against a stale file would delete whatever
 *     replaced it.
 *   - a shared profile the plan decided to CREATE must still be absent. If it
 *     appeared in between, the "adopt only when exactly compatible" decision
 *     was made about content that is no longer there, and creating over it
 *     would overwrite Author-committed project intelligence — the one thing
 *     Spec #190 forbids this surface from ever doing.
 *
 * Pure and synchronous so the invariant is directly testable, and raised
 * `ARTIFACT_IDENTITY_DRIFT` naming the offending path, which is the same code
 * and shape the journal's own pre-write identity guard uses.
 */
export function assertTransitionCaptureIdentity(
  plan: InstallModeTransitionPlan,
  captured: {
    /** Preimage the journal captured for `.gitignore`, or `undefined` when absent. */
    gitignorePreimage: Buffer | undefined;
    /** What the journal captured for each profile file the plan would create. */
    profileCaptures: ReadonlyArray<{ path: string; physicalExists: boolean }>;
  },
): void {
  if (captured.gitignorePreimage === undefined || hashContent(captured.gitignorePreimage) !== plan.observedGitignoreHash) {
    throw new PoiesisError(
      "ARTIFACT_IDENTITY_DRIFT",
      "Git ignore changed while planning the Poiesis installation-mode transition",
      { path: GITIGNORE_RELATIVE_PATH },
    );
  }
  for (const capture of captured.profileCaptures) {
    if (capture.physicalExists) {
      throw new PoiesisError(
        "ARTIFACT_IDENTITY_DRIFT",
        "The shared Poiesis profile appeared while planning the installation-mode transition",
        { path: capture.path },
      );
    }
  }
}

/**
 * Create the parent directories a transition's profile writes need, returning
 * the project-relative paths it actually created.
 * The journal owns file preimages, not directories, so the caller needs the
 * list to be able to undo an empty directory the failed run left behind.
 * `init` solves the same problem with its own `createdInitDirectories` set;
 * this is the transition's equivalent rather than a second convention.
 */
export async function ensureTransitionProfileParents(root: string): Promise<string[]> {
  const created: string[] = [];
  const missing: string[] = [];
  let current = root;
  for (const part of TEAM_PROFILE_CONFIG_PATH.split("/").slice(0, -1)) {
    current = join(current, part);
    if (!(await pathEntryExists(current))) {
      missing.push(relative(root, current));
      continue;
    }
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new PoiesisError("UNSAFE_MANAGED_PATH", "Refusing to traverse a non-directory managed parent", {
        path: relative(root, current),
      });
    }
  }
  // Shallow first: an intermediate directory has to exist before its child.
  for (const path of missing) {
    await mkdir(join(root, path), { recursive: true });
    created.push(path);
  }
  return created;
}

/**
 * Remove the directories a failed transition created, deepest first, and only
 * while they are still empty.
 *
 * A directory the Author or a later step put content into is left alone, so a
 * rollback can never delete real project structure on the strength of a
 * bookkeeping list.
 */
export async function removeEmptyTransitionDirectories(
  root: string,
  created: readonly string[],
): Promise<void> {
  for (const path of [...created].sort((left, right) => right.split("/").length - left.split("/").length)) {
    try {
      await rmdir(join(root, path));
    } catch {
      // Only an empty directory this run created is safe to remove.
    }
  }
}
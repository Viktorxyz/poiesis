/**
 * Spec #190 — the installation mode and the ONE managed
 * `.gitignore` block that expresses it.
 *
 * Two facts live here and nowhere else:
 *
 *  1. **The mode.** `private` (this clone only) or `team` (this clone plus
 *     a shareable project profile, ticket #192). The mode is never
 *     inferred: `init` requires an explicit answer, interactively or in
 *     `--config`, because choosing a sharing policy on the Author's
 *     behalf is exactly the thing this Spec exists to prevent.
 *
 *  2. **The block.** Poiesis manages exactly ONE uniquely delimited,
 *     mode-labelled `.gitignore` block. It is visible, reviewable, and it
 *     is the only Poiesis surface Git is ever meant to see. Everything
 *     else Poiesis owns is hidden behind it.
 *
 * Sharing works by what the block does NOT hide, never by widening it: the
 * team profile sits outside every path this block names, so the same
 * closed classification serves both modes and the policy can never grow
 * over user content because a mode changed.
 *
 * The block is deliberately NOT a loose append of whatever rules each
 * caller happens to want. A loose append cannot answer "did I insert
 * this?" and therefore cannot be reversed, cannot detect a second block,
 * and cannot tell a foreign edit from its own. Delimiters make all three
 * mechanical: anything that is not one well-formed block fails closed
 * with a typed error instead of silently merging into a policy the Author
 * did not write.
 *
 * There is no `.git/info/exclude` fallback here and no hidden activation
 * of any kind. If the block cannot be written, the installation does not
 * pretend it succeeded.
 */
import { join } from "node:path";
import { PoiesisError } from "./errors.js";
import { exists, readUtf8 } from "./fs.js";
import { hashContent } from "./hash.js";
import type { IgnoreBlockRecord } from "./manifest.js";
import { TEAM_PROFILE_DIRECTORY } from "./team-profile.js";

/** Spec #190 — the installation modes Poiesis can express. */
export const INSTALL_MODES = ["private", "team"] as const;

export type InstallMode = (typeof INSTALL_MODES)[number];

export function isInstallMode(value: unknown): value is InstallMode {
  return typeof value === "string" && (INSTALL_MODES as readonly string[]).includes(value);
}

/**
 * The modes `init` can actually install today.
 *
 * Both are installable. `team` additionally writes the shareable project
 * profile (ticket #192) and therefore validates its portability before any
 * byte is written; it never widens the ignore policy over user content.
 *
 * Deliberately NOT a type predicate: narrowing `InstallMode` here would
 * make every downstream `mode === "team"` branch unreachable to the
 * compiler, which is exactly the mistake this list exists to prevent.
 */
export const INSTALLABLE_MODES: readonly InstallMode[] = ["private", "team"];

export function isInstallableMode(mode: InstallMode): boolean {
  return INSTALLABLE_MODES.includes(mode);
}

/**
 * Fail-closed mode parse for machine-supplied configuration.
 *
 * An absent mode is NOT a default. `init` calls this with the value the
 * Author actually gave, so a config that omits it fails here rather than
 * silently installing private or team.
 */
export function parseInstallMode(value: unknown, source: string): InstallMode {
  if (isInstallMode(value)) return value;
  throw new PoiesisError(
    "INVALID_INSTALL_MODE",
    `Poiesis installation mode is missing or unsupported in ${source}; choose private or team explicitly`,
    {
      source,
      mode: value === undefined ? null : value,
      supported: [...INSTALL_MODES],
    },
  );
}

/**
 * Product wording aliases for the guided prompt. The Author is asked for
 * "Private/local" or "Team/shared"; the machine value stays the terse
 * `private` / `team` the rest of the runtime uses.
 */
const MODE_ALIASES: Readonly<Record<string, InstallMode>> = {
  private: "private",
  local: "private",
  team: "team",
  shared: "team",
};

/** Fail-closed mode parse for a human answer at the guided prompt. */
export function parseInstallModeAnswer(answer: string, source: string): InstallMode {
  const normalized = answer.trim().toLowerCase();
  const mode = Object.hasOwn(MODE_ALIASES, normalized) ? MODE_ALIASES[normalized] : undefined;
  if (mode === undefined) {
    throw new PoiesisError(
      "INVALID_INSTALL_MODE",
      `Unsupported Poiesis installation mode; expected private/local or team/shared`,
      { source, answer: normalized, supported: [...INSTALL_MODES] },
    );
  }
  return mode;
}

/** Repo-relative name of the visible ignore policy. */
export const GITIGNORE_RELATIVE_PATH = ".gitignore";

/**
 * The one token that identifies the managed block. Every delimiter line
 * carries it, so a truncated / hand-mangled block is recognised as a
 * malformed Poiesis block rather than as ordinary user text.
 */
export const IGNORE_BLOCK_TOKEN = "poiesis-managed-ignore";

const IGNORE_BLOCK_START_PATTERN = /^#\s*>>>\s*poiesis-managed-ignore\s+mode=([A-Za-z][A-Za-z0-9-]*)\s*>>>\s*$/;
const IGNORE_BLOCK_END_PATTERN = /^#\s*<<<\s*poiesis-managed-ignore\s+mode=([A-Za-z][A-Za-z0-9-]*)\s*<<<\s*$/;

/** Canonical opening delimiter for a mode. */
export function ignoreBlockStartLabel(mode: InstallMode): string {
  return `# >>> ${IGNORE_BLOCK_TOKEN} mode=${mode} >>>`;
}

/** Canonical closing delimiter for a mode. */
export function ignoreBlockEndLabel(mode: InstallMode): string {
  return `# <<< ${IGNORE_BLOCK_TOKEN} mode=${mode} <<<`;
}

/**
 * The fixed explanation carried inside every block. It is part of the
 * block text and therefore part of the block hash, so `uninstall` can
 * tell an untouched block from an edited one.
 */
const IGNORE_BLOCK_HEADER: readonly string[] = [
  "# Poiesis-managed ignore policy.",
  "# Every line inside this block is inserted by `poiesis init` and removed by",
  "# `poiesis uninstall` while it is unchanged. Edit outside the block, or",
  "# uninstall will preserve the block and report it instead of removing it.",
];

function malformed(reason: string): PoiesisError {
  return new PoiesisError(
    "GITIGNORE_BLOCK_MALFORMED",
    `The Poiesis-managed ignore block is malformed; repair or remove it before installing (${reason})`,
    { path: GITIGNORE_RELATIVE_PATH, reason },
  );
}

export interface ManagedIgnoreBlock {
  mode: InstallMode;
  /** Zero-based index of the opening delimiter line. */
  startIndex: number;
  /** Zero-based index of the closing delimiter line. */
  endIndex: number;
  /** Body lines between the delimiters, comments included. */
  body: readonly string[];
  /** Effective ignore patterns: non-blank, non-comment body lines. */
  patterns: readonly string[];
  /** Exact block text, opening delimiter through closing delimiter's newline. */
  text: string;
  /** `sha256` of `text` — the exact-block ownership identity. */
  hash: string;
}

function blockFromLines(lines: readonly string[], startIndex: number, endIndex: number, mode: InstallMode): ManagedIgnoreBlock {
  const body = lines.slice(startIndex + 1, endIndex);
  const text = `${lines.slice(startIndex, endIndex + 1).join("\n")}\n`;
  return {
    mode,
    startIndex,
    endIndex,
    body,
    patterns: body.filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    }),
    text,
    hash: hashContent(text),
  };
}

/**
 * Parse every Poiesis-managed block out of a `.gitignore`.
 *
 * Fail-closed on purpose. A nested block, an orphan delimiter, a start
 * and end that disagree about the mode, an unterminated block, or a
 * delimiter line that merely mentions the token are all refused: each one
 * means the file no longer states one unambiguous policy, and rewriting
 * it anyway would either silently drop rules the Author depends on or
 * claim a block Poiesis cannot identify. More than one block is a
 * `GITIGNORE_BLOCK_DUPLICATE` — Poiesis owns exactly one.
 *
 * Returns at most one element; the array shape keeps the "duplicate is a
 * distinct condition" rule explicit at every call site.
 */
export function parseManagedIgnoreBlocks(content: string): ManagedIgnoreBlock[] {
  const lines = content.split("\n");
  const blocks: ManagedIgnoreBlock[] = [];
  let open: { mode: InstallMode; startIndex: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.includes(IGNORE_BLOCK_TOKEN)) continue;
    const start = IGNORE_BLOCK_START_PATTERN.exec(line);
    if (start !== null) {
      if (open !== undefined) throw malformed("a block starts before the previous one closed");
      const mode = start[1]!;
      if (!isInstallMode(mode)) throw malformed(`unknown block mode "${mode}"`);
      open = { mode, startIndex: index };
      continue;
    }
    const end = IGNORE_BLOCK_END_PATTERN.exec(line);
    if (end !== null) {
      if (open === undefined) throw malformed("a block ends before it starts");
      const endMode = end[1]!;
      if (!isInstallMode(endMode)) throw malformed(`unknown block mode "${endMode}"`);
      if (endMode !== open.mode) {
        throw malformed(`block starts as mode="${open.mode}" and ends as mode="${endMode}"`);
      }
      blocks.push(blockFromLines(lines, open.startIndex, index, open.mode));
      open = undefined;
      continue;
    }
    throw malformed("a line mentions the Poiesis block marker but is not a delimiter");
  }
  if (open !== undefined) throw malformed("a block is never closed");
  if (blocks.length > 1) {
    throw new PoiesisError(
      "GITIGNORE_BLOCK_DUPLICATE",
      "More than one Poiesis-managed ignore block is present; Poiesis owns exactly one",
      { path: GITIGNORE_RELATIVE_PATH, blocks: blocks.length },
    );
  }
  return blocks;
}

/** Render a fresh block, delimiters and header included. */
export function renderManagedIgnoreBlock(mode: InstallMode, lines: readonly string[]): string {
  return [
    ignoreBlockStartLabel(mode),
    ...IGNORE_BLOCK_HEADER,
    ...lines,
    ignoreBlockEndLabel(mode),
    "",
  ].join("\n");
}

export interface ManagedIgnorePlan {
  /** `true` when the plan changes the file at all. */
  changed: boolean;
  /** Post-write content, or `null` when nothing changes. */
  content: string | null;
  /** The block as it will exist after the plan is applied. */
  block: ManagedIgnoreBlock | null;
  /** Whether `.gitignore` already existed before the plan. */
  fileExisted: boolean;
}

/**
 * The single computation behind every `.gitignore` write.
 *
 * Idempotent by construction: a line already present inside the block is
 * never added twice, and an already-correct block yields
 * `changed: false` with no content at all, so a caller can leave the file
 * untouched rather than rewriting identical bytes.
 *
 * Ownership-aware: an existing block whose label names a DIFFERENT mode
 * than the one being installed is a `GITIGNORE_BLOCK_CONFLICT` rather
 * than a silent relabel, because relabelling would misdescribe the
 * policy the Author is looking at.
 */
export function planManagedIgnoreBlock(args: {
  /** Current `.gitignore` content, or `null` when the file is absent. */
  existing: string | null;
  mode: InstallMode;
  lines: readonly string[];
}): ManagedIgnorePlan {
  const fileExisted = args.existing !== null;
  const existing = args.existing ?? "";
  const [existingBlock] = parseManagedIgnoreBlocks(existing);
  if (existingBlock !== undefined && existingBlock.mode !== args.mode) {
    throw new PoiesisError(
      "GITIGNORE_BLOCK_CONFLICT",
      `The existing Poiesis ignore block is labelled mode="${existingBlock.mode}"; refusing to relabel it as mode="${args.mode}"`,
      { path: GITIGNORE_RELATIVE_PATH, installed: existingBlock.mode, requested: args.mode },
    );
  }
  const wanted = args.lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (existingBlock !== undefined) {
    const present = new Set(existingBlock.body.map((line) => line.trim()));
    const additions = wanted.filter((line) => !present.has(line));
    if (additions.length === 0) {
      return { changed: false, content: null, block: existingBlock, fileExisted };
    }
    const lines = existing.split("\n");
    lines.splice(existingBlock.endIndex, 0, ...additions);
    const content = lines.join("\n");
    const [block] = parseManagedIgnoreBlocks(content);
    return { changed: true, content, block: block ?? null, fileExisted };
  }
  const content = existing.length === 0
    ? renderManagedIgnoreBlock(args.mode, wanted)
    : `${existing.replace(/\n*$/, "\n")}${renderManagedIgnoreBlock(args.mode, wanted)}`;
  const [block] = parseManagedIgnoreBlocks(content);
  return { changed: true, content, block: block ?? null, fileExisted };
}

export interface ManagedIgnoreRemoval {
  /** `true` only when this call reverses the recorded block. */
  removed: boolean;
  /** Post-removal content, or `null` when the whole file must go. */
  content: string | null;
  /** The block that was inspected, for reporting. */
  block: ManagedIgnoreBlock | null;
}

/**
 * Reverse exactly the block this installation recorded, and nothing else.
 *
 * "Unchanged" is the exact-block hash the manifest recorded. A block that
 * is missing, relabelled, or edited is reported (`removed: false`) and
 * left byte-for-byte alone: the Author edited it, and a deletion would
 * destroy their edit on the strength of a hash Poiesis no longer
 * recognises.
 *
 * When the block was the entire file Poiesis created, removing it removes
 * the file too. A `.gitignore` the Author already had keeps whatever else
 * it says.
 */
export function planManagedIgnoreBlockRemoval(args: {
  existing: string | null;
  mode: InstallMode;
  /** `hash` recorded in the manifest for the block this installation inserted. */
  hash: string;
  /** Whether Poiesis created the `.gitignore` file itself. */
  fileCreated: boolean;
}): ManagedIgnoreRemoval {
  if (args.existing === null) return { removed: false, content: null, block: null };
  const [block] = parseManagedIgnoreBlocks(args.existing);
  if (block === undefined) return { removed: false, content: args.existing, block: null };
  if (block.mode !== args.mode) {
    throw new PoiesisError(
      "GITIGNORE_BLOCK_CONFLICT",
      `The Poiesis ignore block is labelled mode="${block.mode}", not the installed mode="${args.mode}"`,
      { path: GITIGNORE_RELATIVE_PATH, installed: args.mode, found: block.mode },
    );
  }
  if (block.hash !== args.hash) {
    return { removed: false, content: args.existing, block };
  }
  const lines = args.existing.split("\n");
  lines.splice(block.startIndex, block.endIndex - block.startIndex + 1);
  // Drop the single blank separator the append introduced, so a file that
  // existed before the block comes back exactly as it was.
  if (block.startIndex > 0 && lines[block.startIndex - 1]?.trim() === "") {
    lines.splice(block.startIndex - 1, 1);
  }
  const remaining = lines.join("\n");
  if (remaining.trim().length === 0 && args.fileCreated) {
    return { removed: true, content: null, block };
  }
  return { removed: true, content: remaining, block };
}

/**
 * Re-read the recorded block ownership after a transaction has reconciled
 * the block.
 *
 * The receipt-bearing update / bootstrap transactions merge their one
 * extra rule INTO the existing block. That is Poiesis editing its own
 * block, not the Author editing it, so the recorded identity has to move
 * with it — otherwise `uninstall` would later see a hash it no longer
 * recognises and preserve a block Poiesis itself had just written.
 *
 * Fail-safe by construction: an unreadable, missing, relabelled, or
 * malformed block leaves the previous record untouched rather than
 * inventing one, so a genuinely foreign edit still surfaces at uninstall.
 */
export async function refreshIgnoreBlockRecord(
  root: string,
  current: IgnoreBlockRecord | undefined,
): Promise<IgnoreBlockRecord | undefined> {
  if (current === undefined) return undefined;
  const path = join(root, current.path);
  if (!(await exists(path))) return current;
  const [block] = parseManagedIgnoreBlocks(await readUtf8(path));
  if (block === undefined || block.mode !== current.mode) return current;
  return { ...current, patterns: [...block.patterns], hash: block.hash };
}

/** Project-relative facts the managed ignore classification needs. */
export interface ManagedIgnoreContext {
  /** The sharing mode this block states. */
  mode: InstallMode;
  /** Generated OpenCode agent projections this installation owns. */
  generatedAgentPaths: readonly string[];
  /**
   * The OpenCode config path, but ONLY when this installation created it.
   * A config the Author already had is user-owned and is never claimed,
   * ignored, or removed on their behalf.
   */
  createdOpenCodeConfigPath: string | undefined;
  /** Delivery scripts this installation generated. */
  generatedDeliveryScripts: readonly string[];
  /** Installed default skills. Preexisting skills are deliberately absent. */
  installedSkillPaths: readonly string[];
}

/**
 * Spec #190: the ONE managed block. Every Poiesis-owned artifact stays
 * ignored in BOTH modes, so the classification below is mode-independent by
 * construction — sharing policy changes what Poiesis WRITES outside the
 * ignore list, never what it hides inside it.
 *
 * The classification is explicit and closed. Nothing here is a wildcard
 * over user content:
 *
 *   - `.poiesis/` is Poiesis's own root. `init` already refuses to install
 *     over an unowned `.poiesis` path, so nothing under it is user data.
 *   - the generated OpenCode agent projections are listed one by one from
 *     the template table, never as a `.opencode/` wildcard, because
 *     `.opencode/` belongs to the Author.
 *   - the OpenCode config is ignored ONLY when Poiesis created it.
 *   - delivery scripts and installed skills are listed only when this
 *     installation generated / installed them. A preexisting skill
 *     directory is never broadly ignored, because the Author owns it.
 */
export function managedIgnoreBlockLines(context: ManagedIgnoreContext): string[] {
  return [
    "# Poiesis canon, config, manifest, receipts, runtime state, caches, workspaces, locks, and logs.",
    ".poiesis/",
    // The default-path workspace area is ALSO named on its own line, even though
    // `.poiesis/` already covers it. The receipt-bearing update / bootstrap
    // transactions reconcile exactly this one rule, and a block that already
    // states it makes that reconcile a genuine no-op — so a same-version
    // `update` does not rewrite the block, change its hash, and leave uninstall
    // holding an identity Poiesis itself invalidated.
    ".poiesis/workspaces/",
    // The Repository Intelligence cache is named for the same reason, and the
    // Spec #120 contract depends on the cache being ignored BY NAME: an
    // uninstall that reads the policy must be able to see which Poiesis-owned
    // local-state roots exist without re-deriving them from the block body.
    ".poiesis/cache/",
    ...teamProfilePolicyLines(context.mode),
    "# Generated OpenCode agent projections. Ordinary `opencode` discovers them on disk,",
    "# which is exactly why a Poiesis installation keeps them untracked.",
    ...context.generatedAgentPaths,
    ...(context.createdOpenCodeConfigPath === undefined ? [] : [context.createdOpenCodeConfigPath]),
    "# Delivery scripts this installation generated.",
    ...context.generatedDeliveryScripts,
    ...(context.installedSkillPaths.length === 0
      ? []
      : ["# Skills this installation installed. Preexisting skills stay the Author's own.", ...context.installedSkillPaths]),
  ];
}

/**
 * Spec #190 / ticket #192 — the one difference the sharing MODE makes inside
 * the block, and it is a statement rather than a rule.
 *
 * In `team` mode the profile is committed on purpose, so the block says so.
 * That is not decoration: a reviewer reading `.gitignore` has to be able to
 * tell "Poiesis ignores everything of mine" from "Poiesis ignores everything
 * of mine except this directory, on purpose". A rule cannot express the
 * exception because Git needs none — the profile simply is never named — so
 * the block states the omission instead of manufacturing a negation that
 * would silently start depending on Git's parent-directory semantics.
 */
function teamProfilePolicyLines(mode: InstallMode): string[] {
  if (mode !== "team") return [];
  return [
    `# Shareable project profile: this block deliberately does NOT ignore ${TEAM_PROFILE_DIRECTORY}/.`,
    "# That directory holds the project's declarative Poiesis intelligence (models,",
    "# repository/tracker/delivery/verification policy, locked skill selection, and",
    "# project-created instruction overrides) so a team commits it and a fresh clone",
    "# hydrates its ignored local projections from it.",
  ];
}
/**
 * Spec #207 / ticket #209 — deterministic AGENTS.md inventory and
 * path-scoped ancestor resolution.
 *
 * Inventory is mechanical coverage of eligible project folders. Semantic
 * AGENTS.md content remains Author-owned project source: Primary and Workers
 * establish and maintain it through ordinary reviewed changes. Poiesis never
 * invents domain rules from folder names and never installs or deletes
 * semantic AGENTS.md during install/update/uninstall.
 *
 * OpenCode 1.18.x native read already appends ancestor AGENTS.md files.
 * Explicit applicable-chain reads are allowed; broad instruction globs are not.
 */

import { lstat, readdir, realpath as fsRealpath } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";
import { PoiesisError } from "./errors.js";
import { exists } from "./fs.js";

/**
 * Directory **names** never entered when they appear as a path segment.
 * Does not blanket-exclude Author hidden containers such as `.agents` or
 * `.opencode` — those use path-scoped rules below.
 */
const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".poiesis",
  "node_modules",
  "vendor",
  "bower_components",
  "jspm_packages",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  ".output",
  ".vercel",
  ".tox",
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  "tmp",
  "temp",
  ".tmp",
  ".temp",
]);

/**
 * Relative path prefixes that are installed skill / generated runtime trees,
 * not Author source folders for AGENTS coverage.
 */
const EXCLUDED_RELATIVE_PREFIXES: readonly string[] = [".agents/skills"];

export interface AgentsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/**
 * lstat-style path kind for target resolution. Does not follow the final
 * symlink for the `isSymbolicLink` flag.
 */
export type AgentsLstatResult =
  | { exists: false }
  | {
      exists: true;
      isDirectory: boolean;
      isFile: boolean;
      isSymbolicLink: boolean;
    };

/**
 * Injected filesystem seam for pure tests. Production uses Node fs.
 */
export interface AgentsFs {
  readdir(path: string): Promise<AgentsDirEntry[]>;
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** True when the path resolves to a directory (follows one logical target). */
  isDirectory(path: string): Promise<boolean>;
  /** lstat-style kind; does not follow the final component's symlink. */
  lstat(path: string): Promise<AgentsLstatResult>;
}

export interface AgentsFolderRecord {
  /** Relative folder path from project root; empty string is the root. */
  path: string;
  agentsMd: "present" | "missing";
}

export interface AgentsInventoryResult {
  folders: AgentsFolderRecord[];
  /** Relative folder paths whose AGENTS.md is missing, sorted. */
  missing: string[];
}

export interface AgentsChainEntry {
  folder: string;
  agentsMdPath: string;
  status: "present" | "missing";
}

export interface AgentsResolutionResult {
  target: string;
  /** Root → leaf ancestor folders for the target path. */
  chain: AgentsChainEntry[];
  /** Present AGENTS.md paths only, root → leaf (native applicable chain). */
  applicable: string[];
}

export interface AgentsOptions {
  fs?: AgentsFs;
}

export function isAgentsExcludedDirectoryName(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name);
}

/**
 * Path-scoped exclusion: name segments plus installed-skill / runtime prefixes.
 * Author content under `.agents` and `.opencode` remains eligible except for
 * the installed skills subtree (`.agents/skills`).
 */
export function isAgentsExcludedRelativePath(relativePath: string): boolean {
  if (relativePath === "") return false;
  const segments = relativePath.split("/").filter((s) => s.length > 0);
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true;
  for (const prefix of EXCLUDED_RELATIVE_PREFIXES) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function defaultFs(): AgentsFs {
  return {
    async readdir(path: string): Promise<AgentsDirEntry[]> {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    },
    async realpath(path: string): Promise<string> {
      return fsRealpath(path);
    },
    async exists(path: string): Promise<boolean> {
      return exists(path);
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) {
          const target = await fsRealpath(path);
          const targetStats = await lstat(target);
          return targetStats.isDirectory();
        }
        return stats.isDirectory();
      } catch {
        return false;
      }
    },
    async lstat(path: string): Promise<AgentsLstatResult> {
      try {
        const stats = await lstat(path);
        return {
          exists: true,
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
          isSymbolicLink: stats.isSymbolicLink(),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
        throw error;
      }
    },
  };
}

function agentsMdRelative(folderRelative: string): string {
  return folderRelative === "" ? "AGENTS.md" : `${folderRelative}/AGENTS.md`;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const root = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  if (candidateReal === rootReal) return true;
  return candidateReal.startsWith(root);
}

/**
 * Root-relative POSIX path for a canonical absolute path under `rootReal`.
 * Returns `null` when the candidate is outside the root.
 */
function canonicalRelativePath(rootReal: string, candidateReal: string): string | null {
  if (candidateReal === rootReal) return "";
  if (!isInsideRoot(rootReal, candidateReal)) return null;
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return candidateReal.slice(rootPrefix.length).split(sep).join("/");
}

/**
 * True when any canonical ancestor of `directory` (walking up, excluding the
 * project root) is a nested separate Git repository root — `.git` as a
 * directory or gitfile. Project-root `.git` is allowed and never marks the
 * root as nested. Canonicalization failure on an intermediate hop skips that
 * hop and continues upward.
 */
async function hasNestedGitAncestor(
  fs: AgentsFs,
  directory: string,
  rootReal: string,
): Promise<boolean> {
  let current = directory;
  const seen = new Set<string>();
  while (current !== rootReal) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current === "" || current === sep) break;
    // Stop before treating the project root as a nested-repo candidate.
    let parent: string;
    try {
      const parentRaw = join(current, "..");
      parent = await fs.realpath(parentRaw).catch(() => parentRaw);
    } catch {
      break;
    }
    // Nested-repo marker on `current` itself (not root).
    if (current !== rootReal) {
      const gitMarker = join(current, ".git");
      try {
        if (await fs.exists(gitMarker)) return true;
      } catch {
        // existence probe failure — skip this hop
      }
    }
    if (parent === current) break;
    // Do not walk above rootReal.
    if (!isInsideRoot(rootReal, parent) && parent !== rootReal) break;
    if (parent === rootReal) {
      // Final check: current is a direct child of root — already checked .git above.
      break;
    }
    current = parent;
  }
  return false;
}

/**
 * Lexical exclusion plus canonical root-relative exclusion. A path is
 * ineligible when its reported relative path OR its canonical path under
 * `rootReal` matches the exclusion table (so a symlink alias into
 * `node_modules` / `.poiesis` / `.agents/skills` cannot become eligible).
 * Canonicalization failure skips the canonical check (lexical still applies).
 */
function isAgentsExcludedPath(reportRelative: string, canonicalRel: string | null): boolean {
  if (isAgentsExcludedRelativePath(reportRelative)) return true;
  if (canonicalRel !== null && isAgentsExcludedRelativePath(canonicalRel)) return true;
  return false;
}

/**
 * Deterministic inventory of every eligible project folder (including root)
 * and whether `AGENTS.md` is present.
 *
 * Skips Git internals, dependency/vendor trees, generated/build/cache trees,
 * `.poiesis`, the installed skills subtree (`.agents/skills`), and nested
 * separate repositories (including deep descendants reached via alias). Does
 * not blanket-exclude hidden Author containers (`.agents`, `.opencode`,
 * `.github`, …). Does not follow external symlinks. One traversal with a
 * visited canonical set: cycles and duplicate aliases collapse to the first
 * deterministic sorted logical representative. AGENTS.md presence shares the
 * resolver's bounded regular-file semantics (regular file or internal
 * symlink→regular present; external/dangling/cycle/directory missing).
 */
export async function inventoryAgents(root: string, options: AgentsOptions = {}): Promise<AgentsInventoryResult> {
  const fs = options.fs ?? defaultFs();
  const absoluteRoot = resolve(root);
  const rootReal = await fs.realpath(absoluteRoot).catch(() => absoluteRoot);
  const folders: AgentsFolderRecord[] = [];
  // One traversal: visited canonical realpaths (dedupe + cycles). First
  // sorted logical representative wins.
  const visitedCanonical = new Set<string>();

  /**
   * @param readDir - absolute directory to readdir (realpath for links)
   * @param reportRelative - relative path reported in the inventory (link name)
   * @param ancestorCanonical - canonical realpaths on the active descent stack
   */
  async function visit(
    readDir: string,
    reportRelative: string,
    ancestorCanonical: ReadonlySet<string>,
  ): Promise<void> {
    let canonical: string;
    try {
      canonical = await fs.realpath(readDir);
    } catch {
      // Canonicalization failure: skip this node (fail closed on eligibility).
      return;
    }

    const canonicalRel = canonicalRelativePath(rootReal, canonical);
    if (canonicalRel === null) return;
    if (isAgentsExcludedPath(reportRelative, canonicalRel)) return;

    // Cycle / already emitted via another logical path: first representative wins.
    if (ancestorCanonical.has(canonical)) return;
    if (visitedCanonical.has(canonical)) return;

    if (!(await fs.isDirectory(readDir))) return;

    // Nested separate repository ancestry (from target up, excluding root).
    if (reportRelative !== "" && (await hasNestedGitAncestor(fs, canonical, rootReal))) return;

    visitedCanonical.add(canonical);

    // Presence is evaluated on the canonical read directory so internal
    // directory aliases observe the target tree, with the same regular-file
    // semantics as the path-scoped resolver.
    const agentsMd = await agentsMdStatusAtAbsolute(fs, rootReal, join(readDir, "AGENTS.md"));
    folders.push({
      path: reportRelative,
      agentsMd,
    });

    const nextAncestors = new Set(ancestorCanonical);
    nextAncestors.add(canonical);

    let entries: AgentsDirEntry[];
    try {
      entries = await fs.readdir(readDir);
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childReport = reportRelative === "" ? entry.name : `${reportRelative}/${entry.name}`;
      if (isAgentsExcludedRelativePath(childReport)) continue;
      if (isAgentsExcludedDirectoryName(entry.name)) continue;

      const childAbs = join(readDir, entry.name);

      if (entry.isSymbolicLink) {
        let targetReal: string;
        try {
          targetReal = await fs.realpath(childAbs);
        } catch {
          // Dangling / cycle canonicalize failure — skip.
          continue;
        }
        if (!isInsideRoot(rootReal, targetReal)) continue;
        // Symlink to a regular file (or non-directory) is not an eligible folder.
        if (!(await fs.isDirectory(targetReal))) continue;
        // Ancestor / self cycle on the canonical stack.
        if (nextAncestors.has(targetReal)) continue;
        if (visitedCanonical.has(targetReal)) continue;
        const targetRel = canonicalRelativePath(rootReal, targetReal);
        if (targetRel === null || isAgentsExcludedPath(childReport, targetRel)) continue;
        if (await hasNestedGitAncestor(fs, targetReal, rootReal)) continue;
        await visit(targetReal, childReport, nextAncestors);
        continue;
      }

      if (!entry.isDirectory) continue;
      await visit(childAbs, childReport, nextAncestors);
    }
  }

  await visit(rootReal, "", new Set());

  folders.sort((a, b) => a.path.localeCompare(b.path));
  const missing = folders.filter((f) => f.agentsMd === "missing").map((f) => f.path);
  return { folders, missing };
}

/**
 * True when `candidate` is the project root or a path strictly inside it.
 * Uses the caller's already-canonical root realpath.
 */
function assertInsideProjectRoot(rootReal: string, candidateReal: string, target: string): void {
  if (!isInsideRoot(rootReal, candidateReal)) {
    throw new PoiesisError("AGENTS_PATH_OUTSIDE_ROOT", "AGENTS resolution target must stay inside the project root", {
      target,
    });
  }
}

/**
 * Bounded regular-file AGENTS.md presence at an absolute path.
 * Regular file or internal symlink→regular file → present.
 * Missing, external, dangling, cycle, or directory → missing.
 * Never surfaces an external path.
 */
async function agentsMdStatusAtAbsolute(
  fs: AgentsFs,
  rootReal: string,
  agentsAbs: string,
): Promise<"present" | "missing"> {
  const st = await fs.lstat(agentsAbs);
  if (!st.exists) return "missing";
  let agentsReal: string;
  try {
    agentsReal = await fs.realpath(agentsAbs);
  } catch {
    return "missing";
  }
  if (!isInsideRoot(rootReal, agentsReal)) {
    // External AGENTS symlink (or other escape) — exclude, never report outside path.
    return "missing";
  }
  if (st.isSymbolicLink) {
    // Resolved inside root: present when the target is a regular file.
    const targetKind = await fs.lstat(agentsReal);
    if (!targetKind.exists) return "missing";
    if (targetKind.isFile) return "present";
    if (targetKind.isDirectory) return "missing";
    return "missing";
  }
  return st.isFile ? "present" : "missing";
}

/**
 * AGENTS.md presence for a folder under root (logical relative path).
 * Inventory of a canonical read directory should call
 * {@link agentsMdStatusAtAbsolute} on `join(readDir, "AGENTS.md")` so directory
 * aliases still observe the target tree's AGENTS.md.
 */
async function agentsMdStatusInFolder(
  fs: AgentsFs,
  rootReal: string,
  absoluteRoot: string,
  folderRelative: string,
): Promise<"present" | "missing"> {
  const agentsAbs =
    folderRelative === ""
      ? join(absoluteRoot, "AGENTS.md")
      : join(absoluteRoot, ...folderRelative.split("/"), "AGENTS.md");
  return agentsMdStatusAtAbsolute(fs, rootReal, agentsAbs);
}

/**
 * Resolve the leaf folder relative path for a work target using real path kind
 * (lstat/stat + safe symlink handling) — never a basename-dot heuristic.
 *
 * - Existing directory (or internal directory symlink) → itself
 * - Existing regular file (or internal file symlink) → dirname
 * - Dotted/hidden directories (e.g. `.github`) → themselves when they are dirs
 * - Extensionless regular files → dirname
 * - Nonexistent target → conservative dirname (`path.resolve` strips trailing
 *   separators, so a trailing-slash directory hint is unavailable)
 * - External directory/file symlink → refuse (`AGENTS_PATH_OUTSIDE_ROOT`)
 */
async function resolveLeafFolderRelative(
  fs: AgentsFs,
  rootReal: string,
  absoluteRoot: string,
  absoluteTarget: string,
  normalizedTarget: string,
  targetLabel: string,
): Promise<string> {
  const dirnameOf = (rel: string): string => {
    const dir = posix.dirname(rel);
    return dir === "." ? "" : dir;
  };

  const st = await fs.lstat(absoluteTarget);
  if (!st.exists) {
    // Conservative fail-closed policy for nonexistent paths after resolve.
    return dirnameOf(normalizedTarget);
  }

  if (st.isSymbolicLink) {
    let linkReal: string;
    try {
      linkReal = await fs.realpath(absoluteTarget);
    } catch {
      // Dangling symlink — treat like nonexistent (dirname).
      return dirnameOf(normalizedTarget);
    }
    assertInsideProjectRoot(rootReal, linkReal, targetLabel);
    const isDir = await fs.isDirectory(absoluteTarget);
    if (isDir) return normalizedTarget;
    return dirnameOf(normalizedTarget);
  }

  if (st.isDirectory) {
    // Canonical containment for the directory itself.
    let dirReal: string;
    try {
      dirReal = await fs.realpath(absoluteTarget);
    } catch {
      dirReal = absoluteTarget;
    }
    assertInsideProjectRoot(rootReal, dirReal, targetLabel);
    return normalizedTarget;
  }

  if (st.isFile) {
    let fileReal: string;
    try {
      fileReal = await fs.realpath(absoluteTarget);
    } catch {
      fileReal = absoluteTarget;
    }
    assertInsideProjectRoot(rootReal, fileReal, targetLabel);
    return dirnameOf(normalizedTarget);
  }

  // Other node types — conservative dirname.
  return dirnameOf(normalizedTarget);
}

/**
 * Path-scoped ancestor chain for a work target under `root`.
 *
 * Returns every ancestor folder from project root to the target's containing
 * folder with AGENTS.md presence. `applicable` is the present subset — the
 * chain OpenCode native read would append — without loading every project
 * instruction document into a prompt.
 *
 * Target kind uses lstat/stat with safe symlink handling (no basename-dot
 * heuristic). Project-root containment is enforced on the root realpath and on
 * every candidate target/ancestor directory and AGENTS.md realpath; external
 * directory or AGENTS file symlinks are refused or excluded and never report
 * an external path. Internal inventory exclusion policy is unchanged.
 */
export async function resolveAgentsChain(
  root: string,
  targetRelativePath: string,
  options: AgentsOptions = {},
): Promise<AgentsResolutionResult> {
  const fs = options.fs ?? defaultFs();
  const absoluteRoot = resolve(root);
  let rootReal: string;
  try {
    rootReal = await fs.realpath(absoluteRoot);
  } catch {
    rootReal = absoluteRoot;
  }

  const normalizedTarget = targetRelativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalizedTarget === "" || normalizedTarget === ".") {
    // Target is the project root itself (a directory).
    const status = await agentsMdStatusInFolder(fs, rootReal, absoluteRoot, "");
    const entry: AgentsChainEntry = {
      folder: "",
      agentsMdPath: "AGENTS.md",
      status,
    };
    return {
      target: "",
      chain: [entry],
      applicable: status === "present" ? ["AGENTS.md"] : [],
    };
  }

  if (normalizedTarget.startsWith("/") || normalizedTarget.split("/").includes("..")) {
    throw new PoiesisError("AGENTS_PATH_OUTSIDE_ROOT", "AGENTS resolution target must stay inside the project root", {
      target: targetRelativePath,
    });
  }

  const absoluteTarget = resolve(absoluteRoot, ...normalizedTarget.split("/"));
  // Lexical containment before kind resolution.
  if (!isInsideRoot(absoluteRoot, absoluteTarget) && absoluteTarget !== absoluteRoot) {
    throw new PoiesisError("AGENTS_PATH_OUTSIDE_ROOT", "AGENTS resolution target must stay inside the project root", {
      target: targetRelativePath,
    });
  }

  const leafFolderRel = await resolveLeafFolderRelative(
    fs,
    rootReal,
    absoluteRoot,
    absoluteTarget,
    normalizedTarget,
    targetRelativePath,
  );

  const segments = leafFolderRel === "" ? [] : leafFolderRel.split("/").filter((s) => s.length > 0);
  const chain: AgentsChainEntry[] = [];
  const applicable: string[] = [];
  // Bound internal symlink cycles while verifying ancestor containment.
  const seenCanonical = new Set<string>();
  seenCanonical.add(rootReal);

  // Root
  {
    const agentsMdPath = "AGENTS.md";
    const status = await agentsMdStatusInFolder(fs, rootReal, absoluteRoot, "");
    chain.push({ folder: "", agentsMdPath, status });
    if (status === "present") applicable.push(agentsMdPath);
  }

  let acc = "";
  for (const segment of segments) {
    acc = acc === "" ? segment : `${acc}/${segment}`;
    const absFolder = join(absoluteRoot, ...acc.split("/"));
    try {
      const folderReal = await fs.realpath(absFolder);
      assertInsideProjectRoot(rootReal, folderReal, targetRelativePath);
      if (seenCanonical.has(folderReal)) {
        // Cycle via internal symlink — stop extending the chain (bounded).
        break;
      }
      seenCanonical.add(folderReal);
    } catch (error) {
      if (error instanceof PoiesisError) throw error;
      // Intermediate folder may not exist yet (e.g. nonexistent leaf under a
      // conservative dirname). Still report the logical chain without realpath.
    }
    const agentsMdPath = agentsMdRelative(acc);
    const status = await agentsMdStatusInFolder(fs, rootReal, absoluteRoot, acc);
    chain.push({ folder: acc, agentsMdPath, status });
    if (status === "present") applicable.push(agentsMdPath);
  }

  return {
    target: normalizedTarget,
    chain,
    applicable,
  };
}

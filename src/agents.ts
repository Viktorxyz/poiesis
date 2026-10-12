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
 * Injected filesystem seam for pure tests. Production uses Node fs.
 */
export interface AgentsFs {
  readdir(path: string): Promise<AgentsDirEntry[]>;
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** True when the path resolves to a directory (follows one logical target). */
  isDirectory(path: string): Promise<boolean>;
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
 * True when `directory` is a nested separate Git repository root
 * (contains `.git` as a directory or gitfile) and is not the project root.
 */
async function isNestedGitRepository(fs: AgentsFs, directory: string, projectRoot: string): Promise<boolean> {
  if (directory === projectRoot) return false;
  return fs.exists(join(directory, ".git"));
}

/**
 * Deterministic inventory of every eligible project folder (including root)
 * and whether `AGENTS.md` is present.
 *
 * Skips Git internals, dependency/vendor trees, generated/build/cache trees,
 * `.poiesis`, the installed skills subtree (`.agents/skills`), and nested
 * separate repositories. Does not blanket-exclude hidden Author containers
 * (`.agents`, `.opencode`, `.github`, …). Does not follow external symlinks.
 * Bounds internal symlink cycles via the canonical ancestor stack so a link
 * back to root/self cannot grow report paths unboundedly. Symlinks to regular
 * files are never treated as eligible directories.
 */
export async function inventoryAgents(root: string, options: AgentsOptions = {}): Promise<AgentsInventoryResult> {
  const fs = options.fs ?? defaultFs();
  const absoluteRoot = resolve(root);
  const rootReal = await fs.realpath(absoluteRoot).catch(() => absoluteRoot);
  const folders: AgentsFolderRecord[] = [];
  // Dedupe by reported relative path so the same coverage path is not emitted twice.
  const seenReportPaths = new Set<string>();

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
    if (isAgentsExcludedRelativePath(reportRelative)) return;
    if (seenReportPaths.has(reportRelative)) return;

    let canonical: string;
    try {
      canonical = await fs.realpath(readDir);
    } catch {
      canonical = readDir;
    }

    // Cycle: this canonical directory is already an active ancestor.
    if (ancestorCanonical.has(canonical)) return;

    if (!(await fs.isDirectory(readDir))) return;

    seenReportPaths.add(reportRelative);

    const agentsPath = join(readDir, "AGENTS.md");
    const agentsPresent = await fs.exists(agentsPath);
    folders.push({
      path: reportRelative,
      agentsMd: agentsPresent ? "present" : "missing",
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
          continue;
        }
        if (!isInsideRoot(rootReal, targetReal)) continue;
        // Symlink to a regular file (or non-directory) is not an eligible folder.
        if (!(await fs.isDirectory(targetReal))) continue;
        // Ancestor / self cycle on the canonical stack.
        if (nextAncestors.has(targetReal)) continue;
        if (await isNestedGitRepository(fs, targetReal, absoluteRoot)) continue;
        await visit(targetReal, childReport, nextAncestors);
        continue;
      }

      if (!entry.isDirectory) continue;
      if (await isNestedGitRepository(fs, childAbs, absoluteRoot)) continue;
      await visit(childAbs, childReport, nextAncestors);
    }
  }

  await visit(rootReal, "", new Set());

  folders.sort((a, b) => a.path.localeCompare(b.path));
  const missing = folders.filter((f) => f.agentsMd === "missing").map((f) => f.path);
  return { folders, missing };
}

/**
 * Path-scoped ancestor chain for a work target under `root`.
 *
 * Returns every ancestor folder from project root to the target's containing
 * folder with AGENTS.md presence. `applicable` is the present subset — the
 * chain OpenCode native read would append — without loading every project
 * instruction document into a prompt.
 */
export async function resolveAgentsChain(
  root: string,
  targetRelativePath: string,
  options: AgentsOptions = {},
): Promise<AgentsResolutionResult> {
  const fs = options.fs ?? defaultFs();
  const absoluteRoot = resolve(root);
  const normalizedTarget = targetRelativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalizedTarget === "" || normalizedTarget === ".") {
    // Target is the project root itself.
    const agentsPresent = await fs.exists(join(absoluteRoot, "AGENTS.md"));
    const entry: AgentsChainEntry = {
      folder: "",
      agentsMdPath: "AGENTS.md",
      status: agentsPresent ? "present" : "missing",
    };
    return {
      target: "",
      chain: [entry],
      applicable: agentsPresent ? ["AGENTS.md"] : [],
    };
  }

  if (normalizedTarget.startsWith("/") || normalizedTarget.split("/").includes("..")) {
    throw new PoiesisError("AGENTS_PATH_OUTSIDE_ROOT", "AGENTS resolution target must stay inside the project root", {
      target: targetRelativePath,
    });
  }

  const absoluteTarget = resolve(absoluteRoot, ...normalizedTarget.split("/"));
  if (!isInsideRoot(absoluteRoot, absoluteTarget) && absoluteTarget !== absoluteRoot) {
    throw new PoiesisError("AGENTS_PATH_OUTSIDE_ROOT", "AGENTS resolution target must stay inside the project root", {
      target: targetRelativePath,
    });
  }

  let leafFolderRel: string;
  const base = posix.basename(normalizedTarget);
  const looksLikeFile = base.includes(".");
  leafFolderRel = looksLikeFile ? posix.dirname(normalizedTarget) : normalizedTarget;
  if (leafFolderRel === ".") leafFolderRel = "";

  const segments = leafFolderRel === "" ? [] : leafFolderRel.split("/").filter((s) => s.length > 0);
  const chain: AgentsChainEntry[] = [];
  const applicable: string[] = [];

  // Root
  {
    const agentsMdPath = "AGENTS.md";
    const status = (await fs.exists(join(absoluteRoot, "AGENTS.md"))) ? "present" : "missing";
    chain.push({ folder: "", agentsMdPath, status });
    if (status === "present") applicable.push(agentsMdPath);
  }

  let acc = "";
  for (const segment of segments) {
    acc = acc === "" ? segment : `${acc}/${segment}`;
    const agentsMdPath = agentsMdRelative(acc);
    const status = (await fs.exists(join(absoluteRoot, ...acc.split("/"), "AGENTS.md"))) ? "present" : "missing";
    chain.push({ folder: acc, agentsMdPath, status });
    if (status === "present") applicable.push(agentsMdPath);
  }

  return {
    target: normalizedTarget,
    chain,
    applicable,
  };
}

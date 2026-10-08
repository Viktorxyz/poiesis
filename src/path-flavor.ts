import { posix, win32 } from "node:path";

/**
 * Spec #139 / ticket #156 — the path semantics a derivation must use, chosen
 * by NAME instead of by the host the tests happen to run on.
 *
 * The derivation this module exists for asks "which checkout owns this Git
 * common directory?", and the answer is "the directory above it". That is a
 * `dirname` question, and `dirname` is a PLATFORM question: `path.posix.dirname`
 * and `path.win32.dirname` disagree about what a separator is, and a
 * hand-rolled `replace(/\/$/, "").replace(/\/[^/]+$/, "")` silently answers
 * for POSIX only — on a Windows path containing no `/` it strips nothing and
 * returns its own input, which is how a linked worktree came to resolve the
 * installation root to itself.
 *
 * A flavor is therefore injected rather than read from `process.platform` at
 * each call site. Production passes `hostPathFlavor()`; a test on a Linux host
 * can pass `win32PathFlavor` and get the Windows answer as evidence instead of
 * a claim about a platform nobody in the run can execute.
 */
export type PathFlavorName = "posix" | "win32";

export interface PathFlavor {
  readonly name: PathFlavorName;
  /** The platform's own path separator. */
  readonly sep: string;
  isAbsolute(path: string): boolean;
  /** Collapse `.`, redundant separators, and `..` without touching the disk. */
  normalize(path: string): string;
  resolve(...segments: string[]): string;
  dirname(path: string): string;
  join(...segments: string[]): string;
  basename(path: string): string;
}

function flavor(name: PathFlavorName, api: typeof posix | typeof win32): PathFlavor {
  return {
    name,
    sep: api.sep,
    isAbsolute: (path) => api.isAbsolute(path),
    normalize: (path) => api.normalize(path),
    resolve: (...segments) => api.resolve(...segments),
    dirname: (path) => api.dirname(path),
    join: (...segments) => api.join(...segments),
    basename: (path) => api.basename(path),
  };
}

export const posixPathFlavor: PathFlavor = flavor("posix", posix);
export const win32PathFlavor: PathFlavor = flavor("win32", win32);

export function pathFlavorFor(platform: string): PathFlavor {
  return platform === "win32" ? win32PathFlavor : posixPathFlavor;
}

/**
 * The flavor of the process actually running. The single production entry
 * point; every derivation that takes an optional flavor defaults to this, so
 * an injectable flavor is an override rather than a way to forget the default.
 */
export function hostPathFlavor(): PathFlavor {
  return pathFlavorFor(process.platform);
}

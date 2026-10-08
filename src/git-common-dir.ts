import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { PoiesisError } from "./errors.js";

/**
 * Spec #139 / ticket #156 — the ONE bounded, synchronous place Poiesis asks
 * Git where its common directory is.
 *
 * The `local` tracker is canonical to that directory: it is the one path a
 * linked worktree and its primary checkout agree on, and the one directory
 * `poiesis uninstall` never removes. Getting the answer wrong is not a small
 * error — a store written beside the wrong `.git` is a second store — so the
 * query is made once, with explicit bounds, and every way it can fail is a
 * STABLE TYPED refusal rather than an untyped throw.
 *
 * Three properties are load-bearing and each is enforced here rather than
 * documented and hoped for.
 *
 *   1. BOUNDED. `timeout` and `maxOutputBytes` are explicit and finite, and
 *      they are passed to the transport AND re-checked on the result. The
 *      re-check is not redundant: `spawnSync` raises its overflow error only
 *      after the child has already written, and it can hand back more bytes
 *      than the cap it was given, so a seam that trusted the transport's error
 *      alone would be trusting a bound it did not enforce. A repository whose
 *      configuration made Git print megabytes therefore costs Poiesis at most
 *      the declared ceiling, and is then refused.
 *
 *   2. TYPED. `timeout`, `spawn`, `nonzero`, `oversized`, and `malformed` are
 *      five DISTINGUISHABLE refusals with five stable codes. Collapsing them
 *      into one code is what made the previous `execFileSync` catch-all
 *      useless: a hang, a missing Git, a directory that is not a repository, an
 *      oversized report, and a report that is not a path all looked identical to
 *      every caller and to every operator.
 *
 *   3. TEXT-FREE. No refusal carries the command, the arguments, the child's
 *      stdout, the child's stderr, or a caught exception's message. That is not
 *      squeamishness about a fixed argument vector: an `execFileSync` /
 *      `spawnSync` failure message is assembled FROM the command line, the
 *      child's own output, and the absolute paths around it, and the child here
 *      is `git` running inside a repository Poiesis did not create. A `.git`
 *      hook, a `.git/config` alias, or a `core.pager` can make that output
 *      contain a remote URL with a credential in its userinfo, and this store
 *      lives in exactly the directory such a repository controls. The refusals
 *      therefore carry only structural values — a reason, the two bounds, the
 *      invocation root, an exit code, a signal name, a byte count, a line
 *      COUNT — and no process text at all, retained or bounded-and-sanitized.
 *
 * The seam is SYNCHRONOUS by contract, not by convenience. `TrackerAdapter.project`
 * is a synchronous readonly property and `createTrackerAdapter` returns
 * synchronously, so the store location is resolved during adapter construction.
 * An async seam would either break that contract or leave two implementations
 * of the same answer to drift apart.
 */

/** Finite wall-clock ceiling for the read-only query. */
export const GIT_COMMON_DIR_TIMEOUT_MS = 10_000;
/**
 * Finite ceiling on the bytes this seam will accept as a path. A common
 * directory is one filesystem path, so anything near this size is a report
 * Poiesis refuses on principle rather than parses.
 */
export const GIT_COMMON_DIR_MAX_OUTPUT_BYTES = 4_096;

/** The five distinguishable ways the query can fail, each with a stable code. */
export const GIT_COMMON_DIR_REFUSALS = {
  timeout: "LOCAL_TRACKER_GIT_COMMON_DIR_TIMEOUT",
  spawn: "LOCAL_TRACKER_GIT_COMMON_DIR_SPAWN_FAILED",
  nonzero: "LOCAL_TRACKER_GIT_COMMON_DIR_REFUSED",
  oversized: "LOCAL_TRACKER_GIT_COMMON_DIR_OUTPUT_TOO_LARGE",
  malformed: "LOCAL_TRACKER_GIT_COMMON_DIR_MALFORMED",
} as const;

export type GitCommonDirRefusalReason = keyof typeof GIT_COMMON_DIR_REFUSALS;

const REFUSAL_MESSAGES: Record<GitCommonDirRefusalReason, string> = {
  timeout: "The Git common-directory query exceeded its bounded wait for the local tracker",
  spawn: "The Git common-directory query could not be started for the local tracker",
  nonzero: "Git refused the common-directory query the local tracker requires",
  oversized: "The Git common-directory query reported more output than the local tracker will read",
  malformed: "Git reported a common directory the local tracker cannot use",
};

export interface GitCommonDirInvocation {
  /** The invocation root, already resolved. Relative reports anchor here. */
  readonly repoRoot: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * The transport's answer, in the ONE shape the seam accepts.
 *
 * The failure variants deliberately carry no `stderr`, no `stdout`, no `error`,
 * and no `message` field: a transport that wants to report process text has
 * nowhere to put it, so text cannot reach a refusal by accident.
 */
export type GitCommonDirProbeResult =
  | { readonly outcome: "reported"; readonly stdout: string }
  | { readonly outcome: "timeout" }
  | { readonly outcome: "spawn" }
  | { readonly outcome: "nonzero"; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly outcome: "oversized"; readonly observedBytes: number };

export type GitCommonDirProbe = (invocation: GitCommonDirInvocation) => GitCommonDirProbeResult;

/**
 * The transport seam, mirroring the existing `setLinearTrackerSeamsForTest`
 * precedent: module-scoped, deliberately NOT re-exported from `src/index.ts`,
 * and reset to `null` by the caller. Production always runs the real transport.
 */
let probeForTest: GitCommonDirProbe | null = null;

export function setGitCommonDirProbeForTest(probe: GitCommonDirProbe | null): void {
  probeForTest = probe;
}

function refusal(
  reason: GitCommonDirRefusalReason,
  invocation: GitCommonDirInvocation,
  extra: Record<string, unknown> = {},
): PoiesisError {
  return new PoiesisError(GIT_COMMON_DIR_REFUSALS[reason], REFUSAL_MESSAGES[reason], {
    // A capability LABEL, never a command line: the fixed argument vector is
    // an implementation detail, and an operator does not need it to act.
    capability: "git-common-dir",
    reason,
    repoRoot: invocation.repoRoot,
    timeoutMs: invocation.timeoutMs,
    maxOutputBytes: invocation.maxOutputBytes,
    ...extra,
  });
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function byteLength(text: string | undefined): number {
  return Buffer.byteLength(text ?? "", "utf8");
}

/**
 * The real transport: one read-only `git rev-parse`, no network, no hook, no
 * working-tree read, bounded on both axes.
 *
 * The three transport errors are distinguished by their Node `code` rather
 * than by their message, and the message is never read: `ETIMEDOUT` is the
 * bound we asked for expiring, `ENOBUFS` is the output ceiling, and anything
 * else means the query never started (no Git on PATH, a permission refusal, a
 * cwd that does not exist).
 */
function runGitCommonDirProbe(invocation: GitCommonDirInvocation): GitCommonDirProbeResult {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: invocation.repoRoot,
    encoding: "utf8",
    timeout: invocation.timeoutMs,
    maxBuffer: invocation.maxOutputBytes,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const code = errorCode(result.error);
  if (code === "ETIMEDOUT") return { outcome: "timeout" };
  // The transport can return MORE bytes than the cap it was given before it
  // raises this, so the count is re-checked against the declared ceiling below
  // rather than trusted from here.
  if (code === "ENOBUFS") return { outcome: "oversized", observedBytes: byteLength(result.stdout) };
  if (result.error !== undefined) return { outcome: "spawn" };
  if (result.status === 0) return { outcome: "reported", stdout: result.stdout ?? "" };
  return { outcome: "nonzero", exitCode: result.status, signal: result.signal };
}

// A control byte is never part of a filesystem path, and a NUL in particular
// truncates one in every C API the OS offers. This is the shape check that
// keeps a report which is not a path from being resolved into one.
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;

/**
 * Normalize a report into an absolute path, or refuse it.
 *
 * `git rev-parse --git-common-dir` prints a path RELATIVE to the directory the
 * query ran in inside a primary checkout, and an ABSOLUTE path in a linked
 * worktree. `resolve` accepts both and anchors a relative one at the invocation
 * root rather than at the process cwd — the difference between a store beside
 * the repository the caller named and a store beside whatever directory the
 * caller happened to be standing in.
 */
function normalizeReported(
  invocation: GitCommonDirInvocation,
  stdout: string,
): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const detail = { reportedLineCount: lines.length };
  if (lines.length !== 1 || CONTROL_BYTES.test(lines[0]!)) {
    throw refusal("malformed", invocation, detail);
  }
  return resolve(invocation.repoRoot, lines[0]!);
}

/**
 * Resolve the Git common directory for `repoRoot`, or refuse with one of the
 * five typed codes. The single implementation the synchronous and the
 * `Promise`-returning tracker call sites both delegate to, so no caller can
 * observe two different locations.
 */
export function discoverGitCommonDir(repoRoot: string): string {
  const invocation: GitCommonDirInvocation = {
    repoRoot: resolve(repoRoot),
    timeoutMs: GIT_COMMON_DIR_TIMEOUT_MS,
    maxOutputBytes: GIT_COMMON_DIR_MAX_OUTPUT_BYTES,
  };
  const result = (probeForTest ?? runGitCommonDirProbe)(invocation);
  switch (result.outcome) {
    case "reported": {
      const reported = result.stdout;
      if (byteLength(reported) > invocation.maxOutputBytes) {
        throw refusal("oversized", invocation, { observedBytes: byteLength(reported) });
      }
      return normalizeReported(invocation, reported);
    }
    case "timeout":
      throw refusal("timeout", invocation);
    case "spawn":
      throw refusal("spawn", invocation);
    case "nonzero":
      throw refusal("nonzero", invocation, { exitCode: result.exitCode, signal: result.signal });
    case "oversized":
      throw refusal("oversized", invocation, { observedBytes: result.observedBytes });
  }
}

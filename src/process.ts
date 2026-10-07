import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { PoiesisError } from "./errors.js";
import { completeUtf8PrefixLength } from "./utf8-prefix.js";
import { sanitizeSubprocessOutput } from "./url-userinfo.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const GRACEFUL_TIMEOUT_MS = 2_000;
const TERMINATION_CONFIRM_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const IS_WINDOWS = process.platform === "win32";

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Spec #120 / ticket #129 — explicit replacement-environment seam.
   *
   * When set, the child process receives EXACTLY this env object as
   * its environment, with NO `{...process.env, ...options.env}` merge.
   * This is the secure boundary for spawning `uvx graphify`: the
   * default `GraphifyRunner` hands the pre-sanitized env (the result
   * of `sanitizeGraphifyEnvironment`) to the runner and the runner
   * MUST NOT silently re-merge parent credentials into the child.
   *
   * The caller is responsible for putting every variable the child
   * needs into this object. In particular, PATH (and the Windows
   * spelling `Path`) MUST be present or the child cannot resolve
   * binaries; `sanitizeGraphifyEnvironment` already preserves PATH
   * via its allow-list, so the default Graphify runner satisfies
   * this requirement automatically.
   *
   * Setting BOTH `env` and `replacementEnv` is rejected with
   * `INVALID_RUN_OPTIONS` so the seam cannot accidentally fall back
   * to the merge path. When `replacementEnv` is NOT set, the runner
   * falls back to the legacy `{...process.env, ...options.env}`
   * merge — preserving every existing caller's parent-env
   * inheritance (git, gh, glab, init, update, doctor, skills, …).
   */
  replacementEnv?: NodeJS.ProcessEnv;
  input?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

interface Capture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  finalized: boolean;
}

export async function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const childEnv = resolveChildEnvironment(options);
  const startedAt = Date.now();

  return await new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: childEnv,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        killSignal: "SIGTERM",
        ...(IS_WINDOWS ? {} : { detached: true }),
      });
    } catch (error) {
      reject(commandIoError(command, args, error));
      return;
    }

    const stdout = createCapture();
    const stderr = createCapture();
    const processGroupId = IS_WINDOWS ? null : (child.pid ?? null);
    let childExited = false;
    let stdoutClosed = child.stdout === null;
    let stderrClosed = child.stderr === null;
    let stdinClosed = child.stdin === null || options.input === undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let infrastructureError: Error | null = null;
    let timedOut = false;
    let terminationComplete = true;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let ownedGroupMembers: Map<number, string> | null = null;

    const buildResult = (): RunResult => ({
      command,
      args,
      exitCode,
      stdout: sanitizedStream(stdout),
      stderr: sanitizedStream(stderr),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      signal: exitSignal,
      durationMs: Date.now() - startedAt,
    });

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      timeoutTimer = null;
      graceTimer = null;

      const result = buildResult();
      if (timedOut) {
        reject(
          new PoiesisError(
            "COMMAND_TIMEOUT",
            `${command} exceeded ${timeoutMs}ms timeout`,
            {
              command,
              args,
              timeoutMs,
              exitCode: result.exitCode,
              signal: result.signal,
              durationMs: result.durationMs,
              stdout: bounded(result.stdout),
              stderr: bounded(result.stderr),
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
            },
            124,
          ),
        );
        return;
      }
      if (infrastructureError !== null) {
        reject(commandIoError(command, args, infrastructureError, result));
        return;
      }
      if (result.exitCode !== 0 && !options.allowFailure) {
        reject(
          new PoiesisError("COMMAND_FAILED", `${command} exited with code ${result.exitCode}`, {
            command,
            args,
            exitCode: result.exitCode,
            stderr: bounded(result.stderr),
            stderrTruncated: result.stderrTruncated,
            stdoutTruncated: result.stdoutTruncated,
          }),
        );
        return;
      }
      resolve(result);
    };

    const tryFinalize = (): void => {
      if (settled || !childExited || !stdoutClosed || !stderrClosed || !stdinClosed) return;

      if (timedOut && !terminationComplete) {
        // When an owned process-group snapshot exists, do not trust a single
        // "PG appears empty" verdict during the grace period: a TERM-handler
        // descendant that forks a TERM-resistant replacement can briefly
        // hide that replacement from /proc (the new /proc entry is created
        // at fork and populated across exec). Always wait for the forced
        // SIGKILL phase so every TERM-resistant descendant, including
        // TERM-handler-replacement descendants, is captured and killed
        // before settlement. The "PG appears empty" verdict is still useful
        // on non-owned-group paths where the snapshot is untracked.
        if (ownedGroupMembers !== null) return;
        const groupExists = processGroupId !== null && processGroupExists(processGroupId);
        if (processGroupId !== null && !groupExists) {
          if (graceTimer !== null) clearTimeout(graceTimer);
          graceTimer = null;
          terminationComplete = true;
        } else {
          return;
        }
      }
      settle();
    };

    const recordInfrastructureError = (error: Error): void => {
      infrastructureError ??= error;
    };

    child.stdout?.on("data", (chunk: Buffer) => consume(stdout, chunk, maxBytes));
    child.stderr?.on("data", (chunk: Buffer) => consume(stderr, chunk, maxBytes));
    child.stdout?.on("error", (error: Error) => {
      recordInfrastructureError(error);
    });
    child.stderr?.on("error", (error: Error) => {
      recordInfrastructureError(error);
    });
    child.stdout?.on("close", () => {
      stdoutClosed = true;
      finalizeCapture(stdout);
      tryFinalize();
    });
    child.stderr?.on("close", () => {
      stderrClosed = true;
      finalizeCapture(stderr);
      tryFinalize();
    });

    child.stdin?.on("error", (error: Error) => {
      if (!isExpectedStdinClosure(error)) recordInfrastructureError(error);
    });
    child.stdin?.on("close", () => {
      stdinClosed = true;
      tryFinalize();
    });

    child.on("error", (error: Error) => {
      recordInfrastructureError(error);
      childExited = true;
      tryFinalize();
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      childExited = true;
      exitCode = code;
      exitSignal = signal;
      tryFinalize();
    });

    const forceTermination = async (): Promise<void> => {
      graceTimer = null;
      if (processGroupId !== null && ownedGroupMembers !== null) {
        refreshOwnedProcessGroup(processGroupId, ownedGroupMembers);
        // Bounded-reliability safety net: even if the snapshot missed a
        // TERM-handler-replacement descendant due to a /proc race,
        // SIGKILL the entire group so every descendant is captured
        // before settlement. The group was created by this runner via
        // detached: true; every member is a descendant of the original
        // child and is intended to be terminated.
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {
          // The group may already be gone; the per-member signals below
          // remain authoritative for PID-reuse verification.
        }
        signalOwnedProcesses(processGroupId, ownedGroupMembers, "SIGKILL");
        await waitForOwnedProcessesExit(ownedGroupMembers, TERMINATION_CONFIRM_MS);
      } else {
        await terminateTree(child, processGroupId, true);
      }
      if (processGroupId !== null && ownedGroupMembers === null) {
        await waitForProcessGroupExit(processGroupId, TERMINATION_CONFIRM_MS);
      }
      terminationComplete = true;
      tryFinalize();
    };

    const beginTermination = async (): Promise<void> => {
      const gracefulSucceeded = await terminateTree(child, processGroupId, false);
      if (settled) return;
      if (IS_WINDOWS) {
        // taskkill /T reports completion for the requested tree. If it fails,
        // force immediately only while the original child handle is still
        // active; a delayed /PID call after exit could target a reused PID.
        if (!gracefulSucceeded && !childExited) {
          const forced = await terminateTree(child, processGroupId, true);
          if (!forced) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Best effort after both taskkill phases failed.
            }
          }
        }
        terminationComplete = true;
        tryFinalize();
        return;
      }
      graceTimer = setTimeout(() => {
        void forceTermination();
      }, GRACEFUL_TIMEOUT_MS);
      tryFinalize();
    };

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      if (processGroupId !== null) {
        ownedGroupMembers = snapshotLinuxProcessGroup(processGroupId);
      }
      timedOut = true;
      terminationComplete = false;
      void beginTermination();
    }, timeoutMs);

    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.end(options.input);
    }
  });
}

export function bounded(value: string, limit = 8_000): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limit) return value;
  const retained = encoded.subarray(0, completeUtf8PrefixLength(encoded.subarray(0, limit)));
  return `${retained.toString("utf8")}\n... truncated ${encoded.length - retained.length} bytes`;
}

function createCapture(): Capture {
  return { chunks: [], bytes: 0, truncated: false, finalized: false };
}

function consume(capture: Capture, chunk: Buffer, maxBytes: number): void {
  const keep = Math.min(chunk.length, Math.max(0, maxBytes - capture.bytes));
  if (keep > 0) {
    capture.chunks.push(Buffer.from(chunk.subarray(0, keep)));
    capture.bytes += keep;
  }
  if (keep < chunk.length) capture.truncated = true;
}

function finalizeCapture(capture: Capture): void {
  if (capture.finalized) return;
  capture.finalized = true;
  const bytes = Buffer.concat(capture.chunks, capture.bytes);
  const safeLength = completeUtf8PrefixLength(bytes);
  if (safeLength < bytes.length) capture.truncated = true;
  capture.chunks = safeLength === 0 ? [] : [Buffer.from(bytes.subarray(0, safeLength))];
  capture.bytes = safeLength;
}

function captureText(capture: Capture): string {
  finalizeCapture(capture);
  return Buffer.concat(capture.chunks, capture.bytes).toString("utf8");
}

function isExpectedStdinClosure(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPIPE" ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}

async function terminateTree(
  child: ChildProcess,
  processGroupId: number | null,
  force: boolean,
): Promise<boolean> {
  if (IS_WINDOWS) {
    const pid = child.pid;
    if (pid === undefined) return false;
    return await runTaskkill(pid, force);
  } else if (processGroupId !== null) {
    try {
      process.kill(-processGroupId, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      // The group may already be gone; fall back to the direct child.
    }
  }

  try {
    return child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Best effort; lifecycle events still decide settlement.
    return false;
  }
}

async function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let helper: ChildProcess;
    try {
      helper = spawn(
        "taskkill",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      resolve(false);
      return;
    }

    let done = false;
    const finish = (succeeded: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(succeeded);
    };
    const timer = setTimeout(() => {
      try {
        helper.kill();
      } catch {
        // The helper may have exited between the timeout and kill.
      }
      finish(false);
    }, TASKKILL_TIMEOUT_MS);
    helper.once("error", () => finish(false));
    helper.once("close", (code) => finish(code === 0));
  });
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function snapshotLinuxProcessGroup(processGroupId: number): Map<number, string> | null {
  if (process.platform !== "linux") return null;
  const members = new Map<number, string>();
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const identity = readLinuxProcessIdentity(pid);
      if (identity?.processGroupId === processGroupId) members.set(pid, identity.startTime);
    }
    return members;
  } catch {
    return null;
  }
}

function readLinuxProcessIdentity(
  pid: number,
): { processGroupId: number; startTime: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(processGroupId) || startTime === undefined) return null;
    return { processGroupId, startTime };
  } catch {
    return null;
  }
}

function ownedProcessesExist(members: Map<number, string>): boolean {
  for (const [pid, startTime] of members) {
    if (readLinuxProcessIdentity(pid)?.startTime === startTime) return true;
  }
  return false;
}

function refreshOwnedProcessGroup(processGroupId: number, members: Map<number, string>): boolean {
  const current = snapshotLinuxProcessGroup(processGroupId);
  if (current === null) return ownedProcessesExist(members);
  if (current.size === 0) return false;
  for (const [pid, startTime] of current) members.set(pid, startTime);
  return true;
}

function signalOwnedProcesses(
  processGroupId: number,
  members: Map<number, string>,
  signal: NodeJS.Signals,
): void {
  for (const [pid, startTime] of members) {
    const current = readLinuxProcessIdentity(pid);
    if (current?.startTime !== startTime || current.processGroupId !== processGroupId) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // The process may exit after its identity check.
    }
  }
}

async function waitForOwnedProcessesExit(
  members: Map<number, string>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (ownedProcessesExist(members) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function commandIoError(
  command: string,
  args: string[],
  error: unknown,
  result?: RunResult,
): PoiesisError {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new PoiesisError(
    "COMMAND_IO_ERROR",
    `${command} stream or process error: ${cause.message}`,
    {
      command,
      args,
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      durationMs: result?.durationMs,
      cause: cause.name,
      causeMessage: cause.message,
      stdoutTruncated: result?.stdoutTruncated ?? false,
      stderrTruncated: result?.stderrTruncated ?? false,
    },
  );
}

function stripTrailingWhitespace(value: string): string {
  return value.replace(/[\s\u0000]+$/, "");
}

/**
 * Spec #139 / ticket #149 — the redaction seam for a captured stream.
 *
 * This runner is the ONE place subprocess output is captured, so the URL
 * userinfo redaction is applied here rather than at each of the many
 * call sites that report a command's output. Every settlement path reads
 * `buildResult()` — the resolved result (including `allowFailure`), the
 * `COMMAND_TIMEOUT` details, and the `COMMAND_FAILED` details — so a
 * credential a child printed (`fatal: unable to access
 * 'https://user:<token>@host/…'`) cannot reach any of them.
 *
 * Sanitizing happens AFTER the capture and BEFORE `bounded()` bounds the
 * text for an error detail, so a later cut can only ever shorten a
 * credential-free URL, never expose a credential that is still present.
 *
 * `truncated` is the capture's own flag: when the byte cap or an
 * incomplete trailing code point cut the stream, the text's end is not a
 * real boundary, and the sanitizer withholds a trailing authority it
 * cannot prove is credential-free.
 */
function sanitizedStream(capture: Capture): string {
  return sanitizeSubprocessOutput(stripTrailingWhitespace(captureText(capture)), {
    truncated: capture.truncated,
  });
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new PoiesisError("INVALID_TIMEOUT", `Timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`, { value });
  }
  return value;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PoiesisError("INVALID_MAX_BYTES", "Max bytes must be a positive safe integer", { value });
  }
  return value;
}

/**
 * Spec #120 / ticket #129 — resolve the env passed to `spawn`.
 *
 * Three contracts, in priority order:
 *
 *   1. `replacementEnv` set AND `env` set → `INVALID_RUN_OPTIONS`.
 *      The two options are mutually exclusive; passing both is a
 *      fail-closed caller bug that must NOT silently fall back to the
 *      merge path (which is the very leak the replacement seam
 *      exists to prevent).
 *
 *   2. `replacementEnv` set → the child env is EXACTLY the supplied
 *      object. No `{...process.env, ...replacementEnv}` merge. This
 *      is the secure boundary for `uvx graphify`: the caller hands
 *      the pre-sanitized env (the result of
 *      `sanitizeGraphifyEnvironment`) and the runner must not
 *      silently re-merge parent credentials. The caller is
 *      responsible for including PATH/Path and any other variable
 *      the child needs; `sanitizeGraphifyEnvironment` already
 *      preserves PATH via its allow-list.
 *
 *   3. `replacementEnv` NOT set → the legacy
 *      `{...process.env, ...options.env}` merge. Every existing
 *      caller (git, gh, glab, init, update, doctor, skills, …)
 *      inherits the parent env unchanged; the merge only overrides
 *      keys the caller explicitly supplied.
 *
 * The resolved env is a fresh object so the caller can mutate
 * `options.replacementEnv` / `options.env` after the call without
 * leaking back into the spawned child.
 */
function resolveChildEnvironment(options: RunOptions): NodeJS.ProcessEnv {
  if (options.replacementEnv !== undefined) {
    if (options.env !== undefined) {
      throw new PoiesisError(
        "INVALID_RUN_OPTIONS",
        "run() cannot accept both env and replacementEnv; pass exactly one",
        { hasEnv: true, hasReplacementEnv: true },
      );
    }
    return { ...options.replacementEnv };
  }
  return { ...process.env, ...options.env };
}

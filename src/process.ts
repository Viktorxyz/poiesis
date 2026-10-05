import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { PoiesisError, asPoiesisError } from "./errors.js";
import {
  createManagedProcessLease,
  isManagedProcessLeaseLabel,
  settleManagedProcessLease,
  type ManagedProcessLease,
} from "./process-tree.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const IS_WINDOWS = process.platform === "win32";

/**
 * Spec #168 / ticket #170 — bounded window a managed command may keep the
 * runner waiting after the child exited while a descendant still holds the
 * inherited output. When the window elapses the managed process group is
 * settled (see `settleManagedProcessLease`) and the run settles with it,
 * so a leaked background descendant can never hold a Poiesis operation
 * open indefinitely.
 */
const POST_EXIT_GRACE_MS = 2_000;

/** Conventional exit status for a command cancelled by SIGINT-equivalent. */
const CANCELLED_EXIT_CODE = 130;

/**
 * Transient fallback workspace label for callers that do not name a
 * workspace. The lease identity is per-run and in-memory only; Poiesis
 * never persists it, so no durable identity store is implied.
 */
const UNSCOPED_WORKSPACE_ID = "poiesis-unscoped-workspace";

let transientOperationCounter = 0;

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
  /**
   * Spec #168 / ticket #170 — the caller's cancellation intent.
   *
   * When the signal fires, the runner settles the managed process group
   * exactly as it does for a timeout and then rejects with
   * `COMMAND_CANCELLED` (exit code 130). A signal that is already aborted
   * when `run` is called rejects WITHOUT spawning anything, so a cancelled
   * operation never creates a subprocess it must then clean up.
   */
  signal?: AbortSignal;
  /**
   * Spec #168 / ticket #170 — the managed operation identity recorded on
   * the transient process lease. Optional; when omitted the runner mints a
   * transient in-memory label. A malformed value is refused with
   * `PROCESS_LEASE_MALFORMED` before any process is created.
   */
  operationId?: string;
  /**
   * Spec #168 / ticket #170 — the Poiesis workspace identity recorded on
   * the transient process lease. Optional; same fail-closed contract as
   * `operationId`.
   */
  workspaceId?: string;
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

/**
 * Spec #168 / ticket #170 — run one managed subprocess to a settled state.
 *
 * Every exit path — success, non-zero exit, timeout, cancellation, and
 * internal error — settles only AFTER the managed process group has been
 * cleaned through its transient identity lease (`src/process-tree.ts`).
 * The child is spawned `detached: true`, so it leads an isolated process
 * group that cannot be reached from Poiesis's own group or the terminal's,
 * and cleanup targets are derived from that lease alone: there is no
 * process-name, port, user, or age matching anywhere in this path.
 *
 * A descendant that outlives the child — the classic "successful command
 * that leaks a background process" — is cleaned too. While such a
 * descendant still holds the inherited output the runner waits at most
 * {@link POST_EXIT_GRACE_MS} for it, then settles the group instead of
 * blocking until the command timeout.
 */
export async function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const childEnv = resolveChildEnvironment(options);
  // The lease identity is validated before anything is spawned, so a
  // malformed operation or workspace identity can never create a process.
  const leaseIdentity = resolveLeaseIdentity(options);
  const startedAt = Date.now();

  // A caller that has already cancelled must not create a subprocess that
  // would then have to be cleaned up.
  if (options.signal?.aborted === true) {
    throw cancelledError(command, args, "cancelled before the command was spawned");
  }

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

    // The transient lease for this managed process. Windows has no POSIX
    // process groups, so its tree cleanup runs through taskkill instead.
    // A spawn that produced no PID has no process to lease: the `error`
    // event settles it as COMMAND_IO_ERROR.
    let lease: ManagedProcessLease | null = null;
    if (!IS_WINDOWS && child.pid !== undefined) {
      try {
        lease = createManagedProcessLease({
          operationId: leaseIdentity.operationId,
          workspaceId: leaseIdentity.workspaceId,
          pid: child.pid,
        });
      } catch (error) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort; the process never left Poiesis's hands.
        }
        child.on("error", () => {
          // The lease failure is the reported outcome; swallow the late
          // spawn error so it cannot surface as an unhandled rejection.
        });
        reject(asPoiesisError(error));
        return;
      }
    }

    const stdout = createCapture();
    const stderr = createCapture();
    let childExited = false;
    let stdoutClosed = child.stdout === null;
    let stderrClosed = child.stderr === null;
    let stdinClosed = child.stdin === null || options.input === undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let infrastructureError: Error | null = null;
    let timedOut = false;
    let cancelled = false;
    let cleanupError: PoiesisError | null = null;
    /** True once the managed group was cleaned (or refused). Never earlier. */
    let cleanupComplete = false;
    let cleanupStarted = false;
    let settled = false;
    let lingerTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const buildResult = (): RunResult => ({
      command,
      args,
      exitCode,
      stdout: stripTrailingWhitespace(captureText(stdout)),
      stderr: stripTrailingWhitespace(captureText(stderr)),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      signal: exitSignal,
      durationMs: Date.now() - startedAt,
    });

    const clearLingerTimer = (): void => {
      if (lingerTimer === null) return;
      clearTimeout(lingerTimer);
      lingerTimer = null;
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearLingerTimer();
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      if (options.signal !== undefined) options.signal.removeEventListener("abort", onCallerAbort);

      const result = buildResult();
      // A refused or unresolved cleanup outranks every other outcome: it
      // means a process Poiesis spawned may still be running, so the run
      // must not report success, failure, or cancellation as settled.
      if (cleanupError !== null) {
        reject(cleanupError);
        return;
      }
      if (cancelled) {
        reject(cancelledError(command, args, "cancelled by the caller", result));
        return;
      }
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
      if (settled || !childExited) return;
      // Once the managed group is settled, no further output can arrive: an
      // open pipe is a leaked descendant's doing, not a reason to keep
      // waiting.
      if (cleanupComplete) {
        settle();
        return;
      }
      if (!stdoutClosed || !stderrClosed || !stdinClosed) {
        armLingerTimer();
        return;
      }
      void beginCleanup();
    };

    /**
     * Bound how long a descendant may hold the runner open after the child
     * exited. When the window elapses the managed group is settled, which
     * both bounds the wait and removes the leak.
     */
    const armLingerTimer = (): void => {
      if (lingerTimer !== null || cleanupComplete) return;
      lingerTimer = setTimeout(() => {
        lingerTimer = null;
        void beginCleanup();
      }, POST_EXIT_GRACE_MS);
    };

    /**
     * Clean the managed process group exactly once, and only then let the
     * run settle. The POSIX path delegates to the lease settler, which
     * validates process identity before every signal and fails closed with
     * a typed error instead of claiming a cleanup it could not confirm.
     */
    const beginCleanup = async (): Promise<void> => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      clearLingerTimer();
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (lease !== null) {
        try {
          await settleManagedProcessLease(lease);
        } catch (error) {
          cleanupError = asPoiesisError(error);
        }
      } else if (IS_WINDOWS) {
        // Documented Windows model: no POSIX process groups and no readable
        // process-start identity, so `taskkill /PID <pid> /T` is the only
        // way to reach the tree, and it is meaningful ONLY while the PID is
        // still the process Poiesis spawned. Once the child has exited that
        // PID has been reaped and may already be recycled, so addressing it
        // — for a normal completion or for the linger window — could kill an
        // unrelated process. Nothing is therefore signalled once
        // `childExited` is set; a normal Windows run is simply already
        // settled.
        if (!childExited) await terminateWindowsTree();
      }
      // Neither a lease nor Windows: the spawn produced no process, so
      // there is nothing to clean up before settling.
      cleanupComplete = true;
      tryFinalize();
    };

    const beginTermination = (): void => {
      if (cleanupComplete) return;
      void beginCleanup();
    };

    /** Windows has no POSIX process groups; `taskkill /T` drives the tree. */
    const terminateWindowsTree = async (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined) return;
      const gracefulSucceeded = await runTaskkill(pid);
      if (settled) return;
      // taskkill /T reports completion for the requested tree. If it fails,
      // force immediately only while the original child handle is still
      // active; a delayed /PID call after exit could target a reused PID.
      if (!gracefulSucceeded && !childExited) {
        const forced = await runTaskkill(pid, true);
        if (!forced) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best effort after both taskkill phases failed.
          }
        }
      }
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

    function onCallerAbort(): void {
      if (settled || cancelled) return;
      cancelled = true;
      beginTermination();
    }

    options.signal?.addEventListener("abort", onCallerAbort, { once: true });

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      timedOut = true;
      beginTermination();
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

function completeUtf8PrefixLength(buffer: Buffer): number {
  let offset = 0;
  while (offset < buffer.length) {
    const lead = buffer[offset]!;
    if (lead <= 0x7f) {
      offset += 1;
      continue;
    }

    let width: number;
    if (lead >= 0xc2 && lead <= 0xdf) width = 2;
    else if (lead >= 0xe0 && lead <= 0xef) width = 3;
    else if (lead >= 0xf0 && lead <= 0xf4) width = 4;
    else return offset;
    if (offset + width > buffer.length) return offset;

    const second = buffer[offset + 1]!;
    if (!isUtf8Continuation(second)) return offset;
    if (lead === 0xe0 && second < 0xa0) return offset;
    if (lead === 0xed && second > 0x9f) return offset;
    if (lead === 0xf0 && second < 0x90) return offset;
    if (lead === 0xf4 && second > 0x8f) return offset;
    for (let index = 2; index < width; index += 1) {
      if (!isUtf8Continuation(buffer[offset + index]!)) return offset;
    }
    offset += width;
  }
  return offset;
}

function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
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

async function runTaskkill(pid: number, force = false): Promise<boolean> {
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

/**
 * Spec #168 / ticket #170 — resolve the transient lease identity for one
 * managed run. Both fields must be well-formed lease labels; a malformed
 * one is refused here, BEFORE `spawn`, so a bad identity can never create
 * a process. Callers that do not name an operation get a transient,
 * in-memory label: no durable identity store is introduced.
 */
function resolveLeaseIdentity(options: RunOptions): { operationId: string; workspaceId: string } {
  transientOperationCounter += 1;
  const operationId = options.operationId ?? `poiesis-operation-${transientOperationCounter}`;
  const workspaceId = options.workspaceId ?? UNSCOPED_WORKSPACE_ID;
  for (const [field, value] of [
    ["operationId", operationId],
    ["workspaceId", workspaceId],
  ] as const) {
    if (!isManagedProcessLeaseLabel(value)) {
      throw new PoiesisError("PROCESS_LEASE_MALFORMED", `Managed process lease ${field} is not a valid identity`, {
        field,
        value,
      });
    }
  }
  return { operationId, workspaceId };
}

/**
 * Cancellation is a typed outcome, not a silent success and not a timeout:
 * the caller asked for this run to stop, and the managed group has already
 * been settled by the time this is raised.
 */
function cancelledError(command: string, args: string[], reason: string, result?: RunResult): PoiesisError {
  return new PoiesisError("COMMAND_CANCELLED", `${command} was cancelled: ${reason}`, {
    command,
    args,
    reason,
    cancelled: true,
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    durationMs: result?.durationMs,
    stdout: bounded(result?.stdout ?? ""),
    stderr: bounded(result?.stderr ?? ""),
    stdoutTruncated: result?.stdoutTruncated ?? false,
    stderrTruncated: result?.stderrTruncated ?? false,
  }, CANCELLED_EXIT_CODE);
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

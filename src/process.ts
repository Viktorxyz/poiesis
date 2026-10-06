import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { PoiesisError, asPoiesisError } from "./errors.js";
import {
  ADMISSION_ARGV0,
  ADMISSION_CONFIRM_MS,
  ADMISSION_DRAIN_MS,
  ADMISSION_LEAF_ENV,
  ADMISSION_PROLOGUE,
  isAdmissionConfirmation,
  provisionContainment,
  releaseContainment,
  requireConfirmedAdmission,
  settleContainment,
  type ContainmentModel,
  type ManagedContainmentLease,
} from "./containment.js";
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
/**
 * Spec #168 / ticket #176 — bounded window the Windows path waits for the exit
 * it is already holding after every signalling phase has been tried.
 *
 * `taskkill` can report success for a tree it never reached, `child.kill` can
 * be refused, and none of the three phases produces evidence that the child
 * actually died. The only evidence this runner holds is its own `exit` event,
 * so after the last phase it waits for that event — and if it never arrives,
 * the run rejects with a typed cleanup error instead of reporting success, a
 * timeout, or a cancellation for a process that is still running.
 */
const WINDOWS_CLEANUP_CONFIRM_MS = 2_000;
/**
 * Spec #168 / ticket #176 — bounded window each Windows signalling phase gets to
 * produce the child's `exit` before the next one is tried.
 *
 * It exists so a phase that REPORTED success cannot end the sequence: `taskkill`
 * exits 0 for trees it never reached, so success is a claim about the request and
 * only `exit` is evidence about the process. Short enough that three waits plus
 * the final confirmation stay far inside any caller's timeout.
 */
const WINDOWS_CLEANUP_PHASE_MS = 300;
const IS_WINDOWS = process.platform === "win32";

/**
 * Spec #168 / ticket #176 — the admission barrier's shell.
 *
 * Only ever used on the contained path, which only exists where strong
 * containment is available (Linux with a delegated cgroup v2 subtree). A
 * contained run is never admitted on Windows, so this constant is never reached
 * there and Windows support is not claimed.
 */
const ADMISSION_SHELL = "/bin/sh";

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
  /**
   * Spec #168 / ticket #176 — the containment model this run REQUIRES.
   *
   * Omitted (the default, and every direct low-level caller) keeps the
   * documented process-group contract unchanged: a `detached: true` child that
   * leads an isolated group, cleaned through its transient identity lease.
   * That is isolation, not containment, and it is honest only because nothing
   * in a fixed argv can `setsid` its way out of the boundary Poiesis claims.
   *
   * Set it when the caller executes arbitrary command TEXT: the boundary is
   * provisioned BEFORE the spawn, the child is admitted into it and that
   * admission is confirmed from the kernel, and settlement uses it. When the
   * capability does not exist on this host, `run()` rejects with
   * `PROCESS_CONTAINMENT_UNAVAILABLE` BEFORE spawning anything.
   */
  containment?: ContainmentModel;
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
 * Spec #168 / ticket #170, extended by ticket #176 — run one managed
 * subprocess to a settled state.
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
 *
 * Spec #168 / ticket #176 bounds what that group IS. It is isolation, not
 * containment: `setsid(2)` and reparenting both leave it. So a caller that
 * executes arbitrary command TEXT passes `options.containment`, and this
 * runner then provisions a real kernel boundary before the spawn
 * (`src/containment.ts`), spawns the child into a Poiesis-owned admission
 * prologue that admits and confirms ITSELF before any caller text can run,
 * settles the boundary with `cgroup.kill`, and — when the host has no such
 * capability, or the admission cannot be confirmed — refuses with a typed
 * error and nothing is reported contained. A caller that passes no
 * `containment` keeps the process-group contract unchanged, which is honest
 * exactly because nothing in a fixed argv can escape it.
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

  // Spec #168 / ticket #176: a caller that requires containment gets the
  // boundary provisioned BEFORE the process exists. When the host cannot
  // provide it this throws `PROCESS_CONTAINMENT_UNAVAILABLE` here, with no
  // process created and nothing to clean — the fail-closed direction.
  const containment: ManagedContainmentLease | null =
    options.containment === undefined
      ? null
      : provisionContainment({
          model: options.containment,
          operationId: leaseIdentity.operationId,
          remediation:
            "Run this operation on a host that provides strong containment — Linux with a delegated cgroup v2 subtree exposing cgroup.kill.",
        });

  return await new Promise<RunResult>((resolve, reject) => {
    // Spec #168 / ticket #176: a contained run is NOT spawned as the command.
    // It is spawned as the Poiesis-owned admission prologue, which receives the
    // resolved processor and its resolved argv as positional parameters and
    // `exec`s them only after it has confirmed its own membership of the leaf.
    // The leaf travels in the environment, out of band, so it can never appear
    // in the command's own argv. The child's `command`/`args` here — and hence
    // the `RunResult` and every observer of this runner — stay the caller's
    // processor and argv, unchanged.
    const contained = containment !== null;
    const spawnEnv = contained ? { ...childEnv, [ADMISSION_LEAF_ENV]: containment!.leaf ?? "" } : childEnv;
    let child: ChildProcess;
    try {
      child = spawn(
        contained ? ADMISSION_SHELL : command,
        contained ? ["-c", ADMISSION_PROLOGUE, ADMISSION_ARGV0, command, ...args] : args,
        {
          cwd: options.cwd,
          env: spawnEnv,
          // The contained child gets a fourth, report-only pipe: the prologue
          // writes its admission confirmation there and closes it before exec,
          // so the command never inherits it.
          stdio: [
            options.input === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe",
            ...(contained ? ["pipe" as const] : []),
          ],
          killSignal: "SIGTERM",
          ...(IS_WINDOWS ? {} : { detached: true }),
        },
      );
    } catch (error) {
      releaseContainment(containment);
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
        releaseChildHandles(child, contained);
        releaseContainment(containment);
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
    /**
     * The in-flight cleanup, or `null` before it starts. A path that must
     * GUARANTEE the boundary was settled before it is released — an admission
     * refusal — awaits this instead of starting a second cleanup.
     */
    let cleanupInFlight: Promise<void> | null = null;
    let settled = false;
    /**
     * Spec #168 / ticket #176 — true until the admission gate has a verdict, and
     * then true again only while a settlement it deferred is being replayed.
     */
    let admissionPending = contained;
    let settlementDeferred = false;
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
      // Spec #168 / ticket #176: a contained run may not settle before its
      // admission verdict exists. Deferring here is what stops a child that
      // finished without reporting from being reported as a clean exit; the
      // deferred settlement is resumed by the admission gate below.
      if (admissionPending) {
        settlementDeferred = true;
        return;
      }
      settled = true;
      clearLingerTimer();
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      if (options.signal !== undefined) options.signal.removeEventListener("abort", onCallerAbort);
      // Exactly one release per settled run, on every outcome.
      releaseContainment(containment);

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
      if (lingerTimer !== null || cleanupComplete || cleanupStarted) return;
      lingerTimer = setTimeout(() => {
        lingerTimer = null;
        void beginCleanup();
      }, POST_EXIT_GRACE_MS);
    };

    /**
     * Release the runtime resources this run owns, so a bounded rejection is
     * not itself a way to leave Node blocked.
     *
     * Only the ends Poiesis opened are closed here. The child is deliberately
     * NOT signalled, killed, or escalated: a refused or unresolved cleanup
     * means its identity is unconfirmed, so any further signal — by group or
     * by the still-held PID — could reach an unrelated process that inherited
     * it. Holding a handle on a process Poiesis proved it could not touch
     * would just extend the same unbounded wait the rejection ends.
     */
    const releaseOwnedResources = (): void => {
      releaseChildHandles(child, contained);
    };

    /**
     * Clean the managed containment, then the managed process group, exactly
     * once, and only then let the run settle.
     *
     * Containment comes first and is the stronger boundary: a cgroup leaf
     * reaches a descendant that `setsid`'d or was reparented out of the group.
     * The POSIX process-group lease still settles afterwards so the run keeps
     * its per-PID identity evidence; either phase failing is a cleanup error,
     * and the first one recorded is the one reported.
     *
     * The returned promise is the cleanup itself, so a caller that must know the
     * boundary is settled gets that fact rather than a second cleanup.
     */
    const beginCleanup = (): Promise<void> => {
      if (cleanupStarted) return cleanupInFlight ?? Promise.resolve();
      cleanupStarted = true;
      clearLingerTimer();
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      cleanupInFlight = (async (): Promise<void> => {
        if (containment !== null) {
          try {
            await settleContainment(containment);
          } catch (error) {
            cleanupError ??= asPoiesisError(error);
          }
        }
        if (lease !== null) {
          try {
            await settleManagedProcessLease(lease);
          } catch (error) {
            cleanupError ??= asPoiesisError(error);
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
        // A REFUSED or UNRESOLVED cleanup stopped for the one reason it cannot
        // fix: it could not prove the target was still the process Poiesis
        // leased, so nothing was signalled and the child is still running.
        // There is no `exit` coming to settle on, so waiting for one would turn
        // a bounded cleanup failure into an unbounded pending run that also
        // loses the typed cleanup error. Settle now with that original error —
        // it outranks timeout, cancellation, infrastructure, and exit code
        // because a process Poiesis spawned may still be running.
        if (cleanupError !== null && !childExited) {
          releaseOwnedResources();
          settle();
          return;
        }
        tryFinalize();
      })();
      return cleanupInFlight;
    };

    const beginTermination = (): void => {
      if (cleanupComplete) return;
      void beginCleanup();
    };

    /**
     * Windows has no POSIX process groups, so `taskkill /T` drives the tree.
     *
     * Spec #168 / ticket #176: every phase is followed by a bounded wait for the
     * one piece of evidence this runner actually holds — its own `exit` event —
     * and escalation never stops early because a phase REPORTED SUCCESS.
     * `taskkill /T` exits 0 for trees it never reached, so a graceful success is
     * a claim about the request, not about the process; if the child has not
     * exited when the claim is made, the forced phase still runs, then
     * `child.kill`, and only then is the run refused. When nothing confirmed the
     * exit, the run must say so: signalling success, a timeout, or a cancellation
     * would describe a settled run while the process Poiesis spawned is still
     * running.
     */
    const terminateWindowsTree = async (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined) return;
      const gracefulSucceeded = await runTaskkill(pid);
      // A PID is meaningful only while it is still the process Poiesis spawned.
      // Every escalation below is therefore gated on the child not having
      // exited, so a reused PID is never addressed.
      if (await waitForChildExit(WINDOWS_CLEANUP_PHASE_MS)) return;
      if (settled || childExited) return;
      // The forced phase is attempted whether or not the graceful one reported
      // success: exit 0 from `taskkill` is a claim about the request, and the
      // child is still running.
      const forcedSucceeded = await runTaskkill(pid, true);
      if (await waitForChildExit(WINDOWS_CLEANUP_PHASE_MS)) return;
      if (settled || childExited) return;
      if (!(gracefulSucceeded || forcedSucceeded)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort after both taskkill phases failed.
        }
      }
      if (await waitForChildExit(WINDOWS_CLEANUP_CONFIRM_MS)) return;
      if (settled || childExited) return;
      cleanupError ??= windowsCleanupUnresolved(command, pid);
    };

    /** Bounded wait for the exit event this run already holds. */
    const waitForChildExit = async (windowMs: number): Promise<boolean> => {
      const deadline = Date.now() + windowMs;
      while (!childExited && !settled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return childExited;
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

    // Spec #168 / ticket #176: the parent decides admission. The prologue can
    // only report a confirmation it obtained from the kernel itself, before it
    // exec'd the command; if that report never arrives, this run is refused
    // whether the child is still live or already finished. There is no
    // "it probably made it" branch.
    if (contained) {
      void (async (): Promise<void> => {
        const outcome = await awaitAdmissionConfirmation(child);
        admissionPending = false;
        if (!outcome.confirmed) {
          try {
            requireConfirmedAdmission(containment!, {
              confirmed: false,
              pid: child.pid ?? -1,
              detail: outcome.detail,
            });
          } catch (error) {
            // A refused admission is a cleanup-class failure, so it keeps the
            // same priority a refused cleanup has: nothing may report success,
            // failure, timeout, or cancellation for a run whose containment was
            // never proven. It is recorded with `??=` for the same reason every
            // other cleanup error is: the FIRST fact recorded is the one the
            // operator has to act on, and an earlier failure is not replaced by a
            // refusal that happened to be detected later.
            cleanupError ??= asPoiesisError(error);
            try {
              child.kill("SIGKILL");
            } catch {
              // Best effort; the process never left Poiesis's hands.
            }
            // Installed BEFORE the await below: a late spawn error arriving while
            // the boundary settles would otherwise be an unhandled `error` event.
            child.on("error", () => {
              // The refusal is the reported outcome; swallow the late spawn
              // error so it cannot surface as an unhandled rejection.
            });
            // The leaf is already PROVISIONED and the prologue may already be
            // INSIDE it, so the boundary has to be settled before it can be
            // released: a leaf the kernel still reports as populated can never
            // be removed, and releasing one is how a half-admitted leaf leaks.
            // `beginCleanup` settles it and settles the process-group lease, and
            // returns the cleanup already running when one is in flight rather
            // than starting a second.
            await beginCleanup();
            releaseOwnedResources();
            settle();
            return;
          }
        }
        if (settled) return;
        // Replay whatever settlement the refusal check deferred.
        if (settlementDeferred) {
          settlementDeferred = false;
          settle();
          return;
        }
        armRunControl();
      })();
    } else {
      armRunControl();
    }

    /**
     * The caller's cancellation and the command bound only start once the run
     * is real: a contained run has its admission verdict first, so an abort or
     * a timeout can never fire against a process Poiesis has not yet placed.
     */
    function armRunControl(): void {
      if (settled) return;
      // Spec #168 / ticket #176 — re-read the signal ATOMICALLY with the
      // subscription below. `run()` checked `aborted` before the spawn, but a
      // contained run only reaches this point after its admission gate has a
      // verdict, and the caller may have aborted anywhere in between. Node's
      // `AbortSignal` does NOT replay `abort` to a listener added after the
      // signal is already aborted, so installing the listener alone would drop
      // that cancellation on the floor and let the caller's command text run to
      // completion — which, for Verify, is a `verified` result and an
      // authoritative receipt for a run the operator cancelled. Reading the flag
      // and subscribing here closes that window with the SAME cancellation path
      // a live signal takes, so the outcome is identical either way.
      if (options.signal?.aborted === true) {
        onCallerAbort();
        return;
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
    }

    function onCallerAbort(): void {
      if (settled || cancelled) return;
      cancelled = true;
      beginTermination();
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

/**
 * Spec #168 / ticket #176 — wait for the admission prologue's confirmation.
 *
 * The prologue writes one byte to its report pipe only AFTER it has read its own
 * PID back out of `cgroup.procs`. Every other outcome — the report channel
 * closing with no byte, a channel error, the child finishing first, or the bound
 * elapsing — is a refusal with a reason, EXCEPT that a refusal first drains the
 * channel for {@link ADMISSION_DRAIN_MS}: the prologue writes the byte and then
 * `exec`s immediately, so `exit` can legitimately be delivered before that byte
 * has been read, and refusing on the ordering alone would report a real
 * admission as an unconfirmed one. This function never infers admission from
 * liveness, from a PID listing sampled later, or from the child exiting
 * successfully — it only ever accepts a byte the prologue actually wrote.
 */
async function awaitAdmissionConfirmation(child: ChildProcess): Promise<{
  confirmed: boolean;
  detail: string;
}> {
  const report = child.stdio[3];
  if (report === undefined || report === null) {
    return { confirmed: false, detail: "the admission report channel was never opened" };
  }
  const confirmedDetail = "the prologue confirmed its own kernel membership";
  const declaredExit = new Promise<{ confirmed: false; detail: string }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({
        confirmed: false,
        detail: `the admission prologue finished without reporting (exit code ${String(code)}, signal ${String(signal)})`,
      });
    });
  });
  const channelClosed = new Promise<{ confirmed: false; detail: string }>((resolve) => {
    report.once("error", () => resolve({ confirmed: false, detail: "the admission report channel failed" }));
    report.once("close", () =>
      resolve({ confirmed: false, detail: "the admission report channel closed without reporting" }),
    );
    report.once("end", () =>
      resolve({ confirmed: false, detail: "the admission report channel ended without reporting" }),
    );
  });
  const confirmed = new Promise<{ confirmed: true; detail: string }>((resolve) => {
    report.on("data", (chunk: Buffer | string) => {
      if (isAdmissionConfirmation(chunk.toString("utf8"))) {
        resolve({ confirmed: true, detail: confirmedDetail });
      }
    });
  });
  const elapsed = new Promise<{ confirmed: false; detail: string }>((resolve) => {
    const timer = setTimeout(
      () => resolve({ confirmed: false, detail: `no admission confirmation within ${ADMISSION_CONFIRM_MS}ms` }),
      ADMISSION_CONFIRM_MS,
    );
    // The bound must not be what keeps Node alive once the report arrives.
    timer.unref?.();
  });
  const outcome = await Promise.race([confirmed, declaredExit, channelClosed, elapsed]);
  // The refusal reason stays whatever the gate actually observed; the drain only
  // gets the chance to convert an ordering artifact into a real verdict.
  const verdict = outcome.confirmed ? outcome : ((await drainAdmissionReport(report)) ?? outcome);
  // The report channel is single-use: the prologue closes it before `exec`, so
  // nothing further is read from it and the command never inherits the pipe.
  report.removeAllListeners();
  const drained = report as Partial<NodeJS.ReadableStream> & { resume?: () => void; unref?: () => void };
  drained.resume?.();
  drained.unref?.();
  return verdict;
}

/**
 * Spec #168 / ticket #176 — one bounded read of the report channel that the race
 * above already gave up on.
 *
 * Resolves the confirmation the moment a byte carrying it arrives, `null` when the
 * channel closes, ends, fails, or the bound elapses without one. It is the ONLY
 * thing standing between "the byte is in flight" and a spurious refusal, and it
 * cannot create an admission: it accepts the same byte `isAdmissionConfirmation`
 * accepts and nothing else.
 */
function drainAdmissionReport(
  report: NonNullable<ChildProcess["stdio"][3]>,
): Promise<{ confirmed: true; detail: string } | null> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const finish = (outcome: { confirmed: true; detail: string } | null): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      report.off("data", onData);
      report.off("close", onDrained);
      report.off("end", onDrained);
      report.off("error", onDrained);
      resolve(outcome);
    };
    function onData(chunk: Buffer | string): void {
      if (isAdmissionConfirmation(chunk.toString("utf8"))) {
        finish({ confirmed: true, detail: "the prologue confirmed its own kernel membership" });
      }
    }
    function onDrained(): void {
      finish(null);
    }
    report.on("data", onData);
    report.once("close", onDrained);
    report.once("end", onDrained);
    report.once("error", onDrained);
    // A paused channel with bytes already buffered would otherwise never deliver
    // them inside the bound.
    (report as Partial<NodeJS.ReadableStream>).resume?.();
    timer = setTimeout(() => finish(null), ADMISSION_DRAIN_MS);
    timer.unref?.();
  });
}

/**
 * Release every runtime handle a failed run owns: the child's own stdio ends,
 * its process handle, and — for a contained run — the admission report pipe.
 * Best effort and idempotent: it runs on paths where the outcome has already
 * been decided, so a throw here would replace a real typed failure with an
 * unhelpful one.
 */
function releaseChildHandles(child: ChildProcess, contained: boolean): void {
  const streams: ({ destroy?: () => void } | null | undefined)[] = [
    child.stdin,
    child.stdout,
    child.stderr,
    ...(contained ? [child.stdio[3]] : []),
  ];
  for (const stream of streams) {
    try {
      stream?.destroy?.();
    } catch {
      // Already closed.
    }
  }
  try {
    child.unref();
  } catch {
    // The process handle may already be gone.
  }
}

/**
 * Spec #168 / ticket #176 — the Windows cleanup failure with nothing left to
 * try. The three signalling phases are named in the details because they are
 * the whole of what Poiesis attempted, and `platform` is carried so an
 * operator can tell this apart from the POSIX lease's own unresolved failure.
 */
function windowsCleanupUnresolved(command: string, pid: number): PoiesisError {
  return new PoiesisError(
    "PROCESS_CLEANUP_UNRESOLVED",
    `${command} cleanup could not confirm that the process Poiesis spawned (PID ${pid}) exited`,
    {
      command,
      pid,
      containment: "process-group",
      // The branch that ran is what the report must name, not whatever the
      // platform reads as by the time the error is constructed.
      platform: IS_WINDOWS ? "win32" : process.platform,
      phases: ["taskkill", "taskkill /F", "child.kill"],
      confirmed: false,
    },
  );
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

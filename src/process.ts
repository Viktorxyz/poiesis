import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { PoiesisError, asPoiesisError } from "./errors.js";
import {
  ADMISSION_ARGV0,
  ADMISSION_CONFIRM_MS,
  ADMISSION_DRAIN_MS,
  ADMISSION_LEAF_ENV,
  ADMISSION_PROLOGUE,
  ADMISSION_TOKEN_ENV,
  EXECUTION_TOKEN_ENV,
  encodeReleasePayload,
  mintStartupTokens,
  parseStartupReport,
  provisionContainment,
  releaseContainment,
  requireConfirmedAdmission,
  requireValidatedStartupIdentity,
  settleContainment,
  type ContainmentModel,
  type ManagedContainmentLease,
  type StartupIdentity,
  type StartupReportKind,
} from "./containment.js";
import {
  createManagedProcessLease,
  isManagedProcessLeaseLabel,
  readManagedProcessIdentity,
  settleManagedProcessLease,
  validateManagedProcessLease,
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
 * Spec #168 / ticket #182 — bounded window a refused startup waits for the child's
 * OWN exit before it reports what happened.
 *
 * A refusal that happens before a lease exists has no authority to signal
 * anything: no PID signal, because the identity was never confirmed, and no group
 * signal, because no group was ever leased. Revoking the gate is the only thing
 * this runner may do, and it works only because a pre-`exec` prologue exits when
 * its control channel closes. So the proof that it did is the `exit` event this
 * runner already holds — and if that event never arrives, Poiesis says a process
 * it spawned may still be running instead of reporting a settled refusal.
 */
const PRE_EXEC_EXIT_MS = 2_000;

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
 * inherited output. When the window elapses the managed cleanup runs — the
 * contained boundary where there is one, otherwise the leased process group
 * (see `settleManagedProcessLease`) — and the run settles with it, so a leaked
 * background descendant can never hold a Poiesis operation open indefinitely.
 */
const POST_EXIT_GRACE_MS = 2_000;

/** Conventional exit status for a command cancelled by SIGINT-equivalent. */
const CANCELLED_EXIT_CODE = 130;

/**
 * Spec #168 / ticket #182 — how far the two-phase startup got. It is the only
 * input to "what may cleanup do", because each phase earns a different authority:
 * a confirmed identity may address a group, and a confirmed admission makes the
 * cgroup the sole authority.
 */
type StartupAuthority = "pre-lease" | "leased" | "admitted";

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
 * Spec #168 / ticket #170, extended by tickets #176 and #180 — run one managed
 * subprocess to a settled state.
 *
 * Every exit path — success, non-zero exit, timeout, cancellation, and
 * internal error — settles only AFTER the managed cleanup has run: the
 * process group the transient identity lease names (`src/process-tree.ts`),
 * or the kernel boundary this run was contained in
 * (`src/containment.ts`). The child is spawned `detached: true`, so it leads an
 * isolated process group that cannot be reached from Poiesis's own group or the
 * terminal's, and cleanup targets are derived from that lease alone: there is
 * no process-name, port, user, or age matching anywhere in this path.
 *
 * A descendant that outlives the child — the classic "successful command that
 * leaks a background process" — is bounded two different ways, and which one
 * applies is a property of the leader rather than of the descendant. While the
 * leased leader is still provably the process Poiesis spawned, the group is
 * still Poiesis's to signal, and the leak is cleaned through both a graceful
 * and a forced phase. Once that leader has exited, its PID — which IS the
 * group id — is a number any later process may be handed, so nothing about the
 * surviving group is provable any more: Poiesis sends no further signal and
 * reports the run as an unresolved cleanup instead of a settled one. That is
 * the honest direction, and it is why the surface that runs caller-supplied
 * command text is contained rather than group-isolated: a cgroup leaf is
 * emptied atomically and does not depend on a leader being alive.
 *
 * Spec #168 / ticket #176 bounds what that group IS. It is isolation, not
 * containment: `setsid(2)` and reparenting both leave it. So a caller that
 * executes arbitrary command TEXT passes `options.containment`, and this
 * runner then provisions a real kernel boundary before the spawn
 * (`src/containment.ts`) and starts the child through the TWO-PHASE startup
 * protocol in that module, settles the boundary with `cgroup.kill`, and — when
 * the host has no such capability, or the startup cannot be confirmed — refuses
 * with a typed error and nothing is reported contained. A caller that passes no
 * `containment` keeps the process-group contract unchanged, which is honest
 * exactly because nothing in a fixed argv can escape it.
 *
 * Spec #168 / ticket #182 — what the two-phase protocol is for, and why cleanup
 * is decided by the phase a run reached:
 *
 *   1. the Poiesis-owned prologue reports its own kernel PID, process-group id,
 *      and process-start identity, and WAITS. It is spawned with no caller text
 *      in its argv at all;
 *   2. this runner checks that report against `child.pid` and against a fresh
 *      kernel read (`readManagedProcessIdentity`), leases the identity as a LIVE
 *      validated lease, and only then sends the admission token;
 *   3. the prologue admits itself into the provisioned leaf, confirms that
 *      membership is bound to the SAME identity, reports that, and waits for a
 *      DISTINCT execution token;
 *   4. this runner binds the admitted report to the leased identity, releases the
 *      caller's exact argv, and only then arms stdin, the command timeout, and
 *      cancellation.
 *
 * Cleanup authority follows from how far that got. Before a validated lease
 * there is no authority to signal anything, so the gate is REVOKED (a pre-`exec`
 * prologue exits when its channel closes), the leaf is settled, and the child's
 * own linked exit is required — no proof of it is `PROCESS_CLEANUP_UNRESOLVED`.
 * After a validated lease but before a confirmed admission the group is settled
 * through the lease AND the leaf is settled independently, because an empty leaf
 * cannot prove anything about a leader that may never have entered it. After a
 * confirmed admission the cgroup is the authority and no group signal runs at
 * all.
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
    // Spec #168 / ticket #182: a contained run is NOT spawned as the command, and
    // it is not spawned carrying the command either. It is spawned as the
    // Poiesis-owned startup prologue with Poiesis-owned argv only; the caller's
    // processor and argv are held here until the prologue has been admitted and
    // the parent has bound that admission to a live validated lease. The leaf and
    // both gate tokens travel in the environment, out of band, so none of them can
    // ever appear in the command's own argv.
    const contained = containment !== null;
    const startup = contained ? mintStartupTokens() : null;
    const spawnEnv = contained
      ? {
          ...childEnv,
          [ADMISSION_LEAF_ENV]: containment!.leaf ?? "",
          [ADMISSION_TOKEN_ENV]: startup!.admissionToken,
          [EXECUTION_TOKEN_ENV]: startup!.executionToken,
        }
      : childEnv;
    let child: ChildProcess;
    try {
      child = spawn(
        contained ? ADMISSION_SHELL : command,
        contained ? ["-c", ADMISSION_PROLOGUE, ADMISSION_ARGV0] : args,
        {
          cwd: options.cwd,
          env: spawnEnv,
          // The contained child's stdin is Poiesis's own gate: the admission
          // token, the execution token, and the released argv all travel through
          // it, and the caller-supplied input is written to it only after
          // authority exists. It is a pipe even when the caller supplied no
          // input — the protocol needs a parent→child channel, and for any fd
          // above 0 Node gives the parent the reading end. An uncontained caller
          // keeps the documented stdio shape exactly.
          //
          // The contained child also gets a fourth, report-only pipe: the
          // prologue writes its identity and admitted reports there and closes
          // it before exec, so the command never inherits it.
          stdio: [
            contained ? "pipe" : options.input === undefined ? "ignore" : "pipe",
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
    //
    // Spec #168 / ticket #182: a contained run does NOT lease at spawn time. Its
    // lease is established only after the prologue's identity report has been
    // checked against the kernel, so a lease can never exist for a process whose
    // identity this run never confirmed.
    let lease: ManagedProcessLease | null = null;
    if (!IS_WINDOWS && !contained && child.pid !== undefined) {
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
    /**
     * Spec #168 / ticket #177 — an admission refusal, kept SEPARATE from
     * {@link cleanupError}.
     *
     * Both mean "nothing may report a settled run", but they are not the same
     * fact and neither may hide the other. A cleanup failure recorded after a
     * refusal means a member of a boundary Poiesis owned may still be running,
     * which is the stronger claim and therefore the one reported; the refusal
     * is carried forward on that error as context instead of being dropped, and
     * is reported on its own whenever cleanup could confirm the boundary.
     */
    let containmentRefusal: PoiesisError | null = null;
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
    /**
     * Spec #168 / ticket #182 — how much authority this run has earned, which is
     * the only thing that decides what cleanup may do.
     *
     *   `pre-lease` — nothing about the child has been confirmed. No PID may be
     *     signalled and no group may be addressed; the gate is revoked and the
     *     child's own exit is the only acceptable proof.
     *   `leased` — the identity was confirmed against the kernel and leased, but
     *     the admission is not confirmed. The group is Poiesis's to settle, and
     *     the leaf still has to be settled on its own.
     *   `admitted` — the prologue confirmed membership bound to that identity. The
     *     cgroup is the authority and no group settlement runs at all.
     */
    let startupAuthority: StartupAuthority = contained ? "pre-lease" : "admitted";
    /** The identity the first phase leased, or `null` while none exists. */
    let leasedIdentity: StartupIdentity | null = null;
    /**
     * Spec #168 / ticket #182 — the live report reader, while a gate is waiting.
     * A cancellation reaches it through {@link unwindStartupGate} so a revoked
     * gate ends its bound instead of being waited out.
     */
    let startupReader: StartupReportReader | null = null;

    /**
     * Spec #168 / ticket #182 — revoke Poiesis's own control channel.
     *
     * Closing the gate is the only thing this runner may do to a child it cannot
     * identify, and it is deliberately the FIRST thing a refused or cancelled
     * startup does: a prologue that is still waiting for authority exits when
     * its channel closes, which is what turns "Poiesis has no authority here"
     * into a process that is actually gone instead of one that has to be killed
     * by a number Poiesis may not trust.
     *
     * The caller's own stdin is that channel, so revoking also drops any input
     * the caller had queued for a command that will never be released. That is
     * the point: after a revocation there is nothing left to hand it.
     */
    const revokeStartupControl = (): void => {
      try {
        child.stdin?.destroy();
      } catch {
        // Already closed, already revoked, or never opened.
      }
    };

    /**
     * Spec #168 / ticket #182 — release the caller's exact processor argv.
     *
     * Only ever called once authority exists: a validated lease AND a confirmed
     * admission bound to that lease. The frames are exact (see
     * `encodeReleasePayload`), so what the processor `exec`s is byte-identical to
     * what the caller passed, and the count the parent sends first means the
     * prologue consumes exactly these frames and never a byte of the caller's own
     * stdin.
     */
    const releaseCallerArgv = (): void => {
      const gate = child.stdin;
      if (gate === null) {
        throw new PoiesisError(
          "PROCESS_CONTAINMENT_REFUSED",
          `Managed command ${child.pid ?? -1} was admitted but the release channel was never opened`,
          {
            containment: containment?.model ?? "cgroup-v2",
            pid: child.pid ?? -1,
            reason: "ADMISSION_UNCONFIRMED",
            detail: "the startup control channel was never opened",
            confirmed: false,
          },
        );
      }
      // The execution token is a DISTINCT frame, sent only now — after the
      // admission was confirmed for the leased identity — and immediately
      // followed by the argv it authorises.
      try {
        child.stdin?.write(`E ${startup!.executionToken}\n`);
      } catch {
        // Refused by the pipe; the child is gone or closing, and nothing runs.
      }
      gate.write(encodeReleasePayload([command, ...args]));
      if (options.input === undefined) {
        // Nothing more will be written on this channel, so the command the
        // prologue `exec`s reads an immediate EOF exactly as it would have read
        // the ignored stdin of an uncontained run.
        gate.end();
      }
    };

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
      // The gate-phase listener is the same cancellation, observed earlier; it is
      // detached by the startup protocol itself, and again here so a settled run
      // never leaves one attached.
      detachGateAbortListener();
      // Exactly one release per settled run, on every outcome.
      releaseContainment(containment);

      const result = buildResult();
      // A refused or unresolved cleanup outranks every other outcome: it
      // means a process Poiesis spawned may still be running, so the run
      // must not report success, failure, or cancellation as settled.
      //
      // Spec #168 / ticket #177: an unconfirmed admission is the same class of
      // fact — nothing may report success, failure, timeout, or cancellation
      // for a run whose containment was never proven — so it shares that slot.
      // A cleanup failure recorded after the refusal still wins: "Poiesis could
      // not confirm it stopped what it started" is the surviving-process fact an
      // operator has to act on, and the refusal travels with it as context
      // rather than being dropped or masking it.
      const refusal = cleanupError ?? containmentRefusal;
      if (refusal !== null) {
        reject(withContainmentRefusalContext(refusal, containmentRefusal));
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
      // Spec #168 / ticket #182: a contained run has no startup verdict yet, and
      // cleanup before one is not merely early — it would REVOKE the gate of a
      // startup that is still in progress and settle the run on a fact the
      // protocol has not established. The decision is deferred instead, and the
      // gate replays it as soon as it has a verdict.
      if (admissionPending) {
        settlementDeferred = true;
        return;
      }
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
     * Only the ends Poiesis opened are closed here, and this happens on EVERY
     * cleanup error — including one recorded after the child exited, because an
     * inherited pipe still open on a leaked descendant is exactly the handle
     * that would keep Node blocked. The child is deliberately NOT signalled,
     * killed, or escalated: a refused or unresolved cleanup means its identity
     * is unconfirmed, so any further signal — by group or by the still-held PID
     * — could reach an unrelated process that inherited it. Holding a handle on
     * a process Poiesis proved it could not touch would just extend the same
     * unbounded wait the rejection ends.
     */
    const releaseOwnedResources = (): void => {
      releaseChildHandles(child, contained);
    };

    /**
     * Spec #168 / ticket #182 — settle a CONTAINED run, and only the authority the
     * startup actually earned may be used.
     *
     * The gate is revoked FIRST on every path where the prologue might still be
     * pre-`exec`, so a child Poiesis may not signal can still be made to leave by
     * closing the channel it is waiting on. Then, and only then:
     *
     *   `pre-lease` — the leaf is settled, and the child's own linked exit is
     *     required. No PID signal is sent, because no identity was confirmed, and
     *     no group signal is sent, because no group was leased. An EMPTY leaf is
     *     not proof of anything here: the child may never have entered it, which
     *     is exactly why the linked exit, and not the emptiness, is what this
     *     phase waits for. No proof is `PROCESS_CLEANUP_UNRESOLVED`.
     *   `leased` — the leaf is settled AND the leased group is settled, and the
     *     two are independent. The child may be inside the leaf, outside it, or
     *     between the two; an empty leaf cannot prove that a leader outside it
     *     stopped, and the group settlement can only be driven because the lease
     *     re-confirms the leader's identity before every signal it sends.
     *   `admitted` — the cgroup is the authority and no group settlement runs,
     *     which is the same conclusion an unrefused contained run rests on.
     */
    const settleContainedRun = async (): Promise<void> => {
      if (startupAuthority !== "admitted") revokeStartupControl();
      try {
        await settleContainment(containment!);
      } catch (error) {
        cleanupError ??= asPoiesisError(error);
      }
      if (startupAuthority === "admitted") return;
      if (startupAuthority === "pre-lease") {
        if (childExited || (await waitForChildExit(PRE_EXEC_EXIT_MS))) return;
        cleanupError ??= preExecStartupUnresolved(command, child.pid ?? -1);
        return;
      }
      // `leased`: the group is Poiesis's to settle, and it is settled through the
      // lease — the only module that may signal a POSIX process group.
      if (lease === null) return;
      try {
        await settleManagedProcessLease(lease);
      } catch (error) {
        cleanupError ??= asPoiesisError(error);
      }
    };

    /**
     * Clean the managed containment, then the managed process group, exactly
     * once, and only then let the run settle.
     *
     * Spec #168 / ticket #180: containment comes first and is the authority. A
     * cgroup leaf reaches a descendant that `setsid`'d or was reparented out of
     * the group, and it is emptied atomically by `cgroup.kill` and confirmed by
     * the kernel's own `populated` flag. Once that confirmation has landed there
     * is nothing left for a process-group settlement to do, and running one
     * anyway would only re-derive a weaker authority: group liveness proves
     * absence, never ownership. So a run whose containment settled cleanly skips
     * the group phase entirely.
     *
     * Spec #168 / ticket #182 sharpens that for a contained run: which phase it
     * settles in is decided by the startup authority, not by the emptiness of the
     * leaf (see {@link settleContainedRun}).
     *
     * The group phase still runs — and is still the only phase — when there was
     * no containment, when containment could not confirm the leaf is empty, and
     * on Windows, where there are no POSIX groups at all. Either phase failing
     * is a cleanup error, and the first one recorded is the one reported.
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
        if (contained) {
          await settleContainedRun();
          finishCleanup();
          return;
        }
        if (lease === null) {
          // Documented Windows model: no POSIX process groups and no readable
          // process-start identity, so `taskkill /PID <pid> /T` is the only
          // way to reach the tree, and it is meaningful ONLY while the PID is
          // still the process Poiesis spawned. Once the child has exited that
          // PID has been reaped and may already be recycled, so addressing it
          // — for a normal completion or for the linger window — could kill an
          // unrelated process. Nothing is therefore signalled once
          // `childExited` is set; a normal Windows run is simply already
          // settled.
          if (IS_WINDOWS && !childExited) await terminateWindowsTree();
        } else {
          try {
            await settleManagedProcessLease(lease);
          } catch (error) {
            cleanupError ??= asPoiesisError(error);
          }
        }
        finishCleanup();
      })();
      return cleanupInFlight;
    };

    /**
     * The tail every cleanup shares: release the runtime handles this run owns
     * when it could not confirm what it stopped, then settle or finalize.
     */
    const finishCleanup = (): void => {
      // Every phase has now been attempted. Nothing further is signalled, and a
      // run whose cleanup could not be confirmed may not report success.
      cleanupComplete = true;
      // Spec #168 / ticket #177: EVERY cleanup error releases the runtime
      // handles this run owns before it settles or rejects — no longer only
      // the case where the child was still live. The two are independent: a
      // leader that already exited can still leave a DESCENDANT holding the
      // inherited stdout/stderr, and those open pipes are precisely what
      // would keep Node blocked after a run that has already given up. A
      // bounded rejection must not be a way to leave the runtime holding
      // handles for a process Poiesis can no longer reach.
      if (cleanupError !== null) {
        releaseOwnedResources();
        settle();
        return;
      }
      // A REFUSED or UNRESOLVED cleanup stopped for the one reason it cannot
      // fix: it could not prove the target was still the process Poiesis
      // leased, so nothing was signalled and the child is still running.
      // There is no `exit` coming to settle on, so waiting for one would turn
      // a bounded cleanup failure into an unbounded pending run that also
      // loses the typed cleanup error. Settle now with that original error —
      // it outranks timeout, cancellation, infrastructure, and exit code
      // because a process Poiesis spawned may still be running.
      tryFinalize();
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
     * exited when the claim is made, the forced phase still runs, and so does
     * the `child.kill` this runner already holds a handle for. Only then is the
     * run refused, and it says exactly that: signalling success, a timeout, or a
     * cancellation would describe a settled run while the process Poiesis
     * spawned is still running.
     *
     * Spec #168 / ticket #177: `child.kill` is no longer conditioned on what
     * `taskkill` reported. Both taskkill phases reporting success is evidence
     * about two REQUESTS, and the only evidence about the process is still the
     * absence of an `exit`, so the escalation that costs nothing but a bounded
     * wait is always taken. Every PID-directed step is gated on the child not
     * having exited: once that PID has been reaped it may already be recycled,
     * and addressing it — for a normal completion, for the linger window, or
     * for this cleanup — could kill an unrelated process.
     */
    const terminateWindowsTree = async (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined || settled || childExited) return;
      await runTaskkill(pid);
      if (await waitForChildExit(WINDOWS_CLEANUP_PHASE_MS)) return;
      if (settled || childExited) return;
      // The forced phase is attempted whether or not the graceful one reported
      // success: exit 0 from `taskkill` is a claim about the request, and the
      // child is still running.
      await runTaskkill(pid, true);
      if (await waitForChildExit(WINDOWS_CLEANUP_PHASE_MS)) return;
      if (settled || childExited) return;
      // The last phase is the handle this runner still holds, so it is eligible
      // for exactly as long as the child has not exited — and eligible
      // regardless of what either taskkill claimed.
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort: the handle may have gone already. Whether it worked is
        // decided below by the one observation this runner can actually make.
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

    // Spec #168 / ticket #182: the parent conducts BOTH startup phases and
    // decides both. Nothing here infers admission from liveness, from a PID
    // listing sampled later, or from the child exiting successfully: a phase
    // passes only on a report the prologue actually wrote, and every report has
    // to agree with what the kernel says about the process at that instant.
    if (contained) {
      armGateAbortListener();
      void (async (): Promise<void> => {
        const reader = createStartupReportReader(child.stdio[3], child);
        startupReader = reader;
        try {
          // Phase 1 — the identity report. No lease, no token, no caller text
          // may exist until the report agrees with `child.pid` AND with a fresh
          // kernel read of that PID's group and start identity.
          const reported = await reader.awaitReport("identity");
          const pid = child.pid ?? -1;
          const leasedReport = reportedIdentityOf(reported);
          requireValidatedStartupIdentity(containment!, {
            pid,
            reported: leasedReport,
            fresh: readManagedProcessIdentity(pid),
            detail: reportFailureDetail(reported),
          });
          const leased = createManagedProcessLease({
            operationId: leaseIdentity.operationId,
            workspaceId: leaseIdentity.workspaceId,
            pid,
            processGroupId: leasedReport?.processGroupId ?? pid,
          });
          const validation = validateManagedProcessLease(leased);
          if (!validation.accepted || !validation.verified || validation.state !== "live") {
            // The lease exists but Poiesis could not prove the process at that PID
            // is the one it started, so nothing derived from it may be acted on.
            requireValidatedStartupIdentity(containment!, {
              pid,
              reported: null,
              fresh: null,
              detail: validation.accepted
                ? `the lease could not be re-confirmed live for PID ${pid}`
                : validation.detail,
            });
          }
          lease = leased;
          leasedIdentity = leasedReport;
          startupAuthority = "leased";
          sendStartupGate(`A ${startup!.admissionToken}`);

          // Phase 2 — the admission, bound to the identity just leased.
          const admitted = await reader.awaitReport("admitted");
          requireConfirmedAdmission(containment!, {
            confirmed: admitted.confirmed,
            pid,
            detail: reportFailureDetail(admitted),
            identity: reportedIdentityOf(admitted),
            expected: leasedIdentity,
          });
          startupAuthority = "admitted";
          releaseCallerArgv();
          admissionPending = false;
        } catch (error) {
          // The startup verdict exists in either form — a refusal, or a
          // cancellation that revoked the protocol — so nothing may defer
          // settlement waiting for one that will never arrive.
          admissionPending = false;
          if (cancelled) {
            // The caller revoked the run while the protocol still held it. There
            // is no startup verdict to report — the caller asked for it to stop —
            // so cleanup runs through whatever authority the protocol had earned
            // and the cancellation is the outcome, unless cleanup cannot confirm
            // what it stopped.
            await beginCleanup();
            settle();
            return;
          }
          // A refused startup is a cleanup-class failure, so it keeps the same
          // priority a refused cleanup has: nothing may report success, failure,
          // timeout, or cancellation for a run whose startup was never proven. It
          // is held in its OWN slot rather than folded into `cleanupError` (see
          // `containmentRefusal`): a settlement failure recorded below it is the
          // stronger surviving-process fact, and folding the refusal in first
          // would let it hide that failure entirely.
          containmentRefusal = asPoiesisError(error);
          // Spec #168 / ticket #182: NOTHING is signalled here. A raw
          // `child.kill` would address a PID whose identity this run may never
          // have confirmed, and a raw group signal would address a group no lease
          // owns. The gate is revoked instead, which is what a pre-`exec` prologue
          // exits on, and `beginCleanup` then settles only with the authority the
          // startup earned — leaf-only plus a required linked exit before a lease
          // existed, leaf and leased group after one did.
          //
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
          await beginCleanup();
          releaseOwnedResources();
          settle();
          return;
        } finally {
          // The report channel has had its verdict; nothing else reads it, and
          // the prologue closes it before `exec`.
          reader.retire();
          startupReader = null;
          detachGateAbortListener();
        }
        if (settled) return;
        // Replay whatever finalization the pending startup decision deferred.
        // It is `tryFinalize` rather than `settle()` because the cleanup that
        // finalization owes has still not run — the gate only decides WHEN, never
        // WHETHER.
        if (settlementDeferred) {
          settlementDeferred = false;
          tryFinalize();
          return;
        }
        armRunControl();
      })();
    } else {
      armRunControl();
    }

    /**
     * Send one gate frame to the child.
     *
     * A failed write is not reported here: the child is gone or the channel is
     * closed, which the gate itself reports as a refusal, and the caller text it
     * would have carried cannot run either way. What matters — that the frame is
     * never written before its authority exists — is a property of the protocol
     * above, not of this write.
     */
    function sendStartupGate(frame: string): void {
      try {
        child.stdin?.write(`${frame}\n`);
      } catch {
        // Refused by the pipe; the phase that follows decides the outcome.
      }
    }

    /**
     * Spec #168 / ticket #182 — the cancellation that arrives DURING a gate.
     *
     * The command timeout and the caller's stdin deliberately stay unarmed until
     * authority exists, but a cancellation is not something Poiesis may sit on:
     * it records the cancellation, revokes the gate immediately — so no caller
     * text can be released after the caller asked for it to stop — and unwinds
     * the pending gate so cleanup does not wait out a bound the caller has
     * already ended.
     */
    function onGateAbort(): void {
      if (settled || cancelled) return;
      cancelled = true;
      revokeStartupControl();
      unwindStartupGate();
    }

    function unwindStartupGate(): void {
      startupReader?.unwind();
    }

    function armGateAbortListener(): void {
      if (options.signal === undefined || options.signal.aborted) return;
      options.signal.addEventListener("abort", onGateAbort, { once: true });
    }

    function detachGateAbortListener(): void {
      options.signal?.removeEventListener("abort", onGateAbort);
    }

    /**
     * The caller's cancellation and the command bound only start once the run
     * is real: a contained run has a startup verdict first, so an abort or a
     * timeout can never fire against a process Poiesis has not yet placed.
     */
    function armRunControl(): void {
      if (settled) return;
      // Spec #168 / ticket #176 — re-read the signal ATOMICALLY with the
      // subscription below. `run()` checked `aborted` before the spawn, but a
      // contained run only reaches this point after both startup phases, and the
      // caller may have aborted anywhere in between. Node's `AbortSignal` does NOT
      // replay `abort` to a listener added after the signal is already aborted, so
      // installing the listener alone would drop that cancellation on the floor
      // and let the caller's command text run to completion — which, for Verify,
      // is a `verified` result and an authoritative receipt for a run the
      // operator cancelled. Reading the flag and subscribing here closes that
      // window with the SAME cancellation path a live signal takes, so the
      // outcome is identical either way.
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
 * Spec #168 / ticket #182 — ONE reader for the startup report channel, shared by
 * both phases.
 *
 * The two phases read the same pipe in order, so the reader holds complete lines
 * as they arrive rather than subscribing and unsubscribing per phase. That is not
 * an optimisation: the parent sends the admission token itself, so the prologue's
 * admitted report can be written while this runner is between phases, and a
 * reader that only listened during its own phase would drop exactly that line and
 * refuse a run it had admitted.
 *
 * A line is only accepted when it parses AND is the report the waiting phase
 * asked for. A malformed line, or a report for the wrong phase, is a refusal with
 * that fact named — this is the boundary between a Poiesis-owned shell and a
 * parent about to act on what it says, so nothing here guesses at what was meant.
 */
interface StartupReportReader {
  /**
   * Wait for one report of `kind`, bounded, with the ordered drain. Resolves
   * `{ confirmed: false, detail }` for every outcome that is not that report.
   */
  awaitReport(kind: StartupReportKind): Promise<
    { confirmed: true; identity: StartupIdentity } | { confirmed: false; detail: string }
  >;
  /** End the current bound early, because Poiesis revoked the protocol itself. */
  unwind(): void;
  /** Retire this reader's own listeners, leaving a single error sink behind. */
  retire(): void;
}

/** What one startup gate observed. */
type StartupGateOutcome =
  | { readonly confirmed: true; readonly identity: StartupIdentity }
  | { readonly confirmed: false; readonly detail: string };

/** The reported identity, or `null` when the gate observed no usable report. */
function reportedIdentityOf(outcome: StartupGateOutcome): StartupIdentity | null {
  return outcome.confirmed ? outcome.identity : null;
}

/**
 * What the gate observed, as a detail string. A gate that did get its report has
 * no failure to report, and the refusals that consult this only read it when
 * there is no report to compare.
 */
function reportFailureDetail(outcome: StartupGateOutcome): string {
  return outcome.confirmed ? "the prologue reported the identity this run was waiting for" : outcome.detail;
}

function createStartupReportReader(
  report: ChildProcess["stdio"][3],
  child: ChildProcess,
): StartupReportReader {
  const unavailable = (detail: string): { confirmed: false; detail: string } => ({ confirmed: false, detail });
  if (report === undefined || report === null) {
    return {
      awaitReport: async () => unavailable("the startup report channel was never opened"),
      unwind: () => undefined,
      retire: () => undefined,
    };
  }

  interface PendingReport {
    kind: StartupReportKind;
    resolve: (outcome: StartupGateOutcome) => void;
    timer: NodeJS.Timeout;
  }

  let buffered = "";
  const lines: string[] = [];
  let pending: PendingReport | null = null;

  const decide = (
    outcome: { confirmed: true; identity: StartupIdentity } | { confirmed: false; detail: string },
  ): void => {
    const waiting = pending;
    if (waiting === null) return;
    pending = null;
    clearTimeout(waiting.timer);
    waiting.resolve(outcome);
  };

  const inspect = (): void => {
    if (pending === null || lines.length === 0) return;
    const line = lines.shift()!;
    const parsed = parseStartupReport(line);
    if (parsed === null) {
      decide(unavailable(`the startup report channel carried a malformed report: ${bounded(line, 120)}`));
      return;
    }
    if (parsed.kind !== pending.kind) {
      decide(
        unavailable(
          `the startup report channel reported a ${parsed.kind} report where a ${pending.kind} report was required`,
        ),
      );
      return;
    }
    decide({ confirmed: true, identity: parsed.identity });
  };

  // Spec #168 / ticket #178: every listener is held BY REFERENCE so the decision
  // can be retired exactly — this reader's own listeners, and nothing else on the
  // channel.
  const onChunk = (chunk: Buffer | string): void => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      lines.push(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
    inspect();
  };
  const onChannelFailure = (): void => decide(unavailable("the startup report channel failed"));
  const onChannelEnded = (): void => decide(unavailable("the startup report channel ended without reporting"));
  const onChannelClosed = (): void => decide(unavailable("the startup report channel closed without reporting"));
  const onDeclaredExit = (code: number | null, signal: NodeJS.Signals | null): void =>
    decide(
      unavailable(
        `the startup prologue finished without reporting (exit code ${String(code)}, signal ${String(signal)})`,
      ),
    );
  report.on("data", onChunk);
  report.on("error", onChannelFailure);
  report.on("end", onChannelEnded);
  report.on("close", onChannelClosed);
  child.on("exit", onDeclaredExit);

  const awaitKind = (
    kind: StartupReportKind,
    windowMs: number,
  ): Promise<StartupGateOutcome> => {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          if (pending === null) return;
          pending = null;
          resolve(unavailable(`no ${kind} startup report within ${windowMs}ms`));
        },
        windowMs,
      );
      // The bound must not be what keeps Node alive once the report arrives.
      timer.unref?.();
      pending = { kind, resolve, timer };
      inspect();
    });
  };

  return {
    async awaitReport(kind) {
      const outcome = await awaitKind(kind, ADMISSION_CONFIRM_MS);
      if (outcome.confirmed) return outcome;
      const drained = await awaitKind(kind, ADMISSION_DRAIN_MS);
      // The drain only gets the chance to convert an ordering artifact into a
      // real verdict; it can never create one, and it is a bound, not a wait.
      // When it does not, the FIRST observation stays the reported reason: a
      // closed channel explains the refusal better than an elapsed bound does.
      return drained.confirmed ? drained : outcome;
    },
    unwind() {
      decide(unavailable("Poiesis revoked the startup protocol before the report arrived"));
    },
    retire() {
      // A gate still waiting when the protocol ends must be decided, not
      // dropped: a promise nobody resolves is a run nobody settles.
      decide(unavailable("the startup protocol ended before this report arrived"));
      report.off("data", onChunk);
      report.off("error", onChannelFailure);
      report.off("end", onChannelEnded);
      report.off("close", onChannelClosed);
      child.off("exit", onDeclaredExit);
      // Deliberately retained: the channel can still be open (the prologue
      // `exec`s with fd3 closed, but a descendant may hold it), and a late stream
      // failure with no listener is an unhandled `error` event — fatal over a run
      // that has already reported its outcome.
      report.on("error", onSettledChannelError);
      const drained = report as Partial<NodeJS.ReadableStream> & { resume?: () => void; unref?: () => void };
      drained.resume?.();
      drained.unref?.();
    },
  };
}

/**
 * Spec #168 / ticket #178 — the retained no-op error sink for a startup report
 * channel whose decision is already reported.
 *
 * ONE shared function, so re-attaching it is idempotent (a channel holds at most
 * one listener per function) and repeated ownership of one channel can never
 * accumulate sinks.
 */
function onSettledChannelError(): void {
  // The startup verdict is already reported. A late stream failure on a channel
  // nothing reads any more is not a new fact about this run.
}

/**
 * Spec #168 / ticket #182 — the typed failure for a startup that stopped before a
 * lease existed and whose child never exited.
 *
 * It says exactly what happened and, just as importantly, what was NOT done: no
 * signal was sent, because no identity was ever confirmed to send one to. The
 * startup refusal that caused it travels on as bounded context, so an operator
 * learns both the reason the startup stopped and the fact that a process Poiesis
 * spawned may still be running.
 */
function preExecStartupUnresolved(command: string, pid: number): PoiesisError {
  return new PoiesisError(
    "PROCESS_CLEANUP_UNRESOLVED",
    `${command} startup could not confirm that the process Poiesis spawned (PID ${pid}) exited before its admission was settled, and Poiesis had no confirmed identity to signal it with`,
    {
      command,
      pid,
      containment: "cgroup-v2",
      reason: "STARTUP_EXIT_UNCONFIRMED",
      phase: "startup",
      startupAuthority: "pre-lease",
      signalsSent: [],
      membersEnumerated: false,
      confirmed: false,
    },
  );
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
 * Spec #168 / ticket #177 — carry an admission refusal forward as bounded
 * context on the error that IS reported.
 *
 * When cleanup could confirm the boundary, the refusal is reported on its own
 * and nothing is added. When cleanup could NOT confirm it, the cleanup failure
 * is the stronger claim — a member of a boundary Poiesis owned may still be
 * running — and it is reported with the refusal attached, so the operator still
 * learns that admission was never confirmed without either fact hiding the
 * other. Only bounded, Poiesis-owned strings are copied; the refusal's own
 * details stay where they are.
 */
function withContainmentRefusalContext(failure: PoiesisError, refusal: PoiesisError | null): PoiesisError {
  if (refusal === null || failure.code === refusal.code) return failure;
  if (failure.details.containmentRefusal !== undefined) return failure;
  const detail = refusal.details;
  failure.details.containmentRefusal = {
    code: refusal.code,
    ...(typeof detail.reason === "string" ? { reason: detail.reason } : {}),
    ...(typeof detail.detail === "string" ? { detail: detail.detail } : {}),
  };
  return failure;
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

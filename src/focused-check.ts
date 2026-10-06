/**
 * Spec #168 / ticket #172 — the ONE scope-aware check executor.
 *
 * Before this module a Worker that wanted fast feedback had exactly one
 * route: run a command itself and read raw shell output. Nothing recorded
 * WHICH command failed, in WHICH workspace state, for HOW long, or WHY — so
 * an unchanged failure looked exactly like a fresh one and the only rational
 * response was another identical run. That is the loop the Spec set out to
 * remove.
 *
 * `executeCheck` is the single seam, with two deliberately unequal scopes:
 *
 *   - `focused` — EXPLICIT commands, a Poiesis-OWNED candidate workspace
 *     that may be dirty, bounded per-command evidence, a deterministic
 *     action fingerprint, and a deterministic failure classification. It
 *     has NO lifecycle authority: a `FocusedCheckResult` is typed so that
 *     `verification` and `proof` are literally `null`, nothing is written
 *     anywhere, and no downstream step can consume a focused run.
 *
 *   - `proof` — the exact clean candidate plus the installation's
 *     configured plan, delegated UNCHANGED to `verify` so ticket #171's
 *     exact-candidate receipt and every existing fail-closed code
 *     (`DIRTY_CANDIDATE`, `VERIFICATION_FAILED`, `COMMAND_TIMEOUT`, …) stay
 *     exactly as they are. A proof failure keeps throwing; the executor
 *     only ADDS `details.check` (classification + fingerprints), it never
 *     rewrites the code or turns a failure into a pass.
 *
 * Authority contract: `focused` resolves the shared lifecycle authority
 * (#169) and then REQUIRES a proven ownership marker. A primary checkout or
 * a foreign linked worktree is refused with `WORKSPACE_OWNERSHIP_UNKNOWN`,
 * so a focused check can never be pointed at work Poiesis does not own.
 * `proof` keeps `verify`'s own compatibility surface (a repository that
 * never installed Poiesis stays a valid non-project-bound Verify surface).
 *
* Non-goals, enforced structurally rather than by convention:
 *   - no automatic retry. Every command runs at most once per invocation and
 *     the loop stops at the first failure; a repeat decision belongs to
 *     the orchestrator, which now has the fingerprint to make it honestly;
 *   - no daemon, no durable history, no telemetry, no second engine. The
 *     progress sink is invoked in-process and its events are discarded when
 *     the call returns.
 *
 * Spec #168 / ticket #176: a focused command is caller-supplied command TEXT,
 * so it runs through `runManagedShellCommand` — the same platform-aware command
 * processor and the same kernel containment boundary Verify uses. There is no
 * second interpreter and no weaker boundary on this surface, and a host that
 * provides neither fails before a process exists.
 *
 * Agent reachability (resolved by ticket #173): `poiesis check` is reachable
 * by the PRIMARY agent through its exact-version `pnpm dlx poiesis-cli@<version>
 * *` route, by the ticket Worker through exactly one narrower exact-version
 * route — `pnpm dlx poiesis-cli@<version> check *` — and by any caller of the
 * library seam exported from `src/index.ts`. The Worker's projection still
 * denies every Poiesis lifecycle launcher (Spec #104 / #113) and still re-allows
 * only the four narrow Repository Intelligence subcommands (Spec #120 / #123);
 * the single added allow is the non-authoritative `check` subcommand, appended
 * AFTER the `pnpm dlx poiesis-cli@*` deny so last-match-wins still refuses
 * everything else. That grant is safe precisely because of the two unequal
 * scopes above: a `focused` result cannot carry authority, writes nothing, and
 * is refused for any workspace Poiesis cannot prove it owns. The matching
 * Method/role guidance that tells a Worker to use focused checks instead of
 * the configured full verification plan also landed in #173.
 * `tests/focused-check-worker-permission.test.ts` is the executable record of
 * that boundary.
 */
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { asPoiesisError, invariant, type PoiesisError } from "./errors.js";
import { hashContent } from "./hash.js";
import {
  readWorktreeState,
  resolveLifecycleAuthority,
  verify,
  type LifecycleAuthority,
  type VerifyResult,
  type WorktreePathDigest,
} from "./git.js";
import { bounded, DEFAULT_VERIFY_TIMEOUT_MS, type RunResult } from "./process.js";
import { runManagedShellCommand } from "./managed-shell.js";
import type { VerificationEvidence } from "./verification-receipt.js";

export type CheckScope = "focused" | "proof";

/**
 * The complete, closed failure vocabulary of the executor.
 *
 * `passed` is the only non-failure member and is reachable ONLY from a
 * command that actually exited zero. Every other member describes a
 * FAILED check, and none of them can ever be produced from a passing run.
 */
export type CheckClassification =
  | "passed"
  | "command-failed"
  | "timeout"
  | "timeout-unknown"
  | "likely-load-induced-timeout"
  | "infrastructure"
  | "dirty-candidate";

/** The six failure classifications, in the order the Spec lists them. */
export const CHECK_FAILURE_CLASSIFICATIONS = [
  "command-failed",
  "timeout",
  "timeout-unknown",
  "likely-load-induced-timeout",
  "infrastructure",
  "dirty-candidate",
] as const satisfies readonly CheckClassification[];

/**
 * The FULL vocabulary a rendered progress event may carry: the six failure
 * classifications plus `passed`.
 *
 * `CHECK_FAILURE_CLASSIFICATIONS` alone is the WRONG allow-list for
 * rendering: a `command-settled` event for a genuinely green command
 * legitimately carries `passed`, and redacting it to `unknown` would make
 * every successful focused command look unattributable in the progress
 * stream. Rejection of hostile values comes from the closed vocabulary, not
 * from withholding a real member of it.
 */
export const CHECK_CLASSIFICATIONS = ["passed", ...CHECK_FAILURE_CLASSIFICATIONS] as const satisfies readonly CheckClassification[];

/**
 * What the executor can honestly say about whether a command was stopped
 * because it ran out of time.
 *
 *   - `not-timed-out` — the run settled well inside the bound, or was
 *     rejected by the caller (cancellation);
 *   - `timed-out`      — the managed runner reported `COMMAND_TIMEOUT`;
 *   - `unknown`        — the runner rejected for some other reason AFTER the
 *     bound had been consumed. The timeout state genuinely cannot be
 *     determined here, so the executor reports `unknown` and classifies the
 *     failure as `timeout-unknown` instead of guessing.
 */
export type CheckTimeoutState = "not-timed-out" | "timed-out" | "unknown";

/**
 * Focused scope's own default bound.
 *
 * Deliberately much shorter than the proof bound: a focused check exists to
 * be fast local feedback, and a caller who wants a long bound either states
 * it or is running the wrong scope.
 */
export const DEFAULT_FOCUSED_CHECK_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 8_000;
const MAX_OUTPUT_LIMIT = 64_000;
const MAX_COMMAND_LENGTH = 4_000;

/**
 * Load-per-CPU at or above this ratio, or free memory at or below
 * {@link FREE_MEMORY_PRESSURE_FRACTION}, is what "the host was under
 * pressure" means for a timeout. Both must come from SAMPLED counters; a
 * timeout with no pressure evidence stays a plain `timeout`.
 */
const LOAD_PRESSURE_PER_CPU = 1;
const FREE_MEMORY_PRESSURE_FRACTION = 0.1;

/** Bounded ratio precision so the evidence string can never grow. */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

// ---------------------------------------------------------------------------
// Resource pressure
// ---------------------------------------------------------------------------

/**
 * One host resource sample. Every field is `null` when the host does not
 * report the counter, which is treated as "no evidence" rather than as
 * "no pressure".
 */
export interface ResourcePressureSample {
  /** 1-minute load average. */
  loadAverage1m: number | null;
  /** Usable CPUs, the denominator for load per CPU. */
  parallelism: number | null;
  freeMemoryBytes: number | null;
  totalMemoryBytes: number | null;
}

/**
 * The BOUNDED derived evidence a timeout classification is allowed to use.
 *
 * Deliberately only ratios and a sample count: no host name, no path, no
 * environment value, and no unbounded digit string can ever reach it.
 */
export interface ResourcePressureEvidence {
  /** How many samples were folded in. Bounded by the executor. */
  samples: number;
  /** Highest observed 1-minute load divided by parallelism. */
  peakLoadPerCpu: number | null;
  /** Lowest observed free-memory fraction. */
  minFreeMemoryFraction: number | null;
  /** Whether either sampled counter crossed its pressure threshold. */
  pressured: boolean;
}

/**
 * The default sampler: cheap `os` counters, no shelling out, no interval
 * timer, no background work. A caller may substitute its own sampler (the
 * executor accepts `samplePressure`) so a classification is reproducible
 * without depending on the host's real load.
 */
export function sampleResourcePressure(): ResourcePressureSample {
  const parallelism = availableParallelism();
  return {
    loadAverage1m: loadavg()[0] ?? null,
    parallelism: Number.isSafeInteger(parallelism) && parallelism > 0 ? parallelism : null,
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
  };
}

/**
 * Fold samples into bounded pressure evidence.
 *
 * Nonsensical counters (negative load, zero CPUs, free memory larger than
 * total memory) are DISCARDED rather than trusted: inventing pressure from
 * a broken counter would turn an ordinary timeout into a load-induced one,
 * and inventing its absence would hide a real one.
 */
export function summarizeResourcePressure(
  samples: readonly ResourcePressureSample[],
): ResourcePressureEvidence {
  let peakLoadPerCpu: number | null = null;
  let minFreeMemoryFraction: number | null = null;
  for (const sample of samples) {
    const { loadAverage1m, parallelism, freeMemoryBytes, totalMemoryBytes } = sample;
    if (
      loadAverage1m !== null &&
      parallelism !== null &&
      Number.isFinite(loadAverage1m) &&
      Number.isFinite(parallelism) &&
      loadAverage1m >= 0 &&
      parallelism > 0
    ) {
      const ratio = loadAverage1m / parallelism;
      if (peakLoadPerCpu === null || ratio > peakLoadPerCpu) peakLoadPerCpu = ratio;
    }
    if (
      freeMemoryBytes !== null &&
      totalMemoryBytes !== null &&
      Number.isFinite(freeMemoryBytes) &&
      Number.isFinite(totalMemoryBytes) &&
      totalMemoryBytes > 0 &&
      freeMemoryBytes >= 0 &&
      freeMemoryBytes <= totalMemoryBytes
    ) {
      const fraction = freeMemoryBytes / totalMemoryBytes;
      if (minFreeMemoryFraction === null || fraction < minFreeMemoryFraction) minFreeMemoryFraction = fraction;
    }
  }
  const load = peakLoadPerCpu === null ? null : round2(peakLoadPerCpu);
  const memory = minFreeMemoryFraction === null ? null : round2(minFreeMemoryFraction);
  return {
    samples: samples.length,
    peakLoadPerCpu: load,
    minFreeMemoryFraction: memory,
    pressured:
      (load !== null && load >= LOAD_PRESSURE_PER_CPU) ||
      (memory !== null && memory <= FREE_MEMORY_PRESSURE_FRACTION),
  };
}

/**
 * Fold already-summarized per-command evidence into one operation-level
 * summary. Values are already rounded to two decimals, so merging is exact
 * and cannot change a threshold verdict between the command and the run.
 */
function mergeResourcePressure(
  entries: readonly ResourcePressureEvidence[],
): ResourcePressureEvidence | null {
  if (entries.length === 0) return null;
  let peakLoadPerCpu: number | null = null;
  let minFreeMemoryFraction: number | null = null;
  let samples = 0;
  for (const entry of entries) {
    samples += entry.samples;
    if (entry.peakLoadPerCpu !== null && (peakLoadPerCpu === null || entry.peakLoadPerCpu > peakLoadPerCpu)) {
      peakLoadPerCpu = entry.peakLoadPerCpu;
    }
    if (
      entry.minFreeMemoryFraction !== null &&
      (minFreeMemoryFraction === null || entry.minFreeMemoryFraction < minFreeMemoryFraction)
    ) {
      minFreeMemoryFraction = entry.minFreeMemoryFraction;
    }
  }
  return {
    samples,
    peakLoadPerCpu,
    minFreeMemoryFraction,
    pressured:
      (peakLoadPerCpu !== null && peakLoadPerCpu >= LOAD_PRESSURE_PER_CPU) ||
      (minFreeMemoryFraction !== null && minFreeMemoryFraction <= FREE_MEMORY_PRESSURE_FRACTION),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface CheckFailureInput {
  timeoutState: CheckTimeoutState;
  exitCode: number | null;
  /**
   * The managed runner did not produce a settled result for this command
   * (transport error, cancellation, process-lease refusal, failed cleanup).
   */
  infrastructure: boolean;
  /** The exact candidate workspace was not clean when it had to be. */
  dirtyCandidate: boolean;
  /** Bounded sampled pressure evidence, when a timeout was observed. */
  pressure: ResourcePressureEvidence | null;
}

/**
 * The deterministic failure classifier.
 *
 * Precedence is fixed and total, so the same evidence always yields the same
 * label:
 *
 *   1. a dirty exact candidate outranks everything — the workspace itself is
 *      untrustworthy, so nothing smaller is worth reporting;
 *   2. an indeterminate timeout state is reported as `timeout-unknown`
 *      rather than being attributed to a command or to the host;
 *   3. a settled timeout becomes `likely-load-induced-timeout` ONLY with
 *      sampled pressure evidence, otherwise `timeout`;
 *   4. a real non-zero exit is `command-failed`;
 *   5. everything else — an unattributable rejection, or a signal-carrying
 *      termination with no non-zero exit — is `infrastructure`. It fails
 *      closed rather than being optimistically read as a pass.
 *
 * There is deliberately no branch that returns `passed`: the function is
 * only ever asked to describe a FAILURE.
 */
export function classifyCheckFailure(input: CheckFailureInput): CheckClassification {
  if (input.dirtyCandidate) return "dirty-candidate";
  if (input.timeoutState === "unknown") return "timeout-unknown";
  if (input.timeoutState === "timed-out") {
    return input.pressure?.pressured === true ? "likely-load-induced-timeout" : "timeout";
  }
  if (input.exitCode !== null && input.exitCode !== 0) return "command-failed";
  return "infrastructure";
}

/**
 * Derive the timeout state of ONE command from what the managed runner
 * actually reported about it.
 *
 * A `COMMAND_TIMEOUT` is the runner's own settled word and is believed. Any
 * OTHER rejection that nonetheless consumed the whole bound is the
 * `timeout-unknown` case: Poiesis cannot honestly say the command was
 * stopped for time, so it says it does not know.
 *
 * `elapsedMs` MUST be one command's own duration. Proof scope never calls this
 * with the operation's elapsed time: there `timeoutMs` is a per-command bound,
 * so a whole-operation duration is not comparable to it. Proof derives its own
 * state from the failing command's record instead.
 */
export function deriveCheckTimeoutState(
  failure: PoiesisError | null,
  elapsedMs: number,
  timeoutMs: number,
): CheckTimeoutState {
  if (failure === null) return "not-timed-out";
  if (failure.code === "COMMAND_TIMEOUT") return "timed-out";
  return elapsedMs >= timeoutMs ? "unknown" : "not-timed-out";
}

// ---------------------------------------------------------------------------
// Invocation-local progress events
// ---------------------------------------------------------------------------

export const CHECK_PROGRESS_PHASES = ["resolve-authority", "execute", "settle"] as const;
export const CHECK_PROGRESS_ACTIONS = [
  "check-started",
  "command-started",
  "command-settled",
  "check-settled",
] as const;
export const CHECK_RETRY_REASONS = [
  "mutation-since-last-attempt",
  "new-hypothesis",
  "focused-recheck-authorized",
] as const;

export type CheckProgressPhase = (typeof CHECK_PROGRESS_PHASES)[number];
export type CheckProgressAction = (typeof CHECK_PROGRESS_ACTIONS)[number];
export type CheckRetryReason = (typeof CHECK_RETRY_REASONS)[number];

/**
 * One bounded, invocation-local progress event.
 *
 * `phase`, `action`, and `retryReason` come from CLOSED vocabularies and
 * `operationId` is a hash-derived label, so no command text, command
 * output, environment value, or filesystem path can reach a progress event
 * even if a caller tried to put one there. There is no event history and no
 * store: the sink is called and the event is then gone.
 */
export interface CheckProgressEvent {
  operationId: string;
  phase: CheckProgressPhase;
  action: CheckProgressAction;
  elapsedMs: number;
  /** Position in the explicit command list, or `null` outside a command. */
  index: number | null;
  /** `null` until an outcome exists for the step being reported. */
  classification: CheckClassification | null;
  /** Present only when the caller supplied one; it never triggers a retry. */
  retryReason?: CheckRetryReason;
}

export interface CheckProgressSink {
  emit(event: CheckProgressEvent): void;
}

/** Operation labels are the only free-form field on a rendered event. */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function vocabulary<T extends string>(value: unknown, allowed: readonly T[]): T | "unknown" {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : "unknown";
}

/**
 * Project one event through the allow-list into its rendered JSON line.
 *
 * Values are matched against the CLOSED vocabularies — including `passed`,
 * which is a real member of {@link CHECK_CLASSIFICATIONS} — and anything
 * outside them collapses to `"unknown"`. A non-numeric elapsed time collapses
 * to `0`, so a hand-built event cannot smuggle caller text into stderr.
 */
export function renderCheckProgressLine(event: CheckProgressEvent): string {
  const operationId =
    typeof event.operationId === "string" && OPERATION_ID_PATTERN.test(event.operationId)
      ? event.operationId
      : "unknown";
  const elapsedMs =
    typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs) ? Math.trunc(event.elapsedMs) : 0;
  const index =
    event.index === null || event.index === undefined
      ? null
      : typeof event.index === "number" && Number.isFinite(event.index)
        ? Math.trunc(event.index)
        : null;
  const classification = vocabulary(event.classification, CHECK_CLASSIFICATIONS);
  const rendered: Record<string, unknown> = {
    operationId,
    phase: vocabulary(event.phase, CHECK_PROGRESS_PHASES),
    action: vocabulary(event.action, CHECK_PROGRESS_ACTIONS),
    elapsedMs,
    index,
    classification: event.classification === null || event.classification === undefined ? null : classification,
  };
  const retryReason = vocabulary(event.retryReason, CHECK_RETRY_REASONS);
  if (event.retryReason !== undefined && event.retryReason !== null && retryReason !== "unknown") {
    rendered.retryReason = retryReason;
  }
  return JSON.stringify(rendered);
}

/** The production sink: one newline-terminated JSON line per event, on stderr. */
export function createStderrCheckProgress(): CheckProgressSink {
  return {
    emit(event: CheckProgressEvent): void {
      process.stderr.write(`${renderCheckProgressLine(event)}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------

/**
 * The workspace state a check ran against. This is the "state fingerprint":
 * together with the command it is what makes an unchanged failure
 * recognizable as unchanged.
 *
 * `pathDigests` is what makes that claim true for an ALREADY-DIRTY workspace.
 * `head`, `tree`, `dirty`, and `changedFiles` are all invariant under "edit
 * the bytes of a file that was already modified", so without a content digest
 * a genuinely changed state would be reported as unchanged — precisely the
 * blind-rerun loop this fingerprint exists to end. The digests are Git object
 * ids, so they change with the bytes and disclose nothing about them.
 */
export interface CheckStateFingerprint {
  workspace: string;
  ownershipId: string | null;
  head: string | null;
  tree: string | null;
  dirty: boolean;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  /**
   * Spec #168 / ticket #179 — the status bytes behind this reading were cut
   * short, so the workspace was observed only in part.
   *
   * It is carried here, rather than folded into `changedFilesTruncated`,
   * because it is the one of the three bounds that means "state nobody read":
   * the fingerprint below must separate a partially observed workspace from the
   * complete one it was cut from, or a check would report an incomplete reading
   * as an unchanged action.
   */
  statusCaptureTruncated: boolean;
  pathDigests: WorktreePathDigest[];
  pathDigestsTruncated: boolean;
}

/**
 * Spec #168 / ticket #177 — the bounded, typed cause of one rejected command.
 *
 * Read field by field out of the runner's own rejection details, so a
 * caller-shaped value is never trusted wholesale: an absent or non-string field
 * becomes `null` evidence rather than a fabricated one. Only the bounded fields
 * that make a pre-spawn refusal actionable are carried — the containment model,
 * the platform, the processor that was rejected (`COMMAND_PROCESSOR_UNAVAILABLE`),
 * and the reason/detail/remediation — and none of them is unbounded output.
 */
export interface FocusedFailureCause {
  readonly containment: string | null;
  readonly platform: string | null;
  /**
   * Spec #168 / ticket #178 — the processor path or name a
   * `COMMAND_PROCESSOR_UNAVAILABLE` refused, so the operator is told WHICH
   * processor to repair rather than only that one was unusable.
   */
  readonly processor: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly remediation: string | null;
}

/** One focused command's complete bounded evidence. */
export interface FocusedCommandEvidence {
  index: number;
  command: string;
  status: "passed" | "failed";
  classification: CheckClassification;
  /**
   * Spec #168 / ticket #176 — the typed code the managed runner rejected with,
   * or `null` for a command that settled.
   *
   * The classification vocabulary deliberately stays closed, so a cancellation
   * or a cleanup failure lands in `infrastructure` like every other
   * unattributable rejection. This field is what makes the actual cause
   * visible without widening that vocabulary: an orchestrator can tell
   * `COMMAND_CANCELLED` from `PROCESS_CONTAINMENT_UNAVAILABLE` here.
   */
  failureCode: string | null;
  /**
   * Spec #168 / ticket #177 — the bounded CAUSE of a rejection that never
   * produced a result.
   *
   * `failureCode` names which refusal happened; this says why, in the
   * runtime's own words, so the public surface can rethrow an actionable
   * `PROCESS_CONTAINMENT_UNAVAILABLE` or `PROCESS_CONTAINMENT_REFUSED` with
   * its `reason`, `platform`, `detail`, and `remediation` intact instead of
   * collapsing it into a generic failed check that names none of them.
   *
   * Every field is a Poiesis-owned string or `null`, so nothing caller-supplied
   * — no command text, no output, no path beyond the ones the refusal itself
   * already reports — can reach it.
   */
  failureCause: FocusedFailureCause | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timeoutMs: number;
  timeoutState: CheckTimeoutState;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputTruncated: boolean;
  /** Bounded sampled pressure around this command, when it is known. */
  pressure: ResourcePressureEvidence | null;
}

export interface CheckResultBase {
  /**
   * Deterministic, request-derived operation label. Two invocations of the
   * same scope / workspace / command list share it, which is exactly what
   * makes an unchanged rerun recognizable.
   */
  operationId: string;
  /**
   * Deterministic action fingerprint over the scope, the explicit commands,
   * the bounds, and the state fingerprint. Identical inputs produce an
   * identical value; any mutation of the state changes it.
   */
  actionFingerprint: string;
  state: CheckStateFingerprint;
  outcome: "passed" | "failed";
  /** `null` only when every command passed. */
  classification: CheckClassification | null;
  /** Bounded pressure sampled around the whole operation. */
  pressure: ResourcePressureEvidence | null;
  /** Whether this result may authorize lifecycle proof. */
  authoritative: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

/**
 * A focused result. `verification` and `proof` are typed `null`: a focused
 * run cannot be made to carry lifecycle authority even by a cast-heavy
 * caller, because the fields do not exist in any other shape.
 */
export interface FocusedCheckResult extends CheckResultBase {
  scope: "focused";
  authoritative: false;
  commands: FocusedCommandEvidence[];
  verification: null;
  proof: null;
}

/**
 * A proof result. Per-command evidence is deliberately `null` here: the
 * authoritative per-command record for a proof-scope Verify is ticket #171's
 * `VerificationCommandEvidenceV1` inside the receipt, and duplicating it
 * under a second, unvalidated shape would create a second source of truth.
 */
export interface ProofCheckResult extends CheckResultBase {
  scope: "proof";
  authoritative: true;
  commands: null;
  verification: VerificationEvidence | null;
  proof: VerifyResult;
}

export type CheckResult = FocusedCheckResult | ProofCheckResult;

export interface ExecuteFocusedCheckOptions {
  cwd: string;
  ownershipId?: string;
  /** Explicit, non-empty command list. Focused scope never discovers a plan. */
  commands: readonly string[];
  timeoutMs?: number;
  outputLimit?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  progress?: CheckProgressSink;
  /** Sampler seam so classification is reproducible without host load. */
  samplePressure?: () => ResourcePressureSample;
  retryReason?: CheckRetryReason;
}

export interface ExecuteProofCheckOptions {
  cwd: string;
  candidateSha: string;
  /** The installation's authoritative plan, resolved by the caller. */
  commands: readonly string[];
  ownershipId?: string;
  timeoutMs?: number;
  outputLimit?: number;
  env?: NodeJS.ProcessEnv;
  progress?: CheckProgressSink;
  samplePressure?: () => ResourcePressureSample;
  retryReason?: CheckRetryReason;
}

export type ExecuteCheckRequest =
  | ({ scope: "focused" } & ExecuteFocusedCheckOptions)
  | ({ scope: "proof" } & ExecuteProofCheckOptions);

/**
 * The one executor.
 *
 * The scope discriminates authority, never convenience: `focused` can only
 * be non-authoritative and `proof` can only be authoritative, and the
 * return type encodes that so the compiler rejects the conflation.
 */
export async function executeCheck(request: ExecuteCheckRequest): Promise<CheckResult> {
  return request.scope === "focused"
    ? await executeFocusedCheck(request)
    : await executeProofCheck(request);
}

/** Focused scope: explicit commands, owned (possibly dirty) workspace, no proof. */
export async function executeFocusedCheck(
  options: ExecuteFocusedCheckOptions,
): Promise<FocusedCheckResult> {
  const commands = validateCommands(options.commands, "NO_FOCUSED_CHECK_COMMANDS");
  const timeoutMs = resolveCheckTimeoutMs("focused", options.timeoutMs);
  const outputLimit = normalizeOutputLimit(options.outputLimit);
  const retryReason = validateRetryReason(options.retryReason);
  const sample = options.samplePressure ?? sampleResourcePressure;
  const operationId = operationLabel("focused", options.cwd, options.ownershipId, commands);
  const startedAtMs = Date.now();
  const emit = progressEmitter(options.progress, operationId, retryReason, startedAtMs);

  emit(startedAtMs, "resolve-authority", "check-started", null, null);

  // Focused scope is an owned-workspace surface: the shared authority from
  // #169 resolves, then a marker must exist. A primary checkout or a
  // foreign linked worktree is refused here rather than silently checked.
  const authority = await resolveOwnedAuthority(options.cwd, options.ownershipId);
  const state = await readStateFingerprint(authority);
  const evidence: FocusedCommandEvidence[] = [];

  for (const [index, command] of commands.entries()) {
    emit(startedAtMs, "execute", "command-started", index, null);
    const recorded = await runFocusedCommand({
      command,
      index,
      root: authority.candidateRoot,
      ownershipId: authority.marker?.ownershipId ?? null,
      operationId,
      timeoutMs,
      outputLimit,
      sample,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    evidence.push(recorded);
    emit(startedAtMs, "execute", "command-settled", index, recorded.classification);
    // Fail fast and NEVER retry: the orchestrator decides whether another
    // attempt is justified, and it now has the fingerprint to do so.
    if (recorded.status === "failed") break;
  }

  const failed = evidence.find((entry) => entry.status === "failed") ?? null;
  const pressure = mergeResourcePressure(evidence.flatMap((entry) => (entry.pressure === null ? [] : [entry.pressure])));
  const endedAtMs = Date.now();
  const outcome = failed === null ? "passed" : "failed";
  const result: FocusedCheckResult = {
    scope: "focused",
    authoritative: false,
    operationId,
    actionFingerprint: actionFingerprint({
      scope: "focused",
      commands,
      timeoutMs,
      outputLimit,
      state,
    }),
    state,
    outcome,
    classification: failed?.classification ?? null,
    pressure,
    commands: evidence,
    verification: null,
    proof: null,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
  };
  emit(endedAtMs, "settle", "check-settled", null, result.classification);
  return result;
}

/**
 * Proof scope: the unchanged `verify` call, with the executor's
 * fingerprints and classification attached as ADDITIONAL evidence.
 *
 * The thrown error keeps its original code, message, exit code, and details
 * (including the #171 receipt reference `verify` already attached). The
 * classification is added so an orchestrator sees the same vocabulary for
 * both scopes — it never downgrades a failure and never substitutes one.
 */
export async function executeProofCheck(options: ExecuteProofCheckOptions): Promise<ProofCheckResult> {
  const commands = validateCommands(options.commands, "NO_VERIFICATION_COMMANDS");
  const timeoutMs = resolveCheckTimeoutMs("proof", options.timeoutMs);
  const outputLimit = normalizeOutputLimit(options.outputLimit);
  const retryReason = validateRetryReason(options.retryReason);
  const sample = options.samplePressure ?? sampleResourcePressure;
  const operationId = operationLabel("proof", options.cwd, options.ownershipId, commands);
  const startedAtMs = Date.now();
  const emit = progressEmitter(options.progress, operationId, retryReason, startedAtMs);

  emit(startedAtMs, "resolve-authority", "check-started", null, null);
  const state = await readStateFingerprintFor(options.cwd, options.ownershipId);
  const pressureBefore = sample();

  let proof: VerifyResult;
  try {
    proof = await verify({
      cwd: options.cwd,
      candidateSha: options.candidateSha,
      commands: [...commands],
      timeoutMs,
      outputLimit,
      ...(options.ownershipId === undefined ? {} : { ownershipId: options.ownershipId }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (error) {
    const pressure = summarizeResourcePressure([pressureBefore, sample()]);
    const failure = asPoiesisError(error);
    const classification = classifyProofFailure(failure, timeoutMs, pressure);
    failure.details.check = {
      operationId,
      classification,
      actionFingerprint: actionFingerprint({
        scope: "proof",
        commands,
        timeoutMs,
        outputLimit,
        state,
      }),
      state,
      pressure,
    };
    emit(Date.now(), "settle", "check-settled", null, classification);
    throw failure;
  }

  const endedAtMs = Date.now();
  const pressure = summarizeResourcePressure([pressureBefore, sample()]);
  const result: ProofCheckResult = {
    scope: "proof",
    authoritative: true,
    operationId,
    actionFingerprint: actionFingerprint({ scope: "proof", commands, timeoutMs, outputLimit, state }),
    state,
    outcome: "passed",
    classification: null,
    pressure,
    commands: null,
    verification: proof.verification,
    proof,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
  };
  emit(endedAtMs, "settle", "check-settled", null, null);
  return result;
}

// ---------------------------------------------------------------------------
// Focused command execution
// ---------------------------------------------------------------------------

interface FocusedCommandInput {
  command: string;
  index: number;
  root: string;
  ownershipId: string | null;
  operationId: string;
  timeoutMs: number;
  outputLimit: number;
  sample: () => ResourcePressureSample;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Run ONE focused command through ticket #170 managed execution and turn
 * whatever comes back — a settled result or a typed rejection — into one
 * bounded evidence record.
 *
 * The runner is called with `allowFailure` because a non-zero exit is
 * EVIDENCE here, not an exception: it is exactly the `command-failed`
 * classification an orchestrator needs.
 */
async function runFocusedCommand(input: FocusedCommandInput): Promise<FocusedCommandEvidence> {
  const pressureBefore = input.sample();
  const startedAtMs = Date.now();
  let result: RunResult | null = null;
  let failure: PoiesisError | null = null;
  try {
    // Spec #168 / ticket #176: the same managed command-processor and
    // strong-containment seam Verify uses, so a focused command is interpreted
    // by the same validated processor and runs inside the same boundary. There
    // is no second interpreter and no weaker containment on this surface.
    //
    // The runner's own capture bound is deliberately NOT narrowed to
    // `outputLimit` (Spec #168 / ticket #178 review note): the evidence limit
    // bounds what the RESULT carries, while the capture bound is what makes the
    // reported "... truncated N bytes" honest, and it already caps buffering at
    // a fixed 256 KiB per stream. Narrowing it would save that fixed, small
    // amount while making the recorded byte count a fabrication.
    result = await runManagedShellCommand({
      cwd: input.root,
      command: input.command,
      allowFailure: true,
      timeoutMs: input.timeoutMs,
      // #170: the transient managed lease names this operation and, when the
      // caller proved one, the workspace that owns it. Nothing is persisted.
      operationId: input.operationId,
      ...(input.ownershipId === null ? {} : { workspaceId: input.ownershipId }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    failure = asPoiesisError(error);
  }
  const elapsedMs = Date.now() - startedAtMs;
  const pressure = summarizeResourcePressure([pressureBefore, input.sample()]);
  const details = failure?.details ?? {};

  const stdout = rawString(details, "stdout", result?.stdout);
  const stderr = rawString(details, "stderr", result?.stderr);
  const boundedStdout = bounded(stdout, input.outputLimit);
  const boundedStderr = bounded(stderr, input.outputLimit);
  const stdoutTruncated =
    details.stdoutTruncated === true ||
    result?.stdoutTruncated === true ||
    (result !== null && boundedStdout !== result.stdout);
  const stderrTruncated =
    details.stderrTruncated === true ||
    result?.stderrTruncated === true ||
    (result !== null && boundedStderr !== result.stderr);

  const exitCode = typeof details.exitCode === "number" ? details.exitCode : (result?.exitCode ?? null);
  const signal = typeof details.signal === "string" ? details.signal : (result?.signal ?? null);
  const durationMs =
    typeof details.durationMs === "number" && Number.isFinite(details.durationMs)
      ? details.durationMs
      : elapsedMs;
  const timeoutState = deriveCheckTimeoutState(failure, durationMs, input.timeoutMs);
  const passed = failure === null && exitCode === 0;

  return {
    index: input.index,
    command: input.command,
    status: passed ? "passed" : "failed",
    classification: passed
      ? "passed"
      : classifyCheckFailure({
          timeoutState,
          exitCode,
          infrastructure: failure !== null,
          dirtyCandidate: false,
          pressure,
        }),
    failureCode: failure?.code ?? null,
    failureCause: failure === null ? null : readFailureCause(failure.details),
    exitCode,
    signal,
    durationMs,
    timeoutMs: input.timeoutMs,
    timeoutState,
    stdout: boundedStdout,
    stderr: boundedStderr,
    stdoutTruncated,
    stderrTruncated,
    outputTruncated: stdoutTruncated || stderrTruncated,
    pressure,
  };
}

function rawString(details: Record<string, unknown>, key: string, fallback: string | undefined): string {
  const value = details[key];
  if (typeof value === "string") return value;
  return fallback ?? "";
}

/**
 * Spec #168 / ticket #177 — project the runner's own refusal details into the
 * bounded cause a focused record carries.
 *
 * `null` for the whole record when the rejection carried none of these strings,
 * which is the common case (a cancellation or a cleanup failure says nothing
 * about the containment capability or the processor) and keeps the field from
 * implying a host story that was never told.
 */
function readFailureCause(details: Record<string, unknown>): FocusedFailureCause | null {
  const cause: Record<string, string> = {};
  for (const key of ["containment", "platform", "processor", "reason", "detail", "remediation"] as const) {
    const value = details[key];
    if (typeof value === "string" && value.length > 0) cause[key] = value;
  }
  if (Object.keys(cause).length === 0) return null;
  return {
    containment: cause.containment ?? null,
    platform: cause.platform ?? null,
    processor: cause.processor ?? null,
    reason: cause.reason ?? null,
    detail: cause.detail ?? null,
    remediation: cause.remediation ?? null,
  };
}

/**
 * Bounded, PER-COMMAND evidence about the one command that ended a proof run.
 *
 * Every field is `null` when the record does not carry it, which is read as
 * "no evidence" rather than as "the opposite". No command text, output, path,
 * or unbounded string is ever captured here.
 */
interface FailingCommandEvidence {
  exitCode: number | null;
  /** The managed runner's own `timedOut` word, when a record carries it. */
  timedOut: boolean | null;
  durationMs: number | null;
  timeoutMs: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one per-command record out of a details bag, or `null` when that bag
 * holds no per-command numbers or flags at all.
 *
 * Reading field by field is what keeps a caller-shaped value from being trusted
 * wholesale: an absent or nonsensical field becomes `null` evidence instead of
 * a fabricated one.
 */
function readCommandRecord(details: Record<string, unknown>): FailingCommandEvidence | null {
  const exitCode = finiteNumber(details.exitCode);
  const timedOut = typeof details.timedOut === "boolean" ? details.timedOut : null;
  const durationMs = finiteNumber(details.durationMs);
  const timeoutMs = finiteNumber(details.timeoutMs);
  if (exitCode === null && timedOut === null && durationMs === null && timeoutMs === null) return null;
  return { exitCode, timedOut, durationMs, timeoutMs };
}

/**
 * Collect the failing command's OWN evidence, in strict precedence order:
 *
 *   1. a #170 runner rejection IS that command's own record — its details
 *      carry the command's own duration, its bound, and its exit code;
 *   2. a command `verify` settled as non-zero is recorded in `failed`, which
 *      is that command's own result;
 *   3. a nested `runError` is the same per-command record for a rejection
 *      that ended a run whose workspace went dirty.
 *
 * The operation's own `timeoutMs` is the fallback bound only when a record
 * carries no bound of its own; it is NEVER a stand-in for elapsed time. The
 * resolved record therefore always carries a comparable per-command bound.
 */
function readFailingCommandEvidence(
  failure: PoiesisError,
  timeoutMs: number,
): FailingCommandEvidence & { timeoutMs: number } {
  const details = failure.details;
  const record =
    readCommandRecord(details) ??
    (isRecord(details.failed) ? readCommandRecord(details.failed) : null) ??
    (isRecord(details.runError) ? readCommandRecord(details.runError) : null) ?? {
      exitCode: null,
      timedOut: null,
      durationMs: null,
      timeoutMs: null,
    };
  return { ...record, timeoutMs: record.timeoutMs ?? timeoutMs };
}

/**
 * Derive the proof-scope timeout state from the FAILING COMMAND's own
 * evidence, never from how long the whole operation took.
 *
 * `timeoutMs` is a PER-COMMAND bound, so an N-command plan routinely takes N
 * times longer than it while every command settles well inside it. Comparing
 * cumulative elapsed time against a per-command bound therefore answered a
 * question nobody asked: it turned an ordinary non-zero exit into
 * `timeout-unknown` and sent the orchestrator looking for a timeout that never
 * happened. Only the command that ended the run can say whether IT ran out of
 * time.
 *
 *   - `timed-out`      — the managed runner reported `COMMAND_TIMEOUT`, or the
 *     failing command's own record says `timedOut`. The runner's word is
 *     believed;
 *   - `not-timed-out`  — the failing command settled on a non-zero exit of its
 *     own, however long the run as a whole took; otherwise an unattributable
 *     rejection whose own duration stayed inside the bound;
 *   - `unknown`        — an unattributable rejection that consumed ITS OWN
 *     bound. Poiesis cannot honestly attribute it either way, so it says it
 *     does not know.
 */
function deriveProofTimeoutState(
  failure: PoiesisError,
  evidence: FailingCommandEvidence & { timeoutMs: number },
): CheckTimeoutState {
  if (failure.code === "COMMAND_TIMEOUT" || evidence.timedOut === true) return "timed-out";
  if (evidence.exitCode !== null && evidence.exitCode !== 0) return "not-timed-out";
  if (evidence.durationMs !== null && evidence.durationMs >= evidence.timeoutMs) return "unknown";
  return "not-timed-out";
}

/**
 * Classify a proof failure the executor re-throws unchanged.
 *
 * The code, message, and details are never rewritten here — this only decides
 * which member of the closed vocabulary describes the failure the orchestrator
 * already has to handle.
 */
function classifyProofFailure(
  failure: PoiesisError,
  timeoutMs: number,
  pressure: ResourcePressureEvidence,
): CheckClassification {
  if (failure.code === "DIRTY_CANDIDATE") return "dirty-candidate";
  const evidence = readFailingCommandEvidence(failure, timeoutMs);
  const timeoutState = deriveProofTimeoutState(failure, evidence);
  return classifyCheckFailure({
    timeoutState,
    exitCode: evidence.exitCode,
    infrastructure: true,
    dirtyCandidate: false,
    pressure: timeoutState === "timed-out" ? pressure : null,
  });
}

// ---------------------------------------------------------------------------
// Authority + state fingerprint
// ---------------------------------------------------------------------------

/**
 * The shared lifecycle authority (#169) narrowed to a proven owner.
 *
 * Focused scope deliberately has no primary-checkout and no foreign-worktree
 * compatibility surface: those are not "an owned workspace", and a focused
 * check pointed at them would be running where Poiesis has no authority.
 */
async function resolveOwnedAuthority(cwd: string, ownershipId?: string): Promise<LifecycleAuthority> {
  const authority = await resolveLifecycleAuthority(cwd, ownershipId);
  invariant(
    authority.marker !== null && authority.markerPath !== null,
    "WORKSPACE_OWNERSHIP_UNKNOWN",
    "Focused checks may only run in a Poiesis-owned candidate workspace",
    { path: authority.candidateRoot, matches: 0 },
  );
  return authority;
}

/**
 * Proof scope reads its state through the SAME authority resolution `verify`
 * uses, so every compatibility surface `verify` keeps stays intact.
 *
 * When that resolution cannot succeed — the non-project-bound primary
 * checkout of a repository that never installed Poiesis is `verify`'s
 * documented compatibility surface — the fingerprint is still taken, from
 * the canonical Git root, and the caller-asserted ownership identity is
 * recorded as-is. A fingerprint is EVIDENCE, not a gate: `verify` is invoked
 * immediately afterwards and raises the real typed refusal, so nothing is
 * masked and no authority is invented. The read is still bounded and still
 * rejects anything Git itself refuses.
 */
async function readStateFingerprintFor(cwd: string, ownershipId?: string): Promise<CheckStateFingerprint> {
  try {
    const authority = await resolveLifecycleAuthority(cwd, ownershipId);
    return await readStateFingerprint(authority);
  } catch {
    const state = await readWorktreeState(cwd);
    return {
      workspace: state.root,
      ownershipId: ownershipId ?? null,
      head: state.head,
      tree: state.tree,
      dirty: state.dirty,
      changedFiles: state.changedFiles,
      changedFilesTruncated: state.changedFilesTruncated,
      statusCaptureTruncated: state.statusCaptureTruncated,
      pathDigests: state.pathDigests,
      pathDigestsTruncated: state.pathDigestsTruncated,
    };
  }
}

async function readStateFingerprint(authority: LifecycleAuthority): Promise<CheckStateFingerprint> {
  const state = await readWorktreeState(authority.candidateRoot);
  return {
    workspace: state.root,
    ownershipId: authority.marker?.ownershipId ?? null,
    head: state.head,
    tree: state.tree,
    dirty: state.dirty,
    changedFiles: state.changedFiles,
    changedFilesTruncated: state.changedFilesTruncated,
    statusCaptureTruncated: state.statusCaptureTruncated,
    pathDigests: state.pathDigests,
    pathDigestsTruncated: state.pathDigestsTruncated,
  };
}

// ---------------------------------------------------------------------------
// Fingerprints + validation
// ---------------------------------------------------------------------------

/**
 * The deterministic operation label: a function of what was asked for, not
 * of when. Two identical invocations therefore share an identity, which is
 * what makes an unchanged repeat visible instead of looking like new work.
 */
function operationLabel(
  scope: CheckScope,
  cwd: string,
  ownershipId: string | undefined,
  commands: readonly string[],
): string {
  const digest = hashContent(JSON.stringify([scope, cwd, ownershipId ?? null, [...commands]]));
  return `poiesis-${scope}-check-${digest.slice(0, 16)}`;
}

/**
 * The action fingerprint an orchestrator compares before repeating work.
 *
 * Field order is fixed by construction (a positional tuple), so this is
 * deterministic without a general canonical-JSON helper.
 */
function actionFingerprint(input: {
  scope: CheckScope;
  commands: readonly string[];
  timeoutMs: number;
  outputLimit: number;
  state: CheckStateFingerprint;
}): string {
  return hashContent(
    JSON.stringify([
      input.scope,
      [...input.commands],
      input.timeoutMs,
      input.outputLimit,
      input.state.workspace,
      input.state.ownershipId,
      input.state.head,
      input.state.tree,
      input.state.dirty,
      [...input.state.changedFiles],
      input.state.changedFilesTruncated,
      // The content digests, flattened positionally as `path\0blob` so the
      // fingerprint stays a pure function of the (sorted) digest list.
      input.state.pathDigests.map((digest) => `${digest.path}\0${digest.blob}`),
      input.state.pathDigestsTruncated,
      // Spec #168 / ticket #179: appended last so every COMPLETE reading keeps
      // the exact fingerprint it already had, and a partially observed one is
      // separated from the complete state it was cut from.
      input.state.statusCaptureTruncated,
    ]),
  );
}

function validateCommands(commands: readonly string[], emptyCode: string): readonly string[] {
  invariant(commands.length > 0, emptyCode, "At least one explicit check command is required", {
    commands: commands.length,
  });
  for (const command of commands) {
    invariant(
      typeof command === "string" && command.trim().length > 0 && command.length <= MAX_COMMAND_LENGTH,
      "INVALID_CHECK_COMMAND",
      "Each check command must be non-empty text within the command length bound",
      { length: typeof command === "string" ? command.length : 0 },
    );
  }
  return [...commands];
}

function validateRetryReason(value: CheckRetryReason | undefined): CheckRetryReason | undefined {
  if (value === undefined) return undefined;
  invariant(
    (CHECK_RETRY_REASONS as readonly string[]).includes(value),
    "INVALID_CHECK_RETRY_REASON",
    "Retry reason is not a declared progress reason",
    { supported: [...CHECK_RETRY_REASONS] },
  );
  return value;
}

/**
 * Resolve the command bound for one scope.
 *
 * Proof scope keeps `verify`'s documented ten-minute whole-change bound
 * (`DEFAULT_VERIFY_TIMEOUT_MS`) rather than borrowing the short focused
 * default — silently starting to time out legitimate full suites would be a
 * Proof regression, and Proof is exactly what this ticket must not weaken.
 * An explicit value overrides either default, and any out-of-range value is
 * refused identically in both scopes.
 */
export function resolveCheckTimeoutMs(scope: CheckScope, value: number | undefined): number {
  const fallback = scope === "proof" ? DEFAULT_VERIFY_TIMEOUT_MS : DEFAULT_FOCUSED_CHECK_TIMEOUT_MS;
  if (value === undefined) return fallback;
  invariant(
    Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS,
    "INVALID_TIMEOUT",
    `Timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`,
    { value },
  );
  return value;
}

function normalizeOutputLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OUTPUT_LIMIT;
  invariant(
    Number.isSafeInteger(value) && value > 0 && value <= MAX_OUTPUT_LIMIT,
    "INVALID_OUTPUT_LIMIT",
    `Output limit must be between 1 and ${MAX_OUTPUT_LIMIT}`,
    { value },
  );
  return value;
}

type ProgressEmitter = (
  atMs: number,
  phase: CheckProgressPhase,
  action: CheckProgressAction,
  index: number | null,
  classification: CheckClassification | null,
) => void;

function progressEmitter(
  sink: CheckProgressSink | undefined,
  operationId: string,
  retryReason: CheckRetryReason | undefined,
  startedAtMs: number,
): ProgressEmitter {
  if (sink === undefined) return () => undefined;
  return (atMs, phase, action, index, classification): void => {
    try {
      sink.emit({
        operationId,
        phase,
        action,
        // Measured from the SAME instant the result's `startedAt` uses, so the
        // final event's elapsed and `result.durationMs` cannot disagree.
        elapsedMs: Math.max(0, atMs - startedAtMs),
        index,
        classification,
        ...(retryReason === undefined ? {} : { retryReason }),
      });
    } catch {
      // Observability must never change an outcome. A failing sink is the
      // sink's problem, not the check's.
    }
  };
}
import { readFileSync, readdirSync } from "node:fs";
import { PoiesisError } from "./errors.js";

/**
 * Spec #168 / ticket #170 — transient managed-process identity leases.
 *
 * Every subprocess Poiesis spawns through managed execution is leased, not
 * merely remembered. A lease is a plain in-memory value that names the
 * operation and workspace that own the process, the PID and process-group
 * id of the process, and the kernel process-start identity observed for
 * that PID at spawn time. It is deliberately transient: nothing about it is
 * written to disk, reported to a tracker, or reused across processes, so a
 * stale lease can never be revived later and mistaken for authority.
 *
 * The lease exists so cleanup can answer one question safely — "is this
 * still the process Poiesis spawned?" — before any signal is sent. Every
 * path in this module is fail-closed: a malformed, ambiguous, reused, or
 * foreign identity is refused rather than signalled, and an unresolved
 * cleanup surfaces as a typed failure instead of a silent success.
 *
 * Two hard rules bound the implementation:
 *
 *   1. Cleanup targets are derived ONLY from a validated lease. There is
 *      no process-name, port, user, or age matching anywhere in this
 *      module — a same-named unrelated process is never a target.
 *   2. A managed process group must be isolated. A lease that names the
 *      Poiesis process, process group 0/1, or Poiesis's own process group
 *      is refused, because signalling it would reach processes Poiesis
 *      never spawned.
 */

/** Schema version carried by every lease, so a future shape change is visible. */
export const PROCESS_LEASE_SCHEMA = 1;

/**
 * True when this runtime can read the kernel process-start identity
 * (`starttime` from `/proc/<pid>/stat`), i.e. Linux.
 */
const PROCESS_START_IDENTITY_AVAILABLE = process.platform === "linux";

/**
 * True when this runtime can observe the process-group id of an arbitrary
 * PID. Linux exposes it as the `pgrp` field of `/proc/<pid>/stat`.
 */
const PROCESS_GROUP_IDENTITY_AVAILABLE = PROCESS_START_IDENTITY_AVAILABLE;

/**
 * True when the running platform has POSIX process groups at all, which is
 * what makes `detached: true` plus `kill(-pgid, …)` a real isolation
 * boundary. False only on Windows, whose tree cleanup runs through
 * `taskkill` in `src/process.ts` instead.
 */
export const PROCESS_GROUPS_SUPPORTED = process.platform !== "win32";

/**
 * True when this runtime can read the kernel process-start identity.
 *
 * Where it cannot, a lease carries `startIdentity: null` and Poiesis falls
 * back to the group-isolation model documented on
 * {@link PROCESS_GROUP_ONLY_IDENTITY_MODEL} rather than refusing every
 * cleanup.
 */
export const PROCESS_START_IDENTITY_SUPPORTED = PROCESS_START_IDENTITY_AVAILABLE;

/**
 * The documented identity model for POSIX platforms without a readable
 * process-start identity (macOS, the BSDs, and any other POSIX that is not
 * Linux).
 *
 * Without `starttime` Poiesis cannot prove "this PID is still the process I
 * spawned", so it does not try. Instead it relies on the one property the
 * OS itself guarantees about the group it created:
 *
 *   - The runner spawns the child `detached: true`, so the child is the
 *     leader of a brand-new session and process group whose id EQUALS the
 *     child's PID. Poiesis records that pair at spawn time.
 *   - Group membership is a property of the group, not of a PID, so the
 *     group can only contain that child and processes descended from it.
 *   - Cleanup addresses the group (`kill(-pgid, …)`) and NEVER an individual
 *     PID from outside it. A PID that has exited and been recycled cannot be
 *     re-entered into a group whose leader PID Poiesis still holds, and a
 *     recycled PID is never signalled individually.
 *   - Because per-PID identity cannot be re-confirmed, settlement on these
 *     platforms confirms by GROUP EMPTINESS (`kill(-pgid, 0)`), not by a
 *     per-PID identity scan, and reports the reduced evidence it actually
 *     has: `terminated` is empty when members cannot be enumerated.
 *   - A lease whose group id is not its PID is refused (`FOREIGN_PROCESS`):
 *     the detached-leader invariant is the only ownership proof available
 *     here, so a lease that does not satisfy it gets no cleanup at all.
 *
 * The trade is explicit: on these platforms a recycled group-leader PID is
 * the residual risk, and it is bounded by the fact that the leader PID is
 * held by the runner's own `ChildProcess` for the whole lifetime of the
 * run. It is strictly safer than the previous behaviour, which reported
 * every live PID as ambiguous and therefore refused to clean up anything.
 */
export const PROCESS_GROUP_ONLY_IDENTITY_MODEL = PROCESS_GROUPS_SUPPORTED && !PROCESS_START_IDENTITY_AVAILABLE;

/** Default bounded window between the graceful and forced termination phases. */
export const PROCESS_TERMINATION_GRACE_MS = 2_000;

/** Default bounded window for confirming that every descendant is gone. */
export const PROCESS_TERMINATION_CONFIRM_MS = 2_000;

const MAX_IDENTITY_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The transient identity lease for one managed subprocess. Every field is a
 * primitive so the lease stays structured-cloneable and JSON-round-trippable;
 * it never holds a process handle, a timer, or any runtime object.
 */
export interface ManagedProcessLease {
  /** Always {@link PROCESS_LEASE_SCHEMA}. */
  readonly schema: number;
  /** Identity of the managed operation that created the process. */
  readonly operationId: string;
  /** Identity of the Poiesis workspace that owns the operation. */
  readonly workspaceId: string;
  /** PID of the spawned child (the group leader under `detached: true`). */
  readonly pid: number;
  /** Process-group id of the isolated group the child leads. */
  readonly processGroupId: number;
  /** Kernel process-start identity, or `null` where unsupported. */
  readonly startIdentity: string | null;
}

export interface ManagedProcessLeaseInput {
  operationId: string;
  workspaceId: string;
  pid: number;
  /** Defaults to `pid`: a `detached: true` child always leads its own group. */
  processGroupId?: number;
}

/** Why a lease was refused. Every value means "no signal was sent". */
export type ManagedProcessLeaseRejection =
  /** The value is not a well-formed lease. */
  | "MALFORMED_LEASE"
  /** The lease names a process or group Poiesis must never signal. */
  | "UNSAFE_TARGET"
  /** This runtime can confirm a start identity and the lease carries none. */
  | "UNSUPPORTED_IDENTITY"
  /** The target is alive but its identity cannot be read. */
  | "IDENTITY_AMBIGUOUS"
  /** The PID is alive but is a different process than the one leased. */
  | "PID_REUSE"
  /** The live process is not in the process group the lease names. */
  | "FOREIGN_PROCESS";

export type ManagedProcessLeaseValidation =
  | {
      readonly accepted: true;
      readonly lease: ManagedProcessLease;
      /** `gone` means the leased PID no longer exists; nothing to signal. */
      readonly state: "live" | "gone";
      /** True only when the live target's identity was confirmed. */
      readonly verified: boolean;
    }
  | {
      readonly accepted: false;
      readonly reason: ManagedProcessLeaseRejection;
      readonly detail: string;
    };

export interface ManagedProcessLeaseValidationContext {
  /**
   * Require a process-start identity. Defaults to
   * {@link PROCESS_START_IDENTITY_SUPPORTED} so a runtime that CAN confirm
   * identity refuses a lease that cannot present one.
   */
  requireStartIdentity?: boolean;
}

export interface ProcessSettlementOptions {
  /** Bounded window between the graceful and forced phase. Defaults to 2s. */
  graceMs?: number;
  /** Bounded confirmation window. Defaults to 2s. `0` disables waiting. */
  confirmMs?: number;
}

export interface ManagedProcessSettlement {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly processGroupId: number;
  /** PIDs the settlement identified as owned group members. */
  readonly terminated: number[];
  /** PIDs still alive with the exact identity the settlement recorded. */
  readonly survived: number[];
  /** True only when every recorded descendant was confirmed terminated. */
  readonly confirmed: boolean;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startIdentity: string;
}

type ProcessIdentityProbe =
  | { readonly state: "live"; readonly identity: ProcessIdentity }
  /** No process-table entry, or an entry in a terminal task state. */
  | { readonly state: "gone"; readonly terminal: boolean }
  /**
   * Alive by `kill(pid, 0)` on a POSIX platform that cannot confirm a
   * process-start identity. This is the reduced-evidence state described by
   * {@link PROCESS_GROUP_ONLY_IDENTITY_MODEL}: the process exists, but the
   * only thing Poiesis can act on is the isolated group it created.
   */
  | { readonly state: "unidentified-live" }
  | { readonly state: "unreadable" };

/**
 * Task states that mean "this process will never execute again".
 *
 * A zombie (`Z`) has already terminated and is only waiting for its parent
 * to reap it; `X`/`x` is dead. Such a PID is still allocated, so it still
 * answers `kill(pid, 0)` and still appears in `/proc`, but no signal can
 * affect it and no code in it can run. Counting one as a live process would
 * report every completed cleanup as unresolved; counting one as a signal
 * target would be a no-op at best. It is therefore terminal: gone for
 * signalling and gone for confirmation, exactly like a reaped process.
 */
const TERMINAL_TASK_STATES = new Set(["Z", "X", "x"]);

/**
 * Read the identity of a live PID.
 *
 * `/proc/<pid>/stat` is field 3 after the `comm` field; `state` is that
 * field, `pgrp` is field 5, and `starttime` is field 22, so they are offsets
 * 0, 2, and 19 in the split. A stat line Poiesis cannot parse is reported
 * as `unreadable` rather than guessed: an unparseable identity is
 * ambiguity, and ambiguity fails closed.
 */
function probeProcessIdentity(pid: number): ProcessIdentityProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { state: "gone", terminal: false };
  }
  if (PROCESS_GROUP_IDENTITY_AVAILABLE) return probeLinuxProcessIdentity(pid);
  // No readable process table (non-Linux POSIX): liveness comes from
  // signal(0) alone, so the target can only be treated as "alive, identity
  // unconfirmable" and cleanup is restricted to its isolated group.
  return isSignalAlive(pid) ? { state: "unidentified-live" } : { state: "gone", terminal: false };
}

function probeLinuxProcessIdentity(pid: number): ProcessIdentityProbe {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH"
      ? { state: "gone", terminal: false }
      : { state: "unreadable" };
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const taskState = fields[0];
  // A terminated task is reported gone BEFORE its identity is trusted: it
  // must never be signalled, and its lingering PID must never be read as a
  // survivor. It is marked `terminal` so the liveness cross-check knows that
  // a still-answering `kill(pid, 0)` is expected rather than ambiguous.
  if (taskState !== undefined && TERMINAL_TASK_STATES.has(taskState)) {
    return { state: "gone", terminal: true };
  }
  const processGroupId = Number(fields[2]);
  const startIdentity = fields[19];
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0 || !isIdentityToken(startIdentity)) {
    return { state: "unreadable" };
  }
  return { state: "live", identity: { pid, processGroupId, startIdentity } };
}

function isIdentityToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH && /^\d+$/.test(value);
}

function isIdentityLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !CONTROL_CHARACTERS.test(value)
  );
}

/**
 * The one predicate that decides whether an operation / workspace label is
 * well-formed. Exported so the runner validates its own identity input with
 * exactly the same rule the lease shape uses.
 */
export function isManagedProcessLeaseLabel(value: unknown): value is string {
  return isIdentityLabel(value);
}

/**
 * Poiesis's own process-group id, or `null` where the runtime cannot read
 * it. Used to refuse any lease that would sweep in the Poiesis process
 * itself (and, transitively, the terminal or CI runner that started it).
 */
function ownProcessGroupId(): number | null {
  if (!PROCESS_GROUP_IDENTITY_AVAILABLE) return null;
  const probe = probeProcessIdentity(process.pid);
  return probe.state === "live" ? probe.identity.processGroupId : null;
}

/**
 * `kill(pid, 0)` liveness probe. Deliberately independent of the identity
 * source: when the two disagree the identity is ambiguous, and the caller
 * refuses.
 */
function isSignalAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLeaseShape(value: unknown): ManagedProcessLease | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<ManagedProcessLease>;
  if (candidate.schema !== PROCESS_LEASE_SCHEMA) return null;
  if (!isIdentityLabel(candidate.operationId)) return null;
  if (!isIdentityLabel(candidate.workspaceId)) return null;
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) < 2) return null;
  // The shape check proves TYPE only. Whether a well-formed process-group
  // id is an acceptable cleanup target (never 0, never 1, never Poiesis's
  // own group) is the safety check's decision, so the rejection reason
  // stays meaningful.
  if (!Number.isSafeInteger(candidate.processGroupId) || (candidate.processGroupId as number) < 0) return null;
  if (candidate.startIdentity !== null && !isIdentityToken(candidate.startIdentity)) return null;
  return {
    schema: PROCESS_LEASE_SCHEMA,
    operationId: candidate.operationId,
    workspaceId: candidate.workspaceId,
    pid: candidate.pid as number,
    processGroupId: candidate.processGroupId as number,
    startIdentity: candidate.startIdentity ?? null,
  };
}

function rejected(
  reason: ManagedProcessLeaseRejection,
  detail: string,
): ManagedProcessLeaseValidation {
  return { accepted: false, reason, detail };
}

function unsafeTargetReason(lease: ManagedProcessLease): ManagedProcessLeaseRejection | null {
  if (lease.pid === process.pid) return "UNSAFE_TARGET";
  // Process group 0 and 1 are never a managed group: 1 holds every process
  // that never joined a group of its own, so signalling it would reach
  // processes Poiesis never spawned.
  if (lease.processGroupId <= 1) return "UNSAFE_TARGET";
  if (lease.processGroupId === ownProcessGroupId()) return "UNSAFE_TARGET";
  return null;
}

/**
 * Build a lease for a process Poiesis just spawned under `detached: true`.
 *
 * The caller is the trusted runner, so this fails closed with a typed error
 * rather than returning a half-formed lease. The start identity is read
 * from the kernel immediately; a process that already exited simply yields
 * `null`, which later settlement treats as already settled.
 */
export function createManagedProcessLease(input: ManagedProcessLeaseInput): ManagedProcessLease {
  const lease = readLeaseShape({
    schema: PROCESS_LEASE_SCHEMA,
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    pid: input.pid,
    processGroupId: input.processGroupId ?? input.pid,
    startIdentity:
      PROCESS_GROUP_IDENTITY_AVAILABLE && Number.isSafeInteger(input.pid) ? readStartIdentity(input.pid) : null,
  });
  if (lease === null) {
    throw new PoiesisError("PROCESS_LEASE_MALFORMED", "Cannot lease a process with malformed identity fields", {
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      pid: input.pid,
    });
  }
  return lease;
}

function readStartIdentity(pid: number): string | null {
  const probe = probeProcessIdentity(pid);
  return probe.state === "live" ? probe.identity.startIdentity : null;
}

/**
 * Validate a lease BEFORE any signal is derived from it.
 *
 * Order matters and is part of the contract: shape, then safety, then
 * liveness, then identity confirmation. Safety is checked before liveness
 * so an unsafe target is refused even when nothing about it is readable,
 * and identity is confirmed only after the target is known to be alive.
 */
export function validateManagedProcessLease(
  value: unknown,
  context: ManagedProcessLeaseValidationContext = {},
): ManagedProcessLeaseValidation {
  const requireStartIdentity = context.requireStartIdentity ?? PROCESS_START_IDENTITY_SUPPORTED;
  const lease = readLeaseShape(value);
  if (lease === null) {
    return rejected("MALFORMED_LEASE", "Lease is not a well-formed managed process lease");
  }

  const unsafe = unsafeTargetReason(lease);
  if (unsafe !== null) {
    return rejected(unsafe, `Lease names an unsafe cleanup target (pid ${lease.pid}, group ${lease.processGroupId})`);
  }

  const probe = probeProcessIdentity(lease.pid);
  if (probe.state === "gone") {
    // A terminal task (zombie/dead) still answers signal(0) because its PID
    // is allocated, so that agreement is expected and the target is simply
    // finished. Only a PID with NO process-table entry contradicts
    // signal(0), and that contradiction is ambiguity.
    if (!probe.terminal && isSignalAlive(lease.pid)) {
      return rejected("IDENTITY_AMBIGUOUS", `PID ${lease.pid} is signal-alive but has no readable identity`);
    }
    return { accepted: true, lease, state: "gone", verified: false };
  }
  if (probe.state === "unreadable") {
    return rejected("IDENTITY_AMBIGUOUS", `PID ${lease.pid} is alive but its identity is unreadable`);
  }

  if (probe.state === "unidentified-live") {
    // Documented group-only model: the platform cannot confirm a
    // process-start identity, so the lease is accepted ONLY when the OS's
    // own detached-spawn invariant proves the group is Poiesis's. A group
    // whose id differs from its leader PID was not created by this runner,
    // so it is refused rather than signalled on a weaker basis than Linux.
    if (lease.processGroupId !== lease.pid) {
      return rejected(
        "FOREIGN_PROCESS",
        `PID ${lease.pid} is alive but the lease names group ${lease.processGroupId}, which is not the detached group this runner creates`,
      );
    }
    if (requireStartIdentity) {
      return rejected(
        "UNSUPPORTED_IDENTITY",
        `A process-start identity is required but this runtime cannot confirm one for PID ${lease.pid}`,
      );
    }
    return { accepted: true, lease, state: "live", verified: false };
  }

  if (lease.startIdentity === null) {
    if (requireStartIdentity) {
      return rejected(
        "UNSUPPORTED_IDENTITY",
        `This runtime can confirm a process-start identity, but lease ${lease.operationId} carries none`,
      );
    }
    return { accepted: true, lease, state: "live", verified: false };
  }
  if (probe.identity.startIdentity !== lease.startIdentity) {
    return rejected(
      "PID_REUSE",
      `PID ${lease.pid} now holds start identity ${probe.identity.startIdentity}, not ${lease.startIdentity}`,
    );
  }
  if (probe.identity.processGroupId !== lease.processGroupId) {
    return rejected(
      "FOREIGN_PROCESS",
      `PID ${lease.pid} is in process group ${probe.identity.processGroupId}, not ${lease.processGroupId}`,
    );
  }
  return { accepted: true, lease, state: "live", verified: true };
}

/**
 * Settle a managed process lease: terminate every process in the leased
 * group and confirm it is gone, or fail with a typed error.
 *
 * The settlement is bounded in both phases and never broad-matches: the
 * targets are the leased PID and the group members observed under that
 * exact process-group id with their exact start identities. Every member
 * signal re-reads the member's identity first, so a PID reused between the
 * snapshot and the signal is skipped rather than signalled.
 */
export async function settleManagedProcessLease(
  lease: ManagedProcessLease,
  options: ProcessSettlementOptions = {},
): Promise<ManagedProcessSettlement> {
  const graceMs = normalizeWindow(options.graceMs, PROCESS_TERMINATION_GRACE_MS, "graceMs");
  const confirmMs = normalizeWindow(options.confirmMs, PROCESS_TERMINATION_CONFIRM_MS, "confirmMs");

  const validation = validateManagedProcessLease(lease);
  const shape = readLeaseShape(lease);
  const operationId = shape?.operationId ?? "unknown";
  const workspaceId = shape?.workspaceId ?? "unknown";
  const processGroupId = shape?.processGroupId ?? 0;

  if (!validation.accepted) {
    throw new PoiesisError(
      "PROCESS_CLEANUP_REFUSED",
      `Managed process cleanup refused: ${validation.reason}`,
      {
        reason: validation.reason,
        detail: validation.detail,
        operationId,
        workspaceId,
        pid: shape?.pid ?? null,
        processGroupId,
      },
    );
  }

  // Fast path, and the leaked-descendant path alike: when the leased
  // process has already exited the group it left behind still has to be
  // settled — that is exactly the "successful command that leaks a
  // background process" case — but an empty group has nothing to clean, so
  // a normal run pays one `kill(-pgid, 0)` syscall and no /proc scan.
  if (!isGroupSignalAlive(processGroupId)) {
    return { operationId, workspaceId, processGroupId, terminated: [], survived: [], confirmed: true };
  }

  // PID -> recorded start identity for every group member observed. `null`
  // means this runtime cannot enumerate members, so settlement degrades to
  // the isolated group signal only.
  const members = snapshotProcessGroupMembers(processGroupId);

  signalIsolatedGroup(processGroupId, "SIGTERM");
  signalIdentifiedMembers(members, "SIGTERM");
  await waitForProcessGroupSettled(processGroupId, members, graceMs);

  // Re-snapshot before the forced phase: a TERM-handler descendant can fork
  // a replacement that the first snapshot could not have seen, and the
  // group leader's own exit can momentarily empty the group.
  refreshProcessGroupMembers(processGroupId, members);
  signalIsolatedGroup(processGroupId, "SIGKILL");
  signalIdentifiedMembers(members, "SIGKILL");
  await waitForProcessGroupSettled(processGroupId, members, confirmMs);

  const survived =
    members === null
      ? []
      : [...members.entries()]
          .filter(([pid, startIdentity]) => readStartIdentity(pid) === startIdentity)
          .map(([pid]) => pid)
          .sort((left, right) => left - right);

  // When members could not be enumerated there is no identity-confirmed
  // evidence that the forced phase emptied the group, so the group itself
  // is the only remaining evidence available. Claiming `confirmed` from an
  // absence of evidence would be exactly the unsupported unsafe behavior
  // this contract refuses.
  //
  // Known residual of the group-only model: an unreaped zombie left in the
  // group keeps `kill(-pgid, 0)` succeeding, so it reads as a
  // not-emptied group and the settlement fails closed. That is the safe
  // direction (Poiesis reports "not confirmed" rather than asserting a
  // cleanup it cannot see), and in practice killing the group leader
  // reparents the zombie to init, which reaps it. On Linux the per-PID
  // identity scan classifies zombies as terminated explicitly, so this
  // residual does not arise there.
  const groupStillExists = isGroupSignalAlive(processGroupId);

  const settlement: ManagedProcessSettlement = {
    operationId,
    workspaceId,
    processGroupId,
    terminated: members === null ? [] : [...members.keys()].sort((left, right) => left - right),
    survived,
    confirmed: survived.length === 0 && !groupStillExists,
  };

  if (!settlement.confirmed) {
    throw new PoiesisError(
      "PROCESS_CLEANUP_UNRESOLVED",
      `Managed process cleanup could not confirm termination of ${
        survived.length > 0 ? `${survived.length} process(es)` : "the managed process group"
      }`,
      {
        operationId,
        workspaceId,
        pid: shape?.pid ?? null,
        processGroupId,
        survived,
        membersEnumerated: members !== null,
        confirmed: false,
      },
    );
  }
  return settlement;
}

function normalizeWindow(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new PoiesisError(
      "PROCESS_CLEANUP_INVALID_WINDOW",
      `Process cleanup ${label} must be between 0 and 60000ms`,
      { [label]: value },
    );
  }
  return value;
}

/**
 * Enumerate the current members of a process group, keyed by PID with the
 * start identity observed for each. Returns `null` when member
 * enumeration is unsupported or the group could not be read, which callers
 * treat as "trust the isolated group only".
 */
function snapshotProcessGroupMembers(processGroupId: number): Map<number, string> | null {
  if (!PROCESS_GROUP_IDENTITY_AVAILABLE) return null;
  const members = new Map<number, string>();
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const probe = probeProcessIdentity(pid);
      if (probe.state !== "live") continue;
      if (probe.identity.processGroupId === processGroupId) members.set(pid, probe.identity.startIdentity);
    }
    return members;
  } catch {
    return null;
  }
}

/** Fold newly observed group members into the recorded identities. */
function refreshProcessGroupMembers(processGroupId: number, members: Map<number, string> | null): void {
  if (members === null) return;
  const current = snapshotProcessGroupMembers(processGroupId);
  if (current === null) return;
  for (const [pid, startIdentity] of current) members.set(pid, startIdentity);
}

/**
 * Signal every recorded member, re-reading its identity first. A member
 * whose PID was reused (different start identity) or which left the leased
 * group is skipped: it is not the process Poiesis leased.
 */
function signalIdentifiedMembers(members: Map<number, string> | null, signal: NodeJS.Signals): void {
  if (members === null) return;
  for (const [pid, startIdentity] of members) {
    const probe = probeProcessIdentity(pid);
    if (probe.state !== "live") continue;
    if (probe.identity.startIdentity !== startIdentity) continue;
    signalProcess(pid, signal);
  }
}

/**
 * Signal the isolated group. The group was created by the runner via
 * `detached: true`, so every member is a descendant the runner intends to
 * terminate. If the group signal fails, the validated lease still permits
 * signalling its own leader by PID.
 */
function signalIsolatedGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The group may already be gone, or may not be group-addressable on
    // this platform; the identified member pass below is authoritative.
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process exited after its identity check.
  }
}

/**
 * Bounded wait until the leased group is empty and no recorded member is
 * still alive. Exits early only when the group itself no longer exists and
 * no recorded member survives; a still-existing group (for example one
 * holding a freshly forked replacement) always uses the full window.
 */
async function waitForProcessGroupSettled(
  processGroupId: number,
  members: Map<number, string> | null,
  windowMs: number,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!isGroupSignalAlive(processGroupId) && !anyMemberAlive(members)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isGroupSignalAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function anyMemberAlive(members: Map<number, string> | null): boolean {
  if (members === null) return false;
  for (const [pid, startIdentity] of members) {
    if (readStartIdentity(pid) === startIdentity) return true;
  }
  return false;
}
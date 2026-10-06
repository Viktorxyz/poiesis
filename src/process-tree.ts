import { readFileSync } from "node:fs";
import { PoiesisError } from "./errors.js";

/**
 * Spec #168 / ticket #170, extended by ticket #180 — transient managed-process
 * identity leases, and the one authority cleanup may act on.
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
 * Ticket #180 sharpens that into a single rule with no exceptions:
 *
 *   1. Cleanup targets are derived ONLY from a validated lease. There is no
 *      process-name, port, user, or age matching anywhere in this module — a
 *      same-named unrelated process is never a target.
 *   2. A managed process group must be isolated. A lease that names the
 *      Poiesis process, process group 0/1, or Poiesis's own process group
 *      is refused, because signalling it would reach processes Poiesis
 *      never spawned.
 *   3. THE GROUP IS ADDRESSED AS A GROUP, NEVER AS A LIST OF MEMBERS. Nothing
 *      here enumerates the process table: no process-table walk, no member
 *      snapshot, no per-PID signal, and therefore no survivor list to
 *      report. A member that Poiesis cannot identify is never a target.
 *   4. THE GROUP MAY BE SIGNALLED ONLY WHILE ITS LEADER IS STILL PROVABLE.
 *      A process-group id is the PID of the process that created it, so once
 *      that leader is gone the id is a free PID that any later process may
 *      be handed — and a process that becomes a group leader with that id
 *      owns a brand-new group. Liveness of the group is therefore an
 *      ABSENCE fact and never an ownership one: `kill(-pgid, 0)` answering
 *      proves a group exists, nothing more.
 *   5. So the leader's identity — its exact start identity and its exact
 *      process-group id — is re-read immediately before EACH signal. If that
 *      read says the leader is gone, terminal, unreadable, reused, or
 *      foreign, no further signal is sent and the cleanup is reported
 *      unresolved with `GROUP_AUTHORITY_LOST`. Success is confirmed by
 *      exactly one thing: the group no longer exists.
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
 * Where it cannot, Poiesis has no ownership proof for a live managed group, so
 * it signals nothing at all and lets cleanup refuse — see the
 * `UNSUPPORTED_IDENTITY` rejection in {@link validateManagedProcessLease}.
 */
export const PROCESS_START_IDENTITY_SUPPORTED = PROCESS_START_IDENTITY_AVAILABLE;

/** Default bounded window between the graceful and forced termination phases. */
export const PROCESS_TERMINATION_GRACE_MS = 2_000;

/** Default bounded window for confirming that the managed group is gone. */
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

/**
 * What the kernel said about the leased leader when cleanup last looked.
 *
 * `live` is the only state that authorises a signal; every other value means
 * Poiesis cannot prove the group is still the one it created.
 */
export type ManagedProcessLeaderState =
  /** Confirmed: the exact start identity, in the exact leased group. */
  | "live"
  /** No process-table entry at that PID any more. */
  | "gone"
  /** A zombie or dead task still holding the PID until it is reaped. */
  | "terminal"
  /** Alive, but its identity cannot be read. */
  | "unreadable"
  /** The PID now holds a different process-start identity. */
  | "reused"
  /** Alive and identified, but in a different process group. */
  | "foreign"
  /** This runtime cannot confirm a start identity at all. */
  | "unconfirmed";

/** Why a settlement could not confirm that the managed group is gone. */
export type ManagedProcessCleanupUnresolvedReason =
  /**
   * The leader that made the group id meaningful stopped being provable while
   * the group still existed, so Poiesis had no authority left to signal it.
   */
  | "GROUP_AUTHORITY_LOST"
  /** The leader stayed provable and the group still existed anyway. */
  | "GROUP_STILL_PRESENT";

/** The phase a settlement had reached when it gave up. */
export type ManagedProcessCleanupPhase = "before-sigterm" | "before-sigkill" | "confirm";

export type ManagedProcessLeaseValidation =
  | {
      readonly accepted: true;
      readonly lease: ManagedProcessLease;
      /** `gone` means the leased PID no longer exists; nothing to signal. */
      readonly state: "live" | "gone";
      /** True only when the live target's identity was confirmed. */
      readonly verified: boolean;
      /**
       * True only for a `gone` state that still holds its PID because the task
       * is terminated (`Z`/`X`): a zombie is never a signal target and never a
       * survivor, and this is what lets a caller tell it apart from a reaped PID.
       */
      readonly terminal?: boolean;
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
  /**
   * Always `false`. Settlement reads no member list, so it reports no
   * terminated or surviving PIDs: an empty array here would be a claim about
   * processes it never enumerated.
   */
  readonly membersEnumerated: false;
  /** True only when the group no longer exists. */
  readonly confirmed: boolean;
}

/** What the last identity read of the leased leader said about the group. */
interface GroupAuthority {
  /** True only while the leader is provably still Poiesis's own. */
  readonly held: boolean;
  readonly leaderState: ManagedProcessLeaderState;
  readonly detail: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startIdentity: string;
}

/**
 * Spec #168 / ticket #182 — read the kernel identity of a PID NOW.
 *
 * This is the same single-entry process-table read
 * {@link validateManagedProcessLease} uses, exposed for the one caller that needs
 * the fact before it has a lease: the startup protocol compares what a child
 * REPORTED about itself against what the kernel says about that PID at this
 * instant, and refuses the run when the two disagree. It returns `null` for
 * anything it cannot confirm — no entry, a terminated task, an unreadable line,
 * or a platform with no readable process table — because "could not read it" and
 * "read it" must not look alike here any more than they do in a lease.
 *
 * Nothing about the leased leader is cached: the PID a process-start identity
 * protects is reusable the moment its holder exits, so a value read earlier is a
 * value about a process that may no longer exist.
 */
export function readManagedProcessIdentity(pid: number): ProcessIdentity | null {
  const probe = probeProcessIdentity(pid);
  return probe.state === "live" ? probe.identity : null;
}

type ProcessIdentityProbe =
  | { readonly state: "live"; readonly identity: ProcessIdentity }
  /** No process-table entry, or an entry in a terminal task state. */
  | { readonly state: "gone"; readonly terminal: boolean }
  /**
   * Alive by `kill(pid, 0)` on a POSIX platform that cannot confirm a
   * process-start identity. Poiesis has no ownership proof for such a
   * process and therefore no authority over its group either, so every
   * cleanup path here fails closed on it.
   */
  | { readonly state: "unidentified-live" }
  | { readonly state: "unreadable" };

/**
 * Task states that mean "this process will never execute again".
 *
 * A zombie (`Z`) has already terminated and is only waiting for its parent
 * to reap it; `X`/`x` is dead. Such a PID is still allocated, so it still
 * answers `kill(pid, 0)` and still has a process-table entry, but no signal can
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
 *
 * This is the ONLY process-table read in the managed lifecycle, and it reads
 * exactly one PID: the leased leader. Nothing here enumerates the table.
 */
function probeProcessIdentity(pid: number): ProcessIdentityProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { state: "gone", terminal: false };
  }
  if (PROCESS_GROUP_IDENTITY_AVAILABLE) return probeLinuxProcessIdentity(pid);
  // No readable process table (non-Linux POSIX): liveness comes from
  // signal(0) alone, so the target can never become an identity-confirmed
  // leader and no signal may be derived from it.
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
    return {
      accepted: true,
      lease,
      state: "gone",
      verified: false,
      ...(probe.terminal ? { terminal: true } : {}),
    };
  }
  if (probe.state === "unreadable") {
    return rejected("IDENTITY_AMBIGUOUS", `PID ${lease.pid} is alive but its identity is unreadable`);
  }

  if (probe.state === "unidentified-live") {
    // No readable process table: the process exists, but nothing about it can
    // be confirmed, so nothing about its group can be owned either. A group
    // whose id is not its leader's PID was never this runner's group at all.
    if (lease.processGroupId !== lease.pid) {
      return rejected(
        "FOREIGN_PROCESS",
        `PID ${lease.pid} is alive but the lease names group ${lease.processGroupId}, which is not the detached group this runner creates`,
      );
    }
    // Spec #168 / ticket #180: fail closed. Cleanup may signal a group only
    // while the leader that created it can be re-confirmed by exact start
    // identity and exact process-group id, and on a platform with no readable
    // process table neither field exists. "The child leads the group it was
    // spawned into" is not a weaker proof of ownership — it is none: the group
    // id IS that PID, and the PID becomes reusable the moment the leader
    // exits. So a live group here gets no signal at all.
    return rejected(
      "UNSUPPORTED_IDENTITY",
      `PID ${lease.pid} is live but this runtime cannot confirm a process-start identity, so its process group cannot be owned and no signal may be sent to it`,
    );
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
 * Settle a managed process lease: terminate the group it created and confirm
 * the group is gone, or fail with a typed error.
 *
 * Spec #168 / ticket #180. The group is the ONLY thing addressed: no member is
 * enumerated and no individual PID is ever signalled, so the settlement reports
 * `membersEnumerated: false` and no PID arrays. The algorithm is:
 *
 *   1. validate the lease (shape, safety, identity) — a refusal signals nothing;
 *   2. if the group does not exist, it is settled. Group liveness is an absence
 *      fact, so its absence settles the run with nothing to terminate;
 *   3. re-confirm the leader's exact start identity and process-group id, then
 *      signal the GROUP with SIGTERM;
 *   4. wait, bounded, for the group to disappear;
 *   5. re-confirm the leader the same way, then signal the GROUP with SIGKILL;
 *   6. wait, bounded, for the group to disappear.
 *
 * If a re-confirmation fails while the group still exists, no signal follows it:
 * the settlement reports `PROCESS_CLEANUP_UNRESOLVED` / `GROUP_AUTHORITY_LOST`
 * with the phase it reached and what the leader then read as. A group that
 * outlives both phases while its leader stayed provable is reported as
 * `GROUP_STILL_PRESENT` — also unresolved, because Poiesis did not empty it.
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

  // The group is gone, so there is nothing left to terminate and nothing to
  // own: a successful command that leaked nothing, and the leaked-descendant
  // case whose descendants have already finished, both settle here.
  if (!isGroupSignalAlive(processGroupId)) return settled(operationId, workspaceId, processGroupId, true);

  const graceful = confirmGroupAuthority(lease);
  if (!graceful.held) {
    throw authorityLost({ operationId, workspaceId, processGroupId, pid: shape?.pid ?? null, phase: "before-sigterm", leader: graceful });
  }
  signalIsolatedGroup(processGroupId, "SIGTERM");
  if (await waitForGroupGone(processGroupId, graceMs)) {
    return settled(operationId, workspaceId, processGroupId, true);
  }

  const forced = confirmGroupAuthority(lease);
  if (!forced.held) {
    throw authorityLost({ operationId, workspaceId, processGroupId, pid: shape?.pid ?? null, phase: "before-sigkill", leader: forced });
  }
  signalIsolatedGroup(processGroupId, "SIGKILL");
  if (await waitForGroupGone(processGroupId, confirmMs)) {
    return settled(operationId, workspaceId, processGroupId, true);
  }

  throw new PoiesisError(
    "PROCESS_CLEANUP_UNRESOLVED",
    `Managed process group ${processGroupId} still exists after SIGTERM and SIGKILL`,
    {
      reason: "GROUP_STILL_PRESENT",
      phase: "confirm",
      operationId,
      workspaceId,
      pid: shape?.pid ?? null,
      processGroupId,
      membersEnumerated: false,
      confirmed: false,
    },
  );
}

function settled(
  operationId: string,
  workspaceId: string,
  processGroupId: number,
  confirmed: boolean,
): ManagedProcessSettlement {
  return { operationId, workspaceId, processGroupId, membersEnumerated: false, confirmed };
}

/**
 * Spec #168 / ticket #180 — did the kernel just confirm the leader?
 *
 * This is the ONLY authority cleanup has. `held` is true only when the leased
 * PID is alive with the exact start identity the lease recorded AND is still
 * in the exact process group the lease names — read now, not remembered from
 * lease creation, because the whole point is that the group id (which IS that
 * PID) may have been reused since.
 */
function confirmGroupAuthority(lease: ManagedProcessLease): GroupAuthority {
  const validation = validateManagedProcessLease(lease);
  if (!validation.accepted) {
    return {
      held: false,
      leaderState: leaderStateOfRejection(validation.reason),
      detail: validation.detail,
    };
  }
  if (validation.verified && validation.state === "live") {
    return {
      held: true,
      leaderState: "live",
      detail: `PID ${validation.lease.pid} still holds start identity ${String(validation.lease.startIdentity)} in group ${validation.lease.processGroupId}`,
    };
  }
  const leaderState: ManagedProcessLeaderState =
    validation.state === "gone" ? (validation.terminal === true ? "terminal" : "gone") : "unconfirmed";
  return {
    held: false,
    leaderState,
    detail:
      leaderState === "gone"
        ? `PID ${validation.lease.pid} no longer exists while its process group ${validation.lease.processGroupId} still does`
        : leaderState === "terminal"
          ? `PID ${validation.lease.pid} is a terminated task (zombie), so its group ${validation.lease.processGroupId} can no longer be owned`
          : `PID ${validation.lease.pid} carries no confirmed start identity for group ${validation.lease.processGroupId}`,
  };
}

function leaderStateOfRejection(reason: ManagedProcessLeaseRejection): ManagedProcessLeaderState {
  switch (reason) {
    case "PID_REUSE":
      return "reused";
    case "FOREIGN_PROCESS":
      return "foreign";
    case "IDENTITY_AMBIGUOUS":
      return "unreadable";
    default:
      return "unconfirmed";
  }
}

/**
 * The typed failure for a group Poiesis may no longer signal. The details name
 * the phase reached, what the leader read as, the group, and the fact that no
 * member list exists — an operator reading this learns that something is still
 * running that Poiesis declined to touch, not which processes those were.
 */
function authorityLost(input: {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly processGroupId: number;
  readonly pid: number | null;
  readonly phase: ManagedProcessCleanupPhase;
  readonly leader: GroupAuthority;
}): PoiesisError {
  return new PoiesisError(
    "PROCESS_CLEANUP_UNRESOLVED",
    `Managed process cleanup lost the authority to signal group ${input.processGroupId}: the leader reads as ${input.leader.leaderState}`,
    {
      reason: "GROUP_AUTHORITY_LOST",
      phase: input.phase,
      leaderState: input.leader.leaderState,
      detail: input.leader.detail,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      pid: input.pid,
      processGroupId: input.processGroupId,
      membersEnumerated: false,
      confirmed: false,
    },
  );
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
 * Signal the isolated group — the ONLY signal this module ever sends.
 *
 * The group was created by the runner via `detached: true`, so every member is
 * a descendant the runner intends to terminate, and it is addressed as a group
 * because no member can be individually identified. The caller re-confirmed the
 * leader immediately before this ran. A failure here is not reported as a
 * problem: the emptiness confirmation that follows is the authority, not the
 * delivery of the request.
 */
function signalIsolatedGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The group may already be gone; the confirmation below decides the outcome.
  }
}

/**
 * Bounded wait for the leased group to stop existing. It waits on group
 * liveness alone, because that is the only fact that can be waited on without
 * enumerating the processes inside it.
 */
async function waitForGroupGone(processGroupId: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!isGroupSignalAlive(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !isGroupSignalAlive(processGroupId);
}

function isGroupSignalAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
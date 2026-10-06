import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PoiesisError } from "./errors.js";

/**
 * Spec #168 / ticket #176 — capability-bound process containment.
 *
 * A managed PROCESS GROUP is isolation, not containment. `setsid(2)` moves a
 * process into a brand-new session with a brand-new process group, and a
 * process whose parent dies is reparented; both leave the group the runner
 * created. Once that has happened no amount of post-hoc polling can prove where
 * the process went, so Poiesis never claims that it detected the escape — the
 * only honest boundary is one the kernel enforces.
 *
 * Absolute containment is therefore CAPABILITY-BOUND, and this module is the
 * only place that decides which capability exists:
 *
*   - Linux, delegated cgroup v2 — Poiesis provisions its own leaf BEFORE the
 *     spawn, admits the child through a deterministic admission barrier, and
 *     settles the leaf with `cgroup.kill` confirmed by `cgroup.events`.
 *     Membership is inherited across `fork` and is unaffected by `setsid` and
 *     reparenting, so this is an absolute boundary.
 *   - Windows — a no-breakaway Job Object created by a native launcher. This
 *     package has no native launcher, so the capability is absent.
 *   - non-Linux POSIX — no portable strong primitive exists at all.
 *
 * When the capability is absent the caller MUST fail before spawning. Running
 * the command anyway and reporting success would be the exact false claim this
 * contract exists to prevent.
 *
 * === The exact boundary this module enforces ===
 *
 *   - the leaf is provisioned BEFORE the process is created, so a run that
 *     cannot be contained never starts;
 *   - the child is spawned into a Poiesis-owned ADMISSION PROLOGUE, not into the
 *     command processor. The prologue runs Poiesis's own shell text, moves ITSELF
 *     into the leaf, confirms its own kernel membership by reading
 *     `cgroup.procs` back, reports that confirmation to the parent, and only
 *     then `exec`s the already-resolved processor with the already-resolved
 *     argv;
 *   - therefore NO caller command text can execute before admission is
 *     confirmed. The prologue is the only thing that runs before it, it is
 *     Poiesis-owned, and it contains no caller data;
 *   - the parent refuses the run unless that confirmation arrives. There is no
 *     path on which an unconfirmed child is reported contained, whether it is
 *     still live or already finished;
 *   - every process the command creates after admission inherits the leaf;
 *   - settlement is `cgroup.kill` confirmed by the kernel's own
 *     `cgroup.events populated=0`, so a surviving member fails closed.
 *
 * What is NOT claimed, and never is: that Poiesis detects an escape. It never
 * polls for one, never matches on a process name, port, user, or age, and never
 * scans the system.
 */

/**
 * The admission barrier: a Poiesis-owned shell prologue that admits ITSELF and
 * then becomes the command.
 *
 * Deterministic by construction: the prologue is the child's whole world until
 * admission is confirmed, so the ordering "admission confirmed, then any caller
 * text runs" is enforced by the prologue's own control flow rather than by a
 * parent-side `write(2)` racing the child's `execve`. The caller's command text
 * is never interpolated into this script — the processor and its argv arrive as
 * positional parameters and are handed to `exec` verbatim, so the final argv
 * element is byte-identical to what the caller passed.
 *
 * The leaf arrives out of band, in the environment, so it cannot appear in the
 * command's own argv.
 */
export const ADMISSION_PROLOGUE = [
  'leaf=$POIESIS_ADMISSION_LEAF',
  '[ -n "$leaf" ] || exit 71',
  'printf %s\\\\n "$$" > "$leaf/cgroup.procs" || exit 70',
  'member=0',
  'while IFS= read -r line; do',
  '  if [ "$line" = "$$" ]; then member=1; break; fi',
  'done < "$leaf/cgroup.procs"',
  '[ "$member" = 1 ] || exit 71',
  // Report the confirmed admission, then close the report channel so the command
  // never inherits it. A refusal above exits instead, and the parent sees the
  // channel close with no report.
  'printf a >&3 || exit 71',
  // The leaf has already been read into `$leaf`, so the Poiesis-owned variable is
  // no longer needed. Scrubbing it here means the caller's command never inherits
  // Poiesis's internal boundary path. It is deliberately NOT fatal: `unset` on an
  // already-unset variable always succeeds, so the only way this can fail is a
  // processor that refuses to drop a variable — which must not turn a confirmed
  // admission into a refusal.
  'unset POIESIS_ADMISSION_LEAF || :',
  'exec "$@" 3>&-',
  "",
].join("\n");

/** The environment variable that carries the provisioned leaf out of band. */
export const ADMISSION_LEAF_ENV = "POIESIS_ADMISSION_LEAF";

/** The single byte the prologue writes once the kernel confirms its membership. */
export const ADMISSION_CONFIRMATION = "a";

/** `$0` for the admission prologue; it keeps the caller's argv positions intact. */
export const ADMISSION_ARGV0 = "poiesis-admission";

/** Bounded window the parent waits for the admission confirmation. */
export const ADMISSION_CONFIRM_MS = 5_000;

/**
 * Spec #168 / ticket #176 — bounded window the parent drains the report channel
 * before it refuses a run.
 *
 * The prologue writes the confirmation and then immediately `exec`s, so the two
 * facts the parent observes — the report byte on fd3 and the child's `exit` —
 * race in the parent's own event loop: Node can deliver `exit` before an already
 * written byte has been read off the pipe. Treating that ordering as a refusal
 * would report a genuinely admitted run as unconfirmed, which is the opposite
 * failure and just as dishonest. So a non-confirmation drains the channel for
 * this window first. It is a bound, not a wait: a channel that never reports is
 * still refused, one bound later.
 */
export const ADMISSION_DRAIN_MS = 250;

/** True when a chunk read from the report channel carries the confirmation. */
export function isAdmissionConfirmation(chunk: string): boolean {
  return chunk.includes(ADMISSION_CONFIRMATION);
}

/** The three containment models Poiesis can name. */
export type ContainmentModel = "process-group" | "cgroup-v2" | "job-object";

/**
 * The model a managed shell command REQUIRES. It is deliberately not
 * `process-group`: that is the documented contract for direct low-level `run()`
 * callers, and it is not strong containment.
 */
export const STRONG_CONTAINMENT_MODEL: ContainmentModel = "cgroup-v2";

/** Why a containment model cannot be enforced here. */
export type ContainmentUnavailableReason =
  /** The model is not a strong model at all. */
  | "NOT_STRONG_CONTAINMENT"
  /** The platform has no primitive this model names. */
  | "UNSUPPORTED_PLATFORM"
  /** No unified cgroup v2 hierarchy is exposed. */
  | "NO_CGROUP_V2"
  /** The hierarchy exists but Poiesis was delegated no writable subtree. */
  | "NO_DELEGATION"
  /** The leaf has no atomic `cgroup.kill`. */
  | "NO_CGROUP_KILL"
  /** The leaf could not be created. */
  | "PROVISION_FAILED"
  /** The native launcher a Windows Job Object needs is not available. */
  | "NO_JOB_OBJECT_LAUNCHER";

export interface ContainmentCapability {
  readonly model: ContainmentModel;
  readonly available: boolean;
  readonly platform: NodeJS.Platform;
  /** `null` exactly when `available` is true. */
  readonly reason: ContainmentUnavailableReason | null;
  readonly detail: string;
  /** Absolute delegated parent directory, or `null` when unresolved. */
  readonly parent: string | null;
}

/**
 * One provisioned containment boundary. Transient and in-memory: it holds a
 * kernel path and nothing else, and it is released as soon as the run settles.
 */
export interface ManagedContainmentLease {
  readonly model: ContainmentModel;
  readonly operationId: string;
  /** Absolute leaf path, or `null` for models with no filesystem boundary. */
  readonly leaf: string | null;
}

export interface ContainmentSettlement {
  readonly model: ContainmentModel;
  readonly leaf: string | null;
  /** PIDs the leaf still listed when settlement gave up. */
  readonly survived: number[];
  readonly confirmed: boolean;
}

export interface ContainmentSettlementOptions {
  /** Bounded confirmation window. Defaults to 2s. */
  windowMs?: number;
}

/** Bounded confirmation window for a `cgroup.kill` to empty the leaf. */
export const CONTAINMENT_SETTLE_MS = 2_000;

const CGROUP_ROOT = "/sys/fs/cgroup";
const SELF_CGROUP = "/proc/self/cgroup";
const MAX_LEAF_TOKEN = 48;

let leafCounter = 0;

function unavailable(
  model: ContainmentModel,
  reason: ContainmentUnavailableReason,
  detail: string,
  parent: string | null = null,
): ContainmentCapability {
  return { model, available: false, platform: process.platform, reason, detail, parent };
}

function available(model: ContainmentModel, detail: string, parent: string | null): ContainmentCapability {
  return { model, available: true, platform: process.platform, reason: null, detail, parent };
}

/**
 * Report the containment capability this runtime can actually enforce.
 *
 * This is a REPORT, never a fallback: callers that require strong containment
 * either get `available: true` or a typed refusal before anything is spawned.
 */
export function resolveContainmentCapability(
  model: ContainmentModel = STRONG_CONTAINMENT_MODEL,
): ContainmentCapability {
  if (model === "process-group") {
    return unavailable(
      model,
      "NOT_STRONG_CONTAINMENT",
      "A POSIX process group is not strong containment: setsid(2) creates a new session and process group, and a descendant is reparented when its parent exits. Neither is visible to a group-directed signal afterwards, and post-hoc polling cannot prove where the process went.",
    );
  }
  if (model === "job-object") {
    return unavailable(
      model,
      "NO_JOB_OBJECT_LAUNCHER",
      "Windows containment requires a no-breakaway Job Object created by a native launcher before the child is created; this runtime ships no such launcher, so it cannot create one at the spawn boundary.",
    );
  }
  if (process.platform !== "linux") {
    return unavailable(
      model,
      "UNSUPPORTED_PLATFORM",
      process.platform === "win32"
        ? "Windows has no cgroup hierarchy: absolute containment there requires a no-breakaway Job Object created by a native launcher, which this runtime does not provide."
        : "macOS and the other non-Linux POSIX platforms expose no portable strong containment primitive; only POSIX process groups exist there, and setsid(2) leaves them.",
    );
  }

  let unified: string | null = null;
  try {
    for (const line of readFileSync(SELF_CGROUP, "utf8").split("\n")) {
      // Field 2 of the v2 line is empty; a populated one means a v1 hierarchy.
      if (line.startsWith("0::")) {
        unified = line.slice(3).trim();
        break;
      }
    }
  } catch {
    unified = null;
  }
  if (unified === null) {
    return unavailable(model, "NO_CGROUP_V2", `This host does not expose a unified cgroup v2 hierarchy (${SELF_CGROUP} names none).`);
  }
  if (!existsSync(join(CGROUP_ROOT, "cgroup.controllers"))) {
    return unavailable(model, "NO_CGROUP_V2", `No unified cgroup v2 hierarchy is mounted at ${CGROUP_ROOT}.`);
  }
  const parent = join(CGROUP_ROOT, unified);
  try {
    if (!statSync(parent).isDirectory()) {
      return unavailable(
        model,
        "NO_DELEGATION",
        `Poiesis's own cgroup path ${parent} is not a directory, so no delegated subtree can host a managed leaf.`,
      );
    }
  } catch (error) {
    return unavailable(
      model,
      "NO_DELEGATION",
      `Poiesis cannot reach its own cgroup path ${parent} (${(error as NodeJS.ErrnoException).code ?? "unknown"}), so no delegated subtree is usable.`,
    );
  }
  return available(
    model,
    `A delegated cgroup v2 subtree is available at ${parent}; managed leaves can be created, entered, killed, and confirmed empty there.`,
    parent,
  );
}

/**
 * The one actionable refusal a caller raises before it creates a process it
 * could not contain.
 */
export function containmentUnavailableError(
  capability: ContainmentCapability,
  remediation: string,
): PoiesisError {
  return new PoiesisError(
    "PROCESS_CONTAINMENT_UNAVAILABLE",
    `Managed command execution requires strong process containment, and this runtime cannot provide ${capability.model}: ${capability.detail}`,
    {
      containment: capability.model,
      platform: capability.platform,
      reason: capability.reason,
      detail: capability.detail,
      ...(capability.parent === null ? {} : { parent: capability.parent }),
      remediation,
    },
  );
}

/**
 * Provision the boundary, BEFORE the process exists.
 *
 * Throws `PROCESS_CONTAINMENT_UNAVAILABLE` when the model cannot be enforced.
 * The caller must let that propagate: it is a fail-closed refusal, not a
 * warning, and nothing has been created yet.
 */
export function provisionContainment(input: {
  model: ContainmentModel;
  operationId: string;
  remediation: string;
}): ManagedContainmentLease {
  const capability = resolveContainmentCapability(input.model);
  if (!capability.available || capability.parent === null) {
    throw containmentUnavailableError(capability, input.remediation);
  }

  leafCounter += 1;
  const leaf = join(capability.parent, leafName(input.operationId));
  try {
    mkdirSync(leaf, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw containmentUnavailableError(
      unavailable(input.model, "PROVISION_FAILED", `The managed cgroup leaf ${leaf} could not be created (${code}).`, capability.parent),
      input.remediation,
    );
  }

  // `cgroup.kill` is the atomic primitive. Without it, cleanup could only
  // enumerate and signal members, which a fork between read and signal defeats,
  // so the leaf is not strong containment and the run must not start.
  for (const required of ["cgroup.kill", "cgroup.procs", "cgroup.events"]) {
    if (existsSync(join(leaf, required))) continue;
    rmdirSync(leaf);
    throw containmentUnavailableError(
      unavailable(input.model, "NO_CGROUP_KILL", `The managed cgroup leaf ${leaf} exposes no ${required}.`, capability.parent),
      input.remediation,
    );
  }

  return { model: input.model, operationId: input.operationId, leaf };
}

/**
 * The parent's side of admission. It has exactly one outcome — refusal.
 *
 * The prologue admits and confirms itself; the parent decides. If the
 * confirmation never arrived, Poiesis does not know whether the child is inside
 * the boundary or outside it, and a process it cannot place is a process it
 * cannot settle, so the run is refused. There is deliberately NO "it probably
 * made it" branch: a live child and a finished child are both unconfirmed
 * unless the prologue said otherwise, because "finished" is exactly the case
 * where nothing can be re-checked afterwards.
 *
 * @throws `PROCESS_CONTAINMENT_REFUSED` — always, unless admission confirmed.
 */
export function requireConfirmedAdmission(
  lease: ManagedContainmentLease,
  input: { confirmed: boolean; pid: number; detail: string },
): void {
  if (input.confirmed) return;
  throw new PoiesisError(
    "PROCESS_CONTAINMENT_REFUSED",
    `Managed command ${input.pid} never reported a confirmed admission to the managed containment ${lease.leaf ?? "<none>"}: ${input.detail}`,
    {
      containment: lease.model,
      pid: input.pid,
      reason: "ADMISSION_UNCONFIRMED",
      detail: input.detail,
      confirmed: false,
    },
  );
}

/**
 * Settle the boundary: kill everything in it, then confirm from the kernel that
 * it is empty.
 *
 * `populated` in `cgroup.events` is the authoritative emptiness fact; a leaf
 * that still reports members after the bounded window is `PROCESS_CLEANUP_
 * UNRESOLVED`, never a silent success.
 */
export async function settleContainment(
  lease: ManagedContainmentLease,
  options: ContainmentSettlementOptions = {},
): Promise<ContainmentSettlement> {
  const leaf = lease.leaf;
  if (leaf === null) {
    return { model: lease.model, leaf: null, survived: [], confirmed: true };
  }
  const windowMs = options.windowMs ?? CONTAINMENT_SETTLE_MS;
  if (isLeafPopulated(leaf)) {
    try {
      writeFileSync(join(leaf, "cgroup.kill"), "1");
    } catch {
      // The leaf may already be gone; the emptiness confirmation below is the
      // authority, not this write.
    }
  }
  const deadline = Date.now() + windowMs;
  while (isLeafPopulated(leaf) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // `populated` is the authoritative fact. A leaf the kernel still reports as
  // populated is a cleanup Poiesis cannot confirm, whatever the PID listing
  // happens to show, so it fails closed rather than reasoning about the gap.
  if (isLeafPopulated(leaf)) {
    throw new PoiesisError(
      "PROCESS_CLEANUP_UNRESOLVED",
      `Managed containment ${leaf} still reports a populated cgroup after cgroup.kill`,
      { containment: lease.model, leaf, survived: listLeafPids(leaf), populated: true, confirmed: false },
    );
  }
  return { model: lease.model, leaf, survived: [], confirmed: true };
}

/**
 * Drop the provisioned boundary. Best effort and idempotent: a leaf that is
 * still populated cannot be removed, and the run has already settled with the
 * outcome that explains why.
 */
export function releaseContainment(lease: ManagedContainmentLease | null): void {
  if (lease?.leaf === null || lease === null) return;
  try {
    rmdirSync(lease.leaf);
  } catch {
    // EBUSY while a member is still present, ENOENT when it never existed.
  }
}

function leafName(operationId: string): string {
  const token = operationId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, MAX_LEAF_TOKEN);
  return `poiesis-${token}-${process.pid}-${leafCounter}`;
}

function listLeafPids(leaf: string): number[] {
  try {
    return readFileSync(join(leaf, "cgroup.procs"), "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function isLeafPopulated(leaf: string): boolean {
  try {
    for (const line of readFileSync(join(leaf, "cgroup.events"), "utf8").split("\n")) {
      if (line.startsWith("populated")) return line.split(/\s+/)[1] === "1";
    }
  } catch {
    // A leaf whose events file cannot be read cannot be confirmed empty.
    return true;
  }
  return true;
}
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
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
 *   - the child is spawned into a Poiesis-owned STARTUP PROLOGUE, not into the
 *     command processor, and it is spawned with NO caller text in its argv at
 *     all. The prologue is Poiesis's own shell text and nothing else;
 *   - startup is TWO PHASE, and each phase earns its authority before it is
 *     used (ticket #182):
 *       1. the prologue reports its own kernel PID, process-group id, and
 *          process-start identity and WAITS. The parent checks that report
 *          against `child.pid` AND against a fresh kernel read, establishes a
 *          live validated lease, and only then sends the admission token;
 *       2. the prologue admits ITSELF into the leaf, confirms that membership is
 *          bound to the SAME identity it reported, reports that, and waits for a
 *          DISTINCT execution token. The parent checks the admitted report
 *          against the identity it leased, then releases the caller's argv;
 *   - so no caller command text exists in the child's argv before admission,
 *     nothing runs before it is released, and stdin, the command timeout, and
 *     cancellation arm only after authority exists;
 *   - the parent refuses the run unless both reports arrive and both bind. There
 *     is no path on which an unconfirmed child is reported contained, whether it
 *     is still live or already finished;
 *   - the boundary path, both tokens, and Poiesis's own variables are scrubbed
 *     before `exec`, so the caller's process inherits none of them;
 *   - every process the command creates after admission inherits the leaf;
 *   - settlement is `cgroup.kill` confirmed by the kernel's own
 *     `cgroup.events populated=0`, so a surviving member fails closed.
 *
 * What is NOT claimed, and never is: that Poiesis detects an escape. It never
 * polls for one, never matches on a process name, port, user, or age, and never
 * scans the system.
 */

/**
 * The two-phase startup protocol: a Poiesis-owned shell prologue that reports
 * itself, waits for authority, admits itself, waits again, and only then runs
 * the caller's exact argv.
 *
 * Deterministic by construction. Every byte the caller's text would occupy is
 * held by the parent until the parent has a live validated lease AND a
 * confirmed admission, so "no caller text before admission" is not a race
 * between a parent-side write and a child-side `execve` — the text does not
 * exist yet. The prologue is the only thing running in that window, it is
 * Poiesis-owned, and it contains no caller data at all.
 *
 * Channel direction matters here, and it is a kernel fact rather than a
 * convention: for `stdio` entries above fd 0 Node gives the PARENT the reading
 * end of the pipe, so a parent→child channel can only be the child's stdin. The
 * prologue therefore reads Poiesis's gate from fd 0, and it reads exactly the
 * frames it is entitled to, leaving anything the caller piped in unread for the
 * command it `exec`s.
 *
 * Frames, in order, all newline-terminated: the admission token, then the
 * distinct execution token, then the argv count, then one frame per argv
 * element. Every element is octal-escaped by the parent, so a frame can contain
 * no literal newline and the shell's line reader is exact. It is decoded with
 * `printf %b`, which POSIX makes a `sh` regular built-in, so the last element
 * the command sees is byte-identical to what the caller passed.
 *
 * The leaf and both tokens arrive out of band, in the environment, so they can
 * never appear in the caller's own argv — and are unset before `exec`.
 */
export const ADMISSION_PROLOGUE = [
  // Pathname expansion is disabled for this script only: the frames below are
  // split into positional parameters, and a glob in a /proc field must never be
  // expanded into filenames.
  "set -f",
  // 1. Report THIS process's kernel identity, then wait for authority. Nothing
  //    the caller said is in this process yet, not even in its argv.
  "stat_line=",
  'IFS= read -r stat_line < "/proc/$$/stat" || exit 72',
  'rest=${stat_line##*") "}',
  "set -- $rest",
  "state=$1",
  "pgid=$3",
  "start=${20}",
  "case $state in Z|X|x) exit 73 ;; esac",
  "printf 'I %s %s %s\\n' \"$$\" \"$pgid\" \"$start\" >&3 || exit 74",
  // 2. The parent validated that report and leased this identity. Its answer is
  //    a token only it knows; anything else — including a closed gate — exits.
  "IFS= read -r gate || exit 75",
  '[ "$gate" = "A $POIESIS_ADMISSION_TOKEN" ] || exit 76',
  // 3. Admit ITSELF into the provisioned leaf, exactly as the boundary requires.
  "leaf=$POIESIS_ADMISSION_LEAF",
  '[ -n "$leaf" ] || exit 71',
  "printf '%s\\n' \"$$\" > \"$leaf/cgroup.procs\" || exit 70",
  "member=0",
  "while IFS= read -r listed; do",
  '  if [ "$listed" = "$$" ]; then member=1; break; fi',
  'done < "$leaf/cgroup.procs"',
  '[ "$member" = 1 ] || exit 71',
  // 4. The membership must be bound to the SAME identity that was reported and
  //    leased. A report is a claim about a process; these two fields are what
  //    make it a claim about THIS process.
  "admitted=",
  'IFS= read -r admitted < "/proc/$$/stat" || exit 77',
  'rest=${admitted##*") "}',
  "set -- $rest",
  '[ "$3" = "$pgid" ] || exit 78',
  '[ "${20}" = "$start" ] || exit 79',
  "printf 'A %s %s %s\\n' \"$$\" \"$pgid\" \"$start\" >&3 || exit 80",
  // 5. A DISTINCT execution token. The admission token cannot double as it, so
  //    a replay of the first phase cannot release the caller's text.
  "IFS= read -r gate || exit 81",
  '[ "$gate" = "E $POIESIS_EXECUTION_TOKEN" ] || exit 82',
  // 6. The caller's exact argv, one octal-escaped frame per element. The count
  //    is read first so the loop consumes exactly the frames the parent sent and
  //    never a byte of the caller's own stdin.
  "IFS= read -r count || exit 83",
  'case $count in ""|*[!0-9]*) exit 84 ;; esac',
  // Bounded before any arithmetic: the count can only be a number the parent's
  // own argv could produce, and a value this shell cannot hold is refused rather
  // than evaluated into a diagnostic on the caller's stderr.
  "[ ${#count} -le 4 ] || exit 84",
  "[ $count -ge 1 ] && [ $count -le 4096 ] || exit 84",
  "set --",
  "n=0",
  'while [ "$n" -lt "$count" ]; do',
  "  IFS= read -r encoded || exit 85",
  "  argument=\"$(printf '%b' \"$encoded\"; printf X)\"",
  "  argument=${argument%X}",
  '  set -- "$@" "$argument"',
  "  n=$((n + 1))",
  "done",
  // 7. Nothing Poiesis-owned reaches the caller's process: the boundary path and
  //    both tokens are dropped, and the report channel is closed so no
  //    descendant inherits it. `unset` on a missing name always succeeds, so
  //    this can never turn a released run into a refusal.
  "unset POIESIS_ADMISSION_LEAF POIESIS_ADMISSION_TOKEN POIESIS_EXECUTION_TOKEN || :",
  'exec "$@" 3>&-',
  "",
].join("\n");

/** The environment variable that carries the provisioned leaf out of band. */
export const ADMISSION_LEAF_ENV = "POIESIS_ADMISSION_LEAF";

/**
 * Spec #168 / ticket #182 — the environment variable that carries the admission
 * token out of band. The parent is the only holder of its value, so the token is
 * proof that the parent itself decided the child may admit itself.
 */
export const ADMISSION_TOKEN_ENV = "POIESIS_ADMISSION_TOKEN";

/**
 * Spec #168 / ticket #182 — the DISTINCT execution token. It is not the
 * admission token, and it is not derived from anything the child has already
 * seen, so replaying the first phase cannot release the caller's argv.
 */
export const EXECUTION_TOKEN_ENV = "POIESIS_EXECUTION_TOKEN";

/** Every Poiesis-owned variable the prologue must not leave behind. */
export const STARTUP_ENVIRONMENT_KEYS = [
  ADMISSION_LEAF_ENV,
  ADMISSION_TOKEN_ENV,
  EXECUTION_TOKEN_ENV,
] as const;

/** The first frame the prologue writes: its kernel identity, before any authority. */
export const STARTUP_IDENTITY_REPORT = "I";

/** The frame that confirms its admission, bound to the identity it reported. */
export const ADMISSION_CONFIRMATION = "A";

/** `$0` for the startup prologue. It is Poiesis-owned and carries no caller text. */
export const ADMISSION_ARGV0 = "poiesis-admission";

/** Bounded window the parent waits for each startup report. */
export const ADMISSION_CONFIRM_MS = 5_000;

/**
 * Spec #168 / ticket #182 — one startup identity, as the kernel reports it.
 *
 * These three fields are the whole of what identifies a process for this
 * protocol: a PID names a slot that any later process may be handed, a
 * process-group id IS the PID of the process that created it, and only the
 * process-start identity distinguishes the process at that PID from its
 * predecessor. A report that carries all three is a claim; the parent's fresh
 * read is what makes it a fact.
 */
export interface StartupIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startIdentity: string;
}

/** Which startup frame a report is, and therefore which phase it can answer. */
export type StartupReportKind = "identity" | "admitted";

export interface StartupReport {
  readonly kind: StartupReportKind;
  readonly identity: StartupIdentity;
}

/**
 * Render a startup report. The parent and the prologue must agree on this to the
 * byte, and the prologue builds the same three fields out of `/proc/$$/stat`, so
 * this is the single definition of the wire format.
 */
export function formatStartupReport(kind: StartupReportKind, identity: StartupIdentity): string {
  const marker = kind === "identity" ? STARTUP_IDENTITY_REPORT : ADMISSION_CONFIRMATION;
  return `${marker} ${identity.pid} ${identity.processGroupId} ${identity.startIdentity}`;
}

/**
 * Parse one startup report, or `null` when it is not one.
 *
 * Strict on purpose. The parser is the boundary between a Poiesis-owned shell
 * and a parent that is about to act on what it says, so a line with a missing
 * field, a non-numeric PID, a nonsense group id, or an unbounded identity token
 * is not "mostly a report" — it is not a report, and anything else would be
 * parsing around a child that is not speaking the protocol.
 */
export function parseStartupReport(line: string): StartupReport | null {
  const match = /^([IA]) ([0-9]{1,10}) ([0-9]{1,10}) ([0-9]{1,64})$/.exec(line.trim());
  if (match === null) return null;
  const marker = match[1];
  const pidToken = match[2];
  const groupToken = match[3];
  const startIdentity = match[4];
  if (marker === undefined || pidToken === undefined || groupToken === undefined || startIdentity === undefined) {
    return null;
  }
  const pid = Number(pidToken);
  const processGroupId = Number(groupToken);
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) return null;
  return {
    kind: marker === STARTUP_IDENTITY_REPORT ? "identity" : "admitted",
    identity: { pid, processGroupId, startIdentity },
  };
}

/**
 * Spec #168 / ticket #182 — mint the two gate tokens for one run.
 *
 * They are independent random values and are never equal: "the second phase uses
 * a different token" has to be a property of what is minted, not a claim about
 * how likely a collision is.
 */
export function mintStartupTokens(): { admissionToken: string; executionToken: string } {
  const admissionToken = randomBytes(24).toString("hex");
  let executionToken = randomBytes(24).toString("hex");
  while (executionToken === admissionToken) {
    executionToken = randomBytes(24).toString("hex");
  }
  return { admissionToken, executionToken };
}

/**
 * Spec #168 / ticket #182 — encode the caller's argv for the release channel.
 *
 * Each element becomes one newline-free octal-escaped frame, preceded by the
 * element count, so the shell's line reader reproduces the argv exactly and the
 * prologue can consume precisely the frames the parent sent. `printf %b` is a
 * POSIX `sh` regular built-in, so the decoder exists wherever the processor
 * does. A byte an `execve` argument could never carry (NUL) cannot be expressed
 * in an argument either, so it is encoded like any other byte rather than
 * special-cased.
 */
export function encodeReleasePayload(argv: readonly string[]): string {
  const frames = argv.map(encodeReleaseFrame);
  return `${frames.length}\n${frames.join("\n")}\n`;
}

function encodeReleaseFrame(value: string): string {
  let frame = "";
  for (const byte of Buffer.from(value, "utf8")) {
    frame += `\\0${byte.toString(8).padStart(3, "0")}`;
  }
  return frame;
}

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
 *
 * Spec #168 / ticket #177: on the strong model the verdict is EARNED, not
 * inferred. Where a hierarchy exists, the report still has to be able to create
 * a leaf under it and find `cgroup.kill`, `cgroup.procs`, and `cgroup.events`
 * there, and it proves exactly that on a transient probe leaf it removes again
 * (see {@link probeProvisionable}). A readable `cgroup.controllers`, a resolvable
 * path, and a directory are necessary but not sufficient, and reporting
 * `available: true` without them would send every managed run on this host into
 * a pre-spawn refusal it was told would succeed — or, worse, into a run that
 * discovers the boundary cannot be provisioned only after a process exists.
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
  // Spec #168 / ticket #177: a readable hierarchy is not a usable one. The
  // prerequisites that actually decide whether a managed run can be contained
  // are the ones real provisioning performs — creating a leaf under the
  // delegated parent and finding `cgroup.kill`, `cgroup.procs`, and
  // `cgroup.events` in it — so the report PERFORMS them on a throwaway probe
  // instead of asserting them from the shape of the hierarchy. A parent that
  // cannot be written, or a kernel that exposes no atomic `cgroup.kill`, is
  // reported unavailable here, before any process is spawned.
  return probeProvisionable(model, parent);
}

/**
 * Spec #168 / ticket #177 — the controls a managed leaf MUST expose.
 *
 * `cgroup.kill` is the atomic primitive cleanup depends on; without it, cleanup
 * could only enumerate and signal members, which a fork between read and signal
 * defeats. `cgroup.procs` is what admission confirms itself against, and
 * `cgroup.events` is the authoritative emptiness fact settlement refuses to
 * trade for anything weaker.
 */
const REQUIRED_LEAF_CONTROLS = ["cgroup.kill", "cgroup.procs", "cgroup.events"] as const;

/**
 * Spec #168 / ticket #177 — prove the provisioning prerequisites by doing them
 * once, on a leaf that is removed again before this returns.
 *
 * Properties this deliberately has:
 *
 *   - FAITHFUL. It performs exactly what `provisionContainment` performs:
 *     `mkdir` a leaf under the delegated parent, then require the three
 *     controls. Nothing about the project, its files, or its state is read or
 *     written, and nothing durable is created: the probe lives only in the
 *     kernel's own cgroup tree and is `rmdir`'d in a `finally`, so even the
 *     refusal path leaves no residue.
 *   - BOUNDED. Every step is one synchronous local syscall — no polling, no
 *     interval timer, no subprocess, no network — so the probe cannot itself
 *     become an unbounded wait.
 *   - RACE-SAFE. The probe leaf name carries this process's PID and a monotonic
 *     counter, so two concurrent probes never collide on one directory and a
 *     probe can never address, read, or remove another one's leaf. `mkdir`
 *     itself is the atomic test: an existing name would be `EEXIST`, never a
 *     silently shared directory.
 *
 * Real provisioning STILL revalidates every one of these facts for the leaf it
 * actually provisions. The probe answers "can this host do it at all", never
 * "this particular leaf is good", so the report can be a few microseconds stale
 * without ever becoming a promise.
 */
function probeProvisionable(model: ContainmentModel, parent: string): ContainmentCapability {
  leafCounter += 1;
  const probe = join(parent, leafName("capability-probe"));
  try {
    mkdirSync(probe, { mode: 0o700 });
  } catch (error) {
    return unavailable(
      model,
      "PROVISION_FAILED",
      `A managed cgroup leaf could not be created under the delegated subtree at ${parent} (${
        (error as NodeJS.ErrnoException).code ?? "unknown"
      }), so this runtime cannot provision strong containment here.`,
      parent,
    );
  }
  try {
    for (const required of REQUIRED_LEAF_CONTROLS) {
      if (existsSync(join(probe, required))) continue;
      return unavailable(
        model,
        "NO_CGROUP_KILL",
        `A leaf created under the delegated subtree at ${parent} exposes no ${required}, so managed leaves there can neither be confirmed nor settled.`,
        parent,
      );
    }
    return available(
      model,
      `A delegated cgroup v2 subtree is available at ${parent}; managed leaves can be created, entered, killed, and confirmed empty there.`,
      parent,
    );
  } finally {
    try {
      rmdirSync(probe);
    } catch {
      // The probe is empty by construction, so this can only mean the kernel
      // already reclaimed it. Never let cleanup change the reported verdict.
    }
  }
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

  // Spec #168 / ticket #177: the capability report now PROVES these
  // prerequisites on a throwaway probe leaf rather than asserting them, but the
  // probe answers only "can this host do it at all". The leaf this run actually
  // provisions is revalidated here, control by control, so a report that is even
  // a few microseconds stale can never become a promise about it.
  for (const required of REQUIRED_LEAF_CONTROLS) {
    if (existsSync(join(leaf, required))) continue;
    // Spec #168 / ticket #178: the typed refusal is the outcome, so the cleanup
    // of the leaf it leaves behind can never replace it. `rmdir` is asked for
    // on a directory the kernel itself refused to expose controls for, which is
    // exactly the state where it can answer `EACCES` or `EBUSY`; raising that
    // raw errno would replace an actionable "this host cannot provide
    // containment" with an opaque filesystem failure that names neither the
    // missing control nor the host requirement. Cleanup stays best effort, and
    // the leaf it could not remove is named in the refusal's bounded detail so
    // the operator can see it.
    let cleanupError: string | null = null;
    try {
      rmdirSync(leaf);
    } catch (error) {
      cleanupError = (error as NodeJS.ErrnoException).code ?? "unknown";
    }
    const unusable = unavailable(
      input.model,
      "NO_CGROUP_KILL",
      `The managed cgroup leaf ${leaf} exposes no ${required}.`,
      capability.parent,
    );
    throw containmentUnavailableError(
      {
        ...unusable,
        detail:
          cleanupError === null
            ? unusable.detail
            : `${unusable.detail} The unusable leaf ${leaf} could not be removed (${cleanupError}); remove it before re-running.`,
      },
      input.remediation,
    );
  }

  return { model: input.model, operationId: input.operationId, leaf };
}

/**
 * Spec #168 / ticket #182 — the parent's side of the FIRST phase: the startup
 * identity report. It has exactly one outcome — refusal.
 *
 * Nothing may be leased, admitted, released, or signalled until this returns.
 * That is the whole point of splitting the barrier in two: a report is a child's
 * claim about itself, and a claim is only worth acting on when it agrees with
 * the two things the parent can check independently — the PID `spawn` returned,
 * and a fresh kernel read of that PID's process-group id and process-start
 * identity. A report that names another PID, an earlier process at that PID, a
 * group the kernel does not agree with, or a process that is already gone is not
 * a report this run may act on.
 *
 * @throws `PROCESS_CONTAINMENT_REFUSED` — always, unless the identity is proven.
 */
export function requireValidatedStartupIdentity(
  lease: ManagedContainmentLease,
  input: {
    pid: number;
    /** The parsed report, or `null` when none was received. */
    reported: StartupIdentity | null;
    /** The parent's own kernel read of `pid`, or `null` when unreadable. */
    fresh: StartupIdentity | null;
    /** What the gate itself observed, when it observed nothing usable. */
    detail: string;
  },
): void {
  const problems: string[] = [];
  if (input.reported === null) {
    problems.push(input.detail);
  } else {
    if (input.reported.pid !== input.pid) {
      problems.push(`the report named PID ${input.reported.pid}, not the spawned child ${input.pid}`);
    }
    if (input.fresh === null) {
      problems.push(`the kernel identity at PID ${input.pid} could not be read`);
    } else {
      if (input.reported.processGroupId !== input.fresh.processGroupId) {
        problems.push(
          `the report named process group ${input.reported.processGroupId}, not the group ${input.fresh.processGroupId} the kernel reports for PID ${input.pid}`,
        );
      }
      if (input.reported.startIdentity !== input.fresh.startIdentity) {
        problems.push(
          `the report named start identity ${input.reported.startIdentity}, not the identity ${input.fresh.startIdentity} the kernel reports for PID ${input.pid}`,
        );
      }
    }
  }
  if (problems.length === 0) return;
  throw new PoiesisError(
    "PROCESS_CONTAINMENT_REFUSED",
    `Managed command ${input.pid} reported no startup identity Poiesis could confirm against the kernel: ${problems.join("; ")}`,
    {
      containment: lease.model,
      leaf: lease.leaf,
      pid: input.pid,
      reason: "STARTUP_IDENTITY_UNCONFIRMED",
      detail: problems.join("; "),
      // The two sides of the comparison, so an operator can see which one
      // disagreed without re-running anything.
      reported: input.reported,
      fresh: input.fresh,
      confirmed: false,
    },
  );
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
 * Spec #168 / ticket #182: a confirmation is also only about a process when it
 * is bound to the identity this run leased. An admitted report naming a
 * different identity is a claim by something else, so it is refused here rather
 * than accepted as "something in the leaf confirmed a membership".
 *
 * @throws `PROCESS_CONTAINMENT_REFUSED` — always, unless admission confirmed.
 */
export function requireConfirmedAdmission(
  lease: ManagedContainmentLease,
  input: {
    confirmed: boolean;
    pid: number;
    detail: string;
    /** The admitted report's identity, when one arrived. */
    identity?: StartupIdentity | null;
    /** The identity this run leased in the first phase. */
    expected?: StartupIdentity | null;
  },
): void {
  const problems: string[] = [];
  if (!input.confirmed) problems.push(input.detail);
  const reported = input.identity ?? null;
  const expected = input.expected ?? null;
  if (reported !== null && expected !== null) {
    if (
      reported.pid !== expected.pid ||
      reported.processGroupId !== expected.processGroupId ||
      reported.startIdentity !== expected.startIdentity
    ) {
      problems.push(
        `the admission was confirmed for PID ${reported.pid} in group ${reported.processGroupId} with start identity ${reported.startIdentity}, not the leased identity of PID ${expected.pid} in group ${expected.processGroupId} with start identity ${expected.startIdentity}`,
      );
    }
  } else if (reported === null && expected !== null) {
    problems.push("the admitted report carried no identity to bind the confirmation to");
  }
  if (problems.length === 0) return;
  throw new PoiesisError(
    "PROCESS_CONTAINMENT_REFUSED",
    `Managed command ${input.pid} was never admitted under an identity Poiesis confirmed: ${problems.join("; ")}`,
    {
      containment: lease.model,
      leaf: lease.leaf,
      pid: input.pid,
      reason: "ADMISSION_UNCONFIRMED",
      detail: problems.join("; "),
      admittedIdentity: reported,
      leasedIdentity: expected,
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
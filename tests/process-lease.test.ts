/**
 * Spec #168 / ticket #180 — the managed process group has no member inventory.
 *
 * A managed subprocess is only ever identified by the lease the runner created
 * for it: operation id, workspace id, PID, process-group id, and the kernel
 * process-start identity captured at spawn. These tests pin the fail-closed
 * boundary around that lease, and the ONE cleanup authority it can have:
 *
 *   - a well-formed lease for a real detached child carries every field and
 *     names an ISOLATED process group (never Poiesis's own group);
 *   - a malformed lease is rejected before any signal is considered;
 *   - an unsafe target (init's group, Poiesis's own group, Poiesis itself), a
 *     reused PID, a foreign group, an unreadable identity, and a missing
 *     identity are all refused;
 *   - settlement NEVER enumerates the group's members and never signals an
 *     individual one. The group is addressed as a group, and only while the
 *     leased leader has been freshly identity-confirmed — its exact start
 *     identity and its exact process-group id, read immediately before each
 *     signal;
 *   - group LIVENESS proves absence and nothing else, so a group that is still
 *     there after the leader stopped being confirmable is reported unresolved
 *     (GROUP_AUTHORITY_LOST) with NO further signal, never killed on the
 *     strength of a group that merely exists;
 *   - success is confirmed by exactly one thing: the group no longer exists.
 *     The settlement reports `membersEnumerated: false` and no PID arrays,
 *     because Poiesis reads no member list it could honestly report;
 *   - a zombie is terminal — never a live target, never signalled;
 *   - a POSIX platform that cannot confirm a process-start identity cannot
 *     settle a LIVE group at all, so it fails closed instead of signalling a
 *     group whose ownership it cannot prove.
 *
 * Everything here observes real processes through the real kernel surface
 * (per-PID `/proc/<pid>/stat`, kill(2)); no signal is intercepted except where
 * a case is unreachable on a real host — an unreadable identity, a reused PID,
 * or a leader that changes state between two signals — which is produced by
 * denying or doctoring that one per-PID read while leaving every other process
 * and every signal real.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createManagedProcessLease,
  settleManagedProcessLease,
  validateManagedProcessLease,
  type ManagedProcessLease,
} from "../src/process-tree.js";

const fixtures: string[] = [];
const spawned: ChildProcess[] = [];
const tracked: Array<{ pid: number; startIdentity: string | null }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of spawned) {
    child.removeAllListeners();
    try {
      if (child.pid !== undefined && isSignalAlive(child.pid)) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already terminated.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Already terminated.
    }
  }
  spawned.length = 0;
  for (const { pid, startIdentity } of tracked) {
    try {
      if (startIdentity === null || startTimeOf(pid) === startIdentity) process.kill(pid, "SIGKILL");
    } catch {
      // Already terminated.
    }
  }
  tracked.length = 0;
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
  vi.doUnmock("node:fs");
  vi.resetModules();
});

function isLinux(): boolean {
  return process.platform === "linux";
}

function statFields(pid: number | "self"): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

function ownProcessGroupId(): number {
  const fields = statFields("self");
  if (fields === null) throw new Error("this test requires /proc");
  return Number(fields[2]);
}

function startTimeOf(pid: number): string | null {
  return statFields(pid)?.[19] ?? null;
}

function isSignalAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

async function stageScript(content: string): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-lease-"));
  fixtures.push(dir);
  const script = join(dir, "case.sh");
  await writeFile(script, content, "utf8");
  await chmod(script, 0o755);
  return { dir, script };
}

/**
 * Spawn a detached child (exactly how `run()` isolates a managed subprocess: its
 * own session/process group) that keeps running until it is signalled, and
 * return the live lease for it.
 */
async function spawnManagedChild(
  script: string,
  identity: { operationId: string; workspaceId: string },
): Promise<{ child: ChildProcess; lease: ManagedProcessLease }> {
  const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
  spawned.push(child);
  child.unref();
  expect(child.pid).toBeGreaterThan(0);
  const lease = createManagedProcessLease({ ...identity, pid: child.pid! });
  tracked.push({ pid: child.pid!, startIdentity: lease.startIdentity });
  return { child, lease };
}

/** A lease for another process inside `group`'s process group. */
function createLeaseFor(pid: number, group: ManagedProcessLease): ManagedProcessLease {
  const fields = statFields(pid);
  if (fields === null) throw new Error(`cannot read the identity of ${pid}`);
  return {
    schema: 1,
    operationId: group.operationId,
    workspaceId: group.workspaceId,
    pid,
    processGroupId: group.processGroupId,
    startIdentity: fields[19] ?? null,
  };
}

/** One signal Poiesis actually delivered, as the kernel saw it. */
interface DeliveredSignal {
  readonly pid: number;
  readonly signal: NodeJS.Signals;
}

/**
 * Wait until the lease can no longer see a live leader at `lease.pid`.
 *
 * The spawned child is unreferenced, so its own `exit` event is not a fact this
 * suite can rely on; the kernel's answer is. A leader that is `gone` or already
 * `terminal` satisfies this, because either way the process Poiesis leased has
 * finished and no signal may be derived from its PID.
 */
async function waitForLeaseGone(lease: ManagedProcessLease, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const validation = validateManagedProcessLease(lease);
    if (validation.accepted && validation.state === "gone") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`leased leader ${lease.pid} was still live after ${timeoutMs}ms`);
}

/**
 * Record every signal `process.kill` delivers, and run `body` with the real
 * deliverer in place, so a test can assert on what was sent (and prove that
 * nothing was) rather than only on how the settlement ended.
 */
async function recordingSignals<T>(body: () => Promise<T>): Promise<{ outcome: T | Promise<T>; signals: DeliveredSignal[] }> {
  const deliver = process.kill.bind(process);
  const signals: DeliveredSignal[] = [];
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    // `0` is the liveness probe; anything else — including the signal NAMES
    // production sends — is a real signal and has to be delivered.
    if (signal !== 0) {
      signals.push({ pid, signal: signal as NodeJS.Signals });
      return deliver(pid, signal as NodeJS.Signals);
    }
    return deliver(pid, 0);
  }) as typeof process.kill);
  const outcome = body();
  return { outcome, signals };
}

/**
 * The leader states that are unreachable on a healthy host at the exact moment
 * settlement needs them: an unreadable identity, a PID reused by another
 * process, a process that left the leased group, and a terminated task still
 * holding its PID. Each is produced by altering ONE per-PID read and nothing
 * else — the processes, the group, and every signal stay real.
 */
type LeaderState = "unreadable" | "reused" | "foreign" | "terminal";

interface SettleObservation {
  readonly error: unknown;
  readonly signals: DeliveredSignal[];
}

/**
 * Settle `lease` through a fresh module instance whose leader read is switched
 * to `state` at the first observable event named by `flipOn`:
 *
 *   - `group-probe`: the group's own liveness probe, i.e. the first moment the
 *     settlement has learned the group exists but has signalled nothing yet;
 *   - `group-sigterm`: the delivery of the graceful group signal, i.e. after the
 *     leader was freshly confirmed and after the group was signalled.
 *
 * Flipping on a real kernel event rather than on a read count keeps the case
 * meaningful: it is the same moment in the algorithm either way, and it does not
 * depend on how many times the implementation happens to read the leader.
 *
 * `groupAliveProbes` scripts how many group liveness probes answer "exists"
 * before the group answers "gone" — the shape of a group that empties itself,
 * such as one whose only remaining members have exited and are being reaped. It
 * exists so a case can decide what it is testing: with the group gone there is
 * nothing left to survive, so only the LEADER's state can decide the verdict.
 */
async function settleWithLeaderState(
  lease: ManagedProcessLease,
  flipOn: "group-probe" | "group-sigterm",
  state: LeaderState,
  options: { graceMs?: number; confirmMs?: number; groupAliveProbes?: number } = {},
): Promise<SettleObservation> {
  const flipped = { active: false };
  const signals: DeliveredSignal[] = [];
  let groupProbes = 0;
  const deliver = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    const isGroupProbe = pid < 0 && signal === 0;
    const isGroupSigterm = pid < 0 && signal === "SIGTERM";
    if (signal !== 0) {
      signals.push({ pid, signal: signal as NodeJS.Signals });
      const delivered = deliver(pid, signal as NodeJS.Signals);
      if (flipOn === "group-sigterm" && isGroupSigterm) flipped.active = true;
      return delivered;
    }
    if (flipOn === "group-probe" && isGroupProbe) flipped.active = true;
    if (isGroupProbe) {
      groupProbes += 1;
      if (options.groupAliveProbes !== undefined && groupProbes > options.groupAliveProbes) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
    }
    return deliver(pid, 0);
  }) as typeof process.kill);

  const leaderStat = `/proc/${lease.pid}/stat`;
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      readFileSync: ((path: string, ...rest: unknown[]) => {
        const honest = Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
        if (path !== leaderStat || !flipped.active) return honest;
        if (state === "unreadable") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return doctorLeaderStat(honest, state);
      }),
    };
  });

  try {
    const tree = await vi.importActual<typeof import("../src/process-tree.js")>("../src/process-tree.js");
    let error: unknown = null;
    try {
      await tree.settleManagedProcessLease(lease, options);
    } catch (thrown) {
      error = thrown;
    }
    return { error, signals };
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
}

/**
 * Rewrite one field of a `/proc/<pid>/stat` line, leaving every other field
 * honest: `state` is field 3, `pgrp` is field 5, `starttime` is field 22.
 */
function doctorLeaderStat(stat: string, state: Exclude<LeaderState, "unreadable">): string {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (state === "terminal") fields[0] = "Z";
  if (state === "reused") fields[19] = String(Number(fields[19]) + 977);
  if (state === "foreign") fields[2] = String(Number(fields[2]) + 500_000);
  return `${stat.slice(0, stat.lastIndexOf(")") + 1)} ${fields.join(" ")}`;
}

/**
 * Import a fresh instance of the production modules while the runtime reports a
 * different platform. Used to exercise the non-Linux POSIX identity model on a
 * Linux host: the module reads `process.platform` once at load time, so a
 * re-import under a redefined platform is the only way to reach those branches.
 */
async function importAsPlatform<T extends object>(platform: string, modules: string): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.resetModules();
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  try {
    return await vi.importActual<T>(modules);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.resetModules();
  }
}

/**
 * A leader that stays alive, stays in its group, and stays identity-confirmed
 * for the whole settlement, with one descendant that ignores SIGTERM. This is
 * the only shape in which the forced phase is reachable: a leader that exits on
 * the graceful signal takes the group's authority with it.
 */
async function stageLeaderValidTree(): Promise<{
  leader: string;
  descendant: string;
  pidFile: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-lease-tree-"));
  fixtures.push(dir);
  const descendant = join(dir, "descendant.sh");
  const leader = join(dir, "leader.sh");
  const pidFile = join(dir, "descendant.pid");
  await writeFile(
    descendant,
    ["#!/bin/sh", "trap '' TERM", "exec 0</dev/null 1>/dev/null 2>/dev/null", 'printf "%s\\n" "$$" > "$1"', "while :; do sleep 1; done", ""].join(
      "\n",
    ),
    "utf8",
  );
  await chmod(descendant, 0o755);
  await writeFile(
    leader,
    ["#!/bin/sh", "trap '' TERM", "exec 0</dev/null 1>/dev/null 2>/dev/null", `"${descendant}" "${pidFile}" &`, "while :; do sleep 1; done", ""].join(
      "\n",
    ),
    "utf8",
  );
  await chmod(leader, 0o755);
  return { leader, descendant, pidFile };
}

/**
 * A leader that leaves at once and a descendant whose own body decides how long
 * the group outlives it. The group is therefore observably alive for a while
 * after the leader that gave it its id has been reaped — the shape a command
 * leaves behind when a background writer closes its inherited output late.
 */
async function stageLeaderExitsTree(descendantBody: readonly string[]): Promise<{
  leader: string;
  descendant: string;
  pidFile: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-lease-natural-"));
  fixtures.push(dir);
  const descendant = join(dir, "descendant.sh");
  const leader = join(dir, "leader.sh");
  const pidFile = join(dir, "descendant.pid");
  await writeFile(descendant, ["#!/bin/sh", 'printf "%s\\n" "$$" > "$1"', ...descendantBody, ""].join("\n"), "utf8");
  await chmod(descendant, 0o755);
  await writeFile(leader, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nexit 0\n`, "utf8");
  await chmod(leader, 0o755);
  return { leader, descendant, pidFile };
}

/**
 * A descendant that replaces itself with a TERM-resistant process when the
 * graceful group signal arrives, plus a leader that keeps the group's authority
 * alive throughout.
 *
 * The descendant is a real Node process rather than a shell script on purpose:
 * a shell only runs a `trap ... TERM` handler between foreground commands, so on
 * a host whose `/bin/sh` is bash a TERM delivered to the whole group while the
 * script sits in `while :; do sleep 1; done` never runs the handler at all. A
 * signal handler is the property under test, so the process implementing it must
 * actually have one.
 */
async function stageTermHandlerReplacement(): Promise<{
  leader: string;
  descendantPidFile: string;
  replacementPidFile: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-lease-replace-"));
  fixtures.push(dir);
  const replacement = join(dir, "replacement.cjs");
  const descendant = join(dir, "descendant.cjs");
  const leader = join(dir, "leader.sh");
  const descendantPidFile = join(dir, "descendant.pid");
  const replacementPidFile = join(dir, "replacement.pid");
  await writeFile(
    replacement,
    [
      'const { writeFileSync } = require("node:fs");',
      'writeFileSync(process.argv[2], `${process.pid}\\n`);',
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    descendant,
    [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const [replacement, replacementPidFile, ownPidFile] = process.argv.slice(2);",
      "writeFileSync(ownPidFile, `${process.pid}\\n`);",
      "process.on('SIGTERM', () => {",
      "  const forked = spawn(process.execPath, [replacement, replacementPidFile], { stdio: 'ignore' });",
      "  forked.unref();",
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    leader,
    [
      "#!/bin/sh",
      "trap '' TERM",
      "exec 0</dev/null 1>/dev/null 2>/dev/null",
      `"${process.execPath}" "${descendant}" "${replacement}" "${replacementPidFile}" "${descendantPidFile}" &`,
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(leader, 0o755);
  return { leader, descendantPidFile, replacementPidFile };
}

async function waitForPid(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The descendant has not published its PID yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`descendant did not publish a valid PID at ${path}`);
}

/**
 * The direct children of `pid`, read from that process's OWN `children` list.
 * A zombie is looked up through its parent rather than by walking the process
 * table: the lifecycle never enumerates processes, and neither does its suite.
 */
function childPidsOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .split(/\s+/)
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => Number(entry));
  } catch {
    return [];
  }
}

/** Find a zombie whose parent is `parentPid`: a terminated task that still holds its PID. */
async function waitForUnreapedZombie(parentPid: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const childPid of childPidsOf(parentPid)) {
      if (statFields(childPid)?.[0] === "Z") return childPid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no unreaped zombie appeared under parent ${parentPid}`);
}

describe("managed process lease creation", () => {
  it("carries operation, workspace, pid, process-group and start identity for a detached child", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-1",
      workspaceId: "workspace-1",
    });
    expect(lease).toMatchObject({
      schema: 1,
      operationId: "operation-1",
      workspaceId: "workspace-1",
      pid: child.pid,
      processGroupId: child.pid,
    });
    if (isLinux()) expect(lease.startIdentity).toBe(startTimeOf(child.pid!));
  });

  it.skipIf(!isLinux())("names an isolated process group, never the Poiesis group", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-2",
      workspaceId: "workspace-2",
    });
    expect(lease.processGroupId).not.toBe(ownProcessGroupId());
    // The leased group exists as a real, separately addressable group.
    expect(isSignalAlive(lease.pid)).toBe(true);
    expect(() => process.kill(-lease.processGroupId, 0)).not.toThrow();
  });

  it("keeps the lease transient: no identity is written outside the returned object", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { lease } = await spawnManagedChild(script, {
      operationId: "operation-3",
      workspaceId: "workspace-3",
    });
    // The lease is a plain in-memory value: structured-cloneable, JSON
    // round-trippable, and carrying no process handle or runtime object.
    expect(JSON.parse(JSON.stringify(lease))).toEqual({ ...lease });
    expect(
      Object.values(lease).every((value) => typeof value === "number" || typeof value === "string" || value === null),
    ).toBe(true);
  });
});

describe("managed process lease rejection (fail closed)", () => {
  const malformed: Array<[string, unknown]> = [
    ["a non-object value", "not-a-lease"],
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["an unknown schema version", { schema: 2 }],
    ["a missing operation id", { schema: 1, workspaceId: "w", pid: 10, processGroupId: 10, startIdentity: "5" }],
    ["a blank operation id", { schema: 1, operationId: "  ", workspaceId: "w", pid: 10, processGroupId: 10, startIdentity: "5" }],
    ["a blank workspace id", { schema: 1, operationId: "o", workspaceId: "", pid: 10, processGroupId: 10, startIdentity: "5" }],
    ["a zero pid", { schema: 1, operationId: "o", workspaceId: "w", pid: 0, processGroupId: 10, startIdentity: "5" }],
    ["a negative pid", { schema: 1, operationId: "o", workspaceId: "w", pid: -3, processGroupId: 10, startIdentity: "5" }],
    ["a fractional pid", { schema: 1, operationId: "o", workspaceId: "w", pid: 1.5, processGroupId: 10, startIdentity: "5" }],
    ["a non-numeric process group id", { schema: 1, operationId: "o", workspaceId: "w", pid: 10, processGroupId: "10", startIdentity: "5" }],
    ["a non-numeric start identity", { schema: 1, operationId: "o", workspaceId: "w", pid: 10, processGroupId: 10, startIdentity: "5x" }],
    ["a negative process group id", { schema: 1, operationId: "o", workspaceId: "w", pid: 10, processGroupId: -10, startIdentity: "5" }],
  ];

  for (const [label, value] of malformed) {
    it(`rejects ${label} as MALFORMED_LEASE without throwing`, () => {
      const validation = validateManagedProcessLease(value);
      expect(validation).toMatchObject({ accepted: false, reason: "MALFORMED_LEASE" });
    });
  }

  it.skipIf(!isLinux())("rejects init's process group as an unsafe target", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-4",
      workspaceId: "workspace-4",
    });
    // Process group 1 holds every process that never joined a group of
    // its own; signalling it would reach processes Poiesis never spawned.
    expect(validateManagedProcessLease({ ...lease, processGroupId: 1 })).toMatchObject({
      accepted: false,
      reason: "UNSAFE_TARGET",
    });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("rejects the Poiesis process group as an unsafe target", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-5",
      workspaceId: "workspace-5",
    });
    expect(validateManagedProcessLease({ ...lease, processGroupId: ownProcessGroupId() })).toMatchObject({
      accepted: false,
      reason: "UNSAFE_TARGET",
    });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("rejects Poiesis itself as an unsafe target", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-6",
      workspaceId: "workspace-6",
    });
    const self = statFields("self")!;
    const validation = validateManagedProcessLease({
      schema: 1,
      operationId: "operation-6",
      workspaceId: "workspace-6",
      pid: process.pid,
      processGroupId: process.pid,
      startIdentity: self[19]!,
    });
    expect(validation).toMatchObject({ accepted: false, reason: "UNSAFE_TARGET" });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("rejects a reused pid whose process-start identity no longer matches", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-7",
      workspaceId: "workspace-7",
    });
    expect(lease.startIdentity).not.toBeNull();
    const validation = validateManagedProcessLease({
      ...lease,
      startIdentity: String(Number(lease.startIdentity) + 7),
    });
    expect(validation).toMatchObject({ accepted: false, reason: "PID_REUSE" });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("rejects a missing start identity when this runtime can confirm one", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-8",
      workspaceId: "workspace-8",
    });
    expect(validateManagedProcessLease({ ...lease, startIdentity: null })).toMatchObject({
      accepted: false,
      reason: "UNSUPPORTED_IDENTITY",
    });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("rejects a live process that does not belong to the leased process group", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-9",
      workspaceId: "workspace-9",
    });
    // Same live process, correctly identified, but the lease claims a
    // group it was never observed in: the lease is foreign to the target.
    const validation = validateManagedProcessLease({ ...lease, processGroupId: lease.pid + 1_000_000 });
    expect(validation).toMatchObject({ accepted: false, reason: "FOREIGN_PROCESS" });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("accepts a live, isolated, identity-confirmed lease", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-10",
      workspaceId: "workspace-10",
    });
    expect(validateManagedProcessLease(lease)).toMatchObject({
      accepted: true,
      state: "live",
      verified: true,
    });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("treats a lease whose process already exited as settled", async () => {
    const { script } = await stageScript("#!/bin/sh\nexit 0\n");
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const lease = createManagedProcessLease({
      operationId: "operation-11",
      workspaceId: "workspace-11",
      pid: child.pid!,
    });
    expect(validateManagedProcessLease(lease)).toMatchObject({ accepted: true, state: "gone" });
  });

  it.skipIf(!isLinux())("rejects a live process whose identity the runtime cannot read", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: ((path: string, ...rest: unknown[]) => {
          if (typeof path === "string" && /^\/proc\/\d+\/stat$/.test(path)) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
        }) as typeof actual.readFileSync,
      };
    });

    try {
      const tree = await vi.importActual<typeof import("../src/process-tree.js")>("../src/process-tree.js");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: tmpdir(),
        detached: true,
        stdio: "ignore",
      });
      spawned.push(child);
      child.unref();
      const lease: ManagedProcessLease = {
        schema: 1,
        operationId: "operation-12",
        workspaceId: "workspace-12",
        pid: child.pid!,
        processGroupId: child.pid!,
        startIdentity: "1",
      };
      // The process is alive by signal(0) but its identity is unreadable:
      // Poiesis cannot prove the target is the process it leased, so it
      // must refuse rather than signal on ambiguity.
      expect(tree.validateManagedProcessLease(lease)).toMatchObject({
        accepted: false,
        reason: "IDENTITY_AMBIGUOUS",
      });
      expect(isSignalAlive(child.pid!)).toBe(true);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("managed process group settlement", () => {
  it.skipIf(!isLinux())(
    "confirms a group it emptied while the leader stayed freshly confirmed",
    { timeout: 20_000 },
    async () => {
      const { leader, pidFile } = await stageLeaderValidTree();
      const { lease } = await spawnManagedChild(leader, {
        operationId: "operation-settle",
        workspaceId: "workspace-settle",
      });
      const descendantPid = await waitForPid(pidFile);
      tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });

      const startedAt = Date.now();
      const { outcome, signals } = await recordingSignals(() => settleManagedProcessLease(lease));
      const settlement = await outcome;
      const elapsed = Date.now() - startedAt;
      expect(settlement).toMatchObject({
        operationId: "operation-settle",
        workspaceId: "workspace-settle",
        processGroupId: lease.processGroupId,
        confirmed: true,
        // No member list is read, so none is reported.
        membersEnumerated: false,
      });
      // Only the group was ever addressed, and only in both phases.
      expect(signals).toEqual([
        { pid: -lease.processGroupId, signal: "SIGTERM" },
        { pid: -lease.processGroupId, signal: "SIGKILL" },
      ]);
      // The TERM-resistant descendant could only be removed by the forced
      // escalation, so settlement cannot have completed before the grace
      // window elapsed.
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(isSignalAlive(descendantPid)).toBe(false);
      // Confirmed on exactly one fact: the group no longer exists.
      expect(() => process.kill(-lease.processGroupId, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    },
  );

  it.skipIf(!isLinux())(
    "kills a TERM-handler replacement while the leader is still freshly confirmed",
    { timeout: 20_000 },
    async () => {
      // The descendant replaces itself with a TERM-resistant process when the
      // graceful group signal arrives. The replacement is in the leased group
      // and the leader is still the confirmed owner of that group, so the
      // forced phase reaches it — which is the only shape in which it is
      // reachable at all.
      const { leader, descendantPidFile, replacementPidFile } = await stageTermHandlerReplacement();
      const { lease } = await spawnManagedChild(leader, {
        operationId: "operation-replacement",
        workspaceId: "workspace-replacement",
      });
      const descendantPid = await waitForPid(descendantPidFile);
      const descendantStart = startTimeOf(descendantPid);
      tracked.push({ pid: descendantPid, startIdentity: descendantStart });

      const { outcome, signals } = await recordingSignals(() => settleManagedProcessLease(lease));
      const settlement = await outcome;
      // The replacement only exists once the graceful signal has been handled,
      // so it is read after the group has already been asked to terminate.
      const replacementPid = await waitForPid(replacementPidFile, 5_000);
      const replacementStart = startTimeOf(replacementPid);
      tracked.push({ pid: replacementPid, startIdentity: replacementStart });

      expect(settlement).toMatchObject({ confirmed: true, membersEnumerated: false });
      expect(signals.filter((entry) => entry.pid !== -lease.processGroupId)).toEqual([]);
      expect(signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(isSignalAlive(descendantPid)).toBe(false);
      expect(isSignalAlive(replacementPid)).toBe(false);
    },
  );

  it.skipIf(!isLinux())("settles an already-empty group without signalling anything", async () => {
    const { script } = await stageScript("#!/bin/sh\nexit 0\n");
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const lease = createManagedProcessLease({
      operationId: "operation-gone",
      workspaceId: "workspace-gone",
      pid: child.pid!,
    });

    const { outcome, signals } = await recordingSignals(() => settleManagedProcessLease(lease));
    const settlement = await outcome;
    expect(settlement).toMatchObject({
      confirmed: true,
      processGroupId: lease.processGroupId,
      membersEnumerated: false,
    });
    // Nothing to terminate means nothing was terminated: the settlement carries
    // no PID arrays at all, so it cannot report a survivor or a terminator it
    // never enumerated.
    expect(Object.keys(settlement).sort()).toEqual([
      "confirmed",
      "membersEnumerated",
      "operationId",
      "processGroupId",
      "workspaceId",
    ]);
    expect(signals).toEqual([]);
  });

  it.skipIf(!isLinux())("fails closed with PROCESS_CLEANUP_REFUSED instead of signalling a rejected lease", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-refused",
      workspaceId: "workspace-refused",
    });
    const { outcome, signals } = await recordingSignals(() =>
      settleManagedProcessLease({ ...lease, startIdentity: String(Number(lease.startIdentity) + 3) }),
    );
    await expect(outcome).rejects.toMatchObject({
      code: "PROCESS_CLEANUP_REFUSED",
      details: {
        reason: "PID_REUSE",
        operationId: "operation-refused",
        workspaceId: "workspace-refused",
        pid: child.pid,
      },
    });
    // The rejected lease produced no signal at all.
    expect(signals).toEqual([]);
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("reports PROCESS_CLEANUP_UNRESOLVED when the group cannot be emptied", { timeout: 20_000 }, async () => {
    const { leader, pidFile } = await stageLeaderValidTree();
    const { lease } = await spawnManagedChild(leader, {
      operationId: "operation-unresolved",
      workspaceId: "workspace-unresolved",
    });
    const descendantPid = await waitForPid(pidFile);
    tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });

    // Every signal is swallowed and the group answers every liveness probe, so
    // neither phase can remove anything and the group outlives both.
    const deliver = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0) return pid < 0 ? true : deliver(pid, 0);
      return true;
    }) as typeof process.kill);

    // The leader is confirmed throughout, so this is not an authority failure:
    // the group simply could not be emptied, and saying so is the honest report.
    await expect(settleManagedProcessLease(lease, { graceMs: 300, confirmMs: 300 })).rejects.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: {
        operationId: "operation-unresolved",
        workspaceId: "workspace-unresolved",
        processGroupId: lease.processGroupId,
        reason: "GROUP_STILL_PRESENT",
        phase: "confirm",
        membersEnumerated: false,
        confirmed: false,
      },
    });
    expect(isSignalAlive(lease.pid)).toBe(true);
    expect(isSignalAlive(descendantPid)).toBe(true);
  });

  it.skipIf(!isLinux())(
    "rejects with GROUP_AUTHORITY_LOST and sends no SIGKILL when the leader exits during the grace window",
    { timeout: 20_000 },
    async () => {
      // The leader leaves on the graceful group signal while a TERM-resistant
      // descendant stays behind. The group is still there, so it is NOT
      // evidence of anything Poiesis owns: the leader's PID is reaped and may
      // be recycled, and a recycled leader PID can own a brand-new group.
      const dir = await mkdtemp(join(tmpdir(), "poiesis-lease-authority-"));
      fixtures.push(dir);
      const descendant = join(dir, "descendant.sh");
      const leader = join(dir, "leader.sh");
      const pidFile = join(dir, "descendant.pid");
      await writeFile(
        descendant,
        [
          "#!/bin/sh",
          "trap '' TERM",
          "exec 0</dev/null 1>/dev/null 2>/dev/null",
          'printf "%s\\n" "$$" > "$1"',
          "while :; do sleep 1; done",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(descendant, 0o755);
      await writeFile(
        leader,
        [
          "#!/bin/sh",
          "trap 'exit 0' TERM",
          "exec 0</dev/null 1>/dev/null 2>/dev/null",
          `"${descendant}" "${pidFile}" &`,
          "while :; do sleep 1; done",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(leader, 0o755);

      const { child, lease } = await spawnManagedChild(leader, {
        operationId: "operation-authority",
        workspaceId: "workspace-authority",
      });
      const descendantPid = await waitForPid(pidFile);
      const descendantStart = startTimeOf(descendantPid);
      tracked.push({ pid: descendantPid, startIdentity: descendantStart });

      const { outcome, signals } = await recordingSignals(() =>
        settleManagedProcessLease(lease, { graceMs: 1_500, confirmMs: 500 }),
      );
      await expect(outcome).rejects.toMatchObject({
        code: "PROCESS_CLEANUP_UNRESOLVED",
        details: {
          reason: "GROUP_AUTHORITY_LOST",
          phase: "before-sigkill",
          leaderState: "gone",
          processGroupId: lease.processGroupId,
          membersEnumerated: false,
          confirmed: false,
        },
      });
      // The graceful signal was delivered while the leader was confirmed; the
      // forced one was not, because by then nothing confirmed the group.
      expect(signals).toEqual([{ pid: -lease.processGroupId, signal: "SIGTERM" }]);
      expect(isSignalAlive(child.pid!)).toBe(false);
      expect(isSignalAlive(descendantPid)).toBe(true);
    },
  );

  const LEADER_STATES: Array<readonly [LeaderState, string]> = [
    ["unreadable", "unreadable"],
    ["reused", "reused"],
    ["foreign", "foreign"],
    ["terminal", "terminal"],
  ];

  for (const [state, expected] of LEADER_STATES) {
    it.skipIf(!isLinux())(
      `sends no further signal when the leader reads as ${state} before the forced phase`,
      { timeout: 20_000 },
      async () => {
        const { leader, pidFile } = await stageLeaderValidTree();
        const { child, lease } = await spawnManagedChild(leader, {
          operationId: `operation-${state}`,
          workspaceId: `workspace-${state}`,
        });
        const descendantPid = await waitForPid(pidFile);
        tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });

        const observed = await settleWithLeaderState(lease, "group-sigterm", state, {
          graceMs: 300,
          confirmMs: 300,
        });
        expect(observed.error).toMatchObject({
          code: "PROCESS_CLEANUP_UNRESOLVED",
          details: {
            reason: "GROUP_AUTHORITY_LOST",
            phase: "before-sigkill",
            leaderState: expected,
            processGroupId: lease.processGroupId,
            membersEnumerated: false,
            confirmed: false,
          },
        });
        // Exactly the graceful signal that was authorised, and nothing after.
        expect(observed.signals).toEqual([{ pid: -lease.processGroupId, signal: "SIGTERM" }]);
        // The TERM-resistant descendant is still running, which is the honest
        // cost of refusing to signal a group Poiesis can no longer own.
        expect(isSignalAlive(descendantPid)).toBe(true);
        expect(isSignalAlive(child.pid!)).toBe(true);
      },
    );

    it.skipIf(!isLinux())(
      `signals nothing at all when the leader reads as ${state} before the graceful phase`,
      { timeout: 20_000 },
      async () => {
        const { leader, pidFile } = await stageLeaderValidTree();
        const { child, lease } = await spawnManagedChild(leader, {
          operationId: `operation-pre-${state}`,
          workspaceId: `workspace-pre-${state}`,
        });
        const descendantPid = await waitForPid(pidFile);
        tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });

        const observed = await settleWithLeaderState(lease, "group-probe", state, {
          graceMs: 300,
          confirmMs: 300,
        });
        expect(observed.error).toMatchObject({
          code: "PROCESS_CLEANUP_UNRESOLVED",
          details: {
            reason: "GROUP_AUTHORITY_LOST",
            phase: "before-sigterm",
            leaderState: expected,
            processGroupId: lease.processGroupId,
            membersEnumerated: false,
            confirmed: false,
          },
        });
        // The leader's identity was confirmed when the lease was validated and
        // was gone before the signal was derived: nothing is delivered.
        expect(observed.signals).toEqual([]);
        expect(isSignalAlive(child.pid!)).toBe(true);
      },
    );
  }

  it.skipIf(!isLinux())("never treats a zombie as a live target and never signals one", { timeout: 20_000 }, async () => {
    // The leader `exec`s into `sleep 30`, which never waits on children, so the
    // backgrounded short script becomes an unreaped zombie that still holds its
    // PID. A zombie cannot run code and cannot be killed: it is terminal, so it
    // is neither a signal target nor something cleanup failed to remove.
    const { dir } = await stageScript("#!/bin/sh\nexec sleep 30\n");
    const zombieParent = join(dir, "zombie-parent.sh");
    const shortLived = join(dir, "short.sh");
    await writeFile(shortLived, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(shortLived, 0o755);
    await writeFile(zombieParent, `#!/bin/sh\n"${shortLived}" &\nexec sleep 30\n`, "utf8");
    await chmod(zombieParent, 0o755);

    const { lease } = await spawnManagedChild(zombieParent, {
      operationId: "operation-zombie",
      workspaceId: "workspace-zombie",
    });
    const zombiePid = await waitForUnreapedZombie(lease.pid);
    const zombieLease = createLeaseFor(zombiePid, lease);

    // Terminal, so the lease reads as already settled rather than as a live
    // target worth signalling.
    expect(validateManagedProcessLease(zombieLease)).toMatchObject({ accepted: true, state: "gone" });

    const { outcome, signals } = await recordingSignals(() => settleManagedProcessLease(zombieLease));
    await expect(outcome).rejects.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: {
        reason: "GROUP_AUTHORITY_LOST",
        phase: "before-sigterm",
        leaderState: "terminal",
        membersEnumerated: false,
        confirmed: false,
      },
    });
    // Not one signal: a zombie is never a target, and a group whose only
    // confirmable member is terminal is not a group Poiesis will signal.
    expect(signals).toEqual([]);
  });
});

/**
 * Spec #168 / ticket #185 — a group that outlives its leader by a moment.
 *
 * A leader that has exited — or become a zombie — does not take the group it
 * created with it. Its descendants can still be running, and even after every one
 * of them has finished their unreaped task entries keep the group observable for
 * a while. That window is a fact about REAPING, not about ownership: the group id
 * is still just a free PID the moment the leader is gone, so nothing may be
 * signalled in it, and group liveness still proves absence and nothing more.
 *
 * What may legitimately change inside that window is the settlement's VERDICT. A
 * group that empties itself is settled, and a group that outlives the bounded
 * natural-settlement window is still `PROCESS_CLEANUP_UNRESOLVED` /
 * `GROUP_AUTHORITY_LOST` with nothing signalled. The states that mean "this is
 * not the process Poiesis spawned" — reused, foreign, unreadable — are never
 * laundered into completion, however empty the group then looks.
 */
describe("natural settlement of a group whose leader is gone (ticket #185)", () => {
  it.skipIf(!isLinux())(
    "settles without a signal when a gone leader's group empties itself",
    { timeout: 20_000 },
    async () => {
      const { leader, pidFile } = await stageLeaderExitsTree(["sleep 0.3", "exit 0"]);
      const { lease } = await spawnManagedChild(leader, {
        operationId: "operation-natural",
        workspaceId: "workspace-natural",
      });
      const descendantPid = await waitForPid(pidFile);
      tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });
      // The leader is reaped before settlement starts, so its PID is now only a
      // number while its descendant is still inside the group: the group is
      // observably alive and provably unowned at the same moment.
      await waitForLeaseGone(lease);

      const { outcome, signals } = await recordingSignals(() =>
        settleManagedProcessLease(lease, { graceMs: 200, confirmMs: 3_000 }),
      );
      // The descendant finishes on its own, reaping clears the group, and the
      // settlement reports the one fact that counts: the group no longer exists.
      await expect(outcome).resolves.toMatchObject({
        operationId: "operation-natural",
        workspaceId: "workspace-natural",
        processGroupId: lease.processGroupId,
        confirmed: true,
        membersEnumerated: false,
      });
      // Not one signal: waiting for a group to empty itself is not a licence to
      // signal it, and its leader's PID was free for the whole wait.
      expect(signals).toEqual([]);
    },
  );

  it.skipIf(!isLinux())(
    "keeps GROUP_AUTHORITY_LOST when a gone leader's group outlives the natural-settlement window",
    { timeout: 20_000 },
    async () => {
      const { leader, pidFile } = await stageLeaderExitsTree([
        "trap '' TERM",
        "while :; do sleep 1; done",
      ]);
      const { lease } = await spawnManagedChild(leader, {
        operationId: "operation-survivor",
        workspaceId: "workspace-survivor",
      });
      const descendantPid = await waitForPid(pidFile);
      tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });
      await waitForLeaseGone(lease);

      const startedAt = Date.now();
      const { outcome, signals } = await recordingSignals(() =>
        settleManagedProcessLease(lease, { graceMs: 200, confirmMs: 300 }),
      );
      // A group that empties itself is settled; one that is still there when the
      // window closes is the same unresolved report as before, because nothing
      // about a survivor became provable while Poiesis waited.
      await expect(outcome).rejects.toMatchObject({
        code: "PROCESS_CLEANUP_UNRESOLVED",
        details: {
          reason: "GROUP_AUTHORITY_LOST",
          phase: "before-sigterm",
          leaderState: "gone",
          processGroupId: lease.processGroupId,
          membersEnumerated: false,
          confirmed: false,
        },
      });
      expect(signals).toEqual([]);
      expect(isSignalAlive(descendantPid)).toBe(true);
      // The wait is bounded: a survivor is reported, never waited on forever.
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    },
  );

  const NON_NATURAL_LEADER_STATES = ["unreadable", "reused", "foreign"] as const;

  for (const state of NON_NATURAL_LEADER_STATES) {
    it.skipIf(!isLinux())(
      `never reports natural completion when the leader reads as ${state}, even as the group goes away`,
      { timeout: 20_000 },
      async () => {
        const { leader, pidFile } = await stageLeaderValidTree();
        const { child, lease } = await spawnManagedChild(leader, {
          operationId: `operation-not-natural-${state}`,
          workspaceId: `workspace-not-natural-${state}`,
        });
        const descendantPid = await waitForPid(pidFile);
        tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });

        // The group answers "exists" once and then "gone", so an empty group is
        // available to launder into a success. What must decide the verdict is
        // the leader's identity, and these states are exactly the ones that
        // leave nothing to own.
        const observed = await settleWithLeaderState(lease, "group-probe", state, {
          graceMs: 300,
          confirmMs: 300,
          groupAliveProbes: 1,
        });
        expect(observed.error).toMatchObject({
          code: "PROCESS_CLEANUP_UNRESOLVED",
          details: {
            reason: "GROUP_AUTHORITY_LOST",
            phase: "before-sigterm",
            leaderState: state,
            membersEnumerated: false,
            confirmed: false,
          },
        });
        expect(observed.signals).toEqual([]);
        expect(isSignalAlive(child.pid!)).toBe(true);
      },
    );
  }
});

/**
 * Spec #168 / ticket #180 — the lifecycle has no member inventory, and the
 * source says so.
 *
 * Group cleanup used to walk `/proc`, snapshot every member, and signal them
 * one by one. That inventory is gone, and it is gone from the SOURCE: a process
 * table walk can only happen through a directory read, so the guard below fails
 * the moment one is reintroduced anywhere in the lifecycle — including in the
 * suites that watch those processes, which look them up one PID at a time.
 */
describe("managed process lifecycle never enumerates processes", () => {
  const REPO_ROOT = join(import.meta.dirname, "..");
  const LIFECYCLE_SOURCES = [
    "src/process-tree.ts",
    "src/process.ts",
    "src/containment.ts",
    "src/managed-shell.ts",
  ] as const;
  const LIFECYCLE_SUITES = [
    "tests/process-lease.test.ts",
    "tests/process-lifecycle.test.ts",
    "tests/process.test.ts",
    "tests/process-containment.test.ts",
  ] as const;

  for (const file of LIFECYCLE_SOURCES) {
    it(`${file} reads no directory, so it cannot walk a process table`, async () => {
      const source = await readFile(join(REPO_ROOT, file), "utf8");
      expect(source, `${file} re-enumerates the process table`).not.toMatch(/readdir|opendir|globSync/);
    });

    it(`${file} names no process-table root directory`, async () => {
      const source = await readFile(join(REPO_ROOT, file), "utf8");
      expect(source, `${file} names /proc as a directory`).not.toMatch(/["'`]\/proc["'`]/);
    });
  }

  for (const file of LIFECYCLE_SUITES) {
    it(`${file} finds processes one PID at a time, never by scanning /proc`, async () => {
      const source = await readFile(join(REPO_ROOT, file), "utf8");
      expect(source, `${file} scans the process table`).not.toMatch(
        /readdir(?:Sync)?\(\s*["'`]\/proc|readdirSync\(\s*"\/"/,
      );
    });
  }
});

/**
 * Spec #168 / ticket #180 — the fail-closed non-Linux POSIX contract.
 *
 * On a POSIX platform with no readable process table Poiesis cannot prove "this
 * PID is still the process I spawned", so it no longer pretends to. Group
 * liveness is not a substitute: it proves absence, never ownership, and there
 * is no lease-derived ownership proof available on such a platform at all. A
 * LIVE group therefore cannot be settled there, and the refusal is the safe
 * direction — nothing is signalled and the failure is typed. What still works is
 * the case that needs no authority: a group that is already gone.
 *
 * These run on a Linux host with `process.platform` redefined to `darwin` for a
 * fresh module import, so the real non-Linux branches execute.
 */
describe("non-Linux POSIX identity model (platform-mocked)", () => {
  it("declares process groups but no start-identity support, and no weaker model", async () => {
    const linux = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "linux",
      "../src/process-tree.js",
    );
    expect(linux.PROCESS_START_IDENTITY_SUPPORTED).toBe(true);

    const darwin = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    expect(darwin.PROCESS_GROUPS_SUPPORTED).toBe(true);
    expect(darwin.PROCESS_START_IDENTITY_SUPPORTED).toBe(false);
    // There is no group-only identity model to fall back to any more: on a
    // platform that cannot confirm a start identity, Poiesis fails closed
    // rather than signalling a group it cannot prove it owns.
    expect("PROCESS_GROUP_ONLY_IDENTITY_MODEL" in darwin).toBe(false);

    const win32 = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "win32",
      "../src/process-tree.js",
    );
    expect(win32.PROCESS_GROUPS_SUPPORTED).toBe(false);
  });

  it("refuses a live group it cannot identity-confirm, and signals nothing", async () => {
    const tree = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    child.unref();
    tracked.push({ pid: child.pid!, startIdentity: null });

    // The lease carries no start identity, exactly as this platform allows.
    const lease = tree.createManagedProcessLease({
      operationId: "operation-darwin",
      workspaceId: "workspace-darwin",
      pid: child.pid!,
    });
    expect(lease).toMatchObject({ startIdentity: null, processGroupId: child.pid });
    // Alive, but not confirmable — and the group is alive with it.
    expect(tree.validateManagedProcessLease(lease)).toMatchObject({
      accepted: false,
      reason: "UNSUPPORTED_IDENTITY",
    });

    const signals: DeliveredSignal[] = [];
    const deliver = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal !== 0) {
        signals.push({ pid, signal: signal as NodeJS.Signals });
        return deliver(pid, signal as NodeJS.Signals);
      }
      return deliver(pid, 0);
    }) as typeof process.kill);

    let error: unknown = null;
    try {
      await tree.settleManagedProcessLease(lease);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({
      code: "PROCESS_CLEANUP_REFUSED",
      details: { reason: "UNSUPPORTED_IDENTITY", processGroupId: lease.processGroupId },
    });
    expect(signals).toEqual([]);
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it("settles a lease whose group is already gone, which needs no authority", async () => {
    const tree = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    const { script } = await stageScript("#!/bin/sh\nexit 0\n");
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const lease = tree.createManagedProcessLease({
      operationId: "operation-darwin-settled",
      workspaceId: "workspace-darwin-settled",
      pid: child.pid!,
    });
    await expect(tree.settleManagedProcessLease(lease)).resolves.toMatchObject({
      operationId: "operation-darwin-settled",
      processGroupId: lease.processGroupId,
      confirmed: true,
      membersEnumerated: false,
    });
  });

  it("reports GROUP_AUTHORITY_LOST when the leader is gone and the group remains", { timeout: 20_000 }, async () => {
    const tree = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    const dir = await mkdtemp(join(tmpdir(), "poiesis-darwin-leak-"));
    fixtures.push(dir);
    const descendant = join(dir, "descendant.sh");
    const leader = join(dir, "leader.sh");
    const pidFile = join(dir, "descendant.pid");
    await writeFile(
      descendant,
      [
        "#!/bin/sh",
        "trap '' TERM",
        "exec 0</dev/null 1>/dev/null 2>/dev/null",
        'printf "%s\\n" "$$" > "$1"',
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(descendant, 0o755);
    await writeFile(leader, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nexit 0\n`, "utf8");
    await chmod(leader, 0o755);

    const child = spawn(leader, [], { cwd: dir, detached: true, stdio: "ignore" });
    spawned.push(child);
    child.unref();
    tracked.push({ pid: child.pid!, startIdentity: null });
    const descendantPid = await waitForPid(pidFile);
    tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });
    const lease = tree.createManagedProcessLease({
      operationId: "operation-darwin-leak",
      workspaceId: "workspace-darwin-leak",
      pid: child.pid!,
    });

    let error: unknown = null;
    try {
      await tree.settleManagedProcessLease(lease);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "GROUP_AUTHORITY_LOST", phase: "before-sigterm", membersEnumerated: false },
    });
    expect(isSignalAlive(descendantPid)).toBe(true);
  });

  it("still refuses a lease whose group is not the detached group of its PID", async () => {
    const tree = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    child.unref();
    tracked.push({ pid: child.pid!, startIdentity: null });

    const lease = tree.createManagedProcessLease({
      operationId: "operation-darwin-foreign",
      workspaceId: "workspace-darwin-foreign",
      pid: child.pid!,
    });
    expect(tree.validateManagedProcessLease({ ...lease, processGroupId: lease.pid + 1_000_000 })).toMatchObject({
      accepted: false,
      reason: "FOREIGN_PROCESS",
    });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it("still refuses an unsafe target", async () => {
    const tree = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    child.unref();
    tracked.push({ pid: child.pid!, startIdentity: null });
    const lease = tree.createManagedProcessLease({
      operationId: "operation-darwin-unsafe",
      workspaceId: "workspace-darwin-unsafe",
      pid: child.pid!,
    });
    expect(tree.validateManagedProcessLease({ ...lease, processGroupId: 1 })).toMatchObject({
      accepted: false,
      reason: "UNSAFE_TARGET",
    });
    expect(isSignalAlive(child.pid!)).toBe(true);
  });
});
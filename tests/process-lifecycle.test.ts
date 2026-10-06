/**
 * Spec #168 / ticket #170, extended by ticket #180 — managed execution cleanup
 * on every exit.
 *
 * `run()` is the single subprocess seam every Poiesis operation goes
 * through, so its settlement contract is what actually bounds Poiesis:
 *
 *   - a command that leaves NOTHING behind settles on every outcome: success,
 *     non-zero exit, timeout, cancellation;
 *   - a command that leaks a descendant sets two different contracts, decided
 *     by whether the group's leader is still provable at the moment the group
 *     has to be signalled. While it is — a leader that survives the graceful
 *     signal — the group is signalled and the leak is cleaned, escalating to
 *     the forced phase when the descendant ignores SIGTERM. Once the leader is
 *     gone the group id is a free PID that nothing owns any more, so no signal
 *     is sent and the run reports the leak as an unresolved cleanup rather
 *     than as a clean finish;
 *   - a caller's AbortSignal cancels the run, and an already-aborted signal
 *     never spawns anything at all;
 *   - the managed process group is isolated from the Poiesis process
 *     group, so cleanup can never reach the caller's shell;
 *   - cleanup targets come from the lease alone: an unrelated process with
 *     an identical executable name, in a different group, is never
 *     signalled even though it shares the descendant's name;
 *   - a malformed operation/workspace identity is refused before a process
 *     is created.
 *
 * The suite is POSIX-wide: every scenario is asserted on any POSIX
 * platform, and the non-Linux identity model is exercised separately with
 * `process.platform` redefined, so its cleanup behaviour is covered on this
 * Linux host rather than only on a developer's Mac.
 *
 * Every assertion observes real processes through /proc and kill(2).
 */
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/process.js";

const fixtures: string[] = [];
const tracked = new Map<number, string | null>();

afterEach(async () => {
  for (const [pid, startIdentity] of tracked) {
    try {
      if (startIdentity === null || startTimeOf(pid) === startIdentity) process.kill(pid, "SIGKILL");
    } catch {
      // Already terminated.
    }
  }
  tracked.clear();
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

/**
 * `process.pid`'s start identity, read from `/proc`. `null` on a platform
 * without a readable process table (non-Linux POSIX), where the assertions
 * fall back to signal(0) liveness.
 */
function statFields(pid: number | "self"): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/**
 * The process-group id of `pid`, resolved portably: `/proc` where it is
 * available, `ps` otherwise. Used to prove the managed group is isolated
 * from Poiesis's own group on every POSIX platform.
 */
async function processGroupOf(pid: number): Promise<number | null> {
  const fields = statFields(pid);
  if (fields !== null) return Number(fields[2]);
  const result = await run("ps", ["-o", "pgid=", "-p", String(pid)], {
    cwd: tmpdir(),
    allowFailure: true,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) return null;
  const pgid = Number(result.stdout.trim());
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
}

async function ownProcessGroupId(): Promise<number | null> {
  const fields = statFields("self");
  if (fields !== null) return Number(fields[2]);
  return await processGroupOf(process.pid);
}

function startTimeOf(pid: number): string | null {
  return statFields(pid)?.[19] ?? null;
}

function isSameProcess(pid: number, startTime: string | null): boolean {
  if (startTime !== null) return startTimeOf(pid) === startTime;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Start a run and hand back its outcome already attached.
 *
 * Several cases below have to wait for the child to publish a PID before they
 * can assert anything, and some runs reject within milliseconds of the spawn —
 * a leaked descendant behind an already-exited parent is refused immediately. A
 * rejection nobody is listening for yet is an unhandled rejection, which fails
 * the whole run even when every assertion passes, so the handler is attached
 * here at the moment the invocation is created.
 */
function startRun(...args: Parameters<typeof run>): { outcome: Promise<unknown> } {
  const invocation = run(...args);
  return { outcome: invocation.then(() => null, (error: unknown) => error) };
}

interface LeakyTree {
  dir: string;
  parent: string;
  pidFile: string;
}

/**
 * Stage a parent that spawns `descendant.sh` in the background and then either
 * exits with `parentExit` or — with `parentStays` — ignores SIGTERM and stays
 * alive as the group's leader. The descendant holds the inherited stdout/stderr
 * open (so the runner cannot see the command as finished) unless
 * `detachOutput` is set, in which case it closes them and the runner only
 * learns about the leak from the process-group settlement.
 *
 * `parentStays` is the switch that decides which cleanup contract a run is
 * held to: a leader that outlives the graceful signal keeps the group's
 * authority, and a leader that exits with it does not.
 */
async function stageLeakyTree(options: {
  resistsTerm?: boolean;
  parentExit?: number;
  parentStays?: boolean;
  detachOutput?: boolean;
  name?: string;
}): Promise<LeakyTree> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-lifecycle-"));
  fixtures.push(dir);
  const name = options.name ?? "descendant";
  const descendant = join(dir, `${name}.sh`);
  const pidFile = join(dir, `${name}.pid`);
  await writeFile(
    descendant,
    [
      "#!/bin/sh",
      ...(options.resistsTerm === true ? ["trap '' TERM"] : []),
      ...(options.detachOutput === true ? ["exec 0</dev/null 1>/dev/null 2>/dev/null"] : []),
      'printf "%s\\n" "$$" > "$1"',
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(descendant, 0o755);
  const parent = join(dir, "parent.sh");
  await writeFile(
    parent,
    options.parentStays === true
      ? `#!/bin/sh\ntrap '' TERM\n"${descendant}" "${pidFile}" &\nwhile :; do sleep 1; done\n`
      : `#!/bin/sh\n"${descendant}" "${pidFile}" &\nexit ${options.parentExit ?? 0}\n`,
    "utf8",
  );
  await chmod(parent, 0o755);
  return { dir, parent, pidFile };
}

async function waitForPid(path: string, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The descendant has not published its PID yet.
    }
    await delay(20);
  }
  throw new Error(`descendant did not publish a valid PID at ${path}`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroup(pid: number, timeoutMs = 5_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let observed = await processGroupOf(pid);
  while (observed === null && Date.now() < deadline) {
    await delay(50);
    observed = await processGroupOf(pid);
  }
  return observed;
}

describe.skipIf(process.platform === "win32")("managed execution cleanup on success", () => {
  it("reports a leaked descendant it may no longer signal, instead of settling the run as clean", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({});
    const { outcome } = startRun(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    const descendantStart = startTimeOf(descendantPid);
    tracked.set(descendantPid, descendantStart);

    const startedAt = Date.now();
    // The parent exited, so the group id is a free PID while the descendant
    // still holds that group. Poiesis has no authority left over it, so the
    // honest outcome is "a process I spawned is still running", never "clean".
    await expect(outcome).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "GROUP_AUTHORITY_LOST", phase: "before-sigterm", membersEnumerated: false },
    });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(isSameProcess(descendantPid, descendantStart)).toBe(true);
  });

  it("reports the same leak without waiting for the linger window when the pipes are already closed", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ detachOutput: true });
    const { outcome } = startRun(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    const startedAt = Date.now();
    await expect(outcome).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "GROUP_AUTHORITY_LOST", membersEnumerated: false },
    });
    // The pipes closed with the parent, so the leak is observable immediately
    // and costs no linger window to report.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(isSameProcess(descendantPid, startTime)).toBe(true);
  });

  it("escalates past a TERM-resistant descendant while the leader is still confirmable", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ parentStays: true, resistsTerm: true, detachOutput: true });
    const startedAt = Date.now();
    // The leader ignores SIGTERM and stays the process Poiesis leased, so the
    // group keeps an owner and the forced phase is allowed to fire.
    const { outcome } = startRun(parent, [], { cwd: dir, timeoutMs: 250 });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);
    await expect(outcome).resolves.toMatchObject({ code: "COMMAND_TIMEOUT" });
    const elapsed = Date.now() - startedAt;
    // The graceful phase is bounded and the forced phase is what actually
    // removes this descendant, so settlement cannot be immediate.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(15_000);
    expect(isSameProcess(descendantPid, startTime)).toBe(false);
  });

  it("reports an out-of-reach leak ahead of the command's own non-zero exit", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ parentExit: 7 });
    const { outcome } = startRun(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    // A surviving process outranks the exit code: nothing may report this run
    // as finished while a process it spawned is still running.
    await expect(outcome).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "GROUP_AUTHORITY_LOST" },
    });
    expect(isSameProcess(descendantPid, startTime)).toBe(true);
  });
});

/**
 * Spec #168 / ticket #180 — the fail-closed non-Linux POSIX model.
 *
 * These are the production paths the Linux suite covers, imported with
 * `process.platform` redefined so the platform branches that cannot confirm a
 * process-start identity actually execute on this host.
 *
 * The contract there is no longer "clean up on a weaker basis". Group liveness
 * is an absence fact and never an ownership one, so a runtime that cannot read
 * `starttime` has no authority over a LIVE group at all: cleanup refuses,
 * signals nothing, and the refusal outranks the timeout or the cancellation
 * that triggered it. What still works is what needs no authority — a group that
 * is already gone.
 */
describe("non-Linux POSIX timeout and cancellation (platform-mocked)", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  async function stageTermResistantTree(): Promise<{ dir: string; parent: string; pidFile: string }> {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-posix-model-"));
    fixtures.push(dir);
    const descendant = join(dir, "descendant.sh");
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
    const parent = join(dir, "parent.sh");
    await writeFile(parent, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nsleep 30\n`, "utf8");
    await chmod(parent, 0o755);
    return { dir, parent, pidFile };
  }

  async function runAsPosix<T>(modules: string): Promise<T> {
    vi.resetModules();
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
    try {
      return await vi.importActual<T>(modules);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      vi.resetModules();
    }
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.resetModules();
  });

  it("refuses a timed-out run instead of signalling a group it cannot own", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageTermResistantTree();
    const module = await runAsPosix<typeof import("../src/process.js")>("../src/process.js");
    const invocation = module.run(parent, [], { cwd: dir, timeoutMs: 250 });
    const error = invocation.then(
      () => null,
      (rejection: { code?: string; details?: Record<string, unknown> }) => rejection,
    );
    const descendantPid = await waitForPid(pidFile);
    const descendantStart = startTimeOf(descendantPid);
    tracked.set(descendantPid, descendantStart);

    // The refusal is the reported outcome, not the timeout that triggered it:
    // Poiesis could not stop what it started, so nothing may report this run
    // as merely timed out.
    await expect(error).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_REFUSED",
      details: { reason: "UNSUPPORTED_IDENTITY" },
    });
    // Refused means unsignalled: the whole tree is still running.
    expect(isSameProcess(descendantPid, descendantStart)).toBe(true);
  });

  it("refuses a cancelled run for the same reason", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageTermResistantTree();
    const module = await runAsPosix<typeof import("../src/process.js")>("../src/process.js");
    const controller = new AbortController();
    const invocation = module.run(parent, [], { cwd: dir, timeoutMs: 60_000, signal: controller.signal });
    const error = invocation.then(
      () => null,
      (rejection: unknown) => rejection,
    );
    const descendantPid = await waitForPid(pidFile);
    const descendantStart = startTimeOf(descendantPid);
    tracked.set(descendantPid, descendantStart);

    controller.abort();
    await expect(error).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_REFUSED",
      details: { reason: "UNSUPPORTED_IDENTITY" },
    });
    expect(isSameProcess(descendantPid, descendantStart)).toBe(true);
  });

  it("reports an unreachable leak after a successful command", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-posix-leak-"));
    fixtures.push(dir);
    const descendant = join(dir, "descendant.sh");
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
    const parent = join(dir, "parent.sh");
    await writeFile(parent, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nexit 0\n`, "utf8");
    await chmod(parent, 0o755);

    const module = await runAsPosix<typeof import("../src/process.js")>("../src/process.js");
    const invocation = module.run(parent, [], { cwd: dir });
    const error = invocation.then(
      () => null,
      (rejection: unknown) => rejection,
    );
    const descendantPid = await waitForPid(pidFile);
    const descendantStart = startTimeOf(descendantPid);
    tracked.set(descendantPid, descendantStart);

    // The leader is gone and its PID is now only a number, so the group it
    // names is no longer Poiesis's to signal.
    await expect(error).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "GROUP_AUTHORITY_LOST", phase: "before-sigterm" },
    });
    expect(isSameProcess(descendantPid, descendantStart)).toBe(true);
  });

  it("still settles a command that leaves nothing behind", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-posix-clean-"));
    fixtures.push(dir);
    const script = join(dir, "clean.sh");
    await writeFile(script, "#!/bin/sh\nprintf ok\n", "utf8");
    await chmod(script, 0o755);

    const module = await runAsPosix<typeof import("../src/process.js")>("../src/process.js");
    // An empty group needs no ownership proof: there is nothing to signal and
    // nothing to confirm but its absence.
    await expect(module.run(script, [], { cwd: dir })).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
  });
});

describe.skipIf(process.platform === "win32")("managed execution cleanup on cancellation", () => {
  it("cancels a running command and still cleans the managed tree", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-cancel-"));
    fixtures.push(dir);
    const descendant = join(dir, "descendant.sh");
    const pidFile = join(dir, "descendant.pid");
    // The parent ignores SIGTERM and stays the group's leader, so the
    // cancellation reaches a group Poiesis still owns and can escalate over.
    await writeFile(
      join(dir, "parent.sh"),
      `#!/bin/sh\ntrap '' TERM\n"${descendant}" "${pidFile}" &\nwhile :; do sleep 1; done\n`,
      "utf8",
    );
    await writeFile(descendant, ["#!/bin/sh", "trap '' TERM", 'printf "%s\\n" "$$" > "$1"', "while :; do sleep 1; done", ""].join("\n"), "utf8");
    await chmod(descendant, 0o755);
    const parent = join(dir, "parent.sh");
    await chmod(parent, 0o755);

    const controller = new AbortController();
    const { outcome } = startRun(parent, [], { cwd: dir, timeoutMs: 60_000, signal: controller.signal });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    const startedAt = Date.now();
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(isSameProcess(descendantPid, startTime)).toBe(false);
  });

  it("reports a cancellation whose tree outlived the group's authority", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ resistsTerm: true });
    const controller = new AbortController();
    const { outcome } = startRun(parent, [], { cwd: dir, timeoutMs: 60_000, signal: controller.signal });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    controller.abort();
    // The parent exited with the TERM-resistant descendant still holding the
    // group, so the group id is a free PID before the first signal and nothing
    // may be sent at all. The cancellation is not the outcome either: a process
    // Poiesis spawned is still running.
    await expect(outcome).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "GROUP_AUTHORITY_LOST", phase: "before-sigterm", leaderState: "gone" },
    });
    expect(isSameProcess(descendantPid, startTime)).toBe(true);
  });

  it("never spawns a process when the caller's signal is already aborted", { timeout: 15_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(parent, [], { cwd: dir, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "COMMAND_CANCELLED" });
    await delay(250);
    expect(await fileExists(pidFile)).toBe(false);
  });

  it("keeps cancellation precedence over the command's own exit code", { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-cancel-race-"));
    fixtures.push(dir);
    const script = join(dir, "quick-fail.sh");
    await writeFile(script, "#!/bin/sh\nexit 7\n", "utf8");
    await chmod(script, 0o755);
    const controller = new AbortController();
    controller.abort();
    await expect(run(script, [], { cwd: dir, signal: controller.signal })).rejects.toMatchObject({
      code: "COMMAND_CANCELLED",
    });
  });
});

describe.skipIf(process.platform === "win32")("managed execution isolation and target selection", () => {
  it("runs the managed tree in a process group isolated from the Poiesis process group", { timeout: 30_000 }, async () => {
    // TERM-resistant so the descendant is still observable while the
    // group's settlement runs.
    const { dir, parent, pidFile } = await stageLeakyTree({ detachOutput: true, resistsTerm: true });
    const { outcome } = startRun(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    tracked.set(descendantPid, startTimeOf(descendantPid));
    const managedGroup = await waitForProcessGroup(descendantPid);

    expect(managedGroup).not.toBeNull();
    expect(managedGroup).not.toBe(await ownProcessGroupId());
    // The managed group is addressed by its own leader's PID and is not
    // reachable through Poiesis's group.
    expect(managedGroup).not.toBe(process.pid);
    // The parent exited with the descendant still holding its group, which is
    // the honest report: isolation held, ownership did not survive the exit.
    await expect(outcome).resolves.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "GROUP_AUTHORITY_LOST" },
    });
  });

  it("never signals an unrelated process that shares the descendant's executable name", { timeout: 30_000 }, async () => {
    const managed = await stageLeakyTree({ parentStays: true, detachOutput: true, name: "same-name" });
    // A decoy with byte-identical content, started by the test outside any
    // managed group. Name, command line, and executable all match the
    // managed descendant; only the lease identity differs.
    const decoyDir = await mkdtemp(join(tmpdir(), "poiesis-decoy-"));
    fixtures.push(decoyDir);
    await writeFile(
      join(decoyDir, "same-name.sh"),
      await readFile(join(managed.dir, "same-name.sh"), "utf8"),
      "utf8",
    );
    await chmod(join(decoyDir, "same-name.sh"), 0o755);
    const { spawn } = await import("node:child_process");
    const decoyPidFile = join(decoyDir, "decoy.pid");
    const decoy = spawn(join(decoyDir, "same-name.sh"), [decoyPidFile], { stdio: "ignore" });
    const decoyPid = await waitForPid(decoyPidFile);
    const decoyStart = startTimeOf(decoyPid);
    tracked.set(decoyPid, decoyStart);

    // The leader stays provable, so this run really does signal its group.
    const { outcome } = startRun(managed.parent, [], { cwd: managed.dir, timeoutMs: 250 });
    const descendantPid = await waitForPid(managed.pidFile);
    const descendantStart = startTimeOf(descendantPid);
    tracked.set(descendantPid, descendantStart);
    await expect(outcome).resolves.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(isSameProcess(descendantPid, descendantStart)).toBe(false);
    // The same-named process outside the leased group is untouched: cleanup
    // never matched on anything but the lease.
    expect(isSameProcess(decoyPid, decoyStart)).toBe(true);
    decoy.kill("SIGKILL");
  });

  it("refuses a malformed operation identity before creating a process", { timeout: 15_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({});
    await expect(run(parent, [], { cwd: dir, operationId: "" })).rejects.toMatchObject({
      code: "PROCESS_LEASE_MALFORMED",
    });
    await delay(250);
    expect(await fileExists(pidFile)).toBe(false);
  });

  it("refuses a malformed workspace identity before creating a process", { timeout: 15_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({});
    await expect(run(parent, [], { cwd: dir, workspaceId: "  " })).rejects.toMatchObject({
      code: "PROCESS_LEASE_MALFORMED",
    });
    await delay(250);
    expect(await fileExists(pidFile)).toBe(false);
  });
});

/**
 * Spec #168 / ticket #175 — bounded rejection when managed cleanup is
 * REFUSED or UNRESOLVED while the child is still live.
 *
 * Settling after the child's `exit` is the right ordering for every outcome
 * a CONFIRMED cleanup produces, because the cleanup is what makes the exit
 * happen. A refused or unresolved cleanup breaks exactly that assumption:
 * it stopped because it could not prove the target was still the process
 * Poiesis leased, so no signal was sent, the child kept running, and no
 * `exit` was coming. Waiting for one left the run pending forever and lost
 * the typed cleanup error with it.
 *
 * These drive the public `run()` seam and force each failure through the
 * real `settleManagedProcessLease`, never a hand-thrown error:
 *
 *   - refusal: the kernel process-start identity cannot be read, so the
 *     lease is ambiguous and cleanup refuses without signalling at all;
 *   - unresolved: every signal is undeliverable and the group never empties,
 *     so settlement cannot confirm that anything terminated.
 *
 * In both the child is still live when cleanup gives up, so the run must
 * still settle, still reject with the ORIGINAL cleanup error ahead of
 * timeout and cancellation, still signal nothing further, and still leave
 * Node unblocked.
 */
describe.skipIf(process.platform === "win32")("bounded rejection when managed cleanup is refused or unresolved", () => {
  const REFUSAL_BOUND_MS = 10_000;
  const UNRESOLVED_BOUND_MS = 15_000;

  type RunOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

  interface CleanupObservation {
    /** `null` means the run was still pending when its bound elapsed. */
    readonly outcome: RunOutcome | null;
    readonly elapsedMs: number;
    /** Every PID Poiesis signalled while the run was in flight. */
    readonly signalsSent: number[];
    readonly handlesBefore: number;
    readonly handlesAfter: number;
  }

  /**
   * A child that publishes its own PID and then stays alive as a single
   * process, so a test can prove cleanup never reached it: `exec` replaces
   * the shell, leaving the published PID and the surviving process identical.
   */
  async function stageLiveChild(): Promise<{ dir: string; script: string; pidFile: string }> {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-refusal-"));
    fixtures.push(dir);
    const pidFile = join(dir, "child.pid");
    const script = join(dir, "live.sh");
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$$" > "${pidFile}"\nexec sleep 30\n`, "utf8");
    await chmod(script, 0o755);
    return { dir, script, pidFile };
  }

  /** The live child a run left behind, tracked for the suite's own teardown. */
  async function trackLiveChild(pidFile: string): Promise<{ pid: number; startTime: string | null }> {
    const pid = await waitForPid(pidFile);
    const startTime = startTimeOf(pid);
    tracked.set(pid, startTime);
    return { pid, startTime };
  }

  /** Settle an invocation, or report `null` if it is still pending at the bound. */
  async function settleWithin(invocation: Promise<unknown>, boundMs: number): Promise<RunOutcome | null> {
    let timer: NodeJS.Timeout | null = null;
    const stillPending = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), boundMs);
    });
    try {
      return await Promise.race([
        invocation.then(
          () => ({ ok: true }) as RunOutcome,
          (error: unknown) => ({ ok: false, error }) as RunOutcome,
        ),
        stillPending,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Runtime handles one managed run owns: the child's pipes and its handle. */
  function ownedHandleCount(): number {
    return process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "PipeWrap" || resource === "ProcessWrap").length;
  }

  async function waitForHandlesAtOrBelow(baseline: number, boundMs = 3_000): Promise<void> {
    const deadline = Date.now() + boundMs;
    while (ownedHandleCount() > baseline && Date.now() < deadline) await delay(20);
  }

  /**
   * Drive one `run()` whose lease validation refuses the cleanup as
   * ambiguous, and observe what it settled with, how long that took, what
   * it signalled, and which runtime handles it still held afterwards.
   */
  async function runRefusingCleanup(
    command: string,
    args: string[],
    options: Parameters<typeof run>[2],
    afterStart?: () => Promise<void>,
  ): Promise<CleanupObservation> {
    const deliver = process.kill.bind(process);
    const signalsSent: number[] = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal !== 0) signalsSent.push(pid);
      return signal === 0 ? deliver(pid, 0) : deliver(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

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
      const module = await vi.importActual<typeof import("../src/process.js")>("../src/process.js");
      const handlesBefore = ownedHandleCount();
      const startedAt = Date.now();
      const invocation = module.run(command, args, options);
      if (afterStart !== undefined) await afterStart();
      const outcome = await settleWithin(invocation, REFUSAL_BOUND_MS);
      return {
        outcome,
        elapsedMs: Date.now() - startedAt,
        signalsSent,
        handlesBefore,
        handlesAfter: ownedHandleCount(),
      };
    } finally {
      killSpy.mockRestore();
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  }

  /**
   * Drive one `run()` whose settlement runs to completion but cannot remove
   * anything: every signal is swallowed and the group answers every liveness
   * probe, so settlement can only fail closed as unresolved.
   */
  async function runWithUndeliverableSignals(
    command: string,
    args: string[],
    options: Parameters<typeof run>[2],
    afterStart?: () => Promise<void>,
  ): Promise<{
    outcome: RunOutcome | null;
    elapsedMs: number;
    handlesBefore: number;
    handlesAfter: number;
  }> {
    const probe = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0) return pid < 0 ? true : probe(pid, 0);
      return true;
    }) as typeof process.kill);
    try {
      const handlesBefore = ownedHandleCount();
      const startedAt = Date.now();
      const invocation = run(command, args, options);
      if (afterStart !== undefined) await afterStart();
      const outcome = await settleWithin(invocation, UNRESOLVED_BOUND_MS);
      return { outcome, elapsedMs: Date.now() - startedAt, handlesBefore, handlesAfter: ownedHandleCount() };
    } finally {
      killSpy.mockRestore();
    }
  }

  it("rejects boundedly with the cleanup error ahead of the timeout that triggered it", { timeout: 30_000 }, async () => {
    const { dir, script, pidFile } = await stageLiveChild();
    let live: { pid: number; startTime: string | null } | null = null;
    const observed = await runRefusingCleanup(script, [], { cwd: dir, timeoutMs: 250 }, async () => {
      live = await trackLiveChild(pidFile);
    });

    // Bounded: the run settles inside its own window instead of waiting for
    // an `exit` the refused cleanup could never cause.
    expect(observed.outcome).not.toBeNull();
    expect(observed.elapsedMs).toBeLessThan(REFUSAL_BOUND_MS);
    // The original typed cleanup error, not the timeout that triggered it.
    expect(observed.outcome).toMatchObject({
      ok: false,
      error: { code: "PROCESS_CLEANUP_REFUSED", details: { reason: "IDENTITY_AMBIGUOUS" } },
    });
    // Refused means unconfirmed, so nothing may be signalled: not the group,
    // not the leader, and not the child afterwards either.
    expect(observed.signalsSent).toEqual([]);
    // The child was still live when cleanup gave up, and still is.
    expect(live).not.toBeNull();
    expect(isSameProcess(live!.pid, live!.startTime)).toBe(true);
  });

  it("rejects boundedly with the unresolved error while the child is still live", { timeout: 40_000 }, async () => {
    const { dir, script, pidFile } = await stageLiveChild();
    let live: { pid: number; startTime: string | null } | null = null;
    const observed = await runWithUndeliverableSignals(script, [], { cwd: dir, timeoutMs: 250 }, async () => {
      live = await trackLiveChild(pidFile);
    });

    expect(observed.outcome).not.toBeNull();
    expect(observed.outcome).toMatchObject({
      ok: false,
      error: {
        code: "PROCESS_CLEANUP_UNRESOLVED",
        // No member list was read, so none is reported: the group is still
        // there and that is the whole of the evidence.
        details: {
          reason: "GROUP_STILL_PRESENT",
          phase: "confirm",
          membersEnumerated: false,
          confirmed: false,
        },
      },
    });
    // Nothing could be removed, so the process this run spawned is still the
    // same live process — and the run still finished.
    expect(isSameProcess(live!.pid, live!.startTime)).toBe(true);
  });

  it("reports a refused cleanup ahead of the caller's cancellation", { timeout: 30_000 }, async () => {
    const { dir, script, pidFile } = await stageLiveChild();
    const controller = new AbortController();
    let live: { pid: number; startTime: string | null } | null = null;
    const observed = await runRefusingCleanup(
      script,
      [],
      { cwd: dir, timeoutMs: 60_000, signal: controller.signal },
      async () => {
        live = await trackLiveChild(pidFile);
        controller.abort();
      },
    );

    expect(observed.outcome).not.toBeNull();
    expect(observed.outcome).toMatchObject({ ok: false, error: { code: "PROCESS_CLEANUP_REFUSED" } });
    expect(isSameProcess(live!.pid, live!.startTime)).toBe(true);
  });

  it("leaves Node unblocked when it rejects for a refused cleanup", { timeout: 30_000 }, async () => {
    const { dir, script, pidFile } = await stageLiveChild();
    const controller = new AbortController();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    let live: { pid: number; startTime: string | null } | null = null;
    const observed = await runRefusingCleanup(
      script,
      [],
      { cwd: dir, timeoutMs: 250, signal: controller.signal },
      async () => {
        live = await trackLiveChild(pidFile);
      },
    );

    expect(observed.outcome).toMatchObject({ ok: false, error: { code: "PROCESS_CLEANUP_REFUSED" } });
    // A bounded rejection must not be how Node stays blocked: the abort
    // listener is detached and the run holds neither the child's pipes nor
    // its process handle, even though the child itself is still alive.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(isSameProcess(live!.pid, live!.startTime)).toBe(true);
    await waitForHandlesAtOrBelow(observed.handlesBefore);
    expect(ownedHandleCount()).toBeLessThanOrEqual(observed.handlesBefore);
  });

  /**
   * Spec #168 / ticket #177 — the leader is GONE and the cleanup still refuses,
   * which is the case that used to leave the runtime holding the descendant's
   * pipes.
   *
   * `childExited` and "cleanup failed" are independent facts. A leader that has
   * exited can still have left a descendant holding the inherited stdout and
   * stderr, and those two open pipes are precisely what keeps a Node process
   * alive after a run that has already given up. Releasing runtime-owned
   * handles used to be conditioned on the child still being live, so exactly
   * this shape settled with its cleanup error while still holding them.
   */
  it("releases the pipes a leaked descendant still holds when cleanup is refused after the leader exited", { timeout: 40_000 }, async () => {
    // No `detachOutput`: the descendant inherits and keeps both pipes open, so
    // the run cannot see the command as finished and settles the group through
    // the linger window instead.
    const { dir, parent, pidFile } = await stageLeakyTree({});
    const observed = await runRefusingCleanup(parent, [], { cwd: dir, timeoutMs: 60_000 });

    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    // Bounded, and typed: the leader exiting changes neither the refusal nor
    // the requirement that the run settles instead of waiting for an `exit` no
    // further signal can cause.
    expect(observed.outcome).not.toBeNull();
    expect(observed.elapsedMs).toBeLessThan(REFUSAL_BOUND_MS);
    expect(observed.outcome).toMatchObject({
      ok: false,
      error: { code: "PROCESS_CLEANUP_REFUSED", details: { reason: "IDENTITY_AMBIGUOUS" } },
    });
    // Refused is still unconfirmed, so nothing was signalled — and the
    // surviving descendant is exactly why that is the honest outcome.
    expect(observed.signalsSent).toEqual([]);
    expect(isSameProcess(descendantPid, startTime)).toBe(true);
    // The regression: the pipes the descendant still holds do not outlive the
    // rejection as runtime handles.
    await waitForHandlesAtOrBelow(observed.handlesBefore);
    expect(ownedHandleCount()).toBeLessThanOrEqual(observed.handlesBefore);
  });

  it("releases those same handles when the leader's cleanup is UNRESOLVED instead", { timeout: 40_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({});
    const observed = await runWithUndeliverableSignals(parent, [], { cwd: dir, timeoutMs: 60_000 });

    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    expect(observed.outcome).toMatchObject({
      ok: false,
      // The leader is gone and the group it named is still alive: authority
      // lost, so nothing was signalled after the graceful phase.
      error: { code: "PROCESS_CLEANUP_UNRESOLVED", details: { reason: "GROUP_AUTHORITY_LOST", confirmed: false } },
    });
    expect(observed.elapsedMs).toBeLessThan(UNRESOLVED_BOUND_MS);
    // Nothing could be removed, so the descendant this run leaked is still the
    // same live process — and the run still finished and let go of its handles.
    expect(isSameProcess(descendantPid, startTime)).toBe(true);
    await waitForHandlesAtOrBelow(observed.handlesBefore);
    expect(ownedHandleCount()).toBeLessThanOrEqual(observed.handlesBefore);
  });

  it("still resolves a normal successful run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-refusal-ok-"));
    fixtures.push(dir);
    const script = join(dir, "ok.sh");
    await writeFile(script, "#!/bin/sh\nprintf ok\n", "utf8");
    await chmod(script, 0o755);
    await expect(run(script, [], { cwd: dir })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok",
      timedOut: false,
      signal: null,
    });
  });

  it("still cleans a leaked descendant while its leader stays confirmable", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ parentStays: true, detachOutput: true });
    const { outcome } = startRun(parent, [], { cwd: dir, timeoutMs: 250 });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    // Nothing about this run is reported as unresolved: the group had an owner
    // at every signal, so the leak was cleaned like any other.
    await expect(outcome).resolves.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(isSameProcess(descendantPid, startTime)).toBe(false);
  });
});
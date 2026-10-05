/**
 * Spec #168 / ticket #170 — managed execution cleanup on every exit.
 *
 * `run()` is the single subprocess seam every Poiesis operation goes
 * through, so its settlement contract is what actually bounds Poiesis:
 *
 *   - a command that exits SUCCESSFULLY but leaks a background descendant
 *     still settles, and the descendant is gone;
 *   - the same holds when the leaked descendant ignores SIGTERM, and for a
 *     command that exits non-zero;
 *   - a caller's AbortSignal cancels the run and still cleans the tree,
 *     and an already-aborted signal never spawns anything at all;
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

interface LeakyTree {
  dir: string;
  parent: string;
  pidFile: string;
}

/**
 * Stage a parent that spawns `descendant.sh` in the background and then
 * exits with `parentExit`. The descendant holds the inherited stdout/stderr
 * open (so the runner cannot see the command as finished) unless
 * `detachOutput` is set, in which case it closes them and the runner only
 * learns about the leak from the process-group settlement.
 */
async function stageLeakyTree(options: {
  resistsTerm?: boolean;
  parentExit?: number;
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
    `#!/bin/sh\n"${descendant}" "${pidFile}" &\nexit ${options.parentExit ?? 0}\n`,
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
  it("settles a successful command that leaks a background descendant holding the output pipes", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({});
    const invocation = run(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    tracked.set(descendantPid, startTimeOf(descendantPid));

    const startedAt = Date.now();
    await expect(invocation).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    const elapsed = Date.now() - startedAt;
    // Bounded: the leak is cleaned promptly, never by waiting out the
    // default command timeout.
    expect(elapsed).toBeLessThan(15_000);
    expect(isSameProcess(descendantPid, startTimeOf(descendantPid))).toBe(false);
  });

  it("cleans a leaked descendant that already closed the inherited output pipes", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ detachOutput: true });
    const invocation = run(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    const startedAt = Date.now();
    await expect(invocation).resolves.toMatchObject({ exitCode: 0 });
    // The pipes closed with the parent, so the leak is only observable
    // through the process group and must be cleaned without the linger
    // window.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(isSameProcess(descendantPid, startTime)).toBe(false);
  });

  it("escalates past a TERM-resistant leaked descendant before settling", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ resistsTerm: true });
    const invocation = run(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    const startedAt = Date.now();
    await expect(invocation).resolves.toMatchObject({ exitCode: 0 });
    const elapsed = Date.now() - startedAt;
    // The graceful phase is bounded and the forced phase is what actually
    // removes this descendant, so settlement cannot be immediate.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(15_000);
    expect(isSameProcess(descendantPid, startTime)).toBe(false);
  });

  it("cleans a leaked descendant of a command that exits non-zero", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageLeakyTree({ parentExit: 7 });
    const invocation = run(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_FAILED", details: { exitCode: 7 } });
    expect(isSameProcess(descendantPid, startTime)).toBe(false);
  });
});

/**
 * Spec #168 / ticket #170 — the cancellation and timeout paths on a POSIX
 * platform with no readable process table.
 *
 * These are the same production paths the Linux suite covers, imported
 * with `process.platform` redefined so the documented group-only identity
 * model is exercised on this host. Without that model the runner would
 * refuse to clean up anything, and a cancelled or timed-out run would leave
 * its whole tree behind.
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

  it("times out and still cleans the managed tree", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageTermResistantTree();
    const module = await runAsPosix<typeof import("../src/process.js")>("../src/process.js");
    const invocation = module.run(parent, [], { cwd: dir, timeoutMs: 250 });
    const descendantPid = await waitForPid(pidFile);
    tracked.set(descendantPid, startTimeOf(descendantPid));

    // The refusal-to-clean failure mode this model exists to prevent: the
    // timeout must still be the reported outcome, and the tree must
    // actually be gone rather than left running.
    const error = await invocation.then(
      () => null,
      (rejection: { code?: string }) => rejection,
    );
    expect(error?.code).toBe("COMMAND_TIMEOUT");
    expect(isSameProcess(descendantPid, startTimeOf(descendantPid))).toBe(false);
  });

  it("cancels and still cleans the managed tree", { timeout: 30_000 }, async () => {
    const { dir, parent, pidFile } = await stageTermResistantTree();
    const module = await runAsPosix<typeof import("../src/process.js")>("../src/process.js");
    const controller = new AbortController();
    const invocation = module.run(parent, [], { cwd: dir, timeoutMs: 60_000, signal: controller.signal });
    const descendantPid = await waitForPid(pidFile);
    tracked.set(descendantPid, startTimeOf(descendantPid));

    controller.abort();
    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_CANCELLED" });
    expect(isSameProcess(descendantPid, startTimeOf(descendantPid))).toBe(false);
  });

  it("cleans a leaked descendant after a successful command", { timeout: 30_000 }, async () => {
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
    const descendantPid = await waitForPid(pidFile);
    tracked.set(descendantPid, startTimeOf(descendantPid));

    await expect(invocation).resolves.toMatchObject({ exitCode: 0 });
    expect(isSameProcess(descendantPid, startTimeOf(descendantPid))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("managed execution cleanup on cancellation", () => {
  it("cancels a running command and still cleans the managed tree", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-cancel-"));
    fixtures.push(dir);
    const descendant = join(dir, "descendant.sh");
    const pidFile = join(dir, "descendant.pid");
    await writeFile(
      descendant,
      ["#!/bin/sh", "trap '' TERM", 'printf "%s\\n" "$$" > "$1"', "while :; do sleep 1; done", ""].join("\n"),
      "utf8",
    );
    await chmod(descendant, 0o755);
    const parent = join(dir, "parent.sh");
    await writeFile(parent, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nsleep 30\n`, "utf8");
    await chmod(parent, 0o755);

    const controller = new AbortController();
    const invocation = run(parent, [], { cwd: dir, timeoutMs: 60_000, signal: controller.signal });
    const descendantPid = await waitForPid(pidFile);
    const startTime = startTimeOf(descendantPid);
    tracked.set(descendantPid, startTime);

    const startedAt = Date.now();
    controller.abort();
    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(isSameProcess(descendantPid, startTime)).toBe(false);
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
    // group settlement's graceful phase runs.
    const { dir, parent, pidFile } = await stageLeakyTree({ detachOutput: true, resistsTerm: true });
    const invocation = run(parent, [], { cwd: dir });
    const descendantPid = await waitForPid(pidFile);
    tracked.set(descendantPid, startTimeOf(descendantPid));
    const managedGroup = await waitForProcessGroup(descendantPid);

    expect(managedGroup).not.toBeNull();
    expect(managedGroup).not.toBe(await ownProcessGroupId());
    // The managed group is addressed by its own leader's PID and is not
    // reachable through Poiesis's group.
    expect(managedGroup).not.toBe(process.pid);
    await expect(invocation).resolves.toMatchObject({ exitCode: 0 });
  });

  it("never signals an unrelated process that shares the descendant's executable name", { timeout: 30_000 }, async () => {
    const managed = await stageLeakyTree({ detachOutput: true, name: "same-name" });
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

    const invocation = run(managed.parent, [], { cwd: managed.dir });
    const descendantPid = await waitForPid(managed.pidFile);
    const descendantStart = startTimeOf(descendantPid);
    tracked.set(descendantPid, descendantStart);

    await expect(invocation).resolves.toMatchObject({ exitCode: 0 });
    expect(isSameProcess(descendantPid, descendantStart)).toBe(false);
    // The same-named process outside the leased group is untouched.
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
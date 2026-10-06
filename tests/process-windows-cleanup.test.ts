/**
 * Spec #168 / ticket #176 — the Windows pending-cleanup defect.
 *
 * On Windows there is no POSIX process group and no readable process-start
 * identity, so `taskkill /PID <pid> /T` is the only tree-addressing primitive,
 * and it is meaningful ONLY while the PID is still the process Poiesis
 * spawned. That leaves exactly three phases — graceful taskkill, forced
 * taskkill, and `child.kill` — and every one of them can fail. Before this
 * ticket the run settled as if the cleanup had succeeded anyway, so a process
 * Poiesis spawned could still be running while the run reported success, a
 * timeout, or a cancellation.
 *
 * These tests drive the PUBLIC `run()` seam with `process.platform` redefined
 * and `node:child_process` mocked, so the real Windows branch executes on this
 * host:
 *   - total cleanup failure rejects boundedly with a typed cleanup error while
 *     the child is still live, outranks both the timeout and the cancellation
 *     that triggered it, and releases the runtime resources the run owns;
 *   - success, timeout, and cancellation are unchanged;
 *   - a PID is never addressed after the child exited.
 */
import { getEventListeners } from "node:events";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
const fixtures: string[] = [];
const tracked = new Map<number, string | null>();

afterEach(async () => {
  for (const [pid, startIdentity] of tracked) {
    try {
      if (startIdentity === null) process.kill(pid, "SIGKILL");
    } catch {
      // Already terminated.
    }
  }
  tracked.clear();
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  vi.doUnmock("node:child_process");
  vi.resetModules();
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

/**
 * The Windows branch's real behaviour under a scripted `taskkill`, through the
 * public `run()` seam.
 *
 * `taskkill` outcomes are scripted per phase, and `neutralizeChildKill` makes
 * `child.kill` a no-op so the run reaches the point where NOTHING can confirm
 * the child is gone. That is the defect this ticket fixes.
 */
async function runAsWindows(
  args: string[],
  options: Parameters<typeof import("../src/process.js").run>[2],
  script: {
    gracefulTaskkillExit: number;
    forcedTaskkillExit: number;
    neutralizeChildKill: boolean;
    forceTerminateOnForcedTaskkill?: boolean;
    forceTerminateOnGracefulTaskkill?: boolean;
  },
): Promise<{ taskkillCalls: string[][]; run: () => Promise<never> }> {
  const taskkillCalls: string[][] = [];
  vi.resetModules();
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      spawn: ((...spawnArgs: unknown[]) => {
        if (spawnArgs[0] !== "taskkill") {
          const child = Reflect.apply(actual.spawn, undefined, spawnArgs) as ChildProcess;
          if (script.neutralizeChildKill) {
            Object.defineProperty(child, "kill", { configurable: true, value: () => false });
          }
          return child;
        }
        const argv = spawnArgs[1] as string[];
        taskkillCalls.push(argv);
        const helper = new EventEmitter() as ChildProcess;
        Object.assign(helper, { kill: () => true });
        const forced = argv.includes("/F");
        setTimeout(() => {
          const terminate =
            forced ? script.forceTerminateOnForcedTaskkill === true : script.forceTerminateOnGracefulTaskkill === true;
          if (terminate) {
            try {
              process.kill(Number(argv[1]), "SIGKILL");
            } catch {
              // The child is already gone.
            }
          }
          helper.emit("close", forced ? script.forcedTaskkillExit : script.gracefulTaskkillExit);
        }, 25);
        return helper;
      }) as typeof actual.spawn,
    };
  });
  Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: "win32" });
  const mocked = await import("../src/process.js");
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  return {
    taskkillCalls,
    run: () => mocked.run(process.execPath, args, options) as Promise<never>,
  };
}

const LIVE_CHILD = ["-e", "setTimeout(() => {}, 30_000)"];
/** Bound the "nothing confirmed the exit" window in the assertions below. */
const UNRESOLVED_BOUND_MS = 15_000;

function ownedHandleCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "PipeWrap" || resource === "ProcessWrap").length;
}

async function waitForHandlesAtOrBelow(baseline: number, boundMs = 3_000): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (ownedHandleCount() > baseline && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function settleWithin(
  invocation: Promise<unknown>,
  boundMs: number,
): Promise<{ settled: false } | { settled: true; error: unknown }> {
  let timer: NodeJS.Timeout | null = null;
  const stillPending = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), boundMs);
  });
  try {
    return await Promise.race([
      invocation.then(
        () => ({ settled: true, error: null }) as { settled: true; error: unknown },
        (error: unknown) => ({ settled: true, error }) as { settled: true; error: unknown },
      ),
      stillPending,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

describe("Windows cleanup that cannot be confirmed (Spec #168 / ticket #176)", () => {
  it("rejects boundedly with PROCESS_CLEANUP_UNRESOLVED while the child is still live", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-unresolved-");
    const { run: invoke } = await runAsWindows(
      LIVE_CHILD,
      { cwd: dir, timeoutMs: 250 },
      { gracefulTaskkillExit: 1, forcedTaskkillExit: 1, neutralizeChildKill: true },
    );

    const startedAt = Date.now();
    const outcome = await settleWithin(invoke(), UNRESOLVED_BOUND_MS);
    const elapsedMs = Date.now() - startedAt;

    // Bounded: the run settles on its own windows instead of waiting for an
    // `exit` that nothing could cause.
    expect(outcome).toMatchObject({ settled: true });
    expect(elapsedMs).toBeLessThan(UNRESOLVED_BOUND_MS);
    // The cleanup error, not the timeout that triggered the cleanup.
    expect((outcome as { error: unknown }).error).toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { confirmed: false, containment: "process-group", platform: "win32" },
    });
    expect(((outcome as { error: unknown }).error as { exitCode: number }).exitCode).toBe(1);
  });

  it("keeps cleanup-error priority over the caller's cancellation", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-unresolved-cancel-");
    const controller = new AbortController();
    const { run: invoke } = await runAsWindows(
      LIVE_CHILD,
      { cwd: dir, timeoutMs: 60_000, signal: controller.signal },
      { gracefulTaskkillExit: 1, forcedTaskkillExit: 1, neutralizeChildKill: true },
    );

    const invocation = invoke();
    queueMicrotask(() => controller.abort());
    const outcome = await settleWithin(invocation, UNRESOLVED_BOUND_MS);

    expect((outcome as { error: unknown }).error).toMatchObject({ code: "PROCESS_CLEANUP_UNRESOLVED" });
  });

  it("leaves the child live and Node unblocked when the cleanup rejects", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-unresolved-release-");
    const controller = new AbortController();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    const { run: invoke } = await runAsWindows(
      ["-e", "require('node:fs').writeFileSync(process.env.POIESIS_WIN_PID, String(process.pid)); setTimeout(() => {}, 30_000)"],
      {
        cwd: dir,
        timeoutMs: 250,
        signal: controller.signal,
        env: { ...process.env, POIESIS_WIN_PID: join(dir, "child.pid") },
      },
      { gracefulTaskkillExit: 1, forcedTaskkillExit: 1, neutralizeChildKill: true },
    );

    const baseline = ownedHandleCount();
    const startedAt = Date.now();
    const outcome = await settleWithin(invoke(), UNRESOLVED_BOUND_MS);
    expect((outcome as { error: unknown }).error).toMatchObject({ code: "PROCESS_CLEANUP_UNRESOLVED" });

    // The abort listener the run attached is gone even though the child lives.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await waitForHandlesAtOrBelow(baseline);
    expect(ownedHandleCount()).toBeLessThanOrEqual(baseline);

    const pid = Number((await readFile(join(dir, "child.pid"), "utf8")).trim());
    tracked.set(pid, null);
    // Reported as unresolved precisely because the process is still there.
    expect(isAlive(pid)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(UNRESOLVED_BOUND_MS);
  });
});

describe("unchanged Windows outcomes (Spec #168 / ticket #176)", () => {
  it("still resolves a normal completion without ever addressing a PID", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-success-");
    const { taskkillCalls, run: invoke } = await runAsWindows(
      ["-e", "process.stdout.write('done')"],
      { cwd: dir },
      { gracefulTaskkillExit: 1, forcedTaskkillExit: 1, neutralizeChildKill: false },
    );

    await expect(invoke()).resolves.toMatchObject({ exitCode: 0, stdout: "done" });
    expect(taskkillCalls).toEqual([]);
  });

  it("still reports a timeout when the forced taskkill phase terminates the tree", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-timeout-");
    const { taskkillCalls, run: invoke } = await runAsWindows(
      LIVE_CHILD,
      { cwd: dir, timeoutMs: 200 },
      {
        gracefulTaskkillExit: 1,
        forcedTaskkillExit: 0,
        neutralizeChildKill: false,
        forceTerminateOnForcedTaskkill: true,
      },
    );

    await expect(invoke()).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(taskkillCalls).toEqual([
      ["/PID", expect.any(String), "/T"],
      ["/PID", expect.any(String), "/T", "/F"],
    ]);
  });

  it("still reports the caller's cancellation when cleanup does succeed", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-cancel-");
    const controller = new AbortController();
    const { run: invoke } = await runAsWindows(
      LIVE_CHILD,
      { cwd: dir, timeoutMs: 60_000, signal: controller.signal },
      {
        gracefulTaskkillExit: 1,
        forcedTaskkillExit: 0,
        neutralizeChildKill: false,
        forceTerminateOnForcedTaskkill: true,
      },
    );

    const invocation = invoke();
    queueMicrotask(() => controller.abort());
    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
  });
});

/**
 * `taskkill /T` exits 0 for trees it never reached, so a graceful SUCCESS is a
 * claim about the request, not about the process. The only evidence this runner
 * holds is its own `exit` event, so escalation cannot stop at the first phase
 * that reported success.
 */
describe("Windows escalation does not trust a reported success (Spec #168 / ticket #176)", () => {
  it("still forces the tree when the graceful taskkill reported success and the child is alive", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-force-after-success-");
    const { taskkillCalls, run: invoke } = await runAsWindows(
      LIVE_CHILD,
      { cwd: dir, timeoutMs: 250 },
      {
        gracefulTaskkillExit: 0,
        forcedTaskkillExit: 0,
        neutralizeChildKill: false,
        forceTerminateOnForcedTaskkill: true,
      },
    );

    // The outcome is the real one — the forced phase is what ended the tree — so
    // the run reports the timeout that triggered the cleanup, not a cleanup error.
    await expect(invoke()).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(taskkillCalls).toEqual([
      ["/PID", expect.any(String), "/T"],
      ["/PID", expect.any(String), "/T", "/F"],
    ]);
  });

  it("does not address the PID again once the graceful taskkill really did end the child", { timeout: 60_000 }, async () => {
    const dir = await scratch("poiesis-win-no-second-pid-");
    const { taskkillCalls, run: invoke } = await runAsWindows(
      LIVE_CHILD,
      { cwd: dir, timeoutMs: 250 },
      {
        gracefulTaskkillExit: 0,
        forcedTaskkillExit: 0,
        neutralizeChildKill: false,
        forceTerminateOnGracefulTaskkill: true,
      },
    );

    await expect(invoke()).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    // The PID has been reaped. A second `/PID` call would be addressing whatever
    // inherited it, which is the one thing the Windows path must never do.
    expect(taskkillCalls).toEqual([["/PID", expect.any(String), "/T"]]);
  });
});
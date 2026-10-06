/**
 * Spec #168 / ticket #176 — the containment boundary for arbitrary managed
 * shell commands.
 *
 * A managed process GROUP is not a containment boundary. `setsid(2)` and
 * reparenting both take a descendant out of the group the runner created, and
 * no amount of post-hoc polling can prove where a process Poiesis stopped
 * tracking it. Poiesis therefore makes absolute containment CAPABILITY-BOUND for
 * the one surface that runs caller-supplied command text — Verify and Focused
 * Check — and refuses that surface before spawning when the capability is
 * absent, instead of claiming a boundary it does not have.
 *
 * The boundary is established through an ADMISSION BARRIER: the managed child is
 * a Poiesis-owned prologue that moves ITSELF into the provisioned cgroup v2
 * leaf, confirms its own kernel membership, reports that confirmation, and only
 * then `exec`s the resolved processor. No caller command text can run before
 * that confirmation, and the parent refuses the run if it never comes.
 *
 * These tests drive the real public seams:
 *   - `runManagedShellCommand` (the one Spec #168 managed command path);
 *   - `run` as a direct low-level library caller, which keeps the documented
 *     process-group contract unchanged and is NOT silently upgraded;
 *   - the pre-spawn typed refusal and the unconfirmed-admission refusal, with
 *     proof that an unconfirmed child is never reported contained.
 *
 * Tests that actually execute a strongly contained command are gated on the
 * host capability; the pure resolver, refusal, and control-flow assertions are
 * not, because those prove the fail-closed contract and must run everywhere.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveContainmentCapability, type ContainmentCapability } from "../src/containment.js";
import { runManagedShellCommand } from "../src/managed-shell.js";
import { run } from "../src/process.js";
import { describeManagedExecution } from "./helpers.js";

const fixtures: string[] = [];
const tracked = new Map<number, string | null>();
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(async () => {
  for (const [pid, startIdentity] of tracked) {
    try {
      if (startIdentity === null || startTimeOf(pid) === startIdentity) process.kill(pid, "SIGKILL");
    } catch {
      // Already terminated.
    }
  }
  tracked.clear();
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../src/containment.js");
  vi.resetModules();
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

function startTimeOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").slice(readFileSync(`/proc/${pid}/stat`, "utf8").lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function isSameProcess(pid: number, startIdentity: string | null): boolean {
  if (startIdentity !== null) return startTimeOf(pid) === startIdentity;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForPid(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // Not published yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no PID published at ${path}`);
}

async function stageDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

/**
 * The exact escape this ticket is about: the managed leader leaves a descendant
 * in its OWN session, so its own process group, and then exits, which reparents
 * the descendant away from the runner. Nothing that addresses a process group
 * can reach it afterwards.
 *
 * There is NO delay before the escape here. Under the admission barrier the
 * ordering is enforced by the prologue's own control flow — it cannot `exec` the
 * command until its membership is confirmed — so a zero-delay escape is a
 * deterministic property of the implementation rather than a race it has to win.
 * That is exactly why this is the shape worth repeating: it is the shape a
 * parent-side post-spawn write could lose.
 */
function setsidEscapeCommand(pidFile: string): string {
  return [
    `setsid sh -c 'printf "%s\\n" "$$" > ${pidFile}; exec sleep 30' >/dev/null 2>&1 &`,
    `while [ ! -s ${pidFile} ]; do sleep 0.05; done`,
    "printf contained",
    "",
  ].join("\n");
}

const HOST_CAPABILITY: ContainmentCapability = resolveContainmentCapability();

describeManagedExecution("strong containment for arbitrary managed shell commands",
  () => {
    it("contains a zero-delay setsid escape, repeatedly", { timeout: 60_000 }, async () => {
      // Repeated enough to expose a lost race without making the suite
      // unbounded. Every iteration creates its escape with no delay at all.
      for (let index = 0; index < 8; index += 1) {
        const dir = await stageDir("poiesis-containment-");
        const pidFile = join(dir, "escape.pid");
        const result = await runManagedShellCommand({
          cwd: dir,
          operationId: "poiesis-test-escape",
          command: setsidEscapeCommand(pidFile),
        });

        expect(result).toMatchObject({ exitCode: 0, stdout: "contained" });
        const escapedPid = await waitForPid(pidFile);
        const startIdentity = startTimeOf(escapedPid);
        tracked.set(escapedPid, startIdentity);
        expect(isSameProcess(escapedPid, startIdentity)).toBe(false);
      }
    });

    it("does not silently upgrade a direct low-level run() caller to strong containment", { timeout: 60_000 }, async () => {
      const dir = await stageDir("poiesis-containment-direct-");
      const pidFile = join(dir, "escape.pid");
      const script = join(dir, "escape.sh");
      await writeFile(script, `#!/bin/sh\n${setsidEscapeCommand(pidFile)}\n`, "utf8");
      await chmod(script, 0o755);

      const direct = await run(script, [], { cwd: dir, allowFailure: true });

      expect(direct.exitCode).toBe(0);
      const escapedPid = await waitForPid(pidFile);
      const startIdentity = startTimeOf(escapedPid);
      tracked.set(escapedPid, startIdentity);
      // The documented process-group contract is unchanged, and this is exactly
      // what it does NOT cover: the escaped session leader is untouched. That is
      // why arbitrary command text goes through the strong-containment seam and
      // a fixed-argv library call does not.
      expect(isSameProcess(escapedPid, startIdentity)).toBe(true);
    });

    it(
      "settles a contained run through the kernel boundary alone, never through a process-group signal", { timeout: 60_000 }, async () => {
      // The leaked descendant calls `setsid(2)`, so it leaves the managed
      // process group entirely: nothing that addresses a group can reach it.
      // Only the cgroup leaf can, which makes this the case where a redundant
      // group settlement afterwards would be pure cost — and where skipping it
      // is observable.
      const dir = await stageDir("poiesis-containment-authority-");
      const pidFile = join(dir, "escape.pid");
      const script = join(dir, "parent.sh");
      await writeFile(script, `#!/bin/sh\n${setsidEscapeCommand(pidFile)}\n`, "utf8");
      await chmod(script, 0o755);

      // Every address this runner directs at a PROCESS GROUP — a liveness probe
      // included — is a negative PID. `cgroup.kill` plus `populated 0` is the
      // authority for a contained run, so there must be none.
      const groupAddresses: Array<{ pid: number; signal: string | number | undefined }> = [];
      const deliver = process.kill.bind(process);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (pid < 0) groupAddresses.push({ pid, signal });
        return signal === 0 ? deliver(pid, 0) : deliver(pid, signal as NodeJS.Signals);
      }) as typeof process.kill);

      let result: Awaited<ReturnType<typeof runManagedShellCommand>>;
      try {
        result = await runManagedShellCommand({ cwd: dir, command: script, operationId: "poiesis-test-authority" });
      } finally {
        killSpy.mockRestore();
      }

      expect(result).toMatchObject({ exitCode: 0, stdout: "contained" });
      expect(groupAddresses).toEqual([]);
      // And the settlement was real: the escaped descendant is gone, which no
      // group signal could have achieved.
      const escapedPid = await waitForPid(pidFile);
      const startIdentity = startTimeOf(escapedPid);
      tracked.set(escapedPid, startIdentity);
      expect(isSameProcess(escapedPid, startIdentity)).toBe(false);
    },
    );

    it("still cleans a leaked descendant that stays inside the managed group", { timeout: 60_000 }, async () => {
      const dir = await stageDir("poiesis-containment-group-");
      const pidFile = join(dir, "descendant.pid");
      const script = join(dir, "parent.sh");
      // The leader waits for the descendant to publish its own PID, so the leak
      // is fully established before the run settles and the assertion is about
      // cleanup rather than about who won a scheduling race.
      await writeFile(
        script,
        [
          "#!/bin/sh",
          `sh -c 'printf "%s\\n" "$$" > ${pidFile}; sleep 30' >/dev/null 2>&1 &`,
          `while [ ! -s ${pidFile} ]; do sleep 0.05; done`,
          "printf early",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(script, 0o755);

      const result = await runManagedShellCommand({ cwd: dir, command: script });
      expect(result).toMatchObject({ exitCode: 0, stdout: "early" });
      const descendantPid = await waitForPid(pidFile);
      const startIdentity = startTimeOf(descendantPid);
      tracked.set(descendantPid, startIdentity);
      expect(isSameProcess(descendantPid, startIdentity)).toBe(false);
    });
  },
);

describeManagedExecution("command text reaches the processor verbatim, through the admission barrier",
  () => {
    /**
     * A real contained run, observed at the spawn boundary. The caller's
     * command must appear exactly once, byte-identical, as the final argv
     * element of the processor invocation the barrier hands to `exec` — and must
     * never appear inside the Poiesis-owned prologue.
     */
    it("keeps the caller command out of the prologue and byte-identical in the exec'd argv", { timeout: 60_000 }, async () => {
      const spawns: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
      vi.resetModules();
      vi.doMock("node:child_process", async () => {
        const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        return {
          ...actual,
          spawn: ((command: string, argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
            spawns.push({ command, args: argv, env: options.env });
            return Reflect.apply(actual.spawn, undefined, [command, argv, options]) as ChildProcess;
          }) as typeof actual.spawn,
        };
      });
      const dir = await stageDir("poiesis-admission-shape-");
      const marker = `printf '%s' "byte identical & < > | $HOME"`;
      try {
        const managed = await import("../src/managed-shell.js");
        await managed.runManagedShellCommand({ cwd: dir, command: marker });
      } finally {
        vi.doUnmock("node:child_process");
        vi.resetModules();
      }

      expect(spawns).toHaveLength(1);
      const [spawned] = spawns;
      // The child is the Poiesis-owned barrier, never the command itself.
      expect(spawned!.command).toBe("/bin/sh");
      expect(spawned!.args[0]).toBe("-c");
      const [prologue, argv0, processor, ...rest] = spawned!.args.slice(1);
      expect(argv0).toBe("poiesis-admission");
      expect(prologue).not.toContain(marker);
      expect(prologue).not.toContain("byte identical");
      // The leaf travels out of band: its VALUE is in the environment and
      // nowhere in the argv, so it can never reach the command as an argument.
      const leaf = spawned!.env?.POIESIS_ADMISSION_LEAF ?? "";
      expect(leaf.length).toBeGreaterThan(0);
      expect(spawned!.args.join("|")).not.toContain(leaf);
      // The processor and its argv are handed to `exec` untouched.
      expect(processor).toBe("/bin/sh");
      expect(rest).toEqual(["-c", marker]);
    });
  },
);

/**
 * Script the kernel boundary so the ADMISSION gate itself is what runs.
 *
 * Spec #168 / ticket #178: these assertions are about what the parent does with
 * an unconfirmed report, not about whether this host can contain anything — and
 * a host that cannot (Windows, macOS, an under-provisioned Linux) would refuse
 * inside `provisionContainment` before the gate is ever reached, reporting its
 * own correct answer in place of the one under test. Only provisioning,
 * settlement, and release are substituted; the report format, the confirmation
 * predicate, and the refusal itself stay the real implementation.
 */
const SCRIPTED_LEAF = "/poiesis-scripted-cgroup-leaf";

function scriptContainmentBoundary(): void {
  vi.doMock("../src/containment.js", async () => {
    const actual = await vi.importActual<typeof import("../src/containment.js")>("../src/containment.js");
    return {
      ...actual,
      provisionContainment: (input: { model: string; operationId: string }) => ({
        model: input.model,
        operationId: input.operationId,
        leaf: SCRIPTED_LEAF,
      }),
      settleContainment: async (lease: { model: string; leaf: string | null }) => ({
        model: lease.model,
        leaf: lease.leaf,
        survived: [],
        confirmed: true,
      }),
      releaseContainment: () => undefined,
    };
  });
}

describe("unconfirmed admission is refused, never silently accepted", () => {
  /**
   * Drive the public managed-command seam with a child that never reports an
   * admission — which is what a prologue that could not write, or could not
   * confirm, looks like from the parent. Both a live child and a child that has
   * already finished must be refused; "it probably made it" is not an outcome.
   */
  async function runWithUnreportingAdmission(
    mode: "live" | "finished",
  ): Promise<{ error: unknown; spawnCalls: number }> {
    const spawnCalls = { count: 0 };
    vi.resetModules();
    scriptContainmentBoundary();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((command: string, ...rest: unknown[]) => {
          const argv = (rest[0] as string[]) ?? [];
          if (command !== "/bin/sh" || !argv.includes("poiesis-admission")) {
            return Reflect.apply(actual.spawn, undefined, [command, ...rest]) as ChildProcess;
          }
          spawnCalls.count += 1;
          const fake = new EventEmitter() as ChildProcess;
          const report = new PassThrough();
          Object.assign(fake, {
            pid: 424242,
            stdin: null,
            stdout: null,
            stderr: null,
            stdio: [null, null, null, report],
            kill: () => true,
            unref: () => undefined,
          });
          queueMicrotask(() => {
            if (mode === "finished") {
              // Finished without ever reporting: the case that must not be
              // silently accepted as "probably admitted".
              report.end();
              fake.emit("exit", 0, null);
              return;
            }
            // Still live, still silent.
            setTimeout(() => report.end(), 60_000).unref?.();
          });
          return fake;
        }) as typeof actual.spawn,
      };
    });
    const managed = await import("../src/managed-shell.js");
    let error: unknown = null;
    try {
      await managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-confirmed" });
    } catch (thrown) {
      error = thrown;
    }
    return { error, spawnCalls: spawnCalls.count };
  }

  it("refuses a live child that never reports an admission", { timeout: 60_000 }, async () => {
    const observed = await runWithUnreportingAdmission("live");
    expect(observed.spawnCalls).toBe(1);
    expect(observed.error).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      exitCode: 1,
      details: { reason: "ADMISSION_UNCONFIRMED", confirmed: false },
    });
  });

  it("refuses a child that finished without ever reporting an admission", { timeout: 60_000 }, async () => {
    const observed = await runWithUnreportingAdmission("finished");
    expect(observed.error).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "ADMISSION_UNCONFIRMED", confirmed: false },
    });
    expect((observed.error as { details: { detail: string } }).details.detail).toContain(
      "finished without reporting",
    );
  });
});

describe("honest refusal when strong containment cannot be established", () => {
  /**
   * Drive the public managed-command seam with the host's cgroup v2 support
   * hidden, and record every `spawn` the seam attempts.
   */
  async function runWithCgroupSupportHidden(): Promise<{
    outcome: "resolved" | "rejected";
    spawnCalls: number;
    error: unknown;
  }> {
    const spawnCalls = { count: 0 };
    vi.resetModules();
    // Spec #168 / ticket #178: asked for explicitly. The report reads
    // `process.platform` before it reads any hierarchy, so on Windows or macOS
    // this would otherwise answer `UNSUPPORTED_PLATFORM` (or refuse in the
    // processor seam) and report THIS host instead of the missing subtree.
    Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: "linux" });
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: ((path: string, ...rest: unknown[]) => {
          if (typeof path === "string" && (path === "/proc/self/cgroup" || path.startsWith("/sys/fs/cgroup"))) {
            throw Object.assign(new Error("hidden for the test"), { code: "EACCES" });
          }
          return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
        }) as typeof actual.readFileSync,
        // Spec #168 / ticket #178: the processor is resolved before containment
        // is provisioned, so a host without `/bin/sh` would stop at the
        // processor seam and report THAT host instead of the missing subtree
        // under test. The processor's own availability is covered in
        // `tests/command-processor.test.ts`.
        accessSync: ((path: string, ...rest: unknown[]) => {
          if (path === "/bin/sh") return undefined;
          return Reflect.apply(actual.accessSync, undefined, [path, ...rest]) as void;
        }) as typeof actual.accessSync,
      };
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((...args: unknown[]) => {
          spawnCalls.count += 1;
          return Reflect.apply(actual.spawn, undefined, args) as never;
        }) as typeof actual.spawn,
      };
    });

    const managed = await import("../src/managed-shell.js");
    let error: unknown = null;
    try {
      await managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-run" });
    } catch (thrown) {
      error = thrown;
    }
    return { outcome: error === null ? "resolved" : "rejected", spawnCalls: spawnCalls.count, error };
  }

  it("refuses before spawning with an actionable PROCESS_CONTAINMENT_UNAVAILABLE", { timeout: 60_000 }, async () => {
    const observed = await runWithCgroupSupportHidden();
    expect(observed.outcome).toBe("rejected");
    expect(observed.error).toMatchObject({
      code: "PROCESS_CONTAINMENT_UNAVAILABLE",
      details: { containment: "cgroup-v2", reason: "NO_CGROUP_V2" },
    });
    // Nothing was created, so nothing can leak: the refusal precedes the spawn.
    expect(observed.spawnCalls).toBe(0);
  });

  it("never claims containment on a platform with no portable strong model", { timeout: 60_000 }, async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: "win32" });
    const containment = await import("../src/containment.js");
    const capability = containment.resolveContainmentCapability();

    expect(capability).toMatchObject({
      model: "cgroup-v2",
      available: false,
      platform: "win32",
      reason: "UNSUPPORTED_PLATFORM",
    });
    expect(capability.detail).toContain("Job Object");
  });
});

describe("containment capability report", () => {
  it("is internally consistent: available exactly when no reason is reported", () => {
    const capability = resolveContainmentCapability();
    expect(capability.available).toBe(capability.reason === null);
    expect(capability.model).toBe("cgroup-v2");
  });

  it("reports the unmanaged process-group model as a model that is not strong containment", () => {
    // The group model is what direct library callers keep; it is deliberately
    // NOT the strong model, and saying so on every host is the point.
    const capability = resolveContainmentCapability("process-group");
    expect(capability).toMatchObject({ model: "process-group", available: false, reason: "NOT_STRONG_CONTAINMENT" });
    expect(capability.detail).toContain("setsid");
  });
});
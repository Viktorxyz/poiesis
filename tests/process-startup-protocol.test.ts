/**
 * Spec #168 / ticket #182 — the localized TWO-PHASE contained startup protocol.
 *
 * The single-phase admission barrier could not answer one question the parent has
 * to answer before it may touch anything: "is the process I just spawned the
 * process whose kernel identity this run leased?" The old prologue admitted
 * itself and `exec`'d the caller text in one step, so the parent learned only
 * that SOMETHING confirmed a membership — the lease cleanup needed was still
 * created straight from `child.pid`, and a refusal could still reach for
 * `child.kill`, a raw PID signal on a child whose identity was never confirmed.
 *
 * The protocol is now strictly two-phase, and every authority is earned before it
 * is used:
 *
 *   1. the Poiesis-owned prologue reports its own kernel PID, process-group id,
 *      and process-start identity, and WAITS;
 *   2. the parent checks the report against `child.pid` AND against a fresh
 *      kernel read, establishes a live validated lease, and only then sends the
 *      admission token;
 *   3. the prologue admits ITSELF into the provisioned leaf, confirms that
 *      membership is bound to the SAME identity it reported, reports that, and
 *      waits for a DISTINCT execution token;
 *   4. only then does the parent release the exact processor argv, and only then
 *      do stdin, the command timeout, and cancellation arm.
 *
 * The properties these tests pin:
 *
 *   - no caller command text, no leaf path, and no token is ever in the
 *     prologue's argv, and none of them survives into the exec'd process;
 *   - the caller's argv arrives byte-identical, including the empty string and a
 *     trailing newline;
 *   - identity disagreement, PID reuse, a missing report, a malformed report, and
 *     a delayed report all REFUSE, and none of them releases caller text or
 *     signals a PID;
 *   - cleanup authority follows the phase: before a validated lease the gate is
 *     revoked, the leaf is settled, and a LINKED child exit is required (no PID
 *     signal at all); after a validated lease the group and the leaf are settled
 *     independently; after a confirmed admission the cgroup is authoritative and
 *     the group is skipped;
 *   - cancellation at either gate revokes the control channel and cleans
 *     boundedly; after the release the ordinary contained path applies.
 *
 * The control-flow cases script the child and the kernel boundary through
 * `tests/startup-harness.ts`, so they run on EVERY host including the ones that
 * cannot contain anything; the real cases are gated on this host's capability
 * because they prove the shell protocol itself.
 */
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMISSION_ARGV0,
  ADMISSION_LEAF_ENV,
  ADMISSION_TOKEN_ENV,
  EXECUTION_TOKEN_ENV,
  STARTUP_ENVIRONMENT_KEYS,
  formatStartupReport,
} from "../src/containment.js";
import { describeManagedExecution } from "./helpers.js";
import {
  exitOnGate,
  FAKE_LEAF,
  FAKE_PGID,
  FAKE_PID,
  mockContainmentBoundary,
  newBoundary,
  REUSED_START,
  scriptStartupChild,
  scriptedIdentity,
  startupExit,
  type BoundaryProbe,
  type ScriptedStartup,
} from "./startup-harness.js";

/** Every scripted gate stays far inside this. */
const BOUND_MS = 30_000;

const fixtures: string[] = [];

afterEach(async () => {
  vi.doUnmock("../src/containment.js");
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.resetModules();
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

async function stageDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

/**
 * Await a run's outcome under a bound, then let the scripted channels deliver
 * what the runner wrote before the test inspects it.
 */
async function settleWithin(
  invocation: Promise<unknown>,
  boundMs: number,
): Promise<{ settled: false } | { settled: true; error: unknown; elapsedMs: number }> {
  let timer: NodeJS.Timeout | null = null;
  const startedAt = Date.now();
  const stillPending = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), boundMs);
  });
  try {
    const outcome = await Promise.race([
      invocation.then(
        () => ({ settled: true, error: null, elapsedMs: Date.now() - startedAt }),
        (error: unknown) => ({ settled: true, error, elapsedMs: Date.now() - startedAt }),
      ),
      stillPending,
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return outcome;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function rejectionOf(outcome: { settled: boolean; error?: unknown }): unknown {
  expect(outcome).toMatchObject({ settled: true });
  const error = outcome.error;
  expect(error).toBeInstanceOf(Error);
  return error;
}

/** Drive the contained seam and return its bounded outcome. */
async function driveContained(
  command = "printf never-runs",
): Promise<{ settled: boolean; error?: unknown; elapsedMs?: number }> {
  // The module under test must be loaded fresh so this test's mocks apply to it.
  vi.resetModules();
  const { run: containedRun } = await import("../src/process.js");
  return await settleWithin(
    containedRun("/bin/sh", ["-c", command], {
      cwd: tmpdir(),
      containment: "cgroup-v2",
      operationId: "poiesis-startup-protocol",
    }),
    BOUND_MS,
  );
}

describeManagedExecution("the real two-phase contained startup protocol", () => {
  it("delivers the caller's argv byte-identical, including the empty string and a trailing newline", { timeout: 60_000 }, async () => {
    const dir = await stageDir("poiesis-startup-argv-");
    // Every element is printed between explicit delimiters, `$0` included, so a
    // single lost, truncated, reordered, or shifted element is visible in the
    // evidence itself — including the empty string, which is the element a
    // line-framed transport most easily drops.
    const args = ["", "trailing-newline\n", "tab\tand \\backslash\\ and $(id)", "  spaced  ", "marker"];
    const script = 'printf "[%s]" "$0" "$@"';

    const { run } = await import("../src/process.js");
    const result = await run("/bin/sh", ["-c", script, ...args], {
      cwd: dir,
      containment: "cgroup-v2",
      operationId: "poiesis-startup-argv",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(args.map((element) => `[${element}]`).join(""));
    // And what the runner reports is still the caller's argv, not the prologue's.
    expect(result.command).toBe("/bin/sh");
    expect(result.args).toEqual(["-c", script, ...args]);
  });

it("scrubs every Poiesis-owned startup variable before exec", { timeout: 60_000 }, async () => {
    const dir = await stageDir("poiesis-startup-scrub-");
    // The leaf, both tokens, and the gate channel must not reach the caller's
    // process: they are Poiesis's internal boundary, not the command's context.
    // The search names every variable the protocol introduced, so adding a fourth
    // internal name later cannot quietly escape the check.
    const names = STARTUP_ENVIRONMENT_KEYS.map((key) => `^${key}=`).join("|");
    const { run } = await import("../src/process.js");
    const result = await run("/bin/sh", ["-c", `env | grep -E '${names}' || :`], {
      cwd: dir,
      containment: "cgroup-v2",
      operationId: "poiesis-startup-scrub",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("never places the caller's text, the leaf, or a token in the prologue's argv", { timeout: 60_000 }, async () => {
    const spawns: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
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
    const dir = await stageDir("poiesis-startup-shape-");
    const marker = `printf '%s' "byte identical & < > | $HOME"`;
    try {
      // The module under test must be loaded fresh so this test's mocks apply to it.
      vi.resetModules();
      const { run } = await import("../src/process.js");
      await run("/bin/sh", ["-c", marker], { cwd: dir, containment: "cgroup-v2", operationId: "poiesis-startup-shape" });
    } catch {
      // The spawn shape is the subject; a refusal on a scripted host is fine.
    }

    expect(spawns).toHaveLength(1);
    const [spawned] = spawns;
    expect(spawned!.command).toBe("/bin/sh");
    expect(spawned!.args[0]).toBe("-c");
    expect(spawned!.args[2]).toBe(ADMISSION_ARGV0);
    // The prologue is Poiesis-owned text: it carries no caller command, and the
    // caller text is not handed to it as an argument either.
    expect(spawned!.args[1]).not.toContain(marker);
    expect(spawned!.args.slice(3)).toEqual([]);
    // The leaf and BOTH tokens travel out of band, so no boundary value can
    // appear in the caller's own argv.
    const leaf = spawned!.env?.[ADMISSION_LEAF_ENV] ?? "";
    const admissionToken = spawned!.env?.[ADMISSION_TOKEN_ENV] ?? "";
    const executionToken = spawned!.env?.[EXECUTION_TOKEN_ENV] ?? "";
    expect(leaf.length).toBeGreaterThan(0);
    expect(admissionToken.length).toBeGreaterThan(0);
    expect(executionToken.length).toBeGreaterThan(0);
    // Distinct by construction, or "a distinct execution token" is a claim.
    expect(executionToken).not.toBe(admissionToken);
    expect(spawned!.args.join("|")).not.toContain(leaf);
    expect(spawned!.args.join("|")).not.toContain(admissionToken);
    expect(spawned!.args.join("|")).not.toContain(executionToken);
  });
});

describe("a contained startup refuses before it releases any caller text", () => {
  it("refuses a report that names a PID other than the child, without sending a token or signalling it", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const startup = scriptStartupChild({ report: scriptedIdentity({ pid: FAKE_PGID + 1 }) });
    exitOnGate(startup);

    const outcome = await driveContained();

    expect(rejectionOf(outcome)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "STARTUP_IDENTITY_UNCONFIRMED", confirmed: false },
    });
    expect(startup.gateLines).toEqual([]);
    expect(startup.releaseLines).toEqual([]);
    expect(startup.kills).toEqual([]);
    expect(boundary.settled).toEqual([FAKE_LEAF]);
  });

  it("refuses a report that disagrees with a fresh kernel identity read", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    // The report is well-formed and names the right PID; its START IDENTITY is not
    // the identity the kernel has at that PID right now.
    const startup = scriptStartupChild({ report: scriptedIdentity({ startIdentity: "999999999" }) });
    exitOnGate(startup);

    const outcome = await driveContained();

    expect(rejectionOf(outcome)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "STARTUP_IDENTITY_UNCONFIRMED" },
    });
    expect(startup.gateLines).toEqual([]);
    expect(startup.releaseLines).toEqual([]);
    expect(startup.kills).toEqual([]);
  });

  it("refuses a PID whose identity changed between the report and the validation, never releasing text", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const startup = scriptStartupChild({ report: scriptedIdentity() });
    exitOnGate(startup);
    // The kernel moves the PID to a different process between the prologue's
    // report and the parent's own read — the reuse window a lease exists for.
    startup.kernel.startIdentity = REUSED_START;

    const outcome = await driveContained();

    expect(rejectionOf(outcome)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "STARTUP_IDENTITY_UNCONFIRMED" },
    });
    expect(startup.gateLines).toEqual([]);
    expect(startup.releaseLines).toEqual([]);
    expect(startup.kills).toEqual([]);
  });

  it("refuses a malformed report rather than parsing around it", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const startup = scriptStartupChild();
    startup.report.write("I not-a-pid 424242 100000001\n");
    startup.report.write("totally-unexpected\n");
    exitOnGate(startup);

    const outcome = await driveContained();

    expect(rejectionOf(outcome)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "STARTUP_IDENTITY_UNCONFIRMED" },
    });
    expect(startup.gateLines).toEqual([]);
    expect(startup.kills).toEqual([]);
  });

  it("refuses a child that never reports, within a bound", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const startup = scriptStartupChild({ report: null });
    exitOnGate(startup);

    const outcome = await driveContained();

    expect(rejectionOf(outcome)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "STARTUP_IDENTITY_UNCONFIRMED" },
    });
    expect((outcome as { elapsedMs: number }).elapsedMs).toBeLessThan(BOUND_MS);
    expect(startup.gateLines).toEqual([]);
    expect(startup.kills).toEqual([]);
  });
});

describe("cleanup authority follows the phase the startup reached", () => {
  it("before a validated lease: settles the leaf and requires a linked child exit, with no PID signal", { timeout: 60_000 }, async () => {
    const boundary = newBoundary({ populated: false });
    mockContainmentBoundary(boundary);
    // The leaf is empty because the child never admitted itself — the
    // initial-empty race. That proves nothing about a leader still outside it, so
    // the only proof that will do is the child's OWN exit.
    const startup = scriptStartupChild({ report: null });
    exitOnGate(startup);

    const outcome = await driveContained();

    expect(rejectionOf(outcome)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "STARTUP_IDENTITY_UNCONFIRMED" },
    });
    // An empty leaf is not killed — there is nothing in it — and the boundary is
    // still settled before it is released.
    expect(boundary.cgroupKills).toBe(0);
    expect(boundary.order).toEqual(["provision", "settle-leaf", "release"]);
    // The linked exit is the proof, and it arrived. Nothing was signalled to get it.
    expect(startup.gateClosed).toBe(true);
    expect(startup.kills).toEqual([]);
  });

  it("before a validated lease: an empty leaf plus no linked exit is PROCESS_CLEANUP_UNRESOLVED with the startup error as context", { timeout: 60_000 }, async () => {
    const boundary = newBoundary({ populated: false });
    mockContainmentBoundary(boundary);
    // The child is live and silent: nothing may signal it (no lease exists), and
    // nothing can prove it stopped, so the run must say so rather than report a
    // settled refusal.
    const startup = scriptStartupChild({ report: null });

    const outcome = await driveContained();

    const error = rejectionOf(outcome);
    expect(error).toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { reason: "STARTUP_EXIT_UNCONFIRMED", confirmed: false, signalsSent: [] },
    });
    // The startup refusal travels with it as bounded context, so an operator
    // learns both facts and neither hides the other.
    expect((error as { details: Record<string, unknown> }).details.containmentRefusal).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      reason: "STARTUP_IDENTITY_UNCONFIRMED",
    });
    expect(boundary.cgroupKills).toBe(0);
    expect(startup.kills).toEqual([]);
  });

  it("after a validated lease: settles the group AND the leaf independently", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    // The identity report validates and the lease is live, but no admitted report
    // arrives: the child may be inside the leaf or still outside it, so neither
    // boundary can stand in for the other.
    const startup = scriptStartupChild({ report: scriptedIdentity(), admitted: null });
    exitOnGate(startup);
    const groupSignals: number[] = [];
    const groupProbes: number[] = [];
    const deliver = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) (signal === 0 ? groupProbes : groupSignals).push(pid);
      return signal === 0 ? deliver(pid, 0) : deliver(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    let observed: Awaited<ReturnType<typeof driveContained>>;
    try {
      observed = await driveContained();
    } finally {
      killSpy.mockRestore();
    }

    expect(rejectionOf(observed)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "ADMISSION_UNCONFIRMED" },
    });
    // The admission token WAS sent: the lease existed, which is what makes a
    // group settlement legitimate here.
    expect(startup.gateLines[0]?.startsWith("A ")).toBe(true);
    expect(startup.releaseLines).toEqual([]);
    expect(boundary.settled).toEqual([FAKE_LEAF]);
    expect(boundary.cgroupKills).toBe(1);
    // A liveness probe is what a settlement starts with; a SIGNAL is not. The
    // scripted group does not exist, so the lease found nothing to signal and
    // stopped — a number no live leader owns is never escalated.
    expect(groupSignals).toEqual([]);
    expect(groupProbes).toEqual([-FAKE_PGID]);
    expect(startup.kills).toEqual([]);
  });

  it("after a confirmed admission: the cgroup is the authority and the group is skipped", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    // The released run finishes: the prologue `exec`s and the command exits 0.
    const startup = scriptStartupChild({
      report: scriptedIdentity(),
      admitted: scriptedIdentity(),
      onGate: (line) => {
        if (line.startsWith("E ")) setImmediate(() => startupExit(startup));
      },
    });
    const groupSignals: number[] = [];
    const groupProbes: number[] = [];
    const deliver = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) (signal === 0 ? groupProbes : groupSignals).push(pid);
      return signal === 0 ? deliver(pid, 0) : deliver(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

    // The module under test must be loaded fresh so this test's mocks apply to it.
    vi.resetModules();
    const { run: containedRun } = await import("../src/process.js");
    const outcome = await settleWithin(
      containedRun("/bin/sh", ["-c", "printf released"], {
        cwd: tmpdir(),
        containment: "cgroup-v2",
        operationId: "poiesis-startup-admitted",
      }),
      BOUND_MS,
    );
    killSpy.mockRestore();

    expect(outcome).toMatchObject({ settled: true });
    expect((outcome as { error: unknown }).error).toBe(null);
    // Both tokens, in order, and only then the released argv.
    expect(startup.gateLines).toHaveLength(2);
    expect(startup.gateLines[0]?.startsWith("A ")).toBe(true);
    expect(startup.gateLines[1]?.startsWith("E ")).toBe(true);
    expect(startup.gateLines[0]?.slice(2)).not.toBe(startup.gateLines[1]?.slice(2));
    expect(startup.releaseLines[0]).toBe("3");
    expect(startup.releaseLines).toHaveLength(4);
    expect(groupSignals).toEqual([]);
    expect(groupProbes).toEqual([]);
    expect(boundary.cgroupKills).toBe(1);
  });

  it("refuses an admitted report whose identity is not the one that was leased", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    // The admission is real — the child is in the leaf — but the confirmation it
    // reports is bound to a different identity than the one the parent leased.
    const startup = scriptStartupChild({
      report: scriptedIdentity(),
      admitted: scriptedIdentity({ startIdentity: REUSED_START }),
    });
    exitOnGate(startup);

    const outcome = await driveContained();

    expect(rejectionOf(outcome)).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "ADMISSION_UNCONFIRMED" },
    });
    expect(startup.releaseLines).toEqual([]);
    expect(startup.kills).toEqual([]);
    expect(boundary.settled).toEqual([FAKE_LEAF]);
  });

  it("never signals a group whose leader changed identity after the lease", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const startup = scriptStartupChild({
      report: scriptedIdentity(),
      admitted: null,
      // The lease is live once the admission token is written, and the kernel
      // moves the PID to a different process at that same moment: the group id is
      // still the number the lease names, but it now belongs to something Poiesis
      // never spawned.
      onGate: () => {
        startup.kernel.startIdentity = REUSED_START;
      },
    });
    const groupSignals: number[] = [];
    const deliver = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      // Every negative PID is a group address; only a real signal is a target.
      if (pid < 0 && signal !== 0) groupSignals.push(pid);
      return signal === 0 ? deliver(pid, 0) : deliver(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    let observed: Awaited<ReturnType<typeof driveContained>>;
    try {
      observed = await driveContained();
    } finally {
      killSpy.mockRestore();
    }

    // The settlement refuses before it addresses anything at all, and the
    // refusal outranks the startup refusal that started the sequence.
    expect(rejectionOf(observed)).toMatchObject({
      code: "PROCESS_CLEANUP_REFUSED",
      details: { reason: "PID_REUSE", pid: FAKE_PID, processGroupId: FAKE_PGID },
    });
    // The decoy is never signalled: the lease re-confirms the leader before it
    // addresses anything, and a mismatch stops the sequence where it is.
    expect(groupSignals).toEqual([]);
    expect(startup.releaseLines).toEqual([]);
    expect(startup.kills).toEqual([]);
  });

  it("accepts an admitted report delivered after the child exit event", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const startup = scriptStartupChild({ report: scriptedIdentity() });
    // Node can deliver `exit` before the report line written just before it has
    // been read off the pipe. The bounded drain is what keeps a real admission
    // from being reported as an unconfirmed one — and the release follows it, so
    // the run reports the same settled outcome either way.
    startup.report.on("data", () => {
      setTimeout(() => {
        startup.child.emit("exit", 0, null);
        setTimeout(() => startup.report.write(`${formatStartupReport("admitted", scriptedIdentity())}\n`), 20);
      }, 0);
    });

    // The module under test must be loaded fresh so this test's mocks apply to it.
    vi.resetModules();
    const { run: containedRun } = await import("../src/process.js");
    const late = await settleWithin(
      containedRun("/bin/sh", ["-c", "printf late-admission"], {
        cwd: tmpdir(),
        containment: "cgroup-v2",
        operationId: "poiesis-startup-late",
      }),
      BOUND_MS,
    );

    expect((late as { error: unknown }).error).toBe(null);
    // Both tokens were sent and the argv released: the drain decided the
    // admission, not the ordering.
    expect(startup.gateLines).toHaveLength(2);
    expect(startup.releaseLines.length).toBeGreaterThan(1);
    expect(boundary.settled).toEqual([FAKE_LEAF]);
  });
});

describe("cancellation at either gate revokes the control channel and cleans boundedly", () => {
  it("revokes and cleans when the caller cancels during the identity gate", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const controller = new AbortController();
    // The abort lands one turn after the spawn, while the identity gate is still
    // waiting: the boundary is provisioned, the prologue is live, and no verdict
    // exists yet.
    const startup = scriptStartupChild({ onSpawn: () => controller.abort() });
    exitOnGate(startup);

    // The module under test must be loaded fresh so this test's mocks apply to it.
    vi.resetModules();
    const { run: containedRun } = await import("../src/process.js");
    const outcome = await settleWithin(
      containedRun("/bin/sh", ["-c", "printf must-not-run"], {
        cwd: tmpdir(),
        containment: "cgroup-v2",
        operationId: "poiesis-startup-cancel-identity",
        signal: controller.signal,
      }),
      BOUND_MS,
    );

    expect(rejectionOf(outcome)).toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
    // The gate was revoked rather than left for the child to wait on, and no
    // caller text was ever released.
    expect(startup.gateClosed).toBe(true);
    expect(startup.gateLines).toEqual([]);
    expect(startup.releaseLines).toEqual([]);
    expect(startup.kills).toEqual([]);
    expect(boundary.settled).toEqual([FAKE_LEAF]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("revokes and cleans when the caller cancels at the admission gate, after the lease exists", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const controller = new AbortController();
    const startup = scriptStartupChild({
      report: scriptedIdentity(),
      admitted: null,
      // The abort lands when the admission token is written, which is after the
      // identity was validated and the lease established, and while the admitted
      // report is still outstanding.
      onGate: () => controller.abort(),
    });
    exitOnGate(startup);

    // The module under test must be loaded fresh so this test's mocks apply to it.
    vi.resetModules();
    const { run: containedRun } = await import("../src/process.js");
    const outcome = await settleWithin(
      containedRun("/bin/sh", ["-c", "printf must-not-run"], {
        cwd: tmpdir(),
        containment: "cgroup-v2",
        operationId: "poiesis-startup-cancel-admission",
        signal: controller.signal,
      }),
      BOUND_MS,
    );

    expect(rejectionOf(outcome)).toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
    expect(startup.gateLines[0]?.startsWith("A ")).toBe(true);
    expect(startup.releaseLines).toEqual([]);
    expect(startup.kills).toEqual([]);
    expect(boundary.settled).toEqual([FAKE_LEAF]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("honours a cancellation after the release with the cgroup as the authority", { timeout: 60_000 }, async () => {
    const boundary = newBoundary();
    mockContainmentBoundary(boundary);
    const controller = new AbortController();
    // The released run is a long-lived command: it stays live after the release,
    // so the cancellation is what has to stop it.
    const startup = scriptStartupChild({
      report: scriptedIdentity(),
      admitted: scriptedIdentity(),
      onGate: (line) => {
        if (line.startsWith("E ")) {
          setImmediate(() => controller.abort());
          setTimeout(() => startupExit(startup), 200);
        }
      },
    });

    // The module under test must be loaded fresh so this test's mocks apply to it.
    vi.resetModules();
    const { run: containedRun } = await import("../src/process.js");
    const outcome = await settleWithin(
      containedRun("/bin/sh", ["-c", "sleep 30"], {
        cwd: tmpdir(),
        containment: "cgroup-v2",
        operationId: "poiesis-startup-cancel-release",
        signal: controller.signal,
        timeoutMs: 60_000,
      }),
      BOUND_MS,
    );

    // The cancellation reached a released, admitted run, so it takes the ordinary
    // contained path: cgroup settlement, no group signal.
    expect(rejectionOf(outcome)).toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
    expect(startup.gateLines).toHaveLength(2);
    expect(boundary.cgroupKills).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("uncontained and Windows paths are untouched by the startup protocol", () => {
  it("spawns a direct uncontained caller as the command itself, with no prologue and no gate", { timeout: 60_000 }, async () => {
    const spawns: { command: string; args: string[]; stdio: unknown[] }[] = [];
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((command: string, argv: string[], options: { stdio?: unknown[] }) => {
          spawns.push({ command, args: argv, stdio: options.stdio ?? [] });
          return Reflect.apply(actual.spawn, undefined, [command, argv, options]) as ChildProcess;
        }) as typeof actual.spawn,
      };
    });
    const dir = await stageDir("poiesis-startup-direct-");
    // The module under test must be loaded fresh so this test's mocks apply to it.
    vi.resetModules();
    const { run: directRun } = await import("../src/process.js");

    const result = await directRun("/bin/sh", ["-c", 'printf "%s" "$1"', "sh", "byte identical"], {
      cwd: dir,
      operationId: "poiesis-startup-direct",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("byte identical");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe("/bin/sh");
    expect(spawns[0]!.args).toEqual(["-c", 'printf "%s" "$1"', "sh", "byte identical"]);
    // Three stdio entries and nothing else: the documented process-group
    // contract, unchanged.
    expect(spawns[0]!.stdio).toHaveLength(3);
  });

  it("never arms the startup protocol on a platform that reports Windows", { timeout: 60_000 }, async () => {
    const spawns: { command: string; stdio: unknown[] }[] = [];
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((command: string, argv: string[], options: { stdio?: unknown[] }) => {
          spawns.push({ command, stdio: options.stdio ?? [] });
          return Reflect.apply(actual.spawn, undefined, [command, argv, options]) as ChildProcess;
        }) as typeof actual.spawn,
      };
    });
    const dir = await stageDir("poiesis-startup-windows-");
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      // The module under test must be loaded fresh so this test's mocks apply to it.
      vi.resetModules();
      const { run: windowsRun } = await import("../src/process.js");
      await windowsRun("/bin/sh", ["-c", "printf windows"], { cwd: dir, allowFailure: true });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe("/bin/sh");
    expect(spawns[0]!.stdio).toHaveLength(3);
  });
});
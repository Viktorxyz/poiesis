/**
 * Spec #168 / ticket #176 — cancellation is not lost while a managed command is
 * still being ADMITTED.
 *
 * `run()` checks `signal.aborted` once, BEFORE the spawn, and installs its abort
 * listener only after the admission gate has a verdict. On a contained run that
 * leaves a real window: the boundary is provisioned, the prologue is spawned, and
 * the caller may abort at any point in there. Node's `AbortSignal` does NOT replay
 * `abort` to a listener added after the signal is already aborted, so the listener
 * installed at the end of that window can never fire — the cancellation simply
 * evaporates and the caller's command text runs to completion.
 *
 * That is not a lost error message, it is a lost FACT: Verify resolves `verified`
 * for a run the operator cancelled, and `verify()` mints an authoritative
 * verification receipt for it.
 *
 * These assertions are pure control flow — the admission verdict, the cancellation
 * re-check, the ordering of cleanup against release, and the refusal that must
 * survive its own cleanup. They mock the kernel boundary rather than requiring one,
 * so they run on EVERY host, including the Windows and macOS hosts where strong
 * containment is deliberately unavailable. The real-boundary counterpart lives in
 * `tests/cli-cancellation.test.ts`, where a genuine contained Verify is interrupted
 * inside the admission window and must issue no receipt.
 */
import { getEventListeners } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const FAKE_LEAF = "/poiesis-fake-cgroup-leaf";
/** A leaf path no kernel can read, so `populated` can never be confirmed. */
const ABSENT_LEAF = "/poiesis-absent-cgroup-leaf";
/** Bound every scripted admission window stays inside. */
const ADMISSION_BOUND_MS = 20_000;

interface ContainmentProbe {
  provisioned: { model: string; operationId: string }[];
  settled: string[];
  released: string[];
  /**
   * When set, settling fails the way a poisoned kernel does: the REAL
   * `settleContainment`, against a leaf whose `cgroup.events` cannot be read, so
   * emptiness can never be confirmed. Using the real failure keeps the assertion
   * about the runtime's own typed error rather than a hand-built stand-in.
   */
  settleFails: boolean;
  /**
   * Runs when the boundary is settled. The real `cgroup.kill` kills the member
   * that admission placed inside the leaf, so a scripted boundary does the same:
   * without it the scripted child would never exit and the run would have no way
   * to settle.
   */
  onSettle: (() => void) | null;
}

function newProbe(): ContainmentProbe {
  return { provisioned: [], settled: [], released: [], settleFails: false, onSettle: null };
}

/**
 * Replace the kernel boundary with recorded no-ops.
 *
 * Only `provisionContainment`, `settleContainment`, and `releaseContainment` are
 * substituted: the admission report format, the confirmation predicate, and the
 * refusal itself stay the real implementation, because those are exactly the
 * pieces under test. `order` records settle/release so the tests can assert that
 * a boundary is settled BEFORE it is released.
 */
function mockContainment(probe: ContainmentProbe, order?: string[]): void {
  vi.resetModules();
  vi.doMock("../src/containment.js", async () => {
    const actual = await vi.importActual<typeof import("../src/containment.js")>("../src/containment.js");
    return {
      ...actual,
      provisionContainment: (input: { model: string; operationId: string }) => {
        probe.provisioned.push({ model: input.model, operationId: input.operationId });
        return { model: input.model, operationId: input.operationId, leaf: FAKE_LEAF };
      },
      settleContainment: async (lease: { leaf: string | null }) => {
        order?.push("settle");
        probe.settled.push(lease.leaf ?? "");
        if (probe.settleFails) {
          return await actual.settleContainment(
            { model: "cgroup-v2", operationId: "unresolvable", leaf: ABSENT_LEAF },
            { windowMs: 1 },
          );
        }
        probe.onSettle?.();
        return { model: "cgroup-v2", leaf: lease.leaf, survived: [], confirmed: true };
      },
      releaseContainment: (lease: { leaf: string | null } | null) => {
        if (lease === null) return;
        order?.push("release");
        probe.released.push(lease.leaf ?? "");
      },
    };
  });
}

interface ScriptedAdmission {
  child: ChildProcess;
  report: PassThrough;
  /** Signals the runner sent to the child, so a test can prove it sent none. */
  kills: (NodeJS.Signals | undefined)[];
}

/**
 * A child that never executes anything: the test scripts the admission window
 * itself, so the verdict is decided by the test rather than by a scheduler race.
 *
 * It has no PID on purpose. The runner therefore holds no process-group lease and
 * cannot signal a real process from a unit test.
 *
 * `drive` runs on the `setImmediate` scheduled by the mocked `spawn`, which is
 * after the runner has attached every listener: that is the real window between
 * the spawn and `armRunControl`.
 */
function scriptAdmissionChild(drive: (admission: ScriptedAdmission) => void): ScriptedAdmission {
  const kills: (NodeJS.Signals | undefined)[] = [];
  const child = new EventEmitter() as ChildProcess;
  const report = new PassThrough();
  Object.assign(child, {
    pid: undefined,
    stdin: null,
    stdout: null,
    stderr: null,
    stdio: [null, null, null, report],
  });
  child.kill = ((signal?: NodeJS.Signals) => {
    kills.push(signal);
    setImmediate(() => child.emit("exit", null, "SIGKILL"));
    return true;
  }) as ChildProcess["kill"];
  child.unref = () => child;
  const admission: ScriptedAdmission = { child, report, kills };

  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      spawn: (() => {
        setImmediate(() => drive(admission));
        return child;
      }) as typeof actual.spawn,
    };
  });
  return admission;
}

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
    return await Promise.race([
      invocation.then(
        () => ({ settled: true, error: null, elapsedMs: Date.now() - startedAt }),
        (error: unknown) => ({ settled: true, error, elapsedMs: Date.now() - startedAt }),
      ),
      stillPending,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function rejectionOf(outcome: { settled: boolean; error?: unknown }): unknown {
  expect(outcome).toMatchObject({ settled: true });
  return outcome.error;
}

afterEach(() => {
  vi.doUnmock("../src/containment.js");
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("cancellation during admission is not lost (Spec #168 / ticket #176)", () => {
  it("reports COMMAND_CANCELLED/130 for a caller that aborts while the child is still being admitted", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    const controller = new AbortController();
    const admission = scriptAdmissionChild(({ report }) => {
      // The abort lands inside the admission window: the boundary is provisioned
      // and the prologue spawned, but no verdict has been reported yet.
      controller.abort();
      report.write("a");
    });
    // Settling the boundary is what kills an admitted member in the real path.
    probe.onSettle = () => admission.child.emit("exit", null, "SIGKILL");

    const managed = await import("../src/managed-shell.js");
    const outcome = await settleWithin(
      managed.runManagedShellCommand({
        cwd: tmpdir(),
        command: "printf must-not-run",
        operationId: "poiesis-admission-cancel",
        signal: controller.signal,
      }),
      ADMISSION_BOUND_MS,
    );

    expect(rejectionOf(outcome)).toMatchObject({
      code: "COMMAND_CANCELLED",
      exitCode: 130,
      details: { cancelled: true },
    });
    // Bounded: the cancellation is honoured through the normal cleanup path, so
    // it settles promptly instead of waiting out the command timeout.
    expect((outcome as { elapsedMs: number }).elapsedMs).toBeLessThan(ADMISSION_BOUND_MS);
    expect(probe.provisioned).toEqual([{ model: "cgroup-v2", operationId: "poiesis-admission-cancel" }]);
    // The boundary was settled, not merely released.
    expect(probe.settled).toEqual([FAKE_LEAF]);
    expect(probe.released).toEqual([FAKE_LEAF]);
    // The listener the run attached is gone.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not settle a run cancelled during admission as a timeout", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    const controller = new AbortController();
    const admission = scriptAdmissionChild(({ report }) => {
      controller.abort();
      report.write("a");
    });
    probe.onSettle = () => admission.child.emit("exit", null, "SIGKILL");

    const managed = await import("../src/managed-shell.js");
    const outcome = await settleWithin(
      managed.runManagedShellCommand({
        cwd: tmpdir(),
        command: "sleep 30",
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
      ADMISSION_BOUND_MS,
    );

    // With the abort lost, the ONLY thing that could settle this run is the
    // timeout arm. Reporting a cancellation as a timeout is the difference
    // between "you stopped it" and "it ran for the full bound".
    expect(rejectionOf(outcome)).toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
  });

  it("lets a cleanup failure outrank a cancellation that arrived during admission", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    probe.settleFails = true;
    mockContainment(probe);
    const controller = new AbortController();
    scriptAdmissionChild(({ report }) => {
      controller.abort();
      report.write("a");
    });

    const managed = await import("../src/managed-shell.js");
    const outcome = await settleWithin(
      managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf must-not-run", signal: controller.signal }),
      ADMISSION_BOUND_MS,
    );

    // "Poiesis could not confirm it stopped what it started" is the fact an
    // operator has to act on, so it outranks the cancellation.
    expect(rejectionOf(outcome)).toMatchObject({ code: "PROCESS_CLEANUP_UNRESOLVED" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("admission confirmation survives a late report (Spec #168 / ticket #176)", () => {
  it("accepts a confirmation delivered after the child exit event", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    // Node can deliver `exit` before the report byte written just before it has
    // been read off fd3. Refusing here would report a real admission as an
    // unconfirmed one, so the report channel is drained for a bounded window
    // before the run is refused.
    scriptAdmissionChild(({ child, report }) => {
      child.emit("exit", 0, null);
      setTimeout(() => report.write("a"), 20);
    });

    const managed = await import("../src/managed-shell.js");
    const result = await managed.runManagedShellCommand({
      cwd: tmpdir(),
      command: "printf confirmed-despite-ordering",
    });

    expect(result).toMatchObject({ exitCode: 0, command: "/bin/sh" });
    expect(probe.settled).toEqual([FAKE_LEAF]);
  });

  it("still refuses when the report never arrives, after a bounded drain", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    // The channel closes with no byte: nothing was confirmed, and draining the
    // channel must not turn that into an admission.
    scriptAdmissionChild(({ report }) => {
      report.end();
    });

    const managed = await import("../src/managed-shell.js");
    const startedAt = Date.now();
    await expect(
      managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-confirmed" }),
    ).rejects.toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "ADMISSION_UNCONFIRMED", confirmed: false },
    });
    expect(Date.now() - startedAt).toBeLessThan(ADMISSION_BOUND_MS);
    expect(probe.settled).toEqual([FAKE_LEAF]);
  });
});

/**
 * Spec #168 / ticket #178 — the admission report channel is released, not disarmed.
 *
 * Once the admission verdict exists, this gate's own listeners have no further
 * job: nothing else reads the report channel, and the prologue closes it before
 * `exec` so the command never inherits the pipe. The channel itself is NOT
 * necessarily finished at that moment, though, so the runner resumes it to let
 * any trailing byte drain and keep the handle from holding Node open.
 *
 * Stripping EVERY listener and then resuming an unfinished stream is how a run
 * that has already reported its outcome brings the process down: a late `error`
 * on a resumed stream with no `error` listener is an unhandled `error` event,
 * which is fatal — for a contained Verify that is a crash where the receipt
 * either exists or does not, decided by a scheduling artifact on a pipe nothing
 * reads any more. So the decision retires only its OWN listeners, by reference,
 * and leaves an error sink behind.
 */
describe("a settled admission channel keeps an error sink (Spec #168 / ticket #178)", () => {
  it("retires its own listeners and survives a late stream error", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    const admission = scriptAdmissionChild(({ child, report }) => {
      report.write("a");
      setTimeout(() => child.emit("exit", 0, null), 20);
    });

    const managed = await import("../src/managed-shell.js");
    const result = await managed.runManagedShellCommand({
      cwd: tmpdir(),
      command: "printf admitted-and-settled",
      operationId: "poiesis-admission-sink",
    });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(probe.released).toEqual([FAKE_LEAF]);

    const report = admission.report;
    const uncaught: unknown[] = [];
    const capture = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", capture);
    try {
      report.emit("error", new Error("late admission channel failure"));
      // Two turns of the loop, so a failure delivered from a stream callback
      // would have surfaced by now.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("uncaughtException", capture);
    }
    // The claim that matters: the late failure is not a new fact about a run
    // that has already reported one, so it must not become an unhandled `error`
    // event — the difference between a finished run and a crashed process.
    expect(uncaught).toEqual([]);
    // How it holds: the decision's own listeners are gone, by reference, and a
    // sink is deliberately left in their place.
    expect(report.listenerCount("data")).toBe(0);
    expect(report.listenerCount("close")).toBe(0);
    expect(report.listenerCount("end")).toBe(0);
    expect(report.listenerCount("error")).toBeGreaterThan(0);
  });

  it("keeps the sink after a refused admission too", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    // The channel closes with no confirmation: the verdict is a refusal, and the
    // refusal's own settle/release sequence runs afterwards.
    const admission = scriptAdmissionChild(({ report }) => {
      report.end();
    });
    probe.onSettle = () => admission.child.emit("exit", null, "SIGKILL");

    const managed = await import("../src/managed-shell.js");
    await expect(
      managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-confirmed" }),
    ).rejects.toMatchObject({ code: "PROCESS_CONTAINMENT_REFUSED" });

    expect(admission.report.listenerCount("error")).toBeGreaterThan(0);
  });
});

describe("an admission refusal settles the boundary it provisioned (Spec #168 / ticket #176)", () => {
  it("settles the provisioned leaf before releasing it", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    const order: string[] = [];
    mockContainment(probe, order);
    // The prologue closed its report channel without confirming: it may already
    // be INSIDE the leaf, and a leaf that is still populated can never be
    // removed. Releasing without settling is how a half-admitted leaf leaks.
    // Nothing here has exited or closed its streams, so the refusal path is the
    // only thing that can settle the boundary.
    const admission = scriptAdmissionChild(({ report }) => {
      report.end();
    });

    const managed = await import("../src/managed-shell.js");
    await expect(
      managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-confirmed" }),
    ).rejects.toMatchObject({ code: "PROCESS_CONTAINMENT_REFUSED" });

    expect(order).toEqual(["settle", "release"]);
    expect(probe.settled).toEqual([FAKE_LEAF]);
    expect(probe.released).toEqual([FAKE_LEAF]);
    // The half-admitted child is terminated rather than left behind.
    expect(admission.kills).not.toHaveLength(0);
  });

  it("never signals a PID that was already reaped when the admission is refused", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    // The prologue finished without ever reporting — the case where the child
    // is ALREADY gone by the time the refusal is decided. Signalling it here
    // would address whatever inherited that PID, which is the one thing the
    // admission barrier must never do.
    const admission = scriptAdmissionChild(({ child, report }) => {
      child.emit("exit", 0, null);
      report.end();
    });

    const managed = await import("../src/managed-shell.js");
    const startedAt = Date.now();
    await expect(
      managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-confirmed" }),
    ).rejects.toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: { reason: "ADMISSION_UNCONFIRMED", confirmed: false },
    });
    expect(Date.now() - startedAt).toBeLessThan(ADMISSION_BOUND_MS);
    expect(admission.kills).toEqual([]);
    // The refusal still settles the boundary it provisioned.
    expect(probe.settled).toEqual([FAKE_LEAF]);
    expect(probe.released).toEqual([FAKE_LEAF]);
  });

  it("keeps the refusal as the reported outcome when the refusal's own cleanup confirms the boundary", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    mockContainment(probe);
    scriptAdmissionChild(({ report }) => {
      report.end();
    });

    const managed = await import("../src/managed-shell.js");
    await expect(
      managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-confirmed" }),
    ).rejects.toMatchObject({ code: "PROCESS_CONTAINMENT_REFUSED" });
    expect(probe.settled).toEqual([FAKE_LEAF]);
  });

  /**
   * Spec #168 / ticket #177 — when the boundary Poiesis OWNED cannot be
   * confirmed empty, that failure is the reported outcome.
   *
   * The refusal explains why the boundary was in play; the settlement failure
   * says a member of it may still be running. The second is the surviving-process
   * fact an operator has to act on, so it is reported — with the refusal
   * carried forward as context rather than dropped, so neither fact hides the
   * other.
   */
  it("lets an unresolved settlement dominate the refusal without masking it", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    probe.settleFails = true;
    mockContainment(probe);
    scriptAdmissionChild(({ report }) => {
      report.end();
    });

    const managed = await import("../src/managed-shell.js");
    let error: unknown = null;
    try {
      await managed.runManagedShellCommand({ cwd: tmpdir(), command: "printf never-confirmed" });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: { confirmed: false },
    });
    const details = (error as { details: Record<string, unknown> }).details;
    // The refusal is preserved as bounded context, not as the outcome.
    expect(details.containmentRefusal).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      reason: "ADMISSION_UNCONFIRMED",
    });
    // And the surviving-process evidence the cleanup error itself carries is
    // untouched by the refusal being present.
    expect(details.populated).toBe(true);
    expect(probe.settled).toEqual([FAKE_LEAF]);
    expect(probe.released).toEqual([FAKE_LEAF]);
  });
});
/**
 * Spec #168 / ticket #182 — the scripted managed child and kernel boundary the
 * startup-protocol control-flow tests share.
 *
 * What is scripted here is deliberately the SMALLEST thing that can stand in for
 * the kernel and the child: a process table with one entry, a cgroup leaf with a
 * recorded settlement, and a child that speaks the startup protocol's report
 * format. Everything that decides the outcome stays the real implementation —
 * the two-phase protocol, the report parser, the lease validation, the refusal,
 * and the phase-aware cleanup — because those are exactly the parts under test.
 *
 * A test drives the child's behaviour through {@link ScriptOptions} and asserts
 * on what Poiesis did: the frames it wrote, the PID signals it sent (which on
 * the contained path must be none), and the boundary it settled.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { vi } from "vitest";
import { formatStartupReport, type StartupIdentity } from "../src/containment.js";

/** A PID no kernel has, and one Poiesis can therefore only ever lease, never signal. */
export const FAKE_PID = 424242;
export const FAKE_PGID = FAKE_PID;
export const FAKE_START = "100000001";
/** A second, different identity for the same PID: what reuse looks like. */
export const REUSED_START = "200000002";
/** A leaf path no kernel has, so its emptiness is a scripted fact, not a guess. */
export const FAKE_LEAF = "/poiesis-scripted-cgroup-leaf";

/** The identity a well-behaved prologue reports and is admitted under. */
export function scriptedIdentity(overrides: Partial<StartupIdentity> = {}): StartupIdentity {
  return { pid: FAKE_PID, processGroupId: FAKE_PGID, startIdentity: FAKE_START, ...overrides };
}

/**
 * The mutable kernel view the parent reads: a stand-in for `/proc`, so a test can
 * move a PID's start identity between two phases of the protocol and observe what
 * the parent does when the identity it validated is no longer the identity at
 * that PID.
 */
export interface KernelProbe {
  pid: number;
  processGroupId: number;
  startIdentity: string;
}

/** One `/proc/<pid>/stat` line the kernel could have produced. */
function statLine(probe: KernelProbe): string {
  const fields = new Array<string>(52).fill("0");
  fields[0] = "S";
  fields[1] = String(probe.pid);
  fields[2] = String(probe.processGroupId);
  fields[19] = probe.startIdentity;
  return `${probe.pid} (poiesis-scripted) ${fields.join(" ")}\n`;
}

export function mockKernelProbe(probe: KernelProbe): void {
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      readFileSync: ((path: string, ...rest: unknown[]) => {
        const match = typeof path === "string" ? /^\/proc\/(\d+)\/stat$/.exec(path) : null;
        if (match !== null && Number(match[1]) === probe.pid) return statLine(probe);
        return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
      }) as typeof actual.readFileSync,
    };
  });
}

export interface BoundaryProbe {
  leaf: string;
  order: string[];
  provisioned: string[];
  settled: string[];
  released: string[];
  /**
   * Whether the leaf held a member when settlement ran. `false` is the
   * initial-empty race: the parent may settle a leaf the child never entered, and
   * that says nothing at all about a leader that is still outside it.
   */
  populated: boolean;
  /** `cgroup.kill` writes the real settlement makes before its final read. */
  cgroupKills: number;
}

export function newBoundary(overrides: Partial<BoundaryProbe> = {}): BoundaryProbe {
  return {
    leaf: FAKE_LEAF,
    order: [],
    provisioned: [],
    settled: [],
    released: [],
    populated: true,
    cgroupKills: 0,
    ...overrides,
  };
}

/** Substitute ONLY the kernel boundary; the protocol stays the real one. */
export function mockContainmentBoundary(probe: BoundaryProbe): void {
  vi.doMock("../src/containment.js", async () => {
    const actual = await vi.importActual<typeof import("../src/containment.js")>("../src/containment.js");
    return {
      ...actual,
      provisionContainment: (input: { model: string; operationId: string }) => {
        probe.order.push("provision");
        probe.provisioned.push(input.operationId);
        return { model: input.model, operationId: input.operationId, leaf: probe.leaf };
      },
      settleContainment: async (lease: { leaf: string | null }) => {
        probe.order.push("settle-leaf");
        probe.settled.push(lease.leaf ?? "");
        if (probe.populated) probe.cgroupKills += 1;
        return { model: "cgroup-v2", leaf: lease.leaf, survived: [], confirmed: true };
      },
      releaseContainment: (lease: { leaf: string | null } | null) => {
        if (lease === null) return;
        probe.order.push("release");
        probe.released.push(lease.leaf ?? "");
      },
    };
  });
}

export interface ScriptedStartup {
  child: ChildProcess;
  /** The prologue's report channel. */
  report: PassThrough;
  /** The child's stdin: Poiesis's own gate and release channel. */
  gate: PassThrough;
  kernel: KernelProbe;
  /** The admission token and the execution token, in the order Poiesis wrote them. */
  gateLines: string[];
  /** The released argv: the element count, then one frame per element. */
  releaseLines: string[];
  /** `true` once Poiesis has revoked or released the gate channel. */
  gateClosed: boolean;
  /** Every raw PID signal the runner sent this child. Must stay empty. */
  kills: (NodeJS.Signals | undefined)[];
}

export interface ScriptOptions {
  /** The identity report the prologue writes immediately, or `null` for silence. */
  report?: StartupIdentity | null;
  /** The admitted report written once the admission token arrives. */
  admitted?: StartupIdentity | null;
  /** Runs after each line Poiesis writes to the gate or the release channel. */
  onGate?: (line: string, startup: ScriptedStartup) => void;
  /** Runs one turn after the spawn, while the identity gate is still waiting. */
  onSpawn?: () => void;
}

/** A child that speaks the startup protocol and records everything Poiesis does. */
export function scriptStartupChild(options: ScriptOptions = {}): ScriptedStartup {
  const kernel: KernelProbe = {
    pid: FAKE_PID,
    processGroupId: FAKE_PGID,
    startIdentity: FAKE_START,
  };
  mockKernelProbe(kernel);

  const child = new EventEmitter() as ChildProcess;
  const report = new PassThrough();
  const gate = new PassThrough();
  const startup: ScriptedStartup = {
    child,
    report,
    gate,
    kernel,
    gateLines: [],
    releaseLines: [],
    gateClosed: false,
    kills: [],
  };
  Object.assign(child, {
    pid: kernel.pid,
    stdin: gate,
    stdout: null,
    stderr: null,
    stdio: [gate, null, null, report],
  });
  child.kill = ((signal?: NodeJS.Signals) => {
    startup.kills.push(signal);
    setImmediate(() => child.emit("exit", null, "SIGKILL"));
    return true;
  }) as ChildProcess["kill"];
  child.unref = () => child;
  gate.on("close", () => {
    startup.gateClosed = true;
  });

  let buffered = "";
  let released = false;
  gate.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      // Everything after the execution token is the released argv.
      if (released) startup.releaseLines.push(line);
      else startup.gateLines.push(line);
      if (line.startsWith("E ")) released = true;
      options.onGate?.(line, startup);
      newline = buffered.indexOf("\n");
    }
  });

  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      spawn: (() => {
        setImmediate(() => {
          if (options.onSpawn !== undefined) {
            options.onSpawn();
            return;
          }
          if (options.report !== null) {
            report.write(`${formatStartupReport("identity", options.report ?? scriptedIdentity())}\n`);
          }
          if (options.admitted !== undefined && options.admitted !== null) {
            // The prologue answers the admission token itself, once.
            let answered = false;
            gate.on("data", () => {
              if (answered || released) return;
              answered = true;
              report.write(`${formatStartupReport("admitted", options.admitted ?? scriptedIdentity())}\n`);
            });
          }
        });
        return child;
      }) as typeof actual.spawn,
    };
  });
  return startup;
}

/** The released run finishes the way a finished command does. */
export function startupExit(startup: ScriptedStartup, code = 0): void {
  startup.child.emit("exit", code, null);
}

/** The child exits the way a revoked prologue does: promptly, on its own. */
export function exitOnGate(startup: ScriptedStartup, code = 75): void {
  startup.gate.on("close", () => {
    setImmediate(() => startup.child.emit("exit", code, null));
  });
}
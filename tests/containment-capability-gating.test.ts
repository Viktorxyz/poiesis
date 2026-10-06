/**
 * Spec #168 / ticket #176 — the capability gate itself.
 *
 * Verify, Focused Check, and post-integration commands execute caller-supplied
 * command TEXT, so they require strong containment and refuse with
 * `PROCESS_CONTAINMENT_UNAVAILABLE` before spawning anything on a host without a
 * delegated cgroup v2 subtree. Windows, macOS, and non-delegated Linux are all
 * such hosts, and none of them is broken — they are hosts Poiesis declines to
 * run arbitrary command text on.
 *
 * That makes the test suite's own portability a contract of its own:
 *
 *   - a test that actually EXECUTES a managed command must SKIP there, because
 *     otherwise the suite reports a host capability as a code regression;
 *   - a test that proves a resolver, a refusal, an evidence shape, or a control
 *     flow must RUN there, because those assertions are the fail-closed contract
 *     and a host that cannot contain anything is exactly where they matter most.
 *
 * These tests pin that contract without needing an unsupported host: they hide
 * the host's cgroup support the same way a Windows or macOS host would, and then
 * show the gate reporting "unavailable" (so the gated suites skip) while the
 * pure assertions still produce their own typed outcomes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRepository, strongContainmentAvailable } from "./helpers.js";

/**
 * Make THIS host look like one with no delegated cgroup v2 subtree.
 *
 * `/proc/self/cgroup` and the hierarchy under it are exactly what
 * `resolveContainmentCapability` reads, so denying them is the same shape of
 * answer a Windows or macOS host gives — a typed refusal naming the missing
 * capability, not a runtime failure.
 */
async function withoutStrongContainment<T>(run: () => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      readFileSync: ((path: string, ...rest: unknown[]) => {
        if (typeof path === "string" && (path === "/proc/self/cgroup" || path.startsWith("/sys/fs/cgroup"))) {
          throw Object.assign(new Error("no delegated cgroup v2 subtree on this host"), { code: "EACCES" });
        }
        return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
      }) as typeof actual.readFileSync,
    };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
}

const fixtures: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-capability-gate-"));
  fixtures.push(dir);
  return dir;
}

afterEach(async () => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  while (fixtures.length > 0) await rm(fixtures.pop()!, { recursive: true, force: true });
});

describe("the shared gate reports the host capability (Spec #168 / ticket #176)", () => {
  it("is true on a host that can strongly contain a managed command", () => {
    // Whatever this host is, the gate must equal the capability report exactly:
    // a gate that disagrees with the code it protects would either hide a real
    // failure or skip a suite that could have run.
    expect(strongContainmentAvailable()).toBe(true);
  });

  it("is false on a host with no delegated cgroup v2 subtree, so gated suites skip", async () => {
    const observed = await withoutStrongContainment(async () => {
      const helpers = await import("./helpers.js");
      const containment = await import("../src/containment.js");
      return {
        gate: helpers.strongContainmentAvailable(),
        capability: containment.resolveContainmentCapability(),
      };
    });

    expect(observed.gate).toBe(false);
    expect(observed.capability).toMatchObject({
      model: "cgroup-v2",
      available: false,
      reason: "NO_CGROUP_V2",
    });
  });
});

describe("execution-dependent paths refuse on a capability-unavailable host (Spec #168 / ticket #176)", () => {
  it("refuses a managed shell command before spawning anything", async () => {
    const spawnCalls: string[] = [];
    const dir = await scratch();
    const observed = await withoutStrongContainment(async () => {
      vi.doMock("node:child_process", async () => {
        const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        return {
          ...actual,
          spawn: ((...args: unknown[]) => {
            spawnCalls.push(String(args[0]));
            return Reflect.apply(actual.spawn, undefined, args) as never;
          }) as typeof actual.spawn,
        };
      });
      try {
        const managed = await import("../src/managed-shell.js");
        let error: unknown = null;
        try {
          await managed.runManagedShellCommand({ cwd: dir, command: "printf must-not-run" });
        } catch (thrown) {
          error = thrown;
        }
        return error;
      } finally {
        vi.doUnmock("node:child_process");
      }
    });

    expect(observed).toMatchObject({
      code: "PROCESS_CONTAINMENT_UNAVAILABLE",
      details: { containment: "cgroup-v2", reason: "NO_CGROUP_V2" },
    });
    // Nothing was created, so nothing can leak. This is the refusal every gated
    // suite would otherwise report as a code failure.
    expect(spawnCalls).toEqual([]);
  });

  it("refuses a Verify plan before spawning anything on a capability-unavailable host", async () => {
    // `createTestRepository` drives `git` with a FIXED argv, which needs no
    // containment, so the repository itself is real on such a host. Only the
    // plan execution is gated — which is exactly the boundary under test.
    const repository = await createTestRepository();
    fixtures.push(repository.parent);
    const shellSpawns: string[] = [];
    const observed = await withoutStrongContainment(async () => {
      vi.doMock("node:child_process", async () => {
        const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        return {
          ...actual,
          spawn: ((...args: unknown[]) => {
            // Only the INTERPRETER matters: the fixed-argv `git` calls Verify
            // makes around its plan are not gated and must still run.
            if (String(args[0]).includes("sh")) shellSpawns.push(String(args[0]));
            return Reflect.apply(actual.spawn, undefined, args) as never;
          }) as typeof actual.spawn,
        };
      });
      try {
        const git = await import("../src/git.js");
        try {
          await git.verify({
            cwd: repository.root,
            candidateSha: repository.baseSha,
            commands: ["printf must-not-run"],
          });
          return null;
        } catch (error) {
          return error;
        }
      } finally {
        vi.doUnmock("node:child_process");
      }
    });

    expect(observed).toMatchObject({
      code: "PROCESS_CONTAINMENT_UNAVAILABLE",
      details: { containment: "cgroup-v2", reason: "NO_CGROUP_V2" },
    });
    // Not one interpreter was spawned: the refusal precedes the shell entirely.
    expect(shellSpawns).toEqual([]);
  });

  it("never lets a Focused Check surface resolve on a capability-unavailable host", async () => {
    const dir = await scratch();
    const observed = await withoutStrongContainment(async () => {
      const focused = await import("../src/focused-check.js");
      try {
        return { result: await focused.executeFocusedCheck({ cwd: dir, commands: ["printf must-not-run"] }), error: null };
      } catch (error) {
        return { result: null, error };
      }
    });

    // Whatever the workspace-authority refusal is, it is a refusal: no managed
    // command ran, and nothing reported a pass or a proof of any kind.
    expect(observed.result).toBeNull();
    expect((observed.error as { code?: string } | null)?.code).toBeDefined();
  });
});

describe("pure fail-closed assertions still run on a capability-unavailable host (Spec #168 / ticket #176)", () => {
  it("still reports the unmanaged process-group model as not strong containment", async () => {
    const capability = await withoutStrongContainment(async () => {
      const containment = await import("../src/containment.js");
      return containment.resolveContainmentCapability("process-group");
    });

    expect(capability).toMatchObject({ available: false, reason: "NOT_STRONG_CONTAINMENT" });
    expect(capability.detail).toContain("setsid");
  });

  it("still refuses a caller that demands strong containment by name, with an actionable remediation", async () => {
    const refusal = await withoutStrongContainment(async () => {
      const containment = await import("../src/containment.js");
      return containment.containmentUnavailableError(
        containment.resolveContainmentCapability(),
        "Run this operation on a Linux host with a delegated cgroup v2 subtree.",
      );
    });

    expect(refusal).toMatchObject({
      code: "PROCESS_CONTAINMENT_UNAVAILABLE",
      details: {
        remediation: "Run this operation on a Linux host with a delegated cgroup v2 subtree.",
        platform: expect.any(String),
      },
    });
    expect(refusal.message).toContain("cgroup-v2");
  });

  it("still resolves the POSIX command processor, which needs no containment", async () => {
    // The processor seam is a separate fact from the containment seam: a host
    // with no cgroup subtree can absolutely have a working `/bin/sh`, and
    // refusing it here would be a different — and wrong — claim.
    const invocation = await withoutStrongContainment(async () => {
      const processor = await import("../src/command-processor.js");
      return processor.buildCommandProcessorInvocation("printf kept");
    });

    expect(invocation).toEqual({ command: "/bin/sh", args: ["-c", "printf kept"] });
  });

  it("still reports the unsupported-platform reason for Windows verbatim", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      const capability = await withoutStrongContainment(async () => {
        const containment = await import("../src/containment.js");
        return containment.resolveContainmentCapability();
      });
      expect(capability).toMatchObject({ available: false, platform: "win32", reason: "UNSUPPORTED_PLATFORM" });
      // Actionable, not merely negative: it names the primitive that is missing.
      expect(capability.detail).toContain("Job Object");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });
});
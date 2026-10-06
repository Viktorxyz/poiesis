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
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveContainmentCapability, type ContainmentCapability } from "../src/containment.js";
import {
  createTestRepository,
  describeManagedExecution,
  strongContainmentAvailable,
} from "./helpers.js";

/** The prefix every transient capability probe carries, so residue is detectable. */
const PROBE_PREFIX = "poiesis-capability-probe-";

/**
 * Make THIS host look like one with no delegated cgroup v2 subtree.
 *
 * `/proc/self/cgroup` and the hierarchy under it are exactly what
 * `resolveContainmentCapability` reads, so denying them is the same shape of
 * answer a Windows or macOS host gives — a typed refusal naming the missing
 * capability, not a runtime failure.
 *
 * Spec #168 / ticket #178: the platform is injected as Linux for the same
 * reason the filesystem is scripted. Without it a macOS or Windows host would
 * answer `UNSUPPORTED_PLATFORM` before any of these facts are read, and every
 * assertion about the cgroup files would be a host report wearing a test's
 * name. Production semantics are untouched — the unsupported-platform answer is
 * asserted separately, from a host that really is that platform.
 */
async function withoutStrongContainment<T>(
  run: () => Promise<T>,
  platform: NodeJS.Platform = "linux",
): Promise<T> {
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
      ...posixProcessorProbe(actual),
    };
  });
  const restore = injectPlatform(platform);
  try {
    return await run();
  } finally {
    restore();
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
}

/**
 * Spec #168 / ticket #178 — answer the capability report as this platform for
 * the duration of a scripted-filesystem assertion.
 *
 * The report consults `process.platform` before it reads any hierarchy, so a
 * non-Linux host would never reach the scripted facts at all. Restored by the
 * returned function, so no test can leave the runtime lying about its platform.
 */
function injectPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  return () => Object.defineProperty(process, "platform", original);
}

/**
 * Spec #168 / ticket #178 — report the POSIX processor as present.
 *
 * The processor is resolved BEFORE containment is provisioned, so on a host
 * without `/bin/sh` these assertions would stop one seam earlier and report that
 * host's missing interpreter instead of the containment answer under test. The
 * processor's own availability is covered where it is the subject
 * (`tests/command-processor.test.ts`); here it is only the thing that has to
 * stop objecting before the boundary is asked.
 */
function posixProcessorProbe(actual: typeof import("node:fs")): Record<string, unknown> {
  return {
    accessSync: ((path: string, ...rest: unknown[]) => {
      if (path === "/bin/sh") return undefined;
      return Reflect.apply(actual.accessSync, undefined, [path, ...rest]) as void;
    }) as typeof actual.accessSync,
  };
}

const fixtures: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-capability-gate-"));
  fixtures.push(dir);
  return dir;
}

/**
 * Spec #168 / ticket #177 — answer the capability report's filesystem questions
 * from a script instead of from this host, so the probe's own decisions are what
 * is under test.
 *
 * `mkdir`/`rmdir` under the cgroup root are SIMULATED and recorded rather than
 * performed: a host without a delegated subtree must be able to observe the
 * refusal paths too, and it must be able to do so without this test creating a
 * real directory on whatever host it happens to run on. Everything else passes
 * through to the real `node:fs`.
 *
 * Spec #168 / ticket #178: `hideRealControl` and `rmdir` answer for the leaf
 * REAL provisioning creates (as opposed to the transient capability probe), so
 * the provisioning path can be driven — including its own revalidation of the
 * leaf it just created — without a real cgroup hierarchy anywhere.
 */
interface ProbeRecord {
  readonly created: string[];
  readonly removed: string[];
  /** Real leaves whose `rmdir` was refused, with the errno that refused it. */
  readonly rmdirFailed: { path: string; code: string }[];
}

async function withCgroupFilesystem<T>(
  overrides: {
    unified?: string | null;
    controllers?: boolean;
    mkdir?: "deny";
    hideControl?: string | null;
    /** Hides a control from the leaf real provisioning creates. */
    hideRealControl?: string | null;
    /** Makes `rmdir` of a real leaf fail the way a busy or forbidden kernel answers. */
    rmdir?: "EBUSY" | "EACCES" | null;
  },
  run: (probe: ProbeRecord) => Promise<T>,
): Promise<T> {
  const probe: ProbeRecord = { created: [], removed: [], rmdirFailed: [] };
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const underCgroupRoot = (path: unknown): path is string =>
      typeof path === "string" && path.startsWith("/sys/fs/cgroup/");
    const isProbeLeaf = (path: string): boolean => path.includes(PROBE_PREFIX);
    return {
      ...actual,
      existsSync: ((path: string, ...rest: unknown[]) => {
        if (overrides.controllers !== undefined && path === "/sys/fs/cgroup/cgroup.controllers") {
          return overrides.controllers;
        }
        if (underCgroupRoot(path)) {
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (overrides.hideControl != null && path.endsWith(`/${overrides.hideControl}`)) {
            return false;
          }
          if (overrides.hideRealControl != null && path.endsWith(`/${overrides.hideRealControl}`) && !isProbeLeaf(path)) {
            return false;
          }
          // A SIMULATED leaf: because `mkdir` below creates nothing on disk, the
          // controls of a leaf it did create have to be answered here, or every
          // probe would look like it found none of them.
          if (probe.created.includes(parent)) return true;
        }
        return Reflect.apply(actual.existsSync, undefined, [path, ...rest]) as boolean;
      }) as typeof actual.existsSync,
      statSync: ((path: string, ...rest: unknown[]) => {
        if (path === "/sys/fs/cgroup") {
          return { isDirectory: () => true } as unknown as ReturnType<typeof actual.statSync>;
        }
        return Reflect.apply(actual.statSync, undefined, [path, ...rest]) as ReturnType<typeof actual.statSync>;
      }) as typeof actual.statSync,
      readFileSync: ((path: string, ...rest: unknown[]) => {
        if (path === "/proc/self/cgroup") {
          if (overrides.unified === null) {
            throw Object.assign(new Error("no unified cgroup v2 line"), { code: "ENOENT" });
          }
          return overrides.unified ?? "0::/\n";
        }
        return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
      }) as typeof actual.readFileSync,
      mkdirSync: ((path: string, ...rest: unknown[]) => {
        if (underCgroupRoot(path)) {
          probe.created.push(path);
          if (overrides.mkdir === "deny") {
            throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
          }
          return undefined;
        }
        return Reflect.apply(actual.mkdirSync, undefined, [path, ...rest]) as unknown;
      }) as typeof actual.mkdirSync,
      rmdirSync: ((path: string, ...rest: unknown[]) => {
        if (underCgroupRoot(path)) {
          if (overrides.rmdir != null && !isProbeLeaf(path)) {
            probe.rmdirFailed.push({ path, code: overrides.rmdir });
            throw Object.assign(new Error(`rmdir refused: ${overrides.rmdir}`), { code: overrides.rmdir });
          }
          probe.removed.push(path);
          return undefined;
        }
        return Reflect.apply(actual.rmdirSync, undefined, [path, ...rest]) as unknown;
      }) as typeof actual.rmdirSync,
    };
  });
  // Spec #168 / ticket #178: the report reads `process.platform` before it
  // reads any hierarchy, so a non-Linux host must still be answered as Linux
  // here or these assertions would report that host instead of this code.
  const restorePlatform = injectPlatform("linux");
  try {
    return await run(probe);
  } finally {
    restorePlatform();
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
}

afterEach(async () => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  while (fixtures.length > 0) await rm(fixtures.pop()!, { recursive: true, force: true });
});

describe("the shared gate reports the host capability (Spec #168 / ticket #176)", () => {
  it("equals the capability report exactly, on whatever host this is", () => {
    // Spec #168 / ticket #177: the gate is not allowed to have an opinion of
    // its own. A gate that hard-codes an answer would either skip a suite that
    // could have run or — far worse — run a suite on a host that cannot contain
    // anything, reporting the HOST's missing capability as a code regression.
    // Whatever this host is, the gate is exactly what the code it protects
    // reports.
    expect(strongContainmentAvailable()).toBe(resolveContainmentCapability().available);
  });

  it("reports whatever the report says, and gates managed execution on it", async () => {
    // The two consequences of the equality above, stated as observable
    // behaviour rather than restated as an implementation: on this host the
    // gate is whatever the report says, and every managed-execution suite in the
    // repository is declared through that one predicate.
    const capability: ContainmentCapability = resolveContainmentCapability();
    expect(strongContainmentAvailable()).toBe(capability.available);
    expect(capability.available).toBe(capability.reason === null);
    expect(capability.model).toBe("cgroup-v2");
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

describe("the capability report earns its verdict (Spec #168 / ticket #177)", () => {
  // These answer the report from a scripted cgroup filesystem, so they describe
  // the probe's decisions rather than this host's kernel — and they therefore
  // say the same thing on every host.
  it("reports unavailable when a managed leaf cannot be CREATED under a readable hierarchy", async () => {
    const observed = await withCgroupFilesystem(
      { unified: "0::/\n", controllers: true, mkdir: "deny" },
      async (probe) => {
        const containment = await import("../src/containment.js");
        return { capability: containment.resolveContainmentCapability(), probe };
      },
    );

    // A readable `cgroup.controllers`, a resolvable path, and a directory are
    // necessary but NOT sufficient: this parent cannot host a managed leaf, so
    // every managed run on this host would refuse inside `provisionContainment`
    // after the report had promised it would work.
    expect(observed.capability).toMatchObject({
      model: "cgroup-v2",
      available: false,
      reason: "PROVISION_FAILED",
    });
    expect(observed.capability.detail).toContain("EROFS");
    // It really did try: the answer came from performing the provisioning step
    // on a leaf of its own, not from reading the hierarchy.
    expect(observed.probe.created).toHaveLength(1);
    expect(observed.probe.created[0]).toContain(PROBE_PREFIX);
  });

  it("reports unavailable when the leaf it created exposes no cgroup.kill", async () => {
    const observed = await withCgroupFilesystem(
      { unified: "0::/\n", controllers: true, hideControl: "cgroup.kill" },
      async (probe) => {
        const containment = await import("../src/containment.js");
        return { capability: containment.resolveContainmentCapability(), probe };
      },
    );

    expect(observed.capability).toMatchObject({
      model: "cgroup-v2",
      available: false,
      reason: "NO_CGROUP_KILL",
    });
    expect(observed.capability.detail).toContain("cgroup.kill");
    // The refusal path removes its probe too, so a host that answers "no" is
    // not left holding a directory it just said it cannot use.
    expect(observed.probe.removed).toEqual(observed.probe.created);
    expect(observed.probe.removed[0]).toContain(PROBE_PREFIX);
  });

  it.each(["cgroup.procs", "cgroup.events"])("reports unavailable when a leaf exposes no %s", async (control) => {
    // Every required control is checked, not just the one settlement happens to
    // read: `cgroup.procs` is what admission confirms itself against and
    // `cgroup.events` is what settlement refuses to trade for anything weaker,
    // so a host missing either cannot host a managed leaf either.
    const observed = await withCgroupFilesystem(
      { unified: "0::/\n", controllers: true, hideControl: control },
      async (probe) => {
        const containment = await import("../src/containment.js");
        return { capability: containment.resolveContainmentCapability(), probe };
      },
    );

    expect(observed.capability).toMatchObject({ available: false, reason: "NO_CGROUP_KILL" });
    expect(observed.capability.detail).toContain(control);
    expect(observed.probe.removed).toEqual(observed.probe.created);
  });

  it("reports available, and still removes the probe, when every prerequisite holds", async () => {
    const observed = await withCgroupFilesystem(
      { unified: "0::/\n", controllers: true },
      async (probe) => {
        const containment = await import("../src/containment.js");
        return { capability: containment.resolveContainmentCapability(), probe };
      },
    );

    expect(observed.capability).toMatchObject({ model: "cgroup-v2", available: true, reason: null });
    expect(observed.probe.created).toHaveLength(1);
    expect(observed.probe.removed).toEqual(observed.probe.created);
  });

  it("gives two probes distinct leaf names, so concurrent probes cannot collide", async () => {
    // `mkdir` is the atomic test: a shared name would be `EEXIST`, never a
    // silently shared directory. The name therefore carries this process's PID
    // and a monotonic counter, and two calls never repeat one.
    const observed = await withCgroupFilesystem(
      { unified: "0::/\n", controllers: true },
      async (probe) => {
        const containment = await import("../src/containment.js");
        containment.resolveContainmentCapability();
        containment.resolveContainmentCapability();
        return probe;
      },
    );

    expect(observed.created).toHaveLength(2);
    expect(new Set(observed.created).size).toBe(2);
  });

  it("still reports unavailable before touching the hierarchy when there is no unified cgroup v2 at all", async () => {
    // The probe is only reached once a real hierarchy exists; the cheaper
    // refusals stay refusals.
    const observed = await withCgroupFilesystem({ unified: null }, async (probe) => {
      const containment = await import("../src/containment.js");
      return { capability: containment.resolveContainmentCapability(), probe };
    });

    expect(observed.capability).toMatchObject({ available: false, reason: "NO_CGROUP_V2" });
    expect(observed.probe.created).toEqual([]);
  });
});

/**
 * Spec #168 / ticket #178 — the leaf real provisioning creates is revalidated
 * on its own terms.
 *
 * The capability report proves the prerequisites on a throwaway probe, which
 * answers "can this host do it at all". The leaf a run actually provisions is
 * checked again, control by control, and a leaf that fails that revalidation is
 * refused with `PROCESS_CONTAINMENT_UNAVAILABLE` and asked to be removed first.
 *
 * That `rmdir` is best-effort in exactly the state where it can fail — the
 * kernel just refused to expose the controls of that directory — so its errno
 * must never become the reported outcome. An `EACCES` or `EBUSY` from the
 * cleanup used to replace the actionable refusal with an opaque filesystem
 * failure that named neither the missing control nor the host requirement, and
 * the caller could not tell a host limitation from a bug.
 */
describe("provisioning revalidation keeps the typed refusal (Spec #168 / ticket #178)", () => {
  it.each(["EBUSY", "EACCES"] as const)(
    "reports the missing control, not the %s from cleaning up the unusable leaf",
    async (code) => {
      const observed = await withCgroupFilesystem(
        { unified: "0::/\n", controllers: true, hideRealControl: "cgroup.kill", rmdir: code },
        async (probe) => {
          const containment = await import("../src/containment.js");
          try {
            containment.provisionContainment({
              model: "cgroup-v2",
              operationId: "spec-t178-revalidation",
              remediation: "Run this operation on a host that provides strong containment.",
            });
            return { error: null, probe };
          } catch (error) {
            return { error, probe };
          }
        },
      );

      // The refusal is still the refusal: its own code, its own reason, and the
      // control that was missing — whatever the cleanup answered.
      expect(observed.error).toMatchObject({
        code: "PROCESS_CONTAINMENT_UNAVAILABLE",
        details: {
          containment: "cgroup-v2",
          reason: "NO_CGROUP_KILL",
          detail: expect.stringContaining("cgroup.kill"),
          remediation: expect.stringContaining("strong containment"),
        },
      });
      expect((observed.error as Error).message).toContain("cgroup.kill");
      // The cleanup failure is bounded context on that refusal, not the outcome:
      // the operator is told the leaf is still there and how to remove it.
      expect(observed.error).toMatchObject({ details: { detail: expect.stringContaining(code) } });
      // Cleanup was still attempted, and the transient capability probe — which
      // has every control — was removed as usual.
      expect(observed.probe.rmdirFailed).toHaveLength(1);
      expect(observed.probe.rmdirFailed[0]?.path).not.toContain(PROBE_PREFIX);
      expect(observed.probe.removed).toEqual([observed.probe.created[0]]);
    },
  );

  it("removes the unusable leaf and refuses identically when the cleanup succeeds", async () => {
    const observed = await withCgroupFilesystem(
      { unified: "0::/\n", controllers: true, hideRealControl: "cgroup.events" },
      async (probe) => {
        const containment = await import("../src/containment.js");
        try {
          containment.provisionContainment({
            model: "cgroup-v2",
            operationId: "spec-t178-cleanup",
            remediation: "Run this operation on a host that provides strong containment.",
          });
          return { error: null, probe };
        } catch (error) {
          return { error, probe };
        }
      },
    );

    expect(observed.error).toMatchObject({
      code: "PROCESS_CONTAINMENT_UNAVAILABLE",
      details: { reason: "NO_CGROUP_KILL", detail: expect.stringContaining("cgroup.events") },
    });
    // Nothing is left behind for the next run to trip over.
    expect(observed.probe.removed).toEqual(observed.probe.created);
    expect(observed.probe.rmdirFailed).toEqual([]);
  });
});

describeManagedExecution("capability probing leaves no residue (Spec #168 / ticket #177)", () => {
  it("removes its own probe leaf from the delegated subtree", () => {
    const capability = resolveContainmentCapability();
    expect(capability.available).toBe(true);
    expect(capability.parent).not.toBeNull();

    // The probe is transient: it lives only in the kernel's cgroup tree and is
    // removed again before the report returns, so a probe can never accumulate
    // under the delegated parent or become something a managed run inherits.
    resolveContainmentCapability();
    const residue = readdirSync(capability.parent!).filter((entry) => entry.startsWith(PROBE_PREFIX)).sort();
    expect(residue).toEqual([]);
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
    // Asked for explicitly rather than inherited from this host: the point of the
    // assertion is that the PRODUCTION branch answers this platform with the
    // primitive it lacks, on every host that runs this suite.
    const capability = await withoutStrongContainment(async () => {
      const containment = await import("../src/containment.js");
      return containment.resolveContainmentCapability();
    }, "win32");

    expect(capability).toMatchObject({ available: false, platform: "win32", reason: "UNSUPPORTED_PLATFORM" });
    // Actionable, not merely negative: it names the primitive that is missing.
    expect(capability.detail).toContain("Job Object");
  });

  it("reports the real reason on whichever platform this host actually is", async () => {
    // Spec #168 / ticket #178: a non-Linux host has its own correct answer, and
    // these assertions must describe THIS runtime's real capability rather than
    // the answer a Linux CI box would give.
    const capability = resolveContainmentCapability();
    expect(strongContainmentAvailable()).toBe(capability.available);
    if (process.platform !== "linux") {
      expect(capability).toMatchObject({ available: false, reason: "UNSUPPORTED_PLATFORM" });
      expect(capability.platform).toBe(process.platform);
    }
  });
});
/**
 * Spec #168 / ticket #170 — transient managed-process identity leases.
 *
 * A managed subprocess is only ever identified by the lease the runner
 * created for it: operation id, workspace id, PID, process-group id, and
 * the kernel process-start identity captured at spawn. These tests pin
 * the fail-closed boundary around that lease:
 *
 *   - a well-formed lease for a real detached child carries every field
 *     and names an ISOLATED process group (never Poiesis's own group);
 *   - a malformed lease is rejected before any signal is considered;
 *   - an unsafe target (init's group, Poiesis's own group, Poiesis
 *     itself) is rejected;
 *   - a live process whose start identity does not match the lease
 *     (PID reuse), a live process outside the leased group (foreign),
 *     an identity the runtime cannot read (ambiguous), and an identity
 *     the runtime does not support are all rejected;
 *   - settlement of a live TERM-resistant descendant tree resolves only
 *     after identity-confirmed cleanup, and every rejection surfaces as
 *     a typed failure instead of a signal.
 *
 * Everything here observes real processes through the real kernel
 * surface (/proc, kill(2)); no signal is intercepted or mocked except in
 * the deliberately unreachable-ambiguity case, where the only way to
 * produce "alive but unreadable identity" is to deny the identity source.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
 * Spawn a detached child (exactly how `run()` isolates a managed
 * subprocess: its own session/process group) that keeps running until it
 * is signalled, and return the live lease for it.
 */
/**
 * Import a fresh instance of the production modules while the runtime
 * reports a different platform. Used to exercise the non-Linux POSIX
 * identity model on a Linux host: the module reads `process.platform` once
 * at load time, so a re-import under a redefined platform is the only way
 * to reach those branches.
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
    expect(Object.values(lease).every((value) => typeof value === "number" || typeof value === "string" || value === null)).toBe(
      true,
    );
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

describe("managed process lease settlement", () => {
  it.skipIf(!isLinux())(
    "confirms cleanup of a TERM-resistant descendant tree before resolving",
    { timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "poiesis-lease-tree-"));
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
      const leader = join(dir, "leader.sh");
      await writeFile(leader, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nsleep 30\n`, "utf8");
      await chmod(leader, 0o755);

      const { lease } = await spawnManagedChild(leader, {
        operationId: "operation-settle",
        workspaceId: "workspace-settle",
      });
      const descendantPid = await waitForPid(pidFile);
      tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });

      const startedAt = Date.now();
      const settlement = await settleManagedProcessLease(lease);
      const elapsed = Date.now() - startedAt;
      expect(settlement).toMatchObject({
        operationId: "operation-settle",
        workspaceId: "workspace-settle",
        processGroupId: lease.processGroupId,
        confirmed: true,
        survived: [],
      });
      // The TERM-resistant descendant could only be removed by the forced
      // escalation, so settlement cannot have completed before the grace
      // window elapsed.
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(isSignalAlive(descendantPid)).toBe(false);
    },
  );

  it.skipIf(!isLinux())(
    "treats a killed-but-unreaped zombie descendant as terminated, not unresolved",
    { timeout: 20_000 },
    async () => {
      // The parent execs into `sleep 30`, which never waits on children, so
      // the backgrounded short sleep becomes an unreaped zombie that still
      // holds its PID and process-group id. A zombie cannot run code and
      // cannot be killed, so counting it as a survivor would report every
      // such cleanup as PROCESS_CLEANUP_UNRESOLVED.
      const { dir } = await stageScript("#!/bin/sh\nexec sleep 30\n");
      const zombieParent = join(dir, "zombie-parent.sh");
      const shortLived = join(dir, "short.sh");
      await writeFile(shortLived, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(shortLived, 0o755);
      // `exec` immediately: the shell hands the group to `sleep 30`, which
      // never waits, so the backgrounded child stays an unreaped zombie.
      await writeFile(zombieParent, `#!/bin/sh\n"${shortLived}" &\nexec sleep 30\n`, "utf8");
      await chmod(zombieParent, 0o755);

      const { lease } = await spawnManagedChild(zombieParent, {
        operationId: "operation-zombie",
        workspaceId: "workspace-zombie",
      });
      const zombiePid = await waitForUnreapedZombie(lease.pid);

      // The zombie's PID is still allocated but the task can never run
      // again, so the lease must read as already settled rather than as a
      // live target worth signalling.
      expect(validateManagedProcessLease(createLeaseFor(zombiePid, lease))).toMatchObject({
        accepted: true,
        state: "gone",
      });

      const settlement = await settleManagedProcessLease(lease, { graceMs: 250, confirmMs: 500 });
      expect(settlement).toMatchObject({
        operationId: "operation-zombie",
        workspaceId: "workspace-zombie",
        processGroupId: lease.processGroupId,
        confirmed: true,
        survived: [],
      });
      // The zombie was accounted for as terminated, never as a survivor.
      expect(settlement.survived).not.toContain(zombiePid);
    },
  );

  it.skipIf(!isLinux())(
    "settles a zombie lease without signalling it or reporting it as a survivor",
    { timeout: 20_000 },
    async () => {
      // A zombie cannot be killed and cannot run; the only correct answers
      // are "already settled" and "not a survivor". A survivor scan that
      // equates "the PID is still in the process table" with "the process
      // is still running" gets both wrong.
      const { dir } = await stageScript("#!/bin/sh\nexec sleep 30\n");
      const zombieParent = join(dir, "zombie-parent.sh");
      const shortLived = join(dir, "short.sh");
      await writeFile(shortLived, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(shortLived, 0o755);
      await writeFile(zombieParent, `#!/bin/sh\n"${shortLived}" &\nexec sleep 30\n`, "utf8");
      await chmod(zombieParent, 0o755);

      const { lease } = await spawnManagedChild(zombieParent, {
        operationId: "operation-zombie-lease",
        workspaceId: "workspace-zombie-lease",
      });
      const zombiePid = await waitForUnreapedZombie(lease.pid);
      const zombieLease = createLeaseFor(zombiePid, lease);

      expect(validateManagedProcessLease(zombieLease)).toMatchObject({ accepted: true, state: "gone" });
      // The zombie itself is never recorded as a member to signal: the
      // group settlement terminates the live leader and reports success
      // rather than tripping over the unkillable zombie.
      const settlement = await settleManagedProcessLease(zombieLease);
      expect(settlement).toMatchObject({
        operationId: "operation-zombie-lease",
        confirmed: true,
        survived: [],
      });
      expect(settlement.terminated).toContain(lease.pid);
      expect(settlement.terminated).not.toContain(zombiePid);
    },
  );

  it.skipIf(!isLinux())("settles a lease whose process already exited without signalling", async () => {
    const { script } = await stageScript("#!/bin/sh\nexit 0\n");
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const lease = createManagedProcessLease({
      operationId: "operation-gone",
      workspaceId: "workspace-gone",
      pid: child.pid!,
    });
    await expect(settleManagedProcessLease(lease)).resolves.toMatchObject({
      confirmed: true,
      terminated: [],
      survived: [],
    });
  });

  it.skipIf(!isLinux())("fails closed with PROCESS_CLEANUP_REFUSED instead of signalling a rejected lease", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nexec 0</dev/null 1>/dev/null 2>/dev/null\nwhile :; do sleep 1; done\n",
    );
    const { child, lease } = await spawnManagedChild(script, {
      operationId: "operation-refused",
      workspaceId: "workspace-refused",
    });
    await expect(
      settleManagedProcessLease({ ...lease, startIdentity: String(Number(lease.startIdentity) + 3) }),
    ).rejects.toMatchObject({
      code: "PROCESS_CLEANUP_REFUSED",
      details: {
        reason: "PID_REUSE",
        operationId: "operation-refused",
        workspaceId: "workspace-refused",
        pid: child.pid,
      },
    });
    // The rejected lease produced no signal at all.
    expect(isSignalAlive(child.pid!)).toBe(true);
  });

  it.skipIf(!isLinux())("reports PROCESS_CLEANUP_UNRESOLVED when descendants cannot be confirmed gone", async () => {
    const { script } = await stageScript(
      [
        "#!/bin/sh",
        "trap '' TERM",
        "exec 0</dev/null 1>/dev/null 2>/dev/null",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
    );
    const { lease } = await spawnManagedChild(script, {
      operationId: "operation-unresolved",
      workspaceId: "workspace-unresolved",
    });
    // A zero-length confirmation bound cannot confirm that the forced
    // phase actually removed every descendant, so settlement must fail
    // closed with the unconfirmed identities instead of claiming success.
    await expect(settleManagedProcessLease(lease, { confirmMs: 0 })).rejects.toMatchObject({
      code: "PROCESS_CLEANUP_UNRESOLVED",
      details: {
        operationId: "operation-unresolved",
        workspaceId: "workspace-unresolved",
        processGroupId: lease.processGroupId,
      },
    });
  });

  it.skipIf(!isLinux())("still settles a TERM-resistant group when members cannot be enumerated", { timeout: 30_000 }, async () => {
    // Deny the member-enumeration source. Settlement can then only address
    // the isolated group as a whole — there is no per-member identity pass —
    // and its confirmation evidence is the group itself being empty. This is
    // the reduced-evidence path, not a licence to signal more widely.
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readdirSync: (() => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }) as typeof actual.readdirSync,
      };
    });

    try {
      const tree = await vi.importActual<typeof import("../src/process-tree.js")>("../src/process-tree.js");
      const { script } = await stageScript(
        [
          "#!/bin/sh",
          "trap '' TERM",
          "exec 0</dev/null 1>/dev/null 2>/dev/null",
          "while :; do sleep 1; done",
          "",
        ].join("\n"),
      );
      const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
      spawned.push(child);
      child.unref();
      tracked.push({ pid: child.pid!, startIdentity: startTimeOf(child.pid!) });
      const lease = tree.createManagedProcessLease({
        operationId: "operation-unenumerable",
        workspaceId: "workspace-unenumerable",
        pid: child.pid!,
      });

      await expect(tree.settleManagedProcessLease(lease)).resolves.toMatchObject({
        operationId: "operation-unenumerable",
        workspaceId: "workspace-unenumerable",
        processGroupId: lease.processGroupId,
        confirmed: true,
      });
      expect(isSignalAlive(child.pid!)).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

/**
 * Spec #168 / ticket #170 — the documented non-Linux POSIX identity model.
 *
 * On a POSIX platform with no readable process table, Poiesis cannot prove
 * "this PID is still the process I spawned". The contract is that it does
 * not pretend to: liveness comes from signal(0), a lease is accepted only
 * when the OS's own detached-spawn invariant identifies the group as
 * Poiesis's, cleanup addresses the group and never an individual PID, and
 * settlement confirms by group emptiness. The alternative — reporting every
 * live PID as ambiguous — would refuse to clean up anything at all.
 *
 * These run on a Linux host with `process.platform` redefined to `darwin`
 * for a fresh module import, so the real non-Linux branches execute.
 */
describe("non-Linux POSIX identity model (platform-mocked)", () => {
  it("declares the group-only model and no start-identity support", async () => {
    const linux = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "linux",
      "../src/process-tree.js",
    );
    expect(linux.PROCESS_START_IDENTITY_SUPPORTED).toBe(true);
    expect(linux.PROCESS_GROUP_ONLY_IDENTITY_MODEL).toBe(false);

    const darwin = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    expect(darwin.PROCESS_GROUPS_SUPPORTED).toBe(true);
    expect(darwin.PROCESS_START_IDENTITY_SUPPORTED).toBe(false);
    expect(darwin.PROCESS_GROUP_ONLY_IDENTITY_MODEL).toBe(true);

    const win32 = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "win32",
      "../src/process-tree.js",
    );
    expect(win32.PROCESS_GROUPS_SUPPORTED).toBe(false);
    expect(win32.PROCESS_GROUP_ONLY_IDENTITY_MODEL).toBe(false);
  });

  it("accepts a live detached-group lease instead of refusing every cleanup", async () => {
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

    // Live and accepted, but explicitly NOT identity-verified: the reduced
    // evidence is reported as such rather than dressed up as confirmation.
    expect(tree.validateManagedProcessLease(lease)).toMatchObject({
      accepted: true,
      state: "live",
      verified: false,
    });
    expect(isSignalAlive(child.pid!)).toBe(true);
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
    expect(
      tree.validateManagedProcessLease({ ...lease, processGroupId: lease.pid + 1_000_000 }),
    ).toMatchObject({ accepted: false, reason: "FOREIGN_PROCESS" });
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

  it("settles a live TERM-resistant tree by group, reporting no identity-confirmed members", { timeout: 30_000 }, async () => {
    const tree = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    const dir = await mkdtemp(join(tmpdir(), "poiesis-darwin-tree-"));
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
    const leader = join(dir, "leader.sh");
    await writeFile(leader, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nsleep 30\n`, "utf8");
    await chmod(leader, 0o755);

    const child = spawn(leader, [], { cwd: dir, detached: true, stdio: "ignore" });
    spawned.push(child);
    child.unref();
    tracked.push({ pid: child.pid!, startIdentity: null });
    const descendantPid = await waitForPid(pidFile);
    tracked.push({ pid: descendantPid, startIdentity: startTimeOf(descendantPid) });
    const lease = tree.createManagedProcessLease({
      operationId: "operation-darwin-settle",
      workspaceId: "workspace-darwin-settle",
      pid: child.pid!,
    });

    const settlement = await tree.settleManagedProcessLease(lease, { graceMs: 300, confirmMs: 2_000 });
    expect(settlement).toMatchObject({
      operationId: "operation-darwin-settle",
      workspaceId: "workspace-darwin-settle",
      processGroupId: lease.processGroupId,
      confirmed: true,
      survived: [],
      // Members cannot be enumerated without a readable process table, so
      // the settlement reports no identity-confirmed terminations.
      terminated: [],
    });
    // The tree really was terminated, on evidence that does not require
    // reading a process table.
    expect(isSignalAlive(descendantPid)).toBe(false);
    expect(isSignalAlive(child.pid!)).toBe(false);
  });

  it("confirms by group emptiness, which is the only evidence this platform has", { timeout: 30_000 }, async () => {
    const tree = await importAsPlatform<typeof import("../src/process-tree.js")>(
      "darwin",
      "../src/process-tree.js",
    );
    const { script } = await stageScript(
      [
        "#!/bin/sh",
        "trap '' TERM",
        "exec 0</dev/null 1>/dev/null 2>/dev/null",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
    );
    const child = spawn(script, [], { cwd: tmpdir(), detached: true, stdio: "ignore" });
    spawned.push(child);
    child.unref();
    tracked.push({ pid: child.pid!, startIdentity: null });
    const lease = tree.createManagedProcessLease({
      operationId: "operation-darwin-evidence",
      workspaceId: "workspace-darwin-evidence",
      pid: child.pid!,
    });

    // SIGKILL is untrappable, so this tree always ends. Confirmation comes
    // from the group no longer existing.
    await expect(tree.settleManagedProcessLease(lease)).resolves.toMatchObject({
      operationId: "operation-darwin-evidence",
      confirmed: true,
      survived: [],
      terminated: [],
    });
    expect(() => process.kill(-lease.processGroupId, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
});

/**
 * Find a zombie whose parent is `parentPid`. A zombie is a terminated task
 * that still holds its PID until its parent reaps it, so it is the exact
 * case a survivor scan must not mistake for a live descendant.
 */
async function waitForUnreapedZombie(parentPid: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const fields = statFields(Number(entry));
      if (fields === null) continue;
      if (fields[0] === "Z" && fields[1] === String(parentPid)) return Number(entry);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no unreaped zombie appeared under parent ${parentPid}`);
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`descendant did not publish a valid PID at ${path}`);
}
import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bounded, boundedOutput, run } from "../src/process.js";
import type { PoiesisError } from "../src/errors.js";

const fixtures: string[] = [];
const survivorPids = new Map<number, string | null>();

afterEach(async () => {
  for (const [pid, startTime] of survivorPids) {
    try {
      if (await isSameProcess(pid, startTime)) process.kill(pid, "SIGKILL");
    } catch {
      // Already terminated.
    }
  }
  survivorPids.clear();
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

async function stageScript(content: string): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-process-"));
  fixtures.push(dir);
  const script = join(dir, "case.sh");
  await writeFile(script, content, "utf8");
  await chmod(script, 0o755);
  return { dir, script };
}

async function waitForPid(path: string, timeoutMs = 2_000): Promise<number> {
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

async function processStartTime(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

async function isSameProcess(pid: number, startTime: string | null): Promise<boolean> {
  if (startTime !== null) return (await processStartTime(pid)) === startTime;
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

describe("process runner", () => {
  it("runs a normal command and captures both output streams", async () => {
    const { script } = await stageScript("#!/bin/sh\necho hello\necho world 1>&2\n");
    const result = await run(script, [], { cwd: tmpdir() });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hello",
      stderr: "world",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    });
  });

  it("returns or rejects according to the command exit code", async () => {
    const { script } = await stageScript("#!/bin/sh\necho bad 1>&2\nexit 7\n");
    await expect(run(script, [], { cwd: tmpdir() })).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      details: { exitCode: 7 },
    });
    await expect(run(script, [], { cwd: tmpdir(), allowFailure: true })).resolves.toMatchObject({
      exitCode: 7,
    });
  });

  it("keeps timeout precedence and diagnostic shape with allowFailure", { timeout: 10_000 }, async () => {
    const { script } = await stageScript("#!/bin/sh\nsleep 30\n");
    await expect(
      run(script, [], { cwd: tmpdir(), allowFailure: true, timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: "COMMAND_TIMEOUT",
      exitCode: 124,
      details: {
        command: script,
        args: [],
        timeoutMs: 100,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });
  });

  it("waits for inherited output to close and captures late output", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\n(sleep 0.15; printf late) &\nprintf early\nexit 0\n",
    );
    const startedAt = Date.now();
    const result = await run(script, [], { cwd: tmpdir() });
    expect(result.stdout).toBe("earlylate");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });

  it("drains output after each byte budget is exhausted", { timeout: 15_000 }, async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nhead -c 524288 /dev/zero | tr '\\0' x\nhead -c 524288 /dev/zero | tr '\\0' y 1>&2\n",
    );
    const result = await run(script, [], { cwd: tmpdir(), maxBytes: 1_024 });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(1_024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it("handles output descriptors that close before child exit", async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nprintf out\nprintf err 1>&2\nexec 1>&- 2>&-\nsleep 0.1\n",
    );
    await expect(run(script, [], { cwd: tmpdir() })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "out",
      stderr: "err",
    });
  });

  it("turns spawn failure into COMMAND_IO_ERROR", async () => {
    await expect(
      run("/no/such/poiesis-process-fixture-binary", [], { cwd: tmpdir() }),
    ).rejects.toMatchObject({ code: "COMMAND_IO_ERROR" });
  });
});

describe("replacement environment seam (ticket #129)", () => {
  // Local child fixture: spawn a Node subprocess that writes its own
  // process.env as JSON to stdout. This is the deterministic, network-
  // free / project-free boundary probe required by the ticket #129
  // standards security finding: it proves the actual child receives
  // the env the runner intended, not the parent env.
  const ENV_PROBE_SCRIPT = "process.stdout.write(JSON.stringify(process.env))";
  const PROBE_ARGS = ["-e", ENV_PROBE_SCRIPT];

  async function probeChildEnv(options: {
    replacementEnv?: NodeJS.ProcessEnv;
    env?: NodeJS.ProcessEnv;
  }): Promise<Record<string, string>> {
    const result = await run(process.execPath, PROBE_ARGS, {
      cwd: tmpdir(),
      allowFailure: true,
      ...options,
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as Record<string, string>;
  }

  // Snapshot + restore the parent env around each probe so the
  // standards-security test does not leak fake credentials into the
  // rest of the suite. Only the keys this test touches are managed.
  const PARENT_SECRET_KEYS = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "POIESIS_API_KEY",
    "POIESIS_TOKEN",
    "POIESIS_DEBUG",
    "POIESIS_TEST_SECRET",
  ] as const;

  let parentEnvSnapshots: Map<string, string | undefined> | null = null;

  function seedParentSecrets(): void {
    parentEnvSnapshots = new Map();
    for (const key of PARENT_SECRET_KEYS) {
      parentEnvSnapshots.set(key, process.env[key]);
      process.env[key] = `parent-secret-${key}`;
    }
  }

  function restoreParentSecrets(): void {
    if (parentEnvSnapshots === null) return;
    for (const [key, value] of parentEnvSnapshots) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    parentEnvSnapshots = null;
  }

  beforeEach(seedParentSecrets);
  afterEach(restoreParentSecrets);

  it("child lacks provider/tracker/POIESIS secrets when replacementEnv omits them, while allowed vars reach the child", async () => {
    const replacementEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      Path: "/usr/bin:/bin",
      HOME: "/home/sanitized-test",
      USER: "sanitized-test",
      LOGNAME: "sanitized-test",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp",
      TMP: "/tmp",
      TEMP: "/tmp",
      XDG_RUNTIME_DIR: "/run/user/0",
      XDG_CACHE_HOME: "/home/sanitized-test/.cache",
      SHELL: "/bin/sh",
    };
    const childEnv = await probeChildEnv({ replacementEnv });
    // Every secret the parent process owned MUST be absent from the
    // child's env. None of these are in the sanitized replacement,
    // so the runner must NOT re-merge them.
    for (const key of PARENT_SECRET_KEYS) {
      expect(childEnv[key]).toBeUndefined();
    }
    // Every allow-listed variable the replacement env carries MUST
    // reach the child untouched. PATH/Path in particular must remain
    // available so `uvx` (and any other binary the child spawns) can
    // resolve.
    for (const [key, value] of Object.entries(replacementEnv)) {
      expect(childEnv[key]).toBe(value);
    }
  });

  it("replacementEnv also strips provider/tracker/POIESIS secrets when the sanitized env includes unrelated keys", async () => {
    // The real `defaultGraphifyRunner` passes the result of
    // `sanitizeGraphifyEnvironment(process.env)`, which keeps only
    // the allow-listed safe variables. Even if a future allow-list
    // change adds unrelated-but-safe keys (e.g. CI metadata), the
    // runner MUST NOT silently re-merge the parent secrets that the
    // sanitization explicitly stripped.
    const replacementEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/test",
      USER: "test",
      // An unrelated, non-secret key intentionally present in the
      // sanitized env — proves the runner does NOT collapse the
      // replacement env to a fixed allowlist, only that it does not
      // re-merge the parent env on top.
      POIESIS_REFRESH_LOCK_DIR: "/var/lock/poiesis",
    };
    const childEnv = await probeChildEnv({ replacementEnv });
    expect(childEnv.POIESIS_REFRESH_LOCK_DIR).toBe("/var/lock/poiesis");
    for (const key of PARENT_SECRET_KEYS) {
      expect(childEnv[key]).toBeUndefined();
    }
  });

  it("default behavior (no replacementEnv) still merges the parent env via the legacy `env` option", async () => {
    // Backward-compatibility invariant for every existing caller.
    // When `replacementEnv` is NOT supplied, the runner MUST continue
    // to merge `{...process.env, ...options.env}` so existing call
    // sites (git, gh, glab, init, update, doctor, skills, ...) keep
    // their parent-env inheritance.
    const childEnv = await probeChildEnv({
      env: { POIESIS_PROBE_OVERLAY: "overlay-value" },
    });
    expect(childEnv.POIESIS_PROBE_OVERLAY).toBe("overlay-value");
    // A parent secret that the test seeded above must still be
    // present in the child, because the legacy merge path does not
    // strip — that is the documented behavior every existing caller
    // depends on.
    expect(childEnv.OPENAI_API_KEY).toBe("parent-secret-OPENAI_API_KEY");
    expect(childEnv.POIESIS_API_KEY).toBe("parent-secret-POIESIS_API_KEY");
  });

  it("rejects passing both env and replacementEnv as INVALID_RUN_OPTIONS (fail-closed)", async () => {
    await expect(
      run(process.execPath, PROBE_ARGS, {
        cwd: tmpdir(),
        allowFailure: true,
        env: { POIESIS_PROBE: "env" },
        replacementEnv: { POIESIS_PROBE: "replacement" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUN_OPTIONS" });
  });
});

describe.skipIf(process.platform === "win32")("POSIX process-tree termination", () => {
  /**
   * A leader that ignores SIGTERM stays the process Poiesis leased for the
   * whole settlement, so the group keeps an owner at every signal and the
   * forced phase is reachable. A leader that exits with the graceful signal
   * does not: its PID, which IS the group id, becomes a free number and the
   * group is then nothing Poiesis may signal (see the GROUP_AUTHORITY_LOST
   * coverage in `tests/process-lease.test.ts`).
   */
  async function stageTree(options: {
    resistsTerm: boolean;
    leaderSurvivesTerm?: boolean;
  }): Promise<{ dir: string; parent: string; pidFile: string }> {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-tree-"));
    fixtures.push(dir);
    const descendant = join(dir, "descendant.sh");
    const parent = join(dir, "parent.sh");
    const pidFile = join(dir, "descendant.pid");
    await writeFile(
      descendant,
      [
        "#!/bin/sh",
        ...(options.resistsTerm ? ["trap '' TERM"] : []),
        "exec 0</dev/null 1>/dev/null 2>/dev/null",
        'printf "%s\\n" "$$" > "$1"',
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      parent,
      options.leaderSurvivesTerm === true
        ? `#!/bin/sh\ntrap '' TERM\n"${descendant}" "${pidFile}" &\nwhile :; do sleep 1; done\n`
        : `#!/bin/sh\n"${descendant}" "${pidFile}" &\nsleep 30\n`,
      "utf8",
    );
    await chmod(descendant, 0o755);
    await chmod(parent, 0o755);
    return { dir, parent, pidFile };
  }

  /**
   * A descendant that replaces itself with a TERM-resistant process when the
   * graceful signal arrives, and a leader that keeps the group ownable.
   *
   * The descendants are real Node processes rather than shell scripts: a shell
   * only runs a `trap ... TERM` handler between foreground commands, so on a
   * host whose `/bin/sh` is bash the handler never runs at all. A signal
   * handler is the property under test, so the process implementing it must
   * have one.
   */
  async function stageTermHandlerTree(descendantCount: number): Promise<{
    dir: string;
    parent: string;
    ownPidFiles: string[];
    replacementPidFiles: string[];
  }> {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-tree-"));
    fixtures.push(dir);
    const replacement = join(dir, "replacement.cjs");
    const descendant = join(dir, "descendant.cjs");
    const parent = join(dir, "parent.sh");
    const ownPidFiles: string[] = [];
    const replacementPidFiles: string[] = [];
    await writeFile(
      replacement,
      [
        'const { writeFileSync } = require("node:fs");',
        'writeFileSync(process.argv[2], `${process.pid}\\n`);',
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      descendant,
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        "const [replacement, replacementPidFile, ownPidFile] = process.argv.slice(2);",
        "writeFileSync(ownPidFile, `${process.pid}\\n`);",
        "process.on('SIGTERM', () => {",
        "  const forked = spawn(process.execPath, [replacement, replacementPidFile], { stdio: 'ignore' });",
        "  forked.unref();",
        "  process.exit(0);",
        "});",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );
    const spawns: string[] = [];
    for (let index = 0; index < descendantCount; index += 1) {
      const ownPidFile = join(dir, `descendant-${index}.pid`);
      const replacementPidFile = join(dir, `replacement-${index}.pid`);
      ownPidFiles.push(ownPidFile);
      replacementPidFiles.push(replacementPidFile);
      spawns.push(
        `"${process.execPath}" "${descendant}" "${replacement}" "${replacementPidFile}" "${ownPidFile}" &`,
      );
    }
    await writeFile(
      parent,
      [
        "#!/bin/sh",
        "trap '' TERM",
        "exec 0</dev/null 1>/dev/null 2>/dev/null",
        ...spawns,
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(parent, 0o755);
    return { dir, parent, ownPidFiles, replacementPidFiles };
  }

  it("terminates a normally inherited descendant before settlement", { timeout: 10_000 }, async () => {
    const { dir, parent, pidFile } = await stageTree({ resistsTerm: false });
    const invocation = run(parent, [], { cwd: dir, timeoutMs: 250 });
    const descendantPid = await waitForPid(pidFile);
    const startTime = await processStartTime(descendantPid);
    survivorPids.set(descendantPid, startTime);

    const startedAt = Date.now();
    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(await isSameProcess(descendantPid, startTime)).toBe(false);
    survivorPids.delete(descendantPid);
  });

  it("does not settle before forced escalation kills a TERM-resistant descendant", { timeout: 15_000 }, async () => {
    const { dir, parent, pidFile } = await stageTree({ resistsTerm: true, leaderSurvivesTerm: true });
    const startedAt = Date.now();
    const invocation = run(parent, [], { cwd: dir, timeoutMs: 250 });
    const descendantPid = await waitForPid(pidFile);
    const startTime = await processStartTime(descendantPid);
    survivorPids.set(descendantPid, startTime);

    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    const duration = Date.now() - startedAt;
    expect(duration).toBeGreaterThanOrEqual(2_000);
    expect(duration).toBeLessThan(6_000);
    expect(await isSameProcess(descendantPid, startTime)).toBe(false);
    survivorPids.delete(descendantPid);
  });

  it("captures and kills a TERM-handler replacement before settlement", { timeout: 15_000 }, async () => {
    const { dir, parent, ownPidFiles, replacementPidFiles } = await stageTermHandlerTree(1);
    const invocation = run(parent, [], { cwd: dir, timeoutMs: 500 });
    const descendantPid = await waitForPid(ownPidFiles[0]!);
    const descendantStartTime = await processStartTime(descendantPid);
    survivorPids.set(descendantPid, descendantStartTime);
    // The replacement exists only once the graceful signal has been handled, so
    // it is read after the group has been asked to terminate.
    const replacementPid = await waitForPid(replacementPidFiles[0]!, 3_000);
    const replacementStartTime = await processStartTime(replacementPid);
    survivorPids.set(replacementPid, replacementStartTime);

    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(await isSameProcess(descendantPid, descendantStartTime)).toBe(false);
    expect(await isSameProcess(replacementPid, replacementStartTime)).toBe(false);
    survivorPids.delete(descendantPid);
    survivorPids.delete(replacementPid);
  });

  /**
   * Coverage for the settlement window in which a descendant appears AFTER the
   * graceful signal was sent. There is no member snapshot to miss it any more:
   * the group is addressed as a group, so a replacement forked inside the grace
   * window is still inside the group the forced signal reaches. Repeated enough
   * times that the window reliably surfaces if it is ever left unguarded.
   */
  it(
    "captures every TERM-handler replacement across repeated settlement attempts",
    { timeout: 60_000 },
    async () => {
      const repeats = 5;
      for (let attempt = 0; attempt < repeats; attempt += 1) {
        const { dir, parent, ownPidFiles, replacementPidFiles } = await stageTermHandlerTree(1);
        const invocation = run(parent, [], { cwd: dir, timeoutMs: 500 });
        const descendantPid = await waitForPid(ownPidFiles[0]!);
        const descendantStartTime = await processStartTime(descendantPid);
        survivorPids.set(descendantPid, descendantStartTime);
        const replacementPid = await waitForPid(replacementPidFiles[0]!, 3_000);
        const replacementStartTime = await processStartTime(replacementPid);
        survivorPids.set(replacementPid, replacementStartTime);

        await expect(invocation).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
        expect(await isSameProcess(descendantPid, descendantStartTime)).toBe(false);
        expect(await isSameProcess(replacementPid, replacementStartTime)).toBe(false);
        survivorPids.delete(descendantPid);
        survivorPids.delete(replacementPid);
      }
    },
  );

  // Several TERM-handling descendants, each spawning its own TERM-resistant
  // replacement inside the same grace window.
  it(
    "captures and kills multiple TERM-handler replacements before settlement",
    { timeout: 20_000 },
    async () => {
      const { dir, parent, ownPidFiles, replacementPidFiles } = await stageTermHandlerTree(4);
      const invocation = run(parent, [], { cwd: dir, timeoutMs: 500 });

      const trackedPids: Array<{ pid: number; startTime: string | null }> = [];
      for (const [index, pidFile] of ownPidFiles.entries()) {
        const pid = await waitForPid(pidFile, 3_000);
        const startTime = await processStartTime(pid);
        survivorPids.set(pid, startTime);
        trackedPids.push({ pid, startTime });
        const replacementPid = await waitForPid(replacementPidFiles[index]!, 3_000);
        const replacementStartTime = await processStartTime(replacementPid);
        survivorPids.set(replacementPid, replacementStartTime);
        trackedPids.push({ pid: replacementPid, startTime: replacementStartTime });
      }

      await expect(invocation).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
      for (const { pid, startTime } of trackedPids) {
        expect(await isSameProcess(pid, startTime)).toBe(false);
        survivorPids.delete(pid);
      }
    },
  );
});

/**
 * Spec #168 / ticket #170 — the Windows cleanup model.
 *
 * Windows has no POSIX process groups and no readable process-start
 * identity, so `taskkill /PID <pid> /T` is the only tree-addressing
 * primitive available. Its one safety property is the same as any
 * by-PID call: it is only meaningful while the PID is still the process
 * Poiesis spawned. Once the child has exited, that PID is reaped and may
 * already be recycled, so `run()` must not address it at all — not for a
 * normal completion, and not for the linger window either.
 *
 * `process.platform` is redefined for the duration of each test so the
 * Windows branch of the real module runs on this host; the `taskkill`
 * helper is faked so its invocations are observable.
 */
describe("Windows cleanup model", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let taskkillCalls: string[][] = [];
  let killSignalledPids: number[] = [];

  async function runAsWindows(
    command: string,
    args: string[],
    options: Parameters<typeof run>[2],
  ): Promise<Awaited<ReturnType<typeof run>>> {
    taskkillCalls = [];
    killSignalledPids = [];
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((...spawnArgs: unknown[]) => {
          if (spawnArgs[0] !== "taskkill") {
            return Reflect.apply(actual.spawn, undefined, spawnArgs) as ChildProcess;
          }
          const argv = spawnArgs[1] as string[];
          taskkillCalls.push(argv);
          const helper = new EventEmitter() as ChildProcess;
          Object.assign(helper, { kill: () => true });
          // The graceful phase always fails, so the forced phase is what
          // actually ends the run — this is the only case where Poiesis may
          // escalate by PID.
          setTimeout(() => {
            killSignalledPids.push(Number(argv[1]));
            helper.emit("close", argv.includes("/F") ? 0 : 1);
          }, 25);
          return helper;
        }) as typeof actual.spawn,
      };
    });
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    try {
      const mocked = await import("../src/process.js");
      return await mocked.run(command, args, options);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("never addresses a by-PID taskkill when the command completed normally", { timeout: 30_000 }, async () => {
    const result = await runAsWindows(process.execPath, ["-e", "process.stdout.write('done')"], {
      cwd: tmpdir(),
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "done" });
    // The child exited and its PID was reaped. Addressing it now could hit
    // an unrelated process that inherited the recycled PID.
    expect(taskkillCalls).toEqual([]);
    expect(killSignalledPids).toEqual([]);
  });

  it("does not address a by-PID taskkill for the linger window after a normal exit", { timeout: 60_000 }, async () => {
    // A descendant that outlives the child keeps the inherited pipes open,
    // which arms the post-exit linger window. On Windows that window must
    // still not signal the exited child's recycled PID.
    const { script } = await stageScript(
      "#!/bin/sh\n(sleep 30) &\nprintf early\nexit 0\n",
    );
    const result = await runAsWindows(script, [], { cwd: tmpdir() });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(taskkillCalls).toEqual([]);
    expect(killSignalledPids).toEqual([]);
  });

  it("awaits taskkill and forces immediately while the original child is active", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const taskkillCalls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((...args: unknown[]) => {
          if (args[0] !== "taskkill") {
            return Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
          }

          const argv = args[1] as string[];
          taskkillCalls.push(argv);
          const helper = new EventEmitter() as ChildProcess;
          Object.assign(helper, { kill: () => true });
          setTimeout(() => {
            if (argv.includes("/F")) {
              process.kill(Number(argv[1]), "SIGKILL");
              helper.emit("close", 0);
            } else {
              helper.emit("close", 1);
            }
          }, 75);
          return helper;
        }) as typeof actual.spawn,
      };
    });

    try {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
      const mocked = await import("../src/process.js");
      Object.defineProperty(process, "platform", originalPlatform);
      const startedAt = Date.now();
      await expect(
        mocked.run(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
          cwd: tmpdir(),
          timeoutMs: 50,
        }),
      ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(175);
      expect(taskkillCalls).toEqual([
        ["/PID", expect.any(String), "/T"],
        ["/PID", expect.any(String), "/T", "/F"],
      ]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

describe("stdin errors", () => {
  it("repeatedly preserves clean exit after stdin peer closure", { timeout: 20_000 }, async () => {
    const { script } = await stageScript("#!/bin/sh\nexec 0<&-\nsleep 0.05\nexit 0\n");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        run(script, [], { cwd: tmpdir(), input: "x".repeat(1024 * 1024) }),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
  });

  it("does not let stdin peer closure mask command failure", async () => {
    const { script } = await stageScript("#!/bin/sh\nexec 0<&-\nsleep 0.05\nexit 7\n");
    await expect(
      run(script, [], { cwd: tmpdir(), input: "x".repeat(1024 * 1024) }),
    ).rejects.toMatchObject({ code: "COMMAND_FAILED", details: { exitCode: 7 } });
  });

  it("surfaces an unexpected stdin error through the full lifecycle", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((...args: unknown[]) => {
          const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
          queueMicrotask(() => {
            const error = Object.assign(new Error("synthetic stdin failure"), { code: "EIO" });
            child.stdin?.emit("error", error);
          });
          return child;
        }) as typeof actual.spawn,
      };
    });

    try {
      const mocked = await import("../src/process.js");
      await expect(
        mocked.run(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
          cwd: tmpdir(),
          input: "input",
        }),
      ).rejects.toMatchObject({
        code: "COMMAND_IO_ERROR",
        details: { causeMessage: "synthetic stdin failure" },
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

describe("UTF-8 byte bounds", () => {
  it("is independent of producer write partitioning at the byte cap", async () => {
    const text = "aé中😀z";
    const bytes = Buffer.from(text, "utf8");
    const whole = await run(
      process.execPath,
      ["-e", `process.stdout.write(Buffer.from("${bytes.toString("hex")}", "hex"))`],
      { cwd: tmpdir(), maxBytes: 8 },
    );
    const split = await run(
      process.execPath,
      [
        "-e",
        `const b=Buffer.from("${bytes.toString("hex")}","hex");let i=0;` +
          "const write=()=>{if(i===b.length)return;process.stdout.write(b.subarray(i,i+1));i++;setTimeout(write,2)};write()",
      ],
      { cwd: tmpdir(), maxBytes: 8 },
    );
    expect(whole.stdout).toBe("aé中");
    expect(split.stdout).toBe(whole.stdout);
    expect(split.stdout).not.toContain("\uFFFD");
    expect(whole.stdoutTruncated).toBe(true);
    expect(split.stdoutTruncated).toBe(true);
  });

  it("maintains independent exact and over-cap budgets for stdout and stderr", async () => {
    const result = await run(
      process.execPath,
      ["-e", 'process.stdout.write("é中");process.stderr.write("😀😀")'],
      { cwd: tmpdir(), maxBytes: 5 },
    );
    expect(result.stdout).toBe("é中");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderr).toBe("😀");
    expect(result.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(5);
  });

  it("drops a terminal incomplete sequence and reports truncation", async () => {
    const result = await run(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0xe2, 0x82]))"],
      { cwd: tmpdir(), maxBytes: 10 },
    );
    expect(result.stdout).toBe("");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("returns only the valid prefix before malformed UTF-8", async () => {
    const result = await run(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0x61, 0x80, 0x62]))"],
      { cwd: tmpdir(), maxBytes: 10 },
    );
    expect(result.stdout).toBe("a");
    expect(result.stdout).not.toContain("\uFFFD");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("never returns a partial code point when maxBytes cuts a valid sequence", async () => {
    const result = await run(
      process.execPath,
      ["-e", 'process.stdout.write("é")'],
      { cwd: tmpdir(), maxBytes: 1 },
    );
    expect(result.stdout).toBe("");
    expect(result.stdoutTruncated).toBe(true);
  });
});

describe("bounded", () => {
  it("leaves under-cap values unchanged", () => {
    expect(bounded("hello", 5)).toBe("hello");
  });

  it("retains complete UTF-8 prefixes and reports omitted encoded bytes", () => {
    const value = "aé中😀z";
    const totalBytes = Buffer.byteLength(value, "utf8");
    for (let limit = 1; limit < totalBytes; limit += 1) {
      let prefix = "";
      for (const character of value) {
        if (Buffer.byteLength(prefix + character, "utf8") > limit) break;
        prefix += character;
      }
      const retainedBytes = Buffer.byteLength(prefix, "utf8");
      expect(bounded(value, limit)).toBe(
        `${prefix}\n... truncated ${totalBytes - retainedBytes} bytes`,
      );
    }
  });
});

/**
 * Spec #168 / ticket #183 — an error envelope that clips its output must SAY it
 * clipped it.
 *
 * A timeout or a cancellation rejection carries the captured streams inside
 * `details`, bounded by a fixed 8,000-byte envelope bound that has nothing to do
 * with the runner's own capture bound. Before this ticket the envelope
 * kept the PROCESS capture flags only, so a command that emitted 50 KiB and was
 * killed at its timeout produced an 8,000-byte `details.stdout` beside
 * `stdoutTruncated: false`: the text was silently short and the flag claimed it
 * was whole. Focused evidence and Verify receipt evidence both read that flag,
 * and neither could re-detect the clip on a rejected run (there is no
 * `RunResult` to compare against), so a bounded envelope became authoritative
 * evidence of complete output.
 *
 * These assertions are about the public `run` rejection itself: the flags must
 * be truthful, the text must stay bounded, and the typed code / exit status /
 * precedence of the rejection must be exactly what they were.
 */
describe("error-envelope output bounding (Spec #168 / ticket #183)", () => {
  /** The one rejection, so its details can be read field by field. */
  async function rejectionOf(invocation: Promise<unknown>): Promise<PoiesisError> {
    try {
      await invocation;
    } catch (error) {
      return error as PoiesisError;
    }
    throw new Error("expected the run to reject, but it resolved");
  }

  /** A script that emits `bytes` on stdout and then hangs until it is signalled. */
  function emittingHang(bytes: number): string {
    return `#!/bin/sh\nhead -c ${bytes} /dev/zero | tr '\\0' x\nsleep 30\n`;
  }

  it("reports the envelope's own clip on both streams of a timed-out command", { timeout: 20_000 }, async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nhead -c 50000 /dev/zero | tr '\\0' x\nhead -c 20000 /dev/zero | tr '\\0' y 1>&2\nsleep 30\n",
    );

    const failure = await rejectionOf(run(script, [], { cwd: tmpdir(), timeoutMs: 1_000 }));

    // The typed outcome is untouched: same code, same exit status, same priority.
    expect(failure.code).toBe("COMMAND_TIMEOUT");
    expect(failure.exitCode).toBe(124);
    // The defect: both streams were clipped by the envelope, and both say so.
    expect(failure.details.stdoutTruncated).toBe(true);
    expect(failure.details.stderrTruncated).toBe(true);
    const stdout = String(failure.details.stdout);
    const stderr = String(failure.details.stderr);
    expect(stdout).toMatch(/\.\.\. truncated \d+ bytes$/);
    expect(stderr).toMatch(/\.\.\. truncated \d+ bytes$/);
    // Still bounded: the envelope remains a fixed bound, not the raw capture.
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(8_000 + 64);
    expect(Buffer.byteLength(stderr, "utf8")).toBeLessThanOrEqual(8_000 + 64);
  });

  it("reports the envelope's own clip on both streams of a cancelled command", { timeout: 20_000 }, async () => {
    const { script } = await stageScript(
      "#!/bin/sh\nhead -c 50000 /dev/zero | tr '\\0' x\nhead -c 20000 /dev/zero | tr '\\0' y 1>&2\nsleep 30\n",
    );
    const controller = new AbortController();
    const invocation = run(script, [], { cwd: tmpdir(), signal: controller.signal });
    setTimeout(() => controller.abort(), 1_000);

    const failure = await rejectionOf(invocation);

    expect(failure.code).toBe("COMMAND_CANCELLED");
    expect(failure.exitCode).toBe(130);
    expect(failure.details.stdoutTruncated).toBe(true);
    expect(failure.details.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(String(failure.details.stdout), "utf8")).toBeLessThanOrEqual(8_000 + 64);
    expect(Buffer.byteLength(String(failure.details.stderr), "utf8")).toBeLessThanOrEqual(8_000 + 64);
  });

  it("still reports a small timed-out command's output as complete", { timeout: 20_000 }, async () => {
    const { script } = await stageScript("#!/bin/sh\nprintf small\nsleep 30\n");

    const failure = await rejectionOf(run(script, [], { cwd: tmpdir(), timeoutMs: 1_000 }));

    expect(failure.code).toBe("COMMAND_TIMEOUT");
    expect(failure.details.stdout).toBe("small");
    expect(failure.details.stdoutTruncated).toBe(false);
    expect(failure.details.stderrTruncated).toBe(false);
  });

  it("retains the captured output a caller's own evidence limit asks for", { timeout: 20_000 }, async () => {
    // 12,000 bytes, more than the envelope's fixed 8,000-byte default and less
    // than the requested 20,000-byte limit: the downstream surface asked for
    // more than the fixed bound, so the envelope must not clip below what its
    // own caller will retain, and a complete capture must read as complete.
    const { script } = await stageScript(emittingHang(12_000));

    const failure = await rejectionOf(
      run(script, [], { cwd: tmpdir(), timeoutMs: 1_000, outputLimit: 20_000 }),
    );

    expect(failure.code).toBe("COMMAND_TIMEOUT");
    expect(Buffer.byteLength(String(failure.details.stdout), "utf8")).toBe(12_000);
    expect(failure.details.stdout).not.toContain("truncated");
    expect(failure.details.stdoutTruncated).toBe(false);
  });

  it("reports the clip when the retained output still exceeds the requested limit", { timeout: 20_000 }, async () => {
    const { script } = await stageScript(emittingHang(50_000));

    const failure = await rejectionOf(
      run(script, [], { cwd: tmpdir(), timeoutMs: 1_000, outputLimit: 20_000 }),
    );

    expect(failure.details.stdoutTruncated).toBe(true);
    const stdout = String(failure.details.stdout);
    expect(stdout).toMatch(/\.\.\. truncated \d+ bytes$/);
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(20_000 + 64);
  });

  it("refuses a malformed requested evidence limit instead of guessing one", () => {
    return expect(run(process.execPath, ["-e", "process.exit(0)"], { cwd: tmpdir(), outputLimit: 0 })).rejects.toMatchObject({
      code: "INVALID_OUTPUT_LIMIT",
    });
  });
});

describe("boundedOutput", () => {
  it("reports whether the bound clipped the value", () => {
    expect(boundedOutput("hello", 8)).toEqual({ text: "hello", clipped: false });
    const clipped = boundedOutput("hello world", 5);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text).toBe(bounded("hello world", 5));
  });

  it("agrees with bounded() on the text for every value it bounds", () => {
    const value = "aé中😀z".repeat(50);
    for (const limit of [1, 7, 8, 120, 8_000]) {
      expect(boundedOutput(value, limit).text).toBe(bounded(value, limit));
    }
  });
});

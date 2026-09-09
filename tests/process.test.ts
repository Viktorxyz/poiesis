import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bounded, run } from "../src/process.js";

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

describe.skipIf(process.platform === "win32")("POSIX process-tree termination", () => {
  async function stageTree(resistsTerm: boolean): Promise<{
    dir: string;
    parent: string;
    pidFile: string;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-tree-"));
    fixtures.push(dir);
    const descendant = join(dir, "descendant.sh");
    const parent = join(dir, "parent.sh");
    const pidFile = join(dir, "descendant.pid");
    await writeFile(
      descendant,
      [
        "#!/bin/sh",
        ...(resistsTerm ? ["trap '' TERM"] : []),
        "exec 0</dev/null 1>/dev/null 2>/dev/null",
        'printf "%s\\n" "$$" > "$1"',
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      parent,
      `#!/bin/sh\n"${descendant}" "${pidFile}" &\nsleep 30\n`,
      "utf8",
    );
    await chmod(descendant, 0o755);
    await chmod(parent, 0o755);
    return { dir, parent, pidFile };
  }

  it("terminates a normally inherited descendant before settlement", { timeout: 10_000 }, async () => {
    const { dir, parent, pidFile } = await stageTree(false);
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
    const { dir, parent, pidFile } = await stageTree(true);
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
    const dir = await mkdtemp(join(tmpdir(), "poiesis-tree-"));
    fixtures.push(dir);
    const parent = join(dir, "parent.sh");
    const descendant = join(dir, "descendant.sh");
    const replacement = join(dir, "replacement.sh");
    const descendantPidFile = join(dir, "descendant.pid");
    const replacementPidFile = join(dir, "replacement.pid");

    await writeFile(
      replacement,
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
    await writeFile(
      descendant,
      [
        "#!/bin/sh",
        'replacement="$1"',
        'own_pid="$2"',
        'replacement_pid="$3"',
        `trap '"$replacement" "$replacement_pid" & exit 0' TERM`,
        "exec 0</dev/null 1>/dev/null 2>/dev/null",
        'printf "%s\\n" "$$" > "$own_pid"',
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      parent,
      `#!/bin/sh\n"${descendant}" "${replacement}" "${descendantPidFile}" "${replacementPidFile}" &\nsleep 30\n`,
      "utf8",
    );
    await chmod(replacement, 0o755);
    await chmod(descendant, 0o755);
    await chmod(parent, 0o755);

    const invocation = run(parent, [], { cwd: dir, timeoutMs: 500 });
    const descendantPid = await waitForPid(descendantPidFile);
    const descendantStartTime = await processStartTime(descendantPid);
    survivorPids.set(descendantPid, descendantStartTime);
    const replacementPid = await waitForPid(replacementPidFile, 3_000);
    const replacementStartTime = await processStartTime(replacementPid);
    survivorPids.set(replacementPid, replacementStartTime);

    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(await isSameProcess(descendantPid, descendantStartTime)).toBe(false);
    expect(await isSameProcess(replacementPid, replacementStartTime)).toBe(false);
    survivorPids.delete(descendantPid);
    survivorPids.delete(replacementPid);
  });
});

describe("Windows termination seam", () => {
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

/**
 * Spec #168 / ticket #176 — the one platform-aware command-processor seam.
 *
 * Verify and Focused Check both execute caller-supplied COMMAND TEXT. Before
 * this ticket that text went to a hardcoded `/bin/sh`, which simply does not
 * exist on Windows and which no caller could validate, point at a different
 * processor, or get a typed failure from when it was missing.
 *
 * The seam resolves ONE processor per platform:
 *   - POSIX      `/bin/sh` with `["-c", <exact command>]`
 *   - Windows    a validated absolute `ComSpec`/`cmd.exe` with
 *                `["/d", "/s", "/c", <exact command>]`
 * and it never mutates the command, never falls back to `shell: true`, and
 * never substitutes PowerShell. A processor that is missing, relative,
 * malformed, or not executable is a typed, actionable infrastructure failure
 * raised BEFORE any process exists.
 *
 * The Verify assertions run through the real public `verify()` seam and observe
 * what the public `run()` seam actually received.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCommandProcessorInvocation } from "../src/command-processor.js";
import * as processModule from "../src/process.js";
import { verify } from "../src/git.js";
import { createTestRepository, itManagedExecution } from "./helpers.js";

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
const fixtures: string[] = [];

afterEach(async () => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  vi.doUnmock("node:fs");
  vi.resetModules();
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

/** A real, absolute, executable `cmd.exe` stand-in on the Windows path. */
async function stageWindowsComSpec(dir: string, name = "cmd.exe"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "MZ fake command processor\n", "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("command processor argv", () => {
  it("uses /bin/sh with -c on a POSIX platform and passes the command through unchanged", () => {
    const command = `printf "%s" 'a b' && exit 0`;
    expect(buildCommandProcessorInvocation(command, { platform: "linux" })).toEqual({
      command: "/bin/sh",
      args: ["-c", command],
    });
    expect(buildCommandProcessorInvocation(command, { platform: "darwin" })).toEqual({
      command: "/bin/sh",
      args: ["-c", command],
    });
  });

  it("uses the validated absolute ComSpec with /d /s /c on Windows", async () => {
    const dir = await scratch("poiesis-comspec-");
    const comSpec = await stageWindowsComSpec(dir);
    const command = "pnpm test -- --run";
    const invocation = buildCommandProcessorInvocation(command, {
      platform: "win32",
      env: { ComSpec: comSpec },
    });
    expect(invocation).toEqual({ command: comSpec, args: ["/d", "/s", "/c", command] });
  });

  it("accepts a case-different but valid ComSpec spelling", async () => {
    const dir = await scratch("poiesis-comspec-case-");
    const comSpec = await stageWindowsComSpec(dir, "CMD.EXE");
    expect(
      buildCommandProcessorInvocation("dir", { platform: "win32", env: { ComSpec: comSpec } }).command,
    ).toBe(comSpec);
  });

  it("accepts the real Windows shape C:\\Windows\\System32\\cmd.exe", () => {
    // The value every Windows installation actually uses. `win32` path
    // semantics are what make it validate: a POSIX basename would return the
    // whole string and refuse the one value that is correct. The existence
    // check is injected so the assertion does not need this host to have a
    // `C:\\` drive at all.
    const command = "pnpm test -- --run";
    const invocation = buildCommandProcessorInvocation(command, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      isFile: () => true,
    });
    expect(invocation).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", command],
    });
  });

  it("refuses the Windows shape when the injected probe reports no such file", () => {
    expectProcessorRefusal(
      () =>
        buildCommandProcessorInvocation("dir", {
          platform: "win32",
          env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
          isFile: () => false,
        }),
      { reason: "COMSPEC_UNAVAILABLE", processor: "C:\\Windows\\System32\\cmd.exe" },
    );
  });
});

/**
 * Assert one typed pre-spawn refusal. `toMatchObject` matches `details`
 * recursively as a SUBSET, which is what these assertions mean: the reason and
 * platform identify the failure, and the extra guidance fields are additive.
 */
function expectProcessorRefusal(invoke: () => unknown, details: Record<string, unknown>): void {
  let thrown: unknown = null;
  try {
    invoke();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: "COMMAND_PROCESSOR_UNAVAILABLE", details });
}

describe("unavailable command processors are typed, actionable, pre-spawn failures", () => {
  it("refuses a missing ComSpec with COMSPEC_MISSING", () => {
    expectProcessorRefusal(() => buildCommandProcessorInvocation("dir", { platform: "win32", env: {} }), {
      reason: "COMSPEC_MISSING",
      platform: "win32",
    });
  });

  it("refuses a relative ComSpec", () => {
    expectProcessorRefusal(
      () => buildCommandProcessorInvocation("dir", { platform: "win32", env: { ComSpec: "cmd.exe" } }),
      { reason: "COMSPEC_NOT_ABSOLUTE", platform: "win32" },
    );
  });

  it("refuses a ComSpec that is not the Windows command processor", async () => {
    const dir = await scratch("poiesis-comspec-wrong-");
    const impostor = await stageWindowsComSpec(dir, "powershell.exe");
    expectProcessorRefusal(
      () => buildCommandProcessorInvocation("dir", { platform: "win32", env: { ComSpec: impostor } }),
      { reason: "COMSPEC_NOT_COMMAND_PROCESSOR", platform: "win32" },
    );
  });

  it("refuses an absolute ComSpec that does not exist", () => {
    const missing = join(tmpdir(), "poiesis-absent-cmd", "cmd.exe");
    expect(existsSync(missing)).toBe(false);
    expectProcessorRefusal(
      () => buildCommandProcessorInvocation("dir", { platform: "win32", env: { ComSpec: missing } }),
      { reason: "COMSPEC_UNAVAILABLE", platform: "win32" },
    );
  });

  it("refuses a POSIX processor that is not executable", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        accessSync: ((path: string, ...rest: unknown[]) => {
          if (path === "/bin/sh") {
            throw Object.assign(new Error("not executable"), { code: "EACCES" });
          }
          return Reflect.apply(actual.accessSync, undefined, [path, ...rest]) as void;
        }) as typeof actual.accessSync,
      };
    });
    const processor = await import("../src/command-processor.js");
    expectProcessorRefusal(() => processor.buildCommandProcessorInvocation("true", { platform: "linux" }), {
      reason: "PROCESSOR_NOT_EXECUTABLE",
      platform: "linux",
      processor: "/bin/sh",
    });
  });
});

describe("Verify runs its plan through the shared command-processor seam", () => {
  itManagedExecution(
    "spawns the resolved processor with the exact plan command and the strong containment model",
    { timeout: 60_000 },
    async () => {
      const repository = await createTestRepository();
      fixtures.push(repository.parent);
      const recorder = vi.spyOn(processModule, "run");
      try {
        await verify({
          cwd: repository.root,
          candidateSha: repository.baseSha,
          commands: [`printf "%s" seam-probe`],
        });
        const verification = recorder.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "-c");
        expect(verification?.[0]).toBe("/bin/sh");
        expect(verification?.[1]).toEqual(["-c", `printf "%s" seam-probe`]);
        // Arbitrary command text is the surface that must not run without the
        // strong containment capability, so the seam asks for it explicitly.
        expect(verification?.[2]).toMatchObject({ operationId: "poiesis-verify", containment: "cgroup-v2" });
      } finally {
        recorder.mockRestore();
      }
    },
  );

  it("refuses the plan with COMMAND_PROCESSOR_UNAVAILABLE and spawns nothing when the processor is gone", { timeout: 60_000 }, async () => {
    const repository = await createTestRepository();
    fixtures.push(repository.parent);
    const shellSpawns: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        accessSync: ((path: string, ...rest: unknown[]) => {
          if (path === "/bin/sh") {
            throw Object.assign(new Error("not executable"), { code: "EACCES" });
          }
          return Reflect.apply(actual.accessSync, undefined, [path, ...rest]) as void;
        }) as typeof actual.accessSync,
      };
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((command: string, ...rest: unknown[]) => {
          if (String(command).includes("sh")) shellSpawns.push(String(command));
          return Reflect.apply(actual.spawn, undefined, [command, ...rest]) as ChildProcess;
        }) as typeof actual.spawn,
      };
    });
    try {
      const git = await import("../src/git.js");
      await expect(
        git.verify({
          cwd: repository.root,
          candidateSha: repository.baseSha,
          commands: [`printf "%s" never`],
        }),
      ).rejects.toMatchObject({
        code: "COMMAND_PROCESSOR_UNAVAILABLE",
        details: { reason: "PROCESSOR_NOT_EXECUTABLE" },
      });
      // No processor, no plan command: the refusal precedes the shell entirely.
      expect(shellSpawns).toEqual([]);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
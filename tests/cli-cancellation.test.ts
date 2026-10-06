/**
 * Spec #168 / ticket #176 — CLI cancellation through the public dispatch.
 *
 * SIGINT / SIGTERM on the CLI were previously not connected to anything: the
 * default handlers terminated the process immediately, so a long Verify or a
 * long focused check was cut off with no settled managed process, no typed
 * outcome, and (for Verify) whatever the interruption happened to leave behind.
 *
 * The contract this file pins:
 *   - handlers are installed ONLY for the operations that consume a signal —
 *     `verify` and `check`. Every other subcommand keeps the platform default
 *     signal behaviour untouched, because replacing it would silently change
 *     Ctrl-C for `doctor`, `inspect`, `init`, and the rest;
 *   - ONE invocation-scoped AbortController per cancellable dispatch;
 *   - temporary SIGINT/SIGTERM handlers, removed in `finally`;
 *   - the FIRST signal aborts once; repeated signals are idempotent and cannot
 *     start a second cleanup;
 *   - the next invocation starts fresh (a new, un-aborted controller);
 *   - the signal reaches the managed command path, so the run settles with
 *     `COMMAND_CANCELLED` — unless a cleanup failure dominates it;
 *   - a cancelled, incomplete Verify issues NO authoritative receipt;
 *   - a library caller that supplies its own signal keeps it, and Poiesis
 *     installs no process-wide handlers on its behalf.
 *
 * The tests that actually execute a strongly contained managed command are
 * gated on the host capability. The signal-SCOPE assertions are not: they
 * install and remove handlers on operations that never reach a contained
 * command, so they run everywhere and are the ones that must hold on a host
 * with no containment at all.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchCli } from "../src/cli.js";
import { run } from "../src/process.js";
import { workspacePrepare, type WorkspaceIdentity } from "../src/git.js";
import { init } from "../src/maintenance.js";
import { VERIFICATION_RECEIPT_DIRECTORY } from "../src/verification-receipt.js";
import * as processModule from "../src/process.js";
import { createTestRepository, describeManagedExecution, testConfig, type TestRepository } from "./helpers.js";

const PLAN_COMMAND = "sleep 30";

let repository: TestRepository;
let plainRepository: TestRepository;
let commonDir: string;
let candidate: WorkspaceIdentity | null = null;
const cleanupDirs: string[] = [];
const CLONE_DIR = join(import.meta.dirname, "..", ".poiesis-cancel-bin");

beforeAll(async () => {
  repository = await createTestRepository();
  plainRepository = await createTestRepository();
  await init(
    repository.root,
    { ...testConfig(repository), verification: { commands: [PLAN_COMMAND] } },
    { skipSkills: true, allowFixtureAdapters: true },
  );
  const reported = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: repository.root })).stdout;
  commonDir = await realpath(isAbsolute(reported) ? reported : resolve(repository.root, reported));
  candidate = await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch: "poiesis/spec-cli-cancellation",
    specId: "spec-cli-cancellation",
  });
}, 240_000);

afterAll(async () => {
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  await rm(CLONE_DIR, { recursive: true, force: true });
  if (repository !== undefined) await rm(repository.parent, { recursive: true, force: true });
  if (plainRepository !== undefined) await rm(plainRepository.parent, { recursive: true, force: true });
});

async function receiptFiles(): Promise<string[]> {
  try {
    return (await readdir(join(commonDir, VERIFICATION_RECEIPT_DIRECTORY))).sort();
  } catch {
    return [];
  }
}

/** Dispatch without letting the structured envelope pollute the test output. */
async function dispatchQuietly(
  argv: string[],
  dispatch: (args: string[]) => Promise<unknown> = dispatchCli,
): Promise<unknown> {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await dispatch(argv);
    return null;
  } catch (error) {
    return error;
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/**
 * Script ONLY the admission prologue's managed child.
 *
 * Everything else — every `git` call Verify makes around the plan — runs for
 * real, so the run reaches the managed command with a genuine provisioned
 * cgroup v2 leaf. Inside that leaf's admission window the operator interrupts
 * and the prologue then confirms, which is precisely the window in which
 * `AbortSignal` will not replay the abort to a listener that has not been
 * installed yet.
 *
 * The admitted command then exits 0, which is what makes the loss material: an
 * operator-cancelled Verify that keeps going resolves `verified`, and `verify()`
 * mints an authoritative receipt for it.
 */
function interruptDuringAdmission(): void {
  vi.resetModules();
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      spawn: ((command: string, ...rest: unknown[]) => {
        const argv = (rest[0] as string[]) ?? [];
        if (command !== "/bin/sh" || !argv.includes("poiesis-admission")) {
          return Reflect.apply(actual.spawn, undefined, [command, ...rest]) as ChildProcess;
        }
        const fake = new EventEmitter() as ChildProcess;
        const report = new PassThrough();
        Object.assign(fake, {
          pid: undefined,
          stdin: null,
          stdout: null,
          stderr: null,
          stdio: [null, null, null, report],
          kill: () => true,
          unref: () => fake,
        });
        setImmediate(() => {
          // Ctrl-C while the run is being admitted.
          process.emit("SIGINT");
          // The prologue then confirms and the admitted command succeeds.
          report.write("a");
          setTimeout(() => {
            report.end();
            fake.emit("exit", 0, null);
          }, 50);
        });
        return fake;
      }) as typeof actual.spawn,
    };
  });
}

function verifyArgv(): string[] {
  return ["verify", "--sha", candidate!.headSha, "--cwd", candidate!.path];
}

function checkArgv(...commands: string[]): string[] {
  return [
    "check",
    ...commands.flatMap((command) => ["--command", command]),
    "--cwd",
    candidate!.path,
    "--ownership-id",
    candidate!.ownershipId,
  ];
}

function signalBaseline(): { int: number; term: number } {
  return { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
}

describe("CLI signal scope (Spec #168 / ticket #176)", () => {
  it("installs no handlers for an operation that does not consume cancellation", { timeout: 60_000 }, async () => {
    const baseline = signalBaseline();
    expect(await dispatchQuietly(["inspect", "--cwd", plainRepository.root])).toBeNull();
    // `inspect` never reads a signal, so taking SIGINT/SIGTERM over on its
    // behalf would change Ctrl-C behaviour for nothing.
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.term);
  });

  it("installs no handlers for an unknown command", { timeout: 60_000 }, async () => {
    const baseline = signalBaseline();
    expect(await dispatchQuietly(["not-a-command"])).toMatchObject({ code: "UNKNOWN_COMMAND" });
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.term);
  });

  it("installs exactly one handler pair for a cancellable operation and removes it", { timeout: 60_000 }, async () => {
    // `verify` in a repository that never installed Poiesis resolves authority
    // and then refuses on the missing config — no contained command runs, so
    // this proves the handler lifetime without needing containment at all. The
    // handlers go up synchronously with the dispatch, so the "installed" half is
    // observable before the operation settles.
    const baseline = signalBaseline();
    const invocation = dispatchQuietly(["verify", "--sha", "0".repeat(40), "--cwd", plainRepository.root]);
    expect(process.listenerCount("SIGINT")).toBe(baseline.int + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.term + 1);
    expect(await invocation).not.toBeNull();
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.term);
  });

  it("starts the next cancellable invocation fresh, with no accumulated listeners", { timeout: 60_000 }, async () => {
    const baseline = signalBaseline();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const invocation = dispatchQuietly(["verify", "--sha", "0".repeat(40), "--cwd", plainRepository.root]);
      expect(process.listenerCount("SIGINT")).toBe(baseline.int + 1);
      expect(process.listenerCount("SIGTERM")).toBe(baseline.term + 1);
      await invocation;
      expect(process.listenerCount("SIGINT")).toBe(baseline.int);
      expect(process.listenerCount("SIGTERM")).toBe(baseline.term);
    }
  });
});

describeManagedExecution("CLI cancellation of managed commands (Spec #168 / ticket #176)", () => {
  it("cancels a running Verify with COMMAND_CANCELLED and removes its signal listeners", { timeout: 60_000 }, async () => {
    const before = await receiptFiles();
    const baseline = signalBaseline();
    const invocation = dispatchQuietly(verifyArgv());

    await new Promise((r) => setTimeout(r, 500));
    expect(process.listenerCount("SIGINT")).toBe(baseline.int + 1);
    process.emit("SIGINT");
    const error = await invocation;

    expect(error).toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
    // A cancelled, incomplete Verify issued no authoritative receipt.
    expect(await receiptFiles()).toEqual(before);
    // The handlers were temporary.
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.term);
  });

  it("surfaces a cancelled focused check as COMMAND_CANCELLED with its complete evidence", { timeout: 60_000 }, async () => {
    const baseline = signalBaseline();
    const invocation = dispatchQuietly(checkArgv(`printf "%s" first`, PLAN_COMMAND));
    await new Promise((r) => setTimeout(r, 700));
    process.emit("SIGINT");
    const error = await invocation;

    // The cancellation identity, not FOCUSED_CHECK_FAILED: the operator pressed
    // Ctrl-C, and saying their code failed would be a different fact.
    expect(error).toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
    const check = (error as { details: { check: FocusedShape } }).details.check;
    // The bounded evidence is still attached, and the closed vocabulary is
    // unchanged: an unattributable rejection is `infrastructure`.
    expect(check).toMatchObject({
      scope: "focused",
      authoritative: false,
      outcome: "failed",
      classification: "infrastructure",
    });
    expect(check.commands).toHaveLength(2);
    expect(check.commands?.[0]).toMatchObject({ index: 0, status: "passed", classification: "passed" });
    expect(check.commands?.[1]).toMatchObject({ index: 1, failureCode: "COMMAND_CANCELLED" });
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
  });

  it("still reports a genuinely failed focused command as FOCUSED_CHECK_FAILED", { timeout: 60_000 }, async () => {
    const error = await dispatchQuietly(checkArgv("exit 3"));
    expect(error).toMatchObject({
      code: "FOCUSED_CHECK_FAILED",
      details: { check: { classification: "command-failed" } },
    });
  });

  it("treats repeated signals as one abort and leaves the invocation settled", { timeout: 60_000 }, async () => {
    const baseline = signalBaseline();
    const invocation = dispatchQuietly(verifyArgv());

    await new Promise((r) => setTimeout(r, 500));
    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGTERM");
    const error = await invocation;

    expect(error).toMatchObject({ code: "COMMAND_CANCELLED" });
    // Idempotent: one abort, so nothing re-ran, re-cleaned, or re-reported.
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.term);
  });

  it("starts the next invocation fresh rather than inheriting the previous abort", { timeout: 60_000 }, async () => {
    const baseline = signalBaseline();
    expect(await dispatchQuietly(checkArgv(`printf "%s" first`))).toBeNull();
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);

    const cancelled = dispatchQuietly(checkArgv(PLAN_COMMAND));
    await new Promise((r) => setTimeout(r, 700));
    process.emit("SIGINT");
    expect(await cancelled).toMatchObject({ code: "COMMAND_CANCELLED" });

    // A third invocation is not pre-aborted by either earlier one, and its
    // commands run through the shared processor seam with strong containment.
    const recorder = vi.spyOn(processModule, "run");
    try {
      expect(await dispatchQuietly(checkArgv(`printf "%s" third`))).toBeNull();
      const managed = recorder.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "-c");
      expect(managed?.[0]).toBe("/bin/sh");
      expect(managed?.[2]).toMatchObject({ containment: "cgroup-v2" });
    } finally {
      recorder.mockRestore();
    }
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
  });

  it("preserves a library caller's own signal and installs no process handlers for it", { timeout: 60_000 }, async () => {
    const baseline = signalBaseline();
    const controller = new AbortController();
    const invocation = dispatchCli(checkArgv(PLAN_COMMAND), { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 700));
    // A caller-supplied signal means Poiesis did not take over SIGINT/SIGTERM.
    expect(process.listenerCount("SIGINT")).toBe(baseline.int);
    controller.abort();
    await expect(invocation).rejects.toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
  });

  it("reports a cleanup failure ahead of the cancellation", { timeout: 60_000 }, async () => {
    const before = await receiptFiles();
    // The kernel is made to keep reporting the managed cgroup leaf as
    // populated, so `cgroup.kill` runs but emptiness can never be confirmed.
    // That is scoped to containment, so the Git calls Verify makes around the
    // plan are untouched and the only rejection left is the cleanup one.
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: ((path: string, ...rest: unknown[]) => {
          if (typeof path === "string" && /\/cgroup\.events$/.test(path)) {
            return "populated 1\nfrozen 0\n";
          }
          return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
        }) as typeof actual.readFileSync,
      };
    });
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const cli = await import("../src/cli.js");
      const invocation = cli.dispatchCli(verifyArgv());
      await new Promise((r) => setTimeout(r, 700));
      process.emit("SIGINT");
      await expect(invocation).rejects.toMatchObject({
        code: expect.stringMatching(/^PROCESS_CLEANUP_(REFUSED|UNRESOLVED)$/) as unknown as string,
      });
      // The cancellation still happened; the cleanup failure simply outranks
      // it, because "Poiesis could not confirm it stopped what it started"
      // is the fact an operator has to act on.
      expect(await receiptFiles()).toEqual(before);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("reports COMMAND_CANCELLED and issues no receipt when interrupted DURING admission", { timeout: 60_000 }, async () => {
    const before = await receiptFiles();
    interruptDuringAdmission();
    try {
      const cli = await import("../src/cli.js");
      const startedAt = Date.now();
      const error = await dispatchQuietly(verifyArgv(), (argv) => cli.dispatchCli(argv) as Promise<unknown>);

      expect(error).toMatchObject({ code: "COMMAND_CANCELLED", exitCode: 130 });
      // Bounded: the cancellation is honoured at the admission boundary instead
      // of being dropped and the plan running on to a successful exit.
      expect(Date.now() - startedAt).toBeLessThan(60_000);
      // The fact that matters most: an interrupted Verify that did not complete
      // its plan proves nothing, so it leaves no authoritative receipt behind.
      expect(await receiptFiles()).toEqual(before);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("reports a cleanup failure ahead of a cancellation that arrived DURING admission", { timeout: 60_000 }, async () => {
    const before = await receiptFiles();
    interruptDuringAdmission();
    // Emptiness can never be confirmed, so the boundary Poiesis provisioned for
    // the interrupted run cannot be reported as settled.
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: ((path: string, ...rest: unknown[]) => {
          if (typeof path === "string" && /\/cgroup\.events$/.test(path)) {
            return "populated 1\nfrozen 0\n";
          }
          return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
        }) as typeof actual.readFileSync,
      };
    });
    try {
      const cli = await import("../src/cli.js");
      const error = await dispatchQuietly(verifyArgv(), (argv) => cli.dispatchCli(argv) as Promise<unknown>);

      expect(error).toMatchObject({
        code: expect.stringMatching(/^PROCESS_CLEANUP_(REFUSED|UNRESOLVED)$/) as unknown as string,
      });
      expect(await receiptFiles()).toEqual(before);
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describeManagedExecution("the packaged bin honours the same cancellation contract", () => {
  it("exits COMMAND_CANCELLED when the operator interrupts it", { timeout: 180_000 }, async () => {
    await run(
      "node",
      [
        "node_modules/tsup/dist/cli-default.js",
        "src/cli.ts",
        "--format",
        "esm",
        "--no-dts",
        "--out-dir",
        CLONE_DIR,
      ],
      { cwd: join(import.meta.dirname, ".."), timeoutMs: 120_000 },
    );
    const cliPath = join(CLONE_DIR, "cli.js");
    expect(existsSync(cliPath)).toBe(true);
    cleanupDirs.push(CLONE_DIR);

    const child = spawn(process.execPath, [cliPath, ...verifyArgv()], {
      cwd: candidate!.path,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));

    await new Promise((r) => setTimeout(r, 2_000));
    process.kill(-(child.pid as number), "SIGINT");
    const code = await Promise.race([
      exited,
      new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
    ]);

    expect(code).toBe(130);
    expect(stderr).toContain("COMMAND_CANCELLED");
  });
});

/** The bounded shape a focused result carries into the failure envelope. */
interface FocusedShape {
  scope: string;
  authoritative: boolean;
  outcome: string;
  classification: string | null;
  commands: { index: number; status: string; classification: string; failureCode: string | null }[] | null;
}
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures: string[] = [];
afterEach(async () => {
  while (fixtures.length > 0) await rm(fixtures.pop()!, { recursive: true, force: true });
});

async function stageScript(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-process-"));
  fixtures.push(dir);
  const script = join(dir, "case.sh");
  await writeFile(script, content, "utf8");
  await chmod(script, 0o755);
  return script;
}

describe("process runner", () => {
  it("runs a normal command and succeeds", async () => {
    const script = await stageScript("#!/bin/sh\necho hello\necho world 1>&2\nexit 0\n");
    const result = await run(script, [], { cwd: tmpdir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("world");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("rejects an ordinary non-zero exit as a structured failure", async () => {
    const script = await stageScript("#!/bin/sh\necho bad 1>&2\nexit 7\n");
    await expect(run(script, [], { cwd: tmpdir() })).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("kills hanging commands after timeoutMs and surfaces COMMAND_TIMEOUT", { timeout: 15_000 }, async () => {
    const script = await stageScript("#!/bin/sh\nsleep 30\n");
    await expect(run(script, [], { cwd: tmpdir(), timeoutMs: 250 })).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  });

  it("honours an explicit timeout override", { timeout: 15_000 }, async () => {
    const script = await stageScript("#!/bin/sh\nsleep 30\n");
    await expect(run(script, [], { cwd: tmpdir(), timeoutMs: 100 })).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  });

  it("bounds stdout and stderr memory and flags truncation", { timeout: 30_000 }, async () => {
    const script = await stageScript(
      "#!/bin/sh\nyes '0123456789abcdef' | head -c 1048576 1>&1\nyes 'abcdef0123456789' | head -c 1048576 1>&2\nexit 0\n",
    );
    const result = await run(script, [], { cwd: tmpdir(), maxBytes: 1024 });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 64);
    expect(result.stderr.length).toBeLessThanOrEqual(1024 + 64);
    expect(result.exitCode).toBe(0);
  });

  it("timeout takes priority over allowFailure", { timeout: 15_000 }, async () => {
    const script = await stageScript("#!/bin/sh\nsleep 5\nexit 0\n");
    await expect(
      run(script, [], { cwd: tmpdir(), allowFailure: true, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  });

  it("returns COMMAND_TIMEOUT with bounded diagnostic detail", { timeout: 30_000 }, async () => {
    const script = await stageScript("#!/bin/sh\nsleep 30\n");
    let caught: unknown;
    try {
      await run(script, [], { cwd: tmpdir(), timeoutMs: 100 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "COMMAND_TIMEOUT", exitCode: 124 });
  });
});

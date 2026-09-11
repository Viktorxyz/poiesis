import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verify } from "../src/git.js";
import { createTestRepository, type TestRepository } from "./helpers.js";

const repositories: TestRepository[] = [];
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
  while (repositories.length > 0) {
    await rm(repositories.pop()!.parent, { recursive: true, force: true });
  }
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

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

async function stageParentAndDescendant() {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-verify-timeout-"));
  fixtures.push(dir);
  const descendant = join(dir, "descendant.sh");
  const parent = join(dir, "parent.sh");
  const pidFile = join(dir, "descendant.pid");
  await writeFile(
    descendant,
    [
      "#!/bin/sh",
      "exec 0</dev/null 1>/dev/null 2>/dev/null",
      'printf "%s\n" "$$" > "$1"',
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(parent, `#!/bin/sh
"${descendant}" "${pidFile}" &
sleep 30
`, "utf8");
  await chmod(descendant, 0o755);
  await chmod(parent, 0o755);
  return { dir, parent, pidFile };
}

async function stageDirtyHang(trackedPath: string, marker: string): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-verify-dirty-"));
  fixtures.push(dir);
  const script = join(dir, "dirty-hang.sh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      `printf "%s\\n" "${marker}" > "${trackedPath}"`,
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(script, 0o755);
  return { dir, script };
}

async function stageDirtyDescendant(
  trackedPath: string,
  marker: string,
): Promise<{ dir: string; parent: string; pidFile: string; descendant: string }> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-verify-descendant-"));
  fixtures.push(dir);
  const descendant = join(dir, "descendant.sh");
  const parent = join(dir, "parent.sh");
  const pidFile = join(dir, "descendant.pid");
  await writeFile(
    descendant,
    [
      "#!/bin/sh",
      "exec 0</dev/null 1>/dev/null 2>/dev/null",
      `printf "%s\\n" "${marker}" > "${trackedPath}"`,
      'printf "%s\n" "$$" > "$1"',
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(parent, `#!/bin/sh
"${descendant}" "${pidFile}" &
sleep 30
`, "utf8");
  await chmod(descendant, 0o755);
  await chmod(parent, 0o755);
  return { dir, parent, pidFile, descendant };
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`descendant did not publish a valid PID at ${path}`);
}

describe("deterministic Verify timeout", () => {
  it(
    "runs a Verify command longer than the generic process default within the verify bound",
    { timeout: 90000 },
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const startedAt = Date.now();
      const result = await verify({
        cwd: repository.root,
        candidateSha: repository.baseSha,
        commands: ["sleep 32"],
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(30000);
      expect(result).toMatchObject({
        candidateSha: repository.baseSha,
        cleanBefore: true,
        cleanAfter: true,
      });
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        command: "sleep 32",
        exitCode: 0,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "times out and cleans spawned descendants when the verify bound is overridden to a short value",
    { timeout: 30000 },
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const { dir, parent, pidFile } = await stageParentAndDescendant();
      fixtures.push(dir);
      const startedAt = Date.now();
      const invocation = verify({
        cwd: repository.root,
        candidateSha: repository.baseSha,
        commands: [`/bin/sh ${parent}`],
        timeoutMs: 500,
      });
      const descendantPid = await waitForPid(pidFile);
      const startTime = await processStartTime(descendantPid);
      survivorPids.set(descendantPid, startTime);

      await expect(invocation).rejects.toMatchObject({
        code: "COMMAND_TIMEOUT",
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(10000);
      expect(await isSameProcess(descendantPid, startTime)).toBe(false);
      survivorPids.delete(descendantPid);
    },
  );
});

describe("Verify exact-SHA clean-after reporting", () => {
  it.skipIf(process.platform === "win32")(
    "fails closed with DIRTY_CANDIDATE when a timed-out verify command mutates tracked state",
    { timeout: 30000 },
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const trackedPath = join(repository.root, "README.md");
      const marker = "dirty-hang residue";
      const { dir, script } = await stageDirtyHang(trackedPath, marker);
      fixtures.push(dir);

      const startedAt = Date.now();
      await expect(
        verify({
          cwd: repository.root,
          candidateSha: repository.baseSha,
          commands: [`/bin/sh ${script}`],
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({
        code: "DIRTY_CANDIDATE",
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(10000);

      const after = await readFile(trackedPath, "utf8");
      expect(after).toBe(`${marker}\n`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports DIRTY_CANDIDATE only after the descendant that mutated tracked state is reaped",
    { timeout: 30000 },
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const trackedPath = join(repository.root, "README.md");
      const marker = "descendant residue";
      const { dir, parent, pidFile } = await stageDirtyDescendant(trackedPath, marker);
      fixtures.push(dir);

      const startedAt = Date.now();
      const invocation = verify({
        cwd: repository.root,
        candidateSha: repository.baseSha,
        commands: [`/bin/sh ${parent}`],
        timeoutMs: 500,
      });
      const descendantPid = await waitForPid(pidFile);
      const startTime = await processStartTime(descendantPid);
      survivorPids.set(descendantPid, startTime);

      await expect(invocation).rejects.toMatchObject({
        code: "DIRTY_CANDIDATE",
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(10000);

      expect(await isSameProcess(descendantPid, startTime)).toBe(false);
      survivorPids.delete(descendantPid);

      const after = await readFile(trackedPath, "utf8");
      expect(after).toBe(`${marker}\n`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves success and non-zero command evidence semantics on the exact candidate",
    { timeout: 30000 },
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);

      const successResult = await verify({
        cwd: repository.root,
        candidateSha: repository.baseSha,
        commands: [`printf "%s" first`, `printf "%s" second`],
      });
      expect(successResult).toMatchObject({
        candidateSha: repository.baseSha,
        cleanBefore: true,
        cleanAfter: true,
      });
      expect(successResult.commands).toHaveLength(2);
      expect(successResult.commands[0]).toMatchObject({
        command: `printf "%s" first`,
        exitCode: 0,
        stdout: "first",
      });
      expect(successResult.commands[1]).toMatchObject({
        command: `printf "%s" second`,
        exitCode: 0,
        stdout: "second",
      });

      await expect(
        verify({
          cwd: repository.root,
          candidateSha: repository.baseSha,
          commands: [
            `printf "%s" ok`,
            `printf "%s" bad 1>&2; exit 7`,
            `printf "%s" never`,
          ],
        }),
      ).rejects.toMatchObject({
        code: "VERIFICATION_FAILED",
        details: {
          candidateSha: repository.baseSha,
          failed: {
            command: `printf "%s" bad 1>&2; exit 7`,
            exitCode: 7,
            stderr: "bad",
          },
          commands: [
            { command: `printf "%s" ok`, exitCode: 0, stdout: "ok" },
            { command: `printf "%s" bad 1>&2; exit 7`, exitCode: 7, stderr: "bad" },
          ],
        },
      });
    },
  );
});

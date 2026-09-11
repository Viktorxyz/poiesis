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
      'printf "%s\\n" "$$" > "$1"',
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(parent, `#!/bin/sh\n"${descendant}" "${pidFile}" &\nsleep 30\n`, "utf8");
  await chmod(descendant, 0o755);
  await chmod(parent, 0o755);
  return { dir, parent, pidFile };
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
      // sleep 32 exceeds the 30s generic process default but stays within the
      // explicit Verify suite bound.
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

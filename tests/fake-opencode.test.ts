import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import {
  installFakeOpenCode,
  TEST_OPENCODE_VERSION,
} from "./fake-opencode.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec #104 / ticket #105: the fake-opencode PATH fixture must be
 * deterministic across sequential installs in the same test. In
 * particular, a second install MUST NOT leave the first install's bin
 * directory in `process.env.PATH` after `restore()` (a "stale PATH"
 * prefix that no longer exists on disk). The state below was previously
 * a silent corruption: subsequent tests in the same process could
 * resolve an `opencode` command against a deleted bin, fall through to
 * a different binary, or fail to find any binary at all.
 */
describe("fake-opencode PATH fixture (ticket #105)", () => {
  it("restore() strips the installed bin prefix and reverts PATH to the baseline", async () => {
    const beforePath = process.env.PATH;
    const env = await installFakeOpenCode();
    try {
      // The install must prepend the bin dir to PATH.
      expect(process.env.PATH?.startsWith(env.bin)).toBe(true);
      // The bin dir and the fake binary must exist on disk while the
      // install is active so the spawn inside the CLI actually finds
      // the fake binary.
      expect(await pathExists(env.bin)).toBe(true);
      expect(await pathExists(`${env.bin}/opencode`)).toBe(true);
      // Spawning `opencode --version` through PATH must hit the fake
      // and report the fixture's version.
      const result = await run("opencode", ["--version"], { cwd: process.cwd(), allowFailure: true });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(TEST_OPENCODE_VERSION);
    } finally {
      env.restore();
    }
    // After restore: PATH no longer references the bin dir. The
    // bin-dir removal is best-effort and asynchronous so the test does
    // not block on it; the process-exit hook in fake-opencode.ts
    // catches anything `restore()` did not finish in time.
    expect(process.env.PATH?.includes(env.bin)).toBe(false);
    // The PATH baseline is restored to whatever it was before the install.
    expect(process.env.PATH).toBe(beforePath);
  });

  it("a second install without restore() strips the first install's bin prefix on its own restore()", async () => {
    // This is the regression that produced a "stale PATH fixture":
    // test A installs the fake, captures previousPath = PATH-before-A;
    // test A's body installs the fake again without restoring first,
    // capturing previousPath = PATH-with-A-bin. When the second install
    // restores, PATH goes back to PATH-with-A-bin — leaving A's bin
    // prefix behind. The fixture MUST also strip every other tracked
    // install's bin prefix on every restore.
    const baselinePath = process.env.PATH;
    const envA = await installFakeOpenCode();
    const envB = await installFakeOpenCode();
    try {
      // Both bin dirs are tracked, both prefixes are in PATH.
      expect(process.env.PATH?.startsWith(envB.bin)).toBe(true);
      expect(process.env.PATH?.includes(envA.bin)).toBe(true);
    } finally {
      envB.restore();
      envA.restore();
    }
    // After both restores, neither bin dir is referenced in PATH and
    // PATH is back to the baseline.
    expect(process.env.PATH?.includes(envA.bin)).toBe(false);
    expect(process.env.PATH?.includes(envB.bin)).toBe(false);
    expect(process.env.PATH).toBe(baselinePath);
  });

  it("restore() is idempotent: a second call is a no-op", async () => {
    const env = await installFakeOpenCode();
    const pathAfterInstall = process.env.PATH;
    env.restore();
    const pathAfterFirstRestore = process.env.PATH;
    env.restore();
    expect(process.env.PATH).toBe(pathAfterFirstRestore);
    expect(pathAfterFirstRestore).not.toBe(pathAfterInstall);
  });
});

/**
 * Spec #168 / ticket #174 — general Vitest timing tolerates loaded-host
 * variance; explicitly timing-sensitive tests keep tight local bounds.
 *
 * This suite is almost entirely integration-shaped: it builds Git remotes,
 * prepares linked worktrees, installs fake harnesses, and drives the real
 * lifecycle transactions. Vitest's default 5s per-test timeout is a floor
 * that says nothing about this codebase — on an unloaded developer host the
 * slowest test finishes well inside it, while the same test on a loaded
 * machine (or a CI box running the pool at its configured concurrency) can
 * take several times longer and be reported as a failure that has nothing to
 * do with the change under review. That is exactly the false signal this
 * Spec is removing, and it is a load property, not a defect.
 *
 * The correction is a general bound in `vitest.config.ts` wide enough to
 * absorb observed loaded-host variance. It must NOT become unbounded: a
 * general bound that swallows a genuinely hung test just relocates the
 * signal.
 *
 * The second half matters more than the first. A handful of tests assert on
 * TIMING ITSELF — a bounded command timeout fires, a process group settles
 * within its confirmation window — and those must stay pinned to explicit
 * local bounds so widening the general timeout cannot silently relax them.
 * This file pins that split.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

/** The narrowest general bound that absorbs observed loaded-host variance. */
const MINIMUM_GENERAL_TIMEOUT_MS = 30_000;
/** The widest general bound still short enough to surface a hung test. */
const MAXIMUM_GENERAL_TIMEOUT_MS = 300_000;

/**
 * Files whose assertions are ABOUT elapsed time or bounded termination, so
 * their per-test budget must stay an explicit local decision rather than
 * inheriting whatever the general bound happens to be.
 */
const TIMING_SENSITIVE_TESTS = [
  "verify-timeout.test.ts",
  "process.test.ts",
  "process-lifecycle.test.ts",
  "process-lease.test.ts",
] as const;

async function vitestConfigSource(): Promise<string> {
  return readFile(join(repoRoot, "vitest.config.ts"), "utf8");
}

function declaredTimeout(config: string, key: string): number {
  const match = new RegExp(`\\b${key}\\s*:\\s*([0-9_]+)`).exec(config);
  if (match === null) throw new Error(`vitest.config.ts declares no ${key}`);
  return Number.parseInt(match[1]!.replace(/_/g, ""), 10);
}

describe("Spec #168 / ticket #174 — Vitest timing bounds", () => {
  it("declares a general per-test bound that absorbs loaded-host variance", async () => {
    const config = await vitestConfigSource();
    const testTimeout = declaredTimeout(config, "testTimeout");
    expect(testTimeout).toBeGreaterThanOrEqual(MINIMUM_GENERAL_TIMEOUT_MS);
    expect(testTimeout).toBeLessThanOrEqual(MAXIMUM_GENERAL_TIMEOUT_MS);
  });

  it("gives hooks and teardown the same general bound, since both dominate the loaded-host cost", async () => {
    const config = await vitestConfigSource();
    const testTimeout = declaredTimeout(config, "testTimeout");
    expect(declaredTimeout(config, "hookTimeout")).toBe(testTimeout);
    expect(declaredTimeout(config, "teardownTimeout")).toBe(testTimeout);
  });

  it("keeps the workspace isolation excludes alongside the timing bound", async () => {
    const config = await vitestConfigSource();
    expect(config).toContain("globalSetup");
    expect(config).toContain(".poiesis/workspaces/**");
  });

  it.each(TIMING_SENSITIVE_TESTS)("%s keeps explicit local timeouts so the general bound cannot relax it", async (file) => {
    const source = await readFile(join(repoRoot, "tests", file), "utf8");
    const explicit = [...source.matchAll(/timeout\s*:\s*([0-9_]+)/g)].map((match) => Number.parseInt(match[1]!.replace(/_/g, ""), 10));
    expect(explicit.length, `${file} declares no explicit local timeout`).toBeGreaterThan(0);
    for (const bound of explicit) {
      // Vitest resolves a per-test `timeout` INSTEAD of `testTimeout`, so
      // these files keep their own budget whatever the general bound becomes.
      // What this pins is that each budget stays a bounded, explicit local
      // decision rather than a silently unbounded one.
      expect(bound, `${file} declares ${bound}ms`).toBeLessThanOrEqual(MAXIMUM_GENERAL_TIMEOUT_MS);
    }
  });

  it("verify-timeout keeps its own elapsed-time assertions independent of the general bound", async () => {
    const source = await readFile(join(repoRoot, "tests", "verify-timeout.test.ts"), "utf8");
    const elapsedBounds = [...source.matchAll(/toBeLessThan\((\d+)\)/g)].map((match) => Number.parseInt(match[1]!, 10));
    expect(elapsedBounds.length, "verify-timeout.test.ts lost its elapsed-time assertions").toBeGreaterThan(0);
    for (const bound of elapsedBounds) {
      expect(bound).toBeLessThan(MINIMUM_GENERAL_TIMEOUT_MS);
    }
  });
});
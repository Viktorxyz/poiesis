/**
 * Spec #168 / ticket #174 — a stale running session fails with actionable
 * recovery, and is never bypassed.
 *
 * Every receipt-gated workspace mutation (ordinary `update`, `update --config`,
 * the 1.0.0 bootstrap) is serialized by one fail-fast, cooperating mutation
 * lock at `<ownership receipt>.mutation.lock`. The lock file is what a running
 * Poiesis session leaves behind; when the session dies without releasing it —
 * a crash, a SIGKILL, a closed laptop — the lock survives with nothing alive
 * holding it.
 *
 * Before this ticket that condition surfaced as a bare
 * `POIESIS_MUTATION_LOCKED` carrying only the lock path. An operator holding
 * the only two plausible answers ("is something actually running?" and "what
 * do I do now?") had neither, and the equally tempting wrong answer — delete
 * the lock — is exactly the bypass this ticket forbids: a live concurrent
 * mutation would be silently stolen from.
 *
 * This file proves the three properties that make the condition operable
 * without making it permissive:
 *
 *   1. Fail, never bypass: a held lock — live holder or stale holder — always
 *      refuses the mutation and never rewrites, removes, or steals the lock.
 *   2. Actionable: the typed diagnostic names the holder, whether that holder
 *      is still running, and the concrete recovery for that exact state.
 *   3. Fail closed on an unreadable holder: a lock whose bytes cannot be
 *      attributed still refuses, and still says so, instead of guessing.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWorkspaceMutationLock } from "../src/mutation-transaction.js";
import { init, update } from "../src/maintenance.js";
import { loadManifest } from "../src/manifest.js";
import { ownershipReceiptLocation, readOwnershipReceipt } from "../src/receipt.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

async function installFakeUv(): Promise<FakeUvEnvironment> {
  const { chmod, mkdir } = await import("node:fs/promises");
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-174b-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    parent,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** A pid that is confirmed not to be running right now. */
async function deadPid(): Promise<number> {
  const { run } = await import("../src/process.js");
  for (let attempt = 0; attempt < 8; attempt++) {
    const scratch = await mkdtemp(join(tmpdir(), "poiesis-dead-pid-"));
    const result = await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { cwd: scratch });
    void rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    const pid = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && !isRunning(pid)) return pid;
  }
  throw new Error("could not obtain a pid confirmed dead");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockPath(repository: TestRepository): Promise<string> {
  return ownershipReceiptLocation(repository.root).then((receipt) => `${receipt}.mutation.lock`);
}

async function writeLock(repository: TestRepository, token: string): Promise<string> {
  const path = await lockPath(repository);
  await writeFile(path, token);
  return path;
}

describe("Spec #168 / ticket #174 — stale running session fails with actionable recovery", () => {
  let opencode: FakeOpenCodeEnvironment;
  let uv: FakeUvEnvironment;
  const repositories: TestRepository[] = [];

  beforeEach(async () => {
    opencode = await installFakeOpenCode();
    uv = await installFakeUv();
  });

  afterEach(async () => {
    uv.restore();
    opencode.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("refuses a LIVE holder with the wait-then-retry recovery and never steals the lock", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const held = await acquireWorkspaceMutationLock(repository.root);
    const lockBytesBefore = await readFile(held.path);
    const manifestBefore = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const receiptBefore = await readFile(await ownershipReceiptLocation(repository.root));

    const failure = await update(repository.root, { skipSkills: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "POIESIS_MUTATION_LOCKED" });
    const details = (failure as { details: Record<string, unknown> }).details;
    expect(details.path).toBe(held.path);
    expect(details.holderPid).toBe(process.pid);
    expect(details.holderRunning).toBe(true);
    expect(details.hint).toBe("live-mutation-lock");
    expect(String(details.recovery)).toMatch(/re-run/i);
    // The live-holder recovery explicitly forbids the bypass.
    expect(String(details.recovery)).toMatch(/Do NOT remove/);

    // No bypass: the lock is byte-identical and still owned by the live holder,
    // and nothing the transaction owns was written.
    expect(await readFile(held.path)).toEqual(lockBytesBefore);
    expect(await readFile(join(repository.root, ".poiesis", "manifest.json"))).toEqual(manifestBefore);
    expect(await readFile(await ownershipReceiptLocation(repository.root))).toEqual(receiptBefore);

    await held.release();
    expect(existsSync(held.path)).toBe(false);
  }, 120_000);

  it("refuses a STALE holder with the confirm-then-remove recovery and never bypasses", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const manifestBefore = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const receiptBefore = await readFile(await ownershipReceiptLocation(repository.root));
    const pid = await deadPid();
    const path = await writeLock(repository, `${pid}:11111111-2222-3333-4444-555555555555\n`);
    const lockBytesBefore = await readFile(path);

    const failure = await update(repository.root, { skipSkills: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "POIESIS_MUTATION_LOCKED" });
    const details = (failure as { details: Record<string, unknown> }).details;
    expect(details.path).toBe(path);
    expect(details.holderPid).toBe(pid);
    expect(details.holderRunning).toBe(false);
    expect(String(details.recovery)).toMatch(/remove/i);
    expect(details.hint).toBe("stale-mutation-lock");

    // Still fail-closed: the stale lock is never reclaimed automatically, and
    // no transaction-owned artifact moved.
    expect(existsSync(path)).toBe(true);
    expect(await readFile(path)).toEqual(lockBytesBefore);
    expect(await readFile(join(repository.root, ".poiesis", "manifest.json"))).toEqual(manifestBefore);
    expect(await readFile(await ownershipReceiptLocation(repository.root))).toEqual(receiptBefore);
    expect((await loadManifest(repository.root)).poiesisVersion).toBe(await (await import("../src/maintenance.js")).packageVersion());
  }, 120_000);

  it("refuses an UNATTRIBUTABLE holder rather than guessing", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const path = await writeLock(repository, "not-a-poiesis-lock-token\n");

    const failure = await update(repository.root, { skipSkills: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "POIESIS_MUTATION_LOCKED" });
    const details = (failure as { details: Record<string, unknown> }).details;
    expect(details.path).toBe(path);
    expect(details.holderRunning).toBeNull();
    expect(details.hint).toBe("unattributable-mutation-lock");
    expect(String(details.recovery)).toMatch(/remove/i);
    expect(existsSync(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("not-a-poiesis-lock-token\n");
  }, 120_000);

  it("a released lock restores normal migration", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const pid = await deadPid();
    const path = await writeLock(repository, `${pid}:11111111-2222-3333-4444-555555555555\n`);
    // The recovery the diagnostic names is the only way past it: the operator
    // confirms nothing is running and clears the lock, then re-runs.
    await rm(path);
    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.poiesisVersion).toBe(await (await import("../src/maintenance.js")).packageVersion());
    expect((await readOwnershipReceipt(repository.root)).generation).toBeGreaterThan(0);
  }, 120_000);
});
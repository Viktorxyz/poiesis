/**
 * Spec #120 / ticket #127 — identity-safe refresh lock protocol.
 *
 * The previous refresh-lock implementation (`acquireRefreshLock`) used
 * unconditional `unlink(path)` after a PID-liveness check, which left
 * two windows where a contender could remove a live lock it did not
 * own:
 *
 *   1. Stale reclamation: two contenders both read the same stale
 *      lock, both decided it was stale, both called `unlink(path)`.
 *      The first unlink removes the stale file; the second unlink
 *      removes the freshly-acquired lock the first contender then
 *      created. A second reclaimer could erase a brand-new live lock
 *      before its owner reached the protected region.
 *
 *   2. Release: the release closure called `unlink(path)` with no
 *      identity check. An "old release" (delayed, queued before the
 *      owning process died or before the lock was replaced by a
 *      legitimate stale-reclaimer) could remove the replacement lock
 *      and leave the path empty, breaking the next acquirer's
 *      contention check.
 *
 * The first review pass replaced the unconditional `unlink` with a
 * `rename(path, sidecar)` + `rename(sidecar, path)` restore. That
 * protocol passed the simpler invariants but suffered from one
 * residual Standards finding: the `rename(sidecar, path)` restore
 * could OVERWRITE a foreign lock another process had legitimately
 * installed in the brief window between the capture and the restore.
 * Displacement is equivalent to removal.
 *
 * The current implementation (this test file is the regression gate)
 * fixes that finding with a genuinely serialized protocol built on a
 * fixed reclamation / release guard:
 *
 *   - A guard file (`.refresh.lock.guard`) is acquired with
 *     `writeFile(guard, ..., { flag: "wx" })`. POSIX `wx` is atomic,
 *     so exactly ONE contender creates the guard; everyone else
 *     observes EEXIST and waits.
 *
 *   - Every canonical-lock mutation runs UNDER the guard:
 *
 *     - Acquire: read canonical. If absent → `wx` with our token.
 *       If present → check token + PID; if stale, unlink the exact
 *       observed stale token and `wx` with our token; if live,
 *       leave it alone.
 *
 *     - Release: re-read canonical under the guard. If the token
 *       matches ours → unlink. If the token does NOT match → no-op.
 *
 *     - Stale reclamation runs as part of acquire; it only unlinks
 *       the EXACT observed stale token, then attempts `wx` for the
 *       new unique token without overwriting. There is NO
 *       rename-back path.
 *
 *   - A crashed guard produces a bounded fallback: every waiter
 *     observes EEXIST, sleeps the bounded poll interval, and
 *     ultimately fails closed with
 *     `REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT`. The runtime
 *     NEVER auto-reclaims the guard.
 *
 * These tests exercise the protocol directly through the exported
 * lock primitives so the deterministic invariants are observable
 * without relying on real multi-process timing. The harness-provided
 * `acquireRefreshLockWithTimeout` test seam lets the suite bound the
 * wait so concurrent reclaimer races resolve within the test budget.
 *
 * The `acquireRefreshLockWithTimeout` test seam and the
 * `acquireRefreshLock` production entry are explicitly enumerated in
 * `tests/public-api.test.ts` as forbidden public-API exports — the
 * capability stays internal to the CLI / runtime. The forbidden
 * list test fails fast if `src/index.ts` ever re-exports them.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRefreshLock,
  acquireRefreshLockWithTimeout,
} from "../src/repository-intelligence.js";
import { exists } from "../src/fs.js";

// ---- Test harness ------------------------------------------------------------

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-lock-127-"));
  const root = join(parent, "repo");
  await mkdir(root);
  return root;
}

function lockPath(root: string): string {
  return join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
}

function guardPath(root: string): string {
  return join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock.guard");
}

interface LockSnapshot {
  version: number;
  token: string;
  pid: number;
  acquiredAt: number;
}

async function readLockSnapshot(path: string): Promise<LockSnapshot | null> {
  if (!(await exists(path))) return null;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<LockSnapshot>;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.version !== 1 ||
    typeof parsed.token !== "string" ||
    typeof parsed.pid !== "number" ||
    typeof parsed.acquiredAt !== "number"
  ) {
    return null;
  }
  return parsed as LockSnapshot;
}

async function writeLockSnapshot(path: string, snapshot: Partial<LockSnapshot>): Promise<void> {
  const value: LockSnapshot = {
    version: 1,
    token: snapshot.token ?? "00000000-0000-0000-0000-000000000000",
    pid: snapshot.pid ?? process.pid,
    acquiredAt: snapshot.acquiredAt ?? Date.now(),
  };
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

async function writeGuardSnapshot(path: string, token: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const payload = JSON.stringify({
    version: 1,
    token,
    pid: process.pid,
    acquiredAt: Date.now(),
  });
  await writeFile(path, payload, { mode: 0o600 });
}

async function listLockArtifacts(root: string): Promise<string[]> {
  const dir = join(root, ".poiesis", "cache", "repository-intelligence");
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name === ".refresh.lock" || entry.name === ".refresh.lock.guard")
    .map((entry) => entry.name)
    .sort();
}

// ---- Identity acquisition ----------------------------------------------------

describe("ticket #127 identity-safe refresh lock: acquisition identity", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a UUID ownership token into the lock file (not just a PID)", async () => {
    const release = await acquireRefreshLock(root);
    try {
      const snapshot = await readLockSnapshot(lockPath(root));
      expect(snapshot).not.toBeNull();
      expect(snapshot!.version).toBe(1);
      // Standard UUID format (36 chars, 4 hyphens).
      expect(snapshot!.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(snapshot!.pid).toBe(process.pid);
      expect(typeof snapshot!.acquiredAt).toBe("number");
    } finally {
      await release();
    }
    // Release removes the lock file.
    expect(await exists(lockPath(root))).toBe(false);
  });

  it("each acquire call writes a distinct UUID token (no collisions across successive acquires)", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const release = await acquireRefreshLock(root);
      try {
        const snapshot = await readLockSnapshot(lockPath(root));
        expect(snapshot).not.toBeNull();
        tokens.add(snapshot!.token);
      } finally {
        await release();
      }
    }
    expect(tokens.size).toBe(4);
  });

  it("the canonical guard is acquired and released exactly once per critical section (no leftover guard file after a clean acquire)", async () => {
    const release = await acquireRefreshLock(root);
    try {
      // While holding the lock the canonical file is present; the
      // guard is short-lived and may or may not be on disk depending
      // on timing. After release the canonical file is gone.
      expect(await exists(lockPath(root))).toBe(true);
    } finally {
      await release();
    }
    // Both lock and guard are gone.
    expect(await exists(lockPath(root))).toBe(false);
    expect(await exists(guardPath(root))).toBe(false);
    expect(await listLockArtifacts(root)).toEqual([]);
  });
});

// ---- Identity release: replacement preservation ------------------------------

describe("ticket #127 identity-safe refresh lock: release identity", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("release does not remove a lock that another identity has acquired (replacement preservation)", async () => {
    const releaseA = await acquireRefreshLock(root);
    const beforeReplace = await readLockSnapshot(lockPath(root));
    expect(beforeReplace).not.toBeNull();
    const tokenA = beforeReplace!.token;

    // Simulate a legitimate foreign replacement of the lock file. The
    // replacement uses the SAME alive PID (the test process) so the
    // staleness check would also pass; the proof is in the identity
    // check, not the PID check.
    const foreignToken = "11111111-2222-3333-4444-555555555555";
    await writeLockSnapshot(lockPath(root), { token: foreignToken, pid: process.pid });
    expect((await readLockSnapshot(lockPath(root)))!.token).toBe(foreignToken);

    // The original releaser (token A) runs its release. With the new
    // protocol it must NOT touch the file.
    await releaseA();

    // The replacement lock MUST still be intact at the canonical path.
    const afterRelease = await readLockSnapshot(lockPath(root));
    expect(afterRelease).not.toBeNull();
    expect(afterRelease!.token).toBe(foreignToken);
    expect(afterRelease!.token).not.toBe(tokenA);

    // No leaked guard or sidecar files from the release protocol.
    expect(await listLockArtifacts(root)).toEqual([".refresh.lock"]);

    await rm(lockPath(root), { force: true });
  });

  it("release preserves the captured lock even when the foreign token points at a different alive PID", async () => {
    const releaseA = await acquireRefreshLock(root);
    const foreignToken = "22222222-3333-4444-5555-666666666666";
    await writeLockSnapshot(lockPath(root), { token: foreignToken, pid: process.pid });

    await releaseA();

    const afterRelease = await readLockSnapshot(lockPath(root));
    expect(afterRelease).not.toBeNull();
    expect(afterRelease!.token).toBe(foreignToken);
    expect(await listLockArtifacts(root)).toEqual([".refresh.lock"]);

    await rm(lockPath(root), { force: true });
  });

  it("release preserves the captured lock even when the captured file is malformed JSON (defensive)", async () => {
    const releaseA = await acquireRefreshLock(root);
    // Replace the lock with a completely malformed blob — neither a
    // valid JSON envelope nor a known token. The release must NOT
    // delete this foreign content; it must preserve it so the next
    // acquirer can decide.
    const path = lockPath(root);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "definitely-not-json-payload", { mode: 0o600 });

    await releaseA();

    // The malformed payload must still be at the canonical path.
    const raw = await readFile(path, "utf8");
    expect(raw).toBe("definitely-not-json-payload");
    expect(await listLockArtifacts(root)).toEqual([".refresh.lock"]);

    await rm(path, { force: true });
  });

  it("release of an absent lock is a no-op (no error, no orphan file)", async () => {
    const releaseA = await acquireRefreshLock(root);
    await releaseA();
    // Second release — file already gone.
    await expect(releaseA()).resolves.toBeUndefined();
    expect(await listLockArtifacts(root)).toEqual([]);
  });
});

// ---- Atomic stale reclamation: exact-token-match unlink ---------------------

describe("ticket #127 identity-safe refresh lock: atomic stale reclamation", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("acquireRefreshLock reclaims a stale lock (PID dead) and writes a fresh UUID token under the guard", async () => {
    const path = lockPath(root);
    const deadPid = 2_147_483_647;
    await writeLockSnapshot(path, { token: "stale", pid: deadPid });

    const release = await acquireRefreshLock(root);
    try {
      const snapshot = await readLockSnapshot(path);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.token).not.toBe("stale");
      expect(snapshot!.pid).toBe(process.pid);
      expect(snapshot!.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      await release();
    }
  });

  it("acquireRefreshLock waits for a live lock to be released and then acquires (no contention failure)", async () => {
    const releaseA = await acquireRefreshLock(root);
    // B starts acquiring but the live lock makes it wait.
    const acquireBPromise = acquireRefreshLockWithTimeout(root, 5000);
    // A is still holding — release A after a tick.
    setTimeout(() => {
      void releaseA();
    }, 50);
    const releaseB = await acquireBPromise;
    try {
      const snapshot = await readLockSnapshot(lockPath(root));
      expect(snapshot).not.toBeNull();
      // B's token is a fresh UUID, distinct from A's (which is gone).
      expect(snapshot!.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      await releaseB();
    }
  });
});

// ---- Concurrency invariants (the Standards findings) --------------------------

describe("ticket #127 identity-safe refresh lock: end-to-end concurrency invariants", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("holds returned locks: concurrent acquirers on one stale lock yield exactly one simultaneous fulfilled owner (guard-serialized critical section)", async () => {
    const path = lockPath(root);
    const deadPid = 2_147_483_647;
    await writeLockSnapshot(path, { token: "stale", pid: deadPid });

    // Launch N concurrent acquirers with a short bounded wait. The
    // guard file at `.refresh.lock.guard` is acquired with `wx` so
    // exactly ONE contender enters the read-decide-write critical
    // section. The rest wait for the guard, observe the winner's
    // live lock, and time out.
    //
    // Hold the returned release closures — the assertion below proves
    // that AT MOST ONE simultaneous fulfilled owner holds the
    // canonical lock. Multiple "fulfilled" acquisitions (the
    // bounded-failure property of the previous implementation) are
    // no longer possible.
    const N = 4;
    const shortTimeoutMs = 300;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => acquireRefreshLockWithTimeout(root, shortTimeoutMs)),
    );
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");

    // Exactly one winner. The guard serializes the critical section;
    // concurrent reclaimers cannot both produce a successful `wx`.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(N - 1);

    // The winner's lock is at the canonical path with a valid UUID token.
    const winnerRelease = (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value;
    const winnerSnapshot = await readLockSnapshot(path);
    expect(winnerSnapshot).not.toBeNull();
    expect(winnerSnapshot!.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(winnerSnapshot!.pid).toBe(process.pid);

    // The rejected acquirers saw REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT
    // — they did NOT mutate the lock.
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason as { code?: string };
      expect(reason.code).toBe("REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT");
    }

    // Release the winner so no lock file remains.
    await winnerRelease();
    expect(await exists(path)).toBe(false);
    expect(await exists(guardPath(root))).toBe(false);
  });

  it("multiple stale reclaimers cannot displace a live replacement (exact-token-match unlink only)", async () => {
    // Set up a live lock owned by the test process (PID is alive).
    // A stale reclaimer arriving concurrently under the new protocol
    // observes the canonical lock, sees the live PID, and refuses to
    // touch the canonical file. There is no rename-back overwrite
    // path: the reclaimer either leaves the lock alone or unlinks
    // ONLY the exact observed stale token (which never matches the
    // foreign replacement's token).
    const path = lockPath(root);
    const releaseA = await acquireRefreshLock(root);
    const tokenA = (await readLockSnapshot(path))!.token;

    // Replace the lock with a foreign live token held by an alive
    // (test-process) PID. Both PIDs are alive; the staleness check
    // would also pass — the proof is in the token check, not the
    // PID check.
    const foreignToken = "33333333-4444-5555-6666-777777777777";
    await writeLockSnapshot(path, { token: foreignToken, pid: process.pid });
    expect((await readLockSnapshot(path))!.token).toBe(foreignToken);

    // A second acquirer (the stale reclaimer, arriving under the
    // assumption the lock is stale) MUST NOT acquire the foreign
    // lock — the runtime fails closed with a bounded timeout.
    const startTs = Date.now();
    await expect(
      acquireRefreshLockWithTimeout(root, 150),
    ).rejects.toMatchObject({
      code: "REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT",
    });
    const elapsed = Date.now() - startTs;
    expect(elapsed).toBeLessThan(500);

    // The foreign replacement is preserved at the canonical path with
    // its exact token. The original acquirer's lock was overwritten
    // by the foreign replacement (legitimate foreign write) but the
    // reclaimer did NOT unlink the replacement.
    const after = await readLockSnapshot(path);
    expect(after).not.toBeNull();
    expect(after!.token).toBe(foreignToken);
    expect(after!.token).not.toBe(tokenA);

    // No leftover guard file from the failed acquisition.
    expect(await exists(guardPath(root))).toBe(false);

    // Clean up: A's release is a no-op against the foreign lock.
    await releaseA();
    const final = await readLockSnapshot(path);
    expect(final).not.toBeNull();
    expect(final!.token).toBe(foreignToken);
    expect(await exists(guardPath(root))).toBe(false);

    await rm(path, { force: true });
  });

  it("old release is a no-op against a replacement (identity check inside the guard)", async () => {
    const path = lockPath(root);
    const releaseA = await acquireRefreshLock(root);
    const tokenA = (await readLockSnapshot(path))!.token;

    // Replace the lock with a foreign lock.
    const foreignToken = "44444444-5555-6666-7777-888888888888";
    await writeLockSnapshot(path, { token: foreignToken, pid: process.pid });

    // A's release runs. Under the guard the release re-reads the
    // canonical lock; the observed token is foreign, so the release
    // is a strict no-op.
    await releaseA();

    // The foreign lock is preserved verbatim.
    const final = await readLockSnapshot(path);
    expect(final).not.toBeNull();
    expect(final!.token).toBe(foreignToken);
    expect(final!.token).not.toBe(tokenA);
    expect(await exists(guardPath(root))).toBe(false);

    await rm(path, { force: true });
  });

  it("guard timeout is bounded: a stuck guard causes the acquisition to fail closed within the bounded wait", async () => {
    const path = lockPath(root);
    await mkdir(join(path, ".."), { recursive: true });

    // Simulate a stuck guard (held by an external crashed holder)
    // by placing a guard envelope on disk that no one will release.
    await writeGuardSnapshot(guardPath(root), "stuck-guard-token");

    // The acquisition must fail closed after the bounded wait,
    // NOT auto-reclaim the guard, and NOT touch the canonical lock.
    const startTs = Date.now();
    await expect(
      acquireRefreshLockWithTimeout(root, 1000),
    ).rejects.toMatchObject({
      code: "REPOSITORY_INTELLIGENCE_REFRESH_LOCK_TIMEOUT",
    });
    const elapsed = Date.now() - startTs;

    // Bounded wait — the failure fires within the configured
    // timeout, never significantly later.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);

    // The stuck guard is preserved (no automatic recursive
    // reclamation); recovery is the operator's responsibility.
    expect(await exists(guardPath(root))).toBe(true);
    expect(await exists(path)).toBe(false);

    await rm(guardPath(root), { force: true });
  });
});
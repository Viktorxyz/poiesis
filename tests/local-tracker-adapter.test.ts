/**
 * Spec #139 / ticket #142 — the first-class `local` tracker.
 *
 * `local` is a complete `TrackerAdapter`, not a fixture and not a stub. The
 * evidence in this file is deliberately about the four properties the ticket
 * names, because each one is a place where a plausible-looking
 * implementation is silently wrong:
 *
 *   1. CANONICALITY. The store lives under the Git COMMON directory, so a
 *      linked worktree observes the same Specs/Tickets as its primary
 *      checkout, the adapter never writes a byte into a working tree, and
 *      `uninstall` cannot delete the tracker's history.
 *   2. DURABILITY + MONOTONICITY. Identifiers are stable `LOCAL-<n>` values
 *      from a counter that only ever increases, and comments/history survive
 *      both a fresh adapter instance and a separate OS process.
 *   3. EXCLUSIVITY. Concurrent writers in different processes serialize on a
 *      cross-process lock whose release is token-checked and whose stale
 *      recovery is bounded. A live foreign lock is preserved, never stolen.
 *   4. FAIL-CLOSED VALIDATION. A malformed store, a symlinked/nonregular store
 *      or lock path, or a store file that is not 0600 is a typed refusal that
 *      leaves the bytes on disk untouched.
 */
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTrackerAdapter } from "../src/adapters.js";
import { PoiesisError } from "../src/errors.js";
import {
  LOCAL_TRACKER_LOCK_VERSION,
  LOCAL_TRACKER_STORE_DIRECTORY,
  LOCAL_TRACKER_STORE_MAX_BYTES,
  type LocalTrackerStoreLocation,
  acquireLocalTrackerLockWithTimeout,
  assertLocalTrackerStoreUsable,
  createLocalTrackerAdapter,
  releaseLocalTrackerLock,
  resolveLocalTrackerStoreLocation,
} from "../src/local-tracker.js";
import { autoResolveConfigDefaults, init, uninstall, verifyTracker } from "../src/maintenance.js";
import { run } from "../src/process.js";
import { templateMappings } from "../src/templates.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/**
 * The durable working-tree destinations `init` writes.
 *
 * Spec #190 / ticket #191 replaced the old flat durable-path list with the
 * per-mapping `trackInProject` classification, so this list is derived from
 * the ONE template table that owns it rather than from a second literal that
 * could drift away from what `init` actually writes.
 */
const POIESIS_DURABLE_PATHS: readonly string[] = templateMappings
  .filter((mapping) => mapping.trackInProject === true)
  .map((mapping) => mapping.destination);

/**
 * A dependency text with trailing spaces, a blank line, tabs, and non-ASCII
 * content. The store must round-trip it byte-for-byte: dependency text is
 * Author-supplied evidence about ordering, and normalizing it would silently
 * change what a ticket claims.
 */
const EXACT_DEPENDENCY_TEXT = [
  "  LOCAL-9 pinned, leading spaces kept  ",
  "",
  "\tsecond line with tabs\t",
  "unicode: αβγ — ✓",
].join("\n");

function baseConfig() {
  return {
    schema: 1 as const,
    // Spec #190 / ticket #191: an explicit init config states the sharing
    // mode, because it is a decision and never a discovery. These tests are
    // about the tracker, so they install private mode like the rest of the
    // suite.
    mode: "private" as const,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    verification: { commands: ["test -f README.md"] },
  };
}

async function readStoreJson(storePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;
}

async function trackedWorktreeEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === ".poiesis") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const stats = await lstat(path);
      entries.push(`${relative(root, path)}:${stats.mode & 0o777}:${stats.size}`);
    }
  }
  await walk(root);
  return entries;
}

async function deadPid(): Promise<number> {
  const child = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
  if (typeof child.pid !== "number") throw new Error("could not obtain an exited child pid");
  return child.pid;
}

function lockEnvelope(token: string, pid: number): string {
  return JSON.stringify({ version: LOCAL_TRACKER_LOCK_VERSION, token, pid, acquiredAt: Date.now() });
}

/**
 * Start a child process and return a completion promise. The function is
 * deliberately NOT awaited: calling it in a loop starts every child before
 * the first `await`, which is the difference between real parallel contention
 * and a sequential batch that merely looks concurrent.
 */
function startNode(args: string[]): {
  done: Promise<{ status: number | null; stdout: string; stderr: string }>;
  stderrNow: () => string;
} {
  const child = spawn(process.execPath, args);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveDone) => {
    child.on("close", (status) => resolveDone({ status, stdout, stderr }));
  });
  return { done, stderrNow: () => stderr };
}

/** Block until every path exists, or fail loudly instead of hanging. */
async function waitForPaths(paths: readonly string[], deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (paths.every((path) => existsSync(path))) return;
    if (Date.now() >= deadline) throw new Error(`paths never appeared: ${paths.join(", ")}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
}

/** A PATH containing only `git`, proving the adapter needs no tracker CLI. */
async function installGitOnlyPath(): Promise<() => void> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-git-only-"));
  const segment = (process.env.PATH ?? "")
    .split(":")
    .find((entry) => entry.length > 0 && existsSync(join(entry, "git")));
  if (segment === undefined) throw new Error("no git executable on PATH");
  await symlink(join(segment, "git"), join(parent, "git"));
  const previous = process.env.PATH;
  process.env.PATH = parent;
  return () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    void rm(parent, { recursive: true, force: true }).catch(() => undefined);
  };
}

const repositories: TestRepository[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
});

async function newRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  return repository;
}

describe("the local tracker store is canonical, versioned, and outside every working tree", () => {
  it("resolves the versioned store under the Git common directory", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    // `git rev-parse --git-common-dir` prints a path relative to the working
    // directory in the primary checkout, so it must be resolved against the
    // repository root and canonicalized, never against the test process cwd.
    const reported = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: repository.root })).stdout;
    const commonDir = await realpath(resolve(repository.root, reported));
    expect(location.directory).toBe(join(commonDir, LOCAL_TRACKER_STORE_DIRECTORY));
    expect(location.storePath).toBe(join(location.directory, "store.json"));
    expect(location.lockPath).toBe(join(location.directory, "store.lock"));
    expect(location.guardPath).toBe(join(location.directory, "store.lock.guard"));
  });

  it("creates the store as 0600 files inside a 0700 directory and never touches the working tree", async () => {
    const repository = await newRepository();
    const before = await trackedWorktreeEntries(repository.root);
    const statusBefore = (await run("git", ["status", "--porcelain"], { cwd: repository.root })).stdout;

    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "Canonical decisions" });
    const location = await resolveLocalTrackerStoreLocation(repository.root);

    expect(tracker.provider).toBe("local");
    expect(tracker.project).toBe(location.storePath);
    expect(spec.url.startsWith("file://")).toBe(true);
    expect((await lstat(location.storePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(location.directory)).mode & 0o777).toBe(0o700);
    // The Git common directory is itself under the repository root, so the
    // meaningful claim is containment in the common dir plus a working tree
    // that is byte-for-byte unchanged (asserted above).
    expect(location.storePath.startsWith(`${location.gitCommonDir}${sep}`)).toBe(true);

    expect(await trackedWorktreeEntries(repository.root)).toEqual(before);
    expect((await run("git", ["status", "--porcelain"], { cwd: repository.root })).stdout).toBe(statusBefore);
  });

  it("completes the whole lifecycle with no tracker CLI on PATH", async () => {
    const repository = await newRepository();
    const restorePath = await installGitOnlyPath();
    try {
      const tracker = createLocalTrackerAdapter(repository.root);
      const spec = await tracker.createSpec({ title: "No CLI", body: "Body" });
      const ticket = await tracker.createTicket({
        title: "No CLI ticket",
        body: "Acceptance",
        parentSpecId: spec.id,
        dependencyText: "none",
      });
      await tracker.commentTicket(ticket.id, "evidence");
      await tracker.closeTicket(ticket.id);
      expect((await tracker.getTicket(ticket.id)).state).toBe("closed");
    } finally {
      restorePath();
    }
  });

  it("persists every item across uninstall and reinstall", async () => {
    const repository = await newRepository();
    const openCode = await installFakeOpenCode();
    const uv = await installFakeUv();
    try {
      await init(
        repository.root,
        { ...baseConfig(), tracker: { provider: "local" } },
        { skipSkills: true },
      );
      const tracker = createLocalTrackerAdapter(repository.root);
      const spec = await tracker.createSpec({ title: "Survives uninstall", body: "Durable" });
      const location = await resolveLocalTrackerStoreLocation(repository.root);

      const removed = await uninstall(repository.root);
      expect(removed.complete).toBe(true);
      expect((await readFile(location.storePath, "utf8")).length).toBeGreaterThan(0);

      // `uninstall` deliberately PRESERVES durable working-tree artifacts
      // (canonical role files, generated agent files) so it can never destroy
      // Author content, so `init` still refuses to overwrite them. A clean
      // reinstall therefore clears exactly those working-tree artifacts first.
      // The tracker store is NOT one of them, which is the point being proven.
      await rm(join(repository.root, ".poiesis"), { recursive: true, force: true });
      for (const destination of POIESIS_DURABLE_PATHS) {
        await rm(join(repository.root, destination), { recursive: true, force: true });
      }
      // `uninstall` neither removed nor preserved anything tracker-shaped: the
      // store is not a working-tree artifact, so it is outside its scope in
      // both directions.
      expect([...removed.removed, ...removed.preserved.map((entry) => entry.path)].join("\n")).not.toContain(
        "poiesis-tracker-v1",
      );

      await init(
        repository.root,
        { ...baseConfig(), tracker: { provider: "local" } },
        { skipSkills: true },
      );
      const after = createLocalTrackerAdapter(repository.root);
      expect((await after.getSpec(spec.id)).title).toBe("Survives uninstall");
      // The counter did not restart: a reinstall continues the same sequence.
      expect((await after.createSpec({ title: "After reinstall", body: "B" })).id).toBe("LOCAL-2");
    } finally {
      uv.restore();
      openCode.restore();
    }
  }, 90_000);
});

describe("the local tracker implements the complete TrackerAdapter", () => {
  it("issues stable monotonic LOCAL ids and round-trips exact dependency text", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "Decisions" });
    expect(spec.id).toBe("LOCAL-1");
    expect(spec.kind).toBe("spec");
    expect(spec.state).toBe("open");
    expect(spec.body).toBe("Decisions");

    const ticket = await tracker.createTicket({
      title: "Slice one",
      body: "Acceptance",
      parentSpecId: spec.id,
      dependencyText: EXACT_DEPENDENCY_TEXT,
    });
    expect(ticket.id).toBe("LOCAL-2");
    expect(ticket.parentSpecId).toBe("LOCAL-1");
    expect(ticket.dependencyText).toBe(EXACT_DEPENDENCY_TEXT);

    // A completely separate adapter instance (the next CLI invocation)
    // observes the identical bytes.
    const reloaded = createLocalTrackerAdapter(repository.root);
    expect((await reloaded.getTicket(ticket.id)).dependencyText).toBe(EXACT_DEPENDENCY_TEXT);
    const next = await reloaded.createSpec({ title: "Second spec", body: "B" });
    expect(next.id).toBe("LOCAL-3");
  });

  it("preserves relationships through update, comment, close and supersede with durable history", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "Decisions" });
    const ticket = await tracker.createTicket({
      title: "Slice one",
      body: "Acceptance",
      parentSpecId: spec.id,
      dependencyText: "LOCAL-9",
    });

    const updated = await tracker.updateTicket(ticket.id, {
      title: "Slice one, revised",
      body: "Revised acceptance",
      dependencyText: "LOCAL-9\nLOCAL-10",
    });
    expect(updated.title).toBe("Slice one, revised");
    expect(updated.body).toBe("Revised acceptance");
    expect(updated.dependencyText).toBe("LOCAL-9\nLOCAL-10");

    const comment = await tracker.commentTicket(ticket.id, "Reviewer: evidence attached.");
    expect(comment.itemId).toBe(ticket.id);
    expect(comment.id).toBe(`${ticket.id}-C1`);
    expect(comment.url).toContain(comment.id);

    expect((await tracker.closeTicket(ticket.id)).state).toBe("closed");

    const replacement = await tracker.createTicket({
      title: "Replacement",
      body: "Replanned acceptance",
      parentSpecId: spec.id,
      dependencyText: `supersedes ${ticket.id}`,
    });
    const superseded = await tracker.supersedeTicket(ticket.id, {
      reason: "Design evidence changed",
      replacementIds: [replacement.id],
    });
    expect(superseded.state).toBe("superseded");
    expect(superseded.supersededReason).toBe("Design evidence changed");
    expect(superseded.supersededBy).toEqual([replacement.id]);
    expect(superseded.parentSpecId).toBe(spec.id);
    expect(superseded.dependencyText).toBe("LOCAL-9\nLOCAL-10");

    const reloaded = createLocalTrackerAdapter(repository.root);
    const raw = await readStoreJson((await resolveLocalTrackerStoreLocation(repository.root)).storePath);
    const record = (raw.items as Record<string, { comments: unknown[]; history: { operation: string }[] }>)[
      ticket.id
    ]!;
    expect(record.history.map((entry) => entry.operation)).toEqual([
      "create",
      "update",
      "comment",
      "close",
      "supersede",
    ]);
    expect(record.comments).toHaveLength(2);
    expect((await reloaded.getTicket(ticket.id)).state).toBe("superseded");
    expect((await reloaded.getSpec(spec.id)).state).toBe("open");
  });

  it("supersedes a Spec and keeps the superseded reason out of the open state", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Old intent", body: "B" });
    const superseded = await tracker.supersedeSpec(spec.id, { reason: "Replanned" });
    expect(superseded.state).toBe("superseded");
    expect(superseded.supersededBy).toEqual([]);
    // A close after supersession must not resurrect the item as merely closed.
    expect((await tracker.closeSpec(spec.id)).state).toBe("superseded");
  });

  it("refuses a replacement identifier that is not a LOCAL id instead of writing a store its own validator refuses", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const before = await readFile(location.storePath, "utf8");

    // `supersededBy` is PERSISTED, and the strict store validator refuses any
    // entry that is not a LOCAL identifier. Accepting an arbitrary value here
    // commits a store this adapter can never read again — the failure is the
    // caller's, and it is total, not a single bad read. Every non-LOCAL value
    // is therefore rejected as invalid input BEFORE the mutation.
    for (const replacementIds of [["ENG-123"], [spec.id, "#42"], ["local-3"], ["LOCAL-0"], [""]]) {
      await expect(
        tracker.supersedeTicket(ticket.id, { reason: "Replanned", replacementIds }),
      ).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT" });
    }
    // The rejection leaves the canonical bytes EXACTLY as they were, and the
    // items that were readable before are still readable.
    expect(await readFile(location.storePath, "utf8")).toBe(before);
    expect((await tracker.getTicket(ticket.id)).state).toBe("open");
    expect((await tracker.getSpec(spec.id)).title).toBe("Intent");

    // A genuine LOCAL replacement is unchanged, including the empty list.
    const replacement = await tracker.createTicket({
      title: "Replacement",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    const superseded = await tracker.supersedeTicket(ticket.id, {
      reason: "Replanned",
      replacementIds: [replacement.id],
    });
    expect(superseded.state).toBe("superseded");
    expect(superseded.supersededBy).toEqual([replacement.id]);
    const reloaded = createLocalTrackerAdapter(repository.root);
    expect((await reloaded.getTicket(ticket.id)).supersededBy).toEqual([replacement.id]);
    expect((await reloaded.supersedeSpec(spec.id, { reason: "Also replanned" })).supersededBy).toEqual([]);
  });

  it("records a replacement this store never issued instead of refusing the supersession", async () => {
    // Break: requiring the replacement to EXIST would make supersession depend
    // on a resolution the tracker never promised. A Replan names the ticket that
    // will replace this one, and that ticket is routinely created after the
    // supersession is recorded. Every provider stores the reference without
    // resolving it, so the Local tracker must not be the one that invents a
    // stricter rule. The IDENTITY is still validated — a non-LOCAL value is
    // refused above, because it would commit a store this adapter can never
    // read again — while EXISTENCE is not invented.
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });

    const superseded = await tracker.supersedeTicket(ticket.id, {
      reason: "Replanned",
      replacementIds: ["LOCAL-99"],
    });

    expect(superseded).toMatchObject({ state: "superseded", supersededBy: ["LOCAL-99"] });
    // Persisted, and still a store this adapter's own strict validator reads.
    const reloaded = createLocalTrackerAdapter(repository.root);
    expect((await reloaded.getTicket(ticket.id)).supersededBy).toEqual(["LOCAL-99"]);
    // The never-issued identifier is not an item, and nothing invents one.
    await expect(reloaded.getTicket("LOCAL-99")).rejects.toMatchObject({ code: "TRACKER_ITEM_NOT_FOUND" });
  });

  it("mints a fresh comment id when a valid store carries a noncontiguous comment run", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    // A noncontiguous run is a VALID store (unique, pattern-conforming ids),
    // e.g. one migrated in from another tool. `comments.length + 1` would
    // mint `C3` a second time and write a store its own validator refuses.
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const store = await readStoreJson(location.storePath);
    const record = (store.items as Record<string, { comments: { id: string; itemId: string; body: string; createdAt: string }[] }>)[
      ticket.id
    ]!;
    record.comments = [
      { id: `${ticket.id}-C2`, itemId: ticket.id, body: "imported two", createdAt: new Date().toISOString() },
      { id: `${ticket.id}-C3`, itemId: ticket.id, body: "imported three", createdAt: new Date().toISOString() },
    ];
    await writeFile(location.storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });

    const comment = await tracker.commentTicket(ticket.id, "appended after import");
    expect(comment.id).toBe(`${ticket.id}-C4`);
    // The store it wrote is readable by its own strict validator.
    const reread = createLocalTrackerAdapter(repository.root);
    expect((await reread.getTicket(ticket.id)).id).toBe(ticket.id);
    expect((await reread.commentSpec(spec.id, "still usable")).id).toBe(`${spec.id}-C1`);
  });

  it("validates the parent Spec on ticket creation", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "Child",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });

    await expect(
      tracker.createTicket({ title: "Orphan", body: "B", parentSpecId: "LOCAL-999", dependencyText: "none" }),
    ).rejects.toMatchObject({ code: "TRACKER_ITEM_NOT_FOUND" });

    await expect(
      tracker.createTicket({ title: "Grandchild", body: "B", parentSpecId: ticket.id, dependencyText: "none" }),
    ).rejects.toMatchObject({ code: "TRACKER_ITEM_KIND_MISMATCH" });

    await expect(
      tracker.createTicket({ title: "No parent", body: "B", parentSpecId: "  ", dependencyText: "none" }),
    ).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT" });
  });

  it("rejects empty titles, bodies, dependency text and unknown ids", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    await expect(tracker.createSpec({ title: " ", body: "B" })).rejects.toMatchObject({
      code: "INVALID_ADAPTER_INPUT",
    });
    await expect(tracker.getSpec("LOCAL-404")).rejects.toMatchObject({ code: "TRACKER_ITEM_NOT_FOUND" });
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    // A Spec is not a Ticket: the kind guard fires before any field is read.
    await expect(tracker.getTicket(spec.id)).rejects.toMatchObject({ code: "TRACKER_ITEM_KIND_MISMATCH" });
    await expect(
      tracker.createTicket({ title: "T", body: "B", parentSpecId: spec.id, dependencyText: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    await expect(tracker.commentTicket(ticket.id, " ")).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT" });
    await expect(tracker.supersedeTicket(ticket.id, { reason: "" })).rejects.toMatchObject({
      code: "INVALID_ADAPTER_INPUT",
    });
  });

  it("shares one store across linked worktrees with a single monotonic sequence", async () => {
    const repository = await newRepository();
    const worktree = join(repository.parent, "linked");
    await run("git", ["worktree", "add", "--quiet", "--no-track", "-b", "poiesis/local-linked", worktree], {
      cwd: repository.root,
    });

    const primary = createLocalTrackerAdapter(repository.root);
    const spec = await primary.createSpec({ title: "Intent", body: "B" });
    expect(spec.id).toBe("LOCAL-1");

    // The linked worktree observes the primary checkout's items and continues
    // the same identifier sequence.
    const linked = createLocalTrackerAdapter(worktree);
    expect((await linked.getSpec(spec.id)).title).toBe("Intent");
    const fromWorktree = await linked.createTicket({
      title: "From worktree",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    expect(fromWorktree.id).toBe("LOCAL-2");
    expect((await primary.getTicket(fromWorktree.id)).title).toBe("From worktree");

    const location = await resolveLocalTrackerStoreLocation(worktree);
    expect(location).toEqual(await resolveLocalTrackerStoreLocation(repository.root));
  });
});

/**
 * Spec #139 / ticket #150 — an identifier that names a JavaScript prototype
 * member is not a tracker item.
 *
 * `store.items` is a plain object, so a bracket lookup of `__proto__`,
 * `constructor`, or `toString` returns something REAL — an inherited object or
 * function — where the caller asked for a Poiesis item. A lookup that treats
 * an inherited value as "found" therefore does not report a missing item at
 * all: it either throws a bare `TypeError` from inside the adapter, with no
 * code an operator can branch on, or (for a key that reaches a field read)
 * surfaces inherited content as if the tracker had recorded it. Membership is
 * therefore OWN-property membership, and every such identifier gets exactly
 * the typed refusal an unknown identifier has always gotten, with the store
 * left byte-for-byte untouched.
 */
describe("the local store resolves an identifier by own property, never through the prototype chain", () => {
  const INHERITED_KEYS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"] as const;

  it("reports an inherited prototype member as a missing item on every read", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    await tracker.createSpec({ title: "Intent", body: "B" });

    for (const key of INHERITED_KEYS) {
      for (const call of [
        () => tracker.getSpec(key),
        () => tracker.getTicket(key),
      ]) {
        const error = await call().then(
          () => undefined,
          (reason: unknown) => reason,
        );
        // The typed refusal, not a `TypeError` raised while reading a field off
        // `Object.prototype`.
        expect(error, `${key} must be an unknown item`).toBeInstanceOf(PoiesisError);
        expect(error, `${key} must be an unknown item`).toMatchObject({
          code: "TRACKER_ITEM_NOT_FOUND",
          details: { id: key },
        });
      }
    }
  });

  it("reports it on every mutation and leaves the canonical store byte-identical", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const before = await readFile(location.storePath, "utf8");

    for (const key of INHERITED_KEYS) {
      for (const call of [
        () => tracker.updateSpec(key, { title: "Renamed" }),
        () => tracker.updateTicket(key, { body: "Rewritten" }),
        () => tracker.commentSpec(key, "note"),
        () => tracker.commentTicket(key, "note"),
        () => tracker.closeSpec(key),
        () => tracker.closeTicket(key),
        () => tracker.supersedeSpec(key, { reason: "Replanned" }),
        () => tracker.supersedeTicket(key, { reason: "Replanned" }),
      ]) {
        await expect(call(), `${key} must be an unknown item`).rejects.toMatchObject({
          code: "TRACKER_ITEM_NOT_FOUND",
        });
      }
    }

    // Every rejection happened inside the guarded read-modify-write, so the
    // proof is that none of them reached the durable write at all.
    expect(await readFile(location.storePath, "utf8")).toBe(before);
    expect((await tracker.getSpec(spec.id)).title).toBe("Intent");
    expect((await tracker.getTicket(ticket.id)).body).toBe("B");
  });

  it("refuses a ticket whose parent identifier is an inherited prototype member", async () => {
    // Break: the parent check runs inside the mutation, so a lookup that
    // resolved `constructor` to an inherited function would create the ticket
    // against something the store never issued.
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const before = await readFile(location.storePath, "utf8").catch(() => "");

    for (const key of INHERITED_KEYS) {
      await expect(
        tracker.createTicket({ title: "Orphan", body: "B", parentSpecId: key, dependencyText: "none" }),
        `${key} must be an unknown parent`).rejects.toMatchObject({ code: "TRACKER_ITEM_NOT_FOUND" });
    }

    expect(await readFile(location.storePath, "utf8").catch(() => "")).toBe(before);
  });
});

describe("the local tracker store is validated strictly and fails closed", () => {
  async function seeded(): Promise<{ repository: TestRepository; tracker: ReturnType<typeof createLocalTrackerAdapter>; storePath: string }> {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });
    await tracker.commentTicket(ticket.id, "seeded comment");
    return { repository, tracker, storePath: (await resolveLocalTrackerStoreLocation(repository.root)).storePath };
  }

  async function expectRefused(
    mutate: (store: Record<string, unknown>) => void,
  ): Promise<void> {
    const { tracker, storePath } = await seeded();
    const store = await readStoreJson(storePath);
    mutate(store);
    const corrupted = `${JSON.stringify(store, null, 2)}\n`;
    await writeFile(storePath, corrupted, { mode: 0o600 });
    for (const call of [
      () => tracker.getSpec("LOCAL-1"),
      () => tracker.commentSpec("LOCAL-1", "note"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "INVALID_LOCAL_TRACKER_STORE" });
    }
    expect(await readFile(storePath, "utf8")).toBe(corrupted);
  }

  it("refuses a store that is not JSON", async () => {
    const { tracker, storePath } = await seeded();
    await writeFile(storePath, "{not json", { mode: 0o600 });
    await expect(tracker.getSpec("LOCAL-1")).rejects.toMatchObject({ code: "INVALID_LOCAL_TRACKER_STORE" });
    expect(await readFile(storePath, "utf8")).toBe("{not json");
  });

  it("refuses an unknown schema version or provider", async () => {
    await expectRefused((store) => {
      store.schema = 2;
    });
    await expectRefused((store) => {
      store.provider = "fixture-test-only";
    });
  });

  it("refuses a non-positive or colliding nextId", async () => {
    await expectRefused((store) => {
      store.nextId = 0;
    });
    await expectRefused((store) => {
      store.nextId = "2";
    });
    await expectRefused((store) => {
      store.nextId = 2;
    });
  });

  it("refuses an identifier that is not a LOCAL id", async () => {
    await expectRefused((store) => {
      const items = store.items as Record<string, unknown>;
      store.items = { "7": items["LOCAL-1"] };
    });
    await expectRefused((store) => {
      (store.items as Record<string, { item: { id: string } }>)["LOCAL-1"]!.item.id = "7";
    });
  });

  it("refuses an unknown history operation and a superseded item without a reason", async () => {
    await expectRefused((store) => {
      const record = (store.items as Record<string, { history: { operation: string }[] }>)["LOCAL-1"]!;
      record.history[0]!.operation = "obliterate";
    });
    await expectRefused((store) => {
      const record = (store.items as Record<string, { item: { state: string } }>)["LOCAL-1"]!;
      record.item.state = "superseded";
    });
  });

  it("refuses a ticket without exact dependency text and a Spec that carries one", async () => {
    await expectRefused((store) => {
      delete (store.items as Record<string, { item: Record<string, unknown> }>)["LOCAL-2"]!.item.dependencyText;
    });
    await expectRefused((store) => {
      (store.items as Record<string, { item: Record<string, unknown> }>)["LOCAL-1"]!.item.dependencyText = "none";
    });
  });

  it("refuses a ticket without a parent Spec and a comment pointing at another item", async () => {
    await expectRefused((store) => {
      delete (store.items as Record<string, { item: Record<string, unknown> }>)["LOCAL-2"]!.item.parentSpecId;
    });
    await expectRefused((store) => {
      const record = (store.items as Record<string, { comments: { itemId: string }[] }>)["LOCAL-2"]!;
      record.comments[0]!.itemId = "LOCAL-1";
    });
  });

  it("refuses a symlinked, nonregular, or world-readable store without touching the target", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);
    const outside = join(repository.parent, "outside-store.json");
    await writeFile(outside, "do not touch\n", { mode: 0o600 });

    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    await symlink(outside, location.storePath);
    await expect(tracker.getSpec("LOCAL-1")).rejects.toMatchObject({ code: "LOCAL_TRACKER_STORE_UNSAFE" });
    await expect(tracker.createSpec({ title: "T", body: "B" })).rejects.toMatchObject({
      code: "LOCAL_TRACKER_STORE_UNSAFE",
    });
    expect(await readFile(outside, "utf8")).toBe("do not touch\n");

    await rm(location.storePath, { force: true });
    await mkdir(location.storePath);
    await expect(tracker.createSpec({ title: "T", body: "B" })).rejects.toMatchObject({
      code: "LOCAL_TRACKER_STORE_UNSAFE",
    });
    await rm(location.storePath, { recursive: true, force: true });

    const spec = await tracker.createSpec({ title: "T", body: "B" });
    await chmod(location.storePath, 0o644);
    await expect(tracker.getSpec(spec.id)).rejects.toMatchObject({ code: "LOCAL_TRACKER_STORE_UNSAFE" });
    // A tightened store resumes working, and every write re-establishes 0600.
    await chmod(location.storePath, 0o600);
    await tracker.commentSpec(spec.id, "resumed");
    expect((await lstat(location.storePath)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked store directory and a symlinked lock path", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const outsideDir = join(repository.parent, "outside-store-dir");
    await mkdir(outsideDir);
    await symlink(outsideDir, location.directory);
    const tracker = createLocalTrackerAdapter(repository.root);
    await expect(tracker.createSpec({ title: "T", body: "B" })).rejects.toMatchObject({
      code: "LOCAL_TRACKER_STORE_UNSAFE",
    });
    await rm(location.directory, { force: true });

    const spec = await tracker.createSpec({ title: "T", body: "B" });
    const outsideLock = join(repository.parent, "outside-lock.json");
    await writeFile(outsideLock, "foreign\n", { mode: 0o600 });
    await symlink(outsideLock, location.lockPath);
    await expect(tracker.commentSpec(spec.id, "note")).rejects.toMatchObject({
      code: "LOCAL_TRACKER_STORE_UNSAFE",
    });
    expect(await readFile(outsideLock, "utf8")).toBe("foreign\n");
    expect((await lstat(location.storePath)).isFile()).toBe(true);
  });

  it("ignores a stray temporary file instead of reading it as the store", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const spec = await tracker.createSpec({ title: "T", body: "B" });
    const abandoned = join(location.directory, `store.json.${randomUUID()}.tmp`);
    await writeFile(abandoned, "partial", { mode: 0o600 });
    expect((await tracker.getSpec(spec.id)).title).toBe("T");
    await tracker.commentSpec(spec.id, "note");
    expect((await readdir(location.directory)).sort()).toEqual(["store.json"]);
  });
});

/**
 * Spec #139 / ticket #155 — a permission refusal is a VALUE, never a command.
 *
 * The store lives inside a Git common directory whose name Poiesis did not
 * choose, and its three artifacts are addressed by full path. A diagnostic that
 * assembles `chmod 600 <path>` therefore hands a command to whatever the path
 * contains: a renamed clone, a checkout under a hostile parent directory, a
 * space, a quote, a newline, a `;`, a `$()`. An operator who trusts an error
 * message is exactly the person who runs it, so the refusal carries the exact
 * path and BOTH modes as structured VALUES, and states the repair as PROSE that
 * names no executable and interpolates nothing.
 *
 * The properties that make that claim checkable, and that a plausible
 * implementation gets wrong, are all asserted below: the modes must be
 * separate fields an operator can compare, the prose must survive a hostile
 * path byte-for-byte, the WHOLE serialized error must contain no shell syntax
 * outside the path value, and none of it may weaken the fail-closed refusal
 * that makes the permission check worth having in the first place.
 */
describe.skipIf(process.platform === "win32")(
  "the local tracker permission refusal reports values and prose, never a command",
  () => {
    /**
     * One hostile path per way a path can break a pasted command. A space
     * splits an argument, a quote ends one, a newline starts a second line, a
     * `;` starts a second command, and `$(...)` / backticks / `|` all
     * substitute or redirect. Each is written to disk first so the refusal is
     * provoked by a real artifact rather than by a synthetic path.
     */
    const HOSTILE_SEGMENTS: readonly string[] = [
      "store with space.json",
      "store'single'quote.json",
      'store"double"quote.json',
      "store\nnewline.json",
      "store;semicolon.json",
      "store$(id).json",
      "store`id`.json",
      "store|tee|pwned.json",
      "store 600.json & curl evil",
    ];

    /**
     * The whole point of prose remediation, stated as assertions. A step is
     * acceptable only if it names no executable, carries no character a shell
     * would act on, and contains no path at all.
     */
    function expectNoExecutableProse(step: string, path: string): void {
      expect(step, "prose must name no executable").not.toMatch(
        /\b(chmod|chown|chgrp|rm|rmdir|unlink|sudo|doas|sh|bash|zsh|fish|pwsh|powershell|cmd|icacls|attrib|takeown|setfacl|install|run)\b/i,
      );
      expect(step, "prose must carry no shell syntax").not.toMatch(/[;&|`$><*?~\\]/);
      expect(step, "prose must interpolate no path").not.toContain(path);
    }

    /** The exact shape the CLI writes to stderr, built the way `writeFailure` builds it. */
    function serializeFailure(error: PoiesisError): string {
      return JSON.stringify({
        ok: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    it("reports the exact path, both modes, and an ordered procedure with no command in it", async () => {
      // Break: `repair: "chmod 600 <path>"` looks like the most helpful field
      // on the error and is the one field that turns a hostile directory name
      // into something a shell executes. The modes are the actionable part and
      // they are values, so the repair can be stated without being runnable.
      const repository = await newRepository();
      const location = await resolveLocalTrackerStoreLocation(repository.root);
      const tracker = createLocalTrackerAdapter(repository.root);
      await tracker.createSpec({ title: "Intent", body: "B" });
      await chmod(location.storePath, 0o644);

      const error = (await assertLocalTrackerStoreUsable(location).catch(
        (reason: unknown) => reason,
      )) as PoiesisError;
      expect(error).toBeInstanceOf(PoiesisError);
      expect(error.code).toBe("LOCAL_TRACKER_STORE_UNSAFE");
      const details = error.details;

      // The EXACT path, as a value. An operator (or Poiesis) can act on it.
      expect(details.path).toBe(location.storePath);
      expect(details.kind).toBe("permissions");
      // Both modes as separate comparable octal digit strings. The refusal is
      // useless without the pair: one says what is wrong, the other says what
      // is required.
      expect(details.currentMode).toBe("644");
      expect(details.expectedMode).toBe("600");
      // The command that used to live here is gone, not renamed.
      expect(details).not.toHaveProperty("repair");
      // The message is built from a fixed label and the observed mode only, so
      // no path byte can reach a sentence that a human reads as instruction.
      expect(error.message).toMatch(/readable beyond its owner/);
      expect(error.message).not.toContain(location.storePath);

      const steps = details.permissionRecovery as string[];
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThanOrEqual(4);
      for (const step of steps) expectNoExecutableProse(step, location.storePath);
      // The order is the whole point of guidance: what the mode means, what to
      // change, where the two mode values are, how to apply it, that it is
      // permanent, and what is not the repair.
      expect(steps[0]).toMatch(/owner/i);
      expect(steps[1]).toMatch(/group/i);
      expect(steps[1]).toMatch(/other/i);
      expect(steps[2]).toMatch(/currentMode/);
      expect(steps[2]).toMatch(/expectedMode/);
      expect(steps[3]).toMatch(/path value on this error/);
      expect(steps[4]).toMatch(/retry/i);
      expect(steps[5]).toMatch(/widen|copy/i);
      // Poiesis re-establishes the mode on every write, so the refusal is not a
      // recurring chore, and the guidance says so rather than implying the
      // operator must maintain it forever.
      expect(steps[4]).toMatch(/every write/i);
      // Widening, copying, or relocating the file is NOT the repair, and the
      // guidance says why.
      expect(steps.join("\n")).toMatch(/widen|copy/i);
    });

    it.each(HOSTILE_SEGMENTS)(
      "keeps a hostile store path an inert value in every field of the serialized error: %j",
      async (segment) => {
        // Break: guidance or a detail built by concatenation turns a path Poiesis
        // did not choose into an argument, a substitution, or a second command.
        // The path must survive byte-for-byte AS A VALUE and reach nothing else.
        const repository = await newRepository();
        const real = await resolveLocalTrackerStoreLocation(repository.root);
        await mkdir(real.directory, { recursive: true, mode: 0o700 });
        const hostile = join(real.directory, segment);
        await writeFile(hostile, "{}\n", { mode: 0o600 });
        // `writeFile`'s mode is masked by the ambient umask, so the mode the
        // refusal observes is set explicitly rather than inherited.
        await chmod(hostile, 0o644);
        const planted = await readFile(hostile, "utf8");

        const error = (await assertLocalTrackerStoreUsable({ ...real, storePath: hostile }).catch(
          (reason: unknown) => reason,
        )) as PoiesisError;
        expect(error.code).toBe("LOCAL_TRACKER_STORE_UNSAFE");
        // Preserved exactly, in the one field a reader or Poiesis can act on.
        expect(error.details.path).toBe(hostile);
        expect(error.details.currentMode).toBe("644");

        const steps = error.details.permissionRecovery as string[];
        expect(Array.isArray(steps)).toBe(true);
        for (const step of steps) {
          expectNoExecutableProse(step, hostile);
          // Not one attacker-controlled byte reached the prose at all.
          expect(step, "prose must not carry any of the path's own bytes").not.toContain(segment);
        }

        // The FULL serialized error: exactly the bytes the CLI writes to stderr,
        // asserted as a whole rather than field by field. Removing every
        // occurrence of the path as a VALUE must leave nothing a shell could act
        // on and no executable named anywhere.
        const serialized = serializeFailure(error);
        const escapedPath = JSON.stringify(hostile).slice(1, -1);
        expect(serialized, "the path must travel as a value").toContain(escapedPath);
        const withoutPath = serialized.split(escapedPath).join("");
        expect(withoutPath, "the serialized error must carry no shell syntax").not.toMatch(/[;&|`$><]/);
        expect(withoutPath, "the serialized error must name no executable").not.toMatch(
          /\b(chmod|rm|unlink|sudo|sh|bash)\b/i,
        );
        // And nothing the path could have said happened: no planted file, no
        // rewritten bytes, no sibling artifact.
        expect(await readFile(hostile, "utf8")).toBe(planted);
        expect(await readdir(real.directory)).toEqual([segment]);
      },
    );

    it("still fails closed on every mode beyond the owner and re-establishes 0600 on the next write", async () => {
      // Break: softening the check to "warn and continue" would let a world
      // readable store be read and then rewritten, compounding a leak that has
      // already happened. Every mode with a group or other bit stays refused, the
      // refused bytes are untouched, and tightening by hand resumes the store.
      const repository = await newRepository();
      const location = await resolveLocalTrackerStoreLocation(repository.root);
      const tracker = createLocalTrackerAdapter(repository.root);
      const spec = await tracker.createSpec({ title: "Intent", body: "B" });
      const before = await readFile(location.storePath, "utf8");

      for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o777]) {
        await chmod(location.storePath, mode);
        const error = (await tracker.getSpec(spec.id).catch((reason: unknown) => reason)) as PoiesisError;
        expect(error.code, `mode ${mode.toString(8)} must be refused`).toBe("LOCAL_TRACKER_STORE_UNSAFE");
        expect(error.details.currentMode).toBe(mode.toString(8));
        expect(error.details.expectedMode).toBe("600");
        // A read that is refused writes nothing.
        expect(await readFile(location.storePath, "utf8")).toBe(before);
      }

      // The operator narrows it, and the store works again: the failure mode
      // was the mode, not the document.
      await chmod(location.storePath, 0o600);
      await tracker.commentSpec(spec.id, "resumed");
      expect((await lstat(location.storePath)).mode & 0o777).toBe(0o600);
      // The directory mode is still the 0700 Poiesis creates, so the fix is not
      // a one-off file edit that the next write undoes.
      expect((await lstat(location.directory)).mode & 0o777).toBe(0o700);
    });

    it("reports the same permission refusal for the lock artifact, before any waiting", async () => {
      // One helper, three artifacts. The lock is a store artifact too, so its
      // permission refusal must carry the same values and prose — and must be
      // reported as the permission problem it is, not as lock contention.
      const repository = await newRepository();
      const location = await resolveLocalTrackerStoreLocation(repository.root);
      await mkdir(location.directory, { recursive: true, mode: 0o700 });
      await writeFile(location.lockPath, lockEnvelope("live-holder", process.pid), { mode: 0o600 });
      await chmod(location.lockPath, 0o666);

      const error = (await acquireLocalTrackerLockWithTimeout(location, 200).catch(
        (reason: unknown) => reason,
      )) as PoiesisError;
      expect(error.code).toBe("LOCAL_TRACKER_STORE_UNSAFE");
      expect(error.details.path).toBe(location.lockPath);
      expect(error.details.kind).toBe("permissions");
      expect(error.details.currentMode).toBe("666");
      expect(error.details.expectedMode).toBe("600");
      for (const step of error.details.permissionRecovery as string[]) expectNoExecutableProse(step, location.lockPath);
      // The bounded-wait report is a different refusal with a different
      // procedure, and mixing them would send an operator to the wrong fix.
      expect(error.details).not.toHaveProperty("guardRecovery");
      expect(error.details).not.toHaveProperty("timeoutMs");
    });

    it("leaves the symlink and nonregular refusals free of permission fields", async () => {
      // Scope: only the PERMISSION diagnostic changes shape. A symlink or a
      // directory is a different refusal, and reporting a mode for it would be a
      // category error: there is no mode to change on something that is not the
      // file the store owns.
      const repository = await newRepository();
      const location = await resolveLocalTrackerStoreLocation(repository.root);
      await mkdir(location.directory, { recursive: true, mode: 0o700 });
      const outside = join(repository.parent, "outside-permission-scope.json");
      await writeFile(outside, "keep\n", { mode: 0o600 });
      await symlink(outside, location.storePath);

      const symlinked = (await assertLocalTrackerStoreUsable(location).catch(
        (reason: unknown) => reason,
      )) as PoiesisError;
      expect(symlinked.code).toBe("LOCAL_TRACKER_STORE_UNSAFE");
      expect(symlinked.details.kind).toBe("symlink");
      expect(symlinked.details).not.toHaveProperty("permissionRecovery");
      expect(symlinked.details).not.toHaveProperty("expectedMode");
      expect(symlinked.details).not.toHaveProperty("currentMode");
      expect(symlinked.details).not.toHaveProperty("repair");

      await rm(location.storePath, { force: true });
      await mkdir(location.storePath);
      const nonregular = (await assertLocalTrackerStoreUsable(location).catch(
        (reason: unknown) => reason,
      )) as PoiesisError;
      expect(nonregular.code).toBe("LOCAL_TRACKER_STORE_UNSAFE");
      expect(nonregular.details.kind).toBe("non-regular");
      expect(nonregular.details).not.toHaveProperty("permissionRecovery");
      expect(nonregular.details).not.toHaveProperty("expectedMode");
      expect(await readFile(outside, "utf8")).toBe("keep\n");
    });
  },
);

describe("the local tracker serializes cross-process writers on a token-checked lock", () => {
  it("refuses to steal a live foreign lock and preserves it byte-for-byte", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    const foreign = lockEnvelope("foreign-token", process.pid);
    await writeFile(location.lockPath, foreign, { mode: 0o600 });

    await expect(acquireLocalTrackerLockWithTimeout(location, 300)).rejects.toMatchObject({
      code: "LOCAL_TRACKER_LOCK_TIMEOUT",
    });
    expect(await readFile(location.lockPath, "utf8")).toBe(foreign);
  });

  it("reclaims a stale lock left by a dead process within a bounded wait", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "T", body: "B" });
    await writeFile(location.lockPath, lockEnvelope("stale-token", await deadPid()), { mode: 0o600 });

    await tracker.commentSpec(spec.id, "after crash");
    expect(await readFile(location.lockPath, "utf8").catch(() => "")).toBe("");
  });

  it("admits exactly one simultaneous owner when contenders race for one stale lock", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    // A stale lock from a dead holder, so every contender starts by trying to
    // RECLAIM it. The guard must still admit exactly one of them.
    await writeFile(location.lockPath, lockEnvelope("stale-token", await deadPid()), { mode: 0o600 });

    const contenders = 4;
    const boundedMs = 500;
    // All four acquisitions are launched in the same tick, so they contend for
    // the canonical lock rather than running one after another.
    const settled = await Promise.allSettled(
      Array.from({ length: contenders }, () => acquireLocalTrackerLockWithTimeout(location, boundedMs)),
    );
    const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
    const rejected = settled.filter((entry) => entry.status === "rejected");

    // Exactly one holder. The guard serializes the read-decide-write critical
    // section, so concurrent reclaimers cannot both win the `wx` slot.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(contenders - 1);
    for (const entry of rejected) {
      // The losers TIMED OUT; none of them stole or overwrote the lock.
      expect((entry as PromiseRejectedResult).reason).toMatchObject({ code: "LOCAL_TRACKER_LOCK_TIMEOUT" });
    }

    const winner = (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value;
    const snapshot = JSON.parse(await readFile(location.lockPath, "utf8")) as { token: string; pid: number };
    expect(snapshot.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(snapshot.pid).toBe(process.pid);

    await winner();
    // Token-checked release leaves no canonical lock and no wedged guard.
    expect(await readFile(location.lockPath, "utf8").catch(() => "")).toBe("");
    expect(await readFile(location.guardPath, "utf8").catch(() => "")).toBe("");
  });

  it("never releases a lock it does not own", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    const foreign = lockEnvelope("foreign-token", process.pid);
    await writeFile(location.lockPath, foreign, { mode: 0o600 });

    await releaseLocalTrackerLock(location, "a-different-token");
    expect(await readFile(location.lockPath, "utf8")).toBe(foreign);
    await releaseLocalTrackerLock(location, "foreign-token");
    expect(await readFile(location.lockPath, "utf8").catch(() => "")).toBe("");
  });
});

/**
 * Spec #139 / ticket #148 — a guard left behind by a crash is the ONE wedged
 * artifact the runtime does not resolve on its own.
 *
 * The canonical `store.lock` has ordinary PID and ownership-token logic, so a
 * stale one is reclaimed inside the caller's bounded wait. The guard has no
 * such logic and must not grow any: a guard whose stamped holder PID is dead
 * still proves that SOME process was inside the read-decide-write critical
 * section, and the runtime cannot tell a crashed holder from a live one it is
 * merely not allowed to signal. Deleting it automatically would let two
 * processes believe they hold the critical section at once, which is exactly
 * the identity violation the guard exists to prevent.
 */
describe("a crash-left store lock guard is never auto-reclaimed, only reported", () => {
  it("times out within the bound on a pre-planted guard and leaves it byte-identical", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    // Planted as a VALID envelope naming a PID that is already gone: the
    // strongest form of the claim, because the canonical-lock stale check would
    // happily reclaim this bytes if the guard were treated the same way.
    const guard = lockEnvelope("crashed-holder-token", await deadPid());
    await writeFile(location.guardPath, guard, { mode: 0o600 });

    const boundedMs = 400;
    const startedAt = Date.now();
    const error = await acquireLocalTrackerLockWithTimeout(location, boundedMs).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const elapsed = Date.now() - startedAt;

    expect(error).toMatchObject({ code: "LOCAL_TRACKER_LOCK_TIMEOUT" });
    // Bounded: the wait is a real bound, not a hang. A generous ceiling absorbs
    // scheduler noise without hiding an unbounded wait.
    expect(elapsed).toBeLessThan(5_000);
    // Byte-identical: nothing rewrote, truncated, chmod-ed, or re-timestamped
    // the guard, and the runtime never unlinked it.
    expect(await readFile(location.guardPath, "utf8")).toBe(guard);
    expect((await lstat(location.guardPath)).mode & 0o777).toBe(0o600);
    // The canonical lock was never created: without the guard the runtime never
    // reaches the read-decide-write critical section at all.
    expect(await readFile(location.lockPath, "utf8").catch(() => "")).toBe("");
    expect((await readdir(location.directory)).sort()).toEqual(["store.lock.guard"]);
  });

  it("does not reclaim a dead canonical lock while the guard is wedged", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    // Both artifacts wedged. The canonical lock is reclaimable on its own; the
    // guard is not. A runtime that reclaimed the lock here would be mutating
    // the canonical path without holding the guard that authorizes it.
    const stale = lockEnvelope("stale-canonical-token", await deadPid());
    const guard = lockEnvelope("crashed-holder-token", await deadPid());
    await writeFile(location.lockPath, stale, { mode: 0o600 });
    await writeFile(location.guardPath, guard, { mode: 0o600 });

    await expect(acquireLocalTrackerLockWithTimeout(location, 400)).rejects.toMatchObject({
      code: "LOCAL_TRACKER_LOCK_TIMEOUT",
    });
    expect(await readFile(location.lockPath, "utf8")).toBe(stale);
    expect(await readFile(location.guardPath, "utf8")).toBe(guard);
  });

  it("resumes after the operator removes only the guard, reclaiming the dead canonical lock itself", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "T", body: "B" });

    // Exactly the two artifacts a process that died inside the guarded critical
    // section leaves behind, with a holder that is provably gone.
    await writeFile(location.lockPath, lockEnvelope("crashed-canonical-token", await deadPid()), { mode: 0o600 });
    await writeFile(location.guardPath, lockEnvelope("crashed-holder-token", await deadPid()), { mode: 0o600 });
    await expect(acquireLocalTrackerLockWithTimeout(location, 400)).rejects.toMatchObject({
      code: "LOCAL_TRACKER_LOCK_TIMEOUT",
    });

    // The operator's documented recovery is exactly one removal: the guard.
    await rm(location.guardPath);
    const release = await acquireLocalTrackerLockWithTimeout(location, 2_000);
    await release();

    // The canonical `store.lock` was never touched by hand and did not need to
    // be: the ordinary holder-PID and ownership-token check reclaimed the dead
    // one on its own. That is why the guidance must never point at it.
    expect(await readFile(location.lockPath, "utf8").catch(() => "")).toBe("");
    expect(await readFile(location.guardPath, "utf8").catch(() => "")).toBe("");
    await tracker.commentSpec(spec.id, "after operator recovery");
    // Recovery is lock plumbing, never a store repair: the wedged attempt wrote
    // nothing, and the canonical document carries exactly the one comment that
    // was actually committed.
    const store = await readStoreJson(location.storePath);
    const record = (store.items as Record<string, { comments: { body: string }[] }>)[spec.id]!;
    expect(record.comments.map((comment) => comment.body)).toEqual(["after operator recovery"]);
  });

  it("never clears a guard it cannot take, even from its own release path", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const release = await acquireLocalTrackerLockWithTimeout(location, 2_000);
    const owned = await readFile(location.lockPath, "utf8");
    // The holder is THIS process and its own release closure, so the only thing
    // standing between the release and an unconditional unlink is the refusal to
    // touch a guard it does not hold. A release path that "cleaned up after
    // itself" here would clear a guard another process is relying on.
    const guard = lockEnvelope("wedged-by-a-crash", await deadPid());
    await writeFile(location.guardPath, guard, { mode: 0o600 });

    await release();
    expect(await readFile(location.guardPath, "utf8")).toBe(guard);
    // The canonical lock is left alone too: without the guard, mutating it is
    // exactly the unlink a replacement lock could be destroyed by.
    expect(await readFile(location.lockPath, "utf8")).toBe(owned);
  }, 20_000);

  it("names both paths and the ordered operator procedure on the timeout", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    await writeFile(location.guardPath, lockEnvelope("crashed-holder-token", await deadPid()), { mode: 0o600 });

    const error = (await acquireLocalTrackerLockWithTimeout(location, 200).catch((reason: unknown) => reason)) as {
      details: Record<string, unknown>;
    };
    const details = error.details;
    // Both artifacts are named by their EXACT path. An operator who is told
    // "the lock" cannot tell which of the two files in the directory is the one
    // to look at.
    expect(details.lockPath).toBe(location.lockPath);
    expect(details.guardPath).toBe(location.guardPath);
    expect(details.storePath).toBe(location.storePath);
    expect(details.timeoutMs).toBe(200);

    const steps = details.guardRecovery as string[];
    expect(Array.isArray(steps)).toBe(true);
    const text = steps.join("\n");

    // Step one is the precondition, step two is the single permitted removal,
    // step three is the retry. Order is the whole point of the guidance.
    expect(steps[0]).toMatch(/first/i);
    expect(steps[0]).toMatch(/no Poiesis process is accessing this clone/i);
    expect(steps[1]).toMatch(/remove only the exact store\.lock\.guard artifact/i);
    expect(steps[2]).toMatch(/retry/i);
    // The canonical lock is explicitly OUT of scope, with the reason.
    expect(text).toMatch(/never remove the canonical store\.lock/i);
    expect(text).toMatch(/holder PID and ownership token/i);
    // The guard is never auto-reclaimed, and the guidance says so instead of
    // implying a self-healing runtime.
    expect(text).toMatch(/never reclaimed by the runtime/i);

    // The report hands over the EXACT paths as structured data (asserted above)
    // and describes the operation in prose, so nothing in the prose is a
    // command an operator could run and nothing in it is built by
    // concatenating a path.
    for (const step of steps) {
      expect(step, "the guidance must carry no command").not.toMatch(/\brm\b/i);
      expect(step, "the guidance must carry no command").not.toMatch(/\b(unlink|chmod|rmdir|sudo|sh|bash)\b/i);
      expect(step, "the guidance must carry no shell syntax").not.toMatch(/[;&|`$><]/);
      expect(step, "the guidance must carry no interpolated path").not.toContain(location.guardPath);
      expect(step, "the guidance must carry no interpolated path").not.toContain(location.lockPath);
    }
  });

  it("states the procedure in prose even when the guard path is hostile", async () => {
    // Break: guidance built by concatenation turns a hostile path into a
    // command. An operator who pastes `rm <path>` from an error message is
    // running whatever the path contains — a second argument, a substitution,
    // a pipe — and a path Poiesis did not choose is exactly what a rename or a
    // hostile clone can supply. The report therefore names the artifact, not a
    // command, and carries the exact path as a field an operator (or Poiesis)
    // can act on without ever being executed.
    const repository = await newRepository();
    const real = await resolveLocalTrackerStoreLocation(repository.root);
    await mkdir(real.directory, { recursive: true, mode: 0o700 });
    const hostile = join(real.directory, 'store.lock.guard"; rm -rf ~ $(id) `id` | tee pwned #');
    const planted = lockEnvelope("crashed-holder-token", await deadPid());
    await writeFile(hostile, planted, { mode: 0o600 });

    const error = (await acquireLocalTrackerLockWithTimeout({ ...real, guardPath: hostile }, 200).catch(
      (reason: unknown) => reason,
    )) as { details: Record<string, unknown> };
    const details = error.details;

    // The exact path IS available — structurally, as a value.
    expect(details.guardPath).toBe(hostile);
    const steps = details.guardRecovery as string[];
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const step of steps) {
      expect(step, "no command may be constructed from a path").not.toMatch(/\brm\b/i);
      expect(step, "no command may be constructed from a path").not.toMatch(/[;&|`$><]/);
      // The prose names the two fixed artifacts, so no attacker-controlled byte
      // reaches it at all.
      expect(step, "the prose must not interpolate the path").not.toContain(hostile);
    }
    // The refusal still happened, and it still changed nothing on disk.
    expect(await readFile(hostile, "utf8")).toBe(planted);
    expect((await readdir(real.directory)).sort()).toEqual([hostile.split("/").pop() as string]);
  });
});

describe("concurrent processes never lose a write or reuse an identifier", () => {
  let bundle: string | undefined;

  beforeAll(async () => {
    const outDir = await mkdtemp(join(tmpdir(), "poiesis-local-tracker-bundle-"));
    await run(
      "node",
      [
        "node_modules/tsup/dist/cli-default.js",
        "src/local-tracker.ts",
        "--format",
        "esm",
        "--no-dts",
        "--out-dir",
        outDir,
      ],
      { cwd: REPO_ROOT, timeoutMs: 90_000 },
    );
    bundle = join(outDir, "local-tracker.js");
  }, 120_000);

  it("serializes N SIMULTANEOUS ticket creations across OS processes without losing a write", async () => {
    const repository = await newRepository();
    const workers = 6;
    const seed = createLocalTrackerAdapter(repository.root);
    const spec = await seed.createSpec({ title: "Intent", body: "B" });

    // The children are released together through a gate file. Every child
    // signals readiness and then blocks on the gate, so all N processes are
    // alive and poised at the store BEFORE any of them mutates. That is what
    // makes this a contention test rather than N sequential runs: without the
    // barrier, process-startup jitter alone could serialize the whole batch.
    const gate = join(repository.parent, "gate");
    const script = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createLocalTrackerAdapter } from ${JSON.stringify(bundle)};
      const [repo, specId, worker, gatePath, readyPath] = process.argv.slice(2);
      writeFileSync(readyPath, "ready");
      const deadline = Date.now() + 60000;
      while (!existsSync(gatePath)) {
        if (Date.now() > deadline) { process.stderr.write("gate never opened\\n"); process.exit(3); }
        await new Promise((r) => setTimeout(r, 5));
      }
      const tracker = createLocalTrackerAdapter(repo);
      const ticket = await tracker.createTicket({
        title: worker, body: "B", parentSpecId: specId, dependencyText: "none",
      });
      await tracker.commentTicket(ticket.id, "note " + worker);
      process.stdout.write(JSON.stringify({ id: ticket.id }));
    `;
    const runner = join(repository.parent, "contend.mjs");
    await writeFile(runner, script, "utf8");

    // Spawn EVERY child before awaiting any of them. `startNode` returns as
    // soon as the process is running, so no child can finish before its
    // siblings exist.
    const readyPaths = Array.from({ length: workers }, (_, index) => join(repository.parent, `ready-${index}`));
    const children = Array.from({ length: workers }, (_, index) =>
      startNode([runner, repository.root, spec.id, `worker-${index}`, gate, readyPaths[index]!]),
    );
    // Wait until every child is parked on the gate, then open it.
    try {
      await waitForPaths(readyPaths);
    } catch (error) {
      throw new Error(`${(error as Error).message}\nchild stderr: ${children.map((c) => c.stderrNow()).join(" | ")}`);
    }
    await writeFile(gate, "go");

    const results = await Promise.all(children.map((child) => child.done));
    for (const [index, result] of results.entries()) {
      expect(result.status, `worker-${index}: ${result.stderr}`).toBe(0);
    }
    const ids = results.map((result) => (JSON.parse(result.stdout) as { id: string }).id);
    // No two processes took the same counter value, and none was skipped.
    expect(new Set(ids).size).toBe(workers);
    expect([...ids].sort()).toEqual(
      Array.from({ length: workers }, (_, index) => `LOCAL-${2 + index}`),
    );

    const store = await readStoreJson((await resolveLocalTrackerStoreLocation(repository.root)).storePath);
    const items = store.items as Record<string, { history: { operation: string }[]; comments: unknown[] }>;
    expect(Object.keys(items)).toHaveLength(1 + workers);
    expect(store.nextId).toBe(2 + workers);
    for (const id of ids) {
      // create, comment — no interleaved write was lost.
      expect(items[id]!.history.map((entry) => entry.operation)).toEqual(["create", "comment"]);
      expect(items[id]!.comments).toHaveLength(1);
    }
    expect(items[spec.id]!.history.map((entry) => entry.operation)).toEqual(["create"]);
  }, 120_000);
});

describe("the local tracker is wired into factory, verification and CLI surfaces", () => {
  /**
   * Spec #139 / ticket #141: the clause that asserted `linear` was still
   * refused is gone. `linear` is now a first-class provider behind the real
   * `TrackerAdapter` (see `tests/linear-tracker.test.ts`), so refusing it
   * here would assert that the Linear adapter does not exist. Every provider
   * in the union is now real; the fail-closed seam is covered by the
   * unknown-provider assertions in `tests/tracker-delivery-foundation.test.ts`.
   */
  it("createTrackerAdapter constructs a real local adapter", async () => {
    const repository = await newRepository();
    const adapter = createTrackerAdapter({ provider: "local" }, repository.root);
    expect(adapter.provider).toBe("local");
    expect((await adapter.createSpec({ title: "T", body: "B" })).id).toBe("LOCAL-1");
  });

  it("verifyTracker resolves the local store without any tracker CLI", async () => {
    const repository = await newRepository();
    const { config } = await autoResolveConfigDefaults(repository.root, {
      ...baseConfig(),
      tracker: { provider: "local" },
    });
    const restorePath = await installGitOnlyPath();
    try {
      expect(await verifyTracker(repository.root, config)).toBe("verified");
    } finally {
      restorePath();
    }
  });

  it("verifyTracker fails closed on a corrupt present store instead of reporting a healthy tracker", async () => {
    const repository = await newRepository();
    const { config } = await autoResolveConfigDefaults(repository.root, {
      ...baseConfig(),
      tracker: { provider: "local" },
    });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    // A real, well-formed store first, so the failure below is attributable to
    // the corruption and not to an absent or unusable path.
    const spec = await createLocalTrackerAdapter(repository.root).createSpec({ title: "T", body: "B" });
    expect(await verifyTracker(repository.root, config)).toBe("verified");

    for (const corrupt of ["{not json", JSON.stringify({ schema: 1, provider: "poiesis-local", nextId: 1 })]) {
      await writeFile(location.storePath, corrupt, { mode: 0o600 });
      await expect(verifyTracker(repository.root, config)).rejects.toMatchObject({
        code: "INVALID_LOCAL_TRACKER_STORE",
      });
      // The refused store is left byte-for-byte alone.
      expect(await readFile(location.storePath, "utf8")).toBe(corrupt);
    }

    // An ABSENT store is still valid: a project that has not created its
    // first Spec has nothing to validate.
    await rm(location.storePath, { force: true });
    expect(await verifyTracker(repository.root, config)).toBe("verified");
    void spec;
  });

  it("verifyTracker fails closed on an unsafe store path", async () => {
    const repository = await newRepository();
    const { config } = await autoResolveConfigDefaults(repository.root, {
      ...baseConfig(),
      tracker: { provider: "local" },
    });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const outside = join(repository.parent, "verify-outside.json");
    await writeFile(outside, "keep\n", { mode: 0o600 });
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    await symlink(outside, location.storePath);
    await expect(verifyTracker(repository.root, config)).rejects.toMatchObject({
      code: "LOCAL_TRACKER_STORE_UNSAFE",
    });
  });

  it("drives every tracker CLI action end to end", async () => {
    const repository = await newRepository();
    const openCode = await installFakeOpenCode();
    const uv = await installFakeUv();
    try {
      await init(
        repository.root,
        { ...baseConfig(), tracker: { provider: "local" } },
        { skipSkills: true },
      );
      const { commandTracker } = await import("../src/cli.js");
      const invoke = async (args: string[]): Promise<Record<string, unknown>> => {
        const chunks: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array): boolean => {
          chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        }) as typeof process.stdout.write;
        try {
          await commandTracker([...args, "--cwd", repository.root]);
        } finally {
          process.stdout.write = original;
        }
        return JSON.parse(chunks.join("")) as Record<string, unknown>;
      };

      const specCreated = await invoke(["spec", "create", "--title", "CLI intent", "--body", "Decisions"]);
      expect(specCreated).toMatchObject({ ok: true, operation: "tracker.spec.create" });
      const spec = specCreated.result as { id: string };

      const ticketCreated = await invoke([
        "ticket", "create",
        "--title", "CLI ticket",
        "--body", "Acceptance",
        "--parent", spec.id,
        "--dependencies", EXACT_DEPENDENCY_TEXT,
      ]);
      expect(ticketCreated).toMatchObject({ ok: true, operation: "tracker.ticket.create" });
      const ticket = ticketCreated.result as { id: string; dependencyText: string };
      expect(ticket.id).toBe("LOCAL-2");
      expect(ticket.dependencyText).toBe(EXACT_DEPENDENCY_TEXT);

      expect((await invoke(["ticket", "get", "--id", ticket.id])).result).toMatchObject({ id: ticket.id });
      expect(
        (await invoke(["ticket", "update", "--id", ticket.id, "--title", "CLI ticket, revised"])).result,
      ).toMatchObject({ title: "CLI ticket, revised" });
      expect(
        (await invoke(["ticket", "comment", "--id", ticket.id, "--body", "CLI note"])).result,
      ).toMatchObject({ itemId: ticket.id, body: "CLI note" });
      expect((await invoke(["ticket", "close", "--id", ticket.id])).result).toMatchObject({ state: "closed" });
      expect(
        (await invoke(["ticket", "supersede", "--id", ticket.id, "--reason", "Replanned"])).result,
      ).toMatchObject({ state: "superseded", supersededReason: "Replanned" });
      expect((await invoke(["spec", "get", "--id", spec.id])).result).toMatchObject({ state: "open" });
    } finally {
      uv.restore();
      openCode.restore();
    }
  }, 90_000);
});

/**
 * Spec #139 / ticket #158 — the Local update path enforces the SAME nonblank
 * dependency invariant `createTicket` already enforces.
 *
 * Ticket #158 makes this explicit because the invariant was only ever stated
 * about creation. An `updateTicket` that accepted blank dependency text would
 * commit a store the adapter's own strict validator refuses — the exact failure
 * the supersession `replacementIds` check was added to prevent — so the two
 * paths have to agree, and the store bytes have to survive the disagreement.
 */
describe("a local ticket update refuses blank dependency text exactly as a create does", () => {
  it("refuses empty and whitespace-only dependency text and leaves the store byte-identical", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: EXACT_DEPENDENCY_TEXT,
    });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const before = await readFile(location.storePath, "utf8");

    for (const dependencyText of ["", " ", "\n", "  \n\t  "]) {
      // A create refuses the same values, so the parity is asserted on both
      // sides of the same loop rather than inferred from one of them.
      await expect(
        tracker.createTicket({ title: "Fresh", body: "B", parentSpecId: spec.id, dependencyText }),
      ).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT", details: { name: "dependencyText" } });
      await expect(
        tracker.updateTicket(ticket.id, { dependencyText }),
      ).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT", details: { name: "dependencyText" } });
    }

    // Every rejection happened before the durable write, so the canonical bytes
    // are EXACTLY what they were and the evidence is intact.
    expect(await readFile(location.storePath, "utf8")).toBe(before);
    expect((await tracker.getTicket(ticket.id)).dependencyText).toBe(EXACT_DEPENDENCY_TEXT);
  });

  it("keeps valid dependency text byte-for-byte and leaves it untouched when omitted", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({
      title: "T",
      body: "B",
      parentSpecId: spec.id,
      dependencyText: "none",
    });

    const supplied = [
      "  LOCAL-10 pinned, leading spaces kept  ",
      "",
      "\tsecond line with tabs\t",
      "unicode: αβγ — ✓",
    ].join("\n");
    expect((await tracker.updateTicket(ticket.id, { dependencyText: supplied })).dependencyText).toBe(supplied);
    // Omitted is not "cleared": a title-only update must not disturb it.
    expect((await tracker.updateTicket(ticket.id, { title: "T, revised" })).dependencyText).toBe(supplied);
    const reloaded = createLocalTrackerAdapter(repository.root);
    expect((await reloaded.getTicket(ticket.id)).dependencyText).toBe(supplied);
  });
});

/**
 * Spec #139 / ticket #158 — a LOCAL identifier is EXACTLY `LOCAL-` followed by
 * a nonzero decimal integer with no leading zero, and nothing else.
 *
 * The store validator resolved the number with `/^LOCAL-(\d+)$/`, so `LOCAL-01`
 * and `LOCAL-1` were two spellings of item number 1. A store could therefore
 * carry both, the monotonicity check could not see the alias, and a parent or
 * supersession reference could be written in the padded spelling that resolved
 * to an item the caller never named. Canonical form is what makes one
 * identifier mean one item, so it is enforced on BOTH sides of the contract:
 * the persisted document (fail closed, bytes preserved) and the caller's own
 * arguments (refused before any write).
 */
describe("a LOCAL identifier is canonical or it is nothing", () => {
  /** Padded, zero, malformed, and unsafe-integer spellings of a LOCAL id. */
  const NONCANONICAL_IDS = [
    "LOCAL-01",
    "LOCAL-007",
    "LOCAL-0",
    "LOCAL-000",
    "LOCAL-",
    "LOCAL-1x",
    "LOCAL-1.0",
    "LOCAL- 1",
    "LOCAL-+1",
    "LOCAL-99999999999999999999",
  ];

  it("refuses a padded item key in persisted state and preserves the exact bytes", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const store = await readStoreJson(location.storePath);
    const items = store.items as Record<string, { item: { id: string }; history: { snapshot: { id: string } }[] }>;
    // EVERY copy of the identifier inside the record — the item and each history
    // snapshot, plus every comment's `itemId` — is rewritten with the padded
    // spelling, so the identifier-mismatch checks have nothing to report and the
    // PADDED SPELLING is the only defect in the document. A single padded key
    // already collides numerically with the canonical spelling of the same
    // number; keeping both makes the collision literal rather than implied.
    const repad = (record: { item: { id: string }; history: { snapshot: { id: string } }[] }): void => {
      record.item.id = "LOCAL-01";
      for (const entry of record.history) entry.snapshot.id = "LOCAL-01";
    };
    const padded = structuredClone(items[spec.id]!);
    repad(padded);
    items["LOCAL-01"] = padded;
    const alias = structuredClone(padded);
    alias.item.id = "LOCAL-1";
    for (const entry of alias.history) entry.snapshot.id = "LOCAL-1";
    items["LOCAL-1"] = alias;
    const corrupted = `${JSON.stringify(store, null, 2)}\n`;
    await writeFile(location.storePath, corrupted, { mode: 0o600 });

    // A CANONICAL handle still resolves the document, so the refusal below is
    // attributable to the document rather than to the handle.
    for (const call of [
      () => tracker.getSpec("LOCAL-1"),
      () => tracker.createSpec({ title: "Never written", body: "B" }),
      () => tracker.commentSpec("LOCAL-1", "note"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "INVALID_LOCAL_TRACKER_STORE" });
    }
    // The padded handle is refused as the caller's own bad argument, before the
    // store is read at all — it is never answered out of the padded key.
    await expect(tracker.getSpec("LOCAL-01")).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT" });
    expect(await readFile(location.storePath, "utf8")).toBe(corrupted);
  });

  it("refuses a padded item identifier that disagrees with its own canonical key", async () => {
    // The mirror image: the key is canonical and the record disagrees with it.
    // Both directions are the same invariant — one key, one spelling, one item.
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const store = await readStoreJson(location.storePath);
    (store.items as Record<string, { item: { id: string } }>)[spec.id]!.item.id = "LOCAL-01";
    const corrupted = `${JSON.stringify(store, null, 2)}\n`;
    await writeFile(location.storePath, corrupted, { mode: 0o600 });

    await expect(tracker.getSpec(spec.id)).rejects.toMatchObject({ code: "INVALID_LOCAL_TRACKER_STORE" });
    expect(await readFile(location.storePath, "utf8")).toBe(corrupted);
  });

  it("refuses a noncanonical parent or supersession reference in persisted state", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({ title: "T", body: "B", parentSpecId: spec.id, dependencyText: "none" });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    // Each case is built from a FRESH read of the canonical store, so a case can
    // only fail because of the reference it plants and never because of the
    // state a previous case left behind.
    const cases: readonly (readonly [string, (item: Record<string, unknown>) => void])[] = [
      ["parentSpecId", (item) => void (item.parentSpecId = "LOCAL-01")],
      [
        "supersededBy",
        (item) => {
          item.state = "superseded";
          item.supersededReason = "Replanned";
          item.supersededBy = ["LOCAL-01"];
        },
      ],
    ];
    for (const [label, apply] of cases) {
      const store = await readStoreJson(location.storePath);
      apply((store.items as Record<string, { item: Record<string, unknown> }>)[ticket.id]!.item);
      const corrupted = `${JSON.stringify(store, null, 2)}\n`;
      await writeFile(location.storePath, corrupted, { mode: 0o600 });
      await expect(tracker.getTicket(ticket.id), `${label} must be refused`).rejects.toMatchObject({
        code: "INVALID_LOCAL_TRACKER_STORE",
      });
      expect(await readFile(location.storePath, "utf8"), `${label} bytes must survive`).toBe(corrupted);
    }
  });

  it("refuses a noncanonical identifier a caller supplies, on every operation, before any write", async () => {
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    const spec = await tracker.createSpec({ title: "Intent", body: "B" });
    const ticket = await tracker.createTicket({ title: "T", body: "B", parentSpecId: spec.id, dependencyText: "none" });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const before = await readFile(location.storePath, "utf8");

    for (const id of NONCANONICAL_IDS) {
      for (const call of [
        () => tracker.getSpec(id),
        () => tracker.getTicket(id),
        () => tracker.updateSpec(id, { title: "Renamed" }),
        () => tracker.updateTicket(id, { body: "Rewritten" }),
        () => tracker.commentSpec(id, "note"),
        () => tracker.commentTicket(id, "note"),
        () => tracker.closeSpec(id),
        () => tracker.closeTicket(id),
        () => tracker.supersedeSpec(id, { reason: "Replanned" }),
        () => tracker.supersedeTicket(id, { reason: "Replanned" }),
        // A parent reference is PERSISTED, so a padded one would commit a
        // document this adapter can never read back.
        () => tracker.createTicket({ title: "Orphan", body: "B", parentSpecId: id, dependencyText: "none" }),
        // So is a supersession replacement, for the same reason.
        () => tracker.supersedeTicket(ticket.id, { reason: "Replanned", replacementIds: [id] }),
      ]) {
        await expect(call(), `${id} must be refused`).rejects.toMatchObject({ code: "INVALID_ADAPTER_INPUT" });
      }
    }

    expect(await readFile(location.storePath, "utf8")).toBe(before);
    expect((await tracker.getSpec(spec.id)).title).toBe("Intent");
    expect((await tracker.getTicket(ticket.id)).body).toBe("B");
  });

  it("keeps canonical multi-digit identifiers working across the whole contract", async () => {
    // Break: a canonicality rule that refused every multi-digit number, or one
    // that compared digits rather than their value, would break the very
    // sequence the store is built to issue.
    const repository = await newRepository();
    const tracker = createLocalTrackerAdapter(repository.root);
    for (let index = 1; index <= 12; index += 1) {
      await tracker.createSpec({ title: `Intent ${index}`, body: "B" });
    }
    expect((await tracker.getSpec("LOCAL-10")).title).toBe("Intent 10");
    expect((await tracker.getSpec("LOCAL-12")).title).toBe("Intent 12");

    const ticket = await tracker.createTicket({
      title: "Child of a multi-digit parent",
      body: "B",
      parentSpecId: "LOCAL-10",
      dependencyText: "none",
    });
    expect(ticket).toMatchObject({ id: "LOCAL-13", parentSpecId: "LOCAL-10" });
    expect((await tracker.updateTicket(ticket.id, { dependencyText: "LOCAL-10" })).dependencyText).toBe("LOCAL-10");
    expect((await tracker.commentTicket(ticket.id, "note")).id).toBe("LOCAL-13-C1");
    expect(
      (await tracker.supersedeTicket(ticket.id, { reason: "Replanned", replacementIds: ["LOCAL-12"] })).supersededBy,
    ).toEqual(["LOCAL-12"]);

    const reloaded = createLocalTrackerAdapter(repository.root);
    expect((await reloaded.getTicket("LOCAL-13")).state).toBe("superseded");
    expect((await reloaded.createSpec({ title: "After", body: "B" })).id).toBe("LOCAL-14");
  });
});

/**
 * Spec #139 / ticket #159 — the COMPLETE serialized store is BOUNDED.
 *
 * The local document is a complete snapshot: every Spec, Ticket, comment, and
 * history entry the tracker has ever committed lives in that one file, so the
 * file only ever grows and no read of it can be free. A ceiling is the only
 * honest answer to that — but a ceiling is only real if it is enforced on BOTH
 * sides of the write, and enforced by ONE mechanism, because two bounds that
 * can disagree produce exactly the two failures this ticket exists to prevent:
 * a store that was committed over the ceiling and can no longer be read, and a
 * store that is silently trimmed to fit.
 *
 * What is asserted here, and what breaks each assertion:
 *
 *   1. EXACTLY AT THE LIMIT IS ACCEPTED, ONE BYTE OVER IS REFUSED. The bound
 *      is a total byte count INCLUDING the trailing newline, so an off-by-one
 *      in either direction is visible at this boundary and nowhere else. The
 *      refusal also happens BEFORE parsing: an oversized document whose bytes
 *      are not JSON at all still reports the SIZE, which a parse-then-check
 *      implementation cannot do.
 *   2. READS ARE LOCK-FREE, SO A LIVE FOREIGN LOCK CHANGES NOTHING. The size
 *      is a fact about the bytes. If the refusal needed the lock, an
 *      oversize store would be reported as a lock timeout and the two would be
 *      indistinguishable.
 *   3. A GROWING FILE STAYS BOUNDED. The reported count is what Poiesis
 *      actually consumed, so it is `max + 1` no matter how large the file
 *      became; a read sized from `stat` reports a number that moves.
 *   4. A MUTATION THAT CROSSES THE CEILING IS REFUSED BEFORE THE DURABLE
 *      REPLACE. The canonical bytes are byte-for-byte unchanged, no temporary,
 *      lock, or guard artifact is left behind, and a later FITTING mutation
 *      still commits — a refusal that wedged the protocol would be a denial of
 *      service the operator cannot clear.
 *   5. NOTHING IS PRUNED TO FIT. A truncated history is indistinguishable from
 *      a history that was never recorded, so the retained comments and history
 *      entries are asserted individually, not merely left byte-identical.
 *   6. TWO WRITERS THAT BOTH CROSS IT are serialized by the same lock and both
 *      refused the same way, and the protocol is still healthy afterwards.
 *   7. The USABILITY check `verifyTracker` / `doctor` runs on the same bound, so
 *      an oversize store is reported as a failing tracker rather than a healthy
 *      one whose every later operation will be refused.
 */
describe("the complete serialized store is bounded and never pruned to fit", () => {
  const BOUNDARY_AT = "2026-01-01T00:00:00.000Z";
  /** Headroom left below the ceiling, and the history already committed in it. */
  const NEAR_SLACK_BYTES = 4_096;
  const RETAINED_COMMENTS = ["kept", "kept verbatim with  spacing", "unicode: αβγ — ✓"];

  function boundaryItem(id: string): Record<string, unknown> {
    return {
      id,
      kind: "spec",
      title: `Intent ${id}`,
      body: "B",
      state: "open",
      createdAt: BOUNDARY_AT,
      updatedAt: BOUNDARY_AT,
    };
  }

  /**
   * A strictly valid document whose total size on disk, trailing newline
   * included, is exact arithmetic rather than a search: the bulk is a comment
   * body, and a comment body adds exactly one byte per character. The bulk
   * sits on `LOCAL-2` so `LOCAL-1` stays small, which is what lets ONE fixture
   * serve the read boundary, the mutation boundary, and the history boundary.
   */
  function boundaryStoreDocument(fillerLength: number, firstSpecComments: readonly string[] = []): string {
    const store = {
      schema: 1,
      provider: "poiesis-local",
      nextId: 3,
      items: {
        "LOCAL-1": {
          item: boundaryItem("LOCAL-1"),
          comments: firstSpecComments.map((body, index) => ({
            id: `LOCAL-1-C${index + 1}`,
            itemId: "LOCAL-1",
            body,
            createdAt: BOUNDARY_AT,
          })),
          history: [{ operation: "create", at: BOUNDARY_AT, snapshot: boundaryItem("LOCAL-1") }],
        },
        "LOCAL-2": {
          item: boundaryItem("LOCAL-2"),
          comments: [
            { id: "LOCAL-2-C1", itemId: "LOCAL-2", body: "z".repeat(fillerLength), createdAt: BOUNDARY_AT },
          ],
          history: [{ operation: "create", at: BOUNDARY_AT, snapshot: boundaryItem("LOCAL-2") }],
        },
      },
    };
    return `${JSON.stringify(store, null, 2)}\n`;
  }

  function boundaryStoreAt(totalBytes: number, firstSpecComments: readonly string[] = []): string {
    const base = Buffer.byteLength(boundaryStoreDocument(0, firstSpecComments), "utf8");
    return boundaryStoreDocument(totalBytes - base, firstSpecComments);
  }

  /**
   * ONE built document per distinct size, shared by the whole block. Each is a
   * 16 MiB string, and a suite that rebuilt one per test would spend its memory
   * budget on fixtures instead of on evidence. The documents are immutable and
   * a test plants one in the store and then mutates the FILE, so sharing one can
   * never let one test's mutation reach another's fixture.
   */
  const fixtures = new Map<string, string>();
  function fixture(key: string, build: () => string): string {
    const cached = fixtures.get(key);
    if (cached !== undefined) return cached;
    const built = build();
    fixtures.set(key, built);
    return built;
  }
  /** A well-formed document of exactly the ceiling, trailing newline included. */
  const atCeiling = (): string => fixture("at-ceiling", () => boundaryStoreAt(LOCAL_TRACKER_STORE_MAX_BYTES));
  /** The same document one byte larger, so it is one byte OVER. */
  const overCeiling = (): string => fixture("over-ceiling", () => boundaryStoreAt(LOCAL_TRACKER_STORE_MAX_BYTES + 1));
  /** One byte over the ceiling AND not valid JSON, which orders the size check first. */
  const unparseableOverCeiling = (): string =>
    fixture("unparseable-over-ceiling", () => `${atCeiling().slice(0, LOCAL_TRACKER_STORE_MAX_BYTES)}{`);
  /** A well-formed document just below the ceiling, with history already in it. */
  const nearCeiling = (): string =>
    fixture("near-ceiling", () => boundaryStoreAt(LOCAL_TRACKER_STORE_MAX_BYTES - NEAR_SLACK_BYTES, RETAINED_COMMENTS));

  async function writeStoreDocument(location: LocalTrackerStoreLocation, document: string): Promise<void> {
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    await writeFile(location.storePath, document, { mode: 0o600 });
  }

  function caught(reason: unknown): PoiesisError {
    return reason as PoiesisError;
  }

  /**
   * The refusal is INERT: the exact path and two exact numbers, and nothing
   * else. A procedure interpolated into that path would hand a command to
   * whatever the Git common directory Poiesis did not choose contains, and
   * there is nothing procedural to say that the two numbers do not.
   */
  function expectInertSizeRefusal(error: PoiesisError, path: string, sizeBytes: number): void {
    expect(error.code).toBe("LOCAL_TRACKER_STORE_TOO_LARGE");
    expect(Object.keys(error.details).sort()).toEqual(["maxBytes", "path", "sizeBytes"]);
    expect(error.details).toEqual({ path, sizeBytes, maxBytes: LOCAL_TRACKER_STORE_MAX_BYTES });
    for (const value of Object.values(error.details)) {
      expect(typeof value === "string" || typeof value === "number").toBe(true);
    }
  }

  it("accepts a store of exactly the ceiling and refuses one byte over, before it parses", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);

    const exact = atCeiling();
    expect(Buffer.byteLength(exact, "utf8")).toBe(LOCAL_TRACKER_STORE_MAX_BYTES);
    await writeStoreDocument(location, exact);
    // EXACTLY at the ceiling is inside it: the whole document, trailing newline
    // included, is served through the ordinary lock-free read path.
    expect((await tracker.getSpec("LOCAL-1")).id).toBe("LOCAL-1");
    expect((await tracker.getSpec("LOCAL-2")).id).toBe("LOCAL-2");

    const over = overCeiling();
    expect(Buffer.byteLength(over, "utf8")).toBe(LOCAL_TRACKER_STORE_MAX_BYTES + 1);
    await writeStoreDocument(location, over);
    expectInertSizeRefusal(
      caught(await tracker.getSpec("LOCAL-1").then(() => undefined, (reason: unknown) => reason)),
      location.storePath,
      LOCAL_TRACKER_STORE_MAX_BYTES + 1,
    );

    // BEFORE PARSING, and not as a parse failure: the same oversized byte count
    // carrying bytes that are not JSON at all still reports the SIZE. A
    // parse-then-check implementation reports INVALID_LOCAL_TRACKER_STORE here.
    const unparseable = unparseableOverCeiling();
    await writeStoreDocument(location, unparseable);
    expectInertSizeRefusal(
      caught(await tracker.getSpec("LOCAL-1").then(() => undefined, (reason: unknown) => reason)),
      location.storePath,
      LOCAL_TRACKER_STORE_MAX_BYTES + 1,
    );
    // The refused store is left byte-for-byte alone, exactly like a corrupt one.
    const refused = await readFile(location.storePath);
    expect(refused.byteLength).toBe(LOCAL_TRACKER_STORE_MAX_BYTES + 1);
    expect(refused.subarray(refused.byteLength - 1).toString("utf8")).toBe("{");
  }, 120_000);

  it("refuses an oversize read while a live foreign lock is held, because reads are lock-free", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);

    await writeStoreDocument(location, atCeiling());
    const foreign = lockEnvelope("foreign-token", process.pid);
    await writeFile(location.lockPath, foreign, { mode: 0o600 });
    // A live foreign lock blocks WRITERS. It has never blocked a reader, and a
    // size fact about the bytes cannot depend on winning the lock either.
    expect((await tracker.getSpec("LOCAL-1")).id).toBe("LOCAL-1");

    await writeStoreDocument(location, overCeiling());
    const error = caught(await tracker.getSpec("LOCAL-1").then(() => undefined, (reason: unknown) => reason));
    // The size refusal, NOT `LOCAL_TRACKER_LOCK_TIMEOUT`: collapsing the two
    // would report a permanent property of the store as a transient condition
    // of a lock, and the recovery for each is different.
    expectInertSizeRefusal(error, location.storePath, LOCAL_TRACKER_STORE_MAX_BYTES + 1);
    // The foreign lock was neither stolen nor rewritten.
    expect(await readFile(location.lockPath, "utf8")).toBe(foreign);
  }, 120_000);

  it("consumes at most one byte over the ceiling while the file keeps growing", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);
    await writeStoreDocument(location, overCeiling());

    const growth = "y".repeat(4 * 1024 * 1024);
    for (let round = 0; round < 2; round += 1) {
      // The file is already over the ceiling, so the refusal is deterministic,
      // and a concurrent appender keeps making it larger across the read: the
      // size the reader observes and the size the file ends at must not be the
      // same number.
      const appending = appendFile(location.storePath, growth, { mode: 0o600 });
      const error = caught(await tracker.getSpec("LOCAL-1").then(() => undefined, (reason: unknown) => reason));
      await appending;
      // The reported count is what Poiesis ACTUALLY consumed. A read sized from
      // `stat` reports a number that moves as the file grows, and a read that
      // counted the rest of the file would read megabytes more to produce it.
      expectInertSizeRefusal(error, location.storePath, LOCAL_TRACKER_STORE_MAX_BYTES + 1);
    }
    // The file really did grow well past what either refusal reported.
    expect((await lstat(location.storePath)).size).toBeGreaterThan(LOCAL_TRACKER_STORE_MAX_BYTES + 1);
  }, 120_000);

  it("refuses a mutation that would cross the ceiling before the durable replace, and still accepts a fitting one", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);

    // `NEAR_SLACK_BYTES` of headroom: a small comment fits inside it, a comment
    // whose body alone is that large does not. A store already AT the ceiling
    // could not prove that a FITTING mutation still succeeds, because every
    // mutation appends at least a history entry.
    await writeStoreDocument(location, nearCeiling());
    const before = await readFile(location.storePath);

    const error = caught(
      await tracker
        .commentSpec("LOCAL-1", "z".repeat(NEAR_SLACK_BYTES))
        .then(() => undefined, (reason: unknown) => reason),
    );
    // The CANDIDATE was over the ceiling while the canonical bytes are not, so
    // the reported size is the candidate's, not the store's.
    expect(error.code).toBe("LOCAL_TRACKER_STORE_TOO_LARGE");
    expect(Object.keys(error.details).sort()).toEqual(["maxBytes", "path", "sizeBytes"]);
    expect(error.details.path).toBe(location.storePath);
    expect(error.details.maxBytes).toBe(LOCAL_TRACKER_STORE_MAX_BYTES);
    expect(error.details.sizeBytes).toBeGreaterThan(LOCAL_TRACKER_STORE_MAX_BYTES);
    expect(error.details.sizeBytes).toBeLessThan(LOCAL_TRACKER_STORE_MAX_BYTES + 8 * 1024);

    // Nothing was replaced: the canonical bytes are byte-for-byte the old ones,
    // so no partial write, no lost mode, and no skipped fsync is even possible.
    expect((await readFile(location.storePath)).equals(before)).toBe(true);
    // No temporary, no lock, and no guard survived the refusal.
    expect((await readdir(location.directory)).sort()).toEqual(["store.json"]);

    // The store is not wedged: a mutation that FITS still commits.
    expect((await tracker.commentSpec("LOCAL-1", "fits")).body).toBe("fits");
    expect((await readdir(location.directory)).sort()).toEqual(["store.json"]);
  }, 120_000);

  it("never prunes a comment or a history entry to make a near-limit mutation fit", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const tracker = createLocalTrackerAdapter(repository.root);

    await writeStoreDocument(location, nearCeiling());
    const before = await readFile(location.storePath);

    const error = caught(
      await tracker.commentSpec("LOCAL-1", "z".repeat(6_000)).then(() => undefined, (reason: unknown) => reason),
    );
    expect(error.code).toBe("LOCAL_TRACKER_STORE_TOO_LARGE");
    expect((await readFile(location.storePath)).equals(before)).toBe(true);

    // A pruned history is indistinguishable from a history that was never
    // recorded, so each retained entry is checked by VALUE, byte-for-byte.
    const recordOf = (document: Buffer): { comments: { body: string }[]; history: { operation: string }[] } =>
      (JSON.parse(document.toString("utf8")) as {
        items: Record<string, { comments: { body: string }[]; history: { operation: string }[] }>;
      }).items["LOCAL-1"]!;
    const record = recordOf(before);
    expect(record.comments.map((comment) => comment.body)).toEqual(RETAINED_COMMENTS);
    expect(record.history.map((entry) => entry.operation)).toEqual(["create"]);

    // The near-limit store is still fully usable, and the entries that were
    // retained are still first in the sequence that follows them.
    expect((await tracker.getSpec("LOCAL-1")).id).toBe("LOCAL-1");
    expect((await tracker.commentSpec("LOCAL-1", "still fits")).body).toBe("still fits");
    const grown = recordOf(await readFile(location.storePath));
    expect(grown.comments.map((comment) => comment.body)).toEqual([...RETAINED_COMMENTS, "still fits"]);
    expect(grown.history.map((entry) => entry.operation)).toEqual(["create", "comment"]);
  }, 120_000);

  it("serializes two crossing writers on the same lock, refuses both, and leaves the protocol healthy", async () => {
    const repository = await newRepository();
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    // Two adapter instances, so two independent in-process queues: the only
    // thing serializing them is the cross-process store lock, which is exactly
    // the contention a real second process creates.
    const first = createLocalTrackerAdapter(repository.root);
    const second = createLocalTrackerAdapter(repository.root);

    await writeStoreDocument(location, nearCeiling());
    const before = await readFile(location.storePath);

    const settled = await Promise.allSettled([
      first.commentSpec("LOCAL-1", "z".repeat(NEAR_SLACK_BYTES)),
      second.commentSpec("LOCAL-1", "y".repeat(NEAR_SLACK_BYTES)),
    ]);
    expect(settled.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
    for (const entry of settled) {
      expect(caught((entry as PromiseRejectedResult).reason).code).toBe("LOCAL_TRACKER_STORE_TOO_LARGE");
    }
    // Neither refusal raced the other into a write, and neither leaked an
    // artifact on its way out of the critical section.
    expect((await readFile(location.storePath)).equals(before)).toBe(true);
    expect((await readdir(location.directory)).sort()).toEqual(["store.json"]);

    // The lock protocol is untouched by the refusal: the next writer commits.
    expect((await second.commentSpec("LOCAL-1", "fits")).body).toBe("fits");
  }, 120_000);

  it("fails the tracker usability check closed on an oversize store", async () => {
    const repository = await newRepository();
    const { config } = await autoResolveConfigDefaults(repository.root, {
      ...baseConfig(),
      tracker: { provider: "local" },
    });
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    await writeStoreDocument(location, atCeiling());
    expect(await verifyTracker(repository.root, config)).toBe("verified");

    await writeStoreDocument(location, overCeiling());
    const error = caught(await verifyTracker(repository.root, config).then(() => undefined, (reason: unknown) => reason));
    // `doctor` runs this same check, so an oversize store is reported as a
    // FAILING tracker rather than a healthy one whose every later mutation
    // will be refused.
    expectInertSizeRefusal(error, location.storePath, LOCAL_TRACKER_STORE_MAX_BYTES + 1);
    // The check still creates and mutates nothing.
    expect((await readdir(location.directory)).sort()).toEqual(["store.json"]);
  }, 120_000);
});

interface FakeUvEnvironment {
  restore: () => void;
}

async function installFakeUv(): Promise<FakeUvEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-local-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

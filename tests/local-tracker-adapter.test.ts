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
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTrackerAdapter } from "../src/adapters.js";
import {
  LOCAL_TRACKER_LOCK_VERSION,
  LOCAL_TRACKER_STORE_DIRECTORY,
  acquireLocalTrackerLockWithTimeout,
  createLocalTrackerAdapter,
  releaseLocalTrackerLock,
  resolveLocalTrackerStoreLocation,
} from "../src/local-tracker.js";
import { autoResolveConfigDefaults, init, uninstall, verifyTracker } from "../src/maintenance.js";
import { run } from "../src/process.js";
import { POIESIS_DURABLE_PATHS } from "../src/templates.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

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

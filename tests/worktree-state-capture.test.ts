/**
 * Spec #168 / ticket #179 — the status BYTE-CAPTURE truncation contract.
 *
 * The runner bounds every capture it takes, so a worktree whose porcelain
 * status exceeds that bound is observed only partially, and the bound can cut
 * a record in half. Three separate facts must never be collapsed into one:
 *
 *   - the CAPTURE was cut short (`statusCaptureTruncated`);
 *   - the changed-path LIST was then bounded for evidence
 *     (`changedFilesTruncated`);
 *   - the per-path digest LIST was bounded by its own count
 *     (`pathDigestsTruncated`).
 *
 * Only the first one means "there is workspace state nobody read". Reporting a
 * capture cut as a complete read is how a focused check ends up fingerprinting
 * an incomplete workspace as though it were fully observed — and parsing the
 * half-record the bound produced is how a path that does not exist on disk ends
 * up with a content digest.
 *
 * The fixtures below build real repositories whose status stream crosses the
 * capture bound deterministically: each record is `?? <2000-byte path>\0`, so
 * 130 untracked files occupy 260,519 bytes and the 131st record straddles the
 * 262,144-byte boundary 1,624 bytes in. Nothing here mocks the runner or Git;
 * the truncation is produced by the same `run()` the product uses.
 */
import { Buffer } from "node:buffer";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readWorktreeState } from "../src/git.js";
import { run } from "../src/process.js";
import { createTestRepository, type TestRepository } from "./helpers.js";

/** The runner's default per-stream capture bound, in bytes. */
const CAPTURE_BOUND_BYTES = 256 * 1024;
/** Bytes of one untracked record: two status columns, a space, the path, a NUL. */
const RECORD_OVERHEAD_BYTES = 4;
/** The record width the fixtures are built to; every component stays <= 250 bytes. */
const PATH_BYTES = 2000;
/** Count whose complete records fit under the bound but leave room for one more. */
const COMPLETE_FILE_COUNT = 130;

/** Measure the real status stream, unbound, so a fixture can prove it crosses the bound. */
async function measureStatusBytes(cwd: string): Promise<number> {
  const result = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    maxBytes: 8 * 1024 * 1024,
  });
  return Buffer.byteLength(result.stdout);
}

/**
 * A repository-relative path of EXACTLY `length` bytes whose every component
 * stays within the 250-byte filesystem limit, so a 2,000-byte path is a real
 * creatable file rather than a synthetic record.
 */
function longPath(prefix: string, index: number, length: number): string {
  const parts: string[] = [`${prefix}${index}`];
  let used = parts[0]!.length;
  while (used < length) {
    const size = Math.min(250, length - used - 1);
    parts.push("z".repeat(size));
    used += size + 1;
  }
  return parts.join("/");
}

async function seedUntracked(root: string, prefix: string, from: number, to: number): Promise<void> {
  for (let index = from; index < to; index += 1) {
    const name = longPath(prefix, index, PATH_BYTES);
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), "");
  }
}

/** Every reported path must be a real worktree entry; a cut record never is. */
async function allPathsExistOnDisk(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await expect(stat(join(root, path)), `reported changed path is not on disk: ${path.slice(0, 24)}...`).resolves.toBeDefined();
  }
}

describe("worktree state status capture completeness (Spec #168 / ticket #179)", () => {
  const repositories: TestRepository[] = [];

  afterAll(async () => {
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  async function repositoryWithUntracked(): Promise<TestRepository> {
    const repository = await createTestRepository();
    repositories.push(repository);
    await seedUntracked(repository.root, "f", 0, COMPLETE_FILE_COUNT);
    return repository;
  }

  it("reports a capture the bound cut short instead of a complete read", async () => {
    const repository = await repositoryWithUntracked();
    const complete = await readWorktreeState(repository.root);
    expect(complete.statusCaptureTruncated).toBe(false);
    expect(complete.changedFiles).toHaveLength(COMPLETE_FILE_COUNT);
    expect(complete.changedFilesTruncated).toBe(false);
    await allPathsExistOnDisk(repository.root, complete.changedFiles);

    // One more file pushes a record across the capture bound, so the reader
    // observes 130 whole records plus 1,624 bytes of the 131st.
    await seedUntracked(repository.root, "f", COMPLETE_FILE_COUNT, COMPLETE_FILE_COUNT + 1);
    // The fixture really is larger than the bound; it is not a mocked runner.
    expect(await measureStatusBytes(repository.root)).toBeGreaterThan(CAPTURE_BOUND_BYTES);
    expect(COMPLETE_FILE_COUNT * (PATH_BYTES + RECORD_OVERHEAD_BYTES)).toBeLessThan(CAPTURE_BOUND_BYTES);
    const cut = await readWorktreeState(repository.root);
    expect(cut.statusCaptureTruncated).toBe(true);
    expect(cut.dirty).toBe(true);
    // The path-count bound is a DIFFERENT fact and is not reached here.
    expect(cut.changedFilesTruncated).toBe(false);
    // The half-record the bound produced names a path that does not exist.
    expect(cut.changedFiles).toHaveLength(COMPLETE_FILE_COUNT);
    await allPathsExistOnDisk(repository.root, cut.changedFiles);
    for (const digest of cut.pathDigests) expect(digest.blob).not.toBe("absent");

    // Removing it makes the very same read complete again.
    await rm(join(repository.root, longPath("f", COMPLETE_FILE_COUNT, PATH_BYTES)), { force: true });
    const restored = await readWorktreeState(repository.root);
    expect(restored.statusCaptureTruncated).toBe(false);
    expect(restored.changedFiles).toEqual(complete.changedFiles);
  });

  it("keeps capture truncation independent of the path-count and digest-count bounds", async () => {
    const repository = await repositoryWithUntracked();
    const bounded = await readWorktreeState(repository.root, 2);
    // A complete capture whose evidence was then bounded: neither path-count
    // truncation nor an incomplete read.
    expect(bounded.statusCaptureTruncated).toBe(false);
    expect(bounded.changedFilesTruncated).toBe(true);
    expect(bounded.changedFiles).toHaveLength(2);
    // More paths than the digest bound allows, reported as its own fact.
    expect(bounded.pathDigestsTruncated).toBe(true);
    expect(bounded.pathDigests).toHaveLength(16);

    await seedUntracked(repository.root, "f", COMPLETE_FILE_COUNT, COMPLETE_FILE_COUNT + 1);
    const cut = await readWorktreeState(repository.root, 2);
    expect(cut.statusCaptureTruncated).toBe(true);
    expect(cut.pathDigestsTruncated).toBe(true);
    expect(cut.changedFilesTruncated).toBe(true);
  });

  it("reads the same incomplete state deterministically", async () => {
    const repository = await repositoryWithUntracked();
    await seedUntracked(repository.root, "f", COMPLETE_FILE_COUNT, COMPLETE_FILE_COUNT + 1);

    const first = await readWorktreeState(repository.root);
    const second = await readWorktreeState(repository.root);
    expect(second).toEqual(first);
    expect(second.statusCaptureTruncated).toBe(true);
  });

  it("marks a capture cut inside a rename record incomplete instead of inventing the record", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const root = repository.root;
    // Staged, so every record is an INDEX record and the stream stays ordered
    // by path: 130 modifications, then a rename whose destination sorts last.
    // The bound then lands inside that rename's SOURCE field — the one record
    // shape that is two NUL-terminated fields wide.
    const modified = Array.from({ length: COMPLETE_FILE_COUNT }, (_, index) => longPath("f", index, PATH_BYTES));
    const origin = longPath("o", 0, 200);
    const destination = longPath("z", 0, 1520);
    await mkdir(dirname(join(root, origin)), { recursive: true });
    await writeFile(join(root, origin), "rename me\n");
    for (const name of modified) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), `${name}\n`);
    }
    await run("git", ["add", "--all"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "seed long paths"], { cwd: root });
    for (const name of modified) await appendFile(join(root, name), "changed\n");
    await run("git", ["add", "--all"], { cwd: root });
    await mkdir(dirname(join(root, destination)), { recursive: true });
    await run("git", ["mv", origin, destination], { cwd: root });

    const cut = await readWorktreeState(root);
    expect(cut.statusCaptureTruncated).toBe(true);
    expect(cut.dirty).toBe(true);
    // The rename record is half-read: its destination field was captured and
    // its source was not. Reporting it as a change would publish the first 100
    // bytes of a 200-byte source path as though it were the whole path.
    expect(cut.changedFiles).toHaveLength(COMPLETE_FILE_COUNT);
    expect(cut.changedFiles.some((path) => path.startsWith("z0/"))).toBe(false);
    await allPathsExistOnDisk(root, cut.changedFiles);
  });
});
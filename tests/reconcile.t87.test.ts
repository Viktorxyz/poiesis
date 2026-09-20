/**
 * Tests for remediation ticket #87.
 *
 * Each `describe` block corresponds to one of the final-review
 * findings for ticket #87. Tests use real disposable Git
 * repositories so the seam is exercised exactly as it would be
 * in production: never mocks, never string substitutions of Git
 * output. Ticket #87 generalizes the ticket #86 finding #1
 * symlink-ancestor detection to cover ANY target leaf/type
 * transition (regular file, executable file, or symlink), so the
 * stale-descendant skip set is computed for every leaf shape the
 * target may install where the preimage had a directory of the
 * same name.
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, TEXT_DECODER_FATAL } from "../src/process.js";
import {
  computeReconcileFingerprint,
  reconcile,
  RECONCILE_FINGERPRINT_SCHEMA,
} from "../src/reconcile.js";

interface TestRepo {
  parent: string;
  root: string;
  remote: string;
}

async function createTestRepo(): Promise<TestRepo> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-t87-"));
  const root = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis T87"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis-t87@example.test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  await run("git", ["init", "--quiet", "--bare", remote], { cwd: parent });
  await run("git", ["remote", "add", "origin", remote], { cwd: root });
  await run("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: root });
  return { parent, root, remote };
}

async function gitignoreRuntime(root: string): Promise<void> {
  await writeFile(join(root, ".gitignore"), ".poiesis/manifest.json\n.poiesis/workspaces/\n");
  await run("git", ["add", ".gitignore"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "ignore"], { cwd: root });
  await run("git", ["push", "--quiet", "origin", "main"], { cwd: root });
}

async function captureBaseline(repo: TestRepo): Promise<{
  head: string;
  target: string;
  fingerprint: string;
}> {
  await run("git", ["fetch", "--quiet", "origin"], { cwd: repo.root });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout;
  const target = (await run("git", ["rev-parse", "origin/main"], { cwd: repo.root })).stdout;
  const fingerprint = (
    await computeReconcileFingerprint({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
    })
  ).digest;
  return { head, target, fingerprint };
}

const REPOS: TestRepo[] = [];

afterEach(async () => {
  while (REPOS.length > 0) {
    const repo = REPOS.pop()!;
    await rm(repo.parent, { recursive: true, force: true });
  }
});

// =============================================================================
// Finding: generalize ticket #86 finding #1 to cover EVERY target
// leaf/type transition (regular file, executable file, symlink).
//   - directory → regular file: preimage descendants fail with
//     ENOTDIR on `lstat` because POSIX does not allow children under
//     a non-directory parent; the destructive step would throw
//     post-reset, leaving the repository in a partially-reset state.
//   - directory → executable file: same as regular file.
//   - directory → symlink: covered by ticket #86 finding #1 (kept for
//     regression coverage of the generalized skip set).
// The skip set must include all such ancestors regardless of the
// resulting leaf shape, the target leaf must be preserved, and no
// external or protected-sentinel state must be deleted.
// =============================================================================

describe("ticket #87 — generalized type-transition ancestor skip", () => {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      await rm(repo.parent, { recursive: true, force: true });
    }
  });

  it("does not abort with ENOTDIR when a preimage directory is replaced by a target regular file", async () => {
    // The target tree installs a regular file `link` at a path where
    // the preimage had a directory. After `git reset --hard`, `link`
    // becomes a regular file on disk and `link/old.txt` (the
    // preimage residue) is no longer reachable: any attempt to
    // `lstat("link/old.txt")` throws ENOTDIR because POSIX does not
    // allow children under a non-directory parent. The destructive
    // cleanup MUST skip the stale descendant instead of throwing
    // post-mutation, and the target leaf must survive. Ticket #87
    // generalization of ticket #86 finding #1.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Pre-target: `link` is a tracked regular directory with one
    // tracked child `link/old.txt`.
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "old.txt"), "primary-residue\n");
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link dir"], { cwd: repo.root });
    // Target: replace `link` (the directory tree) with a regular file
    // holding different content. Tracking only the regular file
    // drops the directory shape from the target tree on reset.
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await writeFile(join(repo.root, "link"), "new-leaf-content\n");
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link as regular file"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Reset local HEAD to the pre-target commit. Manually restore
    // the directory shape on disk so the discard-scope walker sees
    // `link/old.txt` as a real preimage entry (the mixed reset alone
    // would leave the regular file shape on disk).
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "old.txt"), "primary-residue\n");
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

    const baseline = await captureBaseline(repo);
    // Pre-fix: this call throws `ENOTDIR` post-mutation because the
    // destructive cleanup attempted to lstat `link/old.txt` after
    // `git reset --hard` replaced `link/` with the regular file.
    const result = await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    expect(result.head).toBe(baseline.target);
    expect(result.indexMatchesTarget).toBe(true);
    expect(result.workingTreeMatchesTarget).toBe(true);
    // The target leaf (a regular file) is in place at the target
    // path. The descendant `link/old.txt` was correctly skipped, so
    // `lstat` on the same path now surfaces the leaf, not the
    // missing descendant.
    const linkStat = await lstat(join(repo.root, "link"));
    expect(linkStat.isFile()).toBe(true);
    expect(linkStat.isSymbolicLink()).toBe(false);
  });

  it("does not abort with ENOTDIR when a preimage directory is replaced by an executable target leaf", async () => {
    // Same generalized contract as the regular-file case, exercised
    // against an executable mode (100755) target leaf. The discard
    // scope walker records mode bits, so the descendants that get
    // dropped from the target tree are still detected as residue.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "old.txt"), "primary-residue\n");
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link dir"], { cwd: repo.root });
    // Target: executable regular file at `link`.
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await writeFile(join(repo.root, "link"), "#!/bin/sh\necho replaced\n");
    await chmod(join(repo.root, "link"), 0o755);
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link as executable"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "old.txt"), "primary-residue\n");
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

    const baseline = await captureBaseline(repo);
    const result = await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    expect(result.head).toBe(baseline.target);
    expect(result.workingTreeMatchesTarget).toBe(true);
    // Executable target leaf preserves both the file shape and the
    // 0o755 mode bits — both detectable via `lstat` post-reset.
    const linkStat = await lstat(join(repo.root, "link"));
    expect(linkStat.isFile()).toBe(true);
    expect(linkStat.isSymbolicLink()).toBe(false);
    expect((linkStat.mode & 0o777) === 0o755).toBe(true);
  });

  it("does not delete external bytes when a preimage directory is replaced by a target symlink (ticket #86 finding #1 regression)", async () => {
    // Regression coverage: the generalized ancestor-skip set MUST
    // continue to include directory → symlink transitions. The
    // symlink shape was the only one ticket #86 handled; this
    // case pins that the renaming + generalization did not drop
    // the symlink handling in the process.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    const externalDir = join(repo.parent, "external-target");
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, "external-child.txt"), "external\n");
    await writeFile(join(externalDir, "residue.txt"), "external-residue\n");
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "residue.txt"), "primary-residue\n");
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link dir"], { cwd: repo.root });
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await symlink(externalDir, join(repo.root, "link"));
    await run("git", ["add", "link"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "link as symlink"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    await rm(join(repo.root, "link"), { recursive: true, force: true });
    await mkdir(join(repo.root, "link"), { recursive: true });
    await writeFile(join(repo.root, "link", "residue.txt"), "primary-residue\n");
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

    const baseline = await captureBaseline(repo);
    const result = await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    expect(result.head).toBe(baseline.target);
    expect(result.workingTreeMatchesTarget).toBe(true);
    expect(await readFile(join(externalDir, "external-child.txt"), "utf8")).toBe("external\n");
    expect(await readFile(join(externalDir, "residue.txt"), "utf8")).toBe("external-residue\n");
    const linkStat = await lstat(join(repo.root, "link"));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it("preserves the target leaf and skips an intermediate preimage descendant whose ancestor is a transitioned directory in the target", async () => {
    // Intermediate-residue case: preimage has `parent/link/inner.txt`
    // where `parent/link` is a directory. The target tree replaces
    // `parent/link` with a regular file (`link` at `parent/link`).
    // The preimage descendant `parent/link/inner.txt` is not directly
    // under the transitioned ancestor; it is two segments below.
    // The cleanup must skip the entire branch rooted at `parent/link`
    // because `parent/link` on disk is no longer a directory.
    const repo = await createTestRepo();
    repos.push(repo);
    await gitignoreRuntime(repo.root);
    // Pre-target: nested tracked tree where `parent/link/inner.txt`
    // is the residue child.
    await mkdir(join(repo.root, "parent", "link"), { recursive: true });
    await writeFile(join(repo.root, "parent", "link", "inner.txt"), "stale\n");
    await run("git", ["add", "parent"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "parent/link dir"], { cwd: repo.root });
    // Target: replace `parent/link` with a regular file.
    await rm(join(repo.root, "parent", "link"), { recursive: true, force: true });
    await writeFile(join(repo.root, "parent", "link"), "target-leaf\n");
    await run("git", ["add", "parent"], { cwd: repo.root });
    await run("git", ["commit", "--quiet", "-m", "parent/link as leaf"], { cwd: repo.root });
    await run("git", ["push", "--quiet", "origin", "main"], { cwd: repo.root });
    // Restore the directory shape locally so the discard-scope
    // walker sees `parent/link/inner.txt` as a real preimage entry.
    await rm(join(repo.root, "parent", "link"), { recursive: true, force: true });
    await mkdir(join(repo.root, "parent", "link"), { recursive: true });
    await writeFile(join(repo.root, "parent", "link", "inner.txt"), "stale\n");
    await run("git", ["reset", "--mixed", "HEAD~1", "--"], { cwd: repo.root });

    const baseline = await captureBaseline(repo);
    const result = await reconcile({
      cwd: repo.root,
      remote: "origin",
      integrationBranch: "main",
      expectedHeadSha: baseline.head,
      expectedTargetSha: baseline.target,
      expectedFingerprint: baseline.fingerprint,
      discardAcknowledged: true,
    });
    expect(result.head).toBe(baseline.target);
    expect(result.workingTreeMatchesTarget).toBe(true);
    const linkStat = await lstat(join(repo.root, "parent", "link"));
    expect(linkStat.isFile()).toBe(true);
    expect(linkStat.isSymbolicLink()).toBe(false);
  });
});

// Suppress unused warnings for shared helpers that are kept for symmetry
// with the other test suites.
void chmod;
void TEXT_DECODER_FATAL;
void RECONCILE_FINGERPRINT_SCHEMA;
void sep;

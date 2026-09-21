import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpoint, integrate, publish, resolveTree, workspaceCleanup, workspacePrepare } from "../src/git.js";
import { init } from "../src/maintenance.js";
import { run } from "../src/process.js";
import { createFixtureDeliveryAdapter } from "../src/adapters.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/**
 * Spec #104 / ticket #110: guarded Git lifecycle mutations cross the
 * runtime identity boundary; the shared guard fails closed on an
 * absent manifest. The workspace-default-path tests exercise
 * `workspacePrepare` + `checkpoint` + `publish` + `integrate` +
 * `workspaceCleanup`, all of which are guarded; they must install
 * Poiesis first so the guard's manifest-match branch succeeds. The
 * init uses `skipSkills: true` and `allowFixtureAdapters: true` to
 * keep the lifecycle tests fast.
 */
async function installedTestRepository(repositories: TestRepository[]): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
  return repository;
}

/**
 * Default-path workspace lifecycle.
 *
 * `poiesis workspace prepare` accepts an omitted `--path` and selects a
 * deterministic, traversal-safe path under `<root>/.poiesis/workspaces/<id>`
 * instead of an arbitrary external location like `/tmp/...`. This keeps the
 * workspace inside the harness-readable project root and prevents
 * external-directory permission denials while keeping every owned-workspace
 * invariant (marker, candidate base, checkpoint, publish, cleanup, rollback)
 * unchanged.
 */

describe("workspace prepare default path", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  beforeEach(async () => {
    env = await installFakeOpenCode();
  });
  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("derives the workspace path inside <root>/.poiesis/workspaces when --path is omitted", async () => {
    const repository = await installedTestRepository(repositories);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-1",
      specId: "spec-default-1",
    });
    const relPath = relative(repository.root, workspace.path);
    expect(relPath.startsWith(`.poiesis${sep}workspaces${sep}`)).toBe(true);
    expect(relPath).not.toContain(`..${sep}`);
    expect(relPath !== "..").toBe(true);
    expect(workspace.path.startsWith(repository.root)).toBe(true);
  }, 30_000);

  it("creates the missing .poiesis/workspaces parent before git worktree add", async () => {
    // Spec #104 / ticket #110: the runtime identity guard now fails
    // closed on an absent manifest. workspacePrepare creates the
    // missing parent ONLY when the project is installed, so the test
    // installs Poiesis first and then asserts the workspace area is
    // the one workspacePrepare created (not a pre-existing one).
    const repository = await installedTestRepository(repositories);
    expect(await directoryExists(join(repository.root, ".poiesis"))).toBe(true);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-2",
      specId: "spec-default-2",
    });
    expect(await directoryExists(workspace.path)).toBe(true);
    expect(await directoryExists(join(repository.root, ".poiesis", "workspaces"))).toBe(true);
  }, 30_000);

  it("is deterministic for the same specId and branch", async () => {
    const repository = await installedTestRepository(repositories);
    const first = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-3",
      specId: "spec-default-3",
    });
    await workspaceCleanup({ cwd: first.path, deliveredSha: repository.baseSha });
    const second = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-3",
      specId: "spec-default-3",
    });
    expect(second.path).toBe(first.path);
  }, 30_000);

  it("rejects traversal-shaped specIds as workspace id input", async () => {
    const repository = await installedTestRepository(repositories);
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch: "poiesis/traversal",
        specId: "../escape",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_ID_TRAVERSAL_FORBIDDEN" });
  }, 30_000);

  it("fails closed when two specs collide on the same Spec identity", async () => {
    const repository = await installedTestRepository(repositories);
    const first = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-5a",
      specId: "collision-A",
    });
    expect(first.specId).toBe("collision-A");
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch: "poiesis/default-path-5b",
        specId: "collision-A",
      }),
    ).rejects.toMatchObject({ code: "SPEC_WORKSPACE_COLLISION" });
  }, 30_000);

  it("fails closed on a pre-existing default-path directory owned by something else", async () => {
    const repository = await installedTestRepository(repositories);
    const first = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-6",
      specId: "spec-default-6",
    });
    await workspaceCleanup({ cwd: first.path, deliveredSha: repository.baseSha });
    await mkdir(first.path, { recursive: false });
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch: "poiesis/default-path-6",
        specId: "spec-default-6",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_COLLISION" });
  }, 30_000);

  it("keeps the primary checkout clean after a default-path prepare", async () => {
    const repository = await installedTestRepository(repositories);
    // Spec #104 / ticket #110: a real `poiesis init` already wrote the
    // gitignore (`.poiesis/manifest.json`, `.poiesis/workspaces/`) via
    // the transactional gitignore seam. The init commit is implicit
    // through `installedTestRepository`; no manual mirror required.
    await writeFile(join(repository.root, "foreign.txt"), "uncommitted user work\n");
    // The post-install state includes the canonical `.poiesis/`,
    // `.opencode/`, and `opencode.jsonc` artifacts as foreign work
    // unless they are committed. The test only cares that the nested
    // default-path workspace area does NOT appear as foreign work.
    const beforeStatus = (await run("git", ["status", "--porcelain"], { cwd: repository.root })).stdout;
    const foreignLines = beforeStatus
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        line.startsWith("?? ") &&
        !line.includes(".poiesis/") &&
        !line.includes(".opencode/") &&
        line !== "?? opencode.jsonc" &&
        line !== "?? .gitignore",
      );
    expect(foreignLines.join("\n")).toBe("?? foreign.txt");
    await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-clean",
      specId: "spec-default-clean",
    });
    const afterStatus = (await run("git", ["status", "--porcelain"], { cwd: repository.root })).stdout;
    const afterForeignLines = afterStatus
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        line.startsWith("?? ") &&
        !line.includes(".poiesis/") &&
        !line.includes(".opencode/") &&
        line !== "?? opencode.jsonc" &&
        line !== "?? .gitignore",
      );
    expect(afterForeignLines.join("\n")).toBe("?? foreign.txt");
  }, 30_000);

  it("creates the ownership marker under the shared git common dir", async () => {
    const repository = await installedTestRepository(repositories);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-marker",
      specId: "spec-default-marker",
    });
    const commonDir = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: repository.root })).stdout;
    const resolvedCommon = commonDir.startsWith("/") ? commonDir : join(repository.root, commonDir);
    expect(workspace.markerPath.startsWith(resolvedCommon)).toBe(true);
    expect(workspace.markerPath).toContain("poiesis-workspaces-v1");
    const markerJson = JSON.parse(await readFile(workspace.markerPath, "utf8")) as { workspacePath: string };
    expect(markerJson.workspacePath).toBe(workspace.path);
  }, 30_000);

  it("runs a full checkpoint, publish, integrate, and cleanup cycle on the default path", async () => {
    const repository = await installedTestRepository(repositories);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-lifecycle",
      specId: "spec-default-lifecycle",
    });
    await writeFile(join(workspace.path, "feature.txt"), "default-path feature\n");
    const accepted = await checkpoint({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      paths: ["feature.txt"],
      message: "ticket",
      review: { verdict: "PASS", reviewerIdentity: "review", evidence: "pass" },
    });
    const tree = await resolveTree(repository.root, accepted.sha);
    await publish({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      candidateSha: accepted.sha,
      candidateTree: tree,
      provider: "fixture",
      project: repository.fixtures,
      title: "Default path",
      body: "body",
      proof: proofShell(accepted.sha, tree),
    });
    const delivery = createFixtureDeliveryAdapter({ adapter: "fixture", path: repository.fixtures }, repository.root);
    const preview = await delivery.preview({ sha: accepted.sha, candidateTree: tree, proof: proofShell(accepted.sha, tree), publish: publishEvidence(accepted.sha, tree, "poiesis/default-path-lifecycle"), remote: "origin" });
    const staging = await delivery.promote({
      sha: accepted.sha,
      target: "staging",
      candidateTree: tree,
      identity: preview,
    });
    const integrated = await integrate({
      cwd: workspace.path,
      ownershipId: workspace.ownershipId,
      remote: "origin",
      integrationBranch: "main",
      expectedBaseSha: workspace.baseSha,
      candidateSha: accepted.sha,
      candidateTree: tree,
      message: "default-path integrate",
      proof: proofShell(accepted.sha, tree),
      staging,
      authorAcceptance: "Yes.",
    });
    const cleaned = await workspaceCleanup({
      cwd: workspace.path,
      deliveredSha: integrated.integratedSha,
    });
    expect(cleaned.path).toBe(workspace.path);
    expect(cleaned.delivery).toBe("integrated-tree");
  }, 30_000);
});

/**
 * Default-path parent chain hardening.
 *
 * `poiesis workspace prepare` (default path) must validate every relevant
 * component of `<root>/.poiesis/workspaces/` with lstat-style no-follow
 * semantics before any mkdir/worktree write. A hostile symlink at
 * `.poiesis` or `.poiesis/workspaces` would otherwise let the default
 * path escape the project root and mutate an external target. The
 * same applies to a non-directory component that would silently redirect
 * mkdir/realpath. All four hostile cases must fail closed before any
 * target mutation, worktree, marker, or branch creation; a positive
 * lifecycle must still place the workspace physically inside the project
 * root (realpath containment under realpath(root)).
 */

describe("workspace prepare default path parent chain hardening", () => {
  const repositories: TestRepository[] = [];
  const externalTargets: string[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  beforeEach(async () => {
    env = await installFakeOpenCode();
  });
  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
    await Promise.all(externalTargets.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  async function branchExists(repository: TestRepository, branch: string): Promise<boolean> {
    const result = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repository.root, allowFailure: true });
    return result.exitCode === 0;
  }

  async function markersCount(repository: TestRepository): Promise<number> {
    const commonDirResult = await run("git", ["rev-parse", "--git-common-dir"], { cwd: repository.root });
    const commonDir = commonDirResult.stdout.startsWith("/")
      ? commonDirResult.stdout
      : join(repository.root, commonDirResult.stdout);
    try {
      const entries = await readdir(join(commonDir, "poiesis-workspaces-v1"));
      return entries.length;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  it("rejects when <root>/.poiesis is a symlink to an external target (no target mutation, no worktree, no marker, no branch)", async () => {
    // Spec #104 / ticket #110: the runtime identity guard now fails
    // closed on an absent manifest, so the parent-chain safety path
    // cannot be exercised without an installed manifest first. The
    // rejection code is RUNTIME_VERSION_MISMATCH because the guard
    // fires before the parent-chain check inside workspacePrepare.
    const repository = await createTestRepository();
    repositories.push(repository);
    const external = join(repository.parent, "external-poiesis-target");
    await mkdir(external, { recursive: false });
    await writeFile(join(external, "preexisting.txt"), "do not touch\n");
    externalTargets.push(external);
    await symlink(external, join(repository.root, ".poiesis"));

    const branch = "poiesis/hostile-poiesis-symlink";
    const beforeBranches = (await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: repository.root })).stdout.trim();
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch,
        specId: "spec-hostile-poiesis-symlink",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_VERSION_MISMATCH" });

    // Hostile symlink at .poiesis survives untouched (no follow, no replace).
    const poiesisStat = await lstat(join(repository.root, ".poiesis"));
    expect(poiesisStat.isSymbolicLink()).toBe(true);
    // External target is not mutated: no Poiesis workspace directory,
    // no workspace files, no marker bytes.
    expect(await directoryExists(join(external, "workspaces"))).toBe(false);
    expect(await directoryExists(join(external, "poiesis-workspaces-v1"))).toBe(false);
    expect(await readdir(external)).toEqual(["preexisting.txt"]);
    expect(await readFile(join(external, "preexisting.txt"), "utf8")).toBe("do not touch\n");
    // No worktree, no marker, no branch were created. The hostile symlink
    // at .poiesis already survived untouched (checked above via lstat); we
    // do not assert it is a directory because it is intentionally a symlink.
    expect(await directoryExists(join(repository.root, ".poiesis", "workspaces"))).toBe(false);
    expect(await markersCount(repository)).toBe(0);
    expect(await branchExists(repository, branch)).toBe(false);
    const afterBranches = (await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: repository.root })).stdout.trim();
    expect(afterBranches).toBe(beforeBranches);
  }, 30_000);

  it("rejects when <root>/.poiesis/workspaces is a symlink to an external target (no target mutation, no worktree, no marker, no branch)", async () => {
    // Spec #104 / ticket #110: the runtime identity guard now fails
    // closed on an absent manifest, so the parent-chain safety path
    // cannot be exercised without an installed manifest first. The
    // rejection code is RUNTIME_VERSION_MISMATCH because the guard
    // fires before the parent-chain check inside workspacePrepare.
    const repository = await createTestRepository();
    repositories.push(repository);
    await mkdir(join(repository.root, ".poiesis"), { recursive: false });
    const external = join(repository.parent, "external-workspaces-target");
    await mkdir(external, { recursive: false });
    await writeFile(join(external, "preexisting.txt"), "do not touch\n");
    externalTargets.push(external);
    await symlink(external, join(repository.root, ".poiesis", "workspaces"));

    const branch = "poiesis/hostile-workspaces-symlink";
    const beforeBranches = (await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: repository.root })).stdout.trim();
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch,
        specId: "spec-hostile-workspaces-symlink",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_VERSION_MISMATCH" });

    // Hostile symlink at .poiesis/workspaces survives untouched.
    const workspacesStat = await lstat(join(repository.root, ".poiesis", "workspaces"));
    expect(workspacesStat.isSymbolicLink()).toBe(true);
    // External target is not mutated.
    expect(await directoryExists(join(external, "spec-hostile-workspaces-symlink__hostile-workspaces-symlink"))).toBe(false);
    expect(await directoryExists(join(external, "poiesis-workspaces-v1"))).toBe(false);
    expect(await readdir(external)).toEqual(["preexisting.txt"]);
    expect(await readFile(join(external, "preexisting.txt"), "utf8")).toBe("do not touch\n");
    // No worktree, no marker, no branch.
    expect(await markersCount(repository)).toBe(0);
    expect(await branchExists(repository, branch)).toBe(false);
    const afterBranches = (await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: repository.root })).stdout.trim();
    expect(afterBranches).toBe(beforeBranches);
  }, 30_000);

  it("rejects when <root>/.poiesis is a regular file (non-directory parent)", async () => {
    // Spec #104 / ticket #110: the runtime identity guard now fails
    // closed on an absent manifest, so the parent-chain safety path
    // cannot be exercised without an installed manifest first. The
    // rejection code is RUNTIME_VERSION_MISMATCH because the guard
    // fires before the parent-chain check inside workspacePrepare.
    const repository = await createTestRepository();
    repositories.push(repository);
    await rm(join(repository.root, ".poiesis"), { recursive: true, force: true }).catch(() => undefined);
    await writeFile(join(repository.root, ".poiesis"), "not a directory\n");

    const branch = "poiesis/regular-file-poiesis";
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch,
        specId: "spec-regular-poiesis",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_VERSION_MISMATCH" });

    // The regular file is left intact and the parent chain was not created.
    expect((await lstat(join(repository.root, ".poiesis"))).isFile()).toBe(true);
    expect(await readFile(join(repository.root, ".poiesis"), "utf8")).toBe("not a directory\n");
    expect(await directoryExists(join(repository.root, ".poiesis", "workspaces"))).toBe(false);
    expect(await markersCount(repository)).toBe(0);
    expect(await branchExists(repository, branch)).toBe(false);
  }, 30_000);

  it("rejects when <root>/.poiesis/workspaces is a regular file (non-directory parent)", async () => {
    // Spec #104 / ticket #110: the runtime identity guard now fails
    // closed on an absent manifest, so the parent-chain safety path
    // cannot be exercised without an installed manifest first. The
    // rejection code is RUNTIME_VERSION_MISMATCH because the guard
    // fires before the parent-chain check inside workspacePrepare.
    const repository = await createTestRepository();
    repositories.push(repository);
    await mkdir(join(repository.root, ".poiesis"), { recursive: false });
    await writeFile(join(repository.root, ".poiesis", "workspaces"), "not a directory\n");

    const branch = "poiesis/regular-file-workspaces";
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch,
        specId: "spec-regular-workspaces",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_VERSION_MISMATCH" });

    // The regular file is left intact.
    expect((await lstat(join(repository.root, ".poiesis", "workspaces"))).isFile()).toBe(true);
    expect(await readFile(join(repository.root, ".poiesis", "workspaces"), "utf8")).toBe("not a directory\n");
    expect(await markersCount(repository)).toBe(0);
    expect(await branchExists(repository, branch)).toBe(false);
  }, 30_000);

  it("keeps the normal lifecycle intact and proves canonical physical containment under the project root", async () => {
    const repository = await installedTestRepository(repositories);
    const workspace = await workspacePrepare({
      cwd: repository.root,
      remote: "origin",
      integrationBranch: "main",
      branch: "poiesis/default-path-containment",
      specId: "spec-default-containment",
    });
    // The returned workspace path is the canonical physical path; it must
    // live strictly inside the realpath(root) — not a sibling escape.
    const realRoot = await realpath(repository.root);
    const realWorkspace = await realpath(workspace.path);
    expect(realWorkspace.startsWith(realRoot + sep)).toBe(true);
    expect(relative(realRoot, realWorkspace)).not.toMatch(/^\.\./);
    expect(relative(realRoot, realWorkspace).startsWith(`.poiesis${sep}workspaces${sep}`)).toBe(true);
    // And `.poiesis`/`.poiesis/workspaces` are real directories (not symlinks).
    expect((await lstat(join(repository.root, ".poiesis"))).isDirectory()).toBe(true);
    expect((await lstat(join(repository.root, ".poiesis", "workspaces"))).isDirectory()).toBe(true);
    expect((await lstat(join(repository.root, ".poiesis"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(repository.root, ".poiesis", "workspaces"))).isSymbolicLink()).toBe(false);
  }, 30_000);
});

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { code: string }).code === "ENOENT" || (error as { code: string }).code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

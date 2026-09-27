import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor, init, uninstall } from "../src/maintenance.js";
import {
  REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY,
  GRAPHIFY_VERSION,
  repositoryIntelligenceStatus,
  writeRepositoryIntelligenceState,
} from "../src/repository-intelligence.js";
import { exists } from "../src/fs.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

/**
 * Install a fake `uv` binary on PATH. The fake echoes a version and
 * exits 0 for any invocation, mirroring the installFakeOpenCode
 * pattern. The fake is installed ONLY for the lifetime of a test so
 * other tests that expect `uv` to be absent see a clean PATH.
 */
async function installFakeUv(): Promise<FakeUvEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-"));
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

/**
 * Strip every PATH entry that contains a `uv` binary, leaving every
 * other directory (git, fake opencode, basic system tools) reachable.
 * The helper scans `PATH` for any directory that yields an executable
 * `uv` (via `which` semantics) and excludes it. This keeps the
 * `uv --version` probe deterministic across test environments that
 * may or may not have a system `uv` installed.
 *
 * `which`-style resolution: a directory is considered to have a `uv`
 * binary iff `<dir>/uv` exists as a regular file or symlink. The
 * helper does not follow symlinks for symlink safety; if `/a/uv` is a
 * symlink to `/b/uv` and only `/a` is on PATH, the helper excludes
 * `/a` and the probe therefore fails, matching the operator-facing
 * "uv missing" condition.
 */
function maskUvPath(): { restore: () => void } {
  const previousPath = process.env.PATH;
  const segments = (previousPath ?? "").split(":").filter((segment) => {
    if (segment.length === 0) return false;
    // Synchronous probe: does `<segment>/uv` exist?
    try {
      const { existsSync, statSync } = require("node:fs") as typeof import("node:fs");
      if (!existsSync(segment)) return true;
      const stat = statSync(segment);
      if (!stat.isDirectory()) return true;
      return !existsSync(`${segment}/uv`);
    } catch {
      return true;
    }
  });
  process.env.PATH = segments.join(":");
  return {
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    },
  };
}

describe("ticket #121 init / doctor / uninstall integration", () => {
  let opencode: FakeOpenCodeEnvironment | undefined;
  const repositories: TestRepository[] = [];
  let uv: FakeUvEnvironment | undefined;

  afterEach(async () => {
    opencode?.restore();
    opencode = undefined;
    uv?.restore();
    uv = undefined;
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  beforeEach(async () => {
    opencode = await installFakeOpenCode();
    uv = await installFakeUv();
  });

  it("init writes the .poiesis/cache/ gitignore rule alongside the existing local-state rules", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const gitignore = await readFile(join(repository.root, ".gitignore"), "utf8");
    // The cache directory is local state; init must add the rule
    // through the same ensureGitignore transaction the manifest /
    // workspaces rules use, so an uninstall that walks the gitignore
    // sees the cache line and never tracks cache files.
    expect(gitignore).toContain(REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY);
  }, 30_000);

  it("init does not record any cache path as a managed file in the manifest", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const manifest = await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const cacheRefs = manifest.files.filter((file) => file.path.startsWith(".poiesis/cache"));
    expect(cacheRefs).toEqual([]);
    // The manifest must also not list the cache directory as a
    // durable, tracked file: the cache is local state only.
    expect(manifest.files.some((file) => file.durable === true && file.path.startsWith(".poiesis/cache"))).toBe(false);
  }, 30_000);

  it("init fails closed with REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING before any canonical mutation when uv is absent", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // Strip every PATH entry that contains a `uv` binary so the
    // requirement gate fails. Git, OpenCode, and every other PATH
    // entry remain reachable so the failure isolates to the
    // missing-uv condition.
    const masked = maskUvPath();
    try {
      await expect(
        init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
      ).rejects.toMatchObject({
        code: "REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING",
        details: { requirement: "uv", engine: "graphify", engineVersion: GRAPHIFY_VERSION, hint: "missing-binary" },
      });
    } finally {
      masked.restore();
    }
    // No canonical mutation: no manifest, no .poiesis/ directory,
    // no .gitignore write, no OpenCode config write. The repository
    // is byte-for-byte identical to its pre-init state.
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, "opencode.jsonc"))).toBe(false);
    expect(await exists(join(repository.root, ".agents"))).toBe(false);
  }, 30_000);

  it("doctor reports the repository-intelligence-runner check as fail when uv is unavailable", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    // Strip every PATH entry that contains a `uv` binary so the
    // doctor uv probe fails.
    const masked = maskUvPath();
    try {
      const report = await doctor(repository.root);
      const check = report.checks.find((entry) => entry.id === "repository-intelligence-runner");
      expect(check?.status).toBe("fail");
      expect(check?.message).toMatch(/uv/);
      expect(check?.details).toMatchObject({
        uvAvailable: false,
        engine: "graphify",
        engineVersion: GRAPHIFY_VERSION,
        requirement: "uv",
        hint: "missing-binary",
        action: "install-uv",
      });
      // A hard doctor failure flips report.ok to false so the
      // existing `assertUpdateDoctorGate` predicate refuses update
      // transactions and the bounded journal rolls back.
      expect(report.ok).toBe(false);
    } finally {
      masked.restore();
    }
  }, 30_000);

  it("doctor reports the repository-intelligence-runner check as pass when uv is available and the cache is owned", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    // Stamp a fresh owned cache so the runtime sees a valid state.
    // The new layout requires a real generation directory the
    // `activeGeneration` pointer references; the doctor treats a
    // missing / unsafe pointer as a soft warn.
    const generationId = "generation-doctor-1";
    const generationDir = join(
      repository.root,
      ".poiesis",
      "cache",
      "repository-intelligence",
      "generations",
      generationId,
    );
    await mkdir(generationDir, { recursive: true });
    await writeFile(join(generationDir, "graph.json"), "{}\n");
    await writeRepositoryIntelligenceState(repository.root, {
      schema: 1,
      engine: "graphify",
      engineVersion: GRAPHIFY_VERSION,
      mode: "code-only",
      activeGeneration: generationId,
    });
    const report = await doctor(repository.root);
    const check = report.checks.find((entry) => entry.id === "repository-intelligence-runner");
    expect(check?.status).toBe("pass");
    expect(check?.details).toMatchObject({ uvAvailable: true, cachePresent: true, engine: "graphify", engineVersion: GRAPHIFY_VERSION });
  }, 30_000);

  it("doctor reports engine-version-mismatch as warn (still operational; next query rebuilds)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    await writeRepositoryIntelligenceState(repository.root, {
      schema: 1,
      engine: "graphify",
      engineVersion: "0.0.1",
      mode: "code-only",
    });
    const report = await doctor(repository.root);
    const check = report.checks.find((entry) => entry.id === "repository-intelligence-runner");
    expect(check?.status).toBe("warn");
    expect(check?.details).toMatchObject({ reason: "engine-version-mismatch", uvAvailable: true, cachePresent: true });
    // A stale cache is a soft warning; the requirement gate fires
    // only on the missing `uv` case. We deliberately do NOT assert
    // `report.ok === true` here because the test deliberately uses
    // `skipSkills: true` so the `skills` doctor check legitimately
    // fails — the assertion we care about is the typed warning
    // surface, not the overall green verdict.
  }, 30_000);

  it("update refuses to claim a complete 1.2 installation when uv disappears after init", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    // Simulate the dependency disappearing: strip every PATH entry
    // that contains a `uv` binary so the next update sees a missing
    // uv.
    const masked = maskUvPath();
    try {
      // update() runs runUpdateTransaction which calls doctor() at
      // the end of the transaction. doctor() reports uv-missing as
      // `fail`, so the existing `assertUpdateDoctorGate` predicate
      // throws `UPDATE_DOCTOR_FAILED` and the bounded journal rolls
      // back. The transaction therefore refuses to claim a complete
      // 1.2 installation when uv is gone.
      const { update } = await import("../src/maintenance.js");
      await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
        code: "UPDATE_DOCTOR_FAILED",
      });
    } finally {
      masked.restore();
    }
  }, 30_000);

  it("uninstall removes the validated owned Repository Intelligence cache", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const ownedDir = join(repository.root, ".poiesis", "cache", "repository-intelligence");
    await mkdir(join(ownedDir, "graphify"), { recursive: true });
    await writeFile(join(ownedDir, "state.json"), "{}\n");
    await writeFile(join(ownedDir, "graphify", "graph.json"), "{}\n");
    expect(await exists(ownedDir)).toBe(true);
    const result = await uninstall(repository.root);
    expect(await exists(ownedDir)).toBe(false);
    expect(result.removed).toContain(".poiesis/cache/repository-intelligence");
  }, 30_000);

  it("uninstall preserves foreign cache content under .poiesis/cache/", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const foreignDir = join(repository.root, ".poiesis", "cache", "foreign");
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(foreignDir, "user.txt"), "keep\n");
    const result = await uninstall(repository.root);
    expect(await exists(foreignDir)).toBe(true);
    const preservedCacheEntry = result.preserved.find((entry) => entry.path === ".poiesis/cache/foreign");
    expect(preservedCacheEntry?.reason).toMatch(/foreign content/);
  }, 30_000);

  it("uninstall refuses to delete a cache whose owned subdirectory contains a symlink", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const ownedDir = join(repository.root, ".poiesis", "cache", "repository-intelligence");
    await mkdir(ownedDir, { recursive: true });
    await writeFile(join(ownedDir, "state.json"), "{}\n");
    // Replace the state.json with a symlink so the validator walks
    // into the symlink and refuses the removal. This proves the
    // ownership validator guards the destructive path.
    await rm(join(ownedDir, "state.json"));
    await symlink("/tmp", join(ownedDir, "state.json"));
    const result = await uninstall(repository.root);
    // The owned dir must survive the uninstall attempt.
    expect(await exists(ownedDir)).toBe(true);
    // The uninstall result surfaces the refusal as a preserved entry
    // so the operator can investigate without losing the manifest.
    const preservedCacheEntry = result.preserved.find((entry) => entry.path === ".poiesis/cache/");
    expect(preservedCacheEntry?.reason).toMatch(/cache validation refused removal/);
    // The manifest is NOT removed because the operator still owns
    // the installation; the refusal is an ownership signal, not a
    // installation failure.
    expect(result.complete).toBe(false);
    expect(result.manifestRemoved).toBe(false);
  }, 30_000);

  it("repositoryIntelligenceStatus is purely mechanical and never mutates the repository", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const before = await readFile(join(repository.root, ".poiesis", "manifest.json"), "utf8");
    const status = await repositoryIntelligenceStatus(repository.root);
    expect(status.engine).toBe("graphify");
    expect(status.engineVersion).toBe(GRAPHIFY_VERSION);
    expect(status.uvAvailable).toBe(true);
    // Status does NOT create the cache (cache-absent when no query
    // has run). The cache is built lazily by query/path/explain.
    expect(status.cachePresent).toBe(false);
    const after = await readFile(join(repository.root, ".poiesis", "manifest.json"), "utf8");
    expect(after).toBe(before);
  }, 30_000);
});

import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exists } from "../src/fs.js";
import {
  REPOSITORY_INTELLIGENCE_ENGINE,
  REPOSITORY_INTELLIGENCE_STATE_SCHEMA,
  GRAPHIFY_VERSION,
  GRAPHIFY_PACKAGE,
  GRAPHIFY_PYTHON,
  REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY,
  REPOSITORY_INTELLIGENCE_STATE_RELATIVE_PATH,
  repositoryIntelligenceCachePath,
  repositoryIntelligenceStatePath,
  repositoryIntelligenceGraphifyPath,
  probeUvAvailability,
  assertUvRequirement,
  readRepositoryIntelligenceState,
  writeRepositoryIntelligenceState,
  repositoryIntelligenceStatus,
  purgeRepositoryIntelligenceCache,
  validateRepositoryIntelligenceCache,
  removeValidatedRepositoryIntelligenceCache,
  isCachePathInside,
  type RepositoryIntelligenceStatus,
  type RepositoryIntelligenceState,
} from "../src/repository-intelligence.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

/**
 * Install a fake `uv` binary on PATH that reports `--version` and exits
 * 0. Mirrors the installFakeOpenCode pattern from `tests/fake-opencode.ts`
 * but stays local to this suite because it is the only consumer of a
 * `uv` fake.
 */
async function installFakeUv(): Promise<FakeUvEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await (await import("node:fs/promises")).chmod(script, 0o755);
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

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-ri-"));
  const root = join(parent, "repo");
  await mkdir(root);
  return root;
}

describe("repository-intelligence constants", () => {
  it("exposes a pinned graphify engine and exact uvx package identifier", () => {
    expect(REPOSITORY_INTELLIGENCE_ENGINE).toBe("graphify");
    expect(GRAPHIFY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(GRAPHIFY_PACKAGE).toBe(`graphifyy==${GRAPHIFY_VERSION}`);
    expect(GRAPHIFY_PYTHON).toBe("3.12");
  });

  it("exposes a stable non-canonical cache directory and state path", () => {
    expect(REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY).toBe(".poiesis/cache/");
    expect(REPOSITORY_INTELLIGENCE_STATE_RELATIVE_PATH).toBe(".poiesis/cache/repository-intelligence/state.json");
    expect(REPOSITORY_INTELLIGENCE_STATE_SCHEMA).toBe(1);
  });

  it("derives absolute cache paths inside the resolved repo root", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      const state = repositoryIntelligenceStatePath(root);
      const graphify = repositoryIntelligenceGraphifyPath(root);
      expect(cache).toBe(join(root, ".poiesis", "cache"));
      expect(state).toBe(join(root, ".poiesis", "cache", "repository-intelligence", "state.json"));
      expect(graphify).toBe(join(root, ".poiesis", "cache", "repository-intelligence", "graphify"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute, dot, and traversal cache paths in isCachePathInside", async () => {
    const root = await makeRepo();
    try {
      expect(isCachePathInside(root, "")).toBe(false);
      expect(isCachePathInside(root, ".poiesis/cache/")).toBe(true);
      expect(isCachePathInside(root, ".poiesis/cache/repository-intelligence/state.json")).toBe(true);
      expect(isCachePathInside(root, ".poiesis/manifest.json")).toBe(false);
      expect(isCachePathInside(root, "/etc/passwd")).toBe(false);
      expect(isCachePathInside(root, "../etc")).toBe(false);
      expect(isCachePathInside(root, ".poiesis/cache-evil/state.json")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("probeUvAvailability", () => {
  let env: FakeUvEnvironment | undefined;

  afterEach(() => {
    env?.restore();
    env = undefined;
  });

  it("returns true when uv is on PATH", async () => {
    env = await installFakeUv();
    expect(await probeUvAvailability()).toBe(true);
  });

  it("returns false when uv is not on PATH", async () => {
    const previousPath = process.env.PATH;
    delete process.env.PATH;
    try {
      expect(await probeUvAvailability()).toBe(false);
    } finally {
      if (previousPath !== undefined) process.env.PATH = previousPath;
    }
  });
});

describe("assertUvRequirement (init / update / doctor gate)", () => {
  let env: FakeUvEnvironment | undefined;

  afterEach(() => {
    env?.restore();
    env = undefined;
  });

  it("resolves silently when uv is on PATH", async () => {
    env = await installFakeUv();
    await expect(assertUvRequirement()).resolves.toBeUndefined();
  });

  it("throws REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING with actionable detail when uv is absent", async () => {
    const previousPath = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(assertUvRequirement()).rejects.toMatchObject({
        code: "REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING",
        details: {
          requirement: "uv",
          python: GRAPHIFY_PYTHON,
          engine: REPOSITORY_INTELLIGENCE_ENGINE,
          engineVersion: GRAPHIFY_VERSION,
          hint: "missing-binary",
        },
      });
    } finally {
      if (previousPath !== undefined) process.env.PATH = previousPath;
    }
  });
});

describe("state.json read/write", () => {
  it("returns undefined when state.json is absent", async () => {
    const root = await makeRepo();
    try {
      expect(await readRepositoryIntelligenceState(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips a canonical state object", async () => {
    const root = await makeRepo();
    try {
      const state: RepositoryIntelligenceState = {
        schema: 1,
        engine: "graphify",
        engineVersion: GRAPHIFY_VERSION,
        mode: "code-only",
      };
      await writeRepositoryIntelligenceState(root, state);
      const read = await readRepositoryIntelligenceState(root);
      expect(read).toEqual(state);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unrecognized state schema on read", async () => {
    const root = await makeRepo();
    try {
      const statePath = repositoryIntelligenceStatePath(root);
      await mkdir(join(statePath, ".."), { recursive: true });
      await writeFile(statePath, `${JSON.stringify({ schema: 999, engine: "graphify", engineVersion: GRAPHIFY_VERSION, mode: "code-only" }, null, 2)}\n`);
      await expect(readRepositoryIntelligenceState(root)).rejects.toMatchObject({ code: "REPOSITORY_INTELLIGENCE_STATE_INVALID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a state with an unsupported engine", async () => {
    const root = await makeRepo();
    try {
      const statePath = repositoryIntelligenceStatePath(root);
      await mkdir(join(statePath, ".."), { recursive: true });
      await writeFile(statePath, `${JSON.stringify({ schema: 1, engine: "other", engineVersion: GRAPHIFY_VERSION, mode: "code-only" }, null, 2)}\n`);
      await expect(readRepositoryIntelligenceState(root)).rejects.toMatchObject({ code: "REPOSITORY_INTELLIGENCE_STATE_INVALID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("repositoryIntelligenceStatus", () => {
  it("reports enabled=false when uv is unavailable and no cache exists", async () => {
    const root = await makeRepo();
    const previousPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const status = await repositoryIntelligenceStatus(root);
      expect(status).toEqual<RepositoryIntelligenceStatus>({
        enabled: false,
        engine: "graphify",
        engineVersion: GRAPHIFY_VERSION,
        uvAvailable: false,
        cachePresent: false,
        cacheValid: false,
        reason: "uv-unavailable",
      });
    } finally {
      if (previousPath !== undefined) process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports enabled=true when uv is available and no cache exists", async () => {
    const root = await makeRepo();
    const env = await installFakeUv();
    try {
      const status = await repositoryIntelligenceStatus(root);
      expect(status).toEqual<RepositoryIntelligenceStatus>({
        enabled: true,
        engine: "graphify",
        engineVersion: GRAPHIFY_VERSION,
        uvAvailable: true,
        cachePresent: false,
        cacheValid: false,
        reason: "cache-absent",
      });
    } finally {
      env.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports cachePresent=true and cacheValid=true when the state file is owned and the engine version matches", async () => {
    const root = await makeRepo();
    const env = await installFakeUv();
    try {
      const generationId = "generation-test-1";
      const generationDir = join(
        root,
        ".poiesis",
        "cache",
        "repository-intelligence",
        "generations",
        generationId,
      );
      await mkdir(generationDir, { recursive: true });
      await writeFile(join(generationDir, "graph.json"), "{}\n");
      await writeRepositoryIntelligenceState(root, {
        schema: 1,
        engine: "graphify",
        engineVersion: GRAPHIFY_VERSION,
        mode: "code-only",
        activeGeneration: generationId,
      });
      const status = await repositoryIntelligenceStatus(root);
      expect(status.uvAvailable).toBe(true);
      expect(status.cachePresent).toBe(true);
      expect(status.cacheValid).toBe(true);
      expect(status.reason).toBe("ready");
    } finally {
      env.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports cachePresent=true and cacheValid=false when the engine version is stale", async () => {
    const root = await makeRepo();
    const env = await installFakeUv();
    try {
      await writeRepositoryIntelligenceState(root, {
        schema: 1,
        engine: "graphify",
        engineVersion: "0.0.1",
        mode: "code-only",
      });
      const status = await repositoryIntelligenceStatus(root);
      expect(status.uvAvailable).toBe(true);
      expect(status.cachePresent).toBe(true);
      expect(status.cacheValid).toBe(false);
      expect(status.reason).toBe("engine-version-mismatch");
    } finally {
      env.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not run any subprocess and never contacts the network", async () => {
    const root = await makeRepo();
    const env = await installFakeUv();
    try {
      const status = await repositoryIntelligenceStatus(root);
      expect(status.engine).toBe("graphify");
      expect(status.engineVersion).toBe(GRAPHIFY_VERSION);
      // No subprocess is spawned; uv is only probed via PATH resolution.
    } finally {
      env.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("purgeRepositoryIntelligenceCache", () => {
  it("removes the entire .poiesis/cache/ directory tree", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      await mkdir(join(cache, "repository-intelligence", "graphify"), { recursive: true });
      await writeFile(join(cache, "repository-intelligence", "graphify", "graph.json"), "{}\n");
      await writeFile(join(cache, "repository-intelligence", "state.json"), "{}\n");
      await purgeRepositoryIntelligenceCache(root);
      expect(await exists(cache)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when the cache is absent", async () => {
    const root = await makeRepo();
    try {
      await expect(purgeRepositoryIntelligenceCache(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to purge when the cache contains a symlinked subdirectory", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      await mkdir(cache, { recursive: true });
      await symlink("/tmp", join(cache, "repository-intelligence"));
      await expect(purgeRepositoryIntelligenceCache(root)).rejects.toMatchObject({
        code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("validateRepositoryIntelligenceCache", () => {
  it("rejects a cache directory that escapes the project root", async () => {
    const root = await makeRepo();
    try {
      await expect(validateRepositoryIntelligenceCache(root, "/etc/passwd")).rejects.toMatchObject({
        code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a cache directory whose parent is a symlink", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      await mkdir(join(root, ".poiesis"), { recursive: true });
      await symlink("/tmp", cache);
      await expect(validateRepositoryIntelligenceCache(root, cache)).rejects.toMatchObject({
        code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a fully-owned cache directory", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      await mkdir(cache, { recursive: true });
      await mkdir(join(cache, "repository-intelligence", "graphify"), { recursive: true });
      await writeFile(join(cache, "repository-intelligence", "state.json"), "{}\n");
      await writeFile(join(cache, "repository-intelligence", "graphify", "graph.json"), "{}\n");
      const result = await validateRepositoryIntelligenceCache(root, cache);
      expect(result.root).toBe(cache);
      expect(result.owned).toBe(true);
      expect(result.entries.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a cache whose repository-intelligence subdir is a symlink", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      await mkdir(cache, { recursive: true });
      await symlink("/tmp", join(cache, "repository-intelligence"));
      await expect(validateRepositoryIntelligenceCache(root, cache)).rejects.toMatchObject({
        code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("removeValidatedRepositoryIntelligenceCache", () => {
  it("removes only the validated owned cache and preserves foreign content", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      const ownedDir = join(cache, "repository-intelligence");
      const foreignDir = join(cache, "foreign");
      await mkdir(ownedDir, { recursive: true });
      await mkdir(foreignDir, { recursive: true });
      await writeFile(join(ownedDir, "state.json"), "{}\n");
      await writeFile(join(foreignDir, "user.txt"), "keep\n");
      const result = await removeValidatedRepositoryIntelligenceCache(root);
      expect(result.removed).toBe(true);
      expect(result.preserved).toEqual([]);
      expect(result.foreignPreserved).toEqual(["foreign"]);
      // The owned directory is gone, the foreign directory survives.
      const remaining = await readdir(cache);
      expect(remaining).toEqual(["foreign"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an absent cache as a successful no-op", async () => {
    const root = await makeRepo();
    try {
      const result = await removeValidatedRepositoryIntelligenceCache(root);
      expect(result.removed).toBe(false);
      expect(result.preserved).toEqual([]);
      expect(result.foreignPreserved).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to remove a cache whose owned subdirectory contains a symlink", async () => {
    const root = await makeRepo();
    try {
      const cache = repositoryIntelligenceCachePath(root);
      const ownedDir = join(cache, "repository-intelligence");
      await mkdir(ownedDir, { recursive: true });
      // Place the attacker-controlled symlink INSIDE the owned
      // subdirectory so the validator walks into it and refuses with
      // `REPOSITORY_INTELLIGENCE_CACHE_UNSAFE`. Foreign top-level
      // siblings are deliberately preserved by uninstall.
      await symlink("/tmp", join(ownedDir, "foreign-symlink"));
      await expect(removeValidatedRepositoryIntelligenceCache(root)).rejects.toMatchObject({
        code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor, init, resolveConfigForRoot, update } from "../src/maintenance.js";
import { loadManifest } from "../src/manifest.js";
import { assertManifestAuthority } from "../src/authority.js";
import {
  SUPPORTED_OPENCODE_VERSIONS,
  SUPPORTED_OPENCODE_VERSION,
  isSupportedOpenCodeVersion,
  verifyOpenCodeVersion,
} from "../src/opencode.js";
import { run } from "../src/process.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

describe("OpenCode version gate", () => {
  afterEach(async () => {
    // Per-test cleanup is handled inside each test that installs the fake.
  });

  it("exposes 1.18.29 and 1.18.30 as the explicit adapter-v1 supported set", () => {
    expect(SUPPORTED_OPENCODE_VERSIONS).toEqual(["1.18.29", "1.18.30"]);
  });

  it.each(["1.18.29", "1.18.30"])("accepts %s via isSupportedOpenCodeVersion", (version) => {
    expect(isSupportedOpenCodeVersion(version)).toBe(true);
  });

  it.each(["1.18.28", "1.18.31", "0.0.0", "garbage"])(
    "rejects %s via isSupportedOpenCodeVersion",
    (version) => {
      expect(isSupportedOpenCodeVersion(version)).toBe(false);
    },
  );

  it.each(["1.18.29", "1.18.30"])(
    "verifyOpenCodeVersion accepts the fake %s binary",
    async (version) => {
      const env = await installFakeOpenCode(version);
      try {
        await expect(verifyOpenCodeVersion("/")).resolves.toBe(version);
      } finally {
        env.restore();
      }
    },
  );

  it("verifyOpenCodeVersion rejects an unsupported version with a clear error", async () => {
    const env = await installFakeOpenCode("1.18.28");
    try {
      await expect(verifyOpenCodeVersion("/")).rejects.toMatchObject({
        code: "OPENCODE_VERSION_UNSUPPORTED",
        details: { installed: "1.18.28", supported: ["1.18.29", "1.18.30"] },
      });
    } finally {
      env.restore();
    }
  });
});

describe("OpenCode adapter-v1 doctor/init/update against fake binaries", () => {
  let env: FakeOpenCodeEnvironment | undefined;
  const repositories: TestRepository[] = [];

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("init succeeds against the 1.18.29 fake binary and records the explicit supportedVersions set", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const manifest = await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    expect(manifest.adapter.supportedVersion).toBe(SUPPORTED_OPENCODE_VERSION);
    expect(manifest.adapter.supportedVersions).toEqual([...SUPPORTED_OPENCODE_VERSIONS]);
  }, 30_000);

  it("init succeeds against a 1.18.30 fake binary and records the explicit supportedVersions set", async () => {
    env?.restore();
    env = await installFakeOpenCode("1.18.30");
    const repository = await createTestRepository();
    repositories.push(repository);
    const manifest = await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    expect(manifest.adapter.supportedVersion).toBe(SUPPORTED_OPENCODE_VERSION);
    expect(manifest.adapter.supportedVersions).toEqual([...SUPPORTED_OPENCODE_VERSIONS]);
  }, 30_000);

  it("update preserves the explicit supportedVersions set on the next manifest", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.adapter.supportedVersions).toEqual([...SUPPORTED_OPENCODE_VERSIONS]);
  }, 30_000);

  it("doctor recognizes the 1.18.30 fake binary's version and authority against the manifest", async () => {
    env?.restore();
    env = await installFakeOpenCode("1.18.30");
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const report = await doctor(repository.root);
    const opencodeVersion = report.checks.find((check) => check.id === "opencode-version");
    expect(opencodeVersion?.status).toBe("pass");
    expect(opencodeVersion?.details).toMatchObject({ installed: "1.18.30" });
    const manifest = report.checks.find((check) => check.id === "manifest");
    expect(manifest?.status).toBe("pass");
    const receipt = report.checks.find((check) => check.id === "receipt");
    expect(receipt?.status).toBe("pass");
    const opencodeSchema = report.checks.find((check) => check.id === "opencode-schema");
    expect(opencodeSchema?.status).toBe("pass");
  }, 30_000);
});

describe("OpenCode adapter-v1 fail-closed against unsupported fake binary", () => {
  let env: FakeOpenCodeEnvironment | undefined;
  const repositories: TestRepository[] = [];

  beforeEach(async () => {
    env = await installFakeOpenCode("1.18.28");
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("init rejects 1.18.28 fail-closed before any write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await expect(
      init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      }),
    ).rejects.toMatchObject({
      code: "OPENCODE_VERSION_UNSUPPORTED",
      details: { installed: "1.18.28", supported: ["1.18.29", "1.18.30"] },
    });
  }, 30_000);
});

describe("OpenCode adapter-v1 manifest authority backward compatibility", () => {
  const repositories: TestRepository[] = [];

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  // Pre-1.0.3 manifests only carry `supportedVersion`. The 1.0.3 authority must
  // accept them when that version is in the adapter-v1 supported set.
  it("accepts a legacy 1.18.29 manifest that lacks supportedVersions", async () => {
    const env = await installFakeOpenCode();
    try {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      const manifestPath = join(repository.root, ".poiesis", "manifest.json");
      const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const adapter = raw["adapter"] as Record<string, unknown>;
      delete adapter["supportedVersions"];
      await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);

      const manifest = await loadManifest(repository.root);
      const config = await resolveConfigForRoot(repository.root);
      await expect(assertManifestAuthority(repository.root, manifest, config)).resolves.toBeUndefined();
    } finally {
      env.restore();
    }
  }, 30_000);

  it("accepts a 1.0.3 manifest whose supportedVersions is the full set", async () => {
    const env = await installFakeOpenCode();
    try {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      const manifest = await loadManifest(repository.root);
      const config = await resolveConfigForRoot(repository.root);
      await expect(assertManifestAuthority(repository.root, manifest, config)).resolves.toBeUndefined();
      expect(manifest.adapter.supportedVersions).toEqual([...SUPPORTED_OPENCODE_VERSIONS]);
    } finally {
      env.restore();
    }
  }, 30_000);

  // Manifests whose supportedVersions contains a non-member must still fail
  // closed via the authority check.
  it("rejects a manifest whose supportedVersions contains a non-member", async () => {
    const env = await installFakeOpenCode();
    try {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      const manifestPath = join(repository.root, ".poiesis", "manifest.json");
      const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const adapter = raw["adapter"] as Record<string, unknown>;
      adapter["supportedVersions"] = ["1.18.28", "1.18.29"];
      await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);

      const probe = await run("opencode", ["debug", "config"], {
        cwd: repository.root,
        allowFailure: true,
      });
      expect(probe.exitCode).toBe(0);
      const manifest = await loadManifest(repository.root);
      const config = await resolveConfigForRoot(repository.root);
      await expect(assertManifestAuthority(repository.root, manifest, config)).rejects.toMatchObject({
        code: "MANIFEST_MIGRATION_REQUIRED",
      });
    } finally {
      env.restore();
    }
  }, 30_000);
});

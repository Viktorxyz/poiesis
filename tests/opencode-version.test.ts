import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor, init, resolveConfigForRoot, update } from "../src/maintenance.js";
import { loadManifest } from "../src/manifest.js";
import { assertManifestAuthority } from "../src/authority.js";
import {
  CERTIFIED_OPENCODE_VERSIONS,
  CERTIFIED_OPENCODE_VERSION,
  isCertifiedOpenCodeVersion,
  probeOpenCodeAdapterContract,
} from "../src/opencode.js";
import { run } from "../src/process.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

describe("OpenCode adapter-v1 supported set + certified probe", () => {
  it("exposes 1.18.29, 1.18.30 and 1.18.31 as the explicit adapter-v1 supported set", () => {
    expect(CERTIFIED_OPENCODE_VERSIONS).toEqual(["1.18.29", "1.18.30", "1.18.31"]);
  });

  it.each(["1.18.29", "1.18.30", "1.18.31"])("accepts %s via isCertifiedOpenCodeVersion", (version) => {
    expect(isCertifiedOpenCodeVersion(version)).toBe(true);
  });

  it.each(["1.18.28", "0.0.0", "garbage"])(
    "rejects %s via isCertifiedOpenCodeVersion",
    (version) => {
      expect(isCertifiedOpenCodeVersion(version)).toBe(false);
    },
  );

  it.each(["1.18.29", "1.18.30", "1.18.31"])(
    "probeOpenCodeAdapterContract reports certified = true for %s",
    async (version) => {
      const env = await installFakeOpenCode(version);
      try {
        const contract = await probeOpenCodeAdapterContract("/");
        expect(contract.installed).toBe(version);
        expect(contract.certified).toBe(true);
      } finally {
        env.restore();
      }
    },
  );

  it("probeOpenCodeAdapterContract reports certified = false for the newer unrecognized 1.18.32 patch", async () => {
    const env = await installFakeOpenCode("1.18.32");
    try {
      const contract = await probeOpenCodeAdapterContract("/");
      expect(contract.installed).toBe("1.18.32");
      expect(contract.certified).toBe(false);
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
    expect(manifest.adapter.supportedVersion).toBe(CERTIFIED_OPENCODE_VERSION);
    expect(manifest.adapter.supportedVersions).toEqual([...CERTIFIED_OPENCODE_VERSIONS]);
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
    expect(manifest.adapter.supportedVersion).toBe(CERTIFIED_OPENCODE_VERSION);
    expect(manifest.adapter.supportedVersions).toEqual([...CERTIFIED_OPENCODE_VERSIONS]);
  }, 30_000);

  it("init succeeds against a 1.18.31 fake binary and records the explicit supportedVersions set", async () => {
    env?.restore();
    env = await installFakeOpenCode("1.18.31");
    const repository = await createTestRepository();
    repositories.push(repository);
    const manifest = await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    expect(manifest.adapter.supportedVersion).toBe(CERTIFIED_OPENCODE_VERSION);
    expect(manifest.adapter.supportedVersions).toEqual([...CERTIFIED_OPENCODE_VERSIONS]);
  }, 30_000);

  it("update preserves the explicit supportedVersions set on the next manifest", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.adapter.supportedVersions).toEqual([...CERTIFIED_OPENCODE_VERSIONS]);
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

  it("doctor recognizes the 1.18.31 fake binary's version and authority against the manifest", async () => {
    env?.restore();
    env = await installFakeOpenCode("1.18.31");
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const report = await doctor(repository.root);
    const opencodeVersion = report.checks.find((check) => check.id === "opencode-version");
    expect(opencodeVersion?.status).toBe("pass");
    expect(opencodeVersion?.details).toMatchObject({ installed: "1.18.31" });
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
    // The capability-based contract check uses the schema probe (via
    // `debug config`) as the real safety boundary. The fake below
    // exercises the fail-closed path by rejecting the V1 schema
    // projection for any version NOT in the certified set — i.e. it
    // simulates a real-world OpenCode whose adapter contract has
    // drifted away from the V1 projection.
    env = await installFakeOpenCode({ version: "1.18.28", rejectV1SchemaForUnknownVersions: true });
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("init rejects 1.18.28 fail-closed before any write", async () => {
    // The strict certified-set gate no longer hard-fails `init`; the
    // V1 schema probe (validated separately via
    // `validateOpenCodeConfigPayload`) is the real safety boundary.
    // The global fake's `rejectV1SchemaForUnknownVersions: true`
    // option simulates the real-world "binary rejected the projection"
    // path so the capability probe fails closed with the typed
    // `OPENCODE_ADAPTER_INCOMPATIBLE` code.
    const repository = await createTestRepository();
    repositories.push(repository);
    await expect(
      init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      }),
    ).rejects.toMatchObject({
      code: "OPENCODE_ADAPTER_INCOMPATIBLE",
      details: { installed: "1.18.28" },
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
      expect(manifest.adapter.supportedVersions).toEqual([...CERTIFIED_OPENCODE_VERSIONS]);
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

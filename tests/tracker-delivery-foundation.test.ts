/**
 * Spec #139 / ticket #140 — tracker identity, deferred delivery, and
 * Git-remote-derived publishing coordinates.
 *
 * Three seams are under test:
 *
 *   1. `tracker` is a discriminated provider union
 *      (`github` | `gitlab` | `linear` | `local` | `fixture`). Existing
 *      GitHub / GitLab / fixture installations must keep parsing and
 *      resolving byte-for-byte, so every legacy shape is asserted here
 *      alongside the two new providers.
 *   2. `delivery` distinguishes three COMPLETE targets from the explicit
 *      `{ mode: "deferred" }` state. An omitted `delivery` block keeps
 *      its legacy generated-command behavior; a partial or mixed block is
 *      a typed failure, never a silently completed target.
 *   3. Publish provider / repository coordinates come from the configured
 *      Git remote, NOT from tracker identity — a `local` or `linear`
 *      tracker must still publish to the GitHub repository the remote
 *      points at, and a tracker-only coordinate must never be invented.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFERRED_DELIVERY_MODE,
  TRACKER_PROVIDERS,
  isDeferredDelivery,
  requireConfiguredDelivery,
  serializeConfig,
  trackerProjectOf,
  validateConfig,
  type ConfiguredDeliveryConfig,
  type PoiesisConfig,
  type ResolvedPoiesisConfig,
} from "../src/config.js";
import {
  autoResolveConfigDefaults,
  init,
  resolvePublishCoordinates,
  updateFromConfig,
  verifyDeliveryConfiguration,
  verifyTracker,
} from "../src/maintenance.js";
import { createTrackerAdapter } from "../src/adapters.js";
import { PoiesisError } from "../src/errors.js";
import { run } from "../src/process.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const CONFIG_ROOT = ".poiesis/config.jsonc";

function baseConfig(): PoiesisConfig {
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    verification: { commands: ["test -f README.md"] },
  };
}

function completeDelivery(): ConfiguredDeliveryConfig {
  return {
    preview: { adapter: "command", command: ["echo", "preview", "{sha}"] },
    staging: { adapter: "command", command: ["echo", "staging", "{sha}"] },
    production: { adapter: "command", command: ["echo", "production", "{sha}"] },
  };
}

async function pointRemoteAt(repository: TestRepository, url: string): Promise<void> {
  await run("git", ["remote", "set-url", "origin", url], { cwd: repository.root });
}

async function installFakeGh(): Promise<() => void> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-gh-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "gh");
  await writeFile(
    script,
    `#!/bin/sh
case "$1" in
  auth) exit 0 ;;
  repo)
    if [ "$2" = "view" ]; then
      printf '{"nameWithOwner":"%s"}\\n' "$3"
      exit 0
    fi
    exit 1
    ;;
esac
exit 0
`,
  );
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return () => {
    process.env.PATH = previousPath;
  };
}

describe("tracker configuration is a discriminated provider union", () => {
  it("exposes exactly the five supported tracker providers", () => {
    expect([...TRACKER_PROVIDERS]).toEqual(["github", "gitlab", "linear", "local", "fixture"]);
  });

  it("accepts a minimal shape for every supported provider", () => {
    const shapes: PoiesisConfig["tracker"][] = [
      { provider: "github" },
      { provider: "gitlab" },
      { provider: "linear", team: "ENG" },
      { provider: "local" },
      { provider: "fixture", project: "/tmp/poiesis-fixture" },
    ];
    for (const tracker of shapes) {
      const parsed = validateConfig({ ...baseConfig(), tracker }, "test");
      expect(parsed.tracker).toBeDefined();
    }
  });

  it("keeps legacy github / gitlab / fixture shapes and unknown keys parseable", () => {
    const legacy = validateConfig(
      {
        ...baseConfig(),
        tracker: { provider: "github", project: "owner/repo", retiredField: "kept" },
      },
      "test",
    );
    expect(legacy.tracker).toMatchObject({ provider: "github", project: "owner/repo" });

    const fixture = validateConfig(
      { ...baseConfig(), tracker: { provider: "fixture", project: "/tmp/poiesis-fixture" } },
      "test",
    );
    expect(fixture.tracker).toMatchObject({ provider: "fixture", project: "/tmp/poiesis-fixture" });
  });

  it("rejects an unknown provider with an actionable typed error", () => {
    let thrown: unknown;
    try {
      validateConfig({ ...baseConfig(), tracker: { provider: "jira" } }, "test");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PoiesisError);
    expect(thrown).toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
      details: { provider: "jira", supported: [...TRACKER_PROVIDERS] },
    });
  });

  it("rejects a tracker block without a usable provider", () => {
    expect(() => validateConfig({ ...baseConfig(), tracker: { project: "owner/repo" } }, "test")).toThrowError(
      /tracker\.provider/,
    );
    try {
      validateConfig({ ...baseConfig(), tracker: { project: "owner/repo" } }, "test");
    } catch (error) {
      expect((error as PoiesisError).code).toBe("INVALID_TRACKER_CONFIG");
    }
  });

  it("fails a linear tracker with no team at resolution time, naming the missing field", async () => {
    const repository = await createTestRepository();
    try {
      await expect(
        autoResolveConfigDefaults(repository.root, {
          ...baseConfig(),
          tracker: { provider: "linear" },
        }),
      ).rejects.toMatchObject({
        code: "INVALID_TRACKER_CONFIG",
        details: { provider: "linear", field: "tracker.team" },
      });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });
});

describe("tracker resolution stays independent from the Git remote", () => {
  it("still infers the github project from the remote for a github tracker", async () => {
    const repository = await createTestRepository();
    try {
      await pointRemoteAt(repository, "git@github.com:owner/repo.git");
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "github" },
      });
      expect(config.tracker).toEqual({ provider: "github", project: "owner/repo" });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("keeps a local tracker identity even when the remote is a recognized forge", async () => {
    const repository = await createTestRepository();
    try {
      await pointRemoteAt(repository, "git@github.com:owner/repo.git");
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
      });
      expect(config.tracker).toEqual({ provider: "local" });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("keeps linear coordinates from the config instead of deriving them from the remote", async () => {
    const repository = await createTestRepository();
    try {
      await pointRemoteAt(repository, "https://github.com/owner/repo.git");
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "linear", team: "ENG" },
      });
      expect(config.tracker).toEqual({ provider: "linear", team: "ENG" });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("resolves a local tracker on a repository whose remote is not a recognized forge", async () => {
    const repository = await createTestRepository();
    try {
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
      });
      expect(config.tracker).toEqual({ provider: "local" });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });
});

describe("delivery configuration distinguishes complete targets from explicit deferral", () => {
  it("keeps the legacy omitted-delivery behavior", async () => {
    const repository = await createTestRepository();
    try {
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
      });
      const delivery = requireConfiguredDelivery(config.delivery, "test");
      expect(delivery.preview).toEqual({ adapter: "command", command: ["node", "scripts/poiesis-preview.mjs", "{sha}", "{target}"] });
      expect(delivery.staging).toEqual({ adapter: "command", command: ["node", "scripts/poiesis-staging.mjs", "{sha}", "{target}"] });
      expect(delivery.production).toEqual({ adapter: "command", command: ["node", "scripts/poiesis-production.mjs", "{sha}", "{target}"] });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("resolves a complete delivery block without inventing a mode marker", async () => {
    const repository = await createTestRepository();
    try {
      const delivery = completeDelivery();
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
        delivery,
      });
      expect(config.delivery).toEqual(delivery);
      expect("mode" in config.delivery).toBe(false);
      expect(JSON.parse(serializeConfig(config)).delivery).toEqual(delivery);
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("resolves an explicit deferred block and serializes exactly that state", async () => {
    const repository = await createTestRepository();
    try {
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
        delivery: { mode: DEFERRED_DELIVERY_MODE },
      });
      expect(isDeferredDelivery(config.delivery)).toBe(true);
      expect(JSON.parse(serializeConfig(config)).delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("rejects a deferred block that also carries a target", () => {
    try {
      validateConfig(
        { ...baseConfig(), delivery: { mode: DEFERRED_DELIVERY_MODE, preview: { adapter: "command" } } },
        "test",
      );
      throw new Error("expected validateConfig to reject a mixed deferred delivery block");
    } catch (error) {
      expect(error).toBeInstanceOf(PoiesisError);
      expect(error).toMatchObject({ code: "INVALID_DELIVERY_CONFIG", details: { mode: DEFERRED_DELIVERY_MODE } });
      expect((error as PoiesisError).message).toContain("preview");
    }
  });

  it("rejects a partial delivery block and names every missing target", () => {
    try {
      validateConfig(
        { ...baseConfig(), delivery: { preview: { adapter: "command", command: ["echo", "{sha}"] } } },
        "test",
      );
      throw new Error("expected validateConfig to reject a partial delivery block");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_DELIVERY_CONFIG",
        details: { missing: ["staging", "production"] },
      });
    }
  });

  it("rejects an unknown delivery mode and lists the supported states", () => {
    try {
      validateConfig({ ...baseConfig(), delivery: { mode: "later" } }, "test");
      throw new Error("expected validateConfig to reject an unknown delivery mode");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_DELIVERY_CONFIG",
        details: { mode: "later" },
      });
      expect((error as PoiesisError).message).toContain(DEFERRED_DELIVERY_MODE);
    }
  });

  it("rejects per-target deferral and points at the block-level mode", () => {
    try {
      validateConfig(
        {
          ...baseConfig(),
          delivery: {
            preview: { mode: DEFERRED_DELIVERY_MODE },
            staging: { adapter: "command", command: ["echo", "{sha}"] },
            production: { adapter: "command", command: ["echo", "{sha}"] },
          },
        },
        "test",
      );
      throw new Error("expected validateConfig to reject per-target deferral");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_DELIVERY_CONFIG",
        details: { target: "preview" },
      });
      expect((error as PoiesisError).message).toContain(DEFERRED_DELIVERY_MODE);
    }
  });

  it("requireConfiguredDelivery fails closed with a typed deferred-delivery error", () => {
    expect(() => requireConfiguredDelivery({ mode: DEFERRED_DELIVERY_MODE }, "poiesis preview")).toThrowError(
      /poiesis preview/,
    );
    try {
      requireConfiguredDelivery({ mode: DEFERRED_DELIVERY_MODE }, "poiesis preview");
    } catch (error) {
      expect(error).toBeInstanceOf(PoiesisError);
      expect(error).toMatchObject({
        code: "DELIVERY_DEFERRED",
        details: { mode: DEFERRED_DELIVERY_MODE, operation: "poiesis preview" },
      });
    }
  });

  it("reports deferred delivery without constructing any delivery adapter", async () => {
    const repository = await createTestRepository();
    try {
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
        delivery: { mode: DEFERRED_DELIVERY_MODE },
      });
      expect(verifyDeliveryConfiguration(repository.root, config)).toBe("deferred");
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });
});

describe("publish coordinates are derived from the Git remote", () => {
  it("derives github coordinates from the remote for a local tracker", async () => {
    const repository = await createTestRepository();
    try {
      await pointRemoteAt(repository, "git@github.com:owner/repo.git");
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
      });
      expect(await resolvePublishCoordinates(repository.root, config)).toEqual({
        provider: "github",
        project: "owner/repo",
        source: "git-remote",
      });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("derives gitlab coordinates from the remote for a linear tracker", async () => {
    const repository = await createTestRepository();
    try {
      await pointRemoteAt(repository, "https://gitlab.com/group/subgroup/project.git");
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "linear", team: "ENG" },
      });
      expect(await resolvePublishCoordinates(repository.root, config)).toEqual({
        provider: "gitlab",
        project: "group/subgroup/project",
        source: "git-remote",
      });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("keeps legacy tracker coordinates for an unrecognized remote", async () => {
    const repository = await createTestRepository();
    try {
      const config = {
        ...(await autoResolveConfigDefaults(repository.root, testConfig(repository))).config,
      };
      expect(await resolvePublishCoordinates(repository.root, config)).toEqual({
        provider: "fixture",
        project: join(repository.fixtures, "tracker"),
        source: "tracker",
      });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("fails closed rather than inventing coordinates for a tracker-only provider", async () => {
    const repository = await createTestRepository();
    try {
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local" },
      });
      await expect(resolvePublishCoordinates(repository.root, config)).rejects.toMatchObject({
        code: "PUBLISH_PROVIDER_UNRESOLVED",
        details: { provider: "local" },
      });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });
});

describe("unimplemented tracker providers fail closed", () => {
  it("createTrackerAdapter refuses linear and local without a fake adapter", () => {
    for (const tracker of [
      { provider: "linear", team: "ENG" },
      { provider: "local" },
    ] as const) {
      try {
        createTrackerAdapter(tracker, process.cwd());
        throw new Error(`expected createTrackerAdapter to refuse ${tracker.provider}`);
      } catch (error) {
        expect(error).toBeInstanceOf(PoiesisError);
        expect(error).toMatchObject({ code: "UNSUPPORTED_TRACKER_PROVIDER" });
      }
    }
  });

  it("verifyTracker refuses linear and local with an actionable typed error", async () => {
    const repository = await createTestRepository();
    try {
      for (const tracker of [
        { provider: "linear", team: "ENG" },
        { provider: "local" },
      ] as const) {
        const { config } = await autoResolveConfigDefaults(repository.root, {
          ...baseConfig(),
          tracker,
        });
        await expect(verifyTracker(repository.root, config)).rejects.toMatchObject({
          code: "UNSUPPORTED_TRACKER_PROVIDER",
        });
      }
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });
});

describe("trackerProjectOf reads the repository coordinate across the union", () => {
  it("returns the project for forge and fixture trackers and undefined otherwise", () => {
    expect(trackerProjectOf({ provider: "github", project: "owner/repo" })).toBe("owner/repo");
    expect(trackerProjectOf({ provider: "fixture", project: "/tmp/fixture" })).toBe("/tmp/fixture");
    const linear: { provider: string; project?: unknown } & { team: string } = { provider: "linear", team: "ENG" };
    expect(trackerProjectOf(linear)).toBeUndefined();
    expect(trackerProjectOf({ provider: "local" })).toBeUndefined();
  });
});

describe("update --config accepts an explicitly deferred delivery block", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let restoreGh: (() => void) | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    restoreGh?.();
    restoreGh = undefined;
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("persists a deferred delivery block and reports a nonblocking doctor state", async () => {
    restoreGh = await installFakeGh();
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      {
        ...baseConfig(),
        tracker: { provider: "github", project: "owner/repo" },
        delivery: completeDelivery(),
      },
      { skipSkills: true },
    );

    const candidatePath = join(repository.parent, "deferred-config.jsonc");
    const candidate: PoiesisConfig = {
      ...baseConfig(),
      tracker: { provider: "github", project: "owner/repo" },
      delivery: { mode: DEFERRED_DELIVERY_MODE },
    };
    await writeFile(candidatePath, serializeConfig(candidate));

    const result = await updateFromConfig(repository.root, candidatePath);
    const deliveryCheck = result.doctor.checks.find((check) => check.id === "delivery");
    expect(deliveryCheck?.status).toBe("warn");

    const written = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(written).delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });
  }, 90_000);
});

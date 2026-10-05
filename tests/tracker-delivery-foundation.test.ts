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
  type ResolvedDeliveryConfig,
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

/**
 * Assert a `delivery` block is refused with the typed, actionable
 * `INVALID_DELIVERY_CONFIG` failure and the exact reported detail, so a
 * compatibility relaxation can never weaken the semantic rejections.
 */
function expectInvalidDeliveryConfig(config: unknown, details: Record<string, unknown>): void {
  let thrown: unknown;
  try {
    validateConfig(config, "test");
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected validateConfig to reject the delivery block").toBeInstanceOf(PoiesisError);
  expect(thrown).toMatchObject({ code: "INVALID_DELIVERY_CONFIG", details });
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

  /**
   * Spec #139 / ticket #152 — forward compatibility of the delivery block.
   *
   * Both honest branches are EXTENSIBLE: an unknown outer key (a newer
   * runtime's extension, an Author's own annotation) and an unknown nested
   * target-adapter key must survive parse and serialize, so a Poiesis that
   * does not know a key does not silently delete it on the next managed
   * rewrite of `.poiesis/config.jsonc`. This is a COMPATIBILITY relaxation
   * only: the semantic rejections above (partial targets, unknown modes,
   * deferred+target mixtures) are unchanged.
   */
  it("preserves unknown outer extension keys through parse and serialize on the configured branch", () => {
    const delivery = { ...completeDelivery(), experimental: { note: "kept", retries: 2 } };
    const parsed = validateConfig({ ...baseConfig(), delivery }, "test");
    expect(parsed.delivery).toMatchObject({ experimental: { note: "kept", retries: 2 } });
    expect(JSON.parse(serializeConfig(parsed)).delivery).toEqual(delivery);
  });

  it("preserves unknown outer extension keys through parse and serialize on the deferred branch", () => {
    const delivery = { mode: DEFERRED_DELIVERY_MODE, experimental: { note: "kept" } };
    const parsed = validateConfig({ ...baseConfig(), delivery }, "test");
    expect(isDeferredDelivery(parsed.delivery)).toBe(true);
    expect(JSON.parse(serializeConfig(parsed)).delivery).toEqual(delivery);
  });

  it("preserves unknown nested target-adapter keys through parse and serialize", () => {
    const delivery = {
      preview: { adapter: "command", command: ["echo", "preview", "{sha}"], timeoutMs: 5_000 },
      staging: { adapter: "command", command: ["echo", "staging", "{sha}"], retries: 2 },
      production: { adapter: "command", command: ["echo", "production", "{sha}"], note: "kept" },
    };
    const parsed = validateConfig({ ...baseConfig(), delivery }, "test");
    expect(JSON.parse(serializeConfig(parsed)).delivery).toEqual(delivery);
  });

  it("keeps rejecting an unknown mode that also carries an extension key", () => {
    expectInvalidDeliveryConfig(
      { ...baseConfig(), delivery: { mode: "later", experimental: true } },
      { mode: "later" },
    );
  });

  it("keeps rejecting a partial target set that also carries an extension key", () => {
    expectInvalidDeliveryConfig(
      { ...baseConfig(), delivery: { preview: { adapter: "command" }, experimental: true } },
      { missing: ["staging", "production"] },
    );
  });

  it("keeps rejecting a deferred block that carries a target alongside an extension key", () => {
    expectInvalidDeliveryConfig(
      {
        ...baseConfig(),
        delivery: { mode: DEFERRED_DELIVERY_MODE, preview: { adapter: "command" }, experimental: true },
      },
      { mode: DEFERRED_DELIVERY_MODE },
    );
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

/**
 * Spec #139 / ticket #153 — `resolveDelivery` is the ONE seam between the
 * `delivery` block an Author states and the value `init` / `update --config`
 * serialize into `.poiesis/config.jsonc`. It rebuilt both honest branches
 * from the known fields alone, so an extension key that ticket #152 taught
 * the schema to ACCEPT survived `validateConfig` and was then silently
 * deleted by the next managed rewrite. An accepted key that the runtime
 * cannot act on must be carried through, not consumed.
 *
 * What is pinned here:
 *
 *   1. every unknown OUTER key survives resolution on both branches;
 *   2. the known fields stay normalized and RESERVED — an extension can
 *      never introduce a target, never complete a partial block, and never
 *      rewrite `mode`;
 *   3. the resolved delivery TYPES represent an extension key, so the
 *      contract is checked by the compiler and not only at runtime;
 *   4. the semantic rejections from #152 are unchanged, extension keys
 *      included.
 */
describe("delivery extension keys survive config resolution", () => {
  /**
   * The chain both managed rewrites actually run: `validateConfig` (which
   * accepts an extension key) then `autoResolveConfigDefaults` (which used
   * to drop it). Resolution is never called with a raw unvalidated literal,
   * so a unit assertion that skipped the schema would not be evidence.
   */
  async function resolveWithDelivery(
    root: string,
    delivery: Record<string, unknown>,
  ): Promise<ResolvedPoiesisConfig> {
    const validated = validateConfig(
      { ...baseConfig(), tracker: { provider: "local" }, delivery },
      "test",
    );
    const { config } = await autoResolveConfigDefaults(root, validated);
    return config;
  }

  it("keeps unknown outer keys on the configured branch without inventing a mode", async () => {
    const repository = await createTestRepository();
    try {
      const delivery = { ...completeDelivery(), experimental: { note: "kept", retries: 2 } };
      const config = await resolveWithDelivery(repository.root, delivery);
      expect(config.delivery).toEqual(delivery);
      expect("mode" in config.delivery).toBe(false);
      expect(JSON.parse(serializeConfig(config)).delivery).toEqual(delivery);
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("keeps unknown outer keys on the deferred branch without completing a target", async () => {
    const repository = await createTestRepository();
    try {
      const delivery = { mode: DEFERRED_DELIVERY_MODE, experimental: { note: "kept" }, note: "author annotation" };
      const config = await resolveWithDelivery(repository.root, delivery);
      expect(isDeferredDelivery(config.delivery)).toBe(true);
      expect(config.delivery).toEqual(delivery);
      expect(verifyDeliveryConfiguration(repository.root, config)).toBe("deferred");
      expect(JSON.parse(serializeConfig(config)).delivery).toEqual(delivery);
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("normalizes the known fields and reserves them against the extension keys it carries", async () => {
    const repository = await createTestRepository();
    try {
      // A `mode`-shaped key with no usable value is a reserved name, not an
      // extension: it must not reach the resolved configured block, and it
      // must never be promoted to the deferred state.
      const configured = await resolveWithDelivery(repository.root, {
        ...completeDelivery(),
        mode: undefined,
        experimental: { note: "kept" },
      });
      // The three targets are the stated values, verbatim, and the resolved
      // object carries nothing but those targets plus the extension.
      expect(configured.delivery).toEqual({ ...completeDelivery(), experimental: { note: "kept" } });
      expect(Object.keys(configured.delivery as Record<string, unknown>).sort()).toEqual([
        "experimental",
        "preview",
        "production",
        "staging",
      ]);

      const deferred = await resolveWithDelivery(repository.root, {
        mode: DEFERRED_DELIVERY_MODE,
        experimental: { note: "kept" },
      });
      // The deferred branch stays deferred: the extension keys never
      // introduce a target, and `mode` is exactly the deferred literal.
      const resolvedDeferred = deferred.delivery as Record<string, unknown>;
      expect(resolvedDeferred["mode"]).toBe(DEFERRED_DELIVERY_MODE);
      expect(Object.keys(resolvedDeferred).sort()).toEqual(["experimental", "mode"]);
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("represents an extension key in both resolved delivery types", () => {
    // Compile-time evidence, asserted at runtime as well. If the resolved
    // delivery types stop representing an extension key, `pnpm check` fails
    // here even when every runtime assertion above still passes.
    const deferred: ResolvedDeliveryConfig = {
      mode: DEFERRED_DELIVERY_MODE,
      experimental: { note: "kept" },
    };
    const configured: ConfiguredDeliveryConfig = {
      ...completeDelivery(),
      experimental: { note: "kept" },
    };
    expect(isDeferredDelivery(deferred)).toBe(true);
    expect(deferred["experimental"]).toEqual({ note: "kept" });
    expect(configured.experimental).toEqual({ note: "kept" });
    // The extension key does not weaken a known field's type: a target is
    // still an object with a string `adapter`.
    const adapter: string = configured.preview.adapter;
    expect(adapter).toBe("command");
  });

  it("keeps the semantic rejections intact with extension keys present", () => {
    // Compatibility relaxation only: the typed, actionable failures from
    // #152 must not become a silently widened delivery contract.
    expectInvalidDeliveryConfig(
      { ...baseConfig(), delivery: { mode: "later", experimental: { note: "kept" } } },
      { mode: "later" },
    );
    expectInvalidDeliveryConfig(
      {
        ...baseConfig(),
        delivery: { preview: { adapter: "command" }, experimental: { note: "kept" } },
      },
      { missing: ["staging", "production"] },
    );
    expectInvalidDeliveryConfig(
      {
        ...baseConfig(),
        delivery: { mode: DEFERRED_DELIVERY_MODE, preview: { adapter: "command" }, experimental: true },
      },
      { mode: DEFERRED_DELIVERY_MODE },
    );
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

  // Spec #139 / ticket #146: this was "keeps legacy tracker coordinates for
  // an unrecognized remote" and also accepted a `github` / `gitlab` tracker,
  // which re-coupled publishing to tracker identity. The only surviving
  // fallback is the test-only `fixture` tracker, and it is labelled as such
  // in `source` so it can never be read as "tracker coordinates" again.
  it("keeps the test-only fixture coordinates for an unrecognized remote", async () => {
    const repository = await createTestRepository();
    try {
      const config = {
        ...(await autoResolveConfigDefaults(repository.root, testConfig(repository))).config,
      };
      expect(await resolvePublishCoordinates(repository.root, config)).toEqual({
        provider: "fixture",
        project: join(repository.fixtures, "tracker"),
        source: "fixture-tracker",
      });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("fails closed rather than inventing coordinates for a forge tracker on an unrecognized remote", async () => {
    const repository = await createTestRepository();
    try {
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "github", project: "owner/repo" },
      });
      await expect(resolvePublishCoordinates(repository.root, config)).rejects.toMatchObject({
        code: "PUBLISH_PROVIDER_UNRESOLVED",
        details: { provider: "github" },
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

/**
 * Ticket #142: `local` is no longer in this list. It is a first-class
 * provider with a complete adapter, so the fail-closed contract now applies
 * only to a provider whose adapter has not landed. `local`'s own factory,
 * verification, and lifecycle evidence lives in
 * `tests/local-tracker-adapter.test.ts`.
 */
/**
 * Spec #139: the fail-closed factory seam. It originally covered `linear`
 * and `local` as providers with no adapter. Both are now first-class
 * providers behind a real `TrackerAdapter` — `linear` in ticket #141,
 * `local` in ticket #142 — so that block has no remaining subject and is
 * removed rather than left asserting an adapter that no longer exists. The
 * property it protected is still covered above: an unknown or absent
 * `tracker.provider` is refused with a typed, actionable error.
 */
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

/**
 * Spec #139 / ticket #153 — the resolution unit assertions above prove
 * `resolveDelivery` keeps the key; these prove the key actually REACHES
 * `.poiesis/config.jsonc` through the two managed rewrites that serialize a
 * resolved config. A unit assertion alone would still pass if the write path
 * rebuilt the block from the known fields a second time.
 */
describe("delivery extension keys survive a managed init and update --config rewrite", () => {
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

  it("persists a configured delivery extension through a fresh init", async () => {
    restoreGh = await installFakeGh();
    const repository = await createTestRepository();
    repositories.push(repository);
    const delivery = { ...completeDelivery(), experimental: { note: "kept", retries: 2 } };
    await init(
      repository.root,
      { ...baseConfig(), tracker: { provider: "github", project: "owner/repo" }, delivery },
      { skipSkills: true },
    );
    const written = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(written).delivery).toEqual(delivery);
  }, 90_000);

  it("persists a deferred delivery extension through a fresh init", async () => {
    restoreGh = await installFakeGh();
    const repository = await createTestRepository();
    repositories.push(repository);
    const delivery: PoiesisConfig["delivery"] = { mode: DEFERRED_DELIVERY_MODE, experimental: { note: "kept" } };
    await init(
      repository.root,
      { ...baseConfig(), tracker: { provider: "github", project: "owner/repo" }, delivery },
      { skipSkills: true },
    );
    const written = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(written).delivery).toEqual(delivery);
  }, 90_000);

  it("persists a deferred delivery extension through update --config", async () => {
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

    const candidatePath = join(repository.parent, "extended-config.jsonc");
    const delivery: PoiesisConfig["delivery"] = { mode: DEFERRED_DELIVERY_MODE, experimental: { note: "kept" } };
    await writeFile(
      candidatePath,
      serializeConfig({
        ...baseConfig(),
        tracker: { provider: "github", project: "owner/repo" },
        delivery,
      }),
    );

    await updateFromConfig(repository.root, candidatePath);
    const written = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(written).delivery).toEqual(delivery);
  }, 90_000);

  it("persists a configured delivery extension through update --config", async () => {
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

    const candidatePath = join(repository.parent, "extended-configured.jsonc");
    const delivery = { ...completeDelivery(), note: "author annotation" };
    await writeFile(
      candidatePath,
      serializeConfig({
        ...baseConfig(),
        tracker: { provider: "github", project: "owner/repo" },
        delivery,
      }),
    );

    await updateFromConfig(repository.root, candidatePath);
    const written = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(written).delivery).toEqual(delivery);
  }, 90_000);
});

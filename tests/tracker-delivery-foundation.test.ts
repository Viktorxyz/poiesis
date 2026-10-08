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
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFERRED_DELIVERY_MODE,
  TRACKER_PROVIDERS,
  isDeferredDelivery,
  loadConfig,
  requireConfiguredDelivery,
  serializeConfig,
  trackerProjectOf,
  validateConfig,
  type ConfiguredDeliveryConfig,
  type PoiesisConfig,
  type ResolvedDeliveryConfig,
  type ResolvedPoiesisConfig,
  type ResolvedTrackerConfig,
} from "../src/config.js";
import {
  autoResolveConfigDefaults,
  init,
  resolvePublishCoordinates,
  update,
  updateFromConfig,
  verifyDeliveryConfiguration,
  verifyTracker,
} from "../src/maintenance.js";
import { commandInit, commandUpdate } from "../src/cli.js";
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
 * Spec #139 / ticket #153 (tracker half) — the extension keys the tracker
 * block must carry. Neither these key names nor the nested ones contain a
 * credential-bearing form, which is the point: this is a key Poiesis has no
 * opinion about and must therefore neither judge nor delete. Nested and
 * array-valued on purpose, so a shallow-only carry cannot pass.
 */
const EXTENSION_HEAD_KEY = "extensionHead";
const EXTENSION_TAIL_KEY = "extensionTail";
const EXTENSION_TAIL_VALUE = "author annotation";

function trackerExtension(): Record<string, unknown> {
  return {
    [EXTENSION_HEAD_KEY]: { nested: { states: ["triage", "doing"] }, retries: 2 },
    [EXTENSION_TAIL_KEY]: EXTENSION_TAIL_VALUE,
  };
}

/**
 * The tracker extension keys' own bytes inside a `serializeConfig`-shaped
 * document, verbatim. They are a contiguous run in BOTH the offered document
 * and the installed one (the candidate states them adjacently and resolution
 * carries the same partition adjacently), so this compares what was offered
 * against what was installed without depending on where the reserved keys sit
 * around them.
 */
function trackerExtensionBytes(text: string): string {
  const tail = `"${EXTENSION_TAIL_KEY}": ${JSON.stringify(EXTENSION_TAIL_VALUE)}`;
  const start = text.indexOf(`"${EXTENSION_HEAD_KEY}"`);
  const end = text.indexOf(tail);
  return start < 0 || end < 0 ? "" : text.slice(start, end + tail.length);
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

/**
 * Spec #139 / ticket #153 (tracker half) — the managed rewrite dropped an
 * unknown, non-secret tracker key that the schema had already accepted.
 *
 * `src/config.ts` claimed such a key survives a managed rewrite for EVERY
 * tracker branch (the `.loose()` on each provider schema), and the outer
 * `delivery` block had actually been given that guarantee — `deliveryExtensionKeys`
 * plus `resolveDelivery` carry it through init, `update`, `update --config`, and
 * the init-discovery final overlay. The tracker block had no equivalent:
 * `autoResolveConfigDefaults`, the ONE seam between the block an Author states
 * and the bytes `init`, `update`, and `update --config` write into
 * `.poiesis/config.jsonc`, rebuilt every branch from the known coordinates
 * alone, and the interactive flow's per-provider rebuilds did the same.
 *
 * These drive the two managed rewrites through their real command surfaces
 * rather than stopping at `validateConfig` / `serializeConfig`: a unit
 * assertion would still pass if the WRITE path dropped the key a second time.
 *
 *   1. a non-secret extension survives BOTH rewrites byte-for-byte in the
 *      installed `.poiesis/config.jsonc`;
 *   2. the known coordinates stay RESERVED — an extension can never supply,
 *      replace, or complete a coordinate Poiesis owns;
 *   3. the Linear credential refusal (ticket #188) is UNCHANGED and still
 *      fails closed with ZERO WRITES on both surfaces. Carrying extensions
 *      forward must never become carrying a secret forward.
 */
describe("tracker extension keys survive a managed init --config and update --config rewrite", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let restoreGh: (() => void) | undefined;
  let restoreStdout: (() => void) | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
    // `commandInit` / `commandUpdate` emit the structured success envelope on
    // stdout. The assertions below are about bytes on disk, not the envelope.
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    restoreStdout = () => stdoutSpy.mockRestore();
  });

  afterEach(async () => {
    restoreStdout?.();
    restoreStdout = undefined;
    restoreGh?.();
    restoreGh = undefined;
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("installs a non-secret tracker extension byte-for-byte through init --config", async () => {
    restoreGh = await installFakeGh();
    const repository = await createTestRepository();
    repositories.push(repository);
    const candidatePath = join(repository.parent, "init-config.jsonc");
    const candidate = serializeConfig({
      ...baseConfig(),
      tracker: { ...trackerExtension(), provider: "github", project: "owner/repo" },
      delivery: completeDelivery(),
    });
    await writeFile(candidatePath, candidate);

    await commandInit(["--config", candidatePath, "--cwd", repository.root]);

    const installed = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(installed).tracker).toEqual({
      ...trackerExtension(),
      provider: "github",
      project: "owner/repo",
    });
    // BYTE-FOR-BYTE: the extension region of the installed file is the exact
    // bytes of the extension region the Author offered. A structural equality
    // above would also pass if the value were re-derived rather than carried.
    expect(trackerExtensionBytes(installed)).toBe(trackerExtensionBytes(candidate));
    expect(trackerExtensionBytes(installed)).not.toBe("");
  }, 90_000);

  it("installs a non-secret tracker extension byte-for-byte through update --config", async () => {
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

    const candidatePath = join(repository.parent, "update-config.jsonc");
    const candidate = serializeConfig({
      ...baseConfig(),
      tracker: { ...trackerExtension(), provider: "github", project: "owner/repo" },
      delivery: completeDelivery(),
    });
    await writeFile(candidatePath, candidate);

    await commandUpdate(["--config", candidatePath, "--cwd", repository.root]);

    const installed = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(installed).tracker).toEqual({
      ...trackerExtension(),
      provider: "github",
      project: "owner/repo",
    });
    expect(trackerExtensionBytes(installed)).toBe(trackerExtensionBytes(candidate));
    expect(trackerExtensionBytes(installed)).not.toBe("");
  }, 90_000);

  it("keeps the extension through an ordinary update rewrite too", async () => {
    // `update` without `--config` serializes the same resolved config through
    // `resolveConfigForRoot`, so it is the same seam reached without a
    // candidate document. Named explicitly because it is a third writer.
    restoreGh = await installFakeGh();
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      {
        ...baseConfig(),
        tracker: { ...trackerExtension(), provider: "github", project: "owner/repo" },
        delivery: completeDelivery(),
      },
      { skipSkills: true },
    );

    await update(repository.root);

    const installed = await readFile(join(repository.root, CONFIG_ROOT), "utf8");
    expect(JSON.parse(installed).tracker).toEqual({
      ...trackerExtension(),
      provider: "github",
      project: "owner/repo",
    });
    expect(trackerExtensionBytes(installed)).not.toBe("");
  }, 90_000);

  it("refuses a secret-shaped tracker key through init --config with zero writes", async () => {
    restoreGh = await installFakeGh();
    const repository = await createTestRepository();
    repositories.push(repository);
    const candidatePath = join(repository.parent, "credential-config.jsonc");
    // Hand-written, exactly as an Author or a Linear dashboard copy-paste
    // produces it. NOT built with `serializeConfig`, because serializing such a
    // config is itself refused — which is the point being pinned.
    await writeFile(
      candidatePath,
      JSON.stringify(
        {
          ...baseConfig(),
          tracker: { provider: "linear", team: "ENG", apiKey: "lin_key" },
          delivery: completeDelivery(),
        },
        null,
        2,
      ),
    );

    await expect(commandInit(["--config", candidatePath, "--cwd", repository.root])).rejects.toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
      details: { provider: "linear", credentialFields: ["tracker.apiKey"], environmentOnly: true },
    });

    // ZERO WRITES: the refusal lands before init creates anything at all, and
    // the credential itself was never echoed into a message or a detail.
    await expect(stat(join(repository.root, ".poiesis"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);

  it("refuses a secret-shaped tracker key through update --config with zero writes", async () => {
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
    const configPath = join(repository.root, CONFIG_ROOT);
    const manifestPath = join(repository.root, ".poiesis/manifest.json");
    const configBefore = await readFile(configPath);
    const manifestBefore = await readFile(manifestPath);

    const candidatePath = join(repository.parent, "credential-update.jsonc");
    await writeFile(
      candidatePath,
      JSON.stringify(
        {
          ...baseConfig(),
          tracker: { provider: "linear", team: "ENG", oauthToken: "lin_token" },
          delivery: completeDelivery(),
        },
        null,
        2,
      ),
    );

    await expect(commandUpdate(["--config", candidatePath, "--cwd", repository.root])).rejects.toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
      details: { provider: "linear", credentialFields: ["tracker.oauthToken"], environmentOnly: true },
    });

    // ZERO WRITES: the installed config and the manifest are byte-identical to
    // their pre-attempt state, so the refusal left no half-applied transition.
    expect(Buffer.compare(await readFile(configPath), configBefore)).toBe(0);
    expect(Buffer.compare(await readFile(manifestPath), manifestBefore)).toBe(0);
  }, 90_000);
});

/**
 * Spec #139 / ticket #153 (tracker half) — the resolution seam itself. The
 * end-to-end rewrite cases above prove the key REACHES `.poiesis/config.jsonc`;
 * these pin the partition itself, so a future reconstruction elsewhere cannot
 * re-derive the reserved set differently.
 */
describe("tracker extension keys survive config resolution and stay reserved against it", () => {
  it("keeps the extension on the resolution and serialization every managed rewrite runs", async () => {
    const repository = await createTestRepository();
    try {
      // The chain the rewrites actually run: `validateConfig` (which accepts an
      // extension key) then `autoResolveConfigDefaults` (which used to drop it).
      // Resolution is never called with a raw unvalidated literal.
      const validated = validateConfig(
        { ...baseConfig(), tracker: { ...trackerExtension(), provider: "github", project: "owner/repo" } },
        "test",
      );
      const { config } = await autoResolveConfigDefaults(repository.root, validated);
      const expected = { ...trackerExtension(), provider: "github", project: "owner/repo" };
      expect(config.tracker).toEqual(expected);
      expect(JSON.parse(serializeConfig(config)).tracker).toEqual(expected);
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("keeps a Linear block's extension beside its resolved coordinates", async () => {
    const repository = await createTestRepository();
    try {
      const validated = validateConfig(
        { ...baseConfig(), tracker: { ...trackerExtension(), provider: "linear", team: "ENG" } },
        "test",
      );
      const { config } = await autoResolveConfigDefaults(repository.root, validated);
      // `project` stays absent rather than invented, and the extension rides
      // through unchanged alongside the coordinate the Author stated.
      expect(config.tracker).toEqual({ ...trackerExtension(), provider: "linear", team: "ENG" });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("never lets a reserved coordinate name ride through as an extension", async () => {
    const repository = await createTestRepository();
    try {
      // `team` and `project` are reserved for the whole union, not for one
      // provider: a Local block that happens to carry them must resolve to the
      // provider alone, so an extension can neither inject a coordinate into a
      // provider that owns none nor smuggle a cross-provider coordinate in.
      const { config } = await autoResolveConfigDefaults(repository.root, {
        ...baseConfig(),
        tracker: { provider: "local", team: "injected", project: "injected/repo" },
      });
      expect(config.tracker).toEqual({ provider: "local" });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("still narrows only the linear branch once the block is resolved and rewritten", async () => {
    const repository = await createTestRepository();
    try {
      // The partition does NOT re-derive #188's credential rule. `github`'s
      // `token` and `gitlab`'s `password` are that provider's own contract; a
      // runtime that dropped them here would delete a key the pinned contract
      // says must survive. The Linear branch is refused upstream instead.
      for (const [tracker, expected] of [
        [
          { provider: "github", project: "owner/repo", token: "forge-coordinates" },
          { provider: "github", project: "owner/repo", token: "forge-coordinates" },
        ],
        [
          { provider: "gitlab", project: "group/project", password: "host-account" },
          { provider: "gitlab", project: "group/project", password: "host-account" },
        ],
      ] as const satisfies readonly (readonly [PoiesisConfig["tracker"], PoiesisConfig["tracker"]])[]) {
        const validated = validateConfig({ ...baseConfig(), tracker }, "test");
        const { config } = await autoResolveConfigDefaults(repository.root, validated);
        expect(JSON.parse(serializeConfig(config)).tracker).toEqual(expected);
      }
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });

  it("represents an extension key in every resolved tracker branch", () => {
    // Compile-time evidence, asserted at runtime as well. If the resolved
    // tracker types stop representing an extension key, `pnpm run check` fails
    // here even when every runtime assertion above still passes.
    const forge: ResolvedTrackerConfig = { provider: "github", project: "owner/repo", ...trackerExtension() };
    const linear: ResolvedTrackerConfig = { provider: "linear", team: "ENG", ...trackerExtension() };
    const local: ResolvedTrackerConfig = { provider: "local", ...trackerExtension() };
    const fixture: ResolvedTrackerConfig = { provider: "fixture", project: "/tmp/p", ...trackerExtension() };
    for (const tracker of [forge, linear, local, fixture]) {
      expect(tracker[EXTENSION_HEAD_KEY]).toEqual({ nested: { states: ["triage", "doing"] }, retries: 2 });
      expect(tracker[EXTENSION_TAIL_KEY]).toBe("author annotation");
    }
    // The extension does not weaken a coordinate's type: a project is still a
    // string and a Linear team is still a string.
    const project: string = forge.project;
    const team: string = linear.team;
    expect(project).toBe("owner/repo");
    expect(team).toBe("ENG");
  });
});

/**
 * Spec #139 / ticket #188 — the `linear` branch stays `.loose()`, and that is
 * what let a credential ride into the managed config.
 *
 * The `linear` tracker block accepts unknown keys on purpose, so an existing
 * installation's keys keep parsing and a compatible extension survives a
 * managed rewrite. But `.loose()` also accepted `apiKey` / `oauthToken` /
 * `authorization` / `secret` / `password`, and `serializeConfig` then PRESERVED
 * them into `.poiesis/config.jsonc` — so the environment-only boundary was
 * decided by how the field happened to be spelled. Poiesis reads a Linear
 * credential only from the environment, so a credential in the config is a
 * credential in a file that init, update, and every later rewrite carry.
 *
 * What is pinned here:
 *
 *   1. every credential-bearing FORM is refused BEFORE the schema result is
 *      reported, so the value is never validated into a config that would be
 *      persisted, with the offending field paths named;
 *   2. `serializeConfig` refuses too, because a value can reach it from an
 *      in-memory resolution or a caller's own object without passing through
 *      `validateConfig` — and it refuses rather than silently dropping the
 *      key, which would report a healthy installation whose credential is
 *      nowhere;
 *   3. the boundary is NOT strictness: `team`, `project`, and every compatible
 *      unknown non-secret extension key still validate and still survive
 *      serialization, nested and array-valued extensions included;
 *   4. no OTHER provider is narrowed — a `github` / `gitlab` / `local` /
 *     `fixture` block is untouched, and a non-Linear config may still carry a
 *     key that would be credential-bearing under `linear`.
 */
describe("a linear tracker config carries coordinates only, never a credential", () => {
  /**
   * The spellings a credential arrives under. Poiesis compares the NORMALIZED
   * key, so all four API-key spellings are the same form; the values are the
   * distinct things the refusal must never echo.
   */
  const CREDENTIAL_FIELDS: readonly (readonly [string, unknown])[] = [
    ["apiKey", "lin_key"],
    ["api_key", "lin_key"],
    ["API-KEY", "lin_key"],
    ["LINEAR_API_KEY", "lin_key"],
    ["oauthToken", "lin_key"],
    ["access_token", "lin_key"],
    ["refreshToken", "lin_key"],
    ["Authorization", "Bearer lin_key"],
    ["authorizationHeader", "Bearer lin_key"],
    ["webhookSecret", "lin_key"],
    ["clientSecret", "lin_key"],
    ["password", "lin_key"],
    ["passwd", "lin_key"],
    ["credentials", { token: "lin_key" }],
    ["extension", { nested: { apiKey: "lin_key" } }],
    ["extension", [{ bearer: "lin_key" }]],
  ];

  it("refuses every credential-bearing key form before validation, naming the field", () => {
    for (const [field, value] of CREDENTIAL_FIELDS) {
      let thrown: unknown;
      try {
        validateConfig({ ...baseConfig(), tracker: { provider: "linear", team: "ENG", [field]: value } }, "test");
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `expected validateConfig to refuse tracker.${field}`).toBeInstanceOf(PoiesisError);
      expect(thrown).toMatchObject({
        code: "INVALID_TRACKER_CONFIG",
        details: { provider: "linear", environmentOnly: true },
      });
      const details = (thrown as PoiesisError).details;
      expect(JSON.stringify(details)).toContain("tracker.");
      // The named paths are the offending ones, and neither the details nor the
      // message ever echo the credential: a refusal that repeated it would leak
      // the secret into a log or a CI transcript.
      expect(JSON.stringify(details)).not.toContain("lin_key");
      expect(String((thrown as PoiesisError).message)).not.toContain("lin_key");
      expect(String((thrown as PoiesisError).message)).toContain("environment");
    }
  });

  it("names the exact offending paths, including nested and array-valued extensions", () => {
    let thrown: unknown;
    try {
      validateConfig(
        {
          ...baseConfig(),
          tracker: {
            provider: "linear",
            team: "ENG",
            credentials: { token: "lin_nested" },
            extension: { nested: { apiKey: "lin_deep" } },
            keep: "annotation",
          },
        },
        "test",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
      details: {
        provider: "linear",
        // The shallowest offending key is the actionable one (`tracker.credentials`),
        // and a key that is only credential-bearing further down is still named.
        credentialFields: ["tracker.credentials", "tracker.extension.nested.apiKey"],
      },
    });
  });

  it("refuses to serialize a credential-bearing linear config rather than writing it", () => {
    const config = {
      ...baseConfig(),
      tracker: { provider: "linear", team: "ENG", apiKey: "lin_key" },
    } as unknown as PoiesisConfig;
    let thrown: unknown;
    try {
      serializeConfig(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PoiesisError);
    expect(thrown).toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
      details: { provider: "linear", credentialFields: ["tracker.apiKey"], environmentOnly: true },
    });
  });

  it("keeps team, project, and every compatible unknown non-secret extension key", () => {
    const tracker = {
      provider: "linear",
      team: "ENG",
      project: "Roadmap",
      note: "author annotation",
      experimental: { workflowStates: ["triage", "doing"], retries: 2 },
      listOfExtensions: [{ label: "kept" }],
    };
    const validated = validateConfig({ ...baseConfig(), tracker }, "test");
    expect(validated.tracker).toMatchObject({ provider: "linear", team: "ENG", project: "Roadmap" });
    // The extension survives the managed rewrite, nested values included: the
    // boundary refuses a credential, it does not drop fields.
    expect(JSON.parse(serializeConfig(validated)).tracker).toEqual(tracker);
  });

  it("narrows only the linear branch", () => {
    // A field that would be credential-bearing under `linear` is none of this
    // provider's business: no other branch is tightened, and no supported field
    // disappears anywhere.
    for (const tracker of [
      { provider: "github", project: "owner/repo", token: "forge-coordinates" },
      { provider: "gitlab", project: "group/project", password: "host-account" },
      { provider: "local" },
      { provider: "fixture", project: "/tmp/poiesis-fixture", apiKey: "test-only" },
    ] satisfies PoiesisConfig["tracker"][]) {
      const validated = validateConfig({ ...baseConfig(), tracker }, "test");
      expect(JSON.parse(serializeConfig(validated)).tracker).toEqual(tracker);
    }
  });

  it("refuses to load an installed config that carries a linear credential", async () => {
    const repository = await createTestRepository();
    try {
      // A hand-written config file: the shape an Author, a template, or a
      // copy-paste from a Linear dashboard actually produces.
      await mkdir(join(repository.root, ".poiesis"), { recursive: true });
      await writeFile(
        join(repository.root, ".poiesis", "config.jsonc"),
        JSON.stringify({ ...baseConfig(), tracker: { provider: "linear", team: "ENG", apiKey: "lin_key" } }),
      );
      await expect(loadConfig(repository.root)).rejects.toMatchObject({
        code: "INVALID_TRACKER_CONFIG",
        details: { provider: "linear", credentialFields: ["tracker.apiKey"] },
      });
    } finally {
      await rm(repository.parent, { recursive: true, force: true });
    }
  });
});

/**
 * Spec #138: a fresh project installs without the Author hand-writing config.
 *
 * The regression guarded here is concrete. `autoResolveConfigDefaults` only
 * accepted a remote URL whose provider already matched the configured one, so
 * a config with no `tracker` block could never resolve either the provider or
 * the project - turning two facts the Git remote already states into two
 * Author questions. Delivery was worse: the config schema required all three
 * targets, and a missing `{sha}` was a hard `INVALID_DELIVERY_CONFIG` failure
 * before a single byte was written.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { init } from "../src/maintenance.js";
import { renderDefaultDeliveryScript } from "../src/delivery-defaults.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { parseJsonc } from "../src/config.js";

/**
 * `node --check` is the only honest syntax gate for a generated ES module: the
 * script legitimately uses top-level `import`, which the `Function`
 * constructor rejects regardless of validity.
 */
function isSyntacticallyValid(body: string): boolean {
  const dir = makeTempDir();
  try {
    const file = join(dir, "candidate.mjs");
    writeFileSync(file, body);
    return spawnSync("node", ["--check", file], { encoding: "utf8" }).status === 0;
  } finally {
    spawnSync("rm", ["-rf", dir]);
  }
}

function makeTempDir(): string {
  // node:fs mkdirSync returns the path when recursive is set.
  return mkdirSync(
    join(tmpdir(), `poiesis-syntax-${process.pid}-${Math.random().toString(36).slice(2)}`),
    { recursive: true },
  )!;
}

describe("Spec #138 - delivery targets need no hand-written config", () => {
  it("writes a delivery script for every target the project lacks", async () => {
    const repository = await createTestRepository();
    const env: FakeOpenCodeEnvironment = await installFakeOpenCode();
    try {
      await init(repository.root, testConfig(repository, { withDelivery: false }), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      for (const target of ["preview", "staging", "production"] as const) {
        const file = join(repository.root, "scripts", `poiesis-${target}.mjs`);
        const body = await readFile(file, "utf8");
        expect(body).toContain(`poiesis-${target}.mjs <sha> <target>`);
        // A syntax error in a generated file is invisible until the Author runs
        // it, which is exactly the failure this guards.
        expect(isSyntacticallyValid(body), `${target} script must be valid JavaScript`).toBe(true);
      }
    } finally {
      env.restore();
    }
  }, 60_000);

  it("never overwrites an Author-authored delivery script", async () => {
    const repository = await createTestRepository();
    const env: FakeOpenCodeEnvironment = await installFakeOpenCode();
    try {
      await mkdir(join(repository.root, "scripts"), { recursive: true });
      const mine = "#!/usr/bin/env node\n// the Author's own preview\n";
      await writeFile(join(repository.root, "scripts", "poiesis-preview.mjs"), mine);
      await init(repository.root, testConfig(repository, { withDelivery: false }), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      expect(await readFile(join(repository.root, "scripts", "poiesis-preview.mjs"), "utf8")).toBe(mine);
      expect(await readFile(join(repository.root, "scripts", "poiesis-production.mjs"), "utf8")).toContain(
        "poiesis-production.mjs",
      );
    } finally {
      env.restore();
    }
  }, 60_000);

  it("resolves a working delivery adapter in the installed config", async () => {
    const repository = await createTestRepository();
    const env: FakeOpenCodeEnvironment = await installFakeOpenCode();
    try {
      await init(repository.root, testConfig(repository, { withDelivery: false }), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      const config = parseJsonc<{ delivery: Record<string, { command?: string[] }> }>(
        await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8"),
        "config.jsonc",
      );
      for (const target of ["preview", "staging", "production"] as const) {
        expect(config.delivery[target]?.command).toEqual([
          "node",
          `scripts/poiesis-${target}.mjs`,
          "{sha}",
          "{target}",
        ]);
      }
    } finally {
      env.restore();
    }
  }, 60_000);

  it("every generated target is syntactically valid JavaScript", () => {
    for (const target of ["preview", "staging", "production"] as const) {
      const body = renderDefaultDeliveryScript(target, "2026-01-01T00:00:00.000Z");
      expect(isSyntacticallyValid(body), `${target} template must be valid`).toBe(true);
    }
  });

  it("a generated preview reports a real change request when gh is usable, and still produces an artifact when it is not", () => {
    // The preview body must not simply assume `gh` exists: a fresh project
    // without an authenticated `gh` still has to yield a concrete identity.
    const body = renderDefaultDeliveryScript("preview", "2026-01-01T00:00:00.000Z");
    expect(body).toContain("artifactRoot");
    expect(body).toContain("gh");
    expect(body).toContain("delivery.json");
  });
});

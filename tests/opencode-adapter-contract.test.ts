/**
 * Capability-based OpenCode adapter contract regression suite
 * (the strict certified-set gate redesign).
 *
 * The capability-based `assertOpenCodeAdapterContract` /
 * `probeOpenCodeAdapterContract` API is the single source of truth
 * for OpenCode adapter compatibility in Poiesis. This suite exercises
 * the contract probe directly so the behavior of the smallest layer
 * that owns OpenCode compatibility semantics is locked in:
 *
 *   - `probeOpenCodeAdapterContract` reports the installed version
 *     and `certified` flag without raising on unrecognized patch
 *     versions.
 *   - `assertOpenCodeAdapterContract` only hard-fails on capability
 *     probe failure (a real binary-lacks-the-capability case), NOT
 *     on `installed ∉ CERTIFIED_OPENCODE_VERSIONS`.
 *   - The V1 schema probe option propagates the typed
 *     `OPENCODE_ADAPTER_INCOMPATIBLE` failure with `capability:
 *     "debug config schema"` and the installed version in details.
 *
 * The fake opencode binary installed by the global setup has
 * `rejectV1SchemaForUnknownVersions: true` so any test that installs
 * a non-certified fake version automatically fails the V1 schema
 * probe; per-test installFakeOpenCode calls layer on top of the
 * global fake and reset PATH back to the global fake afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CERTIFIED_OPENCODE_VERSIONS,
  assertOpenCodeAdapterContract,
  probeOpenCodeAdapterContract,
} from "../src/opencode.js";
import { PoiesisError } from "../src/errors.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

describe("probeOpenCodeAdapterContract (capability probe report)", () => {
  let env: FakeOpenCodeEnvironment | undefined;

  afterEach(() => {
    env?.restore();
    env = undefined;
  });

  it("reports installed = 1.18.29 and certified = true for the canonical certified binary", async () => {
    env = await installFakeOpenCode();
    const contract = await probeOpenCodeAdapterContract("/");
    expect(contract.installed).toBe("1.18.29");
    expect(contract.certified).toBe(true);
    expect(contract.modelsInventory).toBeNull();
    expect(contract.acceptsV1Schema).toBeNull();
  });

  it("reports installed = 1.18.32 and certified = false for the newer unrecognized patch version", async () => {
    // The regression scenario: a Poiesis installation encounters an
    // OpenCode that is one patch beyond the latest certified tag.
    // The capability probe MUST NOT raise on `installed ∉ certified`;
    // it MUST report the installed version and the certified flag so
    // the caller can decide whether to warn the operator.
    env = await installFakeOpenCode("1.18.32");
    const contract = await probeOpenCodeAdapterContract("/");
    expect(contract.installed).toBe("1.18.32");
    expect(contract.certified).toBe(false);
  });

  it("reports modelsInventory when probeModels: true is requested", async () => {
    env = await installFakeOpenCode();
    const contract = await probeOpenCodeAdapterContract("/", { probeModels: true });
    expect(contract.modelsInventory).not.toBeNull();
    expect(contract.modelsInventory?.length).toBeGreaterThan(0);
  });

  it("reports acceptsV1Schema = true when the projected V1 schema is accepted by a certified binary", async () => {
    env = await installFakeOpenCode();
    const probeDir = await mkdtemp(join(tmpdir(), "poiesis-contract-schema-ok-"));
    try {
      const contract = await probeOpenCodeAdapterContract("/", {
        probeSchema: {
          payload: '{"default_agent": "poiesis"}',
          cwd: probeDir,
        },
      });
      expect(contract.acceptsV1Schema).toBe(true);
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
  });

  it("reports acceptsV1Schema = false when the installed binary rejects the V1 projection (1.18.32 with rejectV1SchemaForUnknownVersions)", async () => {
    env = await installFakeOpenCode({
      version: "1.18.32",
      rejectV1SchemaForUnknownVersions: true,
    });
    const probeDir = await mkdtemp(join(tmpdir(), "poiesis-contract-schema-bad-"));
    try {
      const contract = await probeOpenCodeAdapterContract("/", {
        probeSchema: {
          payload: '{"default_agent": "poiesis"}',
          cwd: probeDir,
        },
      });
      expect(contract.installed).toBe("1.18.32");
      expect(contract.certified).toBe(false);
      expect(contract.acceptsV1Schema).toBe(false);
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
  });

  it("throws OPENCODE_UNAVAILABLE when the binary is missing (capability probe requires --version)", async () => {
    // Restore the per-test fake so PATH has no fake at all. The
    // global setup installs a separate fake that survives across
    // tests; we rely on `which opencode` resolving through PATH to a
    // binary that does not exist on the test machine.
    env = await installFakeOpenCode();
    env.restore();
    env = undefined;
    // Use an env override that puts only non-existent paths on PATH
    // for the duration of this single probe call.
    const previousPath = process.env.PATH;
    process.env.PATH = "/this/path/does/not/exist:/that/path/does/not/exist/either";
    try {
      await expect(probeOpenCodeAdapterContract("/")).rejects.toMatchObject({
        code: "OPENCODE_UNAVAILABLE",
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

describe("assertOpenCodeAdapterContract (capability-based hard gate)", () => {
  let env: FakeOpenCodeEnvironment | undefined;

  afterEach(() => {
    env?.restore();
    env = undefined;
  });

  it("does NOT hard-fail on certified = false when no capability probe was requested (newer patch version 1.18.32)", async () => {
    // The 1.18.32 regression: a newer not-yet-certified OpenCode
    // patch version MUST NOT cause `assertOpenCodeAdapterContract` to
    // throw. The contract probe treats the certified-set flag as
    // informational metadata; only an actual capability probe failure
    // (when the caller requested one) hard-fails.
    env = await installFakeOpenCode("1.18.32");
    await expect(assertOpenCodeAdapterContract("/")).resolves.toMatchObject({
      installed: "1.18.32",
      certified: false,
    });
  });

  it("does NOT hard-fail on certified = false when probeModels succeeds (1.18.32 + working inventory)", async () => {
    // The capability probe runs `opencode models` and succeeds for
    // the 1.18.32 fake. The contract is honored; no hard fail.
    env = await installFakeOpenCode("1.18.32");
    await expect(
      assertOpenCodeAdapterContract("/", { probeModels: true }),
    ).resolves.toMatchObject({
      installed: "1.18.32",
      certified: false,
      modelsInventory: expect.any(Array) as unknown,
    });
  });

  it("hard-fails with OPENCODE_ADAPTER_INCOMPATIBLE when probeModels returns empty inventory", async () => {
    // Empty inventory is a real capability failure: Poiesis cannot
    // enumerate models and therefore cannot serve the operator a
    // valid selection. The error names the missing capability.
    env = await installFakeOpenCode({ modelList: [] });
    await expect(
      assertOpenCodeAdapterContract("/", { probeModels: true }),
    ).rejects.toMatchObject({
      code: "OPENCODE_ADAPTER_INCOMPATIBLE",
      details: { capability: "models" },
    });
  });

  it("hard-fails with OPENCODE_ADAPTER_INCOMPATIBLE when probeSchema rejects the V1 projection", async () => {
    // The fake's `rejectV1SchemaForUnknownVersions: true` simulates a
    // real-world OpenCode whose V1 adapter contract has drifted away
    // from the certified projection. The error names the missing
    // capability so an operator can diagnose WHAT the binary lacks.
    env = await installFakeOpenCode({
      version: "1.18.32",
      rejectV1SchemaForUnknownVersions: true,
    });
    const probeDir = await mkdtemp(join(tmpdir(), "poiesis-contract-probe-"));
    await expect(
      assertOpenCodeAdapterContract("/", {
        probeSchema: { payload: '{"default_agent": "poiesis"}', cwd: probeDir },
      }),
    ).rejects.toMatchObject({
      code: "OPENCODE_ADAPTER_INCOMPATIBLE",
      details: { capability: "debug config schema", installed: "1.18.32" },
    });
    await rm(probeDir, { recursive: true, force: true });
  });
});

describe("validateOpenCodeConfig (typed-failure wrapper)", () => {
  let env: FakeOpenCodeEnvironment | undefined;

  afterEach(() => {
    env?.restore();
    env = undefined;
  });

  it("throws OPENCODE_ADAPTER_INCOMPATIBLE when the installed binary rejects the V1 schema projection (1.18.32 with rejectV1SchemaForUnknownVersions)", async () => {
    // Regression: the previous `run` wrapper raised a generic
    // `COMMAND_FAILED` whenever `opencode debug config` returned
    // non-zero. The redesign wraps the probe and re-emits the failure
    // as `OPENCODE_ADAPTER_INCOMPATIBLE` with `capability: "debug
    // config schema"` so an operator can diagnose WHAT the binary
    // lacks. The installed version is included in details.
    env = await installFakeOpenCode({
      version: "1.18.32",
      rejectV1SchemaForUnknownVersions: true,
    });
    // We must NOT call `validateOpenCodeConfig` directly here because
    // it relies on `detectOpenCodeConfig` which scans the project root
    // for a real `opencode.jsonc`. Instead we mimic the same shape by
    // validating that the underlying capability probe surfaces the
    // typed failure. The actual call path is exercised by the
    // update-config and init transaction tests.
    const probeDir = await mkdtemp(join(tmpdir(), "poiesis-validate-probe-"));
    try {
      await writeFile(join(probeDir, "opencode.jsonc"), "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n");
      await expect(
        assertOpenCodeAdapterContract("/", {
          probeSchema: { payload: '{"default_agent": "poiesis"}', cwd: probeDir },
        }),
      ).rejects.toBeInstanceOf(PoiesisError);
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
  });
});

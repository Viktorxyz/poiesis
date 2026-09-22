/**
 * `poiesis model` regression suite for the `1.18.32` newer
 * unrecognized patch scenario.
 *
 * Acceptance contract (the user's report, distilled):
 *
 *   1. `poiesis model set <class> <id>` MUST NOT fail-closed just
 *      because the installed OpenCode is one patch beyond the latest
 *      certified tag (e.g. `1.18.32` while the certified set ends at
 *      `1.18.31`). The capability probe passes; the operation must
 *      proceed.
 *   2. The "newer than latest certified compatibility" warning is
 *      a CLI / interactive-flow concern. It MUST be emitted on the
 *      Author-visible stderr stream between the successful selection
 *      and the restart notice, naming the installed version AND the
 *      latest certified tag. The warning lives in the interactive
 *      flow, NOT in the structured `SetModelResult`.
 *   3. The chosen model MUST still be validated against the live
 *      inventory; if the operator picks a model that does not exist
 *      in the inventory, `setModel` MUST still reject with the
 *      existing `MODEL_UNAVAILABLE` code.
 *   4. The OpenCode config schema probe (via `validateOpenCodeConfig`
 *      inside the transaction) MUST still catch real schema
 *      incompatibility: when the fake's `rejectV1SchemaForUnknownVersions`
 *      flag simulates a real-world binary that rejects the V1
 *      projection, `setModel` MUST fail closed with
 *      `OPENCODE_ADAPTER_INCOMPATIBLE` — not a generic `COMMAND_FAILED`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  init,
  setModel,
  type ModelClassName,
} from "../src/maintenance.js";
import {
  CERTIFIED_OPENCODE_VERSIONS,
} from "../src/opencode.js";
import { loadManifest, type Manifest } from "../src/manifest.js";
import { parseJsonc, type PoiesisConfig } from "../src/config.js";
import { ownershipReceiptLocation, readOwnershipReceipt } from "../src/receipt.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const CONFIG_ROOT = ".poiesis/config.jsonc";

async function install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function readPoiesisConfig(repository: TestRepository): Promise<PoiesisConfig> {
  return parseJsonc<PoiesisConfig>(
    await readFile(join(repository.root, CONFIG_ROOT), "utf8"),
    join(repository.root, CONFIG_ROOT),
  );
}

describe("setModel on OpenCode 1.18.32 (newer unrecognized patch)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    // 1.18.32 is the regression scenario. The fake's `rejectV1Schema`
    // flag stays off so the V1 projection probe passes — the goal is
    // to assert that `setModel` proceeds and surfaces the warning,
    // NOT to assert that `setModel` fails closed (that is a separate
    // regression test below).
    env = await installFakeOpenCode("1.18.32");
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("changes the reasoning class on 1.18.32 (the capability probe governs success; the warning is a CLI concern, not part of the result)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);

    const result = await setModel(repository.root, "reasoning", "openai/gpt-5.6-fallback");

    // The mutation landed on disk.
    const afterConfig = await readPoiesisConfig(repository);
    expect(afterConfig.models.reasoning).toBe("openai/gpt-5.6-fallback");

    // The result is the structured `SetModelResult` (no terminal-message
    // string). The "newer than latest certified compatibility" notice
    // is a CLI / interactive-flow concern, emitted by `model-interactive`
    // after `setModel` returns. Programmatic callers who need the
    // certified flag can probe `probeOpenCodeAdapterContract`
    // separately.
    expect(result.restart).toEqual({
      notice: expect.stringMatching(/restart/i) as unknown,
      started: false,
    });

    // The manifest records the durable install state on 1.18.32. The
    // Poiesis-owned adapter contract (certified set) is independent of
    // what the operator runs locally — the manifest records the
    // certified set as it was at install time.
    const manifest = await loadManifest(repository.root);
    expect(manifest.adapter.supportedVersions).toEqual([...CERTIFIED_OPENCODE_VERSIONS]);
    expect(manifest.adapter.supportedVersion).toBe("1.18.29");

    // Doctor still reports the newer-not-certified state as `warn`
    // (informational metadata, not a hard failure).
    const opencodeVersion = result.doctor.checks.find((check) => check.id === "opencode-version");
    expect(opencodeVersion?.status).toBe("warn");
    expect(opencodeVersion?.details).toMatchObject({ installed: "1.18.32" });

    // Receipt generation advanced exactly once.
    const receipt = await readOwnershipReceipt(repository.root);
    expect(receipt.generation).toBe(2);
  }, 30_000);

    it("changes the execution class on 1.18.32 (the warning is emitted by the CLI/interactive layer, not the result)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);

    const result = await setModel(repository.root, "execution", "minimax/MiniMax-M3-alt");

    const afterConfig = await readPoiesisConfig(repository);
    expect(afterConfig.models.execution).toBe("minimax/MiniMax-M3-alt");
    // `versionWarning` was deliberately removed from `SetModelResult`
    // — the warning is the CLI / interactive-flow concern, not the
    // operation's structured result.
    expect((result as { versionWarning?: unknown }).versionWarning).toBeUndefined();
  }, 30_000);

    it("rejects with MODEL_UNAVAILABLE on 1.18.32 when the chosen ID is not in the live inventory (chosen-model validation is unchanged)", async () => {
    // Real-world capability still applies: if the operator picks a
    // model that is not in the live inventory, `setModel` MUST still
    // fail closed with MODEL_UNAVAILABLE. The newer-patch-version
    // path does NOT silently substitute or silently accept.
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforePoiesis = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeManifest = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceipt = await readFile(receiptPath);

    await expect(
      setModel(repository.root, "execution", "minimax/not-in-inventory"),
    ).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      details: { missing: ["minimax/not-in-inventory"] },
    });

    // No bytes mutated.
    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforePoiesis)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifest)).toBe(0);
    expect(Buffer.compare(await readFile(receiptPath), beforeReceipt)).toBe(0);
  }, 30_000);

  it("does NOT surface a warning on 1.18.31 (the latest certified tag) — the probe reports certified = true", async () => {
    // Boundary check: when the installed version IS on the certified
    // set, the capability probe reports `certified: true` so neither
    // `setModel` nor the CLI / interactive flow emits a warning.
    env?.restore();
    env = await installFakeOpenCode("1.18.31");
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);

    const { probeOpenCodeAdapterContract } = await import("../src/opencode.js");
    const contract = await probeOpenCodeAdapterContract(repository.root);
    expect(contract.certified).toBe(true);
  }, 30_000);

    it("hard-fails with OPENCODE_ADAPTER_INCOMPATIBLE when the 1.18.32 binary rejects the V1 schema projection", async () => {
    // The capability-based safety boundary still applies on a
    // newer-not-certified version: when the binary actually rejects
    // the V1 projection, the operation must fail closed with a typed
    // failure that names the missing capability. This is the
    // safety-net side of the same probe that emits the warning on
    // success — the warning is INFORMATIONAL, the capability probe
    // is the safety boundary.
    //
    // Install the repository first with the canonical `1.18.29`
    // certified fake so `init` succeeds. Then layer the 1.18.32 +
    // `rejectV1SchemaForUnknownVersions` fake on top of PATH so the
    // `update --config` transaction inside `setModel` hits the
    // rejecting binary.
    env?.restore();
    env = await installFakeOpenCode();
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    env.restore();
    env = await installFakeOpenCode({
      version: "1.18.32",
      rejectV1SchemaForUnknownVersions: true,
    });
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const beforePoiesis = await readFile(join(repository.root, CONFIG_ROOT));
    const beforeManifest = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const beforeReceipt = await readFile(receiptPath);

    await expect(
      setModel(repository.root, "execution", "minimax/MiniMax-M3-alt"),
    ).rejects.toMatchObject({
      code: "OPENCODE_ADAPTER_INCOMPATIBLE",
      details: { installed: "1.18.32", capability: "debug config schema" },
    });

    expect(Buffer.compare(await readFile(join(repository.root, CONFIG_ROOT)), beforePoiesis)).toBe(0);
    expect(Buffer.compare(await readFile(join(repository.root, ".poiesis", "manifest.json")), beforeManifest)).toBe(0);
    expect(Buffer.compare(await readFile(receiptPath), beforeReceipt)).toBe(0);
  }, 30_000);
});

describe("doctor on OpenCode 1.18.32 (newer unrecognized patch)", () => {
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode("1.18.32");
  });

  afterEach(async () => {
    env?.restore();
  });

  it("reports opencode-version as warn with installed + latestCertified details (not as fail)", async () => {
    // Regression: the previous `doctor` opencode-version check used
    // the strict certified-set gate, which raised
    // `OPENCODE_VERSION_UNSUPPORTED` on `1.18.32` and reported
    // status: "fail". The redesign reports the newer-not-certified
    // state as status: "warn" with details naming the installed
    // version and the latest certified tag, so `doctor.ok` (which
    // gates on `status === "fail"`) is preserved for unrelated
    // fail-closed failures while the newer-patch version surfaces a
    // clear informational notice.
    const repository = await createTestRepository();
    const probeDir = await mkdtemp(join(tmpdir(), "poiesis-doctor-11832-"));
    try {
      // We cannot easily install a real Poiesis against a 1.18.32
      // binary (the install-time `validateOpenCodeConfigPayload`
      // would call `opencode debug config` which the fake does not
      // gate against `1.18.32` here, so init would succeed). The
      // capability-based `opencode-version` check is observable from
      // `doctor`'s output once a manifest is present. We synthesize a
      // bare Poiesis install on the certified set first (init still
      // uses 1.18.29 because that's the global fake's default
      // version), then swap to the 1.18.32 fake and re-run doctor.
      env?.restore();
      env = await installFakeOpenCode();
      await init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      env?.restore();
      env = await installFakeOpenCode("1.18.32");

      const { doctor } = await import("../src/maintenance.js");
      const report = await doctor(repository.root);
      const opencodeVersion = report.checks.find((check) => check.id === "opencode-version");
      expect(opencodeVersion?.status).toBe("warn");
      expect(opencodeVersion?.message.toLowerCase()).toContain("newer");
      expect(opencodeVersion?.details).toMatchObject({
        installed: "1.18.32",
      });
      // `doctor.ok` is gated on `status === "fail"`, not on `warn`.
      // A missing-version capability (binary not on PATH, version
      // probe failure) still surfaces as `fail`; the
      // newer-not-certified state stays `warn` so unrelated doctor
      // regressions stay observable. The `skills` / `tracker` /
      // `delivery` checks may report `fail` here because init ran
      // with `skipSkills: true` and the test repo's tracker/delivery
      // are `fixture`; we explicitly assert the opencode-version check
      // and ignore unrelated check statuses.
      const failures = report.checks.filter((check) => check.status === "fail");
      expect(failures.map((check) => check.id)).not.toContain("opencode-version");
    } finally {
      await rm(repository.root, { recursive: true, force: true });
      await rm(probeDir, { recursive: true, force: true });
    }
  }, 60_000);
});


describe("runInteractiveModel on OpenCode 1.18.32 (newer unrecognized patch)", () => {
  // The interactive flow shares the `setModel` capability probe. The
  // warning is surfaced on the Author-visible stderr stream between
  // the successful selection and the restart notice so the operator
  // sees the version status BEFORE the generic restart-handling
  // block. We use the same scripted IO seam the existing interactive
  // suite uses.
  let env: FakeOpenCodeEnvironment | undefined;
  let repository: TestRepository | undefined;

  beforeEach(async () => {
    // Step 1: install the repo on the certified `1.18.29` so init
    // succeeds and the manifest is authoritative.
    env = await installFakeOpenCode();
    const { init } = await import("../src/maintenance.js");
    repository = await createTestRepository();
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    // Step 2: layer the `1.18.32` fake on top of PATH so the
    // interactive `setModel` call inside the flow probes the newer
    // version. The capability probe passes for `1.18.32` (no
    // `rejectV1SchemaForUnknownVersions`), so the warning fires but
    // the operation succeeds.
    env.restore();
    env = await installFakeOpenCode("1.18.32");
  });

  afterEach(async () => {
    env?.restore();
    if (repository) {
      await rm(repository.parent, { recursive: true, force: true });
      repository = undefined;
    }
  });

  it("surfaces the 'newer than latest certified compatibility' warning on stderr between selection and restart notice", async () => {
    const { runInteractiveModel } = await import("../src/model-interactive.js");
    const capturedStderr: string[] = [];
    const io = {
      isTTY: true,
      writeStderr(line: string) {
        capturedStderr.push(line);
      },
      listOpenCodeModels: async () => [
        "openai/gpt-5.6-sol",
        "openai/gpt-5.6-fallback",
        "minimax/MiniMax-M3",
        "minimax/MiniMax-M3-alt",
      ],
      runModelClassSelector: async () => "reasoning" as const,
      runModelSelector: async () => "openai/gpt-5.6-fallback",
      loadCurrentModels: async () => ({
        reasoning: "openai/gpt-5.6-sol",
        execution: "minimax/MiniMax-M3",
      }),
    };
    await runInteractiveModel({ root: repository!.root, io });

    const stderr = capturedStderr.join("");
    // The version warning MUST appear in the captured stderr BEFORE the
    // restart notice (Author sees the version status before the
    // generic restart-handling block).
    const warningIdx = stderr.indexOf("1.18.32");
    const restartIdx = stderr.toLowerCase().indexOf("restart");
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(restartIdx).toBeGreaterThan(warningIdx);
    // The latest certified tag is mentioned so the operator can
    // decide whether to keep going or pin the harness.
    expect(stderr).toContain(CERTIFIED_OPENCODE_VERSIONS[CERTIFIED_OPENCODE_VERSIONS.length - 1]);
  });
});

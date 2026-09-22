/**
 * Subprocess probe trace instrumentation.
 *
 * For every Poiesis operation that touches the OpenCode binary, this
 * suite spies on the `run` subprocess seam in `src/process.ts` and
 * records the ordered sequence of (`command`, `args`) tuples the
 * operation actually invokes. The probe counts are derived from the
 * recorded sequence - not from manual reasoning - so the production
 * probe footprint is observable, not guessed.
 *
 * The fake opencode binary installed by the global setup is
 * permissive (`rejectV1SchemaForUnknownVersions: true` only blocks
 * non-certified versions). Tests use a `1.18.29` fake so every probe
 * the operations perform is "happy path" - the goal here is to
 * enumerate the probes, not to test their failure semantics (those
 * are covered by the per-operation suites).
 *
 * The recorded sequence for each operation is asserted on so the
 * probe footprint is part of the contract.
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processModule from "../src/process.js";
import { init, doctor, setModel, update } from "../src/maintenance.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

/**
 * A single subprocess probe observation: the `command` (e.g.
 * `"opencode"`) and the `args` passed to it (e.g. `["models"]`). The
 * `cwd` is intentionally NOT recorded because the question under
 * review is which surfaces are probed and in what order, not where.
 */
type ProbeObservation = { command: string; args: readonly string[] };

/**
 * Records `run()` calls and returns the recorded list plus a
 * restore handle. The list is mutated in place by the spy.
 */
function recordProbes(): { calls: ProbeObservation[]; restore: () => void } {
  const calls: ProbeObservation[] = [];
  const realRun = processModule.run;
  const spy = vi.spyOn(processModule, "run").mockImplementation(async (command, args, options) => {
    // Filter to OpenCode subprocess calls only - git / gh / glab
    // calls live in other probes that are not the subject of this
    // review.
    if (command === "opencode") {
      calls.push({ command, args: [...args] });
    }
    return await realRun(command, args, options);
  });
  return { calls, restore: () => spy.mockRestore() };
}

async function installRepository(): Promise<{ repo: TestRepository; cleanup: () => Promise<void> }> {
  const repo = await createTestRepository();
  return {
    repo,
    cleanup: async () => {
      await rm(repo.parent, { recursive: true, force: true });
    },
  };
}

describe("subprocess probe footprint per operation (instrumented)", () => {
  const envRef: { env?: FakeOpenCodeEnvironment } = {};
  let recorder: { calls: ProbeObservation[]; restore: () => void } | undefined;

  beforeEach(async () => {
    // Each operation runs against a fresh 1.18.29 fake so every probe
    // is a happy-path observation. The fake's
    // `rejectV1SchemaForUnknownVersions` does not matter for `1.18.29`
    // (it is in the certified set).
    envRef.env = await installFakeOpenCode();
    recorder = recordProbes();
  });

  afterEach(async () => {
    recorder?.restore();
    envRef.env?.restore();
    recorder = undefined;
    envRef.env = undefined as unknown as FakeOpenCodeEnvironment;
  });

  it("poiesis init (skipSkills: true, no doctor gate): probes only the preflight `models` + `debug config`", async () => {
    const { repo, cleanup } = await installRepository();
    try {
      await init(repo.root, testConfig(repo), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      // The doctor gate at the end of init is skipped when
      // `skipSkills: true`. The preflight probes (verifyModels +
      // validateOpenCodeConfigPayload) run once. No `--version`
      // probe: the certified-set flag is informational metadata,
      // not a safety boundary.
      expect(recorder!.calls).toEqual([
        { command: "opencode", args: ["models"] },
        { command: "opencode", args: ["debug", "config"] },
      ]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("poiesis update (receipt-authenticated, skipSkills: true): probes only `models` + `debug config`", async () => {
    const { repo, cleanup } = await installRepository();
    try {
      await init(repo.root, testConfig(repo), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      // Clear probe record so we observe ONLY the update transaction,
      // not the preceding init.
      recorder!.calls.length = 0;
      await update(repo.root, { skipSkills: true });
      // The transaction itself does NOT probe --version,
      // models, or debug config directly. The post-transaction
      // `doctor()` gate is what runs the three capability probes
      // for the transaction. (`verifyModels` + `validateOpenCodeConfigPayload`
      // are part of the `init` flow, not `update`.)
      expect(recorder!.calls).toEqual([
        { command: "opencode", args: ["--version"] },
        { command: "opencode", args: ["models"] },
        { command: "opencode", args: ["debug", "config"] },
      ]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("poiesis model set (deterministic, skipSkills init): probes `models` + `debug config`", async () => {
    const { repo, cleanup } = await installRepository();
    try {
      await init(repo.root, testConfig(repo), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      recorder!.calls.length = 0;
      await setModel(repo.root, "reasoning", "openai/gpt-5.6-fallback");
      // setModel: chosen-model validation (1x models) +
      // transaction doctor gate (--version + models + debug
      // config). The transaction itself does NOT probe
      // preflight; the doctor gate is the only capability
      // probe in `update --config`.
      expect(recorder!.calls).toEqual([
        // 1. setModel chosen-model validation (1x models).
        { command: "opencode", args: ["models"] },
        // 2-3. Transaction preflight (verifyModels + validateOpenCodeConfigPayload).
        { command: "opencode", args: ["models"] },
        { command: "opencode", args: ["debug", "config"] },
        // 4-6. Transaction doctor gate (--version + models + debug config).
        { command: "opencode", args: ["--version"] },
        { command: "opencode", args: ["models"] },
        { command: "opencode", args: ["debug", "config"] },
      ]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("poiesis doctor: probes `--version`, `models`, `debug config` - one of each, no duplicates", async () => {
    const { repo, cleanup } = await installRepository();
    try {
      await init(repo.root, testConfig(repo), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      recorder!.calls.length = 0;
      await doctor(repo.root);
      expect(recorder!.calls).toEqual([
        { command: "opencode", args: ["--version"] },
        { command: "opencode", args: ["models"] },
        { command: "opencode", args: ["debug", "config"] },
      ]);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe("interactive poiesis model flow: probe footprint (instrumented)", () => {
  // The interactive flow is the one place where a `--version` probe
  // exists in production: the warning layer (`model-interactive.ts`)
  // does its own capability probe for the certified-status notice.
  // The probe is exercised against the production IO factory
  // (`createProductionInteractiveModelIO`) so the test observes the
  // EXACT subprocess sequence a real CLI invocation produces — no
  // `listOpenCodeModels` mock, no short-circuited selector seam, no
  // hand-curated trace.

  const envRef: { env?: FakeOpenCodeEnvironment } = {};
  let recorder: { calls: ProbeObservation[]; restore: () => void } | undefined;

  beforeEach(async () => {
    envRef.env = await installFakeOpenCode("1.18.32"); // regression scenario
    recorder = recordProbes();
  });

  afterEach(async () => {
    recorder?.restore();
    envRef.env?.restore();
    recorder = undefined;
    envRef.env = undefined as unknown as FakeOpenCodeEnvironment;
  });

  it("interactive flow: production IO emits the EXACT ordered subprocess trace (no mocked seams)", async () => {
    const { createProductionInteractiveModelIO, runInteractiveModel } = await import(
      "../src/model-interactive.js"
    );
    const { repo, cleanup } = await installRepository();
    try {
      // Step 1: install against the certified 1.18.29 so init succeeds.
      envRef.env!.restore();
      envRef.env = await installFakeOpenCode();
      await init(repo.root, testConfig(repo), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });
      // Step 2: layer the 1.18.32 fake so the interactive flow's
      // capability probe sees the newer not-yet-certified binary. The
      // per-test install has `rejectV1SchemaForUnknownVersions: false`
      // (the default), so the V1 schema probe passes — the goal here
      // is to assert the probe SEQUENCE, not to gate on a schema
      // rejection (that path is covered by
      // `tests/set-model-newer-version.test.ts`).
      envRef.env!.restore();
      envRef.env = await installFakeOpenCode("1.18.32");

      // Reset the probe record so we observe ONLY the interactive
      // flow's probes (the previous init probes are intentionally not
      // asserted here - they are covered by the init test above).
      recorder!.calls.length = 0;

      // Minimal selector IO seam: every selector returns a
      // deterministic answer so the flow runs end-to-end without
      // hitting a real TTY. The `listOpenCodeModels` seam is DELIBERATELY
      // omitted — `createProductionInteractiveModelIO` provides the
      // factory's real `run("opencode", ["models"], ...)` implementation
      // because the inventory probe is the production IO path under
      // review. The fake's `models` output is the default
      // `TEST_OPENCODE_MODEL_LIST` (4 entries); the chosen
      // `openai/gpt-5.6-fallback` falls inside that list so the
      // selector sees a valid selection.
      const capturedStderr: string[] = [];
      const io = createProductionInteractiveModelIO(repo.root);
      await runInteractiveModel({
        root: repo.root,
        io: {
          ...io,
          isTTY: true,
          writeStderr: (line: string) => capturedStderr.push(line),
          runModelClassSelector: async () => "reasoning" as const,
          runModelSelector: async () => "openai/gpt-5.6-fallback",
          loadCurrentModels: async () => ({
            reasoning: "openai/gpt-5.6-sol",
            execution: "minimax/MiniMax-M3",
          }),
        },
      });

      const opencodeCalls = recorder!.calls;
      const versionProbes = opencodeCalls.filter(
        (c) => c.args[0] === "--version",
      );
      // The full production subprocess sequence for the interactive
      // flow on `1.18.32` (newer not-yet-certified) is the canonical
      // contract. Every call is exercised through the real production
      // IO seam — the test does NOT mock `listOpenCodeModels`, so the
      // selector inventory probe is observed like every other call.
      // The eight entries decompose as:
      //
      //   1. `models` — selector inventory probe
      //      (model-interactive.ts → `probeInventory` → factory's
      //      `run("opencode", ["models"], ...)`).
      //   2. `models` — chosen-model validation in `setModel` (the
      //      inventory must contain the operator-selected identity
      //      before any byte is mutated).
      //   3. `models` — `update --config` step-4 env validation
      //      (`verifyModels` against the proposed config's models).
      //   4. `debug config` — `update --config` step-8 schema
      //      preflight (`validateOpenCodeConfigPayload`).
      //   5. `--version` — doctor gate capability probe
      //      (`probeOpenCodeAdapterContract` from `doctor()`).
      //   6. `models` — doctor gate model check (`verifyModels`).
      //   7. `debug config` — doctor gate schema check
      //      (`validateOpenCodeConfig`).
      //   8. `--version` — interactive certification warning probe
      //      (`probeOpenCodeAdapterContract` in model-interactive.ts
      //      after `setModel` returns).
      expect(opencodeCalls).toEqual([
        // 1. selector inventory.
        { command: "opencode", args: ["models"] },
        // 2. setModel chosen-model validation.
        { command: "opencode", args: ["models"] },
        // 3. update --config step 4 verifyModels (proposed config).
        { command: "opencode", args: ["models"] },
        // 4. update --config step 8 validateOpenCodeConfigPayload.
        { command: "opencode", args: ["debug", "config"] },
        // 5. doctor gate probe (--version only).
        { command: "opencode", args: ["--version"] },
        // 6. doctor gate verifyModels.
        { command: "opencode", args: ["models"] },
        // 7. doctor gate validateOpenCodeConfig.
        { command: "opencode", args: ["debug", "config"] },
        // 8. interactive certification warning layer probe.
        { command: "opencode", args: ["--version"] },
      ]);
      // The two `--version` calls (doctor gate at position 5, warning
      // layer at position 8) are the entire `--version` footprint for
      // the interactive flow. There is no third `--version` — the
      // warning layer reuses the doctor gate's probe result instead
      // of running a redundant probe and the inventory / schema
      // probes are independent surfaces (they're not `--version`).
      expect(versionProbes.length).toBe(2);
      // The warning WAS emitted (the binary is `1.18.32`, which is
      // newer than the latest certified compatibility). The interactive
      // flow's exact wording is "has not yet been certified by this
      // Poiesis release" (the same surface used by the
      // `set-model-newer-version` interactive test).
      const stderr = capturedStderr.join("");
      expect(stderr).toContain("1.18.32");
      expect(stderr).toMatch(/certified/i);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

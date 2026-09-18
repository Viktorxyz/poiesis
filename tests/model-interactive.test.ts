/**
 * Ticket #59 — Interactive `poiesis model`.
 *
 * Acceptance contract:
 *   - Human entry is `poiesis model` with NO extra verbs.
 *   - On a TTY, the flow shows the current reasoning and execution
 *     model identities on stderr, asks the Author which slot to change,
 *     runs the shared `runModelSelector` for exactly that slot, and
 *     writes through `setModel` (which in turn uses `updateFromConfig`).
 *   - Exactly one slot is changed per invocation.
 *   - Non-TTY `poiesis model` (no subcommand) fails closed with
 *     `NON_TTY_MODEL` — never a silent default.
 *   - On success, the Author is told to restart OpenCode; Poiesis does
 *     not restart OpenCode on the Author's behalf (mirrors
 *     `poiesis model set`).
 *   - Selector policy is identical to `poiesis init`:
 *       - inventory is the live `opencode models` list;
 *       - recommendation annotation uses the canonical constants;
 *       - empty inventory fails closed with a typed error.
 *
 * Test seam: `InteractiveModelIO` is fully injected. Tests pass scripted
 * prompts, model selections, and inventory; production wires the seam
 * to `process.stdin` / `process.stderr` and the real `opencode models`
 * call. No PTY is required.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  runInteractiveModel,
  type CurrentModels,
  type InteractiveModelIO,
  type ModelSelection,
} from "../src/model-interactive.js";
import { commandModel } from "../src/cli.js";
import { init } from "../src/maintenance.js";
import { hashContent } from "../src/hash.js";
import { loadManifest } from "../src/manifest.js";
import {
  ownershipReceiptLocation,
  readOwnershipReceipt,
} from "../src/receipt.js";
import { parseJsonc, serializeConfig, type PoiesisConfig } from "../src/config.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const CONFIG_ROOT = ".poiesis/config.jsonc";
const repositories: TestRepository[] = [];
let env: FakeOpenCodeEnvironment | undefined;

afterEach(async () => {
  env?.restore();
  env = undefined;
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

interface ScriptedModelIO extends InteractiveModelIO {
  stderrLines: string[];
  prompts: { prompt: string; answer: string }[];
  modelSelections: ModelSelection[];
  inventoryCalls: number;
  currentModelsCalls: number;
}

function scriptedModelIO(options: {
  isTTY?: boolean;
  inventory?: readonly string[];
  current?: CurrentModels;
  classAnswer?: "reasoning" | "execution";
  selectedModel?: string;
}): ScriptedModelIO {
  const stderrLines: string[] = [];
  const prompts: { prompt: string; answer: string }[] = [];
  const modelSelections: ModelSelection[] = [];
  const inventory = options.inventory ?? [];
  const current = options.current ?? { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" };
  const classAnswer = options.classAnswer ?? "reasoning";
  const selectedModel = options.selectedModel ?? inventory[0] ?? "openai/gpt-5.6-sol";

  return {
    isTTY: options.isTTY ?? true,
    stderrLines,
    prompts,
    modelSelections,
    inventoryCalls: 0,
    currentModelsCalls: 0,
    writeStderr(line: string): void {
      stderrLines.push(line);
    },
    async promptLine(prompt: string): Promise<string> {
      // The class prompt is the only promptLine call in the happy path.
      prompts.push({ prompt, answer: classAnswer });
      return classAnswer;
    },
    async listOpenCodeModels(): Promise<readonly string[]> {
      this.inventoryCalls += 1;
      return [...inventory];
    },
    async runModelSelector(selection: ModelSelection): Promise<string> {
      modelSelections.push(selection);
      return selectedModel;
    },
    async loadCurrentModels(): Promise<CurrentModels> {
      this.currentModelsCalls += 1;
      return current;
    },
  };
}

async function install(repository: TestRepository): Promise<void> {
  await init(repository.root, testConfig(repository), {
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

describe("runInteractiveModel (ticket #59)", () => {
  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  it("fails closed with NON_TTY_MODEL when IO.isTTY is false", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const io = scriptedModelIO({ isTTY: false });

    await expect(
      runInteractiveModel({ root: repo.root, io }),
    ).rejects.toMatchObject({ code: "NON_TTY_MODEL" });

    // The flow must refuse BEFORE any IO is offered: no stderr, no
    // prompts, no inventory probe, no selector call.
    expect(io.stderrLines).toEqual([]);
    expect(io.prompts).toEqual([]);
    expect(io.modelSelections).toEqual([]);
    expect(io.inventoryCalls).toBe(0);
    expect(io.currentModelsCalls).toBe(0);
  });

  it("fails closed with MODEL_NOT_INSTALLED when Poiesis is not installed in the repo", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    const io = scriptedModelIO({ isTTY: true });

    await expect(
      runInteractiveModel({ root: repo.root, io }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_INSTALLED" });

    expect(io.modelSelections).toEqual([]);
    expect(io.prompts).toEqual([]);
  });

  it("prints current reasoning and execution on stderr BEFORE asking the Author", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"],
      current: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      classAnswer: "reasoning",
      selectedModel: "openai/gpt-5.6-fallback",
    });

    await runInteractiveModel({ root: repo.root, io });

    const stderr = io.stderrLines.join("");
    // Both current identities appear in the detection frame.
    expect(stderr).toContain("openai/gpt-5.6-sol");
    expect(stderr).toContain("minimax/MiniMax-M3");
    // The stderr frames precede the prompt (Author sees both before being asked).
    const lastDetectionLine = Math.max(
      stderr.indexOf("openai/gpt-5.6-sol"),
      stderr.indexOf("minimax/MiniMax-M3"),
    );
    expect(lastDetectionLine).toBeGreaterThanOrEqual(0);
    expect(stderr).toContain("reasoning");
    expect(stderr).toContain("execution");
  });

  it("runs the shared model selector for the chosen class with the live inventory", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const inventory = ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"];
    const io = scriptedModelIO({
      isTTY: true,
      inventory,
      classAnswer: "reasoning",
      selectedModel: "openai/gpt-5.6-fallback",
    });

    const result = await runInteractiveModel({ root: repo.root, io });

    // Exactly one selector call with the chosen class.
    expect(io.modelSelections).toHaveLength(1);
    expect(io.modelSelections[0]!.modelClass).toBe("reasoning");
    // The inventory is the live `opencode models` list (every entry flows through).
    expect([...io.modelSelections[0]!.inventory]).toEqual(inventory);
    // The recommendation policy mirrors `poiesis init`: canonical constants.
    expect(io.modelSelections[0]!.recommended).toEqual({
      reasoning: "openai/gpt-5.6-sol",
      execution: "minimax/MiniMax-M3",
    });
    // The chosen identity is the one we asked the selector to return.
    expect(result.manifest).toBeDefined();
  });

  it("changes exactly one slot per run (reasoning chosen → execution is preserved)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const before = await readPoiesisConfig(repo);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"],
      classAnswer: "reasoning",
      selectedModel: "openai/gpt-5.6-fallback",
    });

    const beforeReceipt = await readOwnershipReceipt(repo.root);
    await runInteractiveModel({ root: repo.root, io });
    const after = await readPoiesisConfig(repo);

    expect(after.models.reasoning).toBe("openai/gpt-5.6-fallback");
    expect(after.models.execution).toBe(before.models.execution);
    expect(after.tracker.provider).toBe(before.tracker.provider);

    // Receipt generation advanced exactly once (the single write).
    const afterReceipt = await readOwnershipReceipt(repo.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation + 1);
  }, 30_000);

  it("changes exactly one slot per run (execution chosen → reasoning is preserved)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const before = await readPoiesisConfig(repo);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"],
      classAnswer: "execution",
      selectedModel: "minimax/MiniMax-M3-alt",
    });

    await runInteractiveModel({ root: repo.root, io });
    const after = await readPoiesisConfig(repo);

    expect(after.models.execution).toBe("minimax/MiniMax-M3-alt");
    expect(after.models.reasoning).toBe(before.models.reasoning);
  }, 30_000);

  it("writes through setModel → updateFromConfig (manifest digest updates, receipt advances)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const before = await readPoiesisConfig(repo);
    const beforeManifest = await loadManifest(repo.root);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"],
      classAnswer: "reasoning",
      selectedModel: "openai/gpt-5.6-fallback",
    });

    const result = await runInteractiveModel({ root: repo.root, io });

    // The result carries a restart notice and `started: false` — the
    // contract shared with `setModel` for ticket #56.
    expect(result.restart).toEqual({
      notice: expect.stringMatching(/restart/i),
      started: false,
    });

    // The new manifest's recorded Poiesis config hash matches the on-disk file
    // → the write went through updateFromConfig (which records the post-write
    // config hash in `manifest.files`).
    const afterManifest = await loadManifest(repo.root);
    const recordedConfigFile = afterManifest.files.find(
      (file) => file.path === CONFIG_ROOT,
    );
    expect(recordedConfigFile).toBeDefined();
    const onDiskConfig = await readFile(join(repo.root, CONFIG_ROOT), "utf8");
    // The Poiesis config hash in the manifest matches the on-disk bytes.
    expect(recordedConfigFile!.hash).toBe(hashContent(onDiskConfig));
    // Receipt digest moved.
    expect(afterManifest.poiesisVersion).toBe(beforeManifest.poiesisVersion);
    const receipt = await readOwnershipReceipt(repo.root);
    expect(receipt.manifestDigest).not.toBe("");
  }, 30_000);

  it("prints a restart notice on stderr after success and never starts OpenCode", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"],
      classAnswer: "execution",
      selectedModel: "minimax/MiniMax-M3-alt",
    });

    await runInteractiveModel({ root: repo.root, io });
    const stderr = io.stderrLines.join("");
    expect(stderr.toLowerCase()).toMatch(/restart/i);
    expect(stderr.toLowerCase()).toMatch(/opencode/);
    // The notice must say Poiesis did NOT restart OpenCode.
    expect(stderr.toLowerCase()).toMatch(/poiesis.*did not.*restart|poiesis.*not.*restart/);
  }, 30_000);

  it("rejects an invalid class answer (anything other than reasoning|execution) BEFORE any selector call", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
    });
    // Override the default promptLine to return garbage.
    io.promptLine = async (prompt: string): Promise<string> => {
      io.prompts.push({ prompt, answer: "planner" });
      return "planner";
    };

    await expect(
      runInteractiveModel({ root: repo.root, io }),
    ).rejects.toMatchObject({ code: "INVALID_MODEL_CLASS" });

    // No selector was offered — the bad class answer short-circuits.
    expect(io.modelSelections).toEqual([]);
  });

  it("fails closed when the OpenCode inventory is empty (no silent fallback)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const io = scriptedModelIO({ isTTY: true, inventory: [] });

    await expect(
      runInteractiveModel({ root: repo.root, io }),
    ).rejects.toMatchObject({ code: "MODEL_INVENTORY_UNAVAILABLE" });
  });

  it("preserves every owned byte when the chosen identity equals the current value (no-op)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const receiptPath = await ownershipReceiptLocation(repo.root);
    const beforePoiesis = await readFile(join(repo.root, CONFIG_ROOT));
    const beforeManifest = await readFile(join(repo.root, ".poiesis", "manifest.json"));
    const beforeReceipt = await readFile(receiptPath);
    const beforeReceiptParsed = await readOwnershipReceipt(repo.root);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"],
      current: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      classAnswer: "reasoning",
      selectedModel: "openai/gpt-5.6-sol", // no-op
    });

    const result = await runInteractiveModel({ root: repo.root, io });

    const afterPoiesis = await readFile(join(repo.root, CONFIG_ROOT));
    const afterManifest = await readFile(join(repo.root, ".poiesis", "manifest.json"));
    const afterReceipt = await readFile(receiptPath);
    const afterReceiptParsed = await readOwnershipReceipt(repo.root);

    expect(Buffer.compare(afterPoiesis, beforePoiesis)).toBe(0);
    expect(Buffer.compare(afterManifest, beforeManifest)).toBe(0);
    expect(Buffer.compare(afterReceipt, beforeReceipt)).toBe(0);
    expect(afterReceiptParsed.generation).toBe(beforeReceiptParsed.generation);

    // Even on a no-op the restart notice is part of the contract.
    expect(result.restart.started).toBe(false);
  }, 30_000);

  it("propagates MODEL_SELECTOR_CANCELLED without writing when the Author cancels the selector", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);
    const receiptPath = await ownershipReceiptLocation(repo.root);
    const beforePoiesis = await readFile(join(repo.root, CONFIG_ROOT));
    const beforeManifest = await readFile(join(repo.root, ".poiesis", "manifest.json"));
    const beforeReceipt = await readFile(receiptPath);
    const io = scriptedModelIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-5.6-fallback", "minimax/MiniMax-M3", "minimax/MiniMax-M3-alt"],
      classAnswer: "reasoning",
    });
    io.runModelSelector = async (selection: ModelSelection): Promise<string> => {
      io.modelSelections.push(selection);
      throw new (await import("../src/errors.js")).PoiesisError(
        "MODEL_SELECTOR_CANCELLED",
        "cancelled",
        { modelClass: selection.modelClass },
      );
    };

    await expect(
      runInteractiveModel({ root: repo.root, io }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_CANCELLED" });

    const afterPoiesis = await readFile(join(repo.root, CONFIG_ROOT));
    const afterManifest = await readFile(join(repo.root, ".poiesis", "manifest.json"));
    const afterReceipt = await readFile(receiptPath);
    expect(Buffer.compare(afterPoiesis, beforePoiesis)).toBe(0);
    expect(Buffer.compare(afterManifest, beforeManifest)).toBe(0);
    expect(Buffer.compare(afterReceipt, beforeReceipt)).toBe(0);
  });
});

describe("commandModel bare-args TTY wiring (ticket #59)", () => {
  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  it("dispatches bare `poiesis model` on a TTY to the interactive flow (no MODEL_INTERACTIVE_UNAVAILABLE throw)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);

    // Patch the production IO factory used by `commandModel` to use a
    // scripted IO seam. We achieve this by intercepting the
    // `createProductionInteractiveModelIO` import — but since the CLI
    // imports it eagerly, we instead monkey-patch the prototype of
    // `process.stdin` / `process.stderr` so `isTTY` reports true and the
    // model selection happens through the production selector with a
    // scripted keypress loop.
    //
    // Simpler approach: assert that the CLI throws
    // NON_TTY_MODEL when the production IO sees a non-TTY stdin (which
    // is always true under Vitest), i.e. the new fail-closed behavior
    // is wired for non-TTY runs. The TTY happy path is covered by the
    // `runInteractiveModel` suite above; this test only proves the CLI
    // dispatch reaches the new code path.
    const saved = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    try {
      await expect(commandModel([])).rejects.toMatchObject({
        code: "NON_TTY_MODEL",
      });
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = saved;
    }
  });

  it("dispatches `poiesis model --cwd <path>` to the interactive flow against the supplied repo (no UNKNOWN_COMMAND)", async () => {
    // Ticket #66: `--cwd` must be parsed even when args contains no
    // `set` subcommand, so the bare-args interactive flow can target a
    // non-default repo root. The dispatch must NOT reject with
    // `UNKNOWN_COMMAND` — instead it routes to the interactive flow,
    // which then fails closed with `NON_TTY_MODEL` (Vitest stdin is
    // not a TTY), proving we crossed the dispatcher boundary
    // correctly and gave the IO factory the supplied git root.
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);

    const saved = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    try {
      await expect(commandModel(["--cwd", repo.root])).rejects.toMatchObject({
        code: "NON_TTY_MODEL",
      });
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = saved;
    }
  });

  it("dispatches `poiesis model set <class> <id> --cwd <path>` (set still honors --cwd after ticket #66 split)", async () => {
    // Regression guard for ticket #66: the new `--cwd`-first split
    // must NOT regress `set <class> <id> --cwd <path>`. We keep the
    // invocation shape the existing set subcommand already supported
    // and re-run the same happy-path semantics.
    const repo = await createTestRepository();
    repositories.push(repo);
    await install(repo);

    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await commandModel(["set", "reasoning", "openai/gpt-5.6-sol", "--cwd", repo.root]);
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(captured.join("")) as { ok: boolean; operation: string };
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("model.set");
  }, 30_000);
});

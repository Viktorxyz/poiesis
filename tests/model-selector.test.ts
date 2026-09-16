import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECOMMENDED_MODEL_IDS,
  createProductionModelSelectorIO,
  runModelSelector,
  type ModelSelectorIO,
  type ModelSelectorKey,
} from "../src/model-selector.js";

/**
 * Builds a `ModelSelectorIO` backed by a queue of pre-canned keys so
 * the selector's render/keypress logic can be exercised without ever
 * touching a real PTY. The helper records every byte written through
 * `io.write` so tests can assert on the rendered ANSI frame.
 */
function scriptedIO(keys: ModelSelectorKey[], tty = true): ModelSelectorIO & { written: string[] } {
  const written: string[] = [];
  let next = 0;
  return {
    isTTY: tty,
    written,
    write(data: string): void {
      written.push(data);
    },
    async readKey(): Promise<ModelSelectorKey> {
      if (next >= keys.length) {
        throw new Error(`scriptedIO exhausted (consumed ${next} of ${keys.length})`);
      }
      return keys[next++]!;
    },
  };
}

const INVENTORY_WITH_BOTH_RECOMMENDED = [
  "openai/gpt-5.6-sol",
  "openai/gpt-4o",
  "minimax/MiniMax-M3",
  "anthropic/claude-sonnet-4.5",
];

const INVENTORY_WITHOUT_RECOMMENDED = [
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4.5",
  "minimax/some-other-model",
];

describe("runModelSelector", () => {
  it("fails closed when stdin is not a TTY", async () => {
    const io = scriptedIO([], false);
    await expect(
      runModelSelector({ io, inventory: INVENTORY_WITH_BOTH_RECOMMENDED, modelClass: "reasoning" }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_NOT_TTY" });
    expect(io.written.join("")).toBe("");
  });

  it("fails closed when the inventory is empty", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    await expect(
      runModelSelector({ io, inventory: [], modelClass: "reasoning" }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_NO_INVENTORY" });
  });

  it("fails closed when the inventory contains no usable identities", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    await expect(
      runModelSelector({ io, inventory: ["", "   ", "\n"], modelClass: "reasoning" }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_NO_INVENTORY" });
  });

  it("preselects and marks Recommended only when the constant is in inventory", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    expect(selected).toBe("openai/gpt-5.6-sol");
    const rendered = io.written.join("");
    expect(rendered).toContain("openai/gpt-5.6-sol");
    expect(rendered).toContain("Recommended");
    expect(rendered).toMatch(/openai\/gpt-5\.6-sol.*Recommended/s);
  });

  it("does not preselect anything when the recommended identity is absent (no cousin substitute)", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITHOUT_RECOMMENDED,
      modelClass: "reasoning",
    });
    // First inventory item is the cursor start when no recommendation is in inventory.
    expect(selected).toBe("openai/gpt-4o");
    const rendered = io.written.join("");
    expect(rendered).not.toContain("Recommended");
  });

  it("marks the non-selected recommendation only as a cross-reference, never preselects it", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    expect(selected).toBe("openai/gpt-5.6-sol");
    const rendered = io.written.join("");
    // The execution-class recommended identity is annotated but does not move the cursor.
    expect(rendered).toMatch(/minimax\/MiniMax-M3.*Recommended \(execution\)/s);
  });

  it("moves the cursor with down + enter", async () => {
    const io = scriptedIO([{ kind: "down" }, { kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    expect(selected).toBe("openai/gpt-4o");
  });

  it("moves the cursor with up + enter (wraps to last when at the top)", async () => {
    const io = scriptedIO([
      { kind: "up" }, // wraps to last
      { kind: "enter" },
    ]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    expect(selected).toBe("anthropic/claude-sonnet-4.5");
  });

  it("supports direct numeric selection within bounds", async () => {
    const io = scriptedIO([{ kind: "number", value: 3 }, { kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    expect(selected).toBe("minimax/MiniMax-M3");
  });

  it("ignores numeric keys that exceed the inventory size", async () => {
    const io = scriptedIO([
      { kind: "number", value: 9 }, // ignored
      { kind: "enter" },
    ]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    expect(selected).toBe("openai/gpt-5.6-sol");
  });

  it("cancels on escape and reports the cancellation through a typed PoiesisError", async () => {
    const io = scriptedIO([{ kind: "cancel" }]);
    await expect(
      runModelSelector({
        io,
        inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
        modelClass: "reasoning",
      }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_CANCELLED" });
  });

  it("cancels on q", async () => {
    const io = scriptedIO([{ kind: "cancel" }]);
    await expect(
      runModelSelector({
        io,
        inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
        modelClass: "reasoning",
      }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_CANCELLED" });
  });

  it("preselects the execution recommended identity when modelClass is execution", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "execution",
    });
    expect(selected).toBe("minimax/MiniMax-M3");
    const rendered = io.written.join("");
    expect(rendered).toMatch(/minimax\/MiniMax-M3.*Recommended/s);
  });

  it("does not preselect a recommendation when neither constant is in inventory, even with explicit recommended arg", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITHOUT_RECOMMENDED,
      modelClass: "execution",
      recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
    });
    expect(selected).toBe("openai/gpt-4o");
  });

  it("accepts custom recommended identities and uses them only when in inventory", async () => {
    const custom = {
      reasoning: "openai/gpt-5.6-sol",
      execution: "minimax/MiniMax-M3",
    };
    const io = scriptedIO([{ kind: "enter" }]);
    const selected = await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "execution",
      recommended: custom,
    });
    expect(selected).toBe("minimax/MiniMax-M3");
  });

  it("preserves the inventory order in the rendered frame", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    const rendered = io.written.join("");
    const openaiGpt56 = rendered.indexOf("openai/gpt-5.6-sol");
    const openaiGpt4o = rendered.indexOf("openai/gpt-4o");
    const minimax = rendered.indexOf("minimax/MiniMax-M3");
    const anthropic = rendered.indexOf("anthropic/claude-sonnet-4.5");
    expect(openaiGpt56).toBeGreaterThanOrEqual(0);
    expect(openaiGpt4o).toBeGreaterThan(openaiGpt56);
    expect(minimax).toBeGreaterThan(openaiGpt4o);
    expect(anthropic).toBeGreaterThan(minimax);
  });

  it("renders a cursor marker on the active row", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
    });
    const rendered = io.written.join("");
    // The active row carries the cursor glyph; other rows do not.
    const cursorGlyph = "\u276F"; // ❯
    expect(rendered).toContain(cursorGlyph);
    expect(rendered.indexOf(cursorGlyph)).toBeLessThan(rendered.indexOf("openai/gpt-5.6-sol"));
  });

  it("renders an explicit title that mentions the model class", async () => {
    const io = scriptedIO([{ kind: "enter" }]);
    await runModelSelector({
      io,
      inventory: INVENTORY_WITH_BOTH_RECOMMENDED,
      modelClass: "reasoning",
      title: "Pick a reasoning model",
    });
    expect(io.written.join("")).toContain("Pick a reasoning model");
  });

  it("defaults to the canonical recommended constants when none are supplied", () => {
    expect(DEFAULT_RECOMMENDED_MODEL_IDS.reasoning).toBe("openai/gpt-5.6-sol");
    expect(DEFAULT_RECOMMENDED_MODEL_IDS.execution).toBe("minimax/MiniMax-M3");
  });
});

describe("createProductionModelSelectorIO", () => {
  it("reports isTTY=false for a non-TTY stream pair", () => {
    const { PassThrough } = require("node:stream") as typeof import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const io = createProductionModelSelectorIO({ stdin, stdout });
    expect(io.isTTY).toBe(false);
  });

  it("reports isTTY=true for a TTY stream pair", () => {
    const { PassThrough } = require("node:stream") as typeof import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdout as unknown as { isTTY: boolean }).isTTY = true;
    const io = createProductionModelSelectorIO({ stdin, stdout });
    expect(io.isTTY).toBe(true);
  });

  it("writes bytes to the supplied stdout stream", () => {
    const { PassThrough } = require("node:stream") as typeof import("node:stream");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collected: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => collected.push(chunk));
    const io = createProductionModelSelectorIO({ stdin, stdout });
    io.write("hello world\n");
    expect(Buffer.concat(collected).toString("utf8")).toBe("hello world\n");
  });
});
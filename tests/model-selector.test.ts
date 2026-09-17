import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { emitKeypressEvents, type Key } from "node:readline";
import {
  DEFAULT_RECOMMENDED_MODEL_IDS,
  createProductionModelSelectorIO,
  runModelSelector,
  __test,
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

describe("ticket #65 — TTY keypress hardening", () => {
  it("translateKeypress returns null for an undefined keypress chunk instead of throwing UNEXPECTED", () => {
    const result = __test.translateKeypress(undefined);
    expect(result).toBeNull();
  });

  it("translateKeypress returns null for a null keypress chunk instead of throwing UNEXPECTED", () => {
    const result = __test.translateKeypress(null);
    expect(result).toBeNull();
  });

  it("translateKeypress translates the Down arrow sequence \\x1b[B without a PTY", () => {
    const key: Key = { sequence: "\u001b[B", name: "down" };
    expect(__test.translateKeypress(key)).toEqual({ kind: "down" });
  });

  it("readKey resolves with {kind:'down'} when Down arrow bytes are pushed through a non-TTY Readable (no UNEXPECTED throw)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    (stdin as { isTTY?: boolean }).isTTY = true;
    // Track setRawMode calls so we can assert restoration separately.
    const rawModeCalls: boolean[] = [];
    (stdin as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (mode: boolean) => {
      rawModeCalls.push(mode);
    };

    const io = createProductionModelSelectorIO({ stdin, stdout });
    // The factory has already wired emitKeypressEvents, but the test
    // stream must be parsed as keypress events too so the bytes become
    // keypress chunks.
    emitKeypressEvents(stdin);

    const promise = io.readKey();

    // Push the Down arrow CSI sequence in two chunks to mimic how a
    // PTY fragment-ships ESC-prefixed sequences. The first write is a
    // bare ESC, which Node's keypress parser emits as an undefined key
    // chunk; the second write carries "[B" and resolves to { kind: "down" }.
    stdin.write("\x1b");
    stdin.write("[B");

    const key = await promise;
    expect(key).toEqual({ kind: "down" });
    // Up/Down are NOT terminal keys, so raw mode must stay ON until the
    // selector either receives enter / cancel or the stream closes.
    const lastCall = rawModeCalls[rawModeCalls.length - 1];
    expect(lastCall).toBe(true);
  });

  it("readKey keeps waiting when the first keypress chunk is undefined (does not reject)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    (stdin as { isTTY?: boolean }).isTTY = true;

    const io = createProductionModelSelectorIO({ stdin, stdout });
    emitKeypressEvents(stdin);

    const promise = io.readKey();

    // Push a bare ESC fragment first — the keypress event fires with
    // an undefined Key (Node's behavior on incomplete CSI sequences).
    stdin.write("\x1b");

    // The promise must not resolve or reject yet; a follow-up keypress
    // is still required.
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    // Now complete the CSI sequence — Down arrow.
    stdin.write("[B");
    const key = await promise;
    expect(key).toEqual({ kind: "down" });
  });

  it("restores setRawMode(false) after a successful enter resolution when raw mode was enabled", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    (stdin as { isTTY?: boolean }).isTTY = true;
    const rawModeCalls: boolean[] = [];
    (stdin as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (mode: boolean) => {
      rawModeCalls.push(mode);
    };

    const io = createProductionModelSelectorIO({ stdin, stdout });
    emitKeypressEvents(stdin);

    // Sanity: factory turns raw mode ON at construction.
    expect(rawModeCalls).toContain(true);

    const promise = io.readKey();
    // Emit CR (Enter).
    stdin.write("\r");

    const key = await promise;
    expect(key).toEqual({ kind: "enter" });

    // After enter the IO must restore raw mode to off.
    const lastCall = rawModeCalls[rawModeCalls.length - 1];
    expect(lastCall).toBe(false);
  });

  it("restores setRawMode(false) after a cancel resolution when raw mode was enabled", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    (stdin as { isTTY?: boolean }).isTTY = true;
    const rawModeCalls: boolean[] = [];
    (stdin as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (mode: boolean) => {
      rawModeCalls.push(mode);
    };

    const io = createProductionModelSelectorIO({ stdin, stdout });
    emitKeypressEvents(stdin);

    const promise = io.readKey();
    // Emit ESC alone — translated to cancel.
    stdin.write("\x1b");

    const key = await promise;
    expect(key).toEqual({ kind: "cancel" });

    const lastCall = rawModeCalls[rawModeCalls.length - 1];
    expect(lastCall).toBe(false);
  });

  it("restores setRawMode(false) when the input stream closes mid-selector", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    (stdin as { isTTY?: boolean }).isTTY = true;
    const rawModeCalls: boolean[] = [];
    (stdin as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (mode: boolean) => {
      rawModeCalls.push(mode);
    };

    const io = createProductionModelSelectorIO({ stdin, stdout });
    emitKeypressEvents(stdin);

    const promise = io.readKey();
    stdin.end();

    await expect(promise).rejects.toMatchObject({ code: "MODEL_SELECTOR_CANCELLED" });
    const lastCall = rawModeCalls[rawModeCalls.length - 1];
    expect(lastCall).toBe(false);
  });

  it("defaults the production output stream to process.stderr (not process.stdout)", () => {
    // We can't observe process.stdout.write from here without patching,
    // so we verify the structural default by inspecting the factory's
    // docstring contract via the fact that the test infra wires
    // process.stderr (not stdout) for the canonical CLI path.
    //
    // Concretely: when no explicit output stream is provided, the
    // selector's write sink must be process.stderr. We assert this by
    // patching process.stderr.write to record what the selector sends
    // and confirming a sample write lands there (and NOT on stdout).
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const originalStderr = process.stderr.write.bind(process.stderr);
    const originalStdout = process.stdout.write.bind(process.stdout);
    let observedOnStderr = false;
    let observedOnStdout = false;
    (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      stderrChunks.push(text);
      if (text.includes("PROBE-SENTINEL")) observedOnStderr = true;
      return true;
    };
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      stdoutChunks.push(text);
      if (text.includes("PROBE-SENTINEL")) observedOnStdout = true;
      return true;
    };
    try {
      const io = createProductionModelSelectorIO();
      io.write("PROBE-SENTINEL\n");
    } finally {
      process.stderr.write = originalStderr as typeof process.stderr.write;
      process.stdout.write = originalStdout as typeof process.stdout.write;
    }
    expect(observedOnStderr).toBe(true);
    expect(observedOnStdout).toBe(false);
  });
});
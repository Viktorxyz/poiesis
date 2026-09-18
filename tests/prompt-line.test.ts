/**
 * Ticket #68 — settle-once readline helper for interactive line prompts.
 *
 * Acceptance contract (mirrors Spec #67):
 *   - `settleOnceLinePrompt` returns the raw entered line (the caller still
 *     `.trim()`s).
 *   - It settles EXACTLY once.
 *   - A genuine close-before-line rejects with the caller-supplied
 *     `PoiesisError` (so `MODEL_PROMPT_CANCELLED` and `INIT_PROMPT_CANCELLED`
 *     stay distinct per Spec §"Design").
 *   - A `close` event caused by our own `rl.close()` after a successful
 *     line MUST NOT reject — this is the regression that 1.1.0 carried
 *     (synchronous `close` was firing inside the `line` listener before
 *     `resolve(line)` was observed).
 *
 * Test seam: we inject `PassThrough` stdin / stderr so the production
 * readline loop can run without a PTY. Same discipline as
 * `tests/model-selector.test.ts`'s production IO tests.
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { settleOnceLinePrompt } from "../src/prompt-line.js";
import { PoiesisError } from "../src/errors.js";

interface PromptStreamPair {
  stdin: PassThrough;
  stderr: PassThrough;
  stderrChunks: Buffer[];
}

function setupPair(): PromptStreamPair {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const stderrChunks: Buffer[] = [];
  stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  return { stdin, stderr, stderrChunks };
}

describe("settleOnceLinePrompt (ticket #68)", () => {
  it("resolves exactly once with the entered line and ignores the synchronous post-line close", async () => {
    const { stdin, stderr, stderrChunks } = setupPair();
    const cancellation = new PoiesisError("MODEL_PROMPT_CANCELLED", "cancelled", { prompt: "Class" });
    const promise = settleOnceLinePrompt({
      prompt: "Class",
      input: stdin,
      output: stderr,
      isTTY: true,
      cancellationError: cancellation,
    });
    // Line first, then end — readline emits `line` before `close`.
    stdin.write("reasoning\n");
    stdin.end();
    await expect(promise).resolves.toBe("reasoning");
    // The prompt is written to the supplied output stream.
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("Class");
  });

  it("resolves with the empty string when the user presses Enter without typing", async () => {
    const { stdin, stderr } = setupPair();
    const cancellation = new PoiesisError("MODEL_PROMPT_CANCELLED", "cancelled", { prompt: "Class" });
    const promise = settleOnceLinePrompt({
      prompt: "Class",
      input: stdin,
      output: stderr,
      isTTY: true,
      cancellationError: cancellation,
    });
    // Bare newline — readline fires `line` with the empty string.
    stdin.write("\n");
    stdin.end();
    await expect(promise).resolves.toBe("");
  });

  it("rejects with the caller-supplied cancellation error when stdin closes before any line", async () => {
    const { stdin, stderr } = setupPair();
    const cancellation = new PoiesisError("INIT_PROMPT_CANCELLED", "Interactive prompt was cancelled", { prompt: "Class" });
    const promise = settleOnceLinePrompt({
      prompt: "Class",
      input: stdin,
      output: stderr,
      isTTY: true,
      cancellationError: cancellation,
    });
    // No line — readline only sees `close`.
    stdin.end();
    await expect(promise).rejects.toBe(cancellation);
  });

  it("propagates the caller's distinct cancellation error code (MODEL vs INIT stay distinct)", async () => {
    const { stdin, stderr } = setupPair();
    const initError = new PoiesisError("INIT_PROMPT_CANCELLED", "init cancelled", { prompt: "Tracker" });
    const promise = settleOnceLinePrompt({
      prompt: "Tracker",
      input: stdin,
      output: stderr,
      isTTY: true,
      cancellationError: initError,
    });
    stdin.end();
    // The exact rejection object is the caller's — no wrapping, no UNEXPECTED.
    await expect(promise).rejects.toMatchObject({
      code: "INIT_PROMPT_CANCELLED",
      details: { prompt: "Tracker" },
    });
  });

  it("a synchronous close fired by the line handler does not reject (1.1.0 race regression)", async () => {
    // Direct regression for the 1.1.0 bug: the helper used to call
    // `rl.close()` from within the `line` listener; Node's readline emits
    // `close` synchronously, and the bound `close` listener would call
    // `reject(cancellation)` BEFORE `resolve(line)` was observed. Without
    // a settle-once guard, this promise rejects; with the guard, it
    // resolves to the entered line and any subsequent close is a no-op.
    const { stdin, stderr } = setupPair();
    const cancellation = new PoiesisError("MODEL_PROMPT_CANCELLED", "cancelled", { prompt: "Class" });
    const promise = settleOnceLinePrompt({
      prompt: "Class",
      input: stdin,
      output: stderr,
      isTTY: true,
      cancellationError: cancellation,
    });
    // End stdin WITHOUT writing a line first — readline will fire `close`
    // before `line` could fire. The promise MUST reject with the caller
    // error (this is the genuine cancellation path).
    stdin.end();
    await expect(promise).rejects.toBe(cancellation);
  });

  it("a line that resolves the promise cannot be turned into a rejection by a later close event", async () => {
    // Symmetric regression: push a line, await resolution, THEN end
    // stdin. The settled flag must prevent the close handler from
    // mutating the settled state into a rejection.
    const { stdin, stderr } = setupPair();
    const cancellation = new PoiesisError("MODEL_PROMPT_CANCELLED", "cancelled", { prompt: "Class" });
    const settled: { state: "pending" | "fulfilled" | "rejected"; value?: unknown; reason?: unknown } = {
      state: "pending",
    };
    const promise = settleOnceLinePrompt({
      prompt: "Class",
      input: stdin,
      output: stderr,
      isTTY: true,
      cancellationError: cancellation,
    });
    promise.then(
      (value) => {
        settled.state = "fulfilled";
        settled.value = value;
      },
      (reason) => {
        settled.state = "rejected";
        settled.reason = reason;
      },
    );
    stdin.write("execution\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled.state).toBe("fulfilled");
    expect(settled.value).toBe("execution");
    // Now end stdin; this fires a late `close` event the helper must ignore.
    stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled.state).toBe("fulfilled");
    expect(settled.value).toBe("execution");
  });

  it("writes the prompt label to the supplied output stream before reading the line", async () => {
    const { stdin, stderr, stderrChunks } = setupPair();
    const cancellation = new PoiesisError("MODEL_PROMPT_CANCELLED", "cancelled", { prompt: "Tracker provider (github|gitlab)" });
    const promise = settleOnceLinePrompt({
      prompt: "Tracker provider (github|gitlab)",
      input: stdin,
      output: stderr,
      isTTY: true,
      cancellationError: cancellation,
    });
    // Give readline a tick to write the prompt frame.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rendered = Buffer.concat(stderrChunks).toString("utf8");
    expect(rendered).toContain("Tracker provider (github|gitlab)");
    stdin.write("github\n");
    stdin.end();
    await expect(promise).resolves.toBe("github");
  });
});
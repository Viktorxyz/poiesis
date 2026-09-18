/**
 * Settle-once readline prompt (ticket #68).
 *
 * A small CLI-internal helper that resolves a single line from a Node
 * `readline` interface while guaranteeing the returned promise settles
 * exactly once. It is the fix for the 1.1.0 race in
 * `src/model-interactive.ts` and `src/init-interactive.ts`, where the
 * production factories attached both `line` and `close` listeners and
 * called `rl.close()` from inside the `line` listener. Node's readline
 * emits `close` synchronously from `rl.close()`, so the bound `close`
 * listener (which rejected with the caller-supplied cancellation error)
 * fired BEFORE `resolve(line)` was observed — the happy path never
 * resolved.
 *
 * Contract (mirrors Spec #67 "Design"):
 *   - Settles EXACTLY once. The first `line` OR `close` event wins;
 *     subsequent events are no-ops.
 *   - "line" (including an empty line) → resolve that raw line.
 *     Callers continue to `.trim()` themselves; this returns the
 *     byte-exact input so the helper has no opinion on whitespace.
 *   - "close" with no prior "line" → reject with the caller-supplied
 *     `PoiesisError` (so `MODEL_PROMPT_CANCELLED` and
 *     `INIT_PROMPT_CANCELLED` stay distinct per Spec §"Design").
 *   - The successful-line path must mark settled BEFORE closing
 *     readline so a synchronous `close` from that close cannot flip
 *     the promise into a rejection.
 *
 * This module is intentionally NOT re-exported from `src/index.ts`.
 * It lives in flat `src/` as a sibling of the interactive modules and
 * is imported by them directly. Tests import it from this source
 * module.
 */
import type { Readable, Writable } from "node:stream";
import type { PoiesisError } from "./errors.js";

export interface SettleOnceLinePromptArgs {
  readonly prompt: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly isTTY: boolean;
  readonly cancellationError: PoiesisError;
}

/**
 * Read exactly one line from `input` and write a `prompt:` frame to
 * `output` first. Returns the raw line (no trimming). Rejects with
 * `cancellationError` if `input` closes before delivering a line.
 *
 * Implementation notes:
 *   - `node:readline` is loaded with a dynamic import so callers that
 *     never prompt (the scripted-IO test paths, the non-TTY fail-closed
 *     branches) do not pay the readline module cost.
 *   - `settled` is the single source of truth for "has this promise
 *     already been resolved or rejected?". The line handler flips it
 *     BEFORE calling `rl.close()`, so even if Node's readline emits
 *     `close` synchronously inside `rl.close()` (it does), the close
 *     handler observes `settled === true` and bails out.
 *   - The `close` handler flips `settled` only when the line handler
 *     has not already done so, so the genuine "close-before-line"
 *     cancellation path still rejects with the caller's typed error.
 */
export async function settleOnceLinePrompt(args: SettleOnceLinePromptArgs): Promise<string> {
  const { createInterface } = await import("node:readline");
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const trySettle = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };
    let rl: { close: () => void } | undefined;
    try {
      const created = createInterface({
        input: args.input,
        output: args.output,
        terminal: args.isTTY,
      });
      rl = created;
      args.output.write(`${args.prompt}: `);
      created.once("line", (line: string) => {
        if (!trySettle()) return;
        resolve(line);
        // Close readline AFTER marking the promise settled so a
        // synchronous `close` event fired by this call cannot
        // transition the already-settled promise into a rejection.
        created.close();
      });
      created.once("close", () => {
        if (!trySettle()) return;
        reject(args.cancellationError);
      });
    } catch (error) {
      // Construction or `createInterface` itself threw — surface as an
      // UNEXPECTED-style error rather than swallowing the caller's
      // cancellation contract. We never overwrite a settled promise:
      // trySettle is the only gate, and the constructor runs before
      // either listener can fire.
      if (!trySettle()) {
        return;
      }
      rl?.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
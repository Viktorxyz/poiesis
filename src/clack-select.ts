/**
 * CLI-internal Clack `select` adapter (ticket #73).
 *
 * Single source of truth for the Poiesis CLI's interactive list
 * primitive. Wraps `@clack/prompts`' `select()` with three Poiesis-owned
 * guarantees that the bare library call does not give us for free:
 *
 *   - **stderr-only frames.** Every `select()` call passes
 *     `output: process.stderr` so human frames never leak onto the
 *     structured-JSON stdout channel reserved for `writeSuccess` /
 *     `writeFailure`. This mirrors the original
 *     `createProductionModelSelectorIO` discipline and the existing
 *     `settleOnceLinePrompt` contract.
 *
 *   - **Typed cancel mapping.** Clack signals user cancellation (Esc or
 *     Ctrl+C) by returning the `CANCEL_SYMBOL` sentinel. The caller
 *     supplies a distinct `PoiesisError` per call site
 *     (`MODEL_SELECTOR_CANCELLED`, `MODEL_CLASS_SELECTOR_CANCELLED`,
 *     `INIT_MODEL_SELECTOR_CANCELLED`, ...) so the existing per-flow
 *     cancel codes stay distinct the same way
 *     `INIT_PROMPT_CANCELLED` / `MODEL_PROMPT_CANCELLED` already are.
 *
 *   - **Stdin resume in finally.** `@clack/prompts`' `select()`
 *     internally creates a readline interface over the supplied input
 *     stream, which (just like `settleOnceLinePrompt`) pauses the
 *     underlying stream when it closes. The adapter calls
 *     `input.resume()` from a `finally` so any following interactive
 *     seam — for example a follow-up Clack prompt or the remaining
 *     `settleOnceLinePrompt` invocations in `poiesis init` — sees a
 *     flowing stdin. Closes / destroyed / ended streams are NOT
 *     force-resumed.
 *
 * The adapter is intentionally NOT re-exported from `src/index.ts` and
 * lives as a CLI-internal sibling of `prompt-line.ts`. Tests import
 * the helper directly from this module; production callers reach it
 * through the dedicated factories in `model-selector.ts`,
 * `model-interactive.ts`, and `init-interactive.ts`.
 */
import { isCancel, select } from "@clack/prompts";
import type { PoiesisError } from "./errors.js";

export interface ClackSelectRow<V> {
  readonly value: V;
  readonly label: string;
  readonly hint?: string;
}

export interface ClackSelectArgs<V> {
  readonly message: string;
  readonly options: ReadonlyArray<ClackSelectRow<V>>;
  readonly initialValue?: V;
  readonly cancelError: PoiesisError;
}

/**
 * Run Clack's `select` against `process.stdin` / `process.stderr`,
 * translating the Clack `CANCEL_SYMBOL` sentinel into the caller-supplied
 * `PoiesisError`. Always resumes `process.stdin` from a `finally` so a
 * subsequent interactive seam on the same process (a second `select`,
 * the remaining `settleOnceLinePrompt` calls in `poiesis init`) is not
 * silently broken by Clack's internal `readline.close()`.
 *
 * Cancellation surfaces as a rejection, NOT as the `CANCEL_SYMBOL`
 * value, so the caller never has to import anything from
 * `@clack/prompts` and the existing `PoiesisError`-shaped flow
 * contract stays the single source of truth for failure handling.
 */
export async function runClackSelect<V>(args: ClackSelectArgs<V>): Promise<V> {
  const stdin = process.stdin;
  const stderr = process.stderr;
  let resumed = false;
  const resumeStdin = (): void => {
    if (resumed) return;
    if (typeof stdin.resume !== "function") return;
    if ((stdin as { readableEnded?: boolean }).readableEnded === true) return;
    if ((stdin as { destroyed?: boolean }).destroyed === true) return;
    stdin.resume();
    resumed = true;
  };
  try {
    const options = args.options.map<{ value: V; label: string; hint?: string }>((option) => {
      if (option.hint === undefined) {
        return { value: option.value, label: option.label };
      }
      return { value: option.value, label: option.label, hint: option.hint };
    });
    const result = await select<V>({
      input: stdin,
      output: stderr,
      message: args.message,
      // The local `options` array is shaped to satisfy `@clack/prompts`'
      // `Option<V>` exactly-optional contract; a structural assertion
      // would reject this assignment because Clack's published types
      // use the conditional `Primitive` overload which expands
      // differently under `exactOptionalPropertyTypes`. The runtime
      // shape matches: `label` is always a string and `hint` is
      // either a string or absent.
      options: options as unknown as Parameters<typeof select<V>>[0]["options"],
      ...(args.initialValue === undefined ? {} : { initialValue: args.initialValue }),
    });
    if (isCancel(result)) {
      throw args.cancelError;
    }
    return result as V;
  } finally {
    resumeStdin();
  }
}
/**
 * Interactive model selector used later by `poiesis init` and
 * `poiesis model`. Tickets #55 introduces the shared selector. The
 * selector is intentionally kept out of the package-root re-exports
 * (`src/index.ts`); tickets #58 / #59 wire the CLI commands to call
 * `runModelSelector` once the public surface stabilizes.
 *
 * Design contract:
 *   - IO is injected: `isTTY`, `write`, and `readKey` are supplied by
 *     the caller. Production wires them through
 *     `createProductionModelSelectorIO`, which uses Node 22 stdlib
 *     `readline.emitKeypressEvents` plus raw mode on `process.stdin`.
 *   - Tests drive the selector with a scripted key queue; no PTY is
 *     ever required.
 *   - Non-TTY environments fail closed through a `PoiesisError` so
 *     CI / scripts never silently fall through to a default model.
 *   - The "Recommended" annotation and the initial cursor position are
 *     driven exclusively by the canonical recommended constants and
 *     only fire when the identity is actually present in the live
 *     inventory. There is no cousin / fuzzy substitute.
 */

import { emitKeypressEvents, type Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { PoiesisError } from "./errors.js";

export type ModelClass = "reasoning" | "execution";

/**
 * A `provider/modelId` identifier exactly as `opencode models` emits.
 * We keep this as a string alias instead of a branded type so it round
 * trips through `parseOpenCodeModelInventory` without ceremony; runtime
 * invariants are checked by membership in the inventory set.
 */
export type ModelIdentity = string;

export interface RecommendedModelIds {
  readonly reasoning: ModelIdentity;
  readonly execution: ModelIdentity;
}

/**
 * Canonical Poiesis recommended identities. The selector marks and
 * preselects these exactly when they appear in the live inventory;
 * absence is a no-preselect / no-substitute signal per ticket #55.
 */
export const DEFAULT_RECOMMENDED_MODEL_IDS: RecommendedModelIds = {
  reasoning: "openai/gpt-5.6-sol",
  execution: "minimax/MiniMax-M3",
};

export type ModelSelectorKey =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "enter" }
  | { kind: "cancel" }
  | { kind: "number"; value: number };

export interface ModelSelectorIO {
  readonly isTTY: boolean;
  write(data: string): void;
  readKey(): Promise<ModelSelectorKey>;
  /**
   * Optional lifecycle hook called by `runModelSelector` in a `finally`
   * block so the production selector can restore any side effects it
   * installed at construction (notably TTY raw mode). Production MUST
   * provide this so a `MODEL_SELECTOR_NOT_TTY` /
   * `MODEL_SELECTOR_NO_INVENTORY` throw BEFORE the first `readKey` still
   * returns the terminal to cooked mode; tests that supply a scripted
   * IO can omit it.
   */
  dispose?(): void;
}

export interface ModelSelectorRenderedRow {
  readonly index: number;
  readonly identity: ModelIdentity;
  readonly number: number;
  readonly isRecommended: boolean;
  readonly recommendedFor: ModelClass | null;
}

export interface RunModelSelectorArgs {
  readonly io: ModelSelectorIO;
  readonly inventory: Iterable<string>;
  readonly modelClass: ModelClass;
  readonly recommended?: RecommendedModelIds;
  readonly title?: string;
}

const CURSOR = "\u276F"; // ❯
const RECOMMENDED_LABEL = "Recommended";
const NUMBER_PAD_WIDTH = 2;

/**
 * Validate the inventory: drop blank lines, dedupe, return a stable
 * array in the order the caller supplied. Empty result is a selector
 * failure (Poiesis cannot recommend or pick from nothing).
 */
function normalizeInventory(inventory: Iterable<string>): ModelIdentity[] {
  const seen = new Set<string>();
  const out: ModelIdentity[] = [];
  for (const entry of inventory) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Build the rows the selector renders. The row preserves inventory
 * order and carries its `recommendedFor` annotation, which is null
 * unless the row matches one of the recommended constants for either
 * class.
 */
export function buildModelSelectorRows(
  identities: ModelIdentity[],
  recommended: RecommendedModelIds,
): ModelSelectorRenderedRow[] {
  return identities.map((identity, index) => {
    let recommendedFor: ModelClass | null = null;
    if (identity === recommended.reasoning) recommendedFor = "reasoning";
    else if (identity === recommended.execution) recommendedFor = "execution";
    return {
      index,
      identity,
      number: index + 1,
      isRecommended: recommendedFor !== null,
      recommendedFor,
    };
  });
}

function annotateRow(identity: string, recommendedFor: ModelClass | null): string {
  if (recommendedFor === null) return "";
  return `  [${RECOMMENDED_LABEL} (${recommendedFor})]`;
}

/**
 * Render the complete frame to the supplied `write` sink. Returns the
 * exact byte sequence written so tests can compare against a known
 * canonical frame without depending on terminal escape rendering.
 */
export function renderModelSelectorFrame(args: {
  title: string;
  rows: ModelSelectorRenderedRow[];
  active: number;
  inventorySize: number;
}): string {
  const lines: string[] = [];
  lines.push(`${args.title}\n`);
  lines.push("\n");
  args.rows.forEach((row, i) => {
    const cursor = i === args.active ? `${CURSOR} ` : "  ";
    const number = String(row.number).padStart(NUMBER_PAD_WIDTH, " ");
    const identity = row.identity.padEnd(40, " ");
    const annotation = row.recommendedFor === null ? "" : annotateRow(row.identity, row.recommendedFor);
    lines.push(`${cursor}${number}. ${identity}${annotation}\n`);
  });
  lines.push("\n");
  lines.push("Use \u2191/\u2193 to move, Enter to select, Esc/q to cancel.\n");
  return lines.join("");
}

/**
 * Run the interactive selector. Returns the chosen `ModelIdentity`.
 *
 * Failure modes (always `PoiesisError` so callers can branch on
 * `error.code`):
 *   - `MODEL_SELECTOR_NOT_TTY`     -- `io.isTTY === false`
 *   - `MODEL_SELECTOR_NO_INVENTORY` -- normalized inventory is empty
 *   - `MODEL_SELECTOR_CANCELLED`   -- user pressed Esc / q / Ctrl+C
 */
export async function runModelSelector(args: RunModelSelectorArgs): Promise<ModelIdentity> {
  const { io, inventory, modelClass } = args;
  const recommended = args.recommended ?? DEFAULT_RECOMMENDED_MODEL_IDS;
  // Always restore raw mode (or any other IO-installed side effect) on
  // the way out, including throws that fire BEFORE the first `readKey`
  // (`MODEL_SELECTOR_NOT_TTY`, `MODEL_SELECTOR_NO_INVENTORY`). The
  // production factory enables raw mode at construction; without this
  // finally the selector would leave the user's TTY in raw mode after a
  // pre-flight rejection, and any subsequent interactive prompt would
  // see escape sequences instead of normal keypresses.
  try {
    if (!io.isTTY) {
      throw new PoiesisError(
        "MODEL_SELECTOR_NOT_TTY",
        "Interactive model selector requires a TTY; pass --non-tty or use a non-interactive workflow",
      );
    }
    const identities = normalizeInventory(inventory);
    if (identities.length === 0) {
      throw new PoiesisError(
        "MODEL_SELECTOR_NO_INVENTORY",
        "OpenCode model inventory is empty; cannot offer a selection",
      );
    }
    const rows = buildModelSelectorRows(identities, recommended);
    const active = initialCursor(rows, modelClass);
    const title = args.title ?? `Select a ${modelClass} model`;
    const initial = renderModelSelectorFrame({ title, rows, active, inventorySize: identities.length });
    io.write(initial);

    // Cursor is a 0-based index into `rows`.
    let cursor = active;
    // Loop until the user confirms a selection or cancels.
    // Each iteration re-renders the frame so the visible cursor reflects
    // the latest keypress. We always re-render after a state change; the
    // cost is trivial (a few dozen bytes) and avoids bespoke partial-frame
    // bookkeeping in the production IO seam.
    for (;;) {
      const key = await io.readKey();
      let moved = false;
      switch (key.kind) {
        case "up":
          cursor = (cursor - 1 + rows.length) % rows.length;
          moved = true;
          break;
        case "down":
          cursor = (cursor + 1) % rows.length;
          moved = true;
          break;
        case "number": {
          const target = key.value - 1;
          if (target >= 0 && target < rows.length) {
            cursor = target;
            moved = true;
          }
          break;
        }
        case "enter": {
          const chosen = rows[cursor];
          if (chosen === undefined) {
            throw new PoiesisError("MODEL_SELECTOR_NO_INVENTORY", "Selector cursor is out of bounds");
          }
          return chosen.identity;
        }
        case "cancel":
          throw new PoiesisError(
            "MODEL_SELECTOR_CANCELLED",
            "Model selection was cancelled by the user",
            { modelClass },
          );
      }
      if (moved) {
        io.write(renderModelSelectorFrame({ title, rows, active: cursor, inventorySize: identities.length }));
      }
    }
  } finally {
    io.dispose?.();
  }
}

function initialCursor(rows: ModelSelectorRenderedRow[], modelClass: ModelClass): number {
  // Preselect ONLY when the constant for the active modelClass is in
  // the inventory. The cross-class recommendation is annotated but
  // never moves the cursor (no cousin substitute).
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    if (row.recommendedFor === modelClass) return i;
  }
  return 0;
}

/**
 * Production IO factory. Wires the selector to the supplied stream
 * pair (defaulting to `process.stdin` / `process.stderr` when omitted
 * so the typical CLI invocation stays a zero-argument call site and
 * the selector's frames stay on the human-facing channel, not on the
 * structured-JSON stdout reserved for `writeSuccess` / `writeFailure`).
 *
 * Uses Node 22 stdlib `readline.emitKeypressEvents` plus raw mode on
 * the input stream. Only the keypress events the selector needs are
 * surfaced through the `ModelSelectorKey` discriminated union, so the
 * selector never sees a raw `Key` object and tests cannot leak into
 * the production code path.
 *
 * Raw mode is enabled exactly once at construction and restored to
 * `false` whenever the IO leaves the waiting state (terminal key
 * resolution, stream end / close, or an unsupported-key error). This
 * keeps the terminal in cooked mode after the selector returns so a
 * stray Ctrl+C / EOF does not leave the user's TTY in raw mode.
 */
export interface ProductionModelSelectorIOArgs {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

export function createProductionModelSelectorIO(
  args: ProductionModelSelectorIOArgs = {},
): ModelSelectorIO {
  const stdin = args.stdin ?? process.stdin;
  const stdout = args.stdout ?? process.stderr;
  const isTTY = Boolean((stdin as { isTTY?: boolean }).isTTY);
  emitKeypressEvents(stdin);
  const raw = stdin as Readable & { setRawMode?: (mode: boolean) => void };
  const canRawMode = typeof raw.setRawMode === "function";
  if (canRawMode) raw.setRawMode!(true);
  // Track whether raw mode is currently armed so an idempotent
  // `restoreRawMode` (and the `dispose()` seam) cannot double-toggle
  // the TTY back to raw after a prior restore.
  let rawModeActive = canRawMode;
  const restoreRawMode = (): void => {
    if (canRawMode && rawModeActive) {
      raw.setRawMode!(false);
      rawModeActive = false;
    }
  };
  const writer = (data: string): void => {
    stdout.write(data);
  };
  const readKey = (): Promise<ModelSelectorKey> =>
    new Promise((resolve, reject) => {
      // Node's `readline.emitKeypressEvents` listener signature is
      // `(chunk, key)` where `chunk` is the raw byte sequence (often
      // `undefined` for fragments that resolve into a multi-byte CSI
      // sequence like arrow keys) and `key` is the parsed `Key`
      // descriptor. The selector is interested in `key` — passing
      // `chunk` is what produced the `Cannot read properties of
      // undefined (reading 'sequence')` `UNEXPECTED` crash on the very
      // first Down arrow reported by the Python-PTY dogfood. Per ticket
      // #65 we forward `key` and keep waiting when it is undefined.
      const onKey = (_chunk: string | undefined, key: Key | undefined): void => {
        if (key === undefined) {
          return;
        }
        stdin.removeListener("keypress", onKey);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("close", onEnd);
        let resolved: ModelSelectorKey;
        try {
          resolved = translateKeypress(key);
        } catch (error) {
          restoreRawMode();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        // `enter` and `cancel` are the two selector-terminal keys; an
        // `up` / `down` / `number` resolution keeps the loop alive so
        // raw mode stays on until the next keypress.
        if (resolved.kind === "enter" || resolved.kind === "cancel") {
          restoreRawMode();
        }
        resolve(resolved);
      };
      const onEnd = (): void => {
        stdin.removeListener("keypress", onKey);
        restoreRawMode();
        reject(
          new PoiesisError(
            "MODEL_SELECTOR_CANCELLED",
            "Model selection was cancelled by the user (input closed)",
          ),
        );
      };
      stdin.on("keypress", onKey);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
    });
  return {
    isTTY,
    write: writer,
    readKey,
    // Ticket #66: `runModelSelector` invokes `dispose()` from a
    // `finally` block so any pre-`readKey` rejection
    // (`MODEL_SELECTOR_NOT_TTY`, `MODEL_SELECTOR_NO_INVENTORY`) still
    // returns the TTY to cooked mode. Idempotent — safe to call after
    // a successful keypress that already restored raw mode.
    dispose: restoreRawMode,
  };
}

/**
 * Translate a Node `Key` object (or an undefined / null chunk emitted
 * for incomplete CSI fragments) into the selector's typed union. The
 * undefined / null case is intentionally collapsed to `null` so the
 * caller's keypress loop keeps waiting without throwing UNEXPECTED.
 *
 * The two signatures mirror the production read loop's two call
 * shapes: production always passes a concrete `Key` (the narrowed
 * second arg of the keypress event) and gets back a non-null typed
 * key, while the regression suite (and any other defensive caller)
 * can pass undefined / null and observe the `null` sentinel without a
 * thrown `UNEXPECTED`.
 */
function translateKeypress(chunk: Key): ModelSelectorKey;
function translateKeypress(chunk: undefined | null): null;
function translateKeypress(chunk: Key | undefined | null): ModelSelectorKey | null;
function translateKeypress(chunk: Key | undefined | null): ModelSelectorKey | null {
  if (chunk === undefined || chunk === null) return null;
  if (chunk.sequence === "\u0003" || chunk.sequence === "\u001b" || chunk.name === "escape") {
    return { kind: "cancel" };
  }
  if (chunk.name === "up" || chunk.sequence === "\u001b[A") return { kind: "up" };
  if (chunk.name === "down" || chunk.sequence === "\u001b[B") return { kind: "down" };
  if (chunk.name === "return" || chunk.sequence === "\r" || chunk.sequence === "\n") {
    return { kind: "enter" };
  }
  if (chunk.name === "q" && !chunk.ctrl) return { kind: "cancel" };
  const numeric = matchNumericKeypress(chunk);
  if (numeric !== null) return { kind: "number", value: numeric };
  throw new PoiesisError(
    "MODEL_SELECTOR_UNSUPPORTED_KEY",
    "Selector received an unsupported keypress",
    { sequence: chunk.sequence, name: chunk.name },
  );
}

function matchNumericKeypress(chunk: Key): number | null {
  if (chunk.ctrl || chunk.meta || chunk.shift) return null;
  if (chunk.name === undefined) return null;
  if (!/^[0-9]$/.test(chunk.name)) return null;
  return Number.parseInt(chunk.name, 10);
}

/**
 * Internal helpers exposed for the model-selector regression suite
 * (ticket #65). Kept behind a `__test` namespace so the package-root
 * re-exports never surface them to outside consumers.
 */
export const __test = { translateKeypress };
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
 * pair (defaulting to `process.stdin` / `process.stdout` when omitted
 * so the typical CLI invocation stays a zero-argument call site).
 *
 * Uses Node 22 stdlib `readline.emitKeypressEvents` plus raw mode on
 * the input stream. Only the keypress events the selector needs are
 * surfaced through the `ModelSelectorKey` discriminated union, so the
 * selector never sees a raw `Key` object and tests cannot leak into
 * the production code path.
 */
export interface ProductionModelSelectorIOArgs {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

export function createProductionModelSelectorIO(
  args: ProductionModelSelectorIOArgs = {},
): ModelSelectorIO {
  const stdin = args.stdin ?? process.stdin;
  const stdout = args.stdout ?? process.stdout;
  const isTTY = Boolean((stdin as { isTTY?: boolean }).isTTY);
  emitKeypressEvents(stdin);
  const raw = stdin as Readable & { setRawMode?: (mode: boolean) => void };
  if (typeof raw.setRawMode === "function") raw.setRawMode(true);
  const writer = (data: string): void => {
    stdout.write(data);
  };
  const readKey = (): Promise<ModelSelectorKey> =>
    new Promise((resolve, reject) => {
      const onKey = (chunk: Key): void => {
        stdin.removeListener("keypress", onKey);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("close", onEnd);
        try {
          resolve(translateKeypress(chunk));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onEnd = (): void => {
        stdin.removeListener("keypress", onKey);
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
  };
}

function translateKeypress(chunk: Key): ModelSelectorKey {
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
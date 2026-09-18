/**
 * Interactive model selector (ticket #73).
 *
 * Shared domain logic and the Clack adapter contract for the model
 * selector that `poiesis init` and `poiesis model` both call. The
 * selector is intentionally kept out of the package-root re-exports
 * (`src/index.ts`); both interactive modules import `runModelSelector`
 * directly from this source module.
 *
 * Design contract:
 *   - The ONLY interactive list primitive is `@clack/prompts` `select`,
 *     routed through the CLI-internal `runClackSelect` adapter. Clack
 *     handles arrow / Enter / Esc / Ctrl+C keys and the visible
 *     cursor; we never touch `readline.emitKeypressEvents`, raw mode,
 *     or `setRawMode` ourselves.
 *   - Domain option builders are library-free pure functions. The
 *     row shape and the `initialValue` policy belong to Poiesis, not
 *     to Clack — they never assume anything about Clack's internal
 *     cursor placement or framing.
 *   - Cancellation surfaces as a `PoiesisError` with the caller's
 *     exact code (`MODEL_SELECTOR_CANCELLED` for identity,
 *     `MODEL_CLASS_SELECTOR_CANCELLED` for the class selector). The
 *     adapter translates Clack's `CANCEL_SYMBOL` into that typed
 *     failure.
 *   - Non-TTY and empty-inventory invocations fail closed through a
 *     typed `PoiesisError` BEFORE any frame is rendered, so CI / scripts
 *     never silently fall through to a default model.
 *   - "Recommended" and "Current" are annotations on the row's hint.
 *     Cursor highlight is Clack's. Cross-class recommendation MAY
 *     appear as extra hint text; it NEVER sets `initialValue`.
 */

import { PoiesisError } from "./errors.js";
import { runClackSelect, type ClackSelectRow } from "./clack-select.js";

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

/**
 * Domain hint flags for a single identity row. The pure builder merges
 * them into the `hint` string the Clack option carries; we keep the
 * flag structure library-free so callers can assert on the row shape
 * without depending on `@clack/prompts`.
 */
export interface ModelSelectorRowHints {
  readonly isCurrent: boolean;
  readonly isRecommended: boolean;
  readonly recommendedFor: ModelClass | null;
}

/**
 * Pure shape that `buildModelSelectorRows` produces and that the
 * selector passes through to Clack. The library-free shape lets
 * tests assert on the row set without importing Clack.
 */
export interface ModelSelectorRow {
  readonly identity: ModelIdentity;
  readonly hints: ModelSelectorRowHints;
}

export interface BuildModelSelectorRowsArgs {
  readonly identities: readonly ModelIdentity[];
  readonly recommended: RecommendedModelIds;
  readonly currentIdentity: ModelIdentity | null;
}

/**
 * Build the rows the selector renders. Order matches the supplied
 * inventory. The hint flags mark each row with exactly the
 * information the operator needs:
 *   - `isCurrent`        — this row is the operator's currently installed identity
 *   - `isRecommended`    — this row matches a recommended constant
 *   - `recommendedFor`   — the class whose recommended constant matched
 *
 * There is no cousin / fuzzy substitute. `recommendedFor` is `null`
 * unless the row matches a recommended constant exactly.
 */
export function buildModelSelectorRows(args: BuildModelSelectorRowsArgs): ModelSelectorRow[] {
  return args.identities.map((identity) => {
    let recommendedFor: ModelClass | null = null;
    if (identity === args.recommended.reasoning) recommendedFor = "reasoning";
    else if (identity === args.recommended.execution) recommendedFor = "execution";
    return {
      identity,
      hints: {
        isCurrent: args.currentIdentity !== null && identity === args.currentIdentity,
        isRecommended: recommendedFor !== null,
        recommendedFor,
      },
    };
  });
}

/**
 * Render the canonical hint text for a row. The hint is the union of
 * the row's flags:
 *   - ""                            (no flags set)
 *   - "Current"                     (isCurrent only)
 *   - "Recommended"                 (isRecommended for the active class)
 *   - "Current, Recommended"        (both, recommended for the active class)
 *   - "Recommended (execution)"     (recommended for a CROSS class — extra hint text)
 *   - "Current, Recommended (execution)" (both, recommended for a cross class)
 *
 * The active class is supplied by the caller because the same row
 * shape is reused by both `reasoning` and `execution` selectors; the
 * "(class)" suffix only fires when the recommendation does NOT match
 * the active class, so cross-class annotations stay visible without
 * polluting this-class rows. Empty string when neither flag is set.
 */
export function formatModelSelectorHint(
  hints: ModelSelectorRowHints,
  activeClass: ModelClass,
): string {
  if (!hints.isCurrent && !hints.isRecommended) return "";
  const isCrossClass = hints.recommendedFor !== null && hints.recommendedFor !== activeClass;
  const recommendedLabel = isCrossClass ? `Recommended (${hints.recommendedFor})` : "Recommended";
  if (hints.isCurrent && hints.isRecommended) return `Current, ${recommendedLabel}`;
  if (hints.isCurrent) return "Current";
  return recommendedLabel;
}

/**
 * Resolve the canonical `initialValue` policy for the identity
 * selector:
 *
 *   1. The operator's current identity, if it appears in the live inventory.
 *   2. The recommended constant for the active `modelClass`, if it
 *      appears in the live inventory.
 *   3. The first inventory row.
 *
 * Cross-class recommendations never set `initialValue`. The cursor
 * placement this produces is a hint to Clack, NOT a write — the
 * operator can still arrow anywhere before pressing Enter.
 */
export function resolveIdentityInitialValue(args: {
  readonly inventory: readonly ModelIdentity[];
  readonly currentIdentity: ModelIdentity | null;
  readonly recommended: RecommendedModelIds;
  readonly modelClass: ModelClass;
}): ModelIdentity | undefined {
  const identities = new Set(args.inventory);
  if (args.currentIdentity !== null && identities.has(args.currentIdentity)) {
    return args.currentIdentity;
  }
  const classRecommended = args.recommended[args.modelClass];
  if (identities.has(classRecommended)) return classRecommended;
  const first = args.inventory[0];
  return first;
}

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

export interface RunModelSelectorArgs {
  readonly inventory: Iterable<string>;
  readonly modelClass: ModelClass;
  readonly recommended?: RecommendedModelIds;
  readonly currentIdentity?: ModelIdentity | null;
  readonly title?: string;
  readonly cancelError?: PoiesisError;
}

/**
 * Run the model identity selector through the Clack adapter. Returns
 * the chosen `ModelIdentity`.
 *
 * Failure modes (always `PoiesisError` so callers can branch on
 * `error.code`):
 *   - `MODEL_SELECTOR_NOT_TTY`     -- `process.stdin.isTTY === false`
 *   - `MODEL_SELECTOR_NO_INVENTORY` -- normalized inventory is empty
 *   - The caller-supplied `cancelError` (default
 *     `MODEL_SELECTOR_CANCELLED`) -- operator pressed Esc / Ctrl+C
 */
export async function runModelSelector(args: RunModelSelectorArgs): Promise<ModelIdentity> {
  if (process.stdin.isTTY !== true) {
    throw new PoiesisError(
      "MODEL_SELECTOR_NOT_TTY",
      "Interactive model selector requires a TTY; pass --non-tty or use a non-interactive workflow",
    );
  }
  const identities = normalizeInventory(args.inventory);
  if (identities.length === 0) {
    throw new PoiesisError(
      "MODEL_SELECTOR_NO_INVENTORY",
      "OpenCode model inventory is empty; cannot offer a selection",
    );
  }
  const recommended = args.recommended ?? DEFAULT_RECOMMENDED_MODEL_IDS;
  const currentIdentity = args.currentIdentity ?? null;
  const rows = buildModelSelectorRows({ identities, recommended, currentIdentity });
  const options: ClackSelectRow<ModelIdentity>[] = rows.map((row) => {
    const hint = formatModelSelectorHint(row.hints, args.modelClass);
    // Drop the hint entirely when the row carries no flag — Clack's
    // option shape uses exact-optional `hint?: string`, so a literal
    // `""` would render as a blank hint instead of "no hint at all".
    if (hint === "") {
      return { value: row.identity, label: row.identity };
    }
    return { value: row.identity, label: row.identity, hint };
  });
  const initialValue = resolveIdentityInitialValue({
    inventory: identities,
    currentIdentity,
    recommended,
    modelClass: args.modelClass,
  });
  const message = args.title ?? `Select a ${args.modelClass} model`;
  return runClackSelect<ModelIdentity>({
    message,
    options,
    ...(initialValue === undefined ? {} : { initialValue }),
    cancelError:
      args.cancelError ?? new PoiesisError("MODEL_SELECTOR_CANCELLED", "Model selection was cancelled by the user", { modelClass: args.modelClass }),
  });
}
/**
 * Ticket #73 — model selector with Clack `select`.
 *
 * Acceptance contract (Poiesis-owned semantics only — we deliberately do
 * NOT re-test Clack's arrow / Enter / Esc / raw-mode handling because
 * that surface is library code):
 *
 *   - `buildModelSelectorRows` marks `isCurrent` / `isRecommended` /
 *     `recommendedFor` exactly when the identity matches the canonical
 *     constant or the supplied current; no cousin / fuzzy substitute.
 *   - `formatModelSelectorHint` renders the four documented shapes:
 *       "" | "Current" | "Recommended" | "Current, Recommended"
 *     plus the cross-class "Recommended (class)" variant.
 *   - `resolveIdentityInitialValue` policy:
 *       1. current identity if it is in inventory,
 *       2. else this-class recommended if it is in inventory,
 *       3. else the first inventory row.
 *     Cross-class recommendation NEVER sets `initialValue`.
 *   - `runModelSelector` fails closed with `MODEL_SELECTOR_NOT_TTY`
 *     when `process.stdin.isTTY !== true` and with
 *     `MODEL_SELECTOR_NO_INVENTORY` for an empty / blank-only
 *     inventory. It translates Clack's `CANCEL_SYMBOL` into the
 *     caller-supplied `PoiesisError` and delegates the success path to
 *     the CLI-internal `runClackSelect` adapter.
 *
 * The previous keypress / raw-mode / `setRawMode` regression suite
 * (tickets #65 / #66) is intentionally NOT present: Clack owns that
 * surface now and re-testing it would lock the Poiesis CLI to the
 * current Clack internals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoiesisError } from "../src/errors.js";
import {
  DEFAULT_RECOMMENDED_MODEL_IDS,
  buildModelSelectorRows,
  formatModelSelectorHint,
  resolveIdentityInitialValue,
  runModelSelector,
} from "../src/model-selector.js";

// `vi.mock` is hoisted to the top of the file BEFORE any top-level
// statement runs. We can't read a `const` declared below from inside
// the factory closure. The factory uses a globally-namespaced holder
// keyed by a `Symbol.for(...)` value, so the same key survives the
// module-graph reload and the test body resolves it lazily.

vi.mock("@clack/prompts", () => {
  const scope = globalThis as unknown as Record<symbol, {
    select: ReturnType<typeof vi.fn>;
    isCancel: ReturnType<typeof vi.fn>;
    cancelSymbol: symbol;
  }>;
  const key = Symbol.for("poiesis.model-selector.fake-holder");
  if (scope[key] === undefined) {
    scope[key] = {
      select: vi.fn(),
      isCancel: vi.fn(),
      cancelSymbol: Symbol.for("clack.cancel"),
    };
  }
  const holder = scope[key]!;
  return {
    isCancel: (value: unknown) => holder.isCancel(value),
    select: (opts: unknown) => holder.select(opts),
    CANCEL_SYMBOL: holder.cancelSymbol,
  };
});

const fakeHolderKey = Symbol.for("poiesis.model-selector.fake-holder");
const globalScope = globalThis as unknown as Record<symbol, {
  select: ReturnType<typeof vi.fn>;
  isCancel: ReturnType<typeof vi.fn>;
  cancelSymbol: symbol;
}>;
const fakes = globalScope[fakeHolderKey]!;
const cancelSymbol = fakes.cancelSymbol;
const fakeSelect = fakes.select;
const fakeIsCancel = fakes.isCancel;

const REASONING = "openai/gpt-5.6-sol";
const EXECUTION = "minimax/MiniMax-M3";
const INVENTORY = [
  REASONING,
  "openai/gpt-4o",
  EXECUTION,
  "anthropic/claude-sonnet-4.5",
];

const INVENTORY_NO_RECOMMENDED = [
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4.5",
  "minimax/some-other-model",
];

describe("buildModelSelectorRows + formatModelSelectorHint (ticket #73)", () => {
  it("marks Current only on the row that matches the current identity", () => {
    const rows = buildModelSelectorRows({
      identities: INVENTORY,
      recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
      currentIdentity: EXECUTION,
    });
    const currentRows = rows.filter((row) => row.hints.isCurrent);
    expect(currentRows.map((row) => row.identity)).toEqual([EXECUTION]);
    expect(currentRows[0]!.hints.isRecommended).toBe(true);
    expect(currentRows[0]!.hints.recommendedFor).toBe("execution");
  });

  it("marks Recommended only on the rows that match the canonical constants", () => {
    const rows = buildModelSelectorRows({
      identities: INVENTORY,
      recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
      currentIdentity: null,
    });
    const recommendedIdentities = rows.filter((row) => row.hints.isRecommended).map((row) => row.identity);
    expect(recommendedIdentities.sort()).toEqual([EXECUTION, REASONING].sort());
    const executionRow = rows.find((row) => row.identity === EXECUTION)!;
    expect(executionRow.hints.recommendedFor).toBe("execution");
    const reasoningRow = rows.find((row) => row.identity === REASONING)!;
    expect(reasoningRow.hints.recommendedFor).toBe("reasoning");
  });

  it("marks both Current AND Recommended when the current identity happens to be the recommended constant", () => {
    const rows = buildModelSelectorRows({
      identities: INVENTORY,
      recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
      currentIdentity: REASONING,
    });
    const row = rows.find((candidate) => candidate.identity === REASONING)!;
    expect(row.hints.isCurrent).toBe(true);
    expect(row.hints.isRecommended).toBe(true);
    expect(row.hints.recommendedFor).toBe("reasoning");
    expect(formatModelSelectorHint(row.hints, "reasoning")).toBe("Current, Recommended");
  });

  it("never marks a row as Recommended when its identity does not match either canonical constant (no cousin substitute)", () => {
    const rows = buildModelSelectorRows({
      identities: INVENTORY_NO_RECOMMENDED,
      recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
      currentIdentity: null,
    });
    expect(rows.every((row) => row.hints.isRecommended === false)).toBe(true);
    expect(rows.every((row) => row.hints.recommendedFor === null)).toBe(true);
    expect(rows.every((row) => formatModelSelectorHint(row.hints, "reasoning") === "")).toBe(true);
  });

  it("renders the four documented hint shapes", () => {
    // Active class = reasoning. Cross-class execution recommendations
    // get the "(execution)" extra hint text; same-class rows do not.
    expect(formatModelSelectorHint({ isCurrent: false, isRecommended: false, recommendedFor: null }, "reasoning")).toBe("");
    expect(formatModelSelectorHint({ isCurrent: true, isRecommended: false, recommendedFor: null }, "reasoning")).toBe("Current");
    expect(formatModelSelectorHint({ isCurrent: false, isRecommended: true, recommendedFor: "reasoning" }, "reasoning")).toBe("Recommended");
    expect(formatModelSelectorHint({ isCurrent: false, isRecommended: true, recommendedFor: "execution" }, "reasoning")).toBe(
      "Recommended (execution)",
    );
    expect(formatModelSelectorHint({ isCurrent: true, isRecommended: true, recommendedFor: "reasoning" }, "reasoning")).toBe(
      "Current, Recommended",
    );
    expect(formatModelSelectorHint({ isCurrent: true, isRecommended: true, recommendedFor: "execution" }, "reasoning")).toBe(
      "Current, Recommended (execution)",
    );
    // Active class = execution: cross-class reasoning rows now show
    // "(reasoning)" while execution-class rows stay plain.
    expect(formatModelSelectorHint({ isCurrent: false, isRecommended: true, recommendedFor: "execution" }, "execution")).toBe(
      "Recommended",
    );
    expect(formatModelSelectorHint({ isCurrent: false, isRecommended: true, recommendedFor: "reasoning" }, "execution")).toBe(
      "Recommended (reasoning)",
    );
  });

  it("preserves the inventory order in the produced rows", () => {
    const rows = buildModelSelectorRows({
      identities: INVENTORY,
      recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
      currentIdentity: null,
    });
    expect(rows.map((row) => row.identity)).toEqual(INVENTORY);
  });
});

describe("resolveIdentityInitialValue (ticket #73 policy)", () => {
  const recommended = DEFAULT_RECOMMENDED_MODEL_IDS;

  it("preselects the current identity when it is in inventory", () => {
    expect(
      resolveIdentityInitialValue({
        inventory: INVENTORY,
        currentIdentity: "anthropic/claude-sonnet-4.5",
        recommended,
        modelClass: "reasoning",
      }),
    ).toBe("anthropic/claude-sonnet-4.5");
  });

  it("preselects the this-class recommended identity when current is absent", () => {
    expect(
      resolveIdentityInitialValue({
        inventory: INVENTORY,
        currentIdentity: null,
        recommended,
        modelClass: "reasoning",
      }),
    ).toBe(REASONING);
  });

  it("falls back to the first inventory row when neither current nor recommended is present", () => {
    expect(
      resolveIdentityInitialValue({
        inventory: INVENTORY_NO_RECOMMENDED,
        currentIdentity: null,
        recommended,
        modelClass: "reasoning",
      }),
    ).toBe(INVENTORY_NO_RECOMMENDED[0]);
  });

  it("does NOT preselect a cross-class recommended identity", () => {
    // Reasoning selector, current is the execution recommended, no
    // reasoning recommended in inventory — must fall back to the
    // first row, NOT to the execution recommended.
    const result = resolveIdentityInitialValue({
      inventory: INVENTORY_NO_RECOMMENDED,
      currentIdentity: null,
      recommended: { reasoning: "missing/reasoning", execution: EXECUTION },
      modelClass: "reasoning",
    });
    expect(result).toBe(INVENTORY_NO_RECOMMENDED[0]);
  });

  it("treats a current identity that is not in inventory the same as no current", () => {
    expect(
      resolveIdentityInitialValue({
        inventory: INVENTORY,
        currentIdentity: "openai/not-in-inventory",
        recommended,
        modelClass: "execution",
      }),
    ).toBe(EXECUTION);
  });
});

describe("runModelSelector (ticket #73)", () => {
  // `process.stdin` is a getter-only host symbol in Node; we mutate
  // `isTTY` directly on it instead of swapping the whole stream
  // reference. The selector reads `process.stdin.isTTY` at call time
  // so swapping just the boolean is enough to drive every branch.
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    fakeSelect.mockReset();
    fakeIsCancel.mockReset();
    fakeIsCancel.mockImplementation((value: unknown) => value === cancelSymbol);
  });

  afterEach(() => {
    if (originalIsTTY === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
    }
  });

  it("fails closed with MODEL_SELECTOR_NOT_TTY when stdin is not a TTY", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    await expect(
      runModelSelector({ inventory: INVENTORY, modelClass: "reasoning" }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_NOT_TTY" });
    expect(fakeSelect).not.toHaveBeenCalled();
  });

  it("fails closed with MODEL_SELECTOR_NO_INVENTORY for an empty inventory", async () => {
    await expect(
      runModelSelector({ inventory: [], modelClass: "reasoning" }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_NO_INVENTORY" });
    expect(fakeSelect).not.toHaveBeenCalled();
  });

  it("fails closed with MODEL_SELECTOR_NO_INVENTORY when every entry is blank", async () => {
    await expect(
      runModelSelector({ inventory: ["", "   ", "\n"], modelClass: "reasoning" }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_NO_INVENTORY" });
    expect(fakeSelect).not.toHaveBeenCalled();
  });

  it("translates Clack CANCEL_SYMBOL into the caller-supplied cancelError", async () => {
    fakeSelect.mockResolvedValueOnce(cancelSymbol as never);
    const cancelError = new PoiesisError("MODEL_SELECTOR_CANCELLED", "cancelled", { modelClass: "reasoning" });
    await expect(
      runModelSelector({
        inventory: INVENTORY,
        modelClass: "reasoning",
        cancelError,
      }),
    ).rejects.toBe(cancelError);
  });

  it("translates Clack CANCEL_SYMBOL into the default MODEL_SELECTOR_CANCELLED when no cancelError is supplied", async () => {
    fakeSelect.mockResolvedValueOnce(cancelSymbol as never);
    await expect(
      runModelSelector({ inventory: INVENTORY, modelClass: "reasoning" }),
    ).rejects.toMatchObject({ code: "MODEL_SELECTOR_CANCELLED", details: { modelClass: "reasoning" } });
  });

  it("returns the chosen identity and applies the initialValue policy", async () => {
    fakeSelect.mockResolvedValueOnce("anthropic/claude-sonnet-4.5" as never);
    const chosen = await runModelSelector({
      inventory: INVENTORY,
      modelClass: "reasoning",
      currentIdentity: "anthropic/claude-sonnet-4.5",
    });
    expect(chosen).toBe("anthropic/claude-sonnet-4.5");
    const callArg = fakeSelect.mock.calls[0]![0] as {
      options: Array<{ value: string; hint?: string }>;
      initialValue?: string;
      message: string;
    };
    expect(callArg.message).toBe("Select a reasoning model");
    // The execution-class recommendation must be marked in its hint,
    // never as `initialValue`.
    expect(callArg.initialValue).toBe("anthropic/claude-sonnet-4.5");
    const executionRow = callArg.options.find((option) => option.value === EXECUTION)!;
    expect(executionRow.hint).toMatch(/Recommended/);
  });

  it("marks Current + Recommended when the current identity is also a recommended constant", async () => {
    fakeSelect.mockResolvedValueOnce(REASONING as never);
    await runModelSelector({
      inventory: INVENTORY,
      modelClass: "reasoning",
      currentIdentity: REASONING,
    });
    const callArg = fakeSelect.mock.calls[0]![0] as {
      options: Array<{ value: string; hint?: string }>;
      initialValue?: string;
    };
    const row = callArg.options.find((option) => option.value === REASONING)!;
    expect(row.hint).toBe("Current, Recommended");
    expect(callArg.initialValue).toBe(REASONING);
  });

  it("falls back to the first row when neither current nor recommended are in inventory", async () => {
    fakeSelect.mockResolvedValueOnce(INVENTORY_NO_RECOMMENDED[0]! as never);
    await runModelSelector({
      inventory: INVENTORY_NO_RECOMMENDED,
      modelClass: "execution",
    });
    const callArg = fakeSelect.mock.calls[0]![0] as {
      options: Array<{ value: string; hint?: string }>;
      initialValue?: string;
    };
    expect(callArg.initialValue).toBe(INVENTORY_NO_RECOMMENDED[0]);
    expect(callArg.options.every((option) => option.hint === undefined)).toBe(true);
  });

  it("uses an explicit title when supplied", async () => {
    fakeSelect.mockResolvedValueOnce(REASONING as never);
    await runModelSelector({
      inventory: INVENTORY,
      modelClass: "reasoning",
      title: "Pick a reasoning model",
    });
    const callArg = fakeSelect.mock.calls[0]![0] as { message: string };
    expect(callArg.message).toBe("Pick a reasoning model");
  });

  it("accepts custom recommended identities and uses them for hints + initialValue", async () => {
    fakeSelect.mockResolvedValueOnce(REASONING as never);
    // The custom set still includes both REASONING and EXECUTION in
    // the inventory — the test confirms the custom recommended is
    // applied for initialValue AND the cross-class annotation fires
    // for the execution row even though execution is NOT the active
    // modelClass.
    const custom = { reasoning: REASONING, execution: EXECUTION };
    await runModelSelector({
      inventory: INVENTORY,
      modelClass: "reasoning",
      recommended: custom,
      currentIdentity: null,
    });
    const callArg = fakeSelect.mock.calls[0]![0] as {
      options: Array<{ value: string; hint?: string }>;
      initialValue?: string;
    };
    expect(callArg.initialValue).toBe(REASONING);
    const reasoningRow = callArg.options.find((option) => option.value === REASONING)!;
    expect(reasoningRow.hint).toBe("Recommended");
    // The execution-class recommended identity is still annotated as
    // "Recommended (execution)" because the cross-class marker
    // fires when the row's `recommendedFor` does NOT match the
    // active modelClass.
    const executionRow = callArg.options.find((option) => option.value === EXECUTION)!;
    expect(executionRow.hint).toBe("Recommended (execution)");
  });
});

describe("DEFAULT_RECOMMENDED_MODEL_IDS (ticket #73)", () => {
  it("keeps the canonical constants", () => {
    expect(DEFAULT_RECOMMENDED_MODEL_IDS.reasoning).toBe("openai/gpt-5.6-sol");
    expect(DEFAULT_RECOMMENDED_MODEL_IDS.execution).toBe("minimax/MiniMax-M3");
  });
});
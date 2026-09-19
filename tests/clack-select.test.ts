/**
 * Ticket #73 — CLI-internal Clack `select` adapter.
 *
 * The adapter is the SINGLE interactive list primitive in the Poiesis
 * CLI. Its job is to:
 *
 *   - Route every frame to stderr (human channel) — never to stdout
 *     (the structured-JSON channel).
 *   - Translate Clack's `CANCEL_SYMBOL` into the caller-supplied
 *     `PoiesisError`, so the per-flow cancel codes
 *     (`MODEL_SELECTOR_CANCELLED`, `MODEL_CLASS_SELECTOR_CANCELLED`,
 *     `INIT_MODEL_SELECTOR_CANCELLED`, ...) stay distinct.
 *   - Resume `process.stdin` from a `finally` so a subsequent
 *     interactive seam on the same process (a second `select`, a
 *     follow-up `settleOnceLinePrompt`) sees a flowing stdin.
 *
 * These tests exercise the adapter's three guarantees with a
 * hand-built fake `@clack/prompts` import. Real Clack is not invoked:
 * under Vitest there is no TTY, and the adapter's only production
 * caller (`runModelSelector`) checks `process.stdin.isTTY` and throws
 * `MODEL_SELECTOR_NOT_TTY` first. The tests instead import the adapter
 * with a dynamic-import seam that swaps `@clack/prompts` for a stub
 * whose `select` returns either a value or the `CANCEL_SYMBOL`. That
 * keeps the assertion surface focused on the adapter's contract
 * without touching the wider library seam.
 *
 * NOTE on implementation: Vitest module resolution is static per file
 * unless we use `vi.mock(...)`. We use `vi.mock` because the adapter
 * imports `select` and `isCancel` from `@clack/prompts` at module
 * scope; replacing the module after the import has already resolved is
 * too late. The mock is scoped to this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

// `vi.mock` is hoisted to the top of the file BEFORE any top-level
// statement runs. We can't read a `const` declared below from inside
// the factory closure. So the factory uses a globally-namespaced
// holder that's set up by `beforeAll` and reused across every test
// below — the holder itself is the same `vi.fn()` instance the test
// body sees, but the mock factory reaches it via a `Symbol.for(...)`
// key on `globalThis`, which resolves at runtime, not at hoist time.

vi.mock("@clack/prompts", () => {
  const scope = globalThis as unknown as Record<symbol, {
    select: ReturnType<typeof vi.fn>;
    isCancel: ReturnType<typeof vi.fn>;
    cancelSymbol: symbol;
  }>;
  const key = Symbol.for("poiesis.clack-select.fake-holder");
  if (scope[key] === undefined) {
    // Vitest clears `vi.fn()` state between tests, so we always create
    // a fresh pair if the holder hasn't been seeded yet. The first
    // test body resets them to a known shape anyway.
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

import { PoiesisError } from "../src/errors.js";
import { runClackSelect } from "../src/clack-select.js";

const fakeHolderKey = Symbol.for("poiesis.clack-select.fake-holder");
const globalScope = globalThis as unknown as Record<symbol, {
  select: ReturnType<typeof vi.fn>;
  isCancel: ReturnType<typeof vi.fn>;
  cancelSymbol: symbol;
}>;
const fakes = globalScope[fakeHolderKey]!;
const cancelSymbol = fakes.cancelSymbol;
const fakeSelect = fakes.select;
const fakeIsCancel = fakes.isCancel;

describe("runClackSelect (ticket #73 adapter)", () => {
  // We mutate properties on `process.stdin` directly because
  // `process.stdin` is a getter-only host symbol. The adapter reads
  // `process.stdin` and `process.stdin.isTTY` at call time, so swapping
  // out `isTTY` is enough to drive the adapter's TTY branch without
  // trying to reassign the whole stream reference.
  let originalIsTTY: boolean | undefined;
  let fakeResumeCalls: number;

  beforeEach(() => {
    originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    fakeResumeCalls = 0;
    // Override `resume` so the test can count calls without taking a
    // dependency on Vitest's `vi.spyOn`. We restore by deleting the
    // property in `afterEach`.
    (process.stdin as unknown as { resume: () => void }).resume = () => {
      fakeResumeCalls += 1;
    };
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
    delete (process.stdin as { resume?: () => void }).resume;
  });

  it("calls Clack select with output=process.stderr and the supplied rows", async () => {
    fakeSelect.mockResolvedValueOnce("ok" as never);
    const cancelError = new PoiesisError("X_CANCEL", "cancelled");
    await runClackSelect({
      message: "Pick one",
      options: [
        { value: "ok", label: "OK" },
        { value: "no", label: "No", hint: "second" },
      ],
      initialValue: "ok",
      cancelError,
    });
    expect(fakeSelect).toHaveBeenCalledTimes(1);
    const callArg = fakeSelect.mock.calls[0]![0] as {
      message: string;
      options: Array<{ value: string; label: string; hint?: string }>;
      initialValue?: string;
      output: unknown;
      input: unknown;
    };
    expect(callArg.message).toBe("Pick one");
    expect(callArg.output).toBe(process.stderr);
    expect(callArg.input).toBe(process.stdin);
    expect(callArg.initialValue).toBe("ok");
    expect(callArg.options.map((option) => option.value)).toEqual(["ok", "no"]);
    expect(callArg.options[1]!.hint).toBe("second");
    // The first row omits the `hint` property when not supplied so the
    // exact-optional Clack options don't see `hint: undefined`.
    expect("hint" in callArg.options[0]!).toBe(false);
  });

  it("returns the resolved value verbatim and resumes stdin", async () => {
    fakeSelect.mockResolvedValueOnce("chosen" as never);
    const result = await runClackSelect({
      message: "Pick",
      options: [{ value: "chosen", label: "Chosen" }],
      cancelError: new PoiesisError("X_CANCEL", "cancelled"),
    });
    expect(result).toBe("chosen");
    expect(fakeResumeCalls).toBe(1);
  });

  it("translates Clack's CANCEL_SYMBOL into the caller-supplied PoiesisError", async () => {
    fakeSelect.mockResolvedValueOnce(cancelSymbol as never);
    const cancelError = new PoiesisError("MODEL_CLASS_SELECTOR_CANCELLED", "cancelled", {});
    await expect(
      runClackSelect({
        message: "Pick",
        options: [{ value: "x", label: "X" }],
        cancelError,
      }),
    ).rejects.toBe(cancelError);
  });

  it("resumes stdin even when select() throws", async () => {
    fakeSelect.mockRejectedValueOnce(new Error("boom"));
    const cancelError = new PoiesisError("X_CANCEL", "cancelled");
    await expect(
      runClackSelect({
        message: "Pick",
        options: [{ value: "x", label: "X" }],
        cancelError,
      }),
    ).rejects.toThrow("boom");
    expect(fakeResumeCalls).toBe(1);
  });

  it("does not force-resume a stdin that has ended (ticket #71 hygiene)", async () => {
    // `process.stdin.readableEnded` is a getter-only property in
    // Node, so we route the "ended" check through a stand-in field
    // and assert the negative branch directly on `resume`. The
    // adapter's contract is "skip resume when the stream reports
    // ended"; we exercise that by giving it a `destroyed: true`
    // stand-in via a temporary property we control.
    const originalDestroyed = (process.stdin as unknown as { destroyed?: unknown }).destroyed;
    Object.defineProperty(process.stdin, "destroyed", { configurable: true, value: true });
    try {
      fakeSelect.mockResolvedValueOnce("ok" as never);
      await runClackSelect({
        message: "Pick",
        options: [{ value: "ok", label: "OK" }],
        cancelError: new PoiesisError("X_CANCEL", "cancelled"),
      });
      expect(fakeResumeCalls).toBe(0);
    } finally {
      Object.defineProperty(process.stdin, "destroyed", { configurable: true, value: originalDestroyed });
    }
  });
});
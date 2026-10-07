/**
 * Spec #168 / ticket #172 — focused-check classifier, resource-pressure
 * evidence, timeout-state derivation, and progress-redaction contract.
 *
 * These are the pure seams of the one scope-aware executor in
 * `src/focused-check.ts`. They are exercised without a repository so the
 * deterministic failure vocabulary, the "classification never turns failure
 * into success" invariant, the bounded pressure evidence, and the
 * output-free/secret-free progress rendering are all provable on their own.
 *
 * The executor-level behaviour (explicit commands, dirty owned workspace,
 * bounded output truncation, managed process execution, no receipt, no
 * retry, proof-scope authority) is covered in
 * `tests/focused-check-executor.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { PoiesisError } from "../src/errors.js";
import { DEFAULT_VERIFY_TIMEOUT_MS } from "../src/process.js";
import {
  CHECK_FAILURE_CLASSIFICATIONS,
  DEFAULT_FOCUSED_CHECK_TIMEOUT_MS,
  resolveCheckTimeoutMs,
  CHECK_PROGRESS_ACTIONS,
  CHECK_PROGRESS_PHASES,
  CHECK_RETRY_REASONS,
  classifyCheckFailure,
  createStderrCheckProgress,
  deriveCheckTimeoutState,
  renderCheckProgressLine,
  sampleResourcePressure,
  summarizeResourcePressure,
  type CheckClassification,
  type CheckFailureInput,
  type CheckProgressEvent,
  type CheckRetryReason,
  type CheckTimeoutState,
  type ResourcePressureSample,
} from "../src/focused-check.js";

const CALM: ResourcePressureSample = {
  loadAverage1m: 0.1,
  parallelism: 8,
  freeMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
};

const SATURATED: ResourcePressureSample = {
  loadAverage1m: 32,
  parallelism: 8,
  freeMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
};

const UNKNOWN_PRESSURE: ResourcePressureSample = {
  loadAverage1m: null,
  parallelism: null,
  freeMemoryBytes: null,
  totalMemoryBytes: null,
};

function failure(overrides: Partial<CheckFailureInput> = {}): CheckFailureInput {
  return {
    timeoutState: "not-timed-out",
    exitCode: 1,
    infrastructure: false,
    dirtyCandidate: false,
    pressure: null,
    ...overrides,
  };
}

describe("focused failure classification (Spec #168 / ticket #172)", () => {
  it("classifies a non-zero command exit as a non-zero command failure", () => {
    expect(classifyCheckFailure(failure({ exitCode: 7 }))).toBe("command-failed");
  });

  it("classifies a settled process timeout without pressure evidence as a process timeout", () => {
    expect(
      classifyCheckFailure(failure({ timeoutState: "timed-out", exitCode: null, pressure: summarizeResourcePressure([CALM]) })),
    ).toBe("timeout");
  });

  it("classifies a timeout with sampled resource pressure as likely load-induced", () => {
    expect(
      classifyCheckFailure(
        failure({ timeoutState: "timed-out", exitCode: null, pressure: summarizeResourcePressure([SATURATED]) }),
      ),
    ).toBe("likely-load-induced-timeout");
  });

  it("does NOT classify a timeout as load-induced without sampled pressure evidence", () => {
    expect(classifyCheckFailure(failure({ timeoutState: "timed-out", exitCode: null, pressure: null }))).toBe("timeout");
    expect(
      classifyCheckFailure(
        failure({ timeoutState: "timed-out", exitCode: null, pressure: summarizeResourcePressure([UNKNOWN_PRESSURE]) }),
      ),
    ).toBe("timeout");
  });

  it("classifies an indeterminate timeout state as timeout-unknown", () => {
    expect(
      classifyCheckFailure(failure({ timeoutState: "unknown", exitCode: null, infrastructure: true })),
    ).toBe("timeout-unknown");
  });

  it("classifies a managed-runner rejection as an infrastructure failure", () => {
    expect(classifyCheckFailure(failure({ exitCode: null, infrastructure: true }))).toBe("infrastructure");
  });

  it("classifies an unattributable failure as infrastructure rather than success", () => {
    expect(classifyCheckFailure(failure({ exitCode: 0 }))).toBe("infrastructure");
  });

  it("classifies a dirty exact candidate ahead of every other failure signal", () => {
    expect(
      classifyCheckFailure(
        failure({
          dirtyCandidate: true,
          timeoutState: "timed-out",
          exitCode: 9,
          infrastructure: true,
          pressure: summarizeResourcePressure([SATURATED]),
        }),
      ),
    ).toBe("dirty-candidate");
  });

  it("prefers timeout-unknown over a plain infrastructure failure", () => {
    expect(classifyCheckFailure(failure({ timeoutState: "unknown", exitCode: 3, infrastructure: true }))).toBe(
      "timeout-unknown",
    );
  });

  it("never returns a success classification for any failure input", () => {
    const states: CheckTimeoutState[] = ["not-timed-out", "timed-out", "unknown"];
    const pressures = [null, summarizeResourcePressure([CALM]), summarizeResourcePressure([SATURATED])];
    const seen = new Set<CheckClassification>();
    for (const timeoutState of states) {
      for (const exitCode of [null, 0, 1, 124]) {
        for (const infrastructure of [false, true]) {
          for (const dirtyCandidate of [false, true]) {
            for (const pressure of pressures) {
              seen.add(
                classifyCheckFailure(failure({ timeoutState, exitCode, infrastructure, dirtyCandidate, pressure })),
              );
            }
          }
        }
      }
    }
    expect(seen.has("passed")).toBe(false);
    expect([...seen].sort()).toEqual([...CHECK_FAILURE_CLASSIFICATIONS].sort());
  });
});

describe("per-scope timeout bounds (Spec #168 / ticket #172)", () => {
  it("keeps proof scope on verify's ten-minute whole-change bound", () => {
    // Regression guard: proof scope delegates to `verify`, whose documented
    // bound is ten minutes. Reusing the (much shorter) focused default would
    // silently start timing out legitimate whole-change suites.
    expect(resolveCheckTimeoutMs("proof", undefined)).toBe(DEFAULT_VERIFY_TIMEOUT_MS);
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it("keeps focused scope on its own short default", () => {
    expect(resolveCheckTimeoutMs("focused", undefined)).toBe(DEFAULT_FOCUSED_CHECK_TIMEOUT_MS);
    expect(DEFAULT_FOCUSED_CHECK_TIMEOUT_MS).toBeLessThan(DEFAULT_VERIFY_TIMEOUT_MS);
  });

  it("honors an explicit bound in both scopes", () => {
    expect(resolveCheckTimeoutMs("proof", 5_000)).toBe(5_000);
    expect(resolveCheckTimeoutMs("focused", 5_000)).toBe(5_000);
  });

  it("refuses an out-of-range bound in both scopes", () => {
    expect(() => resolveCheckTimeoutMs("proof", 0)).toThrow();
    expect(() => resolveCheckTimeoutMs("focused", 0)).toThrow();
    expect(() => resolveCheckTimeoutMs("proof", 30 * 60_000 + 1)).toThrow();
    expect(() => resolveCheckTimeoutMs("focused", 1.5)).toThrow();
  });
});

describe("bounded resource-pressure evidence (Spec #168 / ticket #172)", () => {
  it("reports a calm host as not pressured with bounded ratios", () => {
    const evidence = summarizeResourcePressure([CALM]);
    expect(evidence).toEqual({ samples: 1, peakLoadPerCpu: 0.01, minFreeMemoryFraction: 0.5, pressured: false });
  });

  it("reports a saturated host as pressured and keeps the peak across samples", () => {
    const evidence = summarizeResourcePressure([CALM, SATURATED]);
    expect(evidence.samples).toBe(2);
    expect(evidence.peakLoadPerCpu).toBe(4);
    expect(evidence.pressured).toBe(true);
  });

  it("reports low free memory as pressured even when load is calm", () => {
    const evidence = summarizeResourcePressure([
      { loadAverage1m: 0.2, parallelism: 8, freeMemoryBytes: 512 * 1024 * 1024, totalMemoryBytes: 16 * 1024 ** 3 },
    ]);
    expect(evidence.minFreeMemoryFraction).toBe(0.03);
    expect(evidence.pressured).toBe(true);
  });

  it("stays unpressured and null-valued when the host reports no counters", () => {
    expect(summarizeResourcePressure([UNKNOWN_PRESSURE])).toEqual({
      samples: 1,
      peakLoadPerCpu: null,
      minFreeMemoryFraction: null,
      pressured: false,
    });
  });

  it("rounds derived ratios so evidence cannot grow unbounded text", () => {
    const evidence = summarizeResourcePressure([
      { loadAverage1m: 1.23456789, parallelism: 3, freeMemoryBytes: 1, totalMemoryBytes: 3 },
    ]);
    expect(String(evidence.peakLoadPerCpu)).toHaveLength(4);
    expect(String(evidence.minFreeMemoryFraction)).toHaveLength(4);
  });

  it("ignores nonsensical counters rather than inventing pressure", () => {
    const evidence = summarizeResourcePressure([
      { loadAverage1m: -4, parallelism: 0, freeMemoryBytes: 900, totalMemoryBytes: 100 },
    ]);
    expect(evidence).toEqual({
      samples: 1,
      peakLoadPerCpu: null,
      minFreeMemoryFraction: null,
      pressured: false,
    });
  });

  it("produces a well-formed bounded sample from the live host", () => {
    const sample = sampleResourcePressure();
    expect(Object.keys(sample).sort()).toEqual([
      "freeMemoryBytes",
      "loadAverage1m",
      "parallelism",
      "totalMemoryBytes",
    ]);
    for (const value of Object.values(sample)) {
      if (value === null) continue;
      expect(Number.isFinite(value)).toBe(true);
    }
    const evidence = summarizeResourcePressure([sample]);
    expect(evidence.samples).toBe(1);
    expect(evidence.pressured === true || evidence.pressured === false).toBe(true);
  });
});

describe("timeout-state derivation (Spec #168 / ticket #172)", () => {
  it("reports a settled command as not timed out", () => {
    expect(deriveCheckTimeoutState(null, 12, 5_000)).toBe("not-timed-out");
  });

  it("reports a typed COMMAND_TIMEOUT as timed out", () => {
    expect(deriveCheckTimeoutState(new PoiesisError("COMMAND_TIMEOUT", "x"), 5_000, 5_000)).toBe("timed-out");
  });

  it("reports a cancellation below the bound as not timed out", () => {
    expect(deriveCheckTimeoutState(new PoiesisError("COMMAND_CANCELLED", "x"), 3, 5_000)).toBe("not-timed-out");
  });

  it("reports an untimed rejection below the bound as not timed out", () => {
    expect(deriveCheckTimeoutState(new PoiesisError("COMMAND_IO_ERROR", "x"), 7, 5_000)).toBe("not-timed-out");
  });

  it("reports an untimed rejection that consumed the whole bound as timeout-unknown", () => {
    expect(deriveCheckTimeoutState(new PoiesisError("COMMAND_IO_ERROR", "x"), 5_000, 5_000)).toBe("unknown");
    expect(deriveCheckTimeoutState(new PoiesisError("PROCESS_CLEANUP_FAILED", "x"), 9_999, 5_000)).toBe("unknown");
  });
});

describe("invocation-local progress events (Spec #168 / ticket #172)", () => {
  const event: CheckProgressEvent = {
    operationId: "poiesis-focused-0123456789abcdef",
    phase: "execute",
    action: "command-settled",
    elapsedMs: 4_201,
    index: 0,
    classification: "likely-load-induced-timeout",
  };

  it("publishes only the allow-listed bounded fields", () => {
    const rendered = JSON.parse(renderCheckProgressLine(event)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual([
      "action",
      "classification",
      "elapsedMs",
      "index",
      "operationId",
      "phase",
    ]);
    expect(rendered.classification).toBe("likely-load-induced-timeout");
    expect(renderCheckProgressLine(event)).not.toContain("\n");
  });

  it("renders the legitimate `passed` classification verbatim", () => {
    // `passed` is a real classification a `command-settled` event legitimately
    // carries. Collapsing it to `unknown` would make every green focused
    // command look unattributable in the progress stream.
    const rendered = JSON.parse(renderCheckProgressLine({ ...event, classification: "passed" })) as Record<string, unknown>;
    expect(rendered.classification).toBe("passed");
    expect(renderCheckProgressLine({ ...event, classification: "passed" })).toContain('"classification":"passed"');
  });

  it("renders every failure classification verbatim and still collapses hostile values", () => {
    for (const classification of CHECK_FAILURE_CLASSIFICATIONS) {
      expect(JSON.parse(renderCheckProgressLine({ ...event, classification })).classification).toBe(classification);
    }
    for (const hostile of ["PASSED", "passed ", "Passed", "ok", "", null, undefined]) {
      const rendered = JSON.parse(
        renderCheckProgressLine({ ...event, classification: hostile } as unknown as CheckProgressEvent),
      ) as { classification: unknown };
      expect(rendered.classification).toBe(hostile === null || hostile === undefined ? null : "unknown");
    }
  });

  it("includes an explicit retry reason only when one is supplied", () => {
    const withReason = renderCheckProgressLine({ ...event, retryReason: "mutation-since-last-attempt" });
    expect(JSON.parse(withReason)).toMatchObject({ retryReason: "mutation-since-last-attempt" });
    expect(renderCheckProgressLine(event)).not.toContain("retryReason");
  });

  it("coerces out-of-vocabulary tokens instead of emitting caller-supplied text", () => {
    const hostile = renderCheckProgressLine({
      operationId: "poiesis-focused-0123456789abcdef",
      phase: "SECRET=hunter2 stdout-of-the-command",
      action: "rm -rf /tmp/produced-by-attacker",
      elapsedMs: 1,
      index: 0,
      classification: "PASSED",
      retryReason: "please print my token",
    } as unknown as CheckProgressEvent);
    expect(JSON.parse(hostile)).toEqual({
      operationId: "poiesis-focused-0123456789abcdef",
      phase: "unknown",
      action: "unknown",
      elapsedMs: 1,
      index: 0,
      classification: "unknown",
    });
    expect(hostile).not.toContain("hunter2");
    expect(hostile).not.toContain("rm -rf");
  });

  it("bounds a non-numeric elapsed value and a non-integer index", () => {
    const rendered = JSON.parse(
      renderCheckProgressLine({
        ...event,
        elapsedMs: "x".repeat(400),
        index: -3,
      } as unknown as CheckProgressEvent),
    ) as { elapsedMs: number; index: number };
    expect(rendered.elapsedMs).toBe(0);
    expect(rendered.index).toBe(-3);
  });

  it("writes one newline-terminated JSON line per event to stderr", () => {
    const original = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      createStderrCheckProgress().emit(event);
    } finally {
      process.stderr.write = original;
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(chunks[0]!)).toMatchObject({ phase: "execute", index: 0 });
  });

  it("publishes closed vocabularies for phase, action, and retry reason", () => {
    expect([...CHECK_PROGRESS_PHASES]).toEqual(["resolve-authority", "execute", "settle"]);
    expect([...CHECK_PROGRESS_ACTIONS]).toEqual([
      "check-started",
      "command-started",
      "command-settled",
      "check-settled",
    ]);
    expect([...CHECK_RETRY_REASONS]).toEqual([
      "mutation-since-last-attempt",
      "new-hypothesis",
      "focused-recheck-authorized",
    ]);
  });

  it("accepts only a declared retry reason token", () => {
    const declared: CheckRetryReason = "new-hypothesis";
    expect(CHECK_RETRY_REASONS.includes(declared)).toBe(true);
    expect(
      CHECK_RETRY_REASONS.includes("because-i-want-to" as unknown as CheckRetryReason),
    ).toBe(false);
  });
});
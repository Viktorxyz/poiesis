/**
 * Spec #139 / ticket #149 — the STRUCTURAL contract of the URL userinfo
 * scanner, asserted through `scanUrlUserinfo` rather than through the
 * redacted text.
 *
 * The rule has to be true for output nobody can enumerate: any line a
 * `git` / `gh` / `glab` / verification command prints, in any order, at
 * any length. Two properties make that tractable, and neither is visible
 * in a handful of hand-written samples:
 *
 *   1. ONE left-to-right pass, with the withheld ranges handed back in
 *      increasing, non-overlapping order. A rule that re-scans — because
 *      a greedy authority run can swallow the `scheme://` of the next URL
 *      — emits ranges that can start inside a range it already emitted,
 *      and the two shapes then disagree about what the text says.
 *   2. A step count that grows with the input's LENGTH. A rule that
 *      restarts a search at every authority start, or that lets a regular
 *      expression retry a scheme candidate at every position of a long run
 *      of scheme characters, costs O(n^2) on a capture that is all one run
 *      — and a subprocess capture is exactly the untrusted, arbitrarily
 *      shaped input this rule exists to survive.
 *
 * Timing is asserted too, but only as a wide ceiling on a large
 * adversarial capture: wall-clock on a shared machine is unreliable, so
 * the load-bearing linearity evidence is the step count, and the timing
 * test exists to catch a regression large enough to be unmissable.
 */
import { describe, expect, it } from "vitest";
import { scanUrlUserinfo } from "../src/url-userinfo.js";

/**
 * An input built to punish a rule that re-searches. Every URL is followed
 * by a long run of scheme characters (`a` and `b` are both legal scheme
 * bytes) that no `://` ever completes, so a scanner which retries a
 * scheme candidate at each of those positions pays for the whole run once
 * per retry.
 */
function adversarial(repeat: number): string {
  return `https://u:p@h1,${"a".repeat(repeat)},https://v:w@h2 ${"b".repeat(repeat)} done`;
}

describe("the URL userinfo scanner's structure (Spec #139 / ticket #149)", () => {
  it("hands back the withheld userinfo of every URL of a chain, in the order it read them", () => {
    const input = "a https://one:tok1@h1, ssh://two:tok2@h2, git+ssh://three:tok3@h3/path b";
    const scan = scanUrlUserinfo(input);
    expect(scan.redactions.map((redaction) => input.slice(redaction.start, redaction.end))).toEqual([
      "one:tok1@",
      "two:tok2@",
      "three:tok3@",
    ]);
  });

  it("hands back ranges that never overlap and never go backwards", () => {
    const input = "remotes https://host1,https://a:b@host2 ssh://c:d@host3,p@q@host4 https://e:f@host5";
    const scan = scanUrlUserinfo(input);
    // One range per authority, not one per `@`: the middle authority's
    // userinfo runs through its LAST `@`, so the first URL contributes
    // nothing and the middle one contributes a single wide range.
    expect(scan.redactions.map((redaction) => input.slice(redaction.start, redaction.end))).toEqual([
      "a:b@",
      "c:d@host3,p@q@",
      "e:f@",
    ]);
    let previousEnd = 0;
    for (const redaction of scan.redactions) {
      expect(redaction.start).toBeGreaterThanOrEqual(previousEnd);
      expect(redaction.end).toBeGreaterThan(redaction.start);
      previousEnd = redaction.end;
    }
    expect(previousEnd).toBeLessThanOrEqual(input.length);
  });

  it("scans an adversarial capture in a number of steps bounded by its length", () => {
    const input = adversarial(4_000);
    const scan = scanUrlUserinfo(input);
    expect(scan.transitions).toBeLessThanOrEqual(3 * input.length);
  });

  it("costs no more steps per byte on a four-times longer adversarial capture", () => {
    const short = adversarial(2_000);
    const long = adversarial(8_000);
    const shortScan = scanUrlUserinfo(short);
    const longScan = scanUrlUserinfo(long);
    // A re-scanning rule's step count grows super-linearly here, because
    // every restart walks the long scheme-character run again.
    expect(longScan.transitions).toBeLessThanOrEqual(4 * shortScan.transitions);
  });

  it("sanitizes a one-megabyte adversarial capture without super-linear work", { timeout: 30_000 }, () => {
    const input = adversarial(500_000);
    const started = process.hrtime.bigint();
    const scan = scanUrlUserinfo(input);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(scan.transitions).toBeLessThanOrEqual(3 * input.length);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("reports no ranges for a capture with no absolute URL", () => {
    const scan = scanUrlUserinfo("contact owner@example.com, scp git@github.com:owner/repo.git\n");
    expect(scan.redactions).toEqual([]);
  });
});

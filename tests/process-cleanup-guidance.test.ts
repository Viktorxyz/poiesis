/**
 * Spec #168 / ticket #180 — the documented platform contract for group-local
 * cleanup.
 *
 * The implementation draws one line and it is easy to document wrongly: a
 * POSIX process group may be signalled ONLY while the leased leader that gave
 * the group its id can still be re-confirmed by exact process-start identity
 * and exact process-group id. Group liveness proves absence, never ownership,
 * so:
 *
 *   - Linux (the documented model) can confirm both fields, so a live managed
 *     group is settled through SIGTERM then SIGKILL;
 *   - a non-Linux POSIX platform has no readable process table, so a LIVE group
 *     there cannot be owned at all. Poiesis sends NO signal and rejects with
 *     `PROCESS_CLEANUP_REFUSED` / `UNSUPPORTED_IDENTITY` carrying the actionable
 *     `pid` and `processGroupId`, instead of pretending a termination happened;
 *   - a group that outlives its leader's provability is reported as
 *     `PROCESS_CLEANUP_UNRESOLVED` / `GROUP_AUTHORITY_LOST` with nothing
 *     further signalled, and a group that survives both phases under a provable
 *     leader is `GROUP_STILL_PRESENT`. Both envelopes apply to group-local
 *     cleanup, not only to the contained path;
 *   - the contained path is unchanged: `cgroup.kill` with a `populated 0`
 *     confirmation is the authority there, and no group signal follows it;
 *   - Windows is unchanged: no POSIX groups, `taskkill /PID <pid> /T` only
 *     while the child has not exited, and its own unresolved envelope.
 *
 * These assertions are the executable contract for the two documents that state
 * this to operators. A document that promises termination where the runtime can
 * only refuse is worse than no document, so the wording is pinned as tightly as
 * the behaviour is.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");

async function readReadme(): Promise<string> {
  return readFile(join(REPO_ROOT, "README.md"), "utf8");
}

async function readCompatibility(): Promise<string> {
  return readFile(join(REPO_ROOT, "COMPATIBILITY.md"), "utf8");
}

/** Both documents that describe the managed process lifecycle. */
async function documents(): Promise<Array<[string, string]>> {
  return [
    ["README.md", await readReadme()],
    ["COMPATIBILITY.md", await readCompatibility()],
  ];
}

describe("Spec #168 / ticket #180 — documented group-cleanup platform contract", () => {
  it.each([
    ["README.md", readReadme],
    ["COMPATIBILITY.md", readCompatibility],
  ])("%s names the readable process-start identity as the precondition for signalling a live group", async (_name, read) => {
    const text = await read();
    expect(text).toMatch(/process-start identity/);
    // The model is named, not implied: the identity comes from the kernel's
    // per-PID process table, which is a Linux facility.
    expect(text).toMatch(/process-start identity[^\n]*\bLinux\b|\bLinux\b[^\n]*process-start identity/);
  });

  it.each([
    ["README.md", readReadme],
    ["COMPATIBILITY.md", readCompatibility],
  ])("%s states the non-Linux POSIX refusal exactly: no signal, PROCESS_CLEANUP_REFUSED, UNSUPPORTED_IDENTITY", async (_name, read) => {
    const text = await read();
    expect(text).toMatch(/PROCESS_CLEANUP_REFUSED/);
    expect(text).toMatch(/UNSUPPORTED_IDENTITY/);
    // "Sends no signal" has to be stated: the point of the refusal is that
    // nothing was signalled, not that a weaker signal was sent.
    expect(text).toMatch(/sends?[^.\n]{0,6}no signal|no signal is sent|without sending a signal/i);
    // The actionable identity of the target it declined to touch.
    expect(text).toMatch(/`?details\.pid`?|`pid`/);
    expect(text).toMatch(/`?details\.processGroupId`?|`processGroupId`/);
  });

  it.each([
    ["README.md", readReadme],
    ["COMPATIBILITY.md", readCompatibility],
  ])("%s documents both group-cleanup failure envelopes, not only the contained path", async (_name, read) => {
    const text = await read();
    expect(text).toMatch(/PROCESS_CLEANUP_UNRESOLVED/);
    expect(text).toMatch(/GROUP_AUTHORITY_LOST/);
    // The unresolved reasons and the leader state that produced them.
    expect(text).toMatch(/GROUP_STILL_PRESENT/);
    expect(text).toMatch(/leaderState/);
    // The group-local case is named as its own scope, so a reader cannot
    // conclude the envelope only ever appears on a contained run.
    expect(text).toMatch(/group-local|group only|managed process group/i);
  });

  it("README no longer offers fixed-argv run() on macOS or the BSDs as equivalent cleanup", async () => {
    const readme = await readReadme();
    // The previous recommendation was unconditional. A caller on a platform
    // with no readable process table gets a typed refusal whenever a live
    // group needs cleaning, so that is the trade the document must name.
    expect(readme).toMatch(
      /fixed[- ]argv[^.]*refusal|refusal[^.]*fixed[- ]argv/i,
    );
    // And it must not survive anywhere as a bare recommendation.
    expect(readme).not.toMatch(
      /Use the library `run\(\)` seam with a fixed argv for work that does not need arbitrary command text on such a host\./,
    );
  });

  it("COMPATIBILITY stops promising unconditional SIGTERM-then-SIGKILL on timeout", async () => {
    const compatibility = await readCompatibility();
    // The old bullet claimed a termination that the runtime only performs on a
    // platform that can prove the group is still Poiesis's.
    expect(compatibility).not.toMatch(/^- safe SIGTERM then SIGKILL termination on timeout\.$/m);
    expect(compatibility).toMatch(/SIGTERM/);
    expect(compatibility).toMatch(/SIGKILL/);
  });

  it("preserves the Windows and cgroup model exactly as implemented", async () => {
    const compatibility = await readCompatibility();
    // Windows: no POSIX groups, a Job Object is still unavailable, and the
    // tree is reached through taskkill.
    expect(compatibility).toMatch(/Job Object/);
    expect(compatibility).toMatch(/taskkill/);
    // The contained path keeps its own authority and confirmation.
    expect(compatibility).toMatch(/cgroup\.kill/);
    expect(compatibility).toMatch(/cgroup\.events/);
    expect(compatibility).toMatch(/PROCESS_CONTAINMENT_UNAVAILABLE/);
    // And the pre-spawn refusal reasons are still the documented set.
    for (const reason of ["NO_CGROUP_V2", "NO_DELEGATION", "NO_CGROUP_KILL", "PROVISION_FAILED", "UNSUPPORTED_PLATFORM"]) {
      expect(compatibility).toContain(reason);
    }
  });

  it("documents the cgroup settlement as authoritative, with no group signal after it", async () => {
    for (const [name, text] of await documents()) {
      expect(text, `${name} does not state that the contained boundary is the authority`).toMatch(
        /authoritative|is the authority/,
      );
    }
  });

  it("never promises per-member identification or a survivor list", async () => {
    // Every mention has to be a denial. A line that names a survivor list or a
    // member enumeration without denying it is a promise the implementation
    // does not make.
    const denial = /\b(?:no|not|never|without|nothing|cannot|does not|neither)\b/i;
    for (const [name, text] of await documents()) {
      for (const line of text.split(/\r?\n/)) {
        // `per-PID` alone is not a promise: reading ONE leased leader's identity
        // is exactly what the contract requires. What must never appear is a
        // survivor list or an enumeration of the group's members.
        if (!/\bsurvivors?\b|\bmember enumerat/i.test(line)) continue;
        expect(line, `${name} promises identification the runtime does not do: ${line.trim()}`).toMatch(denial);
      }
    }
  });
});
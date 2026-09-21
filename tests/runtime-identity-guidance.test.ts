import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec #104 / ticket #107 — role / docs guidance assertions.
 *
 * The runtime identity boundary ticket does not change code; it
 * requires the canonical role + method docs to be tightened so the
 * exact-version route is described as the normal authoritative
 * lifecycle execution path (not as exceptional administration), and so
 * the broader Replan-time scope-expansion policy is not folded into
 * Spec #104. This file is the smallest focused guidance assertion
 * covering both points.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

describe("Spec #104 / ticket #107 role guidance", () => {
  it("POIESIS_METHOD.md does not carry the scope-expansion return-to-Authorize policy (Replan-time #108-only)", async () => {
    const method = await readRepoFile("POIESIS_METHOD.md");
    expect(method, "POIESIS_METHOD.md must not own the Replan-time scope-expansion gate").not.toContain(
      "Scope expansion return-to-Authorize",
    );
    expect(method, "POIESIS_METHOD.md must not own the Replan-time scope-expansion gate").not.toContain(
      "return-to-Authorize",
    );
  });

  it("POIESIS_ROLE_POIESIS.md frames the exact-version route as the normal authoritative lifecycle execution path", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    expect(role).toContain("`pnpm dlx poiesis-cli@<manifest.poiesisVersion>`");
    expect(
      role,
      "POIESIS_ROLE_POIESIS.md must say the exact-version route is the normal authoritative lifecycle execution path",
    ).toMatch(/normal authoritative lifecycle[\s\n]+execution path/);
  });

  it("POIESIS_ROLE_POIESIS.md reserves ordinary shell for bounded diagnosis and explicitly Author-authorized exceptional administration", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    expect(
      role,
      "POIESIS_ROLE_POIESIS.md must say ordinary shell is for bounded diagnosis",
    ).toMatch(/ordinary shell is for bounded diagnosis/i);
    expect(
      role,
      "POIESIS_ROLE_POIESIS.md must explicitly reserve raw / manual mutation for Author-authorized exceptional administration",
    ).toMatch(/explicitly Author-authorized|explicit Author authorization/i);
  });

  it("POIESIS_ROLE_POIESIS.md says raw / manual mutation outside deterministic operations creates no lifecycle evidence and does not transfer lifecycle authority", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    expect(
      role,
      "POIESIS_ROLE_POIESIS.md must say raw mutation creates no lifecycle evidence",
    ).toContain("no lifecycle evidence");
    expect(
      role,
      "POIESIS_ROLE_POIESIS.md must say raw mutation does not transfer lifecycle authority",
    ).toContain("does not transfer lifecycle authority");
  });

  it("POIESIS_ROLE_POIESIS.md does not invent receipt semantics for raw / manual mutation (no foreign-change claim about the next operation)", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    // Earlier draft invented a "treats the exceptional action as an
    // unrelated foreign change" claim about the next deterministic
    // operation. The minimal #104 / #107 wording refuses to commit to
    // that — the deterministic surface decides on its own terms.
    expect(
      role,
      "POIESIS_ROLE_POIESIS.md must not claim the next operation necessarily treats the change as foreign",
    ).not.toMatch(/treats the .* as an unrelated foreign change/);
  });
});

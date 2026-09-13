import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Canonical package guidance for bounded final-review evidence gathering.
 *
 * Ticket #39 acceptance criterion: "Final review dispatches provide bounded
 * project-local evidence and explicitly prohibit parent-directory or broad
 * external-directory discovery; missing evidence is reported rather than
 * searched outside those roots."
 *
 * The dispatcher constraint applies to the Poiesis Reviewer role and the
 * installed projection used by the reasoning-model final reviewer. The
 * guidance surfaces are POIESIS_ROLE_REVIEWER.md (read by both the ticket
 * Reviewer and the final Reviewer) and OPENCODE_AGENT_FINAL_REVIEWER.md
 * (installed/generated projection for the reasoning-model final reviewer).
 *
 * Any guidance that softens these phrasings is a regression: it lets the
 * final reviewer walk outside the supplied project/evidence roots to
 * compensate for missing material, which is the failure mode this
 * criterion is designed to prevent.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

const BOUNDED_HEADER = "Bounded evidence gathering (final review)";
const PARENT_FORBIDDEN = "parent-directory discovery";
const EXTERNAL_FORBIDDEN = "broad external-directory discovery";
const MISSING_REPORT_PATTERN = /report\s+it\s+as\s+missing/i;
// [\s\S] instead of . so we cross line breaks; the doc text wraps
// "report it" and "as missing" across lines.
const MISSING_REPORT_CROSS_LINE = /report[\s\S]*missing|missing[\s\S]*report/i;

describe("bounded final-review evidence guidance", () => {
  it("POIESIS_ROLE_REVIEWER.md has a dedicated Bounded evidence gathering (final review) section", async () => {
    const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
    expect(reviewer).toContain(BOUNDED_HEADER);
  });

  it("POIESIS_ROLE_REVIEWER.md explicitly forbids parent-directory discovery during final review", async () => {
    const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
    expect(reviewer).toContain(PARENT_FORBIDDEN);
    expect(reviewer).toMatch(/prohibit[\s\S]*parent-directory|parent-directory[\s\S]*prohibit|do not[\s\S]*parent-directory/i);
  });

  it("POIESIS_ROLE_REVIEWER.md explicitly forbids broad external-directory discovery during final review", async () => {
    const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
    expect(reviewer).toContain(EXTERNAL_FORBIDDEN);
    expect(reviewer).toMatch(/prohibit[\s\S]*broad external-directory|broad external-directory[\s\S]*prohibit|do not[\s\S]*broad external-directory/i);
  });

  it("POIESIS_ROLE_REVIEWER.md says missing evidence must be reported rather than searched outside the supplied roots", async () => {
    const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
    expect(reviewer).toMatch(MISSING_REPORT_PATTERN);
    expect(reviewer).toMatch(MISSING_REPORT_CROSS_LINE);
  });

  it("POIESIS_ROLE_REVIEWER.md scopes evidence gathering to the supplied project root and supplied evidence roots", async () => {
    const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
    expect(reviewer).toMatch(/supplied project root/);
    expect(reviewer).toMatch(/supplied evidence roots/);
  });

  it("OPENCODE_AGENT_FINAL_REVIEWER.md (installed/generated projection) carries the bounded evidence rule", async () => {
    const finalReviewer = await readRepoFile("OPENCODE_AGENT_FINAL_REVIEWER.md");
    expect(finalReviewer).toMatch(/Bounded evidence/);
    expect(finalReviewer).toContain(PARENT_FORBIDDEN);
    expect(finalReviewer).toContain(EXTERNAL_FORBIDDEN);
    expect(finalReviewer).toMatch(/supplied project root|supplied evidence roots/);
    expect(finalReviewer).toMatch(/report it as missing|report missing evidence|missing evidence/i);
  });

  it("OPENCODE_AGENT_FINAL_REVIEWER.md and POIESIS_ROLE_REVIEWER.md agree on the bounded-evidence contract", async () => {
    const [reviewer, finalReviewer] = await Promise.all([
      readRepoFile("POIESIS_ROLE_REVIEWER.md"),
      readRepoFile("OPENCODE_AGENT_FINAL_REVIEWER.md"),
    ]);
    expect(reviewer).toMatch(/supplied project root/);
    expect(finalReviewer).toMatch(/supplied project root/);
    expect(reviewer).toContain(PARENT_FORBIDDEN);
    expect(reviewer).toContain(EXTERNAL_FORBIDDEN);
    expect(finalReviewer).toContain(PARENT_FORBIDDEN);
    expect(finalReviewer).toContain(EXTERNAL_FORBIDDEN);
    expect(reviewer).toMatch(MISSING_REPORT_CROSS_LINE);
    expect(finalReviewer).toMatch(MISSING_REPORT_CROSS_LINE);
  });
});

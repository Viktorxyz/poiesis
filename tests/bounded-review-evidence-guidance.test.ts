import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Canonical package guidance for bounded final-review evidence gathering.
 *
 * Tickets #39 and #40 acceptance criteria: final review dispatches provide
 * bounded project-local evidence, final Reviewers never widen discovery to
 * fallback/external locations, and each review may use at most one bounded
 * Explore child only when genuinely necessary.
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
const ONE_CHILD_CEILING = "at most one bounded Explore child";
const CODE_REVIEW_OVERRIDE = "never its parallel or multiple child recipe";
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

  it("caps each Spec or Standards Review at one genuinely necessary bounded Explore child", async () => {
    const [reviewer, finalReviewer] = await Promise.all([
      readRepoFile("POIESIS_ROLE_REVIEWER.md"),
      readRepoFile("OPENCODE_AGENT_FINAL_REVIEWER.md"),
    ]);
    for (const guidance of [reviewer, finalReviewer]) {
      expect(guidance).toContain(ONE_CHILD_CEILING);
      expect(guidance).toMatch(/Spec Review[\s\S]*Standards Review|Spec or Standards Review/i);
      expect(guidance).toMatch(/only when genuinely necessary/i);
    }
  });

  it("overrides the code-review skill's parallel or multiple child topology", async () => {
    const [reviewer, finalReviewer] = await Promise.all([
      readRepoFile("POIESIS_ROLE_REVIEWER.md"),
      readRepoFile("OPENCODE_AGENT_FINAL_REVIEWER.md"),
    ]);
    for (const guidance of [reviewer, finalReviewer]) {
      expect(guidance).toMatch(/code-review/i);
      expect(guidance).toContain(CODE_REVIEW_OVERRIDE);
      expect(guidance).toMatch(/judgment|checklist/i);
    }
  });

  it("forbids inferred fallback, package-source, parent, and broad /tmp discovery", async () => {
    const [reviewer, finalReviewer] = await Promise.all([
      readRepoFile("POIESIS_ROLE_REVIEWER.md"),
      readRepoFile("OPENCODE_AGENT_FINAL_REVIEWER.md"),
    ]);
    for (const guidance of [reviewer, finalReviewer]) {
      expect(guidance).toMatch(/exact candidate root/i);
      expect(guidance).toMatch(/exact project root/i);
      expect(guidance).toMatch(/exact\s+evidence roots/i);
      expect(guidance).toMatch(/conventional fallback evidence paths/i);
      expect(guidance).toMatch(/package-source paths/i);
      expect(guidance).toMatch(/broad [`]?\/tmp/i);
      expect(guidance).toMatch(MISSING_REPORT_CROSS_LINE);
    }
  });

  it("requires Poiesis final-review dispatches to supply exact roots without inviting outside search", async () => {
    const [role, agent] = await Promise.all([
      readRepoFile("POIESIS_ROLE_POIESIS.md"),
      readRepoFile("OPENCODE_AGENT_POIESIS.md"),
    ]);
    for (const guidance of [role, agent]) {
      expect(guidance).toMatch(/final-review dispatch/i);
      expect(guidance).toMatch(/exact candidate root/i);
      expect(guidance).toMatch(/exact project root/i);
      expect(guidance).toMatch(/exact\s+evidence roots/i);
      expect(guidance).toMatch(/do\s+not invite[\s\S]*outside/i);
      expect(guidance).toMatch(/missing evidence/i);
    }
  });
});

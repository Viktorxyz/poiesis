import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec #203 / ticket #204 — the update-notice duty in the canonical canon.
 *
 * The runtime only decides WHETHER a newer published version exists. Whether
 * the Author is told about it is a duty, and a duty belongs to exactly one
 * place per surface: the primary Poiesis role (Author interaction) and the
 * installed primary agent projection (new root session preamble). This file
 * pins that duty in both, and pins that no Specialist surface inherits it.
 *
 * The duty's negative half matters as much as its positive half: Poiesis
 * appends a NOTICE, it never runs the update itself, and it never restarts
 * OpenCode on its own initiative. A canon that quietly widened into an
 * automatic upgrade path would convert a read-only comparison into a
 * consequential mutation nobody asked for.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

/** The two surfaces that carry the notice duty. */
const DUTY_DOCS = ["POIESIS_ROLE_POIESIS.md", "OPENCODE_AGENT_POIESIS.md"] as const;

/**
 * Every Specialist surface. The notice is an Author-facing, primary-session
 * decision: a Worker, Planner, Reviewer, or Research dispatch has no Author
 * in front of it and must not grow an update surface.
 */
const SPECIALIST_DOCS = [
  "POIESIS_ROLE_WORKER.md",
  "POIESIS_ROLE_PLANNER.md",
  "POIESIS_ROLE_REVIEWER.md",
  "POIESIS_ROLE_RESEARCH.md",
  "OPENCODE_AGENT_WORKER.md",
  "OPENCODE_AGENT_PLANNER.md",
  "OPENCODE_AGENT_REVIEWER.md",
  "OPENCODE_AGENT_RESEARCH.md",
  "OPENCODE_AGENT_FINAL_REVIEWER.md",
] as const;

describe("Spec #203 / ticket #204 update-notice guidance", () => {
  describe.each(DUTY_DOCS)("%s carries the first-reply update-notice duty", (relativePath) => {
    it("names the read-only `poiesis latest` command", async () => {
      const doc = await readRepoFile(relativePath);
      expect(doc).toMatch(/poiesis latest/);
    });

    it("runs it through every exact installed CLI route, never a bare or @latest launcher", async () => {
      const doc = await readRepoFile(relativePath);
      expect(
        doc,
        `${relativePath} must name the local pnpm package contribution route`,
      ).toMatch(/pnpm poiesis latest/);
      expect(
        doc,
        `${relativePath} must name the local npm package contribution route`,
      ).toMatch(/npm run poiesis -- latest/);
      expect(
        doc,
        `${relativePath} must name the exact-version dlx fallback route`,
      ).toMatch(/poiesis-cli@<manifest\.poiesisVersion>\s+latest/);
      expect(
        doc,
        `${relativePath} must bind local contribution routes before the dlx fallback`,
      ).toMatch(
        /pnpm poiesis latest[\s\S]*npm run poiesis -- latest[\s\S]*poiesis-cli@<manifest\.poiesisVersion>\s+latest|local package contribution[\s\S]*poiesis-cli@<manifest\.poiesisVersion>\s+latest/i,
      );
      expect(
        doc,
        `${relativePath} must not route the notice through poiesis-cli@latest`,
      ).not.toMatch(/poiesis-cli@latest/);
    });

    it("binds the notice to the first Author-facing reply of a new root session", async () => {
      const doc = await readRepoFile(relativePath);
      expect(
        doc,
        `${relativePath} must bind the notice to the first Author-facing reply of a new root session`,
      ).toMatch(/first Author-facing reply of a new root session/i);
    });

    it("appends the notice only when the report says a newer version exists, using `newerAvailable` and `updateCommand`", async () => {
      const doc = await readRepoFile(relativePath);
      expect(doc).toContain("`newerAvailable`");
      expect(doc).toContain("`updateCommand`");
      expect(
        doc,
        `${relativePath} must say the notice is appended only when newerAvailable is true`,
      ).toMatch(/only when[^.]*`?newerAvailable`?\s+is true|only if[^.]*`?newerAvailable`?\s+is true/i);
    });

    it("requires a short localized notice with the command verbatim and no disclaimer prose", async () => {
      const doc = await readRepoFile(relativePath);
      expect(
        doc,
        `${relativePath} must show a short localized notice shape (version + command)`,
      ).toMatch(/Dostupan je Poiesis/);
      expect(
        doc,
        `${relativePath} must carry updateCommand verbatim`,
      ).toMatch(/verbatim/i);
      expect(
        doc,
        `${relativePath} must not narrate that the agent did not update`,
      ).not.toMatch(/I did not update|did not update (?:Poiesis|it)|I have not updated/i);
      expect(
        doc,
        `${relativePath} must not call it a reported command`,
      ).not.toMatch(/reported command/i);
    });

    it("stays silent when no newer version exists or lookup is unavailable", async () => {
      const doc = await readRepoFile(relativePath);
      expect(doc).toMatch(/`lookup`\s+is\s+`unavailable`/i);
      expect(
        doc,
        `${relativePath} must stay silent when newerAvailable is false or lookup unavailable`,
      ).toMatch(
        /(?:append nothing|say nothing about updates|append nothing and say nothing)/i,
      );
    });

    it("never updates automatically and never restarts OpenCode", async () => {
      const doc = await readRepoFile(relativePath);
      expect(
        doc,
        `${relativePath} must state the update is never automatic`,
      ).toMatch(/never (?:update automatically|automatically update|auto-update)/i);
      expect(
        doc,
        `${relativePath} must state OpenCode is never restarted for the notice`,
      ).toMatch(/never restart(?:ing)? OpenCode/i);
    });
  });

  describe.each(SPECIALIST_DOCS)("%s carries no update-notice duty", (relativePath) => {
    it("does not name the `poiesis latest` surface", async () => {
      const doc = await readRepoFile(relativePath);
      expect(doc, `${relativePath} must not carry the update-notice duty`).not.toMatch(
        /poiesis latest/,
      );
    });
  });
});
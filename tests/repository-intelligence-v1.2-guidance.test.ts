import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec #120 / ticket #124 — Repository Intelligence v1.2 documentation
 * guidance contract.
 *
 * The v1.2 release introduces a harness-neutral concept of Repository
 * Intelligence: a rebuildable, non-canonical, deterministic representation
 * of repository structure used to reduce broad source rediscovery.
 * Graphify is the v1.2 default engine behind the deterministic `poiesis
 * repository` surface; the canonical role and method docs MUST use the
 * harness-neutral wording ("Repository Intelligence"), not the engine
 * name, and MUST encode the seven trust invariants the Spec binds:
 *
 *   (a) Query before broad rediscovery when economical.
 *   (b) Source code and project artifacts remain authoritative.
 *   (c) `EXTRACTED` is structural evidence; `INFERRED` is a lead;
 *       `AMBIGUOUS` is a navigation hint.
 *   (d) Consequential conclusions must verify the relevant current
 *       source.
 *   (e) Derived intelligence is non-canonical and may be deleted /
 *       rebuilt at any time.
 *   (f) Unavailability triggers fallback to ordinary exploration; it
 *       does NOT create a new lifecycle phase.
 *   (g) No Graphify mechanics leak into normal Specs / tickets / role
 *       prose. The Graphify installer, skill, OpenCode plugin,
 *       AGENTS.md, hooks, MCP, memory, hosted mode, and docs/media
 *       semantic extraction are explicitly excluded.
 *
 * This file is the smallest focused guidance assertion that codifies
 * the parent Spec contract on the canonical docs:
 *
 *   - POIESIS_PHILOSOPHY.md       (the philosophy)
 *   - POIESIS_METHOD.md           (the canonical lifecycle)
 *   - POIESIS_ROLE_POIESIS.md     (the orchestrator)
 *   - POIESIS_ROLE_PLANNER.md     (the planning specialist)
 *   - POIESIS_ROLE_WORKER.md      (the implementation specialist)
 *   - POIESIS_ROLE_REVIEWER.md    (the independent review specialist)
 *   - POIESIS_INSTALL_LAYOUT.md   (the install-layout spec)
 *   - README.md                   (the user-facing guidance)
 *
 * The Foundation document (renamed from v1.1 → v1.2) is verified by a
 * sibling test (`foundation-v1.2.test.ts`) so this file stays focused
 * on the consumer-projection prose.
 *
 * Each constant / regex below corresponds to a parent-Spec contract
 * clause. The patterns are deliberately short and lexically stable so
 * a regression that softens the contract phrases is caught by a
 * one-line diff. Negative-shape patterns check that no Graphify
 * mechanics leak into role / philosophy / method prose that the Author
 * would otherwise read as Poiesis canon.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

// ---- Contract phrase constants -----------------------------------------
// Harness-neutral Repository Intelligence wording — the canonical
// role / method / philosophy prose MUST use this vocabulary. Engine
// names belong in the runtime module (`src/repository-intelligence.ts`)
// and the COMPATIBILITY.md pinning table, not in role canon.

const REPOSITORY_INTELLIGENCE_TERM = "Repository Intelligence";

const QUERY_BEFORE_REDISCOVERY =
  /query[\s\S]{0,200}?before[\s\S]{0,80}?broad[\s\S]{0,80}?rediscovery|query before broad rediscovery/i;

const SOURCE_AUTHORITATIVE =
  /source[\s\S]{0,200}?(?:remains?|is)\s+authoritative|source code[\s\S]{0,200}?authoritative|source\s+is\s+authoritative/i;

const EXTRACTED_STRUCTURAL =
  /EXTRACTED[\s\S]*structural[\s\S]*evidence|structural[\s\S]*evidence[\s\S]*EXTRACTED/i;

const INFERRED_LEAD =
  /INFERRED[\s\S]{0,200}?lead|lead[\s\S]{0,200}?INFERRED/i;

const AMBIGUOUS_NAVIGATION =
  /AMBIGUOUS[\s\S]{0,200}?navigation|navigation[\s\S]{0,200}?AMBIGUOUS/i;

const VERIFY_BEFORE_CONSEQUENTIAL =
  /(?:consequential[\s\S]{0,200}?verif|verif[\s\S]{0,200}?consequential[\s\S]{0,200}?source|verify[\s\S]{0,200}?current source|verify current source[\s\S]{0,200}?consequential)/i;

const DERIVED_NON_CANONICAL =
  /(?:derived[\s\S]{0,200}?non-canonical|derived intelligence[\s\S]{0,200}?non-canonical|non-canonical[\s\S]{0,200}?derived|rebuildable[\s\S]{0,200}?non-canonical)/i;

const DERIVED_DELETABLE =
  /(?:rebuildable[\s\S]{0,200}?deletable|deleted and rebuilt|may be deleted|can be deleted|deleting[\s\S]{0,200}?force fallback|safe to delete)/i;

const FALLBACK_NO_LIFECYCLE =
  /(?:falls?[\s-]back[\s\S]{0,200}?ordinary|falls?[\s-]back[\s\S]{0,200}?normal[\s\S]{0,200}?exploration|fallback[\s\S]{0,200}?normal[\s\S]{0,200}?exploration|no new lifecycle|does not create a new lifecycle|not[\s\S]{0,200}?new lifecycle phase|no new lifecycle phase)/i;

const POIESIS_REPOSITORY_CLI =
  /poiesis repository\s+(?:query|path|explain|status)/;

const POIESIS_REPOSITORY_QUERY_FIRST =
  /poiesis repository\s+query[\s\S]*before broad|poiesis repository\s+(?:query|path|explain)[\s\S]*broad rediscovery/i;

// Negative-shape invariants: Graphify mechanics must NOT leak into the
// Author-facing canonical prose. The exceptions are:
//   - `src/repository-intelligence.ts` (the runtime seam)
//   - `COMPATIBILITY.md` (the engine-pinning reference)
//   - `README.md` `Repository Intelligence` requirement line, which
//     describes the Graphify pin for operator clarity
//   - the Foundation document (the design record)
// so the negative patterns are scoped to the role / method /
// philosophy / install-layout / opencode-agent files where a stray
// engine name would silently promote Graphify into Poiesis canon.

const GRAPHIFY_INSTALLER_LEAK =
  /\bgraphify install\b|\bgraphify\s+install\s+--project\b|graphify opencode install|graphify hook install/i;

const GRAPHIFY_SKILL_LEAK =
  /POIESIS_SKILLS[^.]*graphify|graphify[^.]*skill default/i;

const GRAPHIFY_PLUGIN_LEAK =
  /graphify[^.]*opencode[^.]*plugin|opencode[^.]*graphify[^.]*plugin|graphify[^.]*plugin/i;

const GRAPHIFY_AGENTS_LEAK =
  /graphify[^.]*AGENTS\.md|AGENTS\.md[^.]*graphify/i;

const GRAPHIFY_HOOKS_LEAK =
  /graphify[^.]*(?:hook|hooks)/i;

const GRAPHIFY_MCP_LEAK =
  /graphify[^.]*MCP|MCP[^.]*graphify/i;

const GRAPHIFY_MEMORY_LEAK =
  /graphify[^.]*memory|\bmemory\b[^.]*graphify/i;

const GRAPHIFY_HOSTED_LEAK =
  /graphify[^.]*hosted|hosted[^.]*graphify|remote graph server/i;

const GRAPHIFY_DOCS_MEDIA_LEAK =
  /graphify[^.]*(?:docs[^.]*semantic|media[^.]*semantic|PDFs?|docs semantic)/i;

describe("Spec #120 / ticket #124 Repository Intelligence v1.2 guidance", () => {
  describe("POIESIS_PHILOSOPHY.md carries the derived-intelligence canon", () => {
    it("POIESIS_PHILOSOPHY.md names Repository Intelligence as the harness-neutral concept", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).toContain(REPOSITORY_INTELLIGENCE_TERM);
    });

    it("POIESIS_PHILOSOPHY.md encodes the query-before-broad-rediscovery rule", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).toMatch(QUERY_BEFORE_REDISCOVERY);
    });

    it("POIESIS_PHILOSOPHY.md keeps source authoritative over derived intelligence", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).toMatch(SOURCE_AUTHORITATIVE);
    });

    it("POIESIS_PHILOSOPHY.md treats derived intelligence as rebuildable, non-canonical local state", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).toMatch(DERIVED_NON_CANONICAL);
      expect(philosophy).toMatch(DERIVED_DELETABLE);
    });
  });

  describe("POIESIS_PHILOSOPHY.md encodes the Author-owned quality-over-under-equipped-environment decisions (ticket #124 Review correction)", () => {
    it("POIESIS_PHILOSOPHY.md still preserves 'Complexity must earn its place' (the new decisions complement, not replace, the gating principle)", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).toMatch(/Complexity must earn its place/);
    });

    it("POIESIS_PHILOSOPHY.md declares that a useful capability is not rejected merely because the initial environment lacks dependencies", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).toMatch(
        /(?:not rejected|not be rejected|never rejected)[\s\S]{0,300}?(?:initial environment|dependencies|lacks?[\s\S]{0,80}?dependencies)/i,
      );
      expect(philosophy).toMatch(/under-equipped|under equipped/i);
    });

    it("POIESIS_PHILOSOPHY.md declares missing tools are setup work the runtime owns, not reasons to weaken the product", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).toMatch(/setup work|runtime owns|owns[\s\S]{0,80}?setup/i);
      expect(philosophy).toMatch(/missing[\s\S]{0,200}?(?:setup|weaken|never|not a reason|not reasons?)/i);
      expect(philosophy).toMatch(/never[\s\S]{0,200}?(?:weakens?|reduce|reduction).*product|not[ a-z]*reasons?[\s\S]{0,80}?weaken/i);
    });

    it("POIESIS_PHILOSOPHY.md declares security / privacy / portability / authority shape the seam rather than serving as excuses to omit value", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      // Section header / topic
      expect(philosophy).toMatch(/Security[\s\S]{0,80}?privacy[\s\S]{0,80}?portability[\s\S]{0,80}?authority/i);
      // Body: the constraints guide HOW (the seam), not WHETHER (the decision to omit)
      expect(philosophy).toMatch(
        /(?:shape|guide)[\s\S]{0,200}?(?:how|seam|installed|exposed|scoped|verified)/i,
      );
      expect(philosophy).toMatch(/not[\s\S]{0,200}?(?:excuse|omit|reason|remove)/i);
    });

    it("POIESIS_PHILOSOPHY.md declares roles receive sufficient tools (including Bash where useful) while deterministic Poiesis operations retain lifecycle authority and out-of-band mutation gains no evidence / authority", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      // Roles receive sufficient tools / permissions
      expect(philosophy).toMatch(/sufficient tools|sufficient permissions/i);
      // Bash is permitted where useful
      expect(philosophy).toMatch(/Bash[\s\S]{0,200}?(?:useful|where)/i);
      // Deterministic Poiesis operations retain lifecycle authority
      expect(philosophy).toMatch(/deterministic[\s\S]{0,200}?(?:retain|retains|authority|lifecycle authority)/i);
      // Out-of-band / raw shell gains no lifecycle evidence and no authority
      expect(philosophy).toMatch(
        /out-of-band[\s\S]{0,200}?(?:no|none|zero)[\s\S]{0,80}?(?:evidence|authority)/i,
      );
      expect(philosophy).toMatch(
        /(?:no|none|zero)[\s\S]{0,80}?(?:evidence|authority)[\s\S]{0,200}?(?:out-of-band|raw)/i,
      );
    });
  });

  describe("POIESIS_METHOD.md teaches the lifecycle where Repository Intelligence fits (and where it does NOT)", () => {
    it("POIESIS_METHOD.md names Repository Intelligence as the harness-neutral concept", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toContain(REPOSITORY_INTELLIGENCE_TERM);
    });

    it("POIESIS_METHOD.md Understand phase tells the agent to query Repository Intelligence before broad rediscovery", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(QUERY_BEFORE_REDISCOVERY);
    });

    it("POIESIS_METHOD.md Plan phase tells the Planner to use `poiesis repository` for cross-file architecture / dependency / impact questions", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(POIESIS_REPOSITORY_CLI);
      expect(method).toMatch(POIESIS_REPOSITORY_QUERY_FIRST);
    });

    it("POIESIS_METHOD.md Realize phase tells the Worker to read the actual files being changed and never implement from graph summaries alone", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(/read[^.]*actual[^.]*files[^.]*being changed|never implement[^.]*graph summaries alone|graph summaries[^.]*not sufficient/i);
    });

    it("POIESIS_METHOD.md Realize phase keeps Repository Intelligence as bounded discovery evidence, not Reviewer ground truth", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(/discovery evidence|ground truth[^.]*candidate source|blocking finding[^.]*candidate source|candidate source[^.]*blocking finding/i);
    });

    it("POIESIS_METHOD.md Prove phase keeps Repository Intelligence out of Proof identity", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(/Proof[^.]*identity|identity[^.]*Proof/i);
      // Proof identity fields must NOT carry a graph hash / cache state.
      // The Proof / Publish / Preview identity fields are bounded to
      // candidateSha, candidateTree, verified, specReview,
      // standardsReview, branch, remoteRef, publishedHeadSha, provider,
      // action, changeRequest. A regression that introduces a graphHash or
      // cacheState field into Proof identity is a hard contract violation.
      const proofIdentitySection = method;
      expect(proofIdentitySection).not.toMatch(/graphHash|graph_hash|cacheState|cache_state|repositoryIntelligenceHash/i);
    });

    it("POIESIS_METHOD.md Operating rules bind query-before-broad-rediscovery and rebuildable-derived-state", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(QUERY_BEFORE_REDISCOVERY);
      expect(method).toMatch(DERIVED_NON_CANONICAL);
    });

    it("POIESIS_METHOD.md keeps Repository Intelligence out of the numbered lifecycle steps (no new phase)", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      // The Method's numbered lifecycle must NOT add a "Repository
      // Intelligence" or "Graph" or "Map" or "Index" phase. The
      // capability lives inside existing phases, not as a numbered step.
      expect(method).not.toMatch(/^## \d+\.\s+(?:Repository Intelligence|Graph(?: Intelligence)?|Map|Index)\b/m);
    });

    it("POIESIS_METHOD.md fall-back invariant: missing / broken Repository Intelligence does not block the Method", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(FALLBACK_NO_LIFECYCLE);
    });
  });

  describe("POIESIS_ROLE_POIESIS.md owns Repository Intelligence orchestration and fallback", () => {
    it("POIESIS_ROLE_POIESIS.md names the canonical Repository Intelligence delegation surface", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toContain(REPOSITORY_INTELLIGENCE_TERM);
      expect(role).toMatch(/poiesis repository\s+(?:query|path|explain|status)/);
    });

    it("POIESIS_ROLE_POIESIS.md tells the orchestrator to query before broad exploration when it is the cheaper path", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(QUERY_BEFORE_REDISCOVERY);
    });

    it("POIESIS_ROLE_POIESIS.md keeps the runtime-owned freshness contract (no manual `graphify update`) and falls back to ordinary exploration", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(/runtime[^.]*owns?[^.]*freshness|runtime-owned freshness|owns[^.]*freshness/i);
      expect(role).toMatch(FALLBACK_NO_LIFECYCLE);
    });
  });

  describe("POIESIS_ROLE_PLANNER.md encodes the Planner query-first rule", () => {
    it("POIESIS_ROLE_PLANNER.md names Repository Intelligence as the Planner's default bounded evidence tool", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).toContain(REPOSITORY_INTELLIGENCE_TERM);
    });

    it("POIESIS_ROLE_PLANNER.md tells the Planner to query Repository Intelligence for cross-file architecture / dependency / impact questions before broad search", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).toMatch(QUERY_BEFORE_REDISCOVERY);
    });

    it("POIESIS_ROLE_PLANNER.md keeps INFERRED / AMBIGUOUS graph results as leads, not consequential commitments", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).toMatch(INFERRED_LEAD);
      expect(role).toMatch(AMBIGUOUS_NAVIGATION);
    });

    it("POIESIS_ROLE_PLANNER.md verifies consequential graph-derived conclusions against the current source", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).toMatch(VERIFY_BEFORE_CONSEQUENTIAL);
    });

    it("POIESIS_ROLE_PLANNER.md does not paste large graph output into the Spec", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).toMatch(/large graph output|paste[^.]*graph[^.]*output|graph output[^.]*Spec|bounded graph output/i);
    });
  });

  describe("POIESIS_ROLE_WORKER.md encodes the Worker orientation contract", () => {
    it("POIESIS_ROLE_WORKER.md names Repository Intelligence as a Worker evidence tool", async () => {
      const role = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(role).toContain(REPOSITORY_INTELLIGENCE_TERM);
    });

    it("POIESIS_ROLE_WORKER.md tells the Worker to read the actual files being changed and never implement from graph summaries alone", async () => {
      const role = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(role).toMatch(/read[^.]*actual[^.]*files[^.]*being changed|read the actual files|never implement[^.]*graph summaries alone/i);
    });
  });

  describe("POIESIS_ROLE_REVIEWER.md encodes the Reviewer ground-truth contract", () => {
    it("POIESIS_ROLE_REVIEWER.md names Repository Intelligence as a Reviewer discovery mechanism", async () => {
      const role = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(role).toContain(REPOSITORY_INTELLIGENCE_TERM);
    });

    it("POIESIS_ROLE_REVIEWER.md requires blocking findings to cite the actual candidate source, not only an inferred graph edge", async () => {
      const role = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(role).toMatch(VERIFY_BEFORE_CONSEQUENTIAL);
      expect(role).toMatch(/candidate source[^.]*review evidence|review evidence[^.]*candidate source|candidate source[^.]*ground truth/i);
    });
  });

  describe("Role canon preserves the sufficient-tools / deterministic-authority alignment (ticket #124 Review correction)", () => {
    it("POIESIS_ROLE_WORKER.md says Bash is permitted where useful for the ticket", async () => {
      const role = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(role).toMatch(/Bash[\s\S]{0,200}?(?:useful|where)/i);
    });

    it("POIESIS_ROLE_PLANNER.md says Bash is permitted under a bounded allowlist where useful for the planning task", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).toMatch(/Bash[\s\S]{0,200}?(?:useful|allowlist|bounded)/i);
    });

    it("POIESIS_ROLE_PLANNER.md states deterministic Poiesis operations retain lifecycle authority and raw shell gains no lifecycle evidence / authority", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).toMatch(/deterministic[\s\S]{0,200}?(?:retain|retains|authority|lifecycle authority)/i);
      expect(role).toMatch(/raw[\s\S]{0,200}?(?:no|none|zero)[\s\S]{0,80}?(?:evidence|authority)/i);
    });

    it("POIESIS_ROLE_POIESIS.md keeps the existing deterministic-authority / exceptional-administration contract", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(/Deterministic Poiesis operations/i);
      expect(role).toMatch(/normal authoritative lifecycle[\s\n]+execution path/i);
      expect(role).toMatch(/NO evidence of correctness|NOT authoritative|no lifecycle evidence/i);
    });
  });

  describe("Author-facing canon does NOT leak Graphify mechanics", () => {
    it("POIESIS_ROLE_POIESIS.md does not mention Graphify mechanics (harness-neutral canon)", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).not.toMatch(GRAPHIFY_INSTALLER_LEAK);
      expect(role).not.toMatch(GRAPHIFY_SKILL_LEAK);
      expect(role).not.toMatch(GRAPHIFY_PLUGIN_LEAK);
      expect(role).not.toMatch(GRAPHIFY_AGENTS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOOKS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MCP_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MEMORY_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOSTED_LEAK);
      expect(role).not.toMatch(GRAPHIFY_DOCS_MEDIA_LEAK);
    });

    it("POIESIS_ROLE_PLANNER.md does not mention Graphify mechanics", async () => {
      const role = await readRepoFile("POIESIS_ROLE_PLANNER.md");
      expect(role).not.toMatch(GRAPHIFY_INSTALLER_LEAK);
      expect(role).not.toMatch(GRAPHIFY_SKILL_LEAK);
      expect(role).not.toMatch(GRAPHIFY_PLUGIN_LEAK);
      expect(role).not.toMatch(GRAPHIFY_AGENTS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOOKS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MCP_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MEMORY_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOSTED_LEAK);
      expect(role).not.toMatch(GRAPHIFY_DOCS_MEDIA_LEAK);
    });

    it("POIESIS_ROLE_WORKER.md does not mention Graphify mechanics", async () => {
      const role = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(role).not.toMatch(GRAPHIFY_INSTALLER_LEAK);
      expect(role).not.toMatch(GRAPHIFY_SKILL_LEAK);
      expect(role).not.toMatch(GRAPHIFY_PLUGIN_LEAK);
      expect(role).not.toMatch(GRAPHIFY_AGENTS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOOKS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MCP_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MEMORY_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOSTED_LEAK);
      expect(role).not.toMatch(GRAPHIFY_DOCS_MEDIA_LEAK);
    });

    it("POIESIS_ROLE_REVIEWER.md does not mention Graphify mechanics", async () => {
      const role = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(role).not.toMatch(GRAPHIFY_INSTALLER_LEAK);
      expect(role).not.toMatch(GRAPHIFY_SKILL_LEAK);
      expect(role).not.toMatch(GRAPHIFY_PLUGIN_LEAK);
      expect(role).not.toMatch(GRAPHIFY_AGENTS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOOKS_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MCP_LEAK);
      expect(role).not.toMatch(GRAPHIFY_MEMORY_LEAK);
      expect(role).not.toMatch(GRAPHIFY_HOSTED_LEAK);
      expect(role).not.toMatch(GRAPHIFY_DOCS_MEDIA_LEAK);
    });

    it("POIESIS_PHILOSOPHY.md does not mention Graphify mechanics", async () => {
      const philosophy = await readRepoFile("POIESIS_PHILOSOPHY.md");
      expect(philosophy).not.toMatch(GRAPHIFY_INSTALLER_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_SKILL_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_PLUGIN_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_AGENTS_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_HOOKS_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_MCP_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_MEMORY_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_HOSTED_LEAK);
      expect(philosophy).not.toMatch(GRAPHIFY_DOCS_MEDIA_LEAK);
    });

    it("POIESIS_METHOD.md does not mention Graphify mechanics", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).not.toMatch(GRAPHIFY_INSTALLER_LEAK);
      expect(method).not.toMatch(GRAPHIFY_SKILL_LEAK);
      expect(method).not.toMatch(GRAPHIFY_PLUGIN_LEAK);
      expect(method).not.toMatch(GRAPHIFY_AGENTS_LEAK);
      expect(method).not.toMatch(GRAPHIFY_HOOKS_LEAK);
      expect(method).not.toMatch(GRAPHIFY_MCP_LEAK);
      expect(method).not.toMatch(GRAPHIFY_MEMORY_LEAK);
      expect(method).not.toMatch(GRAPHIFY_HOSTED_LEAK);
      expect(method).not.toMatch(GRAPHIFY_DOCS_MEDIA_LEAK);
    });

    it("POIESIS_INSTALL_LAYOUT.md does not mention Graphify mechanics", async () => {
      const installLayout = await readRepoFile("POIESIS_INSTALL_LAYOUT.md");
      expect(installLayout).not.toMatch(GRAPHIFY_INSTALLER_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_SKILL_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_PLUGIN_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_AGENTS_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_HOOKS_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_MCP_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_MEMORY_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_HOSTED_LEAK);
      expect(installLayout).not.toMatch(GRAPHIFY_DOCS_MEDIA_LEAK);
    });
  });

  describe("POIESIS_INSTALL_LAYOUT.md keeps the Foundation document singular and v1.2", () => {
    it("POIESIS_INSTALL_LAYOUT.md refers to the v1.2 Foundation, not v1.1", async () => {
      const installLayout = await readRepoFile("POIESIS_INSTALL_LAYOUT.md");
      expect(installLayout).toContain("POIESIS_FOUNDATION_v1.2.md");
      expect(installLayout).not.toMatch(/POIESIS_FOUNDATION_v1\.1\.md/);
    });

    it("POIESIS_INSTALL_LAYOUT.md records the canonical local-state path for the Repository Intelligence cache", async () => {
      const installLayout = await readRepoFile("POIESIS_INSTALL_LAYOUT.md");
      expect(installLayout).toMatch(/\.poiesis\/cache\//);
      expect(installLayout).toMatch(/repository-intelligence/);
    });
  });

  describe("README.md carries the v1.2 Foundation reference and the setup-agent prompt", () => {
    it("README.md refers to POIESIS_FOUNDATION_v1.2.md as the canonical design document, not v1.1", async () => {
      const readme = await readRepoFile("README.md");
      expect(readme).toContain("POIESIS_FOUNDATION_v1.2.md");
      expect(readme).not.toMatch(/POIESIS_FOUNDATION_v1\.1\.md/);
    });

    it("README.md lists `uv` as the standard Repository Intelligence runtime requirement", async () => {
      const readme = await readRepoFile("README.md");
      expect(readme).toContain("uv");
      expect(readme).toContain("docs.astral.sh/uv");
    });

    it("README.md ships a concise full-access setup-agent prompt that installs official requirements (including uv), runs fresh-latest init/update as appropriate, runs doctor, and reports readiness", async () => {
      const readme = await readRepoFile("README.md");
      // The prompt must instruct the agent to install uv, run the
      // fresh-latest init/update form, run doctor, and report a
      // readiness summary. The contract is intentionally narrow: one
      // setup-agent prompt, no separate agent / role file.
      expect(readme).toMatch(/setup-agent|setup agent/i);
      // `uv` install instruction
      expect(readme).toMatch(/install[^.\n]*\buv\b|\buv\b[^.\n]*install/i);
      // Fresh-latest init / update form
      expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+(?:init|update)\b/);
      // Doctor invocation
      expect(readme).toMatch(/\bdoctor\b/i);
      // Readiness report
      expect(readme).toMatch(/readiness|ready to run|ready_for_use|reporting readiness/i);
    });

    it("README.md uses the harness-neutral 'Repository Intelligence' wording in operator prose, not the engine name", async () => {
      const readme = await readRepoFile("README.md");
      expect(readme).toContain(REPOSITORY_INTELLIGENCE_TERM);
    });
  });
});
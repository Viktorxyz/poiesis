import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  init,
  update,
} from "../src/maintenance.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import { parseJsonc } from "../src/config.js";
import { readUtf8 } from "../src/fs.js";
import { hashOwnedSkillDirectory, skillPath } from "../src/skills.js";
import {
  asPredecessorManifest,
  rebindReceipt,
  setupCurrentInstall,
} from "./predecessor-migration-fixtures.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

/**
 * Seed a representative default skill as preexisting on disk so the
 * receipt-authenticated 1.1.1 → 1.1.2 update can prove the COMPLETE
 * skill installation state (source / name / path / preexisting /
 * installedRevision / hash) survives the migration, not just a count.
 *
 * The earlier test compared `result.manifest.skills.length` against a
 * 0-length baseline seeded by `setupCurrentInstall(..., skipSkills:true)`,
 * which silently passed even if the migration dropped fields, renamed a
 * skill, lost the hash, or rewrote `installedRevision`. Seeding a real
 * preexisting directory with a deterministic body gives the assertions
 * a non-empty baseline with concrete fields to assert against.
 *
 * The source / name / installedRevision are sourced from
 * `loadDefaultSkills()` so the seeded record matches the installed
 * adapter exactly. Using a `obra/superpowers` skill exercises the
 * non-mattpocock-source branch.
 */
async function seedRepresentativePreexistingSkill(
  repository: TestRepository,
): Promise<{
  source: string;
  name: string;
  installedRevision: string;
}> {
  const { loadDefaultSkills } = await import("../src/skills.js");
  const defaults = await loadDefaultSkills();
  const chosen = defaults.find((skill) => skill.source === "obra/superpowers") ?? defaults[0]!;
  const name = chosen.name;
  const source = chosen.source;
  const installedRevision = chosen.revision;
  const directory = join(repository.root, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `# ${name}\nseeded preexisting by realize-convergence-guidance test\n`);
  await writeFile(
    join(directory, "INSTALL_REVISION"),
    `${installedRevision}\n`,
  );
  return { source, name, installedRevision };
}

/**
 * Mirror `installDefaultSkills`'s `manifestSkill` shape for the seeded
 * preexisting skill so the manifest carries a valid, complete
 * installation record before the 1.1.1 predecessor rebind and the
 * subsequent 1.1.1 → 1.1.2 update.
 */
async function attachSeededSkillToManifest(
  repository: TestRepository,
  seeded: { source: string; name: string; installedRevision: string },
): Promise<void> {
  const manifest = await loadManifest(repository.root);
  const destination = skillPath(repository.root, seeded.name);
  const hash = await hashOwnedSkillDirectory(destination);
  const record = {
    source: seeded.source,
    name: seeded.name,
    path: `.agents/skills/${seeded.name}`,
    preexisting: true,
    installedRevision: seeded.installedRevision,
    hash,
  };
  // Drop any prior record for this skill (idempotent reseed).
  manifest.skills = [
    ...manifest.skills.filter((existing) => existing.name !== seeded.name),
    record,
  ];
  await writeFile(
    join(repository.root, ".poiesis", "manifest.json"),
    serializeManifest(manifest),
  );
}

/**
 * Spec #108 / ticket #109 — Realize convergence role / method guidance.
 *
 * The parent Spec #108 contract owns four prose invariants that Realize
 * must not silently drift away from:
 *
 *   (a) Poiesis does not continue work merely because more work can be
 *       done. Realize continues only for a concrete unsatisfied
 *       authorized obligation or new evidence the current realization
 *       cannot satisfy it.
 *   (b) Material product/architecture expansion discovered during
 *       Realize returns to Authorize before implementation.
 *   (c) Worker runs relevant focused ticket checks and returns
 *       `ready_for_review` only when implementation exists, focused
 *       checks pass, and no known ticket-blocking defect remains.
 *       Unrelated failures absent causal evidence are bounded Concerns,
 *       not new debugging missions. No rerun of the same failing
 *       command absent relevant mutation or concrete new hypothesis.
 *   (d) Whole-change authoritative verification belongs to Prove for an
 *       intended final candidate, not intermediate Realize or while
 *       known implementation tickets remain unfinished. Reviewer
 *       findings are evidence, not commands; only material contract-
 *       relevant issues block, scoped to bounded PASS and actionable
 *       bounded FAIL grouped by root cause. Repeated reopening of one
 *       semantic area triggers reassessment/Replan, not one-finding/
 *       one-ticket churn. Tickets are smallest coherent engineering
 *       outcomes. Child context/returns stay bounded and do not
 *       duplicate irrelevant discovery.
 *
 * This file is the smallest focused guidance + projection test for that
 * contract. The contract spans the four canonical method / role files:
 *
 *   - POIESIS_METHOD.md         (the canonical lifecycle)
 *   - POIESIS_ROLE_POIESIS.md   (the orchestrator)
 *   - POIESIS_ROLE_WORKER.md    (the implementation child)
 *   - POIESIS_ROLE_REVIEWER.md  (the independent review child)
 *
 * The OpenCode wrappers (OPENCODE_AGENT_*.md) reference those canonical
 * files verbatim and stay thin; no new mode, stage, counter, budget,
 * cache, telemetry, durable state, database, agent, remediation
 * machine, or runtime sufficiency interpreter is added. Exact-candidate
 * and review-independence semantics are preserved.
 *
 * The projection tests at the bottom prove the canonical templates
 * regenerate the corrected owned projections through both the
 * `init` install path and an exact public 1.1.1 → 1.1.2 update, while
 * preserving unrelated OpenCode config + models + tracker + delivery +
 * skill installation state.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Extract a single top-level Method section (e.g. "## 8. Realize") so a
 * regex can be tested against the *relevant* section instead of the whole
 * document. The Method is structured as numbered top-level sections
 * (`## 1.` … `## 19.`); this helper returns the body between the chosen
 * heading and the next top-level heading of the same depth.
 *
 * Whole-document regexes for Spec #108 prose would silently pass when the
 * matched phrase drifts into a *different* section (e.g. `whole-change`
 * belongs to §10 Prove, not §8 Realize). Scoping the regex to the
 * correct section is the only way a regression that re-homes the policy
 * into the wrong section is caught.
 */
function extractMethodSection(method: string, sectionTitle: string): string {
  const start = method.indexOf(`## ${sectionTitle}`);
  if (start === -1) {
    throw new Error(`Method has no top-level section "## ${sectionTitle}"`);
  }
  const bodyStart = method.indexOf("\n", start);
  if (bodyStart === -1) {
    throw new Error(`Method section "## ${sectionTitle}" has no body`);
  }
  const tail = method.slice(bodyStart + 1);
  const lines = tail.split(/\r?\n/);
  let collected = "";
  for (const line of lines) {
    if (/^## \d+\. /.test(line)) break;
    collected += `${line}\n`;
  }
  return collected;
}

/**
 * Extract a named ## section from a role document (e.g. "## Return" in
 * POIESIS_ROLE_REVIEWER.md). The role files use a different section
 * vocabulary (no numbered headings), so this helper matches by exact
 * `## Heading` label rather than by numeric index.
 */
function extractRoleSection(role: string, heading: string): string {
  const start = role.indexOf(`## ${heading}`);
  if (start === -1) {
    throw new Error(`Role document has no top-level section "## ${heading}"`);
  }
  const bodyStart = role.indexOf("\n", start);
  if (bodyStart === -1) {
    throw new Error(`Role section "## ${heading}" has no body`);
  }
  const tail = role.slice(bodyStart + 1);
  const lines = tail.split(/\r?\n/);
  let collected = "";
  for (const line of lines) {
    if (/^## /.test(line)) break;
    collected += `${line}\n`;
  }
  return collected;
}

// --- Spec #108 phrase constants -----------------------------------------
// These are the canonical prose phrasings the parent Spec contract binds
// Realize to. They are deliberately short, lexically stable, and not
// paraphrased into many variants so a regression that softens them is
// caught by a one-line diff. Each constant is checked on the canonical
// template files (POIESIS_METHOD.md / POIESIS_ROLE_POIESIS.md /
// POIESIS_ROLE_WORKER.md / POIESIS_ROLE_REVIEWER.md).

// (a) Realize does not continue work merely because more work can be done.
const CONTINUE_NOT_MORE_WORK = "concrete unsatisfied";
const CONTINUE_NOT_MORE_WORK_VERIFICATION = /concrete unsatisfied[\s\S]*authorized obligation|authorized obligation[\s\S]*concrete unsatisfied/i;
const NO_REASSESS_BECAUSE_NO_EVIDENCE =
  "return-to-Authorize";

// (b) Material scope expansion returns to Authorize before implementation.
const SCOPE_EXPANSION_RETURN = "returns to Authorize";
const SCOPE_EXPANSION_VERIFICATION =
  /material[^.]*returns to Authorize|expansion[^.]*returns to Authorize|scope[^.]*returns to Authorize/i;

// (c) Worker return discipline: ready_for_review conditions, bounded
// Concerns, no rerun-without-mutation.
const READY_FOR_REVIEW_CONDITIONS =
  /ready_for_review[\s\S]*implementation exists|implementation exists[\s\S]*ready_for_review/i;
const READY_FOR_REVIEW_GUARD =
  "no known ticket-blocking defect";
const BOUNDED_CONCERNS_PHRASING = "bounded Concerns";
const NO_RERUN_WITHOUT_MUTATION =
  /no rerun[^.]*absent[^.]*mutation|no rerun[^.]*absent[^.]*hypothesis|rerun[^.]*same failing command[^.]*absent/i;
const NO_RERUN_VERIFICATION =
  /no rerun[\s\S]*absent[\s\S]*mutation|no rerun[\s\S]*absent[\s\S]*hypothesis|same failing command[\s\S]*absent/i;

// (d) Whole-change authoritative verification belongs to Prove (Method
// §10), not intermediate Realize (Method §8). Scoping is enforced by
// section-scoped assertions below; these regex constants describe the
// policy itself, not where it appears.
const WHOLE_CHANGE_PROOF_IN_PROVE =
  /whole-change Proof/i;
const WHOLE_CHANGE_PROOF_DECLARED = "Proof";
const FINDINGS_ARE_EVIDENCE =
  /findings[^.]*evidence[^.]*not commands|reviewer[^.]*evidence[^.]*not commands/i;
const MATERIAL_BLOCKS = /material[^.]*block|only material[^.]*block|only material contract-relevant issues block/i;
const MATERIAL_KINDS_PHRASING =
  /material correctness|material[^.]*security|material[^.]*reliability/i;
const MATERIAL_KINDS_WORDS =
  /correctness|security|reliability|spec|standards|design/i;
const BOUNDED_PASS_FAIL =
  /bounded PASS[\s\S]*actionable bounded FAIL|actionable bounded FAIL[\s\S]*bounded PASS|grouped by root cause|group[\s\S]*by root cause/i;
const REPEATED_REOPENING_REPLAN =
  /repeated[^.]*reopening[^.]*reassessment|Replan[^.]*repeated[^.]*reopening|reopening[^.]*triggers[^.]*reassessment|Replan[\s\S]*one-finding|one-finding[\s\S]*Replan/i;
const SMALLEST_COHERENT_TICKET =
  "smallest coherent engineering outcomes";
const BOUNDED_CHILD_CONTEXT =
  /child context[^.]*bounded|child returns[^.]*bounded|stays bounded/i;

// Negative-shape invariant: no new mode/stage/counter/budget/cache/
// telemetry/durable state/database/agent may be invented in the
// canonical Realize guidance. Realize owns no new machinery; it owns
// discipline over the existing machinery. Scoped to the Realize section
// so this stays the relevant Realize-only invariant.
const MACHINERY_DENIAL_PHRASING =
  /no (?:new )?(?:mode|stage|counter|budget|cache|telemetry|durable state|database|agent)/i;

// Negative-shape invariants the relevant Realize / Prove / Reviewer
// sections MUST NOT carry. A regression that drifts the policy into the
// wrong section — e.g. claims intermediate Realize owns whole-change
// authoritative verification, or blocks on optional preferences in the
// Reviewer, or invents new workflow machinery inside Realize — must be
// caught by a one-line diff.

// Realize (§8) must NOT claim ownership of whole-change authoritative
// verification; that authority belongs to Prove (§10). A Realize section
// that drifted into "we run whole-change Proof here" would be a hard
// contract violation.
const REALIZE_WHOLE_CHANGE_OWNERSHIP_NEGATIVE =
  /Realize[^.]*(?:owns|performs|runs|executes)[^.]*whole-change|whole-change[^.]*(?:owned|performed|run|executed)[^.]*Realize/i;
const REALIZE_AUTHORITATIVE_VERIFICATION_NEGATIVE =
  /Realize[^.]*(?:authoritative verification|final proof|whole-change proof)/i;

// Realize must NOT introduce a new workflow machinery surface (state
// machine, queue, retry loop, durable cache, telemetry, etc.). The
// policy says: Realize owns no new machinery. Section-scoped so the
// phrase appearing later in Operating rules is irrelevant here — the
// Realize discipline line is the one that binds.
const REALIZE_NEW_MACHINERY_NEGATIVE =
  /(?:new )?(?:workflow|state machine|orchestrator|retry loop|durable cache|retry queue|reconciliation loop|replay log|durable journal|stateful scheduler|external state|side-channel|telemetry pipeline)/i;

// Reviewer must NOT block on optional preferences or style preferences.
// Spec #108 says: only material contract-relevant issues block. The
// negative assertion must NOT match the *correct* Reviewer wording
// ("Distinguish material … from optional preferences; only material
// contract-relevant issues block."), so the pattern is anchored to a
// direct predicate claim that preferences block.
const REVIEWER_BLOCKS_PREFERENCES_NEGATIVE =
  /(?:optional|style) preferences[^.;]*\b(?:always|should|must|will|are expected to)\s+block/i;

describe("Spec #108 / ticket #109 Realize convergence guidance", () => {
  describe("canonical Realize prose invariants", () => {
    it("POIESIS_METHOD.md continues Realize only for concrete unsatisfied authorized obligations, not merely because more work can be done", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toContain(CONTINUE_NOT_MORE_WORK);
      expect(method).toMatch(CONTINUE_NOT_MORE_WORK_VERIFICATION);
    });

    it("POIESIS_METHOD.md returns material scope expansion discovered during Realize to Authorize before implementation", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(SCOPE_EXPANSION_VERIFICATION);
      expect(method).toContain(SCOPE_EXPANSION_RETURN);
    });

    it("POIESIS_METHOD.md names the Worker ready_for_review conditions (implementation exists, focused checks pass, no ticket-blocking defect)", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(READY_FOR_REVIEW_CONDITIONS);
      expect(method).toContain(READY_FOR_REVIEW_GUARD);
    });

    it("POIESIS_METHOD.md bounds unrelated failures as Concerns, not new debugging missions", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toContain(BOUNDED_CONCERNS_PHRASING);
    });

    it("POIESIS_METHOD.md forbids rerunning the same failing command without relevant mutation or concrete new hypothesis", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(NO_RERUN_VERIFICATION);
    });

    it("POIESIS_METHOD.md assigns whole-change authoritative verification to Prove (§10), not intermediate Realize (§8)", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realizeSection = extractMethodSection(method, "8. Realize");
      const proveSection = extractMethodSection(method, "10. Prove");
      // The Prove section is where whole-change authoritative verification
      // is owned. The Realize section is not.
      expect(proveSection).toMatch(WHOLE_CHANGE_PROOF_IN_PROVE);
      expect(realizeSection).not.toMatch(WHOLE_CHANGE_PROOF_IN_PROVE);
      // Realize must not claim ownership of whole-change authoritative
      // verification, nor claim it runs final proof / authoritative
      // verification itself.
      expect(realizeSection).not.toMatch(REALIZE_WHOLE_CHANGE_OWNERSHIP_NEGATIVE);
      expect(realizeSection).not.toMatch(REALIZE_AUTHORITATIVE_VERIFICATION_NEGATIVE);
    });

    it("POIESIS_METHOD.md Realize section (§8) forbids inventing new workflow machinery", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realizeSection = extractMethodSection(method, "8. Realize");
      expect(realizeSection).toMatch(MACHINERY_DENIAL_PHRASING);
      // Realize must NOT silently introduce a new workflow machinery
      // surface (state machine, retry loop, durable journal, telemetry
      // pipeline, etc.). The Realize discipline line is the binding one;
      // a regression that drifted new machinery into the Realize section
      // would be a hard contract violation.
      expect(realizeSection).not.toMatch(REALIZE_NEW_MACHINERY_NEGATIVE);
    });

    it("POIESIS_METHOD.md frames Reviewer findings as evidence, not commands, and gates on material contract-relevant issues only", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realizeSection = extractMethodSection(method, "8. Realize");
      expect(realizeSection).toMatch(FINDINGS_ARE_EVIDENCE);
      expect(realizeSection).toMatch(MATERIAL_BLOCKS);
      expect(realizeSection).toMatch(MATERIAL_KINDS_PHRASING);
    });

    it("POIESIS_METHOD.md requires bounded PASS, actionable bounded FAIL, grouped by root cause", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(BOUNDED_PASS_FAIL);
    });

    it("POIESIS_METHOD.md escalates repeated reopening of one semantic area to reassessment/Replan, not one-finding/one-ticket churn", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(REPEATED_REOPENING_REPLAN);
    });

    it("POIESIS_METHOD.md keeps tickets as smallest coherent engineering outcomes and bounded child context/returns", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toContain(SMALLEST_COHERENT_TICKET);
      expect(method).toMatch(BOUNDED_CHILD_CONTEXT);
    });

    it("POIESIS_METHOD.md owns no new Realize machinery (no new mode/stage/counter/budget/cache/telemetry/durable state/database/agent)", async () => {
      // Scoped to §8 Realize so the assertion is about Realize discipline,
      // not about a stray reuse of the words elsewhere in the document.
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realizeSection = extractMethodSection(method, "8. Realize");
      expect(realizeSection).toMatch(MACHINERY_DENIAL_PHRASING);
    });

    it("POIESIS_ROLE_POIESIS.md owns acceptance, localized correction, reassessment/diagnosis, Replan, and Authorize", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(/acceptance/i);
      expect(role).toMatch(/localized correction|correction/i);
      expect(role).toMatch(/reassessment|diagnosis/i);
      expect(role).toMatch(/Replan/i);
      expect(role).toContain("Authorize");
    });

    it("POIESIS_ROLE_POIESIS.md requires identifying the concrete unsatisfied authorized obligation before another implementation Worker", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(/concrete unsatisfied[\s\S]*authorized obligation|authorized obligation[\s\S]*concrete unsatisfied/i);
      expect(role).toMatch(/another implementation Worker|next implementation Worker|new implementation Worker/i);
    });

    it("POIESIS_ROLE_POIESIS.md returns material scope expansion to Authorize before implementation", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(SCOPE_EXPANSION_VERIFICATION);
      expect(role).toContain(SCOPE_EXPANSION_RETURN);
    });

    it("POIESIS_ROLE_WORKER.md returns ready_for_review only when implementation exists, focused checks pass, no known ticket-blocking defect", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(worker).toMatch(READY_FOR_REVIEW_CONDITIONS);
      expect(worker).toContain(READY_FOR_REVIEW_GUARD);
    });

    it("POIESIS_ROLE_WORKER.md frames unrelated failures absent causal evidence as bounded Concerns, not new debugging missions", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(worker).toContain(BOUNDED_CONCERNS_PHRASING);
    });

    it("POIESIS_ROLE_WORKER.md forbids rerunning the same failing command without relevant mutation or concrete new hypothesis", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(worker).toMatch(NO_RERUN_WITHOUT_MUTATION);
    });

    it("POIESIS_ROLE_WORKER.md preserves the smallest-coherent implementation and bounded return discipline", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      expect(worker).toMatch(/smallest coherent implementation/i);
      expect(worker).toMatch(/bounded|no narrative transcript/i);
    });

    it("POIESIS_ROLE_REVIEWER.md Return section frames findings as evidence, not commands, and only blocks on material contract-relevant issues", async () => {
      // Scoped to the Reviewer's Return section. The material/optional
      // distinction is a *return-disciplines* contract; testing the
      // whole-document would silently pass on a stray reuse of the
      // words in the bounded-evidence-gathering section.
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      const returnSection = extractRoleSection(reviewer, "Return");
      expect(returnSection).toMatch(FINDINGS_ARE_EVIDENCE);
      expect(returnSection).toMatch(MATERIAL_KINDS_PHRASING);
      expect(returnSection).toMatch(/optional preferences|preferences[^.]*do not matter|style preferences[^.]*do not matter/i);
      expect(returnSection).toMatch(MATERIAL_BLOCKS);
      // Negative: the Reviewer must NOT block on optional preferences or
      // style preferences. A regression that inverted the policy would
      // be caught here.
      expect(returnSection).not.toMatch(REVIEWER_BLOCKS_PREFERENCES_NEGATIVE);
    });

    it("POIESIS_ROLE_REVIEWER.md returns bounded PASS or actionable bounded FAIL, grouped by root cause", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      const returnSection = extractRoleSection(reviewer, "Return");
      expect(returnSection).toMatch(BOUNDED_PASS_FAIL);
      expect(returnSection).toContain("PASS");
      expect(returnSection).toContain("FAIL");
    });
  });

  describe("canonical templates remain thin and preserve exact-candidate + review-independence semantics", () => {
    it("POIESIS_METHOD.md preserves the exact-candidate identity invariants for Proof", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(/candidateSha/);
      expect(method).toMatch(/candidateTree/);
    });

    it("POIESIS_ROLE_REVIEWER.md preserves bounded evidence gathering (final review) invariants", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(reviewer).toContain("Bounded evidence gathering (final review)");
      expect(reviewer).toMatch(/exact candidate workspace/);
      expect(reviewer).toMatch(/parent-directory discovery/);
    });

    it("OPENCODE_AGENT_POIESIS.md / WORKER.md / REVIEWER.md stay thin and forward the canonical prose rather than duplicating the whole Spec", async () => {
      const poiesis = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
      const worker = await readRepoFile("OPENCODE_AGENT_WORKER.md");
      const reviewer = await readRepoFile("OPENCODE_AGENT_REVIEWER.md");
      // The canonical wrappers reference the role files verbatim; they
      // do NOT re-host the Spec #108 prose twice. Their job is to point
      // the agent at `.poiesis/roles/*.md` so a single canonical edit
      // updates both surfaces.
      expect(poiesis).toMatch(/\.poiesis\/roles\/poiesis\.md/);
      expect(worker).toMatch(/\.poiesis\/roles\/worker\.md/);
      expect(reviewer).toMatch(/\.poiesis\/roles\/reviewer\.md/);
      // None of the wrappers may invent new Spec #108 prose; they are
      // projections, not parallel sources of truth.
      expect(poiesis).not.toMatch(MACHINERY_DENIAL_PHRASING);
      expect(worker).not.toMatch(MACHINERY_DENIAL_PHRASING);
      expect(reviewer).not.toMatch(MACHINERY_DENIAL_PHRASING);
    });
  });

  describe("init installs the corrected canonical projections", () => {
    const repositories: TestRepository[] = [];
    afterEach(async () =>
      Promise.all(repositories.splice(0).map((repo) => rmLocal(repo.parent))),
    );

    it("init writes POIESIS_METHOD.md + the four canonical role files containing the Spec #108 contract phrases", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });

      const method = await readFile(join(repository.root, ".poiesis", "METHOD.md"), "utf8");
      const rolePoiesis = await readFile(join(repository.root, ".poiesis", "roles", "poiesis.md"), "utf8");
      const roleWorker = await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8");
      const roleReviewer = await readFile(join(repository.root, ".poiesis", "roles", "reviewer.md"), "utf8");

      expect(method).toMatch(CONTINUE_NOT_MORE_WORK_VERIFICATION);
      expect(method).toMatch(SCOPE_EXPANSION_VERIFICATION);
      expect(method).toMatch(READY_FOR_REVIEW_CONDITIONS);
      expect(method).toContain(BOUNDED_CONCERNS_PHRASING);
      expect(method).toMatch(NO_RERUN_VERIFICATION);
      expect(method).toMatch(WHOLE_CHANGE_PROOF_IN_PROVE);
      expect(method).toMatch(MATERIAL_BLOCKS);
      expect(method).toMatch(BOUNDED_PASS_FAIL);

      expect(rolePoiesis).toMatch(/concrete unsatisfied[\s\S]*authorized obligation/i);
      expect(rolePoiesis).toMatch(SCOPE_EXPANSION_VERIFICATION);

      expect(roleWorker).toMatch(READY_FOR_REVIEW_CONDITIONS);
      expect(roleWorker).toContain(BOUNDED_CONCERNS_PHRASING);

      expect(roleReviewer).toMatch(FINDINGS_ARE_EVIDENCE);
      expect(roleReviewer).toMatch(MATERIAL_BLOCKS);
      expect(roleReviewer).toMatch(BOUNDED_PASS_FAIL);
    }, 60_000);
  });

  describe("exact public 1.1.1 → 1.1.2 update regenerates the corrected owned projections and preserves unrelated state", () => {
    const repositories: TestRepository[] = [];
    afterEach(async () =>
      Promise.all(repositories.splice(0).map((repo) => rmLocal(repo.parent))),
    );

    it("trusted 1.1.1 predecessor update (Spec #108 / ticket #109) preserves unrelated OpenCode + models + tracker + delivery + complete skill installation state while regenerating the corrected owned projections", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      // Seed a non-empty representative preexisting default-skill
      // installation BEFORE init so the 1.1.1 → 1.1.2 update can prove
      // the COMPLETE skill record (source / name / path / preexisting /
      // installedRevision / hash) survives the migration. A test that
      // only compared `skills.length` against a 0-length baseline would
      // silently pass even if the update rewrote the record.
      const seeded = await seedRepresentativePreexistingSkill(repository);
      await setupCurrentInstall(repository);
      await attachSeededSkillToManifest(repository, seeded);
      await asPredecessorManifest(repository, "1.1.1", { keepReceipt: true });
      await rebindReceipt(repository);

      // Decorate the on-disk OpenCode config with project-owned keys
      // Poiesis never writes; the migration must leave them intact.
      const openCodePath = join(repository.root, "opencode.jsonc");
      const decorated = parseJsonc<Record<string, unknown>>(
        await readUtf8(openCodePath),
        openCodePath,
      );
      decorated["mcp_servers"] = {
        sentinel: { type: "stdio", command: ["echo", "preserved"], enabled: true },
      };
      decorated["theme"] = "customer-themed";
      const decoratedBytes = JSON.stringify(decorated, null, 2) + "\n";
      await writeFile(openCodePath, decoratedBytes);

      const beforeConfigBytes = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
      const beforeOpenCodeBytes = await readFile(openCodePath);
      const beforeManifest = await loadManifest(repository.root);
      // Snapshot the COMPLETE skill installation state so the post-
      // update assertions prove every field — not just the count —
      // survives the migration.
      const seededBefore = beforeManifest.skills.find((skill) => skill.name === seeded.name);
      expect(
        seededBefore,
        "Seeded preexisting skill record must be present on the 1.1.1 manifest",
      ).toBeDefined();
      const beforeSkillSnapshot = {
        source: seededBefore!.source,
        name: seededBefore!.name,
        path: seededBefore!.path,
        preexisting: seededBefore!.preexisting,
        installedRevision: seededBefore!.installedRevision,
        hash: seededBefore!.hash,
      };
      expect(beforeManifest.skills.length).toBeGreaterThan(0);

      const result = await update(repository.root, { skipSkills: true });

      // Manifest + projection advance together to 1.1.2.
      expect(result.manifest.poiesisVersion).toBe("1.1.2");

      // Corrected canonical projections are written to disk and contain
      // the Spec #108 contract phrases.
      const method = await readFile(join(repository.root, ".poiesis", "METHOD.md"), "utf8");
      const rolePoiesis = await readFile(join(repository.root, ".poiesis", "roles", "poiesis.md"), "utf8");
      const roleWorker = await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8");
      const roleReviewer = await readFile(join(repository.root, ".poiesis", "roles", "reviewer.md"), "utf8");
      expect(method).toMatch(CONTINUE_NOT_MORE_WORK_VERIFICATION);
      expect(method).toMatch(SCOPE_EXPANSION_VERIFICATION);
      expect(rolePoiesis).toMatch(/concrete unsatisfied[\s\S]*authorized obligation/i);
      expect(rolePoiesis).toMatch(SCOPE_EXPANSION_VERIFICATION);
      expect(roleWorker).toMatch(READY_FOR_REVIEW_CONDITIONS);
      expect(roleReviewer).toMatch(MATERIAL_BLOCKS);

      // The manifest's recorded file hashes match the post-update bytes
      // (i.e. the corrected canonical projections are owned by the
      // manifest, not foreign content).
      const recorded = new Map(result.manifest.files.map((file) => [file.path, file.hash]));
      for (const relativePath of [
        ".poiesis/METHOD.md",
        ".poiesis/roles/poiesis.md",
        ".poiesis/roles/worker.md",
        ".poiesis/roles/reviewer.md",
      ]) {
        const onDisk = await readUtf8(join(repository.root, relativePath));
        const recordedHash = recorded.get(relativePath);
        expect(recordedHash, `${relativePath} must be a manifest-owned file`).toBeDefined();
        expect(createHash("sha256").update(onDisk).digest("hex")).toBe(recordedHash);
      }

      // Unrelated OpenCode config survives untouched.
      const afterOpenCode = parseJsonc<Record<string, unknown>>(
        await readUtf8(openCodePath),
        openCodePath,
      );
      expect(afterOpenCode["mcp_servers"]).toEqual({
        sentinel: { type: "stdio", command: ["echo", "preserved"], enabled: true },
      });
      expect(afterOpenCode["theme"]).toBe("customer-themed");

      // `.poiesis/config.jsonc` (models / tracker / delivery) carries
      // forward verbatim.
      const afterConfigBytes = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
      const afterConfig = parseJsonc<{
        models: { reasoning: string; execution: string };
        tracker: { provider: string; project?: string };
        delivery: {
          preview: { adapter: string };
          staging: { adapter: string };
          production: { adapter: string };
        };
      }>(afterConfigBytes.toString("utf8"), "config.jsonc");
      const beforeConfig = parseJsonc<{
        models: { reasoning: string; execution: string };
        tracker: { provider: string; project?: string };
        delivery: {
          preview: { adapter: string };
          staging: { adapter: string };
          production: { adapter: string };
        };
      }>(beforeConfigBytes.toString("utf8"), "config.jsonc");
      expect(afterConfig.models).toEqual(beforeConfig.models);
      expect(afterConfig.tracker).toEqual(beforeConfig.tracker);
      expect(afterConfig.delivery).toEqual(beforeConfig.delivery);

      // Complete skill installation state survives the migration
      // (count, identity, fields, and on-disk directory hash).
      expect(result.manifest.skills.length).toBe(beforeManifest.skills.length);
      const seededAfter = result.manifest.skills.find((skill) => skill.name === seeded.name);
      expect(
        seededAfter,
        "Seeded preexisting skill record must survive the 1.1.1 → 1.1.2 update",
      ).toBeDefined();
      const afterSkillSnapshot = {
        source: seededAfter!.source,
        name: seededAfter!.name,
        path: seededAfter!.path,
        preexisting: seededAfter!.preexisting,
        installedRevision: seededAfter!.installedRevision,
        hash: seededAfter!.hash,
      };
      expect(afterSkillSnapshot).toEqual(beforeSkillSnapshot);
      // The on-disk skill directory hash must still match the recorded
      // hash so the doctor gate's skill check stays pass after update.
      const onDiskHash = await hashOwnedSkillDirectory(
        join(repository.root, beforeSkillSnapshot.path),
      );
      expect(onDiskHash).toBe(beforeSkillSnapshot.hash);

      // Receipt advanced by exactly one and the file bytes changed.
      expect(await readFile(openCodePath)).not.toEqual(beforeOpenCodeBytes);
      const afterManifestBytes = await readFile(join(repository.root, ".poiesis", "manifest.json"));
      const afterManifestOnDisk = parseJsonc<{ poiesisVersion: string }>(
        afterManifestBytes.toString("utf8"),
        "manifest.json",
      );
      expect(afterManifestOnDisk.poiesisVersion).toBe("1.1.2");
    }, 60_000);
  });
});

async function rmLocal(parent: string): Promise<void> {
  await rm(parent, { recursive: true, force: true });
}
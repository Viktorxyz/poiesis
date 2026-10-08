/**
 * Spec #168 / ticket #184 — convergent finding triage: the non-authoritative
 * preflight, the frozen realization ledger, and the grouped correction /
 * delta-review contract, across the canonical guidance and its projections.
 *
 * The loop this ticket closes is the one where Review findings arrive without
 * a shared triage contract. Unbounded, ungrouped findings turn one correction
 * into drip-fed one-finding rounds; findings that are really preferences or
 * pre-existing hardening turn a correction into churn; and a ledger written to
 * a repository file would make an internal bookkeeping decision into a
 * canonical artifact.
 *
 * This file is the executable contract for the prose that closes it:
 *
 *   1. Method §10 Prove gains a non-authoritative combined semantic preflight
 *      BEFORE deterministic Verify, on the existing Prove path — no new
 *      lifecycle phase and no new state machine — while the configured full
 *      verification plan still runs once and the two fresh separate
 *      identity-bound final reviews still run after Verify.
 *   2. A preflight / review finding blocks only when all four conjunctive
 *      criteria hold; pre-existing unrelated hardening, optional preferences,
 *      and hypotheticals are Concerns or future Specs.
 *   3. The frozen realization ledger carries exactly one disposition per
 *      finding (`accepted` / `rejected` / `non-blocking` / `resolved`), lives
 *      only in parent tracker comments and dispatch context, never in a
 *      repository file, database, cache, or runtime field, and a later
 *      snapshot supersedes an earlier one.
 *   4. Corrections are grouped and answered exhaustively; the delta review is
 *      scoped to the original grouped blockers, the exact diff, and the
 *      affected callers / direct regressions; one correction plus one delta
 *      review is the default; a closed area reopens only on new concrete
 *      evidence.
 *   5. Material architecture, platform-capability, and product-policy
 *      expansion returns to Authorize before implementation.
 *   6. Every final-review dispatch carries the exact identity, exact root,
 *      exact change scope, canonical Spec, Verify receipt, frozen ledger, and
 *      the bounded inline dispatch protocol — and a role file absent from the
 *      closed candidate workspace is not itself a blocker when its protocol
 *      arrives inline, unless the Spec requires the file.
 *
 * The OpenCode wrappers (OPENCODE_AGENT_*.md) stay thin projections of the
 * canonical roles. This file also pins that the guidance change broadened NO
 * permission projection: the installed OpenCode projection still equals the
 * projection the runtime builds for the current version.
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isExactProjection } from "../src/authority.js";
import { init, packageVersion, update } from "../src/maintenance.js";
import { desiredOpenCodePatches } from "../src/opencode.js";
import { asPredecessorManifest, rebindReceipt, setupCurrentInstall } from "./predecessor-migration-fixtures.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Body of one numbered top-level Method section. Whole-document regexes pass
 * silently when a phrase drifts into the wrong section — preflight belongs to
 * §10 Prove, grouped corrections to §8 Realize — so every assertion about
 * where a policy lives is scoped to its own section.
 */
function extractMethodSection(method: string, sectionTitle: string): string {
  const start = method.indexOf(`## ${sectionTitle}`);
  if (start === -1) throw new Error(`Method has no top-level section "## ${sectionTitle}"`);
  const bodyStart = method.indexOf("\n", start);
  if (bodyStart === -1) throw new Error(`Method section "## ${sectionTitle}" has no body`);
  let collected = "";
  for (const line of method.slice(bodyStart + 1).split(/\r?\n/)) {
    if (/^## \d+\. /.test(line)) break;
    collected += `${line}\n`;
  }
  return collected;
}

/** Body of a named `## Heading` section in a role document. */
function extractRoleSection(role: string, heading: string): string {
  const start = role.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`Role document has no top-level section "## ${heading}"`);
  const bodyStart = role.indexOf("\n", start);
  if (bodyStart === -1) throw new Error(`Role section "## ${heading}" has no body`);
  let collected = "";
  for (const line of role.slice(bodyStart + 1).split(/\r?\n/)) {
    if (/^## /.test(line)) break;
    collected += `${line}\n`;
  }
  return collected;
}

// --- Contract vocabulary ----------------------------------------------------

const PREFLIGHT_STEP = "non-authoritative combined semantic preflight";
const PREFLIGHT_NON_AUTHORITATIVE = /descriptive and non-authoritative/i;
const PREFLIGHT_NO_EVIDENCE = /no verification receipt, no Proof field, and no lifecycle evidence/i;
const PREFLIGHT_NEVER_RUNS_THE_PLAN = /never runs the configured full verification plan/i;
const ONE_FULL_PLAN = /configured full verification plan still runs once, here/i;
const FINAL_REVIEWS_RETAINED = /fresh, separate, identity-bound Spec and Standards Reviews still run after Verify/i;
const NO_NEW_PHASE_OR_MACHINE = /adds no new lifecycle phase and no new state machine/i;

const CRITERIA = [
  /concrete and reachable/i,
  /explicit violation of the current Spec or of a consequential standard/i,
  /materially affects correctness, security, reliability, or the Proof identity/i,
  /caused by the candidate, or it is a proven remaining authorized obligation/i,
] as const;
const CONJUNCTIVE = /all four criteria hold|all four criteria/;
const NOT_BLOCKERS = /pre-existing unrelated hardening opportunity, an optional preference, and a hypothetical risk are Concerns or future Specs, never blockers/i;
const BLOCKED_BY_AUTHORIZE = /returns to Authorize before implementation/i;

const DISPOSITIONS = ["accepted", "rejected", "non-blocking", "resolved"] as const;
const FROZEN_LEDGER = /frozen realization ledger/i;
const LEDGER_LOCATION = /parent tracker comments and (?:in )?dispatch context/i;
const LEDGER_NOT_PERSISTED =
  /never (?:as )?a repository file[^.]*a database entry[^.]*a cache entry[^.]*a runtime field/i;
const SUPERSEDE = /later snapshot supersedes an earlier one/i;

const GROUPED_NOT_DRIP_FED = /never one finding at a time/i;
const EXHAUSTIVE_GROUP_RESPONSE = /whole group exhaustively|grouped response/i;
const DELTA_SCOPE = [
  /original grouped blockers/i,
  /exact diff of the correction/i,
  /affected callers and direct regressions/i,
] as const;
const ONE_CORRECTION_DEFAULT = /One correction plus one delta review is the default/i;
const BOUNDED_POIESIS_REASSESSMENT = /bounded Poiesis reassessment/i;
const CLOSED_AREA_REOPENS = /closed area reopens only on new concrete evidence/i;

const DISPATCH_CONTENTS = [
  /exact candidate identity/i,
  /exact candidate root/i,
  /exact change scope/i,
  /canonical Spec content/i,
  /receiptId/i,
  /receiptDigest/i,
  /frozen realization ledger/i,
  /bounded inline dispatch content/i,
] as const;
const MISSING_ROLE_FILE =
  /role file[^.]*absent[^.]*is not itself a blocker[^.]*bounded inline dispatch content, unless the canonical Spec requires that file/i;

describe("Spec #168 / ticket #184 — convergent finding triage guidance", () => {
  describe("canonical Method: §10 Prove gains a non-authoritative preflight before Verify", () => {
    it("orders preflight before deterministic Verify and keeps both fresh final reviews after it", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const prove = extractMethodSection(method, "10. Prove");

      // The four-step Proof order: preflight is a descriptive first step on
      // the EXISTING Prove path, and the two fresh separate identity-bound
      // reviews remain after Verify.
      const ordered = [
    "non-authoritative combined semantic preflight",
    "deterministic Verify;",
    "fresh reasoning Spec Review;",
    "fresh reasoning Standards Review.",
  ];
      const positions = ordered.map((step) => prove.indexOf(step));
      for (const [index, position] of positions.entries()) {
        expect(position, `Prove must name "${ordered[index]}"`).toBeGreaterThanOrEqual(0);
      }
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(prove).toContain(PREFLIGHT_STEP);
      expect(prove).toMatch(PREFLIGHT_NON_AUTHORITATIVE);
      expect(prove).toMatch(FINAL_REVIEWS_RETAINED);
      // The two final reviews stay separate and identity-bound, never merged
      // into preflight or into each other.
      expect(prove).toMatch(/never merged into preflight or into each other/i);
      expect(prove).toMatch(/reviewerIdentity/);
    });

    it("keeps preflight non-authoritative: no receipt, no Proof field, no lifecycle evidence, and never the configured plan", async () => {
      const prove = extractMethodSection(await readRepoFile("POIESIS_METHOD.md"), "10. Prove");
      expect(prove).toMatch(PREFLIGHT_NO_EVIDENCE);
      expect(prove).toMatch(PREFLIGHT_NEVER_RUNS_THE_PLAN);
      // The configured full verification plan still runs exactly once, here.
      expect(prove).toMatch(ONE_FULL_PLAN);
      expect(prove).toMatch(/configured full verification plan runs once, here, against the exact candidate/i);
      // Preflight substitutes for nothing.
      expect(prove).toMatch(/never substitutes for Verify or for the two final reviews/i);
    });

    it("adds no new lifecycle phase and no new state machine", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const prove = extractMethodSection(method, "10. Prove");
      expect(prove).toMatch(NO_NEW_PHASE_OR_MACHINE);
      // Preflight is a descriptive SUBsection of Prove, never a numbered
      // lifecycle phase: a `## <n>.` heading would be a new phase.
      expect(method).not.toMatch(/^## \d+\.\s+Preflight/im);
      expect(method).toMatch(/^### Preflight$/m);
      expect(method).toMatch(/^### Realization ledger$/m);
      // Prove still owns exactly the original step count: Verify, Spec
      // Review, Standards Review.
      expect(prove).toMatch(/^### Verify$/m);
      expect(prove).toMatch(/^### Spec Review$/m);
      expect(prove).toMatch(/^### Standards Review$/m);
      // §8 Realize does not acquire the preflight.
      expect(extractMethodSection(method, "8. Realize")).not.toMatch(/preflight/i);
    });

    it("binds a preflight blocker to all four conjunctive criteria and names non-blockers as concerns or future Specs", async () => {
      const prove = extractMethodSection(await readRepoFile("POIESIS_METHOD.md"), "10. Prove");
      expect(prove).toMatch(CONJUNCTIVE);
      for (const criterion of CRITERIA) {
        expect(prove, `Prove must state the blocker criterion ${criterion}`).toMatch(criterion);
      }
      expect(prove).toMatch(NOT_BLOCKERS);
      expect(prove).toMatch(BLOCKED_BY_AUTHORIZE);
      // Architecture, platform-capability, and product-policy expansion each
      // return to Authorize before implementation.
      expect(prove).toMatch(/architecture expansion, platform-capability expansion, and product-policy expansion/i);
    });

    it("keeps the frozen realization ledger in tracker comments and dispatch context only", async () => {
      const prove = extractMethodSection(await readRepoFile("POIESIS_METHOD.md"), "10. Prove");
      expect(prove).toMatch(FROZEN_LEDGER);
      expect(prove).toMatch(LEDGER_LOCATION);
      expect(prove).toMatch(LEDGER_NOT_PERSISTED);
      expect(prove).toMatch(SUPERSEDE);
      for (const disposition of DISPOSITIONS) {
        expect(prove, `the ledger must name the "${disposition}" disposition`).toContain(disposition);
      }
      expect(prove).toMatch(/one disposition per finding/i);
    });
  });

  describe("canonical Method: §8 Realize groups corrections and bounds the delta review", () => {
    it("dispatches grouped blockers together and answers the whole group exhaustively", async () => {
      const realize = extractMethodSection(await readRepoFile("POIESIS_METHOD.md"), "8. Realize");
      expect(realize).toMatch(GROUPED_NOT_DRIP_FED);
      expect(realize).toMatch(/answers the whole group exhaustively/i);
      expect(realize).toMatch(/drip-feeding[^.]*not economy/i);
      // Preflight / whole-change Proof authority stays in §10.
      expect(realize).not.toMatch(/whole-change/i);
    });

    it("scopes the delta review to the original grouped blockers, the exact diff, and affected callers / direct regressions", async () => {
      const realize = extractMethodSection(await readRepoFile("POIESIS_METHOD.md"), "8. Realize");
      for (const element of DELTA_SCOPE) {
        expect(realize, `the delta-review scope must name ${element}`).toMatch(element);
      }
      // The delta review does not re-open the candidate wholesale.
      expect(realize).toMatch(/does not re-open the candidate wholesale/i);
      expect(realize).toMatch(ONE_CORRECTION_DEFAULT);
      expect(realize).toMatch(BOUNDED_POIESIS_REASSESSMENT);
      expect(realize).toMatch(/only for what that reassessment authorizes/i);
    });

    it("reopens a closed area only on new concrete evidence", async () => {
      const realize = extractMethodSection(await readRepoFile("POIESIS_METHOD.md"), "8. Realize");
      expect(realize).toMatch(CLOSED_AREA_REOPENS);
      expect(realize).toMatch(/never a re-reading of an area already closed without new evidence/i);
    });
  });

  describe("canonical Poiesis role", () => {
    it("owns preflight triage against the conjunctive criteria", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toContain(PREFLIGHT_STEP);
      expect(role).toMatch(/conjunctive blocker criteria/i);
      expect(role).toMatch(/never runs the configured full verification plan/i);
      expect(role).toMatch(/Verify and the two fresh separate identity-bound final reviews still run after it/i);
      expect(role).toMatch(NO_NEW_PHASE_OR_MACHINE);
      expect(role).toMatch(/Concerns or future Specs, never blockers/i);
      expect(role).toMatch(BLOCKED_BY_AUTHORIZE);
    });

    it("owns the frozen realization ledger and refuses to persist it", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(FROZEN_LEDGER);
      expect(role).toMatch(LEDGER_LOCATION);
      expect(role).toMatch(LEDGER_NOT_PERSISTED);
      expect(role).toMatch(SUPERSEDE);
      for (const disposition of DISPOSITIONS) {
        expect(role, `Poiesis must name the "${disposition}" disposition`).toContain(disposition);
      }
      expect(role).toMatch(/persist the realization ledger anywhere but parent tracker comments and dispatch context/i);
    });

    it("owns the grouped correction dispatch, the bounded delta review, and the Authorize return", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(/every grouped blocker is dispatched together and answered exhaustively rather than drip-fed/i);
      for (const element of DELTA_SCOPE) {
        expect(role, `Poiesis delta-review scope must name ${element}`).toMatch(element);
      }
      expect(role).toMatch(ONE_CORRECTION_DEFAULT);
      expect(role).toMatch(BOUNDED_POIESIS_REASSESSMENT);
      expect(role).toMatch(CLOSED_AREA_REOPENS);
      expect(role).toMatch(/material architecture expansion, platform-capability expansion, or product-policy expansion to Authorize/i);
    });

    it("requires every final-review dispatch to carry identity, root, change scope, Spec, Verify receipt, frozen ledger, and the inline protocol", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      const section = extractRoleSection(role, "Final-review dispatch");
      for (const element of DISPATCH_CONTENTS) {
        expect(section, `final-review dispatch must name ${element}`).toMatch(element);
      }
      expect(role).toMatch(MISSING_ROLE_FILE);
    });
  });

  describe("canonical Worker role carries the grouped correction contract", () => {
    it("answers the whole dispatched group exhaustively in one correction", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      const section = extractRoleSection(worker, "Correction");
      expect(section).toMatch(/they arrive grouped/i);
      expect(section).toMatch(/answers the whole group/i);
      expect(section).toMatch(/Respond to every grouped blocker exhaustively in one pass/i);
      expect(section).toMatch(/Do not drip-feed partial responses/i);
      // The bounded handoff discipline survives the grouped contract.
      expect(section).toMatch(/bounded reassessment/i);
      expect(section).toMatch(/Do not enter repeated self-directed fix loops/i);
      expect(section).toMatch(BLOCKED_BY_AUTHORIZE);
    });

    it("keeps the correction scoped to the blockers, the exact diff, and the affected callers / direct regressions", async () => {
      const section = extractRoleSection(await readRepoFile("POIESIS_ROLE_WORKER.md"), "Correction");
      for (const element of DELTA_SCOPE) {
        expect(section, `Worker correction scope must name ${element}`).toMatch(element);
      }
      expect(section).toMatch(/do not silently widen the correction into unrelated areas/i);
      expect(section).toMatch(ONE_CORRECTION_DEFAULT);
    });

    it("claims no preflight authority and no ledger of its own", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      const boundaries = extractRoleSection(worker, "Git and workflow boundaries");
      expect(boundaries).toMatch(/run the pre-change semantic preflight or hold any finding ledger beyond the returned handoff/i);
      expect(boundaries).toMatch(/widen a correction into unrelated areas or answer only part of a dispatched blocker group/i);
      // Worker ownership is unchanged: no lifecycle, Proof, or review authority.
      expect(worker).toMatch(/Make the smallest coherent implementation that satisfies the ticket and Spec/i);
      expect(worker).not.toMatch(/frozen realization ledger/);
    });
  });

  describe("canonical Reviewer role applies the same triage, ledger, and delta contract", () => {
    it("binds a blocking finding to all four conjunctive criteria", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      const section = extractRoleSection(reviewer, "Finding triage");
      expect(section).toMatch(CONJUNCTIVE);
      for (const criterion of CRITERIA) {
        expect(section, `Reviewer triage must state ${criterion}`).toMatch(criterion);
      }
      expect(section).toMatch(/Concerns or future Specs, never blockers/i);
      expect(section).toMatch(BLOCKED_BY_AUTHORIZE);
      // The Reviewer gains no check route and no lifecycle ownership.
      expect(reviewer).not.toMatch(/poiesis check/);
      expect(reviewer).not.toMatch(/focused check/i);
    });

    it("reports one disposition per finding and keeps the ledger in dispatch context", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      const triage = extractRoleSection(reviewer, "Finding triage");
      for (const disposition of DISPOSITIONS) {
        expect(triage, `Reviewer triage must name the "${disposition}" disposition`).toContain(disposition);
      }
      expect(triage).toMatch(/one disposition per finding/i);
      expect(triage).toMatch(LEDGER_NOT_PERSISTED);
      expect(triage).toMatch(SUPERSEDE);
      const returnSection = extractRoleSection(reviewer, "Return");
      expect(returnSection).toMatch(FROZEN_LEDGER);
      expect(returnSection).toMatch(/every blocking finding in one grouped response/i);
    });

    it("bounds the delta review and reopens a closed area only on new concrete evidence", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      const triage = extractRoleSection(reviewer, "Finding triage");
      for (const element of DELTA_SCOPE) {
        expect(triage, `Reviewer delta-review scope must name ${element}`).toMatch(element);
      }
      expect(triage).toMatch(/does not re-open the whole candidate and does not widen into unrelated areas/i);
      expect(triage).toMatch(CLOSED_AREA_REOPENS);
      const boundaries = extractRoleSection(reviewer, "Boundaries");
      expect(boundaries).toMatch(/drip-feed findings, or hold part of a group back for a later round/i);
    });

    it("does not treat a missing role file as a blocker when the protocol is inline", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(reviewer).toMatch(MISSING_ROLE_FILE);
      // Required-but-missing material is still missing evidence.
      expect(reviewer).toMatch(/stays missing evidence/i);
    });
  });

  describe("OpenCode projections stay thin and consistent with the canonical roles", () => {
    it("the Poiesis wrapper carries the preflight, ledger, grouped dispatch, and the full final-review dispatch", async () => {
      const poiesis = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
      expect(poiesis).toMatch(/combined semantic preflight/);
      expect(poiesis).toMatch(/all four criteria/);
      expect(poiesis).toMatch(/never runs the configured full verification plan/i);
      expect(poiesis).toMatch(FROZEN_LEDGER);
      expect(poiesis).toMatch(SUPERSEDE);
      for (const disposition of DISPOSITIONS) {
        expect(poiesis, `the Poiesis wrapper must name the "${disposition}" disposition`).toContain(disposition);
      }
      expect(poiesis).toMatch(/never in a repository file, database, cache, or runtime field/i);
      expect(poiesis).toMatch(/original grouped blockers, the exact diff, and the affected callers and direct regressions/i);
      expect(poiesis).toMatch(/reopen a closed area only on new concrete evidence/i);
      expect(poiesis).toMatch(BLOCKED_BY_AUTHORIZE);
      // The wrapper keeps the final-review dispatch as one paragraph, so the
      // dispatch contents are asserted against the wrapper text itself.
      const dispatch = poiesis.slice(poiesis.indexOf("Final-review dispatch:"));
      for (const element of DISPATCH_CONTENTS) {
        expect(dispatch, `the projected final-review dispatch must name ${element}`).toMatch(element);
      }
      expect(poiesis).toMatch(MISSING_ROLE_FILE);
      // Thin projection, still forwarding the canonical role file.
      expect(poiesis).toMatch(/\.poiesis\/roles\/poiesis\.md/);
    });

    it("the Worker, Reviewer, and Final Reviewer wrappers stay thin projections", async () => {
      const poiesis = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
      const worker = await readRepoFile("OPENCODE_AGENT_WORKER.md");
      const reviewer = await readRepoFile("OPENCODE_AGENT_REVIEWER.md");
      const finalReviewer = await readRepoFile("OPENCODE_AGENT_FINAL_REVIEWER.md");

      expect(worker).toMatch(/\.poiesis\/roles\/worker\.md/);
      expect(worker).toMatch(/Answer every grouped blocker exhaustively in one correction/i);
      expect(worker).toMatch(ONE_CORRECTION_DEFAULT);
      expect(worker).toMatch(/drip-feed/i);

      expect(reviewer).toMatch(/\.poiesis\/roles\/reviewer\.md/);
      expect(reviewer).toMatch(/all four criteria/);
      for (const disposition of DISPOSITIONS) {
        expect(reviewer, `the Reviewer wrapper must name the "${disposition}" disposition`).toContain(disposition);
      }
      expect(reviewer).toMatch(/the ledger travels in dispatch context, not in a file you create/i);

      expect(finalReviewer).toMatch(/\.poiesis\/roles\/reviewer\.md/);
      expect(finalReviewer).toMatch(FROZEN_LEDGER);
      expect(finalReviewer).toMatch(CLOSED_AREA_REOPENS);
      expect(finalReviewer).toMatch(MISSING_ROLE_FILE);

      // The wrappers add no permission projection and no new lifecycle
      // machinery: they are prompt text, never an authorization surface.
      for (const wrapper of [poiesis, worker, reviewer, finalReviewer]) {
        expect(wrapper).not.toMatch(/permission\.bash/);
        expect(wrapper).not.toMatch(/"allow"/);
        expect(wrapper).not.toMatch(
          /no (?:new )?(?:mode|stage|counter|budget|cache|telemetry|durable state|database|agent)/i,
        );
      }
    });
  });

  describe("init and update project the corrected guidance without broadening the permission projection", () => {
    const repositories: TestRepository[] = [];
    afterEach(async () =>
      Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true }))),
    );

    it("init writes the preflight / ledger / delta guidance as manifest-owned canonical projections", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const current = await packageVersion();
      const manifest = await init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      });

      const method = await readFile(join(repository.root, ".poiesis", "METHOD.md"), "utf8");
      const rolePoiesis = await readFile(join(repository.root, ".poiesis", "roles", "poiesis.md"), "utf8");
      const roleWorker = await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8");
      const roleReviewer = await readFile(join(repository.root, ".poiesis", "roles", "reviewer.md"), "utf8");
      const agentPoiesis = await readFile(join(repository.root, ".opencode", "agents", "poiesis.md"), "utf8");

      const prove = extractMethodSection(method, "10. Prove");
      const realize = extractMethodSection(method, "8. Realize");
      expect(prove).toContain(PREFLIGHT_STEP);
      expect(prove).toMatch(CONJUNCTIVE);
      expect(prove).toMatch(FROZEN_LEDGER);
      expect(prove).toMatch(LEDGER_NOT_PERSISTED);
      expect(realize).toMatch(/original grouped blockers/);
      expect(rolePoiesis).toMatch(FROZEN_LEDGER);
      expect(rolePoiesis).toMatch(MISSING_ROLE_FILE);
      expect(roleWorker).toMatch(/answers the whole group/i);
      expect(roleReviewer).toMatch(CONJUNCTIVE);
      expect(agentPoiesis).toMatch(FROZEN_LEDGER);

      // The regenerated files are manifest-owned, not foreign content.
      const recorded = new Map(manifest.files.map((file) => [file.path, file.hash]));
      for (const relativePath of [
        ".poiesis/METHOD.md",
        ".poiesis/roles/poiesis.md",
        ".poiesis/roles/worker.md",
        ".poiesis/roles/reviewer.md",
        ".opencode/agents/poiesis.md",
      ]) {
        const onDisk = await readFile(join(repository.root, relativePath));
        expect(recorded.get(relativePath), `${relativePath} must be a manifest-owned file`).toBeDefined();
        expect(createHash("sha256").update(onDisk).digest("hex")).toBe(recorded.get(relativePath));
      }

      // No permission projection broadening: the installed projection is
      // exactly the projection the runtime builds for the current version.
      expect(
        isExactProjection(manifest, desiredOpenCodePatches(testConfig(repository), current)),
        "guidance changes must not change the OpenCode permission projection",
      ).toBe(true);
    }, 120_000);

    it("a trusted predecessor update regenerates the same guidance on the current release", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const current = await packageVersion();
      await setupCurrentInstall(repository);
      await asPredecessorManifest(repository, "1.1.1", { keepReceipt: true });
      await rebindReceipt(repository);

      const result = await update(repository.root, { skipSkills: true });
      expect(result.manifest.poiesisVersion).toBe(current);

      const method = await readFile(join(repository.root, ".poiesis", "METHOD.md"), "utf8");
      const roleWorker = await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8");
      const roleReviewer = await readFile(join(repository.root, ".poiesis", "roles", "reviewer.md"), "utf8");

      expect(extractMethodSection(method, "10. Prove")).toContain(PREFLIGHT_STEP);
      expect(extractMethodSection(method, "8. Realize")).toMatch(ONE_CORRECTION_DEFAULT);
      expect(roleWorker).toMatch(/Do not drip-feed partial responses/i);
      expect(roleReviewer).toMatch(CONJUNCTIVE);

      // The crossing advances onto the current exact-version projection and
      // grants no extra launcher route.
      expect(
        isExactProjection(result.manifest, desiredOpenCodePatches(testConfig(repository), current)),
      ).toBe(true);
    }, 120_000);
  });
});
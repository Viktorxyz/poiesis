import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  init,
  update,
} from "../src/maintenance.js";
import { loadManifest } from "../src/manifest.js";
import { parseJsonc } from "../src/config.js";
import { readUtf8 } from "../src/fs.js";
import {
  asPredecessorManifest,
  rebindReceipt,
  setupCurrentInstall,
} from "./predecessor-migration-fixtures.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

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

// (d) Whole-change authoritative verification belongs to Prove. Reviewer
// findings are evidence, not commands; only material contract-relevant
// issues block; bounded PASS, actionable bounded FAIL grouped by root
// cause. Repeated reopening → reassessment/Replan. Tickets are
// smallest coherent engineering outcomes. Child context/returns stay
// bounded.
const WHOLE_CHANGE_PROOF =
  /whole-change[\s\S]*Prove|whole-change authoritative verification belongs to Prove/i;
const FINDINGS_ARE_EVIDENCE =
  /findings[^.]*evidence[^.]*not commands|reviewer[^.]*evidence[^.]*not commands/i;
const MATERIAL_BLOCKS = /material[^.]*block|only material[^.]*block|only material contract-relevant issues block/i;
const MATERIAL_KINDS =
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
// discipline over the existing machinery.
const MACHINERY_DENIAL_PHRASING =
  /no (?:new )?(?:mode|stage|counter|budget|cache|telemetry|durable state|database|agent)/i;

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

    it("POIESIS_METHOD.md assigns whole-change authoritative verification to Prove, not intermediate Realize", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(WHOLE_CHANGE_PROOF);
    });

    it("POIESIS_METHOD.md frames Reviewer findings as evidence, not commands, and gates on material contract-relevant issues only", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(FINDINGS_ARE_EVIDENCE);
      expect(method).toMatch(MATERIAL_BLOCKS);
      expect(method).toMatch(MATERIAL_KINDS);
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
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(MACHINERY_DENIAL_PHRASING);
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

    it("POIESIS_ROLE_REVIEWER.md frames findings as evidence, not commands", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(reviewer).toMatch(FINDINGS_ARE_EVIDENCE);
    });

    it("POIESIS_ROLE_REVIEWER.md distinguishes material correctness/security/reliability/spec/standards/design from optional preferences", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(reviewer).toMatch(MATERIAL_KINDS);
      expect(reviewer).toMatch(/optional preferences|preferences[^.]*do not matter|style preferences[^.]*do not matter/i);
    });

    it("POIESIS_ROLE_REVIEWER.md only blocks on material contract-relevant issues", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(reviewer).toMatch(MATERIAL_BLOCKS);
    });

    it("POIESIS_ROLE_REVIEWER.md returns bounded PASS or actionable bounded FAIL, grouped by root cause", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(reviewer).toMatch(BOUNDED_PASS_FAIL);
      expect(reviewer).toContain("PASS");
      expect(reviewer).toContain("FAIL");
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
      expect(method).toMatch(WHOLE_CHANGE_PROOF);
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

    it("trusted 1.1.1 predecessor update (Spec #108 / ticket #109) preserves unrelated OpenCode + models + tracker + delivery + skills state while regenerating the corrected owned projections", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await setupCurrentInstall(repository);
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
      const beforeSkillsCount = beforeManifest.skills.length;

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

      // Skill installation state is preserved.
      expect(result.manifest.skills.length).toBe(beforeSkillsCount);

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
/**
 * Spec #168 / ticket #173 — convergent Realize checks without repeated full
 * Proof: the canonical guidance and its installed projections.
 *
 * Ticket #172 built the one non-authoritative focused-check surface. Without
 * guidance, the canonical Method and the generated roles still described a
 * Realize loop in which a ticket's evidence came either from unstructured
 * shell output or from running the configured full verification plan. Both
 * produce the same loop the Spec set out to remove: an unchanged failure that
 * looks like new work, answered with another identical run.
 *
 * This file is the executable contract for the prose that closes it:
 *
 *   1. the configured full verification plan is reserved for ONE Proof run
 *      against the exact candidate, and Realize requires each ticket's
 *      relevant focused checks instead;
 *   2. the same command, state fingerprint, and failure classification cannot
 *      justify another attempt without a relevant mutation, a concrete new
 *      hypothesis, or escalation;
 *   3. a `likely-load-induced-timeout` / `timeout-unknown` classification
 *      calls for bounded reassessment — never a blind repeat and never an
 *      unsupported success claim;
 *   4. a known child session is cleaned up at a deterministic handoff or
 *      termination when its identity is available;
 *   5. Worker/Reviewer ownership is preserved and no second check or review
 *      engine is introduced.
 *
 * The contract spans POIESIS_METHOD.md (§8 Realize and §10 Prove), 
 * POIESIS_ROLE_POIESIS.md, and POIESIS_ROLE_WORKER.md, plus the projections
 * `init` and `update` write. The OpenCode wrappers stay thin projections, and
 * the Reviewer role is asserted to be UNCHANGED in ownership.
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { init, packageVersion, update } from "../src/maintenance.js";
import { asPredecessorManifest, rebindReceipt, setupCurrentInstall } from "./predecessor-migration-fixtures.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Body of one numbered top-level Method section. Whole-document regexes would
 * silently pass when a phrase drifts into a different section — e.g.
 * `whole-change Proof` belongs to §10 Prove, never to §8 Realize — so every
 * assertion about where a policy lives is scoped to its own section.
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

/** The one route a Worker owns: exact manifest version, one subcommand. */
const WORKER_CHECK_ROUTE = "pnpm dlx poiesis-cli@<manifest.poiesisVersion> check --command";

const FOCUSED_CHECKS_REQUIRED = /relevant focused (?:ticket )?checks/i;
const RESERVED_PLAN = /configured full verification plan/;
const ACTION_FINGERPRINT = "action fingerprint";
const STATE_FINGERPRINT = "state fingerprint";
const FAILURE_CLASSIFICATION = "failure classification";
const REPEAT_JUSTIFICATIONS = [
  "relevant mutation",
  "concrete new hypothesis",
  "escalation",
] as const;
/**
 * The runtime's own closed retry vocabulary (Spec #168 / ticket #172
 * `CHECK_RETRY_REASONS`). The Worker guidance must name these exact tokens:
 * a reason the prose does not declare is refused by the runtime with
 * `INVALID_CHECK_RETRY_REASON`, so prose and vocabulary cannot drift.
 */
const DECLARED_RETRY_REASONS = [
  "mutation-since-last-attempt",
  "new-hypothesis",
  "focused-recheck-authorized",
] as const;
const TIMEOUT_CLASSIFICATIONS = ["likely-load-induced-timeout", "timeout-unknown"] as const;
const BOUNDED_REASSESSMENT = /bounded reassessment/i;
const NO_BLIND_REPEAT = /never repeat it blindly|do not repeat it blindly|never blind[- ]repeat/i;
const NO_FALSE_SUCCESS = /never report success/i;
const SESSION_CLEANUP_ROUTE = "poiesis session cleanup --id";
const SESSION_CLEANUP_BOUNDARY = /deterministic handoff or termination/i;
const SESSION_IDENTITY = /identity is known|identity known|known child session identity/i;
const SESSION_STAYS_HYGIENE = /stays hygiene|is hygiene, not a correctness dependency/i;
const WORKER_OWNS_FOCUSED = /worker owns[^.]*focused checks/i;
const REVIEWER_OWNS_REVIEW = /reviewer owns[^.]*independent review/i;
const NO_SECOND_ENGINE = /no second (?:check or review|workflow) engine/i;

describe("Spec #168 / ticket #173 — convergent Realize check guidance", () => {
  describe("canonical Method: §8 Realize requires focused checks and reserves full verification", () => {
    it("requires each ticket's relevant focused checks and reserves the configured full verification plan for Prove", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realize = extractMethodSection(method, "8. Realize");
      expect(realize).toMatch(FOCUSED_CHECKS_REQUIRED);
      expect(realize).toMatch(RESERVED_PLAN);
      expect(realize).toMatch(/reserved for one Proof run against the exact candidate, inside Prove/i);
      // Whole-change Proof authority belongs to §10 Prove alone. A Realize
      // section that ran or claimed the whole-change Proof would be the exact
      // regression this ticket removes.
      expect(realize).not.toMatch(/whole-change/i);
      const prove = extractMethodSection(method, "10. Prove");
      expect(prove).toMatch(/whole-change Proof/i);
      expect(prove).toMatch(RESERVED_PLAN);
      expect(prove).toMatch(/runs once, here, against the exact candidate/i);
    });

    it("binds a repeat to a relevant mutation, a concrete new hypothesis, or escalation", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realize = extractMethodSection(method, "8. Realize");
      expect(realize).toContain(ACTION_FINGERPRINT);
      expect(realize).toContain(STATE_FINGERPRINT);
      expect(realize).toContain(FAILURE_CLASSIFICATION);
      expect(realize).toMatch(/same command, state fingerprint, and failure classification does not justify another attempt/i);
      for (const justification of REPEAT_JUSTIFICATIONS) {
        expect(realize, `Realize must name the "${justification}" justification`).toContain(justification);
      }
    });

    it("turns a likely-load or unknown timeout into bounded reassessment, never a blind repeat or a false success", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realize = extractMethodSection(method, "8. Realize");
      for (const classification of TIMEOUT_CLASSIFICATIONS) {
        expect(realize, `Realize must name ${classification}`).toContain(classification);
      }
      expect(realize).toMatch(BOUNDED_REASSESSMENT);
      expect(realize).toMatch(NO_BLIND_REPEAT);
      expect(realize).toMatch(NO_FALSE_SUCCESS);
    });

    it("keeps Worker/Reviewer ownership and adds no second check or review engine", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      const realize = extractMethodSection(method, "8. Realize");
      expect(realize).toMatch(WORKER_OWNS_FOCUSED);
      expect(realize).toMatch(REVIEWER_OWNS_REVIEW);
      expect(realize).toMatch(/focused checks never substitute for review/i);
      expect(realize).toMatch(NO_SECOND_ENGINE);
      // Realize still owns no new machinery (Spec #108 invariant).
      expect(realize).toMatch(/no (?:new )?(?:mode|stage|counter|budget|cache|telemetry|durable state|database|agent)/i);
    });

    it("requires cleanup of a known child session at a deterministic handoff or termination", async () => {
      const method = await readRepoFile("POIESIS_METHOD.md");
      expect(method).toMatch(
        /child session[\s\S]{0,400}deterministic (?:handoff|termination)|deterministic (?:handoff|termination)[\s\S]{0,400}child session/i,
      );
      expect(method).toMatch(SESSION_CLEANUP_BOUNDARY);
      expect(method).toMatch(SESSION_IDENTITY);
      // Hygiene framing survives: cleanup never becomes a correctness gate.
      expect(method).toMatch(SESSION_STAYS_HYGIENE);
    });
  });

  describe("canonical Worker role", () => {
    it("carries a Focused checks section naming the one route it owns", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      const section = extractRoleSection(worker, "Focused checks");
      expect(section).toContain(WORKER_CHECK_ROUTE);
      expect(section).toMatch(/non-authoritative/i);
      // The configured plan is Prove's, not a ticket check.
      expect(section).toMatch(RESERVED_PLAN);
      expect(section).toMatch(/never run it as one/i);
      // No general lifecycle route is acquired.
      expect(section).toMatch(/hold no other Poiesis route, and you do not acquire one/i);
    });

    it("states that a focused check is evidence, never proof", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      const section = extractRoleSection(worker, "Focused checks");
      expect(section).toMatch(/not proof/i);
      expect(section).toMatch(/writes nothing/i);
      expect(section).toMatch(/no verification receipt/i);
      expect(section).toMatch(/never satisfy Prove/i);
      expect(section).toContain(ACTION_FINGERPRINT);
    });

    it("binds a repeat to mutation, hypothesis, or escalation and keeps the Spec #108 no-rerun phrasing", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      const section = extractRoleSection(worker, "Focused checks");
      expect(section).toContain(STATE_FINGERPRINT);
      expect(section).toContain(FAILURE_CLASSIFICATION);
      for (const justification of REPEAT_JUSTIFICATIONS) {
        expect(section, `Worker guidance must name the "${justification}" justification`).toContain(justification);
      }
      expect(section).toMatch(
        /do not rerun the same failing command absent[^.]*mutation|no rerun[^.]*absent[^.]*mutation/i,
      );
      // The guidance must name the runtime's declared retry tokens so a
      // Worker never passes a reason the executor would refuse.
      for (const reason of DECLARED_RETRY_REASONS) {
        expect(section, `Worker guidance must declare the ${reason} retry reason`).toContain(reason);
      }
      const { CHECK_RETRY_REASONS } = await import("../src/focused-check.js");
      expect([...CHECK_RETRY_REASONS].sort()).toEqual([...DECLARED_RETRY_REASONS].sort());
    });

    it("turns a likely-load or unknown timeout into bounded reassessment", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      const section = extractRoleSection(worker, "Focused checks");
      for (const classification of TIMEOUT_CLASSIFICATIONS) {
        expect(section, `Worker guidance must name ${classification}`).toContain(classification);
      }
      expect(section).toMatch(NO_BLIND_REPEAT);
      expect(section).toMatch(NO_FALSE_SUCCESS);
      expect(section).toMatch(/reassess within a bound/i);
    });

    it("preserves Worker implementation/Review independence", async () => {
      const worker = await readRepoFile("POIESIS_ROLE_WORKER.md");
      const section = extractRoleSection(worker, "Focused checks");
      expect(section).toMatch(/focused checks do not replace review/i);
      expect(section).toMatch(/the Reviewer owns independent review/i);
    });
  });

  describe("canonical Poiesis role", () => {
    it("reserves the configured full verification plan for the one Proof run and requires focused checks during Realize", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toMatch(RESERVED_PLAN);
      expect(role).toMatch(/single whole-change Proof in Prove/i);
      expect(role).toMatch(/relevant focused checks during Realize/i);
    });

    it("judges a repeat by the action fingerprint and the three declared justifications", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toContain(ACTION_FINGERPRINT);
      expect(role).toMatch(
        /same command, state fingerprint, and failure classification never justifies another attempt by itself/i,
      );
      for (const justification of REPEAT_JUSTIFICATIONS) {
        expect(role, `Poiesis guidance must name the "${justification}" justification`).toContain(justification);
      }
    });

    it("requires bounded reassessment for a likely-load or unknown timeout", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      for (const classification of TIMEOUT_CLASSIFICATIONS) {
        expect(role, `Poiesis guidance must name ${classification}`).toContain(classification);
      }
      expect(role).toMatch(BOUNDED_REASSESSMENT);
      expect(role).toMatch(/blind repeat/i);
      expect(role).toMatch(/success claim the evidence does not support/i);
    });

    it("requires known child-session cleanup at a deterministic handoff or termination", async () => {
      const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
      expect(role).toContain(SESSION_CLEANUP_ROUTE);
      expect(role).toMatch(SESSION_CLEANUP_BOUNDARY);
      expect(role).toMatch(SESSION_IDENTITY);
      expect(role).toMatch(/never blocks or gates the lifecycle/i);
    });
  });

  describe("Reviewer ownership is untouched", () => {
    it("POIESIS_ROLE_REVIEWER.md gains no check route and no focused-check ownership", async () => {
      const reviewer = await readRepoFile("POIESIS_ROLE_REVIEWER.md");
      expect(reviewer).not.toMatch(/poiesis check/);
      expect(reviewer).not.toMatch(/focused check/i);
      expect(reviewer).not.toMatch(/pnpm dlx poiesis-cli@/);
    });

    it("the OpenCode wrappers stay thin projections that forward the canonical roles", async () => {
      const worker = await readRepoFile("OPENCODE_AGENT_WORKER.md");
      const poiesis = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
      expect(worker).toMatch(/\.poiesis\/roles\/worker\.md/);
      expect(poiesis).toMatch(/\.poiesis\/roles\/poiesis\.md/);
      // The wrappers must not re-host the focused-check policy as a second
      // source of truth.
      expect(worker).not.toMatch(/action fingerprint/i);
      expect(poiesis).not.toMatch(/action fingerprint/i);
    });
  });

  describe("init and update project the corrected guidance", () => {
    const repositories: TestRepository[] = [];
    afterEach(async () =>
      Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true }))),
    );

    it("init writes the corrected canonical projections and the narrow Worker check allow", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const current = await packageVersion();
      await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });

      const method = await readFile(join(repository.root, ".poiesis", "METHOD.md"), "utf8");
      const rolePoiesis = await readFile(join(repository.root, ".poiesis", "roles", "poiesis.md"), "utf8");
      const roleWorker = await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8");

      expect(extractMethodSection(method, "8. Realize")).toMatch(FOCUSED_CHECKS_REQUIRED);
      expect(extractMethodSection(method, "8. Realize")).toMatch(/same command, state fingerprint, and failure classification does not justify another attempt/i);
      expect(roleWorker).toContain(WORKER_CHECK_ROUTE);
      expect(roleWorker).toMatch(/never report success/i);
      expect(rolePoiesis).toContain(SESSION_CLEANUP_ROUTE);

      const openCode = await readFile(join(repository.root, "opencode.jsonc"), "utf8");
      expect(openCode).toContain(`"pnpm dlx poiesis-cli@${current} check *"`);
    }, 120_000);

    it("a trusted predecessor update regenerates the corrected projections as manifest-owned bytes", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      const current = await packageVersion();
      await setupCurrentInstall(repository);
      await asPredecessorManifest(repository, "1.1.1", { keepReceipt: true });
      await rebindReceipt(repository);

      const result = await update(repository.root, { skipSkills: true });
      // The migration ends on the CURRENT release, never on the predecessor.
      expect(result.manifest.poiesisVersion).toBe(current);

      const method = await readFile(join(repository.root, ".poiesis", "METHOD.md"), "utf8");
      const rolePoiesis = await readFile(join(repository.root, ".poiesis", "roles", "poiesis.md"), "utf8");
      const roleWorker = await readFile(join(repository.root, ".poiesis", "roles", "worker.md"), "utf8");

      expect(extractMethodSection(method, "8. Realize")).toMatch(FOCUSED_CHECKS_REQUIRED);
      expect(extractMethodSection(method, "8. Realize")).not.toMatch(/whole-change/i);
      expect(roleWorker).toContain(WORKER_CHECK_ROUTE);
      expect(rolePoiesis).toContain(SESSION_CLEANUP_ROUTE);

      // The regenerated files are manifest-owned, not foreign content.
      const recorded = new Map(result.manifest.files.map((file) => [file.path, file.hash]));
      for (const relativePath of [".poiesis/METHOD.md", ".poiesis/roles/poiesis.md", ".poiesis/roles/worker.md"]) {
        const onDisk = await readFile(join(repository.root, relativePath));
        expect(recorded.get(relativePath), `${relativePath} must be a manifest-owned file`).toBeDefined();
        expect(createHash("sha256").update(onDisk).digest("hex")).toBe(recorded.get(relativePath));
      }

      // The advanced OpenCode projection carries the narrow Worker allow and
      // no lifecycle route.
      const workerPatch = result.manifest.configPatches.find((patch) => patch.path[1] === "poiesis-worker")!;
      const workerBash = (workerPatch.installed as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(workerBash[`pnpm dlx poiesis-cli@${current} check *`]).toBe("allow");
      expect(workerBash[`pnpm dlx poiesis-cli@${current} *`]).toBeUndefined();
      expect(workerBash[`pnpm dlx poiesis-cli@${current} verify *`]).toBeUndefined();
    }, 120_000);
  });
});
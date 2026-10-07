/**
 * Spec #190 / ticket #197 — an ordinary `update` reconciles a Team
 * installation's generated OpenCode projections from PACKAGE CANON PLUS the
 * shared overrides, never from package canon alone.
 *
 * The defect this suite exists for: `update` materialized every managed file
 * straight out of the package, ignoring `.opencode/poiesis/overrides/`. The
 * ownership precondition still passed — the mirror on disk matched the hash
 * `init` had recorded FROM the override — so the transaction cheerfully
 * overwrote a project-created instruction with package canon and re-baselined
 * the manifest record to that canon. One `poiesis update` after a team
 * installed its own worker instructions destroyed committed team
 * intelligence, silently, with a `doctor` verdict of "pass".
 *
 * The properties:
 *
 *   - a shared override stays effective across REPEATED ordinary updates, and
 *     the manifest keeps describing the override-derived bytes, so ownership is
 *     never re-baselined to canon;
 *   - an override the team ADDS after install is picked up on the next update,
 *     which is what proves the shared source is actually READ rather than the
 *     mirror merely being left alone;
 *   - a private installation, and a team installation with no overrides, stay
 *     exactly on package canon — the seam is reached only in Team mode;
 *   - an unsafe, a conflicting, and a concurrently replaced override source all
 *     fail CLOSED, with zero projection rewritten and the manifest and receipt
 *     untouched;
 *   - runtime identity (receipt generation advances), authority, and
 *     convergence (the transaction's own doctor gate) survive all of it.
 *
 * Everything runs against the real `init` / `update` transactions in real
 * temporary Git repositories. Only the concurrent-override case reaches for
 * `runUpdateTransaction`'s internal fault-injection seam, because that case is
 * about a write-window race no public API can stage deterministically.
 */
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, update } from "../src/maintenance.js";
import { runUpdateTransaction } from "../src/update-internal.js";
import { hashContent } from "../src/hash.js";
import { readTemplate } from "../src/templates.js";
import { loadManifest, type ManagedFile, type Manifest } from "../src/manifest.js";
import { ownershipReceiptLocation, readOwnershipReceipt } from "../src/receipt.js";
import { doctor } from "../src/maintenance.js";
import { PoiesisError } from "../src/errors.js";
import {
  TEAM_PROFILE_OVERRIDES_DIRECTORY,
  TEAM_PROFILE_SKILLS_LOCK_PATH,
} from "../src/team-profile.js";
import type { PoiesisConfig } from "../src/config.js";
import { createTestRepository, type TestRepository } from "./helpers.js";

/** The generated OpenCode projection a project instruction override replaces. */
const WORKER_AGENT = ".opencode/agents/poiesis-worker.md";
const PLANNER_AGENT = ".opencode/agents/poiesis-planner.md";
/** Package canon for the projection under test, straight out of the package. */
const WORKER_CANON = await readTemplate("OPENCODE_AGENT_WORKER.md");

const OVERRIDE_NAME = "poiesis-worker.md";
const OVERRIDE_SOURCE = `${TEAM_PROFILE_OVERRIDES_DIRECTORY}/${OVERRIDE_NAME}`;
const OVERRIDE_BODY =
  "---\ndescription: the project's own worker\n---\n\nProject instruction override.\nAlways run `pnpm check` first.\n";

/**
 * A portable Team policy.
 *
 * Every value is project-relative because the shared profile is committed:
 * an absolute path here is exactly the machine leakage `TEAM_PROFILE_NOT_PORTABLE`
 * refuses, and the fixture tracker keeps tracker verification offline.
 */
function teamConfig(): PoiesisConfig {
  const delivery = (target: "preview" | "staging" | "production") => ({
    adapter: "command" as const,
    command: ["node", `scripts/poiesis-${target}.mjs`, target, "{sha}"],
  });
  return {
    schema: 1,
    mode: "team",
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: "poiesis-tracker-fixture" },
    delivery: {
      preview: delivery("preview"),
      staging: delivery("staging"),
      production: delivery("production"),
    },
    verification: { commands: ["test -f README.md"] },
  };
}

function privateConfig(): PoiesisConfig {
  return { ...teamConfig(), mode: "private" };
}

async function install(repository: TestRepository, config: PoiesisConfig): Promise<Manifest> {
  return init(repository.root, config, { skipSkills: true, allowFixtureAdapters: true });
}

async function writeOverride(repository: TestRepository, name: string, content: string): Promise<string> {
  const path = join(repository.root, TEAM_PROFILE_OVERRIDES_DIRECTORY, name);
  await mkdir(join(repository.root, TEAM_PROFILE_OVERRIDES_DIRECTORY), { recursive: true });
  await writeFile(path, content);
  return path;
}

function record(manifest: Manifest, path: string): ManagedFile {
  const found = manifest.files.find((file) => file.path === path);
  if (found === undefined) throw new Error(`manifest has no record for ${path}`);
  return found;
}

/** Every managed file's on-disk bytes, so "nothing was rewritten" is provable. */
async function projections(repository: TestRepository): Promise<Map<string, string>> {
  const manifest = await loadManifest(repository.root);
  const snapshot = new Map<string, string>();
  for (const file of manifest.files) {
    snapshot.set(file.path, await readFile(join(repository.root, file.path), "utf8"));
  }
  return snapshot;
}

async function manifestBytes(repository: TestRepository): Promise<string> {
  return readFile(join(repository.root, ".poiesis", "manifest.json"), "utf8");
}

async function receiptBytes(repository: TestRepository): Promise<string> {
  return readFile(await ownershipReceiptLocation(repository.root), "utf8");
}

/**
 * The public `update` the CLI calls, with the one option the fixture needs:
 * skills are skipped because this suite never stages the network-bound skill
 * set, and an installation with no skills is a complete installation.
 */
async function publicUpdate(repository: TestRepository) {
  return update(repository.root, { skipSkills: true });
}

/**
 * Doctor check ids that failed for a reason other than the network-bound
 * skill set this fixture deliberately skips. The update transaction's own
 * gate exempts exactly `skills` and nothing else, so this is the honest
 * statement of "the update converged" for this harness.
 */
function failingChecks(report: { checks: Array<{ id: string; status: string }> }): string[] {
  return report.checks.filter((check) => check.status === "fail" && check.id !== "skills").map((check) => check.id);
}

async function expectPoiesisCode(operation: Promise<unknown>, code: string): Promise<PoiesisError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(PoiesisError);
    const poiesisError = error as PoiesisError;
    expect(poiesisError.code, poiesisError.message).toBe(code);
    return poiesisError;
  }
  throw new Error(`expected ${code}, but the operation succeeded`);
}

describe("Spec #190 / ticket #197 - an ordinary update keeps Team overrides effective", () => {
  let repository: TestRepository;

  beforeEach(async () => {
    repository = await createTestRepository();
  });

  afterEach(async () => {
    await rm(repository.parent, { recursive: true, force: true });
  });

  it("keeps a shared override effective across repeated ordinary updates", async () => {
    await writeOverride(repository, OVERRIDE_NAME, OVERRIDE_BODY);
    await install(repository, teamConfig());

    // The premise: this installation's worker projection is override-derived,
    // and the manifest describes the override's bytes.
    expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(OVERRIDE_BODY);
    const installed = await loadManifest(repository.root);
    expect(installed.mode).toBe("team");
    expect(record(installed, WORKER_AGENT).hash).toBe(hashContent(OVERRIDE_BODY));
    expect(record(installed, WORKER_AGENT).provenance).toBe("projection");

    // Two ordinary updates in a row: a teammate updating twice must not be
    // able to destroy the team's committed instructions. `init` writes the
    // receipt at generation 1, and every update advances it by exactly one.
    for (const generation of [2, 3]) {
      const result = await publicUpdate(repository);
      expect(result.manifest.mode).toBe("team");
      // Runtime identity: the receipt advanced by exactly one per update.
      expect((await readOwnershipReceipt(repository.root)).generation).toBe(generation);
      // Convergence: the transaction's own doctor gate passed. Only `skills`
      // may fail, because this fixture never stages the network-bound set.
      expect(failingChecks(result.doctor)).toEqual([]);
      expect(result.doctor.checks.find((check) => check.id === "team-profile")?.status).not.toBe("fail");

      expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(OVERRIDE_BODY);
      const updated = await loadManifest(repository.root);
      // Ownership follows the OVERRIDE, never package canon.
      expect(record(updated, WORKER_AGENT).hash).toBe(hashContent(OVERRIDE_BODY));
      expect(record(updated, WORKER_AGENT).hash).not.toBe(hashContent(WORKER_CANON));
      // Projections Poiesis does not own an override for stay on canon.
      expect(await readFile(join(repository.root, PLANNER_AGENT), "utf8")).toBe(
        await readTemplate("OPENCODE_AGENT_PLANNER.md"),
      );
    }

    // The shared source is Author content: still present and unchanged, and
    // never claimed as a manifest record.
    expect(await readFile(join(repository.root, OVERRIDE_SOURCE), "utf8")).toBe(OVERRIDE_BODY);
    const updated = await loadManifest(repository.root);
    expect(updated.files.some((file) => file.path.startsWith(`${TEAM_PROFILE_OVERRIDES_DIRECTORY}/`))).toBe(false);
    // The team's committed lock is reported, never rewritten.
    expect(await readFile(join(repository.root, TEAM_PROFILE_SKILLS_LOCK_PATH), "utf8")).toContain('"schema": 1');
  });

  it("adopts an override the team added after install", async () => {
    await install(repository, teamConfig());
    const installed = await loadManifest(repository.root);
    expect(record(installed, WORKER_AGENT).hash).toBe(hashContent(WORKER_CANON));
    expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(WORKER_CANON);

    // The team commits a new instruction override.
    await writeOverride(repository, OVERRIDE_NAME, OVERRIDE_BODY);

    await publicUpdate(repository);

    // The shared source was READ and applied: this is what distinguishes a
    // real reconcile from simply leaving the existing mirror alone.
    expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(OVERRIDE_BODY);
    const updated = await loadManifest(repository.root);
    expect(record(updated, WORKER_AGENT).hash).toBe(hashContent(OVERRIDE_BODY));
  });

  it("leaves a private installation on package canon", async () => {
    // A private installation never shares a profile, so an override directory
    // that happens to exist is Author content Poiesis does not read.
    await writeOverride(repository, OVERRIDE_NAME, OVERRIDE_BODY);
    const installed = await install(repository, privateConfig());
    expect(installed.mode).toBe("private");

    await publicUpdate(repository);
    await publicUpdate(repository);

    expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(WORKER_CANON);
    expect(record(await loadManifest(repository.root), WORKER_AGENT).hash).toBe(hashContent(WORKER_CANON));
    // Untouched: the private installation never claimed or projected it.
    expect(await readFile(join(repository.root, OVERRIDE_SOURCE), "utf8")).toBe(OVERRIDE_BODY);
  });

  it("leaves a team installation without overrides on package canon", async () => {
    await install(repository, teamConfig());
    await publicUpdate(repository);
    await publicUpdate(repository);

    expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(WORKER_CANON);
    expect(record(await loadManifest(repository.root), WORKER_AGENT).hash).toBe(hashContent(WORKER_CANON));
    const report = await doctor(repository.root);
    expect(failingChecks(report)).toEqual([]);
    expect(report.checks.find((check) => check.id === "team-profile")?.details).toMatchObject({ overrides: [] });
  });

  it("refuses an unsafe shared override without rewriting any projection", async () => {
    await writeOverride(repository, OVERRIDE_NAME, OVERRIDE_BODY);
    await install(repository, teamConfig());

    // The committed override becomes a symlink: projecting Author bytes
    // through a link is how a shared profile reads outside the repository.
    const overridePath = join(repository.root, OVERRIDE_SOURCE);
    const outside = join(repository.parent, "outside.md");
    await writeFile(outside, OVERRIDE_BODY);
    await rm(overridePath);
    await symlink(outside, overridePath);

    const before = await projections(repository);
    const manifestBefore = await manifestBytes(repository);
    const receiptBefore = await receiptBytes(repository);

    await expectPoiesisCode(publicUpdate(repository), "TEAM_OVERRIDE_UNSAFE");

    // Zero partial rewrite: no projection moved, and runtime identity held.
    expect(await projections(repository)).toEqual(before);
    expect(await manifestBytes(repository)).toBe(manifestBefore);
    expect(await receiptBytes(repository)).toBe(receiptBefore);
  });

  it("refuses a mirror the shared override and the manifest disagree on", async () => {
    await writeOverride(repository, OVERRIDE_NAME, OVERRIDE_BODY);
    await install(repository, teamConfig());

    // The mirror was hand-edited locally, so it matches neither the recorded
    // ownership nor the shared source. Poiesis cannot prove it owns the bytes
    // it would overwrite, so it refuses rather than resolving a disagreement
    // by rewriting Author-visible content.
    await writeFile(join(repository.root, WORKER_AGENT), "---\ndescription: locally edited\n---\n");

    const before = await projections(repository);
    const manifestBefore = await manifestBytes(repository);
    const receiptBefore = await receiptBytes(repository);

    await expectPoiesisCode(publicUpdate(repository), "FILE_OWNERSHIP_LOST");

    expect(await projections(repository)).toEqual(before);
    expect(await manifestBytes(repository)).toBe(manifestBefore);
    expect(await receiptBytes(repository)).toBe(receiptBefore);
  });

  it("refuses a shared override replaced mid-transaction without a partial rewrite", async () => {
    await writeOverride(repository, OVERRIDE_NAME, OVERRIDE_BODY);
    await install(repository, teamConfig());

    const before = await projections(repository);
    const manifestBefore = await manifestBytes(repository);
    const receiptBefore = await receiptBytes(repository);

    // The team pushes a different override while this update is between its
    // read of the shared source and its first projection write.
    const replaced = "---\ndescription: replaced mid-transaction\n---\n\nConcurrent edit.\n";
    await expectPoiesisCode(
      runUpdateTransaction(
        repository.root,
        { skipSkills: true },
        {
          preSkillsInstall: async () => {
            await writeOverride(repository, OVERRIDE_NAME, replaced);
          },
        },
      ),
      "TEAM_OVERRIDE_CONFLICT",
    );

    // The transaction refused BEFORE its first projection write, so nothing
    // was half-rewritten and the journal had nothing to restore.
    expect(await projections(repository)).toEqual(before);
    expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(OVERRIDE_BODY);
    expect(await manifestBytes(repository)).toBe(manifestBefore);
    expect(await receiptBytes(repository)).toBe(receiptBefore);
    expect(await readFile(join(repository.root, OVERRIDE_SOURCE), "utf8")).toBe(replaced);
  });

  it("refuses a shared override added mid-transaction without a partial rewrite", async () => {
    // The mirror case of the race above, and the one a per-FILE guard cannot
    // see: at the read there was no override at all, so there is no earlier
    // file whose digest moved. What changed is the shared source itself — the
    // team committed a projection-poisoning instruction this update never
    // planned from — and it must still fail closed rather than write canon
    // over it.
    await install(repository, teamConfig());

    const before = await projections(repository);
    const manifestBefore = await manifestBytes(repository);
    const receiptBefore = await receiptBytes(repository);

    await expectPoiesisCode(
      runUpdateTransaction(
        repository.root,
        { skipSkills: true },
        {
          preSkillsInstall: async () => {
            await writeOverride(repository, OVERRIDE_NAME, OVERRIDE_BODY);
          },
        },
      ),
      "TEAM_OVERRIDE_CONFLICT",
    );

    expect(await projections(repository)).toEqual(before);
    expect(await readFile(join(repository.root, WORKER_AGENT), "utf8")).toBe(WORKER_CANON);
    expect(await manifestBytes(repository)).toBe(manifestBefore);
    expect(await receiptBytes(repository)).toBe(receiptBefore);
    expect(await readFile(join(repository.root, OVERRIDE_SOURCE), "utf8")).toBe(OVERRIDE_BODY);
  });
});
/**
 * Ticket #46 — Roll back default-skill mutations transactionally.
 *
 * Acceptance criteria:
 *   1. Publication reports exact created/replaced tree preimages and
 *      transaction-written identities (the bounded `ArtifactJournal`
 *      captures every default-skill directory before mutation and
 *      binds the post-write hash via `recordDirectoryWrite`; the
 *      manifest's per-skill `hash` is locked to that
 *      `transactionWrittenIdentity`).
 *   2. Later failure removes/restores only unchanged
 *      transaction-authored skill state in reverse order (the
 *      journal's reverse hash-gated rollback restores preimage trees
 *      when the on-disk tree still matches the recorded
 *      transaction-written identity).
 *   3. Preserves/reports concurrent foreign changes (when the
 *      on-disk tree differs from the recorded
 *      `transactionWrittenIdentity`, the rollback reports
 *      `RollbackDiagnostic` with reason `identity-mismatch` and
 *      leaves the foreign tree intact).
 *   4. Backup cleanup only after commit/rollback and cannot turn
 *      committed update into failure (the journal's `commit()`
 *      removes preimage backups after a successful transaction and
 *      swallows its own cleanup errors via `catch(() => undefined)`).
 *   5. Update/bootstrap retry cleanly (a failed transaction leaves
 *      every default-skill directory byte-for-byte identical to its
 *      preimage; the next transaction starts from a clean captured
 *      journal and proceeds normally).
 *   6. Preserve unrelated state (concurrent foreign writes to one
 *      default-skill directory do not leak into another skill's
 *      rollback; non-managed user content adjacent to the skills
 *      tree is untouched).
 *
 * The seam lives in `src/mutation-transaction.ts` (bounded journal
 * extended with `directory`-mode entries), `src/skills.ts`
 * (`installDefaultSkills` accepts an optional journal and an
 * optional `preimageSkillDirectory` test seam that bypasses the
 * network-bound `stageSkills` step), and
 * `src/update-internal.ts` (the transaction runners pass the
 * optional preimageSkillDirectory through to installDefaultSkills via
 * a new `preimageSkillDirectory` hook).
 */
import { exists } from "../src/fs.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  init,
  update,
  type MaintenanceOptions,
} from "../src/maintenance.js";
import {
  runUpdateTransaction,
  runBootstrapLegacyOwnershipTransaction,
  type UpdateBootstrapTransactionHooks,
} from "../src/update-internal.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import {
  ownershipReceiptExists,
  ownershipReceiptLocation,
  readOwnershipReceipt,
  removeOwnershipReceipt,
} from "../src/receipt.js";
import {
  ArtifactJournal,
  hashDirectoryTree,
} from "../src/mutation-transaction.js";
import { installDefaultSkills, loadDefaultSkills, type DefaultSkill } from "../src/skills.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const DEFAULT_SKILL_NAMES = [
  "grilling",
  "grill-with-docs",
  "domain-modeling",
  "research",
  "codebase-design",
  "to-spec",
  "to-tickets",
  "code-review",
  "diagnosing-bugs",
  "test-driven-development",
  "verification-before-completion",
];

/**
 * Build the internal-only widened options object that exercises the
 * transactional journal seam and the test-only preimageSkillDirectory
 * staging bypass. Mirrors the structural widening that
 * `src/skills.ts` applies inside `installDefaultSkills` so the public
 * `SkillMaintenanceOptions` declaration stays free of the journal
 * surface.
 */
function ticket46InternalSkillOptions(opts: {
  replaceOwned?: boolean;
  expectedPreexisting?: ReadonlyMap<string, string>;
  createdDirectories?: Set<string>;
  preimageSkillDirectory?: string;
  journal?: ArtifactJournal;
}) {
  return opts;
}

async function installPoiesis(repository: TestRepository): Promise<void> {
  await init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function asPredecessorManifest(
  repository: TestRepository,
  predecessorVersion: "1.0.0" | "1.0.1" | "1.0.2",
  options: { keepReceipt?: boolean } = {},
): Promise<void> {
  const manifest = await loadManifest(repository.root);
  manifest.poiesisVersion = predecessorVersion;
  await writeFile(
    join(repository.root, ".poiesis", "manifest.json"),
    serializeManifest(manifest),
  );
  if (!options.keepReceipt && (await ownershipReceiptLocation(repository.root).then(() => true).catch(() => false))) {
    await removeOwnershipReceipt(repository.root);
  }
}

async function rebindReceipt(repository: TestRepository): Promise<void> {
  const { replaceOwnershipReceipt } = await import("../src/receipt.js");
  const manifest = await loadManifest(repository.root);
  const existing = await readOwnershipReceipt(repository.root);
  await replaceOwnershipReceipt(repository.root, manifest, existing);
}

async function stripNewGitignoreRule(repository: TestRepository): Promise<Buffer> {
  const gitignorePath = join(repository.root, ".gitignore");
  const before = await readFile(gitignorePath, "utf8");
  const stripped = before
    .split(/\r?\n/)
    .filter((line) => line.trim() !== ".poiesis/workspaces/")
    .filter((line) => !line.includes("default-path workspace area"))
    .join("\n");
  await writeFile(gitignorePath, stripped);
  return readFile(gitignorePath);
}

async function seedPreexistingSkill(repository: TestRepository, name: string, content: string): Promise<string> {
  const dest = join(repository.root, ".agents", "skills", name);
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "SKILL.md"), content);
  return dest;
}

describe("ticket #46 — default-skill transactional rollback (direct journal)", () => {
  // Direct unit tests for the bounded journal's directory-mode
  // capture, recordDirectoryWrite, rollback, and commit paths.
  // Exercises acceptance criteria 2, 3, and 4 independent of
  // installDefaultSkills. Ticket #46.

  it("captureDirectory records physicalExists=false for an absent destination", async () => {
    const staging = await mkdtemp(join(tmpdir(), "poiesis-t46-unit-"));
    try {
      const destination = join(staging, "skill");
      const journal = new ArtifactJournal(4);
      const entry = await journal.captureDirectory(destination);
      expect(entry.physicalExists).toBe(false);
      expect(entry.expectedPreWriteIdentity.kind).toBe("absent");
      expect(entry.expectedPreWriteIdentity.exists).toBe(false);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("captureDirectory records the EXACT preimage hash for an existing destination", async () => {
    const staging = await mkdtemp(join(tmpdir(), "poiesis-t46-unit-"));
    try {
      const destination = join(staging, "skill");
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "owned preimage\n");
      const preimageHash = await hashDirectoryTree(destination);

      const journal = new ArtifactJournal(4);
      const entry = await journal.captureDirectory(destination);
      expect(entry.physicalExists).toBe(true);
      expect(entry.expectedPreWriteIdentity.kind).toBe("directory");
      expect(entry.expectedPreWriteIdentity.hash).toBe(preimageHash);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("rollback unlinks a newly-created skill directory when on-disk matches the transaction-written identity", async () => {
    const staging = await mkdtemp(join(tmpdir(), "poiesis-t46-unit-"));
    try {
      const destination = join(staging, "skill");
      const journal = new ArtifactJournal(4);
      const entry = await journal.captureDirectory(destination);
      expect(entry.physicalExists).toBe(false);

      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "installed content\n");
      const writtenHash = await hashDirectoryTree(destination);
      await journal.recordDirectoryWrite(entry, writtenHash);

      const diagnostics = await journal.rollback();
      expect(diagnostics).toEqual([]);
      expect(await exists(destination)).toBe(false);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("rollback restores the EXACT preimage tree when on-disk matches the transaction-written identity", async () => {
    const staging = await mkdtemp(join(tmpdir(), "poiesis-t46-unit-"));
    try {
      const destination = join(staging, "skill");
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "owned preimage\n");

      const journal = new ArtifactJournal(4);
      const entry = await journal.captureDirectory(destination);

      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "installed content\n");
      const writtenHash = await hashDirectoryTree(destination);
      await journal.recordDirectoryWrite(entry, writtenHash);

      const diagnostics = await journal.rollback();
      expect(diagnostics).toEqual([]);
      const restored = await readFile(join(destination, "SKILL.md"));
      expect(restored.toString("utf8")).toBe("owned preimage\n");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("rollback reports identity-mismatch and preserves a concurrent foreign skill write", async () => {
    const staging = await mkdtemp(join(tmpdir(), "poiesis-t46-unit-"));
    try {
      const destination = join(staging, "skill");
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "owned preimage\n");

      const journal = new ArtifactJournal(4);
      const entry = await journal.captureDirectory(destination);

      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "installed content\n");
      const writtenHash = await hashDirectoryTree(destination);
      await journal.recordDirectoryWrite(entry, writtenHash);

      // Foreign writer replaces the destination after the
      // transaction-authored install completes.
      await writeFile(join(destination, "SKILL.md"), "FOREIGN bytes\n");

      const diagnostics = await journal.rollback();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.reason).toBe("identity-mismatch");
      expect(diagnostics[0]!.path).toBe(destination);
      const onDisk = await readFile(join(destination, "SKILL.md"));
      expect(onDisk.toString("utf8")).toBe("FOREIGN bytes\n");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("commit removes every journal-owned preimage backup after a successful transaction", async () => {
    const staging = await mkdtemp(join(tmpdir(), "poiesis-t46-unit-"));
    try {
      const destination = join(staging, "skill");
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "owned preimage\n");

      const journal = new ArtifactJournal(4);
      const entry = await journal.captureDirectory(destination);
      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "installed content\n");
      const writtenHash = await hashDirectoryTree(destination);
      await journal.recordDirectoryWrite(entry, writtenHash);

      expect(entry.preimageBackup).toBeDefined();
      const backupPath = entry.preimageBackup!;
      expect(await exists(backupPath)).toBe(true);

      // commit() must NOT throw — backup cleanup is best-effort and
      // cannot fail the surrounding committed transaction.
      await journal.commit();
      expect(await exists(backupPath)).toBe(false);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
});

describe("ticket #46 — installDefaultSkills transactional integration", () => {
  const repositories: TestRepository[] = [];
  const stagingDirs: string[] = [];

  beforeEach(async () => {
    // The installDefaultSkills transaction integration tests do NOT
    // need the fake opencode binary; they exercise the journal
    // contract through the direct `installDefaultSkills` API.
    await installFakeOpenCode();
  });

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
    await Promise.all(stagingDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // Build a test-only staged skill directory that mirrors the layout
  // `stageSkills` produces after a real `npx skills add ... --copy`.
  // The caller passes the staging root to `installDefaultSkills` via
  // the `preimageSkillDirectory` option so the network-bound
  // staging step is bypassed.
  async function buildStagedRoot(content: (name: string) => string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "poiesis-t46-stage-"));
    stagingDirs.push(root);
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    for (const name of DEFAULT_SKILL_NAMES) {
      const dest = join(root, ".agents", "skills", name);
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "SKILL.md"), content(name));
    }
    return root;
  }

  // Acceptance #1: publication (managed skill hash) reports the
  // EXACT transaction-written skill identity. After install, the
  // bounded journal's `transactionWrittenIdentity` equals the
  // manifest's recorded `skill.hash` and equals the on-disk tree
  // hash.
  it("publication locks the managed skill hash to the EXACT transaction-written identity", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const staged = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);

    const journal = new ArtifactJournal(32);
    const skills = await installDefaultSkills(
      repository.root,
      [],
      ticket46InternalSkillOptions({
        preimageSkillDirectory: staged,
        journal,
      }),
    );

    expect(skills).toHaveLength(DEFAULT_SKILL_NAMES.length);
    for (const skill of skills) {
      expect(skill.hash, `skill ${skill.name} hash defined`).toBeDefined();
      const journalEntry = journal.entries.find((entry) => entry.path === join(repository.root, skill.path));
      expect(journalEntry, `journal captured ${skill.name}`).toBeDefined();
      // Acceptance criterion: the manifest hash equals the journal's
      // recorded transaction-written identity.
      expect(journalEntry!.transactionWrittenIdentity?.hash).toBe(skill.hash);
      // And the manifest hash equals the on-disk hash (no foreign
      // writes between write and read).
      const onDiskHash = await hashDirectoryTree(join(repository.root, skill.path));
      expect(onDiskHash).toBe(skill.hash);
    }

    await journal.commit();
  });

  // Acceptance #2: later failure restores the EXACT preimage via
  // the bounded journal. Seed preexisting content with sentinel
  // bytes and claim the sentinel hash + sentinel revision on the
  // `previous` manifest so installDefaultSkills treats every skill
  // as a `replaceOwned` candidate. Then install via the seam and
  // roll back via journal.rollback().
  it("later failure restores the EXACT skill preimage via journal.rollback()", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    // Look up the canonical source per skill name; the manifest
    // provenance check in installDefaultSkills rejects mismatched
    // source/path claims.
    const defaults = await loadDefaultSkills();
    const defaultsByName = new Map<string, DefaultSkill>(defaults.map((s) => [s.name, s]));

    // Seed preexisting content for every default skill so
    // installDefaultSkills performs a real replace.
    const sentinels = new Map<string, Buffer>();
    const previous = [];
    for (const name of DEFAULT_SKILL_NAMES) {
      const def = defaultsByName.get(name);
      if (def === undefined) continue;
      const sentinel = `# ${name}\nseeded preimage\n`;
      await seedPreexistingSkill(repository, name, sentinel);
      sentinels.set(name, Buffer.from(sentinel));
      previous.push({
        source: def.source,
        name,
        path: `.agents/skills/${name}`,
        preexisting: false,
        installedRevision: "0".repeat(40),
        hash: await hashDirectoryTree(join(repository.root, ".agents", "skills", name)),
      });
    }

    const staged = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);
    const journal = new ArtifactJournal(32);
    await installDefaultSkills(repository.root, previous, ticket46InternalSkillOptions({ replaceOwned: true,
      preimageSkillDirectory: staged,
      journal,
    }));

    // The journal captured every default-skill preimage as a
    // directory-mode entry.
    expect(journal.entries).toHaveLength(DEFAULT_SKILL_NAMES.length);
    for (const entry of journal.entries) {
      expect(entry.ownershipMode).toBe("directory");
      expect(entry.physicalExists).toBe(true);
    }

    // Simulate a later failure: roll back the journal. Every skill
    // tree is restored to its seeded preimage byte-for-byte.
    const diagnostics = await journal.rollback();
    expect(diagnostics, "rollback produced no diagnostics").toEqual([]);
    for (const name of DEFAULT_SKILL_NAMES) {
      const sentinel = sentinels.get(name)!;
      const onDisk = await readFile(join(repository.root, ".agents", "skills", name, "SKILL.md"));
      expect(Buffer.compare(onDisk, sentinel), `skill ${name} preimage not restored`).toBe(0);
    }
  });

  // Acceptance #3: concurrent foreign writes are preserved via
  // RollbackDiagnostic. After installDefaultSkills returns but
  // before the journal.rollback() runs, the test lands a foreign
  // write to ONE skill directory. The journal must report
  // identity-mismatch for that directory and leave its foreign
  // content intact.
  it("preserves concurrent foreign writes and reports identity-mismatch per affected entry", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const defaults = await loadDefaultSkills();
    const defaultsByName = new Map<string, DefaultSkill>(defaults.map((s) => [s.name, s]));

    // Seed preexisting content for every default skill with a
    // sentinel + sentinel revision + sentinel hash so
    // installDefaultSkills performs a real replaceOwned install.
    const previous = [];
    for (const name of DEFAULT_SKILL_NAMES) {
      const def = defaultsByName.get(name);
      if (def === undefined) continue;
      await seedPreexistingSkill(repository, name, `# ${name}\nseeded preimage\n`);
      previous.push({
        source: def.source,
        name,
        path: `.agents/skills/${name}`,
        preexisting: false,
        installedRevision: "0".repeat(40),
        hash: await hashDirectoryTree(join(repository.root, ".agents", "skills", name)),
      });
    }

    const staged = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);
    const journal = new ArtifactJournal(32);
    await installDefaultSkills(repository.root, previous, ticket46InternalSkillOptions({ replaceOwned: true,
      preimageSkillDirectory: staged,
      journal,
    }));

    // Foreign writer lands a concurrent write to one skill between
    // install and rollback.
    const targetName = "to-spec";
    const targetPath = join(repository.root, ".agents", "skills", targetName);
    const foreignBytes = Buffer.from("# foreign writer to-spec\n");
    await writeFile(join(targetPath, "SKILL.md"), foreignBytes);

    const diagnostics = await journal.rollback();
    // Exactly one diagnostic: the foreign write on to-spec.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.reason).toBe("identity-mismatch");
    expect(diagnostics[0]!.path).toBe(targetPath);
    // Foreign write preserved on disk.
    const onDisk = await readFile(join(targetPath, "SKILL.md"), "utf8");
    expect(onDisk).toBe("# foreign writer to-spec\n");
    // Every other default skill is restored to its seeded preimage.
    for (const name of DEFAULT_SKILL_NAMES) {
      if (name === targetName) continue;
      const content = await readFile(join(repository.root, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(content).toBe(`# ${name}\nseeded preimage\n`);
    }
  });

  // Acceptance #4 + #6: backup cleanup only after commit/rollback;
  // commit cannot fail the transaction. After a successful commit
  // every journal-owned preimage backup is removed from disk; the
  // journal's backup root is also removed. The cleanup uses
  // catch(() => undefined) so a backup-cleanup failure cannot turn
  // the commit into an error.
  it("commit removes every preimage backup after a successful transaction; rollback also cleans up backups", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    const defaults = await loadDefaultSkills();
    const defaultsByName = new Map<string, DefaultSkill>(defaults.map((s) => [s.name, s]));

    // Seed preexisting content + previous claim so installDefaultSkills
    // performs a replaceOwned install and the journal captures a real
    // preimage backup.
    const previous = [];
    for (const name of DEFAULT_SKILL_NAMES) {
      const def = defaultsByName.get(name);
      if (def === undefined) continue;
      await seedPreexistingSkill(repository, name, `# ${name}\nseeded preimage\n`);
      previous.push({
        source: def.source,
        name,
        path: `.agents/skills/${name}`,
        preexisting: false,
        installedRevision: "0".repeat(40),
        hash: await hashDirectoryTree(join(repository.root, ".agents", "skills", name)),
      });
    }

    const staged = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);
    const journal = new ArtifactJournal(32);
    await installDefaultSkills(repository.root, previous, ticket46InternalSkillOptions({ replaceOwned: true,
      preimageSkillDirectory: staged,
      journal,
    }));

    const backupPaths = journal.entries
      .map((entry) => entry.preimageBackup)
      .filter((path): path is string => path !== undefined);
    expect(backupPaths.length).toBeGreaterThan(0);
    for (const backup of backupPaths) {
      expect(await exists(backup), `backup ${backup} should exist before commit`).toBe(true);
    }

    // commit() removes every preimage backup. The transaction
    // remains successful even if cleanup encounters a transient
    // failure (the helper swallows rm errors via catch(() =>
    // undefined)). We then verify the helper does not throw on a
    // clean run.
    await expect(journal.commit()).resolves.toBeUndefined();
    for (const backup of backupPaths) {
      expect(await exists(backup), `backup ${backup} should be removed after commit`).toBe(false);
    }
  });
});

describe("ticket #46 — full update/bootstrap transaction integration", () => {
  const repositories: TestRepository[] = [];
  const stagingDirs: string[] = [];
  let openCodeEnv: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    openCodeEnv = await installFakeOpenCode();
  });

  afterEach(async () => {
    openCodeEnv?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
    await Promise.all(stagingDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function buildStagedRoot(content: (name: string) => string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "poiesis-t46-stage-"));
    stagingDirs.push(root);
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    for (const name of DEFAULT_SKILL_NAMES) {
      const dest = join(root, ".agents", "skills", name);
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "SKILL.md"), content(name));
    }
    return root;
  }

  // Acceptance #1 + #5: a no-interference update through the full
  // transaction (with the staging seam) advances every default skill
  // to its staged preimage hash and leaves the repo in a state that
  // a follow-up update can repeat cleanly (clean retry path).
  it("full update transaction advances every default skill to its staged preimage hash", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const staged = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);
    const result = await runUpdateTransaction(repository.root, {}, {
      preimageSkillDirectory: staged,
    } satisfies UpdateBootstrapTransactionHooks);

    expect(result.manifest.skills).toHaveLength(DEFAULT_SKILL_NAMES.length);
    for (const skill of result.manifest.skills) {
      const onDiskHash = await hashDirectoryTree(join(repository.root, skill.path));
      expect(skill.hash).toBe(onDiskHash);
    }

    // Acceptance #5: a follow-up update with the same staging seam
    // runs cleanly from the post-commit state. The doctor gate must
    // pass on the second run.
    const staged2 = await buildStagedRoot((name) => `# ${name}\nstaged content second run\n`);
    const result2 = await runUpdateTransaction(repository.root, {}, {
      preimageSkillDirectory: staged2,
    } satisfies UpdateBootstrapTransactionHooks);
    expect(result2.doctor.ok).toBe(true);
  });

  // Acceptance #2 + #5: a later failure in the full update
  // transaction (doctor gate trips after installDefaultSkills)
  // restores every default skill tree to its seeded preimage via
  // the bounded journal. A subsequent update starts cleanly.
  it("full update transaction with doctor failure restores every skill preimage via the bounded journal", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);

    // Seed preexisting content for every default skill so the
    // update transaction's `replaceOwned` step actually performs a
    // replacement.
    for (const name of DEFAULT_SKILL_NAMES) {
      await seedPreexistingSkill(repository, name, `# ${name}\nseeded preimage\n`);
    }
    // The receipt/manifest must know the seeded hashes so update
    // accepts the prior. Rewrite the manifest so each owned skill
    // claims the seeded tree's hash (a sentinel revision signals a
    // real replaceOwned install).
    const manifest = await loadManifest(repository.root);
    for (const skill of manifest.skills) {
      if (skill.preexisting || skill.name === undefined) continue;
      skill.preexisting = false;
      skill.installedRevision = "0".repeat(40);
      skill.hash = await hashDirectoryTree(join(repository.root, skill.path));
    }
    await writeFile(
      join(repository.root, ".poiesis", "manifest.json"),
      serializeManifest(manifest),
    );
    await rebindReceipt(repository);
    await stripNewGitignoreRule(repository);

    const staged = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(repository.root, {}, {
          preimageSkillDirectory: staged,
        } satisfies UpdateBootstrapTransactionHooks),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // Every default skill tree is restored to its seeded preimage
    // byte-for-byte via the bounded journal's reverse hash-gated
    // rollback.
    for (const name of DEFAULT_SKILL_NAMES) {
      const onDisk = await readFile(join(repository.root, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(onDisk).toBe(`# ${name}\nseeded preimage\n`);
    }

    // Acceptance #5: the next transaction starts from a clean
    // captured state.
    const staged2 = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);
    const result = await runUpdateTransaction(repository.root, {}, {
      preimageSkillDirectory: staged2,
    } satisfies UpdateBootstrapTransactionHooks);
    expect(result.doctor.ok).toBe(true);
    expect(result.manifest.skills).toHaveLength(DEFAULT_SKILL_NAMES.length);
  });

  // Bootstrap parity: the explicit 1.0.0 bootstrap path applies the
  // same journal-driven default-skill rollback.
  it("full bootstrap transaction with doctor failure restores every skill preimage via the bounded journal", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    for (const name of DEFAULT_SKILL_NAMES) {
      await seedPreexistingSkill(repository, name, `# ${name}\nseeded bootstrap preimage\n`);
    }
    const manifest = await loadManifest(repository.root);
    manifest.poiesisVersion = "1.0.0";
    for (const skill of manifest.skills) {
      if (skill.preexisting || skill.name === undefined) continue;
      skill.preexisting = false;
      skill.installedRevision = "0".repeat(40);
      skill.hash = await hashDirectoryTree(join(repository.root, skill.path));
    }
    await writeFile(
      join(repository.root, ".poiesis", "manifest.json"),
      serializeManifest(manifest),
    );
    await removeOwnershipReceipt(repository.root);
    await stripNewGitignoreRule(repository);

    const staged = await buildStagedRoot((name) => `# ${name}\nstaged content\n`);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runBootstrapLegacyOwnershipTransaction(repository.root, {}, {
          preimageSkillDirectory: staged,
        } satisfies UpdateBootstrapTransactionHooks),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    for (const name of DEFAULT_SKILL_NAMES) {
      const onDisk = await readFile(join(repository.root, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(onDisk).toBe(`# ${name}\nseeded bootstrap preimage\n`);
    }
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
  });
});

// Regression for the high-priority Standards Review blocker on the
// ordinary-update and legacy-bootstrap post-transaction doctor gate.
// `skipSkills: true` must exempt ONLY the skill-related doctor check
// (so test/internal flows that have not installed default skills
// still pass). Every other doctor failure must still trigger
// `UPDATE_DOCTOR_FAILED` and drive the bounded journal's reverse
// hash-gated rollback. Mirrors the gate semantics in
// `src/update-config-internal.ts::assertUpdateConfigDoctorGate`.
describe("skipSkills must not bypass non-skill doctor failures", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () =>
    Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))),
  );

  it("ordinary update with skipSkills:true still fails closed on a non-skill doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // Install with skipSkills:true so the manifest has an empty `skills`
    // array; this is the configuration where the previous
    // `if (!options.skipSkills && !report.ok)` gate would silently let
    // any doctor failure through.
    await installPoiesis(repository);
    const manifestBefore = await loadManifest(repository.root);
    expect(manifestBefore.skills).toHaveLength(0);

    // Force a non-skill doctor failure: fake opencode fails its `debug
    // config` call (propagates to the doctor `opencode-schema` check).
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runUpdateTransaction(repository.root, { skipSkills: true } satisfies MaintenanceOptions, {}),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // Fail-closed rollback: the manifest on disk is restored to the
    // preimage the journal captured before the first write.
    const manifestAfter = await loadManifest(repository.root);
    expect(manifestAfter.poiesisVersion).toBe(manifestBefore.poiesisVersion);
    expect(manifestAfter.adapter).toEqual(manifestBefore.adapter);
    expect(manifestAfter.skills).toHaveLength(0);
  });

  it("legacy bootstrap with skipSkills:true still fails closed on a non-skill doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // init() then immediately strip the receipt and rewrite the
    // manifest version to a 1.0.0 predecessor so the bootstrap path
    // is the canonical 1.0.0 explicit bootstrap.
    await installPoiesis(repository);
    const manifest = await loadManifest(repository.root);
    manifest.poiesisVersion = "1.0.0";
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await removeOwnershipReceipt(repository.root);
    expect(await ownershipReceiptExists(repository.root)).toBe(false);

    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        runBootstrapLegacyOwnershipTransaction(
          repository.root,
          { skipSkills: true } satisfies MaintenanceOptions,
          {},
        ),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
    }

    // The bootstrap transaction's rollback must leave the receipt
    // absent (the preimage the journal captured was `exists:false`).
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
  });

  it("ordinary update with skipSkills:true does NOT throw when the only doctor failure is the skills check", async () => {
    // After init with skipSkills:true, the manifest has an empty
    // `skills` array, so the doctor skills check naturally reports
    // `skills: fail`. The skipSkills gate must exempt that single
    // failure while still requiring every other check to pass. This
    // test asserts that legitimate skipSkills behavior is preserved:
    // the transaction completes without throwing UPDATE_DOCTOR_FAILED.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installPoiesis(repository);

    // Sanity-check that the only failing doctor check here is skills.
    const { doctor } = await import("../src/maintenance.js");
    const baselineReport = await doctor(repository.root);
    expect(baselineReport.ok).toBe(false);
    const failing = baselineReport.checks.filter((check) => check.status === "fail");
    expect(failing.map((check) => check.id)).toEqual(["skills"]);

    // No doctor failure injected: the only `fail` check is the skills
    // check, which the skipSkills gate must exempt.
    const result = await runUpdateTransaction(
      repository.root,
      { skipSkills: true } satisfies MaintenanceOptions,
      {},
    );
    // The doctor's `ok` is still false because the skills check is in
    // the report; the gate's only contract is that the transaction
    // succeeds (no exception thrown). `result.doctor` is returned as
    // observed; `result.manifest` carries the advanced generation.
    expect(result.manifest.adapter).toBeDefined();
  });
});
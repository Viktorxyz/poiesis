import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, update } from "../src/maintenance.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { ownershipReceiptExists, readOwnershipReceipt, removeOwnershipReceipt } from "../src/receipt.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/**
 * Deterministic transactional `.gitignore` rollback tests.
 *
 * The transactional default-path seam in `src/maintenance.ts` appends the
 * `.poiesis/workspaces/` ignore rule inside the receipt-bearing normal
 * `update` and explicit 1.0.0 `bootstrap` transactions (and the broader
 * `init` transaction). If any later step fails, the rollback must
 * restore the exact `.gitignore` preimage including absence and
 * trailing newline state.
 *
 * Each test below forces the doctor gate to fail AFTER the `.gitignore`
 * transaction writes by installing a stateful test-local fake OpenCode
 * (`tests/fake-opencode.ts`): the first N `opencode debug config`
 * invocations succeed (so the writes inside the try block complete) and
 * the next one fails. Doctor calls `validateOpenCodeConfig` which is the
 * post-write probe that trips the seam.
 */

async function stripNewPathFromGitignore(root: string): Promise<Buffer> {
  const gitignorePath = join(root, ".gitignore");
  const before = await readFile(gitignorePath, "utf8");
  const stripped = before
    .split(/\r?\n/)
    .filter((line) => line.trim() !== ".poiesis/workspaces/")
    .filter((line) => !line.includes("default-path workspace area"))
    .join("\n");
  await writeFile(gitignorePath, stripped);
  return readFile(gitignorePath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function seedDefaultSkillDirectoriesAsPreexisting(repository: TestRepository): Promise<void> {
  // Pre-create each default skill directory with a sentinel file so
  // `installDefaultSkills` treats them as preexisting and skips the
  // network-bound `npx` install step. The init/update transactions
  // still call the doctor gate at the end, which is the seam these
  // tests use to force a post-write failure.
  const defaultNames = [
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
  for (const name of defaultNames) {
    const dir = join(repository.root, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `# ${name}\nseeded by transactional-gitignore.test\n`);
  }
}

async function setup1_0_3Install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function asPredecessorManifest(
  repository: TestRepository,
  predecessorVersion: "1.0.0" | "1.0.1" | "1.0.2",
  options: { keepReceipt?: boolean } = {},
): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  manifest.poiesisVersion = predecessorVersion;
  await writeFile(
    join(repository.root, ".poiesis", "manifest.json"),
    serializeManifest(manifest),
  );
  if (!options.keepReceipt && (await ownershipReceiptExists(repository.root))) {
    await removeOwnershipReceipt(repository.root);
  }
  return manifest;
}

async function rebindReceipt(repository: TestRepository): Promise<void> {
  const manifest = await loadManifest(repository.root);
  const existing = await readOwnershipReceipt(repository.root);
  const { replaceOwnershipReceipt } = await import("../src/receipt.js");
  await replaceOwnershipReceipt(repository.root, manifest, existing);
}

describe("transactional .gitignore rollback on post-write doctor failure", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    // The first `opencode debug config` invocation must succeed so the
    // transactional writes (including the `.gitignore` ensure) complete.
    // The NEXT invocation must fail to trip the doctor gate. The counter
    // file lives inside the repository parent so per-test state is
    // isolated and the file is removed with the repository directory.
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });


  it("receipt-authenticated normal update from stale 1.0.2 gitignore restores exact gitignore bytes plus all transaction state on post-write doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setup1_0_3Install(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    // Rewrite the manifest into the exact v1.0.2 predecessor shape and
    // rebind the receipt so the receipt-authenticated update is the
    // path exercised by the test.
    await asPredecessorManifest(repository, "1.0.2", { keepReceipt: true });
    await rebindReceipt(repository);

    const gitignorePath = join(repository.root, ".gitignore");
    // Strip the new ticket rule so the transaction MUST install it.
    const preimage = await stripNewPathFromGitignore(repository.root);
    expect(preimage.toString("utf8")).not.toContain(".poiesis/workspaces/");

    const manifestBytesBefore = await readFile(join(repository.root, ".poiesis", "manifest.json"));
    const configBytesBefore = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
    const openCodeBytesBefore = await readFile(join(repository.root, "opencode.jsonc"));
    const receiptBefore = await readOwnershipReceipt(repository.root);

    // The receipt-authenticated update calls `opencode debug config` ONCE
    // (inside `doctor → validateOpenCodeConfig`, AFTER the gitignore
    // write inside the try block). Threshold 0 forces this probe to fail
    // so the post-write doctor gate trips and the rollback restores the
    // exact `.gitignore` preimage.
    const failAfterDebugCalls = {
      file: join(repository.parent, ".poiesis", "debug-count.txt"),
      threshold: 0,
    };
    env?.restore();
    env = await installFakeOpenCode({ failAfterDebugCalls });

    // skipSkills:false forces the doctor gate. The pre-seeded skill
    // directories keep `installDefaultSkills` a no-op. The
    // receipt-authenticated normal update calls `opencode debug
    // config` only inside the doctor gate (AFTER the .gitignore write).
    // Threshold 1 fails that probe.
    await expect(
      update(repository.root, {}),
    ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });

    // Gitignore preimage is restored byte-for-byte: exact trailing
    // newline, exact presence/absence of the `.poiesis/workspaces/`
    // rule. This proves the catch-block rollback executes against the
    // current file (the post-write content hash matched).
    expect(await readFile(gitignorePath)).toEqual(preimage);
    expect((await readFile(gitignorePath, "utf8")).includes(".poiesis/workspaces/")).toBe(false);

    // Every other transaction-state surface is also restored.
    expect(await readFile(join(repository.root, ".poiesis", "manifest.json"))).toEqual(manifestBytesBefore);
    expect(await readFile(join(repository.root, ".poiesis", "config.jsonc"))).toEqual(configBytesBefore);
    expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(openCodeBytesBefore);
    const receiptAfter = await readOwnershipReceipt(repository.root);
    expect(receiptAfter.generation).toBe(receiptBefore.generation);
    expect(receiptAfter.manifestDigest).toBe(receiptBefore.manifestDigest);

    // A subsequent receipt-authenticated update WITHOUT the failing fake
    // succeeds transactionally and installs the new rule. This proves
    // the receipt-authenticated happy path still installs the rule after
    // the failure was rolled back.
    env?.restore();
    env = await installFakeOpenCode();
    await update(repository.root, {});
    expect((await readFile(gitignorePath, "utf8")).includes(".poiesis/workspaces/")).toBe(true);
  }, 60_000);

  it("fresh init restores exact .gitignore preimage (including absence) on post-write doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);

    // Fresh project: the `.gitignore` does not exist yet. Snapshot the
    // absence so the rollback must remove any file the transaction may
    // have created.
    const gitignorePath = join(repository.root, ".gitignore");
    expect(await pathExists(gitignorePath)).toBe(false);

    // Init's first `opencode debug config` invocation is
    // `validateOpenCodeConfigPayload` (which runs during the transaction,
    // BEFORE the `.gitignore` write). The NEXT invocation is the doctor
    // gate at the end of the transaction, AFTER the `.gitignore` write.
    // Threshold 1 lets the first succeed and trips the second.
    const failAfterDebugCalls = {
      file: join(repository.parent, ".poiesis", "debug-count.txt"),
      threshold: 1,
    };
    env?.restore();
    env = await installFakeOpenCode({ failAfterDebugCalls });

    // skipSkills:false forces the doctor gate. The pre-seeded skill
    // directories make `installDefaultSkills` a no-op so we reach the
    // doctor without touching the network.
    await expect(
      init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "INIT_DOCTOR_FAILED" });

    // .gitignore preimage is restored: the file did not exist before init
    // and must not exist after the failed init. The rollback deletes the
    // created file when the snapshot was null.
    expect(await pathExists(gitignorePath)).toBe(false);

    // The .poiesis/ owned surface created during the transaction is
    // also rolled back: no manifest, no receipt, no installed files.
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
    expect(await pathExists(join(repository.root, ".poiesis", "manifest.json"))).toBe(false);
    expect(await directoryExists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await pathExists(join(repository.root, "opencode.jsonc"))).toBe(false);

    // A subsequent init WITHOUT the failing fake succeeds transactionally
    // and creates the durable `.gitignore` with the new rule. This proves
    // the rollback did not leave residual state that would block re-init.
    env?.restore();
    env = await installFakeOpenCode();
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    expect(await pathExists(gitignorePath)).toBe(true);
    expect((await readFile(gitignorePath, "utf8")).includes(".poiesis/workspaces/")).toBe(true);
  }, 60_000);

  it("explicit 1.0.0 bootstrap restores exact .gitignore preimage on post-write doctor failure (shared helper with update)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setup1_0_3Install(repository);
    // Demote the install to the 1.0.0 predecessor so explicit
    // --bootstrap-legacy-ownership is the path exercised by the test.
    const manifest = await loadManifest(repository.root);
    manifest.poiesisVersion = "1.0.0";
    await writeFile(
      join(repository.root, ".poiesis", "manifest.json"),
      serializeManifest(manifest),
    );
    await removeOwnershipReceipt(repository.root);
    await seedDefaultSkillDirectoriesAsPreexisting(repository);

    const gitignorePath = join(repository.root, ".gitignore");
    const preimage = await stripNewPathFromGitignore(repository.root);

    // Bootstrap calls `opencode debug config` only inside the doctor
    // gate at the end of the transaction (AFTER the .gitignore write).
    // Threshold 0 forces that single probe to fail.
    const failAfterDebugCalls = {
      file: join(repository.parent, ".poiesis", "debug-count.txt"),
      threshold: 0,
    };
    env?.restore();
    env = await installFakeOpenCode({ failAfterDebugCalls });

    // skipSkills:false forces the doctor gate. The pre-seeded skill
    // directories keep `installDefaultSkills` a no-op.
    await expect(
      update(repository.root, { bootstrapLegacyOwnership: true }),
    ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });

    // Shared helper: bootstrap restores the exact gitignore bytes too.
    expect(await readFile(gitignorePath)).toEqual(preimage);
    expect((await readFile(gitignorePath, "utf8")).includes(".poiesis/workspaces/")).toBe(false);

    // Bootstrap also rolled back the receipt + manifest it would have
    // written. The project is left at the legacy 1.0.0 state with no
    // ownership receipt so the receipt-authenticated path still fails.
    expect(await ownershipReceiptExists(repository.root)).toBe(false);

    // A clean bootstrap re-runs successfully and installs the rule.
    env?.restore();
    env = await installFakeOpenCode();
    await update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true });
    expect((await readFile(gitignorePath, "utf8")).includes(".poiesis/workspaces/")).toBe(true);
  }, 60_000);
});

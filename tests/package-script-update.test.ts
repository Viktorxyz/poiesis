import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, setModel, update, updateFromConfig } from "../src/maintenance.js";
import {
  runUpdateTransaction,
  runBootstrapLegacyOwnershipTransaction,
  type UpdateBootstrapTransactionHooks,
} from "../src/update-internal.js";
import {
  runUpdateConfigTransaction,
  type UpdateTransactionHooks,
} from "../src/update-config-internal.js";
import { PoiesisError } from "../src/errors.js";
import { POIESIS_SCRIPT_COMMAND, POIESIS_SCRIPT_NAME } from "../src/package-script.js";
import { parseJsonc, serializeConfig, type PoiesisConfig } from "../src/config.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import type { Manifest } from "../src/manifest.js";

/**
 * Spec #133 / ticket #135 — the `pnpm poiesis` package script in the
 * UPDATE transaction.
 *
 * Ticket #134 covered NEW installs. These tests cover the path that
 * actually reaches the Authors' existing projects (lucca, leo): a
 * project installed BEFORE the feature existed has no `scripts.poiesis`
 * entry, and `poiesis update` is the reconciliation boundary that
 * restores it.
 *
 * The four Spec acceptance items exercised here:
 *
 *   #6  an already-correct value is left untouched and `package.json`
 *       is not rewritten AT ALL;
 *   #7  a missing or drifted value is restored to the expected value;
 *   #9  a failure after the write restores `package.json` byte-for-byte;
 *   #10 a foreign concurrent write is preserved, not clobbered, and the
 *       operation fails closed.
 *
 * `update --config` (and therefore `setModel`) is covered too: the
 * `pnpm poiesis model set ...` route the README advertises runs that
 * transaction, so it must reconcile the script like the other two.
 *
 * `package.json` is an Author-owned file. It is NOT a manifest record and
 * NOT a mutation-journal entry: it uses the same snapshot +
 * written-hash-gated bespoke rollback the transactional `.gitignore`
 * rule already uses, because it is likewise not a Poiesis-owned artifact
 * under the journal's contract.
 */

const INSERTED_2_SPACE = `    "${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}",\n`;

/**
 * A `package.json` shaped exactly like a project written by a Poiesis
 * release that predates the package script: no `scripts.poiesis` entry,
 * plus deliberately non-canonical Author formatting (a double space after
 * the colon and a trailing line comment) that a re-serialising
 * implementation would normalise. The line comment makes it JSONC, so it
 * is read with `parseJsonc` rather than `JSON.parse`.
 */
const PRE_FEATURE_PACKAGE_JSON = [
  "{",
  '  "name": "demo",',
  '  "scripts": {',
  '    "build": "tsc",',
  '    "test":  "node --test"  // Author spacing is preserved',
  "  },",
  '  "version": "1.0.0"',
  "}",
  "",
].join("\n");

function packageJsonPath(repository: TestRepository): string {
  return join(repository.root, "package.json");
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

/**
 * Byte content PLUS the two filesystem identities that prove a file was
 * not rewritten at all. `atomicWrite` stages a fresh temp file and
 * renames it over the destination, so any write necessarily changes BOTH
 * the inode and the nanosecond mtime. Equal bytes alone would also pass
 * for a rewrite of identical content; equal `ino` + `mtimeNs` cannot.
 */
interface FileIdentity {
  bytes: Buffer;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const [bytes, details] = await Promise.all([readFile(path), stat(path, { bigint: true })]);
  return { bytes, ino: details.ino, mtimeNs: details.mtimeNs, size: details.size };
}

function expectSameFile(before: FileIdentity, after: FileIdentity): void {
  expect(after.bytes).toEqual(before.bytes);
  expect(after.ino, "inode changed, so the file was replaced by a rename").toBe(before.ino);
  expect(after.mtimeNs, "mtime changed, so the file was written").toBe(before.mtimeNs);
  expect(after.size).toBe(before.size);
}

async function readPackageJson(repository: TestRepository): Promise<Record<string, unknown>> {
  return parseJsonc<Record<string, unknown>>(
    await readFile(packageJsonPath(repository), "utf8"),
    packageJsonPath(repository),
  );
}

async function install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function seedDefaultSkillDirectoriesAsPreexisting(repository: TestRepository): Promise<void> {
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
    await writeFile(join(dir, "SKILL.md"), `# ${name}\nseeded by package-script-update.test\n`);
  }
}

/** Run `body` with the fake OpenCode forced to fail every `debug config` probe. */
async function withFailingDoctor<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.POIESIS_TEST_OPENCODE_FAIL;
  process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
    else process.env.POIESIS_TEST_OPENCODE_FAIL = previous;
  }
}

/**
 * Rewind `package.json` to the pre-feature shape AFTER init, modelling an
 * Author whose project was installed by a Poiesis release that predates
 * the package script. `package.json` is not a manifest record, so no
 * update transaction treats this as tampering.
 */
async function downgradeToPreFeaturePackageJson(repository: TestRepository): Promise<Buffer> {
  await writeFile(packageJsonPath(repository), PRE_FEATURE_PACKAGE_JSON);
  return readFile(packageJsonPath(repository));
}

describe("update installs the poiesis package script (Spec #133 / ticket #135)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  /**
   * A project that is genuinely Poiesis-installed AND has a
   * `package.json`. `createTestRepository` does not create one, so it is
   * written before `init` (ticket #134 then installs the correct script
   * into it).
   */
  async function createInstalledRepository(options: { withPackageJson?: boolean } = {}): Promise<TestRepository> {
    const repository = await createTestRepository();
    repositories.push(repository);
    if (options.withPackageJson !== false) {
      await writeFile(packageJsonPath(repository), PRE_FEATURE_PACKAGE_JSON);
    }
    await install(repository);
    return repository;
  }

  it("restores a missing scripts.poiesis entry and leaves every sibling byte intact (acceptance #7)", async () => {
    const repository = await createInstalledRepository();
    const preimage = await downgradeToPreFeaturePackageJson(repository);
    expect(preimage.toString("utf8")).toBe(PRE_FEATURE_PACKAGE_JSON);
    expect(preimage.toString("utf8")).not.toContain(POIESIS_SCRIPT_COMMAND);

    await update(repository.root, { skipSkills: true });

    const after = await readFile(packageJsonPath(repository), "utf8");
    // The entry is created with the exact expected value, prepended so
    // the Author's own entries keep their exact source bytes.
    expect(after).toBe(PRE_FEATURE_PACKAGE_JSON.replace('  "scripts": {\n', `  "scripts": {\n${INSERTED_2_SPACE}`));
    expect(after.replace(INSERTED_2_SPACE, "")).toBe(PRE_FEATURE_PACKAGE_JSON);
    expect(after).toContain('    "test":  "node --test"  // Author spacing is preserved\n');
    expect((await readPackageJson(repository)).scripts).toEqual({
      build: "tsc",
      test: "node --test",
      [POIESIS_SCRIPT_NAME]: POIESIS_SCRIPT_COMMAND,
    });
  }, 60_000);

  it("repairs a drifted scripts.poiesis value surgically (acceptance #7)", async () => {
    const repository = await createInstalledRepository();
    const drifted = [
      "{",
      '  "name": "demo",',
      '  "scripts": {',
      `    "${POIESIS_SCRIPT_NAME}": "echo mine",`,
      '    "build": "tsc",',
      '    "test":  "node --test"  // Author spacing is preserved',
      "  },",
      '  "version": "1.0.0"',
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), drifted);

    await update(repository.root, { skipSkills: true });

    // Only the drifted VALUE's own bytes change: the entry keeps its
    // position and every sibling line is byte-identical.
    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toBe(drifted.replace('"echo mine"', JSON.stringify(POIESIS_SCRIPT_COMMAND)));
    expect((await readPackageJson(repository)).scripts).toEqual({
      build: "tsc",
      test: "node --test",
      [POIESIS_SCRIPT_NAME]: POIESIS_SCRIPT_COMMAND,
    });
  }, 60_000);

  it("does not rewrite package.json at all when the value is already correct (acceptance #6)", async () => {
    const repository = await createInstalledRepository();
    // `init` (ticket #134) already installed the correct value, so this is
    // the steady state every subsequent `update` will encounter.
    const before = await fileIdentity(packageJsonPath(repository));
    expect((await readPackageJson(repository)).scripts).toHaveProperty(
      [POIESIS_SCRIPT_NAME],
      POIESIS_SCRIPT_COMMAND,
    );

    const result = await update(repository.root, { skipSkills: true });

    // The update really did run and really did write other artifacts:
    // an update that silently did nothing would also leave the file
    // untouched, so prove the transaction was live.
    const gitignore = await readFile(join(repository.root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".poiesis/workspaces/");
    expect(result.manifest.poiesisVersion).toBeTruthy();
    expect(result.manifest.files.length).toBeGreaterThan(0);

    expectSameFile(before, await fileIdentity(packageJsonPath(repository)));
  }, 60_000);

  it("does not create a package.json for a project that has none", async () => {
    const repository = await createInstalledRepository({ withPackageJson: false });
    expect(await pathExists(packageJsonPath(repository))).toBe(false);

    await update(repository.root, { skipSkills: true });

    expect(await pathExists(packageJsonPath(repository))).toBe(false);
  }, 60_000);

  it("restores exact package.json bytes when update fails after the write (acceptance #9)", async () => {
    const repository = await createInstalledRepository();
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    const preimage = await downgradeToPreFeaturePackageJson(repository);
    // Observed at the write site so the test cannot pass vacuously by
    // never writing at all.
    let contentAtWriteTime: string | undefined;

    await expect(
      withFailingDoctor(async () => {
        await runUpdateTransaction(
          repository.root,
          {},
          {
            postPoiesisScriptEnsure: async () => {
              contentAtWriteTime = await readFile(packageJsonPath(repository), "utf8");
            },
          } satisfies UpdateBootstrapTransactionHooks,
        );
      }),
    ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });

    // The transaction really did author the script...
    expect(contentAtWriteTime).toBeDefined();
    expect(contentAtWriteTime).toContain(POIESIS_SCRIPT_COMMAND);
    // ...and the rollback restored the exact preimage byte-for-byte,
    // including the Author's double space and trailing comment.
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
  }, 60_000);

  it("preserves a foreign package.json write and fails closed (acceptance #10)", async () => {
    const repository = await createInstalledRepository();
    await downgradeToPreFeaturePackageJson(repository);
    const foreign = '{\n  "name": "author-wrote-this"\n}\n';
    let contentAtWriteTime: string | undefined;

    await expect(
      runUpdateTransaction(
        repository.root,
        { skipSkills: true },
        {
          postPoiesisScriptEnsure: async () => {
            contentAtWriteTime = await readFile(packageJsonPath(repository), "utf8");
            await writeFile(packageJsonPath(repository), foreign);
          },
        } satisfies UpdateBootstrapTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_JSON_CHANGED" });

    // The transaction really did author the script before the foreign
    // write landed...
    expect(contentAtWriteTime).toContain(POIESIS_SCRIPT_COMMAND);
    // ...and the Author's bytes are preserved, never clobbered with the
    // preimage by the rollback.
    expect(await readFile(packageJsonPath(repository), "utf8")).toBe(foreign);
  }, 60_000);

  it("preserves a foreign package.json write that lands after the identity check and before the rollback (acceptance #10)", async () => {
    const repository = await createInstalledRepository();
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    await downgradeToPreFeaturePackageJson(repository);
    const foreign = '{\n  "name": "author-wrote-this"\n}\n';
    let contentAtWriteTime: string | undefined;

    // The foreign write lands AFTER this transaction's package.json
    // identity check, so that check passes and the failure comes from
    // the doctor gate. This is the path that exercises
    // `rollbackPackageJson`'s written-hash gate for real: the rollback
    // must no-op rather than restore the preimage over Author bytes.
    await expect(
      withFailingDoctor(async () => {
        await runUpdateTransaction(
          repository.root,
          {},
          {
            postPoiesisScriptEnsure: async () => {
              contentAtWriteTime = await readFile(packageJsonPath(repository), "utf8");
            },
            postReceiptReplace: async () => {
              await writeFile(packageJsonPath(repository), foreign);
            },
          } satisfies UpdateBootstrapTransactionHooks,
        );
      }),
    ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });

    expect(contentAtWriteTime).toContain(POIESIS_SCRIPT_COMMAND);
    expect(await readFile(packageJsonPath(repository), "utf8")).toBe(foreign);
  }, 60_000);

  it("a post-write throw from the hook still restores the exact preimage (rollback identity is bound at write time)", async () => {
    const repository = await createInstalledRepository();
    const preimage = await downgradeToPreFeaturePackageJson(repository);
    let contentAtWriteTime: string | undefined;

    // The throw lands AFTER `ensurePoiesisScript` completed its write but
    // BEFORE the transaction could record the written hash by assignment.
    // Because the hash is bound through the `onWritten` callback instead,
    // the catch block still holds the identity it needs to reverse Poiesis's
    // own write to an Author file.
    await expect(
      runUpdateTransaction(
        repository.root,
        { skipSkills: true },
        {
          postPoiesisScriptEnsure: async () => {
            contentAtWriteTime = await readFile(packageJsonPath(repository), "utf8");
            throw new PoiesisError("INJECTED_POST_WRITE_FAULT", "post-write hook fault");
          },
        } satisfies UpdateBootstrapTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "INJECTED_POST_WRITE_FAULT" });

    expect(contentAtWriteTime).toContain(POIESIS_SCRIPT_COMMAND);
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
  }, 60_000);

  it("bootstrap parity: the explicit 1.0.0 bootstrap restores the script too (acceptance #7)", async () => {
    const repository = await createInstalledRepository();
    // Demote the install to the exact 1.0.0 predecessor projection and
    // drop the receipt, which is the only state
    // `--bootstrap-legacy-ownership` admits.
    const { asLegacyProjection } = await import("./legacy-bootstrap-fixture.js");
    await asLegacyProjection(repository.root, "1.0.0");
    const preimage = await downgradeToPreFeaturePackageJson(repository);

    await runBootstrapLegacyOwnershipTransaction(repository.root, { skipSkills: true }, {});

    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toBe(PRE_FEATURE_PACKAGE_JSON.replace('  "scripts": {\n', `  "scripts": {\n${INSERTED_2_SPACE}`));
    expect(after.replace(INSERTED_2_SPACE, "")).toBe(preimage.toString("utf8"));
  }, 60_000);
});

describe("update --config and setModel reconcile the package script (acceptance #7)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  async function createInstalledRepository(): Promise<TestRepository> {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(join(repository.root, "package.json"), PRE_FEATURE_PACKAGE_JSON);
    await install(repository);
    return repository;
  }

  async function writeCandidateConfig(repository: TestRepository, mutate: (config: PoiesisConfig) => void): Promise<string> {
    const configPath = join(repository.parent, "candidate-config.jsonc");
    const next = structuredClone(testConfig(repository)) as PoiesisConfig;
    mutate(next);
    await writeFile(configPath, serializeConfig(next));
    return configPath;
  }

  it("updateFromConfig restores a missing scripts.poiesis entry (acceptance #7)", async () => {
    const repository = await createInstalledRepository();
    const preimage = await downgradeToPreFeaturePackageJson(repository);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });

    await updateFromConfig(repository.root, candidatePath);

    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toBe(PRE_FEATURE_PACKAGE_JSON.replace('  "scripts": {\n', `  "scripts": {\n${INSERTED_2_SPACE}`));
    expect(after.replace(INSERTED_2_SPACE, "")).toBe(preimage.toString("utf8"));
  }, 60_000);

  it("updateFromConfig repairs a drifted scripts.poiesis value surgically (acceptance #7)", async () => {
    const repository = await createInstalledRepository();
    const drifted = [
      "{",
      '  "name": "demo",',
      '  "scripts": {',
      `    "${POIESIS_SCRIPT_NAME}": "echo mine",`,
      '    "build": "tsc"',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), drifted);
    const candidatePath = await writeCandidateConfig(repository, (config) => {
      config.models.execution = "minimax/MiniMax-M3-alt";
    });

    await updateFromConfig(repository.root, candidatePath);

    expect(await readFile(packageJsonPath(repository), "utf8")).toBe(
      drifted.replace('"echo mine"', JSON.stringify(POIESIS_SCRIPT_COMMAND)),
    );
  }, 60_000);

  it("setModel — the advertised `pnpm poiesis model set` route — restores a missing script (acceptance #7)", async () => {
    const repository = await createInstalledRepository();
    const preimage = await downgradeToPreFeaturePackageJson(repository);
    expect((await readPackageJson(repository)).scripts).not.toHaveProperty([POIESIS_SCRIPT_NAME]);

    await setModel(repository.root, "execution", "minimax/MiniMax-M3-alt");

    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toBe(PRE_FEATURE_PACKAGE_JSON.replace('  "scripts": {\n', `  "scripts": {\n${INSERTED_2_SPACE}`));
    expect(after.replace(INSERTED_2_SPACE, "")).toBe(preimage.toString("utf8"));
  }, 60_000);

  it("setModel does not rewrite package.json when the value is already correct (acceptance #6)", async () => {
    const repository = await createInstalledRepository();
    const before = await fileIdentity(packageJsonPath(repository));

    await setModel(repository.root, "execution", "minimax/MiniMax-M3-alt");

    expectSameFile(before, await fileIdentity(packageJsonPath(repository)));
  }, 60_000);

  it("update --config restores exact package.json bytes when the transaction fails after the write (acceptance #9)", async () => {
    const repository = await createInstalledRepository();
    const preimage = await downgradeToPreFeaturePackageJson(repository);
    let contentAtWriteTime: string | undefined;
    // `update --config` probes `opencode debug config` once in the
    // preflight and once in the doctor gate, so a stateful fake with
    // threshold 1 fails the doctor gate — i.e. AFTER the package.json
    // write. A blanket `POIESIS_TEST_OPENCODE_FAIL` would fail the
    // preflight instead, before anything is written.
    const counterDir = await mkdtemp(join(tmpdir(), "poiesis-doctor-counter-"));
    env?.restore();
    env = await installFakeOpenCode({
      failAfterDebugCalls: { file: join(counterDir, "count"), threshold: 1 },
    });

    await expect(
      runUpdateConfigTransaction(
        repository.root,
        await writeCandidateConfig(repository, (config) => {
          config.models.execution = "minimax/MiniMax-M3-alt";
        }),
        {},
        {
          postPoiesisScriptEnsure: async () => {
            contentAtWriteTime = await readFile(packageJsonPath(repository), "utf8");
          },
        } satisfies UpdateTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });

    expect(contentAtWriteTime).toContain(POIESIS_SCRIPT_COMMAND);
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
  }, 60_000);

  it("update --config preserves a foreign package.json write and fails closed (acceptance #10)", async () => {
    const repository = await createInstalledRepository();
    await downgradeToPreFeaturePackageJson(repository);
    const foreign = '{\n  "name": "author-wrote-this"\n}\n';
    let contentAtWriteTime: string | undefined;

    await expect(
      runUpdateConfigTransaction(
        repository.root,
        await writeCandidateConfig(repository, (config) => {
          config.models.execution = "minimax/MiniMax-M3-alt";
        }),
        {},
        {
          postPoiesisScriptEnsure: async () => {
            contentAtWriteTime = await readFile(packageJsonPath(repository), "utf8");
            await writeFile(packageJsonPath(repository), foreign);
          },
        } satisfies UpdateTransactionHooks,
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_JSON_CHANGED" });

    expect(contentAtWriteTime).toContain(POIESIS_SCRIPT_COMMAND);
    expect(await readFile(packageJsonPath(repository), "utf8")).toBe(foreign);
  }, 60_000);
});

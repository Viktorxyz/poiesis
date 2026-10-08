/**
 * Spec #190 / ticket #193 — the transition's behaviour INSIDE the transaction
 * window, through the module-internal transaction seam.
 *
 * The packaged-CLI suite (`tests/install-mode-transition.test.ts`) proves what
 * an Author ends up with. These cases prove what happens to bytes that change
 * WHILE the transition is running, which an ordinary single-process CLI run
 * cannot produce on demand:
 *
 *   - a `.gitignore` replaced between the plan and the write fails closed and
 *     leaves the foreign bytes exactly as they are;
 *   - a shared profile that appears mid-transaction is never adopted or
 *     overwritten — the bounded journal detects the appearance, the rollback
 *     restores the relabelled block, and the foreign file survives;
 *   - a fault after every transition write rolls `.gitignore` back
 *     byte-for-byte and removes the profile files this run created.
 *
 * The deterministic fault-injection points are the `UpdateTransactionHooks`
 * this module already owns; the transition adds three of its own. They are
 * deliberately NOT part of the packed public declaration.
 *
 * Default skill directories are pre-created so `init` records all of them as
 * `preexisting` and never reaches the network.
 */
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoResolveConfigDefaults, init } from "../src/maintenance.js";
import { runUpdateConfigTransaction, type UpdateTransactionHooks } from "../src/update-config-internal.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import {
  ownershipReceiptLocation,
  readOwnershipReceipt,
  replaceOwnershipReceipt,
} from "../src/receipt.js";
import { atomicWrite } from "../src/fs.js";
import { PoiesisError } from "../src/errors.js";
import { parseManagedIgnoreBlocks } from "../src/install-mode.js";
import {
  assertTransitionCaptureIdentity,
  planInstallModeTransition,
} from "../src/install-mode-transition.js";
import { POIESIS_GENERATED_AGENT_PATHS, templateMappings } from "../src/templates.js";
import { TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_DIRECTORY, TEAM_PROFILE_SKILLS_LOCK_PATH } from "../src/team-profile.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { hashContent } from "../src/hash.js";
import { loadConfig, parseJsonc, serializeConfig, type PoiesisConfig } from "../src/config.js";

/**
 * The fully-resolved configuration a transition would publish, resolved the
 * same way the transaction resolves it, so the plan under test is the plan the
 * transaction would really produce.
 */
async function autoResolvedConfigFor(root: string) {
  const resolved = await autoResolveConfigDefaults(root, await loadConfig(root));
  return resolved.config;
}

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

function portableConfig(mode: "private" | "team"): PoiesisConfig {
  const command = (target: string) => ({
    adapter: "command",
    command: ["node", `scripts/poiesis-${target}.mjs`, target, "{sha}"],
  });
  return {
    schema: 1,
    mode,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: "poiesis-tracker-fixture" },
    delivery: {
      preview: command("preview"),
      staging: command("staging"),
      production: command("production"),
    },
    verification: { commands: ["test -f README.md"] },
  };
}

/**
 * The manifest a pre-Spec #190 installation actually recorded.
 *
 * Dropping `mode` and `ignoreBlock` is only half of that shape: authority
 * classifies project-tracked template files as `durable` exactly when the
 * manifest records no mode (`expectedManagedFiles`), which is what `update`
 * writes for such an installation. A manifest stripped of the mode keys while
 * keeping #191's classification is not a legacy manifest at all — it is a
 * tampered one, and authority rejects it before this ticket's guard is ever
 * reached. So the fixture mirrors the real migration boundary instead.
 */
function asLegacyManifest(manifest: Manifest): Manifest {
  const { mode: _mode, ignoreBlock: _ignoreBlock, ...rest } = manifest;
  const durablePaths = new Set(
    templateMappings.filter((mapping) => mapping.trackInProject === true).map((mapping) => mapping.destination),
  );
  return {
    ...rest,
    files: manifest.files.map((file) =>
      file.durable === undefined && durablePaths.has(file.path) ? { ...file, durable: true } : file,
    ),
  } as Manifest;
}

async function seedAuthorSkills(root: string): Promise<void> {
  for (const name of DEFAULT_SKILL_NAMES) {
    const directory = join(root, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `# author skill ${name}\n`, "utf8");
  }
}

async function writeCandidate(root: string, mode: "private" | "team"): Promise<string> {
  const path = join(root, "..", `candidate-${mode}.jsonc`);
  await writeFile(path, serializeConfig(portableConfig(mode)));
  return path;
}

interface SharingSnapshot {
  gitignore: Buffer;
  manifest: Buffer;
  config: Buffer;
  opencode: Buffer;
}

async function snapshot(root: string): Promise<SharingSnapshot> {
  return {
    gitignore: await readFile(join(root, ".gitignore")),
    manifest: await readFile(join(root, ".poiesis", "manifest.json")),
    config: await readFile(join(root, ".poiesis", "config.jsonc")),
    opencode: await readFile(join(root, "opencode.jsonc")),
  };
}

describe("Spec #190 / ticket #193 - the transition inside the transaction window", () => {
  const repositories: TestRepository[] = [];
  let fake: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    fake = await installFakeOpenCode();
  });

  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });

  afterAll(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  /**
   * Rewrite the installed manifest into the shape a pre-Spec #190
   * installation recorded, and rebind the receipt to it.
   *
   * Rebinding is what makes this a genuine LEGACY state rather than a
   * tampered one: the transaction authenticates the receipt before it reads
   * anything else, so an authenticated manifest with no `mode` is precisely the
   * input that has to refuse — and a receipt-bound one cannot be dismissed as
   * corruption.
   */
  const installLegacyManifest = async (root: string): Promise<Manifest> => {
    const receipt = await readOwnershipReceipt(root);
    const legacy = asLegacyManifest(await loadManifest(root));
    await atomicWrite(join(root, ".poiesis", "manifest.json"), serializeManifest(legacy));
    // Rebind to the manifest as `loadManifest` returns it, NOT to the literal
    // that was written. The digest is computed over the canonical serialization,
    // and `manifestSchema` is a strict object whose parse normalises key order,
    // so a receipt bound to the pre-parse literal would not match the bytes the
    // transaction reads back.
    const roundTripped = await loadManifest(root);
    await replaceOwnershipReceipt(root, roundTripped, receipt);
    return roundTripped;
  };

  const installPrivate = async (): Promise<TestRepository> => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await seedAuthorSkills(repo.root);
    await init(repo.root, portableConfig("private"), { allowFixtureAdapters: true });
    return repo;
  };

  it("refuses a .gitignore that was replaced after the plan and preserves the foreign bytes", async () => {
    const repo = await installPrivate();
    const before = await snapshot(repo.root);
    const foreign = "# a teammate got here first\ndist/\n";

    const hooks: UpdateTransactionHooks = {
      preModeTransitionApply: async () => {
        await writeFile(join(repo.root, ".gitignore"), foreign, "utf8");
      },
    };

    await expect(
      runUpdateConfigTransaction(repo.root, await writeCandidate(repo.root, "team"), {}, hooks),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });

    // The concurrent writer's bytes are the ones on disk, untouched.
    expect(await readFile(join(repo.root, ".gitignore"), "utf8")).toBe(foreign);
    const after = await snapshot(repo.root);
    expect(Buffer.compare(after.manifest, before.manifest)).toBe(0);
    expect(Buffer.compare(after.config, before.config)).toBe(0);
    expect((await loadManifest(repo.root)).mode).toBe("private");
    expect(await pathExists(join(repo.root, TEAM_PROFILE_CONFIG_PATH))).toBe(false);
  }, 120_000);

  it("never adopts or overwrites a shared profile that appears mid-transaction, and still rolls back", async () => {
    const repo = await installPrivate();
    const before = await snapshot(repo.root);
    const foreignProfile = `${JSON.stringify({ ...portableConfig("team"), note: "written by a teammate" }, null, 2)}\n`;

    const hooks: UpdateTransactionHooks = {
      // Fires after `.gitignore` has been relabelled and before the profile is
      // created: the journal captured this path as ABSENT, so a file appearing
      // here is exactly the "replaced while the transaction ran" case.
      postModeTransitionGitignore: async () => {
        await mkdir(join(repo.root, TEAM_PROFILE_DIRECTORY), { recursive: true });
        await writeFile(join(repo.root, TEAM_PROFILE_CONFIG_PATH), foreignProfile, "utf8");
      },
    };

    await expect(
      runUpdateConfigTransaction(repo.root, await writeCandidate(repo.root, "team"), {}, hooks),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });

    // The foreign profile survives; the relabelled block does not; the
    // lock Poiesis would have created alongside it does not exist.
    expect(await readFile(join(repo.root, TEAM_PROFILE_CONFIG_PATH), "utf8")).toBe(foreignProfile);
    expect(await pathExists(join(repo.root, TEAM_PROFILE_SKILLS_LOCK_PATH))).toBe(false);
    const after = await snapshot(repo.root);
    expect(Buffer.compare(after.gitignore, before.gitignore)).toBe(0);
    expect(Buffer.compare(after.manifest, before.manifest)).toBe(0);
    expect(Buffer.compare(after.config, before.config)).toBe(0);
    expect((await loadManifest(repo.root)).mode).toBe("private");
    // The run created the profile directory, and it is still the Author's to
    // keep: a rollback removes only what the journal still owns, and a foreign
    // file inside the directory makes it non-empty on purpose.
    expect(await pathExists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(true);
  }, 120_000);

  it("refuses an EXPLICIT mode against an installation whose manifest records none, and writes nothing", async () => {
    const repo = await installPrivate();
    // Reproduce a pre-Spec #190 installation exactly as it is: a manifest that
    // records no sharing mode and owns no ignore block. The receipt is rebound
    // to it, so this is an authenticated legacy state and not a tampered one —
    // which is the whole point, because a receipt-authenticated manifest is
    // exactly the input that must still refuse.
    const legacyManifest = await installLegacyManifest(repo.root);
    expect((await loadManifest(repo.root)).mode).toBeUndefined();

    const before = await snapshot(repo.root);
    const beforeReceipt = await readFile(await ownershipReceiptLocation(repo.root));
    const beforeConfigMode = parseJsonc<{ mode?: string }>(
      before.config.toString("utf8"),
      ".poiesis/config.jsonc",
    ).mode;

    for (const requested of ["team", "private"] as const) {
      const result = await runUpdateConfigTransaction(
        repo.root,
        await writeCandidate(repo.root, requested),
        {},
        {},
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result, `an explicit "${requested}" mode must not succeed`).toBeInstanceOf(PoiesisError);
      expect((result as PoiesisError).code).toBe("INSTALL_MODE_TRANSITION_UNSUPPORTED");
      expect((result as PoiesisError).details).toMatchObject({
        path: ".poiesis/manifest.json",
        requested,
        recorded: null,
      });

      // The refusal is total: no config mode was written, the manifest did not
      // advance, the block was not relabelled, and no shared profile appeared.
      const after = await snapshot(repo.root);
      expect(Buffer.compare(after.config, before.config), "the installed config gained a mode").toBe(0);
      expect(Buffer.compare(after.manifest, before.manifest)).toBe(0);
      expect(Buffer.compare(after.gitignore, before.gitignore)).toBe(0);
      expect(Buffer.compare(after.opencode, before.opencode)).toBe(0);
      expect(Buffer.compare(await readFile(await ownershipReceiptLocation(repo.root)), beforeReceipt)).toBe(0);
      expect((await loadManifest(repo.root)).mode).toBeUndefined();
      expect(await pathExists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
      // The installed config's mode is whatever it already was — the refusal
      // never rewrites it, and never lets the requested mode into a config the
      // manifest and block cannot back up.
      expect(
        parseJsonc<{ mode?: string }>(after.config.toString("utf8"), ".poiesis/config.jsonc").mode,
      ).toBe(beforeConfigMode);
    }
  }, 120_000);

  it("still performs an ordinary legacy update when the candidate omits mode", async () => {
    const repo = await installPrivate();
    await installLegacyManifest(repo.root);

    // The paired positive control for the refusal above: saying nothing about
    // sharing is an ordinary config update on a legacy installation, and it
    // must still work — no refusal, no invented mode, no block to relabel.
    const { mode: _omitted, ...base } = portableConfig("private");
    const candidate = join(repo.root, "..", "candidate-no-mode.jsonc");
    await writeFile(
      candidate,
      serializeConfig({ ...base, models: { ...base.models, execution: "minimax/MiniMax-M3-alt" } }),
    );

    const result = await runUpdateConfigTransaction(repo.root, candidate, {}, {});
    expect(result.manifest.mode).toBeUndefined();
    const config = parseJsonc<{ mode?: string; models: { execution: string } }>(
      await readFile(join(repo.root, ".poiesis", "config.jsonc"), "utf8"),
      ".poiesis/config.jsonc",
    );
    expect(config.mode).toBeUndefined();
    expect(config.models.execution).toBe("minimax/MiniMax-M3-alt");
    // The transition hooks never fired: there was no transition to apply.
    expect((await loadManifest(repo.root)).mode).toBeUndefined();
    expect(await pathExists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
  }, 120_000);

  it("refuses to apply a plan whose .gitignore or absent profile no longer matches what it observed", async () => {
    const repo = await installPrivate();
    const manifest = await loadManifest(repo.root);
    const plan = await planInstallModeTransition({
      root: repo.root,
      manifest,
      to: "team",
      resolvedConfig: await autoResolvedConfigFor(repo.root),
      generatedAgentPaths: POIESIS_GENERATED_AGENT_PATHS,
    });

    // The plan was rendered against these exact bytes and decided to CREATE
    // both profile files because neither existed.
    expect(plan.observedGitignoreHash).toBe(hashContent(await readFile(join(repo.root, ".gitignore"))));
    expect(plan.createProfileFiles.map((file) => file.path)).toEqual([
      TEAM_PROFILE_CONFIG_PATH,
      TEAM_PROFILE_SKILLS_LOCK_PATH,
    ]);

    const observed = await readFile(join(repo.root, ".gitignore"));
    const capturedAbsent = plan.createProfileFiles.map((file) => ({ path: file.path, physicalExists: false }));

    // Binding to what the journal captured is the happy path.
    expect(() =>
      assertTransitionCaptureIdentity(plan, {
        gitignorePreimage: observed,
        profileCaptures: capturedAbsent,
      }),
    ).not.toThrow();

    // A `.gitignore` that is not the observed content cannot be spliced from
    // this plan.
    expect(() =>
      assertTransitionCaptureIdentity(plan, {
        gitignorePreimage: Buffer.from("# replaced by a teammate\n", "utf8"),
        profileCaptures: [],
      }),
    ).toThrow(expect.objectContaining({ code: "ARTIFACT_IDENTITY_DRIFT", details: { path: ".gitignore" } }));

    // A missing `.gitignore` is the same class of disagreement, not a licence.
    expect(() =>
      assertTransitionCaptureIdentity(plan, { gitignorePreimage: undefined, profileCaptures: [] }),
    ).toThrow(expect.objectContaining({ code: "ARTIFACT_IDENTITY_DRIFT" }));

    // And a profile that appeared after the plan is never created over: that is
    // exactly the Author-committed content adoption was supposed to decide on.
    for (const path of [TEAM_PROFILE_CONFIG_PATH, TEAM_PROFILE_SKILLS_LOCK_PATH]) {
      expect(() =>
        assertTransitionCaptureIdentity(plan, {
          gitignorePreimage: observed,
          profileCaptures: [{ path, physicalExists: true }],
        }),
      ).toThrow(expect.objectContaining({ code: "ARTIFACT_IDENTITY_DRIFT", details: { path } }));
    }
  }, 120_000);

  it("restores every touched byte and removes what it created when a post-write step fails", async () => {
    const repo = await installPrivate();
    const before = await snapshot(repo.root);

    const hooks: UpdateTransactionHooks = {
      // Fires after the config, the OpenCode projection, the relabelled block,
      // AND the created profile files — the widest possible rollback surface.
      postModeTransitionApply: () => {
        throw new Error("injected post-transition fault");
      },
    };

    await expect(
      runUpdateConfigTransaction(repo.root, await writeCandidate(repo.root, "team"), {}, hooks),
    ).rejects.toThrow("injected post-transition fault");

    const after = await snapshot(repo.root);
    expect(Buffer.compare(after.gitignore, before.gitignore), "the relabelled block must be reverted").toBe(0);
    expect(Buffer.compare(after.opencode, before.opencode)).toBe(0);
    expect(Buffer.compare(after.config, before.config)).toBe(0);
    expect(Buffer.compare(after.manifest, before.manifest)).toBe(0);
    // The profile files this run created are gone, and so is the directory it
    // had to make to hold them.
    expect(await pathExists(join(repo.root, TEAM_PROFILE_DIRECTORY))).toBe(false);
    const manifest = await loadManifest(repo.root);
    expect(manifest.mode).toBe("private");
    expect(manifest.ignoreBlock?.mode).toBe("private");

    // And the block on disk is still exactly the one the manifest claims, so a
    // later `uninstall` still recognises it.
    const [block] = parseManagedIgnoreBlocks(after.gitignore.toString("utf8"));
    expect(block?.hash).toBe(manifest.ignoreBlock?.hash);
  }, 120_000);
});

/**
 * Existence, for BOTH files and directories.
 *
 * `lstat` rather than `existsSync` so a symlink at the path counts as present:
 * this suite asserts that a path still holds whatever a foreign writer left
 * there, and "absent" must mean absent rather than "followed to somewhere
 * else".
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
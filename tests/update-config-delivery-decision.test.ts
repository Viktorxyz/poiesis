/**
 * Spec #139 / ticket #166 — an omitted `delivery` block is a FRESH-INSTALL
 * default, never an UPDATE default.
 *
 * `init --config` may complete a project that states no delivery at all: the
 * block resolves to the three generated command targets and `init` writes the
 * matching `scripts/poiesis-<target>.mjs` beside them. That is the legacy
 * behavior an existing noninteractive installation was created under, so it
 * stays exactly as it is.
 *
 * `update --config` is a different question. It is handed a proposed document
 * for an installation that ALREADY recorded a delivery decision, and the one
 * default that must never be invented there is delivery itself: resolving the
 * omission to the generated targets would replace a recorded `deferred` state
 * — or an Author's three real commands — with names of scripts the transaction
 * never writes and `update --config` never writes anything outside the four
 * managed artifacts. The document therefore has to state the decision, and an
 * omission is refused.
 *
 * The refusal is contextual, not a schema change. `configSchema` still treats
 * `delivery` as optional so `init --config` keeps working, and the same
 * `INVALID_DELIVERY_CONFIG` code that already reports a partial block, an
 * unknown `mode`, and a deferred block that also carries a target is the one
 * that reports the omission, with `field` and `operation` naming it.
 *
 * Every test here asserts the same three things, because the contract is not
 * only WHICH code is reported but WHERE it is decided:
 *
 *   - the code, with `field: "delivery"` and `operation: "update --config"`;
 *   - every byte the transaction could have touched — the managed config, the
 *     OpenCode config, the manifest, the ownership receipt and its generation,
 *     the Author-owned `package.json`, and the delivery scripts — unchanged,
 *     and the released mutation lock gone;
 *   - nothing that probes or records: no subprocess at all, and no journal.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap `run` so the test can see exactly which subprocesses the runtime
// reached. The wrapper calls the real runner, so real Git and real OpenCode
// behavior is preserved; only the call log is added. The same seam is used by
// `deferred-delivery-lifecycle.test.ts` for its zero-side-effect matrix.
vi.mock("../src/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process.js")>();
  return { ...actual, run: vi.fn(actual.run) };
});

import {
  DEFERRED_DELIVERY_MODE,
  parseJsonc,
  serializeConfig,
  type PoiesisConfig,
} from "../src/config.js";
import { init, setModel, updateFromConfig } from "../src/maintenance.js";
import { runUpdateConfigTransaction } from "../src/update-config-internal.js";
import { run } from "../src/process.js";
import { DELIVERY_TARGETS, deliveryScriptPath } from "../src/delivery-defaults.js";
import { ownershipReceiptLocation, readOwnershipReceipt } from "../src/receipt.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const CONFIG_ROOT = ".poiesis/config.jsonc";

/**
 * A config document that states EVERYTHING except the delivery decision. This
 * is the input the refusal is about: it is a complete, valid config under
 * `init --config`, and under `update --config` it is an unanswered question.
 */
function configWithoutDelivery(repository: TestRepository): PoiesisConfig {
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: join(repository.fixtures, "tracker") },
    verification: { commands: ["test -f README.md"] },
  };
}

function commandDelivery(): NonNullable<PoiesisConfig["delivery"]> {
  return {
    preview: { adapter: "command", command: ["node", "scripts/poiesis-preview.mjs", "{sha}", "{target}"] },
    staging: { adapter: "command", command: ["node", "scripts/poiesis-staging.mjs", "{sha}", "{target}"] },
    production: { adapter: "command", command: ["node", "scripts/poiesis-production.mjs", "{sha}", "{target}"] },
  };
}

/** Author-authored delivery scripts, so the configured install owns real files. */
async function writeAuthorDeliveryScripts(repository: TestRepository): Promise<void> {
  await mkdir(join(repository.root, "scripts"), { recursive: true });
  for (const target of DELIVERY_TARGETS) {
    await writeFile(join(repository.root, deliveryScriptPath(target)), `#!/usr/bin/env node\n// author script for ${target}\n`);
  }
}

async function readInstalledConfig(repository: TestRepository): Promise<PoiesisConfig> {
  const path = join(repository.root, CONFIG_ROOT);
  return parseJsonc<PoiesisConfig>(await readFile(path, "utf8"), path);
}

/** Every byte `update --config` could mutate, plus the script surface. */
interface PreservedState {
  poiesisConfig: Buffer;
  openCodeConfig: Buffer;
  manifest: Buffer;
  receipt: Buffer;
  receiptGeneration: number;
  receiptManifestDigest: number | string;
  packageJson: Buffer | null;
  packagePoiesisScript: unknown;
  deliveryScripts: Map<string, Buffer | null>;
  mutationLockPresent: boolean;
}

async function snapshotPreservedState(repository: TestRepository): Promise<PreservedState> {
  const receiptPath = await ownershipReceiptLocation(repository.root);
  const receipt = await readOwnershipReceipt(repository.root);
  const packageJsonPath = join(repository.root, "package.json");
  const packageJson = existsSync(packageJsonPath) ? await readFile(packageJsonPath) : null;
  const deliveryScripts = new Map<string, Buffer | null>();
  for (const target of DELIVERY_TARGETS) {
    const path = join(repository.root, deliveryScriptPath(target));
    deliveryScripts.set(target, existsSync(path) ? await readFile(path) : null);
  }
  return {
    poiesisConfig: await readFile(join(repository.root, CONFIG_ROOT)),
    openCodeConfig: await readFile(join(repository.root, "opencode.jsonc")),
    manifest: await readFile(join(repository.root, ".poiesis", "manifest.json")),
    receipt: await readFile(receiptPath),
    receiptGeneration: receipt.generation,
    receiptManifestDigest: receipt.manifestDigest,
    packageJson,
    packagePoiesisScript: packageJson === null
      ? undefined
      : (JSON.parse(packageJson.toString("utf8")) as { scripts?: Record<string, string> }).scripts?.poiesis,
    deliveryScripts,
    mutationLockPresent: existsSync(`${receiptPath}.mutation.lock`),
  };
}

function expectPreserved(before: PreservedState, after: PreservedState): void {
  expect(Buffer.compare(after.poiesisConfig, before.poiesisConfig), "managed config bytes changed").toBe(0);
  expect(Buffer.compare(after.openCodeConfig, before.openCodeConfig), "opencode config bytes changed").toBe(0);
  expect(Buffer.compare(after.manifest, before.manifest), "manifest bytes changed").toBe(0);
  expect(Buffer.compare(after.receipt, before.receipt), "ownership receipt bytes changed").toBe(0);
  expect(after.receiptGeneration, "receipt generation advanced").toBe(before.receiptGeneration);
  expect(after.receiptManifestDigest, "receipt manifest digest changed").toBe(before.receiptManifestDigest);
  if (before.packageJson === null) {
    expect(after.packageJson, "package.json was created").toBeNull();
  } else {
    expect(Buffer.compare(after.packageJson!, before.packageJson), "package.json bytes changed").toBe(0);
  }
  expect(after.packagePoiesisScript, "the pnpm poiesis package script changed").toBe(before.packagePoiesisScript);
  for (const [target, bytes] of before.deliveryScripts) {
    const now = after.deliveryScripts.get(target)!;
    if (bytes === null) {
      expect(now, `a delivery script was generated for ${target}`).toBeNull();
    } else {
      expect(Buffer.compare(now, bytes), `delivery script for ${target} changed`).toBe(0);
    }
  }
  expect(after.mutationLockPresent, "the mutation lock was left behind").toBe(false);
}

function subprocessCallsSince(mark: number): string[] {
  return (run as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .slice(mark)
    .map((call) => `${String(call[0])} ${Array.isArray(call[1]) ? (call[1] as unknown[]).map(String).join(" ") : ""}`.trim());
}

function markSubprocesses(): number {
  return (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

/**
 * The only subprocess that may run before this transaction's body is the
 * read-only `git rev-parse` that locates the ownership receipt the mutation
 * lock is keyed by. That is the same carve-out the shipped refusal-precedence
 * contract already states for read-only Git locators, and it is why the
 * assertion is "every call reached is one of these" rather than a literal
 * "no subprocess at all": a claim stronger than the runtime makes would be a
 * claim that fails the first time a locator is added.
 *
 * Everything the contract actually forbids is named explicitly below, so a
 * future implementation that resolves the omission, probes a capability, or
 * reaches a side effect cannot hide behind the carve-out.
 */
const READ_ONLY_RECEIPT_LOCATORS = new Set(["git rev-parse --git-common-dir"]);

/** Capability and tracker-auth probes. */
const PROBE_EXECUTABLES = new Set(["opencode", "gh", "glab"]);

/** The Git calls `autoResolveConfigDefaults` makes while resolving defaults. */
const DEFAULT_RESOLUTION_GIT_SUBCOMMANDS = new Set(["remote", "branch", "ls-remote", "config"]);

/** Subcommands that change the repository or the remote. */
const SIDE_EFFECTING_GIT_SUBCOMMANDS = new Set([
  "add", "apply", "checkout", "clean", "commit", "commit-tree", "fetch", "merge", "push",
  "rebase", "reset", "rm", "stash", "tag", "update-ref", "worktree", "write-tree",
]);

function reachedProbesOrSideEffects(calls: unknown[][]): string[] {
  const reached: string[] = [];
  for (const call of calls) {
    const executable = String(call[0]);
    const args = Array.isArray(call[1]) ? (call[1] as unknown[]).map(String) : [];
    const label = [executable, ...args].join(" ");
    if (PROBE_EXECUTABLES.has(executable)) reached.push(`probe: ${label}`);
    if (executable !== "git") continue;
    const subcommand = args[0];
    if (subcommand === undefined) continue;
    if (DEFAULT_RESOLUTION_GIT_SUBCOMMANDS.has(subcommand)) reached.push(`default resolution: ${label}`);
    if (SIDE_EFFECTING_GIT_SUBCOMMANDS.has(subcommand)) reached.push(`side effect: ${label}`);
  }
  return reached;
}

const EXPECTED_REFUSAL = {
  code: "INVALID_DELIVERY_CONFIG",
  details: { field: "delivery", operation: "update --config" },
};

describe("update --config refuses a config document that omits the delivery decision", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  async function newRepository(): Promise<TestRepository> {
    const repository = await createTestRepository();
    repositories.push(repository);
    return repository;
  }

  async function writeCandidate(repository: TestRepository, config: PoiesisConfig): Promise<string> {
    const path = join(repository.parent, "candidate-config.jsonc");
    await writeFile(path, serializeConfig(config));
    return path;
  }

  it("refuses a DEFERRED install before any default resolution, probe, journal, or write", async () => {
    // Break: resolving the omission here would write the three generated
    // command targets into a config that deliberately recorded `"mode":
    // "deferred"`, and would do it through a transaction that generates no
    // script for any of the three names it just recorded.
    const repository = await newRepository();
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const candidatePath = await writeCandidate(repository, configWithoutDelivery(repository));
    const before = await snapshotPreservedState(repository);
    const mark = markSubprocesses();
    let journalEntries = -1;

    await expect(
      runUpdateConfigTransaction(repository.root, candidatePath, {}, {
        onJournalReady: (entries) => {
          journalEntries = entries.length;
        },
      }),
    ).rejects.toMatchObject(EXPECTED_REFUSAL);

    const callsSinceMark = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls.slice(mark);
    expect(reachedProbesOrSideEffects(callsSinceMark), "the refused transaction probed or changed something").toEqual([]);
    for (const call of subprocessCallsSince(mark)) {
      expect([...READ_ONLY_RECEIPT_LOCATORS], `unexpected subprocess after the refusal: ${call}`).toContain(call);
    }
    expect(journalEntries, "the transaction journal was built").toBe(-1);
    expectPreserved(before, await snapshotPreservedState(repository));
    // The recorded decision is the installer's, and the refusal leaves it
    // exactly where it was: still deferred, still un-published.
    expect((await readInstalledConfig(repository)).delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });
  }, 60_000);

  it("refuses a CONFIGURED install's omission without touching its delivery scripts", async () => {
    // Break: the same default would overwrite three real Author commands with
    // the generated target names, and a rejected transaction that also
    // rewrote a delivery script would be a second, unjournalled writer.
    const repository = await newRepository();
    await writeAuthorDeliveryScripts(repository);
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: commandDelivery() },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const candidatePath = await writeCandidate(repository, configWithoutDelivery(repository));
    const before = await snapshotPreservedState(repository);
    const mark = markSubprocesses();
    let journalEntries = -1;

    await expect(
      runUpdateConfigTransaction(repository.root, candidatePath, {}, {
        onJournalReady: (entries) => {
          journalEntries = entries.length;
        },
      }),
    ).rejects.toMatchObject(EXPECTED_REFUSAL);

    const callsSinceMark = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls.slice(mark);
    expect(reachedProbesOrSideEffects(callsSinceMark), "the refused transaction probed or changed something").toEqual([]);
    for (const call of subprocessCallsSince(mark)) {
      expect([...READ_ONLY_RECEIPT_LOCATORS], `unexpected subprocess after the refusal: ${call}`).toContain(call);
    }
    expect(journalEntries, "the transaction journal was built").toBe(-1);
    expectPreserved(before, await snapshotPreservedState(repository));
    expect((await readInstalledConfig(repository)).delivery).toEqual(commandDelivery());
  }, 60_000);

  it("refuses the same omission through the public updateFromConfig surface", async () => {
    // The refusal is a property of the transaction, not of the internal test
    // seam, so the exported entry point reports the same code and the same
    // details to a CLI or library caller.
    const repository = await newRepository();
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const candidatePath = await writeCandidate(repository, configWithoutDelivery(repository));

    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject(EXPECTED_REFUSAL);
  }, 60_000);

  it("still refuses a malformed `delivery: null` as an invalid config, not by the new rule", async () => {
    // The contextual rule is about an ABSENT property. A stated value that is
    // not a delivery block is a malformed document, and it keeps the schema's
    // own `INVALID_CONFIG` verdict: widening the contextual rule to cover
    // malformed values would be a schema change wearing this ticket's name.
    const repository = await newRepository();
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const before = await snapshotPreservedState(repository);
    const candidatePath = await writeCandidate(repository, {
      ...configWithoutDelivery(repository),
      delivery: null as unknown as PoiesisConfig["delivery"],
    });

    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    expectPreserved(before, await snapshotPreservedState(repository));
  }, 60_000);

  it("still accepts a document that states the deferred mode and one that states the three targets", async () => {
    // The refusal is not a locked door: an explicit decision is accepted in
    // both shapes, so the documented way out of a deferred install keeps
    // working through this very command.
    const repository = await newRepository();
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    await writeAuthorDeliveryScripts(repository);

    const deferredResult = await updateFromConfig(
      repository.root,
      await writeCandidate(repository, { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } }),
    );
    expect(deferredResult.doctor.checks.find((check) => check.id === "delivery")?.status).toBe("warn");
    expect((await readInstalledConfig(repository)).delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });

    const configuredResult = await updateFromConfig(
      repository.root,
      await writeCandidate(repository, { ...configWithoutDelivery(repository), delivery: commandDelivery() }),
    );
    expect(configuredResult.doctor.checks.find((check) => check.id === "delivery")?.status).toBe("pass");
    expect((await readInstalledConfig(repository)).delivery).toEqual(commandDelivery());
  }, 90_000);
});

describe("init keeps treating an omitted delivery block as a fresh-install default", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("resolves the omission to the three generated targets and writes their scripts", async () => {
    // This is the legacy half of the distinction and it must not move: a
    // noninteractive `init --config` that omits delivery still completes the
    // project with real, runnable targets and real files.
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, configWithoutDelivery(repository), { skipSkills: true, allowFixtureAdapters: true });

    const installed = await readInstalledConfig(repository);
    expect(installed.delivery).toMatchObject({
      preview: { command: expect.arrayContaining([deliveryScriptPath("preview")]) },
      staging: { command: expect.arrayContaining([deliveryScriptPath("staging")]) },
      production: { command: expect.arrayContaining([deliveryScriptPath("production")]) },
    });
    expect(JSON.stringify(installed.delivery)).not.toContain(DEFERRED_DELIVERY_MODE);
    for (const target of DELIVERY_TARGETS) {
      await expect(readFile(join(repository.root, deliveryScriptPath(target)), "utf8")).resolves.toContain("#!/usr/bin/env node");
    }
  }, 60_000);

  it("accepts an explicit deferred block and an explicit three-target block unchanged", async () => {
    // The two shapes `init` is offered are both valid input, so the
    // contextual `update --config` rule cannot be read as a schema change
    // that tightened the shared parser.
    const deferredRepository = await createTestRepository();
    repositories.push(deferredRepository);
    await init(
      deferredRepository.root,
      { ...configWithoutDelivery(deferredRepository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    expect((await readInstalledConfig(deferredRepository)).delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });
    expect(existsSync(join(deferredRepository.root, "scripts"))).toBe(false);

    const configuredRepository = await createTestRepository();
    repositories.push(configuredRepository);
    await init(
      configuredRepository.root,
      { ...configWithoutDelivery(configuredRepository), delivery: commandDelivery() },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    expect((await readInstalledConfig(configuredRepository)).delivery).toEqual(commandDelivery());
  }, 90_000);
});

describe("a model update round-trips the installed resolved delivery block", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("keeps a deferred install deferred across `model set`", async () => {
    // `setModel` is a thin wrapper over `update --config`, and it proposes the
    // installed config with one model field changed. If the wrapper dropped
    // the `delivery` block while rebuilding the candidate, the contextual
    // rule would have to special-case it — and if it kept the omission
    // instead, a deferred install would silently become configured here.
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );

    const result = await setModel(repository.root, "execution", "minimax/MiniMax-M3-alt");

    expect(result.restart.started).toBe(false);
    const installed = await readInstalledConfig(repository);
    expect(installed.models.execution).toBe("minimax/MiniMax-M3-alt");
    expect(installed.delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });
    expect(result.doctor.checks.find((check) => check.id === "delivery")?.status).toBe("warn");
  }, 60_000);

  it("keeps a configured install's three targets across `model set`", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeAuthorDeliveryScripts(repository);
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: commandDelivery() },
      { skipSkills: true, allowFixtureAdapters: true },
    );

    await setModel(repository.root, "reasoning", "openai/gpt-5.6-fallback");

    const installed = await readInstalledConfig(repository);
    expect(installed.models.reasoning).toBe("openai/gpt-5.6-fallback");
    expect(installed.delivery).toEqual(commandDelivery());
    for (const target of DELIVERY_TARGETS) {
      const script = await readFile(join(repository.root, deliveryScriptPath(target)), "utf8");
      expect(script).toContain(`// author script for ${target}`);
    }
  }, 60_000);
});

describe("the delivery decision stays outside every other managed surface", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("leaves an unrelated managed change alone when the document omits delivery", async () => {
    // The refusal is about the ANSWER to the delivery question, not about
    // whether anything else changed: a document that also moves the model is
    // refused for exactly the same reason and with exactly the same details,
    // because resolving its omission is the only thing the transaction would
    // have done differently.
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const before = await snapshotPreservedState(repository);
    const candidatePath = join(repository.parent, "candidate-config.jsonc");
    await writeFile(
      candidatePath,
      serializeConfig({ ...configWithoutDelivery(repository), models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3-alt" } }),
    );

    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject(EXPECTED_REFUSAL);

    expectPreserved(before, await snapshotPreservedState(repository));
    expect((await readInstalledConfig(repository)).models.execution).toBe("minimax/MiniMax-M3");
  }, 60_000);

  it("still reports a partial delivery block as a partial block, not as an omission", async () => {
    // One code, three distinct reported shapes. A document that states only
    // some of the three targets names the MISSING ones; a document that states
    // nothing at all names the absent field and the operation. Collapsing them
    // would tell an Author their block is incomplete when the honest answer is
    // that they never answered.
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const candidatePath = join(repository.parent, "partial-config.jsonc");
    await writeFile(
      candidatePath,
      serializeConfig({
        ...configWithoutDelivery(repository),
        delivery: {
          preview: { adapter: "command", command: ["node", "scripts/poiesis-preview.mjs", "{sha}"] },
          staging: { adapter: "command", command: ["node", "scripts/poiesis-staging.mjs", "{sha}"] },
        } as unknown as PoiesisConfig["delivery"],
      }),
    );

    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject({
      code: "INVALID_DELIVERY_CONFIG",
      details: { missing: ["production"] },
    });
  }, 60_000);

  it("generates no delivery script for a rejected document, and the scripts directory stays as it was", async () => {
    // A transaction that refuses must not have written the very files the
    // generated default names. On a deferred install there is no scripts
    // directory at all, and the refusal leaves it that way.
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      { ...configWithoutDelivery(repository), delivery: { mode: DEFERRED_DELIVERY_MODE } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const candidatePath = join(repository.parent, "candidate-config.jsonc");
    await writeFile(candidatePath, serializeConfig(configWithoutDelivery(repository)));

    await expect(updateFromConfig(repository.root, candidatePath)).rejects.toMatchObject(EXPECTED_REFUSAL);

    expect(existsSync(join(repository.root, "scripts"))).toBe(false);
    await expect(readdir(repository.root)).resolves.not.toContain("scripts");
  }, 60_000);
});

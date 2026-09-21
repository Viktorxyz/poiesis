/**
 * Ticket #56 — deterministic `poiesis model set reasoning|execution <id>`.
 *
 * Follows the `update-config.test.ts` prior art: every assertion
 * snapshots owned bytes (Poiesis config, OpenCode config, manifest,
 * ownership receipt) before the transaction and re-reads them after
 * to prove the transaction either advanced exactly the intended
 * fields or left the repository byte-for-byte intact.
 *
 * The test seam is the same `installFakeOpenCode` fake used by
 * `update-config.test.ts` so a custom `modelList` drives the
 * `MODEL_UNAVAILABLE` rejection deterministically (ticket 48
 * semantics: "no substitute").
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  init,
  setModel,
  type ModelClassName,
} from "../src/maintenance.js";
import { commandModel } from "../src/cli.js";
import { desiredOpenCodePatches } from "../src/opencode.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import {
  ownershipReceiptLocation,
  readOwnershipReceipt,
} from "../src/receipt.js";
import { hashContent } from "../src/hash.js";
import { parseJsonc, serializeConfig, type PoiesisConfig } from "../src/config.js";
import type { DoctorReport } from "../src/maintenance.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const CONFIG_ROOT = ".poiesis/config.jsonc";

async function install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

async function readPoiesisConfig(repository: TestRepository): Promise<PoiesisConfig> {
  return parseJsonc<PoiesisConfig>(
    await readFile(join(repository.root, CONFIG_ROOT), "utf8"),
    join(repository.root, CONFIG_ROOT),
  );
}

async function readOpenCodeJson(repository: TestRepository): Promise<Record<string, unknown>> {
  return parseJsonc<Record<string, unknown>>(
    await readFile(join(repository.root, "opencode.jsonc"), "utf8"),
    join(repository.root, "opencode.jsonc"),
  );
}

interface OwnedByteSnapshot {
  poiesisConfig: Buffer;
  openCodeConfig: Buffer;
  manifest: Buffer;
  receipt: Buffer;
  receiptGeneration: number;
  receiptManifestDigest: string;
}

async function snapshotOwnedBytes(repository: TestRepository): Promise<OwnedByteSnapshot> {
  const receiptPath = await ownershipReceiptLocation(repository.root);
  const receipt = await readOwnershipReceipt(repository.root);
  return {
    poiesisConfig: await readFile(join(repository.root, CONFIG_ROOT)),
    openCodeConfig: await readFile(join(repository.root, "opencode.jsonc")),
    manifest: await readFile(join(repository.root, ".poiesis", "manifest.json")),
    receipt: await readFile(receiptPath),
    receiptGeneration: receipt.generation,
    receiptManifestDigest: receipt.manifestDigest,
  };
}

function expectOwnedBytesUnchanged(
  before: OwnedByteSnapshot,
  after: OwnedByteSnapshot,
  scope: string,
): void {
  expect(Buffer.compare(after.poiesisConfig, before.poiesisConfig), `${scope}: poiesis config bytes changed`).toBe(0);
  expect(Buffer.compare(after.openCodeConfig, before.openCodeConfig), `${scope}: opencode config bytes changed`).toBe(0);
  expect(Buffer.compare(after.manifest, before.manifest), `${scope}: manifest bytes changed`).toBe(0);
  expect(Buffer.compare(after.receipt, before.receipt), `${scope}: receipt bytes changed`).toBe(0);
  expect(after.receiptGeneration, `${scope}: receipt generation advanced`).toBe(before.receiptGeneration);
  expect(after.receiptManifestDigest, `${scope}: receipt manifestDigest changed`).toBe(before.receiptManifestDigest);
}

function expectTransactionChecksPass(report: DoctorReport): void {
  // The `skills` check is intentionally excluded: tests use
  // `skipSkills: true` (no Poiesis-managed default skills), so doctor
  // reports `skills: fail` even though the transaction is healthy.
  // `updateFromConfig`'s internal doctor gate already ignores that
  // exact case via `assertUpdateConfigDoctorGate`; the wrapper
  // surfaces the same gate, so a passing transaction is sufficient
  // evidence that every other check is healthy.
  for (const id of [
    "config",
    "manifest",
    "receipt",
    "hashes",
    "opencode-version",
    "models",
    "opencode-config",
    "opencode-schema",
    "git",
    "git-remote",
    "git-base",
  ]) {
    expect(report.checks.find((check: { id: string; status: string }) => check.id === id)?.status, `expected ${id} check to pass`).toBe("pass");
  }
}

describe("setModel (ticket #56)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("changes the reasoning class to a known-available identity and preserves the execution class", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeConfig = await readPoiesisConfig(repository);
    const beforeReceipt = await readOwnershipReceipt(repository.root);

    // `openai/gpt-5.6-fallback` is in the fake `opencode models` list
    // but is NOT the current reasoning identity (`openai/gpt-5.6-sol`),
    // so this is a real transaction (not a no-op) and the receipt
    // generation must advance exactly once.
    const result = await setModel(repository.root, "reasoning", "openai/gpt-5.6-fallback");

    const afterConfig = await readPoiesisConfig(repository);
    expect(afterConfig.models.reasoning).toBe("openai/gpt-5.6-fallback");
    // The other class is preserved byte-for-byte.
    expect(afterConfig.models.execution).toBe(beforeConfig.models.execution);
    // Unrelated config is preserved.
    expect(afterConfig.tracker.provider).toBe(beforeConfig.tracker.provider);
    expect(afterConfig.delivery.preview.adapter).toBe(beforeConfig.delivery.preview.adapter);
    expect(afterConfig.verification?.commands).toEqual(beforeConfig.verification?.commands);

    // The OpenCode projection reflects the new reasoning model.
    const openCode = await readOpenCodeJson(repository);
    expect((openCode.agent as Record<string, Record<string, unknown>>)?.poiesis?.model).toBe("openai/gpt-5.6-fallback");
    const desired = desiredOpenCodePatches(afterConfig, "1.1.2");
    for (const patch of desired) {
      const top = openCode[patch.path[0]!];
      if (patch.path.length === 1) expect(top).toEqual(patch.value);
    }

    // Receipt generation advanced exactly once.
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeReceipt.generation + 1);
    expect(afterReceipt.installationId).toBe(beforeReceipt.installationId);
    expect(afterReceipt.manifestDigest).not.toBe(beforeReceipt.manifestDigest);
    expect(afterReceipt.manifestDigest).toBe(hashContent(serializeManifest(result.manifest)));

    // The manifest records the new Poiesis config hash.
    const manifest = await loadManifest(repository.root);
    const recorded = manifest.files.find((file) => file.path === CONFIG_ROOT);
    expect(recorded?.hash).toBe(hashContent(await readFile(join(repository.root, CONFIG_ROOT))));

    // Result carries a restart notice but does NOT restart OpenCode.
    expect(result.restart.notice).toMatch(/restart/i);
    expect(result.restart.started).toBe(false);

    expectTransactionChecksPass(result.doctor);
  }, 30_000);

  it("changes the execution class and preserves the reasoning class", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeConfig = await readPoiesisConfig(repository);

    const result = await setModel(repository.root, "execution", "minimax/MiniMax-M3-alt");

    const afterConfig = await readPoiesisConfig(repository);
    expect(afterConfig.models.execution).toBe("minimax/MiniMax-M3-alt");
    expect(afterConfig.models.reasoning).toBe(beforeConfig.models.reasoning);

    const openCode = await readOpenCodeJson(repository);
    // Execution routes through `agent.explore.model`.
    expect((openCode.agent as Record<string, Record<string, unknown>>)?.explore?.model).toBe("minimax/MiniMax-M3-alt");

    expectTransactionChecksPass(result.doctor);
  }, 30_000);

  it("preserves every owned byte when the proposed model is a no-op", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    // reasoning is already "openai/gpt-5.6-sol" from testConfig().
    const result = await setModel(repository.root, "reasoning", "openai/gpt-5.6-sol");

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "no-op");
    // Doctor still passes against the unchanged state.
    expect(result.doctor.checks.find((check) => check.id === "manifest")?.status).toBe("pass");
    expect(result.doctor.checks.find((check) => check.id === "receipt")?.status).toBe("pass");
  }, 30_000);

  it("rejects with MODEL_UNAVAILABLE before any write when the requested ID is not in the OpenCode inventory", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    const prevModels = process.env.POIESIS_TEST_OPENCODE_MODELS;
    // Limit the inventory so the requested identity is provably absent.
    process.env.POIESIS_TEST_OPENCODE_MODELS = "openai/gpt-5.6-sol\nminimax/MiniMax-M3\n";
    try {
      await expect(
        setModel(repository.root, "execution", "minimax/MiniMax-M3-alt"),
      ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE", details: { missing: ["minimax/MiniMax-M3-alt"] } });
    } finally {
      if (prevModels === undefined) delete process.env.POIESIS_TEST_OPENCODE_MODELS;
      else process.env.POIESIS_TEST_OPENCODE_MODELS = prevModels;
    }

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "MODEL_UNAVAILABLE");
  }, 30_000);

  it("rejects with MODEL_INVENTORY_UNAVAILABLE before any write when OpenCode cannot list models", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    // Override the fake `opencode models` invocation to fail. Restore the
    // default healthy fake afterwards so subsequent tests get a fresh state.
    env?.restore();
    env = await installFakeOpenCode({
      // Empty model list simulates an OpenCode installation that cannot
      // serve the inventory probe; `verifyModels` surfaces this as
      // MODEL_INVENTORY_UNAVAILABLE inside the transaction, but we want
      // to exercise the same code from `setModel` (which calls the same
      // helper directly). Force a non-zero exit via a stub `modelList`
      // empty + doctor gate — but for this test the simpler deterministic
      // path is to make the fake exit non-zero via `POIESIS_TEST_OPENCODE_FAIL`.
    });
    const prevFail = process.env.POIESIS_TEST_OPENCODE_FAIL;
    process.env.POIESIS_TEST_OPENCODE_FAIL = "1";
    try {
      await expect(
        setModel(repository.root, "reasoning", "openai/gpt-5.6-sol"),
      ).rejects.toMatchObject({ code: "MODEL_INVENTORY_UNAVAILABLE" });
    } finally {
      if (prevFail === undefined) delete process.env.POIESIS_TEST_OPENCODE_FAIL;
      else process.env.POIESIS_TEST_OPENCODE_FAIL = prevFail;
      env?.restore();
      env = await installFakeOpenCode();
    }

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "MODEL_INVENTORY_UNAVAILABLE");
  }, 30_000);

  it("rejects an unknown model class before any write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      // Cast is intentional: the production type does not include this
      // value; we want the runtime to refuse it.
      setModel(repository.root, "planner" as unknown as ModelClassName, "openai/gpt-5.6-sol"),
    ).rejects.toMatchObject({ code: "INVALID_MODEL_CLASS" });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "INVALID_MODEL_CLASS");
  }, 30_000);

  it("preserves every owned byte when the post-write doctor gate fails (fail-closed rollback)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    // Reinstall the fake with a fail-after-threshold so the
    // preflight schema call (count #1 against the stateful fake,
    // threshold=1, 1>1? no → success) passes and the doctor gate
    // schema call (count #2, 2>1? yes → fail) trips the rollback.
    // Mirrors the existing update-config.test.ts pattern.
    env?.restore();
    const counterDir = await mkdtemp(join(tmpdir(), "poiesis-model-set-counter-"));
    const counterFile = join(counterDir, "count");
    env = await installFakeOpenCode({ failAfterDebugCalls: { file: counterFile, threshold: 1 } });
    try {
      await expect(
        setModel(repository.root, "execution", "minimax/MiniMax-M3-alt"),
      ).rejects.toMatchObject({ code: "UPDATE_DOCTOR_FAILED" });
    } finally {
      env?.restore();
      env = await installFakeOpenCode();
    }

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "doctor gate failure");
  }, 30_000);
});

describe("commandModel (CLI)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("dispatches `poiesis model set reasoning <id>` to setModel and returns structured JSON", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await commandModel(["set", "reasoning", "openai/gpt-5.6-sol", "--cwd", repository.root]);
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(captured.join("")) as {
      ok: boolean;
      operation: string;
      result: {
        manifest: unknown;
        doctor: {
          checks: Array<{ id: string; status: string }>;
        };
        restart: { notice: string; started: boolean };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("model.set");
    // Doctor checks that are owned by `update --config` must all pass.
    // The `skills` check is intentionally excluded: tests use
    // `skipSkills: true` (no Poiesis-managed default skills), so doctor
    // reports `skills: fail` even though the transaction is healthy.
    for (const id of [
      "config",
      "manifest",
      "receipt",
      "hashes",
      "opencode-version",
      "models",
      "opencode-config",
      "opencode-schema",
      "git",
      "git-remote",
      "git-base",
    ]) {
      expect(
        payload.result.doctor.checks.find((check: { id: string; status: string }) => check.id === id)?.status,
        `expected ${id} check to pass`,
      ).toBe("pass");
    }
    expect(payload.result.restart.started).toBe(false);
    expect(payload.result.restart.notice).toMatch(/restart/i);
  }, 30_000);

  it("fails closed when bare `poiesis model` is invoked in a non-TTY environment (interactive flow arrives in ticket #59)", async () => {
    // Under Vitest `process.stdin.isTTY` is undefined → the production
    // IO factory reports `isTTY: false` → the interactive flow refuses
    // with `NON_TTY_MODEL` and the hint points at the deterministic
    // subcommand. The ticket #59 TTY happy path is covered by
    // `tests/model-interactive.test.ts`.
    await expect(commandModel([])).rejects.toMatchObject({
      code: "NON_TTY_MODEL",
      details: expect.objectContaining({
        hint: expect.stringContaining("poiesis model set reasoning|execution"),
      }),
    });
  });

  it("rejects an unknown model subcommand", async () => {
    await expect(commandModel(["list"])).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
  });

  it("rejects `poiesis model set` with an unknown model class", async () => {
    await expect(commandModel(["set", "planner", "openai/gpt-5.6-sol"])).rejects.toMatchObject({
      code: "INVALID_MODEL_CLASS",
    });
  });

  it("rejects `poiesis model set` when the model ID is missing", async () => {
    await expect(commandModel(["set", "reasoning"])).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("rejects `poiesis model set` when the model ID is not provider/model", async () => {
    await expect(commandModel(["set", "reasoning", "no-slash"])).rejects.toMatchObject({ code: "INVALID_MODEL_ID" });
  });

  // -----------------------------------------------------------------
  // Ticket #79 — strict parsing for `poiesis model` forms.
  //
  // The previous `splitCwdArgs` recognized only `--cwd <path>` (space
  // form) and silently dropped everything it did not match. That
  // meant `--cwd=/target`, missing values, duplicate `--cwd`,
  // unknown flags, and extra positionals could all be silently
  // ignored — mutating the launcher repo or skipping validation.
  //
  // Ticket #79 reuses the generic `parseArgs` parser in strict mode
  // so `--cwd <path>` and `--cwd=<path>` both work, missing values
  // fail closed, unknown flags fail closed, duplicate `--cwd`
  // fails closed, and extra positionals fail closed BEFORE any
  // inventory/mutation runs. The structured-JSON surface,
  // typed class/id validation, transactions/doctor, and the
  // flagless interactive behavior are preserved.
  // -----------------------------------------------------------------
  it("accepts the equals form `--cwd=<path>` for `poiesis model set` and routes to the target repo", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeConfig = await readPoiesisConfig(repository);

    await commandModel(["set", "execution", "minimax/MiniMax-M3-alt", `--cwd=${repository.root}`]);

    const afterConfig = await readPoiesisConfig(repository);
    expect(afterConfig.models.execution).toBe("minimax/MiniMax-M3-alt");
    expect(afterConfig.models.reasoning).toBe(beforeConfig.models.reasoning);
  }, 30_000);

  it("rejects `poiesis model set --cwd` with no value before any write (ticket #79: missing value)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      commandModel(["set", "reasoning", "openai/gpt-5.6-fallback", "--cwd"]),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT", details: { key: "cwd" } });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "missing --cwd value");
  }, 30_000);

  it("rejects `poiesis model set --cwd=` (empty value) before any write (ticket #79: missing value)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      commandModel(["set", "reasoning", "openai/gpt-5.6-fallback", "--cwd="]),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT", details: { key: "cwd" } });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "empty --cwd value");
  }, 30_000);

  it("rejects duplicate `--cwd` flags before any write (ticket #79: duplicate cwd)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      commandModel([
        "set",
        "reasoning",
        "openai/gpt-5.6-fallback",
        "--cwd",
        repository.root,
        "--cwd",
        repository.root,
      ]),
    ).rejects.toMatchObject({ code: "DUPLICATE_ARGUMENT", details: { key: "cwd" } });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "duplicate --cwd");
  }, 30_000);

  it("rejects unknown flags before any write (ticket #79: unknown flag)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      commandModel(["set", "reasoning", "openai/gpt-5.6-fallback", "--unknown-flag"]),
    ).rejects.toMatchObject({ code: "UNKNOWN_OPTION" });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "unknown flag");
  }, 30_000);

  it("rejects extra positional after `set <class> <id>` before any write (ticket #79: extra positional)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await install(repository);
    const beforeBytes = await snapshotOwnedBytes(repository);

    await expect(
      commandModel([
        "set",
        "reasoning",
        "openai/gpt-5.6-fallback",
        "extra-positional",
      ]),
    ).rejects.toMatchObject({ code: "UNKNOWN_ARGUMENT" });

    const afterBytes = await snapshotOwnedBytes(repository);
    expectOwnedBytesUnchanged(beforeBytes, afterBytes, "extra positional");
  }, 30_000);
});

describe("commandModel launcher/target routing (ticket #79)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  // Helper: snapshot the launcher repo's owned-byte surface (it has
  // no Poiesis install at the start; we assert the install is never
  // created by a stray --cwd misuse).
  async function launcherOwnedSurface(launcher: TestRepository): Promise<{
    poiesisConfigExists: boolean;
    manifestExists: boolean;
    receiptExists: boolean;
  }> {
    return {
      poiesisConfigExists: existsSync(join(launcher.root, CONFIG_ROOT)),
      manifestExists: existsSync(join(launcher.root, ".poiesis", "manifest.json")),
      receiptExists: existsSync(await ownershipReceiptLocation(launcher.root)),
    };
  }

  it("`poiesis model set --cwd <target>` mutates the target repo and leaves the launcher repo untouched", async () => {
    // Launcher is a plain Git repo with no Poiesis install. Target is
    // an installed Poiesis repo. The dispatcher runs from inside the
    // launcher repo and MUST route the write to the target via
    // --cwd, not to the launcher's `process.cwd()`.
    const launcher = await createTestRepository();
    const target = await createTestRepository();
    repositories.push(launcher, target);
    await install(target);
    const targetBefore = await snapshotOwnedBytes(target);

    const savedCwd = process.cwd();
    process.chdir(launcher.root);
    try {
      await commandModel([
        "set",
        "execution",
        "minimax/MiniMax-M3-alt",
        "--cwd",
        target.root,
      ]);
    } finally {
      process.chdir(savedCwd);
    }

    // Target mutated.
    const targetConfig = await readPoiesisConfig(target);
    expect(targetConfig.models.execution).toBe("minimax/MiniMax-M3-alt");
    const targetAfter = await snapshotOwnedBytes(target);
    expect(Buffer.compare(targetAfter.poiesisConfig, targetBefore.poiesisConfig)).not.toBe(0);

    // Launcher untouched: no `.poiesis/` tree created.
    const launcherAfter = await launcherOwnedSurface(launcher);
    expect(launcherAfter.poiesisConfigExists).toBe(false);
    expect(launcherAfter.manifestExists).toBe(false);
    expect(launcherAfter.receiptExists).toBe(false);
  }, 30_000);

  it("`poiesis model set --cwd=<target>` (equals form) mutates the target repo and leaves the launcher repo untouched", async () => {
    const launcher = await createTestRepository();
    const target = await createTestRepository();
    repositories.push(launcher, target);
    await install(target);

    const savedCwd = process.cwd();
    process.chdir(launcher.root);
    try {
      await commandModel([
        "set",
        "execution",
        "minimax/MiniMax-M3-alt",
        `--cwd=${target.root}`,
      ]);
    } finally {
      process.chdir(savedCwd);
    }

    const targetConfig = await readPoiesisConfig(target);
    expect(targetConfig.models.execution).toBe("minimax/MiniMax-M3-alt");

    const launcherAfter = await launcherOwnedSurface(launcher);
    expect(launcherAfter.poiesisConfigExists).toBe(false);
    expect(launcherAfter.manifestExists).toBe(false);
    expect(launcherAfter.receiptExists).toBe(false);
  }, 30_000);

  it("invalid `--cwd` / unknown-flag / extra-positional forms mutate neither launcher nor target (ticket #79: fail-closed)", async () => {
    const launcher = await createTestRepository();
    const target = await createTestRepository();
    repositories.push(launcher, target);
    await install(target);
    const targetBefore = await snapshotOwnedBytes(target);

    const savedCwd = process.cwd();
    process.chdir(launcher.root);
    try {
      // Missing value.
      await expect(
        commandModel(["set", "execution", "minimax/MiniMax-M3-alt", "--cwd"]),
      ).rejects.toMatchObject({ code: "MISSING_ARGUMENT", details: { key: "cwd" } });

      // Duplicate --cwd.
      await expect(
        commandModel([
          "set",
          "execution",
          "minimax/MiniMax-M3-alt",
          "--cwd",
          target.root,
          "--cwd",
          target.root,
        ]),
      ).rejects.toMatchObject({ code: "DUPLICATE_ARGUMENT", details: { key: "cwd" } });

      // Unknown flag.
      await expect(
        commandModel(["set", "execution", "minimax/MiniMax-M3-alt", "--bogus"]),
      ).rejects.toMatchObject({ code: "UNKNOWN_OPTION" });

      // Extra positional.
      await expect(
        commandModel([
          "set",
          "execution",
          "minimax/MiniMax-M3-alt",
          "extra-positional",
        ]),
      ).rejects.toMatchObject({ code: "UNKNOWN_ARGUMENT" });

      // Bare interactive dispatch with unknown flag.
      await expect(commandModel(["--bogus"])).rejects.toMatchObject({ code: "UNKNOWN_OPTION" });

      // Bare interactive dispatch with duplicate --cwd.
      await expect(
        commandModel(["--cwd", target.root, "--cwd", target.root]),
      ).rejects.toMatchObject({ code: "DUPLICATE_ARGUMENT", details: { key: "cwd" } });

      // Bare interactive dispatch with missing --cwd value.
      await expect(commandModel(["--cwd"])).rejects.toMatchObject({
        code: "MISSING_ARGUMENT",
        details: { key: "cwd" },
      });
    } finally {
      process.chdir(savedCwd);
    }

    // Target NOT mutated.
    const targetAfter = await snapshotOwnedBytes(target);
    expectOwnedBytesUnchanged(targetBefore, targetAfter, "invalid forms");

    // Launcher NOT mutated.
    const launcherAfter = await launcherOwnedSurface(launcher);
    expect(launcherAfter.poiesisConfigExists).toBe(false);
    expect(launcherAfter.manifestExists).toBe(false);
    expect(launcherAfter.receiptExists).toBe(false);
  }, 60_000);
});

/**
 * Ticket #58 — Flagless interactive `poiesis init`.
 *
 * Acceptance contract:
 *   - Flagless init on a TTY discovers, prints detections on stderr, prompts
 *     only the remaining Author-owned choices (models via shared selector,
 *     ambiguous remote, real delivery command argv with `{sha}`), then calls
 *     existing `init(root, config)` with a fully resolved config.
 *   - Non-TTY init without `--config` fails closed with an actionable
 *     `NON_TTY_INIT` error.
 *   - An existing `.poiesis/` (Poiesis already installed) refuses BEFORE the
 *     model selectors run (`INSTALL_PATH_CONFLICT`).
 *   - Auth failures include `gh auth login` / `glab auth login` and never
 *     block on `wait-for-enter`.
 *   - Delivery questions are real command argv with `{sha}` — never
 *     hosting-adapter IDs.
 *   - After success, the Author is told to restart OpenCode; Poiesis does
 *     not restart OpenCode.
 *
 * Test-only IO seam: every test injects an `InteractiveInitIO` so no real
 * PTY, no real `gh`/`glab`/`opencode` is required. The CLI command path is
 * covered separately by `tests/cli-bin.test.ts` and `tests/maintenance.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process.js";
import {
  runInteractiveInit,
  type InteractiveInitIO,
  type InteractiveInitOptions,
  type ModelSelection,
} from "../src/init-interactive.js";
import { init } from "../src/maintenance.js";
import type { PoiesisConfig } from "../src/config.js";
import type { Manifest } from "../src/manifest.js";
import { commandInit } from "../src/cli.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

// Ticket #75: the flagless-init CLI dispatch test drives the production
// IO factory's Clack adapter. Under Vitest there is no TTY (no
// `setRawMode` on stdin), so we stub `@clack/prompts` for the duration
// of that test. The scripted-IO tests below this point do NOT need the
// stub because they route through their own `runModelSelector` seam and
// never touch Clack.
vi.mock("@clack/prompts", () => {
  const scope = globalThis as unknown as Record<symbol, {
    select: ReturnType<typeof vi.fn>;
    isCancel: ReturnType<typeof vi.fn>;
    cancelSymbol: symbol;
  }>;
  const key = Symbol.for("poiesis.init-interactive.fake-holder");
  if (scope[key] === undefined) {
    scope[key] = {
      select: vi.fn(),
      isCancel: vi.fn(),
      cancelSymbol: Symbol.for("clack.cancel"),
    };
  }
  const holder = scope[key]!;
  return {
    isCancel: (value: unknown) => holder.isCancel(value),
    select: (opts: unknown) => holder.select(opts),
    CANCEL_SYMBOL: holder.cancelSymbol,
  };
});

const fakeInitHolderKey = Symbol.for("poiesis.init-interactive.fake-holder");
const initFakes = (globalThis as unknown as Record<symbol, {
  select: ReturnType<typeof vi.fn>;
  isCancel: ReturnType<typeof vi.fn>;
  cancelSymbol: symbol;
}>)[fakeInitHolderKey]!;
const initFakeSelect = initFakes.select;
const initFakeIsCancel = initFakes.isCancel;
const initCancelSymbol = initFakes.cancelSymbol;

const repositories: TestRepository[] = [];
let fakeOpenCode: FakeOpenCodeEnvironment | undefined;
let fakeTrackers: { restore: () => void } | undefined;

afterEach(async () => {
  fakeOpenCode?.restore();
  fakeOpenCode = undefined;
  fakeTrackers?.restore();
  fakeTrackers = undefined;
  initFakeSelect.mockReset();
  initFakeIsCancel.mockReset();
  initFakeIsCancel.mockImplementation((value: unknown) => value === initCancelSymbol);
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

/**
 * Minimal hand-rolled IO. The interactive flow writes stderr frames, prompts
 * one-line answers, runs the shared model selector, and probes auth. Every
 * seam is captured so assertions stay precise without depending on a real
 * PTY.
 */
interface ScriptedInitIO extends InteractiveInitIO {
  stderrLines: string[];
  prompts: { prompt: string; answer: string }[];
  modelSelections: ModelSelection[];
  authProbes: { provider: "github" | "gitlab"; command: string }[];
  releaseCalls: number;
}

function scriptedInitIO(options: {
  isTTY?: boolean;
  promptAnswers?: Record<string, string>;
  modelAnswers?: Partial<Record<"reasoning" | "execution", string>>;
  inventory?: readonly string[];
  auth?: { github?: { available: boolean }; gitlab?: { available: boolean } };
}): ScriptedInitIO {
  const stderrLines: string[] = [];
  const prompts: { prompt: string; answer: string }[] = [];
  const modelSelections: ModelSelection[] = [];
  const authProbes: { provider: "github" | "gitlab"; command: string }[] = [];
  const promptAnswers = options.promptAnswers ?? {};
  const modelAnswers = options.modelAnswers ?? {};
  const inventory = options.inventory ?? [];
  const auth = options.auth ?? {};

  return {
    isTTY: options.isTTY ?? true,
    stderrLines,
    prompts,
    modelSelections,
    authProbes,
    releaseCalls: 0,
    writeStderr(line: string): void {
      stderrLines.push(line);
    },
    releaseStdin(): void {
      this.releaseCalls += 1;
    },
    async promptLine(prompt: string): Promise<string> {
      // Match by full prompt string first, then by trailing keyword.
      const exact = promptAnswers[prompt];
      if (exact !== undefined) {
        prompts.push({ prompt, answer: exact });
        return exact;
      }
      const lowered = prompt.toLowerCase();
      for (const [key, value] of Object.entries(promptAnswers)) {
        if (lowered.includes(key.toLowerCase())) {
          prompts.push({ prompt, answer: value });
          return value;
        }
      }
      throw new Error(`scriptedInitIO: no scripted answer for prompt: ${prompt}`);
    },
    async listOpenCodeModels(): Promise<string[]> {
      return [...inventory];
    },
    async runModelSelector(selection: ModelSelection): Promise<string> {
      modelSelections.push(selection);
      const scripted = modelAnswers[selection.modelClass];
      if (scripted !== undefined) return scripted;
      // Default: pick the first available inventory item.
      const first = inventory[0];
      if (first === undefined) {
        throw new Error("scriptedInitIO: empty model inventory");
      }
      return first;
    },
    async probeTrackerAuth(provider: "github" | "gitlab"): Promise<{ available: boolean; stderr?: string; hint?: string }> {
      authProbes.push({ provider, command: provider === "github" ? "gh auth status" : "glab auth status" });
      // Default: tracker auth is reported available. Tests that want to
      // simulate auth failure pass `auth: { github: { available: false } }`.
      const fallback = { available: true };
      if (provider === "github") {
        const config = auth.github ?? fallback;
        return config.available
          ? { available: true }
          : { available: false, stderr: "gh not authenticated", hint: "Run `gh auth login` to authenticate, then re-run poiesis init" };
      }
      const config = auth.gitlab ?? fallback;
      return config.available
        ? { available: true }
        : { available: false, stderr: "glab not authenticated", hint: "Run `glab auth login` to authenticate, then re-run poiesis init" };
    },
  };
}

function baseDraft(): PoiesisConfig {
  // Canonical template form so the composer can prefill delivery hints
  // when `scripts/poiesis-{target}` exists, or surface delivery as
  // unresolved when it does not.
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    tracker: { provider: "github", project: "poiesis-test/init-interactive" },
    delivery: {
      preview: { adapter: "command", command: ["<delivery-executable>", "preview", "{sha}"] },
      staging: { adapter: "command", command: ["<delivery-executable>", "staging", "{sha}"] },
      production: { adapter: "command", command: ["<delivery-executable>", "production", "{sha}"] },
    },
    verification: { commands: ["test -f README.md"] },
  };
}

async function writeDeliveryScripts(root: string): Promise<void> {
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const name of ["poiesis-preview", "poiesis-staging", "poiesis-production"]) {
    const path = join(root, "scripts", name);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
}

/**
 * Install a fake `gh` / `glab` on PATH so init()'s internal verifyTracker
 * pass succeeds without a real GitHub / GitLab CLI. The fake echoes
 * `logged in` for `auth status` and a minimal JSON for `repo view` so
 * the project verification in maintenance.ts::verifyTracker passes.
 */
async function installFakeTrackers(): Promise<{ restore: () => void }> {
  const bin = await mkdtemp(join(tmpdir(), "poiesis-fake-trackers-"));
  const script = join(bin, "gh");
  const body = `#!/bin/sh
case "$1" in
  auth)
    if [ "$2" = "status" ]; then
      printf 'logged in to github.com as fake (oauth)\\n'
      exit 0
    fi
    ;;
  repo)
    if [ "$2" = "view" ]; then
      printf '{"nameWithOwner":"poiesis-test/init-interactive"}\\n'
      exit 0
    fi
    ;;
esac
exit 0
`;
  await writeFile(script, body);
  await chmod(script, 0o755);
  const glabScript = join(bin, "glab");
  const glabBody = `#!/bin/sh
case "$1" in
  auth)
    if [ "$2" = "status" ]; then
      printf 'logged in to gitlab.com as fake\\n'
      exit 0
    fi
    ;;
  api)
    printf '{}'
    exit 0
    ;;
esac
exit 0
`;
  await writeFile(glabScript, glabBody);
  await chmod(glabScript, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath === undefined || previousPath === "" ? bin : `${bin}:${previousPath}`;
  return {
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
}

describe("runInteractiveInit (ticket #58)", () => {
  beforeEach(async () => {
    fakeOpenCode = await installFakeOpenCode();
    fakeTrackers = await installFakeTrackers();
  });

  it("fails closed with NON_TTY_INIT when IO.isTTY is false (no --config supplied)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    const io = scriptedInitIO({ isTTY: false });

    await expect(
      runInteractiveInit({ root: repo.root, io }),
    ).rejects.toMatchObject({ code: "NON_TTY_INIT" });

    // No stderr is written for a non-TTY init — the IO seam never even
    // gets a chance to prompt. (Operators in a non-TTY environment use
    // `--config <path>` instead.)
    expect(io.stderrLines.join("")).toBe("");
    expect(io.prompts).toEqual([]);
    expect(io.modelSelections).toEqual([]);
  });

  it("refuses INSTALL_PATH_CONFLICT when Poiesis is already installed (before any model prompt)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await init(repo.root, testConfig(repo), { skipSkills: true, allowFixtureAdapters: true });

    const io = scriptedInitIO({ isTTY: true });
    await expect(
      runInteractiveInit({ root: repo.root, io }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });

    // The model selector MUST NOT have been called.
    expect(io.modelSelections).toEqual([]);
    expect(io.prompts).toEqual([]);
  });

  it("calls init() with a fully resolved config when scripts/poiesis-{target} hints exist (flagless happy path)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    const io = scriptedInitIO({ isTTY: true });

    const manifest = await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    expect(manifest.poiesisVersion).toMatch(/^\d+\.\d+\.\d+$/);

    // Detections appear on stderr (Git remote, branch, scripts).
    const stderr = io.stderrLines.join("");
    expect(stderr).toContain("origin");
    expect(stderr).toContain("main");
    expect(stderr).toContain("poiesis-preview");

    // No Author prompt was needed because everything was discoverable.
    expect(io.prompts).toEqual([]);
    expect(io.modelSelections).toEqual([]);

    // Restart notice is written to stderr; Poiesis does not restart OpenCode.
    expect(stderr.toLowerCase()).toContain("restart");
    expect(stderr.toLowerCase()).toContain("opencode");

    // Init successfully materialized the Poiesis installation.
    expect((await readFile(join(repo.root, ".poiesis", "config.jsonc"), "utf8"))).toContain("openai/gpt-5.6-sol");
  }, 30_000);

  it("prompts the Author via the shared model selector when both model classes are unresolved", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    const io = scriptedInitIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "openai/gpt-4o", "minimax/MiniMax-M3"],
      modelAnswers: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    });

    // No models in the draft → composer leaves both unresolved.
    const draft: PoiesisConfig = {
      ...baseDraft(),
      models: { reasoning: "", execution: "" },
    };

    const manifest = await runInteractiveInit({ root: repo.root, io, draft });
    expect(manifest).toBeDefined();

    // Both classes were offered to the shared selector.
    expect(io.modelSelections.map((s) => s.modelClass).sort()).toEqual(["execution", "reasoning"]);
    for (const selection of io.modelSelections) {
      expect(selection.inventory).toContain("openai/gpt-5.6-sol");
      expect(selection.inventory).toContain("minimax/MiniMax-M3");
    }

    // The Author choices are written on stderr before/around the prompt.
    const stderr = io.stderrLines.join("");
    expect(stderr.toLowerCase()).toMatch(/model/);
  }, 30_000);

  it("prompts the Author for ambiguous remote (multiple non-origin remotes) BEFORE other choices", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    await run("git", ["remote", "rename", "origin", "upstream"], { cwd: repo.root });
    await run("git", ["remote", "add", "staging", repo.remote], { cwd: repo.root });

    const io = scriptedInitIO({
      isTTY: true,
      promptAnswers: { remote: "upstream" },
    });
    const manifest = await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    expect(manifest).toBeDefined();

    // The Author saw both alternates in the stderr prompt frame.
    const stderr = io.stderrLines.join("");
    expect(stderr).toContain("upstream");
    expect(stderr).toContain("staging");
    // The remote prompt was issued.
    const remotePrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("remote"));
    expect(remotePrompt).toBeDefined();
    expect(remotePrompt?.answer).toBe("upstream");
  }, 30_000);

  it("explains unresolved Preview/Staging/Production in product language BEFORE asking for a command (ticket #64)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    // No scripts/poiesis-* exists → delivery stays unresolved → Author prompted.
    const io = scriptedInitIO({
      isTTY: true,
      promptAnswers: {
        preview: "scripts/run.sh preview {sha}",
        staging: "scripts/run.sh staging {sha}",
        production: "scripts/run.sh production {sha}",
      },
    });
    const manifest = await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    expect(manifest).toBeDefined();

    const stderr = io.stderrLines.join("\n");

    // Each target must surface its own product-language explanation
    // BEFORE the prompt is issued. The wording follows the Spirit of
    // the unresolved Preview message: Poiesis could not determine how
    // this project creates Preview; what this target is for; that no
    // existing Poiesis preview command was found; what we are asking
    // for; and that Poiesis will pass the exact candidate SHA to it.
    expect(stderr).toContain("Poiesis could not determine how this project creates Preview.");
    expect(stderr).toContain("Preview must produce a real candidate you can try before integration.");
    expect(stderr).toContain("No existing Poiesis preview command was found.");
    expect(stderr).toContain("Provide the command this project should use for Preview.");
    expect(stderr).toContain("Poiesis will pass the exact candidate SHA to it.");

    expect(stderr).toContain("Poiesis could not determine how this project deploys to Staging.");
    expect(stderr).toContain("No existing Poiesis staging command was found.");
    expect(stderr).toContain("Provide the command this project should use for Staging.");

    expect(stderr).toContain("Poiesis could not determine how this project releases to Production.");
    expect(stderr).toContain("No existing Poiesis production command was found.");
    expect(stderr).toContain("Provide the command this project should use for Production.");

    // An example command line is shown so the Author can pattern-match.
    expect(stderr).toContain("./scripts/poiesis-preview {sha}");

    // Each target is still prompted exactly once. The prompt itself
    // does NOT lead with raw argv/{sha} jargon. The Author-owned
    // choice stays "command", not "adapter".
    const promptTexts = io.prompts.map((p) => p.prompt);
    const previewPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("preview"));
    const stagingPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("staging"));
    const productionPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("production"));
    expect(previewPrompt).toBeDefined();
    expect(stagingPrompt).toBeDefined();
    expect(productionPrompt).toBeDefined();

    // Old technical wording is gone.
    for (const p of [previewPrompt!, stagingPrompt!, productionPrompt!]) {
      expect(p.prompt).not.toMatch(/argv \(must include \{sha\}\)/);
      expect(p.prompt).not.toMatch(/argv with \{sha\}/);
      // The Author-facing prompt must not surface the word "adapter".
      expect(p.prompt.toLowerCase()).not.toMatch(/\badapter\b/);
    }

    // The prompt itself is product-friendly ("Preview command>" etc.).
    expect(previewPrompt!.prompt).toMatch(/Preview command/i);
    expect(stagingPrompt!.prompt).toMatch(/Staging command/i);
    expect(productionPrompt!.prompt).toMatch(/Production command/i);

    // Forbidden hosting IDs must NEVER appear in prompts.
    expect(promptTexts.join(" ")).not.toMatch(/\b(vercel|netlify|cloudflare|gha|github-actions|pages)\b/);
    // Forbidden hosting IDs must NEVER appear as the Author's answer
    // either — answers are still parsed as shell argv.
    for (const p of [previewPrompt!, stagingPrompt!, productionPrompt!]) {
      expect(p.answer).not.toMatch(/\b(vercel|netlify|cloudflare|gha|github-actions|pages)\b/);
    }
  }, 30_000);

  it("auto-applies scripts/poiesis-{target} hints without an extra Author confirmation (ticket #64)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    // The Author supplied no scripted answers; the composer prefilled
    // each delivery target from the script hint, so no delivery prompt
    // should ever fire.
    const io = scriptedInitIO({ isTTY: true });
    const manifest = await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    expect(manifest).toBeDefined();

    // No delivery prompt was issued.
    const deliveryPrompt = io.prompts.find((p) =>
      /preview|staging|production/i.test(p.prompt),
    );
    expect(deliveryPrompt, "auto-detected script hints must apply silently without a confirm prompt").toBeUndefined();

    // Each target is reported as discovered, not as unresolved.
    const stderr = io.stderrLines.join("\n");
    expect(stderr).toContain("scripts/poiesis-preview");
    expect(stderr).toContain("scripts/poiesis-staging");
    expect(stderr).toContain("scripts/poiesis-production");
  }, 30_000);

  it("still stores argv containing {sha} when the Author supplies a custom command (fail-closed validation, ticket #64)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    // No scripts/poiesis-* exists → Author is prompted. Supply a custom
    // command that omits the {sha} token to verify the validator still
    // rejects and stays fail-closed.
    const io = scriptedInitIO({
      isTTY: true,
      promptAnswers: {
        preview: "scripts/run.sh preview",
        staging: "scripts/run.sh staging {sha}",
        production: "scripts/run.sh production {sha}",
      },
    });
    let caught: unknown;
    try {
      await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    } catch (error) {
      caught = error;
    }
    // The runtime refuses the missing-{sha} answer BEFORE init() runs.
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("INVALID_DELIVERY_ARGV");
    // Auth probe / install must short-circuit before any byte is written.
    expect(io.authProbes).toEqual([]);
  }, 30_000);

  it("still rejects hosting-provider identifiers as custom delivery answers (ticket #64)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    // No scripts/poiesis-* exists → Author is prompted. Supply a
    // hosting-provider identifier to verify the forbidden-adapter
    // guard still fires.
    const io = scriptedInitIO({
      isTTY: true,
      promptAnswers: {
        preview: "vercel {sha}",
        staging: "scripts/run.sh staging {sha}",
        production: "scripts/run.sh production {sha}",
      },
    });
    let caught: unknown;
    try {
      await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("INVALID_DELIVERY_ARGV");
    // Auth probe / install must short-circuit before any byte is written.
    expect(io.authProbes).toEqual([]);
  }, 30_000);

  it("fails closed on GitHub auth unavailability and mentions `gh auth login` in the error", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    const io = scriptedInitIO({
      isTTY: true,
      auth: { github: { available: false } },
    });

    let caught: unknown;
    try {
      await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const code = (caught as { code?: string }).code;
    const message = (caught as { message?: string }).message ?? "";
    expect(code).toBe("TRACKER_AUTH_FAILED");
    expect(message).toContain("gh auth login");
    // NO wait-for-enter: the error must surface immediately and the IO
    // seam never receives a prompt of that shape.
    expect(io.prompts.some((p) => p.prompt.toLowerCase().includes("press enter") || p.prompt.toLowerCase().includes("press return"))).toBe(false);
  });

  it("fails closed on GitLab auth unavailability and mentions `glab auth login` in the error", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    const draft: PoiesisConfig = { ...baseDraft(), tracker: { provider: "gitlab", project: "group/subgroup/repo" } };
    const io = scriptedInitIO({
      isTTY: true,
      auth: { gitlab: { available: false } },
    });

    let caught: unknown;
    try {
      await runInteractiveInit({ root: repo.root, io, draft });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const code = (caught as { code?: string }).code;
    const message = (caught as { message?: string }).message ?? "";
    expect(code).toBe("TRACKER_AUTH_FAILED");
    expect(message).toContain("glab auth login");
  });

  it("discovers tracker provider+project from a github.com remote WITHOUT a draft and never prompts for provider", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    // Point origin at a github.com URL so the composer resolves
    // provider+project from the remote.
    await run("git", ["remote", "set-url", "origin", "https://github.com/poiesis-test/flagless-interactive.git"], { cwd: repo.root });
    // No draft at all — flagless invocation. We still need to script the
    // model selector answers because the composer leaves the models
    // unresolved when no draft is provided.
    const io = scriptedInitIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      modelAnswers: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      promptAnswers: { "verification command": "test -f README.md" },
    });
    // The remote is not actually reachable; `init()` will eventually fail
    // when `verifyGitRepository` runs `git ls-remote` against the github
    // URL. The interesting behavior for this ticket is the prompt log
    // BEFORE init() runs: the composer MUST NOT have asked the Author for
    // the tracker provider or the tracker project. We catch any failure
    // and assert on the prompt log.
    let caught: unknown;
    try {
      await runInteractiveInit({ root: repo.root, io });
    } catch (error) {
      caught = error;
    }
    // The composer must NOT have prompted the Author for the provider,
    // because the github.com URL is enough to infer it uniquely.
    const providerPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("tracker provider"));
    expect(providerPrompt, "no tracker provider prompt is expected when the remote host is github.com").toBeUndefined();

    // The Author's prompt log must not contain "Tracker project" either —
    // the composer must copy the discovered project into the config rather
    // than starting from `tracker: { provider: "github" }` with no project.
    const projectPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("tracker project"));
    expect(projectPrompt, "no tracker project prompt is expected when the project is discovered from the github.com URL").toBeUndefined();

    // The flow reached `init()`, which then failed on the unreachable
    // github URL — that is the expected, documented verification path.
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("GIT_REMOTE_UNAVAILABLE");
  });

  it("discovers tracker provider=gitlab from a gitlab.com remote WITHOUT a draft and never prompts for provider", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    await run("git", ["remote", "set-url", "origin", "https://gitlab.com/poiesis-test/flagless-gitlab-interactive.git"], { cwd: repo.root });
    // No draft at all — flagless invocation.
    const io = scriptedInitIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      modelAnswers: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      promptAnswers: { "verification command": "test -f README.md" },
    });
    let caught: unknown;
    try {
      await runInteractiveInit({ root: repo.root, io });
    } catch (error) {
      caught = error;
    }
    // The composer must NOT have prompted the Author for the provider.
    const providerPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("tracker provider"));
    expect(providerPrompt, "no tracker provider prompt is expected when the remote host is gitlab.com").toBeUndefined();

    // The composer must NOT have prompted the Author for the project either.
    const projectPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("tracker project"));
    expect(projectPrompt, "no tracker project prompt is expected when the project is discovered from the gitlab.com URL").toBeUndefined();

    // The flow reached `init()`, which then failed on the unreachable
    // gitlab URL — that is the expected, documented verification path.
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("GIT_REMOTE_UNAVAILABLE");
  });

  it("still prompts the Author for the tracker provider (and does NOT guess github) when the remote host is unknown", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    // Use a remote URL whose host is unknown to the composer. We point it
    // at the local bare remote shipped with the fixture so `git ls-remote`
    // succeeds; the composer's tracker parser is the only thing that
    // matters here.
    await run("git", ["remote", "set-url", "origin", repo.remote], { cwd: repo.root });
    // No draft at all — flagless invocation.
    const io = scriptedInitIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      modelAnswers: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      promptAnswers: {
        "verification command": "test -f README.md",
        "tracker provider": "github",
        "tracker project": "example/project",
      },
    });
    const manifest = await runInteractiveInit({ root: repo.root, io });
    expect(manifest).toBeDefined();

    // The composer must have prompted for the provider (unknown host).
    const providerPrompt = io.prompts.find((p) => p.prompt.toLowerCase().includes("tracker provider"));
    expect(providerPrompt, "tracker provider prompt is expected when the remote host is unknown").toBeDefined();

    // The prompt must NOT advertise a silent default — unknown hosts must
    // require an explicit github|gitlab answer. Empty Enter MUST fail closed.
    // The previous shape was "Tracker provider [github]" (a default in
    // `[...]`); that bracket-default must NOT be present anymore.
    expect(providerPrompt?.prompt).not.toMatch(/\[github\]/);
    expect(providerPrompt?.prompt).not.toMatch(/\[gitlab\]/);

    // The Author's answer must be carried into the final config.
    const installedConfigRaw = await readFile(join(repo.root, ".poiesis", "config.jsonc"), "utf8");
    expect(installedConfigRaw).toContain("example/project");
  }, 30_000);

  it("fails closed on an empty tracker-provider answer (no silent github default)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    // Remote host is unknown so the composer leaves tracker.provider unresolved.
    await run("git", ["remote", "set-url", "origin", repo.remote], { cwd: repo.root });
    // No draft at all — flagless invocation.
    const io = scriptedInitIO({
      isTTY: true,
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      modelAnswers: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      promptAnswers: {
        "verification command": "test -f README.md",
        // Empty Enter must fail closed; the composer MUST NOT silently
        // default to github.
        "tracker provider": "",
      },
    });
    let caught: unknown;
    try {
      await runInteractiveInit({ root: repo.root, io });
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected INVALID_TRACKER_PROVIDER but the empty answer was accepted").toBeDefined();
    expect((caught as { code?: string }).code).toBe("INVALID_TRACKER_PROVIDER");
    // The init() transaction must NOT have run — auth probe / install must
    // short-circuit before any byte is written.
    expect(io.authProbes).toEqual([]);
    expect(io.prompts.some((p) => p.prompt.toLowerCase().includes("tracker project"))).toBe(false);
  }, 30_000);

it("records the Author's tracker choice without ever restarting OpenCode from the init flow", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    const io = scriptedInitIO({
      isTTY: true,
      auth: { github: { available: true } },
    });

    const manifest = await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    expect(manifest).toBeDefined();
    // The success path writes a restart notice on stderr.
    const stderr = io.stderrLines.join("");
    expect(stderr).toMatch(/restart/i);
    // The notice explicitly says Poiesis did not restart OpenCode.
    expect(stderr.toLowerCase()).toMatch(/poiesis.*did not.*restart|poiesis.*not.*restart/);
  }, 30_000);
});

describe("runInteractiveInit stdin release (ticket #75)", () => {
  beforeEach(async () => {
    fakeOpenCode = await installFakeOpenCode();
    fakeTrackers = await installFakeTrackers();
  });

  it("invokes io.releaseStdin exactly once on the flagless happy path", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    const io = scriptedInitIO({ isTTY: true });

    await runInteractiveInit({ root: repo.root, io, draft: baseDraft() });
    expect(io.releaseCalls).toBe(1);
  }, 30_000);

  it("invokes io.releaseStdin exactly once even when auth fails closed", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    await writeDeliveryScripts(repo.root);
    const io = scriptedInitIO({
      isTTY: true,
      auth: { github: { available: false } },
    });

    await expect(
      runInteractiveInit({ root: repo.root, io, draft: baseDraft() }),
    ).rejects.toMatchObject({ code: "TRACKER_AUTH_FAILED" });
    expect(io.releaseCalls).toBe(1);
  }, 30_000);

  it("invokes io.releaseStdin exactly once even when prompt-line throws (early cancellation)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    // No delivery scripts → composer surfaces delivery as unresolved
    // → init flow asks for the preview command.
    const io = scriptedInitIO({ isTTY: true });
    io.promptLine = async (): Promise<string> => {
      throw new (await import("../src/errors.js")).PoiesisError(
        "INIT_PROMPT_CANCELLED",
        "cancelled",
        { prompt: "preview" },
      );
    };

    await expect(
      runInteractiveInit({ root: repo.root, io, draft: baseDraft() }),
    ).rejects.toMatchObject({ code: "INIT_PROMPT_CANCELLED" });
    expect(io.releaseCalls).toBe(1);
  }, 30_000);

  it("production IO factory's releaseStdin pauses and unrefs process.stdin so the flow can exit naturally", async () => {
    const originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const pauseCalls: number[] = [];
    const unrefCalls: number[] = [];
    const originalPause = (process.stdin as { pause?: () => void }).pause;
    const originalUnref = (process.stdin as { unref?: () => void }).unref;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdin as unknown as { pause: () => void }).pause = (() => {
      pauseCalls.push(1);
    }) as () => void;
    (process.stdin as unknown as { unref: () => void }).unref = (() => {
      unrefCalls.push(1);
    }) as () => void;
    try {
      const { createProductionInteractiveInitIO } = await import("../src/init-interactive.js");
      const io = createProductionInteractiveInitIO();
      expect(typeof io.releaseStdin).toBe("function");
      io.releaseStdin!();
      io.releaseStdin!();
      expect(pauseCalls.length).toBeGreaterThanOrEqual(1);
      expect(unrefCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (originalIsTTY === undefined) {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      } else {
        (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
      }
      if (originalPause === undefined) {
        delete (process.stdin as { pause?: () => void }).pause;
      } else {
        (process.stdin as unknown as { pause: () => void }).pause = originalPause;
      }
      if (originalUnref === undefined) {
        delete (process.stdin as { unref?: () => void }).unref;
      } else {
        (process.stdin as unknown as { unref: () => void }).unref = originalUnref;
      }
    }
  });
});

describe("poiesis init --config regression (ticket #58)", () => {
  beforeEach(async () => {
    fakeOpenCode = await installFakeOpenCode();
  });

  it("still installs via --config (the structured-JSON path is unchanged)", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);
    const configPath = join(repo.parent, "poiesis-config.jsonc");
    await writeFile(configPath, JSON.stringify(testConfig(repo)));

    // Drive the CLI command directly (mirrors commandInit --config path).
    const { commandInit } = await import("../src/cli.js");
    let captured: Manifest | undefined;
    const originalWrite = process.stdout.write.bind(process.stdout);
    try {
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === "string" ? chunk : chunk.toString();
        try {
          const parsed = JSON.parse(text) as { ok: boolean; result: Manifest };
          if (parsed.ok) captured = parsed.result;
        } catch {
          // Ignore non-JSON chunks (HELP text or progress noise).
        }
        return true;
      }) as typeof process.stdout.write;
      await commandInit(["--config", configPath, "--cwd", repo.root, "--allow-fixtures"]);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured).toBeDefined();
    expect(captured!.poiesisVersion).toMatch(/^\d+\.\d+\.\d+$/);
  }, 30_000);
});

describe("flagless `poiesis init` does NOT emit the structured success envelope (ticket #75)", () => {
  // This describe block MUST stay isolated from the production IO
  // factory because driving the full flagless init flow under Vitest
  // would require feeding stdin via `settleOnceLinePrompt`, which
  // expects a real TTY. We test the dispatch contract directly: the
  // CLI surface must invoke `runInteractiveInit` and must NOT call
  // `writeSuccess` on the flagless path. The end-to-end
  // `runInteractiveInit` flow itself is covered by the scripted-IO
  // describe block above.
  it("flagless `poiesis init` calls runInteractiveInit and does NOT call writeSuccess", async () => {
    const repo = await createTestRepository();
    repositories.push(repo);

    // Track the calls without driving the full init flow. The CLI
    // dispatcher does `await import("./init-interactive.js")`, so the
    // symbol-level swap must happen through Vitest's mock registry
    // (ESM module exports are read-only at runtime). We install the
    // mock via `vi.doMock`, then `vi.resetModules()` so the CLI's
    // dynamic `import()` re-resolves against the registry and picks up
    // the stub. The real module is restored in `finally` so the rest
    // of the test file sees the production init flow.
    const runInteractiveInitSpy = vi.fn(async (): Promise<Manifest> => ({
      schema: 1,
      poiesisVersion: "1.1.1",
      adapter: { harness: "opencode", adapterVersion: "1", supportedVersion: "1.18.29", supportedVersions: ["1.18.29"] },
      files: [],
      skills: [],
      configPatches: [],
    }));
    const createProductionSpy = vi.fn(() => ({
      isTTY: true,
      writeStderr: vi.fn(),
      promptLine: vi.fn(),
      listOpenCodeModels: vi.fn(async () => []),
      runModelSelector: vi.fn(async () => ""),
      probeTrackerAuth: vi.fn(async () => ({ available: true })),
      releaseStdin: vi.fn(),
    }));
    vi.doMock("../src/init-interactive.js", () => ({
      runInteractiveInit: runInteractiveInitSpy,
      createProductionInteractiveInitIO: createProductionSpy,
    }));

    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    let cliModule: typeof import("../src/cli.js") | undefined;
    try {
      vi.resetModules();
      // The CLI module is already loaded in the test file by the
      // scripted-IO tests above; `vi.resetModules()` plus a fresh
      // import re-evaluates `commandInit` against the mocked
      // `./init-interactive.js` so the dispatcher's dynamic `import`
      // resolves to our stub.
      cliModule = await import("../src/cli.js");
      await cliModule.commandInit(["--cwd", repo.root, "--allow-fixtures"]);
    } finally {
      process.stdout.write = originalWrite;
      vi.doUnmock("../src/init-interactive.js");
      vi.resetModules();
      cliModule = undefined;
    }

    // The CLI MUST have routed through the interactive flow.
    expect(createProductionSpy).toHaveBeenCalledTimes(1);
    expect(runInteractiveInitSpy).toHaveBeenCalledTimes(1);
    // The CLI MUST NOT have emitted the structured success envelope on
    // stdout — the human-readable frame lives on stderr.
    expect(stdoutChunks.join("")).toBe("");
  }, 30_000);
});

describe("flagless `poiesis init` cancellation is human feedback (ticket #75 reviewer follow-up)", () => {
  // Shared scaffolding: patches `process.exit`, stdout.write, and
  // stderr.write; tracks exit calls; returns a single `restore` that
  // undoes every patch (including `process.exitCode`).
  function patchProcess(): {
    exitCalls: number[];
    stdoutChunks: string[];
    stderrChunks: string[];
    restore: () => void;
  } {
    const exitCalls: number[] = [];
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalExit = process.exit;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalExitCode = process.exitCode;
    const savedIsTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    process.exitCode = 0;
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      return undefined as never;
    }) as never;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    return {
      exitCalls,
      stdoutChunks,
      stderrChunks,
      restore: () => {
        if (savedIsTTY === undefined) {
          delete (process.stdin as { isTTY?: boolean }).isTTY;
        } else {
          (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
        }
        (process as unknown as { exit: typeof originalExit }).exit = originalExit;
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
        process.exitCode = originalExitCode;
      },
    };
  }

  it("cancelled init prompt: human feedback, silent stdout, no process.exit, exitCode=1, release ran", async () => {
    // Force TTY before constructing the IO — the production factory
    // snapshots `process.stdin.isTTY` at construction time, so a
    // post-hoc patch would not flip the captured `io.isTTY` flag.
    const savedIsTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    const { createProductionInteractiveInitIO } = await import("../src/init-interactive.js");
    const io = createProductionInteractiveInitIO();
    const originalRelease = io.releaseStdin;
    let releaseCalls = 0;
    const patchedRelease = (): void => {
      releaseCalls += 1;
      if (originalRelease) originalRelease();
    };
    io.releaseStdin = patchedRelease;

    vi.resetModules();
    vi.doMock("../src/init-interactive.js", () => ({
      runInteractiveInit: async () => {
        // Mirror what the production flow does on cancellation: the
        // finally block has already invoked releaseStdin BEFORE the
        // typed error propagates out. We invoke the SAME patched
        // releaseStdin function the CLI sees so the counter
        // captures the call from the flow's finally.
        patchedRelease();
        throw new (await import("../src/errors.js")).PoiesisError(
          "INIT_PROMPT_CANCELLED",
          "Interactive prompt was cancelled by the user",
          { prompt: "Preview command" },
        );
      },
      createProductionInteractiveInitIO: () => io,
    }));

    const { exitCalls, stdoutChunks, stderrChunks, restore } = patchProcess();
    try {
      const cli = (await import("../src/cli.js")) as typeof import("../src/cli.js");
      await cli.commandInit([]);
    } finally {
      vi.doUnmock("../src/init-interactive.js");
      vi.resetModules();
    }

    // Snapshot the captured exit status BEFORE we restore the
    // patches — `restore()` resets `process.exitCode` to its
    // pre-test value (which may be undefined).
    const capturedExitCode = process.exitCode;
    restore();

    expect(exitCalls, "process.exit must NOT be called on a typed cancellation").toEqual([]);
    expect(stdoutChunks.join(""), "stdout must stay silent on a typed cancellation").toBe("");
    const stderr = stderrChunks.join("");
    expect(stderr.toLowerCase(), "cancellation feedback must reach stderr").toMatch(/cancel/);
    expect(stderr, "no structured JSON envelope on cancellation").not.toMatch(/"ok"/);
    expect(capturedExitCode, "exitCode must be the cancellation error's exit code (1)").toBe(1);
    expect(releaseCalls, "production IO factory's releaseStdin must have run before the catch").toBe(1);

    // Restore TTY only AFTER assertions so a failed expectation does
    // not leave the global state corrupted for subsequent tests.
    if (savedIsTTY === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
    }
  }, 30_000);

  it("cancelled init model selector: same human-feedback contract", async () => {
    // Force TTY before constructing the IO (see prior test for the
    // production factory's snapshot semantics).
    const savedIsTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    const { createProductionInteractiveInitIO } = await import("../src/init-interactive.js");
    const io = createProductionInteractiveInitIO();
    const originalRelease = io.releaseStdin;
    let releaseCalls = 0;
    const patchedRelease = (): void => {
      releaseCalls += 1;
      if (originalRelease) originalRelease();
    };
    io.releaseStdin = patchedRelease;

    vi.resetModules();
    vi.doMock("../src/init-interactive.js", () => ({
      runInteractiveInit: async () => {
        patchedRelease();
        throw new (await import("../src/errors.js")).PoiesisError(
          "INIT_MODEL_SELECTOR_CANCELLED",
          "Interactive init model selector was cancelled by the user",
          { modelClass: "reasoning" },
        );
      },
      createProductionInteractiveInitIO: () => io,
    }));

    const { exitCalls, stdoutChunks, stderrChunks, restore } = patchProcess();
    try {
      const cli = (await import("../src/cli.js")) as typeof import("../src/cli.js");
      await cli.commandInit([]);
    } finally {
      vi.doUnmock("../src/init-interactive.js");
      vi.resetModules();
    }

    const capturedExitCode = process.exitCode;
    restore();

    expect(exitCalls).toEqual([]);
    expect(stdoutChunks.join("")).toBe("");
    expect(stderrChunks.join("").toLowerCase()).toMatch(/cancel/);
    expect(capturedExitCode).toBe(1);
    expect(releaseCalls).toBe(1);

    if (savedIsTTY === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
    }
  }, 30_000);

  it("non-cancellation errors (NON_TTY_INIT) still propagate as rejections — only cancellation is intercepted", async () => {
    // Force non-TTY so the production IO factory reports isTTY=false.
    // The interactive flow throws NON_TTY_INIT; this is NOT a
    // cancellation code, so the CLI must NOT swallow it.
    const saved = process.stdin.isTTY;
    const savedExitCode = process.exitCode;
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    process.exitCode = 0;
    try {
      await expect(commandInit([])).rejects.toMatchObject({
        code: "NON_TTY_INIT",
      });
      // NON_TTY_INIT was not intercepted; process.exitCode stays 0.
      expect(process.exitCode).toBe(0);
    } finally {
      if (saved === undefined) {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      } else {
        (process.stdin as { isTTY?: boolean }).isTTY = saved;
      }
      process.exitCode = savedExitCode;
    }
  });
});

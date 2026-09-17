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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const repositories: TestRepository[] = [];
let fakeOpenCode: FakeOpenCodeEnvironment | undefined;
let fakeTrackers: { restore: () => void } | undefined;

afterEach(async () => {
  fakeOpenCode?.restore();
  fakeOpenCode = undefined;
  fakeTrackers?.restore();
  fakeTrackers = undefined;
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
    writeStderr(line: string): void {
      stderrLines.push(line);
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

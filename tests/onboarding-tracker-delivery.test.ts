/**
 * Spec #139 / ticket #144 — one clear interactive init and authenticated
 * update experience for GitHub, GitLab, Linear, Local, and configured versus
 * deferred delivery.
 *
 * The boundaries under test, each naming the production break it catches:
 *
 *   1. EXPLICIT CHOICE — interactive init always obtains an explicit tracker
 *      choice. A provider inferred from the Git remote is offered as the
 *      DEFAULT, never applied silently, so tracker selection is never
 *      coupled to Git hosting. A draft that already states the provider is
 *      the recorded explicit choice and is not asked again.
 *   2. PROVIDER COORDINATES — GitHub / GitLab prompt for a project, Linear
 *      prompts for a team and an optional project, Local needs no remote
 *      coordinates, and NO provider is ever asked for a secret. An
 *      inferred repository coordinate is never carried across to a
 *      different provider.
 *   3. DELIVERY READINESS — the installer asks configured versus deferred
 *      exactly once. Deferral skips every target prompt, every target
 *      probe, and script generation, and persists `{ mode: "deferred" }`.
 *   4. AUTH / DOCTOR DISPATCH — the pre-install check dispatches for all
 *      four providers and fails closed with actionable guidance.
 *   5. LINEAR VERIFICATION TRUTH — a configured Linear team or project that
 *      does not exist fails the tracker check instead of passing doctor, and
 *      the reported details name the team and project.
 *   6. ATOMIC TRANSITIONS — `update --config` applies tracker and
 *      deferred/configured delivery transitions atomically after the
 *      destination is validated, and rolls everything back when the new
 *      destination is invalid.
 *   7. BACKWARD COMPATIBILITY — a noninteractive config that omits the
 *      tracker or delivery block keeps its legacy inference/generated-script
 *      behavior, and an ordinary update changes no recorded choice.
 */
import { Buffer } from "node:buffer";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeInitDiscovery } from "../src/init-discovery.js";
import {
  __test as interactiveTest,
  createProductionInteractiveInitIO,
  runInteractiveInit,
  type InteractiveInitIO,
  type ModelSelection,
} from "../src/init-interactive.js";
import { doctor, init, setLinearTrackerSeamsForTest, updateFromConfig } from "../src/maintenance.js";
import {
  DEFERRED_DELIVERY_MODE,
  isDeferredDelivery,
  serializeConfig,
  type DeliveryTargetConfig,
  type PoiesisConfig,
} from "../src/config.js";
import { run } from "../src/process.js";
import { resolveLocalTrackerStoreLocation } from "../src/local-tracker.js";
import type { LinearHttpRequest, LinearHttpResponse, LinearTransport } from "../src/linear-tracker.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const CONFIG_PATH = join(".poiesis", "config.jsonc");

// -- scripted interactive IO ----------------------------------------------

interface ScriptedPrompt {
  prompt: string;
  answer: string;
}

interface ProbeCall {
  provider: string;
  team?: string;
  project?: string;
}

class ScriptedIO implements InteractiveInitIO {
  readonly isTTY = true;
  readonly stderrLines: string[] = [];
  readonly prompts: ScriptedPrompt[] = [];
  readonly modelSelections: ModelClassOnly[] = [];
  readonly probes: ProbeCall[] = [];
  releaseCalls = 0;
  /** Exact prompt text -> answer. An unscripted prompt throws loudly. */
  private readonly answers: Map<string, string>;
  private readonly authFailures: Map<string, { stderr?: string; hint?: string }>;

  constructor(options: {
    answers?: Record<string, string>;
    authFailures?: Record<string, { stderr?: string; hint?: string }>;
    inventory?: readonly string[];
  }) {
    this.answers = new Map(Object.entries(options.answers ?? {}));
    this.authFailures = new Map(Object.entries(options.authFailures ?? {}));
    this.inventory = options.inventory ?? [];
  }

  private readonly inventory: readonly string[];

  writeStderr(line: string): void {
    this.stderrLines.push(line);
  }

  releaseStdin(): void {
    this.releaseCalls += 1;
  }

  async promptLine(prompt: string): Promise<string> {
    const answer = this.answers.get(prompt);
    if (answer === undefined) {
      throw new Error(`ScriptedIO: no scripted answer for prompt: ${JSON.stringify(prompt)}`);
    }
    this.prompts.push({ prompt, answer });
    return answer;
  }

  async listOpenCodeModels(): Promise<readonly string[]> {
    return [...this.inventory];
  }

  async runModelSelector(selection: ModelSelection): Promise<string> {
    this.modelSelections.push({ modelClass: selection.modelClass });
    return selection.modelClass === "reasoning" ? "openai/gpt-5.6-sol" : "minimax/MiniMax-M3";
  }

  async probeTrackerAuth(
    provider: string,
    context?: { team?: string; project?: string },
  ): Promise<{ available: boolean; stderr?: string; hint?: string }> {
    this.probes.push({
      provider,
      ...(context?.team === undefined ? {} : { team: context.team }),
      ...(context?.project === undefined ? {} : { project: context.project }),
    });
    const failure = this.authFailures.get(provider);
    return failure === undefined ? { available: true } : { available: false, ...failure };
  }

  stderr(): string {
    return this.stderrLines.join("\n");
  }

  askedFor(fragment: string): boolean {
    return this.prompts.some((entry) => entry.prompt.toLowerCase().includes(fragment.toLowerCase()));
  }

  promptContaining(fragment: string): string | undefined {
    return this.prompts.find((entry) => entry.prompt.toLowerCase().includes(fragment.toLowerCase()))?.prompt;
  }
}

type ModelClassOnly = { modelClass: "reasoning" | "execution" };

// -- fake git forge CLIs ---------------------------------------------------

async function installFakeForge(): Promise<() => void> {
  const bin = await mkdtemp(join(tmpdir(), "poiesis-onboarding-forge-"));
  const gh = join(bin, "gh");
  await writeFile(gh, `#!/bin/sh
case "$1" in
  auth) exit 0 ;;
  repo)
    if [ "$2" = "view" ]; then printf '{"nameWithOwner":"owner/repo"}\\n'; exit 0; fi
    exit 1
    ;;
esac
exit 0
`);
  await chmod(gh, 0o755);
  const glab = join(bin, "glab");
  await writeFile(glab, `#!/bin/sh
case "$1" in
  auth) exit 0 ;;
  api) printf '{}'; exit 0 ;;
esac
exit 0
`);
  await chmod(glab, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = previous === undefined || previous === "" ? bin : `${bin}:${previous}`;
  return () => {
    process.env.PATH = previous;
  };
}

// -- fake Linear endpoint --------------------------------------------------

class LinearScript {
  readonly requests: LinearHttpRequest[] = [];
  constructor(private replies: Readonly<Record<string, unknown>>) {}

  /**
   * Swap the workspace the endpoint describes. `init` refuses a mistyped
   * coordinate, so a test that needs doctor to SEE one installs a valid
   * configuration first and only then makes the workspace stop matching it —
   * which is exactly the real sequence (a coordinate that used to resolve).
   */
  replyWith(replies: Readonly<Record<string, unknown>>): void {
    this.replies = replies;
  }

  readonly transport: LinearTransport = async (request) => {
    this.requests.push(request);
    const operation = /^(?:query|mutation)\s+(\w+)/.exec(JSON.parse(request.body).query as string)?.[1] ?? "";
    const data = this.replies[operation];
    if (data === undefined) throw new Error(`unscripted Linear operation: ${operation}`);
    return {
      status: 200,
      headers: {},
      body: { text: JSON.stringify({ data }), capturedBytes: Buffer.byteLength(JSON.stringify({ data }), "utf8"), truncated: false },
    } satisfies LinearHttpResponse;
  };

  operations(): string[] {
    return this.requests.map((request) => {
      const match = /^(?:query|mutation)\s+(\w+)/.exec(JSON.parse(request.body).query as string);
      return match?.[1] ?? "";
    });
  }
}

const VIEWER_DATA = { viewer: { id: "user-1" } };
const TEAMS_PAGE = (nodes: Array<{ id: string; key: string; name: string }>) => ({
  teams: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
});
const PROJECTS_PAGE = (nodes: Array<{ id: string; name: string }>) => ({
  projects: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
});

/** A workspace whose team AND project resolve. */
const RESOLVING_LINEAR = {
  PoiesisViewer: VIEWER_DATA,
  PoiesisTeams: TEAMS_PAGE([{ id: "team-1", key: "ENG", name: "Engineering" }]),
  PoiesisProjects: PROJECTS_PAGE([{ id: "project-1", name: "Roadmap" }]),
};
/** A workspace whose teams resolve but which has no projects at all. */
const TEAM_ONLY_LINEAR = {
  PoiesisViewer: VIEWER_DATA,
  PoiesisTeams: TEAMS_PAGE([{ id: "team-1", key: "ENG", name: "Engineering" }]),
  PoiesisProjects: PROJECTS_PAGE([]),
};
/** A workspace where the configured team key is simply absent. */
const NO_ENG_LINEAR = {
  PoiesisViewer: VIEWER_DATA,
  PoiesisTeams: TEAMS_PAGE([{ id: "team-9", key: "OPS", name: "Operations" }]),
  PoiesisProjects: PROJECTS_PAGE([{ id: "project-1", name: "Roadmap" }]),
};

function linearSeams(script: LinearScript): { env: Record<string, string | undefined>; transport: LinearTransport } {
  return { env: { LINEAR_API_KEY: "lin_api_secret" }, transport: script.transport };
}

// -- fixtures --------------------------------------------------------------

const repositories: TestRepository[] = [];
let fakeOpenCode: FakeOpenCodeEnvironment | undefined;
let restoreForge: (() => void) | undefined;
let previousLinearKey: string | undefined;

beforeEach(async () => {
  fakeOpenCode = await installFakeOpenCode();
  previousLinearKey = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_OAUTH_TOKEN;
});

afterEach(async () => {
  if (typeof setLinearTrackerSeamsForTest === "function") setLinearTrackerSeamsForTest(null);
  if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = previousLinearKey;
  delete process.env.LINEAR_OAUTH_TOKEN;
  fakeOpenCode?.restore();
  fakeOpenCode = undefined;
  restoreForge?.();
  restoreForge = undefined;
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

function flaglessAnswers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Verification command [test -f README.md]": "test -f README.md",
    "Configure delivery now? (configured|deferred)": "configured",
    ...overrides,
  };
}

/** The exact prompt texts this ticket's installer uses. */
const PROMPTS = {
  trackerWithDefault: (inferred: string) => `Tracker provider (github|gitlab|linear|local) [${inferred}]`,
  tracker: "Tracker provider (github|gitlab|linear|local)",
  team: "Linear team (key or name)",
  linearProject: "Linear project (optional — leave blank to skip)",
  deliveryMode: "Configure delivery now? (configured|deferred)",
  project: "Tracker project",
  preview: "Preview command>",
  staging: "Staging command>",
  production: "Production command>",
} as const;

async function newRepository(remote?: "github" | "gitlab" | "local"): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  if (remote === "github") {
    await run("git", ["remote", "set-url", "origin", "https://github.com/owner/repo.git"], { cwd: repository.root });
  } else if (remote === "gitlab") {
    await run("git", ["remote", "set-url", "origin", "https://gitlab.com/owner/repo.git"], { cwd: repository.root });
  }
  return repository;
}

async function readInstalledConfig(root: string): Promise<PoiesisConfig> {
  return JSON.parse(await readFile(join(root, CONFIG_PATH), "utf8")) as PoiesisConfig;
}

// =========================================================================
// 1. The composer reports the tracker choice and the delivery readiness
//    choice as Author-owned questions, with detection as the default.
// =========================================================================

describe("init discovery reports tracker and delivery readiness as Author-owned choices", () => {
  it("marks tracker.provider unresolved for a github.com remote while keeping the inference as the detected default", async () => {
    // Break: silently accepting the remote-inferred provider couples tracker
    // identity to Git hosting and records a choice the Author never made.
    const repository = await newRepository("github");
    const result = await composeInitDiscovery(repository.root);
    expect(result.unresolved).toContain("tracker.provider");
    // The inference is still reported — as a suggested default, not a decision.
    expect(result.detections.tracker.provider).toBe("github");
    expect(result.detections.tracker.project).toBe("owner/repo");
  });

  it("marks tracker.provider unresolved for a gitlab.com remote too", async () => {
    const repository = await newRepository("gitlab");
    const result = await composeInitDiscovery(repository.root);
    expect(result.unresolved).toContain("tracker.provider");
    expect(result.detections.tracker.provider).toBe("gitlab");
  });

  it("does not ask again when the draft already states the tracker provider", async () => {
    // Break: re-asking a question the draft already answered makes the
    // existing noninteractive/template path noisy and non-idempotent.
    const repository = await newRepository();
    const draft: PoiesisConfig = {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      tracker: { provider: "github", project: "owner/repo" },
      delivery: {
        preview: { adapter: "command", command: ["./d", "preview", "{sha}"] },
        staging: { adapter: "command", command: ["./d", "staging", "{sha}"] },
        production: { adapter: "command", command: ["./d", "production", "{sha}"] },
      },
      verification: { commands: ["test -f README.md"] },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.unresolved).not.toContain("tracker.provider");
    expect(result.unresolved).not.toContain("delivery.mode");
  });

  it("marks delivery.mode unresolved when the draft states no delivery block at all", async () => {
    // Break: defaulting delivery to configured without asking would fabricate
    // three delivery commands the Author never chose.
    const repository = await newRepository();
    const draft: PoiesisConfig = {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      tracker: { provider: "github", project: "owner/repo" },
      verification: { commands: ["test -f README.md"] },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.unresolved).toContain("delivery.mode");
  });

  it("does not ask about delivery.mode when the draft already defers delivery", async () => {
    const repository = await newRepository();
    const draft: PoiesisConfig = {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      tracker: { provider: "github", project: "owner/repo" },
      delivery: { mode: DEFERRED_DELIVERY_MODE },
      verification: { commands: ["test -f README.md"] },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.unresolved).not.toContain("delivery.mode");
    // A deferred draft raises no per-target question either.
    expect(result.unresolved.filter((path) => path.startsWith("delivery."))).toEqual([]);
  });
});

// =========================================================================
// 2. Interactive init records an explicit, provider-appropriate choice.
// =========================================================================

describe("interactive init records an explicit tracker choice", () => {
  it("offers all four providers with the remote-inferred one as a visible default", async () => {
    const repository = await newRepository("github");
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.trackerWithDefault("github")]: "",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, undefined);
    // Empty Enter accepts the DEFAULT, and the prompt names every supported
    // provider so the Author can see the choice exists.
    const prompt = io.promptContaining("Tracker provider");
    expect(prompt).toBe(PROMPTS.trackerWithDefault("github"));
    for (const provider of ["github", "gitlab", "linear", "local"]) {
      expect(prompt).toContain(provider);
    }
    expect(next.tracker?.provider).toBe("github");
  });

  it("does not advertise a default when the remote host is unknown and fails closed on an empty answer", async () => {
    // Break: a bracket default here would silently pick github for an
    // unrecognized host, which is the coupling this ticket removes.
    const repository = await newRepository();
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({ [PROMPTS.tracker]: "", [PROMPTS.deliveryMode]: "deferred" }),
    });
    await expect(interactiveTest.resolveAuthorChoices(io, discovery, undefined)).rejects.toMatchObject({
      code: "INVALID_TRACKER_PROVIDER",
    });
  });

  it("records a local tracker with no remote coordinates and asks no coordinate question", async () => {
    const repository = await newRepository("github");
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.trackerWithDefault("github")]: "local",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, undefined);
    // Local carries no repository coordinate, and the GitHub project the
    // remote revealed must NOT leak into a local tracker block.
    expect(next.tracker).toEqual({ provider: "local" });
    expect(io.askedFor("Tracker project")).toBe(false);
    expect(io.askedFor("Linear team")).toBe(false);
  });

  it("prompts for a Linear team and an optional project and never asks for a secret", async () => {
    const repository = await newRepository("github");
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.trackerWithDefault("github")]: "linear",
        [PROMPTS.team]: "ENG",
        [PROMPTS.linearProject]: "Roadmap",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, undefined);
    expect(next.tracker).toEqual({ provider: "linear", team: "ENG", project: "Roadmap" });
    // The credential is environment-only: no prompt may ask for a key or a
    // token, and the recorded config must carry no credential field.
    // A Linear team KEY is a public coordinate, not a secret; an API key, a
    // token, or a password is. None of those may ever be a prompt.
    for (const fragment of ["api key", "token", "secret", "password", "credential"]) {
      expect(io.askedFor(fragment), `no prompt may ask for a ${fragment}`).toBe(false);
    }
    expect(JSON.stringify(next.tracker)).not.toMatch(/lin_api|Bearer|secret/i);
  });

  it("omits the Linear project when the Author leaves it blank", async () => {
    const repository = await newRepository("github");
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.trackerWithDefault("github")]: "linear",
        [PROMPTS.team]: "ENG",
        [PROMPTS.linearProject]: "",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, undefined);
    expect(next.tracker).toEqual({ provider: "linear", team: "ENG" });
  });

  it("keeps a draft-stated Linear team and project instead of asking again", async () => {
    // Break: re-asking a coordinate the draft already recorded makes the
    // existing template / `--config` path non-idempotent and can silently
    // downgrade a configured project when the Author presses Enter.
    const repository = await newRepository();
    const draft: PoiesisConfig = {
      schema: 1,
      models: { reasoning: "", execution: "" },
      tracker: { provider: "linear", team: "ENG", project: "Roadmap" },
      delivery: { mode: DEFERRED_DELIVERY_MODE },
      verification: { commands: ["test -f README.md"] },
    };
    const discovery = await composeInitDiscovery(repository.root, draft);
    const io = new ScriptedIO({ inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"] });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, draft);
    expect(next.tracker).toEqual({ provider: "linear", team: "ENG", project: "Roadmap" });
    expect(io.askedFor("Linear team")).toBe(false);
    expect(io.askedFor("Linear project")).toBe(false);
  });

  it("treats a blank draft coordinate as nothing said and asks for it", async () => {
    // Break: carrying a blank `project` forward records a coordinate the
    // Author never named, which is the same fabrication as inventing one.
    const repository = await newRepository();
    const draft: PoiesisConfig = {
      schema: 1,
      models: { reasoning: "", execution: "" },
      tracker: { provider: "linear", team: "   " },
      delivery: { mode: DEFERRED_DELIVERY_MODE },
      verification: { commands: ["test -f README.md"] },
    };
    const discovery = await composeInitDiscovery(repository.root, draft);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: { [PROMPTS.team]: "ENG", [PROMPTS.linearProject]: "Roadmap" },
    });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, draft);
    expect(io.askedFor("Linear team")).toBe(true);
    expect(next.tracker).toEqual({ provider: "linear", team: "ENG", project: "Roadmap" });
  });

  it("fails closed on an empty Linear team rather than filing work under an unnamed team", async () => {
    const repository = await newRepository("github");
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.trackerWithDefault("github")]: "linear",
        [PROMPTS.team]: "",
        [PROMPTS.linearProject]: "",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    await expect(interactiveTest.resolveAuthorChoices(io, discovery, undefined)).rejects.toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
    });
  });

  it("prompts for a fresh project when the inferred one belongs to a different provider", async () => {
    // Break: carrying `owner/repo` — discovered from a github.com remote —
    // into a gitlab tracker block files this work in the wrong repository.
    const repository = await newRepository("github");
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.trackerWithDefault("github")]: "gitlab",
        [PROMPTS.project]: "group/project",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, undefined);
    expect(io.askedFor("Tracker project")).toBe(true);
    expect(next.tracker).toEqual({ provider: "gitlab", project: "group/project" });
  });

  it("reuses the inferred project only for the provider it was inferred for", async () => {
    const repository = await newRepository("github");
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.trackerWithDefault("github")]: "github",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    const next = await interactiveTest.resolveAuthorChoices(io, discovery, undefined);
    expect(io.askedFor("Tracker project")).toBe(false);
    expect(next.tracker).toEqual({ provider: "github", project: "owner/repo" });
  });

  it("fails closed on an unsupported tracker answer", async () => {
    const repository = await newRepository();
    const discovery = await composeInitDiscovery(repository.root);
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({ [PROMPTS.tracker]: "jira", [PROMPTS.deliveryMode]: "deferred" }),
    });
    await expect(interactiveTest.resolveAuthorChoices(io, discovery, undefined)).rejects.toMatchObject({
      code: "INVALID_TRACKER_PROVIDER",
    });
  });
});

// =========================================================================
// 3. Configured versus deferred delivery, asked exactly once.
// =========================================================================

describe("interactive init asks configured versus deferred delivery exactly once", () => {
  it("skips every target prompt, every target probe, and script generation when delivery is deferred", async () => {
    // Break: a placeholder delivery script for a deferred install is exactly
    // the fake adapter the Spec forbids.
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.tracker]: "local",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    const manifest = await runInteractiveInit({ root: repository.root, io });
    expect(manifest).toBeDefined();

    for (const fragment of ["Preview command", "Staging command", "Production command"]) {
      expect(io.askedFor(fragment), `deferral must skip the ${fragment} prompt`).toBe(false);
    }
    // Exactly one delivery-readiness question, and no per-target question.
    expect(io.prompts.filter((entry) => entry.prompt.includes("delivery"))).toHaveLength(1);

    const installed = await readInstalledConfig(repository.root);
    expect(installed.delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });

    const scripts = await readFile(join(repository.root, "scripts", "poiesis-preview.mjs"), "utf8").catch(() => null);
    expect(scripts, "a deferred install generates no delivery script").toBeNull();
    expect(await readFile(join(repository.root, "scripts", "poiesis-production.mjs"), "utf8").catch(() => null)).toBeNull();
  }, 60_000);

  it("asks for the real per-target commands when delivery is configured now", async () => {
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.tracker]: "local",
        [PROMPTS.deliveryMode]: "configured",
        [PROMPTS.preview]: "./deploy preview {sha}",
        [PROMPTS.staging]: "./deploy staging {sha}",
        [PROMPTS.production]: "./deploy production {sha}",
      }),
    });
    await runInteractiveInit({ root: repository.root, io });
    for (const fragment of ["Preview command", "Staging command", "Production command"]) {
      expect(io.askedFor(fragment)).toBe(true);
    }
    const installed = await readInstalledConfig(repository.root);
    expect(installed.delivery).toMatchObject({
      preview: { command: ["./deploy", "preview", "{sha}"] },
      staging: { command: ["./deploy", "staging", "{sha}"] },
      production: { command: ["./deploy", "production", "{sha}"] },
    });
  }, 60_000);

  it("does not ask again when the draft already states deferred delivery", async () => {
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({ [PROMPTS.tracker]: "local" }),
    });
    const draft: PoiesisConfig = {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      tracker: { provider: "local" },
      delivery: { mode: DEFERRED_DELIVERY_MODE },
      verification: { commands: ["test -f README.md"] },
    };
    await runInteractiveInit({ root: repository.root, io, draft });
    expect(io.askedFor("delivery")).toBe(false);
  }, 60_000);

  it("fails closed on an empty delivery-readiness answer instead of silently choosing a state", async () => {
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({ [PROMPTS.tracker]: "local", [PROMPTS.deliveryMode]: "" }),
    });
    await expect(runInteractiveInit({ root: repository.root, io })).rejects.toMatchObject({
      code: "INVALID_DELIVERY_MODE",
    });
    // The transaction never ran: nothing was installed.
    await expect(readInstalledConfig(repository.root)).rejects.toThrow();
  }, 60_000);
});

// =========================================================================
// 4. Auth / doctor dispatch for every provider.
// =========================================================================

describe("interactive init dispatches the pre-install capability check for every provider", () => {
  it("probes the provider the Author actually chose, not the one the remote implies", async () => {
    const repository = await newRepository("github");
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({ [PROMPTS.trackerWithDefault("github")]: "local", [PROMPTS.deliveryMode]: "deferred" }),
    });
    // The github.com URL is deliberately unreachable, so `init()` fails after
    // the capability check. The dispatch decision happens before that, which
    // is exactly the boundary under test.
    await runInteractiveInit({ root: repository.root, io }).catch(() => undefined);
    // The remote is a github.com URL, but the recorded tracker is local, so
    // the check must be the clone-local store check — never `gh auth status`.
    expect(io.probes.map((probe) => probe.provider)).toEqual(["local"]);
  }, 60_000);

  it("probes github for a github tracker", async () => {
    restoreForge = await installFakeForge();
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.tracker]: "github",
        [PROMPTS.project]: "owner/repo",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    await runInteractiveInit({ root: repository.root, io });
    expect(io.probes.map((probe) => probe.provider)).toEqual(["github"]);
  }, 60_000);

  it("probes gitlab for a gitlab tracker", async () => {
    restoreForge = await installFakeForge();
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.tracker]: "gitlab",
        [PROMPTS.project]: "group/project",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    await runInteractiveInit({ root: repository.root, io });
    expect(io.probes.map((probe) => probe.provider)).toEqual(["gitlab"]);
  }, 60_000);

  it("passes the Linear team and project to the Linear check and never to a host CLI", async () => {
    const script = new LinearScript(RESOLVING_LINEAR);
    setLinearTrackerSeamsForTest(linearSeams(script));
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.tracker]: "linear",
        [PROMPTS.team]: "ENG",
        [PROMPTS.linearProject]: "Roadmap",
        [PROMPTS.deliveryMode]: "deferred",
      }),
    });
    await runInteractiveInit({ root: repository.root, io });
    expect(io.probes).toEqual([{ provider: "linear", team: "ENG", project: "Roadmap" }]);
  }, 60_000);

  it("fails closed with credential-variable guidance when the Linear check fails, and never asks for a pasted secret", async () => {
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({
        [PROMPTS.tracker]: "linear",
        [PROMPTS.team]: "ENG",
        [PROMPTS.linearProject]: "",
        [PROMPTS.deliveryMode]: "deferred",
      }),
      authFailures: { linear: { stderr: "LINEAR_AUTH_MISSING" } },
    });
    let caught: unknown;
    try {
      await runInteractiveInit({ root: repository.root, io });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "TRACKER_AUTH_FAILED" });
    const details = (caught as { details: Record<string, unknown> }).details;
    expect(details.provider).toBe("linear");
    expect(details.credentialVariables).toEqual(["LINEAR_API_KEY", "LINEAR_OAUTH_TOKEN"]);
    const text = `${(caught as Error).message} ${JSON.stringify(details)}`;
    expect(text).toContain("LINEAR_API_KEY");
    expect(text).toContain("LINEAR_OAUTH_TOKEN");
    // The guidance must not invite the Author to write a secret anywhere.
    expect(text.toLowerCase()).not.toContain("paste");
    expect(text.toLowerCase()).not.toContain("enter your");
    // Nothing was installed.
    await expect(readInstalledConfig(repository.root)).rejects.toThrow();
  }, 60_000);

  it("fails closed with clone-local store guidance when the local check fails", async () => {
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({ [PROMPTS.tracker]: "local", [PROMPTS.deliveryMode]: "deferred" }),
      authFailures: { local: { stderr: "LOCAL_TRACKER_STORE_UNUSABLE" } },
    });
    let caught: unknown;
    try {
      await runInteractiveInit({ root: repository.root, io });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "TRACKER_AUTH_FAILED" });
    const details = (caught as { details: Record<string, unknown> }).details;
    expect(details.provider).toBe("local");
    expect(String(details.hint)).toMatch(/common director|clone-local|store/i);
    await expect(readInstalledConfig(repository.root)).rejects.toThrow();
  }, 60_000);
});

/**
 * The production IO factory is the only place these probes really run, so it
 * gets its own coverage: a scripted IO can only prove the flow asks, never
 * that the real check is a real check. The Linear endpoint is fixed and
 * never proxied, so these cases exercise the offline, credential-bound half
 * of the Linear probe and the real filesystem half of the Local probe.
 */
describe("the production capability check is a real check for Linear and Local", () => {
  it("refuses a Linear probe with no credential in the environment", async () => {
    // Break: returning `available: true` without contacting Linear would let
    // a credential-less Linear install proceed and fail at the first mutation.
    const repository = await newRepository();
    const io = createProductionInteractiveInitIO(repository.root);
    const result = await io.probeTrackerAuth("linear", { team: "ENG" });
    expect(result.available).toBe(false);
    expect(result.stderr).toContain("LINEAR_AUTH_MISSING");
    expect(result.stderr).toContain("LINEAR_API_KEY");
    expect(result.stderr).toContain("LINEAR_OAUTH_TOKEN");
  });

  it("refuses a Linear probe with two credentials in the environment", async () => {
    const repository = await newRepository();
    process.env.LINEAR_API_KEY = "lin_api_secret";
    process.env.LINEAR_OAUTH_TOKEN = "lin_oauth_secret";
    const io = createProductionInteractiveInitIO(repository.root);
    const result = await io.probeTrackerAuth("linear", { team: "ENG" });
    expect(result.available).toBe(false);
    expect(result.stderr).toContain("LINEAR_AUTH_AMBIGUOUS");
  });

  it("passes a Local probe against a real clone and fails closed on a symlinked store", async () => {
    // Break: a Local probe that always answers `available` would accept a
    // store that the first tracker mutation cannot actually use.
    const repository = await newRepository();
    const io = createProductionInteractiveInitIO(repository.root);
    expect(await io.probeTrackerAuth("local")).toEqual({ available: true });

    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const outside = join(repository.parent, "probe-outside.json");
    await writeFile(outside, "keep\n", { mode: 0o600 });
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    await symlink(outside, location.storePath);

    const refused = await io.probeTrackerAuth("local");
    expect(refused.available).toBe(false);
    expect(refused.stderr).toContain("LOCAL_TRACKER_STORE_UNSAFE");
  }, 60_000);
});

// =========================================================================
// 5. Linear verification truth in doctor.
// =========================================================================

describe("doctor reports the configured Linear tracker truthfully", () => {
  async function installLinearProject(
    tracker: { provider: "linear"; team: string; project?: string },
  ): Promise<TestRepository> {
    const repository = await newRepository();
    await init(
      repository.root,
      {
        schema: 1,
        models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
        repository: { remote: "origin", integrationBranch: "main" },
        tracker,
        delivery: { mode: DEFERRED_DELIVERY_MODE },
        verification: { commands: ["test -f README.md"] },
      },
      { skipSkills: true },
    );
    return repository;
  }

  it("fails the tracker check when the configured team no longer resolves", async () => {
    // Break: a viewer-only probe reports a mistyped team as healthy, so a
    // mis-configured Linear installation passes doctor and fails later at the
    // first tracker mutation. `init` already refuses the bad coordinate, so
    // the sequence here is a coordinate that resolved at install time and
    // stopped resolving — the shape a stale config really takes.
    const script = new LinearScript(RESOLVING_LINEAR);
    setLinearTrackerSeamsForTest(linearSeams(script));
    const repository = await installLinearProject({ provider: "linear", team: "ENG" });
    script.replyWith(NO_ENG_LINEAR);
    const report = await doctor(repository.root);
    const tracker = report.checks.find((check) => check.id === "tracker");
    expect(tracker?.status).toBe("fail");
    expect((tracker?.details as { code?: string }).code).toBe("LINEAR_TEAM_NOT_FOUND");
    // The failure is reported against the CONFIGURED coordinate, not only a code.
    expect((tracker?.details as { team?: string }).team).toBe("ENG");
    expect(report.ok).toBe(false);
  }, 90_000);

  it("fails the tracker check when the configured project no longer resolves", async () => {
    const script = new LinearScript(RESOLVING_LINEAR);
    setLinearTrackerSeamsForTest(linearSeams(script));
    const repository = await installLinearProject({ provider: "linear", team: "ENG", project: "Roadmap" });
    script.replyWith(TEAM_ONLY_LINEAR);
    const report = await doctor(repository.root);
    const tracker = report.checks.find((check) => check.id === "tracker");
    expect(tracker?.status).toBe("fail");
    expect((tracker?.details as { code?: string }).code).toBe("LINEAR_PROJECT_NOT_FOUND");
    expect((tracker?.details as { project?: string }).project).toBe("Roadmap");
  }, 90_000);

  it("passes and names the configured team and project when both resolve", async () => {
    const script = new LinearScript(RESOLVING_LINEAR);
    setLinearTrackerSeamsForTest(linearSeams(script));
    const repository = await installLinearProject({ provider: "linear", team: "ENG", project: "Roadmap" });
    const report = await doctor(repository.root);
    const tracker = report.checks.find((check) => check.id === "tracker");
    expect(tracker?.status).toBe("pass");
    const details = tracker?.details as { provider?: string; team?: string; project?: string; resolvedTeamKey?: string };
    expect(details.provider).toBe("linear");
    expect(details.team).toBe("ENG");
    expect(details.project).toBe("Roadmap");
    expect(details.resolvedTeamKey).toBe("ENG");
    expect(tracker?.message).toContain("ENG");
  }, 90_000);
});

// =========================================================================
// 6. update --config transitions tracker and delivery atomically.
// =========================================================================

describe("update --config applies tracker and delivery transitions atomically", () => {
  async function installGithubDeferred(): Promise<TestRepository> {
    restoreForge = await installFakeForge();
    const repository = await newRepository();
    await init(
      repository.root,
      {
        schema: 1,
        models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
        repository: { remote: "origin", integrationBranch: "main" },
        tracker: { provider: "github", project: "owner/repo" },
        delivery: { mode: DEFERRED_DELIVERY_MODE },
        verification: { commands: ["test -f README.md"] },
      },
      { skipSkills: true },
    );
    return repository;
  }

  function candidate(tracker: PoiesisConfig["tracker"], delivery: PoiesisConfig["delivery"]): PoiesisConfig {
    return {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      repository: { remote: "origin", integrationBranch: "main" },
      tracker,
      delivery,
      verification: { commands: ["test -f README.md"] },
    };
  }

  it("moves a github installation to a local tracker and persists it", async () => {
    const repository = await installGithubDeferred();
    const path = join(repository.parent, "local.jsonc");
    await writeFile(
      path,
      serializeConfig(
        candidate(
          { provider: "local" },
          { mode: DEFERRED_DELIVERY_MODE },
        ),
      ),
    );
    const result = await updateFromConfig(repository.root, path);
    const tracker = result.doctor.checks.find((check) => check.id === "tracker");
    expect(tracker?.status).toBe("pass");
    expect((await readInstalledConfig(repository.root)).tracker).toEqual({ provider: "local" });
  }, 90_000);

  it("moves a deferred installation to three configured delivery targets", async () => {
    const repository = await installGithubDeferred();
    const path = join(repository.parent, "configured.jsonc");
    const delivery = {
      preview: { adapter: "command", command: ["echo", "preview", "{sha}"] },
      staging: { adapter: "command", command: ["echo", "staging", "{sha}"] },
      production: { adapter: "command", command: ["echo", "production", "{sha}"] },
    } as const;
    await writeFile(path, serializeConfig(candidate({ provider: "github", project: "owner/repo" }, delivery)));
    const result = await updateFromConfig(repository.root, path);
    const deliveryCheck = result.doctor.checks.find((check) => check.id === "delivery");
    expect(deliveryCheck?.status).toBe("pass");
    expect((await readInstalledConfig(repository.root)).delivery).toEqual(delivery);
  }, 90_000);

  it("refuses a tracker transition whose destination does not validate, without touching a byte", async () => {
    // Break: a transition that persists a tracker whose team does not exist
    // leaves the installation silently mis-configured. The destination is
    // validated BEFORE the first write, so the config must be byte-identical.
    const repository = await installGithubDeferred();
    const before = await readFile(join(repository.root, CONFIG_PATH), "utf8");
    const path = join(repository.parent, "mistyped.jsonc");
    await writeFile(path, serializeConfig(candidate({ provider: "linear", team: "TYPO" }, { mode: DEFERRED_DELIVERY_MODE })));
    const script = new LinearScript(NO_ENG_LINEAR);
    setLinearTrackerSeamsForTest(linearSeams(script));
    await expect(updateFromConfig(repository.root, path)).rejects.toMatchObject({ code: "LINEAR_TEAM_NOT_FOUND" });
    expect(await readFile(join(repository.root, CONFIG_PATH), "utf8")).toBe(before);
    expect((await readInstalledConfig(repository.root)).tracker).toEqual({ provider: "github", project: "owner/repo" });
  }, 90_000);

  it("refuses a delivery transition that configures only some targets, without touching a byte", async () => {
    // Break: accepting a partial block would invent the missing target, which
    // is the fabricated adapter the Spec forbids.
    const repository = await installGithubDeferred();
    const before = await readFile(join(repository.root, CONFIG_PATH), "utf8");
    const path = join(repository.parent, "partial.jsonc");
    await writeFile(
      path,
      serializeConfig(
        candidate(
          { provider: "github", project: "owner/repo" },
          {
            preview: { adapter: "command", command: ["echo", "preview", "{sha}"] },
            staging: { adapter: "command", command: ["echo", "staging", "{sha}"] },
          } as unknown as PoiesisConfig["delivery"],
        ),
      ),
    );
    await expect(updateFromConfig(repository.root, path)).rejects.toMatchObject({ code: "INVALID_DELIVERY_CONFIG" });
    expect(await readFile(join(repository.root, CONFIG_PATH), "utf8")).toBe(before);
    expect((await readInstalledConfig(repository.root)).delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });
  }, 90_000);
});

// =========================================================================
// 7. Backward compatibility for noninteractive onboarding and updates.
// =========================================================================

describe("noninteractive onboarding and ordinary updates change no recorded choice", () => {
  it("keeps generating delivery scripts when a noninteractive config omits the delivery block", async () => {
    // Break: making deferral or configured mandatory for `--config` would
    // break every existing noninteractive installation.
    restoreForge = await installFakeForge();
    const repository = await newRepository();
    await init(
      repository.root,
      {
        schema: 1,
        models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
        repository: { remote: "origin", integrationBranch: "main" },
        tracker: { provider: "github", project: "owner/repo" },
        verification: { commands: ["test -f README.md"] },
      },
      { skipSkills: true },
    );
    const installed = await readInstalledConfig(repository.root);
    // Legacy: an omitted block resolves to the generated scripts, and it is
    // recorded that way — no `deferred` marker is invented for it.
    expect(installed.delivery).toMatchObject({
      preview: { command: expect.arrayContaining(["scripts/poiesis-preview.mjs"]) },
      staging: { command: expect.arrayContaining(["scripts/poiesis-staging.mjs"]) },
      production: { command: expect.arrayContaining(["scripts/poiesis-production.mjs"]) },
    });
    expect(JSON.stringify(installed.delivery)).not.toContain("deferred");
    for (const target of ["preview", "staging", "production"]) {
      await expect(readFile(join(repository.root, "scripts", `poiesis-${target}.mjs`), "utf8")).resolves.toContain("#!/usr/bin/env node");
    }
  }, 90_000);

  it("keeps inferring the tracker from the Git remote for a noninteractive config that omits the tracker block", async () => {
    const repository = await newRepository("github");
    const result = await composeInitDiscovery(repository.root, {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      delivery: { mode: DEFERRED_DELIVERY_MODE },
      verification: { commands: ["test -f README.md"] },
    });
    // The composer still DISCOVERS the provider/project from the remote; it
    // only stops treating the discovery as a recorded decision.
    expect(result.detections.tracker).toMatchObject({ provider: "github", project: "owner/repo" });
    expect(result.detections.tracker.source).toBe("remote-github");
  });

  it("creates the local store lazily — an interactive local install writes no tracker state", async () => {
    // Break: validating the local tracker by creating its store would make a
    // read-only check mutate the clone.
    const repository = await newRepository();
    const io = new ScriptedIO({
      inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"],
      answers: flaglessAnswers({ [PROMPTS.tracker]: "local", [PROMPTS.deliveryMode]: "deferred" }),
    });
    await runInteractiveInit({ root: repository.root, io });
    const commonDir = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: repository.root })).stdout.trim();
    const store = join(repository.root, commonDir, "poiesis-tracker-v1");
    await expect(readFile(join(store, "store.json"), "utf8")).rejects.toThrow();
  }, 60_000);
});

// =========================================================================
// 8. Ticket #154 — unknown outer delivery keys survive the init-discovery
//    final overlay and the managed config it is written into.
//
//    The composer's final overlay rebuilds `delivery` so the managed
//    Preview / Staging / Production targets replace a `<...>` placeholder
//    with the detected script hint. It rebuilt the block from those three
//    targets alone, so an extension key that the schema accepted (ticket
//    #152) and that `resolveDelivery` carried (ticket #153) was deleted by
//    the one seam that runs after both. The overlay is where the extension
//    disappeared, so the overlay is where it must be preserved.
// =========================================================================

/** The composer-owned literal a detected `scripts/poiesis-<target>` hint produces. */
function hintedDeliveryTarget(target: "preview" | "staging" | "production"): DeliveryTargetConfig {
  return { adapter: "command", command: [`scripts/poiesis-${target}`, "{sha}"] };
}

async function writeDeliveryHints(root: string): Promise<void> {
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const target of ["preview", "staging", "production"] as const) {
    const path = join(root, "scripts", `poiesis-${target}`);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
}

/** A complete draft whose targets are still the canonical template placeholders. */
function templateDraft(delivery: PoiesisConfig["delivery"]): PoiesisConfig {
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    tracker: { provider: "github", project: "owner/repo" },
    delivery,
    verification: { commands: ["test -f README.md"] },
  };
}

type ManagedTarget = "preview" | "staging" | "production";

function placeholderTargets(): Record<ManagedTarget, DeliveryTargetConfig> {
  return {
    preview: { adapter: "command", command: ["<delivery-executable>", "preview", "{sha}"] },
    staging: { adapter: "command", command: ["<delivery-executable>", "staging", "{sha}"] },
    production: { adapter: "command", command: ["<delivery-executable>", "production", "{sha}"] },
  };
}

describe("unknown outer delivery keys survive the init-discovery final overlay", () => {
  it("keeps every extension key while the detected script hints replace the placeholder targets", async () => {
    // Break: the overlay rebuilt `delivery` from the three targets alone, so a
    // key the config accepted was deleted from the very config this install
    // then writes — a runtime that cannot act on a key must not remove it.
    const repository = await newRepository();
    await writeDeliveryHints(repository.root);
    const result = await composeInitDiscovery(
      repository.root,
      templateDraft({
        ...placeholderTargets(),
        experimental: { note: "kept", retries: 2 },
        "author-note": "kept",
      } as PoiesisConfig["delivery"]),
    );
    expect(result.unresolved).toEqual([]);
    expect(result.config).toBeDefined();
    // The three managed targets are the overlay's values, and the two
    // extension keys are still present, unexamined, beside them.
    expect(result.config!.delivery).toEqual({
      experimental: { note: "kept", retries: 2 },
      "author-note": "kept",
      preview: hintedDeliveryTarget("preview"),
      staging: hintedDeliveryTarget("staging"),
      production: hintedDeliveryTarget("production"),
    });
    // The overlay invents no `mode` and drops nothing: the recorded block is
    // exactly the five keys the draft carried plus the three it wrote.
    expect(Object.keys(result.config!.delivery).sort()).toEqual([
      "author-note",
      "experimental",
      "preview",
      "production",
      "staging",
    ]);
  });

  it("keeps the extension keys for a complete configured draft that needs no overlay", async () => {
    // Break: a draft whose targets are already concrete takes the OTHER branch
    // of `replaceTemplateDelivery` (the original is kept, not a script hint).
    // The rebuild is unconditional, so a fix that only guarded the hint
    // substitution would still delete the key here.
    const repository = await newRepository();
    const concrete: Record<ManagedTarget, DeliveryTargetConfig> = {
      preview: { adapter: "command", command: ["./deploy", "preview", "{sha}"] },
      staging: { adapter: "command", command: ["./deploy", "staging", "{sha}"] },
      production: { adapter: "command", command: ["./deploy", "production", "{sha}"] },
    };
    const result = await composeInitDiscovery(
      repository.root,
      templateDraft({
        ...concrete,
        // A target-shaped and mode-shaped extension: neither may introduce,
        // replace, or complete a field Poiesis owns, and neither may reach
        // the outer block as one.
        experimental: { preview: { adapter: "fixture" }, mode: "deferred" },
      } as PoiesisConfig["delivery"]),
    );
    expect(result.unresolved).toEqual([]);
    expect(result.config).toBeDefined();
    expect(result.config!.delivery).toEqual({
      experimental: { preview: { adapter: "fixture" }, mode: "deferred" },
      preview: concrete.preview,
      staging: concrete.staging,
      production: concrete.production,
    });
    // The extension's `mode` never became the block's mode, so the result is
    // still the configured branch and not a silent deferral.
    expect(isDeferredDelivery(result.config!.delivery)).toBe(false);
    expect("mode" in result.config!.delivery).toBe(false);
  });

  it("never lets the overlay carry a reserved `mode` marker into a configured block", async () => {
    // Break: the overlay is a SECOND seam that rebuilds the block, so the
    // reserved-name rule has to hold here too. A partition that filtered only
    // the three targets would carry `mode` through and hand init() a block
    // whose deferred/configured state is ambiguous.
    const repository = await newRepository();
    await writeDeliveryHints(repository.root);
    const result = await composeInitDiscovery(
      repository.root,
      templateDraft({
        ...placeholderTargets(),
        mode: "later",
        experimental: { note: "kept" },
      } as unknown as PoiesisConfig["delivery"]),
    );
    expect(result.unresolved).toEqual([]);
    expect(result.config).toBeDefined();
    // `mode` is a reserved NAME, so it is not an extension; the extension key
    // beside it is, and the three targets resolve to the detected hints.
    expect(result.config!.delivery).toEqual({
      experimental: { note: "kept" },
      preview: hintedDeliveryTarget("preview"),
      staging: hintedDeliveryTarget("staging"),
      production: hintedDeliveryTarget("production"),
    });
    expect(isDeferredDelivery(result.config!.delivery)).toBe(false);
  });

  it("adds no target to a deferred draft and keeps its extension keys", async () => {
    // The deferred branch is the one the overlay must not touch. Deferral is
    // an honest answer to the readiness question, so the composer neither
    // completes it with a generated target nor rewrites its extension keys.
    const repository = await newRepository();
    await writeDeliveryHints(repository.root);
    const result = await composeInitDiscovery(
      repository.root,
      templateDraft({
        mode: DEFERRED_DELIVERY_MODE,
        experimental: { note: "kept" },
      } as PoiesisConfig["delivery"]),
    );
    expect(result.unresolved).toEqual([]);
    expect(result.config).toBeDefined();
    expect(isDeferredDelivery(result.config!.delivery)).toBe(true);
    expect(result.config!.delivery).toEqual({
      experimental: { note: "kept" },
      mode: DEFERRED_DELIVERY_MODE,
    });
  });

  it("never reaches the overlay for a draft that states no delivery block at all", async () => {
    // Break: the omitted block is legacy, not an answered readiness question.
    // If the overlay ran for it, the installed config would record a delivery
    // decision that only the Author can make, and with three detected hints
    // present every per-target question would silently disappear too.
    const repository = await newRepository();
    await writeDeliveryHints(repository.root);
    const draft = templateDraft(undefined);
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.unresolved).toEqual(["delivery.mode"]);
    expect(result.config).toBeUndefined();
  });
});

describe("a configured-draft extension key reaches the managed init config", () => {
  it("persists the extension beside the overlaid script adapters through interactive init", async () => {
    // The composer's final config is what `init()` writes, so a key dropped by
    // the overlay is a key deleted from the Author's managed config. This is
    // the end-to-end shape of the break: the install succeeds and the
    // extension is gone.
    restoreForge = await installFakeForge();
    const repository = await newRepository();
    await writeDeliveryHints(repository.root);
    const io = new ScriptedIO({ inventory: ["openai/gpt-5.6-sol", "minimax/MiniMax-M3"] });
    await runInteractiveInit({
      root: repository.root,
      io,
      draft: templateDraft({
        ...placeholderTargets(),
        experimental: { note: "kept", retries: 2 },
      } as PoiesisConfig["delivery"]),
    });
    const installed = await readInstalledConfig(repository.root);
    expect(installed.delivery).toEqual({
      experimental: { note: "kept", retries: 2 },
      preview: hintedDeliveryTarget("preview"),
      staging: hintedDeliveryTarget("staging"),
      production: hintedDeliveryTarget("production"),
    });
  }, 90_000);
});

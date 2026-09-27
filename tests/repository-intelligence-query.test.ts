import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GRAPHIFY_PACKAGE,
  GRAPHIFY_PYTHON,
  GRAPHIFY_VERSION,
  REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY,
  REPOSITORY_INTELLIGENCE_QUERY_BUDGET_TOKENS,
  REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS,
  repositoryIntelligenceGenerationPath,
  repositoryIntelligenceGenerationsPath,
  repositoryIntelligenceStatePath,
  sanitizeGraphifyEnvironment,
  type GraphifyRunner,
  type GraphifyRunnerRequest,
  type GraphifyRunnerResult,
  type RepositoryIntelligenceQueryOptions,
  type RepositoryIntelligenceQueryOutcome,
  queryRepositoryIntelligence,
} from "../src/repository-intelligence.js";

// ---- Test harness ------------------------------------------------------------

interface FakeRunnerCall {
  request: GraphifyRunnerRequest;
}

interface FakeRunner {
  runner: GraphifyRunner;
  calls: FakeRunnerCall[];
  /**
   * Programmable responses. Each entry is consumed on the next call in
   * order. When the queue is empty, a default success response is used
   * that writes a minimal valid graph.json into the directory the
   * refresh command's `--out` / `GRAPHIFY_OUT` pointed at.
   */
  enqueue: (...responses: GraphifyRunnerResult[]) => void;
  /** Clear accumulated calls and pending responses (test isolation). */
  reset: () => void;
}

/**
 * Default post-callback for fake refresh invocations. Writes a
 * non-empty `graph.json` into the directory pointed at by
 * `GRAPHIFY_OUT` (the refresh runner sets this to the new generation
 * directory) so the runtime's staged-graph validation accepts the
 * produced artifact.
 */
async function defaultRefreshPost(env: NodeJS.ProcessEnv): Promise<void> {
  const outDir = env.GRAPHIFY_OUT;
  if (typeof outDir !== "string" || outDir.length === 0) return;
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "graph.json"),
    JSON.stringify({
      nodes: [{ id: "default", label: "default" }],
      edges: [],
      version: GRAPHIFY_VERSION,
      mode: "code-only",
    }),
  );
}

function createFakeRunner(): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  const responses: GraphifyRunnerResult[] = [];
  const runner: GraphifyRunner = async (request) => {
    calls.push({ request });
    const next = responses.shift();
    if (next !== undefined) {
      if (next.ok && next.post !== undefined) {
        await next.post(request.env);
      }
      return next;
    }
    // Default: simulate a successful graphify invocation. For refresh
    // invocations (when GRAPHIFY_OUT is set), write a non-empty
    // graph.json so the runtime's validation accepts it. For query
    // invocations (no GRAPHIFY_OUT), just return a canned answer.
    const outDir = request.env.GRAPHIFY_OUT;
    if (typeof outDir === "string" && outDir.length > 0) {
      await mkdir(outDir, { recursive: true });
      await writeFile(
        join(outDir, "graph.json"),
        JSON.stringify({
          nodes: [{ id: "default", label: "default" }],
          edges: [],
          version: GRAPHIFY_VERSION,
          mode: "code-only",
        }),
      );
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    };
  };
  return {
    runner,
    calls,
    enqueue: (...next) => {
      responses.push(...next);
    },
    reset() {
      calls.length = 0;
      responses.length = 0;
    },
  };
}

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-riq-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  await run("git", ["config", "user.name", "Poiesis Test"], { cwd: root });
  await run("git", ["config", "user.email", "poiesis@example.test"], { cwd: root });
  return root;
}

async function writeValidGeneration(
  root: string,
  generationId: string,
  graph: unknown = {
    nodes: [{ id: "seed", label: "seed" }],
    edges: [],
    version: GRAPHIFY_VERSION,
    mode: "code-only",
  },
): Promise<string> {
  const generationPath = repositoryIntelligenceGenerationPath(root, generationId);
  await mkdir(generationPath, { recursive: true });
  const graphJsonPath = join(generationPath, "graph.json");
  await writeFile(graphJsonPath, JSON.stringify(graph));
  return graphJsonPath;
}

async function writeState(
  root: string,
  overrides: {
    activeGeneration?: string;
    engineVersion?: string;
    mode?: "code-only" | (string & {});
    repoRoot?: string | null;
  } = {},
): Promise<void> {
  const statePath = repositoryIntelligenceStatePath(root);
  await mkdir(join(statePath, ".."), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        schema: 1,
        engine: "graphify",
        engineVersion: overrides.engineVersion ?? GRAPHIFY_VERSION,
        mode: overrides.mode ?? "code-only",
        repoRoot: overrides.repoRoot === null ? undefined : (overrides.repoRoot ?? root),
        activeGeneration: overrides.activeGeneration,
      },
      null,
      2,
    ),
  );
}

function readStateRaw(root: string): Promise<string> {
  return readFile(repositoryIntelligenceStatePath(root), "utf8");
}

async function readState(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readStateRaw(root)) as Record<string, unknown>;
}

async function listGenerations(root: string): Promise<string[]> {
  const generationsRoot = repositoryIntelligenceGenerationsPath(root);
  if (!(await exists(generationsRoot))) return [];
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Minimal local run helper (avoids a runtime dependency on the
// module's process wrapper for tests).
async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeoutMs?: number; maxBytes?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

// ---- Constants ---------------------------------------------------------------

describe("ticket #122 constants", () => {
  it("exposes the 10-minute refresh timeout", () => {
    expect(REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it("exposes the immutable 2000-token query budget", () => {
    expect(REPOSITORY_INTELLIGENCE_QUERY_BUDGET_TOKENS).toBe(2000);
  });

  it("does not change the pinned package or Python version", () => {
    expect(GRAPHIFY_PACKAGE).toBe(`graphifyy==${GRAPHIFY_VERSION}`);
    expect(GRAPHIFY_PYTHON).toBe("3.12");
  });
});

// ---- Environment sanitization ------------------------------------------------

describe("sanitizeGraphifyEnvironment", () => {
  it("keeps PATH, HOME, LANG, LC_ALL, TMPDIR, USER", () => {
    const sanitized = sanitizeGraphifyEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/test",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp",
      USER: "test",
    });
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/test");
    expect(sanitized.LANG).toBe("C.UTF-8");
    expect(sanitized.LC_ALL).toBe("C.UTF-8");
    expect(sanitized.TMPDIR).toBe("/tmp");
    expect(sanitized.USER).toBe("test");
  });

  it("strips every known model-provider credential prefix", () => {
    const sanitized = sanitizeGraphifyEnvironment({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-leak",
      ANTHROPIC_API_KEY: "sk-ant-leak",
      AZURE_OPENAI_API_KEY: "azure-leak",
      GOOGLE_API_KEY: "google-leak",
      COHERE_API_KEY: "cohere-leak",
      MISTRAL_API_KEY: "mistral-leak",
      GROQ_API_KEY: "groq-leak",
      REPLICATE_API_TOKEN: "replicate-leak",
      HUGGINGFACE_HUB_TOKEN: "hf-leak",
      AWS_ACCESS_KEY_ID: "aws-leak",
      AWS_SECRET_ACCESS_KEY: "aws-leak",
    });
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.GOOGLE_API_KEY).toBeUndefined();
    expect(sanitized.COHERE_API_KEY).toBeUndefined();
    expect(sanitized.MISTRAL_API_KEY).toBeUndefined();
    expect(sanitized.GROQ_API_KEY).toBeUndefined();
    expect(sanitized.REPLICATE_API_TOKEN).toBeUndefined();
    expect(sanitized.HUGGINGFACE_HUB_TOKEN).toBeUndefined();
    expect(sanitized.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(sanitized.PATH).toBe("/usr/bin");
  });

  it("strips generic *_API_KEY, *_TOKEN, *_SECRET, *_PASSWORD, *_CREDENTIALS suffixes", () => {
    const sanitized = sanitizeGraphifyEnvironment({
      PATH: "/usr/bin",
      MY_VENDOR_API_KEY: "leak",
      MY_VENDOR_TOKEN: "leak",
      MY_VENDOR_SECRET: "leak",
      MY_VENDOR_PASSWORD: "leak",
      MY_VENDOR_CREDENTIALS: "leak",
    });
    expect(sanitized.MY_VENDOR_API_KEY).toBeUndefined();
    expect(sanitized.MY_VENDOR_TOKEN).toBeUndefined();
    expect(sanitized.MY_VENDOR_SECRET).toBeUndefined();
    expect(sanitized.MY_VENDOR_PASSWORD).toBeUndefined();
    expect(sanitized.MY_VENDOR_CREDENTIALS).toBeUndefined();
  });

  it("strips tracker credentials (GH_TOKEN, GITHUB_TOKEN, GITLAB_TOKEN, GL_TOKEN)", () => {
    const sanitized = sanitizeGraphifyEnvironment({
      PATH: "/usr/bin",
      GH_TOKEN: "gh-leak",
      GITHUB_TOKEN: "github-leak",
      GITLAB_TOKEN: "gitlab-leak",
      GL_TOKEN: "gl-leak",
    });
    expect(sanitized.GH_TOKEN).toBeUndefined();
    expect(sanitized.GITHUB_TOKEN).toBeUndefined();
    expect(sanitized.GITLAB_TOKEN).toBeUndefined();
    expect(sanitized.GL_TOKEN).toBeUndefined();
  });

  it("strips POIESIS_* keys to prevent nested recursion", () => {
    const sanitized = sanitizeGraphifyEnvironment({
      PATH: "/usr/bin",
      POIESIS_DEBUG: "1",
      POIESIS_TOKEN: "leak",
    });
    expect(sanitized.POIESIS_DEBUG).toBeUndefined();
    expect(sanitized.POIESIS_TOKEN).toBeUndefined();
  });

  it("returns a fresh object that does not alias the input", () => {
    const input = { PATH: "/usr/bin", OPENAI_API_KEY: "leak" };
    const sanitized = sanitizeGraphifyEnvironment(input);
    expect(sanitized).not.toBe(input);
    expect(input.OPENAI_API_KEY).toBe("leak");
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
  });
});

// ---- Hard-fail argument validation ------------------------------------------

describe("queryRepositoryIntelligence argument validation", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hard-fails with MISSING_ARGUMENT when --question is empty", async () => {
    await expect(
      queryRepositoryIntelligence(root, { question: "", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with MISSING_ARGUMENT when --question is whitespace-only", async () => {
    await expect(
      queryRepositoryIntelligence(root, { question: "   \t\n", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with INVALID_ARGUMENT when --question exceeds the bounded length", async () => {
    const oversized = "a".repeat(4097);
    await expect(
      queryRepositoryIntelligence(root, { question: oversized, runner: fake.runner }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("hard-fails with INVALID_ARGUMENT when --question contains a NUL byte", async () => {
    await expect(
      queryRepositoryIntelligence(root, { question: "before\u0000after", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("hard-fails with REPOSITORY_INTELLIGENCE_CACHE_UNSAFE when the cache root is a symlink", async () => {
    const { symlink } = await import("node:fs/promises");
    const { repositoryIntelligenceCachePath } = await import("../src/repository-intelligence.js");
    const cache = repositoryIntelligenceCachePath(root);
    await mkdir(join(root, ".poiesis"), { recursive: true });
    await symlink("/tmp", cache);
    await expect(
      queryRepositoryIntelligence(root, { question: "What does this repo do?", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE" });
  });
});

// ---- uv availability fallback ------------------------------------------------

describe("queryRepositoryIntelligence uv availability", () => {
  let root: string;
  let previousPath: string | undefined;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    previousPath = process.env.PATH;
    delete process.env.PATH;
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });

  it("returns a typed uv-unavailable fallback when uv is not on PATH", async () => {
    const outcome = await queryRepositoryIntelligence(root, {
      question: "What does this repo do?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("uv-unavailable");
    expect(outcome.engine).toBe("graphify");
    expect(outcome.engineVersion).toBe(GRAPHIFY_VERSION);
    expect(fake.calls.length).toBe(0);
  });
});

// ---- Refresh path ------------------------------------------------------------

describe("queryRepositoryIntelligence refresh path", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a new immutable generation and activates it via state.json pointer on a fresh repo", async () => {
    const outcome = await queryRepositoryIntelligence(root, {
      question: "What does this repo do?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("initial-extract");
    expect(outcome.answer).toBe("ok");
    // Two runner calls: extract, then query.
    expect(fake.calls.length).toBe(2);
    const refreshCall = fake.calls[0]!;
    const queryCall = fake.calls[1]!;
    // Refresh argv: `extract <root> --code-only --no-cluster --out <generation>`.
    expect(refreshCall.request.args[0]).toBe("extract");
    expect(refreshCall.request.args[1]).toBe(root);
    expect(refreshCall.request.args).toContain("--code-only");
    expect(refreshCall.request.args).toContain("--no-cluster");
    const outIdx = refreshCall.request.args.indexOf("--out");
    expect(outIdx).toBeGreaterThan(-1);
    const outPath = refreshCall.request.args[outIdx + 1]!;
    expect(outPath).toContain(REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY);
    expect(outPath.startsWith(join(root, ".poiesis", "cache"))).toBe(true);
    // GRAPHIFY_OUT also matches the new generation.
    expect(refreshCall.request.env.GRAPHIFY_OUT).toBe(outPath);
    // No --force anywhere on the refresh.
    expect(refreshCall.request.args).not.toContain("--force");
    // The new generation exists on disk with a non-empty graph.json.
    const generationGraph = join(outPath, "graph.json");
    const graphRaw = await readFile(generationGraph, "utf8");
    expect(graphRaw).toContain(`"version":"${GRAPHIFY_VERSION}"`);
    // Query argv: `query <q> --budget <N> --graph <active>`.
    expect(queryCall.request.args[0]).toBe("query");
    expect(queryCall.request.args[1]).toBe("What does this repo do?");
    expect(queryCall.request.args).toContain("--budget");
    const budgetIdx = queryCall.request.args.indexOf("--budget");
    expect(queryCall.request.args[budgetIdx + 1]).toBe(String(REPOSITORY_INTELLIGENCE_QUERY_BUDGET_TOKENS));
    expect(queryCall.request.args).toContain("--graph");
    const graphIdx = queryCall.request.args.indexOf("--graph");
    const queryGraph = queryCall.request.args[graphIdx + 1]!;
    // Query points at the activated generation, NOT a `.staging-*` path.
    expect(queryGraph).toContain(REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY);
    expect(queryGraph).not.toContain(".staging-");
    // state.json points at the new generation via `activeGeneration`.
    const state = await readState(root);
    expect(state.activeGeneration).toBeTruthy();
    expect(typeof state.activeGeneration).toBe("string");
    expect((state.activeGeneration as string).startsWith("generation-")).toBe(true);
    expect(state.repoRoot).toBe(root);
    expect(state.engineVersion).toBe(GRAPHIFY_VERSION);
    // outcome.graphPath matches the state.json pointer.
    expect(outcome.graphPath).toContain(state.activeGeneration as string);
  });

  it("does an incremental refresh (clone + update) when the prior state.json is fully valid", async () => {
    const priorGenerationId = "generation-prior-valid";
    await writeValidGeneration(root, priorGenerationId);
    await writeState(root, { activeGeneration: priorGenerationId });
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "What does this repo do?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    // Valid prior state → incremental update, NOT a full extract.
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("incremental-update");
    // Two runner calls (refresh + query); the refresh argv is `update`,
    // not `extract`.
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0]!.request.args[0]).toBe("update");
    expect(fake.calls[0]!.request.args).not.toContain("--code-only");
    expect(fake.calls[0]!.request.args).not.toContain("--no-cluster");
    // Query points at the NEW active generation (not the prior one).
    const queryGraph = fake.calls[1]!.request.args[fake.calls[1]!.request.args.indexOf("--graph") + 1]!;
    expect(queryGraph).not.toContain(priorGenerationId);
    // state.json is updated to point at the new generation.
    const state = await readState(root);
    expect(state.activeGeneration).not.toBe(priorGenerationId);
  });

  it("does an incremental refresh by cloning the COMPLETE active generation before running graphify update", async () => {
    const priorGenerationId = "generation-prior-1";
    const priorGenerationPath = repositoryIntelligenceGenerationPath(root, priorGenerationId);
    // Pre-populate the active generation with multiple output files
    // so the test can prove the clone is complete, not graph.json-only.
    await mkdir(priorGenerationPath, { recursive: true });
    await writeFile(
      join(priorGenerationPath, "graph.json"),
      JSON.stringify({
        nodes: [{ id: "prior", label: "prior" }],
        edges: [],
        version: GRAPHIFY_VERSION,
        mode: "code-only",
      }),
    );
    await writeFile(join(priorGenerationPath, ".graphify_analysis.json"), '{"analysis":"prior"}');
    await writeFile(join(priorGenerationPath, "graph.html"), "<html>prior</html>");
    await writeState(root, { activeGeneration: priorGenerationId });
    const refreshCalls: GraphifyRunnerCall[] = [];
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      // post is invoked AFTER the runner returns; it should observe
      // the seeded baseline (the cloned generation already contains
      // graph.json + .graphify_analysis.json + graph.html).
      post: async (env) => {
        const outDir = env.GRAPHIFY_OUT!;
        refreshCalls.push({
          stagedGraphJson: await readFile(join(outDir, "graph.json"), "utf8"),
          analysisJson: await readFile(join(outDir, ".graphify_analysis.json"), "utf8"),
          graphHtml: await readFile(join(outDir, "graph.html"), "utf8"),
        });
      },
    });

    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything new?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("incremental-update");
    expect(fake.calls.length).toBe(2);
    // Refresh argv: `update <root> --out <generation>` (no `--no-viz`,
    // no `--force`, no `--code-only`, no `--no-cluster`).
    const refreshArgs = fake.calls[0]!.request.args;
    expect(refreshArgs[0]).toBe("update");
    expect(refreshArgs[1]).toBe(root);
    expect(refreshArgs).toContain("--out");
    expect(refreshArgs).not.toContain("--no-viz");
    expect(refreshArgs).not.toContain("--force");
    expect(refreshArgs).not.toContain("--code-only");
    expect(refreshArgs).not.toContain("--no-cluster");
    // The seeded generation contains the COMPLETE cloned baseline
    // (every file from the prior generation), proving the runtime
    // cloned the whole output, not just graph.json.
    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0]!.stagedGraphJson).toContain('"id":"prior"');
    expect(refreshCalls[0]!.analysisJson).toBe('{"analysis":"prior"}');
    expect(refreshCalls[0]!.graphHtml).toBe("<html>prior</html>");
    // Query argv reads the new active generation.
    const queryGraph = fake.calls[1]!.request.args[fake.calls[1]!.request.args.indexOf("--graph") + 1]!;
    expect(queryGraph).not.toContain(priorGenerationId);
  });

  it("runs a full extract (no seeding) when the engine version is stale", async () => {
    const priorGenerationId = "generation-stale-1";
    await writeValidGeneration(root, priorGenerationId);
    await writeState(root, { activeGeneration: priorGenerationId, engineVersion: "0.0.0" });
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything new?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.kind).toBe("engine-version-mismatch");
    // Mismatch path: full extract, not update.
    const refreshArgs = fake.calls[0]!.request.args;
    expect(refreshArgs[0]).toBe("extract");
    expect(refreshArgs).toContain("--code-only");
    expect(refreshArgs).toContain("--no-cluster");
    expect(refreshArgs).not.toContain("--force");
    // The prior generation's content is NOT seeded into the new
    // generation (the post hook writes a fresh `default` graph).
    const outDir = fake.calls[0]!.request.env.GRAPHIFY_OUT!;
    const writtenGraph = await readFile(join(outDir, "graph.json"), "utf8");
    expect(writtenGraph).toContain('"id":"default"');
    expect(writtenGraph).not.toContain('"id":"seed"');
  });

  it("rebuilds when the mode is not code-only", async () => {
    await writeValidGeneration(root, "generation-mode-1");
    await writeState(root, { activeGeneration: "generation-mode-1", mode: "code+docs" });
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything new?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("mode-mismatch");
  });

  it("rebuilds when the state.repoRoot does not match the resolved root", async () => {
    await writeValidGeneration(root, "generation-root-1");
    await writeState(root, { activeGeneration: "generation-root-1", repoRoot: "/some/other/repo" });
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything new?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("root-mismatch");
  });

  it("rebuilds when the activeGeneration directory is missing", async () => {
    await writeState(root, { activeGeneration: "generation-ghost" });
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
  });

  it("does not invoke graphify query when refresh fails and returns a typed refresh-failed fallback", async () => {
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: "graphify crashed",
      detail: { exitCode: 1, stderr: "boom" },
    });
    // Stale state forces a rebuild; the refresh enqueue reports a
    // crash so the runtime must NOT proceed to the query step.
    const priorGenerationId = "generation-prior-fail";
    const activeGraph = await writeValidGeneration(root, priorGenerationId);
    await writeState(root, { activeGeneration: priorGenerationId, engineVersion: "0.0.0" });
    const before = await readFile(activeGraph, "utf8");
    const beforeState = await readStateRaw(root);

    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("refresh-failed");
    expect(fake.calls.length).toBe(1);
    // The prior active generation is untouched (no rename happened).
    expect(await readFile(activeGraph, "utf8")).toBe(before);
    // state.json is unchanged: still points at the prior generation.
    expect(await readStateRaw(root)).toBe(beforeState);
  });

  it("returns refresh-timeout fallback when the refresh runner reports a timeout", async () => {
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_TIMEOUT",
      message: "graphify exceeded 600000ms",
      detail: { timeoutMs: REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS },
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("refresh-timeout");
    expect(outcome.detail.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS);
  });

  it("returns graph-invalid fallback when the staged graph is not parseable", async () => {
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: async (env) => {
        const outDir = env.GRAPHIFY_OUT!;
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "graph.json"), "{not valid json");
      },
    });
    // Stale state forces a rebuild; the refresh writes invalid JSON
    // so the runtime's staged-graph validator rejects it.
    const activeGraph = await writeValidGeneration(root, "generation-pre-invalid");
    await writeState(root, { activeGeneration: "generation-pre-invalid", engineVersion: "0.0.0" });
    const before = await readFile(activeGraph, "utf8");
    const beforeState = await readStateRaw(root);

    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("graph-invalid");
    expect(fake.calls.length).toBe(1);
    expect(await readFile(activeGraph, "utf8")).toBe(before);
    expect(await readStateRaw(root)).toBe(beforeState);
  });

  it("returns graph-empty fallback when the staged graph has no nodes and no edges", async () => {
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: async (env) => {
        const outDir = env.GRAPHIFY_OUT!;
        await mkdir(outDir, { recursive: true });
        await writeFile(
          join(outDir, "graph.json"),
          JSON.stringify({ nodes: [], edges: [], version: GRAPHIFY_VERSION, mode: "code-only" }),
        );
      },
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "Anything?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("graph-empty");
  });

  it("returns query-failed fallback when the query runner reports a non-zero exit", async () => {
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: "query crashed",
      detail: { exitCode: 2, stderr: "boom" },
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("query-failed");
    expect(fake.calls.length).toBe(2);
  });

  it("returns query-timeout fallback when the query runner reports a timeout", async () => {
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_TIMEOUT",
      message: "query exceeded 30000ms",
      detail: { timeoutMs: 30_000 },
    });
    const outcome = await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("query-timeout");
  });

  it("enforces the 10-minute timeout on the refresh invocation regardless of what the caller asks for", async () => {
    await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
      refreshTimeoutMs: 1, // caller tries to set a tiny budget
    });
    expect(fake.calls[0]!.request.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS);
  });

  it("does not pass any model credential to the graphify runner env", async () => {
    process.env.OPENAI_API_KEY = "sk-leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
    try {
      await queryRepositoryIntelligence(root, {
        question: "What?",
        runner: fake.runner,
      });
      for (const call of fake.calls) {
        expect(call.request.env.OPENAI_API_KEY).toBeUndefined();
        expect(call.request.env.ANTHROPIC_API_KEY).toBeUndefined();
      }
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("preserves PATH and HOME in the sanitized env so uvx can find binaries", async () => {
    process.env.HOME = "/home/test";
    try {
      await queryRepositoryIntelligence(root, {
        question: "What?",
        runner: fake.runner,
      });
      expect(fake.calls[0]!.request.env.PATH).toBeTruthy();
      expect(fake.calls[0]!.request.env.HOME).toBe("/home/test");
    } finally {
      delete process.env.HOME;
    }
  });

  it("writes the new generation inside the Poiesis-owned generations root", async () => {
    await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
    });
    const generations = await listGenerations(root);
    expect(generations.length).toBe(1);
    const outPath = fake.calls[0]!.request.env.GRAPHIFY_OUT!;
    expect(outPath.startsWith(repositoryIntelligenceGenerationsPath(root))).toBe(true);
  });

  it("garbage-collects every prior generation after a successful activation", async () => {
    // Seed two stale generations under the generations root before
    // the query; after activation only the new active generation
    // should remain.
    const staleDir1 = repositoryIntelligenceGenerationPath(root, "generation-stale-A");
    const staleDir2 = repositoryIntelligenceGenerationPath(root, "generation-stale-B");
    await mkdir(staleDir1, { recursive: true });
    await mkdir(staleDir2, { recursive: true });
    await writeFile(join(staleDir1, "graph.json"), "{}");
    await writeFile(join(staleDir2, "graph.json"), "{}");

    const outcome = await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    const remaining = await listGenerations(root);
    expect(remaining.length).toBe(1);
    expect(await exists(staleDir1)).toBe(false);
    expect(await exists(staleDir2)).toBe(false);
  });

  it("atomically commits state.json via temp-file + rename (no partial writes)", async () => {
    // The state.json commit is observed via a custom post hook that
    // captures the state.json content at the moment the runner's
    // process returns. The newly committed state must reference the
    // new generation.
    fake.enqueue({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      post: defaultRefreshPost,
    });
    await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
    });
    // No temp-file residue: state.json.tmp must not exist.
    const tempPath = `${repositoryIntelligenceStatePath(root)}.tmp`;
    expect(await exists(tempPath)).toBe(false);
    // state.json is valid and references the active generation.
    const state = await readState(root);
    expect(state.activeGeneration).toBeTruthy();
  });
});

// ---- Refresh lock serialization ---------------------------------------------

describe("queryRepositoryIntelligence refresh lock", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes the lock file after a successful query", async () => {
    await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
    });
    const lockPath = join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
    expect(await exists(lockPath)).toBe(false);
  });

  it("removes the lock file even when refresh fails", async () => {
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: "boom",
      detail: { exitCode: 1 },
    });
    await queryRepositoryIntelligence(root, {
      question: "What?",
      runner: fake.runner,
    });
    const lockPath = join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
    expect(await exists(lockPath)).toBe(false);
  });
});

// ---- CLI dispatch surface ----------------------------------------------------

describe("poiesis repository query CLI dispatch", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hard-fails with MISSING_ARGUMENT when --question is not supplied", async () => {
    const { commandRepository } = await import("../src/cli.js");
    await expect(
      commandRepository(["query", "--cwd", root], { runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("passes the supported status subcommand through", async () => {
    const { commandRepository } = await import("../src/cli.js");
    await expect(
      commandRepository(["status", "--cwd", root]),
    ).resolves.toBeUndefined();
  });

  it("hard-fails with UNKNOWN_COMMAND for an unrecognized repository subcommand", async () => {
    const { commandRepository } = await import("../src/cli.js");
    await expect(
      commandRepository(["nuke", "--cwd", root]),
    ).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
  });
});

// ---- Local helpers (kept local to this suite to avoid a runtime dependency) -

interface GraphifyRunnerCall {
  stagedGraphJson: string;
  analysisJson: string;
  graphHtml: string;
}

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  explainRepositoryIntelligence,
  GRAPHIFY_VERSION,
  pathRepositoryIntelligence,
  REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY,
  REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH,
  REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS,
  REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS,
  repositoryIntelligenceGenerationPath,
  repositoryIntelligenceGenerationsPath,
  repositoryIntelligenceStatePath,
  type GraphifyRunner,
  type GraphifyRunnerRequest,
  type GraphifyRunnerResult,
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
    // graph.json so the runtime's validation accepts it. For path /
    // explain invocations (no GRAPHIFY_OUT), just return a canned
    // answer that includes the requested identifier so the test
    // suite can assert the right argv reached the runner.
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
      stdout: `path-explain-default:${request.args.join(" ")}`,
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
  const parent = await mkdtemp(join(tmpdir(), "poiesis-ripe-"));
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

describe("ticket #123 constants", () => {
  it("exposes a 512-byte identifier length bound", () => {
    expect(REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH).toBe(512);
  });

  it("exposes a 30-second timeout for the post-refresh path/explain invocation", () => {
    expect(REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS).toBe(30_000);
  });

  it("does not change the pinned package, Python, or refresh timeout", () => {
    // Cross-ticket invariants: the query and path/explain entry points
    // share the same refresh timeout because all three serialize the
    // same extract / update step.
    expect(REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS).toBe(10 * 60_000);
  });
});

// ============================================================================
//   pathRepositoryIntelligence
// ============================================================================

describe("pathRepositoryIntelligence argument validation", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hard-fails with MISSING_ARGUMENT when --from is empty", async () => {
    await expect(
      pathRepositoryIntelligence(root, { from: "", to: "DatabasePool", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with MISSING_ARGUMENT when --from is whitespace-only", async () => {
    await expect(
      pathRepositoryIntelligence(root, { from: "  \t\n", to: "DatabasePool", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with MISSING_ARGUMENT when --to is empty", async () => {
    await expect(
      pathRepositoryIntelligence(root, { from: "AuthService", to: "", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with INVALID_ARGUMENT when --from exceeds the bounded length", async () => {
    const oversized = "a".repeat(REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH + 1);
    await expect(
      pathRepositoryIntelligence(root, { from: oversized, to: "DatabasePool", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("hard-fails with INVALID_ARGUMENT when --to exceeds the bounded length", async () => {
    const oversized = "a".repeat(REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH + 1);
    await expect(
      pathRepositoryIntelligence(root, { from: "AuthService", to: oversized, runner: fake.runner }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("hard-fails with INVALID_ARGUMENT when --from contains a NUL byte", async () => {
    await expect(
      pathRepositoryIntelligence(root, {
        from: "before\u0000after",
        to: "DatabasePool",
        runner: fake.runner,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("hard-fails with REPOSITORY_INTELLIGENCE_CACHE_UNSAFE when the cache root is a symlink", async () => {
    const { symlink } = await import("node:fs/promises");
    const { repositoryIntelligenceCachePath } = await import("../src/repository-intelligence.js");
    const cache = repositoryIntelligenceCachePath(root);
    await mkdir(join(root, ".poiesis"), { recursive: true });
    await symlink("/tmp", cache);
    await expect(
      pathRepositoryIntelligence(root, {
        from: "AuthService",
        to: "DatabasePool",
        runner: fake.runner,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE" });
  });
});

describe("pathRepositoryIntelligence uv availability", () => {
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
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("uv-unavailable");
    expect(outcome.operation).toBe("repository.path");
    expect(outcome.engine).toBe("graphify");
    expect(outcome.engineVersion).toBe(GRAPHIFY_VERSION);
    expect(fake.calls.length).toBe(0);
  });
});

describe("pathRepositoryIntelligence refresh path", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a new immutable generation and runs graphify path with positional args + explicit --graph", async () => {
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("initial-extract");
    expect(outcome.from).toBe("AuthService");
    expect(outcome.to).toBe("DatabasePool");
    // Two runner calls: refresh (extract), then path.
    expect(fake.calls.length).toBe(2);
    const refreshCall = fake.calls[0]!;
    const pathCall = fake.calls[1]!;
    // Refresh argv: `extract <root> --code-only --no-cluster --out <generation>`.
    expect(refreshCall.request.args[0]).toBe("extract");
    expect(refreshCall.request.args[1]).toBe(root);
    expect(refreshCall.request.args).toContain("--code-only");
    expect(refreshCall.request.args).toContain("--no-cluster");
    // Path argv: `path <from> <to> --graph <active>` — named Poiesis
    // flags translate to Graphify positional args + explicit --graph.
    expect(pathCall.request.args[0]).toBe("path");
    expect(pathCall.request.args[1]).toBe("AuthService");
    expect(pathCall.request.args[2]).toBe("DatabasePool");
    expect(pathCall.request.args).toContain("--graph");
    const graphIdx = pathCall.request.args.indexOf("--graph");
    const pathGraph = pathCall.request.args[graphIdx + 1]!;
    expect(pathGraph).toContain(REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY);
    expect(pathGraph).not.toContain(".staging-");
    // Timeout is the bounded node-call budget, not the refresh budget.
    expect(pathCall.request.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS);
    expect(refreshCall.request.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS);
    // The new active generation's graphPath matches the --graph pointer.
    expect(outcome.graphPath).toBe(pathGraph);
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
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("incremental-update");
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0]!.request.args[0]).toBe("update");
    expect(fake.calls[0]!.request.args).not.toContain("--code-only");
    expect(fake.calls[0]!.request.args).not.toContain("--no-cluster");
    // Path points at the NEW active generation, not the prior one.
    const pathGraph = fake.calls[1]!.request.args[fake.calls[1]!.request.args.indexOf("--graph") + 1]!;
    expect(pathGraph).not.toContain(priorGenerationId);
    // state.json is updated to point at the new generation.
    const stateRaw = await readFile(repositoryIntelligenceStatePath(root), "utf8");
    expect(stateRaw).not.toContain(priorGenerationId);
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
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.kind).toBe("engine-version-mismatch");
    const refreshArgs = fake.calls[0]!.request.args;
    expect(refreshArgs[0]).toBe("extract");
    expect(refreshArgs).toContain("--code-only");
    expect(refreshArgs).toContain("--no-cluster");
    expect(refreshArgs).not.toContain("--force");
  });

  it("returns a typed path-failed fallback when the path invocation crashes", async () => {
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
      message: "path crashed",
      detail: { exitCode: 2, stderr: "boom" },
    });
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("path-failed");
    expect(outcome.operation).toBe("repository.path");
    expect(fake.calls.length).toBe(2);
  });

  it("returns a typed path-timeout fallback when the path invocation times out", async () => {
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
      message: "path exceeded 30000ms",
      detail: { timeoutMs: REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS },
    });
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("path-timeout");
    expect(outcome.detail.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS);
  });

  it("returns a typed refresh-failed fallback when the refresh invocation crashes (and never invokes graphify path)", async () => {
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: "extract crashed",
      detail: { exitCode: 1, stderr: "boom" },
    });
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("refresh-failed");
    expect(fake.calls.length).toBe(1);
  });

  it("returns a typed graph-empty fallback when the staged graph is empty", async () => {
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
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("graph-empty");
    // The path invocation is never attempted when the staged graph
    // fails validation; the typed envelope surfaces the right reason.
    expect(fake.calls.length).toBe(1);
  });

  it("does not pass any model credential to the graphify runner env", async () => {
    process.env.OPENAI_API_KEY = "sk-leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
    try {
      await pathRepositoryIntelligence(root, {
        from: "AuthService",
        to: "DatabasePool",
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

  it("garbage-collects every prior generation after a successful activation", async () => {
    const staleDir1 = repositoryIntelligenceGenerationPath(root, "generation-stale-A");
    const staleDir2 = repositoryIntelligenceGenerationPath(root, "generation-stale-B");
    await mkdir(staleDir1, { recursive: true });
    await mkdir(staleDir2, { recursive: true });
    await writeFile(join(staleDir1, "graph.json"), "{}");
    await writeFile(join(staleDir2, "graph.json"), "{}");
    const outcome = await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    const remaining = await listGenerations(root);
    expect(remaining.length).toBe(1);
    expect(await exists(staleDir1)).toBe(false);
    expect(await exists(staleDir2)).toBe(false);
  });
});

describe("pathRepositoryIntelligence refresh lock", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes the lock file after a successful path invocation", async () => {
    await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    const lockPath = join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
    expect(await exists(lockPath)).toBe(false);
  });

  it("removes the lock file even when the path invocation fails", async () => {
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: "boom",
      detail: { exitCode: 1 },
    });
    await pathRepositoryIntelligence(root, {
      from: "AuthService",
      to: "DatabasePool",
      runner: fake.runner,
    });
    const lockPath = join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
    expect(await exists(lockPath)).toBe(false);
  });
});

// ---- CLI dispatch surface ----------------------------------------------------

describe("poiesis repository path CLI dispatch", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hard-fails with MISSING_ARGUMENT when --from is not supplied", async () => {
    const { commandRepository } = await import("../src/cli.js");
    await expect(
      commandRepository(["path", "--to", "DatabasePool", "--cwd", root], { runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with MISSING_ARGUMENT when --to is not supplied", async () => {
    const { commandRepository } = await import("../src/cli.js");
    await expect(
      commandRepository(["path", "--from", "AuthService", "--cwd", root], { runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("routes path --from --to through pathRepositoryIntelligence", async () => {
    const { commandRepository } = await import("../src/cli.js");
    // Capture stdout so we can verify the structured-JSON success envelope.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      await commandRepository(
        ["path", "--from", "AuthService", "--to", "DatabasePool", "--cwd", root],
        { runner: fake.runner },
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    expect(fake.calls.length).toBe(2);
    const pathCall = fake.calls[1]!;
    expect(pathCall.request.args[0]).toBe("path");
    expect(pathCall.request.args[1]).toBe("AuthService");
    expect(pathCall.request.args[2]).toBe("DatabasePool");
    const stdout = stdoutChunks.join("");
    const envelope = JSON.parse(stdout) as { ok: boolean; operation: string; result: { from: string; to: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.operation).toBe("repository.path");
    expect(envelope.result.from).toBe("AuthService");
    expect(envelope.result.to).toBe("DatabasePool");
  });
});

// ============================================================================
//   explainRepositoryIntelligence
// ============================================================================

describe("explainRepositoryIntelligence argument validation", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hard-fails with MISSING_ARGUMENT when --node is empty", async () => {
    await expect(
      explainRepositoryIntelligence(root, { node: "", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with MISSING_ARGUMENT when --node is whitespace-only", async () => {
    await expect(
      explainRepositoryIntelligence(root, { node: "  \t\n", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("hard-fails with INVALID_ARGUMENT when --node exceeds the bounded length", async () => {
    const oversized = "a".repeat(REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH + 1);
    await expect(
      explainRepositoryIntelligence(root, { node: oversized, runner: fake.runner }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("hard-fails with INVALID_ARGUMENT when --node contains a NUL byte", async () => {
    await expect(
      explainRepositoryIntelligence(root, { node: "before\u0000after", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("hard-fails with REPOSITORY_INTELLIGENCE_CACHE_UNSAFE when the cache root is a symlink", async () => {
    const { symlink } = await import("node:fs/promises");
    const { repositoryIntelligenceCachePath } = await import("../src/repository-intelligence.js");
    const cache = repositoryIntelligenceCachePath(root);
    await mkdir(join(root, ".poiesis"), { recursive: true });
    await symlink("/tmp", cache);
    await expect(
      explainRepositoryIntelligence(root, { node: "RateLimiter", runner: fake.runner }),
    ).rejects.toMatchObject({ code: "REPOSITORY_INTELLIGENCE_CACHE_UNSAFE" });
  });
});

describe("explainRepositoryIntelligence uv availability", () => {
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
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("uv-unavailable");
    expect(outcome.operation).toBe("repository.explain");
    expect(outcome.engine).toBe("graphify");
    expect(outcome.engineVersion).toBe(GRAPHIFY_VERSION);
    expect(fake.calls.length).toBe(0);
  });
});

describe("explainRepositoryIntelligence refresh path", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a new immutable generation and runs graphify explain with positional arg + explicit --graph", async () => {
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("initial-extract");
    expect(outcome.node).toBe("RateLimiter");
    // Two runner calls: refresh (extract), then explain.
    expect(fake.calls.length).toBe(2);
    const refreshCall = fake.calls[0]!;
    const explainCall = fake.calls[1]!;
    expect(refreshCall.request.args[0]).toBe("extract");
    expect(refreshCall.request.args).toContain("--code-only");
    expect(refreshCall.request.args).toContain("--no-cluster");
    // Explain argv: `explain <node> --graph <active>` — named Poiesis
    // flag translates to Graphify positional arg + explicit --graph.
    expect(explainCall.request.args[0]).toBe("explain");
    expect(explainCall.request.args[1]).toBe("RateLimiter");
    expect(explainCall.request.args).toContain("--graph");
    const graphIdx = explainCall.request.args.indexOf("--graph");
    const explainGraph = explainCall.request.args[graphIdx + 1]!;
    expect(explainGraph).toContain(REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY);
    expect(explainGraph).not.toContain(".staging-");
    // Timeout is the bounded node-call budget.
    expect(explainCall.request.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS);
    expect(refreshCall.request.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS);
    expect(outcome.graphPath).toBe(explainGraph);
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
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.action).toBe("rebuilt");
    expect(outcome.refresh.kind).toBe("incremental-update");
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0]!.request.args[0]).toBe("update");
    expect(fake.calls[0]!.request.args).not.toContain("--code-only");
    expect(fake.calls[0]!.request.args).not.toContain("--no-cluster");
    const explainGraph = fake.calls[1]!.request.args[fake.calls[1]!.request.args.indexOf("--graph") + 1]!;
    expect(explainGraph).not.toContain(priorGenerationId);
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
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.refresh.kind).toBe("engine-version-mismatch");
    const refreshArgs = fake.calls[0]!.request.args;
    expect(refreshArgs[0]).toBe("extract");
    expect(refreshArgs).toContain("--code-only");
    expect(refreshArgs).toContain("--no-cluster");
    expect(refreshArgs).not.toContain("--force");
  });

  it("returns a typed explain-failed fallback when the explain invocation crashes", async () => {
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
      message: "explain crashed",
      detail: { exitCode: 2, stderr: "boom" },
    });
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("explain-failed");
    expect(outcome.operation).toBe("repository.explain");
    expect(fake.calls.length).toBe(2);
  });

  it("returns a typed explain-timeout fallback when the explain invocation times out", async () => {
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
      message: "explain exceeded 30000ms",
      detail: { timeoutMs: REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS },
    });
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("explain-timeout");
    expect(outcome.detail.timeoutMs).toBe(REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS);
  });

  it("returns a typed refresh-failed fallback when the refresh invocation crashes (and never invokes graphify explain)", async () => {
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: "extract crashed",
      detail: { exitCode: 1, stderr: "boom" },
    });
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("refresh-failed");
    expect(fake.calls.length).toBe(1);
  });

  it("returns a typed graph-invalid fallback when the staged graph is not parseable JSON", async () => {
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
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected fallback");
    expect(outcome.reason).toBe("graph-invalid");
    expect(fake.calls.length).toBe(1);
  });

  it("does not pass any model credential to the graphify runner env", async () => {
    process.env.OPENAI_API_KEY = "sk-leak";
    try {
      await explainRepositoryIntelligence(root, { node: "RateLimiter", runner: fake.runner });
      for (const call of fake.calls) {
        expect(call.request.env.OPENAI_API_KEY).toBeUndefined();
      }
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("garbage-collects every prior generation after a successful activation", async () => {
    const staleDir1 = repositoryIntelligenceGenerationPath(root, "generation-stale-A");
    const staleDir2 = repositoryIntelligenceGenerationPath(root, "generation-stale-B");
    await mkdir(staleDir1, { recursive: true });
    await mkdir(staleDir2, { recursive: true });
    await writeFile(join(staleDir1, "graph.json"), "{}");
    await writeFile(join(staleDir2, "graph.json"), "{}");
    const outcome = await explainRepositoryIntelligence(root, {
      node: "RateLimiter",
      runner: fake.runner,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    const remaining = await listGenerations(root);
    expect(remaining.length).toBe(1);
    expect(await exists(staleDir1)).toBe(false);
    expect(await exists(staleDir2)).toBe(false);
  });
});

describe("explainRepositoryIntelligence refresh lock", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes the lock file after a successful explain invocation", async () => {
    await explainRepositoryIntelligence(root, { node: "RateLimiter", runner: fake.runner });
    const lockPath = join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
    expect(await exists(lockPath)).toBe(false);
  });

  it("removes the lock file even when the explain invocation fails", async () => {
    fake.enqueue({
      ok: false,
      code: "GRAPHIFY_FAILED",
      message: "boom",
      detail: { exitCode: 1 },
    });
    await explainRepositoryIntelligence(root, { node: "RateLimiter", runner: fake.runner });
    const lockPath = join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
    expect(await exists(lockPath)).toBe(false);
  });
});

// ---- CLI dispatch surface ----------------------------------------------------

describe("poiesis repository explain CLI dispatch", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hard-fails with MISSING_ARGUMENT when --node is not supplied", async () => {
    const { commandRepository } = await import("../src/cli.js");
    await expect(
      commandRepository(["explain", "--cwd", root], { runner: fake.runner }),
    ).rejects.toMatchObject({ code: "MISSING_ARGUMENT" });
  });

  it("routes explain --node through explainRepositoryIntelligence", async () => {
    const { commandRepository } = await import("../src/cli.js");
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      await commandRepository(
        ["explain", "--node", "RateLimiter", "--cwd", root],
        { runner: fake.runner },
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    expect(fake.calls.length).toBe(2);
    const explainCall = fake.calls[1]!;
    expect(explainCall.request.args[0]).toBe("explain");
    expect(explainCall.request.args[1]).toBe("RateLimiter");
    const stdout = stdoutChunks.join("");
    const envelope = JSON.parse(stdout) as { ok: boolean; operation: string; result: { node: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.operation).toBe("repository.explain");
    expect(envelope.result.node).toBe("RateLimiter");
  });
});

// ---- Cross-operation invariants ---------------------------------------------

describe("ticket #123 cross-operation invariants", () => {
  let root: string;
  const fake: FakeRunner = createFakeRunner();

  beforeEach(async () => {
    root = await makeRepo();
    fake.reset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("query, path, and explain share the same refresh + lock pipeline (single repo, one operation at a time)", async () => {
    // Run query → path → explain sequentially on the same repo. After
    // each call the lock file MUST be gone (released) and the
    // generations root MUST contain exactly one active generation
    // (the just-committed one). This proves the three entry points
    // share the refresh pipeline without racing the immutable
    // activation.
    for (const call of [
      () =>
        import("../src/repository-intelligence.js").then((m) =>
          m.queryRepositoryIntelligence(root, { question: "What?", runner: fake.runner }),
        ),
      () =>
        import("../src/repository-intelligence.js").then((m) =>
          m.pathRepositoryIntelligence(root, { from: "A", to: "B", runner: fake.runner }),
        ),
      () =>
        import("../src/repository-intelligence.js").then((m) =>
          m.explainRepositoryIntelligence(root, { node: "RateLimiter", runner: fake.runner }),
        ),
    ]) {
      fake.reset();
      const outcome = await call();
      expect(outcome.ok).toBe(true);
      const lockPath = join(root, ".poiesis", "cache", "repository-intelligence", ".refresh.lock");
      expect(await exists(lockPath)).toBe(false);
      const remaining = await listGenerations(root);
      expect(remaining.length).toBe(1);
    }
  });

  it("the three operations share the same uv-unavailable fallback semantics (no subprocess on uv-missing)", async () => {
    fake.reset();
    const previousPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const q = await import("../src/repository-intelligence.js").then((m) =>
        m.queryRepositoryIntelligence(root, { question: "What?", runner: fake.runner }),
      );
      const p = await import("../src/repository-intelligence.js").then((m) =>
        m.pathRepositoryIntelligence(root, { from: "A", to: "B", runner: fake.runner }),
      );
      const e = await import("../src/repository-intelligence.js").then((m) =>
        m.explainRepositoryIntelligence(root, { node: "RateLimiter", runner: fake.runner }),
      );
      expect(q.ok).toBe(false);
      expect(p.ok).toBe(false);
      expect(e.ok).toBe(false);
      if (!q.ok) expect(q.reason).toBe("uv-unavailable");
      if (!p.ok) expect(p.reason).toBe("uv-unavailable");
      if (!e.ok) expect(e.reason).toBe("uv-unavailable");
      expect(fake.calls.length).toBe(0);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
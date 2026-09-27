import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandRepository } from "../src/cli.js";
import {
  GRAPHIFY_VERSION,
  writeRepositoryIntelligenceState,
} from "../src/repository-intelligence.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

async function installFakeUv(): Promise<FakeUvEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    parent,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function captureStdout<T>(operation: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
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
    const value = await operation();
    return { value, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe("ticket #121 CLI surface: poiesis repository status", () => {
  let opencode: FakeOpenCodeEnvironment | undefined;
  let uv: FakeUvEnvironment | undefined;
  const repositories: TestRepository[] = [];

  beforeEach(async () => {
    opencode = await installFakeOpenCode();
  });

  afterEach(async () => {
    opencode?.restore();
    opencode = undefined;
    uv?.restore();
    uv = undefined;
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("writes the canonical structured-JSON success envelope with the status result", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    uv = await installFakeUv();
    const { init } = await import("../src/maintenance.js");
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });

    const { stdout } = await captureStdout(() => commandRepository(["status", "--cwd", repository.root]));
    const envelope = JSON.parse(stdout) as {
      ok: boolean;
      operation: string;
      result: { engine: string; engineVersion: string; uvAvailable: boolean; cachePresent: boolean; cacheValid: boolean; reason: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.operation).toBe("repository.status");
    expect(envelope.result.engine).toBe("graphify");
    expect(envelope.result.engineVersion).toBe(GRAPHIFY_VERSION);
    expect(envelope.result.uvAvailable).toBe(true);
    // No query has run yet; status must NOT lazily build the cache.
    expect(envelope.result.cachePresent).toBe(false);
    expect(envelope.result.reason).toBe("cache-absent");
  }, 30_000);

  it("reports cachePresent=true and reason=ready after a cache has been stamped", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    uv = await installFakeUv();
    const { init } = await import("../src/maintenance.js");
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    // The new layout requires the `activeGeneration` pointer to
    // reference a real directory inside `generations/`.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const generationId = "generation-status-1";
    const generationDir = join(
      repository.root,
      ".poiesis",
      "cache",
      "repository-intelligence",
      "generations",
      generationId,
    );
    await mkdir(generationDir, { recursive: true });
    await writeFile(join(generationDir, "graph.json"), "{}\n");
    await writeRepositoryIntelligenceState(repository.root, {
      schema: 1,
      engine: "graphify",
      engineVersion: GRAPHIFY_VERSION,
      mode: "code-only",
      activeGeneration: generationId,
    });
    const { stdout } = await captureStdout(() => commandRepository(["status", "--cwd", repository.root]));
    const envelope = JSON.parse(stdout) as { result: { cachePresent: boolean; cacheValid: boolean; reason: string } };
    expect(envelope.result.cachePresent).toBe(true);
    expect(envelope.result.cacheValid).toBe(true);
    expect(envelope.result.reason).toBe("ready");
  }, 30_000);

  it("refuses unknown subcommands with UNKNOWN_COMMAND", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    uv = await installFakeUv();
    const { init } = await import("../src/maintenance.js");
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    // The dispatcher pattern (mirrors `commandTracker` etc.) throws
    // the typed `UNKNOWN_COMMAND` error; the CLI `main()` catches and
    // emits the canonical envelope via `writeFailure`. We verify the
    // thrown error directly here to keep the test focused on the
    // typed contract. As of ticket #122, `poiesis repository query`
    // is a supported subcommand; this test exercises an UNSUPPORTED
    // subcommand so the UNKNOWN_COMMAND surface stays covered.
    await expect(commandRepository(["nuke", "--cwd", repository.root])).rejects.toMatchObject({
      code: "UNKNOWN_COMMAND",
      details: { supported: ["status", "query"] },
    });
  }, 30_000);
});

describe("ticket #121 CLI HELP exposes the new subcommand", () => {
  it("mentions `poiesis repository status` in HELP", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
    // The HELP constant is the authoritative surface; asserting on
    // the source keeps the contract explicit without spinning a
    // subprocess. The full help-text integration test lives in
    // tests/cli-bin.test.ts and tests/proof-to-preview-guidance.test.ts.
    expect(source).toContain("poiesis repository status");
  });
});

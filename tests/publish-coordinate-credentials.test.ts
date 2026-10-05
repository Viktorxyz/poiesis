/**
 * Spec #139 / ticket #146 — production publishing coordinates come from the
 * configured Git remote for every non-fixture tracker, and a credential in
 * that remote is never retained and never emitted.
 *
 * Two whole-change findings are pinned here, plus the seam that fixes both.
 *
 *   1. TRACKER INDEPENDENCE. Publishing coordinates are a property of the
 *      configured Git remote. A `github` / `gitlab` tracker no longer
 *      supplies them for a remote that is not a recognized forge, so
 *      `resolvePublishCoordinates` fails closed with
 *      `PUBLISH_PROVIDER_UNRESOLVED` whatever the tracker says. The single
 *      surviving fallback is the test-only `fixture` tracker, and it can
 *      only ever produce `provider: "fixture"` coordinates.
 *
 *   2. CREDENTIAL REDACTION. A remote URL may carry userinfo
 *      (`https://user:token@github.com/owner/repo.git`). Poiesis PARSES a
 *      supported GitHub / GitLab HTTPS URL that carries userinfo, but the
 *      credential is never retained in a coordinate, a report, an error's
 *      `details`, CLI JSON, or a log line. Every surface is routed through
 *      the one `sanitizeGitRemoteUrl` seam, so the sentinel secret below is
 *      absent from the whole serialized form of each surface — not just from
 *      the field this ticket happened to look at.
 *
 * The sentinel is a value that exists only in this file. A test that
 * forgets to assert on a surface leaves the credential in that surface
 * undetected, so each assertion is written against the FULL serialization
 * (`JSON.stringify` of the report / error / inspection) rather than a single
 * convenient field.
 *
 * The built-package test runs the real `dist` bundle, because the shipped
 * CLI — not only the TypeScript source — is the surface an Author sees.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asPoiesisError } from "../src/errors.js";
import { inspect } from "../src/git.js";
import { sanitizeGitRemoteUrl } from "../src/git-remote-url.js";
import { composeInitDiscovery } from "../src/init-discovery.js";
import {
  autoResolveConfigDefaults,
  doctor,
  parseGitHubProject,
  parseGitLabProject,
  parseTrackerFromUrl,
  resolvePublishCoordinates,
} from "../src/maintenance.js";
import { run } from "../src/process.js";
import { createTestRepository, type TestRepository } from "./helpers.js";

/**
 * A credential that exists only in this test file. If it appears in ANY
 * assertion target below, the surface under test leaks it.
 */
const SENTINEL_SECRET = "ghp_POIESIS_SENTINEL_4f3a9c2b7e1d";
const SENTINEL_USERINFO = `build-bot:${SENTINEL_SECRET}`;

/**
 * A credential-bearing remote on a host that is not a recognized forge. The
 * host is a refused loopback port so the URL can never resolve: the only
 * subprocess git runs against it fails immediately and offline.
 */
const CREDENTIAL_REMOTE_UNRECOGNIZED = `https://${SENTINEL_USERINFO}@127.0.0.1:1/team/repo.git`;
const CREDENTIAL_REMOTE_GITHUB = `https://${SENTINEL_USERINFO}@github.com/owner/repo.git`;

/** The serialized CLI failure envelope, byte-identical to `writeFailure`. */
function failureJson(error: unknown): string {
  const normalized = asPoiesisError(error);
  return JSON.stringify(
    { ok: false, error: { code: normalized.code, message: normalized.message, details: normalized.details } },
    null,
    2,
  );
}

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
});

async function repositoryWithRemote(url: string): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await run("git", ["remote", "set-url", "origin", url], { cwd: repository.root });
  return repository;
}

/**
 * A complete project config carrying a FORGE tracker block. The forge
 * provider plus a configured project is exactly the shape that used to be
 * mistaken for a publishing coordinate, so it is the subject of most of the
 * tests below.
 */
function forgeTrackerConfig(): Parameters<typeof autoResolveConfigDefaults>[1] {
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "github", project: "owner/repo" },
    verification: { commands: ["test -f README.md"] },
  };
}

async function resolvedConfig(repository: TestRepository): Promise<Awaited<ReturnType<typeof autoResolveConfigDefaults>>["config"]> {
  return (await autoResolveConfigDefaults(repository.root, forgeTrackerConfig())).config;
}

/**
 * Install a hand-written config so a read-only surface (`doctor`) and the
 * built-package `publish` run can resolve a config without a full `init`
 * transaction. `local` is the tracker because it makes no network call, so
 * the test never depends on a host `gh`.
 */
/**
 * Write a hand-written manifest recording the executing runtime version, so
 * the built CLI's `publish` preflight (ticket #152: runtime identity, then the
 * central delivery policy) reaches publishing-coordinate resolution — the
 * surface whose URL redaction this file qualifies — without a full `init`
 * transaction. The config's own `delivery` block is omitted, which keeps its
 * legacy resolved state, so no policy refusal precedes the coordinates.
 */
async function writeMatchingManifest(root: string): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string;
  };
  await mkdir(join(root, ".poiesis"), { recursive: true });
  await writeFile(
    join(root, ".poiesis", "manifest.json"),
    `${JSON.stringify(
      {
        schema: 1,
        poiesisVersion: packageJson.version,
        adapter: { harness: "opencode", adapterVersion: "test", supportedVersion: packageJson.version },
        files: [],
        skills: [],
        configPatches: [],
      },
      null,
      2,
    )}\n`,
  );
}

async function writeMinimalConfig(root: string): Promise<void> {
  await mkdir(join(root, ".poiesis"), { recursive: true });
  await writeFile(
    join(root, ".poiesis", "config.jsonc"),
    `${JSON.stringify(
      {
        schema: 1,
        models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
        repository: { remote: "origin", integrationBranch: "main" },
        tracker: { provider: "local" },
        verification: { commands: ["test -f README.md"] },
      },
      null,
      2,
    )}\n`,
  );
}

describe("the one URL sanitization seam (Spec #139 / ticket #146)", () => {
  it("strips HTTPS userinfo and keeps the host and path", () => {
    expect(sanitizeGitRemoteUrl(`https://${SENTINEL_USERINFO}@github.com/owner/repo.git`)).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("strips userinfo whose secret itself contains an `@`", () => {
    expect(sanitizeGitRemoteUrl("https://user:p@ss@github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
  });

  it("strips ssh:// userinfo", () => {
    expect(sanitizeGitRemoteUrl(`ssh://git:${SENTINEL_SECRET}@internal/owner/repo.git`)).toBe(
      "ssh://internal/owner/repo.git",
    );
  });

  it("leaves the scp-like SSH form byte-for-byte intact", () => {
    expect(sanitizeGitRemoteUrl("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
  });

  it("leaves a credential-free URL and a filesystem path intact", () => {
    expect(sanitizeGitRemoteUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
    expect(sanitizeGitRemoteUrl("/tmp/poiesis-test/remote.git")).toBe("/tmp/poiesis-test/remote.git");
  });

  it("leaves an `@` in the PATH alone", () => {
    expect(sanitizeGitRemoteUrl("https://github.com/own@er/repo.git")).toBe("https://github.com/own@er/repo.git");
  });
});

describe("a supported HTTPS remote is parsed with userinfo and keeps no credential", () => {
  it("parses GitHub HTTPS with userinfo into the project coordinate", () => {
    const parsed = parseTrackerFromUrl(CREDENTIAL_REMOTE_GITHUB);
    expect(parsed).toEqual({ provider: "github", project: "owner/repo" });
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL_SECRET);
  });

  it("parses GitLab HTTPS with userinfo into a nested project coordinate", () => {
    const parsed = parseTrackerFromUrl(`https://${SENTINEL_USERINFO}@gitlab.com/group/subgroup/project.git`);
    expect(parsed).toEqual({ provider: "gitlab", project: "group/subgroup/project" });
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL_SECRET);
  });

  it("keeps the credential out of the single-provider parsers too", () => {
    expect(parseGitHubProject(CREDENTIAL_REMOTE_GITHUB)).toBe("owner/repo");
    expect(parseGitLabProject(`https://${SENTINEL_USERINFO}@gitlab.com/group/project.git`)).toBe("group/project");
  });

  it("still refuses to recognize a self-hosted host that carries userinfo", () => {
    expect(parseTrackerFromUrl(`https://${SENTINEL_USERINFO}@git.example.com/owner/repo.git`)).toBeNull();
  });

  it("still refuses an SSH remote and a lookalike host", () => {
    expect(parseTrackerFromUrl("ssh://git@internal/owner/repo.git")).toBeNull();
    expect(parseTrackerFromUrl("git@github.example.com:owner/repo.git")).toBeNull();
  });
});

describe("publishing coordinates are remote-only for every non-fixture tracker", () => {
  it("fails closed for a github tracker on an unrecognized remote", async () => {
    const repository = await repositoryWithRemote(CREDENTIAL_REMOTE_UNRECOGNIZED);
    await expect(resolvePublishCoordinates(repository.root, await resolvedConfig(repository))).rejects.toMatchObject({
      code: "PUBLISH_PROVIDER_UNRESOLVED",
    });
  });

  it("fails closed for a gitlab tracker on an unrecognized remote", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const { config } = await autoResolveConfigDefaults(repository.root, {
      ...forgeTrackerConfig(),
      tracker: { provider: "gitlab", project: "group/project" },
    });
    await expect(resolvePublishCoordinates(repository.root, config)).rejects.toMatchObject({
      code: "PUBLISH_PROVIDER_UNRESOLVED",
    });
  });

  it("keeps the test-only fixture fallback, and it can only ever be fixture", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const { config } = await autoResolveConfigDefaults(repository.root, {
      ...forgeTrackerConfig(),
      tracker: { provider: "fixture", project: join(repository.fixtures, "tracker") },
    });
    const coordinates = await resolvePublishCoordinates(repository.root, config);
    expect(coordinates.provider).toBe("fixture");
    expect(coordinates.project).toBe(join(repository.fixtures, "tracker"));
    expect(coordinates.source).toBe("fixture-tracker");
  });

  it("resolves a credential-bearing recognized remote to a credential-free coordinate", async () => {
    const repository = await repositoryWithRemote(CREDENTIAL_REMOTE_GITHUB);
    const coordinates = await resolvePublishCoordinates(repository.root, await resolvedConfig(repository));
    expect(coordinates).toEqual({ provider: "github", project: "owner/repo", source: "git-remote" });
    expect(JSON.stringify(coordinates)).not.toContain(SENTINEL_SECRET);
  });

  it("serializes PUBLISH_PROVIDER_UNRESOLVED without the remote credential", async () => {
    const repository = await repositoryWithRemote(CREDENTIAL_REMOTE_UNRECOGNIZED);
    const error = await resolvePublishCoordinates(repository.root, await resolvedConfig(repository)).catch(
      (thrown: unknown) => thrown,
    );
    const json = failureJson(error);
    expect(json).toContain("PUBLISH_PROVIDER_UNRESOLVED");
    expect(json).toContain("https://127.0.0.1:1/team/repo.git");
    expect(json).not.toContain(SENTINEL_SECRET);
    expect(json).not.toContain(SENTINEL_USERINFO);
  });
});

describe("every read-only surface that shows a remote URL is credential-free", () => {
  it("keeps the credential out of the whole doctor report", async () => {
    const repository = await repositoryWithRemote(CREDENTIAL_REMOTE_UNRECOGNIZED);
    await writeMinimalConfig(repository.root);
    const report = await doctor(repository.root);
    const json = JSON.stringify(report);
    expect(json).not.toContain(SENTINEL_SECRET);
    expect(json).not.toContain(SENTINEL_USERINFO);
    const remoteCheck = report.checks.find((check) => check.id === "git-remote");
    expect(remoteCheck?.details).toMatchObject({ url: "https://127.0.0.1:1/team/repo.git" });
  });

  it("keeps the credential out of the git inspection the inspect command prints", async () => {
    const repository = await repositoryWithRemote(CREDENTIAL_REMOTE_UNRECOGNIZED);
    const result = await inspect({ cwd: repository.root });
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL_SECRET);
    expect(result.remotes).toEqual([
      {
        name: "origin",
        fetchUrls: ["https://127.0.0.1:1/team/repo.git"],
        pushUrls: ["https://127.0.0.1:1/team/repo.git"],
      },
    ]);
  });

  it("keeps the credential out of init discovery and the summary it renders", async () => {
    const repository = await repositoryWithRemote(CREDENTIAL_REMOTE_UNRECOGNIZED);
    const discovery = await composeInitDiscovery(repository.root, {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      repository: { remote: "origin", integrationBranch: "main" },
    });
    expect(JSON.stringify(discovery)).not.toContain(SENTINEL_SECRET);
    expect(discovery.detections.remote).toMatchObject({ name: "origin", url: "https://127.0.0.1:1/team/repo.git" });
  });
});

/**
 * The built package, not the source: the shipped bundle is what an Author
 * runs, so a source-only guarantee would leave the CLI free to print the
 * credential. The bundle is built into a dedicated out-dir so it cannot
 * race the suites that own `dist/`.
 */
describe("the built package never prints a remote credential", () => {
  const outDir = "dist-ticket-146";
  let cliPath: string | undefined;

  beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, "..");
    await run(
      "node",
      ["node_modules/tsup/dist/cli-default.js", "src/cli.ts", "--format", "esm", "--clean", "--no-dts", "--out-dir", outDir],
      { cwd: repoRoot, timeoutMs: 120_000 },
    );
    const built = join(repoRoot, outDir, "cli.js");
    if (!existsSync(built)) throw new Error(`tsup did not produce ${built}`);
    cliPath = built;
  }, 120_000);

  afterAll(async () => {
    // Only remove the dedicated out-dir; never touch dist/.
    await rm(join(import.meta.dirname, "..", outDir), { recursive: true, force: true });
  });

  it("keeps the sentinel out of `poiesis inspect` and out of a publish refusal", async () => {
    if (cliPath === undefined) throw new Error("cli not built");
    const cli = cliPath;
    const repository = await repositoryWithRemote(CREDENTIAL_REMOTE_UNRECOGNIZED);
    await writeMinimalConfig(repository.root);
    await writeMatchingManifest(repository.root);

    const inspection = await run("node", [cli, "inspect"], { cwd: repository.root, allowFailure: true });
    expect(inspection.exitCode).toBe(0);
    expect(inspection.stdout).not.toContain(SENTINEL_SECRET);
    expect(inspection.stdout).toContain("https://127.0.0.1:1/team/repo.git");

    const publish = await run(
      "node",
      [
        cli,
        "publish",
        "--sha",
        repository.baseSha,
        "--candidate-tree",
        repository.baseSha,
        "--proof",
        JSON.stringify({ candidateSha: repository.baseSha, candidateTree: repository.baseSha, verified: true }),
        "--title",
        "Redaction check",
        "--body",
        "Redaction check",
      ],
      { cwd: repository.root, allowFailure: true },
    );
    expect(publish.exitCode).not.toBe(0);
    expect(publish.stderr).toContain("PUBLISH_PROVIDER_UNRESOLVED");
    expect(publish.stderr).toContain("https://127.0.0.1:1/team/repo.git");
    expect(publish.stderr).not.toContain(SENTINEL_SECRET);
    expect(`${publish.stdout}${publish.stderr}`).not.toContain(SENTINEL_USERINFO);
  });
});

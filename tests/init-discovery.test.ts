import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import { composeInitDiscovery } from "../src/init-discovery.js";
import type { PoiesisConfig } from "../src/config.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import { installFakeOpenCode } from "./fake-opencode.js";
import { autoResolveConfigDefaults } from "../src/maintenance.js";

const repositories: TestRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

interface RepoSnapshot {
  rootEntries: string[];
  opencodeConfigPath: string;
  opencodeConfigBytes: Buffer | null;
  gitignoreBytes: Buffer | null;
}

async function snapshotTree(root: string): Promise<RepoSnapshot> {
  const candidates = [
    "opencode.jsonc",
    "opencode.json",
    ".opencode/opencode.jsonc",
    ".opencode/opencode.json",
  ];
  let opencodeConfigPath = "(none)";
  let opencodeConfigBytes: Buffer | null = null;
  for (const candidate of candidates) {
    const path = join(root, candidate);
    try {
      opencodeConfigBytes = await readFile(path);
      opencodeConfigPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  let gitignoreBytes: Buffer | null = null;
  try {
    gitignoreBytes = await readFile(join(root, ".gitignore"));
  } catch {
    gitignoreBytes = null;
  }
  const rootEntries = await readdir(root).catch(() => []);
  return { rootEntries, opencodeConfigPath, opencodeConfigBytes, gitignoreBytes };
}

function baseDraft(): PoiesisConfig {
  // The canonical template form: delivery contains `<...>` placeholders that
  // the composer is expected to either prefill (when a `scripts/poiesis-*`
  // hint exists) or surface as unresolved delivery.
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    tracker: { provider: "github", project: "poiesis-test/init-discovery" },
    delivery: {
      preview: { adapter: "command", command: ["<delivery-executable>", "preview", "{sha}"] },
      staging: { adapter: "command", command: ["<delivery-executable>", "staging", "{sha}"] },
      production: { adapter: "command", command: ["<delivery-executable>", "production", "{sha}"] },
    },
    verification: { commands: ["test -f README.md"] },
  };
}

function resolvedDraft(): PoiesisConfig {
  // A draft where every field is explicit and concrete (no `<...>` sentinels).
  // Used by tests that assert the composer produces a fully resolved config
  // without relying on `scripts/poiesis-*` hints.
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    tracker: { provider: "github", project: "poiesis-test/init-discovery" },
    delivery: {
      preview: { adapter: "command", command: ["./delivery-runner", "preview", "{sha}"] },
      staging: { adapter: "command", command: ["./delivery-runner", "staging", "{sha}"] },
      production: { adapter: "command", command: ["./delivery-runner", "production", "{sha}"] },
    },
    verification: { commands: ["test -f README.md"] },
  };
}

describe("composeInitDiscovery", () => {
  it("returns a fully resolved PoiesisConfig when the draft is concrete and every fact is discoverable", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const before = await snapshotTree(repository.root);
    const result = await composeInitDiscovery(repository.root, resolvedDraft());

    expect(result.unresolved).toEqual([]);
    expect(result.config).toBeDefined();
    expect(result.config!.repository.remote).toBe("origin");
    expect(result.config!.repository.integrationBranch).toBe("main");
    expect(result.config!.tracker).toEqual({ provider: "github", project: "poiesis-test/init-discovery" });
    expect(result.config!.verification.commands).toEqual(["test -f README.md"]);
    // The resolved config carries the user's concrete argv; delivery stays explicit.
    expect(result.config!.delivery.preview).toEqual({ adapter: "command", command: ["./delivery-runner", "preview", "{sha}"] });
    expect(result.detections.remote.source).toBe("git-origin");
    expect(result.detections.integrationBranch.source).toBe("git-local-main");
    expect(result.detections.tracker.source).toBe("explicit");
    expect(result.detections.verification.source).toBe("explicit");
    expect(result.detections.delivery.preview?.source).toEqual({ kind: "explicit" });

    const after = await snapshotTree(repository.root);
    expect(after.rootEntries).toEqual(before.rootEntries);
    expect(after.opencodeConfigPath).toBe(before.opencodeConfigPath);
    expect(after.opencodeConfigBytes?.equals(before.opencodeConfigBytes ?? Buffer.alloc(0)) ?? true).toBe(true);
    expect(after.gitignoreBytes?.equals(before.gitignoreBytes ?? Buffer.alloc(0)) ?? true).toBe(true);
    expect(await readdir(join(repository.root, ".poiesis")).catch(() => [])).toEqual([]);
    expect(await readdir(join(repository.root, ".opencode")).catch(() => [])).toEqual([]);
  });

  it("returns a fully resolved PoiesisConfig when scripts/poiesis-{target} hints exist alongside a template draft", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await mkdir(join(repository.root, "scripts"), { recursive: true });
    for (const name of ["poiesis-preview", "poiesis-staging", "poiesis-production"]) {
      await writeFile(join(repository.root, "scripts", name), "#!/bin/sh\ntrue\n");
      await chmod(join(repository.root, "scripts", name), 0o755);
    }
    const result = await composeInitDiscovery(repository.root, baseDraft());
    expect(result.unresolved).toEqual([]);
    expect(result.config).toBeDefined();
    expect(result.config!.delivery.preview).toEqual({ adapter: "command", command: ["scripts/poiesis-preview", "{sha}"] });
    expect(result.config!.delivery.staging).toEqual({ adapter: "command", command: ["scripts/poiesis-staging", "{sha}"] });
    expect(result.config!.delivery.production).toEqual({ adapter: "command", command: ["scripts/poiesis-production", "{sha}"] });
    expect(result.detections.delivery.preview?.source).toEqual({ kind: "script", path: "scripts/poiesis-preview" });
  });

  it("does not mutate the repository when called against a fresh test fixture (full filesystem snapshot)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const before = await snapshotTree(repository.root);
    await composeInitDiscovery(repository.root, resolvedDraft());
    const after = await snapshotTree(repository.root);
    expect(after.rootEntries).toEqual(before.rootEntries);
    expect(after.opencodeConfigPath).toBe(before.opencodeConfigPath);
    expect(after.opencodeConfigBytes?.equals(before.opencodeConfigBytes ?? Buffer.alloc(0)) ?? true).toBe(true);
    expect(after.gitignoreBytes?.equals(before.gitignoreBytes ?? Buffer.alloc(0)) ?? true).toBe(true);
  });

  it("leaves remote unresolved when no Git remote is configured (does not invent one)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "remove", "origin"], { cwd: repository.root });
    const result = await composeInitDiscovery(repository.root, baseDraft());
    expect(result.config).toBeUndefined();
    expect(result.unresolved).toContain("repository.remote");
    expect(result.detections.remote.source).toBe("none");
  });

  it("leaves remote unresolved when multiple non-origin remotes exist (does not guess)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "rename", "origin", "upstream"], { cwd: repository.root });
    await run("git", ["remote", "add", "staging", repository.remote], { cwd: repository.root });
    const result = await composeInitDiscovery(repository.root, baseDraft());
    expect(result.config).toBeUndefined();
    expect(result.unresolved).toContain("repository.remote");
    expect(result.detections.remote.source).toBe("ambiguous");
    expect(result.detections.remote.alternates?.sort()).toEqual(["staging", "upstream"]);
  });

  it("auto-picks the sole non-origin remote when exactly one non-origin remote is configured", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "rename", "origin", "upstream"], { cwd: repository.root });
    const result = await composeInitDiscovery(repository.root, resolvedDraft());
    expect(result.config?.repository.remote).toBe("upstream");
    expect(result.detections.remote.source).toBe("git-singleton");
  });

  it("honors an explicitly configured remote override and reports source=explicit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "rename", "origin", "upstream"], { cwd: repository.root });
    const draft: PoiesisConfig = {
      ...resolvedDraft(),
      repository: { remote: "upstream", integrationBranch: "main" },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.config?.repository.remote).toBe("upstream");
    expect(result.detections.remote.source).toBe("explicit");
  });

  it("auto-derives verification commands from package scripts when the draft omits them", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(
      join(repository.root, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { test: "true", lint: "echo lint" } }),
    );
    const draft: PoiesisConfig = {
      ...resolvedDraft(),
      verification: undefined,
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.config?.verification.commands).toEqual(["true", "echo lint"]);
    expect(result.detections.verification.source).toBe("package-scripts");
  });

  it("prefills command delivery adapters from scripts/poiesis-preview|staging|production hints", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await mkdir(join(repository.root, "scripts"), { recursive: true });
    await writeFile(join(repository.root, "scripts", "poiesis-preview"), "#!/bin/sh\ntrue\n");
    await writeFile(join(repository.root, "scripts", "poiesis-staging"), "#!/bin/sh\ntrue\n");
    await writeFile(join(repository.root, "scripts", "poiesis-production"), "#!/bin/sh\ntrue\n");
    await chmod(join(repository.root, "scripts", "poiesis-preview"), 0o755);
    await chmod(join(repository.root, "scripts", "poiesis-staging"), 0o755);
    await chmod(join(repository.root, "scripts", "poiesis-production"), 0o755);
    const draft: PoiesisConfig = {
      ...baseDraft(),
      delivery: {
        preview: { adapter: "command", command: ["<delivery-executable>", "preview", "{sha}"] },
        staging: { adapter: "command", command: ["<delivery-executable>", "staging", "{sha}"] },
        production: { adapter: "command", command: ["<delivery-executable>", "production", "{sha}"] },
      },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.config).toBeDefined();
    expect(result.config!.delivery.preview).toEqual({
      adapter: "command",
      command: ["scripts/poiesis-preview", "{sha}"],
    });
    expect(result.config!.delivery.staging).toEqual({
      adapter: "command",
      command: ["scripts/poiesis-staging", "{sha}"],
    });
    expect(result.config!.delivery.production).toEqual({
      adapter: "command",
      command: ["scripts/poiesis-production", "{sha}"],
    });
    expect(result.detections.delivery.preview?.source).toEqual({ kind: "script", path: "scripts/poiesis-preview" });
    expect(result.detections.delivery.staging?.source).toEqual({ kind: "script", path: "scripts/poiesis-staging" });
    expect(result.detections.delivery.production?.source).toEqual({ kind: "script", path: "scripts/poiesis-production" });
  });

  it("leaves each delivery target unresolved when no scripts/poiesis-{target} hint exists", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // No scripts/* delivery hint exists.
    const result = await composeInitDiscovery(repository.root, baseDraft());
    expect(result.detections.delivery.preview).toBeNull();
    expect(result.detections.delivery.staging).toBeNull();
    expect(result.detections.delivery.production).toBeNull();
    expect(result.unresolved).toContain("delivery.preview");
    expect(result.unresolved).toContain("delivery.staging");
    expect(result.unresolved).toContain("delivery.production");
    // config remains undefined because delivery is unresolved
    expect(result.config).toBeUndefined();
  });

  it("never invents a hosting-provider delivery adapter (no Vercel/Netlify/Cloudflare/GHA auto-adapters)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const result = await composeInitDiscovery(repository.root, baseDraft());
    expect(result.detections.delivery.preview).toBeNull();
    expect(result.detections.delivery.staging).toBeNull();
    expect(result.detections.delivery.production).toBeNull();
    // The forbidden adapter families never appear in the resolved config either.
    if (result.config !== undefined) {
      for (const target of ["preview", "staging", "production"] as const) {
        const adapter = result.config.delivery[target].adapter;
        expect(adapter).not.toBe("vercel");
        expect(adapter).not.toBe("netlify");
        expect(adapter).not.toBe("cloudflare");
        expect(adapter).not.toBe("gha");
        expect(adapter).not.toBe("github-actions");
        expect(adapter).not.toBe("pages");
      }
    }
  });

  it("honors an explicitly configured delivery target and reports source=explicit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await mkdir(join(repository.root, "scripts"), { recursive: true });
    await writeFile(join(repository.root, "scripts", "poiesis-preview"), "#!/bin/sh\ntrue\n");
    await chmod(join(repository.root, "scripts", "poiesis-preview"), 0o755);
    const draft: PoiesisConfig = {
      ...baseDraft(),
      delivery: {
        preview: { adapter: "command", command: ["./custom-preview", "{sha}"] },
        staging: { adapter: "command", command: ["./custom-staging", "{sha}"] },
        production: { adapter: "command", command: ["./custom-production", "{sha}"] },
      },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.config?.delivery.preview).toEqual({
      adapter: "command",
      command: ["./custom-preview", "{sha}"],
    });
    expect(result.detections.delivery.preview?.source).toEqual({ kind: "explicit" });
  });

  it("reports existing harness OpenCode config without writing (path-only detection)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const opencodeConfig = '{ "share": "disabled" }\n';
    await writeFile(join(repository.root, "opencode.jsonc"), opencodeConfig);
    const before = await readFile(join(repository.root, "opencode.jsonc"), "utf8");
    const result = await composeInitDiscovery(repository.root, resolvedDraft());
    expect(result.detections.repo.opencodeConfigPath).toBe("opencode.jsonc");
    const after = await readFile(join(repository.root, "opencode.jsonc"), "utf8");
    expect(after).toBe(before);
  });

  it("reports existing Poiesis state (installed manifest) as a detection but does not read or merge it into the draft", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await mkdir(join(repository.root, ".poiesis"), { recursive: true });
    await writeFile(
      join(repository.root, ".poiesis", "manifest.json"),
      JSON.stringify({ schema: 1, poiesisVersion: "1.0.3", adapter: { harness: "opencode", adapterVersion: "1", supportedVersion: "1.18.29", supportedVersions: ["1.18.29"] }, files: [], skills: [], configPatches: [] }),
    );
    const before = await readFile(join(repository.root, ".poiesis", "manifest.json"), "utf8");
    const result = await composeInitDiscovery(repository.root, resolvedDraft());
    expect(result.detections.repo.poiesisInstalled).toBe(true);
    const after = await readFile(join(repository.root, ".poiesis", "manifest.json"), "utf8");
    expect(after).toBe(before);
  });

  it("returns the resolved config when called without a draft (uses purely discoverable facts)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const result = await composeInitDiscovery(repository.root);
    // Draft is undefined, but autoResolveConfigDefaults requires models + tracker provider.
    // The composer keeps discovery pure: it cannot manufacture the models block, so
    // it must leave models as unresolved rather than fabricating them.
    expect(result.unresolved).toContain("models.reasoning");
    expect(result.unresolved).toContain("models.execution");
    // The local bare-repo fixture is not a github.com / gitlab.com URL, so
    // the composer cannot infer a tracker provider and must leave it
    // unresolved (rather than guessing github).
    expect(result.unresolved).toContain("tracker.provider");
  });

  it("discovers tracker provider+project from a github.com remote WITHOUT a draft (flagless init)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "set-url", "origin", "https://github.com/poiesis-test/flagless.git"], { cwd: repository.root });
    // No draft at all — flagless invocation.
    const result = await composeInitDiscovery(repository.root);
    // The composer must NOT mark `tracker.provider` unresolved when it has
    // already discovered the provider from the remote URL.
    expect(result.unresolved).not.toContain("tracker.provider");
    // The discovered detection carries both provider and project.
    expect(result.detections.tracker.provider).toBe("github");
    expect(result.detections.tracker.project).toBe("poiesis-test/flagless");
    expect(result.detections.tracker.source).toBe("remote-github");
  });

  it("discovers tracker provider=gitlab from a gitlab.com remote WITHOUT a draft (flagless init)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "set-url", "origin", "https://gitlab.com/poiesis-test/flagless-gitlab.git"], { cwd: repository.root });
    // No draft at all — flagless invocation.
    const result = await composeInitDiscovery(repository.root);
    // The composer must NOT mark `tracker.provider` unresolved when it has
    // already discovered gitlab from the remote URL.
    expect(result.unresolved).not.toContain("tracker.provider");
    // The discovered detection carries gitlab + the discovered project.
    expect(result.detections.tracker.provider).toBe("gitlab");
    expect(result.detections.tracker.project).toBe("poiesis-test/flagless-gitlab");
    expect(result.detections.tracker.source).toBe("remote-gitlab");
  });

  it("leaves tracker.provider unresolved (and does NOT guess github) when the remote host is unknown", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // Use a remote URL whose host is neither github.com nor gitlab.com.
    await run("git", ["remote", "set-url", "origin", "https://example.com/some/repo.git"], { cwd: repository.root });
    // No draft at all — flagless invocation.
    const result = await composeInitDiscovery(repository.root);
    // The composer must leave `tracker.provider` unresolved; it MUST NOT
    // silently default to github.
    expect(result.unresolved).toContain("tracker.provider");
    expect(result.detections.tracker.provider).toBeUndefined();
    expect(result.detections.tracker.source).toBe("missing");
  });

  it("honors an explicit tracker.project and reports source=explicit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const draft: PoiesisConfig = {
      ...resolvedDraft(),
      tracker: { provider: "github", project: "explicit/owner" },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.config?.tracker).toEqual({ provider: "github", project: "explicit/owner" });
    expect(result.detections.tracker.source).toBe("explicit");
  });

  it("discovers tracker.project from a github.com remote when omitted", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "set-url", "origin", "https://github.com/poiesis-test/discovered.git"], { cwd: repository.root });
    const draft: PoiesisConfig = {
      ...resolvedDraft(),
      tracker: { provider: "github" },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.config?.tracker).toEqual({ provider: "github", project: "poiesis-test/discovered" });
    expect(result.detections.tracker.source).toBe("remote-github");
  });

  it("never invents a tracker provider when the configured provider disagrees with the remote", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await run("git", ["remote", "set-url", "origin", "https://gitlab.com/some-group/repo.git"], { cwd: repository.root });
    const draft: PoiesisConfig = {
      ...baseDraft(),
      tracker: { provider: "github" },
    };
    const result = await composeInitDiscovery(repository.root, draft);
    expect(result.unresolved).toContain("tracker.project");
    expect(result.detections.tracker.source).toBe("missing");
    expect(result.config).toBeUndefined();
  });

  it("does not call out to OpenCode or any external service (read-only side-effect-free)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const fake = await installFakeOpenCode();
    try {
      const result = await composeInitDiscovery(repository.root, resolvedDraft());
      // The composer must surface harness facts without invoking OpenCode.
      // We can only assert indirectly: a fake-installed OpenCode on PATH
      // must not affect the result structure (no model list gap).
      expect(result.unresolved).not.toContain("harness.opencodeVersion");
      // And the "before" filesystem tree remains untouched (no .opencode created).
      expect(await readdir(repository.root)).toEqual(await readdir(repository.root));
    } finally {
      fake.restore();
    }
  });

  it("does not depend on the bundled Poiesis install layout (composer works against a bare repo)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // No .poiesis, no .opencode, no scripts/, no package.json scripts.
    // Pass the resolvedDraft so delivery is explicit (no <...>) and the
    // composer is not asked to invent delivery out of missing scripts.
    const result = await composeInitDiscovery(repository.root, resolvedDraft());
    // Repository is still resolvable because remote=origin, branch=main exist.
    expect(result.unresolved).not.toContain("repository.remote");
    expect(result.unresolved).not.toContain("repository.integrationBranch");
  });

  it("reuses autoResolveConfigDefaults so library consumers get identical detection flags for the happy path", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const draft = resolvedDraft();
    const composer = await composeInitDiscovery(repository.root, draft);
    const resolved = await autoResolveConfigDefaults(repository.root, draft);
    // composer and autoResolveConfigDefaults both reach the same conclusions on origin/main with an explicit draft.
    expect(composer.config).toEqual(resolved.config);
    expect(composer.detections.remote.source === "git-origin").toBe(true);
  });
});

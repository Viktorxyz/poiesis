import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { init, uninstall, update, resolveConfigForRoot } from "../src/maintenance.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import { atomicWrite, exists } from "../src/fs.js";
import { hashDirectory } from "../src/hash.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

describe("maintenance ownership", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("installs canonical files without touching foreign OpenCode config", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(join(repository.root, "opencode.jsonc"), '{ "share": "disabled" }\n');
    const manifest = await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    expect(await exists(join(repository.root, ".poiesis", "METHOD.md"))).toBe(true);
    expect(await exists(join(repository.root, ".opencode", "agents", "poiesis-final-reviewer.md"))).toBe(true);
    expect(manifest.files.some((file) => file.path === "AGENTS.md")).toBe(false);
    expect(await readFile(join(repository.root, "opencode.jsonc"), "utf8")).toContain('"share": "disabled"');
  }, 30_000);

  it("refuses to update a modified managed role", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const role = join(repository.root, ".poiesis", "roles", "worker.md");
    await writeFile(role, "foreign edit\n");
    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({ code: "FILE_OWNERSHIP_LOST" });
    expect(await readFile(role, "utf8")).toBe("foreign edit\n");
  }, 30_000);

  it("preserves unknown files and preexisting skills during uninstall", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(join(repository.root, "opencode.jsonc"), '{ "share": "disabled" }\n');
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const skillPath = join(repository.root, ".agents", "skills", "grilling");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "user owned\n");
    const manifest = await loadManifest(repository.root);
    manifest.skills.push({
      source: "mattpocock/skills",
      name: "grilling",
      path: ".agents/skills/grilling",
      preexisting: true,
      installedRevision: "preexisting",
      hash: await hashDirectory(skillPath),
    });
    await atomicWrite(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await writeFile(join(repository.root, ".poiesis", "foreign.txt"), "keep\n");

    const result = await uninstall(repository.root);
    expect(result.complete).toBe(false);
    expect(await readFile(join(repository.root, ".poiesis", "foreign.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toBe("user owned\n");
    const config = await readFile(join(repository.root, "opencode.jsonc"), "utf8");
    expect(config).toContain('"share": "disabled"');
    expect(config).not.toContain("default_agent");
  }, 30_000);

  it("discovers remote, integration branch, and verification commands from the Git repository", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const draft: Parameters<typeof resolveConfigForRoot>[1] = {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      tracker: { provider: "fixture", project: repository.fixtures },
      delivery: {
        preview: { adapter: "command", command: ["echo", "{sha}"] },
        staging: { adapter: "command", command: ["echo", "{sha}"] },
        production: { adapter: "command", command: ["echo", "{sha}"] },
      },
    };
    await writeFile(
      join(repository.root, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { test: "true" } }),
    );
    const resolved = await resolveConfigForRoot(repository.root, draft);
    expect(resolved.repository.remote).toBe("origin");
    expect(resolved.repository.integrationBranch).toBe("main");
    expect(resolved.verification.commands).toEqual(["true"]);
  });
});

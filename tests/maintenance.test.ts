import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { init, uninstall, update, resolveConfigForRoot } from "../src/maintenance.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import { atomicWrite, exists } from "../src/fs.js";
import { hashOwnedSkillDirectory } from "../src/skills.js";
import { readOwnershipReceipt, replaceOwnershipReceipt } from "../src/receipt.js";
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

  it("rejects a late OpenCode conflict before any repository write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const gitignorePath = join(repository.root, ".gitignore");
    const configPath = join(repository.root, "opencode.jsonc");
    const originalConfig = '{ "share": "disabled", "agent": { "poiesis-final-reviewer": {} } }\n';
    await writeFile(gitignorePath, "keep\n");
    await writeFile(configPath, originalConfig);

    await expect(
      init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });

    expect(await readFile(gitignorePath, "utf8")).toBe("keep\n");
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repository.root, ".agents"))).toBe(false);
    expect(await exists(join(repository.root, ".opencode"))).toBe(false);
  }, 30_000);

  it("rejects ambiguous OpenCode configs before any Poiesis write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const rootConfig = join(repository.root, "opencode.jsonc");
    const nestedConfig = join(repository.root, ".opencode", "opencode.json");
    await mkdir(join(repository.root, ".opencode"));
    await writeFile(rootConfig, '{ "share": "disabled" }\n');
    await writeFile(nestedConfig, '{ "theme": "system" }\n');

    await expect(
      init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "OPENCODE_CONFIG_AMBIGUOUS" });

    expect(await readFile(rootConfig, "utf8")).toBe('{ "share": "disabled" }\n');
    expect(await readFile(nestedConfig, "utf8")).toBe('{ "theme": "system" }\n');
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repository.root, ".agents"))).toBe(false);
  }, 30_000);

  it.each([
    ["generated file", ".opencode/agents/poiesis-final-reviewer.md", "INSTALL_PATH_CONFLICT"],
    ["managed parent", ".opencode", "UNSAFE_MANAGED_PATH"],
    ["Git ignore", ".gitignore", "INSTALL_PATH_CONFLICT"],
  ])("rejects a dangling %s symlink before any Poiesis write", async (_case, relativePath, code) => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const destination = join(repository.root, relativePath);
    await mkdir(join(destination, ".."), { recursive: true });
    await symlink("missing-target", destination);

    await expect(
      init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code });

    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repository.root, "opencode.jsonc"))).toBe(false);
  }, 30_000);

  it.each([
    ["OpenCode config", "opencode.jsonc"],
    ["managed destination", ".opencode/agents/poiesis-final-reviewer.md"],
    ["Git ignore", ".gitignore"],
  ])("rejects a %s created during environment verification", async (_case, relativePath) => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const bin = join(repository.parent, "bin");
    const target = join(repository.root, relativePath);
    const opencode = join(bin, "opencode");
    await mkdir(bin);
    await writeFile(
      opencode,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  mkdir -p "$(dirname "$POIESIS_TEST_TARGET")"\n  printf "{\\\"share\\\":\\\"disabled\\\"}\\n" > "$POIESIS_TEST_TARGET"\n  printf "1.18.29\\n"\n  exit 0\nfi\nif [ "$1" = "models" ]; then\n  printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"\n  exit 0\nfi\nexit 0\n',
    );
    await chmod(opencode, 0o755);
    const priorPath = process.env.PATH;
    const priorTarget = process.env.POIESIS_TEST_TARGET;
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    process.env.POIESIS_TEST_TARGET = target;
    try {
      await expect(
        init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
      ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
    } finally {
      process.env.PATH = priorPath;
      if (priorTarget === undefined) delete process.env.POIESIS_TEST_TARGET;
      else process.env.POIESIS_TEST_TARGET = priorTarget;
    }

    expect(await readFile(target, "utf8")).toBe('{"share":"disabled"}\n');
    if (relativePath !== ".gitignore") expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 30_000);

  it("rejects an existing OpenCode config changed during environment verification", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const bin = join(repository.parent, "bin");
    const configPath = join(repository.root, "opencode.jsonc");
    const opencode = join(bin, "opencode");
    await writeFile(configPath, '{ "share": "disabled" }\n');
    await mkdir(bin);
    await writeFile(
      opencode,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "{ \\"share\\": \\"changed\\" }\\n" > "$POIESIS_TEST_CONFIG"; printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"; exit 0; fi\nexit 0\n',
    );
    await chmod(opencode, 0o755);
    const priorPath = process.env.PATH;
    const priorConfig = process.env.POIESIS_TEST_CONFIG;
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    process.env.POIESIS_TEST_CONFIG = configPath;
    try {
      await expect(
        init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
      ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
    } finally {
      process.env.PATH = priorPath;
      if (priorConfig === undefined) delete process.env.POIESIS_TEST_CONFIG;
      else process.env.POIESIS_TEST_CONFIG = priorConfig;
    }

    expect(await readFile(configPath, "utf8")).toBe('{ "share": "changed" }\n');
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 30_000);

  it.each(["opencode.jsonc", ".gitignore"])("rejects invalid UTF-8 in %s without rewriting it", async (relativePath) => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, relativePath);
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    await writeFile(path, bytes);

    await expect(
      init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });

    expect(await readFile(path)).toEqual(bytes);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    if (relativePath === ".gitignore") expect(await exists(join(repository.root, "opencode.jsonc"))).toBe(false);
  }, 30_000);

  it("rejects a default skill file conflict before any repository write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const skill = join(repository.root, ".agents", "skills", "grilling");
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "foreign\n");

    await expect(
      init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "SKILL_PATH_CONFLICT" });

    expect(await readFile(skill, "utf8")).toBe("foreign\n");
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repository.root, "opencode.jsonc"))).toBe(false);
  }, 30_000);

  it("does not adopt a skill directory created during environment verification", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const bin = join(repository.parent, "bin");
    const skill = join(repository.root, ".agents", "skills", "grilling");
    const opencode = join(bin, "opencode");
    await mkdir(bin);
    await writeFile(
      opencode,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  mkdir -p "$POIESIS_TEST_SKILL"\n  printf "foreign\\n" > "$POIESIS_TEST_SKILL/SKILL.md"\n  printf "1.18.29\\n"\n  exit 0\nfi\nif [ "$1" = "models" ]; then\n  printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"\n  exit 0\nfi\nexit 0\n',
    );
    await chmod(opencode, 0o755);
    const priorPath = process.env.PATH;
    const priorSkill = process.env.POIESIS_TEST_SKILL;
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    process.env.POIESIS_TEST_SKILL = skill;
    try {
      await expect(
        init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
      ).rejects.toMatchObject({ code: "SKILL_PATH_CONFLICT" });
    } finally {
      process.env.PATH = priorPath;
      if (priorSkill === undefined) delete process.env.POIESIS_TEST_SKILL;
      else process.env.POIESIS_TEST_SKILL = priorSkill;
    }

    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe("foreign\n");
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
    expect(await exists(join(repository.root, "opencode.jsonc"))).toBe(false);
  }, 30_000);

  it("rejects a preexisting skill changed during environment verification", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const bin = join(repository.parent, "bin");
    const skill = join(repository.root, ".agents", "skills", "grilling");
    const skillFile = join(skill, "SKILL.md");
    const opencode = join(bin, "opencode");
    await mkdir(skill, { recursive: true });
    await writeFile(skillFile, "preexisting\n");
    await mkdir(bin);
    await writeFile(
      opencode,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "changed\\n" > "$POIESIS_TEST_SKILL_FILE"; printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"; exit 0; fi\nexit 0\n',
    );
    await chmod(opencode, 0o755);
    const priorPath = process.env.PATH;
    const priorSkillFile = process.env.POIESIS_TEST_SKILL_FILE;
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    process.env.POIESIS_TEST_SKILL_FILE = skillFile;
    try {
      await expect(
        init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
      ).rejects.toMatchObject({ code: "SKILL_PATH_CONFLICT" });
    } finally {
      process.env.PATH = priorPath;
      if (priorSkillFile === undefined) delete process.env.POIESIS_TEST_SKILL_FILE;
      else process.env.POIESIS_TEST_SKILL_FILE = priorSkillFile;
    }

    expect(await readFile(skillFile, "utf8")).toBe("changed\n");
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 30_000);

  it("rejects a preexisting skill whose empty directory tree changed during environment verification", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const bin = join(repository.parent, "bin");
    const skill = join(repository.root, ".agents", "skills", "grilling");
    const empty = join(skill, "empty");
    const opencode = join(bin, "opencode");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "preexisting\n");
    await mkdir(bin);
    await writeFile(
      opencode,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then mkdir -p "$POIESIS_TEST_EMPTY"; printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"; exit 0; fi\nexit 0\n',
    );
    await chmod(opencode, 0o755);
    const priorPath = process.env.PATH;
    const priorEmpty = process.env.POIESIS_TEST_EMPTY;
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    process.env.POIESIS_TEST_EMPTY = empty;
    try {
      await expect(
        init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
      ).rejects.toMatchObject({ code: "SKILL_PATH_CONFLICT" });
    } finally {
      process.env.PATH = priorPath;
      if (priorEmpty === undefined) delete process.env.POIESIS_TEST_EMPTY;
      else process.env.POIESIS_TEST_EMPTY = priorEmpty;
    }

    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe("preexisting\n");
    expect(await exists(empty)).toBe(true);
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 30_000);

  it("rejects a preexisting skill containing a symlink before any repository write", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const skill = join(repository.root, ".agents", "skills", "grilling");
    await mkdir(skill, { recursive: true });
    await symlink("missing", join(skill, "SKILL.md"));

    await expect(
      init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "SKILL_PATH_UNSAFE" });

    expect((await lstat(join(skill, "SKILL.md"))).isSymbolicLink()).toBe(true);
    expect(await exists(join(repository.root, ".gitignore"))).toBe(false);
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 30_000);

  it("restores exact config bytes when later ownership validation fails", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const bin = join(repository.parent, "bin");
    const configPath = join(repository.root, "opencode.jsonc");
    const gitignorePath = join(repository.root, ".gitignore");
    const opencode = join(bin, "opencode");
    const original = '{\n  "share": "disabled"\n}\n';
    await writeFile(configPath, original);
    await mkdir(bin);
    await writeFile(
      opencode,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"; exit 0; fi\nif [ "$1" = "debug" ]; then printf "foreign\\n" > "$POIESIS_TEST_GITIGNORE"; exit 0; fi\nexit 0\n',
    );
    await chmod(opencode, 0o755);
    const priorPath = process.env.PATH;
    const priorGitignore = process.env.POIESIS_TEST_GITIGNORE;
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    process.env.POIESIS_TEST_GITIGNORE = gitignorePath;
    try {
      await expect(
        init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true }),
      ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
    } finally {
      process.env.PATH = priorPath;
      if (priorGitignore === undefined) delete process.env.POIESIS_TEST_GITIGNORE;
      else process.env.POIESIS_TEST_GITIGNORE = priorGitignore;
    }

    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readFile(gitignorePath, "utf8")).toBe("foreign\n");
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
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
      hash: await hashOwnedSkillDirectory(skillPath),
    });
    await atomicWrite(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await replaceOwnershipReceipt(repository.root, manifest, await readOwnershipReceipt(repository.root));
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

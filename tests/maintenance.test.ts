import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/process.js";
import {
  autoResolveConfigDefaults,
  init,
  resolveConfigForRoot,
  uninstall,
  update,
  parseGitHubProject,
  parseGitLabProject,
  parseOpenCodeModelInventory,
  parseTrackerFromUrl,
} from "../src/maintenance.js";
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
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then\n  mkdir -p "$(dirname "$POIESIS_TEST_TARGET")"\n  printf "{\\"share\\":\\"disabled\\"}\\n" > "$POIESIS_TEST_TARGET"\n  printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"\n  exit 0\nfi\nexit 0\n',
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
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then printf "{ \\"share\\": \\"changed\\" }\\n" > "$POIESIS_TEST_CONFIG"; printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"; exit 0; fi\nexit 0\n',
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
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then\n  mkdir -p "$POIESIS_TEST_SKILL"\n  printf "foreign\\n" > "$POIESIS_TEST_SKILL/SKILL.md"\n  printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"\n  exit 0\nfi\nexit 0\n',
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
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.18.29\\n"; exit 0; fi\nif [ "$1" = "models" ]; then printf "changed\\n" > "$POIESIS_TEST_SKILL_FILE"; printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"; exit 0; fi\nexit 0\n',
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

describe("parseOpenCodeModelInventory (library seam)", () => {
  it("returns a set of newline-trimmed, non-empty identities", () => {
    const inventory = parseOpenCodeModelInventory(
      "openai/gpt-5.6-sol\nminimax/MiniMax-M3\n\nminimax/MiniMax-M3-alt\n",
    );
    expect(inventory).toBeInstanceOf(Set);
    expect([...inventory].sort()).toEqual([
      "minimax/MiniMax-M3",
      "minimax/MiniMax-M3-alt",
      "openai/gpt-5.6-sol",
    ]);
  });

  it("ignores whitespace-only lines and trims surrounding whitespace", () => {
    const inventory = parseOpenCodeModelInventory("  openai/gpt-5.6-sol  \n   \n\tminimax/MiniMax-M3\t\n");
    expect([...inventory]).toEqual(["openai/gpt-5.6-sol", "minimax/MiniMax-M3"]);
  });

  it("returns an empty set when the inventory is empty or whitespace", () => {
    expect([...parseOpenCodeModelInventory("")]).toEqual([]);
    expect([...parseOpenCodeModelInventory("   \n  \n")]).toEqual([]);
  });

  it("deduplicates repeated identities", () => {
    const inventory = parseOpenCodeModelInventory("openai/gpt-5.6-sol\nopenai/gpt-5.6-sol\nminimax/MiniMax-M3\n");
    expect(inventory.size).toBe(2);
    expect(inventory.has("openai/gpt-5.6-sol")).toBe(true);
    expect(inventory.has("minimax/MiniMax-M3")).toBe(true);
  });
});

describe("parseGitHubProject (library seam)", () => {
  it("parses HTTPS github.com URLs", () => {
    expect(parseGitHubProject("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGitHubProject("https://github.com/owner/repo")).toBe("owner/repo");
    expect(parseGitHubProject("http://github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("parses SSH github.com URLs", () => {
    expect(parseGitHubProject("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGitHubProject("git@github.com:owner/repo")).toBe("owner/repo");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parseGitHubProject("  git@github.com:owner/repo.git  ")).toBe("owner/repo");
    expect(parseGitHubProject(" https://github.com/owner/repo.git\n")).toBe("owner/repo");
  });

  it("returns null for non-github hosts", () => {
    expect(parseGitHubProject("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGitHubProject("https://git.example.com/owner/repo.git")).toBeNull();
  });

  it("returns null for malformed github URLs", () => {
    expect(parseGitHubProject("https://github.com/single-segment")).toBeNull();
    expect(parseGitHubProject("https://github.com/")).toBeNull();
    expect(parseGitHubProject("not a url")).toBeNull();
    expect(parseGitHubProject("")).toBeNull();
  });
});

describe("parseGitLabProject (library seam)", () => {
  it("parses HTTPS gitlab.com URLs with two segments", () => {
    expect(parseGitLabProject("https://gitlab.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGitLabProject("https://gitlab.com/owner/repo")).toBe("owner/repo");
    expect(parseGitLabProject("http://gitlab.com/owner/repo.git")).toBe("owner/repo");
  });

  it("parses SSH gitlab.com URLs with two segments", () => {
    expect(parseGitLabProject("git@gitlab.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGitLabProject("git@gitlab.com:owner/repo")).toBe("owner/repo");
  });

  it("parses gitlab.com URLs with nested groups (HTTPS)", () => {
    expect(parseGitLabProject("https://gitlab.com/group/subgroup/repo.git")).toBe("group/subgroup/repo");
    expect(parseGitLabProject("https://gitlab.com/a/b/c/d/e/repo.git")).toBe("a/b/c/d/e/repo");
    expect(parseGitLabProject("https://gitlab.com/group/subgroup/repo")).toBe("group/subgroup/repo");
  });

  it("parses gitlab.com URLs with nested groups (SSH)", () => {
    expect(parseGitLabProject("git@gitlab.com:group/subgroup/repo.git")).toBe("group/subgroup/repo");
    expect(parseGitLabProject("git@gitlab.com:a/b/c/d/e/repo.git")).toBe("a/b/c/d/e/repo");
  });

  it("returns null for a single-segment gitlab.com URL (group only, no project)", () => {
    expect(parseGitLabProject("https://gitlab.com/single-segment")).toBeNull();
    expect(parseGitLabProject("https://gitlab.com/single-segment.git")).toBeNull();
    expect(parseGitLabProject("git@gitlab.com:single-segment.git")).toBeNull();
  });

  it("returns null for non-gitlab hosts", () => {
    expect(parseGitLabProject("https://github.com/owner/repo.git")).toBeNull();
    expect(parseGitLabProject("https://gitlab.example.com/owner/repo.git")).toBeNull();
  });

  it("returns null for malformed or empty URLs", () => {
    expect(parseGitLabProject("https://gitlab.com/")).toBeNull();
    expect(parseGitLabProject("https://gitlab.com")).toBeNull();
    expect(parseGitLabProject("not a url")).toBeNull();
    expect(parseGitLabProject("")).toBeNull();
  });

  it("does not match gitlab.com URLs with empty segments (e.g., trailing slash, double slash)", () => {
    expect(parseGitLabProject("https://gitlab.com/group//repo.git")).toBeNull();
    expect(parseGitLabProject("git@gitlab.com:group//repo.git")).toBeNull();
  });
});

describe("parseTrackerFromUrl (library seam)", () => {
  it("dispatches github.com URLs to the github provider", () => {
    expect(parseTrackerFromUrl("https://github.com/owner/repo.git")).toEqual({
      provider: "github",
      project: "owner/repo",
    });
    expect(parseTrackerFromUrl("git@github.com:owner/repo.git")).toEqual({
      provider: "github",
      project: "owner/repo",
    });
  });

  it("dispatches gitlab.com URLs to the gitlab provider with nested groups", () => {
    expect(parseTrackerFromUrl("https://gitlab.com/group/subgroup/repo.git")).toEqual({
      provider: "gitlab",
      project: "group/subgroup/repo",
    });
    expect(parseTrackerFromUrl("git@gitlab.com:group/subgroup/repo.git")).toEqual({
      provider: "gitlab",
      project: "group/subgroup/repo",
    });
  });

  it("does not invent a tracker provider for unknown / self-hosted hosts", () => {
    expect(parseTrackerFromUrl("https://git.example.com/owner/repo.git")).toBeNull();
    expect(parseTrackerFromUrl("https://gitlab.example.com/owner/repo.git")).toBeNull();
    expect(parseTrackerFromUrl("ssh://git@internal/owner/repo.git")).toBeNull();
    expect(parseTrackerFromUrl("git@github.example.com:owner/repo.git")).toBeNull();
  });

  it("does not invent a tracker provider for malformed URLs", () => {
    expect(parseTrackerFromUrl("not a url")).toBeNull();
    expect(parseTrackerFromUrl("")).toBeNull();
    expect(parseTrackerFromUrl("https://github.com/")).toBeNull();
    expect(parseTrackerFromUrl("https://gitlab.com/")).toBeNull();
  });
});

describe("autoResolveConfigDefaults tracker discovery (library seam)", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () =>
    Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))),
  );

  async function setRemoteUrl(repository: TestRepository, url: string): Promise<void> {
    await run("git", ["remote", "set-url", "origin", url], { cwd: repository.root });
  }

  function baseDraft(repository: TestRepository): Parameters<typeof autoResolveConfigDefaults>[1] {
    return {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      tracker: { provider: "github" },
      delivery: {
        preview: { adapter: "command", command: ["echo", "{sha}"] },
        staging: { adapter: "command", command: ["echo", "{sha}"] },
        production: { adapter: "command", command: ["echo", "{sha}"] },
      },
      verification: { commands: ["test -f README.md"] },
    };
  }

  it("fills tracker.project from a github.com HTTPS remote when omitted", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "https://github.com/poiesis-test/qualification.git");
    const draft = baseDraft(repository);
    const result = await autoResolveConfigDefaults(repository.root, draft);
    expect(result.config.tracker).toEqual({ provider: "github", project: "poiesis-test/qualification" });
    expect(result.discovered.tracker).toBe(true);
  });

  it("fills tracker.project from a github.com SSH remote when omitted", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "git@github.com:poiesis-test/qualification.git");
    const draft = baseDraft(repository);
    const result = await autoResolveConfigDefaults(repository.root, draft);
    expect(result.config.tracker).toEqual({ provider: "github", project: "poiesis-test/qualification" });
    expect(result.discovered.tracker).toBe(true);
  });

  it("fills tracker.project from a gitlab.com HTTPS remote with nested groups when omitted", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "https://gitlab.com/poiesis-group/subgroup/repo.git");
    const draft: Parameters<typeof autoResolveConfigDefaults>[1] = {
      ...baseDraft(repository),
      tracker: { provider: "gitlab" },
    };
    const result = await autoResolveConfigDefaults(repository.root, draft);
    expect(result.config.tracker).toEqual({
      provider: "gitlab",
      project: "poiesis-group/subgroup/repo",
    });
    expect(result.discovered.tracker).toBe(true);
  });

  it("fills tracker.project from a gitlab.com SSH remote with nested groups when omitted", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "git@gitlab.com:poiesis-group/subgroup/repo.git");
    const draft: Parameters<typeof autoResolveConfigDefaults>[1] = {
      ...baseDraft(repository),
      tracker: { provider: "gitlab" },
    };
    const result = await autoResolveConfigDefaults(repository.root, draft);
    expect(result.config.tracker).toEqual({
      provider: "gitlab",
      project: "poiesis-group/subgroup/repo",
    });
    expect(result.discovered.tracker).toBe(true);
  });

  it("does not invent a tracker provider when the configured provider is github but the remote is gitlab", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "https://gitlab.com/some-group/repo.git");
    const draft = baseDraft(repository);
    await expect(autoResolveConfigDefaults(repository.root, draft)).rejects.toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
    });
  });

  it("does not invent a tracker provider when the configured provider is gitlab but the remote is github", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "https://github.com/owner/repo.git");
    const draft: Parameters<typeof autoResolveConfigDefaults>[1] = {
      ...baseDraft(repository),
      tracker: { provider: "gitlab" },
    };
    await expect(autoResolveConfigDefaults(repository.root, draft)).rejects.toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
    });
  });

  it("does not invent a tracker provider when the remote host is unknown / self-hosted", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "https://git.example.com/owner/repo.git");
    const draft = baseDraft(repository);
    await expect(autoResolveConfigDefaults(repository.root, draft)).rejects.toMatchObject({
      code: "INVALID_TRACKER_CONFIG",
    });
  });

  it("preserves an explicitly configured tracker.project without re-discovering from the remote", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await setRemoteUrl(repository, "https://github.com/different-owner/different-repo.git");
    const draft: Parameters<typeof autoResolveConfigDefaults>[1] = {
      ...baseDraft(repository),
      tracker: { provider: "github", project: "explicit/owner" },
    };
    const result = await autoResolveConfigDefaults(repository.root, draft);
    expect(result.config.tracker).toEqual({ provider: "github", project: "explicit/owner" });
    expect(result.discovered.tracker).toBe(false);
  });
});

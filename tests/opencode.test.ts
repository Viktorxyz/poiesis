import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOpenCodeConfig,
  assertOpenCodeConfigAvailable,
  desiredOpenCodePatches,
  detectOpenCodeConfigForInit,
  reverseOpenCodeConfig,
} from "../src/opencode.js";
import { parseJsonc } from "../src/config.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

describe("OpenCode adapter", () => {
  const repositories: TestRepository[] = [];
  afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

  it("uses the verified 1.18.29 schema and preserves unrelated config", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, '{\n  "$schema": "https://opencode.ai/config.json",\n  "share": "disabled"\n}\n');
    const patches = await applyOpenCodeConfig(repository.root, testConfig(repository));
    const installed = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"), path);

    expect(installed.share).toBe("disabled");
    expect(installed.default_agent).toBe("poiesis");
    expect(installed.subagent_depth).toBe(2);
    expect(installed).toHaveProperty("agent.poiesis.permission.bash.poiesis *", "allow");
    expect(installed).toHaveProperty("agent.poiesis-worker.permission.bash.git *", "deny");
    expect(installed).not.toHaveProperty("agents");
    expect(installed).not.toHaveProperty("permissions");

    await reverseOpenCodeConfig(repository.root, patches);
    const restored = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"), path);
    expect(restored).toEqual({ $schema: "https://opencode.ai/config.json", share: "disabled" });
  });

  it("projects all six roles and native Explore routing", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = desiredOpenCodePatches(testConfig(repository));
    expect(patches.map((entry) => entry.path.join("."))).toEqual([
      "default_agent",
      "subagent_depth",
      "agent.explore",
      "agent.poiesis",
      "agent.poiesis-planner",
      "agent.poiesis-worker",
      "agent.poiesis-research",
      "agent.poiesis-reviewer",
      "agent.poiesis-final-reviewer",
    ]);
  });

  it("marks internal subagents as hidden subagents", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, "{}\n");
    const patches = await applyOpenCodeConfig(repository.root, testConfig(repository));
    const installed = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"), path);
    expect(installed.agent).toMatchObject({
      poiesis: { mode: "primary" },
      "poiesis-planner": { mode: "subagent", hidden: true },
      "poiesis-worker": { mode: "subagent", hidden: true },
      "poiesis-research": { mode: "subagent", hidden: true },
      "poiesis-reviewer": { mode: "subagent", hidden: true },
      "poiesis-final-reviewer": { mode: "subagent", hidden: true },
    });
  });

  it("routes specialists through configured reasoning and execution models", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const config = testConfig(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(config).map((patch) => [patch.path.join("."), patch.value as Record<string, unknown>]),
    );
    expect(patches["agent.poiesis"]).toMatchObject({ mode: "primary", model: config.models.reasoning });
    expect(patches["agent.poiesis-planner"]).toMatchObject({ mode: "subagent", model: config.models.reasoning });
    expect(patches["agent.poiesis-final-reviewer"]).toMatchObject({ mode: "subagent", model: config.models.reasoning });
    expect(patches["agent.poiesis-worker"]).toMatchObject({ mode: "subagent", model: config.models.execution });
    expect(patches["agent.poiesis-research"]).toMatchObject({ mode: "subagent", model: config.models.execution });
    expect(patches["agent.poiesis-reviewer"]).toMatchObject({ mode: "subagent", model: config.models.execution });
    expect(patches["agent.explore"]).toMatchObject({ model: config.models.execution });
    expect(patches["agent.poiesis"]?.permission).toMatchObject({
      task: {
        explore: "allow",
        "poiesis-planner": "allow",
        "poiesis-worker": "allow",
        "poiesis-research": "allow",
        "poiesis-reviewer": "allow",
        "poiesis-final-reviewer": "allow",
      },
    });
    expect(patches["agent.poiesis"]?.permission).not.toHaveProperty("task.build");
  });

  it.each([
    ["default_agent", { default_agent: "poiesis" }],
    ["subagent_depth", { subagent_depth: 2 }],
    ["agent.explore", { agent: { explore: {} } }],
    ["agent.poiesis", { agent: { poiesis: {} } }],
    ["agent.poiesis-planner", { agent: { "poiesis-planner": {} } }],
    ["agent.poiesis-worker", { agent: { "poiesis-worker": {} } }],
    ["agent.poiesis-research", { agent: { "poiesis-research": {} } }],
    ["agent.poiesis-reviewer", { agent: { "poiesis-reviewer": {} } }],
    ["agent.poiesis-final-reviewer", { agent: { "poiesis-final-reviewer": {} } }],
  ])("rejects the preexisting reserved path %s", async (_name, content) => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, `${JSON.stringify(content)}\n`);

    await expect(assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository))).rejects.toMatchObject({
      code: "INSTALL_PATH_CONFLICT",
    });
  });

  it("rejects ambiguous OpenCode config locations", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(join(repository.root, "opencode.jsonc"), "{}\n");
    await mkdir(join(repository.root, ".opencode"));
    await writeFile(join(repository.root, ".opencode", "opencode.json"), "{}\n");

    await expect(detectOpenCodeConfigForInit(repository.root)).rejects.toMatchObject({ code: "OPENCODE_CONFIG_AMBIGUOUS" });
  });

  it("rejects a dangling OpenCode config symlink", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await symlink("missing.jsonc", path);

    await expect(
      assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository)),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
  });

  it("rejects incompatible and duplicate config structure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, '{ "agent": "foreign" }\n');

    await expect(
      assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository)),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });

    await writeFile(path, '{ "agent": { "poiesis": {} }, "agent": {} }\n');
    await expect(
      assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository)),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
  });

  it("rechecks reserved paths at the init write boundary", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    const original = '{ "default_agent": "foreign" }\n';
    await writeFile(path, original);

    await expect(
      applyOpenCodeConfig(repository.root, testConfig(repository), path, { requireAvailable: true }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("reports the exact config bytes successfully written", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, '{ "share": "disabled" }');
    let written: string | undefined;

    await applyOpenCodeConfig(repository.root, testConfig(repository), path, {
      onWritten: (content) => {
        written = content;
      },
    });

    expect(written).toBeDefined();
    expect(await readFile(path, "utf8")).toBe(written);
  });

  it("rejects config bytes that changed after their ownership snapshot", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    const expected = Buffer.from('{ "share": "disabled" }\n');
    await writeFile(path, expected);
    await writeFile(path, '{ "share": "changed" }\n');

    await expect(
      applyOpenCodeConfig(repository.root, testConfig(repository), path, {
        requireAvailable: true,
        expectedContent: expected,
      }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe('{ "share": "changed" }\n');
  });
});

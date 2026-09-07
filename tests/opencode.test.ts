import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOpenCodeConfig, desiredOpenCodePatches, reverseOpenCodeConfig } from "../src/opencode.js";
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
});

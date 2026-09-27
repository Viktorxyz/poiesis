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
import { readTemplate } from "../src/templates.js";
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
    const patches = await applyOpenCodeConfig(repository.root, testConfig(repository), undefined, "1.1.2");
    const installed = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"), path);

    expect(installed.share).toBe("disabled");
    expect(installed.default_agent).toBe("poiesis");
    expect(installed.subagent_depth).toBe(2);
    // Ticket #105: the runtime identity boundary uses an exact-version
    // canonical route (last-match-wins allow) plus ordered ambiguous
    // launcher denies; the bare `poiesis` form is no longer a canonical
    // route and is denied.
    expect(installed).toHaveProperty("agent.poiesis.permission.bash.*", "allow");
    expect(installed).toHaveProperty("agent.poiesis.permission.bash.poiesis *", "deny");
    expect(installed).toHaveProperty("agent.poiesis-worker.permission.bash.git *", "deny");
    expect(installed).not.toHaveProperty("agents");
    expect(installed).not.toHaveProperty("permissions");

    await reverseOpenCodeConfig(repository.root, patches);
    const restored = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"), path);
    expect(restored).toEqual({ $schema: "https://opencode.ai/config.json", share: "disabled" });
  });

  it("primary bash denies ambiguous launchers and allows only the exact-version canonical route", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const config = testConfig(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(config, "1.1.2").map((patch) => [patch.path.join("."), patch.value as Record<string, unknown>]),
    );
    const primaryBash = (patches["agent.poiesis"] as { permission: { bash: Record<string, string> } }).permission.bash;
    // Broad ordinary shell allow first; ordered ambiguous launcher denies
    // follow; the exact-version canonical route is the LAST entry so that
    // OpenCode's last-match-wins resolver prefers it for any command
    // matching `pnpm dlx poiesis-cli@<manifest.poiesisVersion> *`.
    expect(primaryBash["*"]).toBe("allow");
    expect(primaryBash["poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm exec poiesis *"]).toBe("deny");
    expect(primaryBash["npx poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli *"]).toBe("deny");
    // Spec #104 / ticket #110: deny version-qualified alternate routes
    // (e.g. `pnpm dlx poiesis-cli@latest`, `pnpm dlx poiesis-cli@1.0.0`)
    // BEFORE the exact manifest route allow last. The broad `*` allow at
    // the head would otherwise let every off-version dlx invocation slip
    // through; the ordered deny collapses the version-qualified surface
    // so only `pnpm dlx poiesis-cli@<manifest.poiesisVersion>` survives.
    expect(primaryBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli@1.1.2 *"]).toBe("allow");
    // The exact-version canonical route must be the LAST key in the
    // serialized bash object so last-match-wins resolves it last.
    const lastKey = Object.keys(primaryBash).at(-1);
    expect(lastKey).toBe("pnpm dlx poiesis-cli@1.1.2 *");
    // The version-qualified deny MUST sit BEFORE the exact allow so
    // last-match-wins cannot resolve a deny for an exact-version key.
    const keys = Object.keys(primaryBash);
    const versionQualifiedDenyIdx = keys.indexOf("pnpm dlx poiesis-cli@*");
    const exactAllowIdx = keys.indexOf("pnpm dlx poiesis-cli@1.1.2 *");
    expect(versionQualifiedDenyIdx).toBeGreaterThanOrEqual(0);
    expect(exactAllowIdx).toBeGreaterThan(versionQualifiedDenyIdx);
  });

  it("worker and specialist authority is unchanged: only primary retains lifecycle exact-version allow", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const config = testConfig(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(config, "1.1.2").map((patch) => [patch.path.join("."), patch.value as Record<string, unknown>]),
    );
    const workerBash = (patches["agent.poiesis-worker"] as { permission: { bash: Record<string, string> } }).permission.bash;
    // Spec #104 / ticket #113: the Worker must deny every known
    // package-runner lifecycle launcher in addition to the existing
    // bare/exec/npx denies. Worker has no primary-style exact-version
    // ALLOW for arbitrary Poiesis lifecycle, so the broad `*` allow
    // first is kept narrow by the two ordered `pnpm dlx` denies
    // below; the exact manifest-version allow for arbitrary lifecycle
    // is reserved for the primary alone.
    //
    // Spec #120 / ticket #123 ADDS the four narrow Repository
    // Intelligence subcommand allows (status / query / path / explain)
    // AFTER the `pnpm dlx poiesis-cli@*` deny so OpenCode's
    // last-match-wins resolver grants only the documented operations
    // and leaves every other Poiesis lifecycle invocation denied.
    expect(workerBash).toEqual({
      "*": "allow",
      "git *": "deny",
      "poiesis *": "deny",
      "pnpm exec poiesis *": "deny",
      "npx poiesis *": "deny",
      "pnpm dlx poiesis-cli *": "deny",
      "pnpm dlx poiesis-cli@*": "deny",
      "pnpm dlx poiesis-cli@1.1.2 repository status": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository query *": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository path *": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository explain *": "allow",
    });
    expect(workerBash["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(workerBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    // Worker must NOT retain a primary-style arbitrary-lifecycle
    // exact-version allow (e.g. `pnpm dlx poiesis-cli@1.1.2 *`).
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 *");
    // Worker MUST NOT gain lifecycle subcommand allows.
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 workspace *");
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 checkpoint *");
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 publish *");
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 integrate *");
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 promote *");
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 tracker *");
    expect(workerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 capability *");
    // Primary alone retains the lifecycle exact-version canonical route.
    const primaryBash = (patches["agent.poiesis"] as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(primaryBash["pnpm dlx poiesis-cli@1.1.2 *"]).toBe("allow");
  });

  it("exact-version canonical route is sourced from the installed package version", async () => {
    // Spec #104 / ticket #105: the sole durable source of the exact
    // version X in `pnpm dlx poiesis-cli@X` is the installed package
    // version. The desiredOpenCodePatches call derives this from
    // package.json so the route always matches the package shipped to
    // consumers.
    const repository = await createTestRepository();
    repositories.push(repository);
    const config = testConfig(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(config, "1.1.2").map((patch) => [patch.path.join("."), patch.value as Record<string, unknown>]),
    );
    const primaryBash = (patches["agent.poiesis"] as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(primaryBash).toHaveProperty("pnpm dlx poiesis-cli@1.1.2 *", "allow");
  });

  it("projects all six roles and native Explore routing", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = desiredOpenCodePatches(testConfig(repository), "1.1.2");
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
    const patches = await applyOpenCodeConfig(repository.root, testConfig(repository), undefined, "1.1.2");
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
      desiredOpenCodePatches(config, "1.1.2").map((patch) => [patch.path.join("."), patch.value as Record<string, unknown>]),
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

  it("strips native Task/Explore delegation from the ticket Reviewer projection", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), "1.1.2").map((patch) => [
        patch.path.join("."),
        patch.value as Record<string, unknown>,
      ]),
    );
    const reviewer = patches["agent.poiesis-reviewer"] as { permission: Record<string, unknown> };
    expect(reviewer.permission).not.toHaveProperty("task");
    // Spec #120 / ticket #123: ticket Reviewer now carries a narrow
    // Repository Intelligence bash surface (the four exact-version
    // subcommand allows) instead of NO bash at all. The Reviewer
    // still must not gain arbitrary shell or Poiesis lifecycle
    // ownership.
    expect(reviewer.permission).toHaveProperty("bash");
    const reviewerBash = (reviewer.permission as { bash: Record<string, string> }).bash;
    expect(reviewerBash["*"]).toBe("deny");
    expect(reviewerBash["pnpm dlx poiesis-cli@1.1.2 repository status"]).toBe("allow");
    expect(reviewerBash["pnpm dlx poiesis-cli@1.1.2 repository query *"]).toBe("allow");
    expect(reviewerBash["pnpm dlx poiesis-cli@1.1.2 repository path *"]).toBe("allow");
    expect(reviewerBash["pnpm dlx poiesis-cli@1.1.2 repository explain *"]).toBe("allow");
    // No arbitrary bash.
    expect(reviewerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 *");
    expect(reviewerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 workspace *");
    expect(reviewerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 publish *");
    expect(reviewerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 integrate *");
    expect(reviewerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 promote *");
    expect(reviewerBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 tracker *");
  });

  it("keeps direct read/glob/grep/list and code-review on the ticket Reviewer", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), "1.1.2").map((patch) => [
        patch.path.join("."),
        patch.value as Record<string, unknown>,
      ]),
    );
    const reviewer = patches["agent.poiesis-reviewer"] as { permission: Record<string, unknown> };
    expect(reviewer.permission).toMatchObject({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      skill: { "code-review": "allow" },
    });
  });

  it("preserves required native child routes on the other specialists", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), "1.1.2").map((patch) => [
        patch.path.join("."),
        patch.value as Record<string, unknown>,
      ]),
    );
    expect((patches["agent.poiesis-final-reviewer"] as { permission: Record<string, unknown> }).permission).toMatchObject({
      task: { explore: "allow" },
    });
    expect((patches["agent.poiesis-worker"] as { permission: Record<string, unknown> }).permission).toMatchObject({
      task: { explore: "allow" },
    });
    expect((patches["agent.poiesis-planner"] as { permission: Record<string, unknown> }).permission).toMatchObject({
      task: { explore: "allow", "poiesis-research": "allow" },
    });
    expect((patches["agent.poiesis"] as { permission: Record<string, unknown> }).permission).toMatchObject({
      task: {
        explore: "allow",
        "poiesis-planner": "allow",
        "poiesis-worker": "allow",
        "poiesis-research": "allow",
        "poiesis-reviewer": "allow",
        "poiesis-final-reviewer": "allow",
      },
    });
    expect((patches["agent.poiesis-research"] as { permission: Record<string, unknown> }).permission).not.toHaveProperty(
      "task",
    );
  });

  // ============================================================================
  // Spec #120 / ticket #123 — Repository Intelligence bash surface
  // ============================================================================

  it("ticket #123: Planner bash grants only the four exact-version repository subcommands", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), "1.1.2").map((patch) => [
        patch.path.join("."),
        patch.value as Record<string, unknown>,
      ]),
    );
    const planner = patches["agent.poiesis-planner"] as { permission: { bash: Record<string, string> } };
    // The Planner previously had no bash at all. ticket #123 adds a
    // narrow surface: `*` is denied, only the four exact-version
    // repository subcommands are allowed.
    expect(planner.permission.bash).toEqual({
      "*": "deny",
      "pnpm dlx poiesis-cli@1.1.2 repository status": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository query *": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository path *": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository explain *": "allow",
    });
  });

  it("ticket #123: Final Reviewer bash grants only the four exact-version repository subcommands", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), "1.1.2").map((patch) => [
        patch.path.join("."),
        patch.value as Record<string, unknown>,
      ]),
    );
    const finalReviewer = patches["agent.poiesis-final-reviewer"] as { permission: { bash: Record<string, string> } };
    expect(finalReviewer.permission.bash).toEqual({
      "*": "deny",
      "pnpm dlx poiesis-cli@1.1.2 repository status": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository query *": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository path *": "allow",
      "pnpm dlx poiesis-cli@1.1.2 repository explain *": "allow",
    });
  });

  it("ticket #123: Research bash never carries a repository subcommand allow (Research owns external facts only)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), "1.1.2").map((patch) => [
        patch.path.join("."),
        patch.value as Record<string, unknown>,
      ]),
    );
    const research = patches["agent.poiesis-research"] as { permission: Record<string, unknown> };
    expect(research.permission).not.toHaveProperty("bash");
    // Belt-and-braces: if any future refactor accidentally adds a
    // `bash` map to Research, ensure the four repository subcommand
    // allows do NOT appear.
    const researchBash = (research.permission as { bash?: Record<string, string> }).bash;
    if (researchBash !== undefined) {
      expect(researchBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 repository status");
      expect(researchBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 repository query *");
      expect(researchBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 repository path *");
      expect(researchBash).not.toHaveProperty("pnpm dlx poiesis-cli@1.1.2 repository explain *");
    }
  });

  it("ticket #123: the four repository subcommand allows use the exact-version canonical route (no bare / @latest / @* survives)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), "1.1.2").map((patch) => [
        patch.path.join("."),
        patch.value as Record<string, unknown>,
      ]),
    );
    for (const agentName of ["agent.poiesis-planner", "agent.poiesis-reviewer", "agent.poiesis-final-reviewer", "agent.poiesis-worker"]) {
      const bash = (patches[agentName] as { permission: { bash: Record<string, string> } }).permission.bash;
      // No bare-launcher allows.
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli repository status");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli repository query *");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli repository path *");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli repository explain *");
      // No version-qualified alternate routes (`@latest`, `@1.1.1`, …).
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@latest repository status");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@latest repository query *");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@latest repository path *");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@latest repository explain *");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@* repository status");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@* repository query *");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@* repository path *");
      expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@* repository explain *");
    }
  });

  it("strips ticket Reviewer Explore delegation from the V2 design template while keeping other agent subagent routes", async () => {
    const template = await readTemplate("OPENCODE_CONFIG_PATCH_V2.jsonc");
    const parsed = parseJsonc<{
      agents: Record<string, { model: string; permissions: Array<{ action: string; resource: string; effect: string }> }>;
    }>(template, "OPENCODE_CONFIG_PATCH_V2.jsonc");
    const reviewerPermissions = parsed.agents["poiesis-reviewer"]!.permissions;
    expect(reviewerPermissions).toContainEqual({ action: "read", resource: "*", effect: "allow" });
    expect(reviewerPermissions).toContainEqual({ action: "glob", resource: "*", effect: "allow" });
    expect(reviewerPermissions).toContainEqual({ action: "grep", resource: "*", effect: "allow" });
    expect(reviewerPermissions).toContainEqual({ action: "list", resource: "*", effect: "allow" });
    expect(reviewerPermissions).toContainEqual({ action: "skill", resource: "code-review", effect: "allow" });
    expect(reviewerPermissions.some((rule) => rule.action === "subagent")).toBe(false);

    expect(parsed.agents["poiesis-final-reviewer"]!.permissions).toContainEqual({
      action: "subagent",
      resource: "explore",
      effect: "allow",
    });
    expect(parsed.agents["poiesis-worker"]!.permissions).toContainEqual({
      action: "subagent",
      resource: "explore",
      effect: "allow",
    });
    expect(parsed.agents["poiesis-planner"]!.permissions).toContainEqual({
      action: "subagent",
      resource: "explore",
      effect: "allow",
    });
    expect(parsed.agents["poiesis-planner"]!.permissions).toContainEqual({
      action: "subagent",
      resource: "poiesis-research",
      effect: "allow",
    });
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

    await expect(assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository), "1.1.2")).rejects.toMatchObject({
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
      assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository), "1.1.2"),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
  });

  it("rejects incompatible and duplicate config structure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, '{ "agent": "foreign" }\n');

    await expect(
      assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository), "1.1.2"),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });

    await writeFile(path, '{ "agent": { "poiesis": {} }, "agent": {} }\n');
    await expect(
      assertOpenCodeConfigAvailable(repository.root, path, testConfig(repository), "1.1.2"),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
  });

  it("rechecks reserved paths at the init write boundary", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    const original = '{ "default_agent": "foreign" }\n';
    await writeFile(path, original);

    await expect(
      applyOpenCodeConfig(repository.root, testConfig(repository), path, "1.1.2", { requireAvailable: true }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("reports the exact config bytes successfully written", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, '{ "share": "disabled" }');
    let written: string | undefined;

    await applyOpenCodeConfig(repository.root, testConfig(repository), path, "1.1.2", {
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
      applyOpenCodeConfig(repository.root, testConfig(repository), path, "1.1.2", {
        requireAvailable: true,
        expectedContent: expected,
      }),
    ).rejects.toMatchObject({ code: "INSTALL_PATH_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe('{ "share": "changed" }\n');
  });

  it("never projects an external_directory permission key on any specialist", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const config = testConfig(repository);
    const patches = desiredOpenCodePatches(config, "1.1.2");
    for (const patch of patches) {
      const value = patch.value as Record<string, unknown> | string | number | boolean | undefined;
      expect(patch.path).not.toContain("external_directory");
      expect(patch.path).not.toContain("externalDirectory");
      expect(value).not.toHaveProperty("external_directory");
      expect(value).not.toHaveProperty("externalDirectory");
    }
    // Also assert that the installed opencode.jsonc contains no
    // external_directory key on any agent, after the managed config
    // has been written.
    const path = join(repository.root, "opencode.jsonc");
    await writeFile(path, "{}\n");
    await applyOpenCodeConfig(repository.root, config, path, "1.1.2");
    const installed = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"), path);
    const agents = (installed.agent ?? {}) as Record<string, unknown>;
    for (const agent of Object.values(agents)) {
      const permission = (agent as { permission?: Record<string, unknown> }).permission;
      if (permission !== undefined) {
        expect(permission).not.toHaveProperty("external_directory");
        expect(permission).not.toHaveProperty("externalDirectory");
      }
    }
    expect(JSON.stringify(installed)).not.toContain("external_directory");
    expect(JSON.stringify(installed)).not.toContain("externalDirectory");
  });
});

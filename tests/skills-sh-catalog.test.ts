/**
 * Spec #207 / ticket #208 — skills.sh catalog discovery, default pins,
 * native skill permissions, catalog provenance, and authentic 1.6.0
 * static-skill predecessor migration.
 *
 * Pure / in-memory only: injected fetch, no git-init fixtures, no network.
 */
import { describe, expect, it } from "vitest";
import {
  isExactProjection,
  predecessorProjectionPreFocusedCheck,
  predecessorProjectionV160StaticSkills,
} from "../src/authority.js";
import type { PoiesisConfig } from "../src/config.js";
import type { Manifest } from "../src/manifest.js";
import {
  WORKER_LOCAL_LIFECYCLE_DENY_KEYS,
  desiredOpenCodePatches,
  OPENCODE_V160_STATIC_SKILL_PERMISSIONS,
  stripWorkerLocalLifecycleDenies,
} from "../src/opencode.js";
import {
  FIND_SKILLS_REVISION,
  FIND_SKILLS_SOURCE,
  loadDefaultSkills,
  MATT_SKILLS_REVISION,
  resolveCapabilityCatalogProvenance,
  sanitizeDiscoveryQuery,
  searchSkillsCatalog,
  SKILLS_DISCOVERY_MAX_RESULTS,
  SKILLS_DISCOVERY_MAX_SEARCHES,
  SKILLS_DISCOVERY_MAX_SELECTED,
  SKILLS_SH_SEARCH_URL,
  SUPERPOWERS_REVISION,
  WRITING_FOR_AGENTS_REVISION,
} from "../src/skills.js";
import { PoiesisError } from "../src/errors.js";

function testConfig(): PoiesisConfig {
  return {
    schema: 1,
    models: { reasoning: "test/reasoning", execution: "test/execution" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "github", project: "example/example" },
    delivery: { mode: "deferred" },
    verification: { commands: ["true"] },
  };
}

function manifestFromPatches(
  poiesisVersion: string,
  patches: Array<{ path: string[]; value: unknown }>,
): Manifest {
  return {
    schema: 1,
    poiesisVersion,
    adapter: {
      harness: "opencode",
      adapterVersion: "1",
      supportedVersion: "1.18.29",
      supportedVersions: ["1.18.29", "1.18.30", "1.18.31"],
    },
    files: [],
    skills: [],
    configPatches: patches.map((patch) => ({
      file: "opencode.jsonc",
      path: patch.path,
      previousExists: false,
      installed: patch.value,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("skills.sh catalog bounds and defaults (ticket #208)", () => {
  it("pins discovery bounds and the skills.sh search endpoint", () => {
    expect(SKILLS_SH_SEARCH_URL).toBe("https://skills.sh/api/search");
    expect(SKILLS_DISCOVERY_MAX_RESULTS).toBe(20);
    expect(SKILLS_DISCOVERY_MAX_SEARCHES).toBe(2);
    expect(SKILLS_DISCOVERY_MAX_SELECTED).toBe(3);
  });

  it("loads thirteen curated defaults including find-skills and writing-for-agents pins", async () => {
    const defaults = await loadDefaultSkills();
    expect(defaults).toHaveLength(13);
    const names = defaults.map((skill) => skill.name);
    expect(names).toContain("find-skills");
    expect(names).toContain("writing-for-agents");
    expect(names).toContain("to-spec");
    expect(names).toContain("test-driven-development");
    expect(names).not.toContain("writing-plans");
    expect(names).not.toContain("graphify");

    const writing = defaults.find((skill) => skill.name === "writing-for-agents");
    expect(writing).toEqual({
      source: "mattpocock/skills",
      name: "writing-for-agents",
      revision: WRITING_FOR_AGENTS_REVISION,
    });
    expect(WRITING_FOR_AGENTS_REVISION).toBe("49dd158d1076134a641b33efb035946536778336");
    expect(WRITING_FOR_AGENTS_REVISION).not.toBe(MATT_SKILLS_REVISION);

    const findSkills = defaults.find((skill) => skill.name === "find-skills");
    expect(findSkills).toEqual({
      source: FIND_SKILLS_SOURCE,
      name: "find-skills",
      revision: FIND_SKILLS_REVISION,
    });
    expect(FIND_SKILLS_SOURCE).toBe("vercel-labs/skills");
    expect(FIND_SKILLS_REVISION).toBe("13e4063a1cf913f5606d57d42ab83a86f5001e04");

    const grilling = defaults.find((skill) => skill.name === "grilling");
    expect(grilling?.revision).toBe(MATT_SKILLS_REVISION);
    const tdd = defaults.find((skill) => skill.name === "test-driven-development");
    expect(tdd?.revision).toBe(SUPERPOWERS_REVISION);
  });

  it("sanitizes discovery queries and refuses private task content", () => {
    expect(sanitizeDiscoveryQuery("  writing agents  ")).toBe("writing agents");
    expect(sanitizeDiscoveryQuery("test-driven-development")).toBe("test-driven-development");
    expect(() => sanitizeDiscoveryQuery("")).toThrow(PoiesisError);
    expect(() => sanitizeDiscoveryQuery("/home/viktor/secret")).toThrow(PoiesisError);
    expect(() => sanitizeDiscoveryQuery("C:\\Users\\me\\repo")).toThrow(PoiesisError);
    expect(() => sanitizeDiscoveryQuery("owner/private-repo skill")).toThrow(PoiesisError);
    expect(() => sanitizeDiscoveryQuery("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toThrow(PoiesisError);
    expect(() => sanitizeDiscoveryQuery("a".repeat(200))).toThrow(PoiesisError);
  });

  it("searchSkillsCatalog returns ok, none-relevant, and catalog-unavailable distinctly", async () => {
    const ok = await searchSkillsCatalog("writing", {
      fetch: async (input) => {
        const url = String(input);
        expect(url.startsWith(`${SKILLS_SH_SEARCH_URL}?`)).toBe(true);
        expect(url).toContain("q=writing");
        expect(url).toContain("limit=20");
        return jsonResponse({
          query: "writing",
          skills: [
            {
              id: "mattpocock/skills/writing-for-agents",
              source: "mattpocock/skills",
              skillId: "writing-for-agents",
              name: "writing-for-agents",
              installs: 1,
            },
          ],
          count: 1,
        });
      },
    });
    expect(ok).toEqual({
      status: "ok",
      query: "writing",
      results: [
        {
          id: "mattpocock/skills/writing-for-agents",
          source: "mattpocock/skills",
          name: "writing-for-agents",
        },
      ],
    });

    const none = await searchSkillsCatalog("zzzz-no-match", {
      fetch: async () => jsonResponse({ query: "zzzz-no-match", skills: [], count: 0 }),
    });
    expect(none).toEqual({ status: "none-relevant", query: "zzzz-no-match", results: [] });

    const unavailable = await searchSkillsCatalog("writing", {
      fetch: async () => {
        throw new Error("network down");
      },
    });
    expect(unavailable.status).toBe("catalog-unavailable");
    if (unavailable.status === "catalog-unavailable") {
      expect(unavailable.reason.length).toBeGreaterThan(0);
    }

    const badStatus = await searchSkillsCatalog("writing", {
      fetch: async () => jsonResponse({ error: "nope" }, 503),
    });
    expect(badStatus.status).toBe("catalog-unavailable");
  });

  it("caps catalog results at twenty and rejects oversized limits", async () => {
    const skills = Array.from({ length: 25 }, (_, i) => ({
      id: `owner/repo/skill-${i}`,
      source: "owner/repo",
      skillId: `skill-${i}`,
      name: `skill-${i}`,
      installs: i,
    }));
    const outcome = await searchSkillsCatalog("topic", {
      fetch: async () => jsonResponse({ query: "topic", skills, count: 25 }),
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.results).toHaveLength(20);
    }
    await expect(
      searchSkillsCatalog("topic", {
        limit: 21,
        fetch: async () => jsonResponse({ query: "topic", skills: [], count: 0 }),
      }),
    ).rejects.toBeInstanceOf(PoiesisError);
  });

  it("resolves bundled-default provenance and rejects arbitrary non-catalog sources", async () => {
    const bundled = await resolveCapabilityCatalogProvenance({
      source: "mattpocock/skills",
      name: "to-spec",
      revision: MATT_SKILLS_REVISION,
    });
    expect(bundled).toEqual({
      kind: "bundled-default",
      source: "mattpocock/skills",
      name: "to-spec",
      revision: MATT_SKILLS_REVISION,
    });

    const catalog = await resolveCapabilityCatalogProvenance(
      {
        source: "other/repo",
        name: "some-skill",
        revision: "a".repeat(40),
      },
      {
        fetch: async () =>
          jsonResponse({
            query: "some-skill",
            skills: [
              {
                id: "other/repo/some-skill",
                source: "other/repo",
                skillId: "some-skill",
                name: "some-skill",
                installs: 9,
              },
            ],
            count: 1,
          }),
      },
    );
    expect(catalog).toEqual({
      kind: "skills.sh-catalog",
      source: "other/repo",
      name: "some-skill",
      catalogId: "other/repo/some-skill",
    });

    await expect(
      resolveCapabilityCatalogProvenance(
        {
          source: "evil/private",
          name: "not-listed",
          revision: "b".repeat(40),
        },
        {
          fetch: async () =>
            jsonResponse({
              query: "not-listed",
              skills: [
                {
                  id: "other/repo/different",
                  source: "other/repo",
                  skillId: "different",
                  name: "different",
                  installs: 1,
                },
              ],
              count: 1,
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "ARBITRARY_CAPABILITY_SOURCE" });
  });
});

describe("native skill permissions and 1.6.0 static-skill predecessor (ticket #208)", () => {
  it("projects skill wildcard allows without expanding bash or task authority", () => {
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(), "1.6.0").map((patch) => [patch.path.join("."), patch.value]),
    );
    const primary = patches["agent.poiesis"] as {
      permission: { skill: Record<string, string>; bash: Record<string, string>; task: Record<string, string> };
    };
    expect(primary.permission.skill).toEqual({ "*": "allow" });
    expect(primary.permission.bash["pnpm dlx poiesis-cli@1.6.0 *"]).toBe("allow");
    expect(primary.permission.task).toMatchObject({
      explore: "allow",
      "poiesis-worker": "allow",
    });

    const worker = patches["agent.poiesis-worker"] as {
      permission: { skill: Record<string, string>; bash: Record<string, string> };
    };
    expect(worker.permission.skill).toEqual({ "*": "allow" });
    expect(worker.permission.bash["pnpm dlx poiesis-cli@1.6.0 *"]).toBeUndefined();
    expect(worker.permission.bash["pnpm dlx poiesis-cli@1.6.0 capability *"]).toBeUndefined();
    expect(worker.permission.bash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    // Ticket #212 + #215: current Worker keeps ordered local lifecycle denies.
    for (const key of [
      "pnpm poiesis",
      "pnpm run poiesis",
      "npm run poiesis",
      "npm run-script poiesis",
      "pnpm poiesis *",
      "pnpm run poiesis *",
      "npm run poiesis *",
      "npm run-script poiesis *",
      "npm run poiesis -- *",
    ] as const) {
      expect(worker.permission.bash[key], key).toBe("deny");
    }

    for (const agent of [
      "poiesis-planner",
      "poiesis-research",
      "poiesis-reviewer",
      "poiesis-final-reviewer",
    ] as const) {
      const permission = (patches[`agent.${agent}`] as { permission: { skill: Record<string, string> } }).permission;
      expect(permission.skill).toEqual({ "*": "allow" });
    }

    expect(OPENCODE_V160_STATIC_SKILL_PERMISSIONS.poiesis?.["to-spec"]).toBe("allow");
    expect(OPENCODE_V160_STATIC_SKILL_PERMISSIONS["poiesis-worker"]?.["test-driven-development"]).toBe(
      "allow",
    );
  });

  it("builds an authentic 1.6.0 static-skill predecessor (skill maps + pre-#212 Worker bash)", () => {
    const config = testConfig();
    const current = desiredOpenCodePatches(config, "1.6.0");
    const staticSkills = predecessorProjectionV160StaticSkills(config, "1.6.0");
    expect(isExactProjection(manifestFromPatches("1.6.0", current), current)).toBe(true);
    expect(isExactProjection(manifestFromPatches("1.6.0", staticSkills), current)).toBe(false);
    expect(isExactProjection(manifestFromPatches("1.6.0", staticSkills), staticSkills)).toBe(true);

    for (const patch of staticSkills) {
      if (patch.path.length !== 2 || patch.path[0] !== "agent") continue;
      const agentName = patch.path[1]!;
      const expected = OPENCODE_V160_STATIC_SKILL_PERMISSIONS[agentName];
      if (expected === undefined) continue;
      const permission = (patch.value as {
        permission: { skill: Record<string, string>; bash?: Record<string, string> };
      }).permission;
      expect(permission.skill).toEqual({ ...expected });
      const currentPatch = current.find(
        (candidate) =>
          candidate.path.length === patch.path.length &&
          candidate.path.every((segment, index) => segment === patch.path[index]),
      );
      expect(currentPatch).toBeDefined();
      const currentPermission = (currentPatch!.value as {
        permission: { skill: Record<string, string>; bash?: Record<string, string> };
      }).permission;
      expect(currentPermission.skill).toEqual({ "*": "allow" });
      if (agentName === "poiesis-worker") {
        // Ticket #212 + #215: historic Worker bash omits every local lifecycle
        // deny; current desired keeps them ordered.
        const localDenyKeys = [
          "pnpm poiesis",
          "pnpm run poiesis",
          "npm run poiesis",
          "npm run-script poiesis",
          "pnpm poiesis *",
          "pnpm run poiesis *",
          "npm run poiesis *",
          "npm run-script poiesis *",
          "npm run poiesis -- *",
        ] as const;
        for (const key of localDenyKeys) {
          expect(permission.bash?.[key], `historic ${key}`).toBeUndefined();
          expect(currentPermission.bash?.[key], `current ${key}`).toBe("deny");
        }
        const historicBash = { ...(permission.bash ?? {}) };
        const currentBashWithoutLocalDenies = stripWorkerLocalLifecycleDenies({
          ...(currentPermission.bash ?? {}),
        });
        expect(historicBash).toEqual(currentBashWithoutLocalDenies);
      } else {
        expect(permission.bash).toEqual(currentPermission.bash);
      }
    }

    const drifted = manifestFromPatches(
      "1.6.0",
      staticSkills.map((patch) => ({
        path: [...patch.path],
        value: structuredClone(patch.value),
      })),
    );
    const workerPatch = drifted.configPatches.find((p) => p.path[1] === "poiesis-worker");
    expect(workerPatch).toBeDefined();
    (workerPatch!.installed as { permission: { skill: Record<string, string> } }).permission.skill = {
      "unexpected-skill": "allow",
    };
    expect(isExactProjection(drifted, staticSkills)).toBe(false);
    expect(isExactProjection(drifted, current)).toBe(false);
  });

  it("pre-focused-check predecessor omits Worker local lifecycle denies present on current", () => {
    // Ticket #212 + #215 pure inheritance: authentic pre-focused-check Worker
    // bash never carried any WORKER_LOCAL_LIFECYCLE_DENY_KEYS; current does.
    const config = testConfig();
    const current = desiredOpenCodePatches(config, "1.4.0");
    const predecessor = predecessorProjectionPreFocusedCheck(config, "1.4.0");
    const currentWorker = current.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker");
    const historicWorker = predecessor.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker");
    expect(currentWorker).toBeDefined();
    expect(historicWorker).toBeDefined();
    const currentBash = (currentWorker!.value as { permission: { bash: Record<string, string> } }).permission.bash;
    const historicBash = (historicWorker!.value as { permission: { bash: Record<string, string> } }).permission.bash;
    for (const key of WORKER_LOCAL_LIFECYCLE_DENY_KEYS) {
      expect(currentBash[key], `current ${key}`).toBe("deny");
      expect(historicBash[key], `historic ${key}`).toBeUndefined();
    }
    expect(historicBash["pnpm dlx poiesis-cli@1.4.0 check *"]).toBeUndefined();
    expect(currentBash["pnpm dlx poiesis-cli@1.4.0 check *"]).toBe("allow");
  });
});

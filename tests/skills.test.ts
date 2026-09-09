import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashOwnedSkillDirectory,
  loadDefaultSkills,
  removeOwnedSkills,
  skillInstallArgs,
  SKILLS_CLI_VERSION,
} from "../src/skills.js";

describe("skill integration", () => {
  const fixtures: string[] = [];
  afterEach(async () => Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

  it("contains only the curated defaults and emits safe exact CLI arguments", async () => {
    const defaults = await loadDefaultSkills();
    expect(defaults).toHaveLength(11);
    expect(defaults.map((skill) => skill.name)).toContain("to-spec");
    expect(defaults.map((skill) => skill.name)).toContain("to-tickets");
    expect(defaults.map((skill) => skill.name)).not.toContain("writing-plans");
    const args = skillInstallArgs("mattpocock/skills", "a".repeat(40), ["to-spec", "to-tickets"]);
    expect(args).toContain(`skills@${SKILLS_CLI_VERSION}`);
    expect(args).toContain("--skill");
    expect(args.some((arg) => arg.startsWith("--skill="))).toBe(false);
  });

  it("includes empty directories in owned skill tree hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "poiesis-skill-hash-"));
    fixtures.push(root);
    await writeFile(join(root, "SKILL.md"), "owned\n");
    const before = await hashOwnedSkillDirectory(root);
    await mkdir(join(root, "empty"));
    expect(await hashOwnedSkillDirectory(root)).not.toBe(before);
  });

  it("continues removing authored skills after one removal failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "poiesis-skill-remove-"));
    fixtures.push(root);
    const alpha = join(root, ".agents", "skills", "alpha");
    const beta = join(root, ".agents", "skills", "beta");
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await mkdir(alpha);
    await writeFile(join(alpha, "SKILL.md"), "alpha\n");
    await writeFile(beta, "not-a-directory\n");
    const result = await removeOwnedSkills(root, [
      {
        source: "mattpocock/skills",
        name: "beta",
        path: ".agents/skills/beta",
        preexisting: false,
        installedRevision: "a".repeat(40),
        hash: "0".repeat(64),
      },
      {
        source: "mattpocock/skills",
        name: "alpha",
        path: ".agents/skills/alpha",
        preexisting: false,
        installedRevision: "a".repeat(40),
        hash: await hashOwnedSkillDirectory(alpha),
      },
    ]);
    expect(result.preserved).toEqual([{ path: ".agents/skills/beta", reason: "path is not a directory" }]);
    expect(result.removed).toEqual([".agents/skills/alpha"]);
  });
});

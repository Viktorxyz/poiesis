import { describe, expect, it } from "vitest";
import { loadDefaultSkills, skillInstallArgs, SKILLS_CLI_VERSION } from "../src/skills.js";

describe("skill integration", () => {
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
});

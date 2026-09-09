import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { doctor, init, uninstall } from "../src/maintenance.js";
import { createTestRepository, testConfig } from "./helpers.js";

describe("real upstream skill integration", () => {
  it.runIf(process.env.POIESIS_REAL_SKILLS === "1")(
    "installs exactly the curated pinned skills and passes doctor",
    async () => {
      const repository = await createTestRepository();
      try {
        const manifest = await init(repository.root, testConfig(repository), { allowFixtureAdapters: true });
        expect(manifest.skills).toHaveLength(11);
        expect(manifest.skills.every((skill) => !skill.preexisting && skill.hash !== undefined)).toBe(true);
        const report = await doctor(repository.root);
        expect(report.ok).toBe(true);
        expect(report.checks.find((check) => check.id === "skills")?.status).toBe("pass");
        const removed = await uninstall(repository.root);
        expect(removed.manifestRemoved).toBe(false);
        expect(removed.preserved.some((entry) => entry.reason.includes("durable"))).toBe(true);
      } finally {
        await rm(repository.parent, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

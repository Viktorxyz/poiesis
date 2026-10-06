/**
 * Spec #168 / ticket #172 — the Worker focused-check reachability boundary.
 *
 * `poiesis check` (ticket #172) exists and is callable by the PRIMARY agent
 * through the exact-version `pnpm dlx poiesis-cli@<version> *` route. The
 * ticket Worker, however, has no Poiesis CLI route at all: Spec #104 / ticket
 * #113 denies every package-runner lifecycle launcher, and Spec #120 /
 * ticket #123 re-appends only the four narrow Repository Intelligence
 * subcommand allows after that deny.
 *
 * That gap is a DELIBERATE deferral, not an oversight, and this file is its
 * executable record. Granting the Worker a Poiesis CLI route is a change to
 * the manifest's OpenCode permission projection, which is a consequential
 * security-surface decision owned by dependent ticket #173 ("Enforce
 * convergent Realize checks without repeated full Proof"), together with the
 * Method/role guidance that tells a Worker to use focused checks.
 *
 * #172 therefore must NOT widen the projection. These assertions fail if a
 * future change tries to hand the Worker a lifecycle route under cover of the
 * focused-check work, and they pin the deny ordering that keeps the broad
 * `*` allow from reaching one through a package runner.
 */
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { desiredOpenCodePatches } from "../src/opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const POIESIS_VERSION = "1.4.0";
const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
});

async function workerBash(): Promise<Record<string, string>> {
  const repository = await createTestRepository();
  repositories.push(repository);
  const patches = Object.fromEntries(
    desiredOpenCodePatches(testConfig(repository), POIESIS_VERSION).map((patch) => [
      patch.path.join("."),
      patch.value as Record<string, unknown>,
    ]),
  );
  const worker = patches["agent.poiesis-worker"] as { permission: { bash: Record<string, string> } };
  return worker.permission.bash;
}

describe("Worker focused-check reachability (Spec #168 / ticket #172, deferred to #173)", () => {
  it("grants the Worker no focused-check CLI route", async () => {
    const bash = await workerBash();
    const exact = `pnpm dlx poiesis-cli@${POIESIS_VERSION}`;

    // Ticket #172 must not add a `check` allow for the Worker.
    expect(bash).not.toHaveProperty(`${exact} check *`);
    expect(bash).not.toHaveProperty(`${exact} check`);
    expect(bash).not.toHaveProperty("poiesis check *");
    expect(bash).not.toHaveProperty("poiesis check");
  });

  it("keeps the ordered lifecycle denies that make the broad `*` allow unreachable", async () => {
    const bash = await workerBash();

    expect(bash["*"]).toBe("allow");
    expect(bash["git *"]).toBe("deny");
    expect(bash["poiesis *"]).toBe("deny");
    expect(bash["pnpm exec poiesis *"]).toBe("deny");
    expect(bash["npx poiesis *"]).toBe("deny");
    expect(bash["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(bash[`pnpm dlx poiesis-cli@*`]).toBe("deny");

    // Last-match-wins: the broad exact-version deny must still precede every
    // allow, or a later allow would silently widen the Worker's lifecycle.
    const keys = Object.keys(bash);
    const denyIndex = keys.indexOf("pnpm dlx poiesis-cli@*");
    expect(denyIndex).toBeGreaterThan(keys.indexOf("npx poiesis *"));
    for (const key of keys.filter((entry) => bash[entry] === "allow" && entry.startsWith("pnpm dlx poiesis-cli@"))) {
      expect(keys.indexOf(key)).toBeGreaterThan(denyIndex);
    }
  });

  it("leaves the Worker's exact-version allows limited to the four Repository Intelligence subcommands", async () => {
    const bash = await workerBash();
    const exact = `pnpm dlx poiesis-cli@${POIESIS_VERSION}`;
    const exactAllows = Object.keys(bash).filter((key) => bash[key] === "allow" && key.startsWith(exact));

    expect(exactAllows.sort()).toEqual([
      `${exact} repository explain *`,
      `${exact} repository path *`,
      `${exact} repository query *`,
      `${exact} repository status`,
    ]);
  });

  it("keeps the primary as the only holder of the broad exact-version lifecycle route", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = desiredOpenCodePatches(testConfig(repository), POIESIS_VERSION);
    const broadRoute = `pnpm dlx poiesis-cli@${POIESIS_VERSION} *`;

    // `poiesis check` is reachable for an orchestrator today ONLY because the
    // primary holds this broad route. Exactly one agent may hold it: if the
    // Worker ever acquires it, #172/#173 reached across the boundary this
    // file exists to keep closed.
    const holders = patches
      .filter((patch) => patch.path[0] === "agent" && patch.path.length === 2)
      .filter((patch) => {
        const value = patch.value as { permission?: { bash?: Record<string, string> } };
        return value.permission?.bash?.[broadRoute] === "allow";
      })
      .map((patch) => patch.path[1]);

    expect(holders).toEqual(["poiesis"]);
  });
});
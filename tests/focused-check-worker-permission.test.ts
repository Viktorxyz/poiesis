/**
 * Spec #168 / ticket #173 — the Worker focused-check reachability boundary.
 *
 * Ticket #172 built the ONE non-authoritative focused-check surface
 * (`poiesis check`) but deliberately left the Worker's OpenCode bash
 * projection untouched, because granting an agent a Poiesis CLI route changes
 * the manifest's permission projection, its digest, and the
 * predecessor-compatibility authority. Ticket #173 owns that decision and now
 * makes the narrow grant.
 *
 * The grant is exactly ONE exact-version subcommand: `check`. `check` is the
 * surface whose result type makes lifecycle authority structurally impossible
 * (`authoritative: false`, `verification: null`, `proof: null`), it writes
 * nothing anywhere, and it refuses any workspace Poiesis cannot prove it owns.
 * It is therefore the narrowest addition that lets a Worker act on real
 * focused-check evidence instead of running the configured full verification
 * plan or guessing from raw shell output.
 *
 * Everything else stays closed, and these assertions fail if a future change
 * widens the grant under cover of the focused-check work:
 *
 *   - the deny ordering still holds, so the broad `*` allow cannot reach a
 *     lifecycle launcher through a package runner and a later allow cannot
 *     silently widen the Worker's lifecycle;
 *   - the exact-version allows stay the four Repository Intelligence
 *     subcommands plus `check` — no other subcommand;
 *   - no general lifecycle authority: no `verify`, `checkpoint`, `workspace`,
 *     `publish`, `preview`, `promote`, `integrate`, `tracker`, `capability`,
 *     `session`, `model`, `update`, or bare/`exec`/`npx`/unversioned route;
 *   - the primary remains the only holder of the broad exact-version route.
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

/**
 * Every Poiesis subcommand the Worker must NOT be able to reach through the
 * exact-version route. `check` is the only granted subcommand; each of these
 * is either lifecycle authority, tracker/capability mutation, delivery
 * mechanics, or hygiene that belongs to the orchestrator, not the Worker.
 */
const FORBIDDEN_SUBCOMMANDS = [
  "verify",
  "checkpoint",
  "workspace",
  "publish",
  "preview",
  "promote",
  "integrate",
  "tracker",
  "capability",
  "session",
  "model",
  "update",
  "init",
  "doctor",
  "uninstall",
  "inspect",
  "bootstrap",
] as const;

describe("Worker focused-check reachability (Spec #168 / ticket #173)", () => {
  it("grants the Worker exactly the narrow exact-version `poiesis check` route", async () => {
    const bash = await workerBash();
    const exact = `pnpm dlx poiesis-cli@${POIESIS_VERSION}`;

    // The one granted route: the exact manifest version, one subcommand, any
    // flags. A narrower arg shape (`check --command *`) would deny ordinary
    // flag orders such as `check --progress --command ...`, so the subcommand
    // boundary is the narrowest pattern that is actually usable.
    expect(bash[`${exact} check *`]).toBe("allow");
    // No off-version route, and no bare / exec / npx route, may reach it.
    expect(bash).not.toHaveProperty(`poiesis check *`);
    expect(bash).not.toHaveProperty(`poiesis check`);
    expect(bash).not.toHaveProperty(`pnpm exec poiesis check *`);
    expect(bash).not.toHaveProperty(`npx poiesis check *`);
    expect(bash).not.toHaveProperty(`pnpm dlx poiesis-cli check *`);
    expect(bash).not.toHaveProperty(`pnpm dlx poiesis-cli@latest check *`);
    // A different exact version must not inherit the grant.
    expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@1.4.1 check *");
    expect(bash).not.toHaveProperty("pnpm dlx poiesis-cli@* check *");
  });

  it("keeps the ordered lifecycle denies that make the broad `*` allow unreachable", async () => {
    const bash = await workerBash();

    expect(bash["*"]).toBe("allow");
    expect(bash["git *"]).toBe("deny");
    expect(bash["poiesis *"]).toBe("deny");
    expect(bash["pnpm exec poiesis *"]).toBe("deny");
    expect(bash["npx poiesis *"]).toBe("deny");
    expect(bash["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(bash["pnpm dlx poiesis-cli@*"]).toBe("deny");

    // Last-match-wins: the broad exact-version deny must still precede every
    // allow, or a later allow would silently widen the Worker's lifecycle.
    const keys = Object.keys(bash);
    const denyIndex = keys.indexOf("pnpm dlx poiesis-cli@*");
    expect(denyIndex).toBeGreaterThan(keys.indexOf("npx poiesis *"));
    for (const key of keys.filter((entry) => bash[entry] === "allow" && entry.startsWith("pnpm dlx poiesis-cli@"))) {
      expect(keys.indexOf(key)).toBeGreaterThan(denyIndex);
    }
  });

  it("leaves the Worker's exact-version allows limited to the four Repository Intelligence subcommands plus `check`", async () => {
    const bash = await workerBash();
    const exact = `pnpm dlx poiesis-cli@${POIESIS_VERSION}`;
    const exactAllows = Object.keys(bash).filter((key) => bash[key] === "allow" && key.startsWith(exact));

    expect(exactAllows.sort()).toEqual([
      `${exact} check *`,
      `${exact} repository explain *`,
      `${exact} repository path *`,
      `${exact} repository query *`,
      `${exact} repository status`,
    ]);
  });

  it("grants no general lifecycle authority through the exact-version route", async () => {
    const bash = await workerBash();
    const exact = `pnpm dlx poiesis-cli@${POIESIS_VERSION}`;

    for (const subcommand of FORBIDDEN_SUBCOMMANDS) {
      expect(bash, `Worker must not reach ${subcommand}`).not.toHaveProperty(`${exact} ${subcommand}`);
      expect(bash, `Worker must not reach ${subcommand} with args`).not.toHaveProperty(`${exact} ${subcommand} *`);
    }
    // The broad primary-style route stays reserved for the primary alone.
    expect(bash).not.toHaveProperty(`${exact} *`);
  });

  it("keeps the primary as the only holder of the broad exact-version lifecycle route", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = desiredOpenCodePatches(testConfig(repository), POIESIS_VERSION);
    const broadRoute = `pnpm dlx poiesis-cli@${POIESIS_VERSION} *`;

    const holders = patches
      .filter((patch) => patch.path[0] === "agent" && patch.path.length === 2)
      .filter((patch) => {
        const value = patch.value as { permission?: { bash?: Record<string, string> } };
        return value.permission?.bash?.[broadRoute] === "allow";
      })
      .map((patch) => patch.path[1]);

    expect(holders).toEqual(["poiesis"]);
  });

  it("grants `check` to the Worker only, never to the read-only Specialists", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const patches = Object.fromEntries(
      desiredOpenCodePatches(testConfig(repository), POIESIS_VERSION).map((patch) => [
        patch.path.join("."),
        patch.value as { permission?: { bash?: Record<string, string> } },
      ]),
    );
    const exact = `pnpm dlx poiesis-cli@${POIESIS_VERSION}`;

    // The Planner, Ticket Reviewer, Final Reviewer, and Research keep their
    // existing surfaces. `check` is a Worker implementation tool: Reviewer
    // independence and Review ownership are preserved.
    for (const agent of [
      "agent.poiesis-planner",
      "agent.poiesis-reviewer",
      "agent.poiesis-final-reviewer",
      "agent.poiesis-research",
    ]) {
      const bash = patches[agent]?.permission?.bash;
      if (bash === undefined) {
        expect(patches[agent], `${agent} carries no bash surface`).not.toHaveProperty("permission.bash");
        continue;
      }
      expect(bash, `${agent} must not reach check`).not.toHaveProperty(`${exact} check *`);
      expect(bash, `${agent} must not reach the broad route`).not.toHaveProperty(`${exact} *`);
    }
  });
});
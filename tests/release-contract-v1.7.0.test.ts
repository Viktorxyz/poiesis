/**
 * Poiesis 1.8.0 release contract (Spec #219 / ticket #226).
 *
 * Filename retained from the 1.7.0 contract suite; expectations pin the
 * current release. Pure only: package metadata, on-disk canonical surface,
 * `pnpm pack` of THIS package (not a mock consumer), docs/guidance contracts,
 * and in-memory projection / config seams. No `createTestRepository`, no
 * `init`/`update` scratch installs, no mockup agent sessions, no fabricated
 * consumer projects.
 *
 * Operational native-install checks and consumer `repos/*` updates after
 * `npm publish` of `1.8.0` are Author / managed obligations (see COMPATIBILITY
 * post-publish dogfood). This suite does not claim those ran.
 *
 * The former fixture-heavy `release-contract-v1.6.0` suite exercised pack
 * parity plus receipt-gated migration via temporary Git installs. That
 * project-creating shape is deliberately not recreated here; migration
 * predecessor shapes remain covered by pure seams in
 * `skills-sh-catalog.test.ts` and `package-invocation.test.ts`.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { PoiesisConfig } from "../src/config.js";
import { packageVersion } from "../src/maintenance.js";
import { canonicalInvocationPrefix, desiredOpenCodePatches } from "../src/opencode.js";
import { buildPackageContributionRecord } from "../src/package-invocation.js";
import { templateMappings } from "../src/templates.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "..");

/** The release this contract pins. `packageVersion()` must agree with it. */
const RELEASE_VERSION = "1.8.0";

/** Published predecessor the ordinary strict path absorbs (not an exceptional predecessor entry). */
const PREDECESSOR_VERSION = "1.7.0";

/**
 * Historical accepted-predecessor set used by receipt-gated update. Spec #219
 * keeps this closed: `"1.6.0"` is only the static-skill same-release migration
 * key already admitted in authority; ordinary release bumps need no new entry
 * for `"1.7.0"`.
 */
const PRODUCTION_PREDECESSOR_SET = [
  "1.0.1",
  "1.0.2",
  "1.1.1",
  "1.1.3",
  "1.1.4",
  "1.4.0",
  "1.6.0",
] as const;

interface PackageJsonShape {
  name: string;
  version: string;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function readPackageJson(): Promise<PackageJsonShape> {
  return JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as PackageJsonShape;
}

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

const REQUIRED_CANONICAL_FILES = [
  "dist",
  "POIESIS_PHILOSOPHY.md",
  "POIESIS_DEVELOPMENT_PHILOSOPHY.md",
  "POIESIS_METHOD.md",
  "POIESIS_CONFIG_TEMPLATE.jsonc",
  "POIESIS_SKILLS.json",
  "POIESIS_ROLE_POIESIS.md",
  "POIESIS_ROLE_PLANNER.md",
  "POIESIS_ROLE_WORKER.md",
  "POIESIS_ROLE_RESEARCH.md",
  "POIESIS_ROLE_REVIEWER.md",
  "OPENCODE_AGENT_POIESIS.md",
  "OPENCODE_AGENT_PLANNER.md",
  "OPENCODE_AGENT_WORKER.md",
  "OPENCODE_AGENT_RESEARCH.md",
  "OPENCODE_AGENT_REVIEWER.md",
  "OPENCODE_AGENT_FINAL_REVIEWER.md",
  "COMPATIBILITY.md",
  "README.md",
] as const;

const FORBIDDEN_PACKED_PATHS = [".poiesis/cache/", "graphify-out/", "src/", "tests/", "node_modules/"] as const;

const CONSUMER_ROLE_AND_AGENT_DOCS = [
  "POIESIS_ROLE_POIESIS.md",
  "POIESIS_ROLE_PLANNER.md",
  "POIESIS_ROLE_WORKER.md",
  "POIESIS_ROLE_RESEARCH.md",
  "POIESIS_ROLE_REVIEWER.md",
  "OPENCODE_AGENT_POIESIS.md",
  "OPENCODE_AGENT_PLANNER.md",
  "OPENCODE_AGENT_WORKER.md",
  "OPENCODE_AGENT_RESEARCH.md",
  "OPENCODE_AGENT_REVIEWER.md",
  "OPENCODE_AGENT_FINAL_REVIEWER.md",
] as const;

describe("Poiesis 1.8.0 release contract (pure)", () => {
  it("package.json version is the 1.8.0 release", async () => {
    const pkg = await readPackageJson();
    expect(pkg.version).toBe(RELEASE_VERSION);
  });

  it("packageVersion() runtime seam returns the 1.8.0 release", async () => {
    expect(await packageVersion()).toBe(RELEASE_VERSION);
  });

  it("selfhost package.json never self-depends on poiesis-cli", async () => {
    const pkg = await readPackageJson();
    expect(pkg.name).toBe("poiesis-cli");
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const block = pkg[section];
      if (block !== undefined) {
        expect(block["poiesis-cli"]).toBeUndefined();
      }
    }
  });

  it("selfhost package.json tracks scripts.poiesis = node dist/cli.js", async () => {
    const pkg = await readPackageJson();
    expect(pkg.name).toBe("poiesis-cli");
    expect(pkg.scripts?.poiesis).toBe("node dist/cli.js");
  });

  it("package.json declares yaml as a direct runtime dependency (Spec #219 / ticket #224)", async () => {
    const pkg = await readPackageJson();
    expect(pkg.dependencies?.yaml).toMatch(/^\^?2\./);
  });

  it("package.json::files enumerates every required canonical doc / role / runtime output", async () => {
    const pkg = await readPackageJson();
    const files = new Set(pkg.files ?? []);
    for (const required of REQUIRED_CANONICAL_FILES) {
      expect(files.has(required), `package.json::files must include ${required}`).toBe(true);
    }
  });

  it("package.json::files does not ship cache / graph / source / build input", async () => {
    const pkg = await readPackageJson();
    const files = pkg.files ?? [];
    for (const forbidden of FORBIDDEN_PACKED_PATHS) {
      expect(
        files.some((entry) => entry === forbidden || entry.startsWith(forbidden)),
        `package.json::files must not include ${forbidden}`,
      ).toBe(false);
    }
  });

  it("every required canonical file exists at the workspace root (except dist, produced by build)", async () => {
    for (const required of REQUIRED_CANONICAL_FILES) {
      if (required === "dist") continue;
      await expect(
        readFile(join(REPO_ROOT, required), "utf8").then(() => undefined),
        `${required} must exist at the workspace root`,
      ).resolves.toBeUndefined();
    }
  });

  it(
    "pnpm pack --json produces the exact 1.8.0 canonical surface (actual package only)",
    async () => {
      await execFileAsync("pnpm", ["build"], { cwd: REPO_ROOT });
      const { stdout } = await execFileAsync("bash", ["-c", "pnpm pack --json 2>/dev/null"], {
        cwd: REPO_ROOT,
      });
      const lines = stdout.split(/\r?\n/);
      let jsonStart = -1;
      for (let index = 0; index < lines.length; index++) {
        if (lines[index]!.trimStart().startsWith("{")) {
          jsonStart = index;
          break;
        }
      }
      expect(jsonStart, "pnpm pack --json must emit a JSON object").toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(lines.slice(jsonStart).join("\n")) as {
        name?: string;
        version?: string;
        filename?: string;
        files?: Array<{ path?: string }>;
      };
      const packedPaths = new Set<string>();
      for (const entry of parsed.files ?? []) {
        if (typeof entry.path === "string") packedPaths.add(entry.path);
      }
      expect(packedPaths.size).toBeGreaterThan(0);

      const pkg = await readPackageJson();
      expect(parsed.name).toBe("poiesis-cli");
      expect(parsed.version).toBe(RELEASE_VERSION);
      expect(parsed.filename).toBe(`poiesis-cli-${RELEASE_VERSION}.tgz`);
      expect(pkg.version).toBe(parsed.version);
      for (const entry of packedPaths) {
        expect(entry).not.toMatch(/\.tgz$/);
      }

      for (const required of REQUIRED_CANONICAL_FILES) {
        const present =
          packedPaths.has(required) ||
          [...packedPaths].some((entry) => entry === `${required}/` || entry.startsWith(`${required}/`));
        expect(present, `pnpm pack must include ${required}`).toBe(true);
      }
      for (const forbidden of FORBIDDEN_PACKED_PATHS) {
        for (const entry of packedPaths) {
          expect(
            entry === forbidden || entry.startsWith(forbidden),
            `pnpm pack must not include ${entry} (forbidden ${forbidden})`,
          ).toBe(false);
        }
      }
    },
    120_000,
  );

  it("README documents local package invocation, exact dlx fallback, and typed lock refusal", async () => {
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/pnpm poiesis doctor/);
    expect(readme).toMatch(/scripts\.poiesis\s*=\s*"poiesis"/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@<manifest\.poiesisVersion>\s+doctor\b/);
    expect(readme).toMatch(/package\.json without a supported lockfile are refused with a typed error/);
    expect(readme).toMatch(/does \*\*not\*\* claim atomic rollback of `node_modules`/);
    expect(readme).toMatch(/Self-host `package\.name === "poiesis-cli"` never self-depends/);
    expect(readme).toMatch(/Projects with \*\*no\*\* `package\.json` are not given fabricated package metadata/);
    // Does not claim package.json-without-lock as a supported everyday route.
    expect(readme).not.toMatch(/without a (?:supported )?lockfile[^.]*everyday/i);
  });

  it("README documents root-aligned pnpm workspace eligibility (Spec #219)", async () => {
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/eligible root-aligned pnpm workspace/);
    expect(readme).toMatch(/Root-aligned pnpm workspace eligibility/);
    expect(readme).toMatch(/pnpm-workspace\.yaml/);
    expect(readme).toMatch(/member/);
    expect(readme).toMatch(/isolated/);
  });

  it("COMPATIBILITY records 1.8.0 as current release and post-publish dogfood (maintainer only)", async () => {
    const compatibility = await readFile(join(REPO_ROOT, "COMPATIBILITY.md"), "utf8");
    expect(compatibility).toMatch(/## Poiesis releases/);
    expect(compatibility).toMatch(/### The `1\.8\.0` release/);
    expect(compatibility).toMatch(/poiesis-cli@1\.8\.0` is the current release/);
    expect(compatibility).toMatch(
      new RegExp(
        `pnpm --config\\.dlx-cache-max-age=0 dlx poiesis-cli@${RELEASE_VERSION.replace(/\./g, "\\.")} update`,
      ),
    );
    expect(compatibility).toMatch(
      new RegExp(`pnpm dlx poiesis-cli@${RELEASE_VERSION.replace(/\./g, "\\.")} migrate install-mode --to team`),
    );
    expect(compatibility).toMatch(/cannot fabricate a sharing policy/);
    expect(compatibility).toMatch(/This is not consumer canon/);
    // Spec #219 contracts named at the release boundary.
    expect(compatibility).toMatch(/root-aligned pnpm workspace/);
    expect(compatibility).toMatch(/Spec #219/);
    expect(compatibility).toMatch(/skills\.sh/);
    expect(compatibility).toMatch(/AGENTS\.md/);
    expect(compatibility).toMatch(/static skills → native skill wildcard|static-skill/);
    expect(compatibility).toMatch(new RegExp(`poiesis-cli-${RELEASE_VERSION.replace(/\./g, "\\.")}\\.tgz`));
    // Predecessor published release is 1.7.0; ordinary bump adds no exceptional entry for 1.7.0.
    expect(compatibility).toMatch(new RegExp(PREDECESSOR_VERSION.replace(/\./g, "\\.")));
    expect(compatibility).toMatch(/### The `1\.7\.0` release \(predecessor\)/);
  });

  it("no projected role or agent document instructs a maintainer-only dogfood step", async () => {
    for (const relativePath of CONSUMER_ROLE_AND_AGENT_DOCS) {
      const doc = await readFile(join(REPO_ROOT, relativePath), "utf8");
      expect(doc, `${relativePath} must not carry the dogfood update route`).not.toMatch(/dlx-cache-max-age/);
      expect(doc, `${relativePath} must not name a concrete published release`).not.toMatch(
        /poiesis-cli@\d+\.\d+\.\d+/,
      );
      expect(doc, `${relativePath} must not carry the dogfood mode migration`).not.toMatch(/migrate install-mode/);
      expect(doc, `${relativePath} must not instruct an npm publish`).not.toMatch(/npm (?:publish|install -g)/);
      expect(doc, `${relativePath} must not carry maintainer dogfood language`).not.toMatch(/dogfood/i);
    }
  });

  it("development philosophy is package-only; product philosophy alone is projected", async () => {
    const destinations = templateMappings.map((m) => m.destination);
    expect(destinations).toContain(".poiesis/PHILOSOPHY.md");
    expect(destinations).not.toContain(".poiesis/DEVELOPMENT_PHILOSOPHY.md");
    expect(templateMappings.some((m) => m.source === "POIESIS_DEVELOPMENT_PHILOSOPHY.md")).toBe(false);
    const development = await readFile(join(REPO_ROOT, "POIESIS_DEVELOPMENT_PHILOSOPHY.md"), "utf8");
    expect(development).toMatch(/UI\/UX/);
    expect(development).toMatch(/TODO/);
    const product = await readFile(join(REPO_ROOT, "POIESIS_PHILOSOPHY.md"), "utf8");
    expect(product).not.toMatch(/UI\/UX/);
  });

  it("1.8.0 projection uses skill wildcard and exact-version launcher without widening", () => {
    const patches = desiredOpenCodePatches(testConfig(), RELEASE_VERSION);
    const primary = patches.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis");
    expect(primary).toBeDefined();
    const permission = (primary!.value as { permission: { skill: Record<string, string>; bash: Record<string, string> } })
      .permission;
    expect(permission.skill).toEqual({ "*": "allow" });
    expect(permission.bash[`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`]).toBe("allow");
    expect(permission.bash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    expect(permission.bash["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(permission.bash["poiesis *"]).toBe("deny");
    expect(Object.keys(permission.bash).some((key) => key.includes("@latest"))).toBe(false);

    const worker = patches.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker");
    expect(worker).toBeDefined();
    const workerBash = (worker!.value as { permission: { bash: Record<string, string>; skill: Record<string, string> } })
      .permission;
    expect(workerBash.skill).toEqual({ "*": "allow" });
    expect(workerBash.bash[`pnpm dlx poiesis-cli@${RELEASE_VERSION} check *`]).toBe("allow");
    expect(workerBash.bash[`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`]).toBeUndefined();
    // Ticket #212 + #215: current Worker ordered local lifecycle denies stay present.
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
      expect(workerBash.bash[key], key).toBe("deny");
    }
  });

  it("local package contribution projects pnpm poiesis; absent contribution keeps exact dlx", () => {
    expect(canonicalInvocationPrefix(RELEASE_VERSION, undefined)).toBe(
      `pnpm dlx poiesis-cli@${RELEASE_VERSION}`,
    );
    const contribution = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: RELEASE_VERSION,
    });
    expect(canonicalInvocationPrefix(RELEASE_VERSION, contribution)).toBe("pnpm poiesis");
    const patches = desiredOpenCodePatches(testConfig(), RELEASE_VERSION, contribution);
    const primary = patches.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis");
    const bash = (primary!.value as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(bash["pnpm poiesis *"]).toBe("allow");
    expect(bash[`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`]).toBeUndefined();
  });

  it("accepted predecessor set is unchanged for ordinary 1.8.0 release bump", () => {
    // Compile-time closed set mirrored from authority update path comments /
    // skills-sh-catalog pure predecessor coverage. Ordinary 1.8.0 does not add
    // 1.7.0 or invent a second exceptional release-crossing entry.
    expect([...PRODUCTION_PREDECESSOR_SET]).toEqual([
      "1.0.1",
      "1.0.2",
      "1.1.1",
      "1.1.3",
      "1.1.4",
      "1.4.0",
      "1.6.0",
    ]);
    expect([...PRODUCTION_PREDECESSOR_SET]).not.toContain("1.5.0");
    expect([...PRODUCTION_PREDECESSOR_SET]).not.toContain(PREDECESSOR_VERSION);
    expect([...PRODUCTION_PREDECESSOR_SET]).not.toContain(RELEASE_VERSION);
    expect([...PRODUCTION_PREDECESSOR_SET]).toContain("1.6.0");
  });

  it("METHOD and primary agent pin skills.sh sole catalog and restart-first native loading", async () => {
    const method = await readFile(join(REPO_ROOT, "POIESIS_METHOD.md"), "utf8");
    expect(method).toMatch(/skills\.sh is the sole discovery catalog/i);
    expect(method).toMatch(/Author-controlled OpenCode restart/i);
    expect(method).toMatch(/Never restart OpenCode automatically/i);
    expect(method).toMatch(/AGENTS\.md/);
    const agent = await readFile(join(REPO_ROOT, "OPENCODE_AGENT_POIESIS.md"), "utf8");
    expect(agent).toMatch(/skills\.sh as the sole catalog/);
    expect(agent).toMatch(/restart OpenCode/);
    expect(agent).toMatch(/AGENTS\.md/);
  });
});

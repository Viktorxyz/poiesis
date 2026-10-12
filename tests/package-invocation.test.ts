/**
 * Spec #207 / ticket #210 — pinned local package invocation with ownership-safe
 * package.json + lockfile lifecycle.
 *
 * Pure / in-memory / injected-executor tests only. No mock agent sessions and
 * no new consumer projects that run a real package manager install.
 */
import { describe, expect, it } from "vitest";
import { parseJsonc, type PoiesisConfig } from "../src/config.js";
import { PoiesisError } from "../src/errors.js";
import { hashContent } from "../src/hash.js";
import {
  LOCAL_CLI_PACKAGE_JSON_RELATIVE,
  ORDINARY_SCRIPT_VALUE,
  PACKAGE_JSON_RELATIVE,
  POIESIS_CLI_PACKAGE_NAME,
  POIESIS_SCRIPT_NAME,
  SELFHOST_DIST_CLI_RELATIVE,
  SELFHOST_PACKAGE_NAME,
  SELFHOST_SCRIPT_VALUE,
  applyPackageContributionPlan,
  applyPackageContributionWithJournal,
  assertPackageContributionCaptureIdentity,
  assertPackageContributionMatches,
  assertPackageContributionRuntimeReady,
  assertResolvedLocalCliVersion,
  assertSelfhostDistReady,
  buildPackageContributionRecord,
  classifyPackageProject,
  desiredScriptValue,
  nativePackageManagerArgv,
  packageContributionMode,
  packagePlanIsNoopWithPreimage,
  packagePlanRetainsContribution,
  planPackageContribution,
  planPackageContributionForVersionCross,
  planPackageContributionRemoval,
  resolvePackageManagerOwnership,
  writeManifestWithNoopPackageContributionGate,
  type PackageContributionRecord,
  type PackageFsSnapshot,
  type PackageManagerExecutor,
} from "../src/package-invocation.js";
import {
  WORKER_LOCAL_LIFECYCLE_DENY_KEYS,
  canonicalInvocationPrefix,
  desiredOpenCodePatches,
} from "../src/opencode.js";
import type { ArtifactJournalEntry } from "../src/mutation-transaction.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

function parsePkg(content: string): {
  name?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
} {
  return parseJsonc(content, "package.json");
}

function testConfig(): PoiesisConfig {
  return {
    schema: 1,
    mode: "private",
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    verification: { commands: ["true"] },
  };
}

function snap(args: {
  packageJson?: string | null;
  lockfiles?: Partial<Record<"pnpm-lock.yaml" | "package-lock.json" | "yarn.lock" | "bun.lock" | "bun.lockb" | "pnpm-workspace.yaml", string | null>>;
}): PackageFsSnapshot {
  return {
    packageJson: args.packageJson === undefined ? null : args.packageJson,
    lockfiles: {
      "pnpm-lock.yaml": args.lockfiles?.["pnpm-lock.yaml"] ?? null,
      "package-lock.json": args.lockfiles?.["package-lock.json"] ?? null,
      "yarn.lock": args.lockfiles?.["yarn.lock"] ?? null,
      "bun.lock": args.lockfiles?.["bun.lock"] ?? null,
      "bun.lockb": args.lockfiles?.["bun.lockb"] ?? null,
      "pnpm-workspace.yaml": args.lockfiles?.["pnpm-workspace.yaml"] ?? null,
    },
  };
}

const ORDINARY_PKG = [
  "{",
  '  "name": "demo",',
  '  "version": "0.1.0",',
  '  "scripts": {',
  '    "build": "tsc",',
  '    "test":  "vitest run"  // Author spacing',
  "  },",
  '  "devDependencies": {',
  '    "typescript": "^5.0.0"',
  "  }",
  "}",
  "",
].join("\n");

const SELFHOST_PKG = [
  "{",
  '  "name": "poiesis-cli",',
  '  "version": "1.6.0",',
  '  "scripts": {',
  '    "build": "tsup"',
  "  }",
  "}",
  "",
].join("\n");

describe("package manager ownership resolution (ticket #210)", () => {
  it("reports absent when package.json is missing and keeps no fabricated metadata", () => {
    const resolved = resolvePackageManagerOwnership(snap({}));
    expect(resolved).toEqual({ kind: "absent" });
  });

  it("selects pnpm when only pnpm-lock.yaml owns the lock", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" } }),
    );
    expect(resolved).toEqual({
      kind: "supported",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
    });
  });

  it("selects npm when only package-lock.json owns the lock", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({ packageJson: ORDINARY_PKG, lockfiles: { "package-lock.json": "{}\n" } }),
    );
    expect(resolved).toEqual({
      kind: "supported",
      manager: "npm",
      lockfile: "package-lock.json",
    });
  });

  it("fails closed on ambiguous npm+pnpm lockfiles instead of choosing", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": "x", "package-lock.json": "{}" },
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind !== "unsupported") return;
    expect(resolved.code).toBe("PACKAGE_MANAGER_AMBIGUOUS");
  });

  it("fails closed on yarn or bun locks", () => {
    const yarn = resolvePackageManagerOwnership(
      snap({ packageJson: ORDINARY_PKG, lockfiles: { "yarn.lock": "x" } }),
    );
    expect(yarn.kind).toBe("unsupported");
    if (yarn.kind === "unsupported") expect(yarn.code).toBe("PACKAGE_MANAGER_UNSUPPORTED");

    const bun = resolvePackageManagerOwnership(
      snap({ packageJson: ORDINARY_PKG, lockfiles: { "bun.lockb": "x" } }),
    );
    expect(bun.kind).toBe("unsupported");
    if (bun.kind === "unsupported") expect(bun.code).toBe("PACKAGE_MANAGER_UNSUPPORTED");
  });

  it("fails closed when package.json exists without a supported lockfile", () => {
    const resolved = resolvePackageManagerOwnership(snap({ packageJson: ORDINARY_PKG }));
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") expect(resolved.code).toBe("PACKAGE_MANAGER_UNSUPPORTED");
  });

  it("fails closed on pnpm workspace and package.json workspaces", () => {
    const pnpmWs = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": "x", "pnpm-workspace.yaml": "packages:\n  - apps/*\n" },
      }),
    );
    expect(pnpmWs.kind).toBe("unsupported");
    if (pnpmWs.kind === "unsupported") expect(pnpmWs.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");

    const npmWs = resolvePackageManagerOwnership(
      snap({
        packageJson: ['{', '  "name": "demo",', '  "workspaces": ["packages/*"]', "}", ""].join("\n"),
        lockfiles: { "package-lock.json": "{}" },
      }),
    );
    expect(npmWs.kind).toBe("unsupported");
    if (npmWs.kind === "unsupported") expect(npmWs.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
  });
});

describe("package project classification and desired contributions", () => {
  it("classifies ordinary vs selfhost by package.name === poiesis-cli", () => {
    expect(classifyPackageProject({ name: "demo" })).toBe("ordinary");
    expect(classifyPackageProject({ name: SELFHOST_PACKAGE_NAME })).toBe("selfhost");
    expect(classifyPackageProject({})).toBe("ordinary");
  });

  it("uses script poiesis=poiesis for ordinary and node dist/cli.js for selfhost without self-dep", () => {
    expect(desiredScriptValue("ordinary")).toBe(ORDINARY_SCRIPT_VALUE);
    expect(desiredScriptValue("selfhost")).toBe(SELFHOST_SCRIPT_VALUE);
    expect(POIESIS_SCRIPT_NAME).toBe("poiesis");
    expect(POIESIS_CLI_PACKAGE_NAME).toBe("poiesis-cli");
    expect(ORDINARY_SCRIPT_VALUE).toBe("poiesis");
    expect(SELFHOST_SCRIPT_VALUE).toBe("node dist/cli.js");
  });

  it("plans ordinary exact devDependency + script while preserving foreign fields byte-minimally", () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.record.projectKind).toBe("ordinary");
    expect(plan.record.manager).toBe("pnpm");
    expect(plan.record.devDependencyVersion).toBe("1.6.0");
    expect(plan.record.scriptValue).toBe("poiesis");
    expect(plan.packageJsonChanged).toBe(true);
    expect(plan.lockfileOperation).toEqual({
      op: "add-dev",
      name: "poiesis-cli",
      version: "1.6.0",
    });
    const next = parsePkg(plan.nextPackageJson!);
    expect(next.name).toBe("demo");
    expect(next.scripts?.build).toBe("tsc");
    expect(next.scripts?.test).toBe("vitest run");
    expect(next.scripts?.poiesis).toBe("poiesis");
    expect(next.devDependencies?.typescript).toBe("^5.0.0");
    expect(next.devDependencies?.["poiesis-cli"]).toBe("1.6.0");
    // Author spacing / comment region on the test script line is preserved.
    expect(plan.nextPackageJson).toContain('"test":  "vitest run"  // Author spacing');
  });

  it("plans selfhost script only and never adds a self dependency", () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: SELFHOST_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.record.projectKind).toBe("selfhost");
    expect(plan.record.devDependencyVersion).toBeUndefined();
    expect(plan.record.scriptValue).toBe("node dist/cli.js");
    expect(plan.lockfileOperation).toBeNull();
    const next = parsePkg(plan.nextPackageJson!);
    expect(next.scripts?.poiesis).toBe("node dist/cli.js");
    expect(next.devDependencies?.["poiesis-cli"]).toBeUndefined();
    expect(next.dependencies?.["poiesis-cli"]).toBeUndefined();
  });

  it("returns noop when contributions already match", () => {
    const withOwned = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: withOwned, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("noop");
    if (plan.kind !== "noop") return;
    expect(plan.record.devDependencyVersion).toBe("1.6.0");
    expect(plan.packageJsonChanged).toBe(false);
    expect(plan.lockfileOperation).toBeNull();
  });

  it("returns absent plan when there is no package.json", () => {
    const plan = planPackageContribution({
      snapshot: snap({}),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan).toEqual({ kind: "absent" });
  });

  it("refuses a conflicting foreign poiesis script on ensure", () => {
    const conflicted = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "echo no" },',
      '  "devDependencies": {}',
      "}",
      "",
    ].join("\n");
    expect(() =>
      planPackageContribution({
        snapshot: snap({ packageJson: conflicted, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "ensure",
      }),
    ).toThrow(PoiesisError);
    try {
      planPackageContribution({
        snapshot: snap({ packageJson: conflicted, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "ensure",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PoiesisError);
      expect((error as PoiesisError).code).toBe("PACKAGE_SCRIPT_CONFLICT");
      expect((error as PoiesisError).details.path).toEqual(["scripts", "poiesis"]);
    }
  });

  it("refuses a conflicting foreign poiesis-cli dependency version on ensure", () => {
    const conflicted = [
      "{",
      '  "name": "demo",',
      '  "scripts": {},',
      '  "devDependencies": { "poiesis-cli": "^1.6.0" }',
      "}",
      "",
    ].join("\n");
    try {
      planPackageContribution({
        snapshot: snap({ packageJson: conflicted, lockfiles: { "package-lock.json": "{}" } }),
        poiesisVersion: "1.6.0",
        mode: "ensure",
      });
      expect.fail("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(PoiesisError);
      expect((error as PoiesisError).code).toBe("PACKAGE_DEPENDENCY_CONFLICT");
      expect((error as PoiesisError).details.path).toEqual(["devDependencies", "poiesis-cli"]);
    }
  });

  it("repair without authenticated prior still refuses foreign script (planner does not bypass)", () => {
    const conflicted = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "echo foreign" },',
      '  "devDependencies": {}',
      "}",
      "",
    ].join("\n");
    try {
      planPackageContribution({
        snapshot: snap({ packageJson: conflicted, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "repair",
      });
      expect.fail("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(PoiesisError);
      expect((error as PoiesisError).code).toBe("PACKAGE_SCRIPT_CONFLICT");
    }
  });

  it("repair without authenticated prior still refuses foreign dependency version", () => {
    const conflicted = [
      "{",
      '  "name": "demo",',
      '  "scripts": {},',
      '  "devDependencies": { "poiesis-cli": "^1.6.0" }',
      "}",
      "",
    ].join("\n");
    try {
      planPackageContribution({
        snapshot: snap({ packageJson: conflicted, lockfiles: { "package-lock.json": "{}" } }),
        poiesisVersion: "1.6.0",
        mode: "repair",
      });
      expect.fail("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(PoiesisError);
      expect((error as PoiesisError).code).toBe("PACKAGE_DEPENDENCY_CONFLICT");
    }
  });

  it("packageContributionMode is ensure without prior and repair only with prior", () => {
    expect(packageContributionMode(undefined)).toBe("ensure");
    expect(
      packageContributionMode(
        buildPackageContributionRecord({
          manager: "pnpm",
          lockfile: "pnpm-lock.yaml",
          projectKind: "ordinary",
          scriptValue: "poiesis",
          devDependencyVersion: "1.6.0",
        }),
      ),
    ).toBe("repair");
  });

  it("repair mode version-crosses an exact owned dep when provenance still matches", () => {
    // Prior owned contribution is still present (script + exact 1.5.0 dep).
    // Author did not edit those fields; update advances the exact version.
    const current = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.5.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const prior: PackageContributionRecord = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.5.0",
    });
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: current, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "repair",
      prior,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.record.devDependencyVersion).toBe("1.6.0");
    const next = parsePkg(plan.nextPackageJson!);
    expect(next.scripts?.poiesis).toBe("poiesis");
    expect(next.devDependencies?.["poiesis-cli"]).toBe("1.6.0");
    expect(next.devDependencies?.typescript).toBe("^5.0.0");
  });

  it("repair mode refuses a foreign-edited script that no longer matches prior ownership", () => {
    const foreign = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "echo author", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.5.0" }',
      "}",
      "",
    ].join("\n");
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.5.0",
    });
    expect(() =>
      planPackageContribution({
        snapshot: snap({ packageJson: foreign, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "repair",
        prior,
      }),
    ).toThrow(PoiesisError);
  });

  it("refuses selfhost packages that already self-depend on poiesis-cli", () => {
    const selfDep = [
      "{",
      '  "name": "poiesis-cli",',
      '  "version": "1.6.0",',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    try {
      planPackageContribution({
        snapshot: snap({ packageJson: selfDep, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "ensure",
      });
      expect.fail("expected selfdep refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PoiesisError);
      expect((error as PoiesisError).code).toBe("PACKAGE_SELF_DEPENDENCY");
    }
  });

  it("plans removal of only owned contributions, preserving foreign fields", () => {
    const installed = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const plan = planPackageContributionRemoval({
      snapshot: snap({ packageJson: installed, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      record,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.lockfileOperation).toEqual({ op: "remove-dev", name: "poiesis-cli" });
    const next = parsePkg(plan.nextPackageJson!);
    expect(next.scripts?.poiesis).toBeUndefined();
    expect(next.scripts?.build).toBe("tsc");
    expect(next.devDependencies?.["poiesis-cli"]).toBeUndefined();
    expect(next.devDependencies?.typescript).toBe("^5.0.0");
  });

  it("removal preserves a foreign-edited script and reports it instead of clobbering", () => {
    const edited = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "echo author", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const plan = planPackageContributionRemoval({
      snapshot: snap({ packageJson: edited, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      record,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.preserved).toEqual([
      { path: ["scripts", "poiesis"], reason: "foreign script value differs from owned contribution" },
    ]);
    const next = parsePkg(plan.nextPackageJson!);
    expect(next.scripts?.poiesis).toBe("echo author");
  });
});

describe("injected package transaction apply (ticket #210)", () => {
  it("enumerates package.json + lockfile as the write set and applies through the executor", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const executorCalls: unknown[] = [];
    const executor: PackageManagerExecutor = {
      async apply(request) {
        executorCalls.push(request);
        // Simulated lockfile rewrite after add-dev; package.json already planned.
        return {
          packageJson: request.packageJson,
          lockfile: `lock-after-${request.operation.op}\n`,
        };
      },
    };
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock-before\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;

    const result = await applyPackageContributionPlan({
      plan,
      preimage: {
        packageJson: ORDINARY_PKG,
        lockfile: "lock-before\n",
      },
      executor,
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
    });

    expect(result.writeSet).toEqual([PACKAGE_JSON_RELATIVE, "pnpm-lock.yaml"]);
    expect(writes.map((w) => w.path)).toEqual([PACKAGE_JSON_RELATIVE, "pnpm-lock.yaml"]);
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      manager: "pnpm",
      operation: { op: "add-dev", name: "poiesis-cli", version: "1.6.0" },
      ignoreScripts: true,
    });
    expect(result.lockfile).toBe("lock-after-add-dev\n");
    expect(parsePkg(result.packageJson).devDependencies?.["poiesis-cli"]).toBe("1.6.0");
  });

  it("does not re-write package.json from executor reread when contribution still matches", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock-before\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    // Executor returns reformatted package.json that still carries owned fields.
    const reformatted = `${plan.nextPackageJson}\n`;
    await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: ORDINARY_PKG, lockfile: "lock-before\n" },
      executor: {
        async apply(request) {
          return { packageJson: reformatted, lockfile: "lock-after\n" };
        },
      },
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
    });
    // Only planned package.json + lockfile — never a second package.json adoption write.
    expect(writes.map((w) => w.path)).toEqual([PACKAGE_JSON_RELATIVE, "pnpm-lock.yaml"]);
    expect(writes[0]!.content).toBe(plan.nextPackageJson);
    expect(writes[0]!.content).not.toBe(reformatted);
  });

  it("reports PACKAGE_MANAGER_INCOMPLETE when post-PM package.json no longer matches contribution", async () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: ORDINARY_PKG, lockfile: "lock\n" },
        executor: {
          async apply() {
            return {
              packageJson: [
                "{",
                '  "name": "demo",',
                '  "scripts": { "poiesis": "echo hijacked" },',
                '  "devDependencies": { "poiesis-cli": "1.6.0" }',
                "}",
                "",
              ].join("\n"),
              lockfile: "lock-after\n",
            };
          },
        },
        writeFile: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_MANAGER_INCOMPLETE",
      details: { postPmMismatch: true, nativeSideEffectsNotClaimedRolledBack: true },
    });
  });

  it("reports PACKAGE_MANAGER_INCOMPLETE on executor failure without claiming native pm rollback", async () => {
    const executor: PackageManagerExecutor = {
      async apply() {
        throw new PoiesisError("PACKAGE_MANAGER_FAILED", "injected failure", { manager: "pnpm" });
      },
    };
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply plan");
    const writes: string[] = [];
    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: ORDINARY_PKG, lockfile: "lock\n" },
        executor,
        writeFile: async (path) => {
          writes.push(path);
        },
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_MANAGER_INCOMPLETE",
      details: {
        ownedArtifactsMayRollback: true,
        nativeSideEffectsNotClaimedRolledBack: true,
        argv: ["add", "-D", "-E", "poiesis-cli@1.6.0", "--ignore-scripts"],
      },
    });
    expect(writes.length).toBeLessThanOrEqual(1);
  });

  it("skips lockfile onWritten when writeFile signals it did not own-write (native already wrote)", async () => {
    const written: string[] = [];
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock-before\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: ORDINARY_PKG, lockfile: "lock-before\n" },
      executor: {
        async apply(request) {
          return { packageJson: request.packageJson, lockfile: "native-lock\n" };
        },
      },
      writeFile: async (path) => {
        if (path === "pnpm-lock.yaml") return false;
        return;
      },
      onWritten: (path) => {
        written.push(path);
      },
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
    });
    expect(written).toEqual([PACKAGE_JSON_RELATIVE]);
  });

  it("after ordinary add-dev verifies resolved local package version equals target", async () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: ORDINARY_PKG, lockfile: "lock\n" },
        executor: {
          async apply(request) {
            return { packageJson: request.packageJson, lockfile: "lock-after\n" };
          },
        },
        writeFile: async () => undefined,
        readResolvedLocalPackageJson: async () => JSON.stringify({ name: "poiesis-cli", version: "1.5.0" }),
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_LOCAL_BIN_VERSION_MISMATCH",
      details: { expectedVersion: "1.6.0", actualVersion: "1.5.0" },
    });
  });

  it("after ordinary add-dev accepts matching resolved local package version", async () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const result = await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: ORDINARY_PKG, lockfile: "lock\n" },
      executor: {
        async apply(request) {
          return { packageJson: request.packageJson, lockfile: "lock-after\n" };
        },
      },
      writeFile: async () => undefined,
      readResolvedLocalPackageJson: async () => JSON.stringify({ name: "poiesis-cli", version: "1.6.0" }),
    });
    expect(result.record.devDependencyVersion).toBe("1.6.0");
  });

  it("assertPackageContributionMatches verifies exact owned values after apply", () => {
    const record = buildPackageContributionRecord({
      manager: "npm",
      lockfile: "package-lock.json",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const ok = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
    ].join("\n");
    expect(() => assertPackageContributionMatches(ok, record)).not.toThrow();
    const bad = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.5.0" }',
      "}",
    ].join("\n");
    expect(() => assertPackageContributionMatches(bad, record)).toThrow(PoiesisError);
  });
});

/**
 * OpenCode bash last-match-wins evaluator used only to prove Worker local
 * lifecycle denial ordering. Patterns treat each `*` as "any remainder".
 */
function lastMatchBashPermission(
  bash: Record<string, string>,
  command: string,
): "allow" | "deny" | undefined {
  let result: "allow" | "deny" | undefined;
  for (const [pattern, permission] of Object.entries(bash)) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}$`).test(command)) {
      result = permission as "allow" | "deny";
    }
  }
  return result;
}

describe("local invocation permission route (ticket #210 / #212)", () => {
  it("keeps exact dlx prefix when there is no package contribution", () => {
    expect(canonicalInvocationPrefix("1.6.0", undefined)).toBe("pnpm dlx poiesis-cli@1.6.0");
    const primary = desiredOpenCodePatches(testConfig(), "1.6.0").find(
      (p) => p.path[0] === "agent" && p.path[1] === "poiesis",
    );
    const bash = (primary?.value as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(bash["pnpm dlx poiesis-cli@1.6.0 *"]).toBe("allow");
    expect(bash["pnpm poiesis *"]).toBeUndefined();
    expect(bash["poiesis *"]).toBe("deny");
    expect(bash["pnpm dlx poiesis-cli@*"]).toBe("deny");
  });

  it("projects pnpm local invocation allows while keeping launcher denials", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    expect(canonicalInvocationPrefix("1.6.0", record)).toBe("pnpm poiesis");
    const patches = desiredOpenCodePatches(testConfig(), "1.6.0", record);
    const primary = patches.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis");
    const worker = patches.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker");
    const primaryBash = (primary?.value as { permission: { bash: Record<string, string> } }).permission.bash;
    const workerBash = (worker?.value as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(primaryBash["pnpm poiesis *"]).toBe("allow");
    expect(primaryBash["pnpm dlx poiesis-cli@1.6.0 *"]).toBeUndefined();
    expect(primaryBash["poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm exec poiesis *"]).toBe("deny");
    expect(primaryBash["npx poiesis *"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(primaryBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    expect(workerBash["pnpm poiesis check *"]).toBe("allow");
    expect(workerBash["pnpm poiesis repository status"]).toBe("allow");
    // Ticket #212 + #215: Worker denies every supported local alias (ordered
    // before narrow check/repository allows) so `*` cannot grant full lifecycle.
    for (const key of WORKER_LOCAL_LIFECYCLE_DENY_KEYS) {
      expect(workerBash[key], key).toBe("deny");
    }
    expect(workerBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    const keys = Object.keys(workerBash);
    const lastLocalDenyIdx = Math.max(...WORKER_LOCAL_LIFECYCLE_DENY_KEYS.map((k) => keys.indexOf(k)));
    const firstLocalDenyIdx = Math.min(...WORKER_LOCAL_LIFECYCLE_DENY_KEYS.map((k) => keys.indexOf(k)));
    const checkAllowIdx = keys.indexOf("pnpm poiesis check *");
    const repoAllowIdx = keys.indexOf("pnpm poiesis repository status");
    expect(firstLocalDenyIdx).toBeGreaterThan(keys.indexOf("pnpm dlx poiesis-cli@*"));
    expect(checkAllowIdx).toBeGreaterThan(lastLocalDenyIdx);
    expect(repoAllowIdx).toBeGreaterThan(lastLocalDenyIdx);
  });

  it("projects npm run poiesis local invocation allows", () => {
    const record = buildPackageContributionRecord({
      manager: "npm",
      lockfile: "package-lock.json",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    expect(canonicalInvocationPrefix("1.6.0", record)).toBe("npm run poiesis --");
    const patches = desiredOpenCodePatches(testConfig(), "1.6.0", record);
    const primary = patches.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis");
    const worker = patches.find((p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker");
    const bash = (primary?.value as { permission: { bash: Record<string, string> } }).permission.bash;
    const workerBash = (worker?.value as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(bash["npm run poiesis -- *"]).toBe("allow");
    expect(bash["pnpm dlx poiesis-cli@1.6.0 *"]).toBeUndefined();
    expect(workerBash["npm run poiesis -- check *"]).toBe("allow");
    expect(workerBash["npm run poiesis -- repository status"]).toBe("allow");
    for (const key of WORKER_LOCAL_LIFECYCLE_DENY_KEYS) {
      expect(workerBash[key], key).toBe("deny");
    }
    const keys = Object.keys(workerBash);
    const lastLocalDenyIdx = Math.max(...WORKER_LOCAL_LIFECYCLE_DENY_KEYS.map((k) => keys.indexOf(k)));
    expect(keys.indexOf("npm run poiesis -- check *")).toBeGreaterThan(lastLocalDenyIdx);
    expect(keys.indexOf("npm run poiesis -- repository status")).toBeGreaterThan(lastLocalDenyIdx);
  });

  it("denies Worker pnpm/npm full lifecycle through last-match evaluation", () => {
    const pnpmRecord = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const npmRecord = buildPackageContributionRecord({
      manager: "npm",
      lockfile: "package-lock.json",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const pnpmWorker = (
      desiredOpenCodePatches(testConfig(), "1.6.0", pnpmRecord).find(
        (p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker",
      )?.value as { permission: { bash: Record<string, string> } }
    ).permission.bash;
    const npmWorker = (
      desiredOpenCodePatches(testConfig(), "1.6.0", npmRecord).find(
        (p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker",
      )?.value as { permission: { bash: Record<string, string> } }
    ).permission.bash;
    const pnpmPrimary = (
      desiredOpenCodePatches(testConfig(), "1.6.0", pnpmRecord).find(
        (p) => p.path[0] === "agent" && p.path[1] === "poiesis",
      )?.value as { permission: { bash: Record<string, string> } }
    ).permission.bash;

    const lifecycleCommands = [
      "pnpm poiesis workspace create",
      "pnpm poiesis checkpoint create",
      "pnpm poiesis verify",
      "pnpm poiesis tracker set-status done",
      "pnpm poiesis update",
      "npm run poiesis -- workspace create",
      "npm run poiesis -- verify",
      "npm run poiesis -- tracker set-status done",
    ] as const;

    for (const command of lifecycleCommands) {
      expect(lastMatchBashPermission(pnpmWorker, command), `pnpm worker: ${command}`).toBe("deny");
      expect(lastMatchBashPermission(npmWorker, command), `npm worker: ${command}`).toBe("deny");
    }

    // Narrow owned routes still win after the broad local denies.
    expect(lastMatchBashPermission(pnpmWorker, "pnpm poiesis check --command tsc")).toBe("allow");
    expect(lastMatchBashPermission(pnpmWorker, "pnpm poiesis repository status")).toBe("allow");
    expect(lastMatchBashPermission(npmWorker, "npm run poiesis -- check --command tsc")).toBe("allow");
    expect(lastMatchBashPermission(npmWorker, "npm run poiesis -- repository status")).toBe("allow");

    // Primary keeps the owned local lifecycle allow (last-match wins).
    expect(lastMatchBashPermission(pnpmPrimary, "pnpm poiesis workspace create")).toBe("allow");
    expect(lastMatchBashPermission(pnpmPrimary, "pnpm poiesis verify")).toBe("allow");
  });

  it("ticket #215: denies every supported local alias bare and remainder; narrow allows only canonical route", () => {
    const pnpmRecord = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const npmRecord = buildPackageContributionRecord({
      manager: "npm",
      lockfile: "package-lock.json",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const pnpmWorker = (
      desiredOpenCodePatches(testConfig(), "1.6.0", pnpmRecord).find(
        (p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker",
      )?.value as { permission: { bash: Record<string, string> } }
    ).permission.bash;
    const npmWorker = (
      desiredOpenCodePatches(testConfig(), "1.6.0", npmRecord).find(
        (p) => p.path[0] === "agent" && p.path[1] === "poiesis-worker",
      )?.value as { permission: { bash: Record<string, string> } }
    ).permission.bash;
    const pnpmPrimary = (
      desiredOpenCodePatches(testConfig(), "1.6.0", pnpmRecord).find(
        (p) => p.path[0] === "agent" && p.path[1] === "poiesis",
      )?.value as { permission: { bash: Record<string, string> } }
    ).permission.bash;

    // Complete deny key set projected and ordered: broad allow → all denies → narrow allows.
    for (const key of WORKER_LOCAL_LIFECYCLE_DENY_KEYS) {
      expect(pnpmWorker[key], key).toBe("deny");
      expect(npmWorker[key], key).toBe("deny");
    }
    const keys = Object.keys(pnpmWorker);
    expect(keys[0]).toBe("*");
    expect(pnpmWorker["*"]).toBe("allow");
    const firstLocalDenyIdx = Math.min(...WORKER_LOCAL_LIFECYCLE_DENY_KEYS.map((k) => keys.indexOf(k)));
    const lastLocalDenyIdx = Math.max(...WORKER_LOCAL_LIFECYCLE_DENY_KEYS.map((k) => keys.indexOf(k)));
    expect(firstLocalDenyIdx).toBeGreaterThan(keys.indexOf("pnpm dlx poiesis-cli@*"));
    expect(keys.indexOf("pnpm poiesis check *")).toBeGreaterThan(lastLocalDenyIdx);
    expect(keys.indexOf("pnpm poiesis repository status")).toBeGreaterThan(lastLocalDenyIdx);

    const aliasLifecycle = [
      "pnpm poiesis",
      "pnpm poiesis workspace create",
      "pnpm poiesis -- verify",
      "pnpm run poiesis",
      "pnpm run poiesis workspace create",
      "pnpm run poiesis -- verify",
      "npm run poiesis",
      "npm run poiesis workspace create",
      "npm run poiesis -- verify",
      "npm run-script poiesis",
      "npm run-script poiesis workspace create",
      "npm run-script poiesis -- verify",
    ] as const;
    for (const command of aliasLifecycle) {
      expect(lastMatchBashPermission(pnpmWorker, command), `pnpm worker: ${command}`).toBe("deny");
      expect(lastMatchBashPermission(npmWorker, command), `npm worker: ${command}`).toBe("deny");
    }

    // Canonical narrow allows only.
    expect(lastMatchBashPermission(pnpmWorker, "pnpm poiesis check --command tsc")).toBe("allow");
    expect(lastMatchBashPermission(pnpmWorker, "pnpm poiesis repository status")).toBe("allow");
    expect(lastMatchBashPermission(pnpmWorker, "pnpm poiesis repository query --question x")).toBe("allow");
    expect(lastMatchBashPermission(npmWorker, "npm run poiesis -- check --command tsc")).toBe("allow");
    expect(lastMatchBashPermission(npmWorker, "npm run poiesis -- repository explain --node n")).toBe("allow");

    // Noncanonical aliases denied even for narrow check/repository suffixes.
    expect(lastMatchBashPermission(pnpmWorker, "pnpm run poiesis check --command tsc")).toBe("deny");
    expect(lastMatchBashPermission(pnpmWorker, "npm run poiesis -- check --command tsc")).toBe("deny");
    expect(lastMatchBashPermission(pnpmWorker, "npm run-script poiesis check --command tsc")).toBe("deny");
    expect(lastMatchBashPermission(npmWorker, "pnpm poiesis check --command tsc")).toBe("deny");
    expect(lastMatchBashPermission(npmWorker, "npm run poiesis check --command tsc")).toBe("deny");
    expect(lastMatchBashPermission(npmWorker, "npm run-script poiesis repository status")).toBe("deny");

    // Primary unchanged: owned local lifecycle still allowed; no new primary denies.
    expect(lastMatchBashPermission(pnpmPrimary, "pnpm poiesis workspace create")).toBe("allow");
    expect(pnpmPrimary["pnpm run poiesis *"]).toBeUndefined();
    expect(pnpmPrimary["npm run-script poiesis *"]).toBeUndefined();
  });
});

describe("dependency section ownership (ticket #215)", () => {
  const nonDevSections = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

  for (const section of nonDevSections) {
    it(`ensure refuses exact desired poiesis-cli in ${section} as foreign (not owned dev)`, () => {
      const pkg = [
        "{",
        '  "name": "demo",',
        '  "version": "0.1.0",',
        '  "scripts": {},',
        `  "${section}": { "poiesis-cli": "1.6.0" }`,
        "}",
        "",
      ].join("\n");
      try {
        planPackageContribution({
          snapshot: snap({ packageJson: pkg, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
          poiesisVersion: "1.6.0",
          mode: "ensure",
        });
        expect.fail("expected PACKAGE_DEPENDENCY_CONFLICT");
      } catch (error) {
        expect(error).toBeInstanceOf(PoiesisError);
        expect((error as PoiesisError).code).toBe("PACKAGE_DEPENDENCY_CONFLICT");
        const details = (error as PoiesisError).details as {
          foreign?: Array<{ section: string; version: unknown }>;
        };
        expect(details.foreign).toEqual(expect.arrayContaining([{ section, version: "1.6.0" }]));
      }
    });

    it(`ensure refuses different version in ${section} with section-typed details`, () => {
      const pkg = [
        "{",
        '  "name": "demo",',
        '  "version": "0.1.0",',
        '  "scripts": {},',
        `  "${section}": { "poiesis-cli": "^1.5.0" }`,
        "}",
        "",
      ].join("\n");
      try {
        planPackageContribution({
          snapshot: snap({ packageJson: pkg, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
          poiesisVersion: "1.6.0",
          mode: "ensure",
        });
        expect.fail("expected PACKAGE_DEPENDENCY_CONFLICT");
      } catch (error) {
        expect((error as PoiesisError).code).toBe("PACKAGE_DEPENDENCY_CONFLICT");
        const details = (error as PoiesisError).details as {
          foreign?: Array<{ section: string; version: unknown }>;
        };
        expect(details.foreign).toEqual(expect.arrayContaining([{ section, version: "^1.5.0" }]));
      }
    });

    it(`ensure refuses malformed non-string poiesis-cli in ${section}`, () => {
      const pkg = [
        "{",
        '  "name": "demo",',
        '  "version": "0.1.0",',
        '  "scripts": {},',
        `  "${section}": { "poiesis-cli": true }`,
        "}",
        "",
      ].join("\n");
      try {
        planPackageContribution({
          snapshot: snap({ packageJson: pkg, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
          poiesisVersion: "1.6.0",
          mode: "ensure",
        });
        expect.fail("expected PACKAGE_DEPENDENCY_CONFLICT");
      } catch (error) {
        expect((error as PoiesisError).code).toBe("PACKAGE_DEPENDENCY_CONFLICT");
        const details = (error as PoiesisError).details as {
          foreign?: Array<{ section: string; version: unknown }>;
        };
        expect(details.foreign?.some((f) => f.section === section && f.version === true)).toBe(true);
      }
    });
  }

  it("ensure surfaces multiple foreign non-dev declarations together (none hidden)", () => {
    const pkg = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": {},',
      '  "dependencies": { "poiesis-cli": "1.6.0" },',
      '  "optionalDependencies": { "poiesis-cli": "1.5.0" },',
      '  "peerDependencies": { "poiesis-cli": true }',
      "}",
      "",
    ].join("\n");
    try {
      planPackageContribution({
        snapshot: snap({ packageJson: pkg, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "ensure",
      });
      expect.fail("expected PACKAGE_DEPENDENCY_CONFLICT");
    } catch (error) {
      expect((error as PoiesisError).code).toBe("PACKAGE_DEPENDENCY_CONFLICT");
      const foreign = ((error as PoiesisError).details as { foreign: Array<{ section: string }> }).foreign;
      expect(foreign.map((f) => f.section).sort()).toEqual([
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ]);
    }
  });

  it("exact owned devDependencies is noop; assert matches exact dev only", () => {
    const pkg = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: pkg, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("noop");
    if (plan.kind !== "noop") return;
    expect(plan.record.devDependencyVersion).toBe("1.6.0");
    expect(() => assertPackageContributionMatches(pkg, plan.record)).not.toThrow();
  });

  it("exact dev + foreign non-dev duplicate refuses and does not hide the foreign section", () => {
    const pkg = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" },',
      '  "dependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    try {
      planPackageContribution({
        snapshot: snap({ packageJson: pkg, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "ensure",
      });
      expect.fail("expected PACKAGE_DEPENDENCY_CONFLICT");
    } catch (error) {
      expect((error as PoiesisError).code).toBe("PACKAGE_DEPENDENCY_CONFLICT");
      const foreign = ((error as PoiesisError).details as { foreign: Array<{ section: string }> }).foreign;
      expect(foreign).toEqual([{ section: "dependencies", version: "1.6.0" }]);
    }
  });

  it("repair prior permits only same-path devDependencies version cross", () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.5.0",
    });
    const ok = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.5.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ok, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "repair",
      prior,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind === "apply") {
      expect(parsePkg(plan.nextPackageJson).devDependencies?.["poiesis-cli"]).toBe("1.6.0");
    }

    const foreignNonDev = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "dependencies": { "poiesis-cli": "1.5.0" }',
      "}",
      "",
    ].join("\n");
    expect(() =>
      planPackageContribution({
        snapshot: snap({ packageJson: foreignNonDev, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        poiesisVersion: "1.6.0",
        mode: "repair",
        prior,
      }),
    ).toThrow(PoiesisError);
  });

  it("selfhost rejects poiesis-cli in every dependency section", () => {
    for (const section of ["devDependencies", "dependencies", "optionalDependencies", "peerDependencies"] as const) {
      const pkg = [
        "{",
        '  "name": "poiesis-cli",',
        '  "version": "1.6.0",',
        '  "scripts": {},',
        `  "${section}": { "poiesis-cli": "1.6.0" }`,
        "}",
        "",
      ].join("\n");
      try {
        planPackageContribution({
          snapshot: snap({ packageJson: pkg, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
          poiesisVersion: "1.6.0",
          mode: "ensure",
        });
        expect.fail(`expected PACKAGE_SELF_DEPENDENCY for ${section}`);
      } catch (error) {
        expect((error as PoiesisError).code).toBe("PACKAGE_SELF_DEPENDENCY");
      }
    }
  });

  it("removal only drops exact owned devDependencies; relocated same version is preserved with no native remove", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    // Author relocated the exact version into dependencies.
    const relocated = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "dependencies": { "poiesis-cli": "1.6.0" },',
      '  "devDependencies": { "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContributionRemoval({
      snapshot: snap({ packageJson: relocated, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      record,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.lockfileOperation).toBeNull();
    expect(plan.preserved).toEqual(
      expect.arrayContaining([
        {
          path: ["dependencies", "poiesis-cli"],
          reason: "foreign dependency section is outside owned devDependencies",
        },
      ]),
    );
    const next = parsePkg(plan.nextPackageJson);
    expect(next.dependencies?.["poiesis-cli"]).toBe("1.6.0");
    expect(next.scripts?.poiesis).toBeUndefined();
    expect(next.scripts?.build).toBe("tsc");
  });

  it("when non-dev declaration remains, preserves matching dev too and schedules no native remove", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const dual = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" },',
      '  "dependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContributionRemoval({
      snapshot: snap({ packageJson: dual, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      record,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.lockfileOperation).toBeNull();
    const next = parsePkg(plan.nextPackageJson);
    expect(next.devDependencies?.["poiesis-cli"]).toBe("1.6.0");
    expect(next.dependencies?.["poiesis-cli"]).toBe("1.6.0");
    expect(next.scripts?.poiesis).toBeUndefined();
    expect(plan.preserved?.some((p) => p.path[0] === "devDependencies")).toBe(true);
    expect(plan.preserved?.some((p) => p.path[0] === "dependencies")).toBe(true);
  });

  it("removal of exact owned dev alone still schedules remove-dev", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const onlyDev = [
      "{",
      '  "name": "demo",',
      '  "version": "0.1.0",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContributionRemoval({
      snapshot: snap({ packageJson: onlyDev, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      record,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.lockfileOperation).toEqual({ op: "remove-dev", name: "poiesis-cli" });
    expect(parsePkg(plan.nextPackageJson).devDependencies?.["poiesis-cli"]).toBeUndefined();
    expect(parsePkg(plan.nextPackageJson).devDependencies?.typescript).toBe("^5.0.0");
  });
});

describe("owned-write journal identity and native pm incomplete (ticket #210 replan)", () => {
  it("binds package.json identity before executor; incomplete failure still allows owned-byte restore", async () => {
    // Pure in-memory journal entries (no git repo): bind identity on write,
    // then prove rollback restores only when identity still matches.
    const packageJsonEntry = {
      path: "/mem/package.json",
      physicalExists: true,
      preimage: Buffer.from(ORDINARY_PKG),
      ownershipMode: "whole-file" as const,
      expectedPreWriteIdentity: { exists: true as const, kind: "file" as const, hash: hashContent(ORDINARY_PKG) },
      transactionWrittenIdentity: undefined as
        | { exists: true; kind: "file"; hash: string }
        | undefined,
    };
    const lockfileEntry = {
      path: "/mem/pnpm-lock.yaml",
      physicalExists: true,
      preimage: Buffer.from("lock-before\n"),
      ownershipMode: "whole-file" as const,
      expectedPreWriteIdentity: {
        exists: true as const,
        kind: "file" as const,
        hash: hashContent("lock-before\n"),
      },
      transactionWrittenIdentity: undefined as
        | { exists: true; kind: "file"; hash: string }
        | undefined,
    };

    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock-before\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");

    const store = new Map<string, string>([
      [PACKAGE_JSON_RELATIVE, ORDINARY_PKG],
      ["pnpm-lock.yaml", "lock-before\n"],
    ]);

    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: ORDINARY_PKG, lockfile: "lock-before\n" },
        executor: {
          async apply() {
            expect(packageJsonEntry.transactionWrittenIdentity?.hash).toBe(hashContent(plan.nextPackageJson));
            expect(lockfileEntry.transactionWrittenIdentity).toBeUndefined();
            throw new PoiesisError("PACKAGE_MANAGER_FAILED", "injected", {});
          },
        },
        writeFile: async (path, content) => {
          store.set(path, content);
        },
        onWritten: (path, content) => {
          const identity = { exists: true as const, kind: "file" as const, hash: hashContent(content) };
          if (path === PACKAGE_JSON_RELATIVE) packageJsonEntry.transactionWrittenIdentity = identity;
          if (path === "pnpm-lock.yaml") lockfileEntry.transactionWrittenIdentity = identity;
        },
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_MANAGER_INCOMPLETE",
      details: { nativeSideEffectsNotClaimedRolledBack: true, ownedArtifactsMayRollback: true },
    });

    // Owned package.json write is still present and identity-bound — caller
    // journal may restore it. No claim that node_modules was reversed.
    expect(store.get(PACKAGE_JSON_RELATIVE)).toBe(plan.nextPackageJson);
    expect(packageJsonEntry.transactionWrittenIdentity?.hash).toBe(hashContent(plan.nextPackageJson));
  });

  it("onWritten fires with exact authored bytes after each known write", async () => {
    const written: Array<{ path: string; content: string }> = [];
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock-before\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: ORDINARY_PKG, lockfile: "lock-before\n" },
      executor: {
        async apply(request) {
          return { packageJson: request.packageJson, lockfile: "lock-after\n" };
        },
      },
      writeFile: async () => undefined,
      onWritten: (path, content) => {
        written.push({ path, content });
      },
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
    });
    expect(written.map((w) => w.path)).toEqual([PACKAGE_JSON_RELATIVE, "pnpm-lock.yaml"]);
    expect(written[0]!.content).toBe(plan.nextPackageJson);
    expect(written[1]!.content).toBe("lock-after\n");
  });
});

describe("native pm argv and resolved version seams (ticket #210 replan)", () => {
  it("exports exact npm/pnpm argv with --save-exact/-E and --ignore-scripts", () => {
    expect(nativePackageManagerArgv("pnpm", { op: "add-dev", name: "poiesis-cli", version: "1.6.0" })).toEqual([
      "add",
      "-D",
      "-E",
      "poiesis-cli@1.6.0",
      "--ignore-scripts",
    ]);
    expect(nativePackageManagerArgv("npm", { op: "add-dev", name: "poiesis-cli", version: "1.6.0" })).toEqual([
      "install",
      "-D",
      "-E",
      "poiesis-cli@1.6.0",
      "--ignore-scripts",
    ]);
    expect(nativePackageManagerArgv("pnpm", { op: "remove-dev", name: "poiesis-cli" })).toEqual([
      "remove",
      "poiesis-cli",
      "--ignore-scripts",
    ]);
    expect(nativePackageManagerArgv("npm", { op: "remove-dev", name: "poiesis-cli" })).toEqual([
      "uninstall",
      "poiesis-cli",
      "--ignore-scripts",
    ]);
  });

  it("assertResolvedLocalCliVersion matches and mismatches", () => {
    expect(() =>
      assertResolvedLocalCliVersion({
        expectedVersion: "1.6.0",
        installedPackageJson: JSON.stringify({ version: "1.6.0" }),
      }),
    ).not.toThrow();
    expect(() =>
      assertResolvedLocalCliVersion({
        expectedVersion: "1.6.0",
        installedPackageJson: JSON.stringify({ version: "1.5.0" }),
      }),
    ).toThrow(PoiesisError);
    try {
      assertResolvedLocalCliVersion({ expectedVersion: "1.6.0", installedPackageJson: null });
      expect.fail("expected throw");
    } catch (error) {
      expect((error as PoiesisError).code).toBe("PACKAGE_LOCAL_BIN_UNRESOLVED");
      expect((error as PoiesisError).details.path).toBe(LOCAL_CLI_PACKAGE_JSON_RELATIVE);
    }
  });

  it("assertSelfhostDistReady probes node dist/cli.js --version without package scripts", () => {
    expect(() =>
      assertSelfhostDistReady({
        expectedVersion: "1.6.0",
        probe: { ok: true, stdout: "1.6.0\n" },
      }),
    ).not.toThrow();
    try {
      assertSelfhostDistReady({
        expectedVersion: "1.6.0",
        probe: { ok: false, code: "missing" },
      });
      expect.fail("expected missing");
    } catch (error) {
      expect((error as PoiesisError).code).toBe("SELFHOST_DIST_MISSING");
      expect((error as PoiesisError).details.path).toBe(SELFHOST_DIST_CLI_RELATIVE);
    }
    try {
      assertSelfhostDistReady({
        expectedVersion: "1.6.0",
        probe: { ok: true, stdout: "1.5.0\n" },
      });
      expect.fail("expected mismatch");
    } catch (error) {
      expect((error as PoiesisError).code).toBe("SELFHOST_DIST_VERSION_MISMATCH");
      expect((error as PoiesisError).details.actualVersion).toBe("1.5.0");
    }
  });

  it("selfhost apply refuses missing dist before writing package.json", async () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: SELFHOST_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const writes: string[] = [];
    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: SELFHOST_PKG, lockfile: "lock\n" },
        executor: {
          async apply() {
            throw new Error("executor must not run for selfhost script-only");
          },
        },
        writeFile: async (path) => {
          writes.push(path);
        },
        selfhostExpectedVersion: "1.6.0",
        probeSelfhostDist: async () => ({ ok: false, code: "missing" }),
      }),
    ).rejects.toMatchObject({ code: "SELFHOST_DIST_MISSING" });
    expect(writes).toEqual([]);
  });

  it("selfhost apply proceeds when dist version matches via direct node probe shape", async () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: SELFHOST_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const result = await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: SELFHOST_PKG, lockfile: "lock\n" },
      executor: {
        async apply() {
          throw new Error("no lock op for selfhost");
        },
      },
      writeFile: async () => undefined,
      selfhostExpectedVersion: "1.6.0",
      probeSelfhostDist: async () => ({ ok: true, stdout: "1.6.0\n" }),
    });
    expect(result.record.scriptValue).toBe("node dist/cli.js");
    expect(result.record.devDependencyVersion).toBeUndefined();
  });
});

describe("ordinary readiness required on every retained contribution (ticket #210 correction)", () => {
  const ordinaryRecord = () =>
    buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });

  it("runtime ready: matching resolved bin succeeds", async () => {
    await expect(
      assertPackageContributionRuntimeReady({
        record: ordinaryRecord(),
        poiesisVersion: "1.6.0",
        readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("runtime ready: missing resolved bin fails closed", async () => {
    await expect(
      assertPackageContributionRuntimeReady({
        record: ordinaryRecord(),
        poiesisVersion: "1.6.0",
        readResolvedLocalPackageJson: async () => null,
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_LOCAL_BIN_UNRESOLVED" });
  });

  it("runtime ready: wrong resolved bin version fails closed", async () => {
    await expect(
      assertPackageContributionRuntimeReady({
        record: ordinaryRecord(),
        poiesisVersion: "1.6.0",
        readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.5.0" }),
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_LOCAL_BIN_VERSION_MISMATCH",
      details: { expectedVersion: "1.6.0", actualVersion: "1.5.0" },
    });
  });

  it("runtime ready: no reader cannot skip ordinary contribution", async () => {
    await expect(
      assertPackageContributionRuntimeReady({
        record: ordinaryRecord(),
        poiesisVersion: "1.6.0",
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_LOCAL_BIN_UNRESOLVED" });
  });

  it("ordinary apply without reader fails even when package.json already correct (script-only)", async () => {
    const already = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    // Script missing → apply with lockfileOperation null (dep already exact).
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: already, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.lockfileOperation).toBeNull();
    expect(plan.packageJsonChanged).toBe(true);
    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: already, lockfile: "lock\n" },
        executor: {
          async apply() {
            throw new Error("no lock op");
          },
        },
        writeFile: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_LOCAL_BIN_UNRESOLVED" });
  });

  it("ordinary script-only apply succeeds only with matching resolved bin reader", async () => {
    const already = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: already, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const result = await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: already, lockfile: "lock\n" },
      executor: {
        async apply() {
          throw new Error("no lock op");
        },
      },
      writeFile: async () => undefined,
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
    });
    expect(result.record.devDependencyVersion).toBe("1.6.0");
    expect(parsePkg(result.packageJson).scripts?.poiesis).toBe("poiesis");
  });

  it("ordinary noop readiness still requires matching resolved bin (production wiring shape)", async () => {
    const withOwned = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: withOwned, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("noop");
    if (plan.kind !== "noop") return;
    await expect(
      assertPackageContributionRuntimeReady({
        record: plan.record,
        poiesisVersion: "1.6.0",
        readResolvedLocalPackageJson: async () => null,
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_LOCAL_BIN_UNRESOLVED" });
    await expect(
      assertPackageContributionRuntimeReady({
        record: plan.record,
        poiesisVersion: "1.6.0",
        readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("package plan-to-capture identity bind (ticket #214 correction A)", () => {
  function journalEntryFor(content: string): Pick<ArtifactJournalEntry, "preimage" | "expectedPreWriteIdentity"> {
    const preimage = Buffer.from(content, "utf8");
    return {
      preimage,
      expectedPreWriteIdentity: { exists: true, kind: "file", hash: hashContent(preimage) },
    };
  }

  it("apply plans carry the ORIGINAL package.json preimage hash, never nextPackageJson", () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.expectedPackageJsonPreimageHash).toBe(hashContent(ORDINARY_PKG));
    expect(plan.expectedPackageJsonPreimageHash).not.toBe(hashContent(plan.nextPackageJson));
  });

  it("removal apply plans carry the snapshot preimage hash from the planner", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const owned = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContributionRemoval({
      snapshot: snap({ packageJson: owned, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      record,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.expectedPackageJsonPreimageHash).toBe(hashContent(owned));
    expect(plan.expectedPackageJsonPreimageHash).not.toBe(hashContent(plan.nextPackageJson));
  });

  it("assertPackageContributionCaptureIdentity accepts matching capture preimage/identity", () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    expect(() => assertPackageContributionCaptureIdentity(plan, journalEntryFor(ORDINARY_PKG))).not.toThrow();
  });

  it("assertPackageContributionCaptureIdentity rejects drifted capture and does not treat nextPackageJson as preimage", () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const intervening = ORDINARY_PKG.replace('"name": "demo"', '"name": "hijacked"');
    expect(() => assertPackageContributionCaptureIdentity(plan, journalEntryFor(intervening))).toThrow(
      expect.objectContaining({
        code: "ARTIFACT_IDENTITY_DRIFT",
        details: { path: PACKAGE_JSON_RELATIVE },
      }),
    );
    // nextPackageJson must never be accepted as the expected preimage.
    expect(() =>
      assertPackageContributionCaptureIdentity(plan, journalEntryFor(plan.nextPackageJson)),
    ).toThrow(expect.objectContaining({ code: "ARTIFACT_IDENTITY_DRIFT" }));
  });

  it("change after plan before capture rejects applyPackageContributionWithJournal before write/executor", async () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock-before\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const intervening = ORDINARY_PKG.replace('"name": "demo"', '"name": "author-edit"');
    const packageJsonEntry = {
      path: "/tmp/package.json",
      physicalExists: true,
      ownershipMode: "whole-file" as const,
      ...journalEntryFor(intervening),
    };
    const lockfileEntry = {
      path: "/tmp/pnpm-lock.yaml",
      physicalExists: true,
      ownershipMode: "whole-file" as const,
      preimage: Buffer.from("lock-before\n", "utf8"),
      expectedPreWriteIdentity: { exists: true, kind: "file" as const, hash: hashContent("lock-before\n") },
    };
    const writes: string[] = [];
    let executorCalled = false;
    await expect(
      applyPackageContributionWithJournal({
        root: "/tmp",
        plan,
        packageJsonEntry,
        lockfileEntry,
        replaceOwnedFile: async () => {
          writes.push("replace");
        },
        executor: {
          async apply() {
            executorCalled = true;
            return { packageJson: plan.nextPackageJson, lockfile: "lock-after\n" };
          },
        },
        preimageLockfile: "lock-before\n",
        poiesisVersion: "1.6.0",
        readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_IDENTITY_DRIFT",
      details: { path: PACKAGE_JSON_RELATIVE },
    });
    expect(writes).toEqual([]);
    expect(executorCalled).toBe(false);
  });

  it("matching capture allows applyPackageContributionWithJournal to proceed to write", async () => {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock-before\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const packageJsonEntry = {
      path: "/tmp/package.json",
      physicalExists: true,
      ownershipMode: "whole-file" as const,
      ...journalEntryFor(ORDINARY_PKG),
    };
    const lockfileEntry = {
      path: "/tmp/pnpm-lock.yaml",
      physicalExists: true,
      ownershipMode: "whole-file" as const,
      preimage: Buffer.from("lock-before\n", "utf8"),
      expectedPreWriteIdentity: { exists: true, kind: "file" as const, hash: hashContent("lock-before\n") },
    };
    const writes: string[] = [];
    await applyPackageContributionWithJournal({
      root: "/tmp",
      plan,
      packageJsonEntry,
      lockfileEntry,
      replaceOwnedFile: async (_entry, content) => {
        writes.push(content.slice(0, 20));
      },
      executor: {
        async apply(request) {
          return { packageJson: request.packageJson, lockfile: "lock-after\n" };
        },
      },
      preimageLockfile: "lock-before\n",
      poiesisVersion: "1.6.0",
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
    });
    expect(writes.length).toBeGreaterThan(0);
  });

  it("noop plans carry original package.json preimage hash and retain contribution", () => {
    const owned = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: owned, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("noop");
    if (plan.kind !== "noop") return;
    expect(plan.expectedPackageJsonPreimageHash).toBe(hashContent(owned));
    expect(packagePlanRetainsContribution(plan)).toBe(true);
    expect(packagePlanRetainsContribution({ kind: "absent" })).toBe(false);
  });

  it("assertPackageContributionCaptureIdentity gates noop retain/advance on original hash", () => {
    const owned = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: owned, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(packagePlanRetainsContribution(plan)).toBe(true);
    if (!packagePlanRetainsContribution(plan)) throw new Error("expected retainable noop");
    // Matching journal capture and current-content observation both pass.
    expect(() => assertPackageContributionCaptureIdentity(plan, journalEntryFor(owned))).not.toThrow();
    expect(() =>
      assertPackageContributionCaptureIdentity(plan, { packageJsonContent: owned }),
    ).not.toThrow();
    // Author edit after plan → ARTIFACT_IDENTITY_DRIFT before any ownership advance.
    const intervening = owned.replace('"name": "demo"', '"name": "author-edit"');
    expect(() => assertPackageContributionCaptureIdentity(plan, journalEntryFor(intervening))).toThrow(
      expect.objectContaining({
        code: "ARTIFACT_IDENTITY_DRIFT",
        details: { path: PACKAGE_JSON_RELATIVE },
      }),
    );
    expect(() =>
      assertPackageContributionCaptureIdentity(plan, { packageJsonContent: intervening }),
    ).toThrow(expect.objectContaining({ code: "ARTIFACT_IDENTITY_DRIFT" }));
  });

  it("caller retain gate: apply and hashed noop require identity bind; absent does not", () => {
    const apply = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(packagePlanRetainsContribution(apply)).toBe(true);
    expect(packagePlanIsNoopWithPreimage(apply)).toBe(false);
    const owned = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const noop = planPackageContribution({
      snapshot: snap({ packageJson: owned, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(noop.kind).toBe("noop");
    expect(packagePlanRetainsContribution(noop)).toBe(true);
    expect(packagePlanIsNoopWithPreimage(noop)).toBe(true);
    // Removal with no package.json: noop without preimage — does not retain via gate.
    const removalNoPkg = planPackageContributionRemoval({
      snapshot: snap({}),
      record: buildPackageContributionRecord({
        manager: "pnpm",
        lockfile: "pnpm-lock.yaml",
        projectKind: "ordinary",
        scriptValue: "poiesis",
        devDependencyVersion: "1.6.0",
      }),
    });
    expect(removalNoPkg.kind).toBe("noop");
    expect(packagePlanRetainsContribution(removalNoPkg)).toBe(false);
    expect(packagePlanIsNoopWithPreimage(removalNoPkg)).toBe(false);
  });

  it("writeManifestWithNoopPackageContributionGate: read→assert→write order; drift/missing skip writer", async () => {
    const owned = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: owned, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(packagePlanIsNoopWithPreimage(plan)).toBe(true);
    if (!packagePlanIsNoopWithPreimage(plan)) throw new Error("expected noop");

    const events: string[] = [];
    await writeManifestWithNoopPackageContributionGate({
      plan,
      readPackageJson: async () => {
        events.push("read");
        return owned;
      },
      writeManifest: async () => {
        events.push("write");
      },
    });
    expect(events).toEqual(["read", "write"]);

    // Drift: writer never called.
    const drifted: string[] = [];
    await expect(
      writeManifestWithNoopPackageContributionGate({
        plan,
        readPackageJson: async () => {
          drifted.push("read");
          return owned.replace('"name": "demo"', '"name": "hijacked"');
        },
        writeManifest: async () => {
          drifted.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT", details: { path: PACKAGE_JSON_RELATIVE } });
    expect(drifted).toEqual(["read"]);

    // Missing: writer never called.
    const missing: string[] = [];
    await expect(
      writeManifestWithNoopPackageContributionGate({
        plan,
        readPackageJson: async () => {
          missing.push("read");
          return null;
        },
        writeManifest: async () => {
          missing.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });
    expect(missing).toEqual(["read"]);

    // Reader throw → drift, writer not called.
    const threw: string[] = [];
    await expect(
      writeManifestWithNoopPackageContributionGate({
        plan,
        readPackageJson: async () => {
          threw.push("read");
          throw new Error("ENOENT");
        },
        writeManifest: async () => {
          threw.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });
    expect(threw).toEqual(["read"]);
  });

  it("production callers wire writeManifestWithNoopPackageContributionGate at publication boundary", async () => {
    const root = join(import.meta.dirname, "..");
    const maintenance = await readFile(join(root, "src/maintenance.ts"), "utf8");
    const updateInternal = await readFile(join(root, "src/update-internal.ts"), "utf8");
    const updateConfig = await readFile(join(root, "src/update-config-internal.ts"), "utf8");
    expect(maintenance).toContain("writeManifestWithNoopPackageContributionGate");
    expect(updateConfig).toContain("writeManifestWithNoopPackageContributionGate");
    // Ordinary update + bootstrap legacy both publish through the helper
    // (import once + two call sites).
    expect(updateInternal.match(/writeManifestWithNoopPackageContributionGate/g)?.length).toBe(3);
    expect((updateInternal.match(/await writeManifestWithNoopPackageContributionGate\(/g) ?? []).length).toBe(2);
    expect((maintenance.match(/await writeManifestWithNoopPackageContributionGate\(/g) ?? []).length).toBe(1);
    expect((updateConfig.match(/await writeManifestWithNoopPackageContributionGate\(/g) ?? []).length).toBe(1);
    // Apply path must not run the noop final guard unconditionally — gated by packagePlanIsNoopWithPreimage.
    expect(updateInternal).toContain("packagePlanIsNoopWithPreimage(packagePlan)");
    expect(maintenance).toContain("packagePlanIsNoopWithPreimage(packagePlan)");
    expect(updateConfig).toContain("packagePlanIsNoopWithPreimage(packagePlan)");
  });
});

describe("update-config version-cross package planning seam (ticket #210 correction)", () => {
  it("version-cross plans exact dep bump and local projection from the new record", () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.5.0",
    });
    const current = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
      '  "devDependencies": { "poiesis-cli": "1.5.0", "typescript": "^5.0.0" }',
      "}",
      "",
    ].join("\n");
    const { plan, contributionForProjection } = planPackageContributionForVersionCross({
      snapshot: snap({ packageJson: current, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      nextPoiesisVersion: "1.6.0",
      prior,
    });
    expect(plan.kind).toBe("apply");
    expect(contributionForProjection?.devDependencyVersion).toBe("1.6.0");
    expect(contributionForProjection?.scriptValue).toBe("poiesis");
    // Projection must use the NEW record so permissions stay local while the
    // next manifest records the crossed exact version — never the stale 1.5.0.
    expect(canonicalInvocationPrefix("1.6.0", contributionForProjection)).toBe("pnpm poiesis");
    const primary = desiredOpenCodePatches(testConfig(), "1.6.0", contributionForProjection).find(
      (p) => p.path[0] === "agent" && p.path[1] === "poiesis",
    );
    const bash = (primary?.value as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(bash["pnpm poiesis *"]).toBe("allow");
    expect(bash["pnpm dlx poiesis-cli@1.6.0 *"]).toBeUndefined();
    if (plan.kind === "apply") {
      expect(parsePkg(plan.nextPackageJson).devDependencies?.["poiesis-cli"]).toBe("1.6.0");
    }
  });

  it("absent package.json keeps exact dlx and fabricates no contribution metadata", () => {
    const { plan, contributionForProjection } = planPackageContributionForVersionCross({
      snapshot: snap({}),
      nextPoiesisVersion: "1.6.0",
    });
    expect(plan).toEqual({ kind: "absent" });
    expect(contributionForProjection).toBeUndefined();
    expect(canonicalInvocationPrefix("1.6.0", contributionForProjection)).toBe("pnpm dlx poiesis-cli@1.6.0");
  });

  it("fails closed on foreign script conflict when no prior ownership authorizes repair", () => {
    const conflicted = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "echo foreign" },',
      '  "devDependencies": {}',
      "}",
      "",
    ].join("\n");
    expect(() =>
      planPackageContributionForVersionCross({
        snapshot: snap({ packageJson: conflicted, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
        nextPoiesisVersion: "1.6.0",
      }),
    ).toThrow(PoiesisError);
  });
});

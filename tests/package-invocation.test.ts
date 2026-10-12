/**
 * Spec #207 / ticket #210 — pinned local package invocation with ownership-safe
 * package.json + lockfile lifecycle.
 * Spec #219 / ticket #220 — root-aligned pnpm workspace eligibility + scope.
 * Spec #219 / ticket #221 — update / version-cross / removal lifecycle on the
 * same eligibility + explicit workspace-root scope; child manifests stay
 * byte-identical; fail-closed drift and incomplete native ops.
 *
 * Pure / in-memory / injected-executor tests plus bounded real-pnpm workspace
 * fixtures. No mock agent sessions.
 */
import { afterAll, describe, expect, it } from "vitest";
import { parseJsonc, type PoiesisConfig } from "../src/config.js";
import { PoiesisError } from "../src/errors.js";
import { hashContent } from "../src/hash.js";
import {
  LOCAL_CLI_BIN_RELATIVE,
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
  assertLocalCliExecutableAtRoot,
  assertPackageContributionCaptureIdentity,
  assertPackageContributionMatches,
  assertPackageContributionRuntimeReady,
  assertResolvedLocalCliExecutable,
  assertResolvedLocalCliVersion,
  assertSelfhostDistReady,
  buildPackageContributionRecord,
  classifyPackageProject,
  createNativePackageManagerExecutor,
  desiredScriptValue,
  detectOuterPnpmWorkspace,
  gateUpdateConfigEarlyNoopPackage,
  isExternalLockfileDir,
  nativePackageManagerArgv,
  packageContributionMode,
  packagePlanIsNoopWithPreimage,
  packagePlanRetainsContribution,
  parsePnpmSharedLockSettings,
  planPackageContribution,
  planPackageContributionForVersionCross,
  planPackageContributionRemoval,
  readPackageFsSnapshot,
  resolvePackageManagerOwnership,
  writeManifestWithNoopPackageContributionGate,
  writeManifestWithPackageContributionGate,
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
import { mkdtemp, mkdir, readFile, rm, writeFile as writeFileUtf8 } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  npmrc?: string | null;
  outerPnpmWorkspace?: boolean;
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
    ...(args.npmrc === undefined ? {} : { npmrc: args.npmrc }),
    ...(args.outerPnpmWorkspace === undefined ? {} : { outerPnpmWorkspace: args.outerPnpmWorkspace }),
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
      executionScope: { kind: "single-package" },
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
      executionScope: { kind: "single-package" },
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

  it("fails closed on package.json npm workspaces", () => {
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

describe("pnpm workspace-root eligibility (Spec #219 / ticket #220)", () => {
  const PNPM_WS = "packages:\n  - 'packages/*'\n";
  const PNPM_LOCK = "lockfileVersion: '9.0'\n";

  it("accepts root-aligned pnpm workspace with sole root pnpm-lock.yaml", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
      }),
    );
    expect(resolved).toEqual({
      kind: "supported",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      executionScope: { kind: "pnpm-workspace-root" },
    });
  });

  it("fails closed on npm workspaces even when pnpm-workspace.yaml is also present", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ['{', '  "name": "demo",', '  "workspaces": ["packages/*"]', "}", ""].join("\n"),
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") {
      expect(resolved.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
      expect(resolved.details.packageWorkspaces).toBe(true);
    }
  });

  it("fails closed when shared-workspace-lockfile is disabled via .npmrc", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
        npmrc: "shared-workspace-lockfile=false\n",
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") {
      expect(resolved.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
      expect(resolved.details.sharedWorkspaceLockfile).toBe(false);
    }
  });

  it("fails closed when package.json disables pnpm.sharedWorkspaceLockfile", () => {
    const pkg = [
      "{",
      '  "name": "demo",',
      '  "pnpm": { "sharedWorkspaceLockfile": false }',
      "}",
      "",
    ].join("\n");
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: pkg,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") expect(resolved.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
  });

  it("fails closed when lockfile-dir redirects outside the root", () => {
    expect(isExternalLockfileDir("../locks")).toBe(true);
    expect(isExternalLockfileDir(".")).toBe(false);
    expect(parsePnpmSharedLockSettings("lockfile-dir=../other\n").lockfileDir).toBe("../other");
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
        npmrc: "lockfile-dir=../external-locks\n",
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") {
      expect(resolved.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
      expect(resolved.details.lockfileDir).toBe("../external-locks");
    }
  });

  it("fails closed when local workspace + outer parent workspace (non-root effective scope)", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
        outerPnpmWorkspace: true,
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") {
      expect(resolved.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
      expect(resolved.details.outerPnpmWorkspace).toBe(true);
      expect(resolved.details.pnpmWorkspace).toBe(true);
    }
  });

  it("fails closed on outer parent workspace even without a local pnpm-workspace.yaml (nested single-package layout)", () => {
    // Nested project under an outer monorepo: sole root lock present, no local
    // workspace file — must not resolve as single-package ownership.
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK },
        outerPnpmWorkspace: true,
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") {
      expect(resolved.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
      expect(resolved.details.outerPnpmWorkspace).toBe(true);
      expect(resolved.details.pnpmWorkspace).toBe(false);
    }
  });

  it("ordinary single-package without outer flag remains supported", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK },
      }),
    );
    expect(resolved).toEqual({
      kind: "supported",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      executionScope: { kind: "single-package" },
    });
  });

  it("detectOuterPnpmWorkspace / readPackageFsSnapshot see parent workspace and refuse nested ownership", async () => {
    const outer = await mkdtemp(join(tmpdir(), "poiesis-outer-ws-220-"));
    try {
      const nested = join(outer, "apps", "nested");
      await mkdir(nested, { recursive: true });
      await writeFileUtf8(join(outer, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8");
      await writeFileUtf8(join(nested, "package.json"), ORDINARY_PKG, "utf8");
      await writeFileUtf8(join(nested, "pnpm-lock.yaml"), PNPM_LOCK, "utf8");
      // No local pnpm-workspace.yaml under nested.

      const readText = async (absolutePath: string): Promise<string | null> => {
        try {
          return await readFile(absolutePath, "utf8");
        } catch {
          return null;
        }
      };

      expect(await detectOuterPnpmWorkspace(nested, { readText })).toBe(true);
      expect(await detectOuterPnpmWorkspace(outer, { readText })).toBe(false);

      const snapshot = await readPackageFsSnapshot(nested, { readText });
      expect(snapshot.outerPnpmWorkspace).toBe(true);
      expect(snapshot.lockfiles["pnpm-workspace.yaml"]).toBeNull();
      const resolved = resolvePackageManagerOwnership(snapshot);
      expect(resolved.kind).toBe("unsupported");
      if (resolved.kind === "unsupported") {
        expect(resolved.code).toBe("PACKAGE_WORKSPACE_UNSUPPORTED");
        expect(resolved.details.outerPnpmWorkspace).toBe(true);
        expect(resolved.details.pnpmWorkspace).toBe(false);
      }
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it("fails closed on ambiguous locks inside a pnpm workspace", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: {
          "pnpm-lock.yaml": PNPM_LOCK,
          "package-lock.json": "{}",
          "pnpm-workspace.yaml": PNPM_WS,
        },
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") expect(resolved.code).toBe("PACKAGE_MANAGER_AMBIGUOUS");
  });

  it("fails closed when pnpm-workspace.yaml exists without a root pnpm-lock.yaml", () => {
    const resolved = resolvePackageManagerOwnership(
      snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-workspace.yaml": PNPM_WS },
      }),
    );
    expect(resolved.kind).toBe("unsupported");
    if (resolved.kind === "unsupported") expect(resolved.code).toBe("PACKAGE_MANAGER_UNSUPPORTED");
  });

  it("planning carries explicit workspace-root execution scope without durable schema fields", () => {
    const plan = planPackageContribution({
      snapshot: snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
      }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.executionScope).toEqual({ kind: "pnpm-workspace-root" });
    // Durable record stays root-relative — no workspace field on the ownership schema.
    expect(plan.record).toEqual({
      owned: true,
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      packageJson: "package.json",
      scriptName: "poiesis",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    expect(Object.keys(plan.record).sort()).toEqual(
      [
        "owned",
        "manager",
        "lockfile",
        "projectKind",
        "packageJson",
        "scriptName",
        "scriptValue",
        "devDependencyVersion",
      ].sort(),
    );
    const next = parsePkg(plan.nextPackageJson);
    expect(next.scripts?.poiesis).toBe("poiesis");
    expect(next.devDependencies?.["poiesis-cli"]).toBe("1.6.0");
  });

  it("native argv uses explicit -w for pnpm workspace-root add and remove", () => {
    const scope = { kind: "pnpm-workspace-root" as const };
    expect(
      nativePackageManagerArgv("pnpm", { op: "add-dev", name: "poiesis-cli", version: "1.6.0" }, scope),
    ).toEqual(["add", "-w", "-D", "-E", "poiesis-cli@1.6.0", "--ignore-scripts"]);
    expect(nativePackageManagerArgv("pnpm", { op: "remove-dev", name: "poiesis-cli" }, scope)).toEqual([
      "install",
      "-w",
      "--ignore-scripts",
    ]);
    // Single-package default remains unchanged.
    expect(nativePackageManagerArgv("pnpm", { op: "add-dev", name: "poiesis-cli", version: "1.6.0" })).toEqual([
      "add",
      "-D",
      "-E",
      "poiesis-cli@1.6.0",
      "--ignore-scripts",
    ]);
  });

  it("apply passes workspace-root scope to the executor and only writes root package.json + lock", async () => {
    const childManifest = ['{', '  "name": "@demo/app",', '  "version": "0.0.1"', "}", ""].join("\n");
    const writes: Array<{ path: string; content: string }> = [];
    const executorCalls: unknown[] = [];
    const plan = planPackageContribution({
      snapshot: snap({
        packageJson: ORDINARY_PKG,
        lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
      }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: ORDINARY_PKG, lockfile: PNPM_LOCK },
      executor: {
        async apply(request) {
          executorCalls.push(request);
          return { packageJson: request.packageJson, lockfile: "lock-after\n" };
        },
      },
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
    });
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      manager: "pnpm",
      executionScope: { kind: "pnpm-workspace-root" },
      ignoreScripts: true,
    });
    expect(writes.map((w) => w.path)).toEqual([PACKAGE_JSON_RELATIVE, "pnpm-lock.yaml"]);
    // Child manifests are never in the write set.
    expect(writes.some((w) => w.path.includes("packages/"))).toBe(false);
    expect(childManifest).toContain("@demo/app");
  });

  it("assertResolvedLocalCliExecutable fails closed when the root bin is missing", () => {
    expect(() =>
      assertResolvedLocalCliExecutable({ expectedVersion: "1.6.0", present: false }),
    ).toThrow(PoiesisError);
    try {
      assertResolvedLocalCliExecutable({ expectedVersion: "1.6.0", present: false });
    } catch (error) {
      expect((error as PoiesisError).code).toBe("PACKAGE_LOCAL_BIN_UNRESOLVED");
      expect((error as PoiesisError).details.path).toBe(LOCAL_CLI_BIN_RELATIVE);
    }
    expect(() =>
      assertResolvedLocalCliExecutable({
        expectedVersion: "1.6.0",
        present: true,
        versionProbe: { ok: true, stdout: "1.6.0\n" },
      }),
    ).not.toThrow();
  });

  it("runtime ready invokes executable assert when wired", async () => {
    let executableChecked = false;
    await assertPackageContributionRuntimeReady({
      record: buildPackageContributionRecord({
        manager: "pnpm",
        lockfile: "pnpm-lock.yaml",
        projectKind: "ordinary",
        scriptValue: "poiesis",
        devDependencyVersion: "1.6.0",
      }),
      poiesisVersion: "1.6.0",
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
      assertLocalCliExecutable: async () => {
        executableChecked = true;
        assertResolvedLocalCliExecutable({
          expectedVersion: "1.6.0",
          present: true,
          versionProbe: { ok: true, stdout: "1.6.0\n" },
        });
      },
    });
    expect(executableChecked).toBe(true);
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
  it("exports exact npm/pnpm add argv and post-edit lock reconcile install for remove-dev", () => {
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
    // remove-dev: package.json already lacks the owned dep; reconcile lock via install.
    expect(nativePackageManagerArgv("pnpm", { op: "remove-dev", name: "poiesis-cli" })).toEqual([
      "install",
      "--ignore-scripts",
    ]);
    expect(nativePackageManagerArgv("npm", { op: "remove-dev", name: "poiesis-cli" })).toEqual([
      "install",
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

  it("writeManifestWithPackageContributionGate apply: read→validate→write; mismatch/missing skip writer; writer error preserved", async () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: ORDINARY_SCRIPT_VALUE,
      devDependencyVersion: "1.6.0",
    });
    const matching = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");

    // Valid apply order: read → validate → write.
    const events: string[] = [];
    await writeManifestWithPackageContributionGate({
      check: { kind: "apply", record },
      readPackageJson: async () => {
        events.push("read");
        return matching;
      },
      writeManifest: async () => {
        events.push("write");
      },
    });
    expect(events).toEqual(["read", "write"]);

    // Script drift: writer never called.
    const scriptDrift: string[] = [];
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "apply", record },
        readPackageJson: async () => {
          scriptDrift.push("read");
          return matching.replace('"poiesis": "poiesis"', '"poiesis": "node dist/cli.js"');
        },
        writeManifest: async () => {
          scriptDrift.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_CONTRIBUTION_MISMATCH" });
    expect(scriptDrift).toEqual(["read"]);

    // DevDependency version drift: writer never called.
    const depDrift: string[] = [];
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "apply", record },
        readPackageJson: async () => {
          depDrift.push("read");
          return matching.replace('"poiesis-cli": "1.6.0"', '"poiesis-cli": "1.5.0"');
        },
        writeManifest: async () => {
          depDrift.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_CONTRIBUTION_MISMATCH" });
    expect(depDrift).toEqual(["read"]);

    // Foreign non-dev section: writer never called.
    const foreignNonDev = [
      "{",
      '  "name": "demo",',
      '  "scripts": { "poiesis": "poiesis" },',
      '  "dependencies": { "poiesis-cli": "1.6.0" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const foreign: string[] = [];
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "apply", record },
        readPackageJson: async () => {
          foreign.push("read");
          return foreignNonDev;
        },
        writeManifest: async () => {
          foreign.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_CONTRIBUTION_MISMATCH" });
    expect(foreign).toEqual(["read"]);

    // Missing package.json: writer never called.
    const missing: string[] = [];
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "apply", record },
        readPackageJson: async () => {
          missing.push("read");
          return null;
        },
        writeManifest: async () => {
          missing.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT", details: { path: PACKAGE_JSON_RELATIVE } });
    expect(missing).toEqual(["read"]);

    // Reader throw → drift, writer not called.
    const threw: string[] = [];
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "apply", record },
        readPackageJson: async () => {
          threw.push("read");
          throw new Error("EACCES");
        },
        writeManifest: async () => {
          threw.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });
    expect(threw).toEqual(["read"]);

    // Writer error propagates (outside read catch).
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "apply", record },
        readPackageJson: async () => matching,
        writeManifest: async () => {
          throw new Error("injected: manifest write failed");
        },
      }),
    ).rejects.toThrow("injected: manifest write failed");

    // Selfhost apply: matching script + no dependency.
    const selfhostRecord = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "selfhost",
      scriptValue: SELFHOST_SCRIPT_VALUE,
    });
    const selfhostOk = [
      "{",
      '  "name": "poiesis-cli",',
      '  "scripts": { "poiesis": "node dist/cli.js" }',
      "}",
      "",
    ].join("\n");
    const selfhostEvents: string[] = [];
    await writeManifestWithPackageContributionGate({
      check: { kind: "apply", record: selfhostRecord },
      readPackageJson: async () => {
        selfhostEvents.push("read");
        return selfhostOk;
      },
      writeManifest: async () => {
        selfhostEvents.push("write");
      },
    });
    expect(selfhostEvents).toEqual(["read", "write"]);

    // Selfhost with foreign dependency fails closed before writer.
    const selfhostWithDep = [
      "{",
      '  "name": "poiesis-cli",',
      '  "scripts": { "poiesis": "node dist/cli.js" },',
      '  "devDependencies": { "poiesis-cli": "1.6.0" }',
      "}",
      "",
    ].join("\n");
    const selfhostBad: string[] = [];
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "apply", record: selfhostRecord },
        readPackageJson: async () => {
          selfhostBad.push("read");
          return selfhostWithDep;
        },
        writeManifest: async () => {
          selfhostBad.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_SELF_DEPENDENCY" });
    expect(selfhostBad).toEqual(["read"]);

    // Noop path through unified gate preserves original-snapshot hash assertion.
    const noopPlan = planPackageContribution({
      snapshot: snap({ packageJson: matching, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(packagePlanIsNoopWithPreimage(noopPlan)).toBe(true);
    if (!packagePlanIsNoopWithPreimage(noopPlan)) throw new Error("expected noop");
    const noopEvents: string[] = [];
    await writeManifestWithPackageContributionGate({
      check: { kind: "noop", plan: noopPlan },
      readPackageJson: async () => {
        noopEvents.push("read");
        return matching;
      },
      writeManifest: async () => {
        noopEvents.push("write");
      },
    });
    expect(noopEvents).toEqual(["read", "write"]);
    const noopDrift: string[] = [];
    await expect(
      writeManifestWithPackageContributionGate({
        check: { kind: "noop", plan: noopPlan },
        readPackageJson: async () => {
          noopDrift.push("read");
          return matching.replace('"name": "demo"', '"name": "hijacked"');
        },
        writeManifest: async () => {
          noopDrift.push("write");
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });
    expect(noopDrift).toEqual(["read"]);
  });

  it("production callers wire writeManifestWithPackageContributionGate at publication boundary for apply and noop", async () => {
    const root = join(import.meta.dirname, "..");
    const maintenance = await readFile(join(root, "src/maintenance.ts"), "utf8");
    const updateInternal = await readFile(join(root, "src/update-internal.ts"), "utf8");
    const updateConfig = await readFile(join(root, "src/update-config-internal.ts"), "utf8");
    // Four production call sites: init, ordinary update, bootstrap update, update-config.
    expect(maintenance).toContain("writeManifestWithPackageContributionGate");
    expect(updateConfig).toContain("writeManifestWithPackageContributionGate");
    // Ordinary update + bootstrap both publish through the helper (import once + two call sites).
    expect(updateInternal.match(/writeManifestWithPackageContributionGate/g)?.length).toBe(3);
    expect((updateInternal.match(/await writeManifestWithPackageContributionGate\(/g) ?? []).length).toBe(2);
    expect((maintenance.match(/await writeManifestWithPackageContributionGate\(/g) ?? []).length).toBe(1);
    expect((updateConfig.match(/await writeManifestWithPackageContributionGate\(/g) ?? []).length).toBe(1);
    // Gate when package plan retains contribution (apply or hashed noop); absent writes direct.
    expect(updateInternal).toContain("packagePlanRetainsContribution(packagePlan)");
    expect(maintenance).toContain("packagePlanRetainsContribution(packagePlan)");
    expect(updateConfig).toContain("packagePlanRetainsContribution(packagePlan)");
    // No apply bypass: retain gate must not be noop-only.
    expect(updateInternal).not.toMatch(
      /if\s*\(\s*packagePlanIsNoopWithPreimage\s*\(\s*packagePlan\s*\)\s*\)\s*\{\s*\n\s*await writeManifestWith/,
    );
    expect(maintenance).not.toMatch(
      /if\s*\(\s*packagePlanIsNoopWithPreimage\s*\(\s*packagePlan\s*\)\s*\)\s*\{\s*\n\s*await writeManifestWith/,
    );
    expect(updateConfig).not.toMatch(
      /if\s*\(\s*packagePlanIsNoopWithPreimage\s*\(\s*packagePlan\s*\)\s*\)\s*\{\s*\n\s*await writeManifestWith/,
    );
    // Apply branch must pass applied/next record into the gate (not skip it).
    expect(updateInternal).toMatch(/kind:\s*"apply"/);
    expect(maintenance).toMatch(/kind:\s*"apply"/);
    expect(updateConfig).toMatch(/kind:\s*"apply"/);
  });
});

describe("update-config early config-noop package gate (ticket #218)", () => {
  const ownedOrdinary = [
    "{",
    '  "name": "demo",',
    '  "scripts": { "poiesis": "poiesis", "build": "tsc" },',
    '  "devDependencies": { "poiesis-cli": "1.6.0", "typescript": "^5.0.0" }',
    "}",
    "",
  ].join("\n");

  const ownedSelfhost = [
    "{",
    '  "name": "poiesis-cli",',
    '  "version": "1.6.0",',
    '  "scripts": { "poiesis": "node dist/cli.js", "build": "tsup" }',
    "}",
    "",
  ].join("\n");

  function ordinaryNoopPlan() {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ownedOrdinary, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("noop");
    if (plan.kind !== "noop") throw new Error("expected ordinary hashed noop");
    expect(plan.expectedPackageJsonPreimageHash).toBe(hashContent(ownedOrdinary));
    return plan;
  }

  function selfhostNoopPlan() {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ownedSelfhost, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("noop");
    if (plan.kind !== "noop") throw new Error("expected selfhost hashed noop");
    return plan;
  }

  function applyPlan() {
    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") throw new Error("expected apply");
    return plan;
  }

  it("apply returns continue-transaction without reading package.json or readiness", async () => {
    const events: string[] = [];
    const result = await gateUpdateConfigEarlyNoopPackage({
      packagePlan: applyPlan(),
      readPackageJson: async () => {
        events.push("read");
        return ownedOrdinary;
      },
      assertRuntimeReady: async () => {
        events.push("ready");
      },
    });
    expect(result).toEqual({ decision: "continue-transaction" });
    expect(events).toEqual([]);
  });

  it("absent allows early-return without package read or readiness", async () => {
    const events: string[] = [];
    const result = await gateUpdateConfigEarlyNoopPackage({
      packagePlan: { kind: "absent" },
      readPackageJson: async () => {
        events.push("read");
        return null;
      },
      assertRuntimeReady: async () => {
        events.push("ready");
      },
    });
    expect(result).toEqual({ decision: "allow-early-return" });
    expect(events).toEqual([]);
  });

  it("hashed noop with matching fresh read and readiness allows early-return", async () => {
    const plan = ordinaryNoopPlan();
    const events: string[] = [];
    const result = await gateUpdateConfigEarlyNoopPackage({
      packagePlan: plan,
      readPackageJson: async () => {
        events.push("read");
        return ownedOrdinary;
      },
      assertRuntimeReady: async (record) => {
        events.push("ready");
        expect(record.devDependencyVersion).toBe("1.6.0");
        expect(record.projectKind).toBe("ordinary");
      },
    });
    expect(result).toEqual({ decision: "allow-early-return" });
    expect(events).toEqual(["read", "ready"]);
  });

  it("hashed noop rejects drifted package.json and never calls readiness", async () => {
    const plan = ordinaryNoopPlan();
    const events: string[] = [];
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => {
          events.push("read");
          return ownedOrdinary.replace('"name": "demo"', '"name": "author-edit"');
        },
        assertRuntimeReady: async () => {
          events.push("ready");
        },
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_IDENTITY_DRIFT",
      details: { path: PACKAGE_JSON_RELATIVE },
    });
    expect(events).toEqual(["read"]);
  });

  it("hashed noop rejects missing package.json and never calls readiness", async () => {
    const plan = ordinaryNoopPlan();
    const events: string[] = [];
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => {
          events.push("read");
          return null;
        },
        assertRuntimeReady: async () => {
          events.push("ready");
        },
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_IDENTITY_DRIFT",
      details: { path: PACKAGE_JSON_RELATIVE },
    });
    expect(events).toEqual(["read"]);
  });

  it("hashed noop rejects read errors as identity drift and never calls readiness", async () => {
    const plan = ordinaryNoopPlan();
    const events: string[] = [];
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => {
          events.push("read");
          throw new Error("EIO simulated");
        },
        assertRuntimeReady: async () => {
          events.push("ready");
        },
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_IDENTITY_DRIFT",
      details: { path: PACKAGE_JSON_RELATIVE },
    });
    expect(events).toEqual(["read"]);
  });

  it("hashed noop propagates ordinary readiness failure and is not successful", async () => {
    const plan = ordinaryNoopPlan();
    const events: string[] = [];
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => {
          events.push("read");
          return ownedOrdinary;
        },
        assertRuntimeReady: async (record) => {
          events.push("ready");
          await assertPackageContributionRuntimeReady({
            record,
            poiesisVersion: "1.6.0",
            readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.5.0" }),
          });
        },
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_LOCAL_BIN_VERSION_MISMATCH",
      details: { expectedVersion: "1.6.0", actualVersion: "1.5.0" },
    });
    expect(events).toEqual(["read", "ready"]);
  });

  it("hashed noop propagates missing ordinary resolved bin as not successful", async () => {
    const plan = ordinaryNoopPlan();
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => ownedOrdinary,
        assertRuntimeReady: async (record) => {
          await assertPackageContributionRuntimeReady({
            record,
            poiesisVersion: "1.6.0",
            readResolvedLocalPackageJson: async () => null,
          });
        },
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_LOCAL_BIN_UNRESOLVED" });
  });

  it("hashed selfhost noop succeeds only after matching dist probe; wrong probe rejects", async () => {
    const plan = selfhostNoopPlan();
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => ownedSelfhost,
        assertRuntimeReady: async (record) => {
          await assertPackageContributionRuntimeReady({
            record,
            poiesisVersion: "1.6.0",
            probeSelfhostDist: async () => ({ ok: true, stdout: "1.6.0\n" }),
          });
        },
      }),
    ).resolves.toEqual({ decision: "allow-early-return" });

    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => ownedSelfhost,
        assertRuntimeReady: async (record) => {
          await assertPackageContributionRuntimeReady({
            record,
            poiesisVersion: "1.6.0",
            probeSelfhostDist: async () => ({ ok: true, stdout: "1.5.0\n" }),
          });
        },
      }),
    ).rejects.toMatchObject({
      code: "SELFHOST_DIST_VERSION_MISMATCH",
    });

    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => ownedSelfhost,
        assertRuntimeReady: async (record) => {
          await assertPackageContributionRuntimeReady({
            record,
            poiesisVersion: "1.6.0",
            probeSelfhostDist: async () => ({ ok: false, code: "missing" }),
          });
        },
      }),
    ).rejects.toMatchObject({ code: "SELFHOST_DIST_MISSING" });
  });

  it("version-cross apply (package target not yet next runtime) continues transaction", async () => {
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
    const { plan } = planPackageContributionForVersionCross({
      snapshot: snap({ packageJson: current, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      nextPoiesisVersion: "1.6.0",
      prior,
    });
    expect(plan.kind).toBe("apply");
    const events: string[] = [];
    const result = await gateUpdateConfigEarlyNoopPackage({
      packagePlan: plan,
      readPackageJson: async () => {
        events.push("read");
        return current;
      },
      assertRuntimeReady: async () => {
        events.push("ready");
      },
    });
    expect(result).toEqual({ decision: "continue-transaction" });
    expect(events).toEqual([]);
  });

  it("version-cross hashed noop only when package target already matches next runtime", async () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const { plan } = planPackageContributionForVersionCross({
      snapshot: snap({ packageJson: ownedOrdinary, lockfiles: { "pnpm-lock.yaml": "lock\n" } }),
      nextPoiesisVersion: "1.6.0",
      prior,
    });
    expect(plan.kind).toBe("noop");
    const result = await gateUpdateConfigEarlyNoopPackage({
      packagePlan: plan,
      readPackageJson: async () => ownedOrdinary,
      assertRuntimeReady: async () => undefined,
    });
    expect(result).toEqual({ decision: "allow-early-return" });
  });

  it("production update-config early branch wires the gate before doctor", async () => {
    const root = join(import.meta.dirname, "..");
    const updateConfig = await readFile(join(root, "src/update-config-internal.ts"), "utf8");
    expect(updateConfig).toContain("gateUpdateConfigEarlyNoopPackage");
    // Gate runs inside the config-byte no-op branch, before preNoopDoctor/doctor.
    const noopBranch = updateConfig.slice(
      updateConfig.indexOf("if (poiesisConfigBytesMatch && openCodeBytesMatch && !transitionRequested)"),
      updateConfig.indexOf("// 8. Validate the projected"),
    );
    expect(noopBranch).toContain("gateUpdateConfigEarlyNoopPackage");
    expect(noopBranch).toContain('decision === "allow-early-return"');
    expect(noopBranch).toContain("preNoopDoctor");
    expect(noopBranch.indexOf("gateUpdateConfigEarlyNoopPackage")).toBeLessThan(
      noopBranch.indexOf("preNoopDoctor"),
    );
    // Apply must not early-return: continue falls through out of the branch.
    expect(noopBranch).toMatch(/continue-transaction|decision !== "allow-early-return"|decision === "continue-transaction"/);
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

describe("real pnpm workspace-root install (Spec #219 / ticket #220)", () => {
  const ownedRoots: string[] = [];
  afterAll(async () => {
    for (const root of ownedRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "installs exact root contribution under isolated linker without touching child manifests",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "poiesis-pnpm-ws-220-"));
      ownedRoots.push(root);
      const childDir = join(root, "packages", "app");
      await mkdir(childDir, { recursive: true });

      const rootPkg = [
        "{",
        '  "name": "ws-root-demo",',
        '  "private": true,',
        '  "version": "0.0.0"',
        "}",
        "",
      ].join("\n");
      const childPkg = [
        "{",
        '  "name": "@ws/app",',
        '  "version": "0.0.1",',
        '  "private": true',
        "}",
        "",
      ].join("\n");
      const workspaceYaml = "packages:\n  - 'packages/*'\n";
      // Default isolated linker; do not enable hoisting.
      const npmrc = "node-linker=isolated\n";

      await writeFileUtf8(join(root, "package.json"), rootPkg, "utf8");
      await writeFileUtf8(join(root, "pnpm-workspace.yaml"), workspaceYaml, "utf8");
      await writeFileUtf8(join(root, ".npmrc"), npmrc, "utf8");
      await writeFileUtf8(join(childDir, "package.json"), childPkg, "utf8");

      // Seed a real root lockfile via pnpm so eligibility sees sole pnpm-lock.yaml.
      const { run } = await import("../src/process.js");
      await run("pnpm", ["install", "--ignore-scripts"], { cwd: root });
      const lockBefore = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
      expect(lockBefore.length).toBeGreaterThan(0);

      const childBefore = await readFile(join(childDir, "package.json"), "utf8");
      const targetVersion = "1.7.0";
      const plan = planPackageContribution({
        snapshot: snap({
          packageJson: rootPkg,
          lockfiles: {
            "pnpm-lock.yaml": lockBefore,
            "pnpm-workspace.yaml": workspaceYaml,
          },
          npmrc,
        }),
        poiesisVersion: targetVersion,
        mode: "ensure",
      });
      expect(plan.kind).toBe("apply");
      if (plan.kind !== "apply") throw new Error("expected apply");
      expect(plan.executionScope).toEqual({ kind: "pnpm-workspace-root" });
      expect(
        nativePackageManagerArgv("pnpm", plan.lockfileOperation!, plan.executionScope),
      ).toEqual(["add", "-w", "-D", "-E", `poiesis-cli@${targetVersion}`, "--ignore-scripts"]);

      const executor = createNativePackageManagerExecutor(root);
      const result = await applyPackageContributionPlan({
        plan,
        preimage: { packageJson: rootPkg, lockfile: lockBefore },
        executor,
        writeFile: async (relative, content) => {
          // Only root package.json + root lock — never child paths.
          expect(relative === PACKAGE_JSON_RELATIVE || relative === "pnpm-lock.yaml").toBe(true);
          await writeFileUtf8(join(root, relative), content, "utf8");
        },
        readResolvedLocalPackageJson: async () => {
          try {
            return await readFile(join(root, LOCAL_CLI_PACKAGE_JSON_RELATIVE), "utf8");
          } catch {
            return null;
          }
        },
        assertLocalCliExecutable: () =>
          assertLocalCliExecutableAtRoot({
            root,
            expectedVersion: targetVersion,
            run,
          }),
      });

      expect(result.record.devDependencyVersion).toBe(targetVersion);
      expect(result.record.scriptValue).toBe("poiesis");
      // Durable schema still has no workspace field.
      expect("executionScope" in result.record).toBe(false);

      const rootAfter = parsePkg(await readFile(join(root, PACKAGE_JSON_RELATIVE), "utf8"));
      expect(rootAfter.scripts?.poiesis).toBe("poiesis");
      expect(rootAfter.devDependencies?.["poiesis-cli"]).toBe(targetVersion);

      const childAfter = await readFile(join(childDir, "package.json"), "utf8");
      expect(childAfter).toBe(childBefore);
      expect(childAfter).toBe(childPkg);

      // Isolated linker: package identity + usable root bin.
      const installedPkg = JSON.parse(await readFile(join(root, LOCAL_CLI_PACKAGE_JSON_RELATIVE), "utf8")) as {
        version: string;
      };
      expect(installedPkg.version).toBe(targetVersion);
      await assertLocalCliExecutableAtRoot({ root, expectedVersion: targetVersion, run });

      // Root invocation: package script value is `poiesis`, resolved via PATH to
      // the root-local .bin shim under the isolated linker (same as `pnpm run`).
      const scriptRun = await run("pnpm", ["exec", "poiesis", "--version"], {
        cwd: root,
        allowFailure: true,
      });
      expect(
        scriptRun.exitCode,
        `pnpm exec poiesis --version failed: stdout=${scriptRun.stdout} stderr=${scriptRun.stderr}`,
      ).toBe(0);
      expect(scriptRun.stdout.trim().split(/\r?\n/)[0]?.trim()).toBe(targetVersion);
    },
    120_000,
  );
});

/**
 * Spec #219 / ticket #221 — lifecycle surfaces (version-cross update --config,
 * config-byte no-op readiness, removal) reuse ticket #220 eligibility and
 * explicit workspace-root execution scope. Child manifests including foreign
 * child Poiesis declarations stay byte-identical; drift and native failures
 * fail closed without claiming node_modules rollback.
 */
describe("pnpm workspace-root lifecycle (Spec #219 / ticket #221)", () => {
  const PNPM_WS = "packages:\n  - 'packages/*'\n";
  const PNPM_LOCK = "lockfileVersion: '9.0'\n";

  const ownedRootPkg = (version: string) =>
    [
      "{",
      '  "name": "ws-root-demo",',
      '  "private": true,',
      '  "version": "0.0.0",',
      '  "scripts": { "poiesis": "poiesis" },',
      `  "devDependencies": { "poiesis-cli": "${version}" }`,
      "}",
      "",
    ].join("\n");

  const foreignChildPkg = [
    "{",
    '  "name": "@ws/app",',
    '  "version": "0.0.1",',
    '  "private": true,',
    '  "scripts": { "poiesis": "echo child-foreign" },',
    '  "devDependencies": { "poiesis-cli": "1.5.0" }',
    "}",
    "",
  ].join("\n");

  const wsSnap = (packageJson: string, lock = PNPM_LOCK) =>
    snap({
      packageJson,
      lockfiles: { "pnpm-lock.yaml": lock, "pnpm-workspace.yaml": PNPM_WS },
    });

  it("version-cross update planning reuses workspace-root eligibility and explicit scope", () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const { plan, contributionForProjection } = planPackageContributionForVersionCross({
      snapshot: wsSnap(ownedRootPkg("1.6.0")),
      nextPoiesisVersion: "1.7.0",
      prior,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") throw new Error("expected apply");
    expect(plan.executionScope).toEqual({ kind: "pnpm-workspace-root" });
    expect(plan.lockfileOperation).toEqual({
      op: "add-dev",
      name: "poiesis-cli",
      version: "1.7.0",
    });
    expect(
      nativePackageManagerArgv("pnpm", plan.lockfileOperation!, plan.executionScope),
    ).toEqual(["add", "-w", "-D", "-E", "poiesis-cli@1.7.0", "--ignore-scripts"]);
    expect(contributionForProjection?.devDependencyVersion).toBe("1.7.0");
    // Durable schema stays root-relative — no executionScope field.
    expect("executionScope" in (contributionForProjection ?? {})).toBe(false);
    expect(parsePkg(plan.nextPackageJson).devDependencies?.["poiesis-cli"]).toBe("1.7.0");
  });

  it("version-cross fails closed on workspace scope drift (shared lock disabled)", () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    expect(() =>
      planPackageContributionForVersionCross({
        snapshot: snap({
          packageJson: ownedRootPkg("1.6.0"),
          lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
          npmrc: "shared-workspace-lockfile=false\n",
        }),
        nextPoiesisVersion: "1.7.0",
        prior,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PACKAGE_WORKSPACE_UNSUPPORTED",
      }),
    );
  });

  it("version-cross fails closed on outer/non-root effective workspace scope", () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    expect(() =>
      planPackageContributionForVersionCross({
        snapshot: snap({
          packageJson: ownedRootPkg("1.6.0"),
          lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
          outerPnpmWorkspace: true,
        }),
        nextPoiesisVersion: "1.7.0",
        prior,
      }),
    ).toThrow(expect.objectContaining({ code: "PACKAGE_WORKSPACE_UNSUPPORTED" }));
  });

  it("removal plans explicit workspace-root -w and only mutates authenticated root contributions", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.7.0",
    });
    const plan = planPackageContributionRemoval({
      snapshot: wsSnap(ownedRootPkg("1.7.0")),
      record,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") throw new Error("expected apply");
    expect(plan.executionScope).toEqual({ kind: "pnpm-workspace-root" });
    expect(plan.lockfileOperation).toEqual({ op: "remove-dev", name: "poiesis-cli" });
    expect(
      nativePackageManagerArgv("pnpm", plan.lockfileOperation!, plan.executionScope),
    ).toEqual(["install", "-w", "--ignore-scripts"]);
    const next = parsePkg(plan.nextPackageJson);
    expect(next.scripts?.poiesis).toBeUndefined();
    expect(next.devDependencies?.["poiesis-cli"]).toBeUndefined();
    // Child foreign declarations are never part of the root plan.
    expect(JSON.stringify(plan)).not.toContain("child-foreign");
    expect(JSON.stringify(plan)).not.toContain("@ws/app");
  });

  it("removal fails closed when workspace eligibility drifts after install", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.7.0",
    });
    expect(() =>
      planPackageContributionRemoval({
        snapshot: snap({
          packageJson: ownedRootPkg("1.7.0"),
          lockfiles: { "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": PNPM_WS },
          npmrc: "shared-workspace-lockfile=false\n",
        }),
        record,
      }),
    ).toThrow(expect.objectContaining({ code: "PACKAGE_WORKSPACE_UNSUPPORTED" }));
  });

  it("version-cross apply writes only root package.json + lock; child foreign Poiesis stays untouched", async () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const rootBefore = ownedRootPkg("1.6.0");
    const childBefore = foreignChildPkg;
    const { plan } = planPackageContributionForVersionCross({
      snapshot: wsSnap(rootBefore),
      nextPoiesisVersion: "1.7.0",
      prior,
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    const writes: Array<{ path: string; content: string }> = [];
    const executorCalls: unknown[] = [];
    await applyPackageContributionPlan({
      plan,
      preimage: { packageJson: rootBefore, lockfile: PNPM_LOCK },
      executor: {
        async apply(request) {
          executorCalls.push(request);
          return { packageJson: request.packageJson, lockfile: "lock-after-cross\n" };
        },
      },
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
      readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.7.0" }),
      assertLocalCliExecutable: async () => undefined,
    });
    expect(executorCalls).toEqual([
      expect.objectContaining({
        manager: "pnpm",
        executionScope: { kind: "pnpm-workspace-root" },
        ignoreScripts: true,
        operation: { op: "add-dev", name: "poiesis-cli", version: "1.7.0" },
      }),
    ]);
    expect(writes.map((w) => w.path)).toEqual([PACKAGE_JSON_RELATIVE, "pnpm-lock.yaml"]);
    expect(writes.some((w) => w.path.includes("packages/") || w.path.includes("@ws"))).toBe(false);
    expect(childBefore).toBe(foreignChildPkg);
    expect(parsePkg(writes[0]!.content).devDependencies?.["poiesis-cli"]).toBe("1.7.0");
  });

  it("removal apply path (uninstall-shaped) uses workspace-root scope and never writes child paths", async () => {
    // Uninstall does not route removal through applyPackageContributionPlan
    // (post-remove package.json no longer matches the ownership record). It
    // writes planned root package.json, then native remove with plan.executionScope.
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.7.0",
    });
    const rootBefore = ownedRootPkg("1.7.0");
    const childBefore = foreignChildPkg;
    const plan = planPackageContributionRemoval({
      snapshot: wsSnap(rootBefore),
      record,
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    expect(plan.packageJsonChanged).toBe(true);
    expect(plan.lockfileOperation).toEqual({ op: "remove-dev", name: "poiesis-cli" });

    const writes: Array<{ path: string; content: string }> = [];
    // Root package.json replace (journal.replace equivalent).
    writes.push({ path: PACKAGE_JSON_RELATIVE, content: plan.nextPackageJson });
    const executor: PackageManagerExecutor = {
      async apply(request) {
        expect(request.executionScope).toEqual({ kind: "pnpm-workspace-root" });
        expect(request.operation).toEqual({ op: "remove-dev", name: "poiesis-cli" });
        expect(request.ignoreScripts).toBe(true);
        expect(
          nativePackageManagerArgv("pnpm", request.operation, request.executionScope),
        ).toEqual(["install", "-w", "--ignore-scripts"]);
        writes.push({ path: "pnpm-lock.yaml", content: "lock-after-remove\n" });
        return { packageJson: request.packageJson, lockfile: "lock-after-remove\n" };
      },
    };
    await executor.apply({
      manager: plan.record.manager,
      operation: plan.lockfileOperation!,
      packageJson: plan.nextPackageJson,
      lockfile: PNPM_LOCK,
      ignoreScripts: true,
      executionScope: plan.executionScope,
    });
    expect(writes.map((w) => w.path)).toEqual([PACKAGE_JSON_RELATIVE, "pnpm-lock.yaml"]);
    expect(writes.some((w) => w.path.includes("packages/"))).toBe(false);
    expect(childBefore).toBe(foreignChildPkg);
    const next = parsePkg(writes[0]!.content);
    expect(next.scripts?.poiesis).toBeUndefined();
    expect(next.devDependencies?.["poiesis-cli"]).toBeUndefined();
  });

  it("workspace version-cross native failure is PACKAGE_MANAGER_INCOMPLETE with -w argv and no node_modules rollback claim", async () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const rootBefore = ownedRootPkg("1.6.0");
    const { plan } = planPackageContributionForVersionCross({
      snapshot: wsSnap(rootBefore),
      nextPoiesisVersion: "1.7.0",
      prior,
    });
    if (plan.kind !== "apply") throw new Error("expected apply");
    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: rootBefore, lockfile: PNPM_LOCK },
        executor: {
          async apply() {
            throw new PoiesisError("PACKAGE_MANAGER_FAILED", "injected workspace native failure", {
              manager: "pnpm",
            });
          },
        },
        writeFile: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_MANAGER_INCOMPLETE",
      details: {
        ownedArtifactsMayRollback: true,
        nativeSideEffectsNotClaimedRolledBack: true,
        executionScope: { kind: "pnpm-workspace-root" },
        argv: ["add", "-w", "-D", "-E", "poiesis-cli@1.7.0", "--ignore-scripts"],
      },
    });
  });

  it("workspace removal native failure surfaces uninstall incomplete contract (no node_modules rollback claim)", async () => {
    // Mirrors maintenance.uninstall catch: PACKAGE_MANAGER_INCOMPLETE with
    // executionScope + nativeSideEffectsNotClaimedRolledBack; partial uninstall
    // retains packageContribution authority (tested via message/details contract).
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.7.0",
    });
    const rootBefore = ownedRootPkg("1.7.0");
    const plan = planPackageContributionRemoval({
      snapshot: wsSnap(rootBefore),
      record,
    });
    if (plan.kind !== "apply" || plan.lockfileOperation === null) throw new Error("expected remove op");
    const executor: PackageManagerExecutor = {
      async apply() {
        throw new Error("pnpm remove -w failed");
      },
    };
    await expect(
      executor.apply({
        manager: plan.record.manager,
        operation: plan.lockfileOperation,
        packageJson: plan.nextPackageJson,
        lockfile: PNPM_LOCK,
        ignoreScripts: true,
        executionScope: plan.executionScope,
      }),
    ).rejects.toThrow(/pnpm remove -w failed/);
    // Uninstall wraps this as PACKAGE_MANAGER_INCOMPLETE with the same scope + flags.
    const wrapped = new PoiesisError(
      "PACKAGE_MANAGER_INCOMPLETE",
      "Native package-manager remove failed during uninstall; owned package.json bytes may be journal-restored; node_modules and other native pm side effects are not claimed rolled back.",
      {
        manager: plan.record.manager,
        operation: plan.lockfileOperation,
        executionScope: plan.executionScope,
        ownedArtifactsMayRollback: true,
        nativeSideEffectsNotClaimedRolledBack: true,
        cause: "pnpm remove -w failed",
      },
    );
    expect(wrapped.code).toBe("PACKAGE_MANAGER_INCOMPLETE");
    expect(wrapped.details).toMatchObject({
      executionScope: { kind: "pnpm-workspace-root" },
      ownedArtifactsMayRollback: true,
      nativeSideEffectsNotClaimedRolledBack: true,
    });
    expect(wrapped.message).toMatch(/not claimed rolled back/i);
    // Partial uninstall retains unresolved packageContribution when removal fails.
    expect(plan.record.devDependencyVersion).toBe("1.7.0");
  });

  it("config-byte hashed noop revalidates root package identity and executable readiness under workspace plan", async () => {
    const rootOwned = ownedRootPkg("1.7.0");
    const plan = planPackageContribution({
      snapshot: wsSnap(rootOwned),
      poiesisVersion: "1.7.0",
      mode: "ensure",
    });
    expect(plan.kind).toBe("noop");
    expect(packagePlanIsNoopWithPreimage(plan)).toBe(true);
    if (!packagePlanIsNoopWithPreimage(plan)) throw new Error("expected hashed noop");
    expect(plan.executionScope).toEqual({ kind: "pnpm-workspace-root" });

    let readinessCalls = 0;
    const allow = await gateUpdateConfigEarlyNoopPackage({
      packagePlan: plan,
      readPackageJson: async () => rootOwned,
      assertRuntimeReady: async () => {
        readinessCalls += 1;
        await assertPackageContributionRuntimeReady({
          record: plan.record,
          poiesisVersion: "1.7.0",
          readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.7.0" }),
          assertLocalCliExecutable: async () => {
            assertResolvedLocalCliExecutable({
              expectedVersion: "1.7.0",
              present: true,
              versionProbe: { ok: true, stdout: "1.7.0\n" },
            });
          },
        });
      },
    });
    expect(allow).toEqual({ decision: "allow-early-return" });
    expect(readinessCalls).toBe(1);

    // Identity drift fails closed before readiness / early return.
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => rootOwned.replace('"name": "ws-root-demo"', '"name": "drifted"'),
        assertRuntimeReady: async () => {
          throw new Error("readiness must not run after identity drift");
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_DRIFT" });

    // Executable absence fails closed under readiness.
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => rootOwned,
        assertRuntimeReady: async () => {
          await assertPackageContributionRuntimeReady({
            record: plan.record,
            poiesisVersion: "1.7.0",
            readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.7.0" }),
            assertLocalCliExecutable: async () => {
              assertResolvedLocalCliExecutable({ expectedVersion: "1.7.0", present: false });
            },
          });
        },
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_LOCAL_BIN_UNRESOLVED" });

    // Runtime version mismatch fails closed.
    await expect(
      gateUpdateConfigEarlyNoopPackage({
        packagePlan: plan,
        readPackageJson: async () => rootOwned,
        assertRuntimeReady: async () => {
          await assertPackageContributionRuntimeReady({
            record: plan.record,
            poiesisVersion: "1.7.0",
            readResolvedLocalPackageJson: async () => JSON.stringify({ version: "1.6.0" }),
          });
        },
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_LOCAL_BIN_VERSION_MISMATCH" });
  });

  it("version-cross apply (package target not yet next runtime) continues past config-byte no-op gate", async () => {
    const prior = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.6.0",
    });
    const { plan } = planPackageContributionForVersionCross({
      snapshot: wsSnap(ownedRootPkg("1.6.0")),
      nextPoiesisVersion: "1.7.0",
      prior,
    });
    expect(plan.kind).toBe("apply");
    const decision = await gateUpdateConfigEarlyNoopPackage({
      packagePlan: plan,
      readPackageJson: async () => ownedRootPkg("1.6.0"),
      assertRuntimeReady: async () => {
        throw new Error("apply must continue-transaction without readiness");
      },
    });
    expect(decision).toEqual({ decision: "continue-transaction" });
  });

  it("capture identity drift on workspace removal plan fails closed before native pm", () => {
    const record = buildPackageContributionRecord({
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      projectKind: "ordinary",
      scriptValue: "poiesis",
      devDependencyVersion: "1.7.0",
    });
    const planned = ownedRootPkg("1.7.0");
    const plan = planPackageContributionRemoval({
      snapshot: wsSnap(planned),
      record,
    });
    expect(packagePlanRetainsContribution(plan)).toBe(true);
    if (!packagePlanRetainsContribution(plan)) throw new Error("expected retainable removal");
    const drifted = planned.replace('"name": "ws-root-demo"', '"name": "author-edit"');
    expect(() =>
      assertPackageContributionCaptureIdentity(plan, { packageJsonContent: drifted }),
    ).toThrow(expect.objectContaining({ code: "ARTIFACT_IDENTITY_DRIFT" }));
  });
});

describe("real pnpm workspace-root update + uninstall lifecycle (Spec #219 / ticket #221)", () => {
  const ownedRoots: string[] = [];
  afterAll(async () => {
    for (const root of ownedRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "version-cross then removal keep child foreign Poiesis declarations byte-identical",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "poiesis-pnpm-ws-221-"));
      ownedRoots.push(root);
      const childDir = join(root, "packages", "app");
      await mkdir(childDir, { recursive: true });

      const rootSeed = [
        "{",
        '  "name": "ws-root-demo",',
        '  "private": true,',
        '  "version": "0.0.0"',
        "}",
        "",
      ].join("\n");
      // Foreign child Poiesis declarations must survive root lifecycle untouched.
      const childPkg = [
        "{",
        '  "name": "@ws/app",',
        '  "version": "0.0.1",',
        '  "private": true,',
        '  "scripts": { "poiesis": "echo child-foreign" },',
        '  "devDependencies": { "poiesis-cli": "1.5.0" }',
        "}",
        "",
      ].join("\n");
      const workspaceYaml = "packages:\n  - 'packages/*'\n";
      const npmrc = "node-linker=isolated\n";

      await writeFileUtf8(join(root, "package.json"), rootSeed, "utf8");
      await writeFileUtf8(join(root, "pnpm-workspace.yaml"), workspaceYaml, "utf8");
      await writeFileUtf8(join(root, ".npmrc"), npmrc, "utf8");
      await writeFileUtf8(join(childDir, "package.json"), childPkg, "utf8");

      const { run } = await import("../src/process.js");
      await run("pnpm", ["install", "--ignore-scripts"], { cwd: root });
      const lockSeed = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
      const childBefore = await readFile(join(childDir, "package.json"), "utf8");
      expect(childBefore).toBe(childPkg);

      const vFrom = "1.6.0";
      const vTo = "1.7.0";

      // 1) Install root contribution at vFrom.
      const installPlan = planPackageContribution({
        snapshot: snap({
          packageJson: rootSeed,
          lockfiles: { "pnpm-lock.yaml": lockSeed, "pnpm-workspace.yaml": workspaceYaml },
          npmrc,
        }),
        poiesisVersion: vFrom,
        mode: "ensure",
      });
      expect(installPlan.kind).toBe("apply");
      if (installPlan.kind !== "apply") throw new Error("expected install apply");
      expect(installPlan.executionScope).toEqual({ kind: "pnpm-workspace-root" });

      const executor = createNativePackageManagerExecutor(root);
      const installResult = await applyPackageContributionPlan({
        plan: installPlan,
        preimage: { packageJson: rootSeed, lockfile: lockSeed },
        executor,
        writeFile: async (relative, content) => {
          expect(relative === PACKAGE_JSON_RELATIVE || relative === "pnpm-lock.yaml").toBe(true);
          await writeFileUtf8(join(root, relative), content, "utf8");
        },
        readResolvedLocalPackageJson: async () => {
          try {
            return await readFile(join(root, LOCAL_CLI_PACKAGE_JSON_RELATIVE), "utf8");
          } catch {
            return null;
          }
        },
        assertLocalCliExecutable: () =>
          assertLocalCliExecutableAtRoot({ root, expectedVersion: vFrom, run }),
      });
      expect(installResult.record.devDependencyVersion).toBe(vFrom);
      expect(await readFile(join(childDir, "package.json"), "utf8")).toBe(childBefore);

      const rootAfterInstall = await readFile(join(root, PACKAGE_JSON_RELATIVE), "utf8");
      const lockAfterInstall = await readFile(join(root, "pnpm-lock.yaml"), "utf8");

      // 2) Version-cross to vTo (update / update --config package seam).
      const prior = installResult.record;
      const cross = planPackageContributionForVersionCross({
        snapshot: snap({
          packageJson: rootAfterInstall,
          lockfiles: { "pnpm-lock.yaml": lockAfterInstall, "pnpm-workspace.yaml": workspaceYaml },
          npmrc,
        }),
        nextPoiesisVersion: vTo,
        prior,
      });
      expect(cross.plan.kind).toBe("apply");
      if (cross.plan.kind !== "apply") throw new Error("expected cross apply");
      expect(cross.plan.executionScope).toEqual({ kind: "pnpm-workspace-root" });
      expect(
        nativePackageManagerArgv("pnpm", cross.plan.lockfileOperation!, cross.plan.executionScope),
      ).toEqual(["add", "-w", "-D", "-E", `poiesis-cli@${vTo}`, "--ignore-scripts"]);

      await applyPackageContributionPlan({
        plan: cross.plan,
        preimage: { packageJson: rootAfterInstall, lockfile: lockAfterInstall },
        executor,
        writeFile: async (relative, content) => {
          expect(relative === PACKAGE_JSON_RELATIVE || relative === "pnpm-lock.yaml").toBe(true);
          await writeFileUtf8(join(root, relative), content, "utf8");
        },
        readResolvedLocalPackageJson: async () => {
          try {
            return await readFile(join(root, LOCAL_CLI_PACKAGE_JSON_RELATIVE), "utf8");
          } catch {
            return null;
          }
        },
        assertLocalCliExecutable: () =>
          assertLocalCliExecutableAtRoot({ root, expectedVersion: vTo, run }),
      });

      const rootAfterCross = await readFile(join(root, PACKAGE_JSON_RELATIVE), "utf8");
      const lockAfterCross = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
      expect(parsePkg(rootAfterCross).devDependencies?.["poiesis-cli"]).toBe(vTo);
      expect(await readFile(join(childDir, "package.json"), "utf8")).toBe(childBefore);
      await assertLocalCliExecutableAtRoot({ root, expectedVersion: vTo, run });

      // 3) Removal (uninstall-shaped): capture bind → root package.json replace →
      // native remove with explicit workspace-root scope. Never touches child paths.
      const removal = planPackageContributionRemoval({
        snapshot: snap({
          packageJson: rootAfterCross,
          lockfiles: { "pnpm-lock.yaml": lockAfterCross, "pnpm-workspace.yaml": workspaceYaml },
          npmrc,
        }),
        record: cross.contributionForProjection!,
      });
      expect(removal.kind).toBe("apply");
      if (removal.kind !== "apply") throw new Error("expected removal apply");
      expect(removal.executionScope).toEqual({ kind: "pnpm-workspace-root" });
      expect(removal.lockfileOperation).toEqual({ op: "remove-dev", name: "poiesis-cli" });
      expect(
        nativePackageManagerArgv("pnpm", removal.lockfileOperation!, removal.executionScope),
      ).toEqual(["install", "-w", "--ignore-scripts"]);

      // Capture-identity bind (uninstall journal preimage) before lock reconcile.
      assertPackageContributionCaptureIdentity(removal, { packageJsonContent: rootAfterCross });

      if (removal.packageJsonChanged) {
        await writeFileUtf8(join(root, PACKAGE_JSON_RELATIVE), removal.nextPackageJson, "utf8");
      }
      const removeResult = await executor.apply({
        manager: removal.record.manager,
        operation: removal.lockfileOperation!,
        packageJson: removal.nextPackageJson,
        lockfile: lockAfterCross,
        ignoreScripts: true,
        executionScope: removal.executionScope,
      });
      // Root lock only — never adopt child paths.
      await writeFileUtf8(join(root, "pnpm-lock.yaml"), removeResult.lockfile, "utf8");

      const rootAfterRemove = parsePkg(await readFile(join(root, PACKAGE_JSON_RELATIVE), "utf8"));
      expect(rootAfterRemove.scripts?.poiesis).toBeUndefined();
      expect(rootAfterRemove.devDependencies?.["poiesis-cli"]).toBeUndefined();
      // Child foreign Poiesis declarations remain byte-identical through the full lifecycle.
      expect(await readFile(join(childDir, "package.json"), "utf8")).toBe(childBefore);
      expect(childBefore).toContain("child-foreign");
      expect(childBefore).toContain('"poiesis-cli": "1.5.0"');
    },
    180_000,
  );
});

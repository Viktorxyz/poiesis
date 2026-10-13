/**
 * Spec #227 / ticket #228 — dedicated native package-manager mutation bound.
 *
 * The native executor previously called `run()` without `timeoutMs`, so npm/pnpm
 * installs inherited the shared 30s process default and were killed mid-tree.
 * This suite proves the real executor-to-run seam carries an explicit 600000ms
 * bound for every mutation (including workspace-root argv), without raising the
 * process default or auto-retrying, and that timeout/failure diagnostics stay
 * allowlisted, sanitized, and partial-state honest.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PoiesisError } from "../src/errors.js";
import {
  PACKAGE_JSON_RELATIVE,
  PACKAGE_MANAGER_MUTATION_TIMEOUT_MS,
  applyPackageContributionPlan,
  createNativePackageManagerExecutor,
  nativePackageManagerArgv,
  planPackageContribution,
  setPackageManagerRunForTest,
  type PackageFsSnapshot,
  type PackageManagerRun,
} from "../src/package-invocation.js";
import type { RunOptions, RunResult } from "../src/process.js";

const fixtures: string[] = [];

afterEach(async () => {
  setPackageManagerRunForTest(null);
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

const ORDINARY_PKG = [
  "{",
  '  "name": "demo",',
  '  "version": "0.1.0",',
  '  "scripts": {',
  '    "build": "tsc"',
  "  },",
  '  "devDependencies": {',
  '    "typescript": "^5.0.0"',
  "  }",
  "}",
  "",
].join("\n");

const PNPM_LOCK = "lockfileVersion: '9.0'\n";

function snap(args: {
  packageJson?: string | null;
  lockfiles?: Partial<
    Record<"pnpm-lock.yaml" | "package-lock.json" | "pnpm-workspace.yaml", string | null>
  >;
  npmrc?: string | null;
}): PackageFsSnapshot {
  return {
    packageJson: args.packageJson === undefined ? null : args.packageJson,
    lockfiles: {
      "pnpm-lock.yaml": args.lockfiles?.["pnpm-lock.yaml"] ?? null,
      "package-lock.json": args.lockfiles?.["package-lock.json"] ?? null,
      "yarn.lock": null,
      "bun.lock": null,
      "bun.lockb": null,
      "pnpm-workspace.yaml": args.lockfiles?.["pnpm-workspace.yaml"] ?? null,
    },
    ...(args.npmrc === undefined ? {} : { npmrc: args.npmrc }),
  };
}

function liveFromPlan(
  plan: { record: { lockfile: "pnpm-lock.yaml" | "package-lock.json" }; executionScope: { kind: string } },
  packageJson: string,
  lockfile: string,
  extra?: { workspaceYaml?: string },
): PackageFsSnapshot {
  const lockfiles: Partial<
    Record<"pnpm-lock.yaml" | "package-lock.json" | "pnpm-workspace.yaml", string | null>
  > = {
    [plan.record.lockfile]: lockfile,
  };
  if (plan.executionScope.kind === "pnpm-workspace-root") {
    lockfiles["pnpm-workspace.yaml"] = extra?.workspaceYaml ?? "packages:\n  - 'packages/*'\n";
  }
  return snap({ packageJson, lockfiles });
}

function successResult(command: string, args: string[], options: RunOptions): RunResult {
  return {
    command,
    args,
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    signal: null,
    durationMs: 1,
    ...(options.cwd ? {} : {}),
  };
}

async function stageRoot(contents: {
  packageJson: string;
  lockfile?: string;
  lockName?: "pnpm-lock.yaml" | "package-lock.json";
  workspaceYaml?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "poiesis-pm-timeout-"));
  fixtures.push(root);
  await writeFile(join(root, PACKAGE_JSON_RELATIVE), contents.packageJson, "utf8");
  const lockName = contents.lockName ?? "pnpm-lock.yaml";
  await writeFile(join(root, lockName), contents.lockfile ?? PNPM_LOCK, "utf8");
  if (contents.workspaceYaml !== undefined) {
    await writeFile(join(root, "pnpm-workspace.yaml"), contents.workspaceYaml, "utf8");
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await writeFile(
      join(root, "packages", "app", "package.json"),
      '{\n  "name": "@ws/app",\n  "version": "0.0.1",\n  "private": true\n}\n',
      "utf8",
    );
  }
  return root;
}

describe("native package-manager mutation timeout (Spec #227 / ticket #228)", () => {
  it("exposes the dedicated 600000ms mutation bound (not the shared 30s default)", () => {
    // Named break: omitting or shrinking this bound reintroduces the 30s kill.
    expect(PACKAGE_MANAGER_MUTATION_TIMEOUT_MS).toBe(600_000);
    expect(PACKAGE_MANAGER_MUTATION_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("createNativePackageManagerExecutor passes the dedicated bound at the real run seam", async () => {
    const root = await stageRoot({ packageJson: ORDINARY_PKG });
    const calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];
    const run: PackageManagerRun = async (command, args, options) => {
      calls.push({ command, args, options });
      const nextPkg = [
        "{",
        '  "name": "demo",',
        '  "version": "0.1.0",',
        '  "scripts": { "build": "tsc", "poiesis": "poiesis" },',
        '  "devDependencies": { "typescript": "^5.0.0", "poiesis-cli": "1.6.0" }',
        "}",
        "",
      ].join("\n");
      await writeFile(join(root, PACKAGE_JSON_RELATIVE), nextPkg, "utf8");
      await writeFile(join(root, "pnpm-lock.yaml"), "lock-after\n", "utf8");
      return successResult(command, args, options);
    };
    setPackageManagerRunForTest(run);

    const executor = createNativePackageManagerExecutor(root);
    const result = await executor.apply({
      manager: "pnpm",
      operation: { op: "add-dev", name: "poiesis-cli", version: "1.6.0" },
      packageJson: ORDINARY_PKG,
      lockfile: PNPM_LOCK,
      ignoreScripts: true,
      executionScope: { kind: "single-package" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("pnpm");
    expect(calls[0]!.args).toEqual(nativePackageManagerArgv("pnpm", { op: "add-dev", name: "poiesis-cli", version: "1.6.0" }, { kind: "single-package" }));
    expect(calls[0]!.options.cwd).toBe(root);
    expect(calls[0]!.options.timeoutMs).toBe(600_000);
    // Must not silently fall through to the process default by omitting timeoutMs.
    expect(Object.hasOwn(calls[0]!.options, "timeoutMs")).toBe(true);
    expect(result.lockfile).toBe("lock-after\n");
  });

  it("workspace-root mutation also carries the dedicated bound on the real executor run seam", async () => {
    const workspaceYaml = "packages:\n  - 'packages/*'\n";
    const root = await stageRoot({ packageJson: ORDINARY_PKG, workspaceYaml });
    const calls: Array<RunOptions> = [];
    setPackageManagerRunForTest(async (command, args, options) => {
      calls.push(options);
      const nextPkg = [
        "{",
        '  "name": "demo",',
        '  "version": "0.1.0",',
        '  "scripts": { "build": "tsc", "poiesis": "poiesis" },',
        '  "devDependencies": { "typescript": "^5.0.0", "poiesis-cli": "1.7.0" }',
        "}",
        "",
      ].join("\n");
      await writeFile(join(root, PACKAGE_JSON_RELATIVE), nextPkg, "utf8");
      await writeFile(join(root, "pnpm-lock.yaml"), "lock-ws\n", "utf8");
      return successResult(command, args, options);
    });

    const executor = createNativePackageManagerExecutor(root);
    await executor.apply({
      manager: "pnpm",
      operation: { op: "add-dev", name: "poiesis-cli", version: "1.7.0" },
      packageJson: ORDINARY_PKG,
      lockfile: PNPM_LOCK,
      ignoreScripts: true,
      executionScope: { kind: "pnpm-workspace-root" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.timeoutMs).toBe(PACKAGE_MANAGER_MUTATION_TIMEOUT_MS);
  });

  it("deterministic >30s work succeeds under the dedicated bound without a real long sleep", async () => {
    // Named break: if the seam still used the shared 30s default, simulated 45s work fails.
    const root = await stageRoot({ packageJson: ORDINARY_PKG });
    const SIMULATED_NEED_MS = 45_000;
    let observedTimeoutMs: number | undefined;
    setPackageManagerRunForTest(async (command, args, options) => {
      observedTimeoutMs = options.timeoutMs;
      const bound = options.timeoutMs ?? 30_000;
      if (bound < SIMULATED_NEED_MS) {
        throw new PoiesisError(
          "COMMAND_TIMEOUT",
          `${command} exceeded ${bound}ms timeout`,
          {
            command,
            args,
            timeoutMs: bound,
            exitCode: null,
            signal: "SIGTERM",
            durationMs: bound,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          },
          124,
        );
      }
      const nextPkg = [
        "{",
        '  "name": "demo",',
        '  "version": "0.1.0",',
        '  "scripts": { "build": "tsc", "poiesis": "poiesis" },',
        '  "devDependencies": { "typescript": "^5.0.0", "poiesis-cli": "1.6.0" }',
        "}",
        "",
      ].join("\n");
      await writeFile(join(root, PACKAGE_JSON_RELATIVE), nextPkg, "utf8");
      await writeFile(join(root, "pnpm-lock.yaml"), "lock-slow-ok\n", "utf8");
      return {
        ...successResult(command, args, options),
        durationMs: SIMULATED_NEED_MS,
      };
    });

    const executor = createNativePackageManagerExecutor(root);
    await expect(
      executor.apply({
        manager: "pnpm",
        operation: { op: "add-dev", name: "poiesis-cli", version: "1.6.0" },
        packageJson: ORDINARY_PKG,
        lockfile: PNPM_LOCK,
        ignoreScripts: true,
        executionScope: { kind: "single-package" },
      }),
    ).resolves.toMatchObject({ lockfile: "lock-slow-ok\n" });
    expect(observedTimeoutMs).toBe(600_000);
  });

  it("genuine timeout expires once with allowlisted diagnostics and no retry", async () => {
    const root = await stageRoot({ packageJson: ORDINARY_PKG });
    let runCalls = 0;
    setPackageManagerRunForTest(async (command, args, options) => {
      runCalls += 1;
      throw new PoiesisError(
        "COMMAND_TIMEOUT",
        `${command} exceeded ${options.timeoutMs}ms timeout`,
        {
          command,
          args,
          timeoutMs: options.timeoutMs,
          exitCode: null,
          signal: "SIGTERM",
          durationMs: options.timeoutMs,
          stdout: "",
          stderr: "npm ERR network hang",
          stdoutTruncated: false,
          stderrTruncated: true,
        },
        124,
      );
    });

    const executor = createNativePackageManagerExecutor(root);
    let thrown: unknown;
    try {
      await executor.apply({
        manager: "npm",
        operation: { op: "add-dev", name: "poiesis-cli", version: "1.6.0" },
        packageJson: ORDINARY_PKG,
        lockfile: "{}",
        ignoreScripts: true,
        executionScope: { kind: "single-package" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(runCalls).toBe(1);
    expect(thrown).toMatchObject({
      code: "PACKAGE_MANAGER_FAILED",
      details: {
        manager: "npm",
        timeoutMs: 600_000,
        exitCode: null,
        signal: "SIGTERM",
        stderrTruncated: true,
        causeCode: "COMMAND_TIMEOUT",
      },
    });
    const details = (thrown as PoiesisError).details;
    expect(details.stderr).toBe("npm ERR network hang");
    // No credential / env / config dumps on the failure envelope.
    expect(JSON.stringify(details)).not.toMatch(/process\.env|NPM_TOKEN|\/\/[^/]+:[^@]+@/i);
    expect(details).not.toHaveProperty("env");
    expect(details).not.toHaveProperty("stdout");
  });

  it("apply wraps native timeout as PACKAGE_MANAGER_INCOMPLETE with diagnostics and no node_modules rollback claim", async () => {
    const root = await stageRoot({ packageJson: ORDINARY_PKG });
    let runCalls = 0;
    setPackageManagerRunForTest(async (command, args, options) => {
      runCalls += 1;
      throw new PoiesisError(
        "COMMAND_TIMEOUT",
        `${command} exceeded ${options.timeoutMs}ms timeout`,
        {
          command,
          args,
          timeoutMs: options.timeoutMs,
          exitCode: null,
          signal: "SIGKILL",
          durationMs: options.timeoutMs,
          stdout: "",
          stderr: "fetch timed out",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        124,
      );
    });

    const plan = planPackageContribution({
      snapshot: snap({ packageJson: ORDINARY_PKG, lockfiles: { "pnpm-lock.yaml": PNPM_LOCK } }),
      poiesisVersion: "1.6.0",
      mode: "ensure",
    });
    if (plan.kind !== "apply") throw new Error("expected apply");

    const writes: string[] = [];
    const executor = createNativePackageManagerExecutor(root);
    await expect(
      applyPackageContributionPlan({
        plan,
        preimage: { packageJson: ORDINARY_PKG, lockfile: PNPM_LOCK },
        liveSnapshot: liveFromPlan(plan, ORDINARY_PKG, PNPM_LOCK),
        executor,
        writeFile: async (path, content) => {
          writes.push(path);
          await writeFile(join(root, path), content, "utf8");
        },
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_MANAGER_INCOMPLETE",
      details: {
        ownedArtifactsMayRollback: true,
        nativeSideEffectsNotClaimedRolledBack: true,
        causeCode: "PACKAGE_MANAGER_FAILED",
        causeDetails: expect.objectContaining({
          timeoutMs: 600_000,
          signal: "SIGKILL",
          causeCode: "COMMAND_TIMEOUT",
          stderrTruncated: false,
        }),
      },
    });
    // One native attempt only — no auto-retry through apply.
    expect(runCalls).toBe(1);
    // Owned package.json may have been written; lock/native tree not claimed rolled back.
    expect(writes).toContain(PACKAGE_JSON_RELATIVE);
    expect(await readFile(join(root, PACKAGE_JSON_RELATIVE), "utf8")).toBe(plan.nextPackageJson);
  });

  it("COMMAND_FAILED path still carries allowlisted exit/stderr truncation without secrets", async () => {
    const root = await stageRoot({
      packageJson: ORDINARY_PKG,
      lockName: "package-lock.json",
      lockfile: "{}\n",
    });
    setPackageManagerRunForTest(async (command, args) => {
      throw new PoiesisError("COMMAND_FAILED", `${command} exited with code 1`, {
        command,
        args,
        exitCode: 1,
        stderr: "ERR! code ERESOLVE",
        stderrTruncated: false,
        stdoutTruncated: false,
      });
    });

    const executor = createNativePackageManagerExecutor(root);
    await expect(
      executor.apply({
        manager: "npm",
        operation: { op: "add-dev", name: "poiesis-cli", version: "1.6.0" },
        packageJson: ORDINARY_PKG,
        lockfile: "{}\n",
        ignoreScripts: true,
        executionScope: { kind: "single-package" },
      }),
    ).rejects.toMatchObject({
      code: "PACKAGE_MANAGER_FAILED",
      details: {
        timeoutMs: 600_000,
        exitCode: 1,
        stderr: "ERR! code ERESOLVE",
        stderrTruncated: false,
        causeCode: "COMMAND_FAILED",
      },
    });
  });
});

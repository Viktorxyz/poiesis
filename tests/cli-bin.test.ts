import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/process.js";

/**
 * Regression test for the silent-exit-0 bug in the packaged bin.
 *
 * When `npx poiesis ...` invokes `node_modules/.bin/poiesis` (a symlink to
 * `node_modules/poiesis/dist/cli.js`), `process.argv[1]` is the symlink path
 * while `import.meta.url` resolves to the real file path. A naive
 * `argv[1] === import.meta.url` comparison misses, `main()` never runs, and
 * the process silently exits 0. This file proves the bin resolves `main` via
 * the symlink-aware realpath comparison in `src/cli.ts` and that the
 * import-time safety guard still holds for tests.
 *
 * The test prefers a high-level packed/built seam (it builds the CLI bundle
 * with `tsup` and then exercises the real `.bin` shape that npm/pnpm install
 * would create) and keeps the suite bounded by sharing the build across all
 * assertions in a single beforeAll. The transient `dist/` and the bin
 * symlink are removed in afterAll so the working tree is clean on handoff.
 */

interface BuiltBin {
  binPath: string;
  cliPath: string;
  repoRoot: string;
  /** Scratch directory for the "install" shape; always under tmpdir. */
  installDir: string;
}

let built: BuiltBin | undefined;

beforeAll(async () => {
  const repoRoot = join(import.meta.dirname, "..");
  // Build the CLI entry only — the bin contract is the CLI surface, not the
  // library entry. `--no-dts` keeps the build cheap.
  await run(
    "node",
    [
      "node_modules/tsup/dist/cli-default.js",
      "src/cli.ts",
      "--format",
      "esm",
      "--clean",
      "--no-dts",
      "--out-dir",
      "dist",
    ],
    { cwd: repoRoot, timeoutMs: 60_000 },
  );
  const cliPath = join(repoRoot, "dist", "cli.js");
  if (!existsSync(cliPath)) throw new Error("tsup did not produce dist/cli.js");

  // Lay out an "installed consumer" tree under tmpdir and symlink the bin into
  // it the way npm/pnpm would: `<consumer>/node_modules/.bin/poiesis` →
  // `<repo>/dist/cli.js`. The consumer's `node_modules/poiesis` is a symlink
  // to the repo so the bundled CLI can resolve its `jsonc-parser` and
  // `zod` imports when launched from the consumer tree.
  const installDir = await mkdtemp(join(tmpdir(), "poiesis-cli-bin-"));
  const consumerBinDir = join(installDir, "node_modules", ".bin");
  const consumerNodeModules = join(installDir, "node_modules");
  await mkdir(consumerBinDir, { recursive: true });
  // `jsonc-parser` and `zod` live in the repo's hoisted node_modules and the
  // CLI's ESM import walker looks upward from dist/cli.js, so we just need a
  // symmetric node_modules reachable from the bin invocation. A symlink to the
  // repo's node_modules at the consumer root satisfies that walk and keeps the
  // suite side-effect-free.
  await symlink(join(repoRoot, "node_modules"), join(consumerNodeModules, "poiesis-cli"));
  const binPath = join(consumerBinDir, "poiesis");
  await symlink(cliPath, binPath);

  built = { binPath, cliPath, repoRoot, installDir };
}, 60_000);

afterAll(async () => {
  if (built) {
    await rm(built.installDir, { recursive: true, force: true });
    await rm(join(built.repoRoot, "dist"), { recursive: true, force: true });
    // The bin symlink lives in the repo's own node_modules/.bin. pnpm's
    // `node_modules/.bin` is content-addressed, but our manual symlink is a
    // residue we own; remove it explicitly.
    try {
      await rm(join(built.repoRoot, "node_modules", ".bin", "poiesis"));
    } catch {
      // file already gone; ignore
    }
  }
  built = undefined;
});

describe("CLI bin (symlink-aware main resolution)", () => {
  it("lays out consumer/node_modules/.bin/poiesis as a symlink to dist/cli.js", () => {
    if (!built) throw new Error("bin not built");
    const { lstatSync, readlinkSync } = require("node:fs") as typeof import("node:fs");
    expect(lstatSync(built.binPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(built.binPath)).toBe(built.cliPath);
  });

  it("prints the package version when invoked via .bin/poiesis --version", async () => {
    if (!built) throw new Error("bin not built");
    const result = await run("node", [built.binPath, "--version"], { cwd: built.installDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.stdout).not.toBe("");
  });

  it("prints the package version via the short -v flag", async () => {
    if (!built) throw new Error("bin not built");
    const result = await run("node", [built.binPath, "-v"], { cwd: built.installDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints help text when invoked via .bin/poiesis --help", async () => {
    if (!built) throw new Error("bin not built");
    const result = await run("node", [built.binPath, "--help"], { cwd: built.installDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("poiesis init");
    expect(result.stdout).toContain("poiesis update --config <file>");
    expect(result.stdout).toContain("poiesis update [--bootstrap-legacy-ownership]");
  });

  it("package-installed HELP imperatively tells the operator to omit --path for ordinary Prepare", async () => {
    if (!built) throw new Error("bin not built");
    // Package-installed proof: the HELP that a consumer sees when running
    // `.bin/poiesis --help` must imperatively direct operators to omit
    // `--path` for ordinary Prepare. The default command shape must
    // appear before any exceptional `--path` form.
    const result = await run("node", [built.binPath, "--help"], { cwd: built.installDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Omit `--path`");
    expect(result.stdout).toContain("default: Omit `--path`");
    expect(result.stdout).toContain("exceptional only");
    expect(result.stdout).toContain("Author explicitly supplied an exceptional path");
    expect(result.stdout).toContain("compatibility recovery requires the exact pre-existing path");
    // The exceptional --path form must appear strictly after the default
    // form so an agent reading top-to-bottom sees the default first.
    const defaultIdx = result.stdout.indexOf("poiesis workspace prepare --branch <name> --spec <id>");
    const exceptionalIdx = result.stdout.indexOf("poiesis workspace prepare --branch <name> --path");
    expect(defaultIdx).toBeGreaterThanOrEqual(0);
    expect(exceptionalIdx).toBeGreaterThan(defaultIdx);
  });

  it("executes a structured command (inspect) via .bin/poiesis", async () => {
    if (!built) throw new Error("bin not built");
    // `inspect` requires a git repository to produce its structured report,
    // so initialise a throwaway repo inside the consumer tree.
    await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: built.installDir });
    await run("git", ["config", "user.name", "Poiesis Bin Test"], { cwd: built.installDir });
    await run("git", ["config", "user.email", "poiesis-bin@example.test"], { cwd: built.installDir });
    const result = await run(
      "node",
      [built.binPath, "inspect", "--cwd", built.installDir],
      { cwd: built.installDir },
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      operation: string;
      result: { poiesis: { installed: boolean } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("inspect");
    expect(payload.result.poiesis.installed).toBe(false);
  });

  it("runs main when invoked directly via dist/cli.js (no symlink)", async () => {
    if (!built) throw new Error("bin not built");
    const result = await run("node", [built.cliPath, "--version"], { cwd: built.repoRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("computes a fingerprint via the built package bin (native ESM smoke)", async () => {
    if (!built) throw new Error("bin not built");
    // Ticket #84 finding #1: the built native ESM fingerprint
    // surface must work end-to-end. `poiesis inspect --fingerprint`
    // exercises the entire reconcile code path through the bin and
    // proves the package does not silently require a CJS shim.
    const repoRoot = join(built.installDir, "fingerprint-smoke");
    await mkdir(repoRoot, { recursive: true });
    await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repoRoot });
    await run("git", ["config", "user.name", "Poiesis Smoke"], { cwd: repoRoot });
    await run("git", ["config", "user.email", "poiesis-smoke@example.test"], { cwd: repoRoot });
    await writeFile(join(repoRoot, "README.md"), "smoke\n");
    await run("git", ["add", "README.md"], { cwd: repoRoot });
    await run("git", ["commit", "--quiet", "-m", "smoke"], { cwd: repoRoot });
    const result = await run(
      "node",
      [built.binPath, "inspect", "--cwd", repoRoot, "--fingerprint"],
      { cwd: repoRoot },
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      operation: string;
      result: { fingerprint?: { digest: string } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("inspect");
    expect(payload.result.fingerprint?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not run main when src/cli.ts is imported by a test", async () => {
    if (!built) throw new Error("bin not built");
    // The whole regression: importing `src/cli.ts` from a test must not invoke
    // `main()`. If this assertion ever starts emitting CLI output during the
    // existing test runs, the symlink-aware guard regressed and the other tests
    // in this suite (which already `import` cli for `commandUpdate`) would
    // also be disrupted. We assert the import surface is callable without
    // side-effects on stdout/stderr.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const cli = await import("../src/cli.js");
      expect(typeof cli.commandUpdate).toBe("function");
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    // `main` writes HELP (for argv-less) or a structured error to stdout.
    // The import path must not produce either.
    const combined = stdoutChunks.join("") + stderrChunks.join("");
    expect(combined).not.toContain("poiesis init");
    expect(combined).not.toContain("Unknown command");
  });
});

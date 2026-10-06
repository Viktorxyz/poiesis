import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/process.js";
import { buildIsolatedPackage, removeOwnedBuildRoot, type IsolatedPackageBuild } from "./isolated-package-build.js";

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
 * assertions in a single beforeAll.
 *
 * Spec #168 / ticket #181 — the build is OWNED, not shared.
 *
 * This suite used to build into the repository-wide `dist/` with
 * `tsup --clean` and then recursively delete that same `dist/` in `afterAll`.
 * `dist/` is not private: `tests/release-contract-v1.4.1.test.ts` runs
 * `pnpm build` (`tsup ... --clean` into `dist/`) and `pnpm pack` against it
 * while the pool runs several forks concurrently, so this suite was deleting
 * and half-rewriting a directory another running suite was building and
 * validating. Two concrete failures fall out of that, both observed running
 * the two suites together:
 *
 *   - `tsup --clean` from either side unlinks `dist/cli.js` while the other
 *     side's bin child is booting. Depending on where in the boot the unlink
 *     lands, the child either fails to load its own entry (exit 1) or has
 *     already loaded the module graph and cannot `realpath` `argv[1]` for the
 *     entry guard, reads "not main", and exits 0 having printed nothing — the
 *     silent-exit-0 bug this file exists to prevent, produced by the race
 *     rather than by the bug.
 *   - this suite's `afterAll` `rm -rf dist` can land inside the release
 *     contract's `pnpm pack`, which then reports a tarball with no `dist` at
 *     all, and it leaves the workspace with no build output whatsoever.
 *
 * The build now lives in a unique `mkdtemp` package root
 * (`tests/isolated-package-build.ts`), and the only path this suite removes is
 * that root. Ownership is fixed by isolation, not by scheduling: nothing here
 * serialises against the release contract, and the pool keeps its full
 * parallelism.
 *
 * The ownership claim is asserted, not assumed. This suite does not just
 * happen to be isolated — it pins the isolation on both ends:
 *
 *   - BUILD: the exact `tsup` argv records the output directory, so the
 *     assertions can require an absolute `--out-dir` inside the owned root and
 *     the absence of `--clean`, without reading prose.
 *   - CLEANUP: {@link removeOwnedBuildRoot} removes exactly one path and
 *     returns it; the final case asserts the returned path is the owned root,
 *     that the owned root is gone, and that a sentinel OUTSIDE it is untouched.
 *   - SOURCE: a small contract assertion over this file and the helper
 *     rejects the two shapes that reintroduce sharing — a `tsup --clean`, and
 *     a removal or relative build target naming the canonical `dist/`.
 *
 * Audited siblings: `tests/proof-to-preview-guidance.test.ts` builds into its
 * own `dist-proof-to-preview/` and `tests/cli-cancellation.test.ts` into its
 * own `.poiesis-cancel-bin/`. Neither owns or touches the canonical `dist/`,
 * so neither is part of this defect and neither is changed here.
 */

/** Both sources that build and remove the packaged CLI for this suite. */
const OWNERSHIP_SOURCES = ["cli-bin.test.ts", "isolated-package-build.ts"] as const;

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * Shapes that would put this suite back in the canonical `dist/` that
 * `pnpm build` and the release contract own.
 *
 * Each pattern is anchored on a CODE shape, not on wording, so ordinary
 * comments and prose about `--clean` or about the shared `dist/` cannot break
 * it while both regressions this ticket removes still would:
 *
 *   - `--clean` as an argument-array element (leading or subsequent), which is
 *     how `tsup` is actually invoked — not the word appearing in a sentence;
 *   - a removal whose path is derived from the repository root AND names
 *     `dist`, so an owned-root removal (whose path legitimately contains a
 *     `dist/` segment) stays legal;
 *   - a build output directory given to `tsup` as the relative name for the
 *     canonical directory, i.e. a build that resolves against the working
 *     directory instead of the owned root.
 */
const FORBIDDEN_OWNERSHIP_SHAPES: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  {
    what: "tsup --clean in an argument array (wipes the output directory it is pointed at)",
    pattern: /(?:\[\s*|,\s*)["'`]--clean["'`]/,
  },
  {
    what: "a removal of the repository-wide dist/ directory",
    pattern: /\brm(?:Sync)?\(\s*[^)]*(?:repoRoot|REPO_ROOT|import\.meta\.dirname)[^)]*["'`]dist\b/,
  },
  {
    what: "a tsup output directory of a relative `dist`",
    pattern: /--out-dir[^\n]*["'`]dist["'`]/,
  },
];

let built: IsolatedPackageBuild | undefined;

beforeAll(async () => {
  built = await buildIsolatedPackage(REPO_ROOT);
}, 60_000);

afterAll(async () => {
  // The owned root is the ONLY path this suite removes. The repository `dist/`,
  // `node_modules/`, and every other suite's output are left as they were found.
  if (built) await removeOwnedBuildRoot(built.ownedRoot);
  built = undefined;
});

describe("CLI bin (symlink-aware main resolution)", () => {
  it("lays out the isolated install as node_modules/.bin/poiesis → dist/cli.js", () => {
    if (!built) throw new Error("bin not built");
    expect(lstatSync(built.binPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(built.binPath)).toBe(built.cliPath);
  });

  it("builds into a suite-owned package root and never into the repository dist", () => {
    if (!built) throw new Error("bin not built");
    // Spec #168 / ticket #181 — the build half of the ownership claim. The
    // `tsup` argv is inspected rather than the prose describing it, and both
    // sides of every path are compared through `realpath` because the platform
    // temp directory may itself be a symlink.
    const ownedRoot = realpathSync(built.ownedRoot);
    const outDirIndex = built.buildArgv.indexOf("--out-dir");
    expect(outDirIndex, "tsup must be given an explicit output directory").toBeGreaterThanOrEqual(0);
    const outDir = built.buildArgv[outDirIndex + 1]!;

    // No `--clean`, so this build has no mechanism that could reach a
    // directory it does not own.
    expect(built.buildArgv).not.toContain("--clean");
    // An absolute output directory inside the owned root: not the canonical
    // `dist/`, not a cwd-relative path that could resolve to it.
    expect(isAbsolute(outDir)).toBe(true);
    expect(outDir).toBe(built.distDir);
    expect(resolve(outDir).startsWith(`${ownedRoot}${sep}`)).toBe(true);
    expect(realpathSync(built.cliPath).startsWith(`${ownedRoot}${sep}`)).toBe(true);
    expect(resolve(built.binPath).startsWith(`${ownedRoot}${sep}`)).toBe(true);
    // The bundle under test is not the repository build output.
    expect(built.cliPath).not.toBe(join(REPO_ROOT, "dist", "cli.js"));
    // The entry guard resolves `packageRoot` to the isolated install, which is
    // what makes `--version` and the template/skills surfaces behave exactly
    // as they do for a packaged consumer.
    expect(existsSync(join(built.packageRoot, "package.json"))).toBe(true);
  });

  it("declares no canonical dist build target and no tsup --clean", async () => {
    // The runtime argv above proves what THIS run did; this proves the source
    // cannot reintroduce sharing on the next run, including in a code path the
    // assertions above do not execute.
    for (const file of OWNERSHIP_SOURCES) {
      const source = await readFile(join(import.meta.dirname, file), "utf8");
      for (const { what, pattern } of FORBIDDEN_OWNERSHIP_SHAPES) {
        expect(pattern.test(source), `${file} must not contain ${what}`).toBe(false);
      }
    }
  });

  it("prints the package version when invoked via .bin/poiesis --version", async () => {
    if (!built) throw new Error("bin not built");
    const result = await run("node", [built.binPath, "--version"], { cwd: built.consumerDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.stdout).not.toBe("");
  });

  it("prints the package version via the short -v flag", async () => {
    if (!built) throw new Error("bin not built");
    // This is the assertion the shared-`dist/` race broke: while a concurrent
    // `tsup --clean` had `dist/cli.js` unlinked, the entry guard could not
    // realpath `argv[1]`, decided it was not main, and the bin exited 0 with
    // nothing on stdout.
    const result = await run("node", [built.binPath, "-v"], { cwd: built.consumerDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints help text when invoked via .bin/poiesis --help", async () => {
    if (!built) throw new Error("bin not built");
    const result = await run("node", [built.binPath, "--help"], { cwd: built.consumerDir });
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
    const result = await run("node", [built.binPath, "--help"], { cwd: built.consumerDir });
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
    // so initialise a throwaway repo inside the owned consumer tree.
    await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: built.consumerDir });
    await run("git", ["config", "user.name", "Poiesis Bin Test"], { cwd: built.consumerDir });
    await run("git", ["config", "user.email", "poiesis-bin@example.test"], { cwd: built.consumerDir });
    const result = await run(
      "node",
      [built.binPath, "inspect", "--cwd", built.consumerDir],
      { cwd: built.consumerDir },
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
    const result = await run("node", [built.cliPath, "--version"], { cwd: built.consumerDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
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

  // Last: this case consumes the owned root, so nothing may run after it.
  it("removes exactly the owned root and nothing outside it", async () => {
    if (!built) throw new Error("bin not built");
    const ownedRoot = built.ownedRoot;
    // A sentinel OUTSIDE the owned root. It sits in its own temp directory so
    // proving it survived proves the removal was scoped, without writing
    // anything into the repository.
    const sentinelDir = await mkdtemp(join(tmpdir(), "poiesis-cli-bin-sentinel-"));
    const sentinel = join(sentinelDir, "keep.txt");
    await writeFile(sentinel, "owned by nobody under test\n");
    try {
      // The owned root is live for the whole suite and is what teardown removes.
      expect(existsSync(ownedRoot), "the owned build root must exist while the suite runs").toBe(true);

      const removed = await removeOwnedBuildRoot(ownedRoot);

      // The teardown target is inspectable, and it is EXACTLY the owned root:
      // not the repository root, not the canonical `dist/`, and not something
      // under the temp directory that this suite did not create.
      expect(removed).toBe(resolve(ownedRoot));
      expect(removed).not.toBe(resolve(REPO_ROOT));
      expect(removed).not.toBe(resolve(REPO_ROOT, "dist"));
      expect(existsSync(removed), "the owned build root must be gone after cleanup").toBe(false);
      // Nothing outside the owned root was touched.
      expect(existsSync(sentinel), "cleanup must not reach outside the owned root").toBe(true);
    } finally {
      await rm(sentinelDir, { recursive: true, force: true });
    }
  });
});
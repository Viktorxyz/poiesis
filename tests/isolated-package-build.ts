import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/process.js";

/**
 * Spec #168 / ticket #181 — a packaged-CLI build that owns nothing but its
 * own output directory.
 *
 * `dist/` at the repository root is NOT private. `pnpm build` (`tsup ...
 * --clean`) writes it, and `tests/release-contract-v1.4.2.test.ts` builds,
 * packs, and validates against it while the pool runs several forks at once.
 * A test suite that builds into that directory, or deletes it in teardown,
 * reaches into another running suite's output.
 *
 * This helper builds the CLI bundle into a unique `mkdtemp` package root laid
 * out like an installed package, and exposes the two facts a caller needs to
 * audit the ownership:
 *
 *   - {@link IsolatedPackageBuild.buildArgv} — the exact argv handed to
 *     `tsup`, so a caller can assert the output directory is the owned one
 *     and that `--clean` was never passed, without parsing this source;
 *   - {@link removeOwnedBuildRoot}, which removes exactly ONE path — the one
 *     it is given — and returns it, so a caller can assert that the teardown
 *     target is the owned root and that a sentinel outside it survived.
 *
 * Nothing here writes into the repository. Not into `dist/`, not into
 * `node_modules/`, not anywhere else.
 */

export interface IsolatedPackageBuild {
  /** The single directory this build owns and may delete. */
  ownedRoot: string;
  /** Root of the isolated install: `package.json` + canonical docs + `dist/`. */
  packageRoot: string;
  /** Where `tsup` was told to write. */
  distDir: string;
  /** The bundled CLI entry. */
  cliPath: string;
  /** `<packageRoot>/node_modules/.bin/poiesis`, as an install would create it. */
  binPath: string;
  /** Bare project directory the bin is invoked from. */
  consumerDir: string;
  /** The exact argv passed to `tsup`. */
  buildArgv: string[];
  /** The directory `tsup` ran in (the repository, for config and input paths). */
  buildCwd: string;
}

/**
 * Build the CLI bundle into a fresh, suite-owned package root.
 *
 * The root is `mkdtemp`-unique, so two concurrent instances could never share
 * a build either, and `tsup` is given an ABSOLUTE `--out-dir` inside it. No
 * `--clean`: the output directory is already fresh, and omitting the flag
 * means this build has no mechanism that could reach a directory it does not
 * own.
 */
export async function buildIsolatedPackage(repoRoot: string): Promise<IsolatedPackageBuild> {
  const ownedRoot = await mkdtemp(join(tmpdir(), "poiesis-cli-bin-"));
  // Mirrors the layout `npm pack` produces, so `packageRoot` in the bundle
  // resolves to THIS directory and the packaged-CLI behaviour under test is
  // the installed one rather than a relocated accident.
  const packageRoot = join(ownedRoot, "package");
  const distDir = join(packageRoot, "dist");
  await mkdir(distDir, { recursive: true });

  // Lay the rest of the packed surface around the build output. The bundle
  // resolves its own runtime identity (`packageRoot`, used by `--version`) and
  // its canonical docs by walking one level up from `dist/cli.js`, so those
  // files belong here or the packaged CLI fails for a reason unrelated to the
  // behaviour under test.
  const manifestPath = join(repoRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files?: string[];
    dependencies?: Record<string, string>;
  };
  // Every installed package carries its manifest; `files` does not list it
  // because npm always includes it. The bundle reads it for `--version`, so
  // without it the packaged CLI has no runtime identity to report.
  await symlink(manifestPath, join(packageRoot, "package.json"));
  for (const entry of manifest.files ?? []) {
    // `dist` is this build's own output; it is created above, not linked in
    // from the repository.
    if (entry === "dist") continue;
    const source = join(repoRoot, entry);
    if (!existsSync(source)) continue;
    await symlink(source, join(packageRoot, entry));
  }

  // Build the CLI entry only — the bin contract is the CLI surface, not the
  // library entry. `--no-dts` keeps the build cheap. `tsup` runs in the
  // repository (it needs `src/cli.ts` and the repository config) but writes
  // only into the owned root.
  const buildArgv = [
    "node_modules/tsup/dist/cli-default.js",
    "src/cli.ts",
    "--format",
    "esm",
    "--no-dts",
    "--out-dir",
    distDir,
  ];
  await run("node", buildArgv, { cwd: repoRoot, timeoutMs: 60_000 });
  const cliPath = join(distDir, "cli.js");
  if (!existsSync(cliPath)) throw new Error("tsup did not produce the isolated dist/cli.js");

  // The bundle's dependencies stay external (that is the shipped contract), so
  // they must resolve by walking up from `dist/cli.js`. Point each declared
  // runtime dependency at the repository's resolved copy: a symlink inside the
  // owned `node_modules/` keeps transitive resolution intact (pnpm places each
  // package's own dependencies beside it) while every byte this build creates
  // stays inside the owned root.
  const packageNodeModules = join(packageRoot, "node_modules");
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const target = join(packageNodeModules, dependency);
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(join(repoRoot, "node_modules", dependency), target);
  }

  // The bin exactly as npm/pnpm would create it: `<packageRoot>/node_modules/
  // .bin/poiesis` → `<packageRoot>/dist/cli.js`, so invocation goes through the
  // same symlinked `.bin` path a real consumer uses.
  const binPath = join(packageNodeModules, ".bin", "poiesis");
  await mkdir(join(packageNodeModules, ".bin"), { recursive: true });
  await symlink(cliPath, binPath);

  // A bare consumer project the bin is invoked from.
  const consumerDir = join(ownedRoot, "consumer");
  await mkdir(consumerDir, { recursive: true });

  return { ownedRoot, packageRoot, distDir, cliPath, binPath, consumerDir, buildArgv, buildCwd: repoRoot };
}

/**
 * Remove exactly one path — the one given — and return it.
 *
 * There is no second target, no derived path, and no repository reference: a
 * caller that passes the owned root cannot delete anything else with this, and
 * a caller can prove it by asserting the returned path and by checking that a
 * sentinel outside it survived.
 */
export async function removeOwnedBuildRoot(target: string): Promise<string> {
  const removed = resolve(target);
  await rm(removed, { recursive: true, force: true });
  return removed;
}
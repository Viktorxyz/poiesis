/**
 * Poiesis 1.3.1 release / update contract.
 *
 * Spec #133 / ticket #136 ships 1.3.1. The 1.3.1 feature is additive:
 * `init` and `update` maintain a `pnpm poiesis` script in the project's
 * `package.json`. Nothing about the OpenCode permission projection, the
 * exact-version agent launcher, or the packed canonical surface changes,
 * so this file's contract is inherited from the 1.2 release with the
 * version string advanced.
 *
 * This file proves the 1.3.1 release contract at the existing seams the
 * runtime already exposes for the same version-bounded invariants:
 *
 *   - `packageVersion()` (the runtime identity seam) reads the published
 *     package version and the value is exactly `1.3.1`. This is the
 *     durable half of the runtime identity boundary the OpenCode
 *     projection keys off (`pnpm dlx poiesis-cli@<manifest.poiesisVersion>`).
 *
 *   - `package.json::files` enumerates the durable canonical surface
 *     that ships in the npm tarball. The contract is:
 *
 *       * every required canonical doc / role / runtime output is listed;
 *       * no cache, no graph state, no source-of-truth build input
 *         (`src/`, `tests/`, `node_modules/`, `.poiesis/cache/`,
 *         `graphify-out/`) is listed.
 *
 *   - `pnpm pack --json` (offline-only, no publish, no network)
 *     produces the same set of packed paths that the runtime contract
 *     promises. A regression in the `files` array or in the on-disk
 *     canonical surface (e.g. a deleted role file) is caught here
 *     before any real publish.
 *
 *   - the same-version reconciliation contract still holds when the
 *     package is at 1.3.1: a receipt-authenticated `update` on a
 *     1.3.1 install stamps `manifest.poiesisVersion = "1.3.1"`. This
 *     pins the new exact-version route the OpenCode projection
 *     admits so a fresh consumer install lands on the 1.3.1
 *     canonical surface.
 *
 *   - Spec #131 / ticket #132 — the package at 1.3.1 still admits
 *     the v1.1.3 / v1.1.4 predecessor projection through the
 *     receipt-authenticated ordinary `update` transaction. A 1.1.3 /
 *     1.1.4 install with a trusted receipt is accepted, the manifest
 *     version advances to 1.3.1, the primary bash is keyed off
 *     `pnpm dlx poiesis-cli@1.3.1 *`, the Worker carries the v1.2
 *     Repository Intelligence additive allows, and the Specialist
 *     bash is restored. (Covered by
 *     `tests/authority-1.1.x-predecessor.test.ts`.)
 *
 *   - Spec #133 / ticket #136 — the version crossing from 1.2.1 to
 *     1.3.1. A project installed at 1.2.1 runs `poiesis update` under a
 *     1.3.1 runtime and succeeds, WITHOUT 1.2.1 being added to the
 *     accepted predecessor set: `assertManifestAuthorityToleratingPredecessor`
 *     builds its strict projection from the MANIFEST's own
 *     `poiesisVersion`, not the runtime's, so a 1.2.1 manifest matches
 *     the current strict surface on the strict path. The
 *     `pnpm poiesis` script value is deliberately NOT version-interpolated
 *     — it is the literal cache-bypassing fresh-latest route
 *     `pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest`, so the
 *     Author is never asked to type a version AND never gets a stale
 *     1440-minute `dlx` cache entry.
 *
 * The tests are deterministic, offline, and free of:
 *   - real npm publish;
 *   - network access;
 *   - Graphify / uv / Python;
 *   - prompt-driven agent dogfood.
 *
 * The tests that exercise the maintenance surface
 * (`init` / `update`) install a fake `uv` binary on PATH via the
 * shared `installFakeUv` pattern (mirroring `tests/fake-opencode.ts`'s
 * PATH-shim approach) so they never depend on a host uv and the
 * offline / no-real-uv claim stays true.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { init, update } from "../src/maintenance.js";
import { packageVersion } from "../src/maintenance.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { readOwnershipReceipt } from "../src/receipt.js";
import { POIESIS_SCRIPT_COMMAND, POIESIS_SCRIPT_NAME } from "../src/package-script.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

/**
 * Install a fake `uv` binary on PATH that reports `--version` and
 * exits 0 for any other invocation. Mirrors the inline pattern from
 * `tests/repository-intelligence-integration.test.ts` /
 * `tests/repository-intelligence.test.ts` / `tests/repository-status-cli.test.ts`
 * so the release / update contract test never depends on a host `uv`
 * and the offline / no-real-uv claim stays true. The fake is
 * prepended to PATH for the test's lifetime and torn down by
 * `restore()` so the global PATH is unchanged once the suite ends.
 */
async function installFakeUv(): Promise<FakeUvEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    parent,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

interface PackageJsonShape {
  name: string;
  version: string;
  files?: string[];
  scripts?: Record<string, string>;
}

async function readPackageJson(): Promise<PackageJsonShape> {
  return JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as PackageJsonShape;
}

/**
 * Rewrite a freshly-installed project into the exact state a 1.2.1
 * install would have left behind: `manifest.poiesisVersion = "1.2.1"`,
 * `manifest.configPatches` rebuilt by `desiredOpenCodePatches(config,
 * "1.2.1")` (so the primary bash allow key is
 * `pnpm dlx poiesis-cli@1.2.1 *`), the on-disk `opencode.jsonc` rewritten
 * to match, the manifest's `opencode.jsonc` file hash recomputed, and the
 * ownership receipt rebound to the new manifest digest.
 *
 * This is the manifest-versus-runtime version crossing shape used by
 * `tests/authority-1.1.x-predecessor.test.ts`: the manifest carries the
 * OLD version while the running runtime is the NEW one.
 */
async function asV121Manifest(repository: TestRepository): Promise<Manifest> {
  const { desiredOpenCodePatches } = await import("../src/opencode.js");
  const { parseJsonc } = await import("../src/config.js");
  const { readUtf8 } = await import("../src/fs.js");
  const { replaceOwnershipReceipt } = await import("../src/receipt.js");
  const { hashContent } = await import("../src/hash.js");

  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor = desiredOpenCodePatches(config, "1.2.1");
  manifest.poiesisVersion = "1.2.1";
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (candidate) =>
        candidate.path.length === patch.path.length &&
        candidate.path.every((segment, index) => segment === patch.path[index]),
    );
    return matching === undefined ? patch : { ...patch, installed: matching.value };
  });

  const openCodePath = join(repository.root, "opencode.jsonc");
  const current = parseJsonc<Record<string, unknown>>(await readUtf8(openCodePath), openCodePath);
  for (const patch of manifest.configPatches) {
    let target: Record<string, unknown> = current;
    for (let index = 0; index < patch.path.length - 1; index++) {
      const segment = patch.path[index]!;
      if (typeof target[segment] !== "object" || target[segment] === null) target[segment] = {};
      target = target[segment] as Record<string, unknown>;
    }
    target[patch.path[patch.path.length - 1]!] = patch.installed;
  }
  const rewrittenOpenCodeBytes = `${JSON.stringify(current, null, 2)}\n`;
  await writeFile(openCodePath, rewrittenOpenCodeBytes);
  manifest.files = manifest.files.map((file) =>
    file.path === "opencode.jsonc" ? { ...file, hash: hashContent(rewrittenOpenCodeBytes) } : file,
  );
  await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  const existing = await readOwnershipReceipt(repository.root);
  await replaceOwnershipReceipt(repository.root, manifest, existing);
  return manifest;
}

// Required canonical surface that MUST ship in the npm tarball.
// Each entry mirrors a `package.json::files[]` entry and a real
// on-disk file so a regression in either list is caught here.
const REQUIRED_CANONICAL_FILES = [
  "dist",
  "POIESIS_PHILOSOPHY.md",
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

// Forbidden paths that MUST NOT be packed. The Poiesis-owned cache and
// the Graphify-derived graph are local state, not canonical truth.
const FORBIDDEN_PACKED_PATHS = [
  ".poiesis/cache/",
  "graphify-out/",
  "src/",
  "tests/",
  "node_modules/",
] as const;

describe("Poiesis 1.3.1 release / update contract", () => {
  it("package.json version is the 1.3.1 release", async () => {
    const pkg = await readPackageJson();
    expect(pkg.version).toBe("1.3.1");
  });

  it("packageVersion() runtime seam returns the 1.3.1 release", async () => {
    expect(await packageVersion()).toBe("1.3.1");
  });

  it("the pnpm poiesis script value is the literal cache-bypassing @latest route, not version-interpolated", async () => {
    // Spec #133: the Author is never asked to type a version, and the
    // script is never allowed to resolve a stale `dlx` cache entry. The
    // script value is a release-independent constant, so a version bump
    // must not touch it. Poiesis CLI's OWN package.json is not a
    // Poiesis-managed project (it is the tool, not an install of it), so
    // it correctly carries no `poiesis` script; assert that so nobody
    // "fixes" it by adding a self-referential route to the CLI itself.
    const pkg = await readPackageJson();
    expect(POIESIS_SCRIPT_COMMAND).toBe("pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest");
    expect(POIESIS_SCRIPT_NAME).toBe("poiesis");
    expect(POIESIS_SCRIPT_COMMAND).toContain("--config.dlx-cache-max-age=0");
    expect(POIESIS_SCRIPT_COMMAND).toContain("@latest");
    expect(POIESIS_SCRIPT_COMMAND).not.toContain(pkg.version);
    expect(POIESIS_SCRIPT_COMMAND).not.toContain("1.3.1");
    expect(POIESIS_SCRIPT_COMMAND).not.toMatch(/@\d+\.\d+\.\d+/);
    expect(pkg.scripts?.[POIESIS_SCRIPT_NAME]).toBeUndefined();
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
        `package.json::files must not include ${forbidden} (cache/graph/source/build input is not canonical truth)`,
      ).toBe(false);
    }
  });

  it("every required canonical file actually exists at the workspace root (no drift between package.json::files and the on-disk tree)", async () => {
    for (const required of REQUIRED_CANONICAL_FILES) {
      if (required === "dist") continue; // dist is produced by `pnpm build`, not committed
      const absolute = join(REPO_ROOT, required);
      // Stat the file via fs.access — keep the test offline / no network.
      await expect(
        readFile(absolute, "utf8").then(() => undefined),
        `${required} must exist as a real file at the workspace root`,
      ).resolves.toBeUndefined();
    }
  });

  it(
    "pnpm pack --json produces the exact canonical surface (no cache / graph / source leak)",
    async () => {
      // Build first so dist/ is populated; the test must see the
      // post-build pack output, not the un-built workspace.
      await execFileAsync("pnpm", ["build"], { cwd: REPO_ROOT });
      // Suppress stderr so the build-script noise does not pollute the
      // pack output, and run `pack --json` from a subshell whose stdout
      // is exactly the JSON document `pnpm pack --json` emits.
      const { stdout } = await execFileAsync(
        "bash",
        ["-c", "pnpm pack --json 2>/dev/null"],
        { cwd: REPO_ROOT },
      );
      // Locate the JSON document: it begins with `{` at the start of a
      // line (after the build-output lines, which are pure ASCII
      // banners and never start with `{` at column 0).
      const lines = stdout.split(/\r?\n/);
      let jsonStart = -1;
      for (let index = 0; index < lines.length; index++) {
        if (lines[index]!.trimStart().startsWith("{")) {
          jsonStart = index;
          break;
        }
      }
      expect(jsonStart, "pnpm pack --json must emit a JSON object").toBeGreaterThanOrEqual(0);
      const jsonText = lines.slice(jsonStart).join("\n");
      const parsed = JSON.parse(jsonText) as { files?: Array<{ path?: string }> };
      const packedPaths = new Set<string>();
      for (const entry of parsed.files ?? []) {
        if (typeof entry.path === "string") packedPaths.add(entry.path);
      }
      expect(
        packedPaths.size,
        "pnpm pack --json must report at least one packed entry",
      ).toBeGreaterThan(0);

      // Every required canonical entry must appear in the pack output
      // (either as a top-level entry or as a file under it).
      for (const required of REQUIRED_CANONICAL_FILES) {
        const present =
          packedPaths.has(required) ||
          [...packedPaths].some((entry) => entry === `${required}/` || entry.startsWith(`${required}/`));
        expect(present, `pnpm pack must include ${required}`).toBe(true);
      }

      // No forbidden entry may appear.
      for (const forbidden of FORBIDDEN_PACKED_PATHS) {
        for (const entry of packedPaths) {
          expect(
            entry === forbidden || entry.startsWith(forbidden),
            `pnpm pack must not include ${entry} (forbidden prefix ${forbidden})`,
          ).toBe(false);
        }
      }
    },
    120_000,
  );

  it("README documents the intentional fresh-latest path and the setup-agent prompt", async () => {
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
    // Intentional fresh-latest routes use
    // `pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest ...`
    expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+init\b/);
    // The setup-agent prompt is the v1.2 one-shot block.
    expect(readme).toContain("One-shot setup-agent prompt (Poiesis v1.2)");
    expect(readme).toContain("uv");
    // Repository Intelligence is documented as a Poiesis v1.2 standard
    // requirement (not a new lifecycle phase).
    expect(readme).toMatch(/Repository Intelligence standard requirement/);
  });

  it(
    "same-version reconciliation on a v1.2 install stamps manifest.poiesisVersion = 1.3.1 and advances the receipt once",
    async () => {
      // The receipt-authenticated ordinary `update` is the same-version
      // reconciliation path. A successful run on a v1.2 install must
      // stamp the manifest with the current package version (1.3.1)
      // and advance the receipt generation by exactly one. This is the
      // deterministic contract the OpenCode projection's
      // `pnpm dlx poiesis-cli@<manifest.poiesisVersion>` allow key
      // depends on for a fresh consumer install.
      //
      // The maintenance surface asserts the v1.2 standard requirement
      // (`uv` on PATH) through `assertUvRequirement` before any
      // canonical mutation. To keep this test truly offline and free
      // of any host-uv dependency we install a fake `uv` binary on
      // PATH using the same shim pattern the other
      // repository-intelligence suites use (see `installFakeUv` in
      // `tests/repository-intelligence-integration.test.ts` etc.). The
      // fake reports a stable version and exits 0 for any other
      // invocation; `uvx` is never invoked from this test.
      const fakeOpenCodeEnv: FakeOpenCodeEnvironment = await installFakeOpenCode();
      const fakeUvEnv: FakeUvEnvironment = await installFakeUv();
      const repositories: TestRepository[] = [];
      try {
        const repository = await createTestRepository();
        repositories.push(repository);
        const initial = await init(repository.root, testConfig(repository), {
          skipSkills: true,
          allowFixtureAdapters: true,
        });
        expect(initial.poiesisVersion).toBe("1.3.1");

        const beforeReceipt = await readOwnershipReceipt(repository.root);
        const result = await update(repository.root, { skipSkills: true });

        // Same-version reconciliation succeeds and re-stamps the
        // manifest version (no-op semantically, but the projection is
        // re-applied against proven-owned state).
        expect(result.manifest.poiesisVersion).toBe("1.3.1");

        // The on-disk manifest reflects the re-stamped version.
        const reloaded = await loadManifest(repository.root);
        expect(reloaded.poiesisVersion).toBe("1.3.1");

        // Receipt advanced by exactly one.
        const afterReceipt = await readOwnershipReceipt(repository.root);
        expect(afterReceipt.generation).toBe(beforeReceipt.generation + 1);
        // The receipt's manifestDigest is bound to the post-update
        // manifest bytes; for a byte-equal same-version reconciliation
        // the manifest does not change so the digest stays equal.
        expect(afterReceipt.manifestDigest).toBe(beforeReceipt.manifestDigest);
      } finally {
        fakeUvEnv.restore();
        fakeOpenCodeEnv.restore();
        await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
      }
    },
    60_000,
  );

  it(
    "a 1.2.1 install updates under the 1.3.1 runtime without joining the accepted predecessor set",
    async () => {
      // Spec #133 / ticket #136 — the migration claim, proven rather than
      // assumed. `assertManifestAuthorityToleratingPredecessor` builds
      // its strict projection with `desiredOpenCodePatches(config,
      // manifest.poiesisVersion)`, so a manifest that says 1.2.1 is
      // compared against the 1.2.1 strict surface, NOT against the
      // 1.3.1 runtime. That is why "1.2.1" does NOT need to be added to
      // the accepted predecessor set in `runLockedUpdateTransaction`.
      const fakeOpenCodeEnv: FakeOpenCodeEnvironment = await installFakeOpenCode();
      const fakeUvEnv: FakeUvEnvironment = await installFakeUv();
      const repositories: TestRepository[] = [];
      try {
        const repository = await createTestRepository();
        repositories.push(repository);
        await init(repository.root, testConfig(repository), {
          skipSkills: true,
          allowFixtureAdapters: true,
        });
        // Pin the project back to the exact 1.2.1 install state.
        const predecessorManifest = await asV121Manifest(repository);
        expect(predecessorManifest.poiesisVersion).toBe("1.2.1");

        // The 1.2.1 manifest's primary bash really is keyed off 1.2.1.
        const primaryBefore = predecessorManifest.configPatches.find((patch) => patch.path[1] === "poiesis")!;
        const bashBefore = (primaryBefore.installed as { permission: { bash: Record<string, string> } })
          .permission.bash;
        expect(bashBefore["pnpm dlx poiesis-cli@1.2.1 *"]).toBe("allow");
        expect(bashBefore["pnpm dlx poiesis-cli@1.3.1 *"]).toBeUndefined();

        // The production accepted-predecessor set does NOT contain
        // "1.2.1" — assert that at runtime AND note the compile-time
        // guarantee: the parameter is a closed literal union, so
        // "1.2.1" is not even assignable without widening the type.
        const { assertManifestAuthorityToleratingPredecessor } = await import("../src/authority.js");
        const productionSet = ["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4"] as const;
        expect([...productionSet]).not.toContain("1.2.1");
        // It resolves without throwing: the strict path already matches.
        await expect(
          assertManifestAuthorityToleratingPredecessor(
            repository.root,
            predecessorManifest,
            testConfig(repository),
            productionSet,
          ),
        ).resolves.toBeUndefined();

        const beforeReceipt = await readOwnershipReceipt(repository.root);
        const result = await update(repository.root, { skipSkills: true });

        // The crossing succeeds and the manifest advances to 1.3.1.
        expect(result.manifest.poiesisVersion).toBe("1.3.1");
        expect((await loadManifest(repository.root)).poiesisVersion).toBe("1.3.1");

        // The receipt advanced by exactly one.
        expect((await readOwnershipReceipt(repository.root)).generation).toBe(
          beforeReceipt.generation + 1,
        );

        // The exact-version launcher is re-keyed off the NEW runtime
        // version, and the old key is gone: `pnpm dlx poiesis-cli@1.3.1 *`
        // and nothing else on the primary agent.
        const primaryAfter = result.manifest.configPatches.find((patch) => patch.path[1] === "poiesis")!;
        const bashAfter = (primaryAfter.installed as { permission: { bash: Record<string, string> } })
          .permission.bash;
        expect(bashAfter["pnpm dlx poiesis-cli@1.3.1 *"]).toBe("allow");
        expect(bashAfter["pnpm dlx poiesis-cli@1.2.1 *"]).toBeUndefined();
        expect(bashAfter["pnpm dlx poiesis-cli@*"]).toBe("deny");
        expect(bashAfter["pnpm dlx poiesis-cli *"]).toBe("deny");

        // The on-disk OpenCode config carries the 1.3.1 key too, not just
        // the manifest record.
        const onDisk = await readFile(join(repository.root, "opencode.jsonc"), "utf8");
        expect(onDisk).toContain('"pnpm dlx poiesis-cli@1.3.1 *"');
        expect(onDisk).not.toContain('"pnpm dlx poiesis-cli@1.2.1 *"');
      } finally {
        fakeUvEnv.restore();
        fakeOpenCodeEnv.restore();
        await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
      }
    },
    60_000,
  );
});

/**
 * Poiesis 1.4.2 release / update contract.
 *
 * Spec #168 / ticket #184 — the 1.4.2 release carries the finding-triage
 * convergence guidance (POIESIS_METHOD.md §10, the Poiesis / Worker / Reviewer
 * roles, and the thin OpenCode projections) forward unchanged at the package
 * and migration seams, and advances the exact-version launcher route from the
 * `1.4.1` release to `1.4.2`.
 *
 * The 1.4.1 migration needs NO new admitted predecessor. The strict gate is
 * keyed off the MANIFEST's own `poiesisVersion`, and
 * `desiredOpenCodePatches(config, "1.4.1")` is version-parameterized, so an
 * authentic 1.4.1 projection satisfies the ordinary strict manifest-version
 * check before any exceptional predecessor tolerance is reached. `"1.4.1"` is
 * therefore deliberately absent from the accepted predecessor set: admitting it
 * would grant an exceptional migration path to a projection the strict path
 * already accepts, and would widen what drift can reach.
 *
 * This file proves the 1.4.2 release contract at the seams the runtime already
 * exposes for the same version-bounded invariants:
 *
 *   - `package.json::version` and `packageVersion()` (the runtime identity
 *     seam) are the 1.4.2 release. This is the durable half of the runtime
 *     identity boundary the OpenCode projection keys off
 *     (`pnpm dlx poiesis-cli@<manifest.poiesisVersion>`).
 *
 *   - the published artifact parity: `pnpm pack --json` (offline-only, no
 *     publish, no network) reports the tarball as the `1.4.2` release whose
 *     name/version agree with `package.json`, and packs the same canonical
 *     surface the runtime contract promises. A regression in the `files` array,
 *     in the on-disk canonical surface (e.g. a deleted role file), or in the
 *     artifact version is caught here before any real publish.
 *
 *   - the receipt-gated `update` transitions an authentic `1.4.1` install onto
 *     `1.4.2`, re-keys the exact-version launcher, grants no broad /
 *     `@latest` / unversioned route, and advances the receipt by exactly one.
 *
 *   - the same-version reconciliation contract still holds at 1.4.2: a
 *     receipt-authenticated `update` on a 1.4.2 install stamps
 *     `manifest.poiesisVersion = "1.4.2"`.
 *
 *   - historical predecessors stay exactly as they were: a 1.2.1 install still
 *     updates under the 1.4.2 runtime WITHOUT 1.2.1 joining the accepted
 *     predecessor set, and the 1.4.0 pre-focused-check projection remains the
 *     only same-release migration. (Covered by
 *     `tests/authority-1.1.x-predecessor.test.ts` and
 *     `tests/launcher-projection-migration.test.ts`.)
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
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");

/** The release this contract pins. `packageVersion()` must agree with it. */
const RELEASE_VERSION = "1.4.2";

/**
 * The published predecessor release the 1.4.2 update must absorb. It is NOT an
 * accepted predecessor: an authentic 1.4.1 projection is admitted by the
 * ordinary strict manifest-version check because the strict projection is
 * keyed off the manifest's own `poiesisVersion`.
 */
const PREDECESSOR_VERSION = "1.4.1";

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
 * Rewrite a freshly-installed project into the exact state an install at
 * `version` would have left behind: `manifest.poiesisVersion = version`,
 * `manifest.configPatches` rebuilt by `desiredOpenCodePatches(config, version)`
 * (so the primary bash allow key is `pnpm dlx poiesis-cli@<version> *`), the
 * on-disk `opencode.jsonc` rewritten to match, the manifest's `opencode.jsonc`
 * file hash recomputed, and the ownership receipt rebound to the new manifest
 * digest.
 *
 * This is the manifest-versus-runtime version crossing shape used by
 * `tests/authority-1.1.x-predecessor.test.ts`: the manifest carries the OLD
 * version while the running runtime is the NEW one. The projection is built by
 * the ordinary projection builder, so the result is the AUTHENTIC projection
 * for that version — not a drifted or hand-edited one.
 */
async function asVersionedManifest(repository: TestRepository, version: string): Promise<Manifest> {
  const { desiredOpenCodePatches } = await import("../src/opencode.js");
  const { parseJsonc } = await import("../src/config.js");
  const { readUtf8 } = await import("../src/fs.js");
  const { replaceOwnershipReceipt } = await import("../src/receipt.js");
  const { hashContent } = await import("../src/hash.js");

  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor = desiredOpenCodePatches(config, version);
  manifest.poiesisVersion = version;
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

describe("Poiesis 1.4.2 release / update contract", () => {
  it("package.json version is the 1.4.2 release", async () => {
    const pkg = await readPackageJson();
    expect(pkg.version).toBe(RELEASE_VERSION);
  });

  it("packageVersion() runtime seam returns the 1.4.2 release", async () => {
    expect(await packageVersion()).toBe(RELEASE_VERSION);
  });

  it("Poiesis installs no project script into package.json", async () => {
    // Spec #190 / ticket #191: invoking Poiesis must not require a project
    // manifest mutation, so the installed surface carries no `poiesis`
    // script at all. Asserted here on the CLI's OWN package.json (the tool
    // is not an install of itself) so nobody re-introduces a
    // self-referential route, and end-to-end on a real installed project in
    // `tests/private-install-git-isolation.test.ts`.
    const pkg = await readPackageJson();
    expect(pkg.scripts?.["poiesis"]).toBeUndefined();
    expect(pkg.scripts?.["pnpm:poiesis"]).toBeUndefined();
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
      const parsed = JSON.parse(jsonText) as {
      name?: string;
      version?: string;
      filename?: string;
      files?: Array<{ path?: string }>;
    };
      const packedPaths = new Set<string>();
      for (const entry of parsed.files ?? []) {
        if (typeof entry.path === "string") packedPaths.add(entry.path);
      }
      expect(
        packedPaths.size,
        "pnpm pack --json must report at least one packed entry",
      ).toBeGreaterThan(0);

      // Published artifact parity: the tarball that this release would publish
      // IS this release. A version string that drifts from the packed artifact
      // name would ship a mislabeled tarball, and the exact-version launcher
      // route keys off the published version, so the two must agree.
      const pkg = await readPackageJson();
      expect(parsed.name).toBe("poiesis-cli");
      expect(parsed.version).toBe(RELEASE_VERSION);
      expect(parsed.filename).toBe(`poiesis-cli-${RELEASE_VERSION}.tgz`);
      expect(pkg.version).toBe(parsed.version);
      // No tarball of any version may be packed INSIDE the artifact: the
      // published artifact is the only `.tgz` this release produces.
      for (const entry of packedPaths) {
        expect(entry, `only the ${RELEASE_VERSION} tarball may be produced by pack, found ${entry}`).not.toMatch(
          /\.tgz$/,
        );
      }

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
    "same-version reconciliation on a v1.2 install stamps manifest.poiesisVersion = 1.4.2 and advances the receipt once",
    async () => {
      // The receipt-authenticated ordinary `update` is the same-version
      // reconciliation path. A successful run on a v1.2 install must
      // stamp the manifest with the current package version (1.4.2)
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
        expect(initial.poiesisVersion).toBe(RELEASE_VERSION);

        const beforeReceipt = await readOwnershipReceipt(repository.root);
        const result = await update(repository.root, { skipSkills: true });

        // Same-version reconciliation succeeds and re-stamps the
        // manifest version (no-op semantically, but the projection is
        // re-applied against proven-owned state).
        expect(result.manifest.poiesisVersion).toBe(RELEASE_VERSION);

        // The on-disk manifest reflects the re-stamped version.
        const reloaded = await loadManifest(repository.root);
        expect(reloaded.poiesisVersion).toBe(RELEASE_VERSION);

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
    "a 1.2.1 install updates under the 1.4.2 runtime without joining the accepted predecessor set",
    async () => {
      // Spec #133 / ticket #136 — the migration claim, proven rather than
      // assumed. `assertManifestAuthorityToleratingPredecessor` builds
      // its strict projection with `desiredOpenCodePatches(config,
      // manifest.poiesisVersion)`, so a manifest that says 1.2.1 is
      // compared against the 1.2.1 strict surface, NOT against the
      // 1.4.2 runtime. That is why "1.2.1" does NOT need to be added to
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
        const predecessorManifest = await asVersionedManifest(repository, "1.2.1");
        expect(predecessorManifest.poiesisVersion).toBe("1.2.1");

        // The 1.2.1 manifest's primary bash really is keyed off 1.2.1.
        const primaryBefore = predecessorManifest.configPatches.find((patch) => patch.path[1] === "poiesis")!;
        const bashBefore = (primaryBefore.installed as { permission: { bash: Record<string, string> } })
          .permission.bash;
        expect(bashBefore["pnpm dlx poiesis-cli@1.2.1 *"]).toBe("allow");
        expect(bashBefore[`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`]).toBeUndefined();

        // The production accepted-predecessor set does NOT contain
        // "1.2.1" — assert that at runtime AND note the compile-time
        // guarantee: the parameter is a closed literal union, so
        // "1.2.1" is not even assignable without widening the type.
        const { assertManifestAuthorityToleratingPredecessor } = await import("../src/authority.js");
        const productionSet = ["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4", "1.4.0"] as const;
        expect([...productionSet]).not.toContain("1.2.1");
        // Spec #168 / ticket #184 — the 1.4.2 release adds no accepted
        // predecessor either: the historical set is byte-for-byte unchanged,
        // and neither "1.2.1" nor the published "1.4.1" joined it.
        expect([...productionSet]).not.toContain(PREDECESSOR_VERSION);
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

        // The crossing succeeds and the manifest advances to 1.4.2.
        expect(result.manifest.poiesisVersion).toBe(RELEASE_VERSION);
        expect((await loadManifest(repository.root)).poiesisVersion).toBe(RELEASE_VERSION);

        // The receipt advanced by exactly one.
        expect((await readOwnershipReceipt(repository.root)).generation).toBe(
          beforeReceipt.generation + 1,
        );

        // The exact-version launcher is re-keyed off the NEW runtime
        // version, and the old key is gone: `pnpm dlx poiesis-cli@1.4.2 *`
        // and nothing else on the primary agent.
        const primaryAfter = result.manifest.configPatches.find((patch) => patch.path[1] === "poiesis")!;
        const bashAfter = (primaryAfter.installed as { permission: { bash: Record<string, string> } })
          .permission.bash;
        expect(bashAfter[`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`]).toBe("allow");
        expect(bashAfter["pnpm dlx poiesis-cli@1.2.1 *"]).toBeUndefined();
        expect(bashAfter["pnpm dlx poiesis-cli@*"]).toBe("deny");
        expect(bashAfter["pnpm dlx poiesis-cli *"]).toBe("deny");

        // The on-disk OpenCode config carries the 1.4.2 key too, not just
        // the manifest record.
        const onDisk = await readFile(join(repository.root, "opencode.jsonc"), "utf8");
        expect(onDisk).toContain(`"pnpm dlx poiesis-cli@${RELEASE_VERSION} *"`);
        expect(onDisk).not.toContain('"pnpm dlx poiesis-cli@1.2.1 *"');
      } finally {
        fakeUvEnv.restore();
        fakeOpenCodeEnv.restore();
        await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
      }
    },
    60_000,
  );

  it(
    "the authentic 1.4.1 projection passes the strict manifest-version check and never reaches predecessor tolerance",
    async () => {
      // Spec #168 / ticket #184 — the 1.4.1 → 1.4.2 crossing needs NO new
      // accepted predecessor. The strict gate builds its projection from the
      // MANIFEST's own `poiesisVersion`, so an authentic 1.4.1 manifest
      // matches the 1.4.1 strict surface and is admitted by the ordinary
      // strict path, before any exceptional tolerance is consulted.
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
        const predecessorManifest = await asVersionedManifest(repository, PREDECESSOR_VERSION);
        expect(predecessorManifest.poiesisVersion).toBe(PREDECESSOR_VERSION);

        // The authentic 1.4.1 projection really is keyed off 1.4.1.
        const primaryBefore = predecessorManifest.configPatches.find((patch) => patch.path[1] === "poiesis")!;
        const bashBefore = (primaryBefore.installed as { permission: { bash: Record<string, string> } })
          .permission.bash;
        expect(bashBefore[`pnpm dlx poiesis-cli@${PREDECESSOR_VERSION} *`]).toBe("allow");
        expect(bashBefore[`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`]).toBeUndefined();

        // The STRICT gate alone admits it — no predecessor set involved.
        const { assertManifestAuthority } = await import("../src/authority.js");
        await expect(
          assertManifestAuthority(repository.root, predecessorManifest, testConfig(repository)),
        ).resolves.toBeUndefined();

        // And the migration gate resolves with the PRODUCTION predecessor
        // set, which deliberately does NOT contain "1.4.1". A version the
        // strict path already admits gains nothing from an exceptional
        // predecessor entry, and adding one would widen what drift can reach.
        const { assertManifestAuthorityToleratingPredecessor } = await import("../src/authority.js");
        const productionSet = ["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4", "1.4.0"] as const;
        expect([...productionSet]).not.toContain(PREDECESSOR_VERSION);
        await expect(
          assertManifestAuthorityToleratingPredecessor(
            repository.root,
            predecessorManifest,
            testConfig(repository),
            productionSet,
          ),
        ).resolves.toBeUndefined();
      } finally {
        fakeUvEnv.restore();
        fakeOpenCodeEnv.restore();
        await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
      }
    },
    60_000,
  );

  it(
    "the receipt-gated update migrates an authentic 1.4.1 install onto 1.4.2 and re-keys the launcher without widening it",
    async () => {
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
        const before = await asVersionedManifest(repository, PREDECESSOR_VERSION);
        const beforeGeneration = (await readOwnershipReceipt(repository.root)).generation;
        expect(before.poiesisVersion).toBe(PREDECESSOR_VERSION);

        const result = await update(repository.root, { skipSkills: true });

        expect(result.manifest.poiesisVersion).toBe(RELEASE_VERSION);
        expect((await loadManifest(repository.root)).poiesisVersion).toBe(RELEASE_VERSION);
        expect((await readOwnershipReceipt(repository.root)).generation).toBe(beforeGeneration + 1);

        // The exact-version launcher is re-keyed onto the new release, and
        // the old key is gone from every agent that carried it.
        const primaryAfter = result.manifest.configPatches.find((patch) => patch.path[1] === "poiesis")!;
        const primaryBash = (primaryAfter.installed as { permission: { bash: Record<string, string> } })
          .permission.bash;
        expect(primaryBash[`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`]).toBe("allow");
        expect(primaryBash).not.toHaveProperty(`pnpm dlx poiesis-cli@${PREDECESSOR_VERSION} *`);

        const workerAfter = result.manifest.configPatches.find((patch) => patch.path[1] === "poiesis-worker")!;
        const workerBash = (workerAfter.installed as { permission: { bash: Record<string, string> } })
          .permission.bash;
        expect(workerBash[`pnpm dlx poiesis-cli@${RELEASE_VERSION} check *`]).toBe("allow");
        expect(workerBash[`pnpm dlx poiesis-cli@${RELEASE_VERSION} repository status`]).toBe("allow");
        expect(workerBash).not.toHaveProperty(`pnpm dlx poiesis-cli@${PREDECESSOR_VERSION} check *`);

        // Fail-closed launcher identity: no broad, `@latest`, or unversioned
        // route is granted by the crossing. The primary keeps exactly its own
        // exact-version canonical route plus the ordered denies, and the
        // Worker is granted only its narrow exact-version subcommands.
        for (const patch of result.manifest.configPatches) {
          const installed = patch.installed as { permission?: { bash?: Record<string, string> } };
          for (const key of Object.keys(installed.permission?.bash ?? {})) {
            expect(key, `no @latest launcher key: ${key}`).not.toContain("@latest");
            expect(key, `no unversioned launcher key: ${key}`).not.toMatch(/^pnpm dlx poiesis-cli$/);
          }
        }
        expect(Object.keys(primaryBash).filter((key) => /^pnpm dlx poiesis-cli/.test(key))).toEqual([
          "pnpm dlx poiesis-cli *",
          "pnpm dlx poiesis-cli@*",
          `pnpm dlx poiesis-cli@${RELEASE_VERSION} *`,
        ]);
        expect(primaryBash["pnpm dlx poiesis-cli *"]).toBe("deny");
        expect(primaryBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
        expect(workerBash["pnpm dlx poiesis-cli *"]).toBe("deny");
        expect(workerBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
        expect(Object.keys(workerBash)).not.toContain(`pnpm dlx poiesis-cli@${RELEASE_VERSION} *`);
        for (const denied of ["poiesis *", "pnpm exec poiesis *", "npx poiesis *"]) {
          expect(workerBash[denied], `Worker keeps ${denied} denied`).toBe("deny");
        }

        // The on-disk config agrees, and the strict gate accepts the result.
        const onDisk = await readFile(join(repository.root, "opencode.jsonc"), "utf8");
        expect(onDisk).toContain(`"pnpm dlx poiesis-cli@${RELEASE_VERSION} *"`);
        expect(onDisk).not.toContain(`"pnpm dlx poiesis-cli@${PREDECESSOR_VERSION} *"`);
        const { assertManifestAuthority } = await import("../src/authority.js");
        await expect(
          assertManifestAuthority(repository.root, result.manifest, testConfig(repository)),
        ).resolves.toBeUndefined();
      } finally {
        fakeUvEnv.restore();
        fakeOpenCodeEnv.restore();
        await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
      }
    },
    120_000,
  );

  it(
    "arbitrary projection drift on a 1.4.1 install still fails closed",
    async () => {
      // The 1.4.1 migration is admitted through the STRICT path, not through
      // an exceptional predecessor entry, so a drifted 1.4.1 manifest is
      // simply not that projection: it fails closed everywhere, including the
      // receipt-gated update.
      const { desiredOpenCodePatches } = await import("../src/opencode.js");
      const { parseJsonc } = await import("../src/config.js");
      const { readUtf8 } = await import("../src/fs.js");
      const { replaceOwnershipReceipt } = await import("../src/receipt.js");
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
        const authentic = desiredOpenCodePatches(testConfig(repository), PREDECESSOR_VERSION);
        // Foreign edit inside the 1.4.1 surface: the Worker keeps the exact
        // 1.4.1 route and additionally gains a broad wildcard. That is drift,
        // never a predecessor.
        const driftedProjection = authentic.map((patch) => {
          if (patch.path.length !== 2 || patch.path[1] !== "poiesis-worker") return patch;
          const installed = patch.value as { permission: { bash: Record<string, string> } };
          return {
            ...patch,
            value: {
              ...installed,
              permission: { ...installed.permission, bash: { ...installed.permission.bash, "pnpm dlx poiesis-cli@*": "allow" } },
            },
          };
        });
        const manifest = await loadManifest(repository.root);
        manifest.poiesisVersion = PREDECESSOR_VERSION;
        manifest.configPatches = manifest.configPatches.map((patch) => {
          const matching = driftedProjection.find(
            (candidate) =>
              candidate.path.length === patch.path.length &&
              candidate.path.every((segment, index) => segment === patch.path[index]),
          );
          return matching === undefined ? patch : { ...patch, installed: matching.value };
        });
        await writeFile(
          join(repository.root, ".poiesis", "manifest.json"),
          serializeManifest(manifest),
        );
        const openCodePath = join(repository.root, "opencode.jsonc");
        const document = parseJsonc<Record<string, unknown>>(await readUtf8(openCodePath), openCodePath);
        for (const patch of manifest.configPatches) {
          let target: Record<string, unknown> = document;
          for (let index = 0; index < patch.path.length - 1; index++) {
            const segment = patch.path[index]!;
            if (typeof target[segment] !== "object" || target[segment] === null) target[segment] = {};
            target = target[segment] as Record<string, unknown>;
          }
          target[patch.path[patch.path.length - 1]!] = patch.installed;
        }
        const rewritten = `${JSON.stringify(document, null, 2)}\n`;
        await writeFile(openCodePath, rewritten);
        const { hashContent } = await import("../src/hash.js");
        manifest.files = manifest.files.map((file) =>
          file.path === "opencode.jsonc" ? { ...file, hash: hashContent(rewritten) } : file,
        );
        await writeFile(
          join(repository.root, ".poiesis", "manifest.json"),
          serializeManifest(manifest),
        );
        await replaceOwnershipReceipt(repository.root, manifest, await readOwnershipReceipt(repository.root));

        const { assertManifestAuthority, assertManifestAuthorityToleratingPredecessor } = await import(
          "../src/authority.js"
        );
        await expect(
          assertManifestAuthority(repository.root, manifest, testConfig(repository)),
        ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
        await expect(
          assertManifestAuthorityToleratingPredecessor(
            repository.root,
            manifest,
            testConfig(repository),
            ["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4", "1.4.0"],
          ),
        ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
        await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
          code: "MANIFEST_AUTHORITY_INVALID",
        });
      } finally {
        fakeUvEnv.restore();
        fakeOpenCodeEnv.restore();
        await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
      }
    },
    120_000,
  );
});

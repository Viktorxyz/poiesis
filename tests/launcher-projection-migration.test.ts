/**
 * Spec #168 / ticket #174 — compatible migration onto the authoritative
 * launcher projection.
 *
 * Ticket #173 (the narrow focused-check allow for the Worker) changed the
 * exact current OpenCode projection without bumping the runtime version, so a
 * project installed by an EARLIER image of the SAME release now carries a
 * manifest whose `configPatches` no longer match `desiredOpenCodePatches`.
 * Before this ticket that manifest was admitted by NEITHER the strict check
 * nor any accepted predecessor, so the receipt-authenticated `update` — the
 * only migration boundary — failed closed with `MANIFEST_AUTHORITY_INVALID`
 * and the installed project could never reach the faster authoritative flow.
 *
 * This file proves the compatible migration closes that hole WITHOUT widening
 * the launcher surface:
 *
 *   1. Current install: the exact current projection is admitted by the
 *      strict gate, unchanged.
 *   2. Predecessor: the exact pre-focused-check same-release projection is
 *      admitted ONLY by the explicitly accepted version set.
 *   3. Drift: a manifest that drifts from BOTH the current and the
 *      predecessor projection still fails closed.
 *   4. Receipt-gated `update` transitions the pre-focused-check manifest onto
 *      the current projection, advances the receipt generation by exactly
 *      one, and never grants a broad / `@latest` / unversioned launcher route.
 *   5. `doctor` reports the drifted-by-one-release install as a FAIL, not a
 *      bypass: read-only diagnosis stays strict.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertManifestAuthority,
  assertManifestAuthorityToleratingPredecessor,
  predecessorProjectionPreFocusedCheck,
} from "../src/authority.js";
import { parseJsonc } from "../src/config.js";
import { readUtf8 } from "../src/fs.js";
import { doctor, init, packageVersion, update } from "../src/maintenance.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { readOwnershipReceipt, replaceOwnershipReceipt } from "../src/receipt.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

async function installFakeUv(): Promise<FakeUvEnvironment> {
  const { chmod, mkdir, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-174-"));
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

/** The accepted-predecessor set the receipt-gated `update` passes. */
const UPDATE_PREDECESSOR_VERSIONS = ["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4", "1.4.0"] as const;

function workerBash(manifest: Manifest): Record<string, string> {
  const patch = manifest.configPatches.find((p) => p.path.length === 2 && p.path[1] === "poiesis-worker");
  if (patch === undefined) throw new Error("manifest carries no poiesis-worker patch");
  return (patch.installed as { permission: { bash: Record<string, string> } }).permission.bash;
}

function primaryBash(manifest: Manifest): Record<string, string> {
  const patch = manifest.configPatches.find((p) => p.path.length === 2 && p.path[1] === "poiesis");
  if (patch === undefined) throw new Error("manifest carries no poiesis patch");
  return (patch.installed as { permission: { bash: Record<string, string> } }).permission.bash;
}

/** Rewrite `opencode.jsonc` so every manifest patch is reflected on disk. */
async function writeOpenCodeFromManifest(repository: TestRepository, manifest: Manifest): Promise<void> {
  const path = join(repository.root, "opencode.jsonc");
  const document = parseJsonc<Record<string, unknown>>(await readUtf8(path), path);
  for (const patch of manifest.configPatches) {
    let target: Record<string, unknown> = document;
    for (let i = 0; i < patch.path.length - 1; i++) {
      const segment = patch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) target[segment] = {};
      target = target[segment] as Record<string, unknown>;
    }
    target[patch.path[patch.path.length - 1]!] = patch.installed;
  }
  await writeFile(path, JSON.stringify(document, null, 2) + "\n");
}

/**
 * The pre-focused-check projection derived INDEPENDENTLY of the runtime
 * helper under test: exactly the current projection minus the single
 * focused-check allow. Keeping the fixture free of the helper is what makes
 * the migration tests below honest — they fail today because the authority
 * gate refuses the projection, not because the helper is missing.
 */
function preFocusedCheckProjection(manifest: Manifest): Array<{ path: string[]; value: unknown }> {
  return manifest.configPatches.map((patch) => {
    if (patch.path.length !== 2 || patch.path[1] !== "poiesis-worker") return { path: patch.path, value: patch.installed };
    const installed = patch.installed as { permission: { bash: Record<string, string> } };
    const bash = { ...installed.permission.bash };
    for (const key of Object.keys(bash)) {
      if (/\scheck \*$/.test(key)) delete bash[key];
    }
    return { path: patch.path, value: { ...installed, permission: { ...installed.permission, bash } } };
  });
}

/**
 * Downgrade a current install to the pre-focused-check same-release
 * projection and rebind the receipt, so the ONLY thing standing between the
 * project and the migration is the authority gate under test.
 */
async function asPreFocusedCheckInstall(repository: TestRepository): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  const predecessor = preFocusedCheckProjection(manifest);
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) => p.path.length === patch.path.length && p.path.every((s, i) => s === patch.path[i]),
    );
    return matching === undefined ? patch : { ...patch, installed: matching.value };
  });
  await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  await writeOpenCodeFromManifest(repository, manifest);
  await replaceOwnershipReceipt(repository.root, manifest, await readOwnershipReceipt(repository.root));
  return manifest;
}

describe("Spec #168 / ticket #174 — compatible launcher projection migration", () => {
  let opencode: FakeOpenCodeEnvironment;
  let uv: FakeUvEnvironment;
  const repositories: TestRepository[] = [];

  beforeEach(async () => {
    opencode = await installFakeOpenCode();
    uv = await installFakeUv();
  });

  afterEach(async () => {
    uv.restore();
    opencode.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("names a pre-focused-check predecessor that differs from the current projection in exactly one key", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const manifest = await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const version = await packageVersion();
    const predecessor = predecessorProjectionPreFocusedCheck(testConfig(repository), version);

    expect(predecessor.map((patch) => patch.path.join("\0"))).toEqual(manifest.configPatches.map((patch) => patch.path.join("\0")));

    const currentWorker = workerBash(manifest);
    const predecessorWorker = (
      predecessor.find((p) => p.path.length === 2 && p.path[1] === "poiesis-worker")!.value as {
        permission: { bash: Record<string, string> };
      }
    ).permission.bash;

    expect(currentWorker[`pnpm dlx poiesis-cli@${version} check *`]).toBe("allow");
    expect(predecessorWorker).not.toHaveProperty(`pnpm dlx poiesis-cli@${version} check *`);
    expect(Object.keys(predecessorWorker)).toEqual(Object.keys(currentWorker).filter((key) => key !== `pnpm dlx poiesis-cli@${version} check *`));
    for (const [key, value] of Object.entries(predecessorWorker)) {
      expect(currentWorker[key], `predecessor key ${key}`).toBe(value);
    }
  }, 60_000);

  it("admit-miss: the strict current gate rejects the pre-focused-check projection", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const manifest = await asPreFocusedCheckInstall(repository);
    await expect(
      assertManifestAuthority(repository.root, manifest, testConfig(repository)),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
  }, 60_000);

  it("drift-rejected: a manifest that drifts from BOTH the current and the predecessor projection still fails closed", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const manifest = await asPreFocusedCheckInstall(repository);
    // Foreign edit inside the admitted predecessor surface: the Repository
    // Intelligence allow is re-pointed at a different runtime version. This is
    // drift, not a predecessor, and must never be migrated.
    const drifted = manifest.configPatches.map((patch) => {
      if (patch.path.length !== 2 || patch.path[1] !== "poiesis-worker") return patch;
      const installed = patch.installed as { permission: { bash: Record<string, string> } };
      return { ...patch, installed: { ...installed, permission: { ...installed.permission, bash: { ...installed.permission.bash, "pnpm dlx poiesis-cli@9.9.9 repository status": "allow" } } } };
    });
    manifest.configPatches = drifted;
    await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
    await writeOpenCodeFromManifest(repository, manifest);
    await replaceOwnershipReceipt(repository.root, manifest, await readOwnershipReceipt(repository.root));

    await expect(
      assertManifestAuthorityToleratingPredecessor(repository.root, manifest, testConfig(repository), [...UPDATE_PREDECESSOR_VERSIONS]),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
    await expect(
      update(repository.root, { skipSkills: true }),
    ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
  }, 120_000);

  it("receipt-gated update installs the current projection onto a pre-focused-check install without widening the launcher", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const before = await asPreFocusedCheckInstall(repository);
    const beforeGeneration = (await readOwnershipReceipt(repository.root)).generation;
    const version = await packageVersion();
    expect(workerBash(before)).not.toHaveProperty(`pnpm dlx poiesis-cli@${version} check *`);

    const result = await update(repository.root, { skipSkills: true });

    expect(result.manifest.poiesisVersion).toBe(version);
    // The projection the manifest records is the current one.
    const afterWorker = workerBash(result.manifest);
    expect(afterWorker[`pnpm dlx poiesis-cli@${version} check *`]).toBe("allow");
    // Fail-closed launcher: no broad, `@latest`, or unversioned route is
    // introduced by the migration.
    expect(afterWorker["pnpm dlx poiesis-cli@*"]).toBe("deny");
    expect(afterWorker["pnpm dlx poiesis-cli *"]).toBe("deny");
    expect(afterWorker["poiesis *"]).toBe("deny");
    expect(afterWorker["pnpm exec poiesis *"]).toBe("deny");
    expect(afterWorker["npx poiesis *"]).toBe("deny");
    expect(afterWorker).not.toHaveProperty(`pnpm dlx poiesis-cli@${version} *`);
    for (const key of Object.keys(afterWorker)) {
      expect(key, `no off-version or latest launcher key: ${key}`).not.toContain("@latest");
    }
    // The primary keeps its own exact-version canonical route, unchanged.
    expect(primaryBash(result.manifest)[`pnpm dlx poiesis-cli@${version} *`]).toBe("allow");
    // Receipt advanced by exactly one generation and re-bound to the new manifest.
    const afterReceipt = await readOwnershipReceipt(repository.root);
    expect(afterReceipt.generation).toBe(beforeGeneration + 1);
    const onDisk = await loadManifest(repository.root);
    await expect(assertManifestAuthority(repository.root, onDisk, testConfig(repository))).resolves.toBeUndefined();
  }, 180_000);

  it("doctor reports the pre-focused-check install as a fail rather than bypassing it", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    await asPreFocusedCheckInstall(repository);
    const report = await doctor(repository.root);
    expect(report.ok).toBe(false);
    const manifest = report.checks.find((check) => check.id === "manifest");
    expect(manifest?.status).toBe("fail");
    expect((manifest?.details as { code?: string } | undefined)?.code).toBe("MANIFEST_AUTHORITY_INVALID");
  }, 120_000);

  it("the pre-focused-check projection is keyed off the supplied version, not the running runtime", async () => {
    const config = testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" });
    const { setRuntimePackageVersionOverrideForTest } = await import("../src/maintenance.js");
    const baseline = JSON.stringify(predecessorProjectionPreFocusedCheck(config, "1.4.0"));
    try {
      setRuntimePackageVersionOverrideForTest("9.9.9-fake");
      expect(JSON.stringify(predecessorProjectionPreFocusedCheck(config, "1.4.0"))).toBe(baseline);
    } finally {
      setRuntimePackageVersionOverrideForTest(null);
    }
    const other = predecessorProjectionPreFocusedCheck(config, "1.4.1");
    const keys = (other.find((p) => p.path[1] === "poiesis-worker")!.value as { permission: { bash: Record<string, string> } })
      .permission.bash;
    expect(keys["pnpm dlx poiesis-cli@1.4.1 repository status"]).toBe("allow");
    expect(keys).not.toHaveProperty("pnpm dlx poiesis-cli@1.4.0 repository status");
    // The published contract file keeps the migration documented.
    const compatibility = await readFile(join(import.meta.dirname, "..", "COMPATIBILITY.md"), "utf8");
    expect(compatibility).toContain("pre-focused-check");
  });
});
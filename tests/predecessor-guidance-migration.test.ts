/**
 * Spec #227 / ticket #229 — authentic published-predecessor guidance migration.
 *
 * Ordinary release bumps (1.8.0 → 1.8.1) need no exceptional predecessor entry:
 * the strict gate keys off the MANIFEST's own `poiesisVersion`, so a project
 * installed by published `1.8.0` carries that release's authentic projection and
 * file hashes and is admitted before any predecessor tolerance is consulted.
 * This suite proves that path with REAL published `poiesis-cli@1.8.0` canon
 * bytes (npm pack), not relabelled current-workspace docs:
 *
 *   1. Trusted install recording authentic 1.8.0 primary role + agent guidance
 *      hashes and the exact 1.8.0 projection passes the shared update gate and
 *      migrates onto the current package version, rewriting guidance and
 *      advancing the ownership receipt by exactly one generation.
 *   2. Tampered on-disk guidance (bytes no longer match the recorded hash) is
 *      refused with `FILE_OWNERSHIP_LOST` before any rewrite.
 *   3. A receipt rebound onto a foreign digest is refused at the receipt gate.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertManifestAuthority } from "../src/authority.js";
import { hashContent } from "../src/hash.js";
import { doctor, init, packageVersion, update } from "../src/maintenance.js";
import { loadManifest, serializeManifest, type Manifest } from "../src/manifest.js";
import { desiredOpenCodePatches } from "../src/opencode.js";
import { parseJsonc } from "../src/config.js";
import { readUtf8 } from "../src/fs.js";
import {
  assertOwnershipReceipt,
  ownershipReceiptLocation,
  readOwnershipReceipt,
  replaceOwnershipReceipt,
} from "../src/receipt.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

/** Immediate published predecessor absorbed on the ordinary strict path. */
const PREDECESSOR_VERSION = "1.8.0";

/** Primary canon surfaces this ticket rewrote; migration must carry authentic predecessor bytes. */
const PRIMARY_GUIDANCE = [
  {
    packageSource: "POIESIS_ROLE_POIESIS.md",
    destination: ".poiesis/roles/poiesis.md",
  },
  {
    packageSource: "OPENCODE_AGENT_POIESIS.md",
    destination: ".opencode/agents/poiesis.md",
  },
] as const;

const PREDECESSOR_TARBALL_CACHE = join(tmpdir(), "poiesis-predecessor-tarball-cache-1.8.0");

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

async function predecessorTarball(): Promise<string> {
  await mkdir(PREDECESSOR_TARBALL_CACHE, { recursive: true });
  const expectedName = `poiesis-cli-${PREDECESSOR_VERSION}.tgz`;
  const expectedPath = join(PREDECESSOR_TARBALL_CACHE, expectedName);
  try {
    await access(expectedPath);
    return expectedPath;
  } catch {
    // Not cached yet.
  }
  const packed = spawnSync(
    "npm",
    ["pack", `poiesis-cli@${PREDECESSOR_VERSION}`, "--pack-destination", PREDECESSOR_TARBALL_CACHE, "--silent"],
    { encoding: "utf8" },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack poiesis-cli@${PREDECESSOR_VERSION} failed: ${packed.stderr}`);
  }
  const packedName = packed.stdout.trim().split("\n").pop() ?? "";
  if (packedName !== expectedName) {
    await rm(join(PREDECESSOR_TARBALL_CACHE, packedName), { force: true });
    throw new Error(`Unexpected tarball filename for poiesis-cli@${PREDECESSOR_VERSION}: ${packedName}`);
  }
  return expectedPath;
}

/** Read one package-root file from the published predecessor tarball (authentic bytes). */
async function readPredecessorPackageFile(relativePath: string): Promise<string> {
  const tarball = await predecessorTarball();
  const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (listed.status !== 0) {
    throw new Error(`tar -tzf failed: ${listed.stderr}`);
  }
  const entry = listed.stdout
    .split(/\r?\n/)
    .find((line) => line === `package/${relativePath}` || line.endsWith(`/${relativePath}`));
  if (entry === undefined) {
    throw new Error(`Published ${PREDECESSOR_VERSION} tarball lacks ${relativePath}`);
  }
  const extracted = spawnSync("tar", ["-xOzf", tarball, entry], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (extracted.status !== 0) {
    throw new Error(`tar extract ${entry} failed: ${extracted.stderr}`);
  }
  return extracted.stdout;
}

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
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Downgrade a current install onto authentic published `1.8.0` primary guidance
 * bytes + the exact `1.8.0` projection, with matching recorded hashes and a
 * rebound receipt — the ordinary strict-path predecessor shape.
 */
async function asAuthenticPredecessorGuidanceInstall(repository: TestRepository): Promise<{
  manifest: Manifest;
  guidance: Record<string, string>;
}> {
  const guidance: Record<string, string> = {};
  for (const entry of PRIMARY_GUIDANCE) {
    const bytes = await readPredecessorPackageFile(entry.packageSource);
    guidance[entry.destination] = bytes;
    await writeFile(join(repository.root, entry.destination), bytes);
  }

  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessorPatches = desiredOpenCodePatches(config, PREDECESSOR_VERSION);
  manifest.poiesisVersion = PREDECESSOR_VERSION;
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessorPatches.find(
      (candidate) =>
        candidate.path.length === patch.path.length &&
        candidate.path.every((segment, index) => segment === patch.path[index]),
    );
    return matching === undefined ? patch : { ...patch, installed: matching.value };
  });
  manifest.files = manifest.files.map((file) => {
    const authentic = guidance[file.path];
    if (authentic === undefined) return file;
    return { ...file, hash: hashContent(authentic) };
  });
  await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  await writeOpenCodeFromManifest(repository, manifest);
  await replaceOwnershipReceipt(repository.root, manifest, await readOwnershipReceipt(repository.root));
  return { manifest, guidance };
}

describe("Spec #227 / ticket #229 — authentic 1.8.0 predecessor guidance migration", () => {
  it("published 1.8.0 primary guidance is authentic predecessor canon, not relabelled current", async () => {
    const currentRole = await readFile(join(import.meta.dirname, "..", "POIESIS_ROLE_POIESIS.md"), "utf8");
    const currentAgent = await readFile(join(import.meta.dirname, "..", "OPENCODE_AGENT_POIESIS.md"), "utf8");
    const predecessorRole = await readPredecessorPackageFile("POIESIS_ROLE_POIESIS.md");
    const predecessorAgent = await readPredecessorPackageFile("OPENCODE_AGENT_POIESIS.md");

    expect(hashContent(predecessorRole)).not.toBe(hashContent(currentRole));
    expect(hashContent(predecessorAgent)).not.toBe(hashContent(currentAgent));
    // Current 1.8.1 notice shape is not on the published predecessor.
    expect(predecessorRole).not.toMatch(/Dostupan je Poiesis/);
    expect(predecessorAgent).not.toMatch(/Dostupan je Poiesis/);
    // Authentic 1.8.0 ROLE named only the exact-dlx latest route (the gap this ticket closed).
    expect(predecessorRole).toMatch(/poiesis-cli@<manifest\.poiesisVersion>\s+latest/);
    expect(predecessorRole).not.toMatch(/pnpm poiesis latest/);
  }, 120_000);

  it("receipt-gated update migrates authentic 1.8.0 guidance + projection onto current, advancing receipt once", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const currentVersion = await packageVersion();
    expect(currentVersion).not.toBe(PREDECESSOR_VERSION);

    const receiptBeforeDowngrade = await readOwnershipReceipt(repository.root);
    const { guidance } = await asAuthenticPredecessorGuidanceInstall(repository);
    const predecessorManifest = await loadManifest(repository.root);
    expect(predecessorManifest.poiesisVersion).toBe(PREDECESSOR_VERSION);
    for (const entry of PRIMARY_GUIDANCE) {
      const recorded = predecessorManifest.files.find((file) => file.path === entry.destination);
      expect(recorded?.hash).toBe(hashContent(guidance[entry.destination]!));
      expect(await readFile(join(repository.root, entry.destination), "utf8")).toBe(guidance[entry.destination]);
    }

    // Ordinary strict path admits authentic predecessor keyed off its own version.
    await assertManifestAuthority(repository.root, predecessorManifest, testConfig(repository));
    await assertOwnershipReceipt(repository.root, predecessorManifest);

    const receiptBeforeUpdate = await readOwnershipReceipt(repository.root);
    expect(receiptBeforeUpdate.generation).toBe(receiptBeforeDowngrade.generation + 1);
    expect(receiptBeforeUpdate.manifestDigest).not.toBe(receiptBeforeDowngrade.manifestDigest);

    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.poiesisVersion).toBe(currentVersion);

    const receiptAfter = await readOwnershipReceipt(repository.root);
    expect(receiptAfter.generation).toBe(receiptBeforeUpdate.generation + 1);
    expect(receiptAfter.installationId).toBe(receiptBeforeUpdate.installationId);
    expect(receiptAfter.manifestDigest).not.toBe(receiptBeforeUpdate.manifestDigest);

    // Guidance rewritten from current package canon (localized notice + all routes).
    const roleAfter = await readFile(join(repository.root, ".poiesis/roles/poiesis.md"), "utf8");
    const agentAfter = await readFile(join(repository.root, ".opencode/agents/poiesis.md"), "utf8");
    expect(roleAfter).toMatch(/Dostupan je Poiesis/);
    expect(roleAfter).toMatch(/pnpm poiesis latest/);
    expect(roleAfter).toMatch(/npm run poiesis -- latest/);
    expect(agentAfter).toMatch(/Dostupan je Poiesis/);
    expect(hashContent(roleAfter)).not.toBe(hashContent(guidance[".poiesis/roles/poiesis.md"]!));

    const report = await doctor(repository.root);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "receipt")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "hashes")?.status).toBe("pass");
  }, 120_000);

  it("refuses tampered predecessor guidance whose bytes no longer match the recorded hash", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    await asAuthenticPredecessorGuidanceInstall(repository);

    await writeFile(
      join(repository.root, ".poiesis/roles/poiesis.md"),
      "# tampered guidance\nnot the recorded predecessor bytes\n",
    );

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "FILE_OWNERSHIP_LOST",
      details: { path: ".poiesis/roles/poiesis.md" },
    });
    expect((await loadManifest(repository.root)).poiesisVersion).toBe(PREDECESSOR_VERSION);
  }, 120_000);

  it("refuses a receipt that no longer authenticates the predecessor manifest digest", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    await asAuthenticPredecessorGuidanceInstall(repository);
    const receiptPath = await ownershipReceiptLocation(repository.root);
    const existing = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    // Foreign digest written directly: replaceOwnershipReceipt always rebinds
    // to the live manifest digest, so only a raw write can forge a mismatch.
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...existing, manifestDigest: "a".repeat(64) }, null, 2)}\n`,
    );

    await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({
      code: "OWNERSHIP_RECEIPT_MISMATCH",
    });
    expect((await loadManifest(repository.root)).poiesisVersion).toBe(PREDECESSOR_VERSION);
  }, 120_000);
});

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec #120 / ticket #124 — Foundation v1.2 rename / update.
 *
 * The parent Spec binds the canonical Foundation document to v1.2 and
 * requires:
 *
 *   - The single canonical Foundation lives at
 *     `POIESIS_FOUNDATION_v1.2.md`; the prior v1.1 file is removed
 *     because Git history already preserves v1.1 and a parallel file
 *     that looks canonical invites drift.
 *   - The Foundation keeps the harness-neutral "Repository Intelligence"
 *     vocabulary in the canonical semantics sections.
 *   - The Foundation records the current implementation engine
 *     (Graphify) explicitly so the engine pin can be changed without
 *     rewriting the harness-neutral canon.
 *
 * The Foundation is NOT a consumer-projection file: it stays in the
 * GitHub repository and is not shipped in the npm tarball, so the
 * negative patterns from `repository-intelligence-v1.2-guidance.test.ts`
 * do not apply. The Foundation may mention "Graphify" because the
 * Foundation is the design record, not Author-facing canon.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

const FOUNDATION_HEADER =
  /Foundation v1\.2|POIESIS_FOUNDATION_v1\.2|Status.*v1\.2/i;

const REPOSITORY_INTELLIGENCE_NAMED = "Repository Intelligence";

const GRAPHIFY_AS_ENGINE =
  /current implementation[\s\S]*[Gg]raphify|default engine[\s\S]*[Gg]raphify|implementation engine[\s\S]*[Gg]raphify|[Gg]raphify[\s\S]*default engine/i;

const VERSION_ANCHOR = "v1.2";

// Spec #120 / ticket #126 — the Foundation must prescribe the SAME
// Graphify invocation shape that the runtime actually issues. The
// pinned engine is Graphify 0.9.70 (per `GRAPHIFY_VERSION` in
// `src/repository-intelligence.ts`); 0.9.70's supported flags are
// `extract <root> --code-only --no-cluster --out <generation>` and
// `update <root> --out <generation>` (the runtime builds these
// argvs in `refreshRepositoryIntelligence` at the bottom of
// `src/repository-intelligence.ts`). `--no-viz` was an older
// visualization-suppression flag that is not in the supported
// 0.9.70 surface; the Foundation MUST NOT prescribe it.
const FOUNDATION_REFRESH_ARGV = /extract[^`\n]*--code-only[^`\n]*--no-cluster[^`\n]*--out[^`\n]*<generation>|extract[^`\n]*<root>[^`\n]*--code-only[^`\n]*--no-cluster[^`\n]*--out/i;

const FOUNDATION_UPDATE_ARGV = /update[^`\n]*--out[^`\n]*<generation>|update[^`\n]*<root>[^`\n]*--out/i;

const FOUNDATION_NO_VIZ = /--no-viz/;

describe("Spec #120 / ticket #124 Foundation v1.2 rename / update", () => {
  it("POIESIS_FOUNDATION_v1.2.md exists as the single canonical Foundation file", () => {
    const path = join(REPO_ROOT, "POIESIS_FOUNDATION_v1.2.md");
    expect(existsSync(path), `${path} must exist as the single canonical Foundation`).toBe(true);
  });

  it("POIESIS_FOUNDATION_v1.1.md is removed (Git history preserves the prior version)", () => {
    const legacyPath = join(REPO_ROOT, "POIESIS_FOUNDATION_v1.1.md");
    expect(
      existsSync(legacyPath),
      `${legacyPath} must be removed so the canonical Foundation is singular`,
    ).toBe(false);
  });

  it("POIESIS_FOUNDATION_v1.2.md records Foundation v1.2 in its header", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).toMatch(FOUNDATION_HEADER);
    expect(foundation).toContain(VERSION_ANCHOR);
  });

  it("POIESIS_FOUNDATION_v1.2.md uses the harness-neutral 'Repository Intelligence' vocabulary in canonical semantics", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).toContain(REPOSITORY_INTELLIGENCE_NAMED);
  });

  it("POIESIS_FOUNDATION_v1.2.md records Graphify as the current default implementation engine behind the Repository Intelligence concept", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).toMatch(GRAPHIFY_AS_ENGINE);
  });

  it("POIESIS_FOUNDATION_v1.2.md preserves the exact-candidate Proof identity contract (any mutation invalidates Proof for the prior candidate)", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    // The Foundation is the design record; the operational identity
    // fields (`candidateSha`, `candidateTree`, etc.) live in the
    // canonical Method and role files, not the Foundation. The
    // Foundation's binding contract is: the exact candidate identity
    // is preserved across Proof / Publish / Preview, and any
    // mutation invalidates Proof for the prior candidate.
    expect(foundation).toMatch(/exact candidate|exact-candidate/i);
    expect(foundation).toMatch(/any[\s\S]{0,200}?mutation[\s\S]{0,200}?invalidates Proof|mutation invalidates Proof/i);
    // The Foundation must NOT record Repository Intelligence cache
    // state or graph hashes as durable Proof identity. Graph hashes /
    // cache state are explicitly excluded from Proof identity per the
    // parent Spec.
    expect(foundation).not.toMatch(/graphHash|graph_hash|cacheState|cache_state|repositoryIntelligenceHash/i);
  });

  it("POIESIS_FOUNDATION_v1.2.md states that Repository Intelligence does not create a new lifecycle phase", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).toMatch(/no new lifecycle|not[^.]*new lifecycle phase|not[^.]*new lifecycle stage|inside existing phases/i);
  });

  it("POIESIS_FOUNDATION_v1.2.md states that derived Repository Intelligence is non-canonical and may be deleted / rebuilt", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).toMatch(/rebuildable[^.]*non-canonical|non-canonical[^.]*derived|deleted and rebuilt|may be deleted/i);
  });

  it("POIESIS_FOUNDATION_v1.2.md requires consequential INFERRED / AMBIGUOUS graph conclusions to verify the current source", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    // The Foundation's binding contract for Repository Intelligence is
    // that INFERRED relationships are useful leads that must be
    // verified against the relevant current source before they become a
    // consequential commitment, and AMBIGUOUS relationships are
    // navigation hints only. The exact wording uses "verified" (past
    // participle) in the existing v1.2 Foundation text; the test
    // pattern is loose enough to accept either "verify current source"
    // or "verified against the relevant current source".
    expect(foundation).toMatch(/INFERRED[\s\S]*verif|verif[\s\S]*INFERRED/i);
    expect(foundation).toMatch(/AMBIGUOUS[\s\S]*navigation|AMBIGUOUS[\s\S]*hint/i);
    expect(foundation).toMatch(/verif[\s\S]{0,200}?current source|current source[\s\S]{0,200}?verif/i);
  });

  it("POIESIS_FOUNDATION_v1.2.md prescribes the runtime's actual Graphify extract argv (--code-only --no-cluster --out <generation>)", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).toMatch(FOUNDATION_REFRESH_ARGV);
  });

  it("POIESIS_FOUNDATION_v1.2.md prescribes the runtime's actual Graphify update argv (--out <generation>)", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).toMatch(FOUNDATION_UPDATE_ARGV);
  });

  it("POIESIS_FOUNDATION_v1.2.md does not prescribe the unsupported `--no-viz` flag (not in the pinned Graphify 0.9.70 surface)", async () => {
    const foundation = await readRepoFile("POIESIS_FOUNDATION_v1.2.md");
    expect(foundation).not.toMatch(FOUNDATION_NO_VIZ);
  });

  it("README_DOWNLOAD_LIST.md ships as the v1.2 source bundle (the singular canonical Foundation)", async () => {
    // Spec #120 / ticket #126 — the v1.2 release must not leave a
    // v1.1 download list in the repo. The canonical Foundation is
    // singular (`POIESIS_FOUNDATION_v1.2.md`); the v1.1 Foundation
    // is preserved only in Git history. A parallel v1.1 download list
    // that still references `POIESIS_FOUNDATION_v1.1.md` would
    // invite drift back to the old canon.
    const downloadList = await readRepoFile("README_DOWNLOAD_LIST.md");
    expect(downloadList).toContain("v1.2");
    expect(downloadList).not.toMatch(/v1\.1/i);
    expect(downloadList).toContain("POIESIS_FOUNDATION_v1.2.md");
    expect(downloadList).not.toMatch(/POIESIS_FOUNDATION_v1\.1\.md/);
  });
});
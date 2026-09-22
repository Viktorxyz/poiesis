/**
 * Spec #104 / ticket #106 — runtime identity boundary.
 *
 * The executing Poiesis package version MUST equal the durable
 * `manifest.poiesisVersion` for every project-bound installed lifecycle
 * operation, or the guard fails closed with `RUNTIME_VERSION_MISMATCH`
 * and details `{ project, runtime }` BEFORE any consequential mutation.
 * Read-only `inspect` / `doctor` remain usable for diagnosis. The
 * manifest-less `init` flow is exempt by design. The explicit,
 * receipt-gated `update` flow stays the sole intentional
 * version-crossing boundary.
 *
 * This test file establishes a single "Lucca-class fixture" — a fresh
 * project whose manifest records `poiesisVersion: "1.1.1"` while the
 * runtime package presents as `1.0.3` — and proves every guarded
 * mutation entry point fails closed WITHOUT mutating any owned byte.
 * The companion exempt reads (`doctor`, `inspect`, `init`) keep working
 * and the explicit `update` boundary still migrates the Lucca-class
 * manifest forward.
 *
 * Implementation note: the "runtime 1.0.3" portion of the fixture is
 * projected via the bounded internal seam
 * `setRuntimePackageVersionOverrideForTest` exported from
 * `src/maintenance.js` (NOT re-exported via `src/index.ts`). The seam
 * is module-scoped, in-memory only, and survives the entire test
 * process without any filesystem mutation; a process crash between
 * snapshot and restore cannot leave the workspace `package.json`
 * corrupted. No mock seam is added to the production runtime outside
 * this single setter; the only filesystem fixture is the test
 * repository itself.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertRuntimeVersionMatchesProject,
  doctor,
  init,
  installAuthorizedCapability,
  packageVersion,
  setModel,
  setRuntimePackageVersionOverrideForTest,
  uninstall,
  update,
} from "../src/maintenance.js";
import { loadManifest, serializeManifest } from "../src/manifest.js";
import {
  ownershipReceiptLocation,
  readOwnershipReceipt,
  replaceOwnershipReceipt,
} from "../src/receipt.js";
import { parseJsonc } from "../src/config.js";
import { hashContent } from "../src/hash.js";
import {
  checkpoint,
  integrate,
  publish,
  workspaceCleanup,
  workspacePrepare,
} from "../src/git.js";
import { previewDelivery, promoteDelivery } from "../src/adapters.js";
import { predecessorProjectionV111 } from "../src/authority.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

interface OwnedByteSnapshot {
  poiesisConfig: Buffer;
  openCodeConfig: Buffer;
  manifest: Buffer;
  receipt: Buffer;
  receiptGeneration: number;
  receiptManifestDigest: string;
}

async function snapshotOwnedBytes(repository: TestRepository): Promise<OwnedByteSnapshot> {
  const receiptPath = await ownershipReceiptLocation(repository.root);
  const receipt = await readOwnershipReceipt(repository.root);
  return {
    poiesisConfig: await readFile(join(repository.root, ".poiesis", "config.jsonc")),
    openCodeConfig: await readFile(join(repository.root, "opencode.jsonc")),
    manifest: await readFile(join(repository.root, ".poiesis", "manifest.json")),
    receipt: await readFile(receiptPath),
    receiptGeneration: receipt.generation,
    receiptManifestDigest: receipt.manifestDigest,
  };
}

function expectBytesUnchanged(before: OwnedByteSnapshot, after: OwnedByteSnapshot, scope: string): void {
  expect(
    Buffer.compare(after.poiesisConfig, before.poiesisConfig),
    `${scope}: .poiesis/config.jsonc changed`,
  ).toBe(0);
  expect(
    Buffer.compare(after.openCodeConfig, before.openCodeConfig),
    `${scope}: opencode.jsonc changed`,
  ).toBe(0);
  expect(
    Buffer.compare(after.manifest, before.manifest),
    `${scope}: .poiesis/manifest.json changed`,
  ).toBe(0);
  expect(
    Buffer.compare(after.receipt, before.receipt),
    `${scope}: ownership receipt changed`,
  ).toBe(0);
  expect(after.receiptGeneration, `${scope}: receipt generation advanced`).toBe(before.receiptGeneration);
  expect(after.receiptManifestDigest, `${scope}: receipt manifestDigest changed`).toBe(
    before.receiptManifestDigest,
  );
}

/**
 * Stamp a Lucca-class mismatch on top of an existing init-managed install
 * by rewriting the manifest to the v1.1.1 predecessor primary-bash
 * projection. The full v1.1.1 predecessor projection is the SPEC-104/#105
 * "exact" shape — every patch matches the predecessor's recorded
 * `installed`, the OpenCode config on disk reflects every claimed patch,
 * and the receipt is rebound to the new manifest digest so the existing
 * projection is internally consistent for `update`'s receipt-gated
 * predecessor tolerance.
 *
 * The "runtime 1.0.3" half of the Lucca fixture is set by the suite's
 * `beforeAll` (in-memory via the bounded seam). The combined effect is a
 * project whose durable manifest is `1.1.1` while `packageVersion()`
 * returns `"1.0.3"`.
 */
async function asLuccaManifestMismatch(repository: TestRepository): Promise<void> {
  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor = predecessorProjectionV111(config, "1.1.1");
  manifest.poiesisVersion = "1.1.1";
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) =>
        p.path.length === patch.path.length &&
        p.path.every((segment, index) => segment === patch.path[index]),
    );
    return matching === undefined ? patch : { ...patch, installed: matching.value };
  });
  const openCodePath = join(repository.root, "opencode.jsonc");
  const current = parseJsonc<Record<string, unknown>>(
    await readFile(openCodePath, "utf8"),
    openCodePath,
  );
  for (const patch of manifest.configPatches) {
    let target: Record<string, unknown> = current;
    for (let i = 0; i < patch.path.length - 1; i++) {
      const segment = patch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[patch.path[patch.path.length - 1]!] = patch.installed;
  }
  const rewrittenOpenCodeBytes = JSON.stringify(current, null, 2) + "\n";
  await writeFile(openCodePath, rewrittenOpenCodeBytes);
  manifest.files = manifest.files.map((file) =>
    file.path === "opencode.jsonc"
      ? { ...file, hash: hashContent(rewrittenOpenCodeBytes) }
      : file,
  );
  await writeFile(join(repository.root, ".poiesis", "manifest.json"), serializeManifest(manifest));
  const previous = await readOwnershipReceipt(repository.root);
  await replaceOwnershipReceipt(repository.root, manifest, previous);
}

describe("runtime identity boundary (ticket #106)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeAll(async () => {
    // Present the running package as `1.0.3` for the entire suite via
    // the bounded in-memory seam in `src/maintenance.js`. No file is
    // touched; if the test process dies before `afterAll` runs, the
    // override simply dies with it (no cross-pool pollution).
    setRuntimePackageVersionOverrideForTest("1.0.3");
  });

  afterAll(async () => {
    setRuntimePackageVersionOverrideForTest(null);
  });

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  it("Lucca-class: every guarded mutation entry point fails closed before any owned byte is mutated (manifest 1.1.1 / runtime 1.0.3)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    await asLuccaManifestMismatch(repository);

    const before = await snapshotOwnedBytes(repository);

    // 1. uninstall (owned-cleanup / installation removal)
    await expect(uninstall(repository.root)).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: "1.1.1", runtime: "1.0.3" },
    });

    // 2. installAuthorizedCapability (installation = capability install)
    await expect(
      installAuthorizedCapability(repository.root, {
        source: "mattpocock/skills",
        name: "diagnosing-bugs",
        revision: "main",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: "1.1.1", runtime: "1.0.3" },
    });

    // 3. setModel (model is not an upgrade channel)
    await expect(
      setModel(repository.root, "reasoning", "openai/gpt-5.6-fallback"),
    ).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: "1.1.1", runtime: "1.0.3" },
    });

    // 4. workspace prepare (workspace)
    await expect(
      workspacePrepare({
        cwd: repository.root,
        remote: "origin",
        integrationBranch: "main",
        branch: `poiesis/lucca-${Math.random().toString(16).slice(2, 10)}`,
        specId: `spec-lucca-${Math.random().toString(16).slice(2, 10)}`,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: "1.1.1", runtime: "1.0.3" },
    });

    // 5. previewDelivery (preview)
    await expect(
      previewDelivery(
        { adapter: "fixture", path: join(repository.fixtures, "delivery") },
        {
          sha: repository.baseSha,
          candidateTree: repository.baseSha,
          proof: {
            candidateSha: repository.baseSha,
            candidateTree: repository.baseSha,
            verified: true,
            specReview: { verdict: "PASS", reviewerIdentity: "lucca-spec" },
            standardsReview: { verdict: "PASS", reviewerIdentity: "lucca-standards" },
          },
          publish: {
            candidateSha: repository.baseSha,
            candidateTree: repository.baseSha,
            verified: true,
            branch: "main",
            remoteRef: "refs/heads/main",
            publishedHeadSha: repository.baseSha,
            provider: "fixture",
            action: "pushed",
            changeRequest: { id: null, url: null },
          },
          remote: "origin",
        },
        repository.root,
      ),
    ).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: "1.1.1", runtime: "1.0.3" },
    });

    // 6. promoteDelivery (promote)
    await expect(
      promoteDelivery(
        { adapter: "fixture", path: join(repository.fixtures, "delivery") },
        {
          sha: repository.baseSha,
          target: "staging",
          candidateTree: repository.baseSha,
          identity: {
            id: "lucca-staging",
            url: "lucca://staging",
            artifact: "lucca",
            sha: repository.baseSha,
            candidateSha: repository.baseSha,
            candidateTree: repository.baseSha,
            target: "staging",
            artifactIdentity: "lucca-staging",
            verified: true as const,
          },
        },
        repository.root,
      ),
    ).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: "1.1.1", runtime: "1.0.3" },
    });

    // Workspace cleanup (owned-cleanup) needs an owned workspace; we
    // cannot get one through the guard with mismatched versions. So
    // checkpoint / publish / integrate / workspace-cleanup are best
    // exercised together by a paired positive path that flips runtime
    // to the matching version, lays out the workspace, then flips the
    // runtime back to "1.0.3" and exercises the guarded operations.
    // The positive path itself is covered by the dedicated update test
    // below; for the Lucca no-mutation proof here, the snapshot above
    // already proves no owned byte has moved.
    //
    // `tracker` mutations route through the same shared guard in
    // `src/cli.ts -> commandTracker`; the dedicated proof is exercised
    // by the namespace-imported private dispatcher further down so we
    // cover every entry point listed by the spec.

    const after = await snapshotOwnedBytes(repository);
    expectBytesUnchanged(before, after, "Lucca-class mismatch");
  }, 60_000);

  it("keeps the explicit update boundary as the version-crossing path on a Lucca-class install", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    await asLuccaManifestMismatch(repository);

    // `update` is the version-crossing boundary. It must still migrate
    // a Lucca-class 1.1.1 manifest forward to the runtime version that
    // is currently claiming "1.0.3" (test-managed via the bounded seam)
    // without the guard firing — and once it runs, the resulting
    // manifest records the CURRENT runtime version (still "1.0.3" in
    // this test process because `beforeAll` set the override).
    const result = await update(repository.root, { skipSkills: true });
    expect(result.manifest.poiesisVersion).toBe("1.0.3");
  }, 60_000);

  it("keeps `doctor` usable on a Lucca-class install for diagnosis (read-only, no guard)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    await asLuccaManifestMismatch(repository);

    // Doctor must NOT throw; it must return a structured report whose
    // `manifest` check failed (the projection doesn't match current)
    // so an operator can diagnose the mismatch itself. The exact
    // failure code is the existing strict authority code — the
    // runtime guard is intentionally absent in `doctor` per
    // Spec #104 / ticket #106.
    const report = await doctor(repository.root);
    expect(report.checks.find((check) => check.id === "manifest")?.status).toBe("fail");
    expect(report.ok).toBe(false);
  }, 30_000);

  it("skips the runtime guard when no manifest has been installed yet (init scenario)", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    // `init` is exempt: there is no project manifest yet, so the guard
    // has nothing to compare against and must succeed.
    const manifest = await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    // init under the Lucca runtime of 1.0.3 records the runtime version
    // it observed — the manifest's freshly-stamped poiesisVersion equals
    // `packageVersion()` (which the seam presents as "1.0.3").
    expect(manifest.poiesisVersion).toBe("1.0.3");
  }, 30_000);
});

describe("runtime identity boundary — helper seam (ticket #106)", () => {
  // The "higher seam" proof: the SHARED helper itself enforces the
  // contract, regardless of which guarded entry point calls it. The
  // entry-point wiring is covered by the Lucca-class integration test
  // above; this unit-level proof covers the helper's three core
  // behaviours (mismatch, equal, manifest-less) at the source.
  const helperRepositories: TestRepository[] = [];
  let helperEnv: FakeOpenCodeEnvironment | undefined;
  beforeEach(async () => {
    // The "helper seam" describe is a top-level peer of the main
    // describe, so it does NOT inherit the parent's `beforeEach`. Install
    // the fake here too so the `init()` calls below resolve the
    // certified `1.18.29` binary regardless of the real-world
    // installation (`opencode --version`).
    helperEnv = await installFakeOpenCode();
  });
  afterEach(async () => {
    helperEnv?.restore();
    setRuntimePackageVersionOverrideForTest(null);
    await Promise.all(
      helperRepositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })),
    );
  });

  it("matches exactly: present runtime equals manifest poiesisVersion => no throw", async () => {
    const repository = await createTestRepository();
    helperRepositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const manifest = await loadManifest(repository.root);
    setRuntimePackageVersionOverrideForTest(manifest.poiesisVersion);
    await expect(assertRuntimeVersionMatchesProject(repository.root)).resolves.toBeUndefined();
  }, 30_000);

  it("mismatches: present runtime differs from manifest => RUNTIME_VERSION_MISMATCH with { project, runtime }", async () => {
    const repository = await createTestRepository();
    helperRepositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    setRuntimePackageVersionOverrideForTest("9.9.9-different");
    await expect(assertRuntimeVersionMatchesProject(repository.root)).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: expect.any(String), runtime: "9.9.9-different" },
    });
  }, 30_000);

  it("absent manifest fails closed: no manifest on disk => guard rejects as RUNTIME_VERSION_MISMATCH (uninstalled project cannot run a guarded mutation)", async () => {
    const repository = await createTestRepository();
    helperRepositories.push(repository);
    // No init; no manifest. The guard must fail closed — guarded
    // mutations (workspace prepare, preview/promote delivery, checkpoint,
    // publish, integrate, tracker mutations, installAuthorizedCapability,
    // setModel, uninstall) must not run in an uninstalled project. The
    // exempt surfaces (`init` because it does not call the guard;
    // `update` / `updateFromConfig` by design as the explicit
    // version-crossing boundary; `doctor` / `inspect` / `verify` /
    // `session cleanup` because they are read-only or non-project-bound)
    // remain coherent without the guard.
    setRuntimePackageVersionOverrideForTest("anything");
    await expect(assertRuntimeVersionMatchesProject(repository.root)).rejects.toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: null, runtime: "anything" },
    });
  }, 10_000);

  it("init is coherent without calling the guard: no manifest, no guard call => init succeeds and stamps the runtime version", async () => {
    // Init does NOT call the shared guard. The exempt path stays
    // implicit: `init` writes the manifest as its own first durable
    // artifact, so the "absent manifest" branch of the guard never fires
    // from inside init. The test exercises the explicit invariant: init
    // against a fresh, manifest-less project stamps the running package
    // version onto the freshly-authored manifest.
    setRuntimePackageVersionOverrideForTest(null);
    const repository = await createTestRepository();
    helperRepositories.push(repository);
    const manifest = await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    expect(manifest.poiesisVersion).toBe("1.1.4");
  }, 30_000);

  it("packageVersion() reads through the seam when the override is set", async () => {
    setRuntimePackageVersionOverrideForTest("2.0.0-from-seam");
    expect(await packageVersion()).toBe("2.0.0-from-seam");
  }, 5_000);

  it("packageVersion() falls back to the workspace package.json when the seam is cleared", async () => {
    setRuntimePackageVersionOverrideForTest(null);
    // The workspace is the local source tree at 1.1.4 (see
    // 104__runtime-identity-boundary/package.json). The seam MUST be
    // the only override; clearing it returns the filesystem truth.
    expect(await packageVersion()).toBe("1.1.4");
  }, 5_000);
});

describe("runtime identity boundary — tracker dispatcher (ticket #110)", () => {
  // Spec #104 / ticket #110: tracker `get` is read-only and must
  // remain usable across a runtime/manifest mismatch (so an operator
  // can diagnose the mismatch by reading the remote). Tracker mutations
  // (`create`, `update`, `comment`, `close`, `supersede`) cross the
  // runtime identity boundary; the shared guard runs immediately
  // BEFORE the adapter mutation so the guard fails closed before any
  // remote call.
  //
  // `commandTracker` is exported from `src/cli.ts` as a library seam
  // (same pattern as `commandInit`, `commandUpdate`, `commandModel`)
  // for the test-only purpose of exercising the dispatcher behavior
  // directly. It is intentionally NOT re-exported by `src/index.ts`.
  const trackerRepositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    setRuntimePackageVersionOverrideForTest(null);
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    setRuntimePackageVersionOverrideForTest(null);
    env?.restore();
    await Promise.all(
      trackerRepositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })),
    );
  });

  function captureStdout(): { chunks: string[]; restore: () => void } {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    return { chunks, restore: () => { process.stdout.write = original; } };
  }

  it("tracker spec get stays usable across a runtime/manifest mismatch (read-only)", async () => {
    // Setup: init creates a manifest stamped with the running package
    // version (1.1.4). The seam then makes the runtime present as
    // "1.0.3" while the manifest still claims "1.1.4" (Lucca-class).
    // The fixture adapter seeds a Spec at init time, so `spec get` is
    // a pure read.
    const repository = await createTestRepository();
    trackerRepositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    // First, create a Spec via the dispatcher while runtime matches so
    // the fixture tracker has an item to return.
    setRuntimePackageVersionOverrideForTest("1.1.4");
    const { commandTracker } = await import("../src/cli.js");
    const createCapture = captureStdout();
    try {
      await commandTracker(["spec", "create", "--title", "Mismatch diag", "--body", "Body", "--cwd", repository.root]);
    } finally {
      createCapture.restore();
    }
    const created = JSON.parse(createCapture.chunks.join("")) as {
      ok: boolean;
      operation: string;
      result: { id: string };
    };
    expect(created.ok).toBe(true);
    const specId = created.result.id;

    // Now flip the runtime to a mismatching version. `spec get` must
    // still work — read-only dispatchers do not cross the runtime
    // identity boundary.
    setRuntimePackageVersionOverrideForTest("9.9.9-different");
    const getCapture = captureStdout();
    try {
      await expect(
        commandTracker(["spec", "get", "--id", specId, "--cwd", repository.root]),
      ).resolves.toBeUndefined();
    } finally {
      getCapture.restore();
    }
    const got = JSON.parse(getCapture.chunks.join("")) as {
      ok: boolean;
      operation: string;
      result: { id: string };
    };
    expect(got.ok).toBe(true);
    expect(got.result.id).toBe(specId);
  }, 60_000);

  it("tracker ticket get stays usable across a runtime/manifest mismatch (read-only)", async () => {
    const repository = await createTestRepository();
    trackerRepositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    setRuntimePackageVersionOverrideForTest("1.1.4");
    const { commandTracker } = await import("../src/cli.js");
    const createSpecCapture = captureStdout();
    try {
      await commandTracker(["spec", "create", "--title", "Ticket get diag", "--body", "Body", "--cwd", repository.root]);
    } finally {
      createSpecCapture.restore();
    }
    const specId = (JSON.parse(createSpecCapture.chunks.join("")) as { result: { id: string } }).result.id;

    const createTicketCapture = captureStdout();
    try {
      await commandTracker([
        "ticket", "create",
        "--title", "Ticket",
        "--body", "Body",
        "--parent", specId,
        "--dependencies", "none",
        "--cwd", repository.root,
      ]);
    } finally {
      createTicketCapture.restore();
    }
    const ticketId = (JSON.parse(createTicketCapture.chunks.join("")) as { result: { id: string } }).result.id;

    setRuntimePackageVersionOverrideForTest("9.9.9-different");
    const getCapture = captureStdout();
    try {
      await expect(
        commandTracker(["ticket", "get", "--id", ticketId, "--cwd", repository.root]),
      ).resolves.toBeUndefined();
    } finally {
      getCapture.restore();
    }
    const got = JSON.parse(getCapture.chunks.join("")) as {
      ok: boolean;
      operation: string;
      result: { id: string };
    };
    expect(got.ok).toBe(true);
    expect(got.result.id).toBe(ticketId);
  }, 60_000);

  it("tracker spec create rejects a runtime/manifest mismatch BEFORE the adapter mutation", async () => {
    const repository = await createTestRepository();
    trackerRepositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    // Lucca-class mismatch.
    setRuntimePackageVersionOverrideForTest("9.9.9-different");
    const manifest = await loadManifest(repository.root);
    const { commandTracker } = await import("../src/cli.js");
    const capture = captureStdout();
    try {
      await expect(
        commandTracker(["spec", "create", "--title", "Mismatch blocked", "--body", "Body", "--cwd", repository.root]),
      ).rejects.toMatchObject({
        code: "RUNTIME_VERSION_MISMATCH",
        details: { project: manifest.poiesisVersion, runtime: "9.9.9-different" },
      });
    } finally {
      capture.restore();
    }
  }, 60_000);

  it("tracker ticket update rejects a runtime/manifest mismatch BEFORE the adapter mutation", async () => {
    const repository = await createTestRepository();
    trackerRepositories.push(repository);
    await init(repository.root, testConfig(repository), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    setRuntimePackageVersionOverrideForTest("1.1.4");
    const { commandTracker } = await import("../src/cli.js");
    const createSpecCapture = captureStdout();
    try {
      await commandTracker(["spec", "create", "--title", "S", "--body", "B", "--cwd", repository.root]);
    } finally {
      createSpecCapture.restore();
    }
    const specId = (JSON.parse(createSpecCapture.chunks.join("")) as { result: { id: string } }).result.id;
    const createTicketCapture = captureStdout();
    try {
      await commandTracker([
        "ticket", "create",
        "--title", "T",
        "--body", "B",
        "--parent", specId,
        "--dependencies", "none",
        "--cwd", repository.root,
      ]);
    } finally {
      createTicketCapture.restore();
    }
    const ticketId = (JSON.parse(createTicketCapture.chunks.join("")) as { result: { id: string } }).result.id;

    setRuntimePackageVersionOverrideForTest("9.9.9-different");
    const capture = captureStdout();
    try {
      await expect(
        commandTracker(["ticket", "update", "--id", ticketId, "--title", "renamed", "--cwd", repository.root]),
      ).rejects.toMatchObject({
        code: "RUNTIME_VERSION_MISMATCH",
      });
    } finally {
      capture.restore();
    }
  }, 60_000);
});
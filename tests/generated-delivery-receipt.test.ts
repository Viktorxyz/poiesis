/**
 * Spec #139 / ticket #165 — a generated delivery target speaks the receipt
 * schema the runtime already validates.
 *
 * The generated `preview`, `staging` and `production` scripts were written to
 * be *inspectable*, not to be *deliverable*. Each one recorded a local
 * `delivery.json` and printed `{ target, candidateSha, candidateTree, artifact }`
 * — and that is not a delivery receipt. `CommandDeliveryAdapter.execute`
 * (`src/adapters.ts`) requires the exact candidate `sha`, the exact
 * `candidateTree`, the exact `target`, `verified: true`, a non-empty
 * `artifactIdentity`, and a string `id` / `url` / `artifact` equal to it. The
 * generated scripts reported none of `sha`, `verified` or `artifactIdentity`, so
 * a fresh project that adopted Poiesis' own defaults got a `poiesis preview`
 * that failed closed with `DELIVERY_IDENTITY_MISMATCH` — Poiesis refusing its
 * own recommended artifact. Two facts kept that invisible: nothing had ever RUN
 * a generated target through the adapter, and the preview body answered with
 * `changeRequest: { id: null, url: null }`, which reads as a produced receipt
 * right up until the validator reads it.
 *
 * The contract this ticket holds, and the production break each half catches:
 *
 *   1. THE VALIDATOR STAYS AUTHORITATIVE. Nothing here relaxes
 *      `CommandDeliveryAdapter`; the generated target is brought up to the
 *      schema, and a target that omits `verified: true` is still refused — the
 *      schema cannot be talked out of by editing a project file.
 *   2. ONE CANDIDATE, ONE IDENTITY. `sha` and `candidateSha` are the same
 *      canonical SHA the argv named, the tree is the repository's, and the
 *      identity is deterministic and target-specific, so a re-run is
 *      recognizably the same delivery. Break: a fresh id per run would make a
 *      second `preview` un-promotable from the first one's receipt.
 *   3. THE CHAIN IS REAL. Staging validates the Preview identity it is given
 *      and mints a NEW identity; Production requires and validates the Staging
 *      identity, preserves its `artifactIdentity` byte-for-byte, exposes it as
 *      `id`, and puts its OWN record at `artifact`. Break: Production minting
 *      its own id breaks the Author authorization that binds to the Staging
 *      artifact.
 *   4. ZERO EFFECTS BEFORE THE CONTRACT IS MET. A malformed source identity, a
 *      target this script does not deliver, a candidate SHA or tree the runtime
 *      did not hand it — each refuses with nothing on disk and `gh` never
 *      invoked. Break: an artifact written before validation is a receipt for a
 *      delivery that did not happen.
 *   5. THE RECORD BEFORE THE REMOTE STEP. The Preview record and receipt exist
 *      on disk before the optional best-effort `gh` step runs, and a recognized
 *      receipt field is never `null`. Break: a project without an authenticated
 *      `gh` gets no artifact, or a `url: null` the runtime reads as a failed
 *      delivery rather than an absent optional step.
 *   6. NOTHING NEW IS OWNED. The generated scripts stay untracked project files
 *      and never become manifest records.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCommandDeliveryAdapter,
  previewDelivery,
  promoteDelivery,
  type DeliveryIdentity,
  type DeliveryResult,
  type ProductionPromotionInput,
  type ProofPayload,
  type StagingPromotionInput,
} from "../src/adapters.js";
import { DELIVERY_TARGETS, deliveryScriptPath, renderDefaultDeliveryScript, type DeliveryTarget } from "../src/delivery-defaults.js";
import { parseJsonc } from "../src/config.js";
import type { PublishEvidence } from "../src/evidence.js";
import { readUtf8 } from "../src/fs.js";
import { publish, resolveTree, workspacePrepare } from "../src/git.js";
import { init } from "../src/maintenance.js";
import { loadManifest } from "../src/manifest.js";
import { run } from "../src/process.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, verifiedProof, type TestRepository } from "./helpers.js";

/**
 * The Poiesis-owned runtime subtree, written as a LITERAL so a drifted
 * production constant cannot redefine the contract these tests pin.
 */
const DELIVERY_RUNTIME = ".poiesis/runtime/delivery";
const FORGE_URL = "https://github.example/poiesis/preview/pull/7";

interface TargetRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface GhStubEnvironment {
  /** Report an authenticated `gh`, and open the change request on `pr create`. */
  authenticate(): void;
  /**
   * Make the stub report, once per invocation, whether `recordPath` existed at
   * the moment `gh` was reached. This is how "the record is established BEFORE
   * the optional remote step" becomes an observation rather than an assumption.
   */
  observeRecord(recordPath: string): void;
  /** Every `gh` invocation the target made, arguments included. */
  invocations(): Promise<string[]>;
  /** The `record:` markers written by `observeRecord`. */
  recordProbes(): Promise<string[]>;
  restore(): void;
}

const ghStubs: GhStubEnvironment[] = [];
const repositories: TestRepository[] = [];
let openCode: FakeOpenCodeEnvironment | undefined;

/**
 * A `gh` stub on `PATH` whose behaviour is switched per test, recording every
 * invocation. The generated Preview target resolves `gh` through `PATH`, so a
 * stub is the only way to reach — and to prove the absence of — its
 * remote-facing step.
 */
async function installGhStub(): Promise<GhStubEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-gh-stub-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const logPath = join(parent, "gh-invocations.log");
  const probePath = join(parent, "gh-record-probe.log");
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ -n "\${POIESIS_TEST_GH_RECORD:-}" ]; then
  if [ -f "\${POIESIS_TEST_GH_RECORD}" ]; then
    printf 'record:present\\n' >> ${JSON.stringify(probePath)}
  else
    printf 'record:absent\\n' >> ${JSON.stringify(probePath)}
  fi
fi
case "$1" in
  auth)
    if [ "\${POIESIS_TEST_GH_AUTH:-0}" = "1" ]; then exit 0; fi
    printf 'gh: not authenticated\\n' >&2
    exit 1
    ;;
  pr)
    if [ "\${POIESIS_TEST_GH_AUTH:-0}" != "1" ]; then
      printf 'gh stub must not be asked to open a change request\\n' >&2
      exit 97
    fi
    printf '%s\\n' "\${POIESIS_TEST_GH_URL}"
    exit 0
    ;;
esac
exit 1
`,
  );
  await chmod(gh, 0o755);
  const previous = {
    PATH: process.env.PATH,
    POIESIS_TEST_GH_AUTH: process.env.POIESIS_TEST_GH_AUTH,
    POIESIS_TEST_GH_URL: process.env.POIESIS_TEST_GH_URL,
    POIESIS_TEST_GH_RECORD: process.env.POIESIS_TEST_GH_RECORD,
  };
  process.env.PATH = previous.PATH === undefined || previous.PATH === "" ? bin : `${bin}:${previous.PATH}`;
  process.env.POIESIS_TEST_GH_AUTH = "0";
  process.env.POIESIS_TEST_GH_URL = FORGE_URL;
  delete process.env.POIESIS_TEST_GH_RECORD;
  const markers = async (path: string): Promise<string[]> =>
    existsSync(path) ? (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0) : [];
  const stub: GhStubEnvironment = {
    authenticate: () => {
      process.env.POIESIS_TEST_GH_AUTH = "1";
      process.env.POIESIS_TEST_GH_URL = FORGE_URL;
    },
    observeRecord: (record) => {
      process.env.POIESIS_TEST_GH_RECORD = record;
    },
    invocations: () => markers(logPath),
    recordProbes: () => markers(probePath),
    restore: () => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
  ghStubs.push(stub);
  return stub;
}

/** Materialize a rendered target outside the repository, as `init` would. */
async function renderTarget(repository: TestRepository, target: DeliveryTarget): Promise<string> {
  const directory = join(repository.parent, "rendered", target);
  await mkdir(directory, { recursive: true });
  const script = join(directory, `poiesis-${target}.mjs`);
  await writeFile(script, renderDefaultDeliveryScript(target, "2026-01-01T00:00:00.000Z"), "utf8");
  return script;
}

interface TargetEnvironment {
  sha: string;
  tree: string;
  target: string;
  identity?: unknown;
}

/** Run a target the way the command adapter does: in the candidate's own root. */
async function runTarget(root: string, script: string, environment: TargetEnvironment): Promise<TargetRun> {
  const { sha, tree, target, identity } = environment;
  const result = await run("node", [script, sha, target], {
    cwd: root,
    env: {
      POIESIS_CANDIDATE_SHA: sha,
      POIESIS_CANDIDATE_TREE: tree,
      POIESIS_DELIVERY_TARGET: target,
      ...(identity === undefined ? {} : { POIESIS_DELIVERY_IDENTITY: JSON.stringify(identity) }),
    },
    allowFailure: true,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** The exact source identity each promotion target consumes. */
function previewIdentity(sha: string, tree: string): DeliveryResult {
  return {
    sha,
    candidateSha: sha,
    candidateTree: tree,
    target: "preview",
    artifactIdentity: `poiesis:preview:${sha}`,
    status: "created",
    verified: true,
    id: `poiesis:preview:${sha}`,
  };
}

function stagingIdentity(sha: string, tree: string): DeliveryResult {
  return {
    sha,
    candidateSha: sha,
    candidateTree: tree,
    target: "staging",
    artifactIdentity: `poiesis:staging:${sha}`,
    status: "created",
    verified: true,
    id: `poiesis:staging:${sha}`,
  };
}

/** The on-disk record path a target produces, compared through `realpath`. */
async function recordPath(root: string, target: string, sha: string): Promise<string> {
  return join(await realpath(root), DELIVERY_RUNTIME, target, sha, "delivery.json");
}

function artifactExists(root: string, target: string): boolean {
  return existsSync(join(root, DELIVERY_RUNTIME, target));
}

async function newRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  return repository;
}

beforeEach(async () => {
  openCode = await installFakeOpenCode();
});

afterEach(async () => {
  for (const stub of ghStubs.splice(0)) stub.restore();
  openCode?.restore();
  await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
});

// =========================================================================
// 2. Through the RENDERER: a generated target is a receipt producer.
// =========================================================================

describe("a generated delivery target answers with the receipt the runtime validates", () => {
  it("reports one canonical candidate, a verified target, and a string-carried identity for every target", async () => {
    // Break: the pre-#165 scripts printed no `sha`, no `verified`, and no
    // `artifactIdentity`, so the adapter refused Poiesis' own default target.
    const repository = await newRepository();
    const gh = await installGhStub();
    const tree = await resolveTree(repository.root, repository.baseSha);

    for (const target of DELIVERY_TARGETS) {
      const script = await renderTarget(repository, target);
      const source =
        target === "staging"
          ? previewIdentity(repository.baseSha, tree)
          : target === "production"
            ? stagingIdentity(repository.baseSha, tree)
            : undefined;
      // Production mints nothing: it carries the verified Staging artifact
      // forward, so that is the identity it must report.
      const expectedIdentity = target === "production"
        ? `poiesis:staging:${repository.baseSha}`
        : `poiesis:${target}:${repository.baseSha}`;
      const outcome = await runTarget(repository.root, script, {
        sha: repository.baseSha,
        tree,
        target,
        identity: source,
      });

      expect(outcome.exitCode, `${target}: ${outcome.stderr}`).toBe(0);
      const receipt = JSON.parse(outcome.stdout) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        sha: repository.baseSha,
        candidateSha: repository.baseSha,
        candidateTree: tree,
        target,
        verified: true,
        status: "created",
        artifactIdentity: expectedIdentity,
      });
      // The identity is carried by a string field, and that field is the id.
      expect(receipt.id).toBe(expectedIdentity);
      expect(receipt.artifact).toBe(await recordPath(repository.root, target, repository.baseSha));
      // No recognized field is null: `url: null` is how a target that produced
      // something reads as a target that produced nothing.
      expect(JSON.stringify(receipt)).not.toContain("null");
      expect(await readUtf8(await recordPath(repository.root, target, repository.baseSha))).toContain(
        `"artifactIdentity": "${expectedIdentity}"`,
      );
    }
    // `gh` is probed, and probed only: the stub is unauthenticated here.
    const invocations = (await gh.invocations()).join("\n");
    expect(invocations).toContain("auth status");
    expect(invocations).not.toContain("pr create");
  }, 60_000);

  it("names the same identity and the same record for the same candidate delivered twice", async () => {
    // Break: a per-run id would make the first Preview receipt un-promotable.
    const repository = await newRepository();
    await installGhStub();
    const tree = await resolveTree(repository.root, repository.baseSha);
    const script = await renderTarget(repository, "staging");
    const environment = { sha: repository.baseSha, tree, target: "staging", identity: previewIdentity(repository.baseSha, tree) };

    const first = await runTarget(repository.root, script, environment);
    const second = await runTarget(repository.root, script, environment);

    expect(first.exitCode, first.stderr).toBe(0);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).artifactIdentity).toBe(JSON.parse(first.stdout).artifactIdentity);
    // Staging mints its OWN identity, distinct from the Preview it extends.
    expect(JSON.parse(first.stdout).artifactIdentity).toBe(`poiesis:staging:${repository.baseSha}`);
    expect(JSON.parse(first.stdout).artifactIdentity).not.toBe(`poiesis:preview:${repository.baseSha}`);
  }, 60_000);

  it("writes the record before it ever reaches the optional change request", async () => {
    // Break: a target that opens the change request FIRST leaves an Author
    // with a remote-facing side effect and no artifact when `gh` is slow,
    // unauthenticated, or missing.
    const repository = await newRepository();
    const gh = await installGhStub();
    gh.authenticate();
    const tree = await resolveTree(repository.root, repository.baseSha);
    const script = await renderTarget(repository, "preview");
    gh.observeRecord(await recordPath(repository.root, "preview", repository.baseSha));

    const outcome = await runTarget(repository.root, script, { sha: repository.baseSha, tree, target: "preview" });

    expect(outcome.exitCode, outcome.stderr).toBe(0);
    // Every `gh` the target reached — `auth status` and `pr create` alike —
    // already found the record on disk.
    const probes = await gh.recordProbes();
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((marker) => marker === "record:present")).toBe(true);
  }, 60_000);

  it("keeps the record and the receipt when the optional change request succeeds", async () => {
    // Break: a `gh`-dependent target produces nothing without an authenticated
    // `gh`, or reports `url: null` for a step that simply did not run.
    const repository = await newRepository();
    const gh = await installGhStub();
    gh.authenticate();
    const tree = await resolveTree(repository.root, repository.baseSha);
    const script = await renderTarget(repository, "preview");

    const outcome = await runTarget(repository.root, script, { sha: repository.baseSha, tree, target: "preview" });

    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const receipt = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(receipt.url).toBe(FORGE_URL);
    // The deterministic identity is NOT the forge URL: a re-run must still
    // name the same delivery.
    expect(receipt.artifactIdentity).toBe(`poiesis:preview:${repository.baseSha}`);
    expect(receipt.id).toBe(receipt.artifactIdentity);
    expect(JSON.stringify(receipt)).not.toContain("null");
    expect(await readUtf8(await recordPath(repository.root, "preview", repository.baseSha))).toContain(FORGE_URL);
  }, 60_000);
});

// =========================================================================
// 4. ZERO EFFECTS: the contract is met before the filesystem or `gh`.
// =========================================================================

describe("a generated delivery target refuses a broken contract with nothing on disk", () => {
  it("refuses a target this script does not deliver, as named by argv or by the environment", async () => {
    // Break: running the Preview body under a Staging label publishes a
    // receipt that claims to be a Staging delivery.
    const repository = await newRepository();
    const gh = await installGhStub();
    const tree = await resolveTree(repository.root, repository.baseSha);
    const script = await renderTarget(repository, "preview");

    const byArgv = await runTarget(repository.root, script, { sha: repository.baseSha, tree, target: "staging" });
    expect(byArgv.exitCode).not.toBe(0);
    expect(byArgv.stderr).toContain("staging");
    expect(artifactExists(repository.root, "staging")).toBe(false);

    // The runtime's own environment naming a different target is the same
    // disagreement, reached from the other direction.
    const byEnvironment = await run("node", [script, repository.baseSha, "preview"], {
      cwd: repository.root,
      env: {
        POIESIS_CANDIDATE_SHA: repository.baseSha,
        POIESIS_CANDIDATE_TREE: tree,
        POIESIS_DELIVERY_TARGET: "production",
      },
      allowFailure: true,
    });
    expect(byEnvironment.exitCode).not.toBe(0);
    expect(byEnvironment.stderr).toContain("production");
    expect(artifactExists(repository.root, "preview")).toBe(false);
    expect(await gh.invocations()).toEqual([]);
  }, 60_000);

  it("refuses a candidate SHA or tree the runtime did not hand it", async () => {
    // Break: a receipt bound to a candidate the runtime did not verify is a
    // Preview claim for a commit nobody proved.
    const repository = await newRepository();
    const gh = await installGhStub();
    const tree = await resolveTree(repository.root, repository.baseSha);
    const script = await renderTarget(repository, "preview");
    const other = "c".repeat(40);

    const mismatchedSha = await run("node", [script, repository.baseSha, "preview"], {
      cwd: repository.root,
      env: {
        POIESIS_CANDIDATE_SHA: other,
        POIESIS_CANDIDATE_TREE: tree,
        POIESIS_DELIVERY_TARGET: "preview",
      },
      allowFailure: true,
    });
    expect(mismatchedSha.exitCode).not.toBe(0);
    expect(mismatchedSha.stderr).toContain("candidate sha");
    expect(artifactExists(repository.root, "preview")).toBe(false);

    const mismatchedTree = await run("node", [script, repository.baseSha, "preview"], {
      cwd: repository.root,
      env: {
        POIESIS_CANDIDATE_SHA: repository.baseSha,
        POIESIS_CANDIDATE_TREE: other,
        POIESIS_DELIVERY_TARGET: "preview",
      },
      allowFailure: true,
    });
    expect(mismatchedTree.exitCode).not.toBe(0);
    expect(mismatchedTree.stderr).toContain("candidate tree");
    expect(await gh.invocations()).toEqual([]);
  }, 60_000);

  it("refuses every malformed source identity without writing a record or calling gh", async () => {
    // Break: a promotion that cannot name the exact artifact it extends still
    // leaves a delivery record naming a delivery that never happened.
    const repository = await newRepository();
    const gh = await installGhStub();
    const tree = await resolveTree(repository.root, repository.baseSha);
    const staging = await renderTarget(repository, "staging");
    const production = await renderTarget(repository, "production");
    const other = "c".repeat(40);
    const sha = repository.baseSha;

    const malformed: { label: string; target: string; script: string; identity: unknown; message: string }[] = [
      { label: "absent", target: "staging", script: staging, identity: undefined, message: "POIESIS_DELIVERY_IDENTITY" },
      { label: "not an object", target: "staging", script: staging, identity: ["preview"], message: "JSON object" },
      { label: "a different candidate", target: "staging", script: staging, identity: previewIdentity(other, tree), message: "different candidate" },
      { label: "a different candidate tree", target: "staging", script: staging, identity: previewIdentity(sha, other), message: "different candidate tree" },
      { label: "an unverified source", target: "staging", script: staging, identity: { ...previewIdentity(sha, tree), verified: false }, message: "not been verified" },
      { label: "no artifact identity", target: "staging", script: staging, identity: { ...previewIdentity(sha, tree), artifactIdentity: "" }, message: "artifact identity" },
      { label: "a Staging identity where Preview is required", target: "staging", script: staging, identity: stagingIdentity(sha, tree), message: "preview" },
      { label: "a Preview identity where Staging is required", target: "production", script: production, identity: previewIdentity(sha, tree), message: "staging" },
    ];

    for (const entry of malformed) {
      const outcome = await runTarget(repository.root, entry.script, {
        sha,
        tree,
        target: entry.target,
        identity: entry.identity,
      });
      expect(outcome.exitCode, `${entry.label} must be refused: ${outcome.stderr}`).not.toBe(0);
      expect(outcome.stdout, `${entry.label} must print no receipt`).toBe("");
      expect(outcome.stderr.toLowerCase(), entry.label).toContain(entry.message.toLowerCase());
      expect(artifactExists(repository.root, entry.target), `${entry.label} must leave no record`).toBe(false);
    }
    expect(await gh.invocations()).toEqual([]);
  }, 60_000);
});

// =========================================================================
// 1. The DELIVERY ADAPTER stays authoritative in both directions.
// =========================================================================

describe("the delivery adapter accepts the generated receipt and still refuses a broken one", () => {
  /**
   * Ticket #188: `createCommandDeliveryAdapter` is a package-public factory, so
   * the adapter it returns carries the delivery authority guard. Both tests
   * below therefore install Poiesis first, and the receipt contract they assert
   * is the one an installed project actually experiences. The refusal half of
   * that contract — a deferred install refused through this same factory before
   * any subprocess, artifact, or evidence — is pinned in
   * `tests/deferred-delivery-lifecycle.test.ts`.
   */
  it("promotes a generated preview to a new Staging identity and then to a preserved Production identity", async () => {
    const repository = await newRepository();
    await installGhStub();
    await init(repository.root, testConfig(repository, { withDelivery: false }), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const tree = await resolveTree(repository.root, repository.baseSha);
    const scripts = {
      preview: await renderTarget(repository, "preview"),
      staging: await renderTarget(repository, "staging"),
      production: await renderTarget(repository, "production"),
    };
    const adapter = (target: DeliveryTarget) =>
      createCommandDeliveryAdapter(
        { adapter: "command", command: ["node", scripts[target], "{sha}", "{target}"] },
        repository.root,
      );
    const sha = repository.baseSha;

    const preview = await adapter("preview").preview({
      sha,
      candidateTree: tree,
      proof: proofShell(sha, tree),
      publish: publishEvidence(sha, tree, "main"),
      remote: "origin",
    });
    expect(preview).toMatchObject({
      sha,
      candidateSha: sha,
      candidateTree: tree,
      target: "preview",
      verified: true,
      status: "created",
      artifactIdentity: `poiesis:preview:${sha}`,
    });

    const staging = await adapter("staging").promote({ sha, target: "staging", candidateTree: tree, identity: preview });
    expect(staging).toMatchObject({
      target: "staging",
      verified: true,
      artifactIdentity: `poiesis:staging:${sha}`,
    });
    expect(staging.artifactIdentity).not.toBe(preview.artifactIdentity);

    const production = await adapter("production").promote(
      // The delivery ADAPTER is driven directly here rather than through
      // `promoteDelivery`, so the forwarded proof is the adapter's own delivery
      // contract and is not receipt-authenticated; it stays the structural shell.
      productionInput(sha, tree, staging, proofShell(sha, tree)),
    );
    // Production carries the verified Staging artifact forward, exposes it as
    // its id, and keeps its own record at `artifact`.
    expect(production.artifactIdentity).toBe(staging.artifactIdentity);
    expect(production.id).toBe(staging.artifactIdentity);
    expect(production.artifact).toBe(await recordPath(repository.root, "production", sha));
  }, 60_000);

  it("still refuses a target that reports the candidate but never claims verification", async () => {
    // Break: the schema becomes advisory, and any project file can claim a
    // delivery nobody verified.
    const repository = await newRepository();
    await init(repository.root, testConfig(repository, { withDelivery: false }), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const tree = await resolveTree(repository.root, repository.baseSha);
    const script = join(repository.parent, "unverified-preview.mjs");
    await writeFile(script, UNVERIFIED_TARGET, "utf8");
    const adapter = createCommandDeliveryAdapter(
      { adapter: "command", command: ["node", script, "{sha}", "{target}"] },
      repository.root,
    );

    await expect(
      adapter.preview({
        sha: repository.baseSha,
        candidateTree: tree,
        proof: proofShell(repository.baseSha, tree),
        publish: publishEvidence(repository.baseSha, tree, "main"),
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_VERIFICATION_FAILED" });
  }, 60_000);
});

/**
 * A hand-written target that satisfies every other field of the receipt and
 * deliberately omits `verified: true`. It is written here rather than derived
 * from the generated body so the refusal cannot be an accident of how the
 * template happens to spell that field.
 */
const UNVERIFIED_TARGET = `#!/usr/bin/env node
const [, , sha, target] = process.argv;
const tree = process.env.POIESIS_CANDIDATE_TREE;
const artifactIdentity = "unverified-" + target + "-" + sha;
process.stdout.write(
  JSON.stringify({ sha, candidateSha: sha, candidateTree: tree, target, artifactIdentity, id: artifactIdentity, status: "created" }) + "\\n",
);
`;

// =========================================================================
// 3. Through the PUBLIC API: the whole chain against a local bare remote.
// =========================================================================

/**
 * Spec #168 / ticket #169 + #171 + #186 — a project-bound delivery operation
 * runs in a Poiesis-OWNED candidate workspace, and the proof and Publish
 * evidence it forwards must name the SAME runtime-owned verification receipt
 * that Publish resolved for that exact candidate.
 *
 * This does not change what the two tests below are about. They exercise the
 * GENERATED delivery defaults — the targets, the records each one writes, and
 * the change-request handling — and every one of those assertions is reached
 * exactly as before; the operation simply reaches them the way production
 * reaches them. The generated targets are copied into the candidate because
 * `init` invokes them as a RELATIVE `scripts/...` path resolved against the
 * delivery execution root, and the candidate must therefore carry the same
 * generated targets the primary got.
 */
async function ownedDeliveryCandidate(repository: TestRepository): Promise<{
  root: string;
  proof: ProofPayload;
  publish: PublishEvidence;
}> {
  const workspace = await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch: "poiesis/generated-delivery",
    specId: "spec-generated-delivery",
  });
  const sha = repository.baseSha;
  const tree = await resolveTree(repository.root, sha);
  const proof = await verifiedProof({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    candidateSha: sha,
    candidateTree: tree,
  });
  const published = await publish({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    remote: "origin",
    integrationBranch: "main",
    candidateSha: sha,
    candidateTree: tree,
    provider: "fixture",
    project: repository.fixtures,
    title: "Generated delivery candidate",
    body: "body",
    proof,
  });
  await mkdir(join(workspace.path, "scripts"), { recursive: true });
  for (const target of DELIVERY_TARGETS) {
    await writeFile(
      join(workspace.path, deliveryScriptPath(target)),
      await readFile(join(repository.root, deliveryScriptPath(target)), "utf8"),
      "utf8",
    );
  }
  return { root: workspace.path, proof, publish: published.evidence };
}

describe("a project that took the generated defaults delivers preview, staging and production", () => {
  it("carries one candidate from a local bare remote through all three targets", async () => {
    const repository = await newRepository();
    const gh = await installGhStub();
    await init(repository.root, testConfig(repository, { withDelivery: false }), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const delivery = await installedDelivery(repository.root);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const candidate = await ownedDeliveryCandidate(repository);

    const preview = await previewDelivery(
      delivery.preview,
      {
        sha,
        candidateTree: tree,
        proof: candidate.proof,
        publish: candidate.publish,
        remote: "origin",
      },
      candidate.root,
    );
    expect(preview).toMatchObject({
      sha,
      candidateSha: sha,
      candidateTree: tree,
      target: "preview",
      verified: true,
      status: "created",
      artifactIdentity: `poiesis:preview:${sha}`,
    });
    expect(preview.id).toBe(preview.artifactIdentity);

    const staging = await promoteDelivery(
      delivery.staging,
      { sha, target: "staging", candidateTree: tree, identity: preview } satisfies StagingPromotionInput,
      candidate.root,
    );
    expect(staging).toMatchObject({ target: "staging", verified: true, artifactIdentity: `poiesis:staging:${sha}` });

    const production = await promoteDelivery(
      delivery.production,
      productionInput(sha, tree, staging, candidate.proof),
      candidate.root,
    );
    expect(production).toMatchObject({
      target: "production",
      verified: true,
      artifactIdentity: staging.artifactIdentity,
      id: staging.artifactIdentity,
    });
    expect(production.artifact).toBe(await recordPath(candidate.root, "production", sha));

    // Each target left its own inspectable record, and the ownership boundary
    // is unchanged: derived state, never a manifest record.
    for (const target of DELIVERY_TARGETS) {
      expect(existsSync(await recordPath(candidate.root, target, sha)), target).toBe(true);
    }
    const manifest = await loadManifest(repository.root);
    expect(manifest.files.map((file) => file.path)).not.toContain("scripts/poiesis-preview.mjs");
    expect((await gh.invocations()).join("\n")).not.toContain("pr create");
  }, 180_000);

  it("records an opened change request as a string, and nothing at all when gh is unavailable", async () => {
    // Break: a forge-backed Preview that reports `url: null` reads as a failed
    // delivery, and one that mints its identity from the URL loses determinism.
    const repository = await newRepository();
    const gh = await installGhStub();
    await init(repository.root, testConfig(repository, { withDelivery: false }), {
      skipSkills: true,
      allowFixtureAdapters: true,
    });
    const delivery = await installedDelivery(repository.root);
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const candidate = await ownedDeliveryCandidate(repository);
    const input = {
      sha,
      candidateTree: tree,
      proof: candidate.proof,
      publish: candidate.publish,
      remote: "origin",
    };

    const withoutGh = await previewDelivery(delivery.preview, input, candidate.root);
    expect(withoutGh.url).toBeUndefined();
    expect(withoutGh.artifactIdentity).toBe(`poiesis:preview:${sha}`);

    gh.authenticate();
    const withGh = await previewDelivery(delivery.preview, input, candidate.root);

    expect(withGh.url).toBe(FORGE_URL);
    expect(withGh.artifactIdentity).toBe(withoutGh.artifactIdentity);
    expect(withGh.id).toBe(withGh.artifactIdentity);
  }, 180_000);
});

async function installedDelivery(root: string): Promise<Record<DeliveryTarget, { adapter: string; command: string[] }>> {
  const path = join(root, ".poiesis", "config.jsonc");
  const parsed = parseJsonc<{ delivery: Record<DeliveryTarget, { adapter: string; command: string[] }> }>(
    await readUtf8(path),
    path,
  );
  return parsed.delivery;
}

function productionInput(
  sha: string,
  tree: string,
  staging: DeliveryIdentity,
  proof: ProofPayload,
): ProductionPromotionInput {
  return {
    sha,
    target: "production",
    candidateTree: tree,
    identity: staging,
    productionAuthorization: {
      candidateSha: sha,
      candidateTree: tree,
      stagingArtifactIdentity: staging.artifactIdentity,
      integrationSha: sha,
      authorIdentity: "author-165",
      approved: true,
    },
    integrationRemote: "origin",
    integrationBranch: "main",
    proof,
    integration: {
      candidateSha: sha,
      candidateTree: tree,
      integrationSha: sha,
      integrationTree: tree,
      contentMatchesCandidate: true,
    },
  };
}

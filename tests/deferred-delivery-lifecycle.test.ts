/**
 * Spec #139 / ticket #143 — explicit deferred delivery is a healthy LOCAL
 * lifecycle up to exact-candidate Proof, and a hard block on every
 * delivery-integrated operation.
 *
 * One central internal lifecycle-policy guard reads the authorized installed
 * config — and nothing else, with no auto-resolution and no network — then
 * every gated seam calls it before its first side effect. So a deferred
 * install keeps preparing workspaces, accepting accepted-Review checkpoints,
 * and proving exact candidates, while it can never produce a push, a fetch, a
 * remote revalidation, a delivery subprocess, an integration commit, a remote
 * branch deletion, a worktree removal, evidence, or a success envelope.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap `run` so the test can see exactly which subprocesses the runtime
// reached. The wrapper calls the real runner, so real Git behavior is
// preserved; only the call log is added. See tests/git-lifecycle.test.ts for
// the same seam used for a different purpose.
vi.mock("../src/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process.js")>();
  return { ...actual, run: vi.fn(actual.run) };
});

import {
  DEFERRED_DELIVERY_MODE,
  serializeConfig,
  type PoiesisConfig,
  type ResolvedPoiesisConfig,
} from "../src/config.js";
import {
  createCommandDeliveryAdapter,
  createDeliveryAdapter,
  createFixtureDeliveryAdapter,
  createTrackerAdapter,
  previewDelivery,
  promoteDelivery,
  type DeliveryAdapter,
  type DeliveryIdentity,
  type PreviewDeliveryInput,
  type PreviewDeliveryResult,
  type ProductionPromotionInput,
  type StagingPromotionInput,
} from "../src/adapters.js";
import {
  checkpoint,
  inspect,
  integrate,
  publish,
  resolveTree,
  verify,
  workspaceCleanup,
  workspacePrepare,
  type WorkspaceIdentity,
} from "../src/git.js";
import { assertDeliveryPolicyAllows, DEFERRED_BLOCKED_OPERATIONS, type DeferredBlockedOperation } from "../src/lifecycle-policy.js";
import { commandIntegrate, commandPreview, commandPromote, commandPublish } from "../src/cli.js";
import { doctor, init, updateFromConfig } from "../src/maintenance.js";
import { PoiesisError } from "../src/errors.js";
import { run } from "../src/process.js";
import { createTestRepository, proofShell, publishEvidence, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const BRANCH = "poiesis/spec-1";
const PROBE = "poiesis-delivery-probe.mjs";

/**
 * Subprocess seams a deferred install must never reach. `ls-remote` is the
 * remote revalidation used by Publish, Preview, and workspace cleanup;
 * `worktree remove` and `update-ref -d` are the cleanup teardown; the probe
 * script stands in for any delivery subprocess.
 */
const FORBIDDEN_GIT_SUBCOMMANDS = ["push", "fetch", "ls-remote", "commit-tree", "worktree", "update-ref"] as const;

interface SubprocessCall {
  executable: string;
  args: string[];
}

function markSubprocesses(): number {
  return (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

function subprocessCallsSince(mark: number): SubprocessCall[] {
  return (run as unknown as { mock: { calls: unknown[][] } }).mock.calls.slice(mark).map((call) => ({
    executable: String(call[0]),
    args: Array.isArray(call[1]) ? (call[1] as unknown[]).map(String) : [],
  }));
}

function reachedSideEffects(calls: SubprocessCall[]): string[] {
  const labels: string[] = [];
  for (const call of calls) {
    const subcommand = call.args[0];
    if (call.executable === "git" && subcommand !== undefined && (FORBIDDEN_GIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      labels.push(`git ${subcommand}`);
    }
    if (call.executable === "node" && call.args.some((argument) => argument.endsWith(PROBE))) {
      labels.push(`delivery subprocess: node ${call.args.join(" ")}`);
    }
  }
  return labels;
}

function deferredConfig(repository: TestRepository): PoiesisConfig {
  return {
    schema: 1,
    models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
    repository: { remote: "origin", integrationBranch: "main" },
    tracker: { provider: "fixture", project: join(repository.fixtures, "tracker") },
    delivery: { mode: DEFERRED_DELIVERY_MODE },
    verification: { commands: ["test -f feature.txt"] },
  };
}

function probeScript(artifactRoot: string): string {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const [, , sha, target] = process.argv;
const candidateTree = spawnSync("git", ["rev-parse", \`\${sha}^{tree}\`], { encoding: "utf8" }).stdout.trim();
mkdirSync(${JSON.stringify(artifactRoot)}, { recursive: true });
const artifactIdentity = \`artifact-\${target}\`;
writeFileSync(resolve(${JSON.stringify(artifactRoot)}, "ran.json"), JSON.stringify({ sha, target }));
process.stdout.write(\`\${JSON.stringify({ sha, candidateTree, target, verified: true, artifactIdentity, artifact: artifactIdentity })}\\n\`);
`;
}

interface DeferredLocalProgress {
  repository: TestRepository;
  workspace: WorkspaceIdentity;
  candidateSha: string;
  candidateTree: string;
  artifactPath: string;
  probeCommand: { adapter: "command"; command: string[] };
}

async function deliveryProbeCommand(fixture: DeferredLocalProgress): Promise<{ adapter: "command"; command: string[] }> {
  const script = join(fixture.repository.parent, PROBE);
  await writeFile(script, probeScript(join(fixture.repository.parent, "delivery-artifacts")));
  return { adapter: "command", command: ["node", script, "{sha}", "{target}"] };
}

function previewIdentity(fixture: DeferredLocalProgress): PreviewDeliveryResult {
  const artifactIdentity = "artifact-preview";
  return {
    sha: fixture.candidateSha,
    candidateSha: fixture.candidateSha,
    candidateTree: fixture.candidateTree,
    target: "preview",
    verified: true,
    status: "previewed",
    artifactIdentity,
    artifact: artifactIdentity,
  };
}

function stagingEvidence(fixture: DeferredLocalProgress): {
  candidateSha: string;
  candidateTree: string;
  target: "staging";
  artifactIdentity: string;
  verified: true;
} {
  return {
    candidateSha: fixture.candidateSha,
    candidateTree: fixture.candidateTree,
    target: "staging",
    artifactIdentity: "artifact-staging",
    verified: true,
  };
}

/**
 * A deferred install that has completed all local work through exact-candidate
 * Proof: an owned workspace, an accepted-Review checkpoint, and a passing
 * Verify for that exact candidate. The harness (not the runtime) publishes the
 * candidate so the delivery seams have a genuine precondition; a blocked seam
 * must still refuse.
 */
async function deferredLocalProgress(repositories: TestRepository[]): Promise<DeferredLocalProgress> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await init(repository.root, deferredConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
  const workspace = await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch: BRANCH,
    workspacePath: join(repository.parent, "workspace"),
    specId: "1",
  });
  await writeFile(join(workspace.path, "feature.txt"), "deferred local work\n");
  const accepted = await checkpoint({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    paths: ["feature.txt"],
    message: "ticket 143: local work",
    review: { verdict: "PASS", reviewerIdentity: "final-review-143", evidence: "no findings" },
  });
  const candidateTree = await resolveTree(workspace.path, accepted.sha);
  await verify({ cwd: workspace.path, candidateSha: accepted.sha, commands: ["test -f feature.txt"] });
  await run("git", ["push", "--porcelain", "origin", `${accepted.sha}:refs/heads/${BRANCH}`], { cwd: workspace.path });
  return {
    repository,
    workspace,
    candidateSha: accepted.sha,
    candidateTree,
    artifactPath: join(repository.parent, "delivery-artifacts", "ran.json"),
    probeCommand: { adapter: "command", command: ["node", "unused", "{sha}", "{target}"] },
  };
}

async function remoteHeads(repository: TestRepository): Promise<string> {
  return (await run("git", ["ls-remote", "--heads", "origin"], { cwd: repository.root })).stdout;
}

async function deliveryScripts(repository: TestRepository): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const scripts = join(repository.root, "scripts");
  if (!existsSync(scripts)) return [];
  return (await readdir(scripts)).filter((entry) => entry.startsWith("poiesis-")).sort();
}

/** A non-fixture (`github`) tracker needs an authenticated `gh` for doctor. */
async function installFakeGh(): Promise<() => void> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-deferred-gh-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "gh");
  await writeFile(
    script,
    `#!/bin/sh
case "$1" in
  auth) exit 0 ;;
  repo)
    if [ "$2" = "view" ]; then
      printf '{"nameWithOwner":"%s"}\\n' "$3"
      exit 0
    fi
    exit 1
    ;;
esac
exit 0
`,
  );
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return () => {
    process.env.PATH = previousPath;
    void rm(parent, { recursive: true, force: true });
  };
}

function expectedDeferredFailure(operation: string) {
  return {
    code: "DELIVERY_DEFERRED",
    details: {
      mode: DEFERRED_DELIVERY_MODE,
      operation,
      remediation: expect.stringContaining("delivery"),
    },
  };
}

/**
 * Ticket #152 — the installed-state failure for a manifest-present project
 * with no installed `.poiesis/config.jsonc`. It is distinct from both
 * `DELIVERY_DEFERRED` (delivery is explicitly deferred) and the
 * `INVALID_DELIVERY_CONFIG` malformed-block failure: nothing is known about
 * delivery, so the operation must stop at the installed state.
 */
function expectedMissingConfigFailure(operation: string) {
  return {
    code: "CONFIG_NOT_INSTALLED",
    details: {
      operation,
      path: expect.stringContaining(join(".poiesis", "config.jsonc")),
      remediation: expect.stringContaining("poiesis init"),
    },
  };
}

/**
 * The zero-side-effect matrix: every delivery-integrated operation, with
 * inputs that are otherwise complete and valid, so a refusal can only come
 * from the lifecycle policy.
 */
function blockedAttempts(
  fixture: DeferredLocalProgress,
  probeCommand: { adapter: "command"; command: string[] },
): Array<{ operation: DeferredBlockedOperation; attempt: () => Promise<unknown> }> {
  const proof = proofShell(fixture.candidateSha, fixture.candidateTree);
  const ownership = { cwd: fixture.workspace.path, ownershipId: fixture.workspace.ownershipId };
  const preview = previewIdentity(fixture);
  const staging = { ...preview, target: "staging" as const, artifactIdentity: "artifact-staging", artifact: "artifact-staging" };
  return [
    {
      operation: "poiesis publish",
      attempt: () =>
        publish({
          ...ownership,
          remote: "origin",
          integrationBranch: "main",
          candidateSha: fixture.candidateSha,
          candidateTree: fixture.candidateTree,
          provider: "fixture",
          project: fixture.repository.fixtures,
          title: "Spec 1",
          body: "body",
          proof,
        }),
    },
    {
      operation: "poiesis preview",
      attempt: () =>
        previewDelivery(
          probeCommand,
          {
            sha: fixture.candidateSha,
            candidateTree: fixture.candidateTree,
            proof,
            publish: publishEvidence(fixture.candidateSha, fixture.candidateTree, BRANCH),
            remote: "origin",
          },
          fixture.repository.root,
        ),
    },
    {
      operation: "poiesis promote --target staging",
      attempt: () =>
        promoteDelivery(
          probeCommand,
          { sha: fixture.candidateSha, target: "staging", candidateTree: fixture.candidateTree, identity: preview },
          fixture.repository.root,
        ),
    },
    {
      operation: "poiesis promote --target production",
      attempt: () =>
        promoteDelivery(
          probeCommand,
          {
            sha: fixture.candidateSha,
            target: "production",
            candidateTree: fixture.candidateTree,
            identity: staging,
            productionAuthorization: {
              candidateSha: fixture.candidateSha,
              candidateTree: fixture.candidateTree,
              stagingArtifactIdentity: "artifact-staging",
              integrationSha: fixture.candidateSha,
              authorIdentity: "author",
              approved: true,
            },
            integrationRemote: "origin",
            integrationBranch: "main",
            proof,
            integration: {
              candidateSha: fixture.candidateSha,
              candidateTree: fixture.candidateTree,
              integrationSha: fixture.candidateSha,
              integrationTree: fixture.candidateTree,
              contentMatchesCandidate: true,
            },
          },
          fixture.repository.root,
        ),
    },
    {
      operation: "poiesis integrate",
      attempt: () =>
        integrate({
          ...ownership,
          remote: "origin",
          integrationBranch: "main",
          expectedBaseSha: fixture.workspace.baseSha,
          candidateSha: fixture.candidateSha,
          candidateTree: fixture.candidateTree,
          message: "Spec 1: deferred local work",
          proof,
          staging: stagingEvidence(fixture),
          authorAcceptance: "Yes, this is what I wanted.",
        }),
    },
    {
      operation: "poiesis workspace cleanup",
      attempt: () => workspaceCleanup(ownership),
    },
  ];
}

/**
 * Spec #139 / ticket #189 — the shape through which an UNCHECKED delivery
 * delegate could be reached, however it was named and whatever it hid
 * behind: an object whose `preview` and `promote` are both callable. The
 * `DeliveryAdapter` interface is the whole surface, so nothing else needs to
 * be special-cased — a reachable delegate is detectable by shape alone.
 */
function isDeliveryAdapterLike(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const candidate = value as { preview?: unknown; promote?: unknown };
  return typeof candidate.preview === "function" && typeof candidate.promote === "function";
}

function prototypeChainOf(value: object): object[] {
  const chain: object[] = [];
  let current: object | null = Object.getPrototypeOf(value);
  while (current !== null) {
    chain.push(current);
    current = Object.getPrototypeOf(current);
  }
  return chain;
}

/**
 * Everything reflection can hand a JavaScript consumer from `subject`: its
 * own string and symbol keys, every prototype up the chain, every data
 * descriptor value, and every accessor result. This deliberately does NOT
 * look for a particular field name — a TS `private readonly` field emits an
 * ordinary own property, and a later regression could rename it, nest it, or
 * hide it behind a symbol. The invariant is behavioural: no object reachable
 * from the wrapper is a delivery adapter other than the wrapper itself.
 *
 * The subject's own prototype chain is the wrapper's CLASS SHAPE and is not a
 * leak: it holds no state, and calling its `preview` / `promote` on the wrapper
 * still runs the guard. A delegate is a separate object, and that is what this
 * reports.
 */
function reachableUncheckedDelegates(subject: DeliveryAdapter): string[] {
  const leaked: string[] = [];
  const seen = new Set<unknown>();
  const shape = new Set<unknown>([subject, ...prototypeChainOf(subject)]);

  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 5 || value === null || (typeof value !== "object" && typeof value !== "function")) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (!shape.has(value) && isDeliveryAdapterLike(value)) leaked.push(path);
    for (const holder of [value as object, ...prototypeChainOf(value as object)]) {
      for (const key of Reflect.ownKeys(holder)) {
        const descriptor = Object.getOwnPropertyDescriptor(holder, key);
        if (descriptor === undefined) continue;
        const name = String(key);
        if ("value" in descriptor) {
          visit(descriptor.value, `${path}.${name}`, depth + 1);
          continue;
        }
        if (descriptor.get === undefined) continue;
        try {
          visit(descriptor.get.call(value), `${path}.${name}()`, depth + 1);
        } catch {
          // A getter that refuses this receiver exposes nothing to reach.
        }
      }
    }
  };

  visit(subject, "adapter", 0);
  return leaked;
}

/**
 * The same six operations as the operator invokes them, through the CLI
 * command seams, with complete and otherwise-valid arguments. The CLI
 * wrappers each run the shared preflight (runtime identity, then the central
 * lifecycle policy) before they read the installed config or resolve
 * publishing coordinates, so a refusal can only come from that preflight.
 */
function cliAttempts(
  fixture: DeferredLocalProgress,
  cwd: string,
): Array<{ operation: DeferredBlockedOperation; attempt: () => Promise<unknown> }> {
  const sha = fixture.candidateSha;
  const tree = fixture.candidateTree;
  const proof = JSON.stringify(proofShell(sha, tree));
  const candidate = ["--sha", sha, "--candidate-tree", tree, "--cwd", cwd];
  const preview = JSON.stringify(previewIdentity(fixture));
  const staging = JSON.stringify(stagingEvidence(fixture));
  const authorization = JSON.stringify({
    candidateSha: sha,
    candidateTree: tree,
    stagingArtifactIdentity: "artifact-staging",
    integrationSha: sha,
    authorIdentity: "author",
    approved: true,
  });
  const integration = JSON.stringify({
    candidateSha: sha,
    candidateTree: tree,
    integrationSha: sha,
    integrationTree: tree,
    contentMatchesCandidate: true,
  });
  return [
    {
      operation: "poiesis publish",
      attempt: () =>
        commandPublish([...candidate, "--proof", proof, "--title", "Spec 1", "--body", "body"]),
    },
    {
      operation: "poiesis preview",
      attempt: () =>
        commandPreview([...candidate, "--proof", proof, "--publish", JSON.stringify(publishEvidence(sha, tree, BRANCH))]),
    },
    {
      operation: "poiesis promote --target staging",
      attempt: () => commandPromote([...candidate, "--target", "staging", "--identity", preview]),
    },
    {
      operation: "poiesis promote --target production",
      attempt: () =>
        commandPromote([
          ...candidate,
          "--target",
          "production",
          "--identity",
          staging,
          "--authorization",
          authorization,
          "--proof",
          proof,
          "--integration",
          integration,
        ]),
    },
    {
      operation: "poiesis integrate",
      attempt: () =>
        commandIntegrate([
          ...candidate,
          "--base",
          fixture.workspace.baseSha,
          "--proof",
          proof,
          "--staging",
          staging,
          "--acceptance",
          "Yes, this is what I wanted.",
          "--message",
          "Spec 1: local work",
        ]),
    },
  ];
}

describe("explicit deferred delivery keeps local work healthy through exact-candidate Proof", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let restoreGh: (() => void) | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    restoreGh?.();
    restoreGh = undefined;
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("prepares a workspace, accepts an accepted-Review checkpoint, and proves the exact candidate", async () => {
    const fixture = await deferredLocalProgress(repositories);
    expect(fixture.workspace.branch).toBe(BRANCH);
    expect(fixture.candidateSha).not.toBe(fixture.workspace.baseSha);
    expect(fixture.candidateTree).toMatch(/^[0-9a-f]{40}$/);
    await expect(
      verify({ cwd: fixture.workspace.path, candidateSha: fixture.candidateSha, commands: ["test -f feature.txt"] }),
    ).resolves.toMatchObject({ candidateSha: fixture.candidateSha, cleanBefore: true, cleanAfter: true });
  }, 30_000);

  it("does not gate inspect", async () => {
    const fixture = await deferredLocalProgress(repositories);
    await expect(inspect({ cwd: fixture.workspace.path, remote: "origin", integrationBranch: "main" })).resolves.toMatchObject({
      root: expect.stringContaining("workspace"),
    });
  }, 30_000);

  it("does not gate a tracker mutation", async () => {
    const fixture = await deferredLocalProgress(repositories);
    const adapter = createTrackerAdapter({ provider: "fixture", project: join(fixture.repository.fixtures, "tracker") }, fixture.repository.root);
    const created = await adapter.createSpec({ title: "Deferred delivery", body: "local work only" });
    expect(created.id).toBeTruthy();
    await expect(adapter.getSpec(created.id)).resolves.toMatchObject({ title: "Deferred delivery" });
  }, 30_000);

  it("creates no delivery script or delivery adapter at init and reports only a nonblocking doctor warning", async () => {
    const fixture = await deferredLocalProgress(repositories);
    const installed = JSON.parse(await readFile(join(fixture.repository.root, ".poiesis", "config.jsonc"), "utf8")) as ResolvedPoiesisConfig;
    expect(installed.delivery).toEqual({ mode: DEFERRED_DELIVERY_MODE });
    for (const target of ["preview", "staging", "production"] as const) {
      expect(existsSync(join(fixture.repository.root, "scripts", `poiesis-${target}.mjs`))).toBe(false);
    }
    const report = await doctor(fixture.repository.root);
    expect(report.checks.find((check) => check.id === "delivery")).toMatchObject({ status: "warn" });
    // A nonblocking warning: the deferred state never surfaces as a typed
    // block error anywhere in the doctor report.
    expect(JSON.stringify(report.checks)).not.toContain("DELIVERY_DEFERRED");
  }, 60_000);

  it("creates no delivery script when update switches an installation to deferred delivery", async () => {
    restoreGh = await installFakeGh();
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(
      repository.root,
      {
        ...deferredConfig(repository),
        tracker: { provider: "github", project: "owner/repo" },
        delivery: {
          preview: { adapter: "command", command: ["echo", "preview", "{sha}", "{target}"] },
          staging: { adapter: "command", command: ["echo", "staging", "{sha}", "{target}"] },
          production: { adapter: "command", command: ["echo", "production", "{sha}", "{target}"] },
        },
      },
      { skipSkills: true },
    );
    const scriptsBefore = await deliveryScripts(repository);

    const candidatePath = join(repository.parent, "deferred.jsonc");
    await writeFile(
      candidatePath,
      serializeConfig({ ...deferredConfig(repository), tracker: { provider: "github", project: "owner/repo" } }),
    );
    const result = await updateFromConfig(repository.root, candidatePath);
    expect(result.doctor.checks.find((check) => check.id === "delivery")).toMatchObject({ status: "warn" });
    expect(await deliveryScripts(repository)).toEqual(scriptsBefore);
    expect(JSON.parse(await readFile(join(repository.root, ".poiesis", "config.jsonc"), "utf8")).delivery).toEqual({
      mode: DEFERRED_DELIVERY_MODE,
    });
  }, 90_000);
});

describe("explicit deferred delivery hard-blocks every delivery-integrated operation", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let fixture: DeferredLocalProgress;
  let probeCommand: { adapter: "command"; command: string[] };

  beforeEach(async () => {
    env = await installFakeOpenCode();
    fixture = await deferredLocalProgress(repositories);
    probeCommand = await deliveryProbeCommand(fixture);
  }, 60_000);

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("refuses Publish with a typed error naming the operation and the remediation", async () => {
    const mark = markSubprocesses();
    await expect(
      publish({
        cwd: fixture.workspace.path,
        ownershipId: fixture.workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        candidateSha: fixture.candidateSha,
        candidateTree: fixture.candidateTree,
        provider: "fixture",
        project: fixture.repository.fixtures,
        title: "Spec 1",
        body: "body",
        proof: proofShell(fixture.candidateSha, fixture.candidateTree),
      }),
    ).rejects.toMatchObject(expectedDeferredFailure("poiesis publish"));
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
  }, 30_000);

  it("refuses Preview before remote revalidation and before any delivery subprocess", async () => {
    const mark = markSubprocesses();
    await expect(
      previewDelivery(
        probeCommand,
        {
          sha: fixture.candidateSha,
          candidateTree: fixture.candidateTree,
          proof: proofShell(fixture.candidateSha, fixture.candidateTree),
          publish: publishEvidence(fixture.candidateSha, fixture.candidateTree, BRANCH),
          remote: "origin",
        },
        fixture.repository.root,
      ),
    ).rejects.toMatchObject(expectedDeferredFailure("poiesis preview"));
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    expect(existsSync(fixture.artifactPath)).toBe(false);
  }, 30_000);

  it("refuses Staging and Production promotion before any delivery subprocess", async () => {
    const stagingMark = markSubprocesses();
    await expect(
      promoteDelivery(
        probeCommand,
        { sha: fixture.candidateSha, target: "staging", candidateTree: fixture.candidateTree, identity: previewIdentity(fixture) },
        fixture.repository.root,
      ),
    ).rejects.toMatchObject(expectedDeferredFailure("poiesis promote --target staging"));
    expect(reachedSideEffects(subprocessCallsSince(stagingMark))).toEqual([]);

    const productionMark = markSubprocesses();
    await expect(
      promoteDelivery(
        probeCommand,
        {
          sha: fixture.candidateSha,
          target: "production",
          candidateTree: fixture.candidateTree,
          identity: { ...previewIdentity(fixture), target: "staging", artifactIdentity: "artifact-staging", artifact: "artifact-staging" },
          productionAuthorization: {
            candidateSha: fixture.candidateSha,
            candidateTree: fixture.candidateTree,
            stagingArtifactIdentity: "artifact-staging",
            integrationSha: fixture.candidateSha,
            authorIdentity: "author",
            approved: true,
          },
          integrationRemote: "origin",
          integrationBranch: "main",
          proof: proofShell(fixture.candidateSha, fixture.candidateTree),
          integration: {
            candidateSha: fixture.candidateSha,
            candidateTree: fixture.candidateTree,
            integrationSha: fixture.candidateSha,
            integrationTree: fixture.candidateTree,
            contentMatchesCandidate: true,
          },
        },
        fixture.repository.root,
      ),
    ).rejects.toMatchObject(expectedDeferredFailure("poiesis promote --target production"));
    expect(reachedSideEffects(subprocessCallsSince(productionMark))).toEqual([]);
    expect(existsSync(fixture.artifactPath)).toBe(false);
  }, 30_000);

  it("refuses Integrate before fetch, commit-tree, and push", async () => {
    const mark = markSubprocesses();
    await expect(
      integrate({
        cwd: fixture.workspace.path,
        ownershipId: fixture.workspace.ownershipId,
        remote: "origin",
        integrationBranch: "main",
        expectedBaseSha: fixture.workspace.baseSha,
        candidateSha: fixture.candidateSha,
        candidateTree: fixture.candidateTree,
        message: "Spec 1: deferred local work",
        proof: proofShell(fixture.candidateSha, fixture.candidateTree),
        staging: stagingEvidence(fixture),
        authorAcceptance: "Yes, this is what I wanted.",
        postIntegrationCommands: ["test -f feature.txt"],
      }),
    ).rejects.toMatchObject(expectedDeferredFailure("poiesis integrate"));
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
  }, 30_000);

  it("refuses workspace cleanup before remote branch deletion and worktree removal", async () => {
    const mark = markSubprocesses();
    await expect(workspaceCleanup({ cwd: fixture.workspace.path, ownershipId: fixture.workspace.ownershipId })).rejects.toMatchObject(
      expectedDeferredFailure("poiesis workspace cleanup"),
    );
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    expect(existsSync(fixture.workspace.path)).toBe(true);
    expect(existsSync(fixture.workspace.markerPath)).toBe(true);
  }, 30_000);

  it("reports exactly the operations the policy declares as blocked", async () => {
    const reported: string[] = [];
    for (const { operation, attempt } of blockedAttempts(fixture, probeCommand)) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, `${operation} must be refused`).toMatchObject(expectedDeferredFailure(operation));
      reported.push((error as PoiesisError).details.operation as string);
    }
    expect(reported.sort()).toEqual([...DEFERRED_BLOCKED_OPERATIONS].sort());
  }, 30_000);

  it("leaves the remote, the local candidate, and the delivered state untouched", async () => {
    const headsBefore = await remoteHeads(fixture.repository);
    for (const { attempt } of blockedAttempts(fixture, probeCommand)) {
      await expect(attempt()).rejects.toMatchObject({ code: "DELIVERY_DEFERRED" });
    }
    expect(await remoteHeads(fixture.repository)).toBe(headsBefore);
    expect(existsSync(fixture.artifactPath)).toBe(false);
    expect((await resolveTree(fixture.workspace.path, fixture.candidateSha)).trim()).toBe(fixture.candidateTree);
    expect(existsSync(fixture.workspace.path)).toBe(true);
    expect(existsSync(fixture.workspace.markerPath)).toBe(true);
    await expect(
      verify({ cwd: fixture.workspace.path, candidateSha: fixture.candidateSha, commands: ["test -f feature.txt"] }),
    ).resolves.toMatchObject({ candidateSha: fixture.candidateSha });
  }, 30_000);
});

/**
 * Spec #139 / ticket #188 — the deferred lifecycle is not bypassable through
 * the PUBLIC delivery-adapter API.
 *
 * `src/index.ts` re-exports `createDeliveryAdapter`,
 * `createCommandDeliveryAdapter`, and `createFixtureDeliveryAdapter`, and each
 * one returns an adapter object. Before this ticket only the
 * `previewDelivery` / `promoteDelivery` wrappers consulted
 * `assertDeliveryAuthority`, so a library consumer could construct through any
 * exported factory and drive `preview` / `promote` directly: a deferred
 * installation still ran a delivery subprocess, still revalidated a remote,
 * still wrote a fixture delivery record, and still minted a delivery identity.
 *
 * What is pinned here:
 *
 *   1. EVERY exported factory refuses a deferred install, by the canonical
 *      operation name, with the guard running BEFORE remote revalidation,
 *      BEFORE any delivery subprocess, BEFORE any filesystem artifact, and
 *      BEFORE any evidence.
 *   2. The guard ORDER is unchanged on those paths: runtime identity first,
 *      then the single central lifecycle-policy guard, so an absent manifest
 *      still reports `RUNTIME_VERSION_MISMATCH` and a manifest-present project
 *      with no installed config still reports `CONFIG_NOT_INSTALLED`.
 *   3. The refusal is POLICY, not a blanket denial: the same exported
 *      factories still drive a real Preview and Staging in a CONFIGURED
 *      installation, writing the artifacts they are supposed to write.
 */
describe("every exported delivery factory is policy-aware", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let fixture: DeferredLocalProgress;
  let probeCommand: { adapter: "command"; command: string[] };

  beforeEach(async () => {
    env = await installFakeOpenCode();
    fixture = await deferredLocalProgress(repositories);
    probeCommand = await deliveryProbeCommand(fixture);
  }, 60_000);

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  function fixtureDeliveryPath(): string {
    return join(fixture.repository.fixtures, "delivery");
  }

  function previewAttempt(): Promise<unknown> {
    return createDeliveryAdapter(probeCommand, fixture.repository.root).preview({
      sha: fixture.candidateSha,
      candidateTree: fixture.candidateTree,
      proof: proofShell(fixture.candidateSha, fixture.candidateTree),
      publish: publishEvidence(fixture.candidateSha, fixture.candidateTree, BRANCH),
      remote: "origin",
    });
  }

  function stagingAttempt(adapter: DeliveryAdapter): Promise<unknown> {
    return adapter.promote({
      sha: fixture.candidateSha,
      target: "staging",
      candidateTree: fixture.candidateTree,
      identity: previewIdentity(fixture),
    });
  }

  function productionAttempt(adapter: DeliveryAdapter): Promise<unknown> {
    return adapter.promote({
      sha: fixture.candidateSha,
      target: "production",
      candidateTree: fixture.candidateTree,
      identity: {
        ...previewIdentity(fixture),
        target: "staging",
        artifactIdentity: "artifact-staging",
        artifact: "artifact-staging",
      },
      productionAuthorization: {
        candidateSha: fixture.candidateSha,
        candidateTree: fixture.candidateTree,
        stagingArtifactIdentity: "artifact-staging",
        integrationSha: fixture.candidateSha,
        authorIdentity: "author",
        approved: true,
      },
      integrationRemote: "origin",
      integrationBranch: "main",
      proof: proofShell(fixture.candidateSha, fixture.candidateTree),
      integration: {
        candidateSha: fixture.candidateSha,
        candidateTree: fixture.candidateTree,
        integrationSha: fixture.candidateSha,
        integrationTree: fixture.candidateTree,
        contentMatchesCandidate: true,
      },
    });
  }

  it("refuses createDeliveryAdapter before remote revalidation, any subprocess, and any evidence", async () => {
    const adapter = createDeliveryAdapter(probeCommand, fixture.repository.root);
    const mark = markSubprocesses();
    await expect(previewAttempt()).rejects.toMatchObject(expectedDeferredFailure("poiesis preview"));
    await expect(stagingAttempt(adapter)).rejects.toMatchObject(expectedDeferredFailure("poiesis promote --target staging"));
    await expect(productionAttempt(adapter)).rejects.toMatchObject(
      expectedDeferredFailure("poiesis promote --target production"),
    );
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    expect(existsSync(fixture.artifactPath)).toBe(false);
  }, 30_000);

  it("refuses createCommandDeliveryAdapter the same way", async () => {
    const adapter = createCommandDeliveryAdapter(probeCommand, fixture.repository.root);
    const mark = markSubprocesses();
    await expect(adapter.preview({
      sha: fixture.candidateSha,
      candidateTree: fixture.candidateTree,
      proof: proofShell(fixture.candidateSha, fixture.candidateTree),
      publish: publishEvidence(fixture.candidateSha, fixture.candidateTree, BRANCH),
      remote: "origin",
    })).rejects.toMatchObject(expectedDeferredFailure("poiesis preview"));
    await expect(stagingAttempt(adapter)).rejects.toMatchObject(expectedDeferredFailure("poiesis promote --target staging"));
    await expect(productionAttempt(adapter)).rejects.toMatchObject(
      expectedDeferredFailure("poiesis promote --target production"),
    );
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    expect(existsSync(fixture.artifactPath)).toBe(false);
  }, 30_000);

  it("refuses createFixtureDeliveryAdapter before it writes any delivery record", async () => {
    const adapter = createFixtureDeliveryAdapter(
      { adapter: "fixture", path: fixtureDeliveryPath() },
      fixture.repository.root,
    );
    const mark = markSubprocesses();
    await expect(adapter.preview({
      sha: fixture.candidateSha,
      candidateTree: fixture.candidateTree,
      proof: proofShell(fixture.candidateSha, fixture.candidateTree),
      publish: publishEvidence(fixture.candidateSha, fixture.candidateTree, BRANCH),
      remote: "origin",
    })).rejects.toMatchObject(expectedDeferredFailure("poiesis preview"));
    await expect(stagingAttempt(adapter)).rejects.toMatchObject(expectedDeferredFailure("poiesis promote --target staging"));
    await expect(productionAttempt(adapter)).rejects.toMatchObject(
      expectedDeferredFailure("poiesis promote --target production"),
    );
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    for (const directory of ["candidates", "staging", "production"]) {
      expect(existsSync(join(fixtureDeliveryPath(), directory)), `${directory} must not be written`).toBe(false);
    }
  }, 30_000);

  it("keeps runtime identity ahead of the deferred refusal through an exported factory", async () => {
    await rm(join(fixture.repository.root, ".poiesis", "manifest.json"));
    const adapter = createDeliveryAdapter(probeCommand, fixture.repository.root);
    const mark = markSubprocesses();
    await expect(previewAttempt()).rejects.toMatchObject({ code: "RUNTIME_VERSION_MISMATCH" });
    await expect(stagingAttempt(adapter)).rejects.toMatchObject({ code: "RUNTIME_VERSION_MISMATCH" });
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    expect(existsSync(fixture.artifactPath)).toBe(false);
  }, 30_000);

  it("fails closed at the installed state through an exported factory", async () => {
    await rm(join(fixture.repository.root, ".poiesis", "config.jsonc"));
    const adapter = createFixtureDeliveryAdapter(
      { adapter: "fixture", path: fixtureDeliveryPath() },
      fixture.repository.root,
    );
    const mark = markSubprocesses();
    await expect(adapter.preview({
      sha: fixture.candidateSha,
      candidateTree: fixture.candidateTree,
      proof: proofShell(fixture.candidateSha, fixture.candidateTree),
      publish: publishEvidence(fixture.candidateSha, fixture.candidateTree, BRANCH),
      remote: "origin",
    })).rejects.toMatchObject(expectedMissingConfigFailure("poiesis preview"));
    await expect(stagingAttempt(adapter)).rejects.toMatchObject(expectedMissingConfigFailure("poiesis promote --target staging"));
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    expect(existsSync(join(fixtureDeliveryPath(), "candidates"))).toBe(false);
    expect(existsSync(join(fixtureDeliveryPath(), "staging"))).toBe(false);
  }, 30_000);

  it("still delivers through the same exported factories in a CONFIGURED installation", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const script = join(repository.parent, PROBE);
    const commandArtifact = join(repository.parent, "configured-artifacts", "ran.json");
    await writeFile(script, probeScript(commandArtifact));
    const delivery = { adapter: "command" as const, command: ["node", script, "{sha}", "{target}"] };
    const changeBranch = "poiesis/configured";
    await run("git", ["push", "--quiet", "origin", `${repository.baseSha}:refs/heads/${changeBranch}`], {
      cwd: repository.root,
    });
    await init(
      repository.root,
      { ...testConfig(repository), delivery: { preview: delivery, staging: delivery, production: delivery } },
      { skipSkills: true, allowFixtureAdapters: true },
    );
    const sha = repository.baseSha;
    const tree = await resolveTree(repository.root, sha);
    const proof = proofShell(sha, tree);
    const publish = publishEvidence(sha, tree, changeBranch);

    // The command factory: a real delivery subprocess runs and reports.
    const command = createCommandDeliveryAdapter(delivery, repository.root);
    const preview = await command.preview({ sha, candidateTree: tree, proof, publish, remote: "origin" });
    expect(preview).toMatchObject({ target: "preview", verified: true, artifactIdentity: "artifact-preview" });
    const staging = await command.promote({ sha, target: "staging", candidateTree: tree, identity: preview });
    expect(staging).toMatchObject({ target: "staging", verified: true, artifactIdentity: "artifact-staging" });
    expect(existsSync(commandArtifact)).toBe(true);

    // The fixture factory: the delivery record it is supposed to write is written.
    const fixturePath = join(repository.fixtures, "delivery");
    const fixtureAdapter = createFixtureDeliveryAdapter({ adapter: "fixture", path: fixturePath }, repository.root);
    const fixturePreview = await fixtureAdapter.preview({ sha, candidateTree: tree, proof, publish, remote: "origin" });
    expect(fixturePreview).toMatchObject({ target: "preview", verified: true, id: `fixture:${sha}` });
    expect(existsSync(join(fixturePath, "candidates"))).toBe(true);

    // Ticket #189: the factories deliver exactly as before, and the adapters
    // that did the delivering still expose no unchecked delegate.
    expect(reachableUncheckedDelegates(command)).toEqual([]);
    expect(reachableUncheckedDelegates(fixtureAdapter)).toEqual([]);
  }, 90_000);
});

/**
 * Spec #139 / ticket #189 — TypeScript `private` is erased at emit, so the
 * policy-aware wrapper handed back by a public delivery factory was not
 * actually sealed: `private readonly adapter` compiles to an ordinary own
 * enumerable property, and a JavaScript consumer could call
 * `adapter.adapter.preview(...)` on the UNCHECKED `CommandDeliveryAdapter` /
 * `FixtureDeliveryAdapter` — skipping runtime identity and the central
 * deferred guard entirely. In a deferred installation that is the whole
 * lifecycle block: the delegate would revalidate the remote, run the delivery
 * subprocess, write the artifact, and mint the Preview identity.
 *
 * What is pinned here:
 *
 *   1. Every public factory hands back an object from which NO property,
 *      symbol, enumerable value, or descriptor yields the delegate or the
 *      authority root — checked generically by reachability, not by name.
 *   2. A bypass attempt is a hard refusal that produces no remote
 *      revalidation, no subprocess, no filesystem write, no artifact, and no
 *      delivery evidence, in the installation where a reachable delegate
 *      would have produced all five.
 */
describe("no public delivery factory exposes the unchecked delegate at runtime", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let fixture: DeferredLocalProgress;
  let probeCommand: { adapter: "command"; command: string[] };

  beforeEach(async () => {
    env = await installFakeOpenCode();
    fixture = await deferredLocalProgress(repositories);
    probeCommand = await deliveryProbeCommand(fixture);
  }, 60_000);

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  function fixtureDeliveryPath(): string {
    return join(fixture.repository.fixtures, "delivery");
  }

  /** What a library consumer actually receives from each public factory. */
  function publicAdapters(): Array<{ label: string; adapter: DeliveryAdapter }> {
    return [
      { label: "createDeliveryAdapter", adapter: createDeliveryAdapter(probeCommand, fixture.repository.root) },
      { label: "createCommandDeliveryAdapter", adapter: createCommandDeliveryAdapter(probeCommand, fixture.repository.root) },
      {
        label: "createFixtureDeliveryAdapter",
        adapter: createFixtureDeliveryAdapter({ adapter: "fixture", path: fixtureDeliveryPath() }, fixture.repository.root),
      },
    ];
  }

  function previewInput(): PreviewDeliveryInput {
    return {
      sha: fixture.candidateSha,
      candidateTree: fixture.candidateTree,
      proof: proofShell(fixture.candidateSha, fixture.candidateTree),
      publish: publishEvidence(fixture.candidateSha, fixture.candidateTree, BRANCH),
      remote: "origin",
    };
  }

  async function outcome(attempt: () => unknown): Promise<unknown> {
    try {
      await attempt();
      return null;
    } catch (error) {
      return error;
    }
  }

  it("exposes no property, symbol, enumerable value, or descriptor that yields the unchecked delegate", () => {
    for (const { label, adapter } of publicAdapters()) {
      const ownKeys = Reflect.ownKeys(adapter).map(String);
      expect(ownKeys, `${label} own keys`).not.toContain("adapter");
      expect(ownKeys, `${label} own keys`).not.toContain("root");

      const enumerated = [...Object.keys(adapter)];
      for (const inherited in adapter) enumerated.push(inherited);
      expect(enumerated, `${label} enumeration`).not.toContain("adapter");
      expect(enumerated, `${label} enumeration`).not.toContain("root");

      // The invariant behind the two names above: nothing reachable by
      // reflection is a delivery adapter other than the guarded wrapper.
      expect(reachableUncheckedDelegates(adapter), `${label} reflection`).toEqual([]);
    }
  });

  it("refuses a bypass attempt with no remote, process, filesystem, artifact, or evidence effect", async () => {
    const mark = markSubprocesses();
    for (const { label, adapter } of publicAdapters()) {
      const reachable = adapter as unknown as Record<string, unknown>;
      expect(reachable.adapter, `${label} .adapter`).toBeUndefined();
      expect(reachable.root, `${label} .root`).toBeUndefined();

      // The delegate itself would have succeeded here: the candidate is
      // published, proven, and the deferred block is the ONLY thing that
      // stops it. Reading through the wrapper must fail as a missing
      // property, not as a typed Poiesis policy refusal.
      const delegate = reachable.adapter as DeliveryAdapter;
      const preview = await outcome(() => delegate.preview(previewInput()));
      expect(preview, `${label} .adapter.preview`).toBeInstanceOf(TypeError);
      const staging = await outcome(() => delegate.promote({
        sha: fixture.candidateSha,
        target: "staging",
        candidateTree: fixture.candidateTree,
        identity: previewIdentity(fixture),
      }));
      expect(staging, `${label} .adapter.promote`).toBeInstanceOf(TypeError);
    }

    // Zero remote revalidation, zero delivery subprocess, zero artifact.
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    expect(existsSync(fixture.artifactPath)).toBe(false);
    // Zero delivery evidence of any kind, for both the command and the
    // fixture delegate.
    for (const directory of ["candidates", "staging", "production"]) {
      expect(existsSync(join(fixtureDeliveryPath(), directory)), `${directory} must not be written`).toBe(false);
    }
  }, 60_000);
});

describe("the lifecycle-policy guard reads the installed config without auto-resolution or network", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("blocks a deferred install without running a single subprocess", async () => {
    const fixture = await deferredLocalProgress(repositories);
    const mark = markSubprocesses();
    await expect(assertDeliveryPolicyAllows(fixture.repository.root, "poiesis publish")).rejects.toMatchObject(
      expectedDeferredFailure("poiesis publish"),
    );
    expect(subprocessCallsSince(mark)).toEqual([]);
  }, 30_000);

  it("allows a configured install without running a single subprocess", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
    const mark = markSubprocesses();
    await expect(assertDeliveryPolicyAllows(repository.root, "poiesis publish")).resolves.toBeUndefined();
    expect(subprocessCallsSince(mark)).toEqual([]);
  }, 60_000);

  it("fails closed on a malformed installed delivery block instead of allowing the operation", async () => {
    const fixture = await deferredLocalProgress(repositories);
    await writeFile(
      join(fixture.repository.root, ".poiesis", "config.jsonc"),
      JSON.stringify({
        ...deferredConfig(fixture.repository),
        delivery: { preview: { adapter: "command", command: ["echo", "{sha}"] } },
      }),
    );
    await expect(assertDeliveryPolicyAllows(fixture.repository.root, "poiesis publish")).rejects.toMatchObject({
      code: "INVALID_DELIVERY_CONFIG",
    });
  }, 30_000);

  it("refuses a manifest-present project that has no installed config, without running a subprocess", async () => {
    const fixture = await deferredLocalProgress(repositories);
    await rm(join(fixture.repository.root, ".poiesis", "config.jsonc"));
    const mark = markSubprocesses();
    await expect(assertDeliveryPolicyAllows(fixture.repository.root, "poiesis publish")).rejects.toMatchObject(
      expectedMissingConfigFailure("poiesis publish"),
    );
    expect(subprocessCallsSince(mark)).toEqual([]);
  }, 30_000);
});

/**
 * Spec #139 / ticket #152 — after the runtime identity guard has confirmed
 * the manifest exists and its version matches, an installed project with no
 * `.poiesis/config.jsonc` is an INCOMPLETE installed state, not an exemption.
 *
 * The absent config is therefore a typed installed-state failure raised by
 * the one central policy guard, ahead of any caller-supplied delivery
 * config (Preview / promote are handed a complete command adapter here) and
 * ahead of every side effect. A missing MANIFEST keeps its existing
 * precedence: the runtime identity guard refuses first, so the
 * uninstalled-project failure an Author already sees is unchanged.
 */
describe("an installed project with no installed config fails closed at the installed state", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let fixture: DeferredLocalProgress;
  let probeCommand: { adapter: "command"; command: string[] };

  beforeEach(async () => {
    env = await installFakeOpenCode();
    fixture = await deferredLocalProgress(repositories);
    probeCommand = await deliveryProbeCommand(fixture);
  }, 60_000);

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("refuses every guarded operation, however complete the caller-supplied delivery config is", async () => {
    await rm(join(fixture.repository.root, ".poiesis", "config.jsonc"));
    const headsBefore = await remoteHeads(fixture.repository);
    const reported: string[] = [];
    for (const { operation, attempt } of blockedAttempts(fixture, probeCommand)) {
      const mark = markSubprocesses();
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, `${operation} must be refused`).toMatchObject(expectedMissingConfigFailure(operation));
      // No push, fetch, remote revalidation, delivery subprocess, integration
      // commit, worktree removal, or artifact.
      expect(reachedSideEffects(subprocessCallsSince(mark)), operation).toEqual([]);
      reported.push((error as PoiesisError).details.operation as string);
    }
    expect(reported.sort()).toEqual([...DEFERRED_BLOCKED_OPERATIONS].sort());
    // The refused operations left the remote, the local candidate, the
    // delivery state, and the owned workspace exactly as they were.
    expect(await remoteHeads(fixture.repository)).toBe(headsBefore);
    expect(existsSync(fixture.artifactPath)).toBe(false);
    expect((await resolveTree(fixture.workspace.path, fixture.candidateSha)).trim()).toBe(fixture.candidateTree);
    expect(existsSync(fixture.workspace.path)).toBe(true);
    expect(existsSync(fixture.workspace.markerPath)).toBe(true);
  }, 60_000);

  it("keeps manifest absence owned by the runtime identity guard", async () => {
    await rm(join(fixture.repository.root, ".poiesis", "manifest.json"));
    for (const { operation, attempt } of blockedAttempts(fixture, probeCommand)) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, `${operation} must still report the uninstalled-project failure`).toMatchObject({
        code: "RUNTIME_VERSION_MISMATCH",
        details: { project: null },
      });
    }
    expect(existsSync(fixture.artifactPath)).toBe(false);
    expect(existsSync(fixture.workspace.path)).toBe(true);
  }, 60_000);

  it("does not relax the deferred refusal: an installed deferred config still blocks with DELIVERY_DEFERRED", async () => {
    for (const { operation, attempt } of blockedAttempts(fixture, probeCommand)) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, operation).toMatchObject(expectedDeferredFailure(operation));
    }
  }, 60_000);
});

/**
 * Spec #139 / ticket #163 — workspace cleanup decides OWNERSHIP first.
 *
 * Ticket #152's guidance promised `CONFIG_NOT_INSTALLED` for all six
 * operations from every cwd. That promise is false for the sixth, and the
 * reason is structural rather than a gap in the guard: the five preflighted
 * operations are judged by the PRIMARY installation authority, but
 * `workspaceCleanup` has to know what it would delete before it can judge
 * anything else, so it resolves workspace ownership first. The three cwds an
 * Author actually runs commands from — the primary checkout, a linked worktree
 * Poiesis never prepared, and a directory outside the clone — are all outside
 * an owned workspace, and a cleanup there must refuse with
 * `WORKSPACE_OWNERSHIP_UNKNOWN` without ever reaching the installed-state
 * decision. The linked-worktree case is the discriminating one: the primary
 * there IS a fully installed deferred project, so an order that consulted the
 * config first would answer `DELIVERY_DEFERRED` and be wrong about what it was
 * about to delete.
 *
 * Inside an owned workspace the precedence is unchanged and strictly ordered
 * — runtime identity, then the missing installed config named by the PRIMARY
 * path, then the deferred state — and every refusal lands before the first
 * side effect: no subprocess, no remote branch deletion, no worktree removal,
 * no local ref deletion, no ownership-marker change.
 */
describe("workspace cleanup proves ownership before it judges the installed state", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let fixture: DeferredLocalProgress;

  /** A linked worktree of the same clone that Poiesis never prepared. */
  async function unpreparedWorktree(): Promise<string> {
    const path = join(fixture.repository.parent, "unprepared-worktree");
    await run("git", ["worktree", "add", "--detach", path, "main"], { cwd: fixture.repository.root });
    return path;
  }

  /**
   * Everything a refused cleanup must leave byte-for-byte: the remote, the
   * published change branch, the local change ref, the worktree directory, and
   * the immutable ownership marker that proves the worktree was ever owned.
   */
  async function assertNothingWasTouched(before: { heads: string; marker: string; branch: string; tree: string }): Promise<void> {
    expect(await remoteHeads(fixture.repository)).toBe(before.heads);
    expect(readFileSync(fixture.workspace.markerPath, "utf8")).toBe(before.marker);
    expect(existsSync(fixture.workspace.path)).toBe(true);
    expect((await run("git", ["rev-parse", `refs/heads/${BRANCH}`], { cwd: fixture.repository.root })).stdout).toBe(before.branch);
    expect((await resolveTree(fixture.workspace.path, fixture.candidateSha)).trim()).toBe(before.tree);
  }

  async function snapshot(): Promise<{ heads: string; marker: string; branch: string; tree: string }> {
    return {
      heads: await remoteHeads(fixture.repository),
      marker: readFileSync(fixture.workspace.markerPath, "utf8"),
      branch: (await run("git", ["rev-parse", `refs/heads/${BRANCH}`], { cwd: fixture.repository.root })).stdout,
      tree: (await resolveTree(fixture.workspace.path, fixture.candidateSha)).trim(),
    };
  }

  beforeEach(async () => {
    env = await installFakeOpenCode();
    fixture = await deferredLocalProgress(repositories);
  }, 60_000);

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("refuses from the primary checkout with WORKSPACE_OWNERSHIP_UNKNOWN, not an installed-state code", async () => {
    const before = await snapshot();
    const mark = markSubprocesses();
    const error = await workspaceCleanup({ cwd: fixture.repository.root }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    // The primary checkout is a complete, correctly versioned, DEFERRED
    // installation, so any code other than the ownership failure here would be
    // the guard reporting on a delivery state it was not asked about.
    expect(error).toMatchObject({
      code: "WORKSPACE_OWNERSHIP_UNKNOWN",
      details: { path: fixture.repository.root, matches: 0 },
    });
    expect((error as PoiesisError).details).not.toHaveProperty("operation");
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    await assertNothingWasTouched(before);
  }, 60_000);

  it("refuses from a linked worktree Poiesis never prepared with WORKSPACE_OWNERSHIP_UNKNOWN, not DELIVERY_DEFERRED", async () => {
    // This is the case the old guidance got wrong: the primary installation is
    // intact and deferred, so only an ownership-first order can refuse with
    // the right code here.
    const unprepared = await unpreparedWorktree();
    const before = await snapshot();
    const mark = markSubprocesses();
    const error = await workspaceCleanup({ cwd: unprepared }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({
      code: "WORKSPACE_OWNERSHIP_UNKNOWN",
      details: { path: unprepared, matches: 0 },
    });
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    await assertNothingWasTouched(before);
  }, 60_000);

  it("refuses from a directory that is not in a Git repository at all with NOT_GIT_REPOSITORY", async () => {
    // The boundary of the ownership-first claim: a cwd outside any repository
    // never reaches the ownership decision, so the documentation must not fold
    // it into the WORKSPACE_OWNERSHIP_UNKNOWN case.
    const outside = join(fixture.repository.parent, "not-a-repository");
    await mkdir(outside, { recursive: true });
    const before = await snapshot();
    const mark = markSubprocesses();
    const error = await workspaceCleanup({ cwd: outside }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({ code: "NOT_GIT_REPOSITORY", details: { cwd: outside } });
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    await assertNothingWasTouched(before);
  }, 60_000);

  it("keeps the preflight ahead of ownership for the publish and integrate commands from an unowned cwd", async () => {
    // Ticket #163 review F1. `workspace cleanup` is the ONLY operation whose
    // ownership decision comes first: `poiesis publish` and `poiesis integrate`
    // each run the shared preflight (runtime identity, then the installed
    // state) before their own `resolveOwnedWorkspace`. So the same unowned cwd
    // yields the preflight's code through the command and the ownership code
    // through the library seam, and the compatibility matrix has to say so
    // rather than imply one order for all three operations.
    const unowned = fixture.repository.root;
    const before = await snapshot();
    const mark = markSubprocesses();

    // The command surface: the deferred installed state is decided first.
    for (const { operation, attempt } of [
      {
        operation: "poiesis publish" as const,
        attempt: () =>
          commandPublish([
            "--sha",
            fixture.candidateSha,
            "--candidate-tree",
            fixture.candidateTree,
            "--proof",
            JSON.stringify(proofShell(fixture.candidateSha, fixture.candidateTree)),
            "--title",
            "Spec 1",
            "--body",
            "body",
            "--cwd",
            unowned,
          ]),
      },
      {
        operation: "poiesis integrate" as const,
        attempt: () =>
          commandIntegrate([
            "--sha",
            fixture.candidateSha,
            "--candidate-tree",
            fixture.candidateTree,
            "--base",
            fixture.workspace.baseSha,
            "--message",
            "Spec 1: deferred local work",
            "--proof",
            JSON.stringify(proofShell(fixture.candidateSha, fixture.candidateTree)),
            "--staging",
            JSON.stringify(stagingEvidence(fixture)),
            "--acceptance",
            "Yes, this is what I wanted.",
            "--cwd",
            unowned,
          ]),
      },
    ]) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, "the preflight decides before ownership").toMatchObject(expectedDeferredFailure(operation));
    }

    // The library seam from the same cwd: ownership is the first decision.
    for (const attempt of [
      () =>
        publish({
          cwd: unowned,
          remote: "origin",
          integrationBranch: "main",
          candidateSha: fixture.candidateSha,
          candidateTree: fixture.candidateTree,
          provider: "fixture",
          project: fixture.repository.fixtures,
          title: "Spec 1",
          body: "body",
          proof: proofShell(fixture.candidateSha, fixture.candidateTree),
        }),
      () =>
        integrate({
          cwd: unowned,
          remote: "origin",
          integrationBranch: "main",
          expectedBaseSha: fixture.workspace.baseSha,
          candidateSha: fixture.candidateSha,
          candidateTree: fixture.candidateTree,
          message: "Spec 1: deferred local work",
          proof: proofShell(fixture.candidateSha, fixture.candidateTree),
          staging: stagingEvidence(fixture),
          authorAcceptance: "Yes, this is what I wanted.",
        }),
    ]) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, "the library seam resolves ownership first").toMatchObject({
        code: "WORKSPACE_OWNERSHIP_UNKNOWN",
      });
    }

    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    await assertNothingWasTouched(before);
  }, 60_000);

  it("reports CONFIG_NOT_INSTALLED from the primary installation authority inside an owned workspace", async () => {
    const installedConfig = join(fixture.repository.root, ".poiesis", "config.jsonc");
    await rm(installedConfig);
    const before = await snapshot();
    const mark = markSubprocesses();
    const error = await workspaceCleanup({ cwd: fixture.workspace.path, ownershipId: fixture.workspace.ownershipId }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({
      code: "CONFIG_NOT_INSTALLED",
      details: {
        operation: "poiesis workspace cleanup",
        // The PRIMARY path, never the workspace the cleanup was invoked from:
        // the authority is the installation, not the invocation root.
        path: installedConfig,
        remediation: expect.stringContaining("poiesis init"),
      },
    });
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    await assertNothingWasTouched(before);
  }, 60_000);

  it("keeps runtime-mismatch precedence ahead of the missing installed config inside an owned workspace", async () => {
    await rm(join(fixture.repository.root, ".poiesis", "config.jsonc"));
    const manifestPath = join(fixture.repository.root, ".poiesis", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { poiesisVersion: string };
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, poiesisVersion: "0.0.0-other" }, null, 2)}\n`);
    const before = await snapshot();
    const mark = markSubprocesses();
    const error = await workspaceCleanup({ cwd: fixture.workspace.path, ownershipId: fixture.workspace.ownershipId }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({
      code: "RUNTIME_VERSION_MISMATCH",
      details: { project: "0.0.0-other" },
    });
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    await assertNothingWasTouched(before);
  }, 60_000);

  it("keeps the deferred refusal unchanged inside an owned workspace", async () => {
    const before = await snapshot();
    const mark = markSubprocesses();
    const error = await workspaceCleanup({ cwd: fixture.workspace.path, ownershipId: fixture.workspace.ownershipId }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject(expectedDeferredFailure("poiesis workspace cleanup"));
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
    await assertNothingWasTouched(before);
  }, 60_000);
});

/**
 * Spec #139 / ticket #152 (Review correction) — the CLI operator surface.
 *
 * The four delivery-integrated command wrappers each run ONE shared preflight
 * before they read the installed config or resolve publishing coordinates:
 * `resolveGitRoot` / `resolveConfigRoot`, then the runtime identity guard, then
 * the central lifecycle-policy guard. So an operator sees the same typed
 * failure, with the same `details.operation` / `path` / `remediation`, that the
 * library seam reports — never an opaque file-read error and never a
 * wrapper-specific delivery decision.
 *
 * The preflight decides from the CONFIG root, so an invocation from a linked
 * worktree reads the installation itself and can never report a false missing
 * config; and because runtime identity runs first, an absent manifest keeps
 * its existing `RUNTIME_VERSION_MISMATCH` precedence.
 */
describe("the CLI preflight reports the same typed failures as the policy guard", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;
  let fixture: DeferredLocalProgress;

  beforeEach(async () => {
    env = await installFakeOpenCode();
    fixture = await deferredLocalProgress(repositories);
  }, 60_000);

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("refuses every delivery-integrated command with the installed-state failure, from either root", async () => {
    await rm(join(fixture.repository.root, ".poiesis", "config.jsonc"));
    const headsBefore = await remoteHeads(fixture.repository);
    const installedConfig = join(fixture.repository.root, ".poiesis", "config.jsonc");
    for (const cwd of [fixture.repository.root, fixture.workspace.path]) {
      for (const { operation, attempt } of cliAttempts(fixture, cwd)) {
        const mark = markSubprocesses();
        const error = await attempt().then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error, `${operation} (cwd ${cwd}) must be refused`).toMatchObject({
          code: "CONFIG_NOT_INSTALLED",
          details: {
            operation,
            // The decision is read from the installation, never from the
            // invocation root, so a linked-worktree `--cwd` cannot report a
            // false missing config.
            path: installedConfig,
            remediation: expect.stringContaining("poiesis init"),
          },
        });
        expect(reachedSideEffects(subprocessCallsSince(mark)), `${operation} from ${cwd}`).toEqual([]);
      }
    }
    expect(await remoteHeads(fixture.repository)).toBe(headsBefore);
    expect(existsSync(fixture.artifactPath)).toBe(false);
  }, 60_000);

  it("refuses a deferred install with DELIVERY_DEFERRED from either root, before the config is read", async () => {
    for (const cwd of [fixture.repository.root, fixture.workspace.path]) {
      for (const { operation, attempt } of cliAttempts(fixture, cwd)) {
        const error = await attempt().then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error, `${operation} (cwd ${cwd})`).toMatchObject(expectedDeferredFailure(operation));
      }
    }
    expect(existsSync(fixture.artifactPath)).toBe(false);
  }, 60_000);

  it("keeps manifest absence reported by the runtime identity guard, never as an installed-config failure", async () => {
    await rm(join(fixture.repository.root, ".poiesis", "manifest.json"));
    for (const { operation, attempt } of cliAttempts(fixture, fixture.workspace.path)) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, operation).toMatchObject({
        code: "RUNTIME_VERSION_MISMATCH",
        details: { project: null },
      });
    }
  }, 60_000);

  it("reports the same installed-state failure for a fully uninstalled project only as a runtime-identity failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const mark = markSubprocesses();
    const error = await commandPublish([
      "--sha",
      "0".repeat(40),
      "--candidate-tree",
      "0".repeat(40),
      "--proof",
      "{}",
      "--title",
      "Spec 1",
      "--body",
      "body",
      "--cwd",
      repository.root,
    ]).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({ code: "RUNTIME_VERSION_MISMATCH", details: { project: null } });
    expect(reachedSideEffects(subprocessCallsSince(mark))).toEqual([]);
  }, 30_000);
});

describe("deferred-delivery guidance", () => {
  const GUIDED_STATEMENTS: readonly string[] = [
    '"delivery": { "mode": "deferred" }',
    "pauses after exact-candidate Proof",
    "DELIVERY_DEFERRED",
    "must not claim",
  ];

  it("POIESIS_METHOD.md states that explicit deferred delivery pauses after Proof and forbids a completion or Preview claim", () => {
    const method = readFileSync(join(REPO_ROOT, "POIESIS_METHOD.md"), "utf8");
    for (const statement of GUIDED_STATEMENTS) {
      expect(method, "POIESIS_METHOD.md must state: " + statement).toContain(statement);
    }
  });

  it("POIESIS_ROLE_POIESIS.md states the same paused-after-Proof rule", () => {
    const role = readFileSync(join(REPO_ROOT, "POIESIS_ROLE_POIESIS.md"), "utf8");
    for (const statement of GUIDED_STATEMENTS) {
      expect(role, "POIESIS_ROLE_POIESIS.md must state: " + statement).toContain(statement);
    }
  });

  it("OPENCODE_AGENT_POIESIS.md projects the same paused-after-Proof rule to the installed agent", () => {
    const agent = readFileSync(join(REPO_ROOT, "OPENCODE_AGENT_POIESIS.md"), "utf8");
    for (const statement of GUIDED_STATEMENTS) {
      expect(agent, "OPENCODE_AGENT_POIESIS.md must state: " + statement).toContain(statement);
    }
  });
});

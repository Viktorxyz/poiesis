/**
 * Spec #139 / ticket #145 — package-level qualification for a built
 * `poiesis-cli` on the Local tracker with deferred delivery.
 *
 * Everything before this file proved the two trackers, the deferred mode,
 * and the interactive questions against the source tree. This file proves
 * the thing an operator actually installs: the packed tarball, extracted
 * into a real `node_modules/poiesis-cli` and invoked through the real
 * `node_modules/.bin/poiesis` symlink, against a real temporary Git
 * repository, for the exact configuration a project with no forge and no
 * deployment pipeline records:
 *
 *     { "tracker": { "provider": "local" }, "delivery": { "mode": "deferred" } }
 *
 * What it qualifies, and why each one is a package-level fact:
 *
 *   1. `pnpm pack` ships the whole canonical surface, and the extracted
 *      package can read it. `init` materializes `.poiesis/METHOD.md` and
 *      `.opencode/agents/poiesis.md` byte-for-byte from the PACKED bytes,
 *      so a doc missing from `package.json::files` fails here rather than
 *      in a consumer's install.
 *   2. The installed config records exactly the two blocks, with no
 *      `project` and no `team` invented for the clone-local tracker.
 *   3. `init` mutates nothing on the remote: the bare remote's refs and
 *      its entire object database are byte-identical before and after.
 *   4. A deferred install writes no delivery script, because there is no
 *      delivery command to run.
 *   5. `doctor` is healthy — `report.ok === true`, the `tracker` check
 *      passes, `delivery` is a nonblocking `warn`. A deferred install is
 *      not a defect.
 *   6. The tracker lifecycle works through the real bin with no tracker
 *      CLI on PATH and no credential anywhere, and the store lives under
 *      the Git common directory rather than in the working tree.
 *   7. The local work still reaches exact-candidate Proof, and every
 *      delivery-integrated operation then hard-stops with zero remote side
 *      effects: the remote's refs and objects are still byte-identical,
 *      no delivery script exists, and no delivery evidence was written.
 *
 * Two dependencies are shimmed, exactly as `opencode` and `uv` are shimmed
 * throughout this suite, because neither is what this qualification is
 * about and neither can be acquired offline:
 *
 *   - `uv` — Repository Intelligence's exact-version runtime. `init` and
 *     `doctor` require its presence; nothing here invokes Graphify.
 *   - `npx` — the upstream Agent Skills CLI that `init` shells out to in
 *     order to materialize the 11 curated skills into a staging tree. The
 *     shim materializes the exact `--skill` directories `init` then hashes
 *     and records, so the skills half of the transaction runs to
 *     completion without a network fetch. It stands in for the network,
 *     not for the behavior under test.
 *
 * The remote is a filesystem bare repository: a real Git remote with no
 * network, and the shape a Veritium-style project actually has. Every
 * delivery-integrated operation is refused by the ONE central lifecycle
 * policy, through the shared CLI preflight (ticket #152), so the refusal
 * code no longer depends on the remote's shape: a deferred install reports
 * `DELIVERY_DEFERRED` for `poiesis publish` exactly as it does for the
 * other five, before publishing coordinates are resolved at all. On a
 * CONFIGURED install with an unrecognized remote, `poiesis publish` still
 * refuses with `PUBLISH_PROVIDER_UNRESOLVED`; that is a separate,
 * equally fail-closed condition with the same zero remote side effects.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/process.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");
const BRANCH = "poiesis/veritium-spec-1";
const PROOF_REVIEWER = "final-review-145";

interface SuccessEnvelope<T> {
  ok: true;
  operation: string;
  result: T;
}

interface FailureEnvelope {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "warn";
  message: string;
  details?: Record<string, unknown>;
}

interface DoctorReport {
  root: string;
  ok: boolean;
  checks: DoctorCheck[];
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  success?: SuccessEnvelope<unknown>;
  failure?: FailureEnvelope;
}

interface RemoteState {
  refs: string;
  objects: string;
}

interface InstalledConsumer {
  /** The extracted package root: `<consumer>/node_modules/poiesis-cli`. */
  packageRoot: string;
  /** The real `node_modules/.bin/poiesis` symlink an install creates. */
  binPath: string;
  scratch: string;
  repoRoot: string;
  remote: string;
}

interface Qualifier {
  initResult: CliResult;
  remoteBefore: RemoteState;
  remoteAfterInit: RemoteState;
  remoteAfterBlocked: RemoteState;
  doctor: DoctorReport;
  spec: { id: string; title: string };
  ticket: { id: string; parentSpecId: string; dependencyText: string };
  closedTicket: { id: string; state: string };
  workspace: { path: string; branch: string; baseSha: string };
  candidate: { sha: string; tree: string };
}

let installed: InstalledConsumer | undefined;
let qualifier: Qualifier | undefined;
let restoreShims: (() => void) | undefined;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * The remote's complete observable state: every ref, and every object in
 * the object database. A push, a force-update, a delete, or even a failed
 * push that left an object behind changes one of these.
 */
async function remoteState(remote: string): Promise<RemoteState> {
  return {
    refs: await git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    objects: [
      ...(await git(remote, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]))
        .split("\n")
        .sort(),
    ].join("\n"),
  };
}

/**
 * Run the installed bin the way a shell resolves
 * `node_modules/.bin/poiesis`: `node <the symlink>`. Going through the
 * symlink is the point — `dist/cli.js` is reached through a link whose
 * `process.argv[1]` differs from its realpath, which is the exact shape
 * that once made the packaged bin exit 0 silently.
 */
async function cli(args: string[], cwd: string): Promise<CliResult> {
  if (installed === undefined) throw new Error("the packed package is not installed");
  const result = await run("node", [installed.binPath, ...args, "--cwd", cwd], {
    cwd,
    allowFailure: true,
    timeoutMs: 120_000,
  });
  if (result.exitCode === 0) {
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      success: JSON.parse(result.stdout) as SuccessEnvelope<unknown>,
    };
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    failure: JSON.parse(result.stderr) as FailureEnvelope,
  };
}

function expectSuccess<T>(result: CliResult, operation: string): T {
  if (result.exitCode !== 0) {
    throw new Error(
      `expected \`${operation}\` to succeed, got exit ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  return (result.success as SuccessEnvelope<T>).result;
}

function expectBlocked(result: CliResult, code: string, label: string): FailureEnvelope {
  if (result.exitCode === 0) {
    throw new Error(`expected \`${label}\` to fail closed, but it succeeded: ${result.stdout}`);
  }
  const failure = result.failure;
  if (failure === undefined) {
    throw new Error(`\`${label}\` did not emit a structured failure envelope: ${result.stderr}`);
  }
  expect(failure.error.code, `\`${label}\` must fail closed with ${code}`).toBe(code);
  return failure;
}

function canonicalProof(candidateSha: string, candidateTree: string): string {
  return JSON.stringify({
    candidateSha,
    candidateTree,
    verified: true,
    specReview: { verdict: "PASS", reviewerIdentity: PROOF_REVIEWER },
    standardsReview: { verdict: "PASS", reviewerIdentity: PROOF_REVIEWER },
  });
}

function publishEvidence(candidateSha: string, candidateTree: string): string {
  return JSON.stringify({
    candidateSha,
    candidateTree,
    verified: true,
    branch: BRANCH,
    remoteRef: `refs/heads/${BRANCH}`,
    publishedHeadSha: candidateSha,
    provider: "github",
    action: "pushed",
    changeRequest: { id: null, url: null },
  });
}

/** A `uv` that reports a version and exits 0; nothing here runs Graphify. */
async function installFakeUv(): Promise<() => void> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fresh-uv-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    void rm(parent, { recursive: true, force: true });
  };
}

/**
 * The upstream Agent Skills CLI is invoked as
 * `npx --yes skills@<pin> add <source>#<revision> --skill <name>... --copy`,
 * and `init` then requires every requested name to exist as a directory
 * under `<cwd>/.agents/skills`. This shim materializes exactly those
 * directories so the skills half of the `init` transaction runs to
 * completion offline. Every non-option argument after `--skill` is a skill
 * name, because the caller passes the whole group in one flag.
 */
async function installFakeSkillsCli(): Promise<() => void> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fresh-skills-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "npx");
  await writeFile(
    script,
    `#!/bin/sh
root="$(pwd)/.agents/skills"
in_skills=0
for arg in "$@"; do
  case "$arg" in
    --skill) in_skills=1; continue ;;
    -*) in_skills=0; continue ;;
  esac
  if [ "$in_skills" = "1" ]; then
    mkdir -p "$root/$arg"
    printf '# %s\\n\\nPinned skill materialization.\\n' "$arg" > "$root/$arg/SKILL.md"
  fi
done
exit 0
`,
  );
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    void rm(parent, { recursive: true, force: true });
  };
}

interface InstalledConfig {
  schema: number;
  tracker: Record<string, unknown>;
  delivery: Record<string, unknown>;
}

function readInstalledConfig(repoRoot: string): InstalledConfig {
  return JSON.parse(readFileSync(join(repoRoot, ".poiesis", "config.jsonc"), "utf8")) as InstalledConfig;
}

/** Every generated delivery script in the checkout. A deferred install has none. */
async function generatedDeliveryScripts(repoRoot: string): Promise<string[]> {
  const scriptsDir = join(repoRoot, "scripts");
  if (!existsSync(scriptsDir)) return [];
  return (await readdir(scriptsDir))
    .filter((entry) => entry.startsWith("poiesis-") && entry.endsWith(".mjs"))
    .sort();
}

/**
 * `pnpm pack`, which runs the real `prepack` build, and return the tarball.
 *
 * The verification is not ceremony. `cli-bin.test.ts` and the release-contract
 * suite both build into the same shared `dist/` and `cli-bin.test.ts` removes
 * it in its own teardown, so a concurrent suite can delete `dist/` between
 * another suite's build and that suite's own pack. A tarball without
 * `package/dist/cli.js` is that race, not a package defect, so retry a
 * bounded number of times before reporting a failure.
 */
async function packBuiltPackage(destination: string): Promise<string> {
  let lastListing: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await execFileAsync("pnpm", ["pack", "--pack-destination", destination], { cwd: REPO_ROOT });
    const tarballs = (await readdir(destination)).filter(
      (entry) => entry.startsWith("poiesis-cli-") && entry.endsWith(".tgz"),
    );
    const tarball = tarballs[0];
    if (tarball === undefined) continue;
    lastListing = (await execFileAsync("tar", ["-tzf", join(destination, tarball)])).stdout.split("\n");
    if (lastListing.includes("package/dist/cli.js")) return tarball;
  }
  throw new Error(
    `pnpm pack never produced a tarball containing package/dist/cli.js; last listing: ${lastListing.join(", ")}`,
  );
}

/**
 * The complete, otherwise-valid inputs for every delivery-integrated
 * operation, so a refusal can only come from the fail-closed policy and
 * never from a missing or malformed argument.
 */
function blockedAttempts(
  repoRoot: string,
  workspacePath: string,
  candidate: { sha: string; tree: string },
  baseSha: string,
): ReadonlyArray<{ label: string; code: string; attempt: () => Promise<CliResult> }> {
  const { sha, tree } = candidate;
  const proof = canonicalProof(sha, tree);
  const previewIdentity = JSON.stringify({
    sha,
    candidateSha: sha,
    candidateTree: tree,
    target: "preview",
    verified: true,
    artifactIdentity: "artifact-preview",
    artifact: "artifact-preview",
  });
  const staging = JSON.stringify({
    candidateSha: sha,
    candidateTree: tree,
    target: "staging",
    artifactIdentity: "artifact-staging",
    verified: true,
  });
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
      // Ticket #152: the CLI preflight runs the central lifecycle policy
      // before the installed config is read and before publishing
      // coordinates are resolved, so a deferred install is refused by the
      // same policy as the other five operations, whatever the remote shape.
      label: "poiesis publish",
      code: "DELIVERY_DEFERRED",
      attempt: () =>
        cli(
          ["publish", "--sha", sha, "--candidate-tree", tree, "--proof", proof, "--title", "Veritium onboarding", "--body", "body"],
          workspacePath,
        ),
    },
    {
      label: "poiesis preview",
      code: "DELIVERY_DEFERRED",
      attempt: () =>
        cli(
          [
            "preview",
            "--sha",
            sha,
            "--candidate-tree",
            tree,
            "--proof",
            proof,
            "--publish",
            publishEvidence(sha, tree),
          ],
          workspacePath,
        ),
    },
    {
      label: "poiesis promote --target staging",
      code: "DELIVERY_DEFERRED",
      attempt: () =>
        cli(
          ["promote", "--sha", sha, "--candidate-tree", tree, "--target", "staging", "--identity", previewIdentity],
          workspacePath,
        ),
    },
    {
      label: "poiesis promote --target production",
      code: "DELIVERY_DEFERRED",
      attempt: () =>
        cli(
          [
            "promote",
            "--sha",
            sha,
            "--candidate-tree",
            tree,
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
          ],
          workspacePath,
        ),
    },
    {
      label: "poiesis integrate",
      code: "DELIVERY_DEFERRED",
      attempt: () =>
        cli(
          [
            "integrate",
            "--sha",
            sha,
            "--base",
            baseSha,
            "--candidate-tree",
            tree,
            "--proof",
            proof,
            "--staging",
            staging,
            "--acceptance",
            "Yes, this is what I wanted.",
            "--message",
            "Veritium onboarding",
          ],
          workspacePath,
        ),
    },
    {
      label: "poiesis workspace cleanup",
      code: "DELIVERY_DEFERRED",
      attempt: () => cli(["workspace", "cleanup"], workspacePath),
    },
  ];
}

beforeAll(async () => {
  const restoreUv = await installFakeUv();
  const restoreSkillsCli = await installFakeSkillsCli();
  restoreShims = () => {
    restoreSkillsCli();
    restoreUv();
  };

  // 1. Build and pack. `prepack` runs the real build, so this is the same
  //    artifact an operator would download.
  const scratch = await mkdtemp(join(tmpdir(), "poiesis-fresh-install-"));
  const tarball = await packBuiltPackage(scratch);

  // 2. Install it offline the way npm/pnpm lay a package out: extract the
  //    tarball into `node_modules/poiesis-cli` and link the bin.
  const consumerDir = join(scratch, "consumer");
  const packageRoot = join(consumerDir, "node_modules", "poiesis-cli");
  await mkdir(join(consumerDir, "node_modules", ".bin"), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await execFileAsync("tar", ["-xzf", join(scratch, tarball), "--strip-components=1", "-C", packageRoot]);
  // The runtime dependencies resolve from the consumer's own `node_modules`;
  // link the three the published package declares, so the install resolves
  // them exactly as a real one would with no registry access.
  for (const dependency of ["zod", "jsonc-parser", "@clack/prompts"]) {
    const target = join(consumerDir, "node_modules", dependency);
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(join(REPO_ROOT, "node_modules", dependency), target);
  }
  const binPath = join(consumerDir, "node_modules", ".bin", "poiesis");
  await symlink(join(packageRoot, "dist", "cli.js"), binPath);

  // 3. A real Git repository with a real (filesystem) remote. The project
  //    needs a `package.json` because `init` maintains the `pnpm poiesis`
  //    script there.
  const projectDir = join(scratch, "project");
  const repoRoot = join(projectDir, "repo");
  const remote = join(projectDir, "remote.git");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "--quiet", "--initial-branch=main"]);
  await git(repoRoot, ["config", "user.name", "Poiesis Fresh Install"]);
  await git(repoRoot, ["config", "user.email", "fresh-install@example.test"]);
  await writeFile(join(repoRoot, "README.md"), "Veritium-style project\n");
  await writeFile(
    join(repoRoot, "package.json"),
    `${JSON.stringify(
      { name: "veritium-style-project", private: true, version: "0.0.0", scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    )}\n`,
  );
  await git(repoRoot, ["add", "README.md", "package.json"]);
  await git(repoRoot, ["commit", "--quiet", "-m", "initial"]);
  await execFileAsync("git", ["init", "--quiet", "--bare", remote], { cwd: projectDir });
  await git(repoRoot, ["remote", "add", "origin", remote]);
  await git(repoRoot, ["push", "--quiet", "-u", "origin", "main"]);

  installed = { packageRoot, binPath, scratch, repoRoot, remote };
  const remoteBefore = await remoteState(remote);

  // 4. Install Poiesis through the real bin with exactly the two blocks a
  //    project with no forge and no deployment pipeline records. The candidate
  //    file is named `poiesis-config.jsonc` — the one filename the shipped
  //    bootstrap prompt, the README, and the canonical Method all use for both
  //    the initial `init --config` and the later `update --config`.
  const installConfig = join(projectDir, "poiesis-config.jsonc");
  await writeFile(
    installConfig,
    `${JSON.stringify(
      {
        schema: 1,
        // Spec #190 / ticket #191: a non-interactive `--config` init states
        // the sharing mode explicitly; this project with no forge and no
        // deployment pipeline installs private/local mode.
        mode: "private",
        models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
        tracker: { provider: "local" },
        delivery: { mode: "deferred" },
      },
      null,
      2,
    )}\n`,
  );
  const raw = await run("node", [binPath, "init", "--config", installConfig, "--cwd", repoRoot], {
    cwd: repoRoot,
    allowFailure: true,
    timeoutMs: 180_000,
  });
  if (raw.exitCode !== 0) {
    throw new Error(`\`poiesis init --config\` failed in a fresh install: ${raw.stderr || raw.stdout}`);
  }
  const initResult: CliResult = {
    exitCode: 0,
    stdout: raw.stdout,
    stderr: raw.stderr,
    success: JSON.parse(raw.stdout) as SuccessEnvelope<unknown>,
  };
  const remoteAfterInit = await remoteState(remote);

  // 5. The healthy installed state, then the whole local lifecycle through
  //    Proof, then every blocked delivery-integrated operation.
  const doctor = expectSuccess<DoctorReport>(await cli(["doctor"], repoRoot), "poiesis doctor");

  const spec = expectSuccess<{ id: string; title: string }>(
    await cli(["tracker", "spec", "create", "--title", "Veritium onboarding", "--body", "Canonical Spec body."], repoRoot),
    "poiesis tracker spec create",
  );
  const ticket = expectSuccess<{ id: string; parentSpecId: string; dependencyText: string }>(
    await cli(
      [
        "tracker",
        "ticket",
        "create",
        "--title",
        "Ship the doc contract",
        "--body",
        "Ticket body.",
        "--parent",
        spec.id,
        "--dependencies",
        "none",
      ],
      repoRoot,
    ),
    "poiesis tracker ticket create",
  );
  expectSuccess<{ id: string }>(
    await cli(["tracker", "spec", "get", "--id", spec.id], repoRoot),
    "poiesis tracker spec get",
  );
  expectSuccess(
    await cli(["tracker", "ticket", "comment", "--id", ticket.id, "--body", "Accepted after review."], repoRoot),
    "poiesis tracker ticket comment",
  );
  const closedTicket = expectSuccess<{ id: string; state: string }>(
    await cli(["tracker", "ticket", "close", "--id", ticket.id], repoRoot),
    "poiesis tracker ticket close",
  );
  expectSuccess(await cli(["tracker", "spec", "close", "--id", spec.id], repoRoot), "poiesis tracker spec close");

  const workspace = expectSuccess<{ path: string; branch: string; baseSha: string }>(
    await cli(["workspace", "prepare", "--branch", BRANCH, "--spec", spec.id], repoRoot),
    "poiesis workspace prepare",
  );
  await writeFile(join(workspace.path, "feature.txt"), "local work under a deferred lifecycle\n");
  const accepted = expectSuccess<{ sha: string }>(
    await cli(
      [
        "checkpoint",
        "--path",
        "feature.txt",
        "--message",
        "ticket 145: local work",
        "--reviewer",
        PROOF_REVIEWER,
        "--evidence",
        "no findings",
      ],
      workspace.path,
    ),
    "poiesis checkpoint",
  );
  const candidate = {
    sha: accepted.sha,
    tree: (await git(workspace.path, ["rev-parse", `${accepted.sha}^{tree}`])).trim(),
  };
  expectSuccess<{ candidateSha: string; cleanBefore: boolean; cleanAfter: boolean }>(
    await cli(["verify", "--sha", candidate.sha], workspace.path),
    "poiesis verify",
  );

  for (const attempt of blockedAttempts(repoRoot, workspace.path, candidate, workspace.baseSha)) {
    expectBlocked(await attempt.attempt(), attempt.code, attempt.label);
  }
  const remoteAfterBlocked = await remoteState(remote);

  qualifier = {
    initResult,
    remoteBefore,
    remoteAfterInit,
    remoteAfterBlocked,
    doctor,
    spec,
    ticket,
    closedTicket,
    workspace,
    candidate,
  };
}, 600_000);

afterAll(async () => {
  restoreShims?.();
  restoreShims = undefined;
  if (installed !== undefined) {
    // The whole scratch tree: the packed tarball, the extracted package, the
    // consumer project, and its bare remote.
    await rm(installed.scratch, { recursive: true, force: true });
  }
  installed = undefined;
  qualifier = undefined;
});

function state(): Qualifier {
  if (qualifier === undefined) throw new Error("the fresh-install qualification did not run");
  return qualifier;
}

describe("a packed poiesis-cli installs on the Local tracker with deferred delivery", () => {
  it("installs from the packed tarball through the real bin", () => {
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    expect(state().initResult.success?.operation).toBe("init");
    expect(existsSync(consumer.packageRoot)).toBe(true);
    expect(existsSync(join(consumer.packageRoot, "dist", "cli.js"))).toBe(true);
    // The install's durable surfaces exist in the consumer project.
    expect(existsSync(join(consumer.repoRoot, ".poiesis", "manifest.json"))).toBe(true);
    expect(existsSync(join(consumer.repoRoot, ".poiesis", "config.jsonc"))).toBe(true);
    expect(existsSync(join(consumer.repoRoot, ".opencode", "agents", "poiesis.md"))).toBe(true);
  });

  it("projects the packed canon byte-for-byte, so the shipped doc and the installed doc cannot drift", () => {
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    for (const [source, destination] of [
      ["POIESIS_METHOD.md", join(".poiesis", "METHOD.md")],
      ["POIESIS_PHILOSOPHY.md", join(".poiesis", "PHILOSOPHY.md")],
      ["POIESIS_ROLE_POIESIS.md", join(".poiesis", "roles", "poiesis.md")],
      ["POIESIS_ROLE_WORKER.md", join(".poiesis", "roles", "worker.md")],
      ["OPENCODE_AGENT_POIESIS.md", join(".opencode", "agents", "poiesis.md")],
    ] as const) {
      const packed = readFileSync(join(consumer.packageRoot, source));
      const projected = readFileSync(join(consumer.repoRoot, destination));
      expect(projected.equals(packed), `${destination} must be the packed ${source} byte-for-byte`).toBe(true);
    }
  });

  it("records exactly the Local tracker and the deferred delivery state, inventing no coordinate", () => {
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    const config = readInstalledConfig(consumer.repoRoot);
    expect(config.tracker).toEqual({ provider: "local" });
    // A clone-local tracker has no `project` and no `team`; Poiesis must not
    // invent one from the remote the way it may for a forge.
    expect(config.tracker).not.toHaveProperty("project");
    expect(config.tracker).not.toHaveProperty("team");
    expect(config.delivery).toEqual({ mode: "deferred" });
    // A deferred state is a `mode`, never a per-target deferral.
    expect(config.delivery).not.toHaveProperty("preview");
    expect(config.delivery).not.toHaveProperty("staging");
    expect(config.delivery).not.toHaveProperty("production");
  });

  it("generates no delivery script, because there is no delivery command to run", async () => {
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    expect(await generatedDeliveryScripts(consumer.repoRoot)).toEqual([]);
    expect(existsSync(join(consumer.repoRoot, "scripts"))).toBe(false);
  });

  it("mutates nothing on the remote during install", () => {
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    const { remoteBefore, remoteAfterInit } = state();
    expect(remoteAfterInit.refs).toBe(remoteBefore.refs);
    expect(remoteAfterInit.objects).toBe(remoteBefore.objects);
    // Only the base branch the test itself pushed may exist.
    const refs = remoteAfterInit.refs.split("\n").filter((line) => line.length > 0);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toContain("refs/heads/main");
  });
});

describe("a Local + deferred install is healthy", () => {
  it("reports doctor.ok === true with a nonblocking delivery warning", () => {
    const report = state().doctor;
    expect(report.ok).toBe(true);
    const failing = report.checks.filter((check) => check.status === "fail");
    expect(failing, `doctor must report no failures, got ${JSON.stringify(failing)}`).toEqual([]);

    const delivery = report.checks.find((check) => check.id === "delivery");
    expect(delivery?.status).toBe("warn");
    expect(delivery?.message).toContain("deferred");
    expect(delivery?.details).toMatchObject({ mode: "deferred" });

    // The clone-local tracker is a real, healthy tracker — not a warning.
    const tracker = report.checks.find((check) => check.id === "tracker");
    expect(tracker?.status).toBe("pass");
    expect(tracker?.details).toMatchObject({ provider: "local", coordinates: "none (clone-local store)" });
  });

  it("runs the whole tracker lifecycle through the installed bin with no tracker CLI and no credential", () => {
    const { spec, ticket, closedTicket } = state();
    expect(spec).toMatchObject({ id: "LOCAL-1", title: "Veritium onboarding" });
    expect(ticket).toMatchObject({ id: "LOCAL-2", parentSpecId: "LOCAL-1", dependencyText: "none" });
    expect(closedTicket).toMatchObject({ id: "LOCAL-2", state: "closed" });
  });

  it("keeps the tracker store in the Git common directory, out of every working tree", async () => {
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    const storeDir = join(consumer.repoRoot, ".git", "poiesis-tracker-v1");
    const storeFile = join(storeDir, "store.json");
    expect(existsSync(storeFile)).toBe(true);

    // The store sits beside the objects, not in the checkout, so it is never
    // foreign work and can never reach a candidate commit.
    expect(await git(consumer.repoRoot, ["status", "--porcelain"])).not.toContain("poiesis-tracker-v1");
    expect(await git(consumer.repoRoot, ["ls-files"])).not.toContain("poiesis-tracker-v1");

    // A first-class product store, not a test fixture: 0700 with 0600 files.
    expect(statSync(storeDir).mode & 0o777).toBe(0o700);
    expect(statSync(storeFile).mode & 0o777).toBe(0o600);
  });
});

describe("a Local + deferred install reaches Proof and then hard-stops", () => {
  it("prepares a workspace, checkpoints an accepted Review, and proves the exact candidate", () => {
    const { workspace, candidate } = state();
    expect(workspace.branch).toBe(BRANCH);
    // The default in-project workspace path, never an external one.
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    expect(workspace.path.startsWith(join(consumer.repoRoot, ".poiesis", "workspaces"))).toBe(true);
    expect(candidate.sha).not.toBe(workspace.baseSha);
    expect(candidate.tree).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("every delivery-integrated operation is blocked with zero remote side effects", () => {
  it("leaves the remote, the project, and the delivery surface exactly as they were", async () => {
    const consumer = installed;
    if (consumer === undefined) throw new Error("the packed package is not installed");
    const fixture = state();
    expect(fixture.remoteAfterBlocked.refs, "no ref may be created, updated, or deleted").toBe(
      fixture.remoteBefore.refs,
    );
    expect(fixture.remoteAfterBlocked.objects, "no object may reach the remote").toBe(
      fixture.remoteBefore.objects,
    );

    // Nothing may be created in the project to stand in for a delivery.
    expect(await generatedDeliveryScripts(consumer.repoRoot)).toEqual([]);
    expect(existsSync(join(consumer.repoRoot, "scripts"))).toBe(false);
    for (const evidence of ["delivery.json", "preview.json", "staging.json", "production.json"]) {
      expect(existsSync(join(consumer.repoRoot, evidence)), `${evidence} must not exist`).toBe(false);
    }

    // The blocked operations may not have silently changed the installed
    // state: still a clone-local tracker, still explicitly deferred.
    const config = readInstalledConfig(consumer.repoRoot);
    expect(config.tracker).toEqual({ provider: "local" });
    expect(config.delivery).toEqual({ mode: "deferred" });
  });
});

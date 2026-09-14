#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readUtf8 } from "./fs.js";
import { parseJsonc, validateConfig, loadConfig, type PoiesisConfig, type ResolvedPoiesisConfig } from "./config.js";
import { writeFailure, writeSuccess } from "./output.js";
import { packageRoot, resolveGitRoot } from "./paths.js";
import { init, doctor, update, uninstall, resolveConfigForRoot, resolveConfigRoot, installAuthorizedCapability, updateFromConfig } from "./maintenance.js";
import {
  checkpoint,
  integrate,
  publish,
  verify,
  workspaceCleanup,
  workspacePrepare,
} from "./git.js";
import { inspectProject } from "./inspect.js";
import {
  createTrackerAdapter,
  previewDelivery,
  promoteDelivery,
  type DeliveryIdentity,
  type SupersedeInput,
} from "./adapters.js";
import { cleanupOpenCodeSession } from "./session.js";
import { PoiesisError } from "./errors.js";
import type { IntegrationEvidence, ProductionAuthorization, ProofEvidence, PublishEvidence, StagingEvidence } from "./evidence.js";
import type { ProofPayload, StagingPayload } from "./adapters.js";

type Values = Record<string, string | boolean | string[] | undefined>;

const HELP = `Poiesis deterministic runtime

Usage:
  poiesis init --config <file> [--allow-fixtures]
  poiesis doctor
  poiesis update [--bootstrap-legacy-ownership]
  poiesis update --config <file>
  poiesis uninstall
  poiesis inspect
  poiesis capability install --source <owner/repo> --name <skill> --revision <sha>
  poiesis workspace prepare --branch <name> --spec <id>     # default: Omit \`--path\`; the CLI selects a deterministic in-project workspace under <root>/.poiesis/workspaces/<derived-id>. Never an external path such as \`/tmp/...\`
  poiesis workspace prepare --branch <name> --path <absolute> --spec <id>     # exceptional only: when the Author explicitly supplied an exceptional path or compatibility recovery requires the exact pre-existing path
  poiesis workspace cleanup [--ownership-id <id>] [--expected-head <sha>] [--delivered <sha>]
  poiesis checkpoint --path <path>... --message <text> --reviewer <id> --evidence <text>
  poiesis verify --sha <sha>
  poiesis publish --sha <sha> --candidate-tree <tree> --proof <json> --title <text> --body <text>     # Publish only after Verify, Spec Review, and Standards Review pass; \`--proof\` is the canonical identity-bound proof (candidateSha, candidateTree, verified: true, specReview { verdict: PASS, reviewerIdentity }, standardsReview { verdict: PASS, reviewerIdentity }) for the same clean candidate.
  poiesis preview --sha <sha> --candidate-tree <tree> --proof <json> --publish <json>     # Preview only after Publish succeeds. \`--publish\` is the same canonical candidate-bound Publish evidence (candidateSha, candidateTree, verified: true, branch, remoteRef, publishedHeadSha, provider, action, changeRequest) that drove the successful Publish. Poiesis must not claim that a Preview exists or ask for Author validation until the deterministic \`poiesis preview\` operation succeeds and returns a concrete Preview identity (\`id\`, \`url\`, and/or \`artifact\`).
  poiesis integrate --sha <sha> --base <sha> --candidate-tree <tree> --proof <json> --staging <json> --acceptance <text> --message <text>
  poiesis promote --sha <sha> --candidate-tree <tree> --target staging --identity <preview-json>
  poiesis promote --sha <sha> --candidate-tree <tree> --target production --identity <staging-json> --authorization <json> --proof <json> --integration <json>
  poiesis tracker <spec|ticket> <create|get|update|comment|close|supersede> [options]
  poiesis session cleanup --id <session-id> [--server <url>] [--directory <path>]

All commands accept --cwd <path>. Output and errors are structured JSON.
`;

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    const packageJson = JSON.parse(await readUtf8(resolve(packageRoot, "package.json"))) as { version: string };
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const command = argv[0]!;
  const rest = argv.slice(1);
  switch (command) {
    case "init":
      return commandInit(rest);
    case "doctor":
      return commandDoctor(rest);
    case "update":
      return commandUpdate(rest);
    case "uninstall":
      return commandUninstall(rest);
    case "inspect":
      return commandInspect(rest);
    case "capability":
      return commandCapability(rest);
    case "workspace":
      return commandWorkspace(rest);
    case "checkpoint":
      return commandCheckpoint(rest);
    case "verify":
      return commandVerify(rest);
    case "publish":
      return commandPublish(rest);
    case "preview":
      return commandPreview(rest);
    case "integrate":
      return commandIntegrate(rest);
    case "promote":
      return commandPromote(rest);
    case "tracker":
      return commandTracker(rest);
    case "session":
      return commandSession(rest);
    default:
      throw new PoiesisError("UNKNOWN_COMMAND", `Unknown command: ${command}`, { command });
  }
}

async function commandInit(args: string[]): Promise<void> {
  const values = options(args, {
    config: { type: "string" },
    "allow-fixtures": { type: "boolean" },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const root = await resolveGitRoot(cwd);
  const configPath = resolve(cwd, required(values, "config"));
  const config = validateConfig(parseJsonc(await readUtf8(configPath), configPath), configPath);
  writeSuccess(
    "init",
    await init(root, config, {
      allowFixtureAdapters: boolean(values, "allow-fixtures"),
    }),
  );
}

async function commandDoctor(args: string[]): Promise<void> {
  const values = options(args, { cwd: { type: "string" } });
  const root = await resolveGitRoot(cwdOf(values));
  const report = await doctor(root);
  writeSuccess("doctor", report);
  if (!report.ok) process.exitCode = 1;
}

export async function commandUpdate(args: string[]): Promise<void> {
  const values = options(args, {
    "skip-skills": { type: "boolean" },
    "bootstrap-legacy-ownership": { type: "boolean" },
    config: { type: "string" },
    cwd: { type: "string" },
  });
  const root = await resolveGitRoot(cwdOf(values));
  const configPath = values.config;
  if (typeof configPath === "string" && configPath.trim().length > 0) {
    // CLI-level guard: `--config` is incompatible with the other update options
    // even though `updateFromConfig` also rejects them. Failing here keeps the
    // dispatch surface auditable and lets the rejection be tested directly.
    if (values["skip-skills"] === true || values["bootstrap-legacy-ownership"] === true) {
      throw new PoiesisError(
        "INCOMPATIBLE_UPDATE_OPTIONS",
        "poiesis update --config cannot combine with --skip-skills or --bootstrap-legacy-ownership",
        {
          skipSkills: values["skip-skills"] === true,
          bootstrapLegacyOwnership: values["bootstrap-legacy-ownership"] === true,
        },
      );
    }
    writeSuccess("update", await updateFromConfig(root, resolve(cwdOf(values), configPath)));
    return;
  }
  if (typeof configPath !== "undefined") {
    throw new PoiesisError("MISSING_ARGUMENT", "Missing required --config", { key: "config" });
  }
  writeSuccess(
    "update",
    await update(root, {
      skipSkills: boolean(values, "skip-skills"),
      bootstrapLegacyOwnership: boolean(values, "bootstrap-legacy-ownership"),
    }),
  );
}

async function commandUninstall(args: string[]): Promise<void> {
  const values = options(args, { cwd: { type: "string" } });
  const root = await resolveGitRoot(cwdOf(values));
  writeSuccess("uninstall", await uninstall(root));
}

async function commandInspect(args: string[]): Promise<void> {
  const values = options(args, { cwd: { type: "string" } });
  writeSuccess("inspect", await inspectProject(cwdOf(values)));
}

async function commandCapability(args: string[]): Promise<void> {
  if (args[0] !== "install") throw new PoiesisError("UNKNOWN_COMMAND", "Expected capability install");
  const values = options(args.slice(1), {
    source: { type: "string" },
    name: { type: "string" },
    revision: { type: "string" },
    cwd: { type: "string" },
  });
  const root = await resolveGitRoot(cwdOf(values));
  writeSuccess(
    "capability.install",
    await installAuthorizedCapability(root, {
      source: required(values, "source"),
      name: required(values, "name"),
      revision: required(values, "revision"),
    }),
  );
}

async function commandWorkspace(args: string[]): Promise<void> {
  const operation = args[0];
  if (operation === "prepare") {
    const values = options(args.slice(1), {
      branch: { type: "string" },
      path: { type: "string" },
      spec: { type: "string" },
      cwd: { type: "string" },
    });
    const root = await resolveGitRoot(cwdOf(values));
    const config = await resolveConfigForRoot(root);
    writeSuccess(
      "workspace.prepare",
      await workspacePrepare({
        cwd: root,
        remote: config.repository.remote,
        integrationBranch: config.repository.integrationBranch,
        branch: required(values, "branch"),
        ...optionalAbsoluteWorkspacePath(values.path),
        specId: required(values, "spec"),
      }),
    );
    return;
  }
  if (operation === "cleanup") {
    const values = options(args.slice(1), {
      "ownership-id": { type: "string" },
      "expected-head": { type: "string" },
      delivered: { type: "string" },
      cwd: { type: "string" },
    });
    writeSuccess(
      "workspace.cleanup",
      await workspaceCleanup({
        cwd: cwdOf(values),
        ...optional(values, "ownership-id", "ownershipId"),
        ...optional(values, "expected-head", "expectedHeadSha"),
        ...optional(values, "delivered", "deliveredSha"),
      }),
    );
    return;
  }
  throw new PoiesisError("UNKNOWN_COMMAND", "Expected workspace prepare or workspace cleanup");
}

async function commandCheckpoint(args: string[]): Promise<void> {
  const values = options(args, {
    path: { type: "string", multiple: true },
    message: { type: "string" },
    reviewer: { type: "string" },
    evidence: { type: "string" },
    "ownership-id": { type: "string" },
    cwd: { type: "string" },
  });
  writeSuccess(
    "checkpoint",
    await checkpoint({
      cwd: cwdOf(values),
      paths: requiredMany(values, "path"),
      message: required(values, "message"),
      review: {
        verdict: "PASS",
        reviewerIdentity: required(values, "reviewer"),
        evidence: required(values, "evidence"),
      },
      ...optional(values, "ownership-id", "ownershipId"),
    }),
  );
}

async function commandVerify(args: string[]): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const repoRoot = await resolveGitRoot(cwd);
  const configRoot = await resolveConfigRoot(repoRoot);
  const config = await resolveConfigForRoot(configRoot);
  const commands = config.verification.commands;
  writeSuccess("verify", await verify({ cwd: repoRoot, candidateSha: required(values, "sha"), commands }));
}

async function commandPublish(args: string[]): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    "candidate-tree": { type: "string" },
    proof: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    "ownership-id": { type: "string" },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const repoRoot = await resolveGitRoot(cwd);
  const configRoot = await resolveConfigRoot(repoRoot);
  const config = await resolveConfigForRoot(configRoot);
  writeSuccess(
    "publish",
    await publish({
      cwd: repoRoot,
      remote: config.repository.remote,
      integrationBranch: config.repository.integrationBranch,
      candidateSha: required(values, "sha"),
      candidateTree: required(values, "candidate-tree"),
      provider: config.tracker.provider,
      project: config.tracker.project,
      title: required(values, "title"),
      body: required(values, "body"),
      proof: json<ProofPayload>(required(values, "proof"), "proof"),
      ...optional(values, "ownership-id", "ownershipId"),
    }),
  );
}

async function commandPreview(args: string[]): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    "candidate-tree": { type: "string" },
    proof: { type: "string" },
    publish: { type: "string" },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const repoRoot = await resolveGitRoot(cwd);
  const configRoot = await resolveConfigRoot(repoRoot);
  const config = await resolveConfigForRoot(configRoot);
  writeSuccess(
    "preview",
    await previewDelivery(
      config.delivery.preview,
      {
        sha: required(values, "sha"),
        candidateTree: required(values, "candidate-tree"),
        proof: json<ProofPayload>(required(values, "proof"), "proof"),
        publish: json<PublishEvidence>(required(values, "publish"), "publish"),
        remote: config.repository.remote,
      },
      repoRoot,
    ),
  );
}

async function commandIntegrate(args: string[]): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    base: { type: "string" },
    "candidate-tree": { type: "string" },
    proof: { type: "string" },
    staging: { type: "string" },
    acceptance: { type: "string" },
    message: { type: "string" },
    "ownership-id": { type: "string" },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const repoRoot = await resolveGitRoot(cwd);
  const configRoot = await resolveConfigRoot(repoRoot);
  const config = await resolveConfigForRoot(configRoot);
  const postIntegrationCommands = config.verification.postIntegrationCommands ?? config.verification.commands;
  writeSuccess(
    "integrate",
    await integrate({
      cwd: repoRoot,
      remote: config.repository.remote,
      integrationBranch: config.repository.integrationBranch,
      expectedBaseSha: required(values, "base"),
      candidateSha: required(values, "sha"),
      candidateTree: required(values, "candidate-tree"),
      message: required(values, "message"),
      proof: json<ProofPayload>(required(values, "proof"), "proof"),
      staging: json<StagingPayload>(required(values, "staging"), "staging"),
      authorAcceptance: required(values, "acceptance"),
      ...(postIntegrationCommands === undefined ? {} : { postIntegrationCommands }),
      ...optional(values, "ownership-id", "ownershipId"),
    }),
  );
}

async function commandPromote(args: string[]): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    "candidate-tree": { type: "string" },
    target: { type: "string" },
    identity: { type: "string" },
    authorization: { type: "string" },
    integration: { type: "string" },
    proof: { type: "string" },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const repoRoot = await resolveGitRoot(cwd);
  const configRoot = await resolveConfigRoot(repoRoot);
  const config = await resolveConfigForRoot(configRoot);
  const target = required(values, "target");
  if (target !== "staging" && target !== "production") {
    throw new PoiesisError("INVALID_DELIVERY_TARGET", "Promotion target must be staging or production", { target });
  }
  const identity = json<DeliveryIdentity>(required(values, "identity"), "identity");
  const sha = required(values, "sha");
  const candidateTree = required(values, "candidate-tree");
  if (target === "staging") {
    writeSuccess("promote", await promoteDelivery(config.delivery.staging, {
      sha,
      target,
      candidateTree,
      identity,
    }, repoRoot));
    return;
  }
  writeSuccess("promote", await promoteDelivery(config.delivery.production, {
    sha,
    target,
    candidateTree,
    identity,
    productionAuthorization: json<ProductionAuthorization>(required(values, "authorization"), "authorization"),
    integrationRemote: config.repository.remote,
    integrationBranch: config.repository.integrationBranch,
    proof: json<ProofPayload>(required(values, "proof"), "proof"),
    integration: json<IntegrationEvidence>(required(values, "integration"), "integration"),
  }, repoRoot));
}

async function commandTracker(args: string[]): Promise<void> {
  const kind = args[0];
  const action = args[1];
  if ((kind !== "spec" && kind !== "ticket") || action === undefined) {
    throw new PoiesisError("UNKNOWN_COMMAND", "Expected tracker <spec|ticket> <action>");
  }
  const values = options(args.slice(2), {
    id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    parent: { type: "string" },
    dependencies: { type: "string" },
    reason: { type: "string" },
    replacement: { type: "string", multiple: true },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const repoRoot = await resolveGitRoot(cwd);
  const configRoot = await resolveConfigRoot(repoRoot);
  const config = await resolveConfigForRoot(configRoot);
  const adapter = createTrackerAdapter(config.tracker, repoRoot);
  const id = () => required(values, "id");
  let result: unknown;
  if (kind === "spec") {
    switch (action) {
      case "create": result = await adapter.createSpec({ title: required(values, "title"), body: required(values, "body") }); break;
      case "get": result = await adapter.getSpec(id()); break;
      case "update": result = await adapter.updateSpec(id(), updateInput(values)); break;
      case "comment": result = await adapter.commentSpec(id(), required(values, "body")); break;
      case "close": result = await adapter.closeSpec(id()); break;
      case "supersede": result = await adapter.supersedeSpec(id(), supersedeInput(values)); break;
      default: throw new PoiesisError("UNKNOWN_COMMAND", `Unknown tracker Spec action: ${action}`);
    }
  } else {
    switch (action) {
      case "create": result = await adapter.createTicket({
        title: required(values, "title"),
        body: required(values, "body"),
        parentSpecId: required(values, "parent"),
        dependencyText: required(values, "dependencies"),
      }); break;
      case "get": result = await adapter.getTicket(id()); break;
      case "update": result = await adapter.updateTicket(id(), {
        ...updateInput(values),
        ...optional(values, "dependencies", "dependencyText"),
      }); break;
      case "comment": result = await adapter.commentTicket(id(), required(values, "body")); break;
      case "close": result = await adapter.closeTicket(id()); break;
      case "supersede": result = await adapter.supersedeTicket(id(), supersedeInput(values)); break;
      default: throw new PoiesisError("UNKNOWN_COMMAND", `Unknown tracker Ticket action: ${action}`);
    }
  }
  writeSuccess(`tracker.${kind}.${action}`, result);
}

async function commandSession(args: string[]): Promise<void> {
  if (args[0] !== "cleanup") throw new PoiesisError("UNKNOWN_COMMAND", "Expected session cleanup");
  const values = options(args.slice(1), {
    id: { type: "string" },
    server: { type: "string" },
    directory: { type: "string" },
    strict: { type: "boolean" },
    cwd: { type: "string" },
  });
  writeSuccess(
    "session.cleanup",
    await cleanupOpenCodeSession(required(values, "id"), {
      ...optional(values, "server", "baseUrl"),
      ...optional(values, "directory", "directory"),
      strict: boolean(values, "strict"),
    }),
  );
}

function options(
  args: string[],
  definitions: Record<string, { type: "string" | "boolean"; multiple?: boolean }>,
): Values {
  const parsed = parseArgs({ args, options: definitions, strict: true, allowPositionals: false });
  return parsed.values as Values;
}

function cwdOf(values: Values): string {
  const value = values.cwd;
  return resolve(typeof value === "string" ? value : process.cwd());
}

function required(values: Values, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PoiesisError("MISSING_ARGUMENT", `Missing required --${key}`, { key });
  }
  return value;
}

function many(values: Values, key: string): string[] | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [String(value)];
}

function requiredMany(values: Values, key: string): string[] {
  const value = many(values, key);
  if (value === undefined || value.length === 0) throw new PoiesisError("MISSING_ARGUMENT", `Missing required --${key}`);
  return value;
}

function boolean(values: Values, key: string): boolean {
  return values[key] === true;
}

function optional(values: Values, key: string, output: string): Record<string, string> {
  const value = values[key];
  return typeof value === "string" ? { [output]: value } : {};
}

function json<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new PoiesisError("INVALID_JSON_ARGUMENT", `--${label} must be valid JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function updateInput(values: Values): { title?: string; body?: string } {
  return {
    ...optional(values, "title", "title"),
    ...optional(values, "body", "body"),
  };
}

function supersedeInput(values: Values): SupersedeInput {
  return { reason: required(values, "reason"), replacementIds: many(values, "replacement") ?? [] };
}

// Run `main` only when this module is the Node entry point. Tests import this
// module for `commandUpdate` without intending to invoke `main`; without this
// guard the CLI's bootstrap runs as soon as Vitest loads the module and emits
// HELP/error JSON into the test output.
//
// The check is symlink-aware so the packaged bin resolves to "main" both when
// invoked directly (`node dist/cli.js ...`) and through `node_modules/.bin/`
// (which is a symlink to `dist/cli.js`). A naive `argv[1] === import.meta.url`
// comparison fails through `.bin` because `argv[1]` is the symlink path while
// `import.meta.url` is the real file path, so `main` never runs and the bin
// silently exits 0. We compare realpath-normalized paths so both invocation
// forms boot `main`; importing `src/cli.ts` from a test (where `argv[1]` is
// the vitest bin, not `cli.ts`) still yields "not main".
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

function resolveEntryPath(argv1: string | undefined): string {
  if (!argv1) return "";
  try {
    return resolvePath(argv1);
  } catch {
    return "";
  }
}

function sameEntry(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function isMainEntry(argv1: string | undefined, moduleUrl: string): boolean {
  try {
    return sameEntry(resolveEntryPath(argv1), fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

const IS_MAIN_MODULE = isMainEntry(process.argv[1], import.meta.url);
if (IS_MAIN_MODULE) {
  main(process.argv.slice(2)).catch(writeFailure);
}

function optionalAbsoluteWorkspacePath(value: string | boolean | string[] | undefined): Record<string, string> {
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (trimmed.length === 0) return {};
  return { workspacePath: resolve(trimmed) };
}

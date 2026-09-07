#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readUtf8 } from "./fs.js";
import { parseJsonc, validateConfig, loadConfig, type PoiesisConfig } from "./config.js";
import { writeFailure, writeSuccess } from "./output.js";
import { packageRoot, resolveGitRoot } from "./paths.js";
import { init, doctor, update, uninstall } from "./maintenance.js";
import { installCapability } from "./skills.js";
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
import type { IntegrationEvidence, ProofEvidence, StagingEvidence } from "./evidence.js";
import type { ProofPayload, StagingPayload } from "./adapters.js";

type Values = Record<string, string | boolean | string[] | undefined>;

const HELP = `Poiesis deterministic runtime

Usage:
  poiesis init --config <file> [--allow-fixtures]
  poiesis doctor
  poiesis update
  poiesis uninstall
  poiesis inspect
  poiesis capability install --source <owner/repo> --name <skill> --revision <sha>
  poiesis workspace prepare --branch <name> --path <absolute> --spec <id>
  poiesis workspace cleanup [--ownership-id <id>] [--expected-head <sha>] [--delivered <sha>]
  poiesis checkpoint --path <path>... --message <text> --reviewer <id> --evidence <text>
  poiesis verify --sha <sha>
  poiesis publish --sha <sha> --proof <json> --title <text> --body <text>
  poiesis preview --sha <sha> --proof <json>
  poiesis integrate --sha <sha> --base <sha> --proof <json> --staging <json> --acceptance <text> --message <text>
  poiesis promote --sha <sha> --target <staging|production> --identity <json> [--authorization <text>]
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

async function commandUpdate(args: string[]): Promise<void> {
  const values = options(args, { "skip-skills": { type: "boolean" }, cwd: { type: "string" } });
  const root = await resolveGitRoot(cwdOf(values));
  writeSuccess("update", await update(root, { skipSkills: boolean(values, "skip-skills") }));
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
    await installCapability(root, {
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
    const config = await loadConfig(root);
    writeSuccess(
      "workspace.prepare",
      await workspacePrepare({
        cwd: root,
        remote: config.repository.remote,
        integrationBranch: config.repository.integrationBranch,
        branch: required(values, "branch"),
        workspacePath: resolve(required(values, "path")),
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
  const root = await resolveGitRoot(cwdOf(values));
  const config = await loadConfig(root);
  const commands = config.verification?.commands;
  if (commands === undefined) throw new PoiesisError("NO_VERIFICATION_COMMANDS", "No verification commands were supplied or configured");
  writeSuccess("verify", await verify({ cwd: root, candidateSha: required(values, "sha"), commands }));
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
  const root = await resolveGitRoot(cwdOf(values));
  const config = await loadConfig(root);
  writeSuccess(
    "publish",
    await publish({
      cwd: root,
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
    cwd: { type: "string" },
  });
  const root = await resolveGitRoot(cwdOf(values));
  const config = await loadConfig(root);
  writeSuccess(
    "preview",
    await previewDelivery(
      config.delivery.preview,
      {
        sha: required(values, "sha"),
        candidateTree: required(values, "candidate-tree"),
        proof: json<ProofPayload>(required(values, "proof"), "proof"),
      },
      root,
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
  const root = await resolveGitRoot(cwdOf(values));
  const config = await loadConfig(root);
  const postIntegrationCommands = config.verification?.postIntegrationCommands ?? config.verification?.commands;
  writeSuccess(
    "integrate",
    await integrate({
      cwd: root,
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
    staging: { type: "string" },
    integration: { type: "string" },
    proof: { type: "string" },
    cwd: { type: "string" },
  });
  const root = await resolveGitRoot(cwdOf(values));
  const config = await loadConfig(root);
  const target = required(values, "target");
  if (target !== "staging" && target !== "production") {
    throw new PoiesisError("INVALID_DELIVERY_TARGET", "Promotion target must be staging or production", { target });
  }
  const identity = json<DeliveryIdentity>(required(values, "identity"), "identity");
  const sha = required(values, "sha");
  const candidateTree = required(values, "candidate-tree");
  const input = target === "staging"
    ? {
        sha,
        target,
        candidateTree,
        identity,
        staging: json<StagingPayload>(required(values, "staging"), "staging"),
      } as const
    : {
        sha,
        target,
        candidateTree,
        identity,
        productionAuthorization: required(values, "authorization"),
        proof: json<ProofPayload>(required(values, "proof"), "proof"),
        staging: json<StagingPayload>(required(values, "staging"), "staging"),
        integration: json<IntegrationEvidence>(required(values, "integration"), "integration"),
      } as const;
  writeSuccess("promote", await promoteDelivery(config.delivery[target], input, root));
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
  const root = await resolveGitRoot(cwdOf(values));
  const config = await loadConfig(root);
  const adapter = createTrackerAdapter(config.tracker, root);
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

main(process.argv.slice(2)).catch(writeFailure);

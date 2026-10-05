#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readUtf8 } from "./fs.js";
import { parseJsonc, requireConfiguredDelivery, validateConfig, loadConfig, type PoiesisConfig, type ResolvedPoiesisConfig } from "./config.js";
import { writeFailure, writeSuccess } from "./output.js";
import { packageRoot, resolveGitRoot } from "./paths.js";
import { assertRuntimeVersionMatchesProject, init, doctor, update, uninstall, resolveConfigForRoot, resolveConfigRoot, resolveInstallationRoot, resolvePublishCoordinates, installAuthorizedCapability, updateFromConfig, setModel, type ModelClassName } from "./maintenance.js";
import { assertDeliveryPolicyAllows, DEFERRED_BLOCKED_OPERATIONS, type DeferredBlockedOperation } from "./lifecycle-policy.js";
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
  poiesis bootstrap --print                            # print the one paste-able prompt that installs Poiesis into a project
  poiesis init                                          # default: interactive TTY discovery; --config <file> only required for non-interactive / CI use
  poiesis init --config <file> [--allow-fixtures]
  poiesis doctor
  poiesis update [--bootstrap-legacy-ownership]
  poiesis update --config <file>
  poiesis uninstall
  poiesis inspect
  poiesis capability install --source <owner/repo> --name <skill> --revision <sha>
  poiesis model                                         # default: interactive TTY; pick exactly one slot (reasoning or execution) from the live OpenCode inventory through the shared selector and write through the authenticated \`update --config\` transaction. Restart OpenCode after success; Poiesis does not restart it.
  poiesis model set reasoning|execution <provider/model> # deterministic single-class set; goes through the authenticated \`update --config\` transaction. Restart OpenCode after success; Poiesis does not restart it.
  poiesis workspace prepare --branch <name> --spec <id> # default: Omit \`--path\`; the CLI selects a deterministic in-project workspace under <root>/.poiesis/workspaces/<derived-id>. Never an external path such as \`/tmp/...\`
  poiesis workspace prepare --branch <name> --path <absolute> --spec <id> # exceptional only: when the Author explicitly supplied an exceptional path or compatibility recovery requires the exact pre-existing path
  poiesis workspace cleanup [--ownership-id <id>] [--expected-head <sha>] [--delivered <sha>]
  poiesis checkpoint --path <path>... --message <text> --reviewer <id> --evidence <text>
  poiesis verify --sha <sha>
  poiesis publish --sha <sha> --candidate-tree <tree> --proof <json> --title <text> --body <text>   # Publish only after Verify, Spec Review, and Standards Review pass; \`--proof\` is the canonical identity-bound proof (candidateSha, candidateTree, verified: true, specReview { verdict: PASS, reviewerIdentity }, standardsReview { verdict: PASS, reviewerIdentity }) for the same clean candidate.
  poiesis preview --sha <sha> --candidate-tree <tree> --proof <json> --publish <json>   # Preview only after Publish succeeds. \`--publish\` is the same canonical candidate-bound Publish evidence (candidateSha, candidateTree, verified: true, branch, remoteRef, publishedHeadSha, provider, action, changeRequest) that drove the successful Publish. Poiesis must not claim that a Preview exists or ask for Author validation until the deterministic \`poiesis preview\` operation succeeds and returns a concrete Preview identity (\`id\`, \`url\`, and/or \`artifact\`).
  poiesis integrate --sha <sha> --base <sha> --candidate-tree <tree> --proof <json> --staging <json> --acceptance <text> --message <text>
  poiesis promote --sha <sha> --candidate-tree <tree> --target staging --identity <preview-json>
  poiesis promote --sha <sha> --candidate-tree <tree> --target production --identity <staging-json> --authorization <json> --proof <json> --integration <json>
  poiesis tracker <spec|ticket> <create|get|update|comment|close|supersede> [options]
  poiesis session cleanup --id <session-id> [--server <url>] [--directory <path>]
  poiesis repository status                              # Spec #120 / ticket #121 — mechanical uv / cache state; never downloads, never asks the Author
  poiesis repository query --question <text>              # Spec #120 / ticket #122 — refresh code-only graph if needed, then run graphify query; never queries an old graph after a failed refresh
  poiesis repository path --from <node> --to <node>       # Spec #120 / ticket #123 — refresh code-only graph if needed, then run graphify path; never queries an old graph after a failed refresh
  poiesis repository explain --node <node>                # Spec #120 / ticket #123 — refresh code-only graph if needed, then run graphify explain; never queries an old graph after a failed refresh

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
    case "model":
      return commandModel(rest);
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
    case "bootstrap":
      return commandBootstrap(rest);
    case "session":
      return commandSession(rest);
    case "repository":
      return commandRepository(rest);
    default:
      throw new PoiesisError("UNKNOWN_COMMAND", `Unknown command: ${command}`, { command });
  }
}

export async function commandInit(args: string[]): Promise<void> {
  const values = options(args, {
    config: { type: "string" },
    "allow-fixtures": { type: "boolean" },
    cwd: { type: "string" },
  });
  const cwd = cwdOf(values);
  const root = await resolveGitRoot(cwd);
  const configArg = values.config;
  // --config still drives the structured-JSON install path (no flagless
  // interactive flow; ticket #58 keeps `--config` working exactly as
  // before for CI / non-TTY operators).
  if (typeof configArg === "string" && configArg.trim().length > 0) {
    const configPath = resolve(cwd, configArg);
    const config = validateConfig(parseJsonc(await readUtf8(configPath), configPath), configPath);
    writeSuccess(
      "init",
      await init(root, config, {
        allowFixtureAdapters: boolean(values, "allow-fixtures"),
      }),
    );
    return;
  }
  // Flagless path: the interactive init TTY flow. Every TTY check,
  // prompt, model-selector call, and auth probe is delegated to the
  // dedicated module so this dispatcher stays a thin shell.
  //
  // Ticket #75: the flagless interactive flow is human feedback only.
  // It does NOT emit the structured success envelope on stdout —
  // success lives on stderr (the restart notice is the canonical
  // human feedback). The `--config` path above keeps the structured
  // JSON contract for automation; that is the deterministic surface.
  //
  // Ticket #75 (reviewer follow-up): user-initiated cancellations
  // (Esc / Ctrl+C at the line prompt or at the Clack model selector)
  // are human feedback too, not structured JSON. The interactive
  // module's `finally` has already released stdin by the time we see
  // the error; we emit a concise human-readable line on stderr, set
  // `process.exitCode` to the typed cancellation error's exit code,
  // and return naturally. We do NOT call `process.exit` so the
  // cancellation path matches the operator's normal Ctrl+C semantics
  // — the process simply ends with the captured exit status.
  const { runInteractiveInit, createProductionInteractiveInitIO } = await import("./init-interactive.js");
  // Ticket #78: bind the resolved target root into the production IO
  // factory so the `opencode models` and tracker-auth probes run from
  // the same root the transactional `init()` write path uses. Bare
  // `process.cwd()` would let the interactive flow read a different
  // repo's OpenCode / tracker configuration when the launcher is
  // invoked from a subdirectory of a different repo. Mirrors the
  // `commandModel` wiring for the model interactive flow.
  const io = createProductionInteractiveInitIO(root);
  if (!io.isTTY) {
    throw new PoiesisError(
      "NON_TTY_INIT",
      "poiesis init without --config requires a TTY; pass --config <path> for non-interactive use",
      { hint: "use `poiesis init --config <path>` or run inside a TTY" },
    );
  }
  try {
    await runInteractiveInit({ root, io });
  } catch (error) {
    if (error instanceof PoiesisError && isInteractiveInitCancellation(error.code)) {
      io.writeStderr(formatInteractiveCancellation("init"));
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

/**
 * Spec #138: print the one paste-able prompt that installs Poiesis.
 *
 * The Author asked for something they can hand to any agent and walk away
 * from. This is that artifact, and it lives in the CLI so it can never drift
 * from the install path it describes.
 */
async function commandBootstrap(args: string[]): Promise<void> {
  const values = options(args, { "print": { type: "boolean" }, cwd: { type: "string" } });
  void cwdOf(values);
  const { BOOTSTRAP_PROMPT } = await import("./bootstrap-prompt.js");
  // Human feedback, not a lifecycle envelope: this is text for a human or an
  // agent to read, so it goes to stdout verbatim.
  process.stdout.write(BOOTSTRAP_PROMPT);
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

/**
 * CLI dispatch for `poiesis model ...` (ticket #56 / #59 / #66 / #79).
 *
 * `model set reasoning|execution <provider/model>` is the deterministic
 * single-class set (ticket #56) and is unchanged. Bare `poiesis model`
 * on a TTY now invokes the interactive flow (ticket #59) so the
 * Author can change exactly one slot through the shared selector.
 * Bare `poiesis model` on a non-TTY invocation fails closed with
 * `NON_TTY_MODEL` and a hint pointing at the deterministic subcommand.
 * Unknown subcommands error with `UNKNOWN_COMMAND` and explicitly list
 * the supported set.
 *
 * Ticket #66: `--cwd` is parsed up-front and stripped from the
 * remaining args BEFORE the subcommand check, so
 * `poiesis model --cwd <path>` (with no `set` subcommand) reaches the
 * interactive flow against the supplied repo root instead of being
 * rejected as `UNKNOWN_COMMAND`. The interactive IO factory is given
 * that resolved git root so `loadConfig` and the `opencode models`
 * child process read from the same root `setModel` writes to.
 *
 * Ticket #79: the previous `splitCwdArgs` recognized only the space
 * form (`--cwd <path>`) and silently dropped `--cwd=<path>`, missing
 * values, duplicates, unknown flags, and extra positionals — those
 * forms could mutate the launcher repo or skip validation. The
 * dispatcher now reuses the generic Node `parseArgs` parser in strict
 * mode so the equals form, both ways of giving the cwd value, and
 * malformed extras all fail closed BEFORE any inventory/mutation runs.
 * The structured JSON success envelope, the typed `modelClass` / `modelId`
 * validation in `setModel`, the `updateFromConfig` transaction with its
 * doctor gate and rollback, and the flagless interactive behavior are
 * preserved.
 */
export async function commandModel(args: string[]): Promise<void> {
  const { cwd, positionals } = parseModelArgs(args);
  const root = await resolveGitRoot(resolve(typeof cwd === "string" ? cwd : process.cwd()));

  if (positionals.length === 0) {
    const { runInteractiveModel, createProductionInteractiveModelIO } = await import(
      "./model-interactive.js"
    );
    const io = createProductionInteractiveModelIO(root);
    // The interactive flow refuses non-TTY itself with `NON_TTY_MODEL`
    // (the canonical ticket #59 error code); the dispatch surface stays
    // a thin shell.
    //
    // Ticket #75: the flagless interactive flow is human feedback only.
    // It does NOT emit the structured success envelope on stdout — the
    // model interactive flow already prints the exact previous/current
    // + restart notice to stderr, and that is the canonical human
    // feedback. The deterministic `poiesis model set reasoning|execution
    // <provider/model>` path below keeps the structured JSON contract.
    //
    // Ticket #75 (reviewer follow-up): user-initiated cancellations
    // (Esc / Ctrl+C at the class selector or at the identity selector)
    // are human feedback too, not structured JSON. The interactive
    // module's `finally` has already released stdin by the time we see
    // the error; we emit a concise human-readable line on stderr, set
    // `process.exitCode` to the typed cancellation error's exit code,
    // and return naturally. We do NOT call `process.exit` so the
    // cancellation path matches the operator's normal Ctrl+C semantics
    // — the process simply ends with the captured exit status.
    try {
      await runInteractiveModel({ root, io });
    } catch (error) {
      if (error instanceof PoiesisError && isInteractiveModelCancellation(error.code)) {
        io.writeStderr(formatInteractiveCancellation("model"));
        process.exitCode = error.exitCode;
        return;
      }
      throw error;
    }
    return;
  }
  // The strict parser rejected every unknown flag, missing value,
  // duplicate `--cwd`, and empty `--cwd=` already (each surfacing as
  // a typed `PoiesisError` via `parseModelArgs`). The remaining
  // positionals must now describe exactly the `set <class> <id>`
  // shape — anything else is malformed and must fail closed before
  // `setModel` runs the inventory probe or invokes the transaction.
  const [sub, className, modelId, ...extras] = positionals;
  if (sub !== "set") {
    throw new PoiesisError("UNKNOWN_COMMAND", `Unknown model subcommand: ${sub ?? ""}`, {
      subcommand: sub ?? "",
      supported: ["set"],
    });
  }
  if (typeof className !== "string" || className.length === 0) {
    throw new PoiesisError("MISSING_ARGUMENT", "Missing required model class", { expected: "reasoning|execution", key: "class" });
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new PoiesisError("MISSING_ARGUMENT", "Missing required model ID", { expected: "<provider/model>", key: "id" });
  }
  if (extras.length > 0) {
    throw new PoiesisError("UNKNOWN_ARGUMENT", `Unexpected positional argument: ${extras[0]}`, {
      argument: extras[0],
      expected: "exactly `set <class> <id> [--cwd <path>]`",
    });
  }
  writeSuccess(
    "model.set",
    await setModel(root, className as ModelClassName, modelId),
  );
}

/**
 * Strict argument parser for `poiesis model ...`.
 *
 * Accepts a single optional `--cwd <path>` flag (in either the space
 * or `--cwd=<path>` form) plus an ordered list of positionals that
 * drive the subcommand decision in `commandModel`. Rejects every form
 * that the previous loose parser accepted silently:
 *
 * - missing `--cwd` value (`--cwd` alone, `--cwd=` empty value);
 * - duplicate `--cwd` (parseArgs in the supported Node line is
 *   last-wins, so duplicate detection runs as a separate pre-scan);
 * - unknown flags;
 * - extra positionals beyond the supported subcommand shape.
 *
 * Every malformed form throws a typed `PoiesisError` from the
 * `parseModelArgs` call site, so the dispatcher can translate it into
 * the canonical fail-closed envelope before any inventory/mutation
 * runs.
 */
function parseModelArgs(args: string[]): { cwd: string | undefined; positionals: string[] } {
  // Pre-scan for duplicate `--cwd` occurrences. Node's `parseArgs` in
  // the supported line treats untyped repeats as last-wins, which is
  // not what the ticket #79 contract demands — repeated `--cwd` from
  // a launcher script (shell alias expansion, copy-pasted commands)
  // must fail closed before `commandModel` resolves a git root.
  let cwdOccurrences = 0;
  for (const arg of args) {
    if (arg === "--cwd" || arg.startsWith("--cwd=")) cwdOccurrences++;
  }
  if (cwdOccurrences > 1) {
    throw new PoiesisError("DUPLICATE_ARGUMENT", "Duplicate --cwd flag", { key: "cwd" });
  }

  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({
      args,
      options: { cwd: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }) as typeof parsed;
  } catch (error) {
    throw parseModelArgsError(error);
  }

  const cwd = parsed.values.cwd;
  if (typeof cwd === "string" && cwd.length === 0) {
    // `--cwd=` arrives here as an empty string rather than an error
    // in the supported Node line — surface the same typed
    // `MISSING_ARGUMENT` the missing-value form already emits.
    throw new PoiesisError("MISSING_ARGUMENT", "Missing required --cwd value", { key: "cwd" });
  }

  return {
    cwd: typeof cwd === "string" ? cwd : undefined,
    positionals: parsed.positionals,
  };
}

/**
 * Translate a Node `parseArgs` failure into the canonical Poiesis
 * surface so the dispatcher / interactive flow / tests all see the
 * same `code` + `details` envelope the previous loose parser never
 * produced.
 *
 * Falls back to rethrowing the original error when the failure type
 * is not one the ticket contract enumerates — that preserves any
 * future Node-added parseArgs diagnostics instead of swallowing them.
 */
function parseModelArgsError(error: unknown): unknown {
  if (!(error instanceof TypeError) || !("code" in error)) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    // Node's message format is `Option '--<name> <value>' argument
    // missing`. Pull the flag name so the typed error attributes the
    // failure to the right option.
    const match = /^Option '(--[a-zA-Z][\w-]*)/.exec(error.message);
    const flag = match?.[1] ?? "--unknown";
    const key = flag.replace(/^--/, "");
    return new PoiesisError("MISSING_ARGUMENT", `${flag} requires a value`, { key });
  }
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return new PoiesisError("UNKNOWN_OPTION", error.message, { cause: code });
  }
  return error;
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

/**
 * Ticket #152 — the canonical CLI operation names of the six
 * delivery-integrated operations, taken from the lifecycle policy's own
 * declaration so the CLI can never name an operation the guard does not
 * know. `DEFERRED_BLOCKED_OPERATIONS` stays the single source of truth.
 */
const PREFLIGHT_OPERATIONS = {
  publish: DEFERRED_BLOCKED_OPERATIONS[0],
  preview: DEFERRED_BLOCKED_OPERATIONS[1],
  staging: DEFERRED_BLOCKED_OPERATIONS[2],
  production: DEFERRED_BLOCKED_OPERATIONS[3],
  integrate: DEFERRED_BLOCKED_OPERATIONS[4],
} as const;

/**
 * Ticket #152 — the ONE CLI preflight every delivery-integrated command runs.
 *
 * The four command wrappers used to read the installed config FIRST, so a
 * project Poiesis had not installed failed with an opaque file-read error
 * instead of the typed installed-state failure, and a deferred install was
 * refused by each wrapper's own argument-time delivery check rather than by
 * the central policy. Both are now decided here, before any config load, any
 * publishing-coordinate resolution, and any remote or subprocess work:
 *
 *   1. `resolveGitRoot` / `resolveInstallationRoot` locate the two roots. The
 *      OPERATOR root is the Git root of `--cwd` (what the operation acts on,
 *      including a linked worktree); the CONFIG root is the root that owns the
 *      installation, resolved STRUCTURALLY from the Git directory layout. A
 *      linked worktree therefore reports the PRIMARY checkout — where the
 *      manifest and the installed config actually live — instead of falling
 *      back to the invocation root when the installed config is missing, so
 *      the decision can never report a false missing config (or a false
 *      uninstalled project) for a workspace invocation.
 *   2. The runtime identity guard runs FIRST, so an uninstalled project (no
 *      manifest) and a version-mismatched project keep their existing
 *      `RUNTIME_VERSION_MISMATCH` failure ahead of every other refusal.
 *   3. The central lifecycle-policy guard then decides the installed state
 *      and the delivery policy, in that order, from the installed config
 *      alone. This is the SAME seam the operation itself calls, so the CLI
 *      and the library report the same code, the same `details.operation`,
 *      and the same remediation. The wrappers keep no delivery logic of
 *      their own: `requireConfiguredDelivery` is retained below only to
 *      narrow the parsed union to a configured target.
 *
 * The operation's own guards still run afterwards (they are what protect
 * library callers), and both are side-effect free reads, so the duplicate
 * check costs one manifest read and one config read and changes no outcome.
 */
async function preflightDeliveryOperation(
  cwd: string,
  operation: DeferredBlockedOperation,
): Promise<{ repoRoot: string; configRoot: string }> {
  const repoRoot = await resolveGitRoot(cwd);
  const configRoot = await resolveInstallationRoot(repoRoot);
  await assertRuntimeVersionMatchesProject(configRoot);
  await assertDeliveryPolicyAllows(configRoot, operation);
  return { repoRoot, configRoot };
}

/**
 * Spec #139 / ticket #152 — the four delivery-integrated command wrappers.
 * Exported as a library seam (matching the `commandInit` / `commandUpdate` /
 * `commandModel` / `commandTracker` pattern) so the shared preflight's
 * operator-visible failure can be tested directly, without packing a
 * tarball to reach it. They are intentionally NOT re-exported by
 * `src/index.ts`; the public surface is the `poiesis` bin.
 */
export async function commandPublish(args: string[]): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    "candidate-tree": { type: "string" },
    proof: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    "ownership-id": { type: "string" },
    cwd: { type: "string" },
  });
  // Spec #139 / ticket #152: the shared preflight decides runtime identity and
  // then the central delivery policy, before the installed config is read and
  // before publishing coordinates are resolved.
  const { repoRoot, configRoot } = await preflightDeliveryOperation(cwdOf(values), PREFLIGHT_OPERATIONS.publish);
  const config = await resolveConfigForRoot(configRoot);
  // Spec #139 / ticket #140: publishing coordinates come from the
  // configured Git remote, never from tracker identity. A Linear or
  // clone-local tracker still publishes to the repository its remote
  // points at, and an unresolvable remote fails closed before any push.
  const coordinates = await resolvePublishCoordinates(repoRoot, config);
  writeSuccess(
    "publish",
    await publish({
      cwd: repoRoot,
      remote: config.repository.remote,
      integrationBranch: config.repository.integrationBranch,
      candidateSha: required(values, "sha"),
      candidateTree: required(values, "candidate-tree"),
      provider: coordinates.provider,
      project: coordinates.project,
      title: required(values, "title"),
      body: required(values, "body"),
      proof: json<ProofPayload>(required(values, "proof"), "proof"),
      ...optional(values, "ownership-id", "ownershipId"),
    }),
  );
}

export async function commandPreview(args: string[]): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    "candidate-tree": { type: "string" },
    proof: { type: "string" },
    publish: { type: "string" },
    cwd: { type: "string" },
  });
  // Spec #139 / ticket #152: the shared preflight decides runtime identity and
  // then the central delivery policy, before the installed config is read and
  // before any delivery adapter could be constructed.
  const { repoRoot, configRoot } = await preflightDeliveryOperation(cwdOf(values), PREFLIGHT_OPERATIONS.preview);
  const config = await resolveConfigForRoot(configRoot);
  writeSuccess(
    "preview",
    await previewDelivery(
      // Narrowing only: the preflight has already established that delivery
      // is not deferred, so this cannot be the failure an Author sees.
      requireConfiguredDelivery(config.delivery, PREFLIGHT_OPERATIONS.preview).preview,
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

export async function commandIntegrate(args: string[]): Promise<void> {
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
  // Spec #139 / ticket #152: the shared preflight, before the installed config
  // is read and before the integration is attempted.
  const { repoRoot, configRoot } = await preflightDeliveryOperation(cwdOf(values), PREFLIGHT_OPERATIONS.integrate);
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

export async function commandPromote(args: string[]): Promise<void> {
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
  const target = required(values, "target");
  if (target !== "staging" && target !== "production") {
    throw new PoiesisError("INVALID_DELIVERY_TARGET", "Promotion target must be staging or production", { target });
  }
  // Spec #139 / ticket #152: the shared preflight, naming the exact promotion
  // target, before the installed config is read and before any delivery
  // adapter could be constructed.
  const { repoRoot, configRoot } = await preflightDeliveryOperation(
    cwdOf(values),
    target === "staging" ? PREFLIGHT_OPERATIONS.staging : PREFLIGHT_OPERATIONS.production,
  );
  const config = await resolveConfigForRoot(configRoot);
  const identity = json<DeliveryIdentity>(required(values, "identity"), "identity");
  const sha = required(values, "sha");
  const candidateTree = required(values, "candidate-tree");
  // Narrowing only: the preflight has already established that delivery is not
  // deferred for this exact target, so this cannot be the failure an Author
  // sees.
  const delivery = requireConfiguredDelivery(config.delivery, PREFLIGHT_OPERATIONS[target]);
  if (target === "staging") {
    writeSuccess("promote", await promoteDelivery(delivery.staging, {
      sha,
      target,
      candidateTree,
      identity,
    }, repoRoot));
    return;
  }
  writeSuccess("promote", await promoteDelivery(delivery.production, {
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

/**
 * Spec #104 / ticket #110: tracker dispatcher. Exported as a library
 * seam (matching the `commandInit` / `commandUpdate` / `commandModel`
 * pattern) so the runtime-identity-boundary behavior can be tested
 * directly. It is intentionally NOT re-exported by `src/index.ts`.
 */
export async function commandTracker(args: string[]): Promise<void> {
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
  // Spec #104 / ticket #110: pre-mutation runtime identity guard. The
  // shared guard runs ONLY for tracker mutation actions (create |
  // update | comment | close | supersede); the read-only `get` action
  // stays usable across a runtime/manifest mismatch so an operator can
  // diagnose the mismatch itself. Each mutation branch runs the guard
  // immediately before the adapter mutation so the guard fails closed
  // before any remote call.
  const isMutation = action === "create" || action === "update" || action === "comment" || action === "close" || action === "supersede";
  if (isMutation) {
    await (await import("./maintenance.js")).assertRuntimeVersionMatchesProject(configRoot);
  }
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

/**
 * Spec #120 / ticket #121 + ticket #122 + ticket #123 — `poiesis
 * repository <status|query|path|explain>`.
 *
 * `status` (ticket #121) reports the mechanical Repository
 * Intelligence state without downloading anything: `uv` availability,
 * cache presence, cache validity, and the engine-stamp reason code.
 * The status command MUST NOT spawn a network-bound subprocess; it is
 * intentionally read-only so agents and operators can probe the
 * integration health without altering the cache.
 *
 * `query --question <text>` (ticket #122) is the end-to-end runtime
 * seam: it serializes a single refresh per repo, builds the active
 * graph either as an initial code-only extract or as a valid
 * incremental update, and only then runs `graphify query` against the
 * explicit active `graph.json`. A failed refresh NEVER queries the old
 * active graph; instead it returns a typed fallback envelope. The
 * runner is injected through the second parameter so the test seam
 * can drive deterministic mocked behavior without spawning a real
 * `uvx`.
 *
 * `path --from <node> --to <node>` and `explain --node <node>`
 * (ticket #123) reuse the exact same refresh + lock + cache-validation
 * pipeline as `query`; only the post-refresh graphify invocation
 * differs. Poiesis named flags (`--from`, `--to`, `--node`) translate
 * to Graphify's positional args (`path <from> <to>`, `explain <node>`)
 * plus the explicit `--graph <active>` pointer so the runtime owns
 * every CLI argv shape.
 *
 * Exported as a library seam (matching the `commandInit` /
 * `commandUpdate` / `commandModel` / `commandTracker` pattern) so the
 * structured-JSON contract can be tested directly.
 */
export async function commandRepository(
  args: string[],
  dispatcherOptions: { runner?: import("./repository-intelligence.js").GraphifyRunner } = {},
): Promise<void> {
  const operation = args[0];
  if (operation === "status") {
    const values = options(args.slice(1), { cwd: { type: "string" } });
    const cwd = cwdOf(values);
    const repoRoot = await resolveGitRoot(cwd);
    const { repositoryIntelligenceStatus } = await import("./repository-intelligence.js");
    writeSuccess("repository.status", await repositoryIntelligenceStatus(repoRoot));
    return;
  }
  if (operation === "query") {
    const values = options(args.slice(1), {
      question: { type: "string" },
      cwd: { type: "string" },
    });
    const cwd = cwdOf(values);
    const repoRoot = await resolveGitRoot(cwd);
    const { queryRepositoryIntelligence } = await import("./repository-intelligence.js");
    const question = values.question;
    if (typeof question !== "string" || question.trim().length === 0) {
      throw new PoiesisError("MISSING_ARGUMENT", "Missing required --question", { key: "question" });
    }
    const outcome = await queryRepositoryIntelligence(repoRoot, {
      question,
      ...(dispatcherOptions.runner === undefined ? {} : { runner: dispatcherOptions.runner }),
    });
    if (outcome.ok) {
      writeSuccess("repository.query", outcome);
    } else {
      // Operational failure: typed non-blocking fallback. The CLI
      // surfaces the envelope as a structured-JSON error so the
      // operator sees the same `code` / `details` shape they would
      // get from a hard failure, but with the explicit `reason` field
      // making the failure category machine-readable.
      throw new PoiesisError(
        outcome.reason.toUpperCase().replace(/-/g, "_"),
        outcome.message,
        outcome.detail,
      );
    }
    return;
  }
  if (operation === "path") {
    const values = options(args.slice(1), {
      from: { type: "string" },
      to: { type: "string" },
      cwd: { type: "string" },
    });
    const cwd = cwdOf(values);
    const repoRoot = await resolveGitRoot(cwd);
    const { pathRepositoryIntelligence } = await import("./repository-intelligence.js");
    const fromValue = values.from;
    const toValue = values.to;
    if (typeof fromValue !== "string" || fromValue.trim().length === 0) {
      throw new PoiesisError("MISSING_ARGUMENT", "Missing required --from", { key: "from" });
    }
    if (typeof toValue !== "string" || toValue.trim().length === 0) {
      throw new PoiesisError("MISSING_ARGUMENT", "Missing required --to", { key: "to" });
    }
    const outcome = await pathRepositoryIntelligence(repoRoot, {
      from: fromValue,
      to: toValue,
      ...(dispatcherOptions.runner === undefined ? {} : { runner: dispatcherOptions.runner }),
    });
    if (outcome.ok) {
      writeSuccess("repository.path", outcome);
    } else {
      throw new PoiesisError(
        outcome.reason.toUpperCase().replace(/-/g, "_"),
        outcome.message,
        outcome.detail,
      );
    }
    return;
  }
  if (operation === "explain") {
    const values = options(args.slice(1), {
      node: { type: "string" },
      cwd: { type: "string" },
    });
    const cwd = cwdOf(values);
    const repoRoot = await resolveGitRoot(cwd);
    const { explainRepositoryIntelligence } = await import("./repository-intelligence.js");
    const nodeValue = values.node;
    if (typeof nodeValue !== "string" || nodeValue.trim().length === 0) {
      throw new PoiesisError("MISSING_ARGUMENT", "Missing required --node", { key: "node" });
    }
    const outcome = await explainRepositoryIntelligence(repoRoot, {
      node: nodeValue,
      ...(dispatcherOptions.runner === undefined ? {} : { runner: dispatcherOptions.runner }),
    });
    if (outcome.ok) {
      writeSuccess("repository.explain", outcome);
    } else {
      throw new PoiesisError(
        outcome.reason.toUpperCase().replace(/-/g, "_"),
        outcome.message,
        outcome.detail,
      );
    }
    return;
  }
  throw new PoiesisError("UNKNOWN_COMMAND", `Unknown repository subcommand: ${operation ?? ""}`, {
    subcommand: operation ?? "",
    supported: ["status", "query", "path", "explain"],
  });
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

/**
 * Narrow predicate: the typed error codes the interactive `poiesis init`
 * flagless flow throws when the operator cancels the prompt or the
 * shared model selector. The list is exhaustive for the flagless
 * happy-path module surface; `NON_TTY_INIT` and pre-write refusals
 * like `INSTALL_PATH_CONFLICT` are deliberately excluded so they
 * continue to surface through `writeFailure` and `process.exit`.
 */
function isInteractiveInitCancellation(code: string): boolean {
  return code === "INIT_PROMPT_CANCELLED" || code === "INIT_MODEL_SELECTOR_CANCELLED";
}

/**
 * Narrow predicate: the typed error codes the interactive `poiesis model`
 * flagless flow throws when the operator cancels the class selector or
 * the identity selector. `NON_TTY_MODEL`, `MODEL_NOT_INSTALLED`, and
 * `MODEL_INVENTORY_UNAVAILABLE` are deliberately excluded so they
 * continue to surface through `writeFailure` and `process.exit`.
 */
function isInteractiveModelCancellation(code: string): boolean {
  return code === "MODEL_CLASS_SELECTOR_CANCELLED" || code === "MODEL_SELECTOR_CANCELLED";
}

/**
 * Concise human-readable cancellation line for the interactive flows.
 * Mirrors the ticket #75 "human feedback, no structured internal JSON"
 * contract: the cancellation is a single stderr line that confirms the
 * operator's Ctrl+C / Esc and tells them the transaction was a no-op.
 */
function formatInteractiveCancellation(flow: "init" | "model"): string {
  return `Poiesis ${flow} cancelled. No changes were made.\n`;
}

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readUtf8 } from "./fs.js";
import { parseJsonc, validateConfig, loadConfig, type PoiesisConfig, type ResolvedPoiesisConfig } from "./config.js";
import { writeFailure, writeSuccess } from "./output.js";
import { packageRoot, resolveGitRoot } from "./paths.js";
import { init, doctor, update, uninstall, resolveConfigForRoot, resolveConfigRoot, installAuthorizedCapability, updateFromConfig, setModel, type ModelClassName } from "./maintenance.js";
import {
  checkpoint,
  integrate,
  publish,
  resolveLifecycleAuthority,
  verify,
  workspaceCleanup,
  workspacePrepare,
  type LifecycleAuthority,
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
import {
  createStderrCheckProgress,
  executeCheck,
  type CheckResult,
  type CheckRetryReason,
  type FocusedCommandEvidence,
  type FocusedFailureCause,
} from "./focused-check.js";
import { PoiesisError } from "./errors.js";
import type { IntegrationEvidence, ProductionAuthorization, ProofEvidence, PublishEvidence, StagingEvidence } from "./evidence.js";
import type { ProofPayload, StagingPayload } from "./adapters.js";

type Values = Record<string, string | boolean | string[] | undefined>;

const HELP = `Poiesis deterministic runtime

Usage:
  poiesis bootstrap --print                            # print the one paste-able prompt that installs Poiesis into a project
  poiesis init                                          # default: interactive TTY discovery; asks Private/local vs Team/shared first, then the rest of the guided configuration
  poiesis init --config <file> [--allow-fixtures]       # non-interactive: the config MUST state "mode": "private" | "team"
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
  poiesis verify --sha <sha>   # Runs the installation's live verification plan against the exact clean candidate and returns a runtime-owned verification receipt as \`verification\` (receiptId, receiptDigest, runtime, candidateSha, candidateTree, verificationPlanDigest). Forward it in the proof; Poiesis never accepts an asserted \`verified: true\` on its own.
  poiesis check --command <command>... [--timeout <ms>] [--output-limit <bytes>] [--ownership-id <id>] [--progress] [--retry-reason <token>]
                                             # Spec #168 / ticket #172 — NON-AUTHORITATIVE focused checks for ticket work. Runs EXPLICIT commands in a Poiesis-owned (possibly dirty) candidate workspace and returns bounded per-command evidence (command, workspace state fingerprint, exit/signal, duration, timeout state, bounded output, truncation), a deterministic action fingerprint, and a deterministic failure classification (command-failed | timeout | timeout-unknown | likely-load-induced-timeout | infrastructure | dirty-candidate). It never creates a verification receipt or any other proof and never retries; whole-change authority stays with \`poiesis verify\`. A failed check exits non-zero with the full result under \`details.check\`.
  poiesis publish --sha <sha> --candidate-tree <tree> --proof <json> --title <text> --body <text>   # Publish only after Verify, Spec Review, and Standards Review pass; \`--proof\` is the canonical identity-bound proof (candidateSha, candidateTree, verified: true, specReview { verdict: PASS, reviewerIdentity }, standardsReview { verdict: PASS, reviewerIdentity }, verification { ...Verify's receipt reference }) for the same clean candidate. Publish resolves that receipt from runtime storage and revalidates it against the live installation, live plan, and live candidate before pushing anything.
  poiesis preview --sha <sha> --candidate-tree <tree> --proof <json> --publish <json>   # Preview only after Publish succeeds. \`--publish\` is the same canonical candidate-bound Publish evidence (candidateSha, candidateTree, verified: true, branch, remoteRef, publishedHeadSha, provider, action, changeRequest, verification { receiptId, receiptDigest, runtime, candidateSha, candidateTree, verificationPlanDigest }) that drove the successful Publish; Preview resolves the receipt the proof and that evidence name out of runtime storage, revalidates it against the live installation, live plan, and live candidate, requires both to identify the SAME receipt, and revalidates the remote change-branch head. Poiesis must not claim that a Preview exists or ask for Author validation until the deterministic \`poiesis preview\` operation succeeds and returns a concrete Preview identity (\`id\`, \`url\`, and/or \`artifact\`).
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

async function main(argv: string[], signal?: AbortSignal): Promise<void> {
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
      return commandVerify(rest, signal);
    case "check":
      return commandCheck(rest, signal);
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

/**
 * Spec #168 / ticket #176 — the CLI operations that actually consume a
 * cancellation signal.
 *
 * Scoped on purpose. Installing SIGINT/SIGTERM handlers for EVERY subcommand
 * would silently replace Node's default signal behaviour on `doctor`,
 * `inspect`, `init`, `tracker`, and the rest: a Ctrl-C that used to terminate
 * the process immediately would instead start an abort that those operations
 * never read. Only the two operations that run managed commands and therefore
 * settle what they started get handlers at all; every other subcommand keeps
 * the platform default untouched.
 */
const CANCELLABLE_COMMANDS = new Set(["verify", "check"]);

/** The signals an operator actually sends to interrupt a Poiesis invocation. */
const CANCELLABLE_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface CliDispatchOptions {
  /**
   * A caller-supplied cancellation signal.
   *
   * When present it is used verbatim and Poiesis installs NO process-wide
   * signal handlers: the host process belongs to the caller, and taking over
   * SIGINT/SIGTERM on its behalf would be exactly the hijack this seam exists
   * to avoid.
   */
  signal?: AbortSignal;
}

/**
 * Spec #168 / ticket #176 — the public CLI dispatch, with scoped cancellation.
 *
 * One invocation-scoped `AbortController` per dispatch, plus two temporary
 * `SIGINT`/`SIGTERM` handlers, and ONLY for `verify` and `check`. The first
 * signal aborts once — `AbortController.abort()` is idempotent and the handler
 * is guarded besides, so a repeated Ctrl-C cannot start a second cleanup — and
 * the handlers are removed in `finally`, so a later invocation starts from a
 * fresh, un-aborted controller and never accumulates listeners.
 *
 * The controller reaches the managed command paths, so an interrupted command
 * settles its managed processes and reports `COMMAND_CANCELLED` (exit code 130)
 * instead of leaving them behind. A cleanup failure still outranks the
 * cancellation, because "Poiesis could not confirm it stopped what it started"
 * is the more important fact.
 */
export async function dispatchCli(argv: string[], options: CliDispatchOptions = {}): Promise<void> {
  const cancellable = CANCELLABLE_COMMANDS.has(argv[0] ?? "");
  if (options.signal !== undefined) {
    await main(argv, options.signal);
    return;
  }
  if (!cancellable) {
    // No handlers: this operation does not consume cancellation, so the
    // platform default signal behaviour stays exactly as the operator expects.
    await main(argv);
    return;
  }
  const controller = new AbortController();
  let aborted = false;
  const onSignal = (): void => {
    if (aborted) return;
    aborted = true;
    controller.abort();
  };
  for (const signal of CANCELLABLE_SIGNALS) process.on(signal, onSignal);
  try {
    await main(argv, controller.signal);
  } finally {
    for (const signal of CANCELLABLE_SIGNALS) process.off(signal, onSignal);
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
    // Spec #190 / ticket #191 — non-interactive init requires an explicit
    // mode. Reported here, at the flag surface, so an operator sees which
    // file is missing the decision before any repository state is touched.
    if (config.mode === undefined) {
      throw new PoiesisError(
        "INVALID_INSTALL_MODE",
        "Non-interactive `poiesis init` requires an explicit installation mode in the config; add `\"mode\": \"private\"` (or \"team\")",
        { path: configPath, supported: ["private", "team"] },
      );
    }
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

/**
 * Spec #168 / ticket #169 — the shared lifecycle authority for every CLI
 * entry point that a prepared candidate workspace can reach.
 *
 * The authoritative manifest / config / runtime identity always come from the
 * PRIMARY receipt-authenticated installation that owns the workspace, so a
 * prepared candidate's own generated `.poiesis/config.jsonc` — stale by
 * construction, and possibly committed into the candidate tree — can never
 * become lifecycle authority. Wrong ownership, a missing primary receipt, a
 * foreign workspace, and a mismatched runtime identity all fail closed here,
 * before any command runs.
 */
async function lifecycleAuthority(cwd: string): Promise<LifecycleAuthority> {
  return resolveLifecycleAuthority(await resolveGitRoot(cwd));
}

/**
 * Spec #168 / ticket #169: exported as a library seam (same pattern as
 * `commandInit` / `commandUpdate` / `commandModel` / `commandTracker`) so the
 * candidate-authority behaviour of the Verify dispatch can be exercised
 * directly. It is intentionally NOT re-exported by `src/index.ts`.
 */
export async function commandVerify(args: string[], signal?: AbortSignal): Promise<void> {
  const values = options(args, {
    sha: { type: "string" },
    cwd: { type: "string" },
  });
  const authority = await lifecycleAuthority(cwdOf(values));
  const config = await resolveConfigForRoot(authority.primaryRoot);
  const commands = config.verification.commands;
  writeSuccess(
    "verify",
    await verify({
      cwd: authority.candidateRoot,
      candidateSha: required(values, "sha"),
      commands,
      // Spec #168 / ticket #176: the invocation-scoped cancellation from the
      // public dispatch. It settles the managed commands, so an interrupted
      // Verify reports `COMMAND_CANCELLED` and issues no receipt.
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

/**
 * Spec #168 / ticket #172 — `poiesis check`.
 *
 * The focused-scope entry point: EXPLICIT commands, a Poiesis-OWNED (and
 * possibly dirty) candidate workspace, bounded per-command evidence, a
 * deterministic action fingerprint, and a deterministic failure
 * classification. It is deliberately NOT a second verification surface — it
 * cannot produce a receipt or any other proof, and whole-change authority
 * stays exclusively with `poiesis verify`.
 *
 * Lifecycle authority is explicit rather than inherited: the command runs in
 * `authority.candidateRoot` while refusing any workspace Poiesis does not
 * own, and the classification/evidence envelope is emitted by the one
 * executor rather than reassembled here.
 *
 * A failed focused check is a FAILURE, not a result with a sad field: it
 * raises `FOCUSED_CHECK_FAILED` carrying the complete bounded result under
 * `details.check`, so the structured failure envelope the CLI already
 * promises still reaches the caller with the evidence attached.
 *
 * Spec #168 / ticket #177: the two exceptions to that are the containment
 * refusals, which are rethrown with their own code and their own
 * `reason`/`platform`/`detail`/`remediation` intact. A refusal is this host
 * declining to run managed command text at all, so it is neither a pass nor a
 * failing command, and pointing the operator at Verify — which needs the same
 * capability — would only send them somewhere that refuses identically.
 *
 * Spec #168 / ticket #178 adds the third, for the same reason: a host with no
 * usable command processor is refused with `COMMAND_PROCESSOR_UNAVAILABLE`
 * BEFORE any process exists, so it is equally not a failing check, and Verify
 * resolves command text through the very same processor seam.
 *
 * Exported as a library seam (same pattern as `commandVerify`); it is
 * intentionally NOT re-exported by `src/index.ts`.
 */
export async function commandCheck(args: string[], signal?: AbortSignal): Promise<void> {
  const values = options(args, {
    command: { type: "string", multiple: true },
    timeout: { type: "string" },
    "output-limit": { type: "string" },
    "retry-reason": { type: "string" },
    progress: { type: "boolean" },
    "ownership-id": { type: "string" },
    cwd: { type: "string" },
  });
  const authority = await lifecycleAuthority(cwdOf(values));
  const progress = boolean(values, "progress") ? createStderrCheckProgress() : undefined;
  // The executor validates the token against its closed vocabulary and
  // refuses an undeclared one with `INVALID_CHECK_RETRY_REASON`, so the CLI
  // passes the caller's raw string through rather than second-guessing it.
  const retryReason = many(values, "retry-reason")?.[0];
  const result = await executeCheck({
    scope: "focused",
    cwd: authority.candidateRoot,
    commands: requiredMany(values, "command"),
    ...optional(values, "ownership-id", "ownershipId"),
    ...(values.timeout === undefined ? {} : { timeoutMs: boundedInteger(values, "timeout") }),
    ...(values["output-limit"] === undefined ? {} : { outputLimit: boundedInteger(values, "output-limit") }),
    ...(progress === undefined ? {} : { progress }),
    ...(retryReason === undefined ? {} : { retryReason: retryReason as CheckRetryReason }),
    // Spec #168 / ticket #176: the invocation-scoped cancellation from the
    // public dispatch. A caller-supplied signal is never overwritten.
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.outcome !== "passed") {
    // Spec #168 / ticket #176: an interrupted focused check IS a cancellation,
    // not a failed check. Reporting it as `FOCUSED_CHECK_FAILED` would tell the
    // operator their code failed when the truth is that they pressed Ctrl-C, so
    // the typed cancellation identity and exit code 130 are surfaced — with the
    // complete bounded result still attached under `details.check`.
    //
    // A cleanup failure is NOT rewritten as a cancellation: it outranks the
    // abort, and the executor already records its code on the evidence, so the
    // operator is pointed at the real problem.
    const failed = (result.commands ?? []).find((entry) => entry.status === "failed");
    if (failed?.failureCode === "COMMAND_CANCELLED") {
      throw new PoiesisError(
        "COMMAND_CANCELLED",
        "Focused check was cancelled by the caller",
        {
          check: result,
          cancelled: true,
          command: failed.command,
          exitCode: failed.exitCode,
          signal: failed.signal,
          durationMs: failed.durationMs,
          stdout: failed.stdout,
          stderr: failed.stderr,
          stdoutTruncated: failed.stdoutTruncated,
        },
        130,
      );
    }
    // Spec #168 / ticket #177: a containment refusal is not a failed check. It
    // is this host declining to execute managed command text at all, and the
    // operator's next action is a host — not an edit. Collapsing it into
    // `FOCUSED_CHECK_FAILED` would tell them their code failed, and the
    // `migration` line below would send them to `poiesis verify`, which
    // requires the SAME capability and would refuse in exactly the same way.
    if (failed !== undefined && isActionableContainmentRefusal(failed.failureCode)) {
      throw containmentRefusal(failed, result);
    }
    // Spec #168 / ticket #178: a missing command PROCESSOR is the same class of
    // refusal for the same reason. It is raised before a process exists, it is
    // actionable (the operator can fix the host), and `poiesis verify` reaches
    // command text through the very same seam — so the `migration` advice would
    // send the operator to a surface that refuses identically. It keeps its own
    // typed code and its own reason/platform/processor/remediation.
    if (failed !== undefined && failed.failureCode === "COMMAND_PROCESSOR_UNAVAILABLE") {
      throw processorUnavailableRefusal(failed, result);
    }
    throw new PoiesisError("FOCUSED_CHECK_FAILED", "Focused checks did not pass", {
      check: result,
      migration:
        "Focused checks carry no proof. Fix the failure, or escalate to whole-change `poiesis verify`; do not repeat an unchanged command and state fingerprint.",
    });
  }
  writeSuccess("check", result);
}

/**
 * Spec #168 / ticket #177 — the two containment refusals a focused check must
 * pass through with their own identity intact.
 *
 * Both are typed, actionable, and produced by the one module that owns the
 * capability decision, so this surface has nothing new to decide: it only
 * refuses to overwrite them with a generic classification.
 */
function isActionableContainmentRefusal(code: string | null): boolean {
  return code === "PROCESS_CONTAINMENT_UNAVAILABLE" || code === "PROCESS_CONTAINMENT_REFUSED";
}

/**
 * Spec #168 / ticket #177 — rethrow the runner's own containment refusal, with
 * the bounded check evidence attached.
 *
 * The code, the reason, the platform, the detail, and the runtime's own
 * remediation are carried through verbatim, so the operator is told which
 * primitive is missing and what to do about it. Deliberately ABSENT is the
 * `migration` advice attached to a genuine `FOCUSED_CHECK_FAILED`: escalating
 * to `poiesis verify` is not a workaround here, because Verify executes managed
 * command text through the same boundary and would refuse identically.
 */
function containmentRefusal(failed: FocusedCommandEvidence, result: CheckResult): PoiesisError {
  const cause = failed.failureCause;
  const detail = cause?.detail ?? "this runtime could not establish strong process containment for managed command text.";
  return new PoiesisError(
    failed.failureCode ?? "PROCESS_CONTAINMENT_UNAVAILABLE",
    `Focused check did not run: managed command text requires strong process containment, which this runtime cannot provide: ${detail}`,
    {
      check: result,
      // Bounded evidence about the command that never started, so the
      // fingerprint still identifies what was attempted and what state it was
      // attempted against.
      command: failed.command,
      commandIndex: failed.index,
      classification: result.classification,
      exitCode: failed.exitCode,
      durationMs: failed.durationMs,
      stdoutTruncated: failed.stdoutTruncated,
      stderrTruncated: failed.stderrTruncated,
      ...causeDetails(cause),
    },
  );
}

/** Carry the refusal's own bounded strings through, omitting the ones it has none of. */
function causeDetails(cause: FocusedFailureCause | null): Record<string, unknown> {
  if (cause === null) return {};
  return {
    cause: { ...cause },
    ...(cause.containment === null ? {} : { containment: cause.containment }),
    ...(cause.platform === null ? {} : { platform: cause.platform }),
    ...(cause.processor === null ? {} : { processor: cause.processor }),
    ...(cause.reason === null ? {} : { reason: cause.reason }),
    ...(cause.detail === null ? {} : { detail: cause.detail }),
    ...(cause.remediation === null ? {} : { remediation: cause.remediation }),
  };
}

/**
 * Spec #168 / ticket #178 — rethrow the processor seam's own refusal, with the
 * bounded check evidence attached.
 *
 * `COMMAND_PROCESSOR_UNAVAILABLE` is raised BEFORE any process exists, so the
 * focused command never ran and nothing about the operator's code failed. The
 * reason (`PROCESSOR_NOT_EXECUTABLE`, a `ComSpec` that is missing, relative,
 * or not `cmd.exe`), the platform, the processor that was rejected, and the
 * runtime's own remediation are carried through verbatim, so the operator is
 * told exactly what to repair.
 *
 * Deliberately ABSENT is the `migration` advice attached to a genuine
 * `FOCUSED_CHECK_FAILED`. Escalating to `poiesis verify` is not a workaround
 * here: Verify executes managed command text through the same validated
 * processor and would refuse identically, so pointing there would replace an
 * accurate host diagnosis with a dead end.
 */
function processorUnavailableRefusal(failed: FocusedCommandEvidence, result: CheckResult): PoiesisError {
  const cause = failed.failureCause;
  const detail =
    cause?.detail ?? "this runtime could not resolve a usable command processor for the focused command text.";
  return new PoiesisError(
    "COMMAND_PROCESSOR_UNAVAILABLE",
    `Focused check did not run: managed command text requires a usable command processor, which this runtime could not provide: ${detail}`,
    {
      check: result,
      // Bounded evidence about the command that never started, so the
      // fingerprint still identifies what was attempted and what state it was
      // attempted against.
      command: failed.command,
      commandIndex: failed.index,
      classification: result.classification,
      exitCode: failed.exitCode,
      durationMs: failed.durationMs,
      stdoutTruncated: failed.stdoutTruncated,
      stderrTruncated: failed.stderrTruncated,
      ...causeDetails(cause),
    },
  );
}

/**
 * Parse a positive-integer flag. `parseArgs` keeps everything a string so
 * the failure is a typed Poiesis refusal rather than a silent `NaN` that
 * would later surface as a confusing bound violation.
 */
function boundedInteger(values: Values, key: string): number {
  const raw = values[key];
  const parsed = Number(raw);
  if (typeof raw !== "string" || raw.trim().length === 0 || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PoiesisError("INVALID_ARGUMENT", `--${key} must be a positive integer`, { key, value: raw ?? null });
  }
  return parsed;
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
  const authority = await lifecycleAuthority(cwdOf(values));
  const config = await resolveConfigForRoot(authority.primaryRoot);
  writeSuccess(
    "publish",
    await publish({
      cwd: authority.candidateRoot,
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
  const authority = await lifecycleAuthority(cwdOf(values));
  const config = await resolveConfigForRoot(authority.primaryRoot);
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
      // Spec #168 / ticket #186: the CANDIDATE workspace, exactly like the
      // Verify and Publish dispatches above. `previewDelivery` resolves its own
      // authority from this root and still runs delivery against
      // `authority.primaryRoot`, so nothing about the delivery adapter changes;
      // what this preserves is the ownership identity the forwarded verification
      // receipt is bound to. Handing over the primary root instead resolved an
      // authority with no ownership marker, which refused every receipt Verify
      // had legitimately minted for an owned candidate.
      authority.candidateRoot,
    ),
  );
}

/**
 * `poiesis integrate` — exported for the same reason `commandInit`,
 * `commandUpdate`, `commandModel`, `commandVerify`, `commandCheck`, and
 * `commandRepository` are: so the ticket-level tests drive the real CLI
 * argument wiring (which is where the post-integration command list is
 * resolved from config) instead of a hand-rolled approximation of it.
 *
 * Spec #168 / ticket #174: `postIntegrationCommands` is OPT-IN. When the
 * project does not configure it, integration runs nothing — the configured
 * full `verification.commands` plan is NOT substituted as a fallback, because
 * the whole-change proof already ran that plan once, in the owned candidate,
 * before Publish. Re-running it per integration is the redundancy Spec #168
 * removes. In its place integration keeps the EXACT IDENTITY validation it
 * already performs in Git: the squash commit's tree must equal the candidate
 * tree byte-for-byte (`INTEGRATED_TREE_MISMATCH`), the remote integration ref
 * must be exactly the commit Poiesis created (`INTEGRATION_SHA_MISMATCH`), and
 * the tree must still match after the push (`INTEGRATED_TREE_MISMATCH`).
 */
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
  const authority = await lifecycleAuthority(cwdOf(values));
  const config = await resolveConfigForRoot(authority.primaryRoot);
  // Spec #168 / ticket #174: `postIntegrationCommands` is OPT-IN and is the
  // ONLY source. There is deliberately no `?? config.verification.commands`:
  // the whole-change proof already ran that plan once, in the owned candidate,
  // before Publish, and re-running it per integration is the redundancy this
  // Spec removes. An absent value therefore means "run nothing", and the
  // absence is still covered by the exact identity validation `integrate`
  // performs in Git (integrated tree === candidate tree, published ref ===
  // integrated sha, tree still matching after the push).
  const postIntegrationCommands = config.verification.postIntegrationCommands;
  writeSuccess(
    "integrate",
    await integrate({
      cwd: authority.candidateRoot,
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
  const authority = await lifecycleAuthority(cwdOf(values));
  const config = await resolveConfigForRoot(authority.primaryRoot);
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
    }, authority.primaryRoot));
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
  }, authority.primaryRoot));
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
  dispatchCli(process.argv.slice(2)).catch(writeFailure);
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

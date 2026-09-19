/**
 * Flagless interactive `poiesis init` (ticket #58).
 *
 * The composer (`src/init-discovery.ts`) and the shared model selector
 * (`src/model-selector.ts`) already exist; this module orchestrates the
 * TTY-only human happy path:
 *
 *   1. Refuse non-TTY invocations (`NON_TTY_INIT`). Operators in a
 *      non-interactive environment must pass `--config <path>` instead.
 *   2. Refuse when `.poiesis/manifest.json` already exists so the
 *      existing ownership rule (`INSTALL_PATH_CONFLICT`) fires BEFORE
 *      any model selector or prompt is offered.
 *   3. Compose the discovery result via `composeInitDiscovery`. Every
 *      detection that the composer accepted is written to stderr so the
 *      Author can see what was inferred.
 *   4. For each unresolved Author-owned field, prompt via the injected
 *      IO. Models go through the shared `runModelSelector`; ambiguous
 *      remotes and real delivery command argv use the injected
 *      `promptLine` and the canonical `{sha}` token rule.
 *   5. Probe tracker auth via the injected `probeTrackerAuth`. Auth
 *      failures mention `gh auth login` or `glab auth login` and never
 *      wait-for-enter.
 *   6. Call the existing `init(root, config)` (the canonical ownership
 *      transactions are untouched by this ticket).
 *   7. After success, print a restart notice on stderr. Poiesis does NOT
 *      restart OpenCode — that mirrors the explicit `poiesis model set`
 *      rule.
 *
 * Design contract:
 *   - Every I/O operation goes through `InteractiveInitIO` so tests can
 *     drive the flow without a PTY.
 *   - The module never assumes a TTY; it refuses fail-closed before any
 *     IO call when `io.isTTY === false`.
 *   - The module never invents hosting-adapter delivery IDs (Vercel,
 *     Netlify, Cloudflare, GitHub Actions). Delivery questions are real
 *     command argv that contain the literal `{sha}` token, mirroring
 *     `POIESIS_FOUNDATION_v1.1` §46 / `COMPATIBILITY.md` "Delivery".
 *   - Auth probe failures short-circuit BEFORE `init()` runs and include
 *     the exact auth login command in the error message.
 */
import type { PoiesisConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import {
  composeInitDiscovery,
  type InitDiscoveryResult,
  type RemoteDetection,
} from "./init-discovery.js";
import {
  DEFAULT_RECOMMENDED_MODEL_IDS,
  runModelSelector,
  type ModelClass,
  type ModelIdentity,
  type RecommendedModelIds,
} from "./model-selector.js";
import { settleOnceLinePrompt } from "./prompt-line.js";
import { init, parseOpenCodeModelInventory } from "./maintenance.js";
import { loadManifest, type Manifest } from "./manifest.js";
import { run as runChildProcess } from "./process.js";

export type TrackerProvider = "github" | "gitlab";

export interface ModelSelection {
  readonly modelClass: ModelClass;
  readonly inventory: readonly string[];
  readonly recommended: RecommendedModelIds;
  readonly currentIdentity: ModelIdentity | null;
}

export interface TrackerAuthProbeResult {
  readonly available: boolean;
  readonly stderr?: string;
  readonly hint?: string;
}

export interface InteractiveInitIO {
  readonly isTTY: boolean;
  writeStderr(line: string): void;
  promptLine(prompt: string): Promise<string>;
  listOpenCodeModels(): Promise<readonly string[]>;
  runModelSelector(selection: ModelSelection): Promise<string>;
  probeTrackerAuth(provider: TrackerProvider): Promise<TrackerAuthProbeResult>;
  /**
   * Flow-scoped resource release (ticket #75). The interactive flow
   * invokes this exactly once from a `finally` block on every code
   * path (success, typed cancellation, and unexpected throw) so the
   * underlying `process.stdin` cannot keep the event loop alive after
   * the flow settles. Tests supply a counter; the production factory
   * pauses and unrefs `process.stdin`.
   */
  releaseStdin?(): void;
}

export interface InteractiveInitOptions {
  root: string;
  io: InteractiveInitIO;
  /**
   * Optional explicit draft. The composer accepts a draft with `<...>`
   * placeholders (e.g. the canonical `POIESIS_CONFIG_TEMPLATE.jsonc`
   * shape) — the interactive flow replaces any remaining placeholder
   * with the Author's answer.
   */
  draft?: PoiesisConfig;
}

/**
 * Canonical delivery prompt text. The `{sha}` placeholder is the
 * non-negotiable token a real command argv must contain (mirrors the
 * `command` adapter in `src/adapters.ts`); the prompt makes that
 * contract explicit so the Author cannot accidentally paste a hosting
 * adapter ID.
 */
const DELIVERY_TARGET_PROMPTS: ReadonlyArray<{ target: "preview" | "staging" | "production"; label: string }> = [
  { target: "preview", label: "Preview" },
  { target: "staging", label: "Staging" },
  { target: "production", label: "Production" },
];

/**
 * Hosts that must NEVER be auto-invented as delivery adapters. They are
 * valid user choices only when the user explicitly writes them in their
 * draft, which the flagless happy path does not pre-populate. The
 * prompt deliberately asks for argv, not adapter IDs.
 */
const FORBIDDEN_DELIVERY_ADAPTERS: ReadonlySet<string> = new Set([
  "vercel",
  "netlify",
  "cloudflare",
  "gha",
  "github-actions",
  "pages",
]);

/**
 * Run the interactive init flow. Returns the installed Manifest on
 * success; throws `PoiesisError` with a structured code on every
 * documented failure mode.
 *
 * The function never writes to stdout; all human-visible frames are on
 * stderr. Success / failure JSON still flows through the standard
 * `writeSuccess` / `writeFailure` caller, which is the only writer that
 * produces structured stdout.
 */
export async function runInteractiveInit(args: InteractiveInitOptions): Promise<Manifest> {
  try {
    if (!args.io.isTTY) {
      throw new PoiesisError(
        "NON_TTY_INIT",
        "poiesis init without --config requires a TTY; pass --config <path> for non-interactive use",
        { hint: "use `poiesis init --config <path>` or run inside a TTY" },
      );
    }

    // Step 1: refuse an already-installed repo BEFORE any model selector
    // or prompt. This mirrors the existing `assertInitDestinationsAbsent`
    // invariant that `init()` enforces anyway, but we check it up front so
    // we never start asking the Author for choices in a repo that already
    // has Poiesis installed.
    await refuseIfAlreadyInstalled(args.root);

    // Step 2: compose discovery. The composer is read-only — it inspects
    // the repo and the user's draft, then reports either a fully resolved
    // config or a list of unresolved paths.
    const discovery = await composeInitDiscovery(args.root, args.draft);

    // Step 3: print the detected facts to stderr so the Author can see
    // what was inferred before any prompt is issued.
    printDetections(args.io, discovery);

    // Step 4: resolve every Author-owned field. Order matters — model
    // selection runs before tracker auth so the Author sees the same
    // config that the auth probe will read.
    const resolvedDraft = await resolveAuthorChoices(args.io, discovery, args.draft);

    // Step 5: probe tracker auth BEFORE `init()` writes any byte. Auth
    // failures mention `gh auth login` / `glab auth login` and never
    // wait-for-enter.
    await probeTrackerAuthBeforeInstall(args.io, resolvedDraft);

    // Step 6: the existing init() function owns every transactional
    // invariant. This module never duplicates that surface.
    const manifest = await init(args.root, resolvedDraft);

    // Step 7: success. Print a restart notice on stderr; Poiesis does not
    // restart OpenCode on the Author's behalf.
    args.io.writeStderr(formatRestartNotice());
    return manifest;
  } finally {
    // Ticket #75: flow-scoped resource release. The interactive flow
    // pauses and unrefs `process.stdin` on every code path so the Node
    // process can exit naturally after success or cancellation; without
    // this, the readline prompt + Clack selector chain leaves stdin
    // resumed and the event loop waits forever for keypress data.
    // Tests that drive the flow with scripted IO leave `releaseStdin`
    // undefined.
    args.io.releaseStdin?.();
  }
}

async function refuseIfAlreadyInstalled(root: string): Promise<void> {
  try {
    await loadManifest(root);
  } catch (error) {
    if (error instanceof PoiesisError && error.code === "MANIFEST_MISSING") {
      return; // expected for a fresh repo
    }
    // Any other manifest read failure is non-fatal at this stage —
    // `init()` will re-validate and fail closed if the manifest is
    // actually present and unowned.
    return;
  }
  throw new PoiesisError(
    "INSTALL_PATH_CONFLICT",
    "Refusing to run interactive init in a repository that already has a Poiesis install; use `poiesis update` or `poiesis update --config <path>`",
    { path: ".poiesis/manifest.json" },
  );
}

function printDetections(io: InteractiveInitIO, discovery: InitDiscoveryResult): void {
  const lines: string[] = [];
  lines.push("Poiesis init: detected repository facts");
  lines.push("");

  const remote = discovery.detections.remote;
  lines.push(formatRemoteDetection(remote));
  lines.push(
    `  integration branch: ${discovery.detections.integrationBranch.name ?? "(unknown)"}${formatSource(discovery.detections.integrationBranch.source)}`,
  );
  lines.push(
    `  verification: ${discovery.detections.verification.commands.length === 0 ? "(none)" : discovery.detections.verification.commands.join("; ")}${formatSource(discovery.detections.verification.source)}`,
  );
  const tracker = discovery.detections.tracker;
  lines.push(
    `  tracker: ${tracker.provider ?? "(unknown)"}${tracker.project ? ` / ${tracker.project}` : ""}${formatSource(tracker.source)}`,
  );

  for (const { target, label } of DELIVERY_TARGET_PROMPTS) {
    const detection = discovery.detections.delivery[target];
    const text = detection === null
      ? "(not configured)"
      : `${describeDeliveryDetection(detection)}`;
    lines.push(`  ${label} delivery: ${text}`);
  }

  lines.push("");
  const repo = discovery.detections.repo;
  lines.push(
    `  opencode config: ${repo.opencodeConfigPresent ? repo.opencodeConfigPath ?? "present" : "absent"}`,
  );
  lines.push(
    `  poiesis install: ${repo.poiesisInstalled ? `installed (${repo.poiesisManifestVersion ?? "unknown version"})` : "not installed"}`,
  );

  // Surface Author-owned choices so the Author can see exactly which
  // prompts will follow. We always mention "models" / "delivery" by
  // name because those are the two surfaces the ticket makes canonical.
  if (discovery.unresolved.length > 0) {
    lines.push("");
    lines.push("Author-owned choices to resolve:");
    const labels: Record<string, string> = {
      "models.reasoning": "reasoning model (via shared model selector)",
      "models.execution": "execution model (via shared model selector)",
      "repository.remote": "Git remote (multiple candidates)",
      "repository.integrationBranch": "integration branch",
      "verification.commands": "verification command",
      "tracker.provider": "tracker provider",
      "tracker.project": "tracker project",
      "delivery.preview": "how this project creates Preview",
      "delivery.staging": "how this project deploys to Staging",
      "delivery.production": "how this project releases to Production",
    };
    for (const path of discovery.unresolved) {
      lines.push(`  - ${path}: ${labels[path] ?? path}`);
    }
  }
  lines.push("");

  io.writeStderr(lines.join("\n"));
}

function formatRemoteDetection(remote: RemoteDetection): string {
  if (remote.source === "ambiguous" && remote.alternates !== undefined) {
    return `  remote: (ambiguous: ${remote.alternates.join(", ")})`;
  }
  if (remote.name === undefined) {
    return `  remote: (unknown)`;
  }
  return `  remote: ${remote.name}${remote.url ? ` (${remote.url})` : ""}${formatSource(remote.source)}`;
}

function formatSource(source: string): string {
  return ` [${source}]`;
}

function describeDeliveryDetection(detection: NonNullable<InitDiscoveryResult["detections"]["delivery"]["preview"]>): string {
  if (detection.source.kind === "script") {
    return `command via ${detection.source.path}`;
  }
  if (detection.source.kind === "explicit") {
    return "explicit (carried over from draft)";
  }
  return `fixture adapter [${detection.source.kind}]`;
}

async function resolveAuthorChoices(
  io: InteractiveInitIO,
  discovery: InitDiscoveryResult,
  draft: PoiesisConfig | undefined,
): Promise<PoiesisConfig> {
  // If the composer returned a fully resolved config, skip every prompt.
  if (discovery.config !== undefined) {
    return discovery.config;
  }

  // The composer has the detection objects even when it could not
  // return a fully resolved config. Walk the unresolved paths in a
  // stable order.
  //
  // The tracker block is seeded from the composer's discovery result
  // when the remote URL uniquely identifies a supported provider
  // (github.com or gitlab.com). The Author MUST NOT be prompted for a
  // provider that the composer already knows — that would either push
  // the Author toward a default that contradicts the remote (e.g.
  // github for a gitlab.com host) or drop the discovered project.
  // `tracker` is intentionally typed loosely here: when discovery did not
  // fill the provider (unknown remote host), the provider field is omitted.
  // The prompt below requires an explicit `github`|`gitlab` answer before
  // `init()` runs, so the runtime config always carries a valid provider
  // by the time it reaches the validation layer.
  const base: PoiesisConfig = (draft ?? {
    schema: 1,
    models: { reasoning: "", execution: "" },
    tracker: {
      ...(discovery.detections.tracker.provider !== undefined
        ? { provider: discovery.detections.tracker.provider }
        : {}),
      ...(discovery.detections.tracker.project !== undefined
        ? { project: discovery.detections.tracker.project }
        : {}),
    },
    delivery: {
      preview: { adapter: "command", command: ["<delivery-executable>", "preview", "{sha}"] },
      staging: { adapter: "command", command: ["<delivery-executable>", "staging", "{sha}"] },
      production: { adapter: "command", command: ["<delivery-executable>", "production", "{sha}"] },
    },
    verification: { commands: [] },
  }) as PoiesisConfig;

  const next: PoiesisConfig = JSON.parse(JSON.stringify(base)) as PoiesisConfig;

  // Models: select reasoning first, then execution. Both go through the
  // shared model selector; the IO is responsible for failure-closed
  // non-TTY handling at a deeper layer if needed.
  if (discovery.unresolved.includes("models.reasoning")) {
    next.models.reasoning = await selectModel(io, "reasoning");
  }
  if (discovery.unresolved.includes("models.execution")) {
    next.models.execution = await selectModel(io, "execution");
  }

  // Ambiguous remote: list alternates, ask the Author to pick one.
  if (discovery.unresolved.includes("repository.remote")) {
    const alternates = discovery.detections.remote.alternates ?? [];
    next.repository = {
      ...(next.repository ?? {}),
      remote: await pickRemote(io, alternates),
    };
  }

  // Integration branch: ask the Author.
  if (discovery.unresolved.includes("repository.integrationBranch")) {
    next.repository = {
      ...(next.repository ?? {}),
      integrationBranch: await promptWithDefault(
        io,
        "Integration branch",
        "main",
      ),
    };
  }

  // Verification commands: ask the Author when no `package.json` script
  // was discovered.
  if (discovery.unresolved.includes("verification.commands")) {
    const answer = await promptWithDefault(
      io,
      "Verification command",
      "test -f README.md",
    );
    next.verification = { ...(next.verification ?? {}), commands: [answer] };
  }

  // Tracker: provider may be missing when the remote host is unknown.
  // The Author MUST supply an explicit `github` or `gitlab` answer — empty
  // Enter or any other value fails closed. The composer refuses to invent
  // a host, mirroring the discovery layer's no-guess rule.
  if (discovery.unresolved.includes("tracker.provider")) {
    const raw = (await io.promptLine("Tracker provider (github|gitlab)")).trim();
    if (raw !== "github" && raw !== "gitlab") {
      throw new PoiesisError(
        "INVALID_TRACKER_PROVIDER",
        "Unsupported tracker provider; only `github` or `gitlab` are accepted",
        { provider: raw, supported: ["github", "gitlab"] },
      );
    }
    next.tracker = { ...(next.tracker ?? {}), provider: raw };
  }
  if (discovery.unresolved.includes("tracker.project")) {
    const project = await promptWithDefault(io, "Tracker project", "");
    next.tracker = { ...next.tracker, project };
  }

  // Delivery command argv: real command line containing `{sha}`. The
  // composer's delivery detection may have prefilled an explicit
  // adapter (script hint or explicit draft entry) even when the
  // delivery targets themselves are NOT in the unresolved list —
  // for example, the canonical template draft carries `<...>`
  // placeholders that the composer replaces with the detected script
  // hint. We always apply the composer's detected config when present
  // so the Author's draft placeholders never reach `init()`.
  for (const { target } of DELIVERY_TARGET_PROMPTS) {
    const detection = discovery.detections.delivery[target];
    if (detection !== null) {
      next.delivery = {
        ...next.delivery,
        [target]: detection.config,
      };
      continue;
    }
    if (discovery.unresolved.includes(`delivery.${target}`)) {
      const label = target.charAt(0).toUpperCase() + target.slice(1);
      const argv = await promptDeliveryCommand(io, label);
      next.delivery = {
        ...next.delivery,
        [target]: { adapter: "command", command: argv },
      };
    }
  }

  return next;
}

async function selectModel(io: InteractiveInitIO, modelClass: ModelClass): Promise<string> {
  const inventory = await io.listOpenCodeModels();
  const selection: ModelSelection = {
    modelClass,
    inventory,
    recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
    // Init runs before any model is installed, so there is no
    // "current" identity to mark in the hint. Pass `null` and let
    // `runModelSelector` apply its own `initialValue` policy.
    currentIdentity: null,
  };
  const chosen = await io.runModelSelector(selection);
  if (chosen.trim().length === 0) {
    throw new PoiesisError("INVALID_MODEL_CHOICE", "Empty model choice", { modelClass });
  }
  if (!/^[^/]+\/.+$/.test(chosen)) {
    throw new PoiesisError(
      "INVALID_MODEL_ID",
      "Model ID must use provider/model format",
      { modelClass, modelId: chosen },
    );
  }
  return chosen;
}

async function pickRemote(io: InteractiveInitIO, alternates: readonly string[]): Promise<string> {
  if (alternates.length === 0) {
    throw new PoiesisError("REMOTE_DISCOVERY_FAILED", "No Git remote is configured", {});
  }
  io.writeStderr("Multiple Git remotes are configured:");
  for (const name of alternates) io.writeStderr(`  - ${name}`);
  const prompt = `Select the canonical remote for this project (${alternates.join(" / ")})`;
  const answer = (await io.promptLine(prompt)).trim();
  if (!alternates.includes(answer)) {
    throw new PoiesisError("INVALID_REMOTE_CHOICE", "Selected remote is not configured", {
      chosen: answer,
      alternates: [...alternates],
    });
  }
  return answer;
}

async function promptDeliveryCommand(
  io: InteractiveInitIO,
  label: string,
): Promise<readonly string[]> {
  const lower = label.toLowerCase();
  // Spirit of the unresolved Preview message (ticket #64): explain in
  // product language BEFORE asking for the technical boundary. The
  // Author understands what ${label} is for, why we cannot find it,
  // what we are asking them to supply, and that Poiesis will pass the
  // exact candidate SHA to it. The technical argv/{sha} rule is still
  // enforced at validation time, but it never leads the Author-facing
  // prompt. The word "adapter" is never used in Author-facing text.
  io.writeStderr("");
  io.writeStderr(`Poiesis could not determine how this project ${unresolvedDeliveryVerb(label)} ${label}.`);
  io.writeStderr(`${label} ${unresolvedDeliveryRole(label)}`);
  io.writeStderr(`No existing Poiesis ${lower} command was found.`);
  io.writeStderr(`Provide the command this project should use for ${label}.`);
  io.writeStderr(`Poiesis will pass the exact candidate SHA to it.`);
  io.writeStderr("");
  io.writeStderr(`Example: ./scripts/poiesis-${lower} {sha}`);
  io.writeStderr("");
  const raw = (await io.promptLine(`${label} command>`)).trim();
  const argv = raw.split(/\s+/).filter((entry) => entry.length > 0);
  if (argv.length === 0) {
    throw new PoiesisError(
      "INVALID_DELIVERY_ARGV",
      `${label} delivery command must not be empty`,
      {},
    );
  }
  if (!argv.includes("{sha}")) {
    throw new PoiesisError(
      "INVALID_DELIVERY_ARGV",
      `${label} delivery command must contain the literal token {sha} so Poiesis can pass the exact candidate SHA`,
      { argv },
    );
  }
  for (const entry of argv) {
    if (FORBIDDEN_DELIVERY_ADAPTERS.has(entry)) {
      throw new PoiesisError(
        "INVALID_DELIVERY_ARGV",
        `${label} delivery command must be a real shell command; "${entry}" is a hosting-provider name, not a command Poiesis can run`,
        { argv, forbidden: [...FORBIDDEN_DELIVERY_ADAPTERS] },
      );
    }
  }
  return argv;
}

/**
 * Verb used in the unresolved-delivery explanation (ticket #64). The
 * Author-facing text varies per target so the framing stays natural
 * instead of repeating a single template.
 */
function unresolvedDeliveryVerb(label: string): string {
  const lower = label.toLowerCase();
  if (lower === "preview") return "creates";
  if (lower === "staging") return "deploys to";
  return "releases to";
}

/**
 * One-line product role for the unresolved-delivery explanation.
 * Preview produces a tryable candidate before integration; Staging
 * validates the accepted candidate in a production-like target;
 * Production releases the accepted release candidate after integration.
 */
function unresolvedDeliveryRole(label: string): string {
  const lower = label.toLowerCase();
  if (lower === "preview") return "must produce a real candidate you can try before integration.";
  if (lower === "staging") return "must validate the accepted candidate in a production-like target.";
  return "must release the accepted release candidate after integration.";
}

async function promptWithDefault(io: InteractiveInitIO, label: string, fallback: string): Promise<string> {
  const answer = (await io.promptLine(`${label} [${fallback}]`)).trim();
  return answer.length === 0 ? fallback : answer;
}

async function probeTrackerAuthBeforeInstall(io: InteractiveInitIO, config: PoiesisConfig): Promise<void> {
  const provider = config.tracker.provider;
  if (provider === "fixture") return; // test-only path; init() handles authorization
  const result = await io.probeTrackerAuth(provider);
  if (result.available) return;
  const loginCommand = provider === "github" ? "gh auth login" : "glab auth login";
  const detailLines: string[] = [];
  if (result.stderr !== undefined) detailLines.push(result.stderr);
  if (result.hint !== undefined) detailLines.push(result.hint);
  detailLines.push(`Run \`${loginCommand}\` to authenticate, then re-run \`poiesis init\`.`);
  throw new PoiesisError(
    "TRACKER_AUTH_FAILED",
    `${provider} tracker is not authenticated: ${loginCommand}`,
    {
      provider,
      loginCommand,
      stderr: result.stderr,
      hint: result.hint ?? `Run \`${loginCommand}\` to authenticate, then re-run \`poiesis init\`.`,
    },
  );
}

function formatRestartNotice(): string {
  return [
    "",
    "Poiesis init succeeded.",
    "Restart OpenCode to load the new agent projections, harnesses, and skill installs.",
    "Poiesis did not restart OpenCode; you must do that yourself.",
    "",
  ].join("\n");
}

// Export the helpers so tests can drive individual steps without spinning
// up the full init() transaction. Kept module-internal so they do not
// leak through `src/index.ts`; tests import from the source module.
export const __test = { resolveAuthorChoices, refuseIfAlreadyInstalled };

/**
 * Production IO factory. Wires the interactive init IO to
 * `process.stdin` / `process.stderr` so the typical CLI invocation
 * stays a zero-argument call site. Model selection is delegated to
 * `runModelSelector`, which goes through the CLI-internal Clack
 * adapter (`src/clack-select.ts`). The init / model flows share that
 * single interactive list primitive so there is no second selector
 * implementation to drift.
 *
 * Tests inject a fully scripted IO via the `io` parameter on
 * `runInteractiveInit`; production code goes through this factory.
 */
export function createProductionInteractiveInitIO(): InteractiveInitIO {
  const stdin = process.stdin;
  const stderr = process.stderr;
  const isTTY = Boolean((stdin as { isTTY?: boolean }).isTTY);
  // Ticket #75: flow-scoped stdin release. Idempotent and
  // defensive — `settleOnceLinePrompt` and the Clack adapter resume
  // stdin after every intermediate prompt so the next interactive
  // seam can run; at the very end of the interactive flow we want the
  // inverse: pause the stream (so it stops pulling data) and unref it
  // from the event loop (so a still-open stdin cannot keep the process
  // alive). Mirrors the model interactive IO factory's release seam.
  let released = false;
  const releaseStdin = (): void => {
    if (released) return;
    released = true;
    if (typeof stdin.pause === "function" && (stdin as { readableEnded?: boolean }).readableEnded !== true && (stdin as { destroyed?: boolean }).destroyed !== true) {
      try {
        stdin.pause();
      } catch {
        // Defensive: pause() can surface stream-state errors; the
        // `unref()` below is the canonical "do not keep the event
        // loop alive" call, so swallowing pause() failures does not
        // weaken the release contract.
      }
    }
    if (typeof stdin.unref === "function") {
      try {
        stdin.unref();
      } catch {
        // Defensive: unref() can throw on a non-standard stream, and
        // we never want a release failure to propagate.
      }
    }
  };
  return {
    isTTY,
    writeStderr(line: string): void {
      stderr.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    releaseStdin,
    async promptLine(prompt: string): Promise<string> {
      // Ticket #68: the production prompt is a thin adapter over the
      // CLI-internal settle-once readline helper. The helper owns the
      // settle-once invariant; the factory only binds stdin / stderr and
      // the distinct `INIT_PROMPT_CANCELLED` cancellation error (kept
      // distinct from `MODEL_PROMPT_CANCELLED` per Spec §"Design").
      // Callers still `.trim()` the returned raw line themselves.
      return await settleOnceLinePrompt({
        prompt,
        input: stdin,
        output: stderr,
        isTTY,
        cancellationError: new PoiesisError(
          "INIT_PROMPT_CANCELLED",
          "Interactive prompt was cancelled by the user",
          { prompt },
        ),
      });
    },
    async listOpenCodeModels(): Promise<readonly string[]> {
      const result = await runChildProcess("opencode", ["models"], { cwd: process.cwd(), allowFailure: true });
      if (result.exitCode !== 0) {
        throw new PoiesisError(
          "MODEL_INVENTORY_UNAVAILABLE",
          "OpenCode model inventory is unavailable",
          { stderr: result.stderr },
        );
      }
      return [...parseOpenCodeModelInventory(result.stdout)];
    },
    async runModelSelector(selection: ModelSelection): Promise<string> {
      // Init runs before any model is installed, so there is no
      // "current" identity to mark in the hint. Pass `null` and let
      // `runModelSelector` apply its own `initialValue` policy.
      return await runModelSelector({
        inventory: selection.inventory,
        recommended: selection.recommended,
        modelClass: selection.modelClass,
        currentIdentity: selection.currentIdentity,
        cancelError: new PoiesisError(
          "INIT_MODEL_SELECTOR_CANCELLED",
          "Interactive init model selector was cancelled by the user",
          { modelClass: selection.modelClass },
        ),
      });
    },
    async probeTrackerAuth(provider: TrackerProvider): Promise<TrackerAuthProbeResult> {
      if (provider === "github") {
        const result = await runChildProcess("gh", ["auth", "status"], { cwd: process.cwd(), allowFailure: true });
        if (result.exitCode === 0) return { available: true };
        return {
          available: false,
          stderr: result.stderr || result.stdout,
          hint: "Run `gh auth login` to authenticate, then re-run `poiesis init`",
        };
      }
      const result = await runChildProcess("glab", ["auth", "status"], { cwd: process.cwd(), allowFailure: true });
      if (result.exitCode === 0) return { available: true };
      return {
        available: false,
        stderr: result.stderr || result.stdout,
        hint: "Run `glab auth login` to authenticate, then re-run `poiesis init`",
      };
    },
  };
}

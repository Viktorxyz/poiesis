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
import { isDeferredDelivery, trackerExtensionKeys, trackerProjectOf, DEFERRED_DELIVERY_MODE, type ConfiguredDeliveryConfig, type PoiesisConfig } from "./config.js";
import { defaultDeliveryAdapter } from "./delivery-defaults.js";
import { PoiesisError } from "./errors.js";
import {
  composeInitDiscovery,
  type InitDiscoveryResult,
  type RemoteDetection,
} from "./init-discovery.js";
import {
  LINEAR_API_KEY_VARIABLE,
  LINEAR_OAUTH_TOKEN_VARIABLE,
  verifyLinearTrackerConfigured,
} from "./linear-tracker.js";
import { assertLocalTrackerStoreUsable, resolveLocalTrackerStoreLocation } from "./local-tracker.js";
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

/**
 * Spec #139 / ticket #144 — the four tracker providers an interactive install
 * may record. `fixture` is deliberately absent: it is a test-only path gated
 * behind explicit authorization, and offering it in the human flow would make
 * a fixture look like a supported product choice.
 */
export type TrackerProvider = "github" | "gitlab" | "linear" | "local";

/** The provider names this flow offers, in prompt order. */
const TRACKER_CHOICES: readonly TrackerProvider[] = ["github", "gitlab", "linear", "local"];

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

/**
 * Spec #139 / ticket #144 — the coordinates the pre-install check needs.
 *
 * Only `linear` has a coordinate that is not a Git host repository, so only
 * `linear` reads a field here. The credential is never part of this context:
 * it stays in the environment, and a prompt must never carry it.
 */
export interface TrackerAuthProbeContext {
  readonly team?: string;
  readonly project?: string;
}

export interface InteractiveInitIO {
  readonly isTTY: boolean;
  writeStderr(line: string): void;
  promptLine(prompt: string): Promise<string>;
  listOpenCodeModels(): Promise<readonly string[]>;
  runModelSelector(selection: ModelSelection): Promise<string>;
  probeTrackerAuth(provider: TrackerProvider, context?: TrackerAuthProbeContext): Promise<TrackerAuthProbeResult>;
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
 * Spec #139 / ticket #144 — the generated prompt strings this ticket owns.
 * They are the Author-visible contract of the onboarding questions, so they
 * live next to the flow that issues them.
 */
const LINEAR_TEAM_PROMPT = "Linear team (key or name)";
const LINEAR_PROJECT_PROMPT = "Linear project (optional — leave blank to skip)";
const DELIVERY_MODE_PROMPT = "Configure delivery now? (configured|deferred)";
/**
 * The Linear credential variables, and the one sentence that tells an
 * operator what to do about them. The credential is environment-only by
 * design, so the guidance deliberately contains no "paste", "enter your
 * key", or any other wording that would invite a secret into the config.
 */
const LINEAR_CREDENTIAL_VARIABLES = [LINEAR_API_KEY_VARIABLE, LINEAR_OAUTH_TOKEN_VARIABLE] as const;
const LINEAR_CREDENTIAL_GUIDANCE =
  `Set exactly one of ${LINEAR_CREDENTIAL_VARIABLES.join(" or ")} in the environment and re-run \`poiesis init\`. ` +
  "Poiesis never stores a Linear credential in the config, so do not put one there.";
const LOCAL_STORE_LABEL = "poiesis-tracker-v1 (under the Git common directory)";
const LOCAL_STORE_GUIDANCE =
  `The Local tracker needs a writable, non-symlinked ${LOCAL_STORE_LABEL} beneath the Git common directory; ` +
  "remove the obstruction and re-run `poiesis init`.";

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
export /**
 * Spec #138: a delivery target that was neither detected nor asked about still
 * needs a real value, because the config type requires all three. init writes
 * the corresponding generated script, so the generated adapter is the correct
 * answer rather than a placeholder.
 *
 * Spec #139 / ticket #140: the return type is the CONFIGURED branch of the
 * delivery union, so a deferred draft is never completed with generated
 * command targets by this helper.
 */
function resolveDeliveryDefaults(): ConfiguredDeliveryConfig {
  return {
    preview: defaultDeliveryAdapter("preview"),
    staging: defaultDeliveryAdapter("staging"),
    production: defaultDeliveryAdapter("production"),
  };
}

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
  // Spec #139 / ticket #144: the detected tracker is a SUGGESTED default. The
  // wording says so, so a github.com remote never reads as a decision the
  // Author already made.
  lines.push(
    tracker.provider === undefined
      ? `  tracker: (unknown; a provider must be chosen)${formatSource(tracker.source)}`
      : `  tracker: ${tracker.provider}${tracker.project ? ` / ${tracker.project}` : ""}${formatSource(tracker.source)} (suggested default — you choose)`,
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
      "tracker.provider": "tracker provider (github, gitlab, linear, or local)",
      "tracker.project": "tracker project",
      "tracker.team": "Linear team",
      "delivery.mode": "delivery readiness (configured now, or deferred)",
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
  // Spec #139 / ticket #144: the tracker block is NOT seeded from the
  // composer's remote inference. Detection still runs (it is the default the
  // provider prompt offers), but the Author's answer decides the block, and a
  // coordinate detected for one provider is never carried into another — a
  // `owner/repo` learned from a github.com remote must not become a GitLab or
  // Linear project. The runtime config therefore always carries a provider
  // the Author chose, and coordinates that match that provider.
  const base: PoiesisConfig = (draft ?? {
    schema: 1,
    models: { reasoning: "", execution: "" },
    tracker: {
      ...(discovery.detections.tracker.provider !== undefined
        ? { provider: discovery.detections.tracker.provider }
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

  // Spec #139 / ticket #144 — ONE explicit tracker choice, then exactly the
  // coordinates that provider needs. The provider the remote implied is
  // offered as a visible default (empty Enter accepts it); an unrecognized
  // remote host offers NO default, so the composer still cannot guess a
  // tracker for a host it does not understand.
  //
  // Spec #139 / ticket #153 — every rebuild below REPLACES the block from the
  // coordinates alone, and the replacement is what `init` serializes into
  // `.poiesis/config.jsonc`. Each one therefore carries the block's
  // non-reserved, non-secret extension keys from the shared
  // `trackerExtensionKeys` partition, with the known coordinates written LAST
  // so an extension still cannot introduce or complete a coordinate the
  // chosen provider owns. A coordinate belonging to a DIFFERENT provider is
  // still dropped — that is #144's cross-provider rule, unchanged.
  if (discovery.unresolved.includes("tracker.provider")) {
    const inferred = discovery.detections.tracker.provider;
    const answer = (await io.promptLine(trackerProviderPrompt(inferred))).trim();
    const provider = answer.length === 0 && inferred !== undefined ? inferred : answer;
    if (!isTrackerProvider(provider)) {
      throw new PoiesisError(
        "INVALID_TRACKER_PROVIDER",
        `Unsupported tracker provider; choose one of: ${TRACKER_CHOICES.join(", ")}`,
        { provider: answer, supported: [...TRACKER_CHOICES] },
      );
    }
    next.tracker = { ...trackerExtensionKeys(next.tracker), provider };
  }

  // Coordinates follow the CHOSEN provider, never the inferred one. Each
  // branch drops every coordinate that belongs to a different provider, so a
  // repository project discovered from the remote can never leak into a
  // Linear or Local tracker block.
  const chosen = next.tracker?.provider;
  if (chosen === "local") {
    // Spec #139: Local needs no remote coordinates at all. Its only state is
    // the clone-local store the repository already owns.
    next.tracker = { ...trackerExtensionKeys(next.tracker), provider: "local" };
  } else if (chosen === "linear") {
    const team = declaredTeam(next.tracker) ?? (await promptRequired(io, LINEAR_TEAM_PROMPT));
    // The Linear project is OPTIONAL, and a draft that already names one is
    // the recorded answer. A draft that names only the team is asked, and a
    // blank answer keeps the block project-free rather than inventing one.
    const project = declaredProject(next.tracker) ?? (await promptOptional(io, LINEAR_PROJECT_PROMPT));
    next.tracker = {
      ...trackerExtensionKeys(next.tracker),
      provider: "linear",
      team,
      ...(project.length === 0 ? {} : { project }),
    };
  } else if (chosen === "github" || chosen === "gitlab") {
    // A detected project is only reusable when the REMOTE derived it for this
    // same provider; an explicit draft project is the Author's own record.
    const detected =
      discovery.detections.tracker.provider === chosen &&
      (discovery.detections.tracker.source === "remote-github" ||
        discovery.detections.tracker.source === "remote-gitlab")
        ? discovery.detections.tracker.project
        : undefined;
    const project =
      declaredProject(next.tracker) ?? detected ?? (await promptRequired(io, "Tracker project"));
    next.tracker = { ...trackerExtensionKeys(next.tracker), provider: chosen, project };
  }

  // Spec #139 / ticket #144 — delivery readiness is asked ONCE, before any
  // per-target question. The two states are so different from one another
  // (three working targets versus an intentional pause) that choosing one for
  // the Author would record a readiness decision nobody made, and writing
  // placeholder scripts for a deferred install is exactly the fake adapter
  // the Spec forbids. There is no bracket default here on purpose.
  if (discovery.unresolved.includes("delivery.mode")) {
    const answer = (await io.promptLine(DELIVERY_MODE_PROMPT)).trim();
    if (answer === "deferred") {
      // Deferral skips the rest of this function: no target prompt, no target
      // probe, and `init()` generates no script for any target.
      return { ...next, delivery: { mode: DEFERRED_DELIVERY_MODE } };
    }
    if (answer !== "configured") {
      throw new PoiesisError(
        "INVALID_DELIVERY_MODE",
        `Unsupported delivery readiness; choose \`configured\` or \`deferred\``,
        { answer, supported: ["configured", "deferred"] },
      );
    }
  }

  // Delivery command argv: real command line containing `{sha}`. The
  // composer's delivery detection may have prefilled an explicit
  // adapter (script hint or explicit draft entry) even when the
  // delivery targets themselves are NOT in the unresolved list —
  // for example, the canonical template draft carries `<...>`
  // placeholders that the composer replaces with the detected script
  // hint. We always apply the composer's detected config when present
  // so the Author's draft placeholders never reach `init()`.
  // Spec #139 / ticket #140: a deferred draft keeps its deferred state; no
  // target is ever completed from a placeholder or a generated script, so
  // the whole delivery question loop is skipped.
  if (isDeferredDelivery(next.delivery)) return next;
  for (const { target } of DELIVERY_TARGET_PROMPTS) {
    const detection = discovery.detections.delivery[target];
    if (detection !== null) {
      next.delivery = { ...resolveDeliveryDefaults(), ...next.delivery, [target]: detection.config };
      continue;
    }
    if (discovery.unresolved.includes(`delivery.${target}`)) {
      const label = target.charAt(0).toUpperCase() + target.slice(1);
      const argv = await promptDeliveryCommand(io, label);
      next.delivery = { ...resolveDeliveryDefaults(), ...next.delivery, [target]: { adapter: "command", command: argv } };
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

/**
 * Spec #139 / ticket #144 — the tracker-provider prompt. Every supported
 * provider is named in the prompt itself, so the Author can see that the
 * choice is one of four before answering, and an inferred provider appears
 * as a bracketed DEFAULT rather than a silent decision. An unrecognized
 * remote host renders no default at all, so the discovery layer still cannot
 * invent a tracker it cannot see.
 */
function trackerProviderPrompt(inferred: string | undefined): string {
  const choices = TRACKER_CHOICES.join("|");
  const provider = inferred !== undefined && isTrackerProvider(inferred) ? inferred : undefined;
  return provider === undefined
    ? `Tracker provider (${choices})`
    : `Tracker provider (${choices}) [${provider}]`;
}

function isTrackerProvider(value: string): value is TrackerProvider {
  return (TRACKER_CHOICES as readonly string[]).includes(value);
}

/** The declared repository/project coordinate of a possibly absent block. */
function declaredProjectOf(tracker: PoiesisConfig["tracker"]): string | undefined {
  return tracker === undefined ? undefined : trackerProjectOf(tracker);
}

/**
 * A coordinate the draft already recorded, or `undefined` when it recorded
 * nothing usable. An empty or whitespace-only value is treated as nothing
 * said: carrying it forward would record a coordinate the Author never
 * named, which is exactly the fabrication this ticket removes.
 */
function declaredProject(tracker: PoiesisConfig["tracker"]): string | undefined {
  const value = declaredProjectOf(tracker);
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** The declared Linear team of a possibly absent block. */
function declaredTeam(tracker: PoiesisConfig["tracker"]): string | undefined {
  const value = tracker === undefined ? undefined : (tracker as { team?: unknown }).team;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A coordinate with no safe default: an empty answer fails closed. */
async function promptRequired(io: InteractiveInitIO, label: string): Promise<string> {
  const answer = (await io.promptLine(label)).trim();
  if (answer.length === 0) {
    throw new PoiesisError("INVALID_TRACKER_CONFIG", `${label} must not be empty`, { field: label });
  }
  return answer;
}

/** An optional coordinate: an empty answer means "no such coordinate". */
async function promptOptional(io: InteractiveInitIO, label: string): Promise<string> {
  return (await io.promptLine(label)).trim();
}

async function probeTrackerAuthBeforeInstall(
  io: InteractiveInitIO,
  config: PoiesisConfig,
): Promise<void> {
  const provider = config.tracker?.provider;
  if (provider === "fixture") return; // test-only path; init() handles authorization
  if (provider === undefined) return;
  // Spec #139 / ticket #144: the check dispatches on the provider the Author
  // actually chose, and receives whatever coordinates that provider needs.
  // Linear carries a team (and an optional project); the Git hosts and Local
  // need none, because their coordinates are either inferred or absent.
  const tracker = config.tracker;
  const team = provider === "linear" ? declaredTeam(tracker) : undefined;
  const project = declaredProjectOf(tracker);
  const result = await io.probeTrackerAuth(provider, {
    ...(team === undefined ? {} : { team }),
    ...(project === undefined ? {} : { project }),
  });
  if (result.available) return;
  const guidance = trackerAuthGuidance(provider);
  throw new PoiesisError(
    "TRACKER_AUTH_FAILED",
    `${provider} tracker is not ready: ${guidance.summary}`,
    {
      provider,
      ...guidance.details,
      stderr: result.stderr,
      hint: result.hint ?? guidance.action ?? guidance.summary,
    },
  );
}

/**
 * Spec #139 / ticket #144 — actionable guidance per provider.
 *
 * A Git host authenticates through its CLI, so the action is a login command.
 * Linear's credential is environment-only, so the action names the two
 * variables and explicitly refuses to invite the Author to write a secret
 * anywhere. Local has no credential at all, so its action names the state that
 * must be usable. `details` is spread into the error so a caller can act on
 * the guidance programmatically.
 */
function trackerAuthGuidance(provider: TrackerProvider): {
  summary: string;
  action: string | undefined;
  details: Record<string, unknown>;
} {
  if (provider === "github") {
    const action = "Run `gh auth login` to authenticate, then re-run `poiesis init`.";
    return { summary: "gh auth login", action, details: { loginCommand: "gh auth login" } };
  }
  if (provider === "gitlab") {
    const action = "Run `glab auth login` to authenticate, then re-run `poiesis init`.";
    return { summary: "glab auth login", action, details: { loginCommand: "glab auth login" } };
  }
  if (provider === "linear") {
    return {
      summary: `the configured Linear team is not reachable with the ${LINEAR_CREDENTIAL_VARIABLES.join(" / ")} credential in the environment`,
      action: LINEAR_CREDENTIAL_GUIDANCE,
      details: { credentialVariables: [...LINEAR_CREDENTIAL_VARIABLES] },
    };
  }
  return {
    summary: "the clone-local tracker store is not usable",
    action: LOCAL_STORE_GUIDANCE,
    details: { storeDirectory: LOCAL_STORE_LABEL },
  };
}

function formatRestartNotice(): string {
  return [
    "",
    "Poiesis init succeeded.",
    "",
    "Next:",
    "  1. Restart OpenCode. The agent projections, permissions, and skills only",
    "     take effect on a fresh start. Poiesis does not restart it for you.",
    "  2. Confirm it is healthy:   pnpm poiesis doctor",
    "  3. Ask the repository a question:",
    "       pnpm poiesis repository query --question \"...\"",
    "",
    "Every Poiesis command from here is just `pnpm poiesis <command>`.",
    "You never need to name a version, and you never need a cache flag.",
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
 * stays a single-argument call site. Model selection is delegated to
 * `runModelSelector`, which goes through the CLI-internal Clack
 * adapter (`src/clack-select.ts`). The init / model flows share that
 * single interactive list primitive so there is no second selector
 * implementation to drift.
 *
 * The factory takes the resolved repository `root` (git toplevel of the
 * repo the Author is editing) so every repository-sensitive subprocess —
 * `opencode models`, `gh auth status`, and `glab auth status` — runs
 * from the SAME root the transactional `init()` write path uses. Bare
 * `process.cwd()` would let the interactive flow read the wrong repo's
 * OpenCode / tracker configuration when `poiesis init --cwd <path>`
 * lands the CLI in a subdirectory of a different repo (ticket #78).
 *
 * Tests inject a fully scripted IO via the `io` parameter on
 * `runInteractiveInit`; production code goes through this factory.
 */
export function createProductionInteractiveInitIO(root: string): InteractiveInitIO {
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
      // Run `opencode models` from the repo root, NOT `process.cwd()`.
      // CLI dispatch lands here when the Author passes
      // `poiesis init --cwd <path>` from any subdirectory of the repo;
      // the opencode config (`opencode.jsonc`) lives at the repo root,
      // so a child process spawned from a sub-cwd could see a different
      // (or no) OpenCode installation.
      const result = await runChildProcess("opencode", ["models"], { cwd: root, allowFailure: true });
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
    async probeTrackerAuth(provider: TrackerProvider, context?: TrackerAuthProbeContext): Promise<TrackerAuthProbeResult> {
      if (provider === "github") {
        // Run from the repo root so the auth probe sees the same Git
        // config (`gh` / `glab` honor the current repo's credentials
        // configuration) as the rest of the init transaction. Bare
        // `process.cwd()` would let the probe read the wrong repo
        // when `poiesis init --cwd <path>` lands the CLI in a
        // subdirectory of a different repo.
        const result = await runChildProcess("gh", ["auth", "status"], { cwd: root, allowFailure: true });
        if (result.exitCode === 0) return { available: true };
        return {
          available: false,
          stderr: result.stderr || result.stdout,
          hint: "Run `gh auth login` to authenticate, then re-run `poiesis init`",
        };
      }
      if (provider === "gitlab") {
        const result = await runChildProcess("glab", ["auth", "status"], { cwd: root, allowFailure: true });
        if (result.exitCode === 0) return { available: true };
        return {
          available: false,
          stderr: result.stderr || result.stdout,
          hint: "Run `glab auth login` to authenticate, then re-run `poiesis init`",
        };
      }
      // Spec #139 / ticket #144: Linear and Local have no host CLI, so their
      // check is the real capability the tracker depends on, not an
      // `auth status` stand-in. Linear proves the environment credential AND
      // that the configured team/project actually resolve, so a mistyped
      // coordinate is refused here rather than at the first tracker mutation.
      // Both paths fail closed with the provider's own typed error, which
      // `trackerAuthGuidance` turns into Author-facing guidance.
      if (provider === "linear") {
        try {
          await verifyLinearTrackerConfigured({
            team: context?.team ?? "",
            ...(context?.project === undefined ? {} : { project: context.project }),
          });
          return { available: true };
        } catch (error) {
          return { available: false, ...probeFailureDetails(error) };
        }
      }
      try {
        await assertLocalTrackerStoreUsable(await resolveLocalTrackerStoreLocation(root));
        return { available: true };
      } catch (error) {
        return { available: false, ...probeFailureDetails(error) };
      }
    },
  };
}

/** The typed code and message of a failed capability probe, with no secret. */
function probeFailureDetails(error: unknown): { stderr?: string } {
  if (error instanceof PoiesisError) return { stderr: `${error.code}: ${error.message}` };
  if (error instanceof Error) return { stderr: `${error.name}: ${error.message}` };
  return { stderr: String(error) };
}

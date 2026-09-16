/**
 * Init discovery composer (internal).
 *
 * The composer is the read-only, write-free front half of the future `poiesis
 * init` TTY (ticket #58). It inspects the repository, the Git forge, the
 * project verification surface, the OpenCode harness layout, existing Poiesis
 * state, and `scripts/poiesis-{preview,staging,production}*` hints; it then
 * builds either a fully resolved `PoiesisConfig` OR a list of unresolved
 * fields that the TTY will prompt the Author about.
 *
 * Hard rules (mirrored in the ticket #57 acceptance contract):
 *   - The composer NEVER writes to the repository.
 *   - When every fact can be discovered uniquely, the result carries a fully
 *     resolved `PoiesisConfig` with no `<...>` placeholders.
 *   - When ambiguity is genuine, facts stay unresolved and surface via the
 *     `unresolved` array; the composer does NOT guess (no random remote
 *     pick, no fabricated hosting-provider adapter).
 *   - Existing `scripts/poiesis-preview|staging|production*` files MAY be
 *     prefilled as `command` delivery adapters whose `argv` contains the
 *     exact `{sha}` token; missing scripts stay unresolved.
 *   - Vercel, Netlify, Cloudflare, and GitHub Actions are NEVER invented as
 *     delivery adapters — only the user's explicit draft or a present
 *     `scripts/poiesis-*` hint can populate delivery.
 *   - The composer reuses `autoResolveConfigDefaults` and the forge parsers
 *     (`parseGitHubProject`, `parseGitLabProject`, `parseTrackerFromUrl`)
 *     rather than re-implementing their discoveries.
 *
 * This module intentionally exports the composer symbol so the test suite can
 * drive it directly. `src/index.ts` does NOT re-export this module, so the
 * composer stays out of the public `poiesis-cli` API and never appears in
 * `dist/index.d.ts`.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoiesisConfig, ResolvedPoiesisConfig } from "./config.js";
import {
  parseTrackerFromUrl,
  autoResolveConfigDefaults,
} from "./maintenance.js";
import { exists } from "./fs.js";
import { PoiesisError } from "./errors.js";
import { run as runChildProcess } from "./process.js";

export type RemoteSource = "explicit" | "git-origin" | "git-singleton" | "ambiguous" | "none";
export type BranchSource =
  | "explicit"
  | "git-local-main"
  | "git-remote-main"
  | "git-local-fallback"
  | "ambiguous"
  | "none";
export type VerificationSource = "explicit" | "package-scripts" | "none";
export type TrackerSource = "explicit" | "remote-github" | "remote-gitlab" | "missing";
export type DeliverySource =
  | { kind: "script"; path: string }
  | { kind: "explicit" }
  | { kind: "fixture" };

export interface RemoteDetection {
  name?: string;
  url?: string;
  source: RemoteSource;
  /** Other remote names observed (for ambiguous cases). */
  alternates?: string[];
}

export interface BranchDetection {
  name?: string;
  source: BranchSource;
}

export interface VerificationDetection {
  commands: string[];
  source: VerificationSource;
}

export interface TrackerDetection {
  provider?: "github" | "gitlab" | "fixture";
  project?: string;
  source: TrackerSource;
}

export interface DeliveryDetectionTarget {
  config: ResolvedPoiesisConfig["delivery"][keyof ResolvedPoiesisConfig["delivery"]];
  source: DeliverySource;
}

export interface DeliveryDetection {
  preview: DeliveryDetectionTarget | null;
  staging: DeliveryDetectionTarget | null;
  production: DeliveryDetectionTarget | null;
}

export interface RepoStateDetection {
  opencodeConfigPath?: string;
  opencodeConfigPresent: boolean;
  poiesisInstalled: boolean;
  poiesisManifestVersion?: string;
}

export interface InitDiscoveryResult {
  config?: ResolvedPoiesisConfig;
  /** JSON-pointer-style paths into the resolved config that the TTY must resolve. */
  unresolved: string[];
  detections: {
    remote: RemoteDetection;
    integrationBranch: BranchDetection;
    verification: VerificationDetection;
    tracker: TrackerDetection;
    delivery: DeliveryDetection;
    repo: RepoStateDetection;
  };
}

const DELIVERY_TARGETS = ["preview", "staging", "production"] as const;
type DeliveryTargetKey = (typeof DELIVERY_TARGETS)[number];

const OPENCODE_CONFIG_RELATIVE_PATHS = [
  "opencode.jsonc",
  "opencode.json",
  ".opencode/opencode.jsonc",
  ".opencode/opencode.json",
] as const;

const POIESIS_MANIFEST_RELATIVE = ".poiesis/manifest.json";

const DELIVERY_SCRIPT_PREFIX: Record<DeliveryTargetKey, string> = {
  preview: "poiesis-preview",
  staging: "poiesis-staging",
  production: "poiesis-production",
};

/**
 * Compose the init discovery result for `root` using the optional `draft` as
 * the explicit-override source. The composer NEVER writes to the repository
 * and never blocks on missing facts; ambiguous facts surface via
 * `result.unresolved` with a documented `source` so the future TTY can prompt.
 */
export async function composeInitDiscovery(
  root: string,
  draft?: PoiesisConfig,
): Promise<InitDiscoveryResult> {
  const unresolved: string[] = [];
  const remoteNames = await listGitRemotes(root);
  const remoteUrls = await readRemoteUrls(root, remoteNames);

  const remoteDetection = detectRemote(draft, remoteNames, remoteUrls);
  const branchDetection = await detectIntegrationBranch(draft, root, remoteDetection.name);
  const verificationDetection = await detectVerification(root, draft);
  const trackerDetection = await detectTracker(draft, remoteDetection.url);
  const deliveryDetection = await detectDelivery(draft, root);
  const repoState = await inspectRepoState(root);

  if (remoteDetection.source === "none" || remoteDetection.source === "ambiguous") {
    unresolved.push("repository.remote");
  }
  if (
    branchDetection.source === "none" ||
    branchDetection.source === "ambiguous"
  ) {
    unresolved.push("repository.integrationBranch");
  }
  if (verificationDetection.source === "none") {
    unresolved.push("verification.commands");
  }
  if (trackerDetection.source === "missing" || trackerDetection.project === undefined) {
    unresolved.push("tracker.project");
  }
  if (draft?.tracker.provider === undefined) {
    unresolved.push("tracker.provider");
  }
  if (draft?.models.reasoning === undefined || draft.models.reasoning.trim().length === 0) {
    unresolved.push("models.reasoning");
  }
  if (draft?.models.execution === undefined || draft.models.execution.trim().length === 0) {
    unresolved.push("models.execution");
  }
  if (deliveryDetection.preview === null) unresolved.push("delivery.preview");
  if (deliveryDetection.staging === null) unresolved.push("delivery.staging");
  if (deliveryDetection.production === null) unresolved.push("delivery.production");

  if (unresolved.length === 0) {
    try {
      const resolved = await autoResolveConfigDefaults(root, draft as PoiesisConfig);
      if (resolved.config.verification.commands.length > 0 && trackerDetection.project !== undefined) {
        // Replace any delivery target that still carries a `<...>` placeholder
        // (e.g. the canonical config template) with the composer's prefilled
        // command adapter. The composer reuses `autoResolveConfigDefaults` for
        // every field it cannot reasonably recompute, but it owns the delivery
        // argv because the delivery script-hint rule is internal-only.
        const finalConfig: ResolvedPoiesisConfig = {
          ...resolved.config,
          delivery: {
            preview: replaceTemplateDelivery(resolved.config.delivery.preview, deliveryDetection.preview),
            staging: replaceTemplateDelivery(resolved.config.delivery.staging, deliveryDetection.staging),
            production: replaceTemplateDelivery(resolved.config.delivery.production, deliveryDetection.production),
          },
          verification: verificationDetection.source === "package-scripts"
            ? { commands: [...verificationDetection.commands] }
            : resolved.config.verification,
        };
        if (containsTemplatePlaceholder(finalConfig)) {
          // Defensive: if `<...>` placeholders still survive after the merge
          // (e.g. an explicit draft with placeholders the user did not fill
          // and no script hint to substitute), fall back to the unresolved
          // report rather than surface a non-conforming config.
          throw new PoiesisError("UNRESOLVED_TEMPLATE", "Auto-resolved config still contains template placeholders");
        }
        return {
          config: finalConfig,
          unresolved: [],
          detections: {
            remote: remoteDetection,
            integrationBranch: branchDetection,
            verification: verificationDetection,
            tracker: trackerDetection,
            delivery: deliveryDetection,
            repo: repoState,
          },
        };
      }
    } catch {
      // Fall through and surface the unresolved list — the composer
      // never throws; it converts discovery failures into unresolved
      // entries on `result.unresolved`.
    }
  }

  return {
    unresolved,
    detections: {
      remote: remoteDetection,
      integrationBranch: branchDetection,
      verification: verificationDetection,
      tracker: trackerDetection,
      delivery: deliveryDetection,
      repo: repoState,
    },
  };
}

function detectRemote(
  draft: PoiesisConfig | undefined,
  remoteNames: string[],
  remoteUrls: Map<string, string>,
): RemoteDetection {
  const explicit = draft?.repository?.remote;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const url = remoteUrls.get(explicit);
    return { name: explicit, source: "explicit", ...(url === undefined ? {} : { url }) };
  }
  if (remoteNames.includes("origin")) {
    const url = remoteUrls.get("origin");
    return { name: "origin", source: "git-origin", ...(url === undefined ? {} : { url }) };
  }
  if (remoteNames.length === 1) {
    const only = remoteNames[0]!;
    const url = remoteUrls.get(only);
    return { name: only, source: "git-singleton", ...(url === undefined ? {} : { url }) };
  }
  if (remoteNames.length === 0) {
    return { source: "none" };
  }
  return { source: "ambiguous", alternates: [...remoteNames].sort() };
}

async function detectIntegrationBranch(
  draft: PoiesisConfig | undefined,
  root: string,
  resolvedRemote: string | undefined,
): Promise<BranchDetection> {
  const explicit = draft?.repository?.integrationBranch;
  if (explicit !== undefined && explicit.trim().length > 0) {
    return { name: explicit, source: "explicit" };
  }
  const branches = await runChildProcess(
    "git",
    ["branch", "--format=%(refname:short)"],
    { cwd: root, allowFailure: true },
  );
  const localBranches = branches.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (localBranches.includes("main")) return { name: "main", source: "git-local-main" };
  if (resolvedRemote !== undefined) {
    const fetched = await runChildProcess(
      "git",
      ["ls-remote", "--exit-code", "--heads", resolvedRemote, "refs/heads/main"],
      { cwd: root, allowFailure: true },
    );
    if (fetched.exitCode === 0) return { name: "main", source: "git-remote-main" };
  }
  if (localBranches.length === 1) {
    return { name: localBranches[0]!, source: "git-local-fallback" };
  }
  if (localBranches.length > 1) {
    return { source: "ambiguous" };
  }
  return { source: "none" };
}

async function discoverPackageScripts(root: string): Promise<string[]> {
  const packageJsonPath = join(root, "package.json");
  if (!(await exists(packageJsonPath))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  const record = scripts as Record<string, unknown>;
  const out: string[] = [];
  for (const name of ["test", "lint", "typecheck", "build"]) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  return out;
}

async function detectVerification(root: string, draft: PoiesisConfig | undefined): Promise<VerificationDetection> {
  const explicit = draft?.verification?.commands ?? [];
  if (explicit.length > 0) return { commands: [...explicit], source: "explicit" };
  const discovered = await discoverPackageScripts(root);
  if (discovered.length > 0) {
    return { commands: discovered, source: "package-scripts" };
  }
  return { commands: [], source: "none" };
}

async function detectTracker(
  draft: PoiesisConfig | undefined,
  remoteUrl: string | undefined,
): Promise<TrackerDetection> {
  const provider = draft?.tracker.provider;
  const explicitProject = draft?.tracker.project;
  if (provider !== undefined && explicitProject !== undefined && explicitProject.trim().length > 0) {
    return { provider, project: explicitProject, source: "explicit" };
  }
  if (
    provider !== undefined &&
    provider !== "fixture" &&
    (explicitProject === undefined || explicitProject.trim().length === 0) &&
    remoteUrl !== undefined
  ) {
    const parsed = parseTrackerFromUrl(remoteUrl);
    if (parsed !== null && parsed.provider === provider) {
      return {
        provider,
        project: parsed.project,
        source: parsed.provider === "github" ? "remote-github" : "remote-gitlab",
      };
    }
  }
  if (provider === "fixture") {
    return { provider, source: "missing" };
  }
  if (provider === "github" || provider === "gitlab") {
    return { provider, source: "missing" };
  }
  if (remoteUrl !== undefined) {
    const parsed = parseTrackerFromUrl(remoteUrl);
    if (parsed !== null) {
      return {
        provider: parsed.provider,
        project: parsed.project,
        source: parsed.provider === "github" ? "remote-github" : "remote-gitlab",
      };
    }
  }
  return { source: "missing" };
}

async function detectDelivery(draft: PoiesisConfig | undefined, root: string): Promise<DeliveryDetection> {
  const scriptsDir = join(root, "scripts");
  const hintPaths: Record<DeliveryTargetKey, string | null> = {
    preview: null,
    staging: null,
    production: null,
  };
  if (await exists(scriptsDir)) {
    let entries: string[] = [];
    try {
      entries = await readdir(scriptsDir);
    } catch {
      entries = [];
    }
    for (const target of DELIVERY_TARGETS) {
      const prefix = DELIVERY_SCRIPT_PREFIX[target];
      const matches = entries
        .filter((entry) => entry === prefix || entry.startsWith(`${prefix}.`))
        .sort();
      if (matches.length >= 1) {
        hintPaths[target] = `scripts/${matches[0]}`;
      }
    }
  }

  const detection: DeliveryDetection = { preview: null, staging: null, production: null };
  for (const target of DELIVERY_TARGETS) {
    const explicitConfig = draft?.delivery?.[target];
    if (explicitConfig !== undefined && !containsTemplatePlaceholder(explicitConfig)) {
      // Explicit non-template delivery wins over script hints.
      const source: DeliverySource = explicitConfig.adapter === "fixture"
        ? { kind: "fixture" }
        : { kind: "explicit" };
      detection[target] = {
        config: explicitConfig as DeliveryDetectionTarget["config"],
        source,
      };
      continue;
    }
    // Either no explicit entry OR an explicit entry that still carries
    // template placeholders (the canonical `POIESIS_CONFIG_TEMPLATE.jsonc`
    // shape). The composer treats both as "unresolved" and prefers a
    // present script hint; absent a hint, delivery stays unresolved.
    const hint = hintPaths[target];
    if (hint === null) {
      detection[target] = null;
      continue;
    }
    detection[target] = {
      config: { adapter: "command", command: [hint, "{sha}"] },
      source: { kind: "script", path: hint },
    };
  }
  return detection;
}

function containsTemplatePlaceholder(value: unknown): boolean {
  if (typeof value === "string") return /<[^>]+>/.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsTemplatePlaceholder(entry));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => containsTemplatePlaceholder(entry));
  }
  return false;
}

function replaceTemplateDelivery(
  original: ResolvedPoiesisConfig["delivery"][keyof ResolvedPoiesisConfig["delivery"]],
  detected: DeliveryDetectionTarget | null,
): ResolvedPoiesisConfig["delivery"][keyof ResolvedPoiesisConfig["delivery"]] {
  if (detected === null) return original;
  if (!containsTemplatePlaceholder(original)) return original;
  return detected.config;
}

async function inspectRepoState(root: string): Promise<RepoStateDetection> {
  let opencodeConfigPath: string | undefined;
  let opencodeConfigPresent = false;
  for (const relative of OPENCODE_CONFIG_RELATIVE_PATHS) {
    const candidate = join(root, relative);
    if (await exists(candidate)) {
      try {
        const details = await lstat(candidate);
        if (details.isFile() && !details.isSymbolicLink()) {
          opencodeConfigPath = relative;
          opencodeConfigPresent = true;
          break;
        }
      } catch {
        // ignore — caller treats absence uniformly
      }
    }
  }

  const manifestPath = join(root, POIESIS_MANIFEST_RELATIVE);
  let poiesisInstalled = false;
  let poiesisManifestVersion: string | undefined;
  if (await exists(manifestPath)) {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.poiesisVersion !== undefined) poiesisManifestVersion = String(record.poiesisVersion);
        poiesisInstalled = true;
      }
    } catch {
      poiesisInstalled = false;
    }
  }

  const state: RepoStateDetection = {
    opencodeConfigPresent,
    poiesisInstalled,
  };
  if (opencodeConfigPath !== undefined) state.opencodeConfigPath = opencodeConfigPath;
  if (poiesisManifestVersion !== undefined) state.poiesisManifestVersion = poiesisManifestVersion;
  return state;
}

async function listGitRemotes(root: string): Promise<string[]> {
  try {
    const result = await runChildProcess("git", ["remote"], { cwd: root, allowFailure: true });
    return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function readRemoteUrls(root: string, remoteNames: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (remoteNames.length === 0) return map;
  for (const name of remoteNames) {
    try {
      const result = await runChildProcess(
        "git",
        ["remote", "get-url", "--all", name],
        { cwd: root, allowFailure: true },
      );
      const first = result.stdout.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
      if (first !== undefined) map.set(name, first);
    } catch {
      // skip — leave absent
    }
  }
  return map;
}

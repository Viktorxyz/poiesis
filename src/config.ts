import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";
import { readUtf8 } from "./fs.js";
import { PoiesisError } from "./errors.js";
import { poiesisPath } from "./paths.js";
import { DELIVERY_TARGETS } from "./delivery-defaults.js";

const adapterTargetSchema = z
  .object({
    adapter: z.string().min(1),
  })
  .loose();

/**
 * Spec #139 / ticket #140 — tracker identity is a discriminated provider
 * union, independent of the Git hosting provider.
 *
 * `github` / `gitlab` keep the legacy shape (a repository coordinate that
 * may be inferred from the Git remote), `fixture` keeps its
 * authorization-gated external path, and `linear` / `local` are added as
 * first-class choices whose coordinates are stated in the config rather
 * than derived from the remote. `linear` carries only non-secret
 * team / project coordinates; its credential is environment-only and
 * therefore has no schema field here.
 *
 * Every branch stays `.loose()` so an existing installation's unknown
 * keys keep parsing exactly as before.
 */
export const TRACKER_PROVIDERS = ["github", "gitlab", "linear", "local", "fixture"] as const;
export type TrackerProviderId = (typeof TRACKER_PROVIDERS)[number];

const githubTrackerSchema = z
  .object({ provider: z.literal("github"), project: z.string().optional() })
  .loose();
const gitlabTrackerSchema = z
  .object({ provider: z.literal("gitlab"), project: z.string().optional() })
  .loose();
const linearTrackerSchema = z
  .object({
    provider: z.literal("linear"),
    team: z.string().optional(),
    project: z.string().optional(),
  })
  // Ticket #188: `.loose()` stays, so an existing installation's unknown,
  // non-secret keys keep parsing and a compatible extension key survives a
  // managed rewrite. The credential-bearing half of the environment-only
  // boundary is a SEMANTIC refusal (`assertLinearTrackerCredentials`), not a
  // strict schema, so no supported field is ever silently dropped.
  .loose();
const localTrackerSchema = z.object({ provider: z.literal("local") }).loose();
const fixtureTrackerSchema = z
  .object({ provider: z.literal("fixture"), project: z.string().optional() })
  .loose();

export const trackerConfigSchema = z.discriminatedUnion("provider", [
  githubTrackerSchema,
  gitlabTrackerSchema,
  linearTrackerSchema,
  localTrackerSchema,
  fixtureTrackerSchema,
]);

/**
 * Spec #139 / ticket #140 — explicit deferred delivery.
 *
 * Deferral is a MODE, never a fixture, a command placeholder, a no-op
 * adapter, or a lifecycle profile. The only two honest states are: three
 * complete targets, or `{ mode: "deferred" }` with no target at all. A
 * config that mixes the two, or that supplies only some of the three
 * targets, is a partial shape and fails with a typed error rather than
 * being silently completed.
 *
 * Ticket #152 — both branches are EXTENSIBLE at the outer delivery level,
 * exactly like every other Poiesis block: an unknown key (a newer runtime's
 * extension, or an Author's own annotation) survives parse and serialize, so
 * a runtime that does not recognize a key never silently deletes it from the
 * managed `.poiesis/config.jsonc` on its next rewrite. This is a
 * compatibility relaxation ONLY — the semantic rejections in
 * `assertDeliveryShape` (a partial target set, an unknown `mode`, and a
 * deferred block that also carries a target) are unchanged and still run
 * before the schema result is reported.
 */
export const DEFERRED_DELIVERY_MODE = "deferred";

export const deferredDeliverySchema = z.object({ mode: z.literal(DEFERRED_DELIVERY_MODE) }).loose();
export const configuredDeliverySchema = z
  .object({
    preview: adapterTargetSchema,
    staging: adapterTargetSchema,
    production: adapterTargetSchema,
  })
  .loose();
export const deliveryConfigSchema = z.union([deferredDeliverySchema, configuredDeliverySchema]);

export type DeliveryTargetConfig = z.infer<typeof adapterTargetSchema>;

/**
 * Spec #139 / ticket #153 — the extension keys an outer `delivery` block
 * may carry: anything Poiesis does not own.
 *
 * The zod schemas above are `.loose()`, so `PoiesisConfig` already REPRESENTS
 * an extension key on the way in (ticket #152). The resolved types had to
 * represent it too, or the value that init / `update --config` serialize was
 * typed as if it had already lost the key and a future reconstruction step
 * would be told it was safe to drop it. `unknown` is the honest value: Poiesis
 * neither interprets nor validates an extension, it only carries it.
 */
export type DeliveryExtensions = { readonly [key: string]: unknown };

export type DeferredDeliveryConfig = { mode: typeof DEFERRED_DELIVERY_MODE } & DeliveryExtensions;
export type ConfiguredDeliveryConfig = {
  preview: DeliveryTargetConfig;
  staging: DeliveryTargetConfig;
  production: DeliveryTargetConfig;
} & DeliveryExtensions;
export type ResolvedDeliveryConfig = DeferredDeliveryConfig | ConfiguredDeliveryConfig;

/**
 * The resolved tracker is a discriminated union too, so every consumer
 * that needs a repository coordinate has to narrow the provider instead of
 * reading an optional field that may silently be absent.
 */
export type ResolvedTrackerConfig =
  | { provider: "github" | "gitlab"; project: string }
  | { provider: "linear"; team: string; project?: string }
  | { provider: "local" }
  | { provider: "fixture"; project: string };

export function isDeferredDelivery(
  delivery: ResolvedDeliveryConfig | PoiesisConfig["delivery"],
): delivery is DeferredDeliveryConfig {
  return (
    typeof delivery === "object" &&
    delivery !== null &&
    (delivery as { mode?: unknown }).mode === DEFERRED_DELIVERY_MODE
  );
}

/**
 * Spec #139 / ticket #143 — the remediation every `DELIVERY_DEFERRED` failure
 * names. One string, shared by the resolved-config access point and the
 * lifecycle-policy guard, so an Author reads the same actionable instruction
 * whichever seam refused.
 */
export const DELIVERY_DEFERRED_REMEDIATION =
  "Replace the deferred mode with the three delivery targets in .poiesis/config.jsonc " +
  "(delivery.preview, delivery.staging, delivery.production) and apply the change with " +
  "`poiesis update --config <file>`; until then this operation stays blocked.";

/**
 * The one typed `DELIVERY_DEFERRED` error. Every blocked operation is
 * reported by name together with its remediation, so a refusal is actionable
 * without reading the source.
 */
export function deliveryDeferredError(operation: string): PoiesisError {
  return new PoiesisError(
    "DELIVERY_DEFERRED",
    `Delivery is explicitly deferred; ${operation} cannot run until delivery is configured`,
    { mode: DEFERRED_DELIVERY_MODE, operation, remediation: DELIVERY_DEFERRED_REMEDIATION },
  );
}

/**
 * The single fail-closed access point for code that needs a real delivery
 * target. Throws a typed `DELIVERY_DEFERRED` error naming the blocked
 * operation, so a deferred install can never construct a fake target, a
 * placeholder adapter, or synthetic evidence.
 */
export function requireConfiguredDelivery(
  delivery: ResolvedDeliveryConfig | PoiesisConfig["delivery"],
  operation: string,
): ConfiguredDeliveryConfig {
  if (delivery === undefined) {
    throw new PoiesisError(
      "DELIVERY_DEFERRED",
      `Delivery is not configured; ${operation} cannot run until delivery is configured`,
      { mode: null, operation, remediation: DELIVERY_DEFERRED_REMEDIATION },
    );
  }
  if (isDeferredDelivery(delivery)) {
    throw deliveryDeferredError(operation);
  }
  return delivery;
}

/**
 * Read the repository coordinate of a tracker without assuming a provider.
 * Only the forge and fixture branches carry one; `linear` and `local` have
 * no repository coordinate at all, which is exactly why publishing cannot
 * be derived from tracker identity.
 */
export function trackerProjectOf(tracker: { provider: string; project?: unknown }): string | undefined {
  return typeof tracker.project === "string" ? tracker.project : undefined;
}

export const configSchema = z.strictObject({
  schema: z.literal(1),
  models: z
    .strictObject({
      reasoning: z.string().regex(/^[^/]+\/.+$/, "must use provider/model format"),
      execution: z.string().regex(/^[^/]+\/.+$/, "must use provider/model format"),
      roles: z.record(z.string(), z.string()).optional(),
    }),
  repository: z
    .strictObject({
      remote: z.string().optional(),
      integrationBranch: z.string().optional(),
    })
    .optional(),
  // Spec #138: optional. Provider and project are inferred from the Git
  // remote (github.com -> github, gitlab.com -> gitlab) plus its URL path, so
  // a fresh project does not have to state them. An Author who does state them
  // keeps them. Spec #139 / ticket #140: the shape is now a discriminated
  // union so `linear` and `local` are first-class choices that are NOT
  // inferred from the remote and never stand in for a Git host.
  tracker: trackerConfigSchema.optional(),
  // Spec #138: optional. A fresh project should not have to hand-write three
  // delivery commands before `poiesis init` will start; init writes working
  // `scripts/poiesis-<target>.mjs` files and resolves the config to them.
  // Spec #139 / ticket #140: an omitted block keeps that legacy behavior; an
  // explicitly deferred install states `{ mode: "deferred" }` instead.
  delivery: deliveryConfigSchema.optional(),
  verification: z
    .strictObject({
      commands: z.array(z.string().min(1)).optional(),
      postIntegrationCommands: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export type PoiesisConfig = z.infer<typeof configSchema>;
export type ResolvedPoiesisConfig = {
  schema: 1;
  models: { reasoning: string; execution: string; roles?: Record<string, string> };
  repository: { remote: string; integrationBranch: string };
  tracker: ResolvedTrackerConfig;
  delivery: ResolvedDeliveryConfig;
  verification: { commands: string[]; postIntegrationCommands?: string[] };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ticket #140 — the `delivery` sub-object is either three complete
 * targets or an explicit `{ mode: "deferred" }`. Every other shape is a
 * partial/ambiguous delivery state, and a generic `INVALID_CONFIG` union
 * issue is not an actionable message for an Author. This check runs before
 * the schema result is reported so the failure names the exact missing or
 * contradictory field and never invents a target to fill the gap.
 */
function assertDeliveryShape(value: unknown): void {
  if (!isRecord(value)) return;
  if (value.mode !== undefined) {
    if (value.mode !== DEFERRED_DELIVERY_MODE) {
      throw new PoiesisError(
        "INVALID_DELIVERY_CONFIG",
        `delivery.mode must be "${DEFERRED_DELIVERY_MODE}"; omit delivery entirely, configure all three targets, or state the deferred mode`,
        { mode: value.mode, supported: [DEFERRED_DELIVERY_MODE] },
      );
    }
    const mixed = DELIVERY_TARGETS.filter((target) => value[target] !== undefined);
    if (mixed.length > 0) {
      throw new PoiesisError(
        "INVALID_DELIVERY_CONFIG",
        `delivery is deferred, so no target may be configured; remove ${mixed.join(", ")} or drop "mode" and configure all three targets`,
        { mode: DEFERRED_DELIVERY_MODE, mixedTargets: [...mixed] },
      );
    }
    return;
  }
  const missing = DELIVERY_TARGETS.filter((target) => value[target] === undefined);
  if (missing.length > 0) {
    throw new PoiesisError(
      "INVALID_DELIVERY_CONFIG",
      `delivery must configure all three targets or state "mode": "${DEFERRED_DELIVERY_MODE}"; missing ${missing.join(", ")}`,
      { missing: [...missing] },
    );
  }
  for (const target of DELIVERY_TARGETS) {
    const configured = value[target];
    if (!isRecord(configured) || typeof configured.adapter !== "string" || configured.adapter.length === 0) {
      throw new PoiesisError(
        "INVALID_DELIVERY_CONFIG",
        `delivery.${target} must configure a delivery adapter; defer the whole block with "mode": "${DEFERRED_DELIVERY_MODE}" instead of deferring one target`,
        { target, mode: DEFERRED_DELIVERY_MODE },
      );
    }
  }
}

/**
 * Ticket #140 — the `tracker` sub-object must name one of the supported
 * providers. An unknown or absent provider is reported with the supported
 * list so an Author can act on it directly, instead of as an opaque
 * `invalid_union` discriminator failure.
 */
function assertTrackerShape(value: unknown): void {
  if (!isRecord(value)) return;
  if (typeof value.provider !== "string" || !TRACKER_PROVIDERS.includes(value.provider as TrackerProviderId)) {
    throw new PoiesisError(
      "INVALID_TRACKER_CONFIG",
      `tracker.provider must be one of: ${TRACKER_PROVIDERS.join(", ")}`,
      { provider: value.provider ?? null, supported: [...TRACKER_PROVIDERS] },
    );
  }
}

/**
 * Spec #139 / ticket #188 — the key forms that make a Linear tracker field
 * CREDENTIAL-BEARING. A Linear credential is an API key, an OAuth token, an
 * `Authorization` value, a secret, or a password; none of them belongs in a
 * config file, and Poiesis reads them only from the environment.
 *
 * The comparison is on the NORMALIZED key — lowercased with every non
 * alphanumeric character removed — so `apiKey`, `api_key`, `API-KEY`, and
 * `LINEAR_API_KEY` are one form, as are `oauthToken`, `access_token`, and
 * `bearerToken`. Matching is a substring test because a credential-bearing
 * field is spelled differently by every tool and integration; the alternative,
 * an exact-name list, would be a list an author walks around.
 *
 * The rule deliberately errs toward refusal — `auth` covers the whole
 * `Authorization` / `authentication` family rather than one spelling of it —
 * because the cost of naming one credential-bearing field here is an Author who
 * renames it, and the cost of missing one is a secret in a managed config file.
 * It applies to the `linear` tracker block ONLY: another provider's block, and
 * a delivery target's own `env` record, are separate contracts this rule does
 * not judge.
 */
const LINEAR_CREDENTIAL_KEY_FORMS = [
  "apikey",
  "token",
  "auth",
  "secret",
  "password",
  "passwd",
  "credential",
  "bearer",
  "privatekey",
] as const;

function normalizeConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCredentialBearingKey(key: string): boolean {
  const normalized = normalizeConfigKey(key);
  return LINEAR_CREDENTIAL_KEY_FORMS.some((form) => normalized.includes(form));
}

/**
 * Every credential-bearing field path inside a value, as `tracker.apiKey` or
 * `tracker.extension[0].bearer`. The walk descends through nested extension
 * values because the boundary is the whole config block Poiesis would persist,
 * not only its top-level keys; VALUES are never inspected, so an extension that
 * merely mentions a credential in prose is unaffected. A key that is itself
 * credential-bearing is named and NOT descended into, so the reported path is
 * the field an Author has to remove. `seen` makes a shared or cyclic structure
 * terminate instead of recursing forever.
 */
function credentialBearingFields(value: unknown, prefix: string, seen: Set<object>): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => credentialBearingFields(entry, `${prefix}[${index}]`, seen));
  }
  if (!isRecord(value) || seen.has(value)) return [];
  seen.add(value);
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (isCredentialBearingKey(key)) {
      found.push(path);
      continue;
    }
    found.push(...credentialBearingFields(entry, path, seen));
  }
  return found;
}

/**
 * Ticket #188 — the `linear` branch stays `.loose()` on purpose: an existing
 * installation's unknown, non-secret keys keep parsing exactly as before, and
 * an Author's own annotation survives. What `.loose()` also allowed was a
 * credential key riding along into `.poiesis/config.jsonc`, where
 * `serializeConfig` then preserved it — so the environment-only boundary was
 * decided by how the field happened to be spelled.
 *
 * This is the refusal that closes it, and it runs BEFORE the schema result is
 * reported and BEFORE any managed rewrite serializes a config, so a
 * credential-bearing Linear field is never validated into the managed config
 * and never written to it. `provider`, `team`, `project`, and every compatible
 * non-secret extension key are untouched: the boundary is refined, not widened
 * into a strict schema that would silently drop fields.
 */
function assertLinearTrackerCredentials(value: unknown): void {
  if (!isRecord(value) || value.provider !== "linear") return;
  const credentialFields = credentialBearingFields(value, "tracker", new Set());
  if (credentialFields.length === 0) return;
  throw new PoiesisError(
    "INVALID_TRACKER_CONFIG",
    `${credentialFields.join(", ")} would store a Linear credential in the Poiesis config; Linear credentials are read from the environment and must never be stored there. Remove ${credentialFields.length === 1 ? "that field" : "those fields"} and set the credential in the environment instead`,
    { provider: "linear", credentialFields, environmentOnly: true },
  );
}

export function parseJsonc<T>(content: string, source: string): T {
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false }) as T;
  if (errors.length > 0) {
    throw new PoiesisError("INVALID_JSONC", `Invalid JSONC in ${source}`, {
      errors: errors.map((error) => ({
        code: printParseErrorCode(error.error),
        offset: error.offset,
        length: error.length,
      })),
    });
  }
  return value;
}

export function validateConfig(value: unknown, source: string): PoiesisConfig {
  if (isRecord(value)) {
    assertTrackerShape(value.tracker);
    // Ticket #188: a credential-bearing Linear field is refused before the
    // schema result is reported, so it can never be validated into a config
    // `serializeConfig` would persist.
    assertLinearTrackerCredentials(value.tracker);
    assertDeliveryShape(value.delivery);
  }
  const result = configSchema.safeParse(value);
  if (!result.success) {
    throw new PoiesisError("INVALID_CONFIG", `Invalid Poiesis config in ${source}`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

export async function loadConfig(root: string): Promise<PoiesisConfig> {
  const path = poiesisPath(root, "config.jsonc");
  return validateConfig(parseJsonc(await readUtf8(path), path), path);
}

/**
 * Ticket #188 — serialization is the LAST point at which a credential-bearing
 * Linear field could enter the managed `.poiesis/config.jsonc`, so it refuses
 * too. Validation already rejects such a config, but a value can reach
 * `serializeConfig` from an in-memory resolution or a caller's own object
 * without having passed through `validateConfig`; refusing at both points
 * means the write cannot happen even then, and it is a refusal rather than a
 * silent drop — a config that silently lost `apiKey` would report a healthy
 * installation whose credential is nowhere.
 */
export function serializeConfig(config: PoiesisConfig): string {
  if (isRecord(config)) assertLinearTrackerCredentials(config.tracker);
  return `${JSON.stringify(config, null, 2)}\n`;
}

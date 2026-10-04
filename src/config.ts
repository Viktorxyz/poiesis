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
 */
export const DEFERRED_DELIVERY_MODE = "deferred";

export const deferredDeliverySchema = z.strictObject({ mode: z.literal(DEFERRED_DELIVERY_MODE) });
export const configuredDeliverySchema = z.strictObject({
  preview: adapterTargetSchema,
  staging: adapterTargetSchema,
  production: adapterTargetSchema,
});
export const deliveryConfigSchema = z.union([deferredDeliverySchema, configuredDeliverySchema]);

export type DeliveryTargetConfig = z.infer<typeof adapterTargetSchema>;
export type DeferredDeliveryConfig = { mode: typeof DEFERRED_DELIVERY_MODE };
export type ConfiguredDeliveryConfig = {
  preview: DeliveryTargetConfig;
  staging: DeliveryTargetConfig;
  production: DeliveryTargetConfig;
};
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

export function serializeConfig(config: PoiesisConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";
import { readUtf8 } from "./fs.js";
import { PoiesisError } from "./errors.js";
import { poiesisPath } from "./paths.js";

const adapterTargetSchema = z
  .object({
    adapter: z.string().min(1),
  })
  .loose();

export const configSchema = z.strictObject({
  schema: z.literal(1),
  /**
   * Spec #190 / ticket #191 — the installation mode.
   *
   * Optional in the SCHEMA so every pre-Spec #190 config still parses
   * (legacy installs must stay operable), and REQUIRED by `init`, which
   * is where a sharing policy is actually chosen. A non-interactive
   * `poiesis init --config` therefore cannot install without stating it
   * explicitly, which is the whole point of the decision.
   */
  mode: z.enum(["private", "team"]).optional(),
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
  // keeps them.
  tracker: z
    .object({
      provider: z.enum(["github", "gitlab", "fixture"]),
      project: z.string().optional(),
    })
    .loose()
    .optional(),
  // Spec #138: optional. A fresh project should not have to hand-write three
  // delivery commands before `poiesis init` will start; init writes working
  // `scripts/poiesis-<target>.mjs` files and resolves the config to them.
  delivery: z
    .strictObject({
      preview: adapterTargetSchema,
      staging: adapterTargetSchema,
      production: adapterTargetSchema,
    })
    .optional(),
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
  mode?: "private" | "team";
  models: { reasoning: string; execution: string; roles?: Record<string, string> };
  repository: { remote: string; integrationBranch: string };
  tracker: { provider: "github" | "gitlab" | "fixture"; project: string };
  delivery: NonNullable<PoiesisConfig["delivery"]>;
  verification: { commands: string[]; postIntegrationCommands?: string[] };
};

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

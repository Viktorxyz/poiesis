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
  models: z
    .strictObject({
      reasoning: z.string().regex(/^[^/]+\/.+$/, "must use provider/model format"),
      execution: z.string().regex(/^[^/]+\/.+$/, "must use provider/model format"),
      roles: z.record(z.string(), z.string()).optional(),
    }),
  repository: z.strictObject({
    remote: z.string().min(1),
    integrationBranch: z.string().min(1),
  }),
  tracker: z
    .object({
      provider: z.enum(["github", "gitlab", "fixture"]),
      project: z.string().min(1),
    })
    .loose(),
  delivery: z.strictObject({
    preview: adapterTargetSchema,
    staging: adapterTargetSchema,
    production: adapterTargetSchema,
  }),
  verification: z
    .strictObject({
      commands: z.array(z.string().min(1)).min(1),
      postIntegrationCommands: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export type PoiesisConfig = z.infer<typeof configSchema>;

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

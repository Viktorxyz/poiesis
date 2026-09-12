import { applyEdits, modify } from "jsonc-parser";
import { relative } from "node:path";
import { parseJsonc } from "./config.js";
import type { ConfigPatch } from "./manifest.js";

type JsonObject = Record<string, unknown>;

/**
 * One desired mutation the caller wants applied to the OpenCode config,
 * expressed as a JSON-pointer-like path. This is the same shape
 * `desiredOpenCodePatches(config)` returns from `src/opencode.ts`.
 */
export interface OpenCodeDesiredPatch {
  path: string[];
  value: unknown;
}

export interface ProjectOpenCodePayloadInput {
  root: string;
  configPath: string;
  currentContent: string;
  patches: OpenCodeDesiredPatch[];
}

export interface ProjectOpenCodePayloadResult {
  serialized: string;
  configPatches: ConfigPatch[];
}

function getAtPathLocal(value: unknown, path: string[]): { exists: boolean; value?: unknown } {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return { exists: false };
    current = (current as JsonObject)[part];
  }
  return { exists: true, value: current };
}

/**
 * Pure, deterministic projection of the OpenCode config payload.
 *
 * The helper takes the OpenCode config bytes currently on disk (or the
 * seed bytes for a fresh file) and the desired patches, and returns the
 * exact serialized payload plus the `ConfigPatch[]` provenance that
 * should be atomically written. It performs NO filesystem work, so
 * install-time `applyOpenCodeConfig` AND transaction-time preflight in
 * `runUpdateConfigTransaction` can call it byte-for-byte with the same
 * arguments and observe the same payload. The serialized output matches
 * the previous inline projection in `applyOpenCodeConfig` byte-for-byte
 * (same `formattingOptions`, same trailing newline normalization) so the
 * preflight's serialized bytes can be asserted equal to the post-apply
 * `onWritten` callback bytes deterministically before manifest write.
 */
export function projectOpenCodePayload(input: ProjectOpenCodePayloadInput): ProjectOpenCodePayloadResult {
  const relativeFile = relative(input.root, input.configPath);
  let content = input.currentContent;
  const original = parseJsonc<JsonObject>(input.currentContent, input.configPath);
  const configPatches: ConfigPatch[] = [];
  for (const desired of input.patches) {
    const previous = getAtPathLocal(original, desired.path);
    configPatches.push({
      file: relativeFile,
      path: desired.path,
      previousExists: previous.exists,
      ...(previous.exists ? { previous: previous.value } : {}),
      installed: desired.value,
    });
    content = applyEdits(
      content,
      modify(content, desired.path, desired.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  }
  const serialized = content.endsWith("\n") ? content : `${content}\n`;
  return { serialized, configPatches };
}

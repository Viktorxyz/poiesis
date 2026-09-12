import { applyEdits, modify } from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";
import { relative } from "node:path";
import { parseJsonc } from "./config.js";
import { PoiesisError } from "./errors.js";
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
 * arguments and observe the same payload.
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

/**
 * Pure ownership check: every manifest `ConfigPatch` for the OpenCode
 * file must observe its `installed` value at `parsedSnapshot.patch.path`.
 *
 * Replaces the disk-re-reading path inside the maintenance
 * `assertConfigPatchesOwned` helper for the OpenCode config specifically.
 * Callers MUST pass the same parsed snapshot they captured once when
 * reading the OpenCode config bytes; this helper performs no I/O and
 * produces the same `CONFIG_OWNERSHIP_LOST` semantics for a foreign or
 * missing value at any recorded path.
 *
 * Patches with a `file` other than `openCodeRelativeFile` are ignored
 * (the caller must pre-filter by file if it stores patches for multiple
 * managed files in one call). The `root` parameter is used only for
 * error-message paths so callers can map the `file` field back to a
 * stable, canonical relative path.
 */
export function assertOpenCodeOwnershipAgainstSnapshot(args: {
  root: string;
  configPath: string;
  parsedSnapshot: JsonObject;
  patches: ConfigPatch[];
}): void {
  const relativeFile = relative(args.root, args.configPath);
  for (const patch of args.patches) {
    if (patch.file !== relativeFile) continue;
    const value = getAtPathLocal(args.parsedSnapshot, patch.path);
    if (!value.exists || !isDeepStrictEqual(value.value, patch.installed)) {
      throw new PoiesisError("CONFIG_OWNERSHIP_LOST", "Managed OpenCode config value was changed", {
        file: patch.file,
        path: patch.path,
      });
    }
  }
}

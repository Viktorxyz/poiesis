import { parseTree, type Node as JsonNode } from "jsonc-parser";
import { PoiesisError } from "./errors.js";

/**
 * Internal-only OpenCode config validators. These helpers are owned by
 * the transaction surfaces that read the OpenCode config bytes
 * (`runUpdateTransaction` in `src/update-internal.ts`,
 * `runUpdateConfigTransaction` in `src/update-config-internal.ts`); they
 * are NOT re-exported from `src/opencode.js` and therefore NOT picked
 * up by the `export * from "./opencode.js"` line in `src/index.ts`.
 * `src/index.ts::opencode.js` re-export exposes the user-facing OpenCode
 * helpers (config path detection, version gating, patch projection
 * schema, adapter version) — none of the internal validators leak.
 *
 * The duplicate-property check is the existing canonical recursive
 * JSONC validator (init-side callers reach the same helper via
 * `assertOpenCodeContentAvailable` in `src/opencode.ts`). Both call
 * sites throw the same `INSTALL_PATH_CONFLICT` code with the same
 * `{ file, property }` detail shape.
 */
export function assertNoDuplicateProperties(content: string, configPath: string): void {
  const root = parseTree(content);
  function visit(node: JsonNode): void {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (typeof key === "string") {
          if (keys.has(key)) {
            throw new PoiesisError("INSTALL_PATH_CONFLICT", "OpenCode config contains duplicate properties", {
              file: configPath,
              property: key,
            });
          }
          keys.add(key);
        }
        const value = property.children?.[1];
        if (value !== undefined) visit(value);
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  }
  if (root !== undefined) visit(root);
}

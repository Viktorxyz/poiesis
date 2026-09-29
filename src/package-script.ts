import { lstat, readFile, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type FormattingOptions,
  type Node,
} from "jsonc-parser";
import { parseJsonc } from "./config.js";
import { PoiesisError } from "./errors.js";
import { atomicWrite } from "./fs.js";
import { hashFile } from "./hash.js";

/**
 * Spec #133 / ticket #134 — the `pnpm poiesis <command>` project script.
 *
 * `package.json` is an Author-owned file. Poiesis performs exactly ONE
 * bounded, reversible edit to it: a single `scripts.poiesis` entry. The
 * mechanism is the `.gitignore` precedent from `src/templates.ts` /
 * `src/maintenance.ts` — a read-only pre-flight guard before any write,
 * a snapshot + written-hash-gated bespoke rollback, no manifest record
 * and no mutation-journal entry.
 *
 * The edit itself is `jsonc-parser`'s `modify` + `applyEdits`, the same
 * minimal-text-edit mechanism the OpenCode config projection already
 * uses. Every existing property keeps its EXACT source bytes and its
 * exact position, which `assertByteMinimalScriptEdit` checks rather than
 * assumes. One qualification: when `scripts` is written inline
 * (`"scripts": { "build": "tsc" },`) the widened format range is the
 * whole line, so that object is reflowed to multi-line. No property's
 * bytes or order change — only the line layout — which is why the guard
 * permits it.
 */

/** The single source of truth for the script key. */
export const POIESIS_SCRIPT_NAME = "poiesis";

/**
 * The single source of truth for the expected script value.
 *
 * `@latest` is an explicit Author decision: `update` is the command that
 * works across a version drift, so the Author is never asked to type one.
 * The agent's exact-version launcher in the OpenCode config is a separate,
 * unchanged surface.
 *
 * The `--config.dlx-cache-max-age=0` bypass is NOT optional: pnpm caches
 * `dlx` resolutions for ~1440 minutes, so the bare form can silently serve
 * a stale resolution. The flag lives in `package.json`, where the Author
 * cannot forget it and never has to type it.
 */
export const POIESIS_SCRIPT_COMMAND = "pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest";

/** Repo-relative name of the Author-owned file. */
export const PACKAGE_JSON_RELATIVE = "package.json";
const SCRIPTS_SEGMENT = "scripts";
/** The JSON path reported in every typed `PACKAGE_SCRIPT_CONFLICT` error. */
const POIESIS_SCRIPT_PATH: readonly string[] = [SCRIPTS_SEGMENT, POIESIS_SCRIPT_NAME];

/**
 * `details` key convention in this module, so the three shapes are not
 * mistaken for drift:
 *   - `path: string[]` — a JSON pointer INTO `package.json`
 *     (`PACKAGE_SCRIPT_CONFLICT`, the `scripts` shape check).
 *   - `path: string` — a repo-relative FILE name, used ONLY for
 *     `INSTALL_PATH_CONFLICT`, matching the repo-wide convention in
 *     `assertGitignoreAvailable` / `assertInitDestinationsAbsent`.
 *   - `file: string` — a repo-relative file name for this module's own
 *     codes (`INVALID_PACKAGE_JSON`, `PACKAGE_SCRIPT_REFORMAT_REFUSED`).
 */

type JsonObject = Record<string, unknown>;

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  const details = await lstat(path);
  return details.isFile() && !details.isSymbolicLink();
}

async function assertSafeParents(root: string, destination: string): Promise<void> {
  const parts = relative(root, destination).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if ((await pathEntryExists(current)) && (await lstat(current)).isSymbolicLink()) {
      throw new PoiesisError("UNSAFE_MANAGED_PATH", "Refusing to traverse a symlinked managed parent", {
        path: relative(root, current),
      });
    }
  }
}

function getAtPath(value: unknown, path: readonly string[]): { exists: boolean; value?: unknown } {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return { exists: false };
    current = (current as JsonObject)[part];
  }
  return { exists: true, value: current };
}

/**
 * Read and validate the Author's `package.json` document. A parse
 * failure is a typed error and fails closed: Poiesis never rewrites a
 * document it cannot fully understand.
 *
 * The `scripts` shape is validated here too, so a non-object `scripts`
 * value ("x", `null`, `[]`, a number) is reported as a typed
 * `INVALID_PACKAGE_JSON` from the read-only pre-flight. Left to
 * `jsonc-parser` it escapes as a bare `Error('Can not add property to
 * parent of type ...')` and surfaces as `UNEXPECTED` — and only after
 * the OpenCode config and `.gitignore` have already been written.
 */
function parsePackageJson(content: string, path: string): JsonObject {
  const document = parseJsonc<unknown>(content, path);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    // `details.path` is reserved for a JSON pointer (see `ConfigPatch.path`
    // in `src/manifest.ts`). A file NAME goes in `details.file`, so a
    // consumer can always `details.path?.join(".")`.
    throw new PoiesisError("INVALID_PACKAGE_JSON", "package.json is not a JSON object", { file: PACKAGE_JSON_RELATIVE });
  }
  const record = document as JsonObject;
  if (Object.hasOwn(record, SCRIPTS_SEGMENT)) {
    const scripts = record[SCRIPTS_SEGMENT];
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
      throw new PoiesisError("INVALID_PACKAGE_JSON", "package.json \"scripts\" is not a JSON object", {
        path: [SCRIPTS_SEGMENT],
      });
    }
  }
  return record;
}

/**
 * Read the exact preimage bytes of the Author's `package.json`, enforcing
 * the same safe-parent / regular-file / valid-UTF-8 guards
 * `assertGitignoreAvailable` applies to `.gitignore`.
 */
async function readPackageJsonBytes(root: string): Promise<{ path: string; bytes: Buffer } | null> {
  const path = join(root, PACKAGE_JSON_RELATIVE);
  await assertSafeParents(root, path);
  if (!(await pathEntryExists(path))) return null;
  if (!(await isRegularFile(path))) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "package.json is not a regular file", {
      path: PACKAGE_JSON_RELATIVE,
    });
  }
  const bytes = await readFile(path);
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "package.json is not valid UTF-8", {
      path: PACKAGE_JSON_RELATIVE,
    });
  }
  return { path, bytes };
}

/**
 * The ONE definition of the conflict rule, shared by the read-only
 * pre-flight and the refusing writer so they can never disagree.
 *
 * Acceptance #4 makes "never overwrite the Author's `poiesis` script" a
 * property of `init`; acceptance #7 makes "restore a drifted value" a
 * property of the update transactions. Both are Spec requirements, so the
 * choice is exposed as two NAMED entry points rather than a string a
 * caller can pass the wrong way round.
 */
function assertNoConflictingPoiesisScript(document: JsonObject): void {
  const existing = getAtPath(document, POIESIS_SCRIPT_PATH);
  if (existing.exists && existing.value !== POIESIS_SCRIPT_COMMAND) {
    throw new PoiesisError("PACKAGE_SCRIPT_CONFLICT", "package.json already defines a different poiesis script", {
      path: [...POIESIS_SCRIPT_PATH],
    });
  }
}

/**
 * READ-ONLY pre-flight guard for the package-script transaction.
 *
 * Mirrors `assertGitignoreAvailable`: assert safe parents, assert the
 * path is a regular file (not a symlink), assert the content is valid
 * JSON, and fail closed on an existing `scripts.poiesis` that differs
 * from the expected value. Read-only twin of
 * `ensurePoiesisScriptRefusing`.
 *
 * Returns `false` when the project has no `package.json` — that is NOT
 * an error. A project with no package manifest simply gets no script.
 *
 * The guard also runs the full edit PLAN — the same `planPoiesisScriptEdit`
 * the write site runs — and throws away its result, so a deterministic
 * `PACKAGE_SCRIPT_REFORMAT_REFUSED` surfaces BEFORE `opencode.jsonc` and
 * `.gitignore` are written instead of after a write-then-rollback cycle.
 * Strictly read-only; it writes nothing.
 */
export async function assertPoiesisScriptAvailable(root: string): Promise<boolean> {
  const present = await readPackageJsonBytes(root);
  if (present === null) return false;
  const content = present.bytes.toString("utf8");
  const document = parsePackageJson(content, present.path);
  assertNoConflictingPoiesisScript(document);
  // Run the plan for its typed failures ONLY; the planned content is
  // discarded and nothing is written. The conflict check above comes
  // first so an Author's own script is always reported by the Spec's
  // named `PACKAGE_SCRIPT_CONFLICT`, never shadowed by a reformat
  // refusal on the same file.
  planPoiesisScriptEdit(content, document, present.path);
  return true;
}

/**
 * Detect the Author's existing indentation so the inserted block does
 * not introduce mixed indentation. Tabs win over spaces (a line indented
 * with a tab is tab-indented); otherwise the width of the first nested
 * property line is the file's unit. 2-space is the fallback.
 */
function detectFormattingOptions(content: string): FormattingOptions {
  const lines = content.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const body = line.trimStart();
    // Only a property line tells us anything about indentation depth.
    if (body.length === 0 || !body.startsWith("\"")) continue;
    const indent = line.slice(0, line.length - body.length);
    if (indent.includes("\t")) return { insertSpaces: false, tabSize: 4, eol: "\n" };
    return { insertSpaces: true, tabSize: indent.length === 0 ? 2 : indent.length, eol: "\n" };
  }
  return { insertSpaces: true, tabSize: 2, eol: "\n" };
}

/**
 * The exact source bytes of every direct property of `object`, in
 * document order, minus the property named `exclude`. Comparing these
 * lists before and after the edit proves that no sibling region was
 * reformatted, reordered, or removed.
 */
function propertySourceSlices(content: string, object: Node | undefined, exclude: string): string[] {
  return (object?.children ?? [])
    .filter((property) => property.children?.[0]?.value !== exclude)
    .map((property) => content.slice(property.offset, property.offset + property.length));
}

/**
 * Fail closed unless the edit is byte-minimal with respect to the
 * Author's own regions.
 *
 * `jsonc-parser` narrows or widens its edit to whole lines before
 * formatting, so it CAN reformat content it merely passes over — a
 * single-line `package.json` is re-laid-out in full. This guard turns
 * any such non-minimal result into a typed refusal instead of a silent
 * rewrite of an Author-owned file. It is deliberately checked, not
 * assumed.
 */
function assertByteMinimalScriptEdit(before: string, after: string, path: string): void {
  // A result that no longer parses means the edit corrupted the document.
  const afterDocument = parseJsonc<unknown>(after, path);
  const afterTree = parseTree(after);
  if (afterTree === undefined || afterTree.type !== "object") {
    throw new PoiesisError("PACKAGE_SCRIPT_REFORMAT_REFUSED", "Refusing to rewrite a non-object package.json", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }
  const beforeTree = parseTree(before);
  const beforeScripts = beforeTree === undefined ? undefined : findNodeAtLocation(beforeTree, [SCRIPTS_SEGMENT]);
  const afterScripts = findNodeAtLocation(afterTree, [SCRIPTS_SEGMENT]);
  const rootPreserved = isDeepStrictEqual(
    propertySourceSlices(before, beforeTree, SCRIPTS_SEGMENT),
    propertySourceSlices(after, afterTree, SCRIPTS_SEGMENT),
  );
  const siblingsPreserved = isDeepStrictEqual(
    propertySourceSlices(before, beforeScripts, POIESIS_SCRIPT_NAME),
    propertySourceSlices(after, afterScripts, POIESIS_SCRIPT_NAME),
  );
  if (!rootPreserved || !siblingsPreserved) {
    throw new PoiesisError(
      "PACKAGE_SCRIPT_REFORMAT_REFUSED",
      "Refusing to write a package.json edit that would reformat existing entries",
      { file: PACKAGE_JSON_RELATIVE },
    );
  }
  // Post-condition: preserving the Author's bytes is necessary but not
  // sufficient — the edit must also have actually produced the script.
  // Without this, a no-op or mangled insert would be written, hashed,
  // and reported as a successful install with no `poiesis` script.
  if (getAtPath(afterDocument, POIESIS_SCRIPT_PATH).value !== POIESIS_SCRIPT_COMMAND) {
    throw new PoiesisError(
      "PACKAGE_SCRIPT_REFORMAT_REFUSED",
      "Refusing to write a package.json edit that did not produce the poiesis script",
      { file: PACKAGE_JSON_RELATIVE },
    );
  }
}

/**
 * Compute the post-edit `package.json` bytes without ever re-serialising
 * the whole document.
 *
 * The new entry is PREPENDED to `scripts`. `modify` widens a pure
 * insertion to whole lines and re-formats that range, so appending would
 * put the Author's LAST sibling on the re-formatted line and rewrite its
 * bytes; prepending puts the insertion on a line carrying no Author bytes
 * at all, and reorders no existing entry.
 */
function applyPoiesisScript(current: string, path: string): string {
  const next = applyEdits(
    current,
    modify(current, [...POIESIS_SCRIPT_PATH], POIESIS_SCRIPT_COMMAND, {
      formattingOptions: detectFormattingOptions(current),
      getInsertionIndex: () => 0,
    }),
  );
  assertByteMinimalScriptEdit(current, next, path);
  return next;
}

/**
 * The single, pure computation shared by the read-only pre-flight and the
 * write site, so both can never disagree about what the edit would be.
 *
 * Returns the would-be content, or `null` when the value is already
 * correct (no edit is needed at all). Performs no I/O and writes
 * nothing: every failure it raises — the reformat refusal and the
 * missing-script post-condition — is a pure function of the preimage,
 * which is what lets `assertPoiesisScriptAvailable` surface all of them
 * before any write.
 */
function planPoiesisScriptEdit(content: string, document: JsonObject, path: string): string | null {
  if (getAtPath(document, POIESIS_SCRIPT_PATH).value === POIESIS_SCRIPT_COMMAND) return null;
  return applyPoiesisScript(content, path);
}

/**
 * Optional transaction binding for the two entry points below.
 */
export interface EnsurePoiesisScriptOptions {
  /**
   * Invoked with the post-write content IMMEDIATELY after the write
   * lands and BEFORE any post-write verification. A caller binds its
   * rollback identity here so a throw from a later post-write step still
   * leaves the catch block holding the hash it needs to reverse its own
   * write.
   */
  onWritten?: (content: string) => void;
}

async function ensurePoiesisScript(
  root: string,
  refuseConflict: boolean,
  expected: Buffer | null,
  options: EnsurePoiesisScriptOptions,
): Promise<string | undefined> {
  const present = await readPackageJsonBytes(root);
  const existingBytes = present?.bytes ?? null;
  if (expected === null ? existingBytes !== null : existingBytes === null || !expected.equals(existingBytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "package.json changed since the transaction snapshot", {
      path: PACKAGE_JSON_RELATIVE,
    });
  }
  if (present === null) return undefined;
  const content = present.bytes.toString("utf8");
  const document = parsePackageJson(content, present.path);
  if (refuseConflict) assertNoConflictingPoiesisScript(document);
  const next = planPoiesisScriptEdit(content, document, present.path);
  if (next === null) return undefined;
  await atomicWrite(present.path, next);
  options.onWritten?.(next);
  return next;
}

/**
 * Idempotent `scripts.poiesis` ensure that REFUSES to touch a differing
 * Author script — acceptance #4. Used by `init`, which owns the install
 * and must never overwrite what the Author wrote.
 *
 * `expected` is REQUIRED: it is the preimage snapshot taken before the
 * transaction started. A `Buffer` means "must still be exactly these
 * bytes", `null` means "must still be absent". Drift fails closed before
 * the write, and there is no way to opt out of the drift check.
 *
 * Returns `undefined` when the value is already correct, so an
 * already-correct script is a no-op and never counts as an authored
 * write; otherwise returns the post-write content. A project with no
 * `package.json` returns `undefined` and is never given one.
 */
export function ensurePoiesisScriptRefusing(
  root: string,
  expected: Buffer | null,
  options?: EnsurePoiesisScriptOptions,
): Promise<string | undefined> {
  return ensurePoiesisScript(root, true, expected, options ?? {});
}

/**
 * Idempotent `scripts.poiesis` ensure that REPAIRS a missing or drifted
 * value — acceptance #7. Used by the three update transactions, each of
 * which is a receipt-authenticated reconciliation boundary.
 *
 * A drifted value is replaced surgically: only the value's own bytes
 * change, so sibling scripts keep their exact source bytes. `expected`
 * is REQUIRED with the same meaning and the same mandatory drift guard
 * as `ensurePoiesisScriptRefusing`.
 */
export function repairPoiesisScript(
  root: string,
  expected: Buffer | null,
  options?: EnsurePoiesisScriptOptions,
): Promise<string | undefined> {
  return ensurePoiesisScript(root, false, expected, options ?? {});
}

/**
 * Written-hash-gated reversal of the package-script edit.
 *
 * Mirrors `rollbackInitGitignore`: a no-op unless the current file hash
 * still equals the hash this transaction wrote, so a foreign concurrent
 * write is preserved rather than clobbered. `snapshot === null` means
 * the file did not exist before the transaction and is unlinked.
 */
export async function rollbackPackageJson(
  path: string,
  snapshot: Buffer | null | undefined,
  writtenHash?: string,
): Promise<void> {
  if (snapshot === undefined || writtenHash === undefined) return;
  if (!(await pathEntryExists(path))) return;
  if (!(await isRegularFile(path)) || (await hashFile(path)) !== writtenHash) return;
  if (snapshot === null) await unlink(path);
  else await atomicWrite(path, snapshot);
}

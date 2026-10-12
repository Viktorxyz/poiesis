/**
 * Spec #207 / ticket #210 — pinned local package invocation (Author replan).
 *
 * Ordinary Node packages get a standard npm/pnpm exact `poiesis-cli`
 * devDependency equal to the installed release and `scripts.poiesis = "poiesis"`
 * so local invocation uses the installed runtime. After install, the resolved
 * local package version must equal the target. Self-host `package.name ===
 * "poiesis-cli"` never self-depends; it uses `scripts.poiesis = "node dist/cli.js"`
 * and verifies build readiness by probing that binary directly (`node dist/cli.js
 * --version`) — never by running arbitrary package scripts. Projects without
 * `package.json` keep exact `pnpm dlx poiesis-cli@<version>` and never receive
 * fabricated package metadata.
 *
 * Ownership is contribution-scoped (script + optional exact dep + lockfile
 * fields Poiesis wrote), not whole-file package.json ownership. Native pm runs
 * with `--ignore-scripts`. The artifact journal restores only Poiesis-authored
 * package.json/lock bytes it bound; it does **not** promise atomic rollback of
 * `node_modules` or other native package-manager side effects. A native pm
 * failure is an explicit incomplete operation — never a successful manifest
 * transition. Foreign scripts/deps conflict fail closed before mutation.
 *
 * Former `src/package-script.ts` (`@latest` dlx script) is not resurrected.
 */
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type FormattingOptions,
  type Node,
} from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";
import { parseJsonc } from "./config.js";
import { PoiesisError } from "./errors.js";
import type { PackageContributionRecord } from "./manifest.js";
import type { ArtifactJournalEntry } from "./mutation-transaction.js";

export const PACKAGE_JSON_RELATIVE = "package.json";
export const POIESIS_SCRIPT_NAME = "poiesis";
export const POIESIS_CLI_PACKAGE_NAME = "poiesis-cli";
export const SELFHOST_PACKAGE_NAME = "poiesis-cli";
export const ORDINARY_SCRIPT_VALUE = "poiesis";
export const SELFHOST_SCRIPT_VALUE = "node dist/cli.js";
/** Resolved ordinary install identity under the primary root. */
export const LOCAL_CLI_PACKAGE_JSON_RELATIVE = "node_modules/poiesis-cli/package.json";
/** Selfhost built entry; probed with `node dist/cli.js --version`. */
export const SELFHOST_DIST_CLI_RELATIVE = "dist/cli.js";

export type SupportedPackageManager = "npm" | "pnpm";
export type PackageLockfileName = "package-lock.json" | "pnpm-lock.yaml";
export type PackageProjectKind = "ordinary" | "selfhost";
export type { PackageContributionRecord };

/**
 * Assert the resolved local `poiesis-cli` package version equals the installed
 * target. Reads `node_modules/poiesis-cli/package.json` (injected for tests).
 */
export function assertResolvedLocalCliVersion(args: {
  expectedVersion: string;
  installedPackageJson: string | null;
  path?: string;
}): void {
  const path = args.path ?? LOCAL_CLI_PACKAGE_JSON_RELATIVE;
  if (args.installedPackageJson === null) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "poiesis-cli was not resolved under node_modules after the native package-manager install",
      { path, expectedVersion: args.expectedVersion },
    );
  }
  let document: unknown;
  try {
    document = parseJsonc<unknown>(args.installedPackageJson, path);
  } catch (error) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "Resolved poiesis-cli package.json is not valid JSON",
      { path, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    typeof document !== "object" ||
    document === null ||
    !("version" in document) ||
    typeof (document as { version: unknown }).version !== "string" ||
    (document as { version: string }).version.length === 0
  ) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_UNRESOLVED",
      "Resolved poiesis-cli package.json does not declare a version",
      { path },
    );
  }
  const actual = (document as { version: string }).version;
  if (actual !== args.expectedVersion) {
    throw new PoiesisError(
      "PACKAGE_LOCAL_BIN_VERSION_MISMATCH",
      "Resolved local poiesis-cli version does not equal the installed target",
      { path, expectedVersion: args.expectedVersion, actualVersion: actual },
    );
  }
}

/**
 * Selfhost readiness: probe `node dist/cli.js --version` directly (no package
 * script execution). Missing/unbuilt/stale dist is a typed fail-closed condition.
 */
export function assertSelfhostDistReady(args: {
  expectedVersion: string;
  /** Injected probe result: null ⇒ missing binary / spawn failure. */
  probe: { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string };
}): void {
  if (!args.probe.ok) {
    if (args.probe.code === "missing") {
      throw new PoiesisError(
        "SELFHOST_DIST_MISSING",
        "Selfhost poiesis-cli requires a built dist/cli.js before local invocation can be configured",
        { path: SELFHOST_DIST_CLI_RELATIVE, expectedVersion: args.expectedVersion },
      );
    }
    throw new PoiesisError(
      "SELFHOST_DIST_UNREADABLE",
      "Could not probe selfhost dist/cli.js with node --version",
      {
        path: SELFHOST_DIST_CLI_RELATIVE,
        expectedVersion: args.expectedVersion,
        detail: args.probe.detail,
      },
    );
  }
  const actual = args.probe.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (actual.length === 0) {
    throw new PoiesisError(
      "SELFHOST_DIST_VERSION_MISMATCH",
      "Selfhost dist/cli.js --version produced no version output",
      { path: SELFHOST_DIST_CLI_RELATIVE, expectedVersion: args.expectedVersion },
    );
  }
  if (actual !== args.expectedVersion) {
    throw new PoiesisError(
      "SELFHOST_DIST_VERSION_MISMATCH",
      "Selfhost dist/cli.js version does not equal the package runtime version",
      {
        path: SELFHOST_DIST_CLI_RELATIVE,
        expectedVersion: args.expectedVersion,
        actualVersion: actual,
      },
    );
  }
}

/** Production selfhost probe: `node dist/cli.js --version` under the primary root. */
export async function probeSelfhostDistVersion(
  root: string,
  run: (command: string, args: string[], options: { cwd: string; allowFailure: true }) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>,
): Promise<{ ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }> {
  const { exists } = await import("./fs.js");
  const { join } = await import("node:path");
  const distPath = join(root, SELFHOST_DIST_CLI_RELATIVE);
  if (!(await exists(distPath))) {
    return { ok: false, code: "missing" };
  }
  try {
    const result = await run("node", [SELFHOST_DIST_CLI_RELATIVE, "--version"], {
      cwd: root,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: "spawn-failed",
        detail: result.stderr.trim() || `exit ${result.exitCode}`,
      };
    }
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return {
      ok: false,
      code: "spawn-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type PackageFsSnapshot = {
  packageJson: string | null;
  lockfiles: {
    "pnpm-lock.yaml": string | null;
    "package-lock.json": string | null;
    "yarn.lock": string | null;
    "bun.lock": string | null;
    "bun.lockb": string | null;
    "pnpm-workspace.yaml": string | null;
  };
};

export type PackageManagerResolution =
  | { kind: "absent" }
  | { kind: "supported"; manager: SupportedPackageManager; lockfile: PackageLockfileName }
  | {
      kind: "unsupported";
      code: "PACKAGE_MANAGER_AMBIGUOUS" | "PACKAGE_MANAGER_UNSUPPORTED" | "PACKAGE_WORKSPACE_UNSUPPORTED";
      message: string;
      details: Record<string, unknown>;
    };

export type LockfileOperation =
  | { op: "add-dev"; name: typeof POIESIS_CLI_PACKAGE_NAME; version: string }
  | { op: "remove-dev"; name: typeof POIESIS_CLI_PACKAGE_NAME }
  | null;

/**
 * Exact native package-manager argv for a lock/dep operation.
 * Lifecycle scripts are always disabled (`--ignore-scripts`).
 */
export function nativePackageManagerArgv(
  manager: SupportedPackageManager,
  operation: Exclude<LockfileOperation, null>,
): readonly string[] {
  if (manager === "pnpm") {
    return operation.op === "add-dev"
      ? ["add", "-D", `${operation.name}@${operation.version}`, "--ignore-scripts"]
      : ["remove", operation.name, "--ignore-scripts"];
  }
  return operation.op === "add-dev"
    ? ["install", "-D", `${operation.name}@${operation.version}`, "--ignore-scripts"]
    : ["uninstall", operation.name, "--ignore-scripts"];
}

export type PackageContributionPlan =
  | { kind: "absent" }
  | {
      kind: "noop";
      record: PackageContributionRecord;
      packageJsonChanged: false;
      lockfileOperation: null;
      nextPackageJson?: undefined;
      preserved?: undefined;
    }
  | {
      kind: "apply";
      record: PackageContributionRecord;
      packageJsonChanged: boolean;
      lockfileOperation: LockfileOperation;
      nextPackageJson: string;
      /** Paths left untouched because foreign content no longer matches ownership. */
      preserved?: Array<{ path: string[]; reason: string }>;
    };

export type PackageManagerExecutor = {
  apply(request: {
    manager: SupportedPackageManager;
    operation: Exclude<LockfileOperation, null>;
    packageJson: string;
    lockfile: string;
    ignoreScripts: true;
  }): Promise<{ packageJson: string; lockfile: string }>;
};

type JsonObject = Record<string, unknown>;

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}

function parsePackageObject(content: string): JsonObject {
  const document = parseJsonc<unknown>(content, PACKAGE_JSON_RELATIVE);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new PoiesisError("INVALID_PACKAGE_JSON", "package.json is not a JSON object", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }
  const record = document as JsonObject;
  if (Object.hasOwn(record, "scripts")) {
    const scripts = record.scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
      throw new PoiesisError("INVALID_PACKAGE_JSON", 'package.json "scripts" is not a JSON object', {
        path: ["scripts"],
      });
    }
  }
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    if (!Object.hasOwn(record, key)) continue;
    const deps = record[key];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
      throw new PoiesisError("INVALID_PACKAGE_JSON", `package.json "${key}" is not a JSON object`, {
        path: [key],
      });
    }
  }
  return record;
}

function getAtPath(value: unknown, path: readonly string[]): { exists: boolean; value?: unknown } {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
      return { exists: false };
    }
    current = (current as JsonObject)[part];
  }
  return { exists: true, value: current };
}

function hasWorkspacesField(document: JsonObject): boolean {
  if (!Object.hasOwn(document, "workspaces")) return false;
  const workspaces = document.workspaces;
  if (Array.isArray(workspaces) && workspaces.length > 0) return true;
  if (typeof workspaces === "object" && workspaces !== null && !Array.isArray(workspaces)) {
    const packages = (workspaces as JsonObject).packages;
    if (Array.isArray(packages) && packages.length > 0) return true;
  }
  return false;
}

export function resolvePackageManagerOwnership(snapshot: PackageFsSnapshot): PackageManagerResolution {
  if (snapshot.packageJson === null) return { kind: "absent" };

  let document: JsonObject;
  try {
    document = parsePackageObject(snapshot.packageJson);
  } catch (error) {
    if (error instanceof PoiesisError) throw error;
    throw new PoiesisError("INVALID_PACKAGE_JSON", "package.json is not valid JSON", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }

  if (present(snapshot.lockfiles["pnpm-workspace.yaml"]) || hasWorkspacesField(document)) {
    return {
      kind: "unsupported",
      code: "PACKAGE_WORKSPACE_UNSUPPORTED",
      message:
        "Poiesis cannot safely own package/lock contributions in a workspace; use a single-package project with one native lockfile",
      details: {
        pnpmWorkspace: present(snapshot.lockfiles["pnpm-workspace.yaml"]),
        packageWorkspaces: hasWorkspacesField(document),
      },
    };
  }

  const pnpm = present(snapshot.lockfiles["pnpm-lock.yaml"]);
  const npm = present(snapshot.lockfiles["package-lock.json"]);
  const yarn = present(snapshot.lockfiles["yarn.lock"]);
  const bun = present(snapshot.lockfiles["bun.lock"]) || present(snapshot.lockfiles["bun.lockb"]);

  if (pnpm && npm) {
    return {
      kind: "unsupported",
      code: "PACKAGE_MANAGER_AMBIGUOUS",
      message: "Both pnpm-lock.yaml and package-lock.json are present; refuse to choose a package manager",
      details: { lockfiles: ["pnpm-lock.yaml", "package-lock.json"] },
    };
  }

  if (yarn || bun) {
    return {
      kind: "unsupported",
      code: "PACKAGE_MANAGER_UNSUPPORTED",
      message: "Only npm and pnpm lock ownership are supported for local Poiesis package invocation",
      details: {
        yarn: yarn,
        bun: bun,
        supported: ["npm", "pnpm"],
      },
    };
  }

  if (pnpm) return { kind: "supported", manager: "pnpm", lockfile: "pnpm-lock.yaml" };
  if (npm) return { kind: "supported", manager: "npm", lockfile: "package-lock.json" };

  return {
    kind: "unsupported",
    code: "PACKAGE_MANAGER_UNSUPPORTED",
    message:
      "package.json is present without a supported lockfile (pnpm-lock.yaml or package-lock.json); refuse to invent lock ownership",
    details: { supportedLockfiles: ["pnpm-lock.yaml", "package-lock.json"] },
  };
}

export function classifyPackageProject(document: { name?: unknown }): PackageProjectKind {
  return document.name === SELFHOST_PACKAGE_NAME ? "selfhost" : "ordinary";
}

export function desiredScriptValue(kind: PackageProjectKind): string {
  return kind === "selfhost" ? SELFHOST_SCRIPT_VALUE : ORDINARY_SCRIPT_VALUE;
}

export function buildPackageContributionRecord(args: {
  manager: SupportedPackageManager;
  lockfile: PackageLockfileName;
  projectKind: PackageProjectKind;
  scriptValue: string;
  devDependencyVersion?: string;
}): PackageContributionRecord {
  return {
    owned: true,
    manager: args.manager,
    lockfile: args.lockfile,
    projectKind: args.projectKind,
    packageJson: PACKAGE_JSON_RELATIVE,
    scriptName: POIESIS_SCRIPT_NAME,
    scriptValue: args.scriptValue,
    ...(args.devDependencyVersion === undefined ? {} : { devDependencyVersion: args.devDependencyVersion }),
  };
}

function dependencyVersion(document: JsonObject, name: string): { section: string; version: string } | undefined {
  for (const section of ["devDependencies", "dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const block = document[section];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    if (!Object.hasOwn(block as JsonObject, name)) continue;
    const version = (block as JsonObject)[name];
    if (typeof version === "string") return { section, version };
  }
  return undefined;
}

function detectFormattingOptions(content: string): FormattingOptions {
  const lines = content.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const body = line.trimStart();
    if (body.length === 0 || !body.startsWith('"')) continue;
    const indent = line.slice(0, line.length - body.length);
    if (indent.includes("\t")) return { insertSpaces: false, tabSize: 4, eol: "\n" };
    return { insertSpaces: true, tabSize: indent.length === 0 ? 2 : indent.length, eol: "\n" };
  }
  return { insertSpaces: true, tabSize: 2, eol: "\n" };
}

function propertySourceSlices(content: string, object: Node | undefined, exclude: string): string[] {
  return (object?.children ?? [])
    .filter((property) => property.children?.[0]?.value !== exclude)
    .map((property) => content.slice(property.offset, property.offset + property.length));
}

function assertByteMinimalEdit(before: string, after: string, touchedPaths: readonly string[][]): void {
  const afterTree = parseTree(after);
  if (afterTree === undefined || afterTree.type !== "object") {
    throw new PoiesisError("PACKAGE_EDIT_REFUSED", "Refusing to rewrite a non-object package.json", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }
  const beforeTree = parseTree(before);
  if (beforeTree === undefined || beforeTree.type !== "object") {
    throw new PoiesisError("PACKAGE_EDIT_REFUSED", "Refusing to edit a non-object package.json", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }

  // Root properties other than the top-level containers we intentionally touch
  // must keep exact source slices.
  const touchedRoots = new Set(touchedPaths.map((path) => path[0]!));
  for (const root of ["scripts", "devDependencies", "dependencies", "peerDependencies", "optionalDependencies"]) {
    if (!touchedRoots.has(root)) {
      const beforeNode = findNodeAtLocation(beforeTree, [root]);
      const afterNode = findNodeAtLocation(afterTree, [root]);
      const beforeSlice =
        beforeNode === undefined ? null : before.slice(beforeNode.offset, beforeNode.offset + beforeNode.length);
      const afterSlice =
        afterNode === undefined ? null : after.slice(afterNode.offset, afterNode.offset + afterNode.length);
      if (beforeSlice !== afterSlice) {
        throw new PoiesisError(
          "PACKAGE_EDIT_REFUSED",
          "Refusing to write a package.json edit that would reformat unrelated entries",
          { file: PACKAGE_JSON_RELATIVE, path: [root] },
        );
      }
    }
  }

  // Within scripts, siblings of `poiesis` must keep exact bytes.
  if (touchedRoots.has("scripts")) {
    const beforeScripts = findNodeAtLocation(beforeTree, ["scripts"]);
    const afterScripts = findNodeAtLocation(afterTree, ["scripts"]);
    if (
      !isDeepStrictEqual(
        propertySourceSlices(before, beforeScripts, POIESIS_SCRIPT_NAME),
        propertySourceSlices(after, afterScripts, POIESIS_SCRIPT_NAME),
      )
    ) {
      throw new PoiesisError(
        "PACKAGE_EDIT_REFUSED",
        "Refusing to write a package.json edit that would reformat existing scripts",
        { file: PACKAGE_JSON_RELATIVE, path: ["scripts"] },
      );
    }
  }

  // Within devDependencies, siblings of poiesis-cli must keep exact bytes when we touch that section.
  if (touchedRoots.has("devDependencies")) {
    const beforeDeps = findNodeAtLocation(beforeTree, ["devDependencies"]);
    const afterDeps = findNodeAtLocation(afterTree, ["devDependencies"]);
    if (
      !isDeepStrictEqual(
        propertySourceSlices(before, beforeDeps, POIESIS_CLI_PACKAGE_NAME),
        propertySourceSlices(after, afterDeps, POIESIS_CLI_PACKAGE_NAME),
      )
    ) {
      throw new PoiesisError(
        "PACKAGE_EDIT_REFUSED",
        "Refusing to write a package.json edit that would reformat existing devDependencies",
        { file: PACKAGE_JSON_RELATIVE, path: ["devDependencies"] },
      );
    }
  }

  // Other root properties (name, version, private, …) must keep exact source slices.
  if (
    !isDeepStrictEqual(
      propertySourceSlices(before, beforeTree, "scripts").filter((slice) => {
        // Filter is approximate; also drop touched dep sections by comparing root keys separately.
        return true;
      }),
      propertySourceSlices(after, afterTree, "scripts"),
    )
  ) {
    // Stricter check: every root key except scripts/devDependencies must match.
    const beforeRootKeys = (beforeTree.children ?? [])
      .map((property) => property.children?.[0]?.value as string | undefined)
      .filter((key): key is string => typeof key === "string" && key !== "scripts" && key !== "devDependencies");
    for (const key of beforeRootKeys) {
      const beforeNode = findNodeAtLocation(beforeTree, [key]);
      const afterNode = findNodeAtLocation(afterTree, [key]);
      if (beforeNode === undefined || afterNode === undefined) {
        if (beforeNode === undefined && afterNode === undefined) continue;
        throw new PoiesisError(
          "PACKAGE_EDIT_REFUSED",
          "Refusing to write a package.json edit that would reformat existing entries",
          { file: PACKAGE_JSON_RELATIVE, path: [key] },
        );
      }
      const beforeSlice = before.slice(beforeNode.offset, beforeNode.offset + beforeNode.length);
      const afterSlice = after.slice(afterNode.offset, afterNode.offset + afterNode.length);
      if (beforeSlice !== afterSlice) {
        throw new PoiesisError(
          "PACKAGE_EDIT_REFUSED",
          "Refusing to write a package.json edit that would reformat existing entries",
          { file: PACKAGE_JSON_RELATIVE, path: [key] },
        );
      }
    }
  }
}

function applyJsonPathEdit(
  content: string,
  path: readonly string[],
  value: unknown | undefined,
  options: { insertionIndex?: number } = {},
): string {
  return applyEdits(
    content,
    modify(content, [...path], value, {
      formattingOptions: detectFormattingOptions(content),
      ...(options.insertionIndex === undefined ? {} : { getInsertionIndex: () => options.insertionIndex! }),
    }),
  );
}

function setScript(content: string, value: string): string {
  const next = applyJsonPathEdit(content, ["scripts", POIESIS_SCRIPT_NAME], value, { insertionIndex: 0 });
  assertByteMinimalEdit(content, next, [["scripts", POIESIS_SCRIPT_NAME]]);
  if (getAtPath(parsePackageObject(next), ["scripts", POIESIS_SCRIPT_NAME]).value !== value) {
    throw new PoiesisError("PACKAGE_EDIT_REFUSED", "Refusing to write a package.json edit that did not produce the poiesis script", {
      file: PACKAGE_JSON_RELATIVE,
    });
  }
  return next;
}

function removeScript(content: string): string {
  const next = applyJsonPathEdit(content, ["scripts", POIESIS_SCRIPT_NAME], undefined);
  assertByteMinimalEdit(content, next, [["scripts", POIESIS_SCRIPT_NAME]]);
  return next;
}

function setDevDependency(content: string, version: string): string {
  const next = applyJsonPathEdit(content, ["devDependencies", POIESIS_CLI_PACKAGE_NAME], version, {
    insertionIndex: 0,
  });
  assertByteMinimalEdit(content, next, [["devDependencies", POIESIS_CLI_PACKAGE_NAME]]);
  if (getAtPath(parsePackageObject(next), ["devDependencies", POIESIS_CLI_PACKAGE_NAME]).value !== version) {
    throw new PoiesisError(
      "PACKAGE_EDIT_REFUSED",
      "Refusing to write a package.json edit that did not produce the poiesis-cli devDependency",
      { file: PACKAGE_JSON_RELATIVE },
    );
  }
  return next;
}

function removeDevDependency(content: string): string {
  // Prefer removing from the section where it lives.
  const document = parsePackageObject(content);
  const found = dependencyVersion(document, POIESIS_CLI_PACKAGE_NAME);
  if (found === undefined) return content;
  const next = applyJsonPathEdit(content, [found.section, POIESIS_CLI_PACKAGE_NAME], undefined);
  assertByteMinimalEdit(content, next, [[found.section, POIESIS_CLI_PACKAGE_NAME]]);
  return next;
}

function throwIfUnsupported(resolution: PackageManagerResolution): asserts resolution is Extract<
  PackageManagerResolution,
  { kind: "supported" }
> {
  if (resolution.kind === "supported") return;
  if (resolution.kind === "absent") {
    throw new PoiesisError("PACKAGE_MANAGER_UNSUPPORTED", "package.json is absent", {});
  }
  throw new PoiesisError(resolution.code, resolution.message, resolution.details);
}

export function planPackageContribution(args: {
  snapshot: PackageFsSnapshot;
  poiesisVersion: string;
  mode: "ensure" | "repair";
  prior?: PackageContributionRecord | undefined;
}): PackageContributionPlan {
  const resolution = resolvePackageManagerOwnership(args.snapshot);
  if (resolution.kind === "absent") return { kind: "absent" };
  throwIfUnsupported(resolution);

  const content = args.snapshot.packageJson!;
  const document = parsePackageObject(content);
  const projectKind = classifyPackageProject(document);
  const scriptValue = desiredScriptValue(projectKind);
  const desiredDepVersion = projectKind === "ordinary" ? args.poiesisVersion : undefined;

  // Selfhost must never carry a self-dependency.
  if (projectKind === "selfhost") {
    const selfDep = dependencyVersion(document, POIESIS_CLI_PACKAGE_NAME);
    if (selfDep !== undefined) {
      throw new PoiesisError(
        "PACKAGE_SELF_DEPENDENCY",
        "poiesis-cli must not depend on itself; use scripts.poiesis = node dist/cli.js",
        { path: [selfDep.section, POIESIS_CLI_PACKAGE_NAME], version: selfDep.version },
      );
    }
  }

  const existingScript = getAtPath(document, ["scripts", POIESIS_SCRIPT_NAME]);
  const existingDep =
    projectKind === "ordinary" ? dependencyVersion(document, POIESIS_CLI_PACKAGE_NAME) : undefined;

  if (args.mode === "ensure") {
    if (existingScript.exists && existingScript.value !== scriptValue) {
      // Owned prior may repair; bare ensure refuses foreign conflict.
      if (args.prior === undefined || args.prior.scriptValue !== existingScript.value) {
        // If prior owned the current value, repair path should be used. Ensure refuses foreign.
        if (args.prior === undefined || existingScript.value !== args.prior.scriptValue) {
          if (args.prior === undefined) {
            throw new PoiesisError(
              "PACKAGE_SCRIPT_CONFLICT",
              "package.json already defines a different poiesis script",
              { path: ["scripts", POIESIS_SCRIPT_NAME], existing: existingScript.value, expected: scriptValue },
            );
          }
        }
      }
    }
    if (existingDep !== undefined && desiredDepVersion !== undefined && existingDep.version !== desiredDepVersion) {
      // Only exact version is owned. Ranges/other versions are foreign conflicts on ensure.
      const priorOwned =
        args.prior?.devDependencyVersion !== undefined && existingDep.version === args.prior.devDependencyVersion;
      if (!priorOwned) {
        throw new PoiesisError(
          "PACKAGE_DEPENDENCY_CONFLICT",
          "package.json already defines a different poiesis-cli dependency",
          {
            path: [existingDep.section, POIESIS_CLI_PACKAGE_NAME],
            existing: existingDep.version,
            expected: desiredDepVersion,
          },
        );
      }
    }
  }

  // Repair mode: only rewrite when prior provenance authenticates the current value,
  // or the value is missing / already the desired owned value.
  if (args.mode === "repair" && args.prior !== undefined) {
    if (
      existingScript.exists &&
      existingScript.value !== scriptValue &&
      existingScript.value !== args.prior.scriptValue
    ) {
      throw new PoiesisError(
        "PACKAGE_SCRIPT_CONFLICT",
        "package.json poiesis script drifted from owned contribution and is not the prior owned value",
        { path: ["scripts", POIESIS_SCRIPT_NAME], existing: existingScript.value, prior: args.prior.scriptValue },
      );
    }
    if (
      existingDep !== undefined &&
      desiredDepVersion !== undefined &&
      existingDep.version !== desiredDepVersion &&
      existingDep.version !== args.prior.devDependencyVersion
    ) {
      throw new PoiesisError(
        "PACKAGE_DEPENDENCY_CONFLICT",
        "package.json poiesis-cli dependency drifted from owned contribution and is not the prior owned value",
        {
          path: [existingDep.section, POIESIS_CLI_PACKAGE_NAME],
          existing: existingDep.version,
          prior: args.prior.devDependencyVersion,
        },
      );
    }
  }

  // Ensure with foreign conflict already thrown. For ensure with matching prior-owned drift, treat as repair.
  const mayOverwriteScript =
    args.mode === "repair" ||
    !existingScript.exists ||
    existingScript.value === scriptValue ||
    (args.prior !== undefined && existingScript.value === args.prior.scriptValue);
  const mayOverwriteDep =
    desiredDepVersion === undefined ||
    args.mode === "repair" ||
    existingDep === undefined ||
    existingDep.version === desiredDepVersion ||
    (args.prior !== undefined && existingDep.version === args.prior.devDependencyVersion);

  if (!mayOverwriteScript) {
    throw new PoiesisError("PACKAGE_SCRIPT_CONFLICT", "package.json already defines a different poiesis script", {
      path: ["scripts", POIESIS_SCRIPT_NAME],
      existing: existingScript.value,
      expected: scriptValue,
    });
  }
  if (!mayOverwriteDep && desiredDepVersion !== undefined && existingDep !== undefined) {
    throw new PoiesisError(
      "PACKAGE_DEPENDENCY_CONFLICT",
      "package.json already defines a different poiesis-cli dependency",
      {
        path: [existingDep.section, POIESIS_CLI_PACKAGE_NAME],
        existing: existingDep.version,
        expected: desiredDepVersion,
      },
    );
  }

  let next = content;
  let packageJsonChanged = false;

  if (!existingScript.exists || existingScript.value !== scriptValue) {
    next = setScript(next, scriptValue);
    packageJsonChanged = true;
  }

  let lockfileOperation: LockfileOperation = null;
  if (desiredDepVersion !== undefined) {
    if (existingDep === undefined || existingDep.version !== desiredDepVersion) {
      // Move onto devDependencies with exact version.
      if (existingDep !== undefined && existingDep.section !== "devDependencies") {
        next = removeDevDependency(next);
      }
      next = setDevDependency(next, desiredDepVersion);
      packageJsonChanged = true;
      lockfileOperation = { op: "add-dev", name: POIESIS_CLI_PACKAGE_NAME, version: desiredDepVersion };
    }
  }

  const record = buildPackageContributionRecord({
    manager: resolution.manager,
    lockfile: resolution.lockfile,
    projectKind,
    scriptValue,
    ...(desiredDepVersion === undefined ? {} : { devDependencyVersion: desiredDepVersion }),
  });

  if (!packageJsonChanged && lockfileOperation === null) {
    return { kind: "noop", record, packageJsonChanged: false, lockfileOperation: null };
  }

  // Version-crossing ordinary packages always need lockfile reconciliation when dep version changes.
  // If package.json already had exact dep but lock might be stale, callers may still run install —
  // for ensure/repair we only request lockfile ops when the declared dep changes.
  return {
    kind: "apply",
    record,
    packageJsonChanged,
    lockfileOperation,
    nextPackageJson: next,
  };
}

export function planPackageContributionRemoval(args: {
  snapshot: PackageFsSnapshot;
  record: PackageContributionRecord;
}): PackageContributionPlan {
  if (args.snapshot.packageJson === null) {
    return { kind: "noop", record: args.record, packageJsonChanged: false, lockfileOperation: null };
  }
  const resolution = resolvePackageManagerOwnership(args.snapshot);
  if (resolution.kind === "absent") {
    return { kind: "noop", record: args.record, packageJsonChanged: false, lockfileOperation: null };
  }
  // Removal still requires the same manager/lock ownership that installed the contribution.
  if (resolution.kind === "unsupported") {
    throw new PoiesisError(resolution.code, resolution.message, resolution.details);
  }
  if (resolution.manager !== args.record.manager || resolution.lockfile !== args.record.lockfile) {
    throw new PoiesisError(
      "PACKAGE_MANAGER_AMBIGUOUS",
      "Installed package contribution manager/lockfile no longer matches on-disk lock ownership",
      {
        recorded: { manager: args.record.manager, lockfile: args.record.lockfile },
        actual: { manager: resolution.manager, lockfile: resolution.lockfile },
      },
    );
  }

  const content = args.snapshot.packageJson;
  const document = parsePackageObject(content);
  const preserved: Array<{ path: string[]; reason: string }> = [];
  let next = content;
  let packageJsonChanged = false;

  const existingScript = getAtPath(document, ["scripts", POIESIS_SCRIPT_NAME]);
  if (existingScript.exists) {
    if (existingScript.value === args.record.scriptValue) {
      next = removeScript(next);
      packageJsonChanged = true;
    } else {
      preserved.push({
        path: ["scripts", POIESIS_SCRIPT_NAME],
        reason: "foreign script value differs from owned contribution",
      });
    }
  }

  let lockfileOperation: LockfileOperation = null;
  if (args.record.devDependencyVersion !== undefined) {
    const existingDep = dependencyVersion(parsePackageObject(next), POIESIS_CLI_PACKAGE_NAME);
    if (existingDep !== undefined) {
      if (existingDep.version === args.record.devDependencyVersion) {
        next = removeDevDependency(next);
        packageJsonChanged = true;
        lockfileOperation = { op: "remove-dev", name: POIESIS_CLI_PACKAGE_NAME };
      } else {
        preserved.push({
          path: [existingDep.section, POIESIS_CLI_PACKAGE_NAME],
          reason: "foreign dependency version differs from owned contribution",
        });
      }
    }
  }

  if (!packageJsonChanged && lockfileOperation === null) {
    if (preserved.length === 0) {
      return { kind: "noop", record: args.record, packageJsonChanged: false, lockfileOperation: null };
    }
    return {
      kind: "apply",
      record: args.record,
      packageJsonChanged: false,
      lockfileOperation: null,
      nextPackageJson: content,
      preserved,
    };
  }

  return {
    kind: "apply",
    record: args.record,
    packageJsonChanged,
    lockfileOperation,
    nextPackageJson: next,
    ...(preserved.length === 0 ? {} : { preserved }),
  };
}

export function assertPackageContributionMatches(packageJson: string, record: PackageContributionRecord): void {
  const document = parsePackageObject(packageJson);
  const script = getAtPath(document, ["scripts", record.scriptName]);
  if (!script.exists || script.value !== record.scriptValue) {
    throw new PoiesisError(
      "PACKAGE_CONTRIBUTION_MISMATCH",
      "package.json poiesis script does not match the owned contribution",
      { expected: record.scriptValue, actual: script.value },
    );
  }
  if (record.devDependencyVersion !== undefined) {
    const dep = dependencyVersion(document, POIESIS_CLI_PACKAGE_NAME);
    if (dep === undefined || dep.version !== record.devDependencyVersion || dep.section !== "devDependencies") {
      throw new PoiesisError(
        "PACKAGE_CONTRIBUTION_MISMATCH",
        "package.json poiesis-cli devDependency does not match the owned contribution",
        { expected: record.devDependencyVersion, actual: dep },
      );
    }
  } else {
    const dep = dependencyVersion(document, POIESIS_CLI_PACKAGE_NAME);
    if (dep !== undefined) {
      throw new PoiesisError(
        "PACKAGE_SELF_DEPENDENCY",
        "selfhost package contribution must not carry a poiesis-cli dependency",
        { path: [dep.section, POIESIS_CLI_PACKAGE_NAME] },
      );
    }
  }
}

/**
 * Apply a planned package contribution. Writes package.json first (when
 * changed), then runs the injected executor for native pm ops with
 * `ignoreScripts: true`.
 *
 * `onWritten` fires immediately after each Poiesis-authored write so the
 * journal can bind identity before the next fallible step. A native pm
 * failure is {@link PACKAGE_MANAGER_INCOMPLETE}: owned package.json/lock
 * bytes may still be journal-restored, but `node_modules` / native pm side
 * effects are **not** claimed rolled back. Only bytes this function wrote
 * become written identities — never racing foreign disk state.
 */
export async function applyPackageContributionPlan(args: {
  plan: Extract<PackageContributionPlan, { kind: "apply" }>;
  preimage: { packageJson: string; lockfile: string };
  executor: PackageManagerExecutor;
  writeFile: (path: string, content: string) => Promise<void>;
  onWritten?: (path: string, content: string) => void;
  /** After ordinary add-dev: installed `node_modules/poiesis-cli/package.json` text, or null. */
  readResolvedLocalPackageJson?: () => Promise<string | null>;
  /** Before selfhost script write: injected dist probe (tests) or production probe. */
  probeSelfhostDist?: () => Promise<
    { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }
  >;
  /** Runtime version for selfhost dist readiness (package version being installed). */
  selfhostExpectedVersion?: string;
}): Promise<{
  packageJson: string;
  lockfile: string;
  writeSet: string[];
  record: PackageContributionRecord;
  preserved?: Array<{ path: string[]; reason: string }>;
  /**
   * When true, a native pm step failed after some Poiesis writes may have
   * landed. Callers must not advance the install manifest; journal may restore
   * owned package.json/lock only.
   */
  nativePmIncomplete?: true;
}> {
  const writeSet = [PACKAGE_JSON_RELATIVE, args.plan.record.lockfile];
  let packageJson = args.plan.nextPackageJson;
  let lockfile = args.preimage.lockfile;

  // Selfhost: verify dist readiness BEFORE mutating package.json so a missing
  // build does not leave a half-written contribution.
  if (args.plan.record.projectKind === "selfhost") {
    const expected = args.selfhostExpectedVersion;
    if (expected === undefined || args.probeSelfhostDist === undefined) {
      throw new PoiesisError(
        "SELFHOST_DIST_UNREADABLE",
        "Selfhost package contribution requires a dist probe and the installing runtime version",
        { path: SELFHOST_DIST_CLI_RELATIVE },
      );
    }
    assertSelfhostDistReady({ expectedVersion: expected, probe: await args.probeSelfhostDist() });
  }

  if (args.plan.packageJsonChanged) {
    await args.writeFile(PACKAGE_JSON_RELATIVE, packageJson);
    args.onWritten?.(PACKAGE_JSON_RELATIVE, packageJson);
  }

  if (args.plan.lockfileOperation !== null) {
    let result: { packageJson: string; lockfile: string };
    try {
      result = await args.executor.apply({
        manager: args.plan.record.manager,
        operation: args.plan.lockfileOperation,
        packageJson,
        lockfile,
        ignoreScripts: true,
      });
    } catch (error) {
      const cause = error instanceof PoiesisError ? error : undefined;
      throw new PoiesisError(
        "PACKAGE_MANAGER_INCOMPLETE",
        "Native package-manager operation failed; Poiesis did not complete the package contribution and will not advance the install manifest. Owned package.json/lock bytes may be journal-restored; node_modules and other native pm side effects are not claimed rolled back.",
        {
          manager: args.plan.record.manager,
          operation: args.plan.lockfileOperation,
          argv: [...nativePackageManagerArgv(args.plan.record.manager, args.plan.lockfileOperation)],
          ownedArtifactsMayRollback: true,
          nativeSideEffectsNotClaimedRolledBack: true,
          cause: cause?.code ?? (error instanceof Error ? error.message : String(error)),
          ...(cause === undefined ? {} : { causeCode: cause.code, causeDetails: cause.details }),
        },
      );
    }
    packageJson = result.packageJson;
    lockfile = result.lockfile;
    if (packageJson !== args.plan.nextPackageJson) {
      await args.writeFile(PACKAGE_JSON_RELATIVE, packageJson);
      args.onWritten?.(PACKAGE_JSON_RELATIVE, packageJson);
    }
    await args.writeFile(args.plan.record.lockfile, lockfile);
    args.onWritten?.(args.plan.record.lockfile, lockfile);

  }

  // Ordinary contribution: every successful apply that retains a local
  // devDependency MUST prove the resolved primary-root bin version. No reader
  // and no skip — missing/wrong version fails closed.
  if (args.plan.record.devDependencyVersion !== undefined) {
    if (args.readResolvedLocalPackageJson === undefined) {
      throw new PoiesisError(
        "PACKAGE_LOCAL_BIN_UNRESOLVED",
        "Ordinary package contribution requires a reader for node_modules/poiesis-cli/package.json",
        { path: LOCAL_CLI_PACKAGE_JSON_RELATIVE, expectedVersion: args.plan.record.devDependencyVersion },
      );
    }
    assertResolvedLocalCliVersion({
      expectedVersion: args.plan.record.devDependencyVersion,
      installedPackageJson: await args.readResolvedLocalPackageJson(),
    });
  }

  assertPackageContributionMatches(packageJson, args.plan.record);
  return {
    packageJson,
    lockfile,
    writeSet,
    record: args.plan.record,
    ...(args.plan.preserved === undefined ? {} : { preserved: args.plan.preserved }),
  };
}

/**
 * Read a filesystem snapshot for package ownership decisions. Callers that
 * already hold primary-root resolution should pass that root — never a
 * linked worktree path for ownership writes.
 */
export async function readPackageFsSnapshot(
  root: string,
  io: {
    readText: (absolutePath: string) => Promise<string | null>;
  },
): Promise<PackageFsSnapshot> {
  const { join } = await import("node:path");
  const read = async (relative: string): Promise<string | null> => io.readText(join(root, relative));
  return {
    packageJson: await read(PACKAGE_JSON_RELATIVE),
    lockfiles: {
      "pnpm-lock.yaml": await read("pnpm-lock.yaml"),
      "package-lock.json": await read("package-lock.json"),
      "yarn.lock": await read("yarn.lock"),
      "bun.lock": await read("bun.lock"),
      "bun.lockb": await read("bun.lockb"),
      "pnpm-workspace.yaml": await read("pnpm-workspace.yaml"),
    },
  };
}

/** Load a package FS snapshot from the primary installation root. */
export async function loadPackageFsSnapshot(root: string): Promise<PackageFsSnapshot> {
  const { readFile } = await import("node:fs/promises");
  return readPackageFsSnapshot(root, {
    readText: async (absolutePath) => {
      try {
        return await readFile(absolutePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  });
}

/**
 * Plan package contribution at the primary installation root. Throws typed
 * unsupported/ambiguous/workspace errors when package.json is present but
 * lock ownership cannot be claimed safely. Returns `{ kind: "absent" }` when
 * there is no package.json (exact dlx route retained).
 */
export async function planPackageContributionAtRoot(args: {
  root: string;
  poiesisVersion: string;
  mode: "ensure" | "repair";
  prior?: PackageContributionRecord | undefined;
}): Promise<PackageContributionPlan> {
  const snapshot = await loadPackageFsSnapshot(args.root);
  const planArgs: {
    snapshot: PackageFsSnapshot;
    poiesisVersion: string;
    mode: "ensure" | "repair";
    prior?: PackageContributionRecord;
  } = {
    snapshot,
    poiesisVersion: args.poiesisVersion,
    mode: args.mode,
  };
  if (args.prior !== undefined) planArgs.prior = args.prior;
  return planPackageContribution(planArgs);
}

/**
 * Native npm/pnpm executor: full exact install/remove with `--ignore-scripts`
 * under the primary installation root. Tests inject a prepared executor.
 * Does not claim atomic `node_modules` rollback — failure surfaces as
 * {@link PACKAGE_MANAGER_INCOMPLETE} from the apply plan.
 */
export function createNativePackageManagerExecutor(root: string): PackageManagerExecutor {
  return {
    async apply(request) {
      const { run } = await import("./process.js");
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const args = [...nativePackageManagerArgv(request.manager, request.operation)];
      try {
        await run(request.manager, args, { cwd: root });
      } catch (error) {
        throw new PoiesisError(
          "PACKAGE_MANAGER_FAILED",
          `${request.manager} ${args.join(" ")} failed`,
          {
            manager: request.manager,
            operation: request.operation,
            argv: args,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      const lockfileName = request.manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
      return {
        packageJson: await readFile(join(root, PACKAGE_JSON_RELATIVE), "utf8"),
        lockfile: await readFile(join(root, lockfileName), "utf8"),
      };
    },
  };
}

/** Test-only seam: replace the native package-manager executor. */
let packageManagerExecutorOverride: PackageManagerExecutor | null = null;

export function setPackageManagerExecutorForTest(executor: PackageManagerExecutor | null): void {
  packageManagerExecutorOverride = executor;
}

export function resolvePackageManagerExecutor(root: string): PackageManagerExecutor {
  return packageManagerExecutorOverride ?? createNativePackageManagerExecutor(root);
}

/**
 * Apply a planned contribution at the primary root and record journal write
 * identities for package.json + lockfile. Callers must have already
 * `journal.capture`d both paths.
 *
 * Each Poiesis-authored write binds `transactionWrittenIdentity` immediately
 * so journal rollback can restore those owned bytes. Native pm / node_modules
 * effects are never claimed fully rolled back on failure
 * (`PACKAGE_MANAGER_INCOMPLETE`). Racing foreign bytes are never adopted.
 */
export async function applyPackageContributionWithJournal(args: {
  root: string;
  plan: Extract<PackageContributionPlan, { kind: "apply" }>;
  packageJsonEntry: ArtifactJournalEntry;
  lockfileEntry: ArtifactJournalEntry;
  executor?: PackageManagerExecutor;
  preimageLockfile: string;
  /** Installing runtime version (selfhost dist check + ordinary target). */
  poiesisVersion: string;
  /** Test injection for resolved local package.json after ordinary install. */
  readResolvedLocalPackageJson?: () => Promise<string | null>;
  /** Test injection for selfhost dist probe. */
  probeSelfhostDist?: () => Promise<
    { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }
  >;
}): Promise<{
  record: PackageContributionRecord;
  packageJson: string;
  lockfile: string;
  preserved?: Array<{ path: string[]; reason: string }>;
}> {
  const { join } = await import("node:path");
  const { atomicWrite } = await import("./fs.js");
  const { hashContent } = await import("./hash.js");
  const { run } = await import("./process.js");
  const executor = args.executor ?? resolvePackageManagerExecutor(args.root);
  const lockfileRelative = args.plan.record.lockfile;

  const bindWritten = (relativePath: string, content: string): void => {
    const identity = { exists: true as const, kind: "file" as const, hash: hashContent(content) };
    if (relativePath === PACKAGE_JSON_RELATIVE) {
      args.packageJsonEntry.transactionWrittenIdentity = identity;
      return;
    }
    if (relativePath === lockfileRelative) {
      args.lockfileEntry.transactionWrittenIdentity = identity;
    }
  };

  const planArgs: Parameters<typeof applyPackageContributionPlan>[0] = {
    plan: args.plan,
    preimage: {
      packageJson: args.plan.nextPackageJson,
      lockfile: args.preimageLockfile,
    },
    executor,
    writeFile: async (relativePath, content) => {
      const absolute = join(args.root, relativePath);
      await atomicWrite(absolute, content);
    },
    onWritten: bindWritten,
    selfhostExpectedVersion: args.poiesisVersion,
  };
  if (args.plan.record.projectKind === "selfhost") {
    planArgs.probeSelfhostDist =
      args.probeSelfhostDist ?? (() => probeSelfhostDistVersion(args.root, run));
  }
  // Ordinary: always wire a primary-root reader — required on every success path.
  if (args.plan.record.devDependencyVersion !== undefined) {
    planArgs.readResolvedLocalPackageJson =
      args.readResolvedLocalPackageJson ?? (() => readResolvedLocalCliPackageJson(args.root));
  }
  const result = await applyPackageContributionPlan(planArgs);

  return {
    record: result.record,
    packageJson: result.packageJson,
    lockfile: result.lockfile,
    ...(result.preserved === undefined ? {} : { preserved: result.preserved }),
  };
}

/**
 * Production reader: `node_modules/poiesis-cli/package.json` under the primary
 * installation root. Returns null when absent (caller fails closed).
 */
export async function readResolvedLocalCliPackageJson(root: string): Promise<string | null> {
  const { join } = await import("node:path");
  const { exists } = await import("./fs.js");
  const { readFile } = await import("node:fs/promises");
  const path = join(root, LOCAL_CLI_PACKAGE_JSON_RELATIVE);
  if (!(await exists(path))) return null;
  return readFile(path, "utf8");
}

/**
 * Verify runtime readiness for an owned contribution without mutating files.
 * Ordinary with `devDependencyVersion`: resolved primary-root
 * `node_modules/poiesis-cli/package.json` MUST exist and equal the target —
 * a reader is required; missing/wrong fails closed (no silent skip).
 * Selfhost: `node dist/cli.js --version` equals target.
 */
export async function assertPackageContributionRuntimeReady(args: {
  record: PackageContributionRecord;
  poiesisVersion: string;
  readResolvedLocalPackageJson?: () => Promise<string | null>;
  probeSelfhostDist?: () => Promise<
    { ok: false; code: "missing" | "spawn-failed"; detail?: string } | { ok: true; stdout: string }
  >;
}): Promise<void> {
  if (args.record.projectKind === "selfhost") {
    if (args.probeSelfhostDist === undefined) {
      throw new PoiesisError(
        "SELFHOST_DIST_UNREADABLE",
        "Selfhost package contribution requires a dist probe",
        { path: SELFHOST_DIST_CLI_RELATIVE },
      );
    }
    assertSelfhostDistReady({
      expectedVersion: args.poiesisVersion,
      probe: await args.probeSelfhostDist(),
    });
    return;
  }
  if (args.record.devDependencyVersion !== undefined) {
    if (args.readResolvedLocalPackageJson === undefined) {
      throw new PoiesisError(
        "PACKAGE_LOCAL_BIN_UNRESOLVED",
        "Ordinary package contribution requires a reader for node_modules/poiesis-cli/package.json",
        { path: LOCAL_CLI_PACKAGE_JSON_RELATIVE, expectedVersion: args.record.devDependencyVersion },
      );
    }
    assertResolvedLocalCliVersion({
      expectedVersion: args.record.devDependencyVersion,
      installedPackageJson: await args.readResolvedLocalPackageJson(),
    });
  }
}

/**
 * Spec #207 / ticket #210 — pure planning seam for version-crossing config
 * updates. Given a package FS snapshot, the next runtime version, and any
 * prior owned contribution, returns the plan plus the contribution the
 * OpenCode projection and next manifest must use. Absent package.json keeps
 * the exact dlx route (no fabricated metadata). Conflicts fail closed inside
 * `planPackageContribution`.
 */
export function planPackageContributionForVersionCross(args: {
  snapshot: PackageFsSnapshot;
  nextPoiesisVersion: string;
  prior?: PackageContributionRecord | undefined;
}): {
  plan: PackageContributionPlan;
  /** Contribution for projection + next manifest; undefined ⇒ exact dlx. */
  contributionForProjection: PackageContributionRecord | undefined;
} {
  // With authenticated prior ownership, repair may version-cross the exact
  // dep. Without prior, ensure refuses foreign conflicts rather than
  // overwriting Author scripts/deps.
  const mode = args.prior !== undefined ? "repair" : "ensure";
  const planArgs: {
    snapshot: PackageFsSnapshot;
    poiesisVersion: string;
    mode: "ensure" | "repair";
    prior?: PackageContributionRecord;
  } = {
    snapshot: args.snapshot,
    poiesisVersion: args.nextPoiesisVersion,
    mode,
  };
  if (args.prior !== undefined) planArgs.prior = args.prior;
  const plan = planPackageContribution(planArgs);
  if (plan.kind === "absent") {
    return { plan, contributionForProjection: undefined };
  }
  return { plan, contributionForProjection: plan.record };
}

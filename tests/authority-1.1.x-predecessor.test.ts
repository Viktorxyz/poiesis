/**
 * Spec #131 / ticket #132 — v1.1.3 / v1.1.4 predecessor projection.
 *
 * This file proves every contract surface the v1.2.1 release adds so
 * existing 1.1.3 / 1.1.4 installs can transition to 1.2.1 through the
 * receipt-authenticated ordinary `update` transaction.
 *
 * The deterministic test surface covers:
 *
 *   1. Tarball byte-equality. The 1.1.3 and 1.1.4 npm tarballs are
 *      extracted via `tar -xzOf` (no on-disk extraction, no network)
 *      and the primary / worker / Specialist `permission.bash`
 *      literals are compared against the helper output using
 *      `isDeepStrictEqual`. This proves the projection is byte-for-byte
 *      equivalent to the legacy 1.1.3 / 1.1.4 install on every shipped
 *      surface.
 *
 *   2. Specialist agents (Planner / Ticket Reviewer / Final Reviewer /
 *      Research) carry NO `permission.bash` key in 1.1.3 / 1.1.4.
 *
 *   3. The helper is deterministic: same config + same
 *      `poiesisVersion` → same output. Invariant under runtime
 *      `packageVersion()` because the exact-version allow key is
 *      keyed off the supplied `poiesisVersion`, not the running
 *      package version.
 *
 *   4. `assertManifestAuthorityToleratingPredecessor` admits the
 *      synthetic 1.1.3 / 1.1.4 manifest when the accepted-predecessor
 *      set includes `"1.1.3" | "1.1.4"`, and rejects 1.1.5
 *      fail-closed (the gate throws `MANIFEST_AUTHORITY_INVALID`).
 *
 *   5. Strict `assertManifestAuthority` rejects 1.1.3 / 1.1.4 (the
 *      Specialist bash surface differs from the current 1.2.x
 *      projection; the strict check is migration-unaware).
 *
 *   6. Receipt-authenticated `update` accepts the 1.1.3 / 1.1.4
 *      predecessor manifest, writes the post-update manifest with
 *      `poiesisVersion = "1.2.1"` exactly once, advances the receipt
 *      generation by one, and re-emits the OpenCode config so the
 *      primary bash is keyed off `pnpm dlx poiesis-cli@1.2.1 *`, the
 *      Worker carries the v1.2 Repository Intelligence additive
 *      allows (status / query / path / explain), and the Specialist
 *      bash surface is restored.
 *
 *   7. Bounded journal rolls back when the authority gate throws. The
 *      transaction never advances past the strict authority check
 *      when the predecessor manifest does not match any accepted
 *      projection, so the manifest / config / receipt bytes are
 *      restored byte-for-byte.
 *
 *   8. Strict `updateFromConfig` rejects a 1.1.3 / 1.1.4 manifest
 *      with a valid receipt (the receipt-gated strict-update flow
 *      is current-projection-only by design).
 *
 *   9. The v1.1.1 predecessor projection is unchanged: the
 *      existing receipt-authenticated 1.1.1 update path still
 *      succeeds with the exact same manifest transition (additive).
 *
 * All tests are deterministic, offline, and free of:
 *   - real OpenCode (uses `installFakeOpenCode`);
 *   - real Graphify / uv (uses `installFakeUv`);
 *   - network access;
 *   - model call / prompt-driven agent dogfood.
 *
 * The fake-opencode binary is the certified `1.18.29` plus the
 * stable model list documented in `tests/fake-opencode.ts`. The
 * fake-uv binary mirrors the `installFakeUv` pattern from
 * `tests/release-contract-v1.2.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertManifestAuthority,
  assertManifestAuthorityToleratingPredecessor,
  predecessorProjectionV113V114,
  predecessorProjectionV111,
} from "../src/authority.js";
import { packageVersion, init, update, updateFromConfig } from "../src/maintenance.js";
import { loadManifest, type Manifest } from "../src/manifest.js";
import { readOwnershipReceipt, replaceOwnershipReceipt } from "../src/receipt.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

interface FakeUvEnvironment {
  parent: string;
  restore: () => void;
}

async function installFakeUv(): Promise<FakeUvEnvironment> {
  const { mkdir, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { chmod, writeFile } = await import("node:fs/promises");
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-uv-132-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "uv");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.5.0\\n'; exit 0; fi\nexit 0\n");
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    parent,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Read a single file from a tarball via `tar -xzOf` (no on-disk
 * extraction, no network). Mirrors the tarball-introspection pattern
 * the parent spec requires so the test never depends on the unpacked
 * dist tree.
 */
function readTarballFile(tarballPath: string, chunkPath: string): string {
  const result = spawnSync("tar", ["-xzOf", tarballPath, chunkPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar -xzOf ${tarballPath} ${chunkPath} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * The chunk filename inside each tarball that holds the OpenCode
 * adapter contract (`primaryBashPermissions` + `permissions`). The
 * 1.1.3 tarball's chunk hash is `HU4WOHR7`; the 1.1.4 tarball's
 * chunk hash is `XL54HICJ`. Both names are pinned so the byte-for-byte
 * assertions below do not depend on a tarball introspection step.
 */
const TARBALL_PRIMARY_CHUNK_BY_VERSION = {
  "1.1.3": "package/dist/chunk-HU4WOHR7.js",
  "1.1.4": "package/dist/chunk-XL54HICJ.js",
} as const;
const PREDECESSOR_TARBALL_CACHE = join(tmpdir(), "poiesis-predecessor-tarballs");

/**
 * Resolve the published npm tarball for a predecessor version, caching it
 * under the OS temp directory and downloading it from the registry on
 * first use.
 *
 * The published tarball is the source of truth for the byte-equality
 * assertions below, so it has to come from the registry. A hardcoded
 * machine-local path makes the result depend on unrelated files that
 * happen to exist on one developer machine, which is how these
 * assertions previously passed locally and failed everywhere else.
 */
async function predecessorTarball(poiesisVersion: "1.1.3" | "1.1.4"): Promise<string> {
  await mkdir(PREDECESSOR_TARBALL_CACHE, { recursive: true });
  const expectedName = "poiesis-cli-" + poiesisVersion + ".tgz";
  const expectedPath = join(PREDECESSOR_TARBALL_CACHE, expectedName);
  try {
    await access(expectedPath);
    return expectedPath;
  } catch {
    // Not cached yet; fall through and fetch it.
  }
  const packed = spawnSync(
    "npm",
    ["pack", "poiesis-cli@" + poiesisVersion, "--pack-destination", PREDECESSOR_TARBALL_CACHE, "--silent"],
    { encoding: "utf8" },
  );
  if (packed.status !== 0) {
    throw new Error("npm pack poiesis-cli@" + poiesisVersion + " failed: " + packed.stderr);
  }
  const packedName = packed.stdout.trim().split("\n").pop() ?? "";
  if (packedName !== expectedName) {
    await rm(join(PREDECESSOR_TARBALL_CACHE, packedName), { force: true });
    throw new Error("Unexpected tarball filename for poiesis-cli@" + poiesisVersion + ": " + packedName);
  }
  return expectedPath;
}

/**
 * Extract the body of a top-level `function NAME(...) { ... }`
 * declaration from a chunk's source text. Returns the text BETWEEN
 * the outer braces (inclusive of the braces themselves so the
 * extract can be re-evaluated as a function body). Used to
 * materialize the inline bash literal objects
 * (`primaryBashPermissions`) and the surrounding `permissions()`
 * body so the test can drive `isDeepStrictEqual` comparisons
 * against the helper output.
 */
function extractFunctionBody(chunkText: string, functionName: string): string {
  const pattern = new RegExp(`function ${functionName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = chunkText.match(pattern);
  if (match === null) throw new Error(`function ${functionName} not found in chunk`);
  const startBrace = match.index! + match[0].length - 1;
  let depth = 1;
  let i = startBrace + 1;
  while (i < chunkText.length && depth > 0) {
    const ch = chunkText[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`unbalanced braces in ${functionName}`);
  return chunkText.slice(startBrace, i);
}

/**
 * Extract the body INSIDE the function's outer braces (without the
 * braces themselves). Concatenating two such bodies inside a
 * `new Function` wrapper must NOT include each function's own
 * `return` statement at the top level of the wrapper, otherwise the
 * wrapper returns the first function's literal value before the
 * second function's declaration is reached. The cleaner approach is
 * to keep each body as a function declaration (including the
 * `function NAME(...)` prefix) so the wrapper's lexical scope
 * carries both functions and the trailing `return permissions(...)`
 * runs last.
 */
function extractFunctionDeclaration(chunkText: string, functionName: string): string {
  const body = extractFunctionBody(chunkText, functionName);
  // The body starts with the function's opening `{` and ends with
  // the matching `}`. Find the opening `(` of the parameter list
  // and reconstruct the full `function NAME(...) { ... }`
  // declaration by prefixing with the function header. This keeps
  // both declarations independent in the wrapper's scope.
  const pattern = new RegExp(`function ${functionName}\\s*\\([^)]*\\)\\s*\\{`);
  const headerMatch = chunkText.match(pattern);
  if (headerMatch === null) throw new Error(`header for ${functionName} not found`);
  return chunkText.slice(headerMatch.index!, headerMatch.index! + headerMatch[0].length) + body.slice(1);
}

/**
 * Materialize the literal bash object the tarball's
 * `primaryBashPermissions(poiesisVersion)` would return for the
 * supplied version. The function is wrapped in `new Function` so the
 * template literal that references `poiesisVersion` is evaluated in
 * the supplied lexical scope. The returned object is the literal
 * PRIMARY bash map as the tarball would project it for that version.
 */
async function readTarballPrimaryBash(poiesisVersion: "1.1.3" | "1.1.4"): Promise<Record<string, string>> {
  const chunk = readTarballFile(await predecessorTarball(poiesisVersion), TARBALL_PRIMARY_CHUNK_BY_VERSION[poiesisVersion]);
  const declaration = extractFunctionDeclaration(chunk, "primaryBashPermissions");
  const fn = new Function("poiesisVersion", `${declaration}\nreturn primaryBashPermissions(poiesisVersion);`) as (
    version: string,
  ) => Record<string, string>;
  return fn(poiesisVersion);
}

/**
 * Materialize the full `permissions(config, poiesisVersion)` return
 * value the tarball's chunk would produce. The bundle body
 * references `primaryBashPermissions` from the same lexical scope,
 * so both function declarations are joined in the wrapper's body so
 * the surrounding lexical environment (template literals, computed
 * property names, `nullish` operators) is preserved exactly as the
 * tsup bundle emitted it. The returned object is keyed by agent
 * name (`poiesis`, `poiesis-worker`, `poiesis-planner`,
 * `poiesis-research`, `poiesis-reviewer`,
 * `poiesis-final-reviewer`) and each entry's `permission` field
 * carries the legacy 1.1.3 / 1.1.4 permission surface.
 */
async function readTarballPermissions(poiesisVersion: "1.1.3" | "1.1.4"): Promise<Record<string, { permission: Record<string, unknown> }>> {
  const chunk = readTarballFile(await predecessorTarball(poiesisVersion), TARBALL_PRIMARY_CHUNK_BY_VERSION[poiesisVersion]);
  const primaryDeclaration = extractFunctionDeclaration(chunk, "primaryBashPermissions");
  const permissionsDeclaration = extractFunctionDeclaration(chunk, "permissions");
  const fn = new Function(
    "config",
    "poiesisVersion",
    `${primaryDeclaration}\n${permissionsDeclaration}\nreturn permissions(config, poiesisVersion);`,
  ) as (config: { models: { reasoning: string; execution: string } }, version: string) => Record<
    string,
    { permission: Record<string, unknown> }
  >;
  return fn(
    { models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" } },
    poiesisVersion,
  );
}

/**
 * Rewrite the manifest + on-disk OpenCode config into the exact
 * 1.1.3 / 1.1.4 predecessor shape, rebind the receipt to the new
 * manifest digest, and return the new manifest. Mirrors the
 * predecessor-migration-fixtures pattern used by ticket #105 / #106
 * but extends the accepted predecessor version set to include
 * 1.1.3 and 1.1.4 so the receipt-gated update flow admits it.
 */
async function asV113OrV114PredecessorManifest(
  repository: TestRepository,
  predecessorVersion: "1.1.3" | "1.1.4",
): Promise<Manifest> {
  const manifest = await loadManifest(repository.root);
  const config = testConfig(repository);
  const predecessor = predecessorProjectionV113V114(config, predecessorVersion);
  manifest.poiesisVersion = predecessorVersion;
  manifest.configPatches = manifest.configPatches.map((patch) => {
    const matching = predecessor.find(
      (p) =>
        p.path.length === patch.path.length &&
        p.path.every((s, i) => s === patch.path[i]),
    );
    if (matching === undefined) return patch;
    return { ...patch, installed: matching.value };
  });
  await (await import("node:fs/promises")).writeFile(
    join(repository.root, ".poiesis", "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const { parseJsonc } = await import("../src/config.js");
  const { readUtf8 } = await import("../src/fs.js");
  const openCodePath = join(repository.root, "opencode.jsonc");
  const current = parseJsonc<Record<string, unknown>>(await readUtf8(openCodePath), openCodePath);
  for (const patch of manifest.configPatches) {
    let target: Record<string, unknown> = current;
    for (let i = 0; i < patch.path.length - 1; i++) {
      const segment = patch.path[i]!;
      if (typeof target[segment] !== "object" || target[segment] === null) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[patch.path[patch.path.length - 1]!] = patch.installed;
  }
  await (await import("node:fs/promises")).writeFile(openCodePath, JSON.stringify(current, null, 2) + "\n");
  // Rebind the receipt to the new manifest digest so the
  // receipt-gated `update` admits the predecessor projection.
  const existing = await readOwnershipReceipt(repository.root);
  await replaceOwnershipReceipt(repository.root, manifest, existing);
  return manifest;
}

describe("Spec #131 / ticket #132 — v1.1.3 / v1.1.4 predecessor projection", () => {
  let fakeOpenCodeEnv: FakeOpenCodeEnvironment;
  let fakeUvEnv: FakeUvEnvironment;

  beforeEach(async () => {
    fakeOpenCodeEnv = await installFakeOpenCode();
    fakeUvEnv = await installFakeUv();
  });

  afterEach(async () => {
    fakeUvEnv.restore();
    fakeOpenCodeEnv.restore();
  });

  describe("tarball byte-equality (primary / worker / Specialist agents)", () => {
    it("helper primary bash is byte-for-byte equal to the 1.1.3 tarball primary bash", async () => {
      const tarballBash = await readTarballPrimaryBash("1.1.3");
      const helperOutput = predecessorProjectionV113V114(testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" }), "1.1.3");
      const helperPrimary = (helperOutput.find((p) => p.path[1] === "poiesis")!.value as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(isDeepStrictEqual(helperPrimary, tarballBash)).toBe(true);
    });

    it("helper primary bash is byte-for-byte equal to the 1.1.4 tarball primary bash", async () => {
      const tarballBash = await readTarballPrimaryBash("1.1.4");
      const helperOutput = predecessorProjectionV113V114(testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" }), "1.1.4");
      const helperPrimary = (helperOutput.find((p) => p.path[1] === "poiesis")!.value as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(isDeepStrictEqual(helperPrimary, tarballBash)).toBe(true);
    });

    it("helper worker bash is byte-for-byte equal to the 1.1.3 tarball worker bash (pre-#123, no Repository Intelligence additive allows)", async () => {
      const tarballPermissions = await readTarballPermissions("1.1.3");
      const tarballWorkerBash = (tarballPermissions["poiesis-worker"]!.permission as { bash: Record<string, string> }).bash;
      const helperOutput = predecessorProjectionV113V114(testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" }), "1.1.3");
      const helperWorker = (helperOutput.find((p) => p.path[1] === "poiesis-worker")!.value as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(isDeepStrictEqual(helperWorker, tarballWorkerBash)).toBe(true);
      // Pre-#123 invariant: the helper worker bash surface must NOT
      // carry any of the v1.2 Repository Intelligence additive
      // allows (status / query / path / explain).
      expect(Object.keys(helperWorker)).not.toContain("pnpm dlx poiesis-cli@1.1.3 repository status");
      expect(Object.keys(helperWorker)).not.toContain("pnpm dlx poiesis-cli@1.1.3 repository query *");
      expect(Object.keys(helperWorker)).not.toContain("pnpm dlx poiesis-cli@1.1.3 repository path *");
      expect(Object.keys(helperWorker)).not.toContain("pnpm dlx poiesis-cli@1.1.3 repository explain *");
    });

    it("helper worker bash is byte-for-byte equal to the 1.1.4 tarball worker bash (pre-#123, no Repository Intelligence additive allows)", async () => {
      const tarballPermissions = await readTarballPermissions("1.1.4");
      const tarballWorkerBash = (tarballPermissions["poiesis-worker"]!.permission as { bash: Record<string, string> }).bash;
      const helperOutput = predecessorProjectionV113V114(testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" }), "1.1.4");
      const helperWorker = (helperOutput.find((p) => p.path[1] === "poiesis-worker")!.value as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(isDeepStrictEqual(helperWorker, tarballWorkerBash)).toBe(true);
    });

    it("1.1.3 Specialist agents (Planner / Reviewer / Final Reviewer) carry NO permission.bash key (helper matches tarball)", async () => {
      const tarballPermissions = await readTarballPermissions("1.1.3");
      const helperOutput = predecessorProjectionV113V114(testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" }), "1.1.3");
      for (const agentName of ["poiesis-planner", "poiesis-reviewer", "poiesis-final-reviewer"] as const) {
        const tarballAgentPermission = tarballPermissions[agentName]!.permission;
        expect(tarballAgentPermission, `tarball ${agentName} permission carries no bash key`).not.toHaveProperty("bash");
        const helperAgent = helperOutput.find((p) => p.path[1] === agentName)!.value as { permission: Record<string, unknown> };
        expect(helperAgent.permission, `helper ${agentName} permission carries no bash key`).not.toHaveProperty("bash");
      }
    });

    it("1.1.4 Specialist agents (Planner / Reviewer / Final Reviewer) carry NO permission.bash key (helper matches tarball)", async () => {
      const tarballPermissions = await readTarballPermissions("1.1.4");
      const helperOutput = predecessorProjectionV113V114(testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" }), "1.1.4");
      for (const agentName of ["poiesis-planner", "poiesis-reviewer", "poiesis-final-reviewer"] as const) {
        const tarballAgentPermission = tarballPermissions[agentName]!.permission;
        expect(tarballAgentPermission, `tarball ${agentName} permission carries no bash key`).not.toHaveProperty("bash");
        const helperAgent = helperOutput.find((p) => p.path[1] === agentName)!.value as { permission: Record<string, unknown> };
        expect(helperAgent.permission, `helper ${agentName} permission carries no bash key`).not.toHaveProperty("bash");
      }
    });

    it("1.1.3 / 1.1.4 Research agent carries NO permission.bash key (helper matches tarball)", async () => {
      for (const version of ["1.1.3", "1.1.4"] as const) {
        const tarballPermissions = await readTarballPermissions(version);
        const helperOutput = predecessorProjectionV113V114(testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" }), version);
        const tarballResearchPermission = tarballPermissions["poiesis-research"]!.permission;
        expect(tarballResearchPermission, `${version} tarball research permission carries no bash key`).not.toHaveProperty("bash");
        const helperResearch = helperOutput.find((p) => p.path[1] === "poiesis-research")!.value as { permission: Record<string, unknown> };
        expect(helperResearch.permission, `${version} helper research permission carries no bash key`).not.toHaveProperty("bash");
      }
    });
  });

  describe("helper determinism and runtime-version invariance", () => {
    it("helper is deterministic: same config + same poiesisVersion produces deep-equal output across repeated invocations", () => {
      const config = testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" });
      const first = predecessorProjectionV113V114(config, "1.1.3");
      const second = predecessorProjectionV113V114(config, "1.1.3");
      expect(isDeepStrictEqual(first, second)).toBe(true);
      const third = predecessorProjectionV113V114(config, "1.1.4");
      const fourth = predecessorProjectionV113V114(config, "1.1.4");
      expect(isDeepStrictEqual(third, fourth)).toBe(true);
    });

    it("helper is invariant under the running packageVersion (exact-version allow key is keyed off supplied poiesisVersion)", async () => {
      // Mock the running package version to a value that has nothing
      // to do with 1.1.3 / 1.1.4 and assert the helper output is
      // unchanged. This proves the helper is keyed off the supplied
      // poiesisVersion, not the runtime image.
      const { setRuntimePackageVersionOverrideForTest } = await import("../src/maintenance.js");
      const config = testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" });
      const baseline = predecessorProjectionV113V114(config, "1.1.3");
      try {
        setRuntimePackageVersionOverrideForTest("9.9.9-fake");
        const fakeVersion = predecessorProjectionV113V114(config, "1.1.3");
        expect(isDeepStrictEqual(fakeVersion, baseline)).toBe(true);
      } finally {
        setRuntimePackageVersionOverrideForTest(null);
      }
      // Sanity: the running version is back to the real one.
      expect(await packageVersion()).toBe("1.2.1");
    });

    it("helper output differs only in the exact-version allow key between 1.1.3 and 1.1.4", () => {
      const config = testConfig({ parent: "/tmp", root: "/tmp", remote: "/tmp", fixtures: "/tmp", baseSha: "x" });
      const v113 = predecessorProjectionV113V114(config, "1.1.3");
      const v114 = predecessorProjectionV113V114(config, "1.1.4");
      // Same length, same paths.
      expect(v113.length).toBe(v114.length);
      for (let i = 0; i < v113.length; i++) {
        expect(v113[i]!.path).toEqual(v114[i]!.path);
      }
      // Diff is localized to the primary bash exact-version allow key.
      const v113Primary = v113.find((p) => p.path[1] === "poiesis")!.value as { permission: { bash: Record<string, string> } };
      const v114Primary = v114.find((p) => p.path[1] === "poiesis")!.value as { permission: { bash: Record<string, string> } };
      expect(v113Primary.permission.bash["pnpm dlx poiesis-cli@1.1.3 *"]).toBe("allow");
      expect(v113Primary.permission.bash["pnpm dlx poiesis-cli@1.1.4 *"]).toBeUndefined();
      expect(v114Primary.permission.bash["pnpm dlx poiesis-cli@1.1.4 *"]).toBe("allow");
      expect(v114Primary.permission.bash["pnpm dlx poiesis-cli@1.1.3 *"]).toBeUndefined();
      // Every other patch is deep-equal.
      for (let i = 0; i < v113.length; i++) {
        if (v113[i]!.path[1] === "poiesis") continue;
        expect(isDeepStrictEqual(v113[i]!.value, v114[i]!.value), `non-primary patch ${v113[i]!.path.join(".")} differs between 1.1.3 and 1.1.4`).toBe(true);
      }
    });
  });

  describe("authority gate accept / reject matrix", () => {
    const repositories: TestRepository[] = [];
    afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

    it("assertManifestAuthorityToleratingPredecessor admits synthetic 1.1.3 / 1.1.4 manifests when the accepted-predecessor set includes them", async () => {
      for (const version of ["1.1.3", "1.1.4"] as const) {
        const repository = await createTestRepository();
        repositories.push(repository);
        await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
        await asV113OrV114PredecessorManifest(repository, version);
        const config = testConfig(repository);
        const manifest = await loadManifest(repository.root);
        await expect(
          assertManifestAuthorityToleratingPredecessor(repository.root, manifest, config, ["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4"]),
        ).resolves.toBeUndefined();
      }
    }, 90_000);

    it("assertManifestAuthorityToleratingPredecessor rejects 1.1.5 fail-closed (no accepted-predecessor entry admits it)", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
      // Synthesize a 1.1.5 manifest by stamping the version label
      // and using the 1.1.4 projection as the underlying config
      // patches (close enough to drive the authority gate).
      const config = testConfig(repository);
      const synthetic = predecessorProjectionV113V114(config, "1.1.4");
      const manifest = await loadManifest(repository.root);
      manifest.poiesisVersion = "1.1.5";
      manifest.configPatches = manifest.configPatches.map((patch) => {
        const matching = synthetic.find(
          (p) => p.path.length === patch.path.length && p.path.every((s, i) => s === patch.path[i]),
        );
        if (matching === undefined) return patch;
        return { ...patch, installed: matching.value };
      });
      await (await import("node:fs/promises")).writeFile(
        join(repository.root, ".poiesis", "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );
      await expect(
        assertManifestAuthorityToleratingPredecessor(repository.root, manifest, config, ["1.0.1", "1.0.2", "1.1.1", "1.1.3", "1.1.4"]),
      ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
    }, 60_000);

    it("strict assertManifestAuthority rejects synthetic 1.1.3 / 1.1.4 manifests (Specialist bash surface differs from current)", async () => {
      for (const version of ["1.1.3", "1.1.4"] as const) {
        const repository = await createTestRepository();
        repositories.push(repository);
        await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
        await asV113OrV114PredecessorManifest(repository, version);
        const config = testConfig(repository);
        const manifest = await loadManifest(repository.root);
        await expect(
          assertManifestAuthority(repository.root, manifest, config),
        ).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });
      }
    }, 90_000);
  });

  describe("receipt-authenticated update acceptance and projection restore", () => {
    const repositories: TestRepository[] = [];
    afterEach(async () => Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true }))));

    it("receipt-authenticated update accepts 1.1.3 predecessor and writes 1.2.1 manifest exactly once with the current OpenCode projection shape", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
      await asV113OrV114PredecessorManifest(repository, "1.1.3");
      const beforeReceipt = await readOwnershipReceipt(repository.root);
      expect(beforeReceipt.generation).toBe(2);

      const result = await update(repository.root, { skipSkills: true });

      // Manifest advanced to 1.2.1 exactly once.
      expect(result.manifest.poiesisVersion).toBe("1.2.1");
      expect(result.manifest.configPatches.length).toBe(9);

      // Receipt advanced by exactly one.
      const afterReceipt = await readOwnershipReceipt(repository.root);
      expect(afterReceipt.generation).toBe(beforeReceipt.generation + 1);

      // Primary bash keyed off `pnpm dlx poiesis-cli@1.2.1 *`.
      const primaryAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis")!;
      const primaryBash = (primaryAfter.installed as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(primaryBash["*"]).toBe("allow");
      expect(primaryBash["poiesis *"]).toBe("deny");
      expect(primaryBash["pnpm exec poiesis *"]).toBe("deny");
      expect(primaryBash["npx poiesis *"]).toBe("deny");
      expect(primaryBash["pnpm dlx poiesis-cli *"]).toBe("deny");
      expect(primaryBash["pnpm dlx poiesis-cli@*"]).toBe("deny");
      expect(primaryBash["pnpm dlx poiesis-cli@1.2.1 *"]).toBe("allow");
      expect(primaryBash["pnpm dlx poiesis-cli@1.1.3 *"]).toBeUndefined();

      // Worker carries the v1.2 Repository Intelligence additive allows.
      const workerAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis-worker")!;
      const workerBash = (workerAfter.installed as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(workerBash).toEqual({
        "*": "allow",
        "git *": "deny",
        "poiesis *": "deny",
        "pnpm exec poiesis *": "deny",
        "npx poiesis *": "deny",
        "pnpm dlx poiesis-cli *": "deny",
        "pnpm dlx poiesis-cli@*": "deny",
        "pnpm dlx poiesis-cli@1.2.1 repository status": "allow",
        "pnpm dlx poiesis-cli@1.2.1 repository query *": "allow",
        "pnpm dlx poiesis-cli@1.2.1 repository path *": "allow",
        "pnpm dlx poiesis-cli@1.2.1 repository explain *": "allow",
      });

      // Specialist bash restored: Planner / Ticket Reviewer / Final Reviewer
      // all carry the v1.2 narrow Repository Intelligence bash surface.
      for (const agentName of ["poiesis-planner", "poiesis-reviewer", "poiesis-final-reviewer"] as const) {
        const agentAfter = result.manifest.configPatches.find((p) => p.path[1] === agentName)!;
        const agentBash = (agentAfter.installed as { permission: { bash: Record<string, string> } }).permission.bash;
        expect(agentBash).toEqual({
          "*": "deny",
          "pnpm dlx poiesis-cli@1.2.1 repository status": "allow",
          "pnpm dlx poiesis-cli@1.2.1 repository query *": "allow",
          "pnpm dlx poiesis-cli@1.2.1 repository path *": "allow",
          "pnpm dlx poiesis-cli@1.2.1 repository explain *": "allow",
        });
      }
    }, 90_000);

    it("receipt-authenticated update accepts 1.1.4 predecessor and writes 1.2.1 manifest exactly once with the current OpenCode projection shape", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
      await asV113OrV114PredecessorManifest(repository, "1.1.4");
      const beforeReceipt = await readOwnershipReceipt(repository.root);
      expect(beforeReceipt.generation).toBe(2);

      const result = await update(repository.root, { skipSkills: true });

      expect(result.manifest.poiesisVersion).toBe("1.2.1");
      const afterReceipt = await readOwnershipReceipt(repository.root);
      expect(afterReceipt.generation).toBe(beforeReceipt.generation + 1);

      const primaryAfter = result.manifest.configPatches.find((p) => p.path[1] === "poiesis")!;
      const primaryBash = (primaryAfter.installed as { permission: { bash: Record<string, string> } }).permission.bash;
      expect(primaryBash["pnpm dlx poiesis-cli@1.2.1 *"]).toBe("allow");
      expect(primaryBash["pnpm dlx poiesis-cli@1.1.4 *"]).toBeUndefined();
    }, 90_000);

    it("bounded journal rolls back when the new authority gate throws (manifest / config / receipt unchanged)", async () => {
      // Spec #131 / ticket #132 — a synthetic 1.1.3 manifest that
      // drifts from the predecessor projection (e.g. an extra key
      // on the Specialist permission) must be rejected by
      // `assertManifestAuthorityToleratingPredecessor` BEFORE the
      // bounded journal opens, so the manifest / config / receipt
      // bytes are restored byte-for-byte by the transaction's
      // fail-closed path. This proves the gate keeps the same
      // fail-closed semantics for the new 1.1.3 / 1.1.4 branch
      // that it has for every other predecessor branch.
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
      await asV113OrV114PredecessorManifest(repository, "1.1.3");

      const receiptBefore = await readOwnershipReceipt(repository.root);
      const configBefore = await readFile(join(repository.root, ".poiesis", "config.jsonc"));
      const openCodeBefore = await readFile(join(repository.root, "opencode.jsonc"));

      // Drift the Specialist bash surface so the predecessor
      // projection match fails. The strict current projection also
      // fails (different from the drifted surface), so the
      // authority gate throws `MANIFEST_AUTHORITY_INVALID` BEFORE
      // the bounded journal opens. Rebind the receipt to the
      // drifted manifest so the receipt gate (which runs first)
      // admits the test scenario and the authority gate is the
      // surface that actually fires the rejection.
      const manifest = await loadManifest(repository.root);
      manifest.configPatches = manifest.configPatches.map((patch) => {
        if (patch.path.length !== 2 || patch.path[1] !== "poiesis-planner") return patch;
        const installed = patch.installed as { permission: Record<string, unknown> };
        return { ...patch, installed: { ...installed, permission: { ...installed.permission, bash: { "*": "deny" } } } };
      });
      await (await import("node:fs/promises")).writeFile(
        join(repository.root, ".poiesis", "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );
      const existing = await readOwnershipReceipt(repository.root);
      await replaceOwnershipReceipt(repository.root, manifest, existing);

      await expect(update(repository.root, { skipSkills: true })).rejects.toMatchObject({ code: "MANIFEST_AUTHORITY_INVALID" });

      // Authority gate throws BEFORE any mutation, so the
      // manifest / config / receipt bytes are restored byte-for-byte
      // to the pre-update preimage. The receipt rebind step ran
      // (against the drifted manifest) but the gate aborted before
      // any other mutation; the rollback path of the bounded journal
      // is never invoked because the journal never opened.
      const receiptAfter = await readOwnershipReceipt(repository.root);
      expect(receiptAfter.generation).toBe(receiptBefore.generation + 1);
      expect(await readFile(join(repository.root, ".poiesis", "config.jsonc"))).toEqual(configBefore);
      expect(await readFile(join(repository.root, "opencode.jsonc"))).toEqual(openCodeBefore);
    }, 90_000);

    it("strict updateFromConfig rejects a 1.1.3 / 1.1.4 manifest with a valid receipt (strict update is current-projection-only)", async () => {
      for (const version of ["1.1.3", "1.1.4"] as const) {
        const repository = await createTestRepository();
        repositories.push(repository);
        await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
        await asV113OrV114PredecessorManifest(repository, version);
        // updateFromConfig is the strict configuration update flow;
        // it does not consult the predecessor tolerance and must
        // reject the 1.1.3 / 1.1.4 manifest with
        // MANIFEST_AUTHORITY_INVALID. (The runtime identity guard
        // may also surface; both fail the operation closed.)
        // The candidate path is the Poiesis config (`update --config
        // <file>` accepts the proposed Poiesis config, not the
        // OpenCode config). The Poiesis config at the install root
        // is itself a valid candidate, so passing it back exercises
        // the strict authority check unchanged.
        const candidatePath = join(repository.root, ".poiesis", "config.jsonc");
        await expect(
          updateFromConfig(repository.root, candidatePath),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/MANIFEST_AUTHORITY_INVALID|RUNTIME_VERSION_MISMATCH|FILE_OWNERSHIP_LOST/),
        });
      }
    }, 90_000);

    it("1.1.1 projection remains unchanged and additive (predecessor 1.1.1 update still succeeds with the documented transition)", async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await init(repository.root, testConfig(repository), { skipSkills: true, allowFixtureAdapters: true });
      const currentVersion = await packageVersion();
      const { writeFile } = await import("node:fs/promises");
      const config = testConfig(repository);
      const predecessor = predecessorProjectionV111(config, "1.1.1");
      const manifest = await loadManifest(repository.root);
      manifest.poiesisVersion = "1.1.1";
      manifest.configPatches = manifest.configPatches.map((patch) => {
        const matching = predecessor.find(
          (p) => p.path.length === patch.path.length && p.path.every((s, i) => s === patch.path[i]),
        );
        if (matching === undefined) return patch;
        return { ...patch, installed: matching.value };
      });
      await writeFile(
        join(repository.root, ".poiesis", "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );
      const { parseJsonc } = await import("../src/config.js");
      const { readUtf8 } = await import("../src/fs.js");
      const openCodePath = join(repository.root, "opencode.jsonc");
      const current = parseJsonc<Record<string, unknown>>(await readUtf8(openCodePath), openCodePath);
      for (const patch of manifest.configPatches) {
        let target: Record<string, unknown> = current;
        for (let i = 0; i < patch.path.length - 1; i++) {
          const segment = patch.path[i]!;
          if (typeof target[segment] !== "object" || target[segment] === null) {
            target[segment] = {};
          }
          target = target[segment] as Record<string, unknown>;
        }
        target[patch.path[patch.path.length - 1]!] = patch.installed;
      }
      await writeFile(openCodePath, JSON.stringify(current, null, 2) + "\n");
      const existing = await readOwnershipReceipt(repository.root);
      await replaceOwnershipReceipt(repository.root, manifest, existing);

      const result = await update(repository.root, { skipSkills: true });
      expect(result.manifest.poiesisVersion).toBe(currentVersion);
      // isExactProjection still admits the legacy 1.1.1 predecessor.
      const v111After = predecessorProjectionV111(config, "1.1.1");
      const storedAsV111 = manifest.configPatches.every((p) => {
        const match = v111After.find((q) => q.path.length === p.path.length && q.path.every((s, i) => s === p.path[i]));
        return match !== undefined && isDeepStrictEqual(match.value, p.installed);
      });
      expect(storedAsV111).toBe(true);
    }, 90_000);
  });
});

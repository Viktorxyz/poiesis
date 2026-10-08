/**
 * Spec #139 / ticket #162 — the Poiesis-owned generated delivery runtime.
 *
 * A generated delivery target writes its artifact under
 * `.poiesis/runtime/delivery/<target>/<sha>/delivery.json`. Before this
 * ticket nothing owned that subtree: it was not an ignore rule, not a
 * manifest record, not a known `.poiesis` path, and had no removal path.
 * Its only consequence was that its residue showed up as untracked work,
 * which blocked `workspace cleanup` with `DIRTY_WORKSPACE_CLEANUP_FORBIDDEN`
 * and blocked a complete uninstall with "unknown content under .poiesis".
 *
 * The boundaries under test, each naming the production break it catches:
 *
 *   1. EXACT IGNORE RULE — fresh init, the receipt-authenticated `update`,
 *      and the explicit 1.0.0 `bootstrap` each reconcile ONE rule for
 *      `.poiesis/runtime/delivery/`, and never claim all of
 *      `.poiesis/runtime/`. Break: an ignore of the whole runtime container
 *      would hide state Poiesis does not own.
 *   2. NOT A MANAGED RECORD — the runtime is never a manifest file and
 *      never a durable tracked path. Break: recording it would make
 *      derived state a managed artifact with hash-gated uninstall.
 *   3. CLEAN EXECUTION — running the installed default command for each
 *      target creates the artifact while `git status` is byte-identical to
 *      its pre-run value. Break: an unignored artifact is untracked work.
 *   4. LINKED WORKSPACE — the same execution inside a linked worktree that
 *      carries the rule leaves `git status` empty, which is the exact
 *      predicate `workspace cleanup` gates on. The negative control proves
 *      the assertion is not vacuous.
 *   5. OWNED-ONLY UNINSTALL — uninstall removes the complete owned delivery
 *      subtree and an empty runtime parent.
 *   6. FOREIGN SIBLINGS — a foreign `.poiesis/runtime/` sibling survives
 *      byte-for-byte, is reported as preserved, and keeps uninstall
 *      incomplete with the ownership receipt retained.
 *   7. SYMLINK REFUSAL — a symlinked runtime container, delivery root, or
 *      delivery descendant is never traversed or deleted, and yields a safe
 *      refusal that keeps the installation intact.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, uninstall, update } from "../src/maintenance.js";
import {
  DELIVERY_RUNTIME_CONTAINER,
  DELIVERY_RUNTIME_IGNORE_RULE,
  DELIVERY_RUNTIME_OWNED_ENTRY,
  DELIVERY_RUNTIME_RELATIVE,
  removeValidatedDeliveryRuntime,
} from "../src/delivery-runtime.js";
import { loadManifest } from "../src/manifest.js";
import { parseManagedIgnoreBlocks } from "../src/install-mode.js";
import { readOwnershipReceipt, manifestDigest, ownershipReceiptExists } from "../src/receipt.js";
import { resolveTree } from "../src/git.js";
import { run } from "../src/process.js";
import { parseJsonc } from "../src/config.js";
import { readUtf8 } from "../src/fs.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { asLegacyProjection } from "./legacy-bootstrap-fixture.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

// -- The exact contract under test -----------------------------------------
//
// The expectations below are LITERALS, not the production constants. Every
// assertion is therefore made against what an installed project actually has
// on disk, so a drifted constant (a broader `.poiesis/runtime/` container
// rule, a narrower path, a renamed entry) fails these tests instead of
// quietly redefining the contract they are meant to pin.
const EXPECTED_IGNORE_RULE = ".poiesis/runtime/delivery/";
const EXPECTED_OWNED_ENTRY = "delivery";
const EXPECTED_RUNTIME_RELATIVE = ".poiesis/runtime/delivery";
const EXPECTED_RUNTIME_CONTAINER = ".poiesis/runtime";

interface ForeignBinEnvironment {
  parent: string;
  /** Every `gh` invocation the stub received, one argument string per line. */
  ghLog: string;
  restore: () => void;
}

/**
 * A `gh` stub whose `auth status` FAILS, so the generated `preview` target
 * takes its local-artifact path and never attempts a real Change Request.
 * Every invocation is appended to `ghLog` so a test can prove the script
 * never reached a remote-facing step.
 */
async function installForeignBinStubs(): Promise<ForeignBinEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-foreign-bin-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const ghLog = join(parent, "gh-invocations.log");
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
case "$1" in
  auth) exit 1 ;;
  pr) printf 'gh stub must not be asked to open a change request\\n' >&2; exit 97 ;;
esac
exit 1
`,
  );
  await chmod(gh, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = previous === undefined || previous === "" ? bin : `${bin}:${previous}`;
  let restored = false;
  return {
    parent,
    ghLog,
    restore: () => {
      if (restored) return;
      restored = true;
      process.env.PATH = previous;
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function gitignoreLines(root: string): Promise<string[]> {
  return (await readFile(join(root, ".gitignore"), "utf8")).split(/\r?\n/);
}

/** Remove the delivery-runtime rule (and nothing else) from `.gitignore`. */
async function stripDeliveryRuntimeRule(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  const kept = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== EXPECTED_IGNORE_RULE)
    .filter((line) => !line.includes("generated delivery runtime state"));
  await writeFile(path, kept.join("\n"));
}

/**
 * Spec #190 / ticket #196 — remove the WHOLE Poiesis-managed ignore block and
 * nothing else, located through the product's own parser so the helper cannot
 * drift from the delimiters the block really uses.
 *
 * This is NOT what `stripDeliveryRuntimeRule` does, and the difference is the
 * whole point of the negative control below: the #190 classification is closed
 * over `.poiesis/`, so a block that still states `.poiesis/` keeps hiding
 * delivery residue even with the one owned-subtree rule deleted. A branch that
 * carries no Poiesis policy at all is the state in which generated state IS
 * untracked work.
 */
async function stripManagedIgnoreBlock(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  const content = await readFile(path, "utf8");
  const [block] = parseManagedIgnoreBlocks(content);
  if (block === undefined) throw new Error(`expected exactly one Poiesis-managed ignore block at ${path}`);
  const lines = content.split("\n");
  lines.splice(block.startIndex, block.endIndex - block.startIndex + 1);
  await writeFile(path, lines.join("\n"));
}

/**
 * Spec #190: the ONE managed block ignores the whole `.poiesis/` root, so a
 * linked worktree of an installed branch is a checkout of the shared
 * Git-visible surface only — exactly what a teammate's fresh clone receives.
 * It gets its own installation the way that clone does, by running `init`
 * there: Poiesis installs into the checkout it is invoked in, and the
 * ownership receipt is keyed by workspace real path, so this is an ordinary
 * first-class installation rather than a copy of the primary's records.
 */
async function installLinkedWorkspace(repository: TestRepository, root: string): Promise<void> {
  await init(root, testConfig(repository, { withDelivery: false }), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

/**
 * Install a project whose installed config resolves to the GENERATED
 * default delivery targets (`scripts/poiesis-<target>.mjs`), which is the
 * shape a fresh project with no delivery block gets.
 */
async function installWithGeneratedTargets(repository: TestRepository): Promise<void> {
  await init(repository.root, testConfig(repository, { withDelivery: false }), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

/** The argv the INSTALLED config records for one delivery target. */
async function installedTargetCommand(root: string, target: string): Promise<string[]> {
  const path = join(root, ".poiesis", "config.jsonc");
  const config = parseJsonc<{ delivery: Record<string, { adapter: string; command: string[] }> }>(
    await readUtf8(path),
    path,
  );
  return config.delivery[target]!.command;
}

/**
 * Run one delivery target exactly as the command adapter does: the installed
 * argv with `{sha}` / `{target}` substituted, executed with the workspace as
 * its working directory and the runtime's candidate environment.
 *
 * Spec #139 / ticket #165 made `POIESIS_DELIVERY_IDENTITY` REQUIRED for a
 * promotion: `staging` extends a Preview receipt and `production` extends a
 * Staging one, and either refuses to write a record it cannot bind to a real
 * artifact. The source identity is therefore passed in rather than assumed,
 * exactly as `CommandDeliveryAdapter.execute` supplies it.
 */
async function runInstalledTarget(
  root: string,
  target: string,
  sha: string,
  sourceIdentity?: unknown,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const command = await installedTargetCommand(root, target);
  const argv = command.map((argument) =>
    argument === "{sha}" ? sha : argument === "{target}" ? target : argument,
  );
  const result = await run(argv[0]!, argv.slice(1), {
    cwd: root,
    env: {
      POIESIS_CANDIDATE_SHA: sha,
      POIESIS_CANDIDATE_TREE: await resolveTree(root, sha),
      POIESIS_DELIVERY_TARGET: target,
      ...(sourceIdentity === undefined ? {} : { POIESIS_DELIVERY_IDENTITY: JSON.stringify(sourceIdentity) }),
    },
    allowFailure: true,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run the installed default for all three targets as the real chain does, each
 * one extending the receipt the target before it produced, and return those
 * receipts. Every target must succeed, so a refusal fails the caller here
 * rather than silently leaving an uninspected residue behind.
 */
async function runInstalledTargets(root: string, sha: string): Promise<Record<string, Record<string, unknown>>> {
  const receipts: Record<string, Record<string, unknown>> = {};
  for (const target of ["preview", "staging", "production"]) {
    const source = target === "staging" ? receipts.preview : target === "production" ? receipts.staging : undefined;
    const outcome = await runInstalledTarget(root, target, sha, source);
    expect(outcome.exitCode, `${target} target refused: ${outcome.stderr}`).toBe(0);
    receipts[target] = JSON.parse(outcome.stdout) as Record<string, unknown>;
  }
  return receipts;
}

async function gitStatusPorcelain(cwd: string): Promise<string> {
  const result = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  return result.stdout;
}

/** Materialize the artifact a generated delivery target would have left. */
async function writeDeliveryArtifact(root: string, target: string, sha: string): Promise<void> {
  const artifactDir = join(root, EXPECTED_RUNTIME_RELATIVE, target, sha);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "delivery.json"), `${JSON.stringify({ target, candidateSha: sha }, null, 2)}\n`);
}

// =========================================================================
// 1 + 2 + 3 + 4. The exact ignore rule, the ownership boundary, and the
// clean-execution / linked-workspace consequences.
// =========================================================================

describe("generated delivery runtime ownership", () => {
  const repositories: TestRepository[] = [];
  const foreignBins: ForeignBinEnvironment[] = [];
  let openCode: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    openCode = await installFakeOpenCode();
  });

  afterEach(async () => {
    openCode?.restore();
    for (const environment of foreignBins.splice(0)) environment.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("reconciles exactly one delivery-runtime ignore rule on fresh init", async () => {
    // Break: an ignore of the whole `.poiesis/runtime/` container would hide
    // state Poiesis does not own; no rule at all would leave every generated
    // artifact as untracked work.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);

    const lines = await gitignoreLines(repository.root);
    expect(lines.filter((line) => line.trim() === EXPECTED_IGNORE_RULE)).toHaveLength(1);
    // The container itself stays visible: Poiesis owns ONE subtree, not all
    // runtime state.
    expect(lines.map((line) => line.trim())).not.toContain(EXPECTED_RUNTIME_CONTAINER + "/");
    expect(lines.map((line) => line.trim())).not.toContain(EXPECTED_RUNTIME_CONTAINER);
  }, 60_000);

  it("reconciles the delivery-runtime ignore rule on a receipt-authenticated update", async () => {
    // Break: an update that did not re-reconcile the rule would leave an
    // existing project permanently dirty after its next delivery run.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);
    await stripDeliveryRuntimeRule(repository.root);
    expect((await gitignoreLines(repository.root)).map((line) => line.trim())).not.toContain(
      EXPECTED_IGNORE_RULE,
    );

    await update(repository.root, { skipSkills: true });

    const lines = (await gitignoreLines(repository.root)).map((line) => line.trim());
    expect(lines).toContain(EXPECTED_IGNORE_RULE);
    expect(lines).not.toContain(EXPECTED_RUNTIME_CONTAINER + "/");
  }, 60_000);

  it("reconciles the delivery-runtime ignore rule on the explicit 1.0.0 bootstrap", async () => {
    // Break: the explicit bootstrap transaction is a supported update path;
    // leaving the rule off it would strand a migrated project.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);
    await asLegacyProjection(repository.root, "1.0.0");
    await stripDeliveryRuntimeRule(repository.root);

    await update(repository.root, { skipSkills: true, bootstrapLegacyOwnership: true });

    const lines = (await gitignoreLines(repository.root)).map((line) => line.trim());
    expect(lines).toContain(EXPECTED_IGNORE_RULE);
    expect(lines).not.toContain(EXPECTED_RUNTIME_CONTAINER + "/");
  }, 60_000);

  it("keeps the delivery runtime out of the manifest and out of the durable tracked paths", async () => {
    // Break: recording the derived subtree as a managed file would make it
    // hash-gated uninstall state instead of rebuildable local state.
    const repository = await createTestRepository();
    repositories.push(repository);
    foreignBins.push(await installForeignBinStubs());
    await installWithGeneratedTargets(repository);

    await runInstalledTargets(repository.root, repository.baseSha);

    const manifest = await loadManifest(repository.root);
    const recorded = manifest.files.map((file) => file.path);
    expect(recorded.filter((path) => path.startsWith(EXPECTED_RUNTIME_CONTAINER))).toEqual([]);
    expect(recorded.filter((path) => path.includes("runtime"))).toEqual([]);
    // Nothing durable is claimed either, so the rule can never be inverted by
    // an `!`-prefixed durable entry.
    expect(manifest.files.filter((file) => file.durable === true).map((file) => file.path)).not.toContain(
      EXPECTED_IGNORE_RULE,
    );
  }, 60_000);

  it("leaves git status unchanged when the default preview, staging and production targets run", async () => {
    // Break: an unignored artifact is untracked work in the Author's project.
    const repository = await createTestRepository();
    repositories.push(repository);
    const foreign = await installForeignBinStubs();
    foreignBins.push(foreign);
    await installWithGeneratedTargets(repository);
    const before = await gitStatusPorcelain(repository.root);

    // The whole installed chain, so every target's residue is on disk before
    // `git status` is compared with its pre-run value.
    const receipts = await runInstalledTargets(repository.root, repository.baseSha);

    for (const target of ["preview", "staging", "production"]) {
      expect(receipts[target]).toMatchObject({ target, candidateSha: repository.baseSha });
      await expect(
        readFile(join(repository.root, EXPECTED_RUNTIME_RELATIVE, target, repository.baseSha, "delivery.json"), "utf8"),
      ).resolves.toContain(`"candidateSha": "${repository.baseSha}"`);
    }

    expect(await gitStatusPorcelain(repository.root)).toBe(before);
    // The preview target probed `gh auth status` through the stub and got a
    // refusal, so it never reached the remote-facing Change Request step.
    const ghInvocations = await readFile(foreign.ghLog, "utf8");
    expect(ghInvocations).not.toContain("pr create");
  }, 60_000);

  it("leaves a linked workspace clean after a delivery run, and dirties it when the ignore policy is absent", async () => {
    // Break: `workspace cleanup` gates on `git status --porcelain -z
    // --untracked-files=all` being empty. Runtime residue made that
    // impossible, so a delivered workspace could never be cleaned up.
    const repository = await createTestRepository();
    repositories.push(repository);
    const foreign = await installForeignBinStubs();
    foreignBins.push(foreign);
    await installWithGeneratedTargets(repository);
    // Spec #190: the ONLY thing this install stages is the managed ignore
    // block, so a linked worktree of this branch carries no `.poiesis/` at
    // all — the same starting point a teammate's fresh clone gets.
    await run("git", ["add", "-A"], { cwd: repository.root });
    await run("git", ["commit", "--quiet", "-m", "install"], { cwd: repository.root });

    const owned = join(repository.parent, "linked-owned");
    await run("git", ["worktree", "add", "--quiet", "-b", "poiesis/owned", owned], { cwd: repository.root });
    expect(await pathExists(join(owned, EXPECTED_RUNTIME_CONTAINER))).toBe(false);
    await installLinkedWorkspace(repository, owned);
    // Installing into the linked worktree is invisible to Git there too: the
    // committed block is the whole Poiesis surface, so the policy is proven
    // to hold for a workspace Poiesis did not create the block in.
    expect(await gitStatusPorcelain(owned)).toBe("");
    expect(await runInstalledTarget(owned, "preview", repository.baseSha)).toMatchObject({ exitCode: 0 });
    expect(await gitStatusPorcelain(owned)).toBe("");

    // Negative control: the same execution on a branch that carries NO
    // Poiesis-managed ignore block dirties the workspace, so the clean
    // assertion above is not vacuously true. The installation is kept (and
    // force-tracked, the way a pre-#190 checkout carried it), so the ONLY
    // difference from the owned worktree is the ignore policy itself.
    const unguarded = join(repository.parent, "linked-unguarded");
    await run("git", ["worktree", "add", "--quiet", "-b", "poiesis/unguarded", unguarded], { cwd: repository.root });
    await installLinkedWorkspace(repository, unguarded);
    await stripManagedIgnoreBlock(unguarded);
    await run("git", ["add", "-f", "-A"], { cwd: unguarded });
    await run("git", ["commit", "--quiet", "-m", "drop the ignore policy"], { cwd: unguarded });
    expect(await gitStatusPorcelain(unguarded)).toBe("");
    expect(await runInstalledTarget(unguarded, "preview", repository.baseSha)).toMatchObject({ exitCode: 0 });
    expect(await gitStatusPorcelain(unguarded)).toContain(EXPECTED_RUNTIME_RELATIVE);
  }, 120_000);
});

// =========================================================================
// The module contract itself, independent of the uninstall surface.
// =========================================================================

describe("removeValidatedDeliveryRuntime", () => {
  async function makeProjectRoot(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "poiesis-delivery-runtime-"));
  }

  it("publishes the exact owned path, container, entry, and ignore rule", () => {
    // Break: the ignore rule, the generated script's artifact path, and the
    // removal target are three consumers of ONE owner. A drift between them
    // would ignore one subtree while deleting another.
    expect(DELIVERY_RUNTIME_CONTAINER).toBe(EXPECTED_RUNTIME_CONTAINER);
    expect(DELIVERY_RUNTIME_OWNED_ENTRY).toBe(EXPECTED_OWNED_ENTRY);
    expect(DELIVERY_RUNTIME_RELATIVE).toBe(EXPECTED_RUNTIME_RELATIVE);
    expect(DELIVERY_RUNTIME_IGNORE_RULE).toBe(EXPECTED_IGNORE_RULE);
  });

  it("treats an absent runtime container as a successful no-op", async () => {
    // Break: an absent container is the normal state of a project that has
    // never run a delivery target; it must not be an error.
    const root = await makeProjectRoot();
    try {
      expect(await removeValidatedDeliveryRuntime(root)).toEqual({ removed: false, foreignPreserved: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the owned subtree and the emptied container, and preserves a foreign sibling", async () => {
    // Break: claiming the container instead of the owned entry would delete
    // a sibling the Author put there.
    const root = await makeProjectRoot();
    try {
      const container = join(root, EXPECTED_RUNTIME_CONTAINER);
      await mkdir(join(container, EXPECTED_OWNED_ENTRY, "preview", "abc"), { recursive: true });
      await writeFile(join(container, EXPECTED_OWNED_ENTRY, "preview", "abc", "delivery.json"), "{}\n");
      await mkdir(join(container, "notes"), { recursive: true });
      await writeFile(join(container, "notes", "keep.txt"), "author bytes\n");

      const result = await removeValidatedDeliveryRuntime(root);

      expect(result).toEqual({ removed: true, foreignPreserved: ["notes"] });
      expect(await pathExists(join(container, EXPECTED_OWNED_ENTRY))).toBe(false);
      expect(await directoryExists(container)).toBe(true);
      expect(await readFile(join(container, "notes", "keep.txt"), "utf8")).toBe("author bytes\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes an emptied container after the owned subtree is gone", async () => {
    const root = await makeProjectRoot();
    try {
      const container = join(root, EXPECTED_RUNTIME_CONTAINER);
      await mkdir(join(container, EXPECTED_OWNED_ENTRY), { recursive: true });
      expect(await removeValidatedDeliveryRuntime(root)).toEqual({ removed: true, foreignPreserved: [] });
      expect(await directoryExists(container)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked container with a typed code and removes nothing", async () => {
    const root = await makeProjectRoot();
    try {
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "keep.txt"), "outside bytes\n");
      await mkdir(join(root, ".poiesis"), { recursive: true });
      await symlink(outside, join(root, EXPECTED_RUNTIME_CONTAINER));
      await expect(removeValidatedDeliveryRuntime(root)).rejects.toMatchObject({ code: "DELIVERY_RUNTIME_UNSAFE" });
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside bytes\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a delivery root that is a regular file", async () => {
    const root = await makeProjectRoot();
    try {
      const container = join(root, EXPECTED_RUNTIME_CONTAINER);
      await mkdir(container, { recursive: true });
      await writeFile(join(container, EXPECTED_OWNED_ENTRY), "not a directory\n");
      await expect(removeValidatedDeliveryRuntime(root)).rejects.toMatchObject({ code: "DELIVERY_RUNTIME_UNOWNED" });
      expect(await readFile(join(container, EXPECTED_OWNED_ENTRY), "utf8")).toBe("not a directory\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a delivery descendant symlink before any deletion happens", async () => {
    // Break: the walk must refuse BEFORE the recursive `rm`, so a link buried
    // at depth cannot be followed out of the project.
    const root = await makeProjectRoot();
    try {
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "keep.txt"), "outside bytes\n");
      const ownedDir = join(root, EXPECTED_RUNTIME_CONTAINER, EXPECTED_OWNED_ENTRY);
      await mkdir(join(ownedDir, "preview", "abc"), { recursive: true });
      await writeFile(join(ownedDir, "preview", "abc", "delivery.json"), "{}\n");
      await symlink(outside, join(ownedDir, "preview", "abc", "linked"));

      await expect(removeValidatedDeliveryRuntime(root)).rejects.toMatchObject({ code: "DELIVERY_RUNTIME_UNSAFE" });

      expect(await pathExists(ownedDir)).toBe(true);
      expect(await pathExists(join(ownedDir, "preview", "abc", "delivery.json"))).toBe(true);
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside bytes\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// 5 + 6 + 7. Uninstall ownership, foreign siblings, and symlink refusals.
// =========================================================================

describe("uninstall ownership of the delivery runtime", () => {
  const repositories: TestRepository[] = [];
  let openCode: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    openCode = await installFakeOpenCode();
  });

  afterEach(async () => {
    openCode?.restore();
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("removes the complete owned delivery subtree and an empty runtime parent", async () => {
    // Break: leaving the subtree behind reported "unknown content under
    // .poiesis" and forced an incomplete uninstall on a clean project.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);
    for (const target of ["preview", "staging", "production"]) {
      await writeDeliveryArtifact(repository.root, target, repository.baseSha);
    }
    expect(await directoryExists(join(repository.root, EXPECTED_RUNTIME_RELATIVE))).toBe(true);

    const result = await uninstall(repository.root);

    expect(result.removed).toContain(EXPECTED_RUNTIME_RELATIVE);
    expect(result.preserved).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.manifestRemoved).toBe(true);
    // The empty runtime container goes with its owned subtree. `.poiesis`
    // itself survives on purpose: uninstall RELEASES the durable tracked
    // project files (`.poiesis/*.md`, `.poiesis/roles/*.md`) rather than
    // deleting them, so its presence is not residue.
    expect(await directoryExists(join(repository.root, EXPECTED_RUNTIME_CONTAINER))).toBe(false);
    expect(await pathExists(join(repository.root, EXPECTED_RUNTIME_RELATIVE))).toBe(false);
    expect(await ownershipReceiptExists(repository.root)).toBe(false);
  }, 60_000);

  it("preserves a foreign runtime sibling byte-for-byte and keeps uninstall incomplete with the receipt", async () => {
    // Break: claiming all of `.poiesis/runtime/` would delete state Poiesis
    // never wrote and would destroy a local install that still owns files.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);
    await writeDeliveryArtifact(repository.root, "preview", repository.baseSha);
    const foreignFile = join(repository.root, EXPECTED_RUNTIME_CONTAINER, "notes", "keep.txt");
    await mkdir(join(repository.root, EXPECTED_RUNTIME_CONTAINER, "notes"), { recursive: true });
    await writeFile(foreignFile, "author bytes\n");
    const receiptBefore = await readOwnershipReceipt(repository.root);

    const result = await uninstall(repository.root);

    expect(await readFile(foreignFile, "utf8")).toBe("author bytes\n");
    expect(await directoryExists(join(repository.root, EXPECTED_RUNTIME_RELATIVE))).toBe(false);
    expect(result.removed).toContain(EXPECTED_RUNTIME_RELATIVE);
    const preserved = result.preserved.find((entry) => entry.path === `${EXPECTED_RUNTIME_CONTAINER}/notes`);
    expect(preserved?.reason).toMatch(/foreign content/);
    expect(result.complete).toBe(false);
    expect(result.manifestRemoved).toBe(false);
    // The receipt is RETAINED and rebound to the retained manifest, which is
    // how an incomplete uninstall keeps the next one receipt-authoritative.
    expect(await ownershipReceiptExists(repository.root)).toBe(true);
    const receiptAfter = await readOwnershipReceipt(repository.root);
    expect(receiptAfter.generation).toBe(receiptBefore.generation + 1);
    expect(receiptAfter.manifestDigest).toBe(manifestDigest(await loadManifest(repository.root)));
  }, 60_000);

  it("refuses to traverse or delete a symlinked runtime container", async () => {
    // Break: `rm --recursive` follows a symlinked container, so the removal
    // would delete whatever the link pointed at.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);
    const outside = join(repository.parent, "outside");
    await mkdir(join(outside, "delivery"), { recursive: true });
    await writeFile(join(outside, "delivery", "keep.txt"), "outside bytes\n");
    await mkdir(join(repository.root, ".poiesis"), { recursive: true });
    await symlink(outside, join(repository.root, EXPECTED_RUNTIME_CONTAINER));

    const result = await uninstall(repository.root);

    expect(await readFile(join(outside, "delivery", "keep.txt"), "utf8")).toBe("outside bytes\n");
    const preserved = result.preserved.find((entry) => entry.path === `${EXPECTED_RUNTIME_CONTAINER}/`);
    expect(preserved?.reason).toMatch(/delivery runtime validation refused removal/);
    expect(result.complete).toBe(false);
    expect(await ownershipReceiptExists(repository.root)).toBe(true);
  }, 60_000);

  it("refuses to traverse or delete a symlinked delivery root", async () => {
    // Break: the delivery root is the recursive-removal target, so a
    // symlink there is the single most dangerous shape.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);
    const outside = join(repository.parent, "outside-delivery");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "outside bytes\n");
    await mkdir(join(repository.root, EXPECTED_RUNTIME_CONTAINER), { recursive: true });
    await symlink(outside, join(repository.root, EXPECTED_RUNTIME_RELATIVE));

    const result = await uninstall(repository.root);

    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside bytes\n");
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    const preserved = result.preserved.find((entry) => entry.path === `${EXPECTED_RUNTIME_CONTAINER}/`);
    expect(preserved?.reason).toMatch(/delivery runtime validation refused removal/);
    expect(result.complete).toBe(false);
    expect(await ownershipReceiptExists(repository.root)).toBe(true);
  }, 60_000);

  it("refuses to traverse or delete a symlinked delivery descendant", async () => {
    // Break: a symlink buried inside the owned subtree is enough to make the
    // recursive removal destructive, so the walk must refuse before deleting.
    const repository = await createTestRepository();
    repositories.push(repository);
    await installWithGeneratedTargets(repository);
    await writeDeliveryArtifact(repository.root, "preview", repository.baseSha);
    const outside = join(repository.parent, "outside-descendant");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "outside bytes\n");
    await symlink(
      outside,
      join(repository.root, EXPECTED_RUNTIME_RELATIVE, "preview", repository.baseSha, "linked"),
    );

    const result = await uninstall(repository.root);

    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside bytes\n");
    // Nothing under the owned subtree was deleted, not even the owned
    // artifact that sits beside the symlink.
    expect(await pathExists(join(repository.root, EXPECTED_RUNTIME_RELATIVE))).toBe(true);
    expect(await pathExists(join(repository.root, EXPECTED_RUNTIME_RELATIVE, "preview", repository.baseSha, "delivery.json"))).toBe(
      true,
    );
    const preserved = result.preserved.find((entry) => entry.path === `${EXPECTED_RUNTIME_CONTAINER}/`);
    expect(preserved?.reason).toMatch(/delivery runtime validation refused removal/);
    expect(result.complete).toBe(false);
    expect(await ownershipReceiptExists(repository.root)).toBe(true);
  }, 60_000);
});

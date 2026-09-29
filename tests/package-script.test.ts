import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../src/maintenance.js";
import {
  POIESIS_SCRIPT_COMMAND,
  POIESIS_SCRIPT_NAME,
  assertPoiesisScriptAvailable,
  ensurePoiesisScriptRefusing,
  repairPoiesisScript,
  rollbackPackageJson,
} from "../src/package-script.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";
import { hashContent } from "../src/hash.js";
import { parseJsonc } from "../src/config.js";
import type { Manifest } from "../src/manifest.js";

/**
 * Spec #133 / ticket #134 — the `pnpm poiesis <command>` package script.
 *
 * `package.json` is an Author-owned file. Poiesis performs exactly one
 * bounded, reversible edit to it: a single `scripts.poiesis` entry added
 * with `jsonc-parser`'s `modify` + `applyEdits`. The tests below assert
 * the properties the Spec makes non-negotiable:
 *
 *   - the script is created with the exact expected value;
 *   - every sibling entry of `scripts` keeps its EXACT bytes (the tests
 *     assert the untouched region byte-for-byte, not semantically);
 *   - a missing `scripts` field is created with only the `poiesis` entry;
 *   - a project with no `package.json` installs successfully and is not
 *     given a script;
 *   - a differing `scripts.poiesis` fails closed BEFORE any write, with
 *     `details.path === ["scripts", "poiesis"]`, mutating nothing;
 *   - an already-correct value is a no-op, not an authored write;
 *   - the init rollback restores the exact preimage, including absence;
 *   - the Author's indentation style (4-space, tab) is preserved.
 */

// The single inserted line, at the indentation the surrounding
// `scripts` entries already use. Removing it must reproduce the
// Author's document byte-for-byte.
const INSERTED_2_SPACE = `    "${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}",\n`;
const INSERTED_4_SPACE = `        "${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}",\n`;
const INSERTED_TAB = `\t\t"${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}",\n`;
const INSERTED_CRLF = `    "${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}",\r\n`;

function packageJsonPath(repository: TestRepository): string {
  return join(repository.root, "package.json");
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

async function readPackageJson(repository: TestRepository): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(packageJsonPath(repository), "utf8")) as Record<string, unknown>;
}

/**
 * Pre-create each default skill directory with a sentinel file so
 * `installDefaultSkills` treats them as preexisting and skips the
 * network-bound `npx` install step. `init` still calls the doctor gate
 * at the end of the transaction, which is the seam the rollback tests
 * use to force a post-write failure.
 */
async function seedDefaultSkillDirectoriesAsPreexisting(repository: TestRepository): Promise<void> {
  const defaultNames = [
    "grilling",
    "grill-with-docs",
    "domain-modeling",
    "research",
    "codebase-design",
    "to-spec",
    "to-tickets",
    "code-review",
    "diagnosing-bugs",
    "test-driven-development",
    "verification-before-completion",
  ];
  for (const name of defaultNames) {
    const dir = join(repository.root, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `# ${name}\nseeded by package-script.test\n`);
  }
}

/** Every path a successful init transaction would have touched. */
async function expectNothingMutated(repository: TestRepository): Promise<void> {
  expect(await pathExists(join(repository.root, ".gitignore"))).toBe(false);
  expect(await pathExists(join(repository.root, "opencode.jsonc"))).toBe(false);
  expect(await pathExists(join(repository.root, ".poiesis"))).toBe(false);
  expect(await pathExists(join(repository.root, ".opencode"))).toBe(false);
}

async function install(repository: TestRepository): Promise<Manifest> {
  return init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
}

describe("poiesis package script (Spec #133 / ticket #134)", () => {
  const repositories: TestRepository[] = [];
  let env: FakeOpenCodeEnvironment | undefined;

  beforeEach(async () => {
    env = await installFakeOpenCode();
  });

  afterEach(async () => {
    env?.restore();
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
  });

  async function createRepository(): Promise<TestRepository> {
    const repository = await createTestRepository();
    repositories.push(repository);
    return repository;
  }

  it("exports the single source of truth for the script name and command", () => {
    expect(POIESIS_SCRIPT_NAME).toBe("poiesis");
    expect(POIESIS_SCRIPT_COMMAND).toBe("pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest");
  });

  it("pins the cache-bypassing `@latest` form so the dlx cache can never be silently reintroduced", () => {
    // The exact-value assertion above is the load-bearing one; these two
    // say WHY, so a future edit that drops either half explains itself
    // at the point of failure instead of looking like a harmless
    // simplification.
    expect(
      POIESIS_SCRIPT_COMMAND,
      "the script value MUST keep --config.dlx-cache-max-age=0: pnpm caches `dlx` resolutions for ~1440 minutes, so the bare form can silently serve a stale poiesis-cli resolution and defeat the whole feature",
    ).toContain("--config.dlx-cache-max-age=0");

    expect(
      POIESIS_SCRIPT_COMMAND,
      "the script value MUST stay @latest: `update` is the version-crossing boundary, and the Author must never be asked to type a version",
    ).toContain("@latest");

    // Belt and braces: the bypass flag must precede the `dlx` subcommand
    // (it is a pnpm config flag, not a dlx flag) and must not be
    // version-interpolated.
    expect(POIESIS_SCRIPT_COMMAND.indexOf("--config.dlx-cache-max-age=0")).toBeLessThan(
      POIESIS_SCRIPT_COMMAND.indexOf(" dlx "),
    );
    expect(POIESIS_SCRIPT_COMMAND).not.toMatch(/@\d+\.\d+\.\d+/);
  });

  it("init creates scripts.poiesis when package.json already has other scripts", async () => {
    const repository = await createRepository();
    await writeFile(
      packageJsonPath(repository),
      [
        "{",
        '  "name": "demo",',
        '  "scripts": {',
        '    "build": "tsc",',
        '    "test": "vitest run"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    await install(repository);

    const packageJson = await readPackageJson(repository);
    expect(packageJson.scripts).toEqual({
      build: "tsc",
      test: "vitest run",
      [POIESIS_SCRIPT_NAME]: POIESIS_SCRIPT_COMMAND,
    });
  });

  it("init preserves every sibling script byte-for-byte (exact untouched region)", async () => {
    const repository = await createRepository();
    // Deliberately non-canonical Author formatting: a double space after
    // the colon on one sibling and a trailing line comment on another.
    // A re-serialising implementation would normalise both.
    const before = [
      "{",
      '  "name": "demo",',
      '  "private": true,',
      '  "scripts": {',
      '    "build": "tsc",',
      '    "test":  "vitest run"  // Author spacing is preserved',
      "  },",
      '  "version": "1.0.0"',
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);

    await install(repository);

    const after = await readFile(packageJsonPath(repository), "utf8");
    // Prove the entry was actually inserted. Without this the two
    // assertions below also hold when `after === before` — a silent
    // no-op would satisfy `String.replace` and the `toContain` checks,
    // because every string in them is already present in `before`.
    expect(after).toContain(INSERTED_2_SPACE);
    // Exact-byte assertion: stripping the single inserted line must
    // reproduce the Author's original document exactly.
    expect(after.replace(INSERTED_2_SPACE, "")).toBe(before);
    expect(after).toContain('    "test":  "vitest run"  // Author spacing is preserved\n');
    expect(after).toContain('  "private": true,\n');
    expect(after).toContain('  "version": "1.0.0"\n');
    // This fixture carries a line comment, so it is JSONC rather than
    // strict JSON — read it the way the module reads it.
    const parsed = parseJsonc<Record<string, unknown>>(
      await readFile(packageJsonPath(repository), "utf8"),
      packageJsonPath(repository),
    );
    expect(parsed.scripts).toEqual({
      build: "tsc",
      test: "vitest run",
      [POIESIS_SCRIPT_NAME]: POIESIS_SCRIPT_COMMAND,
    });
  }, 60_000);

  it("init creates a missing scripts field containing only the poiesis entry", async () => {
    const repository = await createRepository();
    const before = ["{", '  "name": "demo",', '  "version": "1.0.0"', "}", ""].join("\n");
    await writeFile(packageJsonPath(repository), before);

    await install(repository);

    const packageJson = await readPackageJson(repository);
    expect(packageJson.scripts).toEqual({ [POIESIS_SCRIPT_NAME]: POIESIS_SCRIPT_COMMAND });
    // The pre-existing root entries keep their exact bytes.
    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toContain('  "name": "demo",\n');
    expect(after).toContain('  "version": "1.0.0"\n');
    expect(before).not.toBe(after);
  }, 60_000);

  it("init succeeds and adds no script when the project has no package.json", async () => {
    const repository = await createRepository();
    expect(await pathExists(packageJsonPath(repository))).toBe(false);

    const manifest = await install(repository);

    expect(manifest.files.length).toBeGreaterThan(0);
    expect(await pathExists(packageJsonPath(repository))).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(POIESIS_SCRIPT_COMMAND);
  }, 60_000);

  it("init fails closed on a differing scripts.poiesis and mutates nothing else", async () => {
    const repository = await createRepository();
    const before = [
      "{",
      '  "name": "demo",',
      '  "scripts": {',
      `    "${POIESIS_SCRIPT_NAME}": "echo mine",`,
      '    "build": "tsc"',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);
    const preimage = await readFile(packageJsonPath(repository));

    await expect(install(repository)).rejects.toMatchObject({
      code: "PACKAGE_SCRIPT_CONFLICT",
      details: { path: ["scripts", POIESIS_SCRIPT_NAME] },
    });

    // The Author's script is never overwritten...
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    // ...and no other file was mutated by the failed transaction.
    await expectNothingMutated(repository);
  }, 60_000);

  it.each([
    ["string", '"x"'],
    ["null", "null"],
    ["array", "[]"],
    ["number", "3"],
  ])("init fails closed on a scripts field that is a %s, with a typed error", async (_shape, value) => {
    const repository = await createRepository();
    await writeFile(packageJsonPath(repository), `{\n  "scripts": ${value}\n}\n`);
    const preimage = await readFile(packageJsonPath(repository));

    await expect(install(repository)).rejects.toMatchObject({
      code: "INVALID_PACKAGE_JSON",
      details: { path: ["scripts"] },
    });

    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    await expectNothingMutated(repository);
  }, 60_000);

  it.each([
    ["array", "[1, 2, 3]\n"],
    ["string", '"demo"\n'],
    ["number", "42\n"],
    ["null", "null\n"],
  ])("init fails closed on a package.json whose root is a %s, with a typed error", async (_shape, content) => {
    const repository = await createRepository();
    await writeFile(packageJsonPath(repository), content);
    const preimage = await readFile(packageJsonPath(repository));

    await expect(install(repository)).rejects.toMatchObject({
      code: "INVALID_PACKAGE_JSON",
      details: { file: "package.json" },
    });

    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    await expectNothingMutated(repository);
  }, 60_000);

  it("init fails closed on an empty package.json, with a typed error", async () => {
    const repository = await createRepository();
    await writeFile(packageJsonPath(repository), "");
    const preimage = await readFile(packageJsonPath(repository));

    await expect(install(repository)).rejects.toMatchObject({ code: "INVALID_JSONC" });

    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    await expectNothingMutated(repository);
  }, 60_000);

  it("init accepts an already-correct scripts.poiesis without rewriting package.json", async () => {
    const repository = await createRepository();
    const before = [
      "{",
      '  "name": "demo",',
      '  "scripts": {',
      `    "${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}"`,
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);
    const preimage = await readFile(packageJsonPath(repository));

    await install(repository);

    // An already-correct value is a no-op, not an authored write.
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
  }, 60_000);

  it("ensurePoiesisScriptRefusing returns undefined when the value is already correct", async () => {
    const repository = await createRepository();
    const before = [
      "{",
      '  "scripts": {',
      `    "${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}"`,
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);
    const preimage = await readFile(packageJsonPath(repository));

    const written = await ensurePoiesisScriptRefusing(repository.root, preimage);

    expect(written).toBeUndefined();
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
  });

  it("ensurePoiesisScriptRefusing returns undefined when there is no package.json", async () => {
    const repository = await createRepository();
    expect(await ensurePoiesisScriptRefusing(repository.root, null)).toBeUndefined();
    expect(await pathExists(packageJsonPath(repository))).toBe(false);
  });

  it("ensurePoiesisScriptRefusing fails closed when package.json changed since the snapshot", async () => {
    const repository = await createRepository();
    await writeFile(packageJsonPath(repository), '{\n  "name": "demo"\n}\n');
    const snapshot = await readFile(packageJsonPath(repository));
    await writeFile(packageJsonPath(repository), '{\n  "name": "other"\n}\n');

    await expect(ensurePoiesisScriptRefusing(repository.root, snapshot)).rejects.toMatchObject({
      code: "INSTALL_PATH_CONFLICT",
    });
  });

  it("ensurePoiesisScriptRefusing enforces the refuse policy at the write site, not only at the pre-flight", async () => {
    const repository = await createRepository();
    const before = [
      "{",
      '  "scripts": {',
      `    "${POIESIS_SCRIPT_NAME}": "echo mine"`,
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);
    const preimage = await readFile(packageJsonPath(repository));

    // Acceptance #4 must hold for the WRITER too, so a caller that
    // skips the pre-flight still cannot overwrite the Author's script.
    await expect(ensurePoiesisScriptRefusing(repository.root, preimage)).rejects.toMatchObject({
      code: "PACKAGE_SCRIPT_CONFLICT",
      details: { path: ["scripts", POIESIS_SCRIPT_NAME] },
    });
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
  });

  it("assertPoiesisScriptAvailable reports presence, absence, and conflict", async () => {
    const repository = await createRepository();
    // Absence is not an error.
    expect(await assertPoiesisScriptAvailable(repository.root)).toBe(false);

    await writeFile(packageJsonPath(repository), '{\n  "name": "demo"\n}\n');
    expect(await assertPoiesisScriptAvailable(repository.root)).toBe(true);

    // An already-correct script is available, not a conflict.
    await writeFile(
      packageJsonPath(repository),
      `{\n  "scripts": {\n    "${POIESIS_SCRIPT_NAME}": "${POIESIS_SCRIPT_COMMAND}"\n  }\n}\n`,
    );
    expect(await assertPoiesisScriptAvailable(repository.root)).toBe(true);

    await writeFile(
      packageJsonPath(repository),
      `{\n  "scripts": {\n    "${POIESIS_SCRIPT_NAME}": "echo mine"\n  }\n}\n`,
    );
    await expect(assertPoiesisScriptAvailable(repository.root)).rejects.toMatchObject({
      code: "PACKAGE_SCRIPT_CONFLICT",
      details: { path: ["scripts", POIESIS_SCRIPT_NAME] },
    });
  });

  it("assertPoiesisScriptAvailable fails closed on unparseable package.json", async () => {
    const repository = await createRepository();
    await writeFile(packageJsonPath(repository), "{ this is not json\n");
    await expect(assertPoiesisScriptAvailable(repository.root)).rejects.toMatchObject({
      code: "INVALID_JSONC",
    });
  });

  it("init rollback restores the exact package.json bytes on post-write doctor failure", async () => {
    const repository = await createRepository();
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    const before = [
      "{",
      '  "name": "demo",',
      '  "scripts": {',
      '    "build": "tsc",',
      '    "test":  "vitest run"',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);
    const preimage = await readFile(packageJsonPath(repository));

    // Init's first `opencode debug config` invocation is
    // `validateOpenCodeConfigPayload` (during the transaction, before the
    // package.json write). The NEXT invocation is the doctor gate at the
    // end of the transaction, after the package.json write.
    env?.restore();
    env = await installFakeOpenCode({
      failAfterDebugCalls: { file: join(repository.parent, ".poiesis", "debug-count.txt"), threshold: 1 },
    });

    await expect(
      init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "INIT_DOCTOR_FAILED" });

    // Byte-for-byte restoration, including the Author's double space.
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    expect((await readFile(packageJsonPath(repository), "utf8")).includes(POIESIS_SCRIPT_COMMAND)).toBe(false);
  }, 60_000);

  it("init rollback leaves a previously-absent package.json absent on post-write doctor failure", async () => {
    const repository = await createRepository();
    await seedDefaultSkillDirectoriesAsPreexisting(repository);
    expect(await pathExists(packageJsonPath(repository))).toBe(false);

    env?.restore();
    env = await installFakeOpenCode({
      failAfterDebugCalls: { file: join(repository.parent, ".poiesis", "debug-count.txt"), threshold: 1 },
    });

    await expect(
      init(repository.root, testConfig(repository), { allowFixtureAdapters: true }),
    ).rejects.toMatchObject({ code: "INIT_DOCTOR_FAILED" });

    expect(await pathExists(packageJsonPath(repository))).toBe(false);
  }, 60_000);

  it("init preserves 4-space indentation", async () => {
    const repository = await createRepository();
    const before = [
      "{",
      '    "name": "demo",',
      '    "scripts": {',
      '        "build": "tsc"',
      "    }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);

    await install(repository);

    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toContain(INSERTED_4_SPACE);
    expect(after.replace(INSERTED_4_SPACE, "")).toBe(before);
    // No mixed indentation: no line is indented with a space count that
    // is not a multiple of the file's 4-space unit.
    for (const line of after.split("\n")) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      expect(indent).not.toContain("\t");
      expect(indent.length % 4).toBe(0);
    }
    expect((await readPackageJson(repository)).scripts).toEqual({
      build: "tsc",
      [POIESIS_SCRIPT_NAME]: POIESIS_SCRIPT_COMMAND,
    });
  }, 60_000);

  it("init preserves tab indentation", async () => {
    const repository = await createRepository();
    const before = [
      "{",
      '\t"name": "demo",',
      '\t"scripts": {',
      '\t\t"build": "tsc"',
      "\t}",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), before);

    await install(repository);

    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toContain(INSERTED_TAB);
    expect(after.replace(INSERTED_TAB, "")).toBe(before);
    // No mixed indentation: the inserted block uses tabs, never spaces.
    for (const line of after.split("\n")) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      expect(indent).not.toContain(" ");
    }
    expect((await readPackageJson(repository)).scripts).toEqual({
      build: "tsc",
      [POIESIS_SCRIPT_NAME]: POIESIS_SCRIPT_COMMAND,
    });
  }, 60_000);

  it("init preserves CRLF line endings", async () => {
    const repository = await createRepository();
    const before = [
      "{",
      '  "name": "demo",',
      '  "scripts": {',
      '    "build": "tsc"',
      "  }",
      "}",
      "",
    ].join("\r\n");
    await writeFile(packageJsonPath(repository), before);

    await install(repository);

    const after = await readFile(packageJsonPath(repository), "utf8");
    expect(after).toContain(INSERTED_CRLF);
    expect(after.replace(INSERTED_CRLF, "")).toBe(before);
  }, 60_000);

  it("repairPoiesisScript repairs a drifted scripts.poiesis value", async () => {
    const repository = await createRepository();
    const drifted = [
      "{",
      '  "scripts": {',
      `    "${POIESIS_SCRIPT_NAME}": "echo mine",`,
      '    "build": "tsc"',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(packageJsonPath(repository), drifted);
    const driftedBytes = await readFile(packageJsonPath(repository));

    const written = await repairPoiesisScript(repository.root, driftedBytes);

    expect(written).toBeDefined();
    // The drifted value is replaced surgically: the sibling, the entry's
    // position, and every other byte are untouched. This is acceptance
    // #7, which only `update` needs — hence the explicit "repair".
    expect(await readFile(packageJsonPath(repository), "utf8")).toBe(
      drifted.replace('"echo mine"', JSON.stringify(POIESIS_SCRIPT_COMMAND)),
    );
  });

  it("raises the reformat refusal from the read-only pre-flight, before any write", async () => {
    const repository = await createRepository();
    await writeFile(packageJsonPath(repository), '{"name":"demo","scripts":{"build":"tsc"}}');
    const preimage = await readFile(packageJsonPath(repository));

    // The refusal depends only on the preimage, so it must surface from
    // the read-only guard — not from the write site, after
    // `opencode.jsonc` and `.gitignore` have already been written.
    await expect(assertPoiesisScriptAvailable(repository.root)).rejects.toMatchObject({
      code: "PACKAGE_SCRIPT_REFORMAT_REFUSED",
    });

    // Purely read-only: nothing was written and nothing needed rollback.
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    await expectNothingMutated(repository);
  });

  it("reports the Spec-named conflict even when the file would also be refused for reformatting", async () => {
    const repository = await createRepository();
    const before = `{"name":"demo","scripts":{"${POIESIS_SCRIPT_NAME}":"echo mine"}}`;
    await writeFile(packageJsonPath(repository), before);
    const preimage = await readFile(packageJsonPath(repository));

    // The conflict check runs before the plan, so the Author's own
    // script is always named rather than shadowed by a reformat refusal.
    await expect(install(repository)).rejects.toMatchObject({
      code: "PACKAGE_SCRIPT_CONFLICT",
      details: { path: ["scripts", POIESIS_SCRIPT_NAME] },
    });

    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    await expectNothingMutated(repository);
  }, 60_000);

  it("refuses a package.json whose edit would reformat existing entries", async () => {
    const repository = await createRepository();
    // `jsonc-parser` widens an insertion to whole LINES before it
    // formats, so a single-line document is re-laid-out in full
    // (`"name":"demo"` becomes `"name": "demo"`). Poiesis must fail
    // closed on that instead of silently claiming the whole file.
    const before = '{"name":"demo","scripts":{"build":"tsc"}}';
    await writeFile(packageJsonPath(repository), before);
    const preimage = await readFile(packageJsonPath(repository));

    await expect(install(repository)).rejects.toMatchObject({
      code: "PACKAGE_SCRIPT_REFORMAT_REFUSED",
    });

    // The refusal surfaces from the read-only pre-flight
    // (`assertPoiesisScriptAvailable`, before `init`'s `try` block), so
    // nothing was ever written and no rollback had to run.
    expect(await readFile(packageJsonPath(repository))).toEqual(preimage);
    await expectNothingMutated(repository);
  }, 60_000);

  it("rollbackPackageJson restores the snapshot only while the written hash still matches", async () => {
    const repository = await createRepository();
    const path = packageJsonPath(repository);
    const snapshot = Buffer.from('{\n  "name": "demo"\n}\n', "utf8");
    const written = '{\n  "name": "demo",\n  "scripts": {\n    "poiesis": "x"\n  }\n}\n';

    // Written content: the snapshot is restored.
    await writeFile(path, written);
    await rollbackPackageJson(path, snapshot, hashContent(written));
    expect(await readFile(path)).toEqual(snapshot);

    // A foreign concurrent write is preserved, never clobbered.
    const foreign = '{\n  "name": "author-edit"\n}\n';
    await writeFile(path, foreign);
    await rollbackPackageJson(path, snapshot, hashContent(written));
    expect(await readFile(path, "utf8")).toBe(foreign);

    // A `null` snapshot means "did not exist" and the file is unlinked.
    await writeFile(path, written);
    await rollbackPackageJson(path, null, hashContent(written));
    expect(await pathExists(path)).toBe(false);
  });
});

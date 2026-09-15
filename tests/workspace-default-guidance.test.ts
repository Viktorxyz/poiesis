import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Canonical package guidance for `poiesis workspace prepare`.
 *
 * The runtime already defaults the workspace path to
 * `<root>/.poiesis/workspaces/<derived-id>` when `--path` is omitted
 * (see `tests/workspace-default-path.test.ts` and the
 * `deriveDefaultWorkspacePath` implementation). This file proves the
 * user-visible package guidance agrees with that runtime contract and
 * is imperative enough that an agent following it cannot reasonably
 * choose an external path during ordinary Prepare.
 *
 * The canonical, imperative phrasing is:
 *
 *   "Omit `--path`."
 *
 * The only permitted exceptions are:
 *   1. the Author explicitly supplied an exceptional path; or
 *   2. compatibility recovery requires the exact pre-existing path.
 *
 * Any guidance that softens "omit `--path`" to "may omit" or frames
 * `--path` as the default form is a regression: it lets an agent
 * re-introduce the external-directory / arbitrary-`/tmp`-path failure
 * mode that this guidance was written to prevent.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

const IMPERATIVE_OMIT = "Omit `--path`";
// The CLI HELP lives inside a JS template literal so the backticks around
// `--path` must be escaped (\`). The shipped runtime reads the rendered
// string (without the JS escape). Both shapes are accepted here.
const IMPERATIVE_OMIT_ESCAPED = "Omit \\\`--path\\\`";
const EXCEPTION_AUTHOR = "Author explicitly supplied";
const EXCEPTION_COMPATIBILITY = "compatibility recovery requires the exact pre-existing path";

describe("workspace prepare package guidance", () => {
  it("CLI HELP tells the user to omit `--path` for ordinary Prepare", async () => {
    const cliTs = await readRepoFile("src/cli.ts");
    // The CLI HELP is a JS template literal so the source has \` escapes
    // rather than bare backticks. Both shapes prove the imperative wording.
    expect(cliTs.includes(IMPERATIVE_OMIT) || cliTs.includes(IMPERATIVE_OMIT_ESCAPED)).toBe(true);
  });

  it("POIESIS_METHOD.md tells the user to omit `--path` for ordinary Prepare", async () => {
    const method = await readRepoFile("POIESIS_METHOD.md");
    expect(method).toContain(IMPERATIVE_OMIT);
  });

  it("POIESIS_ROLE_POIESIS.md tells the user to omit `--path` for ordinary Prepare", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    expect(role).toContain(IMPERATIVE_OMIT);
  });

  it("README.md tells the user to omit `--path` for ordinary Prepare", async () => {
    const readme = await readRepoFile("README.md");
    expect(readme).toContain(IMPERATIVE_OMIT);
  });

  it("OPENCODE_AGENT_POIESIS.md (installed/generated projection) tells the user to omit `--path`", async () => {
    const agentDoc = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
    expect(agentDoc).toContain(IMPERATIVE_OMIT);
  });

  it("canonical wording agrees that `--path` is reserved for the two documented exceptions", async () => {
    const [cliTs, method, role, readme, agentDoc] = await Promise.all([
      readRepoFile("src/cli.ts"),
      readRepoFile("POIESIS_METHOD.md"),
      readRepoFile("POIESIS_ROLE_POIESIS.md"),
      readRepoFile("README.md"),
      readRepoFile("OPENCODE_AGENT_POIESIS.md"),
    ]);
    for (const [label, text] of [
      ["src/cli.ts", cliTs],
      ["POIESIS_METHOD.md", method],
      ["POIESIS_ROLE_POIESIS.md", role],
      ["README.md", readme],
      ["OPENCODE_AGENT_POIESIS.md", agentDoc],
    ] as const) {
      expect(text, `${label} should reserve --path for the Author-explicit exception`).toContain(EXCEPTION_AUTHOR);
      expect(text, `${label} should reserve --path for the compatibility-recovery exception`).toContain(EXCEPTION_COMPATIBILITY);
    }
  });

  it("canonical wording forbids arbitrary external workspace paths", async () => {
    const [cliTs, method, role, readme, agentDoc] = await Promise.all([
      readRepoFile("src/cli.ts"),
      readRepoFile("POIESIS_METHOD.md"),
      readRepoFile("POIESIS_ROLE_POIESIS.md"),
      readRepoFile("README.md"),
      readRepoFile("OPENCODE_AGENT_POIESIS.md"),
    ]);
    for (const [label, text] of [
      ["src/cli.ts", cliTs],
      ["POIESIS_METHOD.md", method],
      ["POIESIS_ROLE_POIESIS.md", role],
      ["README.md", readme],
      ["OPENCODE_AGENT_POIESIS.md", agentDoc],
    ] as const) {
      expect(text, `${label} should explicitly reject /tmp/... or other external workspace paths`).toMatch(/\/tmp\/\.\.\.|external path/i);
    }
  });

  it("CLI HELP lists the default `workspace prepare` form before the exceptional `--path` form", async () => {
    const cliTs = await readRepoFile("src/cli.ts");
    const helpMatch = cliTs.match(/const HELP = `([\s\S]*?)`;\s*$/m);
    expect(helpMatch).not.toBeNull();
    const help = helpMatch![1]!;
    const defaultLineIndex = help.indexOf("poiesis workspace prepare --branch <name> --spec <id>");
    const exceptionalLineIndex = help.indexOf("poiesis workspace prepare --branch <name> --path");
    expect(defaultLineIndex).toBeGreaterThanOrEqual(0);
    expect(exceptionalLineIndex).toBeGreaterThan(defaultLineIndex);
  });
});

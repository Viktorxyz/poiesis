/**
 * Spec #207 / ticket #209 — product vs development philosophy split,
 * AGENTS coverage obligations, and packaging scope for maintainer docs.
 *
 * Guidance / shape only: reads package source, no scratch installs.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { templateMappings } from "../src/templates.js";

const REPO_ROOT = join(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), "utf8");
}

describe("philosophy packaging scope (ticket #209)", () => {
  it("packages distinct product and development philosophy documents", async () => {
    const product = await readRepoFile("POIESIS_PHILOSOPHY.md");
    const development = await readRepoFile("POIESIS_DEVELOPMENT_PHILOSOPHY.md");
    const pkg = JSON.parse(await readRepoFile("package.json")) as { files: string[] };

    expect(product).toMatch(/^# Poiesis Philosophy/m);
    expect(development).toMatch(/^# Poiesis Development Philosophy/m);
    expect(pkg.files).toContain("POIESIS_PHILOSOPHY.md");
    expect(pkg.files).toContain("POIESIS_DEVELOPMENT_PHILOSOPHY.md");
  });

  it("projects only product philosophy into consumer installs; development stays package-source", () => {
    const destinations = templateMappings.map((m) => m.destination);
    expect(destinations).toContain(".poiesis/PHILOSOPHY.md");
    expect(destinations).not.toContain(".poiesis/DEVELOPMENT_PHILOSOPHY.md");
    expect(templateMappings.some((m) => m.source === "POIESIS_DEVELOPMENT_PHILOSOPHY.md")).toBe(false);
  });

  it("product philosophy stays concise and free of procedural JSON / maintainer UI TODO", async () => {
    const product = await readRepoFile("POIESIS_PHILOSOPHY.md");
    // Shorter than the pre-split product+maintainer conflation (~8.8k) while
    // still carrying consequential proof/privacy/reliability Author decisions.
    expect(product.length).toBeLessThan(8_500);
    expect(product).not.toMatch(/\{"[a-zA-Z]+":/);
    expect(product).not.toMatch(/UI\/UX/);
    expect(product).toMatch(/Proof before trust/i);
    expect(product).toMatch(/Author/);
  });

  it("development philosophy scopes itself to Poiesis maintainers and records UI/UX as TODO only", async () => {
    const development = await readRepoFile("POIESIS_DEVELOPMENT_PHILOSOPHY.md");
    expect(development).toMatch(/maintainer|developing Poiesis|Poiesis itself/i);
    expect(development).toMatch(/UI\/UX/);
    expect(development).toMatch(/TODO/);
    expect(development).toMatch(/ordinary (?:unrelated )?projects|consumer/i);
  });
});

describe("AGENTS maintenance obligations (ticket #209)", () => {
  it("METHOD instructs source-grounded AGENTS coverage without mechanical invention or broad globs", async () => {
    const method = await readRepoFile("POIESIS_METHOD.md");
    expect(method).toMatch(/AGENTS\.md/);
    expect(method).toMatch(/every eligible (?:project )?folder/i);
    expect(method).toMatch(/poiesis inspect/);
    expect(method).toMatch(/source-grounded|ground(?:ed)? in (?:current )?source/i);
    expect(method).toMatch(/do not (?:mechanically )?invent|never invent/i);
    expect(method).toMatch(/writing-for-agents/);
    expect(method).not.toMatch(/glob \*\*\/AGENTS|all AGENTS\.md files into (?:the )?prompt/i);
  });

  it("Primary role owns coverage establishment and scoped native reads", async () => {
    const role = await readRepoFile("POIESIS_ROLE_POIESIS.md");
    expect(role).toMatch(/AGENTS\.md/);
    expect(role).toMatch(/poiesis inspect/);
    expect(role).toMatch(/writing-for-agents/);
    expect(role).toMatch(/Author-owned|preserve/);
  });

  it("Worker maintains AGENTS with code and reads the applicable ancestor chain only", async () => {
    const role = await readRepoFile("POIESIS_ROLE_WORKER.md");
    expect(role).toMatch(/AGENTS\.md/);
    expect(role).toMatch(/ancestor|applicable chain|scoped/i);
    expect(role).toMatch(/maintain/);
  });

  it("OpenCode primary projection still loads product philosophy only, not development philosophy", async () => {
    const agent = await readRepoFile("OPENCODE_AGENT_POIESIS.md");
    expect(agent).toContain(".poiesis/PHILOSOPHY.md");
    expect(agent).not.toContain("DEVELOPMENT_PHILOSOPHY");
  });

  it("install layout keeps AGENTS.md Author-owned outside Poiesis uninstall", async () => {
    const layout = await readRepoFile("POIESIS_INSTALL_LAYOUT.md");
    expect(layout).toMatch(/AGENTS\.md/);
    expect(layout).toMatch(/Do not modify project `AGENTS\.md` by default/);
  });
});

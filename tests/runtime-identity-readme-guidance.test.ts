import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec #116 / ticket #117 — README fresh-latest guidance.
 *
 * pnpm 9.15.4 caches `dlx` by literal specifier + registry for 1440
 * minutes, so the documented bare `pnpm dlx poiesis-cli@latest`
 * command can execute an old runtime after the npm `@latest` tag
 * moves. Every intentional latest-discovery route documented in
 * the README therefore uses the fresh-latest form
 * `pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest ...`
 * so the documented command always resolves the current `@latest`
 * tag rather than a cached entry.
 *
 * Intentional latest-discovery routes:
 *   - interactive `init` (TTY first install)
 *   - non-interactive `init --config <path>` (automation / CI)
 *   - intentional human upgrade (`update`, plain — fresh `@latest`)
 *   - legacy bootstrap (`update --bootstrap-legacy-ownership`)
 *   - managed-config update (`update --config <path>`)
 *   - coding-agent bootstrap recipe
 *
 * Exact-version routes (must NOT use `@latest`):
 *   - `doctor`
 *   - `uninstall`
 *   - ordinary `update` as same-version reconciliation
 *   - the runtime-generated normal installed lifecycle route
 *     documented in the prose as `pnpm dlx poiesis-cli@<X>`
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readReadme(): Promise<string> {
  return readFile(join(REPO_ROOT, "README.md"), "utf8");
}

/**
 * Extract every documented `pnpm dlx poiesis-cli@latest ...` line
 * from the README. Lines that are part of the fresh-latest form
 * (`pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest ...`)
 * match too — that's the point: every `@latest` line in the README
 * should be the fresh-latest form.
 */
function latestCommandLines(readme: string): string[] {
  const lines: string[] = [];
  for (const line of readme.split(/\r?\n/)) {
    // Only inspect lines that actually start with `pnpm ` — those
    // are documented command lines (either a standalone `bash` /
    // `text` code block, or an inline command in the coding-agent
    // recipe). Prose that just *mentions* the fresh-latest form is
    // intentionally excluded from this check; the prose still uses
    // the same form, but verifying every prose mention would not
    // catch a wrong documented command line.
    const trimmed = line.trim();
    if (trimmed.startsWith("pnpm ") && /dlx poiesis-cli@latest\b/.test(trimmed)) {
      lines.push(trimmed);
    }
  }
  return lines;
}

describe("Spec #116 / ticket #117 README fresh-latest guidance", () => {
  it("doctor example uses the manifest-pinned exact-version route, not @latest", async () => {
    const readme = await readReadme();
    expect(readme).not.toMatch(/pnpm dlx poiesis-cli@latest\s+doctor\b/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@<manifest\.poiesisVersion>\s+doctor\b/);
  });

  it("uninstall example uses the manifest-pinned exact-version route, not @latest", async () => {
    const readme = await readReadme();
    expect(readme).not.toMatch(/pnpm dlx poiesis-cli@latest\s+uninstall\b/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@<manifest\.poiesisVersion>\s+uninstall\b/);
  });

  it("ordinary update (same-version reconciliation) uses the manifest-pinned exact-version route, not @latest", async () => {
    const readme = await readReadme();
    // The "ordinary" update invocation (no `--bootstrap-legacy-ownership`,
    // no `--config`) used as same-version reconciliation MUST be the
    // manifest-pinned form. The fresh-latest `update` form (without
    // those flags) is the distinct "intentional human upgrade" route
    // documented separately.
    expect(readme).not.toMatch(/pnpm dlx poiesis-cli@latest\s+update(?![\s\n]+--bootstrap-legacy-ownership|[\s\n]+--config)/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@<manifest\.poiesisVersion>\s+update\b/);
  });

  it("interactive init example uses the fresh-latest form", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+init\b/);
  });

  it("non-interactive init example uses the fresh-latest form", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+init\s+--config\b/);
  });

  it("intentional human upgrade uses the fresh-latest form (plain `update` with `@latest`)", async () => {
    const readme = await readReadme();
    // Intentional human upgrade: the human explicitly asks Poiesis to
    // resolve `@latest`, so the dlx cache must be bypassed. The plain
    // `update` invocation (no `--bootstrap-legacy-ownership`, no
    // `--config`) used for intentional upgrade must use the
    // fresh-latest form.
    expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+update(?![\s\n]+--bootstrap-legacy-ownership|[\s\n]+--config)\b/);
  });

  it("legacy bootstrap uses the fresh-latest form", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+update\s+--bootstrap-legacy-ownership\b/);
  });

  it("managed-config update uses the fresh-latest form", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+update\s+--config\b/);
  });

  it("coding-agent bootstrap recipe uses the fresh-latest form", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\s+init[^\n]*\(TTY\)/);
  });

  it("no canonical bare `pnpm dlx poiesis-cli@latest` command appears (every `@latest` line is fresh-latest)", async () => {
    const readme = await readReadme();
    const lines = latestCommandLines(readme);
    // Sanity: at least one `@latest` line exists in the README —
    // the fresh-latest flow is supposed to replace every bare
    // `@latest` example. If this ever goes to zero the contract has
    // drifted away from latest-discovery routes entirely.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\b/);
    }
  });

  it("the runtime-generated installed lifecycle route stays on the exact-version form", async () => {
    const readme = await readReadme();
    // Prose must still state the runtime-generated exact-version
    // route as `pnpm dlx poiesis-cli@<X>` where X is the sole
    // durable `manifest.poiesisVersion`. This is the projected
    // OpenCode config's allow entry; @latest is forbidden here.
    expect(readme).toContain("`pnpm dlx poiesis-cli@<X>`");
    expect(readme).toContain("`manifest.poiesisVersion`");
  });
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec #104 / ticket #110 — README normal-lifecycle route guidance.
 *
 * The README documents the Poiesis-launcher route the operator runs in
 * the shell. The runtime identity boundary makes the exact-version
 * route `pnpm dlx poiesis-cli@<manifest.poiesisVersion>` the ONLY
 * Poiesis-launcher route the projected OpenCode config admits after
 * `init`. The `@latest` tag is reserved for the human/operator
 * intentional first install (`init`, `init --config`) and the explicit
 * operator-authorized bootstrap (`update --bootstrap-legacy-ownership`)
 * plus the intentional managed-config update (`update --config`).
 *
 * Normal lifecycle commands (`doctor`, ordinary `update`, `uninstall`)
 * MUST use the manifest-pinned route in the README, not `@latest`,
 * because the operator has already accepted the canonical install
 * boundary and the OpenCode config denies every other launcher
 * variant.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

async function readReadme(): Promise<string> {
  return readFile(join(REPO_ROOT, "README.md"), "utf8");
}

describe("Spec #104 / ticket #110 README normal-lifecycle guidance", () => {
  it("doctor example uses the manifest-pinned exact-version route, not @latest", async () => {
    const readme = await readReadme();
    // The doctor section must NOT show `pnpm dlx poiesis-cli@latest
    // doctor`. It must show the manifest-pinned form.
    expect(readme).not.toMatch(/pnpm dlx poiesis-cli@latest\s+doctor\b/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@<manifest\.poiesisVersion>\s+doctor\b/);
  });

  it("uninstall example uses the manifest-pinned exact-version route, not @latest", async () => {
    const readme = await readReadme();
    expect(readme).not.toMatch(/pnpm dlx poiesis-cli@latest\s+uninstall\b/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@<manifest\.poiesisVersion>\s+uninstall\b/);
  });

  it("ordinary update example uses the manifest-pinned exact-version route, not @latest", async () => {
    const readme = await readReadme();
    // The "ordinary" update invocation (no `--bootstrap-legacy-ownership`,
    // no `--config`) must use the manifest-pinned form. The pattern
    // uses a lookahead right after `update` so the negative cases
    // (`--bootstrap-legacy-ownership` / `--config`) are excluded without
    // a `\s*` greedy match that would let the negative lookahead
    // backtrack to a space-only anchor.
    expect(readme).not.toMatch(/pnpm dlx poiesis-cli@latest\s+update(?![\s\n]+--bootstrap-legacy-ownership|[\s\n]+--config)/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@<manifest\.poiesisVersion>\s+update\b/);
  });

  it("init examples may still use @latest (intentional first install)", async () => {
    const readme = await readReadme();
    // Bootstrap flow: the @latest tag is the human/operator
    // intentional first install route.
    expect(readme).toMatch(/pnpm dlx poiesis-cli@latest\s+init\b/);
    expect(readme).toMatch(/pnpm dlx poiesis-cli@latest\s+init\s+--config\b/);
  });

  it("intentional bootstrap / managed-config update flows may still use @latest", async () => {
    const readme = await readReadme();
    // Operator-authorized bootstrap: legacy 1.0.0 explicit bootstrap.
    expect(readme).toMatch(/pnpm dlx poiesis-cli@latest\s+update\s+--bootstrap-legacy-ownership\b/);
    // Intentional managed-config update.
    expect(readme).toMatch(/pnpm dlx poiesis-cli@latest\s+update\s+--config\b/);
  });
});
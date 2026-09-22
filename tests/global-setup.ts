import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/**
 * Vitest global setup. Installs a fake `opencode` binary on `PATH`
 * before the test pool forks, so every test sees the canonical
 * `1.18.29` (the default V1-adapter certified version) regardless
 * of the real-world `opencode --version` on the test machine.
 *
 * The fake's `debug config` rejects the V1 schema projection for
 * any version NOT in `CERTIFIED_OPENCODE_VERSIONS` so the V1
 * schema probe (via `validateOpenCodeConfigPayload`) catches real
 * incompatibility in tests the same way the real probe does. The
 * certified-set flag is informational metadata, not a hard gate —
 * tests that exercise "newer not-yet-certified" behavior install
 * their own per-test fake via `installFakeOpenCode()`.
 *
 * The fake lives for the lifetime of the test pool. Per-test
 * install/restore is still available via `installFakeOpenCode()`
 * for tests that need to install a non-default version (e.g. the
 * newer-not-certified regression suite that exercises `1.18.32`).
 */
export async function setup(): Promise<void> {
  const env = await installFakeOpenCode({
    rejectV1SchemaForUnknownVersions: true,
  });
  // Hold onto the env in a process-global handle so the per-test
  // restore() (when called) does not yank the global fake off PATH
  // for sibling tests. We expose it via a symbol so tests that want
  // to layer their own fake (e.g. for `1.18.32`) can grab the global
  // reference instead of re-installing.
  const globalKey = Symbol.for("poiesis.test.global-opencode-env");
  (globalThis as Record<symbol, FakeOpenCodeEnvironment | undefined>)[globalKey] = env;
}

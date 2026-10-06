import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    // Spec #168 / ticket #174 — general timing bounds.
    //
    // This suite is integration-shaped: it builds Git remotes, prepares linked
    // worktrees, stages fake harnesses, and drives the real lifecycle
    // transactions. Vitest's 5s default is a floor that describes no property
    // of this codebase — an idle host finishes the slowest test well inside it,
    // while the SAME test on a loaded machine (or a CI box running the pool at
    // its configured concurrency) can take several times longer and be reported
    // as a failure unrelated to the change under review. That is a load
    // property, not a defect, and this Spec exists to stop reporting load as
    // regression.
    //
    // 60s is chosen against observed loaded-host variance for the heaviest
    // transaction tests (init / update / capability install, each of which
    // drives git, the skills transaction, and the OpenCode config projection).
    // It stays bounded: a genuinely hung test must still fail loudly rather
    // than stall the whole run.
    //
    // Hooks and teardown carry the same bound because on a loaded host the
    // global setup and the per-file cleanup are where the wall-clock actually
    // goes, not in the assertions.
    //
    // This general bound is deliberately NOT the answer for timing-sensitive
    // tests. `tests/verify-timeout.test.ts`, `tests/process.test.ts`,
    // `tests/process-lifecycle.test.ts`, and `tests/process-lease.test.ts`
    // assert on elapsed time and bounded termination, so each keeps its own
    // explicit per-test budget and its own tight in-test elapsed-time
    // assertions. Widening the general bound must never be what relaxes them.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.poiesis/workspaces/**",
      "**/.poiesis/tmp/**",
    ],
  },
});

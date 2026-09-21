import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The default OpenCode version this test environment advertises. Keep in
 * sync with the adapter-version-1 supported set in `src/opencode.ts`
 * (`SUPPORTED_OPENCODE_VERSIONS`).
 */
export const TEST_OPENCODE_VERSION = "1.18.29";

/**
 * Model identifiers returned by the fake `opencode models` invocation. They
 * must overlap with the identifiers `testConfig` produces so doctor does not
 * fail on `MODEL_UNAVAILABLE`.
 */
export const TEST_OPENCODE_MODEL_LIST = [
  "openai/gpt-5.6-sol",
  "minimax/MiniMax-M3",
  "minimax/MiniMax-M3-alt",
  "openai/gpt-5.6-fallback",
];

export interface FakeOpenCodeEnvironment {
  bin: string;
  parent: string;
  restore: () => void;
}

export interface InstallFakeOpenCodeOptions {
  /** OpenCode version string to report for `--version`. */
  version?: string;
  /**
   * When set, the fake increments a counter on every `debug config`
   * invocation and fails (exit 1) once the counter exceeds `threshold`.
   * Use this for deterministic post-write doctor failures (e.g. the
   * first call inside `validateOpenCodeConfigPayload` succeeds and the
   * second call inside `doctor → validateOpenCodeConfig` fails).
   */
  failAfterDebugCalls?: { file: string; threshold: number };
  /**
   * When set, the fake reports this list for `models` instead of
   * TEST_OPENCODE_MODEL_LIST. Pass an empty list to simulate an
   * OpenCode installation that has not downloaded any models so every
   * configured model is reported as unavailable.
   */
  modelList?: readonly string[];
}

// Module-level registry of installed fake-opencode bin directories. Used
// for two purposes:
//
//  1. Stale-PATH cleanup at process exit. If a test crashes between
//     `installFakeOpenCode` and `env.restore()`, the on-disk bin dir is
//     removed on `beforeExit` so the temp filesystem does not accumulate
//     thousands of stale `poiesis-fake-opencode-*` directories across
//     full-suite runs.
//
//  2. Stale-PATH defense for tests that install the fake twice without
//     calling restore() between installs. The second install captures
//     the first install's PATH as its `previousPath`; if the first
//     install is never restored, restoring the second install leaves
//     the first install's bin prefix in `process.env.PATH`. Tracking
//     every active install lets the second install's restore also
//     strip the first install's bin prefix.
const installedBins = new Set<string>();
let processCleanupRegistered = false;
function registerProcessCleanup(): void {
  if (processCleanupRegistered) return;
  processCleanupRegistered = true;
  const cleanup = () => {
    for (const parent of installedBins) {
      rm(parent, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup; never throw from a process-exit hook.
      });
    }
    installedBins.clear();
  };
  process.once("beforeExit", cleanup);
  process.once("exit", cleanup);
}

/**
 * Strips a known bin directory prefix from a `:`-delimited PATH string.
 * Idempotent: if the prefix is not present, the path is returned unchanged.
 */
function stripBinPrefix(pathValue: string | undefined, bin: string): string | undefined {
  if (pathValue === undefined) return pathValue;
  const parts = pathValue.split(":").filter((part) => part !== bin);
  return parts.length === 0 ? undefined : parts.join(":");
}

/**
 * Installs a fake `opencode` binary on a temporary `PATH` so maintenance tests
 * can drive `init` / `update` / `doctor` without a real OpenCode installation.
 * The binary echoes the requested version and a fixed model list for any
 * invocation; schema probes (`debug`) return success without touching disk.
 *
 * The `failAfterDebugCalls` option makes the fake stateful: the first N
 * `debug config` calls succeed, and the (N+1)-th and later calls fail. N
 * is `threshold`. The state is persisted via the supplied file so the
 * counter survives across separate shell invocations.
 */
export async function installFakeOpenCode(
  versionOrOptions: string | InstallFakeOpenCodeOptions = TEST_OPENCODE_VERSION,
): Promise<FakeOpenCodeEnvironment> {
  registerProcessCleanup();
  const version = typeof versionOrOptions === "string" ? versionOrOptions : (versionOrOptions.version ?? TEST_OPENCODE_VERSION);
  const failAfter = typeof versionOrOptions === "string" ? undefined : versionOrOptions.failAfterDebugCalls;
  const modelList = typeof versionOrOptions === "string"
    ? TEST_OPENCODE_MODEL_LIST
    : (versionOrOptions.modelList ?? TEST_OPENCODE_MODEL_LIST);
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-opencode-"));
  const bin = join(parent, "bin");
  installedBins.add(parent);
  await mkdir(bin);
  const script = join(bin, "opencode");
  const debugCountFile = failAfter === undefined ? "" : failAfter.file;
  const debugThreshold = failAfter === undefined ? "0" : String(failAfter.threshold);
  const body = `#!/bin/sh
case "$1" in
  --version)
    if [ "\${POIESIS_TEST_OPENCODE_VERSION+set}" = set ]; then
      printf '%s\\n' "$POIESIS_TEST_OPENCODE_VERSION"
    else
      printf '${version}\\n'
    fi
    exit 0
    ;;
  models)
    if [ "$POIESIS_TEST_OPENCODE_FAIL" = "1" ]; then
      printf 'forced models failure\\n' >&2
      exit 1
    fi
    if [ "\${POIESIS_TEST_OPENCODE_MODELS+set}" = set ]; then
      printf '%s\\n' "$POIESIS_TEST_OPENCODE_MODELS"
    else
      printf '${modelList.join("\\n")}\\n'
    fi
    exit 0
    ;;
  debug)
    if [ "$POIESIS_TEST_OPENCODE_FAIL" = "1" ]; then
      printf 'forced doctor failure\\n' >&2
      exit 1
    fi
    if [ -n "${debugCountFile}" ]; then
      count=$(cat "${debugCountFile}" 2>/dev/null || echo "0")
      count=$(expr "\${count}" + 1)
      mkdir -p "$(dirname "${debugCountFile}")"
      printf '%s' "\${count}" > "${debugCountFile}"
      if [ "\${count}" -gt "${debugThreshold}" ]; then
        printf 'stateful fake-opencode: debug call #\${count} exceeds threshold ${debugThreshold}\\n' >&2
        exit 1
      fi
    fi
    exit 0
    ;;
esac
exit 0
`;
  await writeFile(script, body);
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  const nextPath = previousPath === undefined || previousPath === ""
    ? bin
    : `${bin}:${previousPath}`;
  process.env.PATH = nextPath;
  let restored = false;
  return {
    bin,
    parent,
    restore: () => {
      if (restored) return;
      restored = true;
      installedBins.delete(parent);
      // Restore PATH: strip this install's bin prefix AND any other
      // tracked install's bin prefix that may have leaked through a
      // missed restore on a prior install. The captured previousPath
      // remains the authoritative baseline.
      let restored_path = stripBinPrefix(previousPath, bin);
      for (const otherParent of installedBins) {
        const otherBin = join(otherParent, "bin");
        restored_path = stripBinPrefix(restored_path, otherBin);
      }
      process.env.PATH = restored_path;
      // Synchronously schedule bin-dir cleanup. We deliberately do NOT
      // await it inside restore() — restore() is intentionally
      // synchronous so callers can call it from `finally` blocks
      // without changing their error-handling shape — but we fire the
      // rm eagerly so the directory is normally gone before any
      // subsequent filesystem check. Failures here do not affect
      // correctness — the process-exit hook above catches anything we
      // miss.
      void rm(parent, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

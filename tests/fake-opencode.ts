import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
   * `TEST_OPENCODE_MODEL_LIST`. Pass an empty list to simulate an
   * OpenCode installation that has not downloaded any models so every
   * configured model is reported as unavailable.
   */
  modelList?: readonly string[];
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
  const version = typeof versionOrOptions === "string" ? versionOrOptions : (versionOrOptions.version ?? TEST_OPENCODE_VERSION);
  const failAfter = typeof versionOrOptions === "string" ? undefined : versionOrOptions.failAfterDebugCalls;
  const modelList = typeof versionOrOptions === "string"
    ? TEST_OPENCODE_MODEL_LIST
    : (versionOrOptions.modelList ?? TEST_OPENCODE_MODEL_LIST);
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-opencode-"));
  const bin = join(parent, "bin");
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
  return {
    bin,
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
}

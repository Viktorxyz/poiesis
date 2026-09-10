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

/**
 * Installs a fake `opencode` binary on a temporary `PATH` so maintenance tests
 * can drive `init` / `update` / `doctor` without a real OpenCode installation.
 * The binary echoes the requested version and a fixed model list for any
 * invocation; schema probes (`debug`) return success without touching disk.
 */
export async function installFakeOpenCode(
  version: string = TEST_OPENCODE_VERSION,
): Promise<FakeOpenCodeEnvironment> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-fake-opencode-"));
  const bin = join(parent, "bin");
  await mkdir(bin);
  const script = join(bin, "opencode");
  const body = `#!/bin/sh
case "$1" in
  --version)
    printf '${version}\\n'
    exit 0
    ;;
  models)
    printf '${TEST_OPENCODE_MODEL_LIST.join("\\n")}\\n'
    exit 0
    ;;
  debug)
    if [ "$POIESIS_TEST_OPENCODE_FAIL" = "1" ]; then
      printf 'forced doctor failure\\n' >&2
      exit 1
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

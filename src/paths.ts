import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";
import { PoiesisError } from "./errors.js";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function resolveGitRoot(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (result.exitCode !== 0 || !result.stdout) {
    throw new PoiesisError("NOT_GIT_REPOSITORY", "Poiesis requires a Git repository", { cwd });
  }
  return resolve(result.stdout);
}

export function poiesisPath(root: string, ...parts: string[]): string {
  return join(root, ".poiesis", ...parts);
}

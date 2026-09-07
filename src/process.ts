import { spawn } from "node:child_process";
import { PoiesisError } from "./errors.js";

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  allowFailure?: boolean;
}

export interface RunResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const result = await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        command,
        args,
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new PoiesisError("COMMAND_FAILED", `${command} exited with code ${result.exitCode}`, {
      command,
      args,
      exitCode: result.exitCode,
      stderr: bounded(result.stderr),
    });
  }
  return result;
}

export function bounded(value: string, limit = 8_000): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... truncated ${value.length - limit} bytes`;
}

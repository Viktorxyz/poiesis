import { spawn } from "node:child_process";
import { PoiesisError } from "./errors.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const TRUNCATION_MARKER_BYTES = 64;

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export async function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const startedAt = Date.now();

  const result = await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      killSignal: "SIGTERM",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (payload: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (error) {
        // Best effort; child may have already exited.
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          // Best effort.
        }
      }, 2_000);
    }, timeoutMs);

    const consume = (bucket: Buffer[], buffer: Buffer, side: "stdout" | "stderr"): void => {
      const currentBytes = side === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = maxBytes - currentBytes;
      if (remaining <= TRUNCATION_MARKER_BYTES) {
        if (side === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      if (buffer.length <= remaining) {
        bucket.push(buffer);
        if (side === "stdout") stdoutBytes += buffer.length;
        else stderrBytes += buffer.length;
        return;
      }
      const keep = buffer.subarray(0, Math.max(0, remaining - TRUNCATION_MARKER_BYTES));
      bucket.push(Buffer.from(keep));
      if (side === "stdout") {
        stdoutBytes += keep.length;
        stdoutTruncated = true;
      } else {
        stderrBytes += keep.length;
        stderrTruncated = true;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => consume(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => consume(stderr, chunk, "stderr"));
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      finish({
        command,
        args,
        exitCode,
        stdout: stripTrailingWhitespace(Buffer.concat(stdout).toString("utf8")),
        stderr: stripTrailingWhitespace(Buffer.concat(stderr).toString("utf8")),
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        signal,
        durationMs: Date.now() - startedAt,
      });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

  if (result.timedOut) {
    throw new PoiesisError(
      "COMMAND_TIMEOUT",
      `${command} exceeded ${timeoutMs}ms timeout`,
      {
        command,
        args,
        timeoutMs,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: bounded(result.stdout),
        stderr: bounded(result.stderr),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      },
      124,
    );
  }
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new PoiesisError("COMMAND_FAILED", `${command} exited with code ${result.exitCode}`, {
      command,
      args,
      exitCode: result.exitCode,
      stderr: bounded(result.stderr),
      stderrTruncated: result.stderrTruncated,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return result;
}

export function bounded(value: string, limit = 8_000): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... truncated ${value.length - limit} bytes`;
}

function stripTrailingWhitespace(value: string): string {
  return value.replace(/[\s\u0000]+$/, "");
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new PoiesisError("INVALID_TIMEOUT", `Timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`, { value });
  }
  return value;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PoiesisError("INVALID_MAX_BYTES", "Max bytes must be a positive safe integer", { value });
  }
  return value;
}

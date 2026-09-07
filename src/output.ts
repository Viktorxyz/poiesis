import { asPoiesisError } from "./errors.js";

export interface Success<T> {
  ok: true;
  operation: string;
  result: T;
}

export function writeSuccess<T>(operation: string, result: T): void {
  process.stdout.write(`${JSON.stringify({ ok: true, operation, result } satisfies Success<T>, null, 2)}\n`);
}

export function writeFailure(error: unknown): never {
  const normalized = asPoiesisError(error);
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details,
        },
      },
      null,
      2,
    )}\n`,
  );
  process.exit(normalized.exitCode);
}

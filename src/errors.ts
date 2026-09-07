export type ErrorDetails = Record<string, unknown>;

export class PoiesisError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;
  readonly exitCode: number;

  constructor(code: string, message: string, details: ErrorDetails = {}, exitCode = 1) {
    super(message);
    this.name = "PoiesisError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function asPoiesisError(error: unknown): PoiesisError {
  if (error instanceof PoiesisError) return error;
  if (error instanceof Error) {
    return new PoiesisError("UNEXPECTED", error.message, { cause: error.name });
  }
  return new PoiesisError("UNEXPECTED", String(error));
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details: ErrorDetails = {},
): asserts condition {
  if (!condition) throw new PoiesisError(code, message, details);
}

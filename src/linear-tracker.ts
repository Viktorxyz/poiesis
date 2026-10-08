import { Buffer } from "node:buffer";
import { PoiesisError, invariant } from "./errors.js";
import {
  assertKind,
  decorateBody,
  isRecord,
  metadataFromItem,
  requiredText,
  trackerItem,
  type TrackerItem,
  type TrackerItemKind,
  type TrackerMetadata,
} from "./tracker-item.js";
import { completeUtf8PrefixLength } from "./utf8-prefix.js";
import { sanitizeSubprocessOutput } from "./url-userinfo.js";
import type {
  CreateSpecInput,
  CreateTicketInput,
  TrackerAdapter,
  TrackerComment,
  SupersedeInput,
  UpdateTicketInput,
  UpdateTrackerItemInput,
} from "./adapters.js";

/**
 * Spec #139 / ticket #141 — the first-class Linear tracker.
 *
 * Poiesis talks to Linear's official GraphQL endpoint directly over an
 * injected transport. There is deliberately NO Linear SDK dependency: the
 * adapter owns its own request shape so the credential, the redaction
 * boundary, the retry policy, and the ambiguity refusals are all explicit
 * and testable instead of being delegated to a library whose defaults
 * Poiesis cannot inspect.
 *
 * Poiesis identity maps onto Linear as follows:
 *
 *   - a Poiesis **Spec** is an ordinary Linear **issue**;
 *   - a Poiesis **Ticket** is a Linear **child issue** (`parentId`), which
 *     is a real Linear parent/child relation, not a synthesized one;
 *   - a configured Linear **project** is an optional association;
 *   - the Poiesis metadata block lives in the issue description, so the
 *     existing metadata / comment / close supersede semantics apply
 *     unchanged. Poiesis never fabricates a native Linear relation to
 *     express supersession.
 *
 * SECURITY. The credential is read ONLY from `LINEAR_API_KEY` (sent as a
 * raw `Authorization` value) or `LINEAR_OAUTH_TOKEN` (sent as `Bearer
 * <token>`), exactly one of the two. It is never written to the Poiesis
 * config, never placed in a `TrackerItem`, never logged, and never copied
 * into an error message or an error's `details`; every echoed byte that
 * reaches an error goes through the redactor first.
 *
 * BOUNDED (ticket #150). Every attempt carries its own `AbortSignal` and
 * ends at a fixed attempt deadline, and every operation — all its attempts,
 * all its waits, and the idempotency probe — is refused at a fixed total
 * budget. Without those two ceilings a Linear answer that simply never
 * arrives hangs the caller forever: no error, no receipt, no bound. What
 * Poiesis does with a timeout depends only on what the mode can safely do
 * next, which is why the same deadline produces three different outcomes: a
 * read is retried, an idempotent create re-probes the identity it already
 * used, and a non-idempotent mutation is reported as the ambiguity it is
 * rather than replayed.
 *
 * ---------------------------------------------------------------------------
 * BOUNDED RESPONSE (ticket #167)
 * ---------------------------------------------------------------------------
 *
 * The transport ended at `await response.text()`, so an answer of ANY size
 * became a resident string before a single byte of it was judged: the only
 * bound was on the diagnostic built afterwards, which arrives after the whole
 * document has already been read, held, and handed to the redaction rule. The
 * ceiling now lives where the bytes arrive. The body is read delivery by
 * delivery, the first byte past the ceiling CANCELS the transfer, and the text
 * kept is the longest valid UTF-8 PREFIX of what was received.
 *
 * `Content-Length` is deliberately never consulted. It is a claim by the very
 * party being bounded, and a bound that trusts it is not a bound: a header
 * that says 12 bytes must not make Poiesis read an unbounded body, and a
 * chunked answer with no header at all must be bounded exactly the same way.
 *
 * A 2xx whose capture was cut is `LINEAR_RESPONSE_TOO_LARGE` and is never
 * parsed and never retried — a cut body is not malformed JSON, it is Poiesis'
 * own ceiling, and the same answer would be cut again. A MUTATION that reached
 * Linear and whose answer was cut is `LINEAR_MUTATION_UNCERTAIN` with
 * `reason: response-too-large`, because the work may or may not have landed
 * and the answer that would have said so is the one Poiesis refused to read.
 *
 * Everything Poiesis echoes about a failure — a transport exception's
 * message, an HTTP body, a GraphQL `message` / `code` — goes through ONE
 * pipeline: the bounded capture, then the existing URL-userinfo rule told the
 * TRUTH about whether the text was cut, then exact credential replacement,
 * then a final 8 KiB bound. A SUCCESSFUL `data` payload is returned
 * byte-for-byte: it is the Author's own content coming back, not an upstream
 * diagnostic, and rewriting it would corrupt the item Poiesis just read.
 */

/** The official Linear GraphQL endpoint. Never proxied, never overridden by config. */
export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/** A personal Linear API key: sent as a raw `Authorization` value. */
export const LINEAR_API_KEY_VARIABLE = "LINEAR_API_KEY";
/** A Linear OAuth access token: sent as `Authorization: Bearer <token>`. */
export const LINEAR_OAUTH_TOKEN_VARIABLE = "LINEAR_OAUTH_TOKEN";

export interface LinearHttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /**
   * Ticket #150 — the deadline for THIS attempt, and it is never absent. A
   * transport that receives no signal cannot be stopped, so an attempt without
   * one is an unbounded wait: a Linear answer that never arrives would hang the
   * caller with no error and no bound.
   */
  readonly signal: AbortSignal;
}

export interface LinearHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Ticket #167 — the BOUNDED capture, never a bare string.
   *
   * A `string` cannot say whether it is the whole answer, so a transport
   * that returned one made "Poiesis could not read this" indistinguishable
   * from "there was nothing to refuse": the truncation would be invisible at
   * the one place that has to act on it. The three fields are the whole
   * contract — what was read, how much of it the text really carries, and
   * whether anything was dropped.
   */
  readonly body: LinearBodyCapture;
}

/** What one response capture actually holds. */
export interface LinearBodyCapture {
  /** The longest valid UTF-8 PREFIX of the bytes received, and nothing else. */
  readonly text: string;
  /** The bytes `text` really carries — the ceiling, never a claimed length. */
  readonly capturedBytes: number;
  /** True when the ceiling or an undecodable byte dropped something. */
  readonly truncated: boolean;
}

/**
 * Ticket #167 — the ONE thing a capture needs from a response body.
 *
 * Deliberately structural rather than the platform's `Response["body"]`: the
 * capture is a real read against a reader and a cancel, and a test can
 * therefore hand it a reader whose deliveries, cut, and cancel behavior it
 * owns. Nothing here is a production capability a caller can widen.
 */
export interface LinearResponseBodyStream {
  getReader(): {
    read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
    cancel(reason?: unknown): Promise<unknown>;
  };
}

export type LinearTransport = (request: LinearHttpRequest) => Promise<LinearHttpResponse>;

/** A scheduled deadline Poiesis can take back before it fires. */
export interface LinearTimerHandle {
  readonly cancel: () => void;
}

/** Ticket #150 — the timer seam, so a deadline is testable without wall clock. */
export type LinearTimer = (ms: number, onElapsed: () => void) => LinearTimerHandle;

/**
 * Ticket #141 — every source of nondeterminism is injected so the adapter
 * is testable without a live workspace, a real clock, or a real random
 * source. Production passes nothing and gets the real implementations.
 */
export interface LinearTrackerSeams {
  /** Credential source. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** HTTP transport. Defaults to the global `fetch`. */
  readonly transport?: LinearTransport;
  /** Monotonic millisecond clock, used SOLELY to bound the retry budget. */
  readonly clock?: () => number;
  /**
   * Ticket #161 — the wall clock, in EPOCH milliseconds.
   *
   * `Retry-After` has two forms and only one of them needs a clock. The
   * delta-seconds form is a DURATION Poiesis can wait out by itself; the
   * HTTP-date form is an ABSOLUTE instant, so the only way to turn it into a
   * delay is to subtract it from a clock in the SAME epoch. That is the wall
   * clock, and it is a different quantity from `clock` above: the budget clock
   * measures elapsed time and must only move forward, while an HTTP-date lives
   * in epoch time and is meaningless against a monotonic reading. Subtract the
   * wrong one and every date is either already overdue or billions of
   * milliseconds away, so the delay is wrong in a way no later check can
   * repair.
   *
   * Defaults to the real wall clock. Like every other seam here it is internal
   * to the provider: it is not a package-root export, and the durable
   * configuration has no setting for it.
   */
  readonly epochClock?: () => number;
  /** Injected delay, used for rate-limit backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected UUID source, so an idempotent create reuses one identity. */
  readonly uuid?: () => string;
  /**
   * Ticket #150 — the timer that ends an attempt. The clock above measures
   * time; this one ADVANCES it, and it is the only thing that may abort a
   * request. Injecting it is what makes the deadline provable: a test fires a
   * deadline deliberately instead of waiting for it, so "Poiesis bounded this"
   * is distinguishable from "the machine was quick".
   */
  readonly timer?: LinearTimer;
}

export interface LinearTrackerConfig {
  readonly team: string;
  readonly project?: string;
}

interface ResolvedSeams {
  readonly env: Record<string, string | undefined>;
  readonly transport: LinearTransport;
  readonly clock: () => number;
  readonly epochClock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly uuid: () => string;
  readonly timer: LinearTimer;
  readonly authorization: string;
}

function readCredential(env: Record<string, string | undefined>, variable: string): string | null {
  const raw = env[variable];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolve the single Linear credential. Exactly one of the two variables
 * may be present: preferring one when both are set would make the
 * effective identity depend on shell state the Author cannot see, and
 * proceeding with neither would move an authentication failure away from
 * its cause.
 */
function resolveAuthorization(env: Record<string, string | undefined>): string {
  const apiKey = readCredential(env, LINEAR_API_KEY_VARIABLE);
  const oauthToken = readCredential(env, LINEAR_OAUTH_TOKEN_VARIABLE);
  if (apiKey !== null && oauthToken !== null) {
    throw new PoiesisError(
      "LINEAR_AUTH_AMBIGUOUS",
      `Both ${LINEAR_API_KEY_VARIABLE} and ${LINEAR_OAUTH_TOKEN_VARIABLE} are set; set exactly one so the Linear identity Poiesis uses is explicit`,
      { variables: [LINEAR_API_KEY_VARIABLE, LINEAR_OAUTH_TOKEN_VARIABLE] },
    );
  }
  if (apiKey === null && oauthToken === null) {
    throw new PoiesisError(
      "LINEAR_AUTH_MISSING",
      `No Linear credential found; set exactly one of ${LINEAR_API_KEY_VARIABLE} (raw Authorization) or ${LINEAR_OAUTH_TOKEN_VARIABLE} (Bearer) in the environment. The credential is never stored in the Poiesis config`,
      { variables: [LINEAR_API_KEY_VARIABLE, LINEAR_OAUTH_TOKEN_VARIABLE] },
    );
  }
  return apiKey === null ? `Bearer ${oauthToken as string}` : apiKey;
}

function resolveSeams(seams: LinearTrackerSeams): ResolvedSeams {
  const env = seams.env ?? process.env;
  return {
    env,
    transport: seams.transport ?? defaultTransport,
    clock: seams.clock ?? (() => Date.now()),
    // Ticket #161: the same real clock as the default budget clock, but a
    // different reading of it. One is elapsed time; the other is the epoch an
    // HTTP-date is compared against.
    epochClock: seams.epochClock ?? (() => Date.now()),
    sleep: seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    uuid: seams.uuid ?? (() => randomUUID()),
    timer: seams.timer ?? defaultTimer,
    authorization: resolveAuthorization(env),
  };
}

/**
 * The real deadline. The handle is deliberately NOT unref'd: a pending
 * attempt timeout is the only thing that can end a request Poiesis has already
 * sent, so the process must stay alive until it fires or is cancelled.
 */
const defaultTimer: LinearTimer = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, Math.max(0, ms));
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
};

const defaultTransport: LinearTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    // The attempt's own deadline reaches the socket. Without this the timer
    // would classify an abort Poiesis never sends, and a stalled connection
    // would wait forever.
    signal: request.signal,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await captureLinearResponseBody(response.body) };
};

/**
 * Ticket #167 — the ONE bounded body capture.
 *
 * `response.text()` reads until the peer stops sending, so the ceiling has to
 * be enforced on the WIRE rather than on the finished string: a bound applied
 * afterwards is applied to a document that is already fully resident, which is
 * the memory cost the ceiling exists to refuse. So the body is read delivery
 * by delivery, the first byte past the ceiling stops the read, and the reader
 * is CANCELLED so the bytes Poiesis already refused are not queued behind a
 * decision it has made. Cancelling is also what releases the socket, rather
 * than abandoning a transfer that is still running.
 *
 * The text is the longest valid UTF-8 PREFIX of the bytes received (see
 * `src/utf8-prefix.ts`). A ceiling can stop inside a code point and a peer can
 * simply send a bad byte, and neither may become a U+FFFD inside a document
 * Poiesis will quote back to an Author.
 *
 * A body that is absent (204, HEAD) is an empty COMPLETE capture: there is
 * nothing to refuse and nothing to parse.
 */
export async function captureLinearResponseBody(
  body: LinearResponseBodyStream | null,
): Promise<LinearBodyCapture> {
  if (body === null) return { text: "", capturedBytes: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (value === undefined || value.byteLength === 0) continue;
      // The ceiling is a fact about the bytes Poiesis ACCEPTED, so `remaining`
      // is recomputed on every delivery and is the only thing that can end this
      // loop: a capture that kept whole deliveries would grow without limit,
      // would never reach `done`, and would read a peer that never stops
      // forever — a bound that never fires is not a bound.
      const remaining = LINEAR_MAX_RESPONSE_BYTES - captured;
      if (value.byteLength > remaining) {
        // A delivery that crosses the ceiling is cut AT it. Only the part under
        // it is retained: the bytes past it are exactly what the ceiling
        // refuses, and keeping them is the memory cost this ticket removed.
        if (remaining > 0) {
          chunks.push(Buffer.from(value.subarray(0, remaining)));
          captured += remaining;
        }
        truncated = true;
        break;
      }
      // `>` and not `>=`, and a body that is EXACTLY the ceiling is COMPLETE:
      // nothing was refused, so calling it truncated would refuse to parse a
      // legal answer and train an operator to ignore the refusal.
      chunks.push(Buffer.from(value));
      captured += value.byteLength;
    }
  } finally {
    if (!drained) {
      // The rest of the answer is exactly what the ceiling refuses. Leaving
      // the reader open keeps a transfer running for bytes nobody will read,
      // and a cancel that fails changes nothing about the capture above.
      await reader.cancel().catch(() => undefined);
    }
  }
  const received = Buffer.concat(chunks, captured);
  const prefix = completeUtf8PrefixLength(received);
  if (prefix < received.length) truncated = true;
  return { text: received.subarray(0, prefix).toString("utf8"), capturedBytes: prefix, truncated };
}

/** The GraphQL operation name, used to label every typed failure. */
function operationOf(document: string): string {
  return /^(?:query|mutation)\s+(\w+)/.exec(document)?.[1] ?? "unknown";
}

/**
 * How safe it is to try the same request again.
 *
 *   - `read` changes nothing, so a retry is always safe;
 *   - `idempotent` is a mutation whose identity is fixed by the caller (the
 *     create sends one client-chosen UUID), so a retry cannot produce a
 *     second Linear entity;
 *   - `mutation` has no such anchor, so a retry could double a comment or
 *     re-apply an update Poiesis cannot detect. It is never replayed.
 */
type LinearCallMode = "read" | "idempotent" | "mutation";

/**
 * Ticket #150 — the budget a nested call inherits from the operation that owns
 * it.
 *
 * A nested call that starts a FRESH budget is not bounded by its parent, it
 * doubles the parent: an idempotent create would wait up to two operation
 * deadlines for one Poiesis item, and the probe — which is only ever asked
 * whether one identity exists — would be entitled to its own full retry budget
 * inside a budget that was already spent. So the enclosing operation passes its
 * ABSOLUTE deadline down, and the nested call clamps to it. The remaining time
 * is deliberately not passed as a second number: one deadline is the single
 * source of truth, and a snapshot of "what was left" would go stale inside the
 * very call it bounds.
 */
export interface LinearProbeBudget {
  /** Absolute clock time, from the injected clock, the whole operation must finish by. */
  readonly deadlineAt: number;
  /**
   * The nested call asks ONE question, so it makes ONE attempt. A probe that
   * cannot answer on its first try will not answer on its third: Linear is not
   * becoming reachable inside the milliseconds that are left.
   */
  readonly singleAttempt: true;
}

type LinearAttempt =
  | { readonly kind: "data"; readonly data: Record<string, unknown> }
  | { readonly kind: "rate-limited"; readonly status: number; readonly retryAfterMs: number }
  | { readonly kind: "server-error"; readonly status: number; readonly body: string; readonly bodyTruncated: boolean }
  | { readonly kind: "transport"; readonly cause: string; readonly message: string }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "probe-failed"; readonly cause: string }
  /**
   * Ticket #167 — a 2xx answer whose capture was cut by the ceiling.
   *
   * It is neither data nor a refusal: Linear answered, and Poiesis holds a
   * prefix of the answer. Parsing that prefix would blame Linear's encoding
   * for Poiesis' own ceiling, so the attempt is classified and never parsed.
   */
  | { readonly kind: "response-too-large"; readonly status: number; readonly capturedBytes: number }
  | { readonly kind: "rejected"; readonly error: PoiesisError };

/**
 * Send one request and classify the outcome, never throwing for a
 * condition the caller may be allowed to retry.
 *
 * `attemptTimeoutMs` is the deadline for THIS attempt, and it is enforced by
 * aborting the request's own signal rather than by racing the promise. Racing
 * would leave the socket open and the transport running; aborting ends the
 * work. The flag — not the shape of the error the transport threw — decides
 * whether the attempt timed out, because Poiesis owns the only signal it ever
 * passes, so an abort can only be the deadline it armed.
 */
async function attemptOnce(
  seams: ResolvedSeams,
  document: string,
  variables: Record<string, unknown>,
  attemptTimeoutMs: number,
): Promise<LinearAttempt> {
  const operation = operationOf(document);
  const controller = new AbortController();
  let deadlineElapsed = false;
  const deadline = seams.timer(attemptTimeoutMs, () => {
    deadlineElapsed = true;
    controller.abort();
  });
  const request: LinearHttpRequest = {
    url: LINEAR_GRAPHQL_ENDPOINT,
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: seams.authorization,
    },
    body: JSON.stringify({ query: document, variables }),
    signal: controller.signal,
  };
  let response: LinearHttpResponse;
  try {
    response = await seams.transport(request);
  } catch (error) {
    if (deadlineElapsed) return { kind: "timeout", timeoutMs: attemptTimeoutMs };
    return {
      kind: "transport",
      cause: error instanceof Error ? error.name : "unknown",
      // A transport exception is the ONE diagnostic nobody chose to be safe:
      // its text is built by the socket layer and routinely carries the URL
      // that failed, and a proxy URL carries a credential in its userinfo.
      message: diagnose(seams, error instanceof Error ? error.message : String(error), false).text,
    };
  } finally {
    // The deadline is taken back the moment the attempt is over, so a settled
    // attempt can never abort a later one.
    deadline.cancel();
  }
  if (deadlineElapsed) {
    // An answer that arrived after the attempt's deadline is not used. A late
    // answer is still an answer about a request Poiesis already gave up on,
    // and for a mutation acting on it would be acting on evidence the deadline
    // said no longer existed.
    return { kind: "timeout", timeoutMs: attemptTimeoutMs };
  }
  if (response.status === 401 || response.status === 403) {
    // A refused credential will not fix itself; retrying only spends the
    // Author's rate-limit budget.
    return {
      kind: "rejected",
      error: new PoiesisError(
        "LINEAR_AUTH_FAILED",
        `Linear rejected the configured credential (HTTP ${response.status})`,
        { operation, status: response.status },
      ),
    };
  }
  if (response.status === 429) {
    return {
      kind: "rate-limited",
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers, LINEAR_DEFAULT_RETRY_DELAY_MS, seams.epochClock),
    };
  }
  if (response.status >= 500) {
    return serverError(seams, operation, response);
  }
  if (response.status < 200 || response.status >= 300) {
    const body = diagnose(seams, response.body.text, response.body.truncated);
    return {
      kind: "rejected",
      error: new PoiesisError("LINEAR_HTTP_ERROR", `Linear request ${operation} failed with HTTP ${response.status}`, {
        operation,
        status: response.status,
        body: body.text,
        // Only when it happened, and it means one thing: this is not the whole
        // body. A flag that is always present is a flag an operator learns to
        // skip, and a body that stopped mid-sentence is evidence about the
        // answer, not about the refusal.
        ...(response.body.truncated || body.truncated ? { bodyTruncated: true } : {}),
      }),
    };
  }
  if (response.body.truncated) {
    // Ticket #167. The status says Linear answered, and the capture says
    // Poiesis does not hold the answer. Parsing the prefix would report a
    // syntax error for a body that is not malformed but refused, and the
    // reason has to name the ceiling rather than blame Linear's encoding.
    return {
      kind: "response-too-large",
      status: response.status,
      capturedBytes: response.body.capturedBytes,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.body.text);
  } catch (error) {
    return {
      kind: "rejected",
      error: new PoiesisError("LINEAR_HTTP_ERROR", `Linear request ${operation} did not return JSON`, {
        operation,
        status: response.status,
        cause: error instanceof Error ? error.name : "unknown",
      }),
    };
  }
  if (!isRecord(payload)) {
    return {
      kind: "rejected",
      error: new PoiesisError("LINEAR_HTTP_ERROR", `Linear request ${operation} returned a non-object payload`, {
        operation,
        status: response.status,
      }),
    };
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return {
      kind: "rejected",
      error: new PoiesisError("LINEAR_GRAPHQL_ERROR", `Linear rejected the ${operation} operation`, {
        operation,
        ...graphqlErrorDetails(seams, payload.errors, response.body.truncated),
      }),
    };
  }
  if (!isRecord(payload.data)) {
    return {
      kind: "rejected",
      error: new PoiesisError("LINEAR_GRAPHQL_ERROR", `Linear returned no data for ${operation}`, { operation }),
    };
  }
  return { kind: "data", data: payload.data };
}

/**
 * Run an operation within the retry bound AND the operation deadline.
 *
 * `beforeRetry` is the idempotency anchor: an `idempotent` create passes a
 * probe that re-reads the identity it already used, so a lost response
 * resolves to the issue the first attempt created instead of a second one.
 * That probe is also the only evidence that can tell "nothing was created"
 * from "the create landed and its answer was lost", so a probe that FAILS
 * resolves nothing — the create's outcome is unknown, and the operation
 * reports it as uncertain rather than letting the probe's own error escape and
 * invite a caller to retry the create under a new identity.
 *
 * The probe runs INSIDE this operation's deadline and as a single attempt
 * (`LinearProbeBudget`), so the create's total is one budget rather than one
 * budget per nested call, and a probe that cannot answer ends the flow instead
 * of spending a second budget failing to.
 */
async function executeWith(
  seams: ResolvedSeams,
  document: string,
  variables: Record<string, unknown>,
  mode: LinearCallMode,
  beforeRetry?: (attempt: number, budget: LinearProbeBudget) => Promise<Record<string, unknown> | null>,
  enclosing?: LinearProbeBudget,
): Promise<Record<string, unknown>> {
  const operation = operationOf(document);
  const retryable = mode !== "mutation";
  const startedAt = seams.clock();
  // The enclosing deadline WINS over a fresh one: a nested call is bounded by
  // the operation that owns it, never by a second full allowance.
  const deadlineAt =
    enclosing === undefined ? startedAt + LINEAR_OPERATION_DEADLINE_MS : Math.min(startedAt + LINEAR_OPERATION_DEADLINE_MS, enclosing.deadlineAt);
  const maxAttempts = enclosing?.singleAttempt === true ? 1 : LINEAR_MAX_ATTEMPTS;
  // Whether this operation reached Linear at all, and whether Linear ever
  // answered. Together they decide what an exhausted budget MEANS: nothing was
  // sent, so asking again is free; something was sent and never confirmed, so
  // the outcome is genuinely unknown.
  let dispatched = false;
  for (let attempt = 1; ; attempt += 1) {
    // No attempt and no probe ever starts without budget left for it, so the
    // operation's total is bounded by its deadline and not only by its cap.
    if (seams.clock() >= deadlineAt) {
      throw operationDeadline(operation, mode, attempt - 1, ambiguous(mode, dispatched));
    }
    if (attempt > 1 && beforeRetry !== undefined) {
      let existing: Record<string, unknown> | null;
      try {
        existing = await beforeRetry(attempt, { deadlineAt, singleAttempt: true });
      } catch (error) {
        throw uncertainMutation(operation, {
          kind: "probe-failed",
          // A code from Poiesis's own vocabulary, never the probe's message:
          // the probe's failure came from Linear, so its text is upstream.
          cause: error instanceof PoiesisError ? error.code : error instanceof Error ? error.name : "unknown",
        });
      }
      if (existing !== null) return existing;
    }
    // The attempt may never outlive the operation it belongs to.
    const budget = Math.min(LINEAR_ATTEMPT_TIMEOUT_MS, deadlineAt - seams.clock());
    if (budget <= 0) throw operationDeadline(operation, mode, attempt - 1, ambiguous(mode, dispatched));
    dispatched = true;
    const outcome = await attemptOnce(seams, document, variables, budget);
    if (outcome.kind === "data") return outcome.data;
    if (outcome.kind === "rejected") throw outcome.error;
    if (outcome.kind === "response-too-large") {
      // Ticket #167 — the ceiling is not a transient condition, so no mode
      // retries it: the same answer is the same size. What differs is what
      // the refusal MEANS. A read changed nothing and is simply too large to
      // read. A mutation REACHED Linear, and the one document that would have
      // said whether the work landed is the document Poiesis refused to
      // parse — so the outcome is the ambiguity it is, reported with the
      // inspect-in-Linear instruction and never replayed.
      throw mode === "read" ? responseTooLarge(operation, outcome) : uncertainMutation(operation, outcome);
    }
    if (!retryable) throw uncertainMutation(operation, outcome);
    // A timed-out attempt is retried like any other transient failure, but not
    // once the operation itself is out of time: the deadline is the outer
    // guarantee, and reporting it beats spending the retry-wait budget to
    // arrive at the same refusal with a less precise cause.
    if (outcome.kind === "timeout" && seams.clock() >= deadlineAt) {
      throw operationDeadline(operation, mode, attempt, ambiguous(mode, dispatched));
    }
    if (attempt >= maxAttempts) throw exhausted(operation, outcome, attempt, ambiguous(mode, dispatched));
    const delay = boundedDelay(outcome, seams.clock() - startedAt, attempt);
    if (delay === null) throw exhausted(operation, outcome, attempt, ambiguous(mode, dispatched));
    await seams.sleep(delay);
  }
}

/**
 * Whether an operation that has run out of budget left an outcome that is
 * genuinely unknown, rather than one that simply did not happen.
 *
 * A `mutation` has no identity anchor at all. An `idempotent` create has one,
 * which is exactly why its answer matters: once an attempt has REACHED Linear
 * and nothing came back, the issue may exist, and a caller told "timed out,
 * nothing happened" would create it a second time. A `read` changed nothing, so
 * it keeps the plain timeout — the ordinary classification, unchanged.
 */
function ambiguous(mode: LinearCallMode, dispatched: boolean): boolean {
  return mode === "mutation" || (mode === "idempotent" && dispatched);
}

/** The delay before the next attempt, or null when the budget is spent. */
function redact(seams: ResolvedSeams, value: string): string {
  const credential =
    readCredential(seams.env, LINEAR_API_KEY_VARIABLE) ??
    readCredential(seams.env, LINEAR_OAUTH_TOKEN_VARIABLE);
  return credential === null ? value : value.split(credential).join("[redacted]");
}

/** One diagnostic, and whether the final bound cut it. */
interface LinearDiagnostic {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Ticket #167 — the ONE pipeline every echoed byte goes through.
 *
 * The order is the whole point and is not interchangeable:
 *
 *   1. the input is already a BOUNDED capture (the response ceiling, or an
 *      exception message small enough that bounding it is a formality), so no
 *      caller can hand this function an unbounded document;
 *   2. the existing URL-userinfo rule runs FIRST, because it is the only
 *      step that knows about structure, and a later cut through
 *      `scheme://authority` would leave exactly the partial userinfo the rule
 *      exists to withhold. It is told the TRUTH about the capture: a text the
 *      ceiling cut ends inside a possible authority, and the rule already
 *      fails closed on exactly that case. It is NOT told about the final
 *      bound, because that cut is not something it can be honest about: the
 *      sanitizer sees the whole text, where the authority may well be closed,
 *      and a capture flag it cannot verify is a guess;
 *   3. exact credential replacement runs on what survives the redaction —
 *      a credential outside any URL is still a credential, and a redactor
 *      that only understood URLs would miss every occurrence;
 *   4. the final bound runs LAST, so nothing after it can lengthen a
 *      diagnostic past the ceiling it exists to enforce. It is also safe
 *      after the redaction rather than before it: a cut applied to text that
 *      already carries no credential can only shorten it, so the only
 *      credential that could survive a cut is one the cut REVEALED — and
 *      revealing it is exactly what ordering the bound first would allow.
 *
 * A SUCCESSFUL `data` payload never comes here. It is the Author's own
 * content coming back, not a diagnostic about a failure, and rewriting it
 * would corrupt the item Poiesis just read.
 */
function diagnose(seams: ResolvedSeams, raw: string, captureTruncated: boolean): LinearDiagnostic {
  return boundDiagnostic(redact(seams, sanitizeSubprocessOutput(raw, { truncated: captureTruncated })));
}

/**
 * The final bound. The cut lands on a COMPLETE code point, so a diagnostic
 * never ends in U+FFFD, and it appends no marker of its own: the marker would
 * be the byte that pushes the text past the ceiling it exists to enforce, and
 * the byte counts that make the cut visible already travel beside it as
 * metadata.
 */
function boundDiagnostic(text: string): LinearDiagnostic {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= LINEAR_MAX_DIAGNOSTIC_BYTES) return { text, truncated: false };
  const prefix = completeUtf8PrefixLength(encoded.subarray(0, LINEAR_MAX_DIAGNOSTIC_BYTES));
  return { text: encoded.subarray(0, prefix).toString("utf8"), truncated: true };
}

/**
 * Ticket #167 — a Linear `errors` array, bounded and self-reporting.
 *
 * The list is unbounded on the wire and a validation refusal can carry a
 * megabyte in one entry, so three ceilings apply and each is REPORTED rather
 * than performed silently: at most `LINEAR_MAX_GRAPHQL_ERRORS` entries, each
 * `message` and `code` bounded, and `errorCount` / `errorsOmitted` saying how
 * many Linear sent and how many Poiesis left out. An operator who sees five
 * reported errors and a count of 300 knows the answer is incomplete, which is
 * the difference between a diagnosis and a guess.
 */
function graphqlErrorDetails(
  seams: ResolvedSeams,
  errors: readonly unknown[],
  captureTruncated: boolean,
): Record<string, unknown> {
  const reported = errors.slice(0, LINEAR_MAX_GRAPHQL_ERRORS);
  const omitted = errors.length - reported.length;
  return {
    errors: reported.map((entry) => {
      const rawMessage =
        isRecord(entry) && typeof entry.message === "string" ? entry.message : String(entry);
      const message = diagnose(seams, rawMessage, captureTruncated);
      const rawCode =
        isRecord(entry) && isRecord(entry.extensions) && typeof entry.extensions.code === "string"
          ? entry.extensions.code
          : null;
      const code = rawCode === null ? null : diagnose(seams, rawCode, captureTruncated);
      return {
        message: message.text,
        ...(code === null ? {} : { code: code.text }),
        ...(message.truncated ? { messageTruncated: true } : {}),
        ...(code?.truncated === true ? { codeTruncated: true } : {}),
      };
    }),
    errorCount: errors.length,
    ...(omitted > 0 ? { errorsOmitted: omitted } : {}),
  };
}

function boundedDelay(
  outcome: LinearAttempt,
  elapsedMs: number,
  attempt: number,
): number | null {
  const requested = outcome.kind === "rate-limited" ? outcome.retryAfterMs : LINEAR_DEFAULT_RETRY_DELAY_MS * attempt;
  const delay = Math.min(Math.max(0, requested), LINEAR_MAX_RETRY_DELAY_MS);
  return elapsedMs + delay > LINEAR_MAX_RETRY_WAIT_MS ? null : delay;
}

/**
 * `Retry-After` as milliseconds, honoring both the seconds and date forms.
 *
 * Ticket #161: the wall clock is consulted for the date form ONLY. A
 * delta-seconds value is already a duration, so reading a clock for it would
 * add an epoch the number does not live in; and an absolute date is exactly
 * the one form that cannot become a delay without one.
 */
function retryAfterMs(
  headers: Readonly<Record<string, string>>,
  fallbackMs: number,
  epochClock: () => number,
): number {
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (raw === undefined) return fallbackMs;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw.trim());
  return Number.isNaN(at) ? fallbackMs : Math.max(0, at - epochClock());
}

/**
 * A mutation whose outcome Poiesis cannot observe. The work may or may not
 * have landed in Linear, so it is reported as uncertain and never replayed.
 */
function uncertainMutation(operation: string, outcome: LinearAttempt): PoiesisError {
  const status = outcome.kind === "server-error" ? outcome.status : null;
  return new PoiesisError(
    "LINEAR_MUTATION_UNCERTAIN",
    `Linear did not confirm the ${operation} mutation, and Poiesis will not replay it; inspect the issue in Linear before retrying`,
    {
      operation,
      reason: outcome.kind,
      ...(status === null ? {} : { status }),
      ...(outcome.kind === "probe-failed" ? { probeFailure: outcome.cause } : {}),
      // Ticket #167: an operator staring at "response-too-large" needs the
      // numbers to know whether the ceiling was far away or barely crossed.
      ...(outcome.kind === "response-too-large"
        ? { capturedBytes: outcome.capturedBytes, maxResponseBytes: LINEAR_MAX_RESPONSE_BYTES }
        : {}),
    },
  );
}

/**
 * Ticket #167 — the ONE diagnostic a 5xx contributes.
 *
 * A 5xx is the only status worth retrying, so its body is the one diagnostic
 * a retry will carry up to `LINEAR_MAX_ATTEMPTS` times: it is bounded,
 * sanitized, and credential-free here, once, instead of at each of the
 * refusals it eventually produces. `bodyTruncated` means one thing — this is
 * not the whole body — and is true whether the ceiling cut the capture or
 * the final bound cut the diagnostic.
 */
function serverError(seams: ResolvedSeams, operation: string, response: LinearHttpResponse): LinearAttempt {
  const body = diagnose(seams, response.body.text, response.body.truncated);
  return {
    kind: "server-error",
    status: response.status,
    body: body.text,
    bodyTruncated: response.body.truncated || body.truncated,
  };
}

/**
 * Ticket #167 — a read whose answer Poiesis would not hold.
 *
 * The ceiling is a property of Poiesis, not of Linear, so the refusal names
 * Poiesis: the answer arrived, the bytes are real, and reading it is the thing
 * this ticket made impossible. The captured count and the ceiling travel with
 * it so the gap between them is visible without re-running anything.
 */
function responseTooLarge(
  operation: string,
  outcome: { readonly status: number; readonly capturedBytes: number },
): PoiesisError {
  return new PoiesisError(
    "LINEAR_RESPONSE_TOO_LARGE",
    `Linear's answer to ${operation} was not fully captured: Poiesis holds ${outcome.capturedBytes} bytes of it and will not parse a partial body`,
    {
      operation,
      status: outcome.status,
      capturedBytes: outcome.capturedBytes,
      maxResponseBytes: LINEAR_MAX_RESPONSE_BYTES,
    },
  );
}

function exhausted(
  operation: string,
  outcome: LinearAttempt,
  attempts: number,
  ambiguousOutcome = false,
): PoiesisError {
  if (outcome.kind === "rate-limited") {
    return new PoiesisError(
      "LINEAR_RATE_LIMITED",
      `Linear rate-limited the ${operation} operation after ${attempts} attempts`,
      { operation, attempts, status: outcome.status },
    );
  }
  if (outcome.kind === "server-error") {
    return new PoiesisError("LINEAR_HTTP_ERROR", `Linear request ${operation} failed with HTTP ${outcome.status}`, {
      operation,
      attempts,
      status: outcome.status,
      body: outcome.body,
      ...(outcome.bodyTruncated ? { bodyTruncated: true } : {}),
    });
  }
  if (outcome.kind === "timeout") {
    // A create that reached Linear and was never answered is NOT here: it is
    // reported as the ambiguity it is, because a plain timeout tells the caller
    // the create did not happen, and that is exactly what Poiesis cannot know.
    if (ambiguousOutcome) {
      return uncertainMutation(operation, outcome);
    }
    // Reads and un-dispatched operations land here: nothing half-done was left
    // behind, and the caller may simply ask again.
    return new PoiesisError(
      "LINEAR_REQUEST_TIMEOUT",
      `Linear request ${operation} did not answer within its bound after ${attempts} attempts`,
      {
        operation,
        attempts,
        reason: "attempt-timeout",
        timeoutMs: outcome.timeoutMs,
        attemptTimeoutMs: LINEAR_ATTEMPT_TIMEOUT_MS,
        deadlineMs: LINEAR_OPERATION_DEADLINE_MS,
      },
    );
  }
  return new PoiesisError("LINEAR_TRANSPORT_ERROR", `Linear request ${operation} could not be completed`, {
    operation,
    attempts,
    cause: outcome.kind === "transport" ? outcome.cause : "unknown",
    causeMessage: outcome.kind === "transport" ? outcome.message : undefined,
  });
}

/**
 * The whole operation spent its budget. What that MEANS depends on what the
 * operation left behind: a read left nothing, so a plain timeout is accurate
 * and retryable. A create that reached Linear left a real possibility that the
 * issue exists, so it is reported as the ambiguity it is — with the
 * inspect-before-retry instruction — instead of a retryable timeout a caller
 * would answer by creating the same Poiesis item twice.
 */
function operationDeadline(
  operation: string,
  mode: LinearCallMode,
  attempts: number,
  ambiguousOutcome: boolean,
): PoiesisError {
  if (ambiguousOutcome) {
    return uncertainMutation(operation, { kind: "timeout", timeoutMs: LINEAR_OPERATION_DEADLINE_MS });
  }
  return new PoiesisError(
    "LINEAR_REQUEST_TIMEOUT",
    `Linear request ${operation} did not complete within the operation budget`,
    {
      operation,
      attempts,
      reason: "operation-deadline",
      timeoutMs: LINEAR_OPERATION_DEADLINE_MS,
      attemptTimeoutMs: LINEAR_ATTEMPT_TIMEOUT_MS,
      deadlineMs: LINEAR_OPERATION_DEADLINE_MS,
    },
  );
}

function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

class LinearTracker implements TrackerAdapter {
  readonly provider = "linear" as const;
  readonly project: string;
  readonly team: string;
  readonly linearProject: string | undefined;
  /**
   * The resolved credential and the injected seams live in true `#private`
   * fields on purpose. An ordinary field would be an own enumerable
   * property, so `JSON.stringify(adapter)` — or any object logger, receipt,
   * or crash dump that reaches the adapter — would serialize the Linear
   * secret. `#` fields are invisible to enumeration, `JSON.stringify`, and
   * structured cloning.
   */
  readonly #seams: ResolvedSeams;

  constructor(config: LinearTrackerConfig, seams: LinearTrackerSeams) {
    this.team = requiredCoordinate(config.team, "tracker team");
    this.linearProject = config.project === undefined ? undefined : requiredCoordinate(config.project, "tracker project");
    // Linear has no repository project. The team is the non-secret
    // coordinate that scopes every issue Poiesis creates, so it is the
    // adapter's project identity.
    this.project = this.team;
    this.#seams = resolveSeams(seams);
  }

  async getSpec(id: string): Promise<TrackerItem> {
    return assertKind(this.toItem(await this.readIssue(requiredText(id, "id"))), "spec");
  }

  async getTicket(id: string): Promise<TrackerItem> {
    return assertKind(this.toItem(await this.readIssue(requiredText(id, "id"))), "ticket");
  }

  async createSpec(input: CreateSpecInput): Promise<TrackerItem> {
    const created = await this.createIssue(
      requiredText(input.title, "title"),
      decorateBody(input.body, { kind: "spec" }),
    );
    return this.toItem(created);
  }

  /**
   * A Poiesis Ticket is a real Linear CHILD issue: the parent Spec's Linear
   * UUID is sent as `parentId`, so Linear itself records the relationship.
   * The parent is read and kind-checked first, so a Ticket can never be
   * attached to whatever issue happens to share the identifier.
   */
  async createTicket(input: CreateTicketInput): Promise<TrackerItem> {
    const parentSpecId = requiredText(input.parentSpecId, "parentSpecId");
    const parentNode = await this.readIssue(parentSpecId);
    assertKind(this.toItem(parentNode), "spec");
    const created = await this.createIssue(
      requiredText(input.title, "title"),
      decorateBody(input.body, {
        kind: "ticket",
        parentSpecId: parentNode.identifier,
        dependencyText: requiredText(input.dependencyText, "dependencyText"),
      }),
      parentNode.id,
    );
    return this.toItem(created);
  }

  async updateSpec(id: string, input: UpdateTrackerItemInput): Promise<TrackerItem> {
    return this.toItem(await this.updateIssue(requiredText(id, "id"), "spec", input));
  }

  async updateTicket(id: string, input: UpdateTicketInput): Promise<TrackerItem> {
    return this.toItem(await this.updateIssue(requiredText(id, "id"), "ticket", input));
  }

  async closeSpec(id: string): Promise<TrackerItem> {
    const node = await this.readIssue(requiredText(id, "id"));
    assertKind(this.toItem(node), "spec");
    return this.toItem(await this.close(node));
  }

  async closeTicket(id: string): Promise<TrackerItem> {
    const node = await this.readIssue(requiredText(id, "id"));
    assertKind(this.toItem(node), "ticket");
    return this.toItem(await this.close(node));
  }

  supersedeSpec(id: string, input: SupersedeInput): Promise<TrackerItem> {
    return this.supersede(id, "spec", input);
  }

  supersedeTicket(id: string, input: SupersedeInput): Promise<TrackerItem> {
    return this.supersede(id, "ticket", input);
  }

  /**
   * Linear has no "close" flag, so closing means moving the issue into its
   * own team's completed workflow state. That state is resolved from the
   * team the issue actually lives in — never a hard-coded id, and never a
   * guess when the team reports more than one completed state.
   */
  private async close(node: LinearIssueNode): Promise<LinearIssueNode> {
    const stateId = await this.resolveCompletedStateId(node);
    const data = await this.execute(ISSUE_UPDATE_MUTATION, { id: node.identifier, input: { stateId } }, "mutation");
    return readUpdatedIssue(data);
  }

  private async resolveCompletedStateId(node: LinearIssueNode): Promise<string> {
    const data = await this.execute(TEAM_STATES_QUERY, { id: node.team.id }, "read");
    const team = data.team;
    invariant(isRecord(team), "LINEAR_GRAPHQL_ERROR", "Linear returned no team for the issue", {});
    const states = team.states;
    invariant(isRecord(states) && Array.isArray(states.nodes), "LINEAR_GRAPHQL_ERROR", "Linear returned no team states", {});
    const completed = (states.nodes as readonly unknown[])
      .map((state) => {
        invariant(isRecord(state), "LINEAR_GRAPHQL_ERROR", "Linear returned a malformed workflow state", {});
        return { id: requireString(state.id, "id", "PoiesisTeamStates"), type: requireString(state.type, "type", "PoiesisTeamStates") };
      })
      .filter((state) => state.type === "completed");
    if (completed.length === 0) {
      throw new PoiesisError(
        "LINEAR_COMPLETED_STATE_NOT_FOUND",
        `Linear team ${node.team.id} reports no completed workflow state, so Poiesis cannot close the issue without inventing one`,
        { teamId: node.team.id },
      );
    }
    if (completed.length > 1) {
      throw new PoiesisError(
        "LINEAR_COMPLETED_STATE_AMBIGUOUS",
        `Linear team ${node.team.id} reports ${completed.length} completed workflow states; Poiesis will not guess which one means closed`,
        { teamId: node.team.id, states: completed.map((state) => state.id) },
      );
    }
    return (completed[0] as { id: string }).id;
  }

  /**
   * Supersession uses the SAME semantics every other Poiesis provider uses:
   * a comment stating the reason, the reason and replacements recorded in the
   * Poiesis metadata, and a close. Poiesis never writes a native Linear
   * issue relation to express supersession, because that would assert a
   * relationship between two issues that the Author never declared.
   */
  private async supersede(id: string, kind: TrackerItemKind, input: SupersedeInput): Promise<TrackerItem> {
    const reason = requiredText(input.reason, "supersede reason");
    const replacementIds = [...(input.replacementIds ?? [])];
    const node = await this.readIssue(requiredText(id, "id"));
    const current = assertKind(this.toItem(node), kind);
    await this.comment(
      node,
      kind,
      `Superseded: ${reason}${replacementIds.length === 0 ? "" : `\n\nReplaced by: ${replacementIds.join(", ")}`}`,
    );
    const metadata: TrackerMetadata = {
      ...metadataFromItem(current),
      supersededReason: reason,
      supersededBy: replacementIds,
    };
    await this.writeIssue(node, current.title, decorateBody(current.body, metadata));
    return this.toItem(await this.close(node));
  }

  private async writeIssue(node: LinearIssueNode, title: string, description: string): Promise<LinearIssueNode> {
    const data = await this.execute(
      ISSUE_UPDATE_MUTATION,
      { id: node.identifier, input: { title, description } },
      "mutation",
    );
    return readUpdatedIssue(data);
  }

  async commentSpec(id: string, body: string): Promise<TrackerComment> {
    return this.comment(await this.readIssue(requiredText(id, "id")), "spec", body);
  }

  async commentTicket(id: string, body: string): Promise<TrackerComment> {
    return this.comment(await this.readIssue(requiredText(id, "id")), "ticket", body);
  }

  /**
   * A Poiesis comment is an ordinary Linear comment on the issue. It is
   * created exactly once: if the outcome is unknown, the ambiguity is
   * reported rather than replayed, because Linear has no idempotency key for
   * a comment and a duplicate supersede notice is indistinguishable from the
   * original.
   */
  private async comment(node: LinearIssueNode, kind: TrackerItemKind, body: string): Promise<TrackerComment> {
    assertKind(this.toItem(node), kind);
    const text = requiredText(body, "comment body");
    const data = await this.execute(
      COMMENT_CREATE_MUTATION,
      { input: { issueId: node.id, body: text } },
      "mutation",
    );
    const payload = data.commentCreate;
    invariant(isRecord(payload), "LINEAR_GRAPHQL_ERROR", "Linear returned no commentCreate payload", {});
    invariant(payload.success === true, "LINEAR_MUTATION_REJECTED", "Linear refused the commentCreate mutation", {});
    const comment = payload.comment;
    invariant(isRecord(comment), "LINEAR_GRAPHQL_ERROR", "Linear commentCreate returned no comment", {});
    return {
      id: requireString(comment.id, "id", "PoiesisCommentCreate"),
      itemId: node.identifier,
      body: text,
      ...(typeof comment.url === "string" ? { url: comment.url } : {}),
    };
  }

  /**
   * The idempotency probe for a create: if a previous attempt already
   * created the issue under this UUID, return it instead of creating again.
   *
   * The budget is the CREATE's, handed down by the executor: the probe is part
   * of that create, so it may not start its own operation, may not outlive the
   * deadline the create already has, and may not retry — the milliseconds left
   * are not enough for a second attempt and one question deserves one answer.
   */
  private async probeCreatedIssue(
    uuid: string,
    budget: LinearProbeBudget,
  ): Promise<Record<string, unknown> | null> {
    const node = await this.readIssueDirect(uuid, budget);
    if (node === null) return null;
    return { issueCreate: { success: true, issue: node } };
  }

  private async createIssue(
    title: string,
    description: string,
    parentUuid?: string,
  ): Promise<LinearIssueNode> {
    const teamId = await this.resolveTeamId();
    const projectId = await this.resolveProjectId();
    // ONE UUID per logical create, reused by every attempt.
    const uuid = this.#seams.uuid();
    const data = await this.execute(ISSUE_CREATE_MUTATION, {
      input: {
        // One client-chosen UUID per logical create. It is the idempotency
        // anchor: a retried create reuses it, so Linear can never receive two
        // different identities for the same Poiesis item.
        id: uuid,
        teamId,
        ...(parentUuid === undefined ? {} : { parentId: parentUuid }),
        ...(projectId === undefined ? {} : { projectId }),
        title,
        description,
      },
    }, "idempotent", (_attempt, budget) => this.probeCreatedIssue(uuid, budget));
    return readCreatedIssue(data, "issueCreate");
  }

  /**
   * Spec #139 / ticket #158 — an UPDATE enforces the same nonblank dependency
   * invariant a CREATE already enforces.
   *
   * `createTicket` refuses blank dependency text because the value is Author
   * evidence about ordering. Accepting one here would let a single update write
   * the exact value the create path refuses, and it would do so AFTER a read
   * round trip — so a rejected call still cost a request and still confirmed the
   * issue exists. The check therefore runs before `readIssue`, on the caller's
   * input, and never depends on what Linear happens to hold.
   *
   * The same reasoning fixes the ABSENT case: the previous `?? ""` substituted
   * an empty claim for a value the ticket never made, so a title-only update
   * wrote a `Dependencies:` section asserting no dependencies. Omitted now
   * means absent stays absent, and a supplied value is carried byte-for-byte.
   */
  private async updateIssue(
    id: string,
    kind: TrackerItemKind,
    input: UpdateTrackerItemInput,
  ): Promise<LinearIssueNode> {
    const dependencyText = kind === "ticket" ? (input as UpdateTicketInput).dependencyText : undefined;
    if (dependencyText !== undefined) requiredText(dependencyText, "dependencyText");
    const node = await this.readIssue(id);
    const current = assertKind(this.toItem(node), kind);
    const metadata = metadataFromItem(current);
    if (dependencyText !== undefined) metadata.dependencyText = dependencyText;
    return this.writeIssue(
      node,
      input.title === undefined ? current.title : requiredText(input.title, "title"),
      decorateBody(input.body ?? current.body, metadata),
    );
  }

  /**
   * Resolve a Poiesis id to a Linear issue.
   *
   * The direct `issue(id:)` lookup is tried first. When Linear does not
   * resolve it, the configured team is scanned page by page for an issue
   * whose HUMAN identifier or UUID matches. That fallback is what makes
   * `ENG-123` — the identifier Poiesis hands back and the CLI accepts — a
   * usable handle, instead of a citation that only resolves when Linear
   * happens to accept it directly. The scan is bounded by the same page cap
   * as every other connection walk.
   */
  private async readIssue(id: string): Promise<LinearIssueNode> {
    const wanted = id.trim().toLowerCase();
    const direct = await this.readIssueDirect(id);
    if (direct !== null) return direct;
    const matches: LinearIssueNode[] = [];
    const teamId = await this.resolveTeamId();
    for await (const nodes of this.paginate(TEAM_ISSUES_QUERY, "issues", { teamId })) {
      for (const node of nodes) {
        const issue = readIssueNode(node, "PoiesisTeamIssues");
        if (issue.identifier.toLowerCase() === wanted || issue.id.toLowerCase() === wanted) matches.push(issue);
      }
    }
    if (matches.length > 1) {
      throw new PoiesisError(
        "LINEAR_ITEM_AMBIGUOUS",
        `The identifier ${id} matches ${matches.length} Linear issues; Poiesis will not guess which one is meant`,
        { id, matches: matches.map((match) => match.identifier) },
      );
    }
    const found = matches[0];
    if (found === undefined) {
      throw new PoiesisError("LINEAR_ITEM_NOT_FOUND", `Linear issue ${id} was not found`, { id, teamId });
    }
    return found;
  }

  private execute(
    document: string,
    variables: Record<string, unknown>,
    mode: LinearCallMode,
    beforeRetry?: (attempt: number, budget: LinearProbeBudget) => Promise<Record<string, unknown> | null>,
    enclosing?: LinearProbeBudget,
  ): Promise<Record<string, unknown>> {
    return executeWith(this.#seams, document, variables, mode, beforeRetry, enclosing);
  }

  private redact(value: string): string {
    return redact(this.#seams, value);
  }

  /** One direct `issue(id:)` lookup, with no identifier scan behind it. */
  private async readIssueDirect(id: string, budget?: LinearProbeBudget): Promise<LinearIssueNode | null> {
    const data = await this.execute(ISSUE_QUERY, { id }, "read", undefined, budget);
    return isRecord(data.issue) ? readIssueNode(data.issue, "PoiesisIssue") : null;
  }

  /**
   * Map a Linear issue onto the Poiesis shape. The id is Linear's HUMAN
   * identifier (`ENG-123`) and the url is Linear's own, so every surface
   * that cites a Poiesis item cites something an Author can open. Linear
   * has no "open"/"closed" axis, so its workflow state type is mapped:
   * `completed` and `canceled` are terminal, every other type is open.
   */
  private toItem(node: LinearIssueNode): TrackerItem {
    const terminal = node.state.type === "completed" || node.state.type === "canceled";
    return trackerItem({
      id: node.identifier,
      title: node.title,
      body: node.description,
      state: terminal ? "closed" : "open",
      url: node.url,
    });
  }

  /**
   * Resolve the configured team. One paginated scan matches the configured
   * coordinate against a team's key OR its display name, because both are
   * how a Linear team is legitimately named in a config. More than one match
   * is refused: picking the first would silently file a Spec under an
   * arbitrary team.
   */
  private async resolveTeamId(): Promise<string> {
    return (await resolveLinearTeam(this.executeLinear.bind(this), this.team)).id;
  }

  private async resolveProjectId(): Promise<string | undefined> {
    if (this.linearProject === undefined) return undefined;
    return (await resolveLinearProject(this.executeLinear.bind(this), this.linearProject)).id;
  }

  private executeLinear(
    document: string,
    variables: Record<string, unknown>,
    mode: LinearCallMode,
  ): Promise<Record<string, unknown>> {
    return this.execute(document, variables, mode);
  }

  /**
   * Walk a Relay connection page by page, following `endCursor` until
   * Linear says there is no next page. The page count is bounded, so a
   * connection that never terminates fails closed instead of looping.
   */
  private async *paginate(
    document: string,
    connection: string,
    extraVariables: Record<string, unknown>,
  ): AsyncGenerator<readonly unknown[]> {
    yield* paginateLinearConnection(this.executeLinear.bind(this), document, connection, extraVariables);
  }
}

/**
 * The narrow executor seam shared by the adapter and the verification probe.
 * Both need the SAME bounded, redacted, retried call path, and both must
 * resolve a team or a project through the SAME matching rules — otherwise a
 * configuration that verification accepts is not the configuration the
 * adapter will actually file work in.
 */
type LinearExecute = (
  document: string,
  variables: Record<string, unknown>,
  mode: LinearCallMode,
) => Promise<Record<string, unknown>>;

/**
 * Walk a Relay connection page by page, following `endCursor` until Linear
 * says there is no next page. The page count is bounded, so a connection
 * that never terminates fails closed instead of looping.
 */
async function* paginateLinearConnection(
  execute: LinearExecute,
  document: string,
  connection: string,
  extraVariables: Record<string, unknown>,
): AsyncGenerator<readonly unknown[]> {
  let after: string | null = null;
  for (let page = 0; page < LINEAR_MAX_PAGES; page += 1) {
    const data = await execute(document, { first: LINEAR_PAGE_SIZE, after, ...extraVariables }, "read");
    const value = data[connection];
    invariant(isRecord(value), "LINEAR_GRAPHQL_ERROR", `Linear returned no ${connection} connection`, { connection });
    const pageInfo = value.pageInfo;
    invariant(isRecord(pageInfo), "LINEAR_GRAPHQL_ERROR", `Linear returned no ${connection} pageInfo`, { connection });
    const nodes = value.nodes;
    invariant(Array.isArray(nodes), "LINEAR_GRAPHQL_ERROR", `Linear returned no ${connection} nodes`, { connection });
    yield nodes;
    if (pageInfo.hasNextPage !== true) return;
    after = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
  }
  throw new PoiesisError(
    "LINEAR_PAGINATION_BOUND_REACHED",
    `Linear ${connection} still had more pages after ${LINEAR_MAX_PAGES} pages; Poiesis will not keep scanning`,
    { connection, maxPages: LINEAR_MAX_PAGES },
  );
}

/**
 * Resolve a configured team coordinate to exactly one Linear team. The
 * coordinate may be a team key or a team display name. Zero matches and more
 * than one match are both refusals: an ambiguous team would file every Spec
 * under an arbitrary queue, and a missing one is a configuration error that
 * must surface where the operator is looking.
 */
async function resolveLinearTeam(execute: LinearExecute, team: string): Promise<LinearTeamNode> {
  const wanted = team.toLowerCase();
  const matches: LinearTeamNode[] = [];
  for await (const nodes of paginateLinearConnection(execute, TEAM_QUERY, "teams", {})) {
    for (const node of nodes) {
      const candidate = readTeamNode(node, "PoiesisTeams");
      if (candidate.key.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted) matches.push(candidate);
    }
  }
  if (matches.length === 0) {
    throw new PoiesisError(
      "LINEAR_TEAM_NOT_FOUND",
      `No Linear team matches the configured tracker.team; check the team key or name`,
      { team },
    );
  }
  if (matches.length > 1) {
    throw new PoiesisError(
      "LINEAR_TEAM_AMBIGUOUS",
      `The configured tracker.team matches ${matches.length} Linear teams; Poiesis will not guess which team owns this work`,
      { team, matches: matches.map((match) => `${match.key} (${match.id})`) },
    );
  }
  return matches[0] as LinearTeamNode;
}

/** Resolve a configured Linear project name to exactly one project. */
async function resolveLinearProject(execute: LinearExecute, project: string): Promise<LinearProjectNode> {
  const matches: LinearProjectNode[] = [];
  for await (const nodes of paginateLinearConnection(execute, PROJECT_QUERY, "projects", { name: project })) {
    for (const node of nodes) matches.push(readProjectNode(node, "PoiesisProjects"));
  }
  if (matches.length === 0) {
    throw new PoiesisError(
      "LINEAR_PROJECT_NOT_FOUND",
      `No Linear project matches the configured tracker.project`,
      { project },
    );
  }
  if (matches.length > 1) {
    throw new PoiesisError(
      "LINEAR_PROJECT_AMBIGUOUS",
      `The configured tracker.project matches ${matches.length} Linear projects; Poiesis will not guess which project owns this work`,
      { project, matches: matches.map((match) => match.id) },
    );
  }
  return matches[0] as LinearProjectNode;
}

/**
 * Bounded pagination. `LINEAR_MAX_PAGES` caps every connection walk, so a
 * team / project / issue lookup has a fixed request ceiling no matter what
 * the workspace contains.
 */
export const LINEAR_PAGE_SIZE = 50;
export const LINEAR_MAX_PAGES = 20;

/**
 * Ticket #141 — the retry bound. Every number here is a ceiling, not a
 * starting point: Poiesis waits as little as Linear asks for, never longer
 * than a single delay allows, and never for a cumulative wait that would
 * outlive the budget. A rate-limited workspace therefore costs a bounded
 * amount of time instead of an unbounded stall.
 */
export const LINEAR_MAX_ATTEMPTS = 3;
export const LINEAR_MAX_RETRY_DELAY_MS = 10_000;
export const LINEAR_MAX_RETRY_WAIT_MS = 15_000;
export const LINEAR_DEFAULT_RETRY_DELAY_MS = 500;

/**
 * Ticket #150 — the two deadlines that make every Linear call finite.
 *
 * `LINEAR_ATTEMPT_TIMEOUT_MS` bounds ONE HTTP attempt. It exists because the
 * numbers above bound attempts and waits, not a request: a transport that
 * accepts a request and never answers it leaves the promise pending forever,
 * so `poiesis init`, `poiesis doctor`, and every tracker mutation could hang
 * with no error and no bound at all. The attempt is ended by aborting its own
 * signal, which stops the socket rather than abandoning a socket that is still
 * open.
 *
 * `LINEAR_OPERATION_DEADLINE_MS` bounds the operation as a WHOLE — every
 * attempt, every wait, and the idempotency probe. It is the outer guarantee,
 * and it is deliberately larger than the inner bounds can reach
 * (3 attempts x 10s plus at most 15s of cumulative wait), so it never changes
 * which refusal an ordinary rate limit or outage produces. What it closes is
 * the case the inner bounds cannot see: a machine that spends the whole budget
 * on a single stuck attempt. No attempt and no probe is ever started without
 * budget left for it, so a Linear operation is finite in every case.
 */
export const LINEAR_ATTEMPT_TIMEOUT_MS = 10_000;
export const LINEAR_OPERATION_DEADLINE_MS = 45_000;

/**
 * Ticket #167 — the three response bounds.
 *
 * They are ceilings, and none of them is a setting: each exists because
 * Poiesis reads, holds, and quotes bytes that some other party chose the
 * length of, and a bound a caller can raise is not a bound.
 *
 *   - `LINEAR_MAX_RESPONSE_BYTES` bounds the CAPTURE, in bytes read off the
 *     wire. It is the outer one: the two below both apply to text derived
 *     from a capture this one already bounded, so nothing reaches them
 *     without having passed it.
 *   - `LINEAR_MAX_DIAGNOSTIC_BYTES` bounds ONE echoed diagnostic — a body, an
 *     exception message, a GraphQL `message` or `code`. It is the number that
 *     actually reaches a receipt, a CI annotation, or a pasted issue.
 *   - `LINEAR_MAX_GRAPHQL_ERRORS` bounds the COUNT of entries, because a list
 *     of short messages can be longer than a list of long ones and the bound
 *     has to be on both axes.
 */
export const LINEAR_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const LINEAR_MAX_DIAGNOSTIC_BYTES = 8 * 1024;
export const LINEAR_MAX_GRAPHQL_ERRORS = 20;

const ISSUE_FIELDS = "id identifier title description url state { type } team { id }";

const ISSUE_QUERY = `query PoiesisIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;

const TEAM_QUERY = `query PoiesisTeams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { id key name }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PROJECT_QUERY = `query PoiesisProjects($first: Int!, $after: String, $name: String!) {
  projects(first: $first, after: $after, filter: { name: { eq: $name } }) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}`;

const TEAM_ISSUES_QUERY = `query PoiesisTeamIssues($first: Int!, $after: String, $teamId: String!) {
  issues(first: $first, after: $after, filter: { team: { id: { eq: $teamId } } }) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_CREATE_MUTATION = `mutation PoiesisIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

const TEAM_STATES_QUERY = `query PoiesisTeamStates($id: String!) {
  team(id: $id) { states { nodes { id type } } }
}`;

const COMMENT_CREATE_MUTATION = `mutation PoiesisCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;

const ISSUE_UPDATE_MUTATION = `mutation PoiesisIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

interface LinearIssueNode {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly state: { readonly type: string };
  readonly team: { readonly id: string };
}

interface LinearTeamNode {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

interface LinearProjectNode {
  readonly id: string;
  readonly name: string;
}

function requireString(value: unknown, field: string, operation: string): string {
  invariant(typeof value === "string", "LINEAR_GRAPHQL_ERROR", `Linear ${operation} returned an issue with no ${field}`, {
    operation,
    field,
  });
  return value;
}

function readIssueNode(value: unknown, operation: string): LinearIssueNode {
  invariant(isRecord(value), "LINEAR_GRAPHQL_ERROR", `Linear ${operation} returned a malformed issue`, { operation });
  const state = value.state;
  invariant(isRecord(state), "LINEAR_GRAPHQL_ERROR", `Linear ${operation} returned an issue with no state`, { operation });
  return {
    id: requireString(value.id, "id", operation),
    identifier: requireString(value.identifier, "identifier", operation),
    title: requireString(value.title, "title", operation),
    description: typeof value.description === "string" ? value.description : "",
    url: requireString(value.url, "url", operation),
    state: { type: requireString(state.type, "state type", operation) },
    team: readTeamRef(value.team, operation),
  };
}

/** A Linear issue always belongs to exactly one team. */
function readTeamRef(value: unknown, operation: string): { readonly id: string } {
  invariant(isRecord(value), "LINEAR_GRAPHQL_ERROR", `Linear ${operation} returned an issue with no team`, { operation });
  return { id: requireString(value.id, "id", operation) };
}

function readTeamNode(value: unknown, operation: string): LinearTeamNode {
  invariant(isRecord(value), "LINEAR_GRAPHQL_ERROR", `Linear ${operation} returned a malformed team`, { operation });
  return {
    id: requireString(value.id, "id", operation),
    key: requireString(value.key, "key", operation),
    name: requireString(value.name, "name", operation),
  };
}

function readProjectNode(value: unknown, operation: string): LinearProjectNode {
  invariant(isRecord(value), "LINEAR_GRAPHQL_ERROR", `Linear ${operation} returned a malformed project`, { operation });
  return {
    id: requireString(value.id, "id", operation),
    name: requireString(value.name, "name", operation),
  };
}

/** Linear reports `success: false` with no issue when a mutation is refused. */
function readCreatedIssue(data: Record<string, unknown>, field: string): LinearIssueNode {
  const payload = data[field];
  invariant(isRecord(payload), "LINEAR_GRAPHQL_ERROR", `Linear returned no ${field} payload`, { field });
  invariant(payload.success === true, "LINEAR_MUTATION_REJECTED", `Linear refused the ${field} mutation`, { field });
  invariant(isRecord(payload.issue), "LINEAR_GRAPHQL_ERROR", `Linear ${field} returned no issue`, { field });
  return readIssueNode(payload.issue, field);
}

function readUpdatedIssue(data: Record<string, unknown>): LinearIssueNode {
  return readCreatedIssue(data, "issueUpdate");
}

function requiredCoordinate(value: string, name: string): string {
  invariant(value.trim().length > 0, "INVALID_TRACKER_CONFIG", `${name} must not be empty`, { field: name });
  return value.trim();
}

/**
 * Ticket #141 — the tracker verification probe. `poiesis init` and
 * `poiesis doctor` call this to prove the configured credential really
 * authenticates against Linear, instead of reporting a usable tracker that
 * was never contacted. It runs one read, under the same credential rules and
 * the same retry bound as every other Linear call.
 */
export async function verifyLinearTrackerAuthorized(seams: LinearTrackerSeams = {}): Promise<"verified"> {
  await executeWith(resolveSeams(seams), VIEWER_QUERY, {}, "read");
  return "verified";
}

/**
 * Spec #139 / ticket #144 — the coordinates Linear verification actually has
 * to prove. The returned identities are the resolved ones, so a health report
 * can name what the workspace really resolves to rather than echoing the
 * configuration back at the operator.
 */
export interface LinearTrackerVerification {
  readonly team: { readonly id: string; readonly key: string; readonly name: string };
  readonly project?: { readonly id: string; readonly name: string };
}

/**
 * Ticket #144 — prove the CONFIGURED Linear coordinates, not merely that some
 * credential authenticates.
 *
 * A viewer-only probe reports a mistyped `tracker.team` or
 * `tracker.project` as a healthy tracker, so the misconfiguration surfaces
 * much later as an unexplained failure at the first tracker mutation, in a
 * different command, with a different message. This probe resolves the team
 * (and the project when one is configured) through exactly the same
 * pagination, ambiguity refusal, and typed error codes the adapter uses, so
 * `poiesis doctor` fails closed next to the cause.
 *
 * The credential rules are unchanged and still environment-only: a missing or
 * doubled credential fails here, before any request is made, and no secret
 * reaches a request detail, a message, or `details`.
 */
export async function verifyLinearTrackerConfigured(
  config: LinearTrackerConfig,
  seams: LinearTrackerSeams = {},
): Promise<LinearTrackerVerification> {
  const resolved = resolveSeams(seams);
  const execute: LinearExecute = (document, variables, mode) => executeWith(resolved, document, variables, mode);
  // Prove the credential itself before spending requests on coordinates: a
  // refused credential is a different problem from a mistyped team, and the
  // operator needs the credential one first.
  await execute(VIEWER_QUERY, {}, "read");
  const team = await resolveLinearTeam(execute, requiredCoordinate(config.team, "tracker team"));
  if (config.project === undefined) return { team };
  const project = await resolveLinearProject(execute, requiredCoordinate(config.project, "tracker project"));
  return { team, project };
}

const VIEWER_QUERY = `query PoiesisViewer {
  viewer { id }
}`;

/**
 * Ticket #141 — build a real Linear tracker adapter. The credential is
 * resolved eagerly so a missing or doubled credential fails closed at
 * construction, next to its cause, instead of at the first remote call.
 */
export function createLinearTrackerAdapter(
  config: LinearTrackerConfig,
  seams: LinearTrackerSeams = {},
): TrackerAdapter {
  return new LinearTracker(config, seams);
}

/**
 * Spec #139 / ticket #167 — the BOUNDED Linear response, and the bounded
 * diagnostic every Linear error is built from.
 *
 * Before this ticket the production transport ended with
 * `await response.text()`: whatever Linear sent became a resident string,
 * and the only bound in the adapter was the 8 KiB-ish diagnostic it built
 * afterwards. So an answer of any size was fully read and held before a
 * single byte was judged, and the redaction boundary (the URL userinfo rule)
 * was applied to a document Poiesis had already paid for in full.
 *
 * Four boundaries are under test, and every test names the break it catches:
 *
 *   1. CAPTURE — the ceiling is enforced on the WIRE. The body is read
 *      chunk by chunk, the first byte past the cap CANCELS the transfer, and
 *      the text kept is a complete valid UTF-8 PREFIX of the bytes received
 *      (never a replacement character, never a partial code point). A
 *      `Content-Length` that lies, or is absent, changes nothing: the cap is
 *      a fact about bytes Poiesis read, never a claim about bytes Linear
 *      promised.
 *   2. CLASSIFICATION — a 2xx whose capture was truncated is
 *      `LINEAR_RESPONSE_TOO_LARGE` and is never parsed and never retried; a
 *      COMPLETE answer that is not JSON is the pre-existing failure it always
 *      was. A mutation whose answer was truncated is
 *      `LINEAR_MUTATION_UNCERTAIN` with `reason: response-too-large`, and is
 *      never replayed.
 *   3. THE DIAGNOSTIC PIPELINE — every echoed byte (a transport exception
 *      message, an HTTP body, a GraphQL `message` / `code`) goes through ONE
 *      pipeline: bounded capture, then the existing URL-userinfo rule told
 *      the TRUTH about truncation, then exact credential replacement, then a
 *      final 8 KiB bound on a complete code point. Serializing a raised
 *      Linear error must not contain the credential and must not contain a
 *      URL's userinfo — while still naming the host, because a diagnostic
 *      that deletes the whole answer diagnoses nothing.
 *   4. BOUNDS ON BOUNDS — at most 20 GraphQL errors, each `message` and
 *      `code` bounded to 8 KiB, and the omission reported as metadata rather
 *      than performed silently. A SUCCESSFUL `data` payload is returned
 *      byte-for-byte: it is the Author's own content coming back, not an
 *      upstream diagnostic, and rewriting it would corrupt the item Poiesis
 *      just read.
 */
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoiesisError } from "../src/errors.js";
import {
  captureLinearResponseBody,
  createLinearTrackerAdapter,
  type LinearBodyCapture,
  type LinearHttpRequest,
  type LinearHttpResponse,
  type LinearResponseBodyStream,
  type LinearTransport,
} from "../src/linear-tracker.js";

/** The wire capture ceiling, hand-derived rather than read from the module. */
const EIGHT_MIB = 8 * 1024 * 1024;
/** The final bound on ONE echoed diagnostic, hand-derived. */
const EIGHT_KIB = 8 * 1024;

const CREDENTIAL = "lin_api_secret";
const ENV = { LINEAR_API_KEY: CREDENTIAL } as const;

// -- Wire fixtures ---------------------------------------------------------

/** A complete capture: every byte the text carries was received. */
function completeBody(text: string): LinearBodyCapture {
  return { text, capturedBytes: Buffer.byteLength(text, "utf8"), truncated: false };
}

/**
 * A capture the ceiling cut. `capturedBytes` is what the text really holds —
 * the cap, not the advertised length — because the ceiling is a fact about
 * bytes Poiesis read.
 */
function cutBody(prefix: string, capturedBytes = EIGHT_MIB): LinearBodyCapture {
  return { text: prefix, capturedBytes, truncated: true };
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/** The same bytes delivered in `size`-byte deliveries. */
function deliveries(data: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    parts.push(data.subarray(offset, Math.min(data.length, offset + size)));
  }
  return parts;
}

interface StreamObservation {
  reads: number;
  cancels: number;
}

/**
 * A response body the test owns, so the capture's OWN behavior is what is
 * observed: how many reads it performed, whether it cancelled the transfer
 * once the cap was reached, and whether it kept reading after cancelling.
 * A read after a cancel throws, because a cancelled transfer that is still
 * being drained is exactly the unbounded work the cap exists to stop.
 */
function fakeBody(parts: readonly Uint8Array[], observed: StreamObservation): LinearResponseBodyStream {
  let index = 0;
  return {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value?: Uint8Array | undefined }> => {
        if (observed.cancels > 0) throw new Error("the capture kept reading a cancelled transfer");
        observed.reads += 1;
        if (index >= parts.length) return { done: true };
        const part = parts[index];
        index += 1;
        return { done: false, value: part };
      },
      cancel: async (): Promise<void> => {
        observed.cancels += 1;
      },
    }),
  };
}

function observed(): StreamObservation {
  return { reads: 0, cancels: 0 };
}

interface ProductionBody {
  readonly response: Response;
  readonly state: StreamObservation;
}

/**
 * A REAL `Response` over a REAL `ReadableStream`, so the production transport
 * is exercised through the same object the platform hands it — including the
 * `Content-Length` header, which is set here to whatever this test needs it
 * to say, including a lie.
 *
 * `endless` models the peer this ceiling actually defends against: one that
 * keeps delivering and would not stop. It matters for what the test can
 * PROVE. With a finite source, a source `pull` that runs one step ahead can
 * close the stream, and cancelling a closed stream is a silent no-op — so the
 * cancel would be unobservable and a capture that drained forever would look
 * the same. With an endless source nothing but the capture's own cancel can
 * end the transfer, so a capture that failed to cancel would hang here rather
 * than pass.
 */
function productionResponse(
  parts: readonly Uint8Array[],
  state: StreamObservation,
  init: { status?: number; headers?: Record<string, string>; endless?: boolean } = {},
): ProductionBody {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= parts.length) {
        if (init.endless === true && parts.length > 0) {
          index = 0;
        } else {
          controller.close();
          return;
        }
      }
      const part = parts[index];
      index += 1;
      if (part !== undefined) controller.enqueue(part);
    },
    cancel() {
      state.cancels += 1;
    },
  });
  return {
    state,
    response: new Response(stream, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...init.headers },
    }),
  };
}

/** A scripted transport: one reply per attempt, in call order. */
function scriptedTransport(replies: readonly (LinearHttpResponse | Error)[]): {
  readonly transport: LinearTransport;
  readonly requests: LinearHttpRequest[];
} {
  const requests: LinearHttpRequest[] = [];
  let cursor = 0;
  const transport: LinearTransport = async (request) => {
    requests.push(request);
    const reply = replies[cursor];
    cursor += 1;
    if (reply === undefined) throw new Error(`unscripted Linear request #${cursor}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { transport, requests };
}

function httpReply(status: number, body: LinearBodyCapture, headers: Record<string, string> = {}): LinearHttpResponse {
  return { status, headers, body };
}

const ISSUE_NODE = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-1",
  title: "Canonical intent",
  description: specDescription("Canonical decisions"),
  url: "https://linear.app/acme/issue/ENG-1",
  state: { type: "unstarted" },
  team: { id: "team-uuid-eng" },
};

/**
 * A Linear description in the persisted Poiesis format: the metadata envelope,
 * then the relationship prose, then the Author's body. Hand-written rather
 * than built with the adapter's own helper, so a change to that helper cannot
 * make these tests pass by agreeing with themselves.
 */
function specDescription(authorBody: string): string {
  return [
    "<!-- poiesis:tracker",
    '{"kind":"spec"}',
    "poiesis:tracker -->",
    "",
    "**Poiesis Spec**",
    "",
    "---",
    "",
    authorBody,
  ].join("\n");
}

/** The same envelope for a Poiesis Ticket, which a comment call requires. */
function ticketDescription(parentSpecId: string, dependencyText: string, authorBody: string): string {
  return [
    "<!-- poiesis:tracker",
    JSON.stringify({ kind: "ticket", parentSpecId, dependencyText }),
    "poiesis:tracker -->",
    "",
    "**Poiesis Ticket**",
    "",
    `Parent Spec: ${parentSpecId}`,
    "",
    "Dependencies:",
    dependencyText,
    "",
    "---",
    "",
    authorBody,
  ].join("\n");
}

const TICKET_NODE = {
  ...ISSUE_NODE,
  identifier: "ENG-2",
  description: ticketDescription("ENG-1", "none", "Ticket body"),
};

const TEAM_PAGE = {
  teams: { nodes: [{ id: "team-uuid-eng", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: false, endCursor: null } },
};

/** A Linear error, serialized exactly as a receipt or a crash dump would. */
function serialize(error: unknown): string {
  const value = error as PoiesisError;
  return JSON.stringify({ code: value.code, message: value.message, details: value.details });
}

// ===========================================================================
// 1. The capture: the ceiling is enforced on the wire.
// ===========================================================================

describe("a Linear response body is captured under a fixed byte ceiling", () => {
  it("reassembles a body delivered one byte at a time, including split code points", async () => {
    // Break: decoding each delivery separately — or stopping at the first
    // one — loses every multibyte character a delivery happened to cut in
    // half. A one-byte delivery size makes that unavoidable: the payload
    // below is UTF-8 with a 2-, a 3-, and a 4-byte code point, so a
    // capture that is not byte-continuous produces replacement characters.
    const payload = '{"data":{"title":"αβγ — ✓ 🜁"}}';
    const state = observed();

    const captured = await captureLinearResponseBody(fakeBody(deliveries(bytes(payload), 1), state));

    expect(captured.text).toBe(payload);
    expect(captured.capturedBytes).toBe(Buffer.byteLength(payload, "utf8"));
    expect(captured.truncated).toBe(false);
  });

  it("keeps a body that is exactly the ceiling and does not call it truncated", async () => {
    // Break: `>=` where `>` belongs reports an EXACT fit as truncated, which
    // would refuse to parse a legal answer — the false positive that trains
    // an operator to ignore the code.
    const exact = "a".repeat(EIGHT_MIB);
    const state = observed();

    const captured = await captureLinearResponseBody(fakeBody(deliveries(bytes(exact), 64 * 1024), state));

    expect(captured.capturedBytes).toBe(EIGHT_MIB);
    expect(captured.text.length).toBe(EIGHT_MIB);
    expect(captured.truncated).toBe(false);
    expect(state.cancels).toBe(0);
  });

  it("drops the byte past the ceiling and cancels the transfer instead of draining it", async () => {
    // Break: reading to `done` and THEN bounding the string makes the bound
    // cosmetic — the whole oversized body was already read and held, which
    // is the memory cost the ceiling exists to refuse. The cancel is the
    // observable difference: an implementation that keeps draining shows up
    // here as reads after the cancel.
    const oversize = "a".repeat(EIGHT_MIB + 1);
    const state = observed();

    const captured = await captureLinearResponseBody(fakeBody(deliveries(bytes(oversize), 64 * 1024), state));

    expect(captured.capturedBytes).toBe(EIGHT_MIB);
    expect(captured.truncated).toBe(true);
    expect(captured.text.length).toBe(EIGHT_MIB);
    expect(captured.text.endsWith("a")).toBe(true);
    expect(state.cancels).toBe(1);
  });

  it("keeps only the complete code point when the ceiling cuts a multibyte character", async () => {
    // Break: decoding the retained bytes as-is yields U+FFFD for the half of
    // the character the ceiling cut. A replacement character is not evidence
    // from Linear, and a diagnostic carrying one is a corrupted diagnostic.
    // 8 MiB - 1 ASCII bytes, then a 3-byte euro sign: two of its bytes fall
    // under the ceiling and must still be dropped.
    const payload = `${"a".repeat(EIGHT_MIB - 1)}€`;
    const state = observed();

    const captured = await captureLinearResponseBody(fakeBody([bytes(payload)], state));

    expect(captured.capturedBytes).toBe(EIGHT_MIB - 1);
    expect(captured.truncated).toBe(true);
    expect(captured.text).toBe("a".repeat(EIGHT_MIB - 1));
    expect(captured.text.includes("�")).toBe(false);
  });

  it("keeps only the complete code point when a COMPLETE body ends mid-character", async () => {
    // Break: a lead byte with no continuation is not text. Handing it to the
    // decoder produces a replacement character and, worse, makes a complete
    // download look like a complete answer.
    const state = observed();

    const captured = await captureLinearResponseBody(fakeBody([new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe2])], state));

    expect(captured.text).toBe('{"a":"');
    expect(captured.capturedBytes).toBe(6);
    expect(captured.truncated).toBe(true);
  });

  it("stops at the first invalid byte rather than carrying the invalid tail", async () => {
    // Break: skipping over a bad byte and keeping the rest makes the text a
    // PREFIX of nothing — the middle is missing and the tail implies a
    // document that never existed. The capture is a prefix, so it ends where
    // the first invalid byte begins.
    const state = observed();

    const captured = await captureLinearResponseBody(fakeBody([new Uint8Array([0x6f, 0x6b, 0xff, 0x74, 0x61, 0x69, 0x6c])], state));

    expect(captured.text).toBe("ok");
    expect(captured.capturedBytes).toBe(2);
    expect(captured.truncated).toBe(true);
  });

  it("reports an absent body as an empty complete capture", async () => {
    // Break: a 204 or a HEAD has no body at all. Reading a reader off `null`
    // is a TypeError, which would surface as a transport error for an
    // ordinary empty answer.
    const captured = await captureLinearResponseBody(null);

    expect(captured).toEqual({ text: "", capturedBytes: 0, truncated: false });
  });
});

// ===========================================================================
// 2. Classification: what a truncated capture means for each call mode.
// ===========================================================================

describe("a truncated 2xx answer is refused before it is parsed", () => {
  it("reports LINEAR_RESPONSE_TOO_LARGE and never parses or retries a read", async () => {
    // Break: parsing a cut body reports a JSON syntax error and blames
    // Linear's encoding for Poiesis' own ceiling; retrying spends the whole
    // budget to arrive at the same refusal, because the same answer will be
    // the same size.
    const { transport, requests } = scriptedTransport([httpReply(200, cutBody('{"data":{"issue"'))]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "LINEAR_RESPONSE_TOO_LARGE" });
    expect((error as PoiesisError).details).toMatchObject({ operation: "PoiesisIssue", status: 200, capturedBytes: EIGHT_MIB });
    expect(requests).toHaveLength(1);
  });

  it("reports a COMPLETE answer that is not JSON as the pre-existing failure", async () => {
    // Break: folding "not JSON" into the too-large refusal destroys the one
    // distinction an operator needs — a truncated body and a proxy that
    // answered with HTML are different problems in different places.
    const { transport } = scriptedTransport([httpReply(200, completeBody("<html>gateway</html>"))]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    await expect(adapter.getSpec("ENG-1")).rejects.toMatchObject({
      code: "LINEAR_HTTP_ERROR",
      message: expect.stringContaining("did not return JSON"),
    });
  });

  it("reports an uncertainty and never replays a mutation whose answer was truncated", async () => {
    // Break: a comment create is a MUTATION. Linear received it, the answer
    // started arriving with a 2xx, and Poiesis cannot read it — so the work
    // may or may not have landed. Replaying it would double a comment that
    // Poiesis cannot distinguish from the original.
    const { transport, requests } = scriptedTransport([
      httpReply(200, completeBody(JSON.stringify({ data: { issue: TICKET_NODE } }))),
      httpReply(200, cutBody('{"data":{"commentCreate":{"success":true')),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.commentTicket("ENG-2", "a note").catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      details: { operation: "PoiesisCommentCreate", reason: "response-too-large" },
    });
    expect(requests.map((request) => JSON.parse(request.body).query)).toEqual([
      expect.stringContaining("PoiesisIssue"),
      expect.stringContaining("PoiesisCommentCreate"),
    ]);
  });

  it("does not probe the create identity after a truncated answer", async () => {
    // Break: the create is IDEMPOTENT, so a lost answer could be resolved by
    // re-reading the identity it used. The ticket does not permit that here:
    // the probe would be a second request inside a path whose whole content
    // is that the first request's outcome is unknown, and the operation
    // reports the ambiguity with the inspect-in-Linear instruction instead.
    const { transport, requests } = scriptedTransport([
      httpReply(200, completeBody(JSON.stringify({ data: TEAM_PAGE }))),
      httpReply(200, cutBody('{"data":{"issueCreate":{')),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      details: { operation: "PoiesisIssueCreate", reason: "response-too-large" },
    });
    expect(requests).toHaveLength(2);
  });
});

// ===========================================================================
// 3. The production transport: honest, dishonest, and absent Content-Length.
// ===========================================================================

describe("the production Linear transport bounds a dishonest or absent Content-Length", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops at the ceiling even when Content-Length claims the body is tiny", async () => {
    // Break: trusting `Content-Length` to decide whether to read hands the
    // bound to an unverified claim by the very party Poiesis is bounding. A
    // lying header must not be able to make Poiesis read an unbounded body.
    // The source never ends, so the only thing that can stop the read is the
    // capture's own cancel.
    const oversize = bytes("a".repeat(EIGHT_MIB + 1));
    const state = observed();
    const scripted = productionResponse(deliveries(oversize, 64 * 1024), state, {
      headers: { "content-length": "12" },
      endless: true,
    });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return scripted.response;
    });

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV } });

    await expect(adapter.getSpec("ENG-1")).rejects.toMatchObject({ code: "LINEAR_RESPONSE_TOO_LARGE" });
    expect(calls).toBe(1);
    expect(state.cancels).toBe(1);
  });

  it("stops at the ceiling when Content-Length is absent", async () => {
    // Break: chunked transfer encoding sends no length at all. An
    // implementation that required a length before bounding would read the
    // whole body, and one that required a length before reading would treat
    // every chunked answer as empty.
    const oversize = bytes("a".repeat(EIGHT_MIB + 1));
    const state = observed();
    const scripted = productionResponse(deliveries(oversize, 64 * 1024), state, { endless: true });
    vi.stubGlobal("fetch", async () => scripted.response);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV } });

    await expect(adapter.getSpec("ENG-1")).rejects.toMatchObject({ code: "LINEAR_RESPONSE_TOO_LARGE" });
    expect(state.cancels).toBe(1);
  });

  it("still parses an honest answer that is under the ceiling", async () => {
    // Break: a ceiling that reports every body as truncated refuses the
    // ordinary case, which is a total outage wearing a bound's clothes.
    const payload = JSON.stringify({ data: { issue: ISSUE_NODE } });
    const state = observed();
    const scripted = productionResponse(deliveries(bytes(payload), 7), state, {
      headers: { "content-length": String(Buffer.byteLength(payload, "utf8")) },
    });
    vi.stubGlobal("fetch", async () => scripted.response);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV } });

    await expect(adapter.getSpec("ENG-1")).resolves.toMatchObject({ id: "ENG-1", title: "Canonical intent" });
    expect(state.cancels).toBe(0);
  });
});

// ===========================================================================
// 4. The diagnostic pipeline.
// ===========================================================================

describe("every echoed Linear byte is bounded, userinfo-redacted, and credential-free", () => {
  /**
   * A body carrying BOTH leak shapes at once: a URL whose credential lives
   * in its userinfo, and the bare credential echoed twice as ordinary text.
   */
  function leakyBody(): string {
    return [
      "upstream refused: https://build-bot:lin_api_secret@github.com/owner/repo.git",
      "Authorization: lin_api_secret",
      "retry after fixing lin_api_secret",
      "x".repeat(200_000),
    ].join("\n");
  }

  it("bounds and redacts a retried 5xx diagnostic", async () => {
    // Break: an unbounded body in `details` is a log-injection and a
    // megabyte-in-a-CI-annotation hazard; an unsanitized one is a credential
    // in every CI log. The 5xx path is retried, so the bound has to hold for
    // the final refusal AND the failure must stay retryable.
    const { transport, requests } = scriptedTransport([
      httpReply(503, completeBody(leakyBody())),
      httpReply(503, completeBody(leakyBody())),
      httpReply(503, completeBody(leakyBody())),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, {
      env: { ...ENV },
      transport,
      sleep: async () => undefined,
    });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const details = (error as PoiesisError).details;

    expect(error).toMatchObject({ code: "LINEAR_HTTP_ERROR", details: { status: 503, attempts: 3 } });
    expect(details.bodyTruncated).toBe(true);
    expect(requests).toHaveLength(3);
    const body = details.body as string;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(EIGHT_KIB);
    expect(serialize(error)).not.toContain(CREDENTIAL);
    expect(body).not.toContain("build-bot:");
    // A redaction, not a deletion: the host is what makes the diagnostic
    // useful, and the runner's own rule keeps it.
    expect(body).toContain("https://github.com/owner/repo.git");
  });

  it("bounds and redacts an immediate non-2xx diagnostic without retrying it", async () => {
    // Break: a 4xx is a refusal, so it must not spend the retry budget; and
    // the body Linear echoes on a refusal is exactly where a proxy repeats
    // the request it was given, credentials included.
    const { transport, requests } = scriptedTransport([httpReply(400, completeBody(leakyBody()))]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "LINEAR_HTTP_ERROR", details: { status: 400 } });
    expect(requests).toHaveLength(1);
    expect(serialize(error)).not.toContain(CREDENTIAL);
    expect((error as PoiesisError).details.body).not.toContain("build-bot:");
  });

  it("keeps the body out of a 401 entirely", async () => {
    // Break: a refused credential is the one status whose body is pure
    // noise, and the one remediation is the credential. Echoing a body here
    // only adds a way for the refused credential to travel.
    const { transport } = scriptedTransport([httpReply(401, completeBody(leakyBody()))]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "LINEAR_AUTH_FAILED", details: { status: 401 } });
    expect((error as PoiesisError).details.body).toBeUndefined();
    expect(serialize(error)).not.toContain(CREDENTIAL);
  });

  it("redacts and bounds a transport exception message", async () => {
    // Break: a socket error's message routinely carries the URL it was
    // dialling, and a proxy URL carries the proxy's credential in its
    // userinfo. The exception is also the one diagnostic whose text nobody
    // chose to be safe.
    const { transport } = scriptedTransport([
      new Error("request to https://build-bot:lin_api_secret@proxy.internal/graphql failed for lin_api_secret"),
      new Error("request to https://build-bot:lin_api_secret@proxy.internal/graphql failed for lin_api_secret"),
      new Error("request to https://build-bot:lin_api_secret@proxy.internal/graphql failed for lin_api_secret"),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, {
      env: { ...ENV },
      transport,
      sleep: async () => undefined,
    });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const causeMessage = (error as PoiesisError).details.causeMessage as string;

    expect(error).toMatchObject({ code: "LINEAR_TRANSPORT_ERROR", details: { attempts: 3 } });
    expect(causeMessage).toBe("request to https://proxy.internal/graphql failed for [redacted]");
    expect(serialize(error)).not.toContain(CREDENTIAL);
  });

  it("bounds a transport exception message that is longer than the bound", async () => {
    // Break: the bound is applied to the body capture and not to the other
    // echoed byte source. A proxy that returns a page-sized reason phrase in
    // its exception is the ordinary shape of that failure.
    const { transport } = scriptedTransport([
      new Error(`socket reset talking to ${"proxy.internal/".repeat(2000)}`),
      new Error(`socket reset talking to ${"proxy.internal/".repeat(2000)}`),
      new Error(`socket reset talking to ${"proxy.internal/".repeat(2000)}`),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, {
      env: { ...ENV },
      transport,
      sleep: async () => undefined,
    });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const causeMessage = (error as PoiesisError).details.causeMessage as string;

    expect(Buffer.byteLength(causeMessage, "utf8")).toBeLessThanOrEqual(EIGHT_KIB);
  });

  it("withholds a URL authority that the capture cut in half", async () => {
    // Break: the userinfo rule has to be told the text IS being cut. When the
    // ceiling stopped inside a `scheme://authority`, the `@` that proves
    // userinfo is one of the bytes Poiesis refused, so the visible text
    // `https://partial-secret…` cannot be told apart from a host — and a
    // diagnostic that quoted it would leak the part of the credential that
    // did survive. The newline matters: the userinfo rule recognizes a scheme
    // only after a non-scheme byte, so a URL glued to filler is deliberately
    // not a URL to it.
    const cut = `${"x".repeat(64)}\nhttps://${"partial-secret".repeat(20)}`;
    const { transport } = scriptedTransport([
      httpReply(503, cutBody(cut, cut.length)),
      httpReply(503, cutBody(cut, cut.length)),
      httpReply(503, cutBody(cut, cut.length)),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, {
      env: { ...ENV },
      transport,
      sleep: async () => undefined,
    });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const diagnostic = (error as PoiesisError).details.body as string;

    // The withheld range runs to the end of the text, so a diagnostic whose
    // open authority was withheld ends at the replacement.
    expect(diagnostic.endsWith("[redacted]")).toBe(true);
    expect(diagnostic).not.toContain("partial-secret");
    expect((error as PoiesisError).details.bodyTruncated).toBe(true);
  });

  it("keeps a complete body's closed authority readable", async () => {
    // Break: failing closed on EVERY text that ends inside an authority
    // redacts ordinary prose that merely ends next to a URL — `trace to
    // https://github.com/owner/repo.git` with no trailing newline — and a
    // redactor that destroys diagnosable text gets turned off.
    const { transport } = scriptedTransport([httpReply(400, completeBody("trace to https://github.com/owner/repo.git"))]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);

    expect((error as PoiesisError).details.body).toBe("trace to https://github.com/owner/repo.git");
    expect((error as PoiesisError).details.bodyTruncated).toBeUndefined();
  });

  it("leaves a successful data payload byte-for-byte", async () => {
    // Break: sanitizing a SUCCESSFUL payload is corrupting the Author's own
    // content. An issue body that quotes a URL with a userinfo in it — a
    // support thread about exactly that — must come back exactly as Linear
    // stored it, and must not be bounded into a different document.
    const quoted = "reported by https://build-bot:lin_api_secret@github.com/owner/repo.git — see lin_api_secret in CI";
    const payload = JSON.stringify({
      data: { issue: { ...ISSUE_NODE, description: specDescription(quoted), title: quoted } },
    });
    const { transport } = scriptedTransport([httpReply(200, completeBody(payload))]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    await expect(adapter.getSpec("ENG-1")).resolves.toMatchObject({
      title: quoted,
      body: quoted,
    });
  });
});

// ===========================================================================
// 5. Bounds on the GraphQL error list.
// ===========================================================================

describe("a GraphQL error list is bounded and reports what it omitted", () => {
  it("reports at most twenty errors and says how many it left out", async () => {
    // Break: a Linear error array is unbounded, and echoing all of it turns
    // one refusal into a document no error envelope will render. Silently
    // dropping the tail is worse than dropping it loudly: the count is the
    // only thing that tells an operator the refusal had more to say.
    const errors = Array.from({ length: 25 }, (_unused, index) => ({
      message: `refusal number ${index}`,
      extensions: { code: `CODE_${index}` },
    }));
    const { transport } = scriptedTransport([
      httpReply(200, completeBody(JSON.stringify({ data: null, errors }))),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const details = (error as PoiesisError).details;
    const reported = details.errors as { message: string; code: string }[];

    expect(error).toMatchObject({ code: "LINEAR_GRAPHQL_ERROR" });
    expect(reported).toHaveLength(20);
    expect(details.errorCount).toBe(25);
    expect(details.errorsOmitted).toBe(5);
    expect(reported[0]).toEqual({ message: "refusal number 0", code: "CODE_0" });
    expect(reported[19]).toEqual({ message: "refusal number 19", code: "CODE_19" });
  });

  it("omits the omission metadata when nothing was omitted", async () => {
    // Break: reporting `errorsOmitted: 0` on every ordinary refusal is a
    // number an operator has to learn to ignore.
    const { transport } = scriptedTransport([
      httpReply(200, completeBody(JSON.stringify({ data: null, errors: [{ message: "one" }] }))),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const details = (error as PoiesisError).details;

    expect(details.errorCount).toBe(1);
    expect("errorsOmitted" in details).toBe(false);
  });

  it("bounds each message and code to eight KiB and reports that it cut them", async () => {
    // Break: one GraphQL message can be a megabyte (a validation dump, a
    // query echo). Bounding it silently makes a refusal unreadable at the
    // point where the reason is the whole content.
    const longMessage = `m${"g".repeat(EIGHT_KIB + 500)}`;
    const longCode = `c${"d".repeat(EIGHT_KIB + 500)}`;
    const { transport } = scriptedTransport([
      httpReply(200, completeBody(JSON.stringify({
        data: null,
        errors: [{ message: longMessage, extensions: { code: longCode } }],
      }))),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const entry = ((error as PoiesisError).details.errors as { message: string; code: string; messageTruncated: boolean; codeTruncated: boolean }[])[0];

    expect(Buffer.byteLength(entry?.message ?? "", "utf8")).toBeLessThanOrEqual(EIGHT_KIB);
    expect(Buffer.byteLength(entry?.code ?? "", "utf8")).toBeLessThanOrEqual(EIGHT_KIB);
    expect(entry?.messageTruncated).toBe(true);
    expect(entry?.codeTruncated).toBe(true);
  });

  it("redacts a GraphQL message and code that echo the credential and a userinfo URL", async () => {
    // Break: Linear's own error text is built from the request it refused, so
    // it is a place the credential and a userinfo both appear verbatim.
    const { transport } = scriptedTransport([
      httpReply(200, completeBody(JSON.stringify({
        data: null,
        errors: [{
          message: "no such repo: https://build-bot:lin_api_secret@github.com/owner/repo.git (key lin_api_secret)",
          extensions: { code: "lin_api_secret" },
        }],
      }))),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const entry = ((error as PoiesisError).details.errors as { message: string; code: string }[])[0];

    expect(serialize(error)).not.toContain(CREDENTIAL);
    expect(entry?.message).toBe("no such repo: https://github.com/owner/repo.git (key [redacted])");
    expect(entry?.code).toBe("[redacted]");
  });

  it("keeps the truncation flag honest for a message the bound did not cut", async () => {
    // Break: a truncation flag that is always true teaches an operator to
    // distrust it, and a message that was NOT cut must say so.
    const { transport } = scriptedTransport([
      httpReply(200, completeBody(JSON.stringify({
        data: null,
        errors: [{ message: "short refusal", extensions: { code: "SHORT" } }],
      }))),
    ]);

    const adapter = createLinearTrackerAdapter({ team: "ENG" }, { env: { ...ENV }, transport });

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);
    const entry = ((error as PoiesisError).details.errors as Record<string, unknown>[])[0];

    expect(entry).toEqual({ message: "short refusal", code: "SHORT" });
  });
});

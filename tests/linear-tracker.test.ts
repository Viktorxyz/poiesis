/**
 * Spec #139 / ticket #141 — the first-class Linear tracker adapter.
 *
 * The adapter maps Poiesis Specs to ordinary Linear issues and Poiesis
 * Tickets to Linear CHILD issues, optionally associated with a Linear
 * project. It speaks the official GraphQL endpoint directly over an
 * injected transport, so nothing here depends on a Linear SDK, a live
 * workspace, or the wall clock.
 *
 * Every test here names the production break it catches. The five
 * boundaries under test are:
 *
 *   1. CREDENTIALS — `LINEAR_API_KEY` becomes a raw `Authorization`
 *      value, `LINEAR_OAUTH_TOKEN` becomes a `Bearer` value, exactly one
 *      may be present, and the secret never reaches a request detail, an
 *      error message, or an error's `details`.
 *   2. IDENTITY — the round trip preserves the Poiesis metadata block,
 *      the human identifier (`ENG-123`), and the Linear URL.
 *   3. RESOLUTION — team / project / issue / completed-state lookups
 *      follow pagination and refuse to guess when a name is ambiguous.
 *   4. SAFETY — bounded rate-limit retry for reads and for the
 *      UUID-reusing idempotent create; NO blind replay of a comment or an
 *      update whose outcome is unknown.
 *   5. SUPERSEDE — uses the existing metadata + comment + close
 *      semantics and never fabricates a native Linear relation.
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrackerAdapter } from "../src/adapters.js";
import { PoiesisError } from "../src/errors.js";
import { setLinearTrackerSeamsForTest, verifyTracker } from "../src/maintenance.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import type { ResolvedPoiesisConfig } from "../src/config.js";
import {
  createLinearTrackerAdapter,
  verifyLinearTrackerAuthorized,
  verifyLinearTrackerConfigured,
  type LinearHttpRequest,
  type LinearHttpResponse,
  type LinearTimer,
  type LinearTransport,
  type LinearTrackerSeams,
} from "../src/linear-tracker.js";

// -- Wire-format fixtures -------------------------------------------------
//
// These are hand-written literals, NOT values produced by the code under
// test. They fix the persisted Linear description format: a Poiesis
// metadata block, the relationship prose, a `---` rule, then the Author's
// body. A test that reads an item back and sees the original body proves
// the metadata survived the round trip.

const SPEC_DESCRIPTION = [
  "<!-- poiesis:tracker",
  '{"kind":"spec"}',
  "poiesis:tracker -->",
  "",
  "**Poiesis Spec**",
  "",
  "---",
  "",
  "Canonical decisions",
].join("\n");

function supersededTicketDescription(
  parentSpecId: string,
  dependencyText: string,
  body: string,
  reason: string,
  replacementIds: readonly string[],
): string {
  return [
    "<!-- poiesis:tracker",
    JSON.stringify({
      kind: "ticket",
      parentSpecId,
      dependencyText,
      supersededReason: reason,
      supersededBy: [...replacementIds],
    }),
    "poiesis:tracker -->",
    "",
    "**Poiesis Ticket**",
    "",
    `Parent Spec: ${parentSpecId}`,
    "",
    "Dependencies:",
    dependencyText,
    "",
    `Superseded: ${reason}`,
    "",
    `Replaced by: ${replacementIds.join(", ")}`,
    "",
    "---",
    "",
    body,
  ].join("\n");
}

function ticketDescription(parentSpecId: string, dependencyText: string, body: string): string {
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
    body,
  ].join("\n");
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: { type: string };
  team: { id: string };
}

function issueNode(overrides: Partial<LinearIssueNode> = {}): LinearIssueNode {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    identifier: "ENG-1",
    title: "Canonical intent",
    description: SPEC_DESCRIPTION,
    url: "https://linear.app/acme/issue/ENG-1",
    state: { type: "unstarted" },
    team: { id: "team-uuid-eng" },
    ...overrides,
  };
}

interface LinearTeamNode {
  id: string;
  key: string;
  name: string;
}

function teamNode(overrides: Partial<LinearTeamNode> = {}): LinearTeamNode {
  return { id: "team-uuid-eng", key: "ENG", name: "Engineering", ...overrides };
}

interface LinearProjectNode {
  id: string;
  name: string;
}

function projectNode(overrides: Partial<LinearProjectNode> = {}): LinearProjectNode {
  return { id: "project-uuid-platform", name: "Platform", ...overrides };
}

const TEAM_PAGE = (nodes: LinearTeamNode[], hasNextPage = false, endCursor: string | null = null) => ({
  teams: { nodes, pageInfo: { hasNextPage, endCursor } },
});

const PROJECT_PAGE = (nodes: LinearProjectNode[], hasNextPage = false, endCursor: string | null = null) => ({
  projects: { nodes, pageInfo: { hasNextPage, endCursor } },
});

const ISSUE_PAGE = (nodes: LinearIssueNode[], hasNextPage = false, endCursor: string | null = null) => ({
  issues: { nodes, pageInfo: { hasNextPage, endCursor } },
});

const TEAM_STATES = { team: { states: { nodes: [{ id: "state-done", type: "completed" }] } } };

// -- Scripted transport ---------------------------------------------------

/**
 * A scripted Linear endpoint. It answers from a fixed reply list in
 * call order, records every request the adapter made (so a test can assert
 * the emitted operation, variables, and headers), and refuses to invent an
 * answer for an unscripted call. Each reply branch gets its own shape so
 * the wrong branch cannot satisfy a test.
 */
type LinearReply =
  | { readonly kind: "graphql"; readonly data?: unknown; readonly errors?: readonly { message: string; extensions?: Record<string, unknown> }[] }
  | { readonly kind: "http"; readonly status: number; readonly headers?: Record<string, string>; readonly body: string }
  | { readonly kind: "network" }
  /**
   * Spec #139 / ticket #150 — a request that never answers.
   *
   * The only thing that can end this promise is Poiesis's own abort deadline,
   * which is exactly the production shape: a socket that stops reading, a
   * proxy that holds the connection open, a Linear response that never starts
   * arriving. A transport that cannot be aborted has no deadline at all, so
   * this reply is also the assertion that every attempt carries a signal.
   */
  | { readonly kind: "hang" };

class LinearScript {
  readonly requests: LinearHttpRequest[] = [];
  private readonly replies: readonly LinearReply[];
  private cursor = 0;

  constructor(...replies: readonly LinearReply[]) {
    this.replies = replies;
  }

  readonly transport: LinearTransport = async (request) => {
    this.requests.push(request);
    const reply = this.replies[this.cursor];
    this.cursor += 1;
    if (reply === undefined) {
      throw new Error(`unscripted Linear request: ${operationNameOf(request)}`);
    }
    if (reply.kind === "network") throw new Error("socket hang up");
    if (reply.kind === "hang") {
      const signal = request.signal as AbortSignal | undefined;
      if (typeof signal?.addEventListener !== "function") {
        throw new Error("a Linear attempt was sent with no abort signal");
      }
      return await new Promise<LinearHttpResponse>((_resolve, rejectOnAbort) => {
        signal.addEventListener("abort", () => {
          const aborted = new Error("The operation was aborted");
          aborted.name = "AbortError";
          rejectOnAbort(aborted);
        });
      });
    }
    if (reply.kind === "http") {
      return {
        status: reply.status,
        headers: { ...reply.headers },
        body: reply.body,
      } satisfies LinearHttpResponse;
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ data: reply.data ?? null, ...(reply.errors === undefined ? {} : { errors: reply.errors }) }),
    } satisfies LinearHttpResponse;
  };

  /** The GraphQL operation name of every request the adapter emitted. */
  operations(): string[] {
    return this.requests.map(operationNameOf);
  }

  variablesOf(index: number): Record<string, unknown> {
    const request = this.requests[index];
    if (request === undefined) throw new Error(`no Linear request at index ${index}`);
    return JSON.parse(request.body).variables as Record<string, unknown>;
  }
}

function operationNameOf(request: LinearHttpRequest): string {
  const match = /^(?:query|mutation)\s+(\w+)/.exec(JSON.parse(request.body).query as string);
  return match?.[1] ?? "";
}

/**
 * Deterministic clock / sleep / UUID / TIMER seams.
 *
 * Ticket #150: the timer that fires an attempt's abort is virtual here too.
 * A timeout test that waits on a real `setTimeout` is either slow or flaky,
 * and a test that reaches into real time cannot tell "Poiesis bounded this"
 * from "the machine was quick". `sleep` advances the injected clock by exactly
 * the delay, `timer` records the deadline Poiesis asked for and fires it only
 * when the test moves virtual time forward, and `advance` fires due callbacks
 * in a fixed order (earliest deadline first, then scheduling order). So a
 * deadline test asserts a SEQUENCE, never a race.
 */
function deterministicSeams(): ObservableSeams {
  const sleeps: number[] = [];
  const uuids: string[] = [];
  const attemptTimeouts: number[] = [];
  let now = 0;
  let sequence = 0;
  let nextTimer = 0;
  const pending: { id: number; at: number; fire: () => void }[] = [];

  const advance = (ms: number): void => {
    const target = now + Math.max(0, ms);
    for (;;) {
      const due = pending
        .filter((entry) => entry.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (due === undefined) break;
      pending.splice(pending.indexOf(due), 1);
      // Monotonic: time never moves backwards, even if a fired callback moved
      // it forward itself.
      now = Math.max(now, due.at);
      due.fire();
    }
    now = Math.max(now, target);
  };

  return {
    sleeps,
    uuids,
    attemptTimeouts,
    advance,
    clock: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      advance(ms);
    },
    uuid: () => {
      sequence += 1;
      const uuid = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      uuids.push(uuid);
      return uuid;
    },
    timer: (ms: number, onElapsed: () => void) => {
      const entry = { id: (nextTimer += 1), at: now + Math.max(0, ms), fire: onElapsed };
      pending.push(entry);
      attemptTimeouts.push(ms);
      return {
        cancel: () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        },
      };
    },
  };
}

/**
 * The seams plus the observation channels, so a test can assert the delays
 * Poiesis asked for, the deadlines it scheduled, and the identities it
 * generated without waiting or depending on a real random source. Declared
 * explicitly rather than as an intersection with `LinearTrackerSeams` so the
 * injected clock, sleep, UUID, and timer stay REQUIRED here: a test that
 * passed an optional member through would silently fall back to a real clock.
 */
type ObservableSeams = {
  readonly env?: Record<string, string | undefined>;
  readonly transport?: LinearTransport;
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly uuid: () => string;
  readonly timer: LinearTimer;
  readonly sleeps: number[];
  readonly uuids: string[];
  /** The attempt deadline Poiesis scheduled, in scheduling order. */
  readonly attemptTimeouts: number[];
  /** Move virtual time forward, firing every due deadline in a fixed order. */
  readonly advance: (ms: number) => void;
};

/**
 * Let every pending microtask run. The virtual timer only fires on an explicit
 * `advance`, so this is deterministic: it drains the promise chain up to its
 * next suspension, which is the next request awaiting its deadline.
 */
function drain(): Promise<void> {
  return new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
}

/** Observe a pending operation without ever leaving a rejection unhandled. */
async function settled<T>(pending: Promise<T>): Promise<{ ok: T; error?: undefined } | { ok?: undefined; error: unknown }> {
  return await pending.then(
    (value) => ({ ok: value }),
    (error: unknown) => ({ error }),
  );
}

function seamsFor(script: LinearScript, env: Record<string, string | undefined>): ObservableSeams {
  return { env, transport: script.transport, ...deterministicSeams() };
}

// -- Tests ----------------------------------------------------------------

describe("Linear credentials come from the environment and never leak", () => {
  it("posts to the official Linear GraphQL endpoint as JSON", async () => {
    // Break: a hand-rolled or proxied endpoint, or a missing content type,
    // would make the request unreachable by the real Linear API.
    const script = new LinearScript({ kind: "graphql", data: { issue: null } });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-1")).rejects.toBeInstanceOf(PoiesisError);

    expect(script.requests[0]?.url).toBe("https://api.linear.app/graphql");
    expect(script.requests[0]?.method).toBe("POST");
    expect(script.requests[0]?.headers["content-type"]).toBe("application/json");
  });

  it("sends LINEAR_API_KEY as a raw Authorization value with no scheme prefix", async () => {
    // Break: prefixing the personal API key with `Bearer ` (or any other
    // scheme) makes Linear reject a valid credential.
    const script = new LinearScript({ kind: "graphql", data: { issue: null } });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-1")).rejects.toBeInstanceOf(PoiesisError);

    expect(script.requests[0]?.headers.authorization).toBe("lin_api_secret");
  });

  it("sends LINEAR_OAUTH_TOKEN as a Bearer Authorization value", async () => {
    // Break: sending an OAuth token raw (no `Bearer `) makes Linear reject
    // a valid credential.
    const script = new LinearScript({ kind: "graphql", data: { issue: null } });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_OAUTH_TOKEN: "lin_oauth_secret" }));

    await expect(adapter.getSpec("ENG-1")).rejects.toBeInstanceOf(PoiesisError);

    expect(script.requests[0]?.headers.authorization).toBe("Bearer lin_oauth_secret");
  });

  it("fails closed when neither credential variable is present", async () => {
    // Break: constructing an adapter with no credential and failing later at
    // the first request would leave the failure far from its cause.
    expect(() => createLinearTrackerAdapter({ team: "ENG" }, { env: {} })).toThrowError(
      expect.objectContaining({
        code: "LINEAR_AUTH_MISSING",
        details: expect.objectContaining({
          variables: ["LINEAR_API_KEY", "LINEAR_OAUTH_TOKEN"],
        }),
      }),
    );
  });

  it("fails closed when both credential variables are present instead of picking one", async () => {
    // Break: silently preferring one credential would make the effective
    // identity depend on shell state the Author cannot see.
    expect(() =>
      createLinearTrackerAdapter(
        { team: "ENG" },
        { env: { LINEAR_API_KEY: "lin_api_secret", LINEAR_OAUTH_TOKEN: "lin_oauth_secret" } },
      ),
    ).toThrowError(expect.objectContaining({ code: "LINEAR_AUTH_AMBIGUOUS" }));
  });

  it("treats a blank credential variable as absent", async () => {
    // Break: an empty or whitespace-only variable would be sent as a
    // credential and fail at the network with an opaque 401.
    for (const blank of ["", "   ", "\t\n"]) {
      expect(() => createLinearTrackerAdapter({ team: "ENG" }, { env: { LINEAR_API_KEY: blank } })).toThrowError(
        expect.objectContaining({ code: "LINEAR_AUTH_MISSING" }),
      );
    }
  });

  it("keeps the credential out of every error it raises about a failed request", async () => {
    // Break: echoing the response body or the request headers into an error
    // would serialize the secret into logs, receipts, and CI output.
    const script = new LinearScript({
      kind: "http",
      status: 500,
      body: JSON.stringify({ echoed: "lin_api_secret", note: "Authorization: lin_api_secret" }),
    });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PoiesisError);
    const serialized = JSON.stringify({ message: (error as PoiesisError).message, details: (error as PoiesisError).details });
    expect(serialized).not.toContain("lin_api_secret");
  });

  it("keeps the resolved credential out of the adapter's serializable state", async () => {
    // Break: holding the resolved credential in an ordinary field would let
    // any object logger, receipt, or crash dump serialize the secret.
    const script = new LinearScript({ kind: "graphql", data: { issue: null } });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-1")).rejects.toBeInstanceOf(PoiesisError);

    expect(JSON.stringify(adapter)).not.toContain("lin_api_secret");
  });
});

describe("Linear request failures are typed and redacted", () => {
  it("reports an HTTP 401 as an auth failure", async () => {
    // Break: passing a rejected credential through as a generic HTTP error
    // hides the only remediation the Author has (fix the credential).
    const script = new LinearScript({ kind: "http", status: 401, body: "Unauthorized" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-1")).rejects.toMatchObject({
      code: "LINEAR_AUTH_FAILED",
      details: { status: 401 },
    });
  });

  it("reports a refused request as a typed HTTP error and does not retry it", async () => {
    // Break: an untyped or status-free failure leaves an operator unable to
    // tell a Linear outage from a bad request, and retrying a refusal the
    // server will repeat only spends the rate-limit budget.
    const script = new LinearScript({ kind: "http", status: 400, body: "bad request" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "LINEAR_HTTP_ERROR", details: { status: 400 } });
    expect(script.requests).toHaveLength(1);
  });

  it("reports a GraphQL error response with Linear's message and extension code", async () => {
    // Break: dropping the GraphQL `errors` array would discard the only
    // description of WHY Linear refused the operation.
    const script = new LinearScript({
      kind: "graphql",
      data: null,
      errors: [{ message: "Entity not found: Team", extensions: { code: "ENTITY_NOT_FOUND" } }],
    });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-1")).rejects.toMatchObject({
      code: "LINEAR_GRAPHQL_ERROR",
      details: { operation: expect.any(String), errors: [{ code: "ENTITY_NOT_FOUND" }] },
    });
  });

  it("turns a transport failure into a typed error instead of leaking a raw exception", async () => {
    // Break: an untyped socket error escapes as a bare `Error` with no
    // provider context and no stable code for callers to branch on.
    const script = new LinearScript({ kind: "network" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const error = await adapter.getSpec("ENG-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PoiesisError);
    expect(error).toMatchObject({ code: "LINEAR_TRANSPORT_ERROR" });
  });
});

// Referenced by the fixtures above so a rename cannot silently leave the
// literal wire formats unused.
void TEAM_PAGE;
void PROJECT_PAGE;
void ISSUE_PAGE;
void TEAM_STATES;
void teamNode;
void projectNode;
void issueNode;
void ticketDescription;

// -- Cycle 2: identity -----------------------------------------------------

describe("Poiesis identity survives the Linear round trip", () => {
  it("returns the human identifier, the Linear URL, and the Author's body", async () => {
    // Break: reporting the Linear UUID as the id, dropping the URL, or
    // returning the raw description would make the item unciteable and
    // would leak Poiesis metadata into every downstream surface.
    const script = new LinearScript({ kind: "graphql", data: { issue: issueNode() } });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const spec = await adapter.getSpec("ENG-1");

    expect(spec).toEqual({
      id: "ENG-1",
      kind: "spec",
      title: "Canonical intent",
      body: "Canonical decisions",
      state: "open",
      url: "https://linear.app/acme/issue/ENG-1",
    });
  });

  it("refuses a Linear issue that Poiesis does not manage", async () => {
    // Break: adopting a foreign Linear issue would make Poiesis overwrite
    // an Author's own tracker content with generated metadata.
    const script = new LinearScript({
      kind: "graphql",
      data: { issue: issueNode({ description: "a hand-written Linear issue" }) },
    });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-7")).rejects.toMatchObject({ code: "INVALID_TRACKER_ITEM" });
  });

  it("refuses to read a Poiesis Ticket through the Spec surface", async () => {
    // Break: reading a Ticket as a Spec would let a Replan target the wrong
    // tracker item kind.
    const script = new LinearScript({
      kind: "graphql",
      data: {
        issue: issueNode({
          identifier: "ENG-2",
          description: ticketDescription("ENG-1", "none", "Slice one"),
        }),
      },
    });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-2")).rejects.toMatchObject({ code: "TRACKER_ITEM_KIND_MISMATCH" });
  });

  it("creates a Spec as an ordinary Linear issue carrying the Poiesis metadata", async () => {
    // Break: creating the issue without the metadata block would make the
    // new issue unreadable as a Poiesis Spec on the very next read.
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode()]) },
      { kind: "graphql", data: PROJECT_PAGE([projectNode()]) },
      { kind: "graphql", data: { issueCreate: { success: true, issue: issueNode() } } },
    );
    const adapter = createLinearTrackerAdapter(
      { team: "ENG", project: "Platform" },
      { ...seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }), ...deterministicSeams() },
    );

    const spec = await adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" });

    expect(script.operations()).toEqual(["PoiesisTeams", "PoiesisProjects", "PoiesisIssueCreate"]);
    expect(script.variablesOf(2)).toEqual({
      input: {
        id: "00000000-0000-4000-8000-000000000001",
        teamId: "team-uuid-eng",
        projectId: "project-uuid-platform",
        title: "Canonical intent",
        description: SPEC_DESCRIPTION,
      },
    });
    expect(spec).toMatchObject({ id: "ENG-1", kind: "spec", url: "https://linear.app/acme/issue/ENG-1" });
  });

  it("creates a Ticket as a Linear CHILD issue of its parent Spec", async () => {
    // Break: a flat issue with the parent only in prose would lose the real
    // Linear parent/child relation the ticket requires.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      { kind: "graphql", data: TEAM_PAGE([teamNode()]) },
      {
        kind: "graphql",
        data: {
          issueCreate: {
            success: true,
            issue: issueNode({
              identifier: "ENG-2",
              description: ticketDescription("ENG-1", "none", "Acceptance"),
            }),
          },
        },
      },
    );
    const adapter = createLinearTrackerAdapter(
      { team: "ENG" },
      { ...seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }), ...deterministicSeams() },
    );

    const ticket = await adapter.createTicket({
      title: "Slice one",
      body: "Acceptance",
      parentSpecId: "ENG-1",
      dependencyText: "none",
    });

    expect(script.variablesOf(2)).toEqual({
      input: {
        id: "00000000-0000-4000-8000-000000000001",
        teamId: "team-uuid-eng",
        parentId: "11111111-1111-4111-8111-111111111111",
        title: "Slice one",
        description: ticketDescription("ENG-1", "none", "Acceptance"),
      },
    });
    expect(ticket).toMatchObject({ kind: "ticket", parentSpecId: "ENG-1", dependencyText: "none" });
  });

  it("refuses to create a Ticket under a parent that is not a Poiesis Spec", async () => {
    // Break: creating the child before verifying the parent would attach a
    // Ticket to whatever issue happens to share the identifier.
    const script = new LinearScript({
      kind: "graphql",
      data: { issue: issueNode({ identifier: "ENG-2", description: ticketDescription("ENG-1", "none", "Slice") }) },
    });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(
      adapter.createTicket({ title: "Slice", body: "Acceptance", parentSpecId: "ENG-2", dependencyText: "none" }),
    ).rejects.toMatchObject({ code: "TRACKER_ITEM_KIND_MISMATCH" });
    expect(script.operations()).toEqual(["PoiesisIssue"]);
  });

  it("preserves the metadata, identifier, and URL when a Spec body is updated", async () => {
    // Break: writing the Author's body straight into the Linear description
    // would strip the Poiesis metadata and make the item unreadable.
    const updated = issueNode({ title: "Renamed intent", description: SPEC_DESCRIPTION.replace("Canonical decisions", "Revised decisions") });
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: updated } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const spec = await adapter.updateSpec("ENG-1", { body: "Revised decisions" });

    expect(script.variablesOf(1)).toEqual({
      id: "ENG-1",
      input: { title: "Canonical intent", description: SPEC_DESCRIPTION.replace("Canonical decisions", "Revised decisions") },
    });
    expect(spec).toMatchObject({ id: "ENG-1", body: "Revised decisions", url: "https://linear.app/acme/issue/ENG-1" });
  });

  it("preserves the parent Spec and dependency text when a Ticket is updated", async () => {
    // Break: an update that re-derives the description from the new body
    // alone would silently drop the parent Spec relationship.
    const current = issueNode({ identifier: "ENG-2", description: ticketDescription("ENG-1", "none", "Acceptance") });
    const script = new LinearScript(
      { kind: "graphql", data: { issue: current } },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: current } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await adapter.updateTicket("ENG-2", { body: "Revised acceptance" });

    const sent = script.variablesOf(1).input as { description: string };
    expect(JSON.parse(sent.description.split("\n")[1] ?? "{}")).toEqual({
      kind: "ticket",
      parentSpecId: "ENG-1",
      dependencyText: "none",
    });
    expect(sent.description.endsWith("Revised acceptance")).toBe(true);
  });
});

// -- Cycle 3: resolution ---------------------------------------------------

describe("Linear resolution follows pagination and refuses to guess", () => {
  it("follows the team connection across pages until Linear reports the end", async () => {
    // Break: reading only the first page would report "no such team" for a
    // team that exists on page two, or silently pick the first page's teams.
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode({ key: "OPS", name: "Operations" })], true, "cursor-1") },
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "graphql", data: { issueCreate: { success: true, issue: issueNode() } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" });

    expect(script.operations()).toEqual(["PoiesisTeams", "PoiesisTeams", "PoiesisIssueCreate"]);
    expect(script.variablesOf(1).after).toBe("cursor-1");
    expect((script.variablesOf(2).input as { teamId: string }).teamId).toBe("team-uuid-eng");
  });

  it("refuses a configured team that matches more than one Linear team", async () => {
    // Break: taking the first match would file a Spec into an arbitrary
    // team, and the Author would never see it.
    const script = new LinearScript(
      {
        kind: "graphql",
        data: TEAM_PAGE([teamNode(), teamNode({ id: "team-uuid-eng-2", key: "ENG", name: "Engineering EU" })], false),
      },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.createSpec({ title: "T", body: "B" })).rejects.toMatchObject({
      code: "LINEAR_TEAM_AMBIGUOUS",
      details: { team: "ENG" },
    });
    expect(script.operations()).toEqual(["PoiesisTeams"]);
  });

  it("refuses a configured team that matches nothing", async () => {
    // Break: creating the issue without a resolved team would either fail
    // opaquely at Linear or land in a default team Poiesis never verified.
    const script = new LinearScript({ kind: "graphql", data: TEAM_PAGE([], false) });
    const adapter = createLinearTrackerAdapter({ team: "NOPE" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.createSpec({ title: "T", body: "B" })).rejects.toMatchObject({ code: "LINEAR_TEAM_NOT_FOUND" });
  });

  it("stops scanning a connection that never ends instead of looping", async () => {
    // Break: an unbounded pagination loop would hang the CLI forever on a
    // workspace whose pageInfo never reports the end.
    const endless = Array.from({ length: 25 }, (_, index) => ({
      kind: "graphql" as const,
      data: TEAM_PAGE([teamNode({ key: "OPS", name: `Operations ${index}` })], true, `cursor-${index}`),
    }));
    const script = new LinearScript(...endless);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.createSpec({ title: "T", body: "B" })).rejects.toMatchObject({
      code: "LINEAR_PAGINATION_BOUND_REACHED",
    });
    expect(script.requests).toHaveLength(20);
  });

  it("refuses a configured project that matches more than one Linear project", async () => {
    // Break: picking one of two identically named projects would associate
    // every issue with a project the Author never chose.
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "graphql", data: PROJECT_PAGE([projectNode(), projectNode({ id: "project-uuid-2" })], false) },
    );
    const adapter = createLinearTrackerAdapter(
      { team: "ENG", project: "Platform" },
      seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }),
    );

    await expect(adapter.createSpec({ title: "T", body: "B" })).rejects.toMatchObject({
      code: "LINEAR_PROJECT_AMBIGUOUS",
      details: { project: "Platform" },
    });
  });

  it("resolves an issue by its human identifier when the direct lookup misses", async () => {
    // Break: treating a null `issue(id:)` as "not found" would make every
    // `ENG-123` citation unusable, since the identifier is what Poiesis
    // hands back and what the CLI accepts.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: null } },
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      {
        kind: "graphql",
        data: ISSUE_PAGE([issueNode({ identifier: "ENG-4", url: "https://linear.app/acme/issue/ENG-4" })], true, "cursor-1"),
      },
      { kind: "graphql", data: ISSUE_PAGE([issueNode({ identifier: "ENG-5" })], false) },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const spec = await adapter.getSpec("ENG-4");

    expect(spec).toMatchObject({ id: "ENG-4", kind: "spec", url: "https://linear.app/acme/issue/ENG-4" });
    expect(script.operations()).toEqual(["PoiesisIssue", "PoiesisTeams", "PoiesisTeamIssues", "PoiesisTeamIssues"]);
    expect(script.variablesOf(3).after).toBe("cursor-1");
  });

  it("refuses an identifier that matches no issue in the configured team", async () => {
    // Break: returning a synthesized item for an unresolved identifier would
    // report tracker work that does not exist.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: null } },
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "graphql", data: ISSUE_PAGE([issueNode({ identifier: "ENG-9" })], false) },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.getSpec("ENG-404")).rejects.toMatchObject({ code: "LINEAR_ITEM_NOT_FOUND" });
  });
});

// -- Cycle 4: bounded safety -----------------------------------------------

describe("rate limits are retried within a fixed bound", () => {
  it("waits exactly the Retry-After Linear asked for, then completes the read", async () => {
    // Break: retrying immediately would hammer a rate-limited workspace, and
    // ignoring Retry-After would extend the outage Poiesis just joined.
    const script = new LinearScript(
      { kind: "http", status: 429, headers: { "retry-after": "2" }, body: "rate limited" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    expect(await adapter.getSpec("ENG-1")).toMatchObject({ id: "ENG-1" });
    expect(seams.sleeps).toEqual([2000]);
  });

  it("stops after a fixed number of rate-limited attempts", async () => {
    // Break: an unbounded retry loop would hang a CI job on a workspace that
    // is rate-limiting every request.
    const script = new LinearScript(
      { kind: "http", status: 429, body: "rate limited" },
      { kind: "http", status: 429, body: "rate limited" },
      { kind: "http", status: 429, body: "rate limited" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    await expect(adapter.getSpec("ENG-1")).rejects.toMatchObject({
      code: "LINEAR_RATE_LIMITED",
      details: { attempts: 3, status: 429 },
    });
    expect(script.requests).toHaveLength(3);
  });

  it("retries a read that Linear answered with a server error", async () => {
    // Break: refusing to retry a 5xx read turns a transient Linear error into
    // a hard failure even though the operation changed nothing.
    const script = new LinearScript(
      { kind: "http", status: 503, body: "upstream unavailable" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    expect(await adapter.getSpec("ENG-1")).toMatchObject({ id: "ENG-1" });
    expect(script.requests).toHaveLength(2);
  });

  it("clamps a Retry-After longer than the adapter's maximum single wait", async () => {
    // Break: honoring a one-minute Retry-After verbatim would stall the CLI
    // for a minute on a single rate-limited request.
    const script = new LinearScript(
      { kind: "http", status: 429, headers: { "retry-after": "60" }, body: "rate limited" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    await adapter.getSpec("ENG-1");

    expect(seams.sleeps).toEqual([10_000]);
  });

  it("gives up once the total retry wait would exceed the budget", async () => {
    // Break: bounding each individual delay while letting the cumulative
    // wait grow without limit still stalls the caller.
    const script = new LinearScript(
      { kind: "http", status: 429, headers: { "retry-after": "20" }, body: "rate limited" },
      { kind: "http", status: 429, headers: { "retry-after": "20" }, body: "rate limited" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    await expect(adapter.getSpec("ENG-1")).rejects.toMatchObject({ code: "LINEAR_RATE_LIMITED" });
    expect(script.requests).toHaveLength(2);
    expect(seams.sleeps).toEqual([10000]);
  });
});

describe("an uncertain mutation is reported, never replayed", () => {
  it("does not duplicate an issue when the first create response is lost", async () => {
    // Break: a create retried with a fresh identity would file the same Poiesis
    // Spec twice. Reusing one UUID, and re-reading it before retrying, is what
    // makes the create idempotent.
    const created = issueNode({ identifier: "ENG-1" });
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "network" },
      { kind: "graphql", data: { issue: created } },
    );
    const seams = seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" });
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const spec = await adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" });

    expect(spec).toMatchObject({ id: "ENG-1" });
    expect(seams.uuids).toHaveLength(1);
    expect(seams.uuids[0]).toBe((script.variablesOf(1).input as { id: string }).id);
    expect((script.variablesOf(2).id)).toBe(seams.uuids[0]);
  });

  it("reports a comment whose outcome is unknown instead of replaying it", async () => {
    // Break: replaying an ambiguous comment would post the same supersede
    // notice twice, and Poiesis cannot tell from here which one landed.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      { kind: "network" },
      { kind: "graphql", data: { commentCreate: { success: true, comment: { id: "c-2", body: "x", url: "u" } } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.commentSpec("ENG-1", "Superseded: replan")).rejects.toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      details: { operation: "PoiesisCommentCreate" },
    });
    expect(script.operations()).toEqual(["PoiesisIssue", "PoiesisCommentCreate"]);
  });

  it("reports an update that Linear failed with a server error instead of replaying it", async () => {
    // Break: replaying an ambiguous update would silently re-apply a body
    // change, and Linear issues are not versioned, so the Author would have
    // no way to tell it happened twice.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      { kind: "http", status: 500, body: "boom" },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: issueNode() } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.updateSpec("ENG-1", { body: "Revised decisions" })).rejects.toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      details: { operation: "PoiesisIssueUpdate" },
    });
    expect(script.operations()).toEqual(["PoiesisIssue", "PoiesisIssueUpdate"]);
  });

  it("returns the Linear comment it actually created", async () => {
    // Break: inventing a comment id would make a supersede receipt cite a
    // comment that does not exist.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      {
        kind: "graphql",
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-uuid-1", body: "Superseded: replan", url: "https://linear.app/acme/issue/ENG-1#comment-1" },
          },
        },
      },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    expect(await adapter.commentSpec("ENG-1", "Superseded: replan")).toEqual({
      id: "comment-uuid-1",
      itemId: "ENG-1",
      body: "Superseded: replan",
      url: "https://linear.app/acme/issue/ENG-1#comment-1",
    });
  });
});

// -- Cycle 6: the deadline on every Linear call (ticket #150) ----------------

/**
 * Spec #139 / ticket #150 — no Linear call can wait forever.
 *
 * The retry bound that already existed bounds ATTEMPTS and WAITS. It never
 * bounded a single attempt: a transport that accepts a request and then never
 * answers leaves the promise pending forever, so `poiesis update`, `poiesis
 * init`, and every tracker mutation hang with no error, no receipt, and no
 * bound at all. Two ceilings close that: every attempt is aborted through its
 * OWN `AbortSignal` after a fixed attempt deadline, and the operation as a
 * whole is refused once it has spent a fixed total budget.
 *
 * The classification follows what each mode can safely do next:
 *
 *   - a read changed nothing, so a timeout is retried like any other
 *     transient failure, and exhausting its budget is a typed refusal;
 *   - an idempotent create re-probes the identity it already used before any
 *     replay, so a lost answer resolves to the issue the first attempt made;
 *   - a non-idempotent mutation (a comment, an update, a close) is attempted
 *     exactly once and reported `LINEAR_MUTATION_UNCERTAIN`, because whether
 *     it landed is not observable from here and replaying it could double it.
 *
 * Every number below is asserted as a literal on purpose: the ceilings are the
 * guarantee, so a test that reads them out of the module would agree with any
 * value the module chose.
 */
describe("every Linear attempt is bounded by an abort signal and the whole operation is bounded", () => {
  const ATTEMPT_TIMEOUT_MS = 10_000;
  const OPERATION_DEADLINE_MS = 45_000;
  const CREDENTIAL = { LINEAR_API_KEY: "lin_api_secret" };

  it("gives every attempt its own abort signal and a scheduled attempt deadline", async () => {
    // Break: an attempt with no signal cannot be bounded at all, so a Linear
    // response that never arrives is an unbounded wait rather than a refusal.
    const script = new LinearScript({ kind: "graphql", data: { issue: issueNode() } });
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    await adapter.getSpec("ENG-1");

    const signal = script.requests[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // An answer that arrived inside the deadline is used, not discarded: the
    // signal is only a deadline, never a reason to fail a request that worked.
    expect(signal?.aborted).toBe(false);
    // A ceiling, not a hope: the attempt was scheduled to end in 10s.
    expect(seams.attemptTimeouts).toEqual([ATTEMPT_TIMEOUT_MS]);
  });

  it("aborts an attempt that never answers, retries the read, and refuses with a typed timeout", async () => {
    // Break: a read that hangs forever hangs the caller forever. Two hangs and
    // the retry-wait budget is spent, so the operation must fail as a typed
    // refusal rather than wait for an answer that is not coming.
    const script = new LinearScript(
      { kind: "hang" },
      { kind: "hang" },
      { kind: "hang" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const pending = settled(adapter.getSpec("ENG-1"));
    await drain();
    seams.advance(ATTEMPT_TIMEOUT_MS);
    await drain();
    seams.advance(ATTEMPT_TIMEOUT_MS);

    const result = await pending;
    expect(result.error).toMatchObject({
      code: "LINEAR_REQUEST_TIMEOUT",
      details: { attempts: 2, timeoutMs: ATTEMPT_TIMEOUT_MS },
    });
    // The third attempt never started, and the answer that was scripted for it
    // was never used: a timeout exhausts the budget, it does not buy more tries.
    expect(script.operations()).toEqual(["PoiesisIssue", "PoiesisIssue"]);
    // Each attempt was aborted through its own signal, and no signal was reused.
    const signals = script.requests.map((request) => request.signal);
    expect(new Set(signals).size).toBe(2);
    for (const signal of signals) expect(signal?.aborted).toBe(true);
    // A timed-out attempt backs off exactly like any other transient failure.
    expect(seams.sleeps).toEqual([500]);
  });

  it("recovers a read whose first attempt timed out", async () => {
    // Break: treating a timeout as fatal turns a slow Linear into a hard
    // failure even though the operation changed nothing and the next attempt
    // answers normally.
    const script = new LinearScript(
      { kind: "hang" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const pending = adapter.getSpec("ENG-1");
    await drain();
    seams.advance(ATTEMPT_TIMEOUT_MS);

    expect(await pending).toMatchObject({ id: "ENG-1" });
    expect(seams.sleeps).toEqual([500]);
    expect(script.requests[0]?.signal.aborted).toBe(true);
    expect(script.requests[1]?.signal.aborted).toBe(false);
  });

  it("refuses the whole operation when it has spent its total budget", async () => {
    // Break: the attempt ceiling bounds ONE attempt, not the operation. If the
    // first attempt consumed the entire budget — a stuck socket on a machine
    // that then spent the rest of it — starting attempt two anyway would make
    // the total unbounded in exactly the case it matters most.
    const script = new LinearScript(
      { kind: "hang" },
      { kind: "graphql", data: { issue: issueNode() } },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const pending = settled(adapter.getSpec("ENG-1"));
    await drain();
    // The attempt deadline fires, and the machine then spends the remainder of
    // the operation budget before Poiesis gets to decide what to do next.
    seams.advance(ATTEMPT_TIMEOUT_MS);
    seams.advance(OPERATION_DEADLINE_MS);

    const result = await pending;
    expect(result.error).toMatchObject({
      code: "LINEAR_REQUEST_TIMEOUT",
      details: { reason: "operation-deadline", deadlineMs: OPERATION_DEADLINE_MS },
    });
    // One request only: the budget was gone, so no second attempt was started.
    expect(script.requests).toHaveLength(1);
  });

  it("gives a non-idempotent mutation exactly one attempt and reports it uncertain", async () => {
    // Break: a comment whose answer never arrives may or may not have been
    // posted. Replaying it would double a supersede notice, and treating it as
    // a plain timeout would invite the caller to retry with a fresh identity —
    // so the mutation's own ambiguity is the thing reported.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      { kind: "hang" },
      { kind: "graphql", data: { commentCreate: { success: true, comment: { id: "c-2" } } } },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const pending = settled(adapter.commentSpec("ENG-1", "Superseded: replan"));
    await drain();
    seams.advance(ATTEMPT_TIMEOUT_MS);

    const result = await pending;
    expect(result.error).toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      details: { operation: "PoiesisCommentCreate", reason: "timeout" },
    });
    // Exactly one attempt: no retry, and the scripted third reply is untouched.
    expect(script.operations()).toEqual(["PoiesisIssue", "PoiesisCommentCreate"]);
  });

  it("re-probes the identity it already used before replaying a create that timed out", async () => {
    // Break: a create whose answer was lost is the one case where a replay is
    // safe, and it is safe ONLY because the identity is fixed. Replaying with
    // a fresh UUID files the same Poiesis Spec twice; replaying without the
    // probe would too, whenever the first attempt actually landed.
    const created = issueNode({ identifier: "ENG-1" });
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "hang" },
      { kind: "graphql", data: { issue: created } },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const pending = adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" });
    await drain();
    seams.advance(ATTEMPT_TIMEOUT_MS);

    // The probe answered, so the issue the timed-out attempt created is
    // returned instead of a second one.
    expect(await pending).toMatchObject({ id: "ENG-1" });
    expect(script.operations()).toEqual(["PoiesisTeams", "PoiesisIssueCreate", "PoiesisIssue"]);
    expect(seams.uuids).toHaveLength(1);
    expect(seams.uuids[0]).toBe((script.variablesOf(1).input as { id: string }).id);
    expect(script.variablesOf(2).id).toBe(seams.uuids[0]);
    // The create's own attempt really did time out — its signal was aborted —
    // and the probe that replaced the replay was itself a bounded read. Every
    // request in the flow carries a deadline, the team lookup included.
    expect(script.requests[1]?.signal.aborted).toBe(true);
    expect(script.requests[2]?.signal.aborted).toBe(false);
    expect(seams.attemptTimeouts).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
  });

  it("reports a create uncertain when the probe that must resolve it cannot answer", async () => {
    // Break: the probe is the only evidence that can distinguish "nothing was
    // created" from "the create landed and its answer was lost". If the probe
    // itself fails, the outcome is unknown, and letting the probe's own error
    // escape invites a caller to retry the create with a NEW identity — a
    // duplicate, filed on the strength of an unrelated read failure.
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "network" },
      { kind: "http", status: 400, body: "bad request" },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const error = await adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      // The refusal names WHY the ambiguity is unresolved, as a typed code from
      // Poiesis's own vocabulary — never the probe's echoed upstream text.
      details: { operation: "PoiesisIssueCreate", reason: "probe-failed", probeFailure: "LINEAR_HTTP_ERROR" },
    });
    // The create was attempted once and never replayed, under one identity.
    expect(script.operations()).toEqual(["PoiesisTeams", "PoiesisIssueCreate", "PoiesisIssue"]);
    expect(seams.uuids).toHaveLength(1);
  });

  it("bounds the create AND its idempotency probe by one operation budget", async () => {
    // Break: the probe is a nested operation, and a nested operation with a
    // FRESH budget makes a create's total twice its own deadline — 90s of
    // waiting for one Poiesis item — and a probe that RETRIES spends more
    // still. The probe asks exactly one question ("does this identity
    // exist?") inside the budget the create already has, and when it cannot
    // answer, the create's outcome is unknown: uncertain, never a plain
    // retryable timeout.
    //
    // The two spare hangs exist so a probe that retries shows up as EXTRA
    // requests, which the assertions below count, rather than as a script that
    // ran out of replies. A correct probe never reaches them.
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "hang" },
      { kind: "hang" },
      { kind: "hang" },
      { kind: "hang" },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const pending = settled(adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" }));
    await drain();
    seams.advance(ATTEMPT_TIMEOUT_MS);
    await drain();
    // The probe gets ONE bounded lookup, so a single further deadline is all
    // the create can be waiting on.
    seams.advance(ATTEMPT_TIMEOUT_MS);
    await drain();

    // Three deadlines total: the team lookup, the create's attempt, and the
    // probe's single lookup. A fourth is a probe that started retrying inside a
    // budget that was already spent.
    expect(seams.attemptTimeouts).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
    // The create was sent once. The probe READ the identity back; it never
    // issued a second create, under this identity or any other.
    expect(script.operations()).toEqual(["PoiesisTeams", "PoiesisIssueCreate", "PoiesisIssue"]);
    expect(seams.uuids).toHaveLength(1);

    const result = await pending;
    expect(result.error).toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      details: { operation: "PoiesisIssueCreate", reason: "probe-failed" },
    });
    // Never a plain retryable timeout: the create may have landed, and a
    // caller reading LINEAR_REQUEST_TIMEOUT would answer by creating again.
    expect((result.error as { code: string }).code).not.toBe("LINEAR_REQUEST_TIMEOUT");
    expect((result.error as Error).message).toContain("inspect the issue in Linear before retrying");
    // The whole flow stayed inside the ONE operation budget, not two.
    expect(seams.clock()).toBeLessThanOrEqual(OPERATION_DEADLINE_MS);
  });

  it("reports a create uncertain when the budget is gone after it was sent unconfirmed", async () => {
    // Break: the create reached Linear and no answer came back, so Poiesis does
    // not know whether the issue exists. A plain timeout tells the caller the
    // opposite — that nothing happened, so try again — and a caller that acts
    // on that files the same Poiesis Spec twice under a second identity. No
    // probe and no replay may start either: the budget is gone.
    const script = new LinearScript(
      { kind: "graphql", data: TEAM_PAGE([teamNode()], false) },
      { kind: "hang" },
      { kind: "hang" },
      { kind: "hang" },
    );
    const seams = seamsFor(script, CREDENTIAL);
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seams);

    const pending = settled(adapter.createSpec({ title: "Canonical intent", body: "Canonical decisions" }));
    await drain();
    // The attempt deadline fires while the operation is still parked on that
    // request, and the machine then spends the rest of the operation budget
    // before Poiesis gets to decide what happens next.
    seams.advance(ATTEMPT_TIMEOUT_MS);
    seams.advance(OPERATION_DEADLINE_MS);

    const result = await pending;
    expect(result.error).toMatchObject({
      code: "LINEAR_MUTATION_UNCERTAIN",
      details: { operation: "PoiesisIssueCreate" },
    });
    expect((result.error as { code: string }).code).not.toBe("LINEAR_REQUEST_TIMEOUT");
    // No probe, no replay, one identity: the budget was gone, so nothing else
    // was started.
    expect(script.operations()).toEqual(["PoiesisTeams", "PoiesisIssueCreate"]);
    expect(seams.attemptTimeouts).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
    expect(seams.uuids).toHaveLength(1);
  });

  it("bounds the production transport: fetch receives the attempt signal", async () => {
    // Break: the deadline is only real if it reaches the socket. A timer that
    // classifies an abort Poiesis never sends to `fetch` bounds nothing, and
    // this is the only test that exercises the transport Poiesis actually
    // ships rather than an injected one.
    const realFetch = globalThis.fetch;
    const seen: { signal: AbortSignal | undefined }[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      seen.push({ signal });
      return new Promise<Response>((_resolve, rejectOnAbort) => {
        signal?.addEventListener("abort", () => rejectOnAbort(new Error("aborted")));
      });
    }) as typeof globalThis.fetch;
    try {
      const virtual = deterministicSeams();
      const pending = settled(
        verifyLinearTrackerAuthorized({
          env: CREDENTIAL,
          clock: virtual.clock,
          sleep: virtual.sleep,
          uuid: virtual.uuid,
          timer: virtual.timer,
        }),
      );
      await drain();
      virtual.advance(ATTEMPT_TIMEOUT_MS);
      virtual.advance(OPERATION_DEADLINE_MS);

      const result = await pending;
      expect(result.error).toMatchObject({ code: "LINEAR_REQUEST_TIMEOUT" });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(seen[0]?.signal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// -- Cycle 5: supersede, close, and the reachable surfaces ------------------

describe("closing moves a Linear issue to the team's completed state", () => {
  it("resolves the team's completed workflow state and sets it", async () => {
    // Break: Linear has no "close" boolean, so closing must resolve the
    // team's completed state; hard-coding a state id would move a closed
    // item to a state Poiesis never verified exists in that team.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      { kind: "graphql", data: TEAM_STATES },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: issueNode({ state: { type: "completed" } }) } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const spec = await adapter.closeSpec("ENG-1");

    expect(script.operations()).toEqual(["PoiesisIssue", "PoiesisTeamStates", "PoiesisIssueUpdate"]);
    expect(script.variablesOf(2).input).toEqual({ stateId: "state-done" });
    expect(spec.state).toBe("closed");
  });

  it("refuses a team that reports more than one completed workflow state", async () => {
    // Break: picking one of two completed states would close the item into
    // a state whose semantics the Author never agreed to.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      {
        kind: "graphql",
        data: { team: { states: { nodes: [{ id: "state-done", type: "completed" }, { id: "state-done-2", type: "completed" }] } } },
      },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.closeSpec("ENG-1")).rejects.toMatchObject({ code: "LINEAR_COMPLETED_STATE_AMBIGUOUS" });
  });

  it("refuses a team that has no completed workflow state", async () => {
    // Break: reporting a close that moved nothing would claim a state change
    // Linear never made.
    const script = new LinearScript(
      { kind: "graphql", data: { issue: issueNode() } },
      { kind: "graphql", data: { team: { states: { nodes: [{ id: "state-todo", type: "unstarted" }] } } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await expect(adapter.closeSpec("ENG-1")).rejects.toMatchObject({ code: "LINEAR_COMPLETED_STATE_NOT_FOUND" });
  });
});

describe("supersede uses Poiesis metadata, a comment, and a close", () => {
  it("comments, records the reason in the metadata, and closes the item", async () => {
    // Break: supersession with no recorded reason leaves a Replan with no
    // durable trace of why the item was replaced.
    const ticket = issueNode({ identifier: "ENG-2", description: ticketDescription("ENG-1", "none", "Acceptance") });
    const script = new LinearScript(
      { kind: "graphql", data: { issue: ticket } },
      {
        kind: "graphql",
        data: { commentCreate: { success: true, comment: { id: "c-1", url: "https://linear.app/acme/issue/ENG-2#c-1" } } },
      },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: ticket } } },
      { kind: "graphql", data: TEAM_STATES },
      {
        kind: "graphql",
        data: {
          issueUpdate: {
            success: true,
            issue: issueNode({
              identifier: "ENG-2",
              description: supersededTicketDescription(
                "ENG-1",
                "none",
                "Acceptance",
                "Design evidence changed",
                ["ENG-3"],
              ),
              state: { type: "completed" },
            }),
          },
        },
      },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const superseded = await adapter.supersedeTicket("ENG-2", {
      reason: "Design evidence changed",
      replacementIds: ["ENG-3"],
    });

    expect(script.variablesOf(1).input).toEqual({ issueId: ticket.id, body: "Superseded: Design evidence changed\n\nReplaced by: ENG-3" });
    const written = (script.variablesOf(2).input as { description: string }).description;
    expect(JSON.parse(written.split("\n")[1] ?? "{}")).toMatchObject({
      kind: "ticket",
      parentSpecId: "ENG-1",
      supersededReason: "Design evidence changed",
      supersededBy: ["ENG-3"],
    });
    expect(superseded).toMatchObject({
      state: "superseded",
      parentSpecId: "ENG-1",
      supersededReason: "Design evidence changed",
      supersededBy: ["ENG-3"],
    });
  });

  it("records a replacement it never resolved instead of requiring it to exist", async () => {
    // Break: resolving the replacement would make supersession fail on a
    // Replan that names a ticket which does not exist yet, and would add a
    // read whose own failure is indistinguishable from the mutation's. Poiesis
    // records the reference exactly as the Author declared it, on every
    // provider, and the Local tracker keeps the same rule for a LOCAL id.
    const ticket = issueNode({ identifier: "ENG-2", description: ticketDescription("ENG-1", "none", "Acceptance") });
    const script = new LinearScript(
      { kind: "graphql", data: { issue: ticket } },
      { kind: "graphql", data: { commentCreate: { success: true, comment: { id: "c-1" } } } },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: ticket } } },
      { kind: "graphql", data: TEAM_STATES },
      {
        kind: "graphql",
        data: {
          issueUpdate: {
            success: true,
            issue: issueNode({
              identifier: "ENG-2",
              description: supersededTicketDescription("ENG-1", "none", "Acceptance", "Design evidence changed", [
                "ENG-404",
              ]),
              state: { type: "completed" },
            }),
          },
        },
      },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    const superseded = await adapter.supersedeTicket("ENG-2", {
      reason: "Design evidence changed",
      replacementIds: ["ENG-404"],
    });

    expect(superseded).toMatchObject({ state: "superseded", supersededBy: ["ENG-404"] });
    // No request ever looked the replacement up: a supersession costs exactly
    // the same five operations whether or not the replacement resolves.
    expect(script.operations()).toEqual([
      "PoiesisIssue",
      "PoiesisCommentCreate",
      "PoiesisIssueUpdate",
      "PoiesisTeamStates",
      "PoiesisIssueUpdate",
    ]);
    expect((script.variablesOf(2).input as { description: string }).description).toContain(
      '"supersededBy":["ENG-404"]',
    );
  });

  it("never fabricates a native Linear relation to express supersession", async () => {
    // Break: writing a Linear issue relation would assert a relationship the
    // Author never made. Poiesis expresses supersession in its own metadata,
    // a comment, and the completed state, and invents nothing else.
    const ticket = issueNode({ identifier: "ENG-2", description: ticketDescription("ENG-1", "none", "Acceptance") });
    const script = new LinearScript(
      { kind: "graphql", data: { issue: ticket } },
      { kind: "graphql", data: { commentCreate: { success: true, comment: { id: "c-1" } } } },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: ticket } } },
      { kind: "graphql", data: TEAM_STATES },
      { kind: "graphql", data: { issueUpdate: { success: true, issue: ticket } } },
    );
    const adapter = createLinearTrackerAdapter({ team: "ENG" }, seamsFor(script, { LINEAR_API_KEY: "lin_api_secret" }));

    await adapter.supersedeTicket("ENG-2", { reason: "Design evidence changed" });

    const mutations = script.operations().filter((operation) => operation.startsWith("Poiesis"));
    expect(mutations.some((operation) => /relation|parent|block|duplicate/i.test(operation))).toBe(false);
  });
});

describe("the Linear adapter is reachable from the shipped surfaces", () => {
  const repositories: TestRepository[] = [];
  let previousKey: string | undefined;
  let previousToken: string | undefined;

  beforeEach(() => {
    previousKey = process.env.LINEAR_API_KEY;
    previousToken = process.env.LINEAR_OAUTH_TOKEN;
    process.env.LINEAR_API_KEY = "lin_api_secret";
    delete process.env.LINEAR_OAUTH_TOKEN;
  });

  afterEach(async () => {
    setLinearTrackerSeamsForTest(null);
    if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousKey;
    if (previousToken === undefined) delete process.env.LINEAR_OAUTH_TOKEN;
    else process.env.LINEAR_OAUTH_TOKEN = previousToken;
    await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
  });

  it("resolves a linear tracker config to a real Linear adapter", async () => {
    // Break: leaving the ticket #140 fail-closed branch in place makes the
    // adapter unreachable through the only public factory.
    const repository = await createTestRepository();
    repositories.push(repository);

    const adapter = createTrackerAdapter({ provider: "linear", team: "ENG" }, repository.root);

    expect(adapter.provider).toBe("linear");
    expect(adapter.project).toBe("ENG");
  });

  it("refuses a linear tracker config with no team instead of guessing one", async () => {
    // Break: defaulting to a team would place a Spec in an unrelated team.
    const repository = await createTestRepository();
    repositories.push(repository);

    expect(() => createTrackerAdapter({ provider: "linear" }, repository.root)).toThrowError(
      expect.objectContaining({ code: "INVALID_TRACKER_CONFIG" }),
    );
  });

  it("proves the Linear authorization with the configured credential", async () => {
    // Break: reporting the tracker usable without contacting Linear would
    // claim an integration Poiesis never tested.
    const script = new LinearScript({ kind: "graphql", data: { viewer: { id: "user-uuid-1" } } });

    expect(await verifyLinearTrackerAuthorized({ transport: script.transport })).toBe("verified");
    expect(script.operations()).toEqual(["PoiesisViewer"]);
    expect(script.requests[0]?.headers.authorization).toBe("lin_api_secret");
  });

  it("verifyTracker reaches the Linear credential instead of a Git host CLI", async () => {
    // Break: a verifyTracker that kept its old fail-closed branch (or ran
    // `gh`/`glab`) would make `poiesis init` report a tracker Poiesis has no
    // way to reach.
    const repository = await createTestRepository();
    repositories.push(repository);
    delete process.env.LINEAR_API_KEY;
    const config: ResolvedPoiesisConfig = {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      repository: { remote: "origin", integrationBranch: "main" },
      tracker: { provider: "linear", team: "ENG" },
      delivery: { mode: "deferred" },
      verification: { commands: ["test -f README.md"] },
    };

    await expect(verifyTracker(repository.root, config)).rejects.toMatchObject({ code: "LINEAR_AUTH_MISSING" });
  });

  it("verifyTracker refuses a configured team that does not resolve", async () => {
    // Break: a viewer-only probe reports a mistyped team as healthy, so the
    // misconfiguration surfaces much later as an unexplained failure at the
    // first tracker mutation, in a different command, with a different
    // message. `doctor` is the operator's chance to catch it.
    const repository = await createTestRepository();
    repositories.push(repository);
    const config: ResolvedPoiesisConfig = {
      schema: 1,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      repository: { remote: "origin", integrationBranch: "main" },
      tracker: { provider: "linear", team: "TYPO" },
      delivery: { mode: "deferred" },
      verification: { commands: ["test -f README.md"] },
    };
    setLinearTrackerSeamsForTest({
      env: { LINEAR_API_KEY: "lin_api_secret" },
      transport: async (request) => {
        const operation = /^(?:query|mutation)\s+(\w+)/.exec(JSON.parse(request.body).query as string)?.[1] ?? "";
        const data =
          operation === "PoiesisViewer"
            ? { viewer: { id: "user-1" } }
            : TEAM_PAGE([{ id: "team-eng", key: "ENG", name: "Engineering" }]);
        return { status: 200, headers: {}, body: JSON.stringify({ data }) } satisfies LinearHttpResponse;
      },
    });

    await expect(verifyTracker(repository.root, config)).rejects.toMatchObject({
      code: "LINEAR_TEAM_NOT_FOUND",
      details: expect.objectContaining({ team: "TYPO" }),
    });
  });

  it("keeps the credential out of a failed coordinate verification", async () => {
    // Break: the coordinate probe is a NEW network path that echoes upstream
    // text, so it needs the same redaction guarantee as every other Linear
    // call — an echoed secret in a `doctor` report or an init error would
    // write the credential into operator-visible output. Both the refused-
    // credential body and a GraphQL error message that quotes the credential
    // are checked, because they reach the error by different routes.
    const refused = new LinearScript({ kind: "http", status: 401, body: "rejected credential lin_api_secret" });
    const quoted = new LinearScript({
      kind: "graphql",
      data: null,
      errors: [{ message: "bad Authorization: lin_oauth_secret" }],
    });

    for (const [script, env, secret] of [
      [refused, { LINEAR_API_KEY: "lin_api_secret" }, "lin_api_secret"],
      [quoted, { LINEAR_OAUTH_TOKEN: "lin_oauth_secret" }, "lin_oauth_secret"],
    ] as const) {
      const error = await verifyLinearTrackerConfigured(
        { team: "ENG" },
        { env, transport: script.transport },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PoiesisError);
      const serialized = JSON.stringify({
        message: (error as Error).message,
        details: (error as { details: unknown }).details,
      });
      expect(serialized).not.toContain(secret);
      // The GraphQL path DOES echo the credential upstream, so the redactor is
      // what removes it here — proving redaction rather than mere omission.
      if (script === quoted) expect(serialized).toContain("[redacted]");
    }
  });

  it("reports the team it resolved so a health check can name it", async () => {
    const script = new LinearScript(
      { kind: "graphql", data: { viewer: { id: "user-1" } } },
      { kind: "graphql", data: TEAM_PAGE([teamNode({ key: "ENG", name: "Engineering" })]) },
    );

    const verified = await verifyLinearTrackerConfigured(
      { team: "Engineering" },
      { env: { LINEAR_API_KEY: "lin_api_secret" }, transport: script.transport },
    );

    // A team configured by display NAME resolves to the team's own key, so a
    // report can show the operator the identity Poiesis will actually use.
    expect(verified.team.key).toBe("ENG");
    expect(verified.project).toBeUndefined();
    expect(script.operations()).toEqual(["PoiesisViewer", "PoiesisTeams"]);
  });
});

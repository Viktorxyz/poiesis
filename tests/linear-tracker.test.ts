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
import { verifyTracker } from "../src/maintenance.js";
import { createTestRepository, type TestRepository } from "./helpers.js";
import type { ResolvedPoiesisConfig } from "../src/config.js";
import {
  createLinearTrackerAdapter,
  verifyLinearTrackerAuthorized,
  type LinearHttpRequest,
  type LinearHttpResponse,
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
  | { readonly kind: "network" };

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
 * Deterministic clock / sleep / UUID seams. `sleep` advances the injected
 * clock by exactly the requested delay, so a test can assert the backoff
 * Poiesis asked for without waiting for it.
 */
function deterministicSeams(): ObservableSeams {
  const sleeps: number[] = [];
  const uuids: string[] = [];
  let now = 0;
  let sequence = 0;
  return {
    sleeps,
    uuids,
    clock: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    uuid: () => {
      sequence += 1;
      const uuid = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      uuids.push(uuid);
      return uuid;
    },
  };
}

/**
 * The seams plus the observation channels, so a test can assert the delays
 * Poiesis asked for and the identities it generated without waiting or
 * depending on a real random source.
 */
type ObservableSeams = LinearTrackerSeams & { readonly sleeps: number[]; readonly uuids: string[] };

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
});

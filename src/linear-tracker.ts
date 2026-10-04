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
}

export interface LinearHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type LinearTransport = (request: LinearHttpRequest) => Promise<LinearHttpResponse>;

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
  /** Monotonic millisecond clock, used to bound the retry budget. */
  readonly clock?: () => number;
  /** Injected delay, used for rate-limit backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected UUID source, so an idempotent create reuses one identity. */
  readonly uuid?: () => string;
}

export interface LinearTrackerConfig {
  readonly team: string;
  readonly project?: string;
}

interface ResolvedSeams {
  readonly env: Record<string, string | undefined>;
  readonly transport: LinearTransport;
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly uuid: () => string;
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
    sleep: seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    uuid: seams.uuid ?? (() => randomUUID()),
    authorization: resolveAuthorization(env),
  };
}

const defaultTransport: LinearTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.text() };
};

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

type LinearAttempt =
  | { readonly kind: "data"; readonly data: Record<string, unknown> }
  | { readonly kind: "rate-limited"; readonly status: number; readonly retryAfterMs: number }
  | { readonly kind: "server-error"; readonly status: number; readonly body: string }
  | { readonly kind: "transport"; readonly cause: string; readonly message: string }
  | { readonly kind: "rejected"; readonly error: PoiesisError };

/**
 * Send one request and classify the outcome, never throwing for a
 * condition the caller may be allowed to retry.
 */
async function attemptOnce(seams: ResolvedSeams, document: string, variables: Record<string, unknown>): Promise<LinearAttempt> {
  const operation = operationOf(document);
  const request: LinearHttpRequest = {
    url: LINEAR_GRAPHQL_ENDPOINT,
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: seams.authorization,
    },
    body: JSON.stringify({ query: document, variables }),
  };
  let response: LinearHttpResponse;
  try {
    response = await seams.transport(request);
  } catch (error) {
    return {
      kind: "transport",
      cause: error instanceof Error ? error.name : "unknown",
      message: redact(seams, error instanceof Error ? error.message : String(error)),
    };
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
      retryAfterMs: retryAfterMs(response.headers, LINEAR_DEFAULT_RETRY_DELAY_MS),
    };
  }
  if (response.status >= 500) {
    return { kind: "server-error", status: response.status, body: redact(seams, response.body) };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      kind: "rejected",
      error: new PoiesisError("LINEAR_HTTP_ERROR", `Linear request ${operation} failed with HTTP ${response.status}`, {
        operation,
        status: response.status,
        body: redact(seams, response.body),
      }),
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
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
        errors: payload.errors.map((entry) => ({
          message: redact(seams, 
            isRecord(entry) && typeof entry.message === "string" ? entry.message : String(entry),
          ),
          ...(isRecord(entry) && isRecord(entry.extensions) && typeof entry.extensions.code === "string"
            ? { code: entry.extensions.code }
            : {}),
        })),
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
 * Run an operation within the retry bound.
 *
 * `beforeRetry` is the idempotency anchor: an `idempotent` create passes a
 * probe that re-reads the identity it already used, so a lost response
 * resolves to the issue the first attempt created instead of a second one.
 */
async function executeWith(
  seams: ResolvedSeams,
  document: string,
  variables: Record<string, unknown>,
  mode: LinearCallMode,
  beforeRetry?: (attempt: number) => Promise<Record<string, unknown> | null>,
): Promise<Record<string, unknown>> {
  const operation = operationOf(document);
  const retryable = mode !== "mutation";
  const startedAt = seams.clock();
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1 && beforeRetry !== undefined) {
      const existing = await beforeRetry(attempt);
      if (existing !== null) return existing;
    }
    const outcome = await attemptOnce(seams, document, variables);
    if (outcome.kind === "data") return outcome.data;
    if (outcome.kind === "rejected") throw outcome.error;
    if (!retryable) throw uncertainMutation(operation, outcome);
    if (attempt >= LINEAR_MAX_ATTEMPTS) throw exhausted(operation, outcome, attempt);
    const delay = boundedDelay(outcome, seams.clock() - startedAt, attempt);
    if (delay === null) throw exhausted(operation, outcome, attempt);
    await seams.sleep(delay);
  }
}

/** The delay before the next attempt, or null when the budget is spent. */
function redact(seams: ResolvedSeams, value: string): string {
  const credential =
    readCredential(seams.env, LINEAR_API_KEY_VARIABLE) ??
    readCredential(seams.env, LINEAR_OAUTH_TOKEN_VARIABLE);
  return credential === null ? value : value.split(credential).join("[redacted]");
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

/** `Retry-After` as milliseconds, honoring both the seconds and date forms. */
function retryAfterMs(headers: Readonly<Record<string, string>>, fallbackMs: number): number {
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (raw === undefined) return fallbackMs;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw.trim());
  return Number.isNaN(at) ? fallbackMs : Math.max(0, at - Date.now());
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
    },
  );
}

function exhausted(operation: string, outcome: LinearAttempt, attempts: number): PoiesisError {
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
    });
  }
  return new PoiesisError("LINEAR_TRANSPORT_ERROR", `Linear request ${operation} could not be completed`, {
    operation,
    attempts,
    cause: outcome.kind === "transport" ? outcome.cause : "unknown",
    causeMessage: outcome.kind === "transport" ? outcome.message : undefined,
  });
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
   */
  private async probeCreatedIssue(uuid: string): Promise<Record<string, unknown> | null> {
    const node = await this.readIssueDirect(uuid);
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
    }, "idempotent", () => this.probeCreatedIssue(uuid));
    return readCreatedIssue(data, "issueCreate");
  }

  private async updateIssue(
    id: string,
    kind: TrackerItemKind,
    input: UpdateTrackerItemInput,
  ): Promise<LinearIssueNode> {
    const node = await this.readIssue(id);
    const current = assertKind(this.toItem(node), kind);
    const metadata = metadataFromItem(current);
    if (kind === "ticket") {
      const dependencies = (input as UpdateTicketInput).dependencyText;
      metadata.dependencyText = dependencies ?? current.dependencyText ?? "";
    }
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
    beforeRetry?: (attempt: number) => Promise<Record<string, unknown> | null>,
  ): Promise<Record<string, unknown>> {
    return executeWith(this.#seams, document, variables, mode, beforeRetry);
  }

  private redact(value: string): string {
    return redact(this.#seams, value);
  }

  /** One direct `issue(id:)` lookup, with no identifier scan behind it. */
  private async readIssueDirect(id: string): Promise<LinearIssueNode | null> {
    const data = await this.execute(ISSUE_QUERY, { id }, "read");
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
    const wanted = this.team.toLowerCase();
    const matches: LinearTeamNode[] = [];
    for await (const nodes of this.paginate(TEAM_QUERY, "teams", {})) {
      for (const node of nodes) {
        const team = readTeamNode(node, "PoiesisTeams");
        if (team.key.toLowerCase() === wanted || team.name.toLowerCase() === wanted) matches.push(team);
      }
    }
    if (matches.length === 0) {
      throw new PoiesisError(
        "LINEAR_TEAM_NOT_FOUND",
        `No Linear team matches the configured tracker.team; check the team key or name`,
        { team: this.team },
      );
    }
    if (matches.length > 1) {
      throw new PoiesisError(
        "LINEAR_TEAM_AMBIGUOUS",
        `The configured tracker.team matches ${matches.length} Linear teams; Poiesis will not guess which team owns this work`,
        { team: this.team, matches: matches.map((match) => `${match.key} (${match.id})`) },
      );
    }
    return (matches[0] as LinearTeamNode).id;
  }

  private async resolveProjectId(): Promise<string | undefined> {
    if (this.linearProject === undefined) return undefined;
    const name = this.linearProject;
    const matches: LinearProjectNode[] = [];
    for await (const nodes of this.paginate(PROJECT_QUERY, "projects", { name })) {
      for (const node of nodes) matches.push(readProjectNode(node, "PoiesisProjects"));
    }
    if (matches.length === 0) {
      throw new PoiesisError(
        "LINEAR_PROJECT_NOT_FOUND",
        `No Linear project matches the configured tracker.project`,
        { project: name },
      );
    }
    if (matches.length > 1) {
      throw new PoiesisError(
        "LINEAR_PROJECT_AMBIGUOUS",
        `The configured tracker.project matches ${matches.length} Linear projects; Poiesis will not guess which project owns this work`,
        { project: name, matches: matches.map((match) => match.id) },
      );
    }
    return (matches[0] as LinearProjectNode).id;
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
    let after: string | null = null;
    for (let page = 0; page < LINEAR_MAX_PAGES; page += 1) {
      const data = await this.execute(document, { first: LINEAR_PAGE_SIZE, after, ...extraVariables }, "read");
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

import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PoiesisConfig } from "./config.js";
import { PoiesisError, invariant } from "./errors.js";
import { atomicWrite, exists, readUtf8 } from "./fs.js";
import { run } from "./process.js";
import {
  validateIntegrationEvidence,
  validateProductionAuthorization,
  validateProofEvidence,
  validateStagingEvidence,
  type IntegrationEvidence,
  type ProductionAuthorization,
  type ProofEvidence,
  type StagingEvidence,
} from "./evidence.js";

export type TrackerProvider = "github" | "gitlab" | "fixture";
export type TrackerItemKind = "spec" | "ticket";
export type TrackerItemState = "open" | "closed" | "superseded";

export interface TrackerConfig {
  provider: TrackerProvider;
  project: string;
}

export interface TrackerItem {
  id: string;
  kind: TrackerItemKind;
  title: string;
  body: string;
  state: TrackerItemState;
  url: string;
  parentSpecId?: string;
  dependencyText?: string;
  supersededBy?: string[];
  supersededReason?: string;
}

export interface TrackerComment {
  id: string;
  itemId: string;
  body: string;
  url?: string;
}

export interface CreateSpecInput {
  title: string;
  body: string;
}

export interface CreateTicketInput extends CreateSpecInput {
  parentSpecId: string;
  dependencyText: string;
}

export interface UpdateTrackerItemInput {
  title?: string;
  body?: string;
}

export interface UpdateTicketInput extends UpdateTrackerItemInput {
  dependencyText?: string;
}

export interface SupersedeInput {
  reason: string;
  replacementIds?: string[];
}

export interface TrackerAdapter {
  readonly provider: TrackerProvider;
  readonly project: string;
  createSpec(input: CreateSpecInput): Promise<TrackerItem>;
  getSpec(id: string): Promise<TrackerItem>;
  updateSpec(id: string, input: UpdateTrackerItemInput): Promise<TrackerItem>;
  commentSpec(id: string, body: string): Promise<TrackerComment>;
  closeSpec(id: string): Promise<TrackerItem>;
  supersedeSpec(id: string, input: SupersedeInput): Promise<TrackerItem>;
  createTicket(input: CreateTicketInput): Promise<TrackerItem>;
  getTicket(id: string): Promise<TrackerItem>;
  updateTicket(id: string, input: UpdateTicketInput): Promise<TrackerItem>;
  commentTicket(id: string, body: string): Promise<TrackerComment>;
  closeTicket(id: string): Promise<TrackerItem>;
  supersedeTicket(id: string, input: SupersedeInput): Promise<TrackerItem>;
}

interface TrackerMetadata {
  kind: TrackerItemKind;
  parentSpecId?: string;
  dependencyText?: string;
  supersededReason?: string;
  supersededBy?: string[];
}

const METADATA_START = "<!-- poiesis:tracker\n";
const METADATA_END = "\npoiesis:tracker -->\n\n";

function requiredText(value: string, name: string): string {
  invariant(value.trim().length > 0, "INVALID_ADAPTER_INPUT", `${name} must not be empty`, { name });
  return value;
}

function decorateBody(body: string, metadata: TrackerMetadata): string {
  return `${METADATA_START}${JSON.stringify(metadata)}${METADATA_END}${relationshipText(metadata)}${body}`;
}

function parseBody(value: string): { body: string; metadata: TrackerMetadata } {
  if (!value.startsWith(METADATA_START)) {
    throw new PoiesisError("INVALID_TRACKER_ITEM", "Tracker item is not managed by Poiesis");
  }
  const end = value.indexOf(METADATA_END, METADATA_START.length);
  if (end < 0) throw new PoiesisError("INVALID_TRACKER_ITEM", "Tracker item metadata is incomplete");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(METADATA_START.length, end));
  } catch (error) {
    throw new PoiesisError("INVALID_TRACKER_ITEM", "Tracker item metadata is invalid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  invariant(isRecord(parsed), "INVALID_TRACKER_ITEM", "Tracker item metadata must be an object");
  invariant(parsed.kind === "spec" || parsed.kind === "ticket", "INVALID_TRACKER_ITEM", "Unknown tracker item kind");
  const metadata: TrackerMetadata = { kind: parsed.kind };
  if (typeof parsed.parentSpecId === "string") metadata.parentSpecId = parsed.parentSpecId;
  if (typeof parsed.dependencyText === "string") metadata.dependencyText = parsed.dependencyText;
  if (typeof parsed.supersededReason === "string") metadata.supersededReason = parsed.supersededReason;
  if (Array.isArray(parsed.supersededBy) && parsed.supersededBy.every((entry) => typeof entry === "string")) {
    metadata.supersededBy = parsed.supersededBy;
  }
  const remainder = value.slice(end + METADATA_END.length);
  const relationships = relationshipText(metadata);
  invariant(remainder.startsWith(relationships), "INVALID_TRACKER_ITEM", "Tracker relationship text is incomplete");
  return { body: remainder.slice(relationships.length), metadata };
}

function relationshipText(metadata: TrackerMetadata): string {
  const lines = [`**Poiesis ${metadata.kind === "spec" ? "Spec" : "Ticket"}**`];
  if (metadata.parentSpecId !== undefined) lines.push(`Parent Spec: ${metadata.parentSpecId}`);
  if (metadata.dependencyText !== undefined) lines.push(`Dependencies:\n${metadata.dependencyText}`);
  if (metadata.supersededReason !== undefined) lines.push(`Superseded: ${metadata.supersededReason}`);
  if (metadata.supersededBy !== undefined && metadata.supersededBy.length > 0) {
    lines.push(`Replaced by: ${metadata.supersededBy.join(", ")}`);
  }
  return `${lines.join("\n\n")}\n\n---\n\n`;
}

function trackerItem(
  raw: { id: string; title: string; body: string; state: string; url: string },
): TrackerItem {
  const parsed = parseBody(raw.body);
  const supersessionReason = parsed.metadata.supersededReason?.trim();
  const superseded = supersessionReason !== undefined && supersessionReason.length > 0;
  const normalizedState = raw.state.trim().toLowerCase();
  const openStates = new Set(["open", "opened", "reopened"]);
  return {
    id: raw.id,
    kind: parsed.metadata.kind,
    title: raw.title,
    body: parsed.body,
    state: superseded ? "superseded" : openStates.has(normalizedState) ? "open" : "closed",
    url: raw.url,
    ...(parsed.metadata.parentSpecId === undefined ? {} : { parentSpecId: parsed.metadata.parentSpecId }),
    ...(parsed.metadata.dependencyText === undefined ? {} : { dependencyText: parsed.metadata.dependencyText }),
    ...(parsed.metadata.supersededBy === undefined ? {} : { supersededBy: [...parsed.metadata.supersededBy] }),
    ...(supersessionReason === undefined || supersessionReason.length === 0
      ? {}
      : { supersededReason: supersessionReason }),
  };
}

function assertKind(item: TrackerItem, kind: TrackerItemKind): TrackerItem {
  invariant(item.kind === kind, "TRACKER_ITEM_KIND_MISMATCH", `Tracker item ${item.id} is not a ${kind}`, {
    id: item.id,
    expected: kind,
    actual: item.kind,
  });
  return item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(stdout: string, command: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new PoiesisError("INVALID_COMMAND_OUTPUT", `${command} did not return JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  invariant(isRecord(value), "INVALID_COMMAND_OUTPUT", `${command} JSON output must be an object`);
  return value;
}

abstract class CliTrackerAdapter implements TrackerAdapter {
  abstract readonly provider: "github" | "gitlab";

  constructor(
    readonly project: string,
    protected readonly cwd: string,
  ) {}

  protected abstract createIssue(title: string, body: string): Promise<TrackerItem>;
  protected abstract getIssue(id: string): Promise<TrackerItem>;
  protected abstract updateIssue(id: string, title: string, body: string): Promise<TrackerItem>;
  protected abstract addComment(id: string, body: string): Promise<TrackerComment>;
  protected abstract closeIssue(id: string): Promise<TrackerItem>;

  createSpec(input: CreateSpecInput): Promise<TrackerItem> {
    return this.createIssue(
      requiredText(input.title, "title"),
      decorateBody(input.body, { kind: "spec" }),
    );
  }

  async getSpec(id: string): Promise<TrackerItem> {
    return assertKind(await this.getIssue(requiredText(id, "id")), "spec");
  }

  async updateSpec(id: string, input: UpdateTrackerItemInput): Promise<TrackerItem> {
    const current = await this.getSpec(id);
    return this.updateIssue(
      current.id,
      input.title === undefined ? current.title : requiredText(input.title, "title"),
      decorateBody(input.body ?? current.body, metadataFromItem(current)),
    );
  }

  async commentSpec(id: string, body: string): Promise<TrackerComment> {
    const item = await this.getSpec(id);
    return this.addComment(item.id, requiredText(body, "comment body"));
  }

  async closeSpec(id: string): Promise<TrackerItem> {
    const item = await this.getSpec(id);
    return this.closeIssue(item.id);
  }

  supersedeSpec(id: string, input: SupersedeInput): Promise<TrackerItem> {
    return this.supersede(id, "spec", input);
  }

  async createTicket(input: CreateTicketInput): Promise<TrackerItem> {
    await this.getSpec(requiredText(input.parentSpecId, "parentSpecId"));
    const metadata: TrackerMetadata = {
      kind: "ticket",
      parentSpecId: input.parentSpecId,
      dependencyText: requiredText(input.dependencyText, "dependencyText"),
    };
    return this.createIssue(requiredText(input.title, "title"), decorateBody(input.body, metadata));
  }

  async getTicket(id: string): Promise<TrackerItem> {
    return assertKind(await this.getIssue(requiredText(id, "id")), "ticket");
  }

  async updateTicket(id: string, input: UpdateTicketInput): Promise<TrackerItem> {
    const current = await this.getTicket(id);
    const metadata = metadataFromItem(current);
    metadata.dependencyText = input.dependencyText ?? current.dependencyText ?? "";
    return this.updateIssue(
      current.id,
      input.title === undefined ? current.title : requiredText(input.title, "title"),
      decorateBody(input.body ?? current.body, metadata),
    );
  }

  async commentTicket(id: string, body: string): Promise<TrackerComment> {
    const item = await this.getTicket(id);
    return this.addComment(item.id, requiredText(body, "comment body"));
  }

  async closeTicket(id: string): Promise<TrackerItem> {
    const item = await this.getTicket(id);
    return this.closeIssue(item.id);
  }

  supersedeTicket(id: string, input: SupersedeInput): Promise<TrackerItem> {
    return this.supersede(id, "ticket", input);
  }

  private async supersede(id: string, kind: TrackerItemKind, input: SupersedeInput): Promise<TrackerItem> {
    const reason = requiredText(input.reason, "supersede reason");
    const current = assertKind(await this.getIssue(requiredText(id, "id")), kind);
    const replacementIds = [...(input.replacementIds ?? [])];
    await this.addComment(
      current.id,
      `Superseded: ${reason}${replacementIds.length === 0 ? "" : `\n\nReplaced by: ${replacementIds.join(", ")}`}`,
    );
    const metadata = metadataFromItem(current);
    metadata.supersededReason = reason;
    metadata.supersededBy = replacementIds;
    await this.updateIssue(current.id, current.title, decorateBody(current.body, metadata));
    return this.closeIssue(current.id);
  }
}

function metadataFromItem(item: TrackerItem): TrackerMetadata {
  return {
    kind: item.kind,
    ...(item.parentSpecId === undefined ? {} : { parentSpecId: item.parentSpecId }),
    ...(item.dependencyText === undefined ? {} : { dependencyText: item.dependencyText }),
    ...(item.supersededReason === undefined ? {} : { supersededReason: item.supersededReason }),
    ...(item.supersededBy === undefined ? {} : { supersededBy: [...item.supersededBy] }),
  };
}

class GitHubTrackerAdapter extends CliTrackerAdapter {
  readonly provider = "github" as const;
  private readonly endpoint: string;

  constructor(project: string, cwd: string) {
    super(project, cwd);
    const parts = project.split("/");
    invariant(parts.length === 2 && parts.every(Boolean), "INVALID_TRACKER_CONFIG", "GitHub project must be owner/repository", {
      project,
    });
    this.endpoint = `repos/${parts[0]}/${parts[1]}/issues`;
  }

  protected async createIssue(title: string, body: string): Promise<TrackerItem> {
    return githubItem(await this.api("POST", this.endpoint, { title, body }));
  }

  protected async getIssue(id: string): Promise<TrackerItem> {
    return githubItem(await this.api("GET", `${this.endpoint}/${encodeURIComponent(id)}`));
  }

  protected async updateIssue(id: string, title: string, body: string): Promise<TrackerItem> {
    return githubItem(await this.api("PATCH", `${this.endpoint}/${encodeURIComponent(id)}`, { title, body }));
  }

  protected async addComment(id: string, body: string): Promise<TrackerComment> {
    const value = await this.api("POST", `${this.endpoint}/${encodeURIComponent(id)}/comments`, { body });
    invariant(typeof value.id === "number" || typeof value.id === "string", "INVALID_COMMAND_OUTPUT", "GitHub comment has no id");
    return {
      id: String(value.id),
      itemId: id,
      body,
      ...(typeof value.html_url === "string" ? { url: value.html_url } : {}),
    };
  }

  protected async closeIssue(id: string): Promise<TrackerItem> {
    return githubItem(await this.api("PATCH", `${this.endpoint}/${encodeURIComponent(id)}`, { state: "closed" }));
  }

  private async api(method: string, endpoint: string, fields: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const args = ["api", "--method", method, endpoint];
    for (const [name, value] of Object.entries(fields)) args.push("--raw-field", `${name}=${value}`);
    const result = await run("gh", args, { cwd: this.cwd });
    return jsonObject(result.stdout, "gh");
  }
}

function githubItem(value: Record<string, unknown>): TrackerItem {
  invariant(typeof value.number === "number", "INVALID_COMMAND_OUTPUT", "GitHub issue has no number");
  invariant(typeof value.title === "string", "INVALID_COMMAND_OUTPUT", "GitHub issue has no title");
  invariant(typeof value.body === "string", "INVALID_COMMAND_OUTPUT", "GitHub issue has no body");
  invariant(typeof value.state === "string", "INVALID_COMMAND_OUTPUT", "GitHub issue has no state");
  invariant(typeof value.html_url === "string", "INVALID_COMMAND_OUTPUT", "GitHub issue has no URL");
  return trackerItem({
    id: String(value.number),
    title: value.title,
    body: value.body,
    state: value.state,
    url: value.html_url,
  });
}

class GitLabTrackerAdapter extends CliTrackerAdapter {
  readonly provider = "gitlab" as const;
  private readonly endpoint: string;

  constructor(project: string, cwd: string) {
    super(project, cwd);
    this.endpoint = `projects/${encodeURIComponent(requiredText(project, "tracker project"))}/issues`;
  }

  protected async createIssue(title: string, body: string): Promise<TrackerItem> {
    return gitlabItem(await this.api("POST", this.endpoint, { title, description: body }));
  }

  protected async getIssue(id: string): Promise<TrackerItem> {
    return gitlabItem(await this.api("GET", `${this.endpoint}/${encodeURIComponent(id)}`));
  }

  protected async updateIssue(id: string, title: string, body: string): Promise<TrackerItem> {
    return gitlabItem(
      await this.api("PUT", `${this.endpoint}/${encodeURIComponent(id)}`, { title, description: body }),
    );
  }

  protected async addComment(id: string, body: string): Promise<TrackerComment> {
    const value = await this.api("POST", `${this.endpoint}/${encodeURIComponent(id)}/notes`, { body });
    invariant(typeof value.id === "number" || typeof value.id === "string", "INVALID_COMMAND_OUTPUT", "GitLab note has no id");
    return {
      id: String(value.id),
      itemId: id,
      body,
      ...(typeof value.web_url === "string" ? { url: value.web_url } : {}),
    };
  }

  protected async closeIssue(id: string): Promise<TrackerItem> {
    return gitlabItem(await this.api("PUT", `${this.endpoint}/${encodeURIComponent(id)}`, { state_event: "close" }));
  }

  private async api(method: string, endpoint: string, fields: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const args = ["api", "--method", method, endpoint];
    for (const [name, value] of Object.entries(fields)) args.push("--raw-field", `${name}=${value}`);
    const result = await run("glab", args, { cwd: this.cwd });
    return jsonObject(result.stdout, "glab");
  }
}

function gitlabItem(value: Record<string, unknown>): TrackerItem {
  invariant(typeof value.iid === "number", "INVALID_COMMAND_OUTPUT", "GitLab issue has no iid");
  invariant(typeof value.title === "string", "INVALID_COMMAND_OUTPUT", "GitLab issue has no title");
  invariant(typeof value.description === "string", "INVALID_COMMAND_OUTPUT", "GitLab issue has no description");
  invariant(typeof value.state === "string", "INVALID_COMMAND_OUTPUT", "GitLab issue has no state");
  invariant(typeof value.web_url === "string", "INVALID_COMMAND_OUTPUT", "GitLab issue has no URL");
  return trackerItem({
    id: String(value.iid),
    title: value.title,
    body: value.description,
    state: value.state,
    url: value.web_url,
  });
}

interface FixtureHistoryEntry {
  operation: "create" | "update" | "comment" | "close" | "supersede";
  at: string;
  body?: string;
  snapshot: TrackerItem;
}

interface FixtureItemRecord {
  item: TrackerItem;
  comments: TrackerComment[];
  history: FixtureHistoryEntry[];
}

interface FixtureTrackerStore {
  schema: 1;
  provider: "fixture-test-only";
  nextId: number;
  items: Record<string, FixtureItemRecord>;
}

export const FIXTURE_TRACKER_FILENAME = "poiesis-tracker-fixture.json";

class FixtureTrackerAdapter implements TrackerAdapter {
  readonly provider = "fixture" as const;
  readonly project: string;
  private readonly storePath: string;
  private pendingMutation: Promise<void> = Promise.resolve();

  constructor(project: string, root: string) {
    this.project = resolveConfiguredPath(root, project);
    assertExternalFixturePath(root, this.project, "tracker");
    this.storePath = resolve(this.project, FIXTURE_TRACKER_FILENAME);
  }

  createSpec(input: CreateSpecInput): Promise<TrackerItem> {
    return this.create("spec", input);
  }

  async getSpec(id: string): Promise<TrackerItem> {
    return assertKind(await this.get(id), "spec");
  }

  updateSpec(id: string, input: UpdateTrackerItemInput): Promise<TrackerItem> {
    return this.update(id, "spec", input);
  }

  async commentSpec(id: string, body: string): Promise<TrackerComment> {
    await this.getSpec(id);
    return this.comment(id, body);
  }

  async closeSpec(id: string): Promise<TrackerItem> {
    await this.getSpec(id);
    return this.close(id);
  }

  async supersedeSpec(id: string, input: SupersedeInput): Promise<TrackerItem> {
    await this.getSpec(id);
    return this.supersede(id, input);
  }

  async createTicket(input: CreateTicketInput): Promise<TrackerItem> {
    await this.getSpec(requiredText(input.parentSpecId, "parentSpecId"));
    requiredText(input.dependencyText, "dependencyText");
    return this.create("ticket", input);
  }

  async getTicket(id: string): Promise<TrackerItem> {
    return assertKind(await this.get(id), "ticket");
  }

  updateTicket(id: string, input: UpdateTicketInput): Promise<TrackerItem> {
    return this.update(id, "ticket", input);
  }

  async commentTicket(id: string, body: string): Promise<TrackerComment> {
    await this.getTicket(id);
    return this.comment(id, body);
  }

  async closeTicket(id: string): Promise<TrackerItem> {
    await this.getTicket(id);
    return this.close(id);
  }

  async supersedeTicket(id: string, input: SupersedeInput): Promise<TrackerItem> {
    await this.getTicket(id);
    return this.supersede(id, input);
  }

  private async create(kind: TrackerItemKind, input: CreateSpecInput | CreateTicketInput): Promise<TrackerItem> {
    return this.mutate((store) => {
      const id = String(store.nextId++);
      const ticket = kind === "ticket" ? (input as CreateTicketInput) : undefined;
      const item: TrackerItem = {
        id,
        kind,
        title: requiredText(input.title, "title"),
        body: input.body,
        state: "open",
        url: `${pathToFileURL(this.storePath).href}#item-${id}`,
        ...(ticket === undefined ? {} : { parentSpecId: ticket.parentSpecId, dependencyText: ticket.dependencyText }),
      };
      store.items[id] = {
        item,
        comments: [],
        history: [{ operation: "create", at: new Date().toISOString(), snapshot: structuredClone(item) }],
      };
      return structuredClone(item);
    });
  }

  private async get(id: string): Promise<TrackerItem> {
    await this.pendingMutation;
    const store = await this.readStore();
    const record = store.items[requiredText(id, "id")];
    if (!record) throw new PoiesisError("TRACKER_ITEM_NOT_FOUND", `Fixture tracker item ${id} was not found`, { id });
    return structuredClone(record.item);
  }

  private update(id: string, kind: TrackerItemKind, input: UpdateTicketInput): Promise<TrackerItem> {
    return this.mutate((store) => {
      const record = fixtureRecord(store, id, kind);
      if (input.title !== undefined) record.item.title = requiredText(input.title, "title");
      if (input.body !== undefined) record.item.body = input.body;
      if (kind === "ticket" && input.dependencyText !== undefined) record.item.dependencyText = input.dependencyText;
      record.history.push({ operation: "update", at: new Date().toISOString(), snapshot: structuredClone(record.item) });
      return structuredClone(record.item);
    });
  }

  private comment(id: string, body: string): Promise<TrackerComment> {
    return this.mutate((store) => {
      const record = fixtureRecord(store, id);
      const commentNumber = record.comments.length + 1;
      const comment: TrackerComment = {
        id: `${id}:comment:${commentNumber}`,
        itemId: id,
        body: requiredText(body, "comment body"),
        url: `${record.item.url}-comment-${commentNumber}`,
      };
      record.comments.push(comment);
      record.history.push({
        operation: "comment",
        at: new Date().toISOString(),
        body: comment.body,
        snapshot: structuredClone(record.item),
      });
      return structuredClone(comment);
    });
  }

  private close(id: string): Promise<TrackerItem> {
    return this.mutate((store) => {
      const record = fixtureRecord(store, id);
      if (record.item.state !== "superseded") record.item.state = "closed";
      record.history.push({ operation: "close", at: new Date().toISOString(), snapshot: structuredClone(record.item) });
      return structuredClone(record.item);
    });
  }

  private supersede(id: string, input: SupersedeInput): Promise<TrackerItem> {
    return this.mutate((store) => {
      const record = fixtureRecord(store, id);
      const reason = requiredText(input.reason, "supersede reason");
      record.item.state = "superseded";
      record.item.supersededReason = reason;
      record.item.supersededBy = [...(input.replacementIds ?? [])];
      const comment: TrackerComment = {
        id: `${id}:comment:${record.comments.length + 1}`,
        itemId: id,
        body: `Superseded: ${reason}${record.item.supersededBy.length === 0 ? "" : `\n\nReplaced by: ${record.item.supersededBy.join(", ")}`}`,
      };
      record.comments.push(comment);
      record.history.push({
        operation: "supersede",
        at: new Date().toISOString(),
        body: comment.body,
        snapshot: structuredClone(record.item),
      });
      return structuredClone(record.item);
    });
  }

  private async readStore(): Promise<FixtureTrackerStore> {
    if (!(await exists(this.storePath))) {
      return { schema: 1, provider: "fixture-test-only", nextId: 1, items: {} };
    }
    let value: unknown;
    try {
      value = JSON.parse(await readUtf8(this.storePath));
    } catch (error) {
      throw new PoiesisError("INVALID_FIXTURE", `Invalid tracker fixture at ${this.storePath}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    invariant(
      isRecord(value) && value.schema === 1 && value.provider === "fixture-test-only" && isRecord(value.items),
      "INVALID_FIXTURE",
      `Invalid tracker fixture at ${this.storePath}`,
    );
    return value as unknown as FixtureTrackerStore;
  }

  private mutate<T>(operation: (store: FixtureTrackerStore) => T): Promise<T> {
    const result = this.pendingMutation.then(async () => {
      const store = await this.readStore();
      const value = operation(store);
      await atomicWrite(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
      return value;
    });
    this.pendingMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function fixtureRecord(store: FixtureTrackerStore, id: string, kind?: TrackerItemKind): FixtureItemRecord {
  const normalized = requiredText(id, "id");
  const record = store.items[normalized];
  if (!record) throw new PoiesisError("TRACKER_ITEM_NOT_FOUND", `Fixture tracker item ${id} was not found`, { id });
  if (kind !== undefined) assertKind(record.item, kind);
  return record;
}

export function createTrackerAdapter(
  config: TrackerConfig | PoiesisConfig["tracker"],
  root = process.cwd(),
): TrackerAdapter {
  const project = config.project ?? "";
  requiredText(project, "tracker project");
  switch (config.provider) {
    case "github":
      return new GitHubTrackerAdapter(project, root);
    case "gitlab":
      return new GitLabTrackerAdapter(project, root);
    case "fixture":
      return new FixtureTrackerAdapter(project, root);
  }
}

export function createGitHubTrackerAdapter(project: string, cwd = process.cwd()): TrackerAdapter {
  return new GitHubTrackerAdapter(requiredText(project, "tracker project"), cwd);
}

export function createGitLabTrackerAdapter(project: string, cwd = process.cwd()): TrackerAdapter {
  return new GitLabTrackerAdapter(requiredText(project, "tracker project"), cwd);
}

export function createFixtureTrackerAdapter(projectPath: string, root = process.cwd()): TrackerAdapter {
  return new FixtureTrackerAdapter(requiredText(projectPath, "tracker project path"), root);
}

export type DeliveryTarget = "preview" | "staging" | "production";

export interface DeliveryIdentity {
  sha: string;
  candidateSha: string;
  candidateTree: string;
  target: DeliveryTarget;
  artifactIdentity: string;
  verified: true;
  id?: string;
  url?: string;
  artifact?: string;
}

export interface DeliveryResult extends DeliveryIdentity {
  status: string;
}

export type PreviewDeliveryResult = DeliveryResult & { target: "preview" };
export type StagingDeliveryResult = DeliveryResult & StagingEvidence;
export type ProductionDeliveryResult = DeliveryResult & { target: "production" };

export type ProofPayload = ProofEvidence;

export type StagingPayload = StagingEvidence;

export interface PreviewDeliveryInput {
  sha: string;
  candidateTree: string;
  proof: ProofPayload;
}

export interface StagingPromotionInput {
  sha: string;
  target: "staging";
  candidateTree: string;
  identity: DeliveryIdentity;
}

export interface ProductionPromotionInput {
  sha: string;
  target: "production";
  candidateTree: string;
  identity: DeliveryIdentity;
  productionAuthorization: ProductionAuthorization;
  integrationRemote: string;
  integrationBranch: string;
  proof: ProofPayload;
  integration: IntegrationEvidence;
}

export type PromoteDeliveryInput = StagingPromotionInput | ProductionPromotionInput;

export interface DeliveryAdapter {
  readonly kind: "command" | "fixture";
  preview(input: PreviewDeliveryInput): Promise<PreviewDeliveryResult>;
  promote(input: StagingPromotionInput): Promise<StagingDeliveryResult>;
  promote(input: ProductionPromotionInput): Promise<ProductionDeliveryResult>;
}

export interface CommandDeliveryConfig {
  adapter: "command";
  command?: readonly string[];
  argv?: readonly string[];
  executable?: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface FixtureDeliveryConfig {
  adapter: "fixture";
  path: string;
}

export type DeliveryAdapterConfig = CommandDeliveryConfig | FixtureDeliveryConfig;
export type ConfiguredDeliveryTarget = PoiesisConfig["delivery"][DeliveryTarget];

class CommandDeliveryAdapter implements DeliveryAdapter {
  readonly kind = "command" as const;
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly cwd: string;
  private readonly env: Record<string, string> | undefined;

  constructor(config: CommandDeliveryConfig, root: string) {
    const argv = config.command ?? config.argv;
    const usesArgv = argv !== undefined;
    const usesExecutable = config.executable !== undefined;
    invariant(usesArgv !== usesExecutable, "INVALID_DELIVERY_CONFIG", "Configure command argv or executable+args, not both");
    if (argv !== undefined) {
      invariant(argv.length > 0, "INVALID_DELIVERY_CONFIG", "Delivery command argv must not be empty");
      invariant(argv.every((entry) => typeof entry === "string" && entry.length > 0), "INVALID_DELIVERY_CONFIG", "Delivery argv entries must be non-empty strings");
      this.executable = argv[0]!;
      this.args = argv.slice(1);
    } else {
      this.executable = requiredText(config.executable!, "delivery executable");
      this.args = config.args ?? [];
      invariant(this.args.every((entry) => typeof entry === "string"), "INVALID_DELIVERY_CONFIG", "Delivery args must be strings");
    }
    invariant(this.args.includes("{sha}"), "INVALID_DELIVERY_CONFIG", "Delivery command must contain an exact {sha} argument");
    this.cwd = config.cwd === undefined ? root : resolveConfiguredPath(root, config.cwd);
    this.env = config.env;
  }

  async preview(input: PreviewDeliveryInput): Promise<PreviewDeliveryResult> {
    const sha = exactSha(input.sha);
    const candidateTree = await resolveCandidateTree(this.cwd, sha);
    validateCandidateTree(input.candidateTree, candidateTree);
    validateProofEvidence(input.proof, sha, candidateTree);
    return this.execute(sha, candidateTree, "preview");
  }

  promote(input: StagingPromotionInput): Promise<StagingDeliveryResult>;
  promote(input: ProductionPromotionInput): Promise<ProductionDeliveryResult>;
  async promote(input: PromoteDeliveryInput): Promise<StagingDeliveryResult | ProductionDeliveryResult> {
    const sha = exactSha(input.sha);
    const candidateTree = await resolveCandidateTree(this.cwd, sha);
    validateCandidateTree(input.candidateTree, candidateTree);
    if (input.target === "staging") {
      const identity = validateDeliveryIdentity(input.identity, sha, candidateTree, "preview");
      return this.execute(sha, candidateTree, input.target, identity);
    }
    const identity = validateDeliveryIdentity(input.identity, sha, candidateTree, "staging");
    validateProofEvidence(input.proof, sha, candidateTree);
    validateStagingEvidence(identity, sha, candidateTree);
    validateIntegrationEvidence(input.integration, sha, candidateTree);
    await validateCanonicalIntegration(this.cwd, input.integrationRemote, input.integrationBranch, input.integration);
    validateProductionAuthorization(input.productionAuthorization, sha, candidateTree, identity, input.integration);
    return this.execute(sha, candidateTree, input.target, identity);
  }

  private async execute<T extends DeliveryTarget>(
    sha: string,
    candidateTree: string,
    target: T,
    identity?: DeliveryIdentity,
  ): Promise<DeliveryResult & { target: T }> {
    const args = this.args.map((argument) => (argument === "{sha}" ? sha : argument === "{target}" ? target : argument));
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      POIESIS_CANDIDATE_SHA: sha,
      POIESIS_CANDIDATE_TREE: candidateTree,
      POIESIS_DELIVERY_TARGET: target,
      ...(identity === undefined ? {} : { POIESIS_DELIVERY_IDENTITY: JSON.stringify(identity) }),
    };
    const result = await run(this.executable, args, { cwd: this.cwd, env });
    const output = jsonObject(result.stdout, this.executable);
    for (const field of ["url", "artifact", "id"] as const) {
      invariant(
        output[field] === undefined || typeof output[field] === "string",
        "INVALID_COMMAND_OUTPUT",
        `Delivery output ${field} must be a string`,
      );
    }
    invariant(
      typeof output.url === "string" || typeof output.artifact === "string" || typeof output.id === "string",
      "INVALID_COMMAND_OUTPUT",
      "Delivery output must contain a URL, artifact, or id",
    );
    invariant(
      output.sha === sha,
      "DELIVERY_IDENTITY_MISMATCH",
      "Delivery command reported a different candidate",
      { expected: sha, actual: output.sha },
    );
    invariant(
      output.candidateTree === candidateTree,
      "DELIVERY_TREE_MISMATCH",
      "Delivery command reported a different candidate tree",
      { expected: candidateTree, actual: output.candidateTree },
    );
    invariant(
      output.target === target,
      "DELIVERY_TARGET_MISMATCH",
      "Delivery command reported a different target",
      { expected: target, actual: output.target },
    );
    invariant(output.verified === true, "DELIVERY_VERIFICATION_FAILED", `${target} command must report verified: true`);
    invariant(
      typeof output.artifactIdentity === "string" && output.artifactIdentity.trim().length > 0,
      "DELIVERY_ARTIFACT_IDENTITY_MISSING",
      "Delivery command must report an immutable artifact identity",
    );
    const artifactIdentity = output.artifactIdentity as string;
    invariant(
      [output.id, output.url, output.artifact].includes(artifactIdentity),
      "DELIVERY_ARTIFACT_IDENTITY_MISMATCH",
      "Delivery artifact identity must match the reported id, URL, or artifact",
    );
    if (target === "production" && identity !== undefined) {
      invariant(
        artifactIdentity === identity.artifactIdentity,
        "PRODUCTION_STAGING_IDENTITY_MISMATCH",
        "Production command did not preserve the verified Staging artifact identity",
      );
    }
    return {
      sha,
      candidateSha: sha,
      candidateTree,
      target,
      artifactIdentity,
      status: typeof output.status === "string" ? output.status : "created",
      verified: true,
      ...(typeof output.id === "string" ? { id: output.id } : {}),
      ...(typeof output.url === "string" ? { url: output.url } : {}),
      ...(typeof output.artifact === "string" ? { artifact: output.artifact } : {}),
    };
  }
}

interface FixtureDeliveryRecord<T extends DeliveryResult = DeliveryResult> {
  schema: 1;
  adapter: "fixture-test-only";
  result: T;
  sourceIdentity?: DeliveryIdentity;
}

class FixtureDeliveryAdapter implements DeliveryAdapter {
  readonly kind = "fixture" as const;
  private readonly fixturePath: string;
  private readonly root: string;

  constructor(config: FixtureDeliveryConfig, root: string) {
    this.root = resolve(root);
    this.fixturePath = resolveConfiguredPath(root, requiredText(config.path, "delivery fixture path"));
    assertExternalFixturePath(root, this.fixturePath, "delivery");
  }

  async preview(input: PreviewDeliveryInput): Promise<PreviewDeliveryResult> {
    const sha = exactSha(input.sha);
    const candidateTree = await resolveCandidateTree(this.root, sha);
    validateCandidateTree(input.candidateTree, candidateTree);
    validateProofEvidence(input.proof, sha, candidateTree);
    const artifact = resolve(this.fixturePath, "candidates", identityFilename(sha));
    const result: PreviewDeliveryResult = {
      sha,
      candidateSha: sha,
      candidateTree,
      target: "preview",
      artifactIdentity: artifact,
      status: "created",
      verified: true,
      id: `fixture:${sha}`,
      artifact,
    };
    return this.writeImmutable("candidates", sha, { schema: 1, adapter: "fixture-test-only", result });
  }

  promote(input: StagingPromotionInput): Promise<StagingDeliveryResult>;
  promote(input: ProductionPromotionInput): Promise<ProductionDeliveryResult>;
  async promote(input: PromoteDeliveryInput): Promise<StagingDeliveryResult | ProductionDeliveryResult> {
    const sha = exactSha(input.sha);
    const candidateTree = await resolveCandidateTree(this.root, sha);
    validateCandidateTree(input.candidateTree, candidateTree);
    let result: StagingDeliveryResult | ProductionDeliveryResult;
    let recordedSourceIdentity: DeliveryIdentity;
    if (input.target === "staging") {
      const identity = validateDeliveryIdentity(input.identity, sha, candidateTree, "preview");
      const artifactIdentity = `fixture:staging:${sha}`;
      recordedSourceIdentity = identity;
      result = {
        sha,
        candidateSha: sha,
        candidateTree,
        target: "staging",
        artifactIdentity,
        status: "created",
        verified: true,
        id: artifactIdentity,
      };
    } else {
      const identity = validateDeliveryIdentity(input.identity, sha, candidateTree, "staging");
      validateProofEvidence(input.proof, sha, candidateTree);
      validateStagingEvidence(identity, sha, candidateTree);
      validateIntegrationEvidence(input.integration, sha, candidateTree);
      await validateCanonicalIntegration(this.root, input.integrationRemote, input.integrationBranch, input.integration);
      validateProductionAuthorization(input.productionAuthorization, sha, candidateTree, identity, input.integration);
      recordedSourceIdentity = identity;
      result = {
        sha,
        candidateSha: sha,
        candidateTree,
        target: "production",
        artifactIdentity: identity.artifactIdentity,
        status: "created",
        verified: true,
        ...(identity.id === undefined ? {} : { id: identity.id }),
        ...(identity.url === undefined ? {} : { url: identity.url }),
        ...(identity.artifact === undefined ? {} : { artifact: identity.artifact }),
      };
    }
    return this.writeImmutable(input.target, sha, {
      schema: 1,
      adapter: "fixture-test-only",
      result,
      sourceIdentity: recordedSourceIdentity,
    });
  }

  private async writeImmutable<T extends DeliveryResult>(
    directory: "candidates" | "staging" | "production",
    sha: string,
    record: FixtureDeliveryRecord<T>,
  ): Promise<T> {
    const path = resolve(this.fixturePath, directory, identityFilename(sha));
    await mkdir(dirname(path), { recursive: true });
    const content = `${JSON.stringify(record, null, 2)}\n`;
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const current = await readUtf8(path);
      invariant(current === content, "DELIVERY_IDENTITY_CONFLICT", "Fixture delivery identity already records different data", {
        path,
        sha,
        target: record.result.target,
      });
    }
    return structuredClone(record.result);
  }
}

function exactSha(sha: string): string {
  requiredText(sha, "candidate sha");
  invariant(sha === sha.trim() && !sha.includes("\0"), "INVALID_DELIVERY_IDENTITY", "Candidate sha is not exact text", { sha });
  return sha;
}

async function validateCanonicalIntegration(
  root: string,
  remote: string,
  branch: string,
  integration: IntegrationEvidence,
): Promise<void> {
  requiredText(remote, "integration remote");
  requiredText(branch, "integration branch");
  invariant(!remote.startsWith("-") && !remote.includes("\0"), "INVALID_REMOTE_NAME", "Configured integration remote is invalid", {
    remote,
  });
  const remotes = (await run("git", ["remote"], { cwd: root })).stdout.split("\n").filter(Boolean);
  invariant(remotes.includes(remote), "GIT_REMOTE_UNAVAILABLE", "Configured integration remote is unavailable", { remote });
  const branchCheck = await run("git", ["check-ref-format", "--branch", branch], { cwd: root, allowFailure: true });
  invariant(branchCheck.exitCode === 0, "INVALID_BRANCH_NAME", "Configured integration branch is invalid", { branch });
  const fetched = await run("git", ["fetch", "--quiet", "--no-tags", "--", remote, `refs/heads/${branch}`], {
    cwd: root,
    allowFailure: true,
  });
  invariant(fetched.exitCode === 0, "INTEGRATION_BRANCH_UNAVAILABLE", "Canonical integration branch could not be fetched", {
    remote,
    branch,
  });
  const head = await run("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { cwd: root });
  invariant(
    head.stdout === integration.integrationSha,
    "PRODUCTION_INTEGRATION_HEAD_MISMATCH",
    "Integration evidence is not the canonical remote integration head",
    { expected: head.stdout, actual: integration.integrationSha, remote, branch },
  );
  const tree = await run("git", ["rev-parse", "--verify", `${integration.integrationSha}^{tree}`], { cwd: root });
  invariant(
    tree.stdout === integration.integrationTree,
    "PRODUCTION_INTEGRATION_TREE_MISMATCH",
    "Integration evidence tree does not match the repository",
    { expected: tree.stdout, actual: integration.integrationTree },
  );
}

async function resolveCandidateTree(root: string, sha: string): Promise<string> {
  const commit = await run("git", ["rev-parse", "--verify", `${sha}^{commit}`], { cwd: root, allowFailure: true });
  invariant(
    commit.exitCode === 0 && commit.stdout === sha,
    "DELIVERY_CANDIDATE_NOT_FOUND",
    "Delivery candidate must be an exact commit in the repository",
    { candidateSha: sha },
  );
  const tree = await run("git", ["rev-parse", "--verify", `${sha}^{tree}`], { cwd: root, allowFailure: true });
  invariant(tree.exitCode === 0, "DELIVERY_CANDIDATE_TREE_MISSING", "Delivery candidate tree could not be resolved", {
    candidateSha: sha,
  });
  return tree.stdout;
}

function validateCandidateTree(provided: string, actual: string): void {
  invariant(provided === actual, "CANDIDATE_TREE_MISMATCH", "Provided candidate tree does not match repository", {
    expected: actual,
    provided,
  });
}

function validateDeliveryIdentity(
  identity: DeliveryIdentity,
  sha: string,
  candidateTree: string,
  target: "preview",
): DeliveryIdentity & { target: "preview" };
function validateDeliveryIdentity(
  identity: DeliveryIdentity,
  sha: string,
  candidateTree: string,
  target: "staging",
): DeliveryIdentity & { target: "staging" };
function validateDeliveryIdentity(
  identity: DeliveryIdentity,
  sha: string,
  candidateTree: string,
  target: "preview" | "staging",
): DeliveryIdentity & { target: "preview" | "staging" } {
  invariant(isRecord(identity), "INVALID_DELIVERY_IDENTITY", "Promotion requires a structured delivery identity");
  invariant(identity.sha === sha && identity.candidateSha === sha, "DELIVERY_IDENTITY_MISMATCH", "Promotion identity belongs to a different candidate", {
    expected: sha,
    actual: identity.sha,
  });
  invariant(identity.candidateTree === candidateTree, "DELIVERY_TREE_MISMATCH", "Promotion identity belongs to a different candidate tree");
  invariant(identity.target === target, "DELIVERY_SOURCE_TARGET_MISMATCH", `Promotion requires a ${target} identity`);
  invariant(
    typeof identity.artifactIdentity === "string" && identity.artifactIdentity.trim().length > 0,
    "INVALID_DELIVERY_IDENTITY",
    "Promotion requires an immutable artifact identity",
  );
  invariant(
    [identity.id, identity.url, identity.artifact].includes(identity.artifactIdentity),
    "DELIVERY_ARTIFACT_IDENTITY_MISMATCH",
    "Delivery artifact identity must match the reported id, URL, or artifact",
  );
  return identity as DeliveryIdentity & { target: "preview" | "staging" };
}

function identityFilename(identity: string): string {
  return `${createHash("sha256").update(identity).digest("hex")}.json`;
}

function resolveConfiguredPath(root: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function assertExternalFixturePath(root: string, path: string, kind: string): void {
  const relation = relative(resolve(root), resolve(path));
  invariant(
    relation === ".." || relation.startsWith(`..${sep}`),
    "FIXTURE_PATH_INSIDE_REPOSITORY",
    `Test-only ${kind} fixture path must be outside the repository`,
    { root: resolve(root), path: resolve(path) },
  );
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

export function createDeliveryAdapter(
  config: DeliveryAdapterConfig | ConfiguredDeliveryTarget,
  root = process.cwd(),
): DeliveryAdapter {
  switch (config.adapter) {
    case "command":
      return new CommandDeliveryAdapter(config as CommandDeliveryConfig, root);
    case "fixture":
      return new FixtureDeliveryAdapter(config as FixtureDeliveryConfig, root);
    default:
      throw new PoiesisError("UNKNOWN_DELIVERY_ADAPTER", `Unsupported delivery adapter: ${config.adapter}`, {
        adapter: config.adapter,
      });
  }
}

export function createCommandDeliveryAdapter(config: CommandDeliveryConfig, root = process.cwd()): DeliveryAdapter {
  return new CommandDeliveryAdapter(config, root);
}

export function createFixtureDeliveryAdapter(config: FixtureDeliveryConfig, root = process.cwd()): DeliveryAdapter {
  return new FixtureDeliveryAdapter(config, root);
}

export async function previewDelivery(
  config: DeliveryAdapterConfig | ConfiguredDeliveryTarget,
  input: PreviewDeliveryInput,
  root = process.cwd(),
): Promise<PreviewDeliveryResult> {
  return createDeliveryAdapter(config, root).preview(input);
}

export function promoteDelivery(
  config: DeliveryAdapterConfig | ConfiguredDeliveryTarget,
  input: StagingPromotionInput,
  root?: string,
): Promise<StagingDeliveryResult>;
export function promoteDelivery(
  config: DeliveryAdapterConfig | ConfiguredDeliveryTarget,
  input: ProductionPromotionInput,
  root?: string,
): Promise<ProductionDeliveryResult>;
export async function promoteDelivery(
  config: DeliveryAdapterConfig | ConfiguredDeliveryTarget,
  input: PromoteDeliveryInput,
  root = process.cwd(),
): Promise<StagingDeliveryResult | ProductionDeliveryResult> {
  const adapter = createDeliveryAdapter(config, root);
  return input.target === "staging" ? adapter.promote(input) : adapter.promote(input);
}

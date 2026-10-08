import { PoiesisError, invariant } from "./errors.js";

/**
 * The Poiesis tracker item contract, shared by every `TrackerAdapter`.
 *
 * Poiesis stores its own metadata INSIDE the tracker's own item body, in a
 * `<!-- poiesis:tracker ... -->` envelope followed by the relationship
 * prose. That is what lets an ordinary GitHub issue, an ordinary GitLab
 * issue, and an ordinary Linear issue all be a Poiesis Spec or Ticket
 * without the tracker needing any native concept of either. Because the
 * envelope is the durable identity of a Poiesis item, exactly one
 * implementation of it exists: two copies would let a Ticket created
 * through one provider become unreadable through another.
 *
 * This module is module-internal. It is deliberately NOT re-exported by
 * `src/index.ts`, so the envelope format and the item shapes stay free to
 * evolve without freezing into the package's public API.
 */

export type TrackerItemKind = "spec" | "ticket";
export type TrackerItemState = "open" | "closed" | "superseded";

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

export interface TrackerMetadata {
  kind: TrackerItemKind;
  parentSpecId?: string;
  dependencyText?: string;
  supersededReason?: string;
  supersededBy?: string[];
}

const METADATA_START = "<!-- poiesis:tracker\n";
const METADATA_END = "\npoiesis:tracker -->\n\n";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredText(value: string, name: string): string {
  invariant(value.trim().length > 0, "INVALID_ADAPTER_INPUT", `${name} must not be empty`, { name });
  return value;
}

export function decorateBody(body: string, metadata: TrackerMetadata): string {
  return `${METADATA_START}${JSON.stringify(metadata)}${METADATA_END}${relationshipText(metadata)}${body}`;
}

export function parseBody(value: string): { body: string; metadata: TrackerMetadata } {
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

/**
 * Read a tracker's own item shape into the Poiesis shape. A supersession
 * reason recorded in the envelope outranks the tracker's own state, so a
 * superseded item reads as superseded whether or not the provider models
 * that state itself.
 */
export function trackerItem(raw: { id: string; title: string; body: string; state: string; url: string }): TrackerItem {
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

export function assertKind(item: TrackerItem, kind: TrackerItemKind): TrackerItem {
  invariant(item.kind === kind, "TRACKER_ITEM_KIND_MISMATCH", `Tracker item ${item.id} is not a ${kind}`, {
    id: item.id,
    expected: kind,
    actual: item.kind,
  });
  return item;
}

export function metadataFromItem(item: TrackerItem): TrackerMetadata {
  return {
    kind: item.kind,
    ...(item.parentSpecId === undefined ? {} : { parentSpecId: item.parentSpecId }),
    ...(item.dependencyText === undefined ? {} : { dependencyText: item.dependencyText }),
    ...(item.supersededReason === undefined ? {} : { supersededReason: item.supersededReason }),
    ...(item.supersededBy === undefined ? {} : { supersededBy: [...item.supersededBy] }),
  };
}

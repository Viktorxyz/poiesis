import { PoiesisError, invariant } from "./errors.js";
import { bounded } from "./process.js";

export interface OpenCodeSessionCleanupOptions {
  baseUrl?: string;
  directory?: string;
  strict?: boolean;
  fetch?: typeof globalThis.fetch;
  /**
   * Spec #168 / ticket #170 — per-request bound. Every enumerate, delete,
   * and verify request is abandoned after this budget and recorded as a
   * warning, so an unresponsive or slow OpenCode endpoint cannot hold a
   * managed Poiesis operation open. Defaults to 5s, capped at 60s.
   */
  requestTimeoutMs?: number;
  /**
   * Spec #168 / ticket #170 — traversal budget. The walk stops once this
   * many sessions have been observed, so a deep or hostile session graph
   * cannot grow without bound. Sessions never enumerated are never
   * deleted. Defaults to 32, capped at 256.
   */
  maxSessions?: number;
}

export interface SessionCleanupWarning {
  sessionId: string;
  operation: "enumerate" | "delete" | "verify";
  message: string;
  status?: number;
}

export interface OpenCodeSessionCleanupResult {
  rootSessionId: string;
  attempted: string[];
  deleted: string[];
  remaining: string[];
  warnings: SessionCleanupWarning[];
}

interface OpenCodeSession {
  id: string;
}

const DEFAULT_OPENCODE_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_SESSIONS = 32;
const MAX_SESSIONS = 256;

export async function cleanupOpenCodeSession(
  sessionId: string,
  options: OpenCodeSessionCleanupOptions = {},
): Promise<OpenCodeSessionCleanupResult> {
  invariant(sessionId.trim().length > 0, "INVALID_SESSION_ID", "OpenCode session id must not be empty");
  const fetcher = options.fetch ?? globalThis.fetch;
  invariant(typeof fetcher === "function", "FETCH_UNAVAILABLE", "Native fetch is unavailable");
  const baseUrl = normalizedBaseUrl(options.baseUrl ?? DEFAULT_OPENCODE_BASE_URL);
  const requestTimeoutMs = normalizeBound(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const maxSessions = normalizeBound(options.maxSessions, DEFAULT_MAX_SESSIONS, MAX_SESSIONS, "maxSessions");
  const warnings: SessionCleanupWarning[] = [];
  const leafFirst: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  /**
   * Sessions whose children are UNKNOWN: enumeration failed, timed out,
   * hit the traversal budget, or the children response was malformed. A
   * session in this set, and every ancestor above it, is never deleted —
   * deleting a parent whose children were not fully observed could orphan
   * or cascade into sessions Poiesis never saw. Deletion stays strictly
   * leaf-first over sessions whose whole subtree was confirmed.
   */
  const incomplete = new Set<string>();

  /**
   * Enumerate `id` and record it for deletion only when its entire subtree
   * was confirmed. Returns true when the subtree is fully known.
   */
  async function enumerate(id: string): Promise<boolean> {
    if (incomplete.has(id)) return false;
    if (visited.has(id)) return true;
    if (active.has(id)) {
      warnings.push({ sessionId: id, operation: "enumerate", message: "Cycle found in OpenCode session children" });
      incomplete.add(id);
      return false;
    }
    // The traversal budget is spent before the request, so an oversized
    // graph stops exactly at the bound and every un-enumerated remainder
    // stays undeleted, along with the ancestors above the cut.
    if (visited.size + active.size >= maxSessions) {
      warnings.push({
        sessionId: id,
        operation: "enumerate",
        message: `Session traversal stopped at the bounded budget of ${maxSessions} session(s)`,
      });
      incomplete.add(id);
      return false;
    }
    active.add(id);
    const response = await request(
      fetcher,
      sessionUrl(baseUrl, id, "children", options.directory),
      "GET",
      requestTimeoutMs,
    );
    let subtreeComplete = false;
    if (response.error !== undefined) {
      warnings.push(warning(id, "enumerate", response.error, response.status));
    } else if (response.status === 404 || response.status === 410) {
      // A confirmed absence: this session has no children to leak.
      subtreeComplete = true;
    } else if (!response.ok) {
      // An error status says the children are UNKNOWN, not empty.
      warnings.push(warning(id, "enumerate", response.body, response.status));
    } else {
      const parsed = parseSessions(response.body, id, warnings);
      // A malformed entry means the child list is incomplete, so this
      // session's subtree cannot be trusted either.
      subtreeComplete = parsed.complete;
      for (const child of parsed.children) {
        if (!(await enumerate(child.id))) subtreeComplete = false;
      }
    }
    active.delete(id);
    if (!subtreeComplete) {
      incomplete.add(id);
      return false;
    }
    visited.add(id);
    leafFirst.push(id);
    return true;
  }

  await enumerate(sessionId);

  const attempted = [...new Set(leafFirst)];
  const deleted: string[] = [];
  for (const id of attempted) {
    const response = await request(
      fetcher,
      sessionUrl(baseUrl, id, undefined, options.directory),
      "DELETE",
      requestTimeoutMs,
    );
    if (response.error !== undefined) {
      warnings.push(warning(id, "delete", response.error, response.status));
      continue;
    }
    if (response.ok || response.status === 404 || response.status === 410) {
      deleted.push(id);
      continue;
    }
    warnings.push(warning(id, "delete", response.body, response.status));
  }

  const remaining: string[] = [];
  for (const id of attempted) {
    const response = await request(
      fetcher,
      sessionUrl(baseUrl, id, undefined, options.directory),
      "GET",
      requestTimeoutMs,
    );
    if (response.error !== undefined) {
      warnings.push(warning(id, "verify", response.error, response.status));
    } else if (response.status !== 404 && response.status !== 410) {
      remaining.push(id);
      warnings.push(
        warning(
          id,
          "verify",
          response.ok ? "Session still exists after deletion" : response.body,
          response.status,
        ),
      );
    }
  }

  const result: OpenCodeSessionCleanupResult = {
    rootSessionId: sessionId,
    attempted,
    deleted,
    remaining,
    warnings,
  };
  if (options.strict === true && warnings.length > 0) {
    throw new PoiesisError("SESSION_CLEANUP_FAILED", `OpenCode session cleanup produced ${warnings.length} warning(s)`, {
      result,
    });
  }
  return result;
}

export async function cleanupOpenCodeSessions(
  sessionIds: readonly string[],
  options: OpenCodeSessionCleanupOptions = {},
): Promise<OpenCodeSessionCleanupResult[]> {
  const results: OpenCodeSessionCleanupResult[] = [];
  for (const sessionId of sessionIds) results.push(await cleanupOpenCodeSession(sessionId, options));
  return results;
}

export const cleanupSession = cleanupOpenCodeSession;

interface HttpResult {
  ok: boolean;
  status?: number;
  body: string;
  error?: string;
}

/**
 * One bounded HTTP request.
 *
 * The budget is enforced twice on purpose: the `AbortSignal` lets the
 * transport cancel the in-flight request, and the explicit race means the
 * bound holds even for a transport that ignores signals (a stalled socket,
 * a fixture that never settles). Both settle branches handle their own
 * rejection so a late failure can never surface as an unhandled rejection.
 */
async function request(
  fetcher: typeof globalThis.fetch,
  url: URL,
  method: "GET" | "DELETE",
  timeoutMs: number,
): Promise<HttpResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  try {
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    const outcome = await Promise.race([
      fetcher(url, { method, headers: { accept: "application/json" }, signal: controller.signal }).then(
        (response) => ({ kind: "response" as const, response }),
        (error: unknown) => ({
          kind: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      expiry,
    ]);
    if (outcome === "timeout") {
      return { ok: false, body: "", error: `OpenCode request exceeded ${timeoutMs}ms` };
    }
    if (outcome.kind === "error") {
      return { ok: false, body: "", error: outcome.message };
    }
    return {
      ok: outcome.response.ok,
      status: outcome.response.status,
      body: await outcome.response.text(),
    };
  } catch (error) {
    return {
      ok: false,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Spec #168 / ticket #170 — refuse an unbounded or nonsensical cleanup
 * budget instead of silently substituting a default, so a caller can never
 * believe it asked for a bound it did not get.
 */
function normalizeBound(value: number | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  invariant(
    Number.isSafeInteger(value) && value > 0 && value <= maximum,
    "INVALID_SESSION_CLEANUP_BOUND",
    `OpenCode session cleanup ${label} must be between 1 and ${maximum}`,
    { [label]: value, maximum },
  );
  return value;
}

/**
 * Parse a children response.
 *
 * `complete` is false when the response could not be fully understood —
 * invalid JSON, a non-array body, or an entry without a usable id. That
 * distinction is what keeps a partially-read children list from being
 * treated as a confirmed-empty one.
 */
function parseSessions(
  body: string,
  parentId: string,
  warnings: SessionCleanupWarning[],
): { children: OpenCodeSession[]; complete: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    warnings.push({
      sessionId: parentId,
      operation: "enumerate",
      message: `Invalid children JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { children: [], complete: false };
  }
  if (!Array.isArray(value)) {
    warnings.push({ sessionId: parentId, operation: "enumerate", message: "Children response is not an array" });
    return { children: [], complete: false };
  }
  const children: OpenCodeSession[] = [];
  let complete = true;
  for (const child of value) {
    if (typeof child === "object" && child !== null && typeof (child as { id?: unknown }).id === "string") {
      children.push({ id: (child as { id: string }).id });
    } else {
      complete = false;
      warnings.push({ sessionId: parentId, operation: "enumerate", message: "Children response contains an invalid session" });
    }
  }
  return { children, complete };
}

function normalizedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PoiesisError("INVALID_OPENCODE_URL", `Invalid OpenCode base URL: ${value}`);
  }
  invariant(url.protocol === "http:" || url.protocol === "https:", "INVALID_OPENCODE_URL", "OpenCode base URL must use HTTP(S)", {
    baseUrl: value,
  });
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function sessionUrl(baseUrl: URL, sessionId: string, suffix?: "children", directory?: string): URL {
  const path = `session/${encodeURIComponent(sessionId)}${suffix === undefined ? "" : `/${suffix}`}`;
  const url = new URL(path, baseUrl);
  if (directory !== undefined) url.searchParams.set("directory", directory);
  return url;
}

function warning(
  sessionId: string,
  operation: SessionCleanupWarning["operation"],
  message: string,
  status?: number,
): SessionCleanupWarning {
  return {
    sessionId,
    operation,
    message: bounded(message || `OpenCode returned HTTP ${status ?? "unknown"}`, 2_000),
    ...(status === undefined ? {} : { status }),
  };
}

import { PoiesisError, invariant } from "./errors.js";
import { bounded } from "./process.js";

export interface OpenCodeSessionCleanupOptions {
  baseUrl?: string;
  directory?: string;
  strict?: boolean;
  fetch?: typeof globalThis.fetch;
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

export async function cleanupOpenCodeSession(
  sessionId: string,
  options: OpenCodeSessionCleanupOptions = {},
): Promise<OpenCodeSessionCleanupResult> {
  invariant(sessionId.trim().length > 0, "INVALID_SESSION_ID", "OpenCode session id must not be empty");
  const fetcher = options.fetch ?? globalThis.fetch;
  invariant(typeof fetcher === "function", "FETCH_UNAVAILABLE", "Native fetch is unavailable");
  const baseUrl = normalizedBaseUrl(options.baseUrl ?? DEFAULT_OPENCODE_BASE_URL);
  const warnings: SessionCleanupWarning[] = [];
  const leafFirst: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();

  async function enumerate(id: string): Promise<void> {
    if (visited.has(id)) return;
    if (active.has(id)) {
      warnings.push({ sessionId: id, operation: "enumerate", message: "Cycle found in OpenCode session children" });
      return;
    }
    active.add(id);
    const response = await request(fetcher, sessionUrl(baseUrl, id, "children", options.directory), "GET");
    if (response.error !== undefined) {
      warnings.push(warning(id, "enumerate", response.error, response.status));
    } else if (response.status === 404 || response.status === 410) {
      visited.add(id);
    } else if (!response.ok) {
      warnings.push(warning(id, "enumerate", response.body, response.status));
    } else {
      const children = parseSessions(response.body, id, warnings);
      for (const child of children) await enumerate(child.id);
      visited.add(id);
      leafFirst.push(id);
    }
    active.delete(id);
  }

  await enumerate(sessionId);
  if (!visited.has(sessionId)) leafFirst.push(sessionId);

  const attempted = [...new Set(leafFirst)];
  const deleted: string[] = [];
  for (const id of attempted) {
    const response = await request(fetcher, sessionUrl(baseUrl, id, undefined, options.directory), "DELETE");
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
    const response = await request(fetcher, sessionUrl(baseUrl, id, undefined, options.directory), "GET");
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

async function request(fetcher: typeof globalThis.fetch, url: URL, method: "GET" | "DELETE"): Promise<HttpResult> {
  try {
    const response = await fetcher(url, { method, headers: { accept: "application/json" } });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return {
      ok: false,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseSessions(body: string, parentId: string, warnings: SessionCleanupWarning[]): OpenCodeSession[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    warnings.push({
      sessionId: parentId,
      operation: "enumerate",
      message: `Invalid children JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push({ sessionId: parentId, operation: "enumerate", message: "Children response is not an array" });
    return [];
  }
  const children: OpenCodeSession[] = [];
  for (const child of value) {
    if (typeof child === "object" && child !== null && typeof (child as { id?: unknown }).id === "string") {
      children.push({ id: (child as { id: string }).id });
    } else {
      warnings.push({ sessionId: parentId, operation: "enumerate", message: "Children response contains an invalid session" });
    }
  }
  return children;
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

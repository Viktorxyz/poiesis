/**
 * Spec #168 / ticket #170 — bounded, leaf-first, known-session cleanup of
 * the OpenCode child sessions a managed execution creates.
 *
 * The session tree is walked from one KNOWN session id and deleted
 * leaf-first, so a parent is never deleted while children still exist and
 * no session outside the traversal is ever touched. Both the walk and every
 * individual HTTP request are bounded: an unresponsive or slow endpoint
 * must produce a typed warning inside a known budget instead of holding a
 * Poiesis operation open, and the traversal itself is capped so a deep or
 * hostile session graph cannot grow without bound.
 */
import { describe, expect, it } from "vitest";
import { cleanupOpenCodeSession, type OpenCodeSessionCleanupOptions } from "../src/session.js";

interface FakeOpenCode {
  fetch: typeof globalThis.fetch;
  deleted: string[];
  enumerated: string[];
  requestedPaths: string[];
}

function fakeOpenCode(children: Record<string, string[]>): FakeOpenCode {
  const existing = new Set(Object.keys(children));
  const deleted: string[] = [];
  const enumerated: string[] = [];
  const requestedPaths: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    const parts = url.pathname.split("/").filter(Boolean);
    const id = decodeURIComponent(parts[1]!);
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      deleted.push(id);
      existing.delete(id);
      return new Response("{}", { status: 200 });
    }
    if (parts[2] === "children") {
      enumerated.push(id);
      return Response.json(
        (children[id] ?? []).filter((child) => existing.has(child)).map((child) => ({ id: child })),
      );
    }
    return existing.has(id) ? Response.json({ id }) : new Response("", { status: 404 });
  };
  return { fetch, deleted, enumerated, requestedPaths };
}

describe("bounded OpenCode session cleanup", () => {
  it("deletes the known session tree leaf-first and touches nothing else", async () => {
    const tree: Record<string, string[]> = {
      root: ["branch-a"],
      "branch-a": ["leaf-1", "leaf-2"],
      "leaf-1": [],
      "leaf-2": ["leaf-2a"],
      "leaf-2a": [],
    };
    const fake = fakeOpenCode(tree);
    const result = await cleanupOpenCodeSession("root", { fetch: fake.fetch });

    // Leaf-first means every descendant is deleted before its own parent —
    // the sibling order inside a level is not part of the contract.
    expect(fake.deleted).toHaveLength(Object.keys(tree).length);
    expect(new Set(fake.deleted)).toEqual(new Set(Object.keys(tree)));
    for (const [parent, children] of Object.entries(tree)) {
      for (const child of children) {
        expect(fake.deleted.indexOf(child)).toBeLessThan(fake.deleted.indexOf(parent));
      }
    }
    expect(fake.deleted[fake.deleted.length - 1]).toBe("root");
    expect(result.attempted).toEqual(fake.deleted);
    expect(result.remaining).toEqual([]);
    expect(result.warnings).toEqual([]);
    // Every request addressed one concrete session id. A pattern or
    // wildcard target would show up as a path that is not exactly
    // `session/<id>` or `session/<id>/children`.
    for (const path of fake.requestedPaths) {
      expect(path).toMatch(/^\/session\/[^/]+(\/children)?$/);
    }
  });

  it("gives every HTTP request an abort signal and a bounded budget", async () => {
    const fake = fakeOpenCode({ root: [] });
    const signals: Array<AbortSignal | null | undefined> = [];
    await cleanupOpenCodeSession("root", {
      fetch: ((input: unknown, init?: RequestInit) => {
        signals.push(init?.signal ?? null);
        return fake.fetch(input as never, init);
      }) as typeof globalThis.fetch,
    });
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("warns and settles inside the bound when the endpoint never answers", async () => {
    const startedAt = Date.now();
    const result = await cleanupOpenCodeSession("root", {
      requestTimeoutMs: 150,
      fetch: () => new Promise<Response>(() => {}),
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatchObject({ sessionId: "root" });
    expect(result.deleted).toEqual([]);
  }, 15_000);

  /**
   * Ticket #186 — the bound covers the COMPLETE request, not just its headers.
   *
   * A peer that answers with response headers and then stalls forever on the
   * body used to defeat the budget completely: the race resolved on the
   * headers, and `response.text()` was awaited outside it, so one never-settling
   * body held a managed Poiesis operation open with no bound at all. These
   * tests drive the two late-body cases directly — a body that never settles,
   * and a body that fails AFTER the deadline — because a transport injected by
   * a test never honours the abort signal, which is exactly the shape the
   * explicit bound exists for.
   */
  it("settles inside the bound when headers arrive but the body never settles", async () => {
    const startedAt = Date.now();
    const result = await cleanupOpenCodeSession("root", {
      requestTimeoutMs: 150,
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          text: () => new Promise<string>(() => {}),
        }) as unknown as Response,
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.operation === "enumerate")).toBe(true);
    expect(result.deleted).toEqual([]);
  }, 15_000);

  it("settles inside the bound and never leaks a late body failure when the body fails after the deadline", async () => {
    const startedAt = Date.now();
    const result = await cleanupOpenCodeSession("root", {
      requestTimeoutMs: 150,
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              setTimeout(() => reject(new Error("body transport failed late")), 600);
            }),
        }) as unknown as Response,
    });
    const elapsed = Date.now() - startedAt;
    // The bound decided the outcome, so the late failure is not waited for and
    // not reported as this request's error. Vitest fails the file if that late
    // rejection escaped as an unhandled one.
    expect(elapsed).toBeLessThan(500);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.deleted).toEqual([]);
    // Give the late rejection time to land: an unhandled one is reported after
    // the test body has already returned.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(result.warnings.some((warning) => warning.message.includes("body transport failed late"))).toBe(false);
  }, 15_000);

  it("bounds the traversal without deleting sessions it never enumerated", async () => {
    const fake = fakeOpenCode({
      root: ["c1"],
      c1: ["c2"],
      c2: ["c3"],
      c3: ["c4"],
      c4: [],
    });
    const result = await cleanupOpenCodeSession("root", {
      maxSessions: 2,
      fetch: fake.fetch,
    });

    // At most the budget was enumerated, and every deletion is a session
    // the walk actually observed.
    expect(fake.enumerated.length).toBeLessThanOrEqual(2);
    expect(result.attempted.length).toBeLessThanOrEqual(2);
    for (const id of fake.deleted) expect(fake.enumerated).toContain(id);
    expect(result.warnings.some((warning) => warning.operation === "enumerate")).toBe(true);
  });

  it("refuses an unbounded or non-positive request budget", async () => {
    const fake = fakeOpenCode({ root: [] });
    for (const requestTimeoutMs of [0, -1, 10_000_000, 1.5]) {
      await expect(
        cleanupOpenCodeSession("root", { requestTimeoutMs, fetch: fake.fetch } as OpenCodeSessionCleanupOptions),
      ).rejects.toMatchObject({ code: "INVALID_SESSION_CLEANUP_BOUND" });
    }
  });

  it("refuses a non-positive traversal budget", async () => {
    const fake = fakeOpenCode({ root: [] });
    for (const maxSessions of [0, -5, 10_000, 2.5]) {
      await expect(
        cleanupOpenCodeSession("root", { maxSessions, fetch: fake.fetch } as OpenCodeSessionCleanupOptions),
      ).rejects.toMatchObject({ code: "INVALID_SESSION_CLEANUP_BOUND" });
    }
  });

  it("does not delete an ancestor whose subtree could not be fully enumerated", async () => {
    // A session whose children cannot be enumerated has UNKNOWN children.
    // Deleting it anyway would silently orphan — or cascade into — sessions
    // Poiesis never saw. Only sessions whose whole subtree was confirmed are
    // deleted; the root is an ancestor of the unknown one, so it stays.
    const fake = fakeOpenCode({ root: ["reachable", "broken"], reachable: [], broken: [] });
    const result = await cleanupOpenCodeSession("root", {
      requestTimeoutMs: 150,
      fetch: ((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        const id = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1]!);
        if (id === "broken" && (init?.method ?? "GET") === "GET") {
          return new Promise<Response>(() => {});
        }
        return fake.fetch(input as never, init);
      }) as typeof globalThis.fetch,
    });

    // `reachable` had no children and is deleted. `broken` could not be
    // enumerated, so neither it nor its ancestor `root` may be deleted.
    expect(fake.deleted).toEqual(["reachable"]);
    expect(fake.deleted).not.toContain("broken");
    expect(fake.deleted).not.toContain("root");
    expect(result.attempted).toEqual(["reachable"]);
    expect(result.warnings.some((warning) => warning.sessionId === "broken")).toBe(true);
  }, 15_000);

  it("does not delete ancestors above a traversal the budget truncated", async () => {
    // The budget stops the walk mid-tree, so every session above the cut has
    // an unknown remainder and must be preserved. Deleting them would remove
    // sessions the bounded walk never observed.
    const fake = fakeOpenCode({ root: ["c1"], c1: ["c2"], c2: ["c3"], c3: ["c4"], c4: [] });
    const result = await cleanupOpenCodeSession("root", { maxSessions: 2, fetch: fake.fetch });

    expect(fake.deleted).toEqual([]);
    expect(result.attempted).toEqual([]);
    expect(result.warnings.some((warning) => warning.operation === "enumerate")).toBe(true);
  });

  it("does not delete a session that returned a non-2xx children response", async () => {
    const fake = fakeOpenCode({ root: ["server-error"], "server-error": [] });
    const result = await cleanupOpenCodeSession("root", {
      fetch: ((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        const id = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1]!);
        if (id === "server-error" && url.pathname.endsWith("/children")) {
          return new Response("upstream exploded", { status: 503 });
        }
        return fake.fetch(input as never, init);
      }) as typeof globalThis.fetch,
    });

    // Neither the failing child nor its parent is deleted; a 503 means the
    // children are unknown, not empty.
    expect(fake.deleted).toEqual([]);
    expect(result.attempted).toEqual([]);
    expect(result.warnings.some((warning) => warning.sessionId === "server-error")).toBe(true);
  });

  it("still deletes the root when its children enumeration succeeds", async () => {
    // The complement of the two tests above: a confirmed-empty children list
    // is a real answer, so the normal leaf-first deletion must still happen.
    const fake = fakeOpenCode({ root: [], orphan: [] });
    const result = await cleanupOpenCodeSession("root", { fetch: fake.fetch });
    expect(fake.deleted).toEqual(["root"]);
    expect(result.remaining).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
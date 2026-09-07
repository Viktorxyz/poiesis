import { describe, expect, it } from "vitest";
import { cleanupOpenCodeSession } from "../src/session.js";

describe("OpenCode session hygiene", () => {
  it("cleans nested children leaf-first and treats cleanup as best effort", async () => {
    const existing = new Set(["root", "child", "leaf"]);
    const order: string[] = [];
    const children: Record<string, string[]> = { root: ["child"], child: ["leaf"], leaf: [] };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const parts = url.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[1]!);
      if (init?.method === "DELETE") {
        order.push(id);
        existing.delete(id);
        return new Response("{}", { status: 200 });
      }
      if (parts[2] === "children") {
        return Response.json((children[id] ?? []).filter((child) => existing.has(child)).map((child) => ({ id: child })));
      }
      return existing.has(id) ? Response.json({ id }) : new Response("", { status: 404 });
    };
    const result = await cleanupOpenCodeSession("root", { fetch: fetcher });
    expect(order).toEqual(["leaf", "child", "root"]);
    expect(result.remaining).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns warnings instead of blocking correctness", async () => {
    const result = await cleanupOpenCodeSession("root", {
      fetch: async () => {
        throw new Error("server unavailable");
      },
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

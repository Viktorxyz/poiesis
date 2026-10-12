/**
 * Spec #207 / ticket #209 — deterministic AGENTS.md inventory and
 * path-scoped ancestor resolution.
 *
 * Pure / in-memory only: injected filesystem tree, no git-init fixtures,
 * no scratch project installs.
 */
import { describe, expect, it } from "vitest";
import {
  inventoryAgents,
  isAgentsExcludedDirectoryName,
  resolveAgentsChain,
  type AgentsDirEntry,
  type AgentsFs,
} from "../src/agents.js";
import { PoiesisError } from "../src/errors.js";

/**
 * Minimal in-memory tree. Keys are absolute POSIX paths. Directories end
 * with `/` in the key set via a trailing marker in `dirs`; files are keys
 * in `files`. Symlinks map link path → target path (absolute).
 */
function memoryFs(spec: {
  root: string;
  dirs: string[];
  files?: Record<string, string>;
  symlinks?: Record<string, string>;
}): AgentsFs {
  const root = spec.root.replace(/\/$/, "") || "/";
  const dirs = new Set(spec.dirs.map((d) => d.replace(/\/$/, "") || "/"));
  dirs.add(root);
  const files = new Map(Object.entries(spec.files ?? {}));
  const symlinks = new Map(Object.entries(spec.symlinks ?? {}));

  function normalize(path: string): string {
    if (path === "/") return "/";
    return path.replace(/\/$/, "");
  }

  function resolveSymlink(path: string, seen = new Set<string>()): string {
    const n = normalize(path);
    if (seen.has(n)) return n;
    seen.add(n);
    const target = symlinks.get(n);
    if (target === undefined) return n;
    return resolveSymlink(target, seen);
  }

  return {
    async readdir(path: string): Promise<AgentsDirEntry[]> {
      const dir = resolveSymlink(path);
      if (!dirs.has(dir)) {
        const err = new Error(`ENOENT: ${dir}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const names = new Set<string>();
      for (const candidate of dirs) {
        if (candidate === dir) continue;
        if (!candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length);
        if (rest.includes("/")) continue;
        if (rest.length > 0) names.add(rest);
      }
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (rest.includes("/")) continue;
        if (rest.length > 0) names.add(rest);
      }
      for (const linkPath of symlinks.keys()) {
        if (!linkPath.startsWith(prefix)) continue;
        const rest = linkPath.slice(prefix.length);
        if (rest.includes("/")) continue;
        if (rest.length > 0) names.add(rest);
      }
      return [...names].sort().map((name) => {
        const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
        if (symlinks.has(full)) {
          return { name, isDirectory: false, isFile: false, isSymbolicLink: true };
        }
        if (dirs.has(full)) {
          return { name, isDirectory: true, isFile: false, isSymbolicLink: false };
        }
        return { name, isDirectory: false, isFile: true, isSymbolicLink: false };
      });
    },
    async realpath(path: string): Promise<string> {
      const n = resolveSymlink(path);
      if (dirs.has(n) || files.has(n) || n === root || symlinks.has(normalize(path))) return n;
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    async exists(path: string): Promise<boolean> {
      const n = normalize(path);
      if (dirs.has(n) || files.has(n) || symlinks.has(n)) return true;
      const resolved = resolveSymlink(n);
      return dirs.has(resolved) || files.has(resolved);
    },
    async isDirectory(path: string): Promise<boolean> {
      const resolved = resolveSymlink(path);
      return dirs.has(resolved);
    },
  };
}

describe("AGENTS exclusion names (ticket #209)", () => {
  it("excludes git internals, deps, vendor, build/cache, and .poiesis by directory name", () => {
    for (const name of [
      ".git",
      "node_modules",
      "vendor",
      "dist",
      "build",
      "coverage",
      ".cache",
      ".next",
      ".turbo",
      ".poiesis",
    ]) {
      expect(isAgentsExcludedDirectoryName(name), name).toBe(true);
    }
  });

  it("does not blanket-exclude hidden Author containers or ordinary source directories", () => {
    for (const name of [".github", ".husky", ".vscode", ".agents", ".opencode", "src", "tests", "lib"]) {
      expect(isAgentsExcludedDirectoryName(name), name).toBe(false);
    }
  });
});

describe("inventoryAgents (ticket #209)", () => {
  it("includes root and every eligible nested folder, reporting missing AGENTS.md", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/src`, `${root}/src/cli`, `${root}/.github`, `${root}/node_modules`, `${root}/node_modules/x`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/src/index.ts`]: "export {}",
        // src missing AGENTS.md
        [`${root}/src/cli/AGENTS.md`]: "# cli\n",
        [`${root}/.github/workflows/ci.yml`]: "name: ci\n",
        [`${root}/node_modules/x/index.js`]: "module.exports = {}",
      },
    });

    const result = await inventoryAgents(root, { fs });
    const byPath = Object.fromEntries(result.folders.map((f) => [f.path, f.agentsMd]));
    expect(byPath[""]).toBe("present");
    expect(byPath["src"]).toBe("missing");
    expect(byPath["src/cli"]).toBe("present");
    expect(byPath[".github"]).toBe("missing");
    expect(byPath["node_modules"]).toBeUndefined();
    expect(result.missing).toEqual([".github", "src"]);
  });

  it("skips nested separate repositories and does not follow external symlinks", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [
        root,
        `${root}/apps`,
        `${root}/apps/web`,
        `${root}/other-repo`,
        `${root}/other-repo/src`,
        `/outside/lib`,
      ],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/apps/web/index.ts`]: "export {}",
        // nested git marks a separate repository
        [`${root}/other-repo/.git`]: "gitdir: /elsewhere",
        [`${root}/other-repo/src/main.ts`]: "export {}",
        [`/outside/lib/AGENTS.md`]: "# external\n",
      },
      symlinks: {
        [`${root}/linked-out`]: `/outside/lib`,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const paths = result.folders.map((f) => f.path).sort();
    expect(paths).toEqual(["", "apps", "apps/web"]);
    expect(paths).not.toContain("other-repo");
    expect(paths).not.toContain("other-repo/src");
    expect(paths).not.toContain("linked-out");
  });

  it("follows internal directory symlinks that stay inside the project root", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/real-src`, `${root}/real-src/util`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/real-src/util/AGENTS.md`]: "# util\n",
      },
      symlinks: {
        [`${root}/src`]: `${root}/real-src`,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const byPath = Object.fromEntries(result.folders.map((f) => [f.path, f.agentsMd]));
    expect(byPath["src"]).toBe("missing");
    expect(byPath["src/util"]).toBe("present");
  });

  it("bounds canonical ancestor cycles from internal symlinks (self and back-to-root)", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/src`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/src/index.ts`]: "export {}",
      },
      symlinks: {
        // Self-cycle: directory entry that resolves to itself via the parent.
        [`${root}/loop`]: root,
        // Ancestor cycle: child points back at project root.
        [`${root}/src/back`]: root,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const paths = result.folders.map((f) => f.path).sort();
    expect(paths).toEqual(["", "src"]);
    expect(paths).not.toContain("loop");
    expect(paths).not.toContain("src/back");
    // Finite result — no unbounded report-path growth.
    expect(result.folders.length).toBe(2);
  });

  it("does not treat a symlink to a regular file as an eligible directory", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/src`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/src/readme.txt`]: "hello\n",
      },
      symlinks: {
        [`${root}/alias`]: `${root}/src/readme.txt`,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const paths = result.folders.map((f) => f.path);
    expect(paths).toEqual(["", "src"]);
    expect(paths).not.toContain("alias");
  });

  it("covers Author source under .agents and .opencode while excluding installed skills subtree", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [
        root,
        `${root}/.agents`,
        `${root}/.agents/playbooks`,
        `${root}/.agents/skills`,
        `${root}/.agents/skills/writing-for-agents`,
        `${root}/.opencode`,
        `${root}/.opencode/agents`,
        `${root}/.opencode/custom`,
      ],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/.agents/AGENTS.md`]: "# agents root\n",
        [`${root}/.agents/playbooks/AGENTS.md`]: "# playbooks\n",
        [`${root}/.agents/skills/writing-for-agents/SKILL.md`]: "# skill\n",
        [`${root}/.opencode/AGENTS.md`]: "# opencode root\n",
        [`${root}/.opencode/custom/AGENTS.md`]: "# author override\n",
        [`${root}/.opencode/agents/poiesis.md`]: "projection\n",
      },
    });

    const result = await inventoryAgents(root, { fs });
    const byPath = Object.fromEntries(result.folders.map((f) => [f.path, f.agentsMd]));
    expect(byPath[".agents"]).toBe("present");
    expect(byPath[".agents/playbooks"]).toBe("present");
    expect(byPath[".opencode"]).toBe("present");
    expect(byPath[".opencode/custom"]).toBe("present");
    expect(byPath[".opencode/agents"]).toBe("missing");
    expect(byPath[".agents/skills"]).toBeUndefined();
    expect(byPath[".agents/skills/writing-for-agents"]).toBeUndefined();
  });
});

describe("resolveAgentsChain (ticket #209)", () => {
  it("returns root-to-leaf ancestor chain with present/missing status for scoped work", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/src`, `${root}/src/cli`],
      files: {
        [`${root}/AGENTS.md`]: "# root rules\n",
        [`${root}/src/cli/AGENTS.md`]: "# cli rules\n",
        [`${root}/src/cli/main.ts`]: "export {}",
      },
    });

    const chain = await resolveAgentsChain(root, "src/cli/main.ts", { fs });
    expect(chain.target).toBe("src/cli/main.ts");
    expect(chain.chain).toEqual([
      { folder: "", agentsMdPath: "AGENTS.md", status: "present" },
      { folder: "src", agentsMdPath: "src/AGENTS.md", status: "missing" },
      { folder: "src/cli", agentsMdPath: "src/cli/AGENTS.md", status: "present" },
    ]);
    expect(chain.applicable).toEqual(["AGENTS.md", "src/cli/AGENTS.md"]);
  });

  it("refuses path escape outside the project root", async () => {
    const root = "/proj";
    const fs = memoryFs({ root, dirs: [root], files: { [`${root}/AGENTS.md`]: "#\n" } });
    await expect(resolveAgentsChain(root, "../outside", { fs })).rejects.toMatchObject({
      code: "AGENTS_PATH_OUTSIDE_ROOT",
    } satisfies Partial<PoiesisError>);
  });
});

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
    async lstat(path: string) {
      const n = normalize(path);
      if (symlinks.has(n)) {
        return { exists: true as const, isDirectory: false, isFile: false, isSymbolicLink: true };
      }
      if (dirs.has(n)) {
        return { exists: true as const, isDirectory: true, isFile: false, isSymbolicLink: false };
      }
      if (files.has(n)) {
        return { exists: true as const, isDirectory: false, isFile: true, isSymbolicLink: false };
      }
      return { exists: false as const };
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
        // Alias sorts before the real directory name so it is the first
        // logical representative of the shared canonical target.
        [`${root}/alias-src`]: `${root}/real-src`,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const byPath = Object.fromEntries(result.folders.map((f) => [f.path, f.agentsMd]));
    expect(byPath["alias-src"]).toBe("missing");
    expect(byPath["alias-src/util"]).toBe("present");
    // real-src shares the same canonical target — first representative wins.
    expect(byPath["real-src"]).toBeUndefined();
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

  it("ticket #215: excludes canonical aliases into node_modules, .poiesis, skills, and nested-repo descendants", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [
        root,
        `${root}/src`,
        `${root}/node_modules`,
        `${root}/node_modules/pkg`,
        `${root}/.poiesis`,
        `${root}/.poiesis/cache`,
        `${root}/.agents`,
        `${root}/.agents/skills`,
        `${root}/.agents/skills/writing-for-agents`,
        `${root}/vendor-repo`,
        `${root}/vendor-repo/.git`,
        `${root}/vendor-repo/deep`,
        `${root}/vendor-repo/deep/nested`,
        `${root}/real-src`,
        `${root}/real-src/util`,
        `${root}/.hidden-ok`,
      ],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/src/index.ts`]: "export {}",
        [`${root}/node_modules/pkg/index.js`]: "module.exports = {}",
        [`${root}/.poiesis/manifest.json`]: "{}\n",
        [`${root}/.agents/skills/writing-for-agents/SKILL.md`]: "# skill\n",
        // Nested repo: .git as directory marker at vendor-repo, deep descendant
        [`${root}/vendor-repo/.git/HEAD`]: "ref: refs/heads/main\n",
        [`${root}/vendor-repo/deep/nested/file.ts`]: "export {}",
        // Nested repo deep also marked by gitfile
        [`${root}/vendor-repo/deep/nested/.git`]: "gitdir: /elsewhere/git",
        [`${root}/real-src/util/AGENTS.md`]: "# util\n",
        [`${root}/.hidden-ok/AGENTS.md`]: "# hidden\n",
      },
      symlinks: {
        [`${root}/alias-nm`]: `${root}/node_modules/pkg`,
        [`${root}/alias-poiesis`]: `${root}/.poiesis/cache`,
        [`${root}/alias-skills`]: `${root}/.agents/skills/writing-for-agents`,
        [`${root}/alias-nested-deep`]: `${root}/vendor-repo/deep/nested`,
        // Legitimate internal source alias sorts before real-src so it wins
        // as the first logical representative of that canonical target.
        [`${root}/lib-alias`]: `${root}/real-src`,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const paths = result.folders.map((f) => f.path).sort();
    expect(paths).toContain("");
    expect(paths).toContain("src");
    expect(paths).toContain(".hidden-ok");
    expect(paths).toContain("lib-alias");
    expect(paths).toContain("lib-alias/util");
    expect(paths).not.toContain("real-src"); // same canonical as lib-alias; first wins
    expect(paths).not.toContain("alias-nm");
    expect(paths).not.toContain("alias-poiesis");
    expect(paths).not.toContain("alias-skills");
    expect(paths).not.toContain("alias-nested-deep");
    expect(paths).not.toContain("vendor-repo");
    expect(paths).not.toContain("vendor-repo/deep");
    expect(paths).not.toContain("vendor-repo/deep/nested");
    expect(paths).not.toContain("node_modules");
    expect(paths).not.toContain(".poiesis");
    expect(paths).not.toContain(".agents/skills");
  });

  it("ticket #215: canonical visited set dedupes aliases; first sorted logical representative wins", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/real`, `${root}/real/leaf`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/real/leaf/AGENTS.md`]: "# leaf\n",
      },
      symlinks: {
        // Sorted order: a-link before z-link; both target the same canonical real/
        [`${root}/a-link`]: `${root}/real`,
        [`${root}/z-link`]: `${root}/real`,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const paths = result.folders.map((f) => f.path).sort();
    // First logical representative under deterministic sort is a-link (not z-link, not both).
    expect(paths).toContain("a-link");
    expect(paths).toContain("a-link/leaf");
    expect(paths).not.toContain("z-link");
    expect(paths).not.toContain("z-link/leaf");
    // Direct real/ may also appear if visited before aliases — either real or a-link is fine
    // as the single representative family; both real and a-link would double-count canonical.
    const leafRepresentatives = paths.filter((p) => p.endsWith("/leaf") || p === "real/leaf" || p === "a-link/leaf");
    expect(leafRepresentatives.length).toBe(1);
  });

  it("ticket #215: inventory AGENTS presence matches resolver regular-file semantics", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [
        root,
        `${root}/src`,
        `${root}/with-dir-agents`,
        `${root}/with-dir-agents/AGENTS.md`,
        `${root}/internal-target`,
        `${root}/with-dangling`,
        `${root}/with-internal-ok`,
        `/outside`,
      ],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/src/main.ts`]: "export {}",
        [`${root}/internal-target/regular.md`]: "# regular\n",
        [`/outside/AGENTS.md`]: "# external\n",
        [`${root}/with-internal-ok/note.ts`]: "export {}",
      },
      symlinks: {
        [`${root}/src/AGENTS.md`]: `/outside/AGENTS.md`,
        [`${root}/with-external`]: `/outside`,
        [`${root}/with-dangling/AGENTS.md`]: `${root}/does-not-exist.md`,
        [`${root}/with-internal-ok/AGENTS.md`]: `${root}/internal-target/regular.md`,
      },
    });

    const result = await inventoryAgents(root, { fs });
    const byPath = Object.fromEntries(result.folders.map((f) => [f.path, f.agentsMd]));
    expect(byPath[""]).toBe("present");
    expect(byPath["src"]).toBe("missing"); // external AGENTS symlink
    expect(byPath["with-dir-agents"]).toBe("missing"); // AGENTS.md is a directory
    expect(byPath["with-dangling"]).toBe("missing");
    expect(byPath["with-internal-ok"]).toBe("present"); // internal symlink → regular file
    expect(byPath["with-external"]).toBeUndefined(); // external dir symlink excluded

    // Resolver agrees on the same folders.
    const srcChain = await resolveAgentsChain(root, "src/main.ts", { fs });
    expect(srcChain.chain.find((e) => e.folder === "src")?.status).toBe("missing");
    const okChain = await resolveAgentsChain(root, "with-internal-ok/note.ts", { fs });
    expect(okChain.chain.find((e) => e.folder === "with-internal-ok")?.status).toBe("present");
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

  it("treats a hidden/dotted directory as itself so its own AGENTS.md applies", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/.github`, `${root}/.github/workflows`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/.github/AGENTS.md`]: "# github rules\n",
        [`${root}/.github/workflows/ci.yml`]: "name: ci\n",
      },
    });

    const chain = await resolveAgentsChain(root, ".github", { fs });
    expect(chain.target).toBe(".github");
    expect(chain.chain).toEqual([
      { folder: "", agentsMdPath: "AGENTS.md", status: "present" },
      { folder: ".github", agentsMdPath: ".github/AGENTS.md", status: "present" },
    ]);
    expect(chain.applicable).toEqual(["AGENTS.md", ".github/AGENTS.md"]);

    // Nested work under the dotted dir still includes the dotted ancestor.
    const nested = await resolveAgentsChain(root, ".github/workflows/ci.yml", { fs });
    expect(nested.chain.map((e) => e.folder)).toEqual(["", ".github", ".github/workflows"]);
    expect(nested.applicable).toEqual(["AGENTS.md", ".github/AGENTS.md"]);
  });

  it("uses dirname for an extensionless regular file so the containing folder chain applies", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/src`, `${root}/src/cli`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`${root}/src/cli/AGENTS.md`]: "# cli\n",
        // Extensionless executable-style file (not a directory).
        [`${root}/src/cli/run`]: "#!/bin/sh\n",
      },
    });

    const chain = await resolveAgentsChain(root, "src/cli/run", { fs });
    expect(chain.target).toBe("src/cli/run");
    expect(chain.chain).toEqual([
      { folder: "", agentsMdPath: "AGENTS.md", status: "present" },
      { folder: "src", agentsMdPath: "src/AGENTS.md", status: "missing" },
      { folder: "src/cli", agentsMdPath: "src/cli/AGENTS.md", status: "present" },
    ]);
    expect(chain.applicable).toEqual(["AGENTS.md", "src/cli/AGENTS.md"]);
  });

  it("refuses an external directory symlink and never reports the external path", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `/outside/lib`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`/outside/lib/AGENTS.md`]: "# external\n",
      },
      symlinks: {
        [`${root}/linked-out`]: `/outside/lib`,
      },
    });

    await expect(resolveAgentsChain(root, "linked-out", { fs })).rejects.toMatchObject({
      code: "AGENTS_PATH_OUTSIDE_ROOT",
    } satisfies Partial<PoiesisError>);
    await expect(resolveAgentsChain(root, "linked-out/nested", { fs })).rejects.toMatchObject({
      code: "AGENTS_PATH_OUTSIDE_ROOT",
    } satisfies Partial<PoiesisError>);
  });

  it("excludes an external AGENTS.md file symlink (missing, never external path)", async () => {
    const root = "/proj";
    const fs = memoryFs({
      root,
      dirs: [root, `${root}/src`],
      files: {
        [`${root}/AGENTS.md`]: "# root\n",
        [`/outside/AGENTS.md`]: "# external agents\n",
        [`${root}/src/main.ts`]: "export {}",
      },
      symlinks: {
        [`${root}/src/AGENTS.md`]: `/outside/AGENTS.md`,
      },
    });

    const chain = await resolveAgentsChain(root, "src/main.ts", { fs });
    expect(chain.chain).toEqual([
      { folder: "", agentsMdPath: "AGENTS.md", status: "present" },
      { folder: "src", agentsMdPath: "src/AGENTS.md", status: "missing" },
    ]);
    expect(chain.applicable).toEqual(["AGENTS.md"]);
    expect(JSON.stringify(chain)).not.toContain("/outside");
  });
});

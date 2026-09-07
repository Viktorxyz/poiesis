import { join } from "node:path";
import { exists, readUtf8 } from "./fs.js";
import { inspect as inspectGit, type InspectResult } from "./git.js";
import { loadConfig } from "./config.js";
import { loadManifest } from "./manifest.js";
import { PoiesisError } from "./errors.js";
import { resolveGitRoot } from "./paths.js";

export interface ProjectInspection {
  git: InspectResult;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  languages: string[];
  frameworks: string[];
  scripts: Record<string, string>;
  poiesis: {
    installed: boolean;
    version?: string;
    adapter?: string;
    configuredModels?: { reasoning: string; execution: string };
  };
}

export async function inspectProject(cwd: string): Promise<ProjectInspection> {
  const root = await resolveGitRoot(cwd);
  let config;
  let manifest;
  try {
    config = await loadConfig(root);
    manifest = await loadManifest(root);
  } catch (error) {
    if (!(error instanceof Error && /ENOENT/.test(error.message))) {
      if (await exists(join(root, ".poiesis"))) throw error;
    }
  }

  const git = await inspectGit({
    cwd: root,
    ...(config === undefined
      ? {}
      : { remote: config.repository.remote, integrationBranch: config.repository.integrationBranch }),
  });
  const packageJsonPath = join(git.root, "package.json");
  let packageJson: Record<string, unknown> = {};
  if (await exists(packageJsonPath)) {
    try {
      packageJson = JSON.parse(await readUtf8(packageJsonPath)) as Record<string, unknown>;
    } catch (error) {
      throw new PoiesisError("INVALID_PACKAGE_JSON", "package.json is not valid JSON", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const dependencyNames = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const dependencies = packageJson[key];
    if (typeof dependencies === "object" && dependencies !== null) {
      for (const name of Object.keys(dependencies)) dependencyNames.add(name);
    }
  }
  const frameworks = [
    "next",
    "react",
    "vue",
    "svelte",
    "@angular/core",
    "astro",
    "express",
    "fastify",
    "hono",
    "nestjs",
  ].filter((name) => dependencyNames.has(name));
  const scriptsValue = packageJson.scripts;
  const scripts =
    typeof scriptsValue === "object" && scriptsValue !== null
      ? Object.fromEntries(
          Object.entries(scriptsValue).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {};
  return {
    git,
    packageManager: await detectPackageManager(git.root),
    languages: await detectLanguages(git.root),
    frameworks,
    scripts,
    poiesis:
      config === undefined || manifest === undefined
        ? { installed: false }
        : {
            installed: true,
            version: manifest.poiesisVersion,
            adapter: manifest.adapter.harness,
            configuredModels: config.models,
          },
  };
}

async function detectPackageManager(root: string): Promise<ProjectInspection["packageManager"]> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if (await exists(join(root, "bun.lock")) || (await exists(join(root, "bun.lockb")))) return "bun";
  if (await exists(join(root, "package-lock.json"))) return "npm";
  return null;
}

async function detectLanguages(root: string): Promise<string[]> {
  const signals: Array<[string, string[]]> = [
    ["TypeScript", ["tsconfig.json"]],
    ["JavaScript", ["package.json"]],
    ["Python", ["pyproject.toml", "requirements.txt"]],
    ["Rust", ["Cargo.toml"]],
    ["Go", ["go.mod"]],
    ["Ruby", ["Gemfile"]],
    ["PHP", ["composer.json"]],
  ];
  const found: string[] = [];
  for (const [language, files] of signals) {
    if ((await Promise.all(files.map((file) => exists(join(root, file))))).some(Boolean)) found.push(language);
  }
  return found;
}

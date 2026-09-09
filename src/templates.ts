import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { atomicCreate, atomicWrite, exists, readUtf8 } from "./fs.js";
import { PoiesisError } from "./errors.js";
import { packageRoot } from "./paths.js";

export interface TemplateMapping {
  source: string;
  destination: string;
  kind: "canonical" | "generated";
  /** Files in this group are durable project files and should normally be tracked. */
  trackInProject?: boolean;
}

export interface TemplateGroup {
  /** Gitignore pattern group prefix; canonical files in this group are project-tracked. */
  tracked: boolean;
}

export const templateMappings: TemplateMapping[] = [
  { source: "POIESIS_PHILOSOPHY.md", destination: ".poiesis/PHILOSOPHY.md", kind: "canonical", trackInProject: true },
  { source: "POIESIS_METHOD.md", destination: ".poiesis/METHOD.md", kind: "canonical", trackInProject: true },
  { source: "POIESIS_ROLE_POIESIS.md", destination: ".poiesis/roles/poiesis.md", kind: "canonical", trackInProject: true },
  { source: "POIESIS_ROLE_PLANNER.md", destination: ".poiesis/roles/planner.md", kind: "canonical", trackInProject: true },
  { source: "POIESIS_ROLE_WORKER.md", destination: ".poiesis/roles/worker.md", kind: "canonical", trackInProject: true },
  { source: "POIESIS_ROLE_RESEARCH.md", destination: ".poiesis/roles/research.md", kind: "canonical", trackInProject: true },
  { source: "POIESIS_ROLE_REVIEWER.md", destination: ".poiesis/roles/reviewer.md", kind: "canonical", trackInProject: true },
  { source: "OPENCODE_AGENT_POIESIS.md", destination: ".opencode/agents/poiesis.md", kind: "generated", trackInProject: true },
  { source: "OPENCODE_AGENT_PLANNER.md", destination: ".opencode/agents/poiesis-planner.md", kind: "generated", trackInProject: true },
  { source: "OPENCODE_AGENT_WORKER.md", destination: ".opencode/agents/poiesis-worker.md", kind: "generated", trackInProject: true },
  { source: "OPENCODE_AGENT_RESEARCH.md", destination: ".opencode/agents/poiesis-research.md", kind: "generated", trackInProject: true },
  { source: "OPENCODE_AGENT_REVIEWER.md", destination: ".opencode/agents/poiesis-reviewer.md", kind: "generated", trackInProject: true },
  { source: "OPENCODE_AGENT_FINAL_REVIEWER.md", destination: ".opencode/agents/poiesis-final-reviewer.md", kind: "generated", trackInProject: true },
];

export const POIESIS_DURABLE_PATHS: readonly string[] = templateMappings
  .filter((mapping) => mapping.trackInProject === true)
  .map((mapping) => mapping.destination);

export const POIESIS_LOCAL_STATE_PATHS: readonly string[] = [".poiesis/manifest.json"];

export async function ensureGitignore(root: string, lines: string[], expected?: Buffer | null): Promise<string | undefined> {
  const gitignorePath = join(root, ".gitignore");
  const present = await exists(gitignorePath);
  const existingBytes = present ? await readFile(gitignorePath) : null;
  if (
    expected !== undefined &&
    (expected === null ? existingBytes !== null : existingBytes === null || !expected.equals(existingBytes))
  ) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore changed during initialization", {
      path: ".gitignore",
    });
  }
  const existing = existingBytes?.toString("utf8") ?? "";
  if (existingBytes !== null && !Buffer.from(existing, "utf8").equals(existingBytes)) {
    throw new PoiesisError("INSTALL_PATH_CONFLICT", "Git ignore is not valid UTF-8", { path: ".gitignore" });
  }
  const entries = existing.split(/\r?\n/);
  const additions: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (entries.some((entry) => entry.trim() === trimmed)) continue;
    additions.push(line);
  }
  if (additions.length === 0) return undefined;
  const block = ["", "# Poiesis-managed ignore rules (added by `poiesis init`)"].concat(additions).join("\n");
  const content = `${existing.replace(/\n*$/, "\n")}${block}\n`;
  if (present) await atomicWrite(gitignorePath, content);
  else await atomicCreate(gitignorePath, content);
  return content;
}

export async function readTemplate(source: string): Promise<string> {
  return readUtf8(join(packageRoot, source));
}

import { join } from "node:path";
import { readUtf8 } from "./fs.js";
import { packageRoot } from "./paths.js";

export interface TemplateMapping {
  source: string;
  destination: string;
  kind: "canonical" | "generated";
}

export const templateMappings: TemplateMapping[] = [
  { source: "POIESIS_PHILOSOPHY.md", destination: ".poiesis/PHILOSOPHY.md", kind: "canonical" },
  { source: "POIESIS_METHOD.md", destination: ".poiesis/METHOD.md", kind: "canonical" },
  { source: "POIESIS_ROLE_POIESIS.md", destination: ".poiesis/roles/poiesis.md", kind: "canonical" },
  { source: "POIESIS_ROLE_PLANNER.md", destination: ".poiesis/roles/planner.md", kind: "canonical" },
  { source: "POIESIS_ROLE_WORKER.md", destination: ".poiesis/roles/worker.md", kind: "canonical" },
  { source: "POIESIS_ROLE_RESEARCH.md", destination: ".poiesis/roles/research.md", kind: "canonical" },
  { source: "POIESIS_ROLE_REVIEWER.md", destination: ".poiesis/roles/reviewer.md", kind: "canonical" },
  { source: "OPENCODE_AGENT_POIESIS.md", destination: ".opencode/agents/poiesis.md", kind: "generated" },
  { source: "OPENCODE_AGENT_PLANNER.md", destination: ".opencode/agents/poiesis-planner.md", kind: "generated" },
  { source: "OPENCODE_AGENT_WORKER.md", destination: ".opencode/agents/poiesis-worker.md", kind: "generated" },
  { source: "OPENCODE_AGENT_RESEARCH.md", destination: ".opencode/agents/poiesis-research.md", kind: "generated" },
  { source: "OPENCODE_AGENT_REVIEWER.md", destination: ".opencode/agents/poiesis-reviewer.md", kind: "generated" },
  { source: "OPENCODE_AGENT_FINAL_REVIEWER.md", destination: ".opencode/agents/poiesis-final-reviewer.md", kind: "generated" },
];

export async function readTemplate(source: string): Promise<string> {
  return readUtf8(join(packageRoot, source));
}

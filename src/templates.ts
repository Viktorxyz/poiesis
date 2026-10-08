import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { atomicCreate, atomicWrite, exists, readUtf8 } from "./fs.js";
import { PoiesisError } from "./errors.js";
import { packageRoot } from "./paths.js";
import { planManagedIgnoreBlock, parseManagedIgnoreBlocks, type InstallMode, type ManagedIgnorePlan } from "./install-mode.js";

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

/**
 * Spec #190 / ticket #191 — the generated OpenCode agent projections.
 *
 * These are Poiesis-owned projections of package-supplied canon, so the
 * private ignore classification names them one by one. `.opencode/`
 * itself belongs to the Author and is never ignored as a whole.
 */
export const POIESIS_GENERATED_AGENT_PATHS: readonly string[] = templateMappings
  .filter((mapping) => mapping.kind === "generated")
  .map((mapping) => mapping.destination);

export interface EnsureGitignoreOptions {
  /**
   * Spec #190 / ticket #191: the installation mode whose managed block
   * owns these lines. `init` supplies it, so the block it creates is
   * uniquely delimited and mode-labelled.
   *
   * The receipt-bearing update / bootstrap transactions deliberately
   * omit it: they reconcile ONE extra rule inside whatever block already
   * exists and must never invent a block (nor a mode) for an installation
   * that never chose one. A pre-Spec #190 install that has no block
   * keeps the legacy appended-rules shape so its existing rollback
   * contract and its already-installed state stay byte-compatible.
   */
  mode?: InstallMode;
}

/**
 * Append `lines` to `.gitignore`, inside the one Poiesis-managed block
 * when `options.mode` is supplied or a block already exists.
 *
 * The drift guard (`expected`) keeps its exact meaning: `null` means the
 * file must still be absent, a `Buffer` means it must still be exactly
 * those bytes. Returns the post-write content, or `undefined` when the
 * file already states everything requested and is therefore left
 * untouched.
 *
 * Every malformed / duplicate / conflicting block raises a typed
 * `GITIGNORE_BLOCK_*` error BEFORE any write, so a damaged policy is
 * reported rather than merged around.
 */
export async function ensureGitignore(
  root: string,
  lines: string[],
  expected?: Buffer | null,
  options: EnsureGitignoreOptions = {},
): Promise<string | undefined> {
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

  const plan = options.mode === undefined
    ? reconcileWithoutMode(existingBytes === null ? null : existing, lines)
    : planManagedIgnoreBlock({
        existing: existingBytes === null ? null : existing,
        mode: options.mode,
        lines,
      });
  if (!plan.changed || plan.content === null) return undefined;
  const content = plan.content;
  if (present) await atomicWrite(gitignorePath, content);
  else await atomicCreate(gitignorePath, content);
  return content;
}

/**
 * The mode-less reconcile path for the receipt-bearing update / bootstrap
 * transactions.
 *
 * When a managed block already exists, the requested lines merge into it
 * under its OWN recorded label: a transaction that only needs one more
 * rule must not claim the installation's sharing mode, and must never
 * produce a second block. When no block exists at all — a pre-Spec #190
 * installation that never chose a mode — the rules are appended in the
 * legacy shape rather than fabricating a labelled block nobody selected.
 */
function reconcileWithoutMode(existing: string | null, lines: string[]): ManagedIgnorePlan {
  const [block] = parseManagedIgnoreBlocks(existing ?? "");
  if (block !== undefined) {
    return planManagedIgnoreBlock({ existing, mode: block.mode, lines });
  }
  const entries = (existing ?? "").split(/\r?\n/);
  const additions: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (entries.some((entry) => entry.trim() === trimmed)) continue;
    additions.push(line);
  }
  if (additions.length === 0) return { changed: false, content: null, block: null, fileExisted: existing !== null };
  const appended = ["", "# Poiesis-managed ignore rules (added by `poiesis init`)"].concat(additions).join("\n");
  return {
    changed: true,
    content: `${(existing ?? "").replace(/\n*$/, "\n")}${appended}\n`,
    block: null,
    fileExisted: existing !== null,
  };
}

export async function readTemplate(source: string): Promise<string> {
  return readUtf8(join(packageRoot, source));
}

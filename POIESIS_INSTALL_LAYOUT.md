# Poiesis v1 Install Layout

This source bundle is intentionally flat so it can live in `/poiesis` during implementation.

The installer must project these source files into a consumer repository as follows.

## Canonical Poiesis files

These source files are projected into the consumer repo by the runtime (`src/templates.ts::templateMappings` and the `init`/`update`/`update --config` transactions). They are also included in the published `poiesis-cli` package per `package.json::files[]`.

| Source file in `/poiesis` | Installed consumer path |
|---|---|
| `POIESIS_PHILOSOPHY.md` | `.poiesis/PHILOSOPHY.md` |
| `POIESIS_METHOD.md` | `.poiesis/METHOD.md` |
| `POIESIS_CONFIG_TEMPLATE.jsonc` | `.poiesis/config.jsonc` after init resolves values |
| `POIESIS_ROLE_POIESIS.md` | `.poiesis/roles/poiesis.md` |
| `POIESIS_ROLE_PLANNER.md` | `.poiesis/roles/planner.md` |
| `POIESIS_ROLE_WORKER.md` | `.poiesis/roles/worker.md` |
| `POIESIS_ROLE_RESEARCH.md` | `.poiesis/roles/research.md` |
| `POIESIS_ROLE_REVIEWER.md` | `.poiesis/roles/reviewer.md` |

`POIESIS_MANIFEST_TEMPLATE.json` is a **legacy design reference only.** The runtime programmatically constructs the Manifest object inside the `init` flow in `src/maintenance.ts` (around `materializeFiles(config)` and the per-file `managedFiles.push({ ..., hash: hashContent(file.content) })` loop), where each managed file's bytes are read from the live `templateMappings` (via `src/templates.ts::templateMappings`) and the resulting `Manifest` literal is later stringified for write via `src/manifest.ts::serializeManifest()`. The template is **not** read by `src/templates.ts`, **not** in `package.json::files[]`, and **not** shipped in the published package — its only purpose is documenting the manifest shape for human readers.

`POIESIS_SKILLS.json` is installer source metadata. It is not required to be copied into `.poiesis/` unless implementation later proves a runtime need.

## OpenCode first-adapter projections

| Source file in `/poiesis` | Installed consumer path |
|---|---|
| `OPENCODE_AGENT_POIESIS.md` | `.opencode/agents/poiesis.md` |
| `OPENCODE_AGENT_PLANNER.md` | `.opencode/agents/poiesis-planner.md` |
| `OPENCODE_AGENT_WORKER.md` | `.opencode/agents/poiesis-worker.md` |
| `OPENCODE_AGENT_RESEARCH.md` | `.opencode/agents/poiesis-research.md` |
| `OPENCODE_AGENT_REVIEWER.md` | `.opencode/agents/poiesis-reviewer.md` |
| `OPENCODE_AGENT_FINAL_REVIEWER.md` | `.opencode/agents/poiesis-final-reviewer.md` |

`OPENCODE_CONFIG_PATCH_V2.jsonc` is a merge template/specification, **not** a file to copy verbatim.

The installer must:
1. inspect the current project OpenCode config;
2. validate the current OpenCode schema/version;
3. merge only the Poiesis-managed keys;
4. substitute actual reasoning/execution model IDs;
5. preserve all unrelated project/user config;
6. record exact managed mutations in `.poiesis/manifest.json`.

The generated manifest is valid only for the currently installed OpenCode adapter contract. `doctor`, `update`, `uninstall`, and capability installation share one authority validator: current schema and adapter versions, exact managed file paths/kinds/durable flags, exactly one recognized OpenCode config filename, exact desired patch paths and installed values keyed by file plus JSON path, and exact skill name/source/path relationships. Extra or unknown records, including README, `.git`, `package.json` patches, or unsupported versions, fail closed with an explicit migration requirement and must not be copied forward.

## Skills

Install the curated skills through their current supported upstream mechanism.

Prefer current standard project-local Agent Skills location supported by the target OpenCode version.

Do not vendor the skill bodies into Poiesis.

## `AGENTS.md`

Do not modify project `AGENTS.md` by default.

## OpenCode adapter v1 projection

The OpenCode projection files in this bundle target the **adapter-version-1** OpenCode config schema, verified against supported OpenCode tags `1.18.29` and `1.18.30` (see `COMPATIBILITY.md` and `src/opencode.ts::SUPPORTED_OPENCODE_VERSIONS`). OpenCode-specific projection syntax below is **adapter-syntax**, not harness-neutral Poiesis semantics; the Poiesis method, role files, and CLI surface remain harness-neutral.

`poiesis-reviewer` and `poiesis-final-reviewer` are two harness projections of the same canonical `.poiesis/roles/reviewer.md`: the first is execution-model ticket review; the second is reasoning-model final Spec/Standards review. This duplication exists only because current OpenCode binds model choice to the agent definition rather than allowing per-subagent-call model selection.

These projections target:
- Markdown body is the agent `system`;
- Singular `agent` map at the config root (NOT plural `agents`);
- Each `agent.<name>` carries a singular `permission` object (NOT plural `permissions` rules, NOT ordered rule lists);
- `mode` is `primary` or `subagent`;
- Permission keys are the singular V1 names such as `bash`, `task`, `skill`, `edit`, `read`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `todowrite`, `question` (NOT the V2 names `shell`, `subagent`, etc., which are not accepted by `1.18.29` / `1.18.30`);
- The literal `"*"` entry inside `permission` denies everything else.

The implementation must still validate the installed OpenCode version/schema before applying changes.

Do not add undocumented compatibility branches, do not reintroduce the legacy plural `agents` / `permissions` shape, and do not reintroduce legacy action names such as `shell` / `subagent` unless a concrete supported target requires it. The historical `OPENCODE_CONFIG_PATCH_V2.jsonc` is design-intent only and is **not** copied into projects.

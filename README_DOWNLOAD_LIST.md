# Poiesis v1.1 Source Bundle — Download List

Put **all files from this bundle directly in `/poiesis` root**. Do not organize them into subfolders.

The implementation agent will use `POIESIS_INSTALL_LAYOUT.md` to project them into the correct consumer-repository paths.

## Canonical design
- `POIESIS_FOUNDATION_v1.1.md`
- `POIESIS_PHILOSOPHY.md`
- `POIESIS_METHOD.md`

## Canonical role sources
- `POIESIS_ROLE_POIESIS.md`
- `POIESIS_ROLE_PLANNER.md`
- `POIESIS_ROLE_WORKER.md`
- `POIESIS_ROLE_RESEARCH.md`
- `POIESIS_ROLE_REVIEWER.md`

## Installer/config sources
- `POIESIS_CONFIG_TEMPLATE.jsonc`
- `POIESIS_SKILLS.json`
- `POIESIS_INSTALL_LAYOUT.md`

`POIESIS_MANIFEST_TEMPLATE.json` is a legacy design reference only — the runtime programmatically constructs the `Manifest` object inside the `init` flow in `src/maintenance.ts` (around `materializeFiles(config)` and the per-file `managedFiles.push({ ..., hash: hashContent(file.content) })` loop), where each managed file's bytes are read from the live `templateMappings` (via `src/templates.ts::templateMappings`) and the resulting `Manifest` literal is later stringified for write via `src/manifest.ts::serializeManifest()`. The template is not consumed by `src/templates.ts`, not listed in `package.json::files[]`, and not shipped in the published package. Keep it in the bundle for human readers only.

## OpenCode adapter sources
- `OPENCODE_AGENT_POIESIS.md`
- `OPENCODE_AGENT_PLANNER.md`
- `OPENCODE_AGENT_WORKER.md`
- `OPENCODE_AGENT_RESEARCH.md`
- `OPENCODE_AGENT_REVIEWER.md`
- `OPENCODE_AGENT_FINAL_REVIEWER.md`
- `OPENCODE_CONFIG_PATCH_V2.jsonc`

## Implementation
- `POIESIS_IMPLEMENTATION_HANDOFF_FINAL.md`

Do **not** include older Foundation/review/audit drafts in the implementation directory unless you deliberately want historical research available. They are not needed for the build and can create ambiguity.

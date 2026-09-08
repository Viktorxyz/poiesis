# Poiesis

A deterministic runtime for turning human intent into working, proven software.

The Author speaks to one visible agent. Planner, Worker, Research, Reviewer, Git, trackers, skills, and delivery systems remain internal machinery.

```text
Author:  I have an idea.
Poiesis: Tell me.
```

## What Poiesis does

Poiesis combines:

- a harness-neutral method (Express → Understand → Authorize → Prepare → Capability Check → Plan → Specify → Tickets → Realize → Prove → Publish → Preview → Author validation → freshness → Staging → Integrate → Production authorization → Release → Complete);
- a small TypeScript / Node.js CLI for exact mechanics (`init`, `doctor`, `update`, `uninstall`, `inspect`, `capability`, `workspace`, `checkpoint`, `verify`, `publish`, `preview`, `promote`, `integrate`, `tracker`, `session`);
- a first OpenCode `1.18.29` adapter.

Poiesis is not a workflow database, not an OpenCode plugin, and does not own your `AGENTS.md`.

## Requirements

- Node.js `>=22.20.0`
- Git
- OpenCode `1.18.29`
- For GitHub projects: GitHub CLI (`gh`) authenticated for the target repository
- For GitLab projects: GitLab CLI (`glab`) authenticated for the target project
- A configured Preview, Staging, and Production delivery target (see [Preview and Staging](#preview-and-staging))

## Install

Poiesis is published as the `poiesis-cli` npm package. The CLI binary is named `poiesis` (`poiesis` is already occupied by an unrelated package on the public registry).

### First-time init

In a real Git repository:

```bash
pnpm dlx poiesis-cli@latest init --config ./poiesis-config.jsonc
```

`init` resolves the project's Git remote and integration branch automatically, validates the configured models against the local OpenCode model inventory, verifies the configured tracker, and verifies the configured delivery adapters. It installs the canonical method/role files, the OpenCode agent projections, the 11 curated Poiesis skills, and runs `doctor`.

You can also point `init` at a discovered remote by hand:

```bash
pnpm dlx poiesis-cli@latest init --config ./poiesis-config.jsonc --remote origin --integration-branch main
```

`doctor` runs without mutation and verifies the same set of invariants any time:

```bash
pnpm dlx poiesis-cli@latest doctor
```

`update` re-reads the installed canonical files and re-applies the OpenCode adapter projection only against proven-owned state:

```bash
pnpm dlx poiesis-cli@latest update
```

`uninstall` removes only Poiesis-proven-owned state and preserves Git, tracker, PR/MR, and release history:

```bash
pnpm dlx poiesis-cli@latest uninstall
```

## What `init` needs from a config file

`init` cannot run from nothing because every project makes a real choice that only the Author owns. The minimal config file is:

```jsonc
{
  "schema": 1,
  "models": {
    "reasoning": "<provider/model>",
    "execution": "<provider/model>"
  },
  "tracker": {
    "provider": "github",
    "project": "<owner/repository>"
  },
  "delivery": {
    "preview": { "adapter": "command", "command": ["scripts/poiesis-preview.mjs", "{sha}"] },
    "staging": { "adapter": "command", "command": ["scripts/poiesis-staging.mjs", "{sha}"] },
    "production": { "adapter": "command", "command": ["scripts/poiesis-production.mjs", "{sha}"] }
  }
}
```

`repository.remote` and `repository.integrationBranch` are auto-discovered from the Git repository when omitted. `verification.commands` are auto-derived from the project's package manager and test scripts.

## Preview and Staging

Preview and Staging are project-specific. Poiesis never substitutes a JSON evidence file for a real preview/staging target.

The delivery adapter is a deterministic command. The command must:

- accept the exact candidate SHA as the `{sha}` placeholder;
- read the exact tree from `POIESIS_CANDIDATE_TREE` and the source Preview or Staging receipt from `POIESIS_DELIVERY_IDENTITY` when promoting;
- run a real previewable artifact or required target health verification;
- emit JSON containing exact `sha`, `candidateTree`, `target`, `verified: true`, and `artifactIdentity`;
- emit at least one of `id`, `url`, or `artifact` whose value equals `artifactIdentity`.

Preview returns a candidate-bound receipt. Staging consumes that Preview receipt and returns a new Staging receipt; callers do not predeclare Staging success. Integration consumes the Staging receipt directly and returns its complete Integration evidence. Production accepts only a Staging-target receipt, preventing a Preview identity from being relabeled as Staging.

For projects with no existing preview/staging infrastructure, Poiesis uses a fixture adapter (`adapter: "fixture"` plus an external path) that is test-only and requires `--allow-fixtures`.

## Operations

```text
init                    install owned method and adapter files
doctor                  inspect health without mutation
update                  update only proven-owned files and skills
uninstall               remove only proven-owned state
inspect                 return bounded project and Git facts
capability install      install one selected, revision-pinned skill
workspace prepare       create an isolated owned branch/worktree
checkpoint              commit an accepted reviewed ticket
verify                  run checks against an exact clean SHA
publish                 push and create/update a PR/MR after Proof
preview                 create Preview for the exact proven candidate
promote                 promote an immutable identity to Staging or Production
integrate               squash-integrate a fresh accepted staged candidate
workspace cleanup       fail closed unless work is clean and delivered
tracker                 mechanical Spec and ticket operations
session cleanup         best-effort OpenCode child-session hygiene
```

Every command emits structured JSON. Run `poiesis help` for command syntax.

## Safety

- Poiesis never overwrites or deletes a file, config value, skill, worktree, or branch it cannot prove ownership of.
- `doctor` is read-only.
- Failed implementation attempts are never checkpointed.
- History rewriting is refused: `publish` only accepts non-forcing fast-forward updates of the Poiesis-owned remote change branch.
- Production promotion requires separate explicit Author authorization evidence plus the operation-produced Staging receipt and content-equal Integration evidence.
- Fixture tracker and delivery adapters exist only for disposable integration tests and bootstrap dogfood; they are not supported production infrastructure.

## Development

```bash
pnpm check
pnpm test
pnpm build
```

The canonical design is `POIESIS_FOUNDATION_v1.1.md` (kept in the GitHub repository, not the npm tarball). The installed operational projections are `POIESIS_PHILOSOPHY.md` and `POIESIS_METHOD.md`.

## License

MIT

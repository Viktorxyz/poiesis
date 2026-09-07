# Poiesis

Poiesis is a philosophy and deterministic runtime for turning human intent into working, proven software.

It combines:

- a harness-neutral method;
- a small TypeScript/Node.js CLI for exact mechanics;
- an OpenCode `1.18.29` adapter.

The Author speaks to one visible agent. Planner, Worker, Research, Reviewer, Git, trackers, skills, and delivery systems remain internal machinery.

## Requirements

- Node.js `>=22.20.0`
- Git
- pnpm for development
- OpenCode `1.18.29`
- GitHub CLI for GitHub projects, or GitLab CLI for GitLab projects
- configured Preview, Staging, and Production delivery commands

## Install

```bash
pnpm dlx poiesis-cli@latest init --config ./poiesis.config.jsonc
```

Or for local development:

```bash
pnpm install
pnpm build
pnpm link --global
poiesis init --config ./poiesis.config.jsonc
poiesis doctor
```

The binary is named `poiesis`. The npm package name is currently `poiesis-cli`; the unscoped `poiesis` name is already occupied by an unrelated package.

OpenCode loads configuration at startup. Restart OpenCode after `init`, `update`, or `uninstall`.

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
promote                 promote an immutable identity to Staging/Production
integrate               squash-integrate a fresh accepted staged candidate
workspace cleanup       fail closed unless work is clean and delivered
tracker                 mechanical Spec and ticket operations
session cleanup         best-effort OpenCode child-session hygiene
```

Every command emits structured JSON. Run `poiesis help` for command syntax.

## Safety

Poiesis does not overwrite or delete a file, config value, skill, worktree, or branch unless it can prove ownership. `doctor` is read-only. Failed implementation attempts are never checkpointed. History rewriting is refused; `publish` fails safely when the remote change branch already exists. Production promotion requires separate Author authorization evidence plus content-equal Staging and Integration evidence.

Fixture tracker and delivery adapters exist only for disposable integration tests and bootstrap dogfood. They are not supported production infrastructure.

## Development

```bash
pnpm check
pnpm test
pnpm build
```

The canonical design is `POIESIS_FOUNDATION_v1.1.md`; the installed operational projections are `POIESIS_PHILOSOPHY.md` and `POIESIS_METHOD.md`.

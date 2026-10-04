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
- a first OpenCode `1.18.29` / `1.18.30` / `1.18.31` adapter (explicit adapter-version-1 supported set).

Poiesis is not a workflow database, not an OpenCode plugin, and does not own your `AGENTS.md`.

## Requirements

- Node.js `>=22.20.0`
- Git
- OpenCode `1.18.29`, `1.18.30`, or `1.18.31` (see [COMPATIBILITY.md](./COMPATIBILITY.md) for the verified adapter-v1 contract)
- **Repository Intelligence standard requirement (Poiesis v1.2):** `uv` (https://docs.astral.sh/uv/) on PATH. `uv` is the exact-version runtime that launches the pinned default engine behind the deterministic `poiesis repository` surface; it is invoked via `uvx --python 3.12 --from graphifyy==<pin> graphify ...`. A missing `uv` makes `poiesis init` and `poiesis update` fail closed before any canonical mutation with the typed `REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING` error; `poiesis doctor` reports the same condition as a hard `fail`. Poiesis does not install `uv`, does not vendor Python, does not offer a fallback flag, and does not ask the Author a question about it.
- For GitHub projects: GitHub CLI (`gh`) authenticated for the target repository
- For GitLab projects: GitLab CLI (`glab`) authenticated for the target project
- For Linear projects: exactly one of `LINEAR_API_KEY` or `LINEAR_OAUTH_TOKEN` in the environment — never in the config (see [Trackers](#trackers))
- A configured Preview, Staging, and Production delivery target, or an explicit deferred state (see [Configured and deferred delivery](#configured-and-deferred-delivery))

## Install

Poiesis is published as the `poiesis-cli` npm package. The CLI binary is named `poiesis` (`poiesis` is already occupied by an unrelated package on the public registry).

### First-time init

In a real Git repository, the human happy path is flagless:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest init
```

The `@latest` tag is reserved for the human/operator intentional first
install. Every `@latest` route documented here uses the fresh-latest
form `pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest ...`
so the documented command always resolves the current npm `@latest`
tag rather than a 1440-minute pnpm `dlx` cache entry. The
runtime-generated normal installed lifecycle route is exactly
`pnpm dlx poiesis-cli@<X>` where `X` is the sole durable
`manifest.poiesisVersion`; the OpenCode config projected into the
consumer repository reflects this exactly. After `init`, every later
Poiesis-driven shell command goes through the exact-version route so
the runtime identity boundary is never ambiguous. The OpenCode
projection explicitly denies every version-qualified `pnpm dlx
poiesis-cli@*` variant (including the bare `@latest`) so only the
exact-version route survives.

`poiesis init` with no flags runs the interactive TTY flow. It discovers the Git remote, integration branch, package verification scripts, OpenCode model inventory, and `scripts/poiesis-{preview,staging,production}` hints; prints every detection on stderr; prompts only the remaining Author-owned choices (models via the shared selector, the tracker and its coordinates, whether delivery is configured now or deferred, ambiguous remote, real delivery command argv with `{sha}`); probes tracker auth (`gh` / `glab`, or a Linear credential in the environment); and then calls the existing ownership install transaction. After success, restart OpenCode to load the new agent projections — Poiesis does not restart OpenCode on the Author's behalf. A non-TTY invocation without `--config` fails closed with `NON_TTY_INIT`.

`init` resolves the project's Git remote and integration branch automatically, validates the configured models against the local OpenCode model inventory, verifies the configured tracker, and verifies the configured delivery adapters. It installs the canonical method/role files, the OpenCode agent projections, the 11 curated Poiesis skills, and runs `doctor`.

The repository remote and integration branch are not CLI options — they are read from the Git repository directly. The config file described below is the **output** of `init`, not the input: a successful `init` writes a resolved `.poiesis/config.jsonc` plus the manifest, and that resolved file is what subsequent operations consume.

#### Non-interactive init (automation only)

For CI / scripted use, `init` accepts the same resolved config file via `--config`. The flag is reserved for non-TTY invocations and reproducible automation:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest init --config ./poiesis-config.jsonc
```

A non-TTY invocation **without** `--config` fails closed with `NON_TTY_INIT` rather than guessing; the structured path is the supported automation contract. The repository remote and integration branch are still read from the Git repository directly — `repository.remote` and `repository.integrationBranch` keys in the config file are accepted for completeness but the Git repository is the source of truth.

`doctor` runs without mutation and verifies the same set of invariants any time:

```bash
pnpm dlx poiesis-cli@<manifest.poiesisVersion> doctor
```

`update` re-reads the installed canonical files and re-applies the OpenCode adapter projection only against proven-owned state. As same-version reconciliation, it stays on the exact-version route so the on-disk files match what the receipt proves is installed:

```bash
pnpm dlx poiesis-cli@<manifest.poiesisVersion> update
```

The plain `update` invocation is also the **intentional human upgrade** path: when the operator explicitly wants to resolve the current `@latest` published tag (for example after a new Poiesis release), the launcher must bypass the 1440-minute `dlx` cache so the command reflects the npm tag rather than a stale entry:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update
```

Same-version reconciliation and intentional human upgrade are distinct: the former stays pinned to `manifest.poiesisVersion`, the latter uses the fresh-latest `@latest` form. The OpenCode config projection only ever admits the exact-version route; the fresh-latest form is reserved for the human/operator shell.

Installations created by public `poiesis-cli@1.0.0` have no trusted receipt. Ordinary `update` therefore refuses them. An operator may establish that first trust only with an explicit one-time bootstrap after the known 1.0.0 contract is fully validated. This is operator authority, not cryptographic proof that the checkout-controlled 1.0.0 manifest was originally authored by Poiesis:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update --bootstrap-legacy-ownership
```

After that command succeeds, later `doctor`, `update`, `uninstall`, and capability installation use the normal receipt-backed rules. The flag is rejected if a receipt already exists or the installation is not exactly 1.0.0.

### Everyday commands: `pnpm poiesis <command>`

Once a project is installed, you rarely need to spell out a launcher at
all. `poiesis init` and `poiesis update` maintain a single `poiesis`
script in the project's own `package.json`, so the everyday human command
surface is:

```bash
pnpm poiesis doctor
pnpm poiesis model set reasoning openai/gpt-5.6-sol
pnpm poiesis update
```

Poiesis writes exactly one entry, and never overwrites a `poiesis` script
you defined yourself — a conflicting script fails `init` closed instead:

```json
"scripts": {
  "poiesis": "pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest"
}
```

The value is deliberately `@latest`, not a pinned version: you are never
asked to remember or type one. It also carries
`--config.dlx-cache-max-age=0` so the command bypasses pnpm's 1440-minute
`dlx` resolution cache and always resolves the newest published release —
without that flag a `pnpm poiesis update` could silently run a stale
cached version. The flag lives in `package.json`, so you never type it.

This is the **human** route only. The exact-version route
`pnpm dlx poiesis-cli@<X>` (where `X` is the sole durable
`manifest.poiesisVersion`) remains the runtime identity the OpenCode
config projection admits, and the projected agent permissions still deny
every version-qualified and `@latest` `dlx` variant. The script is
inert after `uninstall` — it reports that the project is not installed,
which is also how you reinstall.

### Updating the managed config

`.poiesis/config.jsonc` is a managed surface — Poiesis generated it from a
successful `init`, and ordinary editing would create a stale configuration
that nothing would reconcile. The supported update path is the intentional
managed-config workflow:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update --config ./poiesis-config.jsonc
```

`update --config <path>` is the only sanctioned way to change the managed
configuration after `init`. The command is narrowly scoped: it parses,
validates, and resolves the proposed config first; authenticates the trusted
ownership receipt; verifies the on-disk `.poiesis/config.jsonc` still matches
the manifest's recorded hash; verifies every recorded OpenCode config patch is
still owned; computes the new `.poiesis/config.jsonc` bytes and the new
OpenCode projection in memory; and only then writes — atomically, in this
fixed order: `.poiesis/config.jsonc`, then the OpenCode config, then
`.poiesis/manifest.json`, then the ownership receipt — before `doctor` gates
the result.

`update --config` is deliberately incompatible with the registered
`--skip-skills` and `--bootstrap-legacy-ownership` flags. The CLI rejects
those combinations with `INCOMPATIBLE_UPDATE_OPTIONS` before reaching the
maintenance surface. The transaction is config-only: it does not bootstrap
legacy ownership, install skills, or accept fixture adapters.

If the intended serialized Poiesis config bytes equal the bytes currently on
disk for `.poiesis/config.jsonc` AND the intended projected OpenCode config
bytes equal the bytes currently on disk for the OpenCode config, `update
--config` is a **no-op**: it returns the existing manifest unchanged and
does not advance the ownership receipt generation. (The OpenCode config is
owned through per-field manifest config patches rather than a whole-file
record, so the comparison is direct byte equality against the on-disk file,
not against a single recorded hash.) A repeated identical config cannot
double-advance.

If any write step fails after the transaction has started, `update --config`
runs **transactional rollback**: each mutated artifact is restored to its
pre-write snapshot only if its post-write hash still matches what was written
by the failing step. The Poiesis config, the OpenCode config, the manifest,
and the ownership receipt are all restored, leaving the installation
byte-for-byte identical to its pre-transaction state.

Editing `.poiesis/config.jsonc` by hand is a **fail-closed manual edit**. The
manifest records the hash that `init` (or the previous successful transaction)
wrote; on the next `update --config` the maintenance surface refuses the
transaction with `FILE_OWNERSHIP_LOST` and the proposed config is rejected
before any side effect.

`uninstall` removes only Poiesis-proven-owned state and preserves Git, tracker, PR/MR, and release history:

```bash
pnpm dlx poiesis-cli@<manifest.poiesisVersion> uninstall
```

## What `init` produces

`init` cannot run from nothing because every project makes a real choice that only the Author owns. The interactive flow discovers everything it can and asks only for the Author-owned decisions. The successful install writes a resolved `.poiesis/config.jsonc` shaped like:

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
    "preview": { "adapter": "command", "command": ["node", "scripts/poiesis-preview.mjs", "{sha}", "{target}"] },
    "staging": { "adapter": "command", "command": ["node", "scripts/poiesis-staging.mjs", "{sha}", "{target}"] },
    "production": { "adapter": "command", "command": ["node", "scripts/poiesis-production.mjs", "{sha}", "{target}"] }
  }
}
```

The same shape is the accepted input to `init --config` (for non-interactive / scripted use) and `update --config` (for managed configuration changes after init). `repository.remote` and `repository.integrationBranch` are auto-discovered from the Git repository; `verification.commands` are auto-derived from the project's package manager and test scripts.

`tracker` and `delivery` are independent blocks, and each has more than one valid shape:

```jsonc
  // github: a forge repository, operated through `gh`.
  "tracker": { "provider": "github", "project": "<owner/repository>" },
  // gitlab: a forge project, operated through `glab`.
  "tracker": { "provider": "gitlab", "project": "<group/subgroup/project>" },
  // linear: a Linear team, optionally inside a Linear project. The credential
  // is environment-only and is never stored in this file.
  "tracker": { "provider": "linear", "team": "<team key or name>" },
  // local: the clone itself. No coordinate at all.
  "tracker": { "provider": "local" },

  // Explicitly deferred delivery. No delivery script is generated for it.
  "delivery": { "mode": "deferred" }
```

## Trackers

The tracker choice and the delivery choice are independent. Where your Spec and tickets live says nothing about whether a candidate can be published, previewed, and released today.

| `"provider"` | Where the Spec and tickets live | What you need |
|---|---|---|
| `github` | the forge repository, at `project` (`<owner>/<repository>`) | `gh` authenticated for that repository |
| `gitlab` | the forge project, at `project` (`group/subgroup/project`) | `glab` authenticated for that project |
| `linear` | a Linear team at `team` (key or name), optionally inside a `project` | exactly one credential in the **environment** |
| `local` | the clone itself, under `poiesis-tracker-v1` beneath the Git common directory | nothing |

`fixture` is test-only: it requires `--allow-fixtures` at `init`, writes outside the repository root, and is never offered as a choice.

### `linear`

Linear is reached over its GraphQL API. Its coordinates are a required `team` and an optional `project`: `team` is a key or a name, and Poiesis never picks a team for you. Poiesis reads the credential from the environment only, and expects exactly one of:

- `LINEAR_API_KEY` — a personal API key, sent as the raw `Authorization` value;
- `LINEAR_OAUTH_TOKEN` — an OAuth access token, sent as `Authorization: Bearer <token>`.

Setting both fails closed with `LINEAR_AUTH_AMBIGUOUS`; setting neither fails closed with `LINEAR_AUTH_MISSING`. The credential is never written to `.poiesis/config.jsonc`, never placed in a tracker item, never logged, and never echoed into an error message. If `init` reports a missing credential, export it in your shell and re-run `init` — do not put it in the config file.

### `local`

`local` persists Spec and ticket state in the clone itself under `poiesis-tracker-v1` beneath the Git common directory, outside every working tree, and makes no network call. It needs no CLI and no credential, and it is a first-class product tracker, not a test fixture.

That means it also needs no forge account, no forge issue tracker, and no network to run a full Specify → Tickets → Realize → Prove cycle. Items carry monotonic `LOCAL-<n>` identities. The store lives beside your objects rather than inside your checkout, so it survives `uninstall` and reinstall, is shared by every linked worktree of the clone, and never shows up in `git status`. Its files are `0600` inside a `0700` directory and are validated strictly: a corrupted, foreign, symlinked, or world-readable store fails closed instead of being repaired or overwritten.

Note that `local` is a **tracker** choice, not a delivery choice. It does not stop Poiesis from publishing, and deferring delivery does not stop the Local tracker from persisting Specs and tickets.

## Configured and deferred delivery

`"delivery"` is either complete or explicitly deferred. There is no partial state, and mixing a mode with individual targets fails closed.

**Configured** delivery is the three command targets above. On the interactive path it is an explicit choice, never a silent default: `init` asks `Configure delivery now? (configured|deferred)` once, offers no bracketed default, and fails closed with `INVALID_DELIVERY_MODE` on any other answer. When a config carries no `delivery` block at all — a non-interactive `--config` file, for example — Poiesis resolves the three generated command targets instead, because an adapter that actually runs is a better answer than a placeholder. Either way `init` writes a real `scripts/poiesis-{preview,staging,production}.mjs` for any target the project does not already have, and never overwrites a script you wrote yourself.

**Deferred** delivery is an explicit, healthy state:

```jsonc
"delivery": { "mode": "deferred" }
```

The lifecycle runs normally up to and including whole-change Proof for the exact candidate — Prepare, Realize, accepted Review, Checkpoint, Verify — and `doctor` reports the deferred state as a nonblocking warning with `report.ok === true`. `init` generates no delivery scripts, because there is nothing to run.

At Proof the lifecycle hard-stops. `poiesis publish`, `poiesis preview`, `poiesis promote --target staging`, `poiesis promote --target production`, `poiesis integrate`, and `poiesis workspace cleanup` each fail closed with a typed `DELIVERY_DEFERRED` error naming the blocked operation and its remediation — before any push, fetch, remote revalidation, delivery subprocess, integration commit, remote branch deletion, or worktree removal. Nothing claims that Publish, Preview, integration, or completion happened, and you are never asked to validate a realization that was never delivered.

The exact code depends on how far the operation gets. `poiesis publish` resolves its publishing coordinates first, so on a project whose remote is not a recognized forge it refuses one step earlier with `PUBLISH_PROVIDER_UNRESOLVED` (see [Publishing coordinates and forks](#publishing-coordinates-and-forks)); `poiesis preview` and `poiesis promote` refuse even earlier, because there is no delivery adapter to construct. Both are fail-closed, and neither pushes anything.

Configuring delivery later is the ordinary managed-configuration workflow, never a hand edit of `.poiesis/config.jsonc`: `poiesis update --config`. Supply the proposed complete config as the argument, replacing the `delivery` block with the three command targets and leaving the `tracker` block untouched:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update --config ./poiesis-config.jsonc
```

That transaction is atomic — config, OpenCode projection, manifest, receipt — and `doctor` gates the result. Tracker and delivery stay independent through the change.

## Publishing coordinates and forks

Publishing coordinates are a property of the configured Git remote, never of the tracker. Poiesis uses the remote when it is a recognized `github.com` or `gitlab.com` host; otherwise the only coordinates it may use are the test-only `fixture` tracker's; otherwise there are none. A `github` or `gitlab` tracker never supplies them either — tracker identity is not a second source of truth for where a change request is opened — and a `linear` or `local` tracker never appears as the `provider` of Publish evidence, so a project whose Specs live in Linear or in the clone still publishes to the repository its remote points at.

A remote URL may carry a credential (`https://user:token@github.com/owner/repo.git`). Poiesis reads such a URL as the recognized remote it is, and strips the userinfo before the URL reaches a coordinate, a `doctor` report, an error detail, a CLI JSON envelope, a log line, or published evidence.

When nothing resolves, `poiesis publish` fails closed with `PUBLISH_PROVIDER_UNRESOLVED` before any push, fetch, remote revalidation, change request, or evidence. That is what a project with a filesystem or self-hosted remote gets; Poiesis does not invent a repository to publish into.

A fork is a different repository, not a shortcut to its upstream. A remote pointing at a fork is a recognized host, so Poiesis publishes to the fork that remote names and opens the change request against that fork's own configured integration branch. Nothing in a clone records the fork/upstream relationship, so Poiesis cannot publish back to the upstream it was forked from and does not pretend to: if the change request that comes back is owned by a different repository than the coordinates it resolved, Publish fails closed.

### Onboarding a project with no publishing path (Veritium)

Veritium-style projects — an application that already ships through its own AWS pipeline, with its own release and rollback process, and no GitHub or GitLab issue tracker to mirror — are a first-class onboarding, not a compromise. Onboard with the Local tracker and deferred delivery:

```jsonc
{
  "schema": 1,
  "models": { "reasoning": "<provider/model>", "execution": "<provider/model>" },
  "tracker": { "provider": "local" },
  "delivery": { "mode": "deferred" }
}
```

What adopting Poiesis that way costs the project: nothing it already runs. Adopting a deferred install requires no change to any existing project workflow: nothing is pushed, no pull or merge request is opened, and nothing is deployed to any environment. The AWS workflow, its roles, its pipelines, its environments, and its rollback process are untouched — Poiesis does not adopt, replace, reorder, or reconfigure them, and onboarding Poiesis is not itself a deployment step. Your Specs and tickets live in the clone; your work is proven, reviewed, and checkpointed; and the lifecycle stops at Proof instead of pretending to ship.

When the project later grows a Preview, a forge, or a tracker, that is a separate, deliberate change: `poiesis update --config` with a new `delivery` block, or a new `tracker` block, in either order and independently of the other.

## Preview and Staging

Preview and Staging are project-specific. Poiesis never substitutes a JSON evidence file for a real preview/staging target.

The delivery adapter is a deterministic command. The command must:

- accept the exact candidate SHA as the `{sha}` placeholder;
- read the exact tree from `POIESIS_CANDIDATE_TREE` and the source Preview or Staging receipt from `POIESIS_DELIVERY_IDENTITY` when promoting;
- run a real previewable artifact or required target health verification;
- emit JSON containing exact `sha`, `candidateTree`, `target`, `verified: true`, and `artifactIdentity`;
- emit at least one of `id`, `url`, or `artifact` whose value equals `artifactIdentity`.

Preview returns a candidate-bound receipt. Staging consumes that Preview receipt and returns a new Staging receipt; callers do not predeclare Staging success. Integration consumes the Staging receipt directly and returns its complete Integration evidence. Production accepts only a Staging-target receipt, preventing a Preview identity from being relabeled as Staging.

Publish produces canonical candidate-bound evidence after a successful operation — every required Publish-evidence field (`candidateSha`, `candidateTree`, `verified: true`, `branch`, `remoteRef`, `publishedHeadSha`, `provider`, `action`, `changeRequest`) with the runtime-enforced equalities (`remoteRef = refs/heads/<branch>`, `publishedHeadSha = candidateSha`). Preview MUST receive the same `--proof`, the same dynamic `--candidate-tree`, and that exact successful Publish evidence unchanged as `--publish`; missing or mismatched proof, tree, or Publish evidence fails closed before any Preview identity is claimed.

Production authorization is a structured JSON envelope binding explicit Author approval and identity to the candidate SHA/tree, Staging artifact identity, and integration SHA. Before invoking Production, Poiesis fetches the configured remote integration branch and requires that exact integration SHA to be its head with content equal to the accepted candidate tree. The orchestration layer remains responsible for asking the Author; the runtime prevents stale or cross-candidate authorization replay.

For projects with no existing preview/staging infrastructure, Poiesis uses a fixture adapter (`adapter: "fixture"` plus an external path) that is test-only and requires `--allow-fixtures`.

## Operations

```text
init                    install owned method and adapter files (flagless interactive on TTY; --config <path> only for non-interactive / CI use)
doctor                  inspect health without mutation
update                  update only proven-owned files and skills
uninstall               remove only proven-owned state
inspect                 return bounded project and Git facts
capability install      install one selected, revision-pinned skill
model                   interactive: pick exactly one slot (reasoning or execution) from the live OpenCode inventory
model set               deterministic single-class set (reasoning|execution <provider/model>)
workspace prepare       create an isolated owned branch/worktree (default omits --path and lives under <root>/.poiesis/workspaces/<derived-id>)
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

### Changing the configured model

`poiesis model` (TTY) walks the live OpenCode model inventory and writes the chosen `<provider/model>` for the chosen slot through the authenticated `update --config` transaction. The change is durable: the manifest, `.poiesis/config.jsonc`, and OpenCode projection are all updated together. Restart OpenCode after success — Poiesis does not restart it.

`poiesis model set reasoning|execution <provider/model>` is the deterministic single-class set (no inventory walk). Both forms target exactly one slot per invocation; pick the slot explicitly so the Author-owned decision stays in scope.

A non-TTY `poiesis model` invocation fails closed with `NON_TTY_MODEL`; the deterministic `model set ...` subcommand is the supported path for scripted use.

`workspace prepare` is invoked as `poiesis workspace prepare --branch <name> --spec <id>`. Omit `--path`; the CLI then selects a deterministic, traversal-safe workspace under `<root>/.poiesis/workspaces/<derived-id>`. The default-path workspace area is gitignored so it never appears as foreign work in the primary checkout.

Do not pass any external path such as `/tmp/...` or any location outside the project root — external worktrees fall outside the harness-readable project root and trigger external-directory permission denials. The explicit absolute `--path` form is reserved for exceptional use only — when the Author explicitly supplied an exceptional path or compatibility recovery requires the exact pre-existing path.

## Use with a coding agent

The normal Author experience is to ask Poiesis for something in natural language and let the visible primary agent orchestrate the work. The following prompt is a reusable, internal-mechanics-free recipe for handing a fresh coding agent a project plus Poiesis without teaching it adapter internals:

```text
You are operating inside a real Git repository that is being onboarded to Poiesis (a deterministic runtime for turning human intent into working, proven software). Treat the Poiesis CLI as the only supported interface — do not hand-write Poiesis config, do not invent an OpenCode agent or skill installation, and do not reimplement a Poiesis step the CLI already provides.

There are two phases. The bootstrap phase runs the published package through a package runner because Poiesis is not yet installed in this project. Once `init` succeeds, the local Poiesis CLI is available and the runtime-generated exact-version route `pnpm dlx poiesis-cli@<X>` is the only Poiesis-launcher route the projected OpenCode config admits. The bare `poiesis`, `pnpm exec poiesis`, `npx poiesis`, and unversioned `pnpm dlx poiesis-cli` forms are explicitly denied.

Bootstrap (Poiesis is not installed yet):
  1. Run `pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest init` (TTY). Poiesis prints every detection and asks only the remaining Author-owned choices. After success, tell the human to restart OpenCode.

After init (Poiesis is installed locally):
  2. Inspect: `poiesis inspect` for bounded project and Git facts.
  3. Change a model slot: `poiesis model` (TTY), or the deterministic `poiesis model set reasoning|execution <provider/model>` for scripted use.

If a step needs authentication that Poiesis cannot perform on its own (e.g. signing in to `gh`, `glab`, or a delivery target, or exporting a `LINEAR_API_KEY` / `LINEAR_OAUTH_TOKEN` credential), copy-paste the exact auth command Poiesis prints, run it, and re-run the Poiesis step — do not invent a different auth path.

Ask the human only for decisions that materially affect their product (intent, acceptance, consequential constraints). Do not ask about adapter version numbers, capability shapes, manifest paths, or other Poiesis internals — those are Poiesis's responsibility. If a command fails closed with a structured error, surface the error verbatim; do not silently retry or substitute.
```

Paste that block into a fresh coding-agent session (Cursor, Claude Code, OpenCode chat, etc.) before asking it to do work in the project. It does not teach adapter internals, it does not ask the agent to invent Poiesis flows, and it routes every external auth step through a copy-paste command.

## One-shot setup-agent prompt (Poiesis v1.2)

When the human/operator wants to hand the project to a fresh full-access coding agent and have the agent stand up the entire Poiesis environment without further human intervention, paste the following single block into the agent session. The agent installs `uv`, runs the fresh-latest `init` (or `update`, on an already-installed checkout), runs `doctor`, and reports readiness. There is no hidden setup agent and no new role file: this is just a recipe for one Poiesis-aware operator prompt.

```text
You are a full-access setup agent for Poiesis v1.2 inside this Git repository. Your job is to install the official runtime requirements, run the fresh-latest `init` (or `update` if `.poiesis/manifest.json` already exists), run `doctor`, and report a single readiness summary. Do not implement any product change. Do not commit. Do not push. Do not open a PR. Do not modify `AGENTS.md`. Do not install the Graphify installer, hook, plugin, MCP, memory, hosted mode, or docs/media semantic extraction. Do not ask the Author about Repository Intelligence; the runtime owns it.

Steps (run in order, stop on first fail-closed error and report it verbatim):

  1. Install the standard Poiesis v1.2 runtime requirement on PATH: `uv` (https://docs.astral.sh/uv/). Use the official installer for the host platform (macOS / Linux / Windows). Do not vendor Python; `uv` will manage its own interpreter on demand. Confirm with `uv --version`. If `uv` cannot be installed in this environment, report it as `BLOCKED: uv install failed` and stop.

  2. Run the fresh-latest interactive bootstrap if Poiesis is not yet installed in this repo:
       pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest init
     On a TTY this is interactive; follow every printed prompt, choose the Author-owned model slots via the live OpenCode inventory, choose the tracker (github / gitlab / linear / local) and configure delivery now or defer it, supply the real preview/staging/production argv with `{sha}` when delivery is configured, and only stop when `init` reports success. If `.poiesis/manifest.json` already exists, instead run the same-version reconciliation:
       pnpm dlx poiesis-cli@<manifest.poiesisVersion> update
     If the operator explicitly wants the freshest published runtime, use the fresh-latest form:
       pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update
     Each command must succeed before continuing.

  3. Run the manifest-pinned deterministic health check (does not download, does not mutate, does not require a model call):
       pnpm dlx poiesis-cli@<manifest.poiesisVersion> doctor
     `doctor` must report `report.ok === true`. A `fail` entry that names `uv`, `Graphify`, or the Repository Intelligence runner is BLOCKED until `uv` is installed.

  4. Run the mechanical Repository Intelligence status probe (does not download, does not build a graph):
       pnpm dlx poiesis-cli@<manifest.poiesisVersion> repository status
     The status envelope's `uvAvailable`, `cachePresent`, `cacheValid`, and `reason` fields are part of the readiness report.

  5. Report readiness in one short block:
       READY: poiesisVersion=<X>; uvAvailable=<true|false>; doctor.ok=<true|false>; repository.reason=<ready|uv-unavailable|cache-absent|engine-version-mismatch|cache-invalid>; opencodeRestart=<required|not-required>.
     If anything is not READY, report the failing step verbatim and stop.

You are done. Do not run additional commands, do not implement product work, do not commit, do not push.
```

Use this prompt when the human/operator wants a single agent to stand up the whole Poiesis environment end-to-end without intermediate questions. The prompt is the only sanctioned setup-agent recipe; Poiesis does not install or expose any hidden setup agent or new role.

## Safety

- Poiesis never overwrites or deletes a file, config value, skill, worktree, or branch it cannot prove ownership of.
- `doctor` is read-only.
- Failed implementation attempts are never checkpointed.
- History rewriting is refused: `publish` only accepts non-forcing fast-forward updates of the Poiesis-owned remote change branch.
- Production promotion requires separate candidate-bound Author authorization plus the operation-produced Staging receipt and the verified canonical Integration evidence.
- Fixture tracker and delivery adapters exist only for disposable integration tests and bootstrap dogfood; they are not supported production infrastructure.

## Development

```bash
pnpm check
pnpm test
pnpm build
```

The canonical design is `POIESIS_FOUNDATION_v1.2.md` (kept in the GitHub repository, not the npm tarball). The installed operational projections are `POIESIS_PHILOSOPHY.md` and `POIESIS_METHOD.md`.

## License

MIT

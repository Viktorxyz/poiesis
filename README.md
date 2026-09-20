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
- For GitHub projects: GitHub CLI (`gh`) authenticated for the target repository
- For GitLab projects: GitLab CLI (`glab`) authenticated for the target project
- A configured Preview, Staging, and Production delivery target (see [Preview and Staging](#preview-and-staging))

## Install

Poiesis is published as the `poiesis-cli` npm package. The CLI binary is named `poiesis` (`poiesis` is already occupied by an unrelated package on the public registry).

### First-time init

In a real Git repository, the human happy path is flagless:

```bash
pnpm dlx poiesis-cli@latest init
```

`poiesis init` with no flags runs the interactive TTY flow. It discovers the Git remote, integration branch, package verification scripts, OpenCode model inventory, and `scripts/poiesis-{preview,staging,production}` hints; prints every detection on stderr; prompts only the remaining Author-owned choices (models via the shared selector, ambiguous remote, real delivery command argv with `{sha}`); probes tracker auth (`gh` / `glab`); and then calls the existing ownership install transaction. After success, restart OpenCode to load the new agent projections — Poiesis does not restart OpenCode on the Author's behalf. A non-TTY invocation without `--config` fails closed with `NON_TTY_INIT`.

`init` resolves the project's Git remote and integration branch automatically, validates the configured models against the local OpenCode model inventory, verifies the configured tracker, and verifies the configured delivery adapters. It installs the canonical method/role files, the OpenCode agent projections, the 11 curated Poiesis skills, and runs `doctor`.

The repository remote and integration branch are not CLI options — they are read from the Git repository directly. The config file described below is the **output** of `init`, not the input: a successful `init` writes a resolved `.poiesis/config.jsonc` plus the manifest, and that resolved file is what subsequent operations consume.

#### Non-interactive init (automation only)

For CI / scripted use, `init` accepts the same resolved config file via `--config`. The flag is reserved for non-TTY invocations and reproducible automation:

```bash
pnpm dlx poiesis-cli@latest init --config ./poiesis-config.jsonc
```

A non-TTY invocation **without** `--config` fails closed with `NON_TTY_INIT` rather than guessing; the structured path is the supported automation contract. The repository remote and integration branch are still read from the Git repository directly — `repository.remote` and `repository.integrationBranch` keys in the config file are accepted for completeness but the Git repository is the source of truth.

`doctor` runs without mutation and verifies the same set of invariants any time:

```bash
pnpm dlx poiesis-cli@latest doctor
```

`update` re-reads the installed canonical files and re-applies the OpenCode adapter projection only against proven-owned state:

```bash
pnpm dlx poiesis-cli@latest update
```

Installations created by public `poiesis-cli@1.0.0` have no trusted receipt. Ordinary `update` therefore refuses them. An operator may establish that first trust only with an explicit one-time bootstrap after the known 1.0.0 contract is fully validated. This is operator authority, not cryptographic proof that the checkout-controlled 1.0.0 manifest was originally authored by Poiesis:

```bash
pnpm dlx poiesis-cli@latest update --bootstrap-legacy-ownership
```

After that command succeeds, later `doctor`, `update`, `uninstall`, and capability installation use the normal receipt-backed rules. The flag is rejected if a receipt already exists or the installation is not exactly 1.0.0.

### Updating the managed config

`.poiesis/config.jsonc` is a managed surface — Poiesis generated it from a
successful `init`, and ordinary editing would create a stale configuration
that nothing would reconcile. The supported update path is the intentional
managed-config workflow:

```bash
pnpm dlx poiesis-cli@latest update --config ./poiesis-config.jsonc
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
pnpm dlx poiesis-cli@latest uninstall
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
    "preview": { "adapter": "command", "command": ["scripts/poiesis-preview.mjs", "{sha}"] },
    "staging": { "adapter": "command", "command": ["scripts/poiesis-staging.mjs", "{sha}"] },
    "production": { "adapter": "command", "command": ["scripts/poiesis-production.mjs", "{sha}"] }
  }
}
```

The same shape is the accepted input to `init --config` (for non-interactive / scripted use) and `update --config` (for managed configuration changes after init). `repository.remote` and `repository.integrationBranch` are auto-discovered from the Git repository; `verification.commands` are auto-derived from the project's package manager and test scripts.

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

### Inspect (read-only) and reconcile (destructive)

Two operations sit on the same primary-checkout preimage surface. The first is a bounded read; the second is a bounded mutation that refuses unless every binding captured by the first matches a re-captured binding immediately before any destructive action.

#### `poiesis inspect [--cwd <path>] [--fingerprint]`

`inspect` always returns bounded project and Git facts. `--fingerprint` is an opt-in flag that adds an exact primary preimage fingerprint to the result — a versioned, domain-separated SHA-256 bound to the canonical root, the Git common dir, the configured remote (name plus sorted fetch and push URLs), the integration branch, the raw `.git/index` bytes, the declared exclusion list, and a deterministic byte-preserving inventory of the discard-scope filesystem (tracked files by bytes and mode, symlink targets bound by raw `readlink` bytes, every directory — including empty — and untracked/ignored residue, refusing unsafe states: active Git operations, sparse checkout, submodules, nested repositories, content filters, special entries, and any scan that exceeds a configured bound).

Inspection is strictly read-only. It never fetches, never refreshes the index, never makes a judgment call about what to discard, and never invokes the destructive `reconcile` operation. The fingerprint is the only mechanical input the destructive step will accept.

#### `poiesis reconcile [--cwd <path>] --integration-branch <name> --remote <name> --expected-head <sha> --expected-target <sha> --expected-fingerprint <hex> --discard-acknowledged`

`reconcile` is the only bounded primary-checkout reconciliation primitive. It hard-resets the working tree to the fetched integration target while preserving Git administration, every registered linked worktree in place, shared markers/receipts, and the declared local Poiesis state exclusions (`.poiesis/manifest.json` and `.poiesis/workspaces/`).

Required flags, every one of them:

- `--integration-branch <name>`: the local branch the caller has verified is the configured integration branch. The destructive step re-asserts this immediately before mutation.
- `--remote <name>`: the configured remote name (e.g., `origin`). The remote must have at least one fetch URL; `git fetch` runs against this remote without pruning (the fetch also serves as a reachability probe — an unreachable remote fails closed with `RECONCILE_REMOTE_DRIFT`).
- `--expected-head <sha>`: the local HEAD SHA captured at the same instant as the fingerprint. A drift between capture and mutation is refused with `RECONCILE_HEAD_MISMATCH`.
- `--expected-target <sha>`: the SHA the integration branch is expected to resolve to on the fetched ref. A fetched SHA that differs from this value is refused with `RECONCILE_TARGET_MISMATCH` rather than silently reset to the wrong commit.
- `--expected-fingerprint <hex>`: the 64-hex SHA-256 digest returned by `inspect --fingerprint`. The destructive step re-fetches and re-captures the fingerprint immediately before mutation; a re-captured digest that differs from this value is refused with `RECONCILE_FINGERPRINT_MISMATCH`. A residue file that appears between capture and mutation is therefore reported as drift, never silently deleted.
- `--discard-acknowledged`: must literally be the boolean `true`. Omitting it (or supplying any other value) refuses with `RECONCILE_AUTHORIZATION_MISSING` so a shell-script typo cannot silently destroy local residue.

Runtime mechanics, in fixed order: validate every flag; canonicalize the root; assert the cwd is a primary checkout (not a linked worktree and not bare); assert the configured remote has at least one fetch URL; re-read the local branch and HEAD and refuse on mismatch; fetch the integration ref without pruning and refuse on mismatch; capture the fingerprint and refuse on digest mismatch; refuse any tracked target tree path that overlaps a declared exclusion prefix, a declared exclusion ancestor, or any registered linked worktree root or its ancestor (`RECONCILE_EXCLUSION_COLLISION`, `RECONCILE_TARGET_COLLISION`); refuse any `.gitattributes` the target introduces (escalated through `RECONCILE_FILTER_ACTIVE`); compare the registered linked worktree set against an optional `expectedWorktrees` baseline and refuse same-count move/swap drift with `RECONCILE_WORKTREE_DRIFT`; acquire the same cooperating mutation lock `update`, `uninstall`, and `update --config` take; revalidate every binding immediately before the destructive step; reset to the fetched target; verify the postcondition (HEAD, index, working tree match the target; no residue outside the declared exclusions).

`reconcile` is mechanical, not model-driven. It does not infer the integration branch, the remote, the HEAD, or the target — every value is a caller-supplied binding, validated against a re-captured ground truth immediately before the first destructive action. An operation that cannot prove ownership of a binding refuses with a typed error (`RECONCILE_INTEGRATION_BRANCH_MISMATCH`, `RECONCILE_HEAD_MISMATCH`, `RECONCILE_TARGET_MISMATCH`, `RECONCILE_FINGERPRINT_MISMATCH`, `RECONCILE_AUTHORIZATION_MISSING`, `RECONCILE_REMOTE_DRIFT`, `RECONCILE_EXCLUSION_COLLISION`, `RECONCILE_TARGET_COLLISION`, `RECONCILE_WORKTREE_DRIFT`, `RECONCILE_SCAN_INCOMPLETE`, `RECONCILE_NESTED_REPOSITORY`, `RECONCILE_FILTER_ACTIVE`, …); it never falls back to a best-effort guess, never prunes branches, never deletes remotes, never cleans orphan markers, and never rewrites history.

## Use with a coding agent

The normal Author experience is to ask Poiesis for something in natural language and let the visible primary agent orchestrate the work. The following prompt is a reusable, internal-mechanics-free recipe for handing a fresh coding agent a project plus Poiesis without teaching it adapter internals:

```text
You are operating inside a real Git repository that is being onboarded to Poiesis (a deterministic runtime for turning human intent into working, proven software). Treat the Poiesis CLI as the only supported interface — do not hand-write Poiesis config, do not invent an OpenCode agent or skill installation, and do not reimplement a Poiesis step the CLI already provides.

There are two phases. The bootstrap phase runs the published package through a package runner because Poiesis is not yet installed in this project. Once `init` succeeds, the local `poiesis` CLI is available and later commands can call it directly (or via `pnpm exec poiesis`).

Bootstrap (Poiesis is not installed yet):
  1. Run `pnpm dlx poiesis-cli@latest init` (TTY). Poiesis prints every detection and asks only the remaining Author-owned choices. After success, tell the human to restart OpenCode.

After init (Poiesis is installed locally):
  2. Inspect: `poiesis inspect` for bounded project and Git facts.
  3. Change a model slot: `poiesis model` (TTY), or the deterministic `poiesis model set reasoning|execution <provider/model>` for scripted use.

If a step needs authentication that Poiesis cannot perform on its own (e.g. signing in to `gh`, `glab`, or a delivery target), copy-paste the exact auth command Poiesis prints, run it, and re-run the Poiesis step — do not invent a different auth path.

Ask the human only for decisions that materially affect their product (intent, acceptance, consequential constraints). Do not ask about adapter version numbers, capability shapes, manifest paths, or other Poiesis internals — those are Poiesis's responsibility. If a command fails closed with a structured error, surface the error verbatim; do not silently retry or substitute.
```

Paste that block into a fresh coding-agent session (Cursor, Claude Code, OpenCode chat, etc.) before asking it to do work in the project. It does not teach adapter internals, it does not ask the agent to invent Poiesis flows, and it routes every external auth step through a copy-paste command.

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

The canonical design is `POIESIS_FOUNDATION_v1.1.md` (kept in the GitHub repository, not the npm tarball). The installed operational projections are `POIESIS_PHILOSOPHY.md` and `POIESIS_METHOD.md`.

## License

MIT

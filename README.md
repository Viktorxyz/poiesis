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
- A configured Preview, Staging, and Production delivery target (see [Preview and Staging](#preview-and-staging))

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

`poiesis init` with no flags runs the interactive TTY flow. It discovers the Git remote, integration branch, package verification scripts, OpenCode model inventory, and `scripts/poiesis-{preview,staging,production}` hints; prints every detection on stderr; prompts only the remaining Author-owned choices (models via the shared selector, ambiguous remote, real delivery command argv with `{sha}`); probes tracker auth (`gh` / `glab`); and then calls the existing ownership install transaction. After success, restart OpenCode to load the new agent projections — Poiesis does not restart OpenCode on the Author's behalf. A non-TTY invocation without `--config` fails closed with `NON_TTY_INIT`.

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

A release may add one narrow permission without bumping the runtime version, which leaves an installed project recording the current `poiesisVersion` with an earlier projection. The receipt-gated `update` migrates that exact projection forward — see [COMPATIBILITY.md](./COMPATIBILITY.md#same-release-projection-migration-pre-focused-check). Any drift from both the current and the recognized predecessor projections still fails closed with `MANIFEST_AUTHORITY_INVALID`, and the projection `update` installs never grants a broad, `@latest`, or unversioned launcher route.

An ordinary release bump needs no migration entry at all. A project installed by the previously published release carries that release's authentic projection, and the strict manifest-version check is keyed off the manifest's own `poiesisVersion`, so the receipt-gated `update` crosses straight onto the new release and re-keys the exact-version launcher — see [COMPATIBILITY.md](./COMPATIBILITY.md#release-to-release-crossing). The previous release is deliberately kept out of the accepted predecessor set, and a manifest that drifts from its own release projection still fails closed with `MANIFEST_AUTHORITY_INVALID` on every path.

An OpenCode session that was already running when `update` finished keeps the permission projection it loaded at start, so a Worker in that session still has the pre-migration surface and its `check` route stays denied. Restart OpenCode (or open a new session) after `update`; Poiesis does not restart it for you and never widens a permission to cover a stale session — the correct fix is always re-running against the migrated projection.

Workspace mutations are serialized by one fail-fast lock next to the ownership receipt. If a Poiesis session dies without releasing it, the next mutation fails with `POIESIS_MUTATION_LOCKED` and a diagnostic that names the holder pid, whether it is still running, and the one correct recovery. Poiesis never reclaims the lock automatically: removing a live holder's lock would let two mutations run at once.

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

### Command execution, containment, and cancellation

Poiesis uses two distinct process-execution contracts, and it does not blur
them.

**Fixed-argv commands** (`git`, `gh`, `uv`, `opencode`, delivery executables)
run under a managed process GROUP: each child is spawned `detached`, gets a
transient in-memory identity lease, and is settled through that lease alone.
That is isolation, not containment — and it is honest here precisely because
nothing in a Poiesis-chosen argv can `setsid` its way out of the group.

Cleaning that group has one precondition, and it is not a formality. A process
group may be signalled only while the leased leader that gave the group its id
can still be re-confirmed by exact **process-start identity** and exact process
group — the Linux model, read from the kernel's per-PID process table. Group
liveness is an absence fact, never an ownership one: a group that still exists
after its leader is gone names a PID that any later process may be handed, and
Poiesis will not signal on the strength of a number it cannot attribute.

| Situation | What Poiesis does |
| --- | --- |
| Linux, live leader still provable | group `SIGTERM`, bounded wait, re-confirm, group `SIGKILL`, bounded wait; success is confirmed only when the group no longer exists |
| Linux, leader gone or terminal while the group is still observable | sends **no signal at all**, waits a bounded natural-settlement window for the group to empty itself (a finished leader's descendants may not be reaped yet), and settles when it does. A group still there when the wait closes rejects `PROCESS_CLEANUP_UNRESOLVED` with `details.reason: GROUP_AUTHORITY_LOST` |
| Linux, leader unreadable / reused / foreign while the group remains | sends **no further signal** and rejects `PROCESS_CLEANUP_UNRESOLVED` with `details.reason: GROUP_AUTHORITY_LOST`, `details.phase`, `details.leaderState`, `details.pid`, `details.processGroupId`, `details.membersEnumerated: false` |
| Linux, group survives both phases under a provable leader | rejects `PROCESS_CLEANUP_UNRESOLVED` with `details.reason: GROUP_STILL_PRESENT` |
| non-Linux POSIX (macOS, the BSDs), live leader, no readable process-start identity | sends **no signal at all** and rejects `PROCESS_CLEANUP_REFUSED` with `details.reason: UNSUPPORTED_IDENTITY` plus the actionable `details.pid` and `details.processGroupId`. Poiesis never pretends a termination it could not perform, and it never falls back to the weaker "the child leads the group it was spawned into" argument, because that group id IS that child's PID and the PID becomes reusable the moment the leader exits |
| already-empty group | settled; nothing to signal and nothing to prove |
| Windows | unchanged: no POSIX groups, so the tree is reached with `taskkill /PID <pid> /T` only while the child has not exited, then `child.kill`, each phase bounded by the child's own `exit` |
| Linux, run contained in a cgroup v2 leaf | unchanged, and authoritative: `cgroup.kill` plus a `populated 0` reading from `cgroup.events` empties the leaf, and once that is confirmed no group-local settlement runs at all |

These envelopes are not contained-path-only. `PROCESS_CLEANUP_REFUSED` and
`PROCESS_CLEANUP_UNRESOLVED` describe a managed process group on any platform,
and both outrank success, failure, timeout, and cancellation, because they mean
a process Poiesis spawned may still be running.

Poiesis never enumerates the group to work out what is inside it. There is no
`/proc` walk, no member snapshot, no per-PID signal, and therefore no survivor
list to report: cleanup addresses the group or it does nothing.

**Command TEXT** can do exactly that. Three surfaces run it: `poiesis verify`'s
plan, `poiesis check`'s explicit commands, and the configured
`postIntegrationCommands` that `poiesis integrate` runs against the integrated
revision. All three go through one shared command-processor seam and are placed
in a kernel boundary before any of their text runs:

| | |
| --- | --- |
| Processor (POSIX) | `/bin/sh` with `["-c", <the exact command>]` |
| Processor (Windows) | a validated absolute `ComSpec` naming `cmd.exe`, with `["/d", "/s", "/c", <the exact command>]` |
| Startup protocol (Linux) | a Poiesis-owned prologue that reports its kernel identity, waits, admits ITSELF into the provisioned cgroup v2 leaf, confirms that membership against the same identity, waits again, and only then runs the caller's argv |
| Containment (Linux) | that delegated cgroup v2 leaf, provisioned BEFORE the spawn, settled with `cgroup.kill` and confirmed by `cgroup.events` |
| Containment (Windows) | requires a no-breakaway Job Object from a native launcher, which this runtime does not ship |
| Containment (macOS / other POSIX) | no portable primitive exists |

What Poiesis **does** claim:

- the leaf exists before the process is created;
- the managed child is a Poiesis-owned prologue, not the command, and it is spawned
  with **no caller text in its argv at all**. The startup is two phases:
  1. the prologue reports its own kernel PID, process-group id, and
     process-start identity and waits; Poiesis checks that report against the PID
     `spawn` returned *and* against a fresh kernel read of that PID, establishes a
     live validated lease, and only then sends the admission token;
  2. the prologue admits *itself* into the leaf, confirms that membership is bound
     to the SAME identity it reported, reports that, and waits for a **distinct**
     execution token. Poiesis binds that report to the identity it leased, and only
     then releases the caller's argv and arms stdin, the command timeout, and
     cancellation;
- so **no caller command text can execute before the admission is confirmed**, and
  the ordering is structural rather than a race: the text does not exist in the
  child's argv until the parent has the authority to release it;
- the boundary path and both gate tokens travel out of band in the environment,
  never in the argv, and are scrubbed before the processor is `exec`'d;
- the caller's command is passed through verbatim: byte-identical as the released
  argv, never interpolated into the prologue;
- the parent refuses the run if either report is missing, malformed, or disagrees
  with the kernel — there is no "it probably made it" branch, for a live child or a
  finished one;
- every process the command creates after admission inherits the leaf, because
  cgroup membership survives `fork`, `setsid(2)`, and reparenting;
- settlement fails closed unless the kernel itself reports the leaf empty.

Cleanup follows the phase the startup actually reached, because each phase earns a
different authority. Before a lease exists nothing may be signalled: Poiesis
REVOKES its own control channel — which is what a pre-`exec` prologue exits on —
settles the leaf, and requires the child's own linked exit; without that proof it
reports `PROCESS_CLEANUP_UNRESOLVED` with `details.reason:
STARTUP_EXIT_UNCONFIRMED`. After a lease exists but before the admission is
confirmed, the group and the leaf are settled independently, because an empty leaf
cannot prove anything about a leader that never entered it. After a confirmed
admission the cgroup is the authority and no group-local settlement runs at all.
`src/process-tree.ts` remains the only place that signals a POSIX process group, and
the contained startup path sends no raw PID signal of its own.

What Poiesis **does not** claim: that it detects an escape. It never polls for
one, never matches on a process name, port, user, or age, and never scans the
system.

On a host with no strong boundary — Windows, macOS, or Linux without a
delegated cgroup v2 subtree exposing `cgroup.kill` — `verify`, `check`, and
`postIntegrationCommands` all refuse before spawning anything, with
`PROCESS_CONTAINMENT_UNAVAILABLE` naming the capability that is missing and the
remediation: run the operation on a Linux host with a delegated cgroup v2
subtree. Nothing runs and nothing is reported as verified. On Windows the
missing primitive is a no-breakaway Job Object, which needs a native launcher
this runtime does not ship; on macOS and the other POSIX platforms no portable
strong primitive exists at all.

The library `run()` seam with a fixed argv remains available on such a host for
work that needs no arbitrary command text, and it is a different trade rather
than an equivalent cleanup: on Windows its tree cleanup is `taskkill`-based as
described above, while on macOS and the BSDs a command that is still running at
a timeout or a cancellation gets a typed fail-closed refusal
(`PROCESS_CLEANUP_REFUSED` / `UNSUPPORTED_IDENTITY`) instead of a termination.
Choose it when a caller can act on that refusal; do not read it as the Linux
behaviour.

The command processor is validated on the same terms, before any process
exists. `verify` and `check` refuse with `COMMAND_PROCESSOR_UNAVAILABLE`
carrying `details.reason` (`PROCESSOR_NOT_EXECUTABLE`, or the `ComSpec` reasons
`COMSPEC_MISSING`, `COMSPEC_NOT_ABSOLUTE`, `COMSPEC_NOT_COMMAND_PROCESSOR`,
`COMSPEC_UNAVAILABLE`), `details.platform`, the rejected `details.processor`,
`details.detail`, and a `details.remediation`. `check` passes that refusal
through with its own code and those fields intact and the bounded
`details.check` evidence attached — and without the "escalate to `poiesis
verify`" line a failing check carries, because Verify resolves command text
through the same processor and would refuse in exactly the same way.

`SIGINT` / `SIGTERM` cancel the two operations that actually consume a signal —
`poiesis verify` and `poiesis check`. One AbortController per invocation,
temporary handlers removed in `finally`, the first signal aborts once. Every
other subcommand keeps the platform default signal behaviour untouched. The
managed commands then settle: `verify` reports `COMMAND_CANCELLED` (exit code
130) and issues no verification receipt, and `check` reports `COMMAND_CANCELLED`
with the complete bounded result attached under `details.check`. A cleanup
failure always outranks the cancellation — "Poiesis could not confirm it stopped
what it started" is the fact you have to act on. A library caller that supplies
its own `AbortSignal` keeps it, and Poiesis installs no process-wide handlers on
its behalf.

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

Verify runs the installation's live verification plan against the exact clean candidate and returns runtime-owned evidence: a `verification` block (`receiptId`, `receiptDigest`, `runtime`, `candidateSha`, `candidateTree`, `verificationPlanDigest`) referring to an immutable receipt Poiesis wrote under the repository's shared Git directory. Publish requires that reference, resolves the stored receipt itself, and revalidates it against the live installation identity, workspace ownership, live verification plan, and live candidate before anything is pushed; an asserted `verified: true` is never evidence on its own. A missing, fabricated, stale, or off-plan receipt fails closed and names the one migration that resolves it: run `poiesis verify` again for that exact candidate.

Publish produces canonical candidate-bound evidence after a successful operation — every required Publish-evidence field (`candidateSha`, `candidateTree`, `verified: true`, `branch`, `remoteRef`, `publishedHeadSha`, `provider`, `action`, `changeRequest`, `verification`) with the runtime-enforced equalities (`remoteRef = refs/heads/<branch>`, `publishedHeadSha = candidateSha`). Preview MUST receive the same `--proof`, the same dynamic `--candidate-tree`, and that exact successful Publish evidence unchanged as `--publish`, including the resolved receipt identity. Preview does not take either document on trust: it resolves the receipt they name out of runtime storage and revalidates it against the live installation identity, workspace ownership, live verification plan, and live candidate — the caller's `runtime` and `verificationPlanDigest` must equal the stored receipt's — requires the proof and the Publish evidence to identify the SAME receipt, and revalidates the remote change-branch head. Missing or mismatched proof, tree, receipt reference, or Publish evidence fails closed before any Preview identity is claimed.

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
check                   run explicit non-authoritative focused checks in an owned candidate workspace
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

An owned candidate workspace is where the work happens, never where lifecycle authority lives. `verify`, `checkpoint`, `publish`, `preview`, `promote`, `integrate`, and `workspace cleanup` resolve the manifest, the ownership receipt, and the runtime identity through the primary receipt-authenticated installation that owns the workspace, so a candidate's own generated `.poiesis/config.jsonc` — stale the moment the workspace is prepared, and possibly committed into the candidate tree — is never lifecycle authority. Verification commands still execute against the exact candidate workspace. Wrong ownership, a missing primary receipt, a foreign workspace Poiesis does not own, and a runtime identity that does not match the primary manifest all fail closed with a typed error before anything runs.

`poiesis check` is the focused-check surface for ticket work. It runs EXPLICIT commands in a Poiesis-owned (possibly dirty) candidate workspace, refuses any workspace Poiesis cannot prove it owns, never retries, and returns bounded per-command evidence plus a deterministic action fingerprint over the command, the workspace state fingerprint, and a deterministic failure classification. It creates no verification receipt and no other proof: whole-change authority stays with `poiesis verify`. The ticket Worker reaches exactly this one subcommand through the exact-version route; no other Poiesis lifecycle route is granted to it.

`poiesis integrate` runs post-integration verification only when the project configures `verification.postIntegrationCommands`. The configured `verification.commands` plan is never substituted for it: that plan already ran once, in the owned candidate, before Publish. With no `postIntegrationCommands`, integration runs nothing after the push and proves exact identity in Git instead — the integrated commit's tree equals the accepted candidate's tree byte-for-byte, and the published integration ref is exactly that commit.

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

If a step needs authentication that Poiesis cannot perform on its own (e.g. signing in to `gh`, `glab`, or a delivery target), copy-paste the exact auth command Poiesis prints, run it, and re-run the Poiesis step — do not invent a different auth path.

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
     On a TTY this is interactive; follow every printed prompt, choose the Author-owned model slots via the live OpenCode inventory, supply the real preview/staging/production argv with `{sha}`, and only stop when `init` reports success. If `.poiesis/manifest.json` already exists, instead run the same-version reconciliation:
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
- Command cleanup never claims more than it proved: an unresolved or refused cleanup rejects with a typed error ahead of success, failure, timeout, and cancellation, and a command that Poiesis cannot contain is refused before it is created.

## Development

```bash
pnpm check
pnpm test
pnpm build
```

The canonical design is `POIESIS_FOUNDATION_v1.2.md` (kept in the GitHub repository, not the npm tarball). The installed operational projections are `POIESIS_PHILOSOPHY.md` and `POIESIS_METHOD.md`.

## License

MIT

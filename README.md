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
- **A POSIX host with `/bin/sh` at that exact path.** `poiesis verify` and the post-integration verification `poiesis integrate` runs execute every configured verification command as `/bin/sh -c <command>`, with the working directory set to the canonical Git root of the exact candidate being proven. A host with no `/bin/sh` — Windows, or a container image without a POSIX shell — cannot run verification, so this is a stated requirement rather than a `package.json` `os` restriction, and there is no PowerShell, `cmd.exe`, or `sh`-on-`PATH` fallback.
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

A release may add one narrow permission without bumping the runtime version, which leaves an installed project recording the current `poiesisVersion` with an earlier projection. The receipt-gated `update` migrates that exact projection forward — see [COMPATIBILITY.md](./COMPATIBILITY.md#same-release-projection-migration-pre-focused-check). Any drift from both the current and the recognized predecessor projections still fails closed with `MANIFEST_AUTHORITY_INVALID`, and the projection `update` installs never grants a broad, `@latest`, or unversioned launcher route.

An ordinary release bump needs no migration entry at all. A project installed by the previously published release carries that release's authentic projection, and the strict manifest-version check is keyed off the manifest's own `poiesisVersion`, so the receipt-gated `update` crosses straight onto the new release and re-keys the exact-version launcher — see [COMPATIBILITY.md](./COMPATIBILITY.md#release-to-release-crossing). The previous release is deliberately kept out of the accepted predecessor set, and a manifest that drifts from its own release projection still fails closed with `MANIFEST_AUTHORITY_INVALID` on every path.

An OpenCode session that was already running when `update` finished keeps the permission projection it loaded at start, so a Worker in that session still has the pre-migration surface and its `check` route stays denied. Restart OpenCode (or open a new session) after `update`; Poiesis does not restart it for you and never widens a permission to cover a stale session — the correct fix is always re-running against the migrated projection.

Workspace mutations are serialized by one fail-fast lock next to the ownership receipt. If a Poiesis session dies without releasing it, the next mutation fails with `POIESIS_MUTATION_LOCKED` and a diagnostic that names the holder pid, whether it is still running, and the one correct recovery. Poiesis never reclaims the lock automatically: removing a live holder's lock would let two mutations run at once.

Installations created by public `poiesis-cli@1.0.0` have no trusted receipt. Ordinary `update` therefore refuses them. An operator may establish that first trust only with an explicit one-time bootstrap after the known 1.0.0 contract is fully validated. This is operator authority, not cryptographic proof that the checkout-controlled 1.0.0 manifest was originally authored by Poiesis:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update --bootstrap-legacy-ownership
```

After that command succeeds, later `doctor`, `update`, `uninstall`, and capability installation use the normal receipt-backed rules. The flag is rejected if a receipt already exists or the installation is not exactly 1.0.0.

### Everyday commands

Poiesis installs no project script. `init` never writes a `poiesis` entry into your `package.json`, `update` never adds one, and no command maintains one — so there is nothing for a version to drift on and nothing for a stale cache to break. Every command is a `poiesis <command>` invocation through a launcher.

After `init`, the everyday human surface is the exact-version route:

```bash
pnpm dlx poiesis-cli@<manifest.poiesisVersion> doctor
pnpm dlx poiesis-cli@<manifest.poiesisVersion> latest
pnpm dlx poiesis-cli@<manifest.poiesisVersion> model set reasoning openai/gpt-5.6-sol
pnpm dlx poiesis-cli@<manifest.poiesisVersion> update
```

`<manifest.poiesisVersion>` is the `poiesisVersion` recorded in `.poiesis/manifest.json`: the single durable runtime identity. That exact-version route is the one the projected agent permissions admit, and every version-qualified and `@latest` `dlx` variant is denied, so the runtime identity an agent runs under is never ambiguous. When you deliberately want the current published release instead of the recorded one, use the fresh-latest `update` form documented above; that is the intentional human upgrade, and it is a different command from the same-version reconciliation above.

`poiesis latest` is the read-only way to ask whether any of that matters yet. It compares the durable `manifest.poiesisVersion` against the published `poiesis-cli` release and returns `installed`, `latest`, `newerAvailable`, and `lookup` (`ok` or `unavailable`), plus — only when a newer published version actually exists — one copy-paste `updateCommand` pinned to that exact version. It changes nothing: it is one registry request, never a retry, and it fails open on the network, so an unreachable registry can only make the report quieter, never break your session. It never updates Poiesis for you and never restarts OpenCode; running the update stays your decision.

`init` itself installs no launcher on `PATH` either. `poiesis uninstall` removes what it installed, and reinstalling is `init` again.

### Private/local or Team/shared

`init` asks which of these two you want before it asks anything else, and it never picks for you. In a non-TTY `--config` document the same decision is `"mode": "private"` or `"mode": "team"`; a config that omits it fails closed with `INVALID_INSTALL_MODE` rather than installing a sharing policy you did not choose.

| | `"mode": "private"` | `"mode": "team"` |
|---|---|---|
| What Git sees of Poiesis | the one marked `.gitignore` block, and nothing else | the same block, plus the shareable profile it deliberately does not ignore |
| A teammate's fresh clone | gets no Poiesis state and hydrates nothing | gets the profile and hydrates its own local projections from it |
| Sharing policy changes later | explicit `update --config` with a different `"mode"` | explicit `update --config` with a different `"mode"` |

The mode is stable. An ordinary `update`, an ordinary `doctor`, and a capability install keep whatever the manifest records; none of them re-decide it. The only ways it changes are the explicit ones: `update --config` with a different `mode` for an installation this release installed, and `poiesis migrate install-mode --to private|team` for one installed by a release that recorded no mode at all. Both refuse a block that is missing, relabelled, duplicated, malformed, or edited, they touch only paths the manifest can attribute to this installation, and both run inside the same transaction as every other install mutation — a failure restores your `.gitignore` and every other touched byte.

**The visible `.gitignore` contract.** Poiesis manages exactly ONE uniquely delimited, mode-labelled block in your `.gitignore`, and that block is the only Poiesis surface Git is ever meant to see:

```gitignore
# >>> poiesis-managed-ignore mode=team >>>
...
# <<< poiesis-managed-ignore mode=team <<<
```

It is a real file in your repository, it is reviewable in a diff, and it is not a hidden mechanism: there is no `.git/info/exclude` fallback and no other activation of any kind. The block names `.poiesis/` (Poiesis's own canon, config, manifest, receipts, runtime state, caches, workspaces, locks, and logs), then adds the individual generated OpenCode agent projections, the delivery scripts this installation generated, and the skills this installation installed. Generated agent projections are listed one by one rather than as a `.opencode/` wildcard because `.opencode/` is yours; the OpenCode config is named only when Poiesis created it; and a skill directory you already had is never broadly ignored, because you own it.

The classification is closed in BOTH modes, which is what makes sharing safe: changing the mode never widens or narrows what is hidden, only what Poiesis writes outside the block. A second block, a block that starts and ends under different labels, an orphan delimiter, or a line that merely mentions the marker all fail closed with `GITIGNORE_BLOCK_DUPLICATE` / `GITIGNORE_BLOCK_MALFORMED` rather than merging into a policy you did not write. `uninstall` removes the exact unchanged block it recorded and preserves a block you edited, reporting it instead — a deletion on the strength of a hash Poiesis no longer recognises would destroy your edit.

Repeated `init` / `update` / `doctor` cycles converge: a block that already states what the installation owns is left byte-for-byte alone, so a no-op cycle changes no file, no hash, and nothing an uninstall later has to reconcile.

**What a team shares.** In `team` mode Poiesis publishes exactly one directory, `.opencode/poiesis/`, and the block says so in words rather than inventing a negation rule:

- `.opencode/poiesis/config.jsonc` — a portable projection of your resolved configuration (models, repository, tracker, delivery, verification policy), validated before a single byte is written and refused outright if it contains a machine path or a credential;
- `.opencode/poiesis/skills.lock.json` — the selected skills with their locked source, revision, and integrity hash;
- `.opencode/poiesis/overrides/` — project-created instruction and role overrides.

It sits outside `.poiesis/` on purpose: Git cannot re-include a file whose parent directory is excluded, and `uninstall` treats unknown content under `.poiesis/` as preserved-and-reported. Everything else Poiesis writes — the `.poiesis/` tree, the generated OpenCode projections, the OpenCode config it created, the generated delivery scripts, the installed skills — is derived from package canon plus that profile and is regenerated, never committed. The profile is not a manifest record, so `uninstall` never claims it: going team → private removes nothing from it, and `uninstall` preserves it as your content.

A teammate hydrates from it with ordinary `init` and nothing else:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest init --config .opencode/poiesis/config.jsonc
```

The committed profile is adopted rather than rewritten, every ignored local projection is regenerated, and ordinary `opencode` discovery works from the standard project-relative files with no launcher and no environment setup. A profile that contradicts the local configuration, or that is not portable, fails closed with nothing written.

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

Stating a different `"mode"` in that document is the one structural change it
performs, and only because the sharing decision is Author-owned: it is the
explicit Private ⇄ Team transition, covered under
[Private/local or Team/shared](#privatelocal-or-teamshared) above.

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

That includes Poiesis-owned derived state: the Repository Intelligence cache under `.poiesis/cache/repository-intelligence/`, and the generated delivery runtime under `.poiesis/runtime/delivery/`. Ownership of each is exact — Poiesis owns the `repository-intelligence/` entry under `.poiesis/cache/`, and the `delivery/` entry under `.poiesis/runtime/` — and every other sibling in those containers is yours. `uninstall` removes only the owned entry, `rmdir`s the container only when it is empty, and reports anything it preserved. A symlinked container, a symlinked owned entry, or a symlink anywhere inside one is never traversed or deleted: the removal is refused, reported as `preserved`, and the rest of the uninstall proceeds.

**Uninstall is not a history purge.** An ordinary `uninstall` removes every safely attributable Poiesis artifact and then hands back the rest as your data. Three things in particular are never touched by it:

- the ONE Poiesis-managed `.gitignore` block is removed only when it is byte-for-byte the block the manifest recorded; if you edited inside it, `uninstall` preserves it and reports it, because deleting it on the strength of a hash Poiesis no longer recognises would destroy your edit;
- a committed `.opencode/poiesis/` team profile is your content, not a manifest record, so `uninstall` preserves it and ordinary `update` never rewrites it;
- with the `local` tracker, the recorded Spec and ticket history under `poiesis-tracker-v1` beside your Git objects is retained user data. It is reported under `retained`, and it is never a reason for the runtime uninstall to be called incomplete.

Exactly one operation destroys that Local tracker history:

```bash
pnpm dlx poiesis-cli@<manifest.poiesisVersion> uninstall --purge-history --yes
```

It removes only a validated, repository-bound Local tracker store, and only after an interactive confirmation naming what is destroyed and what is not — or the explicit non-interactive `--yes`. Without a TTY and without `--yes` it refuses before touching anything. A symlink, an unknown entry, foreign content, a held store lock, or a store that does not resolve to this repository's canonical path is refused without deleting anything. Git history, remote tracker issues, pull/merge requests, releases, and deployment state are never purge targets — those are not Poiesis's to destroy.

## What `init` produces

`init` cannot run from nothing because every project makes a real choice that only the Author owns. The interactive flow discovers everything it can and asks only for the Author-owned decisions. The successful install writes a resolved `.poiesis/config.jsonc` shaped like:

```jsonc
{
  "schema": 1,
  "mode": "private",
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

`mode` is required and is never inferred: `private` (this clone only) or
`team` (this clone plus the shareable project profile). See
[Private/local or Team/shared](#privatelocal-or-teamshared).

The same shape is the accepted input to `init --config` (for non-interactive / scripted use) and `update --config` (for managed configuration changes after init), with one difference: an `update --config` document must also state its `delivery` decision, because it configures an installation that already recorded one. `repository.remote` and `repository.integrationBranch` are auto-discovered from the Git repository; `verification.commands` are auto-derived from the project's package manager and test scripts.

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

**Configured** delivery is the three command targets above. On the interactive path it is an explicit choice, never a silent default: `init` asks `Configure delivery now? (configured|deferred)` once, offers no bracketed default, and fails closed with `INVALID_DELIVERY_MODE` on any other answer. When an `init` config carries no `delivery` block at all — a non-interactive `init --config` file, for example — Poiesis resolves the three generated command targets instead, because an adapter that actually runs is a better answer than a placeholder. Either way `init` writes a real `scripts/poiesis-{preview,staging,production}.mjs` for any target the project does not already have, and never overwrites a script you wrote yourself. `poiesis update --config` reads that omission differently; see [Configured and deferred delivery](#configured-and-deferred-delivery).

A generated target records what it produced at `.poiesis/runtime/delivery/<target>/<sha>/delivery.json`, in the workspace it ran in. That path is Poiesis-owned derived state, and the ownership is exact: `init`, `update`, and `update --bootstrap-legacy-ownership` each reconcile the single ignore rule `.poiesis/runtime/delivery/` — never the whole `.poiesis/runtime/` container — transactionally, and a failed transaction restores your `.gitignore` byte-for-byte. The runtime is never a manifest file and never a tracked path, so running a target leaves `git status` exactly as it was, in the primary checkout and in a linked workspace alike; `workspace cleanup` is never blocked by delivery residue. `uninstall` removes the owned `delivery/` subtree and the `.poiesis/runtime/` parent when nothing else is there, and leaves any other sibling under `.poiesis/runtime/` byte-for-byte. Write your own artifact path anywhere you like by editing the generated script — Poiesis stops touching it at your first edit.

**Deferred** delivery is an explicit, healthy state:

```jsonc
"delivery": { "mode": "deferred" }
```

The lifecycle runs normally up to and including whole-change Proof for the exact candidate — Prepare, Realize, accepted Review, Checkpoint, Verify — and `doctor` reports the deferred state as a nonblocking warning with `report.ok === true`. `init` generates no delivery scripts, because there is nothing to run.

At Proof the lifecycle hard-stops. `poiesis publish`, `poiesis preview`, `poiesis promote --target staging`, `poiesis promote --target production`, `poiesis integrate`, and `poiesis workspace cleanup` each fail closed with a typed `DELIVERY_DEFERRED` error naming the blocked operation and its remediation — before any push, fetch, remote revalidation, delivery subprocess, integration commit, remote branch deletion, or worktree removal. Nothing claims that Publish, Preview, integration, or completion happened, and you are never asked to validate a realization that was never delivered.

The exact code is the same wherever you run it from. `poiesis publish`, `poiesis preview`, `poiesis promote`, and `poiesis integrate` each run one shared preflight before they read your config: your installed Poiesis version is checked first, then the deferred state above. So a deferred install reports `DELIVERY_DEFERRED` for those operations, and a project with no `.poiesis/config.jsonc` reports `CONFIG_NOT_INSTALLED` for them too, whether you invoke them in the primary checkout or in a Poiesis workspace.

`poiesis workspace cleanup` is the sixth operation, and it decides in the opposite order, because it has to know what it would delete before it can know anything about delivery. Workspace ownership comes first for cleanup: `poiesis workspace cleanup` proves it owns the workspace before it reads any installation, so a cleanup invoked outside a workspace Poiesis can prove it owns is refused with `WORKSPACE_OWNERSHIP_UNKNOWN` and never reaches the installed-state decision. `poiesis workspace cleanup` invoked outside a workspace Poiesis can prove it owns never reports a delivery code at all: on a fully installed deferred project it reports `WORKSPACE_OWNERSHIP_UNKNOWN` rather than `DELIVERY_DEFERRED`. The primary checkout and a linked worktree Poiesis never prepared are both outside an owned workspace, so both report that code, and a directory that is not inside a Git repository at all is refused even earlier, with `NOT_GIT_REPOSITORY`. Inside an owned workspace the precedence is unchanged and strictly ordered: `RUNTIME_VERSION_MISMATCH` when the installed version does not match, then `CONFIG_NOT_INSTALLED` naming the PRIMARY checkout's `.poiesis/config.jsonc` when that installed config is missing, then `DELIVERY_DEFERRED` when it states the deferred mode. Every one of those refusals is decided before the first lifecycle side effect: before any side-effecting subprocess, before any remote branch deletion, before any worktree removal, before any local ref deletion, and before any change to the immutable workspace ownership marker. The read-only `git rev-parse` calls that find the repository and read its ownership markers finish before the refusal is raised — what is guaranteed is that nothing that changes anything has run. A refused cleanup leaves the remote, the branch, the worktree, and the marker exactly as they were.

`poiesis publish` on a CONFIGURED install whose remote is not a recognized forge refuses with `PUBLISH_PROVIDER_UNRESOLVED` instead (see [Publishing coordinates and forks](#publishing-coordinates-and-forks)). Every one of these is fail-closed, and none of them pushes anything.

Those operations require a real installation, too. Once Poiesis has confirmed the project's installed version — and, for `poiesis workspace cleanup`, once it has proved the workspace is one it owns — a project with no `.poiesis/config.jsonc` is an incomplete install, not an exemption, so the operation fails closed with a typed `CONFIG_NOT_INSTALLED` error naming the missing managed path and the managed fix — before your own delivery arguments are turned into an adapter, and before the first side effect. The path it names is always the PRIMARY checkout's, never the workspace you happened to invoke it from. Restore the config with `poiesis init` or `poiesis update --config`; Poiesis never guesses a delivery state it did not install. Unknown extension keys in the `delivery` block — on the three configured targets, on the deferred mode, or inside a target adapter — are preserved as-is, so a newer Poiesis can read a config written by an older one without losing your fields.

Configuring delivery later is the ordinary managed-configuration workflow, never a hand edit of `.poiesis/config.jsonc`: `poiesis update --config`. Supply the proposed complete config as the argument, replacing the `delivery` block with the three command targets and leaving the `tracker` block untouched:

```bash
pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update --config ./poiesis-config.jsonc
```

That transaction is atomic — config, OpenCode projection, manifest, receipt — and `doctor` gates the result. Tracker and delivery stay independent through the change.

An omitted `delivery` block is a fresh-install default, never an update default: `poiesis init --config` resolves it to the three generated command targets, and `poiesis update --config` refuses it. `poiesis update --config` refuses a proposed config that omits `delivery` with `INVALID_DELIVERY_CONFIG` and details `{ field: "delivery", operation: "update --config" }`, before any default resolution, probe, journal, or write, so an installation's recorded delivery decision is never replaced by a default its Author did not choose. The rule is contextual, not a schema change: `delivery` stays optional in the config, so an `init --config` file that omits it still installs, and the three valid shapes — three targets, `{ "mode": "deferred" }`, or three targets plus a partial typo — still fail closed exactly as before. A stated `"delivery": null` is a malformed document rather than an omission, and keeps the schema's own `INVALID_CONFIG` verdict. `poiesis update --config` never generates a delivery script, so configuring delivery later through it requires the Author's own three commands. Point each target's `command` at the script or binary you already have, and keep the installed block honest about what it runs.

The same document also has to answer for `model set`. `poiesis model set reasoning|execution <provider/model>` proposes the installed config with one model field changed, so the resolved `delivery` block is carried through unchanged — a deferred install stays deferred, and a configured install keeps its three targets — and it is that same explicit block, not a re-resolved default, that the transaction writes back.

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
latest                  report whether a newer Poiesis release is published (read-only; never updates)
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

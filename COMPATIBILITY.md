# Compatibility

## OpenCode

The first adapter is built against the adapter-version-1 contract. That contract is verified against OpenCode `1.18.29`, `1.18.30`, and `1.18.31`: all three tags lower the same V1 config schema, expose the same action keys, permission shape, and session endpoints, and accept the projected harness-native payload. The `1.18.30` and `1.18.31` release changes are provider/model-only — they do not alter `--version` (still a bare version string), the `models` inventory shape (still newline-delimited `provider/model`), or the `debug config` parser (still accepts the projected V1 schema).

### Capability-based contract check

The runtime probes the **capability** the installed OpenCode binary actually exposes, not the version string alone. The V1 adapter contract is checked by running the same probes (`opencode --version`, `opencode models`, and `opencode debug config` against the projected schema) that the certified set was originally verified against. The version being on the certified allowlist is treated as informational metadata, not a hard safety boundary — the capability probe results are the real safety boundary.

The capability check has two layers:

1. **`probeOpenCodeAdapterContract(root, options?)`** — non-fatal probe that returns the installed version, the `certified` flag, the latest certified tag, the model inventory (when `probeModels: true`), and the V1 schema acceptance (when `probeSchema: { payload, cwd }` is supplied). Every probe failure is recorded in the report as `null` / `false`; the only non-capability failure is `OPENCODE_UNAVAILABLE` when `opencode --version` itself cannot run.
2. **`assertOpenCodeAdapterContract(root, options?)`** — the hard-fail version. Capability probe failures surface as `OPENCODE_ADAPTER_INCOMPATIBLE` with a `capability` field naming the missing surface (`"models"` or `"debug config schema"`) and the installed version in details, so an operator can diagnose WHAT the installed binary lacks. The version being on `CERTIFIED_OPENCODE_VERSIONS` is **NOT** a hard gate — a newer not-yet-certified patch version whose capability probe passes is allowed to proceed.

### Practical behavior

- `poiesis model set <class> <id>` on `1.18.32` (newer not-yet-certified): the capability probe passes; the mutation lands. The interactive `poiesis model` flow emits a `Warning: OpenCode 1.18.32 has not yet been certified by this Poiesis release. Latest certified compatibility: 1.18.31` notice on stderr between the selector and the restart notice so the operator sees the version status BEFORE the generic restart-handling block. The warning is a CLI / interactive-flow concern; the structured `SetModelResult` does not carry a `versionWarning` field.
- `poiesis model set <class> <id>` on a binary that rejects the V1 schema (real-world drift): the capability probe fails; the operation rejects with `OPENCODE_ADAPTER_INCOMPATIBLE` and details `{ installed, capability: "debug config schema" }` — not a generic `COMMAND_FAILED`.
- `poiesis doctor` on `1.18.32`: the `opencode-version` check reports `status: "warn"` with `details: { installed, latestCertified }` so `doctor.ok` (which gates on `status === "fail"`) is preserved for unrelated fail-closed failures while the newer-not-certified state surfaces a clear informational notice.
- `poiesis init`, `poiesis update`, `poiesis update --config` on `1.18.32`: the capability probe (with `validateOpenCodeConfigPayload`) accepts the V1 schema projection; the install / update proceeds.

Inclusion in the certified set (`CERTIFIED_OPENCODE_VERSIONS`) is gated on probe parity, not on being a newer release: `1.18.31` is certified because `--version`, `models`, and `debug config` behave identically to the already-verified `1.18.29` / `1.18.30` probes against the V1 projection. The certified set is the smallest explicit list of tags with verified V1 probe parity, not a broad semver range. Newer OpenCode releases MUST NOT be added to `CERTIFIED_OPENCODE_VERSIONS` without explicit V1 contract verification.

### Adapter-v1 proof rationale (`1.18.31`)

`1.18.31` was added to the supported set on the same probe-parity basis as `1.18.30`. The decision is intentionally narrow:

- **Scope.** Probe parity is the only criterion. The runtime re-probes the same three surfaces — `opencode --version` (bare version string), `opencode models` (newline-delimited `provider/model`), and `opencode debug config` (accepts the projected V1 schema) — and refuses any installed version that does not match all three.
- **Probe.** No surface behavior changes between `1.18.29`, `1.18.30`, and `1.18.31`. The `1.18.30` and `1.18.31` releases are provider/model-only; the projected `default_agent`, `subagent_depth`, singular `agent.<name>`, singular `agent.<name>.permission`, and the literal `"*"` deny entry remain the exact accepted V1 shape.
- **Adapter-v1.** The V1 schema — singular `agent` map, singular `agent.<name>.permission` object, V1 action keys (`read`, `glob`, `grep`, `list`, `edit`, `webfetch`, `websearch`, `skill`, `task`, `bash`, `question`, `todowrite`), and `mode: "primary" | "subagent"` — is unchanged across the three tags. Any tag that drifts to a different schema fails closed at probe time before the projection is written.
- **Authority.** Manifests produced under any of the three supported tags pass `assertManifestAuthority` because `supportedVersions` (or the legacy `supportedVersion` field for `1.18.29`-only installs) carries the explicit member. The harness-neutral adapter-v1 contract is the source of truth, not the tag's marketing version.

This is the only ground on which a new tag is added to `CERTIFIED_OPENCODE_VERSIONS`: probe parity plus the same V1 schema, with `assertManifestAuthority` as the runtime gate.

### Verified schema

The adapter projects a harness-native schema accepted by OpenCode `1.18.29`, `1.18.30`, and `1.18.31`:

```text
default_agent          string
subagent_depth         integer (default 2)
agent                  object
  <name>.mode          "primary" | "subagent"
  <name>.hidden        boolean
  <name>.model         "<provider>/<model>"
  <name>.permission    object
```

Action keys are the singular OpenCode `1.18.29` / `1.18.30` / `1.18.31` keys: `read`, `glob`, `grep`, `list`, `edit`, `webfetch`, `websearch`, `skill`, `task`, `bash`, `question`, `todowrite`. Permissions are an ordered object where the literal `"*"` denies everything else.

The handoff's `OPENCODE_CONFIG_PATCH_V2.jsonc` is retained as design intent, not copied into projects. Its plural `agents`/`permissions` and `shell`/`subagent` action names are not accepted by any certified tag. Poiesis generates the current native shape and validates it with `opencode debug config`.

### Same-release projection migration (pre-focused-check)

A narrow Worker permission add can land inside a release without bumping the runtime version. v1.4.0 is the published predecessor that carries this shape: the narrow `check *` focused-check allow for the Worker changed the exact OpenCode projection while `manifest.poiesisVersion` stayed `"1.4.0"`. v1.5.0 is the current release and the migration boundary for that install.

A project installed by the earlier `1.4.0` image therefore records `poiesisVersion = "1.4.0"` with a `configPatches` set that no longer equals the `1.4.0` focused-check projection. The compatible migration is:

- **Admitted:** the exact **pre-focused-check** projection for `poiesisVersion = "1.4.0"` — that published predecessor version and no other — and only through the receipt-gated `poiesis update`. For the version it is keyed on, the predecessor differs from that version's own projection in exactly one field: `agent.poiesis-worker.permission.bash` omits the single focused-check allow key, derived through the same builder the current projection uses.
- **Not admitted:** any other version, and any drift from that exact set. A `1.4.0` manifest that does not match is rethrown by the strict check and never falls through to the older 1.0.x projection.
- **Not admitted elsewhere:** `doctor`, `uninstall`, `capability install`, and `poiesis update --config` remain current-projection-only, so a mismatched install is always visible as a `doctor` failure instead of being silently tolerated.
- **No launcher widening:** the projection the migration installs is the current one. It grants the exact-version canonical route `pnpm dlx poiesis-cli@<version> …` only — never a broad `pnpm dlx poiesis-cli@<version> *`, `@latest`, or unversioned route. An off-version runtime (`RUNTIME_VERSION_MISMATCH`) still fails closed before any mutation.

### Release-to-release crossing

An ordinary release bump needs no exceptional migration entry. `assertManifestAuthority` builds the strict projection from the MANIFEST's own `poiesisVersion`, so a project installed by the previously published `1.4.2` image carries the authentic `1.4.2` projection and satisfies the ordinary strict manifest-version check before any predecessor tolerance is consulted. v1.5.0 is the current release.

- **Admitted:** the exact authentic `1.4.2` projection, on the ordinary strict path — the same path a 1.2.1 install takes. Every operation accepts it, including the receipt-gated `poiesis update`.
- **Not admitted:** `"1.4.2"` is deliberately NOT added to the accepted predecessor set. The strict path already admits that exact projection, so a predecessor entry would grant an exceptional migration route to a surface that needs no exception and would widen what projection drift can reach.
- **Drift still fails closed:** a `1.4.2` manifest that does not match its own exact `1.4.2` projection is drift, and fails closed with `MANIFEST_AUTHORITY_INVALID` on every path — strict, predecessor-tolerant, and the receipt-gated `update`.
- **The receipt-gated `update` crosses the release:** it advances `manifest.poiesisVersion` to `1.5.0`, re-keys the exact-version launcher onto `pnpm dlx poiesis-cli@1.5.0 …`, and advances the ownership receipt by exactly one generation.
- **No launcher widening:** the crossed projection grants the exact-version canonical route only — never a broad `pnpm dlx poiesis-cli@<version> *`, `@latest`, or unversioned route.
- **Published artifact parity:** the packed artifact for this release is `poiesis-cli-1.5.0.tgz` and its version agrees with `package.json`, so the exact-version launcher and the published tarball always name the same release.
- **Historical predecessors are unchanged:** the `1.4.0` pre-focused-check migration above, the v1.1.3 / v1.1.4 projection, and the v1.0.0/1.0.1/1.0.2 legacy projection all behave exactly as they did under 1.4.2.

### Subagent visibility

Five internal specialists are projected with `mode: "subagent"` and `hidden: true`:

- `poiesis-planner`
- `poiesis-worker`
- `poiesis-research`
- `poiesis-reviewer`
- `poiesis-final-reviewer`

The single visible primary is `poiesis` (`mode: "primary"`, `hidden: false`). The harness-native `explore` is also projected and routed through the configured execution model.

### Permission filtering

Per-target permission filtering narrows the visible surface but is not treated as a hard security boundary. Prompt role boundaries remain mandatory. Nested support delegation uses `subagent_depth: 2` and avoids interactive permission asks to prevent child-of-child deadlocks.

### Session cleanup

Session cleanup targets the supported HTTP endpoints at the OpenCode server (`http://127.0.0.1:4096` by default):

- `GET /session/<id>` — existence check
- `GET /session/<id>/children` — child enumeration
- `DELETE /session/<id>` — deletion

Cleanup is leaf-first, bounded by depth, best-effort, and never blocks correctness. It is required at a deterministic handoff or termination whenever the child session identity is known, and still never gates the lifecycle. Session-server integration is exercised via black-box acceptance, not by unit tests in this bundle.

## Skills

Poiesis uses the upstream `skills@1.5.24` CLI and project-local `.agents/skills/` installs.

- `mattpocock/skills` is pinned to `3cca18b368ae95cdbdebbff572ccafa662551015`.
- `obra/superpowers` is pinned to `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.

The installer passes exact skill names as separate `--skill name ...` arguments; it never uses the defective `--skill=name` form and never installs the full Superpowers plugin.

### Curated defaults (11)

```text
grilling                       (mattpocock/skills)
grill-with-docs                (mattpocock/skills)
domain-modeling                (mattpocock/skills)
research                       (mattpocock/skills)
codebase-design                (mattpocock/skills)
to-spec                        (mattpocock/skills)
to-tickets                     (mattpocock/skills)
code-review                    (mattpocock/skills)
diagnosing-bugs                (mattpocock/skills)
test-driven-development        (obra/superpowers)
verification-before-completion (obra/superpowers)
```

Caveman / Cavecrew are deferred dogfood experiments and not installed by v1.

### Skill invocation

Current upstream metadata marks `to-spec` and `to-tickets` as user-invoked. OpenCode `1.18.29` does not interpret that non-standard metadata and supports explicit native Skill-tool calls. The OpenCode adapter uses those calls automatically at Specify and Tickets while keeping Author gates, delegation, tracker mutation, commits, and lifecycle progression under Poiesis. This is an OpenCode-specific compatibility exception, not a portable upstream invocation contract.

## Providers

### Models

Reasoning model:
- Poiesis
- Planner
- Final Spec Review
- Final Standards Review

Execution model:
- Explore (native)
- Research
- Worker
- Ticket Reviewer
- debugging execution

`init` and `doctor` verify that both configured IDs appear in the `opencode models` inventory. Unavailability is reported as a structured failure, never silently substituted.

### Trackers

Production-capable tracker adapters:

- GitHub through `gh`
- GitLab through `glab`
- Linear through its GraphQL API
- Local, clone-local, with no external service

The tracker choice and the delivery choice are independent: any production tracker can be combined with configured delivery or with `"delivery": { "mode": "deferred" }`.

#### GitHub and GitLab

`gh` and `glab` must be installed and authenticated for the target project. `tracker.project` is `<owner>/<repository>` for GitHub and the nested `group/subgroup/project` path for GitLab. A coordinate may be inferred from a recognized `github.com` or `gitlab.com` remote when the config does not state one.

#### Linear

Linear is a first-class tracker, reached over `https://api.linear.app/graphql`. Its coordinates are a required `tracker.team` (key or name) plus an optional `tracker.project`. Poiesis never invents a team: an empty `tracker.team` fails closed with `INVALID_TRACKER_CONFIG`.

The credential is environment-only. Set exactly one of:

- `LINEAR_API_KEY` — a personal API key, sent as the raw `Authorization` value.
- `LINEAR_OAUTH_TOKEN` — an OAuth access token, sent as `Authorization: Bearer <token>`.

Both set fails closed with `LINEAR_AUTH_AMBIGUOUS`; neither set fails closed with `LINEAR_AUTH_MISSING`. The credential is never stored in the Poiesis config, never placed in a tracker item, never logged, and never echoed into an error message or an error's `details` — every byte that could reach an error goes through the redactor first.

#### Local

`local` needs no CLI, no service, no network call, no credential, and no project coordinate. It is a production tracker, not a test fixture.

State lives in `poiesis-tracker-v1` beneath the Git common directory (`git rev-parse --git-common-dir`), which keeps it outside every working tree and shared by every linked worktree of the clone. The store is created as a `0700` directory holding `0600` regular files. Items carry monotonic `LOCAL-<n>` identities. Validation is strict and fails closed: a non-JSON store, an unknown schema version or provider, a non-positive or colliding next id, a non-`LOCAL` identifier, a symlinked or world-readable file, or a symlinked store directory or lock path is refused rather than repaired. Cross-process writers serialize on a token-checked lock, so a live foreign lock is never stolen and a stale lock left by a dead process is reclaimed only within a bounded wait.

That canonical lock is mutated only under a sibling `store.lock.guard` acquired with an exclusive create, and the runtime never reclaims a guard: a guard left behind by a crash stays on disk and fails every later acquisition with `LOCAL_TRACKER_LOCK_TIMEOUT` after the bounded wait. That error names both paths and the ordered procedure — first verify that no Poiesis process is accessing the clone, then remove only the exact `store.lock.guard` artifact and retry — and the canonical `store.lock` is never a removal target, because the ordinary holder-PID and ownership-token check already reclaims a stale one within the bounded wait. The exact guard path travels as a field on that error, and the procedure is stated in prose that names the two artifacts rather than printing a command to run. A clone directory name Poiesis did not choose can never become an argument or a substitution in a command an operator copies out of an error message. A `store.lock` that is present but unreadable or malformed is a separate case: it is corruption, the runtime never unlinks unknown bytes, and clearing it is the operator's decision rather than part of the guard procedure.

The store is bounded, because it is the whole history and the whole history only ever grows. The canonical document is one complete snapshot of every Spec, Ticket, comment, and history entry, and that snapshot is bounded: the total serialized store, including its trailing newline, may not exceed 16,777,216 UTF-8 bytes. History is retained in full, so the file only ever grows and an operator reaches the ceiling by recording more work rather than by losing any. One bounded load serves the lock-free read, the mutation, and the `poiesis doctor` tracker check, so a bound cannot exist on one path and be missing from another. A read consumes at most one byte more than that ceiling and refuses with `LOCAL_TRACKER_STORE_TOO_LARGE` before it parses anything, so a file that keeps growing under a reader stays a bounded read. A mutation serializes its candidate once, measures those bytes, and refuses before the durable replace, so a refused write leaves the canonical bytes, the history, the lock, and the file mode exactly as they were. A later mutation that does fit still commits, so a refusal never wedges the protocol and never denies a writer the store. The refusal carries only the store `path`, the bytes actually consumed as `sizeBytes`, and the ceiling as `maxBytes`, and it states no procedure at all, because the two numbers say everything an operator can act on and a path this module did not choose must never become part of a command. Nothing is pruned to fit and nothing is repaired automatically: an over-ceiling store is left byte-for-byte as it is, and reducing it is the operator's decision about their own work.

#### fixture

`fixture` is test-only, requires `--allow-fixtures` at `init` time, and writes outside the repository root.

### Publishing coordinates

Publishing coordinates are a property of the configured Git remote, never of the tracker. Poiesis uses the remote when it is a recognized `github.com` or `gitlab.com` host, otherwise the test-only `fixture` tracker's `tracker.project`, and otherwise fails closed with `PUBLISH_PROVIDER_UNRESOLVED` before any push, fetch, remote revalidation, change request, or evidence. A `github` or `gitlab` tracker never supplies coordinates, and `linear` and `local` never appear as the `provider` of Publish evidence. A remote URL that carries userinfo is parsed as the remote it is, with the credential stripped from every coordinate, report, error detail, and log line Poiesis emits.

A fork is a different repository, not a shortcut to its upstream. A remote naming a fork is a recognized host, so the change request is opened against that fork's own integration branch, and Publish fails closed if the resulting change request is owned by a different repository than the coordinates Poiesis resolved. A self-hosted host or a filesystem remote is not a recognized host and yields no coordinates.

### Delivery

Delivery uses an argv-only command adapter. The command consumes the exact candidate SHA plus candidate tree and source receipt environment, and returns exact `sha`, `candidateTree`, `target`, `verified: true`, and an `artifactIdentity` matching a returned `id`, `url`, or `artifact`. Staging consumes an operation-produced Preview receipt and returns a directly consumable Staging receipt. This strict receipt schema intentionally rejects unbound 1.0.0 delivery JSON.

Production authorization is JSON bound to the candidate SHA/tree, Staging artifact identity, integration SHA, explicit approval, and Author identity. Production fetches `repository.remote` / `repository.integrationBranch`, requires the integration SHA to be the exact remote head, and verifies its actual Git tree before invoking the delivery command.

Fixture delivery is test-only, requires `--allow-fixtures`, and writes outside the repository root.

### Deferred delivery

`"delivery": { "mode": "deferred" }` is an explicit, healthy product state, not a defect. `poiesis doctor` reports it as a nonblocking `warn` on the `delivery` check and keeps `report.ok` true. `init` writes no `scripts/poiesis-{preview,staging,production}.mjs` for a deferred install.

One central policy guard reads the installed config — with no auto-resolution, no subprocess, and no network — and every gated operation calls it before its first side effect. `poiesis publish`, `poiesis preview`, `poiesis promote --target staging`, `poiesis promote --target production`, `poiesis integrate`, and `poiesis workspace cleanup` each fail closed with `DELIVERY_DEFERRED`, naming the blocked operation and its remediation, before any push, fetch, remote revalidation, delivery subprocess, integration commit, remote branch deletion, or worktree removal. The four `poiesis` commands that read the installed config (`publish`, `preview`, `promote`, `integrate`) additionally run one shared preflight before that read: runtime identity first, then this same policy guard, so the CLI reports the same code and details the library seam does, ahead of config auto-resolution and publishing-coordinate resolution. `poiesis preview` and `poiesis promote` therefore refuse at that preflight, before there is any delivery adapter to construct. On a CONFIGURED install, `poiesis publish` still refuses with `PUBLISH_PROVIDER_UNRESOLVED` when the configured remote is not a recognized forge; that is a separate, equally fail-closed condition and produces the same zero remote side effects.

That same guard also decides the installed state. A gated operation runs only where Poiesis is actually installed, so once the runtime identity guard has confirmed the manifest exists and its version matches, a project with no `.poiesis/config.jsonc` is an incomplete install rather than an exemption: those operations fail closed with `CONFIG_NOT_INSTALLED`, naming the missing managed path and the managed remediation, before any caller-supplied delivery config is turned into an adapter and before the first side effect. A missing manifest keeps its existing precedence and still reports `RUNTIME_VERSION_MISMATCH` with `details.project: null`.

That installed-state decision is not the first decision every gated operation makes, and the compatibility contract names which one is. Only `poiesis workspace cleanup` resolves workspace ownership before it reads an installation, and its command is the one with no preflight of its own, so its ownership decision is the first one an operator reaches. `poiesis publish` and `poiesis integrate` reach workspace ownership only after the shared preflight has accepted the installed state, so their commands invoked from an unowned working directory report the installed-state code the preflight decided, never `WORKSPACE_OWNERSHIP_UNKNOWN`. Workspace ownership comes first for cleanup: `poiesis workspace cleanup` proves it owns the workspace before it reads any installation, so a cleanup invoked outside a workspace Poiesis can prove it owns is refused with `WORKSPACE_OWNERSHIP_UNKNOWN` and never reaches the installed-state decision. `poiesis workspace cleanup` invoked outside a workspace Poiesis can prove it owns never reports a delivery code at all: on a fully installed deferred project it reports `WORKSPACE_OWNERSHIP_UNKNOWN` rather than `DELIVERY_DEFERRED`. The primary checkout and a linked worktree Poiesis never prepared are each such a cwd; a directory that is not inside a Git repository at all is refused even earlier, with `NOT_GIT_REPOSITORY`. Inside an owned workspace the precedence is unchanged and strictly ordered: `RUNTIME_VERSION_MISMATCH` when the installed version does not match, then `CONFIG_NOT_INSTALLED` naming the PRIMARY checkout's `.poiesis/config.jsonc` when that installed config is missing, then `DELIVERY_DEFERRED` when it states the deferred mode. `poiesis preview` and `poiesis promote` have no workspace to prove, so they report the installed-state failure from the primary installation authority from any directory of the clone. Every one of those refusals is decided before the first lifecycle side effect: before any side-effecting subprocess, before any remote branch deletion, before any worktree removal, before any local ref deletion, and before any change to the immutable workspace ownership marker. The read-only `git rev-parse` calls that locate a root, read the common directory, and read the ownership markers complete before the refusal is raised; what is guaranteed is that nothing that mutates has run.

Both `delivery` branches are forward compatible: unknown outer extension keys on the configured block and on `{ "mode": "deferred" }`, and unknown keys nested inside a target adapter, survive parse and serialize, so a runtime that does not recognize a key never deletes it from the managed config. The semantic rejections are unchanged — a partial target set, an unknown `delivery.mode`, and a deferred block that also carries a target are still typed `INVALID_DELIVERY_CONFIG` failures.

Delivery is configured later through `poiesis update --config`, never by hand-editing the managed config. The change is atomic and leaves the `tracker` block untouched.

An omitted `delivery` block is a fresh-install default, never an update default: `poiesis init --config` resolves it to the three generated command targets, and `poiesis update --config` refuses it. `poiesis update --config` refuses a proposed config that omits `delivery` with `INVALID_DELIVERY_CONFIG` and details `{ field: "delivery", operation: "update --config" }`, before any default resolution, probe, journal, or write, so an installation's recorded delivery decision is never replaced by a default its Author did not choose. The `field` and `operation` details are what separate this refusal from the partial-block rejection above: an omitted block is not an incomplete answer, it is no answer. The rule is contextual and does not tighten the schema — `delivery` remains optional, so `init --config` keeps its legacy generated default and a stated `"delivery": null` keeps the schema's own `INVALID_CONFIG` verdict. `poiesis update --config` never generates a delivery script, so configuring delivery later through it requires the Author's own three commands.

### Installation authority and linked worktrees

Poiesis installs into the PRIMARY checkout of a clone, and that installation is the authority for every guarded operation in every linked worktree of the same clone. A linked worktree carries none of the primary's managed Poiesis state, so an operation launched from one is judged by the install that governs the clone, not by the worktree's silence.

The authority is DERIVED, never supplied. `previewDelivery` and `promoteDelivery` read one `git rev-parse --absolute-git-dir --git-common-dir` and reconcile it themselves: two equal paths are a primary checkout that owns its own installation, two different paths are a linked worktree whose common directory is the primary's `.git`, and a report that cannot produce two paths, or that names a filesystem root, leaves the invocation root standing rather than a guess. No caller supplies an authority root, and no guard decides by searching for a config file, because a project whose installed config is missing is exactly the case the installed-state guard has to diagnose. The reconciliation is one side-effect-free subprocess: it never touches the network, a remote, or the working tree.

A configured linked worktree therefore previews and promotes against the PRIMARY install — the runtime-identity guard, the installed-state check, and the delivery-policy guard read the primary's `manifest.poiesisVersion`, `.poiesis/config.jsonc`, and `delivery` block — while the delivery still EXECUTES where it was invoked: the candidate is resolved and the delivery command runs in the linked worktree, so the worktree's own candidate and evidence are the ones the operation is about. A worktree that declares a deferred install of its own does not displace the primary either; the shared authority is the primary's. The `poiesis` CLI and the library seam reach the same decision from the same worktree, so a library caller and an operator see the same code, the same details, and the same delivered artifact.

The derivation uses the platform's own path semantics rather than a POSIX-only string rule. The primary checkout is the directory above the common directory, and the same rule answers for both flavors: `/srv/primary/.git` gives `/srv/primary` and `C:\primary\.git` gives `C:\primary`. Stripping a trailing separator and the last `/`-delimited segment is correct on POSIX and inert on Windows: a Windows path has no `/` in it, so that rule strips nothing, returns its own input, and resolves a linked worktree to itself — which is precisely the authority split this derivation exists to prevent.

## Repository Intelligence (v1.2)

Poiesis v1.2 adds a rebuildable, non-canonical local graph as a default internal capability. The engine is Graphify, pinned to an exact version, run through `uvx` so Poiesis owns neither a global Graphify install nor a global Python interpreter.

### Standard requirement: `uv`

`uv` is a STANDARD Poiesis requirement as of v1.2, not an optional optimization. The exact-pinned invocation form is:

```text
uvx --python 3.12 --from graphifyy==<pin> graphify <subcommand>
```

A missing `uv` makes every canonical lifecycle surface fail closed:

- `poiesis init` fails before any canonical mutation with the typed `REPOSITORY_INTELLIGENCE_REQUIREMENT_MISSING` error. The error names the missing dependency (`uv`), the install entry point (`https://docs.astral.sh/uv/`), and the canonical Python pin (`3.12`). No manifest write, no `.poiesis/` directory creation, no OpenCode config write, no skills install, no receipt write.
- `poiesis update` and `poiesis update --config` inherit the same failure through the existing `assertUpdateDoctorGate` predicate (which throws `UPDATE_DOCTOR_FAILED` and reverses the bounded journal rollback path).
- `poiesis doctor` reports the same condition as a hard `fail` with details `{ requirement: "uv", python: "3.12", engine: "graphify", engineVersion, uvAvailable: false, hint: "missing-binary", action: "install-uv" }`. The overall `report.ok` is `false`.

Poiesis never installs `uv`, never vendors Python, never offers a fallback flag, and never asks the Author a question about it.

Runtime repository operations (`poiesis repository query` / `path` / `explain` in later tickets) may still return a typed fallback via `poiesis repository status`'s `reason: "uv-unavailable"` when a previously working dependency disappears after installation. The requirement is on fresh `init` / `update` transactions and on doctor; the runtime query path keeps the Spec #120 §35 fallback invariant ("Poiesis must still be able to complete the normal Method if Repository Intelligence disappears entirely").

### Pinned Graphify runtime

- engine: `graphify`
- pinned package: `graphifyy==0.9.70`
- Python: `3.12`
- invocation: `uvx --python 3.12 --from graphifyy==0.9.70 graphify ...`

The runtime owns the pin; moving the pin in a future Poiesis release is an `update`-driven cache invalidation, not a Graphify-managed migration. A newer or older `state.json` `engineVersion` is reported by `poiesis repository status` as `reason: "engine-version-mismatch"` and by `poiesis doctor` as a `warn` that the next query will rebuild with the pinned engine.

### Local-state cache

The derived cache lives under `.poiesis/cache/` (Poiesis-owned local state). It is gitignored by `poiesis init` through the same `.gitignore` transaction the manifest and workspaces rules use, and it is never recorded as a manifest file. The directory is owned by Poiesis only at `.poiesis/cache/repository-intelligence/`; foreign siblings under `.poiesis/cache/` are preserved by `poiesis uninstall`.

### Generated delivery runtime

A delivery target records its artifact under `.poiesis/runtime/delivery/<target>/<sha>/delivery.json` (Poiesis-owned derived state). The ownership is exact and one-directional:

- The `.gitignore` rule is `.poiesis/runtime/delivery/`. `poiesis init`, the receipt-authenticated `poiesis update`, and the explicit `poiesis update --bootstrap-legacy-ownership` each reconcile that one rule, transactionally with a byte-exact rollback; `poiesis update --config` intentionally does not touch `.gitignore`. The rule is the owned subtree, never the whole `.poiesis/runtime/` container, so state Poiesis does not own stays visible.
- The runtime is never a manifest file and never a durable (tracked) path, so nothing under it is hash-gated managed state.
- A generated target run therefore leaves `git status` byte-identical to its pre-run value, including in a linked worktree, so `poiesis workspace cleanup` is never blocked by delivery residue (`DIRTY_WORKSPACE_CLEANUP_FORBIDDEN`).
- `poiesis uninstall` removes the complete owned `.poiesis/runtime/delivery/` subtree and the `.poiesis/runtime/` parent when nothing else remains. A foreign sibling under `.poiesis/runtime/` survives byte-for-byte, is reported as `preserved`, and keeps the uninstall incomplete with the ownership receipt retained.
- A symlinked runtime container, a symlinked `delivery` root, or a symlink at any depth inside the owned subtree is never traversed or deleted: the removal is refused with `DELIVERY_RUNTIME_UNSAFE` (or `DELIVERY_RUNTIME_UNOWNED` for a non-directory target), reported as `preserved`, and the installation stays intact.

## Process execution

All external command execution is bounded:

- per-call `timeoutMs` (default 30s, max 30min);
- per-call `maxBytes` for stdout/stderr capture (default 256KB);
- structured `COMMAND_TIMEOUT` error with diagnostic detail on timeout;
- `COMMAND_FAILED` on ordinary non-zero exit;
- `stdoutTruncated`/`stderrTruncated` flags recorded when bound is hit;
- bounded SIGTERM then SIGKILL termination of the managed process group, on the platforms where the group can still be attributed to the lease (see below).

### Verification command execution

`verification.commands` and `verification.postIntegrationCommands` are shell command strings, not argument vectors, and both run through the same interpreter: Poiesis executes each one as `/bin/sh -c <command>`, with the working directory set to the canonical Git root of the exact candidate it is proving — the repository root for `poiesis verify`, and the temporary detached worktree Poiesis creates for the integrated commit for post-integration verification. The interpreter is that exact path: there is no PowerShell, `cmd.exe`, or `sh`-on-`PATH` route, so a host without `/bin/sh` cannot run verification and the requirement is documented in the README rather than declared as a `package.json` `os` restriction. Nothing else about the execution is host-dependent: the per-command timeout, the bounded stdout/stderr evidence, the exact-SHA clean assertions before and after, and the merged environment are identical on every host.
### Group-local cleanup: what a platform must be able to prove

A managed process group is addressed as a group or not at all. Poiesis never enumerates it: there is no process-table walk, no member snapshot, no per-PID signal, and therefore no survivor list to report. The group may be signalled only while the leased leader that gave the group its id can still be re-confirmed by exact **process-start identity** and exact process-group id — the Linux model, read from the kernel's per-PID process table. Group liveness proves absence, never ownership: once the leader is gone, the group id is a PID that any later process may be handed.

| Host | Live managed group at timeout, cancellation, or a lingering leak |
| --- | --- |
| Linux | settled: group `SIGTERM`, bounded wait, leader re-confirmed, group `SIGKILL`, bounded wait, success confirmed only when the group no longer exists |
| macOS and the other non-Linux POSIX platforms | no signal is sent at all; the run rejects `PROCESS_CLEANUP_REFUSED` with `details.reason: UNSUPPORTED_IDENTITY` and the actionable `details.pid` / `details.processGroupId`, because nothing about the group can be attributed without a readable process-start identity. A command that exits on its own still settles normally |
| Windows | no POSIX groups exist; the tree is reached with `taskkill /PID <pid> /T`, then `/F`, then `child.kill`, each phase bounded by the child's own `exit` event, and each PID-directed step suppressed once the child has exited |
| Linux with a delegated cgroup v2 leaf | unchanged and authoritative: `cgroup.kill` empties the leaf and `cgroup.events` confirms `populated 0`; once that confirmation lands, no group-local settlement runs at all |

Two failure envelopes describe a managed process group on any platform, and both outrank success, failure, timeout, and cancellation because they mean a process Poiesis spawned may still be running:

- `PROCESS_CLEANUP_REFUSED` — nothing was signalled and nothing can be. Carries `details.reason` (`MALFORMED_LEASE`, `UNSAFE_TARGET`, `UNSUPPORTED_IDENTITY`, `IDENTITY_AMBIGUOUS`, `PID_REUSE`, `FOREIGN_PROCESS`), `details.detail`, `details.operationId`, `details.workspaceId`, `details.pid`, `details.processGroupId`.
- `PROCESS_CLEANUP_UNRESOLVED` — a signal was sent but the group is still there, or Poiesis declined to send the next one. Carries `details.reason` (`GROUP_AUTHORITY_LOST` when the leader stopped being provable while the group remained — nothing further is signalled, and a leader that merely finished first waits a bounded natural-settlement window for the group to empty itself; `GROUP_STILL_PRESENT` when a provable leader still did not empty it), `details.phase` (`before-sigterm`, `before-sigkill`, `confirm`), `details.leaderState` (`live`, `gone`, `terminal`, `unreadable`, `reused`, `foreign`, `unconfirmed`), `details.pid`, `details.processGroupId`, `details.membersEnumerated: false`, `details.confirmed: false`. On Windows the same code carries `details.platform` and `details.phases` instead, because that path is `taskkill`-based.

A zombie is terminal: it can never be a signal target, and it is never reported as a surviving process.

### Strong containment for arbitrary command text

Two execution contracts exist and are not interchangeable.

**Fixed-argv commands** — `git`, `gh`, `uv`, `opencode`, delivery executables, and any direct library caller of `run()` with a vector Poiesis chose — run under a managed process GROUP. That is isolation, not containment: `setsid(2)` creates a new session and process group, and a descendant is reparented when its parent exits, so neither is visible to a group-directed signal afterwards.

**Arbitrary command TEXT** cannot rely on that. Three surfaces execute it, and all three require the same kernel-enforced boundary:

| Surface | Commands it runs |
| --- | --- |
| `poiesis verify` | the installation's verification plan, in the exact candidate workspace |
| `poiesis check` | the explicit `--command` values, in an owned (possibly dirty) candidate workspace |
| `poiesis integrate` | the configured `postIntegrationCommands`, in a throwaway worktree over the integrated revision |

Each reaches the command processor through the same seam (`/bin/sh -c` on POSIX; a validated absolute `ComSpec` naming `cmd.exe` with `/d /s /c` on Windows), passes the command through byte-identical as the final argv element, and runs inside a boundary provisioned BEFORE the spawn.

| Host | Required capability | Status |
| --- | --- | --- |
| Linux, delegated cgroup v2 subtree | a Poiesis-owned leaf exposing `cgroup.kill`, `cgroup.procs`, `cgroup.events` | supported; the leaf is provisioned before the spawn and entered through a Poiesis-owned two-phase startup — the child reports its kernel identity, is admitted and confirms that membership against the same identity, and only then runs the caller's argv — settled with `cgroup.kill` confirmed by `cgroup.events` |
| Linux, no delegated subtree | — | refused before spawning |
| Windows | a no-breakaway Job Object created by a native launcher before the child is created | refused before spawning; this runtime ships no such launcher |
| macOS and the other non-Linux POSIX platforms | — | refused before spawning; no portable strong primitive exists |

On a refused host the three surfaces above fail with `PROCESS_CONTAINMENT_UNAVAILABLE`, carrying `details.reason` (`NO_CGROUP_V2`, `NO_DELEGATION`, `NO_CGROUP_KILL`, `PROVISION_FAILED`, `UNSUPPORTED_PLATFORM`), `details.platform`, the missing capability in `details.detail`, and a `details.remediation` naming a Linux host with a delegated cgroup v2 subtree. Nothing is spawned and nothing is reported as verified, so "the plan passed" can never be a statement about a run that never happened.

Post-integration commands are gated by the same rule as the verification plan. A host that cannot contain the candidate's plan cannot contain the integrated revision either; `postIntegrationCommands` is not a weaker surface and does not fall back to `verification.commands`.

When the host does provide the capability but the startup cannot be confirmed, the run is refused with `PROCESS_CONTAINMENT_REFUSED`, carrying `details.reason` — `STARTUP_IDENTITY_UNCONFIRMED` when the child's reported kernel identity is missing, malformed, or disagrees with a fresh kernel read of that PID, and `ADMISSION_UNCONFIRMED` when the admission itself is missing or is not bound to the identity Poiesis leased. When the boundary cannot be confirmed settled, it fails with `PROCESS_CLEANUP_UNRESOLVED`; a startup refused before a lease existed additionally requires the child's own linked exit and reports `details.reason: STARTUP_EXIT_UNCONFIRMED` when that proof never arrives. Both outrank success, failure, timeout, and cancellation, because they mean a process Poiesis spawned may still be running.

### Command-processor availability

The processor is resolved and validated BEFORE any process exists, so a host with no usable one refuses rather than failing as an opaque spawn error. `COMMAND_PROCESSOR_UNAVAILABLE` carries `details.reason` (`PROCESSOR_NOT_EXECUTABLE` on POSIX; `COMSPEC_MISSING`, `COMSPEC_NOT_ABSOLUTE`, `COMSPEC_NOT_COMMAND_PROCESSOR`, `COMSPEC_UNAVAILABLE` on Windows), `details.platform`, `details.processor` (the path that was rejected), `details.detail`, and a `details.remediation` for the host.

`poiesis check` passes that refusal through with its own code and those fields intact, and with the bounded `details.check` evidence attached — it is a host limitation, not a failing command. It deliberately attaches none of the `details.migration` advice that a genuine `FOCUSED_CHECK_FAILED` carries, because `poiesis verify` resolves command text through the same processor and would refuse identically. `verify` keeps its own fail-closed propagation of the same error. Nothing is spawned either way.

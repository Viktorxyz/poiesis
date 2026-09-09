# Compatibility

## OpenCode

The first adapter is pinned to OpenCode `1.18.29`. The runtime validates the installed version against this exact string with `opencode --version` before applying changes.

### Verified schema

The adapter projects a harness-native schema accepted by OpenCode `1.18.29`:

```text
default_agent          string
subagent_depth         integer (default 2)
agent                  object
  <name>.mode          "primary" | "subagent"
  <name>.hidden        boolean
  <name>.model         "<provider>/<model>"
  <name>.permission    object
```

Action keys are the singular OpenCode `1.18.29` keys: `read`, `glob`, `grep`, `list`, `edit`, `webfetch`, `websearch`, `skill`, `task`, `bash`, `question`, `todowrite`. Permissions are an ordered object where the literal `"*"` denies everything else.

The handoff's `OPENCODE_CONFIG_PATCH_V2.jsonc` is retained as design intent, not copied into projects. Its plural `agents`/`permissions` and `shell`/`subagent` action names are not accepted by OpenCode `1.18.29`. Poiesis generates the current native shape and validates it with `opencode debug config`.

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

Cleanup is leaf-first, bounded by depth, best-effort, and never blocks correctness.

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

`fixture` is test-only, requires `--allow-fixtures` at `init` time, and writes outside the repository root.

### Delivery

Delivery uses an argv-only command adapter. The command consumes the exact candidate SHA plus candidate tree and source receipt environment, and returns exact `sha`, `candidateTree`, `target`, `verified: true`, and an `artifactIdentity` matching a returned `id`, `url`, or `artifact`. Staging consumes an operation-produced Preview receipt and returns a directly consumable Staging receipt. This strict receipt schema intentionally rejects unbound 1.0.0 delivery JSON.

Production authorization is JSON bound to the candidate SHA/tree, Staging artifact identity, integration SHA, explicit approval, and Author identity. Production fetches `repository.remote` / `repository.integrationBranch`, requires the integration SHA to be the exact remote head, and verifies its actual Git tree before invoking the delivery command.

Fixture delivery is test-only, requires `--allow-fixtures`, and writes outside the repository root.

## Process execution

All external command execution is bounded:

- per-call `timeoutMs` (default 30s, max 30min);
- per-call `maxBytes` for stdout/stderr capture (default 256KB);
- structured `COMMAND_TIMEOUT` error with diagnostic detail on timeout;
- `COMMAND_FAILED` on ordinary non-zero exit;
- `stdoutTruncated`/`stderrTruncated` flags recorded when bound is hit;
- safe SIGTERM then SIGKILL termination on timeout.

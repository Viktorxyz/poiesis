# Compatibility

## OpenCode

The first adapter is pinned to OpenCode `1.18.29`.

The live schema and installed implementation use:

```text
agent
permission
bash
task
default_agent
subagent_depth
```

The handoff's `OPENCODE_CONFIG_PATCH_V2.jsonc` is retained as design intent, not copied into projects. Its plural `agents`/`permissions` and `shell`/`subagent` action names are not accepted by OpenCode `1.18.29`. Poiesis generates the current native shape and validates it with `opencode debug config`.

Per-target task permissions narrow the visible surface but are not treated as a hard security boundary. Prompt role boundaries remain mandatory. Nested support delegation uses `subagent_depth: 2` and avoids interactive permission asks.

Session cleanup targets the supported `GET /session/:id/children`, `DELETE /session/:id`, and `GET /session/:id` HTTP endpoints. Cleanup is best effort and never carries durable workflow truth.

## Skills

Poiesis uses `skills@1.5.24` and project-local `.agents/skills/` installs.

- `mattpocock/skills` is pinned to `3cca18b368ae95cdbdebbff572ccafa662551015`.
- `obra/superpowers` is pinned to `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.

The installer passes exact skill names as `--skill name ...`; it never uses the defective `--skill=name` form and never installs the full Superpowers plugin.

Current Matt metadata marks `to-spec` and `to-tickets` user-invoked. OpenCode `1.18.29` does not interpret that non-standard metadata and supports explicit native Skill-tool calls. The OpenCode adapter uses those calls automatically at Specify and Tickets while keeping Author gates, delegation, tracker mutation, commits, and lifecycle progression under Poiesis. This is an OpenCode-specific compatibility exception, not a portable upstream invocation contract.

## Providers

Production-capable tracker adapters:

- GitHub through `gh`;
- GitLab through `glab`.

Delivery uses an argv-only command adapter. The command must consume the exact candidate SHA and return JSON. Staging and Production commands must include health verification and return `verified: true`.

Fixture tracker and delivery adapters are test-only, require explicit authorization at init, and must write outside the repository.

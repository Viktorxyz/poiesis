# Poiesis v1.1 — Final Implementation Handoff

You are implementing **Poiesis** from scratch.

All source/design files for this handoff are in one flat directory: `/poiesis`.

Do not ask the user to reorganize them.

## 1. Read these files first, in this order

1. `POIESIS_FOUNDATION_v1.1.md`
2. `POIESIS_PHILOSOPHY.md`
3. `POIESIS_METHOD.md`
4. `POIESIS_INSTALL_LAYOUT.md`
5. `POIESIS_ROLE_POIESIS.md`
6. `POIESIS_ROLE_PLANNER.md`
7. `POIESIS_ROLE_WORKER.md`
8. `POIESIS_ROLE_RESEARCH.md`
9. `POIESIS_ROLE_REVIEWER.md`
10. `POIESIS_CONFIG_TEMPLATE.jsonc`
11. `POIESIS_MANIFEST_TEMPLATE.json`
12. `POIESIS_SKILLS.json`
13. `OPENCODE_AGENT_POIESIS.md`
14. `OPENCODE_AGENT_PLANNER.md`
15. `OPENCODE_AGENT_WORKER.md`
16. `OPENCODE_AGENT_RESEARCH.md`
17. `OPENCODE_AGENT_REVIEWER.md`
18. `OPENCODE_AGENT_FINAL_REVIEWER.md`
19. `OPENCODE_CONFIG_PATCH_V2.jsonc`

Treat these as one specification.

If older Poiesis/opencode-ship files disagree, these files win.

## 2. Build a new product, not a rename

Do not refactor or rename `opencode-ship`.

Create Poiesis from scratch as:

```text
harness-neutral method
+
small deterministic npm runtime/CLI
+
OpenCode first adapter
```

No OpenCode plugin.

No workflow database.

No hidden global Poiesis state.

No default `AGENTS.md` mutation.

## 3. Re-verify moving dependencies before coding adapters

Before implementing OpenCode integration, verify the target installed/current OpenCode source/docs and schema.

The bundle was prepared against the current OpenCode V2 design on 2026-09-07:
- Markdown custom agents under `.opencode/agents/`;
- Markdown body is agent `system`;
- `mode: primary|subagent`;
- ordered V2 `permissions` rules;
- action names such as `shell`, `edit`, `subagent`, and `skill`;
- `default_agent` in project config.

Do not use legacy V1 `permission`, `bash`, or `task` syntax in a V2 configuration.

Important current caveat: do not treat per-target subagent permission filtering as a hard security boundary unless the target version is verified to enforce it. Prompt role boundaries remain required.

Avoid nested permission `ask` paths. They can stall child-of-child sessions in current OpenCode behavior.

Verify current session children/delete APIs before implementing session hygiene.

## 4. Verify upstream skills

Verify current upstream repositories and installation/invocation semantics for the skills in `POIESIS_SKILLS.json`.

Especially determine a supported automatic way for Poiesis to use:
- `to-spec`;
- `to-tickets`;

without requiring the Author to type slash commands.

Do not copy maintained skill bodies into Poiesis prompts.

Do not install Caveman/Cavecrew in v1.1. The compact role return contracts are the default. Retain Caveman as a later measured Context Economy experiment.

## 5. Implementation order

Implement in this order.

### Phase A — package/kernel

Prefer TypeScript + Node.js + pnpm.

Provide the binary:

```bash
poiesis
```

Implement:
- config parser/validator;
- manifest/ownership model;
- hashing;
- atomic managed writes;
- structured errors.

### Phase B — maintenance commands

Implement:

```bash
poiesis init
poiesis doctor
poiesis update
poiesis uninstall
```

Ownership invariant:

> If Poiesis cannot prove it owns a file or mutation, it does not overwrite or delete it.

`doctor` is read-only.

`uninstall` preserves foreign files, preexisting skills, Git history, tracker history, PR/MR history, and unmerged user work.

### Phase C — deterministic operations

Implement the smallest mechanical API for:

```text
inspect
capability install
workspace prepare
checkpoint
verify
publish
preview
integrate
promote
workspace cleanup
```

Do not turn these into lifecycle-state commands.

No:
- `next-phase`;
- `approve-plan`;
- `retry-task`;
- workflow DB.

### Phase D — canonical installed files

Use `POIESIS_INSTALL_LAYOUT.md`.

`init` installs `.poiesis/` exactly from the canonical source templates, resolving config values and generating manifest ownership.

### Phase E — skills

Install only `defaults` from `POIESIS_SKILLS.json` through the supported upstream mechanism.

Preserve preexisting skills as user-owned.

### Phase F — OpenCode adapter

Generate the six Poiesis agent files from the `OPENCODE_AGENT_*.md` templates. `poiesis-reviewer` and `poiesis-final-reviewer` are adapter-only projections of the same canonical Reviewer role, required to route ticket review to the execution model and final reviews to the reasoning model.

Merge the intent represented by `OPENCODE_CONFIG_PATCH_V2.jsonc` into the actual current project config.

Do not copy the patch file verbatim.

Do not overwrite unrelated OpenCode config.

Record every managed config mutation in manifest.

Use native `explore` when it satisfies the contract and apply the configured execution model to it through the managed OpenCode config.

### Phase G — session hygiene

Internal child sessions are ephemeral.

Best-effort cleanup:
- Explore/Research after bounded result captured;
- Planner after design is materialized;
- Worker after accepted ticket checkpoint;
- Reviewer after verdict;
- leaf-first for nested children.

Cleanup failure never blocks correctness.

### Phase H — tracker + orchestration

Implement the Method exactly:

```text
Express
→ Understand
→ Authorize
→ Prepare
→ Plan
→ Specify
→ Tickets
→ Realize
→ Prove
→ Publish
→ Preview
→ Author validation
→ freshness
→ Staging
→ Integrate
→ Production authorization
→ Release
→ Complete
```

Every authorized change gets a Spec.

Every Worker unit gets a ticket.

Worker always receives parent Spec + ticket + repo.

### Phase I — Git/history semantics

Do not commit failed attempts.

For a ticket:

```text
Worker work
→ checks
→ fresh Review
→ at most one targeted correction
→ fresh Review
→ checkpoint only after PASS
```

Ticket checkpoints are internal recovery boundaries on the Poiesis change branch.

Keep the feature branch local until whole-change Proof passes; then push/create PR/Preview.

Canonical integration:

> one top-level Spec → one squash integration commit

Do not preserve internal ticket checkpoint commits as permanent integration history.

### Phase J — Proof / Preview / Staging / integration

Whole-change Proof:

```text
deterministic Verify
→ fresh reasoning Spec Review
→ fresh reasoning Standards Review
```

Any mutation invalidates prior Proof.

Preview must represent the exact proven candidate.

Clear unqualified Author acceptance authorizes integration; do not require “merge it”.

Immediately before Staging/integration, fetch latest integration base.

If stale:
- refresh;
- resolve;
- re-Proof;
- new Preview;
- new Author validation.

Stage the accepted fresh candidate before canonical integration.

Staging verification must pass.

Then squash-integrate and verify:
- exact integrated revision;
- integrated tree/content corresponds to accepted candidate;
- required post-integration checks pass.

### Phase K — Production

Always ask the Author whether to release to Production.

Never release automatically.

Release/promotion should preserve the same accepted candidate/artifact identity that passed Staging when the delivery platform supports immutable promotion.

If Production fails, do not claim completion.

## 6. Anti-loop rule

Do not add a retry state machine.

Use the existing Method invariant:

> Never retry the same action without new evidence, a material state change, or a higher escalation level.

Worker gets at most one targeted correction after a Review finding.

If fresh Review still fails, Poiesis reassesses before another attempt.

## 7. Context Economy requirements

Strong reasoning model:
- Poiesis;
- Planner;
- final Spec Review;
- final Standards Review.

Execution model:
- Worker;
- Research;
- Explore;
- ticket Reviewer.

Keep child handoffs compact using the role contracts.

Do not add full Caveman prompt overhead in v1.1.

Do not forward:
- child transcripts;
- raw repository scans;
- huge diffs;
- full test logs.

## 8. Required tests before serious dogfood

Use disposable real Git repos and fake/local provider adapters where needed.

Test:
- dirty foreign checkout remains untouched;
- branch/worktree collision;
- checkpoint only after accepted ticket;
- failed attempts uncommitted;
- exact-SHA Proof freshness;
- branch stays local until Proof;
- stale integration base;
- Preview identity;
- Staging before integration;
- squash canonical integration;
- integrated content equality;
- safe cleanup;
- config patch ownership/reversal;
- preexisting skill preservation;
- unknown file preservation;
- session cleanup best-effort;
- tracker Spec/ticket relationships;
- Replan history;
- explicit Production gate.

## 9. Self-host

As soon as the kernel can safely install itself and `poiesis doctor` passes on the Poiesis repo, use Poiesis for subsequent bounded Poiesis features.

Do not claim full self-hosting after a trivial edit.

## 10. Do not perform irreversible real Production actions during bootstrap

Do not:
- publish npm;
- deploy a real production target;
- merge a real protected external project;
- delete real user work;

without explicit user authorization.

Use fixtures/test adapters for end-to-end verification.

## 11. Final report

Return:
1. what was implemented;
2. repository structure;
3. supported OpenCode version/schema;
4. exact installed skills and invocation solution;
5. tracker adapters supported;
6. delivery adapters supported;
7. runtime operations;
8. ownership/uninstall behavior;
9. session hygiene;
10. tests run;
11. self-hosted flows completed;
12. blockers requiring real external credentials/Production authority;
13. remaining TODOs;
14. any deviation from these source files, with evidence.

Prefer a small working kernel over speculative abstractions.

Build Poiesis so the normal experience remains:

> **Author:** I have an idea.  
> **Poiesis:** Tell me.

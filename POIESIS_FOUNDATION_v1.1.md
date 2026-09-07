# Poiesis — Foundation v1

> **A philosophy and method for turning human intent into working, proven software.**

**Canonical design document**  
**Status:** Foundation v1.1 — implementation handoff baseline  
**Date:** 2026-09-07  
**Product name:** Poiesis  
**Recommended pronunciation:** **poy-EE-sis** (`/pɔɪˈiːsɪs/`)  
**CLI name:** `poiesis`  
**Implementation scope:** harness-neutral core, OpenCode first adapter  
**Primary design goal:** one predictable software-development method from natural-language intent to verified production release, while minimizing unnecessary context, infrastructure, and Author-facing procedure.

---

## 0. How to read this document

This file is the **single canonical source of truth for the Poiesis v1.1 design**.

For exact operational wording, the installed `PHILOSOPHY.md`, `METHOD.md`, and role files in this bundle are normative projections of this Foundation and should remain behaviorally consistent with it.

If an older Poiesis research note, foundation draft, design-review snapshot, `opencode-ship` document, or earlier conversation disagrees with this document, **this document wins**.

Older material remains useful as research history, but it is not normative.

This document intentionally contains:

- product identity and naming;
- philosophy;
- terminology;
- UX;
- exact standard lifecycle;
- role topology;
- delegation rules;
- model routing;
- Context Economy rules;
- capability acquisition;
- curated skills;
- tracker model;
- Git and branching model;
- preview, staging, and production semantics;
- proof/freshness invariants;
- deterministic runtime responsibilities;
- repository footprint;
- config and ownership model;
- installation/update/doctor/uninstall behavior;
- OpenCode adapter behavior;
- session hygiene;
- recovery;
- bootstrap/self-hosting;
- dogfood experiments;
- explicitly rejected/superseded designs;
- implementation constraints;
- definition of done.

The implementation should preserve the **reason** behind every mechanism and should not add machinery simply because older systems had it.

---

# Part I — Product identity

## 1. Name

The product and method are named **Poiesis**.

The name comes from the Greek idea of *making*, *bringing forth*, or *bringing something into existence*.

Poiesis is intentionally **not** named after:

- an editor;
- a model;
- an AI provider;
- a coding harness;
- a Git forge;
- a workflow framework.

OpenCode, Claude Code, Codex, editors, model providers, GitHub, GitLab, and future systems are execution environments and services.

> **Poiesis is the method.**

### 1.1 Product tagline

Canonical short form:

> **A philosophy for turning human intent into working, proven software.**

Expanded product promise:

> **I have an idea → I describe it → it becomes real → I prove that it is right → I decide when it goes to production.**

### 1.2 CLI and package naming

The CLI command is:

```bash
poiesis
```

The preferred npm package name is `poiesis` **if registry availability and package ownership allow it**.

If an unscoped package cannot be used, the package may be scoped, but the installed binary should remain:

```bash
poiesis
```

Package availability is an implementation-time registry check, not a reason to change the product name.

---

## 2. The Author

The human using Poiesis is called the **Author**.

This is deliberate.

The Author owns:

- intent;
- taste;
- desired behavior;
- priorities;
- product judgment;
- consequential human decisions;
- acceptance of the realized result;
- authorization to release to production.

The Author should **not** need to manage:

- agents;
- subagents;
- planning commands;
- task IDs;
- Git;
- branches;
- worktrees;
- commits;
- SHAs;
- GitHub/GitLab;
- issues;
- PRs/MRs;
- skills;
- model routing;
- verification commands;
- deployment mechanics.

The desired interaction is still:

> **Author:** I have an idea.  
> **Poiesis:** Tell me.

---

# Part II — Thesis and philosophy

## 3. Thesis

Software creation should begin with human intention, not engineering procedure.

The Author should be able to describe an idea in normal language. They should not need to know how to convert that idea into:

- a specification;
- an architecture;
- an issue;
- a ticket graph;
- a worktree;
- a branch;
- a test strategy;
- a pull request;
- a staging deployment;
- a production release.

That is Poiesis' responsibility.

Poiesis should turn natural conversation into a **stable, traceable, independently proven realization** while keeping infrastructure complexity out of the Author's mental model.

---

## 4. Core philosophy

### 4.1 One visible agent

Normal UX is:

```text
Author → Poiesis
```

Internal roles are invisible implementation machinery.

The Author does not manually switch to Planner, Worker, Reviewer, Research, or Explore.

---

### 4.2 Standard process over discretionary process

Poiesis is intentionally opinionated.

The model should make engineering decisions **inside a known process**, not decide which process to use every time.

For every authorized implementation change, the same major lifecycle exists.

Artifact depth may scale.

The lifecycle does not disappear.

> **Consistency is a feature. Durable history is a feature.**

---

### 4.3 No separate implementation fast path after Authorize

Earlier Poiesis drafts considered a separate “tiny fast path”.

That is superseded.

Once the Author has authorized a code/product change, Poiesis uses the same standard lifecycle even for a tiny change.

A typo may produce:

- a tiny Spec;
- one tiny ticket;
- one short implementation;
- one review;
- one checkpoint;
- the same proof and preview gates.

The structure remains identical.

Before Authorize, ordinary conversation, research, or brainstorming may naturally end without implementation.

---

### 4.4 Context Economy

Core rule:

> **Every expensive token should sit close to an important decision.**

Poiesis optimizes:

```text
minimum wasted context
+
minimum sufficient intelligence
+
required reliability
```

It does **not** optimize raw token count at the expense of correctness.

Strong models should spend context on:

- product interpretation;
- architecture;
- synthesis;
- consequential decisions;
- planning;
- final semantic review.

Execution models should spend context on:

- repository exploration;
- external fact gathering;
- implementation;
- local debugging;
- routine ticket review;
- mechanical rediscovery.

---

### 4.5 Learn before specialized work

Every authorized implementation passes a **Capability Check** before strong planning.

The question always exists:

> **Do we currently have enough reliable, current capability to plan this specialized work well?**

The answer may immediately be “yes”.

Capability acquisition is conditional.

Capability Check is not.

Poiesis must not rely on the model merely remembering that skills or current documentation might exist.

---

### 4.6 Deterministic mechanics; model-owned judgment

Poiesis should use deterministic helpers for repeated, mechanically verifiable operations.

Examples:

- Git inspection;
- safe worktree creation;
- exact-SHA verification;
- checkpoint commits;
- push/PR mechanics;
- preview creation;
- integration;
- promotion;
- cleanup.

But deterministic helpers must **not** become a second workflow engine.

Bad runtime concepts include:

- `approve-plan`;
- `next-phase`;
- `retry-task`;
- `mark-review-passed`;
- `start-run`;
- workflow status databases.

Rule:

> **Optimize repeated mechanics, not reasoning.**

---

### 4.7 Durable truth lives outside model memory

Agent sessions are temporary.

Durable project history lives in ordinary infrastructure:

```text
issue tracker
+
Git
+
PR/MR
+
deployment/release history
+
project-owned domain docs
```

A restart, compaction, deleted child session, or harness change must not destroy project truth.

---

### 4.8 Git and tracker are infrastructure, not Author workflow

Poiesis uses Git, a remote, an issue tracker, PR/MR infrastructure, Preview, Staging, and Production because they provide reliability and provenance.

The Author normally does not see or operate them.

The Author may explicitly ask for technical provenance, but it is not required to move work forward.

---

### 4.9 Preview always exists

Every project has a **Preview** step.

Preview means:

> a project-appropriate runnable/testable representation of the exact proven candidate that the Author can validate before integration.

The mechanism varies by delivery adapter.

The workflow step does not.

---

### 4.10 Production is always an explicit human authority gate

Poiesis v1 never has:

```text
production: automatic
```

After successful Staging, canonical integration, and integrated verification, Poiesis always asks the Author—in natural product language—whether the accepted release candidate should go to production.

Production is not a Git command.

It is a product/release authority decision.

---

### 4.11 Complexity must earn its place

Before adding a tool, file, database, plugin, state machine, prompt layer, or abstraction, ask:

- Does it remove mechanical work the Author should not manage?
- Does it materially improve reliability?
- Can ordinary Git, tracker state, Markdown, shell tools, or native harness primitives already do it?
- Can the state remain understandable to a developer without Poiesis?
- Can it be safely removed?
- Is the context/maintenance cost justified?

> **Preserve the reason; re-earn the machinery.**

---

# Part III — Product architecture

## 5. Poiesis is harness-neutral

Canonical architecture:

```text
                     POIESIS CORE
              ┌──────────────────────┐
              │ philosophy / method  │
              │ role semantics       │
              │ model classes        │
              │ config               │
              │ deterministic runtime│
              │ tracker/delivery     │
              │ semantics            │
              └──────────┬───────────┘
                         │
                  harness adapter
                         │
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
       OpenCode       Claude Code      Codex
        first            later          later
```

Poiesis is **not an OpenCode product**.

OpenCode is the first adapter and first implementation target.

The core method must not depend on private OpenCode runtime APIs.

---

## 6. OpenCode first

V1 implementation should ship the OpenCode adapter first.

The OpenCode adapter maps harness-neutral concepts to current OpenCode capabilities such as:

- custom primary agents;
- subagents;
- per-agent model routing;
- permissions;
- nested child sessions;
- native Explore if suitable;
- Agent Skills;
- supported session APIs;
- supported configuration.

The implementation must re-verify current OpenCode behavior before coding against it.

Do not rely on old blog posts or stale config syntax.

---

## 7. No OpenCode plugin

Poiesis v1 is **plugin-free**.

Do not implement an OpenCode plugin merely for:

- context isolation;
- model routing;
- child sessions;
- plan handoff;
- session persistence;
- token accounting;
- Git worktrees;
- workflow state.

Use:

- native harness agents;
- native child sessions;
- current supported permissions;
- skills;
- ordinary CLI/runtime helpers.

A future plugin must re-earn its existence against a concrete guarantee that cannot be achieved reliably through supported native primitives.

---

# Part IV — Terminology

## 8. Canonical terms

### Author
The human.

### Poiesis
The visible primary AI/orchestrator and the name of the method/product.

### Intent
What the Author wants to become true.

### Authorize
The natural-language boundary where the Author has asked Poiesis to realize the Intent.

This term intentionally replaces the older word **Commit**, which was confusing beside Git commits.

### Realization
The implemented software change.

### Spec
The durable tracker record of the Intent, acceptance, consequential decisions, architecture commitments, testing decisions, constraints, and non-goals.

### Ticket
One executable vertical slice of implementation work.

### Checkpoint
A normal Git commit representing an accepted repository state.

### Proof
Fresh evidence that a specific exact candidate satisfies the required machine and semantic checks.

### Preview
The Author-testable representation of the exact proven pre-integration candidate.

### Integration
The internal merge of an accepted feature/change into the canonical integration branch.

### Staging
The mandatory post-integration production-like validation target for the exact release candidate.

### Production
The project’s canonical final release target.

This may be:

- a production deployment;
- a package registry release;
- an app-store release;
- a production artifact/channel;
- another project-specific release target.

### Release / Promote
Move the same immutable staged candidate to Production after Author authorization.

---

# Part V — The canonical workflow

## 9. High-level lifecycle

Every authorized implementation follows:

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
→ Author validates
→ Integration freshness gate
→ Stage
→ Verify staging
→ Integrate
→ Verify integrated revision
→ Ask for production authorization
→ Release
→ Verify production
→ Complete
```

No major lifecycle step is model-optional.

---

## 10. Express

The Author speaks naturally.

Examples:

```text
"I have an idea for onboarding..."
"What do you think about..."
"Add organization invitations."
"Fix the checkout typo."
```

Poiesis does not require:

- issue IDs;
- plan IDs;
- agent names;
- Git commands;
- workflow commands.

Poiesis first determines whether the Author is exploring or asking for realization.

---

## 11. Understand

Goal:

> reach enough shared understanding to state the intended result and its consequential constraints.

### 11.1 Find facts instead of asking for them

Poiesis should not ask the Author for facts discoverable from:

- the repository;
- project docs;
- tracker history;
- current external documentation.

Use Explore for repository facts.

Use Research for external facts.

Ask the Author only for decisions the Author actually owns.

---

### 11.2 Consequential ambiguity

Poiesis uses Matt Pocock’s `grilling` methodology when consequential ambiguity exists.

Consequential ambiguity is ambiguity that materially changes:

- product behavior;
- UX;
- architecture;
- security/privacy;
- data ownership;
- compatibility;
- hard-to-reverse scope.

The **Understand gate always exists**.

The number of questions does not.

---

### 11.3 Domain knowledge

When the conversation establishes:

- new canonical domain vocabulary;
- a meaningful domain model;
- a surprising hard-to-reverse architectural/domain decision;

Poiesis should use `domain-modeling` and update project-native durable knowledge where appropriate, such as:

- `CONTEXT.md`;
- `CONTEXT-MAP.md`;
- `docs/adr/`;
- context-local ADRs.

These are project-owned artifacts, not Poiesis workflow state.

Do not create them merely because they are absent.

Create/update them when durable project meaning has actually changed.

---

### 11.4 Understand exit condition

Understand is complete when:

- desired outcome is clear enough to specify;
- acceptance can be stated;
- consequential constraints are known;
- no unresolved Author-owned decision blocks realization.

---

## 12. Authorize

Authorization is the boundary between discussion and implementation.

Examples:

```text
"Implement it."
"Let's build it."
"Fix it."
"Add organizations."
```

If the original message already clearly asks for implementation, Authorize is implicit once Understand resolves consequential ambiguity.

After Authorize, Poiesis autonomously continues through the standard method.

It does not ask the Author to:

- approve a technical plan;
- execute a plan;
- switch agents;
- create tickets;
- open a PR;
- run Git commands.

Poiesis returns to the Author only when:

- a genuinely new consequential Author-owned decision appears;
- the Preview is ready for product validation;
- production authorization is required.

---

## 13. Prepare

Prepare is mandatory.

### 13.1 Infrastructure health

Normal Poiesis operation requires:

```text
Git repository
+
configured Git remote
+
supported issue tracker
+
Preview target
+
Staging target
+
Production target
+
supported harness
+
reasoning model
+
execution model
```

If required infrastructure is missing, implementation does not begin.

`doctor` should report the missing prerequisite.

---

### 13.2 Fetch and inspect

Poiesis deterministically:

- resolves the Git root;
- fetches the configured remote;
- resolves the latest canonical integration HEAD;
- inspects branch/worktree state;
- inspects manifests;
- identifies languages/frameworks/dependencies;
- identifies package manager;
- identifies declared project verification scripts;
- identifies installed skills/capabilities;
- reads relevant project instructions.

Reasoning models should not burn large context on mechanically extractable facts.

---

### 13.3 Prepare isolated workspace

Poiesis creates one owned short-lived change branch and worktree from the latest fetched integration commit.

Important invariant:

> **Never consume foreign uncommitted work as the base.**

A dirty user/main checkout does not automatically block Poiesis from creating a new isolated worktree from an explicit committed base.

---

### 13.4 Capability Check

Capability Check happens before the strong Planner.

If current capability is insufficient:

1. Poiesis dispatches Research.
2. Research checks high-trust current sources.
3. Prefer a maintained relevant Agent Skill when a strong candidate exists.
4. Otherwise use current official documentation/research.
5. Poiesis selects the capability.
6. The deterministic capability installer installs the already-selected skill if needed.
7. Planning starts only after current capability is available.

Generic pretrained memory must not silently replace current specialized knowledge where recency materially matters.

---

## 14. Plan

Every authorized change gets a fresh strong Planner.

There is **no separate durable local plan file in the primary v1 design**.

The Plan phase is a reasoning phase.

The Planner resolves:

- architectural placement;
- responsibility boundaries;
- important interfaces/seams;
- data/control flow;
- invariants;
- schema/API commitments;
- security/compatibility implications;
- testing seams;
- verification strategy;
- ticket decomposition constraints.

The Planner should be:

> **architecturally decisive, implementation-permissive.**

It should not pre-write ordinary implementation code in English.

The Worker may rediscover local implementation details.

---

## 15. Specify

The durable output of planning becomes the canonical **top-level Spec issue** in the configured tracker.

Poiesis adopts Matt Pocock’s `to-spec` methodology.

The Spec is canonical for:

- problem/outcome;
- why the change exists;
- desired behavior;
- acceptance/user-visible behavior;
- consequential constraints;
- implementation/architecture decisions;
- testing decisions/seams;
- out-of-scope boundaries;
- material later replans.

The Spec should be complete enough to preserve all consequential commitments but concise enough to remain a usable tracker artifact.

Do not create a second local copy merely to mirror it.

---

## 16. Tickets

Poiesis adopts Matt Pocock’s `to-tickets` tracer-bullet decomposition methodology.

Every executable Worker unit corresponds to a real tracker ticket.

Each ticket should contain:

- parent Spec reference;
- objective;
- relevant acceptance;
- applicable Spec commitments;
- relevant architecture/invariants;
- dependencies/blockers;
- verification expectations.

Prefer vertical slices.

Avoid artificial horizontal decomposition such as:

```text
database ticket
backend ticket
frontend ticket
tests ticket
```

unless the work is inherently a safe migration sequence such as expand/migrate/contract.

### 16.1 Spec commitment preservation

A known failure mode of spec-to-ticket decomposition is losing shared commitments.

Poiesis therefore enforces:

> **Worker never implements from a ticket alone.**

Worker input always includes:

```text
Parent Spec
+
Current Ticket
+
Current Repository
```

If ticket and Spec conflict, or an important commitment is missing:

```text
STOP
→ escalate to Poiesis
```

Never guess.

---

## 17. Realize

Tickets execute in dependency order.

V1 standard:

- one top-level change branch;
- all tickets for the Spec use that branch;
- one fresh Worker per meaningful ticket;
- ticket execution is serialized on the branch;
- no per-ticket Git branches.

---

### 17.1 Worker input

Worker receives a bounded packet:

- parent Spec;
- current ticket;
- current accepted repository revision;
- relevant architecture/invariants;
- verification expectations;
- escalation conditions.

Worker may rediscover ordinary local implementation details.

---

### 17.2 Worker responsibilities

Worker may:

- read/edit application code;
- read/edit tests;
- run project shell commands;
- use package manager commands;
- run focused tests/typecheck/lint/build;
- use implementation/TDD/debugging skills;
- inspect local diff/status;
- use Explore as a support child.

Worker does **not** own:

- worktree lifecycle;
- Git commit/checkpoint history;
- push/PR;
- integration;
- tracker workflow progression;
- capability acquisition;
- Planner responsibilities;
- production release.

---

### 17.3 TDD

For behavior-changing implementation, Worker uses Superpowers `test-driven-development`.

Poiesis does not restate the entire TDD method in role prompts.

The maintained skill owns the detailed procedure.

---

### 17.4 Debugging

V1 canonical debugging skill:

```text
Matt Pocock — diagnosing-bugs
```

A real failure should be diagnosed rather than patched through repeated guesses.

Dogfood TODO:

```text
Matt diagnosing-bugs
vs.
Superpowers systematic-debugging
```

Use controlled real failures and switch only if evidence justifies it.

---

### 17.5 Worker return

Worker returns bounded information:

- status;
- changed files;
- local checks and results;
- concerns;
- contradiction/escalation.

Do not replay full transcripts into Poiesis.

---

## 18. Ticket review

Every ticket receives an independent fresh Reviewer before checkpoint.

Ticket Reviewer uses the execution model by default.

Reviewer:

- reads the parent Spec;
- reads the ticket;
- reads the candidate diff/relevant code;
- uses project standards;
- may use Explore for bounded context;
- does not edit code;
- does not fix findings.

Reviewer returns:

- pass;
- actionable implementation findings;
- Spec/Plan contradiction;
- uncertainty requiring evidence.

---

### 18.1 Correction policy

For one localized implementation error while the design remains valid:

1. resume the same Worker for one targeted correction;
2. rerun relevant local checks;
3. use a fresh Reviewer again.

If the same failure persists or the cause is unclear:

1. dispatch a fresh bounded diagnostic Worker;
2. use `diagnosing-bugs`;
3. preserve the design unless evidence contradicts it.

If evidence invalidates the design:

```text
Replan
```

not infinite cheap retries.

---

## 19. Replan

Replan is not a retry.

Replan occurs when evidence invalidates the current technical design.

A fresh reasoning Planner receives:

- original Spec;
- current Spec decisions;
- completed checkpoint SHAs;
- contradictory evidence;
- affected open tickets.

If a new consequential Author-owned decision exists, Poiesis asks the Author.

Otherwise the Planner revises the technical direction.

Durable replan history lives on the parent Spec, typically as a tracker comment/update describing:

- evidence;
- prior assumption;
- new decision;
- impact;
- preserved completed work;
- superseded tickets.

Do not erase history.

Unstarted obsolete tickets are superseded/cancelled and replacement tickets are created.

---

## 20. Checkpoint

After a ticket passes independent review, Poiesis creates a normal Git commit through the deterministic checkpoint operation.

Example:

```text
Ticket #101 → commit A
Ticket #102 → commit B
Ticket #103 → commit C
```

A checkpoint means:

> **This repository state is accepted for this execution unit.**

It does not mean the code can never be touched again.

Worker does not create the checkpoint itself.

---

# Part VI — Proof, Preview, staging, integration, and release

## 21. Whole-change Proof

When all current implementation tickets are accepted, Poiesis identifies the exact clean change-branch candidate.

Proof runs against that exact identity:

```text
exact candidate
→ deterministic Verify
→ fresh Spec Review
→ fresh Standards Review
```

No failed implementation attempt is committed.

Accepted ticket checkpoints may exist on the Poiesis change branch for recovery, but they are not canonical integration history.

---

## 22. Deterministic Verify

Verification runs authoritative declared project checks against the exact candidate.

Examples:
- tests;
- typecheck;
- lint;
- build;
- project-specific verification.

The runtime confirms exact candidate identity and clean state before and after checks and returns bounded evidence.

---

## 23. Final Spec Review

Always a fresh reasoning-model Reviewer.

Question:

> **Does this exact candidate realize the canonical Spec?**

This is independent of ticket review.

---

## 24. Final Standards Review

Always a separate fresh reasoning-model Reviewer.

Question:

> **Is this exact candidate technically healthy and appropriate for this repository?**

---

## 25. Proof freshness

Canonical invariant:

```text
verified candidate
=
Spec-reviewed candidate
=
Standards-reviewed candidate
=
Preview candidate
```

Any code mutation invalidates Proof for the previous candidate.

A correction returns through the normal ticket/Review/checkpoint path and then whole-change Proof runs again.

---

## 26. Publish

Only after whole-change Proof passes:
- push the Poiesis change branch;
- create/update one PR/MR;
- target the canonical integration branch;
- preserve the exact proven candidate identity.

The Author does not operate the PR/MR.

---

## 27. Preview

Preview always represents the exact proven candidate.

The concrete mechanism is project-appropriate: preview environment, runnable build, installable package candidate, test build, or another safe Author-testable representation.

The Author validates product realization only after Poiesis technical Proof has already passed.

---

## 28. Author validation

Clear, unqualified natural acceptance of the presented realization authorizes integration.

The Author does not need to say `merge`.

If the Author requests changes, Poiesis creates/amends the required Spec/ticket work, realizes it, reruns whole-change Proof, updates Preview, and seeks validation again.

Do not integrate while requested changes remain unresolved.

---

## 29. Integration freshness gate

Immediately before Staging/integration, fetch the canonical integration branch.

If the validated base changed:
1. refresh the Poiesis change branch against the latest integration state;
2. resolve resulting work through normal implementation/review;
3. rerun whole-change Proof;
4. update Preview;
5. require Author validation again.

Never silently integrate a candidate whose validated base is stale.

---

## 30. Staging

After Author validation and final freshness confirmation, deploy/promote the exact accepted candidate to Staging.

Staging always exists semantically.

Run required Staging verification.

A candidate that fails Staging does not enter canonical integration history.

---

## 31. Integration

After:
- whole-change Proof;
- Author validation;
- final freshness confirmation;
- Staging verification;

integrate the whole top-level Spec into the canonical integration branch.

V1.1 standard:

> **one top-level Spec → one canonical squash integration commit**

Internal ticket checkpoints exist for recovery on the change branch and must not become permanent canonical integration history.

After integration:
- capture the exact integration revision;
- verify integrated tree/content equivalence with the accepted candidate;
- run deterministic post-integration verification.

Squash changes commit SHA, so pre-integration Proof is not used as a claim that the integration SHA itself was verified.

---

## 32. Production authority

Production is a separate human authority boundary.

After successful integration and verification, Poiesis always asks the Author in natural product language whether they want the accepted release candidate released to Production.

There is no automatic Production path.

If the Author says not yet, preserve the accepted release state and wait.

---

## 33. Production identity

Production must receive the same accepted candidate/artifact identity that passed Staging, to the extent the delivery system supports immutable promotion.

Do not silently substitute a semantically different rebuild.

---

## 34. Release

When the Author authorizes Production:
- promote/release the accepted candidate;
- preserve release identity;
- run production/release health verification.

If release or post-release verification fails, do not claim completion. Preserve evidence and route remediation through the normal Method.

---

## 35. Post-release

After successful Production release and health verification:
- close implementation/tracker work;
- close the top-level Spec;
- safely clean the Poiesis-owned workspace/branch;
- clean internal child sessions best-effort;
- preserve Git/tracker/PR/release history.

---

## 36. Canonical history principle

Internal recovery state is not canonical project history.

Failed attempts are not committed.

Accepted ticket checkpoints are recovery boundaries on the Poiesis change branch.

Canonical integration history represents the complete accepted top-level Spec as one coherent commit.

# Part VII — Roles and delegation

## 37. Role set

Canonical semantic roles:

```text
Poiesis       primary/orchestrator
Planner       strong architecture/design child
Worker        implementation child
Research      external-evidence child
Reviewer      independent review child
Explore       cheap repository explorer

Verifier      deterministic runtime, NOT an LLM role
```

Do not add permanent agents for:

- Git;
- Proof;
- TDD;
- Skills;
- PRs;
- Releases;
- tickets;
- domains.

Use skills or deterministic operations instead.

---

## 38. Poiesis role

Model class:

```text
reasoning
```

Only normal user-visible agent.

Poiesis owns:

- Author conversation;
- Understand;
- Authorize recognition;
- consequential-question routing;
- Capability Check;
- delegation;
- Spec/ticket orchestration;
- workflow progression;
- retry vs replan;
- exact-candidate proof coordination;
- Preview presentation;
- realization acceptance interpretation;
- integration;
- production question;
- final synthesis.

Poiesis should not normally edit application code directly after Authorize.

Implementation belongs to Worker.

---

## 39. Planner

Model class:

```text
reasoning
```

Fresh child for each initial design or material replan.

Planner is:

> **architecturally decisive, implementation-permissive.**

Planner decides:

- architecture;
- responsibilities;
- seams/interfaces;
- data flow;
- invariants;
- compatibility/migration strategy;
- testing seams;
- verification strategy;
- ticket-decomposition constraints.

Planner does not:

- implement application code;
- own Git history;
- publish;
- integrate;
- release.

Planner may delegate bounded evidence gathering to:

```text
Explore
Research
```

---

## 40. Explore

Model class:

```text
execution
```

Explore gathers repository facts.

Examples:

- where responsibility currently lives;
- relevant paths;
- symbols;
- current interfaces;
- existing tests;
- project conventions.

Explore is read-only.

It returns bounded:

- answer;
- paths;
- symbols;
- observed invariants;
- uncertainty.

No edits.

No external research.

No recursive delegation.

Use the harness-native explorer when it satisfies the contract.

---

## 41. Research

Model class:

```text
execution
```

Research gathers current external evidence.

Examples:

- framework docs;
- API behavior;
- provider docs;
- maintained skills;
- security guidance;
- current compatibility facts.

Research should prefer high-trust primary sources.

Research returns bounded:

- answer;
- evidence;
- source links;
- recommended capability candidates;
- unresolved uncertainty.

Research does not install capabilities or mutate the repo.

Poiesis makes the selection.

The deterministic runtime installs.

---

## 42. Worker

Model class:

```text
execution
```

Fresh per meaningful ticket.

Worker owns bounded realization.

Worker can:

- edit code/tests;
- use shell/project tools;
- use TDD/debug skills;
- inspect local state;
- use Explore.

Worker cannot:

- checkpoint;
- push;
- integrate;
- mutate tracker workflow;
- acquire capabilities;
- redesign consequential architecture silently;
- create lifecycle roles.

If reality contradicts the Spec/design:

```text
escalate
```

---

## 43. Reviewer

Ticket Reviewer:

```text
execution
```

Final Spec Reviewer:

```text
reasoning
```

Final Standards Reviewer:

```text
reasoning
```

Reviewer is always fresh and independent of the Worker transcript.

Reviewer is read-only.

Reviewer finds issues.

Reviewer does not fix them.

Reviewer may use Explore for bounded repository context.

---

## 44. Nested delegation

Nested delegation is a first-class capability, but not unrestricted recursion.

Principle:

> **Specialists may delegate evidence gathering; only Poiesis delegates responsibility.**

Allowed topology:

```text
Poiesis
├─ Planner
│  ├─ Explore
│  └─ Research
├─ Worker
│  └─ Explore
├─ Reviewer
│  └─ Explore
├─ Research
└─ Explore
```

Not normal:

```text
Worker → Worker
Worker → Planner
Planner → Planner
Reviewer → Worker
Explore → Explore
```

Initial OpenCode target:

```text
maximum depth 2
```

Avoid nested permission flows that require an interactive `ask` from grandchildren.

Do not treat current per-target subagent restrictions as a hard security boundary unless the target OpenCode version demonstrably enforces them.

---

# Part VIII — Model routing

## 45. User-facing model classes

Normal config exposes only:

```text
reasoning
execution
```

Example:

```jsonc
{
  "models": {
    "reasoning": "openai/gpt-5.6-sol",
    "execution": "minimax/<m3-model-id>"
  }
}
```

For the current intended personal setup:

```text
reasoning → GPT-5.6 Sol
execution → MiniMax M3
```

Exact provider IDs must be verified against the installed harness.

---

## 46. Fixed routing

| Responsibility | Model class |
|---|---|
| Poiesis | reasoning |
| Planner | reasoning |
| Final Spec Review | reasoning |
| Final Standards Review | reasoning |
| Explore | execution |
| Research | execution |
| Worker | execution |
| Ticket Reviewer | execution |
| Debugging Worker | execution |

Repeated execution failure escalates to **reasoning diagnosis**, not arbitrary stronger implementation.

The reasoning diagnosis determines whether the problem is:

- implementation;
- design;
- missing capability.

Then Poiesis routes appropriately.

---

## 47. Advanced role overrides

Advanced per-role model overrides may exist:

```jsonc
{
  "models": {
    "reasoning": "...",
    "execution": "...",
    "roles": {
      "research": "...",
      "worker": "..."
    }
  }
}
```

Resolution:

```text
role override
→ otherwise model class
```

The installer should not generate role overrides by default.

---

## 48. Model availability failure

If the configured reasoning or execution model is unavailable:

Poiesis does **not** silently choose another model.

Report the configuration problem.

Model selection affects both quality and economics and is user configuration.

Future explicit fallback configuration may be considered only if dogfood demonstrates a need.

---

# Part IX — Skills and self-learning

## 49. Skills philosophy

Poiesis reuses maintained upstream methods rather than rewriting them into giant role prompts.

Installed is not the same as always invoked.

The standard workflow stage always exists.

The relevant skill method is loaded when its procedure applies inside that stage.

---

## 50. Default curated skills

### Matt Pocock

Install:

```text
grilling
grill-with-docs
domain-modeling
research
codebase-design
to-spec
to-tickets
code-review
diagnosing-bugs
```

### Superpowers

Install:

```text
test-driven-development
verification-before-completion
```

---

## 51. Skill ownership

| Skill | Poiesis use |
|---|---|
| `grilling` | consequential ambiguity during Understand |
| `grill-with-docs` | power-user wrapper over grilling + domain modeling; installed for convenience |
| `domain-modeling` | durable domain vocabulary/ADRs |
| `research` | Research role methodology |
| `codebase-design` | Planner architecture vocabulary/discipline |
| `to-spec` | canonical top-level tracker Spec |
| `to-tickets` | tracer-bullet executable decomposition |
| `code-review` | ticket and final semantic review methodology |
| `diagnosing-bugs` | canonical v1 debugging discipline |
| `test-driven-development` | Worker behavior-changing implementation |
| `verification-before-completion` | fresh evidence before success claims |

---

## 52. Deliberately not default

Do not make these Poiesis workflow owners:

### Superpowers `writing-plans`

Not default.

Reason:

- it creates a separate detailed plan file;
- it specifies exact files/code/steps;
- it assumes an executor with zero context;
- it duplicates the tracker-first technical record;
- it conflicts with “architecturally decisive, implementation-permissive”.

It remains part of the preserved local-plan dogfood alternative.

---

### Superpowers `subagent-driven-development`

Not default.

Poiesis owns orchestration.

Do not introduce a second owner for:

- who delegates;
- when Workers run;
- review cadence;
- workflow progression.

---

### Superpowers `using-git-worktrees`

Not default.

Poiesis deterministic workspace operations own worktree mechanics.

---

### Superpowers `requesting-code-review`

Not default.

Poiesis METHOD owns when review happens.

Matt `code-review` owns review methodology.

---

### Matt `implement`

Current Matt skills include an `implement` orchestration flow.

Do not make it the Poiesis Worker owner without a fresh design decision.

Current upstream behavior includes responsibilities Poiesis intentionally separates, such as committing and invoking review as part of one orchestrated skill.

Poiesis keeps:

```text
Worker implementation
≠
Reviewer
≠
checkpoint
```

---

## 53. Current upstream invocation caveat

As of this Foundation date, current Matt skill metadata distinguishes model-invoked and user-invoked skills.

`to-spec`, `to-tickets`, and `grill-with-docs` may be marked user-invoked in upstream versions.

Poiesis normal UX cannot require the Author to type slash commands.

Therefore implementation must **verify the current supported autonomous invocation mechanism**.

Preferred order:

1. supported programmatic/harness invocation of the upstream skill;
2. supported upstream CLI/entrypoint invoked deterministically;
3. a thin Poiesis adapter/wrapper that references the installed upstream method without copying its full body;
4. only if no supported composition exists, re-evaluate the integration.

Do not silently vendor stale copies of upstream skills.

Do not duplicate maintained method text into Poiesis role prompts.

---

## 54. Skill installation and ownership

Use the current upstream Agent Skills installation mechanism.

Prefer project-local standard Agent Skills placement (commonly `.agents/skills/`) when supported by the current tooling.

`manifest.json` tracks:

- source;
- skill name;
- whether it existed before Poiesis.

If preexisting:

```text
preexisting: true
```

Poiesis may use it, but update/uninstall must not claim ownership over it.

---

# Part X — Durable state and issue tracking

## 55. Required tracker

A supported issue tracker is required like Git and the remote.

Normal Poiesis work requires:

```text
Git
+
remote
+
tracker
```

Examples of possible adapters:

- GitHub Issues;
- GitLab Issues;
- future supported trackers.

Core semantics must not be GitHub-specific.

---

## 56. Primary durable work model

Primary v1:

```text
Spec issue
→ implementation tickets
→ Git checkpoints
→ PR/MR
→ deployment/release history
```

No local `.poiesis/work/*.md` is required.

---

## 57. Source-of-truth ownership

### Spec issue

Canonical:

```text
WHAT
+
WHY
+
consequential technical decisions
+
testing decisions
+
material replans
```

### Tickets

Canonical:

```text
executable slices
+
dependencies
+
slice-specific commitments
+
acceptance
```

### Git

Canonical:

```text
actual repository state
+
accepted checkpoint commits
+
exact candidate identities
```

### PR/MR

Canonical:

```text
integration/delivery record
```

### Deployment/release system

Canonical:

```text
Preview
Staging
Production candidate/release identity
```

---

## 58. Replan history

Material replans are recorded on the parent Spec.

Do not create a second Replan database.

Do not erase old decisions.

Affected unstarted tickets are superseded and replaced.

Completed accepted work remains linked by Git checkpoints.

---

## 59. Work-artifact alternative preserved for dogfood

Earlier design retained a local technical artifact:

```text
.poiesis/work/<work>.md
```

with:

- Spec reference;
- base SHA/branch;
- capabilities;
- Architecture;
- Interfaces;
- Invariants;
- Verification;
- ticket index;
- accepted checkpoint SHAs;
- material Replans.

It could use Git-versioned plan revisions and Superpowers `writing-plans`.

This is **not primary v1**.

It is explicitly preserved for an A/B dogfood experiment.

Do not implement it as the default unless measured evidence shows it materially improves:

- reliability;
- recovery;
- strong-model token economy;
- Worker correctness;
- replan clarity;

enough to justify duplicated state and extra concepts.

---

# Part XI — Git, branches, and workspace safety

## 60. Canonical branch structure

Exactly one canonical long-lived integration branch.

Usually:

```text
main
```

but configured explicitly:

```jsonc
{
  "repository": {
    "integrationBranch": "main"
  }
}
```

Each top-level Spec gets one short-lived Poiesis change branch.

Example:

```text
main
├─ poiesis/organization-invitations
├─ poiesis/checkout-validation
└─ poiesis/billing-retry
```

No permanent Poiesis:

```text
dev
staging
production
```

branches.

Environments are not branches.

---

## 61. Base freshness

Every new change branch starts from the latest fetched remote integration HEAD.

Poiesis must not accidentally use:

- stale local integration state;
- dirty user working copy;
- foreign uncommitted work.

---

## 62. One branch per Spec

One top-level Spec/change:

```text
one Poiesis change branch
+
one owned worktree
+
one PR/MR
```

Tickets are execution units, not branch units.

---

## 63. Workspace prepare

Deterministic `workspace prepare`:

- resolves Git root;
- fetches/validates base;
- checks branch/path collisions;
- checks current worktrees;
- proves ownership;
- creates branch/worktree from explicit committed base;
- returns structured workspace identity.

Dirty foreign checkout does not automatically block a separate worktree.

---

## 64. Workspace cleanup

Deterministic cleanup is fail-closed.

Before deleting:

- prove Poiesis ownership;
- refuse main/integration checkout;
- refuse dirty/untracked workspace;
- refuse unique undelivered commits;
- refuse unknown foreign state.

No free-form `--force` escape from an agent.

Unknown ownership means:

```text
do not delete
```

---

# Part XII — Runtime kernel

## 65. Runtime principle

Poiesis core may provide a small local npm CLI/runtime.

It is not a workflow state machine.

Semantic operations should collapse repeated multi-tool mechanics while leaving decisions to Poiesis.

---

## 66. Deterministic operations

V1 target surface:

```text
1. inspect
2. capability install
3. workspace prepare
4. checkpoint
5. verify
6. publish
7. preview
8. integrate
9. promote
10. workspace cleanup
```

Maintenance commands are separate:

```text
poiesis init
poiesis update
poiesis doctor
poiesis uninstall
```

---

## 67. `inspect`

Read-only deterministic project facts.

Possible profiles:

```text
project
capabilities
workspace
candidate
```

May report:

- Git root;
- HEAD;
- branches;
- dirty state;
- remotes;
- integration branch;
- worktrees;
- manifests;
- package manager;
- frameworks/dependencies;
- scripts;
- installed skills;
- candidate SHA;
- changed files;
- bounded diff metadata.

Must not infer architecture.

---

## 68. `capability install`

Installs an already-selected capability.

Research decides candidates.

Poiesis selects.

Runtime:

- checks whether it is already installed;
- preserves preexisting ownership;
- installs exact chosen skill;
- validates installation;
- records ownership/provenance.

No searching/ranking inside the deterministic operation.

---

## 69. `workspace prepare`

Owns safe isolated branch/worktree creation.

No workflow decisions.

---

## 70. `checkpoint`

Creates a normal local Git commit for an accepted stable state.

For ticket checkpoints:

- resolve owned workspace;
- inspect intended changes;
- stage intended changes;
- commit;
- verify clean post-commit state;
- return SHA.

Worker does not commit itself.

---

## 71. `verify`

Runs authoritative declared checks on an exact clean candidate SHA.

Returns bounded structured evidence.

Large logs stay outside reasoning context.

---

## 72. `publish`

Publishes the proven change branch and creates/updates the PR/MR.

Responsibilities:

- validate exact candidate;
- validate clean workspace;
- push branch;
- resolve provider;
- create/update PR/MR;
- return remote references.

Poiesis writes human-readable title/body.

---

## 73. `preview`

Creates/updates the Author-testable Preview for an exact proven pre-integration candidate.

Returns:

- candidate identity;
- preview handle/URL/artifact;
- deployment/build identity;
- status.

Preview must not silently point at a different candidate.

---

## 74. `integrate`

Integrates the exact validated change into the configured integration branch through the supported forge/Git mechanism.

Must:

- enforce expected candidate/base;
- use normal merge-commit semantics;
- return exact integrated SHA;
- fail on unexpected freshness/ownership conditions.

---

## 75. `promote`

Promotes an immutable integrated release candidate to an explicit target:

```text
staging
production
```

The operation does not decide the target.

Poiesis does.

`promote` must preserve candidate identity and must not rebuild a semantically different release.

---

## 76. Tracker mechanics

`to-spec` and `to-tickets` currently own tracker-oriented methodology.

Provider-specific tracker mutation may initially use their supported tooling.

If repeated tracker mechanics prove token-heavy or unreliable, a small deterministic tracker adapter may be added.

It must remain mechanical:

- create/update Spec;
- create/update ticket;
- link/supersede;
- comment replan/result;

and must **not** become lifecycle state.

This is an implementation seam, not permission to build a workflow database.

---

# Part XIII — Configuration

## 77. `.poiesis/config.jsonc`

Primary v1 conceptual shape:

```jsonc
{
  "models": {
    "reasoning": "openai/gpt-5.6-sol",
    "execution": "minimax/<m3-model-id>"
  },

  "repository": {
    "remote": "origin",
    "integrationBranch": "main"
  },

  "tracker": {
    "provider": "github",
    "project": "owner/repository"
  },

  "delivery": {
    "preview": {
      "adapter": "<adapter-id>"
    },
    "staging": {
      "adapter": "<adapter-id>"
    },
    "production": {
      "adapter": "<adapter-id>"
    }
  }
}
```

Provider/adapter-specific option objects may be nested under their target.

The exact provider-specific option schema is intentionally adapter-owned.

---

## 78. Config principles

Config contains project-level choices.

Config does **not** contain workflow discretion such as:

```text
preview: optional
production: automatic
mergeRequiresExplicitCommand
skipReview
fastPath
```

Those do not exist in normal Poiesis v1.

---

## 79. Remote config

`repository.remote` identifies the canonical Git remote.

Do not universally hardcode `origin`.

Installer may recommend `origin` when appropriate.

---

## 80. Tracker config

Tracker config identifies the required canonical work tracker.

Core treats the project target as a configured provider target.

Do not embed GitHub-only semantics in the METHOD.

---

## 81. Delivery config

All three semantic targets are required:

```text
Preview
Staging
Production
```

`doctor` should treat an unconfigured required delivery target as unhealthy.

The concrete adapter may differ per project.

The lifecycle never does.

---

# Part XIV — Repository footprint

## 82. Canonical tracked `.poiesis/`

```text
.poiesis/
├── PHILOSOPHY.md
├── METHOD.md
├── config.jsonc
├── manifest.json
└── roles/
    ├── poiesis.md
    ├── planner.md
    ├── worker.md
    ├── research.md
    └── reviewer.md
```

No primary tracked:

```text
logs/
state/
events/
proofs/
plans/
intents/
work/
metrics/
cache/
adapters/
```

---

## 83. `PHILOSOPHY.md`

Contains the installed Poiesis method philosophy:

- intent before procedure;
- one visible agent;
- standard lifecycle;
- Context Economy;
- learn before specialized work;
- deterministic mechanics;
- proof before completion;
- invisible infrastructure;
- Preview always;
- production explicit.

It is Poiesis method documentation, not project product philosophy.

---

## 84. `METHOD.md`

Contains the exact runtime workflow and authority gates.

It is the compact operational projection of this Foundation document.

---

## 85. `roles/`

Canonical harness-neutral semantic role definitions.

Harness-specific files are generated projections.

---

## 86. `AGENTS.md`

Poiesis does **not** modify project `AGENTS.md` by default.

Project instructions remain project-owned.

Poiesis instructions live in `.poiesis/` and generated harness adapter files.

If a future harness absolutely requires insertion into a project instruction file, use the smallest clearly managed removable block and treat it as a fallback, not the standard design.

---

## 87. Ephemeral temp

Poiesis may use:

- OS temp;
- an ignored `.poiesis/tmp/`;

for large logs/patches/intermediate artifacts.

Ephemeral temp:

- is not source of truth;
- is safe to delete;
- must not be required for recovery.

---

# Part XV — Manifest and ownership

## 88. `.poiesis/manifest.json`

Manifest is an **ownership record**, not workflow state.

Minimum semantics:

```json
{
  "schema": 1,
  "poiesisVersion": "1.0.0",

  "adapter": {
    "name": "opencode"
  },

  "files": [
    {
      "path": ".opencode/agents/poiesis.md",
      "owned": true,
      "hash": "<content-hash>"
    }
  ],

  "skills": [
    {
      "source": "mattpocock/skills",
      "name": "grilling",
      "preexisting": false
    }
  ],

  "configPatches": [
    {
      "file": "opencode.jsonc",
      "path": "<managed-config-path>",
      "previous": "<previous-value>",
      "installed": "<poiesis-value>"
    }
  ]
}
```

Exact serialization may be refined during implementation.

The semantics are fixed.

---

## 89. Ownership invariant

> **If Poiesis cannot prove it owns a file or mutation, it does not overwrite or delete it.**

Applies to:

- init;
- update;
- uninstall;
- workspace cleanup;
- skill management;
- generated adapter files.

---

# Part XVI — Installation lifecycle

## 90. `poiesis init`

High-level sequence:

```text
PRE-FLIGHT
→ CONFIGURE
→ INSTALL CORE
→ INSTALL SKILLS
→ INSTALL HARNESS ADAPTER
→ APPLY MINIMAL HARNESS CONFIG
→ VALIDATE WITH DOCTOR
```

### Pre-flight validates

- Git repo;
- configured/available remote;
- integration branch;
- supported tracker;
- tracker auth;
- Preview adapter;
- Staging adapter;
- Production adapter;
- supported harness;
- reasoning model;
- execution model;
- conflicts with existing installation.

### Init creates

- `.poiesis/*`;
- canonical roles;
- manifest;
- curated skills through upstream mechanism;
- generated OpenCode adapter files;
- minimal required OpenCode config projection.

Init does not modify application code.

---

## 91. Existing-file conflict

If an intended Poiesis-owned generated path already exists and current manifest cannot prove ownership:

```text
fail closed
```

Do not overwrite.

---

## 92. `poiesis doctor`

Read-only.

Checks at least:

- core files;
- role files;
- config syntax;
- manifest consistency;
- managed-file hashes/ownership;
- curated skills;
- harness adapter;
- models;
- Git repo;
- remote;
- integration branch;
- merge-commit compatibility;
- tracker;
- tracker auth;
- Preview;
- Staging;
- Production;
- runtime availability;
- current provider compatibility.

Doctor never secretly repairs the repo.

---

## 93. `poiesis update`

Update:

1. reads manifest;
2. verifies current ownership;
3. checks compatibility;
4. updates Poiesis-owned core files;
5. regenerates adapter files;
6. updates only Poiesis-owned installed skills;
7. performs required config migrations;
8. runs doctor.

If a managed file has been modified by the user and update cannot safely prove/merge ownership:

```text
refuse destructive update
```

Do not magic-merge role Markdown.

---

## 94. `poiesis uninstall`

Uninstall reverses/removes only proven-owned state.

It may:

- reverse Poiesis config patches if still owned;
- remove generated Poiesis harness files;
- uninstall skills that Poiesis installed and did not preexist;
- remove known-owned `.poiesis/` files.

It must not:

- delete preexisting skills;
- overwrite later user config;
- delete unknown files;
- erase Git history;
- delete tracker issues/tickets/history;
- delete PR/MR history;
- destroy unmerged development work.

If unknown files exist under `.poiesis/`, fail closed instead of recursively deleting the directory.

---

## 95. Active work during uninstall

If Poiesis has an owned workspace with unmerged/undelivered work:

preserve it.

Uninstalling tooling is not permission to destroy development work.

---

## 96. No hidden global Poiesis state

Avoid:

```text
~/.poiesis/database
global workflow state
global credential store
```

Use harness/provider credentials where they already exist.

A clean uninstall/re-init should not depend on hidden Poiesis state elsewhere.

---

# Part XVII — OpenCode adapter

## 97. Generated OpenCode files

Expected projection:

```text
.opencode/
└── agents/
    ├── poiesis.md
    ├── poiesis-planner.md
    ├── poiesis-worker.md
    ├── poiesis-research.md
    └── poiesis-reviewer.md
```

Use OpenCode’s built-in/native Explore when current behavior satisfies the Explore contract.

No generated verifier agent.

Verifier is deterministic runtime.

---

## 98. OpenCode config

The adapter minimally configures:

- Poiesis primary agent;
- model routing;
- required role permissions;
- child delegation;
- nesting depth/current equivalent;
- skill visibility;
- any required session behavior.

Implementation must use the **current supported config format**.

Do not rely on historical keys without verifying source/docs.

---

## 99. Permission philosophy

Permissions reduce both risk and context/tool noise.

Role surfaces should be narrow.

OpenCode adapter should use current supported permission controls to deny entire tool classes when possible.

Do not rely on prompt text as the only boundary when a supported deterministic/harness permission exists.

But also do not overclaim per-target child enforcement if the current OpenCode version does not enforce it strongly.

---

# Part XVIII — Session hygiene

## 100. Internal sessions are ephemeral

Internal child sessions are execution context, not durable work state.

Normal Author UX should not be cluttered by:

- Planner sessions;
- Worker sessions;
- Reviewer sessions;
- Explore sessions;
- Research sessions.

---

## 101. Cleanup policy

Keep a child only while its responsibility may still continue.

Examples:

### Explore / Research

Delete once bounded result is captured.

### Planner

Delete once design result is durably materialized in the Spec.

A future Replan uses a fresh Planner.

### Worker

May stay resumable until ticket review/checkpoint so one targeted correction can reuse it.

Delete after the ticket becomes durably accepted.

### Reviewer

Delete after verdict is captured.

Every new review is fresh.

### Nested children

Clean leaf-first.

---

## 102. OpenCode behavior

Current OpenCode research indicates:

- child sessions are not necessarily deleted on completion;
- root session lists can hide child sessions;
- supported session APIs expose deletion;
- recursive deletion may need explicit child enumeration.

The adapter should use supported APIs only.

Cleanup is best-effort hygiene.

If a crash leaves stale child sessions, project correctness must not depend on removing them.

---

# Part XIX — Recovery

## 103. Recovery source order

Poiesis reconstructs progress from ordinary durable state.

Primary sources:

1. Git/worktree/branch state;
2. top-level Spec;
3. tracker tickets/dependencies/status/history;
4. checkpoint commits;
5. PR/MR state;
6. deployment/release history;
7. harness sessions only as supplementary context.

Objective infrastructure evidence wins over stale conversational memory.

---

## 104. No workflow database

Do not create:

- `state.json`;
- event ledger;
- run database;
- phase mirror;
- retry-count store;

merely to duplicate the information above.

Add durable state machinery only if a concrete failing recovery evaluation proves the ordinary sources insufficient.

---

# Part XX — Author UX

## 105. Normal feature conversation

Example:

> **Author:** Add organization invitations.

Poiesis runs:

```text
Understand
→ Authorize
→ Prepare
→ Plan
→ Spec
→ Tickets
→ Realize
→ Review
→ Checkpoints
→ Proof
→ Publish
→ Preview
```

Then:

> **Poiesis:** The feature is ready for you to try. Test the invitation flow and tell me whether this is what you had in mind.

Author tests.

> **Author:** Yes, that's exactly what I wanted.

Poiesis internally:

```text
freshness gate
→ stage
→ verify staging
→ integrate
→ verify integrated revision
```

Then:

> **Poiesis:** The accepted change passed staging, is integrated, and the integrated revision is verified. Do you want me to release it to production?

> **Author:** Yes.

Poiesis:

```text
promote same candidate
→ production verification
→ close work
→ cleanup
```

Then:

> **Poiesis:** Released successfully.

No Git vocabulary is required.

---

## 106. Technical provenance on request

If the Author asks:

- “Show me the PR.”
- “Which commit was verified?”
- “Show me the tickets.”
- “What failed in verification?”

Poiesis can surface those details.

Infrastructure is hidden by default, not inaccessible.

---

# Part XXI — Definition of done

## 107. Done means production-complete

A top-level Intent is complete only when:

- the Intent is understood;
- implementation was authorized;
- current capability was sufficient/acquired;
- strong technical planning occurred;
- canonical Spec exists;
- executable tickets exist;
- all tickets were independently reviewed and checkpointed;
- whole-change machine verification passed;
- final Spec Review passed;
- final Standards Review passed;
- exact proven candidate was Previewed;
- Author accepted the realization;
- the accepted candidate passed Staging;
- canonical integration completed and the integrated revision was verified;
- Author authorized Production;
- the same candidate was released;
- post-release verification passed;
- tracker work was closed;
- owned workspace was safely cleaned.

“Code generated” is not done.

“Tests passed” is not done.

“Merged” is not done.

Done means:

> **the Author's Intent is realized, proven, accepted, released, and healthy in Production.**

---

# Part XXII — Bootstrap and self-hosting

## 108. Bootstrap principle

> **Hand-write only the smallest kernel required for Poiesis to start developing Poiesis through its own method.**

Do not hand-build the entire product and call self-hosting an afterthought.

Do not create a fake bootstrap that depends on functionality it is itself trying to implement.

---

## 109. Hand-written bootstrap kernel

The initial manually implemented foundation may include:

```text
Poiesis npm CLI/runtime
├─ config + manifest parsing
├─ init
├─ doctor
├─ update
├─ uninstall
├─ inspect
├─ capability install
├─ workspace prepare
├─ checkpoint
├─ verify
├─ publish
├─ preview
├─ integrate
├─ promote
├─ workspace cleanup
├─ OpenCode adapter
├─ session hygiene
├─ PHILOSOPHY.md
├─ METHOD.md
├─ role definitions
└─ curated skill installation
```

No bootstrap-specific state machine.

No bootstrap-only product architecture.

---

## 110. Self-host boundary

As soon as Poiesis can:

```text
poiesis init
poiesis doctor
```

on its own repository and can safely execute the canonical lifecycle, new Poiesis features should normally be implemented **through Poiesis itself**.

---

## 111. First self-hosted work

The first self-hosted feature should be:

- real;
- small enough to understand;
- not circularly required by the existing kernel;
- capable of exercising multiple roles.

A good candidate is an improvement to OpenCode session hygiene or another bounded adapter behavior.

---

## 112. Self-host success gate

Do not declare self-hosting successful after a typo.

Dogfood should demonstrate at least:

```text
simple one-ticket change
multi-ticket feature
Planner → Explore/Research nested delegation
Capability Check + acquired capability
ticket review correction loop
real Replan
crash/restart recovery
dirty foreign checkout untouched
Preview → Author acceptance → integration
Staging → production authority gate
child-session cleanup
uninstall preserves foreign state
```

---

# Part XXIII — Dogfood and experiments

## 113. Work artifact A/B test

Primary:

```text
A — Tracker-first
Spec → Tickets → Git → PR/MR
```

Preserved alternative:

```text
B — Local technical plan
Spec → .poiesis/work plan → Tickets → Git → PR/MR
```

Measure:

- strong-model tokens;
- Worker rediscovery cost;
- Planner quality;
- recovery;
- lost commitments;
- replan clarity;
- human comprehensibility;
- duplicated truths;
- maintenance complexity.

Do not reintroduce B by taste.

Require evidence.

---

## 114. Debug skill A/B test

Primary:

```text
Matt diagnosing-bugs
```

Compare later with:

```text
Superpowers systematic-debugging
```

Use real controlled failures.

---

## 115. Context Economy measurements

For representative dogfood runs capture where supported:

- model used per role;
- number of child sessions;
- strong-model context size;
- execution-model context size;
- whether raw exploration leaked into strong context;
- token/cost totals;
- Worker rediscovery;
- replan frequency;
- review findings;
- compaction occurrence;
- recovery quality.

Target:

> **minimum sufficient context and intelligence without reducing reliability.**

Do not hardcode arbitrary token thresholds before measurement.

---

# Part XXIV — Explicitly superseded designs

## 116. OpenCode-only product identity

**Superseded.**

Current:

```text
harness-neutral Poiesis core
+
OpenCode first adapter
```

---

## 117. OpenCode plugin control plane

**Rejected for v1.**

No plugin unless a future hard guarantee proves native capabilities + runtime insufficient.

---

## 118. Modifying `AGENTS.md`

**Rejected as default.**

Poiesis uses `.poiesis/` + harness adapter projections.

---

## 119. `.poiesis/work/*.md` as primary state

**Not primary. Preserved as dogfood alternative.**

Tracker-first is canonical v1.

---

## 120. Separate durable plan file

**Removed from primary v1.**

Planner remains mandatory.

Its consequential technical decisions are materialized in the tracker Spec.

---

## 121. Superpowers `writing-plans` as default

**Removed from primary v1.**

Preserved only for local-plan experiment.

---

## 122. Separate fast implementation path

**Removed.**

One standard implementation lifecycle after Authorize.

---

## 123. GitHub issue only for large work

**Superseded.**

A supported issue tracker is required.

Every authorized change gets a Spec.

Every executable Worker unit gets a ticket.

---

## 124. `dev` and `production` branches

**Rejected as Poiesis standard.**

Current:

```text
one integration branch
+
short-lived change branches
+
Preview/Staging/Production delivery targets
```

---

## 125. Explicit “merge it” Author command

**Removed from normal UX.**

Natural realization acceptance authorizes integration.

---

## 126. Automatic Production

**Rejected.**

Production always requires explicit natural-language Author authorization.

---

## 127. Normal merge preserving ticket checkpoints as canonical history

**Superseded in v1.1.**

Accepted ticket checkpoints remain useful recovery boundaries on the Poiesis change branch, but they do not need to become permanent integration history.

V1.1 standard is one canonical squash integration commit per top-level Spec.

---

## 128. Verifier LLM role

**Rejected.**

Verifier is deterministic runtime.

Semantic review remains Reviewer.

---

## 129. Many permanent reviewer agent types

**Rejected.**

One semantic Reviewer role.

Different fresh review contracts/model classes where required.

---

## 130. Unlimited nested agent swarms

**Rejected.**

Shallow bounded support delegation only.

---

## 131. Custom skill manager / vendored skills

**Rejected.**

Use maintained upstream installation/update mechanisms.

Manifest tracks ownership.

---

## 132. Workflow database/event ledger

**Rejected unless dogfood proves necessary.**

Durable truth comes from ordinary project infrastructure.

---

# Part XXV — Non-goals

## 133. Poiesis is not

- an IDE;
- a coding model;
- an MCP replacement;
- a CI replacement;
- a new issue tracker;
- a new Git implementation;
- a mandatory hosted service;
- a proprietary project format;
- a workflow database;
- an excuse to generate Markdown;
- a general-purpose agent swarm framework;
- a replacement for project-native domain docs;
- a replacement for maintained skills.

Poiesis is a coherent **method + orchestration runtime**.

---

# Part XXVI — Open implementation TODOs

## 134. Current upstream verification

Before implementation pins behavior, re-verify:

- current OpenCode config schema;
- current custom-agent schema;
- current permission semantics;
- current child nesting semantics;
- current session list/delete/children APIs;
- current Agent Skills discovery/install paths;
- current Matt skill names/frontmatter/invocation rules;
- current Superpowers skill names;
- current tracker support of upstream skills.

Do not code from stale assumptions.

---

## 135. `to-spec` / `to-tickets` autonomous invocation

This is the most important current integration question.

Poiesis requires them as standard method steps.

The Author must not manually invoke slash commands.

Implementation must find the cleanest supported way to invoke the maintained upstream method automatically without copying it into Poiesis.

---

## 136. Delivery adapter mechanics

Semantics are frozen:

```text
Preview always
Staging always
Production always explicit
```

Provider-specific mechanisms are not all frozen.

Implementation needs a clean adapter interface and at least the adapters required for Poiesis self-hosting and initial supported projects.

Do not change the lifecycle to avoid implementing the adapter.

---

## 137. Tracker providers

Core must be provider-neutral.

Provider implementation order may be staged, but do not bake a single forge into Poiesis METHOD.

---

## 138. Model recommendation

Future `poiesis init` should inspect:

- active harness;
- provider/model inventory;
- existing project config;

and recommend reasoning/execution models.

V1 correctness does not depend on smart recommendation.

Explicit configuration is sufficient.

---

## 139. Future harness adapters

After OpenCode is stable and dogfooded:

- Claude Code;
- Codex;
- others.

Do not pay speculative implementation cost before the OpenCode adapter proves the method.

---

# Part XXVII — Research basis / external references

## 140. Matt Pocock skills

Repository:

https://github.com/mattpocock/skills

Relevant current concepts include:

- `grilling`;
- `grill-with-docs`;
- `domain-modeling`;
- `research`;
- `codebase-design`;
- `to-spec`;
- `to-tickets`;
- `code-review`;
- `diagnosing-bugs`.

Current upstream evolves quickly.

Implementation must pin/verify the exact revision it supports.

---

## 141. Superpowers

Repository:

https://github.com/obra/superpowers

Relevant skills:

- `test-driven-development`;
- `verification-before-completion`;
- `systematic-debugging` (dogfood comparison);
- `writing-plans` (preserved alternative, not primary).

---

## 142. OpenCode

Repository/docs:

https://github.com/anomalyco/opencode  
https://opencode.ai/docs/

Use current supported APIs/config only.

Current research found supported session operations and persistent child sessions, but implementation must re-verify the target version.

---

## 143. Git/release research basis

Poiesis branching/release direction is informed by:

- GitHub Flow;
- GitLab Review Apps;
- DORA trunk-based development;
- deployment automation guidance.

The conclusion is intentionally a Poiesis-owned standard:

```text
one integration branch
+
short-lived change branches
+
environments/releases separate from branches
```

No external Git workflow skill owns this policy.

---

# Part XXVIII — Implementation acceptance checklist

## 144. Architecture

- [ ] new Poiesis repository, not an `opencode-ship` rename/refactor
- [ ] harness-neutral core
- [ ] OpenCode first adapter
- [ ] no OpenCode plugin
- [ ] no workflow database
- [ ] no default `AGENTS.md` mutation
- [ ] deterministic runtime is mechanical, not orchestration state

---

## 145. Repository footprint

- [ ] `.poiesis/PHILOSOPHY.md`
- [ ] `.poiesis/METHOD.md`
- [ ] `.poiesis/config.jsonc`
- [ ] `.poiesis/manifest.json`
- [ ] `.poiesis/roles/{poiesis,planner,worker,research,reviewer}.md`
- [ ] generated OpenCode agent projections
- [ ] curated skills installed through supported mechanism
- [ ] no default `.poiesis/work/`

---

## 146. Maintenance CLI

- [ ] `poiesis init`
- [ ] `poiesis update`
- [ ] `poiesis doctor`
- [ ] `poiesis uninstall`
- [ ] fail-closed ownership behavior
- [ ] no hidden global Poiesis state

---

## 147. Runtime

- [ ] inspect
- [ ] capability install
- [ ] workspace prepare
- [ ] checkpoint
- [ ] verify
- [ ] publish
- [ ] preview
- [ ] integrate
- [ ] promote
- [ ] workspace cleanup

---

## 148. Workflow

- [ ] Express
- [ ] Understand
- [ ] Authorize
- [ ] Prepare
- [ ] Capability Check
- [ ] strong fresh Planner
- [ ] Spec issue
- [ ] tickets
- [ ] fresh Worker per ticket
- [ ] independent ticket review
- [ ] checkpoint per accepted ticket
- [ ] Replan on design contradiction
- [ ] exact-SHA Verify
- [ ] fresh reasoning Spec Review
- [ ] fresh reasoning Standards Review
- [ ] Preview exact proven candidate
- [ ] natural Author acceptance
- [ ] integration freshness gate
- [ ] Staging before canonical integration
- [ ] staging verification
- [ ] one canonical squash integration commit per top-level Spec
- [ ] verify integrated SHA/content
- [ ] explicit Production question
- [ ] same candidate released
- [ ] post-release verification
- [ ] close tracker work
- [ ] cleanup

---

## 149. UX

- [ ] Author only normally sees Poiesis
- [ ] no agent switching
- [ ] no plan execution commands
- [ ] no Git commands
- [ ] no issue/PR management required
- [ ] no “merge it” required
- [ ] Production always explicitly asked
- [ ] technical provenance available on request

---

## 150. Context Economy

- [ ] strong model used for Poiesis/Planner/final reviews
- [ ] execution model used for Explore/Research/Worker/ticket review/debug execution
- [ ] child returns bounded
- [ ] raw logs/diffs avoided in strong parent
- [ ] compaction not used as primary architecture
- [ ] role tool surfaces narrow
- [ ] repeated mechanics deterministic

---

## 151. Safety and recovery

- [ ] dirty foreign checkout not consumed
- [ ] cleanup fail-closed
- [ ] unknown ownership never overwritten/deleted
- [ ] exact candidate identity bound to proof
- [ ] any mutation invalidates Proof
- [ ] stale integration base triggers re-Proof + re-Preview + re-acceptance
- [ ] session cleanup not required for correctness
- [ ] restart recovery from Git/tracker/PR/deployments
- [ ] uninstall preserves foreign state and project history

---

# Part XXIX — The Poiesis kernel in 15 rules

If the entire design must be remembered in a compact form:

1. The Author expresses intent in normal language.
2. The Author speaks to one visible agent: Poiesis.
3. Every authorized implementation follows one standard lifecycle.
4. Ask the Author only for consequential decisions that cannot be discovered.
5. Run Capability Check before strong planning.
6. Strong models decide; execution models explore, implement, and perform routine review.
7. Planner is architecturally decisive and implementation-permissive.
8. Spec is the durable decision record; tickets are executable slices; Git is realized truth.
9. Every Worker ticket gets an independent review and accepted checkpoint.
10. Proof belongs to an exact candidate; any mutation invalidates it.
11. Every proven feature gets a Preview before integration.
12. Natural Author acceptance authorizes integration; Git remains invisible.
13. Staging is mandatory and Production is always an explicit Author decision.
14. Deterministic helpers own mechanics, never workflow judgment.
15. Complexity, state, and context must continually re-earn their cost.

---

# Part XXX — Final product promise

Poiesis should make this feel ordinary:

> **Author:** I have an idea.  
> **Poiesis:** Tell me.

Everything after that is the method’s responsibility.

The Author should be free to think about **what should exist**.

Poiesis should carry the engineering process required to make it exist, prove it, present it for validation, integrate it, and—only when the Author explicitly decides—release it to Production.

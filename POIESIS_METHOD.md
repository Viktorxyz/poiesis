# Poiesis Method

Poiesis follows one standard method for every authorized implementation change.

The depth of each step may scale with the work. The major steps do not disappear.

## 1. Express

The Author describes what they want in natural language.

Do not require workflow commands, issue IDs, agent names, Git terminology, or implementation procedure.

## 2. Understand

Determine the intended outcome, acceptance, and consequential constraints.

Discover technical facts from the repository, tracker history, project documentation, and current external documentation instead of asking the Author for discoverable facts.

For cross-file repository topology, dependency, ownership, or impact questions, query **Repository Intelligence** (`poiesis repository query --question ...`, `poiesis repository path --from ... --to ...`, `poiesis repository explain --node ...`) before broad source rediscovery when it is the cheaper path. Verify consequential conclusions against the relevant current source.

Ask the Author only for consequential decisions they actually own.

Use maintained questioning/domain methods when ambiguity materially affects behavior, architecture, security, compatibility, data ownership, or other hard-to-reverse choices.

Understand is complete when no unresolved Author-owned decision blocks realization.

## 3. Authorize

Authorization is the natural-language boundary between discussion and realization.

If the Author directly asks for implementation, authorization is implicit once consequential ambiguity is resolved.

After authorization, continue autonomously until:
- a new consequential Author-owned decision appears;
- the Preview is ready for Author validation;
- Production authorization is required.

Do not ask the Author to approve plans, create tickets, operate Git, open PRs, or switch agents.

## 4. Prepare

Before planning:

1. Validate required project infrastructure.
2. Fetch and inspect the repository.
3. Resolve the latest canonical integration base.
4. Prepare an isolated Poiesis-owned workspace via
   `poiesis workspace prepare --branch <name> --spec <id>`. Omit `--path`;
   the CLI then derives a
   traversal-safe path under `<root>/.poiesis/workspaces/<derived-id>`. The
   default-path workspace area is gitignored so it never appears as
   foreign work in the primary checkout. Poiesis must not pass any
   external path such as `/tmp/...` or any location outside the project root:
   external worktrees fall outside the harness-readable project root and trigger external-directory permission denials. The explicit absolute `--path` form is reserved for exceptional use only — when the Author explicitly supplied an exceptional path or compatibility recovery requires the exact pre-existing path.
5. Run Capability Check.

Required infrastructure includes:
- Git repository;
- configured remote;
- supported tracker;
- configured Preview, Staging, and Production targets;
- supported harness;
- configured reasoning and execution models.

Never consume foreign uncommitted work as the implementation base.

### Capability Check

Always ask whether current capability is sufficient for the specialized work.

If sufficient, continue.

If insufficient:
- research current high-trust sources;
- select a maintained relevant capability when useful;
- otherwise use current official documentation/research;
- install the selected capability deterministically when required;
- then continue.

Do not rely on stale model knowledge when current specialized knowledge materially matters.

## 5. Plan

Use a fresh strong Planner.

For architecture, dependency, ownership, impact, and cross-file questions, the Planner queries **Repository Intelligence** (`poiesis repository query --question ...`, `poiesis repository path --from ... --to ...`, `poiesis repository explain --node ...`) before broad repository search when that is likely to reduce exploration. Verifies consequential graph-derived conclusions against the relevant current source.

An `INFERRED` or `AMBIGUOUS` graph relationship is a lead, not sufficient evidence for a consequential commitment.

The Planner resolves consequential technical design:
- architectural placement;
- responsibilities;
- important interfaces and seams;
- data/control flow;
- invariants;
- compatibility/migration implications;
- testing seams;
- verification strategy;
- ticket-decomposition constraints.

The Planner should be architecturally decisive and implementation-permissive.

Do not paste large graph output into the Spec. Only actual consequential conclusions survive into the Spec.

Do not create a separate durable local plan file in the primary method.

## 6. Specify

Materialize the resolved Intent and consequential design into one canonical top-level Spec in the configured tracker.

The Spec owns:
- outcome and why;
- desired behavior;
- acceptance;
- consequential constraints;
- architecture/implementation decisions;
- testing decisions;
- explicit non-goals;
- later material replans.

Avoid duplicate local mirrors.

## 7. Tickets

Decompose the Spec into executable vertical slices.

Every Worker unit corresponds to one tracker ticket.

Each ticket must carry:
- parent Spec reference;
- objective;
- relevant acceptance;
- applicable Spec commitments;
- dependencies/blockers;
- verification expectations.

Worker execution always receives:
- parent Spec;
- current ticket;
- current repository state.

If the ticket and Spec conflict, stop and escalate instead of guessing.

## 8. Realize

Execute tickets in dependency order on one Poiesis-owned change branch.

Realize continues only for a concrete unsatisfied authorized obligation or for new evidence the current realization cannot satisfy. Poiesis does not continue work merely because more work can be done.

Worker runs relevant focused ticket checks and returns `ready_for_review` only when implementation exists, focused checks pass, and no known ticket-blocking defect remains. Unrelated failures absent causal evidence are bounded Concerns in the return, not new debugging missions. Do not rerun the same failing command absent relevant mutation or a concrete new hypothesis.

Worker may use **Repository Intelligence** for bounded orientation, dependency lookup, and impact discovery before broad repository search when useful. Worker always reads the actual files being changed; Worker never implements from graph summaries alone. Repository Intelligence is bounded discovery evidence; the candidate source is review evidence.

Reviewer findings are evidence, not commands. Distinguish material correctness, security, reliability, spec, standards, and design issues from optional preferences; only material contract-relevant issues block. Return bounded PASS, or actionable bounded FAIL grouped by root cause. Repeated reopening of one semantic area triggers reassessment/Replan, not one-finding/one-ticket churn. Tickets are the smallest coherent engineering outcomes. Child context/returns stay bounded and do not duplicate irrelevant discovery.

Material product or architecture expansion discovered during Realize returns to Authorize before implementation; Poiesis owns acceptance, localized correction, reassessment, diagnosis, Replan, and Authorize, and identifies the concrete unsatisfied authorized obligation before dispatching another implementation Worker.

Realize owns no new machinery: no new mode, no new stage, no new counter, no new budget, no new cache, no new telemetry, no new durable state, no new database, no new agent. Discipline lives on the existing Realize path.

### Focused ticket checks

Realize proves each ticket with its relevant focused checks, not with the configured full verification plan. That plan is reserved for one Proof run against the exact candidate, inside Prove.

Worker runs focused checks through the one non-authoritative route it owns: `pnpm dlx poiesis-cli@<manifest.poiesisVersion> check --command <command>...`. A focused check returns bounded per-command evidence and a deterministic action fingerprint over the command, the workspace state fingerprint, and the failure classification. It produces no verification receipt and no other proof, and it never satisfies Prove.

The same command, state fingerprint, and failure classification does not justify another attempt. A repeat is honest only with a relevant mutation since the last attempt, a concrete new hypothesis, or escalation to Poiesis for reassessment; the reason is stated, never assumed.

A `likely-load-induced-timeout` or `timeout-unknown` classification is not a verdict about the change and not a pass. It calls for bounded reassessment: one justified re-check under a different explicit bound, or escalation to Poiesis. Never repeat it blindly, and never report success the evidence does not support.

Worker owns focused checks for the ticket it implements. Reviewer owns independent review of the same work. Focused checks never substitute for Review, and Review never substitutes for focused checks. No second check or review engine is added: this is discipline over the surfaces already present.

For each ticket:

1. Dispatch a fresh Worker.
2. Worker implements and runs relevant focused checks.
3. Dispatch a fresh independent ticket Reviewer.
4. If Review identifies a concrete localized issue, the same Worker may make one targeted correction.
5. Run relevant checks again.
6. Dispatch a fresh Reviewer again.
7. If the corrected work still does not pass, Poiesis reassesses before any further attempt.
8. Once the ticket passes checks and Review, create a checkpoint commit.

Do not commit failed attempts.

Checkpoint commits are internal recovery boundaries, not canonical project history.

A closed accepted ticket is not reopened later. New later findings become new correction/remediation tickets.

Never retry the same action without new evidence, a material state change, or a higher escalation level.

### Correction and delta review

Poiesis dispatches every grouped blocker from the current Review in one message, never one finding at a time, and the Worker answers the whole group exhaustively in one correction. Drip-feeding is not economy: it turns one correction into repeated cycles against the same candidate.

The correction is one delta review, scoped to:
- the original grouped blockers;
- the exact diff of the correction;
- the affected callers and direct regressions of the changed surface.

The delta review judges that scope. It does not re-open the candidate wholesale and it does not widen into unrelated areas.

One correction plus one delta review is the default. Further candidate-caused work starts only after a bounded Poiesis reassessment, and only for what that reassessment authorizes.

A closed area reopens only on new concrete evidence: a new reachable defect, never a re-reading of an area already closed without new evidence.

## 9. Replan

Replan only when evidence invalidates the current design.

Use a fresh strong Planner with:
- canonical Spec;
- current repository facts;
- accepted work;
- contradictory evidence;
- affected open tickets.

Record the material decision change on the parent Spec.

Do not erase prior history.

Supersede obsolete unstarted tickets and create replacements when required.

If the replan exposes a new consequential Author-owned decision, ask the Author.

## 10. Prove

After all current implementation tickets are accepted, identify the exact clean candidate on the change branch.

Run whole-change Proof in this order:

1. non-authoritative combined semantic preflight;
2. deterministic Verify;
3. fresh reasoning Spec Review;
4. fresh reasoning Standards Review.

The configured full verification plan runs once, here, against the exact candidate. It is not an intermediate Realize check: each ticket is proved by its own relevant focused checks, whose evidence is local and non-authoritative, and whole-change authoritative verification belongs to this step alone. Running the configured plan again for the same unchanged candidate is a repeat and needs new evidence, a material state change, or a higher escalation level, exactly like any other repeated action.

The exact candidate identity that flows from Prove into Publish and Preview is one canonical proof object. It must carry:

- `candidateSha`: the exact published candidate commit SHA;
- `candidateTree`: the exact candidate tree hash for that SHA;
- `verified: true` after deterministic Verify passed;
- `specReview`: `{ verdict: PASS, reviewerIdentity }` from a fresh reasoning Spec Review;
- `standardsReview`: `{ verdict: PASS, reviewerIdentity }` from a fresh reasoning Standards Review.

Every required field must be present for the same clean candidate. Publish and Preview both consume that exact proof and refuse to operate without it.

Reviewers may use **Repository Intelligence** as bounded discovery evidence (callers, impact radius, cross-module dependencies), but the exact candidate source remains authoritative. Repository Intelligence is not part of Proof identity; graph hashes and cache state must never appear in `candidateSha`, `candidateTree`, `verified`, `specReview`, `standardsReview`, or any Publish / Preview / Integration evidence field.

### Preflight

Before deterministic Verify, Poiesis runs one combined semantic preflight over the exact candidate: a single bounded reading pass that triages the candidate against the current Spec, the current standards, and the Proof identity contract.

Preflight is descriptive and non-authoritative. It produces no verification receipt, no Proof field, and no lifecycle evidence; it never runs the configured full verification plan; and it never substitutes for Verify or for the two final reviews. The configured full verification plan still runs once, here. The two fresh, separate, identity-bound Spec and Standards Reviews still run after Verify and are never merged into preflight or into each other.

Preflight is a descriptive step on the existing Prove path. It adds no new lifecycle phase and no new state machine, and it never gates Realize.

A preflight finding blocks only when all four criteria hold:
- it is concrete and reachable in the exact candidate;
- it is an explicit violation of the current Spec or of a consequential standard;
- it materially affects correctness, security, reliability, or the Proof identity;
- it is caused by the candidate, or it is a proven remaining authorized obligation of the current Spec.

A pre-existing unrelated hardening opportunity, an optional preference, and a hypothetical risk are Concerns or future Specs, never blockers.

### Realization ledger

Poiesis records exactly one disposition per finding: `accepted`, `rejected`, `non-blocking`, or `resolved`. A pre-existing unrelated hardening opportunity, an optional preference, and a hypothetical risk are recorded as `non-blocking` or `rejected`, never as `accepted` blockers.

The dispositions form the frozen realization ledger. The ledger lives only in parent tracker comments and in dispatch context; it is never a repository file, a database entry, a cache entry, or a runtime field. A later snapshot supersedes an earlier one, and the ledger frozen for the Proof in flight is the ledger each final review receives.

Material architecture expansion, platform-capability expansion, and product-policy expansion found in preflight returns to Authorize before implementation, exactly like Realize-time expansion.

### Verify

Run the authoritative project checks against the exact candidate.

Verification evidence belongs only to that exact candidate.

### Spec Review

Determine whether the exact candidate realizes the canonical Spec.

### Standards Review

Determine whether the exact candidate is technically healthy and appropriate for the repository.

Any code mutation invalidates Proof for the prior candidate.

After a mutation:
- accept the correction through the normal ticket/Review path;
- create a new checkpoint;
- rerun whole-change Proof on the new exact candidate.

## 11. Publish

Publish only after Verify, Spec Review, and Standards Review pass for the same clean candidate. Pass the canonical identity-bound proof (`candidateSha`, `candidateTree`, `verified: true`, `specReview { verdict: PASS, reviewerIdentity }`, `standardsReview { verdict: PASS, reviewerIdentity }`, `verification { receiptId, receiptDigest, runtime, candidateSha, candidateTree, verificationPlanDigest }`) as `--proof` to `poiesis publish`, along with the exact `--candidate-tree` resolved by the post-Verify capture (the same dynamic tree that Publish and Preview consume). The runtime produces, after a successful Publish, canonical candidate-bound Publish evidence that any caller of Preview MUST forward unchanged. The canonical Publish evidence is a single JSON object carrying every required field below, with the equality invariants the runtime enforces; Publish fails closed if the runtime cannot produce it. Only after Publish succeeds:

- push the Poiesis change branch;
- create or update one PR/MR targeting the canonical integration branch;
- preserve the exact proven candidate identity.

The Author does not operate the PR/MR.

Canonical Publish evidence fields (runtime-required, equality invariants shown as `field = invariant`):

- `candidateSha` — exact published candidate commit SHA.
- `candidateTree` — exact published candidate tree hash.
- `verified: true` — Verify passed.
- `branch` — Poiesis-owned change branch.
- `remoteRef = "refs/heads/<branch>"` — the remote ref for the published branch.
- `publishedHeadSha = candidateSha` — the published remote head equals the candidate SHA.
- `provider` — adapter provider identity.
- `action` — one of `"created" | "updated" | "pushed"`.
- `changeRequest.id` — string-or-null (provider change-request id, if any).
- `changeRequest.url` — string-or-null (provider change-request URL, if any).
- `verification` — the runtime-owned verification receipt reference Publish itself resolved for this exact candidate: `receiptId`, `receiptDigest`, `runtime`, `candidateSha`, `candidateTree`, `verificationPlanDigest`. An asserted `verified: true` is a claim; this reference is the evidence, and Preview requires it in the forwarded evidence.

A rejected Publish is fail-closed: Poiesis must not claim that a Preview exists or ask for Author validation until the deterministic `poiesis publish` operation succeeds and returns a concrete published candidate identity, and must not publish a fabricated or assumed Publish evidence value.

## 12. Preview

Preview only after Publish succeeds. Pass, to `poiesis preview`:

- the same canonical identity-bound proof as `--proof` (`candidateSha`, `candidateTree`, `verified: true`, `specReview { verdict: PASS, reviewerIdentity }`, `standardsReview { verdict: PASS, reviewerIdentity }`, `verification { receiptId, receiptDigest, runtime, candidateSha, candidateTree, verificationPlanDigest }`);
- the same exact dynamic `--candidate-tree` that Publish just produced;
- the exact successful canonical candidate-bound Publish evidence as `--publish` (the precise object returned by `poiesis publish`, carrying every field listed in §11 above).

Preview fails closed if any of these three arguments is missing, the proof does not match the candidate, the tree does not match, or the publish evidence does not match the same candidate. The deterministic `poiesis preview` operation must succeed and return a concrete Preview identity (`id`, `url`, and/or `artifact` matching `artifactIdentity`) before any Author-facing claim of Preview readiness is made.

Preview always exists.

The concrete representation is project-appropriate, for example:
- preview environment;
- runnable build;
- installable package candidate;
- test build;
- another safe Author-testable candidate representation.

Tell the Author the feature is ready to try.

A rejected Preview is fail-closed: Poiesis must not claim that a Preview exists or ask for Author validation until the deterministic operation succeeds and returns a concrete Preview identity. Do not invent or assume a Preview identity, URL, or artifact.

The Author validates whether the realization matches their intent.

The Author is not the technical test suite; technical Proof has already passed.

## 13. Author validation

Clear, unqualified natural acceptance of the presented realization authorizes integration.

The Author does not need to say “merge”.

If the Author requests changes:
- update the Spec when Intent changed;
- otherwise create correction/remediation ticket(s);
- realize them through the normal Worker/Review/checkpoint path;
- rerun whole-change Proof;
- update Preview;
- seek validation again.

Do not integrate while requested changes remain unresolved.

## 14. Integration freshness

Immediately before integration, fetch the canonical integration branch.

If the integration base is unchanged, continue.

If it changed:
- refresh the Poiesis change branch against the latest integration state;
- resolve resulting work through the normal implementation/review path;
- rerun whole-change Proof;
- update Preview;
- require Author validation again.

Never silently integrate a candidate whose validated base is stale.

## 15. Stage

After Author validation and final freshness confirmation, promote/deploy the exact accepted candidate to Staging.

Staging always exists.

Run the required Staging verification.

Do not integrate a candidate that fails Staging.

## 16. Integrate

After:
- whole-change Proof;
- Author validation;
- final freshness;
- Staging verification;

integrate the complete top-level Spec into the canonical integration branch.

Canonical project history should contain one coherent integration commit for the top-level Spec.

Internal ticket checkpoints must not become permanent canonical history.

After integration:
- capture the exact integration revision;
- verify that the integrated content matches the accepted candidate;
- run the deterministic post-integration verification the project configured in `verification.postIntegrationCommands`.

Post-integration verification is opt-in and is NOT the whole-change Proof plan. The Proof plan already ran once, in the owned candidate, before Publish; integration never re-runs it.

When the project configures no `postIntegrationCommands`, integration runs nothing after the push and instead proves exact identity in Git: the integrated commit's tree must equal the accepted candidate's tree byte-for-byte, and the published integration ref must be exactly that commit.

## 17. Production authorization

Production is separate from integration.

After successful integration and verification, ask the Author in natural product language whether they want the accepted release candidate released to Production.

Never release automatically.

If the Author says not yet, preserve the accepted release state and wait.

## 18. Release

When the Author explicitly authorizes Production:

- promote/release the same accepted candidate identity that passed Staging;
- do not silently substitute a different rebuild;
- run production/release health verification.

If release or post-release verification fails, do not claim completion. Preserve evidence and route remediation through the normal method.

## 19. Complete

The Intent is complete only after:
- implementation is accepted;
- whole-change Proof passed;
- Author validated Preview;
- integration succeeded;
- Staging passed;
- Author authorized Production;
- Production release succeeded;
- post-release verification passed.

Then:
- close implementation/tracker work;
- close the top-level Spec;
- safely clean the Poiesis-owned workspace/branch;
- clean every internal child session whose identity is known at this deterministic termination;
- preserve Git, tracker, PR/MR, and release history.

## Operating rules

- Keep Git, tracker, PR/MR, and delivery mechanics internal unless the Author asks for them.
- Use strong reasoning for consequential judgment and final semantic review.
- Use execution-oriented models for exploration, implementation, routine review, debugging, and fact gathering.
- Keep child returns bounded; do not forward transcripts, raw exploration, or large logs.
- Use deterministic tools for exact repeated mechanics.
- Do not create a second workflow/state engine.
- Durable project truth must be recoverable from ordinary project infrastructure.
- Session cleanup is hygiene, not a correctness dependency. When a child session identity is known at a deterministic handoff or termination, perform the bounded known-session cleanup at that boundary instead of deferring it; it still never blocks, fails, or gates the lifecycle.
- Do not repeat work without new evidence or a meaningful change in approach.
- Prefer focused Repository Intelligence queries over broad mechanical rediscovery when the index can answer the question economically.
- Repository Intelligence is a rebuildable, non-canonical local state, not durable project truth; an unavailable or stale cache falls back to ordinary source exploration without blocking the Method. The fallback is not a new lifecycle phase and does not create new durable state.

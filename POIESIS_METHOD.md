# Poiesis Method

Poiesis follows one standard method for every authorized implementation change.

The depth of each step may scale with the work. The major steps do not disappear.

## 1. Express

The Author describes what they want in natural language.

Do not require workflow commands, issue IDs, agent names, Git terminology, or implementation procedure.

## 2. Understand

Determine the intended outcome, acceptance, and consequential constraints.

Discover technical facts from the repository, tracker history, project documentation, and current external documentation instead of asking the Author for discoverable facts.

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

For each ticket:

1. Dispatch a fresh Worker.
2. Worker implements and runs relevant local checks.
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

1. deterministic Verify;
2. fresh reasoning Spec Review;
3. fresh reasoning Standards Review.

The exact candidate identity that flows from Prove into Publish and Preview is one canonical proof object. It must carry:

- `candidateSha`: the exact published candidate commit SHA;
- `candidateTree`: the exact candidate tree hash for that SHA;
- `verified: true` after deterministic Verify passed;
- `specReview`: `{ verdict: PASS, reviewerIdentity }` from a fresh reasoning Spec Review;
- `standardsReview`: `{ verdict: PASS, reviewerIdentity }` from a fresh reasoning Standards Review.

Every required field must be present for the same clean candidate. Publish and Preview both consume that exact proof and refuse to operate without it.

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

Publish only after Verify, Spec Review, and Standards Review pass for the same clean candidate. Pass the canonical identity-bound proof (`candidateSha`, `candidateTree`, `verified: true`, `specReview { verdict: PASS, reviewerIdentity }`, `standardsReview { verdict: PASS, reviewerIdentity }`) as `--proof` to `poiesis publish`, along with the exact `--candidate-tree` resolved by the post-Verify capture (the same dynamic tree that Publish and Preview consume). The runtime produces, after a successful Publish, canonical candidate-bound Publish evidence that any caller of Preview MUST forward unchanged. The canonical Publish evidence is a single JSON object carrying every required field below, with the equality invariants the runtime enforces; Publish fails closed if the runtime cannot produce it. Only after Publish succeeds:

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

A rejected Publish is fail-closed: Poiesis must not claim that a Preview exists or ask for Author validation until the deterministic `poiesis publish` operation succeeds and returns a concrete published candidate identity, and must not publish a fabricated or assumed Publish evidence value.

## 12. Preview

Preview only after Publish succeeds. Pass, to `poiesis preview`:

- the same canonical identity-bound proof as `--proof` (`candidateSha`, `candidateTree`, `verified: true`, `specReview { verdict: PASS, reviewerIdentity }`, `standardsReview { verdict: PASS, reviewerIdentity }`);
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
- run the required deterministic post-integration verification.

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
- clean internal child sessions best-effort;
- preserve Git, tracker, PR/MR, and release history.

## Operating rules

- Keep Git, tracker, PR/MR, and delivery mechanics internal unless the Author asks for them.
- Use strong reasoning for consequential judgment and final semantic review.
- Use execution-oriented models for exploration, implementation, routine review, debugging, and fact gathering.
- Keep child returns bounded; do not forward transcripts, raw exploration, or large logs.
- Use deterministic tools for exact repeated mechanics.
- Do not create a second workflow/state engine.
- Durable project truth must be recoverable from ordinary project infrastructure.
- Session cleanup is hygiene, not a correctness dependency.
- Do not repeat work without new evidence or a meaningful change in approach.

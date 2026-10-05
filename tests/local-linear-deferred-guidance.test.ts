/**
 * Spec #139 / ticket #145 — the shipped product contract for the Local and
 * Linear trackers, for configured versus deferred delivery, and for what
 * publishing a recognized Git remote does and does not authorize.
 *
 * Ticket #141/#142/#143/#144 built the two trackers, the deferred mode, and
 * the interactive onboarding questions. This ticket ships the contract that
 * makes them one coherent product: the canon (`POIESIS_METHOD.md`), the role
 * and the projected primary-agent guidance, `README.md`, `COMPATIBILITY.md`,
 * the canonical config template, and the paste-able bootstrap prompt.
 *
 * Each assertion is an exact literal sentence. The guidance suites in this
 * repository assert literal sentences per file rather than deriving one file
 * from another, so each canonical surface is pinned independently and a
 * projection that silently drifts from the canon fails here.
 *
 * The statements asserted here are the ones an Author (or the agent acting
 * for them) must be able to rely on:
 *
 *   - tracker choice and delivery choice are separate decisions;
 *   - `local` persists Spec and ticket state in the clone, outside every
 *     working tree, with no network, no CLI, and no credential;
 *   - `linear` needs a team (and may name a project) and takes its
 *     credential from the environment only — exactly one of
 *     `LINEAR_API_KEY` (raw) or `LINEAR_OAUTH_TOKEN` (`Bearer`) — never
 *     from the config;
 *   - `fixture` stays test-only and is never an Author choice;
 *   - publishing coordinates come from the recognized Git remote, never from
 *     tracker identity, and an unresolvable remote fails closed with
 *     `PUBLISH_PROVIDER_UNRESOLVED` rather than inventing a repository;
 *   - a fork is a different repository, not a route to its upstream;
 *   - deferred delivery is a delivery statement only: it does not change the
 *     tracker, adopting it changes no existing project workflow, pushes
 *     nothing, opens no change request, and deploys nothing, and delivery is
 *     configured later through the ordinary `poiesis update --config`
 *     managed-configuration transaction;
 *   - the lifecycle still hard-stops after exact-candidate Proof with no
 *     false Preview or completion claim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_PROMPT } from "../src/bootstrap-prompt.js";
import { POIESIS_SCRIPT_COMMAND } from "../src/package-script.js";

const REPO_ROOT = join(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/**
 * The one sentence that carries tracker/delivery independence. It must be
 * literally identical in the canon, in the role, in the projection, and in
 * the README, because it is the statement the whole ticket exists to make.
 */
const INDEPENDENCE = "The tracker choice and the delivery choice are independent.";

const FORK_STATEMENT = "A fork is a different repository, not a shortcut to its upstream.";

const CREDENTIAL_STATEMENT =
  "Poiesis reads the Linear credential from the environment only: set exactly one of `LINEAR_API_KEY` (sent as the raw credential) or `LINEAR_OAUTH_TOKEN` (sent as a `Bearer` token).";

const LOCAL_STATEMENT =
  "`local` persists Spec and ticket state in the clone itself under `poiesis-tracker-v1` beneath the Git common directory, outside every working tree, and makes no network call.";

const PUBLISH_STATEMENT =
  "Publishing coordinates are a property of the configured Git remote, never of the tracker.";

const RESOLVE_STATEMENT =
  "When no coordinate resolves, Poiesis fails closed with `PUBLISH_PROVIDER_UNRESOLVED` before any push, fetch, remote revalidation, change request, or evidence.";

const LATER_CONFIGURATION_STATEMENT =
  "Configuring delivery later is the ordinary managed-configuration workflow, never a hand edit of `.poiesis/config.jsonc`: `poiesis update --config`.";

const NO_EXISTING_WORKFLOW_STATEMENT =
  "Adopting a deferred install requires no change to any existing project workflow: nothing is pushed, no pull or merge request is opened, and nothing is deployed to any environment.";

/**
 * Spec #139 / ticket #148 — the crash-left `store.lock.guard` contract.
 *
 * The canonical `store.lock` has PID and ownership-token logic, so a stale one
 * is reclaimed automatically inside the bounded wait. The guard deliberately has
 * none and must never grow any, so the only thing the runtime can do with a
 * guard a crashed process left behind is report it. These are the sentences an
 * Author reads before touching anything in the store directory themselves.
 */
const GUARD_NEVER_RECLAIMED =
  "Poiesis never reclaims a `store.lock.guard` left behind by a crash: the guard stays on disk, every later acquisition fails closed with `LOCAL_TRACKER_LOCK_TIMEOUT` naming both the canonical `store.lock` and the exact `store.lock.guard`, and clearing it is an operator decision.";

const GUARD_RECOVERY_PROCEDURE =
  "first verify that no Poiesis process is accessing the clone, then remove only the exact `store.lock.guard` artifact and retry";

const CANONICAL_LOCK_NEVER_REMOVED =
  "The canonical `store.lock` is never removed by hand, because its holder PID and ownership token already reclaim a stale one within the bounded wait.";

/**
 * Ticket #150 — the procedure is prose, never a command.
 *
 * The exact guard path travels on the error as a FIELD (`guardPath`). The
 * guidance names the two artifacts by their fixed names instead of printing a
 * command built from that path, so a clone Poiesis did not choose — a hostile
 * directory name, a path with a space, anything that could survive a rename —
 * can never become an argument, a substitution, or a pipe in a command an
 * operator pastes from an error message.
 */
const GUARD_RECOVERY_IS_PROSE =
  "The exact guard path travels as a field on that error, and the procedure is stated in prose that names the two artifacts rather than printing a command to run.";

/**
 * Spec #139 / ticket #159 — the bounded-store contract.
 *
 * The store is a COMPLETE snapshot that only ever grows, so it needs a ceiling,
 * and a ceiling has to be honest about what it counts and about what the runtime
 * refuses to do on the operator's behalf. Each of these five sentences exists
 * because the plausible alternative is silently wrong: counting the document
 * without its trailing newline, sizing a read from `stat`, measuring a
 * candidate with a second serialization, or trimming history to make a write
 * fit.
 */
const STORE_CEILING_STATEMENT =
  "The canonical document is one complete snapshot of every Spec, Ticket, comment, and history entry, and that snapshot is bounded: the total serialized store, including its trailing newline, may not exceed 16,777,216 UTF-8 bytes.";

const STORE_COMPLETE_SNAPSHOT_STATEMENT =
  "History is retained in full, so the file only ever grows and an operator reaches the ceiling by recording more work rather than by losing any.";

const STORE_BOUNDED_READ_STATEMENT =
  "A read consumes at most one byte more than that ceiling and refuses with `LOCAL_TRACKER_STORE_TOO_LARGE` before it parses anything, so a file that keeps growing under a reader stays a bounded read.";

const STORE_BOUNDED_MUTATION_STATEMENT =
  "A mutation serializes its candidate once, measures those bytes, and refuses before the durable replace, so a refused write leaves the canonical bytes, the history, the lock, and the file mode exactly as they were.";

const STORE_NO_AUTOMATIC_REPAIR_STATEMENT =
  "Nothing is pruned to fit and nothing is repaired automatically: an over-ceiling store is left byte-for-byte as it is, and reducing it is the operator's decision about their own work.";

/**
 * Spec #139 / ticket #163 — the refusal precedence, stated honestly.
 *
 * The shipped guidance claimed that a project with no
 * `.poiesis/config.jsonc` "reports `CONFIG_NOT_INSTALLED` for all six" from
 * "the primary checkout or in a Poiesis workspace". That is a promise the
 * runtime cannot keep for `poiesis workspace cleanup`, and the reason is not a
 * gap in the guard but the guard's own design:
 *
 *   - The five preflighted operations (`publish`, `preview`, `promote`
 *     staging, `promote` production, `integrate`) decide the installed state
 *     from the PRIMARY installation authority before they read anything else,
 *     so they report the same code from any directory of the clone.
 *   - `poiesis workspace cleanup` has no such preflight, because it must know
 *     what it would DELETE before it can judge anything else. It resolves
 *     workspace ownership first, so a cleanup invoked outside a workspace
 *     Poiesis can prove it owns never reaches the installed-state decision at
 *     all — and the code it reports is not the one the old sentence promised.
 *
 * That asymmetry is the SIXTH operation's alone. `poiesis publish` and
 * `poiesis integrate` also resolve ownership inside their own seams, but their
 * COMMANDS run the shared preflight first, so from an unowned working
 * directory they report the installed-state code the preflight decided and
 * never reach the ownership check. See `CLEANUP_OWNERSHIP_FIRST_SCOPE`.
 *
 * The four sentences below are the contract: ownership first for cleanup and
 * only for cleanup, the unchanged ordered precedence inside an owned workspace,
 * and the guarantee that every one of those refusals lands before the first
 * lifecycle side effect. They are asserted literally against the canon, the
 * compatibility matrix, and the README, so a projection that drifts from the
 * runtime fails here.
 */
const CLEANUP_OWNERSHIP_FIRST =
  "Workspace ownership comes first for cleanup: `poiesis workspace cleanup` proves it owns the workspace before it reads any installation, so a cleanup invoked outside a workspace Poiesis can prove it owns is refused with `WORKSPACE_OWNERSHIP_UNKNOWN` and never reaches the installed-state decision.";

const CLEANUP_OWNED_PRECEDENCE =
  "Inside an owned workspace the precedence is unchanged and strictly ordered: `RUNTIME_VERSION_MISMATCH` when the installed version does not match, then `CONFIG_NOT_INSTALLED` naming the PRIMARY checkout's `.poiesis/config.jsonc` when that installed config is missing, then `DELIVERY_DEFERRED` when it states the deferred mode.";

/**
 * The scope of the ownership-first rule, stated so it cannot be read as
 * covering all three workspace operations. Only `workspace cleanup` reaches
 * ownership before the installed state; the two commands that also own a
 * workspace are judged by the preflight first, which is why an integrator
 * wiring an error handler must not expect `WORKSPACE_OWNERSHIP_UNKNOWN` from
 * `poiesis publish` or `poiesis integrate` launched in an unowned directory.
 */
const CLEANUP_OWNERSHIP_FIRST_SCOPE =
  "`poiesis publish` and `poiesis integrate` reach workspace ownership only after the shared preflight has accepted the installed state, so their commands invoked from an unowned working directory report the installed-state code the preflight decided, never `WORKSPACE_OWNERSHIP_UNKNOWN`.";

/**
 * The refusals are decided before the first lifecycle SIDE EFFECT, and the
 * distinction is load-bearing: the read-only `git rev-parse` calls that locate
 * a root, read a common directory, and read markers all complete before the
 * refusal is raised, so a literal "before any subprocess" would be false. What
 * is guaranteed is that no subprocess that mutates anything has run.
 */
const REFUSAL_PRECEDES_SIDE_EFFECTS =
  "Every one of those refusals is decided before the first lifecycle side effect: before any side-effecting subprocess, before any remote branch deletion, before any worktree removal, before any local ref deletion, and before any change to the immutable workspace ownership marker.";

/**
 * The carve-out that makes the first sentence honest rather than a loophole.
 * A deferred install is the ordinary case in which the primary installation is
 * present, correct, and deferred, so it is the one project state in which a
 * config-first cleanup would produce a *confidently wrong* answer: it would
 * report a delivery refusal for a workspace that does not exist. Pinned
 * literally in all three files so the correction cannot be half-applied.
 */
const CLEANUP_OUTSIDE_OWNED_WORKSPACE =
  "`poiesis workspace cleanup` invoked outside a workspace Poiesis can prove it owns never reports a delivery code at all: on a fully installed deferred project it reports `WORKSPACE_OWNERSHIP_UNKNOWN` rather than `DELIVERY_DEFERRED`.";

describe("the canonical Method states one tracker / delivery contract", () => {
  const method = readRepoFile("POIESIS_METHOD.md");

  it("states tracker and delivery independence", () => {
    expect(method).toContain(INDEPENDENCE);
  });

  it("states the clone-local, network-free `local` tracker", () => {
    expect(method).toContain(LOCAL_STATEMENT);
    expect(method).toContain("needs no CLI and no credential");
    expect(method).toContain("first-class product tracker, not a test fixture");
  });

  it("states the Linear team/project coordinates and the environment-only credential", () => {
    expect(method).toContain(CREDENTIAL_STATEMENT);
    expect(method).toContain("a required `tracker.team` and an optional `tracker.project`");
    expect(method).toContain("never reads, stores, writes, or logs a Linear credential");
  });

  it("keeps `fixture` test-only and out of the Author's choices", () => {
    expect(method).toContain("`fixture` — test-only, requires `--allow-fixtures`");
    expect(method).toContain("never offered as an Author choice");
  });

  it("states recognized-remote publishing coordinates and the fork implication", () => {
    expect(method).toContain(PUBLISH_STATEMENT);
    expect(method).toContain(RESOLVE_STATEMENT);
    expect(method).toContain("`github.com` or `gitlab.com`");
    expect(method).toContain(FORK_STATEMENT);
  });

  it("states that deferred delivery changes no existing workflow and is configured later", () => {
    expect(method).toContain(NO_EXISTING_WORKFLOW_STATEMENT);
    expect(method).toContain(LATER_CONFIGURATION_STATEMENT);
  });

  it("keeps the paused-after-Proof hard stop and the no-false-claim rule", () => {
    expect(method).toContain('"delivery": { "mode": "deferred" }');
    expect(method).toContain("pauses after exact-candidate Proof");
    expect(method).toContain("DELIVERY_DEFERRED");
    expect(method).toContain("must not claim");
    // The hard stop is a property of the installed state and the operation,
    // decided from the installed config before that config is used for
    // anything else: the canon must say so rather than promise a code it
    // cannot always reach. On a CONFIGURED install, coordinate resolution is
    // the separate condition it names.
    expect(method).toContain("The refusal is a property of the installed state and the operation");
    expect(method).toContain("`CONFIG_NOT_INSTALLED`");
    expect(method).toContain("may refuse with `PUBLISH_PROVIDER_UNRESOLVED`");
    expect(method).toContain("no push, no fetch, no remote revalidation, no change request, and no delivery evidence");
  });

  it("states that workspace ownership outranks the installed state, and the ordered precedence inside an owned workspace", () => {
    // Ticket #163. The canon must not promise `CONFIG_NOT_INSTALLED` for all
    // six operations from every cwd: for `workspace cleanup` the ownership
    // decision is the first one, and it can refuse with a different code.
    expect(method).toContain(CLEANUP_OWNERSHIP_FIRST);
    expect(method).toContain(CLEANUP_OUTSIDE_OWNED_WORKSPACE);
    expect(method).toContain(CLEANUP_OWNED_PRECEDENCE);
    expect(method).toContain(REFUSAL_PRECEDES_SIDE_EFFECTS);
  });

  it("scopes ownership-first to workspace cleanup and never to publish or integrate", () => {
    // Ticket #163 review F1. The canon must not read as though all three
    // workspace-owning operations decide ownership before the installed
    // state: only `workspace cleanup` has no preflight ahead of it.
    expect(method).toContain(CLEANUP_OWNERSHIP_FIRST_SCOPE);
    expect(method).not.toContain(
      "Workspace ownership outranks all of it for the operations that own a workspace.",
    );
  });

  it("states that a crash-left store lock guard is never auto-reclaimed", () => {
    expect(method).toContain(GUARD_NEVER_RECLAIMED);
  });

  it("states the ordered operator recovery and refuses a hand-removed canonical lock", () => {
    expect(method).toContain(GUARD_RECOVERY_PROCEDURE);
    expect(method).toContain(CANONICAL_LOCK_NEVER_REMOVED);
  });

  it("states the recovery as prose on a path field, never as a command to run", () => {
    expect(method).toContain(GUARD_RECOVERY_IS_PROSE);
  });
});

describe("the Poiesis role carries the same contract", () => {
  const role = readRepoFile("POIESIS_ROLE_POIESIS.md");

  it("states tracker and delivery independence", () => {
    expect(role).toContain(INDEPENDENCE);
  });

  it("refuses to invent a tracker credential or a publishing coordinate", () => {
    expect(role).toContain("LINEAR_API_KEY");
    expect(role).toContain("LINEAR_OAUTH_TOKEN");
    expect(role).toContain("PUBLISH_PROVIDER_UNRESOLVED");
  });

  it("states the recognized-remote publishing rule and the fork implication", () => {
    expect(role).toContain(PUBLISH_STATEMENT);
    expect(role).toContain(FORK_STATEMENT);
  });

  it("keeps the paused-after-Proof hard stop and the no-false-claim rule", () => {
    expect(role).toContain('"delivery": { "mode": "deferred" }');
    expect(role).toContain("pauses after exact-candidate Proof");
    expect(role).toContain("DELIVERY_DEFERRED");
    expect(role).toContain("must not claim");
  });
});

describe("the projected primary agent carries the same contract", () => {
  const agent = readRepoFile("OPENCODE_AGENT_POIESIS.md");

  it("projects tracker and delivery independence", () => {
    expect(agent).toContain(INDEPENDENCE);
  });

  it("projects the environment-only Linear credential and the publishing rule", () => {
    expect(agent).toContain("LINEAR_API_KEY");
    expect(agent).toContain("LINEAR_OAUTH_TOKEN");
    expect(agent).toContain(PUBLISH_STATEMENT);
    expect(agent).toContain(FORK_STATEMENT);
  });

  it("projects the paused-after-Proof hard stop and the no-false-claim rule", () => {
    expect(agent).toContain('"delivery": { "mode": "deferred" }');
    expect(agent).toContain("pauses after exact-candidate Proof");
    expect(agent).toContain("DELIVERY_DEFERRED");
    expect(agent).toContain("must not claim");
  });
});

describe("README documents the whole product contract", () => {
  const readme = readRepoFile("README.md");

  it("names every production tracker and keeps fixture test-only", () => {
    for (const provider of ["github", "gitlab", "linear", "local"]) {
      expect(readme, `README must document the ${provider} tracker`).toContain(`"${provider}"`);
    }
    expect(readme).toContain("`fixture` is test-only");
  });

  it("documents the clone-local `local` tracker and the Linear coordinates and credential", () => {
    expect(readme).toContain(LOCAL_STATEMENT);
    expect(readme).toContain("needs no CLI and no credential");
    expect(readme).toContain("a required `team` and an optional `project`");
    expect(readme).toContain("LINEAR_API_KEY");
    expect(readme).toContain("LINEAR_OAUTH_TOKEN");
    expect(readme).toContain("Bearer");
  });

  it("documents configured versus deferred delivery and how to move from one to the other", () => {
    expect(readme).toContain('"delivery": { "mode": "deferred" }');
    expect(readme).toContain(INDEPENDENCE);
    expect(readme).toContain(LATER_CONFIGURATION_STATEMENT);
    // The deferred section must not promise a code the CLI cannot always
    // reach. Ticket #152: the CLI preflight decides the installed state and
    // the deferred state from the installed config BEFORE reading it for
    // anything else, so the five preflighted operations report the same code
    // wherever they run; coordinate resolution is the separate
    // CONFIGURED-install condition the same paragraph names.
    expect(readme).toContain("run one shared preflight before they read your config");
    expect(readme).toContain("refuses with `PUBLISH_PROVIDER_UNRESOLVED` instead");
  });

  it("no longer promises CONFIG_NOT_INSTALLED unconditionally for all six operations", () => {
    // Ticket #163. This sentence was the defect: it promised the
    // installed-state code for `poiesis workspace cleanup` from any cwd, but
    // cleanup proves ownership FIRST and refuses with
    // `WORKSPACE_OWNERSHIP_UNKNOWN` when it cannot.
    expect(readme).not.toContain("`CONFIG_NOT_INSTALLED` for all six");
    expect(readme).toContain("`CONFIG_NOT_INSTALLED` for them too");
  });

  it("documents the ownership-first cleanup precedence and the unchanged precedence inside an owned workspace", () => {
    expect(readme).toContain(CLEANUP_OWNERSHIP_FIRST);
    expect(readme).toContain(CLEANUP_OUTSIDE_OWNED_WORKSPACE);
    expect(readme).toContain(CLEANUP_OWNED_PRECEDENCE);
    expect(readme).toContain(REFUSAL_PRECEDES_SIDE_EFFECTS);
    // The primary checkout is the worked example of a directory that owns no
    // workspace, because it is the one an Author runs commands from.
    expect(readme).toContain("the primary checkout");
  });

  it("documents recognized-remote publishing coordinates including the fork implication", () => {
    expect(readme).toContain(PUBLISH_STATEMENT);
    expect(readme).toContain("PUBLISH_PROVIDER_UNRESOLVED");
    expect(readme).toContain(FORK_STATEMENT);
  });

  it("states that adopting a deferred install changes no AWS workflow, pushes nothing, opens no PR, and deploys nothing", () => {
    expect(readme).toContain("### Onboarding a project with no publishing path (Veritium)");
    expect(readme).toContain(NO_EXISTING_WORKFLOW_STATEMENT);
  });

  it("no longer claims delivery targets are an unconditional install requirement", () => {
    // The old bullet made configured Preview/Staging/Production targets a hard
    // install requirement, which is false for an explicitly deferred install.
    expect(readme).toContain("A configured Preview, Staging, and Production delivery target, or an explicit deferred state");
  });
});

describe("COMPATIBILITY documents the providers", () => {
  const compatibility = readRepoFile("COMPATIBILITY.md");

  it("documents Linear, including the env-only credential and the team coordinate", () => {
    expect(compatibility).toContain("### Linear");
    expect(compatibility).toContain("LINEAR_API_KEY");
    expect(compatibility).toContain("LINEAR_OAUTH_TOKEN");
    expect(compatibility).toContain("Bearer");
    expect(compatibility).toContain("tracker.team");
    expect(compatibility).toContain("never stored in the Poiesis config");
  });

  it("documents Local as a clone-local, network-free production tracker", () => {
    expect(compatibility).toContain("### Local");
    expect(compatibility).toContain("poiesis-tracker-v1");
    expect(compatibility).toContain("no network call");
    expect(compatibility).toContain("no credential");
  });

  it("documents deferred delivery and the recognized-remote publishing rule", () => {
    expect(compatibility).toContain('"mode": "deferred"');
    expect(compatibility).toContain("DELIVERY_DEFERRED");
    expect(compatibility).toContain(PUBLISH_STATEMENT);
    expect(compatibility).toContain(FORK_STATEMENT);
  });

  it("documents the ownership-first cleanup precedence instead of six unconditional installed-state failures", () => {
    // Ticket #163. The compatibility matrix is the reference an integrator
    // reads when wiring an error handler, so it must name the code each
    // operation can actually report and in which order.
    expect(compatibility).not.toContain("the same six operations fail closed with `CONFIG_NOT_INSTALLED`");
    expect(compatibility).toContain(CLEANUP_OWNERSHIP_FIRST);
    expect(compatibility).toContain(CLEANUP_OUTSIDE_OWNED_WORKSPACE);
    expect(compatibility).toContain(CLEANUP_OWNED_PRECEDENCE);
    expect(compatibility).toContain(REFUSAL_PRECEDES_SIDE_EFFECTS);
    expect(compatibility).toContain("WORKSPACE_OWNERSHIP_UNKNOWN");
  });

  it("scopes ownership-first to workspace cleanup and never to publish or integrate", () => {
    // Ticket #163 review F1. The previous sentence here claimed all three
    // workspace-owning operations resolve ownership before they read an
    // installation. That is false for the two commands: `poiesis publish` and
    // `poiesis integrate` run the shared preflight (runtime identity, then the
    // installed state) BEFORE their own ownership check, so from an unowned
    // working directory they report the preflight's installed-state code. An
    // integrator reading the matrix must be able to tell those apart.
    expect(compatibility).not.toContain(
      "`poiesis publish`, `poiesis integrate`, and `poiesis workspace cleanup` each resolve workspace ownership before they read any installation",
    );
    expect(compatibility).toContain(CLEANUP_OWNERSHIP_FIRST_SCOPE);
    // The scope has to be stated once, on the operation it actually describes.
    expect(compatibility).toContain(
      "Only `poiesis workspace cleanup` resolves workspace ownership before it reads an installation",
    );
  });

  it("documents the guard that serializes the canonical lock and is never auto-reclaimed", () => {
    expect(compatibility).toContain("`store.lock.guard`");
    expect(compatibility).toContain("the runtime never reclaims a guard");
    expect(compatibility).toContain("LOCAL_TRACKER_LOCK_TIMEOUT");
  });

  it("documents the ordered operator recovery and the canonical lock it must not name as a removal", () => {
    expect(compatibility).toContain("That error names both paths and the ordered procedure");
    expect(compatibility).toContain(GUARD_RECOVERY_PROCEDURE);
    expect(compatibility).toContain(
      "the canonical `store.lock` is never a removal target, because the ordinary holder-PID and ownership-token check already reclaims a stale one within the bounded wait.",
    );
  });

  it("documents the recovery as prose on a path field, never as a command to run", () => {
    expect(compatibility).toContain(GUARD_RECOVERY_IS_PROSE);
  });

  it("documents the total serialized-store ceiling, the complete snapshot, and the absence of any automatic repair", () => {
    // Spec #139 / ticket #159. These are the sentences an Author reads after
    // `LOCAL_TRACKER_STORE_TOO_LARGE` has refused their store, so they have to
    // say what the ceiling counts, what is refused, and — most importantly —
    // that nothing was pruned and nothing will be repaired for them.
    expect(compatibility).toContain(STORE_CEILING_STATEMENT);
    expect(compatibility).toContain(STORE_COMPLETE_SNAPSHOT_STATEMENT);
    expect(compatibility).toContain(STORE_BOUNDED_READ_STATEMENT);
    expect(compatibility).toContain(STORE_BOUNDED_MUTATION_STATEMENT);
    expect(compatibility).toContain(STORE_NO_AUTOMATIC_REPAIR_STATEMENT);
  });
});

describe("the install layout documents the state a supported install adds", () => {
  const layout = readRepoFile("POIESIS_INSTALL_LAYOUT.md");

  it("places the Local tracker store under the Git common directory, outside every working tree", () => {
    expect(layout).toContain("poiesis-tracker-v1");
    expect(layout).toContain("Git common directory");
    expect(layout).toContain("outside every working tree");
  });

  it("states that a deferred install generates no delivery script and a configured one does", () => {
    expect(layout).toContain("scripts/poiesis-{preview,staging,production}.mjs");
    expect(layout).toContain('A `deferred` install (`"delivery": { "mode": "deferred" }`) generates none of them');
    expect(layout).toContain("poiesis update --config");
  });
});

describe("the canonical config template enumerates the real choices", () => {
  const template = readRepoFile("POIESIS_CONFIG_TEMPLATE.jsonc");

  it("names every supported provider instead of an open placeholder", () => {
    expect(template).not.toContain("<supported-tracker-adapter>");
    for (const provider of ["github", "gitlab", "linear", "local"]) {
      expect(template, `the template must offer the ${provider} tracker`).toContain(provider);
    }
    expect(template).toContain("fixture");
  });

  it("shows the Linear team/project shape and the environment-only credential rule", () => {
    expect(template).toContain('"team"');
    expect(template).toContain("LINEAR_API_KEY");
    expect(template).toContain("LINEAR_OAUTH_TOKEN");
  });

  it("shows the deferred alternative next to the configured targets", () => {
    expect(template).toContain('"mode": "deferred"');
  });
});

describe("the paste-able bootstrap prompt matches the shipped contract", () => {
  it("no longer claims a remote is required to find the tracker", () => {
    // The old prompt said Poiesis "needs a remote to find the ticket tracker",
    // which is false for the Local tracker: its coordinates come from the
    // clone, not from a forge.
    expect(BOOTSTRAP_PROMPT).not.toContain("Poiesis needs a remote to find the");
    expect(BOOTSTRAP_PROMPT).toContain("A remote is only required to find");
  });

  it("offers the Local tracker and the deferred delivery state", () => {
    expect(BOOTSTRAP_PROMPT).toContain("local");
    expect(BOOTSTRAP_PROMPT).toContain("deferred");
  });

  it("does not promise generated delivery scripts for a deferred install", () => {
    expect(BOOTSTRAP_PROMPT).not.toContain("and that generated delivery scripts live in");
    expect(BOOTSTRAP_PROMPT).toContain("A deferred install generates no delivery scripts");
  });
});

/**
 * Ticket #151 — one launcher, one config filename, across the prompt and the
 * docs that surround it.
 *
 * The prompt is the only surface a human hands to an agent and walks away
 * from, so a command in it is copied verbatim and believed. Two defects made
 * that unsafe:
 *
 *   1. Its `init` used the BARE `pnpm dlx poiesis-cli@latest`. pnpm caches
 *      `dlx` resolutions for ~1440 minutes, so a paste-able install command
 *      can silently resolve a stale runtime. The runtime itself already
 *      treats `--config.dlx-cache-max-age=0` as mandatory
 *      (`POIESIS_SCRIPT_COMMAND`), so the prompt was weaker than the contract
 *      it is meant to serve.
 *   2. Its `init` read `./poiesis-install.jsonc` while the later
 *      `update --config` in the same prompt read `./poiesis-config.jsonc` —
 *      and the canon (`POIESIS_METHOD.md` §11) and the README use
 *      `./poiesis-config.jsonc` for both. A human following the prompt
 *      literally ended up with a filename that exists nowhere else.
 *
 * The assertions below therefore pin the launcher to the RUNTIME's own
 * constant rather than to a second literal, so the prompt, the `package.json`
 * script the runtime writes, and the README cannot drift apart.
 */

/** Every command-looking line in the prompt that resolves `@latest`. */
function promptLatestCommandLines(): string[] {
  return BOOTSTRAP_PROMPT.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("pnpm ") && /dlx poiesis-cli@latest\b/.test(line));
}

/** Every `--config <file>` path the prompt passes to a Poiesis command. */
function promptConfigPaths(): string[] {
  // `.jsonc` anchored so the prose mention of a bare `--config` (with no file)
  // is not mistaken for a path.
  return [...BOOTSTRAP_PROMPT.matchAll(/--config (\S*\.jsonc)/g)].map((match) => match[1]!);
}

/** Every documented `--config ./<file>` path in the README. */
function readmeConfigPaths(readme: string): string[] {
  return [...readme.matchAll(/--config (\.\/\S+)/g)].map((match) => match[1]!);
}

describe("the bootstrap prompt uses one canonical fresh-latest launcher", () => {
  it("launches init through the same constant the runtime writes into package.json", () => {
    // `POIESIS_SCRIPT_COMMAND` is the runtime's single source of truth for the
    // fresh-latest `@latest` launcher. If the prompt's own launcher ever stops
    // being that value, the human is told to run something the runtime itself
    // refuses to call canonical.
    expect(POIESIS_SCRIPT_COMMAND).toContain("--config.dlx-cache-max-age=0");
    expect(BOOTSTRAP_PROMPT).toContain(`${POIESIS_SCRIPT_COMMAND} init --config ./poiesis-config.jsonc`);
  });

  it("launches the later delivery-configuration update through the same constant", () => {
    // The turn-delivery-on-later command is printed inside a hand-back bullet.
    // It was line-wrapped across three lines, so even a reader who copied it
    // carefully could reassemble it wrong; the whole command must sit on one
    // line and be byte-identical to the `init` launcher's prefix.
    expect(BOOTSTRAP_PROMPT).toContain(`${POIESIS_SCRIPT_COMMAND} update --config ./poiesis-config.jsonc`);
  });

  it("contains no bare `pnpm dlx poiesis-cli@latest` anywhere in the prompt", () => {
    // Substring, not line-based: a wrapped bare form
    // (`pnpm dlx poiesis-cli@latest` split across lines) must fail too, which
    // a line-prefix check would miss.
    expect(BOOTSTRAP_PROMPT).not.toContain("pnpm dlx poiesis-cli@latest");
  });

  it("has no `@latest` command line that is not the fresh-latest form", () => {
    const lines = promptLatestCommandLines();
    // Sanity: the prompt really does document `@latest` routes (init and the
    // later update). Zero here would mean the contract below is vacuous.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `prompt @latest command must bypass the dlx cache: ${line}`).toMatch(
        /^pnpm --config\.dlx-cache-max-age=0\s+dlx poiesis-cli@latest\b/,
      );
    }
  });
});

describe("the bootstrap prompt names exactly one config file, and so does the README", () => {
  it("no longer names the stale poiesis-install.jsonc", () => {
    // `poiesis-install.jsonc` existed only in this prompt. Nothing else in the
    // product ever wrote or read it.
    expect(BOOTSTRAP_PROMPT).not.toContain("poiesis-install.jsonc");
    expect(readRepoFile("README.md")).not.toContain("poiesis-install.jsonc");
  });

  it("writes, installs from, and later updates the very same file", () => {
    // The file the agent is told to write, the file `init` is told to read, and
    // the file the later `update --config` is told to read must be one FILENAME.
    // Extracting each and comparing is the behaviour: a human following the
    // prompt literally ends up able to configure delivery later without having
    // to guess which of two names is real.
    //
    // `.jsonc`-anchored so the prose mention of a bare `--config` (with no file)
    // in step 3 is not mistaken for a path. The leading `./` is cosmetic (it
    // says "project root"), so it is normalized away rather than pinned —
    // `promptConfigPaths` below pins the exact path on both commands.
    const filename = (match: RegExpExecArray | null): string | undefined => match?.[1]?.replace(/^\.\//, "");
    const written = filename(/Write a file named `([^`]+)`/.exec(BOOTSTRAP_PROMPT));
    const initPath = filename(/\binit --config (\S+\.jsonc)/.exec(BOOTSTRAP_PROMPT));
    const updatePath = filename(/\bupdate --config (\S+\.jsonc)/.exec(BOOTSTRAP_PROMPT));
    expect(written).toBe("poiesis-config.jsonc");
    expect(initPath).toBe(written);
    expect(updatePath).toBe(written);
  });

  it("passes that one filename to every `--config` command in the prompt", () => {
    // A future edit that introduces a second config name fails here instead of
    // shipping. Compared as a SET, so adding one more legitimate
    // `--config <that same file>` command later is not a false alarm.
    const paths = promptConfigPaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set(["./poiesis-config.jsonc"]));
  });

  it("agrees with the README and the canonical Method on that one filename", () => {
    const readme = readRepoFile("README.md");
    const paths = readmeConfigPaths(readme);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set(["./poiesis-config.jsonc"]));
    expect(readme).toContain(`${POIESIS_SCRIPT_COMMAND} init --config ./poiesis-config.jsonc`);
    expect(readme).toContain(`${POIESIS_SCRIPT_COMMAND} update --config ./poiesis-config.jsonc`);
    // The canon names the same file for the later delivery configuration, so
    // the prompt is following the Method rather than inventing a name.
    expect(readRepoFile("POIESIS_METHOD.md")).toContain("poiesis update --config ./poiesis-config.jsonc");
  });
});

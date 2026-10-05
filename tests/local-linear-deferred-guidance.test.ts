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
    // The hard stop is a property of the operation, not of check ordering:
    // publish can refuse one step earlier, and the canon must say so rather
    // than promise a code it cannot always reach.
    expect(method).toContain("may refuse one step earlier with `PUBLISH_PROVIDER_UNRESOLVED`");
    expect(method).toContain("no push, no fetch, no remote revalidation, no change request, and no delivery evidence");
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
    // reach: publish resolves its coordinates first.
    expect(readme).toContain("refuses one step earlier with `PUBLISH_PROVIDER_UNRESOLVED`");
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

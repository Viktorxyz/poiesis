/**
 * Spec #138: a single paste-able prompt that installs Poiesis.
 *
 * The Author asked for one thing they can hand to any agent and walk away.
 * The prompt has to be complete on its own, because the agent reading it has
 * none of our context, and it has to end by telling the human what to do -
 * an agent that installs and then stops talking has not finished the job.
 */
export const BOOTSTRAP_PROMPT = `# Install Poiesis into this project

You are installing Poiesis, a deterministic runtime for turning intent into
working, proven software. The human wants the installation to just work.
Their only remaining decisions are which models to use, where the tracker
keeps the Spec and tickets, and whether delivery is configured now or
deferred.

Do this, in order. Do not ask the human anything except the tracker and
delivery questions in step 3 and the two model questions in step 4.

## 1. Check the environment

Run each and note what is missing:

    git --version
    gh auth status
    opencode --version
    command -v uv

If \`uv\` is missing, install it now:

    curl -LsSf https://astral.sh/uv/install.sh | sh

If \`gh\` is not authenticated, tell the human to run \`gh auth login\` yourself -
never attempt to authenticate on their behalf.

## 2. Make sure this is a git repository with a remote

    git rev-parse --git-dir

If there is no remote, ask the human whether to create one with
\`gh repo create\` before continuing. A remote is only required to find the
publishing destination and the integration branch, and Poiesis reads both
from it. It is NOT required to find the tracker: a project can record its
Spec and tickets in its own clone with the \`local\` tracker, which needs no
remote, no service, and no network.

## 3. Ask the human the tracker and delivery questions

The tracker choice and the delivery choice are independent. Ask both, then
ask the two model questions.

Tracker — offer exactly these four:

  - \`github\` or \`gitlab\` — a forge repository, addressed by
    \`<owner>/<repository>\`, operated through the authenticated \`gh\` or
    \`glab\` CLI.
  - \`linear\` — a Linear team. Ask for the team key or name (required) and
    optionally a project. The credential comes from the environment only:
    exactly one of \`LINEAR_API_KEY\` (sent raw) or \`LINEAR_OAUTH_TOKEN\`
    (sent as a \`Bearer\` token). Never ask the human to paste a credential
    into a config file, and never write one into one.
  - \`local\` — clone-local. Spec and ticket state lives in
    \`poiesis-tracker-v1\` beneath the Git common directory, outside every
    working tree, with no network call, no CLI, and no credential.

Delivery — ask whether to configure it now or defer it. A deferred
install is a healthy state, not an error: the lifecycle runs normally up to
and including Proof, then stops before anything leaves the project. It
pushes nothing, opens no pull or merge request, and deploys nothing, so it
never disturbs an existing deployment workflow. It can be turned on later
with \`poiesis update --config\`.

## 4. Ask only the two model questions

Ask the human:

  - Which model should do the reasoning work (planning, review, decisions)?
  - Which model should do the execution work (implementation, exploration)?

Read the available models with:

    opencode models

Only offer models that appear in that list. If the human is unsure, suggest
the strongest available model for reasoning and a fast one for execution.

## 5. Install

Write a file named \`./poiesis-config.jsonc\` with ONLY the models and the
answers from step 3 — do not hand-write delivery commands, repository, or
verification blocks. Poiesis infers the rest:

    {
      "schema": 1,
      "models": {
        "reasoning": "<their reasoning model>",
        "execution": "<their execution model>"
      },
      "tracker": { "provider": "local" },
      "delivery": { "mode": "deferred" }
    }

Swap \`tracker\` for \`{ "provider": "github", "project": "owner/repo" }\`,
\`{ "provider": "gitlab", "project": "group/project" }\`, or
\`{ "provider": "linear", "team": "<team key or name>" }\` when the human
chose one of those. Swap \`delivery\` for the complete Preview, Staging, and
Production command targets when the human chose configured delivery.

Then run:

    pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest init --config ./poiesis-config.jsonc

Copy that command exactly. The \`--config.dlx-cache-max-age=0\` flag is what
makes \`@latest\` mean *now* instead of a pnpm cache entry up to 1440 minutes
old, so never drop it from any Poiesis command you run.

If it fails, read the error code. Most failures are a missing prerequisite
from step 1, not a bug. Fix the prerequisite and re-run the same command.

## 6. Verify and hand back

Run:

    pnpm poiesis doctor

Then tell the human, in plain language:

  - That Poiesis is installed, and that the project now has a \`pnpm poiesis\`
    command they can use for everything.
  - The one thing they must do themselves: restart OpenCode.
  - That they can verify with \`pnpm poiesis doctor\`.
  - What was inferred for them (integration branch, verification commands)
    and which tracker and delivery state were recorded.
  - For configured delivery: generated delivery scripts live in \`scripts/\`
    and are theirs to edit.
  - A deferred install generates no delivery scripts, because there is
    nothing to run.
  - If the lifecycle is deferred: that work runs locally through Proof and
    then stops before Publish, and that \`pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@latest update --config ./poiesis-config.jsonc\`
    is how they turn delivery on later. It is the same config file the
    install used.

Do not claim anything you have not seen in command output.`;

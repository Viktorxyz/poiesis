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
Their only remaining decision is which models to use.

Do this, in order. Do not ask the human anything except the two model
questions in step 3.

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
\`gh repo create\` before continuing. Poiesis needs a remote to find the
ticket tracker and the integration branch, and infers both from it.

## 3. Ask only the two model questions

Ask the human:

  - Which model should do the reasoning work (planning, review, decisions)?
  - Which model should do the execution work (implementation, exploration)?

Read the available models with:

    opencode models

Only offer models that appear in that list. If the human is unsure, suggest
the strongest available model for reasoning and a fast one for execution.

## 4. Install

Ask the human ONE question first: private/local or team/shared. Then write a
config file with ONLY that mode and the models - do not hand-write delivery
commands, tracker, repository, or verification blocks. Poiesis infers all of
them:

    {
      "schema": 1,
      "mode": "private",
      "models": {
        "reasoning": "<their reasoning model>",
        "execution": "<their execution model>"
      }
    }

The mode is never inferred. If the human does not answer, stop and ask again
rather than choosing for them.

Then run:

    pnpm dlx poiesis-cli@latest init --config ./poiesis-install.jsonc

If it fails, read the error code. Most failures are a missing prerequisite
from step 1, not a bug. Fix the prerequisite and re-run the same command.

## 5. Verify and hand back

Run:

    poiesis doctor

Then tell the human, in plain language:

  - That Poiesis is installed in the mode the human chose, and that every
    command runs as \`poiesis <command>\` with no package.json script added.
  - The one thing they must do themselves: restart OpenCode.
  - That they can verify with \`poiesis doctor\`.
  - That one marked block in \`.gitignore\` is the only Poiesis surface Git
    sees, and that \`package.json\` was not modified.
  - What was inferred for them (tracker, integration branch, verification
    commands) and that generated delivery scripts live in \`scripts/\` and are
    theirs to edit.

Do not claim anything you have not seen in command output.`;

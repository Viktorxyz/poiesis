/**
 * Interactive `poiesis model` (ticket #59).
 *
 * Flagless interactive flow that lets the Author change exactly one
 * model slot at a time. Mirrors the `poiesis init` interactive
 * discipline:
 *
 *   1. Refuse non-TTY invocations (`NON_TTY_MODEL`). Operators in a
 *      non-interactive environment must use the deterministic
 *      `poiesis model set reasoning|execution <provider/model>`
 *      subcommand instead.
 *   2. Refuse when Poiesis is not installed in the repo
 *      (`MODEL_NOT_INSTALLED`). The interactive flow must NOT install
 *      Poiesis for the Author — it only mutates an already-installed
 *      config.
 *   3. Print the current reasoning and execution model identities on
 *      stderr so the Author sees what they are about to change.
 *   4. Probe the live OpenCode model inventory via `opencode models`.
 *      Empty inventory fails closed with `MODEL_INVENTORY_UNAVAILABLE`
 *      — no silent fallback.
 *   5. Ask the Author which slot to change (`reasoning` or `execution`).
 *      Anything else fails closed with `INVALID_MODEL_CLASS` BEFORE the
 *      model selector runs. Exactly one slot changes per run.
 *   6. Run the shared `runModelSelector` for the chosen class with the
 *      live inventory and the canonical recommended constants. The
 *      selector's policy is identical to `poiesis init`'s.
 *   7. Hand the chosen identity to the existing `setModel` (which in
 *      turn routes through `updateFromConfig`). All transactional
 *      invariants (no-op detection, doctor gate, fail-closed rollback)
 *      stay the single source of truth.
 *   8. After success, print a restart notice on stderr; Poiesis does
 *      NOT restart OpenCode.
 *
 * Design contract:
 *   - Every I/O operation goes through `InteractiveModelIO`. Tests
 *     drive the flow with scripted prompts, scripted model selections,
 *     and a scripted inventory; production wires the seam to
 *     `process.stdin` / `process.stderr` and the real `opencode models`
 *     call. No PTY is required.
 *   - The module never invents a default model. Empty inventory, an
 *     out-of-band class name, or a selector cancellation all fail
 *     closed through typed `PoiesisError`s.
 *   - The module never restarts OpenCode on the Author's behalf.
 */
import { PoiesisError } from "./errors.js";
import { loadConfig } from "./config.js";
import { setModel, parseOpenCodeModelInventory, type ModelClassName, type SetModelResult } from "./maintenance.js";
import { loadManifest } from "./manifest.js";
import {
  DEFAULT_RECOMMENDED_MODEL_IDS,
  createProductionModelSelectorIO,
  runModelSelector,
  type ModelClass,
  type ModelIdentity,
  type ModelSelectorIO,
} from "./model-selector.js";
import { settleOnceLinePrompt } from "./prompt-line.js";
import { run as runChildProcess } from "./process.js";

export type { ModelClass, ModelIdentity };

export interface ModelSelection {
  readonly modelClass: ModelClass;
  readonly inventory: readonly string[];
  readonly recommended: { reasoning: ModelIdentity; execution: ModelIdentity };
}

export interface CurrentModels {
  readonly reasoning: ModelIdentity;
  readonly execution: ModelIdentity;
}

export interface InteractiveModelIO {
  readonly isTTY: boolean;
  writeStderr(line: string): void;
  /**
   * One-line prompt. The interactive flow calls this exactly once per
   * invocation: to ask which class (reasoning|execution) the Author
   * wants to change.
   */
  promptLine(prompt: string): Promise<string>;
  listOpenCodeModels(): Promise<readonly string[]>;
  runModelSelector(selection: ModelSelection): Promise<string>;
  /**
   * Read the currently-installed Poiesis config and return the two
   * model class identities. The interactive flow does NOT call this
   * itself — tests inject it so the IO seam stays the only entry point
   * to the filesystem.
   */
  loadCurrentModels(): Promise<CurrentModels>;
}

export interface InteractiveModelOptions {
  root: string;
  io: InteractiveModelIO;
}

const MODEL_CLASSES: ReadonlyArray<ModelClass> = ["reasoning", "execution"];

function isModelClass(value: string): value is ModelClass {
  return value === "reasoning" || value === "execution";
}

/**
 * Probe the OpenCode model inventory through the IO seam. Empty result
 * is a selector failure (Poiesis cannot offer a selection from nothing)
 * and surfaces through `runModelSelector`'s `MODEL_SELECTOR_NO_INVENTORY`.
 * We surface the empty case as `MODEL_INVENTORY_UNAVAILABLE` so the
 * CLI error matches `poiesis model set`'s pre-write inventory probe.
 */
async function probeInventory(io: InteractiveModelIO): Promise<readonly ModelIdentity[]> {
  const inventory = await io.listOpenCodeModels();
  if (inventory.length === 0) {
    throw new PoiesisError(
      "MODEL_INVENTORY_UNAVAILABLE",
      "OpenCode model inventory is empty; cannot offer a selection",
      {},
    );
  }
  return inventory;
}

function formatCurrentModelsFrame(current: CurrentModels): string {
  return [
    "Poiesis model: currently configured",
    `  reasoning: ${current.reasoning}`,
    `  execution: ${current.execution}`,
    "",
  ].join("\n");
}

function formatClassPrompt(): string {
  return "Which model class would you like to change? [reasoning/execution]";
}

function formatRestartNotice(): string {
  return [
    "",
    "Poiesis model update succeeded.",
    "Restart OpenCode to apply the new model configuration.",
    "Poiesis did not restart OpenCode; you must do that yourself.",
    "",
  ].join("\n");
}

/**
 * Run the interactive `poiesis model` flow. Returns the
 * `SetModelResult` from the underlying `setModel` transaction.
 *
 * Failure modes (always `PoiesisError`):
 *   - `NON_TTY_MODEL`               -- `io.isTTY === false`
 *   - `MODEL_NOT_INSTALLED`         -- Poiesis is not installed at `root`
 *   - `INVALID_MODEL_CLASS`         -- class answer is not reasoning|execution
 *   - `MODEL_INVENTORY_UNAVAILABLE` -- `opencode models` returned an empty list
 *   - `MODEL_SELECTOR_CANCELLED`    -- user cancelled the selector (Esc / q)
 *   - `MODEL_SELECTOR_NOT_TTY`      -- selector IO reports non-TTY (defensive)
 *   - `MODEL_SELECTOR_NO_INVENTORY` -- normalized inventory is empty (defensive)
 */
export async function runInteractiveModel(args: InteractiveModelOptions): Promise<SetModelResult> {
  if (!args.io.isTTY) {
    throw new PoiesisError(
      "NON_TTY_MODEL",
      "poiesis model without a subcommand requires an interactive TTY; use `poiesis model set reasoning|execution <provider/model>` for non-interactive use",
      {
        hint: "use `poiesis model set reasoning|execution <provider/model>`",
      },
    );
  }

  await refuseIfNotInstalled(args.root);

  const current = await args.io.loadCurrentModels();
  args.io.writeStderr(formatCurrentModelsFrame(current));

  const inventory = await probeInventory(args.io);

  const classAnswer = (await args.io.promptLine(formatClassPrompt())).trim();
  if (!isModelClass(classAnswer)) {
    throw new PoiesisError(
      "INVALID_MODEL_CLASS",
      `Unknown model class: ${classAnswer}`,
      { className: classAnswer, supported: [...MODEL_CLASSES] },
    );
  }
  const chosen = await args.io.runModelSelector({
    modelClass: classAnswer,
    inventory,
    recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
  });
  const result = await setModel(args.root, classAnswer as ModelClassName, chosen);
  args.io.writeStderr(formatRestartNotice());
  return result;
}

/**
 * Refuse the interactive flow when Poiesis is not installed at `root`.
 * Mirrors `refuseIfAlreadyInstalled` in `init-interactive.ts`: the
 * check runs BEFORE any prompt or selector so we never start asking the
 * Author for choices in a repo that has no Poiesis install. Any
 * manifest other than a missing file is treated as "installed"
 * (defensive — the real failure modes surface inside the transaction).
 */
async function refuseIfNotInstalled(root: string): Promise<void> {
  try {
    await loadManifest(root);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    // `readUtf8` (used by `loadManifest`) surfaces a missing manifest as
    // an `ENOENT` thrown by `node:fs/promises`. Anything that looks
    // like "file missing" means Poiesis is not installed here.
    if (code === "ENOENT" || code === "MANIFEST_MISSING" || /ENOENT/.test(message)) {
      throw new PoiesisError(
        "MODEL_NOT_INSTALLED",
        "Poiesis is not installed in this repository; run `poiesis init` first",
        { hint: "run `poiesis init` (or pass `poiesis init --config <path>`) before using `poiesis model`" },
      );
    }
    throw error;
  }
}

/**
 * Production IO factory. Wires the interactive model flow to
 * `process.stdin` / `process.stderr` so the typical CLI invocation
 * stays a single-argument call site. The shared model-selector IO is
 * delegated to `createProductionModelSelectorIO` so the keypress loop
 * is reused byte-for-byte with `poiesis init`.
 *
 * The factory takes the resolved repository `root` (git toplevel of the
 * repo the Author is editing) so every filesystem-touching seam —
 * `loadConfig` and the `opencode models` child process — reads from
 * the SAME root the transactional `setModel` write path uses. Bare
 * `process.cwd()` would let the interactive flow see one repo while the
 * mutation sees another when `poiesis model --cwd <path>` lands the CLI
 * in a subdirectory of a different repo.
 *
 * `loadCurrentModels` reads the on-disk `.poiesis/config.jsonc` via
 * the maintenance surface; a missing file surfaces as the same typed
 * error the CLI would otherwise raise, so operators see a consistent
 * failure shape regardless of who reads the bytes.
 */
export function createProductionInteractiveModelIO(root: string): InteractiveModelIO {
  const stdin = process.stdin;
  const stderr = process.stderr;
  const isTTY = Boolean((stdin as { isTTY?: boolean }).isTTY);

  return {
    isTTY,
    writeStderr(line: string): void {
      stderr.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    async promptLine(prompt: string): Promise<string> {
      // Ticket #68: the production prompt is now a thin adapter over the
      // CLI-internal settle-once readline helper. The helper owns the
      // settle-once invariant (resolve or reject, never both, never
      // neither) so the factory stays a binding seam for stdin / stderr
      // and the distinct `MODEL_PROMPT_CANCELLED` cancellation error.
      // Callers still `.trim()` the returned raw line themselves.
      return await settleOnceLinePrompt({
        prompt,
        input: stdin,
        output: stderr,
        isTTY,
        cancellationError: new PoiesisError(
          "MODEL_PROMPT_CANCELLED",
          "Interactive model prompt was cancelled by the user",
          { prompt },
        ),
      });
    },
    async listOpenCodeModels(): Promise<readonly string[]> {
      // Run `opencode models` from the repo root, NOT `process.cwd()`.
      // CLI dispatch lands here when the Author passes
      // `poiesis model --cwd <path>` from any subdirectory of the repo;
      // the opencode config (`opencode.jsonc`) lives at the repo root,
      // so a child process spawned from a sub-cwd could see a different
      // (or no) OpenCode installation.
      const result = await runChildProcess("opencode", ["models"], { cwd: root, allowFailure: true });
      if (result.exitCode !== 0) {
        throw new PoiesisError(
          "MODEL_INVENTORY_UNAVAILABLE",
          "OpenCode model inventory is unavailable",
          { stderr: result.stderr },
        );
      }
      return [...parseOpenCodeModelInventory(result.stdout)];
    },
    async runModelSelector(selection: ModelSelection): Promise<string> {
      const io: ModelSelectorIO = createProductionModelSelectorIO();
      return await runModelSelector({
        io,
        inventory: selection.inventory,
        recommended: selection.recommended,
        modelClass: selection.modelClass,
      });
    },
    async loadCurrentModels(): Promise<CurrentModels> {
      // `loadConfig` reads `.poiesis/config.jsonc` and validates the
      // bytes against the canonical schema. It throws when the file is
      // missing or the schema fails — the CLI layer translates that
      // into the typed `MODEL_NOT_INSTALLED` it would have raised
      // anyway, so the production IO seam stays a thin read. Read from
      // `root` (the git toplevel) so the config we render matches the
      // config `setModel` writes.
      const config = await loadConfig(root);
      return { reasoning: config.models.reasoning, execution: config.models.execution };
    },
  };
}

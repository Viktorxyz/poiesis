/**
 * Interactive `poiesis model` (ticket #59, ticket #73, ticket #76).
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
 *   3. Read the currently-installed Poiesis config and print the
 *      current reasoning and execution model identities on stderr so
 *      the Author sees what they are about to change.
 *   4. Ask the Author which slot to change (`reasoning` or `execution`)
 *      through the shared Clack-backed class selector. The current
 *      reasoning / execution identity is shown in each option's hint so
 *      the operator sees the values they are choosing between. Anything
 *      else fails closed with `MODEL_CLASS_SELECTOR_CANCELLED` if the
 *      Author pressed Esc / Ctrl+C, or `INVALID_MODEL_CLASS` if a
 *      custom IO seam returned a non-class answer.
 *   5. Probe the live OpenCode model inventory via `opencode models`.
 *      ticket #76 reordered this step to AFTER the class selector so a
 *      class-selector cancellation (or an out-of-band class answer)
 *      short-circuits BEFORE the `opencode models` subprocess runs.
 *      Empty inventory still fails closed with
 *      `MODEL_INVENTORY_UNAVAILABLE` — no silent fallback.
 *   6. Run the shared `runModelSelector` for the chosen class with the
 *      live inventory, the canonical recommended constants, and the
 *      currently installed identity (so the hint marks "Current" /
 *      "Recommended" / "Current, Recommended" and the cursor lands on
 *      that row first). The selector's policy is identical to
 *      `poiesis init`'s.
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
 *   - The class selector and the identity selector are the SAME
 *     primitive (`@clack/prompts` `select` via the CLI-internal
 *     `runClackSelect` adapter). There is no second mini-TUI.
 *   - ticket #76: the inventory probe runs AFTER the class selector,
 *     not before. Class-selector cancellation (or an invalid class
 *     answer) must cause ZERO inventory probes and ZERO mutation; the
 *     `finally` block still releases the input resource on every code
 *     path.
 */
import { PoiesisError } from "./errors.js";
import { loadConfig } from "./config.js";
import { setModel, parseOpenCodeModelInventory, type ModelClassName, type SetModelResult } from "./maintenance.js";
import { loadManifest } from "./manifest.js";
import {
  DEFAULT_RECOMMENDED_MODEL_IDS,
  runModelSelector,
  type ModelClass,
  type ModelIdentity,
} from "./model-selector.js";
import { runClackSelect } from "./clack-select.js";
import { run as runChildProcess } from "./process.js";

export type { ModelClass, ModelIdentity };

export interface ModelSelection {
  readonly modelClass: ModelClass;
  readonly inventory: readonly string[];
  readonly recommended: { reasoning: ModelIdentity; execution: ModelIdentity };
  readonly currentIdentity: ModelIdentity | null;
}

export interface CurrentModels {
  readonly reasoning: ModelIdentity;
  readonly execution: ModelIdentity;
}

/**
 * Class-selector result type used by `InteractiveModelIO.runModelClassSelector`.
 * The two values mirror the canonical `ModelClass` set. Returning a
 * different string from the IO seam surfaces as `INVALID_MODEL_CLASS`,
 * so the seam cannot smuggle an out-of-band class through the selector.
 */
export type ModelClassChoice = ModelClass;

export interface InteractiveModelIO {
  readonly isTTY: boolean;
  writeStderr(line: string): void;
  listOpenCodeModels(): Promise<readonly string[]>;
  runModelClassSelector(args: {
    readonly current: CurrentModels;
    readonly cancelError: PoiesisError;
  }): Promise<ModelClassChoice>;
  runModelSelector(selection: ModelSelection): Promise<string>;
  /**
   * Read the currently-installed Poiesis config and return the two
   * model class identities. The interactive flow does NOT call this
   * itself — tests inject it so the IO seam stays the only entry point
   * to the filesystem.
   */
  loadCurrentModels(): Promise<CurrentModels>;
  /**
   * Flow-scoped resource release (ticket #75). The interactive flow
   * invokes this exactly once from a `finally` block on every code
   * path (success, typed cancellation, and unexpected throw) so the
   * underlying `process.stdin` cannot keep the event loop alive after
   * the flow settles. Tests supply a counter; the production factory
   * pauses and unrefs `process.stdin`.
   */
  releaseStdin?(): void;
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

function formatRestartNotice(args: {
  readonly modelClass: ModelClass;
  readonly previous: ModelIdentity;
  readonly current: ModelIdentity;
}): string {
  return [
    "",
    "Poiesis model update succeeded.",
    `  class:    ${args.modelClass}`,
    `  previous: ${args.previous}`,
    `  current:  ${args.current}`,
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
 *   - `INVALID_MODEL_CLASS`         -- the IO seam returned a non-class answer (defensive)
 *   - `MODEL_INVENTORY_UNAVAILABLE` -- `opencode models` returned an empty list
 *   - `MODEL_SELECTOR_CANCELLED`    -- user cancelled the identity selector (Esc / Ctrl+C)
 *   - `MODEL_CLASS_SELECTOR_CANCELLED` -- user cancelled the class selector (Esc / Ctrl+C)
 *   - `MODEL_SELECTOR_NOT_TTY`      -- selector IO reports non-TTY (defensive)
 *   - `MODEL_SELECTOR_NO_INVENTORY` -- normalized inventory is empty (defensive)
 */
export async function runInteractiveModel(args: InteractiveModelOptions): Promise<SetModelResult> {
  try {
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

    // ticket #76: the class selector runs BEFORE the inventory
    // probe. The class selector only needs the operator's current
    // identities (already loaded above) to render its hints, so the
    // inventory subprocess is unnecessary until the Author has chosen
    // a class. Cancelling or returning an invalid class short-circuits
    // here with zero inventory probes and zero mutation; the finally
    // block below still releases the input resource.
    const classAnswer = await args.io.runModelClassSelector({
      current,
      cancelError: new PoiesisError(
        "MODEL_CLASS_SELECTOR_CANCELLED",
        "Interactive model class selector was cancelled by the user",
        {},
      ),
    });
    if (!isModelClass(classAnswer)) {
      throw new PoiesisError(
        "INVALID_MODEL_CLASS",
        `Unknown model class: ${classAnswer}`,
        { className: classAnswer, supported: [...MODEL_CLASSES] },
      );
    }
    // ticket #76: inventory discovery happens AFTER class selection.
    // Empty inventory fails closed with `MODEL_INVENTORY_UNAVAILABLE`
    // — no silent fallback — and the finally block still releases the
    // input resource on that error path.
    const inventory = await probeInventory(args.io);
    const chosen = await args.io.runModelSelector({
      modelClass: classAnswer,
      inventory,
      recommended: DEFAULT_RECOMMENDED_MODEL_IDS,
      currentIdentity: current[classAnswer],
    });
    const result = await setModel(args.root, classAnswer as ModelClassName, chosen);
    // Probe the OpenCode adapter contract to emit the "newer than
    // latest certified compatibility" notice when the operator is on
    // an unrecognized patch version. The capability probe here is
    // independent of the safety probes `setModel` already ran
    // because the warning is a UI concern, not a safety boundary —
    // the underlying mutation has already succeeded by this point.
    const { probeOpenCodeAdapterContract, CERTIFIED_OPENCODE_VERSIONS } = await import("./opencode.js");
    const contract = await probeOpenCodeAdapterContract(args.root);
    if (!contract.certified) {
      args.io.writeStderr(
        `Warning: OpenCode ${contract.installed} has not yet been certified by this Poiesis release.\n` +
        `Latest certified compatibility: ${CERTIFIED_OPENCODE_VERSIONS[CERTIFIED_OPENCODE_VERSIONS.length - 1]}.\n` +
        `Poiesis proceeded because the capability probe passed; restart OpenCode to load the change.`,
      );
    }
    args.io.writeStderr(formatRestartNotice({
      modelClass: classAnswer,
      previous: current[classAnswer],
      current: chosen,
    }));
    return result;
  } finally {
    // Ticket #75: flow-scoped resource release. The interactive flow
    // pauses and unrefs `process.stdin` on every code path so the Node
    // process can exit naturally after success or cancellation; without
    // this, Clack's last `select` leaves stdin resumed and the event
    // loop waits forever for keypress data. Tests that drive the flow
    // with scripted IO leave `releaseStdin` undefined. Ticket #76
    // preserves this on the new class-before-inventory ordering.
    args.io.releaseStdin?.();
  }
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
 * stays a single-argument call site. The class selector and the
 * shared identity selector are both routed through the CLI-internal
 * Clack adapter (`src/clack-select.ts`) so there is exactly one
 * interactive list primitive in the CLI.
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
  // Ticket #75: flow-scoped stdin release. Idempotent and
  // defensive — Clack's last `select()` resumes stdin in its `finally`
  // block (tickets #71 / #73) so the next interactive seam can run; at
  // the very end of the interactive flow we want the inverse: pause
  // the stream (so it stops pulling data) and unref it from the event
  // loop (so a still-open stdin cannot keep the process alive).
  let released = false;
  const releaseStdin = (): void => {
    if (released) return;
    released = true;
    if (typeof stdin.pause === "function" && (stdin as { readableEnded?: boolean }).readableEnded !== true && (stdin as { destroyed?: boolean }).destroyed !== true) {
      try {
        stdin.pause();
      } catch {
        // Defensive: pause() can surface stream-state errors; the
        // `unref()` below is the canonical "do not keep the event
        // loop alive" call, so swallowing pause() failures does not
        // weaken the release contract.
      }
    }
    if (typeof stdin.unref === "function") {
      try {
        stdin.unref();
      } catch {
        // Same defensive posture: unref() can throw on a non-standard
        // stream, and we never want a release failure to propagate.
      }
    }
  };

  return {
    isTTY,
    writeStderr(line: string): void {
      stderr.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    releaseStdin,
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
    async runModelClassSelector(args): Promise<ModelClassChoice> {
      // The class selector and the identity selector are the same
      // primitive: Clack `select` via the CLI-internal adapter. The
      // hint carries the operator's currently installed value so the
      // choice is informed. Both classes are always installed, so the
      // cursor defaults to `reasoning` — the row the operator most
      // often wants — while the hint still shows both current
      // identities.
      return await runClackSelect<ModelClassChoice>({
        message: "Which model class would you like to change?",
        options: [
          {
            value: "reasoning",
            label: "Reasoning",
            hint: `Current: ${args.current.reasoning}`,
          },
          {
            value: "execution",
            label: "Execution",
            hint: `Current: ${args.current.execution}`,
          },
        ],
        initialValue: "reasoning",
        cancelError: args.cancelError,
      });
    },
    async runModelSelector(selection: ModelSelection): Promise<string> {
      return await runModelSelector({
        inventory: selection.inventory,
        recommended: selection.recommended,
        modelClass: selection.modelClass,
        currentIdentity: selection.currentIdentity,
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
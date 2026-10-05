/**
 * Spec #139 / ticket #143 — the central lifecycle-policy guard for explicit
 * deferred delivery, and ticket #152 — the installed-state guard for the same
 * six operations.
 *
 * `{ "delivery": { "mode": "deferred" } }` is an honest state, not a defect:
 * the project keeps its real work local. So the guard's rule is precise
 * about what deferral blocks. Local production of work is unaffected —
 * `workspace prepare`, tracker operations, `checkpoint` (and therefore the
 * accepted Review it records), `verify`, `inspect`, `update`, `doctor`, and
 * Review all stay usable, which is what lets a deferred installation reach
 * exact-candidate Proof. Everything that would deliver that work outward is
 * refused: `publish`, `preview`, `promote --target staging`,
 * `promote --target production`, `integrate`, and `workspace cleanup`.
 *
 * This module is the SINGLE place that answers that question, and it answers
 * it from the authorized installed config alone: it reads
 * `<root>/.poiesis/config.jsonc` and nothing else. It deliberately does not
 * run config auto-resolution, remote discovery, `ls-remote`, tracker auth, or
 * any other subprocess, so deciding the policy can never itself touch the
 * network or a remote. A malformed installed delivery block is NOT a bypass:
 * `loadConfig` surfaces its own typed `INVALID_DELIVERY_CONFIG` failure, which
 * fails the gated operation closed.
 *
 * Ticket #152 — the same single place also decides the INSTALLED STATE. A
 * guarded operation runs only in a project Poiesis actually installed, and
 * the evidence of that installation is the pair (manifest, installed config):
 * the runtime identity guard has already confirmed the manifest exists and its
 * recorded version equals the running runtime, so an absent
 * `.poiesis/config.jsonc` is not an exemption but an incomplete install. It
 * therefore fails closed with a typed `CONFIG_NOT_INSTALLED` — before any
 * caller-supplied delivery config is constructed into an adapter, and before
 * the first side effect. Manifest absence keeps its existing precedence: the
 * runtime identity guard refuses first with `RUNTIME_VERSION_MISMATCH`, so an
 * uninstalled project keeps reporting the failure an Author already knows.
 *
 * Callers pass the root that owns the installed config (the ownership
 * marker's `repositoryRoot` for the Git lifecycle seams), call the guard
 * before their first side effect, and report the operation by its canonical
 * CLI name. The refusals are typed `DELIVERY_DEFERRED` / `CONFIG_NOT_INSTALLED`
 * errors carrying that operation and the remediation, so a failure is
 * actionable without reading this file.
 */
import { deliveryDeferredError, isDeferredDelivery, loadConfig } from "./config.js";
import { PoiesisError } from "./errors.js";
import { exists } from "./fs.js";
import { poiesisPath } from "./paths.js";

/**
 * The operations deferral blocks. Each one is a delivery-integrated mutation:
 * it would push, fetch, revalidate a remote, run a delivery subprocess, build
 * an integration commit, delete a remote branch, remove the owned worktree,
 * or produce delivery evidence.
 */
export const DEFERRED_BLOCKED_OPERATIONS = [
  "poiesis publish",
  "poiesis preview",
  "poiesis promote --target staging",
  "poiesis promote --target production",
  "poiesis integrate",
  "poiesis workspace cleanup",
] as const;

export type DeferredBlockedOperation = (typeof DEFERRED_BLOCKED_OPERATIONS)[number];

/**
 * Ticket #152 — the remediation every `CONFIG_NOT_INSTALLED` failure names.
 * The installed config is a managed artifact, so it is restored through the
 * managed flows (`poiesis init`, or the receipt-gated `poiesis update
 * --config <file>`), never by hand.
 */
export const CONFIG_NOT_INSTALLED_REMEDIATION =
  "Restore the installed Poiesis config at .poiesis/config.jsonc by running `poiesis init` in this project, " +
  "or re-apply a known-good config with `poiesis update --config <file>`; until then this operation stays blocked.";

/**
 * Ticket #152 — the one typed installed-state failure. A guarded operation
 * reached a project the runtime identity guard accepted (manifest present,
 * version matched) but with no installed config, so nothing is known about
 * its delivery state. The failure names the missing managed path, the
 * blocked operation, and the managed remediation.
 */
export function configNotInstalledError(configPath: string, operation: string): PoiesisError {
  return new PoiesisError(
    "CONFIG_NOT_INSTALLED",
    `Poiesis is not installed in this project: no installed config at ${configPath}; ${operation} cannot run until it is restored`,
    { operation, path: configPath, remediation: CONFIG_NOT_INSTALLED_REMEDIATION },
  );
}

/**
 * Assert the installed state and delivery policy permit `operation`.
 *
 * Fails closed with `CONFIG_NOT_INSTALLED` when the project has no installed
 * `.poiesis/config.jsonc`: by the time a gated seam reaches this guard, the
 * runtime identity guard has already established that the project IS an
 * installation, so an absent config is a broken installed state rather than a
 * project that may proceed. Throws `DELIVERY_DEFERRED` when the installed
 * config states the deferred mode. Resolves when the installed config states
 * a configured (or legacy omitted) delivery block.
 */
export async function assertDeliveryPolicyAllows(root: string, operation: DeferredBlockedOperation | string): Promise<void> {
  const configPath = poiesisPath(root, "config.jsonc");
  if (!(await exists(configPath))) throw configNotInstalledError(configPath, operation);
  const config = await loadConfig(root);
  if (!isDeferredDelivery(config.delivery)) return;
  throw deliveryDeferredError(operation);
}

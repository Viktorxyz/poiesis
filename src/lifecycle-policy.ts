/**
 * Spec #139 / ticket #143 — the central lifecycle-policy guard for explicit
 * deferred delivery.
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
 * Callers pass the root that owns the installed config (the ownership
 * marker's `repositoryRoot` for the Git lifecycle seams), call the guard
 * before their first side effect, and report the operation by its canonical
 * CLI name. The refusal is a typed `DELIVERY_DEFERRED` carrying that
 * operation and the remediation, so the failure is actionable without
 * reading this file.
 */
import { deliveryDeferredError, isDeferredDelivery, loadConfig } from "./config.js";
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
 * Assert the installed delivery policy permits `operation`.
 *
 * Resolves when delivery is configured — or when the project has no installed
 * config at all, because an uninstalled project is already refused closed by
 * the runtime identity guard every gated seam already runs. Throws
 * `DELIVERY_DEFERRED` when the installed config states the deferred mode.
 */
export async function assertDeliveryPolicyAllows(root: string, operation: DeferredBlockedOperation | string): Promise<void> {
  if (!(await exists(poiesisPath(root, "config.jsonc")))) return;
  const config = await loadConfig(root);
  if (!isDeferredDelivery(config.delivery)) return;
  throw deliveryDeferredError(operation);
}

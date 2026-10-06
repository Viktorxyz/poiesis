export * from "./adapters.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./evidence.js";
// Spec #168 / ticket #172 — the ONE scope-aware check executor.
//
// Public because it is a peer of `verify` at the same seam: a caller that can
// reach whole-change proof must be able to reach the non-authoritative
// focused path with the same classification and fingerprint vocabulary, and
// the `poiesis check` CLI is only one of its callers. The scope is encoded in
// the return type — a `FocusedCheckResult` has `verification` and `proof`
// typed `null`, so the compiler, not a convention, is what keeps focused
// checks from ever authorizing delivery.
export * from "./focused-check.js";
export * from "./git.js";
export * from "./hash.js";
export * from "./inspect.js";
export {
  type MaintenanceOptions,
  type DoctorCheckStatus,
  type DoctorCheck,
  type DoctorReport,
  type UninstallResult,
  type UpdateResult,
  type UpdateConfigOptions,
  type ModelClassName,
  type SetModelResult,
  init,
  doctor,
  update,
  updateFromConfig,
  setModel,
  uninstall,
  resolveConfigForRoot,
  resolveConfigRoot,
  installAuthorizedCapability,
} from "./maintenance.js";
export * from "./manifest.js";
export * from "./opencode.js";
export * from "./session.js";
export * from "./skills.js";
// Spec #120 / ticket #121 — Repository Intelligence is internal to the
// CLI/runtime. The capability is reached only through the
// `poiesis repository status` CLI surface and the init / update /
// doctor / uninstall maintenance flows. Promoting any of the
// constants, helpers, status types, or destructive cache seams to the
// package root would lock the Graphify pin, the cache layout, and the
// ownership-validator contract into a public API before later tickets
// (#122, #123, #124) stabilize them. Every name from
// `src/repository-intelligence.ts` therefore stays module-local; the
// public-API regression test in `tests/public-api.test.ts` enforces
// the absence of every current leak.


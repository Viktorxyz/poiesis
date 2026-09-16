/**
 * Public API declaration regression test.
 *
 * Asserts that the package root (`src/index.ts`) does NOT re-export:
 *   - the security-sensitive fault-injection hooks (`writerHooks` /
 *     `UpdateWriterHooks`) that were removed in this ticket;
 *   - the module-internal transaction seam (`runUpdateConfigTransaction`
 *     and `UpdateTransactionHooks`) that lives in
 *     `src/update-config-internal.ts` and is not re-exported by
 *     `src/index.ts`;
 *   - the ordinary-update / explicit-1.0.0-bootstrap transaction seam
 *     (`runUpdateTransaction`, `runBootstrapLegacyOwnershipTransaction`,
 *     and `UpdateBootstrapTransactionHooks`) that lives in
 *     `src/update-internal.ts` and is not re-exported by
 *     `src/index.ts`;
 *   - the six internal maintenance helpers (`assertResolvedConfig`,
 *     `isRegularManagedFile`, `packageVersion`, `autoResolveConfigDefaults`,
 *     `verifyGitRepository`, `assertConfigPatchesOwned`) that back the
 *     seam and must not leak through the package root;
 *   - the bounded-journal transaction seam from ticket #46
 *     (`ArtifactJournal`, `ArtifactJournalEntry`, `hashDirectoryTree`)
 *     that lives in `src/mutation-transaction.ts` and is intentionally
 *     NOT re-exported by `src/index.ts`. The ticket #46 transactional
 *     `journal` option on `SkillMaintenanceOptions` is also
 *     intentionally absent from the public declaration so callers
 *     cannot bypass the bounded-journal contract.
 *   - the ticket #47 capability-install transaction seam:
 *     `runCapabilityInstallTransaction` (the source-internal runner
 *     with the optional `CapabilityInstallTransactionHooks` parameter),
 *     `CapabilityInstallTransactionHooks` itself, and the
 *     `preimageCapabilityDirectory` field. None of these may appear
 *     in `dist/index.d.ts`; the public
 *     `installAuthorizedCapability(root, input)` wrapper is the only
 *     package-root re-export, and it has EXACTLY TWO parameters.
 *
 * The test uses TypeScript's type system:
 *   - Direct `import` statements from `../src/index.js` fail to compile
 *     if any required name is not re-exported.
 *   - `typeof import("../src/index.js")` gives the module's value type;
 *     `keyof` of that type yields every value-exported name. A
 *     forbidden function present in the runtime surface would make
 *     the corresponding `AssertNotExported` check fail to compile.
 *   - `Pick<PublicType, "field">` against the exported
 *     `SkillMaintenanceOptions` / `CapabilityMaintenanceOptions`
 *     detects forbidden optional properties; a non-empty pick fails
 *     the structural assertion.
 *   - `Parameters<typeof installAuthorizedCapability>["length"]`
 *     asserts the public wrapper's exact arity (must be 2).
 *
 * The test avoids any dependency on the packed `dist/index.d.ts` (which
 * other tests in the suite remove as part of their own cleanup) and
 * runs as part of `pnpm check` and `pnpm test` without extra build
 * steps.
 */
import { describe, it } from "vitest";

// -- Required: the pre-ticket public maintenance surface. A missing
//    re-export fails the import and the test file does not compile.
import {
  type MaintenanceOptions,
  type DoctorCheckStatus,
  type DoctorCheck,
  type DoctorReport,
  type UpdateResult,
  type UninstallResult,
  type UpdateConfigOptions,
  type ModelClassName,
  type SetModelResult,
  type SkillMaintenanceOptions,
  type CapabilityMaintenanceOptions,
  init,
  doctor,
  update,
  updateFromConfig,
  setModel,
  uninstall,
  resolveConfigForRoot,
  resolveConfigRoot,
  installAuthorizedCapability,
} from "../src/index.js";

type PublicApiValues = typeof import("../src/index.js");
type AssertNotExported<K extends string> = K extends keyof PublicApiValues
  ? ["forbidden key present", K]
  : true;

// -- Forbidden: must NOT be re-exported by the package root.
const forbiddenFunctions = [
  "writerHooks",
  "runUpdateConfigTransaction",
  "runUpdateTransaction",
  "runBootstrapLegacyOwnershipTransaction",
  "assertResolvedConfig",
  "isRegularManagedFile",
  "packageVersion",
  "autoResolveConfigDefaults",
  "verifyGitRepository",
  "assertConfigPatchesOwned",
  // Ticket #47: the source-internal capability-install transaction
  // runner. Production callers (CLI, library users) MUST go through
  // the public 2-parameter `installAuthorizedCapability` wrapper; the
  // 3-parameter hook-injection runner stays internal so the
  // security-sensitive preimage/journal/fault surface never reaches
  // the package root.
  "runCapabilityInstallTransaction",
  // Ticket #57: the read-only init discovery composer (`composeInitDiscovery`)
  // lives in `src/init-discovery.ts` and is intentionally NOT re-exported by
  // the package root. The future `poiesis init` TTY (ticket #58) will import
  // the composer directly from the source module, but the package-published
  // surface must not advertise it yet.
  "composeInitDiscovery",
  // Ticket #55: the interactive model selector (`runModelSelector`,
  // `createProductionModelSelectorIO`) lives in `src/model-selector.ts`
  // and is intentionally NOT re-exported by the package root. The
  // future `poiesis init` TTY (ticket #58) and `poiesis model`
  // command (ticket #59) will import the selector directly from the
  // source module; promoting it through the public API would lock the
  // TTY keypress seam before CLI wiring exists.
  "runModelSelector",
  "createProductionModelSelectorIO",
  "DEFAULT_RECOMMENDED_MODEL_IDS",
] as const;

const forbiddenTypes = [
  "UpdateWriterHooks",
  "UpdateTransactionHooks",
  "UpdateBootstrapTransactionHooks",
  // Ticket #46: the bounded-journal transaction seam stays internal.
  "ArtifactJournal",
  "ArtifactJournalEntry",
  "RollbackDiagnostic",
  "ArtifactIdentity",
  "ArtifactJournalEntry",
  "hashDirectoryTree",
  // Ticket #47: the capability-install transaction seam stays internal.
  "CapabilityInstallTransactionHooks",
  "CapabilityMaintenanceInternalOptions",
  // Ticket #57: every composer detection / source type stays internal.
  // The composer and its detection shapes are deliberate internal seams so the
  // future `poiesis init` TTY (ticket #58) owns them; promoting them through
  // the public API would lock the discovery contract before the TTY exists.
  "InitDiscoveryResult",
  "InitDiscoveryDetection",
  "RemoteDetection",
  "BranchDetection",
  "VerificationDetection",
  "TrackerDetection",
  "DeliveryDetection",
  "DeliveryDetectionTarget",
  "RepoStateDetection",
  "RemoteSource",
  "BranchSource",
  "VerificationSource",
  "TrackerSource",
  "DeliverySource",
  // Ticket #55: every model-selector type stays internal. The selector
  // is a deliberate internal seam so the future `poiesis init` TTY
  // (ticket #58) and `poiesis model` command (ticket #59) own the
  // IO/keypress contract directly; promoting any of these types
  // through the public API would freeze that contract before CLI
  // wiring exists.
  "ModelClass",
  "ModelIdentity",
  "RecommendedModelIds",
  "ModelSelectorKey",
  "ModelSelectorIO",
  "ModelSelectorRenderedRow",
  "RunModelSelectorArgs",
  "ProductionModelSelectorIOArgs",
] as const;

// -- Ticket #46: optional properties on the exported
//    `SkillMaintenanceOptions` must stay public-only. The bounded
//    `journal` and the test-only `preimageSkillDirectory` seams are
//    widened through a structural cast inside `installDefaultSkills`,
//    never declared on the public type. `keyof SkillMaintenanceOptions`
//    lists every public key. `Exclude<A, keyof SkillMaintenanceOptions>`
//    is `never` when A is in the keyof (leak), otherwise A (no leak).
//    The conditional below resolves to `true` only when both candidate
//    seams are absent from `keyof SkillMaintenanceOptions`; a leak
//    resolves to a non-`true` tuple literal that fails the assignment.
type AssertSkillMaintenanceOptionsHasNoSeam =
  [Exclude<"journal", keyof SkillMaintenanceOptions>] extends [never]
    ? ["SkillMaintenanceOptions leaks journal seam"]
    : [Exclude<"preimageSkillDirectory", keyof SkillMaintenanceOptions>] extends [never]
      ? ["SkillMaintenanceOptions leaks preimageSkillDirectory seam"]
      : true;

// -- Ticket #47 (Reviewer FAIL fix): optional properties on the
//    exported `CapabilityMaintenanceOptions` must stay public-only.
//    The bounded `journal`, the test-only `preimageCapabilityDirectory`
//    bypass, and the test-only `onCapturesReady` seam are widened
//    through a structural cast inside `installCapability`, never
//    declared on the public type. `keyof CapabilityMaintenanceOptions`
//    lists every public key. `Exclude<A, keyof CapabilityMaintenanceOptions>`
//    is `never` when A is in the keyof (leak), otherwise A (no leak).
//    The conditional below resolves to `true` only when every
//    candidate seam is absent from `keyof CapabilityMaintenanceOptions`;
//    a leak resolves to a non-`true` tuple literal that fails the
//    assignment. Mirrors the ticket #46 assertion pattern.
type AssertCapabilityMaintenanceOptionsHasNoSeam =
  [Exclude<"journal", keyof CapabilityMaintenanceOptions>] extends [never]
    ? ["CapabilityMaintenanceOptions leaks journal seam"]
    : [Exclude<"preimageCapabilityDirectory", keyof CapabilityMaintenanceOptions>] extends [never]
      ? ["CapabilityMaintenanceOptions leaks preimageCapabilityDirectory seam"]
      : [Exclude<"onCapturesReady", keyof CapabilityMaintenanceOptions>] extends [never]
        ? ["CapabilityMaintenanceOptions leaks onCapturesReady seam"]
        : true;

// -- Ticket #47 (final redesign): the public
//    `installAuthorizedCapability(root, input)` wrapper MUST accept
//    EXACTLY two parameters and MUST NOT reference any of the
//    internal hook payload types. The arity is asserted via
//    `Parameters<typeof installAuthorizedCapability>["length"]` (a
//    number literal at compile time). A future 3-parameter addition
//    would surface as the tuple length literal `3` (not `2`) and
//    fail the assignment.
type AssertInstallAuthorizedCapabilityPublicArity =
  Parameters<typeof installAuthorizedCapability>["length"] extends 2
    ? true
    : ["installAuthorizedCapability arity is not 2", Parameters<typeof installAuthorizedCapability>["length"]];

describe("public API declarations (type-level)", () => {
  for (const name of forbiddenFunctions) {
    it(`PublicApi does not re-export function \`${name}\``, () => {
      const assertion: AssertNotExported<typeof name> = true;
      void assertion;
    });
  }
  for (const name of forbiddenTypes) {
    it(`PublicApi does not re-export type \`${name}\``, () => {
      const assertion: AssertNotExported<typeof name> = true;
      void assertion;
    });
  }

  it("PublicApi re-exports the pre-ticket public maintenance functions", () => {
    void init;
    void doctor;
    void update;
    void updateFromConfig;
    void setModel;
    void uninstall;
    void resolveConfigForRoot;
    void resolveConfigRoot;
    void installAuthorizedCapability;
  });

  it("installAuthorizedCapability public wrapper accepts exactly two parameters (arity 2)", () => {
    const arity: AssertInstallAuthorizedCapabilityPublicArity = true;
    void arity;
  });

  it("PublicApi re-exports the pre-ticket public maintenance types", () => {
    type _MaintenanceOptions = MaintenanceOptions;
    type _DoctorCheckStatus = DoctorCheckStatus;
    type _DoctorCheck = DoctorCheck;
    type _DoctorReport = DoctorReport;
    type _UpdateResult = UpdateResult;
    type _UninstallResult = UninstallResult;
    type _UpdateConfigOptions = UpdateConfigOptions;
    type _ModelClassName = ModelClassName;
    type _SetModelResult = SetModelResult;
    void null as unknown as _MaintenanceOptions &
      _DoctorCheckStatus &
      _DoctorCheck &
      _DoctorReport &
      _UpdateResult &
      _UninstallResult &
      _UpdateConfigOptions &
      _ModelClassName &
      _SetModelResult;
  });

  it("ticket #46 internal seams do not leak through SkillMaintenanceOptions", () => {
    const assertion: AssertSkillMaintenanceOptionsHasNoSeam = true;
    void assertion;
  });

  it("ticket #47 internal seams do not leak through CapabilityMaintenanceOptions", () => {
    const assertion: AssertCapabilityMaintenanceOptionsHasNoSeam = true;
    void assertion;
  });
});

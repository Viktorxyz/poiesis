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
 *   - the ticket #58 / #59 interactive IO factories
 *     (`createProductionInteractiveInitIO`,
 *     `createProductionInteractiveModelIO`) and every shape from
 *     `src/init-interactive.ts` / `src/model-interactive.ts` — they
 *     stay CLI-internal so the `InteractiveInitIO` / `InteractiveModelIO`
 *     contracts do not freeze before the TTY flow stabilizes.
 *   - the ticket #68 settle-once readline helper
 *     (`settleOnceLinePrompt` + `SettleOnceLinePromptArgs`) — it is
 *     a private CLI seam; production callers reach it through the
 *     factories above, never through the package root.
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
  // Ticket #73: the CLI-internal Clack adapter (`runClackSelect`) and
  // its row shape (`ClackSelectRow` / `ClackSelectArgs`) live in
  // `src/clack-select.ts` and are intentionally NOT re-exported by the
  // package root. Promoting the adapter would freeze the Clack
  // primitive into the public surface before Clack's API stabilizes
  // for downstream consumers.
  "runClackSelect",
  // Ticket #73: the post-Clack selector exposes a library-free domain
  // shape (`buildModelSelectorRows`, `formatModelSelectorHint`,
  // `resolveIdentityInitialValue`, `ModelSelectorRow`,
  // `ModelSelectorRowHints`). None of those names reach the package
  // root either — the model-selector IO contracts must stay internal.
  "buildModelSelectorRows",
  "formatModelSelectorHint",
  "resolveIdentityInitialValue",
  "DEFAULT_RECOMMENDED_MODEL_IDS",
  // Ticket #58 / #59: the interactive IO factories stay CLI-internal.
  // Tests reach them through the source modules (`src/init-interactive.ts`,
  // `src/model-interactive.ts`) directly; the package root never
  // re-exports them so the `InteractiveInitIO` / `InteractiveModelIO`
  // contracts do not freeze into a public API.
  "createProductionInteractiveInitIO",
  "createProductionInteractiveModelIO",
  // Ticket #68: the settle-once readline helper is a private CLI seam.
  // The factories above are the only production callers; promoting it
  // through `src/index.ts` would freeze the prompt-stream contract.
  "settleOnceLinePrompt",
  // Spec #133 / tickets #134-#137: the `pnpm poiesis` package-script
  // module (`src/package-script.ts`) stays internal. These are the
  // init/update transaction seams and the single source of truth for the
  // script value; promoting them would freeze the Author-owned
  // `package.json` edit contract (including the refusing/repairing
  // entry-point split that forces each caller to choose deliberately)
  // into the packed public surface.
  "POIESIS_SCRIPT_NAME",
  "POIESIS_SCRIPT_COMMAND",
  "PACKAGE_JSON_RELATIVE",
  "assertPoiesisScriptAvailable",
  "ensurePoiesisScriptRefusing",
  "repairPoiesisScript",
  "rollbackPackageJson",
  "EnsurePoiesisScriptOptions",
  // Ticket #121 (reviewer FAIL fix): the ENTIRE Repository Intelligence
  // capability stays internal to the CLI / runtime. No value, no
  // constant, no helper, no status probe, and no destructive cache
  // seam reaches the package root. The capability is reached only
  // through `poiesis repository status` (CLI) and the init / update /
  // doctor / uninstall maintenance flows. Promoting any of these
  // names would lock the Graphify pin, the cache layout, the
  // ownership-validator contract, and the uv requirement gate into a
  // public API before later tickets (#122, #123, #124) stabilize
  // them. Every currently-leaked name is enumerated below so the
  // public-API regression test fails fast if the package root
  // accidentally re-exports any of them.
  // Constants and pinned-runtime identifiers
  "REPOSITORY_INTELLIGENCE_ENGINE",
  "GRAPHIFY_VERSION",
  "GRAPHIFY_PACKAGE",
  "GRAPHIFY_PYTHON",
  "REPOSITORY_INTELLIGENCE_STATE_SCHEMA",
  "REPOSITORY_INTELLIGENCE_RELATIVE_DIRECTORY",
  "REPOSITORY_INTELLIGENCE_STATE_RELATIVE_PATH",
  "REPOSITORY_INTELLIGENCE_CACHE_RELATIVE_DIRECTORY",
  "REPOSITORY_INTELLIGENCE_GRAPHIFY_RELATIVE_PATH",
  "REPOSITORY_INTELLIGENCE_GITIGNORE_LINE",
  // Ticket #122: query runtime surface (constants, runner seam, and
  // the top-level query entry point). Every name stays internal so
  // the Graphify invocation shape, the env-sanitization contract,
  // and the typed fallback envelope cannot freeze into the public
  // API before later tickets stabilize them.
  "REPOSITORY_INTELLIGENCE_REFRESH_TIMEOUT_MS",
  "REPOSITORY_INTELLIGENCE_QUERY_TIMEOUT_MS",
  "REPOSITORY_INTELLIGENCE_QUERY_BUDGET_TOKENS",
  "REPOSITORY_INTELLIGENCE_QUESTION_MAX_LENGTH",
  "REPOSITORY_INTELLIGENCE_GENERATIONS_RELATIVE_DIRECTORY",
  "repositoryIntelligenceGenerationsPath",
  "repositoryIntelligenceGenerationPath",
  "sanitizeGraphifyEnvironment",
  "buildGraphifyInvocation",
  "defaultGraphifyRunner",
  "queryRepositoryIntelligence",
  // Ticket #123: path / explain runtime surface (identifier-length
  // bound, node-call timeout, top-level entry points, and the
  // operation-specific fallback envelopes). Every name stays
  // internal for the same reason as the query seam: the post-refresh
  // graphify argv, the typed fallback reason code, and the
  // success-envelope shape must be free to evolve as later tickets
  // (#124, #125, …) stabilize them.
  "REPOSITORY_INTELLIGENCE_NODE_MAX_LENGTH",
  "REPOSITORY_INTELLIGENCE_NODE_TIMEOUT_MS",
  "pathRepositoryIntelligence",
  "explainRepositoryIntelligence",
  // Path-derivation helpers
  "repositoryIntelligenceCachePath",
  "repositoryIntelligenceStatePath",
  "repositoryIntelligenceGraphifyPath",
  // Status / availability probes
  "repositoryIntelligenceStatus",
  "probeUvAvailability",
  "assertUvRequirement",
  // Destructive cache seams owned by init / uninstall
  "purgeRepositoryIntelligenceCache",
  "validateRepositoryIntelligenceCache",
  "removeValidatedRepositoryIntelligenceCache",
  "stampRepositoryIntelligenceCache",
  // Internal path predicate + state descriptor
  "isCachePathInside",
  "describeRepositoryIntelligenceState",
  // Ticket #127 (Standards finding correction): the canonical-lock
  // acquisition seams stay internal to the CLI / runtime. The
  // guard-serialized acquisition helper and the production entry
  // point both live in `src/repository-intelligence.ts` and MUST
  // NOT reach the package root. Promoting them through `src/index.ts`
  // would lock the guard-file shape, the per-iteration guard wait,
  // and the lock-envelope JSON into a public surface before later
  // tickets stabilize them.
  "acquireRefreshLock",
  "acquireRefreshLockWithTimeout",
  // Spec #131 / ticket #132 — the v1.1.3 / v1.1.4 predecessor
  // projection helper is a migration-only seam that lives in
  // `src/authority.ts` and MUST NOT reach the package root.
  // Promoting it would lock the predecessor projection shape
  // (exact-version allow key, pre-#123 Worker bash surface, and
  // the Specialist agent `permission.bash` strip) into a public
  // API before the v1.2 surface stabilizes.
  "predecessorProjectionV113V114",
  // Spec #139 / ticket #142: the `local` tracker's store layout, lock
  // protocol, and strict-validation contract live in `src/local-tracker.ts`
  // and MUST NOT reach the package root. Only the `createLocalTrackerAdapter`
  // factory is public (mirroring the forge / fixture factories), so a caller
  // gets a complete `TrackerAdapter` without the on-disk store shape, the
  // lock envelope, and the refusal codes freezing into a public surface.
  "resolveLocalTrackerStoreLocation",
  "resolveLocalTrackerStoreLocationSync",
  "parseLocalTrackerStore",
  "acquireLocalTrackerLock",
  "acquireLocalTrackerLockWithTimeout",
  "releaseLocalTrackerLock",
  "assertLocalTrackerStoreUsable",
  "LOCAL_TRACKER_STORE_DIRECTORY",
  "LOCAL_TRACKER_STORE_SCHEMA",
  "LOCAL_TRACKER_STORE_PROVIDER",
  "LOCAL_TRACKER_LOCK_VERSION",
  "LOCAL_TRACKER_LOCK_TIMEOUT_MS",
  // Spec #139 / ticket #141: the Linear adapter lives in
  // `src/linear-tracker.ts` and stays module-internal, and it is reached
  // through the EXISTING public `createTrackerAdapter` factory rather than a
  // second bespoke public entry point. The credential variable names, the
  // official endpoint, the pagination / retry ceilings, the injected
  // transport-clock-sleep-UUID seams, and the authorization probe are the
  // implementation of one provider, not a contract downstream code should
  // depend on.
  "createLinearTrackerAdapter",
  "verifyLinearTrackerAuthorized",
  "LINEAR_GRAPHQL_ENDPOINT",
  "LINEAR_API_KEY_VARIABLE",
  "LINEAR_OAUTH_TOKEN_VARIABLE",
  "LINEAR_PAGE_SIZE",
  "LINEAR_MAX_PAGES",
  "LINEAR_MAX_ATTEMPTS",
  "LINEAR_MAX_RETRY_DELAY_MS",
  "LINEAR_MAX_RETRY_WAIT_MS",
  "LINEAR_DEFAULT_RETRY_DELAY_MS",
  // Ticket #141: the Poiesis tracker metadata envelope and the tracker item
  // helpers were extracted from `src/adapters.ts` into `src/tracker-item.ts`
  // so every adapter — including Linear — shares ONE implementation of the
  // persisted description format. The envelope helpers stay internal:
  // promoting them would lock the on-the-wire format into a public API. The
  // item and comment TYPES remain public and unchanged.
  "decorateBody",
  "parseBody",
  "trackerItem",
  "metadataFromItem",
  "assertKind",
  "isRecord",
  "requiredText",
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
  // Ticket #73: the post-Clack selector exposes `ModelSelectorRow`,
  // `ModelSelectorRowHints`, and a library-free
  // `RunModelSelectorArgs` shape that does NOT take an IO seam. None
  // of these names reach the package root.
  "ModelSelectorRow",
  "ModelSelectorRowHints",
  // Ticket #73: the Clack adapter's input / output types also stay
  // internal; promoting them would leak `@clack/prompts` types into
  // the public surface.
  "ClackSelectRow",
  "ClackSelectArgs",
  // Ticket #58 / #59: every `src/init-interactive.ts` / `src/model-interactive.ts`
  // surface stays internal — the IO contracts, the tracker-provider
  // alias, and the model-selection / current-models shapes.
  "InteractiveInitIO",
  "InteractiveInitOptions",
  "InteractiveModelIO",
  "InteractiveModelOptions",
  "TrackerProvider",
  "TrackerAuthProbeResult",
  "CurrentModels",
  "ModelSelection",
  // Ticket #68: the settle-once prompt's argument bag stays internal.
  "SettleOnceLinePromptArgs",
  // Ticket #121 (reviewer FAIL fix): the ENTIRE Repository Intelligence
  // type surface stays internal to the CLI / runtime. No status
  // shape, no state envelope, no destructive cache result type
  // reaches the package root. Every currently-leaked type is
  // enumerated below so a future re-export regresses immediately
  // instead of silently freezing the v1.2 contract.
  "RepositoryIntelligenceStatus",
  "RepositoryIntelligenceState",
  "RepositoryIntelligenceCacheValidation",
  "RepositoryIntelligenceRemovalResult",
  // Ticket #122: query runtime type surface (runner request /
  // result, refresh decision, query success / fallback, options).
  // Every name stays internal so the typed non-blocking fallback
  // envelope, the refresh-kind label, and the Graphify runner seam
  // cannot freeze into a public API.
  "GraphifyRunner",
  "GraphifyRunnerRequest",
  "GraphifyRunnerResult",
  "GraphifyRunnerSuccess",
  "GraphifyRunnerError",
  "RepositoryIntelligenceQueryOptions",
  "RepositoryIntelligenceQueryOutcome",
  "RepositoryIntelligenceQuerySuccess",
  "RepositoryIntelligenceQueryFallback",
  "RepositoryIntelligenceQueryReason",
  "RepositoryIntelligenceRefresh",
  "RepositoryIntelligenceRefreshKind",
  // Ticket #123: every path / explain runtime type stays internal. The
  // success envelope, the operation-specific fallback envelope, the
  // reason code, the outcome union, and the caller-options shape must
  // all stay internal so the post-refresh graphify argv, the typed
  // fallback reason code, and the success-envelope shape can evolve
  // without freezing into a public API before later tickets (#124,
  // #125, …) stabilize them. Every name is enumerated below so a
  // future re-export regresses immediately.
  "RepositoryIntelligencePathOptions",
  "RepositoryIntelligencePathOutcome",
  "RepositoryIntelligencePathSuccess",
  "RepositoryIntelligencePathFallback",
  "RepositoryIntelligencePathReason",
  "RepositoryIntelligenceExplainOptions",
  "RepositoryIntelligenceExplainOutcome",
  "RepositoryIntelligenceExplainSuccess",
  "RepositoryIntelligenceExplainFallback",
  "RepositoryIntelligenceExplainReason",
  // Ticket #127 (Standards finding correction): the canonical-lock
  // and guard envelopes stay internal. The JSON shape, the
  // identity-check contract, and the bounded-timeout constant must
  // be free to evolve as later tickets stabilize them. The runtime
  // test surface in `tests/repository-intelligence-lock-identity-safety.test.ts`
  // reaches these through the source module directly; they must
  // never reach the package root.
  "RefreshLockContent",
  "RefreshGuardContent",
  "REFRESH_LOCK_CONTENT_VERSION",
  // Ticket #142: the `local` tracker store document, item / comment / history
  // records, lock envelope, and store-location shape are module-internal for
  // the same reason. Every currently-leaked name is enumerated so a future
  // re-export regresses immediately.
  "LocalTrackerStore",
  "LocalTrackerStoreLocation",
  "LocalTrackerItemRecord",
  "LocalTrackerItemFile",
  "LocalTrackerCommentRecord",
  "LocalTrackerHistoryEntry",
  "LocalTrackerLockContent",
  "LocalTrackerState",
  "LocalTrackerOperation",
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

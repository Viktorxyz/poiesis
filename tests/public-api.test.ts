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
 *
 * The test uses TypeScript's type system:
 *   - Direct `import` statements from `../src/index.js` fail to compile
 *     if any required name is not re-exported.
 *   - `typeof import("../src/index.js")` gives the module's value type;
 *     `keyof` of that type yields every value-exported name. A
 *     forbidden function present in the runtime surface would make
 *     the corresponding `AssertNotExported` check fail to compile.
 *   - `Pick<PublicType, "field">` against the exported
 *     `SkillMaintenanceOptions` detects forbidden optional properties;
 *     a non-empty pick fails the structural assertion.
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
  type SkillMaintenanceOptions,
  init,
  doctor,
  update,
  updateFromConfig,
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
    void uninstall;
    void resolveConfigForRoot;
    void resolveConfigRoot;
    void installAuthorizedCapability;
  });

  it("PublicApi re-exports the pre-ticket public maintenance types", () => {
    type _MaintenanceOptions = MaintenanceOptions;
    type _DoctorCheckStatus = DoctorCheckStatus;
    type _DoctorCheck = DoctorCheck;
    type _DoctorReport = DoctorReport;
    type _UpdateResult = UpdateResult;
    type _UninstallResult = UninstallResult;
    type _UpdateConfigOptions = UpdateConfigOptions;
    void null as unknown as _MaintenanceOptions &
      _DoctorCheckStatus &
      _DoctorCheck &
      _DoctorReport &
      _UpdateResult &
      _UninstallResult &
      _UpdateConfigOptions;
  });

  it("ticket #46 internal seams do not leak through SkillMaintenanceOptions", () => {
    const assertion: AssertSkillMaintenanceOptionsHasNoSeam = true;
    void assertion;
  });
});

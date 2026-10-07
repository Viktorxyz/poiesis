/**
 * Spec #168 / ticket #171 — `VerificationReceiptV1`.
 *
 * A proof-scope `verify` used to be an operation with no durable output: its
 * result lived in one process, and the next step (`publish`) believed
 * `proof.verified === true` because the CALLER said so. This module is the
 * runtime-owned answer: a whole-change Verify persists an immutable,
 * self-authenticating receipt, and every downstream step resolves that stored
 * document instead of trusting an asserted flag.
 *
 * Storage contract:
 *   - location: `<git common dir>/poiesis-verification-receipts-v1/<id>.json`,
 *     so a sibling worktree of the same repository resolves the same receipt
 *     and the receipt can never be committed into a candidate tree;
 *   - the directory is `0700` and each receipt is `0400`: runtime evidence is
 *     private to the operating user and read-only to everyone, Poiesis
 *     included;
 *   - creation is atomic and exclusive (never an overwrite), so a receipt id
 *     can never be rebound to different content.
 *
 * Authority contract: every binding the receipt records (runtime identity,
 * adapter/install identity, manifest digest + generation, workspace ownership,
 * candidate SHA + tree, ordered verification plan) is revalidated by
 * `resolveVerificationReceipt` against LIVE authority. A receipt is evidence of
 * one specific Verify of one specific candidate under one specific
 * installation and plan; anything else is refused with a typed code and a
 * fresh-Verify migration message.
 *
 * This module is the single state record for verification evidence. It is not
 * telemetry and it is not a second state engine: it stores facts about one
 * Verify run and resolves them against the existing lifecycle authority.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedPoiesisConfig } from "./config.js";
import { PoiesisError, invariant } from "./errors.js";
import { atomicCreate, exists } from "./fs.js";
import { hashContent } from "./hash.js";
import { manifestDigest, type OwnershipReceipt } from "./receipt.js";
import type { Manifest } from "./manifest.js";

export const VERIFICATION_RECEIPT_DIRECTORY = "poiesis-verification-receipts-v1";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RECEIPT_KEYS = [
  "candidateSha",
  "candidateTree",
  "cleanAfter",
  "cleanBefore",
  "commands",
  "commonDir",
  "digest",
  "durationMs",
  "endedAt",
  "generation",
  "id",
  "installationId",
  "manifestDigest",
  "outcome",
  "outputLimit",
  "runtime",
  "schema",
  "startedAt",
  "timeoutMs",
  "verificationPlan",
  "verificationPlanDigest",
  "workspace",
  "workspaceOwnershipId",
] as const;

const COMMAND_KEYS = [
  "classification",
  "command",
  "durationMs",
  "endedAt",
  "exitCode",
  "outputTruncated",
  "signal",
  "startedAt",
  "status",
  "stderr",
  "stderrTruncated",
  "stdout",
  "stdoutTruncated",
  "timedOut",
  "timeoutMs",
] as const;

const COMMAND_CLASSIFICATIONS = ["passed", "command-failed", "timeout", "spawn-error"] as const;

/**
 * How one verification command actually ended. `passed` / `command-failed` /
 * `timeout` are the ordinary terminal states; `spawn-error` covers a runner
 * that never produced a settled result (for example a transport failure after
 * the process tree was reaped).
 */
export type VerificationCommandClassification = (typeof COMMAND_CLASSIFICATIONS)[number];

export interface VerificationCommandEvidenceV1 {
  command: string;
  status: "passed" | "failed";
  classification: VerificationCommandClassification;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputTruncated: boolean;
}

export interface VerificationReceiptV1 {
  schema: 1;
  id: string;
  digest: string;
  commonDir: string;
  workspace: string;
  workspaceOwnershipId: string | null;
  runtime: string;
  installationId: string;
  manifestDigest: string;
  generation: number;
  candidateSha: string;
  candidateTree: string;
  verificationPlan: string[];
  verificationPlanDigest: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  timeoutMs: number;
  outputLimit: number;
  commands: VerificationCommandEvidenceV1[];
  cleanBefore: true;
  cleanAfter: boolean;
  outcome: "verified" | "failed";
}

/** The receipt document minus the digest the receipt itself carries. */
export type VerificationReceiptBodyV1 = Omit<VerificationReceiptV1, "digest">;

/**
 * The caller-carried reference to a stored receipt.
 *
 * A caller may only point at runtime evidence. Every field is re-derived from
 * the stored document on resolution, so a reference that disagrees with the
 * document it names is refused rather than believed.
 */
export interface VerificationEvidence {
  receiptId: string;
  receiptDigest: string;
  runtime: string;
  candidateSha: string;
  candidateTree: string;
  verificationPlanDigest: string;
}

/**
 * The live authority a receipt is resolved against. Structurally satisfied by
 * `LifecycleAuthority` from `src/git.ts`; declared here so the receipt module
 * never has to import the lifecycle module (which imports this one).
 */
export interface VerificationReceiptAuthority {
  commonDir: string;
  candidateRoot: string;
  marker: { ownershipId: string } | null;
  runtime: string;
  receipt: OwnershipReceipt;
  manifest: Manifest;
}

export interface VerificationReceiptInput {
  authority: VerificationReceiptAuthority;
  candidateSha: string;
  candidateTree: string;
  plan: readonly string[];
  timeoutMs: number;
  outputLimit: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  commands: readonly VerificationCommandEvidenceV1[];
  cleanAfter: boolean;
  outcome: "verified" | "failed";
}

export interface ResolveVerificationReceiptInput {
  authority: VerificationReceiptAuthority;
  /** The caller-supplied reference, i.e. `proof.verification`. */
  reference: unknown;
  candidateSha: string;
  candidateTree: string;
  /** The live verification plan the proof must have been produced against. */
  plan: readonly string[];
}

/** Deterministic, key-order-independent serialization used for digests. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** The digest of a receipt body, independent of JSON key order. */
export function computeVerificationReceiptDigest(receipt: VerificationReceiptV1 | VerificationReceiptBodyV1): string {
  const { digest: _selfDigest, ...body } = receipt as VerificationReceiptV1;
  return hashContent(canonicalJson(body));
}

/** The digest of an ordered verification plan. Order is part of the identity. */
export function verificationPlanDigest(plan: readonly string[]): string {
  return hashContent(canonicalJson([...plan]));
}

export function verificationReceiptPath(commonDir: string, id: string): string {
  invariant(
    typeof id === "string" && id.length > 0 && !id.includes("/") && !id.includes("\\") && id !== "." && id !== "..",
    "VERIFICATION_RECEIPT_ID_INVALID",
    "Verification receipt id is not a safe storage name",
    { id },
  );
  return join(commonDir, VERIFICATION_RECEIPT_DIRECTORY, `${id}.json`);
}

/** The caller-facing reference for a stored receipt. */
export function verificationEvidenceFrom(receipt: VerificationReceiptV1): VerificationEvidence {
  return {
    receiptId: receipt.id,
    receiptDigest: receipt.digest,
    runtime: receipt.runtime,
    candidateSha: receipt.candidateSha,
    candidateTree: receipt.candidateTree,
    verificationPlanDigest: receipt.verificationPlanDigest,
  };
}

/** Structural check for a caller-supplied reference. */
export function isVerificationEvidenceShape(value: unknown): value is VerificationEvidence {
  return (
    isRecord(value) &&
    typeof value.receiptId === "string" &&
    value.receiptId.length > 0 &&
    typeof value.receiptDigest === "string" &&
    DIGEST_PATTERN.test(value.receiptDigest) &&
    typeof value.runtime === "string" &&
    value.runtime.length > 0 &&
    typeof value.candidateSha === "string" &&
    SHA_PATTERN.test(value.candidateSha) &&
    typeof value.candidateTree === "string" &&
    SHA_PATTERN.test(value.candidateTree) &&
    typeof value.verificationPlanDigest === "string" &&
    DIGEST_PATTERN.test(value.verificationPlanDigest)
  );
}

/**
 * Persist one proof-scope Verify run as an immutable receipt and return it.
 *
 * The receipt is written once and never rewritten: a later Verify of the same
 * candidate mints a NEW id, so a stale receipt can always be told apart from a
 * fresh one by identity alone.
 */
export async function createVerificationReceipt(input: VerificationReceiptInput): Promise<VerificationReceiptV1> {
  const { authority } = input;
  const id = randomUUID();
  const body: VerificationReceiptBodyV1 = {
    schema: 1,
    id,
    commonDir: authority.commonDir,
    workspace: authority.candidateRoot,
    workspaceOwnershipId: authority.marker?.ownershipId ?? null,
    runtime: authority.runtime,
    installationId: authority.receipt.installationId,
    manifestDigest: manifestDigest(authority.manifest),
    generation: authority.receipt.generation,
    candidateSha: input.candidateSha,
    candidateTree: input.candidateTree,
    verificationPlan: [...input.plan],
    verificationPlanDigest: verificationPlanDigest(input.plan),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    timeoutMs: input.timeoutMs,
    outputLimit: input.outputLimit,
    commands: input.commands.map((entry) => ({ ...entry })),
    cleanBefore: true,
    cleanAfter: input.cleanAfter,
    outcome: input.outcome,
  };
  const receipt: VerificationReceiptV1 = { ...body, digest: computeVerificationReceiptDigest(body) };
  const path = verificationReceiptPath(authority.commonDir, id);
  await mkdir(join(authority.commonDir, VERIFICATION_RECEIPT_DIRECTORY), { recursive: true, mode: 0o700 });
  try {
    await atomicCreate(path, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    throw new PoiesisError("VERIFICATION_RECEIPT_CONFLICT", "Could not persist the verification receipt", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  // Read-only for everyone, Poiesis included: the receipt is evidence, not a
  // mutable status file. `chmod` is explicit because the atomic-create
  // temporary lands at its own 0600 default.
  await chmod(path, 0o400);
  return receipt;
}

/**
 * The one migration that resolves ANY receipt refusal. Every typed receipt
 * error names it, so an operator — or a model driving the CLI — always knows
 * the exact next deterministic step instead of guessing.
 */
function freshVerifyMigration(candidateSha?: string): string {
  return candidateSha === undefined
    ? "Run `poiesis verify` for this exact candidate and forward the `verification` block it returns."
    : `Run \`poiesis verify --sha ${candidateSha}\` for this exact candidate and forward the \`verification\` block it returns.`;
}

/** Read one stored receipt and prove it authenticates to its own digest. */
export async function readVerificationReceipt(commonDir: string, id: string): Promise<VerificationReceiptV1> {
  const path = verificationReceiptPath(commonDir, id);
  if (!(await exists(path))) {
    throw new PoiesisError("VERIFICATION_RECEIPT_MISSING", "Verification receipt is missing", {
      path,
      receiptId: id,
      migration: freshVerifyMigration(),
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new PoiesisError("VERIFICATION_RECEIPT_INVALID", "Cannot read the verification receipt", {
      path,
      cause: error instanceof Error ? error.message : String(error),
      migration: freshVerifyMigration(),
    });
  }
  const receipt = parseVerificationReceipt(value, path);
  const digest = computeVerificationReceiptDigest(receipt);
  if (receipt.digest !== digest || receipt.id !== id) {
    throw new PoiesisError(
      "VERIFICATION_RECEIPT_INVALID",
      "Verification receipt content does not authenticate to its own digest",
      { path, expected: digest, actual: receipt.digest, migration: freshVerifyMigration() },
    );
  }
  return receipt;
}

/**
 * Resolve a caller-supplied reference to the stored receipt it names and
 * revalidate every binding against LIVE authority, the live verification plan,
 * and the live candidate.
 *
 * Every refusal is typed and names the one migration that resolves it: run
 * Verify again for this exact candidate.
 */
export async function resolveVerificationReceipt(
  input: ResolveVerificationReceiptInput,
): Promise<VerificationReceiptV1> {
  const { authority, reference, candidateSha, candidateTree, plan } = input;
  const freshVerify = freshVerifyMigration(candidateSha);
  if (!isVerificationEvidenceShape(reference)) {
    throw new PoiesisError(
      "VERIFICATION_RECEIPT_REQUIRED",
      "Proof evidence does not reference a runtime verification receipt",
      { candidateSha, migration: freshVerify },
    );
  }
  invariant(
    reference.candidateSha === candidateSha && reference.candidateTree === candidateTree,
    "VERIFICATION_RECEIPT_CANDIDATE_MISMATCH",
    "Verification receipt reference belongs to a different candidate",
    { expected: candidateSha, actual: reference.candidateSha, expectedTree: candidateTree, actualTree: reference.candidateTree },
  );
  const receipt = await readVerificationReceipt(authority.commonDir, reference.receiptId);
  invariant(
    receipt.digest === reference.receiptDigest,
    "VERIFICATION_RECEIPT_INVALID",
    "Verification receipt reference does not match the stored receipt digest",
    { expected: reference.receiptDigest, actual: receipt.digest },
  );
  // Spec #168 / ticket #186 — the caller's copy must AGREE with the document it
  // names. Every other reference field was compared to live authority or to the
  // live plan; `runtime` and `verificationPlanDigest` were only ever checked on
  // the STORED receipt, so a reference could describe a different runtime or a
  // different plan than the evidence actually proven while all checks passed.
  // Both are now fail-closed equalities against the authenticated document, and
  // both name the same migration every other receipt refusal names.
  invariant(
    reference.runtime === receipt.runtime,
    "VERIFICATION_RECEIPT_RUNTIME_MISMATCH",
    "Verification receipt reference names a different runtime identity than the stored receipt",
    { expected: receipt.runtime, actual: reference.runtime, migration: freshVerify },
  );
  invariant(
    reference.verificationPlanDigest === receipt.verificationPlanDigest,
    "VERIFICATION_PLAN_MISMATCH",
    "Verification receipt reference names a different verification plan than the stored receipt",
    {
      expected: receipt.verificationPlanDigest,
      actual: reference.verificationPlanDigest,
      migration: freshVerify,
    },
  );
  invariant(
    receipt.commonDir === authority.commonDir && receipt.workspace === authority.candidateRoot,
    "VERIFICATION_RECEIPT_WORKSPACE_MISMATCH",
    "Verification receipt belongs to a different workspace",
    { expected: authority.candidateRoot, actual: receipt.workspace, migration: freshVerify },
  );
  invariant(
    receipt.workspaceOwnershipId === (authority.marker?.ownershipId ?? null),
    "VERIFICATION_RECEIPT_WORKSPACE_MISMATCH",
    "Verification receipt belongs to a different workspace ownership identity",
    { expected: authority.marker?.ownershipId ?? null, actual: receipt.workspaceOwnershipId, migration: freshVerify },
  );
  invariant(
    receipt.runtime === authority.runtime &&
      receipt.installationId === authority.receipt.installationId &&
      receipt.manifestDigest === manifestDigest(authority.manifest) &&
      receipt.generation === authority.receipt.generation,
    "VERIFICATION_RECEIPT_STALE",
    "Verification receipt belongs to a different Poiesis installation identity",
    {
      expected: authority.runtime,
      actual: receipt.runtime,
      expectedGeneration: authority.receipt.generation,
      actualGeneration: receipt.generation,
      migration: freshVerify,
    },
  );
  invariant(
    receipt.candidateSha === candidateSha && receipt.candidateTree === candidateTree,
    "VERIFICATION_RECEIPT_CANDIDATE_MISMATCH",
    "Verification receipt was produced for a different candidate",
    { expected: candidateSha, actual: receipt.candidateSha, migration: freshVerify },
  );
  const expectedPlanDigest = verificationPlanDigest(plan);
  invariant(
    receipt.verificationPlanDigest === expectedPlanDigest && samePlan(receipt.verificationPlan, plan),
    "VERIFICATION_PLAN_MISMATCH",
    "Verification receipt was produced by a different verification plan than the live plan",
    {
      expected: expectedPlanDigest,
      actual: receipt.verificationPlanDigest,
      expectedPlan: [...plan],
      actualPlan: receipt.verificationPlan,
      migration: freshVerify,
    },
  );
  invariant(
    receipt.outcome === "verified" && receipt.cleanBefore === true && receipt.cleanAfter === true,
    "VERIFICATION_OUTCOME_NOT_VERIFIED",
    "Verification receipt does not record a clean, verified outcome",
    { outcome: receipt.outcome, cleanBefore: receipt.cleanBefore, cleanAfter: receipt.cleanAfter, migration: freshVerify },
  );
  invariant(
    receipt.commands.length === receipt.verificationPlan.length &&
      receipt.commands.every(
        (entry, index) =>
          entry.command === receipt.verificationPlan[index] &&
          entry.status === "passed" &&
          entry.classification === "passed",
      ),
    "VERIFICATION_RECEIPT_INVALID",
    "Verification receipt does not record complete passing evidence for its plan",
    { commands: receipt.commands.length, plan: receipt.verificationPlan.length },
  );
  return receipt;
}

/**
 * The PRIMARY installation's live verification plan.
 *
 * Publish resolves the live plan itself, from the same receipt-authenticated
 * installation that produced the receipt, so a proof cannot be validated
 * against a plan the caller chose.
 *
 * The plan is read through the SAME resolved-configuration semantics `poiesis
 * verify` uses (`resolveConfigForRoot`), not through the raw config file. Both
 * sides must ask one question — "what does this installation run?" — and get
 * one answer: an installation whose config omits `verification.commands` falls
 * back to discovery and then to the documented default command, exactly as the
 * CLI dispatch does. Reading the raw file instead would make Publish resolve a
 * plan the Verify that produced the receipt never ran.
 *
 * `maintenance.js` is reached through a DEFERRED import for the same reason
 * `src/git.ts` defers it: it pulls in `adapters.js` → `evidence.js` → this
 * module, so a static import would close a module cycle.
 */
export async function resolveLiveVerificationPlan(primaryRoot: string): Promise<string[]> {
  let resolved: ResolvedPoiesisConfig;
  try {
    resolved = await (await import("./maintenance.js")).resolveConfigForRoot(primaryRoot);
  } catch (error) {
    throw new PoiesisError(
      "VERIFICATION_PLAN_UNRESOLVED",
      "Cannot resolve the installation's live verification plan",
      {
        primaryRoot,
        cause: error instanceof Error ? error.message : String(error),
        migration: freshVerifyMigration(),
      },
    );
  }
  const plan = resolved.verification.commands;
  invariant(
    plan.length > 0,
    "VERIFICATION_PLAN_UNRESOLVED",
    "The installation does not define a live verification plan",
    { primaryRoot, migration: freshVerifyMigration() },
  );
  return [...plan];
}

function samePlan(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((command, index) => command === right[index]);
}

function parseVerificationReceipt(value: unknown, path: string): VerificationReceiptV1 {
  invariant(
    isRecord(value) && hasExactKeys(value, RECEIPT_KEYS),
    "VERIFICATION_RECEIPT_INVALID",
    "Verification receipt is invalid",
    { path, failed: ["shape"], migration: freshVerifyMigration() },
  );
  const receipt = value as unknown as VerificationReceiptV1;
  // Every field is checked independently and the FAILING NAMES are reported,
  // so a malformed or hand-authored document is diagnosable instead of being a
  // single opaque "invalid".
  const checks: Array<[string, boolean]> = [
    ["schema", receipt.schema === 1],
    ["id", typeof receipt.id === "string" && receipt.id.length > 0],
    ["digest", typeof receipt.digest === "string" && DIGEST_PATTERN.test(receipt.digest)],
    ["commonDir", typeof receipt.commonDir === "string" && receipt.commonDir.length > 0],
    ["workspace", typeof receipt.workspace === "string" && receipt.workspace.length > 0],
    [
      "workspaceOwnershipId",
      receipt.workspaceOwnershipId === null ||
        (typeof receipt.workspaceOwnershipId === "string" && receipt.workspaceOwnershipId.length > 0),
    ],
    ["runtime", typeof receipt.runtime === "string" && receipt.runtime.length > 0],
    ["installationId", typeof receipt.installationId === "string" && receipt.installationId.length > 0],
    ["manifestDigest", typeof receipt.manifestDigest === "string" && DIGEST_PATTERN.test(receipt.manifestDigest)],
    ["generation", Number.isInteger(receipt.generation) && receipt.generation >= 1],
    ["candidateSha", typeof receipt.candidateSha === "string" && SHA_PATTERN.test(receipt.candidateSha)],
    ["candidateTree", typeof receipt.candidateTree === "string" && SHA_PATTERN.test(receipt.candidateTree)],
    ["verificationPlan", isCommandList(receipt.verificationPlan)],
    [
      "verificationPlanDigest",
      typeof receipt.verificationPlanDigest === "string" && DIGEST_PATTERN.test(receipt.verificationPlanDigest),
    ],
    ["startedAt", isInstant(receipt.startedAt)],
    ["endedAt", isInstant(receipt.endedAt)],
    ["durationMs", isDuration(receipt.durationMs)],
    ["timeoutMs", isDuration(receipt.timeoutMs)],
    ["outputLimit", Number.isInteger(receipt.outputLimit) && receipt.outputLimit > 0],
    ["commands", Array.isArray(receipt.commands) && receipt.commands.length > 0],
    ["cleanBefore", receipt.cleanBefore === true],
    ["cleanAfter", typeof receipt.cleanAfter === "boolean"],
    ["outcome", receipt.outcome === "verified" || receipt.outcome === "failed"],
  ];
  const failed = checks.filter(([, passed]) => !passed).map(([field]) => field);
  // Only an ARRAY is ever iterated. A malformed `commands` value (object,
  // number, string, …) is reported as the `commands` field failure above; this
  // loop must never touch it, or a hand-authored document would surface as an
  // opaque TypeError instead of a typed, diagnosable refusal.
  const commandList = Array.isArray(receipt.commands) ? receipt.commands : [];
  for (const [index, entry] of commandList.entries()) {
    const commandFailures = commandEvidenceFailures(entry);
    if (commandFailures.length > 0) failed.push(`commands[${index}]:${commandFailures.join(",")}`);
  }
  invariant(failed.length === 0, "VERIFICATION_RECEIPT_INVALID", "Verification receipt is invalid", {
    path,
    failed,
    migration: freshVerifyMigration(),
  });
  invariant(
    receipt.verificationPlanDigest === verificationPlanDigest(receipt.verificationPlan),
    "VERIFICATION_RECEIPT_INVALID",
    "Verification receipt plan digest does not match its ordered plan",
    { path, failed: ["verificationPlanDigest"], migration: freshVerifyMigration() },
  );
  return receipt;
}

function isCommandEvidence(value: unknown): value is VerificationCommandEvidenceV1 {
  return commandEvidenceFailures(value).length === 0;
}

function commandEvidenceFailures(value: unknown): string[] {
  if (!isRecord(value) || !hasExactKeys(value, COMMAND_KEYS)) return ["shape"];
  const entry = value as unknown as VerificationCommandEvidenceV1;
  const checks: Array<[string, boolean]> = [
    ["command", typeof entry.command === "string" && entry.command.length > 0],
    ["status", entry.status === "passed" || entry.status === "failed"],
    [
      "classification",
      typeof entry.classification === "string" &&
        COMMAND_CLASSIFICATIONS.includes(entry.classification as VerificationCommandClassification),
    ],
    ["exitCode", entry.exitCode === null || Number.isInteger(entry.exitCode)],
    ["signal", entry.signal === null || typeof entry.signal === "string"],
    ["startedAt", isInstant(entry.startedAt)],
    ["endedAt", isInstant(entry.endedAt)],
    ["durationMs", isDuration(entry.durationMs)],
    ["timeoutMs", isDuration(entry.timeoutMs)],
    ["timedOut", typeof entry.timedOut === "boolean"],
    ["stdout", typeof entry.stdout === "string"],
    ["stderr", typeof entry.stderr === "string"],
    ["stdoutTruncated", typeof entry.stdoutTruncated === "boolean"],
    ["stderrTruncated", typeof entry.stderrTruncated === "boolean"],
    ["outputTruncated", typeof entry.outputTruncated === "boolean"],
  ];
  return checks.filter(([, passed]) => !passed).map(([field]) => field);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => key === actual[index]);
}

function isCommandList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
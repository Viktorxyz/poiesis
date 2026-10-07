/**
 * Spec #168 / ticket #171 — runtime-owned whole-change Verify evidence.
 *
 * Before this ticket, `poiesis publish` believed `proof.verified === true`
 * because the CALLER said so: a `--proof` JSON document assembled by a model
 * could claim that deterministic verification had passed for an exact
 * candidate without a single command ever running. Verify itself issued no
 * durable evidence at all.
 *
 * Ticket #171 closes the Verify half of that gap with `VerificationReceiptV1`:
 * a proof-scope `verify` persists an atomic, restrictively-stored receipt
 * under the repository's shared Git common directory. The receipt binds the
 * schema / id / digest, the runtime / adapter / install identity, the manifest
 * digest + generation, the workspace ownership, the exact candidate SHA + tree,
 * the ordered verification-plan digest, start / end / duration, complete
 * bounded per-command status / timing / timeout / classification / output /
 * truncation, the clean checks, and the outcome.
 *
 * The receipt is READ-ONLY evidence: a caller may reference it, never author
 * it. This file owns issuance, storage restriction, binding completeness, and
 * the non-project-bound compatibility surface. The Publish / Preview half —
 * authoritative resolution, propagation, and the rejection matrix — lives in
 * `tests/verification-receipt-publish.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpoint, resolveLifecycleAuthority, resolveTree, verify, workspacePrepare } from "../src/git.js";
import { init } from "../src/maintenance.js";
import {
  VERIFICATION_RECEIPT_DIRECTORY,
  computeVerificationReceiptDigest,
  readVerificationReceipt,
  verificationPlanDigest,
  verificationReceiptPath,
  type VerificationReceiptV1,
} from "../src/verification-receipt.js";
import {
  createTestRepository,
  describeManagedExecution,
  itManagedExecution,
  testConfig,
  type TestRepository,
} from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

/** The PRIMARY installation's live verification plan. */
const LIVE_PLAN = ["test -f README.md", "test -f feature.txt"];

const repositories: TestRepository[] = [];
let env: FakeOpenCodeEnvironment | undefined;

beforeEach(async () => {
  env = await installFakeOpenCode();
});

afterEach(async () => {
  env?.restore();
  await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
});

async function installedRepository(verificationCommands: string[] = LIVE_PLAN): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await init(
    repository.root,
    { ...testConfig(repository), verification: { commands: verificationCommands } },
    { skipSkills: true, allowFixtureAdapters: true },
  );
  return repository;
}

interface Candidate {
  path: string;
  ownershipId: string;
  sha: string;
  tree: string;
}

async function acceptedCandidate(repository: TestRepository, specId: string): Promise<Candidate> {
  const workspace = await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch: `poiesis/${specId}`,
    specId,
  });
  await writeFile(join(workspace.path, "feature.txt"), "feature\n", "utf8");
  const accepted = await checkpoint({
    cwd: workspace.path,
    ownershipId: workspace.ownershipId,
    paths: ["feature.txt"],
    message: `ticket #171 ${specId}`,
    review: { verdict: "PASS", reviewerIdentity: "reviewer", evidence: "pass" },
  });
  return {
    path: workspace.path,
    ownershipId: workspace.ownershipId,
    sha: accepted.sha,
    tree: await resolveTree(repository.root, accepted.sha),
  };
}

/**
 * Spec #168 / ticket #183 — a receipt entry must not claim complete output it
 * does not have.
 *
 * The per-command record for a command that never settled is built from the
 * runner's error `details`, because there is no `RunResult` for it: those
 * streams were bounded on the way into the envelope, and this record bounds
 * them again to the requested `outputLimit`. Before this ticket only the
 * runner's own flag survived, so a timed-out command that emitted 50 KiB was
 * recorded as `stdoutTruncated: false` / `outputTruncated: false` beside an
 * 8,000-byte `stdout` — and a receipt is exactly the durable evidence a later
 * Publish reads. The same defect ran the other way: a small requested
 * `outputLimit` clipped this record's own text while the envelope's flag stayed
 * false, so neither bound was reported.
 */
describeManagedExecution("a failed command's receipt evidence reports real truncation (Spec #168 / ticket #183)", () => {
  /** Emit `bytes` on stdout, then hang until Verify's own bound stops it. */
  const emitThenHang = (bytes: number): string => `head -c ${bytes} /dev/zero | tr '\\0' x; sleep 30`;

  /** The receipt a failed Verify minted, read back from the shared store. */
  async function receiptOfFailure(
    reference: { receiptId: string },
    commonDir: string,
  ): Promise<VerificationReceiptV1> {
    return await readVerificationReceipt(commonDir, reference.receiptId);
  }

  it("records the runner envelope's clip for a timed-out command", { timeout: 60_000 }, async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-183-envelope-clip");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    const failure = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: [emitThenHang(50_000)],
      timeoutMs: 2_000,
    }).then(
      () => {
        throw new Error("expected the verification to fail");
      },
      (error: unknown) => error as { code: string; exitCode: number; details: Record<string, unknown> },
    );

    // The typed outcome is untouched by the bounding change.
    expect(failure.code).toBe("COMMAND_TIMEOUT");
    expect(failure.exitCode).toBe(124);

    const receipt = await receiptOfFailure(
      failure.details.verification as { receiptId: string },
      authority.commonDir,
    );
    const [entry] = receipt.commands;
    expect(entry).toMatchObject({
      command: emitThenHang(50_000),
      status: "failed",
      classification: "timeout",
      timedOut: true,
      stdoutTruncated: true,
      stderrTruncated: false,
      outputTruncated: true,
    });
    expect(entry?.stdout).toMatch(/\.\.\. truncated \d+ bytes$/);
    expect(Buffer.byteLength(String(entry?.stdout ?? ""), "utf8")).toBeLessThanOrEqual(8_000 + 64);
  });

  it("records the receipt record's own bound as truncation for a rejected command", { timeout: 60_000 }, async () => {
    // 7,000 bytes: more than this receipt's 500-byte limit and less than the
    // 8,000 bytes the runner's envelope retains, so the envelope clipped
    // nothing and the clip happened in this record alone.
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-183-own-bound");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    const failure = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: [emitThenHang(7_000)],
      outputLimit: 500,
      timeoutMs: 2_000,
    }).then(
      () => {
        throw new Error("expected the verification to fail");
      },
      (error: unknown) => error as { code: string; details: Record<string, unknown> },
    );

    const receipt = await receiptOfFailure(
      failure.details.verification as { receiptId: string },
      authority.commonDir,
    );
    const [entry] = receipt.commands;
    expect(entry).toMatchObject({
      status: "failed",
      classification: "timeout",
      stdoutTruncated: true,
      outputTruncated: true,
    });
    expect(Buffer.byteLength(String(entry?.stdout ?? ""), "utf8")).toBeLessThanOrEqual(500 + 64);
  });

  it("keeps the whole captured output when the requested limit exceeds the envelope bound", { timeout: 60_000 }, async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-183-requested-limit");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    const failure = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: [emitThenHang(12_000)],
      outputLimit: 20_000,
      timeoutMs: 2_000,
    }).then(
      () => {
        throw new Error("expected the verification to fail");
      },
      (error: unknown) => error as { code: string; details: Record<string, unknown> },
    );

    const receipt = await receiptOfFailure(
      failure.details.verification as { receiptId: string },
      authority.commonDir,
    );
    const [entry] = receipt.commands;
    expect(entry).toMatchObject({
      status: "failed",
      classification: "timeout",
      // Nothing was lost, so the receipt says so instead of implying a clip.
      stdoutTruncated: false,
      stderrTruncated: false,
      outputTruncated: false,
    });
    expect(Buffer.byteLength(String(entry?.stdout ?? ""), "utf8")).toBe(12_000);
  });
});

describeManagedExecution("proof-scope Verify issues a runtime-owned receipt (Spec #168 / ticket #171)", () => {
  it("persists the receipt under the shared Git common directory with restrictive permissions", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-storage");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    const result = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: LIVE_PLAN,
    });

    const reference = result.verification;
    expect(reference).not.toBeNull();
    const path = verificationReceiptPath(authority.commonDir, reference!.receiptId);
    // The receipt lives in the repository's SHARED common directory, never
    // inside the candidate worktree: a sibling worktree of the same repository
    // must resolve it, and it can never be committed into a candidate tree.
    expect(path.startsWith(join(authority.commonDir, VERIFICATION_RECEIPT_DIRECTORY))).toBe(true);
    expect(path.startsWith(candidate.path)).toBe(false);

    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o400);
  }, 60_000);

  it("binds schema, id, digest, install identity, ownership, candidate, plan, timing, commands, clean checks, and outcome", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-binding");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    const result = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: LIVE_PLAN,
    });

    const receipt = await readVerificationReceipt(authority.commonDir, result.verification!.receiptId);

    // Schema / identity / self-authenticating digest.
    expect(receipt.schema).toBe(1);
    expect(receipt.id).toBe(result.verification!.receiptId);
    expect(receipt.digest).toBe(result.verification!.receiptDigest);
    expect(receipt.digest).toBe(computeVerificationReceiptDigest(receipt));

    // Runtime + installation identity.
    expect(receipt.runtime).toBe(authority.runtime);
    expect(receipt.installationId).toBe(authority.receipt.installationId);
    expect(receipt.manifestDigest).toBe(authority.receipt.manifestDigest);
    expect(receipt.generation).toBe(authority.receipt.generation);

    // Workspace ownership + storage locality.
    expect(receipt.commonDir).toBe(authority.commonDir);
    expect(receipt.workspace).toBe(authority.candidateRoot);
    expect(receipt.workspaceOwnershipId).toBe(candidate.ownershipId);

    // Exact candidate identity.
    expect(receipt.candidateSha).toBe(candidate.sha);
    expect(receipt.candidateTree).toBe(candidate.tree);

    // Ordered verification plan.
    expect(receipt.verificationPlan).toEqual(LIVE_PLAN);
    expect(receipt.verificationPlanDigest).toBe(verificationPlanDigest(LIVE_PLAN));

    // Start / end / duration.
    expect(Date.parse(receipt.startedAt)).not.toBeNaN();
    expect(Date.parse(receipt.endedAt)).not.toBeNaN();
    expect(Date.parse(receipt.endedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);

    // Complete bounded per-command evidence, in plan order.
    expect(receipt.commands).toHaveLength(LIVE_PLAN.length);
    expect(receipt.commands.map((entry) => entry.command)).toEqual(LIVE_PLAN);
    for (const entry of receipt.commands) {
      expect(entry).toMatchObject({
        status: "passed",
        classification: "passed",
        exitCode: 0,
        timedOut: false,
        outputTruncated: false,
      });
      expect(typeof entry.stdout).toBe("string");
      expect(typeof entry.stderr).toBe("string");
      expect(Date.parse(entry.startedAt)).not.toBeNaN();
      expect(Date.parse(entry.endedAt)).not.toBeNaN();
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.timeoutMs).toBeGreaterThan(0);
    }

    // Clean checks + outcome.
    expect(receipt.cleanBefore).toBe(true);
    expect(receipt.cleanAfter).toBe(true);
    expect(receipt.outcome).toBe("verified");

    // The caller-visible reference is exactly the receipt's own identity.
    expect(result.verification).toEqual({
      receiptId: receipt.id,
      receiptDigest: receipt.digest,
      runtime: receipt.runtime,
      candidateSha: receipt.candidateSha,
      candidateTree: receipt.candidateTree,
      verificationPlanDigest: receipt.verificationPlanDigest,
    });
  }, 60_000);

  it("bounds retained command output and records the truncation", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-truncation");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    const result = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: ["printf '%0.sx' $(seq 1 4096)"],
      outputLimit: 256,
    });

    const receipt = await readVerificationReceipt(authority.commonDir, result.verification!.receiptId);
    const [entry] = receipt.commands;
    expect(entry?.outputTruncated).toBe(true);
    expect(entry?.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(entry!.stdout)).toBeLessThanOrEqual(4096);
    expect(entry?.stdout).toContain("truncated");
  }, 60_000);

  it("issues a distinct receipt per Verify invocation", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-distinct");

    const first = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: LIVE_PLAN,
    });
    const second = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: LIVE_PLAN,
    });

    expect(first.verification?.receiptId).not.toBe(second.verification?.receiptId);
    expect(first.verification?.candidateSha).toBe(second.verification?.candidateSha);
    expect(first.verification?.verificationPlanDigest).toBe(second.verification?.verificationPlanDigest);
  }, 60_000);

  it("rejects a tampered receipt document instead of trusting its content", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-tampered");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);
    const result = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: LIVE_PLAN,
    });

    const path = verificationReceiptPath(authority.commonDir, result.verification!.receiptId);
    await chmod(path, 0o600);
    const document = JSON.parse(await readFile(path, "utf8")) as VerificationReceiptV1;
    await writeFile(
      path,
      `${JSON.stringify({ ...document, candidateSha: "0".repeat(40) }, null, 2)}\n`,
      "utf8",
    );

    await expect(readVerificationReceipt(authority.commonDir, result.verification!.receiptId)).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_INVALID",
    });
  }, 60_000);

  /**
   * A malformed `commands` block must be refused as EVIDENCE, never explored.
   * Iterating a non-array would raise a TypeError that escapes the typed
   * receipt contract as UNEXPECTED, losing both the failing field and the
   * migration that resolves it.
   */
  it.each([
    ["an object", { "0": { command: "test -f README.md" } }],
    ["a number", 7],
    ["a string", "test -f README.md"],
    ["null", null],
  ])("rejects a receipt whose commands block is %s", async (_label, commands) => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, `spec-171-commands-${_label.replace(/\s+/g, "-")}`);
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);
    const result = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: LIVE_PLAN,
    });
    const original = await readVerificationReceipt(authority.commonDir, result.verification!.receiptId);

    const id = randomUUID();
    const path = verificationReceiptPath(authority.commonDir, id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      `${JSON.stringify({ ...original, id, digest: original.digest, commands }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o400, flag: "wx" },
    );

    const failure = await readVerificationReceipt(authority.commonDir, id).then(
      () => undefined,
      (error: unknown) => error as { code: string; details: { failed: string[]; migration: string } },
    );
    expect(failure, `${_label} commands must be refused`).toBeDefined();
    expect(failure?.code).toBe("VERIFICATION_RECEIPT_INVALID");
    expect(failure?.details.failed).toContain("commands");
    expect(failure?.details.migration).toContain("poiesis verify");
  }, 60_000);
});

describe("non-project-bound Verify compatibility (Spec #168 / tickets #169 / #171)", () => {
  itManagedExecution("still verifies a repository that never installed Poiesis and issues no receipt", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);

    const result = await verify({
      cwd: repository.root,
      candidateSha: repository.baseSha,
      commands: ["test -f README.md"],
    });

    expect(result).toMatchObject({
      candidateSha: repository.baseSha,
      cleanBefore: true,
      cleanAfter: true,
    });
    // No installation means no runtime / adapter / install identity to bind a
    // receipt to, so the compatibility surface verifies without one. Publish is
    // unreachable from here: it requires a Poiesis-owned candidate workspace.
    expect(result.verification).toBeNull();
  }, 60_000);

  it("refuses a receipt id that names no stored document", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-absent");
    const authority = await resolveLifecycleAuthority(candidate.path, candidate.ownershipId);

    await expect(readVerificationReceipt(authority.commonDir, randomUUID())).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_MISSING",
    });
  }, 60_000);
});
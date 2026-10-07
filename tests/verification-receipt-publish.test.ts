/**
 * Spec #168 / ticket #171 — Publish and Preview consume runtime-owned
 * verification evidence.
 *
 * `publish` used to accept a proof document on the caller's word alone: any
 * JSON with `verified: true` and two PASS reviews was enough to push a change
 * branch. Ticket #171 makes Publish resolve the `VerificationReceiptV1` that
 * a proof-scope Verify wrote, revalidate every binding of that stored document
 * against LIVE authority / live plan / live candidate, and carry the resolved
 * receipt identity forward in the Publish evidence that Preview validates.
 *
 * The rejection matrix is the contract: a fabricated, legacy, stale, wrong-plan,
 * wrong-runtime, wrong-owner, wrong-tree, or wrong-SHA receipt must fail closed
 * with its own typed code and a fresh-Verify migration, never with a push.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpoint, publish, resolveTree, verify, workspacePrepare } from "../src/git.js";
import { previewDelivery } from "../src/adapters.js";
import { init } from "../src/maintenance.js";
import { validateProofEvidence, validatePublishEvidence, type PublishEvidence } from "../src/evidence.js";
import type { ProofPayload } from "../src/adapters.js";
import {
  computeVerificationReceiptDigest,
  readVerificationReceipt,
  verificationReceiptPath,
  type VerificationEvidence,
  type VerificationReceiptBodyV1,
  type VerificationReceiptV1,
} from "../src/verification-receipt.js";
import {
  createTestRepository,
  describeManagedExecution,
  itManagedExecution,
  proofShell,
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
  branch: string;
  sha: string;
  tree: string;
  commonDir: string;
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
  const { resolveLifecycleAuthority } = await import("../src/git.js");
  const authority = await resolveLifecycleAuthority(workspace.path, workspace.ownershipId);
  return {
    path: workspace.path,
    ownershipId: workspace.ownershipId,
    branch: workspace.branch,
    sha: accepted.sha,
    tree: await resolveTree(repository.root, accepted.sha),
    commonDir: authority.commonDir,
  };
}

function proofFor(candidate: Candidate, verification?: VerificationEvidence): ProofPayload {
  return verification === undefined
    ? proofShell(candidate.sha, candidate.tree)
    : { ...proofShell(candidate.sha, candidate.tree), verification };
}

/** Run the live plan and return the receipt reference the caller must forward. */
async function verifyCandidate(candidate: Candidate, commands: string[] = LIVE_PLAN): Promise<VerificationEvidence> {
  const result = await verify({
    cwd: candidate.path,
    ownershipId: candidate.ownershipId,
    candidateSha: candidate.sha,
    commands,
  });
  expect(result.verification).not.toBeNull();
  return result.verification!;
}

function publishOptions(repository: TestRepository, candidate: Candidate, proof: ProofPayload) {
  return {
    cwd: candidate.path,
    ownershipId: candidate.ownershipId,
    remote: "origin",
    integrationBranch: "main",
    candidateSha: candidate.sha,
    candidateTree: candidate.tree,
    provider: "fixture" as const,
    project: repository.fixtures,
    title: "candidate",
    body: "body",
    proof,
  };
}

/**
 * Write a receipt the runtime never wrote: internally consistent (its digest
 * authenticates to its own content) but bound to a different installation,
 * plan, workspace, or candidate. This is the real fabrication attack — the
 * document is well formed and self-signed, only its bindings are false.
 */
async function forgeReceipt(
  commonDir: string,
  original: VerificationReceiptV1,
  changes: Partial<VerificationReceiptV1>,
): Promise<VerificationEvidence> {
  const { digest: _runtimeDigest, ...base } = original;
  const body = { ...base, ...changes, id: randomUUID() } as VerificationReceiptBodyV1;
  const receipt: VerificationReceiptV1 = { ...body, digest: computeVerificationReceiptDigest(body) };
  const path = verificationReceiptPath(commonDir, receipt.id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o400, flag: "wx" });
  return {
    receiptId: receipt.id,
    receiptDigest: receipt.digest,
    runtime: receipt.runtime,
    candidateSha: receipt.candidateSha,
    candidateTree: receipt.candidateTree,
    verificationPlanDigest: receipt.verificationPlanDigest,
  };
}

describeManagedExecution("Publish resolves the verification receipt (Spec #168 / ticket #171)", () => {
  itManagedExecution("publishes with a receipt-backed proof and carries the resolved receipt identity in the evidence", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-publish");
    const verification = await verifyCandidate(candidate);

    const result = await publish(publishOptions(repository, candidate, proofFor(candidate, verification)));

    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    // The published evidence carries the RUNTIME's receipt identity — the one
    // Publish resolved out of storage — not the caller's reference verbatim.
    expect(result.evidence.verification).toEqual({
      receiptId: stored.id,
      receiptDigest: stored.digest,
      runtime: stored.runtime,
      candidateSha: stored.candidateSha,
      candidateTree: stored.candidateTree,
      verificationPlanDigest: stored.verificationPlanDigest,
    });
    expect(result.evidence.verified).toBe(true);
    expect(result.publishedHeadSha).toBe(candidate.sha);
  }, 60_000);

  it("rejects a legacy proof that asserts verified without referencing a receipt", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-legacy");

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_REQUIRED",
      details: { migration: expect.stringContaining("poiesis verify") },
    });
    // Nothing was pushed.
    const { run } = await import("../src/process.js");
    const remote = await run("git", ["ls-remote", "--heads", "origin", `refs/heads/${candidate.branch}`], {
      cwd: candidate.path,
    });
    expect(remote.stdout).toBe("");
  }, 60_000);

  itManagedExecution("rejects a reference to a receipt that was never written", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-forged-id");
    const verification = await verifyCandidate(candidate);

    await expect(
      publish(
        publishOptions(repository, candidate, proofFor(candidate, { ...verification, receiptId: randomUUID() })),
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_RECEIPT_MISSING" });
  }, 60_000);

  itManagedExecution("rejects a reference whose digest does not match the stored receipt", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-digest");
    const verification = await verifyCandidate(candidate);

    await expect(
      publish(
        publishOptions(repository, candidate, proofFor(candidate, { ...verification, receiptDigest: "0".repeat(64) })),
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_RECEIPT_INVALID" });
  }, 60_000);

  /**
   * Ticket #186 — the caller's copy of a receipt must AGREE with the document
   * it names.
   *
   * `runtime` and `verificationPlanDigest` were revalidated on the STORED
   * receipt against live authority and the live plan, but never against the
   * reference the caller forwarded. That left a reference free to describe a
   * different runtime or a different plan than the receipt it points at: the
   * evidence a caller carries could disagree with the evidence that is actually
   * proven, while every existing check still passed.
   */
  itManagedExecution("rejects a reference that names a different runtime than the stored receipt", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-ref-runtime");
    const verification = await verifyCandidate(candidate);

    await expect(
      publish(
        publishOptions(repository, candidate, proofFor(candidate, { ...verification, runtime: "9.9.9-other-runtime" })),
      ),
    ).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_RUNTIME_MISMATCH",
      details: { migration: expect.stringContaining("poiesis verify") },
    });
  }, 60_000);

  itManagedExecution("rejects a reference that names a different verification plan than the stored receipt", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-ref-plan");
    const verification = await verifyCandidate(candidate);

    await expect(
      publish(
        publishOptions(repository, candidate, proofFor(candidate, { ...verification, verificationPlanDigest: "c".repeat(64) })),
      ),
    ).rejects.toMatchObject({
      code: "VERIFICATION_PLAN_MISMATCH",
      details: { migration: expect.stringContaining("poiesis verify") },
    });
  }, 60_000);

  itManagedExecution("rejects a reference bound to a different candidate", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-ref-candidate");
    const verification = await verifyCandidate(candidate);

    await expect(
      publish(
        publishOptions(repository, candidate, proofFor(candidate, { ...verification, candidateSha: "1".repeat(40) })),
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_RECEIPT_CANDIDATE_MISMATCH" });
  }, 60_000);

  itManagedExecution("rejects a receipt produced by a different runtime identity", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-runtime");
    const verification = await verifyCandidate(candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, { runtime: "9.9.9-forged-runtime" });

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, forged)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_STALE",
      details: { migration: expect.stringContaining("poiesis verify") },
    });
  }, 60_000);

  itManagedExecution("rejects a receipt produced by a different installation identity", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-install");
    const verification = await verifyCandidate(candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, { installationId: randomUUID() });

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, forged)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_STALE",
    });
  }, 60_000);

  itManagedExecution("rejects a receipt produced by a different workspace ownership identity", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-owner");
    const verification = await verifyCandidate(candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, { workspaceOwnershipId: randomUUID() });

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, forged)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_WORKSPACE_MISMATCH",
    });
  }, 60_000);

  itManagedExecution("rejects a receipt bound to another workspace directory", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-workspace");
    const verification = await verifyCandidate(candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, { workspace: join(repository.parent, "elsewhere") });

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, forged)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_WORKSPACE_MISMATCH",
    });
  }, 60_000);

  itManagedExecution("rejects a receipt bound to another candidate SHA", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-sha");
    const verification = await verifyCandidate(candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, { candidateSha: "2".repeat(40) });

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, forged)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_CANDIDATE_MISMATCH",
    });
  }, 60_000);

  itManagedExecution("rejects a receipt bound to another candidate tree", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-tree");
    const verification = await verifyCandidate(candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, { candidateTree: "3".repeat(40) });

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, forged)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_CANDIDATE_MISMATCH",
    });
  }, 60_000);

  itManagedExecution("rejects a receipt produced by a weaker plan than the installation's live plan", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-wrong-plan");
    // A real Verify, real commands, real receipt — just not the live plan.
    const verification = await verifyCandidate(candidate, ["printf weaker-plan"]);

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, verification)))).rejects.toMatchObject({
      code: "VERIFICATION_PLAN_MISMATCH",
      details: { migration: expect.stringContaining("poiesis verify") },
    });
  }, 60_000);

  itManagedExecution("rejects a receipt whose stored plan records do not match its own plan", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-incomplete-commands");
    const verification = await verifyCandidate(candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, {
      commands: stored.commands.slice(0, 1),
    });

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, forged)))).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_INVALID",
    });
  }, 60_000);

  itManagedExecution("rejects a receipt that records a failed verification", async () => {
    // The live plan itself fails, so the receipt is plan-complete and only the
    // OUTCOME separates it from a proof-worthy receipt.
    const failingPlan = ["test -f README.md", "test -f absent-file.txt"];
    const repository = await installedRepository(failingPlan);
    const candidate = await acceptedCandidate(repository, "spec-171-failed-outcome");
    const failure = await verify({
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.sha,
      commands: failingPlan,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const verification = (failure as { code?: string; details?: { verification?: VerificationEvidence } });
    expect(verification.code).toBe("VERIFICATION_FAILED");
    const reference = verification.details?.verification;
    expect(reference).toBeDefined();
    const stored = await readVerificationReceipt(candidate.commonDir, reference!.receiptId);
    expect(stored.outcome).toBe("failed");
    expect(stored.cleanAfter).toBe(true);
    expect(stored.verificationPlan).toEqual(failingPlan);
    expect(stored.commands.map((entry) => entry.classification)).toEqual(["passed", "command-failed"]);

    await expect(publish(publishOptions(repository, candidate, proofFor(candidate, reference!)))).rejects.toMatchObject(
      { code: "VERIFICATION_OUTCOME_NOT_VERIFIED" },
    );
  }, 60_000);

  itManagedExecution("still requires the candidate-bound reviews after the receipt is resolved", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-reviews");
    const verification = await verifyCandidate(candidate);
    const base = proofFor(candidate, verification);

    await expect(
      publish(
        publishOptions(repository, candidate, {
          ...base,
          specReview: { verdict: "FAIL" as unknown as "PASS", reviewerIdentity: "spec" },
        }),
      ),
    ).rejects.toMatchObject({ code: "PROOF_REVIEW_FAILED" });
    await expect(
      publish(
        publishOptions(repository, candidate, {
          ...base,
          standardsReview: { verdict: "PASS", reviewerIdentity: " " },
        }),
      ),
    ).rejects.toMatchObject({ code: "PROOF_REVIEW_IDENTITY_MISSING" });
  }, 60_000);
});

/** Verify then Publish the candidate, returning the canonical evidence. */
async function publishCandidate(repository: TestRepository, candidate: Candidate): Promise<PublishEvidence> {
  const verification = await verifyCandidate(candidate);
  const published = await publish(publishOptions(repository, candidate, proofFor(candidate, verification)));
  return published.evidence;
}

describeManagedExecution("Preview validates forwarded Publish evidence (Spec #168 / ticket #171)", () => {
  it("accepts forwarded evidence that carries the resolved receipt and revalidates the remote head", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-preview");
    const evidence = await publishCandidate(repository, candidate);

    const preview = await previewDelivery(
      { adapter: "fixture", path: join(repository.fixtures, "delivery") },
      {
        sha: candidate.sha,
        candidateTree: candidate.tree,
        proof: proofFor(candidate, evidence.verification),
        publish: evidence,
        remote: "origin",
      },
      candidate.path,
    );

    expect(preview).toMatchObject({ target: "preview", verified: true, candidateSha: candidate.sha });
  }, 60_000);

  it("rejects forwarded evidence that carries no verification receipt", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-preview-legacy");
    const evidence = await publishCandidate(repository, candidate);
    const legacy = { ...evidence } as Partial<PublishEvidence>;
    delete legacy.verification;

    await expect(
      previewDelivery(
        { adapter: "fixture", path: join(repository.fixtures, "delivery") },
        {
          sha: candidate.sha,
          candidateTree: candidate.tree,
          proof: proofFor(candidate, evidence.verification),
          publish: legacy as PublishEvidence,
          remote: "origin",
        },
        candidate.path,
      ),
    ).rejects.toMatchObject({ code: "PUBLISH_VERIFICATION_EVIDENCE_MISSING" });
  }, 60_000);

  it("rejects forwarded evidence whose receipt is malformed", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-preview-malformed");
    const evidence = await publishCandidate(repository, candidate);

    await expect(
      previewDelivery(
        { adapter: "fixture", path: join(repository.fixtures, "delivery") },
        {
          sha: candidate.sha,
          candidateTree: candidate.tree,
          proof: proofFor(candidate, evidence.verification),
          publish: {
            ...evidence,
            verification: { ...evidence.verification, receiptDigest: "not-a-digest" },
          },
          remote: "origin",
        },
        candidate.path,
      ),
    ).rejects.toMatchObject({ code: "PUBLISH_VERIFICATION_EVIDENCE_INVALID" });
  }, 60_000);

  it("rejects forwarded evidence whose receipt names another candidate", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-171-preview-candidate");
    const evidence = await publishCandidate(repository, candidate);

    await expect(
      previewDelivery(
        { adapter: "fixture", path: join(repository.fixtures, "delivery") },
        {
          sha: candidate.sha,
          candidateTree: candidate.tree,
          proof: proofFor(candidate, evidence.verification),
          publish: {
            ...evidence,
            verification: { ...evidence.verification, candidateTree: "4".repeat(40) },
          },
          remote: "origin",
        },
        candidate.path,
      ),
    ).rejects.toMatchObject({ code: "PUBLISH_VERIFICATION_IDENTITY_MISMATCH" });
  }, 60_000);
});

/**
 * Spec #168 / ticket #186 — Preview resolves the FORWARDED receipt.
 *
 * Preview used to perform structural proof/Publish validation and remote-head
 * revalidation and then run the adapter. It never resolved the receipt those
 * documents name, so any well-formed reference moved a delivery forward: a
 * receipt that was never written, a digest that does not match the stored
 * document, a receipt minted by another installation or another plan, and a
 * Publish whose evidence rested on a DIFFERENT receipt than the proof did were
 * all indistinguishable from a real one at the delivery boundary.
 *
 * The authoritative boundary — `previewDelivery`, the same lifecycle seam the
 * CLI dispatches through — now authenticates BOTH references against primary
 * lifecycle authority and the live verification plan, requires them to identify
 * the same resolved receipt, and refuses before any adapter side effect. The
 * candidate/tree/remote-head contract the adapters enforce is unchanged.
 */
describeManagedExecution("Preview authenticates the forwarded verification receipt (Spec #168 / ticket #186)", () => {
  function fixtureDelivery(repository: TestRepository) {
    return { adapter: "fixture" as const, path: join(repository.fixtures, "delivery") };
  }

  /** The immutable artifact record the fixture adapter would have written. */
  async function fixtureRecords(repository: TestRepository): Promise<string[]> {
    try {
      return (await readdir(join(repository.fixtures, "delivery", "candidates"))).sort();
    } catch {
      return [];
    }
  }

  function preview(
    repository: TestRepository,
    candidate: Candidate,
    proof: ProofPayload,
    publishEvidenceDocument: PublishEvidence,
  ) {
    return previewDelivery(
      fixtureDelivery(repository),
      { sha: candidate.sha, candidateTree: candidate.tree, proof, publish: publishEvidenceDocument, remote: "origin" },
      candidate.path,
    );
  }

  it("rejects a forwarded receipt that was never written, before any adapter side effect", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-preview-absent");
    const evidence = await publishCandidate(repository, candidate);

    await expect(
      preview(repository, candidate, proofFor(candidate, { ...evidence.verification, receiptId: randomUUID() }), evidence),
    ).rejects.toMatchObject({ code: "VERIFICATION_RECEIPT_MISSING" });
    expect(await fixtureRecords(repository)).toEqual([]);
  }, 60_000);

  it("rejects a forwarded receipt whose digest does not match the stored document", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-preview-digest");
    const evidence = await publishCandidate(repository, candidate);

    await expect(
      preview(
        repository,
        candidate,
        proofFor(candidate, { ...evidence.verification, receiptDigest: "0".repeat(64) }),
        evidence,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_RECEIPT_INVALID" });
    expect(await fixtureRecords(repository)).toEqual([]);
  }, 60_000);

  it("rejects a forwarded receipt minted by a different installation identity", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-preview-stale");
    const evidence = await publishCandidate(repository, candidate);
    const stored = await readVerificationReceipt(candidate.commonDir, evidence.verification.receiptId);
    const forged = await forgeReceipt(candidate.commonDir, stored, { installationId: randomUUID() });

    await expect(preview(repository, candidate, proofFor(candidate, forged), evidence)).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_STALE",
      details: { migration: expect.stringContaining("poiesis verify") },
    });
    expect(await fixtureRecords(repository)).toEqual([]);
  }, 60_000);

  it("rejects a forwarded receipt produced by a different verification plan than the live plan", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-preview-plan");
    const evidence = await publishCandidate(repository, candidate);
    // A real second Verify of the same candidate against a weaker plan: a real
    // receipt, real commands, and an identity that resolves out of storage.
    const weaker = await verifyCandidate(candidate, ["printf weaker-plan"]);

    await expect(preview(repository, candidate, proofFor(candidate, weaker), evidence)).rejects.toMatchObject({
      code: "VERIFICATION_PLAN_MISMATCH",
    });
    expect(await fixtureRecords(repository)).toEqual([]);
  }, 60_000);

  it("rejects a forwarded receipt that identifies a different candidate", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-preview-candidate");
    const evidence = await publishCandidate(repository, candidate);

    await expect(
      preview(
        repository,
        candidate,
        proofFor(candidate, { ...evidence.verification, candidateSha: "5".repeat(40) }),
        evidence,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_RECEIPT_CANDIDATE_MISMATCH" });
    expect(await fixtureRecords(repository)).toEqual([]);
  }, 60_000);

  it("rejects a proof whose receipt is the one Publish did not resolve", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-preview-disagreement");
    const evidence = await publishCandidate(repository, candidate);
    // Two real receipts for the SAME candidate and plan. Both authenticate;
    // they are simply not the same proof.
    const other = await verifyCandidate(candidate);

    await expect(preview(repository, candidate, proofFor(candidate, other), evidence)).rejects.toMatchObject({
      code: "PUBLISH_VERIFICATION_IDENTITY_MISMATCH",
      details: { migration: expect.stringContaining("poiesis verify") },
    });
    expect(await fixtureRecords(repository)).toEqual([]);
  }, 60_000);

  it("rejects a legacy proof that asserts verified without naming a receipt", async () => {
    const repository = await installedRepository();
    const candidate = await acceptedCandidate(repository, "spec-186-preview-legacy-proof");
    const evidence = await publishCandidate(repository, candidate);

    await expect(preview(repository, candidate, proofFor(candidate), evidence)).rejects.toMatchObject({
      code: "VERIFICATION_RECEIPT_REQUIRED",
    });
    expect(await fixtureRecords(repository)).toEqual([]);
  }, 60_000);
});

describe("evidence validators keep their structural boundary (Spec #168 / ticket #171)", () => {
  it("validates the receipt reference carried by Publish evidence", () => {
    const evidence: PublishEvidence = {
      candidateSha: "1".repeat(40),
      candidateTree: "2".repeat(40),
      verified: true,
      branch: "poiesis/receipt",
      remoteRef: "refs/heads/poiesis/receipt",
      publishedHeadSha: "1".repeat(40),
      provider: "fixture",
      action: "pushed",
      changeRequest: { id: null, url: null },
      verification: {
        receiptId: "receipt",
        receiptDigest: "a".repeat(64),
        runtime: "1.4.0",
        candidateSha: "1".repeat(40),
        candidateTree: "2".repeat(40),
        verificationPlanDigest: "b".repeat(64),
      },
    };
    expect(() =>
      validatePublishEvidence(evidence, "1".repeat(40), "2".repeat(40), "poiesis/receipt", "refs/heads/poiesis/receipt"),
    ).not.toThrow();
    expect(() =>
      validatePublishEvidence(
        { ...evidence, verification: { ...evidence.verification, runtime: "" } },
        "1".repeat(40),
        "2".repeat(40),
        "poiesis/receipt",
        "refs/heads/poiesis/receipt",
      ),
    ).toThrow(expect.objectContaining({ code: "PUBLISH_VERIFICATION_EVIDENCE_INVALID" }));
  });

  it("leaves proof-structure validation to the boundary that can resolve authority", () => {
    const tree = "2".repeat(40);
    const sha = "1".repeat(40);
    // A legacy proof stays structurally valid: the receipt requirement belongs
    // to Publish, the operation that resolves live authority, not to the pure
    // validator every delivery adapter shares.
    expect(() => validateProofEvidence(proofShell(sha, tree), sha, tree)).not.toThrow();
  });
});
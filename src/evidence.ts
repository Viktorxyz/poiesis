import { invariant } from "./errors.js";

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export interface ReviewVerdictEvidence {
  verdict: "PASS";
  reviewerIdentity: string;
}

export interface ProofEvidence {
  candidateSha: string;
  candidateTree: string;
  verified: true;
  specReview: ReviewVerdictEvidence;
  standardsReview: ReviewVerdictEvidence;
}

export interface StagingEvidence {
  candidateSha: string;
  candidateTree: string;
  target: "staging";
  artifactIdentity: string;
  verified: true;
}

export interface IntegrationEvidence {
  candidateSha: string;
  candidateTree: string;
  integrationSha: string;
  integrationTree: string;
  contentMatchesCandidate: true;
}

export interface ProductionAuthorization {
  productionAuthorization: string;
}

export function validateProofEvidence(proof: ProofEvidence, candidateSha: string, candidateTree: string): void {
  invariant(isRecord(proof), "INVALID_PROOF_EVIDENCE", "Proof evidence must be an object");
  invariant(proof.candidateSha === candidateSha, "PROOF_IDENTITY_MISMATCH", "Proof belongs to a different candidate", {
    expected: candidateSha,
    actual: proof.candidateSha,
  });
  invariant(SHA_PATTERN.test(proof.candidateTree), "PROOF_TREE_MISSING", "Proof is missing a valid candidate tree hash");
  invariant(proof.candidateTree === candidateTree, "PROOF_TREE_MISMATCH", "Proof belongs to a different candidate tree", {
    expected: candidateTree,
    actual: proof.candidateTree,
  });
  invariant(proof.verified === true, "PROOF_INCOMPLETE", "Deterministic verification has not passed");
  validateReview(proof.specReview, "Spec Review");
  validateReview(proof.standardsReview, "Standards Review");
}

export function validateStagingEvidence(staging: StagingEvidence, candidateSha: string, candidateTree: string): void {
  invariant(isRecord(staging), "INVALID_STAGING_EVIDENCE", "Staging evidence must be an object");
  invariant(
    staging.candidateSha === candidateSha,
    "STAGING_IDENTITY_MISMATCH",
    "Staging evidence belongs to a different candidate",
    { expected: candidateSha, actual: staging.candidateSha },
  );
  invariant(SHA_PATTERN.test(staging.candidateTree), "STAGING_TREE_MISSING", "Staging evidence is missing a candidate tree hash");
  invariant(
    staging.candidateTree === candidateTree,
    "STAGING_TREE_MISMATCH",
    "Staging evidence belongs to a different candidate tree",
    { expected: candidateTree, actual: staging.candidateTree },
  );
  invariant(staging.target === "staging", "STAGING_TARGET_MISMATCH", "Staging evidence must come from the Staging target");
  invariant(staging.verified === true, "STAGING_NOT_VERIFIED", "Staging verification has not passed");
  invariant(
    typeof staging.artifactIdentity === "string" && staging.artifactIdentity.trim().length > 0,
    "STAGING_IDENTITY_MISSING",
    "Staging artifact identity is required",
  );
}

export function validateIntegrationEvidence(integration: IntegrationEvidence, acceptedCandidateSha: string, acceptedCandidateTree: string): void {
  invariant(
    integration.candidateSha === acceptedCandidateSha,
    "INTEGRATION_IDENTITY_MISMATCH",
    "Integration evidence belongs to a different candidate",
    { expected: acceptedCandidateSha, actual: integration.candidateSha },
  );
  invariant(
    integration.candidateTree === acceptedCandidateTree,
    "INTEGRATED_CONTENT_MISMATCH",
    "Integrated content does not match the accepted candidate tree",
    { expected: acceptedCandidateTree, actual: integration.candidateTree },
  );
  invariant(SHA_PATTERN.test(integration.integrationSha), "INTEGRATION_IDENTITY_MISSING", "Exact integrated revision is required");
  invariant(SHA_PATTERN.test(integration.integrationTree), "INTEGRATION_TREE_MISSING", "Integrated tree hash is missing or invalid");
  invariant(
    integration.integrationTree === acceptedCandidateTree,
    "INTEGRATED_TREE_MISMATCH",
    "Integrated tree does not match the accepted candidate tree",
    { expected: acceptedCandidateTree, actual: integration.integrationTree },
  );
  invariant(
    integration.contentMatchesCandidate === true,
    "INTEGRATED_TREE_MISMATCH",
    "Integrated content has not been proven equal to the accepted candidate",
  );
}

function validateReview(review: ReviewVerdictEvidence, label: string): void {
  invariant(isRecord(review), "INVALID_PROOF_REVIEW", `${label} evidence must be an object`);
  invariant(review.verdict === "PASS", "PROOF_REVIEW_FAILED", `${label} did not pass`);
  invariant(
    typeof review.reviewerIdentity === "string" && review.reviewerIdentity.trim().length > 0,
    "PROOF_REVIEW_IDENTITY_MISSING",
    `${label} identity is required`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

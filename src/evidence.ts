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
  artifactIdentity: string;
  verified: true;
}

export interface IntegrationEvidence {
  candidateTree: string;
  candidateSha?: string;
  integrationSha: string;
  integrationTree: string;
  contentMatchesCandidate: true;
}

export interface ProductionAuthorization {
  productionAuthorization: string;
}

export function validateProofEvidence(proof: ProofEvidence, candidateSha: string): void {
  invariant(proof.candidateSha === candidateSha, "PROOF_IDENTITY_MISMATCH", "Proof belongs to a different candidate", {
    expected: candidateSha,
    actual: proof.candidateSha,
  });
  invariant(SHA_PATTERN.test(proof.candidateTree), "PROOF_TREE_MISSING", "Proof is missing a valid candidate tree hash");
  invariant(proof.verified === true, "PROOF_INCOMPLETE", "Deterministic verification has not passed");
  validateReview(proof.specReview, "Spec Review");
  validateReview(proof.standardsReview, "Standards Review");
}

export function validateStagingEvidence(staging: StagingEvidence, candidateSha: string): void {
  invariant(
    staging.candidateSha === candidateSha,
    "STAGING_IDENTITY_MISMATCH",
    "Staging evidence belongs to a different candidate",
    { expected: candidateSha, actual: staging.candidateSha },
  );
  invariant(SHA_PATTERN.test(staging.candidateTree), "STAGING_TREE_MISSING", "Staging evidence is missing a candidate tree hash");
  invariant(staging.verified === true, "STAGING_NOT_VERIFIED", "Staging verification has not passed");
  invariant(staging.artifactIdentity.trim().length > 0, "STAGING_IDENTITY_MISSING", "Staging artifact identity is required");
}

export function validateIntegrationEvidence(integration: IntegrationEvidence, acceptedCandidateTree: string): void {
  invariant(
    integration.candidateTree === acceptedCandidateTree,
    "INTEGRATED_CONTENT_MISMATCH",
    "Integrated content does not match the accepted candidate tree",
    { expected: acceptedCandidateTree, actual: integration.candidateTree },
  );
  invariant(SHA_PATTERN.test(integration.integrationSha), "INTEGRATION_IDENTITY_MISSING", "Exact integrated revision is required");
  invariant(SHA_PATTERN.test(integration.integrationTree), "INTEGRATION_TREE_MISSING", "Integrated tree hash is missing or invalid");
  invariant(
    integration.contentMatchesCandidate === true,
    "INTEGRATED_TREE_MISMATCH",
    "Integrated content has not been proven equal to the accepted candidate",
  );
}

function validateReview(review: ReviewVerdictEvidence, label: string): void {
  invariant(review.verdict === "PASS", "PROOF_REVIEW_FAILED", `${label} did not pass`);
  invariant(review.reviewerIdentity.trim().length > 0, "PROOF_REVIEW_IDENTITY_MISSING", `${label} identity is required`);
}

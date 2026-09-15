import { invariant } from "./errors.js";

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export type PublishProvider = "github" | "gitlab" | "fixture" | "command";

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
  candidateSha: string;
  candidateTree: string;
  stagingArtifactIdentity: string;
  integrationSha: string;
  authorIdentity: string;
  approved: true;
}

export interface PublishEvidence {
  candidateSha: string;
  candidateTree: string;
  verified: true;
  branch: string;
  remoteRef: string;
  publishedHeadSha: string;
  provider: PublishProvider;
  action: "created" | "updated" | "pushed";
  changeRequest: {
    id: string | null;
    url: string | null;
  };
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
  invariant(isRecord(integration), "INVALID_INTEGRATION_EVIDENCE", "Integration evidence must be an object");
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

export function validateProductionAuthorization(
  authorization: ProductionAuthorization,
  candidateSha: string,
  candidateTree: string,
  staging: StagingEvidence,
  integration: IntegrationEvidence,
): void {
  invariant(
    authorization !== undefined && authorization !== null,
    "PRODUCTION_AUTHORIZATION_REQUIRED",
    "Production requires explicit Author authorization",
  );
  invariant(isRecord(authorization), "INVALID_PRODUCTION_AUTHORIZATION", "Production authorization must be an object");
  invariant(authorization.approved === true, "PRODUCTION_AUTHORIZATION_REQUIRED", "Production requires explicit Author approval");
  invariant(
    typeof authorization.authorIdentity === "string" && authorization.authorIdentity.trim().length > 0,
    "PRODUCTION_AUTHOR_IDENTITY_MISSING",
    "Production authorization requires an Author identity",
  );
  invariant(
    authorization.candidateSha === candidateSha && authorization.candidateTree === candidateTree,
    "PRODUCTION_AUTHORIZATION_CANDIDATE_MISMATCH",
    "Production authorization belongs to a different candidate",
  );
  invariant(
    authorization.stagingArtifactIdentity === staging.artifactIdentity,
    "PRODUCTION_AUTHORIZATION_STAGING_MISMATCH",
    "Production authorization belongs to a different Staging artifact",
  );
  invariant(
    authorization.integrationSha === integration.integrationSha,
    "PRODUCTION_AUTHORIZATION_INTEGRATION_MISMATCH",
    "Production authorization belongs to a different integration revision",
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

export function validatePublishEvidence(
  evidence: PublishEvidence,
  expectedSha: string,
  expectedTree: string,
  expectedBranch: string,
  expectedRemoteRef: string,
): void {
  invariant(isRecord(evidence), "INVALID_PUBLISH_EVIDENCE", "Publish evidence must be an object");
  invariant(
    evidence.candidateSha === expectedSha,
    "PUBLISH_IDENTITY_MISMATCH",
    "Publish evidence belongs to a different candidate",
    { expected: expectedSha, actual: evidence.candidateSha },
  );
  invariant(SHA_PATTERN.test(evidence.candidateTree), "PUBLISH_TREE_MISSING", "Publish evidence is missing a valid candidate tree hash");
  invariant(
    evidence.candidateTree === expectedTree,
    "PUBLISH_TREE_MISMATCH",
    "Publish evidence belongs to a different candidate tree",
    { expected: expectedTree, actual: evidence.candidateTree },
  );
  invariant(
    evidence.verified === true,
    "PUBLISH_NOT_VERIFIED",
    "Publish evidence must report verified: true after successful push and provider completion",
  );
  invariant(
    evidence.branch === expectedBranch,
    "PUBLISH_BRANCH_MISMATCH",
    "Publish evidence references a different change branch",
    { expected: expectedBranch, actual: evidence.branch },
  );
  invariant(
    evidence.remoteRef === expectedRemoteRef,
    "PUBLISH_REMOTE_REF_MISMATCH",
    "Publish evidence references a different change ref",
    { expected: expectedRemoteRef, actual: evidence.remoteRef },
  );
  invariant(
    SHA_PATTERN.test(evidence.publishedHeadSha),
    "PUBLISH_HEAD_MISSING",
    "Publish evidence is missing a valid published head SHA",
  );
  invariant(
    evidence.publishedHeadSha === expectedSha,
    "PUBLISH_HEAD_MISMATCH",
    "Publish evidence remote head does not match the exact candidate",
    { expected: expectedSha, actual: evidence.publishedHeadSha },
  );
  invariant(
    evidence.action === "created" || evidence.action === "updated" || evidence.action === "pushed",
    "PUBLISH_ACTION_INVALID",
    "Publish evidence action must be created, updated, or pushed",
    { action: evidence.action },
  );
  invariant(isRecord(evidence.changeRequest), "INVALID_PUBLISH_EVIDENCE", "Publish evidence changeRequest must be an object");
  invariant(
    evidence.changeRequest.id === null || (typeof evidence.changeRequest.id === "string" && evidence.changeRequest.id.length > 0),
    "PUBLISH_REQUEST_ID_INVALID",
    "Publish evidence changeRequest.id must be a non-empty string or null",
  );
  invariant(
    evidence.changeRequest.url === null || (typeof evidence.changeRequest.url === "string" && evidence.changeRequest.url.length > 0),
    "PUBLISH_REQUEST_URL_INVALID",
    "Publish evidence changeRequest.url must be a non-empty string or null",
  );
}

/**
 * Ticket #49 — Require Publish evidence before Preview.
 *
 * Preview must consume the same canonical, candidate-bound Publish
 * evidence that drove the successful Publish operation, never a
 * reconstructed or fabricated substitute. This validator enforces
 * every contract surface that a downstream Preview call relies on:
 *
 *   - the schema-shape and verified:true contract from
 *   `validatePublishEvidence`, anchored to the exact candidate SHA and
 *   tree passed to Preview;
 *   - cross-consistency between `branch` and `remoteRef`
 *   (`refs/heads/<branch>`), preventing a tampered ref string from
 *   hiding an unrelated change branch;
 *   - an explicit allow-list of publish providers, rejecting evidence
 *   that names an unknown or fabricated provider;
 *   - the action allow-list (`created` | `updated` | `pushed`),
 *   refusing any state that signals a failed, closed, or otherwise
 *   non-success Publish operation;
 *   - the changeRequest id/url string-or-null contract, rejecting
 *   evidence that fabricates non-string placeholders for the change
 *   request coordinates;
 *   - rejection of empty/whitespace identifiers in any string
 *   identity field, refusing evidence that smuggles in a
 *   human-readable-but-unverifiable placeholder.
 *
 * The remote change-branch head is revalidated separately against the
 * repository so that a force-pushed or rebased branch cannot be used
 * to back-date a Preview claim; that revalidation lives in the
 * adapter to keep this function pure.
 */
export function validatePreviewPublishEvidence(
  evidence: PublishEvidence,
  candidateSha: string,
  candidateTree: string,
): void {
  invariant(isRecord(evidence), "INVALID_PUBLISH_EVIDENCE", "Preview requires matching Publish evidence");
  validatePublishEvidence(evidence, candidateSha, candidateTree, evidence.branch, evidence.remoteRef);
  const expectedRemoteRef = `refs/heads/${evidence.branch}`;
  invariant(
    evidence.remoteRef === expectedRemoteRef,
    "PUBLISH_REMOTE_REF_INCONSISTENT",
    "Publish evidence remoteRef must equal refs/heads/<branch>",
    { expected: expectedRemoteRef, actual: evidence.remoteRef, branch: evidence.branch },
  );
  invariant(
    typeof evidence.provider === "string" && PUBLISH_PROVIDERS.includes(evidence.provider as PublishProvider),
    "PUBLISH_PROVIDER_INVALID",
    "Publish evidence provider is not a supported publish provider",
    { provider: evidence.provider },
  );
  invariant(
    typeof evidence.branch === "string" && evidence.branch.trim().length > 0,
    "PUBLISH_BRANCH_MISSING",
    "Publish evidence branch must be a non-empty string",
    { branch: evidence.branch },
  );
  invariant(
    typeof evidence.publishedHeadSha === "string" && evidence.publishedHeadSha.trim().length > 0,
    "PUBLISH_HEAD_MISSING",
    "Publish evidence publishedHeadSha must be a non-empty string",
    { publishedHeadSha: evidence.publishedHeadSha },
  );
}

const PUBLISH_PROVIDERS: readonly PublishProvider[] = ["github", "gitlab", "fixture", "command"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type {
  TeamInboxSpecApplyResult,
  TeamInboxSpecDraftDetail,
  TeamInboxSpecDraftSummary,
  TeamInboxSpecPage,
  TeamInboxSpecPreviewEnvelope,
  TeamInboxSpecProposalDetail,
  TeamInboxSpecProposalSummary,
} from "../../contracts/workflow.js";

export function projectInboxDraftPage(
  value: TeamInboxSpecPage<TeamInboxSpecDraftSummary>,
): TeamInboxSpecPage<TeamInboxSpecDraftSummary> {
  return structuredClone(value);
}

export function projectInboxDraft(
  value: TeamInboxSpecDraftDetail,
): TeamInboxSpecDraftDetail {
  return structuredClone(value);
}

export function projectInboxProposalPage(
  value: TeamInboxSpecPage<TeamInboxSpecProposalSummary>,
): TeamInboxSpecPage<TeamInboxSpecProposalSummary> {
  return structuredClone(value);
}

export function projectInboxProposal(
  value: TeamInboxSpecProposalDetail,
): TeamInboxSpecProposalDetail {
  return structuredClone(value);
}

export function projectInboxPreview(
  value: TeamInboxSpecPreviewEnvelope,
): TeamInboxSpecPreviewEnvelope {
  return structuredClone(value);
}

export function projectInboxApply(
  value: TeamInboxSpecApplyResult,
): TeamInboxSpecApplyResult {
  return structuredClone(value);
}

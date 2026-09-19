import type {
  TeamRelayApplyResult,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayDraftSummary,
  TeamRelayPage,
  TeamRelayPreviewEnvelope,
  TeamRelaySummary,
} from "../../contracts/workflow.js";

export function projectRelayDraftPage(
  value: TeamRelayPage<TeamRelayDraftSummary>,
): TeamRelayPage<TeamRelayDraftSummary> {
  return structuredClone(value);
}

export function projectRelayDraft(
  value: TeamRelayDraftDetail,
): TeamRelayDraftDetail {
  return structuredClone(value);
}

export function projectRelayPage(
  value: TeamRelayPage<TeamRelaySummary>,
): TeamRelayPage<TeamRelaySummary> {
  return structuredClone(value);
}

export function projectRelay(
  value: TeamRelayDetail,
): TeamRelayDetail {
  return structuredClone(value);
}

export function projectRelayPreview(
  value: TeamRelayPreviewEnvelope,
): TeamRelayPreviewEnvelope {
  return structuredClone(value);
}

export function projectRelayApply(
  value: TeamRelayApplyResult,
): TeamRelayApplyResult {
  return structuredClone(value);
}

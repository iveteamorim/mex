import type {
  TeamInboxDraftListRequest,
  TeamInboxProposalListRequest,
  TeamInboxSpecApplyResult,
  TeamInboxSpecCommand,
  TeamInboxSpecDraftDetail,
  TeamInboxSpecDraftSummary,
  TeamInboxSpecPage,
  TeamInboxSpecPreviewEnvelope,
  TeamInboxSpecProposalDetail,
  TeamInboxSpecProposalSummary,
} from "../../contracts/workflow.js";

/** Narrow product seam shared by the root CLI and the private Hub adapter. */
export interface TeamInboxSpecCliService {
  getInboxDraft(id: string): Promise<TeamInboxSpecDraftDetail | null>;
  listInboxDrafts(
    request?: TeamInboxDraftListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecDraftSummary>>;
  getInboxProposal(id: string): Promise<TeamInboxSpecProposalDetail | null>;
  listInboxProposals(
    request?: TeamInboxProposalListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecProposalSummary>>;
  previewInbox(command: TeamInboxSpecCommand): Promise<TeamInboxSpecPreviewEnvelope>;
  applyInbox(envelope: TeamInboxSpecPreviewEnvelope): Promise<TeamInboxSpecApplyResult>;
}

export type TeamInboxSpecCliServiceFactory = () =>
  | TeamInboxSpecCliService
  | Promise<TeamInboxSpecCliService>;

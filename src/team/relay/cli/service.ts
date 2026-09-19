import type {
  TeamRelayApplyResult,
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayDraftListRequest,
  TeamRelayDraftSummary,
  TeamRelayListRequest,
  TeamRelayPage,
  TeamRelayPreviewEnvelope,
  TeamRelaySummary,
} from "../../contracts/workflow.js";

/** Narrow Relay product seam shared by the root CLI and private Hub adapter. */
export interface TeamRelayCliService {
  getRelayDraft(id: string): Promise<TeamRelayDraftDetail | null>;
  listRelayDrafts(
    request?: TeamRelayDraftListRequest,
  ): Promise<TeamRelayPage<TeamRelayDraftSummary>>;
  getRelay(id: string): Promise<TeamRelayDetail | null>;
  listRelays(
    request?: TeamRelayListRequest,
  ): Promise<TeamRelayPage<TeamRelaySummary>>;
  previewRelay(command: TeamRelayCommand): Promise<TeamRelayPreviewEnvelope>;
  applyRelay(envelope: TeamRelayPreviewEnvelope): Promise<TeamRelayApplyResult>;
}

export type TeamRelayCliServiceFactory = () =>
  | TeamRelayCliService
  | Promise<TeamRelayCliService>;

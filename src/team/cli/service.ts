import type { JsonValue } from "../contracts/shared.js";
import type {
  StoredActivityEvent,
  TeamActivityListRequest,
  TeamCurrentActor,
  TeamIdentityActivityCommand,
  TeamIdentityActivityPreviewEnvelope,
  TeamMember,
  TeamMemberListRequest,
  TeamPage,
  TeamWorkstreamCommand,
  TeamWorkstreamListRequest,
  TeamWorkstreamPreviewEnvelope,
  TeamWorkflowResult,
  Workstream,
} from "../contracts/workflow.js";

/** Small structural seam used by command tests and by later root registration. */
export interface TeamIdentityActivityCliService<
  TWikiPayload extends JsonValue = JsonValue,
> {
  getMember(id: string): Promise<TeamMember | null>;
  listMembers(request?: TeamMemberListRequest): Promise<TeamPage<TeamMember>>;
  getCurrentActor(): Promise<TeamCurrentActor>;
  getActivity(id: string): Promise<StoredActivityEvent | null>;
  listActivity(request?: TeamActivityListRequest): Promise<TeamPage<StoredActivityEvent>>;
  previewIdentityActivity(
    command: TeamIdentityActivityCommand,
  ): Promise<TeamIdentityActivityPreviewEnvelope>;
  applyIdentityActivity(
    envelope: TeamIdentityActivityPreviewEnvelope,
  ): Promise<TeamWorkflowResult<TWikiPayload>>;
}

export type TeamIdentityActivityCliServiceFactory<
  TWikiPayload extends JsonValue = JsonValue,
> = () =>
  | TeamIdentityActivityCliService<TWikiPayload>
  | Promise<TeamIdentityActivityCliService<TWikiPayload>>;

/** Checkpoint D's internal Workstream application seam. */
export interface TeamWorkstreamCliService<
  TWikiPayload extends JsonValue = JsonValue,
> {
  getWorkstream(id: string): Promise<Workstream | null>;
  listWorkstreams(request?: TeamWorkstreamListRequest): Promise<TeamPage<Workstream>>;
  previewWorkstream(command: TeamWorkstreamCommand): Promise<TeamWorkstreamPreviewEnvelope>;
  applyWorkstream(
    envelope: TeamWorkstreamPreviewEnvelope,
  ): Promise<TeamWorkflowResult<TWikiPayload>>;
}

export type TeamWorkstreamCliServiceFactory<
  TWikiPayload extends JsonValue = JsonValue,
> = () =>
  | TeamWorkstreamCliService<TWikiPayload>
  | Promise<TeamWorkstreamCliService<TWikiPayload>>;

/**
 * Make the integration dependency explicit without importing the concrete
 * repository-bound port into the leaf CLI layer.
 */
export function asTeamIdentityActivityCliService<
  TWikiPayload extends JsonValue,
>(
  port: TeamIdentityActivityCliService<TWikiPayload>,
): TeamIdentityActivityCliService<TWikiPayload> {
  return port;
}

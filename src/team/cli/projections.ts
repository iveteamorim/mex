import type {
  ActorRef,
  Diagnostic,
  FileChange,
  JsonValue,
  RepoState,
  Revision,
} from "../contracts/shared.js";
import type {
  ActivityEvent,
  ActivitySubjectRef,
  LocalStateChange,
  MemberGitAlias,
  StoredActivityEvent,
  TeamCurrentActor,
  TeamIdentityActivityPreviewEnvelope,
  TeamMember,
  TeamPage,
  TeamWorkstreamPreviewEnvelope,
  TeamWorkflowResult,
  Workstream,
} from "../contracts/workflow.js";

export interface TeamMemberProjection {
  schemaVersion: 1;
  id: string;
  displayName: string;
  gitAliases: readonly MemberGitAlias[];
  active: boolean;
  sourcePath: string;
  revision: Revision;
}

export interface TeamActivityProjection {
  schemaVersion: ActivityEvent["schemaVersion"];
  id: string;
  timestamp: string;
  actor: ActorRef;
  action: string;
  subjects: readonly ActivitySubjectRef[];
  workstream: ActivityEvent["workstream"] | null;
  repoState: RepoState;
  metadata: ActivityEvent["metadata"] | null;
  recordOrigin:
    | { kind: "workflow"; operation: string }
    | { kind: "custom" }
    | { kind: "unknown" };
  label: string | null;
  sourcePath: string | null;
  revision: Revision | null;
}

export interface TeamWorkstreamProjection {
  schemaVersion: 1;
  id: string;
  entityRevision: number;
  title: string;
  goal: string;
  summary: string;
  state: Workstream["state"];
  owners: Workstream["owners"];
  contributors: Workstream["contributors"];
  paths: Workstream["paths"];
  code: Workstream["code"];
  topics: Workstream["topics"];
  components: Workstream["components"];
  related: Workstream["related"];
  blockers: Workstream["blockers"];
  currentState: string;
  nextMilestone: string;
  createdBy: ActorRef;
  createdAt: string;
  updatedBy: ActorRef;
  updatedAt: string;
  sourcePath: string;
  revision: Revision;
}

export interface TeamPageProjection<T> {
  items: readonly T[];
  nextCursor: string | null;
  truncated: boolean;
  sourceTruncated: boolean;
  deterministicRevision: Revision;
}

export interface TeamCurrentActorProjection {
  actor: ActorRef;
  source: TeamCurrentActor["source"];
  selection: TeamCurrentActor["selection"];
}

export interface TeamApplyProjection {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  members: readonly TeamMemberProjection[];
  events: readonly TeamActivityProjection[];
}

export interface TeamWorkstreamApplyProjection {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  workstreams: readonly TeamWorkstreamProjection[];
  events: readonly TeamActivityProjection[];
}

export function projectMember(member: TeamMember): TeamMemberProjection {
  return {
    schemaVersion: 1,
    id: member.ref.id,
    displayName: member.displayName,
    gitAliases: member.gitAliases.map((alias) => ({ name: alias.name, email: alias.email })),
    active: member.active,
    sourcePath: member.sourcePath,
    revision: member.revision,
  };
}

export function projectMemberPage(
  page: TeamPage<TeamMember>,
): { data: TeamPageProjection<TeamMemberProjection>; diagnostics: readonly Diagnostic[] } {
  return {
    data: projectPage(page, page.items.map(projectMember)),
    diagnostics: page.diagnostics,
  };
}

export function projectActivity(
  activity: ActivityEvent | StoredActivityEvent,
): TeamActivityProjection {
  const stored = activity as Partial<StoredActivityEvent>;
  return {
    schemaVersion: activity.schemaVersion,
    id: activity.id,
    timestamp: activity.timestamp,
    actor: structuredClone(activity.actor),
    action: activity.action,
    subjects: structuredClone(activity.subjects),
    workstream: activity.workstream === undefined ? null : structuredClone(activity.workstream),
    repoState: structuredClone(activity.repoState),
    metadata: activity.metadata === undefined ? null : structuredClone(activity.metadata),
    recordOrigin: activity.schemaVersion === 1
      ? { kind: "unknown" }
      : structuredClone(activity.origin),
    label: activity.schemaVersion === 1 ? null : activity.label ?? null,
    sourcePath: stored.sourcePath ?? null,
    revision: stored.revision ?? null,
  };
}

export function projectActivityPage(
  page: TeamPage<StoredActivityEvent>,
): { data: TeamPageProjection<TeamActivityProjection>; diagnostics: readonly Diagnostic[] } {
  return {
    data: projectPage(page, page.items.map(projectActivity)),
    diagnostics: page.diagnostics,
  };
}

export function projectWorkstream(
  workstream: Workstream,
): TeamWorkstreamProjection {
  return {
    schemaVersion: 1,
    id: workstream.ref.id,
    entityRevision: workstream.entityRevision,
    title: workstream.title,
    goal: workstream.goal,
    summary: workstream.summary,
    state: workstream.state,
    owners: structuredClone(workstream.owners),
    contributors: structuredClone(workstream.contributors),
    paths: [...workstream.paths],
    code: structuredClone(workstream.code),
    topics: structuredClone(workstream.topics),
    components: structuredClone(workstream.components),
    related: structuredClone(workstream.related),
    blockers: [...workstream.blockers],
    currentState: workstream.currentState,
    nextMilestone: workstream.nextMilestone,
    createdBy: structuredClone(workstream.createdBy),
    createdAt: workstream.createdAt,
    updatedBy: structuredClone(workstream.updatedBy),
    updatedAt: workstream.updatedAt,
    sourcePath: workstream.sourcePath,
    revision: workstream.revision,
  };
}

export function projectWorkstreamPage(
  page: TeamPage<Workstream>,
): { data: TeamPageProjection<TeamWorkstreamProjection>; diagnostics: readonly Diagnostic[] } {
  return {
    data: projectPage(page, page.items.map(projectWorkstream)),
    diagnostics: page.diagnostics,
  };
}

export function projectCurrentActor(
  current: TeamCurrentActor,
): { data: TeamCurrentActorProjection; diagnostics: readonly Diagnostic[] } {
  return {
    data: {
      actor: structuredClone(current.actor),
      source: current.source,
      selection: current.selection === null ? null : { ...current.selection },
    },
    diagnostics: current.diagnostics,
  };
}

/** The C0 service already stripped prepared handles and private command state. */
export function projectPreview(
  preview: TeamIdentityActivityPreviewEnvelope,
): TeamIdentityActivityPreviewEnvelope {
  return structuredClone(preview);
}

export function projectWorkstreamPreview(
  preview: TeamWorkstreamPreviewEnvelope,
): TeamWorkstreamPreviewEnvelope {
  return structuredClone(preview);
}

export function projectApply<TWikiPayload extends JsonValue>(
  result: TeamWorkflowResult<TWikiPayload>,
): TeamApplyProjection {
  return {
    operationId: result.operationId,
    previewRevision: result.previewRevision,
    applied: true,
    idempotentReplay: result.idempotentReplay,
    changes: structuredClone(result.changes),
    localChanges: structuredClone(result.localChanges),
    members: result.artifacts
      .filter((artifact): artifact is TeamMember => artifact.kind === "member")
      .map(projectMember),
    events: result.events.map(projectActivity),
  };
}

export function projectWorkstreamApply<TWikiPayload extends JsonValue>(
  result: TeamWorkflowResult<TWikiPayload>,
): TeamWorkstreamApplyProjection {
  return {
    operationId: result.operationId,
    previewRevision: result.previewRevision,
    applied: true,
    idempotentReplay: result.idempotentReplay,
    changes: structuredClone(result.changes),
    localChanges: structuredClone(result.localChanges),
    workstreams: result.artifacts
      .filter((artifact): artifact is Workstream => artifact.kind === "workstream")
      .map(projectWorkstream),
    events: result.events.map(projectActivity),
  };
}

function projectPage<TSource, TProjection>(
  page: TeamPage<TSource>,
  items: readonly TProjection[],
): TeamPageProjection<TProjection> {
  return {
    items,
    nextCursor: page.nextCursor,
    truncated: page.truncated,
    sourceTruncated: page.sourceTruncated,
    deterministicRevision: page.deterministicRevision,
  };
}

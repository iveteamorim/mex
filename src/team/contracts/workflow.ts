import type {
  ActorRef,
  CodeRef,
  Diagnostic,
  EntityRef,
  FileChange,
  JsonValue,
  Page,
  PageRequest,
  RepoRelativePath,
  RepoState,
  Revision,
  RevisionExpectation,
} from "./shared.js";
import type {
  WikiOperationType,
  WikiRevisionExpectation,
} from "./wiki.js";

export const TEAM_READ_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 100,
  maxActivityMetadataEntries: 32,
  maxActivityMetadataBytes: 8 * 1024,
} as const;

export const TEAM_IDENTITY_ACTIVITY_LIMITS = {
  maxEnvelopeBytes: 64 * 1024,
  maxReceiptBytes: 8 * 1024,
  maxReceiptDepth: 8,
  maxReceiptNodes: 128,
  maxPurposeIds: 2,
  maxPreviewAgeMs: 30 * 60 * 1_000,
  maxFutureClockSkewMs: 5_000,
} as const;

/** Internal Checkpoint E Inbox/Spec product bounds. */
export const TEAM_INBOX_SPEC_LIMITS = {
  maxEnvelopeBytes: 64 * 1024,
  maxReceiptBytes: 8 * 1024,
  maxReceiptDepth: 8,
  maxReceiptNodes: 128,
  maxPurposeIds: 2,
  maxPortableRequestBytes: 32 * 1024,
  maxPayloadDepth: 8,
  maxPayloadNodes: 1_024,
  maxStringBytes: 16 * 1024,
  maxTitleBytes: 512,
  maxSummaryBytes: 2 * 1024,
  maxRationaleBytes: 8 * 1024,
  maxTopics: 64,
  maxExpectations: 64,
  maxRationaleExcerptBytes: 240,
  defaultPageSize: 50,
  maxPageSize: 100,
  maxCursorBytes: 4 * 1024,
  maxPreviewAgeMs: 30 * 60 * 1_000,
  maxFutureClockSkewMs: 5_000,
} as const;

/** Internal Checkpoint F Relay product bounds. */
export const TEAM_RELAY_LIMITS = {
  maxEnvelopeBytes: 64 * 1024,
  maxReceiptBytes: 8 * 1024,
  maxReceiptDepth: 8,
  maxReceiptNodes: 128,
  maxPurposeIds: 2,
  maxRecipients: 32,
  defaultPageSize: 50,
  maxPageSize: 100,
  maxCursorBytes: 4 * 1024,
  maxPreviewAgeMs: 30 * 60 * 1_000,
  maxFutureClockSkewMs: 5_000,
} as const;

export const TEAM_INBOX_SPEC_KINDS = [
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
] as const;

export type TeamInboxSpecKind = (typeof TEAM_INBOX_SPEC_KINDS)[number];

/** Existing Wiki knowledge kinds accepted by the additive Inbox facade. */
export const TEAM_INBOX_KNOWLEDGE_KINDS = [
  "architecture",
  "component",
  "convention",
  "decision",
  "pattern",
  "guide",
] as const;

export type TeamInboxKnowledgeKind = (typeof TEAM_INBOX_KNOWLEDGE_KINDS)[number];
export type TeamInboxEntityKind = TeamInboxSpecKind | TeamInboxKnowledgeKind;

export interface TeamInboxKnowledgeRef {
  id: string;
  kind: TeamInboxKnowledgeKind;
  title?: string;
}

export interface TeamInboxSpecRef<
  TKind extends TeamInboxSpecKind = TeamInboxSpecKind,
> {
  id: string;
  kind: TKind;
  title?: string;
}

type TeamInboxRefinesRelation = {
  type: "refines";
  target: TeamInboxSpecRef<"requirement">;
};

type TeamInboxConstrainedByRelation = {
  type: "constrained_by";
  target: TeamInboxSpecRef<"constraint">;
};

export type TeamInboxSpecCreateRelation<
  TKind extends TeamInboxSpecKind,
> = TKind extends "spec"
  ? TeamInboxConstrainedByRelation
  : TKind extends "requirement"
    ? { type: "derived_from"; target: TeamInboxSpecRef<"spec"> }
      | TeamInboxRefinesRelation
      | TeamInboxConstrainedByRelation
    : TKind extends "constraint"
      ? TeamInboxConstrainedByRelation
      : {
          type: "verified_by";
          target: TeamInboxSpecRef<"requirement" | "spec">;
        }
        | TeamInboxConstrainedByRelation;

export type TeamInboxSpecCreateChange = {
  [TKind in TeamInboxSpecKind]: {
    kind: "spec.create";
    entityKind: TKind;
    title: string;
    body: string;
    summary?: string;
    status: "in_flight" | "promoted";
    topics?: readonly string[];
    relation?: TeamInboxSpecCreateRelation<TKind>;
  };
}[TeamInboxSpecKind];

export type TeamInboxSpecUpdatePatch =
  | { title: string; summary?: string; body?: string }
  | { title?: string; summary: string; body?: string }
  | { title?: string; summary?: string; body: string };

export interface TeamInboxSpecUpdateChange {
  kind: "spec.update";
  target: TeamInboxSpecRef;
  patch: TeamInboxSpecUpdatePatch;
}

export interface TeamInboxKnowledgeCreateChange {
  kind: "knowledge.create";
  entityKind: TeamInboxKnowledgeKind;
  title: string;
  body: string;
  summary?: string;
  status: "in_flight" | "promoted";
  topics?: readonly string[];
}

export interface TeamInboxKnowledgeUpdateChange {
  kind: "knowledge.update";
  target: TeamInboxKnowledgeRef;
  patch: TeamInboxSpecUpdatePatch;
}

export type TeamInboxCreateChange = TeamInboxSpecCreateChange | TeamInboxKnowledgeCreateChange;
export type TeamInboxUpdateChange = TeamInboxSpecUpdateChange | TeamInboxKnowledgeUpdateChange;

/** Compatibility-named, closed one-change request. It has no raw Wiki slot. */
export type TeamInboxSpecChange =
  | TeamInboxCreateChange
  | TeamInboxUpdateChange;

export interface TeamInboxSpecDraftInput {
  change: TeamInboxSpecChange;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
}

export interface TeamInboxSpecDraftSummary {
  id: string;
  revision: Revision;
  updatedAt: string;
  changeKind: TeamInboxSpecChange["kind"];
  entityKind: TeamInboxEntityKind;
  title: string;
  rationaleExcerpt: string;
}

export interface TeamInboxSpecDraftDetail extends TeamInboxSpecDraftSummary {
  input: TeamInboxSpecDraftInput;
}

export interface TeamInboxSpecProposalSummary {
  schemaVersion: 1;
  ref: EntityRef;
  sourcePath: RepoRelativePath;
  revision: Revision;
  state: ProposalState;
  author: ActorRef;
  changeKind: TeamInboxSpecChange["kind"];
  entityKind: TeamInboxEntityKind;
  title: string;
  rationaleExcerpt: string;
  reviewer?: ActorRef;
  reviewedAt?: string;
}

export interface TeamInboxSpecProposalDetail
  extends TeamInboxSpecProposalSummary {
  change: TeamInboxSpecChange;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
  reviewRationale?: string;
}

export interface TeamInboxSpecPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  truncated: boolean;
  sourceTruncated: boolean;
  deterministicRevision: Revision;
  diagnostics: readonly Diagnostic[];
}

export interface TeamInboxDraftListRequest extends PageRequest {
  changeKinds?: readonly TeamInboxSpecChange["kind"][];
  entityKinds?: readonly TeamInboxEntityKind[];
}

export interface TeamInboxProposalListRequest
  extends TeamInboxDraftListRequest {
  states?: readonly ProposalState[];
}

export const WORKSTREAM_STATES = [
  "planned",
  "active",
  "blocked",
  "done",
  "archived",
] as const;

export const PROPOSAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "stale",
] as const;

export const RELAY_STATES = ["published", "acknowledged", "closed"] as const;
export const PLAYBOOK_STATES = ["active", "archived"] as const;
export const PLAYBOOK_RUN_STATES = ["active", "completed"] as const;

export type WorkstreamState = (typeof WORKSTREAM_STATES)[number];
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export type RelayState = (typeof RELAY_STATES)[number];
export type PlaybookState = (typeof PLAYBOOK_STATES)[number];
export type PlaybookRunState = (typeof PLAYBOOK_RUN_STATES)[number];

export type TeamArtifactKind =
  | "member"
  | "workstream"
  | "proposal"
  | "relay"
  | "playbook"
  | "playbook_run";

export type TeamArtifactState =
  | WorkstreamState
  | ProposalState
  | RelayState
  | PlaybookState
  | PlaybookRunState;

export interface TeamPage<T> extends Page<T> {
  truncated: boolean;
  /** True only when a bounded source scan could not prove a complete corpus. */
  sourceTruncated: boolean;
  /** Hash of the bounded ordered source revisions used for this page. */
  deterministicRevision: Revision;
  /** Bounded source/validation diagnostics; never an unbounded error corpus. */
  diagnostics: readonly Diagnostic[];
}

export interface TeamArtifactBase<TKind extends TeamArtifactKind> {
  schemaVersion: 1;
  ref: EntityRef;
  kind: TKind;
  sourcePath: RepoRelativePath;
  revision: Revision;
}

export interface MemberGitAlias {
  name: string | null;
  email: string | null;
}

export interface TeamMember extends TeamArtifactBase<"member"> {
  displayName: string;
  gitAliases: readonly MemberGitAlias[];
  active: boolean;
}

export interface Workstream extends TeamArtifactBase<"workstream"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  title: string;
  goal: string;
  summary: string;
  state: WorkstreamState;
  owners: readonly ActorRef[];
  contributors: readonly ActorRef[];
  paths: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  topics: readonly EntityRef[];
  components: readonly EntityRef[];
  related: readonly EntityRef[];
  blockers: readonly string[];
  currentState: string;
  nextMilestone: string;
  createdBy: ActorRef;
  createdAt: string;
  updatedBy: ActorRef;
  updatedAt: string;
}

export type TeamEvidenceRef =
  | { kind: "entity"; entity: EntityRef }
  | { kind: "code"; code: CodeRef }
  | { kind: "commit"; hash: string }
  | { kind: "file"; path: RepoRelativePath }
  | { kind: "external"; uri: string; label?: string }
  | { kind: "manual"; note: string };

export interface InboxProposal<TWikiOperationPlan>
  extends TeamArtifactBase<"proposal"> {
  state: ProposalState;
  author: ActorRef;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  request: PortableWikiOperationRequest<TWikiOperationPlan>;
  targetRevisions: readonly RevisionExpectation[];
  reviewer?: ActorRef;
  reviewRationale?: string;
  reviewedAt?: string;
}

interface RelayBase extends Omit<TeamArtifactBase<"relay">, "schemaVersion"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  state: RelayState;
  sender: ActorRef;
  recipients: readonly ActorRef[];
  summary: string;
  completed: readonly string[];
  inProgress: readonly string[];
  decisions: readonly EntityRef[];
  blockers: readonly string[];
  unresolvedQuestions: readonly string[];
  changedFiles: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  evidence: readonly TeamEvidenceRef[];
  nextActions: readonly string[];
  acknowledgedBy?: ActorRef;
  acknowledgedAt?: string;
  closedBy?: ActorRef;
  closedAt?: string;
}

/** Original Relay format. Its Workstream is immutable and publication time was not recorded. */
export interface RelayV1 extends RelayBase {
  schemaVersion: 1;
  audience?: never;
  workstream: EntityRef;
  publishedAt?: never;
  publishedRepoState?: never;
}

/** Timestamped legacy Relay format. Its Workstream remains canonical related context. */
export interface RelayV2 extends RelayBase {
  schemaVersion: 2;
  audience?: never;
  workstream: EntityRef;
  publishedAt: string;
  publishedRepoState?: never;
}

/** Standalone Relay format with immutable publication-time repository provenance. */
export interface RelayV3 extends RelayBase {
  schemaVersion: 3;
  audience?: never;
  workstream?: never;
  publishedAt: string;
  publishedRepoState: RepoState;
}

/** Open to whichever active Member claims first, including future Members. */
export interface RelayV4 extends RelayBase {
  schemaVersion: 4;
  audience: "team";
  workstream?: never;
  publishedAt: string;
  publishedRepoState: RepoState;
}

export type Relay = RelayV1 | RelayV2 | RelayV3 | RelayV4;
export type RelayAudience = "team" | "members";

export interface PlaybookStepDefinition {
  id: string;
  title: string;
  instructions: string;
  requiredChecks: readonly string[];
  expectedOutputs: readonly string[];
}

export interface Playbook extends TeamArtifactBase<"playbook"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  state: PlaybookState;
  title: string;
  purpose: string;
  trigger: string;
  owners: readonly ActorRef[];
  prerequisites: readonly string[];
  steps: readonly PlaybookStepDefinition[];
  related: readonly EntityRef[];
}

export interface PlaybookRunStep {
  stepId: string;
  completedBy?: ActorRef;
  completedAt?: string;
}

export interface PlaybookRun extends TeamArtifactBase<"playbook_run"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  state: PlaybookRunState;
  playbook: EntityRef;
  workstream: EntityRef;
  steps: readonly PlaybookRunStep[];
  startedBy: ActorRef;
  startedAt: string;
}

export type TeamArtifact<TWikiOperationPlan> =
  | TeamMember
  | Workstream
  | InboxProposal<TWikiOperationPlan>
  | Relay
  | Playbook
  | PlaybookRun;

export interface TeamArtifactListRequest extends PageRequest {
  kinds?: readonly TeamArtifactKind[];
  states?: readonly TeamArtifactState[];
  includeArchived?: boolean;
}

export type LocalDraftKind = "inbox" | "relay";

export interface LocalDraftBase<TKind extends LocalDraftKind> {
  id: string;
  kind: TKind;
  revision: Revision;
  updatedAt: string;
}

export interface InboxDraft<TWikiOperationPlan>
  extends LocalDraftBase<"inbox"> {
  request: PortableWikiOperationRequest<TWikiOperationPlan>;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
}

export interface RelayDraft extends LocalDraftBase<"relay"> {
  audience?: RelayAudience;
  recipients: readonly ActorRef[];
  summary: string;
  completed: readonly string[];
  inProgress: readonly string[];
  decisions: readonly EntityRef[];
  blockers: readonly string[];
  unresolvedQuestions: readonly string[];
  changedFiles: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  evidence: readonly TeamEvidenceRef[];
  nextActions: readonly string[];
}

export type LocalDraft<TWikiOperationPlan> =
  | InboxDraft<TWikiOperationPlan>
  | RelayDraft;

export interface LocalDraftListRequest extends PageRequest {
  kind?: LocalDraftKind;
}

export interface LocalStateChange {
  namespace: "inbox-draft" | "relay-draft" | "cursor" | "member-selection";
  id: string;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
  summary: string;
}

/** Stable references that an immutable activity event may point at. */
export type ActivitySubjectRef =
  | { kind: "entity"; entity: EntityRef }
  | { kind: "code"; code: CodeRef }
  | { kind: "file"; path: RepoRelativePath }
  | { kind: "commit"; hash: string };

export type ActivityRecordOrigin =
  | { kind: "workflow"; operation: string }
  | { kind: "custom" };

interface ActivityEventBase {
  id: string;
  timestamp: string;
  actor: ActorRef;
  action: string;
  subjects: readonly ActivitySubjectRef[];
  workstream?: EntityRef;
  repoState: RepoState;
  metadata?: Readonly<Record<string, JsonValue>>;
}

/** Historical Activity bytes whose creation path cannot be proven. */
export interface ActivityEventV1 extends ActivityEventBase {
  schemaVersion: 1;
  origin?: never;
  label?: never;
}

/** Activity with service-owned creation provenance and a bounded human label. */
export interface ActivityEventV2 extends ActivityEventBase {
  schemaVersion: 2;
  origin: ActivityRecordOrigin;
  label?: string;
}

export type ActivityEvent = ActivityEventV1 | ActivityEventV2;

/** Canonical activity event plus its storage identity. */
export type StoredActivityEvent = ActivityEvent & {
  sourcePath: RepoRelativePath;
  revision: Revision;
};

export interface TeamMemberListRequest extends PageRequest {
  active?: boolean;
}

export interface TeamActivityListRequest extends PageRequest {
  since?: string;
}

export interface TeamWorkstreamListRequest extends PageRequest {
  states?: readonly WorkstreamState[];
  includeArchived?: boolean;
}

export type TeamActorResolutionSource =
  | "configured-member"
  | "git-alias"
  | "git-fallback"
  | "unknown";

export interface TeamMemberSelection {
  memberId: string;
  updatedAt: string;
  revision: Revision;
}

export interface TeamCurrentActor {
  actor: ActorRef;
  source: TeamActorResolutionSource;
  selection: TeamMemberSelection | null;
  diagnostics: readonly Diagnostic[];
}

export interface WorkstreamCreateInput {
  title: string;
  goal: string;
  summary: string;
  owners: readonly ActorRef[];
  contributors?: readonly ActorRef[];
  paths?: readonly RepoRelativePath[];
  code?: readonly CodeRef[];
  topics?: readonly EntityRef[];
  components?: readonly EntityRef[];
  related?: readonly EntityRef[];
  nextMilestone: string;
}

export interface WorkstreamUpdatePatch {
  title?: string;
  goal?: string;
  summary?: string;
  state?: WorkstreamState;
  owners?: readonly ActorRef[];
  contributors?: readonly ActorRef[];
  paths?: readonly RepoRelativePath[];
  code?: readonly CodeRef[];
  topics?: readonly EntityRef[];
  components?: readonly EntityRef[];
  related?: readonly EntityRef[];
  blockers?: readonly string[];
  currentState?: string;
  nextMilestone?: string;
}

export interface InboxDraftInput<TWikiOperationPlan> {
  request: PortableWikiOperationRequest<TWikiOperationPlan>;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
}

export interface RelayDraftInput {
  /** Omission preserves legacy named-recipient receipts and local payloads. */
  audience?: RelayAudience;
  recipients: readonly ActorRef[];
  summary: string;
  completed: readonly string[];
  inProgress: readonly string[];
  decisions: readonly EntityRef[];
  blockers: readonly string[];
  unresolvedQuestions: readonly string[];
  changedFiles: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  evidence: readonly TeamEvidenceRef[];
  nextActions: readonly string[];
}

/** Actions whose primary artifact does not exist yet. */
export type TeamWorkflowCreateAction<TWikiOperationPlan> =
  | {
      kind: "member.add";
      member: { displayName: string; gitAliases: readonly MemberGitAlias[]; active?: boolean };
    }
  | { kind: "workstream.create"; workstream: WorkstreamCreateInput }
  | {
      kind: "inbox.draft.save";
      draftId?: never;
      draft: InboxDraftInput<TWikiOperationPlan>;
    }
  | { kind: "relay.draft.save"; draftId?: never; draft: RelayDraftInput }
  | {
      kind: "playbook.create";
      playbook: Omit<
        Playbook,
        keyof TeamArtifactBase<"playbook"> | "state" | "entityRevision"
      >;
    }
  | {
      kind: "activity.record";
      activity: {
        action: string;
        subjects: readonly ActivitySubjectRef[];
        workstream?: EntityRef;
      };
    };

/** Actions that mutate or depend on an existing revisioned target. */
export type TeamWorkflowRevisionBoundAction<TWikiOperationPlan> =
  | {
      kind: "inbox.draft.save";
      draftId: string;
      draft: InboxDraftInput<TWikiOperationPlan>;
    }
  | { kind: "relay.draft.save"; draftId: string; draft: RelayDraftInput }
  | {
      kind: "member.update";
      memberId: string;
      patch: { displayName?: string; gitAliases?: readonly MemberGitAlias[] };
    }
  | { kind: "member.deactivate"; memberId: string }
  | { kind: "member.reactivate"; memberId: string }
  | { kind: "member.select"; memberId: string }
  | { kind: "member.clear" }
  | { kind: "workstream.update"; workstreamId: string; patch: WorkstreamUpdatePatch }
  | { kind: "workstream.archive"; workstreamId: string }
  | { kind: "inbox.draft.delete"; draftId: string }
  | { kind: "inbox.publish"; draftId: string }
  | { kind: "inbox.approve"; proposalId: string }
  | { kind: "inbox.reject"; proposalId: string; rationale: string }
  | { kind: "inbox.withdraw"; proposalId: string; rationale?: string }
  | { kind: "inbox.mark-stale"; proposalId: string; rationale: string }
  | {
      kind: "inbox.repair";
      proposalId: string;
      replacement: InboxDraftInput<TWikiOperationPlan>;
    }
  | { kind: "relay.draft.delete"; draftId: string }
  | { kind: "relay.publish"; draftId: string }
  | { kind: "relay.acknowledge"; relayId: string }
  | { kind: "relay.close"; relayId: string }
  | {
      kind: "playbook.update";
      playbookId: string;
      patch: Partial<
        Omit<
          Playbook,
          keyof TeamArtifactBase<"playbook"> | "entityRevision"
        >
      >;
    }
  | { kind: "playbook.archive"; playbookId: string }
  | { kind: "playbook.run.start"; playbook: EntityRef; workstream: EntityRef }
  | { kind: "playbook.run.complete-step"; runId: string; stepId: string };

export type TeamWorkflowAction<TWikiOperationPlan> =
  | TeamWorkflowCreateAction<TWikiOperationPlan>
  | TeamWorkflowRevisionBoundAction<TWikiOperationPlan>;

export type NonEmptyRevisionExpectations = readonly [
  RevisionExpectation,
  ...RevisionExpectation[],
];

interface TeamWorkflowCommandBase {
  /**
   * Globally unique caller-generated ID. Exact replay and altered-reuse
   * rejection are retained for the bounded 256-operation local journal
   * window; callers must never intentionally recycle an older ID.
   */
  operationId: string;
  /** Service-owned authority must never be accepted at the caller boundary. */
  actor?: never;
  occurredAt?: never;
  repoState?: never;
}

/**
 * Existing-target actions cannot be previewed without optimistic preconditions.
 * Implementations must also prove that every existing target touched by the
 * action is covered; an unrelated expectation does not satisfy this contract.
 */
export type TeamWorkflowCommand<TWikiOperationPlan> =
  | (TeamWorkflowCommandBase & {
      action: TeamWorkflowCreateAction<TWikiOperationPlan>;
      expectedRevisions: readonly RevisionExpectation[];
    })
  | (TeamWorkflowCommandBase & {
      action: TeamWorkflowRevisionBoundAction<TWikiOperationPlan>;
      expectedRevisions: NonEmptyRevisionExpectations;
    });

type TeamIdentityActivityMemberAddAction = Omit<
  Extract<TeamWorkflowCreateAction<never>, { kind: "member.add" }>,
  "member"
> & {
  member: Omit<
    Extract<TeamWorkflowCreateAction<never>, { kind: "member.add" }>["member"],
    "active"
  > & {
    /** C members always begin active; callers must use member.deactivate later. */
    active?: never;
  };
};

export type TeamIdentityActivityCreateAction =
  | TeamIdentityActivityMemberAddAction
  | Extract<TeamWorkflowCreateAction<never>, { kind: "activity.record" }>;

export type TeamIdentityActivityRevisionBoundAction = Extract<
  TeamWorkflowRevisionBoundAction<never>,
  { kind: "member.update" | "member.deactivate" | "member.reactivate" | "member.select" | "member.clear" }
>;

export type TeamIdentityActivityAction =
  | TeamIdentityActivityCreateAction
  | TeamIdentityActivityRevisionBoundAction;

export type TeamIdentityActivityCommand =
  | (TeamWorkflowCommandBase & {
      action: TeamIdentityActivityCreateAction;
      expectedRevisions: readonly RevisionExpectation[];
    })
  | (TeamWorkflowCommandBase & {
      action: TeamIdentityActivityRevisionBoundAction;
      expectedRevisions: NonEmptyRevisionExpectations;
    });

export type TeamWorkstreamCreateAction = Extract<
  TeamWorkflowCreateAction<never>,
  { kind: "workstream.create" }
>;

export type TeamWorkstreamRevisionBoundAction =
  | {
      kind: "workstream.update";
      workstreamId: string;
      patch: Omit<WorkstreamUpdatePatch, "state"> & {
        state?: Exclude<WorkstreamState, "archived">;
      };
    }
  | Extract<
      TeamWorkflowRevisionBoundAction<never>,
      { kind: "workstream.archive" }
    >;

export type TeamWorkstreamAction =
  | TeamWorkstreamCreateAction
  | TeamWorkstreamRevisionBoundAction;

/** Portable caller boundary restricted to Checkpoint D Workstream actions. */
export type TeamWorkstreamCommand =
  | (TeamWorkflowCommandBase & {
      action: TeamWorkstreamCreateAction;
      expectedRevisions: readonly RevisionExpectation[];
    })
  | (TeamWorkflowCommandBase & {
      action: TeamWorkstreamRevisionBoundAction;
      expectedRevisions: NonEmptyRevisionExpectations;
    });

/** Authority captured by the service while preparing an exact preview. */
export interface TeamWorkflowAuthority {
  actor: ActorRef;
  occurredAt: string;
  repoState: RepoState;
}

/** Caller intent bound to service-owned identity, time, and repository state. */
export type PreparedTeamWorkflowCommand<TWikiOperationPlan> =
  TeamWorkflowCommand<TWikiOperationPlan> & {
    authority: TeamWorkflowAuthority;
  };

export interface TeamWorkflowPreview<TWikiOperationPlan> {
  operationId: string;
  previewRevision: Revision;
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  diagnostics: readonly Diagnostic[];
  /** Exact prepared command that apply must bind and revalidate. */
  command: PreparedTeamWorkflowCommand<TWikiOperationPlan>;
}

export interface TeamIdentityActivityPublicPreview {
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  diagnostics: readonly Diagnostic[];
}

export interface TeamIdentityActivityPurposeId {
  purpose: "activity" | "member";
  id: string;
}

export interface TeamIdentityActivityReceipt {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly TeamIdentityActivityPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
  previewRevision: Revision;
}

/** One portable, human-readable preview and the metadata that binds it. */
export interface TeamIdentityActivityPreviewEnvelope {
  schemaVersion: 1;
  request: TeamIdentityActivityCommand;
  preview: TeamIdentityActivityPublicPreview;
  receipt: TeamIdentityActivityReceipt;
}

export interface TeamWorkstreamPurposeId {
  purpose: "activity" | "workstream";
  id: string;
}

export interface TeamWorkstreamReceipt {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly TeamWorkstreamPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
  previewRevision: Revision;
}

/** Signed exact preview that remains portable across service processes. */
export interface TeamWorkstreamPreviewEnvelope {
  schemaVersion: 1;
  request: TeamWorkstreamCommand;
  preview: TeamIdentityActivityPublicPreview;
  receipt: TeamWorkstreamReceipt;
}

export type TeamInboxSpecAction =
  | {
      kind: "inbox.draft.save";
      draftId?: string;
      draft: TeamInboxSpecDraftInput;
    }
  | { kind: "inbox.draft.delete"; draftId: string }
  | { kind: "inbox.publish"; draftId: string }
  | { kind: "inbox.approve"; proposalId: string }
  | { kind: "inbox.reject"; proposalId: string; rationale: string }
  | { kind: "inbox.withdraw"; proposalId: string; rationale?: string }
  | { kind: "inbox.mark-stale"; proposalId: string; rationale: string }
  | {
      kind: "inbox.repair";
      proposalId: string;
      replacement: TeamInboxSpecDraftInput;
    };

/** Caller-owned Checkpoint E intent. Authority has no product input slot. */
export interface TeamInboxSpecCommand {
  operationId: string;
  action: TeamInboxSpecAction;
  expectedRevisions: readonly RevisionExpectation[];
  actor?: never;
  occurredAt?: never;
  repoState?: never;
  authority?: never;
}

export interface TeamInboxSpecPublicPreview {
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly TeamInboxSpecLocalChange[];
  diagnostics: readonly Diagnostic[];
}

export interface TeamInboxSpecLocalChange {
  namespace: "inbox-draft";
  id: string;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
  summary: string;
}

export interface TeamInboxSpecPurposeId {
  purpose: "inbox-draft" | "proposal" | "activity" | "spec-entity";
  id: string;
}

export interface TeamInboxSpecReceipt {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly TeamInboxSpecPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
  previewRevision: Revision;
}

/** Signed, exact and cross-process Checkpoint E review envelope. */
export interface TeamInboxSpecPreviewEnvelope {
  schemaVersion: 1;
  request: TeamInboxSpecCommand;
  preview: TeamInboxSpecPublicPreview;
  receipt: TeamInboxSpecReceipt;
}

export interface TeamInboxSpecApplyResult {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly TeamInboxSpecLocalChange[];
  proposals: readonly TeamInboxSpecProposalDetail[];
  events: readonly StoredActivityEvent[];
}

/** Internal product facade; intentionally absent from the package root. */
export interface TeamInboxSpecAuthoringPort {
  getInboxDraft(id: string): Promise<TeamInboxSpecDraftDetail | null>;
  listInboxDrafts(
    request?: TeamInboxDraftListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecDraftSummary>>;
  getInboxProposal(id: string): Promise<TeamInboxSpecProposalDetail | null>;
  listInboxProposals(
    request?: TeamInboxProposalListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecProposalSummary>>;
  previewInbox(
    command: TeamInboxSpecCommand,
  ): Promise<TeamInboxSpecPreviewEnvelope>;
  applyInbox(
    envelope: TeamInboxSpecPreviewEnvelope,
  ): Promise<TeamInboxSpecApplyResult>;
}

export type TeamRelayPerspective = "mine" | "sent" | "all";

export interface TeamRelayDraftSummary {
  id: string;
  revision: Revision;
  updatedAt: string;
  audience?: RelayAudience;
  recipients: readonly Extract<ActorRef, { kind: "member" }>[];
  summary: string;
}

export interface TeamRelayDraftDetail extends TeamRelayDraftSummary {
  input: RelayDraftInput;
}

export interface TeamRelaySummary {
  schemaVersion: 1 | 2 | 3 | 4;
  audience?: RelayAudience;
  ref: EntityRef;
  sourcePath: RepoRelativePath;
  revision: Revision;
  state: RelayState;
  sender: ActorRef;
  recipients: readonly ActorRef[];
  workstream: EntityRef | null;
  summary: string;
  publishedAt: string | null;
  publishedRepoState: RepoState | null;
  acknowledgedBy?: ActorRef;
  acknowledgedAt?: string;
  closedBy?: ActorRef;
  closedAt?: string;
}

export interface TeamRelayDetail extends TeamRelaySummary {
  completed: readonly string[];
  inProgress: readonly string[];
  decisions: readonly EntityRef[];
  blockers: readonly string[];
  unresolvedQuestions: readonly string[];
  changedFiles: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  evidence: readonly TeamEvidenceRef[];
  nextActions: readonly string[];
  /** One bounded warning for a strict legacy schema-v1 Relay, otherwise empty. */
  diagnostics: readonly Diagnostic[];
}

export interface TeamRelayPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  truncated: boolean;
  sourceTruncated: boolean;
  deterministicRevision: Revision;
  diagnostics: readonly Diagnostic[];
}

export interface TeamRelayDraftListRequest extends PageRequest {}

export interface TeamRelayListRequest extends PageRequest {
  perspective?: TeamRelayPerspective;
  states?: readonly RelayState[];
  workstreamId?: string;
}

export type TeamRelayAction =
  | { kind: "relay.draft.save"; draftId?: string; draft: RelayDraftInput }
  | { kind: "relay.draft.delete"; draftId: string }
  | { kind: "relay.publish"; draftId: string }
  | { kind: "relay.acknowledge"; relayId: string }
  | { kind: "relay.close"; relayId: string };

/** Caller-owned Relay intent. Authority has no caller-controlled slot. */
export interface TeamRelayCommand {
  operationId: string;
  action: TeamRelayAction;
  expectedRevisions: readonly RevisionExpectation[];
  actor?: never;
  occurredAt?: never;
  repoState?: never;
  authority?: never;
}

export interface TeamRelayLocalChange {
  namespace: "relay-draft";
  id: string;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
  summary: string;
}

export interface TeamRelayPublicPreview {
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly TeamRelayLocalChange[];
  diagnostics: readonly Diagnostic[];
}

export interface TeamRelayPurposeId {
  purpose: "relay-draft" | "relay" | "activity";
  id: string;
}

export interface TeamRelayReceipt {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly TeamRelayPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
  previewRevision: Revision;
}

/** Signed exact preview portable across Relay service processes. */
export interface TeamRelayPreviewEnvelope {
  schemaVersion: 1;
  request: TeamRelayCommand;
  preview: TeamRelayPublicPreview;
  receipt: TeamRelayReceipt;
}

export interface TeamRelayApplyResult {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly TeamRelayLocalChange[];
  relays: readonly TeamRelayDetail[];
  events: readonly StoredActivityEvent[];
}

/** Internal Relay product facade; intentionally absent from the package root. */
export interface TeamRelayHandoffPort {
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

export interface TeamWorkflowApplyRequest<TWikiOperationPlan> {
  command: PreparedTeamWorkflowCommand<TWikiOperationPlan>;
  expectedPreviewRevision: Revision;
}

/** Applies only successful commands; validation/conflict failures throw. */
export interface TeamWorkflowResult<TWikiOperationPlan> {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  artifacts: readonly TeamArtifact<TWikiOperationPlan>[];
  events: readonly ActivityEvent[];
}

export interface ActorResolutionRequest {
  configuredMemberId?: string;
  gitIdentity?: MemberGitAlias;
}

/**
 * Portable proposal shape. It contains declarative Wiki intent and immutable
 * preconditions only; executable plans, process handles, actor, and time are
 * deliberately absent.
 */
export interface PortableWikiOperation<TWikiOperationPlan> {
  opId: string;
  type: WikiOperationType;
  entityId?: string;
  baseRevision?: number;
  baseContentHash?: Revision;
  reason?: string;
  payload: TWikiOperationPlan;
  actor?: never;
  timestamp?: never;
  plan?: never;
  handle?: never;
}

export interface PortableWikiOperationRequest<TWikiOperationPlan> {
  operation: PortableWikiOperation<TWikiOperationPlan>;
  expectedRevisions: readonly WikiRevisionExpectation[];
}

/** Typed facade for members, Workstreams, Inbox, Relays, and Playbooks. */
export interface TeamWorkflowPort<TWikiOperationPlan> {
  /** Resolve configured-member/Git identity from service-owned configuration. */
  resolveActor(): Promise<ActorRef>;
  getArtifact(ref: EntityRef): Promise<TeamArtifact<TWikiOperationPlan> | null>;
  listArtifacts(
    request?: TeamArtifactListRequest,
  ): Promise<TeamPage<TeamArtifact<TWikiOperationPlan>>>;
  getLocalDraft(id: string): Promise<LocalDraft<TWikiOperationPlan> | null>;
  listLocalDrafts(
    request?: LocalDraftListRequest,
  ): Promise<TeamPage<LocalDraft<TWikiOperationPlan>>>;
  preview(
    command: TeamWorkflowCommand<TWikiOperationPlan>,
  ): Promise<TeamWorkflowPreview<TWikiOperationPlan>>;
  apply(
    request: TeamWorkflowApplyRequest<TWikiOperationPlan>,
  ): Promise<TeamWorkflowResult<TWikiOperationPlan>>;
}

// Compatibility re-exports keep existing internal imports stable while the
// future aggregation seam lives in its own module.
export type {
  CatchUpCursor,
  CatchUpDigest,
  CatchUpGroup,
  CatchUpItem,
  CatchUpPort,
  CatchUpRequest,
} from "./catch-up.js";

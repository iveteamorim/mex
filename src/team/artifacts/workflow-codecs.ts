import { parseDocument } from "yaml";
import type {
  ActorRef,
  CodeRef,
  EntityRef,
  JsonValue,
  RepoRelativePath,
  RepoState,
  Revision,
  RevisionExpectation,
} from "../contracts/shared.js";
import { isRepoRelativePath, isRevision } from "../contracts/shared.js";
import {
  PLAYBOOK_RUN_STATES,
  PLAYBOOK_STATES,
  PROPOSAL_STATES,
  RELAY_STATES,
  WORKSTREAM_STATES,
  type InboxProposal,
  type InboxDraftInput,
  type Playbook,
  type PlaybookRun,
  type PlaybookRunStep,
  type PlaybookStepDefinition,
  type PortableWikiOperationRequest,
  type Relay,
  type RelayDraftInput,
  type TeamArtifactBase,
  type TeamArtifactKind,
  type TeamEvidenceRef,
  type Workstream,
} from "../contracts/workflow.js";
import type { WikiRevisionExpectation } from "../contracts/wiki.js";
import { WIKI_OPERATION_TYPES } from "../contracts/wiki.js";
import { artifactError } from "./errors.js";
import { revisionOf } from "./revision.js";
import { isArtifactId, type TeamArtifactIdPrefix } from "./ulid.js";

export const WORKFLOW_ARTIFACT_MAX_BYTES = 64 * 1024;
export const WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES = 64;
export const PLAYBOOK_STEP_LIMIT = 128;
export const PLAYBOOK_STEP_DETAIL_LIMIT = 32;
export const PORTABLE_WIKI_REQUEST_MAX_BYTES = 32 * 1024;

type StoredKeys = keyof TeamArtifactBase<"workstream">;
type WithoutStored<T> = Omit<T, StoredKeys>;

export type WorkstreamArtifactInput = WithoutStored<Workstream> & { id: string };
export type InboxProposalArtifactInput<TPayload> =
  WithoutStored<InboxProposal<TPayload>> & { id: string };
type RelaySharedArtifactInput = {
  id: string;
  entityRevision: number;
  state: Relay["state"];
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
};

/**
 * Repository input retains the pre-v3 implicit v1/v2 discriminator so existing
 * callers and exact legacy update paths remain source compatible. Parsed
 * artifacts themselves are always the strict schema-discriminated `Relay`.
 */
export type RelayArtifactInput =
  | (RelaySharedArtifactInput & {
      schemaVersion?: 1;
      audience?: never;
      workstream: EntityRef;
      publishedAt?: never;
      publishedRepoState?: never;
    })
  | (RelaySharedArtifactInput & {
      schemaVersion?: 2;
      audience?: never;
      workstream: EntityRef;
      publishedAt: string;
      publishedRepoState?: never;
    })
  | (RelaySharedArtifactInput & {
      schemaVersion: 3;
      audience?: never;
      workstream?: never;
      publishedAt: string;
      publishedRepoState: RepoState;
    })
  | (RelaySharedArtifactInput & {
      schemaVersion: 4;
      audience: "team";
      workstream?: never;
      publishedAt: string;
      publishedRepoState: RepoState;
    });

type NormalizedRelayArtifactInput =
  | (RelaySharedArtifactInput & {
      schemaVersion: 1;
      audience?: never;
      workstream: EntityRef;
      publishedAt?: never;
      publishedRepoState?: never;
    })
  | (RelaySharedArtifactInput & {
      schemaVersion: 2;
      audience?: never;
      workstream: EntityRef;
      publishedAt: string;
      publishedRepoState?: never;
    })
  | (RelaySharedArtifactInput & {
      schemaVersion: 3;
      audience?: never;
      workstream?: never;
      publishedAt: string;
      publishedRepoState: RepoState;
    })
  | (RelaySharedArtifactInput & {
      schemaVersion: 4;
      audience: "team";
      workstream?: never;
      publishedAt: string;
      publishedRepoState: RepoState;
    });
export type PlaybookArtifactInput = WithoutStored<Playbook> & { id: string };
export type PlaybookRunArtifactInput = WithoutStored<PlaybookRun> & { id: string };

const WORKSTREAM_KEYS = [
  "schema_version", "id", "mex", "state", "title", "goal", "summary",
  "owners", "contributors", "paths", "code", "topics", "components",
  "related", "blockers", "current_state", "next_milestone", "created_by",
  "created_at", "updated_by", "updated_at",
] as const;
const PROPOSAL_REQUIRED_KEYS = [
  "schema_version", "id", "state", "author", "rationale", "evidence",
  "request", "target_revisions",
] as const;
const PROPOSAL_OPTIONAL_KEYS = ["reviewer", "review_rationale", "reviewed_at"] as const;
const RELAY_REQUIRED_KEYS = [
  "schema_version", "id", "mex", "state", "sender", "recipients",
  "workstream", "summary", "completed", "in_progress", "decisions",
  "blockers", "unresolved_questions", "changed_files", "code", "evidence",
  "next_actions",
] as const;
const RELAY_V2_REQUIRED_KEYS = [...RELAY_REQUIRED_KEYS, "published_at"] as const;
const RELAY_V3_REQUIRED_KEYS = [
  "schema_version", "id", "mex", "state", "sender", "recipients",
  "summary", "completed", "in_progress", "decisions", "blockers",
  "unresolved_questions", "changed_files", "code", "evidence",
  "next_actions", "published_at", "published_repo_state",
] as const;
const RELAY_V4_REQUIRED_KEYS = [...RELAY_V3_REQUIRED_KEYS, "audience"] as const;
const RELAY_OPTIONAL_KEYS = ["acknowledged_by", "acknowledged_at", "closed_by", "closed_at"] as const;
const PLAYBOOK_KEYS = [
  "schema_version", "id", "mex", "state", "title", "purpose", "trigger",
  "owners", "prerequisites", "steps", "related",
] as const;
const RUN_KEYS = [
  "schema_version", "id", "mex", "state", "playbook", "workstream", "steps",
  "started_by", "started_at",
] as const;

export function workstreamArtifactPath(id: string): RepoRelativePath {
  return artifactPath("workstream", "ws", id, ".mex/workstreams");
}

export function inboxProposalArtifactPath(id: string): RepoRelativePath {
  return artifactPath("proposal", "proposal", id, ".mex/inbox");
}

export function relayArtifactPath(id: string): RepoRelativePath {
  return artifactPath("relay", "relay", id, ".mex/relays");
}

export function playbookArtifactPath(id: string): RepoRelativePath {
  return artifactPath("playbook", "playbook", id, ".mex/playbooks");
}

export function playbookRunArtifactPath(id: string): RepoRelativePath {
  return artifactPath("playbook run", "run", id, ".mex/playbooks/runs");
}

export function serializeWorkstreamArtifact(input: WorkstreamArtifactInput): string {
  const value = normalizeWorkstream(input);
  return encodeArtifact([
    ["schema_version", 1], ["id", value.id],
    ["mex", wikiMetadata(value.id, "workstream", workstreamWikiState(value.state), value.entityRevision, value.title, value.summary)],
    ["state", value.state], ["title", value.title], ["goal", value.goal], ["summary", value.summary],
    ["owners", value.owners], ["contributors", value.contributors], ["paths", value.paths],
    ["code", value.code], ["topics", value.topics], ["components", value.components],
    ["related", value.related], ["blockers", value.blockers], ["current_state", value.currentState],
    ["next_milestone", value.nextMilestone], ["created_by", value.createdBy], ["created_at", value.createdAt],
    ["updated_by", value.updatedBy], ["updated_at", value.updatedAt],
  ], "Workstream artifact");
}

export function parseWorkstreamArtifact(bytes: string | Uint8Array, sourcePath: RepoRelativePath): Workstream {
  const { exactBytes, raw } = parseArtifact(bytes, sourcePath);
  exactKeys(raw, WORKSTREAM_KEYS, [], "workstream", sourcePath);
  const mex = parseWikiMetadata(raw.mex, sourcePath);
  const value = normalizeWorkstream({
    id: raw.id as string, entityRevision: mex.revision, state: raw.state as Workstream["state"],
    title: raw.title as string, goal: raw.goal as string, summary: raw.summary as string,
    owners: raw.owners as ActorRef[], contributors: raw.contributors as ActorRef[], paths: raw.paths as RepoRelativePath[],
    code: raw.code as CodeRef[], topics: raw.topics as EntityRef[], components: raw.components as EntityRef[],
    related: raw.related as EntityRef[], blockers: raw.blockers as string[], currentState: raw.current_state as string,
    nextMilestone: raw.next_milestone as string, createdBy: raw.created_by as ActorRef, createdAt: raw.created_at as string,
    updatedBy: raw.updated_by as ActorRef, updatedAt: raw.updated_at as string,
  });
  const expectedPath = workstreamArtifactPath(value.id);
  if (sourcePath !== expectedPath) fail(`Workstream path must be ${expectedPath}.`, sourcePath);
  assertWikiMetadata(mex, value.id, "workstream", workstreamWikiState(value.state), value.entityRevision, value.title, value.summary, sourcePath);
  canonicalBytes(exactBytes, serializeWorkstreamArtifact(value), sourcePath);
  return { ...base(value.id, "workstream", value.title, sourcePath, exactBytes), ...withoutId(value) };
}

export function serializeInboxProposalArtifact<TPayload>(input: InboxProposalArtifactInput<TPayload>): string {
  const value = normalizeProposal(input);
  return encodeArtifact([
    ["schema_version", 1], ["id", value.id], ["state", value.state], ["author", value.author],
    ["rationale", value.rationale], ["evidence", value.evidence], ["request", value.request],
    ["target_revisions", value.targetRevisions],
    ...(value.reviewer === undefined ? [] : [["reviewer", value.reviewer] as const]),
    ...(value.reviewRationale === undefined ? [] : [["review_rationale", value.reviewRationale] as const]),
    ...(value.reviewedAt === undefined ? [] : [["reviewed_at", value.reviewedAt] as const]),
  ], "Inbox proposal artifact");
}

export function parseInboxProposalArtifact<TPayload = JsonValue>(bytes: string | Uint8Array, sourcePath: RepoRelativePath): InboxProposal<TPayload> {
  const { exactBytes, raw } = parseArtifact(bytes, sourcePath);
  exactKeys(raw, PROPOSAL_REQUIRED_KEYS, PROPOSAL_OPTIONAL_KEYS, "inbox proposal", sourcePath);
  const value = normalizeProposal<TPayload>({
    id: raw.id as string, state: raw.state as InboxProposal<TPayload>["state"], author: raw.author as ActorRef,
    rationale: raw.rationale as string, evidence: raw.evidence as TeamEvidenceRef[],
    request: raw.request as PortableWikiOperationRequest<TPayload>, targetRevisions: raw.target_revisions as RevisionExpectation[],
    ...(raw.reviewer === undefined ? {} : { reviewer: raw.reviewer as ActorRef }),
    ...(raw.review_rationale === undefined ? {} : { reviewRationale: raw.review_rationale as string }),
    ...(raw.reviewed_at === undefined ? {} : { reviewedAt: raw.reviewed_at as string }),
  });
  const expectedPath = inboxProposalArtifactPath(value.id);
  if (sourcePath !== expectedPath) fail(`Inbox proposal path must be ${expectedPath}.`, sourcePath);
  canonicalBytes(exactBytes, serializeInboxProposalArtifact(value), sourcePath);
  return { ...base(value.id, "proposal", undefined, sourcePath, exactBytes), ...withoutId(value) };
}

export function serializeRelayArtifact(input: RelayArtifactInput): string {
  const value = normalizeRelay(input);
  return encodeArtifact([
    ["schema_version", value.schemaVersion], ["id", value.id],
    ["mex", wikiMetadata(value.id, "relay", relayWikiState(value.state), value.entityRevision, `Relay ${value.id}`, value.summary)],
    ["state", value.state], ["sender", value.sender],
    ...(value.schemaVersion === 4 ? [["audience", value.audience] as const] : []),
    ["recipients", value.recipients],
    ...(value.schemaVersion === 1 || value.schemaVersion === 2 ? [["workstream", value.workstream] as const] : []),
    ["summary", value.summary], ["completed", value.completed], ["in_progress", value.inProgress], ["decisions", value.decisions],
    ["blockers", value.blockers], ["unresolved_questions", value.unresolvedQuestions], ["changed_files", value.changedFiles],
    ["code", value.code], ["evidence", value.evidence], ["next_actions", value.nextActions],
    ...(value.publishedAt === undefined ? [] : [["published_at", value.publishedAt] as const]),
    ...(value.schemaVersion === 3 || value.schemaVersion === 4
      ? [["published_repo_state", value.publishedRepoState] as const]
      : []),
    ...(value.acknowledgedBy === undefined ? [] : [["acknowledged_by", value.acknowledgedBy] as const]),
    ...(value.acknowledgedAt === undefined ? [] : [["acknowledged_at", value.acknowledgedAt] as const]),
    ...(value.closedBy === undefined ? [] : [["closed_by", value.closedBy] as const]),
    ...(value.closedAt === undefined ? [] : [["closed_at", value.closedAt] as const]),
  ], "Relay artifact");
}

export function parseRelayArtifact(bytes: string | Uint8Array, sourcePath: RepoRelativePath): Relay {
  const { exactBytes, raw } = parseArtifact(bytes, sourcePath, [1, 2, 3, 4]);
  const schemaVersion = raw.schema_version as 1 | 2 | 3 | 4;
  exactKeys(
    raw,
    schemaVersion === 4
      ? RELAY_V4_REQUIRED_KEYS
      : schemaVersion === 3
        ? RELAY_V3_REQUIRED_KEYS
        : schemaVersion === 2
          ? RELAY_V2_REQUIRED_KEYS
          : RELAY_REQUIRED_KEYS,
    RELAY_OPTIONAL_KEYS,
    "relay",
    sourcePath,
  );
  const mex = parseWikiMetadata(raw.mex, sourcePath);
  const common = {
    id: raw.id as string, entityRevision: mex.revision, state: raw.state as Relay["state"], sender: raw.sender as ActorRef,
    recipients: raw.recipients as ActorRef[], summary: raw.summary as string,
    completed: raw.completed as string[], inProgress: raw.in_progress as string[], decisions: raw.decisions as EntityRef[],
    blockers: raw.blockers as string[], unresolvedQuestions: raw.unresolved_questions as string[], changedFiles: raw.changed_files as RepoRelativePath[],
    code: raw.code as CodeRef[], evidence: raw.evidence as TeamEvidenceRef[], nextActions: raw.next_actions as string[],
    ...(raw.acknowledged_by === undefined ? {} : { acknowledgedBy: raw.acknowledged_by as ActorRef }),
    ...(raw.acknowledged_at === undefined ? {} : { acknowledgedAt: raw.acknowledged_at as string }),
    ...(raw.closed_by === undefined ? {} : { closedBy: raw.closed_by as ActorRef }),
    ...(raw.closed_at === undefined ? {} : { closedAt: raw.closed_at as string }),
  };
  const value = normalizeRelay(schemaVersion === 3 || schemaVersion === 4
    ? {
        ...common,
        ...(schemaVersion === 4
          ? { schemaVersion, audience: raw.audience as "team" }
          : { schemaVersion }),
        publishedAt: raw.published_at as string,
        publishedRepoState: raw.published_repo_state as RepoState,
      }
    : schemaVersion === 2
      ? {
          ...common,
          schemaVersion,
          workstream: raw.workstream as EntityRef,
          publishedAt: raw.published_at as string,
        }
      : {
          ...common,
          schemaVersion,
          workstream: raw.workstream as EntityRef,
        });
  const expectedPath = relayArtifactPath(value.id);
  if (sourcePath !== expectedPath) fail(`Relay path must be ${expectedPath}.`, sourcePath);
  assertWikiMetadata(mex, value.id, "relay", relayWikiState(value.state), value.entityRevision, `Relay ${value.id}`, value.summary, sourcePath);
  canonicalBytes(exactBytes, serializeRelayArtifact(value), sourcePath);
  return {
    ref: { id: value.id, kind: "relay" },
    kind: "relay",
    sourcePath,
    revision: revisionOf(exactBytes),
    ...withoutId(value),
  } as Relay;
}

export function serializePlaybookArtifact(input: PlaybookArtifactInput): string {
  const value = normalizePlaybook(input);
  return encodeArtifact([
    ["schema_version", 1], ["id", value.id],
    ["mex", wikiMetadata(value.id, "playbook", playbookWikiState(value.state), value.entityRevision, value.title, value.purpose)],
    ["state", value.state], ["title", value.title], ["purpose", value.purpose], ["trigger", value.trigger],
    ["owners", value.owners], ["prerequisites", value.prerequisites], ["steps", value.steps], ["related", value.related],
  ], "Playbook artifact");
}

export function parsePlaybookArtifact(bytes: string | Uint8Array, sourcePath: RepoRelativePath): Playbook {
  const { exactBytes, raw } = parseArtifact(bytes, sourcePath);
  exactKeys(raw, PLAYBOOK_KEYS, [], "playbook", sourcePath);
  const mex = parseWikiMetadata(raw.mex, sourcePath);
  const value = normalizePlaybook({
    id: raw.id as string, entityRevision: mex.revision, state: raw.state as Playbook["state"], title: raw.title as string,
    purpose: raw.purpose as string, trigger: raw.trigger as string, owners: raw.owners as ActorRef[],
    prerequisites: raw.prerequisites as string[], steps: raw.steps as PlaybookStepDefinition[], related: raw.related as EntityRef[],
  });
  const expectedPath = playbookArtifactPath(value.id);
  if (sourcePath !== expectedPath) fail(`Playbook path must be ${expectedPath}.`, sourcePath);
  assertWikiMetadata(mex, value.id, "playbook", playbookWikiState(value.state), value.entityRevision, value.title, value.purpose, sourcePath);
  canonicalBytes(exactBytes, serializePlaybookArtifact(value), sourcePath);
  return { ...base(value.id, "playbook", value.title, sourcePath, exactBytes), ...withoutId(value) };
}

export function serializePlaybookRunArtifact(input: PlaybookRunArtifactInput): string {
  const value = normalizeRun(input);
  return encodeArtifact([
    ["schema_version", 1], ["id", value.id],
    ["mex", wikiMetadata(value.id, "playbook_run", runWikiState(value.state), value.entityRevision, `Playbook run ${value.id}`)],
    ["state", value.state], ["playbook", value.playbook], ["workstream", value.workstream], ["steps", value.steps],
    ["started_by", value.startedBy], ["started_at", value.startedAt],
  ], "Playbook run artifact");
}

export function parsePlaybookRunArtifact(bytes: string | Uint8Array, sourcePath: RepoRelativePath): PlaybookRun {
  const { exactBytes, raw } = parseArtifact(bytes, sourcePath);
  exactKeys(raw, RUN_KEYS, [], "playbook run", sourcePath);
  const mex = parseWikiMetadata(raw.mex, sourcePath);
  const value = normalizeRun({
    id: raw.id as string, entityRevision: mex.revision, state: raw.state as PlaybookRun["state"], playbook: raw.playbook as EntityRef,
    workstream: raw.workstream as EntityRef, steps: raw.steps as PlaybookRunStep[], startedBy: raw.started_by as ActorRef,
    startedAt: raw.started_at as string,
  });
  const expectedPath = playbookRunArtifactPath(value.id);
  if (sourcePath !== expectedPath) fail(`Playbook run path must be ${expectedPath}.`, sourcePath);
  assertWikiMetadata(mex, value.id, "playbook_run", runWikiState(value.state), value.entityRevision, `Playbook run ${value.id}`, undefined, sourcePath);
  canonicalBytes(exactBytes, serializePlaybookRunArtifact(value), sourcePath);
  return { ...base(value.id, "playbook_run", undefined, sourcePath, exactBytes), ...withoutId(value) };
}

/** Strict canonical projection used before a local Inbox draft is persisted. */
export function normalizeInboxDraftInput<TPayload>(
  input: InboxDraftInput<TPayload>,
): InboxDraftInput<TPayload> {
  const value = record(input, "Inbox draft");
  exactObject(
    value,
    ["request", "rationale", "evidence", "targetRevisions"],
    [],
    "Inbox draft",
  );
  return {
    request: portableWikiRequest<TPayload>(value.request),
    rationale: inboxText(value.rationale, "Inbox draft rationale", 8 * 1024),
    evidence: evidenceList(value.evidence, true),
    targetRevisions: portableWorkflowRevisionExpectations(
      value.targetRevisions,
      "Inbox draft target revisions",
    ),
  };
}

/** Closed governed-Inbox evidence projection for product request validation. */
export function normalizeInboxEvidence(value: unknown): readonly TeamEvidenceRef[] {
  return evidenceList(value, true);
}

/**
 * Canonical standalone Relay draft projection. Sparse caller input is expanded
 * before hashing or persistence. The optional Workstream key is a read-time
 * compatibility seam for pre-v3 checkout-local payloads only.
 */
export function normalizeRelayDraftInput(input: unknown): RelayDraftInput {
  return normalizeRelayDraftInputWithLegacy(input).input;
}

export interface NormalizedRelayDraftWithLegacy {
  input: RelayDraftInput;
  /** Validated pre-translation fields used only by exact legacy intent recovery. */
  legacy: {
    workstream: EntityRef;
    evidence: readonly TeamEvidenceRef[];
  } | null;
}

export function normalizeRelayDraftInputWithLegacy(
  input: unknown,
): NormalizedRelayDraftWithLegacy {
  const value = record(input, "Relay draft");
  exactObject(
    value,
    ["recipients", "summary"],
    [
      "workstream", "completed", "inProgress", "decisions", "blockers",
      "unresolvedQuestions", "changedFiles", "code", "evidence",
      "nextActions", "audience",
    ],
    "Relay draft",
  );
  const legacyWorkstream = value.workstream === undefined
    ? null
    : entity(value.workstream, "legacy Relay draft Workstream", "workstream");
  if (
    legacyWorkstream !== null
    && !isArtifactId(legacyWorkstream.id, "ws")
  ) {
    invalid("Legacy Relay draft Workstream must use a ws_ prefixed ULID.");
  }
  const originalEvidence = legacyWorkstream === null
    ? null
    : evidenceList(value.evidence ?? []);
  const audience = value.audience === undefined
    ? undefined
    : enumValue(value.audience, ["team", "members"] as const, "Relay draft audience");
  const recipients = actorSet(value.recipients, "Relay draft recipients");
  if (recipients.length > 32 || recipients.some((recipient) => recipient.kind !== "member")) {
    invalid("Relay draft recipients may contain up to 32 canonical Members.");
  }
  uniqueBy(
    recipients,
    (recipient) => (recipient as Extract<ActorRef, { kind: "member" }>).memberId,
    "Relay draft recipient Member IDs must be unique.",
  );
  if (audience === "team" && recipients.length !== 0) {
    invalid("Team Relay drafts must have no named recipients.");
  }
  return {
    input: {
    ...(audience === undefined ? {} : { audience }),
    recipients,
    summary: text(value.summary, "Relay draft summary", 8 * 1024),
    completed: textList(value.completed ?? [], "Relay draft completed items"),
    inProgress: textList(value.inProgress ?? [], "Relay draft in-progress items"),
    decisions: entitySet(value.decisions ?? [], "Relay draft decisions"),
    blockers: textList(value.blockers ?? [], "Relay draft blockers"),
    unresolvedQuestions: textList(
      value.unresolvedQuestions ?? [],
      "Relay draft unresolved questions",
    ),
    changedFiles: pathSet(value.changedFiles ?? [], "Relay draft changed files"),
    code: codeSet(value.code ?? [], "Relay draft code references"),
    evidence: normalizeRelayDraftEvidence(value.evidence ?? [], legacyWorkstream),
    nextActions: textList(value.nextActions ?? [], "Relay draft next actions"),
    },
    legacy: legacyWorkstream === null
      ? null
      : { workstream: legacyWorkstream, evidence: originalEvidence! },
  };
}

/** Strict bounded optimistic preconditions for a workflow command. */
export function normalizeWorkflowRevisionExpectations(
  value: unknown,
): readonly RevisionExpectation[] {
  return revisionExpectations(value, "Workflow revision expectations");
}

function normalizeWorkstream(input: WorkstreamArtifactInput): WorkstreamArtifactInput {
  const value = record(input, "workstream");
  exactObject(value, [
    "id", "entityRevision", "state", "title", "goal", "summary", "owners", "contributors", "paths", "code",
    "topics", "components", "related", "blockers", "currentState", "nextMilestone", "createdBy", "createdAt",
    "updatedBy", "updatedAt",
  ], [], "workstream");
  const normalized: WorkstreamArtifactInput = {
    id: artifactId(value.id, "ws", "workstream ID"),
    entityRevision: semanticRevision(value.entityRevision),
    state: enumValue(value.state, WORKSTREAM_STATES, "workstream state"),
    title: text(value.title, "workstream title", 512),
    goal: text(value.goal, "workstream goal", 4 * 1024),
    summary: text(value.summary, "workstream summary", 4 * 1024),
    owners: actorSet(value.owners, "workstream owners", true),
    contributors: actorSet(value.contributors, "workstream contributors"),
    paths: pathSet(value.paths, "workstream paths"),
    code: codeSet(value.code, "workstream code references"),
    topics: entitySet(value.topics, "workstream topics"),
    components: entitySet(value.components, "workstream components"),
    related: entitySet(value.related, "workstream related entities"),
    blockers: textList(value.blockers, "workstream blockers"),
    currentState: text(value.currentState, "workstream current state", 8 * 1024),
    nextMilestone: text(value.nextMilestone, "workstream next milestone", 4 * 1024),
    createdBy: actor(value.createdBy, "workstream creator"),
    createdAt: timestamp(value.createdAt, "workstream creation time"),
    updatedBy: actor(value.updatedBy, "workstream updater"),
    updatedAt: timestamp(value.updatedAt, "workstream update time"),
  };
  if (normalized.createdAt > normalized.updatedAt) invalid("Workstream creation time cannot follow update time.");
  if ((normalized.state === "blocked") !== (normalized.blockers.length > 0)) {
    invalid("A blocked workstream must have blockers, and other states must not retain blockers.");
  }
  return normalized;
}

function normalizeProposal<TPayload>(input: InboxProposalArtifactInput<TPayload>): InboxProposalArtifactInput<TPayload> {
  const value = record(input, "inbox proposal");
  exactObject(value, ["id", "state", "author", "rationale", "evidence", "request", "targetRevisions"], [
    "reviewer", "reviewRationale", "reviewedAt",
  ], "inbox proposal");
  const reviewer = value.reviewer === undefined ? undefined : actor(value.reviewer, "proposal reviewer");
  const reviewRationale = value.reviewRationale === undefined
    ? undefined
    : inboxText(value.reviewRationale, "proposal review rationale", 8 * 1024);
  const reviewedAt = value.reviewedAt === undefined ? undefined : timestamp(value.reviewedAt, "proposal review time");
  const state = enumValue(value.state, PROPOSAL_STATES, "proposal state");
  if ((reviewer === undefined) !== (reviewedAt === undefined)) {
    invalid("Proposal reviewer and review time must be recorded together.");
  }
  if ((state === "approved" || state === "rejected" || state === "withdrawn") && reviewer === undefined) {
    invalid("Approved, rejected, and withdrawn proposals require action authority and time.");
  }
  if (state === "rejected" && reviewRationale === undefined) {
    invalid("Rejected proposals require review rationale.");
  }
  if ((state === "pending" || state === "stale") && reviewer !== undefined) {
    invalid(`${state} proposals must not carry reviewer authority.`);
  }
  if (reviewRationale !== undefined && reviewer === undefined) {
    invalid("Proposal review rationale requires a reviewer.");
  }
  return {
    id: artifactId(value.id, "proposal", "proposal ID"),
    state,
    author: actor(value.author, "proposal author"),
    rationale: inboxText(value.rationale, "proposal rationale", 8 * 1024),
    evidence: evidenceList(value.evidence, true),
    request: portableWikiRequest<TPayload>(value.request),
    targetRevisions: portableWorkflowRevisionExpectations(
      value.targetRevisions,
      "proposal target revisions",
    ),
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(reviewRationale === undefined ? {} : { reviewRationale }),
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
  };
}

function normalizeRelay(input: RelayArtifactInput): NormalizedRelayArtifactInput {
  const value = record(input, "relay");
  const inferredSchemaVersion = value.schemaVersion === undefined
    ? value.publishedAt === undefined ? 1 : 2
    : value.schemaVersion;
  if (
    inferredSchemaVersion !== 1
    && inferredSchemaVersion !== 2
    && inferredSchemaVersion !== 3
    && inferredSchemaVersion !== 4
  ) invalid("Relay schema version is invalid.");
  const schemaVersion = inferredSchemaVersion as 1 | 2 | 3 | 4;
  const commonKeys = [
    "id", "entityRevision", "state", "sender", "recipients", "summary",
    "completed", "inProgress", "decisions", "blockers",
    "unresolvedQuestions", "changedFiles", "code", "evidence",
    "nextActions",
  ] as const;
  const lifecycleKeys = [
    "acknowledgedBy", "acknowledgedAt", "closedBy", "closedAt",
  ] as const;
  if (schemaVersion === 4) {
    exactObject(
      value,
      [...commonKeys, "schemaVersion", "audience", "publishedAt", "publishedRepoState"],
      lifecycleKeys,
      "schema-v4 relay",
    );
    if (value.audience !== "team") invalid("Schema-v4 Relay audience must be team.");
  } else if (schemaVersion === 3) {
    exactObject(
      value,
      [...commonKeys, "schemaVersion", "publishedAt", "publishedRepoState"],
      lifecycleKeys,
      "schema-v3 relay",
    );
  } else if (schemaVersion === 2) {
    exactObject(
      value,
      [...commonKeys, "workstream", "publishedAt"],
      ["schemaVersion", ...lifecycleKeys],
      "schema-v2 relay",
    );
  } else {
    exactObject(
      value,
      [...commonKeys, "workstream"],
      ["schemaVersion", ...lifecycleKeys],
      "schema-v1 relay",
    );
  }
  const state = enumValue(value.state, RELAY_STATES, "relay state");
  const publishedAt = schemaVersion === 1
    ? undefined
    : timestamp(value.publishedAt, "relay publication time");
  const acknowledgedBy = value.acknowledgedBy === undefined ? undefined : actor(value.acknowledgedBy, "relay acknowledger");
  const acknowledgedAt = value.acknowledgedAt === undefined ? undefined : timestamp(value.acknowledgedAt, "relay acknowledgement time");
  const closedBy = value.closedBy === undefined ? undefined : actor(value.closedBy, "relay closer");
  const closedAt = value.closedAt === undefined ? undefined : timestamp(value.closedAt, "relay close time");
  if ((acknowledgedBy === undefined) !== (acknowledgedAt === undefined)) invalid("Relay acknowledgement actor and time must be recorded together.");
  if ((closedBy === undefined) !== (closedAt === undefined)) invalid("Relay close actor and time must be recorded together.");
  if (state === "published" && (acknowledgedBy !== undefined || closedBy !== undefined)) invalid("Published relays must not carry acknowledgement or close authority.");
  if (state === "acknowledged" && (acknowledgedBy === undefined || closedBy !== undefined)) invalid("Acknowledged relays require acknowledgement authority and no close authority.");
  if (state === "closed" && (acknowledgedBy === undefined || closedBy === undefined)) invalid("Closed relays require acknowledgement and close authority.");
  if (publishedAt !== undefined && acknowledgedAt !== undefined && publishedAt > acknowledgedAt) invalid("Relay publication cannot follow acknowledgement.");
  if (acknowledgedAt !== undefined && closedAt !== undefined && acknowledgedAt > closedAt) invalid("Relay acknowledgement cannot follow closure.");
  const sender = actor(value.sender, "relay sender");
  const recipients = actorSet(value.recipients, "relay recipients", schemaVersion !== 4);
  if (schemaVersion === 3 || schemaVersion === 4) {
    if (sender.kind !== "member") {
      invalid(`Schema-v${schemaVersion} Relay sender must be a canonical Member.`);
    }
    if (schemaVersion === 4 && recipients.length !== 0) {
      invalid("Team Relay recipients must be empty.");
    }
    if (
      recipients.length > 32
      || recipients.some((recipient) => recipient.kind !== "member")
    ) {
      invalid(`Schema-v${schemaVersion} Relay recipients must contain between 1 and 32 canonical Members.`);
    }
    const recipientIds = recipients.map((recipient) =>
      (recipient as Extract<ActorRef, { kind: "member" }>).memberId);
    if (new Set(recipientIds).size !== recipientIds.length) {
      invalid(`Schema-v${schemaVersion} Relay recipient Member IDs must be unique.`);
    }
    if (
      (acknowledgedBy !== undefined && acknowledgedBy.kind !== "member")
      || (closedBy !== undefined && closedBy.kind !== "member")
    ) {
      invalid(`Schema-v${schemaVersion} Relay lifecycle principals must be canonical Members.`);
    }
    if (
      schemaVersion === 4
      && closedBy?.kind === "member"
      && closedBy.memberId !== sender.memberId
      && (acknowledgedBy?.kind !== "member" || closedBy.memberId !== acknowledgedBy.memberId)
    ) {
      invalid("Team Relay closer must be its sender or claimant.");
    }
  }
  const common = {
    id: artifactId(value.id, "relay", "relay ID"),
    entityRevision: semanticRevision(value.entityRevision), state,
    sender, recipients,
    summary: text(value.summary, "relay summary", 8 * 1024), completed: textList(value.completed, "relay completed items"),
    inProgress: textList(value.inProgress, "relay in-progress items"), decisions: entitySet(value.decisions, "relay decisions"),
    blockers: textList(value.blockers, "relay blockers"), unresolvedQuestions: textList(value.unresolvedQuestions, "relay unresolved questions"),
    changedFiles: pathSet(value.changedFiles, "relay changed files"), code: codeSet(value.code, "relay code references"),
    evidence: schemaVersion === 3 || schemaVersion === 4
      ? normalizeRelayDraftEvidence(value.evidence, null)
      : evidenceList(value.evidence),
    nextActions: textList(value.nextActions, "relay next actions"),
    ...(acknowledgedBy === undefined ? {} : { acknowledgedBy }), ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
    ...(closedBy === undefined ? {} : { closedBy }), ...(closedAt === undefined ? {} : { closedAt }),
  };
  if (schemaVersion === 3 || schemaVersion === 4) {
    return {
      ...common,
      ...(schemaVersion === 4 ? { schemaVersion, audience: "team" as const } : { schemaVersion }),
      publishedAt: publishedAt!,
      publishedRepoState: repoState(
        value.publishedRepoState,
        "relay publication repository state",
      ),
    };
  }
  const workstream = entity(value.workstream, "relay workstream", "workstream");
  return schemaVersion === 2
    ? { ...common, schemaVersion, workstream, publishedAt: publishedAt! }
    : { ...common, schemaVersion, workstream };
}

function normalizePlaybook(input: PlaybookArtifactInput): PlaybookArtifactInput {
  const value = record(input, "playbook");
  exactObject(value, ["id", "entityRevision", "state", "title", "purpose", "trigger", "owners", "prerequisites", "steps", "related"], [], "playbook");
  const steps = array(value.steps, "playbook steps", PLAYBOOK_STEP_LIMIT, true).map((item, index) => playbookStep(item, index));
  uniqueBy(steps, (step) => step.id, "Playbook step IDs must be unique.");
  return {
    id: artifactId(value.id, "playbook", "playbook ID"), entityRevision: semanticRevision(value.entityRevision),
    state: enumValue(value.state, PLAYBOOK_STATES, "playbook state"), title: text(value.title, "playbook title", 512),
    purpose: text(value.purpose, "playbook purpose", 8 * 1024), trigger: text(value.trigger, "playbook trigger", 4 * 1024),
    owners: actorSet(value.owners, "playbook owners", true), prerequisites: textList(value.prerequisites, "playbook prerequisites"),
    steps, related: entitySet(value.related, "playbook related entities"),
  };
}

function normalizeRun(input: PlaybookRunArtifactInput): PlaybookRunArtifactInput {
  const value = record(input, "playbook run");
  exactObject(value, ["id", "entityRevision", "state", "playbook", "workstream", "steps", "startedBy", "startedAt"], [], "playbook run");
  const steps = array(value.steps, "playbook run steps", PLAYBOOK_STEP_LIMIT, true).map((item, index) => runStep(item, index));
  uniqueBy(steps, (step) => step.stepId, "Playbook run step IDs must be unique.");
  const state = enumValue(value.state, PLAYBOOK_RUN_STATES, "playbook run state");
  const complete = steps.every((step) => step.completedBy !== undefined);
  if ((state === "completed") !== complete) invalid("A completed playbook run must have every step complete, and an active run must retain an incomplete step.");
  return {
    id: artifactId(value.id, "run", "playbook run ID"), entityRevision: semanticRevision(value.entityRevision), state,
    playbook: entity(value.playbook, "playbook run playbook", "playbook"), workstream: entity(value.workstream, "playbook run workstream", "workstream"),
    steps, startedBy: actor(value.startedBy, "playbook run starter"), startedAt: timestamp(value.startedAt, "playbook run start time"),
  };
}

function playbookStep(value: unknown, index: number): PlaybookStepDefinition {
  const item = record(value, `playbook step ${index}`);
  exactObject(item, ["id", "title", "instructions", "requiredChecks", "expectedOutputs"], [], `playbook step ${index}`);
  return {
    id: identifier(item.id, `playbook step ${index} ID`), title: text(item.title, `playbook step ${index} title`, 512),
    instructions: text(item.instructions, `playbook step ${index} instructions`, 8 * 1024),
    requiredChecks: textList(item.requiredChecks, `playbook step ${index} checks`, PLAYBOOK_STEP_DETAIL_LIMIT),
    expectedOutputs: textList(item.expectedOutputs, `playbook step ${index} outputs`, PLAYBOOK_STEP_DETAIL_LIMIT),
  };
}

function runStep(value: unknown, index: number): PlaybookRunStep {
  const item = record(value, `playbook run step ${index}`);
  exactObject(item, ["stepId"], ["completedBy", "completedAt"], `playbook run step ${index}`);
  const completedBy = item.completedBy === undefined ? undefined : actor(item.completedBy, `playbook run step ${index} completer`);
  const completedAt = item.completedAt === undefined ? undefined : timestamp(item.completedAt, `playbook run step ${index} completion time`);
  if ((completedBy === undefined) !== (completedAt === undefined)) invalid(`Playbook run step ${index} completion actor and time must be recorded together.`);
  return { stepId: identifier(item.stepId, `playbook run step ${index} ID`), ...(completedBy === undefined ? {} : { completedBy }), ...(completedAt === undefined ? {} : { completedAt }) };
}

function portableWikiRequest<TPayload>(value: unknown): PortableWikiOperationRequest<TPayload> {
  const request = record(value, "portable Wiki request");
  exactObject(request, ["operation", "expectedRevisions"], [], "portable Wiki request");
  const operation = record(request.operation, "portable Wiki operation");
  exactObject(operation, ["opId", "type", "payload"], ["entityId", "baseRevision", "baseContentHash", "reason"], "portable Wiki operation");
  const type = enumValue(operation.type, WIKI_OPERATION_TYPES, "Wiki operation type");
  const normalized = {
    operation: {
      opId: text(operation.opId, "Wiki operation ID", 256), type,
      ...(operation.entityId === undefined ? {} : { entityId: text(operation.entityId, "Wiki entity ID", 256) }),
      ...(operation.baseRevision === undefined ? {} : { baseRevision: positiveInteger(operation.baseRevision, "Wiki base revision") }),
      ...(operation.baseContentHash === undefined ? {} : { baseContentHash: revision(operation.baseContentHash, "Wiki base content hash") }),
      ...(operation.reason === undefined ? {} : { reason: text(operation.reason, "Wiki operation reason", 8 * 1024) }),
      payload: jsonValue(operation.payload, "Wiki operation payload") as TPayload,
    },
    expectedRevisions: wikiRevisionExpectations(request.expectedRevisions),
  } satisfies PortableWikiOperationRequest<TPayload>;
  if (Buffer.byteLength(stableJson(normalized), "utf8") > PORTABLE_WIKI_REQUEST_MAX_BYTES) {
    invalid(`Portable Wiki request exceeds ${PORTABLE_WIKI_REQUEST_MAX_BYTES} bytes.`);
  }
  return normalized;
}

function wikiRevisionExpectations(value: unknown): readonly WikiRevisionExpectation[] {
  return array(value, "Wiki revision expectations", WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES).map((entry, index) => {
    const expectation = record(entry, `Wiki revision expectation ${index}`);
    exactObject(expectation, ["target"], ["version", "contentHash"], `Wiki revision expectation ${index}`);
    const target = record(expectation.target, `Wiki revision target ${index}`);
    if (target.kind === "entity") {
      exactObject(target, ["kind", "id"], [], `Wiki entity target ${index}`);
      if (!Object.hasOwn(expectation, "version") || Object.hasOwn(expectation, "contentHash")) invalid(`Wiki entity expectation ${index} must carry version only.`);
      const rawVersion = expectation.version;
      const version = rawVersion === null ? null : (() => {
        const parsed = record(rawVersion, `Wiki entity version ${index}`);
        exactObject(parsed, ["semanticRevision", "contentHash"], [], `Wiki entity version ${index}`);
        return { semanticRevision: positiveInteger(parsed.semanticRevision, `Wiki entity semantic revision ${index}`), contentHash: revision(parsed.contentHash, `Wiki entity content hash ${index}`) };
      })();
      return { target: { kind: "entity" as const, id: text(target.id, `Wiki entity target ${index} ID`, 256) }, version };
    }
    if (target.kind === "artifact") {
      exactObject(target, ["kind", "path"], [], `Wiki artifact target ${index}`);
      if (!Object.hasOwn(expectation, "contentHash") || Object.hasOwn(expectation, "version")) invalid(`Wiki artifact expectation ${index} must carry contentHash only.`);
      return {
        target: { kind: "artifact" as const, path: repoPath(target.path, `Wiki artifact target ${index} path`) },
        contentHash: expectation.contentHash === null ? null : revision(expectation.contentHash, `Wiki artifact content hash ${index}`),
      };
    }
    invalid(`Wiki revision target ${index} kind is invalid.`);
  });
}

function revisionExpectations(value: unknown, label: string): readonly RevisionExpectation[] {
  return array(value, label, WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES).map((entry, index) => {
    const expectation = record(entry, `${label} ${index}`);
    exactObject(expectation, ["target", "revision"], ["semanticRevision"], `${label} ${index}`);
    const target = record(expectation.target, `${label} ${index} target`);
    const expectedRevision = expectation.revision === null ? null : revision(expectation.revision, `${label} ${index} revision`);
    if (target.kind === "entity") {
      exactObject(target, ["kind", "id"], [], `${label} ${index} entity target`);
      const semantic = expectation.semanticRevision;
      if (expectedRevision !== null && semantic === undefined) invalid(`${label} ${index} existing entity requires semanticRevision.`);
      return {
        target: { kind: "entity" as const, id: text(target.id, `${label} ${index} entity ID`, 256) }, revision: expectedRevision,
        ...(semantic === undefined ? {} : { semanticRevision: semantic === null ? null : positiveInteger(semantic, `${label} ${index} semantic revision`) }),
      };
    }
    if (target.kind === "artifact") {
      exactObject(target, ["kind", "path"], [], `${label} ${index} artifact target`);
      if (expectation.semanticRevision !== undefined) invalid(`${label} ${index} artifact target must not carry semanticRevision.`);
      return { target: { kind: "artifact" as const, path: repoPath(target.path, `${label} ${index} artifact path`) }, revision: expectedRevision };
    }
    if (target.kind === "local") {
      exactObject(target, ["kind", "namespace", "id"], [], `${label} ${index} local target`);
      if (!(target.namespace === "inbox-draft" || target.namespace === "relay-draft" || target.namespace === "cursor" || target.namespace === "job" || target.namespace === "member-selection")) invalid(`${label} ${index} local namespace is invalid.`);
      if (expectation.semanticRevision !== undefined) invalid(`${label} ${index} local target must not carry semanticRevision.`);
      return { target: { kind: "local" as const, namespace: target.namespace, id: text(target.id, `${label} ${index} local ID`, 256) }, revision: expectedRevision };
    }
    invalid(`${label} ${index} target kind is invalid.`);
  });
}

function portableWorkflowRevisionExpectations(
  value: unknown,
  label: string,
): readonly RevisionExpectation[] {
  const expectations = revisionExpectations(value, label);
  for (const expectation of expectations) {
    if (expectation.target.kind === "local") {
      invalid(`${label} must not contain checkout-local targets.`);
    }
    if (expectation.target.kind === "artifact") {
      const path = expectation.target.path.toLowerCase();
      if (path === ".mex/local" || path.startsWith(".mex/local/")) {
        invalid(`${label} must not contain checkout-local artifact paths.`);
      }
    }
  }
  return expectations;
}

function evidenceList(
  value: unknown,
  inboxCanonicalText = false,
  limit = WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES,
): readonly TeamEvidenceRef[] {
  return array(value, "proposal/relay evidence", limit).map((entry, index) => {
    const item = record(entry, `evidence ${index}`);
    if (item.kind === "entity") {
      exactObject(item, ["kind", "entity"], [], `entity evidence ${index}`);
      return { kind: "entity" as const, entity: entity(item.entity, `entity evidence ${index}`) };
    }
    if (item.kind === "code") {
      exactObject(item, ["kind", "code"], [], `code evidence ${index}`);
      return { kind: "code" as const, code: code(item.code, `code evidence ${index}`) };
    }
    if (item.kind === "commit") {
      exactObject(item, ["kind", "hash"], [], `commit evidence ${index}`);
      return { kind: "commit" as const, hash: gitHash(item.hash, `commit evidence ${index}`) };
    }
    if (item.kind === "file") {
      exactObject(item, ["kind", "path"], [], `file evidence ${index}`);
      return { kind: "file" as const, path: repoPath(item.path, `file evidence ${index}`) };
    }
    if (item.kind === "external") {
      exactObject(item, ["kind", "uri"], ["label"], `external evidence ${index}`);
      const uri = externalUri(item.uri, `external evidence ${index}`, inboxCanonicalText);
      return { kind: "external" as const, uri, ...(item.label === undefined ? {} : { label: text(item.label, `external evidence ${index} label`, 512) }) };
    }
    if (item.kind === "manual") {
      exactObject(item, ["kind", "note"], [], `manual evidence ${index}`);
      return {
        kind: "manual" as const,
        note: inboxCanonicalText
          ? inboxText(item.note, `manual evidence ${index} note`, 4 * 1024)
          : text(item.note, `manual evidence ${index} note`, 4 * 1024),
      };
    }
    invalid(`Evidence ${index} kind is invalid.`);
  });
}

function normalizeRelayDraftEvidence(
  value: unknown,
  legacyWorkstream: EntityRef | null,
): readonly TeamEvidenceRef[] {
  if (legacyWorkstream !== null) {
    const evidence = evidenceList(value);
    const translated = { kind: "entity" as const, entity: legacyWorkstream };
    return evidence.some((item) => stableJson(item) === stableJson(translated))
      ? evidence
      : [translated, ...evidence];
  }
  const evidence = evidenceList(
    value,
    false,
    WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES + 1,
  );
  if (evidence.length <= WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES) {
    return evidence;
  }
  const migrationEvidence = evidence[0];
  if (
    migrationEvidence?.kind !== "entity"
    || migrationEvidence.entity.kind !== "workstream"
    || !isArtifactId(migrationEvidence.entity.id, "ws")
  ) {
    invalid(
      "Relay evidence exceeds 64 entries without the reserved translated Workstream evidence slot.",
    );
  }
  return evidence;
}

function actor(value: unknown, label: string): ActorRef {
  const item = record(value, label);
  if (item.kind === "member") {
    exactObject(item, ["kind", "memberId"], ["displayName"], label);
    return {
      kind: "member", memberId: artifactId(item.memberId, "member", `${label} member ID`),
      ...(item.displayName === undefined ? {} : { displayName: text(item.displayName, `${label} display name`, 512) }),
    };
  }
  if (item.kind === "git") {
    exactObject(item, ["kind", "name", "email"], [], label);
    const name = item.name === null ? null : text(item.name, `${label} Git name`, 512);
    const email = item.email === null ? null : text(item.email, `${label} Git email`, 512);
    if (name === null && email === null) invalid(`${label} Git identity must contain a name or email.`);
    if (email !== null && (!email.includes("@") || /\s/u.test(email))) invalid(`${label} Git email is invalid.`);
    return { kind: "git", name, email };
  }
  if (item.kind === "unknown") {
    exactObject(item, ["kind"], [], label);
    return { kind: "unknown" };
  }
  invalid(`${label} kind is invalid.`);
}

function actorSet(value: unknown, label: string, requireOne = false): readonly ActorRef[] {
  return sortedSet(array(value, label, WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES, requireOne).map((item) => actor(item, label)), stableJson, `${label} must be unique.`);
}

function entity(value: unknown, label: string, expectedKind?: string): EntityRef {
  const item = record(value, label);
  exactObject(item, ["id", "kind"], ["title"], label);
  const result: EntityRef = {
    id: text(item.id, `${label} ID`, 256), kind: text(item.kind, `${label} kind`, 64),
    ...(item.title === undefined ? {} : { title: text(item.title, `${label} title`, 512) }),
  };
  if (expectedKind !== undefined && result.kind !== expectedKind) invalid(`${label} must have kind ${expectedKind}.`);
  return result;
}

function entitySet(value: unknown, label: string): readonly EntityRef[] {
  return sortedSet(array(value, label, WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES).map((item) => entity(item, label)), (item) => `${item.kind}\0${item.id}`, `${label} must be unique.`);
}

function code(value: unknown, label: string): CodeRef {
  const item = record(value, label);
  if (item.kind === "symbol") {
    exactObject(item, ["kind", "symbolId"], ["fingerprint"], label);
    return { kind: "symbol", symbolId: text(item.symbolId, `${label} symbol ID`, 1024), ...(item.fingerprint === undefined ? {} : { fingerprint: text(item.fingerprint, `${label} fingerprint`, 1024) }) };
  }
  if (item.kind === "file") {
    exactObject(item, ["kind", "path"], ["fingerprint"], label);
    return { kind: "file", path: repoPath(item.path, `${label} file path`), ...(item.fingerprint === undefined ? {} : { fingerprint: text(item.fingerprint, `${label} fingerprint`, 1024) }) };
  }
  invalid(`${label} kind is invalid.`);
}

function codeSet(value: unknown, label: string): readonly CodeRef[] {
  return sortedSet(array(value, label, WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES).map((item) => code(item, label)), stableJson, `${label} must be unique.`);
}

interface WikiMetadata {
  id: string;
  type: string;
  status: "in_flight" | "promoted" | "archived";
  revision: number;
  title: string;
  summary?: string;
}

function wikiMetadata(
  id: string,
  type: string,
  status: WikiMetadata["status"],
  entityRevision: number,
  title: string,
  summary?: string,
): WikiMetadata {
  return { id, type, status, revision: entityRevision, title, ...(summary === undefined ? {} : { summary }) };
}

function parseWikiMetadata(value: unknown, path: RepoRelativePath): WikiMetadata {
  try {
    const item = record(value, "mex entity metadata");
    exactObject(item, ["id", "type", "status", "revision", "title"], ["summary"], "mex entity metadata");
    const status = enumValue(item.status, ["in_flight", "promoted", "archived"] as const, "mex lifecycle status");
    return {
      id: text(item.id, "mex entity ID", 256), type: text(item.type, "mex entity type", 64), status,
      revision: semanticRevision(item.revision), title: text(item.title, "mex entity title", 512),
      ...(item.summary === undefined ? {} : { summary: text(item.summary, "mex entity summary", 8 * 1024) }),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "MexPortError") fail(error.message, path);
    throw error;
  }
}

function assertWikiMetadata(
  actual: WikiMetadata,
  id: string,
  type: string,
  status: WikiMetadata["status"],
  entityRevision: number,
  title: string,
  summary: string | undefined,
  path: RepoRelativePath,
): void {
  if (stableJson(actual) !== stableJson(wikiMetadata(id, type, status, entityRevision, title, summary))) {
    fail("mex entity metadata must match the canonical team artifact fields.", path);
  }
}

function workstreamWikiState(state: Workstream["state"]): WikiMetadata["status"] {
  if (state === "done") return "promoted";
  if (state === "archived") return "archived";
  return "in_flight";
}

function relayWikiState(state: Relay["state"]): WikiMetadata["status"] {
  return state === "closed" ? "archived" : "promoted";
}

function playbookWikiState(state: Playbook["state"]): WikiMetadata["status"] {
  return state === "archived" ? "archived" : "promoted";
}

function runWikiState(state: PlaybookRun["state"]): WikiMetadata["status"] {
  return state === "active" ? "in_flight" : "promoted";
}

function parseArtifact(
  bytes: string | Uint8Array,
  path: RepoRelativePath,
  allowedSchemaVersions: readonly number[] = [1],
): { exactBytes: Uint8Array; raw: Record<string, unknown> } {
  repoPath(path, "artifact source path");
  const exactBytes = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (exactBytes.byteLength > WORKFLOW_ARTIFACT_MAX_BYTES) fail(`Artifact exceeds ${WORKFLOW_ARTIFACT_MAX_BYTES} bytes.`, path);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(exactBytes);
  } catch {
    fail("Artifact must be valid UTF-8.", path);
  }
  if (source.includes("\r")) fail("Artifact must use LF line endings.", path);
  if (!source.startsWith("---\n") || !source.endsWith("---\n")) fail("Artifact must contain frontmatter only and end with a newline.", path);
  const yaml = source.slice(4, -4);
  if (yaml.includes("\n---\n")) fail("Artifact must not contain a Markdown body.", path);
  try {
    const document = parseDocument(yaml, { schema: "core", strict: true, uniqueKeys: true });
    if (document.errors.length > 0) fail(`Invalid YAML: ${document.errors[0]!.message}`, path);
    const raw = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (!isRecord(raw)) fail("Artifact frontmatter must be a mapping.", path);
    if (
      typeof raw.schema_version !== "number"
      || !allowedSchemaVersions.includes(raw.schema_version)
    ) {
      fail(`Artifact schema_version must be ${allowedSchemaVersions.join(" or ")}.`, path);
    }
    return { exactBytes, raw };
  } catch (error) {
    if (error instanceof Error && error.name === "MexPortError") throw error;
    fail(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`, path);
  }
}

function encodeArtifact(entries: readonly (readonly [string, unknown])[], label: string): string {
  const document = `---\n${entries.map(([key, value]) => `${key}: ${stableJson(value)}`).join("\n")}\n---\n`;
  if (Buffer.byteLength(document, "utf8") > WORKFLOW_ARTIFACT_MAX_BYTES) {
    invalid(`${label} exceeds ${WORKFLOW_ARTIFACT_MAX_BYTES} bytes.`);
  }
  return document;
}

function canonicalBytes(bytes: Uint8Array, expected: string, path: RepoRelativePath): void {
  if (!Buffer.from(bytes).equals(Buffer.from(expected, "utf8"))) fail("Artifact bytes are valid but not in canonical deterministic form.", path);
}

function base<TKind extends TeamArtifactKind>(id: string, kind: TKind, title: string | undefined, sourcePath: RepoRelativePath, bytes: Uint8Array): TeamArtifactBase<TKind> {
  return {
    schemaVersion: 1, ref: { id, kind, ...(title === undefined ? {} : { title }) }, kind, sourcePath, revision: revisionOf(bytes),
  };
}

function withoutId<T extends { id: string }>(value: T): Omit<T, "id"> {
  const { id: _id, ...rest } = value;
  return rest;
}

function artifactPath(label: string, prefix: TeamArtifactIdPrefix, id: string, directory: string): RepoRelativePath {
  artifactId(id, prefix, `${label} ID`);
  return `${directory}/${id}.md` as RepoRelativePath;
}

function artifactId(value: unknown, prefix: TeamArtifactIdPrefix, label: string): string {
  if (typeof value !== "string" || !isArtifactId(value, prefix)) invalid(`${label} must be a ${prefix}_ prefixed ULID.`);
  return value;
}

function semanticRevision(value: unknown): number {
  return positiveInteger(value, "entity semantic revision");
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) || new Date(result).toISOString() !== result) {
    invalid(`${label} must be an exact UTC ISO-8601 timestamp.`);
  }
  return result;
}

function repoState(value: unknown, label: string): RepoState {
  const item = record(value, label);
  exactObject(
    item,
    ["branch", "head", "dirty", "observedAt"],
    [],
    label,
  );
  const branch = item.branch === null
    ? null
    : text(item.branch, `${label} branch`, 1_024);
  const head = item.head === null
    ? null
    : gitHash(item.head, `${label} HEAD`);
  if (typeof item.dirty !== "boolean") {
    invalid(`${label} dirty flag must be boolean.`);
  }
  return {
    branch,
    head,
    dirty: item.dirty,
    observedAt: timestamp(item.observedAt, `${label} observation time`),
  };
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) invalid(`${label} must be a nonblank trimmed string.`);
  if (
    value.normalize("NFC") !== value
    || hasLoneSurrogate(value)
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) invalid(`${label} contains non-canonical or control characters.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) invalid(`${label} exceeds ${maxBytes} bytes.`);
  return value;
}

/** E1 governed prose permits TAB/LF but no other controls or non-canonical Unicode. */
function inboxText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || value.normalize("NFC") !== value
    || hasLoneSurrogate(value)
    || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) invalid(`${label} contains invalid text or exceeds ${maxBytes} bytes.`);
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(result)) invalid(`${label} must be a lower-case identifier.`);
  return result;
}

function repoPath(value: unknown, label: string): RepoRelativePath {
  if (
    typeof value !== "string"
    || !isRepoRelativePath(value)
    || value.normalize("NFC") !== value
    || hasLoneSurrogate(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 4096
  ) {
    throw artifactError("PATH_OUTSIDE_PROJECT", "Unsafe repository path", `${label} must be a canonical repository-relative path.`);
  }
  return value;
}

function pathSet(value: unknown, label: string): readonly RepoRelativePath[] {
  return sortedSet(array(value, label, WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES).map((item) => repoPath(item, label)), (item) => item, `${label} must be unique.`);
}

function textList(value: unknown, label: string, limit = WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES): readonly string[] {
  const result = array(value, label, limit).map((item) => text(item, label, 4 * 1024));
  uniqueBy(result, (item) => item, `${label} must be unique.`);
  return result;
}

function gitHash(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) invalid(`${label} must be a full lower-case Git object ID.`);
  return result;
}

function revision(value: unknown, label: string): Revision {
  if (typeof value !== "string" || !isRevision(value)) invalid(`${label} must be a lower-case SHA-256 digest.`);
  return value;
}

function externalUri(value: unknown, label: string, requireCanonicalAbsolute = false): string {
  const result = text(value, `${label} URI`, 4 * 1024);
  if (requireCanonicalAbsolute && (!/^https?:\/\//u.test(result) || /\s/u.test(result))) {
    invalid(`${label} URI must use a whitespace-free lower-case absolute http:// or https:// spelling.`);
  }
  let parsed: URL;
  try { parsed = new URL(result); } catch { invalid(`${label} URI is invalid.`); }
  if (!(parsed.protocol === "https:" || parsed.protocol === "http:") || parsed.username !== "" || parsed.password !== "") invalid(`${label} URI must be an HTTP(S) URL without credentials.`);
  return result;
}

function enumValue<const TValues extends readonly string[]>(value: unknown, values: TValues, label: string): TValues[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(`${label} is invalid.`);
  return value as TValues[number];
}

function array(value: unknown, label: string, limit: number, requireOne = false): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit || (requireOne && value.length === 0)) invalid(`${label} must contain ${requireOne ? `between 1 and ${limit}` : `at most ${limit}`} entries.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || !isPlainRecord(value)) invalid(`${label} must be a plain object.`);
  return value;
}

function exactObject(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) invalid(`${label} has invalid fields (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string, path: RepoRelativePath): void {
  try { exactObject(value, required, optional, `${label} artifact`); } catch (error) {
    if (error instanceof Error && error.name === "MexPortError") fail(error.message, path);
    throw error;
  }
}

function sortedSet<T>(values: readonly T[], keyOf: (value: T) => string, duplicateMessage: string): readonly T[] {
  uniqueBy(values, keyOf, duplicateMessage);
  return [...values].sort((left, right) => compare(keyOf(left), keyOf(right)));
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string, message: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) invalid(message);
    seen.add(key);
  }
}

function jsonValue(value: unknown, label: string): JsonValue {
  let nodes = 0;
  const visit = (current: unknown, depth: number, key?: string): JsonValue => {
    nodes += 1;
    if (nodes > 1024) invalid(`${label} contains too many values.`);
    if (depth > 8) invalid(`${label} nesting is too deep.`);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > 16 * 1024) invalid(`${label} contains an oversized string.`);
      if (current.normalize("NFC") !== current || /\u0000/u.test(current)) invalid(`${label} contains non-canonical text.`);
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalid(`${label} numbers must be finite.`);
      return Object.is(current, -0) ? 0 : current;
    }
    if (Array.isArray(current)) {
      if (current.length > 128) invalid(`${label} arrays may contain at most 128 entries.`);
      return current.map((entry) => visit(entry, depth + 1));
    }
    const item = record(current, label);
    const result: Record<string, JsonValue> = {};
    for (const property of Object.keys(item).sort(compare)) {
      text(property, `${label} key`, 128);
      const normalized = property.toLowerCase().replace(/[^a-z0-9]/gu, "");
      if (["__proto__", "prototype", "constructor"].includes(property)
        || [
          "plan", "handle", "diff", "patch", "sourcedump", "sourcebody",
          "sourcecode", "rawsource", "prompt", "transcript", "credentials",
          "credential", "secret", "password", "token",
        ].some((blocked) => normalized.includes(blocked))) {
        invalid(`${label} must not contain process-local or sensitive field ${property}.`);
      }
      Object.defineProperty(result, property, { value: visit(item[property], depth + 1, property), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return visit(value, 0);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compare)) {
    Object.defineProperty(result, key, { value: sortJson(value[key]), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(detail: string): never {
  throw artifactError("VALIDATION_FAILED", "Invalid workflow artifact", detail);
}

function fail(detail: string, path: RepoRelativePath): never {
  throw artifactError("VALIDATION_FAILED", "Invalid canonical workflow artifact", detail, path);
}

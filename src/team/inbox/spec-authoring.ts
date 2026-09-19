import { createHash } from "node:crypto";
import type {
  JsonValue,
  Revision,
  RevisionExpectation,
} from "../contracts/shared.js";
import { isRevision } from "../contracts/shared.js";
import type {
  InboxDraft,
  InboxDraftInput,
  InboxProposal,
  PortableWikiOperationRequest,
  TeamInboxCreateChange,
  TeamInboxUpdateChange,
  TeamInboxEntityKind,
  TeamInboxKnowledgeCreateChange,
  TeamInboxKnowledgeUpdateChange,
  TeamInboxKnowledgeRef,
  TeamEvidenceRef,
  TeamInboxSpecChange,
  TeamInboxSpecCommand,
  TeamInboxSpecCreateChange,
  TeamInboxSpecDraftDetail,
  TeamInboxSpecDraftInput,
  TeamInboxSpecDraftSummary,
  TeamInboxSpecKind,
  TeamInboxSpecProposalDetail,
  TeamInboxSpecProposalSummary,
  TeamInboxSpecRef,
  TeamInboxSpecUpdateChange,
  TeamWorkflowAuthority,
} from "../contracts/workflow.js";
import {
  TEAM_INBOX_SPEC_KINDS,
  TEAM_INBOX_KNOWLEDGE_KINDS,
  TEAM_INBOX_SPEC_LIMITS,
} from "../contracts/workflow.js";
import type {
  WikiOperationActor,
  WikiOperationRequest,
  WikiRevisionExpectation,
} from "../contracts/wiki.js";
import { artifactError } from "../artifacts/errors.js";
import { normalizeInboxEvidence } from "../artifacts/workflow-codecs.js";
import { isEntityId } from "../../wiki/model/ids.js";

const PAYLOAD_KIND = "mex.team.inbox.spec-change.v1" as const;
const KNOWLEDGE_PAYLOAD_KIND = "mex.team.inbox.knowledge-change.v1" as const;
const INBOX_SIGNING_DOMAIN = "mex.team.inbox.spec.receipt.v1" as const;
const SPEC_KINDS = new Set<string>(TEAM_INBOX_SPEC_KINDS);
const KNOWLEDGE_KINDS = new Set<string>(TEAM_INBOX_KNOWLEDGE_KINDS);
const ENTITY_KINDS = new Set<string>([...SPEC_KINDS, ...KNOWLEDGE_KINDS]);
const CREATE_STATUSES = new Set<string>(["in_flight", "promoted"]);
const CHANGE_KINDS = new Set<string>(["spec.create", "spec.update", "knowledge.create", "knowledge.update"]);
const RELATION_TYPES = new Set<string>([
  "derived_from",
  "verified_by",
  "constrained_by",
  "refines",
]);

interface StoredSpecPayload {
  schemaVersion: 1;
  kind: typeof PAYLOAD_KIND | typeof KNOWLEDGE_PAYLOAD_KIND;
  change: JsonValue;
}

export interface ExactSpecEntityAttestation {
  id: string;
  entity: {
    ref: { id: string; kind: string; title?: string };
    version: { semanticRevision: number; contentHash: Revision };
  } | null;
}

export function isInboxCreateChange(change: TeamInboxSpecChange): change is TeamInboxCreateChange {
  return change.kind === "spec.create" || change.kind === "knowledge.create";
}

export function isInboxUpdateChange(change: TeamInboxSpecChange): change is TeamInboxUpdateChange {
  return change.kind === "spec.update" || change.kind === "knowledge.update";
}

function createdKnowledgePath(change: TeamInboxCreateChange, id: string): string {
  if (change.kind === "spec.create") return `specs/${id}.md`;
  return change.entityKind === "pattern" ? `patterns/${id}.md` : `context/${change.entityKind}-${id}.md`;
}

export function normalizeTeamInboxSpecCommand(
  value: unknown,
): TeamInboxSpecCommand {
  assertBoundedJson(value, {
    maxBytes: TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes,
    maxDepth: 32,
    maxNodes: 4_096,
  }, invalidRequest);
  if (!isPlainObject(value)) throw invalidRequest();
  exactKeys(value, ["operationId", "action", "expectedRevisions"], [], invalidRequest);
  if (
    typeof value.operationId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.operationId)
  ) {
    throw invalidRequest();
  }
  if (!isPlainObject(value.action) || typeof value.action.kind !== "string") {
    throw invalidRequest();
  }
  const action = normalizeAction(value.action);
  const expectedRevisions = normalizeCommandExpectations(value.expectedRevisions);
  if (action.kind === "inbox.draft.save") {
    if (action.draftId === undefined && expectedRevisions.length !== 0) {
      throw invalidSpec("A new local draft does not accept unrelated revision expectations.");
    }
    if (action.draftId !== undefined) {
      requireOneLocalExpectation(expectedRevisions, action.draftId);
    }
  } else if (action.kind === "inbox.draft.delete" || action.kind === "inbox.publish") {
    requireOneLocalExpectation(expectedRevisions, action.draftId);
  } else {
    requireOneProposalExpectation(expectedRevisions, action.proposalId);
  }
  return deepFreeze({
    operationId: value.operationId,
    action,
    expectedRevisions,
  });
}

export function inboxDraftInputFromProduct(
  input: TeamInboxSpecDraftInput,
  operationId: string,
): InboxDraftInput<JsonValue> {
  const normalized = normalizeDraftInput(input);
  return deepFreeze({
    request: storedRequest(normalized, operationId),
    rationale: normalized.rationale,
    evidence: normalized.evidence,
    targetRevisions: normalized.targetRevisions,
  });
}

export function productInputFromInboxDraft(
  input: InboxDraftInput<JsonValue>,
): TeamInboxSpecDraftInput | null {
  const change = tryDecodeStoredChange(input.request);
  if (change === null) return null;
  assertStoredRequestConsistency(input.request, input.targetRevisions, change);
  return deepFreeze(normalizeDraftInput({
    change,
    rationale: input.rationale,
    evidence: input.evidence,
    targetRevisions: input.targetRevisions,
  }));
}

export function productDraftProjection(
  draft: InboxDraft<JsonValue>,
): TeamInboxSpecDraftDetail | null {
  const input = productInputFromInboxDraft(draft);
  if (input === null) return null;
  return deepFreeze({
    ...draftSummary(draft.id, draft.revision, draft.updatedAt, input),
    input,
  });
}

export function productDraftSummary(
  draft: TeamInboxSpecDraftDetail,
): TeamInboxSpecDraftSummary {
  const { input: _input, ...summary } = draft;
  return deepFreeze(summary);
}

export function productProposalProjection(
  proposal: InboxProposal<JsonValue>,
): TeamInboxSpecProposalDetail | null {
  const change = tryDecodeStoredChange(proposal.request);
  if (change === null) return null;
  assertStoredRequestConsistency(
    proposal.request,
    proposal.targetRevisions,
    change,
  );
  const input = normalizeDraftInput({
    change,
    rationale: proposal.rationale,
    evidence: proposal.evidence,
    targetRevisions: proposal.targetRevisions,
  });
  const descriptor = describeChange(change);
  return deepFreeze({
    schemaVersion: 1,
    ref: proposal.ref,
    sourcePath: proposal.sourcePath,
    revision: proposal.revision,
    state: proposal.state,
    author: proposal.author,
    changeKind: change.kind,
    entityKind: descriptor.entityKind,
    title: descriptor.title,
    rationaleExcerpt: utf8Excerpt(proposal.rationale),
    ...(proposal.reviewer === undefined ? {} : { reviewer: proposal.reviewer }),
    ...(proposal.reviewedAt === undefined ? {} : { reviewedAt: proposal.reviewedAt }),
    change: input.change,
    rationale: input.rationale,
    evidence: input.evidence,
    targetRevisions: input.targetRevisions,
    ...(proposal.reviewRationale === undefined
      ? {}
      : { reviewRationale: proposal.reviewRationale }),
  });
}

export function productProposalSummary(
  proposal: TeamInboxSpecProposalDetail,
): TeamInboxSpecProposalSummary {
  const {
    change: _change,
    rationale: _rationale,
    evidence: _evidence,
    targetRevisions: _targetRevisions,
    reviewRationale: _reviewRationale,
    ...summary
  } = proposal;
  return deepFreeze(summary);
}

export function storedProposalIsTeamInboxSpec(
  proposal: InboxProposal<JsonValue>,
): boolean {
  return tryDecodeStoredChange(proposal.request) !== null;
}

export function storedDraftIsTeamInboxSpec(
  draft: InboxDraft<JsonValue>,
): boolean {
  return tryDecodeStoredChange(draft.request) !== null;
}

export function materializeSpecWikiRequest(
  proposal: InboxProposal<JsonValue>,
  authority: TeamWorkflowAuthority,
  pinnedSpecId?: string,
): WikiOperationRequest<JsonValue> {
  const change = requireStoredChange(proposal.request);
  assertStoredRequestConsistency(
    proposal.request,
    proposal.targetRevisions,
    change,
  );
  const actor = wikiActor(change.kind.startsWith("knowledge.") ? stableActor(authority.actor) : authority.actor);
  const common = {
    opId: proposal.request.operation.opId,
    actor,
    timestamp: authority.occurredAt,
    reason: proposal.rationale,
  } as const;
  // Legacy Spec materialization stays byte-for-byte stable for signed replay.
  const sources = change.kind.startsWith("knowledge.")
    ? proposalSources(proposal, authority)
    : undefined;
  if (isInboxCreateChange(change)) {
    if (pinnedSpecId === undefined || !isWikiMintedId(pinnedSpecId)) {
      throw invalidSpec("An Inbox create approval requires one service-minted mx ID.");
    }
    const file = createdKnowledgePath(change, pinnedSpecId);
    return deepFreeze({
      operation: {
        ...common,
        type: "create-entry" as const,
        payload: {
          file,
          insertAt: { at: "end-of-file" },
          type: change.entityKind,
          title: change.title,
          body: change.body,
          status: change.status,
          ...(sources === undefined ? {} : { sources }),
          ...(sources === undefined || proposal.author.kind === "unknown" ? {} : {
            provenance: {
              createdBy: cloneJson(wikiActor(stableActor(proposal.author))) as unknown as JsonValue,
              createdAt: authority.occurredAt,
            },
          }),
          ...(change.summary === undefined ? {} : { summary: change.summary }),
          ...(change.topics === undefined ? {} : { topics: change.topics }),
          ...(change.kind !== "spec.create" || change.relation === undefined
            ? {}
            : {
                relations: [{
                  type: change.relation.type,
                  target: change.relation.target.id,
                }],
              }),
        },
      },
      expectedRevisions: [
        ...wikiExpectations(proposal.targetRevisions),
        {
          target: {
            kind: "artifact" as const,
            path: `.mex/${file}`,
          },
          contentHash: null,
        },
      ],
    });
  }
  const target = expectationFor(proposal.targetRevisions, change.target.id);
  return deepFreeze({
    operation: {
      ...common,
      type: "update-entry" as const,
      entityId: change.target.id,
      baseRevision: target.semanticRevision,
      baseContentHash: target.revision,
      payload: sources === undefined ? change.patch : { ...change.patch, appendSources: sources },
    },
    expectedRevisions: wikiExpectations(proposal.targetRevisions),
  });
}

function proposalSources(proposal: InboxProposal<JsonValue>, authority: TeamWorkflowAuthority): JsonValue[] {
  const capturedAt = authority.occurredAt;
  return [
    {
      type: "document",
      ref: proposal.sourcePath,
      note: proposal.rationale,
      capturedAt,
      metadata: {
        proposalId: proposal.ref.id,
        author: stableActor(proposal.author) as unknown as JsonValue,
        approvedBy: stableActor(authority.actor) as unknown as JsonValue,
      },
    },
    ...proposal.evidence.map((evidence: TeamEvidenceRef): JsonValue => {
      const source = evidence.kind === "entity"
        ? { type: "document", ref: evidence.entity.id }
        : evidence.kind === "code"
          ? { type: evidence.code.kind === "symbol" ? "symbol" : "file", ref: evidence.code.kind === "symbol" ? evidence.code.symbolId : evidence.code.path }
          : evidence.kind === "commit"
            ? { type: "commit", commit: evidence.hash }
            : evidence.kind === "file"
              ? { type: "document", ref: evidence.path }
              : evidence.kind === "external"
                ? { type: "url", ref: evidence.uri, ...(evidence.label === undefined ? {} : { note: evidence.label }) }
                : { type: "manual", note: evidence.note };
      return cloneJson({
        ...source,
        capturedAt,
        metadata: { evidence: cloneJson(evidence) as unknown as JsonValue },
      }) as unknown as JsonValue;
    }),
  ];
}

/** Receipt decoding sorts keys; explicit field order keeps reviewed Markdown identical. */
function stableActor(actor: TeamWorkflowAuthority["actor"]): TeamWorkflowAuthority["actor"] {
  if (actor.kind === "member") return {
    kind: "member",
    memberId: actor.memberId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  };
  if (actor.kind === "git") return { kind: "git", name: actor.name, email: actor.email };
  return { kind: "unknown" };
}

export function storedSpecChange(
  proposal: InboxProposal<JsonValue>,
): TeamInboxSpecChange | null {
  const change = tryDecodeStoredChange(proposal.request);
  if (change !== null) {
    assertStoredRequestConsistency(
      proposal.request,
      proposal.targetRevisions,
      change,
    );
  }
  return change;
}

export function specDependencyIds(change: TeamInboxSpecChange): readonly string[] {
  const ids = isInboxUpdateChange(change)
    ? [change.target.id]
    : [
        ...(change.topics ?? []),
        ...(change.kind !== "spec.create" || change.relation === undefined ? [] : [change.relation.target.id]),
      ];
  return [...new Set(ids)].sort(compareCodePoints);
}

export function assertExactSpecAttestations(
  change: TeamInboxSpecChange,
  expectations: readonly RevisionExpectation[],
  attestations: readonly ExactSpecEntityAttestation[],
): void {
  const expectedIds = specDependencyIds(change);
  if (
    attestations.length !== expectedIds.length
    || attestations.some((item, index) => item.id !== expectedIds[index])
  ) {
    throw revisionConflict("The fresh Wiki attestation set changed during review.");
  }
  for (const attestation of attestations) {
    const expected = expectationFor(expectations, attestation.id);
    if (attestation.entity === null) {
      throw revisionConflict(`Wiki dependency ${attestation.id} no longer exists.`);
    }
    if (
      attestation.entity.version.contentHash !== expected.revision
      || attestation.entity.version.semanticRevision !== expected.semanticRevision
    ) {
      throw revisionConflict(`Wiki dependency ${attestation.id} changed after publication.`);
    }
  }
  assertAttestedKinds(change, attestations);
}

export function specAttestationsHaveDrifted(
  change: TeamInboxSpecChange,
  expectations: readonly RevisionExpectation[],
  attestations: readonly ExactSpecEntityAttestation[],
): boolean {
  try {
    assertExactSpecAttestations(change, expectations, attestations);
    return false;
  } catch (error) {
    if (isExpectedDrift(error)) return true;
    throw error;
  }
}

export function inboxSigningPayload(receipt: {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly { purpose: string; id: string }[];
  requestRevision: Revision;
  presentationRevision: Revision;
}): string {
  return boundedCanonicalJson({
    domain: INBOX_SIGNING_DOMAIN,
    schemaVersion: receipt.schemaVersion,
    authority: receipt.authority,
    purposeIds: receipt.purposeIds,
    requestRevision: receipt.requestRevision,
    presentationRevision: receipt.presentationRevision,
  }, {
    maxBytes: TEAM_INBOX_SPEC_LIMITS.maxReceiptBytes,
    maxDepth: TEAM_INBOX_SPEC_LIMITS.maxReceiptDepth,
    maxNodes: TEAM_INBOX_SPEC_LIMITS.maxReceiptNodes,
  }, invalidRequest);
}

export function boundedInboxJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes,
    maxDepth: 32,
    maxNodes: 4_096,
  }, invalidRequest);
}

export function boundedInboxReceiptJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_INBOX_SPEC_LIMITS.maxReceiptBytes,
    maxDepth: TEAM_INBOX_SPEC_LIMITS.maxReceiptDepth,
    maxNodes: TEAM_INBOX_SPEC_LIMITS.maxReceiptNodes,
  }, invalidRequest);
}

export function utf8Excerpt(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= TEAM_INBOX_SPEC_LIMITS.maxRationaleExcerptBytes) {
    return value;
  }
  let end = TEAM_INBOX_SPEC_LIMITS.maxRationaleExcerptBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function normalizeAction(
  value: Readonly<Record<string, unknown>>,
): TeamInboxSpecCommand["action"] {
  switch (value.kind) {
    case "inbox.draft.save": {
      exactKeys(value, ["kind", "draft"], ["draftId"], invalidRequest);
      const draft = normalizeDraftInput(value.draft);
      if (value.draftId !== undefined) assertLocalId(value.draftId);
      return {
        kind: "inbox.draft.save",
        ...(value.draftId === undefined ? {} : { draftId: value.draftId }),
        draft,
      };
    }
    case "inbox.draft.delete":
    case "inbox.publish": {
      exactKeys(value, ["kind", "draftId"], [], invalidRequest);
      assertLocalId(value.draftId);
      return { kind: value.kind, draftId: value.draftId };
    }
    case "inbox.approve": {
      exactKeys(value, ["kind", "proposalId"], [], invalidRequest);
      assertProposalId(value.proposalId);
      return { kind: value.kind, proposalId: value.proposalId };
    }
    case "inbox.reject":
    case "inbox.mark-stale": {
      exactKeys(value, ["kind", "proposalId", "rationale"], [], invalidRequest);
      assertProposalId(value.proposalId);
      const rationale = boundedText(
        value.rationale,
        "review rationale",
        TEAM_INBOX_SPEC_LIMITS.maxRationaleBytes,
        true,
      );
      return { kind: value.kind, proposalId: value.proposalId, rationale };
    }
    case "inbox.withdraw": {
      exactKeys(value, ["kind", "proposalId"], ["rationale"], invalidRequest);
      assertProposalId(value.proposalId);
      const rationale = value.rationale === undefined
        ? undefined
        : boundedText(
            value.rationale,
            "withdraw rationale",
            TEAM_INBOX_SPEC_LIMITS.maxRationaleBytes,
            true,
          );
      return {
        kind: value.kind,
        proposalId: value.proposalId,
        ...(rationale === undefined ? {} : { rationale }),
      };
    }
    case "inbox.repair": {
      exactKeys(value, ["kind", "proposalId", "replacement"], [], invalidRequest);
      assertProposalId(value.proposalId);
      return {
        kind: value.kind,
        proposalId: value.proposalId,
        replacement: normalizeDraftInput(value.replacement),
      };
    }
    default:
      throw invalidSpec("Only the closed Inbox/Spec lifecycle is supported.");
  }
}

function normalizeDraftInput(value: unknown): TeamInboxSpecDraftInput {
  assertNoHiddenOperations(value);
  assertBoundedJson(value, {
    maxBytes: TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes,
    maxDepth: TEAM_INBOX_SPEC_LIMITS.maxPayloadDepth,
    maxNodes: TEAM_INBOX_SPEC_LIMITS.maxPayloadNodes,
  }, invalidRequest);
  if (!isPlainObject(value)) throw invalidRequest();
  exactKeys(
    value,
    ["change", "rationale", "evidence", "targetRevisions"],
    [],
    invalidRequest,
  );
  assertBoundedJson(value.change, {
    maxBytes: TEAM_INBOX_SPEC_LIMITS.maxPortableRequestBytes,
    maxDepth: TEAM_INBOX_SPEC_LIMITS.maxPayloadDepth,
    maxNodes: TEAM_INBOX_SPEC_LIMITS.maxPayloadNodes,
  }, invalidRequest);
  const change = normalizeChange(value.change);
  const rationale = boundedText(
    value.rationale,
    "proposal rationale",
    TEAM_INBOX_SPEC_LIMITS.maxRationaleBytes,
    true,
  );
  let evidence: TeamInboxSpecDraftInput["evidence"];
  try {
    evidence = normalizeInboxEvidence(value.evidence);
  } catch {
    throw invalidRequest();
  }
  const targetRevisions = normalizeEntityExpectations(value.targetRevisions);
  assertDependencyCoverage(change, targetRevisions);
  return deepFreeze({ change, rationale, evidence, targetRevisions });
}

function normalizeChange(value: unknown): TeamInboxSpecChange {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw invalidRequest();
  }
  if (value.kind === "spec.create") return normalizeCreate(value);
  if (value.kind === "spec.update") return normalizeUpdate(value);
  if (value.kind === "knowledge.create") return normalizeKnowledgeCreate(value);
  if (value.kind === "knowledge.update") return normalizeKnowledgeUpdate(value);
  if (CHANGE_KINDS.has(value.kind)) throw invalidRequest();
  throw invalidSpec("Only knowledge.create, knowledge.update, spec.create, and spec.update are supported.");
}

function normalizeKnowledgeCreate(
  value: Readonly<Record<string, unknown>>,
): TeamInboxKnowledgeCreateChange {
  exactKeys(value, ["kind", "entityKind", "title", "body", "status"], ["summary", "topics"], invalidRequest);
  if (typeof value.entityKind !== "string" || !KNOWLEDGE_KINDS.has(value.entityKind)) {
    throw invalidSpec("Knowledge create requires an architecture, component, convention, decision, pattern, or guide.");
  }
  if (typeof value.status !== "string" || !CREATE_STATUSES.has(value.status)) {
    throw invalidSpec("Knowledge create status must be in_flight or promoted.");
  }
  return deepFreeze({
    kind: "knowledge.create",
    entityKind: value.entityKind,
    title: boundedText(value.title, "Knowledge title", TEAM_INBOX_SPEC_LIMITS.maxTitleBytes, true),
    body: boundedText(value.body, "Knowledge body", TEAM_INBOX_SPEC_LIMITS.maxStringBytes, true),
    status: value.status,
    ...(value.summary === undefined ? {} : {
      summary: boundedText(value.summary, "Knowledge summary", TEAM_INBOX_SPEC_LIMITS.maxSummaryBytes, false),
    }),
    ...(value.topics === undefined ? {} : { topics: normalizeTopics(value.topics) }),
  } as TeamInboxKnowledgeCreateChange);
}

function normalizeKnowledgeUpdate(
  value: Readonly<Record<string, unknown>>,
): TeamInboxKnowledgeUpdateChange {
  exactKeys(value, ["kind", "target", "patch"], [], invalidRequest);
  if (!isPlainObject(value.target)) throw invalidRequest();
  exactKeys(value.target, ["id", "kind"], ["title"], invalidRequest);
  if (!isWikiMintedId(value.target.id)
    || typeof value.target.kind !== "string"
    || !KNOWLEDGE_KINDS.has(value.target.kind)) {
    throw invalidSpec("Knowledge update requires one canonical mx ID and an eligible knowledge kind.");
  }
  const target = {
    id: value.target.id,
    kind: value.target.kind,
    ...(value.target.title === undefined ? {} : {
      title: boundedText(value.target.title, "Knowledge reference title", TEAM_INBOX_SPEC_LIMITS.maxTitleBytes, true),
    }),
  } as TeamInboxKnowledgeRef;
  return deepFreeze({ kind: "knowledge.update", target, patch: normalizeTextPatch(value.patch) });
}

function normalizeCreate(
  value: Readonly<Record<string, unknown>>,
): TeamInboxSpecCreateChange {
  if (Object.hasOwn(value, "adopt")) {
    throw invalidSpec("Spec create never adopts existing prose.");
  }
  if (Object.hasOwn(value, "relations")) {
    throw invalidSpec("Spec create accepts at most one typed relation.");
  }
  exactKeys(value, ["kind", "entityKind", "title", "body", "status"], [
    "summary",
    "topics",
    "relation",
  ], invalidRequest);
  if (typeof value.entityKind !== "string" || !SPEC_KINDS.has(value.entityKind)) {
    throw invalidSpec("Spec create kind is not in the four-kind product family.");
  }
  if (typeof value.status !== "string" || !CREATE_STATUSES.has(value.status)) {
    throw invalidSpec("Spec create status must be in_flight or promoted.");
  }
  const title = boundedText(
    value.title,
    "Spec title",
    TEAM_INBOX_SPEC_LIMITS.maxTitleBytes,
    true,
  );
  const body = boundedText(
    value.body,
    "Spec body",
    TEAM_INBOX_SPEC_LIMITS.maxStringBytes,
    true,
  );
  const summary = value.summary === undefined
    ? undefined
    : boundedText(
        value.summary,
        "Spec summary",
        TEAM_INBOX_SPEC_LIMITS.maxSummaryBytes,
        false,
      );
  const topics = value.topics === undefined
    ? undefined
    : normalizeTopics(value.topics);
  const relation = value.relation === undefined
    ? undefined
    : normalizeRelation(value.entityKind as TeamInboxSpecKind, value.relation);
  return deepFreeze({
    kind: "spec.create",
    entityKind: value.entityKind,
    title,
    body,
    status: value.status,
    ...(summary === undefined ? {} : { summary }),
    ...(topics === undefined ? {} : { topics }),
    ...(relation === undefined ? {} : { relation }),
  } as TeamInboxSpecCreateChange);
}

function normalizeUpdate(
  value: Readonly<Record<string, unknown>>,
): TeamInboxSpecUpdateChange {
  exactKeys(value, ["kind", "target", "patch"], [], invalidRequest);
  const target = normalizeSpecRef(value.target);
  return deepFreeze({ kind: "spec.update", target, patch: normalizeTextPatch(value.patch) });
}

function normalizeTextPatch(value: unknown): TeamInboxSpecUpdateChange["patch"] {
  if (!isPlainObject(value)) throw invalidRequest();
  const patchKeys = Object.keys(value);
  if (
    patchKeys.length === 0
    || patchKeys.some((key) => key !== "title" && key !== "summary" && key !== "body")
  ) {
    throw invalidSpec("Inbox update may change only a nonempty title/summary/body patch.");
  }
  const patch: Record<string, string> = {};
  if (Object.hasOwn(value, "title")) {
    patch.title = boundedText(
      value.title,
      "Spec title",
      TEAM_INBOX_SPEC_LIMITS.maxTitleBytes,
      true,
    );
  }
  if (Object.hasOwn(value, "summary")) {
    patch.summary = boundedText(
      value.summary,
      "Spec summary",
      TEAM_INBOX_SPEC_LIMITS.maxSummaryBytes,
      false,
    );
  }
  if (Object.hasOwn(value, "body")) {
    patch.body = boundedText(
      value.body,
      "Spec body",
      TEAM_INBOX_SPEC_LIMITS.maxStringBytes,
      true,
    );
  }
  return deepFreeze(patch as TeamInboxSpecUpdateChange["patch"]);
}

function normalizeRelation(
  sourceKind: TeamInboxSpecKind,
  value: unknown,
): NonNullable<TeamInboxSpecCreateChange["relation"]> {
  if (!isPlainObject(value)) throw invalidRequest();
  exactKeys(value, ["type", "target"], [], invalidRequest);
  if (typeof value.type !== "string" || !RELATION_TYPES.has(value.type)) {
    throw invalidSpec("Unsupported create-time Spec relation.");
  }
  const target = normalizeSpecRef(value.target);
  const accepted = value.type === "derived_from"
    ? sourceKind === "requirement" && target.kind === "spec"
    : value.type === "verified_by"
      ? sourceKind === "acceptance_criterion"
        && (target.kind === "spec" || target.kind === "requirement")
      : value.type === "constrained_by"
        ? target.kind === "constraint"
        : sourceKind === "requirement" && target.kind === "requirement";
  if (!accepted) {
    throw invalidSpec("The create-time relation direction or endpoint kind is invalid.");
  }
  return deepFreeze({ type: value.type, target } as NonNullable<TeamInboxSpecCreateChange["relation"]>);
}

function normalizeSpecRef(value: unknown): TeamInboxSpecRef {
  if (!isPlainObject(value)) throw invalidRequest();
  exactKeys(value, ["id", "kind"], ["title"], invalidRequest);
  if (!isWikiMintedId(value.id)) {
    throw invalidSpec("Spec references require one canonical mx ID.");
  }
  if (typeof value.kind !== "string" || !SPEC_KINDS.has(value.kind)) {
    throw invalidSpec("Spec reference kind is not in the four-kind product family.");
  }
  const title = value.title === undefined
    ? undefined
    : boundedText(
        value.title,
        "Spec reference title",
        TEAM_INBOX_SPEC_LIMITS.maxTitleBytes,
        true,
      );
  return deepFreeze({
    id: value.id,
    kind: value.kind,
    ...(title === undefined ? {} : { title }),
  } as TeamInboxSpecRef);
}

function normalizeTopics(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > TEAM_INBOX_SPEC_LIMITS.maxTopics) {
    throw invalidSpec("Spec topics exceed the bounded typed collection.");
  }
  const topics = value.map((item) => {
    if (!isWikiMintedId(item)) {
      throw invalidSpec("Spec topic references require canonical mx IDs.");
    }
    return item;
  });
  if (new Set(topics).size !== topics.length) {
    throw invalidSpec("Spec topic references must be unique.");
  }
  return deepFreeze([...topics]);
}

function normalizeEntityExpectations(value: unknown): readonly RevisionExpectation[] {
  if (!Array.isArray(value) || value.length > TEAM_INBOX_SPEC_LIMITS.maxExpectations) {
    throw invalidRequest();
  }
  const seen = new Set<string>();
  const expectations = value.map((item) => {
    if (!isPlainObject(item)) throw invalidRequest();
    exactKeys(item, ["target", "revision", "semanticRevision"], [], invalidRequest);
    if (!isPlainObject(item.target)) throw invalidRequest();
    exactKeys(item.target, ["kind", "id"], [], invalidRequest);
    if (item.target.kind !== "entity" || !isWikiMintedId(item.target.id)) {
      throw invalidRequest();
    }
    if (
      typeof item.revision !== "string"
      || !isRevision(item.revision)
      || !Number.isSafeInteger(item.semanticRevision)
      || (item.semanticRevision as number) < 1
    ) {
      throw invalidRequest();
    }
    if (seen.has(item.target.id)) {
      throw invalidSpec("Spec dependency expectations must be unique.");
    }
    seen.add(item.target.id);
    return {
      target: { kind: "entity" as const, id: item.target.id },
      revision: item.revision,
      semanticRevision: item.semanticRevision as number,
    };
  });
  return deepFreeze(expectations);
}

function normalizeCommandExpectations(value: unknown): readonly RevisionExpectation[] {
  if (!Array.isArray(value) || value.length > TEAM_INBOX_SPEC_LIMITS.maxExpectations) {
    throw invalidRequest();
  }
  return deepFreeze(value.map((item) => {
    if (!isPlainObject(item)) throw invalidRequest();
    exactKeys(item, ["target", "revision"], ["semanticRevision"], invalidRequest);
    if (!isPlainObject(item.target) || typeof item.target.kind !== "string") {
      throw invalidRequest();
    }
    if (item.revision !== null && (typeof item.revision !== "string" || !isRevision(item.revision))) {
      throw invalidRequest();
    }
    if (item.target.kind === "local") {
      exactKeys(item.target, ["kind", "namespace", "id"], [], invalidRequest);
      if (
        item.target.namespace !== "inbox-draft"
        || Object.hasOwn(item, "semanticRevision")
      ) throw invalidRequest();
      assertLocalId(item.target.id);
      return cloneJson(item) as unknown as RevisionExpectation;
    }
    if (item.target.kind === "artifact") {
      exactKeys(item.target, ["kind", "path"], [], invalidRequest);
      if (
        typeof item.target.path !== "string"
        || !item.target.path.startsWith(".mex/inbox/proposal_")
        || Object.hasOwn(item, "semanticRevision")
      ) throw invalidRequest();
      return cloneJson(item) as unknown as RevisionExpectation;
    }
    throw invalidRequest();
  }));
}

function assertDependencyCoverage(
  change: TeamInboxSpecChange,
  expectations: readonly RevisionExpectation[],
): void {
  const expected = specDependencyIds(change);
  const actual = expectations.map((item) => (
    item.target.kind === "entity" ? item.target.id : ""
  )).sort(compareCodePoints);
  if (
    expected.length !== actual.length
    || expected.some((id, index) => id !== actual[index])
  ) {
    throw invalidSpec("Exact revision expectations must cover every Spec dependency once.");
  }
}

function storedRequest(
  input: TeamInboxSpecDraftInput,
  operationId: string,
): PortableWikiOperationRequest<JsonValue> {
  const change = input.change;
  const target = isInboxUpdateChange(change)
    ? expectationFor(input.targetRevisions, change.target.id)
    : null;
  const operation = {
    opId: internalWikiOperationId(operationId),
    type: isInboxCreateChange(change) ? "create-entry" as const : "update-entry" as const,
    ...(isInboxUpdateChange(change) ? { entityId: change.target.id } : {}),
    ...(target === null
      ? {}
      : {
          baseRevision: target.semanticRevision,
          baseContentHash: target.revision,
        }),
    payload: cloneJson({
      schemaVersion: 1,
      kind: change.kind.startsWith("knowledge.") ? KNOWLEDGE_PAYLOAD_KIND : PAYLOAD_KIND,
      change: storedChangeValue(change),
    } satisfies StoredSpecPayload) as unknown as JsonValue,
  };
  return deepFreeze({
    operation,
    expectedRevisions: wikiExpectations(input.targetRevisions),
  });
}

function tryDecodeStoredChange(
  request: PortableWikiOperationRequest<JsonValue>,
): TeamInboxSpecChange | null {
  const payload = request.operation.payload;
  if (
    !isPlainObject(payload)
    || (payload.kind !== PAYLOAD_KIND && payload.kind !== KNOWLEDGE_PAYLOAD_KIND)
    || payload.schemaVersion !== 1
  ) return null;
  exactKeys(payload, ["schemaVersion", "kind", "change"], [], invalidStored);
  const change = normalizeStoredChange(payload.change);
  if (
    (payload.kind === KNOWLEDGE_PAYLOAD_KIND) !== change.kind.startsWith("knowledge.")
    || request.operation.type !== (isInboxCreateChange(change) ? "create-entry" : "update-entry")
    || (isInboxCreateChange(change) && request.operation.entityId !== undefined)
    || (isInboxUpdateChange(change) && request.operation.entityId !== change.target.id)
  ) {
    throw invalidStored();
  }
  return change;
}

function assertStoredRequestConsistency(
  request: PortableWikiOperationRequest<JsonValue>,
  targetRevisions: readonly RevisionExpectation[],
  change: TeamInboxSpecChange,
): void {
  const exactExpectations = wikiExpectations(targetRevisions);
  if (
    boundedCanonicalJson(request.expectedRevisions, {
      maxBytes: TEAM_INBOX_SPEC_LIMITS.maxPortableRequestBytes,
      maxDepth: TEAM_INBOX_SPEC_LIMITS.maxPayloadDepth,
      maxNodes: TEAM_INBOX_SPEC_LIMITS.maxPayloadNodes,
    }, invalidStored)
      !== boundedCanonicalJson(exactExpectations, {
        maxBytes: TEAM_INBOX_SPEC_LIMITS.maxPortableRequestBytes,
        maxDepth: TEAM_INBOX_SPEC_LIMITS.maxPayloadDepth,
        maxNodes: TEAM_INBOX_SPEC_LIMITS.maxPayloadNodes,
      }, invalidStored)
  ) {
    throw invalidStored();
  }
  const operation = request.operation;
  if (isInboxCreateChange(change)) {
    if (
      operation.type !== "create-entry"
      || operation.entityId !== undefined
      || operation.baseRevision !== undefined
      || operation.baseContentHash !== undefined
    ) throw invalidStored();
    return;
  }
  const target = expectationFor(targetRevisions, change.target.id);
  if (
    operation.type !== "update-entry"
    || operation.entityId !== change.target.id
    || operation.baseRevision !== target.semanticRevision
    || operation.baseContentHash !== target.revision
  ) throw invalidStored();
}

function storedChangeValue(change: TeamInboxSpecChange): JsonValue {
  if (isInboxCreateChange(change)) {
    return cloneJson(change) as unknown as JsonValue;
  }
  return cloneJson({
    kind: change.kind,
    target: change.target,
    fields: change.patch,
  }) as unknown as JsonValue;
}

function normalizeStoredChange(value: unknown): TeamInboxSpecChange {
  if (isPlainObject(value) && (value.kind === "spec.update" || value.kind === "knowledge.update")) {
    exactKeys(value, ["kind", "target", "fields"], [], invalidStored);
    return normalizeChange({
      kind: value.kind,
      target: value.target,
      patch: value.fields,
    });
  }
  return normalizeChange(value);
}

function requireStoredChange(
  request: PortableWikiOperationRequest<JsonValue>,
): TeamInboxSpecChange {
  const change = tryDecodeStoredChange(request);
  if (change === null) throw invalidStored();
  return change;
}

function wikiExpectations(
  expectations: readonly RevisionExpectation[],
): readonly WikiRevisionExpectation[] {
  return expectations.map((item) => {
    if (
      item.target.kind !== "entity"
      || item.revision === null
      || item.semanticRevision === undefined
      || item.semanticRevision === null
    ) throw invalidStored();
    return {
      target: { kind: "entity" as const, id: item.target.id },
      version: {
        semanticRevision: item.semanticRevision,
        contentHash: item.revision,
      },
    };
  });
}

function expectationFor(
  expectations: readonly RevisionExpectation[],
  id: string,
): RevisionExpectation & { revision: Revision; semanticRevision: number } {
  const matches = expectations.filter((item) => (
    item.target.kind === "entity" && item.target.id === id
  ));
  const match = matches[0];
  if (
    matches.length !== 1
    || match === undefined
    || match.revision === null
    || match.semanticRevision === null
    || match.semanticRevision === undefined
  ) throw invalidSpec(`Wiki dependency ${id} lacks one exact expectation.`);
  return match as RevisionExpectation & { revision: Revision; semanticRevision: number };
}

function assertAttestedKinds(
  change: TeamInboxSpecChange,
  attestations: readonly ExactSpecEntityAttestation[],
): void {
  const byId = new Map(attestations.map((item) => [item.id, item.entity]));
  if (isInboxUpdateChange(change)) {
    const actual = byId.get(change.target.id);
    if (
      actual === null
      || actual === undefined
      || actual.ref.kind !== change.target.kind
      || (change.target.title !== undefined
        && actual.ref.title !== change.target.title)
    ) {
      throw revisionConflict("The update target is no longer the reviewed Inbox entity kind.");
    }
    return;
  }
  for (const topicId of change.topics ?? []) {
    const actual = byId.get(topicId);
    if (
      actual === null
      || actual === undefined
      || actual.ref.kind !== "topic"
    ) {
      throw revisionConflict("A reviewed Spec topic endpoint is no longer a topic.");
    }
  }
  if (change.kind === "spec.create" && change.relation !== undefined) {
    const actual = byId.get(change.relation.target.id);
    if (
      actual === null
      || actual === undefined
      || actual.ref.kind !== change.relation.target.kind
      || (change.relation.target.title !== undefined
        && actual.ref.title !== change.relation.target.title)
    ) {
      throw revisionConflict("The create relation endpoint kind changed after review.");
    }
  }
}

function draftSummary(
  id: string,
  revision: Revision,
  updatedAt: string,
  input: TeamInboxSpecDraftInput,
): TeamInboxSpecDraftSummary {
  const descriptor = describeChange(input.change);
  return {
    id,
    revision,
    updatedAt,
    changeKind: input.change.kind,
    entityKind: descriptor.entityKind,
    title: descriptor.title,
    rationaleExcerpt: utf8Excerpt(input.rationale),
  };
}

function describeChange(change: TeamInboxSpecChange): {
  entityKind: TeamInboxEntityKind;
  title: string;
} {
  return isInboxCreateChange(change)
    ? { entityKind: change.entityKind, title: change.title }
    : {
        entityKind: change.target.kind,
        title: change.patch.title ?? change.target.title ?? change.target.id,
      };
}

function requireOneLocalExpectation(
  expectations: readonly RevisionExpectation[],
  draftId: string,
): void {
  if (
    expectations.length !== 1
    || expectations[0]?.target.kind !== "local"
    || expectations[0].target.namespace !== "inbox-draft"
    || expectations[0].target.id !== draftId
    || expectations[0].revision === null
  ) throw invalidSpec("The action requires the exact local draft revision.");
}

function requireOneProposalExpectation(
  expectations: readonly RevisionExpectation[],
  proposalId: string,
): void {
  if (
    expectations.length !== 1
    || expectations[0]?.target.kind !== "artifact"
    || expectations[0].target.path !== `.mex/inbox/${proposalId}.md`
    || expectations[0].revision === null
  ) throw invalidSpec("The action requires the exact proposal artifact revision.");
}

function normalizeSpecPageKinds(
  values: unknown,
  accepted: ReadonlySet<string>,
  label: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.some((value) => typeof value !== "string" || !accepted.has(value))
    || new Set(values).size !== values.length
  ) throw invalidSpec(`Invalid ${label} filter.`);
  return [...values].sort(compareCodePoints);
}

export function normalizeInboxListFilter(value: unknown, proposals: boolean): {
  cursor?: string;
  limit: number;
  changeKinds?: readonly TeamInboxSpecChange["kind"][];
  entityKinds?: readonly TeamInboxEntityKind[];
  states?: readonly ("pending" | "approved" | "rejected" | "withdrawn" | "stale")[];
} {
  if (value === undefined) value = {};
  if (!isPlainObject(value)) throw invalidRequest();
  exactKeys(
    value,
    [],
    proposals
      ? ["cursor", "limit", "changeKinds", "entityKinds", "states"]
      : ["cursor", "limit", "changeKinds", "entityKinds"],
    invalidRequest,
  );
  if (
    value.cursor !== undefined
    && (typeof value.cursor !== "string"
      || Buffer.byteLength(value.cursor, "utf8") > TEAM_INBOX_SPEC_LIMITS.maxCursorBytes)
  ) throw invalidRequest();
  const limit = value.limit === undefined
    ? TEAM_INBOX_SPEC_LIMITS.defaultPageSize
    : value.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > TEAM_INBOX_SPEC_LIMITS.maxPageSize) {
    throw invalidRequest();
  }
  const changeKinds = normalizeSpecPageKinds(value.changeKinds, CHANGE_KINDS, "change kind") as readonly TeamInboxSpecChange["kind"][] | undefined;
  const entityKinds = normalizeSpecPageKinds(value.entityKinds, ENTITY_KINDS, "entity kind") as readonly TeamInboxEntityKind[] | undefined;
  const states = proposals
    ? normalizeSpecPageKinds(
        value.states,
        new Set(["pending", "approved", "rejected", "withdrawn", "stale"]),
        "proposal state",
      ) as readonly ("pending" | "approved" | "rejected" | "withdrawn" | "stale")[] | undefined
    : undefined;
  return {
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    limit: limit as number,
    ...(changeKinds === undefined ? {} : { changeKinds }),
    ...(entityKinds === undefined ? {} : { entityKinds }),
    ...(states === undefined ? {} : { states }),
  };
}

export function encodeInboxCursor(value: unknown): string {
  return Buffer.from(boundedCanonicalJson(value, {
    maxBytes: 3 * 1024,
    maxDepth: 4,
    maxNodes: 32,
  }, invalidRequest), "utf8").toString("base64url");
}

export function decodeInboxCursor(value: string | undefined): {
  v: 1;
  innerCursor: string;
  corpusRevision: Revision;
  filterRevision: Revision;
} | null {
  if (value === undefined) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidRequest();
  }
  if (!isPlainObject(decoded)) throw invalidRequest();
  exactKeys(decoded, ["v", "innerCursor", "corpusRevision", "filterRevision"], [], invalidRequest);
  if (
    decoded.v !== 1
    || typeof decoded.innerCursor !== "string"
    || typeof decoded.corpusRevision !== "string"
    || !isRevision(decoded.corpusRevision)
    || typeof decoded.filterRevision !== "string"
    || !isRevision(decoded.filterRevision)
  ) throw invalidRequest();
  return decoded as unknown as {
    v: 1;
    innerCursor: string;
    corpusRevision: Revision;
    filterRevision: Revision;
  };
}

export function hashInboxValue(value: unknown): Revision {
  return createHash("sha256").update(boundedInboxJson(value), "utf8").digest("hex");
}

function internalWikiOperationId(operationId: string): string {
  return `inbox_spec_${createHash("sha256").update(operationId, "utf8").digest("hex")}`;
}

function wikiActor(actor: TeamWorkflowAuthority["actor"]): WikiOperationActor {
  if (actor.kind === "member") return { kind: "human", id: actor.memberId };
  if (actor.kind === "git") {
    return {
      kind: "human",
      id: `git:${createHash("sha256").update(JSON.stringify(actor), "utf8").digest("hex").slice(0, 32)}`,
    };
  }
  return { kind: "system", id: "mex:unknown-actor" };
}

function assertNoHiddenOperations(value: unknown): void {
  const active = new Set<object>();
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    if (active.has(current)) throw invalidRequest();
    active.add(current);
    if (Array.isArray(current)) {
      current.forEach(visit);
    } else {
      if (!isPlainObject(current)) throw invalidRequest();
      for (const [key, child] of Object.entries(current)) {
        if (key === "operations") throw invalidRequest();
        visit(child);
      }
    }
    active.delete(current);
  };
  visit(value);
}

function assertBoundedJson(
  value: unknown,
  limits: { maxBytes: number; maxDepth: number; maxNodes: number },
  invalid: () => Error,
): void {
  void boundedCanonicalJson(value, limits, invalid);
}

function boundedCanonicalJson(
  value: unknown,
  limits: { maxBytes: number; maxDepth: number; maxNodes: number },
  invalid: () => Error,
): string {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) throw invalid();
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (!isCanonicalInboxString(current)) throw invalid();
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw invalid();
      return current;
    }
    if (typeof current !== "object" || active.has(current)) throw invalid();
    active.add(current);
    let normalized: unknown;
    if (Array.isArray(current)) {
      normalized = current.map((item) => visit(item, depth + 1));
    } else {
      if (!isPlainObject(current)) throw invalid();
      // A normal object would invoke the legacy `__proto__` setter for an
      // own JSON key with that name, silently dropping it from the canonical
      // bytes that are bounded and signed.
      const object = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(current).sort(compareCodePoints)) {
        if (!isCanonicalInboxString(key)) throw invalid();
        if (current[key] === undefined) throw invalid();
        object[key] = visit(current[key], depth + 1);
      }
      normalized = object;
    }
    active.delete(current);
    return normalized;
  };
  const serialized = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(serialized, "utf8") > limits.maxBytes) throw invalid();
  return serialized;
}

function boundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  required: boolean,
): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maxBytes
    || !isCanonicalInboxString(value)
    || (required && value.trim().length === 0)
  ) throw invalidRequest();
  return value;
}

function isCanonicalInboxString(value: string): boolean {
  return value.normalize("NFC") === value
    && !hasLoneSurrogate(value)
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
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

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  invalid: () => Error,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) throw invalid();
}

function assertLocalId(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256
  ) throw invalidRequest();
}

function assertProposalId(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || !/^proposal_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)
  ) throw invalidRequest();
}

function isWikiMintedId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("mx_") && isEntityId(value);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidRequest(): ReturnType<typeof artifactError> {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid Inbox/Spec request",
    "The Inbox/Spec request is malformed or exceeds its bounded product schema.",
  );
}

function invalidSpec(detail: string): ReturnType<typeof artifactError> {
  return artifactError("VALIDATION_FAILED", "Invalid Inbox/Spec change", detail);
}

function invalidStored(): ReturnType<typeof artifactError> {
  return artifactError(
    "INDEX_CORRUPT",
    "Invalid Inbox/Spec proposal",
    "The canonical Inbox proposal does not match the closed Spec authoring schema.",
  );
}

function revisionConflict(detail: string): ReturnType<typeof artifactError> {
  return artifactError("REVISION_CONFLICT", "Inbox/Spec dependency changed", detail);
}

function isExpectedDrift(error: unknown): boolean {
  return error instanceof Error
    && "problem" in error
    && isPlainObject((error as { problem: unknown }).problem)
    && (error as { problem: { code?: unknown } }).problem.code === "REVISION_CONFLICT";
}

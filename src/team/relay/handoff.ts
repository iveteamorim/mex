import { createHash } from "node:crypto";
import type {
  ActorRef,
  Diagnostic,
  Revision,
  RevisionExpectation,
} from "../contracts/shared.js";
import { isRevision } from "../contracts/shared.js";
import type {
  Relay,
  RelayDraft,
  RelayDraftInput,
  RelayState,
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayDraftSummary,
  TeamRelayListRequest,
  TeamRelayPurposeId,
  TeamRelaySummary,
  TeamWorkflowAuthority,
} from "../contracts/workflow.js";
import {
  RELAY_STATES,
  TEAM_RELAY_LIMITS,
} from "../contracts/workflow.js";
import { artifactError } from "../artifacts/errors.js";
import { memberArtifactPath } from "../artifacts/codecs.js";
import {
  normalizeRelayDraftInput,
  normalizeRelayDraftInputWithLegacy,
  normalizeWorkflowRevisionExpectations,
  relayArtifactPath,
} from "../artifacts/workflow-codecs.js";
import { isArtifactId } from "../artifacts/ulid.js";

const RELAY_SIGNING_DOMAIN = "mex.team.relay.receipt.v1" as const;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RELAY_CALLER_EVIDENCE_LIMIT = 64;
const RAW_LEGACY_RELAY_DRAFT_COMMANDS = new WeakSet<object>();
const LEGACY_RELAY_DIAGNOSTIC = Object.freeze({
  code: "RELAY_LEGACY_PUBLICATION_TIME",
  severity: "warning" as const,
  message: "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
});

export interface NormalizedRelayListFilter {
  perspective: "mine" | "sent" | "all";
  states: readonly RelayState[] | null;
  workstreamId: string | null;
  limit: number;
  cursor?: string;
}

export interface RelayPageCursor {
  v: 1;
  offset: number;
  corpusRevision: Revision;
  filterRevision: Revision;
}

export function normalizeTeamRelayCommand(value: unknown): TeamRelayCommand {
  return normalizeTeamRelayCommandInternal(value, false);
}

/**
 * Structural compatibility parser for an update of an already-stored migrated
 * Relay draft. Callers must prove the exact local revision and reserved
 * evidence provenance against checkout-local storage before using the result.
 */
export function normalizeExistingRelayDraftMigrationCommand(
  value: unknown,
): TeamRelayCommand {
  const command = normalizeTeamRelayCommandInternal(value, true);
  if (
    command.action.kind !== "relay.draft.save"
    || command.action.draftId === undefined
    || command.action.draft.evidence.length !== RELAY_CALLER_EVIDENCE_LIMIT + 1
  ) {
    throw invalidRelayRequest();
  }
  return command;
}

/**
 * Compatibility parser for the pre-v3 CLI request-file shape. The returned
 * command is marked by object identity only: the marker is never serialized,
 * hashed, or included in a signed preview. The workflow service must check the
 * marker before accepting the translated 65th evidence entry for an initial
 * local save.
 */
export function normalizeRawLegacyRelayDraftCommand(
  value: unknown,
): TeamRelayCommand {
  if (!isPlainObject(value) || !isPlainObject(value.action)) {
    throw invalidRelayRequest();
  }
  const rawAction = value.action;
  if (rawAction.kind !== "relay.draft.save") throw invalidRelayRequest();
  let compatibility: ReturnType<typeof normalizeRelayDraftInputWithLegacy>;
  try {
    compatibility = normalizeRelayDraftInputWithLegacy(rawAction.draft);
  } catch {
    throw invalidRelayRequest();
  }
  if (
    compatibility.legacy === null
    || compatibility.legacy.evidence.length > RELAY_CALLER_EVIDENCE_LIMIT
  ) {
    throw invalidRelayRequest();
  }
  const command = normalizeTeamRelayCommandInternal(value, true);
  if (
    command.action.kind !== "relay.draft.save"
    || command.action.draft.evidence.length > RELAY_CALLER_EVIDENCE_LIMIT + 1
  ) {
    throw invalidRelayRequest();
  }
  RAW_LEGACY_RELAY_DRAFT_COMMANDS.add(command as object);
  return command;
}

/** In-memory provenance check used only at the CLI-to-service preview seam. */
export function isRawLegacyRelayDraftCommand(
  value: unknown,
): value is TeamRelayCommand {
  return typeof value === "object"
    && value !== null
    && RAW_LEGACY_RELAY_DRAFT_COMMANDS.has(value);
}

/**
 * Structural parser for the plain translated command inside an exact signed
 * preview. Signature verification remains the authority for apply; callers
 * cannot use this parser to obtain a preview for a modern 65-entry draft.
 */
export function normalizeTranslatedLegacyRelayDraftCommand(
  value: unknown,
): TeamRelayCommand {
  const command = normalizeTeamRelayCommandInternal(value, true);
  if (
    command.action.kind !== "relay.draft.save"
    || command.action.draft.evidence.length !== RELAY_CALLER_EVIDENCE_LIMIT + 1
  ) {
    throw invalidRelayRequest();
  }
  return command;
}

function normalizeTeamRelayCommandInternal(
  value: unknown,
  allowExistingMigrationEvidence: boolean,
): TeamRelayCommand {
  boundedRelayJson(value);
  if (!isPlainObject(value)) throw invalidRelayRequest();
  exactKeys(value, ["operationId", "action", "expectedRevisions"]);
  if (typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId)) {
    throw invalidRelayRequest();
  }
  if (!isPlainObject(value.action) || typeof value.action.kind !== "string") {
    throw invalidRelayRequest();
  }
  const action = normalizeAction(value.action, allowExistingMigrationEvidence);
  let expectedRevisions: readonly RevisionExpectation[];
  try {
    expectedRevisions = normalizeWorkflowRevisionExpectations(value.expectedRevisions);
  } catch {
    throw invalidRelayValidation("Relay revision expectations are malformed.");
  }
  if (expectedRevisions.length > TEAM_RELAY_LIMITS.maxRecipients + 1) {
    throw invalidRelayValidation("Relay expectation set exceeds the product dependency bound.");
  }
  if (action.kind === "relay.draft.save" && action.draftId === undefined) {
    if (expectedRevisions.length !== 0) {
      throw invalidRelayValidation("A new Relay draft accepts no revision expectations.");
    }
  } else if (
    action.kind === "relay.draft.save"
    || action.kind === "relay.draft.delete"
  ) {
    if (action.draftId === undefined) throw invalidRelayRequest();
    requireExactLocalExpectation(expectedRevisions, action.draftId);
  } else if (action.kind === "relay.publish") {
    requirePublishExpectationTopology(expectedRevisions, action.draftId);
  } else {
    requireExactRelayExpectation(expectedRevisions, action.relayId);
  }
  return deepFreeze({ operationId: value.operationId, action, expectedRevisions });
}

export function normalizeRelayProductDraftInput(value: unknown): RelayDraftInput {
  return normalizeRelayProductDraftInputInternal(value, false);
}

/** Read/publish projection for a draft already accepted by checkout-local storage. */
export function normalizeStoredRelayProductDraftInput(value: unknown): RelayDraftInput {
  return normalizeRelayProductDraftInputInternal(value, true);
}

function normalizeRelayProductDraftInputInternal(
  value: unknown,
  allowExistingMigrationEvidence: boolean,
): RelayDraftInput {
  let normalized: RelayDraftInput;
  try {
    normalized = normalizeRelayDraftInput(value as RelayDraftInput);
  } catch {
    throw invalidRelayRequest();
  }
  if (
    normalized.recipients.length > TEAM_RELAY_LIMITS.maxRecipients
    || normalized.recipients.some((recipient) => recipient.kind !== "member")
  ) {
    throw invalidRelayValidation(
      `Local Relay recipients may contain up to ${TEAM_RELAY_LIMITS.maxRecipients} canonical Members.`,
    );
  }
  if (
    !allowExistingMigrationEvidence
    && normalized.evidence.length > RELAY_CALLER_EVIDENCE_LIMIT
  ) {
    throw invalidRelayValidation(
      "Caller-authored Relay evidence is limited to 64 entries; the reserved legacy migration entry may only be preserved on an existing exact-revision draft.",
    );
  }
  const ids = normalized.recipients.map((recipient) =>
    (recipient as Extract<ActorRef, { kind: "member" }>).memberId);
  if (new Set(ids).size !== ids.length) {
    throw invalidRelayValidation("Relay recipient member IDs must be unique.");
  }
  if (hasNoncanonicalRelayRepoPath(normalized)) {
    throw invalidRelayValidation(
      "Relay repository paths must not contain control or line-separator characters.",
    );
  }
  return deepFreeze(normalized);
}

function hasNoncanonicalRelayRepoPath(input: RelayDraftInput): boolean {
  const invalid = (path: string) => /[\u007f-\u009f\u2028\u2029]/u.test(path);
  const invalidCode = (code: RelayDraftInput["code"][number]) =>
    code.kind === "file" && invalid(code.path);
  return input.changedFiles.some(invalid)
    || input.code.some(invalidCode)
    || input.evidence.some((evidence) =>
      (evidence.kind === "file" && invalid(evidence.path))
      || (evidence.kind === "code" && invalidCode(evidence.code)));
}

export function relayDraftProjection(draft: RelayDraft): TeamRelayDraftDetail {
  const input = normalizeStoredRelayProductDraftInput({
    ...(draft.audience === undefined ? {} : { audience: draft.audience }),
    recipients: draft.recipients,
    summary: draft.summary,
    completed: draft.completed,
    inProgress: draft.inProgress,
    decisions: draft.decisions,
    blockers: draft.blockers,
    unresolvedQuestions: draft.unresolvedQuestions,
    changedFiles: draft.changedFiles,
    code: draft.code,
    evidence: draft.evidence,
    nextActions: draft.nextActions,
  });
  return deepFreeze({
    id: draft.id,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    ...(input.audience === undefined ? {} : { audience: input.audience }),
    recipients: input.recipients as readonly Extract<ActorRef, { kind: "member" }>[],
    summary: input.summary,
    input,
  });
}

export function relayDraftSummary(
  draft: TeamRelayDraftDetail,
): TeamRelayDraftSummary {
  const { input: _input, ...summary } = draft;
  return deepFreeze(summary);
}

export function relayProjection(relay: Relay): TeamRelayDetail {
  return deepFreeze({
    schemaVersion: relay.schemaVersion,
    ...(relay.audience === undefined ? {} : { audience: relay.audience }),
    ref: relay.ref,
    sourcePath: relay.sourcePath,
    revision: relay.revision,
    state: relay.state,
    sender: relay.sender,
    recipients: relay.recipients,
    workstream: relay.workstream ?? null,
    summary: relay.summary,
    publishedAt: relay.publishedAt ?? null,
    publishedRepoState: relay.publishedRepoState ?? null,
    ...(relay.acknowledgedBy === undefined ? {} : { acknowledgedBy: relay.acknowledgedBy }),
    ...(relay.acknowledgedAt === undefined ? {} : { acknowledgedAt: relay.acknowledgedAt }),
    ...(relay.closedBy === undefined ? {} : { closedBy: relay.closedBy }),
    ...(relay.closedAt === undefined ? {} : { closedAt: relay.closedAt }),
    completed: relay.completed,
    inProgress: relay.inProgress,
    decisions: relay.decisions,
    blockers: relay.blockers,
    unresolvedQuestions: relay.unresolvedQuestions,
    changedFiles: relay.changedFiles,
    code: relay.code,
    evidence: relay.evidence,
    nextActions: relay.nextActions,
    diagnostics: relay.schemaVersion === 1 ? [LEGACY_RELAY_DIAGNOSTIC] : [],
  });
}

export function relaySummary(relay: TeamRelayDetail): TeamRelaySummary {
  const {
    completed: _completed,
    inProgress: _inProgress,
    decisions: _decisions,
    blockers: _blockers,
    unresolvedQuestions: _unresolvedQuestions,
    changedFiles: _changedFiles,
    code: _code,
    evidence: _evidence,
    nextActions: _nextActions,
    diagnostics: _diagnostics,
    ...summary
  } = relay;
  return deepFreeze(summary);
}

export function legacyRelayDiagnostic() {
  return LEGACY_RELAY_DIAGNOSTIC;
}

export function aggregateRelayDiagnostics(
  diagnostics: readonly Diagnostic[],
  hasLegacy: boolean,
  sourceTruncated: boolean,
): { diagnostics: readonly Diagnostic[]; sourceTruncated: boolean } {
  const withoutLegacy = diagnostics.filter(
    (diagnostic) => diagnostic.code !== LEGACY_RELAY_DIAGNOSTIC.code,
  );
  const limit = hasLegacy ? 99 : 100;
  return deepFreeze({
    diagnostics: [
      ...withoutLegacy.slice(0, limit),
      ...(hasLegacy ? [LEGACY_RELAY_DIAGNOSTIC] : []),
    ],
    sourceTruncated: sourceTruncated || withoutLegacy.length > limit,
  });
}

export function normalizeRelayListFilter(
  value: TeamRelayListRequest = {},
): NormalizedRelayListFilter {
  if (!isPlainObject(value)) throw invalidRelayRequest();
  exactKeys(value, [], ["perspective", "states", "workstreamId", "cursor", "limit"]);
  const perspective = value.perspective ?? "all";
  if (perspective !== "mine" && perspective !== "sent" && perspective !== "all") {
    throw invalidRelayRequest();
  }
  let states: readonly RelayState[] | null = null;
  if (value.states !== undefined) {
    if (
      !Array.isArray(value.states)
      || value.states.length < 1
      || value.states.length > RELAY_STATES.length
      || value.states.some((state) => !RELAY_STATES.includes(state))
      || new Set(value.states).size !== value.states.length
    ) throw invalidRelayRequest();
    states = [...value.states].sort(compareCodePoints);
  }
  let workstreamId: string | null = null;
  if (value.workstreamId !== undefined) {
    if (
      typeof value.workstreamId !== "string"
      || !isArtifactId(value.workstreamId, "ws")
    ) throw invalidRelayRequest();
    workstreamId = value.workstreamId;
  }
  const limit = value.limit ?? TEAM_RELAY_LIMITS.defaultPageSize;
  if (
    typeof limit !== "number"
    || !Number.isInteger(limit)
    || limit < 1
    || limit > TEAM_RELAY_LIMITS.maxPageSize
  ) throw invalidRelayRequest();
  if (
    value.cursor !== undefined
    && (typeof value.cursor !== "string"
      || Buffer.byteLength(value.cursor, "utf8") > TEAM_RELAY_LIMITS.maxCursorBytes)
  ) throw invalidRelayRequest();
  const cursor = value.cursor as string | undefined;
  return deepFreeze({
    perspective,
    states,
    workstreamId,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

export function encodeRelayCursor(value: RelayPageCursor): string {
  const encoded = Buffer.from(boundedRelayJson(value), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > TEAM_RELAY_LIMITS.maxCursorBytes) {
    throw invalidRelayRequest();
  }
  return encoded;
}

export function decodeRelayCursor(value: string | undefined): RelayPageCursor | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > TEAM_RELAY_LIMITS.maxCursorBytes
  ) throw invalidRelayRequest();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw invalidRelayRequest();
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!isPlainObject(parsed)) throw invalidRelayRequest();
    exactKeys(parsed, ["v", "offset", "corpusRevision", "filterRevision"]);
    if (
      parsed.v !== 1
      || !Number.isSafeInteger(parsed.offset)
      || (parsed.offset as number) < 0
      || typeof parsed.corpusRevision !== "string"
      || !isRevision(parsed.corpusRevision)
      || typeof parsed.filterRevision !== "string"
      || !isRevision(parsed.filterRevision)
    ) throw invalidRelayRequest();
    return parsed as unknown as RelayPageCursor;
  } catch (error) {
    if (error instanceof Error && error.name === "MexPortError") throw error;
    throw invalidRelayRequest();
  }
}

export function relaySigningPayload(receipt: {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly TeamRelayPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
}): string {
  return boundedRelayReceiptJson({
    domain: RELAY_SIGNING_DOMAIN,
    schemaVersion: receipt.schemaVersion,
    authority: receipt.authority,
    purposeIds: receipt.purposeIds,
    requestRevision: receipt.requestRevision,
    presentationRevision: receipt.presentationRevision,
  });
}

export function boundedRelayJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_RELAY_LIMITS.maxEnvelopeBytes,
    maxDepth: 32,
    maxNodes: 4_096,
  });
}

export function boundedRelayReceiptJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_RELAY_LIMITS.maxReceiptBytes,
    maxDepth: TEAM_RELAY_LIMITS.maxReceiptDepth,
    maxNodes: TEAM_RELAY_LIMITS.maxReceiptNodes,
  });
}

export function hashRelayValue(value: unknown): Revision {
  return createHash("sha256").update(boundedRelayJson(value)).digest("hex") as Revision;
}

function normalizeAction(
  value: Readonly<Record<string, unknown>>,
  allowExistingMigrationEvidence: boolean,
): TeamRelayCommand["action"] {
  switch (value.kind) {
    case "relay.draft.save": {
      exactKeys(value, ["kind", "draft"], ["draftId"]);
      const draft = normalizeRelayProductDraftInputInternal(
        value.draft,
        allowExistingMigrationEvidence,
      );
      if (value.draftId !== undefined) assertLocalId(value.draftId);
      return {
        kind: value.kind,
        ...(value.draftId === undefined ? {} : { draftId: value.draftId }),
        draft,
      };
    }
    case "relay.draft.delete":
    case "relay.publish":
      exactKeys(value, ["kind", "draftId"]);
      assertLocalId(value.draftId);
      return { kind: value.kind, draftId: value.draftId };
    case "relay.acknowledge":
    case "relay.close":
      exactKeys(value, ["kind", "relayId"]);
      if (typeof value.relayId !== "string" || !isArtifactId(value.relayId, "relay")) {
        throw invalidRelayRequest();
      }
      return { kind: value.kind, relayId: value.relayId };
    default:
      throw invalidRelayValidation("Only the closed Relay lifecycle is supported.");
  }
}

function requireExactLocalExpectation(
  expectations: readonly RevisionExpectation[],
  id: string,
): void {
  requireOneLocalExpectation(expectations, id);
  if (expectations.length !== 1) {
    throw invalidRelayValidation("A Relay draft mutation accepts only its exact local draft revision.");
  }
}

function requireOneLocalExpectation(
  expectations: readonly RevisionExpectation[],
  id: string,
): void {
  const matches = expectations.filter((expectation) =>
    expectation.target.kind === "local"
      && expectation.target.namespace === "relay-draft"
      && expectation.target.id === id
      && expectation.revision !== null);
  if (matches.length !== 1) {
    throw invalidRelayValidation("An exact non-null Relay draft revision is required.");
  }
}

function requirePublishExpectationTopology(
  expectations: readonly RevisionExpectation[],
  draftId: string,
): void {
  let draftExpectations = 0;
  const memberIds: string[] = [];
  for (const expectation of expectations) {
    if (expectation.revision === null) {
      throw invalidRelayValidation(
        "Relay publication dependencies require non-null exact revisions.",
      );
    }
    if (expectation.target.kind === "local") {
      if (
        expectation.target.namespace !== "relay-draft"
        || expectation.target.id !== draftId
      ) {
        throw invalidRelayValidation(
          "Relay publication accepts only its matching local Relay draft dependency.",
        );
      }
      draftExpectations += 1;
      continue;
    }
    if (expectation.target.kind !== "artifact") {
      throw invalidRelayValidation(
        "Relay publication does not accept Wiki entity or unrelated dependency targets.",
      );
    }
    const memberId = artifactIdAtPath(
      expectation.target.path,
      ".mex/team/members",
      "member",
    );
    if (
      memberId !== null
      && memberArtifactPath(memberId) === expectation.target.path
    ) {
      memberIds.push(memberId);
      continue;
    }
    throw invalidRelayValidation(
      expectation.target.path.startsWith(".mex/workstreams/")
        ? "Relay publication no longer accepts a Workstream dependency. Preview this standalone handoff again."
        : "Relay publication artifact dependencies must be active recipient Members.",
    );
  }
  if (
    draftExpectations !== 1
    || memberIds.length > TEAM_RELAY_LIMITS.maxRecipients
    || new Set(memberIds).size !== memberIds.length
  ) {
    throw invalidRelayValidation(
      "Relay publication requires one matching draft and up to 32 unique Member dependencies; named publication requires at least one.",
    );
  }
}

function artifactIdAtPath(
  path: string,
  directory: ".mex/team/members",
  prefix: "member",
): string | null {
  const pathPrefix = `${directory}/${prefix}_`;
  if (!path.startsWith(pathPrefix) || !path.endsWith(".md")) return null;
  const id = path.slice(directory.length + 1, -3);
  return isArtifactId(id, prefix) ? id : null;
}

function requireExactRelayExpectation(
  expectations: readonly RevisionExpectation[],
  relayId: string,
): void {
  const path = relayArtifactPath(relayId);
  if (
    expectations.length !== 1
    || expectations[0]?.target.kind !== "artifact"
    || expectations[0].target.path !== path
    || expectations[0].revision === null
  ) {
    throw invalidRelayValidation("A Relay lifecycle action requires only the exact Relay artifact revision.");
  }
}

function assertLocalId(value: unknown): asserts value is string {
  if (!isRelayLocalId(value)) throw invalidRelayRequest();
}

export function isRelayLocalId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function boundedCanonicalJson(
  value: unknown,
  limits: { maxBytes: number; maxDepth: number; maxNodes: number },
): string {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) throw invalidRelayRequest();
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw invalidRelayRequest();
      return current;
    }
    if (typeof current !== "object" || active.has(current)) throw invalidRelayRequest();
    active.add(current);
    let normalized: unknown;
    if (Array.isArray(current)) {
      normalized = current.map((item) => visit(item, depth + 1));
    } else {
      if (!isPlainObject(current)) throw invalidRelayRequest();
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(current).sort(compareCodePoints)) {
        if (current[key] === undefined) throw invalidRelayRequest();
        record[key] = visit(current[key], depth + 1);
      }
      normalized = record;
    }
    active.delete(current);
    return normalized;
  };
  const serialized = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(serialized, "utf8") > limits.maxBytes) {
    throw invalidRelayRequest();
  }
  return serialized;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) throw invalidRelayRequest();
}

function invalidRelayRequest() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid Relay request",
    "The Relay request is malformed or exceeds its bounded contract.",
  );
}

function invalidRelayValidation(detail: string) {
  return artifactError("VALIDATION_FAILED", "Invalid Relay operation", detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

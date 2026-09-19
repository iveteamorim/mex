import { isArtifactId } from "../../artifacts/ulid.js";
import {
  isRepoRelativePath,
  isRevision,
  MexPortError,
} from "../../contracts/shared.js";
import type {
  TeamRelayCommand,
  TeamRelayPreviewEnvelope,
} from "../../contracts/workflow.js";
import { TeamCliUsageError } from "../../cli/envelope.js";
import { readBoundedJsonFile } from "../../cli/request-file.js";
import {
  isRelayLocalId,
  normalizeExistingRelayDraftMigrationCommand,
  normalizeRawLegacyRelayDraftCommand,
  normalizeTeamRelayCommand,
  normalizeTranslatedLegacyRelayDraftCommand,
} from "../handoff.js";

export type RelayMutationCommandName =
  | "relay.draft.save"
  | "relay.draft.delete"
  | "relay.publish"
  | "relay.acknowledge"
  | "relay.close";

const ACTION_BY_COMMAND: Readonly<Record<RelayMutationCommandName, TeamRelayCommand["action"]["kind"]>> = {
  "relay.draft.save": "relay.draft.save",
  "relay.draft.delete": "relay.draft.delete",
  "relay.publish": "relay.publish",
  "relay.acknowledge": "relay.acknowledge",
  "relay.close": "relay.close",
};

export function readRelayCommandFile(
  path: string,
  expectedCommand: RelayMutationCommandName,
): TeamRelayCommand {
  const raw = readBoundedJsonFile(path);
  assertCurrentPublishDependencyTopology(raw);
  assertCallerAuthoredDraftEvidenceBound(raw);
  const command = normalizeRelayRequest(raw);
  assertCommand(command, expectedCommand);
  return command;
}

/** Consume only the exact complete successful Team JSON preview wrapper. */
export function readRelayPreviewFile(
  path: string,
  expectedCommand: RelayMutationCommandName,
): TeamRelayPreviewEnvelope {
  return parseRelayPreviewValue(readBoundedJsonFile(path), expectedCommand);
}

/** Validate an already bounded complete CLI preview wrapper without file I/O. */
export function parseRelayPreviewValue(
  value: unknown,
  expectedCommand: RelayMutationCommandName,
): TeamRelayPreviewEnvelope {
  const envelope = record(value, "Relay preview envelope");
  exactKeys(
    envelope,
    ["schemaVersion", "command", "mode", "ok", "data", "diagnostics", "problem"],
    "Relay preview envelope",
  );
  if (
    envelope.schemaVersion !== 1
    || envelope.command !== expectedCommand
    || envelope.mode !== "preview"
    || envelope.ok !== true
    || envelope.problem !== null
    || !Array.isArray(envelope.diagnostics)
  ) {
    fail("The apply file must be a successful schema v1 preview for this exact Relay command.");
  }
  const data = record(envelope.data, "Relay service preview");
  exactKeys(data, ["schemaVersion", "request", "preview", "receipt"], "Relay service preview");
  if (data.schemaVersion !== 1) fail("The Relay service preview schemaVersion must be 1.");
  const request = normalizeRelayPreviewRequest(data.request);
  assertCommand(request, expectedCommand);
  const preview = record(data.preview, "Relay public preview");
  assertPublicPreview(preview);
  assertReceipt(data.receipt, request);
  assertDiagnostics(envelope.diagnostics, "Relay preview wrapper diagnostics");
  if (stableJson(envelope.diagnostics) !== stableJson(preview.diagnostics)) {
    fail("The Relay preview wrapper diagnostics do not match its service preview.");
  }
  return data as unknown as TeamRelayPreviewEnvelope;
}

/**
 * Apply parsing admits the exact pre-v3 publish topology only so the workflow
 * service can inspect its durable journal and finish an already-started
 * operation. Unjournaled legacy previews are refused by the apply service.
 */
function normalizeRelayPreviewRequest(value: unknown): TeamRelayCommand {
  try {
    return normalizeTeamRelayCommand(value);
  } catch (currentError) {
    try {
      return normalizeExistingRelayDraftMigrationCommand(value);
    } catch {
      try {
        return normalizeTranslatedLegacyRelayDraftCommand(value);
      } catch {
        // Continue to the separately bounded pre-v3 publication recovery shape.
      }
    }
    const legacy = normalizeLegacyPublishPreviewRequest(value);
    if (legacy === null) throw currentError;
    return legacy;
  }
}

function normalizeRelayRequest(value: unknown): TeamRelayCommand {
  try {
    return normalizeTeamRelayCommand(value);
  } catch (currentError) {
    try {
      return normalizeExistingRelayDraftMigrationCommand(value);
    } catch {
      try {
        return normalizeRawLegacyRelayDraftCommand(value);
      } catch {
        throw currentError;
      }
    }
  }
}

function normalizeLegacyPublishPreviewRequest(
  value: unknown,
): TeamRelayCommand | null {
  if (!plainRecord(value)) return null;
  const action = plainRecord(value.action) ? value.action : null;
  if (action?.kind !== "relay.publish" || !Array.isArray(value.expectedRevisions)) {
    return null;
  }
  const legacyIndexes = value.expectedRevisions.flatMap((candidate, index) =>
    isLegacyWorkstreamExpectation(candidate) ? [index] : []);
  if (legacyIndexes.length !== 1) return null;

  const legacyIndex = legacyIndexes[0]!;
  const legacyRaw = record(
    value.expectedRevisions[legacyIndex],
    "Legacy Relay Workstream expectation",
  );
  exactKeys(
    legacyRaw,
    ["target", "revision"],
    "Legacy Relay Workstream expectation",
  );
  const legacyTarget = record(
    legacyRaw.target,
    "Legacy Relay Workstream expectation target",
  );
  exactKeys(
    legacyTarget,
    ["kind", "path"],
    "Legacy Relay Workstream expectation target",
  );
  if (
    legacyTarget.kind !== "artifact"
    || typeof legacyTarget.path !== "string"
    || !/^\.mex\/workstreams\/ws_[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/u.test(legacyTarget.path)
    || typeof legacyRaw.revision !== "string"
    || !isRevision(legacyRaw.revision)
  ) return null;

  const current = normalizeTeamRelayCommand({
    ...value,
    expectedRevisions: value.expectedRevisions.filter((_, index) => index !== legacyIndex),
  });
  if (current.action.kind !== "relay.publish") return null;
  const legacyExpectation = Object.freeze({
    target: Object.freeze({
      kind: "artifact" as const,
      path: legacyTarget.path,
    }),
    revision: legacyRaw.revision,
  }) as TeamRelayCommand["expectedRevisions"][number];
  let currentIndex = 0;
  const expectedRevisions = Object.freeze(value.expectedRevisions.map((_, index) =>
    index === legacyIndex
      ? legacyExpectation
      : current.expectedRevisions[currentIndex++]!));
  return Object.freeze({
    operationId: current.operationId,
    action: current.action,
    expectedRevisions,
  });
}

function isLegacyWorkstreamExpectation(value: unknown): boolean {
  if (!plainRecord(value) || !plainRecord(value.target)) return false;
  return value.target.kind === "artifact"
    && typeof value.target.path === "string"
    && value.target.path.startsWith(".mex/workstreams/");
}

/**
 * A pre-v3 publish preview signed the Workstream as a dependency. That shape
 * cannot be safely rewritten because doing so would invalidate the receipt.
 */
function assertCurrentPublishDependencyTopology(value: unknown): void {
  if (!plainRecord(value)) return;
  const action = plainRecord(value.action) ? value.action : null;
  if (action?.kind !== "relay.publish" || !Array.isArray(value.expectedRevisions)) return;
  const containsLegacyWorkstream = value.expectedRevisions.some((candidate) => {
    if (!plainRecord(candidate)) return false;
    const target = plainRecord(candidate.target) ? candidate.target : null;
    return target?.kind === "artifact"
      && typeof target.path === "string"
      && /^\.mex\/workstreams\/ws_[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/u.test(target.path);
  });
  if (!containsLegacyWorkstream) return;
  validationFailure(
    "This Relay publication uses the pre-v3 Workstream dependency topology. Preview again with the current MEX version before applying it.",
  );
}

/**
 * JSON Schema reserves one extra evidence slot so a normalized legacy draft
 * can survive inside an exact signed preview. New caller-authored drafts still
 * own the public 64-entry collection bound.
 */
function assertCallerAuthoredDraftEvidenceBound(value: unknown): void {
  if (!plainRecord(value)) return;
  const action = plainRecord(value.action) ? value.action : null;
  if (action?.kind !== "relay.draft.save") return;
  const draft = plainRecord(action.draft) ? action.draft : null;
  if (
    draft === null
    || (typeof action.draftId === "string" && action.draftId.length > 0)
    || !Array.isArray(draft.evidence)
    || draft.evidence.length <= 64
  ) return;
  validationFailure(
    "Caller-authored Relay drafts support at most 64 evidence entries. The 65th schema slot is reserved only for legacy Workstream migration.",
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validationFailure(detail: string): never {
  throw new MexPortError({
    title: "Relay request is incompatible with the current contract",
    status: 422,
    code: "VALIDATION_FAILED",
    detail,
  });
}

function assertPublicPreview(preview: Record<string, unknown>): void {
  exactKeys(preview, ["valid", "scope", "changes", "localChanges", "diagnostics"], "Relay public preview");
  if (preview.valid !== true || !["canonical", "local", "mixed"].includes(preview.scope as string)) {
    fail("Only a valid Relay public preview with a recognized scope can be applied.");
  }
  if (!Array.isArray(preview.changes) || preview.changes.length > 16) {
    fail("Relay preview file changes are invalid.");
  }
  preview.changes.forEach(assertFileChange);
  if (!Array.isArray(preview.localChanges) || preview.localChanges.length > 16) {
    fail("Relay preview local changes are invalid.");
  }
  preview.localChanges.forEach(assertLocalChange);
  assertDiagnostics(preview.diagnostics, "Relay preview diagnostics");
}

function assertFileChange(value: unknown, index: number): void {
  const change = record(value, `Relay file change ${index}`);
  const common = ["kind", "path", "diff", "beforeRevision", "afterRevision"];
  exactKeys(change, change.kind === "move" ? [...common, "previousPath"] : common, `Relay file change ${index}`);
  if (!["create", "update", "delete", "move"].includes(change.kind as string)) {
    fail(`Relay file change ${index} kind is invalid.`);
  }
  repoPath(change.path, `Relay file change ${index} path`);
  if (change.kind === "move") repoPath(change.previousPath, `Relay file change ${index} previousPath`);
  if (typeof change.diff !== "string") fail(`Relay file change ${index} diff is invalid.`);
  nullableRevision(change.beforeRevision, `Relay file change ${index} beforeRevision`);
  nullableRevision(change.afterRevision, `Relay file change ${index} afterRevision`);
  if (change.kind === "create" && change.beforeRevision !== null) {
    fail("Relay create previews require a null beforeRevision.");
  }
  if (change.kind === "delete" && change.afterRevision !== null) {
    fail("Relay delete previews require a null afterRevision.");
  }
}

function assertLocalChange(value: unknown, index: number): void {
  const change = record(value, `Relay local change ${index}`);
  exactKeys(change, ["namespace", "id", "beforeRevision", "afterRevision", "summary"], `Relay local change ${index}`);
  if (change.namespace !== "relay-draft") fail(`Relay local change ${index} namespace is invalid.`);
  localId(change.id, `Relay local change ${index} ID`);
  nullableRevision(change.beforeRevision, `Relay local change ${index} beforeRevision`);
  nullableRevision(change.afterRevision, `Relay local change ${index} afterRevision`);
  canonicalText(change.summary, `Relay local change ${index} summary`, 1_024);
}

function assertReceipt(value: unknown, request: TeamRelayCommand): void {
  const receipt = record(value, "Relay preview receipt");
  exactKeys(receipt, [
    "schemaVersion", "authority", "purposeIds", "requestRevision",
    "presentationRevision", "previewRevision",
  ], "Relay preview receipt");
  if (receipt.schemaVersion !== 1) fail("Relay preview receipt schemaVersion is invalid.");
  assertAuthority(receipt.authority);
  if (!Array.isArray(receipt.purposeIds) || receipt.purposeIds.length > 2) {
    fail("Relay preview purpose IDs are invalid.");
  }
  const purposes = receipt.purposeIds.map((candidate, index) => {
    const purpose = record(candidate, `Relay preview purpose ${index}`);
    exactKeys(purpose, ["purpose", "id"], `Relay preview purpose ${index}`);
    if (!["relay-draft", "relay", "activity"].includes(purpose.purpose as string)) {
      fail(`Relay preview purpose ${index} is invalid.`);
    }
    if (typeof purpose.id !== "string") fail(`Relay preview purpose ${index} ID is invalid.`);
    if (purpose.purpose === "relay-draft") {
      localId(purpose.id, `Relay preview purpose ${index} ID`);
    } else if (purpose.purpose === "relay") {
      if (!isArtifactId(purpose.id, "relay")) fail(`Relay preview purpose ${index} ID is invalid.`);
    } else if (!isArtifactId(purpose.id, "event")) {
      fail(`Relay preview purpose ${index} ID is invalid.`);
    }
    return { purpose: purpose.purpose as string, id: purpose.id };
  });
  if (
    new Set(purposes.map((item) => item.purpose)).size !== purposes.length
    || new Set(purposes.map((item) => item.id)).size !== purposes.length
  ) fail("Relay preview purpose names and IDs must be unique.");
  const ordered = [...purposes].sort((left, right) => (
    left.purpose < right.purpose ? -1 : left.purpose > right.purpose ? 1 : 0
  ));
  if (stableJson(ordered) !== stableJson(purposes)) {
    fail("Relay preview purpose IDs are not in canonical order.");
  }
  const actual = purposes.map((item) => item.purpose);
  const action = request.action;
  const expected = action.kind === "relay.draft.save" && action.draftId === undefined
    ? ["relay-draft"]
    : action.kind === "relay.publish"
      ? ["activity", "relay"]
      : action.kind === "relay.acknowledge" || action.kind === "relay.close"
        ? ["activity"]
        : [];
  if (stableJson(actual) !== stableJson(expected)) {
    fail("Relay preview purpose IDs do not match the request action.");
  }
  for (const key of ["requestRevision", "presentationRevision", "previewRevision"] as const) {
    if (typeof receipt[key] !== "string" || !isRevision(receipt[key])) {
      fail(`Relay preview receipt ${key} is invalid.`);
    }
  }
}

function assertAuthority(value: unknown): void {
  const authority = record(value, "Relay preview authority");
  exactKeys(authority, ["actor", "occurredAt", "repoState"], "Relay preview authority");
  assertActor(authority.actor);
  timestamp(authority.occurredAt, "Relay preview occurredAt");
  const state = record(authority.repoState, "Relay preview repository state");
  exactKeys(state, ["branch", "head", "dirty", "observedAt"], "Relay preview repository state");
  if (state.branch !== null) canonicalText(state.branch, "Relay preview repository branch", 1_024);
  if (state.head !== null && (
    typeof state.head !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(state.head)
  )) fail("Relay preview repository HEAD is invalid.");
  if (typeof state.dirty !== "boolean") fail("Relay preview repository dirty state is invalid.");
  timestamp(state.observedAt, "Relay preview repository observedAt");
}

function assertActor(value: unknown): void {
  const actor = record(value, "Relay preview actor");
  if (actor.kind === "unknown") {
    exactKeys(actor, ["kind"], "Relay preview actor");
    return;
  }
  if (actor.kind === "member") {
    const keys = Object.hasOwn(actor, "displayName")
      ? ["kind", "memberId", "displayName"]
      : ["kind", "memberId"];
    exactKeys(actor, keys, "Relay preview actor");
    if (typeof actor.memberId !== "string" || !isArtifactId(actor.memberId, "member")) {
      fail("Relay preview member actor is invalid.");
    }
    if (actor.displayName !== undefined) {
      canonicalText(actor.displayName, "Relay preview member display name", 512);
    }
    return;
  }
  if (actor.kind === "git") {
    exactKeys(actor, ["kind", "name", "email"], "Relay preview actor");
    if (actor.name !== null) gitActorText(actor.name, "Relay preview Git name", 200);
    if (actor.email !== null) gitActorText(actor.email, "Relay preview Git email", 320);
    if (actor.name === null && actor.email === null) fail("Relay preview Git actor is empty.");
    return;
  }
  fail("Relay preview actor kind is invalid.");
}

function assertDiagnostics(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > 50) fail(`${label} are invalid.`);
  for (const [index, candidate] of value.entries()) {
    const item = record(candidate, `${label} ${index}`);
    const required = ["code", "severity", "message"];
    const optional = ["path", "location", "entity", "remediation", "detail"];
    if (
      required.some((key) => !Object.hasOwn(item, key))
      || Object.keys(item).some((key) => !required.includes(key) && !optional.includes(key))
    ) fail(`${label} ${index} contains unsupported fields.`);
    canonicalText(item.code, `${label} ${index} code`, 256);
    canonicalText(item.message, `${label} ${index} message`, 4_096);
    if (!["error", "warning", "info"].includes(item.severity as string)) {
      fail(`${label} ${index} severity is invalid.`);
    }
    if (item.path !== undefined) repoPath(item.path, `${label} ${index} path`);
    if (item.location !== undefined) assertLocation(item.location, `${label} ${index} location`);
    if (item.entity !== undefined) assertEntityRef(item.entity, `${label} ${index} entity`);
    if (item.remediation !== undefined) assertRemediation(item.remediation, `${label} ${index} remediation`);
    if (item.detail !== undefined) assertDiagnosticDetail(item.detail, `${label} ${index} detail`);
  }
}

function assertLocation(value: unknown, label: string): void {
  const location = record(value, label);
  const required = ["path"];
  const optional = ["startLine", "endLine", "startOffset", "endOffset", "headingDepth"];
  if (
    required.some((key) => !Object.hasOwn(location, key))
    || Object.keys(location).some((key) => !required.includes(key) && !optional.includes(key))
  ) fail(`${label} contains missing, unsupported, or extra fields.`);
  repoPath(location.path, `${label} path`);
  for (const key of ["startLine", "endLine", "headingDepth"] as const) {
    if (location[key] !== undefined && (
      !Number.isSafeInteger(location[key]) || (location[key] as number) < 1
    )) fail(`${label} ${key} is invalid.`);
  }
  for (const key of ["startOffset", "endOffset"] as const) {
    if (location[key] !== undefined && (
      !Number.isSafeInteger(location[key]) || (location[key] as number) < 0
    )) fail(`${label} ${key} is invalid.`);
  }
}

function assertEntityRef(value: unknown, label: string): void {
  const entity = record(value, label);
  const required = ["id", "kind"];
  const optional = ["title"];
  if (
    required.some((key) => !Object.hasOwn(entity, key))
    || Object.keys(entity).some((key) => !required.includes(key) && !optional.includes(key))
  ) fail(`${label} contains missing, unsupported, or extra fields.`);
  canonicalText(entity.id, `${label} ID`, 256);
  canonicalText(entity.kind, `${label} kind`, 64);
  if (entity.title !== undefined) canonicalText(entity.title, `${label} title`, 512);
}

function assertRemediation(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > 50) fail(`${label} is invalid.`);
  for (const [index, candidate] of value.entries()) {
    const recovery = record(candidate, `${label} ${index}`);
    const required = ["label"];
    const optional = ["command", "route"];
    if (
      required.some((key) => !Object.hasOwn(recovery, key))
      || Object.keys(recovery).some((key) => !required.includes(key) && !optional.includes(key))
    ) fail(`${label} ${index} contains missing, unsupported, or extra fields.`);
    canonicalText(recovery.label, `${label} ${index} label`, 4_096);
    if (recovery.command !== undefined) {
      canonicalText(recovery.command, `${label} ${index} command`, 4_096);
    }
    if (recovery.route !== undefined) {
      canonicalText(recovery.route, `${label} ${index} route`, 4_096);
    }
  }
}

function assertDiagnosticDetail(value: unknown, label: string): void {
  record(value, label);
  assertJsonValue(value, label);
}

function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item) => assertJsonValue(item, label));
    return;
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value as Record<string, unknown>).forEach((item) => assertJsonValue(item, label));
    return;
  }
  fail(`${label} is not recursive JSON data.`);
}

function repoPath(value: unknown, label: string): void {
  if (
    typeof value !== "string"
    || !isRepoRelativePath(value)
    || value.normalize("NFC") !== value
    || hasLoneSurrogate(value)
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 4_096
  ) fail(`${label} is invalid.`);
}

function nullableRevision(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "string" || !isRevision(value))) {
    fail(`${label} is invalid.`);
  }
}

function localId(value: unknown, label: string): void {
  if (!isRelayLocalId(value)) fail(`${label} is invalid.`);
}

function canonicalText(value: unknown, label: string, maxBytes: number): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || hasLoneSurrogate(value)
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes
  ) fail(`${label} is invalid.`);
}

/** Exact normalized field domain emitted by ActorResolver Git fallback authority. */
function gitActorText(value: unknown, label: string, maxBytes: number): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes
  ) fail(`${label} is invalid.`);
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

function timestamp(value: unknown, label: string): void {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || parsed === null
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== value
  ) fail(`${label} is invalid.`);
}

function assertCommand(
  command: TeamRelayCommand,
  expectedCommand: RelayMutationCommandName,
): void {
  if (command.action.kind !== ACTION_BY_COMMAND[expectedCommand]) {
    fail(`The request action must be ${ACTION_BY_COMMAND[expectedCommand]}.`);
  }
  if (
    command.action.kind === "relay.draft.save"
    || command.action.kind === "relay.draft.delete"
    || command.action.kind === "relay.publish"
  ) {
    if (command.action.draftId !== undefined) {
      localId(command.action.draftId, "Relay request draft ID");
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key))
  ) fail(`${label} contains missing, unsupported, or extra fields.`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
  )).join(",")}}`;
}

function fail(message: string): never {
  throw new TeamCliUsageError(message);
}

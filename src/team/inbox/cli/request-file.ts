import type {
  TeamInboxSpecCommand,
  TeamInboxSpecPreviewEnvelope,
} from "../../contracts/workflow.js";
import { isRepoRelativePath, isRevision } from "../../contracts/shared.js";
import { isArtifactId } from "../../artifacts/ulid.js";
import { TeamCliUsageError } from "../../cli/envelope.js";
import { readBoundedJsonFile } from "../../cli/request-file.js";
import { normalizeTeamInboxSpecCommand } from "../spec-authoring.js";

export type InboxMutationCommandName =
  | "inbox.draft.save"
  | "inbox.draft.delete"
  | "inbox.publish"
  | "inbox.proposal.approve"
  | "inbox.proposal.reject"
  | "inbox.proposal.withdraw"
  | "inbox.proposal.mark-stale"
  | "inbox.proposal.repair";

const ACTION_BY_COMMAND: Readonly<Record<InboxMutationCommandName, TeamInboxSpecCommand["action"]["kind"]>> = {
  "inbox.draft.save": "inbox.draft.save",
  "inbox.draft.delete": "inbox.draft.delete",
  "inbox.publish": "inbox.publish",
  "inbox.proposal.approve": "inbox.approve",
  "inbox.proposal.reject": "inbox.reject",
  "inbox.proposal.withdraw": "inbox.withdraw",
  "inbox.proposal.mark-stale": "inbox.mark-stale",
  "inbox.proposal.repair": "inbox.repair",
};

export function readInboxCommandFile(
  path: string,
  expectedCommand: InboxMutationCommandName,
): TeamInboxSpecCommand {
  const command = normalizeTeamInboxSpecCommand(readBoundedJsonFile(path));
  assertCommand(command, expectedCommand);
  return command;
}

/** Consume only the exact complete successful Team JSON preview wrapper. */
export function readInboxPreviewFile(
  path: string,
  expectedCommand: InboxMutationCommandName,
): TeamInboxSpecPreviewEnvelope {
  const envelope = record(readBoundedJsonFile(path), "Inbox preview envelope");
  exactKeys(
    envelope,
    ["schemaVersion", "command", "mode", "ok", "data", "diagnostics", "problem"],
    "Inbox preview envelope",
  );
  if (
    envelope.schemaVersion !== 1
    || envelope.command !== expectedCommand
    || envelope.mode !== "preview"
    || envelope.ok !== true
    || envelope.problem !== null
    || !Array.isArray(envelope.diagnostics)
  ) {
    fail("The apply file must be a successful schema v1 preview for this exact Inbox command.");
  }
  const data = record(envelope.data, "Inbox service preview");
  exactKeys(data, ["schemaVersion", "request", "preview", "receipt"], "Inbox service preview");
  if (data.schemaVersion !== 1) fail("The Inbox service preview schemaVersion must be 1.");
  const request = normalizeTeamInboxSpecCommand(data.request);
  assertCommand(request, expectedCommand);
  const preview = record(data.preview, "Inbox public preview");
  assertPublicPreview(preview);
  assertReceipt(data.receipt, request);
  assertDiagnostics(envelope.diagnostics, "Inbox preview wrapper diagnostics");
  if (stableJson(envelope.diagnostics) !== stableJson(preview.diagnostics)) {
    fail("The Inbox preview wrapper diagnostics do not match its service preview.");
  }
  return data as unknown as TeamInboxSpecPreviewEnvelope;
}

function assertPublicPreview(preview: Record<string, unknown>): void {
  exactKeys(preview, ["valid", "scope", "changes", "localChanges", "diagnostics"], "Inbox public preview");
  if (preview.valid !== true || !["canonical", "local", "mixed"].includes(preview.scope as string)) {
    fail("Only a valid Inbox public preview with a recognized scope can be applied.");
  }
  if (!Array.isArray(preview.changes) || preview.changes.length > 16) {
    fail("Inbox preview file changes are invalid.");
  }
  preview.changes.forEach(assertFileChange);
  if (!Array.isArray(preview.localChanges) || preview.localChanges.length > 16) {
    fail("Inbox preview local changes are invalid.");
  }
  preview.localChanges.forEach(assertLocalChange);
  assertDiagnostics(preview.diagnostics, "Inbox preview diagnostics");
}

function assertFileChange(value: unknown, index: number): void {
  const change = record(value, `Inbox file change ${index}`);
  const common = ["kind", "path", "diff", "beforeRevision", "afterRevision"];
  exactKeys(change, change.kind === "move" ? [...common, "previousPath"] : common, `Inbox file change ${index}`);
  if (!["create", "update", "delete", "move"].includes(change.kind as string)) fail(`Inbox file change ${index} kind is invalid.`);
  repoPath(change.path, `Inbox file change ${index} path`);
  if (change.kind === "move") repoPath(change.previousPath, `Inbox file change ${index} previousPath`);
  if (typeof change.diff !== "string") fail(`Inbox file change ${index} diff is invalid.`);
  nullableRevision(change.beforeRevision, `Inbox file change ${index} beforeRevision`);
  nullableRevision(change.afterRevision, `Inbox file change ${index} afterRevision`);
  if (change.kind === "create" && change.beforeRevision !== null) fail("Inbox create previews require a null beforeRevision.");
  if (change.kind === "delete" && change.afterRevision !== null) fail("Inbox delete previews require a null afterRevision.");
}

function assertLocalChange(value: unknown, index: number): void {
  const change = record(value, `Inbox local change ${index}`);
  exactKeys(change, ["namespace", "id", "beforeRevision", "afterRevision", "summary"], `Inbox local change ${index}`);
  if (change.namespace !== "inbox-draft") fail(`Inbox local change ${index} namespace is invalid.`);
  localId(change.id, `Inbox local change ${index} ID`);
  nullableRevision(change.beforeRevision, `Inbox local change ${index} beforeRevision`);
  nullableRevision(change.afterRevision, `Inbox local change ${index} afterRevision`);
  canonicalText(change.summary, `Inbox local change ${index} summary`, 1_024);
}

function assertReceipt(value: unknown, request: TeamInboxSpecCommand): void {
  const receipt = record(value, "Inbox preview receipt");
  exactKeys(receipt, [
    "schemaVersion", "authority", "purposeIds", "requestRevision",
    "presentationRevision", "previewRevision",
  ], "Inbox preview receipt");
  if (receipt.schemaVersion !== 1) fail("Inbox preview receipt schemaVersion is invalid.");
  assertAuthority(receipt.authority);
  if (!Array.isArray(receipt.purposeIds) || receipt.purposeIds.length > 2) {
    fail("Inbox preview purpose IDs are invalid.");
  }
  const purposes = receipt.purposeIds.map((candidate, index) => {
    const purpose = record(candidate, `Inbox preview purpose ${index}`);
    exactKeys(purpose, ["purpose", "id"], `Inbox preview purpose ${index}`);
    if (!["inbox-draft", "proposal", "activity", "spec-entity"].includes(purpose.purpose as string)) {
      fail(`Inbox preview purpose ${index} is invalid.`);
    }
    if (typeof purpose.id !== "string") fail(`Inbox preview purpose ${index} ID is invalid.`);
    if (purpose.purpose === "inbox-draft") {
      localId(purpose.id, `Inbox preview purpose ${index} ID`);
    } else if (purpose.purpose === "proposal") {
      if (!isArtifactId(purpose.id, "proposal")) fail(`Inbox preview purpose ${index} ID is invalid.`);
    } else if (purpose.purpose === "activity") {
      if (!isArtifactId(purpose.id, "event")) fail(`Inbox preview purpose ${index} ID is invalid.`);
    } else if (!/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(purpose.id)) {
      fail(`Inbox preview purpose ${index} ID is invalid.`);
    }
    return { purpose: purpose.purpose as string, id: purpose.id };
  });
  if (
    new Set(purposes.map((item) => item.purpose)).size !== purposes.length
    || new Set(purposes.map((item) => item.id)).size !== purposes.length
  ) fail("Inbox preview purpose names and IDs must be unique.");
  const ordered = [...purposes].sort((left, right) => left.purpose < right.purpose ? -1 : left.purpose > right.purpose ? 1 : 0);
  if (stableJson(ordered) !== stableJson(purposes)) fail("Inbox preview purpose IDs are not in canonical order.");
  const actual = purposes.map((item) => item.purpose);
  const action = request.action;
  const expected = action.kind === "inbox.draft.save" && action.draftId === undefined
    ? ["inbox-draft"]
    : action.kind === "inbox.publish"
      ? ["activity", "proposal"]
      : action.kind === "inbox.approve"
        ? actual.includes("spec-entity") ? ["activity", "spec-entity"] : ["activity"]
        : action.kind === "inbox.reject"
          || action.kind === "inbox.withdraw"
          || action.kind === "inbox.mark-stale"
          || action.kind === "inbox.repair"
          ? ["activity"]
          : [];
  if (stableJson(actual) !== stableJson(expected)) fail("Inbox preview purpose IDs do not match the request action.");
  for (const key of ["requestRevision", "presentationRevision", "previewRevision"] as const) {
    if (typeof receipt[key] !== "string" || !isRevision(receipt[key])) fail(`Inbox preview receipt ${key} is invalid.`);
  }
}

function assertAuthority(value: unknown): void {
  const authority = record(value, "Inbox preview authority");
  exactKeys(authority, ["actor", "occurredAt", "repoState"], "Inbox preview authority");
  assertActor(authority.actor);
  timestamp(authority.occurredAt, "Inbox preview occurredAt");
  const state = record(authority.repoState, "Inbox preview repository state");
  exactKeys(state, ["branch", "head", "dirty", "observedAt"], "Inbox preview repository state");
  if (state.branch !== null) canonicalText(state.branch, "Inbox preview repository branch", 1_024);
  if (state.head !== null && (typeof state.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(state.head))) {
    fail("Inbox preview repository HEAD is invalid.");
  }
  if (typeof state.dirty !== "boolean") fail("Inbox preview repository dirty state is invalid.");
  timestamp(state.observedAt, "Inbox preview repository observedAt");
}

function assertActor(value: unknown): void {
  const actor = record(value, "Inbox preview actor");
  if (actor.kind === "unknown") {
    exactKeys(actor, ["kind"], "Inbox preview actor");
    return;
  }
  if (actor.kind === "member") {
    const keys = Object.hasOwn(actor, "displayName") ? ["kind", "memberId", "displayName"] : ["kind", "memberId"];
    exactKeys(actor, keys, "Inbox preview actor");
    if (typeof actor.memberId !== "string" || !isArtifactId(actor.memberId, "member")) fail("Inbox preview member actor is invalid.");
    if (actor.displayName !== undefined) canonicalText(actor.displayName, "Inbox preview member display name", 512);
    return;
  }
  if (actor.kind === "git") {
    exactKeys(actor, ["kind", "name", "email"], "Inbox preview actor");
    if (actor.name !== null) canonicalText(actor.name, "Inbox preview Git name", 512);
    if (actor.email !== null) canonicalText(actor.email, "Inbox preview Git email", 512);
    if (actor.name === null && actor.email === null) fail("Inbox preview Git actor is empty.");
    return;
  }
  fail("Inbox preview actor kind is invalid.");
}

function assertDiagnostics(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > 50) {
    fail(`${label} are invalid.`);
  }
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
    if (!["error", "warning", "info"].includes(item.severity as string)) fail(`${label} ${index} severity is invalid.`);
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
    if (location[key] !== undefined && (!Number.isSafeInteger(location[key]) || (location[key] as number) < 1)) {
      fail(`${label} ${key} is invalid.`);
    }
  }
  for (const key of ["startOffset", "endOffset"] as const) {
    if (location[key] !== undefined && (!Number.isSafeInteger(location[key]) || (location[key] as number) < 0)) {
      fail(`${label} ${key} is invalid.`);
    }
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
    if (recovery.command !== undefined) canonicalText(recovery.command, `${label} ${index} command`, 4_096);
    if (recovery.route !== undefined) canonicalText(recovery.route, `${label} ${index} route`, 4_096);
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
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 4_096
  ) {
    fail(`${label} is invalid.`);
  }
}

function nullableRevision(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "string" || !isRevision(value))) fail(`${label} is invalid.`);
}

function localId(value: unknown, label: string): void {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256
  ) fail(`${label} is invalid.`);
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
  command: TeamInboxSpecCommand,
  expectedCommand: InboxMutationCommandName,
): void {
  if (command.action.kind !== ACTION_BY_COMMAND[expectedCommand]) {
    fail(`The request action must be ${ACTION_BY_COMMAND[expectedCommand]}.`);
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

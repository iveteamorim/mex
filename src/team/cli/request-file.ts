import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  isRepoRelativePath,
  isRevision,
  type RevisionExpectation,
} from "../contracts/shared.js";
import {
  TEAM_IDENTITY_ACTIVITY_LIMITS,
  type ActivitySubjectRef,
  type MemberGitAlias,
  type TeamIdentityActivityCommand,
  type TeamIdentityActivityPreviewEnvelope,
  type TeamWorkstreamCommand,
  type TeamWorkstreamPreviewEnvelope,
  WORKSTREAM_STATES,
} from "../contracts/workflow.js";
import { ACTIVITY_SUBJECT_LIMIT, MEMBER_GIT_ALIAS_LIMIT } from "../artifacts/codecs.js";
import { WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES } from "../artifacts/workflow-codecs.js";
import { isArtifactId } from "../artifacts/ulid.js";
import {
  TeamCliUsageError,
  type TeamCliCommandName,
} from "./envelope.js";

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const MAX_EXPECTATIONS = 64;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type TeamIdentityActivityMutationCommandName = Extract<
  TeamCliCommandName,
  | "member.add"
  | "member.update"
  | "member.deactivate"
  | "member.reactivate"
  | "member.select"
  | "activity.record"
>;

export type TeamWorkstreamMutationCommandName = Extract<
  TeamCliCommandName,
  "workstream.create" | "workstream.update" | "workstream.archive"
>;

export type TeamMutationCommandName =
  | TeamIdentityActivityMutationCommandName
  | TeamWorkstreamMutationCommandName;

type TeamMutationActionName = TeamMutationCommandName | "member.clear";

/** Read and validate one caller-authored preview request. */
export function readTeamCommandFile(
  path: string,
  expectedCommand: TeamIdentityActivityMutationCommandName,
): TeamIdentityActivityCommand;
export function readTeamCommandFile(
  path: string,
  expectedCommand: TeamWorkstreamMutationCommandName,
): TeamWorkstreamCommand;
export function readTeamCommandFile(
  path: string,
  expectedCommand: TeamMutationCommandName,
): TeamIdentityActivityCommand | TeamWorkstreamCommand {
  const value = readBoundedJsonFile(path);
  if (isWorkstreamCommandName(expectedCommand)) {
    assertWorkstreamCommand(value, expectedCommand);
  } else {
    assertIdentityActivityCommand(value, expectedCommand);
  }
  return value;
}

/**
 * Consume the complete JSON envelope emitted by preview.
 *
 * A request fragment, receipt fragment, or reconstructed prepared command is
 * intentionally rejected. The workflow service gets the exact inner preview
 * envelope that it issued and performs its own revision/hash revalidation.
 */
export function readTeamPreviewFile(
  path: string,
  expectedCommand: TeamIdentityActivityMutationCommandName,
): TeamIdentityActivityPreviewEnvelope;
export function readTeamPreviewFile(
  path: string,
  expectedCommand: TeamWorkstreamMutationCommandName,
): TeamWorkstreamPreviewEnvelope;
export function readTeamPreviewFile(
  path: string,
  expectedCommand: TeamMutationCommandName,
): TeamIdentityActivityPreviewEnvelope | TeamWorkstreamPreviewEnvelope {
  const value = readBoundedJsonFile(path);
  const envelope = record(value, "Team preview envelope");
  exactKeys(
    envelope,
    ["schemaVersion", "command", "mode", "ok", "data", "diagnostics", "problem"],
    [],
    "Team preview envelope",
  );
  if (
    envelope.schemaVersion !== 1
    || envelope.command !== expectedCommand
    || envelope.mode !== "preview"
    || envelope.ok !== true
    || envelope.problem !== null
  ) {
    fail("The apply file must be a successful schema v1 preview for this exact command.");
  }
  if (!Array.isArray(envelope.diagnostics)) {
    fail("The Team preview envelope diagnostics must be an array.");
  }
  const data = record(envelope.data, "Team service preview");
  if (isWorkstreamCommandName(expectedCommand)) {
    assertWorkstreamPreview(data, expectedCommand);
  } else {
    assertIdentityActivityPreview(data, expectedCommand);
  }
  if (!sameDiagnostics(envelope.diagnostics, data.preview.diagnostics)) {
    fail("The Team preview envelope diagnostics do not match its service preview.");
  }
  return data;
}

/** Bounded, no-follow, identity-stable read of one regular JSON file. */
export function readBoundedJsonFile(path: string): unknown {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("A non-empty request file path is required.");
  }
  let descriptor: number | undefined;
  try {
    const lexical = lstatSync(path, { bigint: true });
    if (lexical.isSymbolicLink() || !lexical.isFile()) {
      fail("The request file must be a regular file and must not be a symbolic link.");
    }
    if (lexical.size > BigInt(TEAM_IDENTITY_ACTIVITY_LIMITS.maxEnvelopeBytes)) {
      fail(`The request file exceeds ${TEAM_IDENTITY_ACTIVITY_LIMITS.maxEnvelopeBytes} bytes.`);
    }

    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameIdentity(lexical, before)) {
      fail("The request file changed before it could be read safely.");
    }
    const bytes = readDescriptorBounded(
      descriptor,
      TEAM_IDENTITY_ACTIVITY_LIMITS.maxEnvelopeBytes,
    );
    const after = fstatSync(descriptor, { bigint: true });
    const live = lstatSync(path, { bigint: true });
    if (
      live.isSymbolicLink()
      || !live.isFile()
      || !sameIdentity(before, after)
      || !sameIdentity(after, live)
      || before.size !== after.size
      || after.size !== BigInt(bytes.byteLength)
    ) {
      fail("The request file changed while it was being read.");
    }

    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("The request file must contain valid UTF-8 JSON.");
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      fail("The request file must contain one valid JSON value.");
    }
    assertBoundedJson(value);
    return value;
  } catch (error) {
    if (error instanceof TeamCliUsageError) throw error;
    fail("The request file could not be opened as a safe regular file.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertIdentityActivityCommand(
  value: unknown,
  expectedCommand: TeamIdentityActivityMutationCommandName,
): asserts value is TeamIdentityActivityCommand {
  const command = record(value, "Team mutation request");
  exactKeys(command, ["operationId", "action", "expectedRevisions"], [], "Team mutation request");
  if (typeof command.operationId !== "string" || !OPERATION_ID.test(command.operationId)) {
    fail("operationId must be bounded ASCII without paths or whitespace.");
  }
  const action = record(command.action, "Team mutation action");
  if (!isExpectedAction(action.kind, expectedCommand)) {
    fail(
      expectedCommand === "member.select"
        ? "The request action must be member.select or member.clear."
        : `The request action must be ${expectedCommand}.`,
    );
  }
  const actionKind = action.kind as TeamMutationActionName;
  assertAction(action, actionKind);
  const expectations = assertRevisionExpectations(command.expectedRevisions);
  if (
    actionKind !== "member.add"
    && actionKind !== "activity.record"
    && expectations.length === 0
  ) {
    fail(`${actionKind} requires at least one exact revision expectation.`);
  }
}

function assertWorkstreamCommand(
  value: unknown,
  expectedCommand: TeamWorkstreamMutationCommandName,
): asserts value is TeamWorkstreamCommand {
  const command = record(value, "Workstream mutation request");
  exactKeys(command, ["operationId", "action", "expectedRevisions"], [], "Workstream mutation request");
  if (typeof command.operationId !== "string" || !OPERATION_ID.test(command.operationId)) {
    fail("operationId must be bounded ASCII without paths or whitespace.");
  }
  const action = record(command.action, "Workstream mutation action");
  if (action.kind !== expectedCommand) {
    fail(`The request action must be ${expectedCommand}.`);
  }
  assertAction(action, expectedCommand);
  const expectations = assertRevisionExpectations(command.expectedRevisions);
  if (expectedCommand !== "workstream.create" && expectations.length === 0) {
    fail(`${expectedCommand} requires at least one exact revision expectation.`);
  }
}

function isExpectedAction(
  value: unknown,
  expectedCommand: TeamIdentityActivityMutationCommandName,
): value is TeamMutationActionName {
  return value === expectedCommand
    || (expectedCommand === "member.select" && value === "member.clear");
}

function assertAction(
  action: Record<string, unknown>,
  kind: TeamMutationActionName,
): void {
  switch (kind) {
    case "member.add": {
      exactKeys(action, ["kind", "member"], [], kind);
      assertMemberInput(action.member);
      return;
    }
    case "member.update": {
      exactKeys(action, ["kind", "memberId", "patch"], [], kind);
      memberId(action.memberId);
      const patch = record(action.patch, "member update patch");
      exactKeys(patch, [], ["displayName", "gitAliases"], "member update patch");
      if (Object.keys(patch).length === 0) fail("member.update patch must not be empty.");
      if (patch.displayName !== undefined) canonicalText(patch.displayName, "member display name", 200);
      if (patch.gitAliases !== undefined) assertAliases(patch.gitAliases);
      return;
    }
    case "member.deactivate":
    case "member.reactivate":
    case "member.select":
      exactKeys(action, ["kind", "memberId"], [], kind);
      memberId(action.memberId);
      return;
    case "member.clear":
      exactKeys(action, ["kind"], [], kind);
      return;
    case "activity.record": {
      exactKeys(action, ["kind", "activity"], [], kind);
      const activity = record(action.activity, "activity record input");
      exactKeys(activity, ["action", "subjects"], ["workstream"], "activity record input");
      const name = canonicalText(activity.action, "activity action", 128);
      if (!ACTION.test(name)) fail("activity action must be a lower-case namespaced identifier.");
      assertSubjects(activity.subjects);
      if (activity.workstream !== undefined) {
        const workstream = assertEntityRef(activity.workstream, "activity Workstream");
        if (workstream.kind !== "workstream") fail("activity workstream must have kind workstream.");
      }
      return;
    }
    case "workstream.create": {
      exactKeys(action, ["kind", "workstream"], [], kind);
      assertWorkstreamCreate(action.workstream);
      return;
    }
    case "workstream.update": {
      exactKeys(action, ["kind", "workstreamId", "patch"], [], kind);
      workstreamId(action.workstreamId);
      assertWorkstreamUpdatePatch(action.patch);
      return;
    }
    case "workstream.archive":
      exactKeys(action, ["kind", "workstreamId"], [], kind);
      workstreamId(action.workstreamId);
      return;
  }
}

function assertWorkstreamCreate(value: unknown): void {
  const input = record(value, "workstream create input");
  exactKeys(
    input,
    ["title", "goal", "summary", "owners", "nextMilestone"],
    ["contributors", "paths", "code", "topics", "components", "related"],
    "workstream create input",
  );
  canonicalText(input.title, "workstream title", 512);
  canonicalText(input.goal, "workstream goal", 4 * 1024);
  canonicalText(input.summary, "workstream summary", 4 * 1024);
  assertActorSet(input.owners, "workstream owners", true);
  if (input.contributors !== undefined) assertActorSet(input.contributors, "workstream contributors");
  if (input.paths !== undefined) assertPathSet(input.paths, "workstream paths");
  if (input.code !== undefined) assertCodeSet(input.code, "workstream code references");
  if (input.topics !== undefined) assertEntitySet(input.topics, "workstream topics");
  if (input.components !== undefined) assertEntitySet(input.components, "workstream components");
  if (input.related !== undefined) assertEntitySet(input.related, "workstream related entities");
  canonicalText(input.nextMilestone, "workstream next milestone", 4 * 1024);
}

function assertWorkstreamUpdatePatch(value: unknown): void {
  const patch = record(value, "workstream update patch");
  exactKeys(patch, [], [
    "title", "goal", "summary", "state", "owners", "contributors", "paths",
    "code", "topics", "components", "related", "blockers", "currentState",
    "nextMilestone",
  ], "workstream update patch");
  if (Object.keys(patch).length === 0) fail("workstream.update patch must not be empty.");
  if (patch.title !== undefined) canonicalText(patch.title, "workstream title", 512);
  if (patch.goal !== undefined) canonicalText(patch.goal, "workstream goal", 4 * 1024);
  if (patch.summary !== undefined) canonicalText(patch.summary, "workstream summary", 4 * 1024);
  if (patch.state !== undefined && (
    !(WORKSTREAM_STATES as readonly unknown[]).includes(patch.state)
    || patch.state === "archived"
  )) {
    fail("workstream state is invalid.");
  }
  if (patch.owners !== undefined) assertActorSet(patch.owners, "workstream owners", true);
  if (patch.contributors !== undefined) assertActorSet(patch.contributors, "workstream contributors");
  if (patch.paths !== undefined) assertPathSet(patch.paths, "workstream paths");
  if (patch.code !== undefined) assertCodeSet(patch.code, "workstream code references");
  if (patch.topics !== undefined) assertEntitySet(patch.topics, "workstream topics");
  if (patch.components !== undefined) assertEntitySet(patch.components, "workstream components");
  if (patch.related !== undefined) assertEntitySet(patch.related, "workstream related entities");
  if (patch.blockers !== undefined) assertTextSet(patch.blockers, "workstream blockers", 4 * 1024);
  if (patch.currentState !== undefined) canonicalText(patch.currentState, "workstream current state", 8 * 1024);
  if (patch.nextMilestone !== undefined) canonicalText(patch.nextMilestone, "workstream next milestone", 4 * 1024);
}

function assertActorSet(value: unknown, label: string, requireOne = false): void {
  const entries = boundedArray(value, label, requireOne);
  for (const [index, entry] of entries.entries()) assertActor(entry, `${label} ${index}`);
  assertUnique(entries, label);
}

function assertPathSet(value: unknown, label: string): void {
  const entries = boundedArray(value, label);
  for (const [index, entry] of entries.entries()) repoPath(entry, `${label} ${index}`);
  assertUnique(entries, label);
}

function assertCodeSet(value: unknown, label: string): void {
  const entries = boundedArray(value, label);
  for (const [index, entry] of entries.entries()) assertCodeRef(entry, `${label} ${index}`);
  assertUnique(entries, label);
}

function assertEntitySet(value: unknown, label: string): void {
  const entries = boundedArray(value, label);
  for (const [index, entry] of entries.entries()) assertEntityRef(entry, `${label} ${index}`);
  assertUnique(entries, label);
}

function assertTextSet(value: unknown, label: string, maxBytes: number): void {
  const entries = boundedArray(value, label);
  for (const [index, entry] of entries.entries()) canonicalText(entry, `${label} ${index}`, maxBytes);
  assertUnique(entries, label);
}

function boundedArray(value: unknown, label: string, requireOne = false): readonly unknown[] {
  if (
    !Array.isArray(value)
    || value.length > WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES
    || (requireOne && value.length === 0)
  ) {
    fail(`${label} must contain ${requireOne ? "1-" : "at most "}${WORKFLOW_ARTIFACT_MAX_COLLECTION_ENTRIES} entries.`);
  }
  return value;
}

function assertUnique(value: readonly unknown[], label: string): void {
  const keys = value.map(stableJson);
  if (new Set(keys).size !== keys.length) fail(`${label} must be unique.`);
}

function assertMemberInput(value: unknown): void {
  const member = record(value, "member input");
  exactKeys(member, ["displayName", "gitAliases"], [], "member input");
  canonicalText(member.displayName, "member display name", 200);
  assertAliases(member.gitAliases);
}

function assertAliases(value: unknown): asserts value is readonly MemberGitAlias[] {
  if (!Array.isArray(value) || value.length > MEMBER_GIT_ALIAS_LIMIT) {
    fail(`member gitAliases must contain at most ${MEMBER_GIT_ALIAS_LIMIT} entries.`);
  }
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const alias = record(candidate, `Git alias ${index}`);
    exactKeys(alias, ["name", "email"], [], `Git alias ${index}`);
    const name = alias.name === null ? null : canonicalText(alias.name, `Git alias ${index} name`, 200);
    const email = alias.email === null ? null : canonicalText(alias.email, `Git alias ${index} email`, 320);
    if (name === null && email === null) fail(`Git alias ${index} must contain a name or email.`);
    if (email !== null && (!email.includes("@") || /\s/u.test(email))) {
      fail(`Git alias ${index} email is invalid.`);
    }
    const key = `${name ?? ""}\0${email?.toLowerCase() ?? ""}`;
    if (seen.has(key)) fail("member Git aliases must be unique.");
    seen.add(key);
  }
}

function assertSubjects(value: unknown): asserts value is readonly ActivitySubjectRef[] {
  if (!Array.isArray(value) || value.length > ACTIVITY_SUBJECT_LIMIT) {
    fail(`activity subjects must contain at most ${ACTIVITY_SUBJECT_LIMIT} entries.`);
  }
  for (const [index, candidate] of value.entries()) {
    const subject = record(candidate, `activity subject ${index}`);
    if (subject.kind === "entity") {
      exactKeys(subject, ["kind", "entity"], [], `activity subject ${index}`);
      assertEntityRef(subject.entity, `activity subject ${index} entity`);
    } else if (subject.kind === "code") {
      exactKeys(subject, ["kind", "code"], [], `activity subject ${index}`);
      assertCodeRef(subject.code, `activity subject ${index} code`);
    } else if (subject.kind === "file") {
      exactKeys(subject, ["kind", "path"], [], `activity subject ${index}`);
      repoPath(subject.path, `activity subject ${index} path`);
    } else if (subject.kind === "commit") {
      exactKeys(subject, ["kind", "hash"], [], `activity subject ${index}`);
      if (typeof subject.hash !== "string" || !GIT_OBJECT_ID.test(subject.hash)) {
        fail(`activity subject ${index} commit hash is invalid.`);
      }
    } else {
      fail(`activity subject ${index} kind is invalid.`);
    }
  }
}

function assertEntityRef(value: unknown, label: string): Record<string, unknown> {
  const entity = record(value, label);
  exactKeys(entity, ["id", "kind"], ["title"], label);
  canonicalText(entity.id, `${label} ID`, 256);
  canonicalText(entity.kind, `${label} kind`, 64);
  if (entity.title !== undefined) canonicalText(entity.title, `${label} title`, 512);
  return entity;
}

function assertCodeRef(value: unknown, label: string): void {
  const code = record(value, label);
  if (code.kind === "symbol") {
    exactKeys(code, ["kind", "symbolId"], ["fingerprint"], label);
    canonicalText(code.symbolId, `${label} symbolId`, 1_024);
  } else if (code.kind === "file") {
    exactKeys(code, ["kind", "path"], ["fingerprint"], label);
    repoPath(code.path, `${label} path`);
  } else {
    fail(`${label} kind is invalid.`);
  }
  if (code.fingerprint !== undefined) canonicalText(code.fingerprint, `${label} fingerprint`, 1_024);
}

function assertRevisionExpectations(value: unknown): readonly RevisionExpectation[] {
  if (!Array.isArray(value) || value.length > MAX_EXPECTATIONS) {
    fail(`expectedRevisions must contain at most ${MAX_EXPECTATIONS} entries.`);
  }
  for (const [index, candidate] of value.entries()) {
    const expectation = record(candidate, `revision expectation ${index}`);
    exactKeys(expectation, ["target", "revision"], ["semanticRevision"], `revision expectation ${index}`);
    if (expectation.revision !== null && (typeof expectation.revision !== "string" || !isRevision(expectation.revision))) {
      fail(`revision expectation ${index} revision must be null or a lower-case SHA-256 digest.`);
    }
    const target = record(expectation.target, `revision expectation ${index} target`);
    if (target.kind === "entity") {
      exactKeys(target, ["kind", "id"], [], `revision expectation ${index} entity target`);
      canonicalText(target.id, `revision expectation ${index} entity ID`, 256);
      if (expectation.revision !== null && expectation.semanticRevision === undefined) {
        fail(`revision expectation ${index} existing entity requires semanticRevision.`);
      }
      if (
        expectation.semanticRevision !== undefined
        && expectation.semanticRevision !== null
        && (!Number.isSafeInteger(expectation.semanticRevision) || (expectation.semanticRevision as number) < 1)
      ) {
        fail(`revision expectation ${index} semanticRevision is invalid.`);
      }
    } else if (target.kind === "artifact") {
      exactKeys(target, ["kind", "path"], [], `revision expectation ${index} artifact target`);
      repoPath(target.path, `revision expectation ${index} artifact path`);
      if (expectation.semanticRevision !== undefined) fail("artifact expectations must not carry semanticRevision.");
    } else if (target.kind === "local") {
      exactKeys(target, ["kind", "namespace", "id"], [], `revision expectation ${index} local target`);
      if (![
        "inbox-draft",
        "relay-draft",
        "cursor",
        "job",
        "member-selection",
      ].includes(target.namespace as string)) {
        fail(`revision expectation ${index} local namespace is invalid.`);
      }
      canonicalText(target.id, `revision expectation ${index} local ID`, 256);
      if (expectation.semanticRevision !== undefined) fail("local expectations must not carry semanticRevision.");
    } else {
      fail(`revision expectation ${index} target kind is invalid.`);
    }
  }
  return value as unknown as readonly RevisionExpectation[];
}

function assertIdentityActivityPreview(
  envelope: Record<string, unknown>,
  expectedCommand: TeamIdentityActivityMutationCommandName,
): asserts envelope is Record<string, unknown> & TeamIdentityActivityPreviewEnvelope {
  exactKeys(envelope, ["schemaVersion", "request", "preview", "receipt"], [], "Team service preview");
  if (envelope.schemaVersion !== 1) fail("The Team service preview schemaVersion must be 1.");
  assertIdentityActivityCommand(envelope.request, expectedCommand);

  const preview = record(envelope.preview, "Team public preview");
  exactKeys(preview, ["valid", "scope", "changes", "localChanges", "diagnostics"], [], "Team public preview");
  if (preview.valid !== true) fail("Only a valid preview can be applied.");
  if (!(preview.scope === "canonical" || preview.scope === "local" || preview.scope === "mixed")) {
    fail("The Team public preview scope is invalid.");
  }
  if (!Array.isArray(preview.changes) || preview.changes.length > 16) fail("The Team preview changes are invalid.");
  for (const [index, change] of preview.changes.entries()) assertFileChange(change, index);
  if (!Array.isArray(preview.localChanges) || preview.localChanges.length > 16) fail("The Team preview localChanges are invalid.");
  for (const [index, change] of preview.localChanges.entries()) assertLocalChange(change, index);
  assertDiagnostics(preview.diagnostics);

  const receipt = record(envelope.receipt, "Team preview receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "authority",
    "purposeIds",
    "requestRevision",
    "presentationRevision",
    "previewRevision",
  ], [], "Team preview receipt");
  if (receipt.schemaVersion !== 1) fail("The Team preview receipt schemaVersion must be 1.");
  const authority = record(receipt.authority, "Team preview authority");
  exactKeys(authority, ["actor", "occurredAt", "repoState"], [], "Team preview authority");
  assertActor(authority.actor, "Team preview actor");
  isoTimestamp(authority.occurredAt, "Team preview occurredAt");
  assertRepoState(authority.repoState);
  if (!Array.isArray(receipt.purposeIds) || receipt.purposeIds.length > TEAM_IDENTITY_ACTIVITY_LIMITS.maxPurposeIds) {
    fail("The Team preview purposeIds are invalid.");
  }
  for (const [index, candidate] of receipt.purposeIds.entries()) {
    const purpose = record(candidate, `Team preview purpose ${index}`);
    exactKeys(purpose, ["purpose", "id"], [], `Team preview purpose ${index}`);
    if (!(purpose.purpose === "activity" || purpose.purpose === "member")) fail(`Team preview purpose ${index} is invalid.`);
    canonicalText(purpose.id, `Team preview purpose ${index} ID`, 256);
  }
  for (const key of ["requestRevision", "presentationRevision", "previewRevision"] as const) {
    if (typeof receipt[key] !== "string" || !isRevision(receipt[key])) fail(`Team preview receipt ${key} is invalid.`);
  }
}

function assertWorkstreamPreview(
  envelope: Record<string, unknown>,
  expectedCommand: TeamWorkstreamMutationCommandName,
): asserts envelope is Record<string, unknown> & TeamWorkstreamPreviewEnvelope {
  exactKeys(envelope, ["schemaVersion", "request", "preview", "receipt"], [], "Team service preview");
  if (envelope.schemaVersion !== 1) fail("The Team service preview schemaVersion must be 1.");
  assertWorkstreamCommand(envelope.request, expectedCommand);

  const preview = record(envelope.preview, "Team public preview");
  exactKeys(preview, ["valid", "scope", "changes", "localChanges", "diagnostics"], [], "Team public preview");
  if (preview.valid !== true || preview.scope !== "canonical") fail("The Workstream public preview is invalid.");
  if (!Array.isArray(preview.changes) || preview.changes.length > 16) fail("The Team preview changes are invalid.");
  for (const [index, change] of preview.changes.entries()) assertFileChange(change, index);
  if (!Array.isArray(preview.localChanges) || preview.localChanges.length !== 0) fail("Workstream previews must not contain local changes.");
  assertDiagnostics(preview.diagnostics);

  const receipt = record(envelope.receipt, "Team preview receipt");
  exactKeys(receipt, [
    "schemaVersion", "authority", "purposeIds", "requestRevision",
    "presentationRevision", "previewRevision",
  ], [], "Team preview receipt");
  if (receipt.schemaVersion !== 1) fail("The Team preview receipt schemaVersion must be 1.");
  const authority = record(receipt.authority, "Team preview authority");
  exactKeys(authority, ["actor", "occurredAt", "repoState"], [], "Team preview authority");
  assertActor(authority.actor, "Team preview actor");
  isoTimestamp(authority.occurredAt, "Team preview occurredAt");
  assertRepoState(authority.repoState);
  if (!Array.isArray(receipt.purposeIds) || receipt.purposeIds.length > TEAM_IDENTITY_ACTIVITY_LIMITS.maxPurposeIds) {
    fail("The Team preview purposeIds are invalid.");
  }
  for (const [index, candidate] of receipt.purposeIds.entries()) {
    const purpose = record(candidate, `Team preview purpose ${index}`);
    exactKeys(purpose, ["purpose", "id"], [], `Team preview purpose ${index}`);
    if (!(purpose.purpose === "activity" || purpose.purpose === "workstream")) fail(`Team preview purpose ${index} is invalid.`);
    canonicalText(purpose.id, `Team preview purpose ${index} ID`, 256);
  }
  for (const key of ["requestRevision", "presentationRevision", "previewRevision"] as const) {
    if (typeof receipt[key] !== "string" || !isRevision(receipt[key])) fail(`Team preview receipt ${key} is invalid.`);
  }
}

function assertFileChange(value: unknown, index: number): void {
  const change = record(value, `file change ${index}`);
  const common = ["kind", "path", "beforeRevision", "afterRevision", "diff"];
  if (change.kind === "move") exactKeys(change, [...common, "previousPath"], [], `file change ${index}`);
  else exactKeys(change, common, [], `file change ${index}`);
  if (!["create", "update", "delete", "move"].includes(change.kind as string)) fail(`file change ${index} kind is invalid.`);
  repoPath(change.path, `file change ${index} path`);
  if (change.kind === "move") repoPath(change.previousPath, `file change ${index} previousPath`);
  if (typeof change.diff !== "string") fail(`file change ${index} diff must be a string.`);
  if (change.beforeRevision !== null && (typeof change.beforeRevision !== "string" || !isRevision(change.beforeRevision))) fail(`file change ${index} beforeRevision is invalid.`);
  if (change.afterRevision !== null && (typeof change.afterRevision !== "string" || !isRevision(change.afterRevision))) fail(`file change ${index} afterRevision is invalid.`);
}

function assertLocalChange(value: unknown, index: number): void {
  const change = record(value, `local change ${index}`);
  exactKeys(change, ["namespace", "id", "beforeRevision", "afterRevision", "summary"], [], `local change ${index}`);
  if (!["inbox-draft", "relay-draft", "cursor", "member-selection"].includes(change.namespace as string)) fail(`local change ${index} namespace is invalid.`);
  canonicalText(change.id, `local change ${index} ID`, 256);
  canonicalText(change.summary, `local change ${index} summary`, 1_024);
  for (const key of ["beforeRevision", "afterRevision"] as const) {
    if (change[key] !== null && (typeof change[key] !== "string" || !isRevision(change[key]))) fail(`local change ${index} ${key} is invalid.`);
  }
}

function assertDiagnostics(value: unknown): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > 100) fail("Team diagnostics must contain at most 100 entries.");
  for (const [index, candidate] of value.entries()) {
    const diagnostic = record(candidate, `Team diagnostic ${index}`);
    exactKeys(diagnostic, ["code", "severity", "message"], ["path", "location", "entity", "remediation", "detail"], `Team diagnostic ${index}`);
    canonicalText(diagnostic.code, `Team diagnostic ${index} code`, 256);
    if (!["error", "warning", "info"].includes(diagnostic.severity as string)) fail(`Team diagnostic ${index} severity is invalid.`);
    canonicalText(diagnostic.message, `Team diagnostic ${index} message`, 4_096);
  }
}

function assertActor(value: unknown, label: string): void {
  const actor = record(value, label);
  if (actor.kind === "member") {
    exactKeys(actor, ["kind", "memberId"], ["displayName"], label);
    memberId(actor.memberId);
    if (actor.displayName !== undefined) canonicalText(actor.displayName, `${label} displayName`, 512);
  } else if (actor.kind === "git") {
    exactKeys(actor, ["kind", "name", "email"], [], label);
    if (actor.name !== null) canonicalText(actor.name, `${label} name`, 512);
    if (actor.email !== null) canonicalText(actor.email, `${label} email`, 512);
    if (actor.name === null && actor.email === null) {
      fail(`${label} Git identity must contain a name or email.`);
    }
  } else if (actor.kind === "unknown") {
    exactKeys(actor, ["kind"], [], label);
  } else {
    fail(`${label} kind is invalid.`);
  }
}

function assertRepoState(value: unknown): void {
  const state = record(value, "Team preview repository state");
  exactKeys(state, ["branch", "head", "dirty", "observedAt"], [], "Team preview repository state");
  if (state.branch !== null) canonicalText(state.branch, "repository branch", 1_024);
  if (state.head !== null && (typeof state.head !== "string" || !GIT_OBJECT_ID.test(state.head))) fail("repository HEAD is invalid.");
  if (typeof state.dirty !== "boolean") fail("repository dirty state is invalid.");
  isoTimestamp(state.observedAt, "repository observedAt");
}

function sameDiagnostics(left: readonly unknown[], right: readonly unknown[]): boolean {
  const normalize = (values: readonly unknown[]) => values
    .map((entry) => stableJson(entry))
    .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function assertBoundedJson(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      fail("The request JSON exceeds its structural bounds.");
    }
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) fail("The request JSON contains a non-finite number.");
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value !== "object" || Object.getPrototypeOf(current.value) !== Object.prototype) {
      fail("The request JSON contains an unsupported value.");
    }
    for (const child of Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function readDescriptorBounded(descriptor: number, maxBytes: number): Uint8Array {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, maxBytes + 1 - total));
    const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) fail(`The request file exceeds ${maxBytes} bytes.`);
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function memberId(value: unknown): string {
  if (typeof value !== "string" || !isArtifactId(value, "member")) {
    fail("member ID must be a member_ prefixed ULID.");
  }
  return value;
}

function workstreamId(value: unknown): string {
  if (typeof value !== "string" || !isArtifactId(value, "ws")) {
    fail("workstream ID must be a ws_ prefixed ULID.");
  }
  return value;
}

function isWorkstreamCommandName(
  value: TeamMutationCommandName,
): value is TeamWorkstreamMutationCommandName {
  return value === "workstream.create"
    || value === "workstream.update"
    || value === "workstream.archive";
}

function repoPath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !isRepoRelativePath(value)
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 4_096
  ) {
    fail(`${label} must be a canonical repository-relative path.`);
  }
  return value;
}

function canonicalText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    fail(`${label} must be a bounded canonical nonblank string.`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = canonicalText(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) fail(`${label} must be a canonical UTC ISO timestamp.`);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) fail(`${label} must be a canonical UTC ISO timestamp.`);
  return timestamp;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail(`${label} contains missing, unsupported, or extra fields.`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function fail(message: string): never {
  throw new TeamCliUsageError(message);
}

import { parseDocument } from "yaml";
import type {
  ActorRef,
  CodeRef,
  EntityRef,
  JsonValue,
  RepoRelativePath,
  RepoState,
} from "../contracts/shared.js";
import { isRepoRelativePath } from "../contracts/shared.js";
import {
  TEAM_READ_LIMITS,
  type ActivityEvent,
  type ActivityRecordOrigin,
  type ActivitySubjectRef,
  type MemberGitAlias,
  type StoredActivityEvent,
  type TeamMember,
} from "../contracts/workflow.js";
import { artifactError } from "./errors.js";
import { revisionOf } from "./revision.js";
import { isArtifactId } from "./ulid.js";

export const MEMBER_ARTIFACT_MAX_BYTES = 64 * 1024;
export const ACTIVITY_ARTIFACT_MAX_BYTES = 64 * 1024;
export const MEMBER_GIT_ALIAS_LIMIT = 32;
export const ACTIVITY_SUBJECT_LIMIT = 64;
export const ACTIVITY_LABEL_MAX_BYTES = 512;

const MEMBER_KEYS = [
  "schema_version",
  "id",
  "display_name",
  "git_aliases",
  "active",
] as const;

const ACTIVITY_REQUIRED_KEYS = [
  "schema_version",
  "id",
  "timestamp",
  "actor",
  "action",
  "subjects",
  "repo_state",
] as const;
const ACTIVITY_V2_REQUIRED_KEYS = [...ACTIVITY_REQUIRED_KEYS, "origin"] as const;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTION = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FORBIDDEN_METADATA_KEY_FRAGMENTS = [
  "apikey",
  "apikeys",
  "credential",
  "credentials",
  "chainofthought",
  "diff",
  "diffs",
  "password",
  "passwords",
  "patch",
  "patches",
  "privatekey",
  "privatekeys",
  "prompt",
  "prompts",
  "reasoningtrace",
  "secret",
  "secrets",
  "sourcedump",
  "sourcecode",
  "token",
  "tokens",
  "transcript",
  "transcripts",
] as const;

export interface MemberArtifactInput {
  id: string;
  displayName: string;
  gitAliases: readonly MemberGitAlias[];
  active: boolean;
}

export function memberArtifactPath(id: string): RepoRelativePath {
  assertArtifactId(id, "member", "member ID");
  return `.mex/team/members/${id}.md` as RepoRelativePath;
}

export function activityArtifactPath(event: Pick<ActivityEvent, "id" | "timestamp">): RepoRelativePath {
  assertArtifactId(event.id, "event", "activity event ID");
  assertIsoTimestamp(event.timestamp, "activity timestamp");
  return `.mex/events/activity/${event.timestamp.slice(0, 7)}/${event.id}.md` as RepoRelativePath;
}

export function serializeMemberArtifact(input: MemberArtifactInput): string {
  const member = validateMemberInput(input);
  const document = encodeFrontmatter([
    ["schema_version", 1],
    ["id", member.id],
    ["display_name", member.displayName],
    ["git_aliases", member.gitAliases],
    ["active", member.active],
  ]);
  assertSerializedSize(document, MEMBER_ARTIFACT_MAX_BYTES, "Member artifact");
  return document;
}

export function parseMemberArtifact(
  bytes: string | Uint8Array,
  sourcePath: RepoRelativePath,
): TeamMember {
  assertRepoPath(sourcePath, "member source path");
  const exactBytes = asBytes(bytes);
  const raw = parseCanonicalFrontmatter(exactBytes, sourcePath, MEMBER_ARTIFACT_MAX_BYTES);
  assertExactKeys(raw, MEMBER_KEYS, [], "member artifact", sourcePath);
  if (raw.schema_version !== 1) fail("Member schema_version must be 1.", sourcePath);
  if (typeof raw.id !== "string") fail("Member id must be a string.", sourcePath);
  if (typeof raw.display_name !== "string") fail("Member display_name must be a string.", sourcePath);
  if (!Array.isArray(raw.git_aliases)) fail("Member git_aliases must be an array.", sourcePath);
  if (typeof raw.active !== "boolean") fail("Member active must be a boolean.", sourcePath);

  const input: MemberArtifactInput = {
    id: raw.id,
    displayName: raw.display_name,
    gitAliases: raw.git_aliases.map((alias, index) => parseAlias(alias, index, sourcePath)),
    active: raw.active,
  };
  const normalized = validateMemberInput(input);
  const expectedPath = memberArtifactPath(normalized.id);
  if (sourcePath !== expectedPath) {
    fail(`Member path must be ${expectedPath}.`, sourcePath);
  }
  assertCanonicalBytes(exactBytes, serializeMemberArtifact(normalized), sourcePath);

  return {
    schemaVersion: 1,
    ref: { id: normalized.id, kind: "member", title: normalized.displayName },
    kind: "member",
    sourcePath,
    revision: revisionOf(exactBytes),
    displayName: normalized.displayName,
    gitAliases: normalized.gitAliases,
    active: normalized.active,
  };
}

export function serializeActivityArtifact(event: ActivityEvent): string {
  const normalized = validateActivityEvent(event);
  const document = encodeFrontmatter([
    ["schema_version", normalized.schemaVersion],
    ["id", normalized.id],
    ["timestamp", normalized.timestamp],
    ["actor", normalized.actor],
    ["action", normalized.action],
    ...(normalized.schemaVersion === 1
      ? []
      : [["origin", normalized.origin] as const]),
    ...(normalized.schemaVersion === 2 && normalized.label !== undefined
      ? [["label", normalized.label] as const]
      : []),
    ["subjects", normalized.subjects],
    ...(normalized.workstream === undefined
      ? []
      : [["workstream", normalized.workstream] as const]),
    ["repo_state", normalized.repoState],
    ...(normalized.metadata === undefined
      ? []
      : [["metadata", normalized.metadata] as const]),
  ]);
  assertSerializedSize(document, ACTIVITY_ARTIFACT_MAX_BYTES, "Activity artifact");
  return document;
}

export function parseActivityArtifact(
  bytes: string | Uint8Array,
  sourcePath: RepoRelativePath,
): StoredActivityEvent {
  assertRepoPath(sourcePath, "activity source path");
  const exactBytes = asBytes(bytes);
  const raw = parseCanonicalFrontmatter(exactBytes, sourcePath, ACTIVITY_ARTIFACT_MAX_BYTES);
  if (raw.schema_version !== 1 && raw.schema_version !== 2) {
    fail("Activity schema_version must be 1 or 2.", sourcePath);
  }
  assertExactKeys(
    raw,
    raw.schema_version === 1 ? ACTIVITY_REQUIRED_KEYS : ACTIVITY_V2_REQUIRED_KEYS,
    raw.schema_version === 1
      ? ["workstream", "metadata"]
      : ["workstream", "metadata", "label"],
    "activity artifact",
    sourcePath,
  );
  if (typeof raw.id !== "string") fail("Activity id must be a string.", sourcePath);
  if (typeof raw.timestamp !== "string") fail("Activity timestamp must be a string.", sourcePath);
  if (typeof raw.action !== "string") fail("Activity action must be a string.", sourcePath);
  if (!Array.isArray(raw.subjects)) fail("Activity subjects must be an array.", sourcePath);

  const common = {
    id: raw.id,
    timestamp: raw.timestamp,
    actor: parseActor(raw.actor, sourcePath),
    action: raw.action,
    subjects: raw.subjects.map((subject, index) => parseSubject(subject, index, sourcePath)),
    ...(Object.hasOwn(raw, "workstream")
      ? { workstream: parseEntityRef(raw.workstream, "workstream", sourcePath) }
      : {}),
    repoState: parseRepoState(raw.repo_state, sourcePath),
    ...(Object.hasOwn(raw, "metadata")
      ? { metadata: parseMetadata(raw.metadata, sourcePath) }
      : {}),
  };
  const event: ActivityEvent = raw.schema_version === 1
    ? { schemaVersion: 1, ...common }
    : {
        schemaVersion: 2,
        ...common,
        origin: parseActivityOrigin(raw.origin, sourcePath),
        ...(Object.hasOwn(raw, "label")
          ? { label: parseActivityLabel(raw.label, sourcePath) }
          : {}),
      };
  const normalized = validateActivityEvent(event);
  const expectedPath = activityArtifactPath(normalized);
  if (sourcePath !== expectedPath) {
    fail(`Activity path must be ${expectedPath}.`, sourcePath);
  }
  assertCanonicalBytes(exactBytes, serializeActivityArtifact(normalized), sourcePath);

  return {
    ...normalized,
    sourcePath,
    revision: revisionOf(exactBytes),
  };
}

function validateMemberInput(input: MemberArtifactInput): MemberArtifactInput {
  assertArtifactId(input.id, "member", "member ID");
  const displayName = assertCanonicalText(input.displayName, "member display name", 200);
  if (!Array.isArray(input.gitAliases) || input.gitAliases.length > MEMBER_GIT_ALIAS_LIMIT) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid member",
      `Member git aliases must contain at most ${MEMBER_GIT_ALIAS_LIMIT} entries.`,
    );
  }

  const aliases = input.gitAliases.map((alias, index) => validateAlias(alias, index));
  const seen = new Set<string>();
  for (const alias of aliases) {
    const key = aliasKey(alias);
    if (seen.has(key)) {
      throw artifactError("VALIDATION_FAILED", "Invalid member", "Member Git aliases must be unique.");
    }
    seen.add(key);
  }
  aliases.sort((left, right) => compareCodePoints(aliasKey(left), aliasKey(right)));

  if (typeof input.active !== "boolean") {
    throw artifactError("VALIDATION_FAILED", "Invalid member", "Member active must be a boolean.");
  }
  return { id: input.id, displayName, gitAliases: aliases, active: input.active };
}

function validateActivityEvent(event: ActivityEvent): ActivityEvent {
  if (event.schemaVersion !== 1 && event.schemaVersion !== 2) {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity schemaVersion must be 1 or 2.");
  }
  assertArtifactId(event.id, "event", "activity event ID");
  assertIsoTimestamp(event.timestamp, "activity timestamp");
  const actor = validateActor(event.actor);
  const action = assertCanonicalText(event.action, "activity action", 128);
  if (!ACTION.test(action)) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid activity event",
      "Activity action must be a lower-case namespaced identifier.",
    );
  }
  if (!Array.isArray(event.subjects) || event.subjects.length > ACTIVITY_SUBJECT_LIMIT) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid activity event",
      `Activity subjects must contain at most ${ACTIVITY_SUBJECT_LIMIT} entries.`,
    );
  }
  const subjects = event.subjects.map(validateSubject);
  const workstream = event.workstream === undefined
    ? undefined
    : validateEntityRef(event.workstream, "activity workstream");
  if (workstream !== undefined && workstream.kind !== "workstream") {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid activity event",
      "Activity workstream references must have kind workstream.",
    );
  }
  const repoState = validateRepoState(event.repoState);
  const metadata = event.metadata === undefined ? undefined : validateMetadata(event.metadata);
  const common = {
    id: event.id,
    timestamp: event.timestamp,
    actor,
    action,
    subjects,
    ...(workstream === undefined ? {} : { workstream }),
    repoState,
    ...(metadata === undefined ? {} : { metadata }),
  };
  if (event.schemaVersion === 1) {
    if (Object.hasOwn(event, "origin") || Object.hasOwn(event, "label")) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid activity event",
        "Activity schemaVersion 1 cannot contain provenance fields.",
      );
    }
    return { schemaVersion: 1, ...common };
  }
  return {
    schemaVersion: 2,
    ...common,
    origin: validateActivityOrigin(event.origin),
    ...(event.label === undefined
      ? {}
      : { label: validateActivityLabel(event.label) }),
  };
}

function validateActivityOrigin(value: unknown): ActivityRecordOrigin {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity origin is invalid.");
  }
  if (value.kind === "custom") {
    assertObjectKeys(value, ["kind"], "activity custom origin");
    return { kind: "custom" };
  }
  if (value.kind === "workflow") {
    assertObjectKeys(value, ["kind", "operation"], "activity workflow origin");
    const operation = assertCanonicalText(value.operation, "activity workflow operation", 128);
    if (!ACTION.test(operation)) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid activity event",
        "Activity workflow operation must be a lower-case namespaced identifier.",
      );
    }
    return { kind: "workflow", operation };
  }
  throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity origin kind is invalid.");
}

function parseActivityOrigin(
  value: unknown,
  path: RepoRelativePath,
): Extract<ActivityEvent, { schemaVersion: 2 }>["origin"] {
  try {
    return validateActivityOrigin(value);
  } catch {
    fail("Activity origin is invalid.", path);
  }
}

function parseActivityLabel(value: unknown, path: RepoRelativePath): string {
  try {
    return validateActivityLabel(value);
  } catch {
    fail("Activity label is invalid.", path);
  }
}

function validateActivityLabel(value: unknown): string {
  const label = assertCanonicalText(value, "activity label", ACTIVITY_LABEL_MAX_BYTES);
  if (/[\u0080-\u009f\u2028\u2029]/u.test(label)) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid activity event",
      "Activity label must be canonical single-line text.",
    );
  }
  return label;
}

function validateAlias(alias: MemberGitAlias, index: number): MemberGitAlias {
  if (!isRecord(alias)) {
    throw artifactError("VALIDATION_FAILED", "Invalid member", `Git alias ${index} must be an object.`);
  }
  assertObjectKeys(alias, ["name", "email"], `Git alias ${index}`);
  const name = alias.name === null ? null : assertCanonicalText(alias.name, `Git alias ${index} name`, 200);
  const email = alias.email === null ? null : assertCanonicalText(alias.email, `Git alias ${index} email`, 320);
  if (name === null && email === null) {
    throw artifactError("VALIDATION_FAILED", "Invalid member", `Git alias ${index} must contain a name or email.`);
  }
  if (email !== null && (!email.includes("@") || /\s/.test(email))) {
    throw artifactError("VALIDATION_FAILED", "Invalid member", `Git alias ${index} email is invalid.`);
  }
  return { name, email };
}

function parseAlias(value: unknown, index: number, path: RepoRelativePath): MemberGitAlias {
  if (!isRecord(value)) fail(`Git alias ${index} must be an object.`, path);
  assertExactKeys(value, ["email", "name"], [], `Git alias ${index}`, path);
  if (value.name !== null && typeof value.name !== "string") fail(`Git alias ${index} name is invalid.`, path);
  if (value.email !== null && typeof value.email !== "string") fail(`Git alias ${index} email is invalid.`, path);
  return validateAlias({ name: value.name, email: value.email }, index);
}

function validateActor(actor: ActorRef): ActorRef {
  if (!isRecord(actor) || typeof actor.kind !== "string") {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity actor is invalid.");
  }
  if (actor.kind === "member") {
    assertObjectKeys(actor, ["kind", "memberId", "displayName"], "member actor", ["displayName"]);
    assertArtifactId(actor.memberId, "member", "actor member ID");
    return {
      kind: "member",
      memberId: actor.memberId,
      ...(actor.displayName === undefined
        ? {}
        : { displayName: assertCanonicalText(actor.displayName, "actor display name", 200) }),
    };
  }
  if (actor.kind === "git") {
    assertObjectKeys(actor, ["kind", "name", "email"], "Git actor");
    const name = actor.name === null ? null : assertCanonicalText(actor.name, "Git actor name", 200);
    const email = actor.email === null ? null : assertCanonicalText(actor.email, "Git actor email", 320);
    if (name === null && email === null) {
      throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Git actor must contain a name or email.");
    }
    return { kind: "git", name, email };
  }
  if (actor.kind === "unknown") {
    assertObjectKeys(actor, ["kind"], "unknown actor");
    return { kind: "unknown" };
  }
  throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity actor kind is invalid.");
}

function parseActor(value: unknown, path: RepoRelativePath): ActorRef {
  if (!isRecord(value) || typeof value.kind !== "string") fail("Activity actor is invalid.", path);
  try {
    if (value.kind === "member") {
      assertExactKeys(value, ["kind", "memberId"], ["displayName"], "member actor", path);
      if (typeof value.memberId !== "string") fail("Member actor memberId is invalid.", path);
      if (value.displayName !== undefined && typeof value.displayName !== "string") {
        fail("Member actor displayName is invalid.", path);
      }
      return validateActor({
        kind: "member",
        memberId: value.memberId,
        ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
      });
    }
    if (value.kind === "git") {
      assertExactKeys(value, ["kind", "name", "email"], [], "Git actor", path);
      if (value.name !== null && typeof value.name !== "string") fail("Git actor name is invalid.", path);
      if (value.email !== null && typeof value.email !== "string") fail("Git actor email is invalid.", path);
      return validateActor({ kind: "git", name: value.name, email: value.email });
    }
    if (value.kind === "unknown") {
      assertExactKeys(value, ["kind"], [], "unknown actor", path);
      return { kind: "unknown" };
    }
  } catch (error) {
    if (error instanceof Error) throw error;
  }
  fail("Activity actor kind is invalid.", path);
}

function validateSubject(subject: ActivitySubjectRef): ActivitySubjectRef {
  if (!isRecord(subject) || typeof subject.kind !== "string") {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity subject is invalid.");
  }
  if (subject.kind === "entity") {
    assertObjectKeys(subject, ["kind", "entity"], "entity subject");
    return { kind: "entity", entity: validateEntityRef(subject.entity, "entity subject") };
  }
  if (subject.kind === "code") {
    assertObjectKeys(subject, ["kind", "code"], "code subject");
    return { kind: "code", code: validateCodeRef(subject.code) };
  }
  if (subject.kind === "file") {
    assertObjectKeys(subject, ["kind", "path"], "file subject");
    assertRepoPath(subject.path, "activity file subject");
    return { kind: "file", path: subject.path };
  }
  if (subject.kind === "commit") {
    assertObjectKeys(subject, ["kind", "hash"], "commit subject");
    if (!GIT_OBJECT_ID.test(subject.hash)) {
      throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Commit subject hash is invalid.");
    }
    return { kind: "commit", hash: subject.hash };
  }
  throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity subject kind is invalid.");
}

function parseSubject(value: unknown, index: number, path: RepoRelativePath): ActivitySubjectRef {
  if (!isRecord(value) || typeof value.kind !== "string") fail(`Activity subject ${index} is invalid.`, path);
  if (value.kind === "entity") {
    assertExactKeys(value, ["kind", "entity"], [], `Activity subject ${index}`, path);
    return validateSubject({ kind: "entity", entity: parseEntityRef(value.entity, "subject entity", path) });
  }
  if (value.kind === "code") {
    assertExactKeys(value, ["kind", "code"], [], `Activity subject ${index}`, path);
    return validateSubject({ kind: "code", code: parseCodeRef(value.code, path) });
  }
  if (value.kind === "file") {
    assertExactKeys(value, ["kind", "path"], [], `Activity subject ${index}`, path);
    if (typeof value.path !== "string") fail(`Activity subject ${index} path is invalid.`, path);
    return validateSubject({ kind: "file", path: value.path });
  }
  if (value.kind === "commit") {
    assertExactKeys(value, ["kind", "hash"], [], `Activity subject ${index}`, path);
    if (typeof value.hash !== "string") fail(`Activity subject ${index} hash is invalid.`, path);
    return validateSubject({ kind: "commit", hash: value.hash });
  }
  fail(`Activity subject ${index} kind is invalid.`, path);
}

function validateCodeRef(code: CodeRef): CodeRef {
  if (!isRecord(code) || typeof code.kind !== "string") {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity code reference is invalid.");
  }
  if (code.kind === "symbol") {
    assertObjectKeys(code, ["kind", "symbolId", "fingerprint"], "symbol reference", ["fingerprint"]);
    const symbolId = assertCanonicalText(code.symbolId, "symbol ID", 512);
    return {
      kind: "symbol",
      symbolId,
      ...(code.fingerprint === undefined
        ? {}
        : { fingerprint: assertCanonicalText(code.fingerprint, "symbol fingerprint", 512) }),
    };
  }
  if (code.kind === "file") {
    assertObjectKeys(code, ["kind", "path", "fingerprint"], "file code reference", ["fingerprint"]);
    assertRepoPath(code.path, "code file path");
    return {
      kind: "file",
      path: code.path,
      ...(code.fingerprint === undefined
        ? {}
        : { fingerprint: assertCanonicalText(code.fingerprint, "file fingerprint", 512) }),
    };
  }
  throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity code reference kind is invalid.");
}

function parseCodeRef(value: unknown, path: RepoRelativePath): CodeRef {
  if (!isRecord(value) || typeof value.kind !== "string") fail("Activity code reference is invalid.", path);
  if (value.kind === "symbol") {
    assertExactKeys(value, ["kind", "symbolId"], ["fingerprint"], "symbol reference", path);
    if (typeof value.symbolId !== "string") fail("Symbol reference symbolId is invalid.", path);
    if (value.fingerprint !== undefined && typeof value.fingerprint !== "string") fail("Symbol fingerprint is invalid.", path);
    return validateCodeRef({
      kind: "symbol",
      symbolId: value.symbolId,
      ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
    });
  }
  if (value.kind === "file") {
    assertExactKeys(value, ["kind", "path"], ["fingerprint"], "file code reference", path);
    if (typeof value.path !== "string") fail("File code reference path is invalid.", path);
    if (value.fingerprint !== undefined && typeof value.fingerprint !== "string") fail("File fingerprint is invalid.", path);
    return validateCodeRef({
      kind: "file",
      path: value.path,
      ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
    });
  }
  fail("Activity code reference kind is invalid.", path);
}

function validateEntityRef(value: EntityRef, label: string): EntityRef {
  if (!isRecord(value)) {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", `${label} must be an object.`);
  }
  assertObjectKeys(value, ["id", "kind", "title"], label, ["title"]);
  const id = assertCanonicalText(value.id, `${label} id`, 256);
  const kind = assertCanonicalText(value.kind, `${label} kind`, 64);
  return {
    id,
    kind,
    ...(value.title === undefined
      ? {}
      : { title: assertCanonicalText(value.title, `${label} title`, 256) }),
  };
}

function parseEntityRef(value: unknown, label: string, path: RepoRelativePath): EntityRef {
  if (!isRecord(value)) fail(`${label} must be an object.`, path);
  assertExactKeys(value, ["id", "kind"], ["title"], label, path);
  if (typeof value.id !== "string" || typeof value.kind !== "string") fail(`${label} is invalid.`, path);
  if (value.title !== undefined && typeof value.title !== "string") fail(`${label} title is invalid.`, path);
  return validateEntityRef({
    id: value.id,
    kind: value.kind,
    ...(value.title === undefined ? {} : { title: value.title }),
  }, label);
}

function validateRepoState(value: RepoState): RepoState {
  if (!isRecord(value)) {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity repo state is invalid.");
  }
  assertObjectKeys(value, ["branch", "head", "dirty", "observedAt"], "repository state");
  const branch = value.branch === null ? null : assertCanonicalText(value.branch, "repository branch", 1024);
  if (value.head !== null && !GIT_OBJECT_ID.test(value.head)) {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Repository HEAD is invalid.");
  }
  if (typeof value.dirty !== "boolean") {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Repository dirty state must be boolean.");
  }
  assertIsoTimestamp(value.observedAt, "repository observation timestamp");
  return { branch, head: value.head, dirty: value.dirty, observedAt: value.observedAt };
}

function parseRepoState(value: unknown, path: RepoRelativePath): RepoState {
  if (!isRecord(value)) fail("Activity repo_state is invalid.", path);
  assertExactKeys(value, ["branch", "head", "dirty", "observedAt"], [], "repo_state", path);
  if (value.branch !== null && typeof value.branch !== "string") fail("Repository branch is invalid.", path);
  if (value.head !== null && typeof value.head !== "string") fail("Repository HEAD is invalid.", path);
  if (typeof value.dirty !== "boolean" || typeof value.observedAt !== "string") fail("Repository state is invalid.", path);
  return validateRepoState({
    branch: value.branch,
    head: value.head,
    dirty: value.dirty,
    observedAt: value.observedAt,
  });
}

function validateMetadata(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value)) {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity metadata must be an object.");
  }
  let entryCount = 0;
  const normalized = validateJsonValue(value, 0, (key) => {
    entryCount += 1;
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_METADATA_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid activity event",
        `Activity metadata must not contain ${key}.`,
      );
    }
  }) as Readonly<Record<string, JsonValue>>;
  if (entryCount > TEAM_READ_LIMITS.maxActivityMetadataEntries) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid activity event",
      `Activity metadata exceeds ${TEAM_READ_LIMITS.maxActivityMetadataEntries} entries.`,
    );
  }
  if (Buffer.byteLength(stableJson(normalized), "utf8") > TEAM_READ_LIMITS.maxActivityMetadataBytes) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid activity event",
      `Activity metadata exceeds ${TEAM_READ_LIMITS.maxActivityMetadataBytes} bytes.`,
    );
  }
  return normalized;
}

function parseMetadata(value: unknown, path: RepoRelativePath): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value)) fail("Activity metadata must be an object.", path);
  return validateMetadata(value as Record<string, JsonValue>);
}

function validateJsonValue(
  value: unknown,
  depth: number,
  observeKey: (key: string) => void,
): JsonValue {
  if (depth > 8) {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity metadata nesting is too deep.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 4 * 1024) {
      throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity metadata string is too large.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity metadata numbers must be finite.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) {
      throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity metadata arrays are too large.");
    }
    return value.map((item) => validateJsonValue(item, depth + 1, observeKey));
  }
  if (!isRecord(value) || !isPlainRecord(value)) {
    throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity metadata contains an unsupported value.");
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    assertCanonicalText(key, "activity metadata key", 128);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid activity event",
        `Activity metadata must not contain ${key}.`,
      );
    }
    observeKey(key);
    Object.defineProperty(result, key, {
      value: validateJsonValue(value[key], depth + 1, observeKey),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function parseCanonicalFrontmatter(
  bytes: Uint8Array,
  path: RepoRelativePath,
  maxBytes: number,
): Record<string, unknown> {
  if (bytes.byteLength > maxBytes) fail(`Artifact exceeds ${maxBytes} bytes.`, path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Artifact must be valid UTF-8.", path);
  }
  if (text.includes("\r")) fail("Artifact must use LF line endings.", path);
  if (!text.startsWith("---\n") || !text.endsWith("---\n")) {
    fail("Artifact must contain frontmatter only and end with a newline.", path);
  }
  const yaml = text.slice(4, -4);
  if (yaml.includes("\n---\n")) fail("Artifact must not contain a Markdown body.", path);

  try {
    const document = parseDocument(yaml, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) fail(`Invalid YAML: ${document.errors[0]!.message}`, path);
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(value)) fail("Artifact frontmatter must be a mapping.", path);
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "MexPortError") throw error;
    fail(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`, path);
  }
}

function encodeFrontmatter(entries: readonly (readonly [string, unknown])[]): string {
  return `---\n${entries.map(([key, value]) => `${key}: ${stableJson(value)}`).join("\n")}\n---\n`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    Object.defineProperty(result, key, {
      value: sortJson(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function assertCanonicalBytes(bytes: Uint8Array, canonical: string, path: RepoRelativePath): void {
  if (!Buffer.from(bytes).equals(Buffer.from(canonical, "utf8"))) {
    fail("Artifact bytes are valid but not in canonical deterministic form.", path);
  }
}

function assertSerializedSize(document: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(document, "utf8") > maxBytes) {
    throw artifactError(
      "VALIDATION_FAILED",
      `${label} is too large`,
      `${label} exceeds ${maxBytes} bytes.`,
    );
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  path: RepoRelativePath,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = keys.filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    fail(`${label} has invalid fields (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`, path);
  }
}

function assertObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
  optionalKeys: readonly string[] = [],
): void {
  const allowed = new Set(allowedKeys);
  const required = allowedKeys.filter((key) => !optionalKeys.includes(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid canonical artifact",
      `${label} has invalid fields (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`,
    );
  }
}

function assertArtifactId(value: string, prefix: "member" | "event", label: string): void {
  if (!isArtifactId(value, prefix)) {
    throw artifactError("VALIDATION_FAILED", "Invalid canonical artifact", `${label} must be a ${prefix}_ prefixed ULID.`);
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!ISO_UTC.test(value)) {
    throw artifactError("VALIDATION_FAILED", "Invalid canonical artifact", `${label} must be an exact UTC ISO-8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw artifactError("VALIDATION_FAILED", "Invalid canonical artifact", `${label} is not a real UTC timestamp.`);
  }
}

function assertCanonicalText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw artifactError("VALIDATION_FAILED", "Invalid canonical artifact", `${label} must be a nonblank trimmed string.`);
  }
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw artifactError("VALIDATION_FAILED", "Invalid canonical artifact", `${label} contains non-canonical or control characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw artifactError("VALIDATION_FAILED", "Invalid canonical artifact", `${label} exceeds ${maxBytes} bytes.`);
  }
  return value;
}

function assertRepoPath(value: string, label: string): asserts value is RepoRelativePath {
  if (
    !isRepoRelativePath(value)
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.normalize("NFC") !== value
    || Buffer.byteLength(value, "utf8") > 4096
  ) {
    throw artifactError("PATH_OUTSIDE_PROJECT", "Unsafe repository path", `${label} must be a canonical repository-relative path.`);
  }
}

function aliasKey(alias: MemberGitAlias): string {
  return `${alias.email?.trim().toLowerCase() ?? ""}\0${alias.name?.normalize("NFC") ?? ""}`;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(detail: string, path: RepoRelativePath): never {
  throw artifactError("VALIDATION_FAILED", "Invalid canonical artifact", detail, path);
}

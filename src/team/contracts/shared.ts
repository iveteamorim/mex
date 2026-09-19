/**
 * Shared application-layer contracts for the local human-team memory program.
 *
 * These types intentionally describe references, revisions, failures, and file
 * changes without encoding the teammate-owned Wiki entity or operation schema.
 */

export const TEAM_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const GROUNDING_HEALTH = [
  "fresh",
  "changed",
  "missing",
  "ambiguous",
  "unverified",
] as const;

export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
] as const;

export const MEX_ERROR_CODES = [
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "REVISION_CONFLICT",
  "INDEX_MISSING",
  "INDEX_STALE",
  "INDEX_CORRUPT",
  "MIGRATION_REQUIRED",
  "PATH_OUTSIDE_PROJECT",
  "JOB_ALREADY_RUNNING",
  "JOB_FAILED",
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "ORIGIN_REJECTED",
  "OPERATION_INTERRUPTED",
  "INTERNAL_ERROR",
] as const;

export type MexErrorCode = (typeof MEX_ERROR_CODES)[number];

/** Lower-case SHA-256 of the canonical file bytes. */
export type Revision = string;
export type IsoTimestamp = string;
export type RepoRelativePath = string;
export type EntityId = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface EntityVersion {
  /** Canonical entity revision from the Wiki model. */
  semanticRevision: number;
  /** SHA-256 of the exact containing canonical file bytes. */
  contentHash: Revision;
}

export interface EntityRef {
  id: EntityId;
  kind: string;
  title?: string;
}

export type CodeRef =
  | {
      kind: "symbol";
      symbolId: string;
      fingerprint?: string;
    }
  | {
      kind: "file";
      path: RepoRelativePath;
      fingerprint?: string;
    };

export type ActorRef =
  | {
      kind: "member";
      memberId: string;
      displayName?: string;
    }
  | {
      kind: "git";
      name: string | null;
      email: string | null;
    }
  | {
      kind: "unknown";
    };

export interface RepoState {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  observedAt: IsoTimestamp;
}

export type GroundingHealth = (typeof GROUNDING_HEALTH)[number];

/** Entity-specific durable state. It must never be inferred from grounding. */
export type LifecycleState<TState extends string = string> = TState;

export type JobState = (typeof JOB_STATES)[number];

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface SourceLocation {
  path: RepoRelativePath;
  startLine?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;
  headingDepth?: number;
}

export interface RecoveryAction {
  label: string;
  command?: string;
  route?: string;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: RepoRelativePath;
  location?: SourceLocation;
  entity?: EntityRef;
  remediation?: readonly RecoveryAction[];
  detail?: Readonly<Record<string, JsonValue>>;
}

/** RFC 9457-compatible problem body with a stable MEX machine code. */
export interface ProblemDetails {
  type?: string;
  title: string;
  status: number;
  code: MexErrorCode;
  detail: string;
  instance?: string;
  diagnostics?: readonly Diagnostic[];
  recovery?: readonly RecoveryAction[];
}

export class MexPortError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = "MexPortError";
    this.problem = problem;
  }
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
}

export type RevisionTarget =
  | {
      kind: "entity";
      id: EntityId;
    }
  | {
      kind: "artifact";
      path: RepoRelativePath;
    }
  | {
      kind: "local";
      namespace: "inbox-draft" | "relay-draft" | "cursor" | "job" | "member-selection";
      id: string;
    };

export interface RevisionExpectation {
  target: RevisionTarget;
  /** `null` means the target must not exist yet. */
  revision: Revision | null;
  /** Required when the target is an existing Wiki entity. */
  semanticRevision?: number | null;
}

interface FileChangeBase {
  path: RepoRelativePath;
  /** Exact unified diff over canonical UTF-8/LF bytes. */
  diff: string;
}

/** Exact canonical-file change with revision nullability fixed by operation kind. */
export type FileChange =
  | (FileChangeBase & {
      kind: "create";
      previousPath?: never;
      beforeRevision: null;
      afterRevision: Revision;
    })
  | (FileChangeBase & {
      kind: "update";
      previousPath?: never;
      beforeRevision: Revision;
      afterRevision: Revision;
    })
  | (FileChangeBase & {
      kind: "delete";
      previousPath?: never;
      beforeRevision: Revision;
      afterRevision: null;
    })
  | (FileChangeBase & {
      kind: "move";
      previousPath: RepoRelativePath;
      beforeRevision: Revision;
      afterRevision: Revision;
    });

export interface IndexJobResult {
  state: "succeeded";
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp;
  diagnostics: readonly Diagnostic[];
}

export interface IndexProgress {
  phase: string;
  completed?: number;
  total?: number;
  message: string;
}

export interface OperationContext {
  signal?: AbortSignal;
  reportProgress?: (progress: IndexProgress) => void;
}

export function isRevision(value: string): value is Revision {
  return /^[a-f0-9]{64}$/.test(value);
}

/** Validate canonical POSIX repository-relative paths before filesystem use. */
export function isRepoRelativePath(value: string): value is RepoRelativePath {
  if (!value || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

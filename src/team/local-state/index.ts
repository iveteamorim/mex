import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  HUB_JOB_INTERRUPTION_REASONS,
  HUB_JOB_KINDS,
  HUB_JOB_PHASES,
  HUB_JOB_PROGRESS_PHASES,
} from "../../hub/jobs/types.js";
import type {
  HubJobInterruptionReason,
  HubJobKind,
  HubJobListRequest,
  HubJobPage,
  HubJobPhase,
  HubJobProblem,
  HubJobProgress,
  HubJobSnapshot,
} from "../../hub/jobs/types.js";
import type {
  ActorRef,
  CodeRef,
  EntityRef,
  JsonValue,
  RepoRelativePath,
  RepoState,
  Revision,
} from "../contracts/shared.js";
import { isRevision, JOB_STATES, MexPortError } from "../contracts/shared.js";
import {
  WIKI_OPERATION_TYPES,
  type WikiOperationRecoveryManifest,
} from "../contracts/wiki.js";
import type {
  ActivityRecordOrigin,
  ActivitySubjectRef,
  CatchUpCursor,
} from "../contracts/workflow.js";
import { ACTIVITY_SUBJECT_LIMIT } from "../artifacts/codecs.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof import("node:sqlite").DatabaseSync;
};
type DatabaseSync = NodeDatabaseSync;

const LOCAL_STATE_SCHEMA_VERSION = 4 as const;
const LOCAL_STATE_RECORD_REVISION_VERSION = 1 as const;
const LOCAL_STATE_RELATIVE_PATH = ".mex/local/team.db";
const MEMBER_ID = /^member_[0-9A-HJKMNP-TV-Z]{26}$/;
const HUB_JOB_ID = /^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LOCAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_NAMESPACE = /^[a-z][a-z0-9-]{0,63}$/;
const JOURNAL_ENTITY_KIND_EXCEPTIONS = new Set(["acceptance_criterion"]);
const MAX_JOB_PROBLEM_JSON_BYTES = 4_096;
const DEFAULT_JOB_PAGE_SIZE = 25;
const MAX_JOB_PAGE_SIZE = 100;
const TERMINAL_JOB_RETENTION = 200;
const HUB_LEASE_TOKEN = /^[a-f0-9]{64}$/;
const LOCAL_DRAFT_CURSOR_VERSION = 1 as const;

export const TEAM_LOCAL_STATE_LIMITS = {
  maxDraftBytes: 64 * 1024,
  maxDraftsPerKindPerScaffold: 512,
  defaultDraftPageSize: 50,
  maxDraftPageSize: 100,
  maxCursorBytes: 4 * 1024,
  maxWorkflowEffects: 16,
  maxWorkflowEffectBytes: 64 * 1024,
  terminalWorkflowRetention: 256,
} as const;

export const TEAM_WORKFLOW_JOURNAL_PHASES = [
  "intent",
  "canonical_published",
  "local_finalized",
  "complete",
] as const;

export type TeamLocalDraftKind = "inbox" | "relay";
export type TeamWorkflowJournalPhase = (typeof TEAM_WORKFLOW_JOURNAL_PHASES)[number];

const HUB_JOB_SELECT_COLUMNS = `
  id, scaffold_id, kind, generation, phase,
  progress_completed, progress_total, progress_message, cancel_requested,
  state, created_at, started_at, finished_at, interrupted_reason,
  problem_json, summary, revision
`;

const V1_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_state_schema (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS configured_member_selections (
    scaffold_id TEXT NOT NULL PRIMARY KEY,
    member_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS catch_up_cursors (
    scaffold_id TEXT NOT NULL,
    actor_key TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    head TEXT,
    branch TEXT,
    timestamp TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY (scaffold_id, actor_key)
  ) STRICT;
`;

const V2_SCHEMA_SQL = `
  CREATE TABLE hub_runtime_lease (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid >= 1),
    token TEXT NOT NULL CHECK (length(token) = 64),
    acquired_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE hub_jobs (
    id TEXT NOT NULL PRIMARY KEY,
    scaffold_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('graph_refresh', 'graph_rebuild', 'wiki_refresh', 'wiki_rebuild')),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    phase TEXT NOT NULL CHECK (
      phase IN ('queued', 'running', 'refreshing', 'rebuilding', 'finalizing', 'complete', 'failed', 'interrupted')
    ),
    progress_completed INTEGER CHECK (progress_completed IS NULL OR progress_completed >= 0),
    progress_total INTEGER CHECK (progress_total IS NULL OR progress_total >= 1),
    progress_message TEXT CHECK (progress_message IS NULL),
    cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    interrupted_reason TEXT CHECK (
      interrupted_reason IS NULL
      OR interrupted_reason IN ('user_cancelled', 'process_restart', 'process_shutdown')
    ),
    problem_json TEXT CHECK (problem_json IS NULL OR length(CAST(problem_json AS BLOB)) <= ${MAX_JOB_PROBLEM_JSON_BYTES}),
    summary TEXT CHECK (summary IS NULL),
    revision TEXT NOT NULL,
    CHECK (
      (progress_completed IS NULL AND progress_total IS NULL AND progress_message IS NULL)
      OR progress_completed IS NOT NULL
    ),
    CHECK (progress_total IS NULL OR progress_completed <= progress_total),
    CHECK (state <> 'running' OR started_at IS NOT NULL),
    CHECK (state IN ('queued', 'running') OR finished_at IS NOT NULL),
    CHECK (state <> 'interrupted' OR interrupted_reason IS NOT NULL)
  ) STRICT;

  CREATE UNIQUE INDEX hub_jobs_one_active_index_job_per_scaffold
    ON hub_jobs (scaffold_id)
    WHERE state IN ('queued', 'running');

  CREATE UNIQUE INDEX hub_jobs_generation_per_kind
    ON hub_jobs (scaffold_id, kind, generation);

  CREATE INDEX hub_jobs_scaffold_created
    ON hub_jobs (scaffold_id, created_at DESC, id DESC);
`;

const V3_SCHEMA_SQL = `
  CREATE TABLE hub_runtime_lease (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid >= 1),
    token TEXT NOT NULL CHECK (length(token) = 64),
    acquired_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE hub_jobs (
    id TEXT NOT NULL PRIMARY KEY,
    scaffold_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('graph_refresh', 'graph_rebuild', 'wiki_refresh', 'wiki_rebuild')),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    phase TEXT NOT NULL CHECK (
      phase IN (
        'queued', 'running', 'refreshing', 'rebuilding', 'finalizing',
        'discover', 'stage', 'parse', 'resolve', 'validate', 'publish',
        'complete', 'failed', 'interrupted'
      )
    ),
    progress_completed INTEGER CHECK (progress_completed IS NULL OR progress_completed >= 0),
    progress_total INTEGER CHECK (progress_total IS NULL OR progress_total >= 1),
    progress_message TEXT CHECK (progress_message IS NULL),
    cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    interrupted_reason TEXT CHECK (
      interrupted_reason IS NULL
      OR interrupted_reason IN ('user_cancelled', 'process_restart', 'process_shutdown')
    ),
    problem_json TEXT CHECK (problem_json IS NULL OR length(CAST(problem_json AS BLOB)) <= ${MAX_JOB_PROBLEM_JSON_BYTES}),
    summary TEXT CHECK (summary IS NULL),
    revision TEXT NOT NULL,
    CHECK (
      (progress_completed IS NULL AND progress_total IS NULL AND progress_message IS NULL)
      OR progress_completed IS NOT NULL
    ),
    CHECK (progress_total IS NULL OR progress_completed <= progress_total),
    CHECK (state <> 'running' OR started_at IS NOT NULL),
    CHECK (state IN ('queued', 'running') OR finished_at IS NOT NULL),
    CHECK (state <> 'interrupted' OR interrupted_reason IS NOT NULL)
  ) STRICT;

  CREATE UNIQUE INDEX hub_jobs_one_active_index_job_per_scaffold
    ON hub_jobs (scaffold_id)
    WHERE state IN ('queued', 'running');

  CREATE UNIQUE INDEX hub_jobs_generation_per_kind
    ON hub_jobs (scaffold_id, kind, generation);

  CREATE INDEX hub_jobs_scaffold_created
    ON hub_jobs (scaffold_id, created_at DESC, id DESC);
`;

const V4_SCHEMA_SQL = `
  CREATE TABLE inbox_drafts (
    scaffold_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (
      length(CAST(payload_json AS BLOB)) <= ${TEAM_LOCAL_STATE_LIMITS.maxDraftBytes}
    ),
    updated_at TEXT NOT NULL,
    revision TEXT NOT NULL CHECK (length(revision) = 64),
    PRIMARY KEY (scaffold_id, id)
  ) STRICT;

  CREATE TABLE relay_drafts (
    scaffold_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (
      length(CAST(payload_json AS BLOB)) <= ${TEAM_LOCAL_STATE_LIMITS.maxDraftBytes}
    ),
    updated_at TEXT NOT NULL,
    revision TEXT NOT NULL CHECK (length(revision) = 64),
    PRIMARY KEY (scaffold_id, id)
  ) STRICT;

  CREATE TABLE team_workflow_lease (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    scaffold_id TEXT NOT NULL,
    pid INTEGER NOT NULL CHECK (pid >= 1),
    token TEXT NOT NULL CHECK (length(token) = 64),
    acquired_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE team_workflow_operations (
    scaffold_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    command_revision TEXT NOT NULL CHECK (length(command_revision) = 64),
    preview_revision TEXT NOT NULL CHECK (length(preview_revision) = 64),
    phase TEXT NOT NULL CHECK (
      phase IN ('intent', 'canonical_published', 'local_finalized', 'complete')
    ),
    effects_json TEXT NOT NULL CHECK (
      length(CAST(effects_json AS BLOB)) <= ${TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes}
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision TEXT NOT NULL CHECK (length(revision) = 64),
    PRIMARY KEY (scaffold_id, operation_id)
  ) STRICT;

  CREATE INDEX inbox_drafts_scaffold_updated
    ON inbox_drafts (scaffold_id, updated_at DESC, id DESC);

  CREATE INDEX relay_drafts_scaffold_updated
    ON relay_drafts (scaffold_id, updated_at DESC, id DESC);

  CREATE UNIQUE INDEX team_workflow_one_incomplete_per_repository
    ON team_workflow_operations ((1))
    WHERE phase <> 'complete';

  CREATE INDEX team_workflow_operations_scaffold_updated
    ON team_workflow_operations (scaffold_id, updated_at DESC, operation_id DESC);
`;

const EXPECTED_V1_TABLES = {
  local_state_schema: [
    { name: "singleton", type: "INTEGER", notNull: 1, primaryKeyPosition: 1 },
    { name: "version", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
    { name: "applied_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  ],
  configured_member_selections: [
    { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
    { name: "member_id", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "updated_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  ],
  catch_up_cursors: [
    { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
    { name: "actor_key", type: "TEXT", notNull: 1, primaryKeyPosition: 2 },
    { name: "actor_json", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "head", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
    { name: "branch", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
    { name: "timestamp", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  ],
} as const;

const EXPECTED_HUB_JOB_COLUMNS = [
  { name: "id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
  { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "kind", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "generation", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
  { name: "phase", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "progress_completed", type: "INTEGER", notNull: 0, primaryKeyPosition: 0 },
  { name: "progress_total", type: "INTEGER", notNull: 0, primaryKeyPosition: 0 },
  { name: "progress_message", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "cancel_requested", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
  { name: "state", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "created_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "started_at", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "finished_at", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "interrupted_reason", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "problem_json", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "summary", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
] as const;

const EXPECTED_HUB_LEASE_COLUMNS = [
  { name: "singleton", type: "INTEGER", notNull: 1, primaryKeyPosition: 1 },
  { name: "pid", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
  { name: "token", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "acquired_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
] as const;

const EXPECTED_DRAFT_COLUMNS = [
  { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
  { name: "id", type: "TEXT", notNull: 1, primaryKeyPosition: 2 },
  { name: "payload_json", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "updated_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
] as const;

const EXPECTED_WORKFLOW_LEASE_COLUMNS = [
  { name: "singleton", type: "INTEGER", notNull: 1, primaryKeyPosition: 1 },
  { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "pid", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
  { name: "token", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "acquired_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
] as const;

const EXPECTED_WORKFLOW_OPERATION_COLUMNS = [
  { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
  { name: "operation_id", type: "TEXT", notNull: 1, primaryKeyPosition: 2 },
  { name: "command_revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "preview_revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "phase", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "effects_json", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "created_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "updated_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
] as const;

type V1LocalStateTable = keyof typeof EXPECTED_V1_TABLES;
type LocalStateTable =
  | V1LocalStateTable
  | "hub_jobs"
  | "hub_runtime_lease"
  | "inbox_drafts"
  | "relay_drafts"
  | "team_workflow_lease"
  | "team_workflow_operations";

interface DatabaseFileIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface ConfiguredMemberRow {
  scaffold_id: unknown;
  member_id: unknown;
  updated_at: unknown;
  revision: unknown;
}

interface CatchUpCursorRow {
  scaffold_id: unknown;
  actor_key: unknown;
  actor_json: unknown;
  head: unknown;
  branch: unknown;
  timestamp: unknown;
  revision: unknown;
}

interface HubJobRow {
  id: unknown;
  scaffold_id: unknown;
  kind: unknown;
  generation: unknown;
  phase: unknown;
  progress_completed: unknown;
  progress_total: unknown;
  progress_message: unknown;
  cancel_requested: unknown;
  state: unknown;
  created_at: unknown;
  started_at: unknown;
  finished_at: unknown;
  interrupted_reason: unknown;
  problem_json: unknown;
  summary: unknown;
  revision: unknown;
}

interface HubLeaseRow {
  singleton: unknown;
  pid: unknown;
  token: unknown;
  acquired_at: unknown;
}

interface LocalDraftRow {
  scaffold_id: unknown;
  id: unknown;
  kind?: unknown;
  payload_json: unknown;
  updated_at: unknown;
  revision: unknown;
}

interface TeamWorkflowLeaseRow {
  singleton: unknown;
  scaffold_id: unknown;
  pid: unknown;
  token: unknown;
  acquired_at: unknown;
}

interface TeamWorkflowOperationRow {
  scaffold_id: unknown;
  operation_id: unknown;
  command_revision: unknown;
  preview_revision: unknown;
  phase: unknown;
  effects_json: unknown;
  created_at: unknown;
  updated_at: unknown;
  revision: unknown;
}

export interface ConfiguredMemberSelection {
  scaffoldId: string;
  memberId: string;
  updatedAt: string;
  revision: Revision;
}

export interface ConfigureMemberRequest {
  memberId: string;
  expectedRevision: Revision | null;
  updatedAt?: string;
}

export interface ClearConfiguredMemberRequest {
  expectedRevision: Revision;
}

/** Internal cursor projection. The provisional shared contract does not yet carry branch. */
export interface StoredCatchUpCursor extends CatchUpCursor {
  branch: string | null;
}

export interface WriteCatchUpCursorRequest {
  actor: ActorRef;
  head: string | null;
  branch: string | null;
  expectedRevision: Revision | null;
  timestamp?: string;
}

export interface TeamLocalStateOptions {
  projectRoot: string;
  scaffoldId: string;
  now?: () => string;
  processStatus?: (pid: number) => HubLeaseProcessStatus;
}

export type HubLeaseProcessStatus = "alive" | "dead" | "ambiguous";

export interface HubJobLease {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface AcquireHubJobLeaseRequest {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface CreateHubJobRecordRequest {
  leaseToken: string;
  id: string;
  kind: HubJobKind;
  phase: HubJobPhase;
  createdAt: string;
}

export interface UpdateHubJobRecordRequest {
  leaseToken: string;
  id: string;
  generation: number;
  expectedRevision: Revision;
  phase: HubJobPhase;
  progress: HubJobProgress | null;
  cancelRequested: boolean;
  state: HubJobSnapshot["state"];
  startedAt?: string;
  finishedAt?: string;
  interruptedReason?: HubJobInterruptionReason;
  problem?: HubJobProblem;
}

export interface ReconcileHubJobsResult {
  interrupted: readonly HubJobSnapshot[];
  pruned: number;
}

export interface StoredLocalDraft<TPayload = unknown> {
  scaffoldId: string;
  id: string;
  kind: TeamLocalDraftKind;
  payload: TPayload;
  updatedAt: string;
  revision: Revision;
}

export interface SaveLocalDraftRequest<TPayload = unknown> {
  id: string;
  kind: TeamLocalDraftKind;
  payload: TPayload;
  expectedRevision: Revision | null;
  /** Service-owned preview timestamp; pass it back on apply to bind the exact revision. */
  updatedAt?: string;
}

export interface DeleteLocalDraftRequest {
  id: string;
  kind: TeamLocalDraftKind;
  expectedRevision: Revision;
}

export interface LocalDraftStoreListRequest {
  kind?: TeamLocalDraftKind;
  cursor?: string;
  limit?: number;
}

export interface LocalDraftStorePage<TPayload = unknown> {
  items: readonly StoredLocalDraft<TPayload>[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface TeamWorkflowLease {
  scaffoldId: string;
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface AcquireTeamWorkflowLeaseRequest {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface CanonicalWorkflowEffect {
  kind: "canonical";
  namespace: string;
  id: string;
  path: RepoRelativePath;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
}

/** Bounded immutable audit state needed to recreate an exact missing Activity file. */
interface ActivityWorkflowEffectBase {
  kind: "activity";
  id: string;
  path: RepoRelativePath;
  revision: Revision;
  action: string;
  actor: ActorRef;
  occurredAt: string;
  repoState: RepoState;
  subjects: readonly ActivitySubjectRef[];
  workstream?: EntityRef;
  metadata?: Readonly<Record<string, JsonValue>>;
}

/** Pre-v2 journal shape retained byte-for-byte for interrupted recovery. */
export interface ActivityWorkflowEffectV1 extends ActivityWorkflowEffectBase {
  schemaVersion?: never;
  origin?: never;
  label?: never;
}

export interface ActivityWorkflowEffectV2 extends ActivityWorkflowEffectBase {
  schemaVersion: 2;
  origin: ActivityRecordOrigin;
  // Human labels stay out of the body-free journal and are recovered from the
  // exact canonical primary artifact before the Activity revision is attested.
}

export type ActivityWorkflowEffect =
  | ActivityWorkflowEffectV1
  | ActivityWorkflowEffectV2;

/**
 * Body-free attestation of the exact portable C preview envelope accepted by
 * the caller. This lets journal-backed replay remain available after a local
 * receipt key is lost without trusting altered presentation or authority
 * fields supplied by a later process.
 */
export interface IdentityActivityReceiptWorkflowEffect {
  kind: "identity_activity_receipt";
  envelopeRevision: Revision;
}

export interface LocalWorkflowEffect {
  kind: "local";
  namespace: string;
  id: string;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
}

export interface LocalCleanupWorkflowEffect {
  kind: "local_cleanup";
  draftKind: TeamLocalDraftKind;
  draftId: string;
  expectedRevision: Revision;
}

/** Body-free, engine-produced metadata needed to resume an interrupted Wiki batch. */
export interface WikiRecoveryWorkflowEffect {
  kind: "wiki_recovery";
  manifest: WikiOperationRecoveryManifest;
}

/** Metadata-only recovery effects. Source bodies, diffs, prompts, and raw errors are impossible. */
export type TeamWorkflowJournalEffect =
  | CanonicalWorkflowEffect
  | ActivityWorkflowEffect
  | IdentityActivityReceiptWorkflowEffect
  | LocalWorkflowEffect
  | LocalCleanupWorkflowEffect
  | WikiRecoveryWorkflowEffect;

/** Pure strict boundary used by preview before local storage is initialized. */
export function normalizeTeamWorkflowJournalEffects(
  value: unknown,
): readonly TeamWorkflowJournalEffect[] {
  return JSON.parse(canonicalWorkflowEffectsJson(value)) as readonly TeamWorkflowJournalEffect[];
}

export interface TeamWorkflowJournalEntry {
  scaffoldId: string;
  operationId: string;
  commandRevision: Revision;
  previewRevision: Revision;
  phase: TeamWorkflowJournalPhase;
  effects: readonly TeamWorkflowJournalEffect[];
  createdAt: string;
  updatedAt: string;
  revision: Revision;
}

export interface BeginTeamWorkflowOperationRequest {
  leaseToken: string;
  operationId: string;
  commandRevision: Revision;
  previewRevision: Revision;
  effects: readonly TeamWorkflowJournalEffect[];
}

export interface BeginTeamWorkflowOperationResult {
  entry: TeamWorkflowJournalEntry;
  idempotentReplay: boolean;
}

export interface WorkflowDraftCleanupRequest {
  kind: TeamLocalDraftKind;
  id: string;
  expectedRevision: Revision;
}

export interface AdvanceTeamWorkflowOperationRequest {
  leaseToken: string;
  operationId: string;
  commandRevision: Revision;
  previewRevision: Revision;
  expectedRevision: Revision;
  phase: Exclude<TeamWorkflowJournalPhase, "intent">;
  effects: readonly TeamWorkflowJournalEffect[];
  /** Allowed only for the local_finalized transition and committed atomically with it. */
  deleteDrafts?: readonly WorkflowDraftCleanupRequest[];
}

export interface AbandonTeamWorkflowOperationRequest {
  leaseToken: string;
  operationId: string;
  commandRevision: Revision;
  previewRevision: Revision;
  expectedRevision: Revision;
}

/**
 * Schema-versioned, repository-local state for team identity and Catch Up.
 *
 * Every read is side-effect free: a missing database is represented as absent
 * state, while an old schema asks the caller to perform an explicit write-side
 * migration. All mutations use BEGIN IMMEDIATE and exact optimistic revisions.
 */
export class TeamLocalState {
  readonly databasePath: string;

  private readonly projectRoot: string;
  private readonly scaffoldId: string;
  private readonly now: () => string;
  private readonly processStatus: (pid: number) => HubLeaseProcessStatus;

  constructor(options: TeamLocalStateOptions) {
    this.projectRoot = canonicalProjectRoot(options.projectRoot);
    this.scaffoldId = validateScaffoldId(options.scaffoldId);
    this.databasePath = join(this.projectRoot, LOCAL_STATE_RELATIVE_PATH);
    this.now = options.now ?? (() => new Date().toISOString());
    this.processStatus = options.processStatus ?? probeProcessStatus;
  }

  getConfiguredMember(): ConfiguredMemberSelection | null {
    return this.read((db) => {
      const row = db.prepare(`
        SELECT scaffold_id, member_id, updated_at, revision
        FROM configured_member_selections
        WHERE scaffold_id = ?
      `).get(this.scaffoldId) as ConfiguredMemberRow | undefined;
      return row ? decodeConfiguredMember(row, this.scaffoldId) : null;
    });
  }

  /** Pure projection used by workflow preview; never creates or migrates storage. */
  previewConfigureMember(request: ConfigureMemberRequest): ConfiguredMemberSelection {
    const memberId = validateMemberId(request.memberId);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    const updatedAt = validateTimestamp(request.updatedAt ?? this.now(), "updatedAt");
    this.assertExistingRevisionCanMatch(expectedRevision, "configured member");
    const current = this.getConfiguredMember();
    assertExpectedRevision(current?.revision ?? null, expectedRevision, "configured member");
    return {
      scaffoldId: this.scaffoldId,
      memberId,
      updatedAt,
      revision: configuredMemberRevision(this.scaffoldId, memberId, updatedAt),
    };
  }

  configureMember(request: ConfigureMemberRequest): ConfiguredMemberSelection {
    const memberId = validateMemberId(request.memberId);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    const updatedAt = validateTimestamp(request.updatedAt ?? this.now(), "updatedAt");
    this.assertExistingRevisionCanMatch(expectedRevision, "configured member");

    return this.write((db) => {
      const current = readConfiguredMember(db, this.scaffoldId);
      assertExpectedRevision(current?.revision ?? null, expectedRevision, "configured member");

      const selection: ConfiguredMemberSelection = {
        scaffoldId: this.scaffoldId,
        memberId,
        updatedAt,
        revision: configuredMemberRevision(this.scaffoldId, memberId, updatedAt),
      };
      db.prepare(`
        INSERT INTO configured_member_selections (
          scaffold_id, member_id, updated_at, revision
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(scaffold_id) DO UPDATE SET
          member_id = excluded.member_id,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        selection.scaffoldId,
        selection.memberId,
        selection.updatedAt,
        selection.revision,
      );
      return selection;
    });
  }

  clearConfiguredMember(request: ClearConfiguredMemberRequest): void {
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    if (expectedRevision === null) {
      throw validationError("Clearing a configured member requires its current revision.");
    }
    this.assertExistingRevisionCanMatch(expectedRevision, "configured member");

    this.write((db) => {
      const current = readConfiguredMember(db, this.scaffoldId);
      assertExpectedRevision(current?.revision ?? null, expectedRevision, "configured member");
      db.prepare(
        "DELETE FROM configured_member_selections WHERE scaffold_id = ?",
      ).run(this.scaffoldId);
    });
  }

  /** Pure validation used by workflow preview; never creates or migrates storage. */
  previewClearConfiguredMember(
    request: ClearConfiguredMemberRequest,
  ): ConfiguredMemberSelection {
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    if (expectedRevision === null) {
      throw validationError("Clearing a configured member requires its current revision.");
    }
    this.assertExistingRevisionCanMatch(expectedRevision, "configured member");
    const current = this.getConfiguredMember();
    assertExpectedRevision(current?.revision ?? null, expectedRevision, "configured member");
    if (current === null) {
      throw revisionConflict("The configured member no longer exists.");
    }
    return current;
  }

  getCatchUpCursor(actor: ActorRef): StoredCatchUpCursor | null {
    const actorKey = canonicalActorKey(actor);
    if (actorKey === null) return null;

    return this.read((db) => {
      const row = db.prepare(`
        SELECT scaffold_id, actor_key, actor_json, head, branch, timestamp, revision
        FROM catch_up_cursors
        WHERE scaffold_id = ? AND actor_key = ?
      `).get(this.scaffoldId, actorKey) as CatchUpCursorRow | undefined;
      return row ? decodeCatchUpCursor(row, this.scaffoldId, actorKey) : null;
    });
  }

  /** Mark on the current branch. A branch change must use resetCatchUpCursor. */
  markCatchUpCursor(request: WriteCatchUpCursorRequest): StoredCatchUpCursor {
    return this.writeCursor(request, false);
  }

  /** Explicitly confirms replacement of a cursor, including across branches. */
  resetCatchUpCursor(request: WriteCatchUpCursorRequest): StoredCatchUpCursor {
    return this.writeCursor(request, true);
  }

  getLocalDraft<TPayload = unknown>(idValue: string): StoredLocalDraft<TPayload> | null {
    const id = validateLocalIdentifier(idValue, "draft ID");
    return this.read((db) => readLocalDraft<TPayload>(db, this.scaffoldId, id), 4);
  }

  listLocalDrafts<TPayload = unknown>(
    request: LocalDraftStoreListRequest = {},
  ): LocalDraftStorePage<TPayload> {
    const kind = request.kind === undefined ? undefined : validateDraftKind(request.kind);
    const limit = validateDraftPageLimit(request.limit);
    const cursor = decodeDraftCursor(request.cursor);
    const page = this.read((db) => {
      const corpus = readBoundedLocalDraftCorpus<TPayload>(db, this.scaffoldId);
      const corpusRevision = localDraftCorpusRevision(this.scaffoldId, corpus);
      assertDraftCursorAuthority(cursor, this.scaffoldId, kind, corpusRevision);

      const filtered = kind === undefined
        ? corpus
        : corpus.filter((draft) => draft.kind === kind);
      const start = cursor === null
        ? 0
        : draftCursorStartIndex(filtered, cursor);
      const decoded = filtered.slice(start, start + limit + 1);
      const truncated = decoded.length > limit;
      const items = truncated ? decoded.slice(0, limit) : decoded;
      const last = items.at(-1);
      return {
        items,
        nextCursor: truncated && last
          ? encodeDraftCursor({
              scaffoldId: this.scaffoldId,
              requestedKind: kind ?? null,
              corpusRevision,
              updatedAt: last.updatedAt,
              kind: last.kind,
              id: last.id,
            })
          : null,
        truncated,
      };
    }, 4);
    if (page === null && cursor !== null) {
      throw revisionConflict("The local draft corpus no longer exists; restart pagination.");
    }
    return page ?? { items: [], nextCursor: null, truncated: false };
  }

  saveLocalDraft<TPayload>(request: SaveLocalDraftRequest<TPayload>): StoredLocalDraft<TPayload> {
    const id = validateLocalIdentifier(request.id, "draft ID");
    const kind = validateDraftKind(request.kind);
    const payloadJson = canonicalDraftPayloadJson(request.payload);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    const updatedAt = validateTimestamp(request.updatedAt ?? this.now(), "draft updatedAt");
    this.assertExistingRevisionCanMatch(expectedRevision, `${kind} draft`);

    return this.write((db) => {
      const current = readLocalDraft<TPayload>(db, this.scaffoldId, id);
      if (current && current.kind !== kind) {
        throw revisionConflict(`Draft ID ${id} is already used by a ${current.kind} draft.`);
      }
      assertExpectedRevision(current?.revision ?? null, expectedRevision, `${kind} draft`);
      if (!current) assertDraftCapacity(db, this.scaffoldId, kind);

      const revision = localDraftRevision(
        this.scaffoldId,
        id,
        kind,
        payloadJson,
        updatedAt,
      );
      const table = draftTable(kind);
      db.prepare(`
        INSERT INTO ${table} (scaffold_id, id, payload_json, updated_at, revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scaffold_id, id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(this.scaffoldId, id, payloadJson, updatedAt, revision);
      return {
        scaffoldId: this.scaffoldId,
        id,
        kind,
        payload: parseCanonicalDraftPayload<TPayload>(payloadJson),
        updatedAt,
        revision,
      };
    });
  }

  previewSaveLocalDraft<TPayload>(
    request: SaveLocalDraftRequest<TPayload>,
  ): StoredLocalDraft<TPayload> {
    const id = validateLocalIdentifier(request.id, "draft ID");
    const kind = validateDraftKind(request.kind);
    const payloadJson = canonicalDraftPayloadJson(request.payload);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    const updatedAt = validateTimestamp(request.updatedAt ?? this.now(), "draft updatedAt");
    this.assertExistingRevisionCanMatch(expectedRevision, `${kind} draft`);
    const prepared: StoredLocalDraft<TPayload> = {
      scaffoldId: this.scaffoldId,
      id,
      kind,
      payload: parseCanonicalDraftPayload<TPayload>(payloadJson),
      updatedAt,
      revision: localDraftRevision(this.scaffoldId, id, kind, payloadJson, updatedAt),
    };
    let observed: StoredLocalDraft<TPayload> | null;
    try {
      observed = this.read((db) => {
        const current = readLocalDraft<TPayload>(db, this.scaffoldId, id);
        if (current && current.kind !== kind) {
          throw revisionConflict(`Draft ID ${id} is already used by a ${current.kind} draft.`);
        }
        assertExpectedRevision(current?.revision ?? null, expectedRevision, `${kind} draft`);
        if (!current) assertDraftCapacity(db, this.scaffoldId, kind);
        return prepared;
      }, 4);
    } catch (error) {
      // Schemas v1-v3 predate both draft tables, so an immutable create
      // preview can prove absence without migrating. The explicit apply is the
      // first write and performs the transactional v4 migration.
      if (!(error instanceof MexPortError) || error.problem.code !== "MIGRATION_REQUIRED") {
        throw error;
      }
      assertExpectedRevision(null, expectedRevision, `${kind} draft`);
      observed = null;
    }
    if (observed !== null) return observed;
    assertExpectedRevision(null, expectedRevision, `${kind} draft`);
    return prepared;
  }

  deleteLocalDraft(request: DeleteLocalDraftRequest): void {
    const id = validateLocalIdentifier(request.id, "draft ID");
    const kind = validateDraftKind(request.kind);
    const expectedRevision = validateRequiredRevision(request.expectedRevision, "draft revision");
    this.assertExistingRevisionCanMatch(expectedRevision, `${kind} draft`);
    this.write((db) => deleteLocalDraftExact(
      db,
      this.scaffoldId,
      kind,
      id,
      expectedRevision,
    ));
  }

  previewDeleteLocalDraft(request: DeleteLocalDraftRequest): StoredLocalDraft {
    const id = validateLocalIdentifier(request.id, "draft ID");
    const kind = validateDraftKind(request.kind);
    const expectedRevision = validateRequiredRevision(request.expectedRevision, "draft revision");
    this.assertExistingRevisionCanMatch(expectedRevision, `${kind} draft`);
    const current = this.read((db) => readLocalDraft(db, this.scaffoldId, id), 4);
    if (current && current.kind !== kind) {
      throw revisionConflict(`Draft ID ${id} belongs to ${current.kind}, not ${kind}.`);
    }
    assertExpectedRevision(current?.revision ?? null, expectedRevision, `${kind} draft`);
    return current!;
  }

  acquireTeamWorkflowLease(request: AcquireTeamWorkflowLeaseRequest): TeamWorkflowLease {
    const pid = requireSafeInteger(request.pid, "workflow lease pid", 1);
    const token = validateWorkflowLeaseToken(request.token);
    const acquiredAt = validateTimestamp(request.acquiredAt, "workflow lease acquiredAt");
    return this.write((db) => {
      const current = readTeamWorkflowLease(db);
      if (
        current?.scaffoldId === this.scaffoldId
        && current.pid === pid
        && current.token === token
      ) return current;
      if (current) {
        const status = safeProcessStatus(this.processStatus, current.pid);
        if (status !== "dead") throw workflowLeaseHeldError(current.pid, status);
        const incomplete = readAnyIncompleteWorkflowOperation(db);
        if (
          incomplete
          && (
            incomplete.scaffoldId !== current.scaffoldId
            || current.scaffoldId !== this.scaffoldId
          )
        ) {
          throw revisionConflict(
            `Workflow operation ${incomplete.operationId} for scaffold ${incomplete.scaffoldId} `
              + "must be recovered before the repository workflow lease can be reassigned.",
          );
        }
        const replaced = db.prepare(`
          UPDATE team_workflow_lease
          SET scaffold_id = ?, pid = ?, token = ?, acquired_at = ?
          WHERE singleton = 1 AND scaffold_id = ? AND pid = ? AND token = ?
        `).run(
          this.scaffoldId,
          pid,
          token,
          acquiredAt,
          current.scaffoldId,
          current.pid,
          current.token,
        );
        if (Number(replaced.changes) !== 1) {
          throw revisionConflict("The Team workflow lease changed during dead-holder recovery.");
        }
      } else {
        const incomplete = readAnyIncompleteWorkflowOperation(db);
        if (incomplete) {
          throw revisionConflict(
            `Workflow operation ${incomplete.operationId} for scaffold ${incomplete.scaffoldId} `
              + "must be recovered before acquiring the repository workflow lease.",
          );
        }
        db.prepare(`
          INSERT INTO team_workflow_lease (singleton, scaffold_id, pid, token, acquired_at)
          VALUES (1, ?, ?, ?, ?)
        `).run(this.scaffoldId, pid, token, acquiredAt);
      }
      return { scaffoldId: this.scaffoldId, pid, token, acquiredAt };
    });
  }

  releaseTeamWorkflowLease(tokenValue: string): void {
    const token = validateWorkflowLeaseToken(tokenValue);
    this.write((db) => {
      assertTeamWorkflowLease(db, this.scaffoldId, token);
      const incomplete = readAnyIncompleteWorkflowOperation(db);
      if (incomplete) {
        throw revisionConflict(
          `Workflow operation ${incomplete.operationId} must complete or be abandoned before lease release.`,
        );
      }
      const deleted = db.prepare(`
        DELETE FROM team_workflow_lease
        WHERE singleton = 1 AND scaffold_id = ? AND token = ?
      `).run(this.scaffoldId, token);
      if (Number(deleted.changes) !== 1) {
        throw revisionConflict("The Team workflow lease changed before release.");
      }
    });
  }

  getWorkflowOperation(operationIdValue: string): TeamWorkflowJournalEntry | null {
    const operationId = validateLocalIdentifier(operationIdValue, "workflow operation ID");
    return this.read((db) => readWorkflowOperation(db, this.scaffoldId, operationId), 4);
  }

  getIncompleteWorkflowOperation(): TeamWorkflowJournalEntry | null {
    return this.read((db) => readIncompleteWorkflowOperation(db, this.scaffoldId), 4);
  }

  beginWorkflowOperation(
    request: BeginTeamWorkflowOperationRequest,
  ): BeginTeamWorkflowOperationResult {
    const leaseToken = validateWorkflowLeaseToken(request.leaseToken);
    const operationId = validateLocalIdentifier(request.operationId, "workflow operation ID");
    const commandRevision = validateRequiredRevision(
      request.commandRevision,
      "workflow command revision",
    );
    const previewRevision = validateRequiredRevision(
      request.previewRevision,
      "workflow preview revision",
    );
    const effectsJson = canonicalWorkflowEffectsJson(request.effects);
    const timestamp = validateTimestamp(this.now(), "workflow operation timestamp");

    return this.write((db) => {
      assertTeamWorkflowLease(db, this.scaffoldId, leaseToken);
      const current = readWorkflowOperation(db, this.scaffoldId, operationId);
      if (current) {
        if (current.commandRevision !== commandRevision) {
          throw revisionConflict(
            `Workflow operation ID ${operationId} was already used for a different command.`,
          );
        }
        if (current.previewRevision !== previewRevision) {
          throw revisionConflict(
            `Workflow operation ID ${operationId} was already bound to a different preview.`,
          );
        }
        if (canonicalWorkflowEffectsJson(current.effects) !== effectsJson) {
          throw revisionConflict(
            `Workflow operation ID ${operationId} was already used with different effects.`,
          );
        }
        return { entry: current, idempotentReplay: true };
      }
      const incomplete = readIncompleteWorkflowOperation(db, this.scaffoldId);
      if (incomplete) {
        throw revisionConflict(
          `Workflow operation ${incomplete.operationId} must be recovered before starting another.`,
        );
      }
      const entry: TeamWorkflowJournalEntry = {
        scaffoldId: this.scaffoldId,
        operationId,
        commandRevision,
        previewRevision,
        phase: "intent",
        effects: parseWorkflowEffects(effectsJson),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: workflowOperationRevision({
          scaffoldId: this.scaffoldId,
          operationId,
          commandRevision,
          previewRevision,
          phase: "intent",
          effectsJson,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      };
      insertWorkflowOperation(db, entry, effectsJson);
      return { entry, idempotentReplay: false };
    });
  }

  advanceWorkflowOperation(
    request: AdvanceTeamWorkflowOperationRequest,
  ): TeamWorkflowJournalEntry {
    const leaseToken = validateWorkflowLeaseToken(request.leaseToken);
    const operationId = validateLocalIdentifier(request.operationId, "workflow operation ID");
    const commandRevision = validateRequiredRevision(
      request.commandRevision,
      "workflow command revision",
    );
    const previewRevision = validateRequiredRevision(
      request.previewRevision,
      "workflow preview revision",
    );
    const expectedRevision = validateRequiredRevision(
      request.expectedRevision,
      "workflow operation revision",
    );
    const phase = validateWorkflowAdvancePhase(request.phase);
    const effectsJson = canonicalWorkflowEffectsJson(request.effects);
    const deleteDrafts = validateWorkflowDraftCleanups(request.deleteDrafts ?? []);
    if (deleteDrafts.length > 0 && phase !== "local_finalized") {
      throw validationError("Draft cleanup is allowed only during local_finalized.");
    }
    if (phase === "local_finalized") {
      assertCleanupRequestsMatchEffects(deleteDrafts, request.effects);
    }
    const updatedAt = validateTimestamp(this.now(), "workflow operation timestamp");

    return this.write((db) => {
      assertTeamWorkflowLease(db, this.scaffoldId, leaseToken);
      const current = readWorkflowOperation(db, this.scaffoldId, operationId);
      if (!current) throw workflowOperationNotFoundError(operationId);
      if (current.commandRevision !== commandRevision) {
        throw revisionConflict(
          `Workflow operation ID ${operationId} belongs to a different command.`,
        );
      }
      if (current.previewRevision !== previewRevision) {
        throw revisionConflict("The workflow preview revision no longer matches the journal.");
      }
      assertExpectedRevision(current.revision, expectedRevision, "workflow operation");
      assertNextWorkflowPhase(current.phase, phase);
      if (canonicalWorkflowEffectsJson(current.effects) !== effectsJson) {
        throw revisionConflict("Workflow journal effects cannot change after intent.");
      }

      for (const cleanup of deleteDrafts) {
        deleteLocalDraftExact(
          db,
          this.scaffoldId,
          cleanup.kind,
          cleanup.id,
          cleanup.expectedRevision,
        );
      }

      const next: TeamWorkflowJournalEntry = {
        scaffoldId: this.scaffoldId,
        operationId,
        commandRevision,
        previewRevision,
        phase,
        effects: parseWorkflowEffects(effectsJson),
        createdAt: current.createdAt,
        updatedAt,
        revision: workflowOperationRevision({
          scaffoldId: this.scaffoldId,
          operationId,
          commandRevision,
          previewRevision,
          phase,
          effectsJson,
          createdAt: current.createdAt,
          updatedAt,
        }),
      };
      replaceWorkflowOperation(db, next, effectsJson, expectedRevision);
      if (phase === "complete") {
        pruneTerminalWorkflowOperations(db, this.scaffoldId, operationId);
      }
      return next;
    });
  }

  abandonWorkflowOperation(request: AbandonTeamWorkflowOperationRequest): void {
    const leaseToken = validateWorkflowLeaseToken(request.leaseToken);
    const operationId = validateLocalIdentifier(request.operationId, "workflow operation ID");
    const commandRevision = validateRequiredRevision(
      request.commandRevision,
      "workflow command revision",
    );
    const previewRevision = validateRequiredRevision(
      request.previewRevision,
      "workflow preview revision",
    );
    const expectedRevision = validateRequiredRevision(
      request.expectedRevision,
      "workflow operation revision",
    );
    this.write((db) => {
      assertTeamWorkflowLease(db, this.scaffoldId, leaseToken);
      const current = readWorkflowOperation(db, this.scaffoldId, operationId);
      if (!current) throw workflowOperationNotFoundError(operationId);
      if (current.commandRevision !== commandRevision) {
        throw revisionConflict(
          `Workflow operation ID ${operationId} belongs to a different command.`,
        );
      }
      if (current.previewRevision !== previewRevision) {
        throw revisionConflict("The workflow preview revision no longer matches the journal.");
      }
      assertExpectedRevision(current.revision, expectedRevision, "workflow operation");
      if (current.phase !== "intent") {
        throw revisionConflict("Only an unpublished intent may be abandoned.");
      }
      const deleted = db.prepare(`
        DELETE FROM team_workflow_operations
        WHERE scaffold_id = ? AND operation_id = ? AND revision = ? AND phase = 'intent'
      `).run(this.scaffoldId, operationId, expectedRevision);
      if (Number(deleted.changes) !== 1) {
        throw revisionConflict("The workflow operation changed before abandonment.");
      }
    });
  }

  /** Explicit write-side initialization/migration for a caller-authorized mutation. */
  initializeForMutation(): void {
    this.write(() => undefined);
  }

  /** Compatibility entry used by `mex hub` startup. */
  initializeHubState(): void {
    this.initializeForMutation();
  }

  /** Acquire the repository-singleton Hub job lease before reconciliation. */
  acquireHubJobLease(request: AcquireHubJobLeaseRequest): HubJobLease {
    const pid = requireSafeInteger(request.pid, "lease pid", 1);
    const token = validateLeaseToken(request.token);
    const acquiredAt = validateTimestamp(request.acquiredAt, "lease acquiredAt");
    return this.write((db) => {
      const current = readHubJobLease(db);
      if (current?.pid === pid && current.token === token) return current;
      if (current) {
        const status = safeProcessStatus(this.processStatus, current.pid);
        if (status !== "dead") throw hubLeaseHeldError(current.pid, status);
        const replaced = db.prepare(`
          UPDATE hub_runtime_lease
          SET pid = ?, token = ?, acquired_at = ?
          WHERE singleton = 1 AND pid = ? AND token = ?
        `).run(pid, token, acquiredAt, current.pid, current.token);
        if (Number(replaced.changes) !== 1) {
          throw revisionConflict("The Hub job lease changed during dead-holder recovery.");
        }
      } else {
        db.prepare(`
          INSERT INTO hub_runtime_lease (singleton, pid, token, acquired_at)
          VALUES (1, ?, ?, ?)
        `).run(pid, token, acquiredAt);
      }
      return { pid, token, acquiredAt };
    });
  }

  /** Token-checked release. Call only after every executor has settled. */
  releaseHubJobLease(token: string): void {
    const leaseToken = validateLeaseToken(token);
    this.write((db) => {
      const current = readHubJobLease(db);
      if (!current || current.token !== leaseToken) {
        throw revisionConflict("The Hub job lease is absent or belongs to another process.");
      }
      const activeCountRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM hub_jobs
        WHERE state IN ('queued', 'running')
      `).get() as { count: unknown };
      const activeCount = sqliteInteger(activeCountRow.count);
      if (activeCount === null || activeCount < 0) {
        throw corruptError("The Hub job active-row count is invalid.");
      }
      if (activeCount > 0) {
        throw revisionConflict("The Hub job lease cannot be released while a job is active.");
      }
      const deleted = db.prepare(`
        DELETE FROM hub_runtime_lease
        WHERE singleton = 1 AND token = ?
      `).run(leaseToken);
      if (Number(deleted.changes) !== 1) {
        throw revisionConflict("The Hub job lease changed before release.");
      }
    });
  }

  listHubJobs(request: HubJobListRequest = {}): HubJobPage {
    const limit = validateJobPageLimit(request.limit);
    const cursor = decodeJobCursor(request.cursor);
    return this.read((db) => {
      const rows = cursor === null
        ? db.prepare(`
            SELECT ${HUB_JOB_SELECT_COLUMNS}
            FROM hub_jobs
            WHERE scaffold_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).all(this.scaffoldId, limit + 1) as unknown as HubJobRow[]
        : db.prepare(`
            SELECT ${HUB_JOB_SELECT_COLUMNS}
            FROM hub_jobs
            WHERE scaffold_id = ?
              AND (created_at < ? OR (created_at = ? AND id < ?))
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).all(
            this.scaffoldId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            limit + 1,
          ) as unknown as HubJobRow[];
      const decoded = rows.map((row) => decodeHubJob(row, this.scaffoldId));
      const hasMore = decoded.length > limit;
      const items = hasMore ? decoded.slice(0, limit) : decoded;
      const last = items.at(-1);
      return {
        items,
        ...(hasMore && last
          ? { nextCursor: encodeJobCursor(last.createdAt, last.id) }
          : {}),
      };
    }, 2) ?? { items: [] };
  }

  getHubJob(id: string): HubJobSnapshot | null {
    const jobId = validateHubJobId(id);
    return this.read((db) => readHubJob(db, this.scaffoldId, jobId), 2);
  }

  getActiveHubJob(): HubJobSnapshot | null {
    return this.read((db) => readActiveHubJob(db, this.scaffoldId), 2);
  }

  createHubJobRecord(request: CreateHubJobRecordRequest): HubJobSnapshot {
    const leaseToken = validateLeaseToken(request.leaseToken);
    const id = validateHubJobId(request.id);
    const kind = validateHubJobKind(request.kind);
    const phase = validateJobPhase(request.phase);
    const createdAt = validateTimestamp(request.createdAt, "createdAt");

    return this.write((db) => {
      assertHubJobLease(db, leaseToken);
      const active = readActiveHubJob(db, this.scaffoldId);
      if (active) throw jobAlreadyRunningError(active.id);

      const generationRow = db.prepare(`
        SELECT MAX(generation) AS generation
        FROM hub_jobs
        WHERE scaffold_id = ? AND kind = ?
      `).get(this.scaffoldId, kind) as { generation: unknown };
      const priorGeneration = generationRow.generation === null
        ? 0
        : requireSafeInteger(generationRow.generation, "Hub job generation", 1);
      const generation = priorGeneration + 1;
      if (!Number.isSafeInteger(generation)) {
        throw corruptError("Hub job generation is exhausted.");
      }

      const draft: Omit<HubJobSnapshot, "revision"> = {
        id,
        scaffoldId: this.scaffoldId,
        kind,
        generation,
        phase,
        progress: null,
        cancelRequested: false,
        state: "queued",
        createdAt,
      };
      validateJobLifecycle(draft);
      const job: HubJobSnapshot = {
        ...draft,
        revision: hubJobRevision(draft),
      };
      insertHubJob(db, job);
      return job;
    });
  }

  updateHubJobRecord(request: UpdateHubJobRecordRequest): HubJobSnapshot {
    const leaseToken = validateLeaseToken(request.leaseToken);
    const id = validateHubJobId(request.id);
    const generation = requireSafeInteger(request.generation, "generation", 1);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    if (expectedRevision === null) {
      throw validationError("Updating a Hub job requires its current revision.");
    }
    const phase = validateJobPhase(request.phase);
    const progress = validateJobProgress(request.progress);
    const cancelRequested = validateBoolean(request.cancelRequested, "cancelRequested");
    const state = validateJobState(request.state);
    const startedAt = optionalTimestamp(request.startedAt, "startedAt");
    const finishedAt = optionalTimestamp(request.finishedAt, "finishedAt");
    const interruptedReason = validateInterruptionReason(request.interruptedReason);
    const problem = validateJobProblem(request.problem);

    return this.write((db) => {
      assertHubJobLease(db, leaseToken);
      const current = readHubJob(db, this.scaffoldId, id);
      if (!current) throw jobNotFoundError(id);
      if (current.generation !== generation) {
        throw revisionConflict("The Hub job generation changed; discard the stale update.");
      }
      assertExpectedRevision(current.revision, expectedRevision, "Hub job");
      assertJobTransition(current, state, progress, startedAt, cancelRequested);

      const draft: Omit<HubJobSnapshot, "revision"> = {
        id: current.id,
        scaffoldId: current.scaffoldId,
        kind: current.kind,
        generation: current.generation,
        phase,
        progress,
        cancelRequested,
        state,
        createdAt: current.createdAt,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(interruptedReason === undefined ? {} : { interruptedReason }),
        ...(problem === undefined ? {} : { problem }),
      };
      validateJobLifecycle(draft);
      const job: HubJobSnapshot = {
        ...draft,
        revision: hubJobRevision(draft),
      };
      replaceHubJob(db, job, expectedRevision);
      if (isTerminalJobState(job.state)) pruneTerminalHubJobs(db, this.scaffoldId);
      return job;
    });
  }

  reconcileHubJobs(finishedAt: string, leaseTokenValue: string): ReconcileHubJobsResult {
    const timestamp = validateTimestamp(finishedAt, "finishedAt");
    const leaseToken = validateLeaseToken(leaseTokenValue);
    return this.write((db) => {
      assertHubJobLease(db, leaseToken);
      const activeRows = db.prepare(`
        SELECT ${HUB_JOB_SELECT_COLUMNS}
        FROM hub_jobs
        WHERE state IN ('queued', 'running')
        ORDER BY scaffold_id ASC, created_at ASC, id ASC
      `).all() as unknown as HubJobRow[];
      const touchedScaffolds = new Set<string>([this.scaffoldId]);
      const interrupted = activeRows.map((row) => {
        const scaffoldId = validateStoredScaffoldId(row.scaffold_id);
        touchedScaffolds.add(scaffoldId);
        const current = decodeHubJob(row, scaffoldId);
        const draft: Omit<HubJobSnapshot, "revision"> = {
          ...withoutRevision(current),
          phase: "interrupted",
          state: "interrupted",
          finishedAt: timestamp,
          interruptedReason: "process_restart",
        };
        validateJobLifecycle(draft);
        const job: HubJobSnapshot = {
          ...draft,
          revision: hubJobRevision(draft),
        };
        replaceHubJob(db, job, current.revision);
        return job;
      });
      let pruned = 0;
      for (const scaffoldId of touchedScaffolds) {
        pruned += pruneTerminalHubJobs(db, scaffoldId);
      }
      return { interrupted, pruned };
    });
  }

  private writeCursor(
    request: WriteCatchUpCursorRequest,
    allowBranchChange: boolean,
  ): StoredCatchUpCursor {
    const actor = normalizeWritableActor(request.actor);
    const actorKey = canonicalActorKey(actor);
    if (actorKey === null) {
      throw validationError("Unknown actors cannot mark or reset a Catch Up cursor.");
    }
    const head = validateHead(request.head);
    const branch = validateBranch(request.branch);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    const timestamp = validateTimestamp(request.timestamp ?? this.now(), "timestamp");
    this.assertExistingRevisionCanMatch(expectedRevision, "Catch Up cursor");

    return this.write((db) => {
      const current = readCatchUpCursor(db, this.scaffoldId, actorKey);
      if (current && !allowBranchChange && current.branch !== branch) {
        throw revisionConflict(
          `Catch Up cursor belongs to ${describeBranch(current.branch)}; `
            + `explicitly reset it before using ${describeBranch(branch)}.`,
        );
      }
      assertExpectedRevision(current?.revision ?? null, expectedRevision, "Catch Up cursor");

      const cursor: StoredCatchUpCursor = {
        scaffoldId: this.scaffoldId,
        actor,
        head,
        branch,
        timestamp,
        revision: cursorRevision({
          scaffoldId: this.scaffoldId,
          actor,
          head,
          branch,
          timestamp,
        }),
      };
      db.prepare(`
        INSERT INTO catch_up_cursors (
          scaffold_id, actor_key, actor_json, head, branch, timestamp, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scaffold_id, actor_key) DO UPDATE SET
          actor_json = excluded.actor_json,
          head = excluded.head,
          branch = excluded.branch,
          timestamp = excluded.timestamp,
          revision = excluded.revision
      `).run(
        cursor.scaffoldId,
        actorKey,
        canonicalActorJson(actor),
        cursor.head,
        cursor.branch,
        cursor.timestamp,
        cursor.revision,
      );
      return cursor;
    });
  }

  private read<T>(operation: (db: DatabaseSync) => T, minimumSchemaVersion = 1): T | null {
    this.assertDatabasePathSafe();
    const observedIdentity = beginImmutableObservation(this.databasePath);
    if (observedIdentity === null) return null;

    let db: DatabaseSync | undefined;
    let result: T | undefined;
    let operationError: unknown;
    try {
      const location = `${pathToFileURL(this.databasePath).href}?mode=ro&immutable=1`;
      db = new DatabaseSync(location, { readOnly: true });
      validateReadableSchema(db, minimumSchemaVersion);
      result = operation(db);
    } catch (error) {
      operationError = error;
    } finally {
      closeQuietly(db);
    }

    try {
      finishImmutableObservation(this.databasePath, observedIdentity);
    } catch (error) {
      throw normalizeStorageError(error);
    }
    if (operationError !== undefined) throw normalizeStorageError(operationError);
    return result as T;
  }

  private write<T>(operation: (db: DatabaseSync) => T): T {
    this.assertDatabasePathSafe();
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.assertDatabasePathSafe();

    let db: DatabaseSync | undefined;
    let transactionOpen = false;
    try {
      db = new DatabaseSync(this.databasePath);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      ensureWritableSchema(db, this.now);
      const result = operation(db);
      db.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (db && transactionOpen) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the actionable failure from the operation/schema check.
        }
      }
      throw normalizeStorageError(error);
    } finally {
      closeQuietly(db);
    }
  }

  private assertDatabasePathSafe(): void {
    const containedPrefix = `${this.projectRoot}${sep}`;
    if (!this.databasePath.startsWith(containedPrefix)) {
      throw pathError("The local team database resolves outside the project root.");
    }

    for (const path of [
      join(this.projectRoot, ".mex"),
      join(this.projectRoot, ".mex/local"),
      this.databasePath,
    ]) {
      if (!existsSync(path)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw pathError(`Refusing local state through symbolic link ${path}.`);
      }
      const canonical = realpathSync(path);
      if (canonical !== this.projectRoot && !canonical.startsWith(containedPrefix)) {
        throw pathError("The local team database resolves outside the project root.");
      }
    }
  }

  private assertExistingRevisionCanMatch(
    expectedRevision: Revision | null,
    label: string,
  ): void {
    this.assertDatabasePathSafe();
    if (expectedRevision !== null && !existsSync(this.databasePath)) {
      throw revisionConflict(`The ${label} does not exist; reload it and retry.`);
    }
  }
}

/** Stable cursor key. Git identity data is hashed and never appears in the key. */
export function canonicalActorKey(actor: ActorRef): string | null {
  if (actor.kind === "unknown") return null;
  if (actor.kind === "member") return validateMemberId(actor.memberId);

  const name = normalizeIdentityKeyPart(actor.name);
  const email = normalizeIdentityKeyPart(actor.email);
  if (name === null && email === null) return null;
  const digest = sha256(JSON.stringify({ name, email }));
  return `git:${digest}`;
}

interface DecodedDraftCursor {
  version: typeof LOCAL_DRAFT_CURSOR_VERSION;
  scaffoldId: string;
  requestedKind: TeamLocalDraftKind | null;
  corpusRevision: Revision;
  updatedAt: string;
  kind: TeamLocalDraftKind;
  id: string;
}

interface WorkflowOperationRevisionInput {
  scaffoldId: string;
  operationId: string;
  commandRevision: Revision;
  previewRevision: Revision;
  phase: TeamWorkflowJournalPhase;
  effectsJson: string;
  createdAt: string;
  updatedAt: string;
}

function validateDraftKind(value: unknown): TeamLocalDraftKind {
  if (value !== "inbox" && value !== "relay") {
    throw validationError("Draft kind must be inbox or relay.");
  }
  return value;
}

function validateStoredDraftKind(value: unknown): TeamLocalDraftKind {
  if (value !== "inbox" && value !== "relay") {
    throw corruptError("A persisted local draft has an invalid kind.");
  }
  return value;
}

function draftTable(kind: TeamLocalDraftKind): "inbox_drafts" | "relay_drafts" {
  return kind === "inbox" ? "inbox_drafts" : "relay_drafts";
}

function validateLocalIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOCAL_IDENTIFIER.test(value)) {
    throw validationError(
      `${label} must be a bounded ASCII identifier without paths or whitespace.`,
    );
  }
  return value;
}

function validateStoredLocalIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOCAL_IDENTIFIER.test(value)) {
    throw corruptError(`A persisted ${label} is invalid.`);
  }
  return value;
}

function validateRequiredRevision(value: unknown, label: string): Revision {
  if (typeof value !== "string" || !isRevision(value)) {
    throw validationError(`${label} must be a lower-case SHA-256 revision.`);
  }
  return value;
}

function canonicalDraftPayloadJson(value: unknown): string {
  return canonicalBoundedJson(value, TEAM_LOCAL_STATE_LIMITS.maxDraftBytes, "draft payload");
}

function parseCanonicalDraftPayload<TPayload>(json: string): TPayload {
  if (Buffer.byteLength(json, "utf8") > TEAM_LOCAL_STATE_LIMITS.maxDraftBytes) {
    throw corruptError("A persisted local draft exceeds the byte limit.");
  }
  try {
    const parsed: unknown = JSON.parse(json);
    const canonical = canonicalDraftPayloadJson(parsed);
    if (canonical !== json) throw new Error("not canonical");
    return parsed as TPayload;
  } catch (error) {
    if (error instanceof MexPortError && error.problem.code === "INDEX_CORRUPT") throw error;
    throw corruptError("A persisted local draft payload is invalid or non-canonical.");
  }
}

function localDraftRevision(
  scaffoldId: string,
  id: string,
  kind: TeamLocalDraftKind,
  payloadJson: string,
  updatedAt: string,
): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_STATE_RECORD_REVISION_VERSION,
    scaffoldId,
    id,
    kind,
    payload: JSON.parse(payloadJson) as unknown,
    updatedAt,
  }));
}

function readLocalDraft<TPayload>(
  db: DatabaseSync,
  scaffoldId: string,
  id: string,
): StoredLocalDraft<TPayload> | null {
  const rows: Array<{ row: LocalDraftRow; kind: TeamLocalDraftKind }> = [];
  for (const kind of ["inbox", "relay"] as const) {
    const row = db.prepare(`
      SELECT scaffold_id, id, payload_json, updated_at, revision
      FROM ${draftTable(kind)}
      WHERE scaffold_id = ? AND id = ?
    `).get(scaffoldId, id) as LocalDraftRow | undefined;
    if (row) rows.push({ row, kind });
  }
  if (rows.length > 1) {
    throw corruptError(`Local draft ID ${id} is duplicated across draft kinds.`);
  }
  const found = rows[0];
  return found ? decodeLocalDraft<TPayload>(found.row, scaffoldId, found.kind) : null;
}

function readBoundedLocalDraftCorpus<TPayload>(
  db: DatabaseSync,
  scaffoldId: string,
): StoredLocalDraft<TPayload>[] {
  const corpus: StoredLocalDraft<TPayload>[] = [];
  const ids = new Set<string>();
  for (const kind of ["inbox", "relay"] as const) {
    const rows = db.prepare(`
      SELECT scaffold_id, id, payload_json, updated_at, revision
      FROM ${draftTable(kind)}
      WHERE scaffold_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(
      scaffoldId,
      TEAM_LOCAL_STATE_LIMITS.maxDraftsPerKindPerScaffold + 1,
    ) as unknown as LocalDraftRow[];
    if (rows.length > TEAM_LOCAL_STATE_LIMITS.maxDraftsPerKindPerScaffold) {
      throw corruptError(`The persisted ${kind} draft corpus exceeds its record limit.`);
    }
    for (const row of rows) {
      const draft = decodeLocalDraft<TPayload>(row, scaffoldId, kind);
      if (ids.has(draft.id)) {
        throw corruptError(`Local draft ID ${draft.id} is duplicated across draft kinds.`);
      }
      ids.add(draft.id);
      corpus.push(draft);
    }
  }
  return corpus.sort(compareLocalDraftPageOrder);
}

function compareLocalDraftPageOrder(
  left: StoredLocalDraft,
  right: StoredLocalDraft,
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  if (left.kind !== right.kind) return compareCodeUnits(left.kind, right.kind);
  return -compareCodeUnits(left.id, right.id);
}

function localDraftCorpusRevision(
  scaffoldId: string,
  corpus: readonly StoredLocalDraft[],
): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_DRAFT_CURSOR_VERSION,
    scaffoldId,
    drafts: corpus.map((draft) => ({
      kind: draft.kind,
      id: draft.id,
      updatedAt: draft.updatedAt,
      revision: draft.revision,
    })),
  }));
}

function assertDraftCursorAuthority(
  cursor: DecodedDraftCursor | null,
  scaffoldId: string,
  requestedKind: TeamLocalDraftKind | undefined,
  corpusRevision: Revision,
): void {
  if (cursor === null) return;
  if (cursor.scaffoldId !== scaffoldId) {
    throw revisionConflict("The draft cursor belongs to a different scaffold; restart pagination.");
  }
  if (cursor.requestedKind !== (requestedKind ?? null)) {
    throw revisionConflict("The draft cursor filter changed; restart pagination.");
  }
  if (cursor.corpusRevision !== corpusRevision) {
    throw revisionConflict("The local draft corpus changed; restart pagination.");
  }
}

function draftCursorStartIndex(
  corpus: readonly StoredLocalDraft[],
  cursor: DecodedDraftCursor,
): number {
  const index = corpus.findIndex((draft) => (
    draft.updatedAt === cursor.updatedAt
    && draft.kind === cursor.kind
    && draft.id === cursor.id
  ));
  if (index < 0) {
    throw revisionConflict("The draft cursor position is no longer present; restart pagination.");
  }
  return index + 1;
}

function decodeLocalDraft<TPayload>(
  row: LocalDraftRow,
  expectedScaffoldId: string,
  kind: TeamLocalDraftKind,
): StoredLocalDraft<TPayload> {
  if (row.scaffold_id !== expectedScaffoldId) {
    throw corruptError("Local draft scaffold mismatch.");
  }
  const id = validateStoredLocalIdentifier(row.id, "local draft ID");
  if (typeof row.payload_json !== "string") {
    throw corruptError("A persisted local draft payload is not JSON text.");
  }
  if (typeof row.updated_at !== "string" || !isCanonicalTimestamp(row.updated_at)) {
    throw corruptError("A persisted local draft timestamp is invalid.");
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("A persisted local draft revision is invalid.");
  }
  const payload = parseCanonicalDraftPayload<TPayload>(row.payload_json);
  const expectedRevision = localDraftRevision(
    expectedScaffoldId,
    id,
    kind,
    row.payload_json,
    row.updated_at,
  );
  if (expectedRevision !== row.revision) {
    throw corruptError("A persisted local draft revision does not match its content.");
  }
  return {
    scaffoldId: expectedScaffoldId,
    id,
    kind,
    payload,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function assertDraftCapacity(
  db: DatabaseSync,
  scaffoldId: string,
  kind: TeamLocalDraftKind,
): void {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${draftTable(kind)}
    WHERE scaffold_id = ?
  `).get(scaffoldId) as { count: unknown };
  const count = sqliteInteger(row.count);
  if (count === null || count < 0) throw corruptError("The local draft count is invalid.");
  if (count >= TEAM_LOCAL_STATE_LIMITS.maxDraftsPerKindPerScaffold) {
    throw validationError(
      `The ${kind} draft limit of ${TEAM_LOCAL_STATE_LIMITS.maxDraftsPerKindPerScaffold} was reached.`,
    );
  }
}

function deleteLocalDraftExact(
  db: DatabaseSync,
  scaffoldId: string,
  kind: TeamLocalDraftKind,
  id: string,
  expectedRevision: Revision,
): void {
  const current = readLocalDraft(db, scaffoldId, id);
  if (current && current.kind !== kind) {
    throw revisionConflict(`Draft ID ${id} belongs to ${current.kind}, not ${kind}.`);
  }
  assertExpectedRevision(current?.revision ?? null, expectedRevision, `${kind} draft`);
  const deleted = db.prepare(`
    DELETE FROM ${draftTable(kind)}
    WHERE scaffold_id = ? AND id = ? AND revision = ?
  `).run(scaffoldId, id, expectedRevision);
  if (Number(deleted.changes) !== 1) {
    throw revisionConflict(`The ${kind} draft changed before deletion.`);
  }
}

function validateDraftPageLimit(value: number | undefined): number {
  if (value === undefined) return TEAM_LOCAL_STATE_LIMITS.defaultDraftPageSize;
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > TEAM_LOCAL_STATE_LIMITS.maxDraftPageSize
  ) {
    throw validationError(
      `Draft page limit must be between 1 and ${TEAM_LOCAL_STATE_LIMITS.maxDraftPageSize}.`,
    );
  }
  return value;
}

function encodeDraftCursor(cursor: Omit<DecodedDraftCursor, "version">): string {
  const json = JSON.stringify({
    version: LOCAL_DRAFT_CURSOR_VERSION,
    scaffoldId: cursor.scaffoldId,
    requestedKind: cursor.requestedKind,
    corpusRevision: cursor.corpusRevision,
    updatedAt: cursor.updatedAt,
    kind: cursor.kind,
    id: cursor.id,
  });
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > TEAM_LOCAL_STATE_LIMITS.maxCursorBytes) {
    throw corruptError("The generated local draft cursor exceeds its byte limit.");
  }
  return encoded;
}

function decodeDraftCursor(value: string | undefined): DecodedDraftCursor | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > TEAM_LOCAL_STATE_LIMITS.maxCursorBytes
  ) {
    throw invalidDraftCursor("Draft cursor is empty or exceeds the byte limit.");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw invalidDraftCursor("Draft cursor is not valid base64url.");
  }
  if (bytes.toString("base64url") !== value) {
    throw invalidDraftCursor("Draft cursor is not canonical base64url.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidDraftCursor("Draft cursor is not valid JSON.");
  }
  if (!isStrictPlainObject(parsed)) {
    throw invalidDraftCursor("Draft cursor has an invalid shape.");
  }
  const keys = Object.keys(parsed);
  const expectedKeys = [
    "version",
    "scaffoldId",
    "requestedKind",
    "corpusRevision",
    "updatedAt",
    "kind",
    "id",
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || JSON.stringify(parsed) !== bytes.toString("utf8")
  ) {
    throw invalidDraftCursor("Draft cursor is not in its canonical versioned form.");
  }
  if (parsed.version !== LOCAL_DRAFT_CURSOR_VERSION) {
    throw invalidDraftCursor("Draft cursor version is unsupported.");
  }
  if (
    typeof parsed.scaffoldId !== "string"
    || parsed.scaffoldId.length === 0
    || parsed.scaffoldId.length > 512
    || /[\0-\x1f\x7f]/.test(parsed.scaffoldId)
  ) {
    throw invalidDraftCursor("Draft cursor scaffold is invalid.");
  }
  if (parsed.requestedKind !== null && parsed.requestedKind !== "inbox" && parsed.requestedKind !== "relay") {
    throw invalidDraftCursor("Draft cursor filter is invalid.");
  }
  if (typeof parsed.corpusRevision !== "string" || !isRevision(parsed.corpusRevision)) {
    throw invalidDraftCursor("Draft cursor corpus revision is invalid.");
  }
  if (typeof parsed.updatedAt !== "string" || !isCanonicalTimestamp(parsed.updatedAt)) {
    throw invalidDraftCursor("Draft cursor timestamp is invalid.");
  }
  if (parsed.kind !== "inbox" && parsed.kind !== "relay") {
    throw invalidDraftCursor("Draft cursor position kind is invalid.");
  }
  if (typeof parsed.id !== "string" || !LOCAL_IDENTIFIER.test(parsed.id)) {
    throw invalidDraftCursor("Draft cursor position ID is invalid.");
  }
  return {
    version: LOCAL_DRAFT_CURSOR_VERSION,
    scaffoldId: parsed.scaffoldId,
    requestedKind: parsed.requestedKind,
    corpusRevision: parsed.corpusRevision,
    updatedAt: parsed.updatedAt,
    kind: parsed.kind,
    id: parsed.id,
  };
}

function invalidDraftCursor(detail: string): MexPortError {
  return new MexPortError({
    title: "Invalid local draft cursor",
    status: 422,
    code: "INVALID_REQUEST",
    detail,
  });
}

function validateWorkflowLeaseToken(value: unknown): string {
  if (typeof value !== "string" || !HUB_LEASE_TOKEN.test(value)) {
    throw validationError("Team workflow lease tokens must be lower-case 256-bit hex values.");
  }
  return value;
}

function readTeamWorkflowLease(db: DatabaseSync): TeamWorkflowLease | null {
  const rows = db.prepare(`
    SELECT singleton, scaffold_id, pid, token, acquired_at
    FROM team_workflow_lease
    WHERE singleton = 1
  `).all() as unknown as TeamWorkflowLeaseRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || sqliteInteger(rows[0]?.singleton) !== 1) {
    throw corruptError("The Team workflow lease row is invalid.");
  }
  const row = rows[0]!;
  const scaffoldId = validateStoredScaffoldId(row.scaffold_id);
  const pid = sqliteInteger(row.pid);
  if (pid === null || pid < 1) throw corruptError("The Team workflow lease PID is invalid.");
  if (typeof row.token !== "string" || !HUB_LEASE_TOKEN.test(row.token)) {
    throw corruptError("The Team workflow lease token is invalid.");
  }
  if (typeof row.acquired_at !== "string" || !isCanonicalTimestamp(row.acquired_at)) {
    throw corruptError("The Team workflow lease timestamp is invalid.");
  }
  return { scaffoldId, pid, token: row.token, acquiredAt: row.acquired_at };
}

function assertTeamWorkflowLease(
  db: DatabaseSync,
  scaffoldId: string,
  token: string,
): void {
  const current = readTeamWorkflowLease(db);
  if (!current || current.scaffoldId !== scaffoldId || current.token !== token) {
    throw revisionConflict("The Team workflow lease is absent or no longer owned.");
  }
}

function canonicalWorkflowEffectsJson(value: unknown): string {
  if (!Array.isArray(value)) throw validationError("Workflow effects must be an array.");
  if (value.length > TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffects) {
    throw validationError(
      `Workflow journal entries may contain at most ${TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffects} effects.`,
    );
  }
  const normalized = value.map((effect, index) => normalizeWorkflowEffect(effect, index));
  const keys = new Set<string>();
  for (const effect of normalized) {
    const key = workflowEffectKey(effect);
    if (keys.has(key)) throw validationError(`Workflow effect ${key} is duplicated.`);
    keys.add(key);
  }
  return canonicalBoundedJson(
    normalized,
    TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes,
    "workflow effects",
  );
}

function parseWorkflowEffects(json: string): readonly TeamWorkflowJournalEffect[] {
  if (Buffer.byteLength(json, "utf8") > TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes) {
    throw corruptError("Persisted workflow effects exceed the byte limit.");
  }
  try {
    const parsed: unknown = JSON.parse(json);
    const canonical = canonicalWorkflowEffectsJson(parsed);
    if (canonical !== json) throw new Error("not canonical");
    return parsed as readonly TeamWorkflowJournalEffect[];
  } catch {
    throw corruptError("Persisted workflow effects are invalid or non-canonical.");
  }
}

function normalizeWorkflowEffect(value: unknown, index: number): TeamWorkflowJournalEffect {
  if (!isStrictPlainObject(value) || typeof value.kind !== "string") {
    throw validationError(`Workflow effect ${index} has an invalid shape.`);
  }
  if (value.kind === "canonical") {
    assertOnlyKeys(
      value,
      ["kind", "namespace", "id", "path", "beforeRevision", "afterRevision"],
      `Workflow effect ${index}`,
    );
    const beforeRevision = validateNullableRevision(value.beforeRevision, "beforeRevision");
    const afterRevision = validateNullableRevision(value.afterRevision, "afterRevision");
    if (beforeRevision === null && afterRevision === null) {
      throw validationError(`Workflow effect ${index} must change a revision.`);
    }
    return {
      kind: "canonical",
      namespace: validateWorkflowNamespace(value.namespace),
      id: validateLocalIdentifier(value.id, `workflow effect ${index} ID`),
      path: validateJournalPath(value.path),
      beforeRevision,
      afterRevision,
    };
  }
  if (value.kind === "local") {
    assertOnlyKeys(
      value,
      ["kind", "namespace", "id", "beforeRevision", "afterRevision"],
      `Workflow effect ${index}`,
    );
    const beforeRevision = validateNullableRevision(value.beforeRevision, "beforeRevision");
    const afterRevision = validateNullableRevision(value.afterRevision, "afterRevision");
    if (beforeRevision === null && afterRevision === null) {
      throw validationError(`Workflow effect ${index} must change a revision.`);
    }
    return {
      kind: "local",
      namespace: validateWorkflowNamespace(value.namespace),
      id: validateLocalIdentifier(value.id, `workflow effect ${index} ID`),
      beforeRevision,
      afterRevision,
    };
  }
  if (value.kind === "local_cleanup") {
    assertOnlyKeys(
      value,
      ["kind", "draftKind", "draftId", "expectedRevision"],
      `Workflow effect ${index}`,
    );
    return {
      kind: "local_cleanup",
      draftKind: validateDraftKind(value.draftKind),
      draftId: validateLocalIdentifier(value.draftId, `workflow effect ${index} draft ID`),
      expectedRevision: validateRequiredRevision(
        value.expectedRevision,
        `workflow effect ${index} draft revision`,
      ),
    };
  }
  if (value.kind === "activity") {
    const schemaVersion = value.schemaVersion === 2 ? 2 : 1;
    assertOnlyKeys(
      value,
      schemaVersion === 1
        ? [
            "kind", "id", "path", "revision", "action", "actor", "occurredAt",
            "repoState", "subjects", "workstream", "metadata",
          ]
        : [
            "kind", "schemaVersion", "id", "path", "revision", "action", "actor",
            "occurredAt", "repoState", "subjects", "workstream", "metadata",
            "origin",
          ],
      `Workflow effect ${index}`,
    );
    const common: ActivityWorkflowEffectV1 = {
      kind: "activity",
      id: validateLocalIdentifier(value.id, `workflow effect ${index} Activity ID`),
      path: validateJournalPath(value.path),
      revision: validateRequiredRevision(value.revision, `workflow effect ${index} revision`),
      action: validateBoundedAuditText(value.action, "Activity action", 256),
      actor: normalizeJournalActor(value.actor),
      occurredAt: validateTimestamp(value.occurredAt as string, "Activity occurredAt"),
      repoState: normalizeJournalRepoState(value.repoState),
      subjects: normalizeJournalSubjects(value.subjects),
      ...(value.workstream === undefined
        ? {}
        : { workstream: normalizeJournalEntityRef(value.workstream, "Activity workstream") }),
      ...(value.metadata === undefined
        ? {}
        : { metadata: normalizeActivityMetadata(value.metadata) }),
    };
    if (schemaVersion === 1) return common;
    return {
      ...common,
      schemaVersion: 2,
      origin: normalizeJournalActivityOrigin(value.origin),
    };
  }
  if (value.kind === "identity_activity_receipt") {
    assertOnlyKeys(
      value,
      ["kind", "envelopeRevision"],
      `Workflow effect ${index}`,
    );
    return {
      kind: "identity_activity_receipt",
      envelopeRevision: validateRequiredRevision(
        value.envelopeRevision,
        `workflow effect ${index} envelope revision`,
      ),
    };
  }
  if (value.kind === "wiki_recovery") {
    assertOnlyKeys(value, ["kind", "manifest"], `Workflow effect ${index}`);
    return {
      kind: "wiki_recovery",
      manifest: normalizeWikiRecoveryManifest(value.manifest),
    };
  }
  throw validationError(`Workflow effect ${index} has an unsupported kind.`);
}

function workflowEffectKey(effect: TeamWorkflowJournalEffect): string {
  if (effect.kind === "activity") return `activity:${effect.id}`;
  if (effect.kind === "identity_activity_receipt") return effect.kind;
  if (effect.kind === "local_cleanup") return `cleanup:${effect.draftKind}:${effect.draftId}`;
  if (effect.kind === "wiki_recovery") {
    return `wiki-recovery:${effect.manifest.operationId}`;
  }
  return `${effect.kind}:${effect.namespace}:${effect.id}`;
}

function normalizeWikiRecoveryManifest(value: unknown): WikiOperationRecoveryManifest {
  if (!isStrictPlainObject(value)) {
    throw validationError("Wiki recovery manifest has an invalid shape.");
  }
  assertOnlyKeys(
    value,
    ["schemaVersion", "requestHash", "operationId", "items"],
    "Wiki recovery manifest",
  );
  if (value.schemaVersion !== 1) {
    throw validationError("Wiki recovery manifest schema is unsupported.");
  }
  const operationId = validateLocalIdentifier(
    value.operationId,
    "Wiki recovery operation ID",
  );
  const requestHash = validateRequiredRevision(
    value.requestHash,
    "Wiki recovery request hash",
  );
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 25) {
    throw validationError("Wiki recovery manifest must contain between 1 and 25 items.");
  }
  let totalFiles = 0;
  const seenOperations = new Set<string>();
  const items = value.items.map((rawItem, itemIndex) => {
    if (!isStrictPlainObject(rawItem)) {
      throw validationError(`Wiki recovery item ${itemIndex} has an invalid shape.`);
    }
    assertOnlyKeys(
      rawItem,
      [
        "operationId", "type", "payloadHash", "createdIds", "files",
        "revisions", "audit",
      ],
      `Wiki recovery item ${itemIndex}`,
    );
    const itemOperationId = validateLocalIdentifier(
      rawItem.operationId,
      `Wiki recovery item ${itemIndex} operation ID`,
    );
    if (seenOperations.has(itemOperationId)) {
      throw validationError("Wiki recovery operation IDs must be unique.");
    }
    seenOperations.add(itemOperationId);
    if (
      typeof rawItem.type !== "string"
      || !(WIKI_OPERATION_TYPES as readonly string[]).includes(rawItem.type)
    ) {
      throw validationError(`Wiki recovery item ${itemIndex} type is invalid.`);
    }
    if (!Array.isArray(rawItem.createdIds) || rawItem.createdIds.length > 64) {
      throw validationError(`Wiki recovery item ${itemIndex} created IDs are invalid.`);
    }
    const createdIds = rawItem.createdIds.map((id) => validateLocalIdentifier(
      id,
      `Wiki recovery item ${itemIndex} created ID`,
    ));
    if (new Set(createdIds).size !== createdIds.length) {
      throw validationError(`Wiki recovery item ${itemIndex} created IDs must be unique.`);
    }
    if (!Array.isArray(rawItem.files) || rawItem.files.length > 100) {
      throw validationError(`Wiki recovery item ${itemIndex} files are invalid.`);
    }
    totalFiles += rawItem.files.length;
    if (totalFiles > 100) {
      throw validationError("Wiki recovery manifest contains too many file records.");
    }
    const seenFiles = new Set<string>();
    const files = rawItem.files.map((rawFile, fileIndex) => {
      if (!isStrictPlainObject(rawFile)) {
        throw validationError(`Wiki recovery file ${itemIndex}:${fileIndex} is invalid.`);
      }
      assertOnlyKeys(
        rawFile,
        ["path", "beforeRevision", "afterRevision"],
        `Wiki recovery file ${itemIndex}:${fileIndex}`,
      );
      const path = validateJournalPath(rawFile.path);
      if (seenFiles.has(path)) {
        throw validationError(`Wiki recovery item ${itemIndex} file paths must be unique.`);
      }
      seenFiles.add(path);
      return {
        path,
        beforeRevision: validateNullableRevision(
          rawFile.beforeRevision,
          `Wiki recovery file ${itemIndex}:${fileIndex} before revision`,
        ),
        afterRevision: validateRequiredRevision(
          rawFile.afterRevision,
          `Wiki recovery file ${itemIndex}:${fileIndex} after revision`,
        ),
      };
    });
    if (!Array.isArray(rawItem.revisions) || rawItem.revisions.length > 100) {
      throw validationError(`Wiki recovery item ${itemIndex} revisions are invalid.`);
    }
    const seenEntities = new Set<string>();
    const revisions = rawItem.revisions.map((rawRevision, revisionIndex) => {
      if (!isStrictPlainObject(rawRevision)) {
        throw validationError(`Wiki recovery revision ${itemIndex}:${revisionIndex} is invalid.`);
      }
      assertOnlyKeys(
        rawRevision,
        ["entityId", "before", "after"],
        `Wiki recovery revision ${itemIndex}:${revisionIndex}`,
      );
      const entityId = validateLocalIdentifier(
        rawRevision.entityId,
        `Wiki recovery revision ${itemIndex}:${revisionIndex} entity ID`,
      );
      if (seenEntities.has(entityId)) {
        throw validationError(`Wiki recovery item ${itemIndex} entity revisions must be unique.`);
      }
      seenEntities.add(entityId);
      const before = validateWikiSemanticRevision(rawRevision.before);
      const after = validateWikiSemanticRevision(rawRevision.after);
      if (after < before) {
        throw validationError("Wiki recovery semantic revisions must be monotonic.");
      }
      return { entityId, before, after };
    });
    if (!isStrictPlainObject(rawItem.audit)) {
      throw validationError(`Wiki recovery item ${itemIndex} audit state is invalid.`);
    }
    assertOnlyKeys(
      rawItem.audit,
      ["beforeRevision", "afterRevision"],
      `Wiki recovery item ${itemIndex} audit state`,
    );
    return {
      operationId: itemOperationId,
      type: rawItem.type as WikiOperationRecoveryManifest["items"][number]["type"],
      payloadHash: validateRequiredRevision(
        rawItem.payloadHash,
        `Wiki recovery item ${itemIndex} payload hash`,
      ),
      createdIds,
      files,
      revisions,
      audit: {
        beforeRevision: validateNullableRevision(
          rawItem.audit.beforeRevision,
          `Wiki recovery item ${itemIndex} audit before revision`,
        ),
        afterRevision: validateRequiredRevision(
          rawItem.audit.afterRevision,
          `Wiki recovery item ${itemIndex} audit after revision`,
        ),
      },
    };
  });
  return { schemaVersion: 1, requestHash, operationId, items };
}

function validateWikiSemanticRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw validationError("Wiki recovery semantic revision is invalid.");
  }
  return value as number;
}

function validateWorkflowNamespace(value: unknown): string {
  if (typeof value !== "string" || !WORKFLOW_NAMESPACE.test(value)) {
    throw validationError("Workflow effect namespace is invalid.");
  }
  return value;
}

function validateNullableRevision(value: unknown, label: string): Revision | null {
  if (value === null) return null;
  return validateRequiredRevision(value, label);
}

function validateJournalPath(value: unknown): RepoRelativePath {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 1024
    || value.startsWith("/")
    || value.includes("\\")
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    throw validationError("Workflow effect path must be a bounded repository-relative path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw validationError("Workflow effect path contains an unsafe segment.");
  }
  return value;
}

function normalizeJournalActor(value: unknown): ActorRef {
  if (!isStrictPlainObject(value) || typeof value.kind !== "string") {
    throw validationError("Activity actor has an invalid shape.");
  }
  if (value.kind === "unknown") {
    assertOnlyKeys(value, ["kind"], "Activity actor");
    return { kind: "unknown" };
  }
  if (value.kind === "member") {
    assertOnlyKeys(value, ["kind", "memberId", "displayName"], "Activity actor");
    return {
      kind: "member",
      memberId: validateMemberId(value.memberId as string),
      ...(value.displayName === undefined
        ? {}
        : { displayName: validateBoundedAuditText(value.displayName, "member display name", 512) }),
    };
  }
  if (value.kind === "git") {
    assertOnlyKeys(value, ["kind", "name", "email"], "Activity actor");
    const name = value.name === null
      ? null
      : validateBoundedAuditText(value.name, "Git actor name", 512);
    const email = value.email === null
      ? null
      : validateBoundedAuditText(value.email, "Git actor email", 512).toLowerCase();
    if (name === null && email === null) {
      throw validationError("A Git Activity actor must have a name or email.");
    }
    return { kind: "git", name, email };
  }
  throw validationError("Activity actor kind is unsupported.");
}

function normalizeJournalRepoState(value: unknown): RepoState {
  if (!isStrictPlainObject(value)) throw validationError("Activity repository state is invalid.");
  assertOnlyKeys(value, ["branch", "head", "dirty", "observedAt"], "Activity repository state");
  return {
    branch: validateBranch(value.branch as string | null),
    head: validateHead(value.head as string | null),
    dirty: validateBoolean(value.dirty, "Activity repository dirty state"),
    observedAt: validateTimestamp(value.observedAt as string, "Activity observedAt"),
  };
}

function normalizeJournalActivityOrigin(value: unknown): ActivityRecordOrigin {
  if (!isStrictPlainObject(value) || typeof value.kind !== "string") {
    throw validationError("Activity origin is invalid.");
  }
  if (value.kind === "custom") {
    assertOnlyKeys(value, ["kind"], "Activity custom origin");
    return { kind: "custom" };
  }
  if (value.kind === "workflow") {
    assertOnlyKeys(value, ["kind", "operation"], "Activity workflow origin");
    const operation = validateBoundedAuditText(
      value.operation,
      "Activity workflow operation",
      128,
    );
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(operation)) {
      throw validationError("Activity workflow operation is invalid.");
    }
    return { kind: "workflow", operation };
  }
  throw validationError("Activity origin kind is unsupported.");
}

function normalizeJournalSubjects(value: unknown): readonly ActivitySubjectRef[] {
  if (!Array.isArray(value) || value.length > ACTIVITY_SUBJECT_LIMIT) {
    throw validationError(
      `Activity subjects must be an array of at most ${ACTIVITY_SUBJECT_LIMIT} entries.`,
    );
  }
  return value.map((subject, index) => {
    if (!isStrictPlainObject(subject) || typeof subject.kind !== "string") {
      throw validationError(`Activity subject ${index} has an invalid shape.`);
    }
    if (subject.kind === "entity") {
      assertOnlyKeys(subject, ["kind", "entity"], `Activity subject ${index}`);
      return {
        kind: "entity" as const,
        entity: normalizeJournalEntityRef(subject.entity, `Activity subject ${index} entity`),
      };
    }
    if (subject.kind === "file") {
      assertOnlyKeys(subject, ["kind", "path"], `Activity subject ${index}`);
      return { kind: "file" as const, path: validateJournalPath(subject.path) };
    }
    if (subject.kind === "commit") {
      assertOnlyKeys(subject, ["kind", "hash"], `Activity subject ${index}`);
      return { kind: "commit" as const, hash: validateHead(subject.hash as string)! };
    }
    if (subject.kind === "code") {
      assertOnlyKeys(subject, ["kind", "code"], `Activity subject ${index}`);
      return { kind: "code" as const, code: normalizeJournalCodeRef(subject.code, index) };
    }
    throw validationError(`Activity subject ${index} has an unsupported kind.`);
  });
}

function normalizeJournalEntityRef(value: unknown, label: string): EntityRef {
  if (!isStrictPlainObject(value)) throw validationError(`${label} has an invalid shape.`);
  assertOnlyKeys(value, ["id", "kind", "title"], label);
  return {
    id: validateLocalIdentifier(value.id, `${label} ID`),
    kind: validateJournalEntityKind(value.kind),
    ...(value.title === undefined
      ? {}
      : { title: validateBoundedAuditText(value.title, `${label} title`, 512) }),
  };
}

function validateJournalEntityKind(value: unknown): string {
  if (
    typeof value !== "string"
    || (!WORKFLOW_NAMESPACE.test(value)
      && !JOURNAL_ENTITY_KIND_EXCEPTIONS.has(value))
  ) {
    throw validationError("Activity subject entity kind is invalid.");
  }
  return value;
}

function normalizeJournalCodeRef(value: unknown, index: number): CodeRef {
  if (!isStrictPlainObject(value) || typeof value.kind !== "string") {
    throw validationError(`Activity subject ${index} code reference is invalid.`);
  }
  if (value.kind === "symbol") {
    assertOnlyKeys(value, ["kind", "symbolId", "fingerprint"], `Activity subject ${index} code`);
    return {
      kind: "symbol",
      symbolId: validateBoundedAuditText(value.symbolId, "symbol ID", 512),
      ...(value.fingerprint === undefined
        ? {}
        : { fingerprint: validateBoundedAuditText(value.fingerprint, "symbol fingerprint", 512) }),
    };
  }
  if (value.kind === "file") {
    assertOnlyKeys(value, ["kind", "path", "fingerprint"], `Activity subject ${index} code`);
    return {
      kind: "file",
      path: validateJournalPath(value.path),
      ...(value.fingerprint === undefined
        ? {}
        : { fingerprint: validateBoundedAuditText(value.fingerprint, "file fingerprint", 512) }),
    };
  }
  throw validationError(`Activity subject ${index} code reference kind is unsupported.`);
}

function normalizeActivityMetadata(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!isStrictPlainObject(value)) throw validationError("Activity metadata must be an object.");
  const keys = Object.keys(value);
  if (keys.length > 32) throw validationError("Activity metadata may contain at most 32 entries.");
  assertJournalMetadataPrivacy(value);
  const json = canonicalBoundedJson(value, 8 * 1024, "Activity metadata");
  return JSON.parse(json) as Readonly<Record<string, JsonValue>>;
}

function assertJournalMetadataPrivacy(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertJournalMetadataPrivacy(item);
    return;
  }
  if (!isStrictPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:body|source|prompt|transcript|diff|credential|secret|token|raw[-_]?error)/iu.test(key)) {
      throw validationError(`Activity metadata key ${key} is not safe for the workflow journal.`);
    }
    assertJournalMetadataPrivacy(child);
  }
}

function validateBoundedAuditText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  ) {
    throw validationError(`${label} must be non-empty bounded text.`);
  }
  return value.normalize("NFC");
}

function validateWorkflowPhase(value: unknown): TeamWorkflowJournalPhase {
  if (
    typeof value !== "string"
    || !TEAM_WORKFLOW_JOURNAL_PHASES.includes(value as TeamWorkflowJournalPhase)
  ) {
    throw validationError("Workflow operation phase is invalid.");
  }
  return value as TeamWorkflowJournalPhase;
}

function validateWorkflowAdvancePhase(
  value: unknown,
): Exclude<TeamWorkflowJournalPhase, "intent"> {
  const phase = validateWorkflowPhase(value);
  if (phase === "intent") throw validationError("Workflow operations cannot advance to intent.");
  return phase;
}

function assertNextWorkflowPhase(
  current: TeamWorkflowJournalPhase,
  next: TeamWorkflowJournalPhase,
): void {
  const currentIndex = TEAM_WORKFLOW_JOURNAL_PHASES.indexOf(current);
  const nextIndex = TEAM_WORKFLOW_JOURNAL_PHASES.indexOf(next);
  if (nextIndex !== currentIndex + 1) {
    throw revisionConflict(`Workflow operation cannot advance from ${current} to ${next}.`);
  }
}

function validateWorkflowDraftCleanups(
  value: readonly WorkflowDraftCleanupRequest[],
): readonly WorkflowDraftCleanupRequest[] {
  if (!Array.isArray(value) || value.length > TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffects) {
    throw validationError("Workflow draft cleanup list exceeds the effect limit.");
  }
  const seen = new Set<string>();
  return value.map((cleanup, index) => {
    if (!isStrictPlainObject(cleanup)) {
      throw validationError(`Workflow draft cleanup ${index} has an invalid shape.`);
    }
    assertOnlyKeys(cleanup, ["kind", "id", "expectedRevision"], `Workflow cleanup ${index}`);
    const normalized = {
      kind: validateDraftKind(cleanup.kind),
      id: validateLocalIdentifier(cleanup.id, `workflow cleanup ${index} ID`),
      expectedRevision: validateRequiredRevision(
        cleanup.expectedRevision,
        `workflow cleanup ${index} revision`,
      ),
    };
    const key = `${normalized.kind}:${normalized.id}`;
    if (seen.has(key)) throw validationError(`Workflow cleanup ${key} is duplicated.`);
    seen.add(key);
    return normalized;
  });
}

function assertCleanupRequestsMatchEffects(
  cleanups: readonly WorkflowDraftCleanupRequest[],
  effects: readonly TeamWorkflowJournalEffect[],
): void {
  const effectKeys = effects
    .filter((effect): effect is LocalCleanupWorkflowEffect => effect.kind === "local_cleanup")
    .map((effect) => `${effect.draftKind}:${effect.draftId}:${effect.expectedRevision}`)
    .sort(compareCodeUnits);
  const cleanupKeys = cleanups
    .map((cleanup) => `${cleanup.kind}:${cleanup.id}:${cleanup.expectedRevision}`)
    .sort(compareCodeUnits);
  if (
    effectKeys.length !== cleanupKeys.length
    || effectKeys.some((key, index) => key !== cleanupKeys[index])
  ) {
    throw validationError("local_finalized cleanup requests must exactly match journal effects.");
  }
}

function workflowOperationRevision(input: WorkflowOperationRevisionInput): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_STATE_RECORD_REVISION_VERSION,
    scaffoldId: input.scaffoldId,
    operationId: input.operationId,
    commandRevision: input.commandRevision,
    previewRevision: input.previewRevision,
    phase: input.phase,
    effects: JSON.parse(input.effectsJson) as unknown,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }));
}

function readWorkflowOperation(
  db: DatabaseSync,
  scaffoldId: string,
  operationId: string,
): TeamWorkflowJournalEntry | null {
  const row = db.prepare(`
    SELECT scaffold_id, operation_id, command_revision, preview_revision, phase, effects_json,
      created_at, updated_at, revision
    FROM team_workflow_operations
    WHERE scaffold_id = ? AND operation_id = ?
  `).get(scaffoldId, operationId) as TeamWorkflowOperationRow | undefined;
  return row ? decodeWorkflowOperation(row, scaffoldId) : null;
}

function readIncompleteWorkflowOperation(
  db: DatabaseSync,
  scaffoldId: string,
): TeamWorkflowJournalEntry | null {
  const rows = db.prepare(`
    SELECT scaffold_id, operation_id, command_revision, preview_revision, phase, effects_json,
      created_at, updated_at, revision
    FROM team_workflow_operations
    WHERE scaffold_id = ? AND phase <> 'complete'
    ORDER BY updated_at ASC, operation_id ASC
    LIMIT 2
  `).all(scaffoldId) as unknown as TeamWorkflowOperationRow[];
  if (rows.length > 1) {
    throw corruptError("More than one incomplete Team workflow operation exists for a scaffold.");
  }
  return rows[0] ? decodeWorkflowOperation(rows[0], scaffoldId) : null;
}

function readAnyIncompleteWorkflowOperation(
  db: DatabaseSync,
): TeamWorkflowJournalEntry | null {
  const rows = db.prepare(`
    SELECT scaffold_id, operation_id, command_revision, preview_revision, phase, effects_json,
      created_at, updated_at, revision
    FROM team_workflow_operations
    WHERE phase <> 'complete'
    ORDER BY updated_at ASC, scaffold_id ASC, operation_id ASC
    LIMIT 2
  `).all() as unknown as TeamWorkflowOperationRow[];
  if (rows.length > 1) {
    throw corruptError("More than one incomplete Team workflow operation exists in the repository.");
  }
  const row = rows[0];
  if (!row) return null;
  const scaffoldId = validateStoredScaffoldId(row.scaffold_id);
  return decodeWorkflowOperation(row, scaffoldId);
}

function decodeWorkflowOperation(
  row: TeamWorkflowOperationRow,
  expectedScaffoldId: string,
): TeamWorkflowJournalEntry {
  if (row.scaffold_id !== expectedScaffoldId) {
    throw corruptError("Workflow operation scaffold mismatch.");
  }
  const operationId = validateStoredLocalIdentifier(row.operation_id, "workflow operation ID");
  if (typeof row.command_revision !== "string" || !isRevision(row.command_revision)) {
    throw corruptError("A persisted workflow command revision is invalid.");
  }
  if (typeof row.preview_revision !== "string" || !isRevision(row.preview_revision)) {
    throw corruptError("A persisted workflow preview revision is invalid.");
  }
  let phase: TeamWorkflowJournalPhase;
  try {
    phase = validateWorkflowPhase(row.phase);
  } catch {
    throw corruptError("A persisted workflow operation phase is invalid.");
  }
  if (typeof row.effects_json !== "string") {
    throw corruptError("Persisted workflow effects are not JSON text.");
  }
  const effects = parseWorkflowEffects(row.effects_json);
  if (
    typeof row.created_at !== "string"
    || !isCanonicalTimestamp(row.created_at)
    || typeof row.updated_at !== "string"
    || !isCanonicalTimestamp(row.updated_at)
    || row.updated_at < row.created_at
  ) {
    throw corruptError("A persisted workflow operation timestamp is invalid.");
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("A persisted workflow operation revision is invalid.");
  }
  const expectedRevision = workflowOperationRevision({
    scaffoldId: expectedScaffoldId,
    operationId,
    commandRevision: row.command_revision,
    previewRevision: row.preview_revision,
    phase,
    effectsJson: row.effects_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (expectedRevision !== row.revision) {
    throw corruptError("A persisted workflow operation revision does not match its content.");
  }
  return {
    scaffoldId: expectedScaffoldId,
    operationId,
    commandRevision: row.command_revision,
    previewRevision: row.preview_revision,
    phase,
    effects,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function insertWorkflowOperation(
  db: DatabaseSync,
  entry: TeamWorkflowJournalEntry,
  effectsJson: string,
): void {
  db.prepare(`
    INSERT INTO team_workflow_operations (
      scaffold_id, operation_id, command_revision, preview_revision, phase, effects_json,
      created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.scaffoldId,
    entry.operationId,
    entry.commandRevision,
    entry.previewRevision,
    entry.phase,
    effectsJson,
    entry.createdAt,
    entry.updatedAt,
    entry.revision,
  );
}

function replaceWorkflowOperation(
  db: DatabaseSync,
  entry: TeamWorkflowJournalEntry,
  effectsJson: string,
  expectedRevision: Revision,
): void {
  const updated = db.prepare(`
    UPDATE team_workflow_operations
    SET phase = ?, effects_json = ?, updated_at = ?, revision = ?
    WHERE scaffold_id = ? AND operation_id = ?
      AND command_revision = ? AND preview_revision = ? AND revision = ?
  `).run(
    entry.phase,
    effectsJson,
    entry.updatedAt,
    entry.revision,
    entry.scaffoldId,
    entry.operationId,
    entry.commandRevision,
    entry.previewRevision,
    expectedRevision,
  );
  if (Number(updated.changes) !== 1) {
    throw revisionConflict("The workflow operation changed before phase advancement.");
  }
}

function pruneTerminalWorkflowOperations(
  db: DatabaseSync,
  scaffoldId: string,
  currentOperationId: string,
): number {
  const keepOthers = TEAM_LOCAL_STATE_LIMITS.terminalWorkflowRetention - 1;
  const deleted = db.prepare(`
    DELETE FROM team_workflow_operations
    WHERE scaffold_id = ?
      AND phase = 'complete'
      AND operation_id <> ?
      AND rowid NOT IN (
        SELECT rowid
        FROM team_workflow_operations
        WHERE scaffold_id = ?
          AND phase = 'complete'
          AND operation_id <> ?
        ORDER BY updated_at DESC, operation_id DESC
        LIMIT ?
      )
  `).run(scaffoldId, currentOperationId, scaffoldId, currentOperationId, keepOthers);
  return Number(deleted.changes);
}

function canonicalBoundedJson(value: unknown, maximumBytes: number, label: string): string {
  let budget = maximumBytes;
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 8192 || depth > 32) {
      throw validationError(`${label} exceeds the structural limit.`);
    }
    if (current === null || typeof current === "boolean") {
      budget -= current === null ? 4 : current ? 4 : 5;
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw validationError(`${label} contains a non-finite number.`);
      const normalized = Object.is(current, -0) ? 0 : current;
      budget -= String(normalized).length;
      return normalized;
    }
    if (typeof current === "string") {
      budget -= Buffer.byteLength(current, "utf8") + 2;
      if (budget < 0) throw validationError(`${label} exceeds the byte limit.`);
      return current.normalize("NFC");
    }
    if (Array.isArray(current)) {
      if (current.length > 4096) throw validationError(`${label} contains an oversized array.`);
      budget -= current.length + 2;
      return current.map((item) => visit(item, depth + 1));
    }
    if (!isStrictPlainObject(current)) {
      throw validationError(`${label} must contain only JSON values.`);
    }
    const keys = Object.keys(current).sort(compareCodeUnits);
    if (keys.length > 4096) throw validationError(`${label} contains too many object keys.`);
    const normalized: Record<string, unknown> = {};
    for (const keyValue of keys) {
      const key = keyValue.normalize("NFC");
      if (
        key.length === 0
        || Buffer.byteLength(key, "utf8") > 256
        || /[\0-\x1f\x7f]/.test(key)
      ) {
        throw validationError(`${label} contains an invalid object key.`);
      }
      budget -= Buffer.byteLength(key, "utf8") + 4;
      if (budget < 0) throw validationError(`${label} exceeds the byte limit.`);
      normalized[key] = visit(current[keyValue], depth + 1);
    }
    budget -= keys.length + 2;
    return normalized;
  };
  const normalized = visit(value, 0);
  const json = JSON.stringify(normalized);
  if (json === undefined || Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw validationError(`${label} exceeds the byte limit.`);
  }
  return json;
}

function isStrictPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw validationError("projectRoot must be a non-empty path.");
  }
  const absolute = resolve(projectRoot);
  try {
    const canonical = realpathSync(absolute);
    if (!statSync(canonical).isDirectory()) {
      throw validationError("projectRoot must identify an existing directory.");
    }
    return canonical;
  } catch {
    throw validationError("projectRoot must identify an existing directory.");
  }
}

function validateScaffoldId(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    throw validationError("scaffoldId must be a non-empty, bounded identifier.");
  }
  return value;
}

function validateStoredScaffoldId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    throw corruptError("A persisted Hub job contains an invalid scaffold identifier.");
  }
  return value;
}

function validateMemberId(value: string): string {
  if (typeof value !== "string" || !MEMBER_ID.test(value)) {
    throw validationError("Member IDs must use the member_<ULID> format.");
  }
  return value;
}

function validateTimestamp(value: string, label: string): string {
  if (typeof value !== "string") throw validationError(`${label} must be a UTC timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw validationError(`${label} must be an exact ISO 8601 UTC timestamp.`);
  }
  return value;
}

function validateExpectedRevision(value: Revision | null): Revision | null {
  if (value !== null && (typeof value !== "string" || !isRevision(value))) {
    throw validationError("expectedRevision must be null or a lower-case SHA-256 revision.");
  }
  return value;
}

function validateHead(value: string | null): string | null {
  if (value !== null && (typeof value !== "string" || !GIT_HEAD.test(value))) {
    throw validationError("head must be null or a complete lower-case Git object ID.");
  }
  return value;
}

function validateBranch(value: string | null): string | null {
  if (
    value !== null
    && (
      typeof value !== "string"
      || value.length === 0
      || value.length > 1024
      || /[\0-\x1f\x7f]/.test(value)
    )
  ) {
    throw validationError("branch must be null or a bounded Git branch name.");
  }
  return value;
}

function normalizeWritableActor(actor: ActorRef): Exclude<ActorRef, { kind: "unknown" }> {
  if (!actor || typeof actor !== "object") {
    throw validationError("A valid member or Git actor is required.");
  }
  if (actor.kind === "unknown") {
    throw validationError("Unknown actors cannot mark or reset a Catch Up cursor.");
  }
  if (actor.kind === "member") {
    const memberId = validateMemberId(actor.memberId);
    const displayName = normalizeDisplayValue(actor.displayName);
    return displayName === undefined
      ? { kind: "member", memberId }
      : { kind: "member", memberId, displayName };
  }
  if (actor.kind !== "git") throw validationError("Unsupported actor kind.");

  const name = normalizeDisplayValue(actor.name) ?? null;
  const email = normalizeEmail(actor.email);
  if (name === null && email === null) {
    throw validationError("A Git actor requires a name or email.");
  }
  return { kind: "git", name, email };
}

function normalizeDisplayValue(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw validationError("Actor identity fields must be strings.");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeEmail(value: string | null): string | null {
  const normalized = normalizeDisplayValue(value);
  return normalized?.toLowerCase() ?? null;
}

function normalizeIdentityKeyPart(value: string | null): string | null {
  const normalized = normalizeDisplayValue(value);
  return normalized?.toLowerCase() ?? null;
}

function configuredMemberRevision(
  scaffoldId: string,
  memberId: string,
  updatedAt: string,
): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_STATE_RECORD_REVISION_VERSION,
    scaffoldId,
    memberId,
    updatedAt,
  }));
}

function cursorRevision(cursor: Omit<StoredCatchUpCursor, "revision">): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_STATE_RECORD_REVISION_VERSION,
    scaffoldId: cursor.scaffoldId,
    actor: cursor.actor,
    head: cursor.head,
    branch: cursor.branch,
    timestamp: cursor.timestamp,
  }));
}

function sha256(value: string): Revision {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalActorJson(actor: Exclude<ActorRef, { kind: "unknown" }>): string {
  if (actor.kind === "git") {
    return JSON.stringify({ kind: "git", name: actor.name, email: actor.email });
  }
  return actor.displayName === undefined
    ? JSON.stringify({ kind: "member", memberId: actor.memberId })
    : JSON.stringify({
        kind: "member",
        memberId: actor.memberId,
        displayName: actor.displayName,
      });
}

function readConfiguredMember(
  db: DatabaseSync,
  scaffoldId: string,
): ConfiguredMemberSelection | null {
  const row = db.prepare(`
    SELECT scaffold_id, member_id, updated_at, revision
    FROM configured_member_selections
    WHERE scaffold_id = ?
  `).get(scaffoldId) as ConfiguredMemberRow | undefined;
  return row ? decodeConfiguredMember(row, scaffoldId) : null;
}

function decodeConfiguredMember(
  row: ConfiguredMemberRow,
  expectedScaffoldId: string,
): ConfiguredMemberSelection {
  if (row.scaffold_id !== expectedScaffoldId) throw corruptError("Configured-member scaffold mismatch.");
  if (typeof row.member_id !== "string" || !MEMBER_ID.test(row.member_id)) {
    throw corruptError("Configured-member row contains an invalid member ID.");
  }
  if (typeof row.updated_at !== "string" || !isCanonicalTimestamp(row.updated_at)) {
    throw corruptError("Configured-member row contains an invalid timestamp.");
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("Configured-member row contains an invalid revision.");
  }
  const expectedRevision = configuredMemberRevision(
    expectedScaffoldId,
    row.member_id,
    row.updated_at,
  );
  if (row.revision !== expectedRevision) {
    throw corruptError("Configured-member row failed its revision check.");
  }
  return {
    scaffoldId: expectedScaffoldId,
    memberId: row.member_id,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function readCatchUpCursor(
  db: DatabaseSync,
  scaffoldId: string,
  actorKey: string,
): StoredCatchUpCursor | null {
  const row = db.prepare(`
    SELECT scaffold_id, actor_key, actor_json, head, branch, timestamp, revision
    FROM catch_up_cursors
    WHERE scaffold_id = ? AND actor_key = ?
  `).get(scaffoldId, actorKey) as CatchUpCursorRow | undefined;
  return row ? decodeCatchUpCursor(row, scaffoldId, actorKey) : null;
}

function decodeCatchUpCursor(
  row: CatchUpCursorRow,
  expectedScaffoldId: string,
  expectedActorKey: string,
): StoredCatchUpCursor {
  if (row.scaffold_id !== expectedScaffoldId || row.actor_key !== expectedActorKey) {
    throw corruptError("Catch Up cursor key does not match its stored identity.");
  }
  if (typeof row.actor_json !== "string") throw corruptError("Catch Up actor is not valid JSON.");
  const actor = parseStoredActor(row.actor_json);
  if (canonicalActorKey(actor) !== expectedActorKey) {
    throw corruptError("Catch Up actor does not match its privacy-preserving key.");
  }
  if (row.head !== null && (typeof row.head !== "string" || !GIT_HEAD.test(row.head))) {
    throw corruptError("Catch Up cursor contains an invalid Git HEAD.");
  }
  if (row.branch !== null && !isValidStoredBranch(row.branch)) {
    throw corruptError("Catch Up cursor contains an invalid branch.");
  }
  if (typeof row.timestamp !== "string" || !isCanonicalTimestamp(row.timestamp)) {
    throw corruptError("Catch Up cursor contains an invalid timestamp.");
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("Catch Up cursor contains an invalid revision.");
  }

  const cursor: StoredCatchUpCursor = {
    scaffoldId: expectedScaffoldId,
    actor,
    head: row.head,
    branch: row.branch,
    timestamp: row.timestamp,
    revision: row.revision,
  };
  if (cursorRevision(cursor) !== cursor.revision) {
    throw corruptError("Catch Up cursor failed its revision check.");
  }
  return cursor;
}

function readHubJob(
  db: DatabaseSync,
  scaffoldId: string,
  id: string,
): HubJobSnapshot | null {
  const row = db.prepare(`
    SELECT ${HUB_JOB_SELECT_COLUMNS}
    FROM hub_jobs
    WHERE scaffold_id = ? AND id = ?
  `).get(scaffoldId, id) as HubJobRow | undefined;
  return row ? decodeHubJob(row, scaffoldId) : null;
}

function readHubJobLease(db: DatabaseSync): HubJobLease | null {
  const rows = db.prepare(`
    SELECT singleton, pid, token, acquired_at
    FROM hub_runtime_lease
  `).all() as unknown as HubLeaseRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || sqliteInteger(rows[0]?.singleton) !== 1) {
    throw corruptError("The Hub job lease row is invalid.");
  }
  const row = rows[0]!;
  const pid = sqliteInteger(row.pid);
  if (pid === null || pid < 1) {
    throw corruptError("The Hub job lease PID is invalid.");
  }
  if (typeof row.token !== "string" || !HUB_LEASE_TOKEN.test(row.token)) {
    throw corruptError("The Hub job lease token is invalid.");
  }
  if (typeof row.acquired_at !== "string" || !isCanonicalTimestamp(row.acquired_at)) {
    throw corruptError("The Hub job lease timestamp is invalid.");
  }
  return { pid, token: row.token, acquiredAt: row.acquired_at };
}

function assertHubJobLease(db: DatabaseSync, token: string): void {
  const current = readHubJobLease(db);
  if (!current || current.token !== token) {
    throw revisionConflict("The repository Hub job lease is absent or no longer owned.");
  }
}

function readActiveHubJob(
  db: DatabaseSync,
  scaffoldId: string,
): HubJobSnapshot | null {
  const rows = db.prepare(`
    SELECT ${HUB_JOB_SELECT_COLUMNS}
    FROM hub_jobs
    WHERE scaffold_id = ? AND state IN ('queued', 'running')
    ORDER BY created_at ASC, id ASC
    LIMIT 2
  `).all(scaffoldId) as unknown as HubJobRow[];
  if (rows.length > 1) {
    throw corruptError("More than one active index-mutating Hub job exists for this scaffold.");
  }
  return rows[0] ? decodeHubJob(rows[0], scaffoldId) : null;
}

function decodeHubJob(row: HubJobRow, expectedScaffoldId: string): HubJobSnapshot {
  if (row.scaffold_id !== expectedScaffoldId) {
    throw corruptError("Hub job scaffold does not match its storage partition.");
  }
  let id: string;
  let kind: HubJobKind;
  let generation: number;
  let phase: HubJobPhase;
  let progress: HubJobProgress | null;
  let cancelRequested: boolean;
  let state: HubJobSnapshot["state"];
  let createdAt: string;
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let interruptedReason: HubJobInterruptionReason | undefined;
  let problem: HubJobProblem | undefined;
  let summary: string | undefined;
  try {
    id = validateHubJobId(row.id);
    kind = validateHubJobKind(row.kind);
    generation = requireSafeInteger(row.generation, "generation", 1);
    phase = validateJobPhase(row.phase);
    progress = decodeStoredJobProgress(row);
    cancelRequested = decodeSqliteBoolean(row.cancel_requested, "cancelRequested");
    state = validateJobState(row.state);
    createdAt = validateTimestamp(row.created_at as string, "createdAt");
    startedAt = optionalStoredTimestamp(row.started_at, "startedAt");
    finishedAt = optionalStoredTimestamp(row.finished_at, "finishedAt");
    interruptedReason = validateStoredInterruptionReason(row.interrupted_reason);
    problem = decodeStoredJobProblem(row.problem_json);
    if (row.summary !== null) {
      throw corruptError("Hub jobs must not persist executor-provided summaries.");
    }
    summary = undefined;
  } catch (error) {
    if (error instanceof MexPortError && error.problem.code === "VALIDATION_FAILED") {
      throw corruptError(`Hub job ${String(row.id)} contains invalid persisted fields.`);
    }
    throw error;
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("Hub job contains an invalid revision.");
  }
  const draft: Omit<HubJobSnapshot, "revision"> = {
    id,
    scaffoldId: expectedScaffoldId,
    kind,
    generation,
    phase,
    progress,
    cancelRequested,
    state,
    createdAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(interruptedReason === undefined ? {} : { interruptedReason }),
    ...(problem === undefined ? {} : { problem }),
    ...(summary === undefined ? {} : { summary }),
  };
  try {
    validateJobLifecycle(draft);
  } catch (error) {
    if (error instanceof MexPortError) {
      throw corruptError("Hub job contains an invalid lifecycle projection.");
    }
    throw error;
  }
  if (hubJobRevision(draft) !== row.revision) {
    throw corruptError("Hub job failed its optimistic revision check.");
  }
  return { ...draft, revision: row.revision };
}

function decodeStoredJobProgress(row: HubJobRow): HubJobProgress | null {
  if (
    row.progress_completed === null
    && row.progress_total === null
    && row.progress_message === null
  ) {
    return null;
  }
  if (row.progress_completed === null) {
    throw corruptError("Hub job progress is missing its completed count.");
  }
  if (row.progress_message !== null) {
    throw corruptError("Hub jobs must not persist executor-provided progress messages.");
  }
  return validateJobProgress({
    completed: requireSafeInteger(row.progress_completed, "progress.completed", 0),
    ...(row.progress_total === null
      ? {}
      : { total: requireSafeInteger(row.progress_total, "progress.total", 1) }),
  });
}

function decodeStoredJobProblem(value: unknown): HubJobProblem | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_JOB_PROBLEM_JSON_BYTES) {
    throw corruptError("Hub job problem is invalid or oversized.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw corruptError("Hub job problem is not valid JSON.");
  }
  const problem = validateJobProblem(decoded);
  if (!problem || JSON.stringify(problem) !== value) {
    throw corruptError("Hub job problem is not canonical JSON.");
  }
  return problem;
}

function insertHubJob(db: DatabaseSync, job: HubJobSnapshot): void {
  db.prepare(`
    INSERT INTO hub_jobs (
      id, scaffold_id, kind, generation, phase,
      progress_completed, progress_total, progress_message, cancel_requested,
      state, created_at, started_at, finished_at, interrupted_reason,
      problem_json, summary, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...hubJobSqlValues(job));
}

function replaceHubJob(
  db: DatabaseSync,
  job: HubJobSnapshot,
  expectedRevision: Revision,
): void {
  const values = hubJobSqlValues(job);
  const result = db.prepare(`
    UPDATE hub_jobs SET
      scaffold_id = ?, kind = ?, generation = ?, phase = ?,
      progress_completed = ?, progress_total = ?, progress_message = ?, cancel_requested = ?,
      state = ?, created_at = ?, started_at = ?, finished_at = ?,
      interrupted_reason = ?, problem_json = ?, summary = ?, revision = ?
    WHERE id = ? AND scaffold_id = ? AND revision = ?
  `).run(
    ...values.slice(1),
    job.id,
    job.scaffoldId,
    expectedRevision,
  );
  if (Number(result.changes) !== 1) {
    throw revisionConflict("The Hub job revision changed; reload it and retry.");
  }
}

function hubJobSqlValues(job: HubJobSnapshot): Array<string | number | null> {
  return [
    job.id,
    job.scaffoldId,
    job.kind,
    job.generation,
    job.phase,
    job.progress?.completed ?? null,
    job.progress?.total ?? null,
    job.progress?.message ?? null,
    job.cancelRequested ? 1 : 0,
    job.state,
    job.createdAt,
    job.startedAt ?? null,
    job.finishedAt ?? null,
    job.interruptedReason ?? null,
    job.problem ? JSON.stringify(job.problem) : null,
    job.summary ?? null,
    job.revision,
  ];
}

function pruneTerminalHubJobs(db: DatabaseSync, scaffoldId: string): number {
  const result = db.prepare(`
    DELETE FROM hub_jobs
    WHERE scaffold_id = ?
      AND state IN ('succeeded', 'failed', 'interrupted')
      AND id IN (
        SELECT id
        FROM hub_jobs
        WHERE scaffold_id = ?
          AND state IN ('succeeded', 'failed', 'interrupted')
        ORDER BY finished_at DESC, id DESC
        LIMIT -1 OFFSET ${TERMINAL_JOB_RETENTION}
      )
  `).run(scaffoldId, scaffoldId);
  return Number(result.changes);
}

function hubJobRevision(job: Omit<HubJobSnapshot, "revision">): Revision {
  return sha256(JSON.stringify({
    schemaVersion: 2,
    id: job.id,
    scaffoldId: job.scaffoldId,
    kind: job.kind,
    generation: job.generation,
    phase: job.phase,
    progress: job.progress,
    cancelRequested: job.cancelRequested,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    interruptedReason: job.interruptedReason ?? null,
    problem: job.problem ?? null,
    summary: job.summary ?? null,
  }));
}

function withoutRevision(job: HubJobSnapshot): Omit<HubJobSnapshot, "revision"> {
  const { revision: _revision, ...draft } = job;
  return draft;
}

function validateHubJobId(value: unknown): string {
  if (typeof value !== "string" || !HUB_JOB_ID.test(value)) {
    throw validationError("Hub job IDs must use the job_<ULID> format.");
  }
  return value;
}

function validateHubJobKind(value: unknown): HubJobKind {
  if (typeof value !== "string" || !HUB_JOB_KINDS.includes(value as HubJobKind)) {
    throw validationError("Hub job kind is not registered.");
  }
  return value as HubJobKind;
}

function validateJobState(value: unknown): HubJobSnapshot["state"] {
  if (typeof value !== "string" || !JOB_STATES.includes(value as HubJobSnapshot["state"])) {
    throw validationError("Hub job state is invalid.");
  }
  return value as HubJobSnapshot["state"];
}

function validateJobPhase(value: unknown): HubJobPhase {
  if (
    typeof value !== "string"
    || !HUB_JOB_PHASES.includes(value as HubJobPhase)
  ) {
    throw validationError("Hub job phase is not in the fixed internal allowlist.");
  }
  return value as HubJobPhase;
}

function validateJobProgress(value: HubJobProgress | null): HubJobProgress | null {
  if (value === null) return null;
  if (!isPlainObject(value)) throw validationError("Hub job progress has an invalid shape.");
  assertOnlyKeys(value, ["completed", "total", "message"], "Hub job progress");
  if (value.message !== undefined) {
    throw validationError("Hub jobs persist numeric progress only.");
  }
  const completed = requireSafeInteger(value.completed, "progress.completed", 0);
  const total = value.total === undefined
    ? undefined
    : requireSafeInteger(value.total, "progress.total", 1);
  if (total !== undefined && completed > total) {
    throw validationError("Hub job completed progress cannot exceed its total.");
  }
  return {
    completed,
    ...(total === undefined ? {} : { total }),
  };
}

function validateJobProblem(value: unknown): HubJobProblem | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw validationError("Hub job problem has an invalid shape.");
  assertOnlyKeys(value, ["type", "status", "code", "title", "detail"], "Hub job problem");
  if (value.type !== "about:blank" || value.status !== 500 || value.code !== "JOB_FAILED") {
    throw validationError("Hub job problem must use the bounded JOB_FAILED projection.");
  }
  if (
    value.title !== "Hub job failed"
    || value.detail !== "The job did not complete. Retry it or inspect repository health."
  ) {
    throw validationError("Hub job failures must use the generic non-sensitive projection.");
  }
  const problem: HubJobProblem = {
    type: "about:blank",
    status: 500,
    code: "JOB_FAILED",
    title: value.title,
    detail: value.detail,
  };
  if (Buffer.byteLength(JSON.stringify(problem), "utf8") > MAX_JOB_PROBLEM_JSON_BYTES) {
    throw validationError("Hub job problem is oversized.");
  }
  return problem;
}

function validateInterruptionReason(
  value: unknown,
): HubJobInterruptionReason | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || !HUB_JOB_INTERRUPTION_REASONS.includes(value as HubJobInterruptionReason)
  ) {
    throw validationError("Hub job interruption reason is invalid.");
  }
  return value as HubJobInterruptionReason;
}

function validateStoredInterruptionReason(
  value: unknown,
): HubJobInterruptionReason | undefined {
  if (value === null) return undefined;
  return validateInterruptionReason(value);
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return validateTimestamp(value as string, label);
}

function optionalStoredTimestamp(value: unknown, label: string): string | undefined {
  if (value === null) return undefined;
  return validateTimestamp(value as string, label);
}

function requireSafeInteger(value: unknown, label: string, minimum: number): number {
  const numeric = sqliteInteger(value);
  if (numeric === null || numeric < minimum) {
    throw validationError(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return numeric;
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw validationError(`${label} must be a boolean.`);
  }
  return value;
}

function validateLeaseToken(value: unknown): string {
  if (typeof value !== "string" || !HUB_LEASE_TOKEN.test(value)) {
    throw validationError("Hub job lease tokens must be lower-case 256-bit hex values.");
  }
  return value;
}

function safeProcessStatus(
  probe: (pid: number) => HubLeaseProcessStatus,
  pid: number,
): HubLeaseProcessStatus {
  try {
    const status = probe(pid);
    return status === "alive" || status === "dead" || status === "ambiguous"
      ? status
      : "ambiguous";
  } catch {
    return "ambiguous";
  }
}

function probeProcessStatus(pid: number): HubLeaseProcessStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return isFilesystemError(error, "ESRCH") ? "dead" : "ambiguous";
  }
}

function decodeSqliteBoolean(value: unknown, label: string): boolean {
  const numeric = sqliteInteger(value);
  if (numeric !== 0 && numeric !== 1) {
    throw corruptError(`Hub job ${label} is not a SQLite boolean.`);
  }
  return numeric === 1;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw validationError(`${label} contains unknown fields.`);
  }
}

function assertJobTransition(
  current: HubJobSnapshot,
  nextState: HubJobSnapshot["state"],
  nextProgress: HubJobProgress | null,
  nextStartedAt: string | undefined,
  nextCancelRequested: boolean,
): void {
  const allowed = current.state === "queued"
    ? new Set<HubJobSnapshot["state"]>(["running", "failed", "interrupted"])
    : current.state === "running"
      ? new Set<HubJobSnapshot["state"]>(["running", "succeeded", "failed", "interrupted"])
      : new Set<HubJobSnapshot["state"]>();
  if (!allowed.has(nextState)) {
    throw revisionConflict(`Hub job cannot transition from ${current.state} to ${nextState}.`);
  }
  if (current.startedAt !== undefined && nextStartedAt !== current.startedAt) {
    throw validationError("Hub job start time is immutable once observed.");
  }
  if (current.cancelRequested && !nextCancelRequested) {
    throw validationError("A Hub job cancellation request cannot be cleared.");
  }
  if (current.progress) {
    if (!nextProgress || nextProgress.completed < current.progress.completed) {
      throw validationError("Hub job progress must be monotonic.");
    }
    if (
      current.progress.total !== undefined
      && nextProgress.total !== current.progress.total
    ) {
      throw validationError("Hub job progress total cannot change once observed.");
    }
  }
}

function validateJobLifecycle(job: Omit<HubJobSnapshot, "revision">): void {
  if (job.startedAt !== undefined && job.startedAt < job.createdAt) {
    throw validationError("Hub job start time cannot precede creation.");
  }
  if (
    job.finishedAt !== undefined
    && (job.finishedAt < job.createdAt || (job.startedAt !== undefined && job.finishedAt < job.startedAt))
  ) {
    throw validationError("Hub job finish time cannot precede creation or start.");
  }
  if (job.state === "queued") {
    if (
      job.phase !== "queued"
      || job.progress !== null
      || job.cancelRequested
      || job.startedAt !== undefined
      || job.finishedAt !== undefined
      || job.interruptedReason !== undefined
      || job.problem !== undefined
      || job.summary !== undefined
    ) {
      throw validationError("Queued Hub jobs cannot contain terminal or start fields.");
    }
    return;
  }
  if (job.state === "running") {
    if (
      !HUB_JOB_PROGRESS_PHASES.includes(job.phase as (typeof HUB_JOB_PROGRESS_PHASES)[number])
      || job.startedAt === undefined
      || job.finishedAt !== undefined
      || job.interruptedReason !== undefined
      || job.problem !== undefined
      || job.summary !== undefined
    ) {
      throw validationError("Running Hub jobs require only a start time.");
    }
    return;
  }
  if (job.finishedAt === undefined) {
    throw validationError("Terminal Hub jobs require a finish time.");
  }
  if (job.state === "interrupted") {
    if (
      job.phase !== "interrupted"
      || job.interruptedReason === undefined
      || job.problem !== undefined
      || job.summary !== undefined
    ) {
      throw validationError("Interrupted Hub jobs require only an interruption reason.");
    }
    if (job.interruptedReason === "user_cancelled" && !job.cancelRequested) {
      throw validationError("User-cancelled Hub jobs must retain their cancellation request.");
    }
    return;
  }
  if (job.cancelRequested) {
    throw validationError("Successful or failed Hub jobs cannot retain a cancellation request.");
  }
  if (job.startedAt === undefined || job.interruptedReason !== undefined) {
    throw validationError("Completed Hub jobs require a start time and no interruption reason.");
  }
  if (job.state === "failed" && job.problem === undefined) {
    throw validationError("Failed Hub jobs require a bounded problem.");
  }
  if (job.state === "succeeded" && job.problem !== undefined) {
    throw validationError("Successful Hub jobs cannot contain a problem.");
  }
  if (job.state === "failed" && job.summary !== undefined) {
    throw validationError("Failed Hub jobs cannot contain a success summary.");
  }
  if (
    (job.state === "failed" && job.phase !== "failed")
    || (job.state === "succeeded" && job.phase !== "complete")
  ) {
    throw validationError("Completed Hub job state and phase do not match.");
  }
}

function isTerminalJobState(state: HubJobSnapshot["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "interrupted";
}

interface DecodedJobCursor {
  createdAt: string;
  id: string;
}

function encodeJobCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, "utf8").toString("base64url");
}

function decodeJobCursor(value: string | undefined): DecodedJobCursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw validationError("Hub job cursor is invalid or oversized.");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw validationError("Hub job cursor is invalid.");
  }
  if (bytes.toString("base64url") !== value) {
    throw validationError("Hub job cursor is not canonical.");
  }
  const decoded = bytes.toString("utf8");
  const separator = decoded.indexOf("\n");
  if (separator < 0 || decoded.indexOf("\n", separator + 1) >= 0) {
    throw validationError("Hub job cursor is invalid.");
  }
  return {
    createdAt: validateTimestamp(decoded.slice(0, separator), "cursor timestamp"),
    id: validateHubJobId(decoded.slice(separator + 1)),
  };
}

function validateJobPageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_JOB_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_JOB_PAGE_SIZE) {
    throw validationError(`Hub job page limit must be between 1 and ${MAX_JOB_PAGE_SIZE}.`);
  }
  return value;
}

function parseStoredActor(json: string): Exclude<ActorRef, { kind: "unknown" }> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw corruptError("Catch Up actor is not valid JSON.");
  }
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw corruptError("Catch Up actor has an invalid shape.");
  }

  try {
    if (value.kind === "member") {
      assertExactKeys(value, ["kind", "memberId", "displayName"]);
      return normalizeWritableActor({
        kind: "member",
        memberId: value.memberId as string,
        ...(value.displayName === undefined
          ? {}
          : { displayName: value.displayName as string }),
      });
    }
    if (value.kind === "git") {
      assertExactKeys(value, ["kind", "name", "email"]);
      return normalizeWritableActor({
        kind: "git",
        name: value.name as string | null,
        email: value.email as string | null,
      });
    }
  } catch (error) {
    if (error instanceof MexPortError) {
      throw corruptError("Catch Up actor contains invalid identity fields.");
    }
    throw error;
  }
  throw corruptError("Catch Up actor has an unsupported kind.");
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw corruptError("Catch Up actor contains unknown fields.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function isValidStoredBranch(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1024
    && !/[\0-\x1f\x7f]/.test(value);
}

function assertExpectedRevision(
  current: Revision | null,
  expected: Revision | null,
  label: string,
): void {
  if (current !== expected) {
    throw revisionConflict(`The ${label} revision changed; reload it and retry.`);
  }
}

function describeBranch(branch: string | null): string {
  return branch === null ? "detached HEAD" : `branch ${branch}`;
}

function beginImmutableObservation(databasePath: string): DatabaseFileIdentity | null {
  assertNoActiveSidecars(databasePath);
  const first = readDatabaseFileIdentity(databasePath, true);
  if (first === null) return null;
  assertNoActiveSidecars(databasePath);
  const second = readDatabaseFileIdentity(databasePath, false);
  assertSameDatabaseIdentity(first, second);
  return second;
}

function finishImmutableObservation(
  databasePath: string,
  expected: DatabaseFileIdentity,
): void {
  assertNoActiveSidecars(databasePath);
  const current = readDatabaseFileIdentity(databasePath, false);
  assertSameDatabaseIdentity(expected, current);
  assertNoActiveSidecars(databasePath);
}

function assertNoActiveSidecars(databasePath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      lstatSync(sidecarPath);
    } catch (error) {
      if (isFilesystemError(error, "ENOENT")) continue;
      throw observationError(
        `Cannot safely inspect the local database ${suffix} sidecar; retry after local writes finish.`,
      );
    }
    throw observationError(
      `The local database has an active ${suffix} sidecar; retry after local writes finish.`,
    );
  }
}

function readDatabaseFileIdentity(
  databasePath: string,
  allowMissing: boolean,
): DatabaseFileIdentity | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(databasePath, { bigint: true });
  } catch (error) {
    if (allowMissing && isFilesystemError(error, "ENOENT")) return null;
    throw observationError(
      "The local database changed or became unreadable during a side-effect-free read.",
    );
  }
  if (stat.isSymbolicLink()) {
    throw pathError("Refusing local state through a symbolic-link database.");
  }
  if (!stat.isFile()) {
    throw corruptError("The local team database is not a regular file.");
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs,
  };
}

function assertSameDatabaseIdentity(
  expected: DatabaseFileIdentity,
  actual: DatabaseFileIdentity | null,
): void {
  if (
    actual === null
    || expected.device !== actual.device
    || expected.inode !== actual.inode
    || expected.size !== actual.size
    || expected.modifiedAt !== actual.modifiedAt
    || expected.changedAt !== actual.changedAt
  ) {
    throw observationError(
      "The local database changed during a side-effect-free read; retry against a stable snapshot.",
    );
  }
}

function isFilesystemError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function validateReadableSchema(db: DatabaseSync, minimumVersion: number): void {
  const tables = listUserTables(db);
  if (tables.length === 0) {
    throw migrationError("The local team database has not been initialized.");
  }
  if (!tables.includes("local_state_schema")) {
    throw corruptError("The local team database has no schema metadata.");
  }
  validateSchemaTableColumns(db);
  const version = readSchemaVersion(db);
  if (version === 0) {
    throw migrationError(
      `Local team schema ${version} requires an explicit write-side migration.`,
    );
  }
  if (version === 1) {
    validateV1Tables(db);
    if (minimumVersion <= 1) return;
    throw migrationError(`This local team read requires schema ${minimumVersion}; found schema 1.`);
  }
  if (version === 2) {
    validateV2Tables(db);
    if (minimumVersion <= 2) return;
    throw migrationError(`This local team read requires schema ${minimumVersion}; found schema 2.`);
  }
  if (version === 3) {
    validateV3Tables(db);
    if (minimumVersion <= 3) return;
    throw migrationError(`This local team read requires schema ${minimumVersion}; found schema 3.`);
  }
  if (version > LOCAL_STATE_SCHEMA_VERSION) {
    throw migrationError(
      `Local team schema ${version} is newer than supported schema ${LOCAL_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (version !== LOCAL_STATE_SCHEMA_VERSION) {
    throw corruptError("The local team schema version is invalid.");
  }
  validateV4Tables(db);
}

function ensureWritableSchema(db: DatabaseSync, now: () => string): void {
  const tables = listUserTables(db);
  if (tables.length === 0) {
    createV4Schema(db, now());
    validateV4Tables(db);
    return;
  }
  if (!tables.includes("local_state_schema")) {
    throw corruptError("The local team database has no schema metadata.");
  }
  validateSchemaTableColumns(db);
  const version = readSchemaVersion(db);
  if (version > LOCAL_STATE_SCHEMA_VERSION) {
    throw migrationError(
      `Local team schema ${version} is newer than supported schema ${LOCAL_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (version < 0) throw corruptError("The local team schema version is invalid.");
  if (version === 0) {
    validateV0Tables(db);
    db.exec("DROP TABLE local_state_schema");
    db.exec(V1_SCHEMA_SQL);
    validateV1Tables(db);
    db.prepare(`
      INSERT INTO local_state_schema (singleton, version, applied_at)
      VALUES (1, ?, ?)
    `).run(1, validateTimestamp(now(), "migration timestamp"));
  }
  if (version <= 1) {
    validateV1Tables(db);
    db.exec(V2_SCHEMA_SQL);
    db.prepare(`
      UPDATE local_state_schema
      SET version = ?, applied_at = ?
      WHERE singleton = 1
    `).run(2, validateTimestamp(now(), "migration timestamp"));
  }
  if (version <= 2) {
    validateV2Tables(db);
    migrateV2ToV3(db);
    db.prepare(`
      UPDATE local_state_schema
      SET version = ?, applied_at = ?
      WHERE singleton = 1
    `).run(3, validateTimestamp(now(), "migration timestamp"));
  }
  if (version <= 3) {
    validateV3Tables(db);
    db.exec(V4_SCHEMA_SQL);
    db.prepare(`
      UPDATE local_state_schema
      SET version = ?, applied_at = ?
      WHERE singleton = 1
    `).run(LOCAL_STATE_SCHEMA_VERSION, validateTimestamp(now(), "migration timestamp"));
  }
  validateV4Tables(db);
}

function createV4Schema(db: DatabaseSync, timestamp: string): void {
  db.exec(V1_SCHEMA_SQL);
  db.exec(V3_SCHEMA_SQL);
  db.exec(V4_SCHEMA_SQL);
  db.prepare(`
    INSERT INTO local_state_schema (singleton, version, applied_at)
    VALUES (1, ?, ?)
  `).run(
    LOCAL_STATE_SCHEMA_VERSION,
    validateTimestamp(timestamp, "schema timestamp"),
  );
}

function migrateV2ToV3(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX hub_jobs_generation_per_kind;
    DROP INDEX hub_jobs_one_active_index_job_per_scaffold;
    DROP INDEX hub_jobs_scaffold_created;
    ALTER TABLE hub_jobs RENAME TO hub_jobs_v2;
  `);
  const currentStatements = V3_SCHEMA_SQL
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => (
      statement.startsWith("CREATE TABLE hub_jobs")
      || statement.includes("INDEX hub_jobs_")
    ));
  db.exec(`${currentStatements.join(";\n")};`);
  db.exec(`
    INSERT INTO hub_jobs (
      id, scaffold_id, kind, generation, phase,
      progress_completed, progress_total, progress_message, cancel_requested,
      state, created_at, started_at, finished_at, interrupted_reason,
      problem_json, summary, revision
    )
    SELECT
      id, scaffold_id, kind, generation, phase,
      progress_completed, progress_total, progress_message, cancel_requested,
      state, created_at, started_at, finished_at, interrupted_reason,
      problem_json, summary, revision
    FROM hub_jobs_v2;
    DROP TABLE hub_jobs_v2;
  `);
}

function listUserTables(db: DatabaseSync): string[] {
  return (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: unknown }>).map((row) => {
    if (typeof row.name !== "string") throw corruptError("Invalid SQLite table metadata.");
    return row.name;
  });
}

function validateSchemaTableColumns(db: DatabaseSync): void {
  validateTableSemantics(db, "local_state_schema");
}

function validateV0Tables(db: DatabaseSync): void {
  const actualTables = listUserTables(db);
  if (actualTables.length !== 1 || actualTables[0] !== "local_state_schema") {
    throw corruptError("The local team database contains an invalid v0 table set.");
  }
  validateTableSemantics(db, "local_state_schema");
}

function validateV1Tables(db: DatabaseSync): void {
  const actualTables = listUserTables(db);
  const expectedTables = (Object.keys(EXPECTED_V1_TABLES) as V1LocalStateTable[]).sort();
  if (
    actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw corruptError("The local team database contains an invalid v1 table set.");
  }
  for (const table of expectedTables) {
    validateTableSemantics(db, table);
  }
  validateV1TableSql(db);
  validateNamedSchemaObjects(db, []);
}

function validateV2Tables(db: DatabaseSync): void {
  validateHubTables(db, V2_SCHEMA_SQL, "v2");
}

function validateV3Tables(db: DatabaseSync): void {
  validateHubTables(db, V3_SCHEMA_SQL, "v3");
}

function validateV4Tables(db: DatabaseSync): void {
  const actualTables = listUserTables(db);
  const expectedTables = [
    ...(Object.keys(EXPECTED_V1_TABLES) as V1LocalStateTable[]),
    "hub_jobs",
    "hub_runtime_lease",
    "inbox_drafts",
    "relay_drafts",
    "team_workflow_lease",
    "team_workflow_operations",
  ] satisfies LocalStateTable[];
  expectedTables.sort(compareCodeUnits);
  if (
    actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw corruptError("The local team database contains an invalid v4 table set.");
  }
  for (const table of expectedTables) validateTableSemantics(db, table);
  validateV1TableSql(db);
  validateHubJobIndexes(db, "v3");
  validateHubJobSchemaSql(db, V3_SCHEMA_SQL, "v3");
  validateV4SchemaSql(db);
  validateNamedSchemaObjects(db, [
    "hub_jobs_generation_per_kind",
    "hub_jobs_one_active_index_job_per_scaffold",
    "hub_jobs_scaffold_created",
    "inbox_drafts_scaffold_updated",
    "relay_drafts_scaffold_updated",
    "team_workflow_one_incomplete_per_repository",
    "team_workflow_operations_scaffold_updated",
  ]);
}

function validateHubTables(
  db: DatabaseSync,
  schemaSql: string,
  versionLabel: "v2" | "v3",
): void {
  const actualTables = listUserTables(db);
  const expectedTables = [
    ...(Object.keys(EXPECTED_V1_TABLES) as V1LocalStateTable[]),
    "hub_jobs" as const,
    "hub_runtime_lease" as const,
  ].sort();
  if (
    actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw corruptError(`The local team database contains an invalid ${versionLabel} table set.`);
  }
  for (const table of expectedTables) validateTableSemantics(db, table);
  validateV1TableSql(db);
  validateHubJobIndexes(db, versionLabel);
  validateHubJobSchemaSql(db, schemaSql, versionLabel);
  validateNamedSchemaObjects(db, [
    "hub_jobs_generation_per_kind",
    "hub_jobs_one_active_index_job_per_scaffold",
    "hub_jobs_scaffold_created",
  ]);
}

function validateTableSemantics(
  db: DatabaseSync,
  table: LocalStateTable,
): void {
  const expectedColumns = table === "hub_jobs"
    ? EXPECTED_HUB_JOB_COLUMNS
    : table === "hub_runtime_lease"
      ? EXPECTED_HUB_LEASE_COLUMNS
      : table === "inbox_drafts" || table === "relay_drafts"
        ? EXPECTED_DRAFT_COLUMNS
        : table === "team_workflow_lease"
          ? EXPECTED_WORKFLOW_LEASE_COLUMNS
          : table === "team_workflow_operations"
            ? EXPECTED_WORKFLOW_OPERATION_COLUMNS
      : EXPECTED_V1_TABLES[table];
  const tableRows = (db.prepare("PRAGMA table_list").all() as Array<{
    schema: unknown;
    name: unknown;
    type: unknown;
    ncol: unknown;
    wr: unknown;
    strict: unknown;
  }>).filter((row) => row.schema === "main" && row.name === table);
  if (tableRows.length !== 1) {
    throw corruptError(`Local team table ${table} is missing or ambiguous.`);
  }
  const tableRow = tableRows[0]!;
  if (
    tableRow.type !== "table"
    || sqliteInteger(tableRow.ncol) !== expectedColumns.length
    || sqliteInteger(tableRow.wr) !== 0
    || sqliteInteger(tableRow.strict) !== 1
  ) {
    throw corruptError(`Local team table ${table} is not the required STRICT rowid table.`);
  }

  const actualColumns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{
    cid: unknown;
    name: unknown;
    type: unknown;
    notnull: unknown;
    dflt_value: unknown;
    pk: unknown;
    hidden: unknown;
  }>;
  if (actualColumns.length !== expectedColumns.length) {
    throw corruptError(`Local team table ${table} has an invalid column count.`);
  }

  for (const [index, expected] of expectedColumns.entries()) {
    const actual = actualColumns[index];
    const declaredType = typeof actual?.type === "string"
      ? actual.type.trim().toUpperCase()
      : null;
    if (
      actual === undefined
      || sqliteInteger(actual.cid) !== index
      || actual.name !== expected.name
      || declaredType !== expected.type
      || sqliteInteger(actual.notnull) !== expected.notNull
      || actual.dflt_value !== null
      || sqliteInteger(actual.pk) !== expected.primaryKeyPosition
      || sqliteInteger(actual.hidden) !== 0
    ) {
      throw corruptError(
        `Local team table ${table} column ${expected.name} has invalid semantics.`,
      );
    }
  }
}

function validateHubJobIndexes(db: DatabaseSync, versionLabel: "v2" | "v3"): void {
  const indexes = db.prepare("PRAGMA index_list(hub_jobs)").all() as Array<{
    name: unknown;
    unique: unknown;
    origin: unknown;
    partial: unknown;
  }>;
  const named = indexes
    .filter((row) => row.origin === "c")
    .sort((left, right) => compareCodeUnits(String(left.name), String(right.name)));
  const expected = [
    {
      name: "hub_jobs_generation_per_kind",
      unique: 1,
      partial: 0,
      columns: ["scaffold_id", "kind", "generation"],
    },
    {
      name: "hub_jobs_one_active_index_job_per_scaffold",
      unique: 1,
      partial: 1,
      columns: ["scaffold_id"],
    },
    {
      name: "hub_jobs_scaffold_created",
      unique: 0,
      partial: 0,
      columns: ["scaffold_id", "created_at", "id"],
    },
  ] as const;
  if (named.length !== expected.length) {
    throw corruptError(`The local team database contains an invalid ${versionLabel} Hub job index set.`);
  }
  for (const [index, wanted] of expected.entries()) {
    const actual = named[index];
    if (
      actual?.name !== wanted.name
      || sqliteInteger(actual.unique) !== wanted.unique
      || sqliteInteger(actual.partial) !== wanted.partial
    ) {
      throw corruptError(`Hub job index ${wanted.name} has invalid semantics.`);
    }
    const columns = db.prepare(`PRAGMA index_info(${wanted.name})`).all() as Array<{
      seqno: unknown;
      name: unknown;
    }>;
    if (
      columns.length !== wanted.columns.length
      || columns.some((column, columnIndex) => (
        sqliteInteger(column.seqno) !== columnIndex
        || column.name !== wanted.columns[columnIndex]
      ))
    ) {
      throw corruptError(`Hub job index ${wanted.name} has invalid columns.`);
    }
  }
}

function validateHubJobSchemaSql(
  db: DatabaseSync,
  schemaSql: string,
  versionLabel: "v2" | "v3",
): void {
  const expectedStatements = schemaSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const expectedNames = [
    "hub_runtime_lease",
    "hub_jobs",
    "hub_jobs_one_active_index_job_per_scaffold",
    "hub_jobs_generation_per_kind",
    "hub_jobs_scaffold_created",
  ] as const;
  for (const name of expectedNames) {
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE name = ? AND type IN ('table', 'index')
    `).get(name) as { sql: unknown } | undefined;
    const expected = expectedStatements.find((statement) => (
      statement.startsWith(`CREATE TABLE ${name}`)
      || statement.includes(`INDEX ${name}\n`)
    ));
    if (
      !row
      || typeof row.sql !== "string"
      || expected === undefined
      || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected)
    ) {
      throw corruptError(`Hub job schema object ${name} does not match schema ${versionLabel}.`);
    }
  }
}

function validateV4SchemaSql(db: DatabaseSync): void {
  const expectedStatements = V4_SCHEMA_SQL
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const expectedNames = [
    "inbox_drafts",
    "relay_drafts",
    "team_workflow_lease",
    "team_workflow_operations",
    "inbox_drafts_scaffold_updated",
    "relay_drafts_scaffold_updated",
    "team_workflow_one_incomplete_per_repository",
    "team_workflow_operations_scaffold_updated",
  ] as const;
  for (const name of expectedNames) {
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE name = ? AND type IN ('table', 'index')
    `).get(name) as { sql: unknown } | undefined;
    const expected = expectedStatements.find((statement) => (
      statement.startsWith(`CREATE TABLE ${name}`)
      || statement.includes(`INDEX ${name}\n`)
    ));
    if (
      !row
      || typeof row.sql !== "string"
      || expected === undefined
      || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected)
    ) {
      throw corruptError(`Local team schema object ${name} does not match schema v4.`);
    }
  }
}

function validateV1TableSql(db: DatabaseSync): void {
  const expectedStatements = V1_SCHEMA_SQL
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const name of Object.keys(EXPECTED_V1_TABLES) as V1LocalStateTable[]) {
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE name = ? AND type = 'table'
    `).get(name) as { sql: unknown } | undefined;
    const expected = expectedStatements.find((statement) => statement.includes(name));
    if (
      !row
      || typeof row.sql !== "string"
      || expected === undefined
      || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected)
    ) {
      throw corruptError(`Local team table ${name} does not match the exact v1 schema.`);
    }
  }
}

function validateNamedSchemaObjects(db: DatabaseSync, expectedNames: readonly string[]): void {
  const actualNames = (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('index', 'trigger', 'view')
    ORDER BY name
  `).all() as Array<{ name: unknown }>).map((row) => {
    if (typeof row.name !== "string") throw corruptError("Invalid SQLite schema metadata.");
    return row.name;
  });
  const expected = [...expectedNames].sort(compareCodeUnits);
  if (
    actualNames.length !== expected.length
    || actualNames.some((name, index) => name !== expected[index])
  ) {
    throw corruptError("The local team database contains unexpected indexes, triggers, or views.");
  }
}

function normalizeSchemaSql(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/;+$/g, "")
    .replace(/ifnotexists/gi, "")
    .toLowerCase();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sqliteInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (
    typeof value === "bigint"
    && value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return null;
}

function readSchemaVersion(db: DatabaseSync): number {
  const rows = db.prepare(`
    SELECT singleton, version, applied_at
    FROM local_state_schema
  `).all() as Array<{ singleton: unknown; version: unknown; applied_at: unknown }>;
  if (rows.length !== 1 || Number(rows[0]?.singleton) !== 1) {
    throw corruptError("The local team schema metadata is invalid.");
  }
  const version = Number(rows[0]?.version);
  if (!Number.isSafeInteger(version)) {
    throw corruptError("The local team schema version is invalid.");
  }
  if (typeof rows[0]?.applied_at !== "string" || !isCanonicalTimestamp(rows[0].applied_at)) {
    throw corruptError("The local team schema timestamp is invalid.");
  }
  return version;
}

function closeQuietly(db: DatabaseSync | undefined): void {
  if (!db?.isOpen) return;
  try {
    db.close();
  } catch {
    // A close failure must not mask a typed schema/operation failure.
  }
}

function normalizeStorageError(error: unknown): MexPortError {
  if (error instanceof MexPortError) return error;
  return corruptError(
    `The local team database could not be read safely: ${errorMessage(error)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationError(detail: string): MexPortError {
  return new MexPortError({
    title: "Invalid local team state request",
    status: 422,
    code: "VALIDATION_FAILED",
    detail,
  });
}

function revisionConflict(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state revision conflict",
    status: 409,
    code: "REVISION_CONFLICT",
    detail,
  });
}

function jobAlreadyRunningError(activeJobId: string): MexPortError {
  return new MexPortError({
    title: "Hub index job already running",
    status: 409,
    code: "JOB_ALREADY_RUNNING",
    detail: `Index-mutating Hub job ${activeJobId} is already active for this scaffold.`,
    activeJobId,
  } as ConstructorParameters<typeof MexPortError>[0]);
}

function hubLeaseHeldError(pid: number, status: Exclude<HubLeaseProcessStatus, "dead">): MexPortError {
  return new MexPortError({
    title: "Project Hub job lease is already held",
    status: 409,
    code: "JOB_ALREADY_RUNNING",
    detail: status === "alive"
      ? `Another live Project Hub process (${pid}) owns this repository's job lease.`
      : `The Project Hub job lease holder (${pid}) could not be verified dead; refusing recovery.`,
  });
}

function workflowLeaseHeldError(
  pid: number,
  status: Exclude<HubLeaseProcessStatus, "dead">,
): MexPortError {
  return new MexPortError({
    title: "Team workflow lease is already held",
    status: 409,
    code: "OPERATION_INTERRUPTED",
    detail: status === "alive"
      ? `Another live process (${pid}) owns this scaffold's Team workflow lease.`
      : `The Team workflow lease holder (${pid}) could not be verified dead; refusing recovery.`,
  });
}

function workflowOperationNotFoundError(operationId: string): MexPortError {
  return new MexPortError({
    title: "Team workflow operation not found",
    status: 404,
    code: "NOT_FOUND",
    detail: `Workflow operation ${operationId} does not exist in this scaffold.`,
  });
}

function jobNotFoundError(id: string): MexPortError {
  return new MexPortError({
    title: "Hub job not found",
    status: 404,
    code: "NOT_FOUND",
    detail: `Hub job ${id} does not exist in this scaffold.`,
  });
}

function migrationError(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state migration required",
    status: 409,
    code: "MIGRATION_REQUIRED",
    detail,
  });
}

function observationError(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state snapshot is not stable",
    status: 409,
    code: "OPERATION_INTERRUPTED",
    detail,
  });
}

function corruptError(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state is corrupt",
    status: 500,
    code: "INDEX_CORRUPT",
    detail,
  });
}

function pathError(detail: string): MexPortError {
  return new MexPortError({
    title: "Unsafe local team state path",
    status: 400,
    code: "PATH_OUTSIDE_PROJECT",
    detail,
  });
}

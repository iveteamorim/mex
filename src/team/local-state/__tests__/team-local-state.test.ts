import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MexPortError } from "../../contracts/shared.js";
import type { MexErrorCode } from "../../contracts/shared.js";
import {
  canonicalActorKey,
  normalizeTeamWorkflowJournalEffects,
  TeamLocalState,
} from "../index.js";

const MEMBER_A = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_B = "member_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NOW = "2026-08-23T10:00:00.000Z";
const LATER = "2026-08-23T11:00:00.000Z";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const LEASE_A = "a".repeat(64);
const LEASE_B = "b".repeat(64);
const COMMAND_A = "c".repeat(64);
const PREVIEW_A = "9".repeat(64);
const DRAFT_A = "draft_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DRAFT_B = "draft_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const roots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-team-local-state-"));
  roots.push(root);
  return root;
}

function state(
  root: string,
  scaffoldId = "scaffold-a",
  now = NOW,
): TeamLocalState {
  return new TeamLocalState({ projectRoot: root, scaffoldId, now: () => now });
}

function expectCode(operation: () => unknown, code: MexErrorCode): MexPortError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MexPortError);
    expect((error as MexPortError).problem.code).toBe(code);
    return error as MexPortError;
  }
  throw new Error(`Expected ${code}`);
}

function createSchemaVersionOnly(path: string, version: number): void {
  mkdirSync(join(path, ".mex/local"), { recursive: true });
  const db = new DatabaseSync(join(path, ".mex/local/team.db"));
  db.exec(`
    CREATE TABLE local_state_schema (
      singleton INTEGER NOT NULL PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  db.prepare(`
    INSERT INTO local_state_schema (singleton, version, applied_at)
    VALUES (1, ?, ?)
  `).run(version, NOW);
  db.close();
}

interface RawV1SchemaOverrides {
  schema?: string;
  configuredMembers?: string;
  catchUpCursors?: string;
  extra?: string;
}

const VALID_SCHEMA_TABLE = `
  CREATE TABLE local_state_schema (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

const VALID_CONFIGURED_MEMBERS_TABLE = `
  CREATE TABLE configured_member_selections (
    scaffold_id TEXT NOT NULL PRIMARY KEY,
    member_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision TEXT NOT NULL
  ) STRICT;
`;

const VALID_CATCH_UP_CURSORS_TABLE = `
  CREATE TABLE catch_up_cursors (
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

function createRawV1(path: string, overrides: RawV1SchemaOverrides = {}): void {
  mkdirSync(join(path, ".mex/local"), { recursive: true });
  const db = new DatabaseSync(join(path, ".mex/local/team.db"));
  db.exec(overrides.schema ?? VALID_SCHEMA_TABLE);
  db.exec(overrides.configuredMembers ?? VALID_CONFIGURED_MEMBERS_TABLE);
  db.exec(overrides.catchUpCursors ?? VALID_CATCH_UP_CURSORS_TABLE);
  if (overrides.extra) db.exec(overrides.extra);
  db.prepare(`
    INSERT INTO local_state_schema (singleton, version, applied_at)
    VALUES (1, 1, ?)
  `).run(NOW);
  db.close();
}

function createRawV2(path: string, withQueuedJob = false): void {
  createRawV1(path);
  const db = new DatabaseSync(join(path, ".mex/local/team.db"));
  db.exec(`
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
      problem_json TEXT CHECK (problem_json IS NULL OR length(CAST(problem_json AS BLOB)) <= 4096),
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
    UPDATE local_state_schema SET version = 2, applied_at = '${NOW}';
  `);
  if (withQueuedJob) {
    const id = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const revision = createHash("sha256").update(JSON.stringify({
      schemaVersion: 2,
      id,
      scaffoldId: "scaffold-a",
      kind: "graph_refresh",
      generation: 1,
      phase: "queued",
      progress: null,
      cancelRequested: false,
      state: "queued",
      createdAt: NOW,
      startedAt: null,
      finishedAt: null,
      interruptedReason: null,
      problem: null,
      summary: null,
    })).digest("hex");
    db.prepare(`
      INSERT INTO hub_jobs (
        id, scaffold_id, kind, generation, phase,
        progress_completed, progress_total, progress_message, cancel_requested,
        state, created_at, started_at, finished_at, interrupted_reason,
        problem_json, summary, revision
      ) VALUES (?, 'scaffold-a', 'graph_refresh', 1, 'queued', NULL, NULL, NULL, 0,
        'queued', ?, NULL, NULL, NULL, NULL, NULL, ?)
    `).run(id, NOW, revision);
  }
  db.close();
}

function createRawV3(path: string): void {
  state(path).initializeForMutation();
  const db = new DatabaseSync(join(path, ".mex/local/team.db"));
  db.exec(`
    DROP TABLE team_workflow_operations;
    DROP TABLE team_workflow_lease;
    DROP TABLE relay_drafts;
    DROP TABLE inbox_drafts;
    UPDATE local_state_schema SET version = 3, applied_at = '${NOW}';
  `);
  db.close();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TeamLocalState", () => {
  it("does not create directories or a database while reading absent state", () => {
    const root = tempProject();
    const store = state(root);

    expect(store.getConfiguredMember()).toBeNull();
    expect(store.getCatchUpCursor({ kind: "member", memberId: MEMBER_A })).toBeNull();
    expect(store.getCatchUpCursor({ kind: "unknown" })).toBeNull();
    expect(store.getLocalDraft(DRAFT_A)).toBeNull();
    expect(store.listLocalDrafts()).toEqual({
      items: [],
      nextCursor: null,
      truncated: false,
    });
    expect(store.getWorkflowOperation("operation-a")).toBeNull();
    expect(store.getIncompleteWorkflowOperation()).toBeNull();
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });

  it("creates, updates, and clears configured-member selection optimistically", () => {
    const root = tempProject();
    const store = state(root);

    const first = store.configureMember({
      memberId: MEMBER_A,
      expectedRevision: null,
    });
    expect(first).toMatchObject({
      scaffoldId: "scaffold-a",
      memberId: MEMBER_A,
      updatedAt: NOW,
    });
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(store.getConfiguredMember()).toEqual(first);

    const second = state(root, "scaffold-a", LATER).configureMember({
      memberId: MEMBER_B,
      expectedRevision: first.revision,
    });
    expect(second.memberId).toBe(MEMBER_B);
    expect(second.revision).not.toBe(first.revision);

    expectCode(
      () => store.configureMember({ memberId: MEMBER_A, expectedRevision: first.revision }),
      "REVISION_CONFLICT",
    );
    expect(store.getConfiguredMember()).toEqual(second);

    store.clearConfiguredMember({ expectedRevision: second.revision });
    expect(store.getConfiguredMember()).toBeNull();
  });

  it("previews configured-member selection revisions without initializing storage", () => {
    const root = tempProject();
    const store = state(root);

    const preview = store.previewConfigureMember({
      memberId: MEMBER_A,
      expectedRevision: null,
    });
    expect(preview).toMatchObject({
      scaffoldId: "scaffold-a",
      memberId: MEMBER_A,
      updatedAt: NOW,
    });
    expect(existsSync(join(root, ".mex"))).toBe(false);

    const applied = store.configureMember({
      memberId: MEMBER_A,
      expectedRevision: null,
    });
    expect(applied).toEqual(preview);
    expect(store.previewClearConfiguredMember({
      expectedRevision: applied.revision,
    })).toEqual(applied);
    expect(store.getConfiguredMember()).toEqual(applied);
  });

  it("isolates configured members and cursors by scaffold ID", () => {
    const root = tempProject();
    const first = state(root, "scaffold-a");
    const second = state(root, "scaffold-b");
    const actor = { kind: "member" as const, memberId: MEMBER_A };

    const configuredA = first.configureMember({ memberId: MEMBER_A, expectedRevision: null });
    const configuredB = second.configureMember({ memberId: MEMBER_B, expectedRevision: null });
    const cursorA = first.markCatchUpCursor({
      actor,
      head: HEAD_A,
      branch: "main",
      expectedRevision: null,
    });

    expect(first.getConfiguredMember()).toEqual(configuredA);
    expect(second.getConfiguredMember()).toEqual(configuredB);
    expect(first.getCatchUpCursor(actor)).toEqual(cursorA);
    expect(second.getCatchUpCursor(actor)).toBeNull();
  });

  it("hashes normalized Git identity without exposing PII in the cursor key", () => {
    const first = canonicalActorKey({
      kind: "git",
      name: "  Alice   Example ",
      email: "ALICE@EXAMPLE.COM",
    });
    const second = canonicalActorKey({
      kind: "git",
      name: "alice example",
      email: "alice@example.com",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^git:[a-f0-9]{64}$/);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("example.com");
  });

  it("stores normalized Git actors and round-trips a bounded cursor", () => {
    const root = tempProject();
    const store = state(root);
    const actor = {
      kind: "git" as const,
      name: "  Alice   Example ",
      email: "ALICE@EXAMPLE.COM",
    };

    const cursor = store.markCatchUpCursor({
      actor,
      head: HEAD_A,
      branch: "feature/team",
      expectedRevision: null,
    });

    expect(cursor).toEqual({
      scaffoldId: "scaffold-a",
      actor: {
        kind: "git",
        name: "Alice Example",
        email: "alice@example.com",
      },
      head: HEAD_A,
      branch: "feature/team",
      timestamp: NOW,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.getCatchUpCursor(actor)).toEqual(cursor);
  });

  it("rejects unknown actors before creating local storage", () => {
    const root = tempProject();
    const store = state(root);

    expectCode(
      () => store.markCatchUpCursor({
        actor: { kind: "unknown" },
        head: HEAD_A,
        branch: "main",
        expectedRevision: null,
      }),
      "VALIDATION_FAILED",
    );
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });

  it("requires an explicit optimistic reset when the branch changes", () => {
    const root = tempProject();
    const store = state(root);
    const actor = { kind: "member" as const, memberId: MEMBER_A };
    const initial = store.markCatchUpCursor({
      actor,
      head: HEAD_A,
      branch: "main",
      expectedRevision: null,
    });

    const error = expectCode(
      () => store.markCatchUpCursor({
        actor,
        head: HEAD_B,
        branch: "feature/team",
        expectedRevision: initial.revision,
        timestamp: LATER,
      }),
      "REVISION_CONFLICT",
    );
    expect(error.problem.detail).toContain("explicitly reset");
    expect(store.getCatchUpCursor(actor)).toEqual(initial);

    const reset = store.resetCatchUpCursor({
      actor,
      head: HEAD_B,
      branch: "feature/team",
      expectedRevision: initial.revision,
      timestamp: LATER,
    });
    expect(reset.branch).toBe("feature/team");
    expect(reset.head).toBe(HEAD_B);

    expectCode(
      () => store.resetCatchUpCursor({
        actor,
        head: HEAD_A,
        branch: "main",
        expectedRevision: initial.revision,
      }),
      "REVISION_CONFLICT",
    );
    expect(store.getCatchUpCursor(actor)).toEqual(reset);
  });

  it("does not modify database bytes, timestamps, or sidecars during reads", () => {
    const root = tempProject();
    const writer = state(root);
    const selection = writer.configureMember({ memberId: MEMBER_A, expectedRevision: null });
    const localDir = join(root, ".mex/local");
    const dbPath = join(localDir, "team.db");
    const beforeBytes = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath, { bigint: true }).mtimeNs;
    const beforeFiles = readdirSync(localDir).sort();

    expect(state(root).getConfiguredMember()).toEqual(selection);

    expect(readFileSync(dbPath)).toEqual(beforeBytes);
    expect(statSync(dbPath, { bigint: true }).mtimeNs).toBe(beforeMtime);
    expect(readdirSync(localDir).sort()).toEqual(beforeFiles);
  });

  it("reads a checkpointed WAL-mode database immutably without creating WAL or SHM", () => {
    const root = tempProject();
    const store = state(root);
    const selection = store.configureMember({ memberId: MEMBER_A, expectedRevision: null });
    const localDir = join(root, ".mex/local");
    const dbPath = join(localDir, "team.db");

    const setup = new DatabaseSync(dbPath);
    const mode = setup.prepare("PRAGMA journal_mode = WAL").get() as {
      journal_mode: unknown;
    };
    setup.close();
    expect(mode.journal_mode).toBe("wal");
    expect(readdirSync(localDir).sort()).toEqual(["team.db"]);

    const beforeBytes = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath, { bigint: true }).mtimeNs;
    expect(state(root).getConfiguredMember()).toEqual(selection);

    expect(readFileSync(dbPath)).toEqual(beforeBytes);
    expect(statSync(dbPath, { bigint: true }).mtimeNs).toBe(beforeMtime);
    expect(readdirSync(localDir).sort()).toEqual(["team.db"]);
  });

  it("abstains from active WAL state without touching the database or sidecars", () => {
    const root = tempProject();
    const store = state(root);
    store.configureMember({ memberId: MEMBER_A, expectedRevision: null });
    const localDir = join(root, ".mex/local");
    const dbPath = join(localDir, "team.db");
    const activeWriter = new DatabaseSync(dbPath);

    try {
      activeWriter.exec("PRAGMA journal_mode = WAL");
      activeWriter.exec("CREATE TABLE active_writer_probe (value TEXT) STRICT");
      const beforeFiles = readdirSync(localDir).sort();
      expect(beforeFiles).toContain("team.db-wal");
      expect(beforeFiles).toContain("team.db-shm");
      const before = new Map(
        beforeFiles.map((file) => [file, {
          bytes: readFileSync(join(localDir, file)),
          mtime: statSync(join(localDir, file), { bigint: true }).mtimeNs,
        }]),
      );

      expectCode(() => store.getConfiguredMember(), "OPERATION_INTERRUPTED");

      expect(readdirSync(localDir).sort()).toEqual(beforeFiles);
      for (const [file, snapshot] of before) {
        expect(readFileSync(join(localDir, file))).toEqual(snapshot.bytes);
        expect(statSync(join(localDir, file), { bigint: true }).mtimeNs).toBe(snapshot.mtime);
      }
    } finally {
      activeWriter.close();
    }
  });

  it("reports old schemas without migrating on read and migrates on explicit write", () => {
    const root = tempProject();
    createSchemaVersionOnly(root, 0);
    const dbPath = join(root, ".mex/local/team.db");
    const before = readFileSync(dbPath);

    expectCode(() => state(root).getConfiguredMember(), "MIGRATION_REQUIRED");
    expect(readFileSync(dbPath)).toEqual(before);

    const selection = state(root).configureMember({
      memberId: MEMBER_A,
      expectedRevision: null,
    });
    expect(state(root).getConfiguredMember()).toEqual(selection);
  });

  it("keeps schema v3 reads immutable and migrates only through an explicit initializer", () => {
    const root = tempProject();
    createRawV3(root);
    const dbPath = join(root, ".mex/local/team.db");
    const localDirectory = join(root, ".mex/local");
    const actor = { kind: "member" as const, memberId: MEMBER_A };
    const memberRevision = createHash("sha256").update(JSON.stringify({
      schemaVersion: 1,
      scaffoldId: "scaffold-a",
      memberId: MEMBER_A,
      updatedAt: NOW,
    })).digest("hex");
    const cursorRevision = createHash("sha256").update(JSON.stringify({
      schemaVersion: 1,
      scaffoldId: "scaffold-a",
      actor,
      head: HEAD_A,
      branch: "main",
      timestamp: NOW,
    })).digest("hex");
    const jobId = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const jobRevision = createHash("sha256").update(JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      scaffoldId: "scaffold-a",
      kind: "graph_refresh",
      generation: 1,
      phase: "queued",
      progress: null,
      cancelRequested: false,
      state: "queued",
      createdAt: NOW,
      startedAt: null,
      finishedAt: null,
      interruptedReason: null,
      problem: null,
      summary: null,
    })).digest("hex");
    const seed = new DatabaseSync(dbPath);
    seed.prepare(`
      INSERT INTO configured_member_selections
        (scaffold_id, member_id, updated_at, revision)
      VALUES ('scaffold-a', ?, ?, ?)
    `).run(MEMBER_A, NOW, memberRevision);
    seed.prepare(`
      INSERT INTO catch_up_cursors
        (scaffold_id, actor_key, actor_json, head, branch, timestamp, revision)
      VALUES ('scaffold-a', ?, ?, ?, 'main', ?, ?)
    `).run(MEMBER_A, JSON.stringify(actor), HEAD_A, NOW, cursorRevision);
    seed.prepare(`
      INSERT INTO hub_jobs (
        id, scaffold_id, kind, generation, phase,
        progress_completed, progress_total, progress_message, cancel_requested,
        state, created_at, started_at, finished_at, interrupted_reason,
        problem_json, summary, revision
      ) VALUES (?, 'scaffold-a', 'graph_refresh', 1, 'queued',
        NULL, NULL, NULL, 0, 'queued', ?, NULL, NULL, NULL, NULL, NULL, ?)
    `).run(jobId, NOW, jobRevision);
    seed.close();
    const beforeBytes = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath, { bigint: true }).mtimeNs;
    const beforeEntries = readdirSync(localDirectory).sort();
    const store = state(root);

    expect(store.getConfiguredMember()).toMatchObject({
      memberId: MEMBER_A,
      revision: memberRevision,
    });
    expect(store.getCatchUpCursor(actor)).toMatchObject({
      head: HEAD_A,
      branch: "main",
      revision: cursorRevision,
    });
    expect(store.listHubJobs().items).toMatchObject([{
      id: jobId,
      revision: jobRevision,
    }]);
    expectCode(() => store.getLocalDraft(DRAFT_A), "MIGRATION_REQUIRED");
    expect(readFileSync(dbPath)).toEqual(beforeBytes);
    expect(statSync(dbPath, { bigint: true }).mtimeNs).toBe(beforeMtime);
    expect(readdirSync(localDirectory).sort()).toEqual(beforeEntries);

    store.initializeForMutation();
    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    expect(migrated.prepare("SELECT version FROM local_state_schema").get()).toEqual({ version: 4 });
    expect(migrated.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'inbox_drafts', 'relay_drafts', 'team_workflow_lease', 'team_workflow_operations'
      )
      ORDER BY name
    `).all()).toEqual([
      { name: "inbox_drafts" },
      { name: "relay_drafts" },
      { name: "team_workflow_lease" },
      { name: "team_workflow_operations" },
    ]);
    migrated.close();
  });

  it("rolls the v3-to-v4 migration back with a conflicting explicit mutation", () => {
    const root = tempProject();
    createRawV3(root);
    const store = state(root);

    expectCode(() => store.deleteLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      expectedRevision: "d".repeat(64),
    }), "REVISION_CONFLICT");

    const db = new DatabaseSync(join(root, ".mex/local/team.db"), { readOnly: true });
    expect(db.prepare("SELECT version FROM local_state_schema").get()).toEqual({ version: 3 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'inbox_drafts'
    `).get()).toEqual({ count: 0 });
    db.close();
  });

  it("previews and applies exact bounded local drafts with stable pagination", () => {
    const root = tempProject();
    const store = state(root);
    const firstRequest = {
      id: DRAFT_A,
      kind: "inbox" as const,
      payload: { rationale: "Review", plan: { z: 2, a: 1 } },
      expectedRevision: null,
      updatedAt: NOW,
    };

    const preview = store.previewSaveLocalDraft(firstRequest);
    expect(preview).toMatchObject({
      scaffoldId: "scaffold-a",
      id: DRAFT_A,
      kind: "inbox",
      updatedAt: NOW,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(existsSync(join(root, ".mex"))).toBe(false);
    expect(store.saveLocalDraft(firstRequest)).toEqual(preview);

    const relay = state(root, "scaffold-a", LATER).saveLocalDraft({
      id: DRAFT_B,
      kind: "relay",
      payload: { summary: "Hand off" },
      expectedRevision: null,
      updatedAt: LATER,
    });
    const firstPage = store.listLocalDrafts({ limit: 1 });
    expect(firstPage.items).toEqual([relay]);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(store.listLocalDrafts({ limit: 1, cursor: firstPage.nextCursor! })).toEqual({
      items: [preview],
      nextCursor: null,
      truncated: false,
    });
    expect(store.listLocalDrafts({ kind: "inbox" }).items).toEqual([preview]);

    const updated = store.previewSaveLocalDraft({
      ...firstRequest,
      payload: { rationale: "Updated", plan: { a: 1, z: 2 } },
      expectedRevision: preview.revision,
      updatedAt: LATER,
    });
    expect(store.saveLocalDraft({
      ...firstRequest,
      payload: updated.payload,
      expectedRevision: preview.revision,
      updatedAt: updated.updatedAt,
    })).toEqual(updated);
    expectCode(() => store.saveLocalDraft(firstRequest), "REVISION_CONFLICT");
    expect(store.previewDeleteLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      expectedRevision: updated.revision,
    })).toEqual(updated);
    store.deleteLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      expectedRevision: updated.revision,
    });
    expect(store.getLocalDraft(DRAFT_A)).toBeNull();
  });

  it("binds versioned draft cursors to the filter and complete bounded corpus", () => {
    const root = tempProject();
    const store = state(root);
    store.saveLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      payload: { summary: "First" },
      expectedRevision: null,
      updatedAt: NOW,
    });
    store.saveLocalDraft({
      id: "draft-second-inbox",
      kind: "inbox",
      payload: { summary: "Second" },
      expectedRevision: null,
      updatedAt: LATER,
    });

    const first = store.listLocalDrafts({ kind: "inbox", limit: 1 });
    const repeated = store.listLocalDrafts({ kind: "inbox", limit: 1 });
    expect(first.nextCursor).toBe(repeated.nextCursor);
    expect(Buffer.byteLength(first.nextCursor!, "utf8")).toBeLessThanOrEqual(4 * 1024);

    expectCode(
      () => store.listLocalDrafts({ kind: "relay", limit: 1, cursor: first.nextCursor! }),
      "REVISION_CONFLICT",
    );
    expectCode(
      () => state(root, "scaffold-b").listLocalDrafts({
        kind: "inbox",
        limit: 1,
        cursor: first.nextCursor!,
      }),
      "REVISION_CONFLICT",
    );

    // Even a mutation outside the selected filter changes the full corpus generation.
    store.saveLocalDraft({
      id: DRAFT_B,
      kind: "relay",
      payload: { summary: "Relay" },
      expectedRevision: null,
      updatedAt: "2026-08-23T12:00:00.000Z",
    });
    expectCode(
      () => store.listLocalDrafts({ kind: "inbox", limit: 1, cursor: first.nextCursor! }),
      "REVISION_CONFLICT",
    );
  });

  it("returns INVALID_REQUEST for malformed local draft cursors without initializing storage", () => {
    const root = tempProject();
    const store = state(root);
    const unsupported = Buffer.from(JSON.stringify({
      version: 2,
      scaffoldId: "scaffold-a",
      requestedKind: null,
      corpusRevision: "a".repeat(64),
      updatedAt: NOW,
      kind: "inbox",
      id: DRAFT_A,
    }), "utf8").toString("base64url");

    for (const cursor of ["%%%", unsupported, "x".repeat(4 * 1024 + 1)]) {
      expectCode(() => store.listLocalDrafts({ cursor }), "INVALID_REQUEST");
    }
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });

  it("enforces local draft byte and per-kind corpus ceilings before writes", () => {
    const oversizedRoot = tempProject();
    expectCode(() => state(oversizedRoot).saveLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      payload: { text: "x".repeat(64 * 1024) },
      expectedRevision: null,
    }), "VALIDATION_FAILED");
    expect(existsSync(join(oversizedRoot, ".mex"))).toBe(false);

    const fullRoot = tempProject();
    const store = state(fullRoot);
    store.initializeForMutation();
    const db = new DatabaseSync(join(fullRoot, ".mex/local/team.db"));
    const insert = db.prepare(`
      INSERT INTO inbox_drafts (scaffold_id, id, payload_json, updated_at, revision)
      VALUES ('scaffold-a', ?, '{}', ?, ?)
    `);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 512; index += 1) {
        insert.run(`seed-${String(index).padStart(3, "0")}`, NOW, "a".repeat(64));
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    expectCode(() => store.saveLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      payload: {},
      expectedRevision: null,
    }), "VALIDATION_FAILED");
    const verify = new DatabaseSync(join(fullRoot, ".mex/local/team.db"), { readOnly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM inbox_drafts").get()).toEqual({ count: 512 });
    verify.close();
  });

  it("serializes the Team workflow lease and recovers only a provably dead holder", () => {
    const root = tempProject();
    const aliveStore = new TeamLocalState({
      projectRoot: root,
      scaffoldId: "scaffold-a",
      processStatus: () => "alive",
    });
    expect(aliveStore.acquireTeamWorkflowLease({
      pid: 101,
      token: LEASE_A,
      acquiredAt: NOW,
    })).toEqual({
      scaffoldId: "scaffold-a",
      pid: 101,
      token: LEASE_A,
      acquiredAt: NOW,
    });
    expectCode(() => aliveStore.acquireTeamWorkflowLease({
      pid: 202,
      token: LEASE_B,
      acquiredAt: LATER,
    }), "OPERATION_INTERRUPTED");
    const otherScaffold = new TeamLocalState({
      projectRoot: root,
      scaffoldId: "scaffold-b",
      processStatus: () => "alive",
    });
    expectCode(() => otherScaffold.acquireTeamWorkflowLease({
      pid: 101,
      token: LEASE_A,
      acquiredAt: NOW,
    }), "OPERATION_INTERRUPTED");

    const recovery = new TeamLocalState({
      projectRoot: root,
      scaffoldId: "scaffold-b",
      processStatus: () => "dead",
    });
    expect(recovery.acquireTeamWorkflowLease({
      pid: 202,
      token: LEASE_B,
      acquiredAt: LATER,
    })).toEqual({
      scaffoldId: "scaffold-b",
      pid: 202,
      token: LEASE_B,
      acquiredAt: LATER,
    });
    recovery.releaseTeamWorkflowLease(LEASE_B);
  });

  it("never reassigns the repository workflow lease across an incomplete journal", () => {
    const root = tempProject();
    const original = new TeamLocalState({
      projectRoot: root,
      scaffoldId: "scaffold-a",
      processStatus: () => "alive",
      now: () => NOW,
    });
    original.acquireTeamWorkflowLease({ pid: 101, token: LEASE_A, acquiredAt: NOW });
    const intent = original.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [],
    }).entry;

    // Exact reacquisition by the attested owner remains idempotent.
    expect(original.acquireTeamWorkflowLease({
      pid: 101,
      token: LEASE_A,
      acquiredAt: LATER,
    })).toMatchObject({ scaffoldId: "scaffold-a", pid: 101, token: LEASE_A });

    const drifted = new TeamLocalState({
      projectRoot: root,
      scaffoldId: "scaffold-b",
      processStatus: () => "dead",
      now: () => LATER,
    });
    expectCode(() => drifted.acquireTeamWorkflowLease({
      pid: 202,
      token: LEASE_B,
      acquiredAt: LATER,
    }), "REVISION_CONFLICT");
    expect(original.getIncompleteWorkflowOperation()).toEqual(intent);
    expectCode(() => drifted.releaseTeamWorkflowLease(LEASE_A), "REVISION_CONFLICT");

    const sameScaffoldRecovery = new TeamLocalState({
      projectRoot: root,
      scaffoldId: "scaffold-a",
      processStatus: () => "dead",
      now: () => LATER,
    });
    expect(sameScaffoldRecovery.acquireTeamWorkflowLease({
      pid: 202,
      token: LEASE_B,
      acquiredAt: LATER,
    })).toMatchObject({ scaffoldId: "scaffold-a", pid: 202, token: LEASE_B });
  });

  it("journals immutable recovery effects and atomically finalizes draft cleanup", () => {
    const root = tempProject();
    const store = state(root);
    const draft = store.saveLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      payload: { rationale: "Ship" },
      expectedRevision: null,
      updatedAt: NOW,
    });
    store.acquireTeamWorkflowLease({ pid: 101, token: LEASE_A, acquiredAt: NOW });
    const effects = [
      {
        kind: "canonical" as const,
        namespace: "proposal",
        id: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        path: ".mex/inbox/proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
        beforeRevision: null,
        afterRevision: "d".repeat(64),
      },
      {
        kind: "activity" as const,
        id: "activity_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        path: ".mex/events/activity/2026-08/activity_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
        revision: "e".repeat(64),
        action: "inbox.publish",
        actor: { kind: "member" as const, memberId: MEMBER_A },
        occurredAt: NOW,
        repoState: { branch: "main", head: HEAD_A, dirty: false, observedAt: NOW },
        subjects: [{
          kind: "entity" as const,
          entity: { id: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "proposal" },
        }],
        metadata: { operation: "publish", attempt: 1 },
      },
      {
        kind: "local_cleanup" as const,
        draftKind: "inbox" as const,
        draftId: DRAFT_A,
        expectedRevision: draft.revision,
      },
    ];
    const begun = store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects,
    });
    expect(begun.idempotentReplay).toBe(false);
    expect(store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects,
    })).toMatchObject({ idempotentReplay: true, entry: begun.entry });
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: "8".repeat(64),
      effects,
    }), "REVISION_CONFLICT");

    const published = store.advanceWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      expectedRevision: begun.entry.revision,
      phase: "canonical_published",
      effects,
    });
    const changedEffects = effects.map((effect) => effect.kind === "canonical"
      ? { ...effect, afterRevision: "f".repeat(64) }
      : effect);
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: changedEffects,
    }), "REVISION_CONFLICT");
    expectCode(() => store.advanceWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      expectedRevision: published.revision,
      phase: "local_finalized",
      effects: changedEffects,
      deleteDrafts: [{ kind: "inbox", id: DRAFT_A, expectedRevision: draft.revision }],
    }), "REVISION_CONFLICT");
    expect(store.getLocalDraft(DRAFT_A)).toEqual(draft);

    const finalized = store.advanceWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      expectedRevision: published.revision,
      phase: "local_finalized",
      effects,
      deleteDrafts: [{ kind: "inbox", id: DRAFT_A, expectedRevision: draft.revision }],
    });
    expect(store.getLocalDraft(DRAFT_A)).toBeNull();
    const completed = store.advanceWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      expectedRevision: finalized.revision,
      phase: "complete",
      effects,
    });
    expect(completed.effects).toEqual(effects);
    expect(store.getIncompleteWorkflowOperation()).toBeNull();
    store.releaseTeamWorkflowLease(LEASE_A);
  });

  it("rolls back local finalization when exact cleanup cannot be completed", () => {
    const root = tempProject();
    const store = state(root);
    const draft = store.saveLocalDraft({
      id: DRAFT_A,
      kind: "inbox",
      payload: { rationale: "Ship" },
      expectedRevision: null,
    });
    store.acquireTeamWorkflowLease({ pid: 101, token: LEASE_A, acquiredAt: NOW });
    const effects = [{
      kind: "local_cleanup" as const,
      draftKind: "inbox" as const,
      draftId: DRAFT_A,
      expectedRevision: "f".repeat(64),
    }];
    const intent = store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects,
    }).entry;
    const published = store.advanceWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      expectedRevision: intent.revision,
      phase: "canonical_published",
      effects,
    });
    expectCode(() => store.advanceWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-a",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      expectedRevision: published.revision,
      phase: "local_finalized",
      effects,
      deleteDrafts: [{ kind: "inbox", id: DRAFT_A, expectedRevision: "f".repeat(64) }],
    }), "REVISION_CONFLICT");
    expect(store.getLocalDraft(DRAFT_A)).toEqual(draft);
    expect(store.getIncompleteWorkflowOperation()).toEqual(published);
  });

  it("rejects private or oversized Activity recovery metadata and excess effects", () => {
    const root = tempProject();
    const store = state(root);
    store.acquireTeamWorkflowLease({ pid: 101, token: LEASE_A, acquiredAt: NOW });
    const activity = {
      kind: "activity" as const,
      id: "activity_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      path: ".mex/events/activity/2026-08/activity_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      revision: "e".repeat(64),
      action: "activity.record",
      actor: { kind: "member" as const, memberId: MEMBER_A },
      occurredAt: NOW,
      repoState: { branch: "main", head: HEAD_A, dirty: false, observedAt: NOW },
      subjects: [],
    };
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-private",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{ ...activity, metadata: { sourceBody: "private source" } }],
    }), "VALIDATION_FAILED");
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-large",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{ ...activity, metadata: { note: "x".repeat(8 * 1024) } }],
    }), "VALIDATION_FAILED");
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-effects",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: Array.from({ length: 17 }, (_, index) => ({
        kind: "local" as const,
        namespace: "inbox-draft",
        id: `draft-${index}`,
        beforeRevision: null,
        afterRevision: "a".repeat(64),
      })),
    }), "VALIDATION_FAILED");
    const boundary = store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-subject-boundary",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{
        ...activity,
        subjects: Array.from({ length: 64 }, (_, index) => ({
          kind: "file" as const,
          path: `src/boundary-${index}.ts`,
        })),
      }],
    }).entry;
    expect((boundary.effects[0] as { subjects: readonly unknown[] }).subjects).toHaveLength(64);
    store.abandonWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-subject-boundary",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      expectedRevision: boundary.revision,
    });
    expect(store.getIncompleteWorkflowOperation()).toBeNull();

    const specSubjectEffect = {
      ...activity,
      action: "inbox.approved",
      subjects: [{
        kind: "entity" as const,
        entity: {
          id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          kind: "acceptance_criterion",
          title: "Exact acceptance criterion",
        },
      }],
    };
    const specSubjectEntry = store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-spec-subject",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [specSubjectEffect],
    }).entry;
    expect(specSubjectEntry.effects).toEqual([specSubjectEffect]);
    expect(store.getWorkflowOperation("operation-spec-subject")).toEqual(
      specSubjectEntry,
    );
    store.abandonWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: specSubjectEntry.operationId,
      commandRevision: specSubjectEntry.commandRevision,
      previewRevision: specSubjectEntry.previewRevision,
      expectedRevision: specSubjectEntry.revision,
    });
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-invalid-spec-subject",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{
        ...specSubjectEffect,
        subjects: [{
          kind: "entity" as const,
          entity: {
            id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            kind: "acceptance__criterion",
          },
        }],
      }],
    }), "VALIDATION_FAILED");

    const receiptEffect = {
      kind: "identity_activity_receipt" as const,
      envelopeRevision: "7".repeat(64),
    };
    const receiptEntry = store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-identity-receipt",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [receiptEffect],
    }).entry;
    expect(receiptEntry.effects).toEqual([receiptEffect]);
    store.abandonWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: receiptEntry.operationId,
      commandRevision: receiptEntry.commandRevision,
      previewRevision: receiptEntry.previewRevision,
      expectedRevision: receiptEntry.revision,
    });
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-identity-receipt-private",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{ ...receiptEffect, sourceBody: "private body" } as never],
    }), "VALIDATION_FAILED");
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-identity-receipt-invalid",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{ ...receiptEffect, envelopeRevision: "not-a-revision" }],
    }), "VALIDATION_FAILED");
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-identity-receipt-duplicate",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [receiptEffect, receiptEffect],
    }), "VALIDATION_FAILED");

    const wikiManifest = {
      schemaVersion: 1 as const,
      requestHash: "1".repeat(64),
      operationId: "wiki-batch-1",
      items: [{
        operationId: "wiki-batch-1-item-01",
        type: "update-entry" as const,
        payloadHash: "2".repeat(64),
        createdIds: [],
        files: [{
          path: ".mex/context/decision.md",
          beforeRevision: "3".repeat(64),
          afterRevision: "4".repeat(64),
        }],
        revisions: [{
          entityId: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          before: 1,
          after: 2,
        }],
        audit: {
          beforeRevision: "5".repeat(64),
          afterRevision: "6".repeat(64),
        },
      }],
    };
    const wikiEntry = store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-wiki-manifest",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{ kind: "wiki_recovery", manifest: wikiManifest }],
    }).entry;
    expect(wikiEntry.effects).toEqual([{
      kind: "wiki_recovery",
      manifest: wikiManifest,
    }]);
    store.abandonWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: wikiEntry.operationId,
      commandRevision: wikiEntry.commandRevision,
      previewRevision: wikiEntry.previewRevision,
      expectedRevision: wikiEntry.revision,
    });
    expectCode(() => store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-wiki-private",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [{
        kind: "wiki_recovery",
        manifest: {
          ...wikiManifest,
          items: [{ ...wikiManifest.items[0]!, sourceBody: "private body" }],
        },
      } as never],
    }), "VALIDATION_FAILED");
  });

  it("normalizes both legacy and provenance-aware Activity recovery effects exactly", () => {
    const legacyEffect = {
      kind: "activity" as const,
      id: "activity_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      path: ".mex/events/activity/2026-08/activity_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      revision: "e".repeat(64),
      action: "relay.closed",
      actor: { kind: "member" as const, memberId: MEMBER_A },
      occurredAt: NOW,
      repoState: { branch: "main", head: HEAD_A, dirty: false, observedAt: NOW },
      subjects: [],
    };
    expect(normalizeTeamWorkflowJournalEffects([legacyEffect])).toEqual([legacyEffect]);

    const provenanceAwareEffect = {
      ...legacyEffect,
      schemaVersion: 2 as const,
      origin: { kind: "workflow" as const, operation: "relay.close" },
    };
    expect(normalizeTeamWorkflowJournalEffects([provenanceAwareEffect])).toEqual([
      provenanceAwareEffect,
    ]);
    expectCode(() => normalizeTeamWorkflowJournalEffects([{
      ...provenanceAwareEffect,
      origin: { kind: "custom", operation: "relay.close" },
    }]), "VALIDATION_FAILED");
    expectCode(() => normalizeTeamWorkflowJournalEffects([{
      ...provenanceAwareEffect,
      label: "Activity labels stay out of recovery journals",
    }]), "VALIDATION_FAILED");
    expectCode(() => normalizeTeamWorkflowJournalEffects([{
      ...legacyEffect,
      schemaVersion: 3,
    }]), "VALIDATION_FAILED");
  });

  it("retains no more than 256 terminal workflow rows per scaffold", () => {
    const root = tempProject();
    const store = state(root);
    store.acquireTeamWorkflowLease({ pid: 101, token: LEASE_A, acquiredAt: NOW });
    const db = new DatabaseSync(join(root, ".mex/local/team.db"));
    const insert = db.prepare(`
      INSERT INTO team_workflow_operations (
        scaffold_id, operation_id, command_revision, preview_revision, phase, effects_json,
        created_at, updated_at, revision
      ) VALUES ('scaffold-a', ?, ?, ?, 'complete', '[]', ?, ?, ?)
    `);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 256; index += 1) {
        insert.run(
          `retained-${String(index).padStart(3, "0")}`,
          "c".repeat(64),
          "9".repeat(64),
          NOW,
          NOW,
          "d".repeat(64),
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    let entry = store.beginWorkflowOperation({
      leaseToken: LEASE_A,
      operationId: "operation-current",
      commandRevision: COMMAND_A,
      previewRevision: PREVIEW_A,
      effects: [],
    }).entry;
    for (const phase of ["canonical_published", "local_finalized", "complete"] as const) {
      entry = store.advanceWorkflowOperation({
        leaseToken: LEASE_A,
        operationId: "operation-current",
        commandRevision: COMMAND_A,
        previewRevision: PREVIEW_A,
        expectedRevision: entry.revision,
        phase,
        effects: [],
      });
    }
    const verify = new DatabaseSync(join(root, ".mex/local/team.db"), { readOnly: true });
    expect(verify.prepare(`
      SELECT COUNT(*) AS count
      FROM team_workflow_operations
      WHERE scaffold_id = 'scaffold-a' AND phase = 'complete'
    `).get()).toEqual({ count: 256 });
    verify.close();
  });

  it("migrates v1 through v2 and v3 to v4 while preserving Lane C rows", () => {
    const root = tempProject();
    createRawV1(root);
    const dbPath = join(root, ".mex/local/team.db");
    const actor = { kind: "member" as const, memberId: MEMBER_A };
    const actorJson = JSON.stringify(actor);
    const memberRevision = createHash("sha256").update(JSON.stringify({
      schemaVersion: 1,
      scaffoldId: "scaffold-a",
      memberId: MEMBER_A,
      updatedAt: NOW,
    })).digest("hex");
    const cursorRevision = createHash("sha256").update(JSON.stringify({
      schemaVersion: 1,
      scaffoldId: "scaffold-a",
      actor,
      head: HEAD_A,
      branch: "main",
      timestamp: NOW,
    })).digest("hex");
    const seed = new DatabaseSync(dbPath);
    seed.prepare(`
      INSERT INTO configured_member_selections
        (scaffold_id, member_id, updated_at, revision)
      VALUES (?, ?, ?, ?)
    `).run("scaffold-a", MEMBER_A, NOW, memberRevision);
    seed.prepare(`
      INSERT INTO catch_up_cursors
        (scaffold_id, actor_key, actor_json, head, branch, timestamp, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("scaffold-a", MEMBER_A, actorJson, HEAD_A, "main", NOW, cursorRevision);
    seed.close();
    const beforeRead = readFileSync(dbPath);

    expect(state(root).getConfiguredMember()).toMatchObject({
      memberId: MEMBER_A,
      revision: memberRevision,
    });
    expect(state(root).getCatchUpCursor(actor)).toMatchObject({
      head: HEAD_A,
      branch: "main",
      revision: cursorRevision,
    });
    expect(readFileSync(dbPath)).toEqual(beforeRead);

    const store = state(root);
    store.initializeHubState();
    expect(store.getConfiguredMember()).toMatchObject({
      memberId: MEMBER_A,
      revision: memberRevision,
    });
    expect(store.getCatchUpCursor(actor)).toMatchObject({
      head: HEAD_A,
      branch: "main",
      revision: cursorRevision,
    });

    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    expect(migrated.prepare("SELECT version FROM local_state_schema").get()).toEqual({
      version: 4,
    });
    const hubTable = migrated.prepare(`
      SELECT strict
      FROM pragma_table_list
      WHERE schema = 'main' AND name = 'hub_jobs'
    `).get();
    expect(hubTable).toEqual({ strict: 1 });
    const indexes = migrated.prepare(`
      SELECT name
      FROM pragma_index_list('hub_jobs')
      WHERE origin = 'c'
      ORDER BY name
    `).all();
    expect(indexes).toEqual([
      { name: "hub_jobs_generation_per_kind" },
      { name: "hub_jobs_one_active_index_job_per_scaffold" },
      { name: "hub_jobs_scaffold_created" },
    ]);
    migrated.close();
  });

  it("rolls back the v1-to-v4 migration when the requested job mutation fails", () => {
    const root = tempProject();
    createRawV1(root);
    const store = state(root);

    expectCode(() => store.updateHubJobRecord({
      leaseToken: LEASE_A,
      id: "job_01K3CQW3G00000000000000000",
      generation: 1,
      expectedRevision: "a".repeat(64),
      phase: "running",
      progress: null,
      cancelRequested: false,
      state: "running",
      startedAt: NOW,
    }), "REVISION_CONFLICT");
    expect(store.getConfiguredMember()).toBeNull();

    const db = new DatabaseSync(join(root, ".mex/local/team.db"), { readOnly: true });
    expect(db.prepare("SELECT version FROM local_state_schema").get()).toEqual({ version: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'hub_jobs'
    `).get()).toEqual({ count: 0 });
    db.close();
  });

  it("keeps schema v2 reads non-mutating and migrates queued jobs through v4 exactly", () => {
    const root = tempProject();
    createRawV2(root, true);
    const dbPath = join(root, ".mex/local/team.db");
    const before = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath, { bigint: true }).mtimeNs;
    const store = state(root);

    expect(store.listHubJobs().items).toMatchObject([{
      id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      phase: "queued",
      state: "queued",
    }]);
    expect(readFileSync(dbPath)).toEqual(before);
    expect(statSync(dbPath, { bigint: true }).mtimeNs).toBe(beforeMtime);

    store.initializeHubState();
    expect(store.listHubJobs().items).toMatchObject([{
      id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      phase: "queued",
      state: "queued",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    expect(migrated.prepare("SELECT version FROM local_state_schema").get()).toEqual({ version: 4 });
    const sql = migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hub_jobs'")
      .get() as { sql: string };
    expect(sql.sql).toContain("'discover'");
    expect(sql.sql).toContain("'publish'");
    migrated.close();
  });

  it("rolls the v2-to-v3 phase migration back when the requested mutation fails", () => {
    const root = tempProject();
    createRawV2(root, true);
    const dbPath = join(root, ".mex/local/team.db");
    const before = readFileSync(dbPath);

    expectCode(() => state(root).updateHubJobRecord({
      leaseToken: LEASE_A,
      id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generation: 1,
      expectedRevision: "a".repeat(64),
      phase: "discover",
      progress: null,
      cancelRequested: false,
      state: "running",
      startedAt: NOW,
    }), "REVISION_CONFLICT");

    expect(readFileSync(dbPath)).toEqual(before);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(db.prepare("SELECT version FROM local_state_schema").get()).toEqual({ version: 2 });
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hub_jobs'")
      .get() as { sql: string };
    expect(sql.sql).not.toContain("'discover'");
    db.close();
  });

  it("rejects a v3 database whose required partial index was replaced", () => {
    const root = tempProject();
    const store = state(root);
    store.initializeHubState();
    const db = new DatabaseSync(join(root, ".mex/local/team.db"));
    db.exec("DROP INDEX hub_jobs_one_active_index_job_per_scaffold");
    db.exec(`
      CREATE UNIQUE INDEX hub_jobs_one_active_index_job_per_scaffold
      ON hub_jobs (scaffold_id)
      WHERE state = 'running'
    `);
    db.close();

    expectCode(() => store.listHubJobs(), "INDEX_CORRUPT");
  });

  it("rolls a schema migration back when the requested mutation conflicts", () => {
    const root = tempProject();
    createSchemaVersionOnly(root, 0);

    expectCode(
      () => state(root).configureMember({
        memberId: MEMBER_A,
        expectedRevision: "c".repeat(64),
      }),
      "REVISION_CONFLICT",
    );
    expectCode(() => state(root).getConfiguredMember(), "MIGRATION_REQUIRED");
  });

  it("reports newer schemas as migration-required", () => {
    const root = tempProject();
    createSchemaVersionOnly(root, 5);

    expectCode(() => state(root).getConfiguredMember(), "MIGRATION_REQUIRED");
    expectCode(
      () => state(root).configureMember({ memberId: MEMBER_A, expectedRevision: null }),
      "MIGRATION_REQUIRED",
    );
  });

  it("rejects malformed v1 table semantics even when every column name exists", () => {
    const malformedSchemas: Array<{ label: string; overrides: RawV1SchemaOverrides }> = [
      {
        label: "non-STRICT table",
        overrides: {
          configuredMembers: VALID_CONFIGURED_MEMBERS_TABLE.replace(" STRICT;", ";"),
        },
      },
      {
        label: "wrong declared type",
        overrides: {
          configuredMembers: VALID_CONFIGURED_MEMBERS_TABLE.replace(
            "revision TEXT NOT NULL",
            "revision BLOB NOT NULL",
          ),
        },
      },
      {
        label: "nullable required column",
        overrides: {
          configuredMembers: VALID_CONFIGURED_MEMBERS_TABLE.replace(
            "member_id TEXT NOT NULL",
            "member_id TEXT",
          ),
        },
      },
      {
        label: "missing configured-member primary key",
        overrides: {
          configuredMembers: VALID_CONFIGURED_MEMBERS_TABLE.replace(" PRIMARY KEY", ""),
        },
      },
      {
        label: "reversed composite cursor primary key",
        overrides: {
          catchUpCursors: VALID_CATCH_UP_CURSORS_TABLE.replace(
            "PRIMARY KEY (scaffold_id, actor_key)",
            "PRIMARY KEY (actor_key, scaffold_id)",
          ),
        },
      },
      {
        label: "unexpected v1 table",
        overrides: { extra: "CREATE TABLE unexpected (value TEXT) STRICT;" },
      },
    ];

    for (const { label, overrides } of malformedSchemas) {
      const root = tempProject();
      createRawV1(root, overrides);
      const error = expectCode(() => state(root).getConfiguredMember(), "INDEX_CORRUPT");
      expect(error.problem.detail.length, label).toBeGreaterThan(0);
    }
  });

  it("reports invalid SQLite and tampered rows as corrupt", () => {
    const invalidRoot = tempProject();
    mkdirSync(join(invalidRoot, ".mex/local"), { recursive: true });
    writeFileSync(join(invalidRoot, ".mex/local/team.db"), "not a sqlite database");
    expectCode(() => state(invalidRoot).getConfiguredMember(), "INDEX_CORRUPT");

    const tamperedRoot = tempProject();
    const store = state(tamperedRoot);
    const actor = { kind: "member" as const, memberId: MEMBER_A };
    store.markCatchUpCursor({
      actor,
      head: HEAD_A,
      branch: "main",
      expectedRevision: null,
    });
    const db = new DatabaseSync(join(tamperedRoot, ".mex/local/team.db"));
    db.prepare("UPDATE catch_up_cursors SET actor_json = ?").run('{"kind":"unknown"}');
    db.close();

    expectCode(() => store.getCatchUpCursor(actor), "INDEX_CORRUPT");
  });

  it("rejects malformed IDs, revisions, timestamps, and Git state before writing", () => {
    const root = tempProject();
    const store = state(root);

    expectCode(
      () => store.configureMember({ memberId: "member_bad", expectedRevision: null }),
      "VALIDATION_FAILED",
    );
    expectCode(
      () => store.markCatchUpCursor({
        actor: { kind: "member", memberId: MEMBER_A },
        head: "short",
        branch: "main",
        expectedRevision: null,
      }),
      "VALIDATION_FAILED",
    );
    expectCode(
      () => store.markCatchUpCursor({
        actor: { kind: "member", memberId: MEMBER_A },
        head: HEAD_A,
        branch: "bad\nbranch",
        expectedRevision: null,
      }),
      "VALIDATION_FAILED",
    );
    expectCode(
      () => store.markCatchUpCursor({
        actor: { kind: "member", memberId: MEMBER_A },
        head: HEAD_A,
        branch: "main",
        expectedRevision: null,
        timestamp: "2026-08-23",
      }),
      "VALIDATION_FAILED",
    );
    expectCode(
      () => store.configureMember({
        memberId: MEMBER_A,
        expectedRevision: "d".repeat(64),
      }),
      "REVISION_CONFLICT",
    );
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });

  it("refuses a symlinked local-state path", () => {
    const root = tempProject();
    const target = tempProject();
    symlinkSync(target, join(root, ".mex"));

    expectCode(() => state(root).getConfiguredMember(), "PATH_OUTSIDE_PROJECT");
    expect(readdirSync(target)).toEqual([]);
  });
});

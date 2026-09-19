/**
 * Making a rebuilt index live, without a reader ever seeing half of one.
 *
 * The rule is one `rename(2)` in one directory. A reader either opens the old
 * database or the new one; there is no moment at which `wiki.db` is a database
 * with some of its rows. Building in place would give exactly that moment, and
 * it would last the whole rebuild.
 *
 * Three details are load-bearing and none of them are obvious:
 *
 * **Same directory.** A rename across devices is a copy plus a delete, and a
 * copy is not atomic. The temp database is created beside its target, and
 * `dbfile.ts` refuses paths that are not database files at all.
 *
 * **Checkpoint before close.** A WAL database's committed rows live partly in
 * `wiki.db-wal`. Renaming the database alone would publish a file missing its
 * most recent transactions, and leave a `-wal` beside it belonging to a
 * database that no longer exists — which SQLite may try to recover into the
 * new one. `wal_checkpoint(TRUNCATE)` folds the WAL back in first, and the
 * target's stale siblings are removed as part of the rename.
 *
 * **Temp files never outlive a run.** A crashed build leaves `wiki.db.tmp-…`
 * behind; the next build sweeps them before starting, so a half-built database
 * can never be mistaken for a real one and disk usage cannot grow without
 * bound.
 */

import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { WikiIndexHandle } from "./open.js";
import { createWikiIndex, openWikiIndexForWrite } from "./open.js";
import { openSqlite } from "../../graph/db/sqlite.js";
import { WIKI_META_KEYS, WIKI_SCHEMA_VERSION } from "./schema.js";
import {
  assertIndexPath,
  assertIndexGeneration,
  bindIndexGeneration,
  cloneIndexFile,
  indexSiblingPaths,
  publishIndexFile,
  removeBoundIndexGeneration,
  removeIndexFiles,
  type IndexDirectoryBinding,
  type IndexGenerationBinding,
} from "./dbfile.js";
import type { WikiDiagnostic } from "../model/diagnostic.js";

/** A temp database beside `targetPath`, ready to be built into. */
export function createPendingIndex(
  targetPath: string,
  binding: IndexDirectoryBinding,
): { handle: WikiIndexHandle; tempPath: string } {
  const tempPath = `${targetPath}.tmp-${randomBytes(6).toString("hex")}`;
  // The guard is repeated by publication and cleanup; this one protects the
  // SQLite create itself, before it can make the temp file.
  assertIndexPath(tempPath, binding);
  return { handle: createWikiIndex(tempPath), tempPath };
}

/** Clone the published generation and open only the candidate for refresh. */
export function clonePendingIndex(
  targetPath: string,
  binding: IndexDirectoryBinding,
):
  | { ok: true; handle: WikiIndexHandle; tempPath: string }
  | { ok: false; diagnostic: WikiDiagnostic } {
  const tempPath = `${targetPath}.tmp-${randomBytes(6).toString("hex")}`;
  assertIndexPath(tempPath, binding);
  cloneIndexFile(targetPath, tempPath, binding);
  const opened = openWikiIndexForWrite(tempPath);
  if (!opened.ok) {
    removeIndexFiles(tempPath, binding);
    return { ok: false, diagnostic: opened.diagnostic };
  }
  return { ok: true, handle: opened.index, tempPath };
}

/**
 * Fold the WAL back into the database, close it, and rename it into place.
 *
 * After this the handle is closed whether it succeeded or not — a caller
 * holding an open handle to a file that has been renamed is a subtle way to
 * keep a deleted database alive on Windows.
 */
export function publishPendingIndex(
  handle: WikiIndexHandle,
  tempPath: string,
  targetPath: string,
  binding: IndexDirectoryBinding,
  validate: (path: string) => void = validatePublishedIndex,
  restore?: (recoveryPath: string, targetPath: string) => void,
): void {
  // Candidate validation is intentionally the engine invariant, independent
  // from an injected post-publication validator used by rollback tests.
  const candidate = sealPendingIndex(handle, tempPath, binding);
  const live = bindIndexGeneration(targetPath, binding);
  publishSealedPendingIndex(tempPath, targetPath, binding, candidate, live, validate, restore);
}

export interface SealedPendingIndex {
  readonly generation: IndexGenerationBinding;
}

/** Checkpoint, close, validate and bind the exact candidate generation. */
export function sealPendingIndex(
  handle: WikiIndexHandle,
  tempPath: string,
  binding: IndexDirectoryBinding,
  validate: (path: string) => void = validatePublishedIndex,
): SealedPendingIndex {
  try {
    handle.db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    handle.close();
  }
  if (indexSiblingPaths(tempPath).some((path) => existsSync(path))) {
    throw new Error("The prepared Wiki candidate retained a SQLite sidecar.");
  }
  const generation = bindIndexGeneration(tempPath, binding);
  if (!generation.exists) throw new Error("The prepared Wiki candidate is absent.");
  validate(tempPath);
  assertIndexGeneration(tempPath, generation, binding);
  return { generation };
}

export function publishSealedPendingIndex(
  tempPath: string,
  targetPath: string,
  binding: IndexDirectoryBinding,
  candidate: SealedPendingIndex,
  live: IndexGenerationBinding,
  validate: (path: string) => void = validatePublishedIndex,
  restore?: (recoveryPath: string, targetPath: string) => void,
  hooks?: {
    beforeRecoveryLink?: () => void;
    beforeCandidateRename?: () => void;
    afterCandidateRename?: () => void;
  },
): void {
  publishIndexFile(
    tempPath,
    targetPath,
    binding,
    () => validate(targetPath),
    restore,
    { candidate: candidate.generation, live, ...hooks },
  );
}

/** Drop only the exact sealed candidate owned by a prepared maintenance job. */
export function discardSealedPendingIndex(
  tempPath: string,
  binding: IndexDirectoryBinding,
  candidate: SealedPendingIndex,
): void {
  removeBoundIndexGeneration(tempPath, candidate.generation, binding);
}

/** Drop a temp database that will not be published. */
export function discardPendingIndex(
  handle: WikiIndexHandle,
  tempPath: string,
  binding: IndexDirectoryBinding,
): void {
  try {
    // Publication closes before it renames. If the rename/validation then
    // fails, rebuild reaches this cleanup path with an already-closed handle.
    // Closing is best effort; deleting the bound candidate is not.
    try {
      handle.close();
    } catch {
      // The candidate path remains the cleanup authority below.
    }
  } finally {
    removeIndexFiles(tempPath, binding);
  }
}

/**
 * Remove temp databases left behind by a crashed build.
 *
 * Matched by name against the target, so a sweep for `wiki.db` cannot delete
 * something belonging to another database in the same directory.
 */
export function sweepPendingIndexes(targetPath: string, binding: IndexDirectoryBinding): string[] {
  const directory = dirname(targetPath);
  const prefix = `${basename(targetPath)}.tmp-`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const swept: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.startsWith(prefix)) continue;
    // Skip the WAL/SHM siblings; removeIndexFiles takes them with the database.
    if (/-(wal|shm|journal)$/.test(entry)) continue;
    removeIndexFiles(join(directory, entry), binding);
    swept.push(entry);
  }
  return swept;
}

function validatePublishedIndex(path: string): void {
  // Immutable mode is load-bearing here. A normal read-only open of a WAL
  // database may create `-wal`/`-shm`, making the just-published namespace look
  // writer-active and preventing the next explicit rebuild.
  const db = openSqlite(path, { readOnly: true, immutable: true });
  try {
    const version = db.prepare(`SELECT value FROM wiki_meta WHERE key = ?`)
      .get(WIKI_META_KEYS.schemaVersion) as { value?: unknown } | undefined;
    if (version?.value !== String(WIKI_SCHEMA_VERSION)) {
      throw new Error("The published Wiki index has an unsupported schema version.");
    }
    const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check?: unknown }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error("The published Wiki index did not pass SQLite integrity validation.");
    }
  } finally {
    db.close();
  }
}

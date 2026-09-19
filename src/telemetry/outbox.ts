/** Small per-user queue. SQLite's OS locks disappear on process exit; no lockfiles. */
import { closeSync, constants, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureMexHomeDir, mexHomeDir } from "../global-config.js";
import { openSqlite, type SqliteDatabase } from "../graph/db/sqlite.js";
import { type TelemetryEvent, validateStoredEvent } from "./schema.js";

export const OUTBOX_LIMITS = Object.freeze({
  events: 256, bytes: 256 * 1024, eventBytes: 2048, databaseBytes: 1024 * 1024,
  ageMs: 7 * 24 * 60 * 60 * 1000, batchEvents: 32, leaseMs: 5000,
});
const TABLE_SQL = "CREATE TABLE events (uuid TEXT PRIMARY KEY, occurred INTEGER NOT NULL, payload TEXT NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0)";
interface FileIdentity { dev: bigint; ino: bigint; }
interface QueueHandle { path: string; db: SqliteDatabase; identity: FileIdentity; directory: FileIdentity; }
export interface DeliveryBatch { token: string; events: TelemetryEvent[]; queue: QueueHandle; }
let cached: QueueHandle | undefined;

function identity(path: string, directory = false): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) throw new Error("Unsafe telemetry path");
  if (!directory && stat.size > BigInt(OUTBOX_LIMITS.databaseBytes)) throw new Error("Telemetry store too large");
  return { dev: stat.dev, ino: stat.ino };
}
function same(a: FileIdentity, b: FileIdentity): boolean { return a.dev === b.dev && a.ino === b.ino; }
function validSchema(db: SqliteDatabase, allowEmpty = false): boolean {
  const rows = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 3").all() as Array<{ name: string; type: string; sql: string }>;
  return (allowEmpty && rows.length === 0) || (rows.length === 1 && rows[0].name === "events" && rows[0].type === "table" && rows[0].sql === TABLE_SQL);
}
function safeStorePath(create: boolean): string | undefined {
  const base = mexHomeDir();
  try {
    if (create) ensureMexHomeDir();
    identity(base, true);
    const directory = join(base, "telemetry");
    if (create) {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    identity(directory, true);
    const path = join(directory, "outbox.db");
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { identity(path + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (create) {
      try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    identity(path);
    // Reject obviously non-SQLite files before handing a filename to native code.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const header = Buffer.alloc(16);
      const count = readSync(fd, header, 0, header.length, 0);
      if (count !== 0 && (count !== 16 || header.toString("binary") !== "SQLite format 3\0")) throw new Error("Invalid telemetry store");
      if (!create && count === 0) return undefined;
    } finally { closeSync(fd); }
    return path;
  } catch { return undefined; }
}
function validHandle(queue: QueueHandle): boolean {
  try { return queue.db.open && same(queue.identity, identity(queue.path)) && same(queue.directory, identity(join(mexHomeDir(), "telemetry"), true)); }
  catch { return false; }
}

export function closeOutbox(): void {
  try { cached?.db.close(); } catch { /* best effort */ }
  cached = undefined;
}

function getQueue(create = true): QueueHandle | undefined {
  const path = safeStorePath(create);
  if (!path) { closeOutbox(); return undefined; }
  if (cached && cached.path === path && validHandle(cached)) return cached;
  closeOutbox();
  let db: SqliteDatabase | undefined;
  try {
    const file = identity(path);
    const directory = identity(join(mexHomeDir(), "telemetry"), true);
    db = openSqlite(path);
    // Never wait on another invocation or fsync product execution for analytics.
    // DELETE journals recover interrupted transactions; a power failure may lose
    // telemetry (synchronous=OFF). No WAL/shm growth or background checkpointing.
    db.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;");
    if (!validSchema(db, create)) throw new Error("Unknown telemetry schema");
    const page = db.prepare("PRAGMA page_size").get() as { page_size: number };
    if (!Number.isSafeInteger(page.page_size) || page.page_size < 512 || page.page_size > 65536) throw new Error("Invalid telemetry page size");
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA secure_delete=ON; PRAGMA max_page_count=${Math.floor(OUTBOX_LIMITS.databaseBytes / page.page_size)};`);
    if (!same(file, identity(path)) || !same(directory, identity(join(mexHomeDir(), "telemetry"), true))) throw new Error("Telemetry store replaced");
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 3").all() as Array<{ name: string; type: string; sql: string }>;
      if (rows.length === 0) db.exec(TABLE_SQL);
      else if (rows.length !== 1 || rows[0].name !== "events" || rows[0].type !== "table" || rows[0].sql !== TABLE_SQL) throw new Error("Unknown telemetry schema");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    cached = { path, db, identity: file, directory };
    return cached;
  } catch { try { db?.close(); } catch { /* best effort */ } return undefined; }
}

function transaction<T>(queue: QueueHandle, body: () => T): T | undefined {
  try {
    if (!validHandle(queue) || !validSchema(queue.db)) return undefined;
    queue.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); queue.db.exec("COMMIT"); return result; }
    catch { queue.db.exec("ROLLBACK"); }
  } catch { /* A busy queue drops work instead of blocking a command. */ }
  return undefined;
}

export function enqueue(event: TelemetryEvent, now = Date.now()): boolean {
  if (!validateStoredEvent(event)) return false;
  const serialized = JSON.stringify(event);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > OUTBOX_LIMITS.eventBytes) return false;
  const queue = getQueue();
  if (!queue) return false;
  return transaction(queue, () => {
    queue.db.prepare("DELETE FROM events WHERE occurred < ? OR occurred > ? OR length(CAST(payload AS BLOB)) > ?")
      .run(now - OUTBOX_LIMITS.ageMs, now + 60_000, OUTBOX_LIMITS.eventBytes);
    queue.db.prepare("INSERT OR IGNORE INTO events(uuid,occurred,payload) VALUES(?,?,?)").run(event.uuid, Date.parse(event.timestamp), serialized);
    // Bound both retained events and serialized payload bytes, in one transaction.
    queue.db.prepare("DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY occurred DESC,rowid DESC LIMIT ?)").run(OUTBOX_LIMITS.events);
    const rows = queue.db.prepare("SELECT uuid,length(CAST(payload AS BLOB)) AS bytes FROM events ORDER BY occurred DESC, rowid DESC LIMIT ?").all(OUTBOX_LIMITS.events) as Array<{ uuid: string; bytes: number }>;
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      total += rows[i].bytes;
      if (i >= OUTBOX_LIMITS.events || total > OUTBOX_LIMITS.bytes) queue.db.prepare("DELETE FROM events WHERE uuid=?").run(rows[i].uuid);
    }
    return true;
  }) === true;
}

export function claimBatch(now = Date.now()): DeliveryBatch | undefined {
  const queue = getQueue(false);
  if (!queue) return undefined;
  return transaction(queue, () => {
    queue.db.prepare("DELETE FROM events WHERE occurred < ? OR occurred > ? OR length(CAST(payload AS BLOB)) > ?")
      .run(now - OUTBOX_LIMITS.ageMs, now + 60_000, OUTBOX_LIMITS.eventBytes);
    // A crash releases the SQLite lock. Its delivery claim expires independently.
    queue.db.prepare("UPDATE events SET lease=NULL, lease_until=0 WHERE lease_until > ?").run(now + OUTBOX_LIMITS.leaseMs);
    const rows = queue.db.prepare("SELECT uuid,occurred,payload FROM events WHERE lease_until<=? ORDER BY occurred,rowid LIMIT ?")
      .all(now, OUTBOX_LIMITS.batchEvents) as Array<{ uuid: string; occurred: number; payload: string }>;
    const events: TelemetryEvent[] = [];
    const token = randomUUID();
    for (const row of rows) {
      let value: unknown;
      try { value = JSON.parse(row.payload); } catch { /* invalid local data */ }
      if (!validateStoredEvent(value) || value.uuid !== row.uuid || Date.parse(value.timestamp) !== row.occurred) { queue.db.prepare("DELETE FROM events WHERE uuid=?").run(row.uuid); continue; }
      events.push(value);
      queue.db.prepare("UPDATE events SET lease=?,lease_until=? WHERE uuid=?").run(token, now + OUTBOX_LIMITS.leaseMs, row.uuid);
    }
    return events.length ? { token, events, queue } : undefined;
  });
}

export function finishBatch(batch: DeliveryBatch, delivered: boolean): void {
  transaction(batch.queue, () => {
    if (delivered) batch.queue.db.prepare("DELETE FROM events WHERE lease=?").run(batch.token);
    else batch.queue.db.prepare("UPDATE events SET lease=NULL,lease_until=0 WHERE lease=?").run(batch.token);
  });
}

/** Explicit opt-out only. Never initializes a missing store. */
export function purgeOutbox(): boolean {
  const queue = getQueue(false);
  const cleared = queue ? transaction(queue, () => { queue.db.exec("DELETE FROM events"); return true; }) === true : inspectOutbox().state === "absent";
  closeOutbox();
  return cleared;
}

export interface OutboxInspection { state: "absent" | "available" | "unavailable"; events: number | null; bytes: number | null; }
export function inspectOutbox(): OutboxInspection {
  const path = safeStorePath(false);
  if (!path) {
    try { lstatSync(join(mexHomeDir(), "telemetry", "outbox.db")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", events: 0, bytes: 0 }; }
    return { state: "unavailable", events: null, bytes: null };
  }
  let db: SqliteDatabase | undefined;
  try {
    // immutable=1 prevents journal recovery or sidecar creation on an audit read.
    db = openSqlite(path, { readOnly: true, immutable: true });
    db.exec("PRAGMA trusted_schema=OFF;");
    if (!validSchema(db)) throw new Error("Unknown telemetry schema");
    const row = db.prepare("SELECT count(*) AS events,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM events").get() as { events: number; bytes: number };
    if (row.events > OUTBOX_LIMITS.events || row.bytes > OUTBOX_LIMITS.bytes) throw new Error("Invalid telemetry queue bounds");
    return { state: "available", events: row.events, bytes: row.bytes };
  } catch { return { state: "unavailable", events: null, bytes: null }; }
  finally { try { db?.close(); } catch { /* best effort */ } }
}

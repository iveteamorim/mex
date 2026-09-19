/**
 * §11.4 — the append-only record, and the only legal replay oracle.
 *
 * ## Why the log, and not the index
 *
 * `wiki.db` is disposable by invariant: delete it and a rebuild reproduces
 * every row from Markdown. An index-resident record of applied `opId`s would
 * therefore evaporate on a rebuild, and idempotency would evaporate with it —
 * a replayed `create-entry` would mint a second entity, silently, because there
 * is no precondition that can catch a create. `.mex/events/operations.jsonl` is
 * committed and is where replay looks.
 *
 * ## Two lines, and why that is not a violation of "append one line"
 *
 * §11.3 appends the audit entry at step 10, *after* the write at step 8. A
 * process killed in between leaves a completed operation that looks
 * un-replayed. For `create-entry` a replay then mints a **second entity with a
 * new id** — silent knowledge duplication, produced by implementing the spec
 * exactly as written.
 *
 * So an operation writes an **intent** line before the first rename and a
 * **completion** line after the last one. The completion line is §11.4's "one
 * line per accepted operation" and is what {@link readAuditLog} reports as the
 * audit; the intent line is a journal record of work in flight, and an intent
 * with no completion is the signal to check the filesystem and finish or redo.
 * Crucially the intent line **carries the ids the operation is about to mint**,
 * so a resumed `create-entry` re-uses the id rather than inventing another.
 *
 * ## What may not be in it
 *
 * **HARD: never full prompts, transcripts, source-code payloads or entity
 * bodies.** Git is the content diff and history; this is a privacy boundary,
 * not a size optimization. The entry is built field by field from a fixed list
 * in {@link auditRecord} rather than by spreading anything, so a body cannot
 * arrive by accident, and a test asserts a body-carrying operation leaves no
 * trace of its body in the log.
 *
 * Manual Markdown edits stay valid with no entry here, and MEX does not
 * fabricate an actor for them.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { DirectorySyncError, syncDirectory } from "./durability.js";
import type { WikiActor } from "../model/operation.js";
import { insideRoot } from "../index/discover.js";
import type { RevisionChange, WikiPatchPlan } from "./plan.js";

/** Fixed by `MALFORMED_OPERATION_LOG`'s remediation text. */
export const OPERATION_LOG_FILE = "events/operations.jsonl";
/** Shared hard cap for the append-only operation recovery ledger. */
export const OPERATION_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Shared hard cap for non-empty operation recovery records. */
export const OPERATION_LOG_MAX_ENTRIES = 4_096;

export function operationLogPath(scaffoldRoot: string): string {
  return resolve(scaffoldRoot, OPERATION_LOG_FILE);
}

export type AuditPhase = "intent" | "complete";

/** One line of the log. Every field is named; nothing is spread in. */
export interface AuditEntry {
  /** Format version, so a later phase can change the shape without guessing. */
  v: 1;
  phase: AuditPhase;
  opId: string;
  type: string;
  entityIds: string[];
  /** Ids the operation mints. Present on the intent line so a resume reuses them. */
  createdIds: string[];
  actor: WikiActor;
  timestamp: string;
  reason?: string;
  files: string[];
  /** Hash of the proposal, never the proposal. */
  payloadHash: string;
  revisions: RevisionChange[];
  sessionId?: string;
}

export class OperationLogPathError extends Error {
  constructor(path: string) {
    super(`Refusing to touch ${JSON.stringify(path)}: the audit writer appends to ${OPERATION_LOG_FILE} and nothing else.`);
    this.name = "OperationLogPathError";
  }
}

/**
 * The runtime write guard, in the shape `dbfile.ts` established.
 *
 * Being on the lint's allowlist is an exemption with nothing behind it; this is
 * what is behind it. A lint rule cannot tell that `appendFileSync(p, line)` is
 * safe. This can, and it fails closed.
 */
export function assertOperationLogPath(scaffoldRoot: string, path: string): void {
  const root = resolve(scaffoldRoot);
  const target = resolve(path);
  if (basename(target) !== basename(OPERATION_LOG_FILE)) throw new OperationLogPathError(target);
  if (!insideRoot(root, target)) throw new OperationLogPathError(target);
  if (target !== operationLogPath(root)) throw new OperationLogPathError(target);
}

interface OperationLogBinding {
  root: string;
  realRoot: string;
  rootDev: bigint;
  rootIno: bigint;
  directory: string;
  realDirectory: string;
  directoryDev: bigint;
  directoryIno: bigint;
}

export interface AppendAuditOptions {
  /** Deterministic adversarial seam; production callers leave it absent. */
  beforeOpen?: () => void;
  /** Deterministic ordinary-failure seam after exact bytes land, before fsync. */
  afterWrite?: () => void;
  /** Exact ledger bytes the caller reviewed immediately before this append. */
  expectedText?: string;
  /** Distinguish a reviewed absent ledger from an existing zero-byte ledger. */
  expectedExists?: boolean;
}

function writeExact(fd: number, bytes: Buffer, path: string): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new OperationLogPathError(path);
    offset += written;
  }
}

function assertFdText(fd: number, expectedText: string, path: string): void {
  assertOperationLogBounds(expectedText, path);
  const expected = Buffer.from(expectedText, "utf8");
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(expected.length)) throw new OperationLogPathError(path);
  const actual = Buffer.alloc(expected.length);
  let offset = 0;
  while (offset < actual.length) {
    const read = readSync(fd, actual, offset, actual.length - offset, offset);
    if (read <= 0) throw new OperationLogPathError(path);
    offset += read;
  }
  if (!actual.equals(expected)) throw new OperationLogPathError(path);
  const after = fstatSync(fd, { bigint: true });
  if (
    after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs
  ) throw new OperationLogPathError(path);
}

function readFdText(fd: number, path: string): string {
  const stats = fstatSync(fd);
  if (!stats.isFile()) throw new OperationLogPathError(path);
  if (stats.size > OPERATION_LOG_MAX_BYTES) throw new OperationLogPathError(path);
  const bytes = Buffer.alloc(stats.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (read <= 0) throw new OperationLogPathError(path);
    offset += read;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    assertOperationLogBounds(text, path);
    return text;
  } catch {
    throw new OperationLogPathError(path);
  }
}

/** Build the record for one phase of a plan. Field by field, deliberately. */
export function auditRecord(plan: Omit<WikiPatchPlan, "audit">, phase: AuditPhase): AuditEntry {
  const entry: AuditEntry = {
    v: 1,
    phase,
    opId: plan.opId,
    type: plan.type,
    entityIds: [...plan.entityIds],
    createdIds: [...plan.createdIds],
    actor: { kind: plan.actor.kind, id: plan.actor.id },
    timestamp: plan.timestamp,
    files: plan.files.map((file) => file.path).sort(),
    payloadHash: plan.payloadHash,
    revisions: plan.revisions.map((change) => ({ ...change })),
  };
  if (plan.reason !== undefined) entry.reason = plan.reason;
  if (plan.actor.sessionId !== undefined) entry.sessionId = plan.actor.sessionId;
  return entry;
}

/** Append one line. Creates `events/` if it is not there yet. */
export function appendAudit(
  scaffoldRoot: string,
  entry: AuditEntry,
  options: AppendAuditOptions = {},
): void {
  const path = operationLogPath(scaffoldRoot);
  assertOperationLogPath(scaffoldRoot, path);
  const binding = bindOperationLog(scaffoldRoot, path);
  options.beforeOpen?.();
  assertOperationLogBinding(binding, path);

  let fd: number | undefined;
  try {
    const flags = constants.O_APPEND
      | constants.O_RDWR
      | (options.expectedExists === true ? 0 : constants.O_CREAT)
      | (options.expectedExists === false ? constants.O_EXCL : 0)
      | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(path, flags, 0o600);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new OperationLogPathError(path);
    assertOperationLogBinding(binding, path);
    const current = lstatSync(path, { bigint: true });
    if (
      current.isSymbolicLink()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) throw new OperationLogPathError(path);
    const expectedBefore = options.expectedText ?? readFdText(fd, path);
    assertFdText(fd, expectedBefore, path);
    const line = `${JSON.stringify(entry)}\n`;
    assertOperationLogBounds(`${expectedBefore}${line}`, path);
    const bytes = Buffer.from(line, "utf8");
    writeExact(fd, bytes, path);
    options.afterWrite?.();
    assertFdText(fd, `${expectedBefore}${line}`, path);
    fsyncSync(fd);
    assertFdText(fd, `${expectedBefore}${line}`, path);
    syncDirectory(binding.directory);
  } catch (error) {
    // A failed directory flush is a durability failure, not a bad path.
    // Relabelling it sends a reader to their scaffold layout for a problem
    // that is in the filesystem; let it out carrying its own errno.
    if (error instanceof DirectorySyncError) throw error;
    if (error instanceof OperationLogPathError) throw error;
    throw new OperationLogPathError(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function bindOperationLog(
  scaffoldRoot: string,
  path: string,
  createDirectory = true,
): OperationLogBinding {
  const root = resolve(scaffoldRoot);
  const rootLexical = lstatSync(root, { bigint: true });
  if (!rootLexical.isDirectory() || rootLexical.isSymbolicLink()) throw new OperationLogPathError(path);
  const realRoot = realpathSync(root);
  const rootStats = lstatSync(realRoot, { bigint: true });
  const directory = dirname(path);
  assertRootIdentity(root, realRoot, rootStats.dev, rootStats.ino, path);
  if (!existsSync(directory)) {
    if (!createDirectory) throw new OperationLogPathError(path);
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    // Persist the new `events` directory entry before an operation can rely on
    // its ledger for crash recovery.
    syncDirectory(root);
  }
  const directoryLexical = lstatSync(directory, { bigint: true });
  if (!directoryLexical.isDirectory() || directoryLexical.isSymbolicLink()) throw new OperationLogPathError(path);
  const realDirectory = realpathSync(directory);
  if (!insideRoot(realRoot, realDirectory)) throw new OperationLogPathError(path);
  const directoryStats = lstatSync(realDirectory, { bigint: true });
  assertNoFollowOperationLogLeaf(path);
  return {
    root,
    realRoot,
    rootDev: rootStats.dev,
    rootIno: rootStats.ino,
    directory,
    realDirectory,
    directoryDev: directoryStats.dev,
    directoryIno: directoryStats.ino,
  };
}

function assertOperationLogBinding(binding: OperationLogBinding, path: string): void {
  assertOperationLogPath(binding.root, path);
  assertRootIdentity(binding.root, binding.realRoot, binding.rootDev, binding.rootIno, path);
  let realDirectory: string;
  let directoryStats;
  try {
    const lexical = lstatSync(binding.directory, { bigint: true });
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new OperationLogPathError(path);
    realDirectory = realpathSync(binding.directory);
    directoryStats = lstatSync(realDirectory, { bigint: true });
  } catch {
    throw new OperationLogPathError(path);
  }
  if (
    realDirectory !== binding.realDirectory
    || directoryStats.dev !== binding.directoryDev
    || directoryStats.ino !== binding.directoryIno
  ) throw new OperationLogPathError(path);
  assertNoFollowOperationLogLeaf(path);
}

function assertRootIdentity(
  root: string,
  realRoot: string,
  dev: bigint,
  ino: bigint,
  path: string,
): void {
  try {
    const lexical = lstatSync(root, { bigint: true });
    const currentReal = realpathSync(root);
    const current = lstatSync(currentReal, { bigint: true });
    if (
      !lexical.isDirectory()
      || lexical.isSymbolicLink()
      || currentReal !== realRoot
      || current.dev !== dev
      || current.ino !== ino
    ) throw new OperationLogPathError(path);
  } catch (error) {
    if (error instanceof OperationLogPathError) throw error;
    throw new OperationLogPathError(path);
  }
}

function assertNoFollowOperationLogLeaf(path: string): void {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) throw new OperationLogPathError(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export interface AuditLog {
  entries: AuditEntry[];
  diagnostics: WikiDiagnostic[];
}

export interface ExactOperationLog {
  exists: boolean;
  text: string;
}

/**
 * Restore an exact ledger snapshot after an ordinary, catchable writer error.
 *
 * This is intentionally not used by the crash seam: an intent without a
 * completion is the durable resume oracle.  Rollback callers must name the
 * exact bytes they believe are current so an unrelated/manual ledger edit is
 * never overwritten.
 */
export function restoreOperationLogExact(
  scaffoldRoot: string,
  expectedCurrentText: string,
  original: ExactOperationLog,
  options: { beforeRename?: (tempPath: string) => void } = {},
): void {
  const path = operationLogPath(scaffoldRoot);
  const current = readOperationLogExact(scaffoldRoot);
  if (current.text !== expectedCurrentText) throw new OperationLogPathError(path);
  const binding = bindOperationLog(scaffoldRoot, path, true);
  assertOperationLogBinding(binding, path);

  if (!original.exists) {
    if (!current.exists) return;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd, { bigint: true });
      const lexical = lstatSync(path, { bigint: true });
      if (
        !opened.isFile()
        || lexical.isSymbolicLink()
        || opened.dev !== lexical.dev
        || opened.ino !== lexical.ino
      ) throw new OperationLogPathError(path);
      assertOperationLogBinding(binding, path);
      assertFdText(fd, expectedCurrentText, path);
      rmSync(path);
      syncDirectory(binding.directory);
    } catch (error) {
      // A failed directory flush is a durability failure, not a bad path.
      // Relabelling it sends a reader to their scaffold layout for a problem
      // that is in the filesystem; let it out carrying its own errno.
      if (error instanceof DirectorySyncError) throw error;
      if (error instanceof OperationLogPathError) throw error;
      throw new OperationLogPathError(path);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return;
  }

  const temp = `${path}.rollback-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  let created = false;
  let tempBinding: LedgerTempBinding | undefined;
  const originalBytes = Buffer.from(original.text, "utf8");
  try {
    assertOperationLogBinding(binding, path);
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    const opened = fstatSync(fd, { bigint: true });
    const lexical = lstatSync(temp, { bigint: true });
    if (
      !opened.isFile()
      || lexical.isSymbolicLink()
      || opened.dev !== lexical.dev
      || opened.ino !== lexical.ino
    ) throw new OperationLogPathError(path);
    writeExact(fd, originalBytes, path);
    fsyncSync(fd);
    tempBinding = bindLedgerTemp(temp, fd, original.text);
    closeSync(fd);
    fd = undefined;
    assertOperationLogBinding(binding, path);
    if (readOperationLogExact(scaffoldRoot).text !== expectedCurrentText) throw new OperationLogPathError(path);
    options.beforeRename?.(temp);
    assertOperationLogBinding(binding, path);
    fd = openSync(temp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (tempBinding === undefined) throw new OperationLogPathError(path);
    assertLedgerTemp(temp, fd, tempBinding, original.text);
    if (readOperationLogExact(scaffoldRoot).text !== expectedCurrentText) throw new OperationLogPathError(path);
    assertOperationLogBinding(binding, path);
    renameSync(temp, path);
    assertLedgerTemp(path, fd, tempBinding, original.text, true);
    closeSync(fd);
    fd = undefined;
    created = false;
    syncDirectory(binding.directory);
  } catch (error) {
    // A failed directory flush is a durability failure, not a bad path.
    // Relabelling it sends a reader to their scaffold layout for a problem
    // that is in the filesystem; let it out carrying its own errno.
    if (error instanceof DirectorySyncError) throw error;
    if (error instanceof OperationLogPathError) throw error;
    throw new OperationLogPathError(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        assertOperationLogBinding(binding, path);
        const cleanupFd = openSync(temp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          if (tempBinding !== undefined) {
            assertLedgerTemp(temp, cleanupFd, tempBinding, original.text);
            assertOperationLogBinding(binding, path);
            rmSync(temp, { force: true });
          }
        } finally {
          closeSync(cleanupFd);
        }
      } catch {
        // A path swapped after failure is not ours to remove.
      }
    }
  }
}

interface LedgerTempBinding {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function bindLedgerTemp(path: string, fd: number, text: string): LedgerTempBinding {
  assertFdText(fd, text, path);
  const stats = fstatSync(fd, { bigint: true });
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function assertLedgerTemp(
  path: string,
  fd: number,
  expected: LedgerTempBinding,
  text: string,
  allowRenameCtime = false,
): void {
  const stats = fstatSync(fd, { bigint: true });
  const lexical = lstatSync(path, { bigint: true });
  if (
    !stats.isFile()
    || lexical.isSymbolicLink()
    || stats.dev !== expected.dev
    || stats.ino !== expected.ino
    || stats.size !== expected.size
    || stats.mtimeNs !== expected.mtimeNs
    || (!allowRenameCtime && stats.ctimeNs !== expected.ctimeNs)
    || lexical.dev !== stats.dev
    || lexical.ino !== stats.ino
  ) throw new OperationLogPathError(path);
  assertFdText(fd, text, path);
}

/** Descriptor-bound, no-follow exact ledger read shared by every planner. */
export function readOperationLogExact(scaffoldRoot: string): ExactOperationLog {
  const path = operationLogPath(scaffoldRoot);
  const directory = dirname(path);
  if (!existsSync(path)) {
    // An existing `events` path still has to be a bound real directory; a
    // symlink with no ledger must not be captured into a preview as "absent".
    if (existsSync(directory)) bindOperationLog(scaffoldRoot, path, false);
    else {
      const root = resolve(scaffoldRoot);
      const lexical = lstatSync(root, { bigint: true });
      if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new OperationLogPathError(path);
      const realRoot = realpathSync(root);
      const stats = lstatSync(realRoot, { bigint: true });
      assertRootIdentity(root, realRoot, stats.dev, stats.ino, path);
    }
    return { exists: false, text: "" };
  }

  const binding = bindOperationLog(scaffoldRoot, path, false);
  assertOperationLogBinding(binding, path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (opened.size > BigInt(OPERATION_LOG_MAX_BYTES)) throw new OperationLogPathError(path);
    assertOperationLogBinding(binding, path);
    // `{ bigint: true }`, and not by taste. A plain `lstatSync` reports `ino`
    // as a double, and an NTFS file id is a 64-bit value well past 2^53 — a
    // measured one here is 73183493944776897, which survives the round trip
    // through a double as 73183493944776896. Widening the rounded number back
    // to a BigInt cannot undo the rounding, so `BigInt(current.ino)` never
    // equalled the exact `opened.ino` from `fstatSync(fd, { bigint: true })`,
    // and every exact ledger read on Windows threw. Both sides are now exact.
    // (The `leafAfter` read below already did this; this line did not.)
    const current = lstatSync(path, { bigint: true });
    if (
      !opened.isFile()
      || current.isSymbolicLink()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) throw new OperationLogPathError(path);
    const text = readFileSync(fd, "utf-8");
    assertOperationLogBounds(text, path);
    const after = fstatSync(fd, { bigint: true });
    assertOperationLogBinding(binding, path);
    const leafAfter = lstatSync(path, { bigint: true });
    if (
      leafAfter.isSymbolicLink()
      || leafAfter.dev !== opened.dev
      || leafAfter.ino !== opened.ino
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
    ) throw new OperationLogPathError(path);
    return { exists: true, text };
  } catch (error) {
    if (error instanceof OperationLogPathError) throw error;
    throw new OperationLogPathError(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertOperationLogBounds(text: string, path: string): void {
  if (Buffer.byteLength(text, "utf8") > OPERATION_LOG_MAX_BYTES) throw new OperationLogPathError(path);
  let entries = 0;
  let lineHasContent = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 0x0a) {
      if (lineHasContent) entries += 1;
      lineHasContent = false;
    } else if (character !== 0x0d && character !== 0x20 && character !== 0x09) {
      lineHasContent = true;
    }
    if (entries > OPERATION_LOG_MAX_ENTRIES) throw new OperationLogPathError(path);
  }
  if (lineHasContent) entries += 1;
  if (entries > OPERATION_LOG_MAX_ENTRIES) throw new OperationLogPathError(path);
}

/** True when `value` has the shape this reader will act on. */
function isAuditEntry(value: unknown): value is AuditEntry {
  if (value === null || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    raw["v"] === 1 &&
    (raw["phase"] === "intent" || raw["phase"] === "complete") &&
    typeof raw["opId"] === "string" &&
    typeof raw["type"] === "string" &&
    typeof raw["payloadHash"] === "string" &&
    Array.isArray(raw["entityIds"]) &&
    Array.isArray(raw["createdIds"])
  );
}

/**
 * Read the log, degrading a bad line to a diagnostic.
 *
 * A single unparseable line must never take out the run, and must never touch
 * the Markdown — that is what `MALFORMED_OPERATION_LOG`'s remediation promises.
 * The consequence is stated rather than hidden: a line that cannot be read is a
 * line replay cannot consult, so the diagnostic is what tells a caller their
 * idempotency guarantee has a hole in it at that point.
 */
export function readAuditLog(scaffoldRoot: string): AuditLog {
  let text: string;
  try {
    const exact = readOperationLogExact(scaffoldRoot);
    if (!exact.exists) return { entries: [], diagnostics: [] };
    text = exact.text;
  } catch (error) {
    return {
      entries: [],
      diagnostics: [
        diagnostic("MALFORMED_OPERATION_LOG", `Could not read ${OPERATION_LOG_FILE}: ${String(error)}`, {
          file: OPERATION_LOG_FILE,
        }),
      ],
    };
  }

  const entries: AuditEntry[] = [];
  const diagnostics: WikiDiagnostic[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(
        diagnostic("MALFORMED_OPERATION_LOG", `${OPERATION_LOG_FILE} line ${index + 1} is not valid JSON.`, {
          file: OPERATION_LOG_FILE,
          location: { file: OPERATION_LOG_FILE, startLine: index + 1, endLine: index + 1 },
        }),
      );
      continue;
    }
    if (!isAuditEntry(parsed)) {
      diagnostics.push(
        diagnostic("MALFORMED_OPERATION_LOG", `${OPERATION_LOG_FILE} line ${index + 1} is not an operation record.`, {
          file: OPERATION_LOG_FILE,
          location: { file: OPERATION_LOG_FILE, startLine: index + 1, endLine: index + 1 },
        }),
      );
      continue;
    }
    entries.push(parsed);
  }
  return { entries, diagnostics };
}

/** What the log says about one `opId`. */
export interface OperationRecord {
  intent: AuditEntry | null;
  complete: AuditEntry | null;
}

export function recordFor(log: AuditLog, opId: string): OperationRecord {
  const mine = log.entries.filter((entry) => entry.opId === opId);
  return {
    intent: mine.filter((entry) => entry.phase === "intent").at(-1) ?? null,
    complete: mine.filter((entry) => entry.phase === "complete").at(-1) ?? null,
  };
}

/** The accepted operations, which is what §11.4's "one line each" means. */
export function acceptedOperations(log: AuditLog): AuditEntry[] {
  return log.entries.filter((entry) => entry.phase === "complete");
}

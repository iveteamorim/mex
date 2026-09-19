/**
 * The only module under `src/wiki/` that mutates the filesystem.
 *
 * Rule (c) in `test/wiki-architecture.test.ts` bans direct writes from the wiki
 * engine so that every change to a `.mex` file goes through the one
 * plan/preview/apply pipeline. Publishing an index still has to rename a
 * database and delete a temp file, which is not a Markdown write — but "not a
 * Markdown write" is exactly what every second writer has claimed, so the
 * exemption is made as narrow as it can be:
 *
 * - it is **one file**, and the lint's allowlist names it;
 * - every mutation goes through {@link assertIndexPath}, which rejects any path
 *   that is not a SQLite index or one of its WAL siblings, so a `.md` path
 *   cannot reach a delete even through a caller's bug;
 * - the guard has its own negative tests.
 *
 * A lint rule cannot see that `unlinkSync(path)` is safe; this guard can, and it
 * fails closed.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

/**
 * Names this module will touch: a SQLite database, one of its WAL/SHM/journal
 * siblings, or a temp database awaiting publish.
 *
 * Deliberately restrictive. Widening it is the same decision as adding a second
 * writer, and should be argued for in a review rather than typed in passing.
 */
const INDEX_FILE_PATTERN = /^[A-Za-z0-9._-]+\.db(?:(?:\.tmp-[0-9a-z]+|\.recovery-[0-9a-z]+)?(?:-wal|-shm|-journal)?|\.lock(?:\.gate)?)$/;
const MAX_LOCK_BYTES = 4 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

export class IndexPathError extends Error {
  constructor(path: string) {
    super(
      `Refusing to touch ${JSON.stringify(path)}: the wiki index may only delete or rename a database file. ` +
        `Everything else in a scaffold is written by the operation pipeline.`,
    );
    this.name = "IndexPathError";
  }
}

export interface IndexDirectoryBinding {
  readonly directory: string;
  readonly realDirectory: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly allowedRoot: string;
}

export type IndexGenerationBinding =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly dev: bigint;
      readonly ino: bigint;
      readonly size: bigint;
      readonly mtimeNs: bigint;
      readonly ctimeNs: bigint;
      readonly digest: string;
    };

function generationMismatch(path: string, reason: string): never {
  throw new IndexInUseError(path, new Error(reason));
}

function sameGenerationContent(
  left: IndexGenerationBinding,
  right: IndexGenerationBinding,
): boolean {
  return left.exists && right.exists
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.digest === right.digest;
}

/** Capture one no-follow regular-file generation, including its exact bytes. */
export function bindIndexGeneration(
  path: string,
  binding: IndexDirectoryBinding,
): IndexGenerationBinding {
  assertIndexPath(path, binding);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    assertIndexPath(path, binding);
    try {
      lstatSync(path, { bigint: true });
      return generationMismatch(path, "index generation appeared while absence was being bound");
    } catch (nested) {
      const nestedCode = nested && typeof nested === "object" && "code" in nested ? nested.code : undefined;
      if (nestedCode !== "ENOENT") throw nested;
    }
    return { exists: false };
  }

  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) return generationMismatch(path, "index generation is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fstatSync(fd, { bigint: true });
    assertIndexPath(path, binding);
    const leaf = lstatSync(path, { bigint: true });
    if (
      !leaf.isFile()
      || leaf.isSymbolicLink()
      || leaf.dev !== before.dev
      || leaf.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) return generationMismatch(path, "index generation changed while its bytes were being bound");
    return {
      exists: true,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      digest: hash.digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

export function assertIndexGeneration(
  path: string,
  expected: IndexGenerationBinding,
  binding: IndexDirectoryBinding,
): void {
  const actual = bindIndexGeneration(path, binding);
  if (actual.exists !== expected.exists) return generationMismatch(path, "index generation existence changed");
  if (!actual.exists || !expected.exists) return;
  if (
    actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.size !== expected.size
    || actual.mtimeNs !== expected.mtimeNs
    || actual.ctimeNs !== expected.ctimeNs
    || actual.digest !== expected.digest
  ) return generationMismatch(path, "index generation identity or exact bytes changed");
}

/** Remove only the exact generation a caller owns; never a pathname replacement. */
export function removeBoundIndexGeneration(
  path: string,
  expected: IndexGenerationBinding,
  binding: IndexDirectoryBinding,
): void {
  if (!expected.exists) return;
  assertQuietIndexNamespace(path, "owned candidate acquired an unexpected SQLite sidecar");
  assertIndexGeneration(path, expected, binding);
  rmSync(path);
}

/**
 * Bind all later mutations to one already-resolved scaffold directory.
 * `allowedRoot` is supplied by repository-bound callers and prevents a valid
 * basename in an arbitrary directory from becoming authority to mutate it.
 */
export function bindIndexDirectory(indexPath: string, allowedRoot?: string): IndexDirectoryBinding {
  assertIndexPath(indexPath);
  const directory = resolve(dirname(indexPath));
  let lexicalDirectory;
  try {
    lexicalDirectory = lstatSync(directory, { bigint: true });
  } catch {
    throw new IndexPathError(indexPath);
  }
  if (!lexicalDirectory.isDirectory() || lexicalDirectory.isSymbolicLink()) {
    throw new IndexPathError(indexPath);
  }
  const realDirectory = realpathSync(directory);
  const stats = lstatSync(realDirectory, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.dev !== lexicalDirectory.dev
    || stats.ino !== lexicalDirectory.ino
  ) throw new IndexPathError(indexPath);
  const lexicalAllowedRoot = resolve(allowedRoot ?? directory);
  let allowedStats;
  try {
    allowedStats = lstatSync(lexicalAllowedRoot, { bigint: true });
  } catch {
    throw new IndexPathError(indexPath);
  }
  if (
    lexicalAllowedRoot !== directory
    || !allowedStats.isDirectory()
    || allowedStats.isSymbolicLink()
    || allowedStats.dev !== lexicalDirectory.dev
    || allowedStats.ino !== lexicalDirectory.ino
    || realpathSync(lexicalAllowedRoot) !== realDirectory
  ) {
    throw new IndexPathError(indexPath);
  }
  assertNoFollowLeaf(indexPath);
  return {
    directory,
    realDirectory,
    dev: lexicalDirectory.dev,
    ino: lexicalDirectory.ino,
    allowedRoot: lexicalAllowedRoot,
  };
}

/** Throw unless `path` names a bound database file or one of its siblings. */
export function assertIndexPath(path: string, binding?: IndexDirectoryBinding): void {
  if (!INDEX_FILE_PATTERN.test(basename(path))) throw new IndexPathError(path);
  if (binding === undefined) return;
  if (resolve(dirname(path)) !== binding.directory) throw new IndexPathError(path);
  let lexicalDirectory;
  let lexicalAllowedRoot;
  try {
    lexicalDirectory = lstatSync(binding.directory, { bigint: true });
    lexicalAllowedRoot = lstatSync(binding.allowedRoot, { bigint: true });
  } catch {
    throw new IndexPathError(path);
  }
  if (
    binding.allowedRoot !== binding.directory
    || !lexicalDirectory.isDirectory()
    || lexicalDirectory.isSymbolicLink()
    || lexicalDirectory.dev !== binding.dev
    || lexicalDirectory.ino !== binding.ino
    || !lexicalAllowedRoot.isDirectory()
    || lexicalAllowedRoot.isSymbolicLink()
    || lexicalAllowedRoot.dev !== binding.dev
    || lexicalAllowedRoot.ino !== binding.ino
  ) throw new IndexPathError(path);
  let realDirectory: string;
  let stats;
  let lexicalAfter;
  try {
    realDirectory = realpathSync(binding.directory);
    stats = lstatSync(realDirectory, { bigint: true });
    lexicalAfter = lstatSync(binding.directory, { bigint: true });
  } catch {
    throw new IndexPathError(path);
  }
  if (
    realDirectory !== binding.realDirectory
    || stats.dev !== binding.dev
    || stats.ino !== binding.ino
    || !stats.isDirectory()
    || stats.isSymbolicLink()
    || !lexicalAfter.isDirectory()
    || lexicalAfter.isSymbolicLink()
    || lexicalAfter.dev !== binding.dev
    || lexicalAfter.ino !== binding.ino
  ) throw new IndexPathError(path);
  assertNoFollowLeaf(path);
}

function assertNoFollowLeaf(path: string): void {
  try {
    if (lstatSync(path, { bigint: true }).isSymbolicLink()) throw new IndexPathError(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

/**
 * The sidecar files SQLite creates beside a database.
 *
 * A published database whose `-wal` belongs to the *previous* database is a
 * corruption vector, which is why these are enumerated rather than assumed
 * absent.
 */
export function indexSiblingPaths(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

/** Delete a database and its siblings if they exist. Missing files are fine. */
export function removeIndexFiles(
  dbPath: string,
  binding: IndexDirectoryBinding,
): void {
  for (const path of [dbPath, ...indexSiblingPaths(dbPath)]) {
    assertIndexPath(path, binding);
    rmSync(path, { force: true });
  }
}

/**
 * Copy one quiet published generation into a same-directory candidate.
 *
 * Both endpoints are opened no-follow and the source pathname is rebound to
 * the opened inode after the copy. This is the refresh analogue of rebuild's
 * fresh candidate: the live index is never opened writable.
 */
export function cloneIndexFile(
  sourcePath: string,
  candidatePath: string,
  binding: IndexDirectoryBinding,
  copyWrite: (fd: number, buffer: Buffer, offset: number, length: number) => number =
    (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
): void {
  assertIndexPath(sourcePath, binding);
  assertIndexPath(candidatePath, binding);
  assertQuietIndexNamespace(sourcePath, "published SQLite sidecar prevents a stable clone");
  assertQuietIndexNamespace(candidatePath, "candidate SQLite sidecar already exists");

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let sourceFd: number | undefined;
  let candidateFd: number | undefined;
  try {
    sourceFd = openSync(sourcePath, constants.O_RDONLY | noFollow);
    const before = fstatSync(sourceFd, { bigint: true });
    if (!before.isFile()) throw new IndexPathError(sourcePath);
    candidateFd = openSync(
      candidatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    while (true) {
      const read = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let written = 0;
      while (written < read) {
        const progress = copyWrite(candidateFd, buffer, written, read - written);
        if (progress <= 0 || progress > read - written) {
          throw new Error("Wiki index candidate copy made invalid write progress.");
        }
        written += progress;
      }
    }
    fsyncSync(candidateFd);

    const after = fstatSync(sourceFd, { bigint: true });
    assertIndexPath(sourcePath, binding);
    const current = lstatSync(sourcePath, { bigint: true });
    if (
      current.isSymbolicLink()
      || current.dev !== before.dev
      || current.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) throw new IndexInUseError(sourcePath, new Error("published index changed during candidate clone"));
    assertQuietIndexNamespace(sourcePath, "published SQLite sidecar appeared during candidate clone");
  } catch (error) {
    if (candidateFd !== undefined) {
      closeSync(candidateFd);
      candidateFd = undefined;
    }
    if (sourceFd !== undefined) {
      closeSync(sourceFd);
      sourceFd = undefined;
    }
    if (existsSync(candidatePath)) {
      assertIndexPath(candidatePath, binding);
      rmSync(candidatePath, { force: true });
    }
    throw error;
  } finally {
    if (candidateFd !== undefined) closeSync(candidateFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
  }
}

/**
 * Move a fully-built database over the live one.
 *
 * The stale siblings of the *target* go first: `rename(2)` replaces `wiki.db`
 * but leaves `wiki.db-wal` behind, and SQLite would then try to recover a WAL
 * belonging to a database that no longer exists. The source's own siblings are
 * cleared before this is called, by checkpointing and closing it.
 *
 * Same-directory renames only — a cross-device rename is a copy, and a copy is
 * not atomic. Callers build the temp database beside the target, and this
 * asserts they did.
 */
export function publishIndexFile(
  tempPath: string,
  targetPath: string,
  binding: IndexDirectoryBinding,
  validate?: () => void,
  restore: (recoveryPath: string, targetPath: string) => void = renameSync,
  expectations?: {
    candidate: IndexGenerationBinding;
    live: IndexGenerationBinding;
    beforeRecoveryLink?: () => void;
    beforeCandidateRename?: () => void;
    afterCandidateRename?: () => void;
  },
): void {
  assertIndexPath(tempPath, binding);
  assertIndexPath(targetPath, binding);

  const candidateGeneration = expectations?.candidate ?? bindIndexGeneration(tempPath, binding);
  const liveGeneration = expectations?.live ?? bindIndexGeneration(targetPath, binding);
  if (!candidateGeneration.exists) generationMismatch(tempPath, "candidate generation is absent");
  assertIndexGeneration(tempPath, candidateGeneration, binding);
  assertIndexGeneration(targetPath, liveGeneration, binding);

  // Never delete a live namespace's WAL. A surviving sidecar means a reader or
  // writer still owns the old generation; publication refuses with every byte
  // untouched and can be retried after it closes.
  assertQuietIndexNamespace(targetPath, "active SQLite sidecar");
  assertQuietIndexNamespace(tempPath, "candidate SQLite sidecar was not checkpointed");

  const recoveryPath = `${targetPath}.recovery-${randomBytes(6).toString("hex")}`;
  assertIndexPath(recoveryPath, binding);
  const hadTarget = liveGeneration.exists;
  let recoveryGeneration: IndexGenerationBinding | null = null;
  let publishedGeneration: IndexGenerationBinding | null = null;
  let retainRecovery = false;
  let replaced = false;
  try {
    if (hadTarget) {
      // Same-directory hard link: an exact recovery inode without a window in
      // which the canonical target is absent.
      assertIndexPath(targetPath, binding);
      assertIndexPath(recoveryPath, binding);
      expectations?.beforeRecoveryLink?.();
      assertIndexGeneration(targetPath, liveGeneration, binding);
      linkSync(targetPath, recoveryPath);
      recoveryGeneration = bindIndexGeneration(recoveryPath, binding);
      if (!sameGenerationContent(recoveryGeneration, liveGeneration)) {
        generationMismatch(recoveryPath, "recovery link does not bind the reviewed live generation");
      }
      assertIndexGeneration(targetPath, recoveryGeneration, binding);
    }
    // Re-check after preserving the old generation. A reader that opened in
    // the interval must stop publication before the canonical rename.
    assertQuietIndexNamespace(targetPath, "active SQLite sidecar");
    assertQuietIndexNamespace(tempPath, "candidate SQLite sidecar was not checkpointed");
    expectations?.beforeCandidateRename?.();
    assertIndexGeneration(tempPath, candidateGeneration, binding);
    assertIndexGeneration(targetPath, recoveryGeneration ?? liveGeneration, binding);
    renameSync(tempPath, targetPath);
    replaced = true;
    if (recoveryGeneration !== null) {
      const recoveryAfterUnlink = bindIndexGeneration(recoveryPath, binding);
      if (!sameGenerationContent(recoveryAfterUnlink, recoveryGeneration)) {
        generationMismatch(recoveryPath, "preserved index changed during canonical replacement");
      }
      // Replacing the canonical hard link legitimately changes the prior
      // inode's link count/ctime. Bind that one expected transition, then
      // require the refreshed identity for every rollback/cleanup boundary.
      recoveryGeneration = recoveryAfterUnlink;
    }
    publishedGeneration = bindIndexGeneration(targetPath, binding);
    if (!sameGenerationContent(publishedGeneration, candidateGeneration)) {
      generationMismatch(targetPath, "published index is not the exact prepared candidate");
    }
    expectations?.afterCandidateRename?.();
    assertIndexGeneration(targetPath, publishedGeneration, binding);
    validate?.();
    assertIndexGeneration(targetPath, publishedGeneration, binding);
    const validationSidecar = indexSiblingPaths(targetPath).find((path) => existsSync(path));
    if (validationSidecar !== undefined) {
      throw new Error("Published-index validation created an unsafe SQLite sidecar.");
    }
  } catch (error) {
    if (replaced && hadTarget && existsSync(recoveryPath)) {
      const publishedSidecar = indexSiblingPaths(targetPath).find((path) => existsSync(path));
      if (publishedSidecar !== undefined && !removeCandidateGenerationSidecars(targetPath, binding)) {
        retainRecovery = true;
        throw new IndexPublishRecoveryError(targetPath, recoveryPath, error, new Error("published namespace has an active sidecar"));
      }
      try {
        if (recoveryGeneration === null) generationMismatch(recoveryPath, "recovery generation was not bound");
        if (publishedGeneration === null) generationMismatch(targetPath, "published generation was not bound");
        assertIndexGeneration(recoveryPath, recoveryGeneration, binding);
        assertIndexGeneration(targetPath, publishedGeneration, binding);
        restore(recoveryPath, targetPath);
        const restoredGeneration = bindIndexGeneration(targetPath, binding);
        if (!sameGenerationContent(restoredGeneration, recoveryGeneration)) {
          generationMismatch(targetPath, "restored index is not the exact prior generation");
        }
      } catch (restoreError) {
        // Never delete the last exact copy of the prior generation. A caller
        // can surface this path as a manual recovery artifact; silently
        // cleaning it would turn a failed publish into data loss.
        retainRecovery = true;
        throw new IndexPublishRecoveryError(targetPath, recoveryPath, error, restoreError);
      }
    } else if (replaced && !hadTarget && existsSync(targetPath)) {
      // A failed first publication must not leave a corrupt database wearing
      // the canonical name or validation-created sidecars. The namespace was
      // proven quiet before rename, so every sibling now belongs to this failed
      // candidate generation.
      if (!removeCandidateGenerationSidecars(targetPath, binding)) {
        retainRecovery = true;
        throw new IndexPublishRecoveryError(
          targetPath,
          targetPath,
          error,
          new Error("failed first-publication sidecars could not be removed safely"),
        );
      }
      if (publishedGeneration === null) generationMismatch(targetPath, "published generation was not bound");
      assertIndexGeneration(targetPath, publishedGeneration, binding);
      rmSync(targetPath, { force: true });
    }
    throw new IndexInUseError(targetPath, error);
  } finally {
    if (!retainRecovery && existsSync(recoveryPath)) {
      if (recoveryGeneration === null) generationMismatch(recoveryPath, "recovery generation was not bound");
      assertIndexGeneration(recoveryPath, recoveryGeneration, binding);
      rmSync(recoveryPath, { force: true });
    }
  }
}

function assertQuietIndexNamespace(dbPath: string, reason: string): void {
  const sidecar = indexSiblingPaths(dbPath).find((path) => existsSync(path));
  if (sidecar !== undefined) throw new IndexInUseError(sidecar, new Error(reason));
}

/**
 * Remove sidecars that appeared only after the candidate became canonical.
 * The namespace was proven quiet immediately before rename, so these cannot
 * belong to the preserved generation. Failure retains recovery rather than
 * risking an old database beside a new WAL.
 */
function removeCandidateGenerationSidecars(
  targetPath: string,
  binding: IndexDirectoryBinding,
): boolean {
  try {
    for (const sidecar of indexSiblingPaths(targetPath)) {
      if (!existsSync(sidecar)) continue;
      assertIndexPath(sidecar, binding);
      rmSync(sidecar, { force: true });
    }
    return indexSiblingPaths(targetPath).every((sidecar) => !existsSync(sidecar));
  } catch {
    return false;
  }
}

/**
 * The index could not be replaced because something else has it open.
 *
 * A distinct type rather than a raw `EPERM`, because the two mean different
 * things to a caller: this one is "try again in a moment", and it is the
 * ordinary outcome of rebuilding while an editor extension reads the same
 * scaffold. The build that raised it wrote nothing — the live index is
 * untouched and still correct.
 */
export class IndexInUseError extends Error {
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(
      `The wiki index at ${path} is open in another process, so it could not be replaced. ` +
        `The existing index is unchanged.`,
    );
    this.name = "IndexInUseError";
  }
}

/** Publication failed and the exact prior index was retained for recovery. */
export class IndexPublishRecoveryError extends Error {
  readonly code = "WIKI_INDEX_RECOVERY_REQUIRED";

  constructor(
    readonly path: string,
    readonly recoveryPath: string,
    readonly publishCause: unknown,
    readonly restoreCause: unknown,
  ) {
    super("Wiki index publication failed; the previous index was retained in a same-directory recovery file.");
    this.name = "IndexPublishRecoveryError";
  }
}

/** True when a database file exists at `path`. */
export function indexExists(path: string): boolean {
  return existsSync(path);
}

export type WikiMaintenanceKind = "refresh" | "rebuild" | "operation" | "migration";

export interface WikiMaintenanceLease {
  readonly kind: WikiMaintenanceKind;
  readonly lockPath: string;
  readonly binding: IndexDirectoryBinding;
  release(): void;
}

export class WikiMaintenanceLockedError extends Error {
  readonly code = "WIKI_MAINTENANCE_LOCKED";

  constructor(readonly lockPath: string) {
    super("Another Wiki maintenance operation is already active for this index.");
    this.name = "WikiMaintenanceLockedError";
  }
}

interface LockOwner {
  v: 1;
  pid: number;
  token: string;
  kind: WikiMaintenanceKind | "gate";
  createdAt: string;
}

interface HeldLock {
  path: string;
  owner: LockOwner;
  dev: bigint;
  ino: bigint;
  release(): void;
}

/**
 * Repository-local, cross-process writer lease for Wiki refresh and rebuild.
 *
 * The tiny gate closes the check/remove/create race during dead-holder
 * recovery. Live or unverifiable owners are never stolen, lock symlinks are
 * rejected with `O_NOFOLLOW`, and release verifies both token and inode before
 * deleting anything.
 */
export function acquireWikiMaintenanceLease(
  indexPath: string,
  kind: WikiMaintenanceKind,
  allowedRoot: string,
): WikiMaintenanceLease {
  const binding = bindIndexDirectory(indexPath, allowedRoot);
  assertIndexPath(indexPath, binding);
  // The lease protects canonical Markdown and the operation ledger, not one
  // disposable database filename. Every allowed index name in this scaffold
  // therefore arbitrates through the same fixed lock namespace.
  const lockPath = resolve(binding.directory, "wiki.db.lock");
  const gatePath = `${lockPath}.gate`;
  assertIndexPath(lockPath, binding);
  assertIndexPath(gatePath, binding);

  // A stale gate is never auto-reclaimed: doing so safely needs a second
  // arbitration namespace, recursively. Fail visibly and let explicit/manual
  // recovery remove it after inspecting the owner.
  const gate = acquireLock(gatePath, "gate", binding, false);
  let held: HeldLock;
  try {
    held = acquireLock(lockPath, kind, binding, true);
  } finally {
    gate.release();
  }

  let released = false;
  return {
    kind,
    lockPath,
    binding,
    release: () => {
      if (released) return;
      released = true;
      held.release();
    },
  };
}

function acquireLock(
  path: string,
  kind: LockOwner["kind"],
  binding: IndexDirectoryBinding,
  allowDeadRecovery: boolean,
): HeldLock {
  assertIndexPath(path, binding);
  const owner: LockOwner = {
    v: 1,
    pid: process.pid,
    token: randomBytes(32).toString("hex"),
    kind,
    createdAt: new Date().toISOString(),
  };
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      assertIndexPath(path, binding);
      fd = openSync(path, flags, 0o600);
    } catch (error) {
      if (!isAlreadyExists(error) || attempt > 0 || !allowDeadRecovery || !removeDeadLock(path, binding)) {
        throw new WikiMaintenanceLockedError(path);
      }
      continue;
    }

    let writeError: unknown;
    let openedDev: bigint | undefined;
    let openedIno: bigint | undefined;
    try {
      // Capture ownership before writing: even a partial owner record may
      // fail, and cleanup must never unlink a replacement at the same path.
      const openedStats = fstatSync(fd, { bigint: true });
      if (!openedStats.isFile()) throw new WikiMaintenanceLockedError(path);
      openedDev = openedStats.dev;
      openedIno = openedStats.ino;
      assertIndexPath(path, binding);
      writeExact(fd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"));
      fsyncSync(fd);
    } catch (error) {
      writeError = error;
    } finally {
      closeSync(fd);
    }
    if (writeError !== undefined) {
      try {
        assertIndexPath(path, binding);
        const current = lstatSync(path, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink()
          && current.dev === openedDev && current.ino === openedIno) {
          rmSync(path, { force: true });
        }
      } catch {
        // A missing/unverifiable/replaced lock is not ours to remove.
      }
      throw writeError;
    }
    if (openedDev === undefined || openedIno === undefined) throw new WikiMaintenanceLockedError(path);
    return {
      path,
      owner,
      dev: openedDev,
      ino: openedIno,
      release: () => releaseLock(path, owner, openedDev!, openedIno!, binding),
    };
  }
  throw new WikiMaintenanceLockedError(path);
}

function writeExact(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("The filesystem did not accept the complete Wiki lock owner record.");
    offset += written;
  }
}

function removeDeadLock(path: string, binding: IndexDirectoryBinding): boolean {
  const observed = readOwner(path, binding);
  if (observed === null || processIsAlive(observed.owner.pid)) return false;
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch {
    return true;
  }
  if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
  assertIndexPath(path, binding);
  const final = lstatSync(path, { bigint: true });
  if (!final.isFile() || final.isSymbolicLink()
    || final.dev !== observed.dev || final.ino !== observed.ino) return false;
  rmSync(path, { force: true });
  return true;
}

function releaseLock(
  path: string,
  owner: LockOwner,
  dev: bigint,
  ino: bigint,
  binding: IndexDirectoryBinding,
): void {
  const observed = readOwner(path, binding);
  if (
    observed === null
    || observed.dev !== dev
    || observed.ino !== ino
    || observed.owner.token !== owner.token
  ) {
    throw new WikiMaintenanceLockedError(path);
  }
  assertIndexPath(path, binding);
  const final = lstatSync(path, { bigint: true });
  if (!final.isFile() || final.isSymbolicLink() || final.dev !== dev || final.ino !== ino) {
    throw new WikiMaintenanceLockedError(path);
  }
  rmSync(path, { force: true });
}

function readOwner(
  path: string,
  binding: IndexDirectoryBinding,
): { owner: LockOwner; dev: bigint; ino: bigint } | null {
  let fd: number | undefined;
  try {
    assertIndexPath(path, binding);
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(path, flags);
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile() || stats.size > BigInt(MAX_LOCK_BYTES)) return null;
    // Read through the descriptor whose identity was just captured. Reading by
    // pathname after lstat would let a replace race supply a different owner.
    const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_LOCK_BYTES) return null;
    const after = fstatSync(fd, { bigint: true });
    assertIndexPath(path, binding);
    const current = lstatSync(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== stats.dev || current.ino !== stats.ino
      || after.dev !== stats.dev || after.ino !== stats.ino
      || after.size !== stats.size || BigInt(length) !== stats.size
      || after.mtimeNs !== stats.mtimeNs || after.ctimeNs !== stats.ctimeNs) return null;
    const parsed = JSON.parse(bytes.toString("utf8", 0, length)) as Partial<LockOwner>;
    if (
      parsed.v !== 1
      || !Number.isSafeInteger(parsed.pid)
      || typeof parsed.token !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.token)
      || (
        parsed.kind !== "refresh"
        && parsed.kind !== "rebuild"
        && parsed.kind !== "operation"
        && parsed.kind !== "migration"
        && parsed.kind !== "gate"
      )
      || typeof parsed.createdAt !== "string"
    ) return null;
    return { owner: parsed as LockOwner, dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

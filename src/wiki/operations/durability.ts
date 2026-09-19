/**
 * Directory `fsync`, and the one platform where it cannot be performed.
 *
 * ## What the call is for
 *
 * Both writers here commit a file by renaming a fully-written temp over the
 * target. On POSIX the rename is only durable once the **parent directory** is
 * flushed: `fsync` on the file commits its contents, but the directory entry
 * that names it lives in the parent, and a crash before the parent reaches
 * stable storage can leave the old name — or no name at all. So the sequence is
 * write, `fsync` the file, rename, `fsync` the directory.
 *
 * ## Why Windows is different
 *
 * Windows has no equivalent operation. A directory handle cannot be flushed:
 * `FlushFileBuffers` on a directory is not supported, and the volume-handle
 * flush that would stand in for it needs administrator rights and would flush
 * the whole volume. Node exposes nothing for it either — `constants.O_DIRECTORY`
 * is `undefined` there, so `O_RDONLY | (O_DIRECTORY ?? 0)` opens the directory
 * as though it were an ordinary file, the open **succeeds**, and `fsyncSync` on
 * the resulting handle throws `EPERM`.
 *
 * That `?? 0` reads as portability and is the opposite of it: it removes the
 * only part of the call that would have failed loudly at the open, and leaves a
 * failure at the flush instead.
 *
 * ## HARD: what is given up, so nobody reads this as a promise it does not keep
 *
 * **On Windows the rename's directory entry is never explicitly flushed.** A
 * power loss or host crash in the window between the rename and whenever the
 * filesystem next flushes its own metadata can leave the target file missing or
 * still holding its previous name, even though the bytes that were written to it
 * were flushed. NTFS journals metadata, so the directory is not left
 * *inconsistent* — but journalled is not the same as durable, and the ordering
 * guarantee this code asks for on POSIX is simply not available.
 *
 * File `fsync` is unaffected and stays mandatory everywhere. Only the directory
 * case is skipped, and only where the platform cannot do it.
 *
 * ## Why a platform guard and not errno tolerance
 *
 * Tolerating `EPERM`/`EINVAL` and calling it success would also green Windows,
 * and would additionally cover platforms nobody has tested. It was rejected: the
 * reason this cannot be done is the operating system, not an error, and an
 * errno allowlist silently converts a *genuine* durability failure on a POSIX
 * host — a full or failing device, a sandbox that revokes the call — into a
 * successful write. That is exactly the class of thing a durability step exists
 * to catch.
 *
 * The narrow guard is safe to be narrow because of the other half of this
 * module: on every platform that is expected to support the call, a failure now
 * surfaces **as itself**, with its errno in the message, rather than being
 * relabelled. An untested platform that cannot flush a directory therefore gets
 * a loud, diagnosable error naming the syscall, which is a better outcome than
 * a quiet success.
 */

import { closeSync, constants, fsyncSync, openSync } from "node:fs";

/**
 * Whether this platform can flush a directory handle at all.
 *
 * Windows cannot; everything else this runs on is assumed to be POSIX enough,
 * and is held to it — see {@link syncDirectoryUnconditionally}.
 */
export const DIRECTORY_FSYNC_SUPPORTED = process.platform !== "win32";

/**
 * A directory flush that failed on a platform that is supposed to support it.
 *
 * Distinct from `WritePathError` and `OperationLogPathError` on purpose. Both
 * of those mean *"this path is not one I may touch"*, and reporting a failed
 * durability step as either sends a reader looking at their scaffold layout for
 * a problem that is in the filesystem or the operating system. The original
 * error is kept as `cause` **and put in the message**, because a cause nobody
 * prints is a cause nobody reads.
 */
export class DirectorySyncError extends Error {
  readonly path: string;
  override readonly cause: unknown;
  constructor(path: string, cause: unknown) {
    const code = typeof (cause as { code?: unknown } | null)?.code === "string"
      ? `${(cause as { code: string }).code}: `
      : "";
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not flush the directory ${JSON.stringify(path)} after a rename: ${code}${detail}`);
    this.name = "DirectorySyncError";
    this.path = path;
    this.cause = cause;
  }
}

/**
 * Flush `path`'s directory entry so a preceding rename survives a crash.
 *
 * A no-op where the platform has no such operation. Everywhere else a failure
 * is an error, and is reported as one.
 */
export function syncDirectory(path: string): void {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;
  syncDirectoryUnconditionally(path);
}

/**
 * {@link syncDirectory} without the platform guard.
 *
 * Exported so the guard is testable rather than assumed: a test can drive the
 * unguarded call on a platform where it is known to fail and assert what comes
 * back. Production code calls {@link syncDirectory}.
 */
export function syncDirectoryUnconditionally(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch (error) {
    throw new DirectorySyncError(path, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

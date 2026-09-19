import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Revision } from "../contracts/shared.js";
import { isRevision } from "../contracts/shared.js";
import { artifactError } from "../artifacts/errors.js";
import { canonicalizeProjectRoot } from "../artifacts/filesystem.js";

const SIGNING_DOMAIN = "mex.team.identity-activity.receipt.v1";
const KEY_BYTES = 32;
const KEY_MODE = 0o600;
const LOCAL_DIRECTORY = ".mex/local";

export const TEAM_RECEIPT_SIGNER_RELATIVE_PATH =
  ".mex/local/identity-activity-signing.key" as const;

/** Local trust anchor for exact portable C previews; never package-root exported. */
export class TeamReceiptSigner {
  readonly #projectRoot: string;
  readonly #scaffoldId: string;
  readonly #rootBinding: Readonly<{
    path: string;
    device: string;
    inode: string;
  }>;

  constructor(projectRoot: string, scaffoldId: string) {
    this.#projectRoot = canonicalizeProjectRoot(projectRoot);
    if (
      typeof scaffoldId !== "string"
      || scaffoldId.length === 0
      || scaffoldId.length > 512
      || /[\0-\x1f\x7f]/u.test(scaffoldId)
    ) {
      throw signerProblem(
        "VALIDATION_FAILED",
        "Invalid receipt signer identity",
        "Receipt signing requires one bounded scaffold identity.",
      );
    }
    this.#scaffoldId = scaffoldId;
    const root = statSync(this.#projectRoot, { bigint: true });
    this.#rootBinding = Object.freeze({
      path: this.#projectRoot,
      device: String(root.dev),
      inode: String(root.ino),
    });
  }

  /** Explicit C-preview/Hub-startup preparation boundary. */
  initialize(): void {
    const local = ensureLocalDirectory(this.#projectRoot);
    const finalPath = resolve(local, "identity-activity-signing.key");
    if (pathExists(finalPath)) {
      void readStrictKey(finalPath);
      return;
    }

    const temporaryPath = resolve(
      local,
      `.identity-activity-signing.${randomBytes(16).toString("hex")}.tmp`,
    );
    let descriptor: number | undefined;
    let temporaryPresent = false;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | noFollowFlag(),
        KEY_MODE,
      );
      temporaryPresent = true;
      const key = randomBytes(KEY_BYTES);
      let offset = 0;
      while (offset < key.byteLength) {
        offset += writeSync(descriptor, key, offset, key.byteLength - offset);
      }
      fchmodSync(descriptor, KEY_MODE);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        // Same-directory hard-link publication is atomic and never replaces an
        // existing key. Concurrent initializers therefore converge on exactly
        // one fully written credential.
        linkSync(temporaryPath, finalPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      unlinkSync(temporaryPath);
      temporaryPresent = false;
      fsyncDirectory(local);
      void readStrictKey(finalPath);
    } catch (error) {
      if (error instanceof Error && "problem" in error) throw error;
      throw signerProblem(
        "VALIDATION_FAILED",
        "Receipt signer could not be initialized",
        "The local receipt signing credential could not be provisioned safely.",
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporaryPresent) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // Preserve the actionable signer error; the unpredictable temp name
          // is never treated as a credential.
        }
      }
    }
  }

  sign(canonicalReceipt: string): Revision {
    const key = this.#readKeyForUse();
    return createHmac("sha256", key)
      .update(this.#signingMessage(canonicalReceipt), "utf8")
      .digest("hex") as Revision;
  }

  verify(canonicalReceipt: string, signature: string): void {
    if (!isRevision(signature)) throw invalidSignature();
    const expected = this.sign(canonicalReceipt);
    const actualBytes = Buffer.from(signature, "hex");
    const expectedBytes = Buffer.from(expected, "hex");
    if (
      actualBytes.byteLength !== expectedBytes.byteLength
      || !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw invalidSignature();
    }
  }

  #readKeyForUse(): Buffer {
    const keyPath = resolve(
      this.#projectRoot,
      ...TEAM_RECEIPT_SIGNER_RELATIVE_PATH.split("/"),
    );
    if (!pathExists(keyPath)) {
      throw signerProblem(
        "REVISION_CONFLICT",
        "Receipt signer is unavailable",
        "The local receipt signing credential is missing. Preview the mutation again.",
      );
    }
    assertStrictDirectory(this.#projectRoot, resolve(this.#projectRoot, ".mex"), ".mex");
    assertStrictDirectory(
      this.#projectRoot,
      resolve(this.#projectRoot, LOCAL_DIRECTORY),
      LOCAL_DIRECTORY,
    );
    return readStrictKey(keyPath);
  }

  #signingMessage(canonicalReceipt: string): string {
    return JSON.stringify({
      domain: SIGNING_DOMAIN,
      scaffoldId: this.#scaffoldId,
      root: this.#rootBinding,
      receipt: canonicalReceipt,
    });
  }
}

function ensureLocalDirectory(projectRoot: string): string {
  const mex = resolve(projectRoot, ".mex");
  ensureDirectory(projectRoot, mex, ".mex", 0o755);
  const local = resolve(projectRoot, LOCAL_DIRECTORY);
  ensureDirectory(projectRoot, local, LOCAL_DIRECTORY, 0o700);
  return local;
}

function ensureDirectory(
  projectRoot: string,
  path: string,
  label: string,
  mode: number,
): void {
  if (!pathExists(path)) {
    try {
      mkdirSync(path, { mode });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw signerProblem(
          "VALIDATION_FAILED",
          "Receipt signer directory is unavailable",
          `The local ${label} directory could not be created safely.`,
        );
      }
    }
  }
  assertStrictDirectory(projectRoot, path, label);
}

function assertStrictDirectory(projectRoot: string, path: string, label: string): void {
  let stat;
  let canonical: string;
  try {
    stat = lstatSync(path);
    canonical = realpathSync(path);
  } catch (error) {
    if (isNotFound(error)) {
      throw signerProblem(
        "REVISION_CONFLICT",
        "Receipt signer is unavailable",
        `The local ${label} directory is missing. Preview the mutation again.`,
      );
    }
    throw signerProblem(
      "PATH_OUTSIDE_PROJECT",
      "Unsafe receipt signer path",
      `The local ${label} directory could not be resolved safely inside the repository.`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw signerProblem(
      "PATH_OUTSIDE_PROJECT",
      "Unsafe receipt signer path",
      `The local ${label} path must be a real directory inside the repository.`,
    );
  }
  const escaped = relative(projectRoot, canonical);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || escaped.startsWith(sep)) {
    throw signerProblem(
      "PATH_OUTSIDE_PROJECT",
      "Unsafe receipt signer path",
      `The local ${label} directory escapes the repository.`,
    );
  }
}

function readStrictKey(path: string): Buffer {
  let lexical;
  try {
    lexical = lstatSync(path, { bigint: true });
  } catch {
    throw signerProblem(
      "REVISION_CONFLICT",
      "Receipt signer is unavailable",
      "The local receipt signing credential is missing. Preview the mutation again.",
    );
  }
  if (lexical.isSymbolicLink() || !lexical.isFile()) throw unsafeKey();
  if (process.platform !== "win32" && Number(lexical.mode & 0o777n) !== KEY_MODE) {
    throw signerProblem(
      "VALIDATION_FAILED",
      "Receipt signer permissions are unsafe",
      "The local receipt signing credential must have mode 0600.",
    );
  }
  if (lexical.size !== BigInt(KEY_BYTES)) throw malformedKey();

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== lexical.dev
      || opened.ino !== lexical.ino
      || opened.size !== BigInt(KEY_BYTES)
      || opened.mtimeNs !== lexical.mtimeNs
      || opened.ctimeNs !== lexical.ctimeNs
      || (process.platform !== "win32" && Number(opened.mode & 0o777n) !== KEY_MODE)
    ) {
      throw unsafeKey();
    }
    const key = Buffer.alloc(KEY_BYTES);
    let offset = 0;
    while (offset < KEY_BYTES) {
      const read = readSync(descriptor, key, offset, KEY_BYTES - offset, offset);
      if (read === 0) throw malformedKey();
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== BigInt(KEY_BYTES)
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || (process.platform !== "win32" && Number(after.mode & 0o777n) !== KEY_MODE)
    ) {
      throw unsafeKey();
    }
    const finalPath = lstatSync(path, { bigint: true });
    if (
      finalPath.isSymbolicLink()
      || !finalPath.isFile()
      || finalPath.dev !== after.dev
      || finalPath.ino !== after.ino
      || finalPath.size !== BigInt(KEY_BYTES)
      || finalPath.mtimeNs !== after.mtimeNs
      || finalPath.ctimeNs !== after.ctimeNs
      || (process.platform !== "win32" && Number(finalPath.mode & 0o777n) !== KEY_MODE)
    ) {
      throw unsafeKey();
    }
    return key;
  } catch (error) {
    if (error instanceof Error && "problem" in error) throw error;
    throw unsafeKey();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return !isNotFound(error);
  }
}

function isNotFound(error: unknown): boolean {
  return isSystemError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isSystemError(error) && error.code === "EEXIST";
}

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

function unsafeKey() {
  return signerProblem(
    "PATH_OUTSIDE_PROJECT",
    "Unsafe receipt signer credential",
    "The local receipt signing credential must be one contained regular file.",
  );
}

function malformedKey() {
  return signerProblem(
    "VALIDATION_FAILED",
    "Receipt signer credential is malformed",
    "The local receipt signing credential must contain exactly 32 bytes.",
  );
}

function invalidSignature() {
  return signerProblem(
    "REVISION_CONFLICT",
    "Identity or Activity preview signature is invalid",
    "The portable preview was not issued by this local repository signer. Preview again.",
  );
}

function signerProblem(
  code: "VALIDATION_FAILED" | "REVISION_CONFLICT" | "PATH_OUTSIDE_PROJECT",
  title: string,
  detail: string,
) {
  return artifactError(code, title, detail, TEAM_RECEIPT_SIGNER_RELATIVE_PATH);
}

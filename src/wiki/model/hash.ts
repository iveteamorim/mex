import { createHash } from "node:crypto";

/**
 * Content hashes.
 *
 * Three quantities track change in this engine and they do three different
 * jobs. Conflating any two of them is a bug that shows up as either spurious
 * write rejections or silent clobbering, so they are named apart here:
 *
 * - {@link entityContentHash} — over one entity's own text (metadata block plus
 *   heading plus body). **This is the operation precondition** — the value an
 *   operation envelope carries as `baseContentHash`, and the thing that blocks a
 *   stale write.
 * - {@link fileContentHash} — over a whole file. A change-detection signal for
 *   incremental refresh, and a hint that cached offsets must be recomputed.
 *   **Never a precondition.**
 * - `revision` — a monotonic integer on the entity, incremented only by an
 *   accepted operation. The semantic version, for humans and audit. Not a hash.
 *
 * Why the precondition is entity-scoped rather than file-scoped: several
 * entities routinely share one file. Under a file-scoped precondition an edit
 * anywhere in `architecture.md` would block an operation on an unrelated
 * section, and two agents working on two different sections would collide for
 * no reason. Whole-file damage is caught by write-scope enforcement at apply
 * time instead, which compares the produced text against the original outside
 * the declared ranges and does not depend on hash granularity.
 */

/**
 * Line-ending normalization applied before hashing.
 *
 * CRLF and LF checkouts of the same file must agree on an entity's hash or a
 * precondition minted on Windows would be rejected on Linux. The consequence to
 * keep in mind: **a content hash is not a hash of the on-disk bytes.** Write-
 * scope enforcement therefore compares raw text, never these values.
 */
export function normalizeForHashing(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(normalizeForHashing(text), "utf8").digest("hex");
}

/**
 * Hash the exact UTF-8 bytes of a containing canonical file.
 *
 * This is intentionally different from {@link entityContentHash}. Entity
 * hashes are semantic operation preconditions and remain line-ending neutral;
 * an `EntityVersion`, index freshness observation, and indexed corpus revision
 * describe the exact file bytes that were observed. CRLF, LF, and a UTF-8 BOM
 * therefore produce different exact-file hashes.
 */
export function exactFileContentHash(bytes: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

/**
 * Stable revision of an indexed corpus, derived only from sorted relative paths
 * and their exact byte hashes. Length-prefixed fields make the encoding
 * injective without relying on a path delimiter.
 */
export function indexedCorpusRevision(
  files: readonly { path: string; contentHash: string }[],
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))) {
    hash.update(String(Buffer.byteLength(file.path, "utf8")), "ascii");
    hash.update(":", "ascii");
    hash.update(file.path, "utf8");
    hash.update(":", "ascii");
    hash.update(file.contentHash, "ascii");
    hash.update("\n", "ascii");
  }
  return hash.digest("hex");
}

/** Hash of one entity's own text. The operation precondition. */
export function entityContentHash(entityText: string): string {
  return sha256Hex(entityText);
}

/** Hash of a whole file's text. A change-detection signal, never a precondition. */
export function fileContentHash(fileText: string): string {
  return sha256Hex(fileText);
}

/** Lowercase 64-character hex, the shape both hash functions produce. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH_PATTERN.test(value);
}

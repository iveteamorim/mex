import { createHash } from "node:crypto";
import type { Revision } from "../contracts/shared.js";

/**
 * SHA-256 of exactly the supplied bytes. Generic file and Wiki revisions bind
 * on-disk bytes. Canonical Team codecs explicitly use their LF representation
 * so Git checkout conversion does not change their portable record identity.
 */
export function revisionOf(bytes: string | Uint8Array): Revision {
  return createHash("sha256").update(bytes).digest("hex") as Revision;
}

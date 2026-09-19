import { createHash, hash } from "node:crypto";
import { BANDS, K, ROWS } from "./config.js";
import { FINGERPRINT_PREFIX, type Fingerprint } from "./reconcile.js";

const UINT32_MAX = 0xffffffff;

function hash32(value: string, seed: number): number {
  const digest = createHash("sha256")
    .update(String(seed))
    .update("\0")
    .update(value)
    .digest();
  return digest.readUInt32BE(0);
}

export interface FingerprintBuilder {
  create(
    normalizedTokens: readonly string[],
    callers?: readonly string[],
    callees?: readonly string[],
  ): Fingerprint;
}

/**
 * Create a corpus-scoped builder that memoizes the 64 seed hashes for each
 * normalized syntax trigram. Extractor tokens intentionally discard identifier
 * and literal spellings, so the same small trigram vocabulary recurs throughout
 * a repository; sharing those hashes avoids repeating identical SHA-256 work
 * without changing a single MinHash value.
 */
export function createFingerprintBuilder(): FingerprintBuilder {
  const trigramHashes = new Map<string, Uint32Array>();
  return {
    create(normalizedTokens, callers = [], callees = []) {
      return createFingerprintInternal(normalizedTokens, callers, callees, trigramHashes);
    },
  };
}

/** Build a Tier-2 fingerprint from an extractor-provided normalized AST token stream. */
export function createFingerprint(
  normalizedTokens: readonly string[],
  callers: readonly string[] = [],
  callees: readonly string[] = [],
): Fingerprint {
  return createFingerprintInternal(normalizedTokens, callers, callees);
}

function createFingerprintInternal(
  normalizedTokens: readonly string[],
  callers: readonly string[],
  callees: readonly string[],
  trigramHashes?: Map<string, Uint32Array>,
): Fingerprint {
  const trigrams = new Set<string>();
  for (let index = 0; index <= normalizedTokens.length - 3; index += 1) {
    trigrams.add(normalizedTokens.slice(index, index + 3).join("\0"));
  }

  const minima = new Uint32Array(K);
  minima.fill(UINT32_MAX);
  for (const trigram of trigrams) {
    let hashes = trigramHashes?.get(trigram);
    if (!hashes) {
      hashes = new Uint32Array(K);
      for (let seed = 0; seed < K; seed += 1) hashes[seed] = hash32(trigram, seed);
      trigramHashes?.set(trigram, hashes);
    }
    for (let seed = 0; seed < K; seed += 1) {
      if (hashes[seed]! < minima[seed]!) minima[seed] = hashes[seed]!;
    }
  }

  return {
    minhash: Array.from(minima),
    neighbors: [...new Set([...callers, ...callees])].sort(),
    tokenCount: normalizedTokens.length,
  };
}

export function serializeFingerprint(fingerprint: Fingerprint): string {
  assertFingerprint(fingerprint);
  const payload = Buffer.from(JSON.stringify(fingerprint), "utf8").toString("hex");
  return `${FINGERPRINT_PREFIX}:${K}:${payload}`;
}

export function deserializeFingerprint(serialized: string): Fingerprint | null {
  const [prefix, sizeText, payload, ...extra] = serialized.split(":");
  if (prefix !== FINGERPRINT_PREFIX || Number(sizeText) !== K || !payload || extra.length > 0) {
    return null;
  }
  try {
    const value = JSON.parse(Buffer.from(payload, "hex").toString("utf8")) as unknown;
    assertFingerprint(value);
    return value;
  } catch {
    return null;
  }
}

export function bandHashes(fingerprint: Fingerprint): string[] {
  assertFingerprint(fingerprint);
  if (BANDS * ROWS !== K) {
    throw new Error(`Invalid LSH configuration: ${BANDS} * ${ROWS} !== ${K}`);
  }
  return Array.from({ length: BANDS }, (_, band) => {
    const start = band * ROWS;
    return hash("sha256", JSON.stringify(fingerprint.minhash.slice(start, start + ROWS)));
  });
}

/**
 * Compact schema-v4 LSH band hashes (retained from main-v3): the first 8 bytes
 * of the same per-band sha256
 * that {@link bandHashes} hex-encodes, as a signed 64-bit integer for compact
 * INTEGER storage. Derivation input is identical, so two fingerprints share an
 * int64 band hash exactly when they share the hex band hash (modulo a ~2^-64
 * truncation collision, which merely adds one LSH candidate that full minhash
 * scoring then rejects — it can never remove or reorder a true candidate).
 */
export function bandHashInts(fingerprint: Fingerprint): bigint[] {
  assertFingerprint(fingerprint);
  if (BANDS * ROWS !== K) {
    throw new Error(`Invalid LSH configuration: ${BANDS} * ${ROWS} !== ${K}`);
  }
  return Array.from({ length: BANDS }, (_, band) => {
    const start = band * ROWS;
    // One-shot hex digest: the first 16 hex digits are the first 8 digest
    // bytes, read as a signed 64-bit integer exactly as readBigInt64BE(0) did.
    // For these tiny inputs it is ~40% faster than a Hash object per band, and
    // this runs 32 times per fingerprint in every build and fingerprint audit.
    const digest = hash("sha256", JSON.stringify(fingerprint.minhash.slice(start, start + ROWS)));
    return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
  });
}

/** Encode a K=64 uint32 minhash as a 256-byte big-endian BLOB (schema v4). */
export function encodeMinhash(minhash: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(minhash.length * 4);
  minhash.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
  return buffer;
}

/** Decode a schema-v4 minhash BLOB back to the uint32 array it encodes. */
export function decodeMinhash(blob: Uint8Array): number[] {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    values.push(buffer.readUInt32BE(offset));
  }
  return values;
}

function assertFingerprint(value: unknown): asserts value is Fingerprint {
  if (!value || typeof value !== "object") throw new Error("Invalid fingerprint");
  const candidate = value as Partial<Fingerprint>;
  if (
    !Array.isArray(candidate.minhash) ||
    candidate.minhash.length !== K ||
    candidate.minhash.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > UINT32_MAX) ||
    !Array.isArray(candidate.neighbors) ||
    candidate.neighbors.some((entry) => typeof entry !== "string") ||
    !Number.isInteger(candidate.tokenCount) ||
    (candidate.tokenCount ?? -1) < 0
  ) {
    throw new Error("Invalid fingerprint");
  }
}

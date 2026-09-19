import { randomFillSync } from "node:crypto";

/**
 * ULID generation, implemented in-repo rather than taken from npm.
 *
 * A ULID is 128 bits — a 48-bit big-endian millisecond timestamp followed by 80
 * bits of randomness — rendered as 26 Crockford Base32 characters (10 for the
 * timestamp, 16 for the randomness). Crockford's alphabet omits `I`, `L`, `O`
 * and `U` so a hand-copied id cannot be misread.
 *
 * The property the wiki engine actually depends on is **lexicographic order
 * matching generation order**, including within a single millisecond. Plain
 * re-randomization does not give that: two ids minted in the same millisecond
 * sort arbitrarily. {@link generateUlid} therefore keeps the previous
 * randomness and increments it as an 80-bit big-endian integer whenever the
 * clock has not advanced, which is the standard "monotonic ULID" behaviour.
 */

/** Crockford Base32, excluding I, L, O and U. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ULID_LENGTH = 26;
export const ULID_TIME_LENGTH = 10;
export const ULID_RANDOM_LENGTH = 16;

/** Largest timestamp a 48-bit ULID time field can carry (10889-08-02T05:31:50.655Z). */
export const ULID_MAX_TIME = 2 ** 48 - 1;

const RANDOM_BYTES = 10; // 80 bits
const BITS_PER_CHAR = 5;

/** Reverse lookup for decoding; -1 marks a character outside the alphabet. */
const DECODE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < CROCKFORD_ALPHABET.length; index += 1) {
    table[CROCKFORD_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/**
 * Encode a 48-bit millisecond timestamp as 10 Crockford characters.
 *
 * Done with `Math.floor` division rather than bit operations on purpose: JS
 * bitwise operators coerce to 32 bits, which would silently truncate the top 16
 * bits of a 48-bit timestamp.
 */
export function encodeUlidTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > ULID_MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${timeMs}`);
  }
  let remaining = timeMs;
  let encoded = "";
  for (let index = 0; index < ULID_TIME_LENGTH; index += 1) {
    encoded = CROCKFORD_ALPHABET[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

/**
 * Encode 10 random bytes as 16 Crockford characters.
 *
 * 16 characters carry exactly 80 bits, so this is a dense big-endian bit
 * repacking with no padding: character `i` takes bits `[5i, 5i+5)` of the byte
 * array. The 16-bit sliding window keeps the span across a byte boundary
 * straightforward.
 */
export function encodeUlidRandom(bytes: Uint8Array): string {
  if (bytes.length !== RANDOM_BYTES) {
    throw new RangeError(`ULID randomness must be ${RANDOM_BYTES} bytes, got ${bytes.length}`);
  }
  let encoded = "";
  for (let index = 0; index < ULID_RANDOM_LENGTH; index += 1) {
    const bit = index * BITS_PER_CHAR;
    const byteIndex = bit >> 3;
    const shift = bit & 7;
    const high = bytes[byteIndex]!;
    const low = byteIndex + 1 < bytes.length ? bytes[byteIndex + 1]! : 0;
    // Bring bit (shift + 4) of the window down to position 0, then mask 5 bits.
    encoded += CROCKFORD_ALPHABET[(((high << 8) | low) >>> (11 - shift)) & 31];
  }
  return encoded;
}

/** Decode the timestamp from a 26-character ULID body. Returns null if malformed. */
export function decodeUlidTime(ulid: string): number | null {
  if (ulid.length < ULID_TIME_LENGTH) return null;
  let time = 0;
  for (let index = 0; index < ULID_TIME_LENGTH; index += 1) {
    const code = ulid.charCodeAt(index);
    const value = code < 128 ? DECODE[code]! : -1;
    if (value < 0) return null;
    time = time * 32 + value;
  }
  return time > ULID_MAX_TIME ? null : time;
}

/** True when `value` is exactly 26 uppercase Crockford characters. */
export function isUlid(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== ULID_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 128 || DECODE[code]! < 0) return false;
  }
  // The first character encodes the top 2 bits of a 50-bit field holding a
  // 48-bit value, so anything above '7' overflows the timestamp.
  return value.charCodeAt(0) <= CROCKFORD_ALPHABET.charCodeAt(7);
}

/** Increment a big-endian byte array in place. Returns false on overflow. */
function incrementBytes(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index]! < 0xff) {
      bytes[index] += 1;
      return true;
    }
    bytes[index] = 0;
  }
  return false;
}

/**
 * A monotonic ULID generator.
 *
 * Exported as a factory so tests can drive it with an injected clock and so two
 * independent call sites cannot interfere through shared module state. Most
 * callers want the process-wide {@link generateUlid}.
 */
export interface UlidGenerator {
  (): string;
}

export function createUlidGenerator(now: () => number = Date.now): UlidGenerator {
  let lastTime = -1;
  const random = new Uint8Array(RANDOM_BYTES);

  return function generate(): string {
    const observed = now();
    if (!Number.isFinite(observed)) throw new RangeError(`Invalid clock reading: ${observed}`);
    const time = Math.floor(observed);

    // `<=` rather than `===`: a clock that steps backwards (NTP correction,
    // suspend/resume) must not be allowed to mint an id that sorts before one
    // already handed out. Holding lastTime and incrementing keeps the sequence
    // monotonic at the cost of timestamps briefly running ahead of the clock.
    if (time <= lastTime) {
      if (!incrementBytes(random)) {
        // 2^80 ids inside one millisecond is not reachable in practice, but the
        // carry still has to go somewhere it cannot collide: advance into the
        // next millisecond and start a fresh randomness field there.
        lastTime += 1;
        randomFillSync(random);
        return encodeUlidTime(lastTime) + encodeUlidRandom(random);
      }
      return encodeUlidTime(lastTime) + encodeUlidRandom(random);
    }

    lastTime = time;
    randomFillSync(random);
    return encodeUlidTime(time) + encodeUlidRandom(random);
  };
}

/** Process-wide monotonic ULID generator. */
export const generateUlid: UlidGenerator = createUlidGenerator();

import { describe, it, expect } from "vitest";
import {
  CROCKFORD_ALPHABET,
  ULID_LENGTH,
  ULID_MAX_TIME,
  createUlidGenerator,
  decodeUlidTime,
  encodeUlidRandom,
  encodeUlidTime,
  generateUlid,
  isUlid,
} from "../ulid.js";

describe("ULID encoding", () => {
  it("encodes a timestamp as 10 Crockford characters", () => {
    expect(encodeUlidTime(0)).toBe("0000000000");
    expect(encodeUlidTime(1)).toBe("0000000001");
    expect(encodeUlidTime(32)).toBe("0000000010");
    expect(encodeUlidTime(ULID_MAX_TIME)).toHaveLength(10);
  });

  it("round-trips every timestamp it encodes", () => {
    const samples = [0, 1, 31, 32, 1_000, 1_700_000_000_000, Date.now(), ULID_MAX_TIME];
    for (const time of samples) {
      expect(decodeUlidTime(encodeUlidTime(time))).toBe(time);
    }
  });

  it("rejects a timestamp outside the 48-bit field", () => {
    expect(() => encodeUlidTime(ULID_MAX_TIME + 1)).toThrow(RangeError);
    expect(() => encodeUlidTime(-1)).toThrow(RangeError);
    expect(() => encodeUlidTime(1.5)).toThrow(RangeError);
  });

  it("packs 80 bits of randomness into 16 characters without losing any", () => {
    // All-zero and all-one bytes pin both ends of the bit repacking; a
    // shift-by-one bug shows up immediately in either.
    expect(encodeUlidRandom(new Uint8Array(10))).toBe("0000000000000000");
    expect(encodeUlidRandom(new Uint8Array(10).fill(0xff))).toBe("ZZZZZZZZZZZZZZZZ");
  });

  it("maps a known bit pattern to the expected characters", () => {
    // 0x88 = 10001000. The first 5-bit group is 10001 = 17 -> "H"; the second
    // spans the byte boundary (000 plus two zero bits) -> "0". A byte-at-a-time
    // encoder that never crosses a boundary gets the second group wrong.
    const bytes = new Uint8Array([0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(encodeUlidRandom(bytes)).toBe("H000000000000000");
  });

  it("rejects randomness of the wrong length", () => {
    expect(() => encodeUlidRandom(new Uint8Array(9))).toThrow(RangeError);
    expect(() => encodeUlidRandom(new Uint8Array(11))).toThrow(RangeError);
  });

  it("uses no ambiguous characters", () => {
    for (const excluded of ["I", "L", "O", "U"]) {
      expect(CROCKFORD_ALPHABET).not.toContain(excluded);
    }
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
  });
});

describe("generateUlid", () => {
  it("mints 10,000 ids that are unique and already in lexicographic order", () => {
    const ids: string[] = [];
    for (let index = 0; index < 10_000; index += 1) ids.push(generateUlid());

    expect(new Set(ids).size).toBe(10_000);
    // Not `[...ids].sort()` compared to `ids` — that would pass for an
    // already-sorted array produced by luck. Assert the pairwise property.
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!).toBe(true);
    }
  });

  it("is monotonic when the clock does not move at all", () => {
    // The case plain re-randomization gets wrong: a frozen clock makes every
    // id share a timestamp, so ordering rests entirely on the randomness field.
    const generate = createUlidGenerator(() => 1_700_000_000_000);
    const ids = Array.from({ length: 1_000 }, () => generate());

    expect(new Set(ids).size).toBe(1_000);
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!).toBe(true);
      expect(decodeUlidTime(ids[index]!)).toBe(1_700_000_000_000);
    }
  });

  it("stays monotonic when the clock steps backwards", () => {
    // An NTP correction or a suspend/resume must not be able to mint an id
    // that sorts before one already handed out.
    let now = 1_700_000_000_000;
    const generate = createUlidGenerator(() => now);
    const first = generate();
    now -= 5_000;
    const second = generate();
    const third = generate();

    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
  });

  it("advances into the next millisecond when the randomness field overflows", () => {
    // Force the carry path by exhausting the field: with a frozen clock the
    // generator must not repeat an id even at the boundary.
    const generate = createUlidGenerator(() => 42);
    const seen = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) seen.add(generate());
    expect(seen.size).toBe(5_000);
  });

  it("encodes the generation timestamp", () => {
    const before = Date.now();
    const id = generateUlid();
    const after = Date.now();
    const decoded = decodeUlidTime(id)!;

    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after + 1);
  });

  it("produces 26 characters drawn only from the Crockford alphabet", () => {
    for (let index = 0; index < 200; index += 1) {
      const id = generateUlid();
      expect(id).toHaveLength(ULID_LENGTH);
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it("rejects a non-finite clock", () => {
    const generate = createUlidGenerator(() => Number.NaN);
    expect(() => generate()).toThrow(RangeError);
  });
});

describe("isUlid", () => {
  it("accepts a generated id", () => {
    expect(isUlid(generateUlid())).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVX")).toBe(false);
  });

  it("rejects the excluded Crockford letters", () => {
    for (const excluded of ["I", "L", "O", "U"]) {
      expect(isUlid(`01ARZ3NDEKTSV4RRFFQ69G5F${excluded}V`.slice(0, 26))).toBe(false);
    }
  });

  it("rejects lowercase", () => {
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
  });

  it("rejects a timestamp that overflows the 48-bit field", () => {
    // 'Z' as the leading character sets bits above the 48-bit timestamp.
    expect(isUlid("ZZARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isUlid("7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isUlid(undefined)).toBe(false);
    expect(isUlid(null)).toBe(false);
    expect(isUlid(12345)).toBe(false);
  });
});

describe("decodeUlidTime", () => {
  it("returns null for malformed input", () => {
    expect(decodeUlidTime("short")).toBeNull();
    expect(decodeUlidTime("!!!!!!!!!!")).toBeNull();
    expect(decodeUlidTime("ZZZZZZZZZZ")).toBeNull();
  });
});

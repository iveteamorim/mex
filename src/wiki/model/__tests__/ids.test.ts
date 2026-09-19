import { describe, it, expect } from "vitest";
import {
  ENTITY_ID_LENGTH,
  ENTITY_ID_PATTERN,
  ENTITY_ID_PREFIX,
  READABLE_ENTITY_ID_PREFIXES,
  compareEntityIds,
  entityIdTimestamp,
  findDuplicateEntityIds,
  generateEntityId,
  isEntityId,
  normalizeEntityId,
  type EntityId,
} from "../ids.js";

const SAMPLE = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("generateEntityId", () => {
  it("produces the canonical form", () => {
    for (let index = 0; index < 200; index += 1) {
      const id = generateEntityId();
      expect(id).toMatch(ENTITY_ID_PATTERN);
      expect(id).toHaveLength(ENTITY_ID_LENGTH);
      expect(id.startsWith(ENTITY_ID_PREFIX)).toBe(true);
      expect(isEntityId(id)).toBe(true);
    }
  });

  it("never repeats, and sorts in creation order", () => {
    const ids = Array.from({ length: 5_000 }, () => generateEntityId());
    expect(new Set(ids).size).toBe(5_000);
    for (let index = 1; index < ids.length; index += 1) {
      expect(compareEntityIds(ids[index - 1]!, ids[index]!)).toBeLessThan(0);
    }
  });

  it("does not derive the id from anything about the entity", () => {
    // The rename/move requirement in one assertion: two entities with identical
    // titles, paths and bodies still get different ids, because nothing about
    // the content is an input.
    expect(generateEntityId()).not.toBe(generateEntityId());
  });
});

describe("isEntityId", () => {
  it("accepts a canonical id", () => {
    expect(isEntityId(SAMPLE)).toBe(true);
  });

  it("accepts every canonical Team-owned prefix on read", () => {
    expect(READABLE_ENTITY_ID_PREFIXES).toEqual([
      "mx_",
      "member_",
      "ws_",
      "proposal_",
      "relay_",
      "event_",
      "playbook_",
      "run_",
    ]);
    for (const prefix of READABLE_ENTITY_ID_PREFIXES) {
      const id = `${prefix}${ULID}`;
      expect(isEntityId(id), prefix).toBe(true);
      expect(id).toMatch(ENTITY_ID_PATTERN);
    }
  });

  it("rejects the wrong prefix", () => {
    expect(isEntityId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isEntityId("mex_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(isEntityId("MX_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(isEntityId("mx_01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
    expect(isEntityId("mx_01ARZ3NDEKTSV4RRFFQ69G5FAVV")).toBe(false);
  });

  it("rejects a lowercase body", () => {
    expect(isEntityId("mx_01arz3ndektsv4rrffq69g5fav")).toBe(false);
  });

  it("rejects the excluded Crockford letters I, L, O and U", () => {
    for (const excluded of ["I", "L", "O", "U"]) {
      const id = `mx_${excluded}1ARZ3NDEKTSV4RRFFQ69G5FAV`;
      expect(id).toHaveLength(ENTITY_ID_LENGTH);
      expect(isEntityId(id)).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(isEntityId(null)).toBe(false);
    expect(isEntityId(undefined)).toBe(false);
    expect(isEntityId(42)).toBe(false);
    expect(isEntityId({ id: SAMPLE })).toBe(false);
  });
});

describe("normalizeEntityId", () => {
  it("uppercases the body and lowercases the prefix", () => {
    expect(normalizeEntityId("MX_01arz3ndektsv4rrffq69g5fav")).toBe(SAMPLE);
    expect(normalizeEntityId("Mx_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(SAMPLE);
    expect(normalizeEntityId(`PLAYBOOK_${ULID.toLowerCase()}`)).toBe(`playbook_${ULID}`);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEntityId(`  ${SAMPLE}\n`)).toBe(SAMPLE);
  });

  it("is idempotent", () => {
    expect(normalizeEntityId(normalizeEntityId(SAMPLE)!)).toBe(SAMPLE);
  });

  it("does not map ambiguous letters onto digits", () => {
    // Crockford's *decoder* is lenient about I/L/O; we deliberately are not.
    // Mapping "I" to "1" would turn a typo into a different valid id silently
    // pointing at another entity.
    expect(normalizeEntityId("mx_I1ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    expect(normalizeEntityId("mx_O1ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
  });

  it("returns null for anything that is not an id", () => {
    expect(normalizeEntityId("not-an-id")).toBeNull();
    expect(normalizeEntityId("")).toBeNull();
    expect(normalizeEntityId(undefined)).toBeNull();
    expect(normalizeEntityId(7)).toBeNull();
  });
});

describe("entityIdTimestamp", () => {
  it("recovers the generation time", () => {
    const before = Date.now();
    const id = generateEntityId();
    const after = Date.now();
    const decoded = entityIdTimestamp(id)!;

    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after + 1);
  });

  it("accepts a non-canonical spelling", () => {
    expect(entityIdTimestamp("MX_01arz3ndektsv4rrffq69g5fav")).toBe(entityIdTimestamp(SAMPLE));
    expect(entityIdTimestamp(`WS_${ULID.toLowerCase()}`)).toBe(entityIdTimestamp(SAMPLE));
  });

  it("returns null for a malformed id", () => {
    expect(entityIdTimestamp("nope")).toBeNull();
  });
});

describe("findDuplicateEntityIds", () => {
  it("returns nothing when every id is distinct", () => {
    expect(findDuplicateEntityIds([generateEntityId(), generateEntityId()])).toEqual([]);
  });

  it("reports each duplicate once, in first-seen order", () => {
    const first = generateEntityId();
    const second = generateEntityId();
    expect(findDuplicateEntityIds([first, second, first, first, second])).toEqual([first, second]);
  });

  it("catches duplicates that differ only in case", () => {
    // The case a case-sensitive check misses: two spellings, one identity, two
    // index rows claiming it.
    expect(findDuplicateEntityIds([SAMPLE, SAMPLE.toUpperCase()])).toEqual([SAMPLE]);
    expect(findDuplicateEntityIds([`relay_${ULID}`, `RELAY_${ULID.toLowerCase()}`]))
      .toEqual([`relay_${ULID}`]);
  });

  it("ignores values that are not ids at all", () => {
    // Those are INVALID_ENTITY_ID, reported by the entity validator; reporting
    // them here too would double-count one problem.
    expect(findDuplicateEntityIds(["nope", "nope"])).toEqual([]);
  });
});

describe("EntityId branding", () => {
  it("does not accept a bare string where an id is required", () => {
    const accepts = (id: EntityId): EntityId => id;
    // @ts-expect-error a bare string is not an EntityId; it must pass a guard.
    accepts("mx_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    // The guard is the way in, and it narrows.
    const raw: unknown = SAMPLE;
    if (isEntityId(raw)) expect(accepts(raw)).toBe(SAMPLE);
  });
});

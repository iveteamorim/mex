import { describe, expect, it } from "vitest";
import { generateArtifactId, isArtifactId, isUlid } from "../ulid.js";
import { revisionOf } from "../revision.js";

describe("canonical artifact identifiers and revisions", () => {
  it("encodes a 48-bit time and 80 bits of supplied entropy as a prefixed ULID", () => {
    const id = generateArtifactId("member", {
      now: 0,
      random: new Uint8Array(10),
    });

    expect(id).toBe("member_00000000000000000000000000");
    expect(isArtifactId(id, "member")).toBe(true);
    expect(isArtifactId(id, "event")).toBe(false);
    expect(isUlid(id.slice("member_".length))).toBe(true);
  });

  it("rejects overflow times and entropy that is not exactly 80 bits", () => {
    expect(() => generateArtifactId("event", { now: 0x1_0000_0000_0000 })).toThrow(/48-bit/);
    expect(() => generateArtifactId("event", { random: new Uint8Array(9) })).toThrow(/10 bytes/);
    expect(isUlid("8".repeat(26))).toBe(false);
    expect(isUlid("I".repeat(26))).toBe(false);
  });

  it("hashes exact bytes without line-ending or Unicode normalization", () => {
    expect(revisionOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(revisionOf("line\n")).not.toBe(revisionOf("line\r\n"));
    expect(revisionOf("é")).not.toBe(revisionOf("e\u0301"));
  });
});

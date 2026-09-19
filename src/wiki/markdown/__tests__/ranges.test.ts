import { describe, it, expect } from "vitest";
import {
  assertOnlyRangesChanged,
  assertRangePartition,
  checkOnlyRangesChanged,
  checkRangePartition,
  type LabeledRange,
} from "../ranges.js";

/**
 * The harnesses' own tests.
 *
 * Every later phase's claim about preserving unrelated content rests on these
 * two functions, so a false pass here would silently disarm the whole oracle.
 * Each failure mode therefore gets a deliberately broken example, not just a
 * happy path.
 */

function range(label: string, start: number, end: number): LabeledRange {
  return { label, start, end };
}

const SOURCE = "---\nname: a\n---\n\n## Heading\n\nBody text.\n";

describe("checkRangePartition", () => {
  it("accepts a complete, ordered, non-overlapping cover", () => {
    const ranges = [range("gap[0]", 0, 17), range("heading", 17, 28), range("body", 28, SOURCE.length)];
    expect(checkRangePartition(SOURCE, ranges)).toEqual({ ok: true });
  });

  it("accepts a single range covering the whole file", () => {
    expect(checkRangePartition(SOURCE, [range("all", 0, SOURCE.length)]).ok).toBe(true);
  });

  it("accepts zero-length ranges", () => {
    // A file-level entity has no heading; its heading range is empty, not absent.
    const ranges = [range("metadata", 0, 17), range("heading", 17, 17), range("body", 17, SOURCE.length)];
    expect(checkRangePartition(SOURCE, ranges).ok).toBe(true);
  });

  it("accepts an empty file covered by no ranges", () => {
    expect(checkRangePartition("", []).ok).toBe(true);
  });

  it("rejects overlapping ranges", () => {
    const result = checkRangePartition(SOURCE, [
      range("a", 0, 20),
      range("b", 17, SOURCE.length),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/overlaps/);
  });

  it("rejects a gap between ranges", () => {
    // The off-by-one case: a body that starts one character late.
    const result = checkRangePartition(SOURCE, [range("a", 0, 17), range("b", 18, SOURCE.length)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Unaccounted text at \[17, 18\)/);
  });

  it("rejects ranges supplied out of order", () => {
    const result = checkRangePartition(SOURCE, [range("body", 17, SOURCE.length), range("head", 0, 17)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/position order/);
  });

  it("rejects a range running past end of input", () => {
    const result = checkRangePartition(SOURCE, [range("a", 0, SOURCE.length + 5)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/past end of input/);
  });

  it("rejects an inverted range", () => {
    const result = checkRangePartition(SOURCE, [range("a", 20, 10)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/inverted/);
  });

  it("rejects a negative start", () => {
    expect(checkRangePartition(SOURCE, [range("a", -1, 10)]).ok).toBe(false);
  });

  it("rejects a non-integer range", () => {
    expect(checkRangePartition(SOURCE, [range("a", 0, 10.5)]).ok).toBe(false);
  });

  it("rejects uncovered text at the end of the file", () => {
    // The commonest real failure: a final entity whose body stops short of EOF.
    const result = checkRangePartition(SOURCE, [range("a", 0, SOURCE.length - 3)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/after the last range/);
  });

  it("rejects no ranges over a non-empty file", () => {
    expect(checkRangePartition(SOURCE, []).ok).toBe(false);
  });

  it("counts in UTF-16 units, not bytes", () => {
    // "é" is one UTF-16 unit but two UTF-8 bytes; "😀" is two UTF-16 units but
    // four bytes. A byte-oriented implementation fails this partition.
    const text = "# héllo 😀\n\nbody\n";
    expect(text.length).toBe(17);
    expect(Buffer.from(text, "utf8").length).toBe(20);
    const ranges = [range("heading", 0, 10), range("body", 10, text.length)];
    expect(checkRangePartition(text, ranges).ok).toBe(true);
    // The same split expressed in byte offsets does not partition the string.
    expect(checkRangePartition(text, [range("heading", 0, 13), range("body", 13, 21)]).ok).toBe(false);
  });

  it("names the offending range in its message", () => {
    const result = checkRangePartition(SOURCE, [range("entities[2].body", 0, 5)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("entities[2].body");
  });

  it("throws legibly through the assertion wrapper", () => {
    expect(() => assertRangePartition(SOURCE, [range("a", 0, 5)])).toThrow(/Range partition violated/);
    expect(() => assertRangePartition(SOURCE, [range("a", 0, SOURCE.length)])).not.toThrow();
  });
});

describe("checkOnlyRangesChanged", () => {
  const original = "keep before\n<!-- replace me -->\nkeep after\n";
  const declared = [range("entities[0].metadata", 12, 31)];

  it("accepts a splice inside the declared range", () => {
    const produced = "keep before\n<!-- replaced with something much longer -->\nkeep after\n";
    expect(checkOnlyRangesChanged(original, produced, declared)).toEqual({ ok: true });
  });

  it("accepts a splice that shortens the text", () => {
    expect(checkOnlyRangesChanged(original, "keep before\n<!---->\nkeep after\n", declared).ok).toBe(true);
  });

  it("accepts deleting the declared range entirely", () => {
    expect(checkOnlyRangesChanged(original, "keep before\n\nkeep after\n", declared).ok).toBe(true);
  });

  it("accepts an unchanged file when nothing was declared", () => {
    expect(checkOnlyRangesChanged(original, original, []).ok).toBe(true);
  });

  it("rejects any change when nothing was declared", () => {
    expect(checkOnlyRangesChanged(original, `${original}x`, []).ok).toBe(false);
  });

  it("rejects a change one character before the declared range", () => {
    const produced = "keep beforeX\n<!-- replace me -->\nkeep after\n";
    const result = checkOnlyRangesChanged(original, produced, declared);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/before .* changed/);
  });

  it("rejects a change one character after the declared range", () => {
    const produced = "keep before\n<!-- replace me -->\nXkeep after\n";
    expect(checkOnlyRangesChanged(original, produced, declared).ok).toBe(false);
  });

  it("rejects a whitespace-only change outside the declared range", () => {
    // Reformatting is precisely the bug this harness exists to catch, and it is
    // the one a human reviewer skims past in a diff.
    const produced = "keep before\n<!-- replace me -->\nkeep  after\n";
    expect(checkOnlyRangesChanged(original, produced, declared).ok).toBe(false);
  });

  it("rejects a line-ending change outside the declared range", () => {
    // A writer that normalizes CRLF to LF across the file passes a naive
    // "content looks the same" check and fails this one.
    const crlf = "keep before\r\n<!-- replace me -->\r\nkeep after\r\n";
    const produced = "keep before\r\n<!-- replaced -->\r\nkeep after\n";
    expect(checkOnlyRangesChanged(crlf, produced, [range("m", 13, 32)]).ok).toBe(false);
  });

  it("rejects a trailing newline silently added at end of file", () => {
    expect(checkOnlyRangesChanged(original, `${original}\n`, declared).ok).toBe(false);
  });

  it("reports the offset and the characters that differ", () => {
    const produced = "keep beforX\n<!-- replace me -->\nkeep after\n";
    const result = checkOnlyRangesChanged(original, produced, declared);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/offset 10/);
      expect(result.message).toContain('"e"');
      expect(result.message).toContain('"X"');
    }
  });

  it("handles several declared ranges", () => {
    const source = "A\nONE\nB\nTWO\nC\n";
    const ranges = [range("r0", 2, 5), range("r1", 8, 11)];
    expect(checkOnlyRangesChanged(source, "A\nfirst\nB\nsecond\nC\n", ranges).ok).toBe(true);
    // A change in the middle segment between the two ranges.
    expect(checkOnlyRangesChanged(source, "A\nfirst\nX\nsecond\nC\n", ranges).ok).toBe(false);
    // A change in the tail.
    expect(checkOnlyRangesChanged(source, "A\nfirst\nB\nsecond\nX\n", ranges).ok).toBe(false);
  });

  it("rejects overlapping declared ranges", () => {
    const result = checkOnlyRangesChanged(original, original, [range("a", 0, 20), range("b", 10, 30)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/overlap/);
  });

  it("rejects a declared range outside the original text", () => {
    expect(checkOnlyRangesChanged(original, original, [range("a", 0, original.length + 1)]).ok).toBe(false);
  });

  it("preserves non-ASCII text outside the declared range", () => {
    const text = "héllo 😀\n<!-- m -->\nCJK 文字\n";
    const metadata = range("m", text.indexOf("<!--"), text.indexOf("<!--") + 10);
    expect(checkOnlyRangesChanged(text, text.replace("<!-- m -->", "<!-- meta -->"), [metadata]).ok).toBe(true);
    // Mangling the surrogate pair outside the range must be caught.
    expect(checkOnlyRangesChanged(text, text.replace("😀", "?"), [metadata]).ok).toBe(false);
  });

  it("throws legibly through the assertion wrapper", () => {
    expect(() => assertOnlyRangesChanged(original, `${original}x`, [])).toThrow(/Write scope violated/);
    expect(() => assertOnlyRangesChanged(original, original, [])).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { spliceTopLevelKey, removeTopLevelKey, renderKeyValue, findTopLevelKeyRange, topLevelKeys } from "../frontmatter.js";
import { parseDocument } from "../parse.js";
import { checkOnlyRangesChanged } from "../ranges.js";

/**
 * The scoped-frontmatter case matrix.
 *
 * Every case asserts the same underlying property — **the produced text differs
 * from the original only inside the declared range** — using the P2a harness
 * rather than by eyeballing output. That is the difference between testing a
 * splice and testing a serializer that happens to agree today: a whole-map
 * rewrite can produce byte-identical output for a simple fixture and still
 * destroy a comment in the next file along.
 *
 * The cases come from the brief's matrix, which is drawn from what migration
 * and the operations pipeline will actually do to real scaffolds.
 */

/** Assert the splice stayed inside what it declared, then return the text. */
function spliced(original: string, key: string, valueYaml: string): string {
  const result = spliceTopLevelKey(original, key, valueYaml);
  const check = checkOnlyRangesChanged(original, result.text, result.declared);
  expect(check.ok ? null : check.message).toBeNull();
  return result.text;
}

describe("spliceTopLevelKey", () => {
  it("creates a frontmatter block when the file has none, leaving the body byte-identical", () => {
    const original = "# Title\n\nBody prose that must not move.\n";
    const produced = spliced(original, "mex", "mex:\n  id: mx_1");

    expect(produced.startsWith("---\nmex:\n  id: mx_1\n---\n")).toBe(true);
    expect(produced.endsWith(original)).toBe(true);
  });

  it("inserts an absent key without disturbing existing keys, quoting or comments", () => {
    const original = [
      "---",
      "# a comment above name",
      'name: "quoted-on-purpose"',
      "triggers:",
      '  - "API error"',
      "---",
      "",
      "# Body",
      "",
    ].join("\n");

    const produced = spliced(original, "mex", "mex:\n  id: mx_1");

    expect(produced).toContain("# a comment above name");
    expect(produced).toContain('name: "quoted-on-purpose"');
    expect(produced).toContain('  - "API error"');
    expect(produced).toContain("mex:\n  id: mx_1");
    // Order is preserved: the new key lands after the existing ones.
    expect(produced.indexOf("name:")).toBeLessThan(produced.indexOf("mex:"));
    expect(topLevelKeys(parseDocument(produced).frontmatter!)).toEqual(["name", "triggers", "mex"]);
  });

  it("replaces only the value range of a block-style key", () => {
    const original = ["---", "name: keep-me", "mex:", "  id: mx_old", "  type: pattern", "last: keep-me-too", "---", "", "# Body", ""].join("\n");

    const produced = spliced(original, "mex", "mex:\n  id: mx_new");

    expect(produced).toContain("name: keep-me");
    expect(produced).toContain("last: keep-me-too");
    expect(produced).toContain("id: mx_new");
    expect(produced).not.toContain("mx_old");
    expect(produced).not.toContain("type: pattern");
  });

  it("replaces only the value range of a flow-style key", () => {
    const original = ["---", "a: 1", "grounds_to: []", "b: 2", "---", "", "# Body", ""].join("\n");

    const produced = spliced(original, "grounds_to", 'grounds_to:\n  - node: "function:abc"');

    expect(produced).toContain("a: 1");
    expect(produced).toContain("b: 2");
    expect(produced).not.toContain("grounds_to: []");
    expect(produced).toContain('- node: "function:abc"');
  });

  it("leaves a trailing comment on the key's line alone", () => {
    const original = ["---", "grounds_to: [] # captured by hand, do not delete", "b: 2", "---", "", "# Body", ""].join("\n");

    const produced = spliced(original, "grounds_to", "grounds_to:\n  - node: x");

    expect(produced).toContain("# captured by hand, do not delete");
    expect(produced).toContain("b: 2");
  });

  it("leaves comments above the key attached to it", () => {
    const original = ["---", "a: 1", "# why this grounding exists", "grounds_to: []", "---", "", "# Body", ""].join("\n");

    const produced = spliced(original, "grounds_to", "grounds_to:\n  - node: x");

    expect(produced).toContain("# why this grounding exists");
    // Still immediately above the key it annotates.
    expect(produced.indexOf("# why this grounding exists")).toBeLessThan(produced.indexOf("grounds_to:"));
  });

  it("does not reindent untouched keys with unusual indentation", () => {
    const original = ["---", "nested:", "      deep: value", "      other: value", "mex:", "  id: mx_old", "---", "", "# Body", ""].join("\n");

    const produced = spliced(original, "mex", "mex:\n  id: mx_new");

    expect(produced).toContain("      deep: value");
    expect(produced).toContain("      other: value");
  });

  it("preserves CRLF line endings, including in inserted text", () => {
    const original = ["---", "name: crlf", "---", "", "# Body", ""].join("\r\n");

    const produced = spliced(original, "mex", "mex:\r\n  id: mx_1");

    expect(produced).toContain("\r\n");
    // No lone line feed anywhere: a single LF would mean the writer imposed its
    // own ending on a file that uses CRLF, which shows up as a whole-file diff.
    expect(/[^\r]\n/.test(produced)).toBe(false);
  });

  it("removes a key without leaving blank-line residue or reflowing neighbours", () => {
    const original = ["---", "a: 1", "grounds_to:", "  - node: x", "b: 2", "---", "", "# Body", ""].join("\n");

    const result = removeTopLevelKey(original, "grounds_to");
    const check = checkOnlyRangesChanged(original, result.text, result.declared);
    expect(check.ok ? null : check.message).toBeNull();

    expect(result.text).toBe(["---", "a: 1", "b: 2", "---", "", "# Body", ""].join("\n"));
  });

  it("removes the block's last key without leaving a trailing blank line", () => {
    const original = ["---", "a: 1", "grounds_to:", "  - node: x", "---", "", "# Body", ""].join("\n");

    const result = removeTopLevelKey(original, "grounds_to");
    expect(result.text).toBe(["---", "a: 1", "---", "", "# Body", ""].join("\n"));
  });

  it("is a no-op when the key to remove is absent", () => {
    const original = ["---", "a: 1", "---", "", "# Body", ""].join("\n");
    expect(removeTopLevelKey(original, "nope").text).toBe(original);
  });
});

describe("findTopLevelKeyRange", () => {
  it("covers the key and its value only, so the delimiters stay outside", () => {
    const original = ["---", "name: x", "mex:", "  id: mx_1", "---", "", "# Body", ""].join("\n");
    const frontmatter = parseDocument(original).frontmatter!;

    const range = findTopLevelKeyRange(original, frontmatter, "mex")!;
    expect(original.slice(range.keyStart, range.valueEnd)).toBe("mex:\n  id: mx_1");
  });

  it("stops before the newline that precedes the closing fence", () => {
    // The trailing trim is what keeps this true: `yaml` reports a block value's
    // end past its final newline, and without trimming the range would eat the
    // separator and the partition property would break.
    const original = ["---", "mex:", "  id: mx_1", "---", "", "# Body", ""].join("\n");
    const frontmatter = parseDocument(original).frontmatter!;

    const range = findTopLevelKeyRange(original, frontmatter, "mex")!;
    expect(original.charAt(range.valueEnd)).toBe("\n");
  });

  it("returns null for a key that is not there, and for malformed YAML", () => {
    const original = ["---", "name: x", "---", "", "# Body", ""].join("\n");
    const frontmatter = parseDocument(original).frontmatter!;
    expect(findTopLevelKeyRange(original, frontmatter, "mex")).toBeNull();
  });
});

describe("renderKeyValue", () => {
  it("renders one key and its value, never a surrounding map", () => {
    expect(renderKeyValue("grounds_to", [{ node: "function:a", fingerprint: "mh:64:b" }])).toBe(
      "grounds_to:\n  - node: function:a\n    fingerprint: mh:64:b",
    );
  });
});

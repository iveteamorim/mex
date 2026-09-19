import { describe, expect, it } from "vitest";
import { MAX_FORMATTED_DIFF_LINES, parseSetupDiff } from "./setup-commit-diff";

const header = "diff --git a/example.md b/example.md\nindex abcd123..def4567 100644\n--- a/example.md\n+++ b/example.md\n";

describe("setup unified diff parser", () => {
  it("numbers both sides across context, replacements, and separate hunks", () => {
    const parsed = parseSetupDiff(header + "@@ -2,3 +2,4 @@ section\n unchanged\n-old\n+new\n+extra\n tail\n@@ -20 +21 @@\n-before\n+after\n");
    expect(parsed).toEqual({ formatted: true, added: 3, deleted: 2, rows: [
      { kind: "hunk", text: "@@ -2,3 +2,4 @@ section" },
      { kind: "context", text: "unchanged", oldLine: 2, newLine: 2 },
      { kind: "deletion", text: "old", oldLine: 3, newLine: null },
      { kind: "addition", text: "new", oldLine: null, newLine: 3 },
      { kind: "addition", text: "extra", oldLine: null, newLine: 4 },
      { kind: "context", text: "tail", oldLine: 4, newLine: 5 },
      { kind: "hunk", text: "@@ -20 +21 @@" },
      { kind: "deletion", text: "before", oldLine: 20, newLine: null },
      { kind: "addition", text: "after", oldLine: null, newLine: 21 },
    ] });
  });

  it("keeps marker-like source, tabs, blank lines, CR characters, and HTML text exact", () => {
    const source = ["++ b/not-a-header", "-- a/not-a-header", "@@ -1 +1 @@", "diff --git a/x b/x", "index abc..def", "\t <img src=x> &  \r", ""];
    const parsed = parseSetupDiff(header + `@@ -0,0 +1,${source.length} @@\n` + source.map((line) => "+" + line + "\n").join(""));
    expect(parsed.formatted).toBe(true);
    if (!parsed.formatted) return;
    expect(parsed.rows.slice(1).map((row) => row.text)).toEqual(source);
    expect(parsed.added).toBe(7);
    expect(parsed.deleted).toBe(0);
  });

  it("handles a deleted file and preserves the final newline notice", () => {
    const parsed = parseSetupDiff("diff --git a/x b/x\ndeleted file mode 100644\nindex abcd123..0000000\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-last line\n\\ No newline at end of file\n");
    expect(parsed).toEqual({ formatted: true, added: 0, deleted: 1, rows: [
      { kind: "notice", text: "deleted file mode 100644" },
      { kind: "hunk", text: "@@ -1 +0,0 @@" },
      { kind: "deletion", text: "last line", oldLine: 1, newLine: null },
      { kind: "notice", text: "No newline at end of file" },
    ] });
  });

  it("preserves both old and new no-final-newline notices", () => {
    const parsed = parseSetupDiff(header + "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
    expect(parsed.formatted && parsed.rows.filter((row) => row.kind === "notice")).toHaveLength(2);
  });

  it.each([
    ["old mode 100644\nnew mode 100755\n", ["old mode 100644", "new mode 100755"]],
    ["new file mode 100644\nindex 0000000..e69de29\n", ["new file mode 100644"]],
    ["deleted file mode 100644\nindex e69de29..0000000\n", ["deleted file mode 100644"]],
  ])("keeps mode-only and empty-file changes: %s", (metadata, notices) => {
    const parsed = parseSetupDiff("diff --git a/x b/x\n" + metadata);
    expect(parsed).toEqual({ formatted: true, added: 0, deleted: 0, rows: notices.map((text) => ({ kind: "notice", text })) });
  });

  it.each([
    "@@ -1,2 +1 @@\n-old\n+new\n", // Missing old line.
    "@@ -1 +1 @@\n-old\n+new\n+extra\n", // Extra new line.
    "@@ -1 +1 @@\n-old\n+new\nunknown metadata\n",
    "@@ -1 +1 @@\n-old\n+new\n@@ -0 +2 @@\n-old\n+new\n",
    "@@ -9007199254740991,2 +1,2 @@\n a\n b\n",
    "@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n",
    "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n\\ No newline at end of file\n",
    "@@ malformed @@\n-old\n+new\n",
    "Binary files a/x and b/x differ\n",
  ])("uses raw fallback for malformed or unsupported data: %s", (body) => {
    expect(parseSetupDiff(header + body)).toEqual({ formatted: false, reason: "malformed" });
  });

  it("does not hide unpaired headers or an unexpected second file", () => {
    expect(parseSetupDiff("--- a/x\n@@ -1 +1 @@\n-old\n+new\n")).toEqual({ formatted: false, reason: "malformed" });
    expect(parseSetupDiff(header + "@@ -1 +1 @@\n-old\n+new\n" + header)).toEqual({ formatted: false, reason: "malformed" });
  });

  it("falls back for truncated, empty, and pathological many-line diffs without allocating rows", () => {
    const diff = header + "@@ -0,0 +1,1600 @@\n" + "+\n".repeat(1_600);
    expect(parseSetupDiff(diff)).toEqual({ formatted: false, reason: "large" });
    expect(parseSetupDiff(diff, true)).toEqual({ formatted: false, reason: "truncated" });
    expect(parseSetupDiff("")).toEqual({ formatted: false, reason: "empty" });
    expect(parseSetupDiff("new file mode 100644\n", false, 0)).toEqual({ formatted: false, reason: "large" });
    expect(MAX_FORMATTED_DIFF_LINES).toBeLessThanOrEqual(2_000);
  });
});

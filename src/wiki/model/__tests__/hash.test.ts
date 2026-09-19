import { describe, it, expect } from "vitest";
import {
  CONTENT_HASH_PATTERN,
  entityContentHash,
  exactFileContentHash,
  fileContentHash,
  indexedCorpusRevision,
  isContentHash,
  normalizeForHashing,
} from "../hash.js";

describe("normalizeForHashing", () => {
  it("normalizes CRLF to LF and leaves everything else alone", () => {
    expect(normalizeForHashing("a\r\nb")).toBe("a\nb");
    expect(normalizeForHashing("a\nb")).toBe("a\nb");
    // A lone CR is not a line ending we rewrite; only the CRLF pair.
    expect(normalizeForHashing("a\rb")).toBe("a\rb");
  });

  it("does not touch other whitespace", () => {
    expect(normalizeForHashing("  a \t b  ")).toBe("  a \t b  ");
  });
});

describe("content hashes", () => {
  it("produce lowercase 64-character hex", () => {
    expect(entityContentHash("x")).toMatch(CONTENT_HASH_PATTERN);
    expect(fileContentHash("x")).toMatch(CONTENT_HASH_PATTERN);
  });

  it("are deterministic", () => {
    expect(entityContentHash("same text")).toBe(entityContentHash("same text"));
  });

  it("agree across CRLF and LF checkouts of one file", () => {
    // A precondition minted on Windows must be accepted on Linux; without this
    // every cross-platform operation would be rejected as stale.
    expect(entityContentHash("## Heading\r\n\r\nBody.\r\n")).toBe(entityContentHash("## Heading\n\nBody.\n"));
    expect(fileContentHash("---\r\na: 1\r\n---\r\n")).toBe(fileContentHash("---\na: 1\n---\n"));
  });

  it("change when the text changes", () => {
    expect(entityContentHash("before")).not.toBe(entityContentHash("after"));
    // Including whitespace changes, which are real edits to Markdown.
    expect(entityContentHash("a b")).not.toBe(entityContentHash("a  b"));
  });

  it("handle non-ASCII text", () => {
    // Model text is not ASCII in practice, and the hash must be over the
    // decoded characters, not whatever a byte-oriented reading would produce.
    expect(entityContentHash("naïve — “quoted” 🎯")).toMatch(CONTENT_HASH_PATTERN);
    expect(entityContentHash("naïve")).not.toBe(entityContentHash("naive"));
  });

  it("are the same function over different scopes, kept apart by name", () => {
    // Deliberate: they must be interchangeable in mechanism but never in role.
    // The names are what stop a file hash being used as a precondition.
    expect(entityContentHash("text")).toBe(fileContentHash("text"));
  });

  it("keeps exact containing-file hashes distinct from semantic hashes", () => {
    expect(exactFileContentHash("a\r\nb\r\n")).not.toBe(exactFileContentHash("a\nb\n"));
    expect(exactFileContentHash("\ufeffa\n")).not.toBe(exactFileContentHash("a\n"));
    expect(entityContentHash("a\r\nb\r\n")).toBe(entityContentHash("a\nb\n"));
  });

  it("derives corpus revisions from sorted paths and exact hashes", () => {
    const a = exactFileContentHash("a\n");
    const b = exactFileContentHash("b\n");
    expect(indexedCorpusRevision([
      { path: "z.md", contentHash: b },
      { path: "a.md", contentHash: a },
    ])).toBe(indexedCorpusRevision([
      { path: "a.md", contentHash: a },
      { path: "z.md", contentHash: b },
    ]));
    expect(indexedCorpusRevision([{ path: "a.md", contentHash: a }]))
      .not.toBe(indexedCorpusRevision([{ path: "a.md", contentHash: b }]));
  });
});

describe("isContentHash", () => {
  it("accepts a produced hash", () => {
    expect(isContentHash(entityContentHash("x"))).toBe(true);
  });

  it("rejects the wrong length, uppercase, or a non-string", () => {
    expect(isContentHash("abc")).toBe(false);
    expect(isContentHash(entityContentHash("x").toUpperCase())).toBe(false);
    expect(isContentHash(null)).toBe(false);
    expect(isContentHash(`${entityContentHash("x")}0`)).toBe(false);
  });
});

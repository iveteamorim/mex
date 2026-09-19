/**
 * Scoped metadata writes for **both** entity dialects.
 *
 * Brief 6 §3.3 named this the largest known gap in itself, and it was right:
 * `frontmatter.ts` could locate a key inside a frontmatter block, `parse.ts`
 * exposed a `<!-- mex:entity -->` comment's YAML only as an opaque blob, and
 * `codec.ts` threw its ranges away. So roughly half the entities in a scaffold
 * — every block-level one — had no scoped writer at all, and the only way to
 * change a field was to re-render the whole comment map, losing key order and
 * any comment inside it.
 *
 * The fix is one implementation over an arbitrary `YamlRegion` at an arbitrary
 * key path. What these tests pin is that the two dialects reach the **same**
 * guarantee: the produced text differs only inside the declared range, and
 * every other key, the key order, and any inline YAML comment survive byte for
 * byte.
 */

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseDocument, commentYamlRegion, extractCommentYaml, type YamlRegion } from "../parse.js";
import { findKeyPathRange, findMapInsertion, removeKeyPath, spliceKeyPath } from "../frontmatter.js";
import { checkOnlyRangesChanged } from "../ranges.js";
import { parseWikiMarkdown } from "../codec.js";

const ID = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const OTHER = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";

/** A file whose entity is block-level: metadata in an HTML comment. */
const BLOCK = `# Architecture

Prose above, which must not move.

<!-- mex:entity
id: ${ID}
type: component
# why this component is promoted rather than proposed
status: promoted
revision: 1
topics: [${OTHER}]
-->
## Gateway

Terminates TLS.

More prose below, which must not move either.
`;

/** A file whose entity is file-level: metadata nested under frontmatter \`mex:\`. */
const FILE_LEVEL = `---
name: api-error-pattern
description: Standard API error handling
mex:
  id: ${ID}
  type: pattern
  # the status was argued about; keep the note
  status: promoted
  revision: 1
last_updated: 2026-08-22
---

# API error handling

Every handler returns a problem document.
`;

/** The region holding a block entity's metadata, located from the parse. */
function blockRegion(text: string): YamlRegion {
  const block = parseDocument(text).htmlBlocks.find((entry) => entry.isEntityMarker);
  if (block === undefined) throw new Error("fixture has no entity marker");
  return block;
}

/** The region holding a file entity's frontmatter. */
function frontmatterRegion(text: string): YamlRegion {
  const frontmatter = parseDocument(text).frontmatter;
  if (frontmatter === null) throw new Error("fixture has no frontmatter");
  return frontmatter;
}

/** Splice, then assert the change is confined to its own declared ranges. */
function scopedSplice(text: string, region: YamlRegion, path: string[], value: unknown): string {
  const result = spliceKeyPath(text, region, path, value);
  expect(result, `no splice produced for ${path.join(".")}`).not.toBeNull();
  const check = checkOnlyRangesChanged(text, result!.text, result!.declared);
  expect(check.ok ? "" : check.message).toBe("");
  return result!.text;
}

describe("locating a block entity's YAML", () => {
  it("agrees with the string-only extractor it replaces", () => {
    // `extractCommentYaml` performs the same two steps without coordinates.
    // Asserting the two agree is what makes the offsets trustworthy: if they
    // ever disagree, a splice bounded by the offsets would write into text the
    // reader never parsed.
    const document = parseDocument(BLOCK);
    const block = document.htmlBlocks.find((entry) => entry.isEntityMarker)!;
    const raw = BLOCK.slice(block.start, block.end);
    expect(block.text).toBe(extractCommentYaml(raw));
    // And the offsets really do address that text in the file.
    expect(BLOCK.slice(block.innerStart, block.innerEnd)).toBe(block.text);
    // Vacuity guard: the region is not empty, so the equality above is not two
    // empty strings compared.
    expect(block.text).toContain("id:");
    expect(block.innerEnd).toBeGreaterThan(block.innerStart);
  });

  it("survives CRLF, where the marker line is one unit longer", () => {
    const crlf = BLOCK.replace(/\n/g, "\r\n");
    const region = blockRegion(crlf);
    expect(crlf.slice(region.innerStart, region.innerEnd)).toBe(region.text);
    expect(region.text.startsWith("id:")).toBe(true);
  });

  it("finds a key at the top of a comment region and one nested under mex:", () => {
    const block = findKeyPathRange(BLOCK, blockRegion(BLOCK), ["status"]);
    expect(BLOCK.slice(block!.keyStart, block!.valueEnd)).toBe("status: promoted");

    const nested = findKeyPathRange(FILE_LEVEL, frontmatterRegion(FILE_LEVEL), ["mex", "status"]);
    expect(FILE_LEVEL.slice(nested!.keyStart, nested!.valueEnd)).toBe("status: promoted");
  });

  it("measures indentation from the map rather than assuming it", () => {
    expect(findMapInsertion(BLOCK, blockRegion(BLOCK), [])!.indent).toBe("");
    expect(findMapInsertion(FILE_LEVEL, frontmatterRegion(FILE_LEVEL), ["mex"])!.indent).toBe("  ");
    // A four-space scaffold gets four-space writes, not two.
    const wide = FILE_LEVEL.replace(/^ {2}(?=\S|#)/gm, "    ");
    expect(findMapInsertion(wide, frontmatterRegion(wide), ["mex"])!.indent).toBe("    ");
  });
});

describe("a block entity's metadata is written scoped", () => {
  it("replaces one key and leaves every other byte alone", () => {
    const produced = scopedSplice(BLOCK, blockRegion(BLOCK), ["status"], "deprecated");

    expect(produced).toContain("status: deprecated");
    // Key order, the inline YAML comment, and the prose on both sides.
    expect(produced).toContain("# why this component is promoted rather than proposed");
    const keys = [...produced.matchAll(/^(\w+):/gm)].map((match) => match[1]);
    expect(keys).toEqual(["id", "type", "status", "revision", "topics"]);
    expect(produced).toContain("Prose above, which must not move.");
    expect(produced).toContain("More prose below, which must not move either.");
    // The only difference anywhere in the file is the one word.
    expect(produced.replace("status: deprecated", "status: promoted")).toBe(BLOCK);
  });

  it("appends a key the comment did not have, inside the comment", () => {
    const produced = scopedSplice(BLOCK, blockRegion(BLOCK), ["summary"], "Routes by path prefix.");
    const region = blockRegion(produced);
    // Inside the comment, not after it: the new key is within the region the
    // *re-parse* reports, which is the check that catches an insert landing
    // past the closing `-->`.
    const summaryAt = produced.indexOf("summary:");
    expect(summaryAt).toBeGreaterThan(region.innerStart - 1);
    expect(summaryAt).toBeLessThan(region.innerEnd);
    expect(YAML.parse(region.text)["summary"]).toBe("Routes by path prefix.");
    // Still one entity, still the same id, and the codec still reads it.
    const parsed = parseWikiMarkdown({ path: "block.md", text: produced });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0]!.entity.summary).toBe("Routes by path prefix.");
  });

  it("writes a structured value without disturbing its neighbours", () => {
    const produced = scopedSplice(BLOCK, blockRegion(BLOCK), ["relations"], [
      { type: "depends_on", target: OTHER },
    ]);
    const parsed = parseWikiMarkdown({ path: "block.md", text: produced });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities[0]!.entity.relations).toEqual([{ type: "depends_on", target: OTHER }]);
    expect(parsed.entities[0]!.entity.topics).toEqual([OTHER]);
    expect(produced).toContain("# why this component is promoted rather than proposed");
  });

  it("removes a key without leaving a blank line behind", () => {
    const result = removeKeyPath(BLOCK, blockRegion(BLOCK), ["topics"]);
    expect(result).not.toBeNull();
    expect(checkOnlyRangesChanged(BLOCK, result!.text, result!.declared).ok).toBe(true);
    expect(result!.text).not.toContain("topics:");
    expect(result!.text).toContain(`revision: 1\n-->`);
  });

  it("keeps CRLF line endings when it writes into a CRLF file", () => {
    const crlf = BLOCK.replace(/\n/g, "\r\n");
    const produced = scopedSplice(crlf, blockRegion(crlf), ["summary"], "Routes by path prefix.");
    expect(produced).not.toMatch(/[^\r]\n/);
    expect(produced.split("\r\n").length).toBe(crlf.split("\r\n").length + 1);
  });
});

describe("a file-level entity's metadata is written the same way", () => {
  it("replaces a nested key at the map's own indentation", () => {
    const produced = scopedSplice(FILE_LEVEL, frontmatterRegion(FILE_LEVEL), ["mex", "status"], "deprecated");
    expect(produced).toContain("  status: deprecated");
    expect(produced.replace("  status: deprecated", "  status: promoted")).toBe(FILE_LEVEL);
    // The sibling frontmatter keys are outside `mex:` entirely and must be
    // untouched — including the one *after* it, which a whole-map rewrite
    // reorders.
    const keys = [...produced.matchAll(/^(\w+):/gm)].map((match) => match[1]);
    expect(keys).toEqual(["name", "description", "mex", "last_updated"]);
  });

  it("appends a nested key indented into mex:, not at the root", () => {
    const produced = scopedSplice(FILE_LEVEL, frontmatterRegion(FILE_LEVEL), ["mex", "summary"], "One error shape.");
    expect(produced).toContain("  summary: One error shape.");
    const parsed = parseWikiMarkdown({ path: "file.md", text: produced });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities[0]!.entity.summary).toBe("One error shape.");
    // Still exactly one root key list, so the append did not escape `mex:`.
    const root = YAML.parse(frontmatterRegion(produced).text) as Record<string, unknown>;
    expect(Object.keys(root)).toEqual(["name", "description", "mex", "last_updated"]);
    expect(produced).toContain("# the status was argued about; keep the note");
  });

  it("indents every line of a multi-line value", () => {
    const produced = scopedSplice(FILE_LEVEL, frontmatterRegion(FILE_LEVEL), ["mex", "relations"], [
      { type: "depends_on", target: OTHER },
    ]);
    const parsed = parseWikiMarkdown({ path: "file.md", text: produced });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities[0]!.entity.relations).toEqual([{ type: "depends_on", target: OTHER }]);
    // Every rendered line sits inside `mex:`; a line at column 0 would have
    // become a sibling root key that still parses as valid YAML.
    for (const line of produced.split("\n").filter((entry) => /^\s*(- )?type: depends_on/.test(entry))) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });
});

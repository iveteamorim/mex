import { describe, it, expect } from "vitest";
import { applyEdits, deleteRange, insertAt, replaceRange, WriteScopeError } from "../patch.js";
import { associateAnchors, rewriteAnchor } from "../anchors.js";
import { parseWikiMarkdown } from "../codec.js";
import { parseDocument } from "../parse.js";
import {
  createPositionMap,
  findConflictRegions,
  lineAt,
  lineStarts,
  terminatorLengthAt,
} from "../positions.js";

describe("patch primitives", () => {
  const original = "---\nname: keep\n---\n\n# Title\n\nBody.\n";

  it("replaces a range and leaves everything else identical", () => {
    const start = original.indexOf("keep");
    const result = replaceRange(original, start, start + 4, "changed");
    expect(result.text).toBe(original.replace("keep", "changed"));
    expect(result.declared).toEqual([{ label: "replace", start, end: start + 4 }]);
  });

  it("inserts without disturbing a byte on either side", () => {
    const at = original.indexOf("# Title");
    const result = insertAt(original, at, "## Extra\n\n");
    expect(result.text.startsWith(original.slice(0, at))).toBe(true);
    expect(result.text.endsWith(original.slice(at))).toBe(true);
  });

  it("deletes a range", () => {
    const start = original.indexOf("Body.");
    expect(deleteRange(original, start, start + 5).text).toBe(original.replace("Body.", ""));
  });

  it("applies several disjoint edits in one pass", () => {
    const result = applyEdits(original, [
      { start: 4, end: 8, text: "title", label: "a" },
      { start: original.indexOf("Body."), end: original.indexOf("Body.") + 5, text: "Prose.", label: "b" },
    ]);
    expect(result.text).toContain("title: keep");
    expect(result.text).toContain("Prose.");
  });

  it("refuses overlapping, inverted and out-of-bounds edits", () => {
    expect(() =>
      applyEdits(original, [
        { start: 0, end: 10, text: "x", label: "a" },
        { start: 5, end: 12, text: "y", label: "b" },
      ]),
    ).toThrow(WriteScopeError);
    expect(() => replaceRange(original, 8, 4, "x")).toThrow(/inverted/);
    expect(() => replaceRange(original, 0, original.length + 1, "x")).toThrow(/outside the text/);
  });
});

describe("positions", () => {
  it("shifts every offset by one for a BOM file, and by none otherwise", () => {
    // remark strips a leading BOM before parsing, so its offsets index a string
    // one unit shorter than the one the caller passed in. Correcting it here is
    // the only reason the BOM fixture's expectations can be met without
    // rewriting the text the offsets are supposed to address.
    expect(createPositionMap("﻿# Title\n").shift).toBe(1);
    expect(createPositionMap("# Title\n").shift).toBe(0);
  });

  it("measures line terminators", () => {
    expect(terminatorLengthAt("a\r\nb", 1)).toBe(2);
    expect(terminatorLengthAt("a\nb", 1)).toBe(1);
    expect(terminatorLengthAt("ab", 1)).toBe(0);
    expect(terminatorLengthAt("ab", 2)).toBe(0);
  });

  it("maps offsets to 1-based lines across mixed endings", () => {
    const text = "one\r\ntwo\nthree";
    const starts = lineStarts(text);
    expect(lineAt(starts, 0)).toBe(1);
    expect(lineAt(starts, text.indexOf("two"))).toBe(2);
    expect(lineAt(starts, text.indexOf("three"))).toBe(3);
  });

  it("finds conflict regions, including an unterminated one", () => {
    const text = "a\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> branch\nb\n";
    const [region] = findConflictRegions(text);
    expect(text.slice(region!.start, region!.end)).toContain(">>>>>>> branch");
    expect(findConflictRegions("<<<<<<< HEAD\nmine\n")).toHaveLength(1);
    expect(findConflictRegions("no markers here\n")).toEqual([]);
  });

  it("keeps a conflict marker from truncating an entity body", () => {
    // `=======` is a valid setext underline, so without suppression the region
    // below parses as a depth-1 heading and ends the depth-2 entity early.
    const text =
      `<!-- mex:entity\nid: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\ntype: decision\nstatus: promoted\n-->\n` +
      `## Survived\n\n<<<<<<< HEAD\nfifteen minutes\n=======\nan hour\n>>>>>>> other\n\nTail prose.\n`;

    const file = parseWikiMarkdown({ path: "conflict.md", text });
    expect(file.entities).toHaveLength(1);
    expect(file.entities[0]!.entity.location.bodyEnd).toBe(text.length);
    expect(file.entities[0]!.entity.body).toContain("Tail prose.");
    expect(file.diagnostics).toEqual([]);
  });
});

describe("anchors", () => {
  const text =
    `Outside prose with [a link](mex://function:outside).\n\n` +
    `<!-- mex:entity\nid: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\ntype: decision\nstatus: promoted\n-->\n` +
    `## Rotation\n\nInside prose with [another](mex://function:inside).\n`;

  it("attaches an anchor to its containing entity and leaves the rest unattached", () => {
    const file = parseWikiMarkdown({ path: "anchors.md", text });
    expect(file.anchors.map((anchor) => [anchor.nodeId, anchor.entityId])).toEqual([
      ["function:outside", null],
      ["function:inside", "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD"],
    ]);
  });

  it("does not credit an outside anchor to the nearest entity", () => {
    const owners = [{ id: "mx_x" as never, bodyStart: 100, bodyEnd: 200 }];
    const links = parseDocument(text).links.map((link) => ({ ...link, start: 0, end: 5 }));
    expect(associateAnchors(links, owners).every((anchor) => anchor.entityId === null)).toBe(true);
  });

  it("rewrites a node id while preserving the visible link text", () => {
    const file = parseWikiMarkdown({ path: "anchors.md", text });
    const anchor = file.anchors[1]!;
    const result = rewriteAnchor(text, anchor, "function:moved");

    expect(result.text).toContain("[another](mex://function:moved)");
    expect(result.text).toContain("[a link](mex://function:outside)");
    expect(result.text.length).toBe(text.length + "moved".length - "inside".length);
  });

  it("refuses an empty node id and a stale anchor", () => {
    const file = parseWikiMarkdown({ path: "anchors.md", text });
    expect(() => rewriteAnchor(text, file.anchors[1]!, "")).toThrow(/Invalid mex anchor/);
    expect(() => rewriteAnchor(text, { ...file.anchors[1]!, nodeId: "function:gone" }, "x")).toThrow(
      /no longer matches/,
    );
  });
});

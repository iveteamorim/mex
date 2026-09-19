/**
 * Scoped frontmatter writes: locate one top-level YAML key's own range and
 * splice only that.
 *
 * This replaces the whole-map rewrite that shipped in `src/markdown.ts`, which
 * ran the parsed frontmatter back through `YAML.stringify` and so lost comment
 * placement, quoting style and key order on every grounding write. Losing a
 * contributor's comments because MEX recorded a code fingerprint is not a
 * cosmetic problem — it makes the diff unreviewable, which is the one thing the
 * Markdown-canonical design exists to protect.
 *
 * Ranges come from `YAML.parseDocument`, whose nodes carry `.range` as
 * `[start, valueEnd, nodeEnd]` into the parsed string. Hand-rolled scanning
 * loses to block scalars, flow collections, anchors and comments; the parser
 * already knows where everything is.
 *
 * This module and `patch.ts` are the only files permitted to render YAML, and
 * even here it is rendering **one key's value**, never a whole map.
 */

import YAML from "yaml";
import { applyEdits, type PatchEdit, type PatchResult } from "./patch.js";
import { parseDocument, type RawFrontmatter, type YamlRegion } from "./parse.js";
import { terminatorLengthAt } from "./positions.js";

/** Absolute range of a top-level key and its value, in file offsets. */
export interface KeyRange {
  /** Start of the key token. */
  keyStart: number;
  /** End of the value, with trailing line terminators trimmed off. */
  valueEnd: number;
  /** End including the terminator that closes the key's last line. */
  nodeEnd: number;
}

function trimTrailingBlank(text: string, end: number, floor: number): number {
  let cursor = end;
  while (cursor > floor && /[ \t\r\n]/.test(text.charAt(cursor - 1))) cursor -= 1;
  return cursor;
}

/**
 * Locate a top-level key inside an already-located frontmatter block.
 *
 * The trailing trim matters and is not cosmetic. For a *block* value `yaml`
 * reports `valueEnd` past the closing newline, while for a scalar it stops
 * before it. Left alone, a `mex:` range would swallow the newline separating it
 * from the closing `---`, and the contract's convention — the metadata range
 * covers the key and its value, delimiters are gaps — would quietly break, as
 * would the partition property that depends on it.
 */
export function findTopLevelKeyRange(text: string, frontmatter: RawFrontmatter, key: string): KeyRange | null {
  return findKeyPathRange(text, frontmatter, [key]);
}

/** Parse a region's YAML, returning null rather than throwing. */
function regionDocument(region: YamlRegion): YAML.Document.Parsed | null {
  try {
    return YAML.parseDocument(region.text);
  } catch {
    return null;
  }
}

/** Walk `path` through nested maps, returning the pair the last segment names. */
function pairAt(region: YamlRegion, path: readonly string[]): YAML.Pair<unknown, unknown> | null {
  const document = regionDocument(region);
  if (document === null) return null;

  let node: unknown = document.contents;
  let pair: YAML.Pair<unknown, unknown> | null = null;
  for (const key of path) {
    if (!YAML.isMap(node)) return null;
    const found = node.items.find((item) => YAML.isScalar(item.key) && item.key.value === key);
    if (found === undefined) return null;
    pair = found as YAML.Pair<unknown, unknown>;
    node = found.value;
  }
  return pair;
}

/**
 * Locate a key at an arbitrary depth inside an arbitrary YAML region.
 *
 * The generalization the write side needs and the read side never did. A
 * **file-level** entity keeps its metadata nested one level down, under the
 * frontmatter's `mex:` key, so setting its status is `["mex", "status"]`. A
 * **block-level** entity keeps the same fields at the top of its
 * `<!-- mex:entity -->` comment, so the same operation is `["status"]` against
 * a different region. One implementation, two callers — which is the only way
 * the two paths can be relied on to have the same fidelity.
 *
 * The trailing trim of finding 24 applies to both, and matters more here: a
 * nested value's reported end runs past its newline exactly as a top-level
 * one's does, and left alone a `mex.status` range would swallow the line break
 * separating it from the next key.
 */
export function findKeyPathRange(text: string, region: YamlRegion, path: readonly string[]): KeyRange | null {
  if (path.length === 0) return null;
  const item = pairAt(region, path);
  if (item === null) return null;

  const keyRange = YAML.isScalar(item.key) ? item.key.range : null;
  const valueRange = item.value && typeof item.value === "object" && "range" in item.value
    ? (item.value.range as [number, number, number])
    : null;
  if (!keyRange) return null;

  const keyStart = region.innerStart + keyRange[0];
  const rawEnd = region.innerStart + (valueRange ? valueRange[1] : keyRange[1]);
  const valueEnd = trimTrailingBlank(text, Math.min(rawEnd, region.innerEnd), keyStart);
  return { keyStart, valueEnd, nodeEnd: valueEnd + terminatorLengthAt(text, valueEnd) };
}

/** Where a new key goes inside the map at `path`, and how far it is indented. */
export interface MapInsertion {
  /** File offset to insert at: the end of the map's last entry. */
  offset: number;
  /** Whitespace every rendered line must carry to sit inside this map. */
  indent: string;
  /** True when the map already has entries, so the insert needs a line break first. */
  needsLeadingBreak: boolean;
}

/** The whitespace between the start of `offset`'s line and `offset` itself. */
function indentAt(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && text.charCodeAt(start - 1) !== 0x0a) start -= 1;
  return /^[ \t]*/.exec(text.slice(start, offset))![0]!;
}

/**
 * Find the map at `path` and say where a new key would go inside it.
 *
 * Indentation is **measured from the map's first existing entry**, not computed
 * from the depth. A hand-written file may indent by two spaces or by four, and
 * a writer that assumes one produces a file that still parses as YAML but no
 * longer matches its neighbours — a diff full of whitespace nobody asked for.
 * An empty map has no entry to measure, which is reported as null rather than
 * guessed at.
 */
export function findMapInsertion(text: string, region: YamlRegion, path: readonly string[]): MapInsertion | null {
  const document = regionDocument(region);
  if (document === null) return null;

  const container = path.length === 0 ? document.contents : pairAt(region, path)?.value;
  if (!YAML.isMap(container) || container.items.length === 0) return null;

  const last = container.items[container.items.length - 1]!;
  const first = container.items[0]!;
  if (!YAML.isScalar(first.key) || !first.key.range) return null;

  const lastValue = last.value && typeof last.value === "object" && "range" in last.value
    ? (last.value.range as [number, number, number])
    : null;
  const lastKey = YAML.isScalar(last.key) ? last.key.range : null;
  if (!lastKey) return null;
  const rawEnd = region.innerStart + (lastValue ? lastValue[1] : lastKey[1]);
  const offset = trimTrailingBlank(text, Math.min(rawEnd, region.innerEnd), region.innerStart);

  return { offset, indent: indentAt(text, region.innerStart + first.key.range[0]), needsLeadingBreak: true };
}

/**
 * Prefix every non-blank line with `indent`, and join with `eol`.
 *
 * The line ending is neither cosmetic nor optional. `YAML.stringify` emits LF,
 * so a multi-line value — a relation list, a source list, a grounding list —
 * written into a CRLF file would leave lone LFs in the middle of a file that
 * uses CRLF everywhere else. That is a corruption the scope check cannot see,
 * because the mixed terminators sit *inside* the declared range, and it is
 * exactly what the raw-versus-normalized distinction exists to prevent. Caught
 * by an operation writing a relation into a CRLF fixture.
 */
function withIndent(rendered: string, indent: string, eol: string): string {
  return rendered
    .split("\n")
    .map((line) => (line === "" || indent === "" ? line : `${indent}${line}`))
    .join(eol);
}

/**
 * Set a key at `path` inside `region`, touching nothing else.
 *
 * Replaces the key's own range when it exists and appends inside its parent map
 * when it does not. Either way the produced text is verified against the
 * declared range by `applyEdits`, so the two `.mex` metadata dialects reach the
 * same guarantee through the same check rather than through two writers that
 * happen to agree today.
 */
export function spliceKeyPath(
  content: string,
  region: YamlRegion,
  path: readonly string[],
  value: unknown,
): PatchResult | null {
  const edit = keyPathEdit(content, region, path, value);
  return edit === null ? null : applyEdits(content, [edit]);
}

/**
 * The **edit** that would set a key, rather than the result of applying it.
 *
 * An operation usually changes more than one key — a `set-property` also bumps
 * the revision — and applying two splices in sequence would mean re-parsing
 * between them and holding ranges in two different coordinate systems. Then the
 * one `checkOnlyRangesChanged` over the *original* text, which is the guarantee
 * this whole phase rests on, could no longer be stated. Returning edits in base
 * coordinates lets every change an operation makes go through one `applyEdits`.
 */
export function keyPathEdit(
  content: string,
  region: YamlRegion,
  path: readonly string[],
  value: unknown,
): PatchEdit | null {
  if (path.length === 0) return null;
  const key = path[path.length - 1]!;
  const rendered = renderKeyValue(key, value);
  const eol = dominantTerminator(content);

  const existing = findKeyPathRange(content, region, path);
  if (existing !== null) {
    const indent = indentAt(content, existing.keyStart);
    return {
      start: existing.keyStart,
      end: existing.valueEnd,
      text: withIndent(rendered, indent, eol).slice(indent.length),
      label: `metadata key ${path.join(".")}`,
    };
  }

  const insertion = findMapInsertion(content, region, path.slice(0, -1));
  if (insertion === null) return null;
  return {
    start: insertion.offset,
    end: insertion.offset,
    text: `${insertion.needsLeadingBreak ? eol : ""}${withIndent(rendered, insertion.indent, eol)}`,
    label: `insert metadata key ${path.join(".")}`,
  };
}

/** Remove a key at `path` inside `region`, leaving no blank-line residue. */
export function removeKeyPath(content: string, region: YamlRegion, path: readonly string[]): PatchResult | null {
  const edit = keyPathRemoveEdit(content, region, path);
  if (edit === null) return null;
  return edit === "absent" ? { text: content, declared: [] } : applyEdits(content, [edit]);
}

/** The edit that would remove a key; `"absent"` when there is nothing to remove. */
export function keyPathRemoveEdit(
  content: string,
  region: YamlRegion,
  path: readonly string[],
): PatchEdit | "absent" | null {
  const existing = findKeyPathRange(content, region, path);
  if (existing === null) return "absent";
  const insertion = findMapInsertion(content, region, path.slice(0, -1));
  if (insertion === null) return null;

  // Taking the preceding terminator when this is the map's last key is what
  // keeps the block from ending on a stray blank line.
  const isLast = existing.nodeEnd >= insertion.offset;
  let start = existing.keyStart;
  if (isLast && start > region.innerStart) {
    if (content.charCodeAt(start - 1) === 0x0a) start -= 1;
    if (content.charCodeAt(start - 1) === 0x0d) start -= 1;
  }
  const end = isLast ? existing.valueEnd : existing.nodeEnd;
  return { start, end, text: "", label: `remove metadata key ${path.join(".")}` };
}

/** Top-level keys in document order, so a writer can preserve that order. */
export function topLevelKeys(frontmatter: RawFrontmatter): string[] {
  try {
    const contents = YAML.parseDocument(frontmatter.text).contents;
    if (!YAML.isMap(contents)) return [];
    return contents.items
      .map((item) => (YAML.isScalar(item.key) ? String(item.key.value) : null))
      .filter((name): name is string => name !== null);
  } catch {
    return [];
  }
}

/**
 * Render one key and its value as YAML text.
 *
 * Scoped deliberately: this serializes a single-entry map, so the output is the
 * key and its value and nothing else. It can never reformat a neighbour,
 * because a neighbour is never passed in.
 */
export function renderKeyValue(key: string, value: unknown): string {
  return YAML.stringify({ [key]: value }).replace(/\n$/, "");
}

/**
 * Render several keys, in the order given, as one YAML fragment.
 *
 * For a *new* metadata block, where there is nothing to preserve. Composed from
 * {@link renderKeyValue} one key at a time rather than stringifying a map,
 * which keeps the whole-map serializer out of the picture even here: the key
 * order is the caller's list, not whatever a serializer chose, and the same
 * rendering path serves a new block and an edited one.
 *
 * A key whose value is `undefined` is omitted rather than rendered as null —
 * the model's `optional()` rejects an explicit null, so emitting one would
 * produce a block MEX itself refuses to read.
 */
export function renderKeyValues(entries: readonly (readonly [string, unknown])[], eol = "\n"): string {
  return entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => renderKeyValue(key, value))
    .join("\n")
    .replace(/\n/g, eol);
}

/** The line ending this text uses, so inserted text matches it. */
function dominantTerminator(text: string): string {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

/**
 * Set a top-level frontmatter key to `valueYaml`, touching nothing else.
 *
 * Three cases, all tested: the key exists and its value range is replaced; the
 * key is absent and is appended inside the existing block; there is no
 * frontmatter block at all and one is created above a byte-identical body.
 */
export function spliceTopLevelKey(content: string, key: string, valueYaml: string): PatchResult {
  const frontmatter = parseDocument(content).frontmatter;
  const eol = dominantTerminator(content);

  if (frontmatter === null) {
    const block = `---${eol}${valueYaml}${eol}---${eol}${content.length > 0 ? eol : ""}`;
    return applyEdits(content, [{ start: 0, end: 0, text: block, label: `create frontmatter for ${key}` }]);
  }

  const existing = findTopLevelKeyRange(content, frontmatter, key);
  if (existing !== null) {
    return applyEdits(content, [
      { start: existing.keyStart, end: existing.valueEnd, text: valueYaml, label: `frontmatter key ${key}` },
    ]);
  }

  // Absent: append at the end of the block. Inserting at `innerEnd` keeps every
  // existing key — and every comment attached to one — exactly where it was.
  // An *empty* frontmatter block has no last entry to append after, which is
  // the one case `findMapInsertion` cannot answer and this can.
  const insertAtOffset = findMapInsertion(content, frontmatter, [])?.offset ?? frontmatter.innerEnd;
  const needsLeadingBreak = insertAtOffset > frontmatter.innerStart;
  const text = `${needsLeadingBreak ? eol : ""}${valueYaml}`;
  return applyEdits(content, [
    { start: insertAtOffset, end: insertAtOffset, text, label: `insert frontmatter key ${key}` },
  ]);
}

/**
 * Remove a top-level key entirely, leaving no blank-line residue.
 *
 * The removal takes the key's line terminator with it, so neighbours close up
 * without being reflowed.
 */
export function removeTopLevelKey(content: string, key: string): PatchResult {
  const frontmatter = parseDocument(content).frontmatter;
  if (frontmatter === null) return { text: content, declared: [] };

  const existing = findTopLevelKeyRange(content, frontmatter, key);
  if (existing === null) return { text: content, declared: [] };

  // Take the preceding terminator when this is the block's last key, so the
  // block does not end with a stray blank line.
  const isLast = existing.nodeEnd >= frontmatter.innerEnd;
  let start = existing.keyStart;
  if (isLast && start > frontmatter.innerStart) {
    if (content.charCodeAt(start - 1) === 0x0a) start -= 1;
    if (content.charCodeAt(start - 1) === 0x0d) start -= 1;
  }
  const end = isLast ? existing.valueEnd : existing.nodeEnd;

  return applyEdits(content, [{ start, end, text: "", label: `remove frontmatter key ${key}` }]);
}

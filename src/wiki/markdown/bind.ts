/**
 * Binding metadata to headings, and deciding where a body ends.
 *
 * The rules come from build spec §9.3 and `contract.ts`. Two of them are not in
 * the spec at all — the body's third terminator, and the conflict-region
 * suppression in `positions.ts` — and both were forced by the partition
 * property rather than reasoned into existence.
 *
 * Nothing here guesses. An unbound block is a diagnostic; two blocks competing
 * for one heading is a diagnostic and *neither* wins. A parser that picks a
 * winner is a parser that silently attaches somebody's decision record to the
 * wrong section.
 */

import type { RawDocument, RawHeading, RawHtml } from "./parse.js";

/** Metadata that found its heading. */
export interface Binding {
  kind: "frontmatter" | "comment";
  /** Range of the metadata itself: `<!--`…`-->`, or the `mex` key and value. */
  metadataStart: number;
  metadataEnd: number;
  heading: RawHeading | null;
  /** Raw YAML text to parse into entity metadata, for a comment block. */
  yamlText: string;
  /**
   * Metadata already parsed, for a frontmatter block.
   *
   * The frontmatter YAML is parsed once for the whole document, so the `mex`
   * value is in hand before binding. Re-rendering it to text just to parse it
   * again would be a round-trip through a serializer — the one thing this codec
   * must never do, and the lint rule catches it.
   */
  parsedMetadata?: unknown;
  /** Body extent, filled in once every binding is known. */
  bodyStart: number;
  bodyEnd: number;
}

export interface BindResult {
  bindings: Binding[];
  unbound: RawHtml[];
  /** Comment blocks that competed for a heading another block already claimed. */
  contested: { heading: RawHeading; blocks: RawHtml[] }[];
}

/**
 * Only blank lines may sit between metadata and its heading — plus other
 * metadata blocks.
 *
 * Checked against the source text rather than against node adjacency, because
 * "nothing but whitespace" is the actual rule and the AST cannot express it:
 * two blank lines and a paragraph look the same from the node list until you
 * read what is in the gap.
 *
 * The exception for other metadata blocks is what makes "two blocks cannot bind
 * to the same heading" detectable at all. Without it, the *first* of two
 * stacked blocks is separated from the heading by the second, so it reads as
 * merely unbound and the second binds unopposed — the file silently gets one
 * entity, chosen by document order, which is precisely the guess the rule
 * exists to forbid. `malformed/double-bound-metadata.md` is that case.
 */
function onlyBlankBetween(text: string, from: number, to: number, markers: readonly RawHtml[]): boolean {
  let residual = "";
  let cursor = from;
  for (const marker of markers) {
    if (marker.start < cursor || marker.end > to) continue;
    residual += text.slice(cursor, marker.start);
    cursor = marker.end;
  }
  residual += text.slice(cursor, to);
  return /^[ \t\r\n]*$/.test(residual);
}

/**
 * Bind every `mex:entity` comment to the next heading.
 *
 * A block binds to the first heading that starts at or after its end, provided
 * everything in between is whitespace. Anything else — a paragraph, an HTML
 * block, a code fence — leaves it unbound.
 */
export function bindComments(text: string, document: RawDocument): BindResult {
  const markers = document.htmlBlocks.filter((block) => block.isEntityMarker);
  const claims = new Map<RawHeading, RawHtml[]>();
  const unbound: RawHtml[] = [];

  for (const block of markers) {
    const heading = document.headings.find((candidate) => candidate.start >= block.end);
    if (heading === undefined || !onlyBlankBetween(text, block.end, heading.start, markers)) {
      unbound.push(block);
      continue;
    }
    const existing = claims.get(heading);
    if (existing) existing.push(block);
    else claims.set(heading, [block]);
  }

  const bindings: Binding[] = [];
  const contested: { heading: RawHeading; blocks: RawHtml[] }[] = [];

  for (const [heading, blocks] of claims) {
    if (blocks.length > 1) {
      contested.push({ heading, blocks });
      continue;
    }
    const block = blocks[0]!;
    bindings.push({
      kind: "comment",
      metadataStart: block.start,
      metadataEnd: block.end,
      heading,
      yamlText: block.yamlText,
      bodyStart: heading.end,
      bodyEnd: heading.end,
    });
  }

  return { bindings, unbound, contested };
}

/**
 * Fill in body extents across all bindings in a file.
 *
 * A body runs to whichever comes first:
 *
 *  1. the next heading of equal or shallower depth,
 *  2. **the start of the next entity's metadata**,
 *  3. end of file.
 *
 * Rule 2 is absent from the spec, which gives only the depth rule. Under the
 * depth rule alone a file-level entity's body swallows every block entity
 * nested inside it and the ranges overlap — `structure/mixed-entities.md` is
 * exactly that shape, and the partition property is what caught it.
 *
 * A consequence worth stating: a file-level entity's body therefore stops at
 * the first nested entity and never resumes. Its `body` is not the whole file.
 */
export function resolveBodyExtents(
  text: string,
  document: RawDocument,
  bindings: Binding[],
  /**
   * Start offsets of **every** metadata block in the file, including unbound
   * and contested ones.
   *
   * Not derived from `bindings`, deliberately. A malformed block still marks
   * where the author intended the next entity to begin, so a body that ran past
   * it would absorb metadata belonging to something else — and in
   * `adversarial/spacing.md` the preceding entity would swallow both the
   * unbound block and the section after it.
   */
  metadataStarts: readonly number[],
): void {
  const ordered = [...bindings].sort((left, right) => left.metadataStart - right.metadataStart);

  for (const binding of ordered) {
    const depth = binding.heading?.depth ?? 0;
    const from = binding.bodyStart;
    let end = text.length;

    // (1) the next heading of equal or shallower depth. A file-level entity
    // with no heading has depth 0, which no heading can undercut, so only
    // rules 2 and 3 apply to it — correct, since it owns the document.
    for (const heading of document.headings) {
      if (heading.start < from) continue;
      if (depth > 0 && heading.depth <= depth) {
        end = Math.min(end, heading.start);
        break;
      }
    }

    // (2) the next entity's metadata, bound or not.
    for (const start of metadataStarts) {
      if (start >= from && start > binding.metadataStart) end = Math.min(end, start);
    }

    binding.bodyEnd = Math.max(from, end);
  }
}

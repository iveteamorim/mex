/**
 * One AST pass over a Markdown file, yielding the structural facts the binder
 * needs and nothing else.
 *
 * Everything here is positional. No node is re-serialized, no text is
 * normalized, and the offsets returned index the original string — see
 * `positions.ts` for why that is not the same as trusting remark.
 *
 * Using the AST rather than scanning text is what makes the hardest requirement
 * in the spec nearly free: a `<!-- mex:entity -->` inside a fenced or indented
 * code block arrives as a `code` node, so it is never a candidate at all. Only
 * top-level `html` children of the root are considered, and nothing walks into
 * another node looking for comments.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import type { Root, RootContent, Heading, Yaml } from "mdast";
import { visit } from "unist-util-visit";
import type { Link } from "mdast";
import {
  createPositionMap,
  findConflictRegions,
  isInsideRegion,
  terminatorLengthAt,
  type ConflictRegion,
} from "./positions.js";

const parser = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/** A heading, with its range extended to include its line terminator. */
export interface RawHeading {
  depth: number;
  /** Start of the heading, in file offsets. */
  start: number;
  /** End of the heading **including** its line terminator, per the contract. */
  end: number;
  /** The heading's plain text, with markers and terminator removed. */
  title: string;
}

/**
 * A region of YAML inside a Markdown file, located rather than re-serialized.
 *
 * Both places entity metadata can live reduce to this: the inner text of a
 * frontmatter block, and the text between a `<!-- mex:entity` marker line and
 * its closing `-->`. Naming the shape is what lets **one** key-splicing
 * implementation serve both — see `frontmatter.ts`. Half the entities in a
 * scaffold are block-level, and a metadata writer that only understands
 * frontmatter has no way to touch them except by re-rendering the whole
 * comment, which is the re-serialization D9 exists to prevent.
 */
export interface YamlRegion {
  /** File offset of the first character of the YAML text. */
  innerStart: number;
  /** File offset just past its last character. */
  innerEnd: number;
  /** The YAML text itself, `text.slice(innerStart, innerEnd)`. */
  text: string;
}

/** A top-level HTML block. */
export interface RawHtml extends YamlRegion {
  /** Range of `<!--` through `-->`, in file offsets. */
  start: number;
  end: number;
  /** True when the first line is exactly the `mex:entity` marker. */
  isEntityMarker: boolean;
  /** The YAML body between the marker line and the closing delimiter. */
  yamlText: string;
}

export interface RawFrontmatter extends YamlRegion {
  /** The whole block including both `---` delimiters. */
  start: number;
  end: number;
  /** The inner YAML text's own start offset — not `start + 4`; see below. */
  innerStart: number;
  innerEnd: number;
  text: string;
}

export interface RawLink {
  nodeId: string;
  start: number;
  end: number;
}

export interface RawDocument {
  frontmatter: RawFrontmatter | null;
  headings: RawHeading[];
  htmlBlocks: RawHtml[];
  links: RawLink[];
  conflictRegions: ConflictRegion[];
}

/**
 * The marker line, anchored.
 *
 * A substring test for `mex:entity` passes today's corpus and then binds
 * `<!-- mex:entitynot ... -->` in somebody's real file. The marker is the whole
 * first line, optional trailing spaces included.
 */
const ENTITY_MARKER = /^<!--[ \t]*mex:entity[ \t]*(?:\r?\n|$)/;

function headingText(node: Heading, text: string, start: number, end: number): string {
  // Prefer the source slice over reconstructing from children: it keeps inline
  // markup exactly as written, which is what the expectations compare against.
  const raw = text.slice(start, end).replace(/\r?\n$/, "");
  const atx = /^(#{1,6})[ \t]+/.exec(raw);
  if (atx) return raw.slice(atx[0].length).replace(/[ \t]+#*[ \t]*$/, "");
  // Setext: the title is the first line; the underline is the second.
  return raw.split(/\r?\n/)[0]!.trim();
}

/**
 * The inner YAML's start offset inside a frontmatter block.
 *
 * **Not `start + 4`.** The opening fence is `---` plus a terminator, which is
 * two units on a CRLF file, and the block may be preceded by a BOM that has
 * already shifted `start`. Derive it from the text.
 */
function frontmatterInnerStart(text: string, blockStart: number): number {
  const fenceEnd = blockStart + 3;
  return fenceEnd + terminatorLengthAt(text, fenceEnd);
}

function frontmatterInnerEnd(text: string, blockEnd: number, value: string): number {
  // The closing fence sits at the end of the block; the inner text ends before
  // the terminator that precedes it. Locating it by value length is wrong when
  // remark normalizes, so search backwards for the final fence instead.
  const closing = text.lastIndexOf("---", blockEnd);
  if (closing <= 0) return blockEnd;
  let end = closing;
  if (text.charCodeAt(end - 1) === 0x0a) end -= 1;
  if (text.charCodeAt(end - 1) === 0x0d) end -= 1;
  return Math.max(end, blockEnd - value.length - 4);
}

export function parseDocument(text: string): RawDocument {
  const tree: Root = parser.parse(text);
  const positions = createPositionMap(text);
  const conflictRegions = findConflictRegions(text);

  const headings: RawHeading[] = [];
  const htmlBlocks: RawHtml[] = [];
  let frontmatter: RawFrontmatter | null = null;

  for (const node of tree.children as RootContent[]) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) continue;
    const start = positions.at(from);
    const end = positions.at(to);

    if (node.type === "yaml" && frontmatter === null) {
      const value = (node as Yaml).value;
      frontmatter = {
        start,
        end,
        innerStart: frontmatterInnerStart(text, start),
        innerEnd: frontmatterInnerEnd(text, end, value),
        text: value,
      };
      continue;
    }

    if (node.type === "heading") {
      // A heading inside a conflict region is an artifact of `=======` being a
      // valid setext underline, not a real heading. See findConflictRegions.
      if (isInsideRegion(conflictRegions, start)) continue;
      const withTerminator = end + terminatorLengthAt(text, end);
      headings.push({
        depth: (node as Heading).depth,
        start,
        end: withTerminator,
        title: headingText(node as Heading, text, start, withTerminator),
      });
      continue;
    }

    if (node.type === "html") {
      const raw = text.slice(start, end);
      const isEntityMarker = ENTITY_MARKER.test(raw) && !isInsideRegion(conflictRegions, start);
      // Measured against the file slice rather than the AST node's `value`, so
      // the inner offsets and the inner text can never describe different
      // things. `extractCommentYaml` performs the same two steps on a string
      // with no coordinates; a test asserts the two agree.
      const region = isEntityMarker ? commentYamlRegion(text, start, end) : { innerStart: start, innerEnd: start, text: "" };
      htmlBlocks.push({
        start,
        end,
        isEntityMarker,
        yamlText: region.text,
        innerStart: region.innerStart,
        innerEnd: region.innerEnd,
        text: region.text,
      });
    }
  }

  const links: RawLink[] = [];
  visit(tree, "link", (node: Link) => {
    if (!node.url.startsWith("mex://") || node.url.length === "mex://".length) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    links.push({ nodeId: node.url.slice("mex://".length), start: positions.at(start), end: positions.at(end) });
  });

  return { frontmatter, headings, htmlBlocks, links, conflictRegions };
}

/**
 * Locate the YAML inside a `<!-- mex:entity … -->` block, in file coordinates.
 *
 * The read side never needed the offsets — it parsed the text and threw the
 * positions away — which is why nothing in the tree could write a block
 * entity's metadata scoped. They are the same two steps `extractCommentYaml`
 * performs, kept as arithmetic so a splice can be bounded by them.
 */
export function commentYamlRegion(text: string, start: number, end: number): YamlRegion {
  const raw = text.slice(start, end);
  const marker = ENTITY_MARKER.exec(raw);
  const innerStart = start + (marker === null ? 0 : marker[0].length);
  const closing = raw.lastIndexOf("-->");
  const innerEnd = closing < 0 ? end : Math.max(innerStart, start + closing);
  return { innerStart, innerEnd, text: text.slice(innerStart, innerEnd) };
}

/** The YAML between the `<!-- mex:entity` marker line and the closing `-->`. */
export function extractCommentYaml(comment: string): string {
  const afterMarker = comment.replace(ENTITY_MARKER, "");
  const closing = afterMarker.lastIndexOf("-->");
  return closing < 0 ? afterMarker : afterMarker.slice(0, closing);
}

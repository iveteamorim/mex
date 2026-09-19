import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { visit } from "unist-util-visit";
import YAML from "yaml";
import { renderKeyValue, spliceKeyPath, spliceTopLevelKey } from "./wiki/markdown/frontmatter.js";
import { parseDocument } from "./wiki/markdown/parse.js";
import type { Grounding, ScaffoldFrontmatter } from "./types.js";
import type { Root, Content, Link } from "mdast";

const parser = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/** Parse markdown string into AST */
export function parseMarkdown(content: string): Root {
  return parser.parse(content);
}

/** Extract YAML frontmatter from markdown content */
export function extractFrontmatter(
  content: string
): ScaffoldFrontmatter | null {
  const tree = parseMarkdown(content);
  let frontmatter: ScaffoldFrontmatter | null = null;

  visit(tree, "yaml", (node: { value: string }) => {
    try {
      frontmatter = YAML.parse(node.value) as ScaffoldFrontmatter;
    } catch {
      // Invalid YAML — skip
    }
  });

  return frontmatter;
}

/**
 * Where a file's groundings live: under `mex:` once it has one, else at the root.
 *
 * A pre-wiki scaffold keeps `grounds_to` as a root frontmatter key, and that is
 * the key `mex ground` has always read and written. Once migration adopts a
 * file as a wiki entity, the entity's metadata is the `mex:` map and the
 * grounding belongs inside it — section 13.4's "move it under `mex.grounds_to`".
 *
 * **Both the read and the write follow the same rule, and that is the point.**
 * Teaching only the reader would leave `writeGroundings` splicing the root key
 * back in on the next `mex ground` run, so the file would end up carrying the
 * same grounding in two places, maintained by two writers that drift the moment
 * either updates — the two-stores-of-one-fact failure D1 exists to forbid,
 * arriving through a door D1 did not name. Migration removes the root key as it
 * moves the values (`ABSORBABLE_ROOT_KEYS`), so exactly one store survives.
 *
 * A file with no `mex:` key is untouched by this: the path is the root key, and
 * every shipped grounding test exercises that case unchanged.
 */
export function groundingKeyPath(content: string): readonly string[] {
  const frontmatter = extractFrontmatter(content) as (ScaffoldFrontmatter & { mex?: unknown }) | null;
  const mex = frontmatter?.mex;
  return mex !== null && typeof mex === "object" ? ["mex", "grounds_to"] : ["grounds_to"];
}

/** Return validated code-graph groundings; malformed entries are rejected as a set. */
export function extractGroundings(content: string): Grounding[] {
  const frontmatter = extractFrontmatter(content) as (ScaffoldFrontmatter & { mex?: { grounds_to?: unknown } }) | null;
  const value = groundingKeyPath(content)[0] === "mex" ? frontmatter?.mex?.grounds_to : frontmatter?.grounds_to;
  return isGroundingArray(value) ? value : [];
}

/**
 * Accept a `grounds_to` value.
 *
 * The check names the two required keys and deliberately does not enumerate the
 * optional ones. That is what lets `bodyHash` — and the wiki lane's `file`,
 * `commit`, `verifiedAt` and `reason` — survive a read/write cycle: the parsed
 * entries are handed to {@link writeGroundings} unchanged, so every key the
 * author put in the file is rendered back out. Tightening this into an
 * exact-shape check would silently strip whichever keys this lane's type had
 * not yet heard of, which is the failure it exists to avoid.
 */
export function isGroundingArray(value: unknown): value is Grounding[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const grounding = entry as Partial<Grounding>;
    return typeof grounding.node === "string" && grounding.node.length > 0
      && typeof grounding.fingerprint === "string" && grounding.fingerprint.length > 0;
  });
}

/**
 * Add or replace `grounds_to`, touching nothing else in the file.
 *
 * This used to rewrite the whole frontmatter block through `YAML.stringify`,
 * which preserved the body but reformatted the YAML: comment placement, quoting
 * style and key order were lost every time MEX recorded a fingerprint. That
 * turns a one-line grounding update into a whole-block diff, which is exactly
 * what the Markdown-canonical design exists to avoid — the scaffold has to stay
 * reviewable in an ordinary pull request.
 *
 * It now splices the one key's own range. Everything else in the file, byte for
 * byte, is left as the author wrote it.
 */
export function writeGroundings(content: string, groundings: Grounding[]): string {
  if (!isGroundingArray(groundings)) throw new Error("Invalid grounds_to entries");
  const path = groundingKeyPath(content);
  if (path.length === 1) {
    return spliceTopLevelKey(content, "grounds_to", renderKeyValue("grounds_to", groundings)).text;
  }
  const frontmatter = parseDocument(content).frontmatter;
  if (frontmatter === null) {
    return spliceTopLevelKey(content, "grounds_to", renderKeyValue("grounds_to", groundings)).text;
  }
  const spliced = spliceKeyPath(content, frontmatter, path, groundings);
  // A `mex` map that cannot hold the key is not a reason to write a second copy
  // at the root; it is a reason to leave the file alone and let validation say so.
  return spliced === null ? content : spliced.text;
}

export interface MexAnchor {
  nodeId: string;
  /** Offsets of the complete markdown link, used for precise durable rewrites. */
  start: number;
  end: number;
}

/** Find standard markdown links whose destination is exactly `mex://<nodeId>`. */
export function findMexAnchors(content: string): MexAnchor[] {
  const anchors: MexAnchor[] = [];
  visit(parseMarkdown(content), "link", (node: Link) => {
    if (!node.url.startsWith("mex://") || node.url.length === "mex://".length) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    anchors.push({ nodeId: node.url.slice("mex://".length), start, end });
  });
  return anchors;
}

/** Extract inline anchor node ids in document order. */
export function extractMexAnchorIds(content: string): string[] {
  return findMexAnchors(content).map((anchor) => anchor.nodeId);
}

/** Rewrite one parsed anchor while preserving its visible text and surrounding markdown byte-for-byte. */
export function rewriteMexAnchor(content: string, anchor: MexAnchor, nodeId: string): string {
  if (!nodeId) throw new Error("Invalid mex anchor node id");
  const link = content.slice(anchor.start, anchor.end);
  const oldUri = `mex://${anchor.nodeId}`;
  const uriOffset = link.indexOf(oldUri);
  if (uriOffset < 0) throw new Error("mex anchor no longer matches markdown content");
  const start = anchor.start + uriOffset;
  return content.slice(0, start) + `mex://${nodeId}` + content.slice(start + oldUri.length);
}

/** Get the current heading context for a given line position */
export function getHeadingAtLine(
  tree: Root,
  line: number
): string | null {
  let currentHeading: string | null = null;

  for (const node of tree.children) {
    if (!node.position) continue;
    if (node.position.start.line > line) break;
    if (node.type === "heading") {
      currentHeading = getTextContent(node);
    }
  }

  return currentHeading;
}

/** Extract plain text from an AST node */
export function getTextContent(node: Content | Root): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("children" in node) {
    return (node.children as Content[]).map(getTextContent).join("");
  }
  return "";
}

/** Check if a heading or its ancestors suggest negation */
export function isNegatedSection(heading: string | null): boolean {
  if (!heading) return false;
  const lower = heading.toLowerCase();
  return (
    lower.includes("not exist") ||
    lower.includes("not use") ||
    lower.includes("deliberately not") ||
    lower.includes("excluded") ||
    lower.includes("removed") ||
    lower.includes("deprecated")
  );
}

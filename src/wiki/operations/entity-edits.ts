/**
 * Turning "change this field" into a byte range and a replacement.
 *
 * Everything here returns {@link PatchEdit}s in the **original** file's
 * coordinates and nothing here applies one. That is what lets an operation
 * bundle every change it makes into a single `applyEdits`, so the phase's one
 * guarantee — the produced text differs from the original only inside the
 * declared ranges — is checked once over the whole operation rather than once
 * per field against a moving base.
 *
 * The two metadata dialects are handled by {@link metadataTarget}, which turns
 * a located entity into the region and key prefix its fields live at. Callers
 * never branch on `metadataKind`; if they did, the block-level path would be
 * the one that rots, because it is the one no fixture exercises by default.
 */

import { keyPathEdit, keyPathRemoveEdit } from "../markdown/frontmatter.js";
import type { PatchEdit } from "../markdown/patch.js";
import { parseDocument, type YamlRegion } from "../markdown/parse.js";
import type { WikiEntity } from "../model/entity.js";
import type { LocatedEntity } from "./locate.js";

/** Where one entity's metadata keys live, and how deep. */
export interface MetadataTarget {
  region: YamlRegion;
  /** `["mex"]` for a file-level entity, `[]` for a block-level one. */
  prefix: string[];
}

/** The YAML key each model field is written under. Only one is not the field name. */
export const METADATA_KEYS = {
  type: "type",
  status: "status",
  title: "title",
  summary: "summary",
  topics: "topics",
  metadata: "metadata",
  relations: "relations",
  sources: "sources",
  revision: "revision",
  groundsTo: "grounds_to",
} as const;

/**
 * Locate the YAML region and key prefix for a located entity.
 *
 * Re-derived from a fresh parse of the text passed in rather than carried on
 * `LocatedEntity`, so a caller cannot hand in text that has moved since the
 * entity was located and get ranges that address the old bytes.
 */
export function metadataTarget(text: string, entity: WikiEntity, kind: "frontmatter" | "comment"): MetadataTarget | null {
  const document = parseDocument(text);
  if (kind === "frontmatter") {
    return document.frontmatter === null ? null : { region: document.frontmatter, prefix: ["mex"] };
  }
  const block = document.htmlBlocks.find(
    (candidate) => candidate.isEntityMarker && candidate.start === entity.location.metadataStart,
  );
  return block === undefined ? null : { region: block, prefix: [] };
}

/** The target for an entity the locator already found. */
export function targetOf(located: LocatedEntity): MetadataTarget | null {
  return metadataTarget(located.text, located.entity, located.metadataKind);
}

/** Set one metadata field. Null when the region cannot hold the key. */
export function metadataEdit(text: string, target: MetadataTarget, key: string, value: unknown): PatchEdit | null {
  return keyPathEdit(text, target.region, [...target.prefix, key], value);
}

/** Remove one metadata field. `"absent"` when there was nothing to remove. */
export function metadataRemoveEdit(text: string, target: MetadataTarget, key: string): PatchEdit | "absent" | null {
  return keyPathRemoveEdit(text, target.region, [...target.prefix, key]);
}

/** Replace an entity's body text, and nothing around it. */
export function bodyEdit(entity: WikiEntity, body: string): PatchEdit {
  return {
    start: entity.location.bodyStart,
    end: entity.location.bodyEnd,
    text: body,
    label: `body of ${entity.id}`,
  };
}

/**
 * Rewrite an entity's heading text, preserving the heading's own shape.
 *
 * ATX and setext headings are both real in this corpus, and rewriting a setext
 * heading as ATX would be a reformat the author did not ask for — visible in
 * every diff, and exactly the kind of drive-by normalization this engine exists
 * not to do. Only the title text is replaced; the markers, the underline and
 * the line terminator all stay as they were.
 *
 * Returns an empty list when the entity has no bound heading (a file-level
 * entity whose prose starts before its first heading); the caller then writes
 * the title into metadata, which is where the codec reads it from anyway.
 */
export function headingEdits(text: string, entity: WikiEntity, title: string): PatchEdit[] {
  const { headingStart, headingEnd } = entity.location;
  if (headingEnd <= headingStart) return [];

  const raw = text.slice(headingStart, headingEnd);
  const atx = /^(#{1,6}[ \t]+)([^\r\n]*?)([ \t]*#*[ \t]*)(\r?\n)?$/.exec(raw);
  if (atx !== null) {
    const start = headingStart + atx[1]!.length;
    return [{ start, end: start + atx[2]!.length, text: title, label: `heading of ${entity.id}` }];
  }

  // Setext: the title is the first line, the underline the second. Replacing
  // only the first line's text keeps `===` or `---` and its width alone.
  const firstLine = /^([^\r\n]*)/.exec(raw)![1]!;
  return [{ start: headingStart, end: headingStart + firstLine.length, text: title, label: `heading of ${entity.id}` }];
}

/** The line ending a file uses, so inserted text matches it. */
export function dominantEol(text: string): string {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

/** Rewrite `text`'s line endings to `eol`, for a block moving between files. */
export function withEol(text: string, eol: string): string {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}

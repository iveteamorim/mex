/**
 * Position arithmetic for the Markdown codec.
 *
 * Every offset this engine reports is a **UTF-16 code-unit index into the
 * decoded text exactly as the caller passed it** — BOM included, line endings
 * untouched. Markdown AST positions are string indices, so they coincide with
 * byte offsets only for pure ASCII; slicing a Buffer with one of these corrupts
 * any file containing a curly quote, an accent or an emoji.
 *
 * This module is the single seam where AST positions become file positions.
 * Keeping it in one place matters because of the BOM: remark strips a leading
 * U+FEFF before parsing, so every offset it reports is short by one for a file
 * that has one. Correcting that at each call site would mean getting it right
 * every time forever; correcting it here means getting it right once.
 */

/** U+FEFF, the byte order mark, as it appears in decoded text. */
const BOM = "﻿";

/**
 * Translates AST offsets into offsets against the original text.
 *
 * `shift` is 1 for a file beginning with a BOM and 0 otherwise. It is exposed
 * so a caller can assert the correction happened rather than infer it.
 */
export interface PositionMap {
  readonly shift: number;
  /** An AST offset, as a file offset. */
  at(astOffset: number): number;
}

export function hasBom(text: string): boolean {
  return text.startsWith(BOM);
}

export function createPositionMap(text: string): PositionMap {
  const shift = hasBom(text) ? 1 : 0;
  return { shift, at: (astOffset) => astOffset + shift };
}

/**
 * Length of the line terminator at `offset`: 2 for CRLF, 1 for LF or CR, 0 at
 * end of input or on any other character.
 *
 * Heading ranges include their terminator by the contract's convention, while
 * remark's heading nodes stop before it, so this is how the two are reconciled.
 */
export function terminatorLengthAt(text: string, offset: number): number {
  if (offset >= text.length) return 0;
  const char = text.charCodeAt(offset);
  if (char === 0x0d) return text.charCodeAt(offset + 1) === 0x0a ? 2 : 1;
  if (char === 0x0a) return 1;
  return 0;
}

/**
 * Start offset of every line, so an offset can be turned into a 1-based line
 * number without rescanning the file each time.
 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const width = terminatorLengthAt(text, index);
    if (width === 0) continue;
    starts.push(index + width);
    if (width === 2) index += 1;
  }
  return starts;
}

/** 1-based line number containing `offset`, by binary search over `starts`. */
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** A half-open region of text that heading detection must ignore. */
export interface ConflictRegion {
  start: number;
  end: number;
}

const CONFLICT_START = /^<{7}(?: |$)/;
const CONFLICT_END = /^>{7}(?: |$)/;

/**
 * Git conflict regions, from `<<<<<<<` through `>>>>>>>` inclusive.
 *
 * These exist because a conflict marker is not inert prose to CommonMark: a
 * `=======` separator is a valid setext underline, so
 *
 *     <<<<<<< HEAD
 *     Rotation happens every fifteen minutes.
 *     =======
 *
 * parses as a **depth-1 heading**. Left alone, that phantom heading terminates
 * whatever entity body contains it, and half a section silently disappears from
 * the index after an ordinary bad merge — found by a user, not by a test.
 *
 * So headings starting inside one of these regions are ignored for binding and
 * for body extent. The marker text itself is preserved verbatim, as content,
 * for the human to resolve. Diagnosing conflict markers as a validation problem
 * belongs to a later phase; here they are handled and reported as nothing.
 */
export function findConflictRegions(text: string): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  const starts = lineStarts(text);
  let open: number | null = null;

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const next = index + 1 < starts.length ? starts[index + 1]! : text.length;
    const line = text.slice(start, next);

    if (open === null) {
      if (CONFLICT_START.test(line)) open = start;
      continue;
    }
    if (CONFLICT_END.test(line)) {
      regions.push({ start: open, end: next });
      open = null;
    }
  }

  // An unterminated region runs to end of file. Being generous here is
  // deliberate: an unclosed marker means the file is mid-conflict, and
  // suppressing headings after it loses nothing a correct parse would keep.
  if (open !== null) regions.push({ start: open, end: text.length });

  return regions;
}

export function isInsideRegion(regions: readonly ConflictRegion[], offset: number): boolean {
  return regions.some((region) => offset >= region.start && offset < region.end);
}

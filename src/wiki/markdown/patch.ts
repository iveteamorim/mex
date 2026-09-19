/**
 * The splice primitives. Every Markdown write in this engine ends here.
 *
 * **Positions only. Nothing is ever re-serialized.** A patch replaces a
 * declared range of the original string and leaves every other character
 * exactly as it was — comment placement, key order, quoting style, blank lines,
 * line endings, all of it. That is not a nicety: it is what makes a `.mex`
 * scaffold reviewable in an ordinary pull request, and every acceptance
 * criterion about unrelated content rests on it.
 *
 * Each operation returns the produced text **and the ranges it declared**, in
 * original coordinates, so the caller can hand both to `checkOnlyRangesChanged`
 * rather than taking the writer's word for it.
 */

import { checkOnlyRangesChanged, type LabeledRange } from "./ranges.js";

export interface PatchEdit {
  /** Half-open range in the original text, in UTF-16 code units. */
  start: number;
  end: number;
  /** Replacement text. Empty deletes the range. */
  text: string;
  /** Names the edit in failure messages. */
  label: string;
}

export interface PatchResult {
  text: string;
  /** The declared ranges, in original coordinates, sorted by start. */
  declared: LabeledRange[];
}

export class WriteScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteScopeError";
  }
}

/**
 * Apply edits to `original`, verifying the result differs only inside them.
 *
 * The verification is not redundant with the arithmetic. Splicing is easy to do
 * correctly and easy to *call* incorrectly — an edit whose range was computed
 * against a stale parse lands in the wrong place and still produces plausible
 * text. Checking the complement catches that at the point of the write.
 */
export function applyEdits(original: string, edits: readonly PatchEdit[]): PatchResult {
  const ordered = [...edits].sort((left, right) => left.start - right.start);

  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) {
      throw new WriteScopeError(`${edit.label} [${edit.start}, ${edit.end}) is not an integer range.`);
    }
    if (edit.end < edit.start) throw new WriteScopeError(`${edit.label} [${edit.start}, ${edit.end}) is inverted.`);
    if (edit.start < 0 || edit.end > original.length) {
      throw new WriteScopeError(
        `${edit.label} [${edit.start}, ${edit.end}) lies outside the text (length ${original.length}).`,
      );
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      throw new WriteScopeError(`Edits overlap: ${ordered[index - 1]!.label} and ${ordered[index]!.label}.`);
    }
  }

  let produced = "";
  let cursor = 0;
  for (const edit of ordered) {
    produced += original.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  produced += original.slice(cursor);

  const declared: LabeledRange[] = ordered.map((edit) => ({ label: edit.label, start: edit.start, end: edit.end }));
  const check = checkOnlyRangesChanged(original, produced, declared);
  if (!check.ok) throw new WriteScopeError(check.message);

  return { text: produced, declared };
}

/** Replace one range. */
export function replaceRange(original: string, start: number, end: number, text: string, label = "replace"): PatchResult {
  return applyEdits(original, [{ start, end, text, label }]);
}

/** Insert at one offset, disturbing nothing. */
export function insertAt(original: string, offset: number, text: string, label = "insert"): PatchResult {
  return applyEdits(original, [{ start: offset, end: offset, text, label }]);
}

/** Delete one range. */
export function deleteRange(original: string, start: number, end: number, label = "delete"): PatchResult {
  return applyEdits(original, [{ start, end, text: "", label }]);
}

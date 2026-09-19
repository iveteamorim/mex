/**
 * The two property harnesses the Markdown codec is judged against.
 *
 * Both are pure functions over text and ranges, with no test-framework
 * dependency, so they can be exercised from the codec, from operations, and from
 * tests alike. They are the oracle: when the codec lands, "correct" means these
 * hold, which is a far harder thing to fudge than "it compiles".
 *
 * **Positions are UTF-16 code-unit indices into decoded text — never byte
 * offsets into a Buffer.** Markdown AST positions index a JavaScript string, and
 * the two coincide only for pure ASCII. Slicing a Buffer at one of these writes
 * into the middle of a character, and does so only for files containing
 * non-ASCII prose, so it passes every ASCII fixture and detonates later.
 */

/** A half-open range `[start, end)` in UTF-16 code units. */
export interface SourceRange {
  start: number;
  end: number;
}

/** A range carrying a human-readable name, so failures say what went wrong where. */
export interface LabeledRange extends SourceRange {
  /** e.g. `entities[1].heading`, `gap[0]`. */
  label: string;
}

export type RangeCheck = { ok: true } | { ok: false; message: string };

const ok: RangeCheck = { ok: true };

function fail(message: string): RangeCheck {
  return { ok: false, message };
}

/** Render a short, escaped excerpt so failure messages stay on one line. */
function excerpt(text: string, start: number, length = 32): string {
  const slice = text.slice(start, start + length);
  const escaped = slice.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return slice.length < text.length - start ? `"${escaped}…"` : `"${escaped}"`;
}

function describeRange(range: LabeledRange): string {
  return `${range.label} [${range.start}, ${range.end})`;
}

// -- Property 1: the partition -----------------------------------------------

/**
 * Check that ranges form a complete, non-overlapping partition of `source`.
 *
 * Concatenating every range in the order given must reproduce the source text
 * exactly. This is what catches off-by-one errors: a round-trip test
 * structurally cannot see them, because re-emitting an unmodified buffer is the
 * buffer. A partition, by contrast, fails loudly the moment a range claims one
 * character too many or too few.
 *
 * Zero-length ranges are legal — a file-level entity has no heading, and its
 * heading range is empty rather than absent.
 */
export function checkRangePartition(source: string, ranges: readonly LabeledRange[]): RangeCheck {
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
      return fail(`${describeRange(range)} is not an integer range.`);
    }
    if (range.end < range.start) {
      return fail(`${describeRange(range)} is inverted — end precedes start.`);
    }
    if (range.start < 0) {
      return fail(`${describeRange(range)} starts before the beginning of the input.`);
    }
    if (range.end > source.length) {
      return fail(`${describeRange(range)} runs past end of input (length ${source.length}).`);
    }
  }

  if (ranges.length === 0) {
    return source.length === 0
      ? ok
      : fail(`No ranges supplied, but the input is ${source.length} units long — the whole file is unaccounted for.`);
  }

  // Ordering is checked before coverage so that a codec emitting entities in the
  // wrong order is told exactly that, rather than being told about "unaccounted
  // text" — which is what an out-of-order list looks like to a coverage walk,
  // and which sends the reader hunting for a missing range that is right there.
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (current.start < previous.start) {
      return fail(
        `${describeRange(current)} is supplied after ${describeRange(previous)} but starts earlier. ` +
          `Ranges must be given in position order.`,
      );
    }
  }

  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) {
      return fail(
        `${describeRange(range)} overlaps the previous range, which ended at ${cursor}. Ranges must not overlap.`,
      );
    }
    if (range.start > cursor) {
      return fail(
        `Unaccounted text at [${cursor}, ${range.start}) before ${describeRange(range)}: ${excerpt(source, cursor)}. ` +
          `Every region of the file must belong to an entity range or to an explicit gap.`,
      );
    }
    cursor = range.end;
  }

  if (cursor !== source.length) {
    return fail(
      `Unaccounted text at [${cursor}, ${source.length}) after the last range ${describeRange(ranges[ranges.length - 1]!)}: ` +
        `${excerpt(source, cursor)}.`,
    );
  }

  // Belt and braces: the arithmetic above implies this, but reconstructing the
  // text catches a range whose bounds are right while its label lies about what
  // it covers, and costs nothing at fixture scale.
  const rebuilt = ranges.map((range) => source.slice(range.start, range.end)).join("");
  if (rebuilt !== source) {
    return fail("Concatenating the ranges did not reproduce the source text.");
  }

  return ok;
}

/** {@link checkRangePartition}, as a throwing assertion. */
export function assertRangePartition(source: string, ranges: readonly LabeledRange[]): void {
  const result = checkRangePartition(source, ranges);
  if (!result.ok) throw new Error(`Range partition violated: ${result.message}`);
}

// -- Property 2: scoped mutation ---------------------------------------------

/**
 * Check that `produced` differs from `original` only inside `declared`.
 *
 * Every byte-preservation claim in this project rests on this. An operation
 * declares the ranges it intends to rewrite; everything outside them — comment
 * placement, key order, quoting style, blank lines, line endings — must survive
 * untouched. A writer that re-serializes rather than splices fails here, which
 * is the whole point.
 *
 * `declared` is in **original** coordinates. The produced text may be a
 * different length, since a splice shifts everything after it.
 *
 * The check compares the complement — the segments *outside* the declared
 * ranges. With a single declared range the arithmetic is exact. With several,
 * the replacement lengths are individually unknown, so the complement segments
 * are matched in order, anchored at both ends; a decomposition exists exactly
 * when the outside text survived in order, which is the property being asserted.
 */
export function checkOnlyRangesChanged(
  original: string,
  produced: string,
  declared: readonly LabeledRange[],
): RangeCheck {
  const sorted = [...declared].sort((left, right) => left.start - right.start);

  for (const range of sorted) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
      return fail(`${describeRange(range)} is not an integer range.`);
    }
    if (range.end < range.start) return fail(`${describeRange(range)} is inverted.`);
    if (range.start < 0 || range.end > original.length) {
      return fail(`${describeRange(range)} lies outside the original text (length ${original.length}).`);
    }
  }

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end) {
      return fail(`Declared ranges overlap: ${describeRange(sorted[index - 1]!)} and ${describeRange(sorted[index]!)}.`);
    }
  }

  // The complement: everything the operation promised not to touch.
  const complement: SourceRange[] = [];
  let cursor = 0;
  for (const range of sorted) {
    complement.push({ start: cursor, end: range.start });
    cursor = range.end;
  }
  complement.push({ start: cursor, end: original.length });

  if (sorted.length === 0) {
    return original === produced
      ? ok
      : fail(describeFirstDivergence(original, produced, "No ranges were declared, so the text had to be unchanged"));
  }

  const segments = complement.map((range) => original.slice(range.start, range.end));

  // Anchor the head. Anything wrong before the first declared range shows up
  // here with exact coordinates.
  const head = segments[0]!;
  if (!produced.startsWith(head)) {
    return fail(
      describeFirstDivergence(head, produced.slice(0, head.length), `Text before ${describeRange(sorted[0]!)} changed`),
    );
  }

  // Anchor the tail.
  const tail = segments[segments.length - 1]!;
  if (tail.length > 0 && !produced.endsWith(tail)) {
    return fail(
      describeFirstDivergence(
        tail,
        produced.slice(Math.max(0, produced.length - tail.length)),
        `Text after ${describeRange(sorted[sorted.length - 1]!)} changed`,
      ),
    );
  }

  if (sorted.length === 1) {
    // Exact: with one declared range the replacement is everything between the
    // two anchors, so the lengths determine it completely.
    const replacementLength = produced.length - head.length - tail.length;
    if (replacementLength < 0) {
      return fail(
        `Produced text is too short to contain the unchanged regions around ${describeRange(sorted[0]!)}: ` +
          `expected at least ${head.length + tail.length} units, got ${produced.length}.`,
      );
    }
    return ok;
  }

  // Several ranges: match each interior segment in order. Taking the earliest
  // match is sound for the existence question, and a segment that no longer
  // appears verbatim is exactly the reformatting this harness exists to catch.
  let searchFrom = head.length;
  for (let index = 1; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (segment.length === 0) continue;
    const found = produced.indexOf(segment, searchFrom);
    if (found < 0) {
      return fail(
        `Text between ${describeRange(sorted[index - 1]!)} and ${describeRange(sorted[index]!)} was changed or reordered. ` +
          `Expected to find ${excerpt(segment, 0)} unchanged after position ${searchFrom} of the produced text.`,
      );
    }
    searchFrom = found + segment.length;
  }

  if (tail.length > 0 && produced.length - tail.length < searchFrom) {
    return fail("Unchanged regions overlap in the produced text — the declared ranges do not explain the result.");
  }

  return ok;
}

/** Report the first differing position with surrounding context. */
function describeFirstDivergence(expected: string, actual: string, prefix: string): string {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) index += 1;

  if (index === limit && expected.length === actual.length) {
    return `${prefix}, but no differing character was found — lengths and content match.`;
  }

  const expectedChar = index < expected.length ? JSON.stringify(expected[index]) : "end of text";
  const actualChar = index < actual.length ? JSON.stringify(actual[index]) : "end of text";
  return (
    `${prefix} at offset ${index}: expected ${expectedChar}, found ${actualChar}. ` +
    `Expected ${excerpt(expected, Math.max(0, index - 8))}, found ${excerpt(actual, Math.max(0, index - 8))}.`
  );
}

/** {@link checkOnlyRangesChanged}, as a throwing assertion. */
export function assertOnlyRangesChanged(
  original: string,
  produced: string,
  declared: readonly LabeledRange[],
): void {
  const result = checkOnlyRangesChanged(original, produced, declared);
  if (!result.ok) throw new Error(`Write scope violated: ${result.message}`);
}

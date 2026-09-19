/**
 * Section 13.5 — generated views, bounded by markers.
 *
 * ## Why a bounded section and not a regenerated file
 *
 * `patterns/INDEX.md` already has an owner: `runPatternAdd` appends a row to
 * it, and `src/drift/checkers/index-sync.ts` cross-references the table against
 * the files on disk. Regenerating the whole file would collide with both. So a
 * generated view is a **delimited section inside** a file, everything outside
 * the markers is not in the plan's declared ranges, and P5's write-scope
 * enforcement refuses any attempt to touch it. The enforcement does the work,
 * not this module's care.
 *
 * ## Deterministic, so drift means drift
 *
 * The rendered block is a pure function of the entities it summarizes, sorted
 * by a total order over content. If it were not, `GENERATED_VIEW_DRIFT` would
 * fire on runs where nothing changed, and a diagnostic that cries wolf is a
 * diagnostic people turn off.
 */
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import type { WikiEntityType } from "../model/entity.js";
import type { InventoryFile, ScaffoldInventory } from "./inventory.js";

/** The delimiters. Deliberately visible, so a human editing knows the rule. */
export const GENERATED_BEGIN = "<!-- mex:generated:begin -->";
export const GENERATED_END = "<!-- mex:generated:end -->";

/** One row of a generated view. */
export interface GeneratedRow {
  id: EntityId;
  type: WikiEntityType;
  title: string;
  /** Scaffold-relative path of the file the entity lives in. */
  file: string;
}

export interface GeneratedRegion {
  /** Offset of the first character of `GENERATED_BEGIN`. */
  start: number;
  /** Offset just past `GENERATED_END`. */
  end: number;
  /** The text between the markers, exclusive of both. */
  body: string;
}

/** Locate the generated region, or null when the file has none. */
export function findGeneratedRegion(text: string): GeneratedRegion | null {
  const start = text.indexOf(GENERATED_BEGIN);
  if (start === -1) return null;
  const bodyStart = start + GENERATED_BEGIN.length;
  const end = text.indexOf(GENERATED_END, bodyStart);
  if (end === -1) return null;
  return { start, end: end + GENERATED_END.length, body: text.slice(bodyStart, end) };
}

/** Rows for a generated view of one entity type, in a total content order. */
export function rowsFor(inventory: ScaffoldInventory, type: WikiEntityType): GeneratedRow[] {
  const rows: GeneratedRow[] = [];
  for (const file of inventory.files) {
    for (const entry of file.parsed.entities) {
      if (entry.entity.type !== type) continue;
      rows.push({ id: entry.entity.id, type: entry.entity.type, title: entry.entity.title, file: file.path });
    }
  }
  // File then title then id: a total order over content, so two scaffolds with
  // the same entities render the same block regardless of walk order.
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/**
 * Render the block, markers included.
 *
 * `eol` is the containing file's own terminator. A generated block written with
 * LF into a CRLF file leaves mixed terminators inside the one region a scope
 * check cannot see into, which is finding 42's failure repeated in a new place.
 */
export function renderGeneratedView(rows: readonly GeneratedRow[], eol = "\n"): string {
  const lines = [GENERATED_BEGIN, "", "| Entity | Where |", "|---|---|"];
  for (const row of rows) lines.push(`| ${row.title} | \`${row.file}\` |`);
  if (rows.length === 0) lines.push("| _none yet_ | |");
  lines.push("", GENERATED_END);
  return lines.join(eol);
}

/**
 * The edit that would refresh the block, in the file's own coordinates.
 *
 * Zero-width outside the markers by construction: `start` is the first
 * character of `GENERATED_BEGIN` and `end` is just past `GENERATED_END`, so
 * the declared range has an empty intersection with every other byte in the
 * file. That is what makes section 13.5's "manually authored content outside
 * generated markers must remain untouched" a structural property rather than a
 * promise — and `checkOnlyRangesChanged` is what proves it, over the whole
 * file, in the test beside this.
 *
 * **Nothing here applies it.** See the handoff: applying it needs either a
 * twelfth operation type or P9's command surface, and every one of the eleven
 * acts on an *entity*, while a generated view belongs to a file that section
 * 13.2 deliberately gives none.
 */
export function generatedViewEdit(
  file: InventoryFile,
  inventory: ScaffoldInventory,
  type: WikiEntityType,
  eol = "\n",
): { start: number; end: number; text: string; label: string } | null {
  const region = findGeneratedRegion(file.text);
  if (region === null) return null;
  return {
    start: region.start,
    end: region.end,
    text: renderGeneratedView(rowsFor(inventory, type), eol),
    label: `generated ${type} view in ${file.path}`,
  };
}

export interface GeneratedViewPlan {
  file: string;
  /** The region as it is now. */
  region: GeneratedRegion;
  /** What it should contain. */
  rendered: string;
  /** True when the two differ, so the file needs rewriting. */
  stale: boolean;
  diagnostics: WikiDiagnostic[];
}

/**
 * Compare a file's generated region against what it should hold.
 *
 * `GENERATED_VIEW_DRIFT` is **info** severity and it fires on a mismatch — a
 * block that was hand-edited since it was written, or one whose entities have
 * moved underneath it. It is not an error: the user's edit is still there, and
 * regenerating is their call.
 */
export function planGeneratedView(
  file: InventoryFile,
  inventory: ScaffoldInventory,
  type: WikiEntityType,
  eol = "\n",
): GeneratedViewPlan | null {
  const region = findGeneratedRegion(file.text);
  if (region === null) return null;

  const rendered = renderGeneratedView(rowsFor(inventory, type), eol);
  const current = file.text.slice(region.start, region.end);
  const stale = current !== rendered;

  return {
    file: file.path,
    region,
    rendered,
    stale,
    diagnostics: stale
      ? [
          diagnostic(
            "GENERATED_VIEW_DRIFT",
            `The generated section in ${file.path} no longer matches the ${type} entities in the scaffold. ` +
              "Nothing outside the markers was read or will be written.",
            { file: file.path },
          ),
        ]
      : [],
  };
}

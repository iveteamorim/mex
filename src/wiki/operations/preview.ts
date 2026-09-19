/**
 * §11.3 step 7 — the exact diff, and the hash that binds it to a tree.
 *
 * The diff is rendered from the plan's **own declared edits**, not by comparing
 * two texts after the fact. A reconstructed diff can differ from what the plan
 * declared — it will happily find a smaller, prettier change that happens to
 * produce the same output — and then a reviewer approves one thing while apply
 * performs another. Here the two cannot come apart: the hunks *are* the edits.
 *
 * The preview hash exists so an approved preview cannot be applied against a
 * different tree than the one it was previewed on. It covers, in order: the
 * operation, the payload, and for every file in path order its base version and
 * the exact bytes proposed. **Order matters** — a hash over an unordered set is
 * a hash that changes when nothing did, which is the same as no hash at all,
 * because the first spurious mismatch teaches everyone to pass `force`.
 */

import { createHash } from "node:crypto";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import type { PatchEdit } from "../markdown/patch.js";
import type { PlannedFileEdit, RevisionChange, WikiPatchPlan } from "./plan.js";

/** One changed region, in lines, with the text on both sides. */
export interface DiffHunk {
  label: string;
  /** 1-based line of the first changed line in the original. */
  startLine: number;
  removed: string[];
  added: string[];
}

export interface FileDiff {
  path: string;
  existed: boolean;
  hunks: DiffHunk[];
  /** Net change in UTF-16 code units, for a one-line summary. */
  delta: number;
}

export interface WikiPreview {
  opId: string;
  type: string;
  /** Binds this preview to the exact tree it was produced against. */
  previewHash: string;
  files: FileDiff[];
  revisions: RevisionChange[];
  createdIds: string[];
  diagnostics: WikiDiagnostic[];
}

/** 1-based line number of `offset`, counting the terminators before it. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) line += 1;
  }
  return line;
}

/** Split a region into lines, keeping an empty replacement as no lines at all. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function hunkOf(baseText: string, edit: PatchEdit): DiffHunk {
  return {
    label: edit.label,
    startLine: lineOf(baseText, edit.start),
    removed: linesOf(baseText.slice(edit.start, edit.end)),
    added: linesOf(edit.text),
  };
}

function diffOf(file: PlannedFileEdit): FileDiff {
  return {
    path: file.path,
    existed: file.existed,
    hunks: file.edits.map((edit) => hunkOf(file.baseText, edit)),
    delta: file.proposedText.length - file.baseText.length,
  };
}

/**
 * The ordered digest a plan is bound by.
 *
 * Fields are separated by U+0000, which cannot occur in a path or a hex digest,
 * so two different plans cannot render to the same hash input. **Written as a
 * unicode escape, never as a literal byte** — a raw NUL makes Git treat this
 * file as binary, which costs a readable diff, line-ending normalization and a
 * three-way merge. See `payloadHashOf` in `plan.ts` for the same note.
 */
export function previewHashOf(plan: WikiPatchPlan): string {
  const hash = createHash("sha256");
  hash.update(`${plan.type}\u0000${plan.payloadHash}\u0000`);
  for (const file of [...plan.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    // The base version as well as the proposal: applying previewed bytes to a
    // file that has since moved is exactly what this is here to stop.
    hash.update(`${file.path}\u0000${file.existed ? file.baseFileHash : ""}\u0000`);
    hash.update(file.proposedText);
    hash.update("\u0000");
  }
  hash.update(`${plan.audit.path}\u0000${plan.audit.baseFileHash ?? ""}\u0000`);
  hash.update(plan.audit.proposedText);
  hash.update("\u0000");
  return hash.digest("hex");
}

/** Step 7. Pure: nothing is read, nothing is written. */
export function previewPlan(plan: WikiPatchPlan): WikiPreview {
  return {
    opId: plan.opId,
    type: plan.type,
    previewHash: previewHashOf(plan),
    files: plan.files.map(diffOf),
    revisions: plan.revisions,
    createdIds: [...plan.createdIds],
    diagnostics: plan.diagnostics,
  };
}

/** A unified-ish rendering, for a CLI dry run. */
export function renderPreview(preview: WikiPreview): string {
  const lines: string[] = [];
  for (const file of preview.files) {
    lines.push(`--- ${file.existed ? file.path : "/dev/null"}`);
    lines.push(`+++ ${file.path}`);
    for (const hunk of file.hunks) {
      lines.push(`@@ line ${hunk.startLine} @@ ${hunk.label}`);
      for (const removed of hunk.removed) lines.push(`-${removed}`);
      for (const added of hunk.added) lines.push(`+${added}`);
    }
  }
  return lines.join("\n");
}

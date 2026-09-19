/**
 * Deterministic source reads from the repository, for context extraction.
 *
 * The only filesystem access in the synthesis pipeline, and it is read-only:
 * nothing under `src/wiki/synthesis/` writes a byte, and the architecture lint
 * enforces that for the whole directory.
 *
 * **Containment is checked, and it is not paranoia about the graph.** A node's
 * `filePath` comes from the code graph, which is trustworthy, but it is also a
 * string that reaches this function from three call sites and one of them will
 * eventually be a caller-supplied cluster filter. The check reuses P5's
 * `checkContainment` rather than writing a second rule, which is finding 29.9's
 * discipline: the read side and the write side must answer the same way about
 * the same path, and they do that by sharing the function.
 */

import { readFileSync } from "node:fs";
import { checkContainment } from "../operations/paths.js";
import { normalizeRepoPath } from "./cluster.js";

/**
 * Read a file's lines, or null when it is missing, unreadable, or outside the
 * repository root.
 *
 * Split once here so a caller can slice many spans out of one file without
 * re-reading it — a cluster routinely has ten symbols in one file.
 */
export function readFileLines(repoRoot: string, filePath: string): string[] | null {
  const normalized = normalizeRepoPath(filePath);
  const containment = checkContainment(repoRoot, normalized);
  if (containment.diagnostic !== null) return null;
  try {
    return readFileSync(containment.resolved, "utf-8").split("\n");
  } catch {
    return null;
  }
}

/** A resolved slice with the clamped, 1-indexed bounds it actually covers. */
export interface SourceSlice {
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Slice `[startLine, endLine]` inclusive, padded by `contextLines` and clamped
 * to the file.
 *
 * Returns null for an invalid span or a blank result — which is what routes a
 * node whose span the extractor could not produce onto the file-level
 * fallback rather than into an empty code block.
 *
 * Pure, over an already-read array.
 */
export function sliceLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  contextLines = 0,
): SourceSlice | null {
  const total = lines.length;
  if (total === 0) return null;
  if (startLine <= 0 || endLine < startLine || startLine > total) return null;

  const pad = Math.max(0, contextLines);
  const from = Math.max(1, startLine - pad);
  const to = Math.min(total, endLine + pad);
  const content = lines.slice(from - 1, to).join("\n");
  if (content.trim() === "") return null;

  return { content, startLine: from, endLine: to };
}

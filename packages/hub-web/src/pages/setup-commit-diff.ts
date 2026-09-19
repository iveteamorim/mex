export const MAX_FORMATTED_DIFF_LINES = 1_500;

export type SetupDiffRow =
  | { kind: "addition" | "deletion" | "context"; text: string; oldLine: number | null; newLine: number | null }
  | { kind: "hunk"; text: string }
  | { kind: "notice"; text: string };

export type SetupDiff =
  | { formatted: true; rows: SetupDiffRow[]; added: number; deleted: number }
  | { formatted: false; reason: "truncated" | "large" | "malformed" | "empty" };

/** Parse only complete, single-file unified diffs. Unknown content stays visible in the raw fallback. */
export function parseSetupDiff(diff: string, truncated = false, lineLimit = MAX_FORMATTED_DIFF_LINES): SetupDiff {
  if (truncated) return { formatted: false, reason: "truncated" };
  if (!diff) return { formatted: false, reason: "empty" };
  const lines = diff.split("\n", lineLimit + 2);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > lineLimit) return { formatted: false, reason: "large" };
  const malformed: SetupDiff = { formatted: false, reason: "malformed" };
  const rows: SetupDiffRow[] = [];
  let added = 0;
  let deleted = 0;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  let oldHeader = false;
  let newHeader = false;
  let canMarkNewline = false;

  for (const [index, line] of lines.entries()) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
    if (hunk) {
      if (oldRemaining || newRemaining || oldHeader !== newHeader) return malformed;
      const nextOld = Number(hunk[1]);
      const nextNew = Number(hunk[3]);
      const oldCount = Number(hunk[2] ?? 1);
      const newCount = Number(hunk[4] ?? 1);
      if (![nextOld, nextNew, oldCount, newCount, nextOld + oldCount, nextNew + newCount].every(Number.isSafeInteger)
        || (oldCount > 0 && nextOld === 0) || (newCount > 0 && nextNew === 0)
        || (inHunk && (nextOld < oldLine || nextNew < newLine))) return malformed;
      oldLine = nextOld;
      newLine = nextNew;
      oldRemaining = oldCount;
      newRemaining = newCount;
      inHunk = true;
      canMarkNewline = false;
      rows.push({ kind: "hunk", text: line });
      continue;
    }

    if (inHunk) {
      if (line === "\\ No newline at end of file") {
        if (!canMarkNewline) return malformed;
        rows.push({ kind: "notice", text: "No newline at end of file" });
        canMarkNewline = false;
        continue;
      }
      // Inside a hunk even +++ / --- / @@-like file content belongs to the source.
      const marker = line[0];
      if (marker === "+" && newRemaining > 0) {
        rows.push({ kind: "addition", text: line.slice(1), oldLine: null, newLine: newLine++ });
        newRemaining--;
        added++;
      } else if (marker === "-" && oldRemaining > 0) {
        rows.push({ kind: "deletion", text: line.slice(1), oldLine: oldLine++, newLine: null });
        oldRemaining--;
        deleted++;
      } else if (marker === " " && oldRemaining > 0 && newRemaining > 0) {
        rows.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
        oldRemaining--;
        newRemaining--;
      } else return malformed;
      canMarkNewline = true;
      continue;
    }

    if (/^diff --git .+$/u.test(line) && index === 0) continue;
    if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/u.test(line)) continue;
    if (/^(?:old mode|new mode|new file mode|deleted file mode) [0-7]{6}$/u.test(line)) {
      rows.push({ kind: "notice", text: line });
      continue;
    }
    if (line.startsWith("--- ") && !oldHeader && !newHeader) { oldHeader = true; continue; }
    if (line.startsWith("+++ ") && oldHeader && !newHeader) { newHeader = true; continue; }
    return malformed;
  }

  if (oldRemaining || newRemaining || oldHeader !== newHeader || rows.length === 0 || (oldHeader && !inHunk)) return malformed;
  return { formatted: true, rows, added, deleted };
}

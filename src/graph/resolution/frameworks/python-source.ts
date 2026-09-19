/**
 * Line-scanning helpers shared by the Python framework resolvers.
 *
 * Both Flask and FastAPI declare routes as decorators above a `def`, so both
 * need the same three things before a scan can trust what it reads: comments
 * and docstrings blanked, physical lines joined into logical ones, and a
 * call's arguments read with balanced parentheses. These were written for the
 * Flask resolver (#112); FastAPI needs them identically (#111), so they live
 * here rather than in duplicate.
 */

/**
 * Extract balanced argument text starting at the `(` at `open`, string-aware
 * so quotes never skew depth. Returns null when the call does not close.
 */
export function readBalanced(line: string, open: number): string | null {
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return line.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Join physical lines whose parens are still open into one logical line
 * (the text, plus the 0-based index of its first physical line). Black
 * routinely splits long decorators over several lines; without this those
 * routes produce nothing (#177 review). Paren depth is tracked string-aware
 * per physical line; a line that opens more than it closes continues.
 */
export function mergeLogicalLines(content: string): Array<{ text: string; line: number }> {
  const physical = content.split(/\r?\n/);
  const out: Array<{ text: string; line: number }> = [];
  let buffer: string | null = null;
  let bufferLine = 0;
  let depth = 0;
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i]!;
    let openCount = 0;
    let closeCount = 0;
    let quote: string | null = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) {
        if (ch === quote && line[j - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === "\"" || ch === "'") { quote = ch; continue; }
      if (ch === "(") openCount++;
      else if (ch === ")") closeCount++;
    }
    const delta = openCount - closeCount;
    if (buffer === null) {
      if (delta > 0) {
        buffer = line;
        bufferLine = i;
        depth = delta;
      } else {
        out.push({ text: line, line: i });
      }
      continue;
    }
    buffer += " " + line.trim();
    depth += delta;
    if (depth <= 0) {
      out.push({ text: buffer, line: bufferLine });
      buffer = null;
      depth = 0;
    }
  }
  if (buffer !== null) out.push({ text: buffer, line: bufferLine });
  return out;
}

/**
 * Blank `#` comments and triple-quoted strings with spaces (newlines kept),
 * so every offset and line number stays valid against the original. Single
 * and double quoted strings are preserved — decorator arguments live in
 * them, and they cannot span lines.
 */
export function blankCommentsAndDocstrings(content: string): string {
  const out: string[] = [];
  type State = "code" | "comment" | "string" | "docstring";
  let state: State = "code";
  let quote = "";
  let docQuote = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    const after = content[i + 2];
    if (state === "code") {
      if (ch === "#") { state = "comment"; out.push(" "); continue; }
      if ((ch === "\"" || ch === "'") && ch === next && ch === after) {
        state = "docstring";
        docQuote = ch;
        out.push("   ");
        i += 2;
        continue;
      }
      if (ch === "\"" || ch === "'") { state = "string"; quote = ch; out.push(ch); continue; }
      out.push(ch);
      continue;
    }
    if (state === "comment") {
      if (ch === "\n") { state = "code"; out.push("\n"); } else out.push(" ");
      continue;
    }
    if (state === "string") {
      const escaped = content[i - 1] === "\\";
      if (ch === quote && !escaped) { state = "code"; out.push(ch); continue; }
      if (ch === "\n") { state = "code"; out.push("\n"); continue; }
      out.push(ch);
      continue;
    }
    // docstring: blank everything until the closing triple quote.
    if (content.startsWith(docQuote.repeat(3), i) && content[i - 1] !== "\\") {
      state = "code";
      out.push("   ");
      i += 2;
      continue;
    }
    out.push(ch === "\n" ? "\n" : " ");
  }
  return out.join("");
}

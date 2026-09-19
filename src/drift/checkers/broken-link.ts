import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { toPosix } from "../../paths.js";
import type { DriftIssue } from "../../types.js";

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

/**
 * Remove the commented-out spans of one line, continuing a comment that opened
 * on an earlier line. Markdown renders nothing inside `<!-- -->`, so a link
 * there is illustrative text rather than a claim the scaffold makes -- the
 * shipped `patterns/INDEX.md` documents its own table format that way, and
 * scanning it made every fresh scaffold flag links to files that were never
 * meant to exist. See https://github.com/mex-memory/mex/issues/108
 *
 * An unterminated comment runs to the end of the file, matching how a renderer
 * treats it: the rest of the document is swallowed rather than shown.
 */
function stripHtmlComments(
  line: string,
  inComment: boolean
): { text: string; inComment: boolean } {
  let text = "";
  let index = 0;
  let open = inComment;

  while (index < line.length) {
    if (open) {
      const close = line.indexOf(COMMENT_CLOSE, index);
      if (close === -1) break;
      open = false;
      index = close + COMMENT_CLOSE.length;
      continue;
    }

    const start = line.indexOf(COMMENT_OPEN, index);
    if (start === -1) {
      text += line.slice(index);
      break;
    }
    text += line.slice(index, start);
    open = true;
    index = start + COMMENT_OPEN.length;
  }

  return { text, inComment: open };
}

/** Scan scaffold markdown for local links whose target file does not exist. */
export function checkBrokenLinks(
  scaffoldFiles: string[],
  projectRoot: string,
  scaffoldRoot: string
): DriftIssue[] {
  const issues: DriftIssue[] = [];

  for (const filePath of scaffoldFiles) {
    const source = toPosix(relative(projectRoot, filePath));
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const fileDir = dirname(filePath);
    const lines = content.split("\n");
    let inFence = false;
    let inComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // A fence marker inside a comment is commented-out text, not a fence, so
      // the fence state only advances on lines the renderer would show.
      if (!inComment) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
      }

      // Inline code is stripped first so a documented marker -- `<!--` written
      // as an example -- cannot open a comment that swallows the rest of the
      // file. Inside an open comment there is nothing to protect.
      const withoutInlineCode = inComment ? line : line.replace(/`[^`]+`/g, "");
      const stripped = stripHtmlComments(withoutInlineCode, inComment);
      inComment = stripped.inComment;
      const scanLine = stripped.text;

      LINK_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = LINK_RE.exec(scanLine)) !== null) {
        const rawTarget = match[2].trim();
        const target = normalizeLinkTarget(rawTarget);
        if (!target || isExternalOrAnchor(target)) continue;

        if (!linkTargetExists(target, fileDir, projectRoot, scaffoldRoot)) {
          const isPattern = source.includes("patterns/");
          issues.push({
            code: "BROKEN_LINK",
            severity: isPattern ? "warning" : "error",
            file: source,
            line: i + 1,
            message: `Markdown link target does not exist: ${target}`,
          });
        }
      }
    }
  }

  return issues;
}

function normalizeLinkTarget(raw: string): string {
  let target = raw.replace(/^<|>$/g, "").trim();
  const titleSplit = target.match(/^([^\s]+)(?:\s+["'].+["'])?$/);
  if (titleSplit) target = titleSplit[1];
  target = target.replace(/[#?].*$/, "");
  return target;
}

function isExternalOrAnchor(target: string): boolean {
  return (
    /^https?:\/\//i.test(target) ||
    /^mailto:/i.test(target) ||
    /^mex:\/\//i.test(target) ||
    target.startsWith("#")
  );
}

function linkTargetExists(
  target: string,
  fileDir: string,
  projectRoot: string,
  scaffoldRoot: string
): boolean {
  const fromFile = resolve(fileDir, target);
  if (existsSync(fromFile)) return true;

  if (existsSync(resolve(projectRoot, target))) return true;

  if (scaffoldRoot !== projectRoot && existsSync(resolve(scaffoldRoot, target))) {
    return true;
  }

  if (target.startsWith(".mex/")) {
    const withoutPrefix = target.slice(".mex/".length);
    if (existsSync(resolve(projectRoot, withoutPrefix))) return true;
  }

  return false;
}

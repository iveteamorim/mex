import { memo } from "react";
import type { SetupDiff } from "./setup-commit-diff";
import styles from "../styles/setup.module.css";

const fallbackNotice = {
  truncated: "This diff was shortened. Showing the available raw diff; review the full file before continuing.",
  large: "Showing the complete raw diff to keep this review responsive.",
  malformed: "This diff could not be formatted safely. Showing the complete raw diff.",
  empty: "No text diff is available for this file.",
};

export const SetupCommitDiff = memo(function SetupCommitDiff({ path, diff, parsed, expanded }: {
  path: string;
  diff: string;
  parsed: SetupDiff;
  expanded: boolean;
}) {
  return (
    <div className={styles.commitDiff} role="region" aria-label={`Diff for ${path}`} tabIndex={expanded ? 0 : undefined}>
      {expanded ? parsed.formatted ? (
        <table className={styles.commitDiffTable}>
          <thead className={styles.commitDiffHead}>
            <tr><th scope="col">Old line</th><th scope="col">New line</th><th scope="col">Change</th><th scope="col">Content</th></tr>
          </thead>
          <tbody>
            {parsed.rows.map((row, index) => (
              <tr key={index} data-diff-kind={row.kind}>
                {row.kind === "hunk" || row.kind === "notice" ? (
                  <td colSpan={4} className={styles.commitDiffDivider}>{row.kind === "notice" ? noticeLabel(row.text) : row.text}</td>
                ) : (
                  <>
                    <td className={styles.commitDiffNumber} data-line-side="old">{row.oldLine}</td>
                    <td className={styles.commitDiffNumber} data-line-side="new">{row.newLine}</td>
                    <td className={styles.commitDiffMarker} aria-label={row.kind === "addition" ? "Added" : row.kind === "deletion" ? "Removed" : "Unchanged"}>{row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : " "}</td>
                    <td className={styles.commitDiffContent} data-diff-content="">{row.text}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <p className={styles.commitDiffNotice}>{fallbackNotice[parsed.reason]}</p>
          {diff ? <pre className={styles.commitRawDiff}>{diff}</pre> : null}
        </>
      ) : null}
    </div>
  );
});

function noticeLabel(text: string): string {
  const mode = /^(old mode|new mode|new file mode|deleted file mode) ([0-7]{6})$/u.exec(text);
  if (!mode) return text;
  const executable = mode[2] === "100755";
  if (mode[1] === "new file mode") return `${executable ? "New executable file" : "New file"} (mode ${mode[2]})`;
  if (mode[1] === "deleted file mode") return `Deleted ${executable ? "executable file" : "file"} (mode ${mode[2]})`;
  if (mode[1] === "old mode") return `Previous file permissions: ${mode[2]}`;
  return `File permissions changed to ${mode[2]}${executable ? " (executable)" : ""}`;
}

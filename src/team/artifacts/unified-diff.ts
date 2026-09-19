import type { RepoRelativePath } from "../contracts/shared.js";

/** Deterministic whole-file unified diff; exact, intentionally not minimal. */
export function canonicalFileDiff(
  path: RepoRelativePath,
  before: string | null,
  after: string,
): string {
  if (before === after) return "";
  const afterLines = lines(after);
  if (before === null) {
    return [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${afterLines.length} @@`,
      ...afterLines.map((line) => `+${line}`),
      "",
    ].join("\n");
  }

  const beforeLines = lines(before);
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function lines(value: string): readonly string[] {
  const withoutFinalNewline = value.endsWith("\n") ? value.slice(0, -1) : value;
  return withoutFinalNewline === "" ? [] : withoutFinalNewline.split("\n");
}

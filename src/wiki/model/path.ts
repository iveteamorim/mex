/**
 * Canonical repository/scaffold path syntax stored in Wiki Markdown.
 *
 * This is deliberately lexical. Filesystem containment still belongs to the
 * repository-bound operations/index layers, but unsafe path-shaped metadata
 * must never be accepted into canonical bytes in the first place.
 */
export function isCanonicalRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

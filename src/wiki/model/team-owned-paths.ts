/**
 * Canonical TeamWorkflowPort-owned Markdown roots inside the Wiki scaffold.
 *
 * This classifier is pure so query and operation layers can share the
 * ownership boundary without making reads depend on the write pipeline.
 */
export const TEAM_OWNED_READ_ONLY_PATHS = [
  "team/**",
  "workstreams/**",
  "inbox/**",
  "relays/**",
  "playbooks/**",
  "events/activity/**",
] as const;

const TEAM_OWNED_PREFIXES = TEAM_OWNED_READ_ONLY_PATHS.map(
  (pattern) => pattern.slice(0, -2),
);

/** True for a scaffold-relative path below one invariant Team-owned root. */
export function isTeamOwnedReadOnlyPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, "/").toLowerCase();
  return TEAM_OWNED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

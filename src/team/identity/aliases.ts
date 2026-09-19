import type { GitIdentity } from "../contracts/git.js";
import type { MemberGitAlias, TeamMember } from "../contracts/workflow.js";

export function normalizeGitEmail(value: string | null | undefined): string | null {
  const normalized = normalizeIdentityText(value);
  return normalized === null ? null : normalized.toLowerCase();
}

export function normalizeGitName(value: string | null | undefined): string | null {
  return normalizeIdentityText(value);
}

export function membersMatchingEmail(
  members: readonly TeamMember[],
  email: string,
): readonly TeamMember[] {
  const expected = normalizeGitEmail(email);
  if (expected === null) return [];
  return uniqueMembers(members.filter((member) => member.gitAliases.some(
    (alias) => normalizeGitEmail(alias.email) === expected,
  )));
}

export function membersMatchingName(
  members: readonly TeamMember[],
  name: string,
): readonly TeamMember[] {
  const expected = normalizeGitName(name);
  if (expected === null) return [];
  return uniqueMembers(members.filter((member) => member.gitAliases.some(
    (alias) => normalizeGitName(alias.name) === expected,
  )));
}

export function normalizeGitIdentity(identity: GitIdentity | MemberGitAlias): GitIdentity | null {
  const name = normalizeGitName(identity.name);
  const email = normalizeIdentityText(identity.email);
  return name === null && email === null ? null : { name, email };
}

function normalizeIdentityText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().normalize("NFC");
  return normalized.length === 0 ? null : normalized;
}

function uniqueMembers(members: readonly TeamMember[]): readonly TeamMember[] {
  const byId = new Map(members.map((member) => [member.ref.id, member]));
  return [...byId.values()].sort((left, right) => compareCodePoints(left.ref.id, right.ref.id));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

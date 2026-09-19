import { describe, expect, it } from "vitest";
import type { Revision } from "../../contracts/shared.js";
import type { MemberGitAlias, TeamMember } from "../../contracts/workflow.js";
import { generateArtifactId } from "../../artifacts/ulid.js";
import { ActorResolver } from "../actor-resolver.js";
import type { MemberReader } from "../member-repository.js";

const ADA = member(1, "Ada Lovelace", true, [
  { name: "Ada", email: "ada@example.com" },
]);
const GRACE = member(2, "Grace Hopper", true, [
  { name: "Grace", email: "grace@example.com" },
]);
const INACTIVE = member(3, "Inactive Human", false, [
  { name: "Former", email: "former@example.com" },
]);

describe("ActorResolver", () => {
  it("gives an explicitly configured active member absolute precedence", async () => {
    const resolver = new ActorResolver(reader([ADA, GRACE]), {
      getIdentity: async () => ({ name: "Grace", email: "grace@example.com" }),
    });

    await expect(resolver.resolve({
      configuredMemberId: ADA.ref.id,
      gitIdentity: { name: "Grace", email: "grace@example.com" },
    })).resolves.toEqual({
      kind: "member",
      memberId: ADA.ref.id,
      displayName: ADA.displayName,
    });
  });

  it("fails visibly for configured missing or inactive members without Git fallback", async () => {
    const resolver = new ActorResolver(reader([ADA, INACTIVE]), {
      getIdentity: async () => ({ name: "Ada", email: "ada@example.com" }),
    });

    await expect(resolver.resolve({ configuredMemberId: memberId(9) })).rejects.toMatchObject({
      problem: { code: "NOT_FOUND" },
    });
    await expect(resolver.resolve({ configuredMemberId: INACTIVE.ref.id })).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
  });

  it("projects stale configured selections through bounded Git fallback without hiding them", async () => {
    const resolver = new ActorResolver(reader([ADA, INACTIVE]), {
      getIdentity: async () => ({ name: "Ada Fallback", email: "fallback@example.com" }),
    });

    await expect(resolver.resolveCurrentDetailed({
      configuredMemberId: memberId(9),
    })).resolves.toMatchObject({
      source: "git-fallback",
      actor: { kind: "git", name: "Ada Fallback", email: "fallback@example.com" },
      diagnostics: [{ code: "ACTOR_MEMBER_MISSING", severity: "warning" }],
    });
    await expect(resolver.resolveCurrentDetailed({
      configuredMemberId: INACTIVE.ref.id,
    })).resolves.toMatchObject({
      source: "git-fallback",
      actor: { kind: "git", name: "Ada Fallback", email: "fallback@example.com" },
      diagnostics: [{ code: "ACTOR_MEMBER_INACTIVE", severity: "warning" }],
    });
  });

  it("matches a single active member across case-insensitive email and exact name", async () => {
    const resolver = new ActorResolver(reader([ADA, GRACE]));
    const result = await resolver.resolveDetailed({
      gitIdentity: { name: "Ada", email: "ADA@EXAMPLE.COM" },
    });

    expect(result).toMatchObject({
      source: "git-alias",
      actor: { kind: "member", memberId: ADA.ref.id },
      diagnostics: [],
    });
  });

  it("preserves the Git actor when email and name resolve to different active members", async () => {
    const resolver = new ActorResolver(reader([ADA, GRACE]));
    const identity = { name: "Grace", email: "ada@example.com" };

    const result = await resolver.resolveDetailed({ gitIdentity: identity });

    expect(result).toEqual({
      actor: { kind: "git", ...identity },
      source: "git-fallback",
      diagnostics: [{
        code: "ACTOR_ALIAS_AMBIGUOUS",
        severity: "warning",
        message: "Git identity matches multiple active members; preserving the Git fallback identity.",
        detail: { memberIds: [ADA.ref.id, GRACE.ref.id] },
      }],
    });
  });

  it("uses unique exact names, ignores inactive aliases, and preserves raw Git fallback", async () => {
    const resolver = new ActorResolver(reader([ADA, INACTIVE]));
    await expect(resolver.resolve({ gitIdentity: { name: "Ada", email: null } })).resolves.toMatchObject({
      kind: "member",
      memberId: ADA.ref.id,
    });
    await expect(resolver.resolve({ gitIdentity: { name: "ada", email: null } })).resolves.toEqual({
      kind: "git",
      name: "ada",
      email: null,
    });
    await expect(resolver.resolve({ gitIdentity: { name: "Former", email: "former@example.com" } })).resolves.toEqual({
      kind: "git",
      name: "Former",
      email: "former@example.com",
    });
  });

  it("never guesses when aliases are ambiguous", async () => {
    const duplicateName = member(4, "Second Ada", true, [{ name: "Ada", email: "other@example.com" }]);
    const resolver = new ActorResolver(reader([ADA, duplicateName]));
    const result = await resolver.resolveDetailed({ gitIdentity: { name: "Ada", email: null } });

    expect(result.actor).toEqual({ kind: "git", name: "Ada", email: null });
    expect(result.source).toBe("git-fallback");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "ACTOR_ALIAS_AMBIGUOUS" }),
    ]);
  });

  it("uses the Git seam only when identity was not supplied and degrades to unknown visibly", async () => {
    const resolved = new ActorResolver(reader([GRACE]), {
      getIdentity: async () => ({ name: "Grace", email: "grace@example.com" }),
    });
    await expect(resolved.resolve()).resolves.toMatchObject({
      kind: "member",
      memberId: GRACE.ref.id,
    });

    const unavailable = new ActorResolver(reader([ADA]), {
      getIdentity: async () => { throw new Error("not a Git repository"); },
    });
    const result = await unavailable.resolveDetailed();
    expect(result.actor).toEqual({ kind: "unknown" });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "GIT_IDENTITY_UNAVAILABLE" }),
    ]);

    const empty = new ActorResolver(reader([ADA]));
    await expect(empty.resolve({ gitIdentity: { name: null, email: null } })).resolves.toEqual({
      kind: "unknown",
    });
  });

  it("keeps Git actor fields within the canonical 200/320-byte boundaries", async () => {
    const resolver = new ActorResolver(reader([]));
    await expect(resolver.resolveDetailed({
      gitIdentity: { name: "n".repeat(200), email: "e".repeat(320) },
    })).resolves.toMatchObject({
      source: "git-fallback",
      actor: { kind: "git", name: "n".repeat(200), email: "e".repeat(320) },
      diagnostics: [],
    });

    for (const gitIdentity of [
      { name: "n".repeat(201), email: null },
      { name: null, email: "e".repeat(321) },
    ]) {
      await expect(resolver.resolveDetailed({ gitIdentity })).resolves.toEqual({
        source: "unknown",
        actor: { kind: "unknown" },
        diagnostics: [{
          code: "GIT_IDENTITY_INVALID",
          severity: "warning",
          message: "Git identity exceeds the bounded actor contract and was ignored.",
        }],
      });
    }
  });

  it("projects historical actors through current members without rewriting recorded identity", async () => {
    const remapped = member(5, "Ada Current", true, [
      { name: "Ada Old", email: "old@example.com" },
    ]);
    const resolver = new ActorResolver(reader([remapped, INACTIVE]));
    const recordedGit = { kind: "git" as const, name: "Ada Old", email: "old@example.com" };
    const gitProjection = await resolver.resolveHistorical(recordedGit);
    expect(gitProjection.recordedActor).toBe(recordedGit);
    expect(gitProjection.resolvedActor).toMatchObject({
      kind: "member",
      memberId: remapped.ref.id,
      displayName: "Ada Current",
    });

    const recordedMember = {
      kind: "member" as const,
      memberId: remapped.ref.id,
      displayName: "Ada Historical",
    };
    const memberProjection = await resolver.resolveHistorical(recordedMember);
    expect(memberProjection.recordedActor).toBe(recordedMember);
    expect(memberProjection.resolvedActor).toMatchObject({ displayName: "Ada Current" });
    expect(recordedMember.displayName).toBe("Ada Historical");

    const inactive = await resolver.resolveHistorical({
      kind: "member",
      memberId: INACTIVE.ref.id,
      displayName: "Old Display",
    });
    expect(inactive.diagnostics).toEqual([
      expect.objectContaining({ code: "ACTOR_MEMBER_INACTIVE" }),
    ]);
    const missing = await resolver.resolveHistorical({
      kind: "member",
      memberId: memberId(9),
      displayName: "Missing",
    });
    expect(missing.resolvedActor).toMatchObject({ displayName: "Missing" });
    expect(missing.diagnostics).toEqual([
      expect.objectContaining({ code: "ACTOR_MEMBER_MISSING" }),
    ]);
    await expect(resolver.resolveHistorical({ kind: "unknown" })).resolves.toEqual({
      recordedActor: { kind: "unknown" },
      resolvedActor: { kind: "unknown" },
      diagnostics: [],
    });
  });
});

function reader(members: readonly TeamMember[]): MemberReader {
  return {
    get: async (id) => members.find((candidate) => candidate.ref.id === id) ?? null,
    list: async () => members,
  };
}

function member(
  entropy: number,
  displayName: string,
  active: boolean,
  gitAliases: readonly MemberGitAlias[],
): TeamMember {
  const id = memberId(entropy);
  return {
    schemaVersion: 1,
    ref: { id, kind: "member", title: displayName },
    kind: "member",
    sourcePath: `.mex/team/members/${id}.md`,
    revision: "a".repeat(64) as Revision,
    displayName,
    gitAliases,
    active,
  };
}

function memberId(fill: number): string {
  return generateArtifactId("member", {
    now: Date.UTC(2026, 7, 23),
    random: new Uint8Array(10).fill(fill),
  });
}

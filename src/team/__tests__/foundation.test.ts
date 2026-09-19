import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPort } from "../contracts/git.js";
import { TeamIdentityActivityFoundation } from "../foundation.js";

const MEMBER = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const SECOND_EVENT = "event_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const NOW = new Date("2026-08-23T01:02:03.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TeamIdentityActivityFoundation", () => {
  it("uses an explicitly configured active member for immutable activity", async () => {
    const root = temporaryRoot();
    const foundation = createFoundation(root);
    await foundation.members.create({
      id: MEMBER,
      displayName: "Daksh",
      gitAliases: [{ name: "Daksh", email: "daksh@example.test" }],
    });
    foundation.localState.configureMember({ memberId: MEMBER, expectedRevision: null });

    const preview = await foundation.previewActivity({
      action: "member.updated",
      subjects: [{ kind: "file", path: ".mex/team/members/member.md" }],
    });
    expect(preview.actorResolution.source).toBe("configured-member");
    expect(preview.activity.event.actor).toMatchObject({ kind: "member", memberId: MEMBER });

    const stored = await foundation.applyActivity(
      preview,
      preview.activity.previewRevision,
    );
    expect(stored.actor).toEqual(preview.activity.event.actor);
  });

  it("fails visibly when the configured member is missing or inactive", async () => {
    const missingRoot = temporaryRoot();
    const missing = createFoundation(missingRoot);
    missing.localState.configureMember({ memberId: MEMBER, expectedRevision: null });
    await expect(missing.resolveCurrentActor()).rejects.toMatchObject({
      problem: { code: "NOT_FOUND" },
    });

    const inactiveRoot = temporaryRoot();
    const inactive = createFoundation(inactiveRoot);
    await inactive.members.create({ id: MEMBER, displayName: "Inactive", active: false });
    inactive.localState.configureMember({ memberId: MEMBER, expectedRevision: null });
    await expect(inactive.resolveCurrentActor()).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
  });

  it("uses a unique Git alias and falls back without guessing on ambiguity", async () => {
    const root = temporaryRoot();
    const foundation = createFoundation(root);
    await foundation.members.create({
      id: MEMBER,
      displayName: "Daksh",
      gitAliases: [{ name: "Daksh", email: null }],
    });
    expect(await foundation.resolveCurrentActor()).toMatchObject({
      source: "git-alias",
      actor: { kind: "member", memberId: MEMBER },
    });

    await foundation.members.create({
      id: "member_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      displayName: "Other Daksh",
      gitAliases: [{ name: "Daksh", email: null }],
    });
    const ambiguous = await foundation.resolveCurrentActor();
    expect(ambiguous.actor).toEqual({
      kind: "git",
      name: "Daksh",
      email: "daksh@example.test",
    });
    expect(ambiguous.diagnostics).toEqual([
      expect.objectContaining({ code: "ACTOR_ALIAS_AMBIGUOUS" }),
    ]);
  });

  it("rejects apply when the locally resolved actor changed after preview", async () => {
    const root = temporaryRoot();
    const foundation = createFoundation(root);
    const first = await foundation.members.create({ id: MEMBER, displayName: "First" });
    const second = await foundation.members.create({
      id: "member_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      displayName: "Second",
    });
    const selection = foundation.localState.configureMember({
      memberId: first.ref.id,
      expectedRevision: null,
    });
    const preview = await foundation.previewActivity({
      action: "member.updated",
      subjects: [],
    });
    foundation.localState.configureMember({
      memberId: second.ref.id,
      expectedRevision: selection.revision,
    });

    await expect(foundation.applyActivity(
      preview,
      preview.activity.previewRevision,
    )).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(foundation.listActivity().items).toEqual([]);
  });

  it("resolves a historical Git actor through new aliases without rewriting it", async () => {
    const root = temporaryRoot();
    const foundation = createFoundation(root);
    const preview = await foundation.previewActivity({
      action: "member.observed",
      subjects: [],
    });
    expect(preview.activity.event.actor).toEqual({
      kind: "git",
      name: "Daksh",
      email: "daksh@example.test",
    });
    await foundation.applyActivity(preview, preview.activity.previewRevision);

    await foundation.members.create({
      id: MEMBER,
      displayName: "Daksh Current",
      gitAliases: [{ name: "Daksh", email: "daksh@example.test" }],
    });
    const resolved = await foundation.timeline.listResolved();

    expect(resolved.items[0]?.recordedActor).toEqual(preview.activity.event.actor);
    expect(resolved.items[0]?.effectiveActor).toEqual({
      kind: "member",
      memberId: MEMBER,
      displayName: "Daksh Current",
    });
    expect(foundation.listActivity().items[0]?.actor).toEqual(preview.activity.event.actor);
  });

  it("memoizes current member lookup by ID while preserving each recorded display snapshot", async () => {
    const root = temporaryRoot();
    const ids = [EVENT, SECOND_EVENT];
    const foundation = new TeamIdentityActivityFoundation({
      projectRoot: root,
      scaffoldId: "scaffold-test",
      git: fakeGit(),
      now: () => new Date(NOW),
      activityIdFactory: () => ids.shift()!,
    });
    const member = await foundation.members.create({ id: MEMBER, displayName: "Before" });
    foundation.localState.configureMember({ memberId: MEMBER, expectedRevision: null });
    const first = await foundation.previewActivity({ action: "member.observed", subjects: [] });
    await foundation.applyActivity(first, first.activity.previewRevision);
    await foundation.members.update(MEMBER, { displayName: "Current" }, member.revision);
    const second = await foundation.previewActivity({ action: "member.observed", subjects: [] });
    await foundation.applyActivity(second, second.activity.previewRevision);

    const resolveHistorical = vi.spyOn(foundation.actors, "resolveHistorical");
    const page = await foundation.timeline.listResolved({ source: "activity", limit: 100 });
    expect(resolveHistorical).toHaveBeenCalledTimes(1);
    expect(page.items.map((item) => item.recordedActor)).toEqual([
      { kind: "member", memberId: MEMBER, displayName: "Before" },
      { kind: "member", memberId: MEMBER, displayName: "Current" },
    ]);
    expect(page.items.map((item) => item.effectiveActor)).toEqual([
      { kind: "member", memberId: MEMBER, displayName: "Current" },
      { kind: "member", memberId: MEMBER, displayName: "Current" },
    ]);
  });
});

function createFoundation(root: string): TeamIdentityActivityFoundation {
  return new TeamIdentityActivityFoundation({
    projectRoot: root,
    scaffoldId: "scaffold-test",
    git: fakeGit(),
    now: () => new Date(NOW),
    activityIdFactory: () => EVENT,
  });
}

function fakeGit(): GitPort {
  return {
    async getRepoState() {
      return {
        branch: "feat/team-identity-activity",
        head: "1".repeat(40),
        dirty: false,
        observedAt: NOW.toISOString(),
      };
    },
    async getIdentity() { return { name: "Daksh", email: "daksh@example.test" }; },
    async getWorkingTree() { return { items: [], nextCursor: null, truncated: false }; },
    async resolveRevision(ref) { return ref; },
    async getDiff(request) {
      return { target: request.target, diff: "", bytes: 0, truncated: false };
    },
    async getHistory() { return { items: [], nextCursor: null, truncated: false }; },
    async readFileAtRevision() { return null; },
    async getChangedFiles() { return { items: [], nextCursor: null, truncated: false }; },
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-foundation-"));
  roots.push(root);
  return root;
}

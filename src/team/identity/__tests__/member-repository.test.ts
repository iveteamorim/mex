import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memberArtifactPath, serializeMemberArtifact } from "../../artifacts/codecs.js";
import { atomicCreateArtifact, atomicReplaceArtifact } from "../../artifacts/filesystem.js";
import { generateArtifactId } from "../../artifacts/ulid.js";
import { MEMBER_REPOSITORY_LIMITS, MemberRepository } from "../member-repository.js";
import { ActorResolver } from "../actor-resolver.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MemberRepository", () => {
  it("previews exact create bytes and diff without writing, then requires the approved preview", async () => {
    const root = temporaryRoot();
    const id = memberId(0);
    const repository = new MemberRepository(root);
    const preview = await repository.previewCreate({
      id,
      displayName: "Preview Only",
      gitAliases: [],
    });

    expect(preview.change).toMatchObject({
      kind: "create",
      path: memberArtifactPath(id),
      beforeRevision: null,
      afterRevision: preview.member.revision,
    });
    expect(preview.change.diff).toContain(`--- /dev/null\n+++ b/${memberArtifactPath(id)}`);
    expect(() => statSync(join(root, ".mex"))).toThrow();

    await expect(repository.apply(preview, "f".repeat(64))).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(() => statSync(join(root, ".mex"))).toThrow();

    const applied = await repository.apply(preview, preview.previewRevision);
    expect(applied.member.ref.id).toBe(id);
    expect(readFileSync(join(root, ...applied.change.path.split("/")), "utf8")).toBe(preview.document);
  });

  it("keeps missing reads non-mutating and creates one canonical file per member", async () => {
    const root = temporaryRoot();
    const firstId = memberId(1);
    const secondId = memberId(2);
    const repository = new MemberRepository(root, { idFactory: () => firstId });

    expect(await repository.get(firstId)).toBeNull();
    expect(await repository.list()).toEqual([]);
    expect(() => statSync(join(root, ".mex"))).toThrow();

    const first = await repository.create({
      displayName: "Ada Lovelace",
      gitAliases: [{ name: "Ada", email: "ada@example.com" }],
    });
    const second = await repository.create({
      id: secondId,
      displayName: "Grace Hopper",
      gitAliases: [{ name: "Grace", email: "grace@example.com" }],
      active: false,
    });

    expect(first.ref.id).toBe(firstId);
    expect(second.active).toBe(false);
    expect(readFileSync(join(root, ...first.sourcePath.split("/")), "utf8")).toBe(
      serializeMemberArtifact({
        id: firstId,
        displayName: "Ada Lovelace",
        gitAliases: [{ name: "Ada", email: "ada@example.com" }],
        active: true,
      }),
    );
    expect((await repository.list()).map((member) => member.ref.id)).toEqual([firstId, secondId]);
  });

  it("updates only the expected exact revision and leaves stale writes untouched", async () => {
    const root = temporaryRoot();
    const id = memberId(3);
    const repository = new MemberRepository(root);
    const created = await repository.create({ id, displayName: "Lin", gitAliases: [] });

    const updated = await repository.update(id, { displayName: "Lin Chen", active: false }, created.revision);
    expect(updated).toMatchObject({ displayName: "Lin Chen", active: false });
    await expect(repository.update(id, { displayName: "stale" }, created.revision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect((await repository.get(id))?.displayName).toBe("Lin Chen");

    const noOp = await repository.update(id, {}, updated.revision);
    expect(noOp.revision).toBe(updated.revision);
  });

  it("reactivates the same member and restores actor eligibility without changing recorded identity", async () => {
    const root = temporaryRoot();
    const repository = new MemberRepository(root);
    const member = await repository.create({
      id: memberId(10), displayName: "Returning teammate",
      gitAliases: [{ name: "Returning", email: "returning@example.com" }], active: false,
    });
    const resolver = new ActorResolver(repository);
    const recordedActor = Object.freeze({ kind: "member" as const, memberId: member.ref.id, displayName: "Recorded historical name" });
    await expect(resolver.resolve({ configuredMemberId: member.ref.id })).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    expect((await resolver.resolveHistorical(recordedActor)).diagnostics).toHaveLength(1);
    const path = join(root, member.sourcePath);
    const before = readFileSync(path);
    const preview = await repository.previewReactivate(member.ref.id, member.revision);
    expect(readFileSync(path)).toEqual(before);
    expect(preview.change.diff).toContain("-active: false");
    expect(preview.change.diff).toContain("+active: true");
    const result = await repository.apply(preview, preview.previewRevision);
    expect(result.member).toMatchObject({
      ref: member.ref, sourcePath: member.sourcePath, displayName: member.displayName,
      gitAliases: member.gitAliases, active: true,
    });
    expect((await repository.list()).map((value) => value.ref.id)).toEqual([member.ref.id]);
    await expect(resolver.resolve({ configuredMemberId: member.ref.id })).resolves.toEqual({
      kind: "member", memberId: member.ref.id, displayName: member.displayName,
    });
    await expect(resolver.resolve({ gitIdentity: member.gitAliases[0] })).resolves.toEqual({
      kind: "member", memberId: member.ref.id, displayName: member.displayName,
    });
    expect(await resolver.resolveHistorical(recordedActor)).toMatchObject({ recordedActor, diagnostics: [] });
    expect(recordedActor.displayName).toBe("Recorded historical name");
  });

  it("rejects active or stale reactivation targets and stale reactivation previews", async () => {
    const root = temporaryRoot();
    const repository = new MemberRepository(root);
    const member = await repository.create({ id: memberId(11), displayName: "Member", active: true });
    await expect(repository.previewReactivate(member.ref.id, member.revision)).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    const inactive = await repository.update(member.ref.id, { active: false }, member.revision);
    await expect(repository.previewReactivate(member.ref.id, member.revision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    const preview = await repository.previewReactivate(inactive.ref.id, inactive.revision);
    const changed = await repository.update(inactive.ref.id, { displayName: "Concurrent rename" }, inactive.revision);
    await expect(repository.apply(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(await repository.get(member.ref.id)).toEqual(changed);
    expect(changed.active).toBe(false);
  });

  it("rechecks active alias collisions before reactivation publication", async () => {
    const root = temporaryRoot();
    const repository = new MemberRepository(root);
    const member = await repository.create({
      id: memberId(12), displayName: "Returning", active: false,
      gitAliases: [{ name: "Returning", email: "shared@example.com" }],
    });
    const preview = await repository.previewReactivate(member.ref.id, member.revision);
    atomicCreateArtifact(root, memberArtifactPath(memberId(13)), serializeMemberArtifact({
      id: memberId(13), displayName: "Merged active member", active: true,
      gitAliases: [{ name: "Merged", email: "SHARED@example.com" }],
    }));
    await expect(repository.apply(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    await expect(repository.previewReactivate(member.ref.id, member.revision)).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    expect(await repository.get(member.ref.id)).toEqual(member);
  });

  it("rejects a stale update preview without changing the newer member", async () => {
    const root = temporaryRoot();
    const id = memberId(7);
    const repository = new MemberRepository(root);
    const created = await repository.create({ id, displayName: "Before", gitAliases: [] });
    const preview = await repository.previewUpdate(id, { displayName: "Preview" }, created.revision);
    const concurrent = serializeMemberArtifact({
      id,
      displayName: "Concurrent",
      gitAliases: [],
      active: true,
    });
    atomicReplaceArtifact(root, created.sourcePath, created.revision, concurrent, 64 * 1024);

    await expect(repository.apply(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect((await repository.get(id))?.displayName).toBe("Concurrent");
  });

  it("rechecks alias uniqueness under the apply lock", async () => {
    const root = temporaryRoot();
    const candidateId = memberId(8);
    const mergedId = memberId(9);
    const repository = new MemberRepository(root);
    const preview = await repository.previewCreate({
      id: candidateId,
      displayName: "Candidate",
      gitAliases: [{ name: "Candidate", email: "shared@example.com" }],
    });
    const mergedPath = memberArtifactPath(mergedId);
    atomicCreateArtifact(root, mergedPath, serializeMemberArtifact({
      id: mergedId,
      displayName: "Merged Teammate",
      gitAliases: [{ name: "Merged", email: "SHARED@example.com" }],
      active: true,
    }));

    await expect(repository.apply(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    expect(await repository.get(candidateId)).toBeNull();
    expect((await repository.get(mergedId))?.displayName).toBe("Merged Teammate");
  });

  it("rejects duplicate email ownership case-insensitively", async () => {
    const root = temporaryRoot();
    const repository = new MemberRepository(root);
    await repository.create({
      id: memberId(4),
      displayName: "First",
      gitAliases: [{ name: "First", email: "PERSON@example.com" }],
    });

    await expect(repository.create({
      id: memberId(5),
      displayName: "Second",
      gitAliases: [{ name: "Second", email: "person@EXAMPLE.com" }],
    })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(await repository.get(memberId(5))).toBeNull();
  });

  it("fails visibly on malformed canonical member files", async () => {
    const root = temporaryRoot();
    const id = memberId(6);
    const path = memberArtifactPath(id);
    const absolute = join(root, ...path.split("/"));
    mkdirSync(join(root, ".mex", "team", "members"), { recursive: true });
    writeFileSync(absolute, `${serializeMemberArtifact({
      id,
      displayName: "Malformed",
      gitAliases: [],
      active: true,
    })}body\n`, "utf8");

    const repository = new MemberRepository(root);
    await expect(repository.list()).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
  });

  it("fails closed before materializing an oversized member collection", async () => {
    const root = temporaryRoot();
    const directory = join(root, ".mex", "team", "members");
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index <= MEMBER_REPOSITORY_LIMITS.maxRecords; index += 1) {
      writeFileSync(join(directory, `${String(index).padStart(4, "0")}.md`), "", "utf8");
    }

    await expect(new MemberRepository(root).list()).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects creates that would exceed directory or record capacity and rechecks after preview", async () => {
    await withMemberRepositoryLimits({
      maxDirectoryEntries: 10,
      maxRecords: 1,
      maxCorpusBytes: 1_000_000,
    }, async () => {
      const root = temporaryRoot();
      const repository = new MemberRepository(root);
      const pending = await repository.previewCreate({
        id: memberId(11), displayName: "Pending", gitAliases: [],
      });
      const occupied = await repository.previewCreate({
        id: memberId(12), displayName: "Occupied", gitAliases: [],
      });
      await repository.apply(occupied, occupied.previewRevision);

      await expect(repository.previewCreate({
        id: memberId(13), displayName: "Too many", gitAliases: [],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      await expect(repository.apply(pending, pending.previewRevision)).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
      expect(await repository.get(memberId(11))).toBeNull();
    });

    await withMemberRepositoryLimits({
      maxDirectoryEntries: 1,
      maxRecords: 10,
      maxCorpusBytes: 1_000_000,
    }, async () => {
      const root = temporaryRoot();
      const repository = new MemberRepository(root);
      const pending = await repository.previewCreate({
        id: memberId(14), displayName: "No directory slot", gitAliases: [],
      });
      const directory = join(root, ".mex", "team", "members");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "README"), "reserved", "utf8");

      await expect(repository.previewCreate({
        id: memberId(15), displayName: "No directory slot", gitAliases: [],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      await expect(repository.apply(pending, pending.previewRevision)).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
    });

    await withMemberRepositoryLimits({
      maxDirectoryEntries: 10,
      maxRecords: 10,
      maxCorpusBytes: 1_000_000,
    }, async (limits) => {
      const root = temporaryRoot();
      const repository = new MemberRepository(root);
      const pending = await repository.previewCreate({
        id: memberId(16), displayName: "Corpus pending", gitAliases: [],
      });
      limits.maxCorpusBytes = Buffer.byteLength(pending.document, "utf8");
      const directory = join(root, ".mex", "team", "members");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "occupied.md"), "x", "utf8");

      await expect(repository.previewCreate({
        id: memberId(17), displayName: "Corpus pending", gitAliases: [],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      await expect(repository.apply(pending, pending.previewRevision)).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
    });
  });

  it("uses replacement bytes for projected member corpus capacity", async () => {
    await withMemberRepositoryLimits({
      maxDirectoryEntries: 10,
      maxRecords: 10,
      maxCorpusBytes: 1_000_000,
    }, async (limits) => {
      const root = temporaryRoot();
      const id = memberId(18);
      const repository = new MemberRepository(root);
      const created = await repository.create({
        id,
        displayName: "A deliberately long canonical member display name",
        gitAliases: [],
      });
      const shrink = await repository.previewUpdate(id, { displayName: "Short" }, created.revision);
      limits.maxCorpusBytes = Buffer.byteLength(shrink.document, "utf8");

      const boundedShrink = await repository.previewUpdate(id, { displayName: "Short" }, created.revision);
      const updated = (await repository.apply(boundedShrink, boundedShrink.previewRevision)).member;
      expect(updated.displayName).toBe("Short");

      await expect(repository.previewUpdate(id, {
        displayName: "A display name that grows beyond the newly bounded corpus",
      }, updated.revision)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    });
  });

  it("binds a symlinked project root before preview so apply cannot follow a target swap", async () => {
    const container = temporaryRoot();
    const original = join(container, "original");
    const replacement = join(container, "replacement");
    const link = join(container, "project");
    mkdirSync(original);
    mkdirSync(replacement);
    symlinkSync(original, link);
    const repository = new MemberRepository(link);
    const preview = await repository.previewCreate({
      id: memberId(10),
      displayName: "Bound Root",
      gitAliases: [],
    });

    unlinkSync(link);
    symlinkSync(replacement, link);
    await repository.apply(preview, preview.previewRevision);

    expect(readFileSync(join(original, ...preview.change.path.split("/")), "utf8")).toBe(preview.document);
    expect(() => statSync(join(replacement, ...preview.change.path.split("/")))).toThrow();
  });
});

function memberId(fill: number): string {
  return generateArtifactId("member", {
    now: Date.UTC(2026, 7, 23),
    random: new Uint8Array(10).fill(fill),
  });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-members-"));
  roots.push(root);
  return root;
}

interface MutableMemberRepositoryLimits {
  maxDirectoryEntries: number;
  maxRecords: number;
  maxCorpusBytes: number;
}

async function withMemberRepositoryLimits(
  overrides: Partial<MutableMemberRepositoryLimits>,
  operation: (limits: MutableMemberRepositoryLimits) => Promise<void>,
): Promise<void> {
  const limits = MEMBER_REPOSITORY_LIMITS as unknown as MutableMemberRepositoryLimits;
  const original = { ...limits };
  Object.assign(limits, overrides);
  try {
    await operation(limits);
  } finally {
    Object.assign(limits, original);
  }
}

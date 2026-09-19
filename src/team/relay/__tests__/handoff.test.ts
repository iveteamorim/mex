import { describe, expect, it } from "vitest";
import type { ActorRef, Diagnostic } from "../../contracts/shared.js";
import { generateArtifactId } from "../../artifacts/ulid.js";
import {
  aggregateRelayDiagnostics,
  normalizeExistingRelayDraftMigrationCommand,
  normalizeRelayProductDraftInput,
  normalizeStoredRelayProductDraftInput,
  normalizeTeamRelayCommand,
} from "../handoff.js";

const WORKSTREAM = generateArtifactId("ws", {
  now: 1,
  random: new Uint8Array(10).fill(1),
});
const REVISION = "a".repeat(64);

describe("Relay product normalization", () => {
  it("accepts zero to 32 local recipients and rejects 33 or duplicates", () => {
    const recipients = Array.from({ length: 33 }, (_, index): Extract<ActorRef, { kind: "member" }> => ({
      kind: "member",
      memberId: generateArtifactId("member", {
        now: index + 2,
        random: new Uint8Array(10).fill(index + 2),
      }),
      displayName: `Member ${index + 1}`,
    }));
    expect(normalizeRelayProductDraftInput(input(recipients.slice(0, 1))).recipients)
      .toEqual(recipients.slice(0, 1));
    expect(normalizeRelayProductDraftInput(input([])).recipients).toEqual([]);
    expect(normalizeRelayProductDraftInput(input(recipients.slice(0, 32))).recipients)
      .toHaveLength(32);
    expect(() => normalizeRelayProductDraftInput(input(recipients))).toThrow(/malformed/);
    expect(() => normalizeRelayProductDraftInput(input([
      recipients[0]!,
      { ...recipients[0]!, displayName: "Renamed same Member" },
    ]))).toThrow(/malformed/);
  });

  it("preserves absent audience for legacy receipts and accepts only explicit unambiguous team or named drafts", () => {
    const { workstream: _workstream, ...draft } = input([]);
    expect(normalizeRelayProductDraftInput(draft)).not.toHaveProperty("audience");
    expect(normalizeRelayProductDraftInput({ ...draft, audience: "members" })).toMatchObject({ audience: "members", recipients: [] });
    expect(normalizeRelayProductDraftInput({ ...draft, audience: "team" })).toMatchObject({ audience: "team", recipients: [] });
    expect(() => normalizeRelayProductDraftInput({ ...draft, audience: "team", recipients: [member(8)] })).toThrow();
    expect(() => normalizeRelayProductDraftInput({ ...draft, audience: "everyone" })).toThrow();
  });

  it("translates only a canonical legacy Workstream reference without lookup", () => {
    const valid = input([member(7)]);
    expect(normalizeRelayProductDraftInput(valid)).toMatchObject({
      evidence: [{
        kind: "entity",
        entity: { id: WORKSTREAM, kind: "workstream" },
      }],
    });
    expect(normalizeRelayProductDraftInput(valid)).not.toHaveProperty("workstream");

    for (const id of [
      "ws_not-a-ulid",
      "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ws_81ARZ3NDEKTSV4RRFFQ69G5FAV",
    ]) {
      expect(() => normalizeRelayProductDraftInput({
        ...valid,
        workstream: { ...valid.workstream, id },
      }), id).toThrow(/malformed or exceeds/);
    }
  });

  it("reserves translated evidence for exact-revision updates, never new caller drafts", () => {
    const recipient = member(7);
    const evidence = [
      { kind: "entity" as const, entity: { id: WORKSTREAM, kind: "workstream" as const } },
      ...Array.from({ length: 64 }, (_, index) => ({
        kind: "manual" as const,
        note: `Legacy evidence ${index}`,
      })),
    ];
    const migrated = {
      ...input([recipient]),
      workstream: undefined,
      evidence,
    };
    delete (migrated as { workstream?: unknown }).workstream;
    expect(() => normalizeRelayProductDraftInput(migrated)).toThrow(/at most 64|limited to 64/);
    expect(normalizeStoredRelayProductDraftInput(migrated).evidence).toEqual(evidence);
    expect(() => normalizeTeamRelayCommand({
      operationId: "relay_new_reserved_evidence",
      action: { kind: "relay.draft.save", draft: migrated },
      expectedRevisions: [],
    })).toThrow(/at most 64|limited to 64/);

    const existing = {
      operationId: "relay_existing_reserved_evidence",
      action: { kind: "relay.draft.save", draftId: "relay_migrated", draft: migrated },
      expectedRevisions: [{
        target: { kind: "local", namespace: "relay-draft", id: "relay_migrated" },
        revision: REVISION,
      }],
    };
    expect(() => normalizeTeamRelayCommand(existing)).toThrow(/at most 64|limited to 64/);
    expect(normalizeExistingRelayDraftMigrationCommand(existing)).toMatchObject({
      action: { draftId: "relay_migrated", draft: { evidence } },
    });
  });

  it("rejects control and line-separator characters in Relay repository paths", () => {
    const valid = input([member(8)]);
    expect(() => normalizeRelayProductDraftInput({
      ...valid,
      changedFiles: ["src/relay.ts"],
      evidence: [{ kind: "file", path: "src/relay.ts" }],
    })).not.toThrow();

    for (const path of ["src/relay\u0085.ts", "src/relay\u2028.ts", "src/relay\u2029.ts"]) {
      for (const patch of [
        { changedFiles: [path] },
        { evidence: [{ kind: "file" as const, path }] },
        { code: [{ kind: "file" as const, path }] },
        { evidence: [{ kind: "code" as const, code: { kind: "file" as const, path } }] },
      ]) {
        expect(() => normalizeRelayProductDraftInput({ ...valid, ...patch }), path)
          .toThrow(/control or line-separator/);
      }
    }
  });

  it("uses the locked local draft grammar for request and receipt-compatible IDs", () => {
    const draft = input([member(7)]);
    for (const id of ["../escape", "nested/draft", " leading", "draft space"]) {
      expect(() => normalizeTeamRelayCommand({
        operationId: "relay_local_id",
        action: { kind: "relay.draft.save", draftId: id, draft },
        expectedRevisions: [{
          target: { kind: "local", namespace: "relay-draft", id },
          revision: "a".repeat(64),
        }],
      })).toThrow();
    }
    expect(() => normalizeTeamRelayCommand({
      operationId: "relay_local_id_128",
      action: {
        kind: "relay.draft.save",
        draftId: "d".repeat(128),
        draft,
      },
      expectedRevisions: [{
        target: {
          kind: "local",
          namespace: "relay-draft",
          id: "d".repeat(128),
        },
        revision: "a".repeat(64),
      }],
    })).not.toThrow();
    expect(() => normalizeTeamRelayCommand({
      operationId: "relay_local_id_129",
      action: {
        kind: "relay.draft.save",
        draftId: "d".repeat(129),
        draft,
      },
      expectedRevisions: [{
        target: {
          kind: "local",
          namespace: "relay-draft",
          id: "d".repeat(129),
        },
        revision: "a".repeat(64),
      }],
    })).toThrow();
  });

  it("requires the order-independent publish expectation topology before service construction", () => {
    const draftId = "relay_publish_topology";
    const members = Array.from({ length: 33 }, (_, index) =>
      generateArtifactId("member", {
        now: index + 20,
        random: new Uint8Array(10).fill(index + 20),
      }));
    const local = {
      target: { kind: "local", namespace: "relay-draft", id: draftId },
      revision: REVISION,
    };
    const workstream = {
      target: {
        kind: "artifact",
        path: `.mex/workstreams/${WORKSTREAM}.md`,
      },
      revision: REVISION,
    };
    const memberExpectations = members.map((memberId) => ({
      target: {
        kind: "artifact",
        path: `.mex/team/members/${memberId}.md`,
      },
      revision: REVISION,
    }));
    const valid = [
      memberExpectations[1]!,
      local,
      memberExpectations[0]!,
    ];
    expect(() => normalizeTeamRelayCommand(
      publishCommand(draftId, valid),
    )).not.toThrow();
    expect(() => normalizeTeamRelayCommand(
      publishCommand(draftId, [local, ...memberExpectations.slice(0, 32)]),
    )).not.toThrow();
    // Audience-specific eligibility is checked against the exact stored draft.
    expect(() => normalizeTeamRelayCommand(publishCommand(draftId, [local]))).not.toThrow();

    const invalidTopologies: readonly (readonly unknown[])[] = [
      valid.filter((expectation) => expectation !== local),
      [...valid, workstream],
      [...valid, local],
      [...valid, memberExpectations[0]!],
      [
        { ...local, target: { ...local.target, id: `${draftId}_other` } },
        memberExpectations[0]!,
      ],
      [
        {
          ...local,
          target: { kind: "local", namespace: "cursor", id: draftId },
        },
        memberExpectations[0]!,
      ],
      [{ ...local, revision: null }, memberExpectations[0]!],
      [local, { ...memberExpectations[0]!, revision: null }],
      [
        local,
        {
          target: { kind: "entity", id: "relay:unrelated" },
          revision: REVISION,
          semanticRevision: 1,
        },
      ],
      [
        local,
        {
          target: {
            kind: "artifact",
            path: ".mex/relays/relay_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
          },
          revision: REVISION,
        },
      ],
      [
        local,
        {
          target: { kind: "artifact", path: ".mex/other/arbitrary.md" },
          revision: REVISION,
        },
      ],
      [
        local,
        {
          ...memberExpectations[0]!,
          semanticRevision: 1,
        },
      ],
      [local, ...memberExpectations],
    ];
    for (const expectedRevisions of invalidTopologies) {
      expect(() => normalizeTeamRelayCommand(
        publishCommand(draftId, expectedRevisions),
      )).toThrow();
    }
  });

  it("reserves one diagnostic slot for the bounded legacy warning", () => {
    const diagnostics: Diagnostic[] = Array.from({ length: 100 }, (_, index) => ({
      code: `REPOSITORY_${index}`,
      severity: "warning",
      message: `Repository warning ${index}`,
    }));
    const aggregate = aggregateRelayDiagnostics(diagnostics, true, false);
    expect(aggregate.diagnostics).toHaveLength(100);
    expect(aggregate.diagnostics.filter(
      (diagnostic) => diagnostic.code === "RELAY_LEGACY_PUBLICATION_TIME",
    )).toHaveLength(1);
    expect(aggregate.sourceTruncated).toBe(true);
  });
});

function input(recipients: readonly ActorRef[]) {
  return {
    recipients,
    workstream: { id: WORKSTREAM, kind: "workstream" as const },
    summary: "Transfer exact repository context",
    completed: [],
    inProgress: [],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: [],
    code: [],
    evidence: [],
    nextActions: ["Acknowledge"],
  };
}

function member(entropy: number): Extract<ActorRef, { kind: "member" }> {
  return {
    kind: "member",
    memberId: generateArtifactId("member", {
      now: entropy,
      random: new Uint8Array(10).fill(entropy),
    }),
    displayName: `Member ${entropy}`,
  };
}

function publishCommand(
  draftId: string,
  expectedRevisions: readonly unknown[],
): unknown {
  return {
    operationId: `relay_publish_topology_${draftId}`,
    action: { kind: "relay.publish", draftId },
    expectedRevisions,
  };
}

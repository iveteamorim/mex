import { describe, expect, it } from "vitest";
import type { ActorRef, RepoRelativePath } from "../../contracts/shared.js";
import {
  inboxProposalArtifactPath,
  normalizeInboxDraftInput,
  normalizeRelayDraftInput,
  normalizeRelayDraftInputWithLegacy,
  parseInboxProposalArtifact,
  parsePlaybookArtifact,
  parsePlaybookRunArtifact,
  parseRelayArtifact,
  parseWorkstreamArtifact,
  playbookArtifactPath,
  playbookRunArtifactPath,
  relayArtifactPath,
  serializeInboxProposalArtifact,
  serializePlaybookArtifact,
  serializePlaybookRunArtifact,
  serializeRelayArtifact,
  serializeWorkstreamArtifact,
  workstreamArtifactPath,
} from "../workflow-codecs.js";
import { generateArtifactId } from "../ulid.js";
import { normalizeRelayProductDraftInput } from "../../relay/handoff.js";

const NOW = "2026-08-27T10:00:00.000Z";
const MEMBER = generateArtifactId("member", { now: 1, random: new Uint8Array(10).fill(1) });
const ACTOR: ActorRef = { kind: "member", memberId: MEMBER, displayName: "Ada" };
const WORKSTREAM = generateArtifactId("ws", { now: 2, random: new Uint8Array(10).fill(2) });
const PROPOSAL = generateArtifactId("proposal", { now: 3, random: new Uint8Array(10).fill(3) });
const RELAY = generateArtifactId("relay", { now: 4, random: new Uint8Array(10).fill(4) });
const PLAYBOOK = generateArtifactId("playbook", { now: 5, random: new Uint8Array(10).fill(5) });
const RUN = generateArtifactId("run", { now: 6, random: new Uint8Array(10).fill(6) });
const RELAY_V1_GOLDEN = `---
schema_version: 1
id: ${JSON.stringify(RELAY)}
mex: {"id":${JSON.stringify(RELAY)},"revision":1,"status":"promoted","summary":"Handoff","title":${JSON.stringify(`Relay ${RELAY}`)},"type":"relay"}
state: "published"
sender: {"displayName":"Ada","kind":"member","memberId":${JSON.stringify(MEMBER)}}
recipients: [{"displayName":"Ada","kind":"member","memberId":${JSON.stringify(MEMBER)}}]
workstream: {"id":${JSON.stringify(WORKSTREAM)},"kind":"workstream"}
summary: "Handoff"
completed: []
in_progress: ["Tests"]
decisions: []
blockers: []
unresolved_questions: []
changed_files: ["src/team/index.ts"]
code: []
evidence: []
next_actions: ["Review"]
---
`;
const RELAY_V2_GOLDEN = RELAY_V1_GOLDEN
  .replace("schema_version: 1", "schema_version: 2")
  .replace(
    'next_actions: ["Review"]\n---',
    `next_actions: ["Review"]\npublished_at: ${JSON.stringify(NOW)}\n---`,
  );
const PUBLICATION_STATE = {
  branch: "main", head: "1".repeat(40), dirty: false, observedAt: NOW,
};
const RELAY_V3_GOLDEN = RELAY_V2_GOLDEN
  .replace("schema_version: 2", "schema_version: 3")
  .replace(`workstream: {"id":${JSON.stringify(WORKSTREAM)},"kind":"workstream"}\n`, "")
  .replace(
    `published_at: ${JSON.stringify(NOW)}\n---`,
    `published_at: ${JSON.stringify(NOW)}\npublished_repo_state: {"branch":"main","dirty":false,"head":"${"1".repeat(40)}","observedAt":${JSON.stringify(NOW)}}\n---`,
  );
const RELAY_V4_GOLDEN = RELAY_V3_GOLDEN
  .replace("schema_version: 3", "schema_version: 4")
  .replace(
    `recipients: [{"displayName":"Ada","kind":"member","memberId":${JSON.stringify(MEMBER)}}]`,
    'audience: "team"\nrecipients: []',
  );

function teamRelayInput() {
  return {
    schemaVersion: 4 as const, audience: "team" as const,
    id: RELAY, entityRevision: 1, state: "published" as const,
    sender: ACTOR, recipients: [], summary: "Handoff", completed: [], inProgress: ["Tests"],
    decisions: [], blockers: [], unresolvedQuestions: [], changedFiles: ["src/team/index.ts"],
    code: [], evidence: [], nextActions: ["Review"], publishedAt: NOW,
    publishedRepoState: PUBLICATION_STATE,
  };
}

describe("workflow artifact codecs", () => {
  it("round-trips strict v1 workstream, relay, playbook, and run Wiki entities", () => {
    const workstream = serializeWorkstreamArtifact({
      id: WORKSTREAM, entityRevision: 3, state: "active", title: "Release", goal: "Ship safely", summary: "Release work",
      owners: [ACTOR], contributors: [], paths: ["src/team"], code: [], topics: [], components: [], related: [], blockers: [],
      currentState: "Implementing", nextMilestone: "Conformance", createdBy: ACTOR, createdAt: NOW, updatedBy: ACTOR, updatedAt: NOW,
    });
    expect(workstream).toContain(`mex: {"id":${JSON.stringify(WORKSTREAM)},"revision":3`);
    expect(parseWorkstreamArtifact(workstream, workstreamArtifactPath(WORKSTREAM))).toMatchObject({
      ref: { id: WORKSTREAM, kind: "workstream", title: "Release" }, entityRevision: 3, state: "active",
    });

    const relay = serializeRelayArtifact({
      id: RELAY, entityRevision: 1, state: "published", sender: ACTOR, recipients: [ACTOR],
      workstream: { id: WORKSTREAM, kind: "workstream" }, summary: "Handoff", completed: [], inProgress: ["Tests"],
      decisions: [], blockers: [], unresolvedQuestions: [], changedFiles: ["src/team/index.ts"], code: [], evidence: [], nextActions: ["Review"],
    });
    expect(parseRelayArtifact(relay, relayArtifactPath(RELAY))).toMatchObject({ entityRevision: 1, state: "published" });

    const playbook = serializePlaybookArtifact({
      id: PLAYBOOK, entityRevision: 2, state: "active", title: "Release playbook", purpose: "Repeatable release", trigger: "Release requested",
      owners: [ACTOR], prerequisites: ["Green CI"], steps: [{ id: "verify", title: "Verify", instructions: "Run checks", requiredChecks: ["unit"], expectedOutputs: ["report"] }], related: [],
    });
    expect(parsePlaybookArtifact(playbook, playbookArtifactPath(PLAYBOOK))).toMatchObject({ entityRevision: 2, state: "active" });

    const run = serializePlaybookRunArtifact({
      id: RUN, entityRevision: 1, state: "active", playbook: { id: PLAYBOOK, kind: "playbook" },
      workstream: { id: WORKSTREAM, kind: "workstream" }, steps: [{ stepId: "verify" }], startedBy: ACTOR, startedAt: NOW,
    });
    expect(parsePlaybookRunArtifact(run, playbookRunArtifactPath(RUN))).toMatchObject({ entityRevision: 1, state: "active" });
  });

  it("strictly dual-reads Relay v1/v2 while preserving schema and timestamp order", () => {
    const base = {
      id: RELAY,
      entityRevision: 1,
      state: "published" as const,
      sender: ACTOR,
      recipients: [ACTOR],
      workstream: { id: WORKSTREAM, kind: "workstream" as const },
      summary: "Handoff",
      completed: [],
      inProgress: ["Tests"],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: ["src/team/index.ts" as RepoRelativePath],
      code: [],
      evidence: [],
      nextActions: ["Review"],
    };
    const legacyBytes = serializeRelayArtifact(base);
    expect(legacyBytes).toBe(RELAY_V1_GOLDEN);
    const legacy = parseRelayArtifact(legacyBytes, relayArtifactPath(RELAY));
    expect(legacy).toMatchObject({ schemaVersion: 1, state: "published" });
    expect(legacy).not.toHaveProperty("publishedAt");
    if (legacy.schemaVersion !== 1) throw new Error("expected schema-v1 Relay");
    const {
      ref: _ref,
      kind: _kind,
      sourcePath: _sourcePath,
      revision: _revision,
      ...legacyInput
    } = legacy;
    expect(serializeRelayArtifact({ id: RELAY, ...legacyInput })).toBe(legacyBytes);
    const legacyAcknowledgedBytes = serializeRelayArtifact({
      ...base,
      state: "acknowledged",
      acknowledgedBy: ACTOR,
      acknowledgedAt: NOW,
    });
    expect(legacyAcknowledgedBytes).toContain("schema_version: 1\n");
    expect(parseRelayArtifact(
      legacyAcknowledgedBytes,
      relayArtifactPath(RELAY),
    )).toMatchObject({ schemaVersion: 1, state: "acknowledged" });
    const legacyClosedBytes = serializeRelayArtifact({
      ...base,
      state: "closed",
      acknowledgedBy: ACTOR,
      acknowledgedAt: NOW,
      closedBy: ACTOR,
      closedAt: NOW,
    });
    expect(legacyClosedBytes).toContain("schema_version: 1\n");
    expect(parseRelayArtifact(
      legacyClosedBytes,
      relayArtifactPath(RELAY),
    )).toMatchObject({ schemaVersion: 1, state: "closed" });

    const v2Bytes = serializeRelayArtifact({ ...base, publishedAt: NOW });
    expect(v2Bytes).toBe(RELAY_V2_GOLDEN);
    expect(v2Bytes).toContain("schema_version: 2\n");
    expect(v2Bytes).toContain(`published_at: ${JSON.stringify(NOW)}\n`);
    expect(parseRelayArtifact(v2Bytes, relayArtifactPath(RELAY))).toMatchObject({
      schemaVersion: 2,
      publishedAt: NOW,
    });
    const parsedV2 = parseRelayArtifact(v2Bytes, relayArtifactPath(RELAY));
    const {
      ref: parsedV2Ref,
      kind: _parsedV2Kind,
      sourcePath: _parsedV2SourcePath,
      revision: _parsedV2Revision,
      ...parsedV2Input
    } = parsedV2;
    expect(serializeRelayArtifact({ id: parsedV2Ref.id, ...parsedV2Input }))
      .toBe(v2Bytes);
    const v2AcknowledgedBytes = serializeRelayArtifact({
      ...base,
      entityRevision: 2,
      state: "acknowledged",
      publishedAt: NOW,
      acknowledgedBy: ACTOR,
      acknowledgedAt: NOW,
    });
    const v2ClosedBytes = serializeRelayArtifact({
      ...base,
      entityRevision: 3,
      state: "closed",
      publishedAt: NOW,
      acknowledgedBy: ACTOR,
      acknowledgedAt: NOW,
      closedBy: ACTOR,
      closedAt: NOW,
    });
    for (const bytes of [v2AcknowledgedBytes, v2ClosedBytes]) {
      expect(parseRelayArtifact(bytes, relayArtifactPath(RELAY))).toMatchObject({
        schemaVersion: 2,
        workstream: base.workstream,
        publishedAt: NOW,
      });
      expect(bytes).toContain("schema_version: 2\n");
      expect(bytes).toContain(`workstream: ${JSON.stringify(base.workstream)}\n`);
      expect(bytes).toContain(`published_at: ${JSON.stringify(NOW)}\n`);
    }
    expect(() => serializeRelayArtifact({
      ...base,
      state: "acknowledged",
      publishedAt: NOW,
      acknowledgedBy: ACTOR,
      acknowledgedAt: "2026-08-27T09:59:59.999Z",
    })).toThrow(/publication cannot follow acknowledgement/);
    expect(() => parseRelayArtifact(
      v2Bytes.replace("schema_version: 2", "schema_version: 1"),
      relayArtifactPath(RELAY),
    )).toThrow();
  });

  it("round-trips strict Relay v3 clean, dirty, detached, and null-HEAD repository state", () => {
    const base = {
      schemaVersion: 3 as const,
      id: RELAY,
      entityRevision: 1,
      state: "published" as const,
      sender: ACTOR,
      recipients: [ACTOR],
      summary: "Standalone handoff",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
      publishedAt: NOW,
    };
    const states = [
      { branch: "main", head: "1".repeat(40), dirty: false, observedAt: NOW },
      { branch: "feature/relay-v3", head: "2".repeat(64), dirty: true, observedAt: NOW },
      { branch: null, head: "3".repeat(40), dirty: false, observedAt: NOW },
      { branch: "main", head: null, dirty: false, observedAt: NOW },
    ] as const;

    for (const publishedRepoState of states) {
      const bytes = serializeRelayArtifact({ ...base, publishedRepoState });
      expect(bytes).toContain("schema_version: 3\n");
      expect(bytes).not.toContain("\nworkstream:");
      expect(bytes).toContain(
        `published_repo_state: {"branch":${JSON.stringify(publishedRepoState.branch)},"dirty":${publishedRepoState.dirty},"head":${JSON.stringify(publishedRepoState.head)},"observedAt":${JSON.stringify(publishedRepoState.observedAt)}}\n`,
      );
      const parsed = parseRelayArtifact(bytes, relayArtifactPath(RELAY));
      expect(parsed).toMatchObject({
        schemaVersion: 3,
        publishedAt: NOW,
        publishedRepoState,
      });
      expect(parsed).not.toHaveProperty("workstream");
      if (parsed.schemaVersion !== 3) throw new Error("expected schema-v3 Relay");
      const {
        ref,
        kind: _kind,
        sourcePath: _sourcePath,
        revision: _revision,
        ...input
      } = parsed;
      expect(serializeRelayArtifact({ id: ref.id, ...input })).toBe(bytes);
    }
  });

  it("strictly rejects Workstream and malformed publication state in Relay v3", () => {
    const valid = {
      schemaVersion: 3 as const,
      id: RELAY,
      entityRevision: 1,
      state: "published" as const,
      sender: ACTOR,
      recipients: [ACTOR],
      summary: "Standalone handoff",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
      publishedAt: NOW,
      publishedRepoState: {
        branch: "main",
        head: "1".repeat(40),
        dirty: false,
        observedAt: NOW,
      },
    };
    expect(() => serializeRelayArtifact({
      ...valid,
      workstream: { id: WORKSTREAM, kind: "workstream" },
    } as never)).toThrow();
    for (const publishedRepoState of [
      { ...valid.publishedRepoState, extra: true },
      { ...valid.publishedRepoState, head: "not-a-head" },
      { ...valid.publishedRepoState, dirty: "yes" },
      { ...valid.publishedRepoState, observedAt: "2026-08-27" },
    ]) {
      expect(() => serializeRelayArtifact({
        ...valid,
        publishedRepoState,
      } as never)).toThrow();
    }
    const bytes = serializeRelayArtifact(valid);
    expect(() => parseRelayArtifact(
      bytes.replace(
        "summary:",
        `workstream: ${JSON.stringify({ id: WORKSTREAM, kind: "workstream" })}\nsummary:`,
      ),
      relayArtifactPath(RELAY),
    )).toThrow();
  });

  it("requires bounded canonical Member principals for v3 while preserving legacy actors", () => {
    const valid = {
      schemaVersion: 3 as const,
      id: RELAY,
      entityRevision: 1,
      state: "published" as const,
      sender: ACTOR,
      recipients: [ACTOR],
      summary: "Standalone handoff",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
      publishedAt: NOW,
      publishedRepoState: {
        branch: "main",
        head: "1".repeat(40),
        dirty: false,
        observedAt: NOW,
      },
    };
    const gitActor = {
      kind: "git" as const,
      name: "Legacy author",
      email: "legacy@example.test",
    };
    for (const sender of [gitActor, { kind: "unknown" as const }]) {
      expect(() => serializeRelayArtifact({ ...valid, sender } as never))
        .toThrow(/sender must be a canonical Member/);
    }
    for (const recipients of [[gitActor], [{ kind: "unknown" as const }]]) {
      expect(() => serializeRelayArtifact({ ...valid, recipients } as never))
        .toThrow(/1 and 32 canonical Members/);
    }
    const members = Array.from({ length: 33 }, (_, index) => ({
      kind: "member" as const,
      memberId: generateArtifactId("member", {
        now: 100 + index,
        random: new Uint8Array(10).fill(100 + index),
      }),
      displayName: `Member ${index}`,
    }));
    expect(() => serializeRelayArtifact({ ...valid, recipients: members } as never))
      .toThrow(/1 and 32 canonical Members/);
    expect(() => serializeRelayArtifact({
      ...valid,
      recipients: [members[0], { ...members[0], displayName: "Renamed" }],
    } as never)).toThrow(/Member IDs must be unique/);
    expect(() => serializeRelayArtifact({
      ...valid,
      entityRevision: 2,
      state: "acknowledged",
      acknowledgedBy: gitActor,
      acknowledgedAt: NOW,
    } as never)).toThrow(/lifecycle principals must be canonical Members/);

    const legacyRecipients = Array.from({ length: 64 }, (_, index) => ({
      kind: "git" as const,
      name: `Legacy recipient ${index}`,
      email: `legacy-${index}@example.test`,
    }));
    const legacyBase = {
      id: RELAY,
      entityRevision: 1,
      state: "published" as const,
      sender: gitActor,
      recipients: legacyRecipients,
      workstream: { id: WORKSTREAM, kind: "workstream" as const },
      summary: "Legacy handoff",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
    };
    for (const input of [legacyBase, { ...legacyBase, publishedAt: NOW }]) {
      const bytes = serializeRelayArtifact(input);
      expect(parseRelayArtifact(bytes, relayArtifactPath(RELAY))).toMatchObject({
        sender: gitActor,
        recipients: expect.arrayContaining(legacyRecipients),
      });
    }
  });

  it("preserves canonical v1-v3 bytes and rejects audience on every old schema", () => {
    for (const bytes of [RELAY_V1_GOLDEN, RELAY_V2_GOLDEN, RELAY_V3_GOLDEN]) {
      const parsed = parseRelayArtifact(bytes, relayArtifactPath(RELAY));
      const { ref, kind: _kind, sourcePath: _sourcePath, revision: _revision, ...content } = parsed;
      const input = { id: ref.id, ...content };
      expect(serializeRelayArtifact(input)).toBe(bytes);
      expect(parsed).not.toHaveProperty("audience");
      for (const audience of ["members", "team"]) {
        expect(() => serializeRelayArtifact({ ...input, audience } as never)).toThrow();
        expect(() => parseRelayArtifact(
          bytes.replace("recipients:", `audience: ${JSON.stringify(audience)}\nrecipients:`),
          relayArtifactPath(RELAY),
        )).toThrow();
      }
    }
  });

  it("round-trips team Relay v4 through take and sender or claimant closure", () => {
    const published = teamRelayInput();
    expect(serializeRelayArtifact(published)).toBe(RELAY_V4_GOLDEN);
    const claimant: ActorRef = {
      kind: "member", displayName: "Claimant",
      memberId: generateArtifactId("member", { now: 9, random: new Uint8Array(10).fill(9) }),
    };
    const acknowledged = {
      ...published, state: "acknowledged" as const, entityRevision: 2,
      acknowledgedBy: claimant, acknowledgedAt: "2026-08-27T11:00:00.000Z",
    };
    const states = [published, acknowledged, ...[ACTOR, { ...claimant, displayName: "Renamed claimant" }].map((closedBy) => ({
      ...acknowledged, state: "closed" as const, entityRevision: 3,
      closedBy, closedAt: "2026-08-27T12:00:00.000Z",
    }))];
    for (const input of states) {
      const bytes = serializeRelayArtifact(input);
      const parsed = parseRelayArtifact(bytes, relayArtifactPath(RELAY));
      expect(parsed).toMatchObject({
        schemaVersion: 4, audience: "team", recipients: [], state: input.state,
        publishedAt: NOW, publishedRepoState: PUBLICATION_STATE,
      });
      expect(parsed).not.toHaveProperty("workstream");
      const { ref, kind: _kind, sourcePath: _sourcePath, revision: _revision, ...content } = parsed;
      expect(serializeRelayArtifact({ id: ref.id, ...content })).toBe(bytes);
    }
  });

  it("rejects ambiguous team audiences, legacy principals, and unrelated v4 closers", () => {
    const valid = teamRelayInput();
    const unknown = { kind: "unknown" as const };
    const outsider: ActorRef = {
      kind: "member", memberId: generateArtifactId("member", { now: 10, random: new Uint8Array(10).fill(10) }),
    };
    for (const patch of [
      { audience: undefined }, { audience: "members" }, { recipients: [ACTOR] },
      { workstream: { id: WORKSTREAM, kind: "workstream" } }, { sender: unknown },
      { publishedAt: undefined }, { publishedRepoState: undefined },
      { state: "acknowledged", acknowledgedBy: unknown, acknowledgedAt: NOW },
      { state: "closed", acknowledgedBy: ACTOR, acknowledgedAt: NOW, closedBy: unknown, closedAt: NOW },
      { state: "closed", acknowledgedBy: ACTOR, acknowledgedAt: NOW, closedBy: outsider, closedAt: NOW },
      { state: "acknowledged", acknowledgedBy: outsider, acknowledgedAt: "2026-08-26T10:00:00.000Z" },
    ]) {
      expect(() => serializeRelayArtifact({ ...valid, ...patch } as never)).toThrow();
    }
    for (const bytes of [
      RELAY_V4_GOLDEN.replace('audience: "team"\n', ""),
      RELAY_V4_GOLDEN.replace('audience: "team"', 'audience: "members"'),
      RELAY_V4_GOLDEN.replace("recipients: []", `recipients: [${JSON.stringify(ACTOR)}]`),
      RELAY_V4_GOLDEN.replace("schema_version: 4", "schema_version: 5"),
    ]) expect(() => parseRelayArtifact(bytes, relayArtifactPath(RELAY))).toThrow();
  });

  it("keeps local draft audiences explicit and bounds named Member identity", () => {
    const unaddressed = normalizeRelayDraftInput({ recipients: [], summary: "Capture before routing" });
    expect(unaddressed.recipients).toEqual([]);
    expect(unaddressed).not.toHaveProperty("audience");
    for (const audience of ["team", "members"] as const) {
      expect(normalizeRelayDraftInput({ ...unaddressed, audience })).toMatchObject({ audience, recipients: [] });
    }
    const members = Array.from({ length: 33 }, (_, index) => ({
      kind: "member" as const,
      memberId: generateArtifactId("member", { now: 100 + index, random: new Uint8Array(10).fill(index) }),
    }));
    expect(normalizeRelayDraftInput({ ...unaddressed, audience: "members", recipients: members.slice(0, 32) }).recipients).toHaveLength(32);
    for (const patch of [
      { audience: "all" }, { audience: "team", recipients: [ACTOR] }, { recipients: members },
      { recipients: [{ kind: "unknown" }] },
      { recipients: [{ kind: "git", name: "Name", email: "person@example.com" }] },
      { recipients: [ACTOR, { ...ACTOR, displayName: "Renamed" }] },
    ]) expect(() => normalizeRelayDraftInput({ ...unaddressed, ...patch })).toThrow();
  });

  it("preserves new and omitted draft audiences through bounded legacy evidence translation", () => {
    const workstream = { id: WORKSTREAM, kind: "workstream" as const };
    const evidence = Array.from({ length: 64 }, (_, index) => ({ kind: "manual" as const, note: `Evidence ${index}` }));
    for (const audience of [undefined, "members", "team"] as const) {
      const input = { recipients: [], summary: "Legacy handoff", workstream, evidence, ...(audience === undefined ? {} : { audience }) };
      const before = structuredClone(input);
      const normalized = normalizeRelayDraftInputWithLegacy(input);
      expect(input).toEqual(before);
      expect(normalized.legacy).toEqual({ workstream, evidence });
      expect(normalized.input.evidence).toHaveLength(65);
      expect(normalized.input.evidence[0]).toEqual({ kind: "entity", entity: workstream });
      if (audience === undefined) expect(normalized.input).not.toHaveProperty("audience");
      else expect(normalized.input.audience).toBe(audience);
      expect(normalizeRelayDraftInput(normalized.input)).toEqual(normalized.input);
    }
    const translated = normalizeRelayDraftInput({ recipients: [], summary: "Team", audience: "team", workstream, evidence });
    const canonical = { ...teamRelayInput(), evidence: translated.evidence };
    expect(parseRelayArtifact(serializeRelayArtifact(canonical), relayArtifactPath(RELAY)).evidence).toHaveLength(65);
    for (const invalidEvidence of [
      [...evidence, { kind: "manual" as const, note: "Unreserved" }],
      [...translated.evidence, { kind: "manual" as const, note: "Overflow" }],
    ]) {
      expect(() => normalizeRelayDraftInput({ ...translated, evidence: invalidEvidence })).toThrow();
      expect(() => serializeRelayArtifact({ ...canonical, evidence: invalidEvidence })).toThrow();
    }
  });

  it("normalizes sparse standalone drafts and translates the one bounded legacy evidence slot without mutation", () => {
    const sparse = { recipients: [ACTOR], summary: "Sparse handoff" };
    expect(normalizeRelayDraftInput(sparse)).toEqual({
      recipients: [ACTOR],
      summary: "Sparse handoff",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
    });

    const fullEvidence = Array.from({ length: 64 }, (_, index) => ({
      kind: "manual" as const,
      note: `Legacy evidence ${index}`,
    }));
    const legacy = {
      ...sparse,
      workstream: { id: WORKSTREAM, kind: "workstream" as const, title: "Release" },
      evidence: fullEvidence,
    };
    const before = structuredClone(legacy);
    const compatibility = normalizeRelayDraftInputWithLegacy(legacy);
    const translated = compatibility.input;
    expect(legacy).toEqual(before);
    expect(compatibility.legacy).toEqual({
      workstream: legacy.workstream,
      evidence: fullEvidence,
    });
    expect(translated).not.toHaveProperty("workstream");
    expect(translated.evidence).toHaveLength(65);
    expect(translated.evidence[0]).toEqual({
      kind: "entity",
      entity: legacy.workstream,
    });
    expect(normalizeRelayDraftInput(translated)).toEqual(translated);

    const alreadyReferenced = normalizeRelayDraftInput({
      ...legacy,
      evidence: [
        { kind: "entity", entity: legacy.workstream },
        ...fullEvidence.slice(0, 63),
      ],
    });
    expect(alreadyReferenced.evidence).toHaveLength(64);
    expect(() => normalizeRelayDraftInput({
      ...sparse,
      evidence: fullEvidence.concat({ kind: "manual", note: "Not reserved" }),
    })).toThrow(/reserved translated Workstream evidence slot/);
    expect(() => normalizeRelayDraftInput({
      ...sparse,
      workstream: { id: "ws_not-a-ulid", kind: "workstream" },
    })).toThrow(/ws_ prefixed ULID/);
    expect(() => normalizeRelayDraftInput({
      ...sparse,
      publishedRepoState: {
        branch: "main",
        head: "1".repeat(40),
        dirty: false,
        observedAt: NOW,
      },
    })).toThrow();
  });

  it("rejects lone-surrogate paths during Relay product normalization", () => {
    expect(() => normalizeRelayProductDraftInput({
      recipients: [ACTOR],
      workstream: { id: WORKSTREAM, kind: "workstream" },
      summary: "Handoff",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: ["src/\ud800.ts"],
      code: [],
      evidence: [],
      nextActions: ["Review"],
    })).toThrow();
  });

  it("persists a bounded declarative Wiki request without actor, time, handles, or plans", () => {
    const document = serializeInboxProposalArtifact({
      id: PROPOSAL, state: "pending", author: ACTOR, rationale: "Keep docs current", evidence: [],
      request: {
        operation: { opId: "wiki-op-1", type: "update-entry", entityId: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD", payload: { summary: "Updated" } },
        expectedRevisions: [],
      },
      targetRevisions: [],
    });
    expect(document).not.toContain("actor");
    expect(document).not.toContain("timestamp");
    expect(parseInboxProposalArtifact(document, inboxProposalArtifactPath(PROPOSAL))).toMatchObject({
      state: "pending", request: { operation: { opId: "wiki-op-1", type: "update-entry" } },
    });

    expect(() => serializeInboxProposalArtifact({
      id: PROPOSAL, state: "pending", author: ACTOR, rationale: "Unsafe", evidence: [],
      request: { operation: { opId: "wiki-op-2", type: "update-entry", payload: { compiledPlan: { handle: 7 } } }, expectedRevisions: [] },
      targetRevisions: [],
    })).toThrow(/process-local/);
  });

  it("rejects checkout-local revision targets before a draft can become canonical", () => {
    const base = {
      request: {
        operation: {
          opId: "wiki-op-portable",
          type: "update-entry" as const,
          payload: { summary: "Portable" },
        },
        expectedRevisions: [],
      },
      rationale: "Keep proposal preconditions clone-portable.",
      evidence: [],
    };
    expect(() => normalizeInboxDraftInput({
      ...base,
      targetRevisions: [{
        target: { kind: "local", namespace: "inbox-draft", id: "draft-private" },
        revision: "a".repeat(64),
      }],
    })).toThrow(/checkout-local targets/);
    expect(() => normalizeInboxDraftInput({
      ...base,
      targetRevisions: [{
        target: { kind: "artifact", path: ".mex/local/private.json" },
        revision: "b".repeat(64),
      }],
    })).toThrow(/checkout-local artifact paths/);
  });

  it("preserves governed multiline prose while rejecting noncanonical controls", () => {
    const base = {
      request: {
        operation: {
          opId: "wiki-op-multiline",
          type: "create-entry" as const,
          payload: { body: "First line\n\tIndented line" },
        },
        expectedRevisions: [],
      },
      rationale: "First reason\n\tSecond reason",
      evidence: [
        { kind: "manual" as const, note: "Observed\n\tin review" },
        { kind: "external" as const, uri: "https://example.test/review", label: "Review notes" },
      ],
      targetRevisions: [],
    };
    expect(normalizeInboxDraftInput(base)).toEqual(base);
    const pending = serializeInboxProposalArtifact({
      id: PROPOSAL,
      state: "pending",
      author: ACTOR,
      rationale: base.rationale,
      evidence: base.evidence,
      request: base.request,
      targetRevisions: [],
    });
    expect(parseInboxProposalArtifact(pending, inboxProposalArtifactPath(PROPOSAL))).toMatchObject({
      rationale: base.rationale,
      evidence: base.evidence,
    });
    const rejected = serializeInboxProposalArtifact({
      id: PROPOSAL,
      state: "rejected",
      author: ACTOR,
      rationale: base.rationale,
      evidence: base.evidence,
      request: base.request,
      targetRevisions: [],
      reviewer: ACTOR,
      reviewedAt: NOW,
      reviewRationale: "First finding\n\tSecond finding",
    });
    expect(parseInboxProposalArtifact(rejected, inboxProposalArtifactPath(PROPOSAL))).toMatchObject({
      reviewRationale: "First finding\n\tSecond finding",
    });
    for (const hostile of ["bad\u0001control", "e\u0301", "bad\ud800"]) {
      expect(() => normalizeInboxDraftInput({ ...base, rationale: hostile }), JSON.stringify(hostile)).toThrow();
      expect(() => normalizeInboxDraftInput({
        ...base,
        evidence: [{ kind: "manual", note: hostile }],
      })).toThrow();
    }
    expect(() => normalizeInboxDraftInput({
      ...base,
      evidence: [{ kind: "external", uri: "https://example.test/\nunsafe", label: "Safe label" }],
    })).toThrow();
    expect(() => normalizeInboxDraftInput({
      ...base,
      evidence: [{ kind: "external", uri: "https://example.test/safe", label: "Not\nmultiline" }],
    })).toThrow();
    for (const hostile of ["bad\u0085label", "bad\u2028label", "bad\u2029label", "bad\ud800", "e\u0301", " padded "]) {
      expect(() => normalizeInboxDraftInput({
        ...base,
        evidence: [{ kind: "external", uri: "https://example.test/safe", label: hostile }],
      }), JSON.stringify(hostile)).toThrow();
    }
    for (const hostile of ["https://example.test/bad\u0085uri", "https://example.test/bad\u2028uri", "https://example.test/bad\ud800"] ) {
      expect(() => normalizeInboxDraftInput({
        ...base,
        evidence: [{ kind: "external", uri: hostile, label: "Safe label" }],
      }), JSON.stringify(hostile)).toThrow();
    }
  });

  it("rejects wrong paths, noncanonical bytes, lifecycle contradictions, and bodies", () => {
    const document = serializeWorkstreamArtifact({
      id: WORKSTREAM, entityRevision: 1, state: "blocked", title: "Blocked", goal: "Unblock", summary: "Waiting", owners: [ACTOR],
      contributors: [], paths: [], code: [], topics: [], components: [], related: [], blockers: ["Approval"], currentState: "Waiting",
      nextMilestone: "Approval", createdBy: ACTOR, createdAt: NOW, updatedBy: ACTOR, updatedAt: NOW,
    });
    expect(() => parseWorkstreamArtifact(document, `.mex/workstreams/${RELAY}.md` as RepoRelativePath)).toThrow(/path must/);
    expect(() => parseWorkstreamArtifact(document.replace("schema_version: 1\n", "").replace("id:", "id:\n schema_version: 1\nignored:"), workstreamArtifactPath(WORKSTREAM))).toThrow();
    expect(() => parseWorkstreamArtifact(`${document}body\n`, workstreamArtifactPath(WORKSTREAM))).toThrow(/frontmatter only/);
    expect(() => serializeWorkstreamArtifact({
      id: WORKSTREAM, entityRevision: 1, state: "active", title: "Invalid", goal: "No blockers", summary: "Contradiction", owners: [ACTOR],
      contributors: [], paths: [], code: [], topics: [], components: [], related: [], blockers: ["Still blocked"], currentState: "Active",
      nextMilestone: "Soon", createdBy: ACTOR, createdAt: NOW, updatedBy: ACTOR, updatedAt: NOW,
    })).toThrow(/blocked workstream/);
  });
});

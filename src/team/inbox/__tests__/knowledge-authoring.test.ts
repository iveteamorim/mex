import { describe, expect, it } from "vitest";
import type { InboxProposal, TeamInboxSpecDraftInput, TeamWorkflowAuthority } from "../../contracts/workflow.js";
import type { JsonValue } from "../../contracts/shared.js";
import { assertExactSpecAttestations, inboxDraftInputFromProduct, materializeSpecWikiRequest, normalizeTeamInboxSpecCommand, productInputFromInboxDraft } from "../spec-authoring.js";

const ID = "mx_01J00000000000000000000016";
const HASH = "a".repeat(64);
const input: TeamInboxSpecDraftInput = { change: { kind: "knowledge.create", entityKind: "decision", title: "Keep the evidence", body: "A specific durable decision.", status: "promoted" }, rationale: "Review this change.", evidence: [], targetRevisions: [] };
const authority: TeamWorkflowAuthority = { actor: { kind: "member", memberId: "reviewer", displayName: "Reviewer" }, occurredAt: "2026-09-08T04:00:00.000Z", repoState: { branch: "main", head: "b".repeat(40), dirty: true, observedAt: "2026-09-08T04:00:00.000Z" } };
const command = (draft: unknown) => ({ operationId: "knowledge_validation", action: { kind: "inbox.draft.save", draft }, expectedRevisions: [] });

describe("closed Knowledge Inbox authoring", () => {
  it.each([
    { file: "../../escape.md" }, { adopt: true }, { relation: { type: "related_to", target: { id: ID, kind: "decision" } } },
    { provenance: { createdBy: { kind: "human", id: "forged" } } }, { groundsTo: [] },
    { operations: [{ type: "update-entry", entityId: ID, payload: { body: "Hidden write" } }] },
    { entityKind: "topic" }, { entityKind: "spec" }, { entityKind: "member" },
  ])("rejects caller-controlled scope or attribution %j", (extra) => {
    expect(() => normalizeTeamInboxSpecCommand(command({ ...input, change: { ...input.change, ...extra } }))).toThrow();
  });

  it.each([{ status: "archived" }, { sources: [] }, { appendSources: [] }, { type: "architecture" }, {}])("keeps corrections limited to nonempty text patches %j", (patch) => {
    expect(() => normalizeTeamInboxSpecCommand(command({ ...input, change: { kind: "knowledge.update", target: { id: ID, kind: "decision" }, patch }, targetRevisions: [{ target: { kind: "entity", id: ID }, revision: HASH, semanticRevision: 1 }] }))).toThrow();
  });

  it("requires the exact reviewed target kind and revision and rejects unrelated expectations", () => {
    const update = { ...input, change: { kind: "knowledge.update" as const, target: { id: ID, kind: "decision" as const }, patch: { body: "Correction." } }, targetRevisions: [{ target: { kind: "entity" as const, id: ID }, revision: HASH, semanticRevision: 1 }] };
    const attestations = [{ id: ID, entity: { ref: { id: ID, kind: "decision" }, version: { semanticRevision: 1, contentHash: HASH } } }];
    expect(() => assertExactSpecAttestations(update.change, update.targetRevisions, attestations)).not.toThrow();
    expect(() => assertExactSpecAttestations(update.change, update.targetRevisions, [{ ...attestations[0], entity: { ...attestations[0]!.entity, ref: { id: ID, kind: "spec" } } }])).toThrow();
    expect(() => normalizeTeamInboxSpecCommand(command({ ...update, targetRevisions: [] }))).toThrow();
    expect(() => normalizeTeamInboxSpecCommand(command({ ...input, targetRevisions: update.targetRevisions }))).toThrow();
    expect(() => normalizeTeamInboxSpecCommand(command({ ...input, change: { ...input.change, body: "x".repeat(16 * 1024 + 1) } }))).toThrow();
  });

  it("uses an additive payload discriminator and refuses a new change masquerading as a legacy payload", () => {
    const stored = inboxDraftInputFromProduct(input, "knowledge_versioned");
    expect(stored.request.operation.payload).toMatchObject({ kind: "mex.team.inbox.knowledge-change.v1", change: { kind: "knowledge.create" } });
    expect(productInputFromInboxDraft(stored)).toEqual(input);
    const tampered = structuredClone(stored);
    (tampered.request.operation.payload as { kind: string }).kind = "mex.team.inbox.spec-change.v1";
    expect(() => productInputFromInboxDraft(tampered)).toThrow();
    const legacyInput: TeamInboxSpecDraftInput = { ...input, change: { kind: "spec.create", entityKind: "spec", title: "Legacy Spec", body: "Legacy content.", status: "in_flight" } };
    const legacy = inboxDraftInputFromProduct(legacyInput, "legacy_still_readable");
    expect(legacy.request.operation.payload).toMatchObject({ kind: "mex.team.inbox.spec-change.v1" });
    expect(productInputFromInboxDraft(legacy)).toEqual(legacyInput);
    const proposal = { ...legacy, schemaVersion: 1, kind: "proposal", ref: { id: "proposal-test", kind: "proposal" }, sourcePath: ".mex/inbox/proposal-test.md", revision: HASH, state: "pending", author: authority.actor } as InboxProposal<JsonValue>;
    expect(materializeSpecWikiRequest(proposal, authority, ID).operation.payload).not.toHaveProperty("sources");
    expect(materializeSpecWikiRequest(proposal, authority, ID).operation.payload).not.toHaveProperty("provenance");
  });

  it("records the proposer separately from reviewer, preserves multiline evidence, and does not invent unknown producers", () => {
    const stored = inboxDraftInputFromProduct({ ...input, rationale: "First line.\nSecond line.", evidence: [{ kind: "manual", note: "One\n\ttwo" }] }, "attribution");
    const proposal = { ...stored, schemaVersion: 1, kind: "proposal", ref: { id: "proposal-test", kind: "proposal" }, sourcePath: ".mex/inbox/proposal-test.md", revision: HASH, state: "pending", author: { kind: "member", memberId: "author", displayName: "Author" } } as InboxProposal<JsonValue>;
    const request = materializeSpecWikiRequest(proposal, authority, ID);
    expect(request.operation).toMatchObject({ actor: { kind: "human", id: "reviewer" }, payload: { provenance: { createdBy: { kind: "human", id: "author" } }, sources: [ { note: "First line.\nSecond line.", metadata: { author: proposal.author, approvedBy: authority.actor } }, { note: "One\n\ttwo" } ] } });
    expect(request.operation.payload).not.toHaveProperty("groundsTo");
    const reordered = { ...authority, actor: { displayName: "Reviewer", memberId: "reviewer", kind: "member" as const } };
    expect(JSON.stringify(materializeSpecWikiRequest(proposal, reordered, ID))).toBe(JSON.stringify(request));
    expect(materializeSpecWikiRequest({ ...proposal, author: { kind: "unknown" } }, authority, ID).operation.payload).not.toHaveProperty("provenance");
  });
});

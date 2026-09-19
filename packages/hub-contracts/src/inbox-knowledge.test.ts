import { describe, expect, it } from "vitest";
import { InboxDraftInputSchema, InboxKnowledgeKindSchema, InboxProposalSummarySchema } from "./index.js";

const id = "mx_01000000000000000000000001";
const draft = {
  change: { kind: "knowledge.create", entityKind: "pattern", title: "Preserve reviewed evidence", body: "Keep the accepted baseline until review.", status: "in_flight" },
  rationale: "An automatic refresh must not erase drift.", evidence: [], targetRevisions: [],
};

describe("private Hub knowledge Inbox contracts", () => {
  it.each(InboxKnowledgeKindSchema.options)("accepts one %s create with unchanged canonical text", (entityKind) => {
    const input = { ...draft, change: { ...draft.change, entityKind, summary: "", body: "First line\n\tSecond line" } };
    expect(InboxDraftInputSchema.parse(input)).toEqual(input);
  });

  it("retains the legacy Spec discriminators and rejects crossed kinds or knowledge hierarchy edits", () => {
    expect(InboxDraftInputSchema.safeParse({ ...draft, change: { ...draft.change, kind: "spec.create", entityKind: "spec" } }).success).toBe(true);
    for (const change of [
      { ...draft.change, entityKind: "spec" },
      { ...draft.change, kind: "spec.create" },
      { ...draft.change, relation: { type: "related_to", target: { id, kind: "pattern" } } },
    ]) expect(InboxDraftInputSchema.safeParse({ ...draft, change }).success).toBe(false);
  });

  it("requires exact target coverage and keeps explicit summary clearing distinct from an empty update", () => {
    const input = { ...draft,
      change: { kind: "knowledge.update", target: { id, kind: "architecture" }, patch: { summary: "" } },
      targetRevisions: [{ target: { kind: "entity", id }, revision: "a".repeat(64), semanticRevision: 3 }],
    };
    expect(InboxDraftInputSchema.parse(input)).toEqual(input);
    expect(InboxDraftInputSchema.safeParse({ ...input, targetRevisions: [] }).success).toBe(false);
    expect(InboxDraftInputSchema.safeParse({ ...input, targetRevisions: [...input.targetRevisions, ...input.targetRevisions] }).success).toBe(false);
    expect(InboxDraftInputSchema.safeParse({ ...input, change: { ...input.change, patch: {} } }).success).toBe(false);
    expect(InboxDraftInputSchema.safeParse({ ...input, change: { ...input.change, patch: { status: "promoted" } } }).success).toBe(false);
  });

  it("allows knowledge summaries without changing proposal identity or review authority rules", () => {
    const proposalId = "proposal_01000000000000000000001720";
    const summary = {
      schemaVersion: 1, ref: { id: proposalId, kind: "proposal" }, sourcePath: `.mex/inbox/${proposalId}.md`,
      revision: "b".repeat(64), state: "pending", author: { kind: "unknown" },
      changeKind: "knowledge.update", entityKind: "guide", title: "Setup guide", rationaleExcerpt: "Clarify installation.",
    };
    expect(InboxProposalSummarySchema.safeParse(summary).success).toBe(true);
    expect(InboxProposalSummarySchema.safeParse({ ...summary, state: "approved" }).success).toBe(false);
  });
});

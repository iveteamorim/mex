import { describe, expect, it } from "vitest";
import {
  RelayDetailSchema, RelayDraftDetailSchema, RelayDraftInputSchema,
  RelayDraftSummarySchema, RelayOperationPreviewRequestSchema, RelaySummarySchema,
  TeamOperationPreviewRequestSchema,
} from "./index.js";

const MEMBER = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RELAY = "relay_01000000000000000000000001";
const member = { kind: "member" as const, memberId: MEMBER };
const revision = "a".repeat(64);
const now = "2026-09-08T10:00:00.000Z";
const draft = RelayDraftInputSchema.parse({ audience: "team", recipients: [], summary: "Resume this work later" });
const canonical = {
  schemaVersion: 4, audience: "team", ref: { id: RELAY, kind: "relay" },
  sourcePath: `.mex/relays/${RELAY}.md`, revision, state: "published", sender: member,
  ...draft, workstream: null, diagnostics: [], diagnosticsTruncated: false,
  publishedAt: now, publishedRepoState: { branch: "main", head: "b".repeat(40), dirty: false, observedAt: now },
  acknowledgedBy: null, acknowledgedAt: null, closedBy: null, closedAt: null,
};

describe("Relay audiences and Member recovery", () => {
  it.each([undefined, "members", "team"] as const)("accepts a recipient-free local draft with audience %s", (audience) => {
    const input = { ...draft, audience };
    expect(RelayDraftInputSchema.safeParse(input).success).toBe(true);
    const summary = { audience, recipients: [], id: "draft-local", revision, updatedAt: now, summary: input.summary };
    expect(RelayDraftSummarySchema.safeParse(summary).success).toBe(true);
    expect(RelayDraftDetailSchema.safeParse({ ...summary, input }).success).toBe(true);
    expect(RelayOperationPreviewRequestSchema.safeParse({ operationId: "save-local", action: { kind: "relay.draft.save", draft: input }, expectedRevisions: [] }).success).toBe(true);
  });

  it("rejects team audiences carrying named recipients in every draft boundary", () => {
    const input = { ...draft, recipients: [member] };
    const summary = { audience: "team", recipients: [member], id: "draft-local", revision, updatedAt: now, summary: draft.summary };
    expect(RelayDraftInputSchema.safeParse(input).success).toBe(false);
    expect(RelayDraftSummarySchema.safeParse(summary).success).toBe(false);
    expect(RelayDraftDetailSchema.safeParse({ ...summary, input }).success).toBe(false);
    expect(RelayOperationPreviewRequestSchema.safeParse({ operationId: "save-local", action: { kind: "relay.draft.save", draft: input }, expectedRevisions: [] }).success).toBe(false);
  });

  it("requires schema-v4 team publication and preserves named schema-v3", () => {
    const parsed = RelayDetailSchema.parse(canonical);
    const { completed: _a, inProgress: _b, decisions: _c, blockers: _d, unresolvedQuestions: _e, changedFiles: _f, code: _g, evidence: _h, nextActions: _i, diagnostics: _j, diagnosticsTruncated: _k, ...summary } = parsed;
    expect(RelaySummarySchema.parse(summary)).toEqual(summary);
    for (const patch of [{ audience: undefined }, { audience: "members" }, { recipients: [member] }, { schemaVersion: 3 }, { publishedRepoState: null }, { sender: { kind: "unknown" } }]) {
      expect(RelayDetailSchema.safeParse({ ...canonical, ...patch }).success).toBe(false);
    }
    const { audience: _audience, ...legacy } = canonical;
    expect(RelayDetailSchema.safeParse({ ...legacy, schemaVersion: 3, recipients: [member] }).success).toBe(true);
    expect(RelayDetailSchema.safeParse({ ...legacy, schemaVersion: 3, recipients: [] }).success).toBe(false);
  });

  it("binds reactivation to an existing target and rejects caller-owned authority", () => {
    const request = { operationId: "reactivate-member", action: { kind: "member.reactivate", memberId: MEMBER }, expectedRevisions: [{ target: { kind: "artifact", path: `.mex/team/members/${MEMBER}.md` }, revision }] };
    expect(TeamOperationPreviewRequestSchema.parse(request)).toEqual(request);
    expect(TeamOperationPreviewRequestSchema.safeParse({ ...request, expectedRevisions: [] }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({ ...request, action: { ...request.action, actor: member } }).success).toBe(false);
  });
});

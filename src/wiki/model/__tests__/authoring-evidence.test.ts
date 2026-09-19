import { describe, expect, it } from "vitest";
import {
  authoringSourceCollectionFits,
  validateAuthoringProvenance,
  validateAuthoringSources,
} from "../authoring-evidence.js";

const context = { path: "payload.evidence" };
const source = { type: "document" as const, ref: ".mex/inbox/proposal_reviewed.md", metadata: { approvedBy: { kind: "human", id: "reviewer" } } };

describe("bounded authoring evidence", () => {
  it("accepts 64 evidence references plus the proposal without changing metadata", () => {
    const sources = Array.from({ length: 65 }, (_, index) => ({ ...source, ref: `evidence-${index}` }));
    expect(validateAuthoringSources(sources, context)).toMatchObject({ ok: true, value: sources });
    expect(validateAuthoringSources([...sources, source], context).ok).toBe(false);
  });

  it("rejects excessive aggregate bytes while each source field is within its individual bound", () => {
    const sources = Array.from({ length: 4 }, (_, index) => ({ ...source, ref: `evidence-${index}`, note: "x".repeat(65_536) }));
    expect(validateAuthoringSources(sources, context).ok).toBe(false);
    expect(authoringSourceCollectionFits(sources)).toBe(false);
    expect(authoringSourceCollectionFits(Array.from({ length: 200 }, (_, index) => ({ ...source, ref: `evidence-${index}` })))).toBe(true);
    expect(authoringSourceCollectionFits(Array.from({ length: 201 }, () => source))).toBe(false);
  });

  it.each([
    { ...source, ref: "x".repeat(4_097) },
    { ...source, capturedAt: "private-invalid-time" },
    { ...source, unknownField: "private-extra-field" },
    { ...source, metadata: new Map([["private", "value"]]) },
    { ...source, metadata: { private: undefined } },
    { ...source, metadata: { private: () => "function" } },
    { ...source, metadata: { private: BigInt(1) } },
    { ...source, metadata: { private: Number.POSITIVE_INFINITY } },
    { ...source, metadata: { first: { second: { third: { fourth: { private: true } } } } } },
  ])("rejects unrepresentable evidence without exposing its values", (invalid) => {
    const result = validateAuthoringSources([invalid], context);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-");
  });

  it("rejects cyclic source metadata with bounded traversal", () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    expect(validateAuthoringSources([{ ...source, metadata }], context).ok).toBe(false);
  });

  it("validates explicit creation provenance without substituting the operation actor", () => {
    const provenance = {
      createdBy: { kind: "agent", id: "producer" },
      createdAt: "2026-08-24T10:00:00.000Z",
      lastModifiedBy: { kind: "human", id: "reviewer" },
      lastModifiedAt: "2026-08-24T11:00:00.000Z",
      agentSessionId: "producer-session",
    };
    expect(validateAuthoringProvenance(provenance, context)).toMatchObject({ ok: true, value: provenance });
    for (const invalid of [
      { ...provenance, createdBy: { kind: "unknown", id: "producer" } },
      { ...provenance, createdBy: { kind: "agent", id: "" } },
      { ...provenance, createdBy: { kind: "agent", id: "producer", secret: true } },
      { ...provenance, createdAt: "yesterday" },
      { ...provenance, lastModifiedAt: "2026-99-24T11:00:00.000Z" },
      { ...provenance, agentSessionId: "x".repeat(257) },
      { ...provenance, secret: true },
    ]) expect(validateAuthoringProvenance(invalid, context).ok).toBe(false);
  });
});

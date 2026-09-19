/**
 * Relationship formation, against the inherited oracle.
 *
 * The first three cases came with the pipeline. They pin the three properties
 * that make this stage worth having: candidates come only from structure, the
 * allowed-type menu is computed rather than guessed, and a weak `related_to`
 * is refused at its own higher bar. Only the projection type, the reader's
 * method name and the persistence half moved — the reference persisted rows;
 * here the same judgements become `add-relation` envelopes.
 */

import { describe, it, expect } from "vitest";
import {
  allowedTypesFor,
  findRelationshipCandidates,
  planRelationships,
  RELATIONSHIP_CONFIDENCE,
  RELATIONSHIP_DEFAULTS,
  RELATIONSHIP_TYPES,
  validateRelationshipJudgments,
  type RelationshipGraphReader,
} from "../relationships.js";
import { WIKI_RELATION_TYPES } from "../../model/relation.js";
import type { WikiUnit } from "../global-pass.js";

function unit(overrides: Partial<WikiUnit> & { id: string; type: string }): WikiUnit {
  return {
    title: `title-${overrides.id}`,
    summary: `summary-${overrides.id}`,
    body: `body-${overrides.id}`,
    status: "promoted",
    file: "context/architecture.md",
    groundingNodeIds: [],
    revision: 1,
    contentHash: "c".repeat(64),
    ...overrides,
  };
}

function stubGraph(edges: Record<string, Array<{ source: string; target: string; kind: string }>>): RelationshipGraphReader {
  return { outgoingEdges: (nodeId) => edges[nodeId] ?? [] };
}

const UNITS: WikiUnit[] = [
  unit({ id: "U_COMPONENT", type: "component", groundingNodeIds: ["nA"] }),
  unit({ id: "U_PATTERN", type: "pattern", groundingNodeIds: ["nB"] }),
  unit({ id: "U_CONVENTION", type: "convention", groundingNodeIds: ["nC"] }),
  unit({ id: "U_ISOLATED", type: "fact", groundingNodeIds: ["nZ"] }),
];

// nA implements nB (a component realizing a pattern); nA calls nC.
const GRAPH = stubGraph({
  nA: [
    { source: "nA", target: "nB", kind: "implements" },
    { source: "nA", target: "nC", kind: "calls" },
  ],
});

describe("relationship formation (pure logic)", () => {
  it("generates only structurally connected candidates, never a Cartesian product", () => {
    const candidates = findRelationshipCandidates(UNITS, GRAPH);
    const ids = candidates.flatMap((candidate) => [candidate.source.id, candidate.target.id]);
    expect(ids).not.toContain("U_ISOLATED");
    expect(candidates.length).toBe(2);
  });

  it("orients direction from the edges and offers specific allowed types", () => {
    const candidates = findRelationshipCandidates(UNITS, GRAPH);
    const implementing = candidates.find(
      (candidate) => candidate.source.id === "U_COMPONENT" && candidate.target.id === "U_PATTERN",
    );
    expect(implementing).toBeDefined();
    expect(implementing!.allowedTypes).toContain("implements");
    expect(implementing!.evidence.abstractionEdges?.length).toBe(1);

    const convention = candidates.find((candidate) =>
      [candidate.source.id, candidate.target.id].includes("U_CONVENTION"),
    );
    expect(convention!.allowedTypes).toContain("constrained_by");
  });

  it("validates a create, refuses a weak related_to, and then refuses the duplicate", () => {
    const candidates = findRelationshipCandidates(UNITS, GRAPH);
    const implementing = candidates.find(
      (candidate) => candidate.source.id === "U_COMPONENT" && candidate.target.id === "U_PATTERN",
    )!;
    const convention = candidates.find((candidate) =>
      [candidate.source.id, candidate.target.id].includes("U_CONVENTION"),
    )!;

    const activeIds = new Set(UNITS.map((entry) => entry.id));
    const { valid, skipped, rejected } = validateRelationshipJudgments(
      [
        {
          candidateId: implementing.candidateId,
          action: "create",
          type: "implements",
          sourceId: "U_COMPONENT",
          targetId: "U_PATTERN",
          confidence: 0.92,
          evidence: "nA implements nB in the code graph",
          reasoning: "the component realizes the pattern; direction concrete to abstract",
        },
        {
          // `related_to` below its 0.9 bar, above every other type's 0.8.
          candidateId: convention.candidateId,
          action: "create",
          type: "related_to",
          sourceId: convention.source.id,
          targetId: convention.target.id,
          confidence: 0.82,
          evidence: "they are near each other in the tree",
          reasoning: "a weak association and nothing more",
        },
      ],
      candidates,
      { activeIds },
    );

    expect(valid).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reasons.join(" ")).toContain("threshold");

    const operations = planRelationships(valid, candidates);
    expect(operations).toHaveLength(1);
    const envelope = operations[0]!.envelope as Record<string, unknown>;
    expect(envelope["type"]).toBe("add-relation");
    expect(envelope["entityId"]).toBe("U_COMPONENT");
    const relation = (envelope["payload"] as { relation: Record<string, unknown> }).relation;
    expect(relation["type"]).toBe("implements");
    expect(relation["target"]).toBe("U_PATTERN");

    // The same edge again, once it exists, is a duplicate.
    const second = validateRelationshipJudgments(
      [
        {
          candidateId: implementing.candidateId,
          action: "create",
          type: "implements",
          sourceId: "U_COMPONENT",
          targetId: "U_PATTERN",
          confidence: 0.95,
          evidence: "the same edge, proposed a second time",
          reasoning: "a duplicate attempt that must not double the edge",
        },
      ],
      candidates,
      { activeIds, existing: [{ sourceId: "U_COMPONENT", targetId: "U_PATTERN", type: "implements" }] },
    );
    expect(second.valid).toHaveLength(0);
    expect(second.rejected[0]!.reasons.join(" ")).toContain("duplicate");
  });
});

describe("the checks the inherited set does not provoke", () => {
  const candidates = findRelationshipCandidates(UNITS, GRAPH);
  const pair = candidates.find(
    (candidate) => candidate.source.id === "U_COMPONENT" && candidate.target.id === "U_PATTERN",
  )!;
  const activeIds = new Set(UNITS.map((entry) => entry.id));

  function judge(overrides: Record<string, unknown>): ReturnType<typeof validateRelationshipJudgments> {
    return validateRelationshipJudgments(
      [
        {
          candidateId: pair.candidateId,
          action: "create",
          type: "implements",
          sourceId: "U_COMPONENT",
          targetId: "U_PATTERN",
          confidence: 0.92,
          evidence: "nA implements nB in the code graph",
          reasoning: "the component realizes the pattern",
          ...overrides,
        },
      ],
      candidates,
      { activeIds },
    );
  }

  it("refuses a type outside the candidate's menu", () => {
    expect(pair.allowedTypes).not.toContain("constrained_by");
    expect(judge({ type: "constrained_by" }).rejected[0]!.reasons.join(" ")).toContain("not in allowedTypes");
  });

  it("refuses an endpoint that is not in the pair", () => {
    expect(judge({ targetId: "U_ISOLATED" }).rejected[0]!.reasons.join(" ")).toContain("not in the candidate");
  });

  it("refuses a self-loop", () => {
    expect(judge({ targetId: "U_COMPONENT" }).rejected[0]!.reasons.join(" ")).toContain("must differ");
  });

  it("refuses an endpoint that is no longer active", () => {
    const result = validateRelationshipJudgments(
      [
        {
          candidateId: pair.candidateId,
          action: "create",
          type: "implements",
          sourceId: "U_COMPONENT",
          targetId: "U_PATTERN",
          confidence: 0.92,
          evidence: "nA implements nB in the code graph",
          reasoning: "the component realizes the pattern",
        },
      ],
      candidates,
      { activeIds: new Set(["U_COMPONENT"]) },
    );
    expect(result.rejected[0]!.reasons.join(" ")).toContain("is not active");
  });

  it("refuses a claim with no substantive justification", () => {
    expect(judge({ evidence: "eh" }).rejected[0]!.reasons.join(" ")).toContain("substantive evidence");
    expect(judge({ reasoning: "eh" }).rejected[0]!.reasons.join(" ")).toContain("substantive reasoning");
  });

  it("treats a skip as an outcome, not a failure", () => {
    const result = validateRelationshipJudgments(
      [{ candidateId: pair.candidateId, action: "skip", reasoning: "genuinely unrelated" }],
      candidates,
      { activeIds },
    );
    expect(result.skipped).toEqual([{ candidateId: pair.candidateId, reasoning: "genuinely unrelated" }]);
    expect(result.rejected).toEqual([]);
    expect(result.valid).toEqual([]);
  });

  it("refuses two judgements for one candidate", () => {
    const result = validateRelationshipJudgments(
      [
        { candidateId: pair.candidateId, action: "skip" },
        { candidateId: pair.candidateId, action: "skip" },
      ],
      candidates,
      { activeIds },
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("duplicate judgment");
  });

  it("refuses a candidate id it never proposed", () => {
    const result = validateRelationshipJudgments([{ candidateId: "rel_invented", action: "skip" }], candidates, {
      activeIds,
    });
    expect(result.rejected[0]!.reasons.join(" ")).toContain("unknown candidateId");
  });
});

describe("the vocabulary and the bounds", () => {
  it("proposes only relation types the model registers", () => {
    const registered = new Set<string>(WIKI_RELATION_TYPES);
    for (const type of RELATIONSHIP_TYPES) expect(registered.has(type), type).toBe(true);
  });

  it("holds related_to to a higher bar than every other type", () => {
    for (const type of RELATIONSHIP_TYPES) {
      if (type === "related_to") continue;
      expect(RELATIONSHIP_CONFIDENCE.related_to).toBeGreaterThan(RELATIONSHIP_CONFIDENCE[type]);
    }
  });

  it("always offers related_to and never only related_to when structure says more", () => {
    expect(allowedTypesFor("fact", "fact", false, false)).toContain("related_to");
    expect(allowedTypesFor("component", "pattern", true, false)).toEqual([
      "implements",
      "refines",
      "related_to",
    ]);
  });

  it("caps how many candidates one entity can consume", () => {
    // A hub grounded to a node everything calls would otherwise fill the batch
    // and leave every other pair unproposed.
    const hub = unit({ id: "U_HUB", type: "component", groundingNodeIds: ["hub"] });
    const spokes = Array.from({ length: 20 }, (_, index) =>
      unit({ id: `U_SPOKE_${index}`, type: "component", groundingNodeIds: [`spoke${index}`] }),
    );
    const edges: Record<string, Array<{ source: string; target: string; kind: string }>> = {
      hub: spokes.map((_, index) => ({ source: "hub", target: `spoke${index}`, kind: "calls" })),
    };

    const candidates = findRelationshipCandidates([hub, ...spokes], stubGraph(edges));
    expect(candidates.length).toBe(RELATIONSHIP_DEFAULTS.maxPerUnit);
  });

  it("ignores containment and export edges, which carry no relationship signal", () => {
    const candidates = findRelationshipCandidates(
      [unit({ id: "A", type: "component", groundingNodeIds: ["n1"] }), unit({ id: "B", type: "component", groundingNodeIds: ["n2"] })],
      stubGraph({ n1: [{ source: "n1", target: "n2", kind: "contains" }] }),
    );
    expect(candidates).toEqual([]);
  });

  it("survives a graph read that throws for one node", () => {
    // A node that has gone is a reason to skip a pair, never to fail the batch.
    const reader: RelationshipGraphReader = {
      outgoingEdges: (nodeId) => {
        if (nodeId === "nA") throw new Error("gone");
        return [];
      },
    };
    expect(() => findRelationshipCandidates(UNITS, reader)).not.toThrow();
  });

  it("is deterministic over the same units and graph", () => {
    expect(JSON.stringify(findRelationshipCandidates(UNITS, GRAPH))).toBe(
      JSON.stringify(findRelationshipCandidates(UNITS, GRAPH)),
    );
  });
});

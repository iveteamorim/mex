import { describe, it, expect } from "vitest";
import {
  CONTRADICTION_WAIVER_KEY,
  WIKI_RELATION_TYPES,
  deriveBacklinks,
  detectSupersessionCycles,
  isContradictionWaived,
  isWikiRelationType,
  validateRelationGraph,
  validateRelationRef,
  type RelationSubject,
  type WikiRelationRef,
  type WikiRelationType,
} from "../relation.js";
import { rootContext } from "../validate.js";
import { generateEntityId, type EntityId } from "../ids.js";
import { ids } from "./helpers.js";

function subject(
  id: EntityId,
  relations: WikiRelationRef[] = [],
  overrides: Partial<RelationSubject> = {},
): RelationSubject {
  return { id, type: "decision", status: "promoted", relations, ...overrides };
}

function relate(type: WikiRelationType, target: EntityId, extra: Partial<WikiRelationRef> = {}): WikiRelationRef {
  return { type, target, ...extra };
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code).sort();
}

describe("relation vocabulary", () => {
  it("has the twelve required types", () => {
    expect([...WIKI_RELATION_TYPES].sort()).toEqual(
      [
        "affects",
        "caused_by",
        "constrained_by",
        "contradicts",
        "depends_on",
        "derived_from",
        "grounded_in",
        "implements",
        "refines",
        "related_to",
        "supersedes",
        "verified_by",
      ].sort(),
    );
  });

  it("recognizes only those types", () => {
    expect(isWikiRelationType("depends_on")).toBe(true);
    expect(isWikiRelationType("parent_topic")).toBe(false);
    expect(isWikiRelationType(undefined)).toBe(false);
  });
});

describe("validateRelationRef", () => {
  it("accepts a well-formed relation", () => {
    const target = generateEntityId();
    const result = validateRelationRef(relate("depends_on", target, { note: "why" }), rootContext());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.target).toBe(target);
  });

  it("normalizes the target's case", () => {
    const result = validateRelationRef(
      { type: "affects", target: "MX_01arz3ndektsv4rrffq69g5fav" },
      rootContext(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.target).toBe("mx_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("rejects an unknown relation type", () => {
    const result = validateRelationRef({ type: "sort_of_related", target: generateEntityId() }, rootContext());
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toContain("INVALID_RELATION_TYPE");
  });

  it("rejects a target that is not an entity id", () => {
    const result = validateRelationRef({ type: "affects", target: "architecture.md" }, rootContext());
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toContain("INVALID_RELATION_TARGET");
  });

  it("reports the path of the offending field", () => {
    const result = validateRelationRef({ type: "nope", target: "nope" }, { path: "entities[3].relations[1]" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.path)).toContain("entities[3].relations[1].type");
  });
});

describe("validateRelationGraph", () => {
  it("passes a well-formed graph", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    expect(validateRelationGraph([subject(a, [relate("depends_on", b)]), subject(b)])).toEqual([]);
  });

  it("rejects a self-relation", () => {
    const [a] = ids(1) as [EntityId];
    expect(codes(validateRelationGraph([subject(a, [relate("related_to", a)])]))).toEqual(["SELF_RELATION"]);
  });

  it("rejects a duplicate (source, type, target) triple", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("depends_on", b), relate("depends_on", b)]),
      subject(b),
    ]);
    expect(codes(diagnostics)).toEqual(["DUPLICATE_RELATION"]);
  });

  it("allows the same target under two different relation types", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    expect(validateRelationGraph([subject(a, [relate("depends_on", b), relate("affects", b)]), subject(b)])).toEqual([]);
  });

  it("rejects a target that does not exist", () => {
    const [a, missing] = ids(2) as [EntityId, EntityId];
    expect(codes(validateRelationGraph([subject(a, [relate("depends_on", missing)])]))).toEqual([
      "INVALID_RELATION_TARGET",
    ]);
  });

  it("warns when an active entity points at a deprecated or archived one", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("depends_on", b)]),
      subject(b, [], { status: "archived" }),
    ]);
    expect(codes(diagnostics)).toEqual(["INACTIVE_RELATION_TARGET"]);
    expect(diagnostics[0]!.severity).toBe("warning");
  });

  it("keeps archived targets resolvable rather than dangling", () => {
    // The warning above is the *only* complaint: the relation still resolves,
    // so history does not dangle.
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("supersedes", b)]),
      subject(b, [], { status: "archived" }),
    ]);
    expect(codes(diagnostics)).not.toContain("INVALID_RELATION_TARGET");
  });

  it("reports two promoted decisions that contradict each other", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([subject(a, [relate("contradicts", b)]), subject(b)]);
    expect(codes(diagnostics)).toEqual(["CONTRADICTORY_ACTIVE_DECISIONS"]);
    expect(diagnostics[0]!.severity).toBe("error");
  });

  it("reports a contradicting pair once even when both sides declare it", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("contradicts", b)]),
      subject(b, [relate("contradicts", a)]),
    ]);
    expect(codes(diagnostics)).toEqual(["CONTRADICTORY_ACTIVE_DECISIONS"]);
  });

  it("does not report a contradiction once one side is deprecated", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("contradicts", b)]),
      subject(b, [], { status: "deprecated" }),
    ]);
    expect(codes(diagnostics)).not.toContain("CONTRADICTORY_ACTIVE_DECISIONS");
  });

  it("does not report a contradiction between non-decisions", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("contradicts", b)], { type: "pattern" }),
      subject(b, [], { type: "pattern" }),
    ]);
    expect(codes(diagnostics)).toEqual([]);
  });

  it("honours an explicit waiver on the relation", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const waived = relate("contradicts", b, { metadata: { [CONTRADICTION_WAIVER_KEY]: true } });
    expect(isContradictionWaived(waived)).toBe(true);
    expect(validateRelationGraph([subject(a, [waived]), subject(b)])).toEqual([]);
  });

  it("reports orphans only when asked", () => {
    const [a] = ids(1) as [EntityId];
    expect(validateRelationGraph([subject(a)])).toEqual([]);
    const diagnostics = validateRelationGraph([subject(a)], { reportOrphans: true });
    expect(codes(diagnostics)).toEqual(["ORPHANED_ENTITY"]);
    expect(diagnostics[0]!.severity).toBe("info");
  });

  it("does not call an entity an orphan when something points at it", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([subject(a, [relate("affects", b)]), subject(b)], {
      reportOrphans: true,
    });
    expect(codes(diagnostics)).toEqual([]);
  });

  it("collects every problem in one pass rather than stopping at the first", () => {
    const [a, b, missing] = ids(3) as [EntityId, EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("related_to", a), relate("depends_on", missing), relate("affects", b), relate("affects", b)]),
      subject(b),
    ]);
    expect(codes(diagnostics)).toEqual(["DUPLICATE_RELATION", "INVALID_RELATION_TARGET", "SELF_RELATION"]);
  });
});

describe("detectSupersessionCycles", () => {
  it("finds a direct self-cycle", () => {
    const [a] = ids(1) as [EntityId];
    expect(detectSupersessionCycles([subject(a, [relate("supersedes", a)])])).toEqual([[a]]);
  });

  it("finds a two-step cycle", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const cycles = detectSupersessionCycles([
      subject(a, [relate("supersedes", b)]),
      subject(b, [relate("supersedes", a)]),
    ]);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual([a, b].sort());
  });

  it("finds a longer cycle", () => {
    const [a, b, c, d] = ids(4) as [EntityId, EntityId, EntityId, EntityId];
    const cycles = detectSupersessionCycles([
      subject(a, [relate("supersedes", b)]),
      subject(b, [relate("supersedes", c)]),
      subject(c, [relate("supersedes", d)]),
      subject(d, [relate("supersedes", a)]),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(4);
  });

  it("reports one cycle once, not once per member", () => {
    // Rotation-independent keying: entering the same loop from three different
    // start nodes must not produce three findings.
    const [a, b, c] = ids(3) as [EntityId, EntityId, EntityId];
    const cycles = detectSupersessionCycles([
      subject(a, [relate("supersedes", b)]),
      subject(b, [relate("supersedes", c)]),
      subject(c, [relate("supersedes", a)]),
    ]);
    expect(cycles).toHaveLength(1);
  });

  it("accepts an acyclic supersession chain", () => {
    const [a, b, c] = ids(3) as [EntityId, EntityId, EntityId];
    expect(
      detectSupersessionCycles([
        subject(a, [relate("supersedes", b)]),
        subject(b, [relate("supersedes", c)]),
        subject(c),
      ]),
    ).toEqual([]);
  });

  it("ignores cycles formed by other relation types", () => {
    // Two entities that depend on each other are ordinary; only supersession
    // must be acyclic.
    const [a, b] = ids(2) as [EntityId, EntityId];
    expect(
      detectSupersessionCycles([
        subject(a, [relate("depends_on", b)]),
        subject(b, [relate("depends_on", a)]),
      ]),
    ).toEqual([]);
  });

  it("survives a deep chain without overflowing the stack", () => {
    // 5,000 entities is the calibration target; recursion would be a real risk.
    const chain = ids(5_000);
    const subjects = chain.map((id, index) =>
      subject(id, index + 1 < chain.length ? [relate("supersedes", chain[index + 1]!)] : []),
    );
    expect(detectSupersessionCycles(subjects)).toEqual([]);
  });

  it("surfaces as a SUPERSESSION_CYCLE diagnostic", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateRelationGraph([
      subject(a, [relate("supersedes", b)]),
      subject(b, [relate("supersedes", a)]),
    ]);
    expect(codes(diagnostics)).toContain("SUPERSESSION_CYCLE");
  });
});

describe("deriveBacklinks", () => {
  it("derives inverse edges without them being authored", () => {
    const [a, b, c] = ids(3) as [EntityId, EntityId, EntityId];
    const backlinks = deriveBacklinks([
      subject(a, [relate("depends_on", c)]),
      subject(b, [relate("affects", c)]),
      subject(c),
    ]);
    expect(backlinks.get(c)).toEqual([
      { type: "affects", source: b },
      { type: "depends_on", source: a },
    ]);
    // Nothing was written onto the target entity itself.
    expect(backlinks.get(a)).toBeUndefined();
  });

  it("orders deterministically by type then source id", () => {
    const [a, b, c] = ids(3) as [EntityId, EntityId, EntityId];
    const forward = deriveBacklinks([subject(a, [relate("affects", c)]), subject(b, [relate("affects", c)]), subject(c)]);
    const reverse = deriveBacklinks([subject(b, [relate("affects", c)]), subject(a, [relate("affects", c)]), subject(c)]);
    expect(forward.get(c)).toEqual(reverse.get(c));
  });

  it("carries the relation note across", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const backlinks = deriveBacklinks([subject(a, [relate("refines", b, { note: "narrower" })]), subject(b)]);
    expect(backlinks.get(b)).toEqual([{ type: "refines", source: a, note: "narrower" }]);
  });
});

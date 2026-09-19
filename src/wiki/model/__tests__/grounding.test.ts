import { describe, it, expect } from "vitest";
import {
  GROUNDING_HEALTHS,
  GROUNDING_STATES,
  aggregateGroundingHealth,
  asGraphDerived,
  compareGroundingHealth,
  groundingIdentity,
  isFingerprintShaped,
  isNodeIdShaped,
  validateGrounding,
  verifyGroundingProvenance,
  type GraphDerivedGrounding,
  type GroundingHealth,
  type GroundingResolution,
  type WikiGrounding,
} from "../grounding.js";
import type { WikiLifecycleState } from "../entity.js";
import { rootContext } from "../validate.js";
import { grounding } from "./helpers.js";

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

const fresh: GroundingResolution = {
  state: "fresh",
  health: "fresh",
  node: "function:aaaaaaaaaaaaaaaa",
  resolvedNode: "function:aaaaaaaaaaaaaaaa",
  rebound: false,
  bodyHash: "abc",
};
const changed: GroundingResolution = {
  state: "stale",
  health: "changed",
  node: "function:bbbbbbbbbbbbbbbb",
  resolvedNode: "function:bbbbbbbbbbbbbbbb",
  currentBodyHash: "def",
};
const missing: GroundingResolution = { state: "missing", health: "missing", node: "function:cccccccccccccccc" };
const ambiguous: GroundingResolution = {
  state: "unresolved",
  health: "ambiguous",
  node: "function:dddddddddddddddd",
  candidates: ["function:1111111111111111", "function:2222222222222222"],
};
const unverified: GroundingResolution = {
  state: "unresolved",
  health: "unverified",
  node: "function:eeeeeeeeeeeeeeee",
  reason: "no code graph in this checkout",
};
const ungrounded: GroundingResolution = { state: "ungrounded", health: "unverified" };

describe("grounding vocabularies", () => {
  it("has the five resolution states and five healths", () => {
    expect([...GROUNDING_STATES]).toEqual(["fresh", "stale", "missing", "unresolved", "ungrounded"]);
    expect([...GROUNDING_HEALTHS]).toEqual(["fresh", "changed", "missing", "ambiguous", "unverified"]);
  });
});

describe("lifecycle and health are separate axes", () => {
  it("does not let a health value be used as a lifecycle state", () => {
    const assignLifecycle = (state: WikiLifecycleState): WikiLifecycleState => state;
    // @ts-expect-error "stale" is grounding health, not lifecycle. The reference
    // implementation had it inside the lifecycle enum; that conflation let one
    // checkout's local drift rewrite what the team had agreed was current.
    assignLifecycle("stale");
    // @ts-expect-error likewise for every other health value.
    assignLifecycle("fresh");
    expect(assignLifecycle("promoted")).toBe("promoted");
  });

  it("does not let a lifecycle state be used as a health value", () => {
    const assignHealth = (health: GroundingHealth): GroundingHealth => health;
    // @ts-expect-error "promoted" is governance, not health.
    assignHealth("promoted");
    // @ts-expect-error "archived" is governance, not health.
    assignHealth("archived");
    expect(assignHealth("changed")).toBe("changed");
  });

  it("makes a contradictory state/health pair unrepresentable", () => {
    // The discriminated union pins health per state, so this is a compile
    // error rather than a runtime invariant nobody checks.
    // @ts-expect-error a "stale" resolution is structurally "changed".
    const bad: GroundingResolution = { state: "stale", health: "fresh", node: "n", resolvedNode: "n", currentBodyHash: "x" };
    expect(bad.state).toBe("stale");
  });

  it("requires a missing resolution to carry no resolved node", () => {
    // @ts-expect-error `missing` has no resolvedNode — there is nothing it resolved to.
    const bad: GroundingResolution = { state: "missing", health: "missing", node: "n", resolvedNode: "n" };
    expect(bad.state).toBe("missing");
  });
});

describe("aggregateGroundingHealth", () => {
  it("returns unverified for an entity with no groundings", () => {
    // Absence of evidence is not freshness. Defaulting the other way would make
    // an entirely ungrounded wiki look fully verified.
    expect(aggregateGroundingHealth([])).toBe("unverified");
  });

  it("returns fresh only when everything is fresh", () => {
    expect(aggregateGroundingHealth([fresh, fresh])).toBe("fresh");
  });

  it("takes the worst at every level of the precedence order", () => {
    expect(aggregateGroundingHealth([fresh, unverified])).toBe("unverified");
    expect(aggregateGroundingHealth([fresh, unverified, changed])).toBe("changed");
    expect(aggregateGroundingHealth([fresh, unverified, changed, ambiguous])).toBe("ambiguous");
    expect(aggregateGroundingHealth([fresh, unverified, changed, ambiguous, missing])).toBe("missing");
  });

  it("does not depend on argument order", () => {
    expect(aggregateGroundingHealth([missing, fresh])).toBe(aggregateGroundingHealth([fresh, missing]));
    expect(aggregateGroundingHealth([ambiguous, changed])).toBe(aggregateGroundingHealth([changed, ambiguous]));
  });

  it("treats an ungrounded resolution as unverified", () => {
    expect(aggregateGroundingHealth([ungrounded])).toBe("unverified");
    expect(aggregateGroundingHealth([ungrounded, fresh])).toBe("unverified");
  });

  it("orders healths worst-first for query ranking", () => {
    const sorted = [...GROUNDING_HEALTHS].sort(compareGroundingHealth);
    expect(sorted).toEqual(["missing", "ambiguous", "changed", "unverified", "fresh"]);
  });
});

describe("validateGrounding", () => {
  it("accepts a graph-produced grounding", () => {
    const result = validateGrounding(grounding(), rootContext());
    expect(result.ok).toBe(true);
  });

  it("accepts the optional display fields", () => {
    const result = validateGrounding(
      { ...grounding(), file: "src/auth.ts", commit: "8f21a3c", verifiedAt: "2026-08-22T10:00:00Z", reason: "core rule" },
      rootContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("requires a node", () => {
    const result = validateGrounding({ fingerprint: "mh:64:9f2a" }, rootContext());
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toContain("MALFORMED_GROUNDING");
  });

  it("requires a fingerprint", () => {
    // A node id alone cannot detect drift, so it is not grounding.
    const result = validateGrounding({ node: "function:a3f8c21d9e4b7f60" }, rootContext());
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toContain("MALFORMED_GROUNDING");
  });

  it("rejects a function name written where a node id belongs", () => {
    // The most common agent mistake: writing what it can see rather than what
    // the graph produced.
    const result = validateGrounding({ ...grounding(), node: "rotateRefreshToken" }, rootContext());
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toContain("MALFORMED_GROUNDING");
  });

  it("rejects a fingerprint that is not in mh:<K>:<hex> form", () => {
    for (const bad of ["9f2a4c6e", "mh:9f2a4c6e", "mh:64:", "mh:64:zzzz", "mh:64:9f2a4"]) {
      const result = validateGrounding({ ...grounding(), fingerprint: bad }, rootContext());
      expect(result.ok, `expected ${bad} to be rejected`).toBe(false);
    }
  });

  it("accepts fingerprints from other K values", () => {
    // K is a graph tuning parameter; the model checks shape, not the value.
    expect(validateGrounding({ ...grounding(), fingerprint: "mh:128:9f2a" }, rootContext()).ok).toBe(true);
  });

  it("rejects a malformed verifiedAt", () => {
    const result = validateGrounding({ ...grounding(), verifiedAt: "yesterday" }, rootContext());
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics)).toContain("MALFORMED_GROUNDING");
  });

  it.each(["/etc/passwd", "../outside.ts", "src\\secret.ts", "src/../secret.ts", "src/\0secret.ts"])(
    "rejects unsafe canonical grounding file path %j",
    (file) => {
      const result = validateGrounding({ ...grounding(), file }, rootContext());
      expect(result.ok).toBe(false);
      expect(codes(result.diagnostics)).toContain("MALFORMED_GROUNDING");
    },
  );

  it("rejects a non-object", () => {
    expect(validateGrounding("function:abc", rootContext()).ok).toBe(false);
    expect(validateGrounding(null, rootContext()).ok).toBe(false);
  });
});

describe("node id and fingerprint shape guards", () => {
  it("recognizes graph-shaped node ids", () => {
    expect(isNodeIdShaped("function:a3f8c21d")).toBe(true);
    expect(isNodeIdShaped("type_alias:a3f8c21d")).toBe(true);
    expect(isNodeIdShaped("rotateToken")).toBe(false);
    expect(isNodeIdShaped("function:")).toBe(false);
    expect(isNodeIdShaped(42)).toBe(false);
  });

  it("recognizes serialized fingerprints", () => {
    expect(isFingerprintShaped("mh:64:9f2a")).toBe(true);
    expect(isFingerprintShaped("mh:64:9f2")).toBe(false);
    expect(isFingerprintShaped(null)).toBe(false);
  });
});

describe("grounding provenance", () => {
  it("accepts groundings the graph can re-derive", () => {
    const groundings: WikiGrounding[] = [grounding()];
    expect(verifyGroundingProvenance(groundings, () => true)).toEqual([]);
  });

  it("rejects a caller-supplied value the graph cannot re-derive", () => {
    // §12.4's invariant: an id that merely *looks* right is not grounding. This
    // is what stops an agent inventing a plausible node id and fingerprint.
    const diagnostics = verifyGroundingProvenance([grounding()], () => false);
    expect(codes(diagnostics)).toEqual(["GROUNDING_UNVERIFIED"]);
    expect(diagnostics[0]!.severity).toBe("error");
  });

  it("reports each unverified grounding with its own path", () => {
    const diagnostics = verifyGroundingProvenance(
      [grounding(), grounding({ node: "function:bbbbbbbbbbbbbbbb" })],
      (entry) => entry.node.startsWith("function:a"),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe("groundsTo[1]");
  });

  it("only brands a grounding through an explicit live-graph witness", () => {
    const branded: GraphDerivedGrounding = asGraphDerived(grounding(), { derivedFromLiveGraph: true });
    expect(branded.node).toBe(grounding().node);

    const accepts = (value: GraphDerivedGrounding): string => value.node;
    // @ts-expect-error a plain grounding has not been proven to come from the graph.
    accepts(grounding());
    expect(accepts(branded)).toBe(grounding().node);
  });
});

describe("groundingIdentity", () => {
  it("identifies a grounding by its node, so re-grounding updates rather than appends", () => {
    expect(groundingIdentity(grounding())).toBe(groundingIdentity(grounding({ fingerprint: "mh:64:ffff" })));
  });

  it("distinguishes different nodes", () => {
    expect(groundingIdentity(grounding())).not.toBe(groundingIdentity(grounding({ node: "function:9999999999999999" })));
  });
});

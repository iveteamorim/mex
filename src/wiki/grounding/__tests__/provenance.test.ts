/**
 * §12.4 — an agent cannot invent a grounding.
 *
 * The rule is that a node and fingerprint are accepted only when they can be
 * re-derived from the current graph in the same process. The tests below are
 * mostly about the ways a caller can *nearly* satisfy that: a real node with a
 * copied fingerprint, a real pair with an invented body hash, a well-shaped id
 * for a node that does not exist. Each of those is what an agent that has seen
 * one real grounding will produce, and each has to be refused.
 */

import { describe, expect, it } from "vitest";
import { checkGroundingProvenance, deriveVerifiedGroundings, isGraphDerivedGrounding } from "../provenance.js";
import { deriveGrounding, type GroundedNode, type GroundingGraph } from "../adapter.js";
import { asGraphDerived, type WikiGrounding } from "../../model/grounding.js";

const NODE = "function:1a2b3c4d5e6f7a8b";
const OTHER = "function:9c8d7e6f5a4b3c2d";
const FINGERPRINT = "mh:64:0a0b0c0d";
const OTHER_FINGERPRINT = "mh:64:1a1b1c1d";

function node(id: string, bodyHash: string | null): GroundedNode {
  return { id, bodyHash, filePath: "src/auth.ts", startLine: 4, endLine: 20 };
}

function stubGraph(): GroundingGraph {
  const nodes: Record<string, GroundedNode> = {
    [NODE]: node(NODE, "body-1"),
    [OTHER]: node(OTHER, "body-2"),
  };
  const fingerprints: Record<string, string> = { [NODE]: FINGERPRINT, [OTHER]: OTHER_FINGERPRINT };
  return {
    getNode: (id) => nodes[id] ?? null,
    getFingerprint: (id) => fingerprints[id] ?? null,
    reconcile: () => ({ kind: "GONE" }),
    getBaselineSource: () => null,
  };
}

describe("deriveGrounding", () => {
  it("mints a grounding from live graph output, body hash included", () => {
    const derived = deriveGrounding(stubGraph(), NODE);
    expect(derived).toMatchObject({
      node: NODE,
      fingerprint: FINGERPRINT,
      bodyHash: "body-1",
      file: "src/auth.ts",
    });
  });

  it("returns null for a node the graph does not have", () => {
    // Not a plausible-looking record with empty fields: the caller has to
    // handle absence, because absence is the case that matters.
    expect(deriveGrounding(stubGraph(), "function:0000000000000000")).toBeNull();
  });

  it("takes a node id, so there is no caller-supplied pair to launder", () => {
    // The signature is the invariant. `deriveGrounding` cannot be handed a
    // fingerprint at all, so it cannot be tricked into blessing one — the
    // fingerprint it returns is the one it read.
    const derived = deriveGrounding(stubGraph(), NODE, { reason: "why this decision lives here" });
    expect(derived?.reason).toBe("why this decision lives here");
    expect(derived?.fingerprint).toBe(FINGERPRINT);
  });
});

describe("checkGroundingProvenance", () => {
  it("accepts a pair the graph produces", () => {
    expect(checkGroundingProvenance(
      [{ node: NODE, fingerprint: FINGERPRINT, bodyHash: "body-1" }],
      stubGraph(),
    )).toEqual([]);
  });

  it("rejects a fabricated node id", () => {
    const diagnostics = checkGroundingProvenance(
      [{ node: "function:cafebabecafebabe", fingerprint: FINGERPRINT }],
      stubGraph(),
    );
    expect(diagnostics.map((entry) => entry.code)).toEqual(["GROUNDING_UNVERIFIED"]);
  });

  it("rejects a real node carrying another node's fingerprint", () => {
    // The likely shape of a fabrication: the id is copied from real output and
    // the fingerprint from somewhere else. A node-only check waves this
    // through, and the entity is then grounded against a value that never
    // described its code.
    const diagnostics = checkGroundingProvenance(
      [{ node: NODE, fingerprint: OTHER_FINGERPRINT }],
      stubGraph(),
    );
    expect(diagnostics.map((entry) => entry.code)).toEqual(["GROUNDING_UNVERIFIED"]);
  });

  it("rejects a real pair carrying an invented body hash", () => {
    // The body hash is what every future drift verdict is measured against, so
    // accepting a wrong one poisons resolution permanently — the entity reads
    // stale forever, or reads fresh against a hash that never described it.
    const diagnostics = checkGroundingProvenance(
      [{ node: NODE, fingerprint: FINGERPRINT, bodyHash: "hash-i-made-up" }],
      stubGraph(),
    );
    expect(diagnostics.map((entry) => entry.code)).toEqual(["GROUNDING_UNVERIFIED"]);
  });

  it("rejects everything when there is no graph to re-derive from", () => {
    // The opposite of the read path. A read with no graph degrades to
    // `unverified` and shows what it has; a *write* of a permanent canonical
    // reference cannot proceed unverified merely because the thing that would
    // verify it is absent.
    const diagnostics = checkGroundingProvenance(
      [{ node: NODE, fingerprint: FINGERPRINT }, { node: OTHER, fingerprint: OTHER_FINGERPRINT }],
      null,
    );
    expect(diagnostics).toHaveLength(2);
    expect(new Set(diagnostics.map((entry) => entry.code))).toEqual(new Set(["GROUNDING_UNVERIFIED"]));
  });

  it("reports one diagnostic per bad grounding, with its index", () => {
    const diagnostics = checkGroundingProvenance(
      [
        { node: NODE, fingerprint: FINGERPRINT },
        { node: "function:cafebabecafebabe", fingerprint: FINGERPRINT },
        { node: OTHER, fingerprint: FINGERPRINT },
      ],
      stubGraph(),
    );
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((entry) => entry.path)).toEqual(["groundsTo[1]", "groundsTo[2]"]);
  });

  it("is what isGraphDerivedGrounding answers, one grounding at a time", () => {
    const graph = stubGraph();
    expect(isGraphDerivedGrounding(graph, { node: NODE, fingerprint: FINGERPRINT })).toBe(true);
    expect(isGraphDerivedGrounding(graph, { node: NODE, fingerprint: OTHER_FINGERPRINT })).toBe(false);
  });
});

describe("deriveVerifiedGroundings — the seam P5 will call", () => {
  it("returns branded values a write may use", () => {
    const result = deriveVerifiedGroundings(
      [{ node: NODE, fingerprint: FINGERPRINT, reason: "rotation policy" }],
      stubGraph(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groundings[0]).toMatchObject({
      node: NODE,
      fingerprint: FINGERPRINT,
      bodyHash: "body-1",
      reason: "rotation policy",
    });
  });

  it("re-derives rather than trusting, so a stale body hash is corrected", () => {
    // The caller passed no body hash. What comes back carries the graph's, not
    // an absence — which is what makes every mex-written grounding checkable by
    // the finer comparator from the moment it is written.
    const result = deriveVerifiedGroundings([{ node: NODE, fingerprint: FINGERPRINT }], stubGraph());
    expect(result.ok && result.groundings[0]!.bodyHash).toBe("body-1");
  });

  it("returns diagnostics and no values when any grounding fails", () => {
    const result = deriveVerifiedGroundings(
      [{ node: NODE, fingerprint: FINGERPRINT }, { node: "function:cafebabecafebabe", fingerprint: FINGERPRINT }],
      stubGraph(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // All or nothing: a partially verified set is how half an operation gets
    // written.
    expect(result.diagnostics).toHaveLength(1);
  });

  it("cannot be satisfied by a grounding that merely looks derived", () => {
    // The type-level half of the invariant, kept honest at runtime too. A
    // parsed `WikiGrounding` is not assignable to `GraphDerivedGrounding`, and
    // the only route to the brand is through the adapter — a cast here would
    // typecheck and still be refused by the check.
    const parsed: WikiGrounding = { node: "function:cafebabecafebabe", fingerprint: FINGERPRINT };
    const laundered = asGraphDerived(parsed, { derivedFromLiveGraph: true });
    expect(checkGroundingProvenance([laundered], stubGraph())).toHaveLength(1);
  });
});

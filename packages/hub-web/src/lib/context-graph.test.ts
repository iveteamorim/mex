import { describe, expect, it } from "vitest";
import {
  CONTEXT_NODE_LIMIT,
  layoutCodeSatellites,
  layoutContextGraph,
  type ContextEdge,
  type ContextNode,
  type GraphPoint,
} from "./context-graph";

const types = ["architecture", "component", "convention", "decision", "guide", "pattern"];
const nodes: readonly ContextNode[] = Array.from({ length: 30 }, (_, index) => ({
  id: `knowledge-${String(index).padStart(2, "0")}`,
  title: `Repository knowledge ${index + 1}`,
  kind: types[index % types.length]!,
}));
// Thirteen connected records and seventeen unlinked records, including sections.
const edges: readonly ContextEdge[] = Array.from({ length: 36 }, (_, index) => ({
  source: nodes[index % 13]!.id,
  target: nodes[(index % 13 + 3 + Math.floor(index / 13)) % 13]!.id,
  type: "related_to",
}));

function expectFinite(point: GraphPoint): void {
  expect(Number.isFinite(point.x)).toBe(true);
  expect(Number.isFinite(point.y)).toBe(true);
}

describe("Context knowledge layout", () => {
  it("keeps the same positions when browse results arrive in a different order", () => {
    const original = layoutContextGraph(nodes, edges, 960, 720);
    const reordered = layoutContextGraph([...nodes].reverse(), edges, 960, 720);

    expect(reordered).toEqual(original);
  });

  it("keeps the same positions when recorded relationships arrive in a different order", () => {
    const original = layoutContextGraph(nodes, edges, 960, 720);
    const reordered = layoutContextGraph(nodes, [...edges].reverse(), 960, 720);

    expect(reordered).toEqual(original);
  });

  it.each([
    [720, 720],
    [960, 720],
  ])("includes all thirty records within a %i by %i canvas", (width, height) => {
    const result = layoutContextGraph(nodes, edges, width, height);

    expect(result.size).toBe(30);
    for (const node of nodes) {
      const point = result.get(node.id);
      expect(point).toBeDefined();
      expectFinite(point!);
      expect(point!.x).toBeGreaterThanOrEqual(60);
      expect(point!.x).toBeLessThanOrEqual(width - 60);
      expect(point!.y).toBeGreaterThanOrEqual(30);
      expect(point!.y).toBeLessThanOrEqual(height - 30);
    }
    expect(new Set([...result.values()].map(({ x, y }) => `${x},${y}`)).size).toBe(30);
    for (const unlinked of nodes.slice(13)) expect(result.has(unlinked.id)).toBe(true);
  });

  it("handles empty knowledge and bounds a larger corpus", () => {
    expect(layoutContextGraph([], [], 960, 720).size).toBe(0);
    const largeCorpus = Array.from({ length: CONTEXT_NODE_LIMIT + 10 }, (_, index) => ({
      id: `large-${index}`,
      title: `Knowledge ${index}`,
      kind: "pattern",
    }));
    const result = layoutContextGraph(largeCorpus, [], 960, 720);

    expect(result.size).toBe(CONTEXT_NODE_LIMIT);
    for (const point of result.values()) expectFinite(point);
  });

  it("ignores links whose endpoints cannot appear in the knowledge layout", () => {
    const original = layoutContextGraph(nodes, edges, 960, 720);
    const withUnavailableTargets = layoutContextGraph(nodes, [
      ...edges,
      { source: nodes[0]!.id, target: "missing-record", type: "related_to" },
      { source: "missing-record", target: nodes[1]!.id, type: "related_to" },
      { source: nodes[0]!.id, target: nodes[0]!.id, type: "related_to" },
    ], 960, 720);

    expect(withUnavailableTargets).toEqual(original);
  });
});

describe("Context code expansion", () => {
  it("places a small direct grounding set inside the canvas without moving knowledge", () => {
    const base = layoutContextGraph(nodes, edges, 960, 720);
    const before = structuredClone(base);
    for (const point of base.values()) Object.freeze(point);
    const parent = base.get(nodes[0]!.id);
    const expanded = layoutCodeSatellites(["symbol-a", "symbol-b"], parent, base, 960, 720);

    expect([...expanded.keys()]).toEqual(["symbol-a", "symbol-b"]);
    for (const point of expanded.values()) {
      expectFinite(point);
      expect(point.x).toBeGreaterThanOrEqual(74);
      expect(point.x).toBeLessThanOrEqual(960 - 74);
      expect(point.y).toBeGreaterThanOrEqual(36);
      expect(point.y).toBeLessThanOrEqual(720 - 36);
      for (const knowledge of base.values()) {
        expect(Math.abs(point.x - knowledge.x) >= 132 || Math.abs(point.y - knowledge.y) >= 68).toBe(true);
      }
    }
    expect(base).toEqual(before);
    expect(layoutCodeSatellites(["symbol-a", "symbol-b"], parent, base, 960, 720)).toEqual(expanded);
    layoutCodeSatellites(["another-symbol"], base.get(nodes[1]!.id), base, 960, 720);
    expect(base).toEqual(before);
  });

  it("deduplicates and bounds a dense expansion without moving the base layout", () => {
    const base = layoutContextGraph(nodes, edges, 720, 720);
    const before = structuredClone(base);
    const ids = Array.from({ length: 70 }, (_, index) => `symbol-${index}`);
    const expanded = layoutCodeSatellites([ids[0]!, ...ids], base.get(nodes[0]!.id), base, 720, 720);

    expect(expanded.size).toBe(50);
    for (const point of expanded.values()) {
      expectFinite(point);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(720);
      expect(point.y).toBeGreaterThanOrEqual(0);
      // Dense code sets can extend the canvas; retained work must still be finite.
      expect(point.y).toBeLessThanOrEqual(720 + 50 * 100);
    }
    expect(base).toEqual(before);
  });

  it("shows no satellites without a selected knowledge record or without groundings", () => {
    const base = layoutContextGraph(nodes, edges, 960, 720);

    expect(layoutCodeSatellites(["symbol-a"], undefined, base, 960, 720).size).toBe(0);
    expect(layoutCodeSatellites([], base.get(nodes[0]!.id), base, 960, 720).size).toBe(0);
  });
});

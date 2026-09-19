/**
 * The code→knowledge join.
 *
 * Two things are being defended. The ordering, which is the product claim —
 * ask about a function, get the decisions that govern *it*, most-relevant
 * first, deterministically. And the boundary: no graph score reaches this
 * ordering, and no wiki score reaches the graph's.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { openWikiIndex } from "../../index/open.js";
import { entitiesGroundedIn } from "../get.js";
import { compareGroundedEntities, type GroundedEntity } from "../for-code.js";
import { MAX_RESULT_LIMIT } from "../budget.js";
import { createScaffold, steppingClock, type Scaffold } from "../../index/__tests__/harness.js";
import { isEntityId } from "../../model/ids.js";
import type { EntitySummary } from "../rank.js";

const IDS = {
  rotate: "mx_01KR2E4K002H3ZYA9G0C4XV531",
  cache: "mx_01KRMEXM00JAAVJPQVVRX8N56V",
  naming: "mx_01KS6FPN00RT04JXY9QEG0JN19",
  retired: "mx_01KSRGFP00P5TVKWJ2P5Z9DFJV",
  moved: "mx_01KTAH8Q004DSGTECA5MBCRZ88",
  ungrounded: "mx_01KTWJ1R00FFGFA48FZBYSZ90D",
} as const;

const NODE_A = "function:1a2b3c4d5e6f7a8b";
const NODE_B = "function:2b3c4d5e6f7a8b9c";
const NODE_C = "function:3c4d5e6f7a8b9c0d";
const NODE_ELSEWHERE = "function:9999999999999999";
const NODE_OLD = "function:0000111122223333";
const FINGERPRINT = "mh:64:0a0b0c0d";

interface Spec {
  id: string;
  title: string;
  status?: string;
  nodes?: string[];
}

function entity(spec: Spec): string {
  const grounds =
    spec.nodes === undefined || spec.nodes.length === 0
      ? ""
      : `grounds_to:\n${spec.nodes.map((node) => `  - node: ${node}\n    fingerprint: ${FINGERPRINT}\n`).join("")}`;
  return (
    `<!-- mex:entity\nid: ${spec.id}\ntype: decision\nstatus: ${spec.status ?? "promoted"}\nrevision: 1\n${grounds}-->\n` +
    `## ${spec.title}\n\nProse for ${spec.title}.\n\n`
  );
}

function file(specs: readonly Spec[]): string {
  return `---\nname: generated\n---\n\n# Generated\n\nIntro.\n\n${specs.map(entity).join("")}`;
}

let scaffold: Scaffold;
let indexPath: string;

beforeAll(() => {
  scaffold = createScaffold();
  indexPath = join(scaffold.root, "wiki.db");

  scaffold.write("notes/a.md", file([
    // Grounded to two of the three queried nodes: the highest overlap.
    { id: IDS.rotate, title: "Rotate refresh tokens", nodes: [NODE_A, NODE_B] },
    // One node, promoted.
    { id: IDS.cache, title: "Cache eviction", nodes: [NODE_A] },
  ]));
  scaffold.write("notes/b.md", file([
    // One node, in_flight — loses to `cache` on lifecycle despite equal overlap.
    { id: IDS.naming, title: "Aaa naming convention", status: "in_flight", nodes: [NODE_A] },
    // Archived: excluded by default, like every other list.
    { id: IDS.retired, title: "Retired decision", status: "archived", nodes: [NODE_A] },
  ]));
  scaffold.write("notes/c.md", file([
    // Declares an old node id; reconciliation rebound it to NODE_C.
    { id: IDS.moved, title: "Moved symbol decision", nodes: [NODE_OLD] },
    // No grounding at all: must never appear.
    { id: IDS.ungrounded, title: "Ungrounded decision" },
  ]));

  rebuildWikiIndex({
    scaffoldRoot: scaffold.root,
    indexPath,
    now: steppingClock(),
    resolveGrounding: (grounding) => {
      if (grounding.node === NODE_OLD) {
        return { state: "fresh", health: "fresh", node: NODE_OLD, resolvedNode: NODE_C, rebound: true, bodyHash: "live" };
      }
      if (grounding.node === NODE_B) {
        return { state: "stale", health: "changed", node: NODE_B, resolvedNode: NODE_B, currentBodyHash: "live" };
      }
      return { state: "fresh", health: "fresh", node: grounding.node, resolvedNode: grounding.node, rebound: false, bodyHash: "live" };
    },
  });
});

afterAll(() => {
  scaffold.dispose();
});

function forCode(nodeIds: readonly string[], options = {}): GroundedEntity[] {
  const result = entitiesGroundedIn(indexPath, nodeIds, options);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value.items;
}

describe("entitiesGroundedIn", () => {
  it("indexes the fixtures it claims to", () => {
    // Vacuity guard. Every assertion below is over a list, and an empty index
    // would satisfy several of them.
    for (const id of Object.values(IDS)) expect(isEntityId(id), `${id} is not an id`).toBe(true);
    const opened = openWikiIndex(indexPath);
    if (!opened.ok) throw new Error(opened.diagnostic.message);
    try {
      const counts = opened.index.db.prepare(`SELECT COUNT(*) AS n FROM wiki_groundings`).get() as { n: number };
      // rotate(2) + cache(1) + naming(1) + retired(1) + moved(1).
      expect(Number(counts.n)).toBe(6);
    } finally {
      opened.index.close();
    }
  });

  it("returns the entities grounded to a node, and nothing else", () => {
    const ids = forCode([NODE_A]).map((item) => item.entity.id);
    expect(ids).toContain(IDS.rotate);
    expect(ids).toContain(IDS.cache);
    // Never an entity that declares no grounding — there is no join row for it,
    // and inventing one would make "grounded in" mean "mentions".
    expect(ids).not.toContain(IDS.ungrounded);
  });

  it("orders by overlap count first", () => {
    // `rotate` grounds to two of the queried nodes, `cache` and `naming` to
    // one. Overlap is the graph's only contribution to this ordering, and it is
    // a count rather than a score.
    const items = forCode([NODE_A, NODE_B]);
    expect(items[0]!.entity.id).toBe(IDS.rotate);
    expect(items[0]!.matchedNodes).toEqual([NODE_A, NODE_B]);
    expect(items.slice(1).every((item) => item.matchedNodes.length === 1)).toBe(true);
  });

  it("then by lifecycle, then health, then title", () => {
    const items = forCode([NODE_A]);
    // `cache` (promoted) before `naming` (in_flight), even though "Aaa naming
    // convention" sorts first alphabetically — lifecycle outranks title.
    const ids = items.map((item) => item.entity.id);
    expect(ids.indexOf(IDS.cache)).toBeLessThan(ids.indexOf(IDS.naming));
  });

  it("counts a node once however many times it is asked for", () => {
    // A caller assembling a scope will hand over duplicates. If they counted
    // twice, repeating an argument would silently reorder the results.
    expect(forCode([NODE_A, NODE_A, NODE_A]).map((item) => item.entity.id))
      .toEqual(forCode([NODE_A]).map((item) => item.entity.id));
  });

  it("excludes archived entities by default and includes them on request", () => {
    expect(forCode([NODE_A]).map((item) => item.entity.id)).not.toContain(IDS.retired);
    expect(forCode([NODE_A], { includeArchived: true }).map((item) => item.entity.id)).toContain(IDS.retired);
  });

  it("finds an entity through the node reconciliation rebound it to", () => {
    // The entity's Markdown still names the old node. Without matching on
    // `resolved_node`, every entity whose symbol had been renamed would drop
    // out of code-driven retrieval — exactly when its knowledge matters most.
    const items = forCode([NODE_C]);
    expect(items.map((item) => item.entity.id)).toEqual([IDS.moved]);
    expect(items[0]!.reboundNodes).toEqual([NODE_C]);
    // And still findable by what it actually declares.
    expect(forCode([NODE_OLD]).map((item) => item.entity.id)).toEqual([IDS.moved]);
  });

  it("carries health through, so a stale entity is ranked down and never hidden", () => {
    const items = forCode([NODE_B]);
    expect(items.map((item) => item.entity.id)).toEqual([IDS.rotate]);
    // `rotate` grounds to NODE_A (fresh) and NODE_B (changed). Worst wins.
    expect(items[0]!.entity.health).toBe("changed");
  });

  it("returns nothing for an unknown node, rather than everything", () => {
    expect(forCode([NODE_ELSEWHERE])).toEqual([]);
    expect(forCode([])).toEqual([]);
    expect(forCode([""])).toEqual([]);
  });

  it("is bounded, and says when it truncated", () => {
    const result = entitiesGroundedIn(indexPath, [NODE_A], { limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.truncated).toBe(true);
    // The clamp has no "all" case: asking for more than the ceiling gets the
    // ceiling, not everything.
    const huge = entitiesGroundedIn(indexPath, [NODE_A], { limit: MAX_RESULT_LIMIT * 100 });
    expect(huge.ok && huge.value.items.length).toBeLessThanOrEqual(MAX_RESULT_LIMIT);
  });

  it("is deterministic across repeated queries", () => {
    const once = forCode([NODE_A, NODE_B, NODE_C]).map((item) => item.entity.id);
    const twice = forCode([NODE_A, NODE_B, NODE_C]).map((item) => item.entity.id);
    expect(once).toEqual(twice);
    // Total order: no two results tie all the way down to insertion order.
    expect(new Set(once).size).toBe(once.length);
  });
});

describe("HARD: no score crosses the CG/KG boundary", () => {
  it("orders from wiki facts and an overlap count, and nothing else", () => {
    // The comparator is pure and takes no graph rank, so this is checkable
    // directly rather than by inspecting the SQL. Two entities identical in
    // every wiki respect and in overlap compare equal — there is no hidden
    // relevance term to break the tie.
    const base: EntitySummary = {
      id: "mx_01KR2E4K002H3ZYA9G0C4XV531",
      type: "decision",
      title: "Same title",
      summary: null,
      status: "promoted",
      file: "a.md",
      revision: 1,
      startLine: 1,
      endLine: 2,
      health: "fresh",
    };
    const left: GroundedEntity = { entity: base, matchedNodes: [NODE_A], reboundNodes: [] };
    const right: GroundedEntity = { entity: { ...base }, matchedNodes: [NODE_B], reboundNodes: [] };
    expect(compareGroundedEntities(left, right)).toBe(0);

    // Overlap dominates everything below it, including lifecycle.
    const archivedButBroader: GroundedEntity = {
      entity: { ...base, id: "mx_01KRMEXM00JAAVJPQVVRX8N56V", status: "archived" },
      matchedNodes: [NODE_A, NODE_B],
      reboundNodes: [],
    };
    expect(compareGroundedEntities(archivedButBroader, left)).toBeLessThan(0);
  });
});

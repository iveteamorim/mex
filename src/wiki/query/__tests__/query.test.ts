/**
 * §10.4's ordering rules — each one, with a test that fails if it is dropped.
 *
 * Ordering is where a retrieval system rots quietly: nothing throws, results
 * still arrive, and the right answer is merely second. Two of the rules below
 * are about what must *not* happen, and those are the ones written most
 * carefully — a stale entity must not disappear, and no query may load the
 * whole wiki.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { openWikiIndex } from "../../index/open.js";
import { getEntity, listEntities, relatedEntities, searchEntities } from "../get.js";
import { openWikiQuery, toMatchExpression, type WikiQuerySession } from "../session.js";
import {
  compareEdges,
  compareHits,
  healthRank,
  isVisible,
  MATCH_FIELD_RANK,
  type EntitySummary,
  type RelationEdge,
} from "../rank.js";
import {
  DEFAULT_NEIGHBORHOOD_TOKENS,
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_TRAVERSAL_DEPTH,
  resolveBounds,
} from "../budget.js";
import { createScaffold, steppingClock, type Scaffold } from "../../index/__tests__/harness.js";

const IDS = {
  topic: "mx_01KR2E4K002H3ZYA9G0C4XV531",
  promoted: "mx_01KRMEXM00JAAVJPQVVRX8N56V",
  inFlight: "mx_01KS6FPN00RT04JXY9QEG0JN19",
  deprecated: "mx_01KSRGFP00P5TVKWJ2P5Z9DFJV",
  archived: "mx_01KTAH8Q004DSGTECA5MBCRZ88",
  stale: "mx_01KTWJ1R00FFGFA48FZBYSZ90D",
  hub: "mx_01KVEJTS0033N8ZWSQZXJNG34H",
  leaf: "mx_01KW0KKT00Q5R49QMFGW64X5T6",
} as const;

function block(options: {
  id: string;
  title: string;
  type?: string;
  status?: string;
  summary?: string;
  body?: string;
  relations?: { type: string; target: string }[];
  groundsTo?: { node: string; fingerprint: string }[];
}): string {
  const lines = [
    "<!-- mex:entity",
    `id: ${options.id}`,
    `type: ${options.type ?? "decision"}`,
    `status: ${options.status ?? "promoted"}`,
    "revision: 1",
    `topics: [${IDS.topic}]`,
  ];
  if (options.summary !== undefined) lines.push(`summary: ${JSON.stringify(options.summary)}`);
  if (options.relations !== undefined) {
    lines.push("relations:");
    for (const relation of options.relations) lines.push(`  - type: ${relation.type}\n    target: ${relation.target}`);
  }
  if (options.groundsTo !== undefined) {
    lines.push("grounds_to:");
    for (const grounding of options.groundsTo) {
      lines.push(`  - node: "${grounding.node}"\n    fingerprint: "${grounding.fingerprint}"`);
    }
  }
  lines.push("-->");
  return `${lines.join("\n")}\n## ${options.title}\n\n${options.body ?? "Body prose."}\n\n`;
}

let scaffold: Scaffold;
let indexPath: string;

beforeAll(() => {
  scaffold = createScaffold();
  indexPath = join(scaffold.root, "wiki.db");

  scaffold.write(
    "topics/auth.md",
    `---\nname: auth\nmex:\n  id: ${IDS.topic}\n  type: topic\n  status: promoted\n  revision: 1\n  metadata:\n    aliases: [authn, signin]\n---\n\n# Authentication\n\nProving who a caller is.\n`,
  );

  scaffold.write(
    "notes/lifecycle.md",
    block({ id: IDS.promoted, title: "Rotate refresh tokens", status: "promoted", summary: "Rotation policy." }) +
      block({ id: IDS.inFlight, title: "Rotate session cookies", status: "in_flight" }) +
      block({ id: IDS.deprecated, title: "Rotate api keys", status: "deprecated" }) +
      block({ id: IDS.archived, title: "Rotate passwords", status: "archived" }),
  );

  scaffold.write(
    "notes/fields.md",
    // One distinctive term per field, so the precedence rule can be asserted
    // without any of the three hits also matching another field.
    block({ id: IDS.stale, title: "Zephyrterm in the title", summary: "Nothing else here.", body: "Nothing else here." }) +
      block({
        id: IDS.hub,
        title: "A hub",
        summary: "Zephyrterm in the summary.",
        body: "Ordinary prose.",
        relations: [
          { type: "depends_on", target: IDS.leaf },
          { type: "affects", target: IDS.promoted },
        ],
      }) +
      block({ id: IDS.leaf, title: "A leaf", body: "Zephyrterm in the body, and nowhere else." }),
  );

  rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });

  // P3 stores grounding and resolves nothing — health arrives with P4. The
  // ranking rule is still P3's, so the column is populated here directly to
  // exercise it. Writing it in the test rather than in the indexer is the
  // honest arrangement: it is P4's data, and this is P3's rule.
  const opened = openWikiIndex(indexPath, { readOnly: false });
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  opened.index.db
    .prepare(
      `INSERT INTO wiki_groundings (entity_key, ordinal, node_id, fingerprint, health)
       SELECT entity_key, 0, 'function:deadbeefdeadbeef', 'mh:64:aabb', 'missing' FROM wiki_entities WHERE id = ?`,
    )
    .run(IDS.stale);
  opened.index.close();
});

afterAll(() => {
  scaffold.dispose();
});

function session<T>(body: (session: WikiQuerySession) => T): T {
  const opened = openWikiQuery(indexPath);
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try {
    return body(opened.value);
  } finally {
    opened.value.close();
  }
}

describe("get", () => {
  it("returns an entity with its location and lifecycle", () => {
    const result = getEntity(indexPath, IDS.promoted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("Rotate refresh tokens");
    expect(result.value.status).toBe("promoted");
    expect(result.value.file).toBe("notes/lifecycle.md");
    expect(result.value.startLine).toBeGreaterThan(0);
  });

  it("reports a missing entity as a typed diagnostic, not an exception", () => {
    const result = getEntity(indexPath, "mx_01KY8PQY00F4MT10396E7B21R7");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("ENTITY_NOT_FOUND");
  });

  it("reports a missing index without creating one", () => {
    const result = getEntity(join(scaffold.root, "absent.db"), IDS.promoted);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("WIKI_INDEX_MISSING");
  });
});

describe("lifecycle visibility (§10.4)", () => {
  it("excludes archived entities by default", () => {
    const titles = session((query) => query.list().items.map((entity) => entity.title));
    expect(titles).toContain("Rotate refresh tokens");
    expect(titles).not.toContain("Rotate passwords");
    // Non-vacuity: the archived entity really is in the index.
    expect(getEntity(indexPath, IDS.archived).ok).toBe(true);
  });

  it("includes archived entities when asked", () => {
    const titles = session((query) => query.list({ includeArchived: true }).items.map((entity) => entity.title));
    expect(titles).toContain("Rotate passwords");
  });

  it("shows in_flight by default and hides it only when the caller says so", () => {
    expect(session((query) => query.list().items.map((entity) => entity.id))).toContain(IDS.inFlight);
    expect(session((query) => query.list({ includeInFlight: false }).items.map((entity) => entity.id))).not.toContain(
      IDS.inFlight,
    );
    // A review surface asks for them explicitly and gets them regardless.
    expect(session((query) => query.list({ statuses: ["in_flight"] }).items.map((entity) => entity.id))).toEqual([
      IDS.inFlight,
    ]);
  });

  it("prefers promoted over in_flight over deprecated when ranking", () => {
    const ordered = session((query) => query.search("Rotate", { limit: 10 }).items.map((hit) => hit.entity.status));
    const ranks = ordered.map((status) => ["promoted", "in_flight", "deprecated"].indexOf(status));
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(ordered).not.toContain("archived");
  });
});

describe("search precedence (§10.4)", () => {
  it("puts an exact id ahead of everything lexical", () => {
    const items = session((query) => query.search(IDS.leaf, { limit: 10 }).items);
    expect(items[0]?.entity.id).toBe(IDS.leaf);
    expect(items[0]?.field).toBe("id");
  });

  it("ranks title above summary above body", () => {
    const items = session((query) => query.search("Zephyrterm", { limit: 10 }).items);
    expect(items.map((hit) => hit.field)).toEqual(["title", "summary", "body"]);
    expect(items.map((hit) => hit.entity.id)).toEqual([IDS.stale, IDS.hub, IDS.leaf]);
  });

  it("finds a topic by an alias, which is indexed but is not the title", () => {
    const items = session((query) => query.search("authn", { limit: 10 }).items);
    expect(items.map((hit) => hit.entity.id)).toContain(IDS.topic);
  });

  it("treats a query with FTS syntax in it as text", () => {
    // Unescaped, `NEAR(` and an unbalanced quote are a syntax error at best and
    // somebody else's query at worst.
    expect(() => session((query) => query.search('NEAR("rotate', { limit: 5 }))).not.toThrow();
    expect(toMatchExpression("rotate tokens")).toBe('"rotate" AND "tokens"');
    expect(toMatchExpression("   ")).toBeNull();
  });
});

describe("stale health lowers rank but never hides (§10.4)", () => {
  it("keeps a missing-health entity in the results", () => {
    const ids = session((query) => query.list({ limit: 100 }).items.map((entity) => entity.id));
    expect(ids).toContain(IDS.stale);

    const summary = session((query) => query.get(IDS.stale));
    expect(summary.ok).toBe(true);
    if (summary.ok) expect(summary.value.health).toBe("missing");
  });

  it("summarizes an entity by its worst health, using the model's precedence", () => {
    // Two groundings on one entity: one `changed`, one `ambiguous`. The model
    // calls ambiguous worse; the ranking's HEALTH_RANK penalizes changed more.
    // Aggregation is the model's question — which finding represents this
    // entity — so the answer must be `ambiguous`.
    //
    // The two orders were free to disagree while nothing ever populated the
    // column. P4 populates it, so the disagreement became reachable.
    const opened = openWikiIndex(indexPath, { readOnly: false });
    if (!opened.ok) throw new Error(opened.diagnostic.message);
    opened.index.db
      .prepare(
        `INSERT INTO wiki_groundings (entity_key, ordinal, node_id, fingerprint, health)
         SELECT entity_key, 1, 'function:beefbeefbeefbeef', 'mh:64:ccdd', 'changed' FROM wiki_entities WHERE id = ?`,
      )
      .run(IDS.stale);
    opened.index.db
      .prepare(`UPDATE wiki_groundings SET health = 'ambiguous' WHERE ordinal = 0 AND entity_key IN (SELECT entity_key FROM wiki_entities WHERE id = ?)`)
      .run(IDS.stale);
    opened.index.close();

    try {
      const summary = session((query) => query.get(IDS.stale));
      expect(summary.ok).toBe(true);
      if (summary.ok) expect(summary.value.health).toBe("ambiguous");
    } finally {
      // Restore the fixture for whatever runs next: this suite shares one index.
      const reopened = openWikiIndex(indexPath, { readOnly: false });
      if (!reopened.ok) throw new Error(reopened.diagnostic.message);
      reopened.index.db.prepare(`DELETE FROM wiki_groundings WHERE ordinal = 1`).run();
      reopened.index.db
        .prepare(`UPDATE wiki_groundings SET health = 'missing' WHERE ordinal = 0`)
        .run();
      reopened.index.close();
    }
  });

  it("orders a healthy entity above an unhealthy one, all else equal", () => {
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
    const unhealthy: EntitySummary = { ...base, id: "mx_01KRMEXM00JAAVJPQVVRX8N56V", health: "missing" };
    expect(compareHits({ entity: base, field: "title" }, { entity: unhealthy, field: "title" })).toBeLessThan(0);
    // But a body match on the healthy one still loses to a title match on the
    // unhealthy one: health is a tiebreaker, never a filter and never a trump.
    expect(compareHits({ entity: base, field: "body" }, { entity: unhealthy, field: "title" })).toBeGreaterThan(0);
    expect(healthRank(null)).toBe(healthRank("unverified"));
    expect(isVisible("promoted", {})).toBe(true);
  });
});

describe("relations and traversal (§10.4)", () => {
  it("orders relations and backlinks by (type, target title, id)", () => {
    const result = relatedEntities(indexPath, IDS.hub);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relations.map((edge) => edge.type)).toEqual(["affects", "depends_on"]);
    expect(result.value.relations.map((edge) => edge.target?.title)).toEqual(["Rotate refresh tokens", "A leaf"]);

    const shuffled: RelationEdge[] = [
      { type: "depends_on", targetId: "mx_b", target: null, resolved: false },
      { type: "affects", targetId: "mx_a", target: { ...blankEntity(), title: "Zeta" }, resolved: true },
      { type: "affects", targetId: "mx_c", target: { ...blankEntity(), title: "Alpha" }, resolved: true },
    ];
    expect([...shuffled].sort(compareEdges).map((edge) => edge.targetId)).toEqual(["mx_c", "mx_a", "mx_b"]);
  });

  it("keeps a dangling target visible rather than dropping the edge", () => {
    const dangling: RelationEdge[] = [{ type: "depends_on", targetId: "mx_gone", target: null, resolved: false }];
    expect(dangling.sort(compareEdges)).toHaveLength(1);

    // And in the index: the hub's edges are all resolved, so assert the shape
    // that would carry an unresolved one rather than pretending there is one.
    const result = relatedEntities(indexPath, IDS.hub);
    if (result.ok) {
      expect(result.value.relations.every((edge) => edge.resolved)).toBe(true);
      expect(result.value.relations.every((edge) => edge.target !== null)).toBe(true);
    }
  });

  it("reports backlinks", () => {
    const result = relatedEntities(indexPath, IDS.leaf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.backlinks.map((edge) => edge.targetId)).toContain(IDS.hub);
  });

  it("bounds traversal by depth, count and estimated tokens", () => {
    const deep = relatedEntities(indexPath, IDS.hub, { depth: 2, limit: 50 });
    expect(deep.ok).toBe(true);
    if (!deep.ok) return;
    expect(deep.value.reached.length).toBeGreaterThan(0);
    expect(deep.value.estimatedTokens).toBeGreaterThan(0);

    const shallow = relatedEntities(indexPath, IDS.hub, { depth: 1 });
    if (shallow.ok) expect(shallow.value.reached.length).toBeLessThanOrEqual(deep.value.reached.length);

    const oneNode = relatedEntities(indexPath, IDS.hub, { limit: 1 });
    if (oneNode.ok) {
      expect(oneNode.value.reached).toHaveLength(1);
      expect(oneNode.value.truncated).toBe(true);
    }

    const noTokens = relatedEntities(indexPath, IDS.hub, { maxTokens: 1 });
    if (noTokens.ok) {
      expect(noTokens.value.reached).toEqual([]);
      expect(noTokens.value.truncated).toBe(true);
    }
  });
});

describe("bounds (HARD: no query loads the whole wiki)", () => {
  it("clamps every bound, and has no way to express 'all'", () => {
    expect(resolveBounds().limit).toBe(DEFAULT_RESULT_LIMIT);
    expect(resolveBounds().maxTokens).toBe(DEFAULT_NEIGHBORHOOD_TOKENS);
    expect(resolveBounds({ limit: 10_000 }).limit).toBe(MAX_RESULT_LIMIT);
    expect(resolveBounds({ limit: 0 }).limit).toBe(1);
    expect(resolveBounds({ limit: Number.NaN }).limit).toBe(DEFAULT_RESULT_LIMIT);
    expect(resolveBounds({ depth: 99 }).depth).toBe(MAX_TRAVERSAL_DEPTH);
  });

  it("returns at most the maximum even when the caller asks for more", () => {
    const big = createScaffold();
    try {
      const path = join(big.root, "wiki.db");
      // More entities than the hard maximum, so a missing bound shows up as a
      // longer list rather than as nothing at all.
      const count = MAX_RESULT_LIMIT + 25;
      let text = "";
      for (let index = 0; index < count; index += 1) {
        text += block({ id: syntheticId(index), title: `Entity ${String(index).padStart(4, "0")}` });
      }
      big.write("notes/many.md", text);
      const built = rebuildWikiIndex({ scaffoldRoot: big.root, indexPath: path, now: steppingClock() });
      expect(built.entityCount).toBe(count);

      const listed = listEntities(path, { limit: 10_000 });
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value.items.length).toBeLessThanOrEqual(MAX_RESULT_LIMIT);
        expect(listed.value.truncated).toBe(true);
      }

      const found = searchEntities(path, "Entity", { limit: 10_000, maxTokens: Number.MAX_SAFE_INTEGER });
      if (found.ok) expect(found.value.items.length).toBeLessThanOrEqual(MAX_RESULT_LIMIT);
    } finally {
      big.dispose();
    }
  });

  it("has a LIMIT on every statement that reads entities", () => {
    // The invariant is "there must be no code path that can", so it is checked
    // over the source rather than only over the behaviour of the paths someone
    // thought to test.
    const directory = resolve(__dirname, "..");
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(directory, name), "utf-8");
      // Template literals only, so the scan reads SQL rather than the code
      // between two of them.
      for (const literal of source.split("`").filter((_, index) => index % 2 === 1)) {
        if (!/FROM\s+wiki_/.test(literal)) continue;
        scanned += 1;
        // `SELECT 1 ... ` is an existence check inside an EXISTS clause, which
        // stops at the first row by definition.
        if (/^\s*SELECT\s+1\s/.test(literal)) continue;
        if (!/\bLIMIT\b/.test(literal)) offenders.push(`${name}: ${literal.slice(0, 90).replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
    // The scan has to have found statements, or it proves nothing.
    expect(scanned).toBeGreaterThan(5);
  });
});

describe("match field ranks", () => {
  it("fixes the order the spec states", () => {
    expect(MATCH_FIELD_RANK.id).toBeLessThan(MATCH_FIELD_RANK.title);
    expect(MATCH_FIELD_RANK.title).toBeLessThan(MATCH_FIELD_RANK.summary);
    expect(MATCH_FIELD_RANK.summary).toBeLessThan(MATCH_FIELD_RANK.body);
  });
});

function blankEntity(): EntitySummary {
  return {
    id: "mx_01KR2E4K002H3ZYA9G0C4XV531",
    type: "decision",
    title: "",
    summary: null,
    status: "promoted",
    file: "a.md",
    revision: 1,
    startLine: 1,
    endLine: 1,
    health: null,
  };
}

/** A valid, distinct entity id per index. Crockford Base32, 26 characters. */
function syntheticId(index: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let suffix = "";
  let remaining = index;
  for (let position = 0; position < 6; position += 1) {
    suffix = alphabet[remaining % 32]! + suffix;
    remaining = Math.floor(remaining / 32);
  }
  return `mx_01KR2E4K002H3ZYA9G0C${suffix}`;
}

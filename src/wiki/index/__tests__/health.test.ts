/**
 * Grounding health in the index: where it is computed, and what it does to the
 * oracle.
 *
 * Health is the first derived column whose input lives **outside the scaffold**.
 * Everything before it — shadowing, target resolution, every set-level
 * diagnostic — is a function of the Markdown alone, so a rebuild and a refresh
 * of the same tree could not disagree without one of them being wrong. Health
 * is a function of the Markdown *and the code graph*, and the code graph moves
 * on its own.
 *
 * The decision, stated rather than discovered: health is recomputed for every
 * grounding row on every build, from a resolver the caller passes in, and both
 * paths take the same parameter. It is **not** excluded from the normalized
 * dump. Excluding it would put this phase's own new state outside the oracle,
 * which is what the exclusion list exists to prevent rather than to permit; and
 * the exclusions are meant to be things that cannot be compared, not things
 * that are inconvenient to arrange. Two indexes built against the same graph
 * state agree, and that is what these tests assert.
 */

import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { openWikiIndex } from "../open.js";
import { dumpWikiIndex } from "../dump.js";
import { rebuildWikiIndex } from "../rebuild.js";
import { refreshWikiIndex } from "../refresh.js";
import type { GroundingResolver } from "../write.js";
import { createScaffold, steppingClock, type Scaffold } from "./harness.js";
import type { GroundingResolution, WikiGrounding } from "../../model/grounding.js";

const ENTITY_A = "mx_01KR2E4K002H3ZYA9G0C4XV531";
const ENTITY_B = "mx_01KRMEXM00JAAVJPQVVRX8N56V";
const ENTITY_C = "mx_01KS6FPN00RT04JXY9QEG0JN19";

const NODE_FRESH = "function:1a2b3c4d5e6f7a8b";
const NODE_STALE = "function:2b3c4d5e6f7a8b9c";
const NODE_GONE = "function:3c4d5e6f7a8b9c0d";
const NODE_MOVED_TO = "function:4d5e6f7a8b9c0d1e";
const FINGERPRINT = "mh:64:0a0b0c0d";

function grounded(id: string, node: string, extra = ""): string {
  return (
    `<!-- mex:entity\nid: ${id}\ntype: decision\nstatus: promoted\nrevision: 1\n` +
    `grounds_to:\n  - node: ${node}\n    fingerprint: ${FINGERPRINT}\n    bodyHash: committed-${node}\n${extra}-->\n` +
    `## Decision ${id.slice(-4)}\n\nProse about ${node}.\n\n`
  );
}

function file(body: string): string {
  return `---\nname: generated\n---\n\n# Generated\n\nIntro.\n\n${body}`;
}

/**
 * A resolver that is a pure function of the node id.
 *
 * A stub, and deliberately so: this file is testing where health is written and
 * whether two build paths agree, not what the verdicts mean. The verdicts have
 * their own tests against a stub graph, and against a real one in
 * `grounding/__tests__/integration.test.ts`.
 */
function fixedResolver(): GroundingResolver {
  return (grounding: WikiGrounding): GroundingResolution => {
    if (grounding.node === NODE_FRESH) {
      return { state: "fresh", health: "fresh", node: grounding.node, resolvedNode: grounding.node, rebound: false, bodyHash: "live" };
    }
    if (grounding.node === NODE_STALE) {
      return { state: "stale", health: "changed", node: grounding.node, resolvedNode: grounding.node, currentBodyHash: "live" };
    }
    if (grounding.node === NODE_MOVED_TO) {
      return { state: "fresh", health: "fresh", node: grounding.node, resolvedNode: NODE_MOVED_TO, rebound: true, bodyHash: "live" };
    }
    return { state: "missing", health: "missing", node: grounding.node, reason: "gone" };
  };
}

function readDump(indexPath: string): string {
  const opened = openWikiIndex(indexPath);
  if (!opened.ok) throw new Error(`index would not open: ${opened.diagnostic.message}`);
  try {
    return dumpWikiIndex(opened.index.db);
  } finally {
    opened.index.close();
  }
}

function groundingRows(indexPath: string): Array<Record<string, unknown>> {
  const opened = openWikiIndex(indexPath);
  if (!opened.ok) throw new Error("index would not open");
  try {
    return opened.index.db
      .prepare(
        `SELECT g.node_id, g.body_hash, g.state, g.resolved_node, g.health, e.id AS entity_id
           FROM wiki_groundings g JOIN wiki_entities e ON e.entity_key = g.entity_key
          ORDER BY e.id, g.ordinal`,
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    opened.index.close();
  }
}

function diagnosticCodes(indexPath: string): string[] {
  const opened = openWikiIndex(indexPath);
  if (!opened.ok) throw new Error("index would not open");
  try {
    return (opened.index.db.prepare(`SELECT code FROM wiki_diagnostics ORDER BY code`).all() as { code: string }[])
      .map((row) => row.code);
  } finally {
    opened.index.close();
  }
}

describe("grounding health in the index", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  function threeEntities(): { root: string; indexPath: string } {
    scaffold = createScaffold();
    scaffold.write("notes/a.md", file(grounded(ENTITY_A, NODE_FRESH)));
    scaffold.write("notes/b.md", file(grounded(ENTITY_B, NODE_STALE)));
    scaffold.write("notes/c.md", file(grounded(ENTITY_C, NODE_GONE)));
    return { root: scaffold.root, indexPath: join(scaffold.root, "wiki.db") };
  }

  it("commits the body hash from Markdown and leaves every verdict NULL with no resolver", () => {
    const { root, indexPath } = threeEntities();
    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock() });

    const rows = groundingRows(indexPath);
    expect(rows).toHaveLength(3);
    // The committed reference is stored whether or not anything resolved it —
    // it is what Markdown said, and Markdown is canonical.
    expect(rows.map((row) => row.body_hash)).toEqual([
      `committed-${NODE_FRESH}`, `committed-${NODE_STALE}`, `committed-${NODE_GONE}`,
    ]);
    // NULL, not 'unverified'. Nothing looked, so there is no verdict to record,
    // and a verdict-shaped value would read as one that had been reached.
    for (const row of rows) {
      expect(row.state).toBeNull();
      expect(row.resolved_node).toBeNull();
      expect(row.health).toBeNull();
    }
    expect(diagnosticCodes(indexPath)).toEqual([]);
  });

  it("records the verdict and the resolved node when a resolver is supplied", () => {
    const { root, indexPath } = threeEntities();
    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock(), resolveGrounding: fixedResolver() });

    expect(groundingRows(indexPath)).toEqual([
      { entity_id: ENTITY_A, node_id: NODE_FRESH, body_hash: `committed-${NODE_FRESH}`, state: "fresh", resolved_node: NODE_FRESH, health: "fresh" },
      { entity_id: ENTITY_B, node_id: NODE_STALE, body_hash: `committed-${NODE_STALE}`, state: "stale", resolved_node: NODE_STALE, health: "changed" },
      { entity_id: ENTITY_C, node_id: NODE_GONE, body_hash: `committed-${NODE_GONE}`, state: "missing", resolved_node: null, health: "missing" },
    ]);
  });

  it("emits the three P4 codes, as warnings that say which entity and which grounding", () => {
    const { root, indexPath } = threeEntities();
    scaffold!.write("notes/d.md", file(grounded("mx_01KSRGFP00P5TVKWJ2P5Z9DFJV", "function:aaaaaaaaaaaaaaaa")));
    rebuildWikiIndex({
      scaffoldRoot: root,
      indexPath,
      now: steppingClock(),
      resolveGrounding: (grounding) =>
        grounding.node === "function:aaaaaaaaaaaaaaaa"
          ? { state: "unresolved", health: "unverified", node: grounding.node, reason: "no graph" }
          : fixedResolver()(grounding),
    });

    expect(diagnosticCodes(indexPath)).toEqual(["GROUNDING_MISSING", "GROUNDING_STALE", "GROUNDING_UNRESOLVED"]);

    const opened = openWikiIndex(indexPath);
    if (!opened.ok) throw new Error("index would not open");
    try {
      const stale = opened.index.db
        .prepare(`SELECT severity, entity_id, file, path FROM wiki_diagnostics WHERE code = 'GROUNDING_STALE'`)
        .get() as Record<string, unknown>;
      expect(stale).toEqual({ severity: "warning", entity_id: ENTITY_B, file: "notes/b.md", path: "groundsTo[0]" });
    } finally {
      opened.index.close();
    }
  });

  it("says nothing about a fresh grounding", () => {
    scaffold = createScaffold();
    scaffold.write("notes/a.md", file(grounded(ENTITY_A, NODE_FRESH)));
    const indexPath = join(scaffold.root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock(), resolveGrounding: fixedResolver() });
    expect(diagnosticCodes(indexPath)).toEqual([]);
  });

  it("never lets local health touch canonical lifecycle", () => {
    // §5.7 and §2.2. A stale grounding is branch-local; the same entity is
    // fresh on the branch where nobody edited the code. If drift could rewrite
    // status, a rebase would change what a team had decided.
    const { root, indexPath } = threeEntities();
    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock(), resolveGrounding: fixedResolver() });

    const opened = openWikiIndex(indexPath);
    if (!opened.ok) throw new Error("index would not open");
    try {
      const statuses = opened.index.db
        .prepare(`SELECT id, status FROM wiki_entities ORDER BY id`)
        .all() as Array<{ id: string; status: string }>;
      expect(statuses.every((row) => row.status === "promoted")).toBe(true);
    } finally {
      opened.index.close();
    }
  });
});

describe("health and the determinism oracle", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("keeps refresh and rebuild byte-identical when both see the same graph", () => {
    // The property that lets health stay *inside* the dump: given the same
    // resolver, the two paths agree, because both recompute every row rather
    // than only the ones they parsed.
    scaffold = createScaffold();
    const root = scaffold.root;
    const incremental = join(root, "wiki.db");
    const clean = join(root, "clean.db");

    scaffold.write("notes/a.md", file(grounded(ENTITY_A, NODE_FRESH)));
    scaffold.write("notes/b.md", file(grounded(ENTITY_B, NODE_STALE)));

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: incremental, now: steppingClock(), resolveGrounding: fixedResolver() });

    // Touch only a.md. b.md is never reparsed, and its health must still be
    // recomputed — the file whose entity went stale is the file nobody touched.
    scaffold.write("notes/a.md", file(grounded(ENTITY_A, NODE_FRESH, "reason: still true\n")));
    const refreshed = refreshWikiIndex({
      scaffoldRoot: root,
      indexPath: incremental,
      changed: ["notes/a.md"],
      now: steppingClock(Date.UTC(2028, 0, 1)),
      resolveGrounding: fixedResolver(),
    });
    expect(refreshed.ok).toBe(true);

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: clean, now: steppingClock(Date.UTC(2029, 0, 1)), resolveGrounding: fixedResolver() });

    expect(readDump(incremental)).toBe(readDump(clean));
    // Non-vacuity: two indexes that resolved nothing would also compare equal.
    expect(readDump(clean)).toContain('"changed"');
    expect(readDump(clean)).toContain('"fresh"');
  });

  it("recomputes an untouched file's health when the graph moves under it", () => {
    // The case a per-file projection gets wrong and a refresh cannot see: the
    // Markdown did not change at all, and the verdict did.
    scaffold = createScaffold();
    const root = scaffold.root;
    const indexPath = join(root, "wiki.db");
    scaffold.write("notes/a.md", file(grounded(ENTITY_A, NODE_FRESH)));
    scaffold.write("notes/b.md", file(grounded(ENTITY_B, NODE_FRESH)));

    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock(), resolveGrounding: fixedResolver() });
    expect(groundingRows(indexPath).map((row) => row.health)).toEqual(["fresh", "fresh"]);

    // The code changed; no Markdown did. A refresh of one unrelated file must
    // still bring both rows up to date.
    const nowStale: GroundingResolver = (grounding) => ({
      state: "stale", health: "changed", node: grounding.node, resolvedNode: grounding.node, currentBodyHash: "live-2",
    });
    refreshWikiIndex({
      scaffoldRoot: root,
      indexPath,
      changed: ["notes/a.md"],
      now: steppingClock(Date.UTC(2028, 0, 1)),
      resolveGrounding: nowStale,
    });

    expect(groundingRows(indexPath).map((row) => row.health)).toEqual(["changed", "changed"]);
    expect(diagnosticCodes(indexPath)).toEqual(["GROUNDING_STALE", "GROUNDING_STALE"]);
  });

  it("clears every verdict when a later build has no graph", () => {
    // Dropping to no-graph must not leave yesterday's verdicts behind looking
    // current. It is also what keeps a no-resolver refresh equal to a
    // no-resolver rebuild.
    scaffold = createScaffold();
    const root = scaffold.root;
    const indexPath = join(root, "wiki.db");
    const clean = join(root, "clean.db");
    scaffold.write("notes/a.md", file(grounded(ENTITY_A, NODE_STALE)));

    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock(), resolveGrounding: fixedResolver() });
    expect(groundingRows(indexPath)[0]!.health).toBe("changed");

    refreshWikiIndex({ scaffoldRoot: root, indexPath, changed: [], now: steppingClock(Date.UTC(2028, 0, 1)) });
    expect(groundingRows(indexPath)[0]!.health).toBeNull();
    expect(diagnosticCodes(indexPath)).toEqual([]);

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: clean, now: steppingClock(Date.UTC(2029, 0, 1)) });
    expect(readDump(indexPath)).toBe(readDump(clean));
  });

  it("resolves a shadowed duplicate's grounding without reporting it twice", () => {
    // Both claimants of a duplicated id are stored so the duplicate can be
    // reported at all. The loser's grounding still gets a verdict — the row
    // exists and a NULL there would be a lie — but no second warning, which
    // would point at a row no query returns.
    scaffold = createScaffold();
    const root = scaffold.root;
    const indexPath = join(root, "wiki.db");
    scaffold.write("notes/a.md", file(grounded(ENTITY_A, NODE_STALE)));
    scaffold.write("notes/b.md", file(grounded(ENTITY_A, NODE_STALE)));

    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock(), resolveGrounding: fixedResolver() });

    expect(groundingRows(indexPath).map((row) => row.health)).toEqual(["changed", "changed"]);
    const codes = diagnosticCodes(indexPath);
    expect(codes.filter((code) => code === "GROUNDING_STALE")).toHaveLength(1);
    expect(codes).toContain("DUPLICATE_ENTITY_ID");
  });
});

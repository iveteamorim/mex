/**
 * The reverse join: code → knowledge.
 *
 * This is the direction the product's claim actually rests on. An agent asks
 * about a function and gets back the conventions, decisions and patterns
 * attached to *that code* — not documents that happen to share keywords with
 * it. Everything before this phase made the wiki searchable; this makes it
 * reachable from the thing the agent is already looking at.
 *
 * ## HARD: no score crosses the boundary
 *
 * Graph rank and wiki FTS rank are different scales computed over different
 * corpora. A weighted sum of them is a number that means nothing, and worse, it
 * would be a number nobody can debug — a result moves and there is no way to
 * say why. There is deliberately no blending here, and there is no place to add
 * one: the join key is a node id, and the ordering below is made entirely of
 * facts about the wiki entity.
 *
 * The graph's contribution to the ordering is a **count**, not a score: how
 * many of the queried nodes an entity grounds to. That is structural — it says
 * "this entity is about more of what you asked about" — and it is stable
 * against any change to how the graph ranks anything.
 *
 * ## The ordering, per the plan's §5.1
 *
 * 1. grounded-node overlap count, descending
 * 2. lifecycle (`promoted` first)
 * 3. health (`fresh` first, via the shared `healthRank`)
 * 4. title, then id
 *
 * Every tier is content, so two indexes holding the same rows return the same
 * list. Nothing falls through to insertion order.
 */

import { compareGroundingHealth, type GroundingHealth } from "../model/grounding.js";
import { fitWithinBudget, resolveBounds, type BoundsInput } from "./budget.js";
import {
  compareEntities,
  healthRank,
  isVisible,
  LIFECYCLE_RANK,
  type EntitySummary,
  type VisibilityOptions,
} from "./rank.js";
import type { Page } from "./session.js";

/** One entity, plus why it came back. */
export interface GroundedEntity {
  entity: EntitySummary;
  /**
   * The queried nodes this entity grounds to, in the order they were asked
   * for.
   *
   * Returned rather than merely counted so a caller can say *which* part of
   * the scope an entity is about — the difference between "here are some
   * documents" and "this decision governs the function you are editing".
   */
  matchedNodes: string[];
  /** Nodes the entity grounds to that reconciliation rebound. */
  reboundNodes: string[];
}

export interface ForCodeOptions extends VisibilityOptions, BoundsInput {}

interface JoinRow {
  entity_key: string;
  id: string;
  type: string;
  title: string;
  summary: string | null;
  status: string;
  file: string;
  revision: number;
  start_line: number;
  end_line: number;
  node_id: string;
  resolved_node: string | null;
  health: string | null;
}

/**
 * Entities grounded to any of `nodeIds`.
 *
 * Matches on the declared node **and** on the node reconciliation rebound it
 * to. Without the second, every entity whose symbol had moved would drop out of
 * code-driven retrieval the moment someone renamed something — the moment its
 * knowledge is most worth surfacing.
 */
export function queryEntitiesGroundedIn(
  db: {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
  },
  nodeIds: readonly string[],
  options: ForCodeOptions = {},
): Page<GroundedEntity> {
  const bounds = resolveBounds(options);
  // De-duplicated, because a caller assembling a scope will hand us the same
  // node twice and an entity must not count it twice — that would let a
  // repeated argument reorder the results.
  const requested = [...new Set(nodeIds)].filter((id) => id.length > 0);
  if (requested.length === 0) return { items: [], truncated: false };

  const placeholders = requested.map(() => "?").join(", ");
  // Bounded like every other query: the ceiling is per entity-node pair rather
  // than per entity, since one entity can match several of the queried nodes.
  const rowLimit = bounds.limit * bounds.edgeLimit;
  const rows = db
    .prepare(
      `SELECT e.entity_key, e.id, e.type, e.title, e.summary, e.status, e.file, e.revision,
              e.start_line, e.end_line, g.node_id, g.resolved_node, g.health
         FROM wiki_groundings g
         JOIN wiki_entities e ON e.entity_key = g.entity_key
        WHERE e.shadowed = 0
          AND (g.node_id IN (${placeholders}) OR g.resolved_node IN (${placeholders}))
        ORDER BY e.entity_key, g.ordinal
        LIMIT ?`,
    )
    .all(...requested, ...requested, rowLimit) as JoinRow[];

  const order = new Map(requested.map((id, index) => [id, index]));
  const byKey = new Map<string, { row: JoinRow; matched: Set<string>; rebound: Set<string>; health: GroundingHealth | null }>();

  for (const row of rows) {
    const entry = byKey.get(row.entity_key) ?? { row, matched: new Set<string>(), rebound: new Set<string>(), health: null };
    for (const candidate of [row.node_id, row.resolved_node]) {
      if (candidate !== null && order.has(candidate)) entry.matched.add(candidate);
    }
    if (row.resolved_node !== null && row.resolved_node !== row.node_id && order.has(row.resolved_node)) {
      entry.rebound.add(row.resolved_node);
    }
    // Worst health across the entity's groundings, by the model's precedence —
    // the same question `session.decorate` answers, so it gets the same answer.
    const health = row.health as GroundingHealth | null;
    if (health !== null && (entry.health === null || compareGroundingHealth(health, entry.health) < 0)) {
      entry.health = health;
    }
    byKey.set(row.entity_key, entry);
  }

  const candidates: GroundedEntity[] = [];
  for (const entry of byKey.values()) {
    if (!isVisible(entry.row.status, options)) continue;
    candidates.push({
      entity: summaryOf(entry.row, entry.health),
      matchedNodes: [...entry.matched].sort((left, right) => order.get(left)! - order.get(right)!),
      reboundNodes: [...entry.rebound].sort((left, right) => order.get(left)! - order.get(right)!),
    });
  }

  candidates.sort(compareGroundedEntities);
  return fitWithinBudget(candidates, bounds);
}

/**
 * The §5.1 order, as a total one.
 *
 * Overlap first and descending: an entity grounded to three of the five nodes
 * in a scope is more about that scope than one grounded to a single node, and
 * that is a structural fact rather than a relevance guess.
 */
export function compareGroundedEntities(left: GroundedEntity, right: GroundedEntity): number {
  const byOverlap = right.matchedNodes.length - left.matchedNodes.length;
  if (byOverlap !== 0) return byOverlap;

  const byLifecycle = lifecycleOrder(left.entity.status) - lifecycleOrder(right.entity.status);
  if (byLifecycle !== 0) return byLifecycle;

  // The shared ranking order, not a second one invented here.
  const byHealth = healthRank(left.entity.health) - healthRank(right.entity.health);
  if (byHealth !== 0) return byHealth;

  return compareEntities(left.entity, right.entity);
}

function lifecycleOrder(status: string): number {
  // The shared table. A second copy here would be a second lifecycle order,
  // free to drift from the one every other result list is sorted by.
  return LIFECYCLE_RANK[status] ?? LIFECYCLE_RANK["deprecated"]!;
}

function summaryOf(row: JoinRow, health: GroundingHealth | null): EntitySummary {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    status: row.status,
    file: row.file,
    revision: Number(row.revision),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    health,
  };
}

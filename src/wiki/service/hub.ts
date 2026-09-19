/**
 * §17's Hub surfaces — the data half, which is the whole of what §17 asks for.
 *
 * §17 is titled "OSS Hub integration contract" and its obligation is that "the
 * engine must support the data needed for" twelve surfaces. §4 makes the Hub
 * front end an explicit non-goal and §17 itself says the UI "may be delivered
 * separately against those APIs". So there is no page, no server and no
 * endpoint here: there are functions that return enough to build each surface,
 * and a test per surface asserting they do.
 *
 * Ten of the twelve are projections of primitives that already exist — a list
 * with a type filter is the architecture explorer, `wikiGroundingStatus` is the
 * review queue — and those stay where they are rather than being wrapped for
 * the sake of symmetry. This module holds the two §17 surfaces that have no
 * composition behind them:
 *
 *   - **the supersession timeline**, and
 *   - **SDD traceability**, the six-hop chain.
 *
 * plus the evidence and drift panels, which need to reach across into the
 * grounding baseline and so cannot be a query-layer call.
 *
 * ## No Hub-specific storage, asserted rather than promised
 *
 * §21.7's second clause is "no Hub-specific storage model is required". Nothing
 * here writes, nothing here has a table, and every function takes the same
 * `WikiServiceOptions` every other read takes. The Hub's state is the scaffold.
 */

import { compareGroundingHealth, type GroundingHealth } from "../model/grounding.js";
import { detectSupersessionCycles, type RelationSubject } from "../model/relation.js";
import type { EntityId } from "../model/ids.js";
import {
  ACCEPTANCE_CRITERION_RELATION,
  isTestPath,
  SDD_CHAIN,
  TEST_CALL_DEPTH,
  type SddHop,
} from "../model/sdd.js";
import type { SynthesisGraph } from "../grounding/adapter.js";
import type { WikiBaselineStore } from "../grounding/baseline.js";
import type { EntitySummary } from "../query/rank.js";
import { WikiQuerySession } from "../query/session.js";
import { withWikiQuery } from "../query/session.js";
import { indexPathFor, type ServiceResult, type WikiFilterOptions, type WikiServiceOptions } from "./read.js";

/** Run `body` against an open index, or return the typed reason it could not. */
function read<T>(
  options: WikiServiceOptions,
  empty: T,
  body: (session: WikiQuerySession) => ServiceResult<T>,
): ServiceResult<T> {
  const result = withWikiQuery(indexPathFor(options), body);
  if (!result.ok) return { data: empty, diagnostics: [result.diagnostic] };
  return result.value;
}

// -- Supersession timeline ---------------------------------------------------

export interface TimelineEntry {
  entity: EntitySummary;
  /** Position in the chain, 0 for the oldest. */
  ordinal: number;
  /** The entity this one supersedes, or null at the head of the chain. */
  supersedes: string | null;
  /** True for the one entry nothing supersedes — the current version. */
  current: boolean;
}

export interface TimelineData {
  entries: TimelineEntry[];
  /**
   * Ids involved in a `supersedes` cycle, if any.
   *
   * A cycle means no version is current, which makes "what is the current
   * decision" unanswerable. Reported rather than thrown, and reported *with*
   * whatever chain could still be built, because a Hub that showed nothing
   * would be hiding the very thing the user needs to see to fix it.
   */
  cycles: EntityId[][];
  truncated: boolean;
}

/**
 * The chain of supersessions through one entity, oldest first.
 *
 * ## The ordering key, and why it is not time
 *
 * A timeline is an ordering, and three keys were available: the audit log's
 * timestamps, `revision`, or the supersession chain itself. It is **the chain**.
 *
 * Wall-clock time is wrong because the audit log records when an *operation*
 * ran, not when a decision was made — a migration that adopts five years of
 * decisions stamps them all with the same afternoon. `revision` is wrong
 * because it counts edits to one entity and says nothing about the order of two
 * entities. The `supersedes` edges are the only record of what replaced what,
 * they are authored by the person who knew, and they travel in the Markdown.
 *
 * The cost, stated: a chain is only as good as its edges, so a superseding
 * decision that never declared the relation appears as its own one-entry
 * timeline rather than at the head of the real one. That is visible in the
 * `current` flag — two current entries of the same type is the signature — and
 * it is a missing fact rather than a wrong answer.
 */
export function wikiSupersessionTimeline(
  options: WikiServiceOptions & WikiFilterOptions & { id: string },
): ServiceResult<TimelineData> {
  const empty: TimelineData = { entries: [], cycles: [], truncated: false };
  return read<TimelineData>(options, empty, (session) => {
    const origin = session.get(options.id);
    if (!origin.ok) return { data: empty, diagnostics: [origin.diagnostic] };

    // Walk both ways from the origin: forwards through what it supersedes,
    // backwards through what supersedes it. Either direction alone shows half
    // a history to a reader who happened to open the wrong end of it.
    const chain = new Map<string, EntitySummary>([[origin.value.id, origin.value]]);
    const supersedes = new Map<string, string | null>();
    let truncated = false;

    const visitDown = (id: string): void => {
      const related = session.related(id, { depth: 0, includeBacklinks: false });
      if (!related.ok) return;
      if (related.value.truncated) truncated = true;
      const edge = related.value.relations.find((entry) => entry.type === "supersedes");
      supersedes.set(id, edge?.targetId ?? null);
      if (edge === undefined || edge.target === null || chain.has(edge.targetId)) return;
      chain.set(edge.targetId, edge.target);
      visitDown(edge.targetId);
    };

    const visitUp = (id: string): void => {
      const related = session.related(id, { depth: 0, includeBacklinks: true });
      if (!related.ok) return;
      if (related.value.truncated) truncated = true;
      for (const edge of related.value.backlinks) {
        if (edge.type !== "supersedes" || edge.target === null) continue;
        if (chain.has(edge.targetId)) continue;
        chain.set(edge.targetId, edge.target);
        supersedes.set(edge.targetId, id);
        visitUp(edge.targetId);
      }
    };

    visitDown(origin.value.id);
    visitUp(origin.value.id);
    for (const id of [...chain.keys()]) {
      if (!supersedes.has(id)) visitDown(id);
    }

    // Reuse P1's detector rather than re-deriving one. A cycle here would
    // otherwise make the ordering below non-terminating.
    const subjects: RelationSubject[] = [...chain.values()].map((entity) => ({
      id: entity.id as EntityId,
      type: entity.type,
      status: entity.status,
      relations: (() => {
        const target = supersedes.get(entity.id);
        return target === undefined || target === null
          ? []
          : [{ type: "supersedes" as const, target: target as EntityId }];
      })(),
    }));
    const cycles = detectSupersessionCycles(subjects);

    // Order oldest first: the head is whatever nothing in the chain supersedes
    // *from*, walked forward through the superseded-by edges.
    const supersededBy = new Map<string, string>();
    for (const [id, target] of supersedes) {
      if (target !== null && chain.has(target)) supersededBy.set(target, id);
    }
    const oldest = [...chain.keys()].find((id) => {
      const target = supersedes.get(id);
      return target === null || target === undefined || !chain.has(target);
    });

    // No `cycles.length === 0` condition here, and its absence is deliberate.
    // A first draft had one, and re-breaking it turned nothing red: in a cycle
    // every member's supersession target is *inside* the chain, so no head
    // exists, `oldest` is already undefined, and the ordering is already empty.
    // A condition that can never change an outcome is a lie about what protects
    // you — a reader would believe the cycle check is load-bearing and stop
    // looking for what actually is. What actually is: `oldest` for the empty
    // result, and `seen` below for termination. `cycles` is a *report*.
    const entries: TimelineEntry[] = [];
    if (oldest !== undefined) {
      let cursor: string | undefined = oldest;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        const entity = chain.get(cursor)!;
        const next: string | undefined = supersededBy.get(cursor);
        entries.push({
          entity,
          ordinal: entries.length,
          supersedes: supersedes.get(cursor) ?? null,
          current: next === undefined,
        });
        cursor = next;
      }
    }

    return { data: { entries, cycles, truncated }, diagnostics: [] };
  });
}

// -- Entity evidence panel ---------------------------------------------------

export interface EvidenceGrounding {
  nodeId: string;
  health: GroundingHealth | null;
  state: string | null;
}

export interface EvidenceData {
  entity: EntitySummary | null;
  /** §8.6's sources, in declaration order. */
  sources: Array<{ type: string; ref: string | null; note: string | null; capturedAt: string | null }>;
  groundings: EvidenceGrounding[];
  /** Worst health across the groundings, or null when nothing looked. */
  health: GroundingHealth | null;
}

/**
 * Everything backing one entity's claim — §17's evidence panel.
 *
 * `health` is null rather than `"unverified"` when no resolver ran. The two are
 * different facts: `unverified` is a verdict a resolver reached, null means
 * nothing looked. A panel that collapsed them would tell a reviewer their
 * knowledge had been checked when it had not, which is the precise failure a
 * review queue exists to prevent.
 */
export function wikiEvidence(
  options: WikiServiceOptions & { id: string },
): ServiceResult<EvidenceData> {
  const empty: EvidenceData = { entity: null, sources: [], groundings: [], health: null };
  return read<EvidenceData>(options, empty, (session) => {
    const found = session.get(options.id);
    if (!found.ok) return { data: empty, diagnostics: [found.diagnostic] };

    const groundings = session.groundingsFor(options.id);
    const health = groundings
      .map((entry) => entry.health)
      .filter((value): value is GroundingHealth => value !== null)
      .sort(compareGroundingHealth)[0] ?? null;

    return {
      data: {
        entity: found.value,
        sources: session.sourcesFor(options.id),
        groundings,
        health,
      },
      diagnostics: [],
    };
  });
}

// -- Old-versus-new drift panel ----------------------------------------------

export interface DriftPane {
  nodeId: string;
  /** The node body as of grounding time — the old side. */
  oldSource: string | null;
  /** The node body as it is now, or null when the graph no longer has the node. */
  newSource: string | null;
  health: GroundingHealth | null;
  /** True when the two sides differ, or when the node is gone. */
  drifted: boolean;
}

export interface DriftData {
  entityId: string;
  panes: DriftPane[];
  /** True when no baseline store was supplied, so nothing could be compared. */
  unavailable: boolean;
}

/**
 * The old and new text of every node one entity grounds to — §17's drift panel.
 *
 * The old side comes from the grounding baseline in the code graph, which D1
 * makes the one place it lives; the new side comes from the live graph. Both
 * are parameters rather than things this module opens, for the reason §37 gives
 * about the resolver: an input that lives outside the scaffold has to be
 * explicit, or a caller cannot tell whether the absence of drift means "nothing
 * changed" or "nothing looked".
 *
 * With no baseline store, `unavailable` is true and the panes are empty —
 * never "no drift found", which is the same lie in a different voice.
 */
export function wikiDriftPanel(
  options: WikiServiceOptions & {
    id: string;
    baselines?: Pick<WikiBaselineStore, "list"> | null;
    graph?: Pick<SynthesisGraph, "describeNode"> | null;
    /** Reads a node's current body. Injected, because the graph interface does not carry text. */
    currentSource?: (nodeId: string) => string | null;
  },
): ServiceResult<DriftData> {
  const empty: DriftData = { entityId: options.id, panes: [], unavailable: true };
  if (options.baselines === undefined || options.baselines === null) {
    return { data: empty, diagnostics: [] };
  }

  return read<DriftData>(options, empty, (session) => {
    const found = session.get(options.id);
    if (!found.ok) return { data: empty, diagnostics: [found.diagnostic] };

    const byNode = new Map(session.groundingsFor(options.id).map((entry) => [entry.nodeId, entry]));
    const panes: DriftPane[] = [];
    for (const baseline of options.baselines!.list(options.id)) {
      const current = options.currentSource?.(baseline.nodeId) ?? null;
      const known = options.graph?.describeNode(baseline.nodeId) ?? null;
      const oldSource = baseline.source === "" ? null : baseline.source;
      panes.push({
        nodeId: baseline.nodeId,
        oldSource,
        newSource: current,
        health: byNode.get(baseline.nodeId)?.health ?? null,
        // A node the graph no longer has is drift of the strongest kind, and a
        // text comparison alone would call it unchanged when both sides are null.
        drifted: options.graph !== undefined && options.graph !== null && known === null
          ? true
          : current !== null && oldSource !== null && current !== oldSource,
      });
    }
    panes.sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));
    return { data: { entityId: options.id, panes, unavailable: false }, diagnostics: [] };
  });
}

// -- SDD traceability --------------------------------------------------------

/** One entity in the chain, with the gap below it made explicit. */
export interface ChainNode {
  entity: EntitySummary;
  /** Entities one hop downstream — what points at this one. */
  downstream: EntitySummary[];
  /** Entities one hop upstream — what this one points at. */
  upstream: EntitySummary[];
}

export interface ChainGap {
  /** The entity the chain stopped at. */
  entityId: string;
  /** The hop that found nothing, named as `<from> → <to>`. */
  hop: string;
  reason: string;
}

export interface TraceabilityData {
  origin: EntitySummary | null;
  /** Every entity reached, keyed by chain type, upstream first. */
  nodes: Record<string, ChainNode[]>;
  /** Code nodes the components in this chain ground to. */
  implementations: Array<{ entityId: string; nodeId: string; health: GroundingHealth | null }>;
  /** Test-file nodes calling one of those implementations. */
  tests: Array<{ nodeId: string; testNodeId: string; testFile: string }>;
  /** Acceptance criteria attached to anything in the chain. */
  acceptanceCriteria: Array<{ entityId: string; criterionId: string; title: string }>;
  /**
   * Where the chain stopped, one per missing hop.
   *
   * **A broken chain is the interesting answer, not an error.** A requirement
   * with no decision and a component with no test are exactly what a
   * traceability view exists to show, so they are returned rather than filtered
   * out and nothing throws.
   */
  gaps: ChainGap[];
  truncated: boolean;
}

const HOP_LABEL = (hop: SddHop): string => `${String(hop.from)} → ${String(hop.to)}`;

/**
 * Walk `spec → requirement → decision → component → implementation → test`.
 *
 * Answerable from either end, because "what implements FR-001?" and "why does
 * this component exist?" are the same edges walked in opposite directions and a
 * Hub needs both. The origin can be any entity in the chain; the walk goes both
 * ways from wherever it starts.
 *
 * The last two hops leave the wiki: `component → implementation` reads the
 * entity's groundings, and `implementation → test` asks the code graph which
 * test-file nodes call the implementation. Both graph-dependent halves degrade
 * to empty when no graph is supplied rather than failing the walk — §23.8 says
 * basic wiki reads must not require the code graph, and four of the six hops
 * are pure wiki.
 */
export function wikiTraceability(
  options: WikiServiceOptions & WikiFilterOptions & {
    id: string;
    graph?: Pick<SynthesisGraph, "callersOf" | "describeNode"> | null;
    isTest?: (path: string) => boolean;
  },
): ServiceResult<TraceabilityData> {
  const empty: TraceabilityData = {
    origin: null,
    nodes: {},
    implementations: [],
    tests: [],
    acceptanceCriteria: [],
    gaps: [],
    truncated: false,
  };

  return read<TraceabilityData>(options, empty, (session) => {
    const origin = session.get(options.id);
    if (!origin.ok) return { data: empty, diagnostics: [origin.diagnostic] };

    const isTest = options.isTest ?? isTestPath;
    const collected = new Map<string, EntitySummary>([[origin.value.id, origin.value]]);
    const nodes: Record<string, ChainNode[]> = {};
    const gaps: ChainGap[] = [];
    let truncated = false;

    /** One hop, in whichever direction. Returns what it reached. */
    const step = (entity: EntitySummary, hop: SddHop, direction: "up" | "down"): EntitySummary[] => {
      const related = session.related(entity.id, { depth: 0, includeBacklinks: true });
      if (!related.ok) return [];
      if (related.value.truncated) truncated = true;
      const edges = direction === "up" ? related.value.relations : related.value.backlinks;
      const wanted = direction === "up" ? hop.to : hop.from;
      return edges
        .filter((edge) => edge.type === hop.relation && edge.target !== null && edge.target.type === wanted)
        .map((edge) => edge.target!)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    };

    // Seed from the origin and expand outwards along the chain in both
    // directions until nothing new is reached.
    const frontier: EntitySummary[] = [origin.value];
    const visited = new Set<string>();
    while (frontier.length > 0) {
      const entity = frontier.shift()!;
      if (visited.has(entity.id)) continue;
      visited.add(entity.id);

      const upstream: EntitySummary[] = [];
      const downstream: EntitySummary[] = [];

      for (const hop of SDD_CHAIN) {
        if (String(entity.type) === String(hop.from)) {
          const reached = step(entity, hop, "up");
          if (reached.length === 0) {
            gaps.push({
              entityId: entity.id,
              hop: HOP_LABEL(hop),
              reason: `No \`${hop.relation}\` relation to a ${String(hop.to)} entity.`,
            });
          }
          upstream.push(...reached);
        }
        if (String(entity.type) === String(hop.to)) {
          downstream.push(...step(entity, hop, "down"));
        }
      }

      for (const reached of [...upstream, ...downstream]) {
        collected.set(reached.id, reached);
        if (!visited.has(reached.id)) frontier.push(reached);
      }

      const bucket = nodes[String(entity.type)] ?? [];
      bucket.push({ entity, upstream, downstream });
      nodes[String(entity.type)] = bucket;
    }

    // Hop 4: component → implementation, through grounding.
    const implementations: TraceabilityData["implementations"] = [];
    for (const entity of collected.values()) {
      if (String(entity.type) !== "component") continue;
      const groundings = session.groundingsFor(entity.id);
      if (groundings.length === 0) {
        gaps.push({
          entityId: entity.id,
          hop: "component → implementation",
          reason: "The component grounds to no code node.",
        });
        continue;
      }
      for (const grounding of groundings) {
        implementations.push({ entityId: entity.id, nodeId: grounding.nodeId, health: grounding.health });
      }
    }

    // Hop 5: implementation → test, through the code graph's `calls` edges.
    const tests: TraceabilityData["tests"] = [];
    if (options.graph !== undefined && options.graph !== null) {
      for (const implementation of implementations) {
        const callers = options.graph.callersOf(implementation.nodeId);
        const found = callers
          .map((callerId) => ({ callerId, node: options.graph!.describeNode(callerId) }))
          .filter((entry) => entry.node !== null && isTest(entry.node.filePath));
        if (found.length === 0) {
          gaps.push({
            entityId: implementation.entityId,
            hop: "implementation → test",
            reason: `No test-file node calls \`${implementation.nodeId}\` at depth ${TEST_CALL_DEPTH}.`,
          });
          continue;
        }
        for (const entry of found) {
          tests.push({ nodeId: implementation.nodeId, testNodeId: entry.callerId, testFile: entry.node!.filePath });
        }
      }
    }

    // Acceptance criteria: a decoration on a chain node, not a link in it.
    const acceptanceCriteria: TraceabilityData["acceptanceCriteria"] = [];
    for (const entity of collected.values()) {
      const related = session.related(entity.id, { depth: 0, includeBacklinks: true });
      if (!related.ok) continue;
      for (const edge of related.value.backlinks) {
        if (edge.type !== ACCEPTANCE_CRITERION_RELATION || edge.target === null) continue;
        if (String(edge.target.type) !== "acceptance_criterion") continue;
        acceptanceCriteria.push({ entityId: entity.id, criterionId: edge.target.id, title: edge.target.title });
      }
    }

    tests.sort((left, right) => `${left.nodeId}${left.testNodeId}`.localeCompare(`${right.nodeId}${right.testNodeId}`));
    implementations.sort((left, right) => `${left.entityId}${left.nodeId}`.localeCompare(`${right.entityId}${right.nodeId}`));
    acceptanceCriteria.sort((left, right) => `${left.entityId}${left.criterionId}`.localeCompare(`${right.entityId}${right.criterionId}`));
    gaps.sort((left, right) => `${left.entityId}${left.hop}`.localeCompare(`${right.entityId}${right.hop}`));

    return {
      data: { origin: origin.value, nodes, implementations, tests, acceptanceCriteria, gaps, truncated },
      diagnostics: [],
    };
  });
}

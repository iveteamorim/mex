/**
 * Stage C — relationship formation.
 *
 * The wiki becomes a graph here rather than a list. Two entities are proposed
 * as a pair only when there is real *structural* evidence linking them: shared
 * grounding, or a code-graph edge between the nodes they ground to. There is no
 * Cartesian product and no text similarity anywhere in this file — the walk
 * starts from grounded nodes and only reaches pairs that are actually connected.
 *
 * The code graph does a second job here beyond proposing: it **constrains** what
 * the agent may say. `allowedTypes` is computed from the two entity types plus
 * the kinds of edge that link them, so an agent cannot invent a relationship the
 * structure does not support. That is the difference between asking a model to
 * classify and asking it to choose from a menu.
 *
 * Sparse by design. A wiki with three sharp edges is more useful than one with
 * forty vague ones, which is why `related_to` — the escape hatch — is held to a
 * higher bar than every other type.
 */

import { createHash } from "node:crypto";
import type { EntityId } from "../model/ids.js";
import type { WikiActor } from "../model/operation.js";
import {
  indexContext,
  optional,
  rootContext,
  validateEnum,
  validateNumber,
  validateShape,
  validateString,
  type Validator,
} from "../model/validate.js";
import type { WikiUnit } from "./global-pass.js";

/**
 * The relationship types this stage may propose.
 *
 * Six of mex's twelve. The other six are excluded for reasons: `grounded_in`
 * describes the entity-to-code join, which grounding already records and which
 * no agent should be able to assert; `contradicts` and `caused_by` are
 * judgements about the world rather than about structure, and structural
 * evidence cannot support either; `derived_from`, `affects` and `verified_by`
 * belong to provenance and traceability chains a human maintains.
 */
export const RELATIONSHIP_TYPES = [
  "implements",
  "depends_on",
  "refines",
  "supersedes",
  "constrained_by",
  "related_to",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * The confidence each type must clear.
 *
 * Like the synthesis gates, these are not configuration: they decide what gets
 * written into a user's files. `related_to` sits higher than the rest because
 * it is the type an agent reaches for when it cannot justify a specific one,
 * and a wiki full of `related_to` edges is a wiki whose graph says nothing.
 */
export const RELATIONSHIP_CONFIDENCE: Record<RelationshipType, number> = {
  implements: 0.8,
  depends_on: 0.8,
  refines: 0.8,
  supersedes: 0.8,
  constrained_by: 0.8,
  related_to: 0.9,
};

/** Abstraction edges: a concrete symbol realizing or refining an abstract one. */
const ABSTRACTION_EDGE_KINDS = new Set(["implements", "extends", "overrides"]);

/** Dependency edges: a symbol needing another to function. */
const DEPENDENCY_EDGE_KINDS = new Set([
  "calls",
  "references",
  "instantiates",
  "type_of",
  "returns",
  "decorates",
  "imports",
]);

/** Containment and export say where a symbol lives, not what depends on what. */
const IGNORED_EDGE_KINDS = new Set(["contains", "exports"]);

/** Per-kind strength. Higher means stronger evidence of a real link. */
const EDGE_WEIGHTS: Record<string, number> = {
  implements: 1.0,
  extends: 0.9,
  overrides: 0.7,
  calls: 0.6,
  instantiates: 0.6,
  decorates: 0.5,
  references: 0.4,
  type_of: 0.4,
  returns: 0.4,
  imports: 0.3,
};

const SHARED_NODE_WEIGHT = 0.5;
const DEFAULT_MIN_SCORE = 0.3;
const DEFAULT_MAX_CANDIDATES = 60;
const DEFAULT_MAX_PER_UNIT = 6;

function edgeWeight(kind: string): number {
  return EDGE_WEIGHTS[kind] ?? 0.2;
}

/** The one read this stage makes of the code graph. */
export interface RelationshipGraphReader {
  outgoingEdges(nodeId: string): Array<{ source: string; target: string; kind: string }>;
}

export interface StructuralEdge {
  from: string;
  to: string;
  kind: string;
}

export interface StructuralEvidence {
  sharedNodeIds?: string[];
  callEdges?: StructuralEdge[];
  abstractionEdges?: StructuralEdge[];
  otherEdges?: StructuralEdge[];
  /** Why this pair was proposed, in words the agent and a reviewer both read. */
  adjacencyReason: string;
  /** Deterministic structural strength in [0, 1]. */
  score: number;
}

export interface RelationshipCandidate {
  /** Derived from the sorted member ids, so a re-run recomputes it. */
  candidateId: string;
  source: WikiUnit;
  target: WikiUnit;
  evidence: StructuralEvidence;
  /** The only types the agent may assign to this pair. */
  allowedTypes: RelationshipType[];
}

/**
 * Which types the structure and the two entity types together allow.
 *
 * Order-insensitive: direction is the agent's to choose, and this only
 * constrains the vocabulary.
 */
export function allowedTypesFor(
  sourceType: string,
  targetType: string,
  hasAbstractionEdge: boolean,
  hasDependencyEdge: boolean,
): RelationshipType[] {
  const allowed = new Set<RelationshipType>();
  const pair = (left: string, right: string): boolean =>
    (sourceType === left && targetType === right) || (sourceType === right && targetType === left);

  if (pair("component", "pattern") || pair("architecture", "pattern")) {
    allowed.add("implements");
    allowed.add("refines");
  }
  if (pair("pattern", "architecture")) {
    allowed.add("refines");
    allowed.add("implements");
  }
  if (pair("component", "component")) allowed.add("depends_on");
  if (pair("component", "architecture")) {
    allowed.add("implements");
    allowed.add("refines");
    allowed.add("depends_on");
  }
  if (
    pair("convention", "component") ||
    pair("convention", "pattern") ||
    pair("convention", "architecture") ||
    pair("convention", "decision")
  ) {
    allowed.add("constrained_by");
  }
  if (sourceType === "decision" || targetType === "decision") {
    allowed.add("depends_on");
    allowed.add("supersedes");
  }

  if (hasAbstractionEdge) {
    allowed.add("implements");
    allowed.add("refines");
  }
  if (hasDependencyEdge) allowed.add("depends_on");

  // Two claims of one kind: the newer can refine or replace the older.
  if (sourceType === targetType) {
    allowed.add("refines");
    allowed.add("supersedes");
  }

  // Always available, and always at the higher bar.
  allowed.add("related_to");

  return RELATIONSHIP_TYPES.filter((type) => allowed.has(type));
}

interface PairAccumulator {
  unitA: string;
  unitB: string;
  sharedNodeIds: Set<string>;
  edges: Map<string, StructuralEdge & { fromUnit: string; toUnit: string }>;
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function score(sharedNodes: number, edges: readonly StructuralEdge[]): number {
  const shared = sharedNodes > 0 ? Math.min(1, SHARED_NODE_WEIGHT + 0.1 * (sharedNodes - 1)) : 0;
  let edgeComponent = 0;
  for (const edge of edges) edgeComponent += edgeWeight(edge.kind);
  edgeComponent = Math.min(1, edgeComponent);
  // Edges are the stronger precision signal; shared grounding supports them.
  return Math.min(1, 0.75 * edgeComponent + 0.4 * shared);
}

/** The dominant edge direction by summed weight; ties break by id order. */
function orient(
  unitA: string,
  unitB: string,
  edges: readonly (StructuralEdge & { fromUnit: string })[],
): [string, string] {
  let aToB = 0;
  let bToA = 0;
  for (const edge of edges) {
    const weight = edgeWeight(edge.kind);
    if (edge.fromUnit === unitA) aToB += weight;
    else if (edge.fromUnit === unitB) bToA += weight;
  }
  if (aToB > bToA) return [unitA, unitB];
  if (bToA > aToB) return [unitB, unitA];
  return unitA < unitB ? [unitA, unitB] : [unitB, unitA];
}

export interface FindCandidatesOptions {
  /** Minimum structural score. Default 0.3. */
  minScore?: number;
  /** Cap on candidates, strongest first. Default 60. */
  maxCandidates?: number;
  /** Cap on candidates referencing any one entity. Default 6. */
  maxPerUnit?: number;
}

/**
 * Propose candidate pairs from grounding overlap and code-graph structure.
 *
 * Pure and deterministic given the same units and graph. The walk is outward
 * from each entity's grounded nodes, so the cost is proportional to the edges
 * that exist rather than to the square of the entity count.
 */
export function findRelationshipCandidates(
  units: readonly WikiUnit[],
  graph: RelationshipGraphReader,
  options: FindCandidatesOptions = {},
): RelationshipCandidate[] {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxPerUnit = options.maxPerUnit ?? DEFAULT_MAX_PER_UNIT;

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const unitsByNode = new Map<string, string[]>();
  for (const unit of units) {
    for (const nodeId of unit.groundingNodeIds) {
      const list = unitsByNode.get(nodeId) ?? [];
      if (!list.includes(unit.id)) list.push(unit.id);
      unitsByNode.set(nodeId, list);
    }
  }

  const pairs = new Map<string, PairAccumulator>();
  const pairFor = (left: string, right: string): PairAccumulator => {
    const key = pairKey(left, right);
    let accumulator = pairs.get(key);
    if (accumulator === undefined) {
      const [unitA, unitB] = left < right ? [left, right] : [right, left];
      accumulator = { unitA: unitA!, unitB: unitB!, sharedNodeIds: new Set(), edges: new Map() };
      pairs.set(key, accumulator);
    }
    return accumulator;
  };

  // Signal 1: two entities grounded to the same node describe the same code.
  for (const [nodeId, ids] of unitsByNode) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) pairFor(ids[i]!, ids[j]!).sharedNodeIds.add(nodeId);
    }
  }

  // Signal 2: a code-graph edge between nodes two entities ground to.
  for (const source of units) {
    for (const fromNode of source.groundingNodeIds) {
      let edges: Array<{ source: string; target: string; kind: string }>;
      try {
        edges = graph.outgoingEdges(fromNode);
      } catch {
        // A node that has gone is a reason to skip a pair, never to fail a run.
        continue;
      }
      for (const edge of edges) {
        if (IGNORED_EDGE_KINDS.has(edge.kind)) continue;
        for (const targetUnitId of unitsByNode.get(edge.target) ?? []) {
          if (targetUnitId === source.id) continue;
          const accumulator = pairFor(source.id, targetUnitId);
          const key = `${fromNode}|${edge.target}|${edge.kind}`;
          if (accumulator.edges.has(key)) continue;
          accumulator.edges.set(key, {
            from: fromNode,
            to: edge.target,
            kind: edge.kind,
            fromUnit: source.id,
            toUnit: targetUnitId,
          });
        }
      }
    }
  }

  const scored: Array<{ candidate: RelationshipCandidate; score: number }> = [];

  for (const accumulator of pairs.values()) {
    const unitA = unitById.get(accumulator.unitA);
    const unitB = unitById.get(accumulator.unitB);
    if (unitA === undefined || unitB === undefined) continue;

    const allEdges = [...accumulator.edges.values()];
    const sharedNodeIds = [...accumulator.sharedNodeIds].sort();
    const pairScore = score(sharedNodeIds.length, allEdges);
    if (pairScore < minScore) continue;

    const [sourceId, targetId] = orient(accumulator.unitA, accumulator.unitB, allEdges);
    const source = unitById.get(sourceId)!;
    const target = unitById.get(targetId)!;

    const callEdges: StructuralEdge[] = [];
    const abstractionEdges: StructuralEdge[] = [];
    const otherEdges: StructuralEdge[] = [];
    let hasAbstraction = false;
    let hasDependency = false;

    for (const edge of allEdges) {
      // Re-oriented so `from` reads as the chosen source.
      const directed: StructuralEdge =
        edge.fromUnit === sourceId
          ? { from: edge.from, to: edge.to, kind: edge.kind }
          : { from: edge.to, to: edge.from, kind: edge.kind };
      if (ABSTRACTION_EDGE_KINDS.has(edge.kind)) {
        abstractionEdges.push(directed);
        hasAbstraction = true;
      } else if (edge.kind === "calls") {
        callEdges.push(directed);
        hasDependency = true;
      } else if (DEPENDENCY_EDGE_KINDS.has(edge.kind)) {
        otherEdges.push(directed);
        hasDependency = true;
      } else {
        otherEdges.push(directed);
      }
    }

    const edgeCount = callEdges.length + abstractionEdges.length + otherEdges.length;
    const parts: string[] = [];
    if (edgeCount > 0) {
      parts.push(
        `${edgeCount} code-graph edge(s) link ${source.type} "${source.title}" to ${target.type} "${target.title}".`,
      );
    }
    if (sharedNodeIds.length > 0) parts.push(`Shared grounding nodes: ${sharedNodeIds.slice(0, 5).join(", ")}.`);
    parts.push(`Structural score: ${pairScore.toFixed(2)}.`);

    const evidence: StructuralEvidence = {
      adjacencyReason: parts.join(" "),
      score: pairScore,
      ...(sharedNodeIds.length > 0 ? { sharedNodeIds } : {}),
      ...(callEdges.length > 0 ? { callEdges } : {}),
      ...(abstractionEdges.length > 0 ? { abstractionEdges } : {}),
      ...(otherEdges.length > 0 ? { otherEdges } : {}),
    };

    scored.push({
      score: pairScore,
      candidate: {
        candidateId: `rel_${createHash("sha256")
          .update(pairKey(accumulator.unitA, accumulator.unitB), "utf8")
          .digest("hex")
          .slice(0, 12)}`,
        source,
        target,
        evidence,
        allowedTypes: allowedTypesFor(source.type, target.type, hasAbstraction, hasDependency),
      },
    });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score || left.candidate.candidateId.localeCompare(right.candidate.candidateId),
  );

  // Anti-flood: one hub entity must not consume the whole batch.
  const perUnit = new Map<string, number>();
  const kept: RelationshipCandidate[] = [];
  for (const { candidate } of scored) {
    if (kept.length >= maxCandidates) break;
    const source = candidate.source.id;
    const target = candidate.target.id;
    if ((perUnit.get(source) ?? 0) >= maxPerUnit || (perUnit.get(target) ?? 0) >= maxPerUnit) continue;
    perUnit.set(source, (perUnit.get(source) ?? 0) + 1);
    perUnit.set(target, (perUnit.get(target) ?? 0) + 1);
    kept.push(candidate);
  }

  return kept;
}

// ---------------------------------------------------------------------------
// The agent's judgement
// ---------------------------------------------------------------------------

export interface RelationshipJudgment {
  candidateId: string;
  action: "create" | "skip";
  type?: RelationshipType;
  sourceId?: string;
  targetId?: string;
  confidence?: number;
  evidence?: string;
  reasoning?: string;
}

const MIN_TEXT = 10;

const judgmentValidator: Validator<RelationshipJudgment> = validateShape<RelationshipJudgment>({
  candidateId: validateString(),
  action: validateEnum(["create", "skip"] as const, "INVALID_FIELD_TYPE", "relationship action"),
  type: optional(validateEnum(RELATIONSHIP_TYPES, "INVALID_RELATION_TYPE", "relationship type")),
  sourceId: optional(validateString()),
  targetId: optional(validateString()),
  confidence: optional(validateNumber({ min: 0, max: 1 })),
  evidence: optional(validateString()),
  reasoning: optional(validateString()),
});

export interface ExistingRelationship {
  sourceId: string;
  targetId: string;
  type: string;
}

export interface ValidateJudgmentsOptions {
  /** Ids of entities that are currently active. */
  activeIds: ReadonlySet<string>;
  /** Edges the wiki already carries, so a duplicate is refused. */
  existing?: readonly ExistingRelationship[];
}

export interface SkippedCandidate {
  candidateId: string;
  reasoning?: string;
}

export interface RejectedJudgment {
  judgment: unknown;
  reasons: string[];
}

export interface ValidateJudgmentsResult {
  valid: RelationshipJudgment[];
  /** The agent declining a candidate — the desired common case, not a failure. */
  skipped: SkippedCandidate[];
  rejected: RejectedJudgment[];
}

/**
 * Validate judgements against the candidates mex produced.
 *
 * Every check exists because the corresponding mistake writes a wrong edge into
 * someone's repository: a type outside the menu, an endpoint that is not in the
 * pair, a self-loop, an inactive endpoint, a confidence under the type's bar,
 * a claim with no evidence, and a duplicate of an edge that already exists.
 */
export function validateRelationshipJudgments(
  rawJudgments: readonly unknown[],
  candidates: readonly RelationshipCandidate[],
  options: ValidateJudgmentsOptions,
): ValidateJudgmentsResult {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const valid: RelationshipJudgment[] = [];
  const skipped: SkippedCandidate[] = [];
  const rejected: RejectedJudgment[] = [];
  const seen = new Set<string>();
  const root = rootContext();

  const duplicates = new Set<string>();
  for (const edge of options.existing ?? []) duplicates.add(`${edge.sourceId}|${edge.targetId}|${edge.type}`);

  for (let index = 0; index < rawJudgments.length; index += 1) {
    const raw = rawJudgments[index];
    const parsed = judgmentValidator(raw, indexContext({ ...root, path: "judgments" }, index));
    if (!parsed.ok) {
      rejected.push({ judgment: raw, reasons: parsed.diagnostics.map((entry) => entry.message) });
      continue;
    }
    const judgment = parsed.value;

    const candidate = byId.get(judgment.candidateId);
    if (candidate === undefined) {
      rejected.push({ judgment: raw, reasons: [`unknown candidateId: ${judgment.candidateId}`] });
      continue;
    }
    if (seen.has(judgment.candidateId)) {
      rejected.push({ judgment: raw, reasons: [`duplicate judgment for candidateId: ${judgment.candidateId}`] });
      continue;
    }
    seen.add(judgment.candidateId);

    if (judgment.action === "skip") {
      skipped.push({
        candidateId: judgment.candidateId,
        ...(judgment.reasoning === undefined ? {} : { reasoning: judgment.reasoning }),
      });
      continue;
    }

    const reasons: string[] = [];
    const members = new Set([candidate.source.id, candidate.target.id]);

    if (judgment.type === undefined) {
      reasons.push("create requires a type");
    } else if (!candidate.allowedTypes.includes(judgment.type)) {
      reasons.push(`type "${judgment.type}" is not in allowedTypes [${candidate.allowedTypes.join(", ")}]`);
    }

    if (judgment.sourceId === undefined || judgment.targetId === undefined) {
      reasons.push("create requires sourceId and targetId");
    } else {
      if (!members.has(judgment.sourceId)) reasons.push(`sourceId ${judgment.sourceId} is not in the candidate`);
      if (!members.has(judgment.targetId)) reasons.push(`targetId ${judgment.targetId} is not in the candidate`);
      if (judgment.sourceId === judgment.targetId) reasons.push("sourceId and targetId must differ");
      if (members.has(judgment.sourceId) && !options.activeIds.has(judgment.sourceId)) {
        reasons.push(`source entity ${judgment.sourceId} is not active`);
      }
      if (members.has(judgment.targetId) && !options.activeIds.has(judgment.targetId)) {
        reasons.push(`target entity ${judgment.targetId} is not active`);
      }
    }

    if (judgment.confidence === undefined) {
      reasons.push("create requires a confidence");
    } else if (judgment.type !== undefined) {
      const threshold = RELATIONSHIP_CONFIDENCE[judgment.type];
      if (judgment.confidence < threshold) {
        reasons.push(
          `confidence ${judgment.confidence} is below the ${judgment.type} threshold ${threshold}`,
        );
      }
    }

    if (judgment.evidence === undefined || judgment.evidence.trim().length < MIN_TEXT) {
      reasons.push("create requires substantive evidence");
    }
    if (judgment.reasoning === undefined || judgment.reasoning.trim().length < MIN_TEXT) {
      reasons.push("create requires substantive reasoning");
    }

    if (reasons.length === 0) {
      const key = `${judgment.sourceId}|${judgment.targetId}|${judgment.type}`;
      if (duplicates.has(key)) {
        reasons.push(`duplicate relationship: ${judgment.type} ${judgment.sourceId} to ${judgment.targetId} already exists`);
      } else {
        duplicates.add(key);
      }
    }

    if (reasons.length > 0) {
      rejected.push({ judgment: raw, reasons });
      continue;
    }
    valid.push(judgment);
  }

  return { valid, skipped, rejected };
}

// ---------------------------------------------------------------------------
// Judgements to operations
// ---------------------------------------------------------------------------

export interface RelationshipOperation {
  opId: string;
  candidateId: string;
  summary: string;
  envelope: Record<string, unknown>;
}

const DEFAULT_ACTOR: WikiActor = { kind: "agent", id: "synthesis-relationships" };

/**
 * One `add-relation` per accepted judgement.
 *
 * Both endpoints already exist, so nothing here has to name an id that a later
 * operation will mint — which is what makes stage C the simplest of the three
 * to turn into operations. The agent's own justification travels as the
 * relation's `note`, so a reviewer reading the Markdown sees why the edge is
 * there rather than only that it is.
 */
export function planRelationships(
  judgments: readonly RelationshipJudgment[],
  candidates: readonly RelationshipCandidate[],
  options: { actor?: WikiActor; now?: () => string } = {},
): RelationshipOperation[] {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const actor = options.actor ?? DEFAULT_ACTOR;
  const timestamp = (options.now ?? (() => new Date().toISOString()))();

  return judgments.flatMap((judgment) => {
    const candidate = byId.get(judgment.candidateId);
    if (candidate === undefined) return [];
    const source = candidate.source.id === judgment.sourceId ? candidate.source : candidate.target;
    const opId = `syn_rel_${createHash("sha256")
      .update([judgment.sourceId, judgment.targetId, judgment.type].join("|"), "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    return [
      {
        opId,
        candidateId: judgment.candidateId,
        summary: `${judgment.sourceId} ${judgment.type} ${judgment.targetId} (confidence ${judgment.confidence})`,
        envelope: {
          opId,
          type: "add-relation",
          entityId: judgment.sourceId as EntityId,
          // P5 requires a precondition on every mutating operation, and stage C
          // is exactly the case it exists for: a human reviews between the
          // proposal and the write, so the entity may have moved in between.
          baseRevision: source.revision,
          baseContentHash: source.contentHash,
          actor,
          timestamp,
          payload: {
            relation: {
              type: judgment.type,
              target: judgment.targetId as EntityId,
              ...(judgment.reasoning === undefined ? {} : { note: judgment.reasoning }),
              metadata: {
                synthesis: {
                  stage: "relationships",
                  confidence: judgment.confidence,
                  candidateId: judgment.candidateId,
                  structuralScore: candidate.evidence.score,
                },
              },
            },
          },
        },
      },
    ];
  });
}

/** Exported so a test asserts the numbers rather than restating them. */
export const RELATIONSHIP_DEFAULTS = {
  minScore: DEFAULT_MIN_SCORE,
  maxCandidates: DEFAULT_MAX_CANDIDATES,
  maxPerUnit: DEFAULT_MAX_PER_UNIT,
} as const;

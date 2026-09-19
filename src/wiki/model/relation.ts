import { isEntityId, normalizeEntityId, type EntityId } from "./ids.js";
import { contextDiagnostic, reject, succeed, validateEnum, validateShape, optional, validateString, type ValidationContext, type Validator } from "./validate.js";
import type { WikiDiagnostic } from "./diagnostic.js";

/**
 * Typed relationships between entities.
 *
 * Relations are stored on the *source* entity only. Backlinks are derived by
 * the index, never authored — an inverse field on the target would be a second
 * copy of the same fact, and the two would drift the first time someone edited
 * one side by hand.
 */

export const WIKI_RELATION_TYPES = [
  "depends_on",
  "implements",
  "supersedes",
  "contradicts",
  "derived_from",
  "grounded_in",
  "related_to",
  "affects",
  "verified_by",
  "refines",
  "constrained_by",
  "caused_by",
] as const;

export type WikiRelationType = (typeof WIKI_RELATION_TYPES)[number];

export interface WikiRelationRef {
  type: WikiRelationType;
  target: EntityId;
  note?: string;
  metadata?: Record<string, unknown>;
}

export function isWikiRelationType(value: unknown): value is WikiRelationType {
  return typeof value === "string" && (WIKI_RELATION_TYPES as readonly string[]).includes(value);
}

/**
 * Metadata key that waives a contradiction between two promoted decisions.
 *
 * The build spec requires the contradiction diagnostic "unless explicitly
 * waived", so the waiver has to live somewhere durable and reviewable. Putting
 * it on the relation's own metadata means it travels in the Markdown, shows up
 * in a pull request diff, and applies to exactly the one pair it was granted
 * for — rather than a global suppression list nobody re-reads.
 */
export const CONTRADICTION_WAIVER_KEY = "waived";

/** True when this relation carries an explicit contradiction waiver. */
export function isContradictionWaived(relation: WikiRelationRef): boolean {
  return relation.metadata?.[CONTRADICTION_WAIVER_KEY] === true;
}

const entityIdValidator: Validator<EntityId> = (value, context) => {
  const normalized = normalizeEntityId(value);
  if (normalized === null) {
    return reject(context, "INVALID_RELATION_TARGET", `Expected an entity id, got ${typeof value === "string" ? JSON.stringify(value) : typeof value}.`);
  }
  return succeed(normalized);
};

const metadataValidator: Validator<Record<string, unknown> | undefined> = (value, context) => {
  if (value === undefined) return succeed(undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject(context, "INVALID_FIELD_TYPE", "Expected metadata to be an object.");
  }
  return succeed(value as Record<string, unknown>);
};

/** Validate one relation reference in isolation. Cross-entity rules need {@link validateRelationGraph}. */
export const validateRelationRef: Validator<WikiRelationRef> = validateShape<WikiRelationRef>({
  type: validateEnum(WIKI_RELATION_TYPES, "INVALID_RELATION_TYPE", "relation type"),
  target: entityIdValidator,
  note: optional(validateString()),
  metadata: metadataValidator,
});

/**
 * The minimum an entity must expose for graph-level relation checks.
 *
 * Declared structurally rather than importing `WikiEntity` so this module stays
 * free of the entity module — the checks below are pure graph reasoning and are
 * useful over any shape carrying these four fields, including the index's own
 * row projections.
 */
export interface RelationSubject {
  id: EntityId;
  type: string;
  status: string;
  relations: readonly WikiRelationRef[];
}

/** Lifecycle states that count as active for relation-target checks. */
const ACTIVE_STATUSES = new Set(["in_flight", "promoted"]);

/**
 * Every cycle in the `supersedes` graph, each reported once.
 *
 * Supersession must form chains — A replaced by B replaced by C. A loop means
 * no version is current, which makes "what is the current decision" unanswerable
 * and would make a supersession timeline in the Hub non-terminating.
 *
 * Iterative depth-first search with an explicit stack rather than recursion:
 * this runs over a whole scaffold and the calibration target is 5,000 entities,
 * deep enough that recursion is a stack-overflow risk on a pathological chain.
 */
export function detectSupersessionCycles(subjects: readonly RelationSubject[]): EntityId[][] {
  const successors = new Map<EntityId, EntityId[]>();
  for (const subject of subjects) {
    successors.set(
      subject.id,
      subject.relations.filter((relation) => relation.type === "supersedes").map((relation) => relation.target),
    );
  }

  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;
  const state = new Map<EntityId, number>();
  const cycles: EntityId[][] = [];
  const reported = new Set<string>();

  for (const subject of subjects) {
    if ((state.get(subject.id) ?? UNVISITED) !== UNVISITED) continue;

    const path: EntityId[] = [];
    const stack: { node: EntityId; nextIndex: number }[] = [{ node: subject.id, nextIndex: 0 }];
    state.set(subject.id, IN_PROGRESS);
    path.push(subject.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = successors.get(frame.node) ?? [];
      if (frame.nextIndex >= edges.length) {
        state.set(frame.node, DONE);
        stack.pop();
        path.pop();
        continue;
      }
      const next = edges[frame.nextIndex]!;
      frame.nextIndex += 1;

      const nextState = state.get(next) ?? UNVISITED;
      if (nextState === IN_PROGRESS) {
        // Found a back edge: the cycle is the path from `next` to here.
        const start = path.indexOf(next);
        if (start >= 0) {
          const cycle = path.slice(start);
          const key = canonicalCycleKey(cycle);
          if (!reported.has(key)) {
            reported.add(key);
            cycles.push(cycle);
          }
        }
        continue;
      }
      if (nextState === DONE) continue;
      // Targets outside the supplied set have no edges of their own; visiting
      // them is harmless and keeps the traversal total.
      state.set(next, IN_PROGRESS);
      path.push(next);
      stack.push({ node: next, nextIndex: 0 });
    }
  }

  return cycles;
}

/**
 * Rotation-independent key for a cycle.
 *
 * The same loop discovered from a different entry point produces a rotated
 * array; without this the same cycle is reported once per member.
 */
function canonicalCycleKey(cycle: readonly EntityId[]): string {
  let best: string | null = null;
  for (let offset = 0; offset < cycle.length; offset += 1) {
    const rotated = [...cycle.slice(offset), ...cycle.slice(0, offset)].join(">");
    if (best === null || rotated < best) best = rotated;
  }
  return best ?? "";
}

export interface RelationGraphOptions {
  /** Entity types treated as decisions for the contradiction check. */
  decisionTypes?: readonly string[];
  /**
   * Report promoted entities that have no relations at all.
   *
   * Off by default: a scaffold mid-migration is legitimately full of them and
   * an info diagnostic per entity would bury the errors that matter.
   */
  reportOrphans?: boolean;
}

/**
 * Referential relation checks over the whole entity set.
 *
 * Pure: takes the entity set as an argument and returns diagnostics. Nothing
 * here reads a file or a database, which is what lets the same function serve
 * `mex wiki validate`, operation planning, and migration reporting.
 */
export function validateRelationGraph(
  subjects: readonly RelationSubject[],
  options: RelationGraphOptions = {},
): WikiDiagnostic[] {
  const decisionTypes = new Set(options.decisionTypes ?? ["decision"]);
  const byId = new Map<EntityId, RelationSubject>();
  for (const subject of subjects) byId.set(subject.id, subject);

  const diagnostics: WikiDiagnostic[] = [];
  const contradictionsReported = new Set<string>();

  for (const subject of subjects) {
    const seenTriples = new Set<string>();

    for (let index = 0; index < subject.relations.length; index += 1) {
      const relation = subject.relations[index]!;
      const context: ValidationContext = { path: `relations[${index}]`, entityId: subject.id };

      if (!isWikiRelationType(relation.type)) {
        diagnostics.push(
          contextDiagnostic(context, "INVALID_RELATION_TYPE", `Unknown relation type "${String(relation.type)}".`),
        );
        continue;
      }

      if (!isEntityId(relation.target)) {
        diagnostics.push(
          contextDiagnostic(context, "INVALID_RELATION_TARGET", `Relation target "${String(relation.target)}" is not an entity id.`),
        );
        continue;
      }

      if (relation.target === subject.id) {
        diagnostics.push(
          contextDiagnostic(context, "SELF_RELATION", `Entity ${subject.id} has a "${relation.type}" relation to itself.`),
        );
        continue;
      }

      const triple = `${relation.type}>${relation.target}`;
      if (seenTriples.has(triple)) {
        diagnostics.push(
          contextDiagnostic(context, "DUPLICATE_RELATION", `Duplicate relation "${relation.type}" to ${relation.target}.`),
        );
        continue;
      }
      seenTriples.add(triple);

      const target = byId.get(relation.target);
      if (target === undefined) {
        diagnostics.push(
          contextDiagnostic(context, "INVALID_RELATION_TARGET", `Relation target ${relation.target} does not exist.`),
        );
        continue;
      }

      // Archived and deprecated targets stay resolvable — history must not
      // dangle — but an active entity leaning on one is worth surfacing.
      if (ACTIVE_STATUSES.has(subject.status) && !ACTIVE_STATUSES.has(target.status)) {
        diagnostics.push(
          contextDiagnostic(
            context,
            "INACTIVE_RELATION_TARGET",
            `Active entity ${subject.id} has a "${relation.type}" relation to ${target.status} entity ${target.id}.`,
          ),
        );
      }

      if (
        relation.type === "contradicts" &&
        subject.status === "promoted" &&
        target.status === "promoted" &&
        decisionTypes.has(subject.type) &&
        decisionTypes.has(target.type) &&
        !isContradictionWaived(relation)
      ) {
        // Symmetric relation: report the pair once regardless of which side
        // declared it, and regardless of whether both sides declared it.
        const key = [subject.id, target.id].sort().join("><");
        if (!contradictionsReported.has(key)) {
          contradictionsReported.add(key);
          diagnostics.push(
            contextDiagnostic(
              context,
              "CONTRADICTORY_ACTIVE_DECISIONS",
              `Promoted decisions ${subject.id} and ${target.id} contradict each other.`,
            ),
          );
        }
      }
    }
  }

  for (const cycle of detectSupersessionCycles(subjects)) {
    diagnostics.push(
      contextDiagnostic(
        { path: "relations", entityId: cycle[0] },
        "SUPERSESSION_CYCLE",
        `Supersession cycle: ${[...cycle, cycle[0]].join(" -> ")}.`,
      ),
    );
  }

  if (options.reportOrphans) {
    const referenced = new Set<EntityId>();
    for (const subject of subjects) {
      for (const relation of subject.relations) referenced.add(relation.target);
    }
    for (const subject of subjects) {
      if (subject.status !== "promoted") continue;
      if (subject.relations.length > 0 || referenced.has(subject.id)) continue;
      diagnostics.push(
        contextDiagnostic(
          { path: "", entityId: subject.id },
          "ORPHANED_ENTITY",
          `Promoted entity ${subject.id} has no relations in either direction.`,
        ),
      );
    }
  }

  return diagnostics;
}

/**
 * Derived backlinks: for each entity, the relations pointing at it.
 *
 * Deterministically ordered by (relation type, source id) so two runs over the
 * same input produce the same output — the index and the CLI both depend on it.
 */
export function deriveBacklinks(
  subjects: readonly RelationSubject[],
): Map<EntityId, { type: WikiRelationType; source: EntityId; note?: string }[]> {
  const backlinks = new Map<EntityId, { type: WikiRelationType; source: EntityId; note?: string }[]>();
  for (const subject of subjects) {
    for (const relation of subject.relations) {
      const list = backlinks.get(relation.target) ?? [];
      const entry: { type: WikiRelationType; source: EntityId; note?: string } = {
        type: relation.type,
        source: subject.id,
      };
      if (relation.note !== undefined) entry.note = relation.note;
      list.push(entry);
      backlinks.set(relation.target, list);
    }
  }
  for (const list of backlinks.values()) {
    list.sort((left, right) => (left.type === right.type ? (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) : left.type < right.type ? -1 : 1));
  }
  return backlinks;
}

import type { WikiDiagnostic } from "./diagnostic.js";
import { normalizeEntityId, type EntityId } from "./ids.js";
import { contextDiagnostic } from "./validate.js";
import type { WikiRelationRef } from "./relation.js";

/**
 * Topics.
 *
 * **A topic is an entity of type `topic`, not a string.** That is the whole
 * design: a topic can carry a description, aliases, its own Markdown, and
 * relations, and entity membership refers to it by id — so renaming a topic
 * costs nothing and two spellings of "auth" cannot become two topics.
 *
 * Aliases exist for the edges of the system, where a human or an agent types
 * "authentication" rather than a ULID. They are resolved to ids *before*
 * anything is written, and ambiguous resolution is a hard failure rather than a
 * first-match guess — guessing here silently files knowledge under the wrong
 * topic, which is worse than refusing.
 */

/** Metadata key on a topic entity holding its alternative names. */
export const TOPIC_ALIASES_KEY = "aliases";

/**
 * The relation used for topic hierarchy.
 *
 * The build spec allows "`depends_on` or a registered `parent_topic` relation".
 * `depends_on` is used rather than registering a thirteenth relation type: the
 * relation vocabulary is a published contract and every extra member is one
 * more case in every consumer, while a `depends_on` between two topic entities
 * is unambiguous — nothing else pairs two topics that way.
 */
export const PARENT_TOPIC_RELATION = "depends_on";

/**
 * The minimum a topic entity must expose.
 *
 * Structural rather than importing `WikiEntity`, so this module can also index
 * the row projections the SQLite layer produces.
 */
export interface TopicSubject {
  id: EntityId;
  type: string;
  title: string;
  metadata?: Record<string, unknown>;
  relations: readonly WikiRelationRef[];
}

export interface TopicIndex {
  /** Topic entities by id. */
  byId: Map<EntityId, TopicSubject>;
  /**
   * Normalized name or alias to the ids claiming it. More than one id means the
   * name is ambiguous and must not be resolved.
   */
  byName: Map<string, EntityId[]>;
}

/** Normalize a topic name for lookup: case- and whitespace-insensitive. */
export function normalizeTopicName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Aliases declared on a topic entity, ignoring malformed entries. */
export function topicAliases(topic: TopicSubject): string[] {
  const raw = topic.metadata?.[TOPIC_ALIASES_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Build a lookup over the topic entities in a scaffold. */
export function buildTopicIndex(subjects: readonly TopicSubject[]): TopicIndex {
  const byId = new Map<EntityId, TopicSubject>();
  const byName = new Map<string, EntityId[]>();

  for (const subject of subjects) {
    if (subject.type !== "topic") continue;
    byId.set(subject.id, subject);
    for (const name of [subject.title, ...topicAliases(subject)]) {
      const key = normalizeTopicName(name);
      if (key === "") continue;
      const claimants = byName.get(key) ?? [];
      if (!claimants.includes(subject.id)) claimants.push(subject.id);
      byName.set(key, claimants);
    }
  }

  return { byId, byName };
}

export type TopicResolution =
  | { ok: true; id: EntityId }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "ambiguous"; candidates: EntityId[] };

/**
 * Resolve a topic reference — an id, a title, or an alias — to an id.
 *
 * Ids are tried first so an id that happens to look like a name cannot be
 * shadowed. Ambiguity is reported, never resolved: two topics answering to
 * "auth" is a real modelling problem the user has to settle.
 */
export function resolveTopicReference(index: TopicIndex, reference: string): TopicResolution {
  const asId = normalizeEntityId(reference);
  if (asId !== null) {
    return index.byId.has(asId) ? { ok: true, id: asId } : { ok: false, reason: "unknown" };
  }

  const claimants = index.byName.get(normalizeTopicName(reference));
  if (claimants === undefined || claimants.length === 0) return { ok: false, reason: "unknown" };
  if (claimants.length > 1) return { ok: false, reason: "ambiguous", candidates: [...claimants].sort() };
  return { ok: true, id: claimants[0]! };
}

/** Resolve a reference, reporting the failure as a diagnostic. */
export function resolveTopicOrDiagnose(
  index: TopicIndex,
  reference: string,
  path: string,
): { id: EntityId | null; diagnostics: WikiDiagnostic[] } {
  const resolution = resolveTopicReference(index, reference);
  if (resolution.ok) return { id: resolution.id, diagnostics: [] };
  if (resolution.reason === "ambiguous") {
    return {
      id: null,
      diagnostics: [
        contextDiagnostic(
          { path },
          "AMBIGUOUS_TOPIC_REFERENCE",
          `"${reference}" matches several topics (${resolution.candidates.join(", ")}). Use the topic id.`,
        ),
      ],
    };
  }
  return {
    id: null,
    diagnostics: [contextDiagnostic({ path }, "UNKNOWN_TOPIC", `No topic matches "${reference}".`)],
  };
}

/**
 * The minimum for checking topic membership on an ordinary entity.
 */
export interface TopicMemberSubject {
  id: EntityId;
  topics: readonly EntityId[];
}

/**
 * Check that every topic membership points at an existing entity of type `topic`.
 *
 * The second half matters as much as the first: a membership pointing at a
 * *decision* resolves fine and then produces a topic page that is not a topic.
 */
export function validateTopicMembership(
  members: readonly TopicMemberSubject[],
  entitiesById: ReadonlyMap<EntityId, { type: string }>,
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (const member of members) {
    for (let index = 0; index < member.topics.length; index += 1) {
      const topicId = member.topics[index]!;
      const path = `topics[${index}]`;
      const target = entitiesById.get(topicId);
      if (target === undefined) {
        diagnostics.push(
          contextDiagnostic({ path, entityId: member.id }, "UNKNOWN_TOPIC", `Topic ${topicId} does not exist.`),
        );
        continue;
      }
      if (target.type !== "topic") {
        diagnostics.push(
          contextDiagnostic(
            { path, entityId: member.id },
            "INVALID_TOPIC_MEMBER",
            `Topic membership points at ${topicId}, which is a "${target.type}", not a topic.`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

/**
 * Cycles in the topic hierarchy.
 *
 * Only `depends_on` relations *between two topic entities* count, so an
 * ordinary `depends_on` between a decision and a component is not mistaken for
 * hierarchy. Iterative rather than recursive, for the same stack-depth reason
 * as supersession cycle detection.
 */
export function detectTopicCycles(index: TopicIndex): EntityId[][] {
  const parents = new Map<EntityId, EntityId[]>();
  for (const [id, topic] of index.byId) {
    parents.set(
      id,
      topic.relations
        .filter((relation) => relation.type === PARENT_TOPIC_RELATION && index.byId.has(relation.target))
        .map((relation) => relation.target),
    );
  }

  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;
  const state = new Map<EntityId, number>();
  const cycles: EntityId[][] = [];
  const reported = new Set<string>();

  for (const start of index.byId.keys()) {
    if ((state.get(start) ?? UNVISITED) !== UNVISITED) continue;
    const path: EntityId[] = [start];
    const stack: { node: EntityId; nextIndex: number }[] = [{ node: start, nextIndex: 0 }];
    state.set(start, IN_PROGRESS);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = parents.get(frame.node) ?? [];
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
        const startIndex = path.indexOf(next);
        if (startIndex >= 0) {
          const cycle = path.slice(startIndex);
          const key = [...cycle].sort().join(">");
          if (!reported.has(key)) {
            reported.add(key);
            cycles.push(cycle);
          }
        }
        continue;
      }
      if (nextState === DONE) continue;
      state.set(next, IN_PROGRESS);
      path.push(next);
      stack.push({ node: next, nextIndex: 0 });
    }
  }

  return cycles;
}

/** Topic cycles, as diagnostics. */
export function validateTopicHierarchy(index: TopicIndex): WikiDiagnostic[] {
  return detectTopicCycles(index).map((cycle) =>
    contextDiagnostic(
      { path: "relations", entityId: cycle[0] },
      "TOPIC_CYCLE",
      `Topic hierarchy cycle: ${[...cycle, cycle[0]].join(" -> ")}.`,
    ),
  );
}

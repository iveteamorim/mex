/**
 * Stage B — the global cross-cutting pass.
 *
 * Per-cluster synthesis cannot see across clusters, so it produces the same
 * convention three times under three names. This pass groups the near-duplicates
 * deterministically and asks the agent to judge each group: merge them, promote
 * one, keep them apart, or drop the weak ones.
 *
 * **Grouping optimizes for recall.** A group is a question, not a verdict, so a
 * borderline pair costs the agent one judgement and a missed pair costs the
 * wiki a permanent duplicate. Precision is the agent's job here; mex's job is
 * not to hide the question.
 *
 * ## What this reads, and why it is applied state
 *
 * B judges entities that exist. In the reference that was seamless because
 * stage A wrote rows as it went; here stage A only *proposes*, so a run of A
 * whose operations nobody applied leaves nothing for B to consolidate. That is
 * a property of the phase rather than a gap in it — see the handoff on why B
 * reading unapplied proposals was rejected — and it makes B's input exactly
 * what `wiki list` returns.
 *
 * Pure: units in, groups out, judgements in, operation envelopes out. No index,
 * no filesystem, no model.
 */

import { createHash } from "node:crypto";
import type { EntityId } from "../model/ids.js";
import type { WikiActor } from "../model/operation.js";
import type { WikiEntityType, WikiLifecycleState } from "../model/entity.js";
import {
  indexContext,
  optional,
  rootContext,
  validateArray,
  validateEnum,
  validateShape,
  validateString,
  type Validator,
} from "../model/validate.js";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { deriveGrounding, type GroundingGraph } from "../grounding/adapter.js";
import type { WikiGrounding } from "../model/grounding.js";

/** One applied entity, projected into what consolidation needs. */
export interface WikiUnit {
  id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  status: string;
  /** Scaffold-relative file the entity lives in. */
  file: string;
  /** Code-graph node ids the entity grounds to. */
  groundingNodeIds: string[];
  /**
   * The revision and content hash an operation on this entity must carry.
   *
   * P5 requires a precondition on all nine mutating operations, and requires it
   * for a reason that applies exactly here: stages B and C put a human between
   * proposal and apply, so the tree can move in between, and an unconditional
   * write would overwrite whatever the human did with what the agent saw. Both
   * values are read from the file at projection time rather than from the
   * index, because §51.1's guarantee — locate's answer is the same with a
   * fresh, stale or absent index — is only true of values that came from the
   * bytes.
   */
  revision: number;
  contentHash: string;
}

export interface CandidateGroup {
  /** Derived from the sorted member ids, so a re-run recomputes it. */
  groupId: string;
  /** Groups never mix types. */
  type: string;
  units: WikiUnit[];
  reason: string;
}

export const GLOBAL_PASS_ACTIONS = ["merge", "promote_one", "keep_separate", "drop_weak"] as const;
export type GlobalPassActionType = (typeof GLOBAL_PASS_ACTIONS)[number];

export interface GlobalPassCanonicalUnit {
  type: string;
  title: string;
  summary: string;
  body: string;
  /** Must be a non-empty subset of the group's combined grounding. */
  groundingNodeIds: string[];
}

export interface GlobalPassAction {
  groupId: string;
  action: GlobalPassActionType;
  canonicalUnit?: GlobalPassCanonicalUnit;
  winnerId?: string;
  loserIds?: string[];
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Deterministic grouping
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SCORE = 0.26;
const DEFAULT_MAX_GROUP_SIZE = 10;

/** Words that carry no distinguishing signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "this", "that", "these", "those", "it", "its", "as", "by",
  "from", "at", "into", "via", "using", "used", "use", "uses", "how", "what",
  "when", "which", "each", "per", "we", "our", "they", "their", "can", "may",
  "must", "should", "will", "has", "have", "not", "all", "any", "one", "two",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/** Adjacent token pairs — short distinctive phrases a single token misses. */
function bigrams(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 1) out.add(`${tokens[index]} ${tokens[index + 1]}`);
  return out;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function sharedCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared;
}

interface Features {
  unit: WikiUnit;
  titleTokens: Set<string>;
  summaryTokens: Set<string>;
  textTokens: Set<string>;
  phrases: Set<string>;
  nodeIds: Set<string>;
  files: Set<string>;
}

function featurize(unit: WikiUnit): Features {
  const title = tokenize(unit.title);
  const summary = tokenize(unit.summary);
  return {
    unit,
    titleTokens: new Set(title),
    summaryTokens: new Set(summary),
    textTokens: new Set([...summary, ...tokenize(unit.body)]),
    phrases: bigrams(tokenize(`${unit.title} ${unit.summary}`)),
    nodeIds: new Set(unit.groundingNodeIds),
    files: new Set([unit.file]),
  };
}

function pairScore(left: Features, right: Features): number {
  return (
    0.4 * jaccard(left.titleTokens, right.titleTokens) +
    0.2 * jaccard(left.summaryTokens, right.summaryTokens) +
    0.15 * jaccard(left.nodeIds, right.nodeIds) +
    0.15 * jaccard(left.textTokens, right.textTokens) +
    0.1 * jaccard(left.files, right.files)
  );
}

/**
 * Whether two units are close enough to ask about.
 *
 * Recall-first: any one strong signal is enough. A composite score alone would
 * miss two units with identical titles whose bodies were written differently,
 * which is the most common duplicate there is.
 */
function isEdge(left: Features, right: Features, minScore: number): boolean {
  const titleSimilarity = jaccard(left.titleTokens, right.titleTokens);
  return (
    pairScore(left, right) >= minScore ||
    titleSimilarity >= 0.6 ||
    jaccard(left.nodeIds, right.nodeIds) >= 0.5 ||
    (sharedCount(left.nodeIds, right.nodeIds) >= 1 && titleSimilarity >= 0.25) ||
    sharedCount(left.phrases, right.phrases) >= 2
  );
}

/** Union-find over member indices, so a chain of similar units forms one group. */
class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cursor = index;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]!;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b);
  }
}

function shortHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 12);
}

/** Values recurring across at least `minimum` members — the shared "why". */
function recurring(values: readonly (readonly string[])[], minimum = 2): string[] {
  const counts = new Map<string, number>();
  for (const list of values) {
    for (const value of new Set(list)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minimum)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value]) => value);
}

export interface FindGroupsOptions {
  /** Minimum composite similarity for a grouping edge. Default 0.26. */
  minScore?: number;
  /** Members per group, keeping the strongest. Default 10. */
  maxGroupSize?: number;
  /** Cap on groups emitted, highest-signal first. */
  maxGroups?: number;
}

/**
 * The rank that decides which members survive an oversized group.
 *
 * The reference kept the highest-*confidence* members. mex has no confidence on
 * an applied entity — confidence gated the proposal and is recorded in the
 * entity's metadata, not in its identity — so the ordering here is lifecycle
 * first, which is a fact the wiki actually maintains, and then id, which makes
 * it total.
 */
function memberRank(unit: WikiUnit): number {
  return unit.status === "promoted" ? 0 : unit.status === "in_flight" ? 1 : 2;
}

/** Group units that may describe one concept. Same type only; size two or more. */
export function findCandidateGroups(
  units: readonly WikiUnit[],
  options: FindGroupsOptions = {},
): CandidateGroup[] {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const maxGroupSize = options.maxGroupSize ?? DEFAULT_MAX_GROUP_SIZE;

  const byType = new Map<string, Features[]>();
  for (const unit of units) {
    const bucket = byType.get(unit.type) ?? [];
    bucket.push(featurize(unit));
    byType.set(unit.type, bucket);
  }

  const scored: Array<{ group: CandidateGroup; topScore: number }> = [];

  for (const [type, features] of [...byType.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (features.length < 2) continue;

    const sets = new DisjointSet(features.length);
    for (let i = 0; i < features.length; i += 1) {
      for (let j = i + 1; j < features.length; j += 1) {
        if (isEdge(features[i]!, features[j]!, minScore)) sets.union(i, j);
      }
    }

    const components = new Map<number, number[]>();
    for (let index = 0; index < features.length; index += 1) {
      const root = sets.find(index);
      const list = components.get(root) ?? [];
      list.push(index);
      components.set(root, list);
    }

    for (const indices of components.values()) {
      if (indices.length < 2) continue;

      let topScore = 0;
      for (let a = 0; a < indices.length; a += 1) {
        for (let b = a + 1; b < indices.length; b += 1) {
          topScore = Math.max(topScore, pairScore(features[indices[a]!]!, features[indices[b]!]!));
        }
      }

      let members = indices.map((index) => features[index]!);
      if (members.length > maxGroupSize) {
        members = [...members]
          .sort(
            (left, right) =>
              memberRank(left.unit) - memberRank(right.unit) || left.unit.id.localeCompare(right.unit.id),
          )
          .slice(0, maxGroupSize);
      }

      const sorted = [...members].sort((left, right) => left.unit.id.localeCompare(right.unit.id));
      const memberUnits = sorted.map((entry) => entry.unit);
      const sharedNodes = recurring(sorted.map((entry) => [...entry.nodeIds])).slice(0, 5);
      const sharedTerms = recurring(sorted.map((entry) => [...entry.titleTokens])).slice(0, 6);

      const parts = [`${memberUnits.length} "${type}" entities grouped (recall-first).`];
      if (sharedTerms.length > 0) parts.push(`Common title terms: ${sharedTerms.join(", ")}.`);
      if (sharedNodes.length > 0) parts.push(`Shared grounding nodes: ${sharedNodes.join(", ")}.`);
      parts.push(`Top pairwise similarity: ${topScore.toFixed(2)}.`);

      scored.push({
        topScore,
        group: {
          groupId: `gp_${type}_${shortHash(memberUnits.map((unit) => unit.id).sort().join("|"))}`,
          type,
          units: memberUnits,
          reason: parts.join(" "),
        },
      });
    }
  }

  scored.sort(
    (left, right) => right.topScore - left.topScore || left.group.groupId.localeCompare(right.group.groupId),
  );

  const limited = options.maxGroups === undefined ? scored : scored.slice(0, options.maxGroups);
  return limited.map((entry) => entry.group);
}

// ---------------------------------------------------------------------------
// Validating the agent's judgement
// ---------------------------------------------------------------------------

const MIN_REASONING = 10;

const canonicalUnitValidator: Validator<GlobalPassCanonicalUnit> = validateShape<GlobalPassCanonicalUnit>({
  type: validateString(),
  title: validateString(),
  summary: validateString(),
  body: validateString(),
  groundingNodeIds: validateArray(validateString()),
});

const actionValidator: Validator<GlobalPassAction> = validateShape<GlobalPassAction>({
  groupId: validateString(),
  action: validateEnum(GLOBAL_PASS_ACTIONS, "INVALID_FIELD_TYPE", "global-pass action"),
  canonicalUnit: optional(canonicalUnitValidator),
  winnerId: optional(validateString()),
  loserIds: optional(validateArray(validateString())),
  reasoning: optional(validateString()),
});

export interface RejectedAction {
  action: unknown;
  reasons: string[];
}

export interface ValidateActionsResult {
  valid: GlobalPassAction[];
  rejected: RejectedAction[];
}

/**
 * Validate agent actions against the groups mex produced.
 *
 * The groups are the source of truth: an action may only name ids inside its
 * own group, a merge's grounding may only be a subset of what the group already
 * carries, and every destructive action needs a written reason. mex is not
 * checking that the agent was right; it is checking that the agent stayed
 * inside the question it was asked.
 */
export function validateGlobalPassActions(
  rawActions: readonly unknown[],
  groups: readonly CandidateGroup[],
): ValidateActionsResult {
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  const valid: GlobalPassAction[] = [];
  const rejected: RejectedAction[] = [];
  const seen = new Set<string>();
  const root = rootContext();

  for (let index = 0; index < rawActions.length; index += 1) {
    const raw = rawActions[index];
    const parsed = actionValidator(raw, indexContext({ ...root, path: "actions" }, index));
    if (!parsed.ok) {
      rejected.push({ action: raw, reasons: parsed.diagnostics.map((entry) => entry.message) });
      continue;
    }
    const action = parsed.value;

    const group = byId.get(action.groupId);
    if (group === undefined) {
      rejected.push({ action: raw, reasons: [`unknown groupId: ${action.groupId}`] });
      continue;
    }
    // Marked seen the moment the group is *claimed*, not once an action for it
    // is accepted. The reference only recorded accepted ones, which let a second
    // action slip through after the first failed validation — the duplicate
    // check then depended on whether the first attempt happened to be valid.
    if (seen.has(action.groupId)) {
      rejected.push({ action: raw, reasons: [`duplicate action for groupId: ${action.groupId}`] });
      continue;
    }
    seen.add(action.groupId);

    const memberIds = new Set(group.units.map((unit) => unit.id));
    const nodeUnion = new Set(group.units.flatMap((unit) => unit.groundingNodeIds));
    const loserIds = action.loserIds ?? [];
    const reasons: string[] = [];

    if (action.winnerId !== undefined && !memberIds.has(action.winnerId)) {
      reasons.push(`winnerId ${action.winnerId} is not a member of the group`);
    }
    const strays = loserIds.filter((id) => !memberIds.has(id));
    if (strays.length > 0) reasons.push(`loserIds not in the group: ${strays.join(", ")}`);
    if (action.winnerId !== undefined && loserIds.includes(action.winnerId)) {
      reasons.push("winnerId must not also appear in loserIds");
    }

    const needsReasoning = (): void => {
      if (action.reasoning === undefined || action.reasoning.trim().length < MIN_REASONING) {
        reasons.push(`${action.action} requires substantive reasoning`);
      }
    };

    if (action.action === "merge") {
      const canonical = action.canonicalUnit;
      if (canonical === undefined) {
        reasons.push("merge requires a canonicalUnit");
      } else {
        if (canonical.type !== group.type) {
          reasons.push(`canonicalUnit.type "${canonical.type}" must equal the group type "${group.type}"`);
        }
        if (canonical.groundingNodeIds.length === 0) {
          reasons.push("a merged canonicalUnit must keep at least one grounding node");
        }
        const invented = canonical.groundingNodeIds.filter((nodeId) => !nodeUnion.has(nodeId));
        if (invented.length > 0) {
          reasons.push(`canonicalUnit grounding introduces node ids not in the group: ${invented.join(", ")}`);
        }
      }
      needsReasoning();
    } else if (action.action === "promote_one") {
      if (action.winnerId === undefined) reasons.push("promote_one requires a winnerId");
      needsReasoning();
    } else if (action.action === "drop_weak") {
      if (loserIds.length === 0) reasons.push("drop_weak requires at least one loserId");
      if (loserIds.length >= group.units.length) reasons.push("drop_weak must leave at least one unit in the group");
      needsReasoning();
    }

    if (reasons.length > 0) {
      rejected.push({ action: raw, reasons });
      continue;
    }
    valid.push(action);
  }

  return { valid, rejected };
}

// ---------------------------------------------------------------------------
// Actions to operations
// ---------------------------------------------------------------------------

export interface GlobalPassOperation {
  opId: string;
  groupId: string;
  /** What this envelope does, for a report a human reads before applying. */
  summary: string;
  envelope: Record<string, unknown>;
}

export interface GlobalPassPlanOptions {
  /**
   * The live code graph. A merge mints a *new* entity carrying the group's
   * grounding, so §12.4 applies to it exactly as it does to stage A — and a
   * merge with no graph is refused rather than written ungrounded.
   */
  graph: GroundingGraph | null;
  actor?: WikiActor;
  now?: () => string;
}

export interface GlobalPassPlanResult {
  operations: GlobalPassOperation[];
  /** Actions that could not be turned into operations, with the reason. */
  refused: RejectedAction[];
  diagnostics: WikiDiagnostic[];
}

const DEFAULT_ACTOR: WikiActor = { kind: "agent", id: "synthesis-global-pass" };

function opId(kind: string, parts: readonly string[]): string {
  return `syn_${kind}_${createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Turn validated actions into operation envelopes.
 *
 * Every action maps onto the eleven existing operation types; none of them
 * needed a twelfth. The interesting case is `merge`, which has to create a
 * canonical entity *and* retire several existing ones, and the canonical's id
 * does not exist until the plan is applied.
 *
 * The resolution is to put the lineage on the canonical rather than on the
 * losers: one `supersede-entry` creates the canonical against the first member
 * and carries `supersedes` relations to every other member in its own payload,
 * so no operation ever has to name an id that a later operation will mint. The
 * remaining members are then deprecated in their own right.
 */
export function planGlobalPass(
  actions: readonly GlobalPassAction[],
  groups: readonly CandidateGroup[],
  options: GlobalPassPlanOptions,
): GlobalPassPlanResult {
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  const actor = options.actor ?? DEFAULT_ACTOR;
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  // Two lists, and the order between them is a correctness property.
  //
  // A `create-entry` at end of file necessarily extends the *previous* entity's
  // body range, because a body runs to the start of the next entity's metadata
  // (P2a's third terminator). `verifyPlan` tolerates that — it compares a
  // trailing-whitespace-trimmed fingerprint — but an operation *precondition*
  // is the raw `entityContentHash`, so an insertion invalidates the
  // precondition of whichever entity is last in that file. Every mutation of an
  // existing entity therefore goes out before any operation that creates one.
  const mutations: GlobalPassOperation[] = [];
  const creations: GlobalPassOperation[] = [];
  const refused: RejectedAction[] = [];
  const diagnostics: WikiDiagnostic[] = [];

  const deprecate = (groupId: string, unit: WikiUnit, why: string): void => {
    mutations.push({
      opId: opId("dep", [groupId, unit.id]),
      groupId,
      summary: `deprecate ${unit.id} ("${unit.title}") — ${why}`,
      envelope: {
        opId: opId("dep", [groupId, unit.id]),
        type: "set-property",
        entityId: unit.id,
        baseRevision: unit.revision,
        baseContentHash: unit.contentHash,
        actor,
        timestamp,
        payload: { property: "status", value: "deprecated" satisfies WikiLifecycleState },
      },
    });
  };

  for (const action of actions) {
    const group = byId.get(action.groupId);
    if (group === undefined) continue;
    const members = group.units;

    if (action.action === "keep_separate") continue;

    if (action.action === "drop_weak") {
      for (const id of action.loserIds ?? []) {
        const unit = members.find((entry) => entry.id === id);
        if (unit !== undefined) deprecate(action.groupId, unit, "a weak near-duplicate");
      }
      continue;
    }

    if (action.action === "promote_one") {
      const winner = members.find((entry) => entry.id === action.winnerId)!;
      const losers = members.filter((entry) => entry.id !== winner.id);
      for (const loser of losers) {
        mutations.push({
          opId: opId("sup", [action.groupId, winner.id, loser.id]),
          groupId: action.groupId,
          summary: `${winner.id} supersedes ${loser.id}`,
          envelope: {
            opId: opId("sup", [action.groupId, winner.id, loser.id]),
            type: "add-relation",
            entityId: winner.id,
            baseRevision: winner.revision,
            baseContentHash: winner.contentHash,
            actor,
            timestamp,
            payload: {
              relation: {
                type: "supersedes",
                target: loser.id as EntityId,
                ...(action.reasoning === undefined ? {} : { note: action.reasoning }),
              },
            },
          },
        });
        deprecate(action.groupId, loser, `superseded by ${winner.id}`);
      }
      continue;
    }

    // merge
    const canonical = action.canonicalUnit!;

    // §12.4 on the entity a merge mints. The ids were already checked to be a
    // subset of what the group carries; that says the agent stayed inside the
    // question, not that the graph can still produce them — a node retired
    // between stage A and stage B passes the first check and fails this one.
    const groundings: WikiGrounding[] = [];
    const unverified: string[] = [];
    for (const nodeId of canonical.groundingNodeIds) {
      const derived = options.graph === null ? null : deriveGrounding(options.graph, nodeId);
      if (derived === null) unverified.push(nodeId);
      else groundings.push({ ...derived });
    }
    if (unverified.length > 0) {
      const why =
        options.graph === null
          ? "no code graph is available, and a merged entity may not be written ungrounded"
          : `the code graph cannot produce ${unverified.join(", ")}`;
      refused.push({ action, reasons: [why] });
      diagnostics.push(diagnostic("GROUNDING_UNVERIFIED", `merge of ${action.groupId} was refused: ${why}.`));
      continue;
    }

    const anchor = members.find((entry) => entry.id === action.winnerId) ?? members[0]!;
    const others = members.filter((entry) => entry.id !== anchor.id);
    const id = opId("mrg", [action.groupId]);
    creations.push({
      opId: id,
      groupId: action.groupId,
      summary: `merge ${members.length} entities into a new "${canonical.title}"`,
      envelope: {
        opId: id,
        type: "supersede-entry",
        entityId: anchor.id,
        baseRevision: anchor.revision,
        baseContentHash: anchor.contentHash,
        actor,
        timestamp,
        payload: {
          ...(action.reasoning === undefined ? {} : { note: action.reasoning }),
          replacement: {
            // The canonical is filed where the anchor already lives, so a merge
            // never relocates knowledge as a side effect of consolidating it.
            file: anchor.file,
            insertAt: { at: "end-of-file" },
            type: canonical.type as WikiEntityType,
            title: canonical.title,
            summary: canonical.summary,
            body: canonical.body,
            status: "in_flight" satisfies WikiLifecycleState,
            // Lineage to every other member, carried on the canonical so no
            // operation names an id a later one would mint.
            relations: others.map((entry) => ({ type: "supersedes" as const, target: entry.id as EntityId })),
            groundsTo: groundings,
            metadata: { synthesis: { stage: "global", groupId: action.groupId, mergedFrom: members.map((entry) => entry.id) } },
          },
        },
      },
    });
    for (const other of others) deprecate(action.groupId, other, `merged into "${canonical.title}"`);
  }

  return { operations: [...mutations, ...creations], refused, diagnostics };
}

/** Numbers a caller may tune, exported so a test asserts them rather than restating them. */
export const GLOBAL_PASS_DEFAULTS = {
  minScore: DEFAULT_MIN_SCORE,
  maxGroupSize: DEFAULT_MAX_GROUP_SIZE,
} as const;

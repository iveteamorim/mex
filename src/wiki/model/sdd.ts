/**
 * The SDD traceability chain — `spec → requirement → decision → component →
 * implementation → test` — as a table rather than as prose.
 *
 * ## What this is not
 *
 * "SDD" outside this repository names a *workflow*: write a structured spec,
 * then drive a coding agent from it. §17 asks for none of that. Its entire SDD
 * clause is one line naming a six-hop **query**, in a section whose subject is
 * data sufficiency and whose UI is an explicit non-goal. So there is no
 * `specify` command here, no feature-directory scaffolding, no constitution and
 * no task runner. What this module owes is the ability to answer the
 * traceability question over entities that already exist, whoever authored them
 * and by whatever process.
 *
 * That is also the answer to interoperability. A user running an external SDD
 * tool alongside mex has requirements in *their* tool's file layout, and an
 * importer that understood that layout would be a second parser for the same
 * facts — the shape D1 exists to forbid — that drifts the moment the other tool
 * ships a format change. The vocabularies line up (§8.2 already has `spec`,
 * `requirement`, `constraint` and `acceptance_criterion`), migration is the
 * on-ramp, and the chain reads whatever is in the scaffold.
 *
 * ## Why the mapping has to be pinned here
 *
 * §8.4 gives twelve relation types and §17 gives the chain, and **nothing in
 * the spec says which relation carries which hop.** Until something does, two
 * scaffolds answer the traceability question differently and neither is wrong.
 * `PARENT_TOPIC_RELATION` in `topic.ts` set the precedent for this exact move:
 * a spec-level semantic fixed to a relation type as one named constant, in one
 * place, so it cannot drift between the writer and the reader.
 *
 * ## Direction, and why every hop points backwards
 *
 * Relations are stored on the source entity and backlinks are derived, so the
 * direction a hop is *written* decides which end has to be edited to record it.
 * Every hop here is authored on the **downstream** entity pointing *up* at what
 * it came from:
 *
 *   requirement --derived_from--> spec
 *   decision    --implements-->   requirement
 *   component   --implements-->   decision
 *
 * Two reasons, and the second is the load-bearing one. A requirement is written
 * after its spec and a component after the decision that shaped it, so the
 * upstream entity is the one that already exists and the downstream one carries
 * the reference — authoring in the other direction means editing a finished
 * document every time something new points at it. And a spec that had to list
 * its requirements would make adding a requirement a write to two files, which
 * is two chances for the pair to disagree.
 *
 * `derived_from` for the first hop and `implements` for the next two is a
 * distinction worth keeping: a requirement *restates* its spec in narrower
 * terms, while a decision and a component *realize* what they point at.
 * `refines` was the alternative for hop one and is rejected because §8.4 leaves
 * it for narrowing within one kind — a requirement refining a requirement.
 *
 * ## The last two hops leave the wiki
 *
 * `component → implementation` is grounding: the entity's `groundsTo` node ids,
 * already indexed, already the join §5.1 is built on. `implementation → test`
 * is a code-graph question — nodes in test files that call the node — and needs
 * no new relation type, no `test` entity type, and no extraction work, because
 * test files are indexed as ordinary source and the `calls` edges are already
 * there.
 */

import type { WikiRelationType } from "./relation.js";
import type { WikiEntityType } from "./entity.js";

/** One entity-to-entity hop in the chain. */
export interface SddHop {
  /** The downstream entity type — the one that carries the relation. */
  from: WikiEntityType;
  /** The upstream entity type it points at. */
  to: WikiEntityType;
  /** The relation type that carries this hop, authored on `from`. */
  relation: WikiRelationType;
}

/**
 * The three entity-to-entity hops, in chain order.
 *
 * Read downstream-to-upstream, which is the direction they are authored in.
 * Walking the chain forwards (`spec` to `component`) follows these backwards,
 * through backlinks; walking it in reverse follows them as written.
 */
export const SDD_CHAIN: readonly SddHop[] = [
  { from: "requirement", to: "spec", relation: "derived_from" },
  { from: "decision", to: "requirement", relation: "implements" },
  { from: "component", to: "decision", relation: "implements" },
];

/** The entity types the chain passes through, upstream first. */
export const SDD_CHAIN_TYPES: readonly WikiEntityType[] = ["spec", "requirement", "decision", "component"];

/**
 * Where an acceptance criterion attaches.
 *
 * §8.2 has the type and §17's chain does not mention it, which is the question
 * the spec leaves open. It hangs off whatever it tests — a requirement, most
 * often — pointing up with `verified_by`'s inverse sense: the criterion is the
 * verifier, so the entity it verifies is the target and the criterion is the
 * source, matching every other hop's "downstream carries the reference".
 *
 * Kept separate from `SDD_CHAIN` because it is a decoration on a node of the
 * chain rather than a link in it. Folding it in would make the chain
 * six-then-sometimes-seven hops and every traversal would need a special case.
 */
export const ACCEPTANCE_CRITERION_RELATION: WikiRelationType = "verified_by";

/**
 * Where a constraint attaches.
 *
 * The direction trap the type name sets: `constrained_by` reads passive, so the
 * *constrained* entity is the source and the constraint is the target. A
 * constraint entity therefore does not point at what it constrains; the things
 * it binds point at it. That matches the authoring story — a constraint is
 * written once and referenced by many — and it is the reading that makes
 * `A --constrained_by--> B` say "A is constrained by B" when read aloud.
 */
export const CONSTRAINT_RELATION: WikiRelationType = "constrained_by";

/**
 * How a path is recognised as holding tests.
 *
 * **This is a heuristic and is named as one.** It is convention-matching, not a
 * fact the code graph records: nothing in a parsed AST says "this file is a
 * test", and the four conventions below are what the JavaScript and TypeScript
 * ecosystem settled on rather than anything mex can verify. A repository that
 * names its tests some other way gets an empty last hop, which is why the
 * predicate is configurable rather than baked into the queries that use it.
 *
 * Kept in one place for the reason `groundingKeyPath` is: the second copy of a
 * convention is where the correction gets forgotten.
 */
export const DEFAULT_TEST_PATH_PATTERNS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "test/**",
  "tests/**",
];

/**
 * True when this path looks like a test file.
 *
 * Deliberately not glob-matched: these five conventions are simple enough to
 * check directly, and the index's glob matcher is for user-supplied patterns
 * where the expressiveness is the point. Paths are compared in POSIX form, so a
 * Windows caller gets the same answer as a Linux one.
 */
export function isTestPath(path: string): boolean {
  const posix = path.replace(/\\/g, "/");
  if (/(^|\/)__tests__\//.test(posix)) return true;
  if (/^tests?\//.test(posix)) return true;
  if (/(^|\/)tests?\//.test(posix)) return true;
  return /\.(test|spec)\.[^/]+$/.test(posix);
}

/**
 * The call depth `implementation → test` searches.
 *
 * One. A test that reaches the symbol through three layers of indirection does
 * not appear, and that is stated rather than mitigated: widening the depth
 * turns "the tests for this" into "everything transitively reachable from any
 * test", which on any real repository is most of it. A direct call is evidence;
 * a transitive path is a guess about intent, and §17's panel is meant to answer
 * "what covers this" rather than "what might touch this".
 */
export const TEST_CALL_DEPTH = 1;

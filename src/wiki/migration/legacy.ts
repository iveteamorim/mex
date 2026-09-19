/**
 * Section 13.4 — the legacy fields, and which of them migration may translate.
 *
 * ## `edges` is live infrastructure, so conversion is additive
 *
 * The natural reading of "translate unambiguous `edges` to `related_to`" is
 * that converted edges are removed. That reading breaks shipped behaviour:
 * `src/drift/checkers/edges.ts` validates every frontmatter edge and reports
 * broken targets, `src/drift/checkers/stale-pattern.ts` calls them "mex's
 * canonical navigation" and walks them to decide whether a pattern is
 * reachable, and `src/setup/prompts.ts` instructs agents to write and maintain
 * them. Deleting them empties a shipped navigation graph and silences a shipped
 * drift check, in exchange for a relation the wiki gets anyway.
 *
 * **So the root `edges` key stays exactly as it was**, and the entity gains a
 * `related_to`. The spec never says delete; it says translate and retain. It
 * also keeps migration insertion-only for this case, which is a good sign it is
 * the right reading.
 *
 * ## What "unambiguous" means on each side, and why they differ
 *
 * An edge has two ends and they ask different questions.
 *
 * - **Source.** The edge lives in a file's frontmatter, so it is the *file's*
 *   fact. It needs a file-level entity to belong to. A file that yields only
 *   block entities has no entity the edge is about, and picking one would be
 *   the guess section 13.1 forbids.
 * - **Target.** The edge says "open that file". A target file resolves when it
 *   has a file-level entity — the file-level entity *is* the document — or when
 *   it yields exactly one entity of any kind.
 *
 * A **grounding** is stricter than either, and deliberately: it is a claim that
 * *this prose* is implemented by *that code*. Attributing a file's grounding to
 * a file-level entity that has four component children claims the grounding
 * describes the parent rather than one of the children, which is precisely the
 * guess section 9.4 refuses. So a root `grounds_to` moves only when the file
 * yields **exactly one** entity in total, matching the codec's own rule and the
 * two shipped fixtures that pin it.
 */
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import type { WikiGrounding } from "../model/grounding.js";
import type { LegacyEdge } from "../markdown/contract.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import type { InventoryFile, ScaffoldInventory } from "./inventory.js";
import type { Candidate, FileClassification } from "./classify.js";

/** Frontmatter keys migration preserves untouched. Section 13.4's first bullet. */
export const PRESERVED_LEGACY_KEYS = ["name", "description", "triggers", "last_updated", "edges"] as const;

/** What one file's entities look like once this run has adopted them. */
export interface FileOutcome {
  path: string;
  /** The file-level entity's id, when the file gets one. */
  fileEntity: EntityId | null;
  /** Every entity id the file will hold, adopted or already present. */
  entities: EntityId[];
}

/** An edge that became a relation. */
export interface ConvertedEdge {
  sourceFile: string;
  sourceEntity: EntityId;
  target: EntityId;
  targetFile: string;
  /** The edge's `condition`, which becomes the relation's `note`. */
  note?: string;
  /** Index within the file's `edges` array, so the opId is stable. */
  index: number;
}

export interface LegacyPlan {
  converted: ConvertedEdge[];
  diagnostics: WikiDiagnostic[];
}

/** Resolve one edge target to a single entity, or say why it cannot. */
export function resolveEdgeTarget(outcomes: Map<string, FileOutcome>, target: string): EntityId | null {
  const outcome = outcomes.get(normalizeTarget(target));
  if (outcome === undefined) return null;
  if (outcome.fileEntity !== null) return outcome.fileEntity;
  return outcome.entities.length === 1 ? (outcome.entities[0] ?? null) : null;
}

/** Edge targets are written scaffold-relative, sometimes with a leading `./`. */
function normalizeTarget(target: string): string {
  return target.replace(/^\.\//, "").replace(/\\/g, "/").trim();
}

/**
 * Which edges convert, and which are reported.
 *
 * Runs over the **whole** scaffold's outcomes, never one file's, because an
 * edge's target is another file: finding 29's blast radius applied to a
 * migration that mints ids and converts references in the same run. Every id
 * has to exist before any edge is resolved, so this is a second pass by
 * construction rather than by discipline.
 */
export function planLegacyEdges(
  inventory: ScaffoldInventory,
  outcomes: Map<string, FileOutcome>,
): LegacyPlan {
  const converted: ConvertedEdge[] = [];
  const diagnostics: WikiDiagnostic[] = [];

  for (const file of inventory.files) {
    const edges = file.parsed.legacy.edges;
    if (edges.length === 0) continue;

    const outcome = outcomes.get(file.path);
    const source = outcome?.fileEntity ?? null;
    if (source === null) {
      diagnostics.push(
        diagnostic(
          "AMBIGUOUS_MIGRATION",
          `${file.path} carries ${edges.length} legacy edge(s) but has no file-level entity to own them. ` +
            "The edges are navigation for the file as a whole; attributing them to one of its sections " +
            "would be a guess. They are preserved as they are.",
          { file: file.path },
        ),
      );
      continue;
    }
    const existingRelations = file.parsed.entities.find((entry) => entry.entity.id === source)?.entity.relations ?? [];

    edges.forEach((edge, index) => {
      const target = resolveEdgeTarget(outcomes, edge.target);
      if (target === null) {
        diagnostics.push(
          diagnostic(
            "AMBIGUOUS_MIGRATION",
            `${file.path}: the edge to ${edge.target} does not resolve to exactly one entity. ` +
              "The edge is preserved and no relation was written.",
            { file: file.path, entityId: source },
          ),
        );
        return;
      }
      if (target === source) return;
      // An operation-id replay is not the only way this conversion can already
      // be settled: a human or agent may have authored the same canonical pair.
      // Relation identity is type + target, so preserve its existing note and
      // metadata rather than retrying under migration's different operation id.
      if (existingRelations.some((relation) => relation.type === "related_to" && relation.target === target)) return;
      converted.push({
        sourceFile: file.path,
        sourceEntity: source,
        target,
        targetFile: normalizeTarget(edge.target),
        ...(edge.condition === undefined ? {} : { note: edge.condition }),
        index,
      });
    });
  }

  return { converted, diagnostics };
}

export interface GroundingPlan {
  /** Groundings to move under `mex.grounds_to`, keyed by file. */
  moved: Map<string, WikiGrounding[]>;
  diagnostics: WikiDiagnostic[];
}

/**
 * Decide, per file, whether a root `grounds_to` may move.
 *
 * `backfill` upgrades each entry with a `bodyHash` re-derived from the live
 * graph where the node still resolves (finding 39), and leaves it **absent**
 * where it does not, rather than fabricating one — a wrong body hash is what
 * every future drift verdict is measured against, so an invented one poisons
 * resolution permanently.
 *
 * These groundings are not minted, they are relocated: the pair was already in
 * the scaffold, written by a previous `mex ground`. So section 12.4's
 * re-derivation requirement, which governs *new* groundings, is not what
 * applies here; moving a fact is not asserting a new one.
 */
export function planGroundingMoves(
  inventory: ScaffoldInventory,
  classifications: Map<string, FileClassification>,
  candidatesFor: (path: string) => Candidate[],
  graph: GroundingGraph | null,
): GroundingPlan {
  const moved = new Map<string, WikiGrounding[]>();
  const diagnostics: WikiDiagnostic[] = [];

  for (const file of inventory.files) {
    const groundings = file.parsed.legacy.groundsTo;
    if (groundings.length === 0) continue;

    const candidates = candidatesFor(file.path);
    const existing = file.parsed.entities.length;
    const total = candidates.length + existing;
    const fileLevel = candidates.find((candidate) => candidate.target.at === "file");

    if (total !== 1 || fileLevel === undefined) {
      diagnostics.push(
        diagnostic(
          "AMBIGUOUS_MIGRATION",
          `${file.path} carries a root \`grounds_to\` and yields ${total} entities. A grounding claims that ` +
            "particular prose is implemented by particular code, and nothing here says which section it " +
            "describes. It is preserved at the root and left unattributed.",
          { file: file.path },
        ),
      );
      continue;
    }

    moved.set(file.path, groundings.map((grounding) => backfill(grounding, graph)));
    void classifications;
  }

  return { moved, diagnostics };
}

/** Add a `bodyHash` the graph can re-derive; never invent one. */
export function backfill(grounding: WikiGrounding, graph: GroundingGraph | null): WikiGrounding {
  if (grounding.bodyHash !== undefined || graph === null) return grounding;
  const node = graph.getNode(grounding.node);
  if (node === null || node.bodyHash === null) return grounding;
  return { ...grounding, bodyHash: node.bodyHash };
}

/** Every legacy key a file carries that migration neither converts nor preserves by name. */
export function unrecognizedKeys(file: InventoryFile): string[] {
  const frontmatter = file.parsed.frontmatter;
  if (frontmatter === null) return [];
  const known = new Set<string>([...PRESERVED_LEGACY_KEYS, "grounds_to", "mex"]);
  return frontmatter.keys.filter((key) => !known.has(key));
}

/**
 * §12.3 step 5 — valid candidates become operation plans.
 *
 * **The seam of the whole phase.** Everything upstream of this file is pure and
 * knows nothing about Markdown; everything downstream is P5's pipeline, which
 * was built and tested three phases ago. Synthesis owns *classification and
 * proposal*; it owns no bytes. Nothing here writes a file, opens a database or
 * constructs a patch — it emits envelopes, and `wikiApplyOperation` decides
 * whether they are planned or applied.
 *
 * ## Where a proposed entity goes, and why it is not a new folder
 *
 * A cluster is named after a *source* folder — `auth`, `billing` — and the
 * obvious move is to write `synthesis/auth.md`. It is the wrong move. The
 * scaffold already has a layout its own tools key on: `mex pattern add` writes
 * `patterns/<slug>.md`, `mex setup` writes `context/<name>.md`, P6's classifier
 * reads a file's role off exactly those paths, and P9's generated-view rule
 * does the same. Knowledge filed by *type* is how a person navigates a wiki;
 * knowledge filed by source folder is a second copy of the directory tree the
 * code graph already provides.
 *
 * So an architecture or component unit becomes a section of
 * `context/architecture.md`, a convention becomes a section of
 * `context/conventions.md`, and a pattern becomes its own
 * `patterns/<file>.md` — the same three shapes migration produces, which means
 * a synthesized scaffold and a migrated one are the same scaffold.
 *
 * ## Two gates, and this file owns the second
 *
 * `candidates.ts` checks that a node id was in the context the agent was given.
 * That is cheap and produces a good message. It is not §12.4. Here every id is
 * handed to `deriveGrounding`, which takes an id and mints from the live graph
 * — so there is no caller-supplied fingerprint to compare against and nothing
 * to launder. A node the graph cannot produce yields no grounding and the unit
 * is dropped rather than written unverified.
 */

import { createHash } from "node:crypto";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { WikiEntityType } from "../model/entity.js";
import type { CreateEntryPayload, WikiActor } from "../model/operation.js";
import type { WikiGrounding } from "../model/grounding.js";
import { deriveGrounding, type GroundingGraph } from "../grounding/adapter.js";
import { isReadOnlyPath } from "../operations/paths.js";
import type { AcceptedUnit, RejectedUnit } from "./candidates.js";

/**
 * Where each proposed type is filed, and at what depth.
 *
 * `headingDepth` absent means a file-level entity — one entity that *is* the
 * document, which is what a pattern file has been since the scaffold shipped.
 */
interface Placement {
  /** Fixed destination, or null when the file is derived from the unit. */
  file: string | null;
  headingDepth?: number;
}

const PLACEMENT: Record<string, Placement> = {
  architecture: { file: "context/architecture.md", headingDepth: 2 },
  component: { file: "context/architecture.md", headingDepth: 2 },
  convention: { file: "context/conventions.md", headingDepth: 2 },
  pattern: { file: null },
};

/** The entity types synthesis knows how to file. */
export const PLACEABLE_TYPES = Object.keys(PLACEMENT) as readonly WikiEntityType[];

/**
 * A filename fragment from free text.
 *
 * Deterministic and lossy on purpose: two titles that differ only in
 * punctuation produce one slug and therefore one collision, which is reported.
 * Silently distinguishing them would put two near-identical pattern files in a
 * repository and leave the duplicate for a reader to find.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    // Drop the combining marks NFKD just separated out. Without this an
    // accented title decomposes into a letter plus a mark, the mark is not
    // `[a-z0-9]`, and an accented word becomes three hyphenated fragments — a
    // mangled filename produced by the step meant to normalize it.
    //
    // The Unicode property escape rather than a numeric range, deliberately:
    // a range is written as two escapes, and an escape written by anything but
    // a plain editor is how a literal byte ends up in a source file. This one
    // is ASCII throughout and covers every mark rather than one block of them.
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "unnamed" : slug;
}

/**
 * The file a unit is proposed into.
 *
 * A pattern's path carries the cluster as well as the title, so two clusters
 * that each have a "Repository with an explicit transaction boundary" get two
 * files rather than a collision — they are genuinely two claims, about two
 * different pieces of code, and the global pass is what decides whether they
 * should become one.
 */
export function fileForUnit(unit: AcceptedUnit): string | null {
  const placement = PLACEMENT[unit.type];
  if (placement === undefined) return null;
  if (placement.file !== null) return placement.file;
  return `patterns/${slugify(unit.cluster)}-${slugify(unit.title)}.md`;
}

/** What the caller needs beyond the units themselves. */
export interface ProposeOptions {
  /** The live code graph. Null refuses every grounding, and so every unit. */
  graph: GroundingGraph | null;
  /** `wiki.readOnly` globs, checked before an operation is built. */
  readOnly?: readonly string[];
  /** Recorded in the audit log as the proposer. */
  actor?: WikiActor;
  /** Injected so a test can pin the envelope. */
  now?: () => string;
}

export interface ProposedOperation {
  opId: string;
  /** The scaffold-relative file the operation writes into. */
  file: string;
  /** The unit this came from, for a report a human reads. */
  unit: AcceptedUnit;
  envelope: Record<string, unknown>;
}

export interface ProposeResult {
  operations: ProposedOperation[];
  /** Units dropped here rather than by the candidate gate, with reasons. */
  rejected: RejectedUnit[];
  diagnostics: WikiDiagnostic[];
}

const DEFAULT_ACTOR: WikiActor = { kind: "agent", id: "synthesis" };

/**
 * A deterministic operation id, derived from what the operation proposes.
 *
 * P5 keys replay on `opId` and treats the same id carrying a different payload
 * as a validation failure. Deriving the id *from* the payload makes that state
 * unreachable rather than merely unlikely: an identical proposal replays as a
 * no-op, and a reworded one is a different operation that creates a second
 * entity — which is the case the global pass exists to consolidate. The
 * alternative, keying on title and cluster, turns an ordinary re-run with an
 * improved summary into a refusal whose message explains none of that.
 */
function opIdFor(payload: CreateEntryPayload): string {
  return `syn_${createHash("sha256").update(canonical(payload), "utf8").digest("hex").slice(0, 40)}`;
}

/** Canonical JSON: keys sorted, `undefined` dropped. Stable across callers. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

/**
 * Turn accepted units into `create-entry` envelopes.
 *
 * Order is the order the units arrived in, which is the agent's order, which is
 * deterministic given the same response. Two units filed into one document are
 * both appended; P5 re-plans each operation against the file as it stands, so
 * the second sees the first.
 */
export function proposeUnits(units: readonly AcceptedUnit[], options: ProposeOptions): ProposeResult {
  const operations: ProposedOperation[] = [];
  const rejected: RejectedUnit[] = [];
  const diagnostics: WikiDiagnostic[] = [];
  const readOnly = options.readOnly ?? [];
  const actor = options.actor ?? DEFAULT_ACTOR;
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  const claimedFiles = new Map<string, string>();

  for (const unit of units) {
    const file = fileForUnit(unit);
    if (file === null) {
      rejected.push({
        unit,
        reasons: [`no filing rule for entity type "${unit.type}"; synthesis files ${PLACEABLE_TYPES.join(", ")}`],
      });
      continue;
    }

    // Checked here as well as in `plan.ts`, which is where it is enforced
    // (finding 41). Not a second enforcement point — a naive filing rule would
    // otherwise turn into a pile of refused operations with no explanation of
    // what a user could do about it, and the answer ("this type is filed into a
    // reserved path") is one only this layer knows.
    if (isReadOnlyPath(file, readOnly)) {
      rejected.push({
        unit,
        reasons: [`${file} is reserved read-only from Wiki writes, so a ${unit.type} cannot be filed there`],
      });
      continue;
    }

    const placement = PLACEMENT[unit.type]!;
    if (placement.file === null) {
      const claimant = claimedFiles.get(file);
      if (claimant !== undefined) {
        rejected.push({
          unit,
          reasons: [`"${unit.title}" would be filed at ${file}, which "${claimant}" already claims in this batch`],
        });
        continue;
      }
      claimedFiles.set(file, unit.title);
    }

    const groundings: WikiGrounding[] = [];
    const unverified: string[] = [];
    for (const nodeId of unit.grounding.nodeIds) {
      // §12.4, and the reason this takes an id rather than a pair: there is
      // nothing for a caller to supply and therefore nothing to launder.
      const derived = options.graph === null ? null : deriveGrounding(options.graph, nodeId);
      if (derived === null) unverified.push(nodeId);
      else groundings.push({ ...derived });
    }

    if (unverified.length > 0) {
      const reason =
        options.graph === null
          ? "no code graph is available, and a grounding may not be written unverified"
          : `the code graph cannot produce ${unverified.join(", ")} — it may have moved since the context was rendered`;
      rejected.push({ unit, reasons: [reason] });
      // A diagnostic as well as a rejection: this is the one gate §12.4 makes
      // a product invariant, and a run that silently proposed less than it was
      // given is exactly what the invariant exists to make visible.
      diagnostics.push(
        diagnostic("GROUNDING_UNVERIFIED", `"${unit.title}" was dropped: ${reason}.`, { file }),
      );
      continue;
    }

    const payload: CreateEntryPayload = {
      file,
      insertAt: { at: "end-of-file" },
      type: unit.type as WikiEntityType,
      title: unit.title,
      body: unit.body,
      summary: unit.summary,
      status: unit.status,
      groundsTo: groundings,
      metadata: {
        // The number that chose the lifecycle state, kept beside the state it
        // chose. A confidence that gated a write and then vanished is a
        // decision nobody can audit afterwards.
        synthesis: { confidence: unit.confidence, stage: unit.stage, cluster: unit.cluster },
      },
      ...(placement.headingDepth === undefined ? {} : { headingDepth: placement.headingDepth }),
    };

    operations.push({
      opId: opIdFor(payload),
      file,
      unit,
      envelope: { opId: opIdFor(payload), type: "create-entry", actor, timestamp, payload },
    });
  }

  return { operations, rejected, diagnostics };
}

/**
 * §12.3 steps 3 and 4 — what the agent returns, and the gate it must clear.
 *
 * This is the boundary between untrusted model output and mex's canonical
 * model, and it is the reason §12.1's "Zod boundary validation" is satisfied
 * without Zod: D4's combinators produce `WikiDiagnostic`s carrying codes,
 * severities and structural paths, where a schema library produces issues that
 * would then have to be reformatted into exactly that shape. `units[2].grounding.nodeIds[0]`
 * is a better thing for an agent to be told than "expected string".
 *
 * ## The two things this file decides
 *
 * **Confidence proposes; it never promotes.** At or above 0.7 a unit is
 * proposed with lifecycle `promoted`, at or above 0.4 with `in_flight`, and
 * below that it is rejected. *Proposed* is the operative word: every accepted
 * unit still becomes an operation plan that a human reviews and applies.
 * §12.3's final clause exists because the opposite is tempting, and nothing in
 * this pipeline may write on the strength of a number the model chose for
 * itself.
 *
 * **The thresholds are not configurable.** `wiki.synthesis` can widen what mex
 * *looks at* — how many files make a cluster, how large a context may be, how
 * many candidate pairs to propose — and can change nothing about what mex
 * *accepts*. A knob that lowers the bar for writing into a user's files is a
 * knob whose only use is lowering it, and the number would then differ between
 * two checkouts of the same repository with no record of why.
 *
 * There is a second, stronger grounding gate downstream: the ids that survive
 * here are only checked against the context they were given, and §12.4 requires
 * them to be re-derived from the live graph before anything is written. That is
 * `propose.ts`. The check here is a cheap filter that produces a far better
 * message — "you named a node that was not in your context" is actionable in a
 * way that "grounding unverified" is not.
 */

import { type WikiDiagnostic } from "../model/diagnostic.js";
import type { WikiLifecycleState } from "../model/entity.js";
import {
  optional,
  refine,
  rootContext,
  validateArray,
  validateNumber,
  validateShape,
  validateString,
  type ValidationContext,
  type Validator,
  contextDiagnostic,
  indexContext,
} from "../model/validate.js";
import { STAGE_TYPES, type SynthesisStage } from "./prompts.js";
import type { ClusterContext } from "./types.js";

/**
 * The confidence gates, §12.3 and the implementation plan's P8 entry.
 *
 * Exported so a test can assert the numbers rather than restate them, and so a
 * reader can find them in one place. Not exported to configuration.
 */
export const CONFIDENCE_PROMOTED = 0.7;
export const CONFIDENCE_IN_FLIGHT = 0.4;

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const SUMMARY_MIN = 10;
const SUMMARY_MAX = 500;
const BODY_MIN = 20;

/** One piece of evidence the agent may attach to a grounding. */
export interface CandidateEvidence {
  nodeId: string;
  quote?: string;
  reason?: string;
}

/** A candidate unit, after shape validation and before the gates. */
export interface CandidateUnit {
  type: string;
  title: string;
  summary: string;
  body: string;
  confidence: number;
  grounding: { nodeIds: string[]; evidence?: CandidateEvidence[] };
}

/** A candidate that cleared every gate, with the lifecycle its confidence proposes. */
export interface AcceptedUnit extends CandidateUnit {
  /** Proposed, never applied. A human still reviews the operation this becomes. */
  status: WikiLifecycleState;
  stage: SynthesisStage;
  cluster: string;
}

/** A candidate that did not clear a gate, with every reason it failed. */
export interface RejectedUnit {
  /** The raw value as the agent sent it, so a user can see what was refused. */
  unit: unknown;
  reasons: string[];
}

export interface ValidateUnitsResult {
  accepted: AcceptedUnit[];
  rejected: RejectedUnit[];
}

function lengthCheck(
  label: string,
  min: number,
  max: number | undefined,
): (value: string, context: ValidationContext) => WikiDiagnostic[] {
  return (value, context) => {
    const length = value.trim().length;
    if (length < min) {
      return [
        contextDiagnostic(context, "INVALID_FIELD_TYPE", `${label} must be at least ${min} characters; got ${length}.`),
      ];
    }
    if (max !== undefined && length > max) {
      return [
        contextDiagnostic(context, "INVALID_FIELD_TYPE", `${label} must be at most ${max} characters; got ${length}.`),
      ];
    }
    return [];
  };
}

const evidenceValidator: Validator<CandidateEvidence> = validateShape<CandidateEvidence>({
  nodeId: validateString(),
  quote: optional(validateString({ allowEmpty: true })),
  reason: optional(validateString({ allowEmpty: true })),
});

const groundingValidator: Validator<CandidateUnit["grounding"]> = validateShape<CandidateUnit["grounding"]>({
  nodeIds: refine(validateArray(validateString()), (value, context) =>
    value.length === 0
      ? [
          contextDiagnostic(
            context,
            "MISSING_REQUIRED_FIELD",
            "A candidate must be grounded in at least one code-graph node id.",
          ),
        ]
      : [],
  ),
  evidence: optional(validateArray(evidenceValidator)),
});

/**
 * The candidate shape.
 *
 * `reasoning` is deliberately absent: the prompts invite the agent to include
 * it as scratch space, and `validateShape` keeps only the keys it is given, so
 * it is dropped here rather than carried into an entity. A model's working-out
 * is not knowledge and does not belong in someone's repository.
 */
const candidateValidator: Validator<CandidateUnit> = validateShape<CandidateUnit>({
  type: validateString(),
  title: refine(validateString(), lengthCheck("title", TITLE_MIN, TITLE_MAX)),
  summary: refine(validateString(), lengthCheck("summary", SUMMARY_MIN, SUMMARY_MAX)),
  body: refine(validateString(), lengthCheck("body", BODY_MIN, undefined)),
  confidence: validateNumber({ min: 0, max: 1 }),
  grounding: groundingValidator,
});

/** Every node id a cluster context legitimately offers. */
export function contextNodeIds(context: ClusterContext): Set<string> {
  const ids = new Set<string>(context.cluster.nodeIds);
  for (const node of context.nodes) ids.add(node.id);
  for (const block of context.codeBlocks) {
    if (block.nodeId !== undefined) ids.add(block.nodeId);
  }
  return ids;
}

/** The lifecycle a confidence proposes, or null when it clears no gate. */
export function statusForConfidence(confidence: number): WikiLifecycleState | null {
  if (confidence >= CONFIDENCE_PROMOTED) return "promoted";
  if (confidence >= CONFIDENCE_IN_FLIGHT) return "in_flight";
  return null;
}

export interface ValidateUnitsOptions {
  stage: SynthesisStage;
  /** The context the units must be grounded in. */
  context: ClusterContext;
}

/**
 * Validate a batch of raw candidates: shape, stage vocabulary, grounding, confidence.
 *
 * Pure. Every rejection carries every reason it failed rather than the first,
 * so an agent re-running a stage fixes one unit once instead of three times.
 */
export function validateCandidateUnits(
  rawUnits: readonly unknown[],
  options: ValidateUnitsOptions,
): ValidateUnitsResult {
  const allowedTypes = new Set(STAGE_TYPES[options.stage]);
  const validNodeIds = contextNodeIds(options.context);
  const accepted: AcceptedUnit[] = [];
  const rejected: RejectedUnit[] = [];
  const root = rootContext();

  for (let index = 0; index < rawUnits.length; index += 1) {
    const raw = rawUnits[index];
    const parsed = candidateValidator(raw, indexContext({ ...root, path: "units" }, index));
    if (!parsed.ok) {
      rejected.push({ unit: raw, reasons: parsed.diagnostics.map(formatDiagnostic) });
      continue;
    }

    const unit = parsed.value;
    const reasons: string[] = [];

    if (!allowedTypes.has(unit.type)) {
      reasons.push(
        `type "${unit.type}" is not allowed for stage "${options.stage}" (allowed: ${[...allowedTypes].join(", ")})`,
      );
    }

    const missing = unit.grounding.nodeIds.filter((nodeId) => !validNodeIds.has(nodeId));
    if (missing.length > 0) {
      reasons.push(`grounding names node ids that were not in the cluster context: ${missing.join(", ")}`);
    }

    const status = statusForConfidence(unit.confidence);
    if (status === null) {
      reasons.push(
        `confidence ${unit.confidence} is below the ${CONFIDENCE_IN_FLIGHT} floor, so the unit is not proposed`,
      );
    }

    if (reasons.length > 0 || status === null) {
      rejected.push({ unit: raw, reasons });
      continue;
    }

    accepted.push({ ...unit, status, stage: options.stage, cluster: options.context.cluster.name });
  }

  return { accepted, rejected };
}

function formatDiagnostic(entry: WikiDiagnostic): string {
  return entry.path === undefined ? entry.message : `${entry.path}: ${entry.message}`;
}

/**
 * Strip the Markdown fence models habitually wrap JSON in.
 *
 * Not tolerance for its own sake: the prompt says "no fences", the model adds
 * one anyway perhaps one time in ten, and the alternative is a user staring at
 * a parse error over output that was otherwise perfect.
 */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^`{3,}(?:json|jsonc)?\s*\n([\s\S]*?)\n`{3,}$/i.exec(trimmed);
  return fence?.[1] ?? trimmed;
}

/**
 * Pull the array out of an agent response.
 *
 * Three shapes are accepted — `{ [key]: [...] }`, a bare array, and either of
 * those as a JSON string — because all three are what agents actually send.
 * Anything else yields null, which the caller turns into a diagnostic rather
 * than into an empty batch: "you sent nothing valid" and "you validly sent
 * nothing" must not look the same, or a broken response reads as a clean run
 * that proposed nothing.
 */
export function extractArray(response: unknown, key: string): unknown[] | null {
  let value = response;
  if (typeof value === "string") {
    try {
      value = JSON.parse(stripCodeFences(value)) as unknown;
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return null;
}

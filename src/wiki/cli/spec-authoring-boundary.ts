import { realpathSync } from "node:fs";
import { MexPortError } from "../../team/contracts/shared.js";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import {
  attestEntityClaimantsBatch,
  createParseCache,
} from "../operations/locate.js";
import { checkContainment, toScaffoldRelative } from "../operations/paths.js";

const SPEC_KINDS = new Set([
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
]);
const OPERATION_TYPES = new Set([
  "create-entry",
  "update-entry",
  "set-property",
  "add-relation",
  "remove-relation",
  "add-source",
  "remove-source",
  "set-grounding",
  "supersede-entry",
  "move-entry",
  "archive-entry",
]);
const MAX_GUARD_DEPTH = 32;
const MAX_GUARD_NODES = 4_096;
const MAX_GUARD_ENTITY_IDS = 128;

export interface DirectWikiSpecBoundaryOptions {
  scaffoldRoot: string;
  exclude?: readonly string[];
}

interface CandidateOperation {
  value: Readonly<Record<string, unknown>>;
  payload: Readonly<Record<string, unknown>>;
}

/**
 * Product-only compatibility guard for `mex wiki apply|propose`.
 *
 * The engine stays capable of administrative Wiki operations. Only the root
 * product CLI installs this classifier, so the governed Inbox facade remains
 * the one ordinary path that can create or update the four Spec-family kinds.
 */
export function inspectDirectWikiSpecMutation(
  value: unknown,
  options: DirectWikiSpecBoundaryOptions,
): readonly WikiDiagnostic[] {
  let operations: readonly CandidateOperation[];
  try {
    operations = collectOperations(value);
  } catch {
    return [refusal("The direct Wiki operation is too structurally complex to prove outside governed Spec authoring.")];
  }
  if (operations.length === 0) return [];

  const referencedIds = new Set<string>();
  for (const operation of operations) collectReferencedIds(operation, referencedIds);
  if (referencedIds.size > MAX_GUARD_ENTITY_IDS) {
    return [refusal("The direct Wiki operation names too many entities to prove outside governed Spec authoring.")];
  }

  let kinds = new Map<string, string>();
  let paths = new Map<string, string>();
  if (referencedIds.size > 0) {
    try {
      const attestations = attestEntityClaimantsBatch([...referencedIds].sort(), {
        scaffoldRoot: options.scaffoldRoot,
        parseCache: createParseCache(),
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      });
      kinds = new Map([...attestations].flatMap(([id, claimant]) => (
        claimant.winner === null ? [] : [[id, claimant.winner.entity.type] as const]
      )));
      paths = new Map([...attestations].flatMap(([id, claimant]) => (
        claimant.winner === null ? [] : [[id, claimant.winner.path] as const]
      )));
    } catch {
      return [refusal("MEX could not prove the complete current Wiki target set is outside governed Spec authoring.")];
    }
  }

  for (const operation of operations) {
    if (operationTouchesSpec(operation, kinds, paths, options)) {
      return [refusal(
        "Direct Wiki Spec mutation is disabled. Save an Inbox draft, publish it, preview the proposal, and approve the exact Spec write.",
      )];
    }
  }
  return [];
}

/** Contract-friendly assertion used by the E2 real bypass conformance. */
export function assertNoDirectWikiSpecMutation(
  value: unknown,
  options: DirectWikiSpecBoundaryOptions,
): void {
  if (inspectDirectWikiSpecMutation(value, options).length === 0) return;
  throw new MexPortError({
    title: "Direct Wiki Spec mutation refused",
    status: 400,
    code: "VALIDATION_FAILED",
    detail: "Spec-family authoring is governed by the Inbox proposal lifecycle.",
  });
}

function collectOperations(value: unknown): readonly CandidateOperation[] {
  const operations: CandidateOperation[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number, insideOperations: boolean): void => {
    nodes += 1;
    if (nodes > MAX_GUARD_NODES || depth > MAX_GUARD_DEPTH) throw new Error("guard bound");
    if (candidate === null || typeof candidate !== "object") return;
    if (seen.has(candidate)) throw new Error("cyclic guard input");
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child, depth + 1, insideOperations);
      return;
    }

    const record = candidate as Readonly<Record<string, unknown>>;
    if (typeof record.type === "string" && OPERATION_TYPES.has(record.type)) {
      operations.push({
        value: record,
        payload: isRecord(record.payload) ? record.payload : record,
      });
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "operations" && Array.isArray(child)) {
        for (const item of child) visit(item, depth + 1, true);
      } else if (key !== "operations") {
        visit(child, depth + 1, insideOperations);
      }
    }
  };

  visit(value, 0, false);
  return operations;
}

function collectReferencedIds(
  operation: CandidateOperation,
  result: Set<string>,
): void {
  addId(result, operation.value.entityId);
  const relation = isRecord(operation.payload.relation)
    ? operation.payload.relation
    : isRecord(operation.value.relation)
      ? operation.value.relation
      : null;
  if (relation !== null) {
    addRef(result, relation.source);
    addRef(result, relation.target);
  }
  addRef(result, operation.payload.target);
  if (Array.isArray(operation.payload.relations)) {
    for (const candidate of operation.payload.relations) {
      if (isRecord(candidate)) addRef(result, candidate.target);
    }
  }
  if (operation.value.type === "supersede-entry") {
    addId(result, operation.payload.replacementId);
    const replacement = isRecord(operation.payload.replacement)
      ? operation.payload.replacement
      : null;
    if (replacement !== null && Array.isArray(replacement.relations)) {
      for (const candidate of replacement.relations) {
        if (isRecord(candidate)) addRef(result, candidate.target);
      }
    }
  }
}

function operationTouchesSpec(
  operation: CandidateOperation,
  kinds: ReadonlyMap<string, string>,
  paths: ReadonlyMap<string, string>,
  options: DirectWikiSpecBoundaryOptions,
): boolean {
  const type = operation.value.type;
  const primaryId = stringValue(operation.value.entityId)
    ?? (type === "add-relation" ? relationEndpoint(operation, "source") : null);
  if (primaryId !== null && isSpecKind(kinds.get(primaryId))) return true;
  if (primaryId !== null && isSpecDestination(paths.get(primaryId), options)) return true;

  if (type === "create-entry") {
    if (isSpecKind(operation.payload.type)) return true;
    if (isSpecDestination(operation.payload.file, options)
      || isSpecDestination(operation.value.destinationPath, options)) return true;
  }
  if (type === "move-entry" && (
    isSpecDestination(operation.payload.file, options)
    || isSpecDestination(operation.value.destinationPath, options)
  )) return true;

  if (
    type === "set-property"
    && operation.payload.property === "type"
    && isSpecKind(operation.payload.value)
  ) return true;

  for (const endpoint of relationEndpoints(operation)) {
    if (isSpecKind(kinds.get(endpoint))) return true;
  }

  if (type === "supersede-entry") {
    const replacementId = stringValue(operation.payload.replacementId);
    if (replacementId !== null && isSpecKind(kinds.get(replacementId))) return true;
    if (replacementId !== null && isSpecDestination(paths.get(replacementId), options)) return true;
    const replacement = isRecord(operation.payload.replacement)
      ? operation.payload.replacement
      : null;
    if (replacement !== null && (
      isSpecKind(replacement.type)
      || isSpecDestination(replacement.file, options)
      || createPayloadHasSpecRelation(replacement, kinds)
    )) return true;
  }
  return false;
}

function relationEndpoints(operation: CandidateOperation): readonly string[] {
  const result = new Set<string>();
  const relation = isRecord(operation.payload.relation)
    ? operation.payload.relation
    : isRecord(operation.value.relation)
      ? operation.value.relation
      : null;
  if (relation !== null) {
    addRef(result, relation.source);
    addRef(result, relation.target);
  }
  addRef(result, operation.payload.target);
  if (Array.isArray(operation.payload.relations)) {
    for (const candidate of operation.payload.relations) {
      if (isRecord(candidate)) addRef(result, candidate.target);
    }
  }
  return [...result];
}

function createPayloadHasSpecRelation(
  payload: Readonly<Record<string, unknown>>,
  kinds: ReadonlyMap<string, string>,
): boolean {
  if (!Array.isArray(payload.relations)) return false;
  return payload.relations.some((candidate) => {
    if (!isRecord(candidate)) return false;
    const target = refId(candidate.target);
    return target !== null && isSpecKind(kinds.get(target));
  });
}

function relationEndpoint(
  operation: CandidateOperation,
  side: "source" | "target",
): string | null {
  const relation = isRecord(operation.payload.relation)
    ? operation.payload.relation
    : isRecord(operation.value.relation)
      ? operation.value.relation
      : null;
  return relation === null ? null : refId(relation[side]);
}

function addId(result: Set<string>, value: unknown): void {
  const id = stringValue(value);
  if (id !== null) result.add(id);
}

function addRef(result: Set<string>, value: unknown): void {
  const id = refId(value);
  if (id !== null) result.add(id);
}

function refId(value: unknown): string | null {
  return stringValue(value) ?? (isRecord(value) ? stringValue(value.id) : null);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isSpecKind(value: unknown): boolean {
  return typeof value === "string" && SPEC_KINDS.has(value);
}

function isSpecPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value === "specs"
    || value.startsWith("specs/")
    || value === ".mex/specs"
    || value.startsWith(".mex/specs/");
}

function isSpecDestination(
  value: unknown,
  options: DirectWikiSpecBoundaryOptions,
): boolean {
  if (isSpecPath(value)) return true;
  if (typeof value !== "string") return false;
  try {
    const target = checkContainment(options.scaffoldRoot, value);
    if (target.diagnostic !== null) return false;
    return isSpecPath(toScaffoldRelative(realpathSync(options.scaffoldRoot), target.resolved));
  } catch {
    // If the physical destination cannot be classified, direct product Wiki
    // mutation cannot prove that it stays outside governed Spec ownership.
    return true;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function refusal(message: string): WikiDiagnostic {
  return diagnostic("WRITE_SCOPE_VIOLATION", message, {
    remediation: "Use `mex inbox` for Spec-family authoring; keep direct Wiki administration outside .mex/specs/.",
  });
}

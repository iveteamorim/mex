/**
 * Engine-owned atomic operation batches.
 *
 * Planning walks ordered envelopes over one in-memory Markdown and ledger
 * overlay. Applying executes only those reviewed plans, under one writer lease,
 * after a whole-batch preflight. No operation is re-planned and no id is
 * re-minted at apply time.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import { createParseCache, locateEntity } from "./locate.js";
import { readOperationLogExact } from "./audit.js";
import { readContainedSource } from "../index/source-read.js";
import { planOperation, type PlanOptions, type WikiPatchPlan } from "./plan.js";
import { previewHashOf } from "./preview.js";
import {
  applyPlannedOperationSequence,
  type ApplyPlannedSequenceOptions,
  type ApplyPlannedSequenceResult,
} from "./apply.js";

export interface WikiOperationBatchPlan {
  readonly v: 1;
  readonly operations: readonly WikiPatchPlan[];
  readonly previewRevision: string;
}

export type PlanOperationBatchResult =
  | { readonly ok: true; readonly plan: WikiOperationBatchPlan; readonly diagnostics: readonly WikiDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly WikiDiagnostic[] };

export interface ApplyPlannedOperationBatchOptions
  extends Omit<ApplyPlannedSequenceOptions, "sequenceRevision" | "expectedSequenceRevision"> {
  readonly expectedPreviewRevision: string;
}

export interface ApplyPlannedOperationBatchResult extends ApplyPlannedSequenceResult {
  readonly previewRevision: string;
}

/** Plan every envelope or none of them, against one exact virtual overlay. */
export function planOperationBatch(
  envelopes: readonly unknown[],
  options: PlanOptions,
): PlanOperationBatchResult {
  if (envelopes.length === 0) return { ok: false, diagnostics: [] };
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const virtualFiles = new Map<string, string>();
  const exactAudit = readOperationLogExact(scaffoldRoot);
  let virtualAudit = exactAudit.text;
  let virtualAuditExists = exactAudit.exists;
  const parseCache = options.parseCache ?? createParseCache();
  const operations: WikiPatchPlan[] = [];
  const diagnostics: WikiDiagnostic[] = [];
  const virtuallyChangedEntities = new Set<string>();
  const read = options.readFile ?? ((path: string) => readContainedSource(scaffoldRoot, path));

  for (const envelope of envelopes) {
    const virtualOptions: PlanOptions = {
      ...options,
      scaffoldRoot,
      parseCache,
      readFile: (path) => virtualFiles.get(resolve(path)) ?? read(path),
      auditText: virtualAudit,
      auditExists: virtualAuditExists,
    };
    const raw = envelope !== null && typeof envelope === "object"
      ? envelope as Record<string, unknown>
      : null;
    const entityId = typeof raw?.["entityId"] === "string" ? raw["entityId"] : undefined;
    let prepared = envelope;
    if (entityId !== undefined && virtuallyChangedEntities.has(entityId)) {
      const current = locateEntity(entityId, virtualOptions);
      if (current !== null) {
        prepared = {
          ...raw,
          baseRevision: current.entity.revision,
          baseContentHash: current.entity.location.entityContentHash,
        };
      }
    }
    const planned = planOperation(prepared, virtualOptions);
    if (!planned.ok) return { ok: false, diagnostics: [...diagnostics, ...planned.diagnostics] };
    operations.push(planned.plan);
    diagnostics.push(...planned.diagnostics);
    for (const file of planned.plan.files) virtualFiles.set(resolve(file.absolutePath), file.proposedText);
    for (const id of [...planned.plan.entityIds, ...planned.plan.createdIds]) virtuallyChangedEntities.add(id);
    virtualAudit = planned.plan.audit.proposedText;
    virtualAuditExists = true;
  }

  const unsigned = { v: 1 as const, operations };
  const previewRevision = batchPreviewRevisionOf(unsigned);
  return { ok: true, plan: { ...unsigned, previewRevision }, diagnostics };
}

/** Recompute the ordered exact-plan digest; callers must not trust the field. */
export function batchPreviewRevisionOf(
  plan: Pick<WikiOperationBatchPlan, "v" | "operations">,
): string {
  const hash = createHash("sha256");
  hash.update(`wiki-operation-batch-v${plan.v}\u0000`, "utf8");
  for (const operation of plan.operations) hash.update(`${previewHashOf(operation)}\u0000`, "utf8");
  return hash.digest("hex");
}

/** Apply the exact reviewed sequence under one lease and one rollback scope. */
export function applyPlannedOperationBatch(
  plan: WikiOperationBatchPlan,
  options: ApplyPlannedOperationBatchOptions,
): ApplyPlannedOperationBatchResult {
  const computed = batchPreviewRevisionOf(plan);
  if (plan.v !== 1 || plan.previewRevision !== computed) {
    return {
      ok: false,
      changedFiles: [],
      replayed: false,
      previewRevision: computed,
      diagnostics: [],
    };
  }
  const result = applyPlannedOperationSequence(plan.operations, {
    ...options,
    expectedSequenceRevision: options.expectedPreviewRevision,
    sequenceRevision: computed,
  });
  return { ...result, previewRevision: computed };
}

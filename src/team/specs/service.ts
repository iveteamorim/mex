import { createHash } from "node:crypto";
import {
  GROUNDING_HEALTH,
  MexPortError,
  isRepoRelativePath,
  isRevision,
  type Diagnostic,
  type EntityId,
  type EntityVersion,
  type GroundingHealth,
  type IsoTimestamp,
  type Revision,
} from "../contracts/shared.js";
import {
  WIKI_LIFECYCLE_STATES,
  type WikiEntity,
  type WikiEntityNeighborhood,
  type WikiEntityNeighborhoodSnapshot,
  type WikiEntitySummary,
  type WikiGroundingResolution,
  type WikiIndexState,
  type WikiIndexStatus,
  type WikiLifecycleState,
  type WikiPort,
  type WikiProvenance,
  type WikiRelation,
  type WikiSource,
} from "../contracts/wiki.js";

/** Wiki-owned authoring kinds surfaced by the Checkpoint D Spec reader. */
export const SPEC_ENTITY_KINDS = [
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
] as const;

export type SpecEntityKind = (typeof SPEC_ENTITY_KINDS)[number];

export const SPEC_HIERARCHY_RELATION_TYPES = [
  "derived_from",
  "verified_by",
  "constrained_by",
  "refines",
] as const;

export type SpecHierarchyRelationType =
  (typeof SPEC_HIERARCHY_RELATION_TYPES)[number];

export const SPEC_READ_LIMITS = Object.freeze({
  defaultPageSize: 25,
  maxPageSize: 100,
  maxCursorBytes: 4 * 1024,
  maxPageTokens: 64 * 1024,
  maxBodyBytes: 64 * 1024,
  maxHierarchyEntities: 100,
  maxHierarchyRelations: 100,
  maxHierarchyDepth: 2,
  maxHierarchyTokens: 64 * 1024,
  maxIndexDiagnostics: 50,
  maxEntityDiagnostics: 10,
  maxTopics: 50,
  maxSourceTypes: 50,
  maxTitleBytes: 512,
  maxSummaryBytes: 2 * 1024,
  maxSourcePathBytes: 1024,
  maxEvidenceRecords: 100,
  maxEvidenceBytes: 64 * 1024,
  maxRelationNoteBytes: 2 * 1024,
  maxProvenanceFieldBytes: 256,
} as const);

export interface SpecListRequest {
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
  lifecycleStates?: readonly WikiLifecycleState[];
  groundingHealth?: readonly GroundingHealth[];
  topics?: readonly EntityId[];
}

export interface SpecIndexProjection {
  state: WikiIndexState;
  observedAt: IsoTimestamp;
  indexedRevision: Revision | null;
  indexedAt: IsoTimestamp | null;
  diagnostics: readonly Diagnostic[];
  diagnosticsTruncated: boolean;
}

export type SpecReadAvailability = "ready" | "stale" | "unavailable";

export interface SpecSummaryProjection {
  schemaVersion: 1;
  id: EntityId;
  kind: SpecEntityKind;
  title: string;
  summary: string | null;
  lifecycleState: WikiLifecycleState;
  groundingHealth: GroundingHealth;
  sourcePath: string;
  version: EntityVersion;
  topics: readonly EntityId[];
  sourceTypes: readonly string[];
  diagnostics: readonly Diagnostic[];
  diagnosticsTruncated: boolean;
}

export interface SpecListPageProjection {
  schemaVersion: 1;
  items: readonly SpecSummaryProjection[];
  nextCursor: string | null;
  truncated: boolean;
  estimatedTokens: number;
  deterministicRevision: Revision;
}

export type SpecListResult =
  | {
      availability: "ready";
      index: SpecIndexProjection;
      page: SpecListPageProjection;
    }
  | {
      availability: "stale" | "unavailable";
      index: SpecIndexProjection;
      page: null;
    };

export interface SpecHierarchyRelationProjection {
  type: SpecHierarchyRelationType;
  source: { id: EntityId; kind: SpecEntityKind };
  target: { id: EntityId; kind: SpecEntityKind };
  note: string | null;
}

export interface SpecHierarchyProjection {
  requirements: readonly SpecSummaryProjection[];
  acceptanceCriteria: readonly SpecSummaryProjection[];
  constraints: readonly SpecSummaryProjection[];
  relations: readonly SpecHierarchyRelationProjection[];
  estimatedTokens: number;
}

export interface SpecDetailProjection {
  schemaVersion: 1;
  spec: SpecSummaryProjection;
  body: string;
  bodyTruncated: boolean;
  provenance: WikiProvenance | null;
  sources: readonly WikiSource[];
  sourcesTruncated: boolean;
  groundings: readonly WikiGroundingResolution[];
  groundingsTruncated: boolean;
  hierarchy: SpecHierarchyProjection;
  deterministicRevision: Revision;
}

export type SpecShowResult =
  | {
      availability: "ready";
      index: SpecIndexProjection;
      detail: SpecDetailProjection;
    }
  | {
      availability: "stale" | "unavailable";
      index: SpecIndexProjection;
      detail: null;
    };

export type SpecWikiReadPort<TEntityExtension = unknown> = Pick<
  WikiPort<TEntityExtension>,
  "inspectIndex" | "listEntities" | "getEntityNeighborhood"
>;

export interface SpecReadService {
  list(request?: SpecListRequest): Promise<SpecListResult>;
  show(id: EntityId): Promise<SpecShowResult>;
}

/**
 * Read-only application projection over the existing WikiPort.
 *
 * This service owns no parser, codec, ranking, database, refresh, or rebuild.
 * It gates every read on a fresh disposable index and retains only explicit
 * Wiki relations with the directions pinned by the Wiki SDD model.
 */
export function createSpecReadService<TEntityExtension>(
  wiki: SpecWikiReadPort<TEntityExtension>,
): SpecReadService {
  return new RepositorySpecReadService(wiki);
}

class RepositorySpecReadService<TEntityExtension> implements SpecReadService {
  constructor(private readonly wiki: SpecWikiReadPort<TEntityExtension>) {}

  async list(request: SpecListRequest = {}): Promise<SpecListResult> {
    const normalized = normalizeListRequest(request);
    const before = await this.wiki.inspectIndex();
    const index = projectIndex(before);
    const availability = availabilityOf(before);
    if (availability !== "ready") return { availability, index, page: null };
    assertFreshIndex(before);

    const source = await this.wiki.listEntities({
      kinds: ["spec"],
      includeArchived: normalized.includeArchived,
      limit: normalized.limit,
      maxTokens: SPEC_READ_LIMITS.maxPageTokens,
      ...(normalized.cursor === undefined ? {} : { cursor: normalized.cursor }),
      ...(normalized.lifecycleStates === undefined
        ? {}
        : { lifecycleStates: normalized.lifecycleStates }),
      ...(normalized.groundingHealth === undefined
        ? {}
        : { groundingHealth: normalized.groundingHealth }),
      ...(normalized.topics === undefined ? {} : { topics: normalized.topics }),
    });
    if (source.items.length > normalized.limit) {
      throw unsafeIndex("The Wiki returned more Specs than the requested page bound.");
    }
    assertCursor(source.nextCursor);
    if (source.nextCursor !== null && !source.truncated) {
      throw unsafeIndex("The Wiki returned a Spec continuation cursor without reporting truncation.");
    }
    assertBoundedInteger(source.estimatedTokens, 0, SPEC_READ_LIMITS.maxPageTokens, "Spec page token count");

    const items = source.items.map((item) => projectSummary(item, "spec"));
    const after = await this.wiki.inspectIndex();
    assertSameFreshIndex(before, after);
    const stablePage = {
      schemaVersion: 1 as const,
      items,
      nextCursor: source.nextCursor,
      truncated: source.truncated,
      estimatedTokens: source.estimatedTokens,
    };
    return {
      availability: "ready",
      index,
      page: {
        ...stablePage,
        deterministicRevision: revisionOf({
          kind: "spec-list-v1",
          indexedRevision: before.indexedRevision,
          request: normalized,
          page: stablePage,
        }),
      },
    };
  }

  async show(id: EntityId): Promise<SpecShowResult> {
    const normalizedId = normalizeEntityId(id);
    const before = await this.wiki.inspectIndex();
    const index = projectIndex(before);
    const availability = availabilityOf(before);
    if (availability !== "ready") return { availability, index, detail: null };
    assertFreshIndex(before);

    const snapshot = await this.wiki.getEntityNeighborhood({
      entityId: normalizedId,
      direction: "both",
      relationTypes: SPEC_HIERARCHY_RELATION_TYPES,
      depth: SPEC_READ_LIMITS.maxHierarchyDepth,
      maxEntities: SPEC_READ_LIMITS.maxHierarchyEntities,
      maxTokens: SPEC_READ_LIMITS.maxHierarchyTokens,
      includeArchived: true,
    });
    if (snapshot === null || snapshot.entity.ref.kind !== "spec") throw specNotFound(normalizedId);
    const after = await this.wiki.inspectIndex();
    assertSameFreshIndex(before, after);
    assertSnapshotMatchesIndex(before, snapshot);
    const { entity, neighborhood } = snapshot;
    assertSameEntitySnapshot(entity, neighborhood.root);

    const spec = projectSummary(entity, "spec");
    const body = truncateUtf8(entity.body, SPEC_READ_LIMITS.maxBodyBytes);
    const sources = boundedRecords(
      entity.sources,
      SPEC_READ_LIMITS.maxEvidenceRecords,
      SPEC_READ_LIMITS.maxEvidenceBytes,
    );
    const groundings = boundedRecords(
      entity.groundings,
      SPEC_READ_LIMITS.maxEvidenceRecords,
      SPEC_READ_LIMITS.maxEvidenceBytes,
    );
    const hierarchy = projectHierarchy(neighborhood, normalizedId);
    const stableDetail = {
      schemaVersion: 1 as const,
      spec,
      body: body.value,
      bodyTruncated: body.truncated,
      provenance: projectProvenance(entity.provenance),
      sources: sources.items,
      sourcesTruncated: sources.truncated,
      groundings: groundings.items,
      groundingsTruncated: groundings.truncated,
      hierarchy,
    };
    return {
      availability: "ready",
      index,
      detail: {
        ...stableDetail,
        deterministicRevision: revisionOf({
          kind: "spec-show-v1",
          indexedRevision: before.indexedRevision,
          projectionRevision: snapshot.projectionRevision,
          detail: stableDetail,
        }),
      },
    };
  }
}

interface NormalizedSpecListRequest {
  cursor?: string;
  limit: number;
  includeArchived: boolean;
  lifecycleStates?: readonly WikiLifecycleState[];
  groundingHealth?: readonly GroundingHealth[];
  topics?: readonly EntityId[];
}

function normalizeListRequest(request: SpecListRequest): NormalizedSpecListRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw invalidRequest("Spec list request must be an object.");
  }
  const keys = Object.keys(request);
  const accepted = new Set([
    "cursor",
    "limit",
    "includeArchived",
    "lifecycleStates",
    "groundingHealth",
    "topics",
  ]);
  if (keys.some((key) => !accepted.has(key))) {
    throw invalidRequest("Spec list request contains an unsupported field.");
  }
  const limit = request.limit ?? SPEC_READ_LIMITS.defaultPageSize;
  assertBoundedInteger(limit, 1, SPEC_READ_LIMITS.maxPageSize, "Spec page limit", "request");
  if (request.includeArchived !== undefined && typeof request.includeArchived !== "boolean") {
    throw invalidRequest("includeArchived must be a boolean.");
  }
  if (request.cursor !== undefined) assertCursor(request.cursor, "request");
  const lifecycleStates = normalizeEnumList(
    request.lifecycleStates,
    WIKI_LIFECYCLE_STATES,
    "lifecycleStates",
  ) as readonly WikiLifecycleState[] | undefined;
  const groundingHealth = normalizeEnumList(
    request.groundingHealth,
    GROUNDING_HEALTH,
    "groundingHealth",
  ) as readonly GroundingHealth[] | undefined;
  const topics = normalizeStringList(request.topics, "topics") as readonly EntityId[] | undefined;
  return {
    limit,
    includeArchived: request.includeArchived === true,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(lifecycleStates === undefined ? {} : { lifecycleStates }),
    ...(groundingHealth === undefined ? {} : { groundingHealth }),
    ...(topics === undefined ? {} : { topics }),
  };
}

function projectIndex(status: WikiIndexStatus): SpecIndexProjection {
  const diagnostics = boundedRecords(
    status.diagnostics,
    SPEC_READ_LIMITS.maxIndexDiagnostics,
    SPEC_READ_LIMITS.maxEvidenceBytes,
  );
  return {
    state: status.state,
    observedAt: status.observedAt,
    indexedRevision: status.indexedRevision,
    indexedAt: status.indexedAt,
    diagnostics: diagnostics.items,
    diagnosticsTruncated: diagnostics.truncated,
  };
}

function availabilityOf(status: WikiIndexStatus): SpecReadAvailability {
  if (status.state === "fresh") return "ready";
  if (status.state === "stale" || status.state === "rebuild_required") return "stale";
  return "unavailable";
}

function assertFreshIndex(status: WikiIndexStatus): asserts status is WikiIndexStatus & {
  state: "fresh";
  indexedRevision: Revision;
} {
  if (status.state !== "fresh"
    || status.indexedRevision === null
    || !isRevision(status.indexedRevision)
    || status.indexedAt === null
    || Number.isNaN(Date.parse(status.indexedAt))) {
    throw unsafeIndex("The Wiki reported a fresh index without a valid indexed revision.");
  }
}

function assertSameFreshIndex(before: WikiIndexStatus, after: WikiIndexStatus): void {
  assertFreshIndex(before);
  if (after.state !== "fresh"
    || after.indexedRevision !== before.indexedRevision
    || after.indexedAt !== before.indexedAt) {
    throw new MexPortError({
      title: "Spec snapshot changed",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "The Wiki index changed while the Spec snapshot was being read. Retry the command.",
    });
  }
}

function assertSnapshotMatchesIndex(
  before: WikiIndexStatus,
  snapshot: WikiEntityNeighborhoodSnapshot<unknown>,
): void {
  assertFreshIndex(before);
  if (!isRevision(snapshot.indexedRevision)
    || !isRevision(snapshot.projectionRevision)
    || Number.isNaN(Date.parse(snapshot.observedAt))) {
    throw unsafeIndex("The Wiki returned an unsafe Spec snapshot revision.");
  }
  if (snapshot.indexedRevision !== before.indexedRevision) {
    throw new MexPortError({
      title: "Spec snapshot changed",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "The Wiki index changed before the Spec snapshot was read. Retry the command.",
    });
  }
}

function projectSummary(
  entity: WikiEntitySummary,
  requiredKind?: SpecEntityKind,
): SpecSummaryProjection {
  if (!isSpecEntityKind(entity.ref.kind)
    || (requiredKind !== undefined && entity.ref.kind !== requiredKind)) {
    throw unsafeIndex("The Wiki returned an entity outside the bounded Spec vocabulary.");
  }
  if (!isWikiEntityId(entity.ref.id)
    || (entity.ref.title !== undefined && entity.ref.title !== entity.title)
    || !isRepoRelativePath(entity.location.path)
    || !Number.isSafeInteger(entity.version.semanticRevision)
    || entity.version.semanticRevision < 1
    || !isRevision(entity.version.contentHash)
    || !(WIKI_LIFECYCLE_STATES as readonly string[]).includes(entity.lifecycleState)
    || !(GROUNDING_HEALTH as readonly string[]).includes(entity.groundingHealth)) {
    throw unsafeIndex("The Wiki returned an unsafe Spec identity, location, or revision.");
  }
  if (!isSafeDisplayText(entity.title, SPEC_READ_LIMITS.maxTitleBytes, false)
    || (entity.summary !== undefined
      && !isSafeDisplayText(entity.summary, SPEC_READ_LIMITS.maxSummaryBytes, true))
    || !isSafeDisplayText(entity.location.path, SPEC_READ_LIMITS.maxSourcePathBytes, false)
    || entity.topics.length > SPEC_READ_LIMITS.maxTopics
    || entity.topics.some((topic) => !isWikiEntityId(topic))
    || entity.sourceTypes.length > SPEC_READ_LIMITS.maxSourceTypes
    || entity.sourceTypes.some((sourceType) => !isSafeDisplayText(sourceType, 128, false))) {
    throw projectionTooLarge("A Spec summary exceeded its bounded display contract.");
  }
  const diagnostics = boundedRecords(
    entity.diagnostics,
    SPEC_READ_LIMITS.maxEntityDiagnostics,
    SPEC_READ_LIMITS.maxEvidenceBytes,
  );
  return {
    schemaVersion: 1,
    id: entity.ref.id,
    kind: entity.ref.kind,
    title: entity.title,
    summary: entity.summary ?? null,
    lifecycleState: entity.lifecycleState,
    groundingHealth: entity.groundingHealth,
    sourcePath: entity.location.path,
    version: structuredClone(entity.version),
    topics: [...entity.topics],
    sourceTypes: [...entity.sourceTypes],
    diagnostics: diagnostics.items,
    diagnosticsTruncated: diagnostics.truncated,
  };
}

function projectHierarchy(
  neighborhood: WikiEntityNeighborhood,
  rootId: EntityId,
): SpecHierarchyProjection {
  if (neighborhood.truncated) {
    throw hierarchyTooLarge("The Spec hierarchy exceeded its entity or token bound.");
  }
  if (neighborhood.root.ref.id !== rootId || neighborhood.root.ref.kind !== "spec") {
    throw unsafeIndex("The Wiki returned a different root for the requested Spec hierarchy.");
  }
  if (neighborhood.entities.length + 1 > SPEC_READ_LIMITS.maxHierarchyEntities
    || neighborhood.relations.length > SPEC_READ_LIMITS.maxHierarchyRelations) {
    throw hierarchyTooLarge("The Spec hierarchy exceeded its result bound.");
  }
  assertBoundedInteger(
    neighborhood.estimatedTokens,
    0,
    SPEC_READ_LIMITS.maxHierarchyTokens,
    "Spec hierarchy token count",
  );

  const summaries = new Map<EntityId, WikiEntitySummary>();
  insertUniqueSummary(summaries, neighborhood.root);
  for (const entity of neighborhood.entities) insertUniqueSummary(summaries, entity);

  const relations: SpecHierarchyRelationProjection[] = [];
  for (const relation of neighborhood.relations) {
    if (!isSpecHierarchyRelationType(relation.type)) continue;
    const source = summaries.get(relation.source.id);
    const target = summaries.get(relation.target.id);
    if (source === undefined || target === undefined) {
      throw unsafeIndex("The Spec hierarchy contains a relation with an unavailable endpoint.");
    }
    if (!isSpecEntityKind(source.ref.kind) || !isSpecEntityKind(target.ref.kind)) continue;
    if (!isPinnedHierarchyDirection(relation, source.ref.kind, target.ref.kind)) continue;
    if (relation.note !== undefined
      && !isSafeDisplayText(relation.note, SPEC_READ_LIMITS.maxRelationNoteBytes, true)) {
      throw hierarchyTooLarge("A Spec hierarchy relation note exceeded its read bound.");
    }
    relations.push({
      type: relation.type,
      source: { id: source.ref.id, kind: source.ref.kind },
      target: { id: target.ref.id, kind: target.ref.kind },
      note: relation.note ?? null,
    });
  }
  relations.sort(compareRelations);

  const reachable = reachableEntityIds(rootId, relations, SPEC_READ_LIMITS.maxHierarchyDepth);
  const projected = [...reachable]
    .filter((id) => id !== rootId)
    .flatMap((id) => {
      const summary = summaries.get(id);
      if (summary === undefined || !isSpecEntityKind(summary.ref.kind) || summary.ref.kind === "spec") return [];
      return [projectSummary(summary)];
    });
  projected.sort(compareSummaries);
  const visibleIds = new Set<EntityId>([rootId, ...projected.map((entry) => entry.id)]);
  const visibleRelations = relations.filter((relation) => (
    visibleIds.has(relation.source.id) && visibleIds.has(relation.target.id)
  ));
  if (projected.length + visibleRelations.length > SPEC_READ_LIMITS.maxHierarchyEntities) {
    throw hierarchyTooLarge("The Spec hierarchy exceeded its aggregate read bound.");
  }
  return {
    requirements: projected.filter((entry) => entry.kind === "requirement"),
    acceptanceCriteria: projected.filter((entry) => entry.kind === "acceptance_criterion"),
    constraints: projected.filter((entry) => entry.kind === "constraint"),
    relations: visibleRelations,
    estimatedTokens: neighborhood.estimatedTokens,
  };
}

function insertUniqueSummary(
  summaries: Map<EntityId, WikiEntitySummary>,
  summary: WikiEntitySummary,
): void {
  const previous = summaries.get(summary.ref.id);
  if (previous !== undefined
    && canonical(previous) !== canonical(summary)) {
    throw unsafeIndex("The Spec hierarchy contains conflicting projections for one entity.");
  }
  summaries.set(summary.ref.id, summary);
}

function reachableEntityIds(
  rootId: EntityId,
  relations: readonly SpecHierarchyRelationProjection[],
  maxDepth: number,
): ReadonlySet<EntityId> {
  const childrenByParent = new Map<EntityId, Set<EntityId>>();
  for (const relation of relations) {
    const [parentId, childId] = hierarchyParentAndChild(relation);
    const children = childrenByParent.get(parentId) ?? new Set<EntityId>();
    children.add(childId);
    childrenByParent.set(parentId, children);
  }
  const reached = new Set<EntityId>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: EntityId[] = [];
    for (const id of frontier.sort(compareCodePoints)) {
      for (const childId of [...(childrenByParent.get(id) ?? [])].sort(compareCodePoints)) {
        if (reached.has(childId)) continue;
        reached.add(childId);
        next.push(childId);
      }
    }
    frontier = next;
  }
  return reached;
}

function hierarchyParentAndChild(
  relation: SpecHierarchyRelationProjection,
): readonly [EntityId, EntityId] {
  switch (relation.type) {
    case "derived_from":
    case "verified_by":
    case "refines":
      return [relation.target.id, relation.source.id];
    case "constrained_by":
      return [relation.source.id, relation.target.id];
  }
}

function isPinnedHierarchyDirection(
  relation: WikiRelation,
  sourceKind: SpecEntityKind,
  targetKind: SpecEntityKind,
): boolean {
  switch (relation.type) {
    case "derived_from":
      return sourceKind === "requirement" && targetKind === "spec";
    case "verified_by":
      return sourceKind === "acceptance_criterion"
        && (targetKind === "spec" || targetKind === "requirement");
    case "constrained_by":
      return targetKind === "constraint";
    case "refines":
      return sourceKind === "requirement" && targetKind === "requirement";
    default:
      return false;
  }
}

function assertSameEntitySnapshot(
  entity: WikiEntity<unknown>,
  root: WikiEntitySummary,
): void {
  if (canonical(projectSummary(entity, "spec"))
    !== canonical(projectSummary(root, "spec"))) {
    throw new MexPortError({
      title: "Spec snapshot changed",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "The Spec changed while its hierarchy was being read. Retry the command.",
    });
  }
}

function projectProvenance(value: WikiProvenance | undefined): WikiProvenance | null {
  if (value === undefined) return null;
  const fields = [value.id, value.sessionId].filter(
    (entry): entry is string => entry !== undefined,
  );
  if (fields.some((entry) => (
    !isSafeDisplayText(entry, SPEC_READ_LIMITS.maxProvenanceFieldBytes, false)
  )) || (value.capturedAt !== undefined && Number.isNaN(Date.parse(value.capturedAt)))) {
    throw projectionTooLarge("Spec provenance exceeded its read bound.");
  }
  return {
    kind: value.kind,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.capturedAt === undefined ? {} : { capturedAt: value.capturedAt }),
  };
}

function boundedRecords<T>(
  values: readonly T[],
  maxRecords: number,
  maxBytes: number,
): { items: readonly T[]; truncated: boolean } {
  const items: T[] = [];
  let bytes = 2;
  for (const value of values) {
    if (items.length >= maxRecords) return { items, truncated: true };
    const cloned = structuredClone(value);
    const nextBytes = Buffer.byteLength(JSON.stringify(cloned) ?? "null", "utf8") + 1;
    if (bytes + nextBytes > maxBytes) return { items, truncated: true };
    items.push(cloned);
    bytes += nextBytes;
  }
  return { items, truncated: false };
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function normalizeEntityId(value: unknown): EntityId {
  if (typeof value !== "string") throw invalidRequest("Spec ID must be a string.");
  const normalized = value.trim().normalize("NFC");
  if (!isWikiEntityId(normalized)) {
    throw invalidRequest("Spec ID is invalid.");
  }
  return normalized;
}

function normalizeEnumList(
  values: readonly string[] | undefined,
  allowed: readonly string[],
  field: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > allowed.length
    || values.some((value) => typeof value !== "string" || !allowed.includes(value))) {
    throw invalidRequest(`${field} contains an unsupported value.`);
  }
  if (new Set(values).size !== values.length) {
    throw invalidRequest(`${field} must not contain duplicate values.`);
  }
  return [...values].sort(compareCodePoints);
}

function normalizeStringList(
  values: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > SPEC_READ_LIMITS.maxTopics) {
    throw invalidRequest(`${field} must contain 1-${SPEC_READ_LIMITS.maxTopics} values.`);
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string") throw invalidRequest(`${field} must contain strings.`);
    const item = value.normalize("NFC");
    if (!isWikiEntityId(item)) {
      throw invalidRequest(`${field} contains an invalid value.`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw invalidRequest(`${field} must not contain duplicate values.`);
  }
  return normalized.sort(compareCodePoints);
}

function assertCursor(value: string | null, source: "request" | "response" = "response"): void {
  if (value === null) return;
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > SPEC_READ_LIMITS.maxCursorBytes
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    if (source === "request") throw invalidRequest("Spec cursor is invalid or too large.");
    throw unsafeIndex("The Wiki returned an invalid or oversized Spec cursor.");
  }
}

function assertBoundedInteger(
  value: number,
  min: number,
  max: number,
  label: string,
  source: "request" | "response" = "response",
): void {
  if (Number.isSafeInteger(value) && value >= min && value <= max) return;
  if (source === "request") throw invalidRequest(`${label} must be an integer from ${min} to ${max}.`);
  throw unsafeIndex(`The Wiki returned an invalid ${label.toLowerCase()}.`);
}

function isSpecEntityKind(value: string): value is SpecEntityKind {
  return (SPEC_ENTITY_KINDS as readonly string[]).includes(value);
}

function isWikiEntityId(value: string): boolean {
  return /^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
}

function isSafeDisplayText(value: string, maxBytes: number, allowEmpty: boolean): boolean {
  return (allowEmpty || value.length > 0)
    && value.normalize("NFC") === value
    && value.length <= maxBytes
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

function isSpecHierarchyRelationType(value: string): value is SpecHierarchyRelationType {
  return (SPEC_HIERARCHY_RELATION_TYPES as readonly string[]).includes(value);
}

function compareSummaries(left: SpecSummaryProjection, right: SpecSummaryProjection): number {
  return compareCodePoints(left.title, right.title) || compareCodePoints(left.id, right.id);
}

function compareRelations(
  left: SpecHierarchyRelationProjection,
  right: SpecHierarchyRelationProjection,
): number {
  return compareCodePoints(left.type, right.type)
    || compareCodePoints(left.source.id, right.source.id)
    || compareCodePoints(left.target.id, right.target.id)
    || compareCodePoints(left.note ?? "", right.note ?? "");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function revisionOf(value: unknown): Revision {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function invalidRequest(detail: string): MexPortError {
  return new MexPortError({
    title: "Invalid Spec read request",
    status: 400,
    code: "INVALID_REQUEST",
    detail,
  });
}

function specNotFound(id: EntityId): MexPortError {
  return new MexPortError({
    title: "Spec not found",
    status: 404,
    code: "NOT_FOUND",
    detail: `Spec ${id} does not exist.`,
  });
}

function hierarchyTooLarge(detail: string): MexPortError {
  return new MexPortError({
    title: "Spec hierarchy is too large",
    status: 422,
    code: "VALIDATION_FAILED",
    detail,
  });
}

function projectionTooLarge(detail: string): MexPortError {
  return new MexPortError({
    title: "Spec projection is too large",
    status: 422,
    code: "VALIDATION_FAILED",
    detail,
  });
}

function unsafeIndex(detail: string): MexPortError {
  return new MexPortError({
    title: "Wiki index is unsafe",
    status: 503,
    code: "INDEX_CORRUPT",
    detail,
  });
}

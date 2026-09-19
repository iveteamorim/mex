import { createHash } from "node:crypto";
import {
  MexPortError,
  isRepoRelativePath,
  type Diagnostic,
  type EntityId,
  type EntityRef,
  type EntityVersion,
  type FileChange,
  type OperationContext,
  type RepoRelativePath,
  type Revision,
} from "../../contracts/shared.js";
import {
  WIKI_RELATION_TYPES,
  aggregateWikiGroundingHealth,
} from "../../contracts/wiki.js";
import type {
  WikiBacklinksRequest,
  WikiEntity,
  WikiEntityNeighborhood,
  WikiEntityNeighborhoodSnapshot,
  WikiEntitySummary,
  WikiExactAuthoringPreviewPort,
  WikiExactEntityAttestationView,
  WikiForcedCreatedIdPreviewPort,
  WikiGroundingResolution,
  WikiIndexState,
  WikiIndexStatus,
  WikiListRequest,
  WikiMigrationApplyRequest,
  WikiMigrationOptions,
  WikiMigrationPreview,
  WikiMigrationReport,
  WikiMigrationResult,
  WikiNeighborhoodRequest,
  WikiOperationApplyRequest,
  WikiOperationPreview,
  WikiOperationRequest,
  WikiOperationResult,
  WikiPage,
  WikiPort,
  WikiQueryRequest,
  WikiRebuildResult,
  WikiRefreshResult,
  WikiRelation,
  WikiRelationHit,
  WikiRevisionExpectation,
  WikiSearchHit,
  WikiSource,
  WikiTraverseRequest,
  WikiValidationReport,
  WikiValidationRequest,
} from "../../contracts/wiki.js";
import {
  POPULATED_WIKI_FIXTURE,
  type MockWikiEntitySeed,
  type MockWikiPayload,
  type PopulatedWikiFixture,
} from "./populated-fixture.js";

export type MockWikiOperation =
  | {
      type: "create-entry";
      entity: MockWikiEntitySeed;
    }
  | {
      type: "update-entry";
      entityId: string;
      title?: string;
      summary?: string;
      body?: string;
      lifecycleState?: MockWikiEntitySeed["lifecycleState"];
    }
  | {
      type: "add-relation";
      relation: WikiRelation;
    }
  | {
      type: "move-entry";
      entityId: string;
      destinationPath: string;
    }
  | {
      type: "archive-entry";
      entityId: string;
    };

export interface MockWikiOperationPlan {
  operations: readonly MockWikiOperation[];
}

/**
 * Package-private testing payload for the receipt-bound create seam. The
 * caller deliberately omits the new entity ID; the supplied `createdIds`
 * value must be the only source that materializes it in the returned plan.
 */
export interface MockWikiForcedCreatePayload {
  operations: readonly [{
    type: "create-entry";
    entity: Omit<MockWikiEntitySeed, "id">;
  }];
}

type MockWikiOperationInput = MockWikiOperationPlan | MockWikiForcedCreatePayload;

export interface MockMigrationFile {
  path: string;
  before: string;
  after: string;
}

export interface MockWikiMigrationPlan {
  files: readonly MockMigrationFile[];
  entities: readonly MockWikiEntitySeed[];
  relations: readonly WikiRelation[];
}

export interface MockLegacyMigration {
  documents: Readonly<Record<string, string>>;
  migratedDocuments: Readonly<Record<string, string>>;
  entities: readonly MockWikiEntitySeed[];
  relations?: readonly WikiRelation[];
}

export interface MockWikiPortOptions {
  fixture?: PopulatedWikiFixture;
  indexState?: WikiIndexState;
  legacyMigration?: MockLegacyMigration;
  failNextIndexRefresh?: boolean;
  now?: () => string;
}

export interface MockWikiEffects {
  canonicalWrites: number;
  indexRebuilds: number;
  indexRefreshes: number;
  auditEntries: number;
  agentLaunches: number;
}

export interface MockWikiSnapshot {
  canonicalDigest: Revision;
  indexDigest: Revision;
  files: Readonly<Record<string, string>>;
  effects: MockWikiEffects;
}

interface State {
  entities: Map<string, MockWikiEntitySeed>;
  relations: WikiRelation[];
  fileOverrides: Map<string, string>;
}

interface AppliedOperation {
  requestDigest: Revision;
  result: WikiOperationResult;
}

interface AppliedMigration {
  requestDigest: Revision;
  result: WikiMigrationResult;
}

const DEFAULT_NOW = "2026-08-22T00:00:00.000Z";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const INITIAL_OPERATION_AUDIT = `${JSON.stringify({
  opId: "operation_fixture_baseline",
  type: "update-entry",
  entityIds: [POPULATED_WIKI_FIXTURE.refs.oldDecision],
  actor: { kind: "human", id: "member_fixture_maintainer" },
  timestamp: "2026-08-01T00:00:00.000Z",
  filesChanged: [".mex/context/decisions.md"],
  revisions: [{
    id: POPULATED_WIKI_FIXTURE.refs.oldDecision,
    before: 1,
    after: 2,
  }],
})}\n`;

/**
 * Behavioral test double for the consumer-owned WikiPort.
 *
 * Its Markdown rendering and operation payload are deliberately testing-only;
 * the real adapter must use the teammate engine's codec and operation model.
 */
export class MockWikiPort implements WikiPort<
  MockWikiPayload,
  MockWikiOperationPlan,
  MockWikiOperationPlan,
  MockWikiMigrationPlan
>, WikiForcedCreatedIdPreviewPort<MockWikiOperationPlan, MockWikiOperationPlan>,
WikiExactAuthoringPreviewPort<MockWikiOperationPlan, MockWikiOperationPlan> {
  private canonical: State;
  private index: State;
  private indexState: WikiIndexState;
  private indexedAt: string | null;
  private readonly now: () => string;
  private readonly duplicateIds: readonly string[];
  private readonly appliedOperations = new Map<string, AppliedOperation>();
  private readonly appliedMigrations = new Map<string, AppliedMigration>();
  private readonly legacyMigration?: MockLegacyMigration;
  private failNextIndexRefresh: boolean;
  private effects: MockWikiEffects = {
    canonicalWrites: 0,
    indexRebuilds: 0,
    indexRefreshes: 0,
    auditEntries: 0,
    agentLaunches: 0,
  };

  constructor(options: MockWikiPortOptions = {}) {
    const fixture = options.fixture ?? POPULATED_WIKI_FIXTURE;
    const duplicates = findDuplicates(fixture.entities.map((entity) => entity.id));
    this.duplicateIds = duplicates;
    this.legacyMigration = options.legacyMigration;
    this.failNextIndexRefresh = options.failNextIndexRefresh ?? false;
    this.now = options.now ?? (() => DEFAULT_NOW);

    if (options.legacyMigration) {
      const overrides = new Map(Object.entries(options.legacyMigration.documents));
      this.canonical = { entities: new Map(), relations: [], fileOverrides: overrides };
      this.index = cloneState(this.canonical);
      this.indexState = options.indexState ?? "migration_required";
      this.indexedAt = null;
      return;
    }

    this.canonical = stateFromFixture(fixture);
    this.index = cloneState(this.canonical);
    this.indexState = options.indexState ?? "fresh";
    this.indexedAt = this.indexState === "fresh" ? this.now() : null;
  }

  async getEntity(id: EntityId): Promise<WikiEntity<MockWikiPayload> | null> {
    this.requireReadableIndex();
    const entity = this.index.entities.get(id);
    return entity ? toEntity(entity, this.index, this.now()) : null;
  }

  async readExactEntityAttestations(
    entityIds: readonly EntityId[],
  ): Promise<WikiExactEntityAttestationView> {
    if (!Array.isArray(entityIds) || entityIds.length > 100) {
      throw problem("INVALID_REQUEST", 400, "Exact Wiki attestation accepts at most 100 entity IDs.");
    }
    if (this.indexState !== "fresh") {
      throw problem("INDEX_STALE", 409, "Exact Wiki attestation requires a fresh index.");
    }
    const seen = new Set<string>();
    for (const id of entityIds) {
      if (!isWikiMintedEntityId(id)) {
        throw problem("INVALID_REQUEST", 400, "Exact Wiki attestation contains an invalid mx entity ID.");
      }
      if (seen.has(id)) {
        throw problem("INVALID_REQUEST", 400, "Exact Wiki attestation contains a duplicate entity ID.");
      }
      seen.add(id);
    }
    const indexedRevision = digestState(this.index);
    return {
      indexedRevision,
      observedAt: this.indexedAt ?? this.now(),
      entities: entityIds.map((id) => {
        const entity = this.index.entities.get(id);
        return {
          id,
          entity: entity === undefined ? null : {
            ref: { id: entity.id, kind: entity.kind, title: entity.title },
            version: versionForEntity(entity, this.index),
          },
        };
      }),
    };
  }

  async getEntityNeighborhood(
    request: WikiNeighborhoodRequest,
  ): Promise<WikiEntityNeighborhoodSnapshot<MockWikiPayload> | null> {
    this.requireReadableIndex();
    const root = this.index.entities.get(request.entityId);
    if (root === undefined) return null;
    const observedAt = this.now();
    const indexedRevision = digestState(this.index);
    return {
      indexedRevision,
      projectionRevision: hash(stableStringify({
        graph: "unavailable",
        wiki: indexedRevision,
      })),
      observedAt,
      entity: toEntity(root, this.index, observedAt),
      neighborhood: this.projectNeighborhood(request),
    };
  }

  async listEntities(request: WikiListRequest = {}): Promise<WikiPage<WikiEntitySummary>> {
    this.requireReadableIndex();
    const entities = [...this.index.entities.values()]
      .filter((entity) => matchesListFilters(entity, request))
      .sort(byEntityIdentity)
      .map((entity) => toSummary(entity, this.index));
    return paginate(entities, request);
  }

  async queryEntities(request: WikiQueryRequest): Promise<WikiPage<WikiSearchHit>> {
    this.requireReadableIndex();
    const needle = request.query.trim().toLowerCase();
    if (!needle) {
      throw problem("INVALID_REQUEST", 400, "Wiki query must not be empty.");
    }

    const hits = [...this.index.entities.values()]
      .filter((entity) => matchesListFilters(entity, request))
      .flatMap((entity) => {
        const matches: WikiSearchHit["matchedFields"][number][] = [];
        let score = 0;
        if (entity.id.toLowerCase() === needle) {
          matches.push("id");
          score += 100;
        }
        if (entity.title.toLowerCase().includes(needle)) {
          matches.push("title");
          score += 50;
        }
        if (entity.payload.summary.toLowerCase().includes(needle)) {
          matches.push("summary");
          score += 20;
        }
        if (entity.payload.body.toLowerCase().includes(needle)) {
          matches.push("body");
          score += 10;
        }
        if (matches.length === 0) return [];
        if (entity.groundingHealth === "changed") score *= 0.8;
        return [{ entity, score, matches }];
      })
      .sort((left, right) => right.score - left.score || byEntityIdentity(left.entity, right.entity))
      .map(({ entity, score, matches }) => ({
        entity: toSummary(entity, this.index),
        score,
        matchedFields: matches,
      }));
    return paginate(hits, request);
  }

  async traverseRelations(request: WikiTraverseRequest): Promise<WikiPage<WikiRelationHit>> {
    this.requireReadableIndex();
    this.requireIndexedEntity(request.entityId);
    const hits = this.index.relations
      .flatMap((relation): WikiRelationHit[] => {
        const outgoing = relation.source.id === request.entityId;
        const incoming = relation.target.id === request.entityId;
        if (request.direction === "outgoing" && !outgoing) return [];
        if (request.direction === "incoming" && !incoming) return [];
        if (request.direction === "both" && !outgoing && !incoming) return [];
        if (request.relationTypes && !request.relationTypes.includes(relation.type)) return [];
        const direction = outgoing ? "outgoing" : "incoming";
        const otherId = outgoing ? relation.target.id : relation.source.id;
        const entity = this.index.entities.get(otherId);
        if (!entity || (!request.includeArchived && entity.lifecycleState === "archived")) return [];
        return [{
          relation: cloneRelation(relation),
          direction,
          entity: toSummary(entity, this.index),
        }];
      })
      .sort((left, right) => compareCodePoints(
        relationKey(left.relation),
        relationKey(right.relation),
      ));
    return paginate(hits, request);
  }

  async getBacklinks(request: WikiBacklinksRequest): Promise<WikiPage<WikiRelation>> {
    this.requireReadableIndex();
    this.requireIndexedEntity(request.entityId);
    const relations = this.index.relations
      .filter((relation) => relation.target.id === request.entityId)
      .filter((relation) => !request.relationTypes
        || request.relationTypes.includes(relation.type))
      .filter((relation) => {
        const source = this.index.entities.get(relation.source.id);
        return source !== undefined
          && (request.includeArchived || source.lifecycleState !== "archived");
      })
      .sort((left, right) => compareCodePoints(relationKey(left), relationKey(right)))
      .map(cloneRelation);
    return paginate(relations, request);
  }

  async getNeighborhood(request: WikiNeighborhoodRequest): Promise<WikiEntityNeighborhood> {
    this.requireReadableIndex();
    return this.projectNeighborhood(request);
  }

  private projectNeighborhood(request: WikiNeighborhoodRequest): WikiEntityNeighborhood {
    const rootEntity = this.requireIndexedEntity(request.entityId);
    if (!Number.isSafeInteger(request.depth) || request.depth < 0) {
      throw problem("INVALID_REQUEST", 400, "Neighborhood depth must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(request.maxEntities) || request.maxEntities <= 0) {
      throw problem("INVALID_REQUEST", 400, "Neighborhood maxEntities must be positive.");
    }
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0) {
      throw problem("INVALID_REQUEST", 400, "Neighborhood maxTokens must be positive.");
    }

    const root = toSummary(rootEntity, this.index);
    const entities = new Map<EntityId, WikiEntitySummary>();
    const relations = new Map<string, WikiRelation>();
    const visited = new Set<EntityId>([request.entityId]);
    const queue: { id: EntityId; depth: number }[] = [{ id: request.entityId, depth: 0 }];
    let estimatedTokens = estimateTokens(root);
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= request.depth) continue;
      const candidates = relationsForEntity(this.index, current.id, request.direction ?? "both")
        .filter((relation) => !request.relationTypes
          || request.relationTypes.includes(relation.type))
        .sort((left, right) => compareCodePoints(relationKey(left), relationKey(right)));

      for (const relation of candidates) {
        const neighborId = relation.source.id === current.id
          ? relation.target.id
          : relation.source.id;
        const neighbor = this.index.entities.get(neighborId);
        if (!neighbor || (!request.includeArchived && neighbor.lifecycleState === "archived")) {
          continue;
        }
        if (!visited.has(neighborId)) {
          const summary = toSummary(neighbor, this.index);
          const tokens = estimateTokens(summary);
          if (visited.size >= request.maxEntities || estimatedTokens + tokens > request.maxTokens) {
            truncated = true;
            continue;
          }
          visited.add(neighborId);
          entities.set(neighborId, summary);
          estimatedTokens += tokens;
          queue.push({ id: neighborId, depth: current.depth + 1 });
        }
        if (visited.has(relation.source.id) && visited.has(relation.target.id)) {
          relations.set(relationKey(relation), cloneRelation(relation));
        }
      }
    }

    return {
      root,
      entities: [...entities.values()],
      relations: [...relations.values()],
      estimatedTokens,
      truncated,
    };
  }

  async getGroundingStatus(id: EntityId): Promise<readonly WikiGroundingResolution[]> {
    this.requireReadableIndex();
    return groundingResolutions(this.requireIndexedEntity(id), this.now());
  }

  async validate(request: WikiValidationRequest = {}): Promise<WikiValidationReport> {
    if (request.maxDiagnostics !== undefined
      && (!Number.isSafeInteger(request.maxDiagnostics) || request.maxDiagnostics < 0)) {
      throw problem("INVALID_REQUEST", 400, "maxDiagnostics must be a non-negative integer.");
    }
    for (const path of request.paths ?? []) assertWikiPath(path);
    const onlyIds = request.entityIds && new Set(request.entityIds);
    const onlyPaths = request.paths && new Set(request.paths);
    const allDiagnostics = validateState(this.canonical, this.duplicateIds)
      .filter((diagnostic) => !onlyIds
        || (diagnostic.entity !== undefined && onlyIds.has(diagnostic.entity.id)))
      .filter((diagnostic) => {
        if (!onlyPaths) return true;
        const path = diagnostic.path ?? (diagnostic.entity
          ? this.canonical.entities.get(diagnostic.entity.id)?.sourcePath
          : undefined);
        return path !== undefined && onlyPaths.has(path);
      });
    const diagnostics = request.maxDiagnostics === undefined
      ? allDiagnostics
      : allDiagnostics.slice(0, request.maxDiagnostics);
    return {
      valid: allDiagnostics.every((diagnostic) => diagnostic.severity !== "error"),
      diagnostics,
    };
  }

  async previewOperations(
    request: WikiOperationRequest<MockWikiOperationPlan>,
  ): Promise<WikiOperationPreview<MockWikiOperationPlan>> {
    assertOperationEnvelope(request);
    assertPlanPaths(request.operation.payload);
    assertPlanPreconditions(request.operation.payload, request.expectedRevisions);
    this.assertExpectedRevisions(request.expectedRevisions);
    return this.planOperation(request);
  }

  async previewAuthoringOperations(
    request: WikiOperationRequest<MockWikiOperationPlan>,
  ): Promise<WikiOperationPreview<MockWikiOperationPlan>> {
    const operations = request.operation.payload?.operations;
    if (!Array.isArray(operations)
      || operations.length !== 1
      || operations[0]?.type !== "update-entry") {
      throw problem(
        "VALIDATION_FAILED",
        422,
        "Exact Wiki authoring preview accepts exactly one governed update and no generated IDs.",
      );
    }
    return this.previewOperations(request);
  }

  async previewOperationsWithCreatedIds(
    request: WikiOperationRequest<MockWikiOperationInput>,
    createdIds: readonly EntityId[],
  ): Promise<WikiOperationPreview<MockWikiOperationPlan>> {
    if (!Array.isArray(createdIds)
      || createdIds.length !== 1
      || !isWikiMintedEntityId(createdIds[0])) {
      throw problem("VALIDATION_FAILED", 422, "A receipt-bound Wiki create requires exactly one canonical mx entity ID.");
    }
    assertForcedCreateEnvelope(request);
    const plan = materializeForcedCreatePlan(request.operation.payload, createdIds[0]);
    assertPlanPaths(plan);
    assertPlanPreconditions(plan, request.expectedRevisions);
    this.assertExpectedRevisions(request.expectedRevisions);
    return this.planOperation(request, plan);
  }

  async validateCurrentRevisionExpectations(
    expectations: readonly WikiRevisionExpectation[],
  ): Promise<void> {
    this.assertExpectedRevisions(expectations);
  }

  async applyOperations(
    request: WikiOperationApplyRequest<MockWikiOperationInput, MockWikiOperationPlan>,
  ): Promise<WikiOperationResult> {
    const requestDigest = hash(stableStringify(request));
    const previous = this.appliedOperations.get(request.operation.opId);
    if (previous) {
      if (previous.requestDigest !== requestDigest) {
        throw problem(
          "VALIDATION_FAILED",
          422,
          `Operation ${request.operation.opId} was already used with a different payload.`,
        );
      }
      return { ...previous.result, idempotentReplay: true };
    }

    const forcedPlan = forcedCreatePlanForApply(request);
    const proposedPlan = forcedPlan ?? request.operation.payload as MockWikiOperationPlan;
    if (forcedPlan === null) assertOperationEnvelope(request as WikiOperationRequest<MockWikiOperationPlan>);
    assertPlanPaths(proposedPlan);
    assertPlanPreconditions(proposedPlan, request.expectedRevisions);
    this.assertExpectedRevisions(request.expectedRevisions);
    const preview = this.planOperation(request, proposedPlan);
    if (stableStringify(request.plan) !== stableStringify(preview.plan)) {
      throw problem(
        "REVISION_CONFLICT",
        409,
        `The engine patch plan for ${request.operation.opId} is no longer current.`,
      );
    }
    if (!preview.valid) {
      throw new MexPortError({
        title: "Wiki operation validation failed",
        status: 422,
        code: "VALIDATION_FAILED",
        detail: `Operation ${request.operation.opId} is not valid.`,
        diagnostics: preview.validation.diagnostics,
      });
    }
    if (request.expectedPreviewRevision !== preview.previewRevision) {
      throw problem(
        "REVISION_CONFLICT",
        409,
        `Preview ${request.expectedPreviewRevision} is no longer current.`,
      );
    }

    const next = applyMockPlanWithAudit(
      cloneState(this.canonical),
      request,
      request.plan,
    );
    this.canonical = next;
    this.effects.canonicalWrites += preview.changes.length;
    this.effects.indexRefreshes += 1;
    this.effects.auditEntries += 1;
    const refreshDiagnostics: Diagnostic[] = [];
    let indexRefresh: WikiOperationResult["indexRefresh"];
    if (this.failNextIndexRefresh) {
      this.failNextIndexRefresh = false;
      this.indexState = "rebuild_required";
      const diagnostic: Diagnostic = {
        code: "INDEX_REFRESH_REQUIRED",
        severity: "warning",
        message: "Canonical Markdown was applied, but the disposable Wiki index needs rebuilding.",
      };
      refreshDiagnostics.push(diagnostic);
      indexRefresh = { state: "rebuild_required", diagnostic };
    } else {
      this.index = cloneState(next);
      this.indexState = "fresh";
      this.indexedAt = this.now();
      indexRefresh = { state: "refreshed", indexedRevision: digestState(this.index) };
    }

    const changedPaths = new Set(preview.changes.flatMap((change) => (
      change.previousPath ? [change.previousPath, change.path] : [change.path]
    )));
    const resultingVersions = Object.fromEntries(
      [...this.canonical.entities.values()]
        .filter((entity) => changedPaths.has(entity.sourcePath))
        .sort(byEntityIdentity)
        .map((entity) => [entity.id, versionForEntity(entity, this.canonical)]),
    );
    const result: WikiOperationResult = {
      operationId: request.operation.opId,
      previewRevision: preview.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: preview.changes,
      resultingVersions,
      audit: { appended: true, path: ".mex/events/operations.jsonl" },
      indexRefresh,
      diagnostics: refreshDiagnostics,
    };
    this.appliedOperations.set(request.operation.opId, { requestDigest, result });
    return result;
  }

  async inspectIndex(): Promise<WikiIndexStatus> {
    return {
      state: this.indexState,
      observedAt: this.now(),
      schemaVersion: this.indexState === "missing" ? null : 1,
      indexedRevision: this.indexedAt ? digestState(this.index) : null,
      indexedAt: this.indexedAt,
      diagnostics: indexDiagnostics(this.indexState),
    };
  }

  async refreshFiles(
    paths: readonly RepoRelativePath[],
    context: OperationContext = {},
  ): Promise<WikiRefreshResult> {
    if (paths.length === 0) {
      throw problem("INVALID_REQUEST", 400, "At least one Wiki file is required for refresh.");
    }
    throwIfAborted(context);
    const uniquePaths = [...new Set(paths)].sort(compareCodePoints);
    const canonicalFiles = renderFiles(this.canonical);
    for (const path of uniquePaths) {
      assertWikiPath(path);
      if (!canonicalFiles.has(path)) {
        throw problem("NOT_FOUND", 404, `Wiki file ${path} was not found.`);
      }
    }

    const startedAt = this.now();
    context.reportProgress?.({
      phase: "refresh",
      completed: 0,
      total: uniquePaths.length,
      message: "Refreshing selected Wiki files.",
    });
    this.index = refreshStatePaths(this.index, this.canonical, uniquePaths);
    this.indexState = digestState(this.index) === digestState(this.canonical) ? "fresh" : "stale";
    this.indexedAt = this.now();
    this.effects.indexRefreshes += 1;
    const refreshedIds = new Set(
      [...this.index.entities.values()]
        .filter((entity) => uniquePaths.includes(entity.sourcePath))
        .map((entity) => entity.id),
    );
    context.reportProgress?.({
      phase: "refresh",
      completed: uniquePaths.length,
      total: uniquePaths.length,
      message: "Selected Wiki files refreshed.",
    });
    return {
      state: "succeeded",
      startedAt,
      finishedAt: this.now(),
      diagnostics: [],
      filesRefreshed: uniquePaths.length,
      entitiesIndexed: refreshedIds.size,
      relationsIndexed: this.index.relations.filter((relation) => (
        refreshedIds.has(relation.source.id) || refreshedIds.has(relation.target.id)
      )).length,
      indexedRevision: digestState(this.index),
    };
  }

  async rebuildIndex(context: OperationContext = {}): Promise<WikiRebuildResult> {
    throwIfAborted(context);
    const startedAt = this.now();
    context.reportProgress?.({ phase: "validate", message: "Validating canonical Wiki files." });
    const validation = await this.validate();
    if (!validation.valid) {
      throw new MexPortError({
        title: "Wiki rebuild failed",
        status: 422,
        code: "VALIDATION_FAILED",
        detail: "Canonical Wiki content is invalid.",
        diagnostics: validation.diagnostics,
      });
    }
    this.index = cloneState(this.canonical);
    this.indexState = "fresh";
    this.indexedAt = this.now();
    this.effects.indexRebuilds += 1;
    context.reportProgress?.({
      phase: "index",
      completed: this.index.entities.size,
      total: this.index.entities.size,
      message: "Canonical Wiki index rebuilt.",
    });
    return {
      state: "succeeded",
      startedAt,
      finishedAt: this.now(),
      diagnostics: [],
      entitiesIndexed: this.index.entities.size,
      relationsIndexed: this.index.relations.length,
      indexedRevision: digestState(this.index),
    };
  }

  async planMigration(
    options: WikiMigrationOptions = {},
  ): Promise<WikiMigrationPreview<MockWikiMigrationPlan>> {
    const migration = this.requireLegacyMigration();
    for (const path of options.paths ?? []) assertWikiPath(path);
    const selectedPaths = options.paths ? new Set(options.paths) : null;
    const currentFiles = renderFiles(this.canonical);
    const files = Object.keys(migration.documents)
      .filter((path) => !selectedPaths || selectedPaths.has(path))
      .sort(compareCodePoints)
      .map((path) => ({
        path,
        before: currentFiles.get(path) ?? migration.documents[path]!,
        after: migration.migratedDocuments[path] ?? migration.documents[path]!,
      }));
    const plan: MockWikiMigrationPlan = {
      files,
      entities: migration.entities.filter((entity) => files.some((file) => file.path === entity.sourcePath)),
      relations: migration.relations ?? [],
    };
    const changes = files
      .filter((file) => file.before !== file.after)
      .map((file) => changeFor(file.path, file.before, file.after));
    const expectedRevisions: WikiRevisionExpectation[] = files.map((file) => ({
      target: { kind: "artifact", path: file.path },
      contentHash: hash(file.before),
    }));
    const report = migrationReport(plan, false);
    const migrationId = `migration_${hash(stableStringify(files.map((file) => file.path))).slice(0, 16)}`;
    const previewRevision = hash(stableStringify({
      migrationId,
      plan,
      expectedRevisions,
      changes,
      report,
    }));
    return {
      migrationId,
      previewRevision,
      plan,
      expectedRevisions,
      changes,
      report,
      validation: { valid: true, diagnostics: [] },
    };
  }

  async applyMigration(
    request: WikiMigrationApplyRequest<MockWikiMigrationPlan>,
  ): Promise<WikiMigrationResult> {
    const requestDigest = hash(stableStringify(request));
    const previous = this.appliedMigrations.get(request.migrationId);
    if (previous) {
      if (previous.requestDigest !== requestDigest) {
        throw problem(
          "VALIDATION_FAILED",
          422,
          `Migration ${request.migrationId} was already used with a different plan.`,
        );
      }
      return { ...previous.result, idempotentReplay: true };
    }

    this.assertExpectedRevisions(request.expectedRevisions);
    const expected = await this.planMigration({ paths: request.plan.files.map((file) => file.path) });
    if (expected.previewRevision !== request.previewRevision
      || stableStringify(expected.plan) !== stableStringify(request.plan)
      || stableStringify(expected.expectedRevisions) !== stableStringify(request.expectedRevisions)) {
      throw problem("REVISION_CONFLICT", 409, "Migration preview is no longer current.");
    }

    const next = cloneState(this.canonical);
    for (const file of request.plan.files) next.fileOverrides.set(file.path, file.after);
    for (const entity of request.plan.entities) next.entities.set(entity.id, cloneEntity(entity));
    next.relations.push(...request.plan.relations.map(cloneRelation));
    this.canonical = next;
    this.index = cloneState(next);
    this.indexState = "fresh";
    this.indexedAt = this.now();
    this.effects.canonicalWrites += expected.changes.length;
    this.effects.indexRefreshes += 1;
    this.effects.auditEntries += expected.changes.length > 0 ? 1 : 0;

    const result: WikiMigrationResult = {
      migrationId: request.migrationId,
      applied: true,
      idempotentReplay: false,
      changes: expected.changes,
      report: migrationReport(request.plan, true),
      diagnostics: [],
    };
    this.appliedMigrations.set(request.migrationId, { requestDigest, result });
    return result;
  }

  snapshot(): MockWikiSnapshot {
    return {
      canonicalDigest: digestState(this.canonical),
      indexDigest: digestState(this.index),
      files: Object.fromEntries(renderFiles(this.canonical)),
      effects: { ...this.effects },
    };
  }

  /** Test-driver hook that models an external manual Markdown edit. */
  simulateManualBodyEdit(entityId: EntityId, body: string): void {
    const entity = this.canonical.entities.get(entityId);
    if (!entity) throw new Error(`Cannot edit missing mock Wiki entity ${entityId}.`);
    this.canonical.entities.set(entityId, {
      ...cloneEntity(entity),
      payload: { ...entity.payload, body },
    });
    this.indexState = "stale";
  }

  /** Test-driver hook that models an external edit to a non-entity Wiki file. */
  simulateManualFileEdit(path: RepoRelativePath, content: string): void {
    assertWikiPath(path);
    if (!renderFiles(this.canonical).has(path)) {
      throw new Error(`Cannot edit missing mock Wiki file ${path}.`);
    }
    this.canonical.fileOverrides.set(path, content);
    this.indexState = "stale";
  }

  private requireIndexedEntity(id: EntityId): MockWikiEntitySeed {
    const entity = this.index.entities.get(id);
    if (!entity) throw problem("NOT_FOUND", 404, `Wiki entity ${id} was not found.`);
    return entity;
  }

  private requireReadableIndex(): void {
    if (this.indexState === "missing") {
      throw problem("INDEX_MISSING", 503, "The Wiki index is missing. Rebuild it explicitly.");
    }
    if (this.indexState === "corrupt") {
      throw problem("INDEX_CORRUPT", 503, "The Wiki index is corrupt. Rebuild it explicitly.");
    }
    if (this.indexState === "migration_required") {
      throw problem("MIGRATION_REQUIRED", 409, "The Wiki requires an explicit migration.");
    }
    if (this.indexState === "rebuild_required") {
      throw problem("INDEX_STALE", 409, "The Wiki index requires an explicit rebuild.");
    }
  }

  private assertExpectedRevisions(expectations: readonly WikiRevisionExpectation[]): void {
    const files = renderFiles(this.canonical);
    const seen = new Set<string>();
    for (const expectation of expectations) {
      const label = revisionTargetLabel(expectation);
      if (seen.has(label)) {
        throw problem("INVALID_REQUEST", 400, `Duplicate revision expectation for ${label}.`);
      }
      seen.add(label);
      if ("version" in expectation) {
        const entity = this.canonical.entities.get(expectation.target.id);
        const actual = entity ? versionForEntity(entity, this.canonical) : null;
        if (stableStringify(actual) !== stableStringify(expectation.version)) {
          throw problem("REVISION_CONFLICT", 409, `Revision conflict for ${label}.`);
        }
      } else {
        const bytes = files.get(expectation.target.path);
        const actual = bytes === undefined ? null : hash(bytes);
        if (actual !== expectation.contentHash) {
          throw problem("REVISION_CONFLICT", 409, `Revision conflict for ${label}.`);
        }
      }
    }
  }

  private planOperation(
    request: WikiOperationRequest<unknown>,
    proposedPlan?: MockWikiOperationPlan,
  ): WikiOperationPreview<MockWikiOperationPlan> {
    const plan = cloneOperationPlan(
      proposedPlan ?? request.operation.payload as MockWikiOperationPlan,
    );
    let next: State;
    let diagnostics: readonly Diagnostic[];
    try {
      next = applyMockPlanWithAudit(cloneState(this.canonical), request, plan);
      diagnostics = validateState(next, this.duplicateIds);
    } catch (error) {
      if (!(error instanceof MexPortError)) throw error;
      next = cloneState(this.canonical);
      diagnostics = error.problem.diagnostics ?? [{
        code: error.problem.code,
        severity: "error",
        message: error.problem.detail,
      }];
    }
    const changes = diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? []
      : diffStates(this.canonical, next);
    const affectedEntities = affectedRefs(plan, next);
    const previewRevision = hash(stableStringify({
      operation: request.operation,
      expectedRevisions: request.expectedRevisions,
      plan,
      changes,
    }));
    return {
      operationId: request.operation.opId,
      plan,
      previewRevision,
      valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
      changes,
      affectedEntities,
      validation: {
        valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
        diagnostics,
      },
    };
  }

  private requireLegacyMigration(): MockLegacyMigration {
    if (!this.legacyMigration) {
      throw problem("MIGRATION_REQUIRED", 409, "No legacy migration fixture is configured.");
    }
    return this.legacyMigration;
  }
}

function stateFromFixture(fixture: PopulatedWikiFixture): State {
  return {
    entities: new Map(fixture.entities.map((entity) => [entity.id, cloneEntity(entity)])),
    relations: fixture.relations.map(cloneRelation),
    fileOverrides: new Map([[".mex/events/operations.jsonl", INITIAL_OPERATION_AUDIT]]),
  };
}

function cloneState(state: State): State {
  return {
    entities: new Map([...state.entities].map(([id, entity]) => [id, cloneEntity(entity)])),
    relations: state.relations.map(cloneRelation),
    fileOverrides: new Map(state.fileOverrides),
  };
}

function refreshStatePaths(
  indexed: State,
  canonical: State,
  paths: readonly RepoRelativePath[],
): State {
  const selected = new Set(paths);
  const next = cloneState(indexed);
  const affectedIds = new Set<string>();
  for (const entity of next.entities.values()) {
    if (selected.has(entity.sourcePath)) affectedIds.add(entity.id);
  }
  for (const entity of canonical.entities.values()) {
    if (selected.has(entity.sourcePath)) affectedIds.add(entity.id);
  }
  for (const id of affectedIds) next.entities.delete(id);
  for (const entity of canonical.entities.values()) {
    if (selected.has(entity.sourcePath)) next.entities.set(entity.id, cloneEntity(entity));
  }

  for (const path of selected) {
    next.fileOverrides.delete(path);
    const canonicalOverride = canonical.fileOverrides.get(path);
    if (canonicalOverride !== undefined) next.fileOverrides.set(path, canonicalOverride);
  }

  const retainedRelations = next.relations.filter((relation) => (
    !affectedIds.has(relation.source.id) && !affectedIds.has(relation.target.id)
  ));
  const refreshedRelations = canonical.relations.filter((relation) => (
    affectedIds.has(relation.source.id) || affectedIds.has(relation.target.id)
  ));
  next.relations = [...new Map(
    [...retainedRelations, ...refreshedRelations]
      .map((relation) => [relationKey(relation), cloneRelation(relation)]),
  ).values()].sort((left, right) => compareCodePoints(relationKey(left), relationKey(right)));
  return next;
}

function cloneEntity(entity: MockWikiEntitySeed): MockWikiEntitySeed {
  return {
    ...entity,
    payload: {
      ...entity.payload,
      topics: [...entity.payload.topics],
      sources: entity.payload.sources.map((source) => ({ ...source })),
    },
  };
}

function cloneRelation(relation: WikiRelation): WikiRelation {
  return {
    type: relation.type,
    source: { ...relation.source },
    target: { ...relation.target },
    ...(relation.note === undefined ? {} : { note: relation.note }),
    ...(relation.metadata === undefined ? {} : { metadata: { ...relation.metadata } }),
  };
}

function cloneOperationPlan(plan: MockWikiOperationPlan): MockWikiOperationPlan {
  return {
    operations: plan.operations.map((operation): MockWikiOperation => {
      if (operation.type === "create-entry") {
        return { type: operation.type, entity: cloneEntity(operation.entity) };
      }
      if (operation.type === "add-relation") {
        return { type: operation.type, relation: cloneRelation(operation.relation) };
      }
      return { ...operation };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertForcedCreateEnvelope(
  request: WikiOperationRequest<MockWikiOperationInput>,
): asserts request is WikiOperationRequest<MockWikiForcedCreatePayload> {
  const { operation } = request;
  if (!operation.opId.trim()) {
    throw problem("INVALID_REQUEST", 400, "Wiki operation ID must not be empty.");
  }
  if (!operation.actor.id.trim()) {
    throw problem("INVALID_REQUEST", 400, "Wiki operation actor ID must not be empty.");
  }
  if (!operation.timestamp.trim() || Number.isNaN(Date.parse(operation.timestamp))) {
    throw problem("INVALID_REQUEST", 400, "Wiki operation timestamp must be an ISO timestamp.");
  }
  const operations = operation.payload?.operations;
  const primary = Array.isArray(operations) ? operations[0] : undefined;
  if (operation.type !== "create-entry"
    || !Array.isArray(operations)
    || operations.length !== 1
    || primary?.type !== "create-entry"
    || !isRecord(primary.entity)
    || Object.prototype.hasOwnProperty.call(primary.entity, "id")
    || operation.entityId !== undefined
    || operation.baseRevision !== undefined
    || operation.baseContentHash !== undefined) {
    throw problem(
      "VALIDATION_FAILED",
      422,
      "Receipt-bound Wiki preview accepts exactly one direct create with no caller-provided entity ID.",
    );
  }
}

function materializeForcedCreatePlan(
  payload: MockWikiForcedCreatePayload,
  createdId: EntityId,
): MockWikiOperationPlan {
  const operation = payload.operations[0];
  return {
    operations: [{
      type: "create-entry",
      entity: cloneEntity({ ...operation.entity, id: createdId }),
    }],
  };
}

function forcedCreatePlanForApply(
  request: WikiOperationApplyRequest<MockWikiOperationInput, MockWikiOperationPlan>,
): MockWikiOperationPlan | null {
  const operations = request.operation.payload?.operations;
  const primary = Array.isArray(operations) ? operations[0] : undefined;
  if (primary?.type !== "create-entry"
    || !isRecord(primary.entity)
    || primary.entity.id !== undefined) {
    return null;
  }
  assertForcedCreateEnvelope(request);
  const plannedOperations = request.plan?.operations;
  const planned = Array.isArray(plannedOperations) ? plannedOperations[0] : undefined;
  if (!Array.isArray(plannedOperations)
    || plannedOperations.length !== 1
    || planned?.type !== "create-entry"
    || !isWikiMintedEntityId(planned.entity.id)) {
    throw problem(
      "VALIDATION_FAILED",
      422,
      "A receipt-bound Wiki apply requires the one concrete plan returned by preview.",
    );
  }
  const { id: _createdId, ...plannedInput } = planned.entity;
  if (stableStringify(plannedInput) !== stableStringify(primary.entity)) {
    throw problem(
      "REVISION_CONFLICT",
      409,
      "The receipt-bound Wiki create plan does not match the reviewed ID-less request.",
    );
  }
  return cloneOperationPlan(request.plan);
}

function assertOperationEnvelope(
  request: WikiOperationRequest<MockWikiOperationPlan>,
): void {
  const { operation } = request;
  if (!operation.opId.trim()) {
    throw problem("INVALID_REQUEST", 400, "Wiki operation ID must not be empty.");
  }
  if (!operation.actor.id.trim()) {
    throw problem("INVALID_REQUEST", 400, "Wiki operation actor ID must not be empty.");
  }
  if (!operation.timestamp.trim() || Number.isNaN(Date.parse(operation.timestamp))) {
    throw problem("INVALID_REQUEST", 400, "Wiki operation timestamp must be an ISO timestamp.");
  }
  const primary = operation.payload.operations[0];
  if (primary && primary.type !== operation.type) {
    throw problem(
      "VALIDATION_FAILED",
      422,
      "The operation envelope type must match the primary proposed operation.",
    );
  }
  if (!primary) return;
  const primaryEntityId = primary.type === "create-entry" ? primary.entity.id
    : primary.type === "add-relation" ? primary.relation.source.id
      : primary.entityId;
  if (operation.entityId !== primaryEntityId) {
    throw problem(
      "VALIDATION_FAILED",
      422,
      "The operation envelope entity must match the primary proposed target.",
    );
  }
  const expectation = request.expectedRevisions.find((candidate) => (
    "version" in candidate && candidate.target.id === primaryEntityId
  ));
  if (primary.type === "create-entry") {
    if (operation.baseRevision !== undefined || operation.baseContentHash !== undefined) {
      throw problem(
        "VALIDATION_FAILED",
        422,
        "A create operation must not claim an existing base version.",
      );
    }
    return;
  }
  if (operation.baseRevision === undefined || operation.baseContentHash === undefined) {
    throw problem(
      "VALIDATION_FAILED",
      422,
      "An existing-entity operation requires both base revision and content hash.",
    );
  }
  if (expectation && "version" in expectation && expectation.version !== null
    && (operation.baseRevision !== expectation.version.semanticRevision
      || operation.baseContentHash !== expectation.version.contentHash)) {
    throw problem(
      "VALIDATION_FAILED",
      422,
      "The operation envelope base version must match its optimistic precondition.",
    );
  }
}

function matchesListFilters(entity: MockWikiEntitySeed, request: WikiListRequest): boolean {
  if (!request.includeArchived && entity.lifecycleState === "archived") return false;
  if (request.kinds && !request.kinds.includes(entity.kind)) return false;
  if (request.lifecycleStates && !request.lifecycleStates.includes(entity.lifecycleState)) return false;
  if (request.groundingHealth && !request.groundingHealth.includes(entity.groundingHealth)) {
    return false;
  }
  if (request.topics
    && !request.topics.some((topic) => entity.payload.topics.includes(topic))) return false;
  const sourceTypes = wikiSources(entity).map((source) => source.type);
  if (request.sourceTypes
    && !request.sourceTypes.some((sourceType) => sourceTypes.includes(sourceType))) return false;
  return true;
}

function relationsForEntity(
  state: State,
  entityId: EntityId,
  direction: "outgoing" | "incoming" | "both",
): WikiRelation[] {
  return state.relations.filter((relation) => {
    const outgoing = relation.source.id === entityId;
    const incoming = relation.target.id === entityId;
    return direction === "outgoing" ? outgoing
      : direction === "incoming" ? incoming
        : outgoing || incoming;
  });
}

function applyMockPlanWithAudit(
  state: State,
  request: WikiOperationRequest<unknown>,
  plan: MockWikiOperationPlan,
): State {
  const before = cloneState(state);
  const next = applyMockPlan(state, plan);
  const knowledgeChanges = diffStates(before, next);
  const entities = affectedRefs(plan, next);
  const expectedVersions = new Map(request.expectedRevisions.flatMap((expectation) => (
    "version" in expectation && expectation.version !== null
      ? [[expectation.target.id, expectation.version.semanticRevision] as const]
      : []
  )));
  const revisions = entities.map((entity) => ({
    id: entity.id,
    before: expectedVersions.get(entity.id) ?? null,
    after: next.entities.get(entity.id)?.semanticRevision ?? null,
  }));
  const auditEntry = stableStringify({
    opId: request.operation.opId,
    type: request.operation.type,
    entityIds: entities.map((entity) => entity.id),
    actor: request.operation.actor,
    timestamp: request.operation.timestamp,
    ...(request.operation.reason === undefined ? {} : { reason: request.operation.reason }),
    filesChanged: knowledgeChanges.map((change) => change.path),
    revisions,
  });
  const auditPath = ".mex/events/operations.jsonl";
  const existingAudit = renderFiles(next).get(auditPath) ?? "";
  const separator = existingAudit.length > 0 && !existingAudit.endsWith("\n") ? "\n" : "";
  next.fileOverrides.set(auditPath, `${existingAudit}${separator}${auditEntry}\n`);
  return next;
}

function applyMockPlan(state: State, plan: MockWikiOperationPlan): State {
  if (plan.operations.length === 0) {
    throw problem("VALIDATION_FAILED", 422, "A Wiki operation plan must contain an operation.");
  }
  for (const operation of plan.operations) {
    if (operation.type === "create-entry") {
      if (state.entities.has(operation.entity.id)) {
        throw problem("VALIDATION_FAILED", 422, `Entity ${operation.entity.id} already exists.`);
      }
      state.entities.set(operation.entity.id, cloneEntity(operation.entity));
      continue;
    }

    if (operation.type === "add-relation") {
      if (!state.entities.has(operation.relation.source.id)
        || !state.entities.has(operation.relation.target.id)) {
        throw problem("VALIDATION_FAILED", 422, "A relation endpoint does not exist.");
      }
      state.relations.push(cloneRelation(operation.relation));
      incrementSemanticRevision(state, operation.relation.source.id);
      continue;
    }

    const entity = state.entities.get(operation.entityId);
    if (!entity) throw problem("NOT_FOUND", 404, `Entity ${operation.entityId} was not found.`);
    if (operation.type === "move-entry") {
      state.entities.set(operation.entityId, {
        ...cloneEntity(entity),
        sourcePath: operation.destinationPath,
        semanticRevision: entity.semanticRevision + 1,
      });
      continue;
    }
    if (operation.type === "archive-entry") {
      state.entities.set(operation.entityId, {
        ...cloneEntity(entity),
        lifecycleState: "archived",
        semanticRevision: entity.semanticRevision + 1,
      });
      continue;
    }
    state.entities.set(operation.entityId, {
      ...cloneEntity(entity),
      title: operation.title ?? entity.title,
      lifecycleState: operation.lifecycleState ?? entity.lifecycleState,
      semanticRevision: entity.semanticRevision + 1,
      payload: {
        ...entity.payload,
        summary: operation.summary ?? entity.payload.summary,
        body: operation.body ?? entity.payload.body,
      },
    });
  }
  return state;
}

function incrementSemanticRevision(state: State, entityId: string): void {
  const entity = state.entities.get(entityId);
  if (!entity) return;
  state.entities.set(entityId, {
    ...cloneEntity(entity),
    semanticRevision: entity.semanticRevision + 1,
  });
}

function assertPlanPreconditions(
  plan: MockWikiOperationPlan,
  expectations: readonly WikiRevisionExpectation[],
): void {
  const entityExpectations = new Map(expectations.flatMap((expectation) => (
    "version" in expectation
      ? [[expectation.target.id, expectation.version] as const]
      : []
  )));
  for (const operation of plan.operations) {
    const targetId = operation.type === "create-entry" ? operation.entity.id
      : operation.type === "add-relation" ? operation.relation.source.id
        : operation.entityId;
    if (!entityExpectations.has(targetId)) {
      throw problem(
        "VALIDATION_FAILED",
        422,
        `Operation target ${targetId} is missing an optimistic revision precondition.`,
      );
    }
    const expected = entityExpectations.get(targetId);
    if (operation.type === "create-entry" && expected !== null) {
      throw problem(
        "VALIDATION_FAILED",
        422,
        `Create target ${targetId} must use a null version precondition.`,
      );
    }
    if (operation.type !== "create-entry" && expected === null) {
      throw problem(
        "VALIDATION_FAILED",
        422,
        `Existing target ${targetId} requires an entity version precondition.`,
      );
    }
  }
}

function assertPlanPaths(plan: MockWikiOperationPlan): void {
  for (const operation of plan.operations) {
    const path = operation.type === "create-entry" ? operation.entity.sourcePath
      : operation.type === "move-entry" ? operation.destinationPath
        : undefined;
    if (path !== undefined && (!isRepoRelativePath(path) || !path.startsWith(".mex/"))) {
      throw problem(
        "PATH_OUTSIDE_PROJECT",
        400,
        `Wiki operation path ${JSON.stringify(path)} is outside the scaffold.`,
      );
    }
  }
}

function validateState(state: State, duplicateIds: readonly string[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = duplicateIds.map((id) => ({
    code: "DUPLICATE_ENTITY_ID",
    severity: "error",
    message: `Entity ID ${id} appears more than once.`,
    entity: { id, kind: "unknown" },
  }));
  const triples = new Set<string>();
  const supportedRelationTypes = new Set<string>(WIKI_RELATION_TYPES);
  for (const relation of state.relations) {
    const triple = relationKey(relation);
    if (triples.has(triple)) {
      diagnostics.push({
        code: "DUPLICATE_RELATION",
        severity: "error",
        message: `Duplicate Wiki relation ${triple}.`,
        entity: relation.source,
      });
    }
    triples.add(triple);
    if (!supportedRelationTypes.has(relation.type)) {
      diagnostics.push({
        code: "INVALID_RELATION_TYPE",
        severity: "error",
        message: `Relation ${triple} uses an unregistered type.`,
        entity: relation.source,
      });
    }
    if (!state.entities.has(relation.source.id) || !state.entities.has(relation.target.id)) {
      diagnostics.push({
        code: "INVALID_RELATION_TARGET",
        severity: "error",
        message: `Relation ${triple} has a missing endpoint.`,
        entity: relation.source,
      });
    }
    if (relation.source.id === relation.target.id) {
      diagnostics.push({
        code: "INVALID_RELATION_TARGET",
        severity: "error",
        message: `Relation ${triple} is self-referential.`,
        entity: relation.source,
      });
    }
  }
  for (const entityId of supersessionCycleMembers(state.relations)) {
    const entity = state.entities.get(entityId);
    diagnostics.push({
      code: "SUPERSESSION_CYCLE",
      severity: "error",
      message: `Entity ${entityId} participates in a supersession cycle.`,
      entity: { id: entityId, kind: entity?.kind ?? "unknown" },
    });
  }
  return diagnostics.sort((left, right) => compareCodePoints(
    `${left.code}:${left.entity?.id ?? ""}`,
    `${right.code}:${right.entity?.id ?? ""}`,
  ));
}

function supersessionCycleMembers(relations: readonly WikiRelation[]): string[] {
  const outgoing = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.type !== "supersedes") continue;
    const targets = outgoing.get(relation.source.id) ?? [];
    targets.push(relation.target.id);
    outgoing.set(relation.source.id, targets);
  }
  const cyclic = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      for (const member of path.slice(cycleStart)) cyclic.add(member);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const nextPath = [...path, id];
    for (const target of outgoing.get(id) ?? []) visit(target, nextPath);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of outgoing.keys()) visit(id, []);
  return [...cyclic].sort(compareCodePoints);
}

function renderFiles(state: State): Map<string, string> {
  const byPath = new Map<string, MockWikiEntitySeed[]>();
  for (const entity of state.entities.values()) {
    const group = byPath.get(entity.sourcePath) ?? [];
    group.push(entity);
    byPath.set(entity.sourcePath, group);
  }
  const rendered = new Map(state.fileOverrides);
  for (const [path, entities] of byPath) {
    if (rendered.has(path)) continue;
    rendered.set(path, entities
      .sort(byEntityIdentity)
      .map((entity) => renderEntity(entity, state.relations))
      .join("\n"));
  }
  return new Map([...rendered].sort(([left], [right]) => compareCodePoints(left, right)));
}

function renderEntity(entity: MockWikiEntitySeed, relations: readonly WikiRelation[]): string {
  const outgoing = relations
    .filter((relation) => relation.source.id === entity.id)
    .sort((left, right) => compareCodePoints(relationKey(left), relationKey(right)));
  const metadata = [
    "<!-- mex:entity",
    `id: ${entity.id}`,
    `type: ${entity.kind}`,
    `status: ${entity.lifecycleState}`,
    `revision: ${entity.semanticRevision}`,
    `topics: ${stableStringify([...entity.payload.topics].sort())}`,
    `relations: ${stableStringify(outgoing.map((relation) => ({
      type: relation.type,
      target: relation.target.id,
    })))}`,
    `sources: ${stableStringify(entity.payload.sources)}`,
    "-->",
  ];
  return `${metadata.join("\n")}\n## ${entity.title}\n\n${entity.payload.body.trim()}\n`;
}

function toEntity(
  entity: MockWikiEntitySeed,
  state: State,
  observedAt: string,
): WikiEntity<MockWikiPayload> {
  const outgoing = state.relations
    .filter((relation) => relation.source.id === entity.id)
    .sort((left, right) => compareCodePoints(relationKey(left), relationKey(right)));
  const backlinks = state.relations
    .filter((relation) => relation.target.id === entity.id)
    .sort((left, right) => compareCodePoints(relationKey(left), relationKey(right)))
    .map(cloneRelation);
  return {
    ...toSummary(entity, state),
    body: entity.payload.body,
    relations: outgoing.map((relation) => ({
      type: relation.type,
      target: relation.target.id,
      ...(relation.note === undefined ? {} : { note: relation.note }),
      ...(relation.metadata === undefined ? {} : { metadata: { ...relation.metadata } }),
    })),
    backlinks,
    sources: wikiSources(entity),
    provenance: {
      kind: "system",
      id: "mock-populated-fixture",
      capturedAt: DEFAULT_NOW,
    },
    groundings: groundingResolutions(entity, observedAt),
    extension: cloneEntity(entity).payload,
  };
}

function toSummary(entity: MockWikiEntitySeed, state: State): WikiEntitySummary {
  return {
    ref: { id: entity.id, kind: entity.kind, title: entity.title },
    title: entity.title,
    summary: entity.payload.summary,
    location: { path: entity.sourcePath },
    version: versionForEntity(entity, state),
    lifecycleState: entity.lifecycleState,
    groundingHealth: aggregateWikiGroundingHealth(
      groundingResolutions(entity, DEFAULT_NOW),
    ),
    topics: [...entity.payload.topics].sort(compareCodePoints),
    sourceTypes: [...new Set(wikiSources(entity).map((source) => source.type))]
      .sort(compareCodePoints),
    diagnostics: [],
  };
}

function versionForEntity(entity: MockWikiEntitySeed, state: State): EntityVersion {
  const bytes = renderFiles(state).get(entity.sourcePath);
  if (bytes === undefined) throw new Error(`Missing rendered file ${entity.sourcePath}`);
  return { semanticRevision: entity.semanticRevision, contentHash: hash(bytes) };
}

function wikiSources(entity: MockWikiEntitySeed): WikiSource[] {
  return entity.payload.sources.map((source) => {
    const type = typeof source.type === "string" ? source.type : "manual";
    return {
      type,
      ...(typeof source.ref === "string" ? { ref: source.ref } : {}),
      ...(typeof source.note === "string" ? { note: source.note } : {}),
      ...(typeof source.repository === "string" ? { repository: source.repository } : {}),
      ...(typeof source.commit === "string" ? { commit: source.commit } : {}),
      ...(typeof source.capturedAt === "string" ? { capturedAt: source.capturedAt } : {}),
      ...(typeof source.resolved === "boolean" ? { resolved: source.resolved } : {}),
    };
  });
}

function groundingResolutions(
  entity: MockWikiEntitySeed,
  observedAt: string,
): WikiGroundingResolution[] {
  const groundingCase = entity.payload.groundingCase ?? entity.groundingHealth;
  const symbolSource = entity.payload.sources.find((source) => source.type === "symbol");
  const sourceRef = typeof symbolSource?.ref === "string" ? symbolSource.ref : entity.id;
  const requestedNode = `mex://${sourceRef}`;
  const grounding = {
    node: requestedNode,
    fingerprint: hash(`grounding:${entity.id}`),
    file: entity.sourcePath,
    verifiedAt: DEFAULT_NOW,
  };

  if (groundingCase === "renamed") {
    return [{
      grounding,
      state: "fresh",
      health: "fresh",
      requestedNode,
      resolvedNode: `${requestedNode}:renamed`,
      reason: "The symbol was deterministically reconciled after a rename.",
      observedAt,
    }];
  }
  if (groundingCase === "fresh") {
    return [{
      grounding,
      state: "fresh",
      health: "fresh",
      requestedNode,
      resolvedNode: requestedNode,
      reason: "The canonical grounding matches the current checkout.",
      observedAt,
    }];
  }
  if (groundingCase === "changed") {
    return [{
      grounding,
      state: "stale",
      health: "changed",
      requestedNode,
      resolvedNode: requestedNode,
      previousSource: "function persistCaptureAttempt()",
      currentSource: "function persistCaptureAttempt(attemptId: string)",
      reason: "The resolved code fingerprint differs from the canonical grounding.",
      observedAt,
    }];
  }
  if (groundingCase === "ambiguous") {
    return [{
      grounding,
      state: "unresolved",
      health: "ambiguous",
      requestedNode,
      candidates: [
        { node: `${requestedNode}:primary`, score: 0.8 },
        { node: `${requestedNode}:legacy`, score: 0.8 },
      ],
      reason: "More than one code node is an equally plausible grounding target.",
      observedAt,
    }];
  }
  if (groundingCase === "missing") {
    return [{
      grounding,
      state: "missing",
      health: "missing",
      requestedNode,
      reason: "The canonical grounding target is absent from this checkout.",
      observedAt,
    }];
  }
  return [{
    state: "ungrounded",
    health: "unverified",
    reason: "The fixture has not been verified against the local code graph.",
    observedAt,
  }];
}

function diffStates(before: State, after: State): FileChange[] {
  const beforeFiles = renderFiles(before);
  const afterFiles = renderFiles(after);
  const paths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  return [...paths]
    .sort()
    .flatMap((path) => {
      const previous = beforeFiles.get(path);
      const next = afterFiles.get(path);
      return previous === next ? [] : [changeFor(path, previous, next)];
    });
}

function changeFor(path: string, before?: string, after?: string): FileChange {
  const diff = unifiedDiff(path, before, after);
  if (before === undefined) {
    if (after === undefined) throw new Error(`Cannot diff absent file: ${path}`);
    return {
      kind: "create",
      path,
      beforeRevision: null,
      afterRevision: hash(after),
      diff,
    };
  }
  if (after === undefined) {
    return {
      kind: "delete",
      path,
      beforeRevision: hash(before),
      afterRevision: null,
      diff,
    };
  }
  return {
    kind: "update",
    path,
    beforeRevision: hash(before),
    afterRevision: hash(after),
    diff,
  };
}

function unifiedDiff(path: string, before?: string, after?: string): string {
  const oldPath = before === undefined ? "/dev/null" : `a/${path}`;
  const newPath = after === undefined ? "/dev/null" : `b/${path}`;
  const oldText = splitDiffText(before);
  const newText = splitDiffText(after);
  return [
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -1,${oldText.lines.length} +1,${newText.lines.length} @@`,
    ...renderDiffLines("-", oldText),
    ...renderDiffLines("+", newText),
    "",
  ].join("\n");
}

interface DiffText {
  lines: string[];
  hasFinalNewline: boolean;
}

function splitDiffText(value: string | undefined): DiffText {
  if (value === undefined || value.length === 0) {
    return { lines: [], hasFinalNewline: true };
  }
  const hasFinalNewline = value.endsWith("\n");
  const lines = value.split("\n");
  if (hasFinalNewline) lines.pop();
  return { lines, hasFinalNewline };
}

function renderDiffLines(prefix: "-" | "+", text: DiffText): string[] {
  const lines = text.lines.map((line) => `${prefix}${line}`);
  if (text.lines.length > 0 && !text.hasFinalNewline) {
    lines.push("\\ No newline at end of file");
  }
  return lines;
}

function affectedRefs(plan: MockWikiOperationPlan, state: State): EntityRef[] {
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    if (operation.type === "create-entry") ids.add(operation.entity.id);
    else if (operation.type === "add-relation") ids.add(operation.relation.source.id);
    else ids.add(operation.entityId);
  }
  return [...ids]
    .sort(compareCodePoints)
    .flatMap((id) => {
      const entity = state.entities.get(id);
      return entity ? [{ id, kind: entity.kind, title: entity.title }] : [];
    });
}

function isWikiMintedEntityId(value: unknown): value is EntityId {
  return typeof value === "string" && /^mx_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value);
}

function paginate<T>(
  items: readonly T[],
  request: { cursor?: string; limit?: number; maxTokens?: number },
): WikiPage<T> {
  if (request.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(request.cursor)) {
    throw problem("INVALID_REQUEST", 400, "Pagination cursor is invalid.");
  }
  const offset = request.cursor === undefined ? 0 : Number(request.cursor);
  if (!Number.isSafeInteger(offset)) {
    throw problem("INVALID_REQUEST", 400, "Pagination cursor is invalid.");
  }
  const requestedLimit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw problem("INVALID_REQUEST", 400, "Pagination limit must be positive.");
  }
  const limit = Math.min(requestedLimit, MAX_LIMIT);
  if (request.maxTokens !== undefined
    && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)) {
    throw problem("INVALID_REQUEST", 400, "Pagination maxTokens must be positive.");
  }
  const page: T[] = [];
  let estimatedTokens = 0;
  for (const item of items.slice(offset, offset + limit)) {
    const itemTokens = estimateTokens(item);
    if (request.maxTokens !== undefined && estimatedTokens + itemTokens > request.maxTokens) {
      break;
    }
    page.push(item);
    estimatedTokens += itemTokens;
  }
  if (page.length === 0 && offset < items.length && request.maxTokens !== undefined) {
    throw problem(
      "INVALID_REQUEST",
      400,
      "Pagination maxTokens is too small for the next result.",
    );
  }
  const nextOffset = offset + page.length;
  const truncated = nextOffset < items.length;
  return {
    items: page,
    nextCursor: truncated ? String(nextOffset) : null,
    estimatedTokens,
    truncated,
  };
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(stableStringify(value).length / 4));
}

function digestState(state: State): Revision {
  return hash(stableStringify({
    files: Object.fromEntries(renderFiles(state)),
    entities: [...state.entities.keys()].sort(compareCodePoints),
    relations: state.relations.map(relationKey).sort(compareCodePoints),
  }));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function hash(value: string): Revision {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byEntityIdentity(left: MockWikiEntitySeed, right: MockWikiEntitySeed): number {
  return compareCodePoints(left.kind, right.kind)
    || compareCodePoints(left.title, right.title)
    || compareCodePoints(left.id, right.id);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  if (leftPoints.length === rightPoints.length) return 0;
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

function relationKey(relation: WikiRelation): string {
  return `${relation.type}:${relation.source.id}:${relation.target.id}`;
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareCodePoints);
}

function revisionTargetLabel(expectation: WikiRevisionExpectation): string {
  return "version" in expectation
    ? `entity ${expectation.target.id}`
    : `artifact ${expectation.target.path}`;
}

function assertWikiPath(path: RepoRelativePath): void {
  if (!isRepoRelativePath(path) || !path.startsWith(".mex/")) {
    throw problem(
      "PATH_OUTSIDE_PROJECT",
      400,
      `Wiki path ${JSON.stringify(path)} is outside the scaffold.`,
    );
  }
}

function throwIfAborted(context: OperationContext): void {
  if (context.signal?.aborted) {
    throw problem("OPERATION_INTERRUPTED", 409, "The Wiki index operation was interrupted.");
  }
}

function migrationReport(
  plan: MockWikiMigrationPlan,
  applied: boolean,
): WikiMigrationReport {
  const byType = countEntitiesByKind(plan.entities);
  const groundingCases = plan.entities.map((entity) => entity.payload.groundingCase);
  return {
    filesScanned: plan.files.length,
    proposedByType: byType,
    ...(applied ? { createdByType: byType } : {}),
    idsPreserved: 0,
    ...(applied ? { idsGenerated: plan.entities.length } : {}),
    legacyEdges: { converted: plan.relations.length, ambiguous: 0 },
    groundings: {
      preserved: groundingCases.filter((value) => value === "renamed" || value === "changed").length,
      ambiguous: groundingCases.filter((value) => value === "ambiguous").length,
      unresolved: groundingCases.filter((value) => value === "missing" || value === "unverified").length,
    },
    filesUnchanged: plan.files
      .filter((file) => file.before === file.after)
      .map((file) => file.path)
      .sort(compareCodePoints),
    diagnostics: [],
  };
}

function countEntitiesByKind(
  entities: readonly MockWikiEntitySeed[],
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const entity of entities) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => compareCodePoints(left, right)));
}

function indexDiagnostics(state: WikiIndexState): Diagnostic[] {
  if (state === "fresh") return [];
  const code = state === "missing" ? "INDEX_MISSING"
    : state === "corrupt" ? "INDEX_CORRUPT"
      : state === "migration_required" ? "MIGRATION_REQUIRED"
        : "INDEX_STALE";
  return [{
    code,
    severity: state === "degraded" || state === "stale" ? "warning" : "error",
    message: `Wiki index state is ${state}.`,
  }];
}

function problem(code: ConstructorParameters<typeof MexPortError>[0]["code"], status: number, detail: string): MexPortError {
  return new MexPortError({
    title: code.toLowerCase().replaceAll("_", " "),
    status,
    code,
    detail,
  });
}

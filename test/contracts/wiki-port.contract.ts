import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  EntityRef,
  FileChange,
  GroundingHealth,
  Revision,
} from "../../src/team/contracts/shared.js";
import type {
  WikiMigrationPreview,
  WikiOperationRequest,
  WikiPort,
} from "../../src/team/contracts/wiki.js";

export type WikiContractScenario =
  | "populated"
  | "index-missing"
  | "index-stale"
  | "index-corrupt"
  | "index-refresh-failure"
  | "invalid-reference"
  | "legacy";

export interface WikiContractSnapshot {
  canonicalDigest: Revision;
  indexDigest: Revision;
  files: Readonly<Record<string, string>>;
  canonicalWrites: number;
  indexRebuilds: number;
  indexRefreshes: number;
  auditEntries: number;
  agentLaunches: number;
}

export interface WikiContractOracle {
  lookup: EntityRef;
  search: {
    text: string;
    expected: EntityRef;
    kind: string;
  };
  relation: {
    source: EntityRef;
    target: EntityRef;
    type: string;
  };
  groundingCases: Readonly<Record<
    "renamed" | "changed" | "ambiguous" | "missing" | "unverified",
    { ref: EntityRef; health: GroundingHealth }
  >>;
  lifecycleCases: {
    changedButCurrent: EntityRef;
    deprecatedButFresh: EntityRef;
  };
  archived: EntityRef;
  legacy?: {
    entity: EntityRef;
    sourcePath: string;
    eventsPath: string;
    preservedFragments: readonly string[];
  };
}

export type WikiOperationCase =
  | "valid-update"
  | "invalid-relation"
  | "valid-then-invalid"
  | "changed-replay"
  | "missing-precondition"
  | "envelope-target-mismatch"
  | "envelope-base-mismatch"
  | "outside-path";

export interface WikiPortContractHarness<
  TEntityExtension,
  TOperationPayload,
  TOperationPlan,
  TMigrationPlan,
> {
  port: WikiPort<TEntityExtension, TOperationPayload, TOperationPlan, TMigrationPlan>;
  oracle: WikiContractOracle;
  makeOperation(kind: WikiOperationCase): Promise<WikiOperationRequest<TOperationPayload>>;
  makeConcurrentEdit(): Promise<void>;
  makeUnindexedCanonicalEdits(): Promise<{
    selected: { entityId: string; path: string; body: string };
    untouched: { entityId: string; path: string; body: string };
  }>;
  makeMigrationConcurrentEdit(path: string): Promise<void>;
  snapshot(): Promise<WikiContractSnapshot>;
  close(): Promise<void>;
}

export interface WikiPortContractFactory<
  TEntityExtension,
  TOperationPayload,
  TOperationPlan,
  TMigrationPlan,
> {
  open(
    scenario: WikiContractScenario,
  ): Promise<WikiPortContractHarness<
    TEntityExtension,
    TOperationPayload,
    TOperationPlan,
    TMigrationPlan
  >>;
}

/**
 * Reusable consumer-owned conformance suite. The teammate adapter registers the
 * same suite once its implementation branch and commit are available.
 */
export function defineWikiPortContract<
  TEntityExtension,
  TOperationPayload,
  TOperationPlan,
  TMigrationPlan,
>(
  adapterName: string,
  factory: WikiPortContractFactory<
    TEntityExtension,
    TOperationPayload,
    TOperationPlan,
    TMigrationPlan
  >,
): void {
  const withHarness = async <T>(
    scenario: WikiContractScenario,
    run: (harness: WikiPortContractHarness<
      TEntityExtension,
      TOperationPayload,
      TOperationPlan,
      TMigrationPlan
    >) => Promise<T>,
  ): Promise<T> => {
    const harness = await factory.open(scenario);
    try {
      return await run(harness);
    } finally {
      await harness.close();
    }
  };

  describe(`${adapterName} WikiPort contract`, () => {
    it("looks up, lists, filters, and searches entities deterministically", async () => {
      await withHarness("populated", async ({ port, oracle }) => {
        const entity = await port.getEntity(oracle.lookup.id);
        expect(entity).toMatchObject({ ref: oracle.lookup });
        expect(entity?.body.length).toBeGreaterThan(0);
        expect(entity?.location.path).toMatch(/^\.mex\//);
        expect(entity?.version.semanticRevision).toBeGreaterThan(0);
        expect(entity?.version.contentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(entity?.diagnostics).toBeDefined();
        expect(await port.getEntity("mx_missing")).toBeNull();

        const first = await port.listEntities({ limit: 3 });
        const second = await port.listEntities({ limit: 3 });
        expect(first).toEqual(second);
        expect(first.items).toHaveLength(3);
        expect(first.nextCursor).not.toBeNull();
        expect(first.estimatedTokens).toBeGreaterThan(0);
        expect(first.truncated).toBe(true);
        await expectCode(() => port.listEntities({ cursor: "1junk" }), "INVALID_REQUEST");
        await expectCode(() => port.listEntities({ maxTokens: 1 }), "INVALID_REQUEST");

        const filtered = await port.listEntities({ kinds: [oracle.search.kind] });
        expect(filtered.items.length).toBeGreaterThan(0);
        expect(filtered.items.every((item) => item.ref.kind === oracle.search.kind)).toBe(true);

        const filteredSearch = await port.queryEntities({
          query: oracle.search.text,
          kinds: [oracle.search.kind],
        });
        expect(filteredSearch.items.length).toBeGreaterThan(0);
        expect(filteredSearch.items.every((hit) => (
          hit.entity.ref.kind === oracle.search.kind
        ))).toBe(true);

        expect((await port.listEntities()).items.map((item) => item.ref.id))
          .not.toContain(oracle.archived.id);
        expect((await port.queryEntities({ query: oracle.archived.id })).items).toEqual([]);
        expect((await port.listEntities({ includeArchived: true })).items.map((item) => item.ref.id))
          .toContain(oracle.archived.id);
        expect((await port.queryEntities({
          query: oracle.archived.id,
          includeArchived: true,
        })).items.map((hit) => hit.entity.ref.id)).toContain(oracle.archived.id);

        if (entity?.topics[0]) {
          const byTopic = await port.listEntities({ topics: [entity.topics[0]] });
          expect(byTopic.items.map((item) => item.ref.id)).toContain(entity.ref.id);
        }
        if (entity?.sourceTypes[0]) {
          const bySource = await port.listEntities({ sourceTypes: [entity.sourceTypes[0]] });
          expect(bySource.items.map((item) => item.ref.id)).toContain(entity.ref.id);
        }

        const search = await port.queryEntities({ query: oracle.search.text });
        expect(search.items.map((hit) => hit.entity.ref.id)).toContain(oracle.search.expected.id);
        expect(search.estimatedTokens).toBeGreaterThan(0);
        const repeated = await port.queryEntities({ query: oracle.search.text });
        expect(repeated).toEqual(search);
      });
    });

    it("keeps outgoing relations and derived backlinks in parity", async () => {
      await withHarness("populated", async ({ port, oracle }) => {
        const outgoing = await port.traverseRelations({
          entityId: oracle.relation.source.id,
          direction: "outgoing",
          relationTypes: [oracle.relation.type],
        });
        const incoming = await port.traverseRelations({
          entityId: oracle.relation.target.id,
          direction: "incoming",
          relationTypes: [oracle.relation.type],
        });
        const backlinks = await port.getBacklinks({
          entityId: oracle.relation.target.id,
          relationTypes: [oracle.relation.type],
        });
        expect(outgoing.items).toHaveLength(1);
        expect(incoming.items).toHaveLength(1);
        expect(backlinks.items).toHaveLength(1);
        expect(outgoing.items[0]!.relation).toEqual(incoming.items[0]!.relation);
        expect(backlinks.items[0]).toEqual(incoming.items[0]!.relation);
        expect(outgoing.items[0]).toMatchObject({ direction: "outgoing" });
        expect(incoming.items[0]).toMatchObject({ direction: "incoming" });

        const detail = await port.getEntity(oracle.relation.target.id);
        expect(detail?.backlinks).toContainEqual(incoming.items[0]!.relation);
        const neighborhood = await port.getNeighborhood({
          entityId: oracle.relation.source.id,
          direction: "outgoing",
          relationTypes: [oracle.relation.type],
          depth: 1,
          maxEntities: 10,
          maxTokens: 10_000,
        });
        expect(neighborhood.root.ref.id).toBe(oracle.relation.source.id);
        expect(neighborhood.entities.map((item) => item.ref.id))
          .toContain(oracle.relation.target.id);
        expect(neighborhood.relations).toContainEqual(outgoing.items[0]!.relation);
        expect(neighborhood.estimatedTokens).toBeGreaterThan(0);
        expect(neighborhood.truncated).toBe(false);
      });
    });

    it("keeps canonical lifecycle independent from local grounding health", async () => {
      await withHarness("populated", async ({ port, oracle }) => {
        const changed = await port.getEntity(oracle.lifecycleCases.changedButCurrent.id);
        const deprecated = await port.getEntity(oracle.lifecycleCases.deprecatedButFresh.id);
        expect(changed).toMatchObject({ lifecycleState: "promoted", groundingHealth: "changed" });
        expect(deprecated).toMatchObject({ lifecycleState: "deprecated", groundingHealth: "fresh" });

        for (const [groundingCase, expected] of Object.entries(oracle.groundingCases)) {
          const entity = await port.getEntity(expected.ref.id);
          expect(entity?.groundingHealth, groundingCase).toBe(expected.health);
          const resolutions = await port.getGroundingStatus(expected.ref.id);
          expect(resolutions.map((resolution) => resolution.health), groundingCase)
            .toContain(expected.health);
          expect(entity?.groundings).toEqual(resolutions);
        }
        const renamed = await port.getGroundingStatus(oracle.groundingCases.renamed.ref.id);
        expect(renamed[0]).toMatchObject({ state: "fresh", health: "fresh" });
        if (renamed[0]?.state !== "fresh") throw new Error("Expected a fresh renamed grounding.");
        expect(renamed[0].resolvedNode).not.toBe(renamed[0].requestedNode);
        expect((await port.getEntity(oracle.groundingCases.renamed.ref.id))?.groundingHealth)
          .toBe("fresh");
      });
    });

    it("performs lookup, query, validation, and health reads without writes or agents", async () => {
      await withHarness("populated", async ({ port, oracle, snapshot }) => {
        const before = await snapshot();
        await port.getEntity(oracle.lookup.id);
        await port.listEntities();
        await port.queryEntities({ query: oracle.search.text });
        await port.traverseRelations({ entityId: oracle.relation.source.id, direction: "both" });
        await port.getBacklinks({ entityId: oracle.relation.target.id });
        await port.getNeighborhood({
          entityId: oracle.relation.source.id,
          depth: 1,
          maxEntities: 10,
          maxTokens: 10_000,
        });
        await port.getGroundingStatus(oracle.lifecycleCases.changedButCurrent.id);
        await port.validate();
        await port.inspectIndex();
        expect(await snapshot()).toEqual(before);
        expect(before.agentLaunches).toBe(0);
      });
    });

    it("refreshes selected index files only through an explicit write-free index job", async () => {
      await withHarness("populated", async ({ port, oracle, snapshot }) => {
        const entity = await port.getEntity(oracle.lookup.id);
        if (!entity) throw new Error("Lookup fixture is missing.");
        const before = await snapshot();
        const result = await port.refreshFiles([entity.location.path]);
        const after = await snapshot();
        expect(result).toMatchObject({ state: "succeeded", filesRefreshed: 1 });
        expect(result.indexedRevision).toBe(after.indexDigest);
        expect(after.canonicalDigest).toBe(before.canonicalDigest);
        expect(after.files).toEqual(before.files);
        expect(after.canonicalWrites).toBe(before.canonicalWrites);
        expect(after.auditEntries).toBe(before.auditEntries);
        expect(after.indexRefreshes).toBe(before.indexRefreshes + 1);
        expect(after.agentLaunches).toBe(0);
      });
    });

    it("refreshes only selected stale files before reaching clean-rebuild parity", async () => {
      await withHarness("populated", async ({
        port,
        makeUnindexedCanonicalEdits,
        snapshot,
      }) => {
        const edits = await makeUnindexedCanonicalEdits();
        const before = await snapshot();
        expect(before.canonicalDigest).not.toBe(before.indexDigest);
        expect((await port.inspectIndex()).state).toBe("stale");
        expect((await port.getEntity(edits.selected.entityId))?.body).not.toBe(edits.selected.body);
        expect((await port.getEntity(edits.untouched.entityId))?.body).not.toBe(edits.untouched.body);

        await port.refreshFiles([edits.selected.path]);
        const partial = await snapshot();
        expect(partial.canonicalDigest).toBe(before.canonicalDigest);
        expect(partial.indexDigest).not.toBe(before.indexDigest);
        expect(partial.indexDigest).not.toBe(partial.canonicalDigest);
        expect((await port.inspectIndex()).state).toBe("stale");
        expect((await port.getEntity(edits.selected.entityId))?.body).toBe(edits.selected.body);
        expect((await port.getEntity(edits.untouched.entityId))?.body).not.toBe(edits.untouched.body);

        await port.refreshFiles([edits.untouched.path]);
        const complete = await snapshot();
        expect(complete.indexDigest).toBe(complete.canonicalDigest);
        expect((await port.inspectIndex()).state).toBe("fresh");
        expect((await port.getEntity(edits.untouched.entityId))?.body).toBe(edits.untouched.body);
        expect(complete.canonicalWrites).toBe(before.canonicalWrites);
        expect(complete.auditEntries).toBe(before.auditEntries);
      });
    });

    it("returns an exact, deterministic preview and applies the same diff", async () => {
      await withHarness("populated", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation("valid-update");
        expect(request.operation.opId.length).toBeGreaterThan(0);
        expect(request.operation.actor.id.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(request.operation.timestamp))).toBe(false);
        const before = await snapshot();
        const preview = await port.previewOperations(request);
        expect(preview.valid).toBe(true);
        expect(preview.changes.length).toBeGreaterThan(0);
        expect(preview.changes.map((change) => change.path))
          .toContain(".mex/events/operations.jsonl");
        expect(preview.operationId).toBe(request.operation.opId);
        expect(preview.plan).toBeDefined();
        expect(await port.previewOperations(request)).toEqual(preview);
        expect(await snapshot()).toEqual(before);

        const result = await port.applyOperations({
          ...request,
          plan: preview.plan,
          expectedPreviewRevision: preview.previewRevision,
        });
        expect(result.applied).toBe(true);
        expect(result.idempotentReplay).toBe(false);
        expect(result.previewRevision).toBe(preview.previewRevision);
        expect(result.changes).toEqual(preview.changes);
        expect(result.audit).toEqual({
          appended: true,
          path: ".mex/events/operations.jsonl",
        });
        expect(result.indexRefresh.state).toBe("refreshed");
        const after = await snapshot();
        expect(after.canonicalDigest).not.toBe(before.canonicalDigest);
        assertChangedFileScopeAndHashes(preview.changes, before.files, after.files);
        expect(after.canonicalWrites).toBe(before.canonicalWrites + preview.changes.length);
        expect(after.indexRefreshes).toBe(before.indexRefreshes + 1);
        expect(after.auditEntries).toBe(before.auditEntries + 1);
        expect(after.agentLaunches).toBe(0);
        const priorAuditBytes = before.files[".mex/events/operations.jsonl"];
        const auditBytes = after.files[".mex/events/operations.jsonl"];
        expect(priorAuditBytes?.length).toBeGreaterThan(0);
        expect(auditBytes).toBeDefined();
        expect(auditBytes!.startsWith(priorAuditBytes!)).toBe(true);
        const auditLine = auditBytes!.trimEnd().split("\n").at(-1);
        const audit = JSON.parse(auditLine ?? "{}") as Record<string, unknown>;
        expect(audit).toMatchObject({
          opId: request.operation.opId,
          type: request.operation.type,
          actor: request.operation.actor,
        });
        for (const prohibited of ["payload", "body", "prompt", "transcript", "sourceCode"]) {
          expect(audit).not.toHaveProperty(prohibited);
        }

        const changedPaths = new Set(preview.changes.flatMap((change) => (
          change.previousPath ? [change.previousPath, change.path] : [change.path]
        )));
        const entitiesOnChangedFiles = (await port.listEntities({ limit: 100 })).items
          .filter((entitySummary) => changedPaths.has(entitySummary.location.path));
        expect(Object.keys(result.resultingVersions).sort()).toEqual(
          entitiesOnChangedFiles.map((entitySummary) => entitySummary.ref.id).sort(),
        );
        for (const entitySummary of entitiesOnChangedFiles) {
          expect(result.resultingVersions[entitySummary.ref.id])
            .toEqual(entitySummary.version);
        }
      });
    });

    it("rejects stale concurrent application without a partial write", async () => {
      await withHarness("populated", async ({ port, makeOperation, makeConcurrentEdit, snapshot }) => {
        const request = await makeOperation("valid-update");
        const preview = await port.previewOperations(request);
        await makeConcurrentEdit();
        const afterConcurrentEdit = await snapshot();

        await expectCode(
          () => port.applyOperations({
            ...request,
            plan: preview.plan,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "REVISION_CONFLICT",
        );
        expect(await snapshot()).toEqual(afterConcurrentEdit);
      });
    });

    it("keeps valid canonical Markdown when disposable index refresh fails", async () => {
      await withHarness("index-refresh-failure", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation("valid-update");
        const preview = await port.previewOperations(request);
        const before = await snapshot();
        const result = await port.applyOperations({
          ...request,
          plan: preview.plan,
          expectedPreviewRevision: preview.previewRevision,
        });
        const after = await snapshot();
        expect(result.applied).toBe(true);
        expect(result.indexRefresh.state).toBe("rebuild_required");
        if (result.indexRefresh.state !== "rebuild_required") {
          throw new Error("Expected a rebuild-required index refresh result.");
        }
        expect(result.indexRefresh.diagnostic.code).toBe("INDEX_REFRESH_REQUIRED");
        expect(result.diagnostics.map((diagnostic) => diagnostic.code))
          .toContain("INDEX_REFRESH_REQUIRED");
        expect(after.canonicalDigest).not.toBe(before.canonicalDigest);
        expect(after.indexDigest).toBe(before.indexDigest);
        expect((await port.inspectIndex()).state).toBe("rebuild_required");

        await port.rebuildIndex();
        const rebuilt = await snapshot();
        expect(rebuilt.canonicalDigest).toBe(after.canonicalDigest);
        expect(rebuilt.indexDigest).toBe(rebuilt.canonicalDigest);
      });
    });

    it("rejects invalid operations without writes", async () => {
      await withHarness("populated", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation("invalid-relation");
        const before = await snapshot();
        const preview = await port.previewOperations(request);
        expect(preview.valid).toBe(false);
        expect(preview.changes).toEqual([]);
        expect(await snapshot()).toEqual(before);
        await expectCode(
          () => port.applyOperations({
            ...request,
            plan: preview.plan,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "VALIDATION_FAILED",
        );
        expect(await snapshot()).toEqual(before);
      });
    });

    it("rolls back an entire multi-operation proposal when a later item is invalid", async () => {
      await withHarness("populated", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation("valid-then-invalid");
        const before = await snapshot();
        const preview = await port.previewOperations(request);
        expect(preview.valid).toBe(false);
        expect(preview.changes).toEqual([]);
        await expectCode(
          () => port.applyOperations({
            ...request,
            plan: preview.plan,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "VALIDATION_FAILED",
        );
        expect(await snapshot()).toEqual(before);
      });
    });

    it("requires optimistic preconditions for every operation target", async () => {
      await withHarness("populated", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation("missing-precondition");
        const before = await snapshot();
        await expectCode(() => port.previewOperations(request), "VALIDATION_FAILED");
        expect(await snapshot()).toEqual(before);
      });
    });

    it.each([
      "envelope-target-mismatch",
      "envelope-base-mismatch",
    ] as const)("rejects a contradictory %s before preview", async (operationCase) => {
      await withHarness("populated", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation(operationCase);
        const before = await snapshot();
        await expectCode(() => port.previewOperations(request), "VALIDATION_FAILED");
        expect(await snapshot()).toEqual(before);
      });
    });

    it("rejects paths outside the scaffold before any write", async () => {
      await withHarness("populated", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation("outside-path");
        const before = await snapshot();
        await expectCode(() => port.previewOperations(request), "PATH_OUTSIDE_PROJECT");
        expect(await snapshot()).toEqual(before);
      });
    });

    it.each([
      "../outside.md",
      "/absolute/outside.md",
      "..\\outside.md",
    ])("rejects unsafe direct path input %s without hidden work", async (path) => {
      await withHarness("populated", async ({ port, snapshot }) => {
        const before = await snapshot();
        await expectCode(() => port.refreshFiles([path]), "PATH_OUTSIDE_PROJECT");
        await expectCode(() => port.validate({ paths: [path] }), "PATH_OUTSIDE_PROJECT");
        expect(await snapshot()).toEqual(before);
      });
      await withHarness("legacy", async ({ port, snapshot }) => {
        const before = await snapshot();
        await expectCode(() => port.planMigration({ paths: [path] }), "PATH_OUTSIDE_PROJECT");
        expect(await snapshot()).toEqual(before);
      });
    });

    it("makes exact operation retries idempotent and rejects operation-ID reuse", async () => {
      await withHarness("populated", async ({ port, makeOperation, snapshot }) => {
        const request = await makeOperation("valid-update");
        const preview = await port.previewOperations(request);
        const first = await port.applyOperations({
          ...request,
          plan: preview.plan,
          expectedPreviewRevision: preview.previewRevision,
        });
        const afterFirst = await snapshot();
        await expectCode(
          () => port.applyOperations({
            ...request,
            plan: preview.plan,
            expectedPreviewRevision: "0".repeat(64),
          }),
          "VALIDATION_FAILED",
        );
        expect(await snapshot()).toEqual(afterFirst);
        const retry = await port.applyOperations({
          ...request,
          plan: preview.plan,
          expectedPreviewRevision: preview.previewRevision,
        });
        expect(retry).toEqual({ ...first, idempotentReplay: true });
        expect(await snapshot()).toEqual(afterFirst);

        const changedReplay = await makeOperation("changed-replay");
        await expectCode(
          async () => {
            const changedPreview = await port.previewOperations(changedReplay);
            return port.applyOperations({
              ...changedReplay,
              plan: changedPreview.plan,
              expectedPreviewRevision: changedPreview.previewRevision,
            });
          },
          "VALIDATION_FAILED",
        );
        expect(await snapshot()).toEqual(afterFirst);
      });
    });

    it("reports an invalid reference without mutating canonical state", async () => {
      await withHarness("invalid-reference", async ({ port, snapshot }) => {
        const before = await snapshot();
        const validation = await port.validate();
        expect(validation.valid).toBe(false);
        expect(validation.diagnostics.map((diagnostic) => diagnostic.code))
          .toContain("INVALID_RELATION_TARGET");
        expect(await snapshot()).toEqual(before);
      });
    });

    it("never rebuilds a missing index on read and restores it only explicitly", async () => {
      await withHarness("index-missing", async ({ port, oracle, snapshot }) => {
        const before = await snapshot();
        await expectCode(() => port.getEntity(oracle.lookup.id), "INDEX_MISSING");
        await expectCode(() => port.listEntities(), "INDEX_MISSING");
        await expectCode(
          () => port.queryEntities({ query: oracle.search.text }),
          "INDEX_MISSING",
        );
        expect((await port.inspectIndex()).state).toBe("missing");
        expect(await snapshot()).toEqual(before);

        const rebuilt = await port.rebuildIndex();
        expect(rebuilt.state).toBe("succeeded");
        const after = await snapshot();
        expect(after.canonicalDigest).toBe(before.canonicalDigest);
        expect(after.indexRebuilds).toBe(before.indexRebuilds + 1);
        expect(await port.getEntity(oracle.lookup.id)).not.toBeNull();
      });
    });

    it.each([
      ["index-stale", "stale"],
      ["index-corrupt", "corrupt"],
    ] as const)("inspects %s state without hidden repair", async (scenario, state) => {
      await withHarness(scenario, async ({ port, oracle, snapshot }) => {
        const before = await snapshot();
        expect((await port.inspectIndex()).state).toBe(state);
        if (state === "stale") {
          await port.getEntity(oracle.lookup.id);
          await port.listEntities();
          await port.queryEntities({ query: oracle.search.text });
        } else {
          await expectCode(() => port.getEntity(oracle.lookup.id), "INDEX_CORRUPT");
          await expectCode(() => port.listEntities(), "INDEX_CORRUPT");
          await expectCode(
            () => port.queryEntities({ query: oracle.search.text }),
            "INDEX_CORRUPT",
          );
        }
        await port.validate();
        expect((await port.inspectIndex()).state).toBe(state);
        expect(await snapshot()).toEqual(before);

        await port.rebuildIndex();
        const rebuilt = await snapshot();
        expect(rebuilt.canonicalDigest).toBe(before.canonicalDigest);
        expect(rebuilt.indexDigest).toBe(rebuilt.canonicalDigest);
        expect(rebuilt.indexRebuilds).toBe(before.indexRebuilds + 1);
        expect((await port.inspectIndex()).state).toBe("fresh");
      });
    });

    it("plans and applies a restartable, prose-preserving legacy migration", async () => {
      await withHarness("legacy", async ({ port, oracle, snapshot }) => {
        if (!oracle.legacy) throw new Error("Legacy oracle is required for the legacy scenario.");
        const before = await snapshot();
        const preview = await port.planMigration();
        assertMigrationPreview(preview);
        expect(await snapshot()).toEqual(before);

        const result = await port.applyMigration({
          migrationId: preview.migrationId,
          previewRevision: preview.previewRevision,
          plan: preview.plan,
          expectedRevisions: preview.expectedRevisions,
        });
        expect(result.applied).toBe(true);
        expect(result.idempotentReplay).toBe(false);
        expect(result.report.filesScanned).toBe(preview.report.filesScanned);
        expect(result.report.idsGenerated).toBeGreaterThan(0);
        const after = await snapshot();
        assertChangedFileScopeAndHashes(result.changes, before.files, after.files);
        expect(after.files).toHaveProperty(oracle.legacy.sourcePath);
        expect(after.files[oracle.legacy.sourcePath]).toContain(oracle.legacy.entity.id);
        for (const fragment of oracle.legacy.preservedFragments) {
          expect(after.files[oracle.legacy.sourcePath]).toContain(fragment);
        }
        expect(after.files[oracle.legacy.eventsPath]).toBe(before.files[oracle.legacy.eventsPath]);
        expect(await port.getEntity(oracle.legacy.entity.id)).not.toBeNull();

        await port.rebuildIndex();
        expect(await port.getEntity(oracle.legacy.entity.id)).not.toBeNull();
        const afterRebuild = await snapshot();

        const replay = await port.applyMigration({
          migrationId: preview.migrationId,
          previewRevision: preview.previewRevision,
          plan: preview.plan,
          expectedRevisions: preview.expectedRevisions,
        });
        expect(replay.idempotentReplay).toBe(true);
        expect(await snapshot()).toEqual(afterRebuild);
      });
    });

    it("rejects migration when canonical bytes change after preview", async () => {
      await withHarness("legacy", async ({
        port,
        makeMigrationConcurrentEdit,
        snapshot,
      }) => {
        const preview = await port.planMigration();
        const target = preview.changes[0]?.path;
        if (!target) throw new Error("Migration fixture has no changed file.");
        await makeMigrationConcurrentEdit(target);
        const afterManualEdit = await snapshot();
        await expectCode(
          () => port.applyMigration({
            migrationId: preview.migrationId,
            previewRevision: preview.previewRevision,
            plan: preview.plan,
            expectedRevisions: preview.expectedRevisions,
          }),
          "REVISION_CONFLICT",
        );
        expect(await snapshot()).toEqual(afterManualEdit);
      });
    });
  });
}

function assertMigrationPreview<TMigrationPlan>(
  preview: WikiMigrationPreview<TMigrationPlan>,
): void {
  expect(preview.validation.valid).toBe(true);
  expect(preview.changes.length).toBeGreaterThan(0);
  expect(preview.previewRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.expectedRevisions).toHaveLength(preview.report.filesScanned);
  expect(preview.report.idsGenerated).toBeUndefined();
  expect(preview.report.filesUnchanged.length).toBeGreaterThan(0);
}

function assertChangedFileScopeAndHashes(
  changes: readonly FileChange[],
  beforeFiles: Readonly<Record<string, string>>,
  afterFiles: Readonly<Record<string, string>>,
): void {
  const allPaths = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  const actualChangedPaths = [...allPaths]
    .filter((path) => beforeFiles[path] !== afterFiles[path])
    .sort();
  const reportedChangedPaths = [...new Set(changes.flatMap((change) => (
    change.previousPath ? [change.previousPath, change.path] : [change.path]
  )))].sort();
  expect(reportedChangedPaths).toEqual(actualChangedPaths);

  for (const change of changes) {
    const previousPath = change.previousPath ?? change.path;
    const before = beforeFiles[previousPath];
    const after = afterFiles[change.path];
    expect(change.beforeRevision).toBe(before === undefined ? null : hashBytes(before));
    expect(change.afterRevision).toBe(after === undefined ? null : hashBytes(after));
    expect(change.diff.length).toBeGreaterThan(0);
    expect(change.diff).toContain(`--- ${before === undefined ? "/dev/null" : `a/${previousPath}`}`);
    expect(change.diff).toContain(`+++ ${after === undefined ? "/dev/null" : `b/${change.path}`}`);
  }
}

function hashBytes(value: string): Revision {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function expectCode<T>(run: () => Promise<T>, expected: string): Promise<void> {
  try {
    await run();
    throw new Error(`Expected ${expected}, but the operation succeeded.`);
  } catch (error) {
    const code = errorCode(error);
    if (code !== expected) throw error;
    expect(code).toBe(expected);
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = "code" in error ? error.code : undefined;
  if (typeof direct === "string") return direct;
  if (!("problem" in error) || !error.problem || typeof error.problem !== "object") return undefined;
  const nested = "code" in error.problem ? error.problem.code : undefined;
  return typeof nested === "string" ? nested : undefined;
}

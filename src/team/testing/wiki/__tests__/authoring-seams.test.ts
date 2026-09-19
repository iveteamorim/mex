import { describe, expect, it } from "vitest";
import type { WikiOperationRequest } from "../../../contracts/wiki.js";
import {
  MockWikiPort,
  type MockWikiForcedCreatePayload,
  type MockWikiOperationPlan,
} from "../mock-wiki-port.js";
import { POPULATED_WIKI_FIXTURE } from "../populated-fixture.js";

const CREATED = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJH";
const OTHER = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJK";

describe("MockWikiPort package-private authoring seams", () => {
  it("attests one ordered fresh view and fails closed after canonical drift", async () => {
    const wiki = new MockWikiPort();
    const spec = POPULATED_WIKI_FIXTURE.refs.spec;
    const emptyView = await wiki.readExactEntityAttestations([]);
    expect(emptyView.entities).toEqual([]);
    const view = await wiki.readExactEntityAttestations([CREATED, spec]);

    expect(view.entities.map((entry) => entry.id)).toEqual([CREATED, spec]);
    expect(view.entities[0]?.entity).toBeNull();
    expect(view.entities[1]?.entity).toMatchObject({
      ref: { id: spec, kind: "spec" },
      version: { semanticRevision: 3 },
    });
    await expect(wiki.readExactEntityAttestations([spec, spec])).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });

    wiki.simulateManualBodyEdit(spec, "A teammate changed the Spec prose.");
    await expect(wiki.readExactEntityAttestations([spec])).rejects.toMatchObject({
      problem: { code: "INDEX_STALE" },
    });
  });

  it("injects, consumes, and applies exactly one pinned ID for an ID-less create", async () => {
    const wiki = new MockWikiPort();
    const payload: MockWikiForcedCreatePayload = {
      operations: [{
        type: "create-entry",
        entity: {
          kind: "spec",
          title: "Portable create identity",
          sourcePath: ".mex/specs/portable-create.md",
          lifecycleState: "in_flight",
          groundingHealth: "unverified",
          semanticRevision: 1,
          payload: {
            summary: "Use the receipt-pinned identity.",
            body: "A second process reproduces the reviewed create.",
            topics: [],
            sources: [],
          },
        },
      }],
    };
    const request: WikiOperationRequest<MockWikiForcedCreatePayload> = {
      operation: {
        opId: "operation_mock_forced_create",
        type: "create-entry",
        actor: { kind: "human", id: "member_mock_reviewer" },
        timestamp: "2026-08-28T00:00:00.000Z",
        payload,
      },
      expectedRevisions: [{ target: { kind: "entity", id: CREATED }, version: null }],
    };

    const preview = await wiki.previewOperationsWithCreatedIds(request, [CREATED]);
    expect("id" in payload.operations[0].entity).toBe(false);
    expect(preview.plan.operations).toMatchObject([{
      type: "create-entry",
      entity: { id: CREATED },
    }]);
    expect(preview.affectedEntities).toEqual([{
      id: CREATED,
      kind: "spec",
      title: "Portable create identity",
    }]);
    await expect(wiki.previewOperationsWithCreatedIds(request, [])).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    await expect(wiki.previewOperationsWithCreatedIds(request, [CREATED, OTHER])).rejects
      .toMatchObject({ problem: { code: "VALIDATION_FAILED" } });

    const embeddedIdRequest: WikiOperationRequest<MockWikiOperationPlan> = {
      ...request,
      operation: {
        ...request.operation,
        entityId: CREATED,
        payload: {
          operations: [{
            type: "create-entry",
            entity: { ...payload.operations[0].entity, id: CREATED },
          }],
        },
      },
    };
    await expect(wiki.previewOperationsWithCreatedIds(embeddedIdRequest, [CREATED])).rejects
      .toMatchObject({ problem: { code: "VALIDATION_FAILED" } });

    const restartedWiki = new MockWikiPort();
    const result = await restartedWiki.applyOperations({
      ...request,
      plan: preview.plan,
      expectedPreviewRevision: preview.previewRevision,
    });
    expect(result.resultingVersions[CREATED]).toMatchObject({ semanticRevision: 1 });
    expect((await restartedWiki.getEntity(CREATED))?.ref.kind).toBe("spec");
  });

  it("previews exactly one governed update through the package-private seam", async () => {
    const wiki = new MockWikiPort();
    const specId = POPULATED_WIKI_FIXTURE.refs.spec;
    const current = await wiki.getEntity(specId);
    if (current === null) throw new Error("mock Spec fixture missing");
    const request: WikiOperationRequest<MockWikiOperationPlan> = {
      operation: {
        opId: "operation_mock_exact_authoring_update",
        type: "update-entry",
        entityId: specId,
        baseRevision: current.version.semanticRevision,
        baseContentHash: current.version.contentHash,
        actor: { kind: "human", id: "member_mock_reviewer" },
        timestamp: "2026-08-28T01:00:00.000Z",
        payload: {
          operations: [{
            type: "update-entry",
            entityId: specId,
            body: "The governed mock update retains its exact dependency version.",
          }],
        },
      },
      expectedRevisions: [{
        target: { kind: "entity", id: specId },
        version: current.version,
      }],
    };

    await expect(wiki.previewAuthoringOperations(request)).resolves.toMatchObject({
      valid: true,
      affectedEntities: [{ id: specId, kind: "spec" }],
    });
    await expect(wiki.previewAuthoringOperations({
      ...request,
      operation: {
        ...request.operation,
        type: "create-entry",
        payload: { operations: [] },
      },
    })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
  });
});

import { describe, expect, it, vi } from "vitest";
import { MockWikiPort } from "../../testing/wiki/mock-wiki-port.js";
import {
  POPULATED_WIKI_FIXTURE,
  type MockWikiEntitySeed,
  type PopulatedWikiFixture,
} from "../../testing/wiki/populated-fixture.js";
import type { Diagnostic } from "../../contracts/shared.js";
import {
  SPEC_READ_LIMITS,
  createSpecReadService,
} from "../service.js";

const SECOND_SPEC = "mx_01J0000000000000000000000C";
const CONSTRAINT = "mx_01J0000000000000000000000D";
const REFINED_REQUIREMENT = "mx_01J0000000000000000000000E";
const UNRELATED_REQUIREMENT = "mx_01J0000000000000000000000F";

describe("read-only Spec service", () => {
  it("lists only root Specs through bounded revision-bound Wiki paging", async () => {
    const wiki = new MockWikiPort({ fixture: hierarchyFixture(true) });
    const before = wiki.snapshot();
    const service = createSpecReadService(wiki);

    const first = await service.list({ limit: 1, includeArchived: true });
    const repeated = await service.list({ limit: 1, includeArchived: true });

    expect(first.availability).toBe("ready");
    expect(first).toEqual(repeated);
    if (first.availability !== "ready") throw new Error("expected ready result");
    expect(first.page.items).toHaveLength(1);
    expect(first.page.items[0]!.kind).toBe("spec");
    expect(first.page.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(first.page.nextCursor!, "utf8"))
      .toBeLessThanOrEqual(SPEC_READ_LIMITS.maxCursorBytes);
    expect(first.page.deterministicRevision).toMatch(/^[a-f0-9]{64}$/u);

    const second = await service.list({
      cursor: first.page.nextCursor!,
      limit: 1,
      includeArchived: true,
    });
    expect(second.availability).toBe("ready");
    if (second.availability !== "ready") throw new Error("expected ready result");
    expect(second.page.items).toHaveLength(1);
    expect(second.page.items[0]!.kind).toBe("spec");
    expect(second.page.items[0]!.id).not.toBe(first.page.items[0]!.id);
    expect(wiki.snapshot()).toEqual(before);
  });

  it("shows only explicit pinned Spec hierarchy directions with Wiki provenance and grounding", async () => {
    const wiki = new MockWikiPort({ fixture: hierarchyFixture(false) });
    const before = wiki.snapshot();
    const service = createSpecReadService(wiki);
    const result = await service.show(POPULATED_WIKI_FIXTURE.refs.spec);
    const repeated = await service.show(POPULATED_WIKI_FIXTURE.refs.spec);

    expect(result.availability).toBe("ready");
    expect(result).toEqual(repeated);
    if (result.availability !== "ready") throw new Error("expected ready result");
    expect(result.detail.spec).toMatchObject({
      id: POPULATED_WIKI_FIXTURE.refs.spec,
      kind: "spec",
      title: "Idempotent payment capture",
    });
    expect(result.detail.provenance).toEqual({
      kind: "system",
      id: "mock-populated-fixture",
      capturedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(result.detail.sources).toEqual([
      { type: "commit", ref: "8f21a3c" },
    ]);
    expect(result.detail.groundings).toHaveLength(1);
    expect(result.detail.hierarchy.requirements.map((entry) => entry.id)).toEqual([
      POPULATED_WIKI_FIXTURE.refs.requirement,
      REFINED_REQUIREMENT,
    ]);
    expect(result.detail.hierarchy.requirements.map((entry) => entry.id))
      .not.toContain(UNRELATED_REQUIREMENT);
    expect(result.detail.hierarchy.acceptanceCriteria.map((entry) => entry.id)).toEqual([
      POPULATED_WIKI_FIXTURE.refs.acceptanceCriterion,
    ]);
    expect(result.detail.hierarchy.constraints.map((entry) => entry.id)).toEqual([CONSTRAINT]);
    expect(result.detail.hierarchy.relations.map((relation) => (
      `${relation.source.kind}:${relation.type}:${relation.target.kind}`
    ))).toEqual([
      "spec:constrained_by:constraint",
      "requirement:derived_from:spec",
      "requirement:refines:requirement",
      "acceptance_criterion:verified_by:requirement",
    ]);
    expect(result.detail.deterministicRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(wiki.snapshot()).toEqual(before);
  });

  it("rejects an internally inconsistent composite Wiki snapshot", async () => {
    const wiki = new MockWikiPort({ fixture: hierarchyFixture(false) });
    const original = wiki.getEntityNeighborhood.bind(wiki);
    vi.spyOn(wiki, "getEntityNeighborhood").mockImplementation(async (request) => {
      const snapshot = await original(request);
      if (snapshot === null) return null;
      return {
        ...snapshot,
        neighborhood: {
          ...snapshot.neighborhood,
          root: {
            ...snapshot.neighborhood.root,
            groundingHealth: snapshot.neighborhood.root.groundingHealth === "fresh"
              ? "changed"
              : "fresh",
          },
        },
      };
    });

    await expect(createSpecReadService(wiki).show(POPULATED_WIKI_FIXTURE.refs.spec))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
  });

  it("reports stale and unavailable indexes without attempting a Wiki entity read", async () => {
    for (const [state, availability] of [
      ["stale", "stale"],
      ["rebuild_required", "stale"],
      ["missing", "unavailable"],
      ["degraded", "unavailable"],
      ["corrupt", "unavailable"],
      ["migration_required", "unavailable"],
    ] as const) {
      const wiki = new MockWikiPort({ indexState: state });
      const list = vi.spyOn(wiki, "listEntities");
      const get = vi.spyOn(wiki, "getEntity");
      const neighborhood = vi.spyOn(wiki, "getNeighborhood");
      const snapshot = vi.spyOn(wiki, "getEntityNeighborhood");
      const before = wiki.snapshot();
      const service = createSpecReadService(wiki);

      await expect(service.list()).resolves.toMatchObject({ availability, page: null });
      await expect(service.show(POPULATED_WIKI_FIXTURE.refs.spec)).resolves.toMatchObject({
        availability,
        detail: null,
      });
      expect(list).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(neighborhood).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(wiki.snapshot()).toEqual(before);
    }
  });

  it("bounds status diagnostics and long UTF-8 bodies honestly", async () => {
    const diagnostics: Diagnostic[] = Array.from({ length: 55 }, (_, index) => ({
      code: `TEST_${String(index).padStart(2, "0")}`,
      severity: "warning",
      message: `Diagnostic ${index}`,
    }));
    const unavailable = new MockWikiPort({ indexState: "missing" });
    vi.spyOn(unavailable, "inspectIndex").mockResolvedValue({
      state: "missing",
      observedAt: "2026-08-28T00:00:00.000Z",
      schemaVersion: null,
      indexedRevision: null,
      indexedAt: null,
      diagnostics,
    });
    const status = await createSpecReadService(unavailable).list();
    expect(status.index.diagnostics).toHaveLength(SPEC_READ_LIMITS.maxIndexDiagnostics);
    expect(status.index.diagnosticsTruncated).toBe(true);

    const body = "safe💾".repeat(20_000);
    const fixture = hierarchyFixture(false, body);
    const detail = await createSpecReadService(new MockWikiPort({ fixture }))
      .show(POPULATED_WIKI_FIXTURE.refs.spec);
    expect(detail.availability).toBe("ready");
    if (detail.availability !== "ready") throw new Error("expected ready result");
    expect(detail.detail.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(detail.detail.body, "utf8"))
      .toBeLessThanOrEqual(SPEC_READ_LIMITS.maxBodyBytes);
    expect(detail.detail.body).not.toContain("�");
  });

  it("fails closed on truncated hierarchy data and rejects unsafe requests before reads", async () => {
    const wiki = new MockWikiPort({ fixture: hierarchyFixture(false) });
    const original = wiki.getEntityNeighborhood.bind(wiki);
    vi.spyOn(wiki, "getEntityNeighborhood").mockImplementation(async (request) => {
      const snapshot = await original(request);
      return snapshot === null ? null : {
        ...snapshot,
        neighborhood: { ...snapshot.neighborhood, truncated: true },
      };
    });
    await expect(createSpecReadService(wiki).show(POPULATED_WIKI_FIXTURE.refs.spec))
      .rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });

    const invalid = new MockWikiPort();
    const inspect = vi.spyOn(invalid, "inspectIndex");
    await expect(createSpecReadService(invalid).list({ limit: 101 }))
      .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    await expect(createSpecReadService(invalid).list({ cursor: "x".repeat(4_097) }))
      .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    await expect(createSpecReadService(invalid).list({
      lifecycleStates: ["promoted", "promoted"],
    }))
      .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("treats a non-Spec Wiki entity as not found on the dedicated surface", async () => {
    const service = createSpecReadService(new MockWikiPort());
    await expect(service.show(POPULATED_WIKI_FIXTURE.refs.requirement))
      .rejects.toMatchObject({ problem: { code: "NOT_FOUND" } });
  });
});

function hierarchyFixture(includeSecondSpec: boolean, rootBody?: string): PopulatedWikiFixture {
  const entities = POPULATED_WIKI_FIXTURE.entities.map((entity) => (
    entity.id === POPULATED_WIKI_FIXTURE.refs.spec && rootBody !== undefined
      ? { ...entity, payload: { ...entity.payload, body: rootBody } }
      : entity
  ));
  const additions: MockWikiEntitySeed[] = [
    {
      id: CONSTRAINT,
      kind: "constraint",
      title: "One charge per attempt",
      sourcePath: ".mex/specs/idempotent-payment-capture.md",
      lifecycleState: "promoted",
      groundingHealth: "unverified",
      semanticRevision: 1,
      payload: {
        summary: "A checkout attempt can create at most one charge.",
        body: "Every path preserves the stable attempt identity.",
        topics: [POPULATED_WIKI_FIXTURE.refs.topic],
        sources: [{ type: "manual" }],
      },
    },
    {
      id: REFINED_REQUIREMENT,
      kind: "requirement",
      title: "Persist the gateway response",
      sourcePath: ".mex/specs/idempotent-payment-capture.md",
      lifecycleState: "in_flight",
      groundingHealth: "unverified",
      semanticRevision: 1,
      payload: {
        summary: "Persist the response before acknowledging delivery.",
        body: "The response is durable before the webhook is acknowledged.",
        topics: [POPULATED_WIKI_FIXTURE.refs.topic],
        sources: [{ type: "manual" }],
      },
    },
    {
      id: UNRELATED_REQUIREMENT,
      kind: "requirement",
      title: "Unrelated checkout audit",
      sourcePath: ".mex/specs/unrelated-checkout-audit.md",
      lifecycleState: "in_flight",
      groundingHealth: "unverified",
      semanticRevision: 1,
      payload: {
        summary: "Audit an unrelated checkout workflow.",
        body: "This requirement does not belong to the payment capture Spec.",
        topics: [POPULATED_WIKI_FIXTURE.refs.topic],
        sources: [{ type: "manual" }],
      },
    },
  ];
  if (includeSecondSpec) {
    additions.push({
      id: SECOND_SPEC,
      kind: "spec",
      title: "Webhook retry safety",
      sourcePath: ".mex/specs/webhook-retry-safety.md",
      lifecycleState: "in_flight",
      groundingHealth: "unverified",
      semanticRevision: 1,
      payload: {
        summary: "Retry webhook delivery without duplicate work.",
        body: "Each delivery has a stable identity.",
        topics: [POPULATED_WIKI_FIXTURE.refs.topic],
        sources: [{ type: "manual" }],
      },
    });
  }
  return {
    refs: POPULATED_WIKI_FIXTURE.refs,
    entities: [...entities, ...additions],
    relations: [
      ...POPULATED_WIKI_FIXTURE.relations,
      {
        type: "constrained_by",
        source: { id: POPULATED_WIKI_FIXTURE.refs.spec, kind: "spec" },
        target: { id: CONSTRAINT, kind: "constraint" },
      },
      {
        type: "refines",
        source: { id: REFINED_REQUIREMENT, kind: "requirement" },
        target: { id: POPULATED_WIKI_FIXTURE.refs.requirement, kind: "requirement" },
      },
      {
        type: "constrained_by",
        source: { id: UNRELATED_REQUIREMENT, kind: "requirement" },
        target: { id: CONSTRAINT, kind: "constraint" },
      },
      {
        type: "verified_by",
        source: {
          id: POPULATED_WIKI_FIXTURE.refs.acceptanceCriterion,
          kind: "acceptance_criterion",
        },
        target: { id: POPULATED_WIKI_FIXTURE.refs.requirement, kind: "requirement" },
      },
      // The same relation vocabulary with the wrong semantic direction must
      // not be reinterpreted as Spec hierarchy.
      {
        type: "derived_from",
        source: { id: POPULATED_WIKI_FIXTURE.refs.currentDecision, kind: "decision" },
        target: { id: POPULATED_WIKI_FIXTURE.refs.spec, kind: "spec" },
      },
    ],
  };
}

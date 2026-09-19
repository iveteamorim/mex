import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  CodeKnowledgeResponseSchema,
  HealthResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  SearchResponseSchema,
  WikiBacklinksResponseSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityListResponseSchema,
  WikiRelationsResponseSchema,
  WikiGraphResponseSchema,
  WikiGroundedCodeResponseSchema,
  type HubJobKind,
} from "@mex/hub-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryGraphPort } from "../src/graph/application-adapter.js";
import { createHubApp } from "../src/hub/app.js";
import { createGraphJobExecutors } from "../src/hub/jobs/graph.js";
import { HubJobManager } from "../src/hub/jobs/index.js";
import { createWikiJobExecutors } from "../src/hub/jobs/wiki.js";
import { HubSessionManager } from "../src/hub/security/session.js";
import { createLocalHubReadServices } from "../src/hub/services.js";
import { createRepositoryTeamWorkflowPort } from "../src/team/workflow/repository-team-workflow-port.js";
import { TeamLocalState } from "../src/team/local-state/index.js";
import { createRepositoryWikiPort } from "../src/wiki/application-adapter.js";

const ORIGIN = "http://127.0.0.1:48482";
const HOST = "127.0.0.1:48482";
const BOOTSTRAP_TOKEN = Buffer.alloc(32, 53).toString("base64url");
const TOPIC_ID = "mx_01J00000000000000000000001";
const DECISION_ID = "mx_01J00000000000000000000002";
const PATTERN_ID = "mx_01J00000000000000000000003";
const LARGE_FACT_ID = "mx_01J00000000000000000000004";
const SPEC_ID = "mx_01J00000000000000000000005";
const REQUIREMENT_ID = "mx_01J00000000000000000000006";
const CONSTRAINT_ID = "mx_01J00000000000000000000007";
const ACCEPTANCE_CRITERION_ID = "mx_01J00000000000000000000008";
const TEAM_WORKSTREAM_ID = "ws_01J00000000000000000000009";
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("real Project Hub Wiki integration", () => {
  it("serves engineering-intelligence kinds through the general Knowledge response", async () => {
    const harness = await createHarness(await prepareProject());
    try {
      const response = await parseBounded(
        await harness.get("/api/v1/wiki/entities?limit=25"),
        WikiEntityListResponseSchema,
      );
      expect(response.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: SPEC_ID, kind: "spec", route: `/knowledge/${SPEC_ID}` }),
        expect.objectContaining({ id: REQUIREMENT_ID, kind: "requirement", route: `/knowledge/${REQUIREMENT_ID}` }),
        expect.objectContaining({ id: CONSTRAINT_ID, kind: "constraint", route: `/knowledge/${CONSTRAINT_ID}` }),
        expect.objectContaining({
          id: ACCEPTANCE_CRITERION_ID,
          kind: "acceptance_criterion",
          route: `/knowledge/${ACCEPTANCE_CRITERION_ID}`,
        }),
        expect.objectContaining({ id: DECISION_ID, kind: "decision", route: `/knowledge/${DECISION_ID}` }),
      ]));
      expect(response.items.some((item) => item.id === TEAM_WORKSTREAM_ID)).toBe(false);

      for (const [kind, id] of [
        ["spec", SPEC_ID],
        ["requirement", REQUIREMENT_ID],
        ["constraint", CONSTRAINT_ID],
        ["acceptance_criterion", ACCEPTANCE_CRITERION_ID],
      ] as const) {
        const filtered = await parseBounded(
          await harness.get(`/api/v1/wiki/entities?kind=${kind}&limit=25`),
          WikiEntityListResponseSchema,
        );
        expect(filtered.items.map((item) => [item.kind, item.id])).toEqual([[kind, id]]);
      }

      const teamKind = await harness.get("/api/v1/wiki/entities?kind=workstream&limit=25");
      expect(teamKind.status).toBe(400);
      expect(await teamKind.json()).toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      await harness.close();
    }
  }, 45_000);

  it("serves bounded Knowledge, search, relations, backlinks, and Code links without mutating the repository", async () => {
    const harness = await createHarness(await prepareProject());
    try {
      const unauthenticated = await harness.app.request(`${ORIGIN}/api/v1/wiki/entities`, {
        headers: { host: HOST },
      });
      expect(unauthenticated.status).toBe(401);
      for (const path of ["/api/v1/wiki/graph", `/api/v1/wiki/entities/${DECISION_ID}/code`]) {
        expect((await harness.app.request(`${ORIGIN}${path}`, { headers: { host: HOST } })).status).toBe(401);
      }

      const spoofedHost = await harness.app.request(`${ORIGIN}/api/v1/wiki/entities`, {
        headers: { host: "localhost:48482", cookie: harness.cookie },
      });
      expect(spoofedHost.status).toBe(400);

      const before = snapshotProtectedState(harness.root);
      const capabilities = await parseBounded(
        await harness.get("/api/v1/capabilities"),
        HubCapabilitiesSchema,
      );
      expect(capabilities).toMatchObject({
        wiki: {
          read: { availability: "available" },
          refresh: { availability: "available" },
          rebuild: { availability: "available" },
        },
      });

      const list = await parseBounded(
        await harness.get(
          `/api/v1/wiki/entities?kind=decision&topic=${TOPIC_ID}&lifecycle=promoted&grounding=fresh&sourceType=symbol&limit=1`,
        ),
        WikiEntityListResponseSchema,
      );
      expect(list.items.map((item) => item.id)).toEqual([DECISION_ID]);
      expect(list.items[0]).toMatchObject({
        kind: "decision",
        title: "Preserve packed retries",
        lifecycleState: "promoted",
        groundingHealth: "fresh",
        sourceTypes: ["symbol"],
        route: `/knowledge/${DECISION_ID}`,
      });

      const detail = await parseBounded(
        await harness.get(`/api/v1/wiki/entities/${DECISION_ID}`),
        WikiEntityDetailResponseSchema,
      );
      expect(detail.entity.id).toBe(DECISION_ID);
      expect(detail.body).toMatchObject({
        content: expect.stringContaining("original stable request key"),
        truncated: false,
      });
      expect(detail.sources).toMatchObject({ total: 1, truncated: false });
      expect(detail.groundings.items[0]).toMatchObject({
        state: "fresh",
        health: "fresh",
        requestedNode: harness.symbolId,
        resolvedNode: harness.symbolId,
      });
      expect(detail.sources.items[0]?.note).toBeNull();
      expect(detail.provenance?.id).toBeNull();
      expect(detail).toMatchObject({ relationCount: 1, backlinkCount: 1 });

      const graph = await parseBounded(await harness.get("/api/v1/wiki/graph"), WikiGraphResponseSchema);
      expect(graph.indexedRevision).toBe(detail.indexedRevision);
      expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
        TOPIC_ID, DECISION_ID, PATTERN_ID, LARGE_FACT_ID, SPEC_ID, REQUIREMENT_ID, CONSTRAINT_ID, ACCEPTANCE_CRITERION_ID,
      ]));
      expect(graph.nodes.some((node) => node.id === TEAM_WORKSTREAM_ID)).toBe(false);
      expect(graph.coverage).toMatchObject({ nodesTruncated: false, relationsTruncated: false });
      expect(graph.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "implements", source: expect.objectContaining({ id: DECISION_ID }), target: expect.objectContaining({ id: PATTERN_ID }) }),
      ]));
      const code = await parseBounded(
        await harness.get(`/api/v1/wiki/entities/${DECISION_ID}/code`), WikiGroundedCodeResponseSchema,
      );
      expect(code.indexedRevision).toBe(graph.indexedRevision);
      expect(code.graphRevision).not.toBeNull();
      expect(code.groundings).toMatchObject([{
        requestedNode: harness.symbolId, resolvedNode: harness.symbolId, health: "fresh",
        symbol: { id: harness.symbolId, path: "src/packed.ts" },
      }]);
      expect(JSON.stringify(code)).not.toContain("fingerprint");
      expect(JSON.stringify(code)).not.toContain("bodyHash");

      const relations = await parseBounded(
        await harness.get(`/api/v1/wiki/entities/${DECISION_ID}/relations?direction=both&limit=2`),
        WikiRelationsResponseSchema,
      );
      expect(relations.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          direction: "outgoing",
          relation: expect.objectContaining({ type: "implements" }),
          entity: expect.objectContaining({ id: PATTERN_ID }),
        }),
        expect.objectContaining({
          direction: "incoming",
          relation: expect.objectContaining({ type: "depends_on" }),
          entity: expect.objectContaining({ id: PATTERN_ID }),
        }),
      ]));

      const backlinks = await parseBounded(
        await harness.get(`/api/v1/wiki/entities/${DECISION_ID}/backlinks?type=depends_on`),
        WikiBacklinksResponseSchema,
      );
      expect(backlinks.items).toEqual([
        expect.objectContaining({
          type: "depends_on",
          source: expect.objectContaining({ id: PATTERN_ID }),
          target: expect.objectContaining({ id: DECISION_ID }),
        }),
      ]);

      const search = await parseBounded(
        await harness.get("/api/v1/search?q=packed%20retry&limit=10"),
        SearchResponseSchema,
      );
      expect(search.groups.wiki.status).toBe("available");
      expect(search.groups.wiki.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "wiki", id: DECISION_ID }),
      ]));
      expect(search.groups.symbols.status).toBe("available");
      expect(search.groups.sources.status).toBe("available");

      const codeKnowledge = await parseBounded(
        await harness.get(`/api/v1/code/symbols/${encodeURIComponent(harness.symbolId)}/knowledge`),
        CodeKnowledgeResponseSchema,
      );
      expect(codeKnowledge.items).toEqual([
        expect.objectContaining({
          entity: expect.objectContaining({ id: DECISION_ID }),
          matchedNodes: [harness.symbolId],
        }),
      ]);

      const boundedLargeBody = await parseBounded(
        await harness.get(`/api/v1/wiki/entities/${LARGE_FACT_ID}`),
        WikiEntityDetailResponseSchema,
      );
      expect(boundedLargeBody.body.truncated).toBe(true);
      expect(boundedLargeBody.body.totalBytes).toBeGreaterThan(128 * 1_024);
      expect(Buffer.byteLength(boundedLargeBody.body.content, "utf8")).toBeLessThanOrEqual(128 * 1_024);
      expect(boundedLargeBody.body.content).not.toContain("�");

      const health = await parseBounded(await harness.get("/api/v1/health"), HealthResponseSchema);
      expect(health.components.find((component) => component.id === "wiki")).toMatchObject({
        status: "healthy",
        wiki: {
          indexStatus: "fresh",
          indexedRevision: list.indexedRevision,
          allowedJobKinds: ["wiki_refresh", "wiki_rebuild"],
          recommendedJobKind: null,
        },
      });

      const serialized = JSON.stringify({ list, detail, relations, backlinks, search, codeKnowledge, health });
      for (const secret of [
        harness.root,
        "/Users/alice/private-wiki",
        "packed-private-session",
        "packed-topic-private-metadata",
        "packed-source-private-metadata",
        "packed-entity-private-metadata",
        "packed-relation-private-metadata",
        "punctuated-posix-secret",
        "punctuated-windows-secret",
        "punctuated-unc-secret",
      ]) expect(serialized).not.toContain(secret);
      for (const omitted of ["agentSessionId", "metadata", "private_note"]) {
        expect(serialized).not.toContain(`\"${omitted}\":`);
      }
      expect(snapshotProtectedState(harness.root)).toEqual(before);
    } finally {
      await harness.close();
    }
  }, 45_000);

  it("rejects duplicate, unknown, overlong, and malicious Wiki inputs without leaking local details", async () => {
    const harness = await createHarness(await prepareProject());
    try {
      const firstPage = await parseBounded(
        await harness.get("/api/v1/wiki/entities?limit=1"),
        WikiEntityListResponseSchema,
      );
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const mismatchedCursor = await harness.get(
        `/api/v1/wiki/entities?kind=decision&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      );
      expect(mismatchedCursor.status).toBe(400);
      expect(await mismatchedCursor.json()).toMatchObject({ code: "INVALID_REQUEST" });

      const invalidPaths = [
        "/api/v1/wiki/graph?cursor=next",
        `/api/v1/wiki/entities/${DECISION_ID}/code?limit=1`,
        "/api/v1/wiki/entities/not-an-id/code",
        "/api/v1/wiki/entities?kind=decision&kind=pattern",
        "/api/v1/wiki/entities?unknown=true",
        "/api/v1/wiki/entities?limit=0",
        "/api/v1/wiki/entities?limit=51",
        "/api/v1/wiki/entities?lifecycle=current",
        "/api/v1/wiki/entities?grounding=stale",
        "/api/v1/wiki/entities?topic=payments",
        `/api/v1/wiki/entities?cursor=${"x".repeat(4_097)}`,
        `/api/v1/wiki/entities/${DECISION_ID}?view=raw`,
        `/api/v1/wiki/entities/${DECISION_ID}/relations?direction=sideways`,
        `/api/v1/wiki/entities/${DECISION_ID}/relations?type=a&type=b`,
        `/api/v1/wiki/entities/${DECISION_ID}/backlinks?limit=51`,
        `/api/v1/code/symbols/${encodeURIComponent(harness.symbolId)}/knowledge?limit=51`,
        "/api/v1/search?q=" + "x".repeat(257),
      ];
      for (const path of invalidPaths) {
        const response = await harness.get(path);
        expect(response.status, path).toBe(400);
        const body = await response.json() as Record<string, unknown>;
        expect(["INVALID_REQUEST", "VALIDATION_FAILED"], path).toContain(body["code"]);
        expect(Buffer.byteLength(JSON.stringify(body), "utf8"), path).toBeLessThan(1_048_576);
        expect(JSON.stringify(body), path).not.toContain(harness.root);
        expect(JSON.stringify(body), path).not.toContain("private-wiki");
      }

      for (const id of ["../secret", "..\\secret", `mx_${"A".repeat(25)}\0`]) {
        const response = await harness.get(`/api/v1/wiki/entities/${encodeURIComponent(id)}`);
        expect([400, 404]).toContain(response.status);
        const body = await response.text();
        expect(body).not.toContain(harness.root);
        expect(body).not.toContain("private-wiki");
      }

      const missing = await harness.get("/api/v1/wiki/entities/mx_01J0000000000000000000000Z");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await harness.close();
    }
  }, 45_000);

  it("never follows an escaping source symlink and reports bounded stale health", async () => {
    const harness = await createHarness(await prepareProject());
    const outside = trackedTemp("mex-hub-wiki-outside-");
    const outsideFile = join(outside, "private.md");
    writeFileSync(outsideFile, "outside Wiki source secret\n");
    const outsideBefore = snapshotTree(outside);
    try {
      const source = join(harness.root, ".mex", "context", "packed-knowledge.md");
      unlinkSync(source);
      symlinkSync(outsideFile, source);
      const response = await harness.get(`/api/v1/wiki/entities/${DECISION_ID}`);
      const body = await parseBounded(response, WikiEntityDetailResponseSchema);
      expect(body.body.content).toContain("original stable request key");
      expect(JSON.stringify(body)).not.toContain(outside);
      expect(JSON.stringify(body)).not.toContain("outside Wiki source secret");
      const health = await parseBounded(await harness.get("/api/v1/health"), HealthResponseSchema);
      const wikiHealth = health.components.find((component) => component.id === "wiki");
      expect(wikiHealth).toMatchObject({
        status: "degraded",
        wiki: {
          indexStatus: "stale",
          allowedJobKinds: [],
          recommendedJobKind: null,
        },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "PATH_OUTSIDE_SCAFFOLD" }),
        ]),
      });
      expect(wikiHealth).not.toHaveProperty("repairJobKind");
      expect(JSON.stringify(health)).not.toContain(outside);
      expect(JSON.stringify(health)).not.toContain("outside Wiki source secret");
      expect(snapshotTree(outside)).toEqual(outsideBefore);
    } finally {
      await harness.close();
    }
  }, 45_000);

  it("runs explicit targeted refresh and rebuild jobs while preserving canonical and cross-domain sources", async () => {
    const harness = await createHarness(await prepareProject());
    try {
      const beforeRefreshPage = await parseBounded(
        await harness.get("/api/v1/wiki/entities?limit=1"),
        WikiEntityListResponseSchema,
      );
      expect(beforeRefreshPage.nextCursor).toEqual(expect.any(String));
      const wikiSource = join(harness.root, ".mex", "context", "packed-knowledge.md");
      writeFileSync(
        wikiSource,
        readFileSync(wikiSource, "utf8").replace(
          "The packed service retries only with the original stable request key.",
          "The packed service retries transient failures with the original stable request key.",
        ),
      );
      const staleHealth = await parseBounded(await harness.get("/api/v1/health"), HealthResponseSchema);
      expect(staleHealth.components.find((component) => component.id === "wiki")?.wiki).toMatchObject({
        indexStatus: "stale",
        allowedJobKinds: ["wiki_refresh", "wiki_rebuild"],
        recommendedJobKind: "wiki_refresh",
      });

      const protectedAfterEdit = snapshotMaintenanceProtectedState(harness.root);
      const refreshResponse = await harness.postJob("wiki_refresh");
      expect(refreshResponse.status).toBe(202);
      const refresh = HubJobSnapshotSchema.parse(await refreshResponse.json());
      expect((await waitForTerminal(harness.jobs, refresh.id)).state).toBe("succeeded");
      expect((await harness.wiki.inspectIndex()).state).toBe("fresh");
      expect(snapshotMaintenanceProtectedState(harness.root)).toEqual(protectedAfterEdit);

      const staleCursor = await harness.get(
        `/api/v1/wiki/entities?limit=1&cursor=${encodeURIComponent(beforeRefreshPage.nextCursor!)}`,
      );
      expect(staleCursor.status).toBe(409);
      expect(await staleCursor.json()).toMatchObject({ code: "REVISION_CONFLICT" });

      writeFileSync(join(harness.root, ".mex", "wiki.db"), "intentionally corrupt Wiki index\n");
      expect((await harness.wiki.inspectIndex()).state).toBe("corrupt");
      const refusedRefresh = await harness.postJob("wiki_refresh");
      expect(refusedRefresh.status).toBe(503);
      expect(await refusedRefresh.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

      const protectedBeforeRebuild = snapshotMaintenanceProtectedState(harness.root);
      const rebuildResponse = await harness.postJob("wiki_rebuild");
      expect(rebuildResponse.status).toBe(202);
      const rebuild = HubJobSnapshotSchema.parse(await rebuildResponse.json());
      expect((await waitForTerminal(harness.jobs, rebuild.id)).state).toBe("succeeded");
      expect((await harness.wiki.inspectIndex()).state).toBe("fresh");
      expect(snapshotMaintenanceProtectedState(harness.root)).toEqual(protectedBeforeRebuild);

      const repaired = await parseBounded(
        await harness.get(`/api/v1/wiki/entities/${DECISION_ID}`),
        WikiEntityDetailResponseSchema,
      );
      expect(repaired.body.content).toContain("transient failures");
    } finally {
      await harness.close();
    }
  }, 60_000);
});

interface PreparedProject {
  root: string;
  graph: ReturnType<typeof createRepositoryGraphPort>;
  wiki: ReturnType<typeof createRepositoryWikiPort>;
  symbolId: string;
}

interface Harness extends PreparedProject {
  jobs: HubJobManager;
  app: ReturnType<typeof createHubApp>;
  cookie: string;
  csrfToken: string;
  get(path: string): Promise<Response>;
  postJob(kind: HubJobKind): Promise<Response>;
  close(): Promise<void>;
}

async function createHarness(prepared: PreparedProject): Promise<Harness> {
  const localState = new TeamLocalState({ projectRoot: prepared.root, scaffoldId: "hub-wiki-integration" });
  const jobs = new HubJobManager({
    localState,
    executors: {
      ...createGraphJobExecutors(prepared.graph),
      ...createWikiJobExecutors(prepared.wiki),
    },
    shutdownTimeoutMs: 60_000,
  });
  jobs.initialize();
  const team = await createRepositoryTeamWorkflowPort(prepared.root);
  team.initializeIdentityActivitySigner();
  const services = createLocalHubReadServices({
    projectRoot: prepared.root,
    scaffoldId: "hub-wiki-integration",
    jobs,
    team,
    graph: prepared.graph,
    wiki: prepared.wiki,
  });
  const security = new HubSessionManager({
    bootstrapToken: BOOTSTRAP_TOKEN,
    expectedOrigin: ORIGIN,
    random: (size) => new Uint8Array(size).fill(59),
  });
  const app = createHubApp({
    security,
    services,
    jobs,
    requestId: () => "00000000-0000-4000-8000-000000000053",
  });
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
  });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (bootstrap.status !== 201 || cookie === undefined) throw new Error("Hub bootstrap failed.");
  const session = await app.request(`${ORIGIN}/api/v1/session`, {
    headers: { host: HOST, cookie },
  });
  const csrfToken = (await session.json() as { csrfToken: string }).csrfToken;
  return {
    ...prepared,
    jobs,
    app,
    cookie,
    csrfToken,
    get: (path) => app.request(`${ORIGIN}${path}`, { headers: { host: HOST, cookie } }),
    postJob: (kind) => app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "x-mex-csrf": csrfToken,
      },
      body: JSON.stringify({ kind }),
    }),
    close: () => jobs.shutdown(),
  };
}

async function prepareProject(): Promise<PreparedProject> {
  const root = trackedTemp("mex-hub-wiki-integration-");
  write(root, ".gitignore", ".mex/graph.db*\n.mex/wiki.db*\n.mex/local/\n");
  write(root, "src/packed.ts", [
    "export function packedService(input: number): number {",
    "  return input * 2;",
    "}",
    "",
    "export function packedCaller(): number {",
    "  return packedService(21);",
    "}",
    "",
  ].join("\n"));
  write(root, ".mex/events/decisions.jsonl", "");
  write(root, ".mex/config.json", `${JSON.stringify({ scaffold_id: "hub-wiki-integration" }, null, 2)}\n`);
  write(root, ".mex/events/activity/2026-08/sentinel.md", "activity sentinel\n");
  write(root, ".mex/team/members/sentinel.md", "member sentinel\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Hub Wiki Test");
  git(root, "config", "user.email", "hub-wiki@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "source fixture");

  const graph = createRepositoryGraphPort(root);
  await graph.rebuild();
  const symbol = (await graph.searchNodes({ query: "packedService", limit: 10 })).items.find(
    (item) => item.name === "packedService",
  );
  if (!symbol) throw new Error("Graph fixture did not index packedService.");
  const exact = await graph.withFreshGroundingSnapshot((snapshot) => ({
    node: snapshot.getNode(symbol.ref.symbolId),
    fingerprint: snapshot.getFingerprint(symbol.ref.symbolId),
  }));
  if (!exact.node || !exact.fingerprint) throw new Error("Graph fixture did not expose grounding facts.");
  writeWikiFixture(root, {
    nodeId: symbol.ref.symbolId,
    bodyHash: exact.node.bodyHash,
    fingerprint: exact.fingerprint,
  });
  git(root, "add", ".mex/context", ".mex/topics", ".mex/workstreams");
  git(root, "commit", "-qm", "Wiki fixture");
  await graph.rebuild();

  const wiki = createRepositoryWikiPort(root, { groundingBridge: graph });
  await wiki.rebuildIndex();
  return { root, graph, wiki, symbolId: symbol.ref.symbolId };
}

function writeWikiFixture(
  root: string,
  grounding: { nodeId: string; bodyHash: string; fingerprint: string },
): void {
  const largeBody = "🧪".repeat(40_000);
  const punctuatedPaths = "trace(/Users/alice/punctuated-posix-secret) cwd=C:\\Users\\alice\\punctuated-windows-secret (\\\\server\\share\\punctuated-unc-secret)";
  write(root, ".mex/topics/payments.md", [
    "<!-- mex:entity",
    `id: ${TOPIC_ID}`,
    "type: topic",
    "status: promoted",
    "revision: 1",
    "summary: Reliable payment processing knowledge.",
    "metadata:",
    "  aliases: [payments, checkout]",
    "  private_note: packed-topic-private-metadata",
    "  absolute_path: /Users/alice/private-wiki",
    "-->",
    "## Payments",
    "",
    "Payment processing must remain recoverable and idempotent.",
    "",
  ].join("\n"));
  write(root, ".mex/context/packed-knowledge.md", [
    "<!-- mex:entity",
    `id: ${DECISION_ID}`,
    "type: decision",
    "status: promoted",
    "revision: 2",
    "summary: Retry packed service calls with the original request key.",
    `topics: [${TOPIC_ID}]`,
    "relations:",
    "  - type: implements",
    `    target: ${PATTERN_ID}`,
    "    metadata:",
    "      private_note: packed-relation-private-metadata",
    "sources:",
    "  - type: symbol",
    `    ref: ${JSON.stringify(grounding.nodeId)}`,
    `    note: ${JSON.stringify(punctuatedPaths)}`,
    "    metadata:",
    "      private_note: packed-source-private-metadata",
    "grounds_to:",
    `  - node: ${JSON.stringify(grounding.nodeId)}`,
    `    fingerprint: ${JSON.stringify(grounding.fingerprint)}`,
    `    bodyHash: ${JSON.stringify(grounding.bodyHash)}`,
    "    reason: Exact packed service grounding.",
    "provenance:",
    "  createdBy:",
    "    kind: agent",
    `    id: ${JSON.stringify(punctuatedPaths)}`,
    "  createdAt: 2026-08-23T00:00:00.000Z",
    "  agentSessionId: packed-private-session",
    "metadata:",
    "  private_note: packed-entity-private-metadata",
    "-->",
    "## Preserve packed retries",
    "",
    "The packed service retries only with the original stable request key.",
    "",
    "<!-- mex:entity",
    `id: ${PATTERN_ID}`,
    "type: pattern",
    "status: in_flight",
    "revision: 1",
    "summary: Wrap packed calls in a bounded retry envelope.",
    `topics: [${TOPIC_ID}]`,
    "relations:",
    "  - type: depends_on",
    `    target: ${DECISION_ID}`,
    "sources:",
    "  - type: manual",
    "    note: Maintainer reviewed.",
    "-->",
    "## Packed retry envelope",
    "",
    "Retry transient failures without duplicating the underlying operation.",
    "",
    "<!-- mex:entity",
    `id: ${LARGE_FACT_ID}`,
    "type: fact",
    "status: promoted",
    "revision: 1",
    "summary: Oversized UTF-8 body used to prove the Hub response bound.",
    "-->",
    "## Bounded UTF-8 evidence",
    "",
    largeBody,
    "",
  ].join("\n"));
  write(root, ".mex/context/release-spec.md", [
    "<!-- mex:entity",
    `id: ${SPEC_ID}`,
    "type: spec",
    "status: promoted",
    "revision: 1",
    "summary: Define the release behavior.",
    "relations:",
    "  - type: constrained_by",
    `    target: ${CONSTRAINT_ID}`,
    "sources:",
    "  - type: manual",
    "    note: Maintainer reviewed.",
    "-->",
    "## Release behavior",
    "",
    "The release behavior is explicit and reviewable.",
    "",
    "<!-- mex:entity",
    `id: ${REQUIREMENT_ID}`,
    "type: requirement",
    "status: promoted",
    "revision: 1",
    "summary: Preserve the release contract.",
    "relations:",
    "  - type: derived_from",
    `    target: ${SPEC_ID}`,
    "sources:",
    "  - type: manual",
    "    note: Maintainer reviewed.",
    "-->",
    "## Preserve the release contract",
    "",
    "The implementation preserves the release contract.",
    "",
    "<!-- mex:entity",
    `id: ${CONSTRAINT_ID}`,
    "type: constraint",
    "status: promoted",
    "revision: 1",
    "summary: Keep release reads local.",
    "sources:",
    "  - type: manual",
    "    note: Maintainer reviewed.",
    "-->",
    "## Keep release reads local",
    "",
    "All release reads remain repository local.",
    "",
    "<!-- mex:entity",
    `id: ${ACCEPTANCE_CRITERION_ID}`,
    "type: acceptance_criterion",
    "status: promoted",
    "revision: 1",
    "summary: Prove the release response.",
    "relations:",
    "  - type: verified_by",
    `    target: ${REQUIREMENT_ID}`,
    "sources:",
    "  - type: manual",
    "    note: Maintainer reviewed.",
    "-->",
    "## Prove the release response",
    "",
    "The response retains every canonical entity kind.",
    "",
  ].join("\n"));
  write(root, ".mex/workstreams/team-workstream.md", [
    "<!-- mex:entity",
    `id: ${TEAM_WORKSTREAM_ID}`,
    "type: workstream",
    "status: promoted",
    "revision: 1",
    "summary: Team-owned work stays in its dedicated workbench.",
    "-->",
    "## A team Workstream",
    "",
    "This Team entity is Wiki-readable internally but is not general Knowledge.",
    "",
  ].join("\n"));
}

async function parseBounded<T>(
  response: Response,
  schema: { parse(value: unknown): T },
): Promise<T> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_048_576);
  return schema.parse(JSON.parse(text));
}

async function waitForTerminal(jobs: HubJobManager, id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (job && job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Job ${id} did not finish before the test deadline.`);
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function trackedTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

function snapshotProtectedState(root: string): Record<string, unknown> {
  return {
    tree: snapshotTree(root, [".git/objects", ".git/logs", ".git/hooks", ".git/info"]),
    status: gitStatus(root),
  };
}

function snapshotMaintenanceProtectedState(root: string): Record<string, unknown> {
  return {
    tree: snapshotTree(root, [
      ".git/objects",
      ".git/logs",
      ".git/hooks",
      ".git/info",
      ".mex/wiki.db",
      ".mex/wiki.db-shm",
      ".mex/wiki.db-wal",
      ".mex/local",
    ]),
    status: gitStatus(root),
  };
}

function snapshotTree(root: string, excluded: readonly string[] = []): unknown[] {
  const files: Array<Record<string, unknown>> = [];
  const visit = (path: string): void => {
    const rel = relative(root, path).replaceAll("\\", "/");
    if (excluded.some((entry) => rel === entry || rel.startsWith(`${entry}/`))) return;
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      files.push({ path: rel, type: "symlink", mtimeNs: stat.mtimeNs.toString() });
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (!stat.isFile()) return;
    files.push({
      path: rel,
      bytes: readFileSync(path).toString("base64"),
      mtimeNs: stat.mtimeNs.toString(),
    });
  };
  visit(root);
  return files;
}

function gitStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).toString("base64");
}

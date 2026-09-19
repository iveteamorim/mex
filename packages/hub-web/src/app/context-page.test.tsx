import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

const HUB_ID = "mx_01K36WVM6H7JK8M9NPQRSTVVWX";
const HUB_NODE = "Project Hub read boundaries · architecture";
const CODE_NODE = "createHubServer · code · fresh";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderContext(overrides: Partial<HubApi> = {}, route = "/knowledge") {
  const api = Object.assign(createFixtureApi(), overrides);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { api, queryClient, ...render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={[route]}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  ) };
}

describe("Context graph page", () => {
  it("shows all 30 entities, including disconnected sections, without requesting a list page or details", async () => {
    const fixture = createFixtureApi();
    const graph = await fixture.wikiGraph();
    const extra = Array.from({ length: 27 }, (_, index) => ({
      ...graph.nodes[0], id: `mx_${String(index).padStart(26, "0")}`, kind: "component",
      title: `Unlinked section ${index + 1}`, route: `/knowledge/mx_${String(index).padStart(26, "0")}`,
      location: { path: ".mex/context/architecture.md", startLine: 50 + index * 3, endLine: 52 + index * 3 },
    }));
    const wikiGraph = vi.fn(async () => ({ ...graph, nodes: [...graph.nodes, ...extra] }));
    const listWikiEntities = vi.fn(fixture.listWikiEntities.bind(fixture));
    const getWikiEntity = vi.fn(fixture.getWikiEntity.bind(fixture));
    const getWikiGroundedCode = vi.fn(fixture.getWikiGroundedCode.bind(fixture));
    const getCodeSymbol = vi.fn(fixture.getCodeSymbol.bind(fixture));
    renderContext({ wikiGraph, listWikiEntities, getWikiEntity, getWikiGroundedCode, getCodeSymbol });

    expect(await screen.findByRole("heading", { level: 1, name: "Context" })).toBeVisible();
    const canvas = await screen.findByLabelText("Context graph");
    for (const node of [...graph.nodes, ...extra]) {
      expect(within(canvas).getByRole("button", { name: `${node.title} · ${node.kind}` })).toBeVisible();
    }
    expect(screen.getByText(/30 entities · \d+ links/)).toBeVisible();
    expect(wikiGraph).toHaveBeenCalledOnce();
    expect(listWikiEntities).not.toHaveBeenCalled();
    expect(getWikiEntity).not.toHaveBeenCalled();
    expect(getWikiGroundedCode).not.toHaveBeenCalled();
    expect(getCodeSymbol).not.toHaveBeenCalled();
  });

  it("switches between graph and the existing paginated list", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const listWikiEntities = vi.fn(fixture.listWikiEntities.bind(fixture));
    renderContext({ listWikiEntities });
    await screen.findByRole("button", { name: HUB_NODE });
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByRole("button", { name: "Load more Knowledge" })).toBeVisible();
    expect(screen.queryByLabelText("Context graph")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/knowledge?view=list");
    expect(listWikiEntities).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(await screen.findByRole("button", { name: HUB_NODE })).toBeVisible();
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reveals direct code on selection, preserves its Wiki context, and clears on Escape without fetching source bodies", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const getWikiEntity = vi.fn(fixture.getWikiEntity.bind(fixture));
    const getWikiGroundedCode = vi.fn(fixture.getWikiGroundedCode.bind(fixture));
    const getCodeSymbol = vi.fn(fixture.getCodeSymbol.bind(fixture));
    renderContext({ getWikiEntity, getWikiGroundedCode, getCodeSymbol });
    await user.click(await screen.findByRole("button", { name: HUB_NODE }));
    const sidebar = within(screen.getByRole("complementary", { name: "Context details" }));
    expect(await sidebar.findByText(/Every indexed response belongs to one stable revision/)).toBeVisible();
    expect(sidebar.getByRole("link", { name: "Open full record" })).toHaveAttribute("href", `/knowledge/${HUB_ID}`);
    const satellite = await screen.findByRole("button", { name: CODE_NODE });
    await user.click(satellite);
    expect(sidebar.getByRole("heading", { name: "createHubServer" })).toBeVisible();
    expect(sidebar.getByRole("link", { name: "Open in Code" })).toHaveAttribute("href", "/code/symbols/sym.createHubServer");
    expect(sidebar.getByText("createHubServer(options: HubServerOptions): Promise<RunningHub>")).toBeVisible();
    expect(screen.getByRole("button", { name: HUB_NODE })).toHaveAttribute("aria-pressed", "true");
    expect(sidebar.getByRole("button", { name: "Back to Project Hub read boundaries" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(sidebar.getByRole("heading", { name: "Follow a connection" })).toBeVisible();
    expect(screen.queryByRole("button", { name: CODE_NODE })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: HUB_NODE })).toHaveAttribute("aria-pressed", "false");
    expect(getWikiEntity).toHaveBeenCalledExactlyOnceWith(HUB_ID);
    expect(getWikiGroundedCode).toHaveBeenCalledExactlyOnceWith(HUB_ID);
    expect(getCodeSymbol).not.toHaveBeenCalled();
  });

  it("replaces code satellites when another Wiki entity is selected and distinguishes no grounding from unavailable code", async () => {
    const user = userEvent.setup();
    renderContext();
    await user.click(await screen.findByRole("button", { name: HUB_NODE }));
    await screen.findByRole("button", { name: CODE_NODE });
    await user.click(screen.getByRole("button", { name: "One snapshot per graph request · decision" }));
    const sidebar = within(screen.getByRole("complementary", { name: "Context details" }));
    expect(await sidebar.findByText("No explicit code grounding recorded.")).toBeVisible();
    expect(sidebar.queryByText("Code index unavailable. Groundings are unverified.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CODE_NODE })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "One snapshot per graph request · decision" })).toHaveAttribute("aria-pressed", "true");
  });

  it.each(["detail", "code"] as const)("hides mismatched %s evidence and code until the graph is reloaded", async (mismatch) => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    renderContext({
      getWikiEntity: async (id) => {
        const result = await fixture.getWikiEntity(id);
        return mismatch === "detail" ? { ...result, indexedRevision: "f".repeat(64) } : result;
      },
      getWikiGroundedCode: async (id) => {
        const result = await fixture.getWikiGroundedCode(id);
        return mismatch === "code" ? { ...result, indexedRevision: "f".repeat(64) } : result;
      },
    });
    await user.click(await screen.findByRole("button", { name: HUB_NODE }));
    const sidebar = within(screen.getByRole("complementary", { name: "Context details" }));
    expect(await sidebar.findByRole("heading", { name: "Context changed" })).toBeVisible();
    expect(sidebar.queryByText(/Every indexed response belongs to one stable revision/)).not.toBeInTheDocument();
    expect(sidebar.queryByRole("link", { name: "Open in Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CODE_NODE })).not.toBeInTheDocument();
    await user.click(sidebar.getByRole("button", { name: "Reload graph" }));
    expect(await sidebar.findByRole("heading", { name: "Follow a connection" })).toBeVisible();
  });

  it.each([
    ["missing", "b".repeat(64)],
    ["unverified", null],
  ] as const)("shows a %s grounding honestly without inventing a symbol", async (health, graphRevision) => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    renderContext({ getWikiGroundedCode: async (id) => ({
      ...await fixture.getWikiGroundedCode(id), graphRevision,
      groundings: [{ requestedNode: "sym.unavailable", resolvedNode: null, health, symbol: null }],
    }) });
    await user.click(await screen.findByRole("button", { name: HUB_NODE }));
    const sidebar = within(screen.getByRole("complementary", { name: "Context details" }));
    expect(await sidebar.findByText(`sym.unavailable · ${health} · code unavailable`)).toBeVisible();
    expect(screen.queryByRole("button", { name: / · code · / })).not.toBeInTheDocument();
    if (graphRevision === null) expect(sidebar.getByText("Code index unavailable. Groundings are unverified.")).toBeVisible();
    else expect(sidebar.queryByText("Code index unavailable. Groundings are unverified.")).not.toBeInTheDocument();
  });

  it("keeps a safe sidebar error independent from the trusted graph and code projection", async () => {
    const user = userEvent.setup();
    renderContext({ getWikiEntity: async () => { throw new Error("sqlite failure at /private/secret.db"); } });
    await user.click(await screen.findByRole("button", { name: HUB_NODE }));
    const sidebar = within(screen.getByRole("complementary", { name: "Context details" }));
    expect(await sidebar.findByRole("heading", { name: "Context unavailable" })).toBeVisible();
    expect(await screen.findByRole("button", { name: CODE_NODE })).toBeVisible();
    expect(screen.queryByText(/private\/secret/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: HUB_NODE })).toBeVisible();
  });

  it("reports graph errors safely and still offers the list fallback", async () => {
    const user = userEvent.setup();
    renderContext({ wikiGraph: async () => { throw new HubApiError({ type: "about:blank", title: "Stale Wiki", status: 409, code: "INDEX_STALE", detail: "Recorded knowledge changed. Inspect Health before refreshing.", requestId: "context_test" }); } });
    expect(await screen.findByRole("heading", { name: "The Context index is stale" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Health" })).toHaveAttribute("href", "/health");
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByRole("button", { name: "Load more Knowledge" })).toBeVisible();
  });

  it("reports a partial graph and keeps type filtering from hiding disconnected units", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const graph = await fixture.wikiGraph();
    renderContext({ wikiGraph: async () => ({ ...graph, relations: [], coverage: { ...graph.coverage, relationsTruncated: true } }) });
    expect(await screen.findByText(/Partial graph: up to 100 entities and 500 relationships are shown/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Architecture" }));
    expect(screen.getByRole("button", { name: "One snapshot per graph request · decision" })).toBeVisible();
    expect(screen.getByRole("button", { name: "One snapshot per graph request · decision" })).toHaveAttribute("data-dimmed", "true");
    await user.click(screen.getByRole("button", { name: "One snapshot per graph request · decision" }));
    expect(await screen.findByText("No relationships in this graph.")).toBeVisible();
  });

  it("keeps an unavailable Wiki capability from requesting graph or selected data", async () => {
    const fixture = createFixtureApi();
    const capabilities = await fixture.getCapabilities();
    const wikiGraph = vi.fn(fixture.wikiGraph.bind(fixture));
    const getWikiEntity = vi.fn(fixture.getWikiEntity.bind(fixture));
    renderContext({ wikiGraph, getWikiEntity, getCapabilities: async () => ({
      ...capabilities, wiki: { ...capabilities.wiki, read: { availability: "unavailable", reason: "Wiki migration requires review." } },
    }) });
    expect(await screen.findByRole("heading", { name: "Context unavailable" })).toBeVisible();
    expect(screen.getByText("Wiki migration requires review.")).toBeVisible();
    expect(wikiGraph).not.toHaveBeenCalled();
    expect(getWikiEntity).not.toHaveBeenCalled();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type { CodeWorkspaceResponse, HealthResponse, SearchResponse } from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function apiWith(overrides: Partial<HubApi>): HubApi {
  const fixture = createFixtureApi();
  return Object.assign(fixture, overrides);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderRoute(route: string, api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={[route]}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

async function graphHealthWithPolicy(
  fixture: ReturnType<typeof createFixtureApi>,
  policy: {
    activeJobId?: string | null;
    allowedJobKinds?: Array<"graph_refresh" | "graph_rebuild">;
  } = {},
): Promise<HealthResponse> {
  const response = await fixture.getHealth();
  return {
    ...response,
    components: response.components.map((component) => component.id === "graph" && component.graph
      ? {
          ...component,
          graph: {
            ...component.graph,
            activeJobId: policy.activeJobId === undefined ? component.graph.activeJobId : policy.activeJobId,
            allowedJobKinds: policy.allowedJobKinds ?? component.graph.allowedJobKinds,
          },
        }
      : component),
  };
}

describe("real Graph search", () => {
  it("uses the Code landing for real symbol and source projections without inventing Wiki results", async () => {
    renderRoute("/code?q=hub");

    expect(await screen.findByRole("heading", { level: 1, name: "Code" })).toBeVisible();
    const links = await screen.findAllByRole("link", { name: /createHubServer/ });
    expect(links[0]).toHaveAttribute("href", "/code/symbols/sym.createHubServer");
    expect(screen.getByText(/export async function createHubServer/)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Knowledge" })).not.toBeInTheDocument();
  });

  it("keeps each source independent when symbol pagination fails and then recovers", async () => {
    const fixture = createFixtureApi();
    const base = await fixture.search({ q: "hub", limit: 25 });
    if (base.groups.symbols.status !== "available") throw new Error("Expected available symbol fixture.");
    const [first, second] = base.groups.symbols.items;
    const firstPage: SearchResponse = {
      ...base,
      groups: {
        ...base.groups,
        symbols: { ...base.groups.symbols, items: [first], nextCursor: "symbols_next", truncated: true },
      },
    };
    const secondPage: SearchResponse = {
      ...base,
      groups: {
        ...base.groups,
        symbols: { ...base.groups.symbols, items: [second], nextCursor: null, truncated: false },
      },
    };
    const search = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error("private graph failure"))
      .mockResolvedValueOnce(secondPage);
    const user = userEvent.setup();
    renderRoute("/search?q=hub", apiWith({ search }));

    expect(await screen.findByText("createHubServer")).toBeVisible();
    expect(screen.getByText(/export async function createHubServer/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more code symbols" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("More code symbols could not be loaded.")).toBeVisible();
    expect(screen.getByText("createHubServer")).toBeVisible();
    expect(screen.getByText(/export async function createHubServer/)).toBeVisible();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("searchNodes")).toBeVisible();
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ symbolCursor: "symbols_next" }));
    expect(search.mock.calls.at(-1)?.[0]).not.toHaveProperty("sourceCursor");
  });

  it("keeps successful symbols visible when source search fails independently", async () => {
    const fixture = createFixtureApi();
    const base = await fixture.search({ q: "hub", limit: 25 });
    const response: SearchResponse = {
      ...base,
      groups: {
        ...base.groups,
        sources: {
          status: "failed",
          items: [],
          nextCursor: null,
          truncated: false,
          revision: null,
          code: "INDEX_CORRUPT",
          detail: "Source retrieval failed; symbol results remain trustworthy.",
        },
      },
    };
    renderRoute("/search?q=hub", apiWith({ search: () => Promise.resolve(response) }));

    expect(await screen.findByText("createHubServer")).toBeVisible();
    expect(screen.getByText("This source failed independently.")).toBeVisible();
    expect(screen.getByText("Source retrieval failed; symbol results remain trustworthy.")).toBeVisible();
  });

  it("refuses to mix search pages from different graph revisions", async () => {
    const fixture = createFixtureApi();
    const base = await fixture.search({ q: "hub", limit: 25 });
    if (base.groups.symbols.status !== "available") throw new Error("Expected available symbol fixture.");
    const initial: SearchResponse = {
      ...base,
      groups: { ...base.groups, symbols: { ...base.groups.symbols, items: [base.groups.symbols.items[0]], nextCursor: "symbols_next", truncated: true } },
    };
    const changed: SearchResponse = {
      ...base,
      groups: { ...base.groups, symbols: { ...base.groups.symbols, items: [base.groups.symbols.items[1]], revision: "c".repeat(64), nextCursor: null } },
    };
    const search = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
    const user = userEvent.setup();
    renderRoute("/search?q=hub", apiWith({ search }));

    expect(await screen.findByText("createHubServer")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more code symbols" }));
    expect(await screen.findByText("This source changed while you were paging.")).toBeVisible();
    expect(screen.getByText("createHubServer")).toBeVisible();
    expect(screen.queryByText("searchNodes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload results" })).toBeEnabled();
  });
});

describe("symbol observatory", () => {
  it("waits for graph capability and never reads a symbol when Graph is unavailable", async () => {
    const fixture = createFixtureApi();
    const capabilities = await fixture.getCapabilities();
    const getCodeSymbol = vi.fn();
    renderRoute("/code/symbols/sym.createHubServer", apiWith({
      getCapabilities: () => Promise.resolve({
        ...capabilities,
        graph: { ...capabilities.graph, read: { availability: "unavailable", reason: "No trusted graph snapshot exists." } },
      }),
      getCodeSymbol,
    }));

    expect(await screen.findByRole("heading", { name: "Code graph unavailable" })).toBeVisible();
    expect(screen.getByText("No trusted graph snapshot exists.")).toBeVisible();
    expect(getCodeSymbol).not.toHaveBeenCalled();
  });

  it("renders exact bounded source and revision identity", async () => {
    renderRoute("/code/symbols/sym.createHubServer");

    expect(await screen.findByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();
    expect(screen.getAllByText("hub.server.createHubServer", { selector: "p" })).toHaveLength(2);
    expect(screen.getByRole("region", { name: /src\/hub\/server.ts, lines 74 through 84/ })).toHaveTextContent("export async function createHubServer(options: HubServerOptions)");
    expect(screen.getByText("sha256:888888888888")).toBeVisible();
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeVisible();
  });

  it("ignores Related Knowledge pagination from a previously displayed symbol", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const oldSymbol = "sym.createHubServer";
    const newSymbol = "sym.GraphPort.searchNodes";
    const first = await fixture.getCodeKnowledge(oldSymbol, { limit: 25 });
    const staleEntity = (await fixture.listWikiEntities({ limit: 25, cursor: "fixture_wiki_2" })).items[0];
    if (!staleEntity) throw new Error("Expected a second Wiki fixture page.");
    type KnowledgePage = Awaited<ReturnType<HubApi["getCodeKnowledge"]>>;
    let resolveOlder!: (page: KnowledgePage) => void;
    const olderPage = new Promise<KnowledgePage>((resolve) => { resolveOlder = resolve; });
    const getCodeKnowledge = vi.fn((symbolId: string, request: Parameters<HubApi["getCodeKnowledge"]>[1]) => {
      if (symbolId === oldSymbol && request.cursor) return olderPage;
      if (symbolId === oldSymbol) return Promise.resolve({ ...first, nextCursor: "old_symbol_cursor", truncated: true });
      return Promise.resolve({ ...first, items: [], nextCursor: null, truncated: false });
    });
    function SwitchSymbol() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(`/code/symbols/${newSymbol}`)} type="button">Switch test symbol</button>;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={apiWith({ getCodeKnowledge })}>
          <MemoryRouter initialEntries={[`/code/symbols/${oldSymbol}`]}>
            <SwitchSymbol />
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: /^Load more$/ }));
    await user.click(screen.getByRole("button", { name: "Switch test symbol" }));
    expect(await screen.findByRole("heading", { level: 1, name: "searchNodes" })).toBeVisible();
    expect(await screen.findByText("No Related Knowledge")).toBeVisible();

    await act(async () => {
      resolveOlder({
        ...first,
        items: [{ entity: staleEntity, matchedNodes: [oldSymbol] }],
        nextCursor: null,
        truncated: false,
      });
      await olderPage;
    });
    expect(screen.queryByText("Review immutable activity")).not.toBeInTheDocument();
    expect(screen.getByText("No Related Knowledge")).toBeVisible();
  });

  it("does not invent a numbered source line for the terminal LF sentinel", async () => {
    const fixture = createFixtureApi();
    const response = await fixture.getCodeSymbol("sym.createHubServer", { view: "overview" });
    const source = response.source.items[0];
    const withTerminalLf: CodeWorkspaceResponse = {
      ...response,
      source: {
        items: [{ ...source, startLine: 10, endLine: 11, content: "const first = true;\n\n" }],
        nextCursor: null,
        truncated: false,
      },
    };
    renderRoute("/code/symbols/sym.createHubServer", apiWith({
      getCodeSymbol: () => Promise.resolve(withTerminalLf),
    }));

    const specimen = await screen.findByRole("region", { name: /lines 10 through 11/ });
    expect(specimen.querySelectorAll("code")).toHaveLength(2);
    expect(within(specimen).getByText("10")).toBeVisible();
    expect(within(specimen).getByText("11")).toBeVisible();
    expect(within(specimen).queryByText("12")).not.toBeInTheDocument();
  });

  it("implements arrow, Home, and End navigation with URL-backed real tabs", async () => {
    const fixture = createFixtureApi();
    const getCodeSymbol = vi.fn((id, request) => fixture.getCodeSymbol(id, request));
    const user = userEvent.setup();
    renderRoute("/code/symbols/sym.createHubServer", apiWith({ getCodeSymbol }));
    const overview = await screen.findByRole("tab", { name: "Overview" });
    overview.focus();

    await user.keyboard("{ArrowRight}");
    const callers = screen.getByRole("tab", { name: "Callers" });
    await waitFor(() => expect(callers).toHaveAttribute("aria-selected", "true"));
    expect(callers).toHaveFocus();
    expect(screen.getByTestId("location")).toHaveTextContent("?view=callers");
    await waitFor(() => expect(getCodeSymbol).toHaveBeenLastCalledWith("sym.createHubServer", expect.objectContaining({ view: "callers", limit: 25 })));

    await user.keyboard("{End}");
    const impact = screen.getByRole("tab", { name: "Impact" });
    await waitFor(() => expect(impact).toHaveAttribute("aria-selected", "true"));
    expect(impact).toHaveFocus();
    expect(await screen.findByRole("heading", { name: "Dependent blast radius" })).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("?view=impact&depth=2");

    await user.keyboard("{Home}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus());
    expect(screen.getByTestId("location")).toHaveTextContent("/code/symbols/sym.createHubServer");
  });

  it("preserves exact source after a page failure and retries only the source cursor", async () => {
    const fixture = createFixtureApi();
    let failed = false;
    const getCodeSymbol = vi.fn((id: string, request: Parameters<HubApi["getCodeSymbol"]>[1]) => {
      if (request.sourceCursor && !failed) {
        failed = true;
        return Promise.reject(new Error("private source failure"));
      }
      return fixture.getCodeSymbol(id, request);
    });
    const user = userEvent.setup();
    renderRoute("/code/symbols/sym.createHubServer", apiWith({ getCodeSymbol }));

    const source = await screen.findByRole("region", { name: /src\/hub\/server.ts, lines 74 through 84/ });
    await user.click(screen.getByRole("button", { name: "Load more source" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("More source could not be loaded.")).toBeVisible();
    expect(source).toHaveTextContent("createHubServer");

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/function listenOnLoopback/)).toBeVisible();
    expect(getCodeSymbol).toHaveBeenLastCalledWith("sym.createHubServer", expect.objectContaining({ sourceCursor: "fixture_source_2", view: "overview" }));
  });

  it("keeps a revision conflict latched until a fresh root response succeeds", async () => {
    const fixture = createFixtureApi();
    const base = await fixture.getCodeSymbol("sym.createHubServer", { view: "callers", limit: 25 });
    if (base.traversal.view !== "callers") throw new Error("Expected callers fixture.");
    const initial: CodeWorkspaceResponse = {
      ...base,
      traversal: { ...base.traversal, nextCursor: "fixture_relations_2" },
    };
    if (initial.traversal.view !== "callers") throw new Error("Expected callers fixture.");
    const page = await fixture.getCodeSymbol("sym.createHubServer", {
      view: "callers",
      limit: 25,
      sourceCursor: "fixture_source_2",
    });
    const changed: CodeWorkspaceResponse = { ...page, revision: "b".repeat(64) };
    const fresh: CodeWorkspaceResponse = {
      ...initial,
      revision: "c".repeat(64),
      traversal: { ...initial.traversal, nextCursor: "fresh_relations_2" },
    };
    const getCodeSymbol = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed)
      .mockRejectedValueOnce(new Error("private root reload failure"))
      .mockResolvedValueOnce(fresh);
    const user = userEvent.setup();
    renderRoute("/code/symbols/sym.createHubServer?view=callers", apiWith({ getCodeSymbol }));

    expect(await screen.findByRole("button", { name: "Load more source" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Load more callers" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Load more source" }));
    const conflict = await screen.findByRole("alert");
    expect(within(conflict).getByText("The graph changed while you were reading.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more callers" })).not.toBeInTheDocument();

    await user.click(within(conflict).getByRole("button", { name: "Reload newest graph" }));
    expect(await within(conflict).findByText("The newest graph could not be reloaded. This revision remains frozen.")).toBeVisible();
    expect(within(conflict).getByRole("button", { name: "Reload newest graph" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Load more source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more callers" })).not.toBeInTheDocument();

    await user.click(within(conflict).getByRole("button", { name: "Reload newest graph" }));
    await waitFor(() => expect(screen.queryByText("The graph changed while you were reading.")).not.toBeInTheDocument());
    expect(screen.getByText("Revision cccccccc")).toBeVisible();
    expect(screen.getByRole("button", { name: "Load more source" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Load more callers" })).toBeEnabled();
  });

  it("keeps graph repair states honest and does not leak backend detail", async () => {
    const getCodeSymbol = vi.fn().mockRejectedValue(new HubApiError({
      type: "about:blank",
      title: "stale",
      status: 409,
      code: "INDEX_STALE",
      detail: "private absolute path and backend detail",
      requestId: "1e586537-c11b-4f73-9b5c-f4de2a8f7bad",
    }));
    renderRoute("/code/symbols/sym.createHubServer", apiWith({ getCodeSymbol }));

    expect(await screen.findByRole("heading", { name: "The graph snapshot is stale" })).toBeVisible();
    expect(screen.queryByText(/private absolute path/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Graph health" })).toHaveAttribute("href", "/health");
  });
});

describe("Graph health and operations", () => {
  it("shows structured graph freshness evidence and confirms destructive rebuild intent", async () => {
    const fixture = createFixtureApi();
    const startJob = vi.fn((request) => fixture.startJob(request));
    const user = userEvent.setup();
    renderRoute("/health", apiWith({
      getHealth: () => graphHealthWithPolicy(fixture, { activeJobId: null }),
      startJob,
    }));

    expect(await screen.findByText("Indexed snapshot")).toBeVisible();
    expect(screen.getByText("Current repository")).toBeVisible();
    expect(screen.getByText("179/183")).toBeVisible();
    expect(screen.getByText("Branch changed")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Rebuild graph/ }));
    const dialog = screen.getByRole("dialog", { name: "Rebuild the code graph?" });
    expect(startJob).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Start graph rebuild" }));
    await waitFor(() => expect(startJob).toHaveBeenCalledWith({ kind: "graph_rebuild" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/jobs?job=job_01K36ZZZ6H7JK8M9NPQRSTVVWX"));
  });

  it("shows the exact graph phase sequence and lets Escape cancel rebuild confirmation", async () => {
    const fixture = createFixtureApi();
    const user = userEvent.setup();
    renderRoute("/jobs?job=job_01K36WVM6H7JK8M9NPQRSTVVWX", apiWith({
      getHealth: () => graphHealthWithPolicy(fixture, { activeJobId: null }),
    }));

    const rail = await screen.findByLabelText("Graph operation phases");
    expect(within(rail).getByText("Discover")).toBeVisible();
    expect(within(rail).getByText("Publish")).toBeVisible();
    expect(within(rail).getByText("Parse")).toHaveAttribute("aria-current", "step");

    const rebuild = screen.getByRole("button", { name: /^Rebuild graph/ });
    await user.click(rebuild);
    expect(screen.getByRole("dialog", { name: "Rebuild the code graph?" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Rebuild the code graph?" })).not.toBeInTheDocument();
    expect(rebuild).toHaveFocus();
  });

  it("keeps graph controls disabled when Health does not authorize the operation", async () => {
    const fixture = createFixtureApi();
    const startJob = vi.fn((request) => fixture.startJob(request));
    const user = userEvent.setup();
    renderRoute("/jobs", apiWith({
      getHealth: () => graphHealthWithPolicy(fixture, {
        activeJobId: null,
        allowedJobKinds: ["graph_refresh"],
      }),
      startJob,
    }));

    const refresh = await screen.findByRole("button", { name: /^Refresh graph/ });
    const rebuild = screen.getByRole("button", { name: /^Rebuild graph/ });
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(rebuild).toBeDisabled();
    expect(rebuild).toHaveAttribute("title", "The current graph state does not allow this operation.");
    await user.click(rebuild);
    expect(startJob).not.toHaveBeenCalled();
  });

  it("invalidates Graph read caches from the app lifetime after a successful job snapshot", async () => {
    const fixture = createFixtureApi();
    const page = await fixture.getJobs();
    const running = page.items.find((job) => job.kind === "graph_refresh");
    if (!running) throw new Error("Expected a running graph fixture.");
    let publish: ((job: typeof running) => void) | undefined;
    const subscribeToJob = vi.fn((_id: string, onSnapshot: (job: typeof running) => void) => {
      publish = onSnapshot;
      return { close() {} };
    });
    const rendered = renderRoute("/search", apiWith({
      getJobs: () => Promise.resolve({ items: [running], nextCursor: null }),
      subscribeToJob,
    }));
    const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");
    await screen.findByRole("heading", { name: "Search" });
    await waitFor(() => expect(subscribeToJob).toHaveBeenCalled());

    publish?.({ ...running, state: "running", phase: "validate" });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["jobs"] }));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["search"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["health"] });
    invalidate.mockClear();

    publish?.({ ...running, state: "succeeded", phase: "publish", finishedAt: "2026-08-23T09:00:00.000Z" });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["code-symbol"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["capabilities"] });
  });

  it("reconciles a job that finished before the lifetime observer subscribed", async () => {
    const fixture = createFixtureApi();
    const page = await fixture.getJobs();
    const succeeded = page.items.find((job) => job.kind === "wiki_refresh" && job.state === "succeeded");
    if (!succeeded) throw new Error("Expected a succeeded Wiki fixture.");
    const getJobs = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValue({ items: [succeeded], nextCursor: null });
    const subscribeToJob = vi.fn();
    const rendered = renderRoute("/search", apiWith({ getJobs, subscribeToJob }));
    const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

    await waitFor(() => expect(getJobs).toHaveBeenCalledTimes(1));
    await rendered.queryClient.invalidateQueries({ queryKey: ["job-lifecycle"] });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wiki-entities"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["code-knowledge"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["capabilities"] });
    expect(subscribeToJob).not.toHaveBeenCalled();
  });
});

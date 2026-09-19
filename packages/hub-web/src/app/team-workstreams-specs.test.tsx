import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function renderRoute(route: string, api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={[route]}>
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

async function approveExactPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Review apply" }));
  const confirmation = await screen.findByRole("alertdialog", { name: "Apply this exact preview?" });
  await user.click(within(confirmation).getByRole("button", { name: "Apply approved preview" }));
}

describe("Workstream workbench", () => {
  it("invalidates an edited create preview and applies only the second exact envelope", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    const { queryClient } = renderRoute("/workstreams", api);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(await screen.findByRole("heading", { level: 1, name: "Workstreams" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Create Workstream" }));
    const dialog = await screen.findByRole("dialog", { name: "Create Workstream" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    await user.type(title, "Specification review");
    await user.type(within(dialog).getByRole("textbox", { name: "Goal" }), "Keep specification evidence explicit.");
    await user.type(within(dialog).getByRole("textbox", { name: "Summary" }), "Connect the dedicated reader to the Hub.");
    await user.type(within(dialog).getByRole("textbox", { name: "Next milestone" }), "Review the bounded hierarchy.");
    await user.click(within(dialog).getByRole("button", { name: "Preview change" }));
    expect(await within(dialog).findByRole("heading", { name: "Operation preview" })).toBeVisible();

    await user.clear(title);
    await user.type(title, "Specification evidence review");
    expect(within(dialog).queryByRole("heading", { name: "Operation preview" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Preview change" }));
    const reviewed = await preview.mock.results[1]!.value;

    await approveExactPreview(user);
    expect(await screen.findByText("Canonical Workstream change applied with one immutable Activity event.")).toBeVisible();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]![0]).toEqual(reviewed);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]![0].request.action).toMatchObject({
      kind: "workstream.create",
      workstream: { title: "Specification evidence review" },
    });
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toContainEqual(["workstreams"]);
    expect(invalidated).toContainEqual(["activity"]);
    expect(invalidated).toContainEqual(["home"]);
  });

  it("requires blocker evidence before previewing a blocked transition", async () => {
    const user = userEvent.setup();
    renderRoute("/workstreams");

    expect(await screen.findByRole("heading", { level: 2, name: "Human-team memory" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Update" }));
    const dialog = await screen.findByRole("dialog", { name: "Update Human-team memory" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Lifecycle state" }), "blocked");
    const preview = within(dialog).getByRole("button", { name: "Preview change" });
    expect(preview).toBeDisabled();
    expect(within(dialog).getByText("A blocked Workstream requires at least one blocker.")).toHaveAttribute("role", "alert");
    await user.type(within(dialog).getByRole("textbox", { name: /Blockers/ }), "Waiting for exact review evidence");
    expect(preview).toBeEnabled();
    await user.click(preview);
    expect(await within(dialog).findByRole("heading", { name: "Operation preview" })).toBeVisible();
  });

  it("closes on Escape and restores focus to the create trigger", async () => {
    const user = userEvent.setup();
    renderRoute("/workstreams");
    const trigger = await screen.findByRole("button", { name: "Create Workstream" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Create Workstream" });
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create Workstream" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("keeps unavailable, empty, and bounded error states explicit", async () => {
    const unavailableApi = createFixtureApi();
    const capabilities = await unavailableApi.getCapabilities();
    const listUnavailable = vi.spyOn(unavailableApi, "getWorkstreams");
    vi.spyOn(unavailableApi, "getCapabilities").mockResolvedValue({
      ...capabilities,
      workstreams: {
        ...capabilities.workstreams,
        read: { availability: "unavailable", reason: "The Workstream repository is not connected." },
      },
    });
    const unavailableView = renderRoute("/workstreams", unavailableApi);

    expect(await screen.findByRole("heading", { name: "Workstreams are unavailable" })).toBeVisible();
    expect(screen.getByText("The Workstream repository is not connected.")).toBeVisible();
    expect(listUnavailable).not.toHaveBeenCalled();
    unavailableView.unmount();

    const emptyApi = createFixtureApi();
    vi.spyOn(emptyApi, "getWorkstreams").mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "a".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    const emptyView = renderRoute("/workstreams", emptyApi);
    expect(await screen.findByRole("heading", { name: "No matching Workstreams" })).toBeVisible();
    emptyView.unmount();

    const errorApi = createFixtureApi();
    vi.spyOn(errorApi, "getWorkstreams").mockRejectedValue(new Error("private repository path"));
    renderRoute("/workstreams", errorApi);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(alert).not.toHaveTextContent("private repository path");
  });

  it("keeps valid Workstreams visible beside bounded source diagnostics", async () => {
    const api = createFixtureApi();
    const response = await api.getWorkstreams({ limit: 50 });
    vi.spyOn(api, "getWorkstreams").mockResolvedValue({
      ...response,
      sourceTruncated: true,
      diagnostics: [{
        code: "WORKSTREAM_ENTRY_LIMIT",
        severity: "warning",
        message: "The Workstream directory reached its bounded entry limit.",
      }],
    });
    renderRoute("/workstreams", api);

    expect(await screen.findByRole("heading", { level: 2, name: "Human-team memory" })).toBeVisible();
    expect(screen.getByText("Some Workstream memory needs attention.")).toBeVisible();
    expect(screen.getByText(/bounded entry limit/)).toBeVisible();
    expect(screen.getByText(/Valid canonical rows remain visible/)).toBeVisible();
  });
});

describe("read-only Spec workbench", () => {
  it("uses real Spec routes and exposes hierarchy, provenance, and grounding without edit controls", async () => {
    const user = userEvent.setup();
    renderRoute("/specs");

    expect(await screen.findByRole("heading", { level: 1, name: "Specs" })).toBeVisible();
    const specLink = await screen.findByRole("link", { name: /Human-team memory release/ });
    expect(specLink).toHaveAttribute("href", expect.stringMatching(/^\/specs\/mx_/));
    await user.click(specLink);
    expect(await screen.findByRole("heading", { level: 2, name: "Human-team memory release" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Requirements" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Acceptance criteria" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Constraints" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Provenance" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Grounding" })).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText("No inferred coverage.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /edit|update|create/i })).not.toBeInTheDocument();
  });

  it("fails closed on a stale index and never asks for detail", async () => {
    const api = createFixtureApi();
    vi.spyOn(api, "listSpecs").mockResolvedValue({
      availability: "stale",
      index: {
        state: "stale",
        observedAt: "2026-08-28T00:00:00.000Z",
        indexedRevision: "a".repeat(64),
        indexedAt: "2026-08-27T23:00:00.000Z",
        diagnostics: [{ code: "WIKI_STALE", severity: "warning", message: "The Wiki index is behind HEAD." }],
        diagnosticsTruncated: false,
      },
      page: null,
    });
    const show = vi.spyOn(api, "getSpec");
    renderRoute("/specs", api);

    expect(await screen.findByText("Specs need a fresh Wiki index")).toBeVisible();
    expect(screen.getByText(/fails closed/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /Review health/ })).toHaveAttribute("href", "/health");
    expect(show).not.toHaveBeenCalled();
  });

  it("reports a disconnected private Spec reader as unavailable", async () => {
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      ...capabilities,
      specs: {
        read: { availability: "unavailable", reason: "The dedicated Spec reader is not configured." },
      },
    });
    renderRoute("/specs", api);

    expect(await screen.findByText("Specs are unavailable")).toBeVisible();
    expect(screen.getByText("The dedicated Spec reader is not configured.")).toBeVisible();
  });

  it("keeps empty and bounded reader errors distinct", async () => {
    const emptyApi = createFixtureApi();
    const response = await emptyApi.listSpecs({ limit: 50 });
    if (response.availability !== "ready") throw new Error("Expected the ready fixture Spec index.");
    vi.spyOn(emptyApi, "listSpecs").mockResolvedValue({
      ...response,
      page: { ...response.page, items: [], nextCursor: null, truncated: false },
    });
    const emptyView = renderRoute("/specs", emptyApi);
    expect(await screen.findByRole("heading", { name: "No matching Specs" })).toBeVisible();
    emptyView.unmount();

    const errorApi = createFixtureApi();
    vi.spyOn(errorApi, "listSpecs").mockRejectedValue(new Error("private Wiki database path"));
    renderRoute("/specs", errorApi);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(alert).not.toHaveTextContent("private Wiki database path");
  });

  it("keeps trusted Specs visible beside terminal safety truncation", async () => {
    const api = createFixtureApi();
    const response = await api.listSpecs({ limit: 50 });
    if (response.availability !== "ready") throw new Error("Expected the ready fixture Spec index.");
    vi.spyOn(api, "listSpecs").mockResolvedValue({
      ...response,
      page: { ...response.page, nextCursor: null, truncated: true },
    });
    renderRoute("/specs", api);

    expect(await screen.findByRole("link", { name: /Human-team memory release/ })).toBeVisible();
    expect(screen.getByText("Some Spec index evidence needs attention.")).toBeVisible();
    expect(screen.getByText(/bounded list omitted additional root Specs/)).toBeVisible();
  });

  it("claims fresh grounding evidence only when a complete nonempty set is fresh", async () => {
    const emptyApi = createFixtureApi();
    const specs = await emptyApi.listSpecs({ limit: 1 });
    if (specs.availability !== "ready" || specs.page.items[0] === undefined) {
      throw new Error("Expected the ready fixture Spec index.");
    }
    const specId = specs.page.items[0].id;
    const empty = await emptyApi.getSpec(specId);
    if (empty.availability !== "ready") throw new Error("Expected the ready fixture Spec detail.");
    vi.spyOn(emptyApi, "getSpec").mockResolvedValue({
      ...empty,
      detail: { ...empty.detail, groundings: [], groundingsTruncated: false },
    });
    const emptyView = renderRoute(`/specs/${specId}`, emptyApi);
    expect(await screen.findByText("No grounding evidence")).toBeVisible();
    expect(screen.queryByText("Evidence fresh")).not.toBeInTheDocument();
    emptyView.unmount();

    const boundedApi = createFixtureApi();
    const bounded = await boundedApi.getSpec(specId);
    if (bounded.availability !== "ready") throw new Error("Expected the ready fixture Spec detail.");
    vi.spyOn(boundedApi, "getSpec").mockResolvedValue({
      ...bounded,
      detail: {
        ...bounded.detail,
        sourcesTruncated: true,
        groundingsTruncated: false,
      },
    });
    renderRoute(`/specs/${specId}`, boundedApi);
    expect(await screen.findByText("Evidence bounded")).toBeVisible();
    expect(screen.queryByText("Evidence fresh")).not.toBeInTheDocument();
  });
});

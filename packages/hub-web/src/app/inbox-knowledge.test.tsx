import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type { InboxOperationPreviewResponse, WikiEntityDetailResponse } from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function mount(api: HubApi, route = "/inbox?view=drafts") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><HubApiProvider api={api}>
    <MemoryRouter initialEntries={[route]}><AppRoutes /></MemoryRouter>
  </HubApiProvider></QueryClientProvider>);
  return queryClient;
}

async function createDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Create manually" }));
  return screen.findByRole("dialog", { name: "Create local knowledge draft" });
}

describe("ordinary knowledge Inbox", () => {
  it("offers the six knowledge kinds and saves one checkout-local pattern through the exact envelope", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    let envelope: InboxOperationPreviewResponse | undefined;
    const preview = vi.spyOn(api, "previewInboxOperation").mockImplementation(async (request) => {
      envelope = await realPreview(request); return envelope;
    });
    const apply = vi.spyOn(api, "applyInboxOperation");
    mount(api);
    const dialog = await createDialog(user);
    expect(within(dialog).getByText(/private to this checkout/)).toBeVisible();
    const kind = within(dialog).getByRole("combobox", { name: "Knowledge kind" });
    expect(within(kind).getAllByRole("option").map((option) => option.getAttribute("value")))
      .toEqual(["architecture", "component", "convention", "decision", "pattern", "guide"]);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Preserve accepted evidence" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Summary (optional)" }), { target: { value: "Review drift explicitly." } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Knowledge body" }), { target: { value: "Keep the old body.\n\tAccept only reviewed changes." } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Rationale" }), { target: { value: "Successful execution is not review." } });
    await user.click(within(dialog).getByRole("button", { name: "Advanced" }));
    expect(within(dialog).queryByRole("combobox", { name: /hierarchy relation/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(preview.mock.calls[0]![0].action).toMatchObject({ kind: "inbox.draft.save", draft: {
      change: { kind: "knowledge.create", entityKind: "pattern", title: "Preserve accepted evidence", summary: "Review drift explicitly.", body: "Keep the old body.\n\tAccept only reviewed changes." },
      rationale: "Successful execution is not review.", targetRevisions: [],
    } });
    expect(apply.mock.calls[0]![0]).toBe(envelope);
    expect(envelope?.preview.scope).toBe("local");
    expect(envelope?.preview.changes).toEqual([]);
    expect(await screen.findByRole("heading", { level: 2, name: "Preserve accepted evidence" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Preserve accepted evidence/ })).toHaveAttribute("aria-current", "true");
  });

  it("loads an ordinary Wiki target and preserves an explicit summary-only patch with exact revisions", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const target = (await api.listWikiEntities({ kind: "architecture", limit: 25 })).items[0]!;
    const current = await api.getWikiEntity(target.id);
    const list = vi.spyOn(api, "listWikiEntities");
    const detail = vi.spyOn(api, "getWikiEntity");
    const spec = vi.spyOn(api, "getSpec");
    const specs = vi.spyOn(api, "listSpecs");
    const preview = vi.spyOn(api, "previewInboxOperation");
    mount(api);
    const dialog = await createDialog(user);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Change type" }), "update");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Knowledge kind" }), "architecture");
    await within(dialog).findByRole("option", { name: target.title });
    expect(detail).not.toHaveBeenCalled();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Knowledge to update" }), target.id);
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Replacement body" })).toHaveValue(current.body.content));
    expect(list).toHaveBeenCalledWith({ kind: "architecture", limit: 25 });
    expect(detail).toHaveBeenCalledWith(target.id);
    expect(spec).not.toHaveBeenCalled(); expect(specs).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Body" }));
    await user.click(within(dialog).getByRole("button", { name: "Summary" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Replacement summary" }), { target: { value: "" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Rationale" }), { target: { value: "The body already carries the complete rationale." } });
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(preview.mock.calls[0]![0].action).toMatchObject({ kind: "inbox.draft.save", draft: {
      change: { kind: "knowledge.update", target: { id: target.id, kind: "architecture", title: target.title }, patch: { summary: "" } },
      targetRevisions: [{ target: { kind: "entity", id: target.id }, revision: target.version.contentHash, semanticRevision: target.version.semanticRevision }],
    } });
  });

  it.each(["kind", "mode"])("discards a late target response after changing %s", async (change) => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const target = (await api.listWikiEntities({ kind: "architecture", limit: 25 })).items[0]!;
    const current = await api.getWikiEntity(target.id);
    let resolve!: (value: WikiEntityDetailResponse) => void;
    vi.spyOn(api, "getWikiEntity").mockImplementation(() => new Promise((done) => { resolve = done; }));
    mount(api);
    const dialog = await createDialog(user);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Change type" }), "update");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Knowledge kind" }), "architecture");
    await within(dialog).findByRole("option", { name: target.title });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Knowledge to update" }), target.id);
    expect(within(dialog).getByRole("textbox", { name: "Replacement body" })).toBeDisabled();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: change === "kind" ? "Knowledge kind" : "Change type" }), change === "kind" ? "guide" : "create");
    await act(async () => { resolve(current); });
    if (change === "kind") {
      expect(within(dialog).getByRole("combobox", { name: "Knowledge kind" })).toHaveValue("guide");
      expect(within(dialog).getByRole("combobox", { name: "Knowledge to update" })).toHaveValue("");
    } else {
      expect(within(dialog).getByRole("combobox", { name: "Change type" })).toHaveValue("create");
      expect(within(dialog).getByRole("textbox", { name: "Knowledge body" })).toHaveValue("");
      expect(within(dialog).getByRole("textbox", { name: "Knowledge body" })).toBeEnabled();
    }
    expect(within(dialog).getByRole("button", { name: "Save draft" })).toBeDisabled();
  });
});

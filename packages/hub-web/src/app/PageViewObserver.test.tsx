import { act, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { PageViewObserver } from "./PageViewObserver";

describe("Hub page views", () => {
  it("records route categories once, omitting query/hash/identifiers and idle renders", async () => {
    const recordPageView = vi.fn(async () => undefined);
    const api = { ...createFixtureApi(), recordPageView };
    const router = createMemoryRouter([{ path: "*", element: <PageViewObserver /> }], {
      initialEntries: ["/knowledge/mx_private?query=private%40example.test#private-token"],
    });
    const rendered = render(<StrictMode><HubApiProvider api={api}><RouterProvider router={router} /></HubApiProvider></StrictMode>);
    await waitFor(() => expect(recordPageView).toHaveBeenCalledOnce());
    await act(() => router.navigate("/knowledge/mx_private?query=another-secret#another-token"));
    expect(recordPageView).toHaveBeenCalledOnce();
    await act(() => router.navigate("/code/symbols/private-source-id?view=callers"));
    await act(() => router.navigate("/code/symbols/another-source-id?view=callers"));
    await act(() => router.navigate("/relays?relay=relay_private"));
    await act(() => router.navigate("/unknown/private/path"));
    rendered.rerender(<StrictMode><HubApiProvider api={api}><RouterProvider router={router} /></HubApiProvider></StrictMode>);
    expect(recordPageView.mock.calls).toEqual([
      ["knowledge_detail"], ["code_symbol"], ["code_symbol"], ["relays"], ["not_found"],
    ]);
    expect(JSON.stringify(recordPageView.mock.calls)).not.toMatch(/private|query|token|view|source-id/);
  });

  it("leaves fixtures quiet and ignores optional observer delivery failure", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const router = createMemoryRouter([{ path: "*", element: <PageViewObserver /> }]);
    const rendered = render(<HubApiProvider api={createFixtureApi()}><RouterProvider router={router} /></HubApiProvider>);
    await act(() => router.navigate("/jobs"));
    expect(fetch).not.toHaveBeenCalled();
    rendered.unmount();
    fetch.mockRestore();
    const recordPageView = vi.fn(async () => { throw new Error("local transport failed"); });
    const failingRouter = createMemoryRouter([{ path: "*", element: <PageViewObserver /> }]);
    render(<HubApiProvider api={{ ...createFixtureApi(), recordPageView }}><RouterProvider router={failingRouter} /></HubApiProvider>);
    await waitFor(() => expect(recordPageView).toHaveBeenCalledOnce());
    await act(() => failingRouter.navigate("/settings"));
    expect(recordPageView).toHaveBeenLastCalledWith("settings");
  });
});

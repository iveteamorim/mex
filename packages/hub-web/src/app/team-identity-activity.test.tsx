import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type {
  CapabilitiesResponse,
  TeamMember,
  TeamMemberListResponse,
  TeamOperationPreviewResponse,
} from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

const ADA_ID = "member_01K36WVM6H7JK8M9NPQRSTVVWX";
const GRACE_ID = "member_01K36R3X4A5BC6DE7FGHJKMNPQ";
const LIN_ID = "member_01K35Z2A3B4C5D6E7FGHJKMNPQ";
const MISSING_ID = "member_01K39WVM6H7JK8M9NPQRSTVVWX";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="route-location" hidden>{`${location.pathname}${location.search}`}</span>;
}

function renderRoute(api: HubApi = createFixtureApi(), initialEntry = "/members") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={[initialEntry]}>
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

function routeLocation(): string {
  return screen.getByTestId("route-location").textContent ?? "";
}

async function openMemberDialog(
  user: ReturnType<typeof userEvent.setup>,
  triggerName: string | RegExp,
  dialogName: string | RegExp,
) {
  await user.click(await screen.findByRole("button", { name: triggerName }));
  return screen.findByRole("dialog", { name: dialogName });
}

async function reviewMember(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  confirmationName: string | RegExp,
) {
  await user.click(within(dialog).getByRole("button", { name: "Review member" }));
  return screen.findByRole("alertdialog", { name: confirmationName });
}

function unavailableCapabilities(
  current: CapabilitiesResponse,
  key: "read" | "canonicalMutation" | "localSelection",
  reason: string,
): CapabilitiesResponse {
  return {
    ...current,
    members: {
      ...current.members,
      [key]: { availability: "unavailable", reason },
    },
  };
}

describe("Members identity and team directory", () => {
  it("makes configured identity primary, defaults to the effective Member, and hides protocol details", async () => {
    const api = createFixtureApi({ memberFixture: "configured" });
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute(api);

    expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    const identity = screen.getByRole("region", { name: "Your identity" });
    expect(await within(identity).findByText("You’re working as Ada Lovelace.")).toBeVisible();
    expect(within(identity).getByText("Chosen for this checkout")).toBeVisible();
    expect(within(identity).getByRole("button", { name: "Use Git identity instead" })).toBeEnabled();
    expect(within(identity).getByText("This controls how MEX attributes actions in this checkout. It is not authentication.")).toBeVisible();

    await waitFor(() => expect(routeLocation()).toContain(`member=${ADA_ID}`));
    const detail = await screen.findByRole("region", { name: "Selected Member detail" });
    expect(await within(detail).findByRole("heading", { name: "Ada Lovelace" })).toBeVisible();
    expect(within(detail).getByText("You", { selector: "[data-slot='badge']" })).toBeVisible();
    const technical = within(detail).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");
    expect(within(detail).queryByText(ADA_ID)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deactivate/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ loaded/i)).not.toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("reactivates the existing inactive Member only after exact review and returns to their active record", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const original = await api.getMember(LIN_ID);
    expect(original.active).toBe(false);
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute(api, `/members?status=inactive&member=${LIN_ID}`);
    await user.click(await screen.findByRole("button", { name: "Reactivate Member" }));
    const dialog = await screen.findByRole("alertdialog", { name: `Reactivate ${original.displayName}?` });
    const confirm = within(dialog).getByRole("button", { name: "Reactivate Member" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(apply).not.toHaveBeenCalled();
    expect(preview.mock.calls[0]![0]).toMatchObject({ action: { kind: "member.reactivate", memberId: LIN_ID }, expectedRevisions: [{ target: { kind: "artifact", path: original.sourcePath }, revision: original.revision }] });
    expect(within(dialog).getByText(/Commit and push to share it through Git/)).toBeVisible();
    await user.click(confirm);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toBe(await preview.mock.results[0]!.value);
    await waitFor(() => expect(routeLocation()).toContain(`status=active&member=${LIN_ID}`));
    expect(await screen.findByText("Member reactivated")).toBeVisible();
    expect(await api.getMember(LIN_ID)).toMatchObject({ id: LIN_ID, active: true, displayName: original.displayName });
  });

  it("keeps Member reactivation blocked when the reviewed target differs", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewTeamOperation.bind(api);
    vi.spyOn(api, "previewTeamOperation").mockImplementation(async (request) => ({
      ...await realPreview(request), request: { ...request, action: { kind: "member.reactivate", memberId: GRACE_ID } },
    }));
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute(api, `/members?status=inactive&member=${LIN_ID}`);
    await user.click(await screen.findByRole("button", { name: "Reactivate Member" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("This view could not be loaded")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Reactivate Member" })).toBeDisabled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("marks a Git-alias match as You even without a local selection", async () => {
    const api = createFixtureApi({ memberFixture: "git-alias" });
    renderRoute(api);

    const identity = await screen.findByRole("region", { name: "Your identity" });
    expect(await within(identity).findByText("MEX recognizes you as Ada Lovelace.")).toBeVisible();
    expect(within(identity).getByText("Matched automatically from your Git identity. No local override is saved.")).toBeVisible();
    expect(within(identity).queryByText(/fallback/i)).not.toBeInTheDocument();
    await waitFor(() => expect(routeLocation()).toContain(`member=${ADA_ID}`));
    const detail = await screen.findByRole("region", { name: "Selected Member detail" });
    expect(await within(detail).findByText("You", { selector: "[data-slot='badge']" })).toBeVisible();
    expect(within(detail).queryByText(/not selected/i)).not.toBeInTheDocument();
  });

  it.each([
    {
      variant: "git-fallback" as const,
      headline: "Your Git identity isn’t linked to a MEX member.",
      action: "Add myself",
    },
    {
      variant: "unknown" as const,
      headline: "MEX could not find a usable Git identity.",
      action: "Add myself",
    },
    {
      variant: "ambiguous" as const,
      headline: "Your Git identity matches more than one MEX member.",
      action: "Choose an existing member",
    },
  ])("renders the $variant identity recovery honestly", async ({ variant, headline, action }) => {
    const api = createFixtureApi({ memberFixture: variant });
    const { unmount } = renderRoute(api);

    const identity = await screen.findByRole("region", { name: "Your identity" });
    expect(await within(identity).findByText(headline)).toBeVisible();
    expect(within(identity).getByRole("button", { name: action })).toBeEnabled();
    if (variant !== "ambiguous") {
      expect(within(identity).getByRole("button", { name: "Choose an existing member" })).toBeEnabled();
    } else {
      expect(within(identity).getByText(/MEX did not guess/i)).toBeVisible();
      await userEvent.setup().click(within(identity).getByRole("button", { name: "Identity diagnostic details" }));
      expect(within(identity).getByText("ACTOR_ALIAS_AMBIGUOUS")).toBeVisible();
    }
    unmount();
  });

  it.each([
    ["stale", "Your saved Member no longer exists."],
    ["inactive", "Your saved Member is inactive."],
  ] as const)("requires clear-first recovery for a %s saved selection", async (variant, diagnostic) => {
    const user = userEvent.setup();
    const api = createFixtureApi({ memberFixture: variant });
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    const { unmount } = renderRoute(api);

    const identity = await screen.findByRole("region", { name: "Your identity" });
    expect(await within(identity).findByText("Your saved identity choice must be removed first.")).toBeVisible();
    expect(within(identity).getByText(diagnostic)).toBeVisible();
    expect(within(identity).getByRole("button", { name: "Remove saved choice" })).toBeEnabled();
    expect(within(identity).queryByRole("button", { name: /choose an existing member/i })).not.toBeInTheDocument();
    expect(within(identity).queryByRole("button", { name: /add myself/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add member" })).toBeDisabled();
    await user.click(document.querySelector<HTMLButtonElement>(`button[data-member-id="${ADA_ID}"]`)!);
    await screen.findByRole("heading", { name: "Ada Lovelace" });
    expect(screen.getByRole("button", { name: "Edit member" })).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();

    if (variant === "stale") {
      await user.click(within(identity).getByRole("button", { name: "Remove saved choice" }));
      const confirmation = await screen.findByRole("alertdialog", { name: "Remove your saved identity choice?" });
      expect(within(confirmation).getByText(/writes neither Git files nor Activity/i)).toBeVisible();
      await user.click(within(confirmation).getByRole("button", { name: "Remove saved choice" }));
      await screen.findByText("Saved identity removed");
      const reviewed = await preview.mock.results[0]!.value;
      expect(apply).toHaveBeenCalledWith(reviewed);
      const result = await apply.mock.results[0]!.value;
      expect(result.events).toEqual([]);
      expect(await screen.findByText("MEX recognizes you as Ada Lovelace.")).toBeVisible();
    }
    unmount();
  });

  it("uses structured aliases, discloses Git-shared PII, invalidates edited previews, and applies the exact second envelope", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute(api);

    const dialog = await openMemberDialog(user, "Edit member", "Edit Ada Lovelace");
    expect(within(dialog).getByText(/Names and emails are committed to the repository and may become public history/i)).toBeVisible();
    expect(within(dialog).getByText(/does not invite anyone or grant repository access/i)).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "Git email" })).toHaveValue("ada@example.test");
    expect(within(dialog).getByRole("textbox", { name: /Git name/ })).toHaveValue("Ada");
    expect(within(dialog).getByRole("button", { name: "Add another identity" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Remove identity" })).toBeEnabled();

    const name = within(dialog).getByRole("textbox", { name: "Display name" });
    await user.clear(name);
    await user.type(name, "Ada Byron");
    let confirmation = await reviewMember(user, dialog, "Save changes to Ada Lovelace?");
    expect(within(confirmation).getByRole("button", { name: "Technical details" })).toHaveAttribute("aria-expanded", "false");
    await user.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    await user.clear(name);
    await user.type(name, "Ada King");
    confirmation = await reviewMember(user, dialog, "Save changes to Ada Lovelace?");
    const reviewed = await preview.mock.results[1]!.value;
    await user.click(within(confirmation).getByRole("button", { name: "Save member" }));

    expect(await screen.findByText("Member updated in your working tree. Commit and push to share the change.")).toBeVisible();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(reviewed);
  });

  it("blocks unchanged edits and validates empty and name-only identity rows before preview", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewTeamOperation");
    renderRoute(api);

    const dialog = await openMemberDialog(user, "Edit member", "Edit Ada Lovelace");
    expect(within(dialog).getByRole("button", { name: "Review member" })).toBeDisabled();
    expect(within(dialog).getByText("Change the display name or a Git identity before reviewing.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Add another identity" }));
    expect(within(dialog).getByText(/Enter a Git name or email for each identity/i)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Review member" })).toBeDisabled();

    const gitNames = within(dialog).getAllByRole("textbox", { name: /Git name/ });
    await user.type(gitNames[1]!, "Countess Lovelace");
    expect(within(dialog).getByText(/Name-only matching can be ambiguous/i)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Review member" })).toBeEnabled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("treats alias reordering as an unchanged edit", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const originalGetMember = api.getMember.bind(api);
    const base = await originalGetMember(ADA_ID);
    const reorderedMember: TeamMember = {
      ...base,
      gitAliases: [
        { name: "Zeta", email: "zeta@example.test" },
        { name: "Ada", email: "ada@example.test" },
      ],
    };
    vi.spyOn(api, "getMember").mockImplementation((id) => (
      id === ADA_ID ? Promise.resolve(structuredClone(reorderedMember)) : originalGetMember(id)
    ));
    const preview = vi.spyOn(api, "previewTeamOperation");
    renderRoute(api);

    const dialog = await openMemberDialog(user, "Edit member", "Edit Ada Lovelace");
    expect(within(dialog).getAllByRole("button", { name: "Remove identity" })).toHaveLength(2);
    await user.click(within(dialog).getAllByRole("button", { name: "Remove identity" })[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Remove identity" }));
    await user.click(within(dialog).getByRole("button", { name: "Add another identity" }));
    await user.click(within(dialog).getByRole("button", { name: "Add another identity" }));

    const emails = within(dialog).getAllByRole("textbox", { name: "Git email" });
    const names = within(dialog).getAllByRole("textbox", { name: /Git name/ });
    await user.type(emails[0]!, "ada@example.test");
    await user.type(names[0]!, "Ada");
    await user.type(emails[1]!, "zeta@example.test");
    await user.type(names[1]!, "Zeta");

    expect(within(dialog).getByText("Change the display name or a Git identity before reviewing.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Review member" })).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("prefills Add myself from Git and reports automatic matching after the canonical add", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ memberFixture: "git-fallback" });
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute(api);

    const dialog = await openMemberDialog(user, "Add myself", "Add yourself");
    expect(within(dialog).getByRole("textbox", { name: "Display name" })).toHaveValue("MEX Contributor");
    expect(within(dialog).getByRole("textbox", { name: "Git email" })).toHaveValue("contributor@example.test");
    expect(within(dialog).getByRole("textbox", { name: /Git name/ })).toHaveValue("MEX Contributor");
    const confirmation = await reviewMember(user, dialog, "Add this member?");
    await user.click(within(confirmation).getByRole("button", { name: "Add member" }));

    expect(await screen.findByText(/Member added in your working tree\. Commit and push to share this identity with teammates\./)).toBeVisible();
    expect(await screen.findByText(/MEX now recognizes you as MEX Contributor from your Git identity\./)).toBeVisible();
    expect(await screen.findByText("MEX recognizes you as MEX Contributor.")).toBeVisible();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("applies a local identity override with the exact envelope and does not invalidate Activity", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ memberFixture: "git-alias" });
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    const { queryClient } = renderRoute(api);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const identity = await screen.findByRole("region", { name: "Your identity" });
    const dialog = await openMemberDialog(user, "Choose an existing member", "Choose your identity");
    const picker = within(dialog).getByRole("combobox", { name: "Team member" });
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /Grace Hopper/ }));
    await user.click(within(dialog).getByRole("button", { name: "Review local override" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Work as Grace Hopper in this checkout?" });
    expect(within(confirmation).getByText(/not sign-in, writes no Git files, and creates no Activity/i)).toBeVisible();
    await user.click(within(confirmation).getByRole("button", { name: "Use as me" }));

    expect(await screen.findByText("You’re now working as Grace Hopper in this checkout. Nothing was written to Git or Activity.")).toBeVisible();
    const reviewed = await preview.mock.results[0]!.value;
    expect(apply).toHaveBeenCalledWith(reviewed);
    const result = await apply.mock.results[0]!.value;
    expect(result.events).toEqual([]);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["actor", "current"]);
    expect(keys).toContainEqual(["home"]);
    expect(keys).toContainEqual(["inbox"]);
    expect(keys).toContainEqual(["relays"]);
    expect(keys).not.toContainEqual(["activity"]);
    expect(within(identity).queryByText("MEX recognizes you as Ada Lovelace.")).not.toBeInTheDocument();
  });

  it("loads an addressed Member directly outside page one and keeps status in the URL", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ memberFixture: "git-alias" });
    const originalMembers = api.getMembers.bind(api);
    const getMember = vi.spyOn(api, "getMember");
    vi.spyOn(api, "getMembers").mockImplementation(async (request) => {
      const response = await originalMembers(request);
      if (request.active !== true || request.cursor !== undefined) return response;
      return {
        ...response,
        items: response.items.filter((member) => member.id === ADA_ID),
        nextCursor: "page-two",
        truncated: true,
      };
    });
    renderRoute(api, `/members?status=active&member=${GRACE_ID}`);

    const detail = await screen.findByRole("region", { name: "Selected Member detail" });
    expect(await within(detail).findByRole("heading", { name: "Grace Hopper" })).toBeVisible();
    expect(getMember).toHaveBeenCalledWith(GRACE_ID);
    expect(routeLocation()).toBe(`/members?status=active&member=${GRACE_ID}`);

    await user.click(screen.getByRole("tab", { name: "Inactive" }));
    await waitFor(() => expect(routeLocation()).toContain("status=inactive"));
    expect(routeLocation()).not.toContain("member=");
    expect(screen.getByRole("tab", { name: "Inactive" })).toHaveAttribute("aria-selected", "true");
  });

  it("recovers from invalid, missing, and state-mismatched Member deep links", async () => {
    const user = userEvent.setup();

    const invalidApi = createFixtureApi({ memberFixture: "git-alias" });
    const invalidRead = vi.spyOn(invalidApi, "getMember");
    const invalidRender = renderRoute(invalidApi, "/members?status=active&member=not-a-member-id");
    expect(await screen.findByText("That Member link isn’t valid")).toBeVisible();
    expect(invalidRead).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Return to team list" }));
    await waitFor(() => expect(routeLocation()).toContain(`member=${ADA_ID}`));
    invalidRender.unmount();

    const missingApi = createFixtureApi({ memberFixture: "git-alias" });
    const missingRender = renderRoute(missingApi, `/members?status=active&member=${MISSING_ID}`);
    expect(await screen.findByText("This view could not be loaded")).toBeVisible();
    expect(screen.queryByText("Fixture member not found.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to team list" })).toBeEnabled();
    missingRender.unmount();

    const mismatchApi = createFixtureApi({ memberFixture: "git-alias" });
    renderRoute(mismatchApi, `/members?status=inactive&member=${ADA_ID}`);
    expect(await screen.findByText("Ada Lovelace is in active Members")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View active Members" }));
    await waitFor(() => expect(routeLocation()).toContain(`status=active&member=${ADA_ID}`));
  });

  it("refreshes external Member and identity changes explicitly without polling", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ memberFixture: "git-alias" });
    const originalMembers = api.getMembers.bind(api);
    let exposeGrace = false;
    const members = vi.spyOn(api, "getMembers").mockImplementation(async (request) => {
      const response = await originalMembers(request);
      return request.active === true && !exposeGrace
        ? { ...response, items: response.items.filter((item) => item.id !== GRACE_ID) }
        : response;
    });
    const current = vi.spyOn(api, "getCurrentActor");
    const detail = vi.spyOn(api, "getMember");
    const { queryClient } = renderRoute(api);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByRole("heading", { level: 1, name: "Members" });
    await waitFor(() => expect(routeLocation()).toContain(`member=${ADA_ID}`));
    const selectedDetail = await screen.findByRole("region", { name: "Selected Member detail" });
    expect(await within(selectedDetail).findByRole("heading", { name: "Ada Lovelace" })).toBeVisible();
    expect(screen.queryByText("Grace Hopper")).not.toBeInTheDocument();
    const callsBeforeIdle = members.mock.calls.length;
    const currentCallsBeforeRefresh = current.mock.calls.length;
    const detailCallsBeforeRefresh = detail.mock.calls.length;
    expect(currentCallsBeforeRefresh).toBeGreaterThan(0);
    expect(detailCallsBeforeRefresh).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(members).toHaveBeenCalledTimes(callsBeforeIdle);

    exposeGrace = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Members and identity refreshed.")).toBeVisible();
    expect(await screen.findByText("Grace Hopper")).toBeVisible();
    expect(members.mock.calls.length).toBeGreaterThan(callsBeforeIdle);
    expect(current.mock.calls.length).toBeGreaterThan(currentCallsBeforeRefresh);
    expect(detail.mock.calls.length).toBeGreaterThan(detailCallsBeforeRefresh);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["home"]);
    expect(keys).toContainEqual(["inbox"]);
    expect(keys).toContainEqual(["relays"]);
  });

  it("keeps readable identity and roster content when individual mutation capabilities are unavailable", async () => {
    const canonicalApi = createFixtureApi({ memberFixture: "partial" });
    const canonicalRender = renderRoute(canonicalApi);
    expect(await screen.findByText("You’re working as Ada Lovelace.")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add member" })).toBeDisabled();
    expect(screen.getAllByText(/Canonical Member writes are not connected in this Hub process\./).length).toBeGreaterThanOrEqual(1);
    expect(within(screen.getByRole("region", { name: "Selected Member detail" })).getByText("ada@example.test")).toBeVisible();
    canonicalRender.unmount();

    const localApi = createFixtureApi({ memberFixture: "git-alias" });
    const localCaps = await localApi.getCapabilities();
    vi.spyOn(localApi, "getCapabilities").mockResolvedValue(unavailableCapabilities(
      localCaps,
      "localSelection",
      "Local identity overrides are disabled for this checkout.",
    ));
    const localRender = renderRoute(localApi);
    expect(await screen.findByText("MEX recognizes you as Ada Lovelace.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose an existing member" })).toBeDisabled();
    expect(screen.getByText("Local identity overrides are disabled for this checkout.")).toBeVisible();
    localRender.unmount();
  });

  it("explains a read-capability failure instead of mounting a broken workbench", async () => {
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue(unavailableCapabilities(
      capabilities,
      "read",
      "Member reads are unavailable for this repository.",
    ));
    const members = vi.spyOn(api, "getMembers");
    renderRoute(api);

    expect(await screen.findByText("Members are unavailable")).toBeVisible();
    expect(screen.getByText("Member reads are unavailable for this repository.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(members).not.toHaveBeenCalled();
  });

  it("preserves trusted rows while surfacing bounded source diagnostics", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ memberFixture: "git-alias" });
    const original = api.getMembers.bind(api);
    vi.spyOn(api, "getMembers").mockImplementation(async (request): Promise<TeamMemberListResponse> => {
      const response = await original(request);
      if (request.active !== true) return response;
      return {
        ...response,
        sourceTruncated: true,
        diagnostics: [{
          code: "MEMBER_PARSE_SKIPPED",
          severity: "warning",
          message: "One malformed Member was skipped.",
          path: ".mex/team/members/broken.md",
        }],
        diagnosticsTruncated: true,
      };
    });
    renderRoute(api);

    expect(await screen.findByText("Ada Lovelace")).toBeVisible();
    const warning = screen.getByText("Some Member records need attention").closest<HTMLElement>("[role='alert']")!;
    expect(within(warning).getByText("One malformed Member was skipped.")).toBeVisible();
    expect(within(warning).getByText(/Only the trustworthy bounded portion is shown/i)).toBeVisible();
    await user.click(within(warning).getByRole("button", { name: "Member list diagnostic details" }));
    expect(within(warning).getByText("MEMBER_PARSE_SKIPPED")).toBeVisible();
    expect(within(warning).getByText(".mex/team/members/broken.md")).toBeVisible();
  });
});

describe("Members mutation safety and accessibility", () => {
  it("does not preview from reads, row selection, or technical disclosure", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ memberFixture: "git-alias" });
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute(api);

    await waitFor(() => expect(document.querySelector(`button[data-member-id="${ADA_ID}"]`)).toBeInTheDocument());
    await userEvent.setup().click(document.querySelector<HTMLButtonElement>(`button[data-member-id="${ADA_ID}"]`)!);
    await screen.findByRole("heading", { name: "Ada Lovelace" });
    await user.click(document.querySelector<HTMLButtonElement>(`button[data-member-id="${GRACE_ID}"]`)!);
    const detail = await screen.findByRole("region", { name: "Selected Member detail" });
    await waitFor(() => expect(within(detail).getByRole("heading", { name: "Grace Hopper" })).toBeVisible());
    await user.click(within(detail).getByRole("button", { name: "Technical details" }));
    expect(within(detail).getByText(GRACE_ID)).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("gates canonical controls until current identity resolves", async () => {
    let resolveActor!: (value: Awaited<ReturnType<HubApi["getCurrentActor"]>>) => void;
    const actorPromise = new Promise<Awaited<ReturnType<HubApi["getCurrentActor"]>>>((resolve) => {
      resolveActor = resolve;
    });
    const api = createFixtureApi();
    const baselineActor = await api.getCurrentActor();
    vi.spyOn(api, "getCurrentActor").mockReturnValue(actorPromise);
    renderRoute(api);

    expect(await screen.findByRole("button", { name: "Add member" })).toBeDisabled();
    await waitFor(() => expect(document.querySelector(`button[data-member-id="${ADA_ID}"]`)).toBeInTheDocument());
    await userEvent.setup().click(document.querySelector<HTMLButtonElement>(`button[data-member-id="${ADA_ID}"]`)!);
    await screen.findByRole("heading", { name: "Ada Lovelace" });
    expect(screen.getByRole("button", { name: "Edit member" })).toBeDisabled();
    resolveActor(baselineActor);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit member" })).toBeEnabled());
  });

  it("keeps canonical controls gated and explains a current-identity failure", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    vi.spyOn(api, "getCurrentActor").mockRejectedValue(new HubApiError({
      type: "about:blank",
      title: "Checkout identity unavailable",
      status: 503,
      code: "INTERNAL_ERROR",
      detail: "MEX could not inspect the current checkout identity.",
      requestId: "7a1ef6a4-777d-4c91-942d-2fc44ef0343e",
    }));
    const preview = vi.spyOn(api, "previewTeamOperation");
    renderRoute(api);

    expect(await screen.findByText("Checkout identity unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add member" })).toBeDisabled();
    await waitFor(() => expect(document.querySelector(`button[data-member-id="${ADA_ID}"]`)).toBeInTheDocument());
    await user.click(document.querySelector<HTMLButtonElement>(`button[data-member-id="${ADA_ID}"]`)!);
    await screen.findByRole("heading", { name: "Ada Lovelace" });
    expect(screen.getByRole("button", { name: "Edit member" })).toBeDisabled();
    expect(screen.getAllByText(/MEX could not resolve your checkout identity/i).length).toBeGreaterThanOrEqual(1);
    expect(preview).not.toHaveBeenCalled();
  });

  it("closes on Escape and restores focus to the operation trigger", async () => {
    const user = userEvent.setup();
    renderRoute();
    const trigger = await screen.findByRole("button", { name: "Add member" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Add team member" });
    expect(within(dialog).getByRole("textbox", { name: "Display name" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add team member" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("keeps a rejected exact apply visible and focused inside its confirmation", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    vi.spyOn(api, "applyTeamOperation").mockRejectedValue(new HubApiError({
      type: "about:blank",
      title: "Repository changed",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "Review the Member again against the current repository revision.",
      requestId: "8cf02241-46aa-45e0-b328-9cb2560a4510",
    }));
    renderRoute(api);

    const dialog = await openMemberDialog(user, "Add member", "Add team member");
    await user.type(within(dialog).getByRole("textbox", { name: "Display name" }), "Katherine Johnson");
    await user.type(within(dialog).getByRole("textbox", { name: "Git email" }), "kj@example.test");
    const confirmation = await reviewMember(user, dialog, "Add this member?");
    const applyButton = within(confirmation).getByRole("button", { name: "Add member" });
    await user.click(applyButton);

    const alert = await within(confirmation).findByRole("alert");
    expect(within(alert).getByText("Repository changed")).toBeVisible();
    expect(within(alert).getByText("Review the Member again against the current repository revision.")).toBeVisible();
    expect(confirmation).toBeVisible();
    expect(applyButton).toHaveFocus();
  });

  it("fails closed for an invalid preview and keeps its exact diagnostics collapsed", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const originalPreview = api.previewTeamOperation.bind(api);
    vi.spyOn(api, "previewTeamOperation").mockImplementation(async (request) => {
      const envelope = await originalPreview(request);
      return {
        ...envelope,
        preview: {
          ...envelope.preview,
          valid: false,
          diagnostics: [{
            code: "REVISION_CONFLICT",
            severity: "error",
            message: "The Member changed after this review began.",
            path: ".mex/team/members/member.md",
          }],
        },
      } satisfies TeamOperationPreviewResponse;
    });
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute(api);

    const dialog = await openMemberDialog(user, "Add member", "Add team member");
    await user.type(within(dialog).getByRole("textbox", { name: "Display name" }), "Katherine Johnson");
    await user.type(within(dialog).getByRole("textbox", { name: "Git email" }), "kj@example.test");
    await user.click(within(dialog).getByRole("button", { name: "Review member" }));

    expect(await within(dialog).findByText("This member cannot be saved yet")).toBeVisible();
    expect(screen.queryByRole("alertdialog", { name: "Add this member?" })).not.toBeInTheDocument();
    const technical = within(dialog).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText("REVISION_CONFLICT")).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type {
  InboxDraftDetail,
  InboxOperationPreviewRequest,
  InboxOperationPreviewResponse,
  InboxProposalSummary,
} from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { groupInboxProposals, inboxActorMatches } from "../pages/InboxPage";
import { AppRoutes } from "./App";

const DRAFT_ID = "inbox_00000000000000000000000000000001";
const PROPOSAL_ID = "proposal_01000000000000000000001720";
const OWN_PROPOSAL_ID = "proposal_01000000000000000000001721";
const TOPIC_ID = "mx_02000000000000000000000001";
const RELATION_ID = "mx_03000000000000000000000001";

function renderRoute(api: HubApi = createFixtureApi(), initialEntry = "/inbox") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={[initialEntry]}>
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

async function openDrafts(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: "Drafts on this device" }));
}

async function selectMoreAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp,
) {
  await user.click(screen.getByRole("button", { name: "More proposal actions" }));
  const item = await screen.findByRole("menuitem", { name });
  await user.click(item);
}

async function selectDraftMoreAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp,
) {
  await user.click(screen.getByRole("button", { name: "More draft actions" }));
  const item = await screen.findByRole("menuitem", { name });
  await user.click(item);
}

async function openExactTechnicalDetails(
  user: ReturnType<typeof userEvent.setup>,
  scope: HTMLElement,
) {
  const trigger = await within(scope).findByRole("button", { name: "Exact technical details" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  return within(scope).findByRole("heading", { name: "Exact preview" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Inbox Spec-authoring workbench", () => {
  it("opens For review by default, keeps drafts secondary, and has no page-level creation CTA", async () => {
    const api = createFixtureApi();
    const draftList = vi.spyOn(api, "getInboxDrafts");
    renderRoute(api);

    const reviewTab = await screen.findByRole("tab", { name: "For review 3" });
    expect(reviewTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Drafts on this device" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /New local draft/i })).not.toBeInTheDocument();
    expect(draftList).not.toHaveBeenCalled();
  });

  it("loads a schema-valid URL proposal directly without previewing it", async () => {
    const api = createFixtureApi();
    const detail = vi.spyOn(api, "getInboxProposal");
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api, `/inbox?view=review&proposal=${OWN_PROPOSAL_ID}`);

    expect(await screen.findByRole("heading", { level: 2, name: "Keep approval consequences explicit" })).toBeVisible();
    expect(detail).toHaveBeenCalledWith(OWN_PROPOSAL_ID);
    expect(preview).not.toHaveBeenCalled();
  });

  it("rejects an invalid URL selection before the client read and recovers to the queue", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const detail = vi.spyOn(api, "getInboxProposal");
    renderRoute(api, "/inbox?view=review&proposal=not-a-proposal");

    expect(await screen.findByRole("heading", { name: "This proposal link is invalid" })).toBeVisible();
    expect(detail).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Return to queue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" })).toBeVisible();
  });

  it("loads a valid draft URL lazily", async () => {
    const validApi = createFixtureApi();
    const validDetail = vi.spyOn(validApi, "getInboxDraft");
    renderRoute(validApi, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    expect(await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" })).toBeVisible();
    expect(validDetail).toHaveBeenCalledOnce();
    expect(validDetail).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("rejects a malformed draft URL before a detail read and recovers to the draft list", async () => {
    const user = userEvent.setup();
    const invalidApi = createFixtureApi();
    const invalidDetail = vi.spyOn(invalidApi, "getInboxDraft");
    renderRoute(invalidApi, "/inbox?view=drafts&draft=not%2Fa%2Fdraft");
    expect(await screen.findByRole("heading", { name: "This draft link is invalid" })).toBeVisible();
    expect(invalidDetail).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Return to drafts" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" })).toBeVisible();
    expect(invalidDetail).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("loads at most 25 body-free summaries and fetches detail only after selection", async () => {
    const api = createFixtureApi();
    const drafts = vi.spyOn(api, "getInboxDrafts");
    const proposals = vi.spyOn(api, "getInboxProposals");
    const draftDetail = vi.spyOn(api, "getInboxDraft");
    renderRoute(api);

    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    const proposalRow = (await screen.findByText("Clarify release evidence review")).closest("button");
    expect(proposalRow).toHaveAttribute("data-inbox-proposal-id", PROPOSAL_ID);
    await waitFor(() => expect(proposalRow).toHaveAttribute("aria-current", "true"));
    expect(proposalRow).toHaveAttribute("data-selected", "true");
    expect(drafts).not.toHaveBeenCalled();
    expect(proposals).toHaveBeenCalledWith({ states: ["pending", "stale"], limit: 25 });
    expect(draftDetail).not.toHaveBeenCalled();
    expect(screen.queryByText(/Inbox must help a reviewer understand/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await openDrafts(user);
    const draftRow = (await screen.findByText("Keep Inbox review focused on meaningful changes")).closest("button");
    expect(draftRow).toHaveAttribute("data-inbox-draft-id", DRAFT_ID);
    expect(drafts).toHaveBeenCalledWith({ limit: 25 });
    await user.click(draftRow!);
    expect(await screen.findByText(/Inbox must help a reviewer understand/)).toBeVisible();
    expect(draftDetail).toHaveBeenCalledWith(DRAFT_ID);
    expect(draftRow).toHaveAttribute("aria-current", "true");
  });

  it("groups member, exact Git, and unknown actors without guessing authorship", async () => {
    const api = createFixtureApi();
    const rows = (await api.getInboxProposals({ states: ["pending", "stale"], limit: 25 })).items;

    const memberGroups = groupInboxProposals(rows, {
      kind: "member",
      memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX",
      displayName: "Ada Lovelace",
    });
    expect(memberGroups.map((group) => [group.title, group.rows.map((row) => row.ref.id)])).toEqual([
      ["Needs your review", [PROPOSAL_ID]],
      ["Waiting for teammate", [OWN_PROPOSAL_ID]],
      ["Needs refresh", ["proposal_01000000000000000000001722"]],
    ]);

    const gitRows: InboxProposalSummary[] = rows.map((row, index) => ({
      ...row,
      author: index === 1
        ? { kind: "git", name: "Ada", email: "ada@example.test" }
        : { kind: "git", name: "Grace", email: "grace@example.test" },
    }));
    const gitGroups = groupInboxProposals(gitRows, {
      kind: "git",
      name: "Ada",
      email: "ada@example.test",
    });
    expect(gitGroups.map((group) => [group.title, group.rows.map((row) => row.ref.id)])).toEqual([
      ["Needs your review", [PROPOSAL_ID]],
      ["Waiting for teammate", [OWN_PROPOSAL_ID]],
      ["Needs refresh", ["proposal_01000000000000000000001722"]],
    ]);
    expect(inboxActorMatches(
      { kind: "git", name: "Ada", email: "ada@example.test" },
      { kind: "git", name: "Ada", email: "other@example.test" },
    )).toBe(false);

    for (const current of [{ kind: "unknown" as const }, undefined]) {
      const neutralGroups = groupInboxProposals(rows, current);
      expect(neutralGroups.map((group) => [group.title, group.rows.map((row) => row.ref.id)])).toEqual([
        ["Needs review", [PROPOSAL_ID, OWN_PROPOSAL_ID]],
        ["Needs refresh", ["proposal_01000000000000000000001722"]],
      ]);
    }
  });

  it("drops cached authorship grouping when a current-actor refresh fails", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const initialIdentity = await api.getCurrentActor();
    const actor = vi.spyOn(api, "getCurrentActor")
      .mockResolvedValueOnce(initialIdentity)
      .mockRejectedValueOnce(new Error("Current identity is unavailable."));
    renderRoute(api, `/inbox?view=review&proposal=${PROPOSAL_ID}`);

    expect(await screen.findByRole("heading", { name: "Needs your review" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Waiting for teammate" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("heading", { name: "Needs review" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Needs your review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Waiting for teammate" })).not.toBeInTheDocument();
    expect(await screen.findByText("Team identity is not set")).toBeVisible();
    expect(actor).toHaveBeenCalledTimes(2);
  });

  it("presents a create as readable Spec content with technical metadata collapsed", async () => {
    const user = userEvent.setup();
    renderRoute(createFixtureApi(), `/inbox?view=review&proposal=${OWN_PROPOSAL_ID}`);

    const detail = await screen.findByRole("region", { name: "Selected Inbox review detail" });
    expect(await within(detail).findByText("Knowledge change")).toBeVisible();
    expect(within(detail).getByText("New constraint")).toBeVisible();
    expect(within(detail).getByText("Published by Ada Lovelace")).toBeVisible();
    expect(within(detail).getByRole("heading", { name: "What will change" })).toBeVisible();
    expect(within(detail).getByText("Every approval confirmation must explain the durable Spec change, proposal transition, and Activity record before apply.")).toBeVisible();
    expect(within(detail).getByRole("heading", { name: "Why this change" })).toBeVisible();
    expect(within(detail).getByText("Reviewers should know which working-tree artifacts an approval writes.")).toBeVisible();

    const technical = within(detail).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");
    expect(within(detail).queryByText(OWN_PROPOSAL_ID)).not.toBeInTheDocument();
    expect(within(detail).queryByText(`.mex/inbox/${OWN_PROPOSAL_ID}.md`)).not.toBeInTheDocument();

    await user.click(technical);
    expect(technical).toHaveAttribute("aria-expanded", "true");
    expect(within(detail).getByText(OWN_PROPOSAL_ID)).toBeVisible();
    expect(within(detail).getByText(`.mex/inbox/${OWN_PROPOSAL_ID}.md`)).toBeVisible();
  });

  it("fetches only the selected update target and renders semantic Current and Proposed comparisons", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const getWikiEntity = vi.spyOn(api, "getWikiEntity");
    renderRoute(api, `/inbox?view=review&proposal=${OWN_PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep approval consequences explicit" });
    expect(getWikiEntity).not.toHaveBeenCalled();

    await user.click((await screen.findByText("Clarify release evidence review")).closest("button")!);
    const detail = await screen.findByRole("region", { name: "Selected Inbox review detail" });
    expect(await within(detail).findByText("Human-team memory release", { selector: "strong" })).toBeVisible();
    await waitFor(() => expect(getWikiEntity).toHaveBeenCalledTimes(1));
    expect(getWikiEntity).toHaveBeenCalledWith("mx_01000000000000000000000001");

    const summary = within(detail).getByRole("region", { name: "Summary comparison" });
    expect(within(summary).getByText("Current")).toBeVisible();
    expect(within(summary).getByText("The reviewed Spec for Git-authoritative team memory and the Hub surfaces that explain it.")).toBeVisible();
    expect(within(summary).getByText("Proposed")).toBeVisible();
    expect(within(summary).getByText("Require exact evidence review before release approval.")).toBeVisible();

    const body = within(detail).getByRole("region", { name: "Body comparison" });
    expect(within(body).getByText(/The release gate records bounded evidence before a durable team-memory change/)).toBeVisible();
    expect(within(body).getByText(/Private proposal prose remains outside durable Specs until approval/)).toBeVisible();
  });

  it("waits for the selected draft detail before fetching its update target", async () => {
    const api = createFixtureApi();
    const base = await api.getInboxDraft(DRAFT_ID);
    const update: InboxDraftDetail = {
      ...base,
      changeKind: "spec.update",
      entityKind: "spec",
      title: "Refine the release summary",
      input: {
        change: {
          kind: "spec.update",
          target: {
            id: "mx_01000000000000000000000001",
            kind: "spec",
            title: "Human-team memory release",
          },
          patch: { summary: "Keep the draft review boundary explicit." },
        },
        rationale: "Review the selected Wiki target only after opening this local draft.",
        evidence: [],
        targetRevisions: [{
          target: { kind: "entity", id: "mx_01000000000000000000000001" },
          revision: "3".repeat(64),
          semanticRevision: 4,
        }],
      },
    };
    const delayed = deferred<InboxDraftDetail>();
    vi.spyOn(api, "getInboxDraft").mockReturnValue(delayed.promise);
    const getWikiEntity = vi.spyOn(api, "getWikiEntity");
    renderRoute(api, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    expect(await screen.findByRole("heading", { name: "Opening private draft" })).toBeVisible();
    expect(getWikiEntity).not.toHaveBeenCalled();
    await act(async () => {
      delayed.resolve(update);
      await delayed.promise;
    });

    expect(await screen.findByRole("heading", { level: 2, name: "Refine the release summary" })).toBeVisible();
    await waitFor(() => expect(getWikiEntity).toHaveBeenCalledOnce());
    expect(getWikiEntity).toHaveBeenCalledWith("mx_01000000000000000000000001");
    const comparison = screen.getByRole("region", { name: "Summary comparison" });
    expect(within(comparison).getByText("The reviewed Spec for Git-authoritative team memory and the Hub surfaces that explain it.")).toBeVisible();
    expect(within(comparison).getByText("Keep the draft review boundary explicit.")).toBeVisible();
  });

  it("keeps proposed update content readable when the current Wiki entity cannot be read", async () => {
    const api = createFixtureApi();
    vi.spyOn(api, "getWikiEntity").mockRejectedValue(new Error("/private/wiki/index.sqlite"));
    renderRoute(api, `/inbox?view=review&proposal=${PROPOSAL_ID}`);

    const detail = await screen.findByRole("region", { name: "Selected Inbox review detail" });
    expect(await within(detail).findByText("Current knowledge content could not be read")).toBeVisible();
    expect(within(detail).getByText(/Proposed values remain available below/)).toBeVisible();
    expect(within(detail).getByText("Require exact evidence review before release approval.")).toBeVisible();
    expect(within(detail).getByText(/Private proposal prose remains outside durable Specs until approval/)).toBeVisible();
    expect(detail).not.toHaveTextContent("/private/wiki/index.sqlite");
  });

  it("renders safe actionable evidence links and natural relationship copy for a local draft", async () => {
    const user = userEvent.setup();
    renderRoute(createFixtureApi(), `/inbox?view=drafts&draft=${DRAFT_ID}`);

    const detail = await screen.findByRole("region", { name: "Selected Inbox draft detail" });
    const evidenceHeading = await within(detail).findByRole("heading", { name: "Evidence" });
    const evidence = evidenceHeading.closest("section");
    if (evidence === null) throw new Error("Expected the semantic evidence section.");
    expect(within(evidence).getByRole("link", { name: "Human-team memory release" })).toHaveAttribute(
      "href",
      "/knowledge/mx_01000000000000000000000001",
    );
    expect(within(evidence).getByRole("link", { name: "Open referenced code symbol" })).toHaveAttribute(
      "href",
      "/code/symbols/sym.createHubServer",
    );
    expect(evidence).not.toHaveTextContent("sym.createHubServer");
    const external = within(evidence).getByRole("link", { name: /Accessible dialog guidance/ });
    expect(external).toHaveAttribute("href", "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");

    const related = within(detail).getByRole("heading", { name: "Related knowledge" }).closest("section");
    if (related === null) throw new Error("Expected the related knowledge section.");
    expect(within(related).getByText("Topic")).toBeVisible();
    expect(within(related).getByText("Derived from")).toBeVisible();
    for (const link of within(related).getAllByRole("link", { name: "Human-team memory release" })) {
      expect(link).toHaveAttribute("href", "/knowledge/mx_01000000000000000000000001");
    }
    expect(related).not.toHaveTextContent("mx_01000000000000000000000001");

    const technical = within(detail).getByRole("button", { name: "Technical details" });
    await user.click(technical);
    expect(within(detail).getByText("sym.createHubServer")).toBeVisible();
  });

  it("phrases a verified_by create relation in its stored direction", async () => {
    const api = createFixtureApi();
    const draft = await api.getInboxDraft(DRAFT_ID);
    if (
      draft.input.change.kind !== "spec.create"
      || draft.input.change.relation === undefined
      || draft.input.change.relation.target.kind !== "spec"
    ) {
      throw new Error("Expected a related create draft fixture.");
    }
    vi.spyOn(api, "getInboxDraft").mockResolvedValue({
      ...draft,
      input: {
        ...draft.input,
        change: {
          ...draft.input.change,
          entityKind: "acceptance_criterion",
          relation: { type: "verified_by", target: draft.input.change.relation.target },
        },
      },
    });
    renderRoute(api, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    await screen.findByRole("heading", { level: 2, name: draft.title });
    const detail = await screen.findByRole("region", { name: "Selected Inbox draft detail" });
    const related = within(detail).getByRole("heading", { name: "Related knowledge" }).closest("section");
    if (related === null) throw new Error("Expected the related knowledge section.");
    expect(within(related).getByText("Verifies")).toBeVisible();
    expect(within(related).queryByText("Verified by")).not.toBeInTheDocument();
  });

  it("uses a publish-first draft action hierarchy with keyboard-safe discard overflow and collapsed Advanced fields", async () => {
    const user = userEvent.setup();
    renderRoute(createFixtureApi(), `/inbox?view=drafts&draft=${DRAFT_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" });
    expect(screen.getByRole("button", { name: "Publish for review" })).toBeVisible();
    const edit = screen.getByRole("button", { name: "Edit wording" });
    expect(edit).toBeVisible();
    expect(screen.queryByRole("button", { name: /Delete local draft/i })).not.toBeInTheDocument();

    const more = screen.getByRole("button", { name: "More draft actions" });
    more.focus();
    await user.keyboard("{Enter}");
    const discard = await screen.findByRole("menuitem", { name: "Discard draft…" });
    expect(discard).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Discard draft…" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "More draft actions" })).toHaveFocus();

    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "Edit local Spec draft" });
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveFocus());
    const advanced = within(dialog).getByRole("button", { name: "Advanced" });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByRole("textbox", { name: /Topic endpoint attestations/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(TOPIC_ID)).not.toBeInTheDocument();
    await user.click(advanced);
    expect(within(dialog).getByRole("textbox", { name: /Topic endpoint attestations/ })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit local Spec draft" })).not.toBeInTheDocument());
    expect(edit).toHaveFocus();
  });

  it("renders every exact approval diff, including the Wiki ledger and immutable Activity", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api);
    await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" });
    await user.click(screen.getByRole("button", { name: "Approve change" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Approve this knowledge change?" });
    expect(within(confirmation).getByText("Clarify release evidence review")).toBeVisible();
    expect(within(confirmation).getByText("Knowledge entity affected")).toBeVisible();
    expect(within(confirmation).getByText("Human-team memory release")).toBeVisible();
    expect(within(confirmation).getByText("Approving as Ada Lovelace")).toBeVisible();
    expect(within(confirmation).getByText("Write the reviewed knowledge change")).toBeVisible();
    expect(within(confirmation).queryByText(".mex/specs/mx_01000000000000000000000001.md")).not.toBeInTheDocument();

    expect(await openExactTechnicalDetails(user, confirmation)).toBeVisible();
    expect(within(confirmation).getByText(".mex/specs/mx_01000000000000000000000001.md")).toBeVisible();
    expect(within(confirmation).getByText(".mex/events/operations.jsonl")).toBeVisible();
    expect(within(confirmation).getByText(`.mex/inbox/${PROPOSAL_ID}.md`)).toBeVisible();
    expect(within(confirmation).getByText(/^\.mex\/events\/activity\/2026-08\/event_/u)).toBeVisible();
    expect(within(confirmation).getByText("codex/hub-ux", { exact: true })).toBeVisible();
    expect(within(confirmation).getByText("aeaf0ab0022ac5d704404585d981b4da5f2c1cbf", { exact: true })).toBeVisible();
    expect(within(confirmation).getByText("Dirty · local changes", { exact: true })).toBeVisible();
    expect(within(confirmation).getAllByText("23 Aug, 08:45 UTC", { exact: true })).toHaveLength(2);
    expect(preview.mock.calls[0]![0].action).toEqual({
      kind: "inbox.approve",
      proposalId: PROPOSAL_ID,
    });
  });

  it("keeps teammate approval primary and exposes terminal decline through a keyboard-safe overflow menu", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api, `/inbox?view=review&proposal=${PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" });
    expect(screen.getByRole("button", { name: "Approve change" })).toBeVisible();
    const more = screen.getByRole("button", { name: "More proposal actions" });
    more.focus();
    await user.keyboard("{Enter}");
    const decline = await screen.findByRole("menuitem", { name: "Decline proposal…" });
    expect(decline).toHaveFocus();
    expect(screen.queryByRole("menuitem", { name: "Withdraw proposal…" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Decline proposal…" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "More proposal actions" })).toHaveFocus();
    await selectMoreAction(user, "Decline proposal…");
    expect(await screen.findByRole("dialog", { name: "Decline proposal" })).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
  });

  it("reserves withdrawal and self-approval for the exact current author", async () => {
    const user = userEvent.setup();
    renderRoute(createFixtureApi(), `/inbox?view=review&proposal=${OWN_PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep approval consequences explicit" });
    expect(screen.getByText("Waiting for teammate review")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve change" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More proposal actions" }));
    expect(await screen.findByRole("menuitem", { name: "Approve without teammate review…" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Withdraw proposal…" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Decline proposal…" })).not.toBeInTheDocument();
  });

  it("warns before self-approval, applies the exact returned envelope, and focuses a truthful Git notice", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    let exactEnvelope: InboxOperationPreviewResponse | undefined;
    const preview = vi.spyOn(api, "previewInboxOperation").mockImplementation(async (request) => {
      exactEnvelope = await realPreview(request);
      return exactEnvelope;
    });
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api, `/inbox?view=review&proposal=${OWN_PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep approval consequences explicit" });
    await selectMoreAction(user, "Approve without teammate review…");
    const warning = await screen.findByRole("alertdialog", { name: "Teammate review is recommended" });
    expect(within(warning).getByText(/Independent review is the safer default/)).toBeVisible();
    expect(preview).not.toHaveBeenCalled();

    await user.click(within(warning).getByRole("button", { name: "Continue without teammate review" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Approve this knowledge change?" });
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]![0].action).toEqual({
      kind: "inbox.approve",
      proposalId: OWN_PROPOSAL_ID,
    });
    expect(within(confirmation).getByText("Approving as Ada Lovelace")).toBeVisible();
    await user.click(within(confirmation).getByRole("button", { name: "Approve change" }));

    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(exactEnvelope).toBeDefined();
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);
    const noticeTitle = await screen.findByText("Working tree updated");
    const gitNotice = noticeTitle.closest<HTMLElement>("[role='alert']");
    if (gitNotice === null) throw new Error("Expected the focused Git truth alert.");
    expect(within(gitNotice).getByText(
      "Knowledge change and review record were written to your working tree. Commit and push them to share the result with your team.",
    )).toBeVisible();
    await waitFor(() => expect(gitNotice).toHaveFocus());
    await user.click(within(gitNotice).getByRole("button", { name: "Dismiss Git notice" }));
    await waitFor(() => expect(screen.queryByText("Working tree updated")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("does not let a non-author approve or repair a stale proposal", async () => {
    renderRoute(createFixtureApi(), "/inbox?view=review&proposal=proposal_01000000000000000000001722");

    await screen.findByRole("heading", { level: 2, name: "Refresh the stale review boundary" });
    expect(screen.getAllByText("Needs refresh").length).toBeGreaterThan(0);
    expect(screen.getByText("The referenced knowledge content changed after this proposal was published.")).toBeVisible();
    expect(screen.getByText("Its author or their agent should refresh this proposal against current knowledge content.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve change" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More proposal actions" })).not.toBeInTheDocument();
    expect(screen.queryByText("Repair manually…")).not.toBeInTheDocument();
  });

  it("never applies an invalid approval preview and permits an explicit retry", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const proposal = await api.getInboxProposal(PROPOSAL_ID);
    const valid = await api.previewInboxOperation({
      operationId: "ui_invalid_approval_fixture",
      action: { kind: "inbox.approve", proposalId: PROPOSAL_ID },
      expectedRevisions: [{
        target: { kind: "artifact", path: proposal.sourcePath },
        revision: proposal.revision,
      }],
    });
    const invalid: InboxOperationPreviewResponse = {
      ...valid,
      preview: {
        ...valid.preview,
        valid: false,
        diagnostics: [{
          code: "INBOX_TARGET_REVISION_CHANGED",
          severity: "error",
          message: "The exact Spec dependency changed after publication.",
        }],
      },
    };
    const preview = vi.spyOn(api, "previewInboxOperation").mockResolvedValue(invalid);
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api, `/inbox?view=review&proposal=${PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" });
    await user.click(screen.getByRole("button", { name: "Approve change" }));
    const invalidDialog = await screen.findByRole("dialog", { name: "This change is not ready to approve" });
    expect(within(invalidDialog).getByText("Approval preview is invalid")).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
    expect(within(invalidDialog).queryByText("The exact Spec dependency changed after publication.")).not.toBeInTheDocument();
    await openExactTechnicalDetails(user, invalidDialog);
    expect(within(invalidDialog).getByText("The exact Spec dependency changed after publication.")).toBeVisible();

    await user.click(within(invalidDialog).getByRole("button", { name: "Try preview again" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "This change is not ready to approve" })).toBeVisible();
  });

  it("keeps proposal mutations usable when Spec approval is independently unavailable", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      ...capabilities,
      inbox: {
        ...capabilities.inbox,
        specApproval: { availability: "unavailable", reason: "Spec approval is offline for maintenance." },
      },
    });
    renderRoute(api, `/inbox?view=review&proposal=${PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" });
    expect(screen.getByRole("button", { name: "Approve change" })).toBeDisabled();
    expect(screen.getByText("Approval is unavailable: Spec approval is offline for maintenance.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "More proposal actions" }));
    expect(await screen.findByRole("menuitem", { name: "Decline proposal…" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /Mark as needs refresh…/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Decline proposal…" }));
    expect(await screen.findByRole("dialog", { name: "Decline proposal" })).toBeVisible();
  });

  it("authors a fresh stale repair without exposing withdrawal or writing a Spec", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const pending = await api.getInboxProposal(PROPOSAL_ID);
    const stalePreview = await api.previewInboxOperation({
      operationId: "ui_prepare_stale_proposal",
      action: {
        kind: "inbox.mark-stale",
        proposalId: pending.ref.id,
        rationale: "The exact target attestation changed.",
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: pending.sourcePath },
        revision: pending.revision,
      }],
    });
    await api.applyInboxOperation(stalePreview);
    const currentIdentity = await api.getCurrentActor();
    vi.spyOn(api, "getCurrentActor").mockResolvedValue({
      ...currentIdentity,
      actor: pending.author,
    });
    const preview = vi.spyOn(api, "previewInboxOperation");
    const applyGate = deferred<void>();
    const realApply = api.applyInboxOperation.bind(api);
    const apply = vi.spyOn(api, "applyInboxOperation").mockImplementation(async (envelope) => {
      await applyGate.promise;
      return realApply(envelope);
    });
    renderRoute(api, `/inbox?view=review&proposal=${PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: pending.title });
    expect(screen.queryByRole("button", { name: "Withdraw proposal" })).not.toBeInTheDocument();
    await selectMoreAction(user, "Repair manually…");
    const repairDialog = await screen.findByRole("dialog", { name: "Repair proposal manually" });
    const advanced = within(repairDialog).getByRole("button", { name: "Advanced" });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    await user.click(advanced);
    const exactRevision = within(repairDialog).getByRole("textbox", { name: "Exact file revision" });
    const semanticRevision = within(repairDialog).getByRole("spinbutton", { name: "Semantic revision" });
    const rationale = within(repairDialog).getByRole("textbox", { name: "Rationale" });
    const evidence = within(repairDialog).getByRole("textbox", { name: /Additional manual evidence/ });
    fireEvent.change(exactRevision, { target: { value: "a".repeat(64) } });
    fireEvent.change(semanticRevision, { target: { value: "5" } });
    fireEvent.change(rationale, { target: { value: "Fresh target revision reviewed.\n\tRepair is exact." } });
    fireEvent.change(evidence, { target: { value: "Fresh repair evidence.\n\tObserved locally." } });

    await user.click(within(repairDialog).getByRole("button", { name: "Review repaired proposal" }));
    await openExactTechnicalDetails(user, repairDialog);
    fireEvent.change(exactRevision, { target: { value: "b".repeat(64) } });
    expect(within(repairDialog).queryByRole("heading", { name: "Exact preview" })).not.toBeInTheDocument();
    await user.click(within(repairDialog).getByRole("button", { name: "Review repaired proposal" }));
    await openExactTechnicalDetails(user, repairDialog);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[0]![0].operationId).not.toBe(preview.mock.calls[1]![0].operationId);
    const repairRequest = preview.mock.calls[1]![0];
    if (repairRequest.action.kind !== "inbox.repair") throw new Error("Expected repair request.");
    expect(repairRequest.action.replacement).toMatchObject({
      rationale: "Fresh target revision reviewed.\n\tRepair is exact.",
      evidence: expect.arrayContaining([{
        kind: "manual",
        note: "Fresh repair evidence.\n\tObserved locally.",
      }]),
      targetRevisions: [{
        target: { kind: "entity", id: "mx_01000000000000000000000001" },
        revision: "b".repeat(64),
        semanticRevision: 5,
      }],
    });

    await user.click(within(repairDialog).getByRole("button", { name: "Review repaired proposal" }));
    const repairConfirmation = await screen.findByRole("alertdialog", { name: "Return this proposal to review?" });
    await user.click(within(repairConfirmation).getByRole("button", { name: "Repair and return to review" }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    await user.keyboard("{Escape}");
    expect(repairConfirmation).toBeVisible();
    expect(within(repairConfirmation).getByRole("button", { name: "Saving…" })).toBeDisabled();
    applyGate.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Repair proposal manually" })).not.toBeInTheDocument());
    expect(apply.mock.calls[0]![0].request.action.kind).toBe("inbox.repair");
  });

  it("accepts canonical multiline tabs, rejects NFD and lone surrogates, and applies the exact local-save envelope", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    let exactEnvelope: InboxOperationPreviewResponse | undefined;
    const preview = vi.spyOn(api, "previewInboxOperation").mockImplementation(async (request) => {
      exactEnvelope = await realPreview(request);
      return exactEnvelope;
    });
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api);

    await openDrafts(user);
    const trigger = await screen.findByRole("button", { name: "Create manually" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Create local knowledge draft" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Change type" })).toHaveFocus());
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    const body = within(dialog).getByRole("textbox", { name: "Knowledge body" });
    const rationale = within(dialog).getByRole("textbox", { name: "Rationale" });
    fireEvent.change(title, { target: { value: "Canonical multiline requirement" } });
    fireEvent.change(body, { target: { value: "First line\n\tTabbed second line" } });
    fireEvent.change(rationale, { target: { value: "Review line one\nReview line two" } });
    const saveButton = within(dialog).getByRole("button", { name: "Save draft" });
    expect(saveButton).toBeEnabled();

    fireEvent.change(title, { target: { value: "Cafe\u0301" } });
    expect(saveButton).toBeDisabled();
    fireEvent.change(title, { target: { value: "Café" } });
    expect(saveButton).toBeEnabled();
    fireEvent.change(body, { target: { value: "Broken \ud800 body" } });
    expect(saveButton).toBeDisabled();
    fireEvent.change(body, { target: { value: "First line\n\tTabbed second line" } });
    fireEvent.change(title, { target: { value: "Café requirement" } });

    await user.click(saveButton);
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(preview.mock.calls[0]![0]).toMatchObject({
      action: {
        kind: "inbox.draft.save",
        draft: {
          change: { body: "First line\n\tTabbed second line" },
          rationale: "Review line one\nReview line two",
        },
      },
    });
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(exactEnvelope).toBeDefined();
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);
    const success = await screen.findByText("Draft state updated on this device.");
    await waitFor(() => expect(success).toHaveFocus());
  });

  it("keeps an invalid local-save preview failure-closed with exact diagnostics collapsed", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    vi.spyOn(api, "previewInboxOperation").mockImplementation(async (request) => {
      const valid = await realPreview(request);
      return {
        ...valid,
        preview: {
          ...valid.preview,
          valid: false,
          diagnostics: [{
            code: "INBOX_DRAFT_REVISION_CHANGED",
            severity: "error",
            message: "The local draft revision changed before save.",
          }],
        },
      };
    });
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" });
    await user.click(screen.getByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit local Spec draft" });
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));

    expect(await within(dialog).findByText("This operation is not ready to apply")).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
    expect(within(dialog).queryByText("The local draft revision changed before save.")).not.toBeInTheDocument();
    await openExactTechnicalDetails(user, dialog);
    expect(within(dialog).getByText("The local draft revision changed before save.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("does not apply or leak paths when local-save previewing fails", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    vi.spyOn(api, "previewInboxOperation").mockRejectedValue(new Error("/private/checkout/drafts must not leak"));
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" });
    await user.click(screen.getByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit local Spec draft" });
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));

    expect(await within(dialog).findByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(dialog).not.toHaveTextContent("/private/checkout");
    expect(apply).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("closes the draft dialog on Escape and restores its live trigger", async () => {
    const user = userEvent.setup();
    renderRoute();
    await openDrafts(user);
    const trigger = await screen.findByRole("button", { name: "Create manually" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Create local knowledge draft" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create local knowledge draft" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("never applies an in-flight local save after edited wording makes its preview stale", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    const delayed = deferred<InboxOperationPreviewResponse>();
    let staleRequest: InboxOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewInboxOperation").mockImplementationOnce((request) => {
      staleRequest = request;
      return delayed.promise;
    });
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api);

    await openDrafts(user);
    await user.click(await screen.findByRole("button", { name: "Create manually" }));
    const dialog = await screen.findByRole("dialog", { name: "Create local knowledge draft" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Original reviewed title" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Knowledge body" }), { target: { value: "Original body." } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Rationale" }), { target: { value: "Original rationale." } });
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(staleRequest).toBeDefined());

    fireEvent.change(title, { target: { value: "Edited visible title" } });
    const staleEnvelope = await realPreview(staleRequest!);
    await act(async () => {
      delayed.resolve(staleEnvelope);
      await delayed.promise;
    });

    expect(within(dialog).queryByRole("button", { name: "Exact technical details" })).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    expect(await within(dialog).findByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("never restores an in-flight review preview after rationale changes", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    const delayed = deferred<InboxOperationPreviewResponse>();
    let staleRequest: InboxOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewInboxOperation").mockImplementationOnce((request) => {
      staleRequest = request;
      return delayed.promise;
    });
    renderRoute(api);

    await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" });
    await selectMoreAction(user, "Decline proposal…");
    const dialog = await screen.findByRole("dialog", { name: "Decline proposal" });
    const rationale = within(dialog).getByRole("textbox", { name: "Review rationale" });
    fireEvent.change(rationale, { target: { value: "Original rejection rationale." } });
    await user.click(within(dialog).getByRole("button", { name: "Review decline" }));
    await waitFor(() => expect(staleRequest).toBeDefined());

    fireEvent.change(rationale, { target: { value: "Edited rejection rationale." } });
    const staleEnvelope = await realPreview(staleRequest!);
    await act(async () => {
      delayed.resolve(staleEnvelope);
      await delayed.promise;
    });

    expect(within(dialog).queryByRole("button", { name: "Exact technical details" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Review decline" })).toBeEnabled();
  });

  it.each([
    ["title-only", { title: "Title-only replacement" }],
    ["clear-summary", { summary: "" }],
  ])("preserves exact %s update patch presence", async (_label, patch) => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const base = await api.getInboxDraft(DRAFT_ID);
    const update: InboxDraftDetail = {
      ...base,
      changeKind: "spec.update",
      entityKind: "spec",
      title: "Release root update",
      input: {
        change: {
          kind: "spec.update",
          target: {
            id: "mx_01000000000000000000000001",
            kind: "spec",
            title: "Release root",
          },
          patch,
        },
        rationale: "Preserve the exact selected patch fields.",
        evidence: [],
        targetRevisions: [{
          target: { kind: "entity", id: "mx_01000000000000000000000001" },
          revision: "3".repeat(64),
          semanticRevision: 4,
        }],
      },
    };
    vi.spyOn(api, "getInboxDraft").mockResolvedValue(update);
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api);
    await openDrafts(user);
    await user.click((await screen.findByText(base.title)).closest("button")!);
    await screen.findByRole("heading", { level: 2, name: "Release root update" });
    await user.click(screen.getByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit local Spec draft" });
    expect(within(dialog).getByRole("button", { name: "Title" })).toHaveAttribute(
      "aria-pressed",
      Object.hasOwn(patch, "title") ? "true" : "false",
    );
    expect(within(dialog).getByRole("button", { name: "Summary" })).toHaveAttribute(
      "aria-pressed",
      Object.hasOwn(patch, "summary") ? "true" : "false",
    );
    expect(within(dialog).getByRole("button", { name: "Body" })).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByRole("textbox", { name: "Replacement body" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    const request = preview.mock.calls[0]![0];
    if (request.action.kind !== "inbox.draft.save" || request.action.draft.change.kind !== "spec.update") {
      throw new Error("Expected a typed Spec update draft.");
    }
    expect(request.action.draft.change.patch).toEqual(patch);
  });

  it("preserves rich topics, relation attestations, and every typed evidence ref while editing", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const base = await api.getInboxDraft(DRAFT_ID);
    const rich: InboxDraftDetail = {
      ...base,
      input: {
        change: {
          kind: "spec.create",
          entityKind: "requirement",
          title: base.title,
          body: "Rich body\n\twith canonical layout.",
          summary: "Rich typed draft.",
          status: "in_flight",
          topics: [TOPIC_ID],
          relation: {
            type: "derived_from",
            target: { id: RELATION_ID, kind: "spec", title: "Release root" },
          },
        },
        rationale: "Keep all rich input intact.",
        evidence: [
          { kind: "entity", entity: { id: RELATION_ID, kind: "spec", title: "Release root" } },
          { kind: "code", code: { kind: "symbol", symbolId: "symbol.release" } },
          { kind: "commit", hash: "a".repeat(40) },
          { kind: "file", path: "src/release.ts" },
          { kind: "external", uri: "https://example.test/evidence", label: "Evidence" },
          { kind: "manual", note: "Manual evidence\nwith context." },
        ],
        targetRevisions: [{
          target: { kind: "entity", id: TOPIC_ID },
          revision: "2".repeat(64),
          semanticRevision: 2,
        }, {
          target: { kind: "entity", id: RELATION_ID },
          revision: "3".repeat(64),
          semanticRevision: 3,
        }],
      },
    };
    vi.spyOn(api, "getInboxDraft").mockResolvedValue(rich);
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api);
    await openDrafts(user);
    await user.click((await screen.findByText(base.title)).closest("button")!);
    await screen.findByText("Rich body", { exact: false });
    await user.click(screen.getByRole("button", { name: "Edit wording" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit local Spec draft" });
    expect(within(dialog).getByText("Existing evidence (preserved)")).toBeVisible();
    expect(within(dialog).getByText("Evidence")).toBeVisible();
    const advanced = within(dialog).getByRole("button", { name: "Advanced" });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByRole("textbox", { name: /Topic endpoint attestations/ })).not.toBeInTheDocument();
    await user.click(advanced);
    expect(within(dialog).getByRole("textbox", { name: /Topic endpoint attestations/ })).toHaveValue(
      `${TOPIC_ID} | ${"2".repeat(64)} | 2`,
    );
    expect(within(dialog).getByRole("combobox", { name: /One hierarchy relation/ })).toHaveValue("derived_from");
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    const request = preview.mock.calls[0]![0];
    expect(request.action.kind).toBe("inbox.draft.save");
    if (request.action.kind !== "inbox.draft.save") throw new Error("Expected draft save request.");
    expect(request.action.draft).toEqual(rich.input);
  });

  it("rotates operation identity after review edits and fails a rejected apply closed", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewInboxOperation");
    vi.spyOn(api, "applyInboxOperation").mockRejectedValue(new Error("/private/repository must not leak"));
    renderRoute(api);
    await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" });
    await selectMoreAction(user, "Decline proposal…");
    const dialog = await screen.findByRole("dialog", { name: "Decline proposal" });
    const rationale = within(dialog).getByRole("textbox", { name: "Review rationale" });
    await user.type(rationale, "The evidence is incomplete.");
    await user.click(within(dialog).getByRole("button", { name: "Review decline" }));
    await within(dialog).findByRole("button", { name: "Exact technical details" });
    await user.type(rationale, " Rework it.");
    await user.click(within(dialog).getByRole("button", { name: "Review decline" }));
    await within(dialog).findByRole("button", { name: "Exact technical details" });
    expect(preview.mock.calls[0]![0].operationId).not.toBe(preview.mock.calls[1]![0].operationId);
    await user.click(within(dialog).getByRole("button", { name: "Review outcome" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Decline this proposal?" });
    await user.click(within(confirmation).getByRole("button", { name: "Decline proposal" }));
    expect(await within(confirmation).findByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(confirmation).not.toHaveTextContent("/private/repository");
    await user.click(within(confirmation).getByRole("button", { name: "Keep reviewing" }));
    expect(screen.getByRole("dialog", { name: "Decline proposal" })).toBeVisible();
  });

  it("keeps a supporting-action confirmation modal while its apply is pending", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const applyGate = deferred<void>();
    const realApply = api.applyInboxOperation.bind(api);
    const apply = vi.spyOn(api, "applyInboxOperation").mockImplementation(async (envelope) => {
      await applyGate.promise;
      return realApply(envelope);
    });
    renderRoute(api, `/inbox?view=review&proposal=${PROPOSAL_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Clarify release evidence review" });
    await selectMoreAction(user, "Decline proposal…");
    const dialog = await screen.findByRole("dialog", { name: "Decline proposal" });
    await user.type(within(dialog).getByRole("textbox", { name: "Review rationale" }), "The evidence is incomplete.");
    await user.click(within(dialog).getByRole("button", { name: "Review decline" }));
    await user.click(await within(dialog).findByRole("button", { name: "Review outcome" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Decline this proposal?" });
    await user.click(within(confirmation).getByRole("button", { name: "Decline proposal" }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());

    await user.keyboard("{Escape}");
    expect(confirmation).toBeVisible();
    expect(within(confirmation).getByRole("button", { name: "Applying…" })).toBeDisabled();

    applyGate.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Decline this proposal?" })).not.toBeInTheDocument());
  });

  it("keeps publication read-only until privacy confirmation, applies its exact envelope, and focuses the Git notice", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const draft = await api.getInboxDraft(DRAFT_ID);
    const realPreview = api.previewInboxOperation.bind(api);
    let exactEnvelope: InboxOperationPreviewResponse | undefined;
    const preview = vi.spyOn(api, "previewInboxOperation").mockImplementation(async (request) => {
      exactEnvelope = await realPreview(request);
      return exactEnvelope;
    });
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    await screen.findByRole("heading", { level: 2, name: draft.title });
    await user.click(screen.getByRole("button", { name: "Publish for review" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Publish this draft for review?" });
    expect(within(confirmation).getByText(/pending Markdown proposal in this checkout/)).toBeVisible();
    expect(within(confirmation).getByText(/Project knowledge changes only after approval/)).toBeVisible();
    expect(within(confirmation).getByText("Git step still required")).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole("button", { name: "Publish for review" }));
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    expect(preview.mock.calls[0]![0]).toMatchObject({
      action: { kind: "inbox.publish", draftId: DRAFT_ID },
      expectedRevisions: [{
        target: { kind: "local", namespace: "inbox-draft", id: DRAFT_ID },
        revision: draft.revision,
      }],
    });
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(exactEnvelope).toBeDefined();
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);

    const noticeTitle = await screen.findByText("Proposal created");
    const gitNotice = noticeTitle.closest<HTMLElement>("[role='alert']");
    if (gitNotice === null) throw new Error("Expected the publication Git truth alert.");
    expect(within(gitNotice).getByText(
      "Proposal created in your working tree. Commit and push it to make it available to teammates.",
    )).toBeVisible();
    await waitFor(() => expect(gitNotice).toHaveFocus());
    await user.click(within(gitNotice).getByRole("button", { name: "Dismiss Git notice" }));
    await waitFor(() => expect(screen.queryByText("Proposal created")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("uses one discard confirmation and keeps a failed exact apply recoverable", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    const envelopes: InboxOperationPreviewResponse[] = [];
    const preview = vi.spyOn(api, "previewInboxOperation").mockImplementation(async (request) => {
      const envelope = await realPreview(request);
      envelopes.push(envelope);
      return envelope;
    });
    const realApply = api.applyInboxOperation.bind(api);
    const apply = vi.spyOn(api, "applyInboxOperation").mockImplementation(realApply);
    apply.mockRejectedValueOnce(new Error("/private/checkout/drafts must not leak"));
    renderRoute(api, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" });
    await selectDraftMoreAction(user, "Discard draft…");
    const confirmation = await screen.findByRole("alertdialog", { name: "Discard this draft?" });
    expect(within(confirmation).getByText(/removes the private draft from this checkout/)).toBeVisible();
    expect(preview).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(preview).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]![0]).toBe(envelopes[0]);
    expect(await within(confirmation).findByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(confirmation).not.toHaveTextContent("/private/checkout");
    expect(confirmation).toBeVisible();

    await user.click(within(confirmation).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(preview).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]![0]).toBe(envelopes[1]);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Discard this draft?" })).not.toBeInTheDocument());
    expect(await screen.findByText("Draft state updated on this device.")).toBeVisible();
  });

  it("keeps draft edit, publication, and approval capabilities independent", async () => {
    const user = userEvent.setup();
    const publishApi = createFixtureApi();
    const publishCapabilities = await publishApi.getCapabilities();
    vi.spyOn(publishApi, "getCapabilities").mockResolvedValue({
      ...publishCapabilities,
      inbox: {
        ...publishCapabilities.inbox,
        draftMutation: { availability: "unavailable", reason: "Local draft writes are locked." },
        specApproval: { availability: "unavailable", reason: "Spec approval is offline." },
      },
    });
    const publishView = renderRoute(publishApi, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" });
    expect(screen.getByRole("button", { name: "Publish for review" })).toBeDisabled();
    expect(screen.getByText("Publication is unavailable: Spec approval is offline.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit wording" })).toBeDisabled();
    expect(screen.getByText("Editing and discarding are unavailable: Local draft writes are locked.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "More draft actions" }));
    expect(await screen.findByRole("menuitem", { name: /Discard draft…/ })).toHaveAttribute("aria-disabled", "true");
    publishView.unmount();

    const editApi = createFixtureApi();
    const editCapabilities = await editApi.getCapabilities();
    vi.spyOn(editApi, "getCapabilities").mockResolvedValue({
      ...editCapabilities,
      inbox: {
        ...editCapabilities.inbox,
        proposalMutation: { availability: "unavailable", reason: "Proposal storage is read-only." },
      },
    });
    renderRoute(editApi, `/inbox?view=drafts&draft=${DRAFT_ID}`);
    await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" });
    expect(screen.getByRole("button", { name: "Publish for review" })).toBeDisabled();
    expect(screen.getByText("Publication is unavailable: Proposal storage is read-only.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit wording" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "More draft actions" }));
    expect(await screen.findByRole("menuitem", { name: "Discard draft…" })).toBeEnabled();
  });

  it("shows an externally created draft only after explicit Refresh and never polls", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const populated = await api.getInboxDrafts({ limit: 25 });
    const empty = { ...populated, items: [], nextCursor: null, truncated: false };
    const list = vi.spyOn(api, "getInboxDrafts")
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(populated);
    const detail = vi.spyOn(api, "getInboxDraft");
    renderRoute(api, "/inbox?view=drafts");

    expect(await screen.findByText("No drafts on this device")).toBeVisible();
    expect(list).toHaveBeenCalledOnce();
    expect(detail).not.toHaveBeenCalled();
    await act(async () => Promise.resolve());
    expect(list).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const row = (await screen.findByText("Keep Inbox review focused on meaningful changes")).closest("button");
    expect(row).toHaveAttribute("data-inbox-draft-id", DRAFT_ID);
    expect(list).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" })).toBeVisible();
    expect(detail).toHaveBeenCalledWith(DRAFT_ID);
  });

  it("clears a selected draft that disappears on Refresh and explains how to recover", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const populated = await api.getInboxDrafts({ limit: 25 });
    const draft = await api.getInboxDraft(DRAFT_ID);
    const empty = { ...populated, items: [], nextCursor: null, truncated: false };
    vi.spyOn(api, "getInboxDrafts")
      .mockResolvedValueOnce(populated)
      .mockResolvedValue(empty);
    const detail = vi.spyOn(api, "getInboxDraft")
      .mockResolvedValueOnce(draft)
      .mockRejectedValue(new Error("Fixture draft was removed externally."));
    renderRoute(api, `/inbox?view=drafts&draft=${DRAFT_ID}`);

    expect(await screen.findByRole("heading", { level: 2, name: draft.title })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("That draft is no longer on this device. Choose another draft.")).toBeVisible();
    expect(await screen.findByText("No drafts on this device")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Choose a draft" })).toBeVisible();
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it("keeps unavailable and list-error states explicit without issuing hidden reads", async () => {
    const unavailableApi = createFixtureApi();
    const capabilities = await unavailableApi.getCapabilities();
    const list = vi.spyOn(unavailableApi, "getInboxDrafts");
    vi.spyOn(unavailableApi, "getCapabilities").mockResolvedValue({
      ...capabilities,
      inbox: {
        ...capabilities.inbox,
        read: { availability: "unavailable", reason: "Inbox storage is not connected." },
      },
    });
    const unavailable = renderRoute(unavailableApi);
    expect(await screen.findByRole("heading", { name: "Inbox is unavailable" })).toBeVisible();
    expect(screen.getByText("Inbox storage is not connected.")).toBeVisible();
    expect(list).not.toHaveBeenCalled();
    unavailable.unmount();

    const errorApi = createFixtureApi();
    vi.spyOn(errorApi, "getInboxDrafts").mockRejectedValue(new Error("/private/repository/drafts"));
    renderRoute(errorApi, "/inbox?view=drafts");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(alert).not.toHaveTextContent("/private/repository/drafts");
  });
});

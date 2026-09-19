import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamInboxSpecCliService } from "../service.js";
import type { InboxMutationCommandName } from "../request-file.js";
import {
  runInboxDraftList,
  runInboxDraftShow,
  runInboxMutation,
  runInboxProposalList,
  runInboxProposalShow,
} from "../commands.js";

const PROPOSAL_ID = "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_ID = "event_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND_EVENT_ID = "event_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SPEC_ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVISION = "a".repeat(64);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-inbox-cli-"));
  roots.push(root);
  return root;
}

function command(action: Record<string, unknown>, expectedRevisions: unknown[] = []): unknown {
  return { operationId: "inbox-cli-test-1", action, expectedRevisions };
}

function draftInput(): Record<string, unknown> {
  return {
    change: { kind: "spec.create", entityKind: "spec", title: "Release", body: "Reviewed scope.", status: "in_flight" },
    rationale: "Review this scope.",
    evidence: [],
    targetRevisions: [],
  };
}

function localExpectation(): unknown[] {
  return [{ target: { kind: "local", namespace: "inbox-draft", id: "draft-1" }, revision: REVISION }];
}

function proposalExpectation(): unknown[] {
  return [{ target: { kind: "artifact", path: `.mex/inbox/${PROPOSAL_ID}.md` }, revision: REVISION }];
}

function previewEnvelope(
  commandName: InboxMutationCommandName,
  action: Record<string, unknown>,
  expectedRevisions: unknown[],
  purposeIds: unknown[],
  diagnostics: unknown[] = [],
): Record<string, any> {
  return {
    schemaVersion: 1,
    command: commandName,
    mode: "preview",
    ok: true,
    data: {
      schemaVersion: 1,
      request: command(action, expectedRevisions),
      preview: {
        valid: true,
        scope: "local",
        changes: [],
        localChanges: [],
        diagnostics,
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: { kind: "unknown" },
          occurredAt: "2026-08-28T00:00:00.000Z",
          repoState: {
            branch: "main",
            head: "b".repeat(40),
            dirty: false,
            observedAt: "2026-08-28T00:00:00.000Z",
          },
        },
        purposeIds,
        requestRevision: "c".repeat(64),
        presentationRevision: "d".repeat(64),
        previewRevision: "e".repeat(64),
      },
    },
    diagnostics,
    problem: null,
  };
}

async function expectApplyRejectedBeforeService(
  root: string,
  label: string,
  commandName: InboxMutationCommandName,
  envelope: unknown,
): Promise<void> {
  const path = join(root, `${label}.json`);
  writeFileSync(path, JSON.stringify(envelope));
  const create = vi.fn(async () => service());
  const output = io();
  await runInboxMutation(create, commandName, undefined, { json: true, apply: path }, output.value);
  expect(create, label).not.toHaveBeenCalled();
  expect(JSON.parse(output.lines[0]!), label).toMatchObject({
    ok: false,
    problem: { code: "INVALID_REQUEST" },
  });
  expect(output.exits, label).toEqual([2]);
}

const mutationCases = [
  ["inbox.draft.save", { kind: "inbox.draft.save", draft: draftInput() }, []],
  ["inbox.draft.delete", { kind: "inbox.draft.delete", draftId: "draft-1" }, localExpectation()],
  ["inbox.publish", { kind: "inbox.publish", draftId: "draft-1" }, localExpectation()],
  ["inbox.proposal.approve", { kind: "inbox.approve", proposalId: PROPOSAL_ID }, proposalExpectation()],
  ["inbox.proposal.reject", { kind: "inbox.reject", proposalId: PROPOSAL_ID, rationale: "Insufficient proof." }, proposalExpectation()],
  ["inbox.proposal.withdraw", { kind: "inbox.withdraw", proposalId: PROPOSAL_ID }, proposalExpectation()],
  ["inbox.proposal.mark-stale", { kind: "inbox.mark-stale", proposalId: PROPOSAL_ID, rationale: "Target drifted." }, proposalExpectation()],
  ["inbox.proposal.repair", { kind: "inbox.repair", proposalId: PROPOSAL_ID, replacement: draftInput() }, proposalExpectation()],
] as const;

function service(): TeamInboxSpecCliService {
  const page = {
    items: [], nextCursor: null, truncated: false, sourceTruncated: false,
    deterministicRevision: "a".repeat(64), diagnostics: [],
  };
  return {
    getInboxDraft: vi.fn(async () => null),
    listInboxDrafts: vi.fn(async () => page),
    getInboxProposal: vi.fn(async () => null),
    listInboxProposals: vi.fn(async () => page),
    previewInbox: vi.fn(async (request) => ({
      schemaVersion: 1 as const,
      request,
      preview: { valid: true as const, scope: "local" as const, changes: [], localChanges: [], diagnostics: [] },
      receipt: {
        schemaVersion: 1 as const,
        authority: {
          actor: { kind: "unknown" as const }, occurredAt: "2026-08-28T00:00:00.000Z",
          repoState: { branch: "main", head: "b".repeat(40), dirty: false, observedAt: "2026-08-28T00:00:00.000Z" },
        },
        purposeIds: [{ purpose: "inbox-draft" as const, id: "draft-1" }],
        requestRevision: "c".repeat(64), presentationRevision: "d".repeat(64), previewRevision: "e".repeat(64),
      },
    })),
    applyInbox: vi.fn(async (preview) => ({
      operationId: preview.request.operationId,
      previewRevision: preview.receipt.previewRevision,
      applied: true as const, idempotentReplay: false, changes: [], localChanges: [], proposals: [], events: [],
    })),
  };
}

function io(): { lines: string[]; exits: number[]; value: { write(line: string): void; setExitCode(code: number): void } } {
  const lines: string[] = [];
  const exits: number[] = [];
  return { lines, exits, value: { write: (line) => lines.push(line), setExitCode: (code) => exits.push(code) } };
}

describe("Inbox CLI adapter", () => {
  it("locks every mutation command to its one governed action", async () => {
    const root = fixture();
    for (const [expectedCommand, action, expectations] of mutationCases) {
      const port = service();
      const path = join(root, `${expectedCommand}.json`);
      writeFileSync(path, JSON.stringify(command({ ...action }, [...expectations])));
      const output = io();
      await runInboxMutation(port, expectedCommand, path, { json: true }, output.value);
      expect(output.exits, expectedCommand).toEqual([0]);
      expect(vi.mocked(port.previewInbox), expectedCommand).toHaveBeenCalledOnce();
      expect(vi.mocked(port.previewInbox).mock.calls[0]![0].action.kind, expectedCommand).toBe(action.kind);
    }

    const wrong = join(root, "wrong-command.json");
    writeFileSync(wrong, JSON.stringify(command({ kind: "inbox.publish", draftId: "draft-1" }, localExpectation())));
    const create = vi.fn(async () => service());
    const refused = io();
    await runInboxMutation(create, "inbox.draft.delete", wrong, { json: true }, refused.value);
    expect(create).not.toHaveBeenCalled();
    expect(refused.exits).toEqual([2]);
  });

  it("keeps list projections bounded and validates repeatable proposal states", async () => {
    const port = service();
    const draft = io();
    await runInboxDraftList(port, { json: true, limit: "25" }, draft.value);
    expect(port.listInboxDrafts).toHaveBeenCalledWith({ limit: 25 });
    expect(JSON.parse(draft.lines[0]!)).toMatchObject({ schemaVersion: 1, command: "inbox.draft.list", mode: "read", ok: true });
    expect(draft.exits).toEqual([0]);

    const proposal = io();
    await runInboxProposalList(port, { json: true, state: ["stale", "pending", "stale"] }, proposal.value);
    expect(port.listInboxProposals).toHaveBeenCalledWith({ states: ["stale", "pending"] });
  });

  it("projects draft/proposal list and show results and types not-found exits", async () => {
    const port = service();
    const input = draftInput() as any;
    const draftSummary = {
      id: "draft-1", revision: REVISION, updatedAt: "2026-08-28T00:00:00.000Z",
      changeKind: "spec.create" as const, entityKind: "spec" as const, title: "Release", rationaleExcerpt: "Review.",
    };
    const proposalSummary = {
      schemaVersion: 1 as const,
      ref: { id: PROPOSAL_ID, kind: "inbox_proposal", title: "Release" },
      sourcePath: `.mex/inbox/${PROPOSAL_ID}.md`, revision: REVISION, state: "pending" as const,
      author: { kind: "unknown" as const }, changeKind: "spec.create" as const,
      entityKind: "spec" as const, title: "Release", rationaleExcerpt: "Review.",
    };
    vi.mocked(port.listInboxDrafts).mockResolvedValue({
      items: [draftSummary], nextCursor: "next", truncated: true, sourceTruncated: true,
      deterministicRevision: REVISION, diagnostics: [],
    });
    vi.mocked(port.getInboxDraft).mockResolvedValue({ ...draftSummary, input });
    vi.mocked(port.listInboxProposals).mockResolvedValue({
      items: [proposalSummary], nextCursor: null, truncated: false, sourceTruncated: false,
      deterministicRevision: REVISION, diagnostics: [],
    });
    vi.mocked(port.getInboxProposal).mockResolvedValue({
      ...proposalSummary, change: input.change, rationale: input.rationale,
      evidence: [], targetRevisions: [],
    });

    const draftList = io();
    await runInboxDraftList(port, { json: true }, draftList.value);
    expect(JSON.parse(draftList.lines[0]!).data).toMatchObject({ items: [draftSummary], nextCursor: "next", sourceTruncated: true });
    const draftShow = io();
    await runInboxDraftShow(port, "draft-1", { json: true }, draftShow.value);
    expect(JSON.parse(draftShow.lines[0]!).data.input).toEqual(input);
    const proposalList = io();
    await runInboxProposalList(port, { json: true }, proposalList.value);
    expect(JSON.parse(proposalList.lines[0]!).data.items).toEqual([proposalSummary]);
    const proposalShow = io();
    await runInboxProposalShow(port, PROPOSAL_ID, { json: true }, proposalShow.value);
    expect(JSON.parse(proposalShow.lines[0]!).data.change).toEqual(input.change);

    vi.mocked(port.getInboxDraft).mockResolvedValue(null);
    vi.mocked(port.getInboxProposal).mockResolvedValue(null);
    for (const run of [
      (output: ReturnType<typeof io>) => runInboxDraftShow(port, "missing", { json: true }, output.value),
      (output: ReturnType<typeof io>) => runInboxProposalShow(port, PROPOSAL_ID, { json: true }, output.value),
    ]) {
      const output = io();
      await run(output);
      expect(JSON.parse(output.lines[0]!)).toMatchObject({ ok: false, problem: { code: "NOT_FOUND" } });
      expect(output.exits).toEqual([3]);
    }
  });

  it("rejects invalid page bounds and filters before opening the service", async () => {
    for (const run of [
      (create: () => Promise<TeamInboxSpecCliService>, output: ReturnType<typeof io>) => runInboxDraftList(create, { json: true, cursor: "bad/cursor" }, output.value),
      (create: () => Promise<TeamInboxSpecCliService>, output: ReturnType<typeof io>) => runInboxDraftList(create, { json: true, limit: "101" }, output.value),
      (create: () => Promise<TeamInboxSpecCliService>, output: ReturnType<typeof io>) => runInboxProposalList(create, { json: true, state: "unknown" }, output.value),
    ]) {
      const create = vi.fn(async () => service());
      const output = io();
      await run(create, output);
      expect(create).not.toHaveBeenCalled();
      expect(output.exits).toEqual([2]);
    }
  });

  it("rejects noncanonical local ids as usage before opening the service", async () => {
    const create = vi.fn(async () => service());
    const output = io();
    await runInboxDraftShow(create, "nested/draft", { json: true }, output.value);
    expect(create).not.toHaveBeenCalled();
    expect(JSON.parse(output.lines[0]!)).toMatchObject({ ok: false, problem: { code: "INVALID_REQUEST" } });
    expect(output.exits).toEqual([2]);
  });

  it("rejects noncanonical mutation target ids before opening the service", async () => {
    const root = fixture();
    const cases = [
      command(
        { kind: "inbox.draft.save", draftId: "../escape", draft: draftInput() },
        [{ target: { kind: "local", namespace: "inbox-draft", id: "../escape" }, revision: REVISION }],
      ),
      command(
        { kind: "inbox.draft.delete", draftId: "../escape" },
        [{ target: { kind: "local", namespace: "inbox-draft", id: "../escape" }, revision: REVISION }],
      ),
      command(
        { kind: "inbox.publish", draftId: "../escape" },
        [{ target: { kind: "local", namespace: "inbox-draft", id: "../escape" }, revision: REVISION }],
      ),
      command(
        { kind: "inbox.approve", proposalId: `proposal_${"Z".repeat(26)}` },
        [{ target: { kind: "artifact", path: `.mex/inbox/proposal_${"Z".repeat(26)}.md` }, revision: REVISION }],
      ),
    ];

    for (const [index, request] of cases.entries()) {
      const path = join(root, `bad-target-${index}.json`);
      writeFileSync(path, JSON.stringify(request));
      const create = vi.fn(async () => service());
      const output = io();
      await runInboxMutation(
        create,
        index === 0 ? "inbox.draft.save"
          : index === 1 ? "inbox.draft.delete"
            : index === 2 ? "inbox.publish"
              : "inbox.proposal.approve",
        path,
        { json: true },
        output.value,
      );
      expect(create, String(index)).not.toHaveBeenCalled();
      expect(JSON.parse(output.lines[0]!), String(index)).toMatchObject({
        ok: false,
        problem: { code: "INVALID_REQUEST" },
      });
      expect(output.exits, String(index)).toEqual([2]);
    }
  });

  it("previews a strict request and applies only its complete emitted wrapper", async () => {
    const root = fixture();
    const port = service();
    const requestPath = join(root, "request.json");
    writeFileSync(requestPath, JSON.stringify(command({
      kind: "inbox.draft.save",
      draft: {
        change: { kind: "spec.create", entityKind: "spec", title: "Release", body: "Reviewed scope.", status: "in_flight" },
        rationale: "Review this scope.", evidence: [], targetRevisions: [],
      },
    })));
    const previewOutput = io();
    await runInboxMutation(port, "inbox.draft.save", requestPath, { json: true }, previewOutput.value);
    const preview = JSON.parse(previewOutput.lines[0]!);
    expect(preview).toMatchObject({ command: "inbox.draft.save", mode: "preview", ok: true });

    const previewPath = join(root, "preview.json");
    writeFileSync(previewPath, JSON.stringify(preview));
    const applyOutput = io();
    await runInboxMutation(port, "inbox.draft.save", undefined, { json: true, apply: previewPath }, applyOutput.value);
    expect(port.applyInbox).toHaveBeenCalledOnce();
    expect(JSON.parse(applyOutput.lines[0]!)).toMatchObject({ command: "inbox.draft.save", mode: "apply", ok: true });

    const altered = structuredClone(preview);
    altered.extra = true;
    writeFileSync(previewPath, JSON.stringify(altered));
    const refused = io();
    await runInboxMutation(port, "inbox.draft.save", undefined, { json: true, apply: previewPath }, refused.value);
    expect(JSON.parse(refused.lines[0]!)).toMatchObject({ ok: false, problem: { code: "INVALID_REQUEST" } });
    expect(refused.exits).toEqual([2]);
  });

  it("rejects malformed, nonregular, symlinked, and oversized files before service creation", async () => {
    const root = fixture();
    const valid = join(root, "valid.json");
    writeFileSync(valid, JSON.stringify(command({ kind: "inbox.draft.save", draft: draftInput() })));
    const malformed = join(root, "malformed.json");
    writeFileSync(malformed, "{not json");
    const directory = join(root, "directory");
    mkdirSync(directory);
    const link = join(root, "link.json");
    symlinkSync(valid, link);
    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, "x".repeat(65_537));

    for (const path of [malformed, directory, link, oversized]) {
      const create = vi.fn(async () => service());
      const output = io();
      await runInboxMutation(create, "inbox.draft.save", path, { json: true }, output.value);
      expect(create, path).not.toHaveBeenCalled();
      expect(output.exits, path).toEqual([2]);
    }
  });

  it("rejects malformed optional diagnostics and invalid timestamps before service construction", async () => {
    const root = fixture();
    const diagnosticCases = [
      {
        label: "diagnostic-path",
        diagnostic: { code: "TEST", severity: "warning", message: "Check this.", path: "../escape" },
      },
      {
        label: "diagnostic-location",
        diagnostic: {
          code: "TEST",
          severity: "warning",
          message: "Check this.",
          location: { path: "src/index.ts", startLine: 0 },
        },
      },
      {
        label: "diagnostic-entity",
        diagnostic: {
          code: "TEST",
          severity: "warning",
          message: "Check this.",
          entity: { id: SPEC_ID, kind: "spec", unsupported: true },
        },
      },
      {
        label: "diagnostic-remediation",
        diagnostic: {
          code: "TEST",
          severity: "warning",
          message: "Check this.",
          remediation: [{ label: "Fix this", unsupported: true }],
        },
      },
      {
        label: "diagnostic-detail",
        diagnostic: { code: "TEST", severity: "warning", message: "Check this.", detail: [] },
      },
    ] as const;

    for (const { label, diagnostic } of diagnosticCases) {
      await expectApplyRejectedBeforeService(
        root,
        label,
        "inbox.draft.save",
        previewEnvelope(
          "inbox.draft.save",
          { kind: "inbox.draft.save", draft: draftInput() },
          [],
          [{ purpose: "inbox-draft", id: "draft-1" }],
          [diagnostic],
        ),
      );
    }

    for (const [label, field] of [
      ["invalid-occurred-at", "occurredAt"],
      ["invalid-observed-at", "observedAt"],
    ] as const) {
      const envelope = previewEnvelope(
        "inbox.draft.save",
        { kind: "inbox.draft.save", draft: draftInput() },
        [],
        [{ purpose: "inbox-draft", id: "draft-1" }],
      );
      if (field === "occurredAt") {
        envelope.data.receipt.authority.occurredAt = "2026-02-30T00:00:00.000Z";
      } else {
        envelope.data.receipt.authority.repoState.observedAt = "2026-02-30T00:00:00.000Z";
      }
      await expectApplyRejectedBeforeService(root, label, "inbox.draft.save", envelope);
    }
  });

  it("rejects action-inconsistent, unordered, duplicate, and malformed receipt purposes before service construction", async () => {
    const root = fixture();
    const cases: readonly {
      label: string;
      commandName: InboxMutationCommandName;
      action: Record<string, unknown>;
      expectedRevisions: unknown[];
      purposeIds: unknown[];
    }[] = [
      {
        label: "wrong-purpose",
        commandName: "inbox.proposal.reject",
        action: { kind: "inbox.reject", proposalId: PROPOSAL_ID, rationale: "Insufficient proof." },
        expectedRevisions: proposalExpectation(),
        purposeIds: [{ purpose: "proposal", id: PROPOSAL_ID }],
      },
      {
        label: "missing-purpose",
        commandName: "inbox.proposal.reject",
        action: { kind: "inbox.reject", proposalId: PROPOSAL_ID, rationale: "Insufficient proof." },
        expectedRevisions: proposalExpectation(),
        purposeIds: [],
      },
      {
        label: "reversed-purposes",
        commandName: "inbox.publish",
        action: { kind: "inbox.publish", draftId: "draft-1" },
        expectedRevisions: localExpectation(),
        purposeIds: [
          { purpose: "proposal", id: PROPOSAL_ID },
          { purpose: "activity", id: EVENT_ID },
        ],
      },
      {
        label: "duplicate-purpose",
        commandName: "inbox.publish",
        action: { kind: "inbox.publish", draftId: "draft-1" },
        expectedRevisions: localExpectation(),
        purposeIds: [
          { purpose: "activity", id: EVENT_ID },
          { purpose: "activity", id: SECOND_EVENT_ID },
        ],
      },
      {
        label: "invalid-draft-purpose-id",
        commandName: "inbox.draft.save",
        action: { kind: "inbox.draft.save", draft: draftInput() },
        expectedRevisions: [],
        purposeIds: [{ purpose: "inbox-draft", id: "../escape" }],
      },
      {
        label: "invalid-activity-purpose-id",
        commandName: "inbox.proposal.reject",
        action: { kind: "inbox.reject", proposalId: PROPOSAL_ID, rationale: "Insufficient proof." },
        expectedRevisions: proposalExpectation(),
        purposeIds: [{ purpose: "activity", id: "activity_invalid" }],
      },
      {
        label: "invalid-proposal-purpose-id",
        commandName: "inbox.publish",
        action: { kind: "inbox.publish", draftId: "draft-1" },
        expectedRevisions: localExpectation(),
        purposeIds: [
          { purpose: "activity", id: EVENT_ID },
          { purpose: "proposal", id: "proposal_invalid" },
        ],
      },
      {
        label: "invalid-spec-purpose-id",
        commandName: "inbox.proposal.approve",
        action: { kind: "inbox.approve", proposalId: PROPOSAL_ID },
        expectedRevisions: proposalExpectation(),
        purposeIds: [
          { purpose: "activity", id: EVENT_ID },
          { purpose: "spec-entity", id: "mx_invalid" },
        ],
      },
    ];

    for (const entry of cases) {
      await expectApplyRejectedBeforeService(
        root,
        entry.label,
        entry.commandName,
        previewEnvelope(
          entry.commandName,
          entry.action,
          entry.expectedRevisions,
          entry.purposeIds,
        ),
      );
    }
  });

  it("rejects malformed save and repair evidence before service construction", async () => {
    const root = fixture();
    const saveDraft = structuredClone(draftInput());
    saveDraft.evidence = [{ kind: "manual", note: "bad\u0001note" }];
    const repairDraft = structuredClone(draftInput());
    repairDraft.evidence = [{ kind: "external", uri: "https://user:secret@example.test/evidence" }];
    const cases = [
      {
        label: "save-evidence",
        commandName: "inbox.draft.save" as const,
        request: command({ kind: "inbox.draft.save", draft: saveDraft }),
      },
      {
        label: "repair-evidence",
        commandName: "inbox.proposal.repair" as const,
        request: command(
          { kind: "inbox.repair", proposalId: PROPOSAL_ID, replacement: repairDraft },
          proposalExpectation(),
        ),
      },
    ];

    for (const entry of cases) {
      const path = join(root, `${entry.label}.json`);
      writeFileSync(path, JSON.stringify(entry.request));
      const create = vi.fn(async () => service());
      const output = io();
      await runInboxMutation(create, entry.commandName, path, { json: true }, output.value);
      expect(create, entry.label).not.toHaveBeenCalled();
      expect(JSON.parse(output.lines[0]!), entry.label).toMatchObject({
        ok: false,
        problem: { code: "INVALID_REQUEST" },
      });
      expect(output.exits, entry.label).toEqual([2]);
    }
  });

  it("rejects fragments, extra fields, authority drift, and tampered wrappers before apply", async () => {
    const root = fixture();
    const port = service();
    const requestPath = join(root, "request.json");
    writeFileSync(requestPath, JSON.stringify(command({ kind: "inbox.draft.save", draft: draftInput() })));
    const previewOutput = io();
    await runInboxMutation(port, "inbox.draft.save", requestPath, { json: true }, previewOutput.value);
    const preview = JSON.parse(previewOutput.lines[0]!);
    const cases = [
      preview.data,
      { ...preview, extra: true },
      { ...preview, command: "inbox.publish" },
      { ...preview, diagnostics: [{ code: "X", severity: "warning", message: "changed" }] },
      {
        ...preview,
        data: {
          ...preview.data,
          receipt: {
            ...preview.data.receipt,
            authority: { ...preview.data.receipt.authority, injected: true },
          },
        },
      },
      {
        ...preview,
        data: {
          ...preview.data,
          preview: { ...preview.data.preview, valid: false },
        },
      },
    ];
    for (const [index, candidate] of cases.entries()) {
      const path = join(root, `tampered-${index}.json`);
      writeFileSync(path, JSON.stringify(candidate));
      vi.mocked(port.applyInbox).mockClear();
      const output = io();
      await runInboxMutation(port, "inbox.draft.save", undefined, { json: true, apply: path }, output.value);
      expect(port.applyInbox, String(index)).not.toHaveBeenCalled();
      expect(output.exits, String(index)).toEqual([2]);
    }

    const mixedMode = io();
    await runInboxMutation(port, "inbox.draft.save", requestPath, { json: true, apply: requestPath }, mixedMode.value);
    expect(port.applyInbox).not.toHaveBeenCalled();
    expect(mixedMode.exits).toEqual([2]);
  });
});

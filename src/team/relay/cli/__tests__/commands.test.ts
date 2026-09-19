import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayPreviewEnvelope,
} from "../../../contracts/workflow.js";
import {
  runRelayDraftList,
  runRelayDraftShow,
  runRelayList,
  runRelayMutation,
  runRelayShow,
} from "../commands.js";
import type { RelayMutationCommandName } from "../request-file.js";
import type { TeamRelayCliService } from "../service.js";

const MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKSTREAM_ID = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RELAY_ID = "relay_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_ID = "event_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVISION = "a".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-relay-cli-"));
  roots.push(root);
  return root;
}

function request(action: TeamRelayCommand["action"], expectedRevisions: unknown[] = []): unknown {
  return { operationId: "relay-cli-test-1", action, expectedRevisions };
}

function draftInput(): any {
  return {
    recipients: [{ kind: "member", memberId: MEMBER_ID }],
    summary: "Continue the reviewed handoff.",
    completed: ["Implemented the contract."],
    inProgress: ["Run the checks."],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: ["src/index.ts"],
    code: [],
    evidence: [{ kind: "file", path: "src/index.ts" }],
    nextActions: ["Review the exact preview."],
  };
}

function localExpectation(): any[] {
  return [{
    target: { kind: "local", namespace: "relay-draft", id: "draft-1" },
    revision: REVISION,
  }];
}

function relayExpectation(): any[] {
  return [{
    target: { kind: "artifact", path: `.mex/relays/${RELAY_ID}.md` },
    revision: REVISION,
  }];
}

function publishExpectations(): any[] {
  return [
    ...localExpectation(),
    {
      target: { kind: "artifact", path: `.mex/team/members/${MEMBER_ID}.md` },
      revision: REVISION,
    },
  ];
}

function legacyDraftInput(evidence: unknown[] = []): any {
  return {
    ...draftInput(),
    workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" },
    evidence,
  };
}

const mutationCases = [
  ["relay.draft.save", { kind: "relay.draft.save", draft: draftInput() }, []],
  ["relay.draft.delete", { kind: "relay.draft.delete", draftId: "draft-1" }, localExpectation()],
  ["relay.publish", { kind: "relay.publish", draftId: "draft-1" }, publishExpectations()],
  ["relay.acknowledge", { kind: "relay.acknowledge", relayId: RELAY_ID }, relayExpectation()],
  ["relay.close", { kind: "relay.close", relayId: RELAY_ID }, relayExpectation()],
] as const;

function service(): TeamRelayCliService {
  const page = {
    items: [],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: REVISION,
    diagnostics: [],
  };
  return {
    getRelayDraft: vi.fn(async () => null),
    listRelayDrafts: vi.fn(async () => page),
    getRelay: vi.fn(async () => null),
    listRelays: vi.fn(async () => page),
    previewRelay: vi.fn(async (command) => previewFor(command)),
    applyRelay: vi.fn(async (preview) => ({
      operationId: preview.request.operationId,
      previewRevision: preview.receipt.previewRevision,
      applied: true as const,
      idempotentReplay: false as const,
      changes: [],
      localChanges: [],
      relays: [],
      events: [],
    })),
  };
}

function previewFor(command: TeamRelayCommand): TeamRelayPreviewEnvelope {
  const purposeIds = command.action.kind === "relay.draft.save" && command.action.draftId === undefined
    ? [{ purpose: "relay-draft" as const, id: "draft-1" }]
    : command.action.kind === "relay.publish"
      ? [
          { purpose: "activity" as const, id: EVENT_ID },
          { purpose: "relay" as const, id: RELAY_ID },
        ]
      : command.action.kind === "relay.acknowledge" || command.action.kind === "relay.close"
        ? [{ purpose: "activity" as const, id: EVENT_ID }]
        : [];
  return {
    schemaVersion: 1,
    request: command,
    preview: { valid: true, scope: "local", changes: [], localChanges: [], diagnostics: [] },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: "2026-08-29T00:00:00.000Z",
        repoState: {
          branch: "main",
          head: "b".repeat(40),
          dirty: false,
          observedAt: "2026-08-29T00:00:00.000Z",
        },
      },
      purposeIds,
      requestRevision: "c".repeat(64),
      presentationRevision: "d".repeat(64),
      previewRevision: "e".repeat(64),
    },
  };
}

function io(): {
  lines: string[];
  exits: number[];
  value: { write(line: string): void; setExitCode(code: number): void };
} {
  const lines: string[] = [];
  const exits: number[] = [];
  return {
    lines,
    exits,
    value: {
      write: (line) => lines.push(line),
      setExitCode: (code) => exits.push(code),
    },
  };
}

describe("Relay CLI adapter", () => {
  it("saves sparse local content through one exact local preview/apply without looking up Members", async () => {
    const root = fixture();
    const path = join(root, "draft.json");
    writeFileSync(path, JSON.stringify({ summary: "Continue the parser correction.", nextActions: ["Check the remaining fixture."] }));
    const port = service();
    const preview = vi.spyOn(port, "previewRelay").mockImplementation(async (command) => ({
      ...previewFor(command),
      preview: { valid: true, scope: "local", changes: [], diagnostics: [], localChanges: [{
        namespace: "relay-draft", id: "draft-1", beforeRevision: null, afterRevision: REVISION, summary: "Save draft",
      }] },
    }));
    const output = io();
    await runRelayMutation(port, "relay.draft.save", undefined, { from: path, operationId: "quick-save-1", json: true }, output.value, { projectRoot: () => root });
    expect(output.exits).toEqual([0]);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "quick-save-1", expectedRevisions: [],
      action: { kind: "relay.draft.save", draft: expect.objectContaining({ audience: "team", recipients: [], summary: "Continue the parser correction.", nextActions: ["Check the remaining fixture."] }) },
    }));
    expect(port.applyRelay).toHaveBeenCalledWith(await preview.mock.results[0]!.value);
    expect(port.getRelayDraft).not.toHaveBeenCalled();
    expect(port.listRelays).not.toHaveBeenCalled();
    expect(JSON.parse(output.lines[0]!)).toMatchObject({ command: "relay.draft.save", mode: "apply", ok: true, data: { changes: [], events: [] } });
  });

  it("refuses canonical or invalid previews on the local save shortcut", async () => {
    const root = fixture();
    const path = join(root, "draft.json");
    writeFileSync(path, JSON.stringify({ summary: "Save for later." }));
    for (const scope of ["canonical", "mixed"] as const) {
      const port = service();
      vi.spyOn(port, "previewRelay").mockImplementation(async (command) => ({ ...previewFor(command), preview: { valid: true, scope, changes: [], localChanges: [], diagnostics: [] } }));
      const output = io();
      await runRelayMutation(port, "relay.draft.save", undefined, { from: path, json: true }, output.value, { projectRoot: () => root });
      expect(output.exits[0]).not.toBe(0);
      expect(port.applyRelay).not.toHaveBeenCalled();
    }
  });

  it("rejects ambiguous flags, authority injection and unsafe content files before opening a service", async () => {
    const root = fixture();
    const path = join(root, "draft.json");
    const link = join(root, "link.json");
    writeFileSync(path, JSON.stringify({ summary: "Save for later.", actor: { kind: "unknown" } }));
    symlinkSync(path, link);
    const factory = vi.fn(async () => service());
    for (const flags of [
      { from: path }, { from: link }, { from: path, apply: path }, { operationId: "orphan" },
    ]) {
      const output = io();
      await runRelayMutation(factory, "relay.draft.save", undefined, { ...flags, json: true }, output.value);
      expect(output.exits[0]).not.toBe(0);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("locks every mutation command to its one governed action", async () => {
    const root = fixture();
    for (const [commandName, action, expectations] of mutationCases) {
      const port = service();
      const path = join(root, `${commandName}.json`);
      writeFileSync(path, JSON.stringify(request(action as TeamRelayCommand["action"], [...expectations])));
      const output = io();
      await runRelayMutation(port, commandName, path, { json: true }, output.value);
      expect(output.exits, commandName).toEqual([0]);
      expect(port.previewRelay, commandName).toHaveBeenCalledOnce();
      expect(vi.mocked(port.previewRelay).mock.calls[0]![0].action.kind).toBe(action.kind);
    }

    const wrong = join(root, "wrong.json");
    writeFileSync(wrong, JSON.stringify(request(
      { kind: "relay.close", relayId: RELAY_ID },
      relayExpectation(),
    )));
    const create = vi.fn(async () => service());
    const refused = io();
    await runRelayMutation(create, "relay.acknowledge", wrong, { json: true }, refused.value);
    expect(create).not.toHaveBeenCalled();
    expect(refused.exits).toEqual([2]);
  });

  it("validates list filters before service creation and projects exact requests", async () => {
    const port = service();
    const output = io();
    await runRelayList(port, {
      json: true,
      perspective: "mine",
      state: ["published", "acknowledged", "published"],
      workstream: WORKSTREAM_ID,
      limit: "25",
    }, output.value);
    expect(port.listRelays).toHaveBeenCalledWith({
      perspective: "mine",
      states: ["published", "acknowledged"],
      workstreamId: WORKSTREAM_ID,
      limit: 25,
    });
    expect(output.exits).toEqual([0]);

    for (const flags of [
      { json: true, perspective: "owner" },
      { json: true, state: "withdrawn" },
      { json: true, workstream: "not-a-workstream" },
      { json: true, limit: "101" },
      { json: true, cursor: "bad/cursor" },
    ]) {
      const create = vi.fn(async () => service());
      const invalid = io();
      await runRelayList(create, flags, invalid.value);
      expect(create).not.toHaveBeenCalled();
      expect(invalid.exits).toEqual([2]);
    }
  });

  it("rejects malformed publish expectation topology before service construction", async () => {
    const root = fixture();
    const valid = publishExpectations();
    const invalidTopologies = [
      [],
      [
        ...valid,
        {
          target: { kind: "entity", id: "relay:unrelated" },
          revision: REVISION,
          semanticRevision: 1,
        },
      ],
      [
        ...valid,
        {
          target: { kind: "artifact", path: `.mex/relays/${RELAY_ID}.md` },
          revision: REVISION,
        },
      ],
      [
        ...valid,
        {
          target: { kind: "local", namespace: "relay-draft", id: "draft-other" },
          revision: REVISION,
        },
      ],
    ];
    for (const [index, expectedRevisions] of invalidTopologies.entries()) {
      const path = join(root, `invalid-publish-${index}.json`);
      writeFileSync(path, JSON.stringify(request(
        { kind: "relay.publish", draftId: "draft-1" },
        expectedRevisions,
      )));
      const create = vi.fn(async () => service());
      const output = io();
      await runRelayMutation(create, "relay.publish", path, { json: true }, output.value);
      expect(create, `topology ${index}`).not.toHaveBeenCalled();
      expect(output.exits, `topology ${index}`).toEqual([1]);
      expect(JSON.parse(output.lines[0]!), `topology ${index}`).toMatchObject({
        command: "relay.publish",
        mode: "preview",
        ok: false,
        problem: { code: "VALIDATION_FAILED" },
      });
    }

    const legacyDependencyPath = join(root, "legacy-workstream-publish.json");
    writeFileSync(legacyDependencyPath, JSON.stringify(request(
      { kind: "relay.publish", draftId: "draft-1" },
      [
        ...valid,
        {
          target: { kind: "artifact", path: `.mex/workstreams/${WORKSTREAM_ID}.md` },
          revision: REVISION,
        },
      ],
    )));
    const legacyFactory = vi.fn(async () => service());
    const legacyOutput = io();
    await runRelayMutation(
      legacyFactory,
      "relay.publish",
      legacyDependencyPath,
      { json: true },
      legacyOutput.value,
    );
    expect(legacyFactory).not.toHaveBeenCalled();
    expect(legacyOutput.exits).toEqual([1]);
    expect(JSON.parse(legacyOutput.lines[0]!)).toMatchObject({
      command: "relay.publish",
      mode: "preview",
      ok: false,
      problem: {
        code: "VALIDATION_FAILED",
        detail: expect.stringMatching(/preview again/i),
      },
    });
  });

  it("normalizes sparse drafts and translates legacy Workstreams without accepting new over-limit evidence", async () => {
    const root = fixture();
    const validPath = join(root, "valid-draft.json");
    writeFileSync(validPath, JSON.stringify(request({
      kind: "relay.draft.save",
      draft: {
        recipients: [{ kind: "member", memberId: MEMBER_ID }],
        summary: "Continue the sparse standalone handoff.",
      },
    } as any)));
    const validPort = service();
    const validFactory = vi.fn(async () => validPort);
    const validOutput = io();
    await runRelayMutation(
      validFactory,
      "relay.draft.save",
      validPath,
      { json: true },
      validOutput.value,
    );
    expect(validFactory).toHaveBeenCalledOnce();
    expect(validOutput.exits).toEqual([0]);
    expect(validPort.previewRelay).toHaveBeenCalledWith(expect.objectContaining({
      action: {
        kind: "relay.draft.save",
        draft: {
          recipients: [{ kind: "member", memberId: MEMBER_ID }],
          summary: "Continue the sparse standalone handoff.",
          completed: [],
          inProgress: [],
          decisions: [],
          blockers: [],
          unresolvedQuestions: [],
          changedFiles: [],
          code: [],
          evidence: [],
          nextActions: [],
        },
      },
    }));
    expect((vi.mocked(validPort.previewRelay).mock.calls[0]![0] as any).action.draft)
      .not.toHaveProperty("workstream");

    const invalidDrafts = [
      ...["src/relay\u0085.ts", "src/relay\u2028.ts", "src/relay\u2029.ts"].flatMap((path) => [
        { ...draftInput(), changedFiles: [path] },
        { ...draftInput(), evidence: [{ kind: "file", path }] },
      ]),
    ];
    for (const [index, draft] of invalidDrafts.entries()) {
      const path = join(root, `invalid-draft-${index}.json`);
      writeFileSync(path, JSON.stringify(request({ kind: "relay.draft.save", draft })));
      const create = vi.fn(async () => service());
      const output = io();
      await runRelayMutation(create, "relay.draft.save", path, { json: true }, output.value);
      expect(create, `draft ${index}`).not.toHaveBeenCalled();
      expect(output.exits, `draft ${index}`).toEqual([1]);
      expect(JSON.parse(output.lines[0]!), `draft ${index}`).toMatchObject({
        command: "relay.draft.save",
        mode: "preview",
        ok: false,
        problem: { code: "VALIDATION_FAILED" },
      });
    }

    const legacyPath = join(root, "legacy-draft.json");
    writeFileSync(legacyPath, JSON.stringify(request({
      kind: "relay.draft.save",
      draft: legacyDraftInput([{ kind: "manual", note: "Existing context" }]),
    })));
    const legacyPort = service();
    const legacyFactory = vi.fn(async () => legacyPort);
    const legacyOutput = io();
    await runRelayMutation(
      legacyFactory,
      "relay.draft.save",
      legacyPath,
      { json: true },
      legacyOutput.value,
    );
    expect(legacyOutput.exits).toEqual([0]);
    expect((vi.mocked(legacyPort.previewRelay).mock.calls[0]![0] as any).action.draft)
      .toMatchObject({
        evidence: [
          { kind: "entity", entity: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" } },
          { kind: "manual", note: "Existing context" },
        ],
      });
    expect((vi.mocked(legacyPort.previewRelay).mock.calls[0]![0] as any).action.draft)
      .not.toHaveProperty("workstream");

    const fullEvidence = Array.from({ length: 64 }, (_, index) => ({
      kind: "manual",
      note: `Legacy context ${String(index).padStart(2, "0")}`,
    }));
    writeFileSync(legacyPath, JSON.stringify(request({
      kind: "relay.draft.save",
      draft: legacyDraftInput(fullEvidence),
    })));
    const fullLegacyPort = service();
    const fullLegacyOutput = io();
    await runRelayMutation(
      fullLegacyPort,
      "relay.draft.save",
      legacyPath,
      { json: true },
      fullLegacyOutput.value,
    );
    expect(fullLegacyOutput.exits).toEqual([0]);
    const translatedEvidence = (vi.mocked(fullLegacyPort.previewRelay).mock.calls[0]![0] as any)
      .action.draft.evidence;
    expect(translatedEvidence).toHaveLength(65);
    expect(translatedEvidence.slice(1)).toEqual(fullEvidence);

    const overLimitPath = join(root, "new-over-limit-draft.json");
    writeFileSync(overLimitPath, JSON.stringify(request({
      kind: "relay.draft.save",
      draft: {
        ...draftInput(),
        evidence: [
          { kind: "entity", entity: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" } },
          ...fullEvidence,
        ],
      },
    })));
    const overLimitFactory = vi.fn(async () => service());
    const overLimitOutput = io();
    await runRelayMutation(
      overLimitFactory,
      "relay.draft.save",
      overLimitPath,
      { json: true },
      overLimitOutput.value,
    );
    expect(overLimitFactory).not.toHaveBeenCalled();
    expect(overLimitOutput.exits).toEqual([1]);
  });

  it("projects draft and Relay reads with typed not-found and ID validation", async () => {
    const port = service();
    const draft = {
      id: "draft-1",
      revision: REVISION,
      updatedAt: "2026-08-29T00:00:00.000Z",
      recipients: [{ kind: "member" as const, memberId: MEMBER_ID }],
      summary: "Continue the reviewed handoff.",
      input: draftInput(),
    };
    const relay = {
      schemaVersion: 3,
      ref: { id: RELAY_ID, kind: "relay" },
      sourcePath: `.mex/relays/${RELAY_ID}.md`,
      revision: REVISION,
      state: "published",
      sender: { kind: "member", memberId: MEMBER_ID },
      recipients: [{ kind: "member", memberId: MEMBER_ID }],
      workstream: null,
      summary: "Continue the reviewed handoff.",
      publishedAt: "2026-08-29T00:00:00.000Z",
      publishedRepoState: {
        branch: "benchmark",
        head: "b".repeat(40),
        dirty: true,
        observedAt: "2026-08-29T00:00:00.000Z",
      },
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
      diagnostics: [],
    } as unknown as TeamRelayDetail;
    vi.mocked(port.listRelayDrafts).mockResolvedValue({
      items: [{
        id: draft.id,
        revision: draft.revision,
        updatedAt: draft.updatedAt,
        recipients: draft.recipients,
        summary: draft.summary,
      }],
      nextCursor: "next",
      truncated: true,
      sourceTruncated: true,
      deterministicRevision: REVISION,
      diagnostics: [],
    });
    vi.mocked(port.getRelayDraft).mockResolvedValue(draft);
    vi.mocked(port.listRelays).mockResolvedValue({
      items: [relay],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: REVISION,
      diagnostics: [],
    });
    vi.mocked(port.getRelay).mockResolvedValue(relay);

    const draftList = io();
    await runRelayDraftList(port, { json: true }, draftList.value);
    expect(JSON.parse(draftList.lines[0]!).data.items[0].id).toBe("draft-1");
    const draftShow = io();
    await runRelayDraftShow(port, "draft-1", { json: true }, draftShow.value);
    expect(JSON.parse(draftShow.lines[0]!).data.input.summary).toContain("handoff");
    const relayList = io();
    await runRelayList(port, { json: true }, relayList.value);
    expect(JSON.parse(relayList.lines[0]!).data.items[0].publishedAt)
      .toBe("2026-08-29T00:00:00.000Z");
    const relayShow = io();
    await runRelayShow(port, RELAY_ID, { json: true }, relayShow.value);
    expect(JSON.parse(relayShow.lines[0]!)).toMatchObject({
      data: {
        schemaVersion: 3,
        ref: { id: RELAY_ID },
        workstream: null,
        publishedRepoState: {
          branch: "benchmark",
          head: "b".repeat(40),
          dirty: true,
        },
      },
    });

    const humanDraftList = io();
    await runRelayDraftList(port, {}, humanDraftList.value);
    expect(humanDraftList.lines.join("\n")).toContain("Continue the reviewed handoff.");
    expect(humanDraftList.lines.join("\n")).not.toMatch(/Workstream|undefined/u);
    const humanDraftShow = io();
    await runRelayDraftShow(port, "draft-1", {}, humanDraftShow.value);
    expect(humanDraftShow.lines.join("\n")).not.toMatch(/Workstream|undefined/u);
    const humanRelayList = io();
    await runRelayList(port, {}, humanRelayList.value);
    expect(humanRelayList.lines.join("\n")).toMatch(/benchmark/u);
    expect(humanRelayList.lines.join("\n")).toContain("bbbbbbbb");
    expect(humanRelayList.lines.join("\n")).not.toMatch(/Workstream|undefined/u);
    const humanRelayShow = io();
    await runRelayShow(port, RELAY_ID, {}, humanRelayShow.value);
    expect(humanRelayShow.lines.join("\n")).toMatch(/benchmark/u);
    expect(humanRelayShow.lines.join("\n")).toContain("bbbbbbbb");
    expect(humanRelayShow.lines.join("\n")).toMatch(/local changes|dirty/iu);
    expect(humanRelayShow.lines.join("\n")).toContain("2026-08-29T00:00:00.000Z");
    expect(humanRelayShow.lines.join("\n")).not.toMatch(/Workstream|undefined/u);

    vi.mocked(port.getRelay).mockResolvedValue({
      ...relay,
      schemaVersion: 1,
      workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" },
      publishedAt: null,
      publishedRepoState: null,
      diagnostics: [{
        code: "RELAY_LEGACY_PUBLICATION_TIME",
        severity: "warning",
        message: "Legacy Relay publication time is unavailable.",
      }],
    } as unknown as TeamRelayDetail);
    const legacyShow = io();
    await runRelayShow(port, RELAY_ID, { json: true }, legacyShow.value);
    expect(JSON.parse(legacyShow.lines[0]!)).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        workstream: { id: WORKSTREAM_ID },
        publishedAt: null,
        publishedRepoState: null,
      },
      diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME" }],
    });
    const humanLegacyShow = io();
    await runRelayShow(port, RELAY_ID, {}, humanLegacyShow.value);
    expect(humanLegacyShow.lines.join("\n")).toContain(WORKSTREAM_ID);
    expect(humanLegacyShow.lines.join("\n")).not.toContain("undefined");

    vi.mocked(port.getRelay).mockResolvedValue({
      ...relay,
      publishedRepoState: {
        branch: null,
        head: null,
        dirty: false,
        observedAt: "2026-08-29T00:00:00.000Z",
      },
    } as unknown as TeamRelayDetail);
    const detachedShow = io();
    await runRelayShow(port, RELAY_ID, {}, detachedShow.value);
    expect(detachedShow.lines.join("\n")).toMatch(/Detached HEAD/i);
    expect(detachedShow.lines.join("\n")).toMatch(/No committed HEAD/i);

    for (const run of [
      (create: () => Promise<TeamRelayCliService>, output: ReturnType<typeof io>) =>
        runRelayDraftShow(create, "nested/draft", { json: true }, output.value),
      (create: () => Promise<TeamRelayCliService>, output: ReturnType<typeof io>) =>
        runRelayShow(create, "not-a-relay", { json: true }, output.value),
    ]) {
      const create = vi.fn(async () => service());
      const invalid = io();
      await run(create, invalid);
      expect(create).not.toHaveBeenCalled();
      expect(invalid.exits).toEqual([2]);
    }

    vi.mocked(port.getRelayDraft).mockResolvedValue(null);
    const missing = io();
    await runRelayDraftShow(port, "missing", { json: true }, missing.value);
    expect(JSON.parse(missing.lines[0]!)).toMatchObject({
      ok: false,
      problem: { code: "NOT_FOUND" },
    });
    expect(missing.exits).toEqual([3]);
  });

  it("matches the 128-byte checkout-local draft ID boundary before service construction", async () => {
    const acceptedId = `d${"a".repeat(127)}`;
    const acceptedFactory = vi.fn(async () => service());
    const accepted = io();
    await runRelayDraftShow(acceptedFactory, acceptedId, { json: true }, accepted.value);
    expect(acceptedFactory).toHaveBeenCalledOnce();
    expect(accepted.exits).toEqual([3]);

    const rejectedFactory = vi.fn(async () => service());
    const rejected = io();
    await runRelayDraftShow(rejectedFactory, `${acceptedId}a`, { json: true }, rejected.value);
    expect(rejectedFactory).not.toHaveBeenCalled();
    expect(rejected.exits).toEqual([2]);
    expect(JSON.parse(rejected.lines[0]!)).toMatchObject({
      command: "relay.draft.show",
      ok: false,
      problem: { code: "INVALID_REQUEST" },
    });
  });

  it("applies only the exact complete emitted wrapper", async () => {
    const root = fixture();
    const port = service();
    const requestPath = join(root, "save.json");
    writeFileSync(requestPath, JSON.stringify(request({
      kind: "relay.draft.save",
      draft: draftInput(),
    })));
    const previewOutput = io();
    await runRelayMutation(port, "relay.draft.save", requestPath, { json: true }, previewOutput.value);
    const preview = JSON.parse(previewOutput.lines[0]!);
    expect(preview).toMatchObject({ command: "relay.draft.save", mode: "preview", ok: true });

    const previewPath = join(root, "preview.json");
    writeFileSync(previewPath, JSON.stringify(preview));
    const applied = io();
    await runRelayMutation(port, "relay.draft.save", undefined, {
      json: true,
      apply: previewPath,
    }, applied.value);
    expect(port.applyRelay).toHaveBeenCalledOnce();
    expect(JSON.parse(applied.lines[0]!)).toMatchObject({
      command: "relay.draft.save",
      mode: "apply",
      ok: true,
    });

    preview.extra = true;
    writeFileSync(previewPath, JSON.stringify(preview));
    const create = vi.fn(async () => service());
    const refused = io();
    await runRelayMutation(create, "relay.draft.save", undefined, {
      json: true,
      apply: previewPath,
    }, refused.value);
    expect(create).not.toHaveBeenCalled();
    expect(refused.exits).toEqual([2]);
  });

  it("rejects unsafe request files before service construction", async () => {
    const root = fixture();
    const valid = join(root, "valid.json");
    writeFileSync(valid, JSON.stringify(request({ kind: "relay.draft.save", draft: draftInput() })));
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
      await runRelayMutation(create, "relay.draft.save", path, { json: true }, output.value);
      expect(create).not.toHaveBeenCalled();
      expect(output.exits).toEqual([2]);
    }
  });
});

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../contracts/shared.js";
import { MexPortError } from "../../contracts/shared.js";
import type {
  StoredActivityEvent,
  TeamCurrentActor,
  TeamIdentityActivityCommand,
  TeamIdentityActivityPreviewEnvelope,
  TeamMember,
  TeamWorkflowResult,
} from "../../contracts/workflow.js";
import { buildActivityCommand, buildMemberCommand } from "../builder.js";
import {
  runActivityList,
  runMemberList,
  runTeamMutation,
  type TeamCommandIo,
} from "../commands.js";
import { TEAM_CLI_EXIT } from "../envelope.js";
import { projectActivity } from "../projections.js";
import type { TeamIdentityActivityCliService } from "../service.js";

const MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_ID = "event_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVISION = "a".repeat(64);

describe("Team CLI commands", () => {
  it("projects bounded member pages deterministically", async () => {
    const service = fakeService();
    const output = captureIo();
    await runMemberList(service, { json: true, active: true, limit: "10" }, output.io);

    expect(service.listMembers).toHaveBeenCalledWith({ active: true, limit: 10 });
    expect(output.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);
    expect(JSON.parse(output.lines[0]!)).toMatchObject({
      schemaVersion: 1,
      command: "member.list",
      mode: "read",
      ok: true,
      data: {
        items: [{ id: MEMBER_ID, displayName: "Ada Lovelace", active: true }],
        nextCursor: null,
      },
      problem: null,
    });
  });

  it("projects Activity provenance without inventing it for schema-v1 events", () => {
    const historical = activityFixture();
    if (historical.schemaVersion !== 1) throw new Error("Expected schema-v1 fixture.");
    expect(projectActivity(historical)).toMatchObject({
      schemaVersion: 1,
      recordOrigin: { kind: "unknown" },
      label: null,
    });
    const {
      schemaVersion: _schemaVersion,
      sourcePath: _sourcePath,
      revision: _revision,
      ...common
    } = historical;
    expect(projectActivity({
      schemaVersion: 2,
      ...common,
      origin: { kind: "workflow", operation: "member.add" },
      label: "Ada Lovelace",
    })).toMatchObject({
      schemaVersion: 2,
      recordOrigin: { kind: "workflow", operation: "member.add" },
      label: "Ada Lovelace",
    });
  });

  it("previews by default, then applies only the exact emitted envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-team-cli-roundtrip-"));
    const requestPath = join(root, "request.json");
    writeFileSync(requestPath, JSON.stringify(memberAddRequest()));
    const before = readdirSync(root);
    const service = fakeService();
    const previewOutput = captureIo();

    await runTeamMutation(
      service,
      "member.add",
      requestPath,
      { json: true },
      previewOutput.io,
    );

    expect(service.previewIdentityActivity).toHaveBeenCalledTimes(1);
    expect(service.applyIdentityActivity).not.toHaveBeenCalled();
    expect(previewOutput.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);
    expect(readdirSync(root)).toEqual(before);
    expect(JSON.parse(previewOutput.lines[0]!)).toMatchObject({
      command: "member.add",
      mode: "preview",
      ok: true,
      data: { schemaVersion: 1, request: memberAddRequest() },
    });

    const previewPath = join(root, "approved-preview.json");
    writeFileSync(previewPath, previewOutput.lines[0]!);
    const applyOutput = captureIo();
    await runTeamMutation(
      service,
      "member.add",
      undefined,
      { json: true, apply: previewPath },
      applyOutput.io,
    );

    expect(service.previewIdentityActivity).toHaveBeenCalledTimes(1);
    expect(service.applyIdentityActivity).toHaveBeenCalledTimes(1);
    expect(service.applyIdentityActivity).toHaveBeenCalledWith(previewFixture());
    expect(applyOutput.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);
    expect(JSON.parse(applyOutput.lines[0]!)).toMatchObject({
      command: "member.add",
      mode: "apply",
      ok: true,
      data: { operationId: "member-add-001", applied: true },
    });
  });

  it("rejects malformed intent before the preview service and uses exit 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-team-cli-forgery-"));
    const path = join(root, "request.json");
    writeFileSync(path, JSON.stringify({
      ...memberAddRequest(),
      occurredAt: "2026-08-27T00:00:00.000Z",
    }));
    const service = fakeService();
    const output = captureIo();

    await runTeamMutation(service, "member.add", path, { json: true }, output.io);

    expect(service.previewIdentityActivity).not.toHaveBeenCalled();
    expect(service.applyIdentityActivity).not.toHaveBeenCalled();
    expect(output.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);
    expect(JSON.parse(output.lines[0]!)).toMatchObject({
      ok: false,
      data: null,
      problem: { code: "INVALID_REQUEST" },
    });
  });

  it("maps service precondition failures to exit 4 without leaking raw errors", async () => {
    const service = fakeService();
    service.listActivity.mockRejectedValueOnce(new MexPortError({
      title: "Cursor moved",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "Restart pagination.",
    }));
    const output = captureIo();
    await runActivityList(service, { json: true }, output.io);
    expect(output.exitCodes).toEqual([TEAM_CLI_EXIT.conflict]);
    expect(JSON.parse(output.lines[0]!)).toMatchObject({
      problem: { code: "REVISION_CONFLICT", detail: "Restart pagination." },
    });
  });

  it("rejects conflicting filters and over-limit pages before reads", async () => {
    const service = fakeService();
    const conflict = captureIo();
    await runMemberList(service, { json: true, active: true, inactive: true }, conflict.io);
    expect(conflict.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);
    expect(service.listMembers).not.toHaveBeenCalled();

    const overLimit = captureIo();
    await runActivityList(service, { json: true, limit: 101 }, overLimit.io);
    expect(overLimit.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);
    expect(service.listActivity).not.toHaveBeenCalled();
  });

  it("builds only the isolated Checkpoint C command surface", () => {
    const service = fakeService();
    const output = captureIo();
    const member = buildMemberCommand({ service: () => service, io: output.io });
    const activity = buildActivityCommand({ service: () => service, io: output.io });
    expect(member.commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "current",
      "add",
      "update",
      "deactivate",
      "reactivate",
      "select",
    ]);
    expect(activity.commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "record",
    ]);
  });
});

function captureIo(): { io: TeamCommandIo; lines: string[]; exitCodes: number[] } {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  return {
    lines,
    exitCodes,
    io: {
      write: (line) => lines.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
  };
}

function fakeService(): TeamIdentityActivityCliService & {
  listMembers: ReturnType<typeof vi.fn>;
  listActivity: ReturnType<typeof vi.fn>;
  previewIdentityActivity: ReturnType<typeof vi.fn>;
  applyIdentityActivity: ReturnType<typeof vi.fn>;
} {
  const member = memberFixture();
  const activity = activityFixture();
  return {
    getMember: vi.fn(async () => member),
    listMembers: vi.fn(async () => ({
      items: [member],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: REVISION,
      diagnostics: [],
    })),
    getCurrentActor: vi.fn(async () => ({
      actor: { kind: "member", memberId: MEMBER_ID, displayName: "Ada Lovelace" },
      source: "configured-member",
      selection: {
        memberId: MEMBER_ID,
        updatedAt: "2026-08-27T00:00:00.000Z",
        revision: REVISION,
      },
      diagnostics: [],
    } satisfies TeamCurrentActor)),
    getActivity: vi.fn(async () => activity),
    listActivity: vi.fn(async () => ({
      items: [activity],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: REVISION,
      diagnostics: [],
    })),
    previewIdentityActivity: vi.fn(async () => previewFixture()),
    applyIdentityActivity: vi.fn(async () => applyFixture()),
  };
}

function memberFixture(): TeamMember {
  return {
    schemaVersion: 1,
    ref: { id: MEMBER_ID, kind: "member", title: "Ada Lovelace" },
    kind: "member",
    sourcePath: `.mex/team/members/${MEMBER_ID}.md`,
    revision: REVISION,
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada", email: "ada@example.com" }],
    active: true,
  };
}

function activityFixture(): StoredActivityEvent {
  return {
    schemaVersion: 1,
    id: EVENT_ID,
    timestamp: "2026-08-27T00:00:00.000Z",
    actor: { kind: "unknown" },
    action: "member.added",
    subjects: [{ kind: "entity", entity: { id: MEMBER_ID, kind: "member" } }],
    repoState: {
      branch: "codex/team-identity-workbench",
      head: "b".repeat(40),
      dirty: false,
      observedAt: "2026-08-27T00:00:00.000Z",
    },
    sourcePath: `.mex/events/activity/2026-08/${EVENT_ID}.md`,
    revision: REVISION,
  };
}

function memberAddRequest(): TeamIdentityActivityCommand {
  return {
    operationId: "member-add-001",
    action: {
      kind: "member.add",
      member: {
        displayName: "Ada Lovelace",
        gitAliases: [{ name: "Ada", email: "ada@example.com" }],
      },
    },
    expectedRevisions: [],
  };
}

function previewFixture(): TeamIdentityActivityPreviewEnvelope {
  return {
    schemaVersion: 1,
    request: memberAddRequest(),
    preview: {
      valid: true,
      scope: "canonical",
      changes: [],
      localChanges: [],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: "2026-08-27T00:00:00.000Z",
        repoState: {
          branch: "codex/team-identity-workbench",
          head: "b".repeat(40),
          dirty: false,
          observedAt: "2026-08-27T00:00:00.000Z",
        },
      },
      purposeIds: [{ purpose: "member", id: MEMBER_ID }],
      requestRevision: REVISION,
      presentationRevision: "b".repeat(64),
      previewRevision: "c".repeat(64),
    },
  };
}

function applyFixture(): TeamWorkflowResult<JsonValue> {
  return {
    operationId: "member-add-001",
    previewRevision: "c".repeat(64),
    applied: true,
    idempotentReplay: false,
    changes: [],
    localChanges: [],
    artifacts: [memberFixture()],
    events: [activityFixture()],
  };
}

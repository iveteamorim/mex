import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  TeamWorkstreamCommand,
  TeamWorkstreamPreviewEnvelope,
  TeamWorkflowResult,
  Workstream,
} from "../../contracts/workflow.js";
import { buildWorkstreamCommand } from "../builder.js";
import {
  runWorkstreamList,
  runWorkstreamMutation,
  type TeamCommandIo,
} from "../commands.js";
import { TEAM_CLI_EXIT } from "../envelope.js";
import type { TeamWorkstreamCliService } from "../service.js";

const WORKSTREAM_ID = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_ID = "event_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVISION = "a".repeat(64);

describe("Workstream CLI commands", () => {
  it("projects a bounded, lifecycle-filtered page", async () => {
    const service = fakeService();
    const output = captureIo();
    await runWorkstreamList(
      service,
      { json: true, state: ["active", "blocked", "active"], limit: "10" },
      output.io,
    );

    expect(service.listWorkstreams).toHaveBeenCalledWith({
      states: ["active", "blocked"],
      limit: 10,
    });
    expect(output.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);
    expect(JSON.parse(output.lines[0]!)).toMatchObject({
      command: "workstream.list",
      mode: "read",
      ok: true,
      data: {
        items: [{ id: WORKSTREAM_ID, state: "active", title: "Checkpoint D" }],
        nextCursor: null,
      },
    });
  });

  it("round-trips only the exact complete create preview", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-workstream-cli-"));
    const requestPath = join(root, "create.json");
    writeFileSync(requestPath, JSON.stringify(createRequest()));
    const service = fakeService();
    const previewOutput = captureIo();

    await runWorkstreamMutation(
      service,
      "workstream.create",
      requestPath,
      { json: true },
      previewOutput.io,
    );
    expect(service.previewWorkstream).toHaveBeenCalledWith(createRequest());
    expect(service.applyWorkstream).not.toHaveBeenCalled();
    expect(previewOutput.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);

    const previewPath = join(root, "preview.json");
    writeFileSync(previewPath, previewOutput.lines[0]!);
    const applyOutput = captureIo();
    await runWorkstreamMutation(
      service,
      "workstream.create",
      undefined,
      { json: true, apply: previewPath },
      applyOutput.io,
    );

    expect(service.applyWorkstream).toHaveBeenCalledWith(previewFixture());
    expect(applyOutput.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);
    expect(JSON.parse(applyOutput.lines[0]!)).toMatchObject({
      command: "workstream.create",
      mode: "apply",
      data: {
        operationId: "workstream-create-001",
        applied: true,
        workstreams: [{ id: WORKSTREAM_ID }],
        events: [{ id: EVENT_ID }],
      },
    });
  });

  it("rejects invalid states and caller-owned lifecycle fields before the service", async () => {
    const service = fakeService();
    const invalidState = captureIo();
    await runWorkstreamList(service, { json: true, state: "paused" }, invalidState.io);
    expect(invalidState.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);
    expect(service.listWorkstreams).not.toHaveBeenCalled();

    const root = mkdtempSync(join(tmpdir(), "mex-workstream-forgery-"));
    const path = join(root, "forged.json");
    writeFileSync(path, JSON.stringify({
      ...createRequest(),
      action: {
        ...createRequest().action,
        workstream: {
          ...createRequest().action.workstream,
          state: "active",
        },
      },
    }));
    const forged = captureIo();
    await runWorkstreamMutation(service, "workstream.create", path, { json: true }, forged.io);
    expect(forged.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);

    const archivedUpdatePath = join(root, "archived-update.json");
    writeFileSync(archivedUpdatePath, JSON.stringify({
      operationId: "workstream-update-archived",
      action: {
        kind: "workstream.update",
        workstreamId: WORKSTREAM_ID,
        patch: { state: "archived" },
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: `.mex/workstreams/${WORKSTREAM_ID}.md` },
        revision: REVISION,
      }],
    }));
    const archivedUpdate = captureIo();
    await runWorkstreamMutation(
      service,
      "workstream.update",
      archivedUpdatePath,
      { json: true },
      archivedUpdate.io,
    );
    expect(archivedUpdate.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);

    const emptyGitActorPath = join(root, "empty-git-actor.json");
    writeFileSync(emptyGitActorPath, JSON.stringify({
      ...createRequest(),
      action: {
        kind: "workstream.create",
        workstream: {
          ...createRequest().action.workstream,
          owners: [{ kind: "git", name: null, email: null }],
        },
      },
    }));
    const emptyGitActor = captureIo();
    await runWorkstreamMutation(
      service,
      "workstream.create",
      emptyGitActorPath,
      { json: true },
      emptyGitActor.io,
    );
    expect(emptyGitActor.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);
    expect(service.previewWorkstream).not.toHaveBeenCalled();
  });

  it("builds only the requested D command family", () => {
    const service = fakeService();
    const command = buildWorkstreamCommand({ service: () => service, io: captureIo().io });
    expect(command.commands.map((child) => child.name())).toEqual([
      "list",
      "show",
      "create",
      "update",
      "archive",
    ]);
  });
});

function fakeService(): TeamWorkstreamCliService & {
  listWorkstreams: ReturnType<typeof vi.fn>;
  previewWorkstream: ReturnType<typeof vi.fn>;
  applyWorkstream: ReturnType<typeof vi.fn>;
} {
  const workstream = workstreamFixture();
  return {
    getWorkstream: vi.fn(async () => workstream),
    listWorkstreams: vi.fn(async () => ({
      items: [workstream],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: REVISION,
      diagnostics: [],
    })),
    previewWorkstream: vi.fn(async () => previewFixture()),
    applyWorkstream: vi.fn(async () => applyFixture()),
  };
}

function workstreamFixture(): Workstream {
  return {
    schemaVersion: 1,
    ref: { id: WORKSTREAM_ID, kind: "workstream", title: "Checkpoint D" },
    kind: "workstream",
    sourcePath: `.mex/workstreams/${WORKSTREAM_ID}.md`,
    revision: REVISION,
    entityRevision: 2,
    title: "Checkpoint D",
    goal: "Ship Workstreams safely",
    summary: "A bounded canonical Workstream.",
    state: "active",
    owners: [{ kind: "unknown" }],
    contributors: [],
    paths: [],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Implementation",
    nextMilestone: "Review",
    createdBy: { kind: "unknown" },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedBy: { kind: "unknown" },
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function createRequest(): Extract<
  TeamWorkstreamCommand,
  { action: { kind: "workstream.create" } }
> {
  return {
    operationId: "workstream-create-001",
    action: {
      kind: "workstream.create",
      workstream: {
        title: "Checkpoint D",
        goal: "Ship Workstreams safely",
        summary: "A bounded canonical Workstream.",
        owners: [{ kind: "unknown" }],
        nextMilestone: "Review",
      },
    },
    expectedRevisions: [],
  };
}

function previewFixture(): TeamWorkstreamPreviewEnvelope {
  return {
    schemaVersion: 1,
    request: createRequest(),
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
        occurredAt: "2026-08-28T00:00:00.000Z",
        repoState: {
          branch: "codex/team-workstreams",
          head: "b".repeat(40),
          dirty: false,
          observedAt: "2026-08-28T00:00:00.000Z",
        },
      },
      purposeIds: [
        { purpose: "activity", id: EVENT_ID },
        { purpose: "workstream", id: WORKSTREAM_ID },
      ],
      requestRevision: REVISION,
      presentationRevision: "b".repeat(64),
      previewRevision: "c".repeat(64),
    },
  };
}

function applyFixture(): TeamWorkflowResult<never> {
  return {
    operationId: "workstream-create-001",
    previewRevision: "c".repeat(64),
    applied: true,
    idempotentReplay: false,
    changes: [],
    localChanges: [],
    artifacts: [workstreamFixture()],
    events: [{
      schemaVersion: 1,
      id: EVENT_ID,
      timestamp: "2026-08-28T00:00:00.000Z",
      actor: { kind: "unknown" },
      action: "workstream.created",
      subjects: [{
        kind: "entity",
        entity: { id: WORKSTREAM_ID, kind: "workstream", title: "Checkpoint D" },
      }],
      workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Checkpoint D" },
      repoState: {
        branch: "codex/team-workstreams",
        head: "b".repeat(40),
        dirty: false,
        observedAt: "2026-08-28T00:00:00.000Z",
      },
    }],
  };
}

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

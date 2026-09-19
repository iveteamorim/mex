import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateArtifactId } from "../../artifacts/ulid.js";
import type {
  GitChangedFilesRequest,
  GitDiffRequest,
  GitFileAtRevisionRequest,
  GitHistoryRequest,
  GitPort,
} from "../../contracts/git.js";
import type {
  JsonValue,
  RepoState,
  RevisionExpectation,
} from "../../contracts/shared.js";
import type {
  TeamWorkstreamCommand,
  TeamWorkstreamPreviewEnvelope,
  Workstream,
} from "../../contracts/workflow.js";
import type { WikiPort } from "../../contracts/wiki.js";
import { MockWikiPort } from "../../testing/wiki/mock-wiki-port.js";
import {
  createRepositoryTeamWorkflowPortWithDependencies,
  type RepositoryTeamWorkflowPort,
  type RepositoryTeamWorkflowPortOptions,
  WorkflowPhaseInterruption,
} from "../repository-team-workflow-port.js";

const CREATED_AT = "2026-08-28T03:00:00.000Z";
const UPDATED_AT = "2026-08-28T03:05:00.000Z";
const HEAD = "1".repeat(40);
const WORKSTREAM_IDS = [id("ws", 1), id("ws", 2)] as const;
const EVENT_IDS = [id("event", 3), id("event", 4), id("event", 5), id("event", 6)] as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("RepositoryTeamWorkflowPort Workstream contract", () => {
  it("applies a serialized signed create in a fresh process with service authority and one Activity", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const previewer = port(root, git, {
      workstreamIds: [WORKSTREAM_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    });

    const envelope = await previewer.previewWorkstream(
      createCommand("workstream_portable_create"),
    );

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      request: { operationId: "workstream_portable_create" },
      preview: { valid: true, scope: "canonical" },
      receipt: {
        authority: {
          actor: { kind: "git", name: "Ada", email: "ada@example.test" },
          occurredAt: CREATED_AT,
          repoState: git.state,
        },
        purposeIds: [
          { purpose: "activity", id: EVENT_IDS[0] },
          { purpose: "workstream", id: WORKSTREAM_IDS[0] },
        ],
      },
    });
    expect(envelope.preview.changes).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(existsSync(join(root, ".mex/local/team.db"))).toBe(false);
    expect(existsSync(join(root, ".mex/workstreams"))).toBe(false);
    expect(existsSync(join(root, ".mex/events/activity"))).toBe(false);

    const applier = port(root, git, {
      workstreamIds: [failId("ws")],
      eventIds: [failId("event")],
      pid: 102,
    });
    const result = await applier.applyWorkstream(jsonRoundTrip(envelope));

    expect(result).toMatchObject({
      operationId: "workstream_portable_create",
      applied: true,
      idempotentReplay: false,
      artifacts: [{
        ref: { id: WORKSTREAM_IDS[0], kind: "workstream" },
        state: "planned",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        createdBy: envelope.receipt.authority.actor,
        updatedBy: envelope.receipt.authority.actor,
      }],
      events: [{
        id: EVENT_IDS[0],
        action: "workstream.created",
        actor: envelope.receipt.authority.actor,
        timestamp: CREATED_AT,
      }],
    });
    expect(result.events).toHaveLength(1);
    expect(activityFiles(root)).toEqual([`${EVENT_IDS[0]}.md`]);
    await expect(applier.getActivity(EVENT_IDS[0])).resolves.toMatchObject({
      schemaVersion: 2,
      action: "workstream.created",
      origin: { kind: "workflow", operation: "workstream.create" },
      label: "Human-team release",
    });
  });

  it("enforces exact revisions, lifecycle transitions, and real blockers without failed writes", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const created = await applyCreate(root, git);
    const baselineBytes = readFileSync(join(root, created.sourcePath));
    const updater = port(root, git, {
      now: UPDATED_AT,
      eventIds: [EVENT_IDS[1], EVENT_IDS[2]],
    });

    await expect(updater.previewWorkstream(updateCommand(
      "workstream_illegal_planned_done",
      created,
      { state: "done" },
    ))).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    await expect(updater.previewWorkstream(updateCommand(
      "workstream_blocked_without_blocker",
      created,
      { state: "blocked", currentState: "Waiting" },
    ))).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    await expect(updater.previewWorkstream(updateCommand(
      "workstream_semantic_noop",
      created,
      {
        title: created.title,
        goal: created.goal,
        summary: created.summary,
        state: "planned",
        owners: created.owners,
        contributors: created.contributors,
        paths: created.paths,
        code: created.code,
        topics: created.topics,
        components: created.components,
        related: created.related,
        blockers: created.blockers,
        currentState: created.currentState,
        nextMilestone: created.nextMilestone,
      },
    ))).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    await expect(updater.previewWorkstream(updateCommand(
      "workstream_normalized_noop",
      created,
      { paths: [...created.paths].reverse() },
    ))).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    await expect(updater.previewWorkstream({
      ...updateCommand(
        "workstream_missing_expectation",
        created,
        { state: "active", currentState: "In flight" },
      ),
      expectedRevisions: [],
    } as unknown as TeamWorkstreamCommand)).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    expect(readFileSync(join(root, created.sourcePath))).toEqual(baselineBytes);
    expect(activityFiles(root)).toEqual([`${EVENT_IDS[0]}.md`]);

    const activeResult = await updater.applyWorkstream(
      await updater.previewWorkstream(updateCommand(
        "workstream_activate",
        created,
        { state: "active", currentState: "In flight" },
      )),
    );
    const active = activeResult.artifacts[0] as Workstream;
    expect(active.state).toBe("active");
    expect(active.entityRevision).toBe(2);
    expect(activeResult.events).toHaveLength(1);

    await expect(updater.previewWorkstream(updateCommand(
      "workstream_stale_update",
      created,
      { summary: "Stale update" },
    ))).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

    const blockedResult = await updater.applyWorkstream(
      await updater.previewWorkstream(updateCommand(
        "workstream_block",
        active,
        {
          state: "blocked",
          blockers: ["Awaiting security review"],
          currentState: "Blocked on security review",
        },
      )),
    );
    expect(blockedResult.artifacts[0]).toMatchObject({
      state: "blocked",
      blockers: ["Awaiting security review"],
      entityRevision: 3,
    });
    expect(blockedResult.events).toHaveLength(1);
    expect(activityFiles(root)).toEqual([
      `${EVENT_IDS[0]}.md`,
      `${EVENT_IDS[1]}.md`,
      `${EVENT_IDS[2]}.md`,
    ]);
  });

  it("archives one-way while preserving canonical fields, links, and Git-visible history", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const created = await applyCreate(root, git, richCreateCommand(
      "workstream_archive_seed",
    ));
    const service = port(root, git, {
      now: UPDATED_AT,
      eventIds: [EVENT_IDS[1]],
    });
    const beforeDocument = readFileSync(join(root, created.sourcePath), "utf8");
    const envelope = await service.previewWorkstream({
      operationId: "workstream_archive",
      action: { kind: "workstream.archive", workstreamId: created.ref.id },
      expectedRevisions: expectation(created),
    });
    const result = await service.applyWorkstream(envelope);
    const archived = result.artifacts[0] as Workstream;

    expect(archived).toMatchObject({
      state: "archived",
      entityRevision: 2,
      title: created.title,
      goal: created.goal,
      summary: created.summary,
      owners: created.owners,
      contributors: created.contributors,
      paths: created.paths,
      code: created.code,
      topics: created.topics,
      components: created.components,
      related: created.related,
      blockers: created.blockers,
      currentState: created.currentState,
      nextMilestone: created.nextMilestone,
      createdBy: created.createdBy,
      createdAt: created.createdAt,
      updatedAt: UPDATED_AT,
    });
    expect(readFileSync(join(root, archived.sourcePath), "utf8"))
      .not.toBe(beforeDocument);
    expect((await service.listWorkstreams()).items).toEqual([]);
    expect((await service.listWorkstreams({ includeArchived: true })).items)
      .toEqual([archived]);
    expect((await service.listWorkstreams({ states: ["archived"] })).items)
      .toEqual([archived]);
    await expect(service.previewWorkstream(updateCommand(
      "workstream_unarchive",
      archived,
      { state: "active", blockers: [] },
    ))).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(result.events).toEqual([
      expect.objectContaining({ action: "workstream.archived" }),
    ]);
  });

  it("archives a blocked Workstream by retiring its blocker state", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const created = await applyCreate(root, git);
    const service = port(root, git, {
      now: UPDATED_AT,
      eventIds: [EVENT_IDS[1], EVENT_IDS[2], EVENT_IDS[3]],
    });
    const activated = (await service.applyWorkstream(
      await service.previewWorkstream(updateCommand(
        "workstream_blocked_archive_activate",
        created,
        { state: "active", currentState: "In flight" },
      )),
    )).artifacts[0] as Workstream;
    const blocked = (await service.applyWorkstream(
      await service.previewWorkstream(updateCommand(
        "workstream_blocked_archive_block",
        activated,
        {
          state: "blocked",
          blockers: ["Waiting for a reviewed dependency"],
          currentState: "Waiting",
        },
      )),
    )).artifacts[0] as Workstream;

    const result = await service.applyWorkstream(await service.previewWorkstream({
      operationId: "workstream_blocked_archive",
      action: { kind: "workstream.archive", workstreamId: blocked.ref.id },
      expectedRevisions: expectation(blocked),
    }));

    expect(result.artifacts[0]).toMatchObject({
      state: "archived",
      blockers: [],
      currentState: "Waiting",
      entityRevision: 4,
    });
    expect(result.events).toEqual([
      expect.objectContaining({ action: "workstream.archived" }),
    ]);
  });

  it("supports exact journal replay and rejects altered operation-ID reuse and envelope tampering", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const first = port(root, git, {
      workstreamIds: [WORKSTREAM_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    });
    const envelope = await first.previewWorkstream(
      createCommand("workstream_exact_replay"),
    );
    await first.applyWorkstream(envelope);

    const replay = await port(root, git, { pid: 202 })
      .applyWorkstream(jsonRoundTrip(envelope));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.events).toHaveLength(1);
    expect(activityFiles(root)).toEqual([`${EVENT_IDS[0]}.md`]);

    const alteredRequest = createCommand("workstream_exact_replay");
    if (alteredRequest.action.kind !== "workstream.create") {
      throw new Error("Test invariant: create action expected.");
    }
    const altered = await port(root, git, {
      workstreamIds: [WORKSTREAM_IDS[1]],
      eventIds: [EVENT_IDS[1]],
      pid: 203,
    }).previewWorkstream({
      ...alteredRequest,
      action: {
        kind: "workstream.create",
        workstream: {
          ...alteredRequest.action.workstream,
          title: "Altered operation reuse",
        },
      },
    });
    await expect(port(root, git, { pid: 204 }).applyWorkstream(altered))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

    const tampered = jsonRoundTrip(envelope) as any;
    tampered.preview.scope = "local";
    await expect(port(root, git, { pid: 205 }).applyWorkstream(tampered))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(activityFiles(root)).toEqual([`${EVENT_IDS[0]}.md`]);
  });

  it("recovers a signed Workstream after canonical publication without duplicating Activity", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const envelope = await port(root, git, {
      workstreamIds: [WORKSTREAM_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    }).previewWorkstream(createCommand("workstream_phase_recovery"));
    const interrupted = port(root, git, {
      pid: 301,
      phaseHook: (boundary) => {
        if (boundary === "after-canonical-publication") {
          throw new WorkflowPhaseInterruption(boundary);
        }
      },
    });

    await expect(interrupted.applyWorkstream(envelope))
      .rejects.toBeInstanceOf(WorkflowPhaseInterruption);
    expect(await interrupted.getWorkstream(WORKSTREAM_IDS[0])).not.toBeNull();
    expect(activityFiles(root)).toEqual([]);

    const recovered = await port(root, git, { pid: 302 })
      .applyWorkstream(jsonRoundTrip(envelope));
    expect(recovered.idempotentReplay).toBe(true);
    expect(recovered.events).toEqual([
      expect.objectContaining({
        id: EVENT_IDS[0],
        action: "workstream.created",
      }),
    ]);
    expect(activityFiles(root)).toEqual([`${EVENT_IDS[0]}.md`]);
  });

  it("keeps reads and rejected previews nonmutating and converges canonical bytes in a second clone", async () => {
    const source = temporaryRoot();
    const clone = temporaryRoot();
    const git = fakeGit();
    const reader = port(source, git);

    expect(await reader.getWorkstream(WORKSTREAM_IDS[0])).toBeNull();
    expect((await reader.listWorkstreams()).items).toEqual([]);
    await expect(reader.listWorkstreams({ limit: 101 })).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
    await expect(reader.listWorkstreams({
      cursor: "x".repeat(4 * 1024 + 1),
    })).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    const oversized = createCommand("workstream_oversized");
    if (oversized.action.kind !== "workstream.create") {
      throw new Error("Test invariant: create action expected.");
    }
    await expect(reader.previewWorkstream({
      ...oversized,
      action: {
        kind: "workstream.create",
        workstream: {
          ...oversized.action.workstream,
          summary: "x".repeat(70 * 1024),
        },
      },
    })).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    expect(existsSync(join(source, ".mex"))).toBe(false);

    const created = await applyCreate(source, git);
    const target = join(clone, created.sourcePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(source, created.sourcePath)));

    const cloneReader = port(clone, fakeGit());
    expect(await cloneReader.getWorkstream(created.ref.id)).toEqual(created);
    expect((await cloneReader.listWorkstreams()).items).toEqual([created]);
    expect(existsSync(join(clone, ".mex/local"))).toBe(false);
  });
});

interface FakeGit extends GitPort {
  state: RepoState;
}

function port(
  root: string,
  git: FakeGit,
  options: {
    now?: string;
    pid?: number;
    workstreamIds?: readonly string[];
    eventIds?: readonly string[];
    phaseHook?: RepositoryTeamWorkflowPortOptions<JsonValue>["phaseHook"];
  } = {},
): RepositoryTeamWorkflowPort<JsonValue, unknown> {
  return createRepositoryTeamWorkflowPortWithDependencies(root, {
    scaffoldId: "workstream_contract_scaffold",
    wiki: new MockWikiPort({
      now: () => options.now ?? CREATED_AT,
    }) as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
    git,
    now: () => new Date(options.now ?? CREATED_AT),
    pid: options.pid ?? 101,
    processStatus: () => "dead",
    phaseHook: options.phaseHook,
    idFactories: {
      workstream: queue(options.workstreamIds ?? []),
      activity: queue(options.eventIds ?? []),
      leaseToken: () => "a".repeat(64),
    },
  });
}

async function applyCreate(
  root: string,
  git: FakeGit,
  command: TeamWorkstreamCommand = createCommand("workstream_seed"),
): Promise<Workstream> {
  const service = port(root, git, {
    workstreamIds: [WORKSTREAM_IDS[0]],
    eventIds: [EVENT_IDS[0]],
  });
  const result = await service.applyWorkstream(
    await service.previewWorkstream(command),
  );
  return result.artifacts[0] as Workstream;
}

function createCommand(operationId: string): TeamWorkstreamCommand {
  return {
    operationId,
    action: {
      kind: "workstream.create",
      workstream: {
        title: "Human-team release",
        goal: "Coordinate the release through explicit shared state.",
        summary: "Checkpoint D Workstream.",
        owners: [{ kind: "unknown" }],
        paths: ["src/team", "docs"],
        nextMilestone: "Complete Workstream conformance.",
      },
    },
    expectedRevisions: [],
  };
}

function richCreateCommand(operationId: string): TeamWorkstreamCommand {
  return {
    operationId,
    action: {
      kind: "workstream.create",
      workstream: {
        title: "Human-team release",
        goal: "Coordinate the release through explicit shared state.",
        summary: "Checkpoint D Workstream.",
        owners: [{ kind: "unknown" }],
        contributors: [{ kind: "git", name: "Grace", email: "grace@example.test" }],
        paths: ["src/team"],
        code: [{ kind: "file", path: "src/team/workflow/repository-team-workflow-port.ts" }],
        topics: [{ kind: "topic", id: "topic_team_memory" }],
        components: [{ kind: "component", id: "component_workflow" }],
        related: [{ kind: "spec", id: "spec_checkpoint_d" }],
        nextMilestone: "Complete Workstream conformance.",
      },
    },
    expectedRevisions: [],
  };
}

function updateCommand(
  operationId: string,
  workstream: Workstream,
  patch: Extract<
    TeamWorkstreamCommand["action"],
    { kind: "workstream.update" }
  >["patch"],
): TeamWorkstreamCommand {
  return {
    operationId,
    action: {
      kind: "workstream.update",
      workstreamId: workstream.ref.id,
      patch,
    },
    expectedRevisions: expectation(workstream),
  };
}

function expectation(workstream: Workstream): readonly [RevisionExpectation] {
  return [{
    target: { kind: "artifact", path: workstream.sourcePath },
    revision: workstream.revision,
  }];
}

function fakeGit(): FakeGit {
  const git: FakeGit = {
    state: {
      branch: "feature/team-workstreams",
      head: HEAD,
      dirty: false,
      observedAt: CREATED_AT,
    },
    async getRepoState() { return structuredClone(git.state); },
    async getIdentity() { return { name: "Ada", email: "ada@example.test" }; },
    async getWorkingTree() { return { items: [], nextCursor: null, truncated: false }; },
    async resolveRevision(ref: string) { return ref; },
    async getDiff(request: GitDiffRequest) {
      return { target: request.target, diff: "", bytes: 0, truncated: false };
    },
    async getHistory(_request?: GitHistoryRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
    async readFileAtRevision(_request: GitFileAtRevisionRequest) { return null; },
    async getChangedFiles(_request: GitChangedFilesRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
  };
  return git;
}

function queue(values: readonly string[]): () => string {
  let offset = 0;
  return () => {
    const value = values[offset];
    if (value === undefined) throw new Error("Unexpected generated ID.");
    offset += 1;
    return value;
  };
}

function jsonRoundTrip(
  envelope: TeamWorkstreamPreviewEnvelope,
): TeamWorkstreamPreviewEnvelope {
  return JSON.parse(JSON.stringify(envelope)) as TeamWorkstreamPreviewEnvelope;
}

function activityFiles(root: string): readonly string[] {
  const directory = join(root, ".mex/events/activity", CREATED_AT.slice(0, 7));
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-team-workstreams-"));
  roots.push(root);
  return root;
}

function id(prefix: "ws" | "event", entropy: number): string {
  return generateArtifactId(prefix, {
    now: Date.parse(CREATED_AT),
    random: new Uint8Array(10).fill(entropy),
  });
}

function failId(prefix: "ws" | "event"): string {
  return `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5FZZ`;
}

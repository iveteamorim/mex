import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as repositoryGit from "../../git/git-port.js";
import { generateArtifactId } from "../../artifacts/ulid.js";
import type {
  GitChangedFilesRequest,
  GitDiffRequest,
  GitFileAtRevisionRequest,
  GitHistoryRequest,
  GitPort,
} from "../../contracts/git.js";
import type { JsonValue, RepoState } from "../../contracts/shared.js";
import type { TeamWorkflowCommand } from "../../contracts/workflow.js";
import type { WikiPort } from "../../contracts/wiki.js";
import { MockWikiPort } from "../../testing/wiki/mock-wiki-port.js";
import {
  createRepositoryTeamWorkflowPort,
  createRepositoryTeamWorkflowPortWithDependencies,
  RepositoryTeamWorkflowPort,
  type RepositoryTeamWorkflowPortOptions,
  WorkflowPhaseInterruption,
} from "../repository-team-workflow-port.js";

const NOW = "2026-08-27T04:05:06.000Z";
const HEAD = "1".repeat(40);
const WORKSTREAM_ID = artifactId("ws", 1);
const PROPOSAL_ID = artifactId("proposal", 7);
const MEMBER_IDS = [artifactId("member", 2), artifactId("member", 3)] as const;
const EVENT_IDS = [
  artifactId("event", 4),
  artifactId("event", 5),
  artifactId("event", 6),
] as const;
const LOCAL_DRAFT_ID = "inbox_test_draft";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("RepositoryTeamWorkflowPort", () => {
  it("derives production composition only from a committed scaffold identity", async () => {
    const root = temporaryRoot();
    await expect(createRepositoryTeamWorkflowPort(root)).rejects.toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({ code: "MIGRATION_REQUIRED" }),
      }),
    );
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex/config.json"), JSON.stringify({
      scaffold_id: "tracked-scaffold-identity",
    }), "utf8");
    initializeGitFixture(root);
    writeFileSync(join(root, "README.md"), "# Workflow factory fixture\n", "utf8");
    git(root, ["add", "--", "README.md"]);
    git(root, ["commit", "-q", "-m", "factory fixture baseline"]);

    await expect(createRepositoryTeamWorkflowPort(root)).rejects.toMatchObject({
      problem: { code: "MIGRATION_REQUIRED" },
    });

    git(root, ["add", "--", ".mex/config.json"]);
    git(root, ["commit", "-q", "-m", "track scaffold identity"]);

    const first = await createRepositoryTeamWorkflowPort(root);
    const second = await createRepositoryTeamWorkflowPort(root);
    expect(first).toBeInstanceOf(RepositoryTeamWorkflowPort);
    expect(second).toBeInstanceOf(RepositoryTeamWorkflowPort);
    expect(existsSync(join(root, ".mex/local/team.db"))).toBe(false);

    writeFileSync(join(root, ".mex/config.json"), JSON.stringify({
      scaffold_id: "checkout-only-scaffold-identity",
    }), "utf8");
    await expect(createRepositoryTeamWorkflowPort(root)).rejects.toMatchObject({
      problem: { code: "MIGRATION_REQUIRED" },
    });
  });

  it("accepts the CRLF working copy Git itself writes on checkout", async () => {
    // The defect this test exists for. `core.autocrlf` defaults to true on
    // Windows: Git stores LF and writes CRLF into the working tree, so the
    // working copy and the blob at HEAD differ by one byte per line on a tree
    // Git reports as unmodified. The old check compared the two byte for byte,
    // so the Hub refused to start for **everyone who cloned** — and never for
    // the person who ran `mex setup`, whose working copy Git never rewrote.
    //
    // `git checkout -- <path>` is the one-line way to put a checkout back into
    // the state a clone produces, and is what makes this testable at all.
    const root = temporaryRoot();
    initializeGitFixture(root);
    git(root, ["config", "core.autocrlf", "true"]);
    mkdirSync(join(root, ".mex"), { recursive: true });
    // Multi-line on purpose: a single-line file has no line ending to convert
    // and the defect does not reproduce.
    writeFileSync(
      join(root, ".mex/config.json"),
      `${JSON.stringify({ scaffold_id: "crlf-checkout-scaffold-identity", version: 1 }, null, 2)}\n`,
      "utf8",
    );
    git(root, ["add", "--", ".mex/config.json"]);
    git(root, ["commit", "-q", "-m", "track scaffold identity"]);

    // Let Git write the working copy, exactly as a clone would.
    rmSync(join(root, ".mex/config.json"));
    git(root, ["checkout", "--", ".mex/config.json"]);

    const working = readFileSync(join(root, ".mex/config.json"));
    expect(working.includes(Buffer.from("\r\n"))).toBe(true);
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: root }).toString()).toBe("");
    // The bytes genuinely differ; this is not a test that passes vacuously.
    const blob = execFileSync("git", ["cat-file", "blob", "HEAD:.mex/config.json"], { cwd: root });
    expect(blob.equals(working)).toBe(false);

    expect(await createRepositoryTeamWorkflowPort(root)).toBeInstanceOf(RepositoryTeamWorkflowPort);
  });

  it("still refuses when the identity is absent, unreadable or malformed on either side", async () => {
    // Dropping byte equality must not drop the property. Each of these was
    // rejected before and has to stay rejected.
    const root = temporaryRoot();
    initializeGitFixture(root);
    mkdirSync(join(root, ".mex"), { recursive: true });
    const configPath = join(root, ".mex/config.json");
    const rejects = async () => {
      await expect(createRepositoryTeamWorkflowPort(root)).rejects.toMatchObject({
        problem: { code: "MIGRATION_REQUIRED" },
      });
    };

    // Tracked with no identity at all.
    writeFileSync(configPath, JSON.stringify({ version: 1 }), "utf8");
    git(root, ["add", "--", ".mex/config.json"]);
    git(root, ["commit", "-q", "-m", "no identity"]);
    await rejects();

    // Tracked identity is not a string.
    writeFileSync(configPath, JSON.stringify({ scaffold_id: 7 }), "utf8");
    git(root, ["commit", "-q", "-a", "-m", "numeric identity"]);
    await rejects();

    // Tracked identity carries a control character.
    writeFileSync(configPath, JSON.stringify({ scaffold_id: "bad\u0001id" }), "utf8");
    git(root, ["commit", "-q", "-a", "-m", "control character"]);
    await rejects();

    // Tracked blob is committed and valid, working copy is unparseable.
    writeFileSync(configPath, JSON.stringify({ scaffold_id: "good-identity" }), "utf8");
    git(root, ["commit", "-q", "-a", "-m", "valid identity"]);
    expect(await createRepositoryTeamWorkflowPort(root)).toBeInstanceOf(RepositoryTeamWorkflowPort);
    writeFileSync(configPath, "{ not json", "utf8");
    await rejects();

    // Working copy is valid and committed, but the tracked blob is not JSON.
    git(root, ["checkout", "--", ".mex/config.json"]);
    writeFileSync(configPath, "{ not json", "utf8");
    git(root, ["commit", "-q", "-a", "-m", "unparseable blob"]);
    writeFileSync(configPath, JSON.stringify({ scaffold_id: "good-identity" }), "utf8");
    await rejects();
  });

  it("rejects a CRLF-only config edit between exact production reads", async () => {
    const root = temporaryRoot();
    initializeGitFixture(root);
    git(root, ["config", "core.autocrlf", "true"]);
    mkdirSync(join(root, ".mex"), { recursive: true });
    const path = join(root, ".mex/config.json");
    const original = `${JSON.stringify({ scaffold_id: "config-race" }, null, 2)}\n`;
    writeFileSync(path, original);
    git(root, ["add", "--", ".mex/config.json"]);
    git(root, ["commit", "-q", "-m", "track config"]);
    const createGit = repositoryGit.createRepositoryGitPort;
    vi.spyOn(repositoryGit, "createRepositoryGitPort").mockImplementation((...args) => {
      const port = createGit(...args);
      const read = port.readFileAtRevision.bind(port);
      vi.spyOn(port, "readFileAtRevision").mockImplementation(async (request) => {
        const result = await read(request);
        writeFileSync(path, original.replaceAll("\n", "\r\n"));
        return result;
      });
      return port;
    });
    await expect(createRepositoryTeamWorkflowPort(root)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(readFileSync(path, "utf8")).toBe(original.replaceAll("\n", "\r\n"));
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: root }).toString()).toBe("");
    expect(existsSync(join(root, ".mex/local"))).toBe(false);
  });

  it("captures service-owned actor, time, and repository state in a canonical Workstream and Activity event", async () => {
    const harness = createHarness();
    const command = createWorkstreamCommand("operation_create_workstream");

    const preview = await harness.port.preview(command);
    expect(await harness.port.preview(command)).toEqual(preview);

    expect(preview.command).toEqual({
      ...command,
      authority: {
        actor: { kind: "git", name: "Ada", email: "ada@example.test" },
        occurredAt: NOW,
        repoState: harness.git.state,
      },
    });
    expect(preview.scope).toBe("canonical");
    expect(preview.changes).toHaveLength(2);
    expect(existsSync(join(harness.root, ".mex/team/workstreams"))).toBe(false);
    expect(existsSync(join(harness.root, ".mex/events/activity"))).toBe(false);

    const result = await harness.port.apply({
      command: preview.command,
      expectedPreviewRevision: preview.previewRevision,
    });

    expect(result).toMatchObject({
      operationId: command.operationId,
      applied: true,
      idempotentReplay: false,
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      ref: { id: WORKSTREAM_ID, kind: "workstream" },
      createdBy: preview.command.authority.actor,
      updatedBy: preview.command.authority.actor,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        id: EVENT_IDS[0],
        timestamp: NOW,
        actor: preview.command.authority.actor,
        action: "workstream.created",
        repoState: harness.git.state,
        workstream: expect.objectContaining({ id: WORKSTREAM_ID }),
      }),
    ]);
    expect(existsSync(join(harness.root, preview.changes[0]!.path))).toBe(true);
    expect(existsSync(join(harness.root, preview.changes[1]!.path))).toBe(true);
  });

  it("rejects caller-owned authority, forged prepared authority, and forged preview revisions without writes", async () => {
    const harness = createHarness();
    const command = createWorkstreamCommand("operation_reject_forgery");
    const callerOwned = {
      ...command,
      actor: { kind: "unknown" },
      occurredAt: "2000-01-01T00:00:00.000Z",
      repoState: { branch: null, head: null, dirty: false, observedAt: NOW },
    } as unknown as TeamWorkflowCommand<JsonValue>;

    await expect(harness.port.preview(callerOwned)).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });

    const preview = await harness.port.preview(command);
    const forgedAuthority = structuredClone(preview.command);
    forgedAuthority.authority.occurredAt = "2000-01-01T00:00:00.000Z";
    await expect(harness.port.apply({
      command: forgedAuthority,
      expectedPreviewRevision: preview.previewRevision,
    })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    await expect(harness.port.apply({
      command: preview.command,
      expectedPreviewRevision: "f".repeat(64),
    })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

    expect(existsSync(join(harness.root, ".mex/team/workstreams"))).toBe(false);
    expect(existsSync(join(harness.root, ".mex/events/activity"))).toBe(false);
  });

  it("rejects cyclic or oversized prepared commands before hashing or writing", async () => {
    const harness = createHarness();
    const cyclicPreview = createWorkstreamCommand(
      "operation_reject_unbounded_preview",
    ) as any;
    cyclicPreview.action.workstream.cycle = cyclicPreview;
    await expect(harness.port.preview(cyclicPreview)).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
    const oversizedPreview = createWorkstreamCommand(
      "operation_reject_oversized_preview",
    ) as any;
    oversizedPreview.action.workstream.summary = "x".repeat(300 * 1024);
    await expect(harness.port.preview(oversizedPreview)).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });

    const preview = await harness.port.preview(
      createWorkstreamCommand("operation_reject_unbounded_apply"),
    );
    const cyclic = structuredClone(preview.command) as any;
    cyclic.action.workstream.cycle = cyclic;

    await expect(harness.port.apply({
      command: cyclic,
      expectedPreviewRevision: preview.previewRevision,
    })).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });

    const oversized = structuredClone(preview.command) as any;
    oversized.action.workstream.summary = "x".repeat(300 * 1024);
    await expect(harness.port.apply({
      command: oversized,
      expectedPreviewRevision: preview.previewRevision,
    })).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    expect(existsSync(join(harness.root, ".mex/team/workstreams"))).toBe(false);
    expect(existsSync(join(harness.root, ".mex/local/team.db"))).toBe(false);
  });

  it("refuses an Activity target collision before publishing the primary artifact", async () => {
    const harness = createHarness();
    const preview = await harness.port.preview(
      createWorkstreamCommand("operation_activity_collision"),
    );
    const primary = preview.changes[0]!;
    const activity = preview.changes[1]!;
    const activityPath = join(harness.root, activity.path);
    mkdirSync(dirname(activityPath), { recursive: true });
    writeFileSync(activityPath, "unrelated activity bytes\n", "utf8");

    await expect(harness.port.apply({
      command: preview.command,
      expectedPreviewRevision: preview.previewRevision,
    })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(existsSync(join(harness.root, primary.path))).toBe(false);
    expect(existsSync(join(harness.root, ".mex/local/team.db"))).toBe(false);
  });

  it("keeps pure local reads noninitializing and initializes storage only for an explicit local mutation", async () => {
    const harness = createHarness();
    const database = join(harness.root, ".mex/local/team.db");

    await expect(harness.port.getLocalDraft("missing_draft")).resolves.toBeNull();
    await expect(harness.port.listLocalDrafts()).resolves.toMatchObject({
      items: [],
      nextCursor: null,
    });
    await expect(harness.port.resolveActor()).resolves.toEqual({
      kind: "git",
      name: "Ada",
      email: "ada@example.test",
    });
    expect(existsSync(database)).toBe(false);

    const preview = await harness.port.preview(createInboxDraftCommand("operation_save_draft"));
    expect(existsSync(database)).toBe(false);
    expect(preview).toMatchObject({ scope: "local", changes: [] });
    expect(preview.localChanges).toHaveLength(1);
    await expect(harness.port.listLocalDrafts()).resolves.toMatchObject({ items: [] });

    const result = await harness.port.apply({
      command: preview.command,
      expectedPreviewRevision: preview.previewRevision,
    });
    expect(existsSync(database)).toBe(true);
    expect(result).toMatchObject({
      idempotentReplay: false,
      artifacts: [],
      events: [],
    });
    await expect(harness.port.getLocalDraft(LOCAL_DRAFT_ID)).resolves.toMatchObject({
      id: LOCAL_DRAFT_ID,
      kind: "inbox",
      rationale: "Review the deterministic Wiki request.",
      updatedAt: NOW,
    });
  });

  it("recovers a hot SQLite rollback journal only for an explicit apply", async () => {
    const harness = createHarness();
    const seed = await harness.port.preview(
      createWorkstreamCommand("operation_seed_local_database"),
    );
    await harness.port.apply({
      command: seed.command,
      expectedPreviewRevision: seed.previewRevision,
    });

    const preview = await harness.port.preview(
      createInboxDraftCommand("operation_recover_hot_rollback_journal"),
    );
    const database = join(harness.root, ".mex/local/team.db");
    const journal = `${database}-journal`;
    await leaveHotRollbackJournal(database);
    expect(existsSync(journal)).toBe(true);

    await expect(harness.port.getLocalDraft(LOCAL_DRAFT_ID)).rejects.toMatchObject({
      problem: { code: "OPERATION_INTERRUPTED" },
    });
    expect(existsSync(journal)).toBe(true);

    await expect(harness.port.apply({
      command: preview.command,
      expectedPreviewRevision: preview.previewRevision,
    })).resolves.toMatchObject({
      operationId: "operation_recover_hot_rollback_journal",
      applied: true,
      idempotentReplay: false,
    });
    expect(existsSync(journal)).toBe(false);
    await expect(harness.port.getLocalDraft(LOCAL_DRAFT_ID)).resolves.toMatchObject({
      id: LOCAL_DRAFT_ID,
      kind: "inbox",
    });
  });

  it("replays an exact completed operation but rejects altered intent and altered prepared authority", async () => {
    const harness = createHarness();
    const preview = await harness.port.preview(createWorkstreamCommand("operation_replay"));
    const request = {
      command: preview.command,
      expectedPreviewRevision: preview.previewRevision,
    };

    const first = await harness.port.apply(request);
    const replay = await harness.port.apply(request);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.events).toHaveLength(1);
    expect(activityFiles(harness.root)).toHaveLength(1);

    const alteredIntent = structuredClone(preview.command);
    if (alteredIntent.action.kind !== "workstream.create") throw new Error("test invariant");
    alteredIntent.action.workstream.title = "Altered after apply";
    await expect(harness.port.apply({
      command: alteredIntent,
      expectedPreviewRevision: preview.previewRevision,
    })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

    const alteredAuthority = structuredClone(preview.command);
    alteredAuthority.authority.actor = { kind: "unknown" };
    await expect(harness.port.apply({
      command: alteredAuthority,
      expectedPreviewRevision: preview.previewRevision,
    })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(activityFiles(harness.root)).toHaveLength(1);
  });

  it("recovers exact canonical publication after a phase interruption and emits Activity once", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const interrupted = createPort(root, git, {
      pid: 101,
      phaseHook(boundary) {
        if (boundary === "after-canonical-publication") {
          throw new WorkflowPhaseInterruption(boundary);
        }
      },
      processStatus: () => "alive",
    });
    const preview = await interrupted.preview(createWorkstreamCommand("operation_recover"));
    const request = {
      command: preview.command,
      expectedPreviewRevision: preview.previewRevision,
    };

    await expect(interrupted.apply(request)).rejects.toBeInstanceOf(WorkflowPhaseInterruption);
    expect(existsSync(join(root, preview.changes[0]!.path))).toBe(true);
    expect(activityFiles(root)).toEqual([]);

    const recoveredPort = createPort(root, git, {
      pid: 202,
      processStatus: (pid) => pid === 101 ? "dead" : "alive",
      leaseToken: "b".repeat(64),
    });
    const recovered = await recoveredPort.apply(request);

    expect(recovered).toMatchObject({
      operationId: "operation_recover",
      idempotentReplay: true,
    });
    expect(recovered.events).toHaveLength(1);
    expect(activityFiles(root)).toHaveLength(1);
    await expect(recoveredPort.apply(request)).resolves.toMatchObject({
      idempotentReplay: true,
    });
    expect(activityFiles(root)).toHaveLength(1);
  });

  it("retains recovery state when primary publication lands before its call throws", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    let failAfterPrimary = true;
    const interrupted = createPort(root, git, {
      pid: 191,
      afterPrimaryApply() {
        if (!failAfterPrimary) return;
        failAfterPrimary = false;
        throw new Error("simulated post-publication lock cleanup failure");
      },
      processStatus: () => "alive",
    });
    const preview = await interrupted.preview(
      createWorkstreamCommand("operation_recover_post_publication_throw"),
    );
    const request = {
      command: preview.command,
      expectedPreviewRevision: preview.previewRevision,
    };

    await expect(interrupted.apply(request)).rejects.toThrow(
      "simulated post-publication lock cleanup failure",
    );
    expect(existsSync(join(root, preview.changes[0]!.path))).toBe(true);
    expect(activityFiles(root)).toEqual([]);

    const restarted = createPort(root, git, {
      pid: 192,
      processStatus: (pid) => pid === 191 ? "dead" : "alive",
      leaseToken: "e".repeat(64),
    });
    await expect(restarted.apply(request)).resolves.toMatchObject({
      operationId: "operation_recover_post_publication_throw",
      idempotentReplay: true,
      events: [expect.objectContaining({ id: EVENT_IDS[0] })],
    });
    expect(activityFiles(root)).toHaveLength(1);
  });

  it("returns a terminal conflict when an interrupted published proposal is tampered", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    let armed = false;
    const interrupted = createPort(root, git, {
      pid: 211,
      proposalIds: [PROPOSAL_ID],
      phaseHook(boundary) {
        if (armed && boundary === "after-canonical-publication") {
          throw new WorkflowPhaseInterruption(boundary);
        }
      },
      processStatus: () => "alive",
    });

    const draftPreview = await interrupted.preview(
      createInboxDraftCommand("operation_save_recovery_tamper_draft"),
    );
    await interrupted.apply({
      command: draftPreview.command,
      expectedPreviewRevision: draftPreview.previewRevision,
    });
    const draft = await interrupted.getLocalDraft(LOCAL_DRAFT_ID);
    if (draft === null) throw new Error("test draft missing");

    const publishCommand = {
      operationId: "operation_publish_then_tamper_proposal",
      action: { kind: "inbox.publish", draftId: LOCAL_DRAFT_ID },
      expectedRevisions: [{
        target: { kind: "local", namespace: "inbox-draft", id: LOCAL_DRAFT_ID },
        revision: draft.revision,
      }],
    } satisfies TeamWorkflowCommand<JsonValue>;
    const preview = await interrupted.preview(publishCommand);
    const proposalChange = preview.changes.find((change) => change.path.startsWith(".mex/inbox/"));
    if (proposalChange === undefined) throw new Error("proposal change missing");
    armed = true;
    const request = { command: preview.command, expectedPreviewRevision: preview.previewRevision };
    await expect(interrupted.apply(request)).rejects.toBeInstanceOf(WorkflowPhaseInterruption);

    const proposalPath = join(root, proposalChange.path);
    const tamperMarker = "private-tamper-marker-must-not-enter-errors";
    const tamperedBytes = `${readFileSync(proposalPath, "utf8")}\n${tamperMarker}\n`;
    writeFileSync(proposalPath, tamperedBytes, "utf8");

    const restarted = createPort(root, git, {
      pid: 212,
      processStatus: (pid) => pid === 211 ? "dead" : "alive",
      leaseToken: "d".repeat(64),
    });
    let failure: unknown;
    try {
      await restarted.apply(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(JSON.stringify(failure)).not.toContain(tamperMarker);
    expect(readFileSync(proposalPath, "utf8")).toBe(tamperedBytes);
    await expect(restarted.getLocalDraft(LOCAL_DRAFT_ID)).resolves.toMatchObject({
      revision: draft.revision,
    });
    expect(activityFiles(root)).toEqual([]);
  });

  it("reconstructs an exact unpublished operation after restart without changing its IDs", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const interrupted = createPort(root, git, {
      pid: 301,
      phaseHook(boundary) {
        if (boundary === "before-canonical-publication") throw new Error("stop");
      },
      processStatus: () => "alive",
    });
    const preview = await interrupted.preview(createWorkstreamCommand("operation_recover_unpublished"));
    const request = { command: preview.command, expectedPreviewRevision: preview.previewRevision };

    await expect(interrupted.apply(request)).rejects.toMatchObject({
      problem: { code: "OPERATION_INTERRUPTED" },
    });
    expect(existsSync(join(root, preview.changes[0]!.path))).toBe(false);

    const restarted = createPort(root, git, {
      pid: 302,
      processStatus: (pid) => pid === 301 ? "dead" : "alive",
      leaseToken: "c".repeat(64),
    });
    await expect(restarted.apply(request)).resolves.toMatchObject({
      idempotentReplay: true,
      artifacts: [expect.objectContaining({ ref: expect.objectContaining({ id: WORKSTREAM_ID }) })],
      events: [expect.objectContaining({ id: EVENT_IDS[0] })],
    });
    expect(activityFiles(root)).toHaveLength(1);
  });

  it("paginates members without repetition and binds cursors to filters", async () => {
    const harness = createHarness({
      memberIds: [...MEMBER_IDS],
      eventIds: [...EVENT_IDS],
    });
    for (const [index, active] of [true, false].entries()) {
      const command = {
        operationId: `operation_member_${index}`,
        action: {
          kind: "member.add",
          member: {
            displayName: `Member ${index}`,
            gitAliases: [],
            active,
          },
        },
        expectedRevisions: [],
      } satisfies TeamWorkflowCommand<JsonValue>;
      const preview = await harness.port.preview(command);
      await harness.port.apply({
        command: preview.command,
        expectedPreviewRevision: preview.previewRevision,
      });
    }

    const first = await harness.port.listArtifacts({
      kinds: ["member"],
      includeArchived: true,
      limit: 1,
    });
    expect(first.items.map((item) => item.ref.id)).toEqual([MEMBER_IDS[0]]);
    expect(first.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(first.nextCursor!, "utf8")).toBeLessThanOrEqual(4 * 1024);
    const second = await harness.port.listArtifacts({
      kinds: ["member"],
      includeArchived: true,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.ref.id)).toEqual([MEMBER_IDS[1]]);
    expect(second.nextCursor).toBeNull();

    await expect(harness.port.listArtifacts({
      kinds: ["member"],
      states: ["active"],
      limit: 100,
    })).resolves.toMatchObject({
      items: [],
    });
    await expect(harness.port.listArtifacts({
      kinds: ["member"],
      states: ["active"],
      limit: 1,
      cursor: first.nextCursor!,
    })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
  });
});

interface FakeGit extends GitPort {
  state: RepoState;
}

interface Harness {
  root: string;
  git: FakeGit;
  port: RepositoryTeamWorkflowPort<JsonValue, unknown>;
}

function createHarness(options: {
  memberIds?: string[];
  eventIds?: string[];
} = {}): Harness {
  const root = temporaryRoot();
  const git = fakeGit();
  return {
    root,
    git,
    port: createPort(root, git, {
      memberIds: options.memberIds,
      eventIds: options.eventIds,
    }),
  };
}

function createPort(
  root: string,
  git: FakeGit,
  overrides: {
    pid?: number;
    phaseHook?: RepositoryTeamWorkflowPortOptions<JsonValue>["phaseHook"];
    afterPrimaryApply?: RepositoryTeamWorkflowPortOptions<JsonValue>["afterPrimaryApply"];
    processStatus?: RepositoryTeamWorkflowPortOptions<JsonValue>["processStatus"];
    leaseToken?: string;
    memberIds?: string[];
    eventIds?: string[];
    proposalIds?: string[];
  } = {},
): RepositoryTeamWorkflowPort<JsonValue, unknown> {
  const memberIds = overrides.memberIds ?? [MEMBER_IDS[0]];
  const eventIds = overrides.eventIds ?? [EVENT_IDS[0]];
  const proposalIds = overrides.proposalIds ?? [PROPOSAL_ID];
  return createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(root, {
    scaffoldId: "workflow_test_scaffold",
    wiki: new MockWikiPort({ now: () => NOW }) as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
    git,
    now: () => new Date(NOW),
    pid: overrides.pid ?? 100,
    processStatus: overrides.processStatus ?? (() => "alive"),
    phaseHook: overrides.phaseHook,
    afterPrimaryApply: overrides.afterPrimaryApply,
    idFactories: {
      member: queueFactory(memberIds),
      workstream: () => WORKSTREAM_ID,
      proposal: queueFactory(proposalIds),
      activity: queueFactory(eventIds),
      localDraft: () => LOCAL_DRAFT_ID,
      leaseToken: () => overrides.leaseToken ?? "a".repeat(64),
    },
  });
}

function fakeGit(): FakeGit {
  const git: FakeGit = {
    state: {
      branch: "feature/team-workflow",
      head: HEAD,
      dirty: false,
      observedAt: NOW,
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

function createWorkstreamCommand(operationId: string): TeamWorkflowCommand<JsonValue> {
  return {
    operationId,
    action: {
      kind: "workstream.create",
      workstream: {
        title: "Release baseline",
        goal: "Make Team workflow publication recoverable.",
        summary: "Repository-bound workflow foundation.",
        owners: [{ kind: "unknown" }],
        nextMilestone: "Pass the consumer conformance suite.",
      },
    },
    expectedRevisions: [],
  };
}

function createInboxDraftCommand(operationId: string): TeamWorkflowCommand<JsonValue> {
  return {
    operationId,
    action: {
      kind: "inbox.draft.save",
      draft: {
        request: {
          operation: {
            opId: "wiki_operation_test",
            type: "create-entry",
            payload: { operations: [] },
          },
          expectedRevisions: [],
        },
        rationale: "Review the deterministic Wiki request.",
        evidence: [],
        targetRevisions: [],
      },
    },
    expectedRevisions: [],
  };
}

function queueFactory(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("The deterministic ID queue was exhausted.");
    index += 1;
    return value;
  };
}

function activityFiles(root: string): string[] {
  const directory = join(root, ".mex/events/activity", NOW.slice(0, 7));
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-team-workflow-port-"));
  roots.push(root);
  return root;
}

function initializeGitFixture(root: string): void {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Workflow Factory"]);
  git(root, ["config", "user.email", "workflow-factory@example.test"]);
}

function git(root: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function leaveHotRollbackJournal(database: string): Promise<void> {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(process.argv[1]);
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_size = 1; BEGIN IMMEDIATE");
    database.exec("CREATE TABLE crash_recovery_probe (value BLOB) STRICT");
    const insert = database.prepare("INSERT INTO crash_recovery_probe (value) VALUES (?)");
    for (let index = 0; index < 32; index += 1) insert.run(Buffer.alloc(64 * 1024, index));
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["-e", script, database], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const [chunk] = await once(child.stdout!, "data") as [Buffer];
    expect(chunk.toString("utf8")).toContain("ready");
    child.kill("SIGKILL");
    await once(child, "exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function artifactId(
  prefix: "member" | "ws" | "proposal" | "event",
  entropy: number,
): string {
  return generateArtifactId(prefix, {
    now: Date.parse(NOW),
    random: new Uint8Array(10).fill(entropy),
  });
}

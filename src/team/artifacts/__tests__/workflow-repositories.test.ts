import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorRef } from "../../contracts/shared.js";
import { generateArtifactId } from "../ulid.js";
import {
  WORKFLOW_REPOSITORY_LIMITS,
  InboxProposalRepository,
  PlaybookRepository,
  PlaybookRunRepository,
  RelayRepository,
  WorkstreamRepository,
} from "../workflow-repositories.js";

const roots: string[] = [];
const NOW = "2026-08-27T10:00:00.000Z";
const LATER = "2026-08-27T11:00:00.000Z";
const MEMBER = id("member", 1);
const ACTOR: ActorRef = { kind: "member", memberId: MEMBER };
const WORKSTREAM = id("ws", 2);
const WORKSTREAM_2 = id("ws", 3);
const PROPOSAL = id("proposal", 4);
const RELAY = id("relay", 5);
const PLAYBOOK = id("playbook", 6);
const RUN = id("run", 7);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical workflow repositories", () => {
  it("preserves canonical revisions and update authority across CRLF checkouts", async () => {
    const root = temporaryRoot();
    const repository = new WorkstreamRepository(root);
    const create = await repository.previewCreate(workstreamInput(WORKSTREAM, "First"));
    const original = (await repository.apply(create, create.previewRevision)).artifact;
    const file = join(root, original.sourcePath);
    const crlf = readFileSync(file, "utf8").replaceAll("\n", "\r\n");
    writeFileSync(file, crlf);
    const before = statSync(file, { bigint: true });
    expect(await repository.get(WORKSTREAM)).toEqual(original);
    expect((await repository.list()).items).toEqual([original]);
    const update = await repository.previewUpdate(WORKSTREAM, {
      ...withoutId(workstreamInput(WORKSTREAM, "First active")), state: "active", updatedAt: LATER,
    }, original.revision);
    expect(readFileSync(file, "utf8")).toBe(crlf);
    expect(statSync(file, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    const updated = (await repository.apply(update, update.previewRevision)).artifact;
    expect(updated).toMatchObject({ state: "active", entityRevision: 2 });
    expect(readFileSync(file, "utf8")).toBe(update.document);
    expect(readFileSync(file, "utf8")).not.toContain("\r");
  });

  it("keeps preview non-mutating, applies exact bytes, increments semantic revision, and rejects stale pages", async () => {
    const root = temporaryRoot();
    const repository = new WorkstreamRepository(root);
    const firstPreview = await repository.previewCreate(workstreamInput(WORKSTREAM, "First"));
    expect(() => statSync(join(root, ".mex"))).toThrow();
    await expect(repository.apply(firstPreview, "f".repeat(64))).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    await expect(repository.apply({
      ...firstPreview,
      document: firstPreview.document.replace("First", "Forged"),
    }, firstPreview.previewRevision)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(() => statSync(join(root, ".mex"))).toThrow();
    const first = (await repository.apply(firstPreview, firstPreview.previewRevision)).artifact;
    const secondPreview = await repository.previewCreate(workstreamInput(WORKSTREAM_2, "Second"));
    await repository.apply(secondPreview, secondPreview.previewRevision);

    const page = await repository.list({ limit: 1, states: ["planned"] });
    expect(page).toMatchObject({ truncated: true, sourceTruncated: false, diagnostics: [] });
    expect(page.items).toHaveLength(1);
    expect(page.deterministicRevision).toHaveLength(64);
    await expect(repository.list({ limit: 1, states: ["active"], cursor: page.nextCursor! })).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });

    const update = await repository.previewUpdate(WORKSTREAM, {
      ...withoutId(workstreamInput(WORKSTREAM, "First active")), state: "active", updatedAt: LATER,
    }, first.revision);
    const updated = (await repository.apply(update, update.previewRevision)).artifact;
    expect(updated).toMatchObject({ state: "active", entityRevision: 2 });
    await expect(repository.list({ limit: 1, states: ["planned"], cursor: page.nextCursor! })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect((await repository.list({ states: ["active"] })).items.map((item) => item.ref.id)).toEqual([WORKSTREAM]);
    await expect(repository.apply(update, update.previewRevision)).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
  });

  it("enforces proposal, relay, playbook, and run lifecycle authority", async () => {
    const root = temporaryRoot();
    const proposalRepository = new InboxProposalRepository<{ summary: string }>(root);
    const proposalPlan = await proposalRepository.previewCreate({
      id: PROPOSAL, author: ACTOR, rationale: "Update", evidence: [],
      request: { operation: { opId: "op-1", type: "update-entry", payload: { summary: "New" } }, expectedRevisions: [] },
      targetRevisions: [],
    });
    const proposal = (await proposalRepository.apply(proposalPlan, proposalPlan.previewRevision)).artifact;
    const approvedPlan = await proposalRepository.previewUpdate(PROPOSAL, {
      state: "approved", author: ACTOR, rationale: proposal.rationale, evidence: [], request: proposal.request,
      targetRevisions: [], reviewer: ACTOR, reviewedAt: LATER,
    }, proposal.revision);
    expect((await proposalRepository.apply(approvedPlan, approvedPlan.previewRevision)).artifact.state).toBe("approved");

    const relayRepository = new RelayRepository(root);
    const relayPlan = await relayRepository.previewCreate({
      id: RELAY, sender: ACTOR, recipients: [ACTOR], workstream: { id: WORKSTREAM, kind: "workstream" }, summary: "Handoff",
      completed: [], inProgress: [], decisions: [], blockers: [], unresolvedQuestions: [], changedFiles: [], code: [], evidence: [], nextActions: ["Review"],
    });
    const relay = (await relayRepository.apply(relayPlan, relayPlan.previewRevision)).artifact;
    const acknowledged = await relayRepository.previewUpdate(RELAY, {
      ...relayReplacement(relay), state: "acknowledged", acknowledgedBy: ACTOR, acknowledgedAt: LATER,
    }, relay.revision);
    const acknowledgedRelay = (await relayRepository.apply(
      acknowledged,
      acknowledged.previewRevision,
    )).artifact;
    expect(acknowledgedRelay).toMatchObject({ entityRevision: 2, schemaVersion: 1 });
    expect(readFileSync(join(root, acknowledgedRelay.sourcePath), "utf8"))
      .toContain("schema_version: 1\n");
    const closed = await relayRepository.previewUpdate(RELAY, {
      ...relayReplacement(acknowledgedRelay),
      state: "closed",
      acknowledgedBy: acknowledgedRelay.acknowledgedBy,
      acknowledgedAt: acknowledgedRelay.acknowledgedAt,
      closedBy: ACTOR,
      closedAt: LATER,
    }, acknowledgedRelay.revision);
    const closedRelay = (await relayRepository.apply(closed, closed.previewRevision)).artifact;
    expect(closedRelay).toMatchObject({ entityRevision: 3, schemaVersion: 1, state: "closed" });
    expect(readFileSync(join(root, closedRelay.sourcePath), "utf8"))
      .toContain("schema_version: 1\n");

    const playbookRepository = new PlaybookRepository(root);
    const playbookPlan = await playbookRepository.previewCreate({
      id: PLAYBOOK, title: "Release", purpose: "Ship", trigger: "Requested", owners: [ACTOR], prerequisites: [],
      steps: [{ id: "verify", title: "Verify", instructions: "Run checks", requiredChecks: [], expectedOutputs: [] }], related: [],
    });
    const playbook = (await playbookRepository.apply(playbookPlan, playbookPlan.previewRevision)).artifact;
    const archived = await playbookRepository.previewUpdate(PLAYBOOK, {
      state: "archived", title: playbook.title, purpose: playbook.purpose, trigger: playbook.trigger, owners: playbook.owners,
      prerequisites: playbook.prerequisites, steps: playbook.steps, related: playbook.related,
    }, playbook.revision);
    expect((await playbookRepository.apply(archived, archived.previewRevision)).artifact.state).toBe("archived");
    expect((await playbookRepository.list()).items).toEqual([]);
    expect((await playbookRepository.list({ includeArchived: true })).items).toHaveLength(1);

    const runRepository = new PlaybookRunRepository(root);
    const runPlan = await runRepository.previewCreate({
      id: RUN, playbook: { id: PLAYBOOK, kind: "playbook" }, workstream: { id: WORKSTREAM, kind: "workstream" },
      steps: [{ stepId: "verify" }], startedBy: ACTOR, startedAt: NOW,
    });
    const run = (await runRepository.apply(runPlan, runPlan.previewRevision)).artifact;
    const completed = await runRepository.previewUpdate(RUN, {
      state: "completed", playbook: run.playbook, workstream: run.workstream,
      steps: [{ stepId: "verify", completedBy: ACTOR, completedAt: LATER }], startedBy: run.startedBy, startedAt: run.startedAt,
    }, run.revision);
    expect((await runRepository.apply(completed, completed.previewRevision)).artifact).toMatchObject({ state: "completed", entityRevision: 2 });
  });

  it("allows explicit proposal staleness and repair while keeping terminal review immutable", async () => {
    const root = temporaryRoot();
    const repository = new InboxProposalRepository<{ summary: string }>(root);
    const createdPlan = await repository.previewCreate({
      id: PROPOSAL,
      author: ACTOR,
      rationale: "Govern a Spec prose update",
      evidence: [],
      request: {
        operation: { opId: "op-stale", type: "update-entry", payload: { summary: "Before drift" } },
        expectedRevisions: [],
      },
      targetRevisions: [],
    });
    const pending = (await repository.apply(createdPlan, createdPlan.previewRevision)).artifact;

    const stalePlan = await repository.previewUpdate(PROPOSAL, {
      state: "stale",
      author: pending.author,
      rationale: pending.rationale,
      evidence: pending.evidence,
      request: pending.request,
      targetRevisions: pending.targetRevisions,
    }, pending.revision);
    const stale = (await repository.apply(stalePlan, stalePlan.previewRevision)).artifact;
    expect(stale.state).toBe("stale");

    const repairedRequest = {
      operation: { opId: "op-repaired", type: "update-entry" as const, payload: { summary: "After rebase" } },
      expectedRevisions: [],
    };
    const repairPlan = await repository.previewUpdate(PROPOSAL, {
      state: "pending",
      author: stale.author,
      rationale: stale.rationale,
      evidence: stale.evidence,
      request: repairedRequest,
      targetRevisions: [],
    }, stale.revision);
    const repaired = (await repository.apply(repairPlan, repairPlan.previewRevision)).artifact;
    expect(repaired).toMatchObject({ state: "pending", request: repairedRequest });

    const approvedPlan = await repository.previewUpdate(PROPOSAL, {
      state: "approved",
      author: repaired.author,
      rationale: repaired.rationale,
      evidence: repaired.evidence,
      request: repaired.request,
      targetRevisions: repaired.targetRevisions,
      reviewer: ACTOR,
      reviewedAt: LATER,
    }, repaired.revision);
    const approved = (await repository.apply(approvedPlan, approvedPlan.previewRevision)).artifact;
    await expect(repository.previewUpdate(PROPOSAL, {
      state: "stale",
      author: approved.author,
      rationale: approved.rationale,
      evidence: approved.evidence,
      request: approved.request,
      targetRevisions: approved.targetRevisions,
    }, approved.revision)).rejects.toThrow(/immutable/iu);
  });

  it("rejects caller-forged lifecycle jumps", async () => {
    const root = temporaryRoot();
    const repository = new RelayRepository(root);
    const plan = await repository.previewCreate({
      id: RELAY, sender: ACTOR, recipients: [ACTOR], workstream: { id: WORKSTREAM, kind: "workstream" }, summary: "Handoff",
      completed: [], inProgress: [], decisions: [], blockers: [], unresolvedQuestions: [], changedFiles: [], code: [], evidence: [], nextActions: [],
    });
    const relay = (await repository.apply(plan, plan.previewRevision)).artifact;
    await expect(repository.previewUpdate(RELAY, {
      ...relayReplacement(relay), state: "closed", acknowledgedBy: ACTOR, acknowledgedAt: NOW, closedBy: ACTOR, closedAt: LATER,
    }, relay.revision)).rejects.toThrow(/published -> closed/);
  });

  it("fails closed before parsing an oversized canonical collection", async () => {
    const root = temporaryRoot();
    const directory = join(root, ".mex", "workstreams");
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index <= WORKFLOW_REPOSITORY_LIMITS.maxRecords; index += 1) {
      writeFileSync(join(directory, `${String(index).padStart(4, "0")}.md`), "", "utf8");
    }

    await expect(new WorkstreamRepository(root).list()).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects creates that would exceed directory or record capacity and rechecks after preview", async () => {
    await withWorkflowRepositoryLimits({
      maxDirectoryEntries: 10,
      maxRecords: 1,
      maxCorpusBytes: 1_000_000,
    }, async () => {
      const root = temporaryRoot();
      const repository = new WorkstreamRepository(root);
      const pending = await repository.previewCreate(workstreamInput(WORKSTREAM, "Pending"));
      const occupied = await repository.previewCreate(workstreamInput(WORKSTREAM_2, "Occupied"));
      await repository.apply(occupied, occupied.previewRevision);

      await expect(repository.previewCreate(workstreamInput(id("ws", 8), "Too many"))).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
      await expect(repository.apply(pending, pending.previewRevision)).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
      expect(await repository.get(WORKSTREAM)).toBeNull();
    });

    await withWorkflowRepositoryLimits({
      maxDirectoryEntries: 1,
      maxRecords: 10,
      maxCorpusBytes: 1_000_000,
    }, async () => {
      const root = temporaryRoot();
      const repository = new WorkstreamRepository(root);
      const pending = await repository.previewCreate(workstreamInput(WORKSTREAM, "No directory slot"));
      const directory = join(root, ".mex", "workstreams");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "README"), "reserved", "utf8");

      await expect(
        repository.previewCreate(workstreamInput(WORKSTREAM_2, "No directory slot")),
      ).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      await expect(repository.apply(pending, pending.previewRevision)).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
    });

    await withWorkflowRepositoryLimits({
      maxDirectoryEntries: 10,
      maxRecords: 10,
      maxCorpusBytes: 1_000_000,
    }, async (limits) => {
      const root = temporaryRoot();
      const repository = new WorkstreamRepository(root);
      const pending = await repository.previewCreate(workstreamInput(WORKSTREAM, "Corpus pending"));
      limits.maxCorpusBytes = Buffer.byteLength(pending.document, "utf8");
      const directory = join(root, ".mex", "workstreams");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "occupied.md"), "x", "utf8");

      await expect(repository.previewCreate(workstreamInput(WORKSTREAM_2, "Corpus pending"))).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
      await expect(repository.apply(pending, pending.previewRevision)).rejects.toMatchObject({
        problem: { code: "VALIDATION_FAILED" },
      });
    });
  });

  it("uses replacement bytes for projected workflow corpus capacity", async () => {
    await withWorkflowRepositoryLimits({
      maxDirectoryEntries: 10,
      maxRecords: 10,
      maxCorpusBytes: 1_000_000,
    }, async (limits) => {
      const root = temporaryRoot();
      const repository = new WorkstreamRepository(root);
      const createdPlan = await repository.previewCreate(
        workstreamInput(WORKSTREAM, "A deliberately long canonical workstream title"),
      );
      const created = (await repository.apply(createdPlan, createdPlan.previewRevision)).artifact;
      const shrinkInput = {
        ...withoutId(workstreamInput(WORKSTREAM, "Short")),
        state: "active" as const,
        updatedAt: LATER,
      };
      const shrink = await repository.previewUpdate(WORKSTREAM, shrinkInput, created.revision);
      limits.maxCorpusBytes = Buffer.byteLength(shrink.document, "utf8");

      const boundedShrink = await repository.previewUpdate(WORKSTREAM, shrinkInput, created.revision);
      const updated = (await repository.apply(boundedShrink, boundedShrink.previewRevision)).artifact;
      expect(updated.title).toBe("Short");

      await expect(repository.previewUpdate(WORKSTREAM, {
        ...withoutId(workstreamInput(WORKSTREAM, "A title that grows beyond the newly bounded corpus")),
        state: "active",
        createdAt: updated.createdAt,
        updatedAt: "2026-08-27T12:00:00.000Z",
      }, updated.revision)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    });
  });

  it("binds a symlinked project root before preview so apply cannot follow a target swap", async () => {
    const container = temporaryRoot();
    const original = join(container, "original");
    const replacement = join(container, "replacement");
    const link = join(container, "project");
    mkdirSync(original);
    mkdirSync(replacement);
    symlinkSync(original, link);
    const repository = new WorkstreamRepository(link);
    const preview = await repository.previewCreate(workstreamInput(WORKSTREAM, "Bound root"));

    unlinkSync(link);
    symlinkSync(replacement, link);
    await repository.apply(preview, preview.previewRevision);

    expect(existsSync(join(original, ...preview.change.path.split("/")))).toBe(true);
    expect(existsSync(join(replacement, ...preview.change.path.split("/")))).toBe(false);
  });
});

function workstreamInput(idValue: string, title: string) {
  return {
    id: idValue, title, goal: "Ship", summary: "Release", owners: [ACTOR], contributors: [], paths: [], code: [], topics: [],
    components: [], related: [], blockers: [], currentState: "Planned", nextMilestone: "Start", createdBy: ACTOR, createdAt: NOW,
    updatedBy: ACTOR, updatedAt: NOW,
  } as const;
}

function withoutId<T extends { id?: string }>(value: T): Omit<T, "id"> {
  const { id: _id, ...rest } = value;
  return rest;
}

function relayReplacement(relay: Awaited<ReturnType<RelayRepository["get"]>> & {}) {
  if (relay === null) throw new Error("missing relay");
  const content = {
    sender: relay.sender, recipients: relay.recipients, summary: relay.summary, completed: relay.completed,
    inProgress: relay.inProgress, decisions: relay.decisions, blockers: relay.blockers, unresolvedQuestions: relay.unresolvedQuestions,
    changedFiles: relay.changedFiles, code: relay.code, evidence: relay.evidence, nextActions: relay.nextActions,
  };
  return relay.schemaVersion === 3 || relay.schemaVersion === 4
    ? {
        ...content,
        ...(relay.schemaVersion === 4
          ? { schemaVersion: 4 as const, audience: relay.audience }
          : { schemaVersion: 3 as const }),
        publishedAt: relay.publishedAt,
        publishedRepoState: relay.publishedRepoState,
      }
    : relay.schemaVersion === 2
      ? {
          ...content,
          schemaVersion: 2 as const,
          workstream: relay.workstream,
          publishedAt: relay.publishedAt,
        }
      : {
          ...content,
          schemaVersion: 1 as const,
          workstream: relay.workstream,
        };
}

function id(prefix: "member" | "ws" | "proposal" | "relay" | "playbook" | "run", fill: number): string {
  return generateArtifactId(prefix, { now: fill, random: new Uint8Array(10).fill(fill) });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-workflow-repository-"));
  roots.push(root);
  return root;
}

interface MutableWorkflowRepositoryLimits {
  maxDirectoryEntries: number;
  maxRecords: number;
  maxCorpusBytes: number;
  maxCursorBytes: number;
  maxDiagnostics: number;
}

async function withWorkflowRepositoryLimits(
  overrides: Partial<MutableWorkflowRepositoryLimits>,
  operation: (limits: MutableWorkflowRepositoryLimits) => Promise<void>,
): Promise<void> {
  const limits = WORKFLOW_REPOSITORY_LIMITS as unknown as MutableWorkflowRepositoryLimits;
  const original = { ...limits };
  Object.assign(limits, overrides);
  try {
    await operation(limits);
  } finally {
    Object.assign(limits, original);
  }
}

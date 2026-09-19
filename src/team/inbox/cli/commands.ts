import { isArtifactId } from "../../artifacts/ulid.js";
import { MexPortError } from "../../contracts/shared.js";
import type { RepositoryWikiPort } from "../../../wiki/application-adapter.js";
import {
  PROPOSAL_STATES,
  TEAM_INBOX_SPEC_LIMITS,
  TEAM_INBOX_KNOWLEDGE_KINDS,
  TEAM_INBOX_SPEC_KINDS,
  type ProposalState,
  type TeamInboxSpecApplyResult,
  type TeamInboxSpecDraftDetail,
  type TeamInboxSpecDraftSummary,
  type TeamInboxSpecPage,
  type TeamInboxSpecPreviewEnvelope,
  type TeamInboxSpecProposalDetail,
  type TeamInboxSpecProposalSummary,
} from "../../contracts/workflow.js";
import type {
  TeamCommandIo,
  TeamMutationFlags,
  TeamOutputFlags,
  TeamPageFlags,
} from "../../cli/commands.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
  TeamCliUsageError,
  type TeamCliCommandName,
  type TeamCliEnvelope,
  type TeamCliMode,
} from "../../cli/envelope.js";
import {
  projectInboxApply,
  projectInboxDraft,
  projectInboxDraftPage,
  projectInboxPreview,
  projectInboxProposal,
  projectInboxProposalPage,
} from "./projections.js";
import {
  readInboxCommandFile,
  readInboxPreviewFile,
  type InboxMutationCommandName,
} from "./request-file.js";
import type {
  TeamInboxSpecCliService,
  TeamInboxSpecCliServiceFactory,
} from "./service.js";

export interface InboxProposalListFlags extends TeamPageFlags {
  state?: string | readonly string[];
}

export type InboxCliServiceSource =
  | TeamInboxSpecCliService
  | TeamInboxSpecCliServiceFactory;

/** Resolve one existing Wiki record without exposing metadata or requiring Team state. */
export async function runInboxTarget(
  source: () => Pick<RepositoryWikiPort, "readInboxTarget"> | Promise<Pick<RepositoryWikiPort, "readInboxTarget">>,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("inbox.target", "read", flags, io, async () => {
    if (!/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(id)) {
      throw new TeamCliUsageError("Target ID must be an mx_ prefixed Wiki ULID.");
    }
    const entity = await (await source()).readInboxTarget(id);
    if (entity === null) throw notFound("Knowledge target", id);
    if (!([...TEAM_INBOX_KNOWLEDGE_KINDS, ...TEAM_INBOX_SPEC_KINDS, "topic"] as readonly string[]).includes(entity.ref.kind)) {
      throw new TeamCliUsageError("This entity kind is not supported by Inbox.");
    }
    const data = {
      target: { id: entity.ref.id, kind: entity.ref.kind, title: entity.title },
      version: {
        semanticRevision: entity.version.semanticRevision,
        contentHash: entity.version.contentHash,
      },
      sourcePath: entity.location.path,
      lifecycleState: entity.lifecycleState,
      ...(entity.summary === undefined ? {} : { summary: entity.summary }),
      body: entity.body,
    };
    const envelope = teamEnvelope({ command: "inbox.target", mode: "read", data });
    if (Buffer.byteLength(renderTeamEnvelope(envelope), "utf8") > TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes) {
      throw new MexPortError({
        title: "Knowledge target exceeds read bound", status: 413, code: "INVALID_REQUEST",
        detail: "The complete target exceeds the 64 KiB Inbox read bound. Select a smaller section entity.",
      });
    }
    return envelope;
  }, (data, _envelope, output) => {
    output.write(`${data.target.title} (${data.target.id})`);
    output.write(`Source: ${data.sourcePath}`);
    output.write(`Revision: ${data.version.semanticRevision} / ${data.version.contentHash}`);
    output.write(data.body);
  });
}

export async function runInboxDraftList(
  source: InboxCliServiceSource,
  flags: TeamPageFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("inbox.draft.list", "read", flags, io, async () => {
    const request = pageRequest(flags);
    const page = projectInboxDraftPage(
      await (await resolveService(source)).listInboxDrafts(request),
    );
    return teamEnvelope({
      command: "inbox.draft.list",
      mode: "read",
      data: page,
      diagnostics: page.diagnostics,
    });
  }, renderDraftList);
}

export async function runInboxDraftShow(
  source: InboxCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("inbox.draft.show", "read", flags, io, async () => {
    assertDraftId(id);
    const draft = await (await resolveService(source)).getInboxDraft(id);
    if (draft === null) throw notFound("Inbox draft", id);
    return teamEnvelope({
      command: "inbox.draft.show",
      mode: "read",
      data: projectInboxDraft(draft),
    });
  }, renderDraft);
}

export async function runInboxProposalList(
  source: InboxCliServiceSource,
  flags: InboxProposalListFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("inbox.proposal.list", "read", flags, io, async () => {
    const states = proposalStates(flags.state);
    const request = pageRequest(flags);
    const page = projectInboxProposalPage(
      await (await resolveService(source)).listInboxProposals({
        ...request,
        ...(states.length === 0 ? {} : { states }),
      }),
    );
    return teamEnvelope({
      command: "inbox.proposal.list",
      mode: "read",
      data: page,
      diagnostics: page.diagnostics,
    });
  }, renderProposalList);
}

export async function runInboxProposalShow(
  source: InboxCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("inbox.proposal.show", "read", flags, io, async () => {
    assertProposalId(id);
    const proposal = await (await resolveService(source)).getInboxProposal(id);
    if (proposal === null) throw notFound("Inbox proposal", id);
    return teamEnvelope({
      command: "inbox.proposal.show",
      mode: "read",
      data: projectInboxProposal(proposal),
    });
  }, renderProposal);
}

export async function runInboxMutation(
  source: InboxCliServiceSource,
  command: InboxMutationCommandName,
  requestFile: string | undefined,
  flags: TeamMutationFlags,
  io: TeamCommandIo,
): Promise<void> {
  if (flags.apply === undefined) {
    await execute(command, "preview", flags, io, async () => {
      if (requestFile === undefined) {
        throw new TeamCliUsageError("An Inbox request JSON file is required for preview.");
      }
      const request = readInboxCommandFile(requestFile, command);
      const preview = projectInboxPreview(
        await (await resolveService(source)).previewInbox(request),
      );
      return teamEnvelope({
        command,
        mode: "preview",
        data: preview,
        diagnostics: preview.preview.diagnostics,
        valid: preview.preview.valid,
      });
    }, renderPreview);
    return;
  }

  await execute(command, "apply", flags, io, async () => {
    if (requestFile !== undefined) {
      throw new TeamCliUsageError(
        "Apply accepts only --apply <preview-envelope.json>; do not also pass a request file.",
      );
    }
    const preview = readInboxPreviewFile(flags.apply!, command);
    const result = projectInboxApply(
      await (await resolveService(source)).applyInbox(preview),
    );
    return teamEnvelope({ command, mode: "apply", data: result });
  }, renderApply);
}

async function execute<T>(
  command: TeamCliCommandName,
  mode: TeamCliMode,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
  operation: () => Promise<TeamCliEnvelope<T>>,
  human: (data: T, envelope: TeamCliEnvelope<T>, io: TeamCommandIo) => void,
): Promise<void> {
  let envelope: TeamCliEnvelope<T> | TeamCliEnvelope<never>;
  try {
    envelope = await operation();
  } catch (error) {
    envelope = teamProblemEnvelope(command, mode, error);
  }
  if (flags.json === true) {
    io.write(renderTeamEnvelope(envelope));
  } else if (envelope.data === null) {
    const problem = envelope.problem;
    io.write(problem === null ? "Inbox command failed validation." : `${problem.code}: ${problem.detail}`);
    for (const diagnostic of envelope.diagnostics) {
      io.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
  } else {
    human(envelope.data as T, envelope as TeamCliEnvelope<T>, io);
    for (const diagnostic of envelope.diagnostics) {
      io.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}

function pageRequest(flags: TeamPageFlags): { cursor?: string; limit?: number } {
  if (flags.cursor !== undefined && (
    flags.cursor.length === 0
    || Buffer.byteLength(flags.cursor, "utf8") > TEAM_INBOX_SPEC_LIMITS.maxCursorBytes
    || !/^[A-Za-z0-9_-]+$/u.test(flags.cursor)
  )) {
    throw new TeamCliUsageError(
      `--cursor must be a valid cursor of at most ${TEAM_INBOX_SPEC_LIMITS.maxCursorBytes} bytes.`,
    );
  }
  return {
    ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
    ...(flags.limit === undefined ? {} : { limit: positiveLimit(flags.limit) }),
  };
}

function positiveLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > TEAM_INBOX_SPEC_LIMITS.maxPageSize
  ) {
    throw new TeamCliUsageError(
      `--limit must be an integer from 1 to ${TEAM_INBOX_SPEC_LIMITS.maxPageSize}.`,
    );
  }
  return parsed;
}

function proposalStates(value: string | readonly string[] | undefined): readonly ProposalState[] {
  const values = value === undefined ? [] : typeof value === "string" ? [value] : value;
  const unique: ProposalState[] = [];
  for (const state of values) {
    if (!(PROPOSAL_STATES as readonly string[]).includes(state)) {
      throw new TeamCliUsageError(`--state must be one of: ${PROPOSAL_STATES.join(", ")}.`);
    }
    if (!unique.includes(state as ProposalState)) unique.push(state as ProposalState);
  }
  return unique;
}

function assertDraftId(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256
  ) throw new TeamCliUsageError("Draft ID must be a bounded canonical local identifier.");
}

function assertProposalId(value: string): void {
  if (!isArtifactId(value, "proposal")) {
    throw new TeamCliUsageError("Proposal ID must be a proposal_ prefixed ULID.");
  }
}

function notFound(label: string, id: string): MexPortError {
  return new MexPortError({
    title: `${label} not found`,
    status: 404,
    code: "NOT_FOUND",
    detail: `${label} ${id} does not exist.`,
  });
}

async function resolveService(source: InboxCliServiceSource): Promise<TeamInboxSpecCliService> {
  return typeof source === "function" ? source() : source;
}

function renderDraftList(
  page: TeamInboxSpecPage<TeamInboxSpecDraftSummary>,
  _envelope: TeamCliEnvelope<TeamInboxSpecPage<TeamInboxSpecDraftSummary>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No local Inbox drafts found.");
  for (const draft of page.items) {
    io.write(`${draft.id}\t${draft.changeKind}\t${draft.entityKind}\t${draft.title}`);
  }
  renderContinuation(page, io);
}

function renderDraft(
  draft: TeamInboxSpecDraftDetail,
  _envelope: TeamCliEnvelope<TeamInboxSpecDraftDetail>,
  io: TeamCommandIo,
): void {
  io.write(`${draft.title} (${draft.id})`);
  io.write(`Change: ${draft.changeKind} / ${draft.entityKind}`);
  io.write(`Revision: ${draft.revision}`);
  io.write(`Updated: ${draft.updatedAt}`);
  io.write(`Rationale: ${draft.input.rationale}`);
}

function renderProposalList(
  page: TeamInboxSpecPage<TeamInboxSpecProposalSummary>,
  _envelope: TeamCliEnvelope<TeamInboxSpecPage<TeamInboxSpecProposalSummary>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No canonical Inbox proposals found.");
  for (const proposal of page.items) {
    io.write(`${proposal.ref.id}\t${proposal.state}\t${proposal.changeKind}\t${proposal.title}`);
  }
  renderContinuation(page, io);
}

function renderProposal(
  proposal: TeamInboxSpecProposalDetail,
  _envelope: TeamCliEnvelope<TeamInboxSpecProposalDetail>,
  io: TeamCommandIo,
): void {
  io.write(`${proposal.title} (${proposal.ref.id})`);
  io.write(`State: ${proposal.state}`);
  io.write(`Change: ${proposal.changeKind} / ${proposal.entityKind}`);
  io.write(`Revision: ${proposal.revision}`);
  io.write(`Source: ${proposal.sourcePath}`);
  io.write(`Rationale: ${proposal.rationale}`);
}

function renderPreview(
  preview: TeamInboxSpecPreviewEnvelope,
  envelope: TeamCliEnvelope<TeamInboxSpecPreviewEnvelope>,
  io: TeamCommandIo,
): void {
  io.write(`${envelope.ok ? "Valid" : "Invalid"} ${preview.preview.scope} preview for ${preview.request.operationId}`);
  io.write(`Canonical changes: ${preview.preview.changes.length}`);
  io.write(`Local changes: ${preview.preview.localChanges.length}`);
  io.write(`Preview revision: ${preview.receipt.previewRevision}`);
  io.write("Use --json to save this complete approval envelope before apply.");
}

function renderApply(
  result: TeamInboxSpecApplyResult,
  _envelope: TeamCliEnvelope<TeamInboxSpecApplyResult>,
  io: TeamCommandIo,
): void {
  io.write(`${result.idempotentReplay ? "Replayed" : "Applied"} ${result.operationId}`);
  io.write(`Canonical changes: ${result.changes.length}`);
  io.write(`Local changes: ${result.localChanges.length}`);
  io.write(`Proposals: ${result.proposals.length}`);
  io.write(`Activity events: ${result.events.length}`);
}

function renderContinuation(
  page: { nextCursor: string | null; sourceTruncated: boolean },
  io: TeamCommandIo,
): void {
  if (page.nextCursor !== null) io.write(`Next cursor: ${page.nextCursor}`);
  if (page.sourceTruncated) io.write("Warning: the bounded source scan was incomplete.");
}

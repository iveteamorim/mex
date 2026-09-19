import { randomUUID } from "node:crypto";
import { isArtifactId } from "../../artifacts/ulid.js";
import { MexPortError } from "../../contracts/shared.js";
import {
  RELAY_STATES,
  TEAM_RELAY_LIMITS,
  type RelayState,
  type TeamRelayApplyResult,
  type TeamRelayDetail,
  type TeamRelayDraftDetail,
  type TeamRelayDraftSummary,
  type TeamRelayPage,
  type TeamRelayPerspective,
  type TeamRelayPreviewEnvelope,
  type TeamRelaySummary,
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
  projectRelay,
  projectRelayApply,
  projectRelayDraft,
  projectRelayDraftPage,
  projectRelayPage,
  projectRelayPreview,
} from "./projections.js";
import { isRelayLocalId, normalizeTeamRelayCommand } from "../handoff.js";
import { readBoundedJsonFile } from "../../cli/request-file.js";
import { locateTeamRepositoryRoot } from "../../cli/repository-root.js";
import { withLocalRelayPreview } from "./local-preview.js";
import {
  readRelayCommandFile,
  readRelayPreviewFile,
  type RelayMutationCommandName,
} from "./request-file.js";
import type { TeamRelayCliService, TeamRelayCliServiceFactory } from "./service.js";

export interface RelayListFlags extends TeamPageFlags {
  perspective?: string;
  state?: string | readonly string[];
  workstream?: string;
}

export interface RelayMutationFlags extends TeamMutationFlags {
  /** Save a new local draft directly from bounded sparse content. */
  from?: string;
  operationId?: string;
}

export interface RelayMutationOptions {
  projectRoot?: () => string;
}

export type RelayCliServiceSource = TeamRelayCliService | TeamRelayCliServiceFactory;

export async function runRelayDraftList(
  source: RelayCliServiceSource,
  flags: TeamPageFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.draft.list", "read", flags, io, async () => {
    const request = pageRequest(flags);
    const page = projectRelayDraftPage(
      await (await resolveService(source)).listRelayDrafts(request),
    );
    return teamEnvelope({
      command: "relay.draft.list",
      mode: "read",
      data: page,
      diagnostics: page.diagnostics,
    });
  }, renderDraftList);
}

export async function runRelayDraftShow(
  source: RelayCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.draft.show", "read", flags, io, async () => {
    assertLocalId(id);
    const draft = await (await resolveService(source)).getRelayDraft(id);
    if (draft === null) throw notFound("Relay draft", id);
    return teamEnvelope({ command: "relay.draft.show", mode: "read", data: projectRelayDraft(draft) });
  }, renderDraft);
}

export async function runRelayList(
  source: RelayCliServiceSource,
  flags: RelayListFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.list", "read", flags, io, async () => {
    const perspective = relayPerspective(flags.perspective);
    const states = relayStates(flags.state);
    if (flags.workstream !== undefined && !isArtifactId(flags.workstream, "ws")) {
      throw new TeamCliUsageError("--workstream must be a ws_ prefixed ULID.");
    }
    const request = pageRequest(flags);
    const page = projectRelayPage(await (await resolveService(source)).listRelays({
      ...request,
      ...(perspective === undefined ? {} : { perspective }),
      ...(states.length === 0 ? {} : { states }),
      ...(flags.workstream === undefined ? {} : { workstreamId: flags.workstream }),
    }));
    return teamEnvelope({
      command: "relay.list",
      mode: "read",
      data: page,
      diagnostics: page.diagnostics,
    });
  }, renderRelayList);
}

export async function runRelayShow(
  source: RelayCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.show", "read", flags, io, async () => {
    assertRelayId(id);
    const relay = await (await resolveService(source)).getRelay(id);
    if (relay === null) throw notFound("Relay", id);
    const projected = projectRelay(relay);
    return teamEnvelope({
      command: "relay.show",
      mode: "read",
      data: projected,
      diagnostics: projected.diagnostics,
    });
  }, renderRelay);
}

export async function runRelayMutation(
  source: RelayCliServiceSource,
  command: RelayMutationCommandName,
  requestFile: string | undefined,
  flags: RelayMutationFlags,
  io: TeamCommandIo,
  options: RelayMutationOptions = {},
): Promise<void> {
  if (flags.from !== undefined || flags.operationId !== undefined) {
    await execute(command, "apply", flags, io, async () => {
      if (command !== "relay.draft.save" || flags.from === undefined
        || requestFile !== undefined || flags.apply !== undefined) {
        throw new TeamCliUsageError("Quick saving accepts only relay draft save --from <draft.json> and an optional --operation-id; do not combine it with a request file or --apply.");
      }
      const value = readBoundedJsonFile(flags.from);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TeamCliUsageError("The draft file must contain one Relay draft object.");
      }
      const content = value as Record<string, unknown>;
      const request = normalizeTeamRelayCommand({
        operationId: flags.operationId ?? `relay-local-${randomUUID()}`,
        action: {
          kind: "relay.draft.save",
          draft: {
            ...content,
            ...(!Object.hasOwn(content, "audience") && !Object.hasOwn(content, "recipients") ? { audience: "team" } : {}),
            ...(!Object.hasOwn(content, "recipients") ? { recipients: [] } : {}),
          },
        },
        expectedRevisions: [],
      });
      const service = await resolveService(source);
      const result = await withLocalRelayPreview(
        (options.projectRoot ?? locateTeamRepositoryRoot)(),
        request,
        async () => {
          const preview = await service.previewRelay(request);
          const local = preview.preview.localChanges;
          if (!preview.preview.valid || preview.preview.scope !== "local"
            || preview.preview.changes.length !== 0 || local.length !== 1
            || local[0]?.namespace !== "relay-draft" || local[0].beforeRevision !== null
            || preview.request.action.kind !== "relay.draft.save"
            || preview.request.action.draftId !== undefined) {
            throw new TeamCliUsageError("Quick saving requires a valid preview that only creates one checkout-local Relay draft.");
          }
          return preview;
        },
        async (preview) => projectRelayApply(await service.applyRelay(preview)),
      );
      return teamEnvelope({ command, mode: "apply", data: result });
    }, renderApply);
    return;
  }
  if (flags.apply === undefined) {
    await execute(command, "preview", flags, io, async () => {
      if (requestFile === undefined) {
        throw new TeamCliUsageError("A Relay request JSON file is required for preview.");
      }
      const request = readRelayCommandFile(requestFile, command);
      const preview = projectRelayPreview(
        await (await resolveService(source)).previewRelay(request),
      );
      const envelope = teamEnvelope({
        command,
        mode: "preview",
        data: preview,
        diagnostics: preview.preview.diagnostics,
        valid: preview.preview.valid,
      });
      assertSavableRelayPreview(envelope);
      return envelope;
    }, renderPreview);
    return;
  }

  await execute(command, "apply", flags, io, async () => {
    if (requestFile !== undefined) {
      throw new TeamCliUsageError(
        "Apply accepts only --apply <preview-envelope.json>; do not also pass a request file.",
      );
    }
    const preview = readRelayPreviewFile(flags.apply!, command);
    const result = projectRelayApply(
      await (await resolveService(source)).applyRelay(preview),
    );
    return teamEnvelope({ command, mode: "apply", data: result });
  }, renderApply);
}

/** `console.log` adds one byte; saved output must remain readable by apply. */
function assertSavableRelayPreview(
  envelope: TeamCliEnvelope<TeamRelayPreviewEnvelope>,
): void {
  const outputBytes = Buffer.byteLength(renderTeamEnvelope(envelope), "utf8") + 1;
  if (outputBytes <= TEAM_RELAY_LIMITS.maxEnvelopeBytes) return;
  throw new MexPortError({
    title: "Relay preview exceeds CLI envelope limit",
    status: 422,
    code: "VALIDATION_FAILED",
    detail:
      `The complete Relay preview envelope exceeds ${TEAM_RELAY_LIMITS.maxEnvelopeBytes} bytes and cannot be saved for apply. Reduce the Relay draft content and preview again.`,
  });
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
    io.write(problem === null ? "Relay command failed validation." : `${problem.code}: ${problem.detail}`);
    for (const diagnostic of envelope.diagnostics) {
      io.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
    for (const recovery of problem?.recovery ?? []) {
      io.write(recovery.command ?? recovery.label);
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
    || Buffer.byteLength(flags.cursor, "utf8") > TEAM_RELAY_LIMITS.maxCursorBytes
    || !/^[A-Za-z0-9_-]+$/u.test(flags.cursor)
  )) {
    throw new TeamCliUsageError(
      `--cursor must be a valid cursor of at most ${TEAM_RELAY_LIMITS.maxCursorBytes} bytes.`,
    );
  }
  return {
    ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
    ...(flags.limit === undefined ? {} : { limit: positiveLimit(flags.limit) }),
  };
}

function positiveLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > TEAM_RELAY_LIMITS.maxPageSize) {
    throw new TeamCliUsageError(
      `--limit must be an integer from 1 to ${TEAM_RELAY_LIMITS.maxPageSize}.`,
    );
  }
  return parsed;
}

function relayPerspective(value: string | undefined): TeamRelayPerspective | undefined {
  if (value === undefined) return undefined;
  if (value !== "mine" && value !== "sent" && value !== "all") {
    throw new TeamCliUsageError("--perspective must be one of: mine, sent, all.");
  }
  return value;
}

function relayStates(value: string | readonly string[] | undefined): readonly RelayState[] {
  const values = value === undefined ? [] : typeof value === "string" ? [value] : value;
  const unique: RelayState[] = [];
  for (const state of values) {
    if (!(RELAY_STATES as readonly string[]).includes(state)) {
      throw new TeamCliUsageError(`--state must be one of: ${RELAY_STATES.join(", ")}.`);
    }
    if (!unique.includes(state as RelayState)) unique.push(state as RelayState);
  }
  return unique;
}

function assertLocalId(value: string): void {
  if (!isRelayLocalId(value)) {
    throw new TeamCliUsageError("Draft ID must be a canonical local identifier of at most 128 bytes.");
  }
}

function assertRelayId(value: string): void {
  if (!isArtifactId(value, "relay")) {
    throw new TeamCliUsageError("Relay ID must be a relay_ prefixed ULID.");
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

async function resolveService(source: RelayCliServiceSource): Promise<TeamRelayCliService> {
  return typeof source === "function" ? source() : source;
}

function renderDraftList(
  page: TeamRelayPage<TeamRelayDraftSummary>,
  _envelope: TeamCliEnvelope<TeamRelayPage<TeamRelayDraftSummary>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No local Relay drafts found.");
  for (const draft of page.items) {
    io.write(`${draft.id}\t${relayAudience(draft)}\t${draft.summary}`);
  }
  renderContinuation(page, io);
}

function renderDraft(
  draft: TeamRelayDraftDetail,
  _envelope: TeamCliEnvelope<TeamRelayDraftDetail>,
  io: TeamCommandIo,
): void {
  io.write(`${draft.summary} (${draft.id})`);
  io.write("Sharing: checkout-local draft; nothing is published or shared.");
  io.write(`Audience: ${relayAudience(draft)}`);
  io.write(`Revision: ${draft.revision}`);
  io.write(`Updated: ${draft.updatedAt}`);
}

function renderRelayList(
  page: TeamRelayPage<TeamRelaySummary>,
  _envelope: TeamCliEnvelope<TeamRelayPage<TeamRelaySummary>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No canonical Relays found.");
  for (const relay of page.items) {
    const context = relayPublicationContext(relay);
    io.write([
      relay.ref.id,
      relay.state,
      ...(relay.workstream === null ? [] : [`Workstream ${relay.workstream.id}`]),
      ...(context === null ? [] : [context]),
      relay.summary,
    ].join("\t"));
  }
  renderContinuation(page, io);
}

function renderRelay(
  relay: TeamRelayDetail,
  _envelope: TeamCliEnvelope<TeamRelayDetail>,
  io: TeamCommandIo,
): void {
  io.write(`${relay.summary} (${relay.ref.id})`);
  io.write(`State: ${relay.state}`);
  io.write("Sharing: canonical working-tree artifact; Git distributes it, delivery is not verified.");
  io.write(`Who can take it: ${relay.state === "published" ? relayAudience(relay) : relay.state === "acknowledged" ? "Already taken by the recorded claimant." : "Closed."}`);
  if (relay.workstream !== null) io.write(`Workstream: ${relay.workstream.id}`);
  io.write(`Published: ${relay.publishedAt ?? "legacy timestamp unavailable"}`);
  const publicationContext = relayPublicationContext(relay);
  if (publicationContext !== null) {
    io.write(`Publication repository: ${publicationContext}`);
    io.write(`Repository observed: ${relay.publishedRepoState!.observedAt}`);
  }
  io.write(`Revision: ${relay.revision}`);
}

function relayPublicationContext(
  relay: Pick<TeamRelaySummary, "publishedRepoState">,
): string | null {
  const state = relay.publishedRepoState;
  if (state === null) return null;
  const branch = state.branch ?? "Detached HEAD";
  const head = state.head === null ? "No committed HEAD" : state.head.slice(0, 8);
  return `${branch} @ ${head} (${state.dirty ? "local changes present" : "clean working tree"})`;
}

function relayAudience(value: Pick<TeamRelaySummary, "audience" | "recipients">): string {
  if (value.audience === "team") return "Open to any active project Member, including future Members";
  if (value.recipients.length === 0) return "Recipients not selected; choose an audience before publishing";
  return value.recipients.map((recipient) => recipient.kind === "member"
    ? recipient.displayName ?? recipient.memberId
    : recipient.kind === "git" ? recipient.name ?? recipient.email ?? "Git actor" : "Unknown actor").join(", ");
}

function renderPreview(
  preview: TeamRelayPreviewEnvelope,
  envelope: TeamCliEnvelope<TeamRelayPreviewEnvelope>,
  io: TeamCommandIo,
): void {
  io.write(`${envelope.ok ? "Valid" : "Invalid"} ${preview.preview.scope} preview for ${preview.request.operationId}`);
  io.write(`Canonical changes: ${preview.preview.changes.length}`);
  io.write(`Local changes: ${preview.preview.localChanges.length}`);
  io.write(`Preview revision: ${preview.receipt.previewRevision}`);
  io.write("Use --json to save this complete approval envelope before apply.");
}

function renderApply(
  result: TeamRelayApplyResult,
  _envelope: TeamCliEnvelope<TeamRelayApplyResult>,
  io: TeamCommandIo,
): void {
  io.write(`${result.idempotentReplay ? "Replayed" : "Applied"} ${result.operationId}`);
  io.write(`Canonical changes: ${result.changes.length}`);
  io.write(`Local changes: ${result.localChanges.length}`);
  io.write(`Relays: ${result.relays.length}`);
  io.write(`Activity events: ${result.events.length}`);
  if (result.changes.length === 0 && result.localChanges.length > 0) {
    io.write("Local draft state changed only in this checkout; nothing was published or shared.");
    for (const change of result.localChanges) {
      if (change.namespace === "relay-draft" && change.afterRevision !== null) {
        io.write(`/relays?view=drafts&draft=${encodeURIComponent(change.id)}`);
      }
    }
  } else if (result.changes.length > 0) {
    io.write("Canonical files were written to the working tree; commit/push and teammate pull are still required to share them.");
  }
}

function renderContinuation(
  page: { nextCursor: string | null; sourceTruncated: boolean },
  io: TeamCommandIo,
): void {
  if (page.nextCursor !== null) io.write(`Next cursor: ${page.nextCursor}`);
  if (page.sourceTruncated) io.write("Warning: the bounded source scan was incomplete.");
}

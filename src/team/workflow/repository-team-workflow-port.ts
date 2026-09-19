import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  createRepositoryWikiPort,
  type RepositoryWikiOperationPayload,
  type RepositoryWikiOperationPlan,
} from "../../wiki/application-adapter.js";
import type { GitPort } from "../contracts/git.js";
import type {
  ActorRef,
  Diagnostic,
  EntityRef,
  FileChange,
  JsonValue,
  RepoRelativePath,
  RepoState,
  Revision,
  RevisionExpectation,
} from "../contracts/shared.js";
import {
  isRepoRelativePath,
  isRevision,
  MexPortError,
} from "../contracts/shared.js";
import type {
  ActivityEvent,
  InboxDraft,
  InboxDraftInput,
  InboxProposal,
  LocalDraft,
  LocalDraftListRequest,
  LocalStateChange,
  Playbook,
  PlaybookRun,
  PreparedTeamWorkflowCommand,
  Relay,
  RelayDraft,
  RelayDraftInput,
  StoredActivityEvent,
  TeamArtifact,
  TeamArtifactKind,
  TeamArtifactListRequest,
  TeamArtifactState,
  TeamPage,
  TeamActivityListRequest,
  TeamCurrentActor,
  TeamIdentityActivityCommand,
  TeamIdentityActivityPreviewEnvelope,
  TeamIdentityActivityPublicPreview,
  TeamIdentityActivityPurposeId,
  TeamInboxDraftListRequest,
  TeamInboxProposalListRequest,
  TeamInboxSpecApplyResult,
  TeamInboxSpecAuthoringPort,
  TeamInboxSpecCommand,
  TeamInboxSpecDraftDetail,
  TeamInboxSpecDraftSummary,
  TeamInboxSpecPage,
  TeamInboxSpecPreviewEnvelope,
  TeamInboxSpecPublicPreview,
  TeamInboxSpecProposalDetail,
  TeamInboxSpecProposalSummary,
  TeamInboxSpecPurposeId,
  TeamRelayApplyResult,
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayDraftListRequest,
  TeamRelayDraftSummary,
  TeamRelayHandoffPort,
  TeamRelayListRequest,
  TeamRelayPage,
  TeamRelayPreviewEnvelope,
  TeamRelayPurposeId,
  TeamRelaySummary,
  TeamMember,
  TeamMemberListRequest,
  TeamWorkflowApplyRequest,
  TeamWorkflowAction,
  TeamWorkflowCommand,
  TeamWorkflowPort,
  TeamWorkflowPreview,
  TeamWorkflowResult,
  Workstream,
  TeamWorkstreamCommand,
  TeamWorkstreamListRequest,
  TeamWorkstreamPreviewEnvelope,
  TeamWorkstreamPurposeId,
} from "../contracts/workflow.js";
import {
  TEAM_INBOX_SPEC_LIMITS,
  TEAM_IDENTITY_ACTIVITY_LIMITS,
  TEAM_READ_LIMITS,
  TEAM_RELAY_LIMITS,
} from "../contracts/workflow.js";
import type {
  WikiOperationActor,
  WikiOperationPreview,
  WikiOperationRecoveryInspection,
  WikiOperationRecoveryManifest,
  WikiOperationRequest,
  WikiOperationResult,
  WikiPort,
  WikiExactAuthoringPreviewPort,
  WikiForcedCreatedIdPreviewPort,
  WikiRevisionExpectation,
} from "../contracts/wiki.js";
import {
  ActivityRepository,
  type ActivityCreateInput,
  type ActivityCreatePreview,
  type ActivityCreateProvenance,
  type PreparedActivityPublication,
} from "../activity/repository.js";
import {
  ACTIVITY_ARTIFACT_MAX_BYTES,
  ACTIVITY_LABEL_MAX_BYTES,
  memberArtifactPath,
} from "../artifacts/codecs.js";
import { artifactError } from "../artifacts/errors.js";
import {
  assertContainedArtifactDirectory,
  canonicalCheckoutBytes,
  tryReadContainedArtifact,
  type ArtifactByteMode,
} from "../artifacts/filesystem.js";
import { revisionOf } from "../artifacts/revision.js";
import { generateArtifactId, isArtifactId } from "../artifacts/ulid.js";
import {
  InboxProposalRepository,
  PlaybookRepository,
  PlaybookRunRepository,
  RelayRepository,
  WorkstreamRepository,
  type RelayRepositoryUpdateInput,
  type WorkflowArtifactWritePlan,
  type WorkflowRepositoryPage,
} from "../artifacts/workflow-repositories.js";
import {
  inboxProposalArtifactPath,
  normalizeInboxDraftInput,
  normalizeRelayDraftInput,
  normalizeRelayDraftInputWithLegacy,
  normalizeWorkflowRevisionExpectations,
  playbookArtifactPath,
  playbookRunArtifactPath,
  relayArtifactPath,
  workstreamArtifactPath,
} from "../artifacts/workflow-codecs.js";
import { createRepositoryGitPort } from "../git/git-port.js";
import {
  ActorResolver,
  type ActorResolution,
} from "../identity/actor-resolver.js";
import {
  MemberRepository,
  type MemberWritePlan,
} from "../identity/member-repository.js";
import {
  TEAM_LOCAL_STATE_LIMITS,
  TeamLocalState,
  normalizeTeamWorkflowJournalEffects,
  type ActivityWorkflowEffect,
  type CanonicalWorkflowEffect,
  type HubLeaseProcessStatus,
  type IdentityActivityReceiptWorkflowEffect,
  type LocalCleanupWorkflowEffect,
  type LocalWorkflowEffect,
  type StoredLocalDraft,
  type TeamWorkflowJournalEffect,
  type TeamWorkflowJournalEntry,
  type WikiRecoveryWorkflowEffect,
} from "../local-state/index.js";
import { TeamReceiptSigner } from "../local-state/receipt-signer.js";
import {
  assertExactSpecAttestations,
  boundedInboxJson,
  boundedInboxReceiptJson,
  decodeInboxCursor,
  encodeInboxCursor,
  hashInboxValue,
  inboxDraftInputFromProduct,
  inboxSigningPayload,
  materializeSpecWikiRequest,
  isInboxCreateChange,
  isInboxUpdateChange,
  normalizeInboxListFilter,
  normalizeTeamInboxSpecCommand,
  productDraftProjection,
  productDraftSummary,
  productInputFromInboxDraft,
  productProposalProjection,
  productProposalSummary,
  specAttestationsHaveDrifted,
  specDependencyIds,
  storedSpecChange,
  type ExactSpecEntityAttestation,
  utf8Excerpt,
} from "../inbox/spec-authoring.js";
import {
  aggregateRelayDiagnostics,
  boundedRelayJson,
  boundedRelayReceiptJson,
  decodeRelayCursor,
  encodeRelayCursor,
  hashRelayValue,
  isRawLegacyRelayDraftCommand,
  isRelayLocalId,
  normalizeExistingRelayDraftMigrationCommand,
  normalizeRelayListFilter,
  normalizeStoredRelayProductDraftInput,
  normalizeTeamRelayCommand,
  normalizeTranslatedLegacyRelayDraftCommand,
  relayDraftProjection,
  relayDraftSummary,
  relayProjection,
  relaySigningPayload,
  relaySummary,
} from "../relay/handoff.js";
import { generateEntityId, isEntityId } from "../../wiki/model/ids.js";
import { RepositoryRootGuard } from "./repository-root.js";

const MAX_ISSUED_PREVIEWS = 256;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_WIKI_RECOVERY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WIKI_OPERATION_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PREPARED_COMMAND_BYTES = 256 * 1024;
const MAX_PREPARED_COMMAND_DEPTH = 32;
const MAX_PREPARED_COMMAND_NODES = 8_192;
const MEMBER_SELECTION_NAMESPACE = "member-selection" as const;
const MEMBER_SELECTION_ID = "current" as const;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ARTIFACT_KIND_ORDER = [
  "member",
  "workstream",
  "proposal",
  "relay",
  "playbook",
  "playbook_run",
] as const satisfies readonly TeamArtifactKind[];

const ARTIFACT_STATES = new Set<string>([
  "planned", "active", "blocked", "done", "archived",
  "pending", "approved", "rejected", "withdrawn", "stale",
  "published", "acknowledged", "closed", "completed",
]);

export type TeamWorkflowPhaseBoundary =
  | "before-canonical-publication"
  | "after-canonical-publication"
  | "after-activity-publication"
  | "after-local-cleanup";

export interface RepositoryTeamWorkflowPortOptions<
  TWikiPayload extends JsonValue,
  TWikiPlan = unknown,
> {
  scaffoldId: string;
  wiki: WikiPort<unknown, TWikiPayload, TWikiPlan, unknown>;
  git?: GitPort;
  now?: () => Date;
  pid?: number;
  processStatus?: (pid: number) => HubLeaseProcessStatus;
  phaseHook?: (boundary: TeamWorkflowPhaseBoundary) => void | Promise<void>;
  /** @internal Fault seam after durable primary storage returns to the workflow layer. */
  afterPrimaryApply?: () => void | Promise<void>;
  idFactories?: {
    member?: () => string;
    workstream?: () => string;
    proposal?: () => string;
    relay?: () => string;
    playbook?: () => string;
    playbookRun?: () => string;
    activity?: (timestampMs: number) => string;
    /** Package-private receipt-pinned Wiki entity ID factory for E tests. */
    spec?: () => string;
    localDraft?: (kind: "inbox" | "relay") => string;
    leaseToken?: () => string;
  };
}

interface PreparedOperation<TWikiPayload extends JsonValue, TWikiPlan> {
  callerCommandRevision: Revision;
  commandRevision: Revision;
  preview: TeamWorkflowPreview<TWikiPayload>;
  effects: readonly TeamWorkflowJournalEffect[];
  activity: ActivityCreatePreview | null;
  applyPrimary(): Promise<PrimaryResult<TWikiPayload>>;
  cleanup: readonly LocalCleanupWorkflowEffect[];
  wiki?: {
    request: WikiOperationRequest<TWikiPayload>;
    preview: WikiOperationPreview<TWikiPlan>;
  };
}

interface PrimaryResult<TWikiPayload extends JsonValue> {
  artifacts: readonly TeamArtifact<TWikiPayload>[];
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  wikiResult?: WikiOperationResult;
}

type PlannedActivityInput = Omit<ActivityCreateInput, "actor"> & ActivityCreateProvenance;

type PortableWorkflowPurposeId =
  | TeamIdentityActivityPurposeId
  | TeamWorkstreamPurposeId
  | TeamInboxSpecPurposeId
  | TeamRelayPurposeId;

interface RecoverableWikiPort<TWikiPayload extends JsonValue, TWikiPlan>
  extends WikiPort<unknown, TWikiPayload, TWikiPlan, unknown> {
  inspectOperationRecovery(
    request: WikiOperationRequest<TWikiPayload>,
  ): WikiOperationRecoveryInspection;
  resumeOperations(
    request: WikiOperationRequest<TWikiPayload>,
    manifest: WikiOperationRecoveryManifest,
  ): Promise<WikiOperationPreview<TWikiPlan>>;
}

interface WikiRecoveryContext<TWikiPayload extends JsonValue, TWikiPlan> {
  port: RecoverableWikiPort<TWikiPayload, TWikiPlan>;
  request: WikiOperationRequest<TWikiPayload>;
  manifest: WikiOperationRecoveryManifest;
  inspection: WikiOperationRecoveryInspection;
}

interface ArtifactCursor {
  v: 1;
  kindIndex: number;
  innerCursor: string | null;
  memberOffset: number;
  corpusRevision: Revision;
  filterRevision: Revision;
}

interface MemberCursor {
  v: 1;
  offset: number;
  corpusRevision: Revision;
  filterRevision: Revision;
}

/** Internal repository-bound implementation; intentionally absent from package-root exports. */
export class RepositoryTeamWorkflowPort<
  TWikiPayload extends JsonValue,
  TWikiPlan = unknown,
> implements TeamWorkflowPort<TWikiPayload>, TeamInboxSpecAuthoringPort, TeamRelayHandoffPort {
  readonly #root: RepositoryRootGuard;
  readonly #git: GitPort;
  readonly #wiki: WikiPort<unknown, TWikiPayload, TWikiPlan, unknown>;
  readonly #now: () => Date;
  readonly #pid: number;
  readonly #phaseHook: (boundary: TeamWorkflowPhaseBoundary) => void | Promise<void>;
  readonly #afterPrimaryApply: () => void | Promise<void>;
  readonly #members: MemberRepository;
  readonly #workstreams: WorkstreamRepository;
  readonly #proposals: InboxProposalRepository<TWikiPayload>;
  readonly #relays: RelayRepository;
  readonly #playbooks: PlaybookRepository;
  readonly #runs: PlaybookRunRepository;
  readonly #local: TeamLocalState;
  readonly #receiptSigner: TeamReceiptSigner;
  readonly #actors: ActorResolver;
  readonly #activity: ActivityRepository;
  readonly #localDraftId: (kind: "inbox" | "relay") => string;
  readonly #specId: () => string;
  readonly #leaseToken: () => string;
  readonly #issued = new Map<Revision, PreparedOperation<TWikiPayload, TWikiPlan>>();
  readonly #issuedByCommand = new Map<Revision, Revision>();
  #heldLeaseToken: string | null = null;

  constructor(
    projectRoot: string,
    options: RepositoryTeamWorkflowPortOptions<TWikiPayload, TWikiPlan>,
  ) {
    this.#root = new RepositoryRootGuard(projectRoot);
    this.#git = options.git ?? createRepositoryGitPort(this.#root.path, { now: options.now });
    this.#wiki = options.wiki;
    this.#now = options.now ?? (() => new Date());
    this.#pid = options.pid ?? process.pid;
    this.#phaseHook = options.phaseHook ?? (() => undefined);
    this.#afterPrimaryApply = options.afterPrimaryApply ?? (() => undefined);
    this.#members = new MemberRepository(this.#root.path, {
      ...(options.idFactories?.member === undefined ? {} : { idFactory: options.idFactories.member }),
    });
    this.#workstreams = new WorkstreamRepository(this.#root.path, {
      ...(options.idFactories?.workstream === undefined ? {} : { idFactory: options.idFactories.workstream }),
    });
    this.#proposals = new InboxProposalRepository<TWikiPayload>(this.#root.path, {
      ...(options.idFactories?.proposal === undefined ? {} : { idFactory: options.idFactories.proposal }),
    });
    this.#relays = new RelayRepository(this.#root.path, {
      ...(options.idFactories?.relay === undefined ? {} : { idFactory: options.idFactories.relay }),
    });
    this.#playbooks = new PlaybookRepository(this.#root.path, {
      ...(options.idFactories?.playbook === undefined ? {} : { idFactory: options.idFactories.playbook }),
    });
    this.#runs = new PlaybookRunRepository(this.#root.path, {
      ...(options.idFactories?.playbookRun === undefined ? {} : { idFactory: options.idFactories.playbookRun }),
    });
    this.#local = new TeamLocalState({
      projectRoot: this.#root.path,
      scaffoldId: options.scaffoldId,
      now: () => this.#nowIso(),
      ...(options.processStatus === undefined ? {} : { processStatus: options.processStatus }),
    });
    this.#receiptSigner = new TeamReceiptSigner(
      this.#root.path,
      options.scaffoldId,
    );
    this.#actors = new ActorResolver(this.#members, this.#git);
    this.#activity = new ActivityRepository({
      projectRoot: this.#root.path,
      git: this.#git,
      now: this.#now,
      ...(options.idFactories?.activity === undefined
        ? {}
        : { generateId: options.idFactories.activity }),
    });
    this.#localDraftId = options.idFactories?.localDraft
      ?? ((kind) => `${kind}_${randomBytes(16).toString("hex")}`);
    this.#specId = options.idFactories?.spec ?? (() => generateEntityId());
    this.#leaseToken = options.idFactories?.leaseToken
      ?? (() => randomBytes(32).toString("hex"));
  }

  async resolveActor(): Promise<ActorRef> {
    this.#root.assertCurrent();
    const configured = this.#local.getConfiguredMember();
    return this.#actors.resolve(configured === null ? {} : { configuredMemberId: configured.memberId });
  }

  /** Explicit Hub-startup preparation; ordinary reads never call this. */
  initializeIdentityActivitySigner(): void {
    this.#root.assertCurrent();
    this.#receiptSigner.initialize();
  }

  async getMember(memberId: string): Promise<TeamMember | null> {
    this.#root.assertCurrent();
    return this.#members.get(memberId);
  }

  async listMembers(
    request: TeamMemberListRequest = {},
  ): Promise<TeamPage<TeamMember>> {
    this.#root.assertCurrent();
    if (request.active !== undefined && typeof request.active !== "boolean") {
      throw invalidMemberList();
    }
    const limit = normalizeLimit(request.limit);
    const all = await this.#members.list();
    const corpusRevision = hashJson(all.map((member) => [member.sourcePath, member.revision]));
    const filterRevision = hashJson({ active: request.active ?? null });
    const cursor = decodeMemberCursor(
      request.cursor,
      corpusRevision,
      filterRevision,
    );
    const filtered = request.active === undefined
      ? all
      : all.filter((member) => member.active === request.active);
    if (cursor !== null && cursor.offset >= filtered.length) {
      throw invalidMemberList();
    }
    const offset = cursor?.offset ?? 0;
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length
      ? encodeMemberCursor({
          v: 1,
          offset: nextOffset,
          corpusRevision,
          filterRevision,
        })
      : null;
    return {
      items,
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: hashJson({ corpusRevision, filterRevision }),
      diagnostics: [],
    };
  }

  async getCurrentActor(): Promise<TeamCurrentActor> {
    this.#root.assertCurrent();
    const configured = this.#local.getConfiguredMember();
    const resolution = await this.#resolveCurrentActorDetailed(configured);
    return {
      actor: resolution.actor,
      source: resolution.source,
      selection: configured === null
        ? null
        : {
            memberId: configured.memberId,
            updatedAt: configured.updatedAt,
            revision: configured.revision,
          },
      diagnostics: resolution.diagnostics,
    };
  }

  async getActivity(id: string): Promise<StoredActivityEvent | null> {
    this.#root.assertCurrent();
    return this.#activity.get(id);
  }

  async listActivity(
    request: TeamActivityListRequest = {},
  ): Promise<TeamPage<StoredActivityEvent>> {
    this.#root.assertCurrent();
    const page = this.#activity.list({
      source: "activity",
      ...(request.since === undefined ? {} : { since: request.since }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    });
    if (page.sourceTruncated) throw activitySourceTruncated();
    return page;
  }

  async getWorkstream(workstreamId: string): Promise<Workstream | null> {
    this.#root.assertCurrent();
    return this.#workstreams.get(workstreamId);
  }

  async listWorkstreams(
    request: TeamWorkstreamListRequest = {},
  ): Promise<TeamPage<Workstream>> {
    this.#root.assertCurrent();
    return this.#workstreams.list(request);
  }

  async previewIdentityActivity(
    command: TeamIdentityActivityCommand,
  ): Promise<TeamIdentityActivityPreviewEnvelope> {
    this.#root.assertCurrent();
    assertIdentityActivityCommand(command);
    let internal = await this.preview(
      command as TeamWorkflowCommand<TWikiPayload>,
    );
    if (!this.#portablePreviewIsFresh(internal.command.authority.occurredAt)) {
      this.#evictIssuedCommand(internal);
      internal = await this.preview(command as TeamWorkflowCommand<TWikiPayload>);
    }
    const prepared = this.#issued.get(internal.previewRevision);
    if (prepared === undefined) throw previewConflict();
    const request = commandFromPrepared(internal.command) as TeamIdentityActivityCommand;
    const publicPreview = publicPreviewFrom(internal);
    const purposeIds = purposeIdsFromEffects(command.action.kind, prepared.effects);
    const requestRevision = hashText(boundedIdentityEnvelopeJson(request));
    const presentationRevision = hashText(
      boundedIdentityEnvelopeJson(publicPreview),
    );
    const receiptBase = {
      schemaVersion: 1 as const,
      authority: internal.command.authority,
      purposeIds,
      requestRevision,
      presentationRevision,
    };
    const signingPayload = receiptSigningPayload(receiptBase);
    // Prove the complete envelope bound before the one allowed local signer
    // preparation. A failed/oversized mutation preview therefore cannot create
    // any local credential.
    assertIdentityActivityEnvelope({
      schemaVersion: 1,
      request,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision: "0".repeat(64) },
    });
    this.#receiptSigner.initialize();
    const previewRevision = this.#receiptSigner.sign(signingPayload);
    const envelope = deepFreeze({
      schemaVersion: 1 as const,
      request,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision },
    });
    assertIdentityActivityEnvelope(envelope);
    const portable = withPortableEnvelopeAttestation(
      prepared,
      previewRevision,
      identityActivityEnvelopeRevision(envelope),
    );
    this.#rememberIssued(previewRevision, portable, false);
    return envelope;
  }

  async applyIdentityActivity(
    envelopeValue: TeamIdentityActivityPreviewEnvelope,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    this.#root.assertCurrent();
    const envelope = parseIdentityActivityEnvelope(envelopeValue);
    const command = deepFreeze({
      ...envelope.request,
      authority: envelope.receipt.authority,
    }) as PreparedTeamWorkflowCommand<TWikiPayload>;

    let existing: TeamWorkflowJournalEntry | null = null;
    try {
      existing = this.#local.getWorkflowOperation(command.operationId);
    } catch (error) {
      if (!(error instanceof MexPortError)) throw error;
      if (error.problem.code === "MIGRATION_REQUIRED") {
        existing = null;
      } else if (error.problem.code === "OPERATION_INTERRUPTED") {
        this.#local.initializeForMutation();
        existing = this.#local.getWorkflowOperation(command.operationId);
      } else {
        throw error;
      }
    }
    if (existing !== null) {
      assertJournalEnvelopeAttestation(existing.effects, envelope);
      return this.apply({
        command,
        expectedPreviewRevision: envelope.receipt.previewRevision,
      });
    }

    this.#receiptSigner.verify(
      receiptSigningPayload(envelope.receipt),
      envelope.receipt.previewRevision,
    );
    this.#assertPortablePreviewFresh(envelope.receipt.authority.occurredAt);
    await this.#assertAuthorityCurrent(
      envelope.receipt.authority,
      actionAllowsStaleSelectionFallback(envelope.request.action.kind),
    );
    const replanned = await this.#plan(
      command,
      envelope.receipt.requestRevision,
      envelope.receipt.purposeIds,
    );
    if (
      boundedIdentityEnvelopeJson(publicPreviewFrom(replanned.preview))
        !== boundedIdentityEnvelopeJson(envelope.preview)
      || boundedIdentityEnvelopeJson(
        purposeIdsFromEffects(envelope.request.action.kind, replanned.effects),
      ) !== boundedIdentityEnvelopeJson(envelope.receipt.purposeIds)
    ) {
      throw previewConflict();
    }
    const portable = withPortableEnvelopeAttestation(
      replanned,
      envelope.receipt.previewRevision,
      identityActivityEnvelopeRevision(envelope),
    );
    this.#rememberIssued(envelope.receipt.previewRevision, portable, false);
    return this.apply({
      command,
      expectedPreviewRevision: envelope.receipt.previewRevision,
    });
  }

  async previewWorkstream(
    command: TeamWorkstreamCommand,
  ): Promise<TeamWorkstreamPreviewEnvelope> {
    this.#root.assertCurrent();
    assertWorkstreamCommand(command);
    let internal = await this.preview(
      command as TeamWorkflowCommand<TWikiPayload>,
    );
    if (!this.#portablePreviewIsFresh(internal.command.authority.occurredAt)) {
      this.#evictIssuedCommand(internal);
      internal = await this.preview(command as TeamWorkflowCommand<TWikiPayload>);
    }
    const prepared = this.#issued.get(internal.previewRevision);
    if (prepared === undefined) throw previewConflict();
    const request = commandFromPrepared(internal.command) as TeamWorkstreamCommand;
    const publicPreview = publicPreviewFrom(internal);
    const purposeIds = workstreamPurposeIdsFromEffects(
      command.action.kind,
      prepared.effects,
    );
    const requestRevision = hashText(boundedWorkstreamEnvelopeJson(request));
    const presentationRevision = hashText(
      boundedWorkstreamEnvelopeJson(publicPreview),
    );
    const receiptBase = {
      schemaVersion: 1 as const,
      authority: internal.command.authority,
      purposeIds,
      requestRevision,
      presentationRevision,
    };
    const signingPayload = receiptSigningPayload(receiptBase);
    assertWorkstreamEnvelope({
      schemaVersion: 1,
      request,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision: "0".repeat(64) },
    });
    this.#receiptSigner.initialize();
    const previewRevision = this.#receiptSigner.sign(signingPayload);
    const envelope = deepFreeze({
      schemaVersion: 1 as const,
      request,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision },
    });
    assertWorkstreamEnvelope(envelope);
    const portable = withPortableEnvelopeAttestation(
      prepared,
      previewRevision,
      workstreamEnvelopeRevision(envelope),
    );
    this.#rememberIssued(previewRevision, portable, false);
    return envelope;
  }

  async applyWorkstream(
    envelopeValue: TeamWorkstreamPreviewEnvelope,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    this.#root.assertCurrent();
    const envelope = parseWorkstreamEnvelope(envelopeValue);
    const command = deepFreeze({
      ...envelope.request,
      authority: envelope.receipt.authority,
    }) as PreparedTeamWorkflowCommand<TWikiPayload>;

    let existing: TeamWorkflowJournalEntry | null = null;
    try {
      existing = this.#local.getWorkflowOperation(command.operationId);
    } catch (error) {
      if (!(error instanceof MexPortError)) throw error;
      if (error.problem.code === "MIGRATION_REQUIRED") {
        existing = null;
      } else if (error.problem.code === "OPERATION_INTERRUPTED") {
        this.#local.initializeForMutation();
        existing = this.#local.getWorkflowOperation(command.operationId);
      } else {
        throw error;
      }
    }
    if (existing !== null) {
      assertJournalEnvelopeAttestation(existing.effects, envelope);
      return this.apply({
        command,
        expectedPreviewRevision: envelope.receipt.previewRevision,
      });
    }

    this.#receiptSigner.verify(
      receiptSigningPayload(envelope.receipt),
      envelope.receipt.previewRevision,
    );
    this.#assertPortablePreviewFresh(envelope.receipt.authority.occurredAt);
    await this.#assertAuthorityCurrent(envelope.receipt.authority);
    const replanned = await this.#plan(
      command,
      envelope.receipt.requestRevision,
      envelope.receipt.purposeIds,
    );
    if (
      boundedWorkstreamEnvelopeJson(publicPreviewFrom(replanned.preview))
        !== boundedWorkstreamEnvelopeJson(envelope.preview)
      || boundedWorkstreamEnvelopeJson(
        workstreamPurposeIdsFromEffects(
          envelope.request.action.kind,
          replanned.effects,
        ),
      ) !== boundedWorkstreamEnvelopeJson(envelope.receipt.purposeIds)
    ) {
      throw previewConflict();
    }
    const portable = withPortableEnvelopeAttestation(
      replanned,
      envelope.receipt.previewRevision,
      workstreamEnvelopeRevision(envelope),
    );
    this.#rememberIssued(envelope.receipt.previewRevision, portable, false);
    return this.apply({
      command,
      expectedPreviewRevision: envelope.receipt.previewRevision,
    });
  }

  async getInboxDraft(id: string): Promise<TeamInboxSpecDraftDetail | null> {
    this.#root.assertCurrent();
    const draft = await this.getLocalDraft(id);
    if (draft === null || draft.kind !== "inbox") return null;
    return productDraftProjection(
      draft as unknown as InboxDraft<JsonValue>,
    );
  }

  async listInboxDrafts(
    request: TeamInboxDraftListRequest = {},
  ): Promise<TeamInboxSpecPage<TeamInboxSpecDraftSummary>> {
    this.#root.assertCurrent();
    const filter = normalizeInboxListFilter(request, false);
    const filterRevision = hashInboxValue({
      changeKinds: filter.changeKinds ?? null,
      entityKinds: filter.entityKinds ?? null,
    });
    const cursor = decodeInboxCursor(filter.cursor);
    if (cursor !== null && cursor.filterRevision !== filterRevision) {
      throw inboxPageConflict();
    }
    const all: TeamInboxSpecDraftDetail[] = [];
    let innerCursor: string | undefined;
    for (;;) {
      const page = this.#local.listLocalDrafts<InboxDraftInput<JsonValue>>({
        kind: "inbox",
        limit: TEAM_INBOX_SPEC_LIMITS.maxPageSize,
        ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
      });
      for (const stored of page.items) {
        const projected = productDraftProjection(
          localDraftProjection(stored) as InboxDraft<JsonValue>,
        );
        if (projected !== null && inboxSummaryMatches(projected, filter)) {
          all.push(projected);
        }
      }
      if (page.nextCursor === null) break;
      innerCursor = page.nextCursor;
    }
    const corpusRevision = hashInboxValue(all.map((item) => ({
      id: item.id,
      revision: item.revision,
    })));
    if (cursor !== null && cursor.corpusRevision !== corpusRevision) {
      throw inboxPageConflict();
    }
    const offset = cursor === null ? 0 : parseInboxOffset(cursor.innerCursor);
    if (offset > all.length) throw inboxPageConflict();
    const items = all.slice(offset, offset + filter.limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < all.length;
    return {
      items: items.map(productDraftSummary),
      nextCursor: hasMore
        ? encodeInboxCursor({
            v: 1,
            innerCursor: String(nextOffset),
            corpusRevision,
            filterRevision,
          })
        : null,
      truncated: hasMore,
      sourceTruncated: false,
      deterministicRevision: hashInboxValue({ corpusRevision, filterRevision }),
      diagnostics: [],
    };
  }

  async getInboxProposal(
    id: string,
  ): Promise<TeamInboxSpecProposalDetail | null> {
    this.#root.assertCurrent();
    const proposal = await this.#proposals.get(id);
    return proposal === null
      ? null
      : productProposalProjection(
          proposal as unknown as InboxProposal<JsonValue>,
        );
  }

  async listInboxProposals(
    request: TeamInboxProposalListRequest = {},
  ): Promise<TeamInboxSpecPage<TeamInboxSpecProposalSummary>> {
    this.#root.assertCurrent();
    const filter = normalizeInboxListFilter(request, true);
    const filterRevision = hashInboxValue({
      changeKinds: filter.changeKinds ?? null,
      entityKinds: filter.entityKinds ?? null,
      states: filter.states ?? null,
    });
    const cursor = decodeInboxCursor(filter.cursor);
    if (cursor !== null && cursor.filterRevision !== filterRevision) {
      throw inboxPageConflict();
    }
    const all: TeamInboxSpecProposalDetail[] = [];
    let innerCursor: string | undefined;
    let corpusRevision: Revision | null = null;
    for (;;) {
      let page: WorkflowRepositoryPage<InboxProposal<TWikiPayload>>;
      try {
        page = await this.#proposals.list({
          limit: TEAM_INBOX_SPEC_LIMITS.maxPageSize,
          ...(filter.states === undefined ? {} : { states: filter.states }),
          ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
        });
      } catch (error) {
        if (
          error instanceof MexPortError
          && error.problem.code === "VALIDATION_FAILED"
          && error.problem.title === "Workflow artifact directory is too large"
        ) {
          throw artifactError(
            "INDEX_CORRUPT",
            "Inbox proposal source is outside its bounded contract",
            "The Inbox proposal directory exceeds the bounded readable source.",
            ".mex/inbox",
          );
        }
        throw error;
      }
      if (corpusRevision === null) corpusRevision = page.deterministicRevision;
      if (corpusRevision !== page.deterministicRevision) throw inboxPageConflict();
      for (const proposal of page.items) {
        const projected = productProposalProjection(
          proposal as unknown as InboxProposal<JsonValue>,
        );
        if (projected !== null && inboxSummaryMatches(projected, filter)) {
          all.push(projected);
        }
      }
      if (page.nextCursor === null) break;
      innerCursor = page.nextCursor;
    }
    corpusRevision ??= hashInboxValue([]);
    if (cursor !== null && cursor.corpusRevision !== corpusRevision) {
      throw inboxPageConflict();
    }
    const offset = cursor === null ? 0 : parseInboxOffset(cursor.innerCursor);
    if (offset > all.length) throw inboxPageConflict();
    const items = all.slice(offset, offset + filter.limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < all.length;
    return {
      items: items.map(productProposalSummary),
      nextCursor: hasMore
        ? encodeInboxCursor({
            v: 1,
            innerCursor: String(nextOffset),
            corpusRevision,
            filterRevision,
          })
        : null,
      truncated: hasMore,
      sourceTruncated: false,
      deterministicRevision: hashInboxValue({ corpusRevision, filterRevision }),
      diagnostics: [],
    };
  }

  async previewInbox(
    commandValue: TeamInboxSpecCommand,
  ): Promise<TeamInboxSpecPreviewEnvelope> {
    this.#root.assertCurrent();
    const command = normalizeTeamInboxSpecCommand(commandValue);
    await this.#assertInboxProductTargets(command);
    const workflowCommand = workflowCommandFromInbox<TWikiPayload>(command);
    let internal = await this.#previewWorkflow(workflowCommand, true, true);
    if (!this.#portablePreviewIsFresh(internal.command.authority.occurredAt)) {
      this.#evictIssuedCommand(internal);
      internal = await this.#previewWorkflow(workflowCommand, true, true);
    }
    const prepared = this.#issued.get(internal.previewRevision);
    if (prepared === undefined) throw previewConflict();
    const publicPreview = inboxPublicPreviewFrom(internal);
    const purposeIds = inboxPurposeIdsFromPrepared(command, prepared);
    const requestRevision = hashText(boundedInboxJson(command));
    let presentationRevision: Revision;
    try {
      presentationRevision = hashText(boundedInboxJson(publicPreview));
    } catch (error) {
      if (
        error instanceof MexPortError
        && error.problem.code === "INVALID_REQUEST"
      ) throw inboxEnvelopeTooLarge();
      throw error;
    }
    const receiptBase = {
      schemaVersion: 1 as const,
      authority: internal.command.authority,
      purposeIds,
      requestRevision,
      presentationRevision,
    };
    const signingPayload = inboxSigningPayload(receiptBase);
    const unsignedEnvelope = {
      schemaVersion: 1,
      request: command,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision: "0".repeat(64) },
    };
    assertInboxEnvelopeFits(unsignedEnvelope);
    parseInboxEnvelope(unsignedEnvelope);
    this.#receiptSigner.initialize();
    const previewRevision = this.#receiptSigner.sign(signingPayload);
    const envelope = deepFreeze({
      schemaVersion: 1 as const,
      request: command,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision },
    });
    assertInboxEnvelopeFits(envelope);
    parseInboxEnvelope(envelope);
    const portable = withPortableEnvelopeAttestation(
      prepared,
      previewRevision,
      inboxEnvelopeRevision(envelope),
    );
    this.#rememberIssued(previewRevision, portable, false);
    return envelope;
  }

  async applyInbox(
    envelopeValue: TeamInboxSpecPreviewEnvelope,
  ): Promise<TeamInboxSpecApplyResult> {
    this.#root.assertCurrent();
    let envelope: TeamInboxSpecPreviewEnvelope;
    try {
      envelope = parseInboxEnvelope(envelopeValue);
    } catch (error) {
      if (
        error instanceof MexPortError
        && error.problem.code === "INVALID_REQUEST"
      ) {
        throw invalidSignedInboxEnvelope();
      }
      throw error;
    }
    assertInboxPreviewContainment(this.#root.path, envelope.preview);
    const workflowRequest = workflowCommandFromInbox<TWikiPayload>(
      envelope.request,
    );
    const command = deepFreeze({
      ...workflowRequest,
      authority: envelope.receipt.authority,
    }) as PreparedTeamWorkflowCommand<TWikiPayload>;

    let existing: TeamWorkflowJournalEntry | null = null;
    try {
      existing = this.#local.getWorkflowOperation(command.operationId);
    } catch (error) {
      if (!(error instanceof MexPortError)) throw error;
      if (error.problem.code === "MIGRATION_REQUIRED") {
        existing = null;
      } else if (error.problem.code === "OPERATION_INTERRUPTED") {
        this.#local.initializeForMutation();
        existing = this.#local.getWorkflowOperation(command.operationId);
      } else {
        throw error;
      }
    }
    let result: TeamWorkflowResult<TWikiPayload>;
    const completedInterruptedOperation = existing !== null
      && existing.phase !== "complete";
    if (existing !== null) {
      assertJournalEnvelopeAttestation(existing.effects, envelope);
      result = await this.apply({
        command,
        expectedPreviewRevision: envelope.receipt.previewRevision,
      });
    } else {
      this.#receiptSigner.verify(
        inboxSigningPayload(envelope.receipt),
        envelope.receipt.previewRevision,
      );
      this.#assertPortablePreviewFresh(envelope.receipt.authority.occurredAt);
      await this.#assertAuthorityCurrent(envelope.receipt.authority);
      const replanned = await this.#plan(
        command,
        envelope.receipt.requestRevision,
        envelope.receipt.purposeIds,
        true,
      );
      if (
        boundedInboxJson(inboxPublicPreviewFrom(replanned.preview))
          !== boundedInboxJson(envelope.preview)
        || boundedInboxJson(inboxPurposeIdsFromPrepared(envelope.request, replanned))
          !== boundedInboxJson(envelope.receipt.purposeIds)
      ) {
        throw previewConflict();
      }
      const portable = withPortableEnvelopeAttestation(
        replanned,
        envelope.receipt.previewRevision,
        inboxEnvelopeRevision(envelope),
      );
      this.#rememberIssued(envelope.receipt.previewRevision, portable, false);
      result = await this.apply({
        command,
        expectedPreviewRevision: envelope.receipt.previewRevision,
      });
    }
    const proposals = result.artifacts.flatMap((artifact) => {
      if (artifact.kind !== "proposal") return [];
      const projected = productProposalProjection(
        artifact as unknown as InboxProposal<JsonValue>,
      );
      return projected === null ? [] : [projected];
    });
    return {
      operationId: result.operationId,
      previewRevision: result.previewRevision,
      applied: true,
      idempotentReplay: completedInterruptedOperation
        ? false
        : result.idempotentReplay,
      changes: result.changes,
      localChanges: result.localChanges.filter(
        (change) => change.namespace === "inbox-draft",
      ) as TeamInboxSpecApplyResult["localChanges"],
      proposals,
      events: result.events as TeamInboxSpecApplyResult["events"],
    };
  }

  async getRelayDraft(id: string): Promise<TeamRelayDraftDetail | null> {
    this.#root.assertCurrent();
    const draft = await this.getLocalDraft(id);
    if (draft === null || draft.kind !== "relay") return null;
    return relayDraftProjection(draft);
  }

  async listRelayDrafts(
    request: TeamRelayDraftListRequest = {},
  ): Promise<TeamRelayPage<TeamRelayDraftSummary>> {
    this.#root.assertCurrent();
    if (!isPlainObject(request)) throw invalidRelayList();
    exactObjectKeys(request, [], ["cursor", "limit"]);
    const cursor = request.cursor;
    const limit = request.limit;
    if (cursor !== undefined && typeof cursor !== "string") throw invalidRelayList();
    if (limit !== undefined && typeof limit !== "number") throw invalidRelayList();
    const page = await this.listLocalDrafts({
      kind: "relay",
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    const details = page.items.map((draft) => {
      if (draft.kind !== "relay") throw invalidRelayList();
      return relayDraftProjection(draft);
    });
    return {
      ...page,
      items: details.map(relayDraftSummary),
      deterministicRevision: hashRelayValue(details.map((draft) => ({
        id: draft.id,
        revision: draft.revision,
      }))),
    };
  }

  async getRelay(id: string): Promise<TeamRelayDetail | null> {
    this.#root.assertCurrent();
    const relay = await this.#relays.get(id);
    return relay === null ? null : relayProjection(relay);
  }

  async listRelays(
    request: TeamRelayListRequest = {},
  ): Promise<TeamRelayPage<TeamRelaySummary>> {
    this.#root.assertCurrent();
    const filter = normalizeRelayListFilter(request);
    // Team-wide observation has no actor-dependent predicate. Avoid resolving
    // local identity for it so bounded aggregates can reuse their one explicit
    // current-actor resolution without a hidden second lookup.
    const currentMemberId = filter.perspective === "all"
      ? null
      : await this.#activeRelayMemberOrNull();
    if (filter.perspective !== "all" && currentMemberId === null) {
      throw relayUnauthorized(
        "Select an active Member, or configure one unique active Git alias, to view personal Relays.",
      );
    }
    const memberId = currentMemberId;
    const filterRevision = hashRelayValue({
      perspective: filter.perspective,
      states: filter.states,
      workstreamId: filter.workstreamId,
      memberId,
    });
    const cursor = decodeRelayCursor(filter.cursor);
    if (cursor !== null && cursor.filterRevision !== filterRevision) {
      throw relayPageConflict();
    }
    const all: TeamRelayDetail[] = [];
    const diagnostics: Diagnostic[] = [];
    let sourceTruncated = false;
    let innerCursor: string | undefined;
    let corpusRevision: Revision | null = null;
    for (;;) {
      const page = await this.#relays.list({
        limit: TEAM_RELAY_LIMITS.maxPageSize,
        includeArchived: true,
        ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
      });
      if (corpusRevision === null) corpusRevision = page.deterministicRevision;
      if (corpusRevision !== page.deterministicRevision) throw relayPageConflict();
      sourceTruncated ||= page.sourceTruncated;
      const availableDiagnostics = Math.max(0, 100 - diagnostics.length);
      if (page.diagnostics.length > availableDiagnostics) sourceTruncated = true;
      diagnostics.push(...page.diagnostics.slice(0, availableDiagnostics));
      for (const stored of page.items) {
        if (
          filter.states !== null
          && !filter.states.includes(stored.state)
        ) continue;
        if (
          filter.workstreamId !== null
          && ((stored.schemaVersion === 3 || stored.schemaVersion === 4)
            || stored.workstream.id !== filter.workstreamId)
        ) continue;
        if (filter.perspective === "sent") {
          if (stored.sender.kind !== "member" || stored.sender.memberId !== memberId) continue;
        } else if (filter.perspective === "mine") {
          const mine = stored.state === "published"
            ? stored.audience === "team" || stored.recipients.some(
                (recipient) => recipient.kind === "member" && recipient.memberId === memberId,
              )
            : stored.acknowledgedBy?.kind === "member"
              && stored.acknowledgedBy.memberId === memberId;
          if (!mine) continue;
        }
        all.push(relayProjection(stored));
      }
      if (page.nextCursor === null) break;
      innerCursor = page.nextCursor;
    }
    corpusRevision ??= hashRelayValue([]);
    if (cursor !== null && cursor.corpusRevision !== corpusRevision) {
      throw relayPageConflict();
    }
    all.sort(compareRelayProjection);
    const offset = cursor?.offset ?? 0;
    if (offset > all.length) throw relayPageConflict();
    const details = all.slice(offset, offset + filter.limit);
    const nextOffset = offset + details.length;
    const hasMore = nextOffset < all.length;
    const hasLegacy = all.some((relay) => relay.publishedAt === null);
    const aggregatedDiagnostics = aggregateRelayDiagnostics(
      diagnostics,
      hasLegacy,
      sourceTruncated,
    );
    return {
      items: details.map(relaySummary),
      nextCursor: hasMore
        ? encodeRelayCursor({
            v: 1,
            offset: nextOffset,
            corpusRevision,
            filterRevision,
          })
        : null,
      truncated: hasMore,
      sourceTruncated: aggregatedDiagnostics.sourceTruncated,
      deterministicRevision: hashRelayValue({ corpusRevision, filterRevision }),
      diagnostics: aggregatedDiagnostics.diagnostics,
    };
  }

  async previewRelay(
    commandValue: TeamRelayCommand,
  ): Promise<TeamRelayPreviewEnvelope> {
    this.#root.assertCurrent();
    const command = this.#normalizeRelayPreviewCommand(commandValue);
    const workflowCommand = command as TeamWorkflowCommand<TWikiPayload>;
    let internal = await this.#previewWorkflow(workflowCommand, true);
    if (!this.#portablePreviewIsFresh(internal.command.authority.occurredAt)) {
      this.#evictIssuedCommand(internal);
      internal = await this.#previewWorkflow(workflowCommand, true);
    }
    const prepared = this.#issued.get(internal.previewRevision);
    if (prepared === undefined) throw previewConflict();
    const publicPreview = relayPublicPreviewFrom(internal);
    const purposeIds = relayPurposeIdsFromPrepared(command, prepared);
    const requestRevision = hashText(boundedRelayJson(command));
    let presentationRevision: Revision;
    try {
      presentationRevision = hashText(boundedRelayJson(publicPreview));
    } catch (error) {
      if (error instanceof MexPortError && error.problem.code === "INVALID_REQUEST") {
        throw relayEnvelopeTooLarge();
      }
      throw error;
    }
    const receiptBase = {
      schemaVersion: 1 as const,
      authority: internal.command.authority,
      purposeIds,
      requestRevision,
      presentationRevision,
    };
    const unsigned = {
      schemaVersion: 1 as const,
      request: command,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision: "0".repeat(64) },
    };
    assertRelayEnvelopeFits(unsigned);
    parseRelayEnvelope(unsigned);
    this.#receiptSigner.initialize();
    const previewRevision = this.#receiptSigner.sign(
      relaySigningPayload(receiptBase),
    );
    const envelope = deepFreeze({
      schemaVersion: 1 as const,
      request: command,
      preview: publicPreview,
      receipt: { ...receiptBase, previewRevision },
    });
    assertRelayEnvelopeFits(envelope);
    parseRelayEnvelope(envelope);
    const portable = withPortableEnvelopeAttestation(
      prepared,
      previewRevision,
      relayEnvelopeRevision(envelope),
    );
    this.#rememberIssued(previewRevision, portable, false);
    return envelope;
  }

  #normalizeRelayPreviewCommand(commandValue: TeamRelayCommand): TeamRelayCommand {
    let command: TeamRelayCommand;
    let strictError: unknown = null;
    const rawLegacyDraft = isRawLegacyRelayDraftCommand(commandValue);
    try {
      command = normalizeTeamRelayCommand(commandValue);
    } catch (currentError) {
      strictError = currentError;
      try {
        command = rawLegacyDraft
          ? normalizeTranslatedLegacyRelayDraftCommand(commandValue)
          : normalizeExistingRelayDraftMigrationCommand(commandValue);
      } catch {
        throw currentError;
      }
    }
    if (
      command.action.kind !== "relay.draft.save"
      || command.action.draftId === undefined
    ) return command;
    const current = requiredDraft<TWikiPayload>(
      this.#local.getLocalDraft(command.action.draftId),
      "relay",
    );
    let stored: RelayDraftInput;
    try {
      stored = normalizeStoredRelayProductDraftInput(current.payload);
    } catch {
      if (strictError !== null) throw strictError;
      return command;
    }
    if (stored.evidence.length !== 65) {
      if (strictError !== null) throw strictError;
      return command;
    }
    requireLocalExpectation(
      command.expectedRevisions,
      "relay-draft",
      command.action.draftId,
      current.revision,
    );
    if (
      command.action.draft.evidence.length < 1
      || stableJson(stored.evidence[0])
        !== stableJson(command.action.draft.evidence[0])
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid Relay migration evidence",
        "Saving this migrated Relay draft must preserve its translated Workstream evidence as the first evidence entry.",
      );
    }
    return command;
  }

  async applyRelay(
    envelopeValue: TeamRelayPreviewEnvelope,
  ): Promise<TeamRelayApplyResult> {
    this.#root.assertCurrent();
    let envelope: TeamRelayPreviewEnvelope;
    let legacyPublishTopology = false;
    try {
      envelope = parseRelayEnvelope(envelopeValue);
    } catch (error) {
      try {
        envelope = parsePreV3RelayPublishEnvelope(envelopeValue);
        legacyPublishTopology = true;
      } catch {
        if (error instanceof MexPortError && error.problem.code === "INVALID_REQUEST") {
          throw invalidSignedRelayEnvelope();
        }
        throw error;
      }
    }
    assertRelayPreviewContainment(this.#root.path, envelope.preview);
    const command = deepFreeze({
      ...envelope.request,
      authority: envelope.receipt.authority,
    }) as PreparedTeamWorkflowCommand<TWikiPayload>;
    let existing: TeamWorkflowJournalEntry | null = null;
    try {
      existing = this.#local.getWorkflowOperation(command.operationId);
    } catch (error) {
      if (!(error instanceof MexPortError)) throw error;
      if (error.problem.code === "MIGRATION_REQUIRED") {
        existing = null;
      } else if (error.problem.code === "OPERATION_INTERRUPTED") {
        this.#local.initializeForMutation();
        existing = this.#local.getWorkflowOperation(command.operationId);
      } else {
        throw error;
      }
    }
    const completedInterruptedOperation = existing !== null
      && existing.phase !== "complete";
    if (legacyPublishTopology && existing === null) {
      throw preV3RelayPreviewRequiresRefresh();
    }
    let result: TeamWorkflowResult<TWikiPayload>;
    if (existing !== null) {
      assertJournalEnvelopeAttestation(existing.effects, envelope);
      result = await this.apply({
        command,
        expectedPreviewRevision: envelope.receipt.previewRevision,
      });
    } else {
      this.#receiptSigner.verify(
        relaySigningPayload(envelope.receipt),
        envelope.receipt.previewRevision,
      );
      this.#assertPortablePreviewFresh(envelope.receipt.authority.occurredAt);
      await this.#assertPreWriteFreshnessAndDependencies(command);
      const replanned = await this.#plan(
        command,
        envelope.receipt.requestRevision,
        envelope.receipt.purposeIds,
      );
      if (
        boundedRelayJson(relayPublicPreviewFrom(replanned.preview))
          !== boundedRelayJson(envelope.preview)
        || boundedRelayJson(relayPurposeIdsFromPrepared(envelope.request, replanned))
          !== boundedRelayJson(envelope.receipt.purposeIds)
      ) throw previewConflict();
      const portable = withPortableEnvelopeAttestation(
        replanned,
        envelope.receipt.previewRevision,
        relayEnvelopeRevision(envelope),
      );
      this.#rememberIssued(envelope.receipt.previewRevision, portable, false);
      result = await this.apply({
        command,
        expectedPreviewRevision: envelope.receipt.previewRevision,
      });
    }
    return {
      operationId: result.operationId,
      previewRevision: result.previewRevision,
      applied: true,
      idempotentReplay: completedInterruptedOperation
        ? false
        : result.idempotentReplay,
      changes: result.changes,
      localChanges: result.localChanges.filter(
        (change) => change.namespace === "relay-draft",
      ) as TeamRelayApplyResult["localChanges"],
      relays: result.artifacts.flatMap((artifact) =>
        artifact.kind === "relay" ? [relayProjection(artifact)] : []),
      events: result.events as TeamRelayApplyResult["events"],
    };
  }

  async getArtifact(ref: EntityRef): Promise<TeamArtifact<TWikiPayload> | null> {
    this.#root.assertCurrent();
    switch (ref.kind) {
      case "member": return this.#members.get(ref.id);
      case "workstream": return this.#workstreams.get(ref.id);
      case "proposal": return this.#proposals.get(ref.id);
      case "relay": return this.#relays.get(ref.id);
      case "playbook": return this.#playbooks.get(ref.id);
      case "playbook_run": return this.#runs.get(ref.id);
      default: return null;
    }
  }

  async listArtifacts(
    request: TeamArtifactListRequest = {},
  ): Promise<TeamPage<TeamArtifact<TWikiPayload>>> {
    this.#root.assertCurrent();
    return this.#listArtifacts(request);
  }

  async getLocalDraft(id: string): Promise<LocalDraft<TWikiPayload> | null> {
    this.#root.assertCurrent();
    const stored = this.#local.getLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput>(id);
    return stored === null ? null : localDraftProjection(stored);
  }

  async listLocalDrafts(
    request: LocalDraftListRequest = {},
  ): Promise<TeamPage<LocalDraft<TWikiPayload>>> {
    this.#root.assertCurrent();
    if (request.kind !== undefined && request.kind !== "inbox" && request.kind !== "relay") {
      throw invalidLocalDraftList();
    }
    if (
      request.cursor !== undefined
      && (typeof request.cursor !== "string"
        || Buffer.byteLength(request.cursor, "utf8") > MAX_CURSOR_BYTES)
    ) {
      throw invalidLocalDraftList();
    }
    const limit = normalizeLimit(request.limit);
    let page;
    try {
      page = this.#local.listLocalDrafts<InboxDraftInput<TWikiPayload> | RelayDraftInput>({
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        limit,
      });
    } catch (error) {
      if (error instanceof MexPortError && error.problem.code === "VALIDATION_FAILED") {
        throw invalidLocalDraftList();
      }
      throw error;
    }
    const items = page.items.map(localDraftProjection);
    return {
      items,
      nextCursor: page.nextCursor,
      truncated: page.truncated,
      sourceTruncated: false,
      deterministicRevision: revisionOf(stableJson(items.map((item) => ({
        id: item.id,
        kind: item.kind,
        revision: item.revision,
      })))),
      diagnostics: [],
    };
  }

  async preview(
    command: TeamWorkflowCommand<TWikiPayload>,
  ): Promise<TeamWorkflowPreview<TWikiPayload>> {
    const relayAction = isPlainObject(command)
      && isPlainObject(command.action)
      && typeof command.action.kind === "string"
      && command.action.kind.startsWith("relay.");
    const normalized = relayAction
      ? this.#normalizeRelayPreviewCommand(
          command as unknown as TeamRelayCommand,
        ) as TeamWorkflowCommand<TWikiPayload>
      : command;
    return this.#previewWorkflow(normalized, false);
  }

  async #previewWorkflow(
    command: TeamWorkflowCommand<TWikiPayload>,
    bypassCache: boolean,
    governedInbox = false,
  ): Promise<TeamWorkflowPreview<TWikiPayload>> {
    this.#root.assertCurrent();
    assertCommandShape(command);
    assertOperationId(command.operationId);
    assertNoCallerAuthority(command);
    boundedStableJson(command);
    const callerCommand = cloneCommand(command);
    callerCommand.expectedRevisions = normalizeWorkflowRevisionExpectations(
      command.expectedRevisions,
    ) as typeof callerCommand.expectedRevisions;
    const commandRevision = hashText(boundedStableJson(callerCommand));
    const cachedRevision = bypassCache
      ? undefined
      : this.#issuedByCommand.get(commandRevision);
    const cached = cachedRevision === undefined
      ? undefined
      : this.#issued.get(cachedRevision);
    if (cached !== undefined) {
      await this.#assertCommandAuthorityCurrent(cached.preview.command);
      return cached.preview;
    }
    const actor = actionAllowsStaleSelectionFallback(callerCommand.action.kind)
      ? (await this.#resolveCurrentActorDetailed()).actor
      : await this.resolveActor();
    const occurredAt = this.#nowIso();
    const repoState = await this.#git.getRepoState();
    const preparedCommand = deepFreeze({
      ...callerCommand,
      authority: { actor, occurredAt, repoState },
    }) as PreparedTeamWorkflowCommand<TWikiPayload>;
    const prepared = await this.#plan(
      preparedCommand,
      commandRevision,
      undefined,
      governedInbox,
    );
    this.#rememberIssued(prepared.preview.previewRevision, prepared, true);
    return prepared.preview;
  }

  #rememberIssued(
    revision: Revision,
    prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
    bindCallerCommand: boolean,
  ): void {
    this.#issued.set(revision, prepared);
    if (bindCallerCommand) {
      this.#issuedByCommand.set(prepared.callerCommandRevision, revision);
    }
    while (this.#issued.size > MAX_ISSUED_PREVIEWS) {
      const oldest = this.#issued.keys().next().value as Revision | undefined;
      if (oldest === undefined) break;
      const removed = this.#issued.get(oldest);
      this.#issued.delete(oldest);
      if (
        removed !== undefined
        && this.#issuedByCommand.get(removed.callerCommandRevision) === oldest
      ) {
        this.#issuedByCommand.delete(removed.callerCommandRevision);
      }
    }
  }

  #evictIssuedCommand(preview: TeamWorkflowPreview<TWikiPayload>): void {
    const prepared = this.#issued.get(preview.previewRevision);
    if (prepared === undefined) return;
    for (const [revision, candidate] of this.#issued) {
      if (candidate.callerCommandRevision === prepared.callerCommandRevision) {
        this.#issued.delete(revision);
      }
    }
    if (
      this.#issuedByCommand.get(prepared.callerCommandRevision)
        === preview.previewRevision
    ) {
      this.#issuedByCommand.delete(prepared.callerCommandRevision);
    }
  }

  async apply(
    request: TeamWorkflowApplyRequest<TWikiPayload>,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    this.#root.assertCurrent();
    if (!isPlainObject(request)) invalidApplyRequest();
    exactObjectKeys(request, ["command", "expectedPreviewRevision"]);
    if (!isRevision(request.expectedPreviewRevision)) throw previewConflict();
    assertPreparedCommandShape(request.command);
    const serializedCommand = boundedStableJson(request.command);
    const commandRevision = hashText(serializedCommand);
    let requiresMigration = false;
    let existing: TeamWorkflowJournalEntry | null;
    try {
      existing = this.#local.getWorkflowOperation(request.command.operationId);
    } catch (error) {
      if (!(error instanceof MexPortError)) {
        throw error;
      }
      if (error.problem.code === "MIGRATION_REQUIRED") {
        requiresMigration = true;
        existing = null;
      } else if (error.problem.code === "OPERATION_INTERRUPTED") {
        // This is an explicit write request, so opening the database writable
        // may complete SQLite's own rollback-journal recovery. Re-read the
        // operation only after that bounded recovery; immutable reads never do
        // this and continue to fail closed on every sidecar.
        this.#local.initializeForMutation();
        existing = this.#local.getWorkflowOperation(request.command.operationId);
      } else {
        throw error;
      }
    }
    if (existing !== null) {
      if (
        existing.commandRevision !== commandRevision
        || existing.previewRevision !== request.expectedPreviewRevision
      ) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Workflow operation replay changed",
          "The operation ID is bound to a different prepared command or preview.",
        );
      }
      return this.#recoverExisting(existing, request.command);
    }

    const prepared = this.#issued.get(request.expectedPreviewRevision);
    if (
      prepared === undefined
      || prepared.preview.previewRevision !== request.expectedPreviewRevision
      || stableJson(prepared.preview.command) !== stableJson(request.command)
    ) {
      throw previewConflict();
    }
    // First pass is immutable, so already-stale or escaping inputs fail with
    // byte-identical project/local state. The same pass is repeated while the
    // Team writer lease is held to close the inter-port race.
    await this.#preflightPrepared(prepared, false);
    // Apply is the first caller-authorized local write. Preview and every read
    // above remain immutable, including against legacy v1-v3 databases.
    if (requiresMigration || existing === null) this.#local.initializeForMutation();
    const leaseToken = this.#acquireLease();
    let activityPublication: PreparedActivityPublication | null;
    try {
      activityPublication = await this.#preflightPrepared(prepared, true);
    } catch (error) {
      this.#local.releaseTeamWorkflowLease(leaseToken);
      this.#heldLeaseToken = null;
      throw error;
    }
    let journal: TeamWorkflowJournalEntry;
    try {
      journal = this.#local.beginWorkflowOperation({
        leaseToken,
        operationId: request.command.operationId,
        commandRevision: prepared.commandRevision,
        previewRevision: prepared.preview.previewRevision,
        effects: prepared.effects,
      }).entry;
    } catch (error) {
      if (this.#local.getIncompleteWorkflowOperation() === null) {
        this.#local.releaseTeamWorkflowLease(leaseToken);
        this.#heldLeaseToken = null;
      }
      throw error;
    }
    try {
      await this.#runPhaseHook("before-canonical-publication");
      this.#root.assertCurrent();
      await this.#assertPreWriteFreshnessAndDependencies(
        prepared.preview.command,
      );
      await this.#assertInboxActionDependencies(prepared.preview.command);
      const primary = await prepared.applyPrimary();
      await this.#runPhaseHook("after-canonical-publication");
      if (isAuditOnlyEffects(prepared.effects)) {
        await this.#assertCommandAuthorityCurrent(prepared.preview.command);
      } else {
        await this.#assertPostPrimaryRepository(prepared.preview.command.authority.repoState);
      }
      const event = activityPublication === null ? null : await activityPublication.publish();
      await this.#runPhaseHook("after-activity-publication");
      journal = this.#advanceJournal(journal, leaseToken, "canonical_published");
      journal = this.#advanceJournal(
        journal,
        leaseToken,
        "local_finalized",
        prepared.cleanup.map((effect) => ({
          kind: effect.draftKind,
          id: effect.draftId,
          expectedRevision: effect.expectedRevision,
        })),
      );
      await this.#runPhaseHook("after-local-cleanup");
      journal = this.#advanceJournal(journal, leaseToken, "complete");
      this.#local.releaseTeamWorkflowLease(leaseToken);
      this.#heldLeaseToken = null;
      this.#issued.delete(request.expectedPreviewRevision);
      this.#issuedByCommand.delete(prepared.callerCommandRevision);
      return {
        operationId: request.command.operationId,
        previewRevision: request.expectedPreviewRevision,
        applied: true,
        idempotentReplay: false,
        changes: prepared.preview.changes,
        localChanges: prepared.preview.localChanges,
        artifacts: primary.artifacts,
        events: event === null ? [] : [event],
      };
    } catch (error) {
      // A simulated/process interruption deliberately leaves the durable lease
      // and journal in place. A new instance must prove every effect on replay.
      if (error instanceof WorkflowPhaseInterruption) throw error;
      try {
        const current = this.#local.getWorkflowOperation(journal.operationId);
        let mayAbandon = false;
        const recovery = current?.effects.find(
          (effect): effect is WikiRecoveryWorkflowEffect => effect.kind === "wiki_recovery",
        );
        if (current?.phase === "intent" && prepared.wiki !== undefined && recovery !== undefined) {
          const port = asRecoverableWikiPort(this.#wiki);
          if (port !== null) {
            mayAbandon = port.inspectOperationRecovery(prepared.wiki.request).state === "none"
              && this.#primaryEffectState(current.effects) === "none";
          }
        } else if (current?.phase === "intent" && prepared.wiki === undefined) {
          mayAbandon = this.#primaryEffectState(current.effects) === "none"
            || this.#isAuditOnlyPending(current.effects);
        } else if (current?.phase === "intent" && recovery === undefined) {
          mayAbandon = this.#primaryEffectState(current.effects) === "none"
            || this.#isAuditOnlyPending(current.effects);
        }
        if (
          current?.phase === "intent"
          && mayAbandon
        ) {
          this.#local.abandonWorkflowOperation({
            leaseToken,
            operationId: current.operationId,
            commandRevision: current.commandRevision,
            previewRevision: current.previewRevision,
            expectedRevision: current.revision,
          });
          this.#local.releaseTeamWorkflowLease(leaseToken);
          this.#heldLeaseToken = null;
        }
      } catch {
        // Preserve the original actionable error and the durable recovery state.
      }
      throw error;
    }
  }

  async #plan(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    callerCommandRevision: Revision,
    purposeIds?: readonly PortableWorkflowPurposeId[],
    governedInbox = false,
  ): Promise<PreparedOperation<TWikiPayload, TWikiPlan>> {
    const planned = await this.#planPrimary(
      command,
      undefined,
      purposeIds,
      governedInbox,
    );
    if (planned.wiki?.preview.recoveryManifest !== undefined) {
      assertWikiRecoveryManifestMatchesChanges(
        planned.wiki.preview.recoveryManifest,
        planned.wiki.preview.changes,
      );
    }
    const plannedActivity = planned.activityInput;
    const activity = plannedActivity === null
      ? null
      : await (async () => {
          const { origin, label, ...input } = plannedActivity;
          return this.#activity.previewCreateWithAuthority({
            ...input,
            actor: command.authority.actor,
          }, {
            timestamp: command.authority.occurredAt,
            repoState: command.authority.repoState,
          }, purposeId(purposeIds, "activity"), {
            origin,
            ...(label === undefined ? {} : { label }),
          });
        })();
    const changes = [
      ...planned.changes,
      ...(activity?.changes ?? []),
    ];
    const effects = normalizeTeamWorkflowJournalEffects([
      ...planned.effects,
      ...(planned.wiki?.preview.recoveryManifest === undefined
        ? []
        : [{
            kind: "wiki_recovery" as const,
            manifest: planned.wiki.preview.recoveryManifest,
          }]),
      ...(activity === null ? [] : [activityEffect(activity)]),
      ...planned.cleanup,
    ]);
    if (
      effects.length > TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffects
      || Buffer.byteLength(stableJson(effects), "utf8") > TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Workflow recovery plan is too large",
        "The bounded workflow recovery plan exceeds its effect or byte limit.",
      );
    }
    const scope = changes.length === 0 ? "local"
      : planned.localChanges.length === 0 ? "canonical" : "mixed";
    const previewRevision = hashJson({
      v: 1,
      command,
      callerCommandRevision,
      changes,
      localChanges: planned.localChanges,
      innerRevisions: [...planned.innerRevisions, activity?.previewRevision ?? null],
    });
    const preview = deepFreeze({
      operationId: command.operationId,
      previewRevision,
      valid: true,
      scope,
      changes,
      localChanges: planned.localChanges,
      diagnostics: planned.diagnostics,
      command,
    }) satisfies TeamWorkflowPreview<TWikiPayload>;
    return {
      callerCommandRevision,
      commandRevision: hashJson(command),
      preview,
      effects,
      activity,
      applyPrimary: async () => {
        const result = await planned.applyPrimary();
        await this.#afterPrimaryApply();
        return result;
      },
      cleanup: planned.cleanup,
      ...(planned.wiki === undefined ? {} : { wiki: planned.wiki }),
    };
  }

  async #planPrimary(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    recoveryEffects?: readonly TeamWorkflowJournalEffect[],
    purposeIds?: readonly PortableWorkflowPurposeId[],
    governedInbox = false,
  ): Promise<{
    changes: readonly FileChange[];
    localChanges: readonly LocalStateChange[];
    diagnostics: readonly Diagnostic[];
    effects: readonly (CanonicalWorkflowEffect | LocalWorkflowEffect)[];
    cleanup: readonly LocalCleanupWorkflowEffect[];
    innerRevisions: readonly (Revision | null)[];
    activityInput: PlannedActivityInput | null;
    applyPrimary(): Promise<PrimaryResult<TWikiPayload>>;
    wiki?: { request: WikiOperationRequest<TWikiPayload>; preview: WikiOperationPreview<TWikiPlan> };
  }> {
    const { action, expectedRevisions, authority } = command;
    switch (action.kind) {
      case "member.add": {
        const recoveryId = recoveryCanonicalId(recoveryEffects, "member")
          ?? purposeId(purposeIds, "member");
        const plan = await this.#members.previewCreate({
          ...(recoveryId === null || recoveryId === undefined
            ? {}
            : { id: recoveryId }),
          displayName: action.member.displayName,
          gitAliases: action.member.gitAliases,
          active: action.member.active ?? true,
        });
        return canonicalPlan<TWikiPayload>(plan, "member", plan.member.ref.id, workflowActivity("member.add", {
          action: "member.added",
          subjects: [entitySubject(plan.member.ref)],
        }, plan.member.displayName), async () => {
          const applied = await this.#members.apply(plan, plan.previewRevision);
          return primary([applied.member], [applied.change]);
        });
      }
      case "member.update": {
        const current = await required(this.#members.get(action.memberId), "Member");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const plan = await this.#members.previewUpdate(action.memberId, action.patch, current.revision);
        if (plan.member.revision === current.revision) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Member update has no changes",
            `Member ${action.memberId} already has the proposed display name and Git identities.`,
            current.sourcePath,
          );
        }
        return canonicalPlan<TWikiPayload>(plan, "member", action.memberId, workflowActivity("member.update", {
          action: "member.updated",
          subjects: [entitySubject(plan.member.ref)],
        }, plan.member.displayName), async () => {
          const applied = await this.#members.apply(plan, plan.previewRevision);
          return primary([applied.member], [applied.change]);
        });
      }
      case "member.deactivate": {
        const current = await required(this.#members.get(action.memberId), "Member");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        if (!current.active) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Member is already inactive",
            `Member ${action.memberId} is already inactive.`,
            current.sourcePath,
          );
        }
        this.#assertMemberIsNotSelected(action.memberId);
        const plan = await this.#members.previewUpdate(
          action.memberId,
          { active: false },
          current.revision,
        );
        return canonicalPlan<TWikiPayload>(plan, "member", action.memberId, workflowActivity("member.deactivate", {
          action: "member.deactivated",
          subjects: [entitySubject(plan.member.ref)],
        }, plan.member.displayName), async () => {
          const applied = await this.#members.apply(plan, plan.previewRevision);
          return primary([applied.member], [applied.change]);
        });
      }
      case "member.reactivate": {
        const current = await required(this.#members.get(action.memberId), "Member");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const plan = await this.#members.previewReactivate(action.memberId, current.revision);
        return canonicalPlan<TWikiPayload>(plan, "member", action.memberId, workflowActivity("member.reactivate", {
          action: "member.reactivated",
          subjects: [entitySubject(plan.member.ref)],
        }, plan.member.displayName), async () => {
          const applied = await this.#members.apply(plan, plan.previewRevision);
          return primary([applied.member], [applied.change]);
        });
      }
      case "member.select": {
        const member = await required(this.#members.get(action.memberId), "Member");
        requireArtifactExpectation(expectedRevisions, member.sourcePath, member.revision);
        if (!member.active) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Inactive member cannot be selected",
            `Member ${action.memberId} is inactive.`,
            member.sourcePath,
          );
        }
        const current = this.#local.getConfiguredMember();
        requireLocalExpectation(
          expectedRevisions,
          MEMBER_SELECTION_NAMESPACE,
          MEMBER_SELECTION_ID,
          current?.revision ?? null,
        );
        const selected = this.#local.previewConfigureMember({
          memberId: action.memberId,
          expectedRevision: current?.revision ?? null,
          updatedAt: authority.occurredAt,
        });
        const change = memberSelectionChange(
          current?.revision ?? null,
          selected.revision,
          "Select current member",
        );
        return {
          changes: [],
          localChanges: [change],
          diagnostics: [],
          effects: [{
            kind: "local",
            namespace: MEMBER_SELECTION_NAMESPACE,
            id: MEMBER_SELECTION_ID,
            beforeRevision: current?.revision ?? null,
            afterRevision: selected.revision,
          }],
          cleanup: [],
          innerRevisions: [member.revision, selected.revision],
          activityInput: null,
          applyPrimary: async () => {
            const applied = this.#local.configureMember({
              memberId: action.memberId,
              expectedRevision: current?.revision ?? null,
              updatedAt: authority.occurredAt,
            });
            return primary([], [], [memberSelectionChange(
              current?.revision ?? null,
              applied.revision,
              "Select current member",
            )]);
          },
        };
      }
      case "member.clear": {
        const currentRevision = requiredLocalRevision(
          expectedRevisions,
          MEMBER_SELECTION_NAMESPACE,
          MEMBER_SELECTION_ID,
        );
        const current = this.#local.previewClearConfiguredMember({
          expectedRevision: currentRevision,
        });
        const change = memberSelectionChange(
          current.revision,
          null,
          "Clear current member",
        );
        return {
          changes: [],
          localChanges: [change],
          diagnostics: [],
          effects: [{
            kind: "local",
            namespace: MEMBER_SELECTION_NAMESPACE,
            id: MEMBER_SELECTION_ID,
            beforeRevision: current.revision,
            afterRevision: null,
          }],
          cleanup: [],
          innerRevisions: [current.revision],
          activityInput: null,
          applyPrimary: async () => {
            this.#local.clearConfiguredMember({
              expectedRevision: current.revision,
            });
            return primary([], [], [change]);
          },
        };
      }
      case "activity.record":
        return {
          changes: [],
          localChanges: [],
          diagnostics: [],
          effects: [],
          cleanup: [],
          innerRevisions: [],
          activityInput: {
            ...action.activity,
            origin: { kind: "custom" },
          },
          applyPrimary: async () => primary([], []),
        };
      case "workstream.create": {
        const recoveryId = recoveryCanonicalId(recoveryEffects, "workstream")
          ?? purposeId(purposeIds, "workstream");
        const plan = await this.#workstreams.previewCreate({
          ...(recoveryId === null || recoveryId === undefined
            ? {}
            : { id: recoveryId }),
          ...action.workstream,
          contributors: action.workstream.contributors ?? [],
          paths: action.workstream.paths ?? [],
          code: action.workstream.code ?? [],
          topics: action.workstream.topics ?? [],
          components: action.workstream.components ?? [],
          related: action.workstream.related ?? [],
          blockers: [],
          currentState: "Planned",
          createdBy: authority.actor,
          createdAt: authority.occurredAt,
          updatedBy: authority.actor,
          updatedAt: authority.occurredAt,
        });
        return canonicalWorkflowPlan(plan, "workstream", plan.artifact.ref.id, workflowActivity("workstream.create", {
          action: "workstream.created",
          subjects: [entitySubject(plan.artifact.ref)],
          workstream: plan.artifact.ref,
        }, plan.artifact.title), this.#workstreams);
      }
      case "workstream.update":
      case "workstream.archive": {
        if (
          action.kind === "workstream.update"
          && (Object.keys(action.patch).length === 0
            || action.patch.state === "archived")
        ) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Invalid Workstream update",
            action.patch.state === "archived"
              ? "Use the dedicated Workstream archive action to preserve archival history."
              : "A Workstream update must change at least one caller-owned field.",
          );
        }
        const current = await required(this.#workstreams.get(action.workstreamId), "Workstream");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const patch = action.kind === "workstream.archive"
          ? { state: "archived" as const, blockers: [] }
          : action.patch;
        const plan = await this.#workstreams.previewUpdate(action.workstreamId, {
          ...withoutStored(current),
          ...patch,
          updatedBy: authority.actor,
          updatedAt: authority.occurredAt,
        }, current.revision);
        if (
          action.kind === "workstream.update"
          && workstreamCallerProjectionIsEqual(current, plan.artifact)
        ) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Invalid Workstream update",
            "A Workstream update must change at least one caller-owned field.",
          );
        }
        return canonicalWorkflowPlan(plan, "workstream", action.workstreamId, workflowActivity(action.kind, {
          action: action.kind === "workstream.archive" ? "workstream.archived" : "workstream.updated",
          subjects: [entitySubject(plan.artifact.ref)],
          workstream: plan.artifact.ref,
        }, plan.artifact.title), this.#workstreams);
      }
      case "inbox.draft.save":
      case "relay.draft.save": {
        const kind = action.kind === "inbox.draft.save" ? "inbox" as const : "relay" as const;
        const normalizedDraft = action.kind === "inbox.draft.save"
          ? normalizeInboxDraftInput<TWikiPayload>(action.draft)
          : normalizeRelayDraftInput(action.draft);
        const draftId = action.draftId
          ?? recoveryLocalId(recoveryEffects, `${kind}-draft`)
          ?? purposeId(
            purposeIds,
            kind === "inbox" ? "inbox-draft" : "relay-draft",
          )
          ?? this.#localDraftId(kind);
        const current = action.draftId === undefined
          ? null
          : this.#local.getLocalDraft(draftId);
        if (action.draftId !== undefined) {
          if (kind === "relay") {
            requiredDraft<TWikiPayload>(current, "relay");
          }
          requireLocalExpectation(expectedRevisions, `${kind}-draft`, draftId, current?.revision ?? null);
        }
        const stored = this.#local.previewSaveLocalDraft({
          id: draftId,
          kind,
          payload: normalizedDraft,
          expectedRevision: current?.revision ?? null,
          updatedAt: authority.occurredAt,
        });
        const change = localChange(kind, draftId, current?.revision ?? null, stored.revision, "Save local draft");
        const effect: LocalWorkflowEffect = {
          kind: "local",
          namespace: `${kind}-draft`,
          id: draftId,
          beforeRevision: current?.revision ?? null,
          afterRevision: stored.revision,
        };
        return {
          changes: [], localChanges: [change], diagnostics: [], effects: [effect], cleanup: [],
          innerRevisions: [stored.revision], activityInput: null,
          applyPrimary: async () => {
            const applied = this.#local.saveLocalDraft({
              id: draftId,
              kind,
              payload: normalizedDraft,
              expectedRevision: current?.revision ?? null,
              updatedAt: authority.occurredAt,
            });
            return primary([], [], [localChange(kind, draftId, current?.revision ?? null, applied.revision, "Save local draft")]);
          },
        };
      }
      case "inbox.draft.delete":
      case "relay.draft.delete": {
        const kind = action.kind === "inbox.draft.delete" ? "inbox" as const : "relay" as const;
        if (kind === "relay") {
          requiredDraft<TWikiPayload>(
            this.#local.getLocalDraft(action.draftId),
            "relay",
          );
        }
        const current = this.#local.previewDeleteLocalDraft({
          id: action.draftId,
          kind,
          expectedRevision: requiredLocalRevision(expectedRevisions, `${kind}-draft`, action.draftId),
        });
        const change = localChange(kind, action.draftId, current.revision, null, "Delete local draft");
        return {
          changes: [], localChanges: [change], diagnostics: [], cleanup: [],
          effects: [{ kind: "local", namespace: `${kind}-draft`, id: action.draftId, beforeRevision: current.revision, afterRevision: null }],
          innerRevisions: [current.revision], activityInput: null,
          applyPrimary: async () => {
            this.#local.deleteLocalDraft({ id: action.draftId, kind, expectedRevision: current.revision });
            return primary([], [], [change]);
          },
        };
      }
      case "inbox.publish": {
        const draft = requiredDraft<TWikiPayload>(this.#local.getLocalDraft(action.draftId), "inbox");
        requireLocalExpectation(expectedRevisions, "inbox-draft", action.draftId, draft.revision);
        const payload = draft.payload as InboxDraftInput<TWikiPayload>;
        await this.#assertSpecDraftDependenciesIfPresent(
          payload as unknown as InboxDraftInput<JsonValue>,
        );
        const recoveryId = recoveryCanonicalId(recoveryEffects, "proposal")
          ?? purposeId(purposeIds, "proposal")
          ?? null;
        const plan = await this.#proposals.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          author: authority.actor,
          rationale: payload.rationale,
          evidence: payload.evidence,
          request: payload.request,
          targetRevisions: payload.targetRevisions,
        });
        const proposalLabel = productProposalProjection(
          plan.artifact as unknown as InboxProposal<JsonValue>,
        )?.title;
        return withCleanup(canonicalWorkflowPlan<TWikiPayload, typeof plan.artifact>(plan, "proposal", plan.artifact.ref.id, workflowActivity("inbox.publish", {
          action: "inbox.published",
          subjects: [entitySubject(plan.artifact.ref)],
        }, proposalLabel), this.#proposals), "inbox", action.draftId, draft.revision);
      }
      case "relay.publish": {
        const recoveredWorkstream = legacyRelayPublicationWorkstream(
          recoveryEffects,
        );
        if (recoveredWorkstream === null) {
          await this.#assertRelayActionDependencies(command);
        } else {
          await this.#assertLegacyRelayPublishDependencies(
            command,
            recoveredWorkstream,
          );
        }
        const draft = requiredDraft<TWikiPayload>(this.#local.getLocalDraft(action.draftId), "relay");
        requireLocalExpectation(expectedRevisions, "relay-draft", action.draftId, draft.revision);
        const compatibility = normalizeRelayDraftInputWithLegacy(draft.payload);
        const payload = normalizeStoredRelayProductDraftInput(compatibility.input);
        const { audience, ...publicationPayload } = payload;
        const recipients = await Promise.all(payload.recipients.map(async (recipient) => {
          if (recipient.kind !== "member") throw relayUnauthorized("Relay recipients must be Members.");
          const member = await required(this.#members.get(recipient.memberId), "Member");
          return {
            kind: "member" as const,
            memberId: member.ref.id,
            displayName: member.displayName,
          };
        }));
        const recoveryId = recoveryCanonicalId(recoveryEffects, "relay")
          ?? purposeId(purposeIds, "relay")
          ?? null;
        if (recoveredWorkstream !== null) {
          if (
            compatibility.legacy === null
            || compatibility.legacy.workstream.id !== recoveredWorkstream.id
          ) throw incompleteRecovery();
          const workstream = await this.#requireWorkstreamDependency(
            compatibility.legacy.workstream,
            expectedRevisions,
          );
          const plan = await this.#relays.previewCreate({
            ...(recoveryId === null ? {} : { id: recoveryId }),
            ...publicationPayload,
            schemaVersion: 2,
            evidence: compatibility.legacy.evidence,
            recipients,
            workstream: workstream.ref,
            sender: authority.actor,
            publishedAt: authority.occurredAt,
          });
          return withCleanup(canonicalWorkflowPlan<TWikiPayload, typeof plan.artifact>(plan, "relay", plan.artifact.ref.id, workflowActivity("relay.publish", {
            action: "relay.published",
            subjects: [entitySubject(plan.artifact.ref)],
            workstream: workstream.ref,
          }, plan.artifact.summary), this.#relays), "relay", action.draftId, draft.revision);
        }
        const plan = await this.#relays.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          ...publicationPayload,
          ...(audience === "team" ? { schemaVersion: 4 as const, audience: "team" as const } : { schemaVersion: 3 as const }),
          recipients,
          sender: authority.actor,
          publishedAt: authority.occurredAt,
          publishedRepoState: authority.repoState,
        });
        const publication = canonicalWorkflowPlan<TWikiPayload, typeof plan.artifact>(plan, "relay", plan.artifact.ref.id, workflowActivity("relay.publish", {
          action: "relay.published",
          subjects: [entitySubject(plan.artifact.ref)],
        }, plan.artifact.summary), this.#relays);
        return withCleanup({
          ...publication,
          diagnostics: authority.repoState.dirty
            ? [relayDirtyPublicationDiagnostic()]
            : publication.diagnostics,
        }, "relay", action.draftId, draft.revision);
      }
      case "relay.acknowledge":
      case "relay.close": {
        await this.#assertRelayActionDependencies(command);
        const current = await required(this.#relays.get(action.relayId), "Relay");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const plan = await this.#relays.previewUpdate(action.relayId, {
          ...relayRepositoryUpdateInput(current),
          ...(action.kind === "relay.acknowledge"
            ? { state: "acknowledged" as const, acknowledgedBy: authority.actor, acknowledgedAt: authority.occurredAt }
            : { state: "closed" as const, closedBy: authority.actor, closedAt: authority.occurredAt }),
        }, current.revision);
        return canonicalWorkflowPlan(plan, "relay", action.relayId, workflowActivity(action.kind, {
          action: action.kind === "relay.acknowledge" ? "relay.acknowledged" : "relay.closed",
          subjects: [entitySubject(plan.artifact.ref)],
          ...((current.schemaVersion === 3 || current.schemaVersion === 4)
            ? {}
            : { workstream: current.workstream }),
        }, current.summary), this.#relays);
      }
      case "playbook.create": {
        const recoveryId = recoveryCanonicalId(recoveryEffects, "playbook");
        const plan = await this.#playbooks.previewCreate({
          ...action.playbook,
          ...(recoveryId === null ? {} : { id: recoveryId }),
        });
        return canonicalWorkflowPlan(plan, "playbook", plan.artifact.ref.id, workflowActivity("playbook.create", {
          action: "playbook.created", subjects: [entitySubject(plan.artifact.ref)],
        }, plan.artifact.title), this.#playbooks);
      }
      case "playbook.update":
      case "playbook.archive": {
        const current = await required(this.#playbooks.get(action.playbookId), "Playbook");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const patch = action.kind === "playbook.archive" ? { state: "archived" as const } : action.patch;
        const plan = await this.#playbooks.previewUpdate(action.playbookId, {
          ...withoutStored(current), ...patch,
        }, current.revision);
        return canonicalWorkflowPlan(plan, "playbook", action.playbookId, workflowActivity(action.kind, {
          action: action.kind === "playbook.archive" ? "playbook.archived" : "playbook.updated",
          subjects: [entitySubject(plan.artifact.ref)],
        }, plan.artifact.title), this.#playbooks);
      }
      case "playbook.run.start": {
        const playbook = await this.#requirePlaybookDependency(action.playbook, expectedRevisions);
        const workstream = await this.#requireWorkstreamDependency(action.workstream, expectedRevisions);
        const recoveryId = recoveryCanonicalId(recoveryEffects, "playbook-run");
        const plan = await this.#runs.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          playbook: playbook.ref,
          workstream: workstream.ref,
          steps: playbook.steps.map((step) => ({ stepId: step.id })),
          startedBy: authority.actor,
          startedAt: authority.occurredAt,
        });
        return canonicalWorkflowPlan(plan, "playbook-run", plan.artifact.ref.id, workflowActivity("playbook.run.start", {
          action: "playbook.run.started", subjects: [entitySubject(plan.artifact.ref)], workstream: workstream.ref,
        }, playbook.title), this.#runs);
      }
      case "playbook.run.complete-step": {
        const current = await required(this.#runs.get(action.runId), "Playbook run");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const matched = current.steps.some((step) => step.stepId === action.stepId && step.completedBy === undefined);
        if (!matched) throw artifactError("VALIDATION_FAILED", "Invalid Playbook step", "The requested Playbook run step is missing or already complete.");
        const steps = current.steps.map((step) => step.stepId === action.stepId
          ? { ...step, completedBy: authority.actor, completedAt: authority.occurredAt }
          : step);
        const plan = await this.#runs.previewUpdate(action.runId, {
          ...withoutStored(current),
          steps,
          state: steps.every((step) => step.completedBy !== undefined) ? "completed" : "active",
        }, current.revision);
        return canonicalWorkflowPlan(plan, "playbook-run", action.runId, workflowActivity("playbook.run.complete-step", {
          action: "playbook.run.step-completed", subjects: [entitySubject(plan.artifact.ref)], workstream: current.workstream,
        }, current.playbook.title), this.#runs);
      }
      case "inbox.reject":
      case "inbox.withdraw":
      case "inbox.mark-stale":
      case "inbox.repair":
      case "inbox.approve":
        return this.#planProposalAction(
          command,
          purposeIds,
          recoveryEffects,
          governedInbox,
        );
      default:
        return assertNever(action);
    }
  }

  async #planProposalAction(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    purposeIds?: readonly PortableWorkflowPurposeId[],
    recoveryEffects?: readonly TeamWorkflowJournalEffect[],
    governedInbox = false,
  ): Promise<any> {
    const action = command.action;
    if (!("proposalId" in action)) return assertNever(action as never);
    const current = await required(this.#proposals.get(action.proposalId), "Inbox proposal");
    requireArtifactExpectation(command.expectedRevisions, current.sourcePath, current.revision);
    const specChange = storedSpecChange(
      current as unknown as InboxProposal<JsonValue>,
    );
    const currentProposalLabel = productProposalProjection(
      current as unknown as InboxProposal<JsonValue>,
    )?.title;
    if (governedInbox && specChange === null) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Inbox proposal is outside governed Inbox authoring",
        "The governed Inbox/Spec facade cannot execute a generic Wiki proposal.",
        current.sourcePath,
      );
    }
    if (
      specChange !== null
      && action.kind !== "inbox.mark-stale"
      && current.state !== (action.kind === "inbox.repair" ? "stale" : "pending")
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid Inbox proposal state",
        action.kind === "inbox.repair"
          ? "Only a stale Inbox proposal can be repaired."
          : "Only a pending Inbox proposal can be reviewed or withdrawn.",
        current.sourcePath,
      );
    }
    if (action.kind === "inbox.mark-stale") {
      if (specChange === null || current.state !== "pending") {
        throw artifactError(
          "VALIDATION_FAILED",
          "Invalid Inbox stale transition",
          "Only a pending governed Spec proposal can be explicitly marked stale.",
          current.sourcePath,
        );
      }
      if (!await this.#specProposalHasDrifted(
        current as unknown as InboxProposal<JsonValue>,
      )) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Inbox proposal is still current",
          "A proposal can be marked stale only after the service proves dependency drift.",
          current.sourcePath,
        );
      }
      const plan = await this.#proposals.previewUpdate(current.ref.id, {
        ...withoutStored(current),
        state: "stale",
      }, current.revision);
      return canonicalWorkflowPlan(plan, "proposal", current.ref.id, workflowActivity("inbox.mark-stale", {
        action: "inbox.marked-stale",
        subjects: [entitySubject(plan.artifact.ref)],
        metadata: { rationaleExcerpt: utf8Excerpt(action.rationale) },
      }, currentProposalLabel), this.#proposals);
    }
    if (action.kind === "inbox.approve") {
      await this.#assertExpectationsCurrent(current.targetRevisions);
      if (specChange !== null) {
        await this.#assertSpecProposalDependencies(
          current as unknown as InboxProposal<JsonValue>,
        );
      }
      const receiptSpecId = purposeId(purposeIds, "spec-entity");
      const recoverySpecId = (specChange !== null && isInboxCreateChange(specChange))
        ? recoveryCreatedSpecId(
            recoveryEffects,
            current.ref.id,
            specChange.entityKind,
          )
        : null;
      if (
        receiptSpecId !== undefined
        && recoverySpecId !== null
        && receiptSpecId !== recoverySpecId
      ) throw previewConflict();
      if (
        governedInbox
        && (specChange !== null && isInboxCreateChange(specChange))
        && recoveryEffects !== undefined
        && recoverySpecId === null
      ) throw incompleteRecovery();
      const pinnedSpecId = (specChange !== null && isInboxCreateChange(specChange))
        ? receiptSpecId ?? recoverySpecId ?? this.#mintSpecId()
        : undefined;
      const wikiRequest = specChange === null
        ? portableWikiRequest(current, command.authority.actor, command.authority.occurredAt)
        : materializeSpecWikiRequest(
            current as unknown as InboxProposal<JsonValue>,
            command.authority,
            pinnedSpecId,
          ) as unknown as WikiOperationRequest<TWikiPayload>;
      const wikiPreview = (specChange !== null && isInboxCreateChange(specChange))
        ? await this.#previewWikiWithCreatedId(wikiRequest, pinnedSpecId!)
        : (specChange !== null && isInboxUpdateChange(specChange))
          ? await this.#previewWikiAuthoringUpdate(wikiRequest)
          : await this.#wiki.previewOperations(wikiRequest);
      if (!wikiPreview.valid) {
        throw artifactError("VALIDATION_FAILED", "Wiki proposal is not valid", "The Inbox proposal must be repaired and previewed again before approval.", current.sourcePath);
      }
      const plan = await this.#proposals.previewUpdate(current.ref.id, {
        ...withoutStored(current), state: "approved", reviewer: command.authority.actor,
        reviewedAt: command.authority.occurredAt,
      }, current.revision);
      const base = canonicalWorkflowPlan(plan, "proposal", current.ref.id, workflowActivity("inbox.approve", {
        action: "inbox.approved",
        subjects: specChange === null
          ? [entitySubject(current.ref), ...wikiPreview.affectedEntities.map(entitySubject)]
          : [
              entitySubject(current.ref),
              entitySubject(isInboxCreateChange(specChange)
                ? { id: pinnedSpecId!, kind: specChange.entityKind }
                : specChange.target),
            ],
      }, currentProposalLabel), this.#proposals);
      const wikiEffects = wikiPreview.changes.map((change, index): CanonicalWorkflowEffect => ({
        kind: "canonical", namespace: "wiki", id: `${current.ref.id}:${index}`,
        path: change.path, beforeRevision: change.beforeRevision, afterRevision: change.afterRevision,
      }));
      return {
        ...base,
        changes: [...wikiPreview.changes, ...base.changes],
        effects: [...wikiEffects, ...base.effects],
        innerRevisions: [wikiPreview.previewRevision, ...base.innerRevisions],
        wiki: { request: wikiRequest, preview: wikiPreview },
        applyPrimary: async () => {
          const wikiResult = await this.#wiki.applyOperations({
            ...wikiRequest,
            plan: wikiPreview.plan,
            expectedPreviewRevision: wikiPreview.previewRevision,
          });
          const applied = await this.#proposals.apply(plan, plan.previewRevision);
          return { ...primary([applied.artifact], [...wikiResult.changes, applied.change]), wikiResult };
        },
      };
    }
    if (action.kind === "inbox.repair" && specChange !== null) {
      await this.#assertSpecDraftDependenciesIfPresent(
        action.replacement as unknown as InboxDraftInput<JsonValue>,
      );
    }
    const next = action.kind === "inbox.reject"
      ? { state: "rejected" as const, reviewer: command.authority.actor, reviewedAt: command.authority.occurredAt, reviewRationale: action.rationale }
      : action.kind === "inbox.withdraw"
        ? { state: "withdrawn" as const, reviewer: command.authority.actor, reviewedAt: command.authority.occurredAt, ...(action.rationale === undefined ? {} : { reviewRationale: action.rationale }) }
        : { state: "pending" as const, reviewer: undefined, reviewedAt: undefined, reviewRationale: undefined, ...action.replacement };
    const plan = await this.#proposals.previewUpdate(current.ref.id, {
      ...withoutStored(current), ...next,
    }, current.revision);
    const nextProposalLabel = productProposalProjection(
      plan.artifact as unknown as InboxProposal<JsonValue>,
    )?.title ?? currentProposalLabel;
    return canonicalWorkflowPlan(plan, "proposal", current.ref.id, workflowActivity(action.kind, {
      action: action.kind === "inbox.reject" ? "inbox.rejected" : action.kind === "inbox.withdraw" ? "inbox.withdrawn" : "inbox.repaired",
      subjects: [entitySubject(plan.artifact.ref)],
    }, nextProposalLabel), this.#proposals);
  }

  async #assertExpectationsCurrent(
    expectations: readonly RevisionExpectation[],
  ): Promise<void> {
    const wikiEntityExpectations: WikiRevisionExpectation[] = [];
    for (const expectation of expectations) {
      if (expectation.target.kind !== "entity") continue;
      if (
        expectation.revision !== null
        && (!Number.isSafeInteger(expectation.semanticRevision)
          || (expectation.semanticRevision as number) < 1)
      ) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Wiki entity revision is incomplete",
          "An existing Wiki entity target requires its exact semantic and file revision.",
        );
      }
      wikiEntityExpectations.push({
        target: { kind: "entity", id: expectation.target.id },
        version: expectation.revision === null
          ? null
          : {
              semanticRevision: expectation.semanticRevision as number,
              contentHash: expectation.revision,
            },
      });
    }
    if (wikiEntityExpectations.length > 0) {
      await this.#wiki.validateCurrentRevisionExpectations(wikiEntityExpectations);
    }
    for (const expectation of expectations) {
      if (expectation.target.kind === "entity") {
        continue;
      }
      if (expectation.target.kind === "artifact") {
        const artifact = tryReadContainedArtifact(
          this.#root.path,
          expectation.target.path,
          recoveryFileByteLimit(expectation.target.path),
          teamArtifactByteMode(expectation.target.path),
        );
        if ((artifact?.revision ?? null) !== expectation.revision) {
          throw targetRevisionChanged(expectation.target.path);
        }
        continue;
      }
      if (
        expectation.target.namespace !== "inbox-draft"
        && expectation.target.namespace !== "relay-draft"
        && expectation.target.namespace !== MEMBER_SELECTION_NAMESPACE
      ) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Unsupported proposal target",
          "Inbox approval cannot safely validate this local target namespace.",
        );
      }
      if (expectation.target.namespace === MEMBER_SELECTION_NAMESPACE) {
        if (expectation.target.id !== MEMBER_SELECTION_ID) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Unsupported member selection target",
            "The current member selection must use its fixed local target.",
          );
        }
        const selection = this.#local.getConfiguredMember();
        if ((selection?.revision ?? null) !== expectation.revision) {
          throw targetRevisionChanged(
            `${MEMBER_SELECTION_NAMESPACE}:${MEMBER_SELECTION_ID}`,
          );
        }
        continue;
      }
      const draft = this.#local.getLocalDraft(expectation.target.id);
      const expectedKind = expectation.target.namespace === "inbox-draft"
        ? "inbox"
        : "relay";
      if (
        draft?.kind !== expectedKind
        || (draft?.revision ?? null) !== expectation.revision
      ) {
        throw targetRevisionChanged(
          `${expectation.target.namespace}:${expectation.target.id}`,
        );
      }
    }
  }

  async #assertSpecDraftDependenciesIfPresent(
    input: InboxDraftInput<JsonValue>,
  ): Promise<void> {
    const product = productInputFromInboxDraft(input);
    if (product === null) return;
    const attestations = await this.#readExactSpecAttestations(
      specDependencyIds(product.change),
    );
    assertExactSpecAttestations(
      product.change,
      product.targetRevisions,
      attestations,
    );
  }

  async #assertInboxProductTargets(
    command: TeamInboxSpecCommand,
  ): Promise<void> {
    const action = command.action;
    if (
      action.kind === "inbox.draft.save"
      && action.draftId === undefined
    ) return;
    if (
      action.kind === "inbox.draft.save"
      || action.kind === "inbox.draft.delete"
      || action.kind === "inbox.publish"
    ) {
      const draftId = action.draftId;
      if (draftId === undefined) throw previewConflict();
      const stored = this.#local.getLocalDraft<InboxDraftInput<JsonValue>>(draftId);
      if (
        stored === null
        || stored.kind !== "inbox"
        || productDraftProjection(
          localDraftProjection(stored) as InboxDraft<JsonValue>,
        ) === null
      ) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Inbox draft is outside governed Inbox authoring",
          "The governed Inbox/Spec facade accepts only its own typed local drafts.",
        );
      }
      return;
    }
    const proposal = await this.#proposals.get(action.proposalId);
    if (
      proposal === null
      || productProposalProjection(
        proposal as unknown as InboxProposal<JsonValue>,
      ) === null
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Inbox proposal is outside governed Inbox authoring",
        "The governed Inbox/Spec facade accepts only its own typed canonical proposals.",
      );
    }
  }

  async #assertSpecProposalDependencies(
    proposal: InboxProposal<JsonValue>,
  ): Promise<void> {
    const change = storedSpecChange(proposal);
    if (change === null) return;
    const attestations = await this.#readExactSpecAttestations(
      specDependencyIds(change),
    );
    assertExactSpecAttestations(
      change,
      proposal.targetRevisions,
      attestations,
    );
  }

  async #assertInboxActionDependencies(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
  ): Promise<void> {
    if (command.action.kind === "inbox.approve") {
      const proposal = await required(
        this.#proposals.get(command.action.proposalId),
        "Inbox proposal",
      );
      await this.#assertExpectationsCurrent(proposal.targetRevisions);
      await this.#assertSpecProposalDependencies(
        proposal as unknown as InboxProposal<JsonValue>,
      );
      return;
    }
    if (command.action.kind === "inbox.publish") {
      const draft = requiredDraft<TWikiPayload>(
        this.#local.getLocalDraft(command.action.draftId),
        "inbox",
      );
      await this.#assertSpecDraftDependenciesIfPresent(
        draft.payload as unknown as InboxDraftInput<JsonValue>,
      );
      return;
    }
    if (command.action.kind === "inbox.repair") {
      await this.#assertSpecDraftDependenciesIfPresent(
        command.action.replacement as unknown as InboxDraftInput<JsonValue>,
      );
      return;
    }
    if (command.action.kind !== "inbox.mark-stale") return;
    const proposal = await required(
      this.#proposals.get(command.action.proposalId),
      "Inbox proposal",
    );
    if (!await this.#specProposalHasDrifted(
      proposal as unknown as InboxProposal<JsonValue>,
    )) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Inbox proposal is no longer stale",
        "The exact drift proved at preview is no longer present. Preview again.",
      );
    }
  }

  async #specProposalHasDrifted(
    proposal: InboxProposal<JsonValue>,
  ): Promise<boolean> {
    const change = storedSpecChange(proposal);
    if (change === null) return false;
    const attestations = await this.#readExactSpecAttestations(
      specDependencyIds(change),
    );
    return specAttestationsHaveDrifted(
      change,
      proposal.targetRevisions,
      attestations,
    );
  }

  async #readExactSpecAttestations(
    ids: readonly string[],
  ): Promise<readonly ExactSpecEntityAttestation[]> {
    const port = asInboxSpecWikiPort(this.#wiki);
    if (port === null) throw inboxWikiUnavailable();
    const view = await port.readExactEntityAttestations(ids);
    return view.entities as readonly ExactSpecEntityAttestation[];
  }

  async #previewWikiWithCreatedId(
    request: WikiOperationRequest<TWikiPayload>,
    specId: string,
  ): Promise<WikiOperationPreview<TWikiPlan>> {
    const port = asInboxSpecWikiPort(this.#wiki);
    if (port === null) throw inboxWikiUnavailable();
    return port.previewOperationsWithCreatedIds(request, [specId]);
  }

  async #previewWikiAuthoringUpdate(
    request: WikiOperationRequest<TWikiPayload>,
  ): Promise<WikiOperationPreview<TWikiPlan>> {
    const port = asInboxSpecWikiPort(this.#wiki);
    if (port === null) throw inboxWikiUnavailable();
    return port.previewAuthoringOperations(request);
  }

  #mintSpecId(): string {
    const id = this.#specId();
    if (!isEntityId(id) || !id.startsWith("mx_")) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid generated Spec ID",
        "The Inbox service must mint one canonical mx ID for Spec create.",
      );
    }
    return id;
  }

  async #requireWorkstreamDependency(
    ref: EntityRef,
    expectations: readonly RevisionExpectation[],
  ): Promise<Workstream> {
    if (ref.kind !== "workstream") throw artifactError("VALIDATION_FAILED", "Invalid Workstream reference", "A real Workstream reference is required.");
    const workstream = await required(this.#workstreams.get(ref.id), "Workstream");
    requireArtifactExpectation(expectations, workstream.sourcePath, workstream.revision);
    return workstream;
  }

  async #requirePlaybookDependency(
    ref: EntityRef,
    expectations: readonly RevisionExpectation[],
  ): Promise<Playbook> {
    if (ref.kind !== "playbook") throw artifactError("VALIDATION_FAILED", "Invalid Playbook reference", "A real Playbook reference is required.");
    const playbook = await required(this.#playbooks.get(ref.id), "Playbook");
    requireArtifactExpectation(expectations, playbook.sourcePath, playbook.revision);
    return playbook;
  }

  async #requireActiveRelayMember(action: string): Promise<string> {
    const memberId = await this.#activeRelayMemberOrNull();
    if (memberId === null) {
      throw relayUnauthorized(
        `Select an active Member, or configure one unique active Git alias, to ${action}.`,
      );
    }
    return memberId;
  }

  async #activeRelayMemberOrNull(): Promise<string | null> {
    const resolution = await this.#resolveCurrentActorDetailed();
    if (resolution.actor.kind !== "member") return null;
    const member = await this.#members.get(resolution.actor.memberId);
    return member?.active === true ? member.ref.id : null;
  }

  async #assertRelayActionDependencies(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
  ): Promise<void> {
    const action = command.action;
    if (
      action.kind !== "relay.draft.save"
      && action.kind !== "relay.draft.delete"
      && action.kind !== "relay.publish"
      && action.kind !== "relay.acknowledge"
      && action.kind !== "relay.close"
    ) return;
    if (
      action.kind === "relay.draft.save"
      || action.kind === "relay.draft.delete"
    ) return;
    if (command.authority.actor.kind !== "member") {
      throw relayUnauthorized("Canonical Relay actions require an active Member.");
    }
    const actor = await this.#members.get(command.authority.actor.memberId);
    if (actor?.active !== true) {
      throw relayUnauthorized("The current Relay actor is missing or inactive.");
    }
    if (action.kind === "relay.publish") {
      const draft = requiredDraft<TWikiPayload>(
        this.#local.getLocalDraft(action.draftId),
        "relay",
      );
      const payload = normalizeStoredRelayProductDraftInput(draft.payload);
      if (payload.audience !== "team" && payload.recipients.length === 0) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Relay recipients are required for publication",
          "Choose at least one active Member or explicitly open the handoff to the team before publishing.",
        );
      }
      const recipients = await Promise.all(payload.recipients.map(async (recipient) => {
        if (recipient.kind !== "member") {
          throw artifactError(
            "VALIDATION_FAILED",
            "Invalid Relay recipient",
            "Relay recipients must be canonical Members.",
          );
        }
        const member = await required(this.#members.get(recipient.memberId), "Member");
        if (!member.active) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Inactive Relay recipient",
            `Relay recipient ${recipient.memberId} is inactive.`,
            member.sourcePath,
          );
        }
        return member;
      }));
      const targets = [
        `local:relay-draft:${action.draftId}`,
        ...recipients.map((member) => `artifact:${member.sourcePath}`),
      ];
      assertExactRelayExpectationTargets(command.expectedRevisions, targets);
      requireLocalExpectation(
        command.expectedRevisions,
        "relay-draft",
        action.draftId,
        draft.revision,
      );
      for (const member of recipients) {
        requireArtifactExpectation(
          command.expectedRevisions,
          member.sourcePath,
          member.revision,
        );
      }
      return;
    }
    if (action.kind !== "relay.acknowledge" && action.kind !== "relay.close") {
      return;
    }
    const relay = await required(this.#relays.get(action.relayId), "Relay");
    assertExactRelayExpectationTargets(command.expectedRevisions, [
      `artifact:${relay.sourcePath}`,
    ]);
    requireArtifactExpectation(
      command.expectedRevisions,
      relay.sourcePath,
      relay.revision,
    );
    const actorId = command.authority.actor.memberId;
    if (action.kind === "relay.acknowledge") {
      if (relay.state !== "published") {
        throw artifactError(
          "VALIDATION_FAILED",
          "Relay cannot be acknowledged",
          "Only a published Relay can be acknowledged.",
          relay.sourcePath,
        );
      }
      if (relay.audience !== "team" && !relay.recipients.some(
        (recipient) => recipient.kind === "member" && recipient.memberId === actorId,
      )) {
        throw relayUnauthorized("Only a listed Relay recipient may acknowledge it.");
      }
      return;
    }
    if (relay.state !== "acknowledged") {
      throw artifactError(
        "VALIDATION_FAILED",
        "Relay cannot be closed",
        "Only an acknowledged Relay can be closed.",
        relay.sourcePath,
      );
    }
    if (relay.sender.kind !== "member" || relay.acknowledgedBy?.kind !== "member") {
      throw relayUnauthorized(
        "A Relay with non-Member legacy principals cannot be closed.",
      );
    }
    const principalIds = [...new Set([
      relay.sender.memberId,
      relay.acknowledgedBy.memberId,
    ])];
    const principals = await Promise.all(
      principalIds.map((memberId) => this.#members.get(memberId)),
    );
    if (principals.some((member) => member?.active !== true)) {
      throw relayUnauthorized(
        "The recorded Relay sender and claimant must both remain active Members.",
      );
    }
    if (!principalIds.includes(actorId)) {
      throw relayUnauthorized(
        "Only the recorded Relay sender or claimant may close it.",
      );
    }
  }

  async #assertLegacyRelayPublishDependencies(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    recordedWorkstream: EntityRef,
  ): Promise<void> {
    const action = command.action;
    if (action.kind !== "relay.publish") throw incompleteRecovery();
    if (command.authority.actor.kind !== "member") {
      throw relayUnauthorized("Canonical Relay actions require an active Member.");
    }
    const actor = await this.#members.get(command.authority.actor.memberId);
    if (actor?.active !== true) {
      throw relayUnauthorized("The current Relay actor is missing or inactive.");
    }
    const draft = requiredDraft<TWikiPayload>(
      this.#local.getLocalDraft(action.draftId),
      "relay",
    );
    const compatibility = normalizeRelayDraftInputWithLegacy(draft.payload);
    if (
      compatibility.legacy === null
      || compatibility.legacy.workstream.id !== recordedWorkstream.id
    ) throw incompleteRecovery();
    const workstream = await required(
      this.#workstreams.get(compatibility.legacy.workstream.id),
      "Workstream",
    );
    if (
      compatibility.legacy.workstream.kind !== "workstream"
      || (workstream.state !== "planned"
        && workstream.state !== "active"
        && workstream.state !== "blocked")
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Relay Workstream is not publishable",
        "Recovery of this pre-v3 Relay publication requires its original planned, active, or blocked Workstream.",
        workstream.sourcePath,
      );
    }
    const recipients = await Promise.all(
      compatibility.input.recipients.map(async (recipient) => {
        if (recipient.kind !== "member") {
          throw artifactError(
            "VALIDATION_FAILED",
            "Invalid Relay recipient",
            "Relay recipients must be canonical Members.",
          );
        }
        const member = await required(
          this.#members.get(recipient.memberId),
          "Member",
        );
        if (!member.active) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Inactive Relay recipient",
            `Relay recipient ${recipient.memberId} is inactive.`,
            member.sourcePath,
          );
        }
        return member;
      }),
    );
    assertExactRelayExpectationTargets(command.expectedRevisions, [
      `local:relay-draft:${action.draftId}`,
      `artifact:${workstream.sourcePath}`,
      ...recipients.map((member) => `artifact:${member.sourcePath}`),
    ]);
    requireLocalExpectation(
      command.expectedRevisions,
      "relay-draft",
      action.draftId,
      draft.revision,
    );
    requireArtifactExpectation(
      command.expectedRevisions,
      workstream.sourcePath,
      workstream.revision,
    );
    for (const member of recipients) {
      requireArtifactExpectation(
        command.expectedRevisions,
        member.sourcePath,
        member.revision,
      );
    }
  }

  async #assertAuthorityCurrent(
    authority: { actor: ActorRef; repoState: RepoState },
    allowStaleSelectionFallback = false,
  ): Promise<void> {
    const actor = allowStaleSelectionFallback
      ? (await this.#resolveCurrentActorDetailed()).actor
      : await this.resolveActor();
    if (stableJson(actor) !== stableJson(authority.actor)) {
      throw artifactError("REVISION_CONFLICT", "Workflow actor changed", "The resolved actor changed after preview. Preview the workflow again.");
    }
    const current = await this.#git.getRepoState();
    if (!sameRepoCheckpoint(current, authority.repoState)) throw repositoryChanged();
  }

  async #assertCommandAuthorityCurrent(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
  ): Promise<void> {
    if (
      command.action.kind !== "relay.publish"
      && command.action.kind !== "relay.acknowledge"
      && command.action.kind !== "relay.close"
    ) {
      await this.#assertAuthorityCurrent(
        command.authority,
        actionAllowsStaleSelectionFallback(command.action.kind),
      );
      return;
    }
    const expected = command.authority.actor;
    const currentActor = (await this.#resolveCurrentActorDetailed()).actor;
    if (
      expected.kind !== "member"
      || currentActor.kind !== "member"
      || expected.memberId !== currentActor.memberId
    ) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Workflow actor changed",
        "The resolved Member changed after preview. Preview the workflow again.",
      );
    }
    const currentRepo = await this.#git.getRepoState();
    if (!sameRepoCheckpoint(currentRepo, command.authority.repoState)) {
      throw repositoryChanged();
    }
  }

  /**
   * Relay eligibility is derived from mutable Member, Relay, and checkout-local
   * draft state. Once a Relay preview has been reviewed, stale
   * authority or exact target revisions must win over a newly invalid semantic
   * state so callers receive the stable REVISION_CONFLICT re-preview signal.
   * Keep the historical dependency-first order for every non-Relay workflow.
   */
  async #assertPreWriteFreshnessAndDependencies(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    recoveryEffects?: readonly TeamWorkflowJournalEffect[],
  ): Promise<void> {
    if (command.action.kind.startsWith("relay.")) {
      await this.#assertCommandAuthorityCurrent(command);
      await this.#assertExpectationsCurrent(command.expectedRevisions);
      const legacyWorkstream = legacyRelayPublicationWorkstream(recoveryEffects);
      if (legacyWorkstream === null) {
        await this.#assertRelayActionDependencies(command);
      } else {
        await this.#assertLegacyRelayPublishDependencies(
          command,
          legacyWorkstream,
        );
      }
      return;
    }
    await this.#assertRelayActionDependencies(command);
    await this.#assertCommandAuthorityCurrent(command);
    await this.#assertExpectationsCurrent(command.expectedRevisions);
  }

  async #resolveCurrentActorDetailed(
    configured = this.#local.getConfiguredMember(),
  ): Promise<ActorResolution> {
    return this.#actors.resolveCurrentDetailed(
      configured === null ? {} : { configuredMemberId: configured.memberId },
    );
  }

  #assertPortablePreviewFresh(occurredAt: string): void {
    const issued = Date.parse(occurredAt);
    if (
      Number.isNaN(issued)
      || new Date(issued).toISOString() !== occurredAt
    ) {
      throw invalidIdentityActivityEnvelope();
    }
    const now = this.#now().getTime();
    if (Number.isNaN(now)) {
      throw artifactError(
        "INTERNAL_ERROR",
        "Workflow clock is invalid",
        "The Team workflow clock could not validate the approved preview.",
      );
    }
    if (issued - now > TEAM_IDENTITY_ACTIVITY_LIMITS.maxFutureClockSkewMs) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Workflow preview is from the future",
        "The approved workflow preview has a timestamp beyond the allowed clock skew. Preview again.",
      );
    }
    if (now - issued > TEAM_IDENTITY_ACTIVITY_LIMITS.maxPreviewAgeMs) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Workflow preview expired",
        "The approved workflow preview is older than 30 minutes. Preview again.",
      );
    }
  }

  #portablePreviewIsFresh(occurredAt: string): boolean {
    const issued = Date.parse(occurredAt);
    if (
      Number.isNaN(issued)
      || new Date(issued).toISOString() !== occurredAt
    ) {
      return false;
    }
    const now = this.#now().getTime();
    if (Number.isNaN(now)) {
      throw artifactError(
        "INTERNAL_ERROR",
        "Workflow clock is invalid",
        "The Team workflow clock could not validate the approved preview.",
      );
    }
    return issued - now <= TEAM_IDENTITY_ACTIVITY_LIMITS.maxFutureClockSkewMs
      && now - issued <= TEAM_IDENTITY_ACTIVITY_LIMITS.maxPreviewAgeMs;
  }

  #assertMemberIsNotSelected(memberId: string): void {
    const selection = this.#local.getConfiguredMember();
    if (selection?.memberId === memberId) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Current member cannot be deactivated",
        "Clear or change the current local member selection before deactivating this member.",
      );
    }
  }

  async #assertPostPrimaryRepository(before: RepoState): Promise<void> {
    this.#root.assertCurrent();
    const current = await this.#git.getRepoState();
    if (current.branch !== before.branch || current.head !== before.head) throw repositoryChanged();
  }

  async #revalidatePreparedWiki(
    prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
  ): Promise<void> {
    if (prepared.wiki === undefined) return;
    // Revalidate canonical truth without minting a second set of IDs for
    // create/supersede operations. The reviewed opaque plan performs its own
    // exact base-byte check immediately before publication.
    const governedInboxApproval = prepared.preview.command.action.kind
      === "inbox.approve"
      && prepared.effects.some(
        (effect) => effect.kind === "identity_activity_receipt",
      );
    if (!governedInboxApproval) {
      await this.#wiki.validateCurrentRevisionExpectations(
        prepared.wiki.request.expectedRevisions,
      );
    }
    const recovery = prepared.wiki.preview.recoveryManifest;
    const recoverable = recovery === undefined ? null : asRecoverableWikiPort(this.#wiki);
    if (
      recoverable !== null
      && recoverable.inspectOperationRecovery(prepared.wiki.request).state !== "none"
    ) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Wiki proposal changed",
        "The reviewed Wiki operation ID already has durable audit state. Preview the Inbox approval again.",
      );
    }
  }

  async #preflightPrepared(
    prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
    prepareActivity: boolean,
  ): Promise<PreparedActivityPublication | null> {
    await this.#assertPreWriteFreshnessAndDependencies(
      prepared.preview.command,
    );
    if (prepared.preview.command.action.kind === "member.deactivate") {
      this.#assertMemberIsNotSelected(
        prepared.preview.command.action.memberId,
      );
    }
    await this.#assertInboxActionDependencies(prepared.preview.command);
    this.#assertCleanupPending(prepared.effects);
    await this.#revalidatePreparedWiki(prepared);
    for (const effect of prepared.effects) {
      if (
        (effect.kind === "canonical" || effect.kind === "local")
        && this.#effectState(effect) !== "before"
      ) {
        throw targetRevisionChanged(
          effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
        );
      }
    }
    for (const change of prepared.preview.changes) {
      const observed = tryReadContainedArtifact(
        this.#root.path,
        change.path,
        recoveryFileByteLimit(change.path),
        teamArtifactByteMode(change.path),
      );
      if ((observed?.revision ?? null) !== change.beforeRevision) {
        throw targetRevisionChanged(change.path);
      }
    }
    if (prepared.activity === null) return null;
    const observedActivity = tryReadContainedArtifact(
      this.#root.path,
      prepared.activity.sourcePath,
      ACTIVITY_ARTIFACT_MAX_BYTES,
      "canonical",
    );
    if (observedActivity !== null) {
      throw targetRevisionChanged(prepared.activity.sourcePath);
    }
    return prepareActivity
      ? this.#activity.prepareApplyCreate(
          prepared.activity,
          prepared.activity.previewRevision,
        )
      : null;
  }

  async #runPhaseHook(boundary: TeamWorkflowPhaseBoundary): Promise<void> {
    try {
      await this.#phaseHook(boundary);
    } catch (error) {
      if (error instanceof WorkflowPhaseInterruption) throw error;
      throw new WorkflowPhaseInterruption(boundary, { cause: error });
    }
  }

  #acquireLease(): string {
    const token = this.#heldLeaseToken ?? this.#leaseToken();
    this.#local.acquireTeamWorkflowLease({ pid: this.#pid, token, acquiredAt: this.#nowIso() });
    this.#heldLeaseToken = token;
    return token;
  }

  #advanceJournal(
    entry: TeamWorkflowJournalEntry,
    leaseToken: string,
    phase: "canonical_published" | "local_finalized" | "complete",
    deleteDrafts: readonly { kind: "inbox" | "relay"; id: string; expectedRevision: Revision }[] = [],
  ): TeamWorkflowJournalEntry {
    return this.#local.advanceWorkflowOperation({
      leaseToken,
      operationId: entry.operationId,
      commandRevision: entry.commandRevision,
      previewRevision: entry.previewRevision,
      expectedRevision: entry.revision,
      phase,
      effects: entry.effects,
      ...(deleteDrafts.length === 0 ? {} : { deleteDrafts }),
    });
  }

  async #recoverExisting(
    entry: TeamWorkflowJournalEntry,
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    if (entry.phase === "complete") {
      // Completed replay trusts the durable journal only after attesting the
      // immutable audit artifact. Mutable member state may legitimately have
      // advanced in a later operation and is intentionally not revalidated.
      this.#assertActivityPublished(entry.effects);
      return this.#resultFromEffects(entry, true);
    }
    const wikiRecovery = entry.effects.find(
      (effect): effect is WikiRecoveryWorkflowEffect => effect.kind === "wiki_recovery",
    );
    if (wikiRecovery !== undefined) {
      return this.#recoverWikiExisting(entry, command, wikiRecovery);
    }
    if (
      entry.phase !== "intent"
      || (
        this.#primaryEffectState(entry.effects) !== "none"
        && !this.#isAuditOnlyPending(entry.effects)
      )
    ) {
      await this.#assertRecoveryCheckpoint(entry.effects);
    }
    // An interrupted journal can legitimately contain a bounded prefix of
    // exact before/after effects. A third revision is not an incomplete prefix:
    // it is external alteration of a recovery target and must terminate as a
    // conflict before lease takeover or any cleanup advances the journal.
    this.#assertNoDivergentPrimaryEffects(entry.effects);
    if (
      entry.phase === "intent"
      && command.action.kind.startsWith("relay.")
      && (
        this.#primaryEffectState(entry.effects) === "none"
        || this.#isAuditOnlyPending(entry.effects)
      )
    ) {
      this.#assertPortablePreviewFresh(command.authority.occurredAt);
      await this.#assertPreWriteFreshnessAndDependencies(command, entry.effects);
    }
    const leaseToken = this.#acquireLease();
    let current = this.#local.getWorkflowOperation(entry.operationId) ?? entry;
    if (current.phase === "intent") {
      let primary = this.#primaryEffectState(current.effects);
      if (primary === "none" || this.#isAuditOnlyPending(current.effects)) {
        if (current.effects.some((effect) => effect.kind === "canonical" && effect.namespace === "wiki")) {
          this.#abandonUnpublished(current, leaseToken);
          throw artifactError(
            "OPERATION_INTERRUPTED",
            "Wiki approval requires a new preview",
            "The process-local Wiki plan was not applied. Preview the Inbox approval again before applying it.",
          );
        }
        try {
          await this.#publishUnpublished(command, current.effects);
        } catch (error) {
          if (error instanceof WorkflowPhaseInterruption) throw error;
          if (
            this.#primaryEffectState(current.effects) === "none"
            || this.#isAuditOnlyPending(current.effects)
          ) {
            this.#abandonUnpublished(current, leaseToken);
          }
          throw error;
        }
        primary = this.#primaryEffectState(current.effects);
      }
      await this.#assertRecoveryCheckpoint(current.effects);
      await this.#completeInterruptedProposalApproval(current.effects);
      primary = this.#primaryEffectState(current.effects);
      if (primary !== "all") {
        throw incompleteRecovery();
      }
      await this.#recoverActivity(current.effects);
      this.#assertActivityPublished(current.effects);
      current = this.#advanceJournal(current, leaseToken, "canonical_published");
    }
    if (current.phase === "canonical_published") {
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupPending(current.effects);
      const cleanups = current.effects.filter((effect): effect is LocalCleanupWorkflowEffect => effect.kind === "local_cleanup");
      current = this.#advanceJournal(current, leaseToken, "local_finalized", cleanups.map((effect) => ({
        kind: effect.draftKind, id: effect.draftId, expectedRevision: effect.expectedRevision,
      })));
    }
    if (current.phase === "local_finalized") {
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupApplied(current.effects);
      current = this.#advanceJournal(current, leaseToken, "complete");
    }
    this.#local.releaseTeamWorkflowLease(leaseToken);
    this.#heldLeaseToken = null;
    return this.#resultFromEffects(current, true);
  }

  async #recoverWikiExisting(
    entry: TeamWorkflowJournalEntry,
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    recovery: WikiRecoveryWorkflowEffect,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    await this.#assertRecoveryCheckpoint(entry.effects);
    this.#assertNoDivergentNonWikiPrimaryEffects(entry.effects);
    const leaseToken = this.#acquireLease();
    let current = this.#local.getWorkflowOperation(entry.operationId) ?? entry;
    let context = await this.#wikiRecoveryContext(command, current.effects, recovery);

    if (current.phase === "intent") {
      if (context.inspection.state === "mismatch") {
        throw wikiRecoveryMismatch(context.inspection.reason);
      }
      if (context.inspection.state === "none") {
        const changed = current.effects.find(
          (effect): effect is CanonicalWorkflowEffect | LocalWorkflowEffect =>
            (effect.kind === "canonical" || effect.kind === "local")
            && this.#effectState(effect) !== "before",
        );
        if (changed !== undefined) {
          throw targetRevisionChanged(
            changed.kind === "canonical" ? changed.path : `${changed.namespace}:${changed.id}`,
          );
        }
        this.#abandonUnpublished(current, leaseToken);
        throw artifactError(
          "OPERATION_INTERRUPTED",
          "Wiki approval requires a new preview",
          "No reviewed Wiki operation was published. Preview the Inbox approval again before applying it.",
        );
      }
      if (context.inspection.state === "prefix") {
        const resumed = await context.port.resumeOperations(
          context.request,
          context.manifest,
        );
        if (!resumed.valid || resumed.recoveryManifest === undefined) {
          throw wikiRecoveryConflict(
            "The interrupted Wiki operation no longer has an exact valid recovery preview.",
          );
        }
        if (stableJson(resumed.recoveryManifest) !== stableJson(context.manifest)) {
          throw wikiRecoveryConflict(
            "The interrupted Wiki recovery manifest changed after publication began.",
          );
        }
        this.#assertResumedWikiChanges(current.effects, resumed.changes);
        await context.port.applyOperations({
          ...context.request,
          plan: resumed.plan,
          expectedPreviewRevision: resumed.previewRevision,
        });
        context = await this.#wikiRecoveryContext(command, current.effects, recovery);
      }
      if (context.inspection.state !== "complete") {
        throw context.inspection.state === "mismatch"
          ? wikiRecoveryMismatch(context.inspection.reason)
          : incompleteRecovery();
      }
      this.#assertWikiPrimaryEffectsPublished(current.effects);
      await this.#refreshRecoveredWikiIndex(current.effects);
      await this.#completeInterruptedProposalApproval(current.effects, true);
      this.#assertNonAuditPrimaryEffectsPublished(current.effects);
      await this.#recoverActivity(current.effects);
      this.#assertActivityPublished(current.effects);
      current = this.#advanceJournal(current, leaseToken, "canonical_published");
    }

    if (current.phase === "canonical_published") {
      context = await this.#wikiRecoveryContext(command, current.effects, recovery);
      if (context.inspection.state !== "complete") {
        throw context.inspection.state === "mismatch"
          ? wikiRecoveryMismatch(context.inspection.reason)
          : incompleteRecovery();
      }
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertNonAuditPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupPending(current.effects);
      const cleanups = current.effects.filter(
        (effect): effect is LocalCleanupWorkflowEffect => effect.kind === "local_cleanup",
      );
      current = this.#advanceJournal(
        current,
        leaseToken,
        "local_finalized",
        cleanups.map((effect) => ({
          kind: effect.draftKind,
          id: effect.draftId,
          expectedRevision: effect.expectedRevision,
        })),
      );
    }

    if (current.phase === "local_finalized") {
      context = await this.#wikiRecoveryContext(command, current.effects, recovery);
      if (context.inspection.state !== "complete") {
        throw context.inspection.state === "mismatch"
          ? wikiRecoveryMismatch(context.inspection.reason)
          : incompleteRecovery();
      }
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertNonAuditPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupApplied(current.effects);
      current = this.#advanceJournal(current, leaseToken, "complete");
    }

    this.#local.releaseTeamWorkflowLease(leaseToken);
    this.#heldLeaseToken = null;
    return this.#resultFromEffects(current, true);
  }

  #abandonUnpublished(entry: TeamWorkflowJournalEntry, leaseToken: string): void {
    this.#local.abandonWorkflowOperation({
      leaseToken,
      operationId: entry.operationId,
      commandRevision: entry.commandRevision,
      previewRevision: entry.previewRevision,
      expectedRevision: entry.revision,
    });
    this.#local.releaseTeamWorkflowLease(leaseToken);
    this.#heldLeaseToken = null;
  }

  async #publishUnpublished(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    effects: readonly TeamWorkflowJournalEffect[],
  ): Promise<void> {
    // An intent with no published primary bytes is still only an authorization
    // to attempt the reviewed operation. Before the first canonical/audit byte
    // is written, revalidate all service-owned authority and preview freshness.
    // Once an exact effect exists, the journaled recovery path below may finish
    // without depending on mutable current identity.
    this.#assertPortablePreviewFresh(command.authority.occurredAt);
    await this.#assertPreWriteFreshnessAndDependencies(command, effects);
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activity !== undefined) {
      const occupied = tryReadContainedArtifact(
        this.#root.path,
        activity.path,
        ACTIVITY_ARTIFACT_MAX_BYTES,
        "canonical",
      );
      if (occupied !== null) throw targetRevisionChanged(activity.path);
    }
    const planned = await this.#planPrimary(
      command,
      effects,
      undefined,
      command.action.kind.startsWith("inbox.")
        && effects.some((effect) => effect.kind === "identity_activity_receipt"),
    );
    const expectedPrimary = effects.filter(
      (effect) =>
        effect.kind === "canonical"
        || effect.kind === "local"
        || effect.kind === "local_cleanup",
    );
    if (stableJson([...planned.effects, ...planned.cleanup]) !== stableJson(expectedPrimary)) {
      throw incompleteRecovery();
    }
    assertRecoveryActivityIntent(planned.activityInput, command.authority, activity);
    await this.#runPhaseHook("before-canonical-publication");
    this.#root.assertCurrent();
    this.#assertPortablePreviewFresh(command.authority.occurredAt);
    await this.#assertPreWriteFreshnessAndDependencies(command, effects);
    await this.#assertInboxActionDependencies(command);
    await planned.applyPrimary();
    await this.#runPhaseHook("after-canonical-publication");
    if (isAuditOnlyEffects(effects)) {
      await this.#assertCommandAuthorityCurrent(command);
    } else {
      await this.#assertPostPrimaryRepository(command.authority.repoState);
    }
    await this.#recoverActivity(effects);
    await this.#runPhaseHook("after-activity-publication");
  }

  /**
   * Wiki publication intentionally precedes the proposal state transition. If
   * the process stops in that narrow gap, the journal contains enough bounded
   * audit state to recreate only the exact reviewed proposal bytes. It never
   * replays or reconstructs a Wiki operation plan.
   */
  async #completeInterruptedProposalApproval(
    effects: readonly TeamWorkflowJournalEffect[],
    durableWikiComplete = false,
  ): Promise<void> {
    const wikiEffects = effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "wiki",
    );
    const requiredWikiEffects = durableWikiComplete
      ? wikiEffects.filter((effect) => !isWikiOperationLogEffect(effect))
      : wikiEffects;
    const proposal = effects.find(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "proposal",
    );
    if (
      wikiEffects.length === 0
      || proposal === undefined
      || this.#effectApplied(proposal)
      || !requiredWikiEffects.every((effect) => this.#effectApplied(effect))
    ) {
      return;
    }
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (
      activity === undefined
      || activity.action !== "inbox.approved"
      || proposal.beforeRevision === null
      || proposal.afterRevision === null
    ) {
      throw incompleteRecovery();
    }
    const current = await this.#proposals.get(proposal.id);
    if (
      current === null
      || current.revision !== proposal.beforeRevision
      || current.sourcePath !== proposal.path
    ) {
      throw incompleteRecovery();
    }
    const plan = await this.#proposals.previewUpdate(current.ref.id, {
      ...withoutStored(current),
      state: "approved",
      reviewer: activity.actor,
      reviewedAt: activity.occurredAt,
    }, current.revision);
    if (
      plan.change.path !== proposal.path
      || plan.change.beforeRevision !== proposal.beforeRevision
      || plan.change.afterRevision !== proposal.afterRevision
    ) {
      throw incompleteRecovery();
    }
    await this.#proposals.apply(plan, plan.previewRevision);
  }

  async #wikiRecoveryContext(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    effects: readonly TeamWorkflowJournalEffect[],
    recovery: WikiRecoveryWorkflowEffect,
  ): Promise<WikiRecoveryContext<TWikiPayload, TWikiPlan>> {
    if (command.action.kind !== "inbox.approve") {
      throw wikiRecoveryConflict(
        "The durable Wiki recovery metadata is not bound to an Inbox approval.",
      );
    }
    const proposalEffect = effects.find(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "proposal",
    );
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (
      proposalEffect === undefined
      || activity === undefined
      || activity.action !== "inbox.approved"
      || proposalEffect.id !== command.action.proposalId
    ) {
      throw wikiRecoveryConflict(
        "The durable Wiki recovery metadata does not match the reviewed proposal.",
      );
    }
    const proposal = await this.#proposals.get(proposalEffect.id);
    if (
      proposal === null
      || proposal.sourcePath !== proposalEffect.path
      || (proposal.revision !== proposalEffect.beforeRevision
        && proposal.revision !== proposalEffect.afterRevision)
    ) {
      throw targetRevisionChanged(proposalEffect.path);
    }
    const specChange = storedSpecChange(
      proposal as unknown as InboxProposal<JsonValue>,
    );
    const recoveredSpecId = (specChange !== null && isInboxCreateChange(specChange))
      ? recoveryCreatedSpecId(
          effects,
          proposal.ref.id,
          specChange.entityKind,
        )
      : null;
    if ((specChange !== null && isInboxCreateChange(specChange)) && recoveredSpecId === null) {
      throw wikiRecoveryConflict(
        "The durable Wiki recovery manifest lost the receipt-pinned entity ID.",
      );
    }
    const request = specChange === null
      ? portableWikiRequest(
          proposal,
          activity.actor,
          activity.occurredAt,
        )
      : materializeSpecWikiRequest(
          proposal as unknown as InboxProposal<JsonValue>,
          {
            actor: activity.actor,
            occurredAt: activity.occurredAt,
            repoState: activity.repoState,
          },
          isInboxCreateChange(specChange) ? recoveredSpecId! : undefined,
        ) as unknown as WikiOperationRequest<TWikiPayload>;
    if (recovery.manifest.operationId !== request.operation.opId) {
      throw wikiRecoveryConflict(
        "The durable Wiki recovery manifest identifies a different operation.",
      );
    }
    const port = asRecoverableWikiPort(this.#wiki);
    if (port === null) {
      throw artifactError(
        "OPERATION_INTERRUPTED",
        "Wiki recovery adapter is unavailable",
        "The reviewed Wiki adapter cannot resume this bounded operation. Restore the compatible adapter and retry.",
      );
    }
    return {
      port,
      request,
      manifest: recovery.manifest,
      inspection: port.inspectOperationRecovery(request),
    };
  }

  #wikiPrimaryEffects(
    effects: readonly TeamWorkflowJournalEffect[],
  ): readonly CanonicalWorkflowEffect[] {
    return effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "wiki",
    );
  }

  #assertResumedWikiChanges(
    effects: readonly TeamWorkflowJournalEffect[],
    changes: readonly FileChange[],
  ): void {
    const expected = new Map(
      this.#wikiPrimaryEffects(effects).map((effect) => [effect.path, effect]),
    );
    const seen = new Set<RepoRelativePath>();
    for (const change of changes) {
      const effect = expected.get(change.path);
      if (
        effect === undefined
        || seen.has(change.path)
        || change.afterRevision !== effect.afterRevision
      ) {
        throw wikiRecoveryConflict(
          "The resumed Wiki preview does not match the journaled canonical effects.",
        );
      }
      const observed = tryReadContainedArtifact(
        this.#root.path,
        change.path,
        recoveryFileByteLimit(change.path),
        "exact",
      );
      if ((observed?.revision ?? null) !== change.beforeRevision) {
        throw targetRevisionChanged(change.path);
      }
      seen.add(change.path);
    }
    for (const effect of expected.values()) {
      if (this.#effectState(effect) !== "after" && !seen.has(effect.path)) {
        throw wikiRecoveryConflict(
          "The resumed Wiki preview omits an unfinished canonical effect.",
        );
      }
    }
  }

  #assertWikiPrimaryEffectsPublished(
    effects: readonly TeamWorkflowJournalEffect[],
  ): void {
    for (const effect of this.#wikiPrimaryEffects(effects)) {
      if (isWikiOperationLogEffect(effect)) continue;
      if (this.#effectState(effect) !== "after") {
        throw targetRevisionChanged(effect.path);
      }
    }
  }

  async #refreshRecoveredWikiIndex(
    effects: readonly TeamWorkflowJournalEffect[],
  ): Promise<void> {
    const paths = [...new Set(
      this.#wikiPrimaryEffects(effects)
        .filter((effect) => !isWikiOperationLogEffect(effect))
        .map((effect) => effect.path),
    )].sort(compareCodePoints);
    if (paths.length > 0) await this.#wiki.refreshFiles(paths);
  }

  #assertNonAuditPrimaryEffectsPublished(
    effects: readonly TeamWorkflowJournalEffect[],
  ): void {
    for (const effect of effects) {
      if (effect.kind !== "canonical" && effect.kind !== "local") continue;
      if (effect.kind === "canonical" && isWikiOperationLogEffect(effect)) continue;
      if (this.#effectState(effect) !== "after") {
        throw targetRevisionChanged(
          effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
        );
      }
    }
  }

  #assertNoDivergentNonWikiPrimaryEffects(
    effects: readonly TeamWorkflowJournalEffect[],
  ): void {
    for (const effect of effects) {
      if (effect.kind !== "canonical" && effect.kind !== "local") continue;
      if (effect.kind === "canonical" && effect.namespace === "wiki") continue;
      if (this.#effectState(effect) !== "divergent") continue;
      throw targetRevisionChanged(
        effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
      );
    }
  }

  async #assertRecoveryCheckpoint(effects: readonly TeamWorkflowJournalEffect[]): Promise<void> {
    this.#root.assertCurrent();
    const activity = effects.find((effect): effect is ActivityWorkflowEffect => effect.kind === "activity");
    if (activity === undefined) return;
    const current = await this.#git.getRepoState();
    if (current.branch !== activity.repoState.branch || current.head !== activity.repoState.head) {
      throw repositoryChanged();
    }
  }

  #assertPrimaryEffectsPublished(effects: readonly TeamWorkflowJournalEffect[]): void {
    if (this.#primaryEffectState(effects) !== "all") {
      throw incompleteRecovery();
    }
  }

  #assertNoDivergentPrimaryEffects(effects: readonly TeamWorkflowJournalEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== "canonical" && effect.kind !== "local") continue;
      if (this.#effectState(effect) !== "divergent") continue;
      throw targetRevisionChanged(
        effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
      );
    }
  }

  #assertActivityPublished(effects: readonly TeamWorkflowJournalEffect[]): void {
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activity === undefined) return;
    const stored = tryReadContainedArtifact(
      this.#root.path,
      activity.path,
      ACTIVITY_ARTIFACT_MAX_BYTES,
      "canonical",
    );
    if (stored?.revision !== activity.revision) throw incompleteRecovery();
  }

  #isAuditOnlyPending(effects: readonly TeamWorkflowJournalEffect[]): boolean {
    if (effects.some((effect) => effect.kind === "canonical" || effect.kind === "local")) {
      return false;
    }
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activity === undefined) return false;
    return tryReadContainedArtifact(
      this.#root.path,
      activity.path,
      ACTIVITY_ARTIFACT_MAX_BYTES,
      "canonical",
    )?.revision !== activity.revision;
  }

  #assertCleanupPending(effects: readonly TeamWorkflowJournalEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== "local_cleanup") continue;
      const draft = this.#local.getLocalDraft(effect.draftId);
      if (draft?.kind !== effect.draftKind || draft.revision !== effect.expectedRevision) {
        throw incompleteRecovery();
      }
    }
  }

  #assertCleanupApplied(effects: readonly TeamWorkflowJournalEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== "local_cleanup") continue;
      if (this.#local.getLocalDraft(effect.draftId) !== null) {
        throw incompleteRecovery();
      }
    }
  }

  async #recoverActivity(effects: readonly TeamWorkflowJournalEffect[]): Promise<void> {
    const effect = effects.find((item): item is ActivityWorkflowEffect => item.kind === "activity");
    if (effect === undefined) return;
    const label = await this.#recoverActivityLabel(effects, effect);
    await this.#activity.recoverJournaledCreate(
      activityEventFromEffect(effect, label),
      effect.revision,
    );
  }

  async #recoverActivityLabel(
    effects: readonly TeamWorkflowJournalEffect[],
    activity: ActivityWorkflowEffect,
  ): Promise<string | undefined> {
    if (activity.schemaVersion !== 2 || activity.origin.kind !== "workflow") {
      return undefined;
    }
    const canonical = (namespace: string): CanonicalWorkflowEffect | undefined =>
      effects.find((effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === namespace);
    const operation = activity.origin.operation;
    if (operation.startsWith("member.")) {
      const effect = canonical("member");
      const member = effect === undefined ? null : await this.#members.get(effect.id);
      return effect !== undefined && member !== null && member.revision === effect.afterRevision
        ? activityLabelExcerpt(member.displayName)
        : undefined;
    }
    if (operation.startsWith("workstream.")) {
      const effect = canonical("workstream");
      const workstream = effect === undefined ? null : await this.#workstreams.get(effect.id);
      return effect !== undefined && workstream !== null && workstream.revision === effect.afterRevision
        ? activityLabelExcerpt(workstream.title)
        : undefined;
    }
    if (operation.startsWith("inbox.")) {
      const effect = canonical("proposal");
      const proposal = effect === undefined ? null : await this.#proposals.get(effect.id);
      const title = proposal === null
        ? undefined
        : productProposalProjection(proposal as unknown as InboxProposal<JsonValue>)?.title;
      return effect !== undefined && proposal !== null
        && proposal.revision === effect.afterRevision && title !== undefined
        ? activityLabelExcerpt(title)
        : undefined;
    }
    if (operation.startsWith("relay.")) {
      const effect = canonical("relay");
      const relay = effect === undefined ? null : await this.#relays.get(effect.id);
      return effect !== undefined && relay !== null && relay.revision === effect.afterRevision
        ? activityLabelExcerpt(relay.summary)
        : undefined;
    }
    if (operation.startsWith("playbook.run.")) {
      const effect = canonical("playbook-run");
      const run = effect === undefined ? null : await this.#runs.get(effect.id);
      return effect !== undefined && run !== null
        && run.revision === effect.afterRevision && run.playbook.title !== undefined
        ? activityLabelExcerpt(run.playbook.title)
        : undefined;
    }
    if (operation.startsWith("playbook.")) {
      const effect = canonical("playbook");
      const playbook = effect === undefined ? null : await this.#playbooks.get(effect.id);
      return effect !== undefined && playbook !== null && playbook.revision === effect.afterRevision
        ? activityLabelExcerpt(playbook.title)
        : undefined;
    }
    return undefined;
  }

  #primaryEffectState(effects: readonly TeamWorkflowJournalEffect[]): "none" | "some" | "all" {
    const primaryEffects = effects.filter((effect) => effect.kind === "canonical" || effect.kind === "local");
    if (primaryEffects.length === 0) return "all";
    const states = primaryEffects.map((effect) => this.#effectState(effect));
    if (states.every((state) => state === "after")) return "all";
    if (states.every((state) => state === "before")) return "none";
    return "some";
  }

  #effectApplied(effect: CanonicalWorkflowEffect | LocalWorkflowEffect): boolean {
    return this.#effectState(effect) === "after";
  }

  #effectState(
    effect: CanonicalWorkflowEffect | LocalWorkflowEffect,
  ): "before" | "after" | "divergent" {
    if (effect.kind === "canonical") {
      const read = tryReadContainedArtifact(
        this.#root.path,
        effect.path,
        recoveryFileByteLimit(effect.path),
        effect.namespace === "wiki" ? "exact" : teamArtifactByteMode(effect.path),
      );
      const revision = read?.revision ?? null;
      if (revision === effect.afterRevision) return "after";
      if (revision === effect.beforeRevision) return "before";
      return "divergent";
    }
    if (effect.namespace === MEMBER_SELECTION_NAMESPACE) {
      if (effect.id !== MEMBER_SELECTION_ID) return "divergent";
      const revision = this.#local.getConfiguredMember()?.revision ?? null;
      if (revision === effect.afterRevision) return "after";
      if (revision === effect.beforeRevision) return "before";
      return "divergent";
    }
    if (effect.namespace !== "inbox-draft" && effect.namespace !== "relay-draft") return "divergent";
    let current: StoredLocalDraft<unknown> | null;
    try {
      current = this.#local.getLocalDraft(effect.id);
    } catch (error) {
      // Schemas v1-v3 predate local drafts. A create preview whose expected
      // before revision is null can therefore prove absence without writing;
      // the explicit apply migrates before the under-lease revalidation.
      if (
        error instanceof MexPortError
        && error.problem.code === "MIGRATION_REQUIRED"
        && effect.beforeRevision === null
      ) {
        return "before";
      }
      throw error;
    }
    const expectedKind = effect.namespace === "inbox-draft" ? "inbox" : "relay";
    const revision = current === null || current.kind !== expectedKind
      ? null
      : current.revision;
    if (revision === effect.afterRevision) return "after";
    if (revision === effect.beforeRevision) return "before";
    return "divergent";
  }

  async #resultFromEffects(
    entry: TeamWorkflowJournalEntry,
    idempotentReplay: boolean,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    const artifacts: TeamArtifact<TWikiPayload>[] = [];
    for (const effect of entry.effects) {
      if (effect.kind !== "canonical" || effect.namespace === "wiki") continue;
      const kind = namespaceToArtifactKind(effect.namespace);
      if (kind === null) continue;
      const artifact = await this.getArtifact({ id: effect.id, kind });
      if (artifact !== null && artifact.revision === effect.afterRevision) {
        artifacts.push(artifact);
      }
    }
    const activityEffectValue = entry.effects.find((effect): effect is ActivityWorkflowEffect => effect.kind === "activity");
    const event = activityEffectValue === undefined
      ? null
      : await this.#activity.get(activityEffectValue.id);
    if (
      activityEffectValue !== undefined
      && (event === null
        || event.sourcePath !== activityEffectValue.path
        || event.revision !== activityEffectValue.revision)
    ) throw incompleteRecovery();
    return {
      operationId: entry.operationId,
      previewRevision: entry.previewRevision,
      applied: true,
      idempotentReplay,
      changes: [],
      localChanges: entry.effects.flatMap(effectToLocalChange),
      artifacts,
      events: event === null ? [] : [event],
    };
  }

  async #listArtifacts(request: TeamArtifactListRequest): Promise<TeamPage<TeamArtifact<TWikiPayload>>> {
    if (request.includeArchived !== undefined && typeof request.includeArchived !== "boolean") {
      throw artifactError(
        "INVALID_REQUEST",
        "Invalid artifact archive filter",
        "includeArchived must be a boolean.",
      );
    }
    const limit = normalizeLimit(request.limit);
    const kinds = normalizeKinds(request.kinds);
    const states = normalizeStates(request.states);
    const filterRevision = hashJson({ kinds, states, includeArchived: request.includeArchived ?? false });
    const memberItems = kinds.includes("member") ? await this.#members.list() : [];
    const nonMemberKinds = kinds.filter((kind) => kind !== "member");
    const probes = await Promise.all(nonMemberKinds.map((kind) => this.#listKind(kind, {
      limit: 1,
      states,
      includeArchived: request.includeArchived,
    })));
    const repositoryRevisions = new Map(
      nonMemberKinds.map((kind, index) => [kind, probes[index]!.deterministicRevision]),
    );
    const corpusRevision = hashJson({
      members: memberItems.map((member) => [member.sourcePath, member.revision]),
      repositories: probes.map((page, index) => [nonMemberKinds[index], page.deterministicRevision]),
    });
    const cursor = decodeArtifactCursor(request.cursor, corpusRevision, filterRevision, kinds.length);
    const items: TeamArtifact<TWikiPayload>[] = [];
    let kindIndex = cursor?.kindIndex ?? 0;
    let innerCursor = cursor?.innerCursor ?? null;
    let memberOffset = cursor?.memberOffset ?? 0;

    while (kindIndex < kinds.length && items.length < limit) {
      const kind = kinds[kindIndex]!;
      if (kind === "member") {
        // Member activation is not a TeamArtifactState. A cross-kind state
        // filter therefore excludes members instead of inventing a state.
        const available = states === null ? memberItems : [];
        const take = Math.min(limit - items.length, available.length - memberOffset);
        items.push(...available.slice(memberOffset, memberOffset + take));
        memberOffset += take;
        if (memberOffset < available.length) break;
        kindIndex += 1; memberOffset = 0; innerCursor = null; continue;
      }
      const page = await this.#listKind(kind, {
        limit: limit - items.length,
        ...(innerCursor === null ? {} : { cursor: innerCursor }),
        states,
        includeArchived: request.includeArchived,
      });
      if (page.deterministicRevision !== repositoryRevisions.get(kind)) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Workflow artifact collection changed",
          "The artifact collection changed while the combined page was assembled. Restart listing.",
        );
      }
      items.push(...page.items);
      if (page.nextCursor !== null) { innerCursor = page.nextCursor; break; }
      kindIndex += 1; innerCursor = null;
    }
    const hasMore = kindIndex < kinds.length;
    return {
      items,
      nextCursor: hasMore ? encodeArtifactCursor({ v: 1, kindIndex, innerCursor, memberOffset, corpusRevision, filterRevision }) : null,
      truncated: hasMore,
      sourceTruncated: false,
      deterministicRevision: corpusRevision,
      diagnostics: probes.flatMap((page) => page.diagnostics).slice(0, 100),
    };
  }

  #listKind(kind: Exclude<TeamArtifactKind, "member">, request: { limit: number; cursor?: string; states: readonly TeamArtifactState[] | null; includeArchived?: boolean }): Promise<WorkflowRepositoryPage<any>> {
    const base = { limit: request.limit, ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.includeArchived === undefined ? {} : { includeArchived: request.includeArchived }) };
    switch (kind) {
      case "workstream": return listRepositoryPage(this.#workstreams, base, request.states?.filter(isWorkstreamState) ?? null);
      case "proposal": return listRepositoryPage(this.#proposals, base, request.states?.filter(isProposalState) ?? null);
      case "relay": return listRepositoryPage(this.#relays, base, request.states?.filter(isRelayState) ?? null);
      case "playbook": return listRepositoryPage(this.#playbooks, base, request.states?.filter(isPlaybookState) ?? null);
      case "playbook_run": return listRepositoryPage(this.#runs, base, request.states?.filter(isRunState) ?? null);
    }
  }

  #nowIso(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw artifactError("VALIDATION_FAILED", "Invalid workflow clock", "The Team workflow clock is invalid.");
    }
    return value.toISOString();
  }
}

/**
 * Production composition. The checkout supplies its one tracked scaffold
 * identity and both Git/Wiki adapters are constructed against the same
 * physically-bound root. Dependency injection is intentionally unavailable
 * on this path so two callers cannot select different local-state namespaces
 * or mutate a different checkout.
 */
export async function createRepositoryTeamWorkflowPort(
  projectRoot: string,
): Promise<RepositoryTeamWorkflowPort<RepositoryWikiOperationPayload, RepositoryWikiOperationPlan>> {
  const root = new RepositoryRootGuard(projectRoot);
  const git = createRepositoryGitPort(root.path);
  const config = tryReadContainedArtifact(
    root.path,
    ".mex/config.json",
    64 * 1024,
    "exact",
  );
  if (config === null) {
    throw missingScaffoldIdentity();
  }

  const authority = await git.getRepoState();
  if (authority.head === null) {
    throw missingScaffoldIdentity();
  }
  const trackedConfig = await git.readFileAtRevision({
    revision: authority.head,
    path: ".mex/config.json",
    maxBytes: 64 * 1024,
  });
  // Compare the whole tracked config after undoing checkout CRLF conversion.
  // Keep the observed file and revision exact so a concurrent line-ending edit
  // still invalidates the second read below.
  if (
    trackedConfig === null
    || trackedConfig.truncated
    || !Buffer.from(canonicalCheckoutBytes(trackedConfig.content))
      .equals(Buffer.from(canonicalCheckoutBytes(config.bytes)))
  ) {
    throw missingScaffoldIdentity();
  }

  root.assertCurrent();
  const confirmedConfig = tryReadContainedArtifact(
    root.path,
    ".mex/config.json",
    64 * 1024,
    "exact",
  );
  const confirmedAuthority = await git.getRepoState();
  if (
    confirmedConfig === null
    || confirmedConfig.revision !== config.revision
    || !sameRepoCheckpoint(authority, confirmedAuthority)
  ) {
    throw repositoryChanged();
  }
  const scaffoldId = scaffoldIdentityOf(confirmedConfig.bytes);
  if (scaffoldId === null) {
    throw missingScaffoldIdentity();
  }
  return new RepositoryTeamWorkflowPort(root.path, {
    scaffoldId,
    git,
    wiki: createRepositoryWikiPort(root.path),
  });
}

/** @internal Test/conformance seam; never export from the workflow barrel. */
export function createRepositoryTeamWorkflowPortWithDependencies<
  TWikiPayload extends JsonValue,
  TWikiPlan = unknown,
>(
  projectRoot: string,
  options: RepositoryTeamWorkflowPortOptions<TWikiPayload, TWikiPlan>,
): RepositoryTeamWorkflowPort<TWikiPayload, TWikiPlan> {
  return new RepositoryTeamWorkflowPort(projectRoot, options);
}

export class WorkflowPhaseInterruption extends MexPortError {
  constructor(
    readonly boundary: TeamWorkflowPhaseBoundary,
    options: ErrorOptions = {},
  ) {
    super({
      title: "Team workflow interrupted",
      status: 409,
      code: "OPERATION_INTERRUPTED",
      detail: `The Team workflow was interrupted at ${boundary} and must be recovered by exact replay.`,
    });
    this.name = "WorkflowPhaseInterruption";
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
      });
    }
  }
}

function publicPreviewFrom(
  preview: TeamWorkflowPreview<JsonValue>,
): TeamIdentityActivityPublicPreview;
function publicPreviewFrom<TWikiPayload extends JsonValue>(
  preview: TeamWorkflowPreview<TWikiPayload>,
): TeamIdentityActivityPublicPreview;
function publicPreviewFrom<TWikiPayload extends JsonValue>(
  preview: TeamWorkflowPreview<TWikiPayload>,
): TeamIdentityActivityPublicPreview {
  return deepFreeze({
    valid: preview.valid,
    scope: preview.scope,
    changes: preview.changes,
    localChanges: preview.localChanges,
    diagnostics: preview.diagnostics,
  });
}

function inboxPublicPreviewFrom<TWikiPayload extends JsonValue>(
  preview: TeamWorkflowPreview<TWikiPayload>,
): TeamInboxSpecPreviewEnvelope["preview"] {
  if (preview.localChanges.some((change) => change.namespace !== "inbox-draft")) {
    throw previewConflict();
  }
  return deepFreeze({
    valid: preview.valid,
    scope: preview.scope,
    changes: preview.changes.map(inboxPresentationChange),
    localChanges: preview.localChanges as TeamInboxSpecPreviewEnvelope["preview"]["localChanges"],
    diagnostics: preview.diagnostics,
  });
}

/** Show CR unambiguously in the signed display; executable text and hashes stay exact. */
function inboxPresentationChange(change: FileChange): FileChange {
  if (!change.diff.includes("\r")) return change;
  return {
    ...change,
    diff: `Carriage returns are displayed as \\r; literal backslashes as \\\\ below.\n${change.diff.replaceAll("\\", "\\\\").replaceAll("\r", "\\r")}`,
  };
}

function relayPublicPreviewFrom<TWikiPayload extends JsonValue>(
  preview: TeamWorkflowPreview<TWikiPayload>,
): TeamRelayPreviewEnvelope["preview"] {
  if (preview.localChanges.some((change) => change.namespace !== "relay-draft")) {
    throw previewConflict();
  }
  return deepFreeze({
    valid: preview.valid,
    scope: preview.scope,
    changes: preview.changes,
    localChanges: preview.localChanges as TeamRelayPreviewEnvelope["preview"]["localChanges"],
    diagnostics: preview.diagnostics,
  });
}

function workflowCommandFromInbox<TWikiPayload extends JsonValue>(
  command: TeamInboxSpecCommand,
): TeamWorkflowCommand<TWikiPayload> {
  const action = command.action;
  const translated = action.kind === "inbox.draft.save"
    ? {
        kind: action.kind,
        ...(action.draftId === undefined ? {} : { draftId: action.draftId }),
        draft: inboxDraftInputFromProduct(
          action.draft,
          command.operationId,
        ) as unknown as InboxDraftInput<TWikiPayload>,
      }
    : action.kind === "inbox.repair"
      ? {
          kind: action.kind,
          proposalId: action.proposalId,
          replacement: inboxDraftInputFromProduct(
            action.replacement,
            command.operationId,
          ) as unknown as InboxDraftInput<TWikiPayload>,
        }
      : action;
  return deepFreeze({
    operationId: command.operationId,
    action: translated,
    expectedRevisions: command.expectedRevisions,
  }) as TeamWorkflowCommand<TWikiPayload>;
}

function inboxPurposeIdsFromPrepared<
  TWikiPayload extends JsonValue,
  TWikiPlan,
>(
  command: TeamInboxSpecCommand,
  prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
): readonly TeamInboxSpecPurposeId[] {
  const purposes: TeamInboxSpecPurposeId[] = [];
  if (
    command.action.kind === "inbox.draft.save"
    && command.action.draftId === undefined
  ) {
    const drafts = prepared.effects.filter(
      (effect): effect is LocalWorkflowEffect =>
        effect.kind === "local" && effect.namespace === "inbox-draft",
    );
    if (drafts.length !== 1 || drafts[0]!.beforeRevision !== null) {
      throw previewConflict();
    }
    purposes.push({ purpose: "inbox-draft", id: drafts[0]!.id });
  }
  if (command.action.kind === "inbox.publish") {
    const proposals = prepared.effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "proposal",
    );
    if (proposals.length !== 1 || proposals[0]!.beforeRevision !== null) {
      throw previewConflict();
    }
    purposes.push({ purpose: "proposal", id: proposals[0]!.id });
  }
  if (
    command.action.kind === "inbox.publish"
    || command.action.kind === "inbox.approve"
    || command.action.kind === "inbox.reject"
    || command.action.kind === "inbox.withdraw"
    || command.action.kind === "inbox.mark-stale"
    || command.action.kind === "inbox.repair"
  ) {
    const activities = prepared.effects.filter(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activities.length !== 1) throw previewConflict();
    purposes.push({ purpose: "activity", id: activities[0]!.id });
  }
  if (
    command.action.kind === "inbox.approve"
    && prepared.wiki?.request.operation.type === "create-entry"
  ) {
    const affected = prepared.wiki.preview.affectedEntities.filter(
      (entity) => isEntityId(entity.id) && entity.id.startsWith("mx_"),
    );
    if (affected.length !== 1) throw previewConflict();
    const createdId = affected[0]!.id;
    const manifestIds = prepared.wiki.preview.recoveryManifest?.items.flatMap(
      (item) => item.createdIds,
    );
    if (
      manifestIds !== undefined
      && (manifestIds.length !== 1 || manifestIds[0] !== createdId)
    ) throw previewConflict();
    purposes.push({ purpose: "spec-entity", id: createdId });
  }
  if (purposes.length > TEAM_INBOX_SPEC_LIMITS.maxPurposeIds) {
    throw previewConflict();
  }
  purposes.sort((left, right) => compareCodePoints(left.purpose, right.purpose));
  if (
    new Set(purposes.map((item) => item.purpose)).size !== purposes.length
    || new Set(purposes.map((item) => item.id)).size !== purposes.length
  ) throw previewConflict();
  return deepFreeze(purposes);
}

function relayPurposeIdsFromPrepared<
  TWikiPayload extends JsonValue,
  TWikiPlan,
>(
  command: TeamRelayCommand,
  prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
): readonly TeamRelayPurposeId[] {
  const purposes: TeamRelayPurposeId[] = [];
  if (
    command.action.kind === "relay.draft.save"
    && command.action.draftId === undefined
  ) {
    const drafts = prepared.effects.filter(
      (effect): effect is LocalWorkflowEffect =>
        effect.kind === "local" && effect.namespace === "relay-draft",
    );
    if (drafts.length !== 1 || drafts[0]!.beforeRevision !== null) {
      throw previewConflict();
    }
    purposes.push({ purpose: "relay-draft", id: drafts[0]!.id });
  }
  if (command.action.kind === "relay.publish") {
    const relays = prepared.effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "relay",
    );
    if (relays.length !== 1 || relays[0]!.beforeRevision !== null) {
      throw previewConflict();
    }
    purposes.push({ purpose: "relay", id: relays[0]!.id });
  }
  if (
    command.action.kind === "relay.publish"
    || command.action.kind === "relay.acknowledge"
    || command.action.kind === "relay.close"
  ) {
    const activities = prepared.effects.filter(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activities.length !== 1) throw previewConflict();
    purposes.push({ purpose: "activity", id: activities[0]!.id });
  }
  purposes.sort((left, right) => compareCodePoints(left.purpose, right.purpose));
  if (
    purposes.length > TEAM_RELAY_LIMITS.maxPurposeIds
    || new Set(purposes.map((item) => item.purpose)).size !== purposes.length
    || new Set(purposes.map((item) => item.id)).size !== purposes.length
  ) throw previewConflict();
  return deepFreeze(purposes);
}

function commandFromPrepared<TWikiPayload extends JsonValue>(
  command: PreparedTeamWorkflowCommand<TWikiPayload>,
): TeamWorkflowCommand<TWikiPayload> {
  const { authority: _authority, ...request } = command;
  return deepFreeze(request) as TeamWorkflowCommand<TWikiPayload>;
}

function withPortableEnvelopeAttestation<
  TWikiPayload extends JsonValue,
  TWikiPlan,
>(
  prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
  previewRevision: Revision,
  envelopeRevision: Revision,
): PreparedOperation<TWikiPayload, TWikiPlan> {
  return {
    ...prepared,
    preview: deepFreeze({
      ...prepared.preview,
      previewRevision,
    }),
    effects: normalizeTeamWorkflowJournalEffects([
      ...prepared.effects,
      {
        kind: "identity_activity_receipt",
        envelopeRevision,
      } satisfies IdentityActivityReceiptWorkflowEffect,
    ]),
  };
}

function identityActivityEnvelopeRevision(
  envelope: TeamIdentityActivityPreviewEnvelope,
): Revision {
  return hashText(boundedIdentityEnvelopeJson(envelope));
}

function workstreamEnvelopeRevision(
  envelope: TeamWorkstreamPreviewEnvelope,
): Revision {
  return hashText(boundedWorkstreamEnvelopeJson(envelope));
}

function inboxEnvelopeRevision(
  envelope: TeamInboxSpecPreviewEnvelope,
): Revision {
  return hashText(boundedInboxJson(envelope));
}

function relayEnvelopeRevision(
  envelope: TeamRelayPreviewEnvelope,
): Revision {
  return hashText(boundedRelayJson(envelope));
}

function assertJournalEnvelopeAttestation(
  effects: readonly TeamWorkflowJournalEffect[],
  envelope: TeamIdentityActivityPreviewEnvelope
    | TeamWorkstreamPreviewEnvelope
    | TeamInboxSpecPreviewEnvelope
    | TeamRelayPreviewEnvelope,
): void {
  const receipts = effects.filter(
    (effect): effect is IdentityActivityReceiptWorkflowEffect =>
      effect.kind === "identity_activity_receipt",
  );
  if (
    receipts.length !== 1
    || receipts[0]!.envelopeRevision !== portableEnvelopeRevision(envelope)
  ) {
    throw previewConflict();
  }
}

function portableEnvelopeRevision(
  envelope: TeamIdentityActivityPreviewEnvelope
    | TeamWorkstreamPreviewEnvelope
    | TeamInboxSpecPreviewEnvelope
    | TeamRelayPreviewEnvelope,
): Revision {
  if (envelope.request.action.kind.startsWith("workstream.")) {
    return workstreamEnvelopeRevision(envelope as TeamWorkstreamPreviewEnvelope);
  }
  if (envelope.request.action.kind.startsWith("inbox.")) {
    return inboxEnvelopeRevision(envelope as TeamInboxSpecPreviewEnvelope);
  }
  if (envelope.request.action.kind.startsWith("relay.")) {
    return relayEnvelopeRevision(envelope as TeamRelayPreviewEnvelope);
  }
  return identityActivityEnvelopeRevision(
    envelope as TeamIdentityActivityPreviewEnvelope,
  );
}

function isAuditOnlyEffects(effects: readonly TeamWorkflowJournalEffect[]): boolean {
  return effects.some((effect) => effect.kind === "activity")
    && !effects.some((effect) => effect.kind === "canonical" || effect.kind === "local");
}

function purposeIdsFromEffects(
  action: TeamIdentityActivityCommand["action"]["kind"],
  effects: readonly TeamWorkflowJournalEffect[],
): readonly TeamIdentityActivityPurposeId[] {
  const purposes: TeamIdentityActivityPurposeId[] = [];
  if (action === "member.add") {
    const members = effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "member",
    );
    if (members.length !== 1) throw previewConflict();
    purposes.push({ purpose: "member", id: members[0]!.id });
  }
  if (
    action === "member.add"
    || action === "member.update"
    || action === "member.deactivate"
    || action === "member.reactivate"
    || action === "activity.record"
  ) {
    const activities = effects.filter(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activities.length !== 1) throw previewConflict();
    purposes.push({ purpose: "activity", id: activities[0]!.id });
  } else if (effects.some((effect) => effect.kind === "activity")) {
    throw previewConflict();
  }
  purposes.sort((left, right) => compareCodePoints(left.purpose, right.purpose));
  return deepFreeze(purposes);
}

function workstreamPurposeIdsFromEffects(
  action: TeamWorkstreamCommand["action"]["kind"],
  effects: readonly TeamWorkflowJournalEffect[],
): readonly TeamWorkstreamPurposeId[] {
  const purposes: TeamWorkstreamPurposeId[] = [];
  if (action === "workstream.create") {
    const workstreams = effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "workstream",
    );
    if (workstreams.length !== 1) throw previewConflict();
    purposes.push({ purpose: "workstream", id: workstreams[0]!.id });
  }
  const activities = effects.filter(
    (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
  );
  if (activities.length !== 1) throw previewConflict();
  purposes.push({ purpose: "activity", id: activities[0]!.id });
  purposes.sort((left, right) => compareCodePoints(left.purpose, right.purpose));
  return deepFreeze(purposes);
}

function purposeId(
  purposes: readonly PortableWorkflowPurposeId[] | undefined,
  purpose: PortableWorkflowPurposeId["purpose"],
): string | undefined {
  if (purposes === undefined) return undefined;
  return purposes.find((item) => item.purpose === purpose)?.id;
}

function assertIdentityActivityCommand(
  value: unknown,
): asserts value is TeamIdentityActivityCommand {
  assertCommandShape(value);
  assertOperationId(value.operationId);
  assertNoCallerAuthority(value);
  normalizeWorkflowRevisionExpectations(value.expectedRevisions);
  const action = value.action;
  switch (action.kind) {
    case "member.add": {
      if (!isPlainObject(action.member)) invalidIdentityActivityCommand();
      if (Object.hasOwn(action.member, "active")) invalidIdentityActivityCommand();
      exactIdentityKeys(action.member, ["displayName", "gitAliases"]);
      break;
    }
    case "member.update": {
      if (!isPlainObject(action.patch)) invalidIdentityActivityCommand();
      exactIdentityKeys(action.patch, [], ["displayName", "gitAliases"]);
      if (Object.keys(action.patch).length === 0) invalidIdentityActivityCommand();
      break;
    }
    case "member.deactivate":
    case "member.reactivate":
    case "member.select":
    case "member.clear":
      break;
    case "activity.record": {
      if (!isPlainObject(action.activity)) invalidIdentityActivityCommand();
      exactIdentityKeys(
        action.activity,
        ["action", "subjects"],
        ["workstream"],
      );
      break;
    }
    default:
      invalidIdentityActivityCommand();
  }
  boundedIdentityEnvelopeJson(value);
}

function assertWorkstreamCommand(
  value: unknown,
): asserts value is TeamWorkstreamCommand {
  assertCommandShape(value);
  assertOperationId(value.operationId);
  assertNoCallerAuthority(value);
  const expectations = normalizeWorkflowRevisionExpectations(
    value.expectedRevisions,
  );
  if (
    value.action.kind !== "workstream.create"
    && value.action.kind !== "workstream.update"
    && value.action.kind !== "workstream.archive"
  ) {
    invalidWorkstreamCommand();
  }
  if (
    value.action.kind !== "workstream.create"
    && expectations.length === 0
  ) {
    invalidWorkstreamCommand();
  }
  if (value.action.kind === "workstream.create") {
    if (!isPlainObject(value.action.workstream)) invalidWorkstreamCommand();
    exactWorkstreamCommandKeys(
      value.action.workstream,
      ["title", "goal", "summary", "owners", "nextMilestone"],
      [
        "contributors", "paths", "code", "topics", "components", "related",
      ],
    );
  }
  if (value.action.kind === "workstream.update") {
    if (!isPlainObject(value.action.patch)) invalidWorkstreamCommand();
    exactWorkstreamCommandKeys(value.action.patch, [], [
      "title", "goal", "summary", "state", "owners", "contributors",
      "paths", "code", "topics", "components", "related", "blockers",
      "currentState", "nextMilestone",
    ]);
    if (
      Object.keys(value.action.patch).length === 0
      || value.action.patch.state === "archived"
    ) {
      invalidWorkstreamCommand();
    }
  }
  boundedWorkstreamEnvelopeJson(value);
}

function assertIdentityActivityEnvelope(
  value: unknown,
): asserts value is TeamIdentityActivityPreviewEnvelope {
  parseIdentityActivityEnvelope(value);
}

function parseIdentityActivityEnvelope(
  value: unknown,
): TeamIdentityActivityPreviewEnvelope {
  const serialized = boundedIdentityEnvelopeJson(value);
  const envelope = JSON.parse(serialized) as unknown;
  if (!isPlainObject(envelope)) throw invalidIdentityActivityEnvelope();
  exactIdentityKeys(envelope, ["schemaVersion", "request", "preview", "receipt"]);
  if (envelope.schemaVersion !== 1) throw invalidIdentityActivityEnvelope();
  assertIdentityActivityCommand(envelope.request);
  assertPublicIdentityPreview(envelope.preview);
  assertIdentityReceipt(envelope.receipt, envelope.request, envelope.preview);
  return deepFreeze(envelope as unknown as TeamIdentityActivityPreviewEnvelope);
}

function assertWorkstreamEnvelope(
  value: unknown,
): asserts value is TeamWorkstreamPreviewEnvelope {
  parseWorkstreamEnvelope(value);
}

function parseWorkstreamEnvelope(
  value: unknown,
): TeamWorkstreamPreviewEnvelope {
  const serialized = boundedWorkstreamEnvelopeJson(value);
  const envelope = JSON.parse(serialized) as unknown;
  if (!isPlainObject(envelope)) throw invalidWorkstreamEnvelope();
  exactWorkstreamKeys(envelope, [
    "schemaVersion", "request", "preview", "receipt",
  ]);
  if (envelope.schemaVersion !== 1) throw invalidWorkstreamEnvelope();
  assertWorkstreamCommand(envelope.request);
  assertPublicWorkstreamPreview(envelope.preview);
  assertWorkstreamReceipt(envelope.receipt, envelope.request, envelope.preview);
  return deepFreeze(envelope as unknown as TeamWorkstreamPreviewEnvelope);
}

function parseInboxEnvelope(value: unknown): TeamInboxSpecPreviewEnvelope {
  const serialized = boundedInboxJson(value);
  const parsed = JSON.parse(serialized) as unknown;
  if (!isPlainObject(parsed)) throw invalidInboxEnvelope();
  exactEnvelopeKeys(
    parsed,
    ["schemaVersion", "request", "preview", "receipt"],
    [],
    invalidInboxEnvelope,
  );
  if (parsed.schemaVersion !== 1) throw invalidInboxEnvelope();
  const request = normalizeTeamInboxSpecCommand(parsed.request);
  const preview = parseInboxPublicPreview(parsed.preview);
  const receipt = parseInboxReceipt(parsed.receipt, request, preview);
  return deepFreeze({ schemaVersion: 1, request, preview, receipt });
}

function parseRelayEnvelope(value: unknown): TeamRelayPreviewEnvelope {
  const serialized = boundedRelayJson(value);
  const parsed = JSON.parse(serialized) as unknown;
  if (!isPlainObject(parsed)) throw invalidRelayEnvelope();
  exactEnvelopeKeys(
    parsed,
    ["schemaVersion", "request", "preview", "receipt"],
    [],
    invalidRelayEnvelope,
  );
  if (parsed.schemaVersion !== 1) throw invalidRelayEnvelope();
  let request: TeamRelayCommand;
  try {
    request = normalizeTeamRelayCommand(parsed.request);
  } catch (currentError) {
    try {
      request = normalizeExistingRelayDraftMigrationCommand(parsed.request);
    } catch {
      try {
        request = normalizeTranslatedLegacyRelayDraftCommand(parsed.request);
      } catch {
        throw currentError;
      }
    }
  }
  const preview = parseRelayPublicPreview(parsed.preview);
  const receipt = parseRelayReceipt(parsed.receipt, request, preview);
  return deepFreeze({ schemaVersion: 1, request, preview, receipt });
}

/**
 * Compatibility parser for an exact pre-v3 signed publication envelope. It is
 * intentionally used only by apply so a durable journal can attest and finish
 * old intent; current preview/request parsing remains standalone-v3-only.
 */
function parsePreV3RelayPublishEnvelope(
  value: unknown,
): TeamRelayPreviewEnvelope {
  const serialized = boundedRelayJson(value);
  const parsed = JSON.parse(serialized) as unknown;
  if (!isPlainObject(parsed)) throw invalidRelayEnvelope();
  exactEnvelopeKeys(
    parsed,
    ["schemaVersion", "request", "preview", "receipt"],
    [],
    invalidRelayEnvelope,
  );
  if (parsed.schemaVersion !== 1) throw invalidRelayEnvelope();
  const request = normalizePreV3RelayPublishCommand(parsed.request);
  const preview = parseRelayPublicPreview(parsed.preview);
  const receipt = parseRelayReceipt(parsed.receipt, request, preview);
  return deepFreeze({ schemaVersion: 1, request, preview, receipt });
}

function normalizePreV3RelayPublishCommand(value: unknown): TeamRelayCommand {
  if (!isPlainObject(value)) throw invalidRelayEnvelope();
  exactEnvelopeKeys(
    value,
    ["operationId", "action", "expectedRevisions"],
    [],
    invalidRelayEnvelope,
  );
  if (typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId)) {
    throw invalidRelayEnvelope();
  }
  if (!isPlainObject(value.action)) throw invalidRelayEnvelope();
  exactEnvelopeKeys(value.action, ["kind", "draftId"], [], invalidRelayEnvelope);
  if (
    value.action.kind !== "relay.publish"
    || typeof value.action.draftId !== "string"
    || !isRelayLocalId(value.action.draftId)
  ) throw invalidRelayEnvelope();
  const expectations = normalizeWorkflowRevisionExpectations(
    value.expectedRevisions,
  );
  if (expectations.length > TEAM_RELAY_LIMITS.maxRecipients + 2) {
    throw invalidRelayEnvelope();
  }
  let draftCount = 0;
  let workstreamCount = 0;
  const memberIds: string[] = [];
  for (const expectation of expectations) {
    if (expectation.revision === null || expectation.semanticRevision !== undefined) {
      throw invalidRelayEnvelope();
    }
    if (expectation.target.kind === "local") {
      if (
        expectation.target.namespace !== "relay-draft"
        || expectation.target.id !== value.action.draftId
      ) throw invalidRelayEnvelope();
      draftCount += 1;
      continue;
    }
    if (expectation.target.kind !== "artifact") throw invalidRelayEnvelope();
    const workstreamId = relayDependencyArtifactId(
      expectation.target.path,
      ".mex/workstreams",
      "ws",
    );
    if (
      workstreamId !== null
      && workstreamArtifactPath(workstreamId) === expectation.target.path
    ) {
      workstreamCount += 1;
      continue;
    }
    const memberId = relayDependencyArtifactId(
      expectation.target.path,
      ".mex/team/members",
      "member",
    );
    if (
      memberId !== null
      && memberArtifactPath(memberId) === expectation.target.path
    ) {
      memberIds.push(memberId);
      continue;
    }
    throw invalidRelayEnvelope();
  }
  if (
    draftCount !== 1
    || workstreamCount !== 1
    || memberIds.length < 1
    || memberIds.length > TEAM_RELAY_LIMITS.maxRecipients
    || new Set(memberIds).size !== memberIds.length
  ) throw invalidRelayEnvelope();
  return deepFreeze({
    operationId: value.operationId,
    action: { kind: "relay.publish", draftId: value.action.draftId },
    expectedRevisions: expectations,
  });
}

function relayDependencyArtifactId(
  path: RepoRelativePath,
  directory: ".mex/workstreams" | ".mex/team/members",
  prefix: "ws" | "member",
): string | null {
  const start = `${directory}/${prefix}_`;
  if (!path.startsWith(start) || !path.endsWith(".md")) return null;
  const id = path.slice(directory.length + 1, -3);
  return isArtifactId(id, prefix) ? id : null;
}

function parseRelayPublicPreview(
  value: unknown,
): TeamRelayPreviewEnvelope["preview"] {
  if (!isPlainObject(value)) throw invalidRelayEnvelope();
  exactEnvelopeKeys(
    value,
    ["valid", "scope", "changes", "localChanges", "diagnostics"],
    [],
    invalidRelayEnvelope,
  );
  if (
    typeof value.valid !== "boolean"
    || (value.scope !== "canonical" && value.scope !== "local" && value.scope !== "mixed")
    || !Array.isArray(value.changes)
    || !Array.isArray(value.localChanges)
    || !Array.isArray(value.diagnostics)
  ) throw invalidRelayEnvelope();
  for (const change of value.changes) {
    if (
      !isPlainObject(change)
      || typeof change.path !== "string"
      || !isRepoRelativePath(change.path)
      || typeof change.diff !== "string"
      || (change.kind !== "create"
        && change.kind !== "update"
        && change.kind !== "delete"
        && change.kind !== "move")
      || (change.beforeRevision !== null
        && (typeof change.beforeRevision !== "string" || !isRevision(change.beforeRevision)))
      || (change.afterRevision !== null
        && (typeof change.afterRevision !== "string" || !isRevision(change.afterRevision)))
      || (change.kind === "create" && change.beforeRevision !== null)
      || (change.kind === "delete" && change.afterRevision !== null)
      || (change.kind !== "move" && Object.hasOwn(change, "previousPath"))
      || (change.kind === "move"
        && (typeof change.previousPath !== "string"
          || !isRepoRelativePath(change.previousPath)))
    ) throw invalidRelayEnvelope();
    exactEnvelopeKeys(
      change,
      change.kind === "move"
        ? ["kind", "path", "previousPath", "diff", "beforeRevision", "afterRevision"]
        : ["kind", "path", "diff", "beforeRevision", "afterRevision"],
      [],
      invalidRelayEnvelope,
    );
  }
  for (const change of value.localChanges) {
    if (!isPlainObject(change)) throw invalidRelayEnvelope();
    exactEnvelopeKeys(
      change,
      ["namespace", "id", "beforeRevision", "afterRevision", "summary"],
      [],
      invalidRelayEnvelope,
    );
    if (
      change.namespace !== "relay-draft"
      || typeof change.id !== "string"
      || (change.beforeRevision !== null
        && (typeof change.beforeRevision !== "string" || !isRevision(change.beforeRevision)))
      || (change.afterRevision !== null
        && (typeof change.afterRevision !== "string" || !isRevision(change.afterRevision)))
      || typeof change.summary !== "string"
    ) throw invalidRelayEnvelope();
  }
  return deepFreeze(value as unknown as TeamRelayPreviewEnvelope["preview"]);
}

function parseRelayReceipt(
  value: unknown,
  request: TeamRelayCommand,
  preview: TeamRelayPreviewEnvelope["preview"],
): TeamRelayPreviewEnvelope["receipt"] {
  boundedRelayReceiptJson(value);
  if (!isPlainObject(value)) throw invalidRelayEnvelope();
  exactEnvelopeKeys(value, [
    "schemaVersion",
    "authority",
    "purposeIds",
    "requestRevision",
    "presentationRevision",
    "previewRevision",
  ], [], invalidRelayEnvelope);
  if (
    value.schemaVersion !== 1
    || typeof value.requestRevision !== "string"
    || !isRevision(value.requestRevision)
    || typeof value.presentationRevision !== "string"
    || !isRevision(value.presentationRevision)
    || typeof value.previewRevision !== "string"
    || !isRevision(value.previewRevision)
  ) throw invalidRelayEnvelope();
  assertReceiptAuthority(value.authority, invalidRelayEnvelope);
  const purposeIds = normalizeRelayPurposeIds(value.purposeIds, request);
  if (
    value.requestRevision !== hashText(boundedRelayJson(request))
    || value.presentationRevision !== hashText(boundedRelayJson(preview))
  ) throw previewConflict();
  return deepFreeze({
    schemaVersion: 1,
    authority: value.authority,
    purposeIds,
    requestRevision: value.requestRevision,
    presentationRevision: value.presentationRevision,
    previewRevision: value.previewRevision,
  } as TeamRelayPreviewEnvelope["receipt"]);
}

function normalizeRelayPurposeIds(
  value: unknown,
  request: TeamRelayCommand,
): readonly TeamRelayPurposeId[] {
  if (!Array.isArray(value) || value.length > TEAM_RELAY_LIMITS.maxPurposeIds) {
    throw invalidRelayEnvelope();
  }
  const purposes = value.map((item): TeamRelayPurposeId => {
    if (!isPlainObject(item)) throw invalidRelayEnvelope();
    exactEnvelopeKeys(item, ["purpose", "id"], [], invalidRelayEnvelope);
    if (
      item.purpose !== "relay-draft"
      && item.purpose !== "relay"
      && item.purpose !== "activity"
    ) throw invalidRelayEnvelope();
    if (typeof item.id !== "string") throw invalidRelayEnvelope();
    const valid = item.purpose === "activity"
      ? isArtifactId(item.id, "event")
      : item.purpose === "relay"
        ? isArtifactId(item.id, "relay")
        : isRelayLocalId(item.id);
    if (!valid) throw invalidRelayEnvelope();
    return { purpose: item.purpose, id: item.id };
  });
  const actual = purposes.map((item) => item.purpose);
  const expected: readonly TeamRelayPurposeId["purpose"][] =
    request.action.kind === "relay.draft.save" && request.action.draftId === undefined
      ? ["relay-draft"]
      : request.action.kind === "relay.publish"
        ? ["activity", "relay"]
        : request.action.kind === "relay.acknowledge"
          || request.action.kind === "relay.close"
          ? ["activity"]
          : [];
  if (
    stableJson(actual) !== stableJson(expected)
    || new Set(purposes.map((item) => item.purpose)).size !== purposes.length
    || new Set(purposes.map((item) => item.id)).size !== purposes.length
  ) throw invalidRelayEnvelope();
  return deepFreeze(purposes);
}

function parseInboxPublicPreview(
  value: unknown,
): TeamInboxSpecPreviewEnvelope["preview"] {
  if (!isPlainObject(value)) throw invalidInboxEnvelope();
  exactEnvelopeKeys(
    value,
    ["valid", "scope", "changes", "localChanges", "diagnostics"],
    [],
    invalidInboxEnvelope,
  );
  if (
    typeof value.valid !== "boolean"
    || (value.scope !== "canonical" && value.scope !== "local" && value.scope !== "mixed")
    || !Array.isArray(value.changes)
    || !Array.isArray(value.localChanges)
    || !Array.isArray(value.diagnostics)
  ) throw invalidInboxEnvelope();
  for (const change of value.changes) {
    if (
      !isPlainObject(change)
      || typeof change.path !== "string"
      || !isRepoRelativePath(change.path)
      || typeof change.diff !== "string"
      || (change.kind !== "create"
        && change.kind !== "update"
        && change.kind !== "delete"
        && change.kind !== "move")
      || (change.beforeRevision !== null
        && (typeof change.beforeRevision !== "string"
          || !isRevision(change.beforeRevision)))
      || (change.afterRevision !== null
        && (typeof change.afterRevision !== "string"
          || !isRevision(change.afterRevision)))
      || (change.kind === "create" && change.beforeRevision !== null)
      || (change.kind === "delete" && change.afterRevision !== null)
      || (change.kind !== "move" && Object.hasOwn(change, "previousPath"))
      || (change.kind === "move"
        && (typeof change.previousPath !== "string"
          || !isRepoRelativePath(change.previousPath)))
    ) throw invalidInboxEnvelope();
    exactEnvelopeKeys(
      change,
      change.kind === "move"
        ? ["kind", "path", "previousPath", "diff", "beforeRevision", "afterRevision"]
        : ["kind", "path", "diff", "beforeRevision", "afterRevision"],
      [],
      invalidInboxEnvelope,
    );
  }
  for (const change of value.localChanges) {
    if (!isPlainObject(change)) throw invalidInboxEnvelope();
    exactEnvelopeKeys(
      change,
      ["namespace", "id", "beforeRevision", "afterRevision", "summary"],
      [],
      invalidInboxEnvelope,
    );
    if (
      change.namespace !== "inbox-draft"
      || typeof change.id !== "string"
      || (change.beforeRevision !== null
        && (typeof change.beforeRevision !== "string" || !isRevision(change.beforeRevision)))
      || (change.afterRevision !== null
        && (typeof change.afterRevision !== "string" || !isRevision(change.afterRevision)))
      || typeof change.summary !== "string"
    ) throw invalidInboxEnvelope();
  }
  return deepFreeze(value as unknown as TeamInboxSpecPreviewEnvelope["preview"]);
}

function parseInboxReceipt(
  value: unknown,
  request: TeamInboxSpecCommand,
  preview: TeamInboxSpecPreviewEnvelope["preview"],
): TeamInboxSpecPreviewEnvelope["receipt"] {
  boundedInboxReceiptJson(value);
  if (!isPlainObject(value)) throw invalidInboxEnvelope();
  exactEnvelopeKeys(value, [
    "schemaVersion",
    "authority",
    "purposeIds",
    "requestRevision",
    "presentationRevision",
    "previewRevision",
  ], [], invalidInboxEnvelope);
  if (
    value.schemaVersion !== 1
    || typeof value.requestRevision !== "string"
    || !isRevision(value.requestRevision)
    || typeof value.presentationRevision !== "string"
    || !isRevision(value.presentationRevision)
    || typeof value.previewRevision !== "string"
    || !isRevision(value.previewRevision)
  ) throw invalidInboxEnvelope();
  assertReceiptAuthority(value.authority, invalidInboxEnvelope);
  const purposeIds = normalizeInboxPurposeIds(value.purposeIds, request);
  if (
    value.requestRevision !== hashText(boundedInboxJson(request))
    || value.presentationRevision !== hashText(boundedInboxJson(preview))
  ) throw previewConflict();
  return deepFreeze({
    schemaVersion: 1,
    authority: value.authority,
    purposeIds,
    requestRevision: value.requestRevision,
    presentationRevision: value.presentationRevision,
    previewRevision: value.previewRevision,
  } as TeamInboxSpecPreviewEnvelope["receipt"]);
}

function normalizeInboxPurposeIds(
  value: unknown,
  request: TeamInboxSpecCommand,
): readonly TeamInboxSpecPurposeId[] {
  if (!Array.isArray(value) || value.length > TEAM_INBOX_SPEC_LIMITS.maxPurposeIds) {
    throw invalidInboxEnvelope();
  }
  const purposes = value.map((item): TeamInboxSpecPurposeId => {
    if (!isPlainObject(item)) throw invalidInboxEnvelope();
    exactEnvelopeKeys(item, ["purpose", "id"], [], invalidInboxEnvelope);
    if (
      item.purpose !== "inbox-draft"
      && item.purpose !== "proposal"
      && item.purpose !== "activity"
      && item.purpose !== "spec-entity"
    ) throw invalidInboxEnvelope();
    if (typeof item.id !== "string") throw invalidInboxEnvelope();
    const valid = item.purpose === "activity"
      ? isArtifactId(item.id, "event")
      : item.purpose === "proposal"
        ? isArtifactId(item.id, "proposal")
        : item.purpose === "spec-entity"
          ? isEntityId(item.id) && item.id.startsWith("mx_")
          : Buffer.byteLength(item.id, "utf8") <= 256
            && item.id.length > 0
            && !/[\0-\x1f\x7f]/u.test(item.id);
    if (!valid) throw invalidInboxEnvelope();
    return { purpose: item.purpose, id: item.id };
  });
  const ordered = [...purposes].sort(
    (left, right) => compareCodePoints(left.purpose, right.purpose),
  );
  if (
    stableJson(ordered) !== stableJson(purposes)
    || new Set(purposes.map((item) => item.purpose)).size !== purposes.length
    || new Set(purposes.map((item) => item.id)).size !== purposes.length
  ) throw invalidInboxEnvelope();
  const action = request.action;
  const actual = purposes.map((item) => item.purpose);
  const expected: readonly TeamInboxSpecPurposeId["purpose"][] =
    action.kind === "inbox.draft.save" && action.draftId === undefined
      ? ["inbox-draft"]
      : action.kind === "inbox.publish"
        ? ["activity", "proposal"]
        : action.kind === "inbox.approve"
          ? actual.includes("spec-entity")
            ? ["activity", "spec-entity"]
            : ["activity"]
          : action.kind === "inbox.reject"
            || action.kind === "inbox.withdraw"
            || action.kind === "inbox.mark-stale"
            || action.kind === "inbox.repair"
            ? ["activity"]
            : [];
  if (stableJson(actual) !== stableJson(expected)) throw invalidInboxEnvelope();
  return deepFreeze(purposes);
}

function assertPublicWorkstreamPreview(
  value: unknown,
): asserts value is TeamIdentityActivityPublicPreview {
  if (!isPlainObject(value)) throw invalidWorkstreamEnvelope();
  exactWorkstreamKeys(
    value,
    ["valid", "scope", "changes", "localChanges", "diagnostics"],
  );
  if (
    typeof value.valid !== "boolean"
    || (value.scope !== "canonical"
      && value.scope !== "local"
      && value.scope !== "mixed")
    || !Array.isArray(value.changes)
    || !Array.isArray(value.localChanges)
    || !Array.isArray(value.diagnostics)
  ) {
    throw invalidWorkstreamEnvelope();
  }
}

function assertWorkstreamReceipt(
  value: unknown,
  request: TeamWorkstreamCommand,
  preview: TeamIdentityActivityPublicPreview,
): void {
  boundedWorkstreamReceiptJson(value);
  if (!isPlainObject(value)) throw invalidWorkstreamEnvelope();
  exactWorkstreamKeys(value, [
    "schemaVersion",
    "authority",
    "purposeIds",
    "requestRevision",
    "presentationRevision",
    "previewRevision",
  ]);
  if (
    value.schemaVersion !== 1
    || !isRevisionValue(value.requestRevision)
    || !isRevisionValue(value.presentationRevision)
    || !isRevisionValue(value.previewRevision)
  ) {
    throw invalidWorkstreamEnvelope();
  }
  assertReceiptAuthority(value.authority, invalidWorkstreamEnvelope);
  normalizeWorkstreamReceiptPurposeIds(value.purposeIds, request.action.kind);
  if (
    value.requestRevision
      !== hashText(boundedWorkstreamEnvelopeJson(request))
    || value.presentationRevision
      !== hashText(boundedWorkstreamEnvelopeJson(preview))
  ) {
    throw previewConflict();
  }
}

function assertPublicIdentityPreview(
  value: unknown,
): asserts value is TeamIdentityActivityPublicPreview {
  if (!isPlainObject(value)) throw invalidIdentityActivityEnvelope();
  exactIdentityKeys(
    value,
    ["valid", "scope", "changes", "localChanges", "diagnostics"],
  );
  if (
    typeof value.valid !== "boolean"
    || (value.scope !== "canonical" && value.scope !== "local" && value.scope !== "mixed")
    || !Array.isArray(value.changes)
    || !Array.isArray(value.localChanges)
    || !Array.isArray(value.diagnostics)
  ) {
    throw invalidIdentityActivityEnvelope();
  }
}

function assertIdentityReceipt(
  value: unknown,
  request: TeamIdentityActivityCommand,
  preview: TeamIdentityActivityPublicPreview,
): void {
  boundedReceiptJson(value);
  if (!isPlainObject(value)) throw invalidIdentityActivityEnvelope();
  exactIdentityKeys(value, [
    "schemaVersion",
    "authority",
    "purposeIds",
    "requestRevision",
    "presentationRevision",
    "previewRevision",
  ]);
  if (
    value.schemaVersion !== 1
    || !isRevisionValue(value.requestRevision)
    || !isRevisionValue(value.presentationRevision)
    || !isRevisionValue(value.previewRevision)
  ) {
    throw invalidIdentityActivityEnvelope();
  }
  assertReceiptAuthority(value.authority);
  const purposeIds = normalizeReceiptPurposeIds(value.purposeIds, request.action.kind);
  const requestRevision = hashText(boundedIdentityEnvelopeJson(request));
  const presentationRevision = hashText(boundedIdentityEnvelopeJson(preview));
  if (
    value.requestRevision !== requestRevision
    || value.presentationRevision !== presentationRevision
  ) {
    throw previewConflict();
  }
  // The receipt signature is verified against the repository-local signer at
  // apply. Structural parsing deliberately cannot reproduce that secret-bound
  // value, but still validates every signed field and its deterministic hashes.
  void purposeIds;
}

function assertReceiptAuthority(
  value: unknown,
  invalid: () => MexPortError = invalidIdentityActivityEnvelope,
): void {
  if (!isPlainObject(value)) throw invalid();
  exactEnvelopeKeys(value, ["actor", "occurredAt", "repoState"], [], invalid);
  if (typeof value.occurredAt !== "string") throw invalid();
  const occurredAt = new Date(value.occurredAt);
  if (
    Number.isNaN(occurredAt.getTime())
    || occurredAt.toISOString() !== value.occurredAt
  ) {
    throw invalid();
  }
  assertReceiptActor(value.actor, invalid);
  if (!isPlainObject(value.repoState)) throw invalid();
  exactEnvelopeKeys(
    value.repoState,
    ["branch", "head", "dirty", "observedAt"],
    [],
    invalid,
  );
  if (
    (value.repoState.branch !== null && typeof value.repoState.branch !== "string")
    || (value.repoState.head !== null && typeof value.repoState.head !== "string")
    || typeof value.repoState.dirty !== "boolean"
    || typeof value.repoState.observedAt !== "string"
  ) {
    throw invalid();
  }
  const observedAt = new Date(value.repoState.observedAt);
  if (
    Number.isNaN(observedAt.getTime())
    || observedAt.toISOString() !== value.repoState.observedAt
  ) {
    throw invalid();
  }
}

function assertReceiptActor(
  value: unknown,
  invalid: () => MexPortError = invalidIdentityActivityEnvelope,
): void {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw invalid();
  }
  if (value.kind === "unknown") {
    exactEnvelopeKeys(value, ["kind"], [], invalid);
    return;
  }
  if (value.kind === "member") {
    exactEnvelopeKeys(
      value,
      ["kind", "memberId"],
      ["displayName"],
      invalid,
    );
    if (
      typeof value.memberId !== "string"
      || (value.displayName !== undefined && typeof value.displayName !== "string")
    ) {
      throw invalid();
    }
    return;
  }
  if (value.kind === "git") {
    exactEnvelopeKeys(value, ["kind", "name", "email"], [], invalid);
    if (
      (value.name !== null && typeof value.name !== "string")
      || (value.email !== null && typeof value.email !== "string")
    ) {
      throw invalid();
    }
    return;
  }
  throw invalid();
}

function normalizeReceiptPurposeIds(
  value: unknown,
  action: TeamIdentityActivityCommand["action"]["kind"],
): readonly TeamIdentityActivityPurposeId[] {
  if (
    !Array.isArray(value)
    || value.length > TEAM_IDENTITY_ACTIVITY_LIMITS.maxPurposeIds
  ) {
    throw invalidIdentityActivityEnvelope();
  }
  const purposes = value.map((item): TeamIdentityActivityPurposeId => {
    if (!isPlainObject(item)) throw invalidIdentityActivityEnvelope();
    exactIdentityKeys(item, ["purpose", "id"]);
    if (item.purpose !== "activity" && item.purpose !== "member") {
      throw invalidIdentityActivityEnvelope();
    }
    if (
      typeof item.id !== "string"
      || !isArtifactId(item.id, item.purpose === "activity" ? "event" : "member")
    ) {
      throw invalidIdentityActivityEnvelope();
    }
    return { purpose: item.purpose, id: item.id };
  });
  const expected = action === "member.add"
    ? ["activity", "member"]
    : action === "member.update"
      || action === "member.deactivate"
      || action === "member.reactivate"
      || action === "activity.record"
      ? ["activity"]
      : [];
  if (
    purposes.some((item, index) => item.purpose !== expected[index])
    || purposes.length !== expected.length
  ) {
    throw invalidIdentityActivityEnvelope();
  }
  return purposes;
}

function normalizeWorkstreamReceiptPurposeIds(
  value: unknown,
  action: TeamWorkstreamCommand["action"]["kind"],
): readonly TeamWorkstreamPurposeId[] {
  if (
    !Array.isArray(value)
    || value.length > TEAM_IDENTITY_ACTIVITY_LIMITS.maxPurposeIds
  ) {
    throw invalidWorkstreamEnvelope();
  }
  const purposes = value.map((item): TeamWorkstreamPurposeId => {
    if (!isPlainObject(item)) throw invalidWorkstreamEnvelope();
    exactWorkstreamKeys(item, ["purpose", "id"]);
    if (item.purpose !== "activity" && item.purpose !== "workstream") {
      throw invalidWorkstreamEnvelope();
    }
    if (
      typeof item.id !== "string"
      || !isArtifactId(
        item.id,
        item.purpose === "activity" ? "event" : "ws",
      )
    ) {
      throw invalidWorkstreamEnvelope();
    }
    return { purpose: item.purpose, id: item.id };
  });
  const expected = action === "workstream.create"
    ? ["activity", "workstream"]
    : ["activity"];
  if (
    purposes.some((item, index) => item.purpose !== expected[index])
    || purposes.length !== expected.length
  ) {
    throw invalidWorkstreamEnvelope();
  }
  return purposes;
}

function exactIdentityKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  exactEnvelopeKeys(
    value,
    required,
    optional,
    invalidIdentityActivityEnvelope,
  );
}

function exactEnvelopeKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  invalid: () => MexPortError,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw invalid();
  }
}

function exactWorkstreamKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw invalidWorkstreamEnvelope();
  }
}

function exactWorkstreamCommandKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalidWorkstreamCommand();
  }
}

function isRevisionValue(value: unknown): value is Revision {
  return typeof value === "string" && isRevision(value);
}

function boundedIdentityEnvelopeJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxEnvelopeBytes,
    maxDepth: MAX_PREPARED_COMMAND_DEPTH,
    maxNodes: MAX_PREPARED_COMMAND_NODES,
  }, invalidIdentityActivityEnvelope);
}

function boundedWorkstreamEnvelopeJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxEnvelopeBytes,
    maxDepth: MAX_PREPARED_COMMAND_DEPTH,
    maxNodes: MAX_PREPARED_COMMAND_NODES,
  }, invalidWorkstreamEnvelope);
}

function boundedReceiptJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxReceiptBytes,
    maxDepth: TEAM_IDENTITY_ACTIVITY_LIMITS.maxReceiptDepth,
    maxNodes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxReceiptNodes,
  }, invalidIdentityActivityEnvelope);
}

function boundedWorkstreamReceiptJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maxBytes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxReceiptBytes,
    maxDepth: TEAM_IDENTITY_ACTIVITY_LIMITS.maxReceiptDepth,
    maxNodes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxReceiptNodes,
  }, invalidWorkstreamEnvelope);
}

function receiptSigningPayload(
  receipt: Omit<TeamIdentityActivityPreviewEnvelope["receipt"], "previewRevision">
    | TeamIdentityActivityPreviewEnvelope["receipt"]
    | Omit<TeamWorkstreamPreviewEnvelope["receipt"], "previewRevision">
    | TeamWorkstreamPreviewEnvelope["receipt"],
): string {
  return boundedReceiptJson({
    schemaVersion: receipt.schemaVersion,
    authority: receipt.authority,
    purposeIds: receipt.purposeIds,
    requestRevision: receipt.requestRevision,
    presentationRevision: receipt.presentationRevision,
  });
}

function boundedCanonicalJson(
  value: unknown,
  limits: { maxBytes: number; maxDepth: number; maxNodes: number },
  invalid: () => MexPortError,
): string {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) {
      throw invalid();
    }
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw invalid();
      return current;
    }
    if (typeof current !== "object" || active.has(current)) {
      throw invalid();
    }
    active.add(current);
    let normalized: unknown;
    if (Array.isArray(current)) {
      normalized = current.map((item) => visit(item, depth + 1));
    } else {
      if (!isPlainObject(current)) throw invalid();
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(current).sort()) {
        if (current[key] === undefined) throw invalid();
        record[key] = visit(current[key], depth + 1);
      }
      normalized = record;
    }
    active.delete(current);
    return normalized;
  };
  const serialized = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(serialized, "utf8") > limits.maxBytes) {
    throw invalid();
  }
  return serialized;
}

function invalidIdentityActivityCommand(): never {
  throw artifactError(
    "VALIDATION_FAILED",
    "Invalid identity or Activity command",
    "Only the bounded member and direct Activity fields supported by this checkpoint are accepted.",
  );
}

function invalidIdentityActivityEnvelope(): MexPortError {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid identity or Activity preview",
    "The portable preview envelope is malformed or exceeds its bounded contract.",
  );
}

function invalidWorkstreamCommand(): never {
  throw artifactError(
    "VALIDATION_FAILED",
    "Invalid Workstream command",
    "Only bounded create, update, and archive Workstream fields are accepted.",
  );
}

function invalidWorkstreamEnvelope(): MexPortError {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid Workstream preview",
    "The portable Workstream preview envelope is malformed or exceeds its bounded contract.",
  );
}

function invalidInboxEnvelope(): MexPortError {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid Inbox/Spec preview",
    "The portable Inbox/Spec preview envelope is malformed or exceeds its bounded contract.",
  );
}

function invalidSignedInboxEnvelope(): MexPortError {
  return artifactError(
    "VALIDATION_FAILED",
    "Invalid signed Inbox/Spec preview",
    "The supplied Inbox/Spec envelope is malformed, out of bounds, or has an invalid purpose binding.",
  );
}

function invalidRelayEnvelope(): MexPortError {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid Relay preview",
    "The portable Relay preview envelope is malformed or exceeds its bounded contract.",
  );
}

function invalidSignedRelayEnvelope(): MexPortError {
  return artifactError(
    "VALIDATION_FAILED",
    "Invalid signed Relay preview",
    "The supplied Relay envelope is malformed, out of bounds, or has an invalid purpose binding.",
  );
}

function preV3RelayPreviewRequiresRefresh(): MexPortError {
  return artifactError(
    "REVISION_CONFLICT",
    "Relay publication preview is outdated",
    "This pre-v3 Relay preview has no durable operation intent to recover. Preview the standalone handoff again with the current MEX version.",
  );
}

function relayEnvelopeTooLarge(): MexPortError {
  const detail = `The complete Relay preview envelope exceeds ${TEAM_RELAY_LIMITS.maxEnvelopeBytes} UTF-8 bytes.`;
  return new MexPortError({
    title: "Relay preview envelope is too large",
    status: 422,
    code: "VALIDATION_FAILED",
    detail,
    diagnostics: [{
      code: "ENVELOPE_TOO_LARGE",
      severity: "error",
      message: detail,
    }],
  });
}

function assertRelayEnvelopeFits(value: unknown): void {
  if (
    Buffer.byteLength(stableJson(value), "utf8")
      > TEAM_RELAY_LIMITS.maxEnvelopeBytes
  ) throw relayEnvelopeTooLarge();
}

function inboxEnvelopeTooLarge(): MexPortError {
  const detail = `The complete Inbox/Spec preview envelope exceeds ${TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes} UTF-8 bytes.`;
  return new MexPortError({
    title: "Inbox/Spec preview envelope is too large",
    status: 422,
    code: "VALIDATION_FAILED",
    detail,
    diagnostics: [{
      code: "ENVELOPE_TOO_LARGE",
      severity: "error",
      message: detail,
    }],
  });
}

function assertInboxEnvelopeFits(value: unknown): void {
  if (
    Buffer.byteLength(stableJson(value), "utf8")
      > TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes
  ) throw inboxEnvelopeTooLarge();
}

function assertInboxPreviewContainment(
  projectRoot: string,
  preview: TeamInboxSpecPublicPreview,
): void {
  if (preview.localChanges.length > 0) {
    assertContainedArtifactDirectory(
      projectRoot,
      ".mex/local" as RepoRelativePath,
    );
  }
  for (const change of preview.changes) {
    assertContainedArtifactDirectory(
      projectRoot,
      dirname(change.path) as RepoRelativePath,
    );
    if (change.kind === "move") {
      assertContainedArtifactDirectory(
        projectRoot,
        dirname(change.previousPath) as RepoRelativePath,
      );
    }
  }
}

function assertRelayPreviewContainment(
  projectRoot: string,
  preview: TeamRelayPreviewEnvelope["preview"],
): void {
  if (preview.localChanges.length > 0) {
    assertContainedArtifactDirectory(
      projectRoot,
      ".mex/local" as RepoRelativePath,
    );
  }
  for (const change of preview.changes) {
    assertContainedArtifactDirectory(
      projectRoot,
      dirname(change.path) as RepoRelativePath,
    );
    if (change.kind === "move") {
      assertContainedArtifactDirectory(
        projectRoot,
        dirname(change.previousPath) as RepoRelativePath,
      );
    }
  }
}

function canonicalPlan<TWikiPayload extends JsonValue>(
  plan: MemberWritePlan,
  namespace: string,
  id: string,
  activityInput: PlannedActivityInput,
  applyPrimary: () => Promise<PrimaryResult<TWikiPayload>>,
) {
  return {
    changes: [plan.change], localChanges: [], diagnostics: [], cleanup: [],
    effects: [canonicalEffect(namespace, id, plan.change)], innerRevisions: [plan.previewRevision],
    activityInput, applyPrimary,
  };
}

function canonicalWorkflowPlan<TWikiPayload extends JsonValue, TArtifact extends TeamArtifact<TWikiPayload>>(
  plan: WorkflowArtifactWritePlan<TArtifact>,
  namespace: string,
  id: string,
  activityInput: PlannedActivityInput,
  repository: { apply(plan: WorkflowArtifactWritePlan<TArtifact>, revision: Revision): Promise<{ artifact: TArtifact; change: FileChange }> },
) {
  return {
    changes: [plan.change], localChanges: [], diagnostics: [], cleanup: [],
    effects: [canonicalEffect(namespace, id, plan.change)], innerRevisions: [plan.previewRevision],
    activityInput,
    applyPrimary: async () => {
      const applied = await repository.apply(plan, plan.previewRevision);
      return primary([applied.artifact], [applied.change]);
    },
  };
}

function workflowActivity(
  operation: string,
  input: Omit<ActivityCreateInput, "actor">,
  label?: string,
): PlannedActivityInput {
  const boundedLabel = label === undefined ? undefined : activityLabelExcerpt(label);
  return {
    ...input,
    origin: { kind: "workflow", operation },
    ...(boundedLabel === undefined ? {} : { label: boundedLabel }),
  };
}

function activityLabelExcerpt(value: string): string | undefined {
  if (
    value.length === 0
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) return undefined;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= ACTIVITY_LABEL_MAX_BYTES) return value;
  let end = ACTIVITY_LABEL_MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const excerpt = bytes.subarray(0, end).toString("utf8").trimEnd();
  return excerpt.length === 0 ? undefined : excerpt;
}

function withCleanup<T extends { cleanup: readonly LocalCleanupWorkflowEffect[]; localChanges: readonly LocalStateChange[]; effects: readonly TeamWorkflowJournalEffect[] }>(
  plan: T,
  kind: "inbox" | "relay",
  id: string,
  revision: Revision,
): T {
  const cleanup: LocalCleanupWorkflowEffect = { kind: "local_cleanup", draftKind: kind, draftId: id, expectedRevision: revision };
  return {
    ...plan,
    cleanup: [...plan.cleanup, cleanup],
    effects: [...plan.effects],
    localChanges: [...plan.localChanges, localChange(kind, id, revision, null, "Publish local draft")],
  };
}

async function listRepositoryPage<TArtifact, TState extends string>(
  repository: {
    list(request: {
      limit: number;
      cursor?: string;
      states?: readonly TState[];
      includeArchived?: boolean;
    }): Promise<WorkflowRepositoryPage<TArtifact>>;
  },
  base: { limit: number; cursor?: string; includeArchived?: boolean },
  states: readonly TState[] | null,
): Promise<WorkflowRepositoryPage<TArtifact>> {
  if (states !== null && states.length === 0) {
    const probe = await repository.list({ limit: 1, includeArchived: true });
    return {
      ...probe,
      items: [],
      nextCursor: null,
      truncated: false,
    };
  }
  return repository.list({
    ...base,
    ...(states === null ? {} : { states }),
  });
}

function canonicalEffect(namespace: string, id: string, change: FileChange): CanonicalWorkflowEffect {
  return { kind: "canonical", namespace, id, path: change.path, beforeRevision: change.beforeRevision, afterRevision: change.afterRevision };
}

function recoveryCanonicalId(
  effects: readonly TeamWorkflowJournalEffect[] | undefined,
  namespace: string,
): string | null {
  if (effects === undefined) return null;
  const matches = effects.filter(
    (effect): effect is CanonicalWorkflowEffect =>
      effect.kind === "canonical" && effect.namespace === namespace,
  );
  if (matches.length !== 1) throw incompleteRecovery();
  return matches[0]!.id;
}

function recoveryCreatedSpecId(
  effects: readonly TeamWorkflowJournalEffect[] | undefined,
  proposalId: string,
  expectedKind: string,
): string | null {
  if (effects === undefined) return null;
  const recovery = effects.filter(
    (effect): effect is WikiRecoveryWorkflowEffect => effect.kind === "wiki_recovery",
  );
  if (recovery.length > 1) throw incompleteRecovery();
  const manifestIds = recovery.length === 0
    ? []
    : recovery[0]!.manifest.items.flatMap((item) => item.createdIds);
  if (
    manifestIds.length > 1
    || (manifestIds.length === 1
      && (!isEntityId(manifestIds[0]) || !manifestIds[0]!.startsWith("mx_")))
  ) throw incompleteRecovery();

  const activities = effects.filter(
    (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
  );
  if (activities.length !== 1 || activities[0]!.action !== "inbox.approved") {
    throw incompleteRecovery();
  }
  const subjects = activities[0]!.subjects;
  if (subjects.length !== 2 || subjects.some((subject) => subject.kind !== "entity")) {
    throw incompleteRecovery();
  }
  const proposalSubjects = subjects.filter(
    (subject) => subject.kind === "entity" && subject.entity.id === proposalId,
  );
  const specSubjects = subjects.filter(
    (subject) => subject.kind === "entity"
      && subject.entity.id !== proposalId
      && isEntityId(subject.entity.id)
      && subject.entity.id.startsWith("mx_")
      && subject.entity.kind === expectedKind,
  );
  if (proposalSubjects.length !== 1 || specSubjects.length !== 1) {
    throw incompleteRecovery();
  }
  const activityId = specSubjects[0]!.kind === "entity"
    ? specSubjects[0]!.entity.id
    : null;
  const manifestId = manifestIds[0] ?? null;
  if (manifestId !== null && manifestId !== activityId) throw incompleteRecovery();
  return activityId;
}

function recoveryLocalId(
  effects: readonly TeamWorkflowJournalEffect[] | undefined,
  namespace: "inbox-draft" | "relay-draft",
): string | null {
  if (effects === undefined) return null;
  const matches = effects.filter(
    (effect): effect is LocalWorkflowEffect =>
      effect.kind === "local" && effect.namespace === namespace,
  );
  if (matches.length !== 1) throw incompleteRecovery();
  return matches[0]!.id;
}

function activityEffect(preview: ActivityCreatePreview): ActivityWorkflowEffect {
  const common = {
    kind: "activity" as const, id: preview.event.id, path: preview.sourcePath, revision: preview.revision,
    action: preview.event.action, actor: preview.event.actor, occurredAt: preview.event.timestamp,
    repoState: preview.event.repoState, subjects: preview.event.subjects,
    ...(preview.event.workstream === undefined ? {} : { workstream: preview.event.workstream }),
    ...(preview.event.metadata === undefined ? {} : { metadata: preview.event.metadata }),
  };
  if (preview.event.schemaVersion === 1) return common;
  return {
    ...common,
    schemaVersion: 2,
    origin: preview.event.origin,
  };
}

function activityEventFromEffect(
  effect: ActivityWorkflowEffect,
  recoveredLabel?: string,
): ActivityEvent {
  const common = {
    id: effect.id,
    timestamp: effect.occurredAt,
    actor: effect.actor,
    action: effect.action,
    subjects: effect.subjects,
    ...(effect.workstream === undefined ? {} : { workstream: effect.workstream }),
    repoState: effect.repoState,
    ...(effect.metadata === undefined ? {} : { metadata: effect.metadata }),
  };
  if (effect.schemaVersion !== 2) return { schemaVersion: 1, ...common };
  return {
    schemaVersion: 2,
    ...common,
    origin: effect.origin,
    ...(recoveredLabel === undefined ? {} : { label: recoveredLabel }),
  };
}

function assertRecoveryActivityIntent(
  input: PlannedActivityInput | null,
  authority: PreparedTeamWorkflowCommand<JsonValue>["authority"],
  effect: ActivityWorkflowEffect | undefined,
): void {
  if (input === null || effect === undefined) {
    if (input !== null || effect !== undefined) throw incompleteRecovery();
    return;
  }
  const expected = {
    action: input.action,
    actor: authority.actor,
    occurredAt: authority.occurredAt,
    repoState: authority.repoState,
    subjects: input.subjects,
    ...(input.workstream === undefined ? {} : { workstream: input.workstream }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
  const actual = {
    action: effect.action,
    actor: effect.actor,
    occurredAt: effect.occurredAt,
    repoState: effect.repoState,
    subjects: effect.subjects,
    ...(effect.workstream === undefined ? {} : { workstream: effect.workstream }),
    ...(effect.metadata === undefined ? {} : { metadata: effect.metadata }),
  };
  if (stableJson(expected) !== stableJson(actual)) throw incompleteRecovery();
  if (effect.schemaVersion === 2) {
    const expectedProvenance = { origin: input.origin };
    const actualProvenance = { origin: effect.origin };
    if (stableJson(expectedProvenance) !== stableJson(actualProvenance)) {
      throw incompleteRecovery();
    }
  }
}

function primary<TWikiPayload extends JsonValue>(
  artifacts: readonly TeamArtifact<TWikiPayload>[],
  changes: readonly FileChange[],
  localChanges: readonly LocalStateChange[] = [],
): PrimaryResult<TWikiPayload> {
  return { artifacts, changes, localChanges };
}

function localDraftProjection<TWikiPayload extends JsonValue>(stored: StoredLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput>): LocalDraft<TWikiPayload> {
  if (stored.kind === "inbox") {
    const payload = normalizeInboxDraftInput<TWikiPayload>(
      stored.payload as InboxDraftInput<TWikiPayload>,
    );
    return {
      ...payload,
      id: stored.id,
      kind: "inbox",
      revision: stored.revision,
      updatedAt: stored.updatedAt,
    };
  }
  const payload = normalizeRelayDraftInput(stored.payload as RelayDraftInput);
  return {
    ...payload,
    id: stored.id,
    kind: "relay",
    revision: stored.revision,
    updatedAt: stored.updatedAt,
  };
}

function localChange(kind: "inbox" | "relay", id: string, beforeRevision: Revision | null, afterRevision: Revision | null, summary: string): LocalStateChange {
  return { namespace: `${kind}-draft`, id, beforeRevision, afterRevision, summary };
}

function memberSelectionChange(
  beforeRevision: Revision | null,
  afterRevision: Revision | null,
  summary: string,
): LocalStateChange {
  return {
    namespace: MEMBER_SELECTION_NAMESPACE,
    id: MEMBER_SELECTION_ID,
    beforeRevision,
    afterRevision,
    summary,
  };
}

function recoveryFileByteLimit(path: RepoRelativePath): number {
  return path === ".mex/events/operations.jsonl"
    ? MAX_WIKI_OPERATION_LOG_BYTES
    : MAX_WIKI_RECOVERY_FILE_BYTES;
}

/** Only serializer-owned Team records use portable LF revisions. */
function teamArtifactByteMode(path: RepoRelativePath): ArtifactByteMode {
  if (!path.endsWith(".md")) return "exact";
  const id = path.slice(path.lastIndexOf("/") + 1, -3);
  for (const [prefix, pathOf] of [
    ["member", memberArtifactPath],
    ["ws", workstreamArtifactPath],
    ["proposal", inboxProposalArtifactPath],
    ["relay", relayArtifactPath],
    ["playbook", playbookArtifactPath],
    ["run", playbookRunArtifactPath],
  ] as const) {
    if (isArtifactId(id, prefix) && pathOf(id) === path) return "canonical";
  }
  if (isArtifactId(id, "event")
    && /^\.mex\/events\/activity\/\d{4}-(?:0[1-9]|1[0-2])\/[^/]+\.md$/u.test(path)) {
    return "canonical";
  }
  return "exact";
}

function isWikiOperationLogEffect(effect: CanonicalWorkflowEffect): boolean {
  return effect.namespace === "wiki"
    && effect.path === ".mex/events/operations.jsonl";
}

function asRecoverableWikiPort<
  TWikiPayload extends JsonValue,
  TWikiPlan,
>(
  port: WikiPort<unknown, TWikiPayload, TWikiPlan, unknown>,
): RecoverableWikiPort<TWikiPayload, TWikiPlan> | null {
  const candidate = port as Partial<RecoverableWikiPort<TWikiPayload, TWikiPlan>>;
  return typeof candidate.inspectOperationRecovery === "function"
    && typeof candidate.resumeOperations === "function"
    ? candidate as RecoverableWikiPort<TWikiPayload, TWikiPlan>
    : null;
}

function asInboxSpecWikiPort<
  TWikiPayload extends JsonValue,
  TWikiPlan,
>(
  port: WikiPort<unknown, TWikiPayload, TWikiPlan, unknown>,
): (WikiForcedCreatedIdPreviewPort<TWikiPayload, TWikiPlan>
  & WikiExactAuthoringPreviewPort<TWikiPayload, TWikiPlan>) | null {
  const candidate = port as Partial<
    WikiForcedCreatedIdPreviewPort<TWikiPayload, TWikiPlan>
      & WikiExactAuthoringPreviewPort<TWikiPayload, TWikiPlan>
  >;
  return typeof candidate.readExactEntityAttestations === "function"
    && typeof candidate.previewOperationsWithCreatedIds === "function"
    && typeof candidate.previewAuthoringOperations === "function"
    ? candidate as WikiForcedCreatedIdPreviewPort<TWikiPayload, TWikiPlan>
      & WikiExactAuthoringPreviewPort<TWikiPayload, TWikiPlan>
    : null;
}

function inboxWikiUnavailable(): MexPortError {
  return artifactError(
    "MIGRATION_REQUIRED",
    "Inbox Spec authoring is unavailable",
    "The repository Wiki adapter does not provide the exact governed Spec authoring seam.",
  );
}

function wikiRecoveryMismatch(
  reason: Extract<WikiOperationRecoveryInspection, { state: "mismatch" }>["reason"],
): MexPortError {
  return reason === "audit_unsafe"
    ? artifactError(
        "INDEX_CORRUPT",
        "Wiki recovery audit is unsafe",
        "The bounded Wiki operation audit cannot prove this interrupted approval. Repair the canonical audit before retrying.",
      )
    : wikiRecoveryConflict(
        "The Wiki operation audit does not match the exact interrupted approval.",
      );
}

function wikiRecoveryConflict(detail: string): MexPortError {
  return artifactError(
    "REVISION_CONFLICT",
    "Wiki recovery changed",
    detail,
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inboxSummaryMatches(
  summary: {
    changeKind: "spec.create" | "spec.update" | "knowledge.create" | "knowledge.update";
    entityKind: string;
    state?: string;
  },
  filter: {
    changeKinds?: readonly ("spec.create" | "spec.update" | "knowledge.create" | "knowledge.update")[];
    entityKinds?: readonly string[];
    states?: readonly string[];
  },
): boolean {
  return (filter.changeKinds === undefined
      || filter.changeKinds.includes(summary.changeKind))
    && (filter.entityKinds === undefined
      || filter.entityKinds.includes(summary.entityKind))
    && (filter.states === undefined
      || (summary.state !== undefined && filter.states.includes(summary.state)));
}

function parseInboxOffset(value: string): number {
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) throw invalidInboxEnvelope();
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) throw invalidInboxEnvelope();
  return offset;
}

function inboxPageConflict(): MexPortError {
  return artifactError(
    "REVISION_CONFLICT",
    "Inbox collection changed",
    "The Inbox draft or proposal collection changed during pagination. Restart from the first page.",
  );
}

function assertWikiRecoveryManifestMatchesChanges(
  manifest: WikiOperationRecoveryManifest,
  changes: readonly FileChange[],
): void {
  const expected = new Map<RepoRelativePath, {
    beforeRevision: Revision | null;
    afterRevision: Revision;
  }>();
  for (const item of manifest.items) {
    for (const file of item.files) {
      const previous = expected.get(file.path);
      if (previous !== undefined && previous.afterRevision !== file.beforeRevision) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Wiki recovery manifest is discontinuous",
          "The Wiki recovery manifest does not describe one ordered file revision chain.",
        );
      }
      expected.set(file.path, {
        beforeRevision: previous?.beforeRevision ?? file.beforeRevision,
        afterRevision: file.afterRevision,
      });
    }
  }
  const first = manifest.items[0];
  const last = manifest.items.at(-1);
  if (first === undefined || last === undefined) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Wiki recovery manifest is empty",
      "A Wiki recovery manifest must describe at least one reviewed operation.",
    );
  }
  expected.set(".mex/events/operations.jsonl", {
    beforeRevision: first.audit.beforeRevision,
    afterRevision: last.audit.afterRevision,
  });
  const expectedProjection = [...expected]
    .filter(([, revisions]) => revisions.beforeRevision !== revisions.afterRevision)
    .map(([path, revisions]) => ({ path, ...revisions }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const actualProjection = changes
    .map((change) => ({
      path: change.path,
      beforeRevision: change.beforeRevision,
      afterRevision: change.afterRevision,
    }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  if (stableJson(expectedProjection) !== stableJson(actualProjection)) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Wiki recovery manifest does not match preview",
      "The bounded Wiki recovery metadata must cover the exact reviewed file revisions.",
    );
  }
}

function entitySubject(entity: EntityRef) {
  return { kind: "entity" as const, entity };
}

function portableWikiRequest<TWikiPayload extends JsonValue>(proposal: InboxProposal<TWikiPayload>, actor: ActorRef, timestamp: string): WikiOperationRequest<TWikiPayload> {
  return {
    operation: { ...proposal.request.operation, actor: wikiActor(actor), timestamp },
    expectedRevisions: proposal.request.expectedRevisions,
  };
}

function wikiActor(actor: ActorRef): WikiOperationActor {
  if (actor.kind === "member") return { kind: "human", id: actor.memberId };
  if (actor.kind === "git") return { kind: "human", id: `git:${hashJson(actor).slice(0, 32)}` };
  return { kind: "system", id: "mex:unknown-actor" };
}

function requireArtifactExpectation(expectations: readonly RevisionExpectation[], path: RepoRelativePath, revision: Revision): void {
  const matches = expectations.filter((item) => item.target.kind === "artifact" && item.target.path === path);
  if (matches.length !== 1) throw missingExpectation(path);
  if (matches[0]!.revision !== revision) throw targetRevisionChanged(path);
}

function requireLocalExpectation(
  expectations: readonly RevisionExpectation[],
  namespace: "inbox-draft" | "relay-draft" | "member-selection",
  id: string,
  revision: Revision | null,
): void {
  const matches = expectations.filter((item) => item.target.kind === "local" && item.target.namespace === namespace && item.target.id === id);
  if (matches.length !== 1) throw missingExpectation(`${namespace}:${id}`);
  if (matches[0]!.revision !== revision) throw targetRevisionChanged(`${namespace}:${id}`);
}

function requiredLocalRevision(
  expectations: readonly RevisionExpectation[],
  namespace: "inbox-draft" | "relay-draft" | "member-selection",
  id: string,
): Revision {
  const match = expectations.find((item) => item.target.kind === "local" && item.target.namespace === namespace && item.target.id === id);
  if (match === undefined || match.revision === null) throw missingExpectation(`${namespace}:${id}`);
  return match.revision;
}

function missingExpectation(target: string) {
  return artifactError("VALIDATION_FAILED", "Workflow revision expectation is missing", `An exact revision expectation is required for ${target}.`);
}

function targetRevisionChanged(target: string) {
  return artifactError(
    "REVISION_CONFLICT",
    "Workflow target changed",
    `The exact expected revision for ${target} is no longer current.`,
  );
}

async function required<T>(value: Promise<T | null>, label: string): Promise<T> {
  const result = await value;
  if (result === null) throw artifactError("NOT_FOUND", `${label} not found`, `${label} does not exist.`);
  return result;
}

function requiredDraft<TWikiPayload extends JsonValue>(value: StoredLocalDraft | null, kind: "inbox" | "relay"): StoredLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput> {
  if (value === null || value.kind !== kind) throw artifactError("NOT_FOUND", "Local draft not found", `The ${kind} draft does not exist.`);
  return value as StoredLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput>;
}

function withoutStored<T extends { schemaVersion: number; ref: EntityRef; kind: string; sourcePath: RepoRelativePath; revision: Revision; entityRevision?: number }>(value: T): Omit<T, "schemaVersion" | "ref" | "kind" | "sourcePath" | "revision" | "entityRevision"> {
  const { schemaVersion: _schema, ref: _ref, kind: _kind, sourcePath: _path, revision: _revision, entityRevision: _entityRevision, ...rest } = value;
  return rest;
}

/** Preserve the Relay schema discriminator and its immutable publication context. */
function relayRepositoryUpdateInput(relay: Relay): RelayRepositoryUpdateInput {
  const {
    ref: _ref,
    kind: _kind,
    sourcePath: _sourcePath,
    revision: _revision,
    entityRevision: _entityRevision,
    ...input
  } = relay;
  return input as RelayRepositoryUpdateInput;
}

function legacyRelayPublicationWorkstream(
  effects: readonly TeamWorkflowJournalEffect[] | undefined,
): EntityRef | null {
  if (effects === undefined) return null;
  const activities = effects.filter(
    (effect): effect is ActivityWorkflowEffect =>
      effect.kind === "activity" && effect.action === "relay.published",
  );
  if (activities.length !== 1) return null;
  const workstream = activities[0]!.workstream;
  if (workstream === undefined) return null;
  if (workstream.kind !== "workstream") throw incompleteRecovery();
  return workstream;
}

function relayDirtyPublicationDiagnostic(): Diagnostic {
  return {
    code: "RELAY_DIRTY_PUBLICATION_STATE",
    severity: "warning",
    message: "MEX recorded that local changes existed when this Relay was published; it did not record their paths, diff, or contents.",
  };
}

function workstreamCallerProjectionIsEqual(
  current: Workstream,
  candidate: Workstream,
): boolean {
  return stableJson(workstreamCallerProjection(current))
    === stableJson(workstreamCallerProjection(candidate));
}

function workstreamCallerProjection(workstream: Workstream) {
  return {
    title: workstream.title,
    goal: workstream.goal,
    summary: workstream.summary,
    state: workstream.state,
    owners: workstream.owners,
    contributors: workstream.contributors,
    paths: workstream.paths,
    code: workstream.code,
    topics: workstream.topics,
    components: workstream.components,
    related: workstream.related,
    blockers: workstream.blockers,
    currentState: workstream.currentState,
    nextMilestone: workstream.nextMilestone,
  };
}

function assertNoCallerAuthority(command: TeamWorkflowCommand<JsonValue>): void {
  for (const field of ["actor", "occurredAt", "repoState", "authority"] as const) {
    if (Object.hasOwn(command, field)) throw artifactError("INVALID_REQUEST", "Caller authority is forbidden", "Actor, time, branch, HEAD, and dirty state are captured by the workflow service.");
  }
}

function assertCommandShape(command: unknown): asserts command is TeamWorkflowCommand<JsonValue> {
  if (!isPlainObject(command)) invalidCommandShape();
  exactObjectKeys(command, ["operationId", "action", "expectedRevisions"]);
  assertActionShape(command.action);
}

function assertPreparedCommandShape(
  command: unknown,
): asserts command is PreparedTeamWorkflowCommand<JsonValue> {
  if (!isPlainObject(command)) invalidApplyRequest();
  exactObjectKeys(command, ["operationId", "action", "expectedRevisions", "authority"]);
  assertOperationId(command.operationId as string);
  assertActionShape(command.action);
  // Parsing the complete expectation set here gives malformed apply requests
  // the same stable, bounded semantics as preview before any hash or lookup.
  normalizeWorkflowRevisionExpectations(command.expectedRevisions);
  if (!isPlainObject(command.authority)) invalidApplyRequest();
  exactObjectKeys(command.authority, ["actor", "occurredAt", "repoState"]);
}

function assertActionShape(action: unknown): void {
  if (!isPlainObject(action) || typeof action.kind !== "string") {
    invalidCommandShape();
  }
  const actionKeys: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
    "member.add": [["kind", "member"], []],
    "member.update": [["kind", "memberId", "patch"], []],
    "member.deactivate": [["kind", "memberId"], []],
    "member.reactivate": [["kind", "memberId"], []],
    "member.select": [["kind", "memberId"], []],
    "member.clear": [["kind"], []],
    "activity.record": [["kind", "activity"], []],
    "workstream.create": [["kind", "workstream"], []],
    "workstream.update": [["kind", "workstreamId", "patch"], []],
    "workstream.archive": [["kind", "workstreamId"], []],
    "inbox.draft.save": [["kind", "draft"], ["draftId"]],
    "inbox.draft.delete": [["kind", "draftId"], []],
    "inbox.publish": [["kind", "draftId"], []],
    "inbox.approve": [["kind", "proposalId"], []],
    "inbox.reject": [["kind", "proposalId", "rationale"], []],
    "inbox.mark-stale": [["kind", "proposalId", "rationale"], []],
    "inbox.withdraw": [["kind", "proposalId"], ["rationale"]],
    "inbox.repair": [["kind", "proposalId", "replacement"], []],
    "relay.draft.save": [["kind", "draft"], ["draftId"]],
    "relay.draft.delete": [["kind", "draftId"], []],
    "relay.publish": [["kind", "draftId"], []],
    "relay.acknowledge": [["kind", "relayId"], []],
    "relay.close": [["kind", "relayId"], []],
    "playbook.create": [["kind", "playbook"], []],
    "playbook.update": [["kind", "playbookId", "patch"], []],
    "playbook.archive": [["kind", "playbookId"], []],
    "playbook.run.start": [["kind", "playbook", "workstream"], []],
    "playbook.run.complete-step": [["kind", "runId", "stepId"], []],
  };
  const keys = actionKeys[action.kind];
  if (keys === undefined) invalidCommandShape();
  exactObjectKeys(action, keys[0], keys[1]);
  if (action.kind === "member.update") {
    if (!isPlainObject(action.patch)) invalidCommandShape();
    exactObjectKeys(action.patch, [], ["displayName", "gitAliases"]);
    if (Object.keys(action.patch).length === 0) invalidCommandShape();
  }
  if (action.kind === "activity.record") {
    if (!isPlainObject(action.activity)) invalidCommandShape();
    exactObjectKeys(action.activity, ["action", "subjects"], ["workstream"]);
  }
}

function exactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || actual.some((key) => !allowed.includes(key))
  ) {
    invalidCommandShape();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidCommandShape(): never {
  throw artifactError(
    "VALIDATION_FAILED",
    "Invalid workflow command",
    "The workflow command contains missing, unsupported, or extra fields.",
  );
}

function invalidApplyRequest(): never {
  throw artifactError(
    "INVALID_REQUEST",
    "Invalid workflow apply request",
    "The prepared workflow command must be bounded structured data returned by preview.",
  );
}

function cloneCommand<TWikiPayload extends JsonValue>(
  command: TeamWorkflowCommand<TWikiPayload>,
): TeamWorkflowCommand<TWikiPayload> {
  try {
    return structuredClone(command);
  } catch {
    invalidCommandShape();
  }
}

function assertOperationId(value: string): void {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) throw artifactError("INVALID_REQUEST", "Invalid operation ID", "Operation ID must be bounded ASCII without paths or whitespace.");
}

function sameRepoCheckpoint(left: RepoState, right: RepoState): boolean {
  return left.branch === right.branch && left.head === right.head && left.dirty === right.dirty;
}

function repositoryChanged() {
  return artifactError("REVISION_CONFLICT", "Repository changed", "Repository branch, HEAD, or dirty state changed after workflow preview.");
}

function previewConflict() {
  return artifactError("REVISION_CONFLICT", "Workflow preview is unavailable", "The exact workflow preview is unavailable or no longer matches the approved command.");
}

/**
 * The bounded `scaffold_id` in a `.mex/config.json` body, or `null` when the
 * body is unparseable or the id is absent or malformed.
 *
 * One definition, used for both the tracked copy and the working copy, so the
 * two cannot drift into disagreeing about what a well-formed identity is.
 */
function scaffoldIdentityOf(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const value = isPlainObject(parsed) ? parsed.scaffold_id : undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\0-\x1f\x7f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function missingScaffoldIdentity() {
  return artifactError(
    "MIGRATION_REQUIRED",
    "Team workflow initialization is required",
    "The repository must have one bounded tracked scaffold identity before Team workflows can be opened.",
  );
}

function invalidLocalDraftList() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid local draft list request",
    "Local draft kind, page size, or cursor is invalid.",
  );
}

function invalidRelayList() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid Relay list request",
    "Relay perspective, state, Workstream, page size, or cursor is invalid.",
  );
}

function relayPageConflict() {
  return artifactError(
    "REVISION_CONFLICT",
    "Relay page changed",
    "The Relay corpus, personal identity, or filter changed. Restart pagination.",
  );
}

function relayUnauthorized(detail: string) {
  return artifactError("UNAUTHORIZED", "Relay action is not authorized", detail);
}

function actionAllowsStaleSelectionFallback(
  kind: TeamWorkflowAction<JsonValue>["kind"],
): boolean {
  return kind === "member.clear"
    || kind === "member.reactivate"
    || kind === "relay.draft.save"
    || kind === "relay.draft.delete";
}

function assertExactRelayExpectationTargets(
  expectations: readonly RevisionExpectation[],
  expectedTargets: readonly string[],
): void {
  const actual = expectations.map((expectation) => {
    if (expectation.semanticRevision !== undefined) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid Relay expectation set",
        "Relay artifact and local dependencies never accept semantic revisions.",
      );
    }
    if (expectation.target.kind === "artifact") {
      if (expectation.revision === null) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Invalid Relay expectation set",
          "Every existing Relay artifact dependency requires a non-null exact revision.",
        );
      }
      return `artifact:${expectation.target.path}`;
    }
    if (
      expectation.target.kind === "local"
      && expectation.target.namespace === "relay-draft"
    ) {
      if (expectation.revision === null) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Invalid Relay expectation set",
          "An existing Relay draft requires a non-null exact revision.",
        );
      }
      return `local:relay-draft:${expectation.target.id}`;
    }
    throw artifactError(
      "VALIDATION_FAILED",
      "Invalid Relay expectation set",
      "Relay operations reject unrelated, semantic, and unsupported revision targets.",
    );
  });
  const orderedActual = [...actual].sort(compareCodePoints);
  const orderedExpected = [...expectedTargets].sort(compareCodePoints);
  if (
    new Set(actual).size !== actual.length
    || stableJson(orderedActual) !== stableJson(orderedExpected)
  ) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Incomplete Relay expectation set",
      "Relay publication requires exactly its draft and recipient Members; lifecycle actions require only the Relay.",
    );
  }
}

function compareRelayProjection(
  left: TeamRelayDetail,
  right: TeamRelayDetail,
): number {
  if (left.publishedAt === null && right.publishedAt !== null) return 1;
  if (left.publishedAt !== null && right.publishedAt === null) return -1;
  if (left.publishedAt !== right.publishedAt) {
    return left.publishedAt! > right.publishedAt! ? -1 : 1;
  }
  return left.ref.id > right.ref.id ? -1 : left.ref.id < right.ref.id ? 1 : 0;
}

function incompleteRecovery() {
  return artifactError(
    "OPERATION_INTERRUPTED",
    "Workflow recovery is incomplete",
    "Canonical workflow effects are only partially present; restore the matching checkout and retry.",
  );
}

function hashJson(value: unknown): Revision {
  return createHash("sha256").update(stableJson(value)).digest("hex") as Revision;
}

function hashText(value: string): Revision {
  return createHash("sha256").update(value).digest("hex") as Revision;
}

/**
 * Stable JSON for untrusted apply input. Unlike the internal serializer this
 * rejects cycles, exotic prototypes, excessive depth/node count, and
 * oversized commands before hashing them.
 */
function boundedStableJson(value: unknown): string {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_PREPARED_COMMAND_NODES || depth > MAX_PREPARED_COMMAND_DEPTH) {
      invalidApplyRequest();
    }
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidApplyRequest();
      return current;
    }
    if (typeof current !== "object") invalidApplyRequest();
    if (active.has(current)) invalidApplyRequest();
    active.add(current);
    let result: unknown;
    if (Array.isArray(current)) {
      result = current.map((item) => visit(item, depth + 1));
    } else {
      if (!isPlainObject(current)) invalidApplyRequest();
      const sorted = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(current).sort()) {
        const entry = current[key];
        if (entry === undefined) invalidApplyRequest();
        sorted[key] = visit(entry, depth + 1);
      }
      result = sorted;
    }
    active.delete(current);
    return result;
  };
  const serialized = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(serialized, "utf8") > MAX_PREPARED_COMMAND_BYTES) {
    invalidApplyRequest();
  }
  return serialized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? TEAM_READ_LIMITS.defaultPageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > TEAM_READ_LIMITS.maxPageSize) throw artifactError("INVALID_REQUEST", "Invalid page size", `Page size must be between 1 and ${TEAM_READ_LIMITS.maxPageSize}.`);
  return limit;
}

function normalizeKinds(value: readonly TeamArtifactKind[] | undefined): readonly TeamArtifactKind[] {
  if (value === undefined) return ARTIFACT_KIND_ORDER;
  if (!Array.isArray(value) || value.length === 0 || value.length > ARTIFACT_KIND_ORDER.length || new Set(value).size !== value.length || value.some((kind) => !ARTIFACT_KIND_ORDER.includes(kind))) throw artifactError("INVALID_REQUEST", "Invalid artifact kinds", "Artifact kinds must be a non-empty unique supported list.");
  return ARTIFACT_KIND_ORDER.filter((kind) => value.includes(kind));
}

function normalizeStates(value: readonly TeamArtifactState[] | undefined): readonly TeamArtifactState[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 || new Set(value).size !== value.length || value.some((state) => !ARTIFACT_STATES.has(state))) throw artifactError("INVALID_REQUEST", "Invalid artifact states", "Artifact states must be a non-empty unique bounded supported list.");
  return [...value].sort();
}

function encodeArtifactCursor(cursor: ArtifactCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) throw artifactError("INTERNAL_ERROR", "Workflow cursor is too large", "The bounded workflow cursor exceeded its limit.");
  return encoded;
}

function encodeMemberCursor(cursor: MemberCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) {
    throw artifactError(
      "INTERNAL_ERROR",
      "Member cursor is too large",
      "The bounded member cursor exceeded its limit.",
    );
  }
  return encoded;
}

function decodeMemberCursor(
  value: string | undefined,
  corpusRevision: Revision,
  filterRevision: Revision,
): MemberCursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) {
    throw invalidMemberList();
  }
  let parsed: MemberCursor;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > MAX_CURSOR_BYTES) {
      throw new Error("invalid member cursor");
    }
    const candidate: unknown = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    );
    if (!isPlainObject(candidate)) throw new Error("invalid member cursor");
    exactIdentityKeys(candidate, ["v", "offset", "corpusRevision", "filterRevision"]);
    if (
      candidate.v !== 1
      || !Number.isInteger(candidate.offset)
      || (candidate.offset as number) < 1
      || !isRevisionValue(candidate.corpusRevision)
      || !isRevisionValue(candidate.filterRevision)
    ) {
      throw new Error("invalid member cursor");
    }
    parsed = candidate as unknown as MemberCursor;
  } catch {
    throw invalidMemberList();
  }
  if (
    parsed.corpusRevision !== corpusRevision
    || parsed.filterRevision !== filterRevision
  ) {
    throw artifactError(
      "REVISION_CONFLICT",
      "Member cursor is stale",
      "The member corpus or active filter changed. Restart pagination.",
    );
  }
  return parsed;
}

function decodeArtifactCursor(value: string | undefined, corpusRevision: Revision, filterRevision: Revision, kindCount: number): ArtifactCursor | null {
  if (value === undefined) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) throw invalidArtifactCursor();
  let parsed: ArtifactCursor;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > MAX_CURSOR_BYTES) throw new Error();
    parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as ArtifactCursor;
    if (parsed.v !== 1 || !Number.isInteger(parsed.kindIndex) || parsed.kindIndex < 0 || parsed.kindIndex >= kindCount || !Number.isInteger(parsed.memberOffset) || parsed.memberOffset < 0 || (parsed.innerCursor !== null && typeof parsed.innerCursor !== "string") || typeof parsed.corpusRevision !== "string" || typeof parsed.filterRevision !== "string") throw new Error();
  } catch {
    throw invalidArtifactCursor();
  }
  if (parsed.corpusRevision !== corpusRevision || parsed.filterRevision !== filterRevision) {
    throw artifactError("REVISION_CONFLICT", "Workflow cursor is stale", "The workflow artifact corpus or filter changed. Restart pagination.");
  }
  return parsed;
}

function invalidArtifactCursor() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid workflow cursor",
    "Workflow cursor is malformed or exceeds its bounded size.",
  );
}

function invalidMemberList() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid member list request",
    "Member active filter, page size, or cursor is invalid.",
  );
}

function activitySourceTruncated() {
  return artifactError(
    "VALIDATION_FAILED",
    "Activity source is truncated",
    "Canonical Activity exceeded its bounded scan limits; no partial result is trusted.",
  );
}

function effectToLocalChange(effect: TeamWorkflowJournalEffect): LocalStateChange[] {
  if (effect.kind !== "local") return [];
  if (effect.namespace === MEMBER_SELECTION_NAMESPACE && effect.id === MEMBER_SELECTION_ID) {
    return [memberSelectionChange(
      effect.beforeRevision,
      effect.afterRevision,
      "Recovered current member selection",
    )];
  }
  if (effect.namespace !== "inbox-draft" && effect.namespace !== "relay-draft") return [];
  return [{ namespace: effect.namespace, id: effect.id, beforeRevision: effect.beforeRevision, afterRevision: effect.afterRevision, summary: "Recovered local draft change" }];
}

function namespaceToArtifactKind(namespace: string): TeamArtifactKind | null {
  switch (namespace) {
    case "member": return "member";
    case "workstream": return "workstream";
    case "proposal": return "proposal";
    case "relay": return "relay";
    case "playbook": return "playbook";
    case "playbook-run": return "playbook_run";
    default: return null;
  }
}

function isWorkstreamState(value: TeamArtifactState): value is Workstream["state"] { return ["planned", "active", "blocked", "done", "archived"].includes(value); }
function isProposalState(value: TeamArtifactState): value is InboxProposal<JsonValue>["state"] { return ["pending", "approved", "rejected", "withdrawn", "stale"].includes(value); }
function isRelayState(value: TeamArtifactState): value is Relay["state"] { return ["published", "acknowledged", "closed"].includes(value); }
function isPlaybookState(value: TeamArtifactState): value is Playbook["state"] { return ["active", "archived"].includes(value); }
function isRunState(value: TeamArtifactState): value is PlaybookRun["state"] { return ["active", "completed"].includes(value); }

function assertNever(value: never): never {
  throw artifactError("INVALID_REQUEST", "Unsupported workflow action", `Unsupported workflow action ${String(value)}.`);
}

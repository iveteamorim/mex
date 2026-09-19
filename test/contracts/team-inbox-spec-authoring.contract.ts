import { describe, expect, it } from "vitest";
import type {
  ActorRef,
  Diagnostic,
  EntityRef,
  FileChange,
  RepoRelativePath,
  RepoState,
  Revision,
  RevisionExpectation,
} from "../../src/team/contracts/shared.js";
import type {
  StoredActivityEvent,
  TeamEvidenceRef,
} from "../../src/team/contracts/workflow.js";

export const TEAM_INBOX_SPEC_KINDS = [
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
] as const;

export const TEAM_INBOX_SPEC_PROPOSAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "stale",
] as const;

export const TEAM_INBOX_SPEC_RECOVERY_PHASES = [
  "publish.after-proposal",
  "publish.after-activity",
  "publish.after-cleanup",
  "approve.after-wiki",
  "approve.after-proposal",
  "approve.after-activity",
] as const;

export const TEAM_INBOX_VALID_CREATE_CASES = [
  "in-flight",
  "promoted-with-topics",
  "spec-constrained-by",
  "requirement-derived-from",
  "requirement-refines",
  "requirement-constrained-by",
  "constraint-constrained-by",
  "acceptance-verified-by-requirement",
  "acceptance-verified-by-spec",
  "acceptance-constrained-by",
] as const;

export const TEAM_INBOX_RATIONALE_EXCERPT_MAX_BYTES = 240;

export type TeamInboxSpecKind = (typeof TEAM_INBOX_SPEC_KINDS)[number];
export type TeamInboxSpecProposalState =
  (typeof TEAM_INBOX_SPEC_PROPOSAL_STATES)[number];
export type TeamInboxSpecRecoveryPhase =
  (typeof TEAM_INBOX_SPEC_RECOVERY_PHASES)[number];
export type TeamInboxValidCreateCase =
  (typeof TEAM_INBOX_VALID_CREATE_CASES)[number];
export type TeamInboxSpecDriftCase =
  | "update-target"
  | "topic-endpoint"
  | "relation-endpoint";

export interface TeamInboxSpecRef<TKind extends TeamInboxSpecKind = TeamInboxSpecKind> {
  id: string;
  kind: TKind;
  title?: string;
}

type RefinesRequirementRelation = {
  type: "refines";
  target: TeamInboxSpecRef<"requirement">;
};

type ConstrainedByRelation = {
  type: "constrained_by";
  target: TeamInboxSpecRef<"constraint">;
};

export type TeamInboxSpecCreateRelation<TKind extends TeamInboxSpecKind> =
  TKind extends "spec"
    ? ConstrainedByRelation
    : TKind extends "requirement"
      ? { type: "derived_from"; target: TeamInboxSpecRef<"spec"> }
        | RefinesRequirementRelation
        | ConstrainedByRelation
      : TKind extends "constraint"
        ? ConstrainedByRelation
        : { type: "verified_by"; target: TeamInboxSpecRef<"requirement" | "spec"> }
          | ConstrainedByRelation;

export interface TeamInboxSpecStoredRelation {
  type: "derived_from" | "verified_by" | "constrained_by" | "refines";
  target: TeamInboxSpecRef;
}

export type TeamInboxSpecCreateChange = {
  [TKind in TeamInboxSpecKind]: {
    kind: "spec.create";
    entityKind: TKind;
    title: string;
    body: string;
    summary?: string;
    status: "in_flight" | "promoted";
    topics?: readonly string[];
    /** At most one relation, in the exact Checkpoint D direction. */
    relation?: TeamInboxSpecCreateRelation<TKind>;
  }
}[TeamInboxSpecKind];

export type TeamInboxSpecUpdatePatch =
  | { title: string; summary?: string; body?: string }
  | { title?: string; summary: string; body?: string }
  | { title?: string; summary?: string; body: string };

export interface TeamInboxSpecUpdateChange {
  kind: "spec.update";
  target: TeamInboxSpecRef;
  patch: TeamInboxSpecUpdatePatch;
}

/** Closed product change. Raw Wiki envelopes, paths, IDs, adoption, and batches have no slot. */
export type TeamInboxSpecChange =
  | TeamInboxSpecCreateChange
  | TeamInboxSpecUpdateChange;

export interface TeamInboxSpecDraftInput {
  change: TeamInboxSpecChange;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
}

export interface TeamInboxSpecDraftSummary {
  id: string;
  revision: Revision;
  updatedAt: string;
  changeKind: TeamInboxSpecChange["kind"];
  entityKind: TeamInboxSpecKind;
  title: string;
  rationaleExcerpt: string;
}

export interface TeamInboxSpecDraftDetail extends TeamInboxSpecDraftSummary {
  input: TeamInboxSpecDraftInput;
}

export interface TeamInboxSpecProposalSummary {
  schemaVersion: 1;
  ref: EntityRef;
  sourcePath: RepoRelativePath;
  revision: Revision;
  state: TeamInboxSpecProposalState;
  author: ActorRef;
  changeKind: TeamInboxSpecChange["kind"];
  entityKind: TeamInboxSpecKind;
  title: string;
  rationaleExcerpt: string;
  reviewer?: ActorRef;
  reviewedAt?: string;
}

export interface TeamInboxSpecProposalDetail extends TeamInboxSpecProposalSummary {
  change: TeamInboxSpecChange;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
  reviewRationale?: string;
}

export interface TeamInboxSpecPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  truncated: boolean;
  sourceTruncated: boolean;
  deterministicRevision: Revision;
  diagnostics: readonly Diagnostic[];
}

export interface TeamInboxDraftListRequest {
  cursor?: string;
  limit?: number;
  changeKinds?: readonly TeamInboxSpecChange["kind"][];
  entityKinds?: readonly TeamInboxSpecKind[];
}

export interface TeamInboxProposalListRequest extends TeamInboxDraftListRequest {
  states?: readonly TeamInboxSpecProposalState[];
}

export type TeamInboxSpecAction =
  | { kind: "inbox.draft.save"; draftId?: string; draft: TeamInboxSpecDraftInput }
  | { kind: "inbox.draft.delete"; draftId: string }
  | { kind: "inbox.publish"; draftId: string }
  | { kind: "inbox.approve"; proposalId: string }
  | { kind: "inbox.reject"; proposalId: string; rationale: string }
  | { kind: "inbox.withdraw"; proposalId: string; rationale?: string }
  | { kind: "inbox.mark-stale"; proposalId: string; rationale: string }
  | {
      kind: "inbox.repair";
      proposalId: string;
      replacement: TeamInboxSpecDraftInput;
    };

export interface TeamInboxSpecCommand {
  operationId: string;
  action: TeamInboxSpecAction;
  expectedRevisions: readonly RevisionExpectation[];
  actor?: never;
  occurredAt?: never;
  repoState?: never;
  authority?: never;
}

export interface TeamInboxSpecLocalChange {
  namespace: "inbox-draft";
  id: string;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
  summary: string;
}

export interface TeamInboxSpecPublicPreview {
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly TeamInboxSpecLocalChange[];
  diagnostics: readonly Diagnostic[];
}

export interface TeamInboxSpecAuthority {
  actor: ActorRef;
  occurredAt: string;
  repoState: RepoState;
}

export interface TeamInboxSpecPurposeId {
  purpose: "inbox-draft" | "proposal" | "activity" | "spec-entity";
  id: string;
}

export interface TeamInboxSpecReceipt {
  schemaVersion: 1;
  authority: TeamInboxSpecAuthority;
  /** One operation needs at most proposal+Activity or created-Spec+Activity. */
  purposeIds: readonly TeamInboxSpecPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
  previewRevision: Revision;
}

export interface TeamInboxSpecPreviewEnvelope {
  schemaVersion: 1;
  request: TeamInboxSpecCommand;
  preview: TeamInboxSpecPublicPreview;
  receipt: TeamInboxSpecReceipt;
}

export interface TeamInboxSpecApplyResult {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly TeamInboxSpecLocalChange[];
  proposals: readonly TeamInboxSpecProposalDetail[];
  events: readonly StoredActivityEvent[];
}

/** Structural consumer seam; E1 may satisfy it without exporting a package API. */
export interface TeamInboxSpecAuthoringContractPort {
  getInboxDraft(id: string): Promise<TeamInboxSpecDraftDetail | null>;
  listInboxDrafts(
    request?: TeamInboxDraftListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecDraftSummary>>;
  getInboxProposal(id: string): Promise<TeamInboxSpecProposalDetail | null>;
  listInboxProposals(
    request?: TeamInboxProposalListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecProposalSummary>>;
  previewInbox(command: TeamInboxSpecCommand): Promise<TeamInboxSpecPreviewEnvelope>;
  applyInbox(envelope: TeamInboxSpecPreviewEnvelope): Promise<TeamInboxSpecApplyResult>;
}

export type TeamInboxSpecInvalidCase =
  | "raw-wiki-request"
  | "hidden-operations-batch"
  | "caller-create-id"
  | "caller-create-path"
  | "create-adopt"
  | "create-source"
  | "create-grounding"
  | "create-metadata"
  | "unsupported-operation"
  | "non-spec-kind"
  | "wrong-relation-direction"
  | "multiple-create-relations"
  | "invalid-create-status"
  | "too-many-topics"
  | "missing-topic-expectation"
  | "missing-relation-expectation"
  | "empty-update"
  | "update-extra-field"
  | "update-non-spec-target"
  | "caller-authority"
  | "missing-expectation";

export type TeamInboxDirectBypassSurface = "wiki-apply" | "wiki-propose";

export type TeamInboxDirectBypassCase =
  | "create"
  | "existing-target"
  | "relation-endpoint"
  | "type-conversion-into"
  | "type-conversion-out-of"
  | "supersede-existing-replacement"
  | "supersede-inline-replacement"
  | "supersede-inline-relation-endpoint"
  | "spec-path"
  | "hidden-batch";

export type TeamInboxSpecContainmentTarget =
  | "local"
  | "proposal"
  | "activity"
  | "spec";

export type TeamInboxSpecScenario =
  | "empty"
  | "populated"
  | "uninitialized-local"
  | "wiki-missing"
  | "wiki-stale"
  | "source-bound";

export interface TeamInboxSpecProjection {
  ref: TeamInboxSpecRef;
  sourcePath: RepoRelativePath;
  title: string;
  summary: string | null;
  body: string;
  topics: readonly EntityRef[];
  relations: readonly TeamInboxSpecStoredRelation[];
  revision: Revision;
  semanticRevision: number;
}

export interface TeamInboxSpecSnapshot {
  canonicalDigest: Revision;
  wikiDigest: Revision;
  localStateDigest: Revision | null;
  signerDigest: Revision | null;
  outsideDigest: Revision;
  gitHead: string | null;
  gitIndexDigest: Revision;
  draftIds: readonly string[];
  proposalIds: readonly string[];
  specIds: readonly string[];
  activityIds: readonly string[];
  wikiAuditOperationIds: readonly string[];
  modelInvocations: number;
  outboundRequests: number;
}

export interface TeamInboxSpecJournalInspection {
  rowCount: number;
  incompleteCount: number;
  rows: readonly {
    operationId: string;
    phase: "intent" | "canonical_published" | "local_finalized" | "complete";
    effectCount: number;
    effectJsonBytes: number;
    serializedEffects: string;
    serializedRow: string;
  }[];
  durableStorageForbiddenMatches: readonly string[];
}

export interface TeamInboxSpecContractHarness {
  port: TeamInboxSpecAuthoringContractPort;
  fixture: {
    filesystem: "real";
    localState: "real";
    git: "real";
    wiki: "real-adapter";
  };
  oracle: {
    now: string;
    actor: ActorRef;
    repoState: RepoState;
    populatedDraft: TeamInboxSpecDraftDetail | null;
    populatedProposal: TeamInboxSpecProposalDetail | null;
    privacySentinels: readonly string[];
  };
  makeDraftInput(
    change: TeamInboxSpecChange["kind"],
    entityKind?: TeamInboxSpecKind,
  ): Promise<TeamInboxSpecDraftInput>;
  makeValidCreateInput(kind: TeamInboxValidCreateCase): Promise<TeamInboxSpecDraftInput>;
  makeDriftInput(kind: TeamInboxSpecDriftCase): Promise<TeamInboxSpecDraftInput>;
  makeInvalidCommand(kind: TeamInboxSpecInvalidCase): Promise<unknown>;
  prepareEnvelopeExpansionDraft(): Promise<{
    draft: TeamInboxSpecDraftDetail;
    storedArtifactBytes: number;
  }>;
  mutateReadCorpus(): Promise<void>;
  mutatePublishedDependency(
    proposal: TeamInboxSpecProposalDetail,
    kind: TeamInboxSpecDriftCase,
  ): Promise<void>;
  installTeamOwnedDuplicateClaimant(entityId: string): Promise<void>;
  armDependencyDriftBeforePublication(entityId: string): Promise<void>;
  armDependencyRestoreBeforePublication(entityId: string): Promise<void>;
  armProposalDriftBeforePublication(
    proposal: TeamInboxSpecProposalDetail,
  ): Promise<void>;
  mutateRepositoryAuthority(): Promise<void>;
  refreshDraftInput(input: TeamInboxSpecDraftInput): Promise<TeamInboxSpecDraftInput>;
  readSpec(id: string): Promise<TeamInboxSpecProjection | null>;
  restart(): Promise<TeamInboxSpecAuthoringContractPort>;
  setNow(timestamp: string): void;
  removeSigner(): Promise<void>;
  armCrash(phase: TeamInboxSpecRecoveryPhase): Promise<void>;
  prepareRecoveryEnvelope(
    phase: TeamInboxSpecRecoveryPhase,
  ): Promise<TeamInboxSpecPreviewEnvelope>;
  installEscapingAncestor(target: TeamInboxSpecContainmentTarget): Promise<void>;
  prepareContainmentEnvelope(
    target: TeamInboxSpecContainmentTarget,
  ): Promise<TeamInboxSpecPreviewEnvelope>;
  swapProjectRoot(): Promise<void>;
  snapshot(): Promise<TeamInboxSpecSnapshot>;
  inspectJournal(): Promise<TeamInboxSpecJournalInspection>;
  close(): Promise<void>;
}

export interface TeamInboxSpecTwoCloneHarness {
  left: TeamInboxSpecContractHarness;
  right: TeamInboxSpecContractHarness;
  synchronizeCanonical(): Promise<void>;
  close(): Promise<void>;
}

export interface TeamInboxSpecContractFactory {
  open(scenario: TeamInboxSpecScenario): Promise<TeamInboxSpecContractHarness>;
  openTwoClone(): Promise<TeamInboxSpecTwoCloneHarness>;
}

export interface TeamInboxDirectWikiSpecContractHarness
  extends TeamInboxSpecContractHarness {
  attemptDirectWikiSpecMutation(
    surface: TeamInboxDirectBypassSurface,
    kind: TeamInboxDirectBypassCase,
  ): Promise<void>;
}

export interface TeamInboxDirectWikiSpecContractFactory {
  open(
    scenario: TeamInboxSpecScenario,
  ): Promise<TeamInboxDirectWikiSpecContractHarness>;
}

/** Core Checkpoint E1 consumer contract for the Inbox-governed Spec facade. */
export function defineTeamInboxSpecAuthoringContract(
  adapterName: string,
  factory: TeamInboxSpecContractFactory,
): void {
  describe(`${adapterName} Inbox-governed Spec authoring contract`, () => {
    it("keeps absent local storage absent during bounded draft/proposal reads", async () => {
      await withHarness(factory, "uninitialized-local", async ({ port, snapshot }) => {
        const before = await snapshot();
        expect(before.localStateDigest).toBeNull();
        await expect(port.getInboxDraft("inbox_missing")).resolves.toBeNull();
        await expect(port.getInboxProposal("proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
          .resolves.toBeNull();
        await expect(port.listInboxDrafts()).resolves.toMatchObject({ items: [] });
        await expect(port.listInboxProposals()).resolves.toMatchObject({ items: [] });
        expect(await snapshot()).toEqual(before);
      });
    });

    it("returns bounded summaries and exact details with revision-bound cursors", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const { port, oracle } = harness;
        if (oracle.populatedDraft === null || oracle.populatedProposal === null) {
          throw new Error("The populated Inbox fixture is incomplete.");
        }
        await expect(port.getInboxDraft(oracle.populatedDraft.id))
          .resolves.toEqual(oracle.populatedDraft);
        await expect(port.getInboxProposal(oracle.populatedProposal.ref.id))
          .resolves.toEqual(oracle.populatedProposal);

        const drafts = await port.listInboxDrafts({ limit: 1 });
        const proposals = await port.listInboxProposals({
          states: [oracle.populatedProposal.state],
          entityKinds: [oracle.populatedProposal.entityKind],
          limit: 1,
        });
        expect(drafts.items).toHaveLength(1);
        expect(proposals.items).toHaveLength(1);
        expect(drafts.items[0]).not.toHaveProperty("input");
        expect(proposals.items[0]).not.toHaveProperty("change");
        expect(utf8Bytes(drafts.items[0]!.rationaleExcerpt))
          .toBeLessThanOrEqual(TEAM_INBOX_RATIONALE_EXCERPT_MAX_BYTES);
        expect(utf8Bytes(proposals.items[0]!.rationaleExcerpt))
          .toBeLessThanOrEqual(TEAM_INBOX_RATIONALE_EXCERPT_MAX_BYTES);
        expect(drafts.sourceTruncated).toBe(false);
        expect(proposals.sourceTruncated).toBe(false);
        expectRevision(drafts.deterministicRevision);
        expectRevision(proposals.deterministicRevision);

        await expect(port.listInboxDrafts({ limit: 101 })).rejects.toMatchObject({
          problem: { code: "INVALID_REQUEST" },
        });
        await expect(port.listInboxProposals({ cursor: "x".repeat(4_097) }))
          .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
        if (drafts.nextCursor !== null) {
          await harness.mutateReadCorpus();
          await expect(port.listInboxDrafts({ cursor: drafts.nextCursor, limit: 1 }))
            .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
        }
      });

      await withHarness(factory, "source-bound", async ({ port }) => {
        await expect(port.listInboxProposals()).rejects.toMatchObject({
          problem: { code: "INDEX_CORRUPT" },
        });
      });
    });

    for (const scenario of ["wiki-missing", "wiki-stale"] as const) {
      it(`keeps draft authoring and proposal reads independent when Wiki is ${scenario}`, async () => {
        await withHarness(factory, scenario, async (harness) => {
          const before = await harness.snapshot();
          const existingProposal = expectDefined(harness.oracle.populatedProposal);
          await expect(harness.port.getInboxProposal(existingProposal.ref.id))
            .resolves.toEqual(existingProposal);
          expect((await harness.port.listInboxProposals({ limit: 1 })).items)
            .toEqual([expect.objectContaining({ ref: existingProposal.ref })]);
          const envelope = await harness.port.previewInbox(command(
            `inbox_contract_${scenario}_draft`,
            {
              kind: "inbox.draft.save",
              draft: await harness.makeDraftInput("spec.create", "spec"),
            },
          ));
          expect(envelope.preview).toMatchObject({
            valid: true,
            scope: "local",
            changes: [],
          });
          expectPurposes(envelope, ["inbox-draft"]);
          const draftId = purposeId(envelope, "inbox-draft");
          await harness.port.applyInbox(roundTrip(envelope));
          const draft = await harness.port.getInboxDraft(draftId);
          expect(draft).not.toBeNull();
          expect((await harness.port.listInboxDrafts({ limit: 1 })).items)
            .toEqual([expect.objectContaining({ id: draftId })]);
          if (draft === null) throw new Error("Expected the offline Inbox draft.");
          const replacement = {
            ...draft.input,
            rationale: `${draft.input.rationale} Updated while Wiki is ${scenario}.`,
          };
          const update = await harness.port.previewInbox(command(
            `inbox_contract_${scenario}_draft_update`,
            { kind: "inbox.draft.save", draftId, draft: replacement },
            [draftExpectation(draft)],
          ));
          expectPurposes(update, []);
          await harness.port.applyInbox(roundTrip(update));
          const updated = await harness.port.getInboxDraft(draftId);
          expect(updated?.input).toEqual(replacement);
          if (updated === null) throw new Error("Expected the updated offline Inbox draft.");
          const deletion = await harness.port.previewInbox(command(
            `inbox_contract_${scenario}_draft_delete`,
            { kind: "inbox.draft.delete", draftId },
            [draftExpectation(updated)],
          ));
          expectPurposes(deletion, []);
          await harness.port.applyInbox(roundTrip(deletion));
          await expect(harness.port.getInboxDraft(draftId)).resolves.toBeNull();
          const after = await harness.snapshot();
          expect(after.canonicalDigest).toBe(before.canonicalDigest);
          expect(after.wikiDigest).toBe(before.wikiDigest);
          expect(after.activityIds).toEqual(before.activityIds);
        });
      });
    }

    it("saves, updates, and deletes a local draft with no canonical or Activity effect", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDraftInput("spec.create", "spec");
        const before = await harness.snapshot();
        const save = await harness.port.previewInbox(command(
          "inbox_contract_draft_save",
          { kind: "inbox.draft.save", draft: input },
        ));
        expect(save.preview).toMatchObject({ valid: true, scope: "local", changes: [] });
        expectPurposes(save, ["inbox-draft"]);
        const draftId = purposeId(save, "inbox-draft");

        const restarted = await harness.restart();
        const saved = await restarted.applyInbox(roundTrip(save));
        expect(saved.events).toEqual([]);
        expect(saved.changes).toEqual([]);
        const draft = await restarted.getInboxDraft(draftId);
        expect(draft?.input).toEqual(input);
        if (draft === null) throw new Error("Expected the saved Inbox draft.");

        const replacement = { ...input, rationale: `${input.rationale} Updated.` };
        const update = await restarted.previewInbox(command(
          "inbox_contract_draft_update",
          { kind: "inbox.draft.save", draftId, draft: replacement },
          [draftExpectation(draft)],
        ));
        expectPurposes(update, []);
        await restarted.applyInbox(roundTrip(update));
        const updated = await restarted.getInboxDraft(draftId);
        if (updated === null) throw new Error("Expected the updated Inbox draft.");
        expect(updated.input.rationale).toBe(replacement.rationale);

        const deletion = await restarted.previewInbox(command(
          "inbox_contract_draft_delete",
          { kind: "inbox.draft.delete", draftId },
          [draftExpectation(updated)],
        ));
        expectPurposes(deletion, []);
        expect((await restarted.applyInbox(roundTrip(deletion))).events).toEqual([]);
        await expect(restarted.getInboxDraft(draftId)).resolves.toBeNull();

        const after = await harness.snapshot();
        expect(after.canonicalDigest).toBe(before.canonicalDigest);
        expect(after.wikiDigest).toBe(before.wikiDigest);
        expect(after.activityIds).toEqual(before.activityIds);
        expect(after.gitHead).toBe(before.gitHead);
        expect(after.gitIndexDigest).toBe(before.gitIndexDigest);
      });
    });

    it("accepts only the closed one-change Spec model and refuses every raw or batched escape", async () => {
      await withHarness(factory, "empty", async (harness) => {
        for (const validCase of TEAM_INBOX_VALID_CREATE_CASES) {
          const input = await harness.makeValidCreateInput(validCase);
          expectValidCreateCase(input, validCase);
          await expect(harness.port.previewInbox(command(
            `inbox_contract_valid_create_${validCase}`,
            { kind: "inbox.draft.save", draft: input },
          ))).resolves.toMatchObject({ preview: { valid: true } });
        }

        for (const entityKind of TEAM_INBOX_SPEC_KINDS) {
          const create = await harness.makeDraftInput("spec.create", entityKind);
          expect(create.change).toMatchObject({ kind: "spec.create", entityKind });
          expect(create.change).not.toHaveProperty("request");
          expect(create.change).not.toHaveProperty("operations");
          expect(create.change).not.toHaveProperty("file");
          expect(create.change).not.toHaveProperty("adopt");
          await expect(harness.port.previewInbox(command(
            `inbox_contract_valid_create_${entityKind}`,
            { kind: "inbox.draft.save", draft: create },
          ))).resolves.toMatchObject({ preview: { valid: true } });

          const update = await harness.makeDraftInput("spec.update", entityKind);
          expect(update.change).toMatchObject({ kind: "spec.update", target: { kind: entityKind } });
          await expect(harness.port.previewInbox(command(
            `inbox_contract_valid_update_${entityKind}`,
            { kind: "inbox.draft.save", draft: update },
          ))).resolves.toMatchObject({ preview: { valid: true } });
        }

        for (const [invalid, code] of [
          ["raw-wiki-request", "INVALID_REQUEST"],
          ["hidden-operations-batch", "INVALID_REQUEST"],
          ["caller-create-id", "INVALID_REQUEST"],
          ["caller-create-path", "INVALID_REQUEST"],
          ["caller-authority", "INVALID_REQUEST"],
          ["create-adopt", "VALIDATION_FAILED"],
          ["create-source", "INVALID_REQUEST"],
          ["create-grounding", "INVALID_REQUEST"],
          ["create-metadata", "INVALID_REQUEST"],
          ["unsupported-operation", "VALIDATION_FAILED"],
          ["non-spec-kind", "VALIDATION_FAILED"],
          ["wrong-relation-direction", "VALIDATION_FAILED"],
          ["multiple-create-relations", "VALIDATION_FAILED"],
          ["invalid-create-status", "VALIDATION_FAILED"],
          ["too-many-topics", "VALIDATION_FAILED"],
          ["missing-topic-expectation", "VALIDATION_FAILED"],
          ["missing-relation-expectation", "VALIDATION_FAILED"],
          ["empty-update", "VALIDATION_FAILED"],
          ["update-extra-field", "VALIDATION_FAILED"],
          ["update-non-spec-target", "VALIDATION_FAILED"],
          ["missing-expectation", "VALIDATION_FAILED"],
        ] as const) {
          const before = await harness.snapshot();
          await expect(previewUnknown(
            harness.port,
            await harness.makeInvalidCommand(invalid),
          )).rejects.toMatchObject({ problem: { code } });
          expect(await harness.snapshot()).toEqual(before);
        }

      });
    });

    it("refuses a valid stored draft when its generated exact diffs cannot fit the 64 KiB envelope", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const fixture = await harness.prepareEnvelopeExpansionDraft();
        expect(fixture.storedArtifactBytes).toBeGreaterThan(32 * 1024);
        expect(fixture.storedArtifactBytes).toBeLessThanOrEqual(64 * 1024);
        const before = await harness.snapshot();
        await expect(harness.port.previewInbox(command(
          "inbox_contract_envelope_expansion",
          { kind: "inbox.publish", draftId: fixture.draft.id },
          [draftExpectation(fixture.draft)],
        ))).rejects.toMatchObject({
          problem: {
            code: "VALIDATION_FAILED",
            diagnostics: [expect.objectContaining({ code: "ENVELOPE_TOO_LARGE" })],
          },
        });
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    for (const validCase of TEAM_INBOX_VALID_CREATE_CASES) {
      it(`persists the ${validCase} create case with its exact endpoint expectations`, async () => {
        await withHarness(factory, "empty", async (harness) => {
          const input = await harness.makeValidCreateInput(validCase);
          expectValidCreateCase(input, validCase);
          expectCreateDependenciesCovered(input);
          const proposal = await createPendingProposal(
            harness.port,
            input,
            `inbox_contract_persist_${validCase}`,
          );
          const approval = await harness.port.previewInbox(command(
            `inbox_contract_persist_${validCase}_approve`,
            { kind: "inbox.approve", proposalId: proposal.ref.id },
            [proposalExpectation(proposal)],
          ));
          expectPurposes(approval, ["activity", "spec-entity"]);
          const specId = purposeId(approval, "spec-entity");
          const result = await harness.port.applyInbox(roundTrip(approval));
          const stored = await harness.readSpec(specId);
          if (stored === null) throw new Error("Expected the created Spec fixture.");
          if (input.change.kind !== "spec.create") throw new Error("Expected a create fixture.");
          expect(stored.topics.map((topic) => topic.id))
            .toEqual([...(input.change.topics ?? [])]);
          expect(stored.relations.map((relation) => ({
            type: relation.type,
            target: { id: relation.target.id, kind: relation.target.kind },
          }))).toEqual(input.change.relation === undefined ? [] : [{
            type: input.change.relation.type,
            target: {
              id: input.change.relation.target.id,
              kind: input.change.relation.target.kind,
            },
          }]);
          expectCanonicalActivity(
            result,
            approval,
            "inbox.approved",
            [proposal.ref, { id: specId, kind: input.change.entityKind }],
          );
        });
      });
    }

    it("publishes a draft with portable proposal and Activity IDs, then cleans up locally", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const draft = await saveDraft(
          harness.port,
          await harness.makeDraftInput("spec.create", "spec"),
          "inbox_contract_publish_save",
        );
        const publish = await harness.port.previewInbox(command(
          "inbox_contract_publish",
          { kind: "inbox.publish", draftId: draft.id },
          [draftExpectation(draft)],
        ));
        expect(publish.preview.scope).toBe("mixed");
        expectPurposes(publish, ["activity", "proposal"]);
        const proposalId = purposeId(publish, "proposal");

        const restarted = await harness.restart();
        const result = await restarted.applyInbox(roundTrip(publish));
        await expect(restarted.getInboxDraft(draft.id)).resolves.toBeNull();
        await expect(restarted.getInboxProposal(proposalId)).resolves.toMatchObject({
          state: "pending",
          ref: { id: proposalId, kind: "proposal" },
        });
        expectCanonicalActivity(
          result,
          publish,
          "inbox.published",
          [{ id: proposalId, kind: "proposal" }],
        );
      });
    });

    it("approves a create in a fresh process with one reviewed Spec ID and complete Activity subjects", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const proposal = await createPendingProposal(
          harness.port,
          await harness.makeDraftInput("spec.create", "spec"),
          "inbox_contract_create",
        );
        const approval = await harness.port.previewInbox(command(
          "inbox_contract_create_approve",
          { kind: "inbox.approve", proposalId: proposal.ref.id },
          [proposalExpectation(proposal)],
        ));
        expectPurposes(approval, ["activity", "spec-entity"]);
        expect(approval.receipt.purposeIds.length).toBeLessThanOrEqual(2);
        const specId = purposeId(approval, "spec-entity");
        expect(specId).toMatch(/^mx_[0-9A-HJKMNP-TV-Z]{26}$/u);
        expect(approval.preview.changes.map((change) => change.path))
          .toContain(`.mex/specs/${specId}.md`);

        const restarted = await harness.restart();
        const result = await restarted.applyInbox(roundTrip(approval));
        const stored = await harness.readSpec(specId);
        expect(stored).toMatchObject({
          ref: { id: specId, kind: "spec" },
          sourcePath: `.mex/specs/${specId}.md`,
        });
        await expect(restarted.getInboxProposal(proposal.ref.id)).resolves.toMatchObject({
          state: "approved",
          reviewer: approval.receipt.authority.actor,
          reviewedAt: approval.receipt.authority.occurredAt,
        });
        expectCanonicalActivity(
          result,
          approval,
          "inbox.approved",
          [proposal.ref, { id: specId, kind: "spec" }],
        );
      });
    });

    it.each(TEAM_INBOX_SPEC_KINDS)("updates %s without minting an entity ID", async (entityKind) => {
      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDraftInput("spec.update", entityKind);
        if (input.change.kind !== "spec.update") throw new Error("Expected an update fixture.");
        const before = await harness.readSpec(input.change.target.id);
        if (before === null) throw new Error("Expected the update target fixture.");
        const proposal = await createPendingProposal(
          harness.port,
          input,
          `inbox_contract_update_${entityKind}`,
        );
        const approval = await harness.port.previewInbox(command(
          `inbox_contract_update_${entityKind}_approve`,
          { kind: "inbox.approve", proposalId: proposal.ref.id },
          [proposalExpectation(proposal)],
        ));
        expectPurposes(approval, ["activity"]);
        const result = await harness.port.applyInbox(roundTrip(approval));
        const after = await harness.readSpec(input.change.target.id);
        expect(after?.revision).not.toBe(before.revision);
        expect(after).toMatchObject(input.change.patch);
        expectCanonicalActivity(
          result,
          approval,
          "inbox.approved",
          [proposal.ref, input.change.target],
        );
      });
    });

    it.each(["update-target", "topic-endpoint", "relation-endpoint"] as const)("requires explicit stale classification before repair after %s drifts", async (driftCase) => {
      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDriftInput(driftCase);
        const proposal = await createPendingProposal(
          harness.port,
          input,
          `inbox_contract_stale_${driftCase}`,
        );
        const approval = await harness.port.previewInbox(command(
          `inbox_contract_stale_${driftCase}_approve`,
          { kind: "inbox.approve", proposalId: proposal.ref.id },
          [proposalExpectation(proposal)],
        ));
        await harness.mutatePublishedDependency(proposal, driftCase);
        const drifted = await harness.snapshot();
        await expect(harness.port.applyInbox(roundTrip(approval))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        expect(await harness.snapshot()).toEqual(drifted);
        await expect(harness.port.getInboxProposal(proposal.ref.id)).resolves.toMatchObject({
          state: "pending",
        });

        const markPreview = await harness.port.previewInbox(command(
          `inbox_contract_mark_stale_${driftCase}`,
          {
            kind: "inbox.mark-stale",
            proposalId: proposal.ref.id,
            rationale: `The exact ${driftCase} changed after publication.`,
          },
          [proposalExpectation(proposal)],
        ));
        expectPurposes(markPreview, ["activity"]);
        const marked = await harness.port.applyInbox(roundTrip(markPreview));
        expectCanonicalActivity(
          marked,
          markPreview,
          "inbox.marked-stale",
          [proposal.ref],
        );
        const stale = await requiredProposal(harness.port, proposal.ref.id);
        expect(stale.state).toBe("stale");

        const replacement = await harness.refreshDraftInput(input);
        const repairPreview = await harness.port.previewInbox(command(
          `inbox_contract_repair_${driftCase}`,
          { kind: "inbox.repair", proposalId: stale.ref.id, replacement },
          [proposalExpectation(stale)],
        ));
        expectPurposes(repairPreview, ["activity"]);
        const repaired = await harness.port.applyInbox(roundTrip(repairPreview));
        expectCanonicalActivity(
          repaired,
          repairPreview,
          "inbox.repaired",
          [proposal.ref],
        );
        const repairedProposal = await harness.port.getInboxProposal(stale.ref.id);
        expect(repairedProposal).toMatchObject({
          state: "pending",
          change: replacement.change,
        });
        expect(repairedProposal).not.toHaveProperty("reviewer");
        expect(repairedProposal).not.toHaveProperty("reviewedAt");
      });
    });

    it("rejects Team-owned duplicate Spec claimants during publish and repair without effects", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDraftInput("spec.update", "spec");
        if (input.change.kind !== "spec.update") throw new Error("Expected an update fixture.");
        const draft = await saveDraft(
          harness.port,
          input,
          "inbox_contract_duplicate_claimant_publish_save",
        );
        await harness.installTeamOwnedDuplicateClaimant(input.change.target.id);
        const before = await harness.snapshot();
        await expect(harness.port.previewInbox(command(
          "inbox_contract_duplicate_claimant_publish",
          { kind: "inbox.publish", draftId: draft.id },
          [draftExpectation(draft)],
        ))).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
        expect(await harness.snapshot()).toEqual(before);
      });

      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDriftInput("update-target");
        if (input.change.kind !== "spec.update") throw new Error("Expected an update fixture.");
        const proposal = await createPendingProposal(
          harness.port,
          input,
          "inbox_contract_duplicate_claimant_repair",
        );
        await harness.mutatePublishedDependency(proposal, "update-target");
        const markPreview = await harness.port.previewInbox(command(
          "inbox_contract_duplicate_claimant_mark_stale",
          {
            kind: "inbox.mark-stale",
            proposalId: proposal.ref.id,
            rationale: "The exact update target changed after publication.",
          },
          [proposalExpectation(proposal)],
        ));
        await harness.port.applyInbox(roundTrip(markPreview));
        const stale = await requiredProposal(harness.port, proposal.ref.id);
        const replacement = await harness.refreshDraftInput(input);
        await harness.installTeamOwnedDuplicateClaimant(input.change.target.id);
        const before = await harness.snapshot();
        await expect(harness.port.previewInbox(command(
          "inbox_contract_duplicate_claimant_repair_preview",
          { kind: "inbox.repair", proposalId: stale.ref.id, replacement },
          [proposalExpectation(stale)],
        ))).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("re-attests create dependencies in the final publication window", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDriftInput("relation-endpoint");
        if (input.change.kind !== "spec.create" || input.change.relation === undefined) {
          throw new Error("Expected a related create fixture.");
        }
        const proposal = await createPendingProposal(
          harness.port,
          input,
          "inbox_contract_final_dependency_attestation",
        );
        const approval = await harness.port.previewInbox(command(
          "inbox_contract_final_dependency_attestation_approve",
          { kind: "inbox.approve", proposalId: proposal.ref.id },
          [proposalExpectation(proposal)],
        ));
        const before = await harness.snapshot();
        await harness.armDependencyDriftBeforePublication(
          input.change.relation.target.id,
        );
        await expect(harness.port.applyInbox(roundTrip(approval))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        const after = await harness.snapshot();
        expect(after.proposalIds).toEqual(before.proposalIds);
        expect(after.specIds).toEqual(before.specIds);
        expect(after.activityIds).toEqual(before.activityIds);
        expect(after.wikiAuditOperationIds).toEqual(before.wikiAuditOperationIds);
        await expect(harness.port.getInboxProposal(proposal.ref.id)).resolves.toMatchObject({
          state: "pending",
        });
      });
    });

    it("re-attests the proposal artifact before Wiki publication", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const proposal = await createPendingProposal(
          harness.port,
          await harness.makeDraftInput("spec.update", "spec"),
          "inbox_contract_final_proposal_attestation",
        );
        const approval = await harness.port.previewInbox(command(
          "inbox_contract_final_proposal_attestation_approve",
          { kind: "inbox.approve", proposalId: proposal.ref.id },
          [proposalExpectation(proposal)],
        ));
        const before = await harness.snapshot();
        await harness.armProposalDriftBeforePublication(proposal);
        await expect(harness.port.applyInbox(roundTrip(approval))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        const after = await harness.snapshot();
        expect(after.specIds).toEqual(before.specIds);
        expect(after.activityIds).toEqual(before.activityIds);
        expect(after.wikiAuditOperationIds).toEqual(before.wikiAuditOperationIds);
      });
    });

    it("re-attests publish dependencies in the final publication window", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDriftInput("relation-endpoint");
        if (input.change.kind !== "spec.create" || input.change.relation === undefined) {
          throw new Error("Expected a related create fixture.");
        }
        const draft = await saveDraft(
          harness.port,
          input,
          "inbox_contract_final_publish_dependency_save",
        );
        const publication = await harness.port.previewInbox(command(
          "inbox_contract_final_publish_dependency",
          { kind: "inbox.publish", draftId: draft.id },
          [draftExpectation(draft)],
        ));
        const before = await harness.snapshot();
        await harness.armDependencyDriftBeforePublication(
          input.change.relation.target.id,
        );
        await expect(harness.port.applyInbox(roundTrip(publication))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        const after = await harness.snapshot();
        expect(after.proposalIds).toEqual(before.proposalIds);
        expect(after.activityIds).toEqual(before.activityIds);
        expect(after.draftIds).toEqual(before.draftIds);
      });
    });

    it("re-proves drift before publishing the mark-stale transition", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const input = await harness.makeDriftInput("update-target");
        if (input.change.kind !== "spec.update") throw new Error("Expected an update fixture.");
        const proposal = await createPendingProposal(
          harness.port,
          input,
          "inbox_contract_final_mark_stale_dependency",
        );
        await harness.mutatePublishedDependency(proposal, "update-target");
        const markPreview = await harness.port.previewInbox(command(
          "inbox_contract_final_mark_stale_dependency_apply",
          {
            kind: "inbox.mark-stale",
            proposalId: proposal.ref.id,
            rationale: "The exact update target changed after publication.",
          },
          [proposalExpectation(proposal)],
        ));
        const before = await harness.snapshot();
        await harness.armDependencyRestoreBeforePublication(input.change.target.id);
        await expect(harness.port.applyInbox(roundTrip(markPreview))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        const after = await harness.snapshot();
        expect(after.activityIds).toEqual(before.activityIds);
        await expect(harness.port.getInboxProposal(proposal.ref.id)).resolves.toMatchObject({
          state: "pending",
        });
      });
    });

    it.each(["approved", "rejected", "withdrawn"] as const)("makes %s proposals terminal", async (terminal) => {
      await withHarness(factory, "empty", async (harness) => {
        const proposal = await createPendingProposal(
          harness.port,
          await harness.makeDraftInput(
            terminal === "approved" ? "spec.update" : "spec.create",
            "spec",
          ),
          `inbox_contract_terminal_${terminal}`,
        );
        const action: TeamInboxSpecAction = terminal === "approved"
          ? { kind: "inbox.approve", proposalId: proposal.ref.id }
          : terminal === "rejected"
            ? {
                kind: "inbox.reject",
                proposalId: proposal.ref.id,
                rationale: "The proposal does not meet the reviewed requirement.",
              }
            : {
                kind: "inbox.withdraw",
                proposalId: proposal.ref.id,
                rationale: "The author is replacing this proposal.",
              };
        const terminalPreview = await harness.port.previewInbox(command(
          `inbox_contract_terminal_${terminal}_apply`,
          action,
          [proposalExpectation(proposal)],
        ));
        expectPurposes(terminalPreview, ["activity"]);
        const terminalResult = await harness.port.applyInbox(roundTrip(terminalPreview));
        const terminalSubjects = (() => {
          if (terminal !== "approved") return [proposal.ref];
          if (proposal.change.kind !== "spec.update") {
            throw new Error("Expected the terminal approval fixture to update one Spec.");
          }
          return [proposal.ref, proposal.change.target];
        })();
        expectCanonicalActivity(
          terminalResult,
          terminalPreview,
          `inbox.${terminal}`,
          terminalSubjects,
        );
        const stored = await requiredProposal(harness.port, proposal.ref.id);
        expect(stored.state).toBe(terminal);
        const before = await harness.snapshot();
        await expect(harness.port.previewInbox(command(
          `inbox_contract_terminal_${terminal}_reuse`,
          {
            kind: "inbox.mark-stale",
            proposalId: stored.ref.id,
            rationale: "Terminal records cannot be reopened.",
          },
          [proposalExpectation(stored)],
        ))).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("rejects envelope tampering, expiry, and authority drift before any effect", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const draft = await saveDraft(
          harness.port,
          await harness.makeDraftInput("spec.create", "spec"),
          "inbox_contract_tamper_save",
        );
        const envelope = await harness.port.previewInbox(command(
          "inbox_contract_tamper_publish",
          { kind: "inbox.publish", draftId: draft.id },
          [draftExpectation(draft)],
        ));
        const prepared = await harness.snapshot();
        for (const tamper of [
          tamperEnvelope(envelope, (value) => { value.request.operationId += "_changed"; }),
          tamperEnvelope(envelope, (value) => { value.preview.scope = "canonical"; }),
          tamperEnvelope(envelope, (value) => { value.receipt.authority.occurredAt = "2026-01-01T00:00:00.000Z"; }),
          tamperEnvelope(envelope, (value) => { value.receipt.purposeIds[0]!.id += "X"; }),
          tamperEnvelope(envelope, (value) => { value.receipt.previewRevision = differentRevision(value.receipt.previewRevision); }),
          tamperEnvelope(envelope, (value) => {
            Object.defineProperty(value, "__proto__", {
              value: { unbound: true },
              enumerable: true,
            });
          }),
          tamperEnvelope(envelope, (value) => {
            Object.defineProperty(value.receipt.authority, "__proto__", {
              value: { nested: "unbound" },
              enumerable: true,
            });
          }),
          tamperEnvelope(envelope, (value) => {
            Object.defineProperty(value.preview, "__proto__", {
              value: "x".repeat((64 * 1024) + 1),
              enumerable: true,
            });
          }),
        ]) {
          await expectProblemCode(
            applyUnknown(harness.port, tamper),
            ["VALIDATION_FAILED", "REVISION_CONFLICT"],
          );
          expect(await harness.snapshot()).toEqual(prepared);
        }

        harness.setNow(addMinutes(envelope.receipt.authority.occurredAt, 31));
        await expect(harness.port.applyInbox(roundTrip(envelope))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        expect(await harness.snapshot()).toEqual(prepared);
      });

      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.port.previewInbox(command(
          "inbox_contract_authority_drift",
          {
            kind: "inbox.draft.save",
            draft: await harness.makeDraftInput("spec.create", "spec"),
          },
        ));
        await harness.mutateRepositoryAuthority();
        const drifted = await harness.snapshot();
        await expect(harness.port.applyInbox(roundTrip(envelope))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        expect(await harness.snapshot()).toEqual(drifted);
      });
    });

    it("replays an exact signed envelope after restart and signer loss", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.port.previewInbox(command(
          "inbox_contract_replay",
          {
            kind: "inbox.draft.save",
            draft: await harness.makeDraftInput("spec.create", "spec"),
          },
        ));
        const first = await harness.port.applyInbox(roundTrip(envelope));
        const after = await harness.snapshot();
        await harness.removeSigner();
        const restarted = await harness.restart();
        const replay = await restarted.applyInbox(roundTrip(envelope));
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.operationId).toBe(first.operationId);
        expect(replay.previewRevision).toBe(first.previewRevision);
        expect(await harness.snapshot()).toMatchObject({
          canonicalDigest: after.canonicalDigest,
          wikiDigest: after.wikiDigest,
          draftIds: after.draftIds,
          proposalIds: after.proposalIds,
          specIds: after.specIds,
          activityIds: after.activityIds,
        });
      });
    });

    it("requires re-preview when the signer is lost before journal intent", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.port.previewInbox(command(
          "inbox_contract_signer_loss_before_intent",
          {
            kind: "inbox.draft.save",
            draft: await harness.makeDraftInput("spec.create", "spec"),
          },
        ));
        await harness.removeSigner();
        const afterLoss = await harness.snapshot();
        const restarted = await harness.restart();
        await expect(restarted.applyInbox(roundTrip(envelope))).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        expect(await harness.snapshot()).toEqual(afterLoss);
        const renewed = await restarted.previewInbox(envelope.request);
        expect(renewed.receipt.previewRevision).not.toBe(envelope.receipt.previewRevision);
      });
    });

    for (const phase of TEAM_INBOX_SPEC_RECOVERY_PHASES) {
      it(`recovers ${phase} exactly without duplicate canonical effects`, async () => {
        await withHarness(factory, "empty", async (harness) => {
          const envelope = await harness.prepareRecoveryEnvelope(phase);
          await harness.armCrash(phase);
          await expect(harness.port.applyInbox(roundTrip(envelope))).rejects.toMatchObject({
            problem: { code: "OPERATION_INTERRUPTED" },
          });
          const restarted = await harness.restart();
          const recovered = await restarted.applyInbox(roundTrip(envelope));
          expect(recovered.idempotentReplay).toBe(false);
          const replay = await restarted.applyInbox(roundTrip(envelope));
          expect(replay.idempotentReplay).toBe(true);
          const snapshot = await harness.snapshot();
          expect(unique(snapshot.activityIds)).toEqual(snapshot.activityIds);
          expect(unique(snapshot.wikiAuditOperationIds))
            .toEqual(snapshot.wikiAuditOperationIds);
          expect((await harness.inspectJournal()).incompleteCount).toBe(0);
        });
      });
    }

    it("keeps recovery metadata bounded and free of prose, diffs, paths, and secrets", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.prepareRecoveryEnvelope("approve.after-wiki");
        await harness.port.applyInbox(roundTrip(envelope));
        const journal = await harness.inspectJournal();
        expect(journal.incompleteCount).toBe(0);
        expect(journal.durableStorageForbiddenMatches).toEqual([]);
        for (const row of journal.rows) {
          expect(row.effectCount).toBeLessThanOrEqual(16);
          expect(row.effectJsonBytes).toBeLessThanOrEqual(64 * 1024);
          for (const sentinel of harness.oracle.privacySentinels) {
            expect(row.serializedRow).not.toContain(sentinel);
          }
          expect(row.serializedEffects).not.toMatch(
            /(?:diff|handle|sourceBody|prompt|transcript|credential|password|secret)/iu,
          );
          expect(row.serializedRow).not.toMatch(/(?:^|["'])\/(?:Users|home|private|tmp)\//u);
        }
      });
    });

    it.each(["local", "proposal", "activity", "spec"] as const)(
      "fails closed across the %s containment boundary",
      async (target) => {
        await withHarness(factory, "empty", async (harness) => {
          const envelope = await harness.prepareContainmentEnvelope(target);
          await harness.installEscapingAncestor(target);
          const before = await harness.snapshot();
          await expect(harness.port.applyInbox(roundTrip(envelope))).rejects.toMatchObject({
            problem: { code: "PATH_OUTSIDE_PROJECT" },
          });
          expect((await harness.snapshot()).outsideDigest).toBe(before.outsideDigest);
        });
      },
    );

    it("fails closed after a project root swap", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.port.previewInbox(command(
          "inbox_contract_root_swap",
          {
            kind: "inbox.draft.save",
            draft: await harness.makeDraftInput("spec.create", "spec"),
          },
        ));
        await harness.swapProjectRoot();
        const before = await harness.snapshot();
        await expectProblemCode(
          harness.port.applyInbox(roundTrip(envelope)),
          ["PATH_OUTSIDE_PROJECT", "REVISION_CONFLICT"],
        );
        expect((await harness.snapshot()).outsideDigest).toBe(before.outsideDigest);
      });
    });

    it("publishes in one clone and approves in another while local state stays clone-local", async () => {
      const clones = await factory.openTwoClone();
      try {
        const leftInput = await clones.left.makeDraftInput("spec.create", "spec");
        const proposal = await createPendingProposal(
          clones.left.port,
          leftInput,
          "inbox_contract_clone",
        );
        const leftAfterPublish = await clones.left.snapshot();
        const rightBeforePublishSync = await clones.right.snapshot();

        await clones.synchronizeCanonical();
        const rightProposal = await clones.right.port.getInboxProposal(proposal.ref.id);
        expect(rightProposal).toMatchObject({ state: "pending" });
        const rightAfterPublishSync = await clones.right.snapshot();
        expect(rightAfterPublishSync.draftIds).toEqual(rightBeforePublishSync.draftIds);
        expect(rightAfterPublishSync.localStateDigest)
          .toBe(rightBeforePublishSync.localStateDigest);
        expect(rightAfterPublishSync.signerDigest).toBe(rightBeforePublishSync.signerDigest);

        const approval = await clones.right.port.previewInbox(command(
          "inbox_contract_clone_approve",
          { kind: "inbox.approve", proposalId: proposal.ref.id },
          [proposalExpectation(expectDefined(rightProposal))],
        ));
        const specId = purposeId(approval, "spec-entity");
        await clones.right.port.applyInbox(roundTrip(approval));
        const rightAfterApproval = await clones.right.snapshot();

        await clones.synchronizeCanonical();
        await expect(clones.left.port.getInboxProposal(proposal.ref.id)).resolves.toMatchObject({
          state: "approved",
        });
        await expect(clones.left.readSpec(specId)).resolves.toMatchObject({
          ref: { id: specId, kind: "spec" },
        });
        const leftAfterApprovalSync = await clones.left.snapshot();
        expect(leftAfterApprovalSync.localStateDigest).toBe(leftAfterPublish.localStateDigest);
        expect(leftAfterApprovalSync.signerDigest).toBe(leftAfterPublish.signerDigest);
        expect(rightAfterApproval.proposalIds).toContain(proposal.ref.id);
        expect(rightAfterApproval.specIds).toContain(specId);
        expect(leftAfterApprovalSync.modelInvocations + rightAfterApproval.modelInvocations).toBe(0);
        expect(leftAfterApprovalSync.outboundRequests + rightAfterApproval.outboundRequests).toBe(0);
      } finally {
        await clones.close();
      }
    });
  });
}

/**
 * Checkpoint E2's direct-Wiki bypass contract. E1 deliberately leaves this
 * exported but unregistered until the product Wiki CLI/apply boundary owns the
 * corresponding enforcement.
 */
export function defineTeamInboxDirectWikiSpecBypassContract(
  adapterName: string,
  factory: TeamInboxDirectWikiSpecContractFactory,
): void {
  describe(`${adapterName} direct Wiki Spec bypass contract`, () => {
    it("refuses every direct Wiki propose/apply escape", async () => {
      await withHarness(factory, "empty", async (harness) => {
        for (const surface of ["wiki-apply", "wiki-propose"] as const) {
          for (const bypass of [
            "create",
            "existing-target",
            "relation-endpoint",
            "type-conversion-into",
            "type-conversion-out-of",
            "supersede-existing-replacement",
            "supersede-inline-replacement",
            "supersede-inline-relation-endpoint",
            "spec-path",
            "hidden-batch",
          ] as const) {
            await expect(
              harness.attemptDirectWikiSpecMutation(surface, bypass),
            ).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
          }
        }
      });
    });
  });
}

function command(
  operationId: string,
  action: TeamInboxSpecAction,
  expectedRevisions: readonly RevisionExpectation[] = [],
): TeamInboxSpecCommand {
  return { operationId, action, expectedRevisions };
}

function draftExpectation(draft: TeamInboxSpecDraftDetail): RevisionExpectation {
  return {
    target: { kind: "local", namespace: "inbox-draft", id: draft.id },
    revision: draft.revision,
  };
}

function proposalExpectation(
  proposal: TeamInboxSpecProposalDetail,
): RevisionExpectation {
  return {
    target: { kind: "artifact", path: proposal.sourcePath },
    revision: proposal.revision,
  };
}

async function saveDraft(
  port: TeamInboxSpecAuthoringContractPort,
  input: TeamInboxSpecDraftInput,
  operationId: string,
): Promise<TeamInboxSpecDraftDetail> {
  const envelope = await port.previewInbox(command(
    operationId,
    { kind: "inbox.draft.save", draft: input },
  ));
  const id = purposeId(envelope, "inbox-draft");
  await port.applyInbox(roundTrip(envelope));
  const draft = await port.getInboxDraft(id);
  if (draft === null) throw new Error("Expected the saved Inbox draft.");
  return draft;
}

async function createPendingProposal(
  port: TeamInboxSpecAuthoringContractPort,
  input: TeamInboxSpecDraftInput,
  operationPrefix: string,
): Promise<TeamInboxSpecProposalDetail> {
  const draft = await saveDraft(port, input, `${operationPrefix}_save`);
  const publish = await port.previewInbox(command(
    `${operationPrefix}_publish`,
    { kind: "inbox.publish", draftId: draft.id },
    [draftExpectation(draft)],
  ));
  const proposalId = purposeId(publish, "proposal");
  await port.applyInbox(roundTrip(publish));
  return requiredProposal(port, proposalId);
}

async function requiredProposal(
  port: TeamInboxSpecAuthoringContractPort,
  id: string,
): Promise<TeamInboxSpecProposalDetail> {
  const proposal = await port.getInboxProposal(id);
  if (proposal === null) throw new Error("Expected the Inbox proposal.");
  return proposal;
}

function purposeId(
  envelope: TeamInboxSpecPreviewEnvelope,
  purpose: TeamInboxSpecPurposeId["purpose"],
): string {
  const matched = envelope.receipt.purposeIds.find((entry) => entry.purpose === purpose);
  if (matched === undefined) throw new Error(`Missing ${purpose} purpose ID.`);
  return matched.id;
}

function expectPurposes(
  envelope: TeamInboxSpecPreviewEnvelope,
  expected: readonly TeamInboxSpecPurposeId["purpose"][],
): void {
  const purposeIds = envelope.receipt.purposeIds;
  expect(purposeIds.length).toBeLessThanOrEqual(2);
  expect(new Set(purposeIds.map((entry) => entry.purpose)).size).toBe(purposeIds.length);
  expect(new Set(purposeIds.map((entry) => entry.id)).size).toBe(purposeIds.length);
  expect(purposeIds).toEqual([...purposeIds].sort(comparePurposeIds));
  expect(purposeIds.map((entry) => entry.purpose).sort(compareCodePoints))
    .toEqual([...expected].sort(compareCodePoints));
  expect(jsonBytes(envelope)).toBeLessThanOrEqual(64 * 1024);
  expect(jsonBytes(envelope.receipt)).toBeLessThanOrEqual(8 * 1024);
  const receiptShape = jsonShape(envelope.receipt);
  expect(receiptShape.depth).toBeLessThanOrEqual(8);
  expect(receiptShape.nodes).toBeLessThanOrEqual(128);
}

function comparePurposeIds(
  left: TeamInboxSpecPurposeId,
  right: TeamInboxSpecPurposeId,
): number {
  return compareCodePoints(`${left.purpose}\0${left.id}`, `${right.purpose}\0${right.id}`);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

function expectValidCreateCase(
  input: TeamInboxSpecDraftInput,
  validCase: TeamInboxValidCreateCase,
): void {
  if (input.change.kind !== "spec.create") throw new Error("Expected a create fixture.");
  const change = input.change;
  switch (validCase) {
    case "in-flight":
      expect(change).toMatchObject({ status: "in_flight" });
      expect(change).not.toHaveProperty("relation");
      return;
    case "promoted-with-topics":
      expect(change).toMatchObject({ status: "promoted" });
      expect(change.topics?.length).toBeGreaterThan(0);
      expect(change.topics?.length).toBeLessThanOrEqual(64);
      return;
    case "spec-constrained-by":
      expectCreateRelation(change, "spec", "constrained_by", "constraint");
      return;
    case "requirement-derived-from":
      expectCreateRelation(change, "requirement", "derived_from", "spec");
      return;
    case "requirement-refines":
      expectCreateRelation(change, "requirement", "refines", "requirement");
      return;
    case "requirement-constrained-by":
      expectCreateRelation(change, "requirement", "constrained_by", "constraint");
      return;
    case "constraint-constrained-by":
      expectCreateRelation(change, "constraint", "constrained_by", "constraint");
      return;
    case "acceptance-verified-by-requirement":
      expectCreateRelation(change, "acceptance_criterion", "verified_by", "requirement");
      return;
    case "acceptance-verified-by-spec":
      expectCreateRelation(change, "acceptance_criterion", "verified_by", "spec");
      return;
    case "acceptance-constrained-by":
      expectCreateRelation(change, "acceptance_criterion", "constrained_by", "constraint");
  }
}

function expectCreateRelation(
  change: TeamInboxSpecCreateChange,
  sourceKind: TeamInboxSpecKind,
  relationType: "derived_from" | "verified_by" | "constrained_by" | "refines",
  targetKind: TeamInboxSpecKind,
): void {
  expect(change).toMatchObject({
    entityKind: sourceKind,
    relation: { type: relationType, target: { kind: targetKind } },
  });
}

function expectCreateDependenciesCovered(input: TeamInboxSpecDraftInput): void {
  if (input.change.kind !== "spec.create") throw new Error("Expected a create fixture.");
  const dependencyIds = [
    ...(input.change.topics ?? []),
    ...(input.change.relation === undefined ? [] : [input.change.relation.target.id]),
  ];
  for (const id of dependencyIds) {
    const expectation = input.targetRevisions.find((candidate) => (
      candidate.target.kind === "entity" && candidate.target.id === id
    ));
    expect(expectation).toBeDefined();
    expect(expectation?.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(expectation?.semanticRevision).toBeTypeOf("number");
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function jsonShape(value: unknown): { depth: number; nodes: number } {
  if (value === null || typeof value !== "object") return { depth: 1, nodes: 1 };
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  let depth = 1;
  let nodes = 1;
  for (const child of children) {
    const shape = jsonShape(child);
    depth = Math.max(depth, 1 + shape.depth);
    nodes += shape.nodes;
  }
  return { depth, nodes };
}

function expectCanonicalActivity(
  result: TeamInboxSpecApplyResult,
  envelope: TeamInboxSpecPreviewEnvelope,
  action: string,
  expected: readonly EntityRef[],
): void {
  expect(result.events).toHaveLength(1);
  const event = result.events[0]!;
  expect(event.id).toBe(purposeId(envelope, "activity"));
  expect(event.action).toBe(action);
  expect(event).toMatchObject({
    schemaVersion: 2,
    origin: { kind: "workflow", operation: inboxOperationForAction(action) },
    label: expect.any(String),
  });
  const actual = event.subjects.map((subject) => {
    expect(subject.kind).toBe("entity");
    if (subject.kind !== "entity") throw new Error("Expected only entity subjects.");
    return { id: subject.entity.id, kind: subject.entity.kind };
  }).sort(compareRefs);
  expect(actual).toEqual(expected.map(({ id, kind }) => ({ id, kind })).sort(compareRefs));
}

function inboxOperationForAction(action: string): string {
  switch (action) {
    case "inbox.published": return "inbox.publish";
    case "inbox.approved": return "inbox.approve";
    case "inbox.rejected": return "inbox.reject";
    case "inbox.withdrawn": return "inbox.withdraw";
    case "inbox.marked-stale": return "inbox.mark-stale";
    case "inbox.repaired": return "inbox.repair";
    default: throw new Error(`Unexpected Inbox Activity action ${action}.`);
  }
}

function compareRefs(
  left: Pick<EntityRef, "id" | "kind">,
  right: Pick<EntityRef, "id" | "kind">,
): number {
  return compareCodePoints(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`);
}

function tamperEnvelope(
  envelope: TeamInboxSpecPreviewEnvelope,
  mutate: (value: MutableEnvelope) => void,
): unknown {
  const value = roundTrip(envelope) as MutableEnvelope;
  mutate(value);
  return value;
}

type MutableEnvelope = {
  -readonly [TKey in keyof TeamInboxSpecPreviewEnvelope]: Mutable<
    TeamInboxSpecPreviewEnvelope[TKey]
  >;
};

type Mutable<T> = T extends readonly (infer TItem)[]
  ? Mutable<TItem>[]
  : T extends object
    ? { -readonly [TKey in keyof T]: Mutable<T[TKey]> }
    : T;

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function differentRevision(revision: Revision): Revision {
  return `${revision[0] === "0" ? "1" : "0"}${revision.slice(1)}` as Revision;
}

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + (minutes * 60_000)).toISOString();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function expectRevision(value: string): void {
  expect(value).toMatch(/^[a-f0-9]{64}$/u);
}

async function previewUnknown(
  port: TeamInboxSpecAuthoringContractPort,
  value: unknown,
): Promise<TeamInboxSpecPreviewEnvelope> {
  return port.previewInbox(value as TeamInboxSpecCommand);
}

async function applyUnknown(
  port: TeamInboxSpecAuthoringContractPort,
  value: unknown,
): Promise<TeamInboxSpecApplyResult> {
  return port.applyInbox(value as TeamInboxSpecPreviewEnvelope);
}

async function expectProblemCode(
  promise: Promise<unknown>,
  codes: readonly string[],
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected the operation to be refused.");
  } catch (error) {
    if (error instanceof Error && error.message === "Expected the operation to be refused.") {
      throw error;
    }
    expect(error).toMatchObject({ problem: { code: expect.stringMatching(
      new RegExp(`^(?:${codes.join("|")})$`, "u"),
    ) } });
  }
}

async function withHarness<THarness extends TeamInboxSpecContractHarness>(
  factory: { open(scenario: TeamInboxSpecScenario): Promise<THarness> },
  scenario: TeamInboxSpecScenario,
  run: (harness: THarness) => Promise<void>,
): Promise<void> {
  const harness = await factory.open(scenario);
  try {
    expect(harness.fixture).toEqual({
      filesystem: "real",
      localState: "real",
      git: "real",
      wiki: "real-adapter",
    });
    await run(harness);
    const snapshot = await harness.snapshot();
    expect(snapshot.modelInvocations).toBe(0);
    expect(snapshot.outboundRequests).toBe(0);
  } finally {
    await harness.close();
  }
}

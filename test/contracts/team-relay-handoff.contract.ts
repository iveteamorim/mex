import { describe, expect, it } from "vitest";
import type {
  ActorRef,
  RepoState,
  Revision,
} from "../../src/team/contracts/shared.js";
import type {
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayHandoffPort,
  TeamRelayPreviewEnvelope,
} from "../../src/team/contracts/workflow.js";

export const TEAM_RELAY_RECOVERY_PHASES = [
  "publish.after-relay",
  "publish.after-activity",
  "publish.after-cleanup",
  "acknowledge.after-relay",
  "acknowledge.after-activity",
  "close.after-relay",
  "close.after-activity",
] as const;

export type TeamRelayRecoveryPhase =
  (typeof TEAM_RELAY_RECOVERY_PHASES)[number];
export type TeamRelayScenario =
  | "empty"
  | "populated"
  | "uninitialized-local"
  | "no-current-member"
  | "legacy-local-draft"
  | "legacy-v1"
  | "legacy-v2"
  | "query";

export interface TeamRelaySnapshot {
  canonicalDigest: Revision;
  localStateDigest: Revision | null;
  signerDigest: Revision | null;
  gitHead: string | null;
  relayIds: readonly string[];
  draftIds: readonly string[];
  activityIds: readonly string[];
  outsideDigest: Revision;
  outboundRequests: number;
  modelInvocations: number;
}

export interface TeamRelayContractHarness {
  port: TeamRelayHandoffPort;
  oracle: {
    now: string;
    actor: ActorRef;
    sender: ActorRef;
    recipient: ActorRef;
    alternateRecipient: ActorRef;
    repoState: RepoState;
    populatedDraft: TeamRelayDraftDetail | null;
    populatedRelay: TeamRelayDetail | null;
  };
  makeDraftCommand(operationId: string): Promise<TeamRelayCommand>;
  preparePreV3PublishEnvelope(
    operationId: string,
    journalIntent: boolean,
  ): Promise<TeamRelayPreviewEnvelope>;
  commandFor(
    kind: "relay.publish" | "relay.acknowledge" | "relay.close",
    target: TeamRelayDraftDetail | TeamRelayDetail,
    operationId: string,
  ): Promise<TeamRelayCommand>;
  selectActor(
    actor: "sender" | "recipient" | "alternate-recipient" | "none",
  ): Promise<TeamRelayHandoffPort>;
  restart(): Promise<TeamRelayHandoffPort>;
  removeSigner(): Promise<void>;
  armCrash(phase: TeamRelayRecoveryPhase): Promise<void>;
  armBeforeCanonicalCrash(): Promise<void>;
  armBeforeCanonicalRecipientDeactivation(): Promise<void>;
  setNow(now: string): void;
  setRepositoryState(state: RepoState): void;
  mutateRepositoryAuthority(): void;
  mutateDraftToMissingRecipient(draftId: string): Promise<void>;
  deleteMember(
    member: "sender" | "recipient" | "alternate-recipient",
  ): Promise<void>;
  setMemberActive(
    member: "sender" | "recipient" | "alternate-recipient",
    active: boolean,
  ): Promise<void>;
  renameMember(
    member: "sender" | "recipient" | "alternate-recipient",
    displayName: string,
  ): Promise<void>;
  holdCompetingWorkflowLease(): Promise<void>;
  releaseCompetingWorkflowLease(): Promise<void>;
  installEscapingAncestor(
    target: "local" | "relay" | "activity",
  ): Promise<void>;
  swapProjectRoot(): Promise<void>;
  inspectJournalRows(): Promise<readonly string[]>;
  inspectStoredDraft(id: string): Promise<{
    payload: unknown;
    revision: Revision;
    updatedAt: string;
  } | null>;
  snapshot(): Promise<TeamRelaySnapshot>;
  close(): Promise<void>;
}

export interface TeamRelayContractFactory {
  open(scenario: TeamRelayScenario): Promise<TeamRelayContractHarness>;
}

/** F0's consumer-owned scaffold, registered against the real repository adapter by F1. */
export function defineTeamRelayHandoffContract(
  adapterName: string,
  factory: TeamRelayContractFactory,
): void {
  describe(`${adapterName} Relay handoff contract`, () => {
    it("keeps ordinary draft and Relay reads noninitializing", async () => {
      await withHarness(factory, "uninitialized-local", async (harness) => {
        const before = await harness.snapshot();
        expect(before.localStateDigest).toBeNull();
        await expect(harness.port.getRelayDraft("relay_missing")).resolves.toBeNull();
        await expect(harness.port.getRelay("relay_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
          .resolves.toBeNull();
        await expect(harness.port.listRelayDrafts()).resolves.toMatchObject({ items: [] });
        await expect(harness.port.listRelays()).resolves.toMatchObject({ items: [] });
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("translates a legacy Workstream draft on reads without rewriting SQLite identity", async () => {
      await withHarness(factory, "legacy-local-draft", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const storedBefore = await harness.inspectStoredDraft(draft.id);
        expect(storedBefore).toMatchObject({
          revision: draft.revision,
          updatedAt: draft.updatedAt,
          payload: {
            workstream: expect.objectContaining({ kind: "workstream" }),
          },
        });
        const beforeReads = await harness.snapshot();

        const detail = await harness.port.getRelayDraft(draft.id);
        const page = await harness.port.listRelayDrafts();
        expect(detail).toMatchObject({
          revision: storedBefore!.revision,
          updatedAt: storedBefore!.updatedAt,
          input: {
            evidence: [
              expect.objectContaining({
                kind: "entity",
                entity: expect.objectContaining({ kind: "workstream" }),
              }),
              expect.objectContaining({ kind: "manual" }),
            ],
          },
        });
        expect(detail?.input).not.toHaveProperty("workstream");
        expect(page.items).toEqual([
          expect.objectContaining({
            id: draft.id,
            revision: storedBefore!.revision,
            updatedAt: storedBefore!.updatedAt,
          }),
        ]);
        expect(await harness.inspectStoredDraft(draft.id)).toEqual(storedBefore);
        expect(await harness.snapshot()).toEqual(beforeReads);

        const saved = await harness.port.applyRelay(
          await harness.port.previewRelay({
            operationId: "relay_contract_explicit_legacy_draft_save",
            action: {
              kind: "relay.draft.save",
              draftId: draft.id,
              draft: detail!.input,
            },
            expectedRevisions: [{
              target: {
                kind: "local",
                namespace: "relay-draft",
                id: draft.id,
              },
              revision: draft.revision,
            }],
          }),
        );
        expect(saved.localChanges).toHaveLength(1);
        const storedAfter = await harness.inspectStoredDraft(draft.id);
        expect(storedAfter?.payload).not.toHaveProperty("workstream");
        expect(storedAfter?.revision).not.toBe(storedBefore!.revision);
        expect(storedAfter?.updatedAt).not.toBe(storedBefore!.updatedAt);
      });
    });

    it("saves a local draft without canonical authority and signs only exact apply", async () => {
      await withHarness(factory, "no-current-member", async (harness) => {
        const request = await harness.makeDraftCommand("relay_contract_draft_save");
        const preview = await harness.port.previewRelay(request);
        expect(preview.preview.scope).toBe("local");
        expect(preview.receipt.purposeIds).toHaveLength(1);
        expect(preview.receipt.purposeIds[0]?.purpose).toBe("relay-draft");
        const result = await harness.port.applyRelay(preview);
        expect(result.localChanges).toHaveLength(1);
        expect(result.relays).toEqual([]);
        expect(result.events).toEqual([]);

        const altered = structuredClone(preview);
        altered.request.operationId = "relay_contract_altered";
        await expect(harness.port.applyRelay(altered)).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
      });
    });

    it("updates and deletes an offline draft with exact optimistic revisions", async () => {
      await withHarness(factory, "no-current-member", async (harness) => {
        const canonicalBefore = (await harness.snapshot()).canonicalDigest;
        const create = await harness.port.previewRelay(
          await harness.makeDraftCommand("relay_contract_offline_create"),
        );
        const draftId = create.receipt.purposeIds[0]!.id;
        await harness.port.applyRelay(create);
        const initial = await harness.port.getRelayDraft(draftId);
        if (initial === null) throw new Error("Expected offline Relay draft.");
        const updateCommand: TeamRelayCommand = {
          operationId: "relay_contract_offline_update",
          action: {
            kind: "relay.draft.save",
            draftId,
            draft: { ...initial.input, summary: "Updated offline handoff" },
          },
          expectedRevisions: [{
            target: { kind: "local", namespace: "relay-draft", id: draftId },
            revision: initial.revision,
          }],
        };
        const update = await harness.port.previewRelay(updateCommand);
        const stale = await (await harness.restart()).previewRelay({
          ...updateCommand,
          operationId: "relay_contract_offline_stale_update",
          action: {
            kind: "relay.draft.save",
            draftId,
            draft: { ...initial.input, summary: "Stale offline handoff" },
          },
        });
        const staleDelete = await (await harness.restart()).previewRelay({
          operationId: "relay_contract_offline_stale_delete",
          action: { kind: "relay.draft.delete", draftId },
          expectedRevisions: [{
            target: { kind: "local", namespace: "relay-draft", id: draftId },
            revision: initial.revision,
          }],
        });
        await harness.port.applyRelay(update);
        const updated = await harness.port.getRelayDraft(draftId);
        expect(updated).toMatchObject({ summary: "Updated offline handoff" });
        const afterUpdate = await harness.snapshot();
        await expectProblemCode(
          (await harness.restart()).applyRelay(stale),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(afterUpdate);
        await expectProblemCode(
          (await harness.restart()).applyRelay(staleDelete),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(afterUpdate);
        const current = await harness.port.getRelayDraft(draftId);
        if (current === null) throw new Error("Expected updated offline Relay draft.");
        const deletion = await harness.port.previewRelay({
          operationId: "relay_contract_offline_delete",
          action: { kind: "relay.draft.delete", draftId },
          expectedRevisions: [{
            target: { kind: "local", namespace: "relay-draft", id: draftId },
            revision: current.revision,
          }],
        });
        expect(deletion.receipt.purposeIds).toEqual([]);
        await harness.port.applyRelay(deletion);
        await expect(harness.port.getRelayDraft(draftId)).resolves.toBeNull();
        expect((await harness.snapshot()).canonicalDigest).toBe(canonicalBefore);
      });
    });

    it("reports absent Relay draft and lifecycle targets before revision comparison", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const missingDraftId = "relay_contract_missing_target";
        const missingRelayId = "relay_01ARZ3NDEKTSV4RRFFQ69G5FAV";
        const missingRevision = "a".repeat(64) as Revision;
        const base = await harness.makeDraftCommand(
          "relay_contract_missing_update",
        );
        if (base.action.kind !== "relay.draft.save") {
          throw new Error("Relay harness returned a non-save draft command.");
        }
        const publishBase = await harness.commandFor(
          "relay.publish",
          requirePopulatedDraft(harness),
          "relay_contract_missing_publish",
        );
        const commands: readonly TeamRelayCommand[] = [
          {
            ...base,
            action: { ...base.action, draftId: missingDraftId },
            expectedRevisions: [{
              target: {
                kind: "local",
                namespace: "relay-draft",
                id: missingDraftId,
              },
              revision: missingRevision,
            }],
          },
          {
            operationId: "relay_contract_missing_delete",
            action: { kind: "relay.draft.delete", draftId: missingDraftId },
            expectedRevisions: [{
              target: {
                kind: "local",
                namespace: "relay-draft",
                id: missingDraftId,
              },
              revision: missingRevision,
            }],
          },
          {
            ...publishBase,
            action: { kind: "relay.publish", draftId: missingDraftId },
            expectedRevisions: publishBase.expectedRevisions.map((expectation) =>
              expectation.target.kind === "local"
                ? {
                    target: {
                      kind: "local" as const,
                      namespace: "relay-draft" as const,
                      id: missingDraftId,
                    },
                    revision: missingRevision,
                  }
                : expectation),
          },
          ...(["relay.acknowledge", "relay.close"] as const).map((kind) => ({
            operationId: `relay_contract_missing_${kind.replace("relay.", "")}`,
            action: { kind, relayId: missingRelayId },
            expectedRevisions: [{
              target: {
                kind: "artifact" as const,
                path: `.mex/relays/${missingRelayId}.md` as never,
              },
              revision: missingRevision,
            }],
          })),
        ];
        const before = await harness.snapshot();
        for (const command of commands) {
          await expectProblemCode(
            harness.port.previewRelay(command),
            ["NOT_FOUND"],
          );
          expect(await harness.snapshot()).toEqual(before);
        }
      });
    });

    it("publishes standalone provenance, then preserves it while lifecycle Activity records action-time state", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = harness.oracle.populatedDraft;
        if (draft === null) throw new Error("Relay fixture has no draft.");
        const publish = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_publish"),
        );
        expect(publish.receipt.purposeIds.map((item) => item.purpose))
          .toEqual(["activity", "relay"]);
        const published = await harness.port.applyRelay(publish);
        expect(published.relays).toHaveLength(1);
        expect(published.events).toHaveLength(1);
        expect(published.relays[0]?.publishedAt).toBe(harness.oracle.now);
        expect(published.relays[0]?.schemaVersion).toBe(3);
        expect(published.relays[0]?.workstream).toBeNull();
        expect(published.relays[0]?.publishedRepoState)
          .toEqual(publish.receipt.authority.repoState);
        expect(publish.receipt.purposeIds.find((item) => item.purpose === "relay")?.id)
          .toBe(published.relays[0]!.ref.id);
        expect(publish.receipt.purposeIds.find((item) => item.purpose === "activity")?.id)
          .toBe(published.events[0]!.id);
        expect(published.events[0]).toMatchObject({
          schemaVersion: 2,
          action: "relay.published",
          origin: { kind: "workflow", operation: "relay.publish" },
          label: draft.input.summary,
          timestamp: harness.oracle.now,
          actor: harness.oracle.sender,
          subjects: [{
            kind: "entity",
            entity: published.relays[0]!.ref,
          }],
          repoState: publish.receipt.authority.repoState,
        });
        expect(published.events[0]).not.toHaveProperty("workstream");

        const recipientPort = await harness.selectActor("recipient");
        const relay = published.relays[0]!;
        const immutableContent = immutableRelayContent(relay);
        const acknowledgeRepoState: RepoState = {
          branch: "relay/claim",
          head: "8".repeat(40),
          dirty: true,
          observedAt: "2026-08-29T06:31:00.000Z",
        };
        harness.setNow(acknowledgeRepoState.observedAt);
        harness.setRepositoryState(acknowledgeRepoState);
        const acknowledge = await recipientPort.previewRelay(
          await harness.commandFor(
            "relay.acknowledge",
            relay,
            "relay_contract_acknowledge",
          ),
        );
        const acknowledged = await recipientPort.applyRelay(acknowledge);
        expect(acknowledged.relays[0]).toMatchObject({ state: "acknowledged" });
        expect(acknowledged.events).toHaveLength(1);
        expect(acknowledge.receipt.purposeIds.map((item) => item.purpose))
          .toEqual(["activity"]);
        expect(acknowledge.receipt.purposeIds[0]!.id)
          .toBe(acknowledged.events[0]!.id);
        expect(acknowledged.events[0]).toMatchObject({
          schemaVersion: 2,
          action: "relay.acknowledged",
          origin: { kind: "workflow", operation: "relay.acknowledge" },
          label: draft.input.summary,
          timestamp: acknowledgeRepoState.observedAt,
          actor: harness.oracle.recipient,
          subjects: [{ kind: "entity", entity: relay.ref }],
          repoState: acknowledgeRepoState,
        });
        expect(acknowledged.events[0]).not.toHaveProperty("workstream");
        expect(acknowledged.relays[0]!.publishedRepoState)
          .toEqual(publish.receipt.authority.repoState);

        const closeRepoState: RepoState = {
          branch: null,
          head: null,
          dirty: false,
          observedAt: "2026-08-29T06:32:00.000Z",
        };
        harness.setNow(closeRepoState.observedAt);
        harness.setRepositoryState(closeRepoState);
        const close = await recipientPort.previewRelay(
          await harness.commandFor(
            "relay.close",
            acknowledged.relays[0]!,
            "relay_contract_close",
          ),
        );
        const closed = await recipientPort.applyRelay(close);
        expect(closed.relays[0]).toMatchObject({ state: "closed" });
        expect(closed.events).toHaveLength(1);
        expect(close.receipt.purposeIds[0]!.id).toBe(closed.events[0]!.id);
        expect(closed.events[0]).toMatchObject({
          schemaVersion: 2,
          action: "relay.closed",
          origin: { kind: "workflow", operation: "relay.close" },
          label: draft.input.summary,
          timestamp: closeRepoState.observedAt,
          actor: harness.oracle.recipient,
          subjects: [{ kind: "entity", entity: relay.ref }],
          repoState: closeRepoState,
        });
        expect(closed.events[0]).not.toHaveProperty("workstream");
        expect(closed.relays[0]!.publishedRepoState)
          .toEqual(publish.receipt.authority.repoState);
        expect(closed.relays[0]!.publishedAt! <= closed.relays[0]!.acknowledgedAt!)
          .toBe(true);
        expect(closed.relays[0]!.acknowledgedAt! <= closed.relays[0]!.closedAt!)
          .toBe(true);
        expect(immutableRelayContent(closed.relays[0]!)).toEqual(immutableContent);
        const afterClose = await harness.snapshot();
        for (const kind of ["relay.acknowledge", "relay.close"] as const) {
          await expectProblemCode(recipientPort.previewRelay(
            await harness.commandFor(
              kind,
              closed.relays[0]!,
              `relay_contract_terminal_${kind.replace("relay.", "")}`,
            ),
          ), ["VALIDATION_FAILED"]);
          expect(await harness.snapshot()).toEqual(afterClose);
        }
      });
    });

    it("permits dirty publication and signs one honest bounded provenance warning", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const dirtyRepoState: RepoState = {
          branch: "codex/dirty-handoff",
          head: "7".repeat(40),
          dirty: true,
          observedAt: "2026-08-29T06:35:00.000Z",
        };
        harness.setNow(dirtyRepoState.observedAt);
        harness.setRepositoryState(dirtyRepoState);
        const preview = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_dirty_publish",
          ),
        );
        expect(preview.receipt.authority.repoState).toEqual(dirtyRepoState);
        expect(preview.preview.valid).toBe(true);
        expect(preview.preview.diagnostics).toEqual([
          expect.objectContaining({
            severity: "warning",
            message: expect.stringMatching(/local changes existed.*paths, diff, or contents/iu),
          }),
        ]);

        const applied = await harness.port.applyRelay(preview);
        expect(applied.relays[0]).toMatchObject({
          schemaVersion: 3,
          workstream: null,
          publishedRepoState: dirtyRepoState,
        });
        expect(applied.events[0]).toMatchObject({
          action: "relay.published",
          repoState: dirtyRepoState,
        });
        expect(applied.events[0]).not.toHaveProperty("workstream");
      });
    });

    it("invalidates publication when branch, HEAD, or clean/dirty state drifts", async () => {
      for (const [label, mutate] of [
        ["branch", (state: RepoState): RepoState => ({ ...state, branch: "other/branch" })],
        ["head", (state: RepoState): RepoState => ({ ...state, head: "6".repeat(40) })],
        ["dirty", (state: RepoState): RepoState => ({ ...state, dirty: !state.dirty })],
      ] as const) {
        await withHarness(factory, "populated", async (harness) => {
          const draft = requirePopulatedDraft(harness);
          const envelope = await harness.port.previewRelay(
            await harness.commandFor(
              "relay.publish",
              draft,
              `relay_contract_${label}_drift`,
            ),
          );
          harness.setRepositoryState(mutate(envelope.receipt.authority.repoState));
          const drifted = await harness.snapshot();
          await expectProblemCode(
            harness.port.applyRelay(envelope),
            ["REVISION_CONFLICT"],
          );
          expect(await harness.snapshot()).toEqual(drifted);
          expectNoRelayPublication(drifted, draft.id);
        });
      }
    });

    it("records detached and null-HEAD publication authority without fabricating Git state", async () => {
      for (const [label, repoState] of [
        ["detached", {
          branch: null,
          head: "5".repeat(40),
          dirty: false,
          observedAt: "2026-08-29T06:36:00.000Z",
        }],
        ["null-head", {
          branch: "main",
          head: null,
          dirty: false,
          observedAt: "2026-08-29T06:37:00.000Z",
        }],
      ] as const satisfies readonly (readonly [string, RepoState])[]) {
        await withHarness(factory, "populated", async (harness) => {
          harness.setNow(repoState.observedAt);
          harness.setRepositoryState(repoState);
          const draft = requirePopulatedDraft(harness);
          const envelope = await harness.port.previewRelay(
            await harness.commandFor(
              "relay.publish",
              draft,
              `relay_contract_${label}_publication`,
            ),
          );
          const applied = await harness.port.applyRelay(envelope);
          expect(applied.relays[0]?.publishedRepoState).toEqual(repoState);
          expect(applied.events[0]?.repoState).toEqual(repoState);
        });
      }
    });

    it("requires current Member authority for personal views and canonical actions", async () => {
      await withHarness(factory, "no-current-member", async ({ port }) => {
        await expect(port.listRelays({ perspective: "mine" })).rejects.toMatchObject({
          problem: { code: "UNAUTHORIZED" },
        });
        await expect(port.listRelays({ perspective: "sent" })).rejects.toMatchObject({
          problem: { code: "UNAUTHORIZED" },
        });
        await expect(port.listRelays({ perspective: "all" })).resolves.toBeDefined();
        await expect(port.listRelayDrafts()).resolves.toBeDefined();
      });
    });

    it("filters before pagination, sorts timestamped Relays before v1, and isolates bound cursors", async () => {
      await withHarness(factory, "query", async (harness) => {
        const all = await harness.port.listRelays({ perspective: "all" });
        expect(all.items.map((relay) => relay.summary)).toEqual([
          "Claimed by sender",
          "Published to recipient",
          "Legacy self handoff",
        ]);
        expect(all.diagnostics.filter(
          (diagnostic) => diagnostic.code === "RELAY_LEGACY_PUBLICATION_TIME",
        )).toHaveLength(1);
        const legacyWorkstream = all.items.find(
          (relay) => relay.workstream !== null,
        )?.workstream;
        if (legacyWorkstream === null || legacyWorkstream === undefined) {
          throw new Error("Expected one Workstream-bearing legacy Relay.");
        }
        expect((await harness.port.listRelays({
          perspective: "all",
          workstreamId: legacyWorkstream.id,
        })).items.map((relay) => relay.summary)).toEqual([
          "Legacy self handoff",
        ]);
        const sent = await harness.port.listRelays({ perspective: "sent" });
        expect(sent.items.map((relay) => relay.summary)).toEqual([
          "Published to recipient",
          "Legacy self handoff",
        ]);
        const mine = await harness.port.listRelays({ perspective: "mine" });
        expect(mine.items.map((relay) => relay.summary)).toEqual([
          "Claimed by sender",
          "Legacy self handoff",
        ]);
        const senderMineFirst = await harness.port.listRelays({
          perspective: "mine",
          limit: 1,
        });
        expect(senderMineFirst.items.map((relay) => relay.summary)).toEqual([
          "Claimed by sender",
        ]);
        expect(senderMineFirst.nextCursor).not.toBeNull();

        const first = await harness.port.listRelays({
          perspective: "all",
          states: ["published"],
          limit: 1,
        });
        expect(first.items.map((relay) => relay.summary)).toEqual([
          "Published to recipient",
        ]);
        expect(first.nextCursor).not.toBeNull();
        const second = await harness.port.listRelays({
          perspective: "all",
          states: ["published"],
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.items.map((relay) => relay.summary)).toEqual([
          "Legacy self handoff",
        ]);
        await expectProblemCode(harness.port.listRelays({
          perspective: "all",
          states: ["acknowledged"],
          limit: 1,
          cursor: first.nextCursor!,
        }), ["REVISION_CONFLICT"]);

        const recipient = await harness.selectActor("recipient");
        expect((await recipient.listRelays({
          perspective: "all",
          states: ["published"],
          limit: 1,
          cursor: first.nextCursor!,
        })).items.map((relay) => relay.summary)).toEqual([
          "Legacy self handoff",
        ]);
        await expectProblemCode(recipient.listRelays({
          perspective: "mine",
          limit: 1,
          cursor: senderMineFirst.nextCursor!,
        }), ["REVISION_CONFLICT"]);
        expect((await recipient.listRelays({ perspective: "mine" })).items
          .map((relay) => relay.summary)).toEqual(["Published to recipient"]);
        expect((await recipient.listRelays({ perspective: "sent" })).items
          .map((relay) => relay.summary)).toEqual(["Claimed by sender"]);

        const claimable = await recipient.getRelay(first.items[0]!.ref.id);
        if (claimable === null) throw new Error("Expected claimable query Relay.");
        await recipient.applyRelay(
          await recipient.previewRelay(
            await harness.commandFor(
              "relay.acknowledge",
              claimable,
              "relay_contract_cursor_corpus_change",
            ),
          ),
        );
        const sender = await harness.selectActor("sender");
        await expectProblemCode(sender.listRelays({
          perspective: "all",
          states: ["published"],
          limit: 1,
          cursor: first.nextCursor!,
        }), ["REVISION_CONFLICT"]);
      });
    });

    it("lets exactly one listed recipient claim a concurrently previewed Relay", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = harness.oracle.populatedDraft;
        if (draft === null) throw new Error("Relay fixture has no draft.");
        const published = await harness.port.applyRelay(
          await harness.port.previewRelay(
            await harness.commandFor("relay.publish", draft, "relay_contract_race_publish"),
          ),
        );
        const relay = published.relays[0]!;
        const first = await harness.selectActor("recipient");
        const second = await harness.selectActor("alternate-recipient");
        const firstEnvelope = await first.previewRelay(
          await harness.commandFor("relay.acknowledge", relay, "relay_contract_race_first"),
        );
        const secondEnvelope = await second.previewRelay(
          await harness.commandFor("relay.acknowledge", relay, "relay_contract_race_second"),
        );
        await expect(first.applyRelay(firstEnvelope)).resolves.toMatchObject({
          relays: [{ state: "acknowledged", acknowledgedBy: harness.oracle.recipient }],
        });
        const afterWinner = await harness.snapshot();
        await expect(second.applyRelay(secondEnvelope)).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
        expect(await harness.snapshot()).toEqual(afterWinner);
        const stored = await first.getRelay(relay.ref.id);
        expect(stored).toMatchObject({
          state: "acknowledged",
          acknowledgedBy: harness.oracle.recipient,
        });
      });
    });

    it("allows one publish and close race winner without loser Activity", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const firstPublish = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_publish_race_first"),
        );
        const secondPublisher = await harness.selectActor("sender");
        const secondPublish = await secondPublisher.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_publish_race_second"),
        );
        const published = await harness.port.applyRelay(firstPublish);
        const afterPublishWinner = await harness.snapshot();
        await expectProblemCode(
          secondPublisher.applyRelay(secondPublish),
          ["NOT_FOUND", "REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(afterPublishWinner);
        expect(afterPublishWinner.relayIds).toHaveLength(1);
        expect(afterPublishWinner.activityIds).toHaveLength(1);

        const recipient = await harness.selectActor("recipient");
        const acknowledged = await recipient.applyRelay(
          await recipient.previewRelay(
            await harness.commandFor(
              "relay.acknowledge",
              published.relays[0]!,
              "relay_contract_close_race_acknowledge",
            ),
          ),
        );
        const recipientClose = await recipient.previewRelay(
          await harness.commandFor(
            "relay.close",
            acknowledged.relays[0]!,
            "relay_contract_close_race_recipient",
          ),
        );
        const sender = await harness.selectActor("sender");
        const senderClose = await sender.previewRelay(
          await harness.commandFor(
            "relay.close",
            acknowledged.relays[0]!,
            "relay_contract_close_race_sender",
          ),
        );
        await recipient.applyRelay(recipientClose);
        const afterCloseWinner = await harness.snapshot();
        await expectProblemCode(
          sender.applyRelay(senderClose),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(afterCloseWinner);
        expect(afterCloseWinner.activityIds).toHaveLength(3);
      });
    });

    it("enforces close principal authority, active-principal stranding, and memberId comparison", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const acknowledged = await publishAndAcknowledge(
          harness,
          "relay_contract_close_authority",
        );
        const alternate = await harness.selectActor("alternate-recipient");
        const beforeWrongActor = await harness.snapshot();
        await expectProblemCode(alternate.previewRelay(
          await harness.commandFor(
            "relay.close",
            acknowledged,
            "relay_contract_close_wrong_actor",
          ),
        ), ["UNAUTHORIZED"]);
        expect(await harness.snapshot()).toEqual(beforeWrongActor);

        const recipient = await harness.selectActor("recipient");
        const close = await recipient.previewRelay(
          await harness.commandFor(
            "relay.close",
            acknowledged,
            "relay_contract_close_member_id",
          ),
        );
        await harness.renameMember("recipient", "Rear Admiral Grace Hopper");
        await expect(recipient.applyRelay(close)).resolves.toMatchObject({
          relays: [{ state: "closed" }],
        });
      });

      await withHarness(factory, "populated", async (harness) => {
        const acknowledged = await publishAndAcknowledge(
          harness,
          "relay_contract_inactive_principal",
        );
        await harness.setMemberActive("sender", false);
        const recipient = await harness.selectActor("recipient");
        const stranded = await harness.snapshot();
        await expectProblemCode(recipient.previewRelay(
          await harness.commandFor(
            "relay.close",
            acknowledged,
            "relay_contract_inactive_principal_close",
          ),
        ), ["UNAUTHORIZED"]);
        expect(await harness.snapshot()).toEqual(stranded);
        await harness.setMemberActive("sender", true);
        const current = await recipient.getRelay(acknowledged.ref.id);
        if (current === null) throw new Error("Expected acknowledged Relay.");
        await expect(recipient.applyRelay(
          await recipient.previewRelay(
            await harness.commandFor(
              "relay.close",
              current,
              "relay_contract_reactivated_principal_close",
            ),
          ),
        )).resolves.toMatchObject({ relays: [{ state: "closed" }] });
      });

      await withHarness(factory, "legacy-v1", async (harness) => {
        const legacy = harness.oracle.populatedRelay;
        if (legacy === null) throw new Error("Expected legacy Relay.");
        const recipient = await harness.selectActor("recipient");
        const before = await harness.snapshot();
        await expectProblemCode(recipient.previewRelay(
          await harness.commandFor(
            "relay.close",
            legacy,
            "relay_contract_legacy_principal_close",
          ),
        ), ["UNAUTHORIZED"]);
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    for (const phase of TEAM_RELAY_RECOVERY_PHASES) {
      it(`recovers ${phase} exactly without duplicate Relay or Activity effects`, async () => {
        await withHarness(factory, "populated", async (harness) => {
          const prepared = await prepareRecoveryEnvelope(harness, phase);
          await harness.armCrash(phase);
          await expect(prepared.port.applyRelay(prepared.envelope)).rejects.toMatchObject({
            problem: { code: "OPERATION_INTERRUPTED" },
          });
          const restarted = await harness.restart();
          const recovered = await restarted.applyRelay(prepared.envelope);
          expect(recovered).toMatchObject({
            applied: true,
            idempotentReplay: false,
            relays: [{ state: prepared.expectedState }],
          });
          expect(recovered.events).toHaveLength(1);
          const afterRecovery = await harness.snapshot();
          const replay = await restarted.applyRelay(prepared.envelope);
          expect(replay.idempotentReplay).toBe(true);
          expect(await harness.snapshot()).toEqual(afterRecovery);
          expect(new Set(afterRecovery.relayIds).size).toBe(afterRecovery.relayIds.length);
          expect(new Set(afterRecovery.activityIds).size).toBe(afterRecovery.activityIds.length);
          expect(afterRecovery.activityIds).toHaveLength(prepared.expectedActivityCount);
        });
      });
    }

    it("keeps Relay recovery journal rows bounded and free of proposal prose, diffs, and secrets", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_journal_privacy",
          ),
        );
        await harness.armCrash("publish.after-relay");
        await expectProblemCode(harness.port.applyRelay(envelope), ["OPERATION_INTERRUPTED"]);
        const rows = await harness.inspectJournalRows();
        expect(rows).toHaveLength(1);
        for (const row of rows) {
          expect(Buffer.byteLength(row, "utf8")).toBeLessThanOrEqual(64 * 1024);
          for (const sentinel of [
            draft.input.summary,
            ...draft.input.completed,
            ...draft.input.inProgress,
            ...draft.input.changedFiles,
            ...draft.input.nextActions,
          ]) {
            expect(row).not.toContain(sentinel);
          }
          expect(row).not.toMatch(
            /(?:diff|prompt|transcript|credential|password|secret|sourceBody)/iu,
          );
          expect(row).not.toMatch(/(?:^|["'])\/(?:Users|home|private|tmp)\//u);
        }
      });
    });

    it("projects legacy v1 publication time as null without rewriting bytes", async () => {
      await withHarness(factory, "legacy-v1", async (harness) => {
        const before = await harness.snapshot();
        expect(harness.oracle.populatedRelay).toMatchObject({
          schemaVersion: 1,
          publishedAt: null,
          diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME" }],
        });
        const page = await harness.port.listRelays({ perspective: "all" });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ schemaVersion: 1, publishedAt: null });
        expect(page.diagnostics).toEqual([
          expect.objectContaining({ code: "RELAY_LEGACY_PUBLICATION_TIME" }),
        ]);
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("keeps legacy v2 Workstream association while preserving its schema through Take and Close", async () => {
      await withHarness(factory, "legacy-v2", async (harness) => {
        const legacy = harness.oracle.populatedRelay;
        if (legacy === null) throw new Error("Expected legacy schema-v2 Relay.");
        expect(legacy).toMatchObject({
          schemaVersion: 2,
          publishedRepoState: null,
        });
        expect(legacy.workstream).not.toBeNull();
        const immutable = immutableRelayContent(legacy);

        const recipient = await harness.selectActor("recipient");
        const acknowledged = await recipient.applyRelay(
          await recipient.previewRelay(
            await harness.commandFor(
              "relay.acknowledge",
              legacy,
              "relay_contract_legacy_v2_acknowledge",
            ),
          ),
        );
        expect(acknowledged.relays[0]).toMatchObject({
          schemaVersion: 2,
          publishedRepoState: null,
          workstream: legacy.workstream,
        });
        expect(acknowledged.events[0]).toMatchObject({
          action: "relay.acknowledged",
          workstream: legacy.workstream,
        });

        const closed = await recipient.applyRelay(
          await recipient.previewRelay(
            await harness.commandFor(
              "relay.close",
              acknowledged.relays[0]!,
              "relay_contract_legacy_v2_close",
            ),
          ),
        );
        expect(closed.relays[0]).toMatchObject({
          schemaVersion: 2,
          publishedRepoState: null,
          workstream: legacy.workstream,
        });
        expect(closed.events[0]).toMatchObject({
          action: "relay.closed",
          workstream: legacy.workstream,
        });
        expect(immutableRelayContent(closed.relays[0]!)).toEqual(immutable);
      });
    });

    it("rejects an unjournaled pre-v3 signed Publish preview with actionable re-preview guidance", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const envelope = await harness.preparePreV3PublishEnvelope(
          "relay_contract_pre_v3_unjournaled",
          false,
        );
        const before = await harness.snapshot();
        await expect((await harness.restart()).applyRelay(envelope)).rejects
          .toMatchObject({
            problem: {
              code: "REVISION_CONFLICT",
              detail: expect.stringMatching(/preview.*again/iu),
            },
          });
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("recovers journaled pre-v3 Publish intent as exact v2 Relay and Workstream Activity", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const envelope = await harness.preparePreV3PublishEnvelope(
          "relay_contract_pre_v3_journaled",
          true,
        );
        const relayChange = envelope.preview.changes.find((change) =>
          change.path.startsWith(".mex/relays/"));
        const activityChange = envelope.preview.changes.find((change) =>
          change.path.startsWith(".mex/events/activity/"));
        const recovered = await (await harness.restart()).applyRelay(envelope);
        expect(recovered).toMatchObject({
          idempotentReplay: false,
          relays: [{
            schemaVersion: 2,
            publishedRepoState: null,
            workstream: expect.objectContaining({ kind: "workstream" }),
            evidence: [{ kind: "manual", note: "Consumer contract fixture" }],
          }],
          events: [{
            action: "relay.published",
            workstream: expect.objectContaining({ kind: "workstream" }),
          }],
        });
        expect(recovered.relays[0]?.revision).toBe(relayChange?.afterRevision);
        expect(recovered.events[0]?.revision).toBe(activityChange?.afterRevision);
        expect(recovered.relays[0]?.publishedRepoState).toBeNull();
        await expect(harness.port.getRelayDraft(requirePopulatedDraft(harness).id))
          .resolves.toBeNull();
        const afterRecovery = await harness.snapshot();
        expect(afterRecovery.relayIds).toHaveLength(1);
        expect(afterRecovery.activityIds).toHaveLength(1);

        await harness.removeSigner();
        const replayBaseline = await harness.snapshot();
        const replay = await (await harness.restart()).applyRelay(envelope);
        expect(replay).toMatchObject({
          idempotentReplay: true,
          relays: [{ schemaVersion: 2 }],
          events: [{ action: "relay.published" }],
        });
        expect(await harness.snapshot()).toEqual(replayBaseline);
      });
    });

    it("rejects envelopes after signer loss before journal intent", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = harness.oracle.populatedDraft;
        if (draft === null) throw new Error("Relay fixture has no draft.");
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_signer_loss"),
        );
        await harness.removeSigner();
        const restarted = await harness.restart();
        await expect(restarted.applyRelay(envelope)).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
      });
    });

    it("replays one completed signed lifecycle operation after restart and signer loss", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_completed_replay"),
        );
        const first = await harness.port.applyRelay(envelope);
        await harness.removeSigner();
        const afterLoss = await harness.snapshot();
        const restarted = await harness.restart();
        const replay = await restarted.applyRelay(envelope);
        expect(replay).toMatchObject({
          operationId: first.operationId,
          previewRevision: first.previewRevision,
          idempotentReplay: true,
          relays: [{ state: "published" }],
        });
        expect(await harness.snapshot()).toEqual(afterLoss);
      });
    });

    it("applies service-generated draft, Relay, and Activity IDs in a fresh process", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const draftEnvelope = await harness.port.previewRelay(
          await harness.makeDraftCommand("relay_contract_fresh_process_draft"),
        );
        const draftId = draftEnvelope.receipt.purposeIds[0]!.id;
        const restartedForDraft = await harness.restart();
        await restartedForDraft.applyRelay(draftEnvelope);
        const draft = await restartedForDraft.getRelayDraft(draftId);
        if (draft === null) throw new Error("Expected fresh-process Relay draft.");
        const publishEnvelope = await restartedForDraft.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_fresh_process_publish",
          ),
        );
        const relayId = publishEnvelope.receipt.purposeIds.find(
          (item) => item.purpose === "relay",
        )!.id;
        const activityId = publishEnvelope.receipt.purposeIds.find(
          (item) => item.purpose === "activity",
        )!.id;
        const restartedForPublish = await harness.restart();
        const published = await restartedForPublish.applyRelay(publishEnvelope);
        expect(published.relays[0]!.ref.id).toBe(relayId);
        expect(published.events[0]!.id).toBe(activityId);
      });
    });

    it("rejects signed-field tampering, expiry, future clocks, actor drift, and repository drift without effects", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_tamper"),
        );
        const prepared = await harness.snapshot();
        const tampers: TeamRelayPreviewEnvelope[] = [];
        const operation = structuredClone(envelope);
        operation.request.operationId += "_changed";
        tampers.push(operation);
        const presentation = structuredClone(envelope);
        presentation.preview.scope = presentation.preview.scope === "local" ? "canonical" : "local";
        tampers.push(presentation);
        const authority = structuredClone(envelope);
        authority.receipt.authority.occurredAt = "2026-01-01T00:00:00.000Z";
        tampers.push(authority);
        const purpose = structuredClone(envelope);
        purpose.receipt.purposeIds[0]!.id += "X";
        tampers.push(purpose);
        const signature = structuredClone(envelope);
        signature.receipt.previewRevision = differentRevision(
          signature.receipt.previewRevision,
        );
        tampers.push(signature);
        for (const tamper of tampers) {
          await expectProblemCode(
            harness.port.applyRelay(tamper),
            ["VALIDATION_FAILED", "REVISION_CONFLICT"],
          );
          expect(await harness.snapshot()).toEqual(prepared);
        }
        harness.setNow(addMilliseconds(envelope.receipt.authority.occurredAt, 31 * 60_000));
        await expectProblemCode(harness.port.applyRelay(envelope), ["REVISION_CONFLICT"]);
        expect(await harness.snapshot()).toEqual(prepared);
      });

      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_future"),
        );
        const prepared = await harness.snapshot();
        harness.setNow(addMilliseconds(envelope.receipt.authority.occurredAt, -6_000));
        await expectProblemCode(harness.port.applyRelay(envelope), ["REVISION_CONFLICT"]);
        expect(await harness.snapshot()).toEqual(prepared);
      });

      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_actor_drift"),
        );
        const prepared = await harness.snapshot();
        const changedActor = await harness.selectActor("recipient");
        await expectProblemCode(changedActor.applyRelay(envelope), ["REVISION_CONFLICT"]);
        expect(await harness.snapshot()).toEqual(prepared);
      });

      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_repo_drift"),
        );
        harness.mutateRepositoryAuthority();
        const drifted = await harness.snapshot();
        await expectProblemCode(harness.port.applyRelay(envelope), ["REVISION_CONFLICT"]);
        expect(await harness.snapshot()).toEqual(drifted);
      });
    });

    it("returns revision conflict before newly invalid Relay eligibility in a fresh process", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_stale_actor_inactive",
          ),
        );
        await harness.setMemberActive("sender", false);
        const drifted = await harness.snapshot();
        await expectProblemCode(
          (await harness.restart()).applyRelay(envelope),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(drifted);
        expectNoRelayPublication(drifted, draft.id);
      });

      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_stale_actor_deleted",
          ),
        );
        await harness.deleteMember("sender");
        const drifted = await harness.snapshot();
        await expectProblemCode(
          (await harness.restart()).applyRelay(envelope),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(drifted);
        expectNoRelayPublication(drifted, draft.id);
      });

      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_stale_recipient",
          ),
        );
        await harness.setMemberActive("recipient", false);
        const drifted = await harness.snapshot();
        await expectProblemCode(
          (await harness.restart()).applyRelay(envelope),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(drifted);
        expectNoRelayPublication(drifted, draft.id);
      });

      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_stale_draft_payload",
          ),
        );
        await harness.mutateDraftToMissingRecipient(draft.id);
        const drifted = await harness.snapshot();
        await expectProblemCode(
          (await harness.restart()).applyRelay(envelope),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(drifted);
        expectNoRelayPublication(drifted, draft.id);
      });
    });

    it("rechecks Relay freshness at the final write boundary and before intent recovery", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_final_window_stale_recipient",
          ),
        );
        await harness.armBeforeCanonicalRecipientDeactivation();
        await expectProblemCode(
          harness.port.applyRelay(envelope),
          ["REVISION_CONFLICT"],
        );
        expectNoRelayPublication(await harness.snapshot(), draft.id);
      });

      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_intent_recovery_stale_recipient",
          ),
        );
        await harness.armBeforeCanonicalCrash();
        await expectProblemCode(
          harness.port.applyRelay(envelope),
          ["OPERATION_INTERRUPTED"],
        );
        expectNoRelayPublication(await harness.snapshot(), draft.id);
        await harness.setMemberActive("recipient", false);
        const drifted = await harness.snapshot();
        await expectProblemCode(
          (await harness.restart()).applyRelay(envelope),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(drifted);
        expectNoRelayPublication(drifted, draft.id);
      });
    });

    it("keeps preview-time Relay eligibility failures semantic", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        await harness.setMemberActive("sender", false);
        const before = await harness.snapshot();
        await expectProblemCode(
          harness.port.previewRelay(
            await harness.commandFor(
              "relay.publish",
              draft,
              "relay_contract_preview_inactive_actor",
            ),
          ),
          ["UNAUTHORIZED"],
        );
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("binds a completed operation ID to one exact Relay envelope", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const operationId = "relay_contract_operation_reuse";
        const firstEnvelope = await harness.port.previewRelay(
          await harness.makeDraftCommand(operationId),
        );
        const draftId = firstEnvelope.receipt.purposeIds[0]!.id;
        await harness.port.applyRelay(firstEnvelope);
        const draft = await harness.port.getRelayDraft(draftId);
        if (draft === null) throw new Error("Expected saved Relay draft.");
        const secondEnvelope = await harness.port.previewRelay({
          operationId,
          action: {
            kind: "relay.draft.save",
            draftId,
            draft: { ...draft.input, summary: "Changed operation reuse payload" },
          },
          expectedRevisions: [{
            target: { kind: "local", namespace: "relay-draft", id: draftId },
            revision: draft.revision,
          }],
        });
        const beforeReuse = await harness.snapshot();
        await expectProblemCode(
          harness.port.applyRelay(secondEnvelope),
          ["REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(beforeReuse);
      });
    });

    it("requires exactly the draft and unique recipient revision set", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const valid = await harness.commandFor(
          "relay.publish",
          draft,
          "relay_contract_exact_expectations",
        );
        const before = await harness.snapshot();
        const invalidSets = [
          valid.expectedRevisions.slice(1),
          valid.expectedRevisions.filter((_, index) => index !== 1),
          valid.expectedRevisions.filter((_, index) => index !== 2),
          [...valid.expectedRevisions, {
            target: { kind: "artifact" as const, path: ".mex/unrelated.md" as never },
            revision: "a".repeat(64) as Revision,
          }],
          [...valid.expectedRevisions, {
            target: {
              kind: "artifact" as const,
              path: ".mex/workstreams/ws_01ARZ3NDEKTSV4RRFFQ69G5FAV.md" as never,
            },
            revision: "a".repeat(64) as Revision,
          }],
          [...valid.expectedRevisions, valid.expectedRevisions[1]!],
          valid.expectedRevisions.map((expectation, index) => index === 1
            ? { ...expectation, semanticRevision: 1 }
            : expectation),
        ];
        for (const [index, expectedRevisions] of invalidSets.entries()) {
          await expectProblemCode(harness.port.previewRelay({
            ...valid,
            operationId: `relay_contract_exact_expectations_${index}`,
            expectedRevisions,
          } as TeamRelayCommand), ["VALIDATION_FAILED"]);
          expect(await harness.snapshot()).toEqual(before);
        }
      });
    });

    it("publishes to the sender as recipient and rejects missing or inactive recipients", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const draft = await saveDraftWithRecipients(
          harness,
          [harness.oracle.sender],
          "relay_contract_sender_recipient_draft",
        );
        const published = await harness.port.applyRelay(
          await harness.port.previewRelay(
            await harness.commandFor(
              "relay.publish",
              draft,
              "relay_contract_sender_recipient_publish",
            ),
          ),
        );
        expect(published.relays[0]!.recipients).toEqual([harness.oracle.sender]);
        await expect(harness.port.listRelays({ perspective: "mine" })).resolves.toMatchObject({
          items: [{ ref: published.relays[0]!.ref }],
        });
      });

      await withHarness(factory, "empty", async (harness) => {
        const draft = await saveDraftWithRecipients(
          harness,
          [harness.oracle.recipient],
          "relay_contract_inactive_recipient_draft",
        );
        await harness.setMemberActive("recipient", false);
        const before = await harness.snapshot();
        await expectProblemCode(harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            draft,
            "relay_contract_inactive_recipient_publish",
          ),
        ), ["VALIDATION_FAILED"]);
        expect(await harness.snapshot()).toEqual(before);
      });

      await withHarness(factory, "empty", async (harness) => {
        if (harness.oracle.recipient.kind !== "member") {
          throw new Error("Relay fixture recipient is not a Member.");
        }
        const missing = {
          ...harness.oracle.recipient,
          memberId: differentArtifactId(harness.oracle.recipient.memberId),
        } as ActorRef;
        const draft = await saveDraftWithRecipients(
          harness,
          [missing],
          "relay_contract_missing_recipient_draft",
        );
        const publish = await harness.commandFor(
          "relay.publish",
          draft,
          "relay_contract_missing_recipient_publish",
        );
        if (missing.kind !== "member") {
          throw new Error("Missing Relay recipient is not a Member.");
        }
        const before = await harness.snapshot();
        await expectProblemCode(harness.port.previewRelay(
          {
            ...publish,
            expectedRevisions: [
              ...publish.expectedRevisions,
              {
                target: {
                  kind: "artifact",
                  path: `.mex/team/members/${missing.memberId}.md`,
                },
                revision: "a".repeat(64) as Revision,
              },
            ],
          },
        ), ["NOT_FOUND"]);
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("serializes Relay writers with the repository Team workflow lease", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = requirePopulatedDraft(harness);
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_lease"),
        );
        await harness.holdCompetingWorkflowLease();
        const whileHeld = await harness.snapshot();
        await expectProblemCode(
          harness.port.applyRelay(envelope),
          ["OPERATION_INTERRUPTED"],
        );
        expect(await harness.snapshot()).toEqual(whileHeld);
        await harness.releaseCompetingWorkflowLease();
        await expect(harness.port.applyRelay(envelope)).resolves.toMatchObject({
          relays: [{ state: "published" }],
          events: [{ action: "relay.published" }],
        });
      });
    });

    it("fails closed at every Relay storage ancestor and after project-root swap", async () => {
      for (const target of ["local", "relay", "activity"] as const) {
        await withHarness(
          factory,
          target === "local" ? "empty" : "populated",
          async (harness) => {
            const envelope = target === "local"
              ? await harness.port.previewRelay(
                  await harness.makeDraftCommand(`relay_contract_containment_${target}`),
                )
              : await harness.port.previewRelay(
                  await harness.commandFor(
                    "relay.publish",
                    requirePopulatedDraft(harness),
                    `relay_contract_containment_${target}`,
                  ),
                );
            await harness.installEscapingAncestor(target);
            const attacked = await harness.snapshot();
            await expectProblemCode(
              harness.port.applyRelay(envelope),
              ["PATH_OUTSIDE_PROJECT", "REVISION_CONFLICT"],
            );
            expect(await harness.snapshot()).toEqual(attacked);
          },
        );
      }

      await withHarness(factory, "populated", async (harness) => {
        const envelope = await harness.port.previewRelay(
          await harness.commandFor(
            "relay.publish",
            requirePopulatedDraft(harness),
            "relay_contract_root_swap",
          ),
        );
        await harness.swapProjectRoot();
        const swapped = await harness.snapshot();
        await expectProblemCode(
          harness.port.applyRelay(envelope),
          ["PATH_OUTSIDE_PROJECT", "REVISION_CONFLICT"],
        );
        expect(await harness.snapshot()).toEqual(swapped);
      });
    });
  });
}

async function withHarness(
  factory: TeamRelayContractFactory,
  scenario: TeamRelayScenario,
  run: (harness: TeamRelayContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory.open(scenario);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function prepareRecoveryEnvelope(
  harness: TeamRelayContractHarness,
  phase: TeamRelayRecoveryPhase,
): Promise<{
  port: TeamRelayHandoffPort;
  envelope: TeamRelayPreviewEnvelope;
  expectedState: "published" | "acknowledged" | "closed";
  expectedActivityCount: number;
}> {
  const draft = harness.oracle.populatedDraft;
  if (draft === null) throw new Error("Relay fixture has no draft.");
  const publishEnvelope = await harness.port.previewRelay(
    await harness.commandFor(
      "relay.publish",
      draft,
      `relay_contract_recovery_${phase.replaceAll(".", "_")}_publish`,
    ),
  );
  if (phase.startsWith("publish.")) {
    return {
      port: harness.port,
      envelope: publishEnvelope,
      expectedState: "published",
      expectedActivityCount: 1,
    };
  }
  const published = await harness.port.applyRelay(publishEnvelope);
  const recipientPort = await harness.selectActor("recipient");
  const acknowledgeEnvelope = await recipientPort.previewRelay(
    await harness.commandFor(
      "relay.acknowledge",
      published.relays[0]!,
      `relay_contract_recovery_${phase.replaceAll(".", "_")}_acknowledge`,
    ),
  );
  if (phase.startsWith("acknowledge.")) {
    return {
      port: recipientPort,
      envelope: acknowledgeEnvelope,
      expectedState: "acknowledged",
      expectedActivityCount: 2,
    };
  }
  const acknowledged = await recipientPort.applyRelay(acknowledgeEnvelope);
  const closeEnvelope = await recipientPort.previewRelay(
    await harness.commandFor(
      "relay.close",
      acknowledged.relays[0]!,
      `relay_contract_recovery_${phase.replaceAll(".", "_")}_close`,
    ),
  );
  return {
    port: recipientPort,
    envelope: closeEnvelope,
    expectedState: "closed",
    expectedActivityCount: 3,
  };
}

function requirePopulatedDraft(
  harness: TeamRelayContractHarness,
): TeamRelayDraftDetail {
  const draft = harness.oracle.populatedDraft;
  if (draft === null) throw new Error("Relay fixture has no draft.");
  return draft;
}

async function publishAndAcknowledge(
  harness: TeamRelayContractHarness,
  operationPrefix: string,
): Promise<TeamRelayDetail> {
  const draft = requirePopulatedDraft(harness);
  const published = await harness.port.applyRelay(
    await harness.port.previewRelay(
      await harness.commandFor(
        "relay.publish",
        draft,
        `${operationPrefix}_publish`,
      ),
    ),
  );
  const recipient = await harness.selectActor("recipient");
  const acknowledged = await recipient.applyRelay(
    await recipient.previewRelay(
      await harness.commandFor(
        "relay.acknowledge",
        published.relays[0]!,
        `${operationPrefix}_acknowledge`,
      ),
    ),
  );
  return acknowledged.relays[0]!;
}

async function saveDraftWithRecipients(
  harness: TeamRelayContractHarness,
  recipients: readonly ActorRef[],
  operationId: string,
): Promise<TeamRelayDraftDetail> {
  const base = await harness.makeDraftCommand(operationId);
  if (base.action.kind !== "relay.draft.save") {
    throw new Error("Relay harness returned a non-save draft command.");
  }
  const envelope = await harness.port.previewRelay({
    ...base,
    action: {
      ...base.action,
      draft: { ...base.action.draft, recipients },
    },
  });
  const draftId = envelope.receipt.purposeIds[0]!.id;
  await harness.port.applyRelay(envelope);
  const draft = await harness.port.getRelayDraft(draftId);
  if (draft === null) throw new Error("Expected saved Relay draft.");
  return draft;
}

async function expectProblemCode(
  result: Promise<unknown>,
  expected: readonly string[],
): Promise<void> {
  try {
    await result;
  } catch (error) {
    const code = (error as { problem?: { code?: unknown } })?.problem?.code;
    expect(expected).toContain(code);
    return;
  }
  throw new Error(`Expected operation to fail with ${expected.join(" or ")}.`);
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function differentRevision(revision: Revision): Revision {
  return `${revision[0] === "a" ? "b" : "a"}${revision.slice(1)}` as Revision;
}

function differentArtifactId(id: string): string {
  return `${id.slice(0, -1)}${id.endsWith("A") ? "B" : "A"}`;
}

function expectNoRelayPublication(
  snapshot: TeamRelaySnapshot,
  draftId: string,
): void {
  expect(snapshot.relayIds).toEqual([]);
  expect(snapshot.activityIds).toEqual([]);
  expect(snapshot.draftIds).toContain(draftId);
}

function immutableRelayContent(relay: TeamRelayDetail) {
  return {
    schemaVersion: relay.schemaVersion,
    ref: relay.ref,
    sender: relay.sender,
    recipients: relay.recipients,
    workstream: relay.workstream,
    summary: relay.summary,
    publishedAt: relay.publishedAt,
    publishedRepoState: relay.publishedRepoState,
    completed: relay.completed,
    inProgress: relay.inProgress,
    decisions: relay.decisions,
    blockers: relay.blockers,
    unresolvedQuestions: relay.unresolvedQuestions,
    changedFiles: relay.changedFiles,
    code: relay.code,
    evidence: relay.evidence,
    nextActions: relay.nextActions,
  };
}

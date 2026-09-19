import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { TEAM_RELAY_LIMITS } from "../../../contracts/workflow.js";
import { runRelayContract } from "../contract.js";
import {
  RELAY_ACTION_CONTRACT_MAX_BYTES,
  RELAY_CONTRACT_ACTIONS,
} from "../contract-catalog.js";
import type { RelayMutationCommandName } from "../request-file.js";
import { readRelayCommandFile, readRelayPreviewFile } from "../request-file.js";

const MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKSTREAM_ID = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVISION = "a".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Relay contract resolver CLI", () => {
  it("returns one bounded static catalog whose public roots and examples strict-compile", () => {
    const lines: string[] = [];
    let exit = -1;
    runRelayContract(
      { json: true },
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );

    expect(exit).toBe(0);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!, "utf8")).toBeLessThanOrEqual(
      TEAM_RELAY_LIMITS.maxEnvelopeBytes,
    );
    const envelope = JSON.parse(lines[0]!) as {
      data: {
        catalog: Record<string, unknown>;
        commands: Record<string, Array<{ id: string; usage: string }>>;
        requestFile: {
          schemaRef: string;
          maxRecipients: number;
          examples: Array<{
            command: RelayMutationCommandName;
            request: unknown;
          }>;
        };
        applyFile: { schemaRef: string; requirement: string };
      };
    };
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      command: "relay.contract",
      mode: "read",
      ok: true,
      data: {
        catalogVersion: 1,
        contractId: "team.relay.contract-catalog.v1",
        mediaType: "application/schema+json",
        encoding: "utf-8",
        requestFile: {
          schemaRef: "https://mex.dev/contracts/team-relay-request-v1.json",
          mediaType: "application/json",
          encoding: "utf-8",
          maxRecipients: 32,
        },
        applyFile: {
          schemaRef: "https://mex.dev/contracts/team-relay-preview-envelope-v1.json",
          mediaType: "application/json",
          encoding: "utf-8",
          maxBytes: 65_536,
          maxAgeSeconds: 1_800,
          maxFutureSkewSeconds: 5,
          maxReceiptBytes: 8_192,
          maxReceiptDepth: 8,
          maxReceiptNodes: 128,
          maxPurposeIds: 2,
        },
      },
    });
    expect(envelope.data.applyFile.requirement).toContain("exact complete successful");
    expect(Object.values(envelope.data.commands).flat().map((item) => item.id).sort()).toEqual([
      "relay.contract",
      "relay.draft.list",
      "relay.draft.show",
      "relay.list",
      "relay.show",
      "relay.draft.save.preview",
      "relay.draft.delete.preview",
      "relay.publish.preview",
      "relay.acknowledge.preview",
      "relay.close.preview",
      "relay.draft.save.apply",
      "relay.draft.delete.apply",
      "relay.publish.apply",
      "relay.acknowledge.apply",
      "relay.close.apply",
    ].sort());

    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(envelope.data.catalog);
    const validateRequest = ajv.compile({ $ref: envelope.data.requestFile.schemaRef });
    const validatePreview = ajv.compile({ $ref: envelope.data.applyFile.schemaRef });
    expect(validatePreview).toBeTypeOf("function");

    const root = mkdtempSync(join(tmpdir(), "mex-relay-contract-"));
    roots.push(root);
    expect(envelope.data.requestFile.examples[0]).toMatchObject({
      command: "relay.draft.save",
      request: {
        action: {
          kind: "relay.draft.save",
          draft: {
            audience: "team",
            recipients: [],
            summary: expect.any(String),
          },
        },
      },
    });
    expect(Object.keys((envelope.data.requestFile.examples[0]!.request as any).action.draft).sort())
      .toEqual(["audience", "recipients", "summary"]);
    const exampleEvidence = envelope.data.requestFile.examples.flatMap((example) => {
      const draft = (example.request as any)?.action?.draft;
      return Array.isArray(draft?.evidence) ? draft.evidence : [];
    });
    expect(exampleEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "commit" }),
      expect.objectContaining({ kind: "external" }),
    ]));

    for (const [index, example] of envelope.data.requestFile.examples.entries()) {
      expect(validateRequest(example.request), JSON.stringify(validateRequest.errors)).toBe(true);
      const path = join(root, `${index}-${example.command}.json`);
      writeFileSync(path, JSON.stringify(example.request));
      const normalized = readRelayCommandFile(path, example.command);
      if (normalized.action.kind === "relay.draft.save") {
        expect(normalized.action.draft).toMatchObject({
          recipients: (example.request as any).action.draft.recipients,
          summary: (example.request as any).action.draft.summary,
          completed: expect.any(Array),
          inProgress: expect.any(Array),
          decisions: expect.any(Array),
          blockers: expect.any(Array),
          unresolvedQuestions: expect.any(Array),
          changedFiles: expect.any(Array),
          code: expect.any(Array),
          evidence: expect.any(Array),
          nextActions: expect.any(Array),
        });
        expect(normalized.action.draft).not.toHaveProperty("workstream");
      } else {
        expect(normalized).toEqual(example.request);
      }
    }

    const publish = structuredClone(
      envelope.data.requestFile.examples.find((example) =>
        example.command === "relay.publish")!.request,
    ) as any;
    publish.expectedRevisions.reverse();
    expect(validateRequest(publish), JSON.stringify(validateRequest.errors)).toBe(true);
    const publishPath = join(root, "relay-publish-topology.json");
    writeFileSync(publishPath, JSON.stringify(publish));
    expect(readRelayCommandFile(publishPath, "relay.publish")).toEqual(publish);
    const localExpectation = publish.expectedRevisions.find(
      (expectation: any) => expectation.target.kind === "local",
    );
    expect(publish.expectedRevisions).toHaveLength(2);
    expect(publish.expectedRevisions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({
          path: expect.stringMatching(/^\.mex\/workstreams\//u),
        }),
      }),
    ]));
    const teamPublish = { ...publish, expectedRevisions: [localExpectation] };
    expect(validateRequest(teamPublish), JSON.stringify(validateRequest.errors)).toBe(true);
    writeFileSync(publishPath, JSON.stringify(teamPublish));
    expect(readRelayCommandFile(publishPath, "relay.publish")).toEqual(teamPublish);
    const invalidPublishTopologies = [
      [],
      [
        ...publish.expectedRevisions,
        {
          target: { kind: "entity", id: "relay:unrelated" },
          revision: "a".repeat(64),
          semanticRevision: 1,
        },
      ],
      [
        ...publish.expectedRevisions,
        {
          target: {
            kind: "artifact",
            path: ".mex/relays/relay_01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
          },
          revision: "a".repeat(64),
        },
      ],
      [
        ...publish.expectedRevisions,
        {
          target: {
            kind: "local",
            namespace: "relay-draft",
            id: `${publish.action.draftId}-other`,
          },
          revision: "a".repeat(64),
        },
      ],
    ];
    for (const expectedRevisions of invalidPublishTopologies) {
      const invalidPublish = { ...publish, expectedRevisions };
      expect(validateRequest(invalidPublish)).toBe(false);
      writeFileSync(publishPath, JSON.stringify(invalidPublish));
      expect(() => readRelayCommandFile(publishPath, "relay.publish")).toThrow();
    }

    const legacyDependencyPublish = structuredClone(publish);
    legacyDependencyPublish.expectedRevisions.push({
      target: { kind: "artifact", path: `.mex/workstreams/${WORKSTREAM_ID}.md` },
      revision: REVISION,
    });
    expect(validateRequest(legacyDependencyPublish)).toBe(false);
    writeFileSync(publishPath, JSON.stringify(legacyDependencyPublish));
    expect(() => readRelayCommandFile(publishPath, "relay.publish"))
      .toThrow(/preview again/i);

    const save = structuredClone(envelope.data.requestFile.examples[0]!.request) as any;
    save.action.draft.recipients = Array.from({ length: 33 }, (_, index) => ({
      kind: "member",
      memberId: `member_01ARZ3NDEKTSV4RRFFQ69G${String(index).padStart(2, "0")}`,
    }));
    expect(validateRequest(save)).toBe(false);
    save.action.draft.recipients = [{
      kind: "member",
      memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }];
    save.action.draft.summary = "multiline\nsummary";
    expect(validateRequest(save)).toBe(false);
    save.action.draft.summary = "Relay\u0085Agent";
    expect(validateRequest(save)).toBe(false);

    const canonicalDraft = structuredClone(envelope.data.requestFile.examples[0]!.request) as any;
    expect(validateRequest(canonicalDraft), JSON.stringify(validateRequest.errors)).toBe(true);
    const canonicalDraftPath = join(root, "canonical-draft.json");
    writeFileSync(canonicalDraftPath, JSON.stringify(canonicalDraft));
    expect(readRelayCommandFile(canonicalDraftPath, "relay.draft.save"))
      .toMatchObject({
        action: {
          draft: {
            recipients: canonicalDraft.action.draft.recipients,
            summary: canonicalDraft.action.draft.summary,
            completed: [],
            inProgress: [],
            decisions: [],
            blockers: [],
            unresolvedQuestions: [],
            changedFiles: [],
            code: [],
            evidence: [],
            nextActions: [],
          },
        },
      });

    const legacyDraft = {
      operationId: "relay-legacy-draft-translation-001",
      action: {
        kind: "relay.draft.save",
        draft: legacyDraftInput([{ kind: "manual", note: "Existing evidence" }]),
      },
      expectedRevisions: [],
    };
    expect(validateRequest(legacyDraft), JSON.stringify(validateRequest.errors)).toBe(true);
    const legacyDraftPath = join(root, "legacy-draft.json");
    const legacyBytes = JSON.stringify(legacyDraft);
    writeFileSync(legacyDraftPath, legacyBytes);
    expect(readRelayCommandFile(legacyDraftPath, "relay.draft.save")).toMatchObject({
      action: {
        draft: {
          evidence: [
            { kind: "entity", entity: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" } },
            { kind: "manual", note: "Existing evidence" },
          ],
        },
      },
    });
    expect((readRelayCommandFile(legacyDraftPath, "relay.draft.save") as any).action.draft)
      .not.toHaveProperty("workstream");
    expect(readFileSync(legacyDraftPath, "utf8")).toBe(legacyBytes);

    const fullLegacyEvidence = Array.from({ length: 64 }, (_, index) => ({
      kind: "manual",
      note: `Legacy evidence ${String(index).padStart(2, "0")}`,
    }));
    const fullLegacyDraft = structuredClone(legacyDraft) as any;
    fullLegacyDraft.operationId = "relay-legacy-draft-full-evidence-001";
    fullLegacyDraft.action.draft.evidence = fullLegacyEvidence;
    expect(validateRequest(fullLegacyDraft), JSON.stringify(validateRequest.errors)).toBe(true);
    writeFileSync(legacyDraftPath, JSON.stringify(fullLegacyDraft));
    const translatedFull = readRelayCommandFile(legacyDraftPath, "relay.draft.save") as any;
    expect(translatedFull.action.draft.evidence).toHaveLength(65);
    expect(translatedFull.action.draft.evidence[0]).toEqual({
      kind: "entity",
      entity: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" },
    });
    expect(translatedFull.action.draft.evidence.slice(1)).toEqual(fullLegacyEvidence);

    const migratedCanonicalUpdate = structuredClone(fullLegacyDraft) as any;
    migratedCanonicalUpdate.operationId = "relay-migrated-draft-followup-001";
    migratedCanonicalUpdate.action.draftId = "relay-legacy-draft-existing";
    migratedCanonicalUpdate.action.draft = translatedFull.action.draft;
    migratedCanonicalUpdate.expectedRevisions = [{
      target: {
        kind: "local",
        namespace: "relay-draft",
        id: migratedCanonicalUpdate.action.draftId,
      },
      revision: REVISION,
    }];
    writeFileSync(canonicalDraftPath, JSON.stringify(migratedCanonicalUpdate));
    expect((readRelayCommandFile(canonicalDraftPath, "relay.draft.save") as any)
      .action.draft.evidence).toHaveLength(65);

    const duplicateLegacyDraft = structuredClone(fullLegacyDraft) as any;
    duplicateLegacyDraft.operationId = "relay-legacy-draft-deduplicate-001";
    duplicateLegacyDraft.action.draft.evidence = [
      { kind: "entity", entity: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" } },
      ...fullLegacyEvidence.slice(0, 63),
    ];
    writeFileSync(legacyDraftPath, JSON.stringify(duplicateLegacyDraft));
    const translatedDuplicate = readRelayCommandFile(legacyDraftPath, "relay.draft.save") as any;
    expect(translatedDuplicate.action.draft.evidence).toHaveLength(64);
    expect(translatedDuplicate.action.draft.evidence.filter((item: any) => (
      item.kind === "entity" && item.entity?.id === WORKSTREAM_ID
    ))).toHaveLength(1);

    const callerAuthoredOverLimit = structuredClone(canonicalDraft) as any;
    callerAuthoredOverLimit.operationId = "relay-new-draft-over-limit-001";
    callerAuthoredOverLimit.action.draft.evidence = [
      { kind: "entity", entity: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" } },
      ...fullLegacyEvidence,
    ];
    expect(validateRequest(callerAuthoredOverLimit), JSON.stringify(validateRequest.errors)).toBe(true);
    writeFileSync(canonicalDraftPath, JSON.stringify(callerAuthoredOverLimit));
    expect(() => readRelayCommandFile(canonicalDraftPath, "relay.draft.save"))
      .toThrow(/(?:64|migration|legacy)/i);

    const callerPublicationState = structuredClone(canonicalDraft) as any;
    callerPublicationState.operationId = "relay-caller-publication-state-001";
    callerPublicationState.action.draft.publishedRepoState = {
      branch: "main",
      head: "b".repeat(40),
      dirty: false,
      observedAt: "2026-08-29T00:00:00.000Z",
    };
    expect(validateRequest(callerPublicationState)).toBe(false);
    writeFileSync(canonicalDraftPath, JSON.stringify(callerPublicationState));
    expect(() => readRelayCommandFile(canonicalDraftPath, "relay.draft.save"))
      .toThrow();

    const invalidDrafts = [
      ...[
        "ws_not-a-ulid",
        MEMBER_ID,
        "ws_81ARZ3NDEKTSV4RRFFQ69G5FAV",
      ].map((id) => {
        const candidate = structuredClone(legacyDraft) as any;
        candidate.action.draft.workstream.id = id;
        return candidate;
      }),
      ...["src/relay\u0085.ts", "src/relay\u2028.ts", "src/relay\u2029.ts"].flatMap((path) => {
        const changedFile = structuredClone(canonicalDraft);
        changedFile.action.draft.changedFiles = [path];
        const fileEvidence = structuredClone(canonicalDraft);
        fileEvidence.action.draft.evidence = [{ kind: "file", path }];
        return [changedFile, fileEvidence];
      }),
    ];
    for (const [index, candidate] of invalidDrafts.entries()) {
      expect(validateRequest(candidate), `schema draft ${index}`).toBe(false);
      const candidatePath = join(root, `invalid-draft-${index}.json`);
      writeFileSync(candidatePath, JSON.stringify(candidate));
      expect(() => readRelayCommandFile(candidatePath, "relay.draft.save"), `runtime draft ${index}`)
        .toThrow();
    }

    const maxDraftId = `d${"a".repeat(127)}`;
    const boundedDelete = {
      operationId: "relay-draft-id-boundary-001",
      action: { kind: "relay.draft.delete", draftId: maxDraftId },
      expectedRevisions: [{
        target: { kind: "local", namespace: "relay-draft", id: maxDraftId },
        revision: "a".repeat(64),
      }],
    };
    expect(validateRequest(boundedDelete), JSON.stringify(validateRequest.errors)).toBe(true);
    const boundedPath = join(root, "bounded-delete.json");
    writeFileSync(boundedPath, JSON.stringify(boundedDelete));
    expect(readRelayCommandFile(boundedPath, "relay.draft.delete")).toEqual(boundedDelete);

    const oversizedDraftId = `${maxDraftId}a`;
    const oversizedDelete = structuredClone(boundedDelete);
    oversizedDelete.action.draftId = oversizedDraftId;
    oversizedDelete.expectedRevisions[0]!.target.id = oversizedDraftId;
    expect(validateRequest(oversizedDelete)).toBe(false);
    writeFileSync(boundedPath, JSON.stringify(oversizedDelete));
    expect(() => readRelayCommandFile(boundedPath, "relay.draft.delete")).toThrow();

    for (const [index, uri] of [
      "HTTPS://example.test/path",
      "http:example.test",
      "https://example.test/a b",
    ].entries()) {
      const withExternalEvidence = structuredClone(
        envelope.data.requestFile.examples[0]!.request,
      ) as any;
      withExternalEvidence.action.draft.evidence = [{ kind: "external", uri }];
      expect(
        validateRequest(withExternalEvidence),
        `${uri}: ${JSON.stringify(validateRequest.errors)}`,
      ).toBe(true);
      const uriPath = join(root, `external-uri-${index}.json`);
      writeFileSync(uriPath, JSON.stringify(withExternalEvidence));
      expect(readRelayCommandFile(uriPath, "relay.draft.save"))
        .toMatchObject({ action: { draft: { evidence: [{ kind: "external", uri }] } } });
    }
  });

  it("keeps schema acceptance aligned with the exact complete preview parser", () => {
    const lines: string[] = [];
    runRelayContract(
      { json: true },
      { write: (line) => lines.push(line), setExitCode: () => {} },
    );
    const contract = JSON.parse(lines[0]!).data as {
      catalog: Record<string, unknown>;
      requestFile: { schemaRef: string; examples: Array<{ request: unknown }> };
      applyFile: { schemaRef: string };
    };
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(contract.catalog);
    const validate = ajv.compile({ $ref: contract.applyFile.schemaRef });
    const root = mkdtempSync(join(tmpdir(), "mex-relay-preview-contract-"));
    roots.push(root);
    const path = join(root, "preview.json");

    const saveRequest = contract.requestFile.examples[0]!.request as any;
    const publishRequest = contract.requestFile.examples.find((example: any) =>
      example.request?.action?.kind === "relay.publish")!.request as any;
    const acknowledgeRequest = contract.requestFile.examples.find((example: any) =>
      example.request?.action?.kind === "relay.acknowledge")!.request as any;
    const draftId = publishRequest.action.draftId as string;
    const relayId = acknowledgeRequest.action.relayId as string;
    const revision = acknowledgeRequest.expectedRevisions[0].revision as string;
    const draftExpectation = [{
      target: { kind: "local", namespace: "relay-draft", id: draftId },
      revision,
    }];
    const relayExpectation = [{
      target: { kind: "artifact", path: `.mex/relays/${relayId}.md` },
      revision,
    }];
    const cases: Array<{
      command: RelayMutationCommandName;
      request: unknown;
      purposes: unknown[];
    }> = [
      {
        command: "relay.draft.save",
        request: saveRequest,
        purposes: [{ purpose: "relay-draft", id: draftId }],
      },
      {
        command: "relay.draft.save",
        request: {
          operationId: "relay-draft-update-example-001",
          action: { kind: "relay.draft.save", draftId, draft: saveRequest.action.draft },
          expectedRevisions: draftExpectation,
        },
        purposes: [],
      },
      {
        command: "relay.draft.delete",
        request: {
          operationId: "relay-draft-delete-example-001",
          action: { kind: "relay.draft.delete", draftId },
          expectedRevisions: draftExpectation,
        },
        purposes: [],
      },
      {
        command: "relay.publish",
        request: publishRequest,
        purposes: [
          { purpose: "activity", id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
          { purpose: "relay", id: relayId },
        ],
      },
      {
        command: "relay.acknowledge",
        request: acknowledgeRequest,
        purposes: [{ purpose: "activity", id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      },
      {
        command: "relay.close",
        request: {
          operationId: "relay-close-example-001",
          action: { kind: "relay.close", relayId },
          expectedRevisions: relayExpectation,
        },
        purposes: [{ purpose: "activity", id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      },
    ];

    for (const item of cases) {
      const preview = previewEnvelope(item.request, item.command, item.purposes);
      expect(validate(preview), `${item.command}: ${JSON.stringify(validate.errors)}`).toBe(true);
      writeFileSync(path, JSON.stringify(preview));
      expect(readRelayPreviewFile(path, item.command).request).toEqual(item.request);
    }

    const arbitraryGitEmail = previewEnvelope(
      saveRequest,
      "relay.draft.save",
      [{ purpose: "relay-draft", id: draftId }],
    ) as any;
    arbitraryGitEmail.data.receipt.authority.actor = {
      kind: "git",
      name: "Relay\u0085Agent\u2028Line\u2029Tail",
      email: "not-an-email",
    };
    expect(
      validate(arbitraryGitEmail),
      JSON.stringify(validate.errors),
    ).toBe(true);
    writeFileSync(path, JSON.stringify(arbitraryGitEmail));
    expect(readRelayPreviewFile(path, "relay.draft.save").receipt.authority.actor)
      .toEqual({
        kind: "git",
        name: "Relay\u0085Agent\u2028Line\u2029Tail",
        email: "not-an-email",
      });

    for (const [name, email] of [
      ["n".repeat(200), null],
      [null, "e".repeat(320)],
      ["\u0085", null],
    ] as const) {
      const bounded = structuredClone(arbitraryGitEmail) as any;
      bounded.data.receipt.authority.actor = { kind: "git", name, email };
      expect(validate(bounded), JSON.stringify(validate.errors)).toBe(true);
      writeFileSync(path, JSON.stringify(bounded));
      expect(readRelayPreviewFile(path, "relay.draft.save").receipt.authority.actor)
        .toEqual({ kind: "git", name, email });
    }

    for (const [name, email] of [
      ["n".repeat(201), null],
      [null, "e".repeat(321)],
      [null, null],
      [" Relay", null],
    ] as const) {
      const invalidActor = structuredClone(arbitraryGitEmail) as any;
      invalidActor.data.receipt.authority.actor = { kind: "git", name, email };
      expect(validate(invalidActor)).toBe(false);
      writeFileSync(path, JSON.stringify(invalidActor));
      expect(() => readRelayPreviewFile(path, "relay.draft.save")).toThrow();
    }

    const altered = structuredClone(previewEnvelope(
      saveRequest,
      "relay.draft.save",
      [{ purpose: "relay-draft", id: draftId }],
    )) as any;
    altered.data.receipt.purposeIds[0].purpose = "relay";
    altered.data.receipt.purposeIds[0].id = "relay_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(validate(altered)).toBe(false);
    writeFileSync(path, JSON.stringify(altered));
    expect(() => readRelayPreviewFile(path, "relay.draft.save"))
      .toThrow("purpose IDs do not match");

    const wrongLifecycleTarget = structuredClone(previewEnvelope(
      cases.at(-1)!.request,
      "relay.close",
      [{ purpose: "activity", id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    )) as any;
    wrongLifecycleTarget.data.request.expectedRevisions[0].target.path =
      ".mex/team/members/member_01ARZ3NDEKTSV4RRFFQ69G5FAV.md";
    expect(validate(wrongLifecycleTarget)).toBe(false);
    writeFileSync(path, JSON.stringify(wrongLifecycleTarget));
    expect(() => readRelayPreviewFile(path, "relay.close"))
      .toThrow();

    const legacyPublishRequest = structuredClone(publishRequest) as any;
    legacyPublishRequest.expectedRevisions.push({
      target: { kind: "artifact", path: `.mex/workstreams/${WORKSTREAM_ID}.md` },
      revision: REVISION,
    });
    const legacyPublishPreview = previewEnvelope(
      legacyPublishRequest,
      "relay.publish",
      [
        { purpose: "activity", id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        { purpose: "relay", id: relayId },
      ],
    );
    expect(validate(legacyPublishPreview), JSON.stringify(validate.errors)).toBe(true);
    writeFileSync(path, JSON.stringify(legacyPublishPreview));
    expect(readRelayPreviewFile(path, "relay.publish").request)
      .toEqual(legacyPublishRequest);

    const legacyDraftRequest = {
      operationId: "relay-legacy-preview-full-evidence-001",
      action: {
        kind: "relay.draft.save",
        draft: legacyDraftInput(Array.from({ length: 64 }, (_, index) => ({
          kind: "manual",
          note: `Legacy evidence ${String(index).padStart(2, "0")}`,
        }))),
      },
      expectedRevisions: [],
    };
    const legacyRequestPath = join(root, "legacy-full-request.json");
    writeFileSync(legacyRequestPath, JSON.stringify(legacyDraftRequest));
    const normalizedLegacyRequest = readRelayCommandFile(
      legacyRequestPath,
      "relay.draft.save",
    );
    const translatedPreview = previewEnvelope(
      normalizedLegacyRequest,
      "relay.draft.save",
      [{ purpose: "relay-draft", id: "relay-legacy-preview-created" }],
    );
    expect(validate(translatedPreview), JSON.stringify(validate.errors)).toBe(true);
    writeFileSync(path, JSON.stringify(translatedPreview));
    expect((readRelayPreviewFile(path, "relay.draft.save").request as any).action.draft.evidence)
      .toHaveLength(65);
  });

  it("does not require JSON mode or repository state", () => {
    const lines: string[] = [];
    let exit = -1;
    runRelayContract(
      {},
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );
    expect(exit).toBe(0);
    expect(lines).toEqual([
      "Run mex relay contract --json to emit the versioned machine contract catalog.",
    ]);
  });

  it("projects every supported action into a strict self-contained request closure", () => {
    for (const action of RELAY_CONTRACT_ACTIONS) {
      const lines: string[] = [];
      let exit = -1;
      runRelayContract(
        { action, json: true },
        { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
      );

      expect(exit, action).toBe(0);
      expect(lines, action).toHaveLength(1);
      expect(Buffer.byteLength(lines[0]!, "utf8"), action)
        .toBeLessThanOrEqual(RELAY_ACTION_CONTRACT_MAX_BYTES);
      const envelope = JSON.parse(lines[0]!) as {
        data: {
          action: string;
          catalog?: unknown;
          commands: {
            preview: { id: string; usage: string; inputContract: string };
            apply: { id: string; usage: string; inputContract: string };
          };
          requestFile: {
            schemaRef: string;
            schema: Record<string, unknown>;
            examples: Array<{ request: unknown }>;
          };
        };
      };
      expect(envelope.data.action).toBe(action);
      expect(envelope.data).not.toHaveProperty("catalog");
      expect(envelope.data.commands.preview.id).toBe(`${action}.preview`);
      expect(envelope.data.commands.apply.id).toBe(`${action}.apply`);
      expect(envelope.data.commands.preview.inputContract)
        .toBe(envelope.data.requestFile.schemaRef);
      expect(JSON.stringify(envelope.data.requestFile.schema)).not.toContain("previewEnvelope");

      const ajv = new Ajv2020({ strict: true });
      const validate = ajv.compile(envelope.data.requestFile.schema);
      for (const example of envelope.data.requestFile.examples) {
        expect(validate(example.request), `${action}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });

  it("keeps the common draft selector smaller than the full catalog and rejects other actions", () => {
    const full: string[] = [];
    const focused: string[] = [];
    runRelayContract(
      { json: true },
      { write: (line) => full.push(line), setExitCode: () => {} },
    );
    runRelayContract(
      { action: "relay.draft.save", json: true },
      { write: (line) => focused.push(line), setExitCode: () => {} },
    );
    expect(Buffer.byteLength(focused[0]!, "utf8"))
      .toBeLessThan(Buffer.byteLength(full[0]!, "utf8"));

    const data = (JSON.parse(focused[0]!) as any).data;
    const validateContent = new Ajv2020({ strict: true }).compile(data.localSave.contentFile.schema);
    expect(validateContent({ summary: "Continue tomorrow." })).toBe(true);
    expect(validateContent({ summary: "For Sam once resolved.", audience: "members", recipients: [] })).toBe(true);
    expect(validateContent({ summary: "Conflicting audience.", audience: "team", recipients: [{ kind: "member", memberId: MEMBER_ID }] })).toBe(false);
    expect(validateContent({ summary: "No caller authority.", actor: { kind: "unknown" } })).toBe(false);
    expect(validateContent({ summary: "Invalid audience.", audience: "everyone" })).toBe(false);
    const validate = new Ajv2020({ strict: true }).compile(data.requestFile.schema);
    const save = structuredClone(data.requestFile.examples[0].request);
    expect(validate(save), JSON.stringify(validate.errors)).toBe(true);
    save.action = {
      kind: "relay.close",
      relayId: "relay_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    expect(validate(save)).toBe(false);
  });

  it("uses the typed Team usage exit for an invalid selector", () => {
    const lines: string[] = [];
    let exit = -1;
    runRelayContract(
      { action: "relay.not-real", json: true },
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );
    expect(exit).toBe(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      command: "relay.contract",
      mode: "read",
      ok: false,
      data: null,
      problem: { code: "INVALID_REQUEST" },
    });
  });
});

function legacyDraftInput(evidence: unknown[] = []): Record<string, unknown> {
  return {
    recipients: [{ kind: "member", memberId: MEMBER_ID }],
    workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Legacy lane" },
    summary: "Continue the legacy Relay handoff.",
    completed: [],
    inProgress: [],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: [],
    code: [],
    evidence,
    nextActions: [],
  };
}

function previewEnvelope(
  request: unknown,
  command: RelayMutationCommandName = "relay.draft.save",
  purposeIds: unknown[] = [{ purpose: "relay-draft", id: "relay-draft-example" }],
): unknown {
  const diagnostics: unknown[] = [];
  return {
    schemaVersion: 1,
    command,
    mode: "preview",
    ok: true,
    data: {
      schemaVersion: 1,
      request,
      preview: {
        valid: true,
        scope: "local",
        changes: [],
        localChanges: [],
        diagnostics,
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: { kind: "unknown" },
          occurredAt: "2026-08-29T00:00:00.000Z",
          repoState: {
            branch: "main",
            head: "b".repeat(40),
            dirty: false,
            observedAt: "2026-08-29T00:00:00.000Z",
          },
        },
        purposeIds,
        requestRevision: "c".repeat(64),
        presentationRevision: "d".repeat(64),
        previewRevision: "e".repeat(64),
      },
    },
    diagnostics,
    problem: null,
  };
}

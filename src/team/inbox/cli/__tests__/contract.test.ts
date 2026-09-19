import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  INBOX_ACTION_CONTRACT_MAX_BYTES,
  INBOX_CONTRACT_ACTIONS,
} from "../../../../capabilities.js";
import { TEAM_INBOX_SPEC_LIMITS } from "../../../contracts/workflow.js";
import { runInboxContract } from "../contract.js";
import { normalizeTeamInboxSpecCommand } from "../../spec-authoring.js";

describe("Inbox contract resolver CLI", () => {
  it("keeps knowledge creates/corrections and legacy Specs aligned with the request parser", () => {
    const lines: string[] = [];
    runInboxContract({ action: "inbox.draft.save", json: true }, {
      write: (line) => lines.push(line), setExitCode: () => {},
    });
    const data = JSON.parse(lines[0]!).data;
    const validate = new Ajv2020({ strict: true }).compile(data.requestFile.schema);
    const id = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const make = (change: unknown, targetRevisions: unknown[] = []) => ({
      operationId: "capture-decision", expectedRevisions: [],
      action: { kind: "inbox.draft.save", draft: { change, rationale: "Capture our decision.", evidence: [], targetRevisions } },
    });
    const check = (request: unknown, accepted: boolean) => {
      expect(validate(request), JSON.stringify(validate.errors)).toBe(accepted);
      if (accepted) expect(() => normalizeTeamInboxSpecCommand(request)).not.toThrow();
      else expect(() => normalizeTeamInboxSpecCommand(request)).toThrow();
    };
    for (const entityKind of ["architecture", "component", "convention", "decision", "pattern", "guide"]) {
      const create = { kind: "knowledge.create", entityKind, title: "Shared decision", body: "Durable context.", status: "promoted" };
      check(make(create), true);
      check(make({ ...create, path: "context/arbitrary.md" }), false);
      check(make({ ...create, relation: { type: "related_to", target: { id, kind: entityKind } } }), false);
      const update = { kind: "knowledge.update", target: { id, kind: entityKind }, patch: { body: "Corrected context." } };
      const revisions = [{ target: { kind: "entity", id }, revision: "a".repeat(64), semanticRevision: 1 }];
      check(make(update, revisions), true);
      check(make(update), false);
      check(make({ ...update, patch: {} }, revisions), false);
    }
    check(make({ kind: "knowledge.create", entityKind: "spec", title: "Scope", body: "Scope.", status: "promoted" }), false);
    check(make({ kind: "spec.create", entityKind: "spec", title: "Scope", body: "Scope.", status: "in_flight" }), true);
  });
  it("returns one bounded static catalog whose roots and examples strict-compile", () => {
    const lines: string[] = [];
    let exit = -1;
    runInboxContract(
      { json: true },
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );

    expect(exit).toBe(0);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!, "utf8")).toBeLessThanOrEqual(
      TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes,
    );
    const envelope = JSON.parse(lines[0]!) as {
      schemaVersion: number;
      command: string;
      mode: string;
      ok: boolean;
      data: {
        catalog: Record<string, unknown>;
        requestFile: { schemaRef: string; examples: Array<{ request: unknown }> };
        applyFile: { schemaRef: string; requirement: string };
      };
    };
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      command: "inbox.contract",
      mode: "read",
      ok: true,
      data: {
        catalogVersion: 1,
        contractId: "team.inbox.contract-catalog.v1",
        mediaType: "application/schema+json",
        encoding: "utf-8",
      },
    });
    expect(envelope.data.applyFile.requirement).toContain("exact complete successful");

    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(envelope.data.catalog);
    const validateRequest = ajv.compile({ $ref: envelope.data.requestFile.schemaRef });
    const validatePreview = ajv.compile({ $ref: envelope.data.applyFile.schemaRef });
    expect(validatePreview).toBeTypeOf("function");
    for (const name of [
      "operationId", "revision", "memberId", "workstreamId", "canonicalText", "gitAlias",
      "memberArtifactExpectation", "workstreamArtifactExpectation", "entityExpectation",
      "artifactExpectation", "localExpectation", "expectation", "expectations",
      "nonEmptyExpectations", "entityRef", "codeRef", "actorRef", "canonicalRepoPath",
      "actorSet", "entitySet", "codeSet", "pathSet", "workstreamCreateInput",
      "workstreamUpdatePatch", "activitySubject", "memberAddAction", "memberUpdateAction",
      "memberDeactivateAction", "memberSelectAction", "memberClearAction",
      "activityRecordAction", "workstreamCreateAction", "workstreamUpdateAction",
      "workstreamArchiveAction", "memberAddRequest", "memberUpdateRequest",
      "memberDeactivateRequest", "memberSelectRequest", "memberSelectOnlyRequest",
      "memberClearRequest", "activityRecordRequest", "workstreamCreateRequest",
      "workstreamUpdateRequest", "workstreamArchiveRequest",
    ]) {
      expect(ajv.compile({
        $ref: `https://mex.dev/contracts/team-identity-activity-request-v1.json#/$defs/${name}`,
      })).toBeTypeOf("function");
    }
    for (const example of envelope.data.requestFile.examples) {
      expect(validateRequest(example.request), JSON.stringify(validateRequest.errors)).toBe(true);
    }

    const legacyRef = (name: string) => ajv.compile({
      $ref: `https://mex.dev/contracts/team-identity-activity-request-v1.json#/$defs/${name}`,
    });
    const memberId = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const revision = "a".repeat(64);
    const memberExpectation = {
      target: { kind: "artifact", path: `.mex/team/members/${memberId}.md` },
      revision,
    };
    expect(legacyRef("memberArtifactExpectation")(memberExpectation)).toBe(true);
    expect(legacyRef("memberArtifactExpectation")({
      target: { kind: "artifact", path: ".mex/team/members/not-a-member.md" },
      revision: null,
    })).toBe(false);
    expect(legacyRef("memberDeactivateAction")({ kind: "member.deactivate", memberId })).toBe(true);
    expect(legacyRef("memberDeactivateAction")({ kind: "member.select", memberId })).toBe(false);
    expect(legacyRef("memberSelectAction")({ kind: "member.select", memberId })).toBe(true);
    expect(legacyRef("memberSelectAction")({ kind: "member.deactivate", memberId })).toBe(false);
    const request = (kind: "member.select" | "member.clear") => ({
      operationId: `legacy-${kind}`,
      action: kind === "member.select" ? { kind, memberId } : { kind },
      expectedRevisions: [memberExpectation],
    });
    expect(legacyRef("memberSelectOnlyRequest")(request("member.select"))).toBe(true);
    expect(legacyRef("memberSelectOnlyRequest")(request("member.clear"))).toBe(false);
    expect(legacyRef("memberClearRequest")(request("member.clear"))).toBe(true);
    expect(legacyRef("memberClearRequest")(request("member.select"))).toBe(false);
  });

  it("does not require JSON mode to remain bounded or touch a service", () => {
    const lines: string[] = [];
    let exit = -1;
    runInboxContract(
      {},
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );
    expect(exit).toBe(0);
    expect(lines).toEqual([
      "Run mex inbox contract --json to emit the versioned machine contract catalog.",
    ]);
  });

  it("projects every supported action into a strict self-contained request closure", () => {
    for (const action of INBOX_CONTRACT_ACTIONS) {
      const lines: string[] = [];
      let exit = -1;
      runInboxContract(
        { action, json: true },
        { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
      );

      expect(exit, action).toBe(0);
      expect(lines, action).toHaveLength(1);
      expect(Buffer.byteLength(lines[0]!, "utf8"), action)
        .toBeLessThanOrEqual(INBOX_ACTION_CONTRACT_MAX_BYTES);
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

  it("keeps the draft selector smaller than the full catalog and rejects other actions", () => {
    const full: string[] = [];
    const focused: string[] = [];
    runInboxContract(
      { json: true },
      { write: (line) => full.push(line), setExitCode: () => {} },
    );
    runInboxContract(
      { action: "inbox.draft.save", json: true },
      { write: (line) => focused.push(line), setExitCode: () => {} },
    );
    expect(Buffer.byteLength(focused[0]!, "utf8"))
      .toBeLessThan(Buffer.byteLength(full[0]!, "utf8"));

    const data = (JSON.parse(focused[0]!) as any).data;
    const validate = new Ajv2020({ strict: true }).compile(data.requestFile.schema);
    const save = structuredClone(data.requestFile.examples[0].request);
    expect(validate(save), JSON.stringify(validate.errors)).toBe(true);
    save.action = {
      kind: "inbox.approve",
      proposalId: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    expect(validate(save)).toBe(false);
  });

  it("uses the typed Team usage exit for an invalid selector", () => {
    const lines: string[] = [];
    let exit = -1;
    runInboxContract(
      { action: "inbox.not-real", json: true },
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );
    expect(exit).toBe(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      command: "inbox.contract",
      mode: "read",
      ok: false,
      data: null,
      problem: { code: "INVALID_REQUEST" },
    });
  });
});

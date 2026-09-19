import {
  projectLocalSchemaClosure,
  projectSchemaDefinition,
} from "../../cli/contract-projection.js";

/** Repository-independent Checkpoint F Relay contract identifiers. */
export const RELAY_REQUEST_CONTRACT_ID = "team.relay.request.v1" as const;
export const RELAY_PREVIEW_CONTRACT_ID = "team.relay.preview-envelope.v1" as const;
export const RELAY_CONTRACT_CATALOG_ID = "team.relay.contract-catalog.v1" as const;
export const RELAY_CONTRACT_DESCRIPTOR_ID = "relay.contract" as const;
export const RELAY_CONTRACT_COMMAND = "mex relay contract --json" as const;
export const RELAY_REQUEST_SCHEMA_ID =
  "https://mex.dev/contracts/team-relay-request-v1.json" as const;
export const RELAY_PREVIEW_SCHEMA_ID =
  "https://mex.dev/contracts/team-relay-preview-envelope-v1.json" as const;

export const RELAY_CLI_MAX_ENVELOPE_BYTES = 64 * 1024;
export const RELAY_CLI_MAX_RECIPIENTS = 32;
export const RELAY_ACTION_CONTRACT_MAX_BYTES = 32 * 1024;

export const RELAY_CONTRACT_ACTIONS = Object.freeze([
  "relay.draft.save",
  "relay.draft.delete",
  "relay.publish",
  "relay.acknowledge",
  "relay.close",
] as const);

export type RelayContractAction = (typeof RELAY_CONTRACT_ACTIONS)[number];

const MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RELAY_ID = "relay_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVISION = "a".repeat(64);

const REQUEST_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $id: RELAY_REQUEST_SCHEMA_ID,
  $comment:
    "Runtime additionally requires NFC product text without lone surrogates, UTF-8 byte ceilings, canonical repository paths, WHATWG-valid credential-free HTTP(S) URLs, unique recipient memberIds, canonical set ordering, exact unique expectation coverage, and an active sender immediately before publish, plus active recipients for named audiences. Sparse standalone drafts are normalized before hashing. A pre-v3 Workstream draft field is accepted only as a read-time migration input and becomes entity evidence. Service-issued Git actor fields use their separately declared normalized fallback domain.",
  $ref: "#/$defs/command",
  $defs: {
    operationId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    nullableRevision: {
      anyOf: [{ $ref: "#/$defs/revision" }, { type: "null" }],
    },
    localId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    },
    memberId: {
      type: "string",
      pattern: "^member_[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    },
    workstreamId: {
      type: "string",
      pattern: "^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    },
    relayId: {
      type: "string",
      pattern: "^relay_[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    },
    eventId: {
      type: "string",
      pattern: "^event_[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    },
    singleLine: {
      type: "string",
      minLength: 1,
      pattern:
        "^(?!\\s)(?![\\s\\S]*\\s$)[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$",
    },
    gitActorName: {
      $comment: "Runtime enforces the service-issued 200-byte UTF-8 ceiling and NFC normalization.",
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^(?!\\s)(?![\\s\\S]*\\s$)[^\\u0000-\\u001f\\u007f]+$",
    },
    gitActorEmail: {
      $comment: "Runtime enforces the service-issued 320-byte UTF-8 ceiling and NFC normalization.",
      type: "string",
      minLength: 1,
      maxLength: 320,
      pattern: "^(?!\\s)(?![\\s\\S]*\\s$)[^\\u0000-\\u001f\\u007f]+$",
    },
    text512: { $ref: "#/$defs/singleLine", type: "string", maxLength: 512 },
    text1024: { $ref: "#/$defs/singleLine", type: "string", maxLength: 1_024 },
    text4096: { $ref: "#/$defs/singleLine", type: "string", maxLength: 4_096 },
    text8192: { $ref: "#/$defs/singleLine", type: "string", maxLength: 8_192 },
    repoPath: {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
      pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$",
    },
    memberRef: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "memberId"],
      properties: {
        kind: { const: "member" },
        memberId: { $ref: "#/$defs/memberId" },
        displayName: { $ref: "#/$defs/text512" },
      },
    },
    actorRef: {
      type: "object",
      unevaluatedProperties: false,
      oneOf: [
        { $ref: "#/$defs/memberRef" },
        {
          required: ["kind", "name", "email"],
          properties: {
            kind: { const: "git" },
            name: { anyOf: [{ $ref: "#/$defs/gitActorName" }, { type: "null" }] },
            email: {
              anyOf: [
                { $ref: "#/$defs/gitActorEmail" },
                { type: "null" },
              ],
            },
          },
          not: {
            required: ["name", "email"],
            properties: { name: { type: "null" }, email: { type: "null" } },
          },
        },
        { required: ["kind"], properties: { kind: { const: "unknown" } } },
      ],
    },
    entityRef: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind"],
      properties: {
        id: { $ref: "#/$defs/singleLine", type: "string", maxLength: 256 },
        kind: { $ref: "#/$defs/singleLine", type: "string", maxLength: 64 },
        title: { $ref: "#/$defs/text512" },
      },
    },
    workstreamRef: {
      $ref: "#/$defs/entityRef",
      type: "object",
      properties: {
        id: { $ref: "#/$defs/workstreamId" },
        kind: { const: "workstream" },
      },
    },
    codeRef: {
      type: "object",
      unevaluatedProperties: false,
      oneOf: [
        {
          required: ["kind", "symbolId"],
          properties: {
            kind: { const: "symbol" },
            symbolId: { $ref: "#/$defs/text1024" },
            fingerprint: { $ref: "#/$defs/text1024" },
          },
        },
        {
          required: ["kind", "path"],
          properties: {
            kind: { const: "file" },
            path: { $ref: "#/$defs/repoPath" },
            fingerprint: { $ref: "#/$defs/text1024" },
          },
        },
      ],
    },
    evidence: {
      type: "object",
      unevaluatedProperties: false,
      oneOf: [
        {
          required: ["kind", "entity"],
          properties: { kind: { const: "entity" }, entity: { $ref: "#/$defs/entityRef" } },
        },
        {
          required: ["kind", "code"],
          properties: { kind: { const: "code" }, code: { $ref: "#/$defs/codeRef" } },
        },
        {
          required: ["kind", "hash"],
          properties: {
            kind: { const: "commit" },
            hash: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
          },
        },
        {
          required: ["kind", "path"],
          properties: { kind: { const: "file" }, path: { $ref: "#/$defs/repoPath" } },
        },
        {
          required: ["kind", "uri"],
          properties: {
            kind: { const: "external" },
            uri: {
              $ref: "#/$defs/text4096",
              type: "string",
              pattern: "^[Hh][Tt][Tt][Pp][Ss]?:",
            },
            label: { $ref: "#/$defs/text512" },
          },
        },
        {
          required: ["kind", "note"],
          properties: { kind: { const: "manual" }, note: { $ref: "#/$defs/text4096" } },
        },
      ],
    },
    textList: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { $ref: "#/$defs/text4096" },
    },
    standaloneDraft: {
      type: "object",
      additionalProperties: false,
      required: ["recipients", "summary"],
      properties: {
        audience: { enum: ["team", "members"] },
        recipients: {
          type: "array",
          maxItems: RELAY_CLI_MAX_RECIPIENTS,
          uniqueItems: true,
          items: { $ref: "#/$defs/memberRef" },
        },
        summary: { $ref: "#/$defs/text8192" },
        completed: { $ref: "#/$defs/textList" },
        inProgress: { $ref: "#/$defs/textList" },
        decisions: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: { $ref: "#/$defs/entityRef" },
        },
        blockers: { $ref: "#/$defs/textList" },
        unresolvedQuestions: { $ref: "#/$defs/textList" },
        changedFiles: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: { $ref: "#/$defs/repoPath" },
        },
        code: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: { $ref: "#/$defs/codeRef" },
        },
        evidence: {
          type: "array",
          $comment:
            "The 65th slot is reserved for a normalized pre-v3 Workstream-to-evidence migration. Caller-authored standalone requests remain runtime-limited to 64 entries.",
          maxItems: 65,
          items: { $ref: "#/$defs/evidence" },
        },
        nextActions: { $ref: "#/$defs/textList" },
      },
      allOf: [{
        if: { required: ["audience"], properties: { audience: { const: "team" } } },
        then: { properties: { recipients: { type: "array", maxItems: 0 } } },
      }],
    },
    legacyDraft: {
      $comment:
        "Read-time compatibility input only. The Workstream reference is translated to entity evidence before hashing or persistence.",
      type: "object",
      additionalProperties: false,
      required: ["recipients", "workstream", "summary"],
      properties: {
        recipients: {
          type: "array",
          minItems: 1,
          maxItems: RELAY_CLI_MAX_RECIPIENTS,
          uniqueItems: true,
          items: { $ref: "#/$defs/memberRef" },
        },
        workstream: { $ref: "#/$defs/workstreamRef" },
        summary: { $ref: "#/$defs/text8192" },
        completed: { $ref: "#/$defs/textList" },
        inProgress: { $ref: "#/$defs/textList" },
        decisions: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: { $ref: "#/$defs/entityRef" },
        },
        blockers: { $ref: "#/$defs/textList" },
        unresolvedQuestions: { $ref: "#/$defs/textList" },
        changedFiles: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: { $ref: "#/$defs/repoPath" },
        },
        code: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: { $ref: "#/$defs/codeRef" },
        },
        evidence: {
          type: "array",
          maxItems: 64,
          items: { $ref: "#/$defs/evidence" },
        },
        nextActions: { $ref: "#/$defs/textList" },
      },
    },
    draft: {
      oneOf: [
        { $ref: "#/$defs/standaloneDraft" },
        { $ref: "#/$defs/legacyDraft" },
      ],
    },
    localExpectation: {
      type: "object",
      additionalProperties: false,
      required: ["target", "revision"],
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "namespace", "id"],
          properties: {
            kind: { const: "local" },
            namespace: { const: "relay-draft" },
            id: { $ref: "#/$defs/localId" },
          },
        },
        revision: { $ref: "#/$defs/revision" },
      },
    },
    artifactExpectation: {
      type: "object",
      additionalProperties: false,
      required: ["target", "revision"],
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path"],
          properties: {
            kind: { const: "artifact" },
            path: { $ref: "#/$defs/repoPath" },
          },
        },
        revision: { $ref: "#/$defs/revision" },
      },
    },
    memberExpectation: {
      $ref: "#/$defs/artifactExpectation",
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            path: {
              type: "string",
              pattern: "^\\.mex/team/members/member_[0-7][0-9A-HJKMNP-TV-Z]{25}\\.md$",
            },
          },
        },
      },
    },
    publishArtifactExpectation: {
      $ref: "#/$defs/memberExpectation",
    },
    publishExpectation: {
      oneOf: [
        { $ref: "#/$defs/localExpectation" },
        { $ref: "#/$defs/memberExpectation" },
      ],
    },
    relayExpectation: {
      $ref: "#/$defs/artifactExpectation",
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            path: {
              type: "string",
              pattern: "^\\.mex/relays/relay_[0-7][0-9A-HJKMNP-TV-Z]{25}\\.md$",
            },
          },
        },
      },
    },
    expectation: {
      oneOf: [
        { $ref: "#/$defs/localExpectation" },
        { $ref: "#/$defs/publishArtifactExpectation" },
        { $ref: "#/$defs/relayExpectation" },
      ],
    },
    saveAction: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "draft"],
      properties: {
        kind: { const: "relay.draft.save" },
        draftId: { $ref: "#/$defs/localId" },
        draft: { $ref: "#/$defs/draft" },
      },
    },
    deleteAction: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "draftId"],
      properties: {
        kind: { const: "relay.draft.delete" },
        draftId: { $ref: "#/$defs/localId" },
      },
    },
    publishAction: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "draftId"],
      properties: {
        kind: { const: "relay.publish" },
        draftId: { $ref: "#/$defs/localId" },
      },
    },
    relayAction: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "relayId"],
      properties: {
        kind: { enum: ["relay.acknowledge", "relay.close"] },
        relayId: { $ref: "#/$defs/relayId" },
      },
    },
    command: {
      type: "object",
      additionalProperties: false,
      required: ["operationId", "action", "expectedRevisions"],
      properties: {
        operationId: { $ref: "#/$defs/operationId" },
        action: {
          oneOf: [
            { $ref: "#/$defs/saveAction" },
            { $ref: "#/$defs/deleteAction" },
            { $ref: "#/$defs/publishAction" },
            { $ref: "#/$defs/relayAction" },
          ],
        },
        expectedRevisions: {
          type: "array",
          maxItems: 33,
          uniqueItems: true,
          items: { $ref: "#/$defs/expectation" },
        },
      },
      allOf: [
        {
          if: {
            properties: {
              action: {
                type: "object",
                properties: { kind: { const: "relay.draft.save" } },
                not: { required: ["draftId"], properties: { draftId: {} } },
              },
            },
          },
          then: { properties: { expectedRevisions: { type: "array", maxItems: 0 } } },
        },
        {
          if: {
            properties: {
              action: {
                type: "object",
                required: ["draftId"],
                properties: {
                  kind: { enum: ["relay.draft.save", "relay.draft.delete"] },
                  draftId: {},
                },
              },
            },
          },
          then: {
            properties: {
              expectedRevisions: {
                type: "array",
                minItems: 1,
                maxItems: 1,
                items: { $ref: "#/$defs/localExpectation" },
              },
            },
          },
        },
        {
          if: {
            properties: { action: { type: "object", properties: { kind: { const: "relay.publish" } } } },
          },
          then: {
            properties: {
              expectedRevisions: {
                type: "array",
                minItems: 1,
                maxItems: 33,
                items: { $ref: "#/$defs/publishExpectation" },
                allOf: [
                  {
                    contains: { $ref: "#/$defs/localExpectation" },
                    minContains: 1,
                    maxContains: 1,
                  },
                  {
                    contains: { $ref: "#/$defs/memberExpectation" },
                    minContains: 0,
                    maxContains: 32,
                  },
                ],
              },
            },
          },
        },
        {
          if: {
            properties: {
              action: {
                type: "object",
                properties: { kind: { enum: ["relay.acknowledge", "relay.close"] } },
              },
            },
          },
          then: {
            properties: {
              expectedRevisions: {
                type: "array",
                minItems: 1,
                maxItems: 1,
                items: { $ref: "#/$defs/relayExpectation" },
              },
            },
          },
        },
      ],
    },
  },
});

function focusedRelayRequestSchema(action: RelayContractAction): Readonly<Record<string, unknown>> {
  const command = projectSchemaDefinition(REQUEST_SCHEMA, "command") as Record<string, unknown>;
  const commandProperties = command.properties as Record<string, unknown>;
  const commandConditions = command.allOf as Record<string, unknown>[];
  const selection = relayActionSchemaSelection(action);
  const selectedAction = projectSchemaDefinition(
    REQUEST_SCHEMA,
    selection.actionDefinition,
  ) as Record<string, unknown>;

  if (selection.runtimeAction === "relay.acknowledge" || selection.runtimeAction === "relay.close") {
    const properties = selectedAction.properties as Record<string, unknown>;
    properties.kind = { const: selection.runtimeAction };
  }
  commandProperties.action = selectedAction;
  commandProperties.expectedRevisions = selection.expectedRevisions;
  if (selection.conditionIndexes.length === 0) delete command.allOf;
  else {
    command.allOf = selection.conditionIndexes.map(
      (index) => structuredClone(commandConditions[index]!),
    );
  }

  return projectLocalSchemaClosure({
    id: `${RELAY_REQUEST_SCHEMA_ID}?action=${encodeURIComponent(action)}`,
    source: REQUEST_SCHEMA,
    root: command,
  });
}

function relayActionSchemaSelection(action: RelayContractAction): {
  actionDefinition: "saveAction" | "deleteAction" | "publishAction" | "relayAction";
  conditionIndexes: readonly number[];
  runtimeAction: RelayContractAction;
  expectedRevisions: Readonly<Record<string, unknown>>;
} {
  switch (action) {
    case "relay.draft.save":
      return {
        actionDefinition: "saveAction",
        conditionIndexes: [0, 1],
        runtimeAction: action,
        expectedRevisions: {
          type: "array",
          maxItems: 1,
          uniqueItems: true,
          items: { $ref: "#/$defs/localExpectation" },
        },
      };
    case "relay.draft.delete":
      return {
        actionDefinition: "deleteAction",
        conditionIndexes: [],
        runtimeAction: action,
        expectedRevisions: {
          type: "array",
          minItems: 1,
          maxItems: 1,
          uniqueItems: true,
          items: { $ref: "#/$defs/localExpectation" },
        },
      };
    case "relay.publish":
      return {
        actionDefinition: "publishAction",
        conditionIndexes: [],
        runtimeAction: action,
        expectedRevisions: {
          type: "array",
          minItems: 1,
          maxItems: 33,
          uniqueItems: true,
          items: { $ref: "#/$defs/publishExpectation" },
          allOf: [
            {
              contains: { $ref: "#/$defs/localExpectation" },
              minContains: 1,
              maxContains: 1,
            },
            {
              contains: { $ref: "#/$defs/memberExpectation" },
              minContains: 0,
              maxContains: 32,
            },
          ],
        },
      };
    case "relay.acknowledge":
    case "relay.close":
      return {
        actionDefinition: "relayAction",
        conditionIndexes: [],
        runtimeAction: action,
        expectedRevisions: {
          type: "array",
          minItems: 1,
          maxItems: 1,
          uniqueItems: true,
          items: { $ref: "#/$defs/relayExpectation" },
        },
      };
  }
}

const PREVIEW_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $id: RELAY_PREVIEW_SCHEMA_ID,
  $comment:
    "Apply also verifies the exact signed request, presentation, authority, repository, target revisions, preview age, and idempotency record.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "command", "mode", "ok", "data", "diagnostics", "problem"],
  properties: {
    schemaVersion: { const: 1 },
    command: {
      enum: [
        "relay.draft.save", "relay.draft.delete", "relay.publish",
        "relay.acknowledge", "relay.close",
      ],
    },
    mode: { const: "preview" },
    ok: { const: true },
    data: { $ref: "#/$defs/servicePreview" },
    diagnostics: { $ref: "#/$defs/diagnostics" },
    problem: { type: "null" },
  },
  oneOf: [
    "relay.draft.save", "relay.draft.delete", "relay.publish",
    "relay.acknowledge", "relay.close",
  ].map((command) => ({
    type: "object",
    properties: {
      command: { const: command },
      data: {
        type: "object",
        required: ["request"],
        properties: {
          request: {
            type: "object",
            required: ["action"],
            properties: {
              action: {
                type: "object",
                required: ["kind"],
                properties: { kind: { const: command } },
              },
            },
          },
        },
      },
    },
  })),
  $defs: {
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    timestamp: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
    },
    actorRef: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/actorRef` },
    repoPath: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/repoPath` },
    diagnostic: {
      type: "object",
      additionalProperties: false,
      required: ["code", "severity", "message"],
      properties: {
        code: {
          $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/singleLine`,
          type: "string",
          maxLength: 256,
        },
        severity: { enum: ["error", "warning", "info"] },
        message: {
          $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/singleLine`,
          type: "string",
          maxLength: 4_096,
        },
        path: { $ref: "#/$defs/repoPath" },
        location: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { $ref: "#/$defs/repoPath" },
            startLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            endLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            startOffset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            endOffset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            headingDepth: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
        entity: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/entityRef` },
        remediation: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label"],
            properties: {
              label: {
                $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/singleLine`,
                type: "string",
                maxLength: 4_096,
              },
              command: {
                $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/singleLine`,
                type: "string",
                maxLength: 4_096,
              },
              route: {
                $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/singleLine`,
                type: "string",
                maxLength: 4_096,
              },
            },
          },
        },
        detail: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/json" },
        },
      },
    },
    json: {
      anyOf: [
        { type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string" },
        { type: "array", items: { $ref: "#/$defs/json" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/json" } },
      ],
    },
    diagnostics: {
      type: "array",
      maxItems: 50,
      items: { $ref: "#/$defs/diagnostic" },
    },
    fileChange: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "path", "diff", "beforeRevision", "afterRevision"],
      properties: {
        kind: { enum: ["create", "update", "delete", "move"] },
        path: { $ref: "#/$defs/repoPath" },
        previousPath: { $ref: "#/$defs/repoPath" },
        diff: { type: "string" },
        beforeRevision: {
          anyOf: [{ $ref: "#/$defs/revision" }, { type: "null" }],
        },
        afterRevision: {
          anyOf: [{ $ref: "#/$defs/revision" }, { type: "null" }],
        },
      },
      allOf: [
        {
          if: { type: "object", properties: { kind: { const: "move" } } },
          then: { type: "object", required: ["previousPath"], properties: { previousPath: {} } },
          else: { not: { type: "object", required: ["previousPath"], properties: { previousPath: {} } } },
        },
        {
          if: { type: "object", properties: { kind: { const: "create" } } },
          then: { type: "object", properties: { beforeRevision: { type: "null" } } },
        },
        {
          if: { type: "object", properties: { kind: { const: "delete" } } },
          then: { type: "object", properties: { afterRevision: { type: "null" } } },
        },
      ],
    },
    localChange: {
      type: "object",
      additionalProperties: false,
      required: ["namespace", "id", "beforeRevision", "afterRevision", "summary"],
      properties: {
        namespace: { const: "relay-draft" },
        id: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/localId` },
        beforeRevision: {
          anyOf: [{ $ref: "#/$defs/revision" }, { type: "null" }],
        },
        afterRevision: {
          anyOf: [{ $ref: "#/$defs/revision" }, { type: "null" }],
        },
        summary: {
          $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/singleLine`,
          type: "string",
          maxLength: 1_024,
        },
      },
    },
    publicPreview: {
      type: "object",
      additionalProperties: false,
      required: ["valid", "scope", "changes", "localChanges", "diagnostics"],
      properties: {
        valid: { const: true },
        scope: { enum: ["canonical", "local", "mixed"] },
        changes: { type: "array", maxItems: 16, items: { $ref: "#/$defs/fileChange" } },
        localChanges: { type: "array", maxItems: 16, items: { $ref: "#/$defs/localChange" } },
        diagnostics: { $ref: "#/$defs/diagnostics" },
      },
    },
    authority: {
      type: "object",
      additionalProperties: false,
      required: ["actor", "occurredAt", "repoState"],
      properties: {
        actor: { $ref: "#/$defs/actorRef" },
        occurredAt: { $ref: "#/$defs/timestamp" },
        repoState: {
          type: "object",
          additionalProperties: false,
          required: ["branch", "head", "dirty", "observedAt"],
          properties: {
            branch: {
              anyOf: [
                {
                  $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/singleLine`,
                  type: "string",
                  maxLength: 1_024,
                },
                { type: "null" },
              ],
            },
            head: {
              anyOf: [
                { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
                { type: "null" },
              ],
            },
            dirty: { type: "boolean" },
            observedAt: { $ref: "#/$defs/timestamp" },
          },
        },
      },
    },
    legacyWorkstreamExpectation: {
      type: "object",
      additionalProperties: false,
      required: ["target", "revision"],
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path"],
          properties: {
            kind: { const: "artifact" },
            path: {
              type: "string",
              pattern: "^\\.mex/workstreams/ws_[0-7][0-9A-HJKMNP-TV-Z]{25}\\.md$",
            },
          },
        },
        revision: { $ref: "#/$defs/revision" },
      },
    },
    legacyPublishRequest: {
      $comment:
        "Apply-only compatibility for an exact signed pre-v3 publication. New request files use the standalone request schema and cannot include this dependency.",
      type: "object",
      additionalProperties: false,
      required: ["operationId", "action", "expectedRevisions"],
      properties: {
        operationId: {
          $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/operationId`,
        },
        action: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "draftId"],
          properties: {
            kind: { const: "relay.publish" },
            draftId: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/localId` },
          },
        },
        expectedRevisions: {
          type: "array",
          minItems: 3,
          maxItems: 34,
          uniqueItems: true,
          items: {
            oneOf: [
              { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/localExpectation` },
              { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/memberExpectation` },
              { $ref: "#/$defs/legacyWorkstreamExpectation" },
            ],
          },
          allOf: [
            {
              contains: {
                $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/localExpectation`,
              },
              minContains: 1,
              maxContains: 1,
            },
            {
              contains: { $ref: "#/$defs/legacyWorkstreamExpectation" },
              minContains: 1,
              maxContains: 1,
            },
            {
              contains: {
                $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/memberExpectation`,
              },
              minContains: 1,
              maxContains: 32,
            },
          ],
        },
      },
    },
    relayDraftPurpose: {
      type: "object",
      additionalProperties: false,
      required: ["purpose", "id"],
      properties: {
        purpose: { const: "relay-draft" },
        id: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/localId` },
      },
    },
    activityPurpose: {
      type: "object",
      additionalProperties: false,
      required: ["purpose", "id"],
      properties: {
        purpose: { const: "activity" },
        id: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/eventId` },
      },
    },
    relayPurpose: {
      type: "object",
      additionalProperties: false,
      required: ["purpose", "id"],
      properties: {
        purpose: { const: "relay" },
        id: { $ref: `${RELAY_REQUEST_SCHEMA_ID}#/$defs/relayId` },
      },
    },
    purpose: {
      oneOf: [
        { $ref: "#/$defs/activityPurpose" },
        { $ref: "#/$defs/relayPurpose" },
        { $ref: "#/$defs/relayDraftPurpose" },
      ],
    },
    noPurposes: { type: "array", maxItems: 0 },
    relayDraftPurposes: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ $ref: "#/$defs/relayDraftPurpose" }],
      items: false,
    },
    activityPurposes: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ $ref: "#/$defs/activityPurpose" }],
      items: false,
    },
    publishPurposes: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      prefixItems: [
        { $ref: "#/$defs/activityPurpose" },
        { $ref: "#/$defs/relayPurpose" },
      ],
      items: false,
    },
    receipt: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion", "authority", "purposeIds", "requestRevision",
        "presentationRevision", "previewRevision",
      ],
      properties: {
        schemaVersion: { const: 1 },
        authority: { $ref: "#/$defs/authority" },
        purposeIds: {
          type: "array",
          maxItems: 2,
          uniqueItems: true,
          items: { $ref: "#/$defs/purpose" },
        },
        requestRevision: { $ref: "#/$defs/revision" },
        presentationRevision: { $ref: "#/$defs/revision" },
        previewRevision: { $ref: "#/$defs/revision" },
      },
    },
    servicePreview: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "request", "preview", "receipt"],
      properties: {
        schemaVersion: { const: 1 },
        request: {
          oneOf: [
            { $ref: RELAY_REQUEST_SCHEMA_ID },
            { $ref: "#/$defs/legacyPublishRequest" },
          ],
        },
        preview: { $ref: "#/$defs/publicPreview" },
        receipt: { $ref: "#/$defs/receipt" },
      },
      oneOf: [
        {
          properties: {
            request: {
              type: "object",
              required: ["action"],
              properties: {
                action: {
                  type: "object",
                  required: ["kind"],
                  properties: { kind: { const: "relay.draft.save" } },
                  not: { required: ["draftId"], properties: { draftId: {} } },
                },
              },
            },
            receipt: {
              type: "object",
              required: ["purposeIds"],
              properties: { purposeIds: { $ref: "#/$defs/relayDraftPurposes" } },
            },
          },
        },
        {
          properties: {
            request: {
              type: "object",
              required: ["action"],
              properties: {
                action: {
                  type: "object",
                  required: ["kind", "draftId"],
                  properties: { kind: { const: "relay.draft.save" }, draftId: {} },
                },
              },
            },
            receipt: {
              type: "object",
              required: ["purposeIds"],
              properties: { purposeIds: { $ref: "#/$defs/noPurposes" } },
            },
          },
        },
        {
          properties: {
            request: {
              type: "object",
              required: ["action"],
              properties: {
                action: {
                  type: "object",
                  required: ["kind"],
                  properties: { kind: { const: "relay.draft.delete" } },
                },
              },
            },
            receipt: {
              type: "object",
              required: ["purposeIds"],
              properties: { purposeIds: { $ref: "#/$defs/noPurposes" } },
            },
          },
        },
        {
          properties: {
            request: {
              type: "object",
              required: ["action"],
              properties: {
                action: {
                  type: "object",
                  required: ["kind"],
                  properties: { kind: { const: "relay.publish" } },
                },
              },
            },
            receipt: {
              type: "object",
              required: ["purposeIds"],
              properties: { purposeIds: { $ref: "#/$defs/publishPurposes" } },
            },
          },
        },
        {
          properties: {
            request: {
              type: "object",
              required: ["action"],
              properties: {
                action: {
                  type: "object",
                  required: ["kind"],
                  properties: {
                    kind: { enum: ["relay.acknowledge", "relay.close"] },
                  },
                },
              },
            },
            receipt: {
              type: "object",
              required: ["purposeIds"],
              properties: { purposeIds: { $ref: "#/$defs/activityPurposes" } },
            },
          },
        },
      ],
    },
  },
});

const EXIT_CODES = Object.freeze([
  { code: 0, name: "ok", meaning: "Success, including exact idempotent replay." },
  { code: 1, name: "validation", meaning: "Validation, invalid-preview, job, or internal command failure; inspect problem.code and diagnostics." },
  { code: 2, name: "usage", meaning: "Arguments, request JSON, or preview-envelope input are invalid." },
  { code: 3, name: "unavailable", meaning: "Repository state or the requested resource is unavailable." },
  { code: 4, name: "conflict", meaning: "A revision, operation, or recovery conflict prevented the action." },
  { code: 5, name: "refused", meaning: "A containment, authorization, or origin safety policy refused the action." },
]);

const COMMANDS = Object.freeze({
  read: [
    { id: "relay.contract", usage: RELAY_CONTRACT_COMMAND },
    { id: "relay.draft.list", usage: "mex relay draft list --json" },
    { id: "relay.draft.show", usage: "mex relay draft show <draft-id> --json" },
    { id: "relay.list", usage: "mex relay list --json" },
    { id: "relay.show", usage: "mex relay show <relay-id> --json" },
  ],
  preview: [
    { id: "relay.draft.save.preview", usage: "mex relay draft save <request-file> --json", inputContract: RELAY_REQUEST_SCHEMA_ID },
    { id: "relay.draft.delete.preview", usage: "mex relay draft delete <request-file> --json", inputContract: RELAY_REQUEST_SCHEMA_ID },
    { id: "relay.publish.preview", usage: "mex relay publish <request-file> --json", inputContract: RELAY_REQUEST_SCHEMA_ID },
    { id: "relay.acknowledge.preview", usage: "mex relay acknowledge <request-file> --json", inputContract: RELAY_REQUEST_SCHEMA_ID },
    { id: "relay.close.preview", usage: "mex relay close <request-file> --json", inputContract: RELAY_REQUEST_SCHEMA_ID },
  ],
  apply: [
    { id: "relay.draft.save.apply", usage: "mex relay draft save --apply <preview-envelope> --json", inputContract: RELAY_PREVIEW_SCHEMA_ID },
    { id: "relay.draft.delete.apply", usage: "mex relay draft delete --apply <preview-envelope> --json", inputContract: RELAY_PREVIEW_SCHEMA_ID },
    { id: "relay.publish.apply", usage: "mex relay publish --apply <preview-envelope> --json", inputContract: RELAY_PREVIEW_SCHEMA_ID },
    { id: "relay.acknowledge.apply", usage: "mex relay acknowledge --apply <preview-envelope> --json", inputContract: RELAY_PREVIEW_SCHEMA_ID },
    { id: "relay.close.apply", usage: "mex relay close --apply <preview-envelope> --json", inputContract: RELAY_PREVIEW_SCHEMA_ID },
  ],
});

const SPARSE_DRAFT = Object.freeze({
  audience: "team",
  recipients: [],
  summary: "Continue the reviewed Relay handoff.",
});

const EXAMPLES = Object.freeze([
  {
    command: "relay.draft.save",
    usage: "mex relay draft save request.json --json",
    request: {
      operationId: "relay-draft-save-example-001",
      action: { kind: "relay.draft.save", draft: SPARSE_DRAFT },
      expectedRevisions: [],
    },
  },
  {
    command: "relay.draft.save",
    usage: "mex relay draft save request.json --json",
    request: {
      operationId: "relay-draft-context-example-001",
      action: {
        kind: "relay.draft.save",
        draft: {
          ...SPARSE_DRAFT,
          evidence: [
            { kind: "commit", hash: "b".repeat(40) },
            {
              kind: "external",
              uri: "https://example.com/review/relay-handoff",
              label: "Review context",
            },
          ],
        },
      },
      expectedRevisions: [],
    },
  },
  {
    command: "relay.publish",
    usage: "mex relay publish request.json --json",
    request: {
      operationId: "relay-publish-example-001",
      action: { kind: "relay.publish", draftId: "relay-draft-example" },
      expectedRevisions: [
        { target: { kind: "local", namespace: "relay-draft", id: "relay-draft-example" }, revision: REVISION },
        { target: { kind: "artifact", path: `.mex/team/members/${MEMBER_ID}.md` }, revision: REVISION },
      ],
    },
  },
  {
    command: "relay.acknowledge",
    usage: "mex relay acknowledge request.json --json",
    request: {
      operationId: "relay-acknowledge-example-001",
      action: { kind: "relay.acknowledge", relayId: RELAY_ID },
      expectedRevisions: [{
        target: { kind: "artifact", path: `.mex/relays/${RELAY_ID}.md` },
        revision: REVISION,
      }],
    },
  },
]);

const CATALOG = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:mex:team.relay:contract-catalog:v1",
  $defs: {
    request: REQUEST_SCHEMA,
    previewEnvelope: PREVIEW_SCHEMA,
  },
});

export interface RelayContractCatalogData {
  catalogVersion: 1;
  contractId: typeof RELAY_CONTRACT_CATALOG_ID;
  mediaType: "application/schema+json";
  encoding: "utf-8";
  catalog: Readonly<Record<string, unknown>>;
  commands: typeof COMMANDS;
  requestFile: {
    contractId: typeof RELAY_REQUEST_CONTRACT_ID;
    schemaRef: typeof RELAY_REQUEST_SCHEMA_ID;
    mediaType: "application/json";
    encoding: "utf-8";
    maxBytes: number;
    maxDepth: 32;
    maxNodes: 4_096;
    maxRecipients: 32;
    maxLocalIdBytes: 128;
    runtimeConstraints: readonly {
      id: string;
      enforcedBy: "request-parser" | "preview-service";
      requirement: string;
    }[];
    examples: typeof EXAMPLES;
  };
  applyFile: {
    contractId: typeof RELAY_PREVIEW_CONTRACT_ID;
    schemaRef: typeof RELAY_PREVIEW_SCHEMA_ID;
    mediaType: "application/json";
    encoding: "utf-8";
    maxBytes: number;
    maxAgeSeconds: 1_800;
    maxFutureSkewSeconds: 5;
    maxDepth: 32;
    maxNodes: 4_096;
    maxReceiptBytes: 8_192;
    maxReceiptDepth: 8;
    maxReceiptNodes: 128;
    maxPurposeIds: 2;
    runtimeConstraints: readonly {
      id: string;
      enforcedBy: "preview-parser" | "signed-apply-service";
      requirement: string;
    }[];
    requirement: string;
  };
  exitCodes: typeof EXIT_CODES;
}

export interface RelayActionContractData {
  catalogVersion: 1;
  contractId: typeof RELAY_CONTRACT_CATALOG_ID;
  action: RelayContractAction;
  mediaType: "application/schema+json";
  encoding: "utf-8";
  commands: {
    preview: { id: string; usage: string; inputContract: string };
    apply: { id: string; usage: string; inputContract: string };
  };
  requestFile: Omit<
    RelayContractCatalogData["requestFile"],
    "schemaRef" | "runtimeConstraints" | "examples"
  > & {
    schemaRef: string;
    schema: Readonly<Record<string, unknown>>;
    runtimeConstraints: RelayContractCatalogData["requestFile"]["runtimeConstraints"];
    examples: ReadonlyArray<(typeof EXAMPLES)[number]>;
  };
  applyFile: RelayContractCatalogData["applyFile"];
  localSave?: {
    usage: string;
    requirement: string;
    contentFile: { maxBytes: number; schema: Readonly<Record<string, unknown>> };
  };
  exitCodes: typeof EXIT_CODES;
}

const REQUEST_RUNTIME_CONSTRAINTS = Object.freeze([
  {
    id: "canonical-text-path-uri-and-set-policy",
    enforcedBy: "request-parser",
    requirement: "All strings obey the declared UTF-8 ceilings and canonical Unicode/control policy; paths are repository-relative, external evidence is a credential-free HTTP(S) URL, and structured sets are unique and canonicalized.",
  },
  {
    id: "recipient-member-id-uniqueness",
    enforcedBy: "request-parser",
    requirement: `Local drafts may omit recipient selection with an empty array. Team audiences require an empty recipient array; named publication requires 1-${RELAY_CLI_MAX_RECIPIENTS} unique Member references. An omitted audience preserves named-recipient semantics.`,
  },
  {
    id: "action-expectation-target-equality",
    enforcedBy: "request-parser",
    requirement: "Draft update/delete and Relay acknowledge/close require exactly their selected target revision; new drafts accept none.",
  },
  {
    id: "publish-dependency-expectation-equality",
    enforcedBy: "preview-service",
    requirement: "Team publication requires only the exact local draft revision. Named publication additionally requires every unique recipient Member revision, with no Workstream, unrelated, or semantic expectations.",
  },
  {
    id: "publish-live-authority-and-dependencies",
    enforcedBy: "preview-service",
    requirement: "Publish revalidates an active canonical sender under the workflow lease. Named publication also requires every active recipient Member; team eligibility is checked against active membership when taking the Relay, including Members who joined after publication.",
  },
] as const satisfies RelayContractCatalogData["requestFile"]["runtimeConstraints"]);

const APPLY_RUNTIME_CONSTRAINTS = Object.freeze([
  {
    id: "command-action-equality",
    enforcedBy: "preview-parser",
    requirement: "The wrapper command, request action, and exact action-specific purpose set must agree.",
  },
  {
    id: "service-issued-git-authority-domain",
    enforcedBy: "preview-parser",
    requirement: "Git authority name/email fields exactly preserve ActorResolver fallback identity: trimmed NFC non-empty strings reject C0/DEL, allow C1 and internal U+2028/U+2029, use 200/320 UTF-8 byte ceilings respectively, and require at least one non-null field.",
  },
  {
    id: "diagnostic-projection-equality",
    enforcedBy: "preview-parser",
    requirement: "Wrapper diagnostics must be byte-equivalent under stable JSON ordering to data.preview.diagnostics.",
  },
  {
    id: "signed-replan-and-revision-equality",
    enforcedBy: "signed-apply-service",
    requirement: "Request, presentation, authority, repository, target revisions, and the fresh plan must match the exact unexpired signed preview before effects.",
  },
] as const satisfies RelayContractCatalogData["applyFile"]["runtimeConstraints"]);

const APPLY_REQUIREMENT =
  "Pass the exact complete successful schemaVersion 1 Relay JSON preview emitted for the same Relay command; fragments, altered envelopes, and reconstructed receipts are rejected.";

/** Full static Relay catalog; safe before Git, Home, or `.mex` exists. */
export function relayContractCatalogData(): RelayContractCatalogData {
  return {
    catalogVersion: 1,
    contractId: RELAY_CONTRACT_CATALOG_ID,
    mediaType: "application/schema+json",
    encoding: "utf-8",
    catalog: CATALOG,
    commands: COMMANDS,
    requestFile: {
      contractId: RELAY_REQUEST_CONTRACT_ID,
      schemaRef: RELAY_REQUEST_SCHEMA_ID,
      mediaType: "application/json",
      encoding: "utf-8",
      maxBytes: RELAY_CLI_MAX_ENVELOPE_BYTES,
      maxDepth: 32,
      maxNodes: 4_096,
      maxRecipients: RELAY_CLI_MAX_RECIPIENTS,
      maxLocalIdBytes: 128,
      runtimeConstraints: REQUEST_RUNTIME_CONSTRAINTS,
      examples: EXAMPLES,
    },
    applyFile: {
      contractId: RELAY_PREVIEW_CONTRACT_ID,
      schemaRef: RELAY_PREVIEW_SCHEMA_ID,
      mediaType: "application/json",
      encoding: "utf-8",
      maxBytes: RELAY_CLI_MAX_ENVELOPE_BYTES,
      maxAgeSeconds: 1_800,
      maxFutureSkewSeconds: 5,
      maxDepth: 32,
      maxNodes: 4_096,
      maxReceiptBytes: 8_192,
      maxReceiptDepth: 8,
      maxReceiptNodes: 128,
      maxPurposeIds: 2,
      runtimeConstraints: APPLY_RUNTIME_CONSTRAINTS,
      requirement: APPLY_REQUIREMENT,
    },
    exitCodes: EXIT_CODES,
  };
}

export function isRelayContractAction(value: string): value is RelayContractAction {
  return (RELAY_CONTRACT_ACTIONS as readonly string[]).includes(value);
}

/** Static action-scoped Relay contract; does not construct the full catalog. */
export function relayActionContractData(action: RelayContractAction): RelayActionContractData {
  const schema = focusedRelayRequestSchema(action);
  const schemaRef = schema.$id as string;
  const preview = relayCommandDescriptor("preview", `${action}.preview`);
  const apply = relayCommandDescriptor("apply", `${action}.apply`);
  const constraintIds = relayRequestConstraintIds(action);

  return {
    catalogVersion: 1,
    contractId: RELAY_CONTRACT_CATALOG_ID,
    action,
    mediaType: "application/schema+json",
    encoding: "utf-8",
    commands: {
      preview: { ...preview, inputContract: schemaRef },
      apply,
    },
    ...(action === "relay.draft.save" ? {
      localSave: {
        usage: "mex relay draft save --from <draft.json> [--operation-id <id>] --json",
        requirement: "Creates one checkout-local draft through exact preview/apply. Omitted audience and recipients default to team; omitted recipients become []. No publication or Member lookup. A private pending preview is retained before apply, then removed on success. Resume an interruption with the same operation ID/content or the returned recovery command; never replace a conflicting receipt.",
        contentFile: {
          maxBytes: RELAY_CLI_MAX_ENVELOPE_BYTES,
          schema: projectLocalSchemaClosure({
            id: `${RELAY_REQUEST_SCHEMA_ID}?local-create`,
            source: REQUEST_SCHEMA,
            root: { ...(projectSchemaDefinition(REQUEST_SCHEMA, "standaloneDraft") as Record<string, unknown>), required: ["summary"] },
          }),
        },
      },
    } : {}),
    requestFile: {
      contractId: RELAY_REQUEST_CONTRACT_ID,
      schemaRef,
      mediaType: "application/json",
      encoding: "utf-8",
      maxBytes: RELAY_CLI_MAX_ENVELOPE_BYTES,
      maxDepth: 32,
      maxNodes: 4_096,
      maxRecipients: RELAY_CLI_MAX_RECIPIENTS,
      maxLocalIdBytes: 128,
      schema,
      runtimeConstraints: REQUEST_RUNTIME_CONSTRAINTS.filter(
        (constraint) => constraintIds.has(constraint.id),
      ),
      examples: EXAMPLES.filter((example) => example.command === action),
    },
    applyFile: {
      contractId: RELAY_PREVIEW_CONTRACT_ID,
      schemaRef: RELAY_PREVIEW_SCHEMA_ID,
      mediaType: "application/json",
      encoding: "utf-8",
      maxBytes: RELAY_CLI_MAX_ENVELOPE_BYTES,
      maxAgeSeconds: 1_800,
      maxFutureSkewSeconds: 5,
      maxDepth: 32,
      maxNodes: 4_096,
      maxReceiptBytes: 8_192,
      maxReceiptDepth: 8,
      maxReceiptNodes: 128,
      maxPurposeIds: 2,
      runtimeConstraints: APPLY_RUNTIME_CONSTRAINTS,
      requirement: APPLY_REQUIREMENT,
    },
    exitCodes: EXIT_CODES,
  };
}

function relayCommandDescriptor(
  mode: "preview" | "apply",
  id: string,
): { id: string; usage: string; inputContract: string } {
  const descriptor = COMMANDS[mode].find((candidate) => candidate.id === id);
  if (descriptor === undefined) {
    throw new Error(`Relay action contract is missing the ${mode} descriptor for ${id}.`);
  }
  return descriptor;
}

function relayRequestConstraintIds(action: RelayContractAction): ReadonlySet<string> {
  switch (action) {
    case "relay.draft.save":
      return new Set([
        "canonical-text-path-uri-and-set-policy",
        "recipient-member-id-uniqueness",
        "action-expectation-target-equality",
      ]);
    case "relay.draft.delete":
    case "relay.acknowledge":
    case "relay.close":
      return new Set([
        "canonical-text-path-uri-and-set-policy",
        "action-expectation-target-equality",
      ]);
    case "relay.publish":
      return new Set([
        "canonical-text-path-uri-and-set-policy",
        "publish-dependency-expectation-equality",
        "publish-live-authority-and-dependencies",
      ]);
  }
}

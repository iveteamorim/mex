import { describe, it, expect } from "vitest";
import {
  SETTABLE_PROPERTIES,
  WIKI_OPERATION_TYPES,
  checkOperationPreconditions,
  isWikiOperationType,
  validateOperation,
  type WikiOperationType,
} from "../operation.js";
import { entityContentHash } from "../hash.js";
import { rootContext } from "../validate.js";
import { generateEntityId, type EntityId } from "../ids.js";
import { grounding } from "./helpers.js";

const ENTITY = generateEntityId();
const OTHER = generateEntityId();

function envelope(type: WikiOperationType, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    opId: "op_0001",
    type,
    entityId: ENTITY,
    actor: { kind: "agent", id: "claude" },
    timestamp: "2026-08-23T10:00:00Z",
    payload,
    ...overrides,
  };
}

function check(value: unknown): { ok: boolean; codes: string[] } {
  const result = validateOperation(value, rootContext());
  return { ok: result.ok, codes: result.diagnostics.map((entry) => entry.code) };
}

/** A minimal valid payload for each operation type. */
const PAYLOADS: Record<WikiOperationType, unknown> = {
  "create-entry": {
    file: "context/architecture.md",
    insertAt: { at: "end-of-file" },
    type: "decision",
    title: "Rotate refresh tokens",
    body: "Rotated after every refresh.",
  },
  "update-entry": { body: "Rewritten." },
  "set-property": { property: "status", value: "promoted" },
  "add-relation": { relation: { type: "depends_on", target: OTHER } },
  "remove-relation": { type: "depends_on", target: OTHER },
  "add-source": { source: { type: "commit", ref: "8f21a3c" } },
  "remove-source": { sourceIdentity: "commit||8f21a3c" },
  "set-grounding": { groundsTo: [grounding()] },
  "supersede-entry": { replacementId: OTHER },
  "move-entry": { file: "context/decisions.md", insertAt: { at: "end-of-file" } },
  "archive-entry": { note: "Superseded by the new rotation policy." },
};

describe("operation vocabulary", () => {
  it("has the eleven required types", () => {
    expect([...WIKI_OPERATION_TYPES].sort()).toEqual(
      [
        "add-relation",
        "add-source",
        "archive-entry",
        "create-entry",
        "move-entry",
        "remove-relation",
        "remove-source",
        "set-grounding",
        "set-property",
        "supersede-entry",
        "update-entry",
      ].sort(),
    );
    expect(WIKI_OPERATION_TYPES).toHaveLength(11);
  });

  it("has no hard-delete operation — archive is the terminal state", () => {
    for (const name of ["delete-entry", "delete", "remove-entry", "purge"]) {
      expect(isWikiOperationType(name), `${name} must not exist`).toBe(false);
    }
  });

  it("accepts a valid envelope for every operation type", () => {
    for (const type of WIKI_OPERATION_TYPES) {
      const result = check(envelope(type, PAYLOADS[type]));
      expect(result.ok, `${type} should validate: ${result.codes.join(", ")}`).toBe(true);
    }
  });

  it("rejects an unknown operation type", () => {
    const result = check(envelope("delete-entry" as WikiOperationType, {}));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("UNKNOWN_OPERATION_TYPE");
  });
});

describe("envelope validation", () => {
  it("requires an opId, actor and timestamp", () => {
    expect(check({ ...envelope("archive-entry", {}), opId: undefined }).ok).toBe(false);
    expect(check({ ...envelope("archive-entry", {}), actor: undefined }).ok).toBe(false);
    expect(check({ ...envelope("archive-entry", {}), timestamp: undefined }).ok).toBe(false);
  });

  it("rejects a timestamp that is not ISO 8601", () => {
    const result = check(envelope("archive-entry", {}, { timestamp: "this morning" }));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("INVALID_OPERATION_ENVELOPE");
  });

  it("rejects an unknown actor kind", () => {
    expect(check(envelope("archive-entry", {}, { actor: { kind: "robot", id: "x" } })).ok).toBe(false);
  });

  it("requires an entityId for every operation that acts on an existing entity", () => {
    for (const type of WIKI_OPERATION_TYPES) {
      if (type === "create-entry") continue;
      const result = check(envelope(type, PAYLOADS[type], { entityId: undefined }));
      expect(result.ok, `${type} must name its target entity`).toBe(false);
      expect(result.codes).toContain("INVALID_OPERATION_ENVELOPE");
    }
  });

  it("does not require an entityId for create-entry, which mints one", () => {
    expect(check(envelope("create-entry", PAYLOADS["create-entry"], { entityId: undefined })).ok).toBe(true);
  });

  it("rejects a baseContentHash that is not a SHA-256 digest", () => {
    expect(check(envelope("archive-entry", {}, { baseContentHash: "abc" })).ok).toBe(false);
    expect(check(envelope("archive-entry", {}, { baseContentHash: entityContentHash("x") })).ok).toBe(true);
  });

  it("rejects a baseRevision below 1", () => {
    expect(check(envelope("archive-entry", {}, { baseRevision: 0 })).ok).toBe(false);
    expect(check(envelope("archive-entry", {}, { baseRevision: 3 })).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(check("archive it").ok).toBe(false);
    expect(check(null).ok).toBe(false);
  });
});

describe("create-entry payload", () => {
  it("requires an explicit file and insertion point", () => {
    // The planner must be able to compute a range without guessing, and
    // insertion must never overwrite existing prose.
    const { file: _f, ...noFile } = PAYLOADS["create-entry"] as Record<string, unknown>;
    expect(check(envelope("create-entry", noFile)).ok).toBe(false);
    const { insertAt: _i, ...noInsert } = PAYLOADS["create-entry"] as Record<string, unknown>;
    expect(check(envelope("create-entry", noInsert)).ok).toBe(false);
  });

  it("accepts each insertion anchor", () => {
    for (const insertAt of [
      { at: "start-of-file" },
      { at: "end-of-file" },
      { at: "before-entity", entityId: OTHER },
      { at: "after-entity", entityId: OTHER },
    ]) {
      const payload = { ...(PAYLOADS["create-entry"] as object), insertAt };
      expect(check(envelope("create-entry", payload)).ok, JSON.stringify(insertAt)).toBe(true);
    }
  });

  it("rejects an entity-relative anchor with no entity", () => {
    const payload = { ...(PAYLOADS["create-entry"] as object), insertAt: { at: "after-entity" } };
    expect(check(envelope("create-entry", payload)).ok).toBe(false);
  });

  it("rejects a path that escapes the scaffold root", () => {
    for (const file of ["../outside.md", "context/../../etc/passwd", "/etc/passwd", "C:\\Windows\\x.md"]) {
      const payload = { ...(PAYLOADS["create-entry"] as object), file };
      expect(check(envelope("create-entry", payload)).ok, `${file} must be rejected`).toBe(false);
    }
  });

  it("rejects an unregistered entity type", () => {
    const payload = { ...(PAYLOADS["create-entry"] as object), type: "runbook" };
    expect(check(envelope("create-entry", payload)).codes).toContain("INVALID_ENTITY_TYPE");
  });

  it("does not make readable Team kinds, including Activity, Wiki-authorable", () => {
    for (const type of ["member", "workstream", "proposal", "relay", "activity", "playbook", "playbook_run"]) {
      const payload = { ...(PAYLOADS["create-entry"] as object), type };
      expect(check(envelope("create-entry", payload)).codes, type).toContain("INVALID_ENTITY_TYPE");
    }
  });

  it("rejects unsafe file-source metadata before a create can be planned", () => {
    const payload = { ...(PAYLOADS["create-entry"] as object), sources: [{ type: "file", ref: "../secret.md" }] };
    expect(check(envelope("create-entry", payload)).codes).toContain("MALFORMED_SOURCE");
  });
});

describe("source operation payload", () => {
  it("rejects an unsafe repository path before add-source can be planned", () => {
    const result = check(envelope("add-source", { source: { type: "file", ref: "/etc/passwd" } }));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("MALFORMED_SOURCE");
  });
});

describe("update-entry payload", () => {
  it("must change at least one field", () => {
    expect(check(envelope("update-entry", {})).ok).toBe(false);
    expect(check(envelope("update-entry", { title: "New title" })).ok).toBe(true);
  });
});

describe("set-property payload", () => {
  it("accepts every settable property", () => {
    for (const property of SETTABLE_PROPERTIES) {
      expect(check(envelope("set-property", { property, value: "x" })).ok, property).toBe(true);
    }
  });

  it("refuses to set properties MEX maintains", () => {
    // Letting an operation set these would let an agent forge identity or
    // defeat the precondition system.
    for (const property of ["id", "revision", "location", "groundsTo"]) {
      const result = check(envelope("set-property", { property, value: "x" }));
      expect(result.ok, `${property} must not be settable`).toBe(false);
      expect(result.codes).toContain("INVALID_OPERATION_PAYLOAD");
    }
  });

  it("requires a value, distinguishing it from an absent key", () => {
    expect(check(envelope("set-property", { property: "summary" })).ok).toBe(false);
    expect(check(envelope("set-property", { property: "summary", value: undefined })).ok).toBe(true);
  });
});

describe("supersede-entry payload", () => {
  it("accepts an existing replacement", () => {
    expect(check(envelope("supersede-entry", { replacementId: OTHER })).ok).toBe(true);
  });

  it("accepts an inline replacement to create", () => {
    expect(check(envelope("supersede-entry", { replacement: PAYLOADS["create-entry"] })).ok).toBe(true);
  });

  it("rejects both or neither", () => {
    expect(check(envelope("supersede-entry", {})).ok).toBe(false);
    expect(
      check(envelope("supersede-entry", { replacementId: OTHER, replacement: PAYLOADS["create-entry"] })).ok,
    ).toBe(false);
  });

  it("validates the inline replacement", () => {
    const bad = { ...(PAYLOADS["create-entry"] as object), file: "../escape.md" };
    expect(check(envelope("supersede-entry", { replacement: bad })).ok).toBe(false);
  });
});

describe("set-grounding payload", () => {
  it("validates each grounding", () => {
    expect(check(envelope("set-grounding", { groundsTo: [{ node: "rotateToken", fingerprint: "x" }] })).ok).toBe(false);
  });

  it("leaves inline anchors alone unless asked", () => {
    expect(check(envelope("set-grounding", { groundsTo: [grounding()], updateAnchors: true })).ok).toBe(true);
    expect(check(envelope("set-grounding", { groundsTo: [grounding()], updateAnchors: "yes" })).ok).toBe(false);
  });

  it("rejects an unsafe cached file path before grounding provenance is considered", () => {
    const result = check(envelope("set-grounding", { groundsTo: [{ ...grounding(), file: "src/../../secret.ts" }] }));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("MALFORMED_GROUNDING");
  });
});

describe("checkOperationPreconditions", () => {
  const current = { revision: 4, entityContentHash: entityContentHash("current text") };

  it("passes when both preconditions match", () => {
    expect(
      checkOperationPreconditions(
        { entityId: ENTITY, baseRevision: 4, baseContentHash: current.entityContentHash },
        current,
      ),
    ).toEqual([]);
  });

  it("passes when no precondition is stated", () => {
    // Legal: a first write, or a deliberately unconditional operation. The
    // caller accepts whatever is on disk.
    expect(checkOperationPreconditions({ entityId: ENTITY }, current)).toEqual([]);
  });

  it("rejects a stale revision", () => {
    const diagnostics = checkOperationPreconditions({ entityId: ENTITY, baseRevision: 3 }, current);
    expect(diagnostics.map((entry) => entry.code)).toEqual(["REVISION_CONFLICT"]);
    expect(diagnostics[0]!.entityId).toBe(ENTITY);
  });

  it("rejects a stale content hash", () => {
    const diagnostics = checkOperationPreconditions(
      { entityId: ENTITY, baseContentHash: entityContentHash("older text") },
      current,
    );
    expect(diagnostics.map((entry) => entry.code)).toEqual(["CONTENT_HASH_CONFLICT"]);
  });

  it("reports both when both are stale", () => {
    const diagnostics = checkOperationPreconditions(
      { entityId: ENTITY, baseRevision: 1, baseContentHash: entityContentHash("older text") },
      current,
    );
    expect(diagnostics.map((entry) => entry.code).sort()).toEqual(["CONTENT_HASH_CONFLICT", "REVISION_CONFLICT"]);
  });

  it("catches a hand edit that left the revision untouched", () => {
    // The case revision alone misses: someone edited the Markdown directly, so
    // the revision still reads 4 while the text has moved on.
    const diagnostics = checkOperationPreconditions(
      { entityId: ENTITY, baseRevision: 4, baseContentHash: entityContentHash("what the agent read") },
      current,
    );
    expect(diagnostics.map((entry) => entry.code)).toEqual(["CONTENT_HASH_CONFLICT"]);
  });
});

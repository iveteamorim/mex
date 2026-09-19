import { describe, it, expect } from "vitest";
import {
  SPEC_MINIMUM_DIAGNOSTIC_CODES,
  WIKI_DIAGNOSTICS,
  WIKI_DIAGNOSTIC_CODES,
  defaultSeverity,
  diagnostic,
  hasBlockingDiagnostic,
  isWikiDiagnosticCode,
  sortDiagnostics,
  type WikiDiagnostic,
  type WikiDiagnosticCode,
} from "../diagnostic.js";
import { createEntityValidator, detectRevisionDivergence, validateEntity, validateEntitySetIdentity, type WikiLifecycleState } from "../entity.js";
import { validateRelationGraph, type RelationSubject, type WikiRelationRef, type WikiRelationType } from "../relation.js";
import {
  buildTopicIndex,
  resolveTopicOrDiagnose,
  validateTopicHierarchy,
  validateTopicMembership,
  PARENT_TOPIC_RELATION,
  type TopicSubject,
} from "../topic.js";
import { findDuplicateSources, reportUnresolvedSources, validateSource } from "../source.js";
import { validateGrounding, verifyGroundingProvenance } from "../grounding.js";
import { checkOperationPreconditions, validateOperation, type WikiOperationType } from "../operation.js";
import { entityContentHash } from "../hash.js";
import { rootContext } from "../validate.js";
import { generateEntityId, type EntityId } from "../ids.js";
import { entity, grounding, location, ids } from "./helpers.js";
import { parseWikiMarkdown } from "../../markdown/codec.js";




describe("diagnostic registry", () => {
  it("contains every code the build spec lists as a minimum", () => {
    // A code being dropped is a contract break that would otherwise only
    // surface in whatever consumer was matching on it.
    for (const code of SPEC_MINIMUM_DIAGNOSTIC_CODES) {
      expect(isWikiDiagnosticCode(code), `${code} is missing from the registry`).toBe(true);
    }
  });

  it("gives every code a severity and a remediation", () => {
    for (const code of WIKI_DIAGNOSTIC_CODES) {
      const definition = WIKI_DIAGNOSTICS[code];
      expect(["error", "warning", "info"]).toContain(definition.severity);
      expect(definition.remediation.trim().length, `${code} has no remediation`).toBeGreaterThan(0);
    }
  });

  it("lists its codes deterministically", () => {
    expect(WIKI_DIAGNOSTIC_CODES).toEqual([...WIKI_DIAGNOSTIC_CODES].sort());
  });

  it("recognizes its own codes and nothing else", () => {
    expect(isWikiDiagnosticCode("DUPLICATE_ENTITY_ID")).toBe(true);
    expect(isWikiDiagnosticCode("MADE_UP_CODE")).toBe(false);
    expect(isWikiDiagnosticCode(undefined)).toBe(false);
    // Object.hasOwn, not `in`, so inherited members are not mistaken for codes.
    expect(isWikiDiagnosticCode("toString")).toBe(false);
  });
});


describe("diagnostic()", () => {
  it("defaults severity and remediation from the registry", () => {
    const built = diagnostic("DUPLICATE_ENTITY_ID", "Two entities claim one id.");
    expect(built.severity).toBe(defaultSeverity("DUPLICATE_ENTITY_ID"));
    expect(built.remediation).toBe(WIKI_DIAGNOSTICS.DUPLICATE_ENTITY_ID.remediation);
  });

  it("allows an override where context changes how bad the problem is", () => {
    const built = diagnostic("ORPHANED_ENTITY", "x", { severity: "warning", remediation: "custom" });
    expect(built.severity).toBe("warning");
    expect(built.remediation).toBe("custom");
  });

  it("omits optional fields rather than setting them to undefined", () => {
    const built = diagnostic("WIKI_PARSE_ERROR", "x");
    expect(Object.hasOwn(built, "file")).toBe(false);
    expect(Object.hasOwn(built, "entityId")).toBe(false);
    expect(Object.hasOwn(built, "location")).toBe(false);
  });
});

describe("hasBlockingDiagnostic", () => {
  it("blocks on an error and not on a warning or info", () => {
    expect(hasBlockingDiagnostic([diagnostic("DUPLICATE_ENTITY_ID", "x")])).toBe(true);
    expect(hasBlockingDiagnostic([diagnostic("DUPLICATE_SOURCE", "x")])).toBe(false);
    expect(hasBlockingDiagnostic([diagnostic("REVISION_DIVERGED", "x")])).toBe(false);
    expect(hasBlockingDiagnostic([])).toBe(false);
  });
});

describe("sortDiagnostics", () => {
  it("orders worst first, then by file, position and code", () => {
    const input: WikiDiagnostic[] = [
      diagnostic("REVISION_DIVERGED", "info", { file: "a.md" }),
      diagnostic("DUPLICATE_SOURCE", "warning", { file: "a.md" }),
      diagnostic("DUPLICATE_ENTITY_ID", "error in b", { file: "b.md" }),
      diagnostic("DUPLICATE_ENTITY_ID", "error in a", { file: "a.md", location: { startOffset: 40 } }),
      diagnostic("SELF_RELATION", "error in a, earlier", { file: "a.md", location: { startOffset: 10 } }),
    ];
    expect(sortDiagnostics(input).map((entry) => entry.message)).toEqual([
      "error in a, earlier",
      "error in a",
      "error in b",
      "warning",
      "info",
    ]);
  });

  it("is deterministic and does not mutate its input", () => {
    const input = [diagnostic("DUPLICATE_SOURCE", "b"), diagnostic("DUPLICATE_ENTITY_ID", "a")];
    const snapshot = input.map((entry) => entry.message);
    expect(sortDiagnostics(input)).toEqual(sortDiagnostics(input));
    expect(input.map((entry) => entry.message)).toEqual(snapshot);
  });
});

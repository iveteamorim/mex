import { describe, it, expect } from "vitest";
import {
  ACTIVE_LIFECYCLE_STATES,
  TEAM_READABLE_ENTITY_TYPES,
  WIKI_ENTITY_TYPES,
  WIKI_LIFECYCLE_STATES,
  createEntityTypeRegistry,
  createEntityValidator,
  detectRevisionDivergence,
  isActiveEntity,
  isDefaultEntityType,
  isWikiLifecycleState,
  validateEntity,
  type WikiEntity,
  type WikiLifecycleState,
} from "../entity.js";
import { entityContentHash } from "../hash.js";
import { rootContext } from "../validate.js";
import { generateEntityId, type EntityId } from "../ids.js";
import { entity, grounding, location } from "./helpers.js";

function check(value: unknown, validator = validateEntity): { ok: boolean; codes: string[]; paths: (string | undefined)[] } {
  const result = validator(value, rootContext());
  return {
    ok: result.ok,
    codes: result.diagnostics.map((diag) => diag.code),
    paths: result.diagnostics.map((diag) => diag.path),
  };
}

describe("entity vocabulary", () => {
  it("keeps the fourteen Wiki-authored types separate from Team read types", () => {
    expect([...WIKI_ENTITY_TYPES].sort()).toEqual(
      [
        "acceptance_criterion",
        "architecture",
        "component",
        "constraint",
        "convention",
        "decision",
        "fact",
        "guide",
        "pattern",
        "requirement",
        "risk",
        "spec",
        "task",
        "topic",
      ].sort(),
    );
    expect(WIKI_ENTITY_TYPES).toHaveLength(14);
    expect(TEAM_READABLE_ENTITY_TYPES).toEqual([
      "member",
      "workstream",
      "proposal",
      "relay",
      "activity",
      "playbook",
      "playbook_run",
    ]);
    for (const type of TEAM_READABLE_ENTITY_TYPES) {
      expect(WIKI_ENTITY_TYPES).not.toContain(type as never);
    }
  });

  it("has the four lifecycle states and no health value among them", () => {
    expect([...WIKI_LIFECYCLE_STATES]).toEqual(["in_flight", "promoted", "deprecated", "archived"]);
    for (const health of ["fresh", "stale", "changed", "missing", "ambiguous", "unverified"]) {
      expect(isWikiLifecycleState(health), `${health} is health, not lifecycle`).toBe(false);
    }
  });

  it("treats in_flight and promoted as active", () => {
    expect([...ACTIVE_LIFECYCLE_STATES]).toEqual(["in_flight", "promoted"]);
    expect(isActiveEntity({ status: "promoted" })).toBe(true);
    expect(isActiveEntity({ status: "in_flight" })).toBe(true);
    expect(isActiveEntity({ status: "deprecated" })).toBe(false);
    expect(isActiveEntity({ status: "archived" })).toBe(false);
  });

  it("recognizes default types", () => {
    expect(isDefaultEntityType("decision")).toBe(true);
    expect(isDefaultEntityType("workstream")).toBe(true);
    expect(isDefaultEntityType("playbook_run")).toBe(true);
    expect(isDefaultEntityType("runbook")).toBe(false);
  });
});

describe("validateEntity", () => {
  it("accepts a well-formed entity", () => {
    expect(check(entity())).toMatchObject({ ok: true });
  });

  it("accepts every default type", () => {
    for (const type of [...WIKI_ENTITY_TYPES, ...TEAM_READABLE_ENTITY_TYPES]) {
      expect(check(entity({ type })).ok, `${type} should be valid`).toBe(true);
    }
  });

  it("accepts every lifecycle state", () => {
    for (const status of WIKI_LIFECYCLE_STATES) {
      expect(check(entity({ status })).ok, `${status} should be valid`).toBe(true);
    }
  });

  it("accepts an entity with an empty body", () => {
    // A metadata-only topic generated during migration is legitimate.
    expect(check(entity({ type: "topic", body: "" })).ok).toBe(true);
  });

  it("rejects a malformed id", () => {
    const result = check(entity({ id: "architecture.md" as unknown as EntityId }));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("INVALID_ENTITY_ID");
  });

  it("rejects an unregistered type", () => {
    const result = check(entity({ type: "runbook" }));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("INVALID_ENTITY_TYPE");
  });

  it("rejects a grounding health value used as a lifecycle state", () => {
    // The conflation the two-enum design exists to prevent, checked at runtime
    // as well as in the types, because YAML from disk is not typechecked.
    const result = check(entity({ status: "stale" as unknown as WikiLifecycleState }));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("INVALID_LIFECYCLE_STATE");
    expect(result.paths).toContain("status");
  });

  it("rejects a missing or blank title", () => {
    expect(check(entity({ title: "" })).codes).toContain("MISSING_ENTITY_TITLE");
    expect(check(entity({ title: "   " })).codes).toContain("MISSING_ENTITY_TITLE");
  });

  it("rejects a revision below 1 or non-integral", () => {
    for (const revision of [0, -1, 1.5, Number.NaN]) {
      const result = check(entity({ revision }));
      expect(result.ok, `revision ${revision} should be rejected`).toBe(false);
      expect(result.codes).toContain("INVALID_REVISION");
    }
  });

  it("rejects a free-string topic", () => {
    // Topics are entities, so membership is by id. A string here would be the
    // start of a second, unvalidated topic vocabulary.
    const result = check(entity({ topics: ["authentication" as unknown as EntityId] }));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("UNKNOWN_TOPIC");
    expect(result.paths).toContain("topics[0]");
  });

  it("reports every problem in one pass rather than stopping at the first", () => {
    const result = check(
      entity({
        type: "runbook",
        title: "",
        revision: 0,
        status: "fresh" as unknown as WikiLifecycleState,
      }),
    );
    expect(result.codes.sort()).toEqual(
      ["INVALID_ENTITY_TYPE", "INVALID_LIFECYCLE_STATE", "INVALID_REVISION", "MISSING_ENTITY_TITLE"].sort(),
    );
  });

  it("carries nested diagnostics with their full path", () => {
    const result = check(entity({ relations: [{ type: "nope" as never, target: generateEntityId() }] }));
    expect(result.paths).toContain("relations[0].type");
  });

  it("validates nested sources and groundings", () => {
    expect(check(entity({ sources: [{ type: "manual" }] })).codes).toContain("MALFORMED_SOURCE");
    expect(check(entity({ groundsTo: [grounding({ node: "rotateToken" })] })).codes).toContain("MALFORMED_GROUNDING");
  });

  it("rejects a non-object", () => {
    expect(check("an entity").ok).toBe(false);
    expect(check(null).ok).toBe(false);
    expect(check([]).ok).toBe(false);
  });
});

describe("entity type registry", () => {
  it("is the documented extension point for project-specific types", () => {
    const registry = createEntityTypeRegistry(["runbook"]);
    const validator = createEntityValidator({ registry });
    expect(check(entity({ type: "runbook" }), validator).ok).toBe(true);
    expect(check(entity({ type: "decision" }), validator).ok).toBe(true);
  });

  it("still rejects anything unregistered — extension is explicit, not permissive", () => {
    const validator = createEntityValidator({ registry: createEntityTypeRegistry(["runbook"]) });
    expect(check(entity({ type: "retrospective" }), validator).ok).toBe(false);
  });

  it("registers Team kinds for reads without adding them to Wiki-authored types", () => {
    const registry = createEntityTypeRegistry();
    for (const type of TEAM_READABLE_ENTITY_TYPES) {
      expect(registry.has(type), type).toBe(true);
      expect(WIKI_ENTITY_TYPES).not.toContain(type as never);
    }
  });

  it("lists its types deterministically", () => {
    const registry = createEntityTypeRegistry(["runbook", "playbook"]);
    expect(registry.list()).toEqual([...registry.list()].sort());
    expect(registry.has("runbook")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });
});

describe("location", () => {
  it("is optional for a proposed entity that is not on disk yet", () => {
    const { location: _omitted, ...withoutLocation } = entity();
    expect(check(withoutLocation).ok).toBe(true);
  });

  it("is required when reading from a file", () => {
    const validator = createEntityValidator({ requireLocation: true });
    const { location: _omitted, ...withoutLocation } = entity();
    expect(check(withoutLocation, validator).ok).toBe(false);
    expect(check(entity(), validator).ok).toBe(true);
  });

  it("rejects an inverted range", () => {
    // Everything downstream slices with these numbers, and a negative-length
    // range produces a silent empty splice rather than an error.
    const result = check(entity({ location: location({ bodyStart: 200, bodyEnd: 60 }) }));
    expect(result.ok).toBe(false);
    expect(result.paths).toContain("location");
  });

  it("rejects an inverted line range", () => {
    expect(check(entity({ location: location({ startLine: 12, endLine: 1 }) })).ok).toBe(false);
  });

  it("rejects a heading depth outside 0-6", () => {
    expect(check(entity({ location: location({ headingDepth: 7 }) })).ok).toBe(false);
    expect(check(entity({ location: location({ headingDepth: 0 }) })).ok).toBe(true);
  });

  it("rejects a negative offset", () => {
    expect(check(entity({ location: location({ metadataStart: -1 }) })).ok).toBe(false);
  });
});

describe("detectRevisionDivergence", () => {
  it("stays quiet when the recorded text still matches", () => {
    const subject = entity();
    expect(detectRevisionDivergence(subject, subject.location.entityContentHash)).toEqual([]);
  });

  it("reports a manual edit at info severity, never as an error", () => {
    // People are allowed to edit their own Markdown in any editor. This is a
    // reconcile prompt, not a failure, and it must never block a read.
    const subject: WikiEntity = entity();
    const diagnostics = detectRevisionDivergence(subject, entityContentHash("edited by hand"));
    expect(diagnostics.map((diag) => diag.code)).toEqual(["REVISION_DIVERGED"]);
    expect(diagnostics[0]!.severity).toBe("info");
    expect(diagnostics[0]!.entityId).toBe(subject.id);
    expect(diagnostics[0]!.file).toBe(subject.location.file);
  });
});

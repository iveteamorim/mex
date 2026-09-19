import { describe, it, expect } from "vitest";
import {
  PARENT_TOPIC_RELATION,
  TOPIC_ALIASES_KEY,
  buildTopicIndex,
  detectTopicCycles,
  normalizeTopicName,
  resolveTopicOrDiagnose,
  resolveTopicReference,
  topicAliases,
  validateTopicHierarchy,
  validateTopicMembership,
  type TopicSubject,
} from "../topic.js";
import type { WikiRelationRef } from "../relation.js";
import { generateEntityId, type EntityId } from "../ids.js";
import { ids } from "./helpers.js";

function topic(
  id: EntityId,
  title: string,
  options: { aliases?: string[]; parents?: EntityId[]; type?: string } = {},
): TopicSubject {
  const relations: WikiRelationRef[] = (options.parents ?? []).map((target) => ({
    type: PARENT_TOPIC_RELATION,
    target,
  }));
  const subject: TopicSubject = { id, type: options.type ?? "topic", title, relations };
  if (options.aliases) subject.metadata = { [TOPIC_ALIASES_KEY]: options.aliases };
  return subject;
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}

describe("normalizeTopicName", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(normalizeTopicName("  Refresh   Tokens ")).toBe("refresh tokens");
    expect(normalizeTopicName("AUTH")).toBe(normalizeTopicName("auth"));
  });
});

describe("topicAliases", () => {
  it("reads the declared aliases", () => {
    const [id] = ids(1) as [EntityId];
    expect(topicAliases(topic(id, "Authentication", { aliases: ["auth", "authn"] }))).toEqual(["auth", "authn"]);
  });

  it("ignores malformed alias entries rather than throwing", () => {
    const [id] = ids(1) as [EntityId];
    const subject = topic(id, "Auth");
    subject.metadata = { [TOPIC_ALIASES_KEY]: ["ok", 42, "", null] };
    expect(topicAliases(subject)).toEqual(["ok"]);
  });

  it("returns nothing when there are no aliases", () => {
    const [id] = ids(1) as [EntityId];
    expect(topicAliases(topic(id, "Auth"))).toEqual([]);
  });
});

describe("buildTopicIndex", () => {
  it("indexes only entities of type topic", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "Auth"), topic(b, "A decision", { type: "decision" })]);
    expect([...index.byId.keys()]).toEqual([a]);
  });

  it("indexes titles and aliases together", () => {
    const [a] = ids(1) as [EntityId];
    const index = buildTopicIndex([topic(a, "Authentication", { aliases: ["auth"] })]);
    expect(index.byName.get("authentication")).toEqual([a]);
    expect(index.byName.get("auth")).toEqual([a]);
  });
});

describe("resolveTopicReference", () => {
  it("resolves an id", () => {
    const [a] = ids(1) as [EntityId];
    const index = buildTopicIndex([topic(a, "Auth")]);
    expect(resolveTopicReference(index, a)).toEqual({ ok: true, id: a });
  });

  it("resolves an id spelled in a different case", () => {
    const [a] = ids(1) as [EntityId];
    const index = buildTopicIndex([topic(a, "Auth")]);
    expect(resolveTopicReference(index, a.toUpperCase())).toEqual({ ok: true, id: a });
  });

  it("resolves a title or an alias", () => {
    const [a] = ids(1) as [EntityId];
    const index = buildTopicIndex([topic(a, "Authentication", { aliases: ["auth"] })]);
    expect(resolveTopicReference(index, "Authentication")).toEqual({ ok: true, id: a });
    expect(resolveTopicReference(index, "  AUTH  ")).toEqual({ ok: true, id: a });
  });

  it("reports an unknown reference", () => {
    const index = buildTopicIndex([]);
    expect(resolveTopicReference(index, "auth")).toEqual({ ok: false, reason: "unknown" });
  });

  it("reports an id that is well-formed but not a topic", () => {
    const index = buildTopicIndex([]);
    expect(resolveTopicReference(index, generateEntityId())).toEqual({ ok: false, reason: "unknown" });
  });

  it("refuses to guess when two topics claim one name", () => {
    // Guessing here silently files knowledge under the wrong topic, which is
    // worse than refusing and asking.
    const [a, b] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "Auth"), topic(b, "Authorization", { aliases: ["auth"] })]);
    const resolution = resolveTopicReference(index, "auth");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok && resolution.reason === "ambiguous") {
      expect(resolution.candidates.sort()).toEqual([a, b].sort());
    } else {
      expect.fail("expected an ambiguous resolution");
    }
  });

  it("prefers an id over a name, so an id can never be shadowed", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    // A topic whose *title* is literally another topic's id.
    const index = buildTopicIndex([topic(a, "Auth"), topic(b, a)]);
    expect(resolveTopicReference(index, a)).toEqual({ ok: true, id: a });
  });
});

describe("resolveTopicOrDiagnose", () => {
  it("returns the id with no diagnostics on success", () => {
    const [a] = ids(1) as [EntityId];
    const index = buildTopicIndex([topic(a, "Auth")]);
    expect(resolveTopicOrDiagnose(index, "auth", "topics[0]")).toEqual({ id: a, diagnostics: [] });
  });

  it("reports an unknown topic", () => {
    const result = resolveTopicOrDiagnose(buildTopicIndex([]), "auth", "topics[0]");
    expect(result.id).toBeNull();
    expect(codes(result.diagnostics)).toEqual(["UNKNOWN_TOPIC"]);
    expect(result.diagnostics[0]!.path).toBe("topics[0]");
  });

  it("reports an ambiguous topic", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "Auth"), topic(b, "Authorization", { aliases: ["auth"] })]);
    const result = resolveTopicOrDiagnose(index, "auth", "topics[0]");
    expect(result.id).toBeNull();
    expect(codes(result.diagnostics)).toEqual(["AMBIGUOUS_TOPIC_REFERENCE"]);
  });
});

describe("validateTopicMembership", () => {
  it("accepts membership pointing at a real topic", () => {
    const [member, topicId] = ids(2) as [EntityId, EntityId];
    const entities = new Map([[topicId, { type: "topic" }]]);
    expect(validateTopicMembership([{ id: member, topics: [topicId] }], entities)).toEqual([]);
  });

  it("rejects membership pointing at nothing", () => {
    const [member, missing] = ids(2) as [EntityId, EntityId];
    const diagnostics = validateTopicMembership([{ id: member, topics: [missing] }], new Map());
    expect(codes(diagnostics)).toEqual(["UNKNOWN_TOPIC"]);
  });

  it("rejects membership pointing at an entity that is not a topic", () => {
    // Resolves fine, and then produces a topic page that is not a topic.
    const [member, decision] = ids(2) as [EntityId, EntityId];
    const entities = new Map([[decision, { type: "decision" }]]);
    const diagnostics = validateTopicMembership([{ id: member, topics: [decision] }], entities);
    expect(codes(diagnostics)).toEqual(["INVALID_TOPIC_MEMBER"]);
    expect(diagnostics[0]!.path).toBe("topics[0]");
    expect(diagnostics[0]!.entityId).toBe(member);
  });
});

describe("detectTopicCycles", () => {
  it("accepts an acyclic hierarchy", () => {
    const [a, b, c] = ids(3) as [EntityId, EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "Auth", { parents: [b] }), topic(b, "Security", { parents: [c] }), topic(c, "Platform")]);
    expect(detectTopicCycles(index)).toEqual([]);
  });

  it("finds a direct cycle", () => {
    const [a] = ids(1) as [EntityId];
    const index = buildTopicIndex([topic(a, "Auth", { parents: [a] })]);
    expect(detectTopicCycles(index)).toEqual([[a]]);
  });

  it("finds a two-step cycle", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "Auth", { parents: [b] }), topic(b, "Security", { parents: [a] })]);
    expect(detectTopicCycles(index)).toHaveLength(1);
  });

  it("reports a cycle once, not once per member", () => {
    const [a, b, c] = ids(3) as [EntityId, EntityId, EntityId];
    const index = buildTopicIndex([
      topic(a, "A", { parents: [b] }),
      topic(b, "B", { parents: [c] }),
      topic(c, "C", { parents: [a] }),
    ]);
    expect(detectTopicCycles(index)).toHaveLength(1);
  });

  it("ignores depends_on between non-topics", () => {
    // An ordinary dependency between a decision and a component is not
    // hierarchy and must not be mistaken for one.
    const [a, decision] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([
      topic(a, "Auth", { parents: [decision] }),
      topic(decision, "A decision", { type: "decision", parents: [a] }),
    ]);
    expect(detectTopicCycles(index)).toEqual([]);
  });

  it("surfaces as a TOPIC_CYCLE diagnostic", () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "A", { parents: [b] }), topic(b, "B", { parents: [a] })]);
    expect(codes(validateTopicHierarchy(index))).toEqual(["TOPIC_CYCLE"]);
  });
});

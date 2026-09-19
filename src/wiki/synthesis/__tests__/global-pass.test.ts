/**
 * The global cross-cutting pass: grouping, judging, and the operations it emits.
 *
 * Grouping has no inherited oracle — the reference's pass had no unit tests —
 * so every rule here is provoked rather than sampled, and the merge mapping is
 * exercised end to end against a real scaffold, because "one supersession plus
 * N deprecations, with no operation naming an id a later one mints" is the one
 * claim in this file that a shape assertion cannot check.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findCandidateGroups,
  GLOBAL_PASS_DEFAULTS,
  planGlobalPass,
  validateGlobalPassActions,
  type CandidateGroup,
  type WikiUnit,
} from "../global-pass.js";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { applyOperation } from "../../operations/apply.js";
import { createParseCache } from "../../operations/locate.js";
import { parseWikiMarkdown } from "../../markdown/contract.js";

const NODE = "function:a3f8c21d9e4b7f60a1c2d3e4f5061728";
const FINGERPRINT = "mh:64:9f2a4c6e";
const BODY_HASH = "b".repeat(64);

const graph: GroundingGraph = {
  getNode: (id) => (id === NODE ? { id, bodyHash: BODY_HASH, filePath: "src/token.ts", startLine: 1, endLine: 9 } : null),
  getFingerprint: (id) => (id === NODE ? FINGERPRINT : null),
  reconcile: () => null,
  getBaselineSource: () => {
    throw new Error("the global pass must not read the cached baseline");
  },
};

function unit(overrides: Partial<WikiUnit> & { id: string }): WikiUnit {
  return {
    type: "convention",
    title: "Errors are returned, never thrown",
    summary: "Functions in this codebase return a result object rather than throwing.",
    body: "Every public function returns a discriminated union instead of raising.",
    status: "promoted",
    file: "context/conventions.md",
    groundingNodeIds: [NODE],
    revision: 1,
    contentHash: "c".repeat(64),
    ...overrides,
  };
}

describe("grouping", () => {
  it("groups near-duplicates of one type and leaves a singleton alone", () => {
    const groups = findCandidateGroups([
      unit({ id: "A" }),
      unit({ id: "B", title: "Errors are returned rather than thrown" }),
      unit({ id: "C", type: "pattern", title: "Something else entirely", groundingNodeIds: ["other"] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.units.map((entry) => entry.id)).toEqual(["A", "B"]);
    expect(groups[0]!.type).toBe("convention");
  });

  it("never mixes types, however similar the text", () => {
    // Two entities that say the same thing about the same node are still two
    // different *kinds* of claim, and merging a convention into a pattern would
    // change what the surviving entity is.
    const groups = findCandidateGroups([unit({ id: "A" }), unit({ id: "B", type: "pattern" })]);
    expect(groups).toEqual([]);
  });

  it("groups on shared grounding even when the prose differs", () => {
    // The recall-first rule that a composite score alone would miss.
    const groups = findCandidateGroups([
      unit({ id: "A", title: "Result objects", summary: "aaa bbb ccc ddd", body: "eee fff" }),
      unit({ id: "B", title: "Result values", summary: "ggg hhh iii jjj", body: "kkk lll" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toContain("Shared grounding nodes");
  });

  it("does not group two unrelated entities", () => {
    // The polarity that stops "it grouped them" from being the only outcome
    // this suite can observe.
    const groups = findCandidateGroups([
      unit({ id: "A", title: "Token expiry policy", summary: "How long a token lives.", groundingNodeIds: ["n1"] }),
      unit({
        id: "B",
        title: "Database migrations run forward",
        summary: "Schema changes are never rolled back.",
        groundingNodeIds: ["n2"],
      }),
    ]);
    expect(groups).toEqual([]);
  });

  it("caps an oversized group, keeping promoted members over in_flight ones", () => {
    const many = Array.from({ length: GLOBAL_PASS_DEFAULTS.maxGroupSize + 4 }, (_, index) =>
      unit({ id: `U${String(index).padStart(2, "0")}`, status: index % 2 === 0 ? "in_flight" : "promoted" }),
    );
    const promoted = many.filter((entry) => entry.status === "promoted").length;
    const groups = findCandidateGroups(many);
    expect(groups[0]!.units).toHaveLength(GLOBAL_PASS_DEFAULTS.maxGroupSize);
    // Every promoted member survives the cap, and the ones dropped are all
    // `in_flight` — the rank is lifecycle first, which is a fact the wiki
    // maintains, rather than the confidence an applied entity no longer has.
    expect(groups[0]!.units.filter((entry) => entry.status === "promoted")).toHaveLength(promoted);
    expect(groups[0]!.units.filter((entry) => entry.status === "in_flight").length).toBe(
      GLOBAL_PASS_DEFAULTS.maxGroupSize - promoted,
    );
  });

  it("is deterministic, and its group id is recomputable from the members", () => {
    const units = [unit({ id: "B" }), unit({ id: "A" })];
    const first = findCandidateGroups(units);
    const second = findCandidateGroups([...units].reverse());
    expect(first[0]!.groupId).toBe(second[0]!.groupId);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("validating an action", () => {
  function groups(): CandidateGroup[] {
    return findCandidateGroups([unit({ id: "A" }), unit({ id: "B", title: "Errors are returned rather than thrown" })]);
  }

  function merge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      groupId: groups()[0]!.groupId,
      action: "merge",
      reasoning: "the two say the same thing about the same function",
      canonicalUnit: {
        type: "convention",
        title: "Errors are returned, never thrown",
        summary: "Functions return a result object rather than throwing.",
        body: "Every public function returns a discriminated union instead of raising.",
        groundingNodeIds: [NODE],
      },
      ...overrides,
    };
  }

  it("accepts a well-formed merge", () => {
    const result = validateGlobalPassActions([merge()], groups());
    expect(result.rejected).toEqual([]);
    expect(result.valid).toHaveLength(1);
  });

  it("refuses grounding the group does not already carry", () => {
    // The gate provoked: a merge may re-word, and may not introduce a claim
    // about code that no member of the group was ever grounded to.
    const result = validateGlobalPassActions(
      [merge({ canonicalUnit: { ...(merge().canonicalUnit as object), groundingNodeIds: ["function:invented"] } })],
      groups(),
    );
    expect(result.valid).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("function:invented");
  });

  it("refuses a merge whose canonical changes the group's type", () => {
    const result = validateGlobalPassActions(
      [merge({ canonicalUnit: { ...(merge().canonicalUnit as object), type: "pattern" } })],
      groups(),
    );
    expect(result.rejected[0]!.reasons.join(" ")).toContain("must equal the group type");
  });

  it("requires a reason for every destructive action", () => {
    for (const action of [
      merge({ reasoning: undefined }),
      { groupId: groups()[0]!.groupId, action: "promote_one", winnerId: "A" },
      { groupId: groups()[0]!.groupId, action: "drop_weak", loserIds: ["A"] },
    ]) {
      const result = validateGlobalPassActions([action], groups());
      expect(result.rejected[0]!.reasons.join(" "), JSON.stringify(action)).toContain("substantive reasoning");
    }
  });

  it("refuses a drop_weak that would empty the group", () => {
    const result = validateGlobalPassActions(
      [{ groupId: groups()[0]!.groupId, action: "drop_weak", loserIds: ["A", "B"], reasoning: "both are weak" }],
      groups(),
    );
    expect(result.rejected[0]!.reasons.join(" ")).toContain("must leave at least one unit");
  });

  it("refuses an id from outside the group", () => {
    const result = validateGlobalPassActions(
      [{ groupId: groups()[0]!.groupId, action: "promote_one", winnerId: "Z", reasoning: "not a member at all" }],
      groups(),
    );
    expect(result.rejected[0]!.reasons.join(" ")).toContain("not a member of the group");
  });

  it("refuses a second action for a group whose first action was rejected", () => {
    // The reference marked a group seen only when an action for it was
    // *accepted*, so a second action slipped through whenever the first had
    // failed validation — the duplicate rule depended on the validity of the
    // attempt it was meant to be independent of.
    const id = groups()[0]!.groupId;
    const result = validateGlobalPassActions(
      [
        { groupId: id, action: "promote_one", winnerId: "Z", reasoning: "an invalid first attempt" },
        { groupId: id, action: "keep_separate" },
      ],
      groups(),
    );
    expect(result.valid).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[1]!.reasons.join(" ")).toContain("duplicate action");
  });

  it("accepts keep_separate with no reasoning, because it changes nothing", () => {
    const result = validateGlobalPassActions([{ groupId: groups()[0]!.groupId, action: "keep_separate" }], groups());
    expect(result.valid).toHaveLength(1);
  });
});

describe("the operations an action becomes", () => {
  function groups(): CandidateGroup[] {
    return findCandidateGroups([
      unit({ id: "A" }),
      unit({ id: "B", title: "Errors are returned rather than thrown" }),
      unit({ id: "C", title: "Errors are returned and never thrown" }),
    ]);
  }

  it("keeps keep_separate as no operations at all", () => {
    const planned = planGlobalPass([{ groupId: groups()[0]!.groupId, action: "keep_separate" }], groups(), { graph });
    expect(planned.operations).toEqual([]);
  });

  it("turns drop_weak into one deprecation per loser", () => {
    const planned = planGlobalPass(
      [{ groupId: groups()[0]!.groupId, action: "drop_weak", loserIds: ["B"], reasoning: "a weak near-duplicate" }],
      groups(),
      { graph },
    );
    expect(planned.operations).toHaveLength(1);
    const envelope = planned.operations[0]!.envelope as Record<string, unknown>;
    expect(envelope["type"]).toBe("set-property");
    expect(envelope["entityId"]).toBe("B");
    expect(envelope["payload"]).toEqual({ property: "status", value: "deprecated" });
  });

  it("turns promote_one into a supersedes edge and a deprecation per loser", () => {
    const planned = planGlobalPass(
      [{ groupId: groups()[0]!.groupId, action: "promote_one", winnerId: "A", reasoning: "A is already the clearest" }],
      groups(),
      { graph },
    );
    const types = planned.operations.map((entry) => (entry.envelope as Record<string, unknown>)["type"]);
    expect(types).toEqual(["add-relation", "set-property", "add-relation", "set-property"]);
    // Every relation is asserted on the winner, which exists — no operation
    // names an id that a later one would mint.
    for (const operation of planned.operations) {
      const envelope = operation.envelope as Record<string, unknown>;
      if (envelope["type"] === "add-relation") expect(envelope["entityId"]).toBe("A");
    }
  });

  it("puts a merge's lineage on the canonical, so nothing names an unminted id", () => {
    const planned = planGlobalPass(
      [
        {
          groupId: groups()[0]!.groupId,
          action: "merge",
          reasoning: "all three say the same thing",
          canonicalUnit: {
            type: "convention",
            title: "Errors are returned, never thrown",
            summary: "Functions return a result object rather than throwing.",
            body: "Every public function returns a discriminated union instead of raising.",
            groundingNodeIds: [NODE],
          },
        },
      ],
      groups(),
      { graph },
    );

    // The deprecations go first and the creating operation last: an insertion
    // at end of file extends the trailing entity's body range, which is exactly
    // the raw hash every earlier precondition was taken against.
    const last = planned.operations[planned.operations.length - 1]!;
    const rest = planned.operations.slice(0, -1);
    const envelope = last.envelope as Record<string, unknown>;
    expect(envelope["type"]).toBe("supersede-entry");
    expect(envelope["entityId"]).toBe("A");
    const replacement = (envelope["payload"] as { replacement: Record<string, unknown> }).replacement;
    // The canonical supersedes every *other* member; the operation itself adds
    // the link to the anchor.
    expect(replacement["relations"]).toEqual([
      { type: "supersedes", target: "B" },
      { type: "supersedes", target: "C" },
    ]);
    // And its grounding came from the graph, not from the agent's array.
    expect(replacement["groundsTo"]).toEqual([
      { node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH, file: "src/token.ts" },
    ]);
    expect(rest.map((entry) => (entry.envelope as Record<string, unknown>)["entityId"])).toEqual(["B", "C"]);
  });

  it("refuses a merge when the graph cannot produce the canonical's grounding", () => {
    // §12.4 on the entity a merge mints. Passing the subset check says the
    // agent stayed inside the question, not that the node still exists.
    const planned = planGlobalPass(
      [
        {
          groupId: groups()[0]!.groupId,
          action: "merge",
          reasoning: "all three say the same thing",
          canonicalUnit: {
            type: "convention",
            title: "Errors are returned, never thrown",
            summary: "Functions return a result object rather than throwing.",
            body: "Every public function returns a discriminated union instead of raising.",
            groundingNodeIds: [NODE],
          },
        },
      ],
      groups(),
      { graph: null },
    );
    expect(planned.operations).toEqual([]);
    expect(planned.refused[0]!.reasons.join(" ")).toContain("no code graph is available");
    expect(planned.diagnostics.map((entry) => entry.code)).toEqual(["GROUNDING_UNVERIFIED"]);
  });
});

describe("a merge, applied", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it("leaves one active entity superseding two deprecated ones", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-wiki-gp-"));
    roots.push(root);
    mkdirSync(join(root, "context"), { recursive: true });

    // Two entities that say the same thing, written the way the codec reads.
    const path = "context/conventions.md";
    writeFileSync(
      join(root, path),
      [
        "# Conventions",
        "",
        "<!-- mex:entity",
        "id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD",
        "type: convention",
        "status: promoted",
        "revision: 1",
        "-->",
        "## Errors are returned, never thrown",
        "",
        "Every public function returns a discriminated union instead of raising.",
        "",
        "<!-- mex:entity",
        "id: mx_01BX5ZZKBKACTAV9WEVGEMMVRZ",
        "type: convention",
        "status: promoted",
        "revision: 1",
        "-->",
        "## Errors are returned rather than thrown",
        "",
        "Functions here return a result object rather than raising.",
        "",
      ].join("\n"),
      "utf-8",
    );

    // The preconditions come from the bytes, exactly as the service projection
    // will build them: a fabricated hash would make this test assert that the
    // precondition system does not work.
    const onDisk = parseWikiMarkdown({ path, text: readFileSync(join(root, path), "utf-8") });
    const project = (index: number, overrides: Partial<WikiUnit>): WikiUnit => {
      const entry = onDisk.entities[index]!;
      return unit({
        id: entry.entity.id,
        file: path,
        revision: entry.entity.revision,
        contentHash: entry.entity.location.entityContentHash,
        ...overrides,
      });
    };

    const units: WikiUnit[] = [
      project(0, {}),
      project(1, {
        title: "Errors are returned rather than thrown",
        body: "Functions here return a result object rather than raising.",
      }),
    ];

    const found = findCandidateGroups(units);
    expect(found).toHaveLength(1);

    const planned = planGlobalPass(
      [
        {
          groupId: found[0]!.groupId,
          action: "merge",
          reasoning: "both state the same rule about the same function",
          canonicalUnit: {
            type: "convention",
            title: "Errors are returned, never thrown",
            summary: "Functions return a result object rather than throwing.",
            body: "Every public function returns a discriminated union instead of raising.",
            groundingNodeIds: [NODE],
          },
        },
      ],
      found,
      { graph },
    );

    const cache = createParseCache();
    for (const operation of planned.operations) {
      const applied = applyOperation(operation.envelope, { scaffoldRoot: root, graph, parseCache: cache });
      expect(applied.ok, JSON.stringify(applied.diagnostics)).toBe(true);
    }

    const after = parseWikiMarkdown({ path, text: readFileSync(join(root, path), "utf-8") });
    expect(after.diagnostics).toEqual([]);
    const byStatus = after.entities.map((entry) => entry.entity.status);
    expect(byStatus.filter((status) => status === "deprecated")).toHaveLength(2);
    expect(byStatus.filter((status) => status === "in_flight")).toHaveLength(1);

    const canonical = after.entities.find((entry) => entry.entity.status === "in_flight")!.entity;
    expect(canonical.relations.map((relation) => relation.target).sort()).toEqual(
      units.map((entry) => entry.id).sort(),
    );
    expect(canonical.groundsTo[0]!.node).toBe(NODE);
    // The prose the merge did not claim is still there.
    expect(readFileSync(join(root, path), "utf-8")).toContain("# Conventions");
  });
});

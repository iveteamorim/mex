/**
 * The seam: candidates in, operation plans out, nothing written.
 *
 * The end-to-end cases run the whole deterministic half — cluster, context,
 * prompt, agent response from a fixture, gate, propose, plan, apply — against a
 * real scaffold and a stub graph. That is the exit criterion the plan's own
 * "run it against a real repository" cannot check, because with no agent every
 * count is zero and the criterion passes over an empty set.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileForUnit, PLACEABLE_TYPES, proposeUnits, slugify } from "../propose.js";
import type { AcceptedUnit } from "../candidates.js";
import { validateCandidateUnits } from "../candidates.js";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { applyOperation } from "../../operations/apply.js";
import { planOperation } from "../../operations/plan.js";
import { createParseCache } from "../../operations/locate.js";
import { parseWikiMarkdown } from "../../markdown/contract.js";
import type { ClusterContext } from "../types.js";

const NODE = "function:a3f8c21d9e4b7f60a1c2d3e4f5061728";
const OTHER = "function:b4f8c21d9e4b7f60a1c2d3e4f5061729";
const FINGERPRINT = "mh:64:9f2a4c6e";
const BODY_HASH = "b".repeat(64);

const graph: GroundingGraph = {
  getNode: (id) =>
    id === NODE || id === OTHER
      ? { id, bodyHash: BODY_HASH, filePath: "src/token.ts", startLine: 1, endLine: 9 }
      : null,
  getFingerprint: (id) => (id === NODE || id === OTHER ? FINGERPRINT : null),
  reconcile: () => null,
  getBaselineSource: () => {
    throw new Error("proposing must not read the cached baseline");
  },
};

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-syn-"));
  roots.push(root);
  mkdirSync(join(root, "context"), { recursive: true });
  mkdirSync(join(root, "patterns"), { recursive: true });
  writeFileSync(join(root, "context", "architecture.md"), "# Architecture\n\nHow this system is shaped.\n", "utf-8");
  writeFileSync(join(root, "context", "conventions.md"), "# Conventions\n\nHow we work.\n", "utf-8");
  return root;
}

function unit(overrides: Partial<AcceptedUnit> = {}): AcceptedUnit {
  return {
    type: "component",
    title: "Token minting is centralised",
    summary: "Every token in the system is minted by one function, which is where expiry policy lives.",
    body: "The auth module exposes one mint path. Callers never construct a token themselves.",
    confidence: 0.9,
    grounding: { nodeIds: [NODE] },
    status: "promoted",
    stage: "architecture_component",
    cluster: "auth",
    ...overrides,
  };
}

describe("where a unit is filed", () => {
  it("uses the scaffold's own layout, keyed on type", () => {
    expect(fileForUnit(unit({ type: "architecture" }))).toBe("context/architecture.md");
    expect(fileForUnit(unit({ type: "component" }))).toBe("context/architecture.md");
    expect(fileForUnit(unit({ type: "convention" }))).toBe("context/conventions.md");
    expect(fileForUnit(unit({ type: "pattern", title: "Repository with a transaction boundary" }))).toBe(
      "patterns/auth-repository-with-a-transaction-boundary.md",
    );
  });

  it("has a rule for every type it claims to place, and no others", () => {
    for (const type of PLACEABLE_TYPES) expect(fileForUnit(unit({ type }))).not.toBeNull();
    expect(fileForUnit(unit({ type: "decision" }))).toBeNull();
  });

  it("slugifies deterministically and never to nothing", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  --  ")).toBe("unnamed");
    expect(slugify("Ünïcode  Names")).toBe("unicode-names");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("refuses a type it cannot file, rather than guessing a path", () => {
    const result = proposeUnits([unit({ type: "decision" })], { graph });
    expect(result.operations).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("no filing rule");
  });
});

describe("the operations it emits", () => {
  it("builds a create-entry carrying the graph's own grounding", () => {
    const result = proposeUnits([unit()], { graph, now: () => "2026-08-25T00:00:00.000Z" });

    expect(result.rejected).toEqual([]);
    expect(result.operations).toHaveLength(1);
    const envelope = result.operations[0]!.envelope as Record<string, unknown>;
    expect(envelope["type"]).toBe("create-entry");
    const payload = envelope["payload"] as Record<string, unknown>;
    expect(payload["file"]).toBe("context/architecture.md");
    expect(payload["headingDepth"]).toBe(2);
    expect(payload["status"]).toBe("promoted");
    // The fingerprint and body hash came from the graph, never from the unit.
    expect(payload["groundsTo"]).toEqual([
      { node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH, file: "src/token.ts" },
    ]);
  });

  it("keeps the confidence that chose the lifecycle state beside it", () => {
    const result = proposeUnits([unit({ confidence: 0.55, status: "in_flight" })], { graph });
    const payload = (result.operations[0]!.envelope as Record<string, unknown>)["payload"] as Record<string, unknown>;
    expect(payload["metadata"]).toEqual({
      synthesis: { confidence: 0.55, stage: "architecture_component", cluster: "auth" },
    });
  });

  it("derives the opId from the payload, so a re-proposal replays rather than conflicts", () => {
    // P5 treats one opId with two payloads as a validation failure. Deriving
    // the id from the payload makes that state unreachable: identical in,
    // identical id; reworded in, a different operation.
    const first = proposeUnits([unit()], { graph, now: () => "2026-08-25T00:00:00.000Z" });
    const again = proposeUnits([unit()], { graph, now: () => "2026-09-01T00:00:00.000Z" });
    expect(again.operations[0]!.opId).toBe(first.operations[0]!.opId);

    const reworded = proposeUnits([unit({ summary: "A different summary, at least ten characters long." })], { graph });
    expect(reworded.operations[0]!.opId).not.toBe(first.operations[0]!.opId);
  });

  it("refuses two patterns that would claim one file", () => {
    const result = proposeUnits(
      [
        unit({ type: "pattern", title: "Retry with backoff" }),
        unit({ type: "pattern", title: "Retry, with backoff!" }),
      ],
      { graph },
    );
    expect(result.operations).toHaveLength(1);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("already claims in this batch");
  });

  it("refuses a filing into a reserved read-only path", () => {
    const result = proposeUnits([unit()], { graph, readOnly: ["context/**"] });
    expect(result.operations).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("reserved read-only");
  });
});

describe("the section 12.4 gate", () => {
  it("drops a unit whose node the graph cannot produce, and says so", () => {
    // The gate provoked. `candidates.ts` catches an id that was never in the
    // context; this catches one that was, and has since gone.
    const stale = unit({ grounding: { nodeIds: ["function:vanished"] } });
    const result = proposeUnits([stale], { graph });

    expect(result.operations).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("function:vanished");
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["GROUNDING_UNVERIFIED"]);
  });

  it("refuses every unit when there is no graph at all", () => {
    const result = proposeUnits([unit()], { graph: null });
    expect(result.operations).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("no code graph is available");
  });

  it("drops only the ungrounded unit, not the batch", () => {
    const result = proposeUnits([unit(), unit({ title: "Gone", grounding: { nodeIds: ["function:vanished"] } })], {
      graph,
    });
    expect(result.operations).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });
});

describe("end to end, with the agent stubbed", () => {
  function context(): ClusterContext {
    return {
      cluster: { name: "auth", nodeIds: [NODE, OTHER], files: ["src/token.ts"], description: "auth" },
      nodes: [
        {
          id: NODE,
          kind: "function",
          name: "issueToken",
          filePath: "src/token.ts",
          importance: "primary",
          reason: "central function",
        },
      ],
      codeBlocks: [],
      truncated: false,
    };
  }

  /** Exactly what an agent would hand back, as a JSON string. */
  const RESPONSE = JSON.stringify({
    units: [
      {
        type: "component",
        title: "Token minting is centralised",
        summary: "Every token is minted by one function, which is where the expiry policy lives.",
        body: "The auth module exposes one mint path. Callers never construct a token themselves.",
        confidence: 0.91,
        grounding: { nodeIds: [NODE] },
        reasoning: "scratch space the model uses and mex drops",
      },
      {
        type: "component",
        title: "Weakly evidenced claim",
        summary: "Something the model was not confident about at all, but wrote anyway.",
        body: "A claim with a confidence below the floor, which must never reach a plan.",
        confidence: 0.2,
        grounding: { nodeIds: [NODE] },
      },
    ],
  });

  it("proposes, plans and applies, and every proposal survives preview", () => {
    const root = scaffold();
    const parsed = JSON.parse(RESPONSE) as { units: unknown[] };
    const gated = validateCandidateUnits(parsed.units, { stage: "architecture_component", context: context() });

    // The gate did its job on the way past: one accepted, one refused.
    expect(gated.accepted).toHaveLength(1);
    expect(gated.rejected).toHaveLength(1);

    const proposed = proposeUnits(gated.accepted, { graph });
    expect(proposed.operations).toHaveLength(1);

    // Every proposal is a valid operation that survives preview — the criterion
    // that actually matters, checked with no model anywhere.
    const cache = createParseCache();
    for (const operation of proposed.operations) {
      const plan = planOperation(operation.envelope, { scaffoldRoot: root, graph, parseCache: cache });
      expect(plan.ok, JSON.stringify(plan.ok ? [] : plan.diagnostics)).toBe(true);
    }

    const before = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    for (const operation of proposed.operations) {
      const applied = applyOperation(operation.envelope, { scaffoldRoot: root, graph, parseCache: cache });
      expect(applied.ok).toBe(true);
    }

    const after = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    // The prose that was there is still there, byte for byte, at the front.
    expect(after.startsWith(before.trimEnd())).toBe(true);
    const file = parseWikiMarkdown({ path: "context/architecture.md", text: after });
    expect(file.diagnostics).toEqual([]);
    expect(file.entities).toHaveLength(1);
    expect(file.entities[0]!.entity.title).toBe("Token minting is centralised");
    expect(file.entities[0]!.entity.status).toBe("promoted");
    expect(file.entities[0]!.entity.groundsTo[0]!.node).toBe(NODE);
    expect(file.entities[0]!.entity.metadata).toEqual({
      synthesis: { confidence: 0.91, stage: "architecture_component", cluster: "auth" },
    });
  });

  it("plans without writing, which is what a proposal is", () => {
    // §5.4 as a negative: planning moves nothing on disk and appends no audit
    // line. Asserted rather than assumed, because "returns a plan" would still
    // be true of a function that also wrote.
    const root = scaffold();
    const gated = validateCandidateUnits((JSON.parse(RESPONSE) as { units: unknown[] }).units, {
      stage: "architecture_component",
      context: context(),
    });
    const proposed = proposeUnits(gated.accepted, { graph });

    const before = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    for (const operation of proposed.operations) {
      planOperation(operation.envelope, { scaffoldRoot: root, graph });
    }

    expect(readFileSync(join(root, "context", "architecture.md"), "utf-8")).toBe(before);
    expect(existsSync(resolve(root, "events", "operations.jsonl"))).toBe(false);
  });

  it("creates a pattern file that did not exist, as a file-level entity", () => {
    const root = scaffold();
    const proposed = proposeUnits([unit({ type: "pattern", title: "Retry with backoff" })], { graph });
    const applied = applyOperation(proposed.operations[0]!.envelope, { scaffoldRoot: root, graph });
    expect(applied.ok).toBe(true);

    const path = join(root, "patterns", "auth-retry-with-backoff.md");
    const text = readFileSync(path, "utf-8");
    const file = parseWikiMarkdown({ path: "patterns/auth-retry-with-backoff.md", text });
    expect(file.diagnostics).toEqual([]);
    expect(file.entities).toHaveLength(1);
    expect(file.entities[0]!.metadataKind).toBe("frontmatter");
    expect(file.entities[0]!.entity.type).toBe("pattern");
  });

  it("applies twice with no second entity, because the opId replays", () => {
    const root = scaffold();
    const proposed = proposeUnits([unit()], { graph });
    applyOperation(proposed.operations[0]!.envelope, { scaffoldRoot: root, graph });
    const second = applyOperation(proposed.operations[0]!.envelope, { scaffoldRoot: root, graph });
    expect(second.replayed).toBe(true);

    const text = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    expect(parseWikiMarkdown({ path: "context/architecture.md", text }).entities).toHaveLength(1);
  });
});

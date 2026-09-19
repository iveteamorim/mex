/**
 * The gate between untrusted model output and mex's model.
 *
 * Trap 4 applies to every check in this file: the confidence gate and the
 * grounding gate are both trivially disable-able and both are the point of the
 * phase, so each one has a test that provokes it rather than only tests that
 * pass through it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONFIDENCE_IN_FLIGHT,
  CONFIDENCE_PROMOTED,
  contextNodeIds,
  extractArray,
  statusForConfidence,
  stripCodeFences,
  validateCandidateUnits,
} from "../candidates.js";
import { renderClusterContext, renderPrompt, renderPrompts, stageTypesAreRegistered, STAGE_TYPES, SYNTHESIS_STAGES } from "../prompts.js";
import type { ClusterContext } from "../types.js";

function context(): ClusterContext {
  return {
    cluster: {
      name: "auth",
      nodeIds: ["function:issueToken", "function:revokeToken"],
      files: ["auth/tokens.ts"],
      description: 'Module "auth" (auth/): 1 files, 2 symbols',
    },
    nodes: [
      {
        id: "function:issueToken",
        kind: "function",
        name: "issueToken",
        filePath: "auth/tokens.ts",
        importance: "primary",
        reason: "central function; exported symbol",
        signature: "issueToken(userId: string): string",
      },
      {
        id: "function:revokeToken",
        kind: "function",
        name: "revokeToken",
        filePath: "auth/tokens.ts",
        importance: "supporting",
        reason: "function with no strong centrality signals",
      },
    ],
    codeBlocks: [
      {
        id: "function:issueToken@1-3",
        nodeId: "function:issueToken",
        filePath: "auth/tokens.ts",
        startLine: 1,
        endLine: 3,
        kind: "exact_node_body",
        content: "export function issueToken() {\n  return 1;\n}",
        importance: "primary",
      },
    ],
    fileSummaries: [{ filePath: "auth/tokens.ts", exports: ["issueToken"], notes: "2 resolved symbols (1 exported)" }],
    truncated: false,
  };
}

function unit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "architecture",
    title: "Token issuance is centralised in the auth module",
    summary: "Every token in the system is minted by one function, which is where expiry policy lives.",
    body: "The auth module exposes a single mint path. Callers never construct a token themselves.",
    confidence: 0.9,
    grounding: { nodeIds: ["function:issueToken"] },
    ...overrides,
  };
}

describe("the candidate shape", () => {
  it("accepts a well-formed unit and drops the model's scratch field", () => {
    const result = validateCandidateUnits([unit({ reasoning: "because the code says so" })], {
      stage: "architecture_component",
      context: context(),
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.status).toBe("promoted");
    expect(result.accepted[0]!.cluster).toBe("auth");
    expect(result.accepted[0]!.stage).toBe("architecture_component");
    // `reasoning` is a model's working-out. It never reaches a repository.
    expect(Object.keys(result.accepted[0]!)).not.toContain("reasoning");
  });

  it("reports every reason a unit failed, not the first", () => {
    const result = validateCandidateUnits([unit({ title: "x", summary: "short", body: "tiny" })], {
      stage: "architecture_component",
      context: context(),
    });

    expect(result.accepted).toEqual([]);
    const reasons = result.rejected[0]!.reasons.join(" | ");
    expect(reasons).toContain("title");
    expect(reasons).toContain("summary");
    expect(reasons).toContain("body");
    // The path is what makes a rejection actionable across a batch of twelve.
    expect(result.rejected[0]!.reasons.some((reason) => reason.startsWith("units[0]."))).toBe(true);
  });

  it("keeps the raw unit on a rejection so a user can see what was refused", () => {
    const raw = unit({ confidence: 0.1 });
    const result = validateCandidateUnits([raw], { stage: "architecture_component", context: context() });
    expect(result.rejected[0]!.unit).toBe(raw);
  });

  it("refuses a unit with no grounding at all", () => {
    const result = validateCandidateUnits([unit({ grounding: { nodeIds: [] } })], {
      stage: "architecture_component",
      context: context(),
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("at least one code-graph node id");
  });

  it("refuses a type the stage may not emit", () => {
    const result = validateCandidateUnits([unit({ type: "pattern" })], {
      stage: "architecture_component",
      context: context(),
    });
    expect(result.rejected[0]!.reasons.join(" ")).toContain('is not allowed for stage "architecture_component"');
  });

  it("refuses a type that is not an entity type at all", () => {
    const result = validateCandidateUnits([unit({ type: "vibes" })], {
      stage: "architecture_component",
      context: context(),
    });
    expect(result.accepted).toEqual([]);
  });
});

describe("the grounding gate", () => {
  it("fires on a node id that was not in the context", () => {
    // The gate provoked, not merely present: this is the fabricated-id case,
    // and it is the cheap half of section 12.4.
    const result = validateCandidateUnits([unit({ grounding: { nodeIds: ["function:invented"] } })], {
      stage: "architecture_component",
      context: context(),
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("function:invented");
  });

  it("accepts an id that appears only as a code block's node", () => {
    const withBlockOnly = context();
    withBlockOnly.cluster.nodeIds = [];
    withBlockOnly.nodes = [];
    const ids = contextNodeIds(withBlockOnly);
    expect(ids.has("function:issueToken")).toBe(true);

    const result = validateCandidateUnits([unit()], { stage: "architecture_component", context: withBlockOnly });
    expect(result.accepted).toHaveLength(1);
  });

  it("names every missing id, so one re-run fixes them all", () => {
    const result = validateCandidateUnits(
      [unit({ grounding: { nodeIds: ["function:issueToken", "a", "b"] } })],
      { stage: "architecture_component", context: context() },
    );
    const reason = result.rejected[0]!.reasons.join(" ");
    expect(reason).toContain("a");
    expect(reason).toContain("b");
  });
});

describe("the confidence gate", () => {
  it("maps each band to the lifecycle it proposes", () => {
    expect(statusForConfidence(1)).toBe("promoted");
    expect(statusForConfidence(CONFIDENCE_PROMOTED)).toBe("promoted");
    expect(statusForConfidence(CONFIDENCE_PROMOTED - 0.0001)).toBe("in_flight");
    expect(statusForConfidence(CONFIDENCE_IN_FLIGHT)).toBe("in_flight");
    expect(statusForConfidence(CONFIDENCE_IN_FLIGHT - 0.0001)).toBeNull();
    expect(statusForConfidence(0)).toBeNull();
  });

  it("rejects below the floor, and says the number", () => {
    const result = validateCandidateUnits([unit({ confidence: 0.39 })], {
      stage: "architecture_component",
      context: context(),
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("0.39");
  });

  it("proposes in_flight in the middle band rather than promoted", () => {
    const result = validateCandidateUnits([unit({ confidence: 0.5 })], {
      stage: "architecture_component",
      context: context(),
    });
    expect(result.accepted[0]!.status).toBe("in_flight");
  });

  it("refuses a confidence outside [0, 1] instead of clamping it", () => {
    // A model that returns 1.4 has misunderstood the scale, and clamping hides
    // that from the person who has to trust the number.
    for (const confidence of [1.4, -0.2, Number.NaN]) {
      const result = validateCandidateUnits([unit({ confidence })], {
        stage: "architecture_component",
        context: context(),
      });
      expect(result.accepted, String(confidence)).toEqual([]);
    }
  });
});

describe("reading an agent response", () => {
  it("takes the three shapes agents actually send", () => {
    expect(extractArray({ units: [1, 2] }, "units")).toEqual([1, 2]);
    expect(extractArray([1, 2], "units")).toEqual([1, 2]);
    expect(extractArray('{"units":[1]}', "units")).toEqual([1]);
    expect(extractArray('```json\n{"units":[1]}\n```', "units")).toEqual([1]);
  });

  it("distinguishes an unreadable response from an empty one", () => {
    // Load-bearing: "you sent nothing valid" and "you validly sent nothing"
    // must not both look like a clean run that proposed nothing.
    expect(extractArray("not json at all", "units")).toBeNull();
    expect(extractArray({ notUnits: [] }, "units")).toBeNull();
    expect(extractArray({ units: [] }, "units")).toEqual([]);
  });

  it("strips a fence without eating an unfenced payload", () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe("the prompts", () => {
  it("only ever names entity types the model registers", () => {
    expect(stageTypesAreRegistered()).toBe(true);
  });

  it("renders three stages, each carrying its own vocabulary", () => {
    const prompts = renderPrompts(context());
    expect(prompts.map((prompt) => prompt.stage)).toEqual([...SYNTHESIS_STAGES]);
    for (const prompt of prompts) {
      expect(prompt.expectedTypes).toEqual(STAGE_TYPES[prompt.stage]);
      for (const type of prompt.expectedTypes) expect(prompt.system).toContain(`"${type}"`);
    }
  });

  it("teaches mex's lifecycle vocabulary and never the reference's", () => {
    // Trap 1: `active` is not a lifecycle state here. A prompt that taught it
    // would manufacture rejections in the validator on the next line.
    const system = renderPrompt(context(), "architecture_component").system;
    expect(system).toContain("promoted");
    expect(system).toContain("in_flight");
    expect(system).not.toMatch(/"active"/);
    expect(system).not.toMatch(/\bstale\b/);
  });

  it("puts every node id in the rendered context, since grounding is checked against them", () => {
    const rendered = renderClusterContext(context());
    for (const id of contextNodeIds(context())) expect(rendered).toContain(id);
    expect(rendered).toContain("### Primary symbols (1)");
    expect(rendered).toContain("### Supporting symbols (1)");
  });

  it("says what a trim dropped, in counts, so an absence is not read as a fact", () => {
    const trimmed = {
      ...context(),
      truncated: true,
      dropped: { nodes: 12, primaryBlocks: 3, supportingBlocks: 40 },
    };
    const rendered = renderClusterContext(trimmed);
    expect(rendered).toContain("12 symbol(s)");
    expect(rendered).toContain("3 primary code block(s)");
    expect(rendered).toContain("40 supporting code block(s)");
    expect(rendered).toContain("UNKNOWN");
    expect(renderClusterContext(context())).not.toContain("was trimmed");
  });

  it("fences source that contains its own fence", () => {
    // A cluster full of Markdown examples closes a three-backtick fence early,
    // after which the rest of the file reads to the model as instructions.
    const withFence = context();
    withFence.codeBlocks[0]!.content = "const doc = `x`;\n```\nnot instructions\n```";
    const rendered = renderClusterContext(withFence);
    expect(rendered).toContain("````");
    const fenceLines = rendered.split("\n").filter((line) => /^`{4,}$/.test(line));
    expect(fenceLines).toHaveLength(2);
  });

  it("is deterministic", () => {
    expect(renderClusterContext(context())).toBe(renderClusterContext(context()));
  });

  it("makes no network call and names no model", () => {
    // H1, asserted over the module's own source rather than trusted: a fetch
    // or an API key path here would be the one thing this product may not do.
    const text = readFileSync(resolve(__dirname, "..", "prompts.ts"), "utf-8");
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).not.toMatch(/anthropic|openai|gpt-|claude-3|gemini/i);
  });
});

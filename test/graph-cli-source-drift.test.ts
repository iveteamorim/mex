import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCommandDeps } from "../src/graph/cli-agent.js";
import { runGraphGet, runGraphQuery, runImpact } from "../src/graph/cli-agent.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";

const roots: string[] = [];
type Rec = Record<string, unknown>;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  stableId: string;
  driftingId: string;
}

/**
 * Two files, one calling the other, so a single edit leaves a usable half.
 */
async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-source-drift-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(root, "src", "drifting.ts"),
    "export function drifting(): number {\n  return 1;\n}\n");
  writeFileSync(join(root, "src", "stable.ts"),
    "export function stable(): number {\n  return 2;\n}\n"
    + "export function alsoStable(): number {\n  return stable();\n}\n");
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  const find = (name: string): string => {
    const node = engine.searchNodes(name).find((entry) => entry.name === name);
    if (!node) throw new Error(`fixture node ${name} missing`);
    return node.id;
  };
  const stableId = find("stable");
  const driftingId = find("drifting");
  engine.close();
  return { root, stableId, driftingId };
}

function editDriftingFile(root: string): void {
  writeFileSync(join(root, "src", "drifting.ts"),
    "export function drifting(): number {\n  // moved\n  return 3;\n}\n");
}

async function capture(command: (deps: AgentCommandDeps) => void | Promise<void>): Promise<Rec[]> {
  const output: string[] = [];
  await command({ write: (line) => output.push(line) });
  return output.map((line) => JSON.parse(line) as Rec);
}

const statusRecord = (records: Rec[]): Rec | undefined =>
  records.find((record) => record.type === "status");
const ofType = (records: Rec[], type: string): Rec[] =>
  records.filter((record) => record.type === type);

describe("graph reads with drifted source files", () => {
  it("answers from the files that did not change, and names the ones it left out", async () => {
    const { root } = await fixture();
    editDriftingFile(root);

    const records = await capture((deps) => runGraphQuery("who-calls", "stable", root, deps, {}));
    expect(records.find((record) => record.type === "error")).toBeUndefined();
    expect(statusRecord(records)).toMatchObject({
      graphStatus: "stale",
      reasons: ["source-drift"],
      excludedFiles: ["src/drifting.ts"],
      excludedFileCount: 1,
    });
    const results = ofType(records, "result");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((record) => record.filePath === "src/stable.ts")).toBe(true);
  });

  it("excludes a node whose own file drifted rather than describing it", async () => {
    const { root, driftingId } = await fixture();
    editDriftingFile(root);

    const records = await capture((deps) => runGraphGet([driftingId], root, deps, {}));
    // Present in the index, excluded from the answer, and said so explicitly.
    expect(records.find((record) => record.type === "error")).toMatchObject({
      code: "NODE_SOURCE_DRIFTED",
      filePath: "src/drifting.ts",
    });
    expect(ofType(records, "source")).toEqual([]);
  });

  it("returns a node from a file that did not drift", async () => {
    const { root, stableId } = await fixture();
    editDriftingFile(root);

    const records = await capture((deps) => runGraphGet([stableId], root, deps, { detail: "source" }));
    expect(records.find((record) => record.type === "error")).toBeUndefined();
    expect(statusRecord(records)).toMatchObject({ reasons: ["source-drift"] });
    expect(ofType(records, "source").length).toBeGreaterThan(0);
  });

  it("says a target resolved only into excluded files", async () => {
    const { root } = await fixture();
    editDriftingFile(root);

    const records = await capture((deps) => runImpact("drifting", root, deps, {}));
    // The symbol exists; what the store can no longer describe is where. An
    // empty result would be true and useless.
    expect(statusRecord(records)).toMatchObject({
      reasons: ["source-drift"],
      excludedFiles: ["src/drifting.ts"],
    });
    expect(records.find((record) => record.type === "error"))
      .toMatchObject({ code: "TARGET_SOURCE_DRIFTED", filePaths: ["src/drifting.ts"] });
  });

  it("treats a deleted indexed file as drift and keeps answering", async () => {
    const { root } = await fixture();
    // A deleted indexed file is drift like any other and stays serveable.
    rmSync(join(root, "src", "drifting.ts"));
    const records = await capture((deps) => runGraphQuery("who-calls", "stable", root, deps, {}));
    expect(records.find((record) => record.type === "error")).toBeUndefined();
    expect(statusRecord(records)).toMatchObject({
      reasons: ["source-drift"],
      excludedFiles: ["src/drifting.ts"],
    });
  });

  it("emits nothing extra while every indexed file still matches", async () => {
    const { root } = await fixture();
    const records = await capture((deps) => runGraphQuery("who-calls", "stable", root, deps, {}));
    expect(statusRecord(records)).toBeUndefined();
    expect(records.every((record) => record.stale === undefined)).toBe(true);
  });

  it("is byte-identical across repeated drifted reads", async () => {
    const { root } = await fixture();
    editDriftingFile(root);
    const once: string[] = [];
    const twice: string[] = [];
    await runGraphQuery("who-calls", "stable", root, { write: (line) => once.push(line) }, {});
    await runGraphQuery("who-calls", "stable", root, { write: (line) => twice.push(line) }, {});
    expect(twice).toEqual(once);
  });
});

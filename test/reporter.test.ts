import { afterEach, describe, expect, it, vi } from "vitest";
import { reportConsole, reportQuiet } from "../src/reporter.js";
import type { GraphAwareDriftReport } from "../src/drift/index.js";
import type { GraphStatus } from "../src/team/contracts/graph.js";

function status(
  kind: GraphStatus["status"],
  diagnostics: GraphStatus["diagnostics"] = [],
): GraphStatus {
  return {
    status: kind,
    observedAt: "2026-08-22T00:00:00.000Z",
    currentRepo: {
      branch: "feat/graph-freshness-recovery",
      head: "a".repeat(40),
      dirty: true,
      observedAt: "2026-08-22T00:00:00.000Z",
    },
    lastSuccessfulIndexAt: "2026-08-21T00:00:00.000Z",
    indexedAt: "2026-08-21T00:00:00.000Z",
    indexedBranch: "feat/graph-freshness-recovery",
    indexedHead: "a".repeat(40),
    schemaVersion: 2,
    extractorVersion: "test",
    grammarVersion: "b".repeat(64),
    parseHealth: {
      total: 2,
      ok: 2,
      partial: 0,
      failed: 0,
      failedPaths: [],
      failedPathsTruncated: false,
    },
    changes: {
      total: 2,
      added: ["src/new.ts"],
      modified: ["src/service.ts"],
      deleted: [],
      truncated: false,
      branchChanged: false,
      manifestChanged: false,
      configChanged: false,
      grammarChanged: false,
    },
    diagnostics,
  };
}

function report(graphStatus: GraphStatus): GraphAwareDriftReport {
  return {
    score: 100,
    issues: [],
    filesChecked: 3,
    timestamp: "2026-08-22T00:00:00.000Z",
    graphStatus,
  };
}

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("graph-aware reporters", () => {
  it("renders status, change counts, and a diagnostic-provided command in console output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const graph = status("stale", [{
      code: "GRAPH_SOURCE_STALE",
      severity: "warning",
      message: "Sources changed.",
      remediation: [{ label: "Refresh graph", command: "mex graph" }],
    }]);

    reportConsole(report(graph));

    const rendered = output(log);
    expect(rendered).toContain("graph stale");
    expect(rendered).toContain("2 source changes");
    expect(rendered).toContain("1 added, 1 modified, 0 deleted");
    expect(rendered).toContain("run `mex graph`");
    expect(rendered).toContain("GRAPH_SOURCE_STALE: Sources changed.");
  });

  it("renders graph status in quiet output without inventing a recovery command", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const graph = status("stale", [{
      code: "GRAPH_BRANCH_CHANGED",
      severity: "warning",
      message: "The branch changed.",
      remediation: [{ label: "Review branch state" }],
    }]);
    graph.changes.total = 0;
    graph.changes.added = [];
    graph.changes.modified = [];
    graph.changes.branchChanged = true;

    reportQuiet(report(graph));

    const rendered = output(log);
    expect(rendered).toContain("graph stale");
    expect(rendered).toContain("0 source changes");
    expect(rendered).toContain("branch changed");
    expect(rendered).not.toContain("mex graph");
  });

  it("does not present bounded path arrays as exact category totals", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const graph = status("stale");
    graph.changes.total = 101;
    graph.changes.added = Array.from({ length: 100 }, (_, index) => `src/new-${index}.ts`);
    graph.changes.modified = [];
    graph.changes.truncated = true;

    reportQuiet(report(graph));

    const rendered = output(log);
    expect(rendered).toContain("101 source changes");
    expect(rendered).toContain("path details truncated");
    expect(rendered).not.toContain("100 added, 0 modified, 0 deleted");
  });
});

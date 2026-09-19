import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  ErrorScreen,
  HeartbeatPanel,
  DoctorPanel,
  Summary,
  TimelinePanel,
  eventActivityBars,
  progressBar,
  type DashboardData,
} from "../src/tui.js";
import type { GraphStatus } from "../src/team/contracts/graph.js";

const h = React.createElement;

function graphStatus(status: GraphStatus["status"] = "fresh"): GraphStatus {
  return {
    status,
    observedAt: "2026-05-14T00:00:00.000Z",
    currentRepo: {
      branch: "feat/graph-freshness-recovery",
      head: "a".repeat(40),
      dirty: false,
      observedAt: "2026-05-14T00:00:00.000Z",
    },
    lastSuccessfulIndexAt: "2026-05-14T00:00:00.000Z",
    indexedAt: "2026-05-14T00:00:00.000Z",
    indexedBranch: "feat/graph-freshness-recovery",
    indexedHead: "a".repeat(40),
    schemaVersion: 2,
    extractorVersion: "test",
    grammarVersion: "b".repeat(64),
    parseHealth: {
      total: 0,
      ok: 0,
      partial: 0,
      failed: 0,
      failedPaths: [],
      failedPathsTruncated: false,
    },
    changes: {
      total: 0,
      added: [],
      modified: [],
      deleted: [],
      truncated: false,
      branchChanged: false,
      manifestChanged: false,
      configChanged: false,
      grammarChanged: false,
    },
    diagnostics: [],
  };
}

type DashboardOverrides = Omit<Partial<DashboardData>, "report"> & {
  report?: Partial<DashboardData["report"]>;
};

function data(overrides: DashboardOverrides = {}): DashboardData {
  const base: DashboardData = {
    report: {
      score: 100,
      issues: [],
      filesChecked: 3,
      timestamp: "2026-05-14T00:00:00.000Z",
      graphStatus: graphStatus(),
    },
    heartbeat: {
      ok: true,
      staleFiles: [],
      memoryCleanupDue: false,
      oldDailyMemoryFiles: [],
    },
    events: [],
  };
  return {
    ...base,
    ...overrides,
    report: { ...base.report, ...overrides.report },
  };
}

describe("TUI components", () => {
  it("renders healthy dashboard summary", () => {
    const app = render(h(Summary, { data: data(), notice: null }));
    expect(app.lastFrame()).toContain("Drift");
    expect(app.lastFrame()).toContain("100/100");
    expect(app.lastFrame()).toContain("Heartbeat OK");
    expect(app.lastFrame()).toContain("████");
  });

  describe.each([
    ["Summary", Summary],
    ["HeartbeatPanel", HeartbeatPanel],
    ["DoctorPanel", DoctorPanel],
  ] as const)("%s staleness participation", (name, Component) => {
    it.each([true, false])("shows inactive checks and opt-in guidance when heartbeat ok=%s", (ok) => {
      const app = render(h(Component, {
        data: data({
          heartbeat: {
            ok,
            staleFiles: [],
            memoryCleanupDue: !ok,
            oldDailyMemoryFiles: ok ? [] : ["memory/2026-04-20.md"],
            filesWithoutLastUpdated: 3,
          },
        }),
        notice: null,
      }));
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("staleness checks inactive");
      expect(frame).toContain("Add last_updated: YYYY-MM-DD");
      expect(frame).toContain("frontmatter to opt files in");
      expect(frame).not.toContain("scaffold is fresh");
      if (name === "Summary") {
        expect(frame).toContain(ok ? "Heartbeat OK" : "Heartbeat Attention");
      } else if (name === "HeartbeatPanel") {
        if (ok) expect(frame).toContain("HEARTBEAT_OK");
        else {
          expect(frame).toContain("Memory cleanup is due.");
          expect(frame).toContain("Old memory memory/2026-04-20.md");
        }
      } else {
        expect(frame).toContain(ok ? "Scaffold looks healthy." : "Scaffold needs attention.");
        expect(frame).toContain(ok ? "Heartbeat OK" : "Run `mex heartbeat` for details.");
      }
    });

    it("preserves healthy output when staleness checks participate", () => {
      const app = render(h(Component, { data: data(), notice: null }));
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("staleness checks inactive");
      expect(frame).not.toContain("Add last_updated");
      if (name === "Summary") expect(frame).toContain("Heartbeat OK");
      if (name === "HeartbeatPanel") expect(frame).toContain("HEARTBEAT_OK · scaffold is fresh");
      if (name === "DoctorPanel") expect(frame).toContain("Scaffold looks healthy.");
    });
  });

  it("renders drift warnings and errors in summary", () => {
    const app = render(h(Summary, {
      data: data({
        report: {
          score: 77,
          issues: [
            { code: "MISSING_PATH", severity: "error", file: "ROUTER.md", line: null, message: "missing" },
            { code: "STALE_FILE", severity: "warning", file: "context/stack.md", line: null, message: "stale" },
          ],
          filesChecked: 4,
          timestamp: "2026-05-14T00:00:00.000Z",
        },
      }),
      notice: null,
    }));
    expect(app.lastFrame()).toContain("1 error · 1 warning");
  });

  it("renders graph freshness without triggering maintenance", () => {
    const app = render(h(Summary, {
      data: data({
        report: {
          score: 100,
          issues: [],
          filesChecked: 3,
          timestamp: "2026-05-14T00:00:00.000Z",
          graphStatus: {
            ...graphStatus("stale"),
            changes: {
              ...graphStatus("stale").changes,
              total: 1,
              modified: ["src/service.ts"],
              branchChanged: true,
            },
          },
        },
      }),
      notice: null,
    }));
    expect(app.lastFrame()).toContain("Graph");
    expect(app.lastFrame()).toContain("Attention");
    expect(app.lastFrame()).toContain("stale · 1 source change");
    expect(app.lastFrame()).toContain("branch changed");
  });

  it("renders the primary graph diagnostic in the doctor panel", () => {
    const stale = graphStatus("corrupt");
    stale.diagnostics = [{
      code: "GRAPH_INDEX_CORRUPT",
      severity: "error",
      message: "SQLite quick-check failed.",
    }];
    const app = render(h(DoctorPanel, {
      data: data({ report: { graphStatus: stale } }),
    }));
    expect(app.lastFrame()).toContain("Graph detail");
    expect(app.lastFrame()).toContain("GRAPH_INDEX_CORRUPT");
    expect(app.lastFrame()).toContain("SQLite quick-check failed");
  });

  it("renders heartbeat stale files", () => {
    const app = render(h(HeartbeatPanel, {
      data: data({
        heartbeat: {
          ok: false,
          staleFiles: [{ file: "context/architecture.md", days: 12 }],
          memoryCleanupDue: false,
          oldDailyMemoryFiles: [],
        },
      }),
    }));
    expect(app.lastFrame()).toContain("context/architecture.md");
    expect(app.lastFrame()).toContain("12 days");
  });

  it("renders timeline entries in provided order", () => {
    const app = render(h(TimelinePanel, {
      data: data({
        events: [
          { timestamp: "2026-05-14T00:00:00.000Z", kind: "decision", message: "newer", files: [], cwd: "." },
          { timestamp: "2026-05-01T00:00:00.000Z", kind: "note", message: "older", files: [], cwd: "." },
        ],
      }),
    }));
    const frame = app.lastFrame() ?? "";
    expect(frame.indexOf("newer")).toBeLessThan(frame.indexOf("older"));
  });

  it("renders timeline empty state", () => {
    const app = render(h(TimelinePanel, { data: data() }));
    expect(app.lastFrame()).toContain("No events yet");
  });

  it("builds progress bars for status rows", () => {
    expect(progressBar(50, 10)).toBe("█████░░░░░");
    expect(progressBar(200, 4)).toBe("████");
  });

  it("builds event activity bars oldest to newest", () => {
    const bars = eventActivityBars([
      { timestamp: "2026-05-12T10:00:00.000Z", kind: "decision", message: "one", files: [], cwd: "." },
      { timestamp: "2026-05-14T10:00:00.000Z", kind: "note", message: "two", files: [], cwd: "." },
      { timestamp: "2026-05-14T11:00:00.000Z", kind: "risk", message: "three", files: [], cwd: "." },
    ], 3, new Date("2026-05-14T12:00:00.000Z"));
    expect(bars).toBe("▅▁█");
  });

  it("renders no-scaffold error screen", () => {
    const app = render(h(ErrorScreen, { message: "No .mex/ scaffold found. Run: mex setup" }));
    expect(app.lastFrame()).toContain("could not start");
    expect(app.lastFrame()).toContain("mex setup");
  });
});

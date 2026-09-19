import { describe, expect, it, vi } from "vitest";
import type { TeamCommandIo } from "../../../cli/commands.js";
import { TEAM_CLI_EXIT } from "../../../cli/envelope.js";
import { MockWikiPort } from "../../../testing/wiki/mock-wiki-port.js";
import { POPULATED_WIKI_FIXTURE } from "../../../testing/wiki/populated-fixture.js";
import { createSpecReadService } from "../../service.js";
import { buildSpecCommand } from "../builder.js";
import { runSpecList, runSpecShow } from "../commands.js";
import type { SpecCliService } from "../service.js";

describe("read-only Spec CLI leaf", () => {
  it("emits the shared schema-v1 envelope and passes bounded filters to one service", async () => {
    const real = createSpecReadService(new MockWikiPort());
    const service: SpecCliService & { list: ReturnType<typeof vi.fn> } = {
      list: vi.fn(real.list.bind(real)),
      show: real.show.bind(real),
    };
    const output = captureIo();

    await runSpecList(service, {
      json: true,
      limit: "10",
      includeArchived: true,
      lifecycle: "promoted",
      grounding: "fresh",
      topic: POPULATED_WIKI_FIXTURE.refs.topic,
    }, output.io);

    expect(service.list).toHaveBeenCalledWith({
      limit: 10,
      includeArchived: true,
      lifecycleStates: ["promoted"],
      groundingHealth: ["fresh"],
      topics: [POPULATED_WIKI_FIXTURE.refs.topic],
    });
    expect(output.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);
    expect(JSON.parse(output.lines[0]!)).toMatchObject({
      schemaVersion: 1,
      command: "spec.list",
      mode: "read",
      ok: true,
      data: {
        availability: "ready",
        index: { state: "fresh" },
        page: {
          items: [{
            id: POPULATED_WIKI_FIXTURE.refs.spec,
            kind: "spec",
            title: "Idempotent payment capture",
          }],
          nextCursor: null,
        },
      },
      problem: null,
    });
    expect(output.lines[0]).not.toMatch(/[\u001b]/u);
  });

  it("renders root detail and hierarchy from the same service projection", async () => {
    const output = captureIo();
    await runSpecShow(
      createSpecReadService(new MockWikiPort()),
      POPULATED_WIKI_FIXTURE.refs.spec,
      {},
      output.io,
    );

    expect(output.exitCodes).toEqual([TEAM_CLI_EXIT.ok]);
    expect(output.lines).toContain(
      `Idempotent payment capture (${POPULATED_WIKI_FIXTURE.refs.spec})`,
    );
    expect(output.lines).toContain("Lifecycle: promoted");
    expect(output.lines.some((line) => line.startsWith("Hierarchy: 1 requirements"))).toBe(true);
  });

  it("maps stale, unavailable, and missing records into typed Team problems", async () => {
    const stale = captureIo();
    await runSpecList(
      createSpecReadService(new MockWikiPort({ indexState: "stale" })),
      { json: true },
      stale.io,
    );
    expect(stale.exitCodes).toEqual([TEAM_CLI_EXIT.unavailable]);
    expect(JSON.parse(stale.lines[0]!)).toMatchObject({
      ok: false,
      data: null,
      problem: { code: "INDEX_STALE" },
    });

    const missingIndex = captureIo();
    await runSpecList(
      createSpecReadService(new MockWikiPort({ indexState: "missing" })),
      { json: true },
      missingIndex.io,
    );
    expect(missingIndex.exitCodes).toEqual([TEAM_CLI_EXIT.unavailable]);
    expect(JSON.parse(missingIndex.lines[0]!)).toMatchObject({
      problem: { code: "INDEX_MISSING" },
    });

    const missingSpec = captureIo();
    await runSpecShow(
      createSpecReadService(new MockWikiPort()),
      "mx_01J0000000000000000000000Z",
      { json: true },
      missingSpec.io,
    );
    expect(missingSpec.exitCodes).toEqual([TEAM_CLI_EXIT.unavailable]);
    expect(JSON.parse(missingSpec.lines[0]!)).toMatchObject({
      problem: { code: "NOT_FOUND" },
    });
  });

  it("advertises maintenance only when the exact Wiki state makes it safe", async () => {
    for (const testCase of [
      {
        state: "migration_required" as const,
        code: "MIGRATION_REQUIRED",
        recovery: [{
          label: "Preview the required Wiki migration",
          command: "mex wiki migrate --dry-run --json",
        }],
      },
      { state: "degraded" as const, code: "OPERATION_INTERRUPTED", recovery: [] },
      { state: "corrupt" as const, code: "INDEX_CORRUPT", recovery: [] },
    ]) {
      const output = captureIo();
      const service: SpecCliService = {
        list: async () => ({
          availability: "unavailable",
          index: {
            state: testCase.state,
            observedAt: "2026-08-28T00:00:00.000Z",
            indexedRevision: null,
            indexedAt: null,
            diagnostics: [],
            diagnosticsTruncated: false,
          },
          page: null,
        }),
        show: async () => { throw new Error("unused"); },
      };
      await runSpecList(service, { json: true }, output.io);
      expect(JSON.parse(output.lines[0]!)).toMatchObject({
        problem: {
          code: testCase.code,
          ...(testCase.recovery.length === 0 ? {} : { recovery: testCase.recovery }),
        },
      });
      if (testCase.recovery.length === 0) {
        expect(JSON.parse(output.lines[0]!).problem).not.toHaveProperty("recovery");
      }
    }
  });

  it("rejects invalid flags before resolving or reading the service", async () => {
    const factory = vi.fn(async () => createSpecReadService(new MockWikiPort()));
    const limit = captureIo();
    await runSpecList(factory, { json: true, limit: 101 }, limit.io);
    expect(limit.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);
    expect(JSON.parse(limit.lines[0]!)).toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });

    const cursor = captureIo();
    await runSpecList(factory, { json: true, cursor: "x".repeat(4_097) }, cursor.io);
    expect(cursor.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);

    const lifecycle = captureIo();
    await runSpecList(factory, { json: true, lifecycle: "stale" }, lifecycle.io);
    expect(lifecycle.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);

    const id = captureIo();
    await runSpecShow(factory, "not-a-wiki-id", { json: true }, id.io);
    expect(id.exitCodes).toEqual([TEAM_CLI_EXIT.usage]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("builds exactly list/show with no mutation or generic Wiki commands", () => {
    const service = createSpecReadService(new MockWikiPort());
    const output = captureIo();
    const command = buildSpecCommand({ service: () => service, io: output.io });
    expect(command.name()).toBe("spec");
    expect(command.commands.map((child) => child.name())).toEqual(["list", "show"]);
  });
});

function captureIo(): { io: TeamCommandIo; lines: string[]; exitCodes: number[] } {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  return {
    lines,
    exitCodes,
    io: {
      write: (line) => lines.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
  };
}

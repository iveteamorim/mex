import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, readEvents, EVENT_KINDS, type EventEntry } from "mex-agent";
import { registerTimelineTool } from "../src/tools/timeline.js";

vi.mock("mex-agent", async (original) => ({
  ...(await original<typeof import("mex-agent")>()),
  findConfig: vi.fn(),
  readEvents: vi.fn(),
}));

function tool() {
  const register = vi.fn();
  registerTimelineTool({ tool: register } as unknown as McpServer);
  const [, description, shape, handler] = register.mock.calls[0];
  return {
    description: description as string,
    schema: z.object(shape as z.ZodRawShape),
    handler: handler as (options: { kind?: string; since?: string; limit: number }) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  };
}

beforeEach(() => {
  vi.mocked(findConfig).mockReturnValue({ projectRoot: "/project", scaffoldRoot: "/project/.mex", aiTools: [] });
  vi.mocked(readEvents).mockReturnValue([]);
});

describe("MCP timeline", () => {
  it("advertises and accepts only supported project-note kinds", () => {
    const { schema, description } = tool();
    for (const kind of EVENT_KINDS) expect(schema.safeParse({ kind }).success).toBe(true);
    for (const kind of ["session_start", "checkpoint", "unknown"]) expect(schema.safeParse({ kind }).success).toBe(false);
    expect(description).toContain("historical");
    expect(description).toContain("8 MiB");
    expect(description).not.toContain("what an agent did");
  });

  it("rejects excessive limits and malformed timestamps", () => {
    const { schema } = tool();
    for (const limit of [0, -1, 201, 1.5]) expect(schema.safeParse({ limit }).success).toBe(false);
    expect(schema.safeParse({ since: "yesterday" }).success).toBe(false);
    expect(schema.safeParse({ since: "2026-05-14T00:00:00.000Z", limit: 200 }).success).toBe(true);
  });

  it("filters actual kinds and times while retaining provenance and stable recent ties", async () => {
    vi.mocked(readEvents).mockReturnValue([
      { timestamp: "2026-05-14T00:00:00.000Z", kind: "decision", message: "first", files: [], cwd: "." },
      { timestamp: "2026-05-14T00:00:00.000Z", kind: "decision", message: "second", files: ["src/a.ts"], cwd: ".", source: "meeting", status: "decided" },
      { timestamp: "2026-05-14T00:00:00.000Z", kind: "risk", message: "different kind", files: [], cwd: "." },
      { timestamp: "2026-04-01T00:00:00.000Z", kind: "decision", message: "older", files: [], cwd: "." },
    ]);
    const result = await tool().handler({ kind: "decision", since: "2026-05-01T00:00:00.000Z", limit: 50 });
    expect(JSON.parse(result.content[0].text)).toEqual([
      expect.objectContaining({ message: "second", source: "meeting", status: "decided", files: ["src/a.ts"] }),
      expect.objectContaining({ message: "first" }),
    ]);
    expect(result.content).toHaveLength(1);
  });

  it("keeps UTF-8 responses bounded, reports omission, and never shortens an event", async () => {
    const message = "界".repeat(1000);
    const base: EventEntry = { timestamp: "2026-05-14T00:00:00.000Z", kind: "note", message, files: [], cwd: "." };
    vi.mocked(readEvents).mockReturnValue([...Array.from({ length: 30 }, () => base), { ...base, message: "💡".repeat(20_000) }]);
    const result = await tool().handler({ limit: 200 });
    expect(Buffer.byteLength(result.content.map((entry) => entry.text).join("\n"), "utf8")).toBeLessThanOrEqual(64 * 1024);
    const entries = JSON.parse(result.content[0].text) as EventEntry[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(30);
    expect(entries.every((entry) => entry.message === message)).toBe(true);
    expect(result.content[1].text).toContain("omitted");
  });
});

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, readEvents, EVENT_KINDS, type EventEntry } from "mex-agent";

const MAX_TIMELINE_OUTPUT_BYTES = 64 * 1024;

export function registerTimelineTool(server: McpServer) {
  server.tool(
    "mex_timeline",
    "Read historical project notes, optionally filtered by kind or time. Scans at most the latest 8 MiB / 10,000 non-empty log lines; older history may be absent. Recorded notes are historical context, not verified current knowledge.",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      kind: z
        .enum(EVENT_KINDS)
        .optional()
        .describe(`Filter by event kind: ${EVENT_KINDS.join(", ")}.`),
      since: z
        .string()
        .max(64)
        .datetime({ offset: true })
        .optional()
        .describe("ISO 8601 timestamp — return only events at or after this time."),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ projectRoot, kind, since, limit }) => {
      const root = projectRoot ?? process.cwd();
      let config;
      try {
        config = findConfig(root);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: (e as Error).message, projectRoot: root }),
            },
          ],
        };
      }
      let events = readEvents(config);
      if (kind) events = events.filter((e) => e.kind === kind);
      if (since) {
        const sinceMs = new Date(since).getTime();
        events = events.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
      }
      events.reverse().sort((a, b) => a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0);
      const selected: EventEntry[] = [];
      let outputBytes = 0;
      for (const event of events) {
        if (selected.length === limit) break;
        const serialized = JSON.stringify(event, null, 2);
        const bytes = Buffer.byteLength(serialized, "utf8") + 2 * serialized.split("\n").length + 4;
        if (outputBytes + bytes > MAX_TIMELINE_OUTPUT_BYTES - 512) continue;
        selected.push(event);
        outputBytes += bytes;
      }
      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: JSON.stringify(selected, null, 2) },
      ];
      if (selected.length < events.length) {
        content.push({ type: "text", text: "Some matching events were omitted by the entry or 64 KiB output limit; narrow the filters." });
      }
      return {
        content,
      };
    }
  );
}

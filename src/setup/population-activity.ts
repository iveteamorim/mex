import type { SetupAgentTool } from "./population.js";

export type PopulationActivityKind =
  | "starting" | "started" | "reading" | "searching" | "writing"
  | "running_command" | "delegating" | "working" | "completed" | "failed";
export type PopulationActivityTarget =
  | "architecture" | "stack" | "conventions" | "decisions" | "setup"
  | "router" | "agents" | "patterns";
export interface PopulationActivitySignal {
  readonly kind: PopulationActivityKind;
  readonly state: "running" | "completed" | "failed";
  readonly target?: PopulationActivityTarget;
}

const MAX_LINE_BYTES = 64 * 1024;
const MAX_CONTENT_BLOCKS = 64;
const MAX_TRACKED_TOOLS = 128;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 2048;

interface PopulationActivityDecoder {
  write(chunk: Buffer): void;
  end(): void;
  readonly failed: boolean;
  readonly completed: boolean;
}

/**
 * Decode only allowlisted activity from provider JSONL. No source text, tool
 * arguments, IDs, commands, paths, or reasoning cross this boundary. Oversized
 * records are discarded through their next newline, not truncated into JSON.
 *
 * Protocol references:
 * https://code.claude.com/docs/en/headless
 * https://code.claude.com/docs/en/agent-sdk/streaming-output
 * https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts
 * https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
 * https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs
 */
export function createPopulationActivityDecoder(
  tool: SetupAgentTool,
  onSignal: (signal: PopulationActivitySignal) => void,
): PopulationActivityDecoder {
  const line = Buffer.alloc(MAX_LINE_BYTES);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const tools = new Map<string, PopulationActivitySignal>();
  let length = 0;
  let oversized = false;
  let ended = false;
  let failed = false;
  let completed = false;

  const fail = () => {
    if (failed) return;
    failed = true;
    onSignal({ kind: "failed", state: "failed" });
  };

  const remember = (id: string, signal: PopulationActivitySignal) => {
    if (!tools.has(id) && tools.size >= MAX_TRACKED_TOOLS) {
      tools.delete(tools.keys().next().value!);
    }
    tools.set(id, signal);
  };

  const toolStarted = (block: Record<string, unknown>) => {
    if (block.type !== "tool_use" || typeof block.name !== "string") return;
    const kind = claudeToolKind(block.name);
    const input = record(block.input);
    const target = kind === "reading" || kind === "writing" ? targetForPath(input?.file_path) : undefined;
    const signal: PopulationActivitySignal = { kind, state: "running", ...(target ? { target } : {}) };
    const id = boundedId(block.id);
    if (id) {
      const previous = tools.get(id);
      // Partial tool input is followed by the full assistant block. Only emit
      // again when it adds a safe target; do not count one call twice.
      if (previous && previous.kind === kind && (!target || previous.target === target)) return;
      remember(id, signal);
    }
    onSignal(signal);
  };

  const claudeRecord = (event: Record<string, unknown>) => {
    if (event.type === "system" && event.subtype === "init") {
      completed = false;
      onSignal({ kind: "started", state: "running" });
    } else if (event.type === "result") {
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error_"))) fail();
      else if (event.subtype === "success" && !failed) {
        completed = true;
        onSignal({ kind: "completed", state: "completed" });
      }
    } else if (event.type === "stream_event") {
      const partial = record(event.event);
      if (partial?.type === "message_start") onSignal({ kind: "working", state: "running" });
      else if (partial?.type === "content_block_start") {
        const block = record(partial.content_block);
        if (block) toolStarted(block);
      } else if (partial?.type === "content_block_delta") {
        const type = record(partial.delta)?.type;
        if (type === "text_delta" || type === "thinking_delta" || type === "input_json_delta") {
          // The existence of a recognized event proves activity. Its private
          // body is neither inspected nor retained or projected.
          onSignal({ kind: "working", state: "running" });
        }
      }
      // content_block_stop finishes the generated input, not the executed tool.
    } else if (event.type === "assistant" || event.type === "user") {
      const content = record(event.message)?.content;
      if (!Array.isArray(content)) return;
      for (const value of content.slice(0, MAX_CONTENT_BLOCKS)) {
        const block = record(value);
        if (!block) continue;
        if (event.type === "assistant") toolStarted(block);
        else if (block.type === "tool_result") {
          const id = boundedId(block.tool_use_id);
          const started = id ? tools.get(id) : undefined;
          if (!id || !started) continue;
          tools.delete(id);
          onSignal({ ...started, state: block.is_error === true ? "failed" : "completed" });
        }
      }
    } else if (event.type === "tool_progress") {
      const id = boundedId(event.tool_use_id);
      const started = id ? tools.get(id) : undefined;
      if (started) onSignal(started);
    }
  };

  const codexRecord = (event: Record<string, unknown>) => {
    if (event.type === "thread.started") {
      completed = false;
      onSignal({ kind: "started", state: "running" });
    } else if (event.type === "turn.started") {
      completed = false;
      onSignal({ kind: "working", state: "running" });
    } else if (event.type === "turn.failed" || event.type === "error") fail();
    else if (event.type === "turn.completed") {
      if (!failed) {
        completed = true;
        onSignal({ kind: "completed", state: "completed" });
      }
    } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      const item = record(event.item);
      if (!item) return;
      let kind: PopulationActivityKind;
      switch (item.type) {
        case "command_execution": kind = "running_command"; break;
        case "file_change": kind = "writing"; break;
        case "web_search": kind = "searching"; break;
        case "collab_tool_call": kind = "delegating"; break;
        case "agent_message": case "reasoning":
          onSignal({ kind: "working", state: "running" }); return;
        case "mcp_tool_call":
        case "todo_list": kind = "working"; break;
        // This is a recoverable item error, unlike top-level error/turn.failed.
        case "error": onSignal({ kind: "working", state: "failed" }); return;
        default: return;
      }
      const state = item.status === "failed" || item.status === "declined"
        || (item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0)
        ? "failed" : event.type === "item.completed" || item.status === "completed" ? "completed" : "running";
      if (item.type === "file_change" && Array.isArray(item.changes)) {
        const targets = new Set<PopulationActivityTarget | undefined>();
        for (const change of item.changes.slice(0, MAX_CONTENT_BLOCKS)) targets.add(targetForPath(record(change)?.path));
        for (const target of targets) onSignal({ kind, state, ...(target ? { target } : {}) });
        if (targets.size > 0) return;
      }
      onSignal({ kind, state });
    }
  };

  const consumeLine = () => {
    let event: Record<string, unknown> | undefined;
    if (!oversized && length > 0) {
      try { event = record(JSON.parse(utf8.decode(line.subarray(0, length)))); }
      catch { /* Malformed JSON or UTF-8 is not activity. */ }
    }
    line.fill(0, 0, length);
    length = 0;
    oversized = false;
    if (event) {
      if (tool === "claude") claudeRecord(event);
      else codexRecord(event);
    }
  };

  return {
    get failed() { return failed; },
    get completed() { return completed && !failed; },
    write(chunk) {
      if (ended) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const stop = newline === -1 ? chunk.length : newline;
        const bytes = stop - start;
        if (!oversized) {
          if (length + bytes <= MAX_LINE_BYTES) {
            chunk.copy(line, length, start, stop);
            length += bytes;
          } else oversized = true;
        }
        if (newline === -1) break;
        consumeLine();
        start = newline + 1;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      consumeLine();
      tools.clear();
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function claudeToolKind(name: string): PopulationActivityKind {
  switch (name) {
    case "Read": return "reading";
    case "Glob": case "Grep": case "WebSearch": return "searching";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return "writing";
    case "Bash": return "running_command";
    case "Task": case "Agent": return "delegating";
    default: return "working";
  }
}

function targetForPath(value: unknown): PopulationActivityTarget | undefined {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) return undefined;
  const path = value.replaceAll("\\", "/");
  if (path.split("/").includes("..")) return undefined;
  const context = /(?:^|\/)\.mex\/context\/(architecture|stack|conventions|decisions|setup)\.md$/u.exec(path);
  if (context) return context[1] as PopulationActivityTarget;
  if (/(?:^|\/)\.mex\/ROUTER\.md$/u.test(path)) return "router";
  if (/(?:^|\/)\.mex\/AGENTS\.md$/u.test(path)) return "agents";
  if (/(?:^|\/)\.mex\/patterns\/[^\0]+\.md$/u.test(path)) return "patterns";
  return undefined;
}

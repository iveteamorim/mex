import { afterEach, describe, expect, it, vi } from "vitest";
import { createPopulationTranscriptDecoder, type PopulationTranscriptSignal } from "../population-transcript.js";

afterEach(() => { vi.useRealTimers(); });

function fixture(tool: "claude" | "codex") {
  const entries: PopulationTranscriptSignal[] = [];
  const decoder = createPopulationTranscriptDecoder(tool, (entry) => entries.push(entry));
  const send = (...events: unknown[]) => decoder.write(Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n"));
  return { decoder, send, entries, assistant: () => entries.filter(entry => entry.kind === "assistant").map(entry => entry.text).join("") };
}
const stream = (event: unknown) => ({ type: "stream_event", event });
const assistantMessage = (text: string, id = "msg_1") => ({ type: "assistant", message: { id, content: [{ type: "text", text }] } });
const command = (type: string, output: string, id = "cmd_1") => ({ type, item: { id, type: "command_execution", command: "node --version", aggregated_output: output } });

describe("Claude visible transcript", () => {
  it("streams actual text before completion, deduplicates assistant/final envelopes, and excludes thinking", () => {
    vi.useFakeTimers();
    const f = fixture("claude");
    f.send(
      stream({ type: "message_start", message: { id: "msg_1" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "PRIVATE_REASONING" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the repository. 🍃" } }),
    );
    expect(f.entries).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(f.assistant()).toBe("Reading the repository. 🍃");
    f.send(assistantMessage("Reading the repository. 🍃"), stream({ type: "content_block_stop", index: 0 }),
      { type: "result", subtype: "success", is_error: false, result: "Reading the repository. 🍃" });
    f.decoder.end();
    expect(f.entries).toEqual([{ kind: "assistant", text: "Reading the repository. 🍃" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("appends only the missing suffix when a partial assistant message was followed by its full block", () => {
    const f = fixture("claude");
    f.send(stream({ type: "message_start", message: { id: "msg_1" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Read " } }),
      assistantMessage("Read all source files."),
      { type: "result", subtype: "success", result: "Read all source files." });
    f.decoder.end();
    expect(f.assistant()).toBe("Read all source files.");
  });

  it("supports complete messages and result-only output from non-partial CLI versions", () => {
    const f = fixture("claude");
    f.send(assistantMessage("Created architecture notes."), assistantMessage("Created architecture notes."));
    f.decoder.end();
    expect(f.assistant()).toBe("Created architecture notes.");
    const final = fixture("claude");
    final.send({ type: "result", subtype: "success", is_error: false, result: "Setup complete." });
    final.decoder.end();
    expect(final.assistant()).toBe("Setup complete.");
  });

  it("keeps identical visible phrases from distinct assistant messages", () => {
    const f = fixture("claude");
    f.send(assistantMessage("Done.\n", "msg_1"), assistantMessage("Done.\n", "msg_2"));
    f.decoder.end();
    expect(f.assistant()).toBe("Done.\n\nDone.\n");
  });

  it("separates distinct streamed assistant messages while concatenating their deltas verbatim", () => {
    const f = fixture("claude");
    for (const [id, text] of [["msg_1", "Reading files."], ["msg_2", "Finished reading."]]) {
      f.send(stream({ type: "message_start", message: { id } }),
        stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
        assistantMessage(text!, id));
    }
    f.decoder.end();
    expect(f.assistant()).toBe("Reading files.\n\nFinished reading.");
  });

  it("shows fixed tool markers without commands, paths, arguments, or results", () => {
    const f = fixture("claude");
    f.send({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "node --version" } },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: ".mex/context/architecture.md", content: "WHOLE_FILE_PAYLOAD" } },
      { type: "tool_use", id: "t3", name: "Read", input: { file_path: "package.json" } },
      { type: "tool_use", id: "t4", name: "Agent", input: { prompt: "PRIVATE_DELEGATION_PROMPT" } },
    ] } }, { type: "user", message: { content: [
      { type: "text", text: "PRIVATE_USER_PROMPT" },
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "v22.17.1" }, { type: "image", source: { data: "PRIVATE_IMAGE" } }] },
    ] } });
    f.decoder.end();
    expect(f.entries).toEqual([
      { kind: "command", text: "Ran a command" },
      { kind: "file", text: "Updated a file" },
      { kind: "tool", text: "Read a file" },
      { kind: "tool", text: "Used a tool" },
    ]);
  });

  it("deduplicates repeated tool invocation/result envelopes", () => {
    const f = fixture("claude");
    const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node --version" } }] } };
    const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "v22.17.1" }] } };
    f.send(use, use, result, result);
    f.decoder.end();
    expect(f.entries).toEqual([{ kind: "command", text: "Ran a command" }]);
  });

  it("emits a marker at partial tool start and deduplicates the completed tool block", () => {
    const f = fixture("claude");
    const block = { type: "tool_use", id: "t1", name: "Bash", input: {} };
    f.send(stream({ type: "content_block_start", content_block: block }));
    expect(f.entries).toEqual([{ kind: "command", text: "Ran a command" }]);
    f.send(stream({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "PRIVATE_COMMAND" } }),
      { type: "assistant", message: { content: [{ ...block, input: { command: "PRIVATE_COMMAND" } }] } });
    f.decoder.end();
    expect(f.entries).toHaveLength(1);
  });

  it("does not repeat streamed prose when the full assistant envelope arrives after a tool block", () => {
    const f = fixture("claude");
    const tool = { type: "tool_use", id: "t1", name: "Read", input: { file_path: "PRIVATE_PATH" } };
    f.send(stream({ type: "message_start", message: { id: "msg_1" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading the repository." } }),
      stream({ type: "content_block_stop", index: 0 }),
      stream({ type: "content_block_start", index: 1, content_block: tool }),
      { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "Reading the repository." }, tool] } });
    f.decoder.end();
    expect(f.entries).toEqual([
      { kind: "assistant", text: "Reading the repository." },
      { kind: "tool", text: "Read a file" },
    ]);
  });

  it("deduplicates multiple streamed text blocks in a later complete envelope", () => {
    const f = fixture("claude");
    const blocks = [
      { type: "text", text: "Reading files.\n" },
      { type: "text", text: "Updating notes." },
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "PRIVATE_PATH" } },
    ];
    f.send(stream({ type: "message_start", message: { id: "msg_1" } }));
    blocks.forEach((block, index) => {
      f.send(stream({ type: "content_block_start", index, content_block: block }), stream({ type: "content_block_stop", index }));
    });
    f.send({ type: "assistant", message: { id: "msg_1", content: blocks } });
    f.decoder.end();
    expect(f.entries).toEqual([
      { kind: "assistant", text: "Reading files.\nUpdating notes." },
      { kind: "file", text: "Updated a file" },
    ]);
  });

  it("preserves identical streamed prose in distinct messages when both full envelopes follow tools", () => {
    const f = fixture("claude");
    for (const messageId of ["msg_1", "msg_2"]) {
      const block = { type: "text", text: "Reading files." };
      const tool = { type: "tool_use", id: `${messageId}_tool`, name: "Read", input: {} };
      f.send(stream({ type: "message_start", message: { id: messageId } }),
        stream({ type: "content_block_start", index: 0, content_block: block }),
        stream({ type: "content_block_stop", index: 0 }),
        stream({ type: "content_block_start", index: 1, content_block: tool }),
        { type: "assistant", message: { id: messageId, content: [block, tool] } });
    }
    f.decoder.end();
    expect(f.entries).toEqual([
      { kind: "assistant", text: "Reading files." }, { kind: "tool", text: "Read a file" },
      { kind: "assistant", text: "Reading files." }, { kind: "tool", text: "Read a file" },
    ]);
  });

  it.each([
    ["Grep", "Searched the project"], ["Glob", "Searched the project"],
    ["WebSearch", "Searched the web"], ["private_mcp_tool", "Used a tool"],
  ])("projects %s to a fixed marker", (name, expected) => {
    const f = fixture("claude");
    f.send({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input: { query: "PRIVATE_QUERY" } }] } });
    f.decoder.end();
    expect(f.entries).toEqual([{ kind: "tool", text: expected }]);
  });
});

describe("Codex visible transcript", () => {
  it("shows assistant prose and one fixed command marker across cumulative updates", () => {
    const f = fixture("codex");
    f.send(
      { type: "item.started", item: { id: "a1", type: "agent_message", text: "Reading " } },
      { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Reading the repository." } },
      command("item.started", ""), command("item.updated", "v22."), command("item.completed", "v22.17.1\n"), command("item.completed", "v22.17.1\n"),
    );
    f.decoder.end();
    expect(f.entries).toEqual([
      { kind: "assistant", text: "Reading the repository." },
      { kind: "command", text: "Ran a command" },
    ]);
  });

  it("ignores both cumulative and replaced command output without adding notices", () => {
    const f = fixture("codex");
    f.send(command("item.updated", "initial result"), command("item.completed", "corrected result"));
    f.decoder.end();
    expect(f.entries).toEqual([{ kind: "command", text: "Ran a command" }]);
  });

  it("separates distinct assistant items without inserting separators for duplicate item updates", () => {
    const f = fixture("codex");
    for (const [id, text] of [["a1", "Reading."], ["a2", "Done."], ["a2", "Done."]]) {
      f.send({ type: "item.completed", item: { type: "agent_message", id, text } });
    }
    f.decoder.end();
    expect(f.assistant()).toBe("Reading.\n\nDone.");
  });

  it("shows fixed file and tool markers without reading names, paths, or results", () => {
    const f = fixture("codex");
    f.send(
      { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ kind: "add", path: ".mex/context/architecture.md" }, { kind: "delete", path: "old.md" }] } },
      { type: "item.completed", item: { id: "m1", type: "mcp_tool_call", tool: "lookup_docs", server: "PRIVATE_SERVER", arguments: { prompt: "PRIVATE_PROMPT" }, result: { content: [{ type: "text", text: "Found two documents." }] } } },
    );
    f.decoder.end();
    expect(f.entries).toEqual([
      { kind: "file", text: "Updated a file" },
      { kind: "tool", text: "Used a tool" },
    ]);
  });

  it("does not expose reasoning, agent delegation prompts, or user/system metadata", () => {
    const f = fixture("codex");
    f.send(
      { type: "thread.started", thread_id: "PRIVATE_THREAD" },
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "PRIVATE_REASONING" } },
      { type: "item.started", item: { type: "collab_tool_call", prompt: "PRIVATE_PROMPT", agents_states: { private: { message: "PRIVATE_AGENT_MESSAGE" } } } },
      { type: "error", message: "PRIVATE_ERROR" },
      { type: "system", message: "PRIVATE_SYSTEM" }, { type: "user", message: "PRIVATE_USER" },
    );
    f.decoder.end();
    expect(f.entries).toEqual([{ kind: "tool", text: "Used a tool" }]);
  });

  it("shows one fixed search label across updates without copying the query", () => {
    const f = fixture("codex");
    for (const type of ["item.started", "item.updated", "item.completed"]) {
      f.send({ type, item: { type: "web_search", id: "s1", query: "PRIVATE_QUERY" } });
    }
    f.decoder.end();
    expect(f.entries).toEqual([{ kind: "tool", text: "Searched the web" }]);
  });
});

describe("transcript bounds and presentation safety", () => {
  it("handles arbitrary byte and UTF-8 splits and a newline-free final record", () => {
    const f = fixture("claude");
    const bytes = Buffer.from(JSON.stringify(assistantMessage("Hello 🍃 world.")));
    for (const byte of bytes) f.decoder.write(Buffer.from([byte]));
    f.decoder.end();
    expect(f.assistant()).toBe("Hello 🍃 world.");
  });

  it("strips terminal controls and masks recognizable credentials while preserving code and literal HTML", () => {
    const f = fixture("codex");
    const content = '\u001b[31mconst value = "<script>alert(1)</script>";\u001b[0m\n' +
      'OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrstuvwxyz123456"\n' +
      'Authorization: Bearer abc123456789.secret\n' +
      '\u001b]8;;https://example.invalid\u0007label\u001b]8;;\u0007\u0000';
    f.send({ type: "item.completed", item: { id: "a1", type: "agent_message", text: content } });
    f.decoder.end();
    const output = f.assistant();
    expect(output).toContain('const value = "<script>alert(1)</script>";');
    expect(output).toContain("OPENAI_API_KEY=[redacted]");
    expect(output).toContain("Bearer [redacted]");
    expect(output).toContain("label");
    expect(output).not.toMatch(/abcdefghijklmnopqrstuvwxyz|abc123456789|example.invalid|\x1b|\x00/u);
  });

  it("splits visible output into 4096-character entries and caps extraction per record", () => {
    const f = fixture("codex");
    f.send({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "x".repeat(100_000) } });
    f.decoder.end();
    expect(f.entries.every(entry => entry.text.length <= 4096)).toBe(true);
    expect(f.entries.filter(entry => entry.kind !== "notice").reduce((sum, entry) => sum + entry.text.length, 0)).toBe(65536);
    expect(f.entries.at(-1)?.kind).toBe("notice");
  });

  it("preserves emoji crossing the assistant chunk boundary", () => {
    const f = fixture("codex");
    const value = "x".repeat(4095) + "🍃" + "y";
    f.send({ type: "item.completed", item: { type: "agent_message", id: "a1", text: value } });
    f.decoder.end();
    const chunks = f.entries.filter(entry => entry.kind === "assistant");
    expect(chunks.map(entry => entry.text).join("")).toBe(value);
    expect(chunks.every(entry => entry.text.length <= 4096)).toBe(true);
    expect(chunks.every(entry => !/[\uD800-\uDBFF]$/u.test(entry.text) && !/^[\uDC00-\uDFFF]/u.test(entry.text))).toBe(true);
  });

  it("sanitizes ANSI and recognizable keys split across partial events in the same batch", () => {
    const f = fixture("claude");
    for (const text of ["\u001b[", "31mToken: sk-proj-abc", "defghijklmnopqrstuvwxyz123456", "\u001b[0m"]) {
      f.send(stream({ type: "content_block_delta", delta: { type: "text_delta", text } }));
    }
    f.decoder.end();
    expect(f.assistant()).toBe("Token: [redacted]");
  });

  it("drops oversized records and recovers at the next JSONL record", () => {
    const f = fixture("claude");
    f.decoder.write(Buffer.from('{"type":"assistant","padding":"'));
    for (let i = 0; i < 100; i++) f.decoder.write(Buffer.alloc(4096, "x"));
    f.decoder.write(Buffer.from('"}\n'));
    f.send(assistantMessage("Back to visible output."));
    f.decoder.end();
    expect(f.entries.every(entry => entry.kind === "assistant")).toBe(true);
    expect(f.assistant()).toBe("Back to visible output.");
  });

  it("ignores malformed records and invalid UTF-8", () => {
    const f = fixture("claude");
    f.decoder.write(Buffer.from('bad json\n[]\nnull\n42\n'));
    f.decoder.write(Buffer.concat([Buffer.from('{"type":"result","result":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    f.decoder.end();
    expect(f.entries).toEqual([]);
  });

  it("disposes pending assistant batches on cancellation with no later callbacks", () => {
    vi.useFakeTimers();
    const f = fixture("claude");
    f.send(assistantMessage("Pending text"));
    expect(vi.getTimerCount()).toBe(1);
    f.decoder.dispose();
    f.decoder.end();
    f.send(assistantMessage("Later text"));
    vi.advanceTimersByTime(1000);
    expect(f.entries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes pending text exactly once at normal end", () => {
    vi.useFakeTimers();
    const f = fixture("claude");
    f.send(assistantMessage("Final text"));
    f.decoder.end(); f.decoder.end();
    vi.advanceTimersByTime(1000);
    expect(f.entries).toEqual([{ kind: "assistant", text: "Final text" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds tool-ID retention and still deduplicates the newest entries", () => {
    const f = fixture("codex");
    for (let i = 0; i < 100; i++) f.send(command("item.completed", `result${i}`, `c${i}`));
    f.entries.length = 0;
    f.send(command("item.completed", "result99", "c99"));
    expect(f.entries).toEqual([]);
    f.send(command("item.completed", "result0", "c0"));
    expect(f.entries).toEqual([{ kind: "command", text: "Ran a command" }]);
    f.decoder.dispose();
  });

  it.each(["claude", "codex"] as const)("discards even oversized %s tool output without extra transcript entries", tool => {
    const f = fixture(tool);
    const body = tool === "claude"
      ? { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "PRIVATE".repeat(50_000) }] } }
      : command("item.completed", "PRIVATE".repeat(50_000));
    f.send(body);
    f.decoder.end();
    expect(f.entries).toEqual([]);
  });
});

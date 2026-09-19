import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import type { SetupTranscriptBatch, SetupTranscriptEntry } from "../api/types";
import { SetupTranscript } from "./SetupTranscript";
import {
  appendTranscript, emptyTranscript, transcriptWindow,
  TRANSCRIPT_MEMORY_BYTES, TRANSCRIPT_MEMORY_ENTRIES, TRANSCRIPT_RENDER_CHARACTERS, TRANSCRIPT_RENDER_ROWS,
} from "./setup-transcript-buffer";

const runId = "a944e8d9-7e02-4d04-9a62-d8b347b8e7dc";
const otherId = "75eff665-7fbe-4b1b-9bf8-9ab33e6f3739";
const at = "2026-09-10T10:00:00.000Z";
const entry = (id: number, text = `actual output ${id}`, kind: SetupTranscriptEntry["kind"] = "assistant"): SetupTranscriptEntry => ({ id, at, kind, text, truncated: false });
const batch = (entries: SetupTranscriptEntry[], overrides: Partial<SetupTranscriptBatch> = {}): SetupTranscriptBatch => ({
  runId, entries, cursor: entries.at(-1)?.id ?? 0, firstId: 1, truncated: false, done: false, ...overrides,
});

function harness() {
  const subscriptions: { run: string; onBatch: (next: SetupTranscriptBatch) => void; onDisconnect?: () => void; close: ReturnType<typeof vi.fn> }[] = [];
  const api: Pick<HubApi, "subscribeToSetupTranscript"> = {
    subscribeToSetupTranscript: vi.fn((run, onBatch, onDisconnect) => {
      const subscription = { run, onBatch, onDisconnect, close: vi.fn() };
      subscriptions.push(subscription);
      return subscription;
    }),
  };
  return { api, subscriptions, emit: (value: SetupTranscriptBatch) => act(() => subscriptions.at(-1)!.onBatch(value)) };
}

describe("read-only setup transcript", () => {
  it("renders real escaped session text, groups assistant chunks, and keeps reconnect history", () => {
    const h = harness();
    const view = render(<SetupTranscript runId={runId} api={h.api} />);
    h.emit(batch([entry(1, "I am checking ", "assistant"), entry(2, "README.md now.\n", "assistant"), entry(3, "cat README.md", "command"), entry(4, "<img src=x onerror=alert(1)>")]));
    expect(screen.getByText("I am checking README.md now.")).toBeVisible();
    expect(screen.queryByText("Assistant")).toBeNull();
    expect(screen.getByText("Ran a command")).toBeVisible();
    expect(screen.queryByText("cat README.md")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("input, textarea, [contenteditable=true]")).toBeNull();
    act(() => h.subscriptions[0]!.onDisconnect?.());
    expect(screen.getByText("Reconnecting…")).toBeVisible();
    h.emit(batch([entry(4, "<img src=x onerror=alert(1)>"), entry(5, "Read a file", "tool"), entry(6, "README.md checked.", "assistant")]));
    expect(screen.getAllByText("<img src=x onerror=alert(1)>")).toHaveLength(1);
    expect(screen.getByText("README.md checked.")).toBeVisible();
    h.emit(batch([], { cursor: 6, done: true }));
    expect(screen.getByText("Session ended")).toBeVisible();
    expect(screen.getByText("README.md checked.")).toBeVisible();
  });

  it("preserves the scrolled-up window and rejoins new output only on Follow latest", () => {
    const h = harness();
    render(<SetupTranscript runId={runId} api={h.api} />);
    h.emit(batch([entry(1)]));
    const viewport = screen.getByRole("region", { name: "Agent session transcript" });
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1_000 }, clientHeight: { configurable: true, value: 300 } });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    h.emit(batch([entry(2)]));
    expect(viewport.scrollTop).toBe(100);
    expect(screen.queryByText("actual output 2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Follow latest/ }));
    expect(screen.getByText(/actual output 2/)).toBeVisible();
    expect(viewport.scrollTop).toBe(1_000);
  });

  it("caps the rendered window, exposes earlier output, and reports retention gaps", () => {
    const h = harness();
    const view = render(<SetupTranscript runId={runId} api={h.api} />);
    for (let start = 1; start <= 128; start += 32) h.emit(batch(Array.from({ length: 32 }, (_, index) => entry(start + index, `actual output ${start + index}`, (start + index) % 2 ? "assistant" : "command"))));
    expect(view.container.querySelectorAll("[data-kind]").length).toBeLessThanOrEqual(TRANSCRIPT_RENDER_ROWS);
    expect(screen.queryByText("actual output 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show earlier output" }));
    expect(screen.getByText("actual output 1")).toBeVisible();
    expect(screen.queryByText("actual output 127")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Follow latest/ }));
    expect(screen.getByText("actual output 127")).toBeVisible();
    h.emit(batch([entry(129)], { truncated: true, firstId: 2 }));
    expect(screen.getByText(/Earlier output is no longer retained/)).toBeVisible();
  });

  it("keeps tool calls as compact safe markers, groups repeats, and drops legacy details before retention", () => {
    const h = harness();
    const view = render(<SetupTranscript runId={runId} api={h.api} />);
    const incoming = batch([
      entry(1, "The architecture is clear. I am updating the project notes."),
      entry(2, "cat /private/project/secret.txt", "command"),
      entry(3, "curl --header 'Authorization: secret'", "command"),
      entry(4, "/private/project/config.ts was changed", "file"),
      entry(5, '{"tool":"Read","path":"/private/project/.env"}', "tool"),
      entry(6, "Read a file", "tool"),
      entry(7, "Sensitive tool result: token-value", "output"),
      entry(8, "Searched the web", "tool"),
      entry(9, "Unstructured legacy error /private/project", "notice"),
    ]);
    h.emit(incoming);
    expect(screen.getByText("The architecture is clear. I am updating the project notes.")).toBeVisible();
    expect(screen.getByText("Ran a command × 2")).toBeVisible();
    expect(screen.getByText("Updated a file")).toBeVisible();
    expect(screen.getByText("Used a tool")).toBeVisible();
    expect(screen.getByText("Read a file")).toBeVisible();
    expect(screen.getByText("Searched the web")).toBeVisible();
    expect(screen.getByText("Session update")).toBeVisible();
    expect(view.container.textContent).not.toMatch(/secret|Authorization|private\/project|token-value|Unstructured/);
    expect(view.container.querySelector("pre, details, [data-kind=output]")).toBeNull();
    const retained = appendTranscript(emptyTranscript(), incoming);
    expect(JSON.stringify(retained)).not.toMatch(/secret|Authorization|private\/project|token-value|Unstructured/);
    expect(retained.cursor).toBe(9);
  });

  it("closes old sessions and ignores stale callbacks and foreign-run batches", () => {
    const h = harness();
    const view = render(<SetupTranscript runId={runId} api={h.api} />);
    h.emit(batch([entry(1, "old session")]));
    view.rerender(<SetupTranscript runId={otherId} api={h.api} />);
    expect(h.subscriptions[0]!.close).toHaveBeenCalledOnce();
    expect(screen.queryByText("old session")).toBeNull();
    act(() => h.subscriptions[0]!.onBatch(batch([entry(2, "late old session")])));
    h.emit(batch([entry(3, "foreign session")]));
    expect(screen.queryByText(/late old session|foreign session/)).toBeNull();
    h.emit(batch([entry(1, "new session")], { runId: otherId }));
    expect(screen.getByText("new session")).toBeVisible();
    view.unmount();
    expect(h.subscriptions[1]!.close).toHaveBeenCalledOnce();
  });

  it("bounds retained UTF-8 bytes and entry count separately, and bounds rendered text even after token grouping", () => {
    let buffer = emptyTranscript();
    for (let start = 1; start < 400; start += 32) {
      buffer = appendTranscript(buffer, batch(Array.from({ length: 32 }, (_, index) => entry(start + index, "界".repeat(4_096), "assistant"))));
    }
    expect(buffer.bytes).toBeLessThanOrEqual(TRANSCRIPT_MEMORY_BYTES);
    expect(buffer.truncated).toBe(true);
    const visible = transcriptWindow(buffer.entries, null);
    expect(visible.rows.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(TRANSCRIPT_RENDER_CHARACTERS);
    expect(visible.rows).toHaveLength(1);

    buffer = emptyTranscript();
    for (let start = 1; start < 2_400; start += 32) buffer = appendTranscript(buffer, batch(Array.from({ length: 32 }, (_, index) => entry(start + index, "x"))));
    expect(buffer.entries).toHaveLength(TRANSCRIPT_MEMORY_ENTRIES);
    expect(buffer.truncated).toBe(true);
    expect(transcriptWindow(buffer.entries, 1).rows.length).toBeLessThanOrEqual(TRANSCRIPT_RENDER_ROWS);
  });
});

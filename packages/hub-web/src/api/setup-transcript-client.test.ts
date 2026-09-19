import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHubApi } from "./client";
import type { SetupTranscriptBatch } from "./types";

const runId = "a944e8d9-7e02-4d04-9a62-d8b347b8e7dc";
const otherId = "75eff665-7fbe-4b1b-9bf8-9ab33e6f3739";
const at = "2026-09-10T10:00:00.000Z";
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly close = vi.fn();
  readonly listeners = new Map<string, EventListener>();
  onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly options: EventSourceInit) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
  emit(value: unknown) { this.listeners.get("transcript")?.(new MessageEvent("transcript", { data: typeof value === "string" ? value : JSON.stringify(value) })); }
}

function batch(cursor: number, overrides: Partial<SetupTranscriptBatch> = {}): SetupTranscriptBatch {
  return { runId, cursor, firstId: 1, truncated: false, done: false, entries: [{ id: cursor, at, kind: "assistant", text: "Reading the actual project", truncated: false }], ...overrides };
}

async function connect() {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  const received = vi.fn();
  const disconnected = vi.fn();
  const subscription = new HttpHubApi().subscribeToSetupTranscript(runId, received, disconnected);
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return { source: FakeEventSource.instances[0]!, received, disconnected, subscription };
}

afterEach(() => vi.unstubAllGlobals());

describe("setup transcript transport", () => {
  it("isolates the run, rejects malformed and oversized events, and deduplicates native reconnect replay", async () => {
    const { source, received, disconnected } = await connect();
    expect(source.url).toBe(`/api/v1/setup/transcript/events?run=${runId}`);
    expect(source.options).toEqual({ withCredentials: true });
    source.emit("not json");
    source.emit(" ".repeat(1_048_577));
    source.emit(batch(1, { runId: otherId }));
    source.emit(batch(1, { entries: [{ id: 1, at, kind: "assistant", text: "x".repeat(4_097), truncated: false }] }));
    expect(received).not.toHaveBeenCalled();
    source.emit(batch(1));
    source.onerror?.();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(source.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    source.emit(batch(2, { entries: [...batch(1).entries, ...batch(2).entries] }));
    expect(received.mock.calls[1]![0].entries.map((entry: { id: number }) => entry.id)).toEqual([2]);
    source.emit(batch(1));
    expect(received).toHaveBeenCalledTimes(2);
    source.emit(batch(2, { entries: [], done: true }));
    expect(source.close).toHaveBeenCalledOnce();
    source.emit(batch(3));
    source.onerror?.();
    expect(received).toHaveBeenCalledTimes(3);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("drops out-of-order IDs and closes without delivering late events", async () => {
    const { source, received, subscription } = await connect();
    source.emit(batch(2, { entries: [...batch(2).entries, ...batch(1).entries] }));
    source.emit(batch(1, { entries: batch(2).entries }));
    expect(received).not.toHaveBeenCalled();
    subscription.close();
    source.emit(batch(2));
    expect(received).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("does not create a source for invalid IDs or a subscription closed during lazy loading", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = new HttpHubApi();
    expect(() => api.subscribeToSetupTranscript("../../private", vi.fn())).toThrow("Invalid setup session identifier");
    api.subscribeToSetupTranscript(runId, vi.fn()).close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

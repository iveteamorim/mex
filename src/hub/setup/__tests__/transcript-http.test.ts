import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupTranscriptBatchSchema } from "@mex/hub-contracts/setup";
import { createHubApp, type HubSetupService } from "../../app.js";
import { HubHttpError } from "../../http/errors.js";
import { HubSessionManager } from "../../security/session.js";
import { createSetupHubServices } from "../services.js";
import { SetupTranscriptStore } from "../transcript.js";

const ORIGIN = "http://127.0.0.1:48123";
const HOST = "127.0.0.1:48123";
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const RUN = "00000000-0000-4000-8000-000000000192";
const TRANSCRIPT_PATH = `/api/v1/setup/transcript/events?run=${RUN}`;
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("authenticated setup transcript stream", () => {
  it("gates content behind session, Host, method, run and cursor validation", async () => {
    const fixture = createFixture();
    const cookie = await authenticate(fixture.app);
    for (const [path, headers, method, expected] of [
      [TRANSCRIPT_PATH, { host: HOST }, "GET", 401],
      [TRANSCRIPT_PATH, { host: "example.com", cookie }, "GET", 400],
      [TRANSCRIPT_PATH, { host: HOST, cookie }, "HEAD", 405],
      ["/api/v1/setup/transcript/events?run=bad", { host: HOST, cookie }, "GET", 400],
      [`${TRANSCRIPT_PATH}&run=${RUN}`, { host: HOST, cookie }, "GET", 400],
      [`${TRANSCRIPT_PATH}&after=2`, { host: HOST, cookie }, "GET", 400],
      [TRANSCRIPT_PATH, { host: HOST, cookie, "Last-Event-ID": "-1" }, "GET", 400],
      [TRANSCRIPT_PATH, { host: HOST, cookie, "Last-Event-ID": "9007199254740992" }, "GET", 400],
      [TRANSCRIPT_PATH.replace(RUN, "00000000-0000-4000-8000-000000000193"), { host: HOST, cookie }, "GET", 409],
    ] as const) {
      const response = await fixture.app.request(`${ORIGIN}${path}`, { headers, method });
      expect(response.status, `${method} ${path}`).toBe(expected);
    }
    expect(fixture.listeners.size).toBe(0);
    expect(fixture.subscribe).not.toHaveBeenCalled();
  });

  it("replays bounded pages, resumes from Last-Event-ID, and closes after the final page", async () => {
    const fixture = createFixture();
    const cookie = await authenticate(fixture.app);
    for (let i = 1; i <= 70; i++) fixture.store.append({ kind: "assistant", text: `Actual output ${i}\n` });
    fixture.complete();
    const response = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    const batches = parseBatches(body);
    expect(batches.map((batch) => batch.entries.length)).toEqual([32, 32, 6]);
    expect(batches.map((batch) => batch.done)).toEqual([false, false, true]);
    expect(batches.flatMap((batch) => batch.entries).map((entry) => entry.id)).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
    expect(fixture.listeners.size).toBe(0);

    const resumed = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, {
      headers: { host: HOST, cookie, "Last-Event-ID": "35" },
    });
    const replay = parseBatches(await resumed.text());
    expect(replay.flatMap((batch) => batch.entries).map((entry) => entry.id)).toEqual(Array.from({ length: 35 }, (_, i) => i + 36));
    expect(replay.at(-1)?.done).toBe(true);
    expect(fixture.listeners.size).toBe(0);
  });

  it("reports evicted output instead of pretending a reconnect has complete history", async () => {
    const fixture = createFixture();
    const cookie = await authenticate(fixture.app);
    for (let i = 0; i < 2100; i++) fixture.store.append({ kind: "output", text: `${i}` });
    fixture.complete();
    const response = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } });
    const batches = parseBatches(await response.text());
    expect(batches[0]).toMatchObject({ firstId: 53, truncated: true });
    expect(batches.slice(1).every((batch) => !batch.truncated)).toBe(true);
    expect(batches.flatMap((batch) => batch.entries)).toHaveLength(2048);
  });

  it("delivers newly emitted text and flushes completion without storing text in run snapshots", async () => {
    const fixture = createFixture();
    const cookie = await authenticate(fixture.app);
    const response = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"entries":[]');
    fixture.store.append({ kind: "command", text: "Ran a command" });
    fixture.wake();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("Ran a command");
    const snapshot = await fixture.app.request(`${ORIGIN}/api/v1/setup/run`, { headers: { host: HOST, cookie } });
    expect(await snapshot.text()).not.toContain("Ran a command");
    fixture.complete();
    let remaining = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      remaining += new TextDecoder().decode(part.value);
    }
    expect(remaining).toContain('"done":true');
    expect(fixture.listeners.size).toBe(0);
  });

  it("closes at absolute session expiry and releases its subscription", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-09-10T12:00:00.000Z");
    const fixture = createFixture({ now: () => now, sessionTtlMs: 1_000 });
    const cookie = await authenticate(fixture.app);
    const response = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } });
    const body = response.text();
    expect(fixture.listeners.size).toBe(1);
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await body).toContain("event: transcript");
    expect(fixture.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds concurrent subscribers and releases slots on cancellation", async () => {
    const fixture = createFixture();
    const cookie = await authenticate(fixture.app);
    const responses: Response[] = [];
    try {
      for (let i = 0; i < 8; i++) {
        responses.push(await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } }));
      }
      const denied = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } });
      expect(denied.status).toBe(429);
    } finally {
      for (const response of responses) await response.body?.cancel();
    }
    await vi.waitFor(() => expect(fixture.listeners.size).toBe(0));
    fixture.complete();
    const resumed = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } });
    expect(resumed.status).toBe(200);
    await resumed.text();
  });

  it("expires a subscriber that stops consuming a replay", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-09-10T12:00:00.000Z");
    const fixture = createFixture({ now: () => now, sessionTtlMs: 1_000 });
    const cookie = await authenticate(fixture.app);
    for (let i = 0; i < 200; i++) fixture.store.append({ kind: "output", text: "x".repeat(4096) });
    const response = await fixture.app.request(`${ORIGIN}${TRANSCRIPT_PATH}`, { headers: { host: HOST, cookie } });
    expect(fixture.listeners.size).toBe(1);
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await response.body?.cancel();
  });
});

function parseBatches(text: string) {
  return text.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => SetupTranscriptBatchSchema.parse(JSON.parse(line.slice(6))));
}

function createFixture(options: { now?: () => number; sessionTtlMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mex-transcript-http-"));
  roots.push(root);
  const base = createSetupHubServices(root);
  const store = new SetupTranscriptStore(RUN);
  let terminal = false;
  const listeners = new Set<() => void>();
  const wake = () => { for (const listener of listeners) listener(); };
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  });
  const setup: HubSetupService = {
    status: () => base.setup.status(),
    snapshot: () => ({ ...base.setup.snapshot(), transcriptId: RUN, status: terminal ? "cancelled" : "running" }),
    start: (request) => base.setup.start(request),
    cancel: () => base.setup.cancel(),
    subscribe: (listener) => base.setup.subscribe(listener),
    readTranscript: (runId, after) => {
      if (runId !== RUN) throw new HubHttpError(409, "REVISION_CONFLICT", "Session changed", "Reconnect.");
      return store.read(after, terminal);
    },
    subscribeTranscript: subscribe,
  };
  let random = 20;
  const app = createHubApp({
    security: new HubSessionManager({ bootstrapToken: TOKEN, expectedOrigin: ORIGIN,
      random: (size) => new Uint8Array(size).fill(random++), ...options }),
    services: base.services, setup, ...(options.now ? { now: options.now } : {}),
  });
  return { app, store, listeners, subscribe, wake, complete: () => { terminal = true; wake(); } };
}

async function authenticate(app: ReturnType<typeof createHubApp>) {
  const response = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
    method: "POST", headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing fixture session");
  return cookie;
}

import { HubJobSnapshotSchema } from "@mex/hub-contracts";
import { performance } from "node:perf_hooks";

const MAX_EVENT_BYTES = 32 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 1_024;
const TERMINAL_STATES = new Set(["succeeded", "failed", "interrupted"]);

export function validateBenchmarkJob(value, { id, kind }) {
  const parsed = HubJobSnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== kind || (id !== undefined && parsed.data.id !== id)) {
    throw new Error("Benchmark received an invalid or unexpected job snapshot.");
  }
  return parsed.data;
}

/** One bounded subscription, matching the Hub's snapshot/progress/terminal stream. */
export async function waitForHubJobTerminal(server, auth, { id, kind, deadline }) {
  const remaining = deadline - performance.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 180_000) {
    throw new Error("Benchmark job stream exceeded its maintenance deadline.");
  }
  const controller = new AbortController();
  let reader;
  let deadlineTimer;
  let headersTimer;
  const expired = new Promise((_, reject) => {
    const expire = (message) => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    };
    deadlineTimer = setTimeout(() => expire("Benchmark job stream exceeded its maintenance deadline."), remaining);
    headersTimer = setTimeout(() => expire("Benchmark job stream headers exceeded 5000 ms."), Math.min(5_000, remaining));
  });
  try {
    return await Promise.race([expired, (async () => {
      const response = await fetch(`${server.origin}/api/v1/jobs/${encodeURIComponent(id)}/events`, {
        headers: { accept: "text/event-stream", cookie: auth.cookie },
        redirect: "error",
        signal: controller.signal,
      });
      clearTimeout(headersTimer);
      if (!response.ok) throw new Error(`Benchmark job stream failed with HTTP ${response.status}.`);
      if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream" || !response.body) {
        throw new Error("Benchmark job stream did not return an event stream.");
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let totalBytes = 0;
      let events = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) throw new Error("Benchmark job stream ended before a terminal snapshot.");
        totalBytes += next.value.byteLength;
        if (totalBytes > MAX_STREAM_BYTES) throw new Error("Benchmark job stream exceeded its total byte bound.");
        buffer += decoder.decode(next.value, { stream: true });
        for (let separator; (separator = /\r?\n\r?\n/u.exec(buffer)) !== null;) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          if (Buffer.byteLength(frame) > MAX_EVENT_BYTES) throw new Error("Benchmark job stream exceeded its event byte bound.");
          if (++events > MAX_EVENTS) throw new Error("Benchmark job stream exceeded its event count bound.");
          const job = parseFrame(frame, { id, kind });
          if (job && TERMINAL_STATES.has(job.state)) return job;
        }
        if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw new Error("Benchmark job stream exceeded its event byte bound.");
      }
    })()]);
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(headersTimer);
    controller.abort();
    // Cancellation is deliberately not awaited after the absolute deadline.
    // Aborting fetch releases the Hub subscription even with an outstanding read.
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

function parseFrame(frame, expected) {
  let type;
  let revision;
  const data = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) throw new Error("Benchmark received a malformed job event.");
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /u, "");
    if (field === "data") data.push(value);
    else if (field === "event" && type === undefined) type = value;
    else if (field === "id" && revision === undefined) revision = value;
    else throw new Error("Benchmark received an unsupported job event field.");
  }
  if (type === undefined && revision === undefined && data.length === 0) return null; // Heartbeat.
  if (!["snapshot", "progress", "terminal"].includes(type) || data.length === 0) {
    throw new Error("Benchmark received an invalid job event type or body.");
  }
  let value;
  try { value = JSON.parse(data.join("\n")); }
  catch { throw new Error("Benchmark received malformed job event JSON."); }
  const job = validateBenchmarkJob(value, expected);
  if (revision !== job.revision || (type === "terminal" && !TERMINAL_STATES.has(job.state))) {
    throw new Error("Benchmark received an inconsistent job event.");
  }
  return job;
}

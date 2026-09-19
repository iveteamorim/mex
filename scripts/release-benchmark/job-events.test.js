import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { waitForHubJobTerminal } from "./job-events.mjs";

const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KIND = "graph_rebuild";
const revision = "a".repeat(64);
function snapshot(state = "running", extra = {}) {
  return {
    id: JOB_ID, scaffoldId: "benchmark", kind: KIND, generation: 1,
    phase: state === "succeeded" ? "complete" : state === "interrupted" ? "interrupted" : "parse",
    progress: null, state, cancelRequested: state === "interrupted",
    createdAt: "2026-08-23T00:00:00.000Z", revision, ...extra,
  };
}
function event(job, type = "snapshot", newline = "\n") {
  return [`event: ${type}`, `id: ${job.revision}`, `data: ${JSON.stringify(job)}`, "", ""].join(newline);
}
async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run({ origin: `http://127.0.0.1:${server.address().port}` }); }
  finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
}
const wait = (server, timeoutMs = 2_000) => waitForHubJobTerminal(server, { cookie: "test=session" }, {
  id: JOB_ID, kind: KIND, deadline: performance.now() + timeoutMs,
});

describe("bounded maintenance event observation", () => {
  it("handles split UTF-8 and CRLF frames, coalesced events and heartbeats", async () => {
    const running = snapshot("running", { summary: "caf\u00e9" });
    const bytes = Buffer.from(event(running, "snapshot", "\r\n"));
    const split = bytes.indexOf(Buffer.from("\u00e9")) + 1;
    const parts = [bytes.subarray(0, split), bytes.subarray(split, bytes.length - 1), bytes.subarray(bytes.length - 1)];
    await withServer((request, response) => {
      expect(request.url).toBe(`/api/v1/jobs/${JOB_ID}/events`);
      expect(request.headers.cookie).toBe("test=session");
      response.writeHead(200, { "content-type": "text/event-stream; charset=UTF-8" });
      response.write(parts[0]);
      setTimeout(() => response.write(parts[1]), 5);
      setTimeout(() => {
        response.write(parts[2]);
        response.end(`: heartbeat\n\n${event(snapshot(), "progress")}${event(snapshot("succeeded"), "terminal")}`);
      }, 10);
    }, async (server) => {
      expect((await wait(server)).state).toBe("succeeded");
    });
  });

  it.each(["snapshot", "terminal"])("accepts an already-terminal initial %s and closes the subscription", async (type) => {
    let requests = 0;
    let closed;
    await withServer((_, response) => {
      requests += 1;
      closed = once(response, "close");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(event(snapshot("succeeded"), type));
      // Deliberately keep the server open: the terminal waiter must release it.
    }, async (server) => {
      expect((await wait(server)).state).toBe("succeeded");
      await closed;
      expect(requests).toBe(1);
    });
  });

  it("returns interrupted terminal state so callers cannot count cancellation as success", async () => {
    await withServer((_, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(event(snapshot("interrupted", { interruptedReason: "user_cancelled" }), "terminal"));
    }, async (server) => {
      expect(await wait(server)).toMatchObject({ state: "interrupted", interruptedReason: "user_cancelled" });
    });
  });

  it("keeps the absolute deadline through a stalled body and cancels the reader", async () => {
    let closed;
    await withServer((_, response) => {
      closed = once(response, "close");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(event(snapshot()));
    }, async (server) => {
      await expect(wait(server, 75)).rejects.toThrow(/deadline/u);
      await closed;
    });
  });

  it("does not reconnect after an HTTP failure or a premature stream close", async () => {
    let requests = 0;
    await withServer((_, response) => { requests += 1; response.writeHead(503); response.end("Unavailable"); }, async (server) => {
      await expect(wait(server)).rejects.toThrow(/HTTP 503/u);
      expect(requests).toBe(1);
    });
    await withServer((_, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(event(snapshot()));
    }, async (server) => {
      await expect(wait(server)).rejects.toThrow(/ended before/u);
    });
  });

  it.each([
    ["malformed JSON", `event: snapshot\nid: ${revision}\ndata: {broken}\n\n`, /malformed.*JSON/u],
    ["wrong job", event(snapshot("succeeded", { id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAW" }), "terminal"), /unexpected job/u],
    ["wrong kind", event(snapshot("succeeded", { kind: "wiki_rebuild" }), "terminal"), /unexpected job/u],
    ["wrong state", event(snapshot("invented"), "terminal"), /invalid.*job snapshot/u],
    ["inconsistent terminal", event(snapshot(), "terminal"), /inconsistent/u],
    ["wrong revision", event(snapshot()).replace(`id: ${revision}`, `id: ${"b".repeat(64)}`), /inconsistent/u],
  ])("rejects %s rather than waiting for a later valid frame", async (_, frame, error) => {
    await withServer((_, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frame + event(snapshot("succeeded"), "terminal"));
    }, async (server) => {
      await expect(wait(server)).rejects.toThrow(error);
    });
  });

  it.each([
    ["event bytes", "data: " + "x".repeat(32 * 1024 + 1), /event byte bound/u],
    ["event count", ": heartbeat\n\n".repeat(1_025), /event count bound/u],
    ["total bytes", (":" + "x".repeat(16_000) + "\n\n").repeat(132), /total byte bound/u],
  ])("bounds %s while consuming the stream", async (_, body, error) => {
    await withServer((_, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
    }, async (server) => {
      await expect(wait(server)).rejects.toThrow(error);
    });
  });
});

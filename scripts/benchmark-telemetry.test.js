import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertProjectContextEvent, createProjectContextFixture, inspectQueue, runBoundedProcess, startLocalIngestion, summarizeSamples, telemetryPreloadSource } from "./benchmark-telemetry.mjs";

function projectEvent(expected) {
  return {
    event: "cli.command_completed", uuid: "9fef46b1-cb38-4fda-a166-a6f2395d4c14",
    distinct_id: "311a9850-3dc7-41e1-bc5e-8b10e0df8d19", timestamp: "2026-09-09T00:00:00.000Z",
    properties: { command: "commands", outcome: "success", scaffold_id: expected.scaffoldId, configured_ai_tools: expected.tools },
  };
}

const requestFixture = `
import { request } from 'node:https';
const req = request('https://us.i.posthog.com/batch/', {method:'POST',agent:false,headers:{'content-type':'application/json'}}, (response) => response.resume());
req.on('error', () => {});
req.setTimeout(500, () => req.destroy(new Error('Fixture request timeout')));
req.end(JSON.stringify({batch:[{event:'command_finished',properties:{command:'commands',outcome:'success'}}]}));
`;
const fetchFixture = `
try {
  await fetch('https://us.i.posthog.com/batch/', {method:'POST',signal:AbortSignal.timeout(500),headers:{'content-type':'application/json'},body:JSON.stringify({batch:[{event:'command_run',properties:{command:'commands'}}]})});
} catch {}
`;

describe("isolated telemetry benchmark", () => {
  it("creates existing project identity and rejects missing, altered, or private event metadata", () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-project-test-"));
    try {
      const expected = { ...createProjectContextFixture(workspace), required: true };
      const config = JSON.parse(readFileSync(join(workspace, ".mex", "config.json"), "utf8"));
      assert.equal(config.scaffold_id, expected.scaffoldId);
      assert.deepEqual(config.aiTools, ["claude", "codex"]);
      assert.equal(config.private_metadata.content, expected.sentinel);
      assert.doesNotThrow(() => assertProjectContextEvent(projectEvent(expected), expected));
      for (const change of [
        { scaffold_id: "311a9850-3dc7-41e1-bc5e-8b10e0df8d19" },
        { scaffold_id: undefined },
        { configured_ai_tools: ["codex", "claude"] },
        { configured_ai_tools: undefined },
        { scaffold_name: "Unexpected project name" },
        { command: expected.sentinel },
      ]) {
        const event = projectEvent(expected);
        Object.assign(event.properties, change);
        assert.throws(() => assertProjectContextEvent(event, expected), /metadata|property|sentinel/u);
      }
      const extra = projectEvent(expected);
      extra.private = "unexpected envelope field";
      assert.throws(() => assertProjectContextEvent(extra, expected), /envelope/u);
      const baseline = projectEvent(expected);
      assert.throws(() => assertProjectContextEvent(baseline, { ...expected, required: false }), /baseline/u);
      delete baseline.properties.scaffold_id;
      delete baseline.properties.configured_ai_tools;
      assert.doesNotThrow(() => assertProjectContextEvent(baseline, { ...expected, required: false }));
      assert.doesNotThrow(() => assertProjectContextEvent({ arbitrary: "legacy fixture" }));
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it("validates raw queued metadata before retaining anonymous evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-project-test-"));
    try {
      const expected = { ...createProjectContextFixture(workspace), required: true };
      const directory = join(workspace, ".mex", "telemetry");
      mkdirSync(directory);
      const { DatabaseSync } = await import("node:sqlite");
      const path = join(directory, "outbox.db");
      const database = new DatabaseSync(path);
      const event = projectEvent(expected);
      try {
        database.exec("CREATE TABLE events(uuid TEXT,payload TEXT,lease_until INTEGER)");
        database.prepare("INSERT INTO events VALUES(?,?,0)").run(event.uuid, JSON.stringify(event));
      } finally { database.close(); }
      const state = await inspectQueue(workspace, undefined, expected);
      assert.equal(state.projectContextEventsVerified, 1);
      assert.equal(JSON.stringify(state).includes(expected.scaffoldId), false);
      const writer = new DatabaseSync(path);
      try {
        event.properties.scaffold_name = expected.sentinel;
        writer.prepare("UPDATE events SET payload=?").run(JSON.stringify(event));
      } finally { writer.close(); }
      await assert.rejects(inspectQueue(workspace, undefined, expected), /sentinel/u);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it("validates the full received payload before projecting permitted dimensions", async () => {
    const ingestion = await startLocalIngestion();
    const expected = { scaffoldId: "d4fddfda-a319-43a0-999f-d0f14d33976b", tools: ["claude", "codex"], sentinel: "PRIVATE_SENTINEL", required: true };
    try {
      for (const privateValue of [false, true]) {
        const record = ingestion.begin("healthy", expected);
        const event = projectEvent(expected);
        if (privateValue) event.properties.scaffold_name = expected.sentinel;
        await new Promise((resolve, reject) => {
          const post = request(ingestion.endpoint, { method: "POST", agent: false }, (response) => { response.resume(); response.on("end", resolve); });
          post.on("error", reject);
          post.setTimeout(1_000, () => post.destroy(new Error("Fixture request timeout")));
          post.end(JSON.stringify({ batch: [event] }));
        });
        assert.equal(record.invalidBodies, privateValue ? 1 : 0);
        assert.equal(record.projectContextEventsVerified, privateValue ? 0 : 1);
        assert.equal(record.events.length, privateValue ? 0 : 1);
        assert.equal(JSON.stringify(record.events).includes(expected.scaffoldId), false);
        assert.equal(await ingestion.finish(), 0);
      }
    } finally { await ingestion.close(); }
  });

  it("counts a received but unacknowledged queued UUID only once", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    try {
      const directory = join(workspace, ".mex", "telemetry");
      mkdirSync(directory, { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(join(directory, "outbox.db"));
      const uuid = "9fef46b1-cb38-4fda-a166-a6f2395d4c14";
      try {
        database.exec("CREATE TABLE events(uuid TEXT,payload TEXT,lease_until INTEGER)");
        database.prepare("INSERT INTO events VALUES(?,?,0)").run(uuid, JSON.stringify({ uuid, event: "cli.command_completed", properties: { outcome: "success" } }));
      } finally { database.close(); }
      const state = await inspectQueue(workspace, new Map([[uuid, "cli.command_completed:success"]]));
      assert.equal(state.events, 1);
      assert.deepEqual(state.eventCounts, { "cli.command_completed:success": 1 });
      assert.deepEqual(state.receivedOrQueuedEventCounts, { "cli.command_completed:success": 1 });
      assert.equal(JSON.stringify(state).includes(uuid), false);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it("redirects real HTTPS requests to loopback and leaves no socket after healthy, refused or hanging runs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    const ingestion = await startLocalIngestion();
    try {
      const fixture = join(workspace, "fixture.mjs");
      const preload = join(workspace, "preload.mjs");
      const refused = await startLocalIngestion();
      const refusedEndpoint = refused.endpoint;
      await refused.close();
      for (const source of [requestFixture, fetchFixture]) for (const mode of ["healthy", "refused", "hanging"]) {
        writeFileSync(fixture, source);
        writeFileSync(preload, telemetryPreloadSource(mode === "refused" ? refusedEndpoint : ingestion.endpoint));
        const received = ingestion.begin(mode);
        const result = await runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" } });
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        assert.equal(result.diagnostics.redirected, 1);
        assert.equal(result.diagnostics.blocked, 0);
        assert.equal(result.diagnostics.requestErrors, mode === "healthy" ? 0 : 1);
        assert.equal(received.requests, mode === "refused" ? 0 : 1);
        assert.equal(received.invalidBodies, 0);
        assert.equal(await ingestion.finish(), 0);
      }
    } finally { await ingestion.close(); rmSync(workspace, { recursive: true, force: true }); }
  });

  it("fails closed for another destination and rejects non-loopback harness endpoints", async () => {
    assert.throws(() => telemetryPreloadSource("https://us.i.posthog.com/batch/"), /loopback/u);
    assert.throws(() => telemetryPreloadSource("http://127.0.0.1:1234/other/"), /loopback/u);
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    try {
      const preload = join(workspace, "preload.mjs");
      const fixture = join(workspace, "fixture.mjs");
      writeFileSync(preload, telemetryPreloadSource("http://127.0.0.1:1/batch/"));
      for (const source of [
        "import {request} from 'node:https'; request('https://example.invalid/');",
        "import net from 'node:net'; net.connect({host:'203.0.113.1',port:443});",
        "import {Resolver} from 'node:dns'; new Resolver().resolve4('example.invalid',()=>{});",
        "import dgram from 'node:dgram'; dgram.createSocket('udp4').send('blocked',1234,'203.0.113.1');",
      ]) {
        writeFileSync(fixture, source);
        await assert.rejects(runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" } }), /unexpected outbound/u);
      }
      writeFileSync(fixture, "const response=await fetch('data:application/octet-stream;base64,AGFzbQ==');if((await response.arrayBuffer()).byteLength!==4)process.exitCode=1;");
      const embedded = await runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" } });
      assert.equal(embedded.code, 0);
      assert.equal(embedded.diagnostics.blocked, 0);
      assert.equal(embedded.diagnostics.redirected, 0);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it("bounds child lifetime without turning a killed process into a measurement", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    try {
      const preload = join(workspace, "preload.mjs");
      const fixture = join(workspace, "fixture.mjs");
      writeFileSync(preload, telemetryPreloadSource("http://127.0.0.1:1/batch/"));
      writeFileSync(fixture, "setInterval(() => {},1000);");
      await assert.rejects(runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" }, timeoutMs: 150 }), /bounded lifetime/u);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
    assert.deepEqual(summarizeSamples([-1, 0, 4, 2]), { samples: [-1, 0, 4, 2], p50: 0, p95: 4, min: -1, max: 4 });
  });
});

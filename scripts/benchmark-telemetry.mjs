#!/usr/bin/env node

// Local characterization, never a portable release budget. The built CLI runs
// its normal main entry; only its fixed telemetry destination is redirected.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const CONDITIONS = ["disabled", "healthy", "refused", "hanging"];
const COMMANDS = [
  { name: "success", args: ["commands"], exitCode: 0 },
  { name: "failure", args: ["check", "--json"], exitCode: 1 },
];
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const CHILD_TIMEOUT_MS = 5_000;

export function createProjectContextFixture(root) {
  const scaffoldId = randomUUID();
  const sentinel = `MEX_PRIVATE_BENCHMARK_${randomUUID()}`;
  const tools = ["claude", "codex"];
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".mex"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".mex", "ROUTER.md"), `# Fixture\nThe runtime entry is \`src/runtime-entry.ts\`.\nPrivate note: ${sentinel}\n`);
  writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
    scaffold_id: scaffoldId, aiTools: tools,
    scaffold_name: sentinel, origin: `https://example.invalid/${sentinel}`, upstream: sentinel,
    private_metadata: { email: `${sentinel}@example.invalid`, path: `/private/${sentinel}`, content: sentinel },
  }) + "\n");
  return { scaffoldId, sentinel, tools };
}

/** Check complete transport/queue bytes before projecting anonymous test evidence. */
export function assertProjectContextEvent(event, expected) {
  if (!expected) return;
  if (JSON.stringify(event).includes(expected.sentinel)) throw new Error("Project privacy sentinel escaped into telemetry.");
  if (Object.keys(event).sort().join() !== "distinct_id,event,properties,timestamp,uuid") throw new Error("Unexpected project telemetry envelope.");
  const properties = event.properties;
  const allowed = new Set(["schema_version", "source", "installation_id", "mex_version", "os", "node_version", "$process_person_profile", "$geoip_disable", "command", "stage", "outcome", "duration_ms", "scaffold_id", "configured_ai_tools"]);
  if (!properties || Object.keys(properties).some((key) => !allowed.has(key))) throw new Error("Unexpected project telemetry property.");
  if (expected.required) {
    if (properties.scaffold_id !== expected.scaffoldId || JSON.stringify(properties.configured_ai_tools) !== JSON.stringify(expected.tools)) throw new Error("Existing project metadata was not preserved exactly.");
  } else if (Object.hasOwn(properties, "scaffold_id") || Object.hasOwn(properties, "configured_ai_tools")) {
    throw new Error("The retained baseline unexpectedly contains project metadata.");
  }
}

function fixtureDigest(root) {
  const digest = createHash("sha256");
  for (const file of homeInventory(root)) digest.update(file).update(readFileSync(join(root, file)));
  return digest.digest("hex");
}

export function summarizeSamples(samples) {
  if (!samples.length || !samples.every(Number.isFinite)) throw new Error("Invalid timing samples.");
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value) => Math.round(value * 1000) / 1000;
  return { samples: samples.map(round), p50: round(sorted[Math.ceil(sorted.length * 0.5) - 1]), p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), min: round(sorted[0]), max: round(sorted.at(-1)) };
}

export function telemetryPreloadSource(endpoint) {
  const target = new URL(endpoint);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.pathname !== "/batch/" || target.search || target.hash || target.username || target.password) {
    throw new Error("Benchmark endpoint must be exact IPv4 loopback /batch/.");
  }
  return `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { urlToHttpOptions } from 'node:url';
import { writeSync } from 'node:fs';
const target = new URL(${JSON.stringify(target.href)});
const diagnostics = { redirected: 0, blocked: 0, blockedKind: null, requestErrors: 0, responseCompletions: 0 };
const originalRequest = http.request;
const originalConnect = net.Socket.prototype.connect;
const originalFetch = globalThis.fetch;
function deny(kind) { diagnostics.blocked++; diagnostics.blockedKind = kind; throw new Error('Benchmark blocked an unexpected outbound destination.'); }
for (const owner of [dns, dns.Resolver.prototype, dns.promises, dns.promises.Resolver.prototype]) {
  for (const key of Object.getOwnPropertyNames(owner)) if ((key.startsWith('resolve') || key === 'lookup') && typeof owner[key] === 'function') owner[key] = () => deny('dns');
}
dgram.Socket.prototype.send = () => deny('udp');
function allow(url) {
  if (url.origin !== 'https://us.i.posthog.com' || url.pathname !== '/batch/' || url.username || url.password) deny('https-origin');
  diagnostics.redirected++;
}
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof first[0] === 'object' ? first[0] : { port: first[0], host: first[1] };
  if (String(options.port) !== target.port || options.host !== '127.0.0.1' || options.path) deny('socket');
  return originalConnect.apply(this, args);
};
https.request = function (input, options, callback) {
  const base = typeof input === 'string' || input instanceof URL ? urlToHttpOptions(new URL(input)) : input;
  const merged = { ...base, ...(typeof options === 'object' ? options : {}) };
  const original = new URL((merged.protocol ?? 'https:') + '//' + (merged.hostname ?? merged.host) + (merged.port ? ':' + merged.port : '') + (merged.path ?? '/'));
  allow(original);
  const request = originalRequest({ ...merged, protocol: 'http:', hostname: target.hostname, host: target.hostname, port: target.port, path: target.pathname, agent: false, lookup: undefined }, typeof options === 'function' ? options : callback);
  request.on('error', () => { diagnostics.requestErrors++; });
  request.on('response', (response) => response.on('end', () => { diagnostics.responseCompletions++; }));
  return request;
};
https.get = (...args) => { const request = https.request(...args); request.end(); return request; };
http.request = () => deny('http-origin');
http.get = () => deny('http-origin');
globalThis.fetch = async (input, options) => {
  // Yoga loads its embedded WASM through fetch(data:). This performs no I/O.
  if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,') && input.length <= 2 * 1024 * 1024) return originalFetch(input, options);
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  allow(url);
  try { return await originalFetch(target, options); }
  catch (error) { diagnostics.requestErrors++; throw error; }
};
syncBuiltinESMExports();
process.on('exit', () => { try { writeSync(3, JSON.stringify(diagnostics)); } catch {} });
`;
}

export async function startLocalIngestion() {
  const sockets = new Set();
  let current = null;
  const server = createServer((request, response) => {
    const record = current;
    if (!record) { request.destroy(); return; }
    record.requests++;
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { record.invalidBodies++; request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        let body = Buffer.concat(chunks);
        if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES });
        const payload = JSON.parse(body.toString("utf8"));
        if (!Array.isArray(payload.batch) || payload.batch.length > 64) throw new Error("Invalid batch.");
        for (const event of payload.batch) {
          assertProjectContextEvent(event, record.projectContext);
          if (record.projectContext) record.projectContextEventsVerified++;
          // Retain only the closed aggregate dimensions used by this fixture.
          record.events.push({
            uuid: typeof event.uuid === "string" && event.uuid.length <= 64 ? event.uuid : null,
            event: typeof event.event === "string" && event.event.length <= 64 ? event.event : "invalid",
            command: typeof event.properties?.command === "string" && event.properties.command.length <= 64 ? event.properties.command : null,
            outcome: typeof event.properties?.outcome === "string" && event.properties.outcome.length <= 32 ? event.properties.outcome : null,
          });
        }
      } catch { record.invalidBodies++; }
      if (record.mode === "healthy") { response.writeHead(200, { "content-type": "application/json", connection: "close" }); response.end('{"status":1}'); }
    });
    request.on("error", () => {});
    response.on("error", () => {});
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/batch/`,
    begin(mode, projectContext) { current = { mode, requests: 0, invalidBodies: 0, events: [], projectContext, projectContextEventsVerified: 0 }; return current; },
    async finish() {
      // Measured child close has already happened. Let the parent observe its
      // socket close before checking cleanup; this wait is outside the sample.
      const deadline = performance.now() + 500;
      while (sockets.size && performance.now() < deadline) await new Promise((done) => setTimeout(done, 5));
      const openSockets = sockets.size;
      current = null;
      return openSockets;
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((done) => server.close(done)); },
  };
}

export async function runBoundedProcess({ cli, args, preload, cwd, env, timeoutMs = CHILD_TIMEOUT_MS }) {
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", preload, cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  let timedOut = false;
  let outputOverflow = false;
  let spawnError = null;
  const chunks = [[], [], []];
  const sizes = [0, 0, 0];
  child.on("error", (error) => { spawnError = error; });
  for (const [index, stream] of [child.stdout, child.stderr, child.stdio[3]].entries()) {
    stream.on("data", (chunk) => {
      sizes[index] += chunk.length;
      if (sizes[index] > MAX_OUTPUT_BYTES) { outputOverflow = true; child.kill("SIGKILL"); }
      else chunks[index].push(chunk);
    });
  }
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  const result = await new Promise((done) => child.once("close", (code, signal) => done({ code, signal, elapsedMs: performance.now() - started })));
  clearTimeout(timer);
  if (spawnError) throw spawnError;
  if (timedOut) throw new Error("Benchmark child exceeded its bounded lifetime.");
  if (outputOverflow) throw new Error("Benchmark child exceeded its output cap.");
  const [stdout, stderr, rawDiagnostics] = chunks.map((parts) => Buffer.concat(parts).toString("utf8"));
  const diagnostics = JSON.parse(rawDiagnostics);
  if (diagnostics.blocked) throw new Error(`Benchmark detected unexpected outbound networking (${diagnostics.blockedKind}).`);
  return { ...result, stdout, stderr, diagnostics };
}

function childEnvironment(mexHome, disabled) {
  const env = { ...process.env, MEX_HOME: mexHome, MEX_TELEMETRY: disabled ? "0" : "1", NO_COLOR: "1", LANG: "C", LC_ALL: "C" };
  for (const name of Object.keys(env)) {
    if (name === "DO_NOT_TRACK" || name === "MEX_DEV" || name.startsWith("NODE_") || name.startsWith("GIT_") || /^(https?|all|no)_proxy$/iu.test(name)) delete env[name];
  }
  return env;
}

function prepareHome(path, pristine = false) {
  mkdirSync(path, { recursive: true });
  if (!pristine) {
    mkdirSync(join(path, ".mex"));
    writeFileSync(join(path, ".mex", "config.json"), JSON.stringify({ firstRunNoticeShown: true, feedbackDismissed: true }));
    writeFileSync(join(path, ".mex", "telemetry-id"), randomUUID() + "\n", { mode: 0o600 });
  }
}

function homeInventory(root) {
  const output = [];
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (output.length > 64) throw new Error("Unexpected unbounded local telemetry state.");
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), relative + "/");
      else output.push(relative);
    }
  }
  visit(root);
  return output.sort();
}

export async function inspectQueue(mexHome, receivedById = new Map(), projectContext) {
  const path = join(mexHome, ".mex", "telemetry", "outbox.db");
  if (!existsSync(path)) return { state: "absent", events: 0, payloadBytes: 0, databaseBytes: 0, activeClaims: 0, eventCounts: {}, receivedOrQueuedEventCounts: {} };
  // The child has closed; read-only inspection is outside its timed lifetime.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT count(*) AS events, coalesce(sum(length(CAST(payload AS BLOB))),0) AS payloadBytes, coalesce(sum(CASE WHEN lease_until > ? THEN 1 ELSE 0 END),0) AS activeClaims FROM events").get(Date.now());
    const databaseBytes = statSync(path).size;
    if (row.events > 256 || row.payloadBytes > 256 * 1024 || databaseBytes > 1024 * 1024 || row.activeClaims) throw new Error("Telemetry queue bounds or released claims failed.");
    const eventCounts = {};
    const receivedOrQueued = new Map(receivedById);
    for (const item of database.prepare("SELECT payload FROM events LIMIT 256").all()) {
      const event = JSON.parse(item.payload);
      assertProjectContextEvent(event, projectContext);
      const key = event.event + ":" + (event.properties?.outcome ?? "");
      if (!["cli.command_started:", "cli.command_completed:success", "cli.command_completed:failure"].includes(key)) throw new Error("Unexpected benchmark queue event.");
      eventCounts[key] = (eventCounts[key] ?? 0) + 1;
      if (typeof event.uuid !== "string" || event.uuid.length > 64) throw new Error("Invalid benchmark queue identity.");
      receivedOrQueued.set(event.uuid, key);
    }
    const receivedOrQueuedEventCounts = {};
    for (const key of receivedOrQueued.values()) receivedOrQueuedEventCounts[key] = (receivedOrQueuedEventCounts[key] ?? 0) + 1;
    return { state: "available", ...row, databaseBytes, eventCounts, receivedOrQueuedEventCounts, ...(projectContext ? { projectContextEventsVerified: row.events } : {}) };
  } finally { database.close(); }
}

async function prepareModuleProbe(workspace, projectContext = false) {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src/telemetry/index.ts");
  const output = join(workspace, "module", "dist", "probe.mjs");
  mkdirSync(dirname(output), { recursive: true });
  const packageJson = JSON.parse(readFileSync(resolve(dirname(source), "../../package.json"), "utf8"));
  writeFileSync(join(workspace, "module", "package.json"), JSON.stringify({ type: "module", version: packageJson.version, private: true }));
  const esbuild = await import("esbuild");
  try {
    await esbuild.build({
      stdin: { contents: `
import {captureEvent,flush,getTelemetryInspection,__resetTelemetryForTest${projectContext ? ",getProjectTelemetryContext" : ""}} from ${JSON.stringify(source)};
import {performance} from 'node:perf_hooks';
const warmups=Number(process.argv[2]), samples=Number(process.argv[3]);
const results={started:[],completed:[],flush:[],firstStartedMs:null,${projectContext ? "contextRead:[]," : ""}};
for(let index=0;index<warmups+samples;index++) {
  __resetTelemetryForTest();
  ${projectContext ? "const readStarted=performance.now(); const context=getProjectTelemetryContext(process.cwd()); const readEnded=performance.now();" : "const context={};"}
  const start=performance.now();
  captureEvent('cli.command_started',{...context,command:'commands',stage:'direct'});
  const middle=performance.now();
  captureEvent('cli.command_completed',{...context,command:'commands',stage:'direct',outcome:'success',duration_ms:0});
  const end=performance.now();
  await flush();
  const closed=performance.now();
  if(index===0) results.firstStartedMs=middle-start;
  if(index>=warmups) {results.started.push(middle-start);results.completed.push(end-middle);results.flush.push(closed-end);}
  ${projectContext ? "if(index>=warmups) results.contextRead.push(readEnded-readStarted);" : ""}
}
results.queue=getTelemetryInspection().queue;
await flush({deadlineMs:0});
__resetTelemetryForTest();
process.stdout.write(JSON.stringify(results));
`, sourcefile: "telemetry-module-probe.ts", resolveDir: resolve(dirname(source), "../..") },
      outfile: output, bundle: true, packages: "external", platform: "node", target: "node22", format: "esm", logLevel: "silent",
    });
  } finally { await esbuild.stop(); }
  return output;
}

export async function runTelemetryBenchmark({ cli, baseline, samples = 20, warmups = 5, projectContext = false, progress = () => {} }) {
  if (!Number.isInteger(samples) || samples < 20 || samples > 100 || !Number.isInteger(warmups) || warmups < 0 || warmups > 20) throw new Error("Expected 20–100 samples and 0–20 warmups.");
  const builds = [{ name: "baseline", cli: resolve(baseline) }, { name: "candidate", cli: resolve(cli) }];
  for (const build of builds) if (!existsSync(build.cli)) throw new Error("Built CLI missing.");
  const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-benchmark-"));
  let ingestion;
  try {
    const fixture = join(workspace, "fixture");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "package.json"), '{"name":"telemetry-benchmark-fixture","private":true}\n');
    const project = projectContext ? createProjectContextFixture(fixture) : undefined;
    const canonicalBefore = project ? fixtureDigest(fixture) : undefined;
    const expectedContext = (build) => project ? { ...project, required: build === "candidate" } : undefined;
    ingestion = await startLocalIngestion();
    const refused = await startLocalIngestion();
    const refusedEndpoint = refused.endpoint;
    await refused.close();
    const preloads = {};
    for (const condition of CONDITIONS) {
      preloads[condition] = join(workspace, `${condition}.mjs`);
      writeFileSync(preloads[condition], telemetryPreloadSource(condition === "refused" ? refusedEndpoint : ingestion.endpoint));
    }
    // Compile the private source-module probe and stop its compiler service
    // before any timing loop. This is distinct from the unchanged built CLI.
    const moduleProbePath = await prepareModuleProbe(workspace, projectContext);
    const records = {};
    for (const build of builds) {
      build.sha256 = createHash("sha256").update(readFileSync(build.cli)).digest("hex");
      for (const command of COMMANDS) {
        for (const condition of CONDITIONS) {
          const key = `${build.name}.${command.name}.${condition}`;
          const mexHome = join(workspace, key);
          prepareHome(mexHome);
          records[key] = { build: build.name, command: command.name, condition, mexHome, runs: [], receivedById: new Map(), receivedEventCounts: {} };
        }
      }
    }
    async function measure(build, command, condition, mexHome, ledger = { receivedById: new Map(), receivedEventCounts: {} }) {
      const received = ingestion.begin(condition === "healthy" || condition === "disabled" ? "healthy" : "hanging", expectedContext(build.name));
      let result;
      try { result = await runBoundedProcess({ cli: build.cli, args: command.args, preload: preloads[condition], cwd: fixture, env: childEnvironment(mexHome, condition === "disabled") }); }
      catch (error) { throw new Error(`${build.name}.${command.name}.${condition}: ${error.message}`); }
      const openSockets = await ingestion.finish();
      if (result.code !== command.exitCode || result.signal || openSockets || received.invalidBodies) throw new Error(`Invalid process/delivery result for ${build.name}.${command.name}.${condition}.`);
      if (condition === "disabled" && (received.requests || result.diagnostics.redirected)) throw new Error("Disabled telemetry touched the network.");
      if (condition === "refused" && received.requests) throw new Error("Refused condition reached ingestion.");
      if (command.name === "success" && (!result.stdout.includes("CLI Commands") || result.stderr.includes("Unhandled"))) throw new Error("Success command output changed.");
      if (command.name === "failure") {
        if (project) {
          const report = JSON.parse(result.stdout);
          if (!Array.isArray(report.issues) || !report.issues.some((issue) => issue.code === "MISSING_PATH" && issue.severity === "error")) throw new Error("Project fixture did not report its deliberate missing path.");
        } else if (!result.stderr.trim() || result.stdout.trim()) throw new Error("Failure command output contract changed.");
      }
      for (const event of received.events) {
        if (!event.uuid || !ledger.receivedById.has(event.uuid)) {
          const key = event.event + ":" + (event.outcome ?? "");
          if (event.uuid) ledger.receivedById.set(event.uuid, key);
          ledger.receivedEventCounts[key] = (ledger.receivedEventCounts[key] ?? 0) + 1;
        }
      }
      if (ledger.receivedById.size > 512) throw new Error("Unexpected unbounded delivery evidence.");
      return { elapsedMs: result.elapsedMs, exitCode: result.code, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), requests: received.requests, events: received.events.map(({ uuid: _uuid, ...event }) => event), openSocketsAfterExit: openSockets, ...result.diagnostics, ...(project ? { projectContextEventsVerified: received.projectContextEventsVerified } : {}) };
    }
    for (let round = 0; round < warmups + samples; round++) {
      const order = round % 2 ? [...builds].reverse() : builds;
      const conditions = [...CONDITIONS.slice(round % CONDITIONS.length), ...CONDITIONS.slice(0, round % CONDITIONS.length)];
      for (const command of COMMANDS) {
        for (const condition of conditions) {
          for (const build of order) {
            const record = records[`${build.name}.${command.name}.${condition}`];
            const result = await measure(build, command, condition, record.mexHome, record);
            if (round >= warmups) record.runs.push(result);
          }
        }
      }
      progress({ round: round + 1, totalRounds: warmups + samples, phase: round < warmups ? "warmup" : "measured" });
    }
    const pristine = [];
    for (let round = 0; round < 3; round++) {
      for (const build of round % 2 ? [...builds].reverse() : builds) {
        for (const condition of ["disabled", "healthy"]) {
          const mexHome = join(workspace, `pristine-${round}-${build.name}-${condition}`);
          prepareHome(mexHome, true);
          const result = await measure(build, COMMANDS[0], condition, mexHome);
          const queue = await inspectQueue(mexHome, undefined, expectedContext(build.name));
          if (condition === "disabled" && homeInventory(mexHome).length) throw new Error("Disabled first command created local telemetry state.");
          pristine.push({ build: build.name, condition, ...result, files: homeInventory(mexHome), queue });
        }
      }
    }
    const groups = Object.fromEntries(await Promise.all(Object.entries(records).map(async ([key, record]) => [key, {
      processMs: summarizeSamples(record.runs.map((run) => run.elapsedMs)),
      delivery: { serverReceivedRequests: record.runs.map((run) => run.requests), serverReceivedEventsPerRun: record.runs.map((run) => run.events), requestErrors: record.runs.map((run) => run.requestErrors), clientHttpResponseCompletions: record.runs.map((run) => run.responseCompletions), openSocketsAfterExit: record.runs.map((run) => run.openSocketsAfterExit) },
      ...(project ? { projectContextEventsVerified: record.runs.map((run) => run.projectContextEventsVerified) } : {}),
      output: { exitCodes: [...new Set(record.runs.map((run) => run.exitCode))], stdoutBytes: [...new Set(record.runs.map((run) => run.stdoutBytes))], stderrBytes: [...new Set(record.runs.map((run) => run.stderrBytes))] },
      files: homeInventory(record.mexHome),
      queue: await inspectQueue(record.mexHome, record.receivedById, expectedContext(record.build)),
      uniqueServerReceivedEventsIncludingWarmups: record.receivedEventCounts,
    }])));
    for (const command of COMMANDS) {
      const healthy = groups[`candidate.${command.name}.healthy`];
      const completionKey = "cli.command_completed:" + command.name;
      if (!(healthy.uniqueServerReceivedEventsIncludingWarmups[completionKey] > 0)) throw new Error("Healthy ingestion never received a command outcome.");
      for (const key of ["cli.command_started:", completionKey]) {
        if ((healthy.queue.receivedOrQueuedEventCounts[key] ?? 0) !== warmups + samples) throw new Error("Healthy command event receipt/retention accounting failed.");
      }
      for (const condition of ["refused", "hanging"]) if (!groups[`candidate.${command.name}.${condition}`].queue.events) throw new Error("Offline candidate did not preserve queued events.");
    }
    const pairedDeltasMs = {};
    for (const build of builds) for (const command of COMMANDS) {
      const disabled = records[`${build.name}.${command.name}.disabled`].runs;
      for (const condition of CONDITIONS.slice(1)) pairedDeltasMs[`${build.name}.${command.name}.${condition}-disabled`] = summarizeSamples(records[`${build.name}.${command.name}.${condition}`].runs.map((run, index) => run.elapsedMs - disabled[index].elapsedMs));
    }
    for (const command of COMMANDS) for (const condition of CONDITIONS) {
      const before = records[`baseline.${command.name}.${condition}`].runs;
      pairedDeltasMs[`candidate-baseline.${command.name}.${condition}`] = summarizeSamples(records[`candidate.${command.name}.${condition}`].runs.map((run, index) => run.elapsedMs - before[index].elapsedMs));
    }
    const moduleProbe = {};
    for (const condition of CONDITIONS) {
      const mexHome = join(workspace, `module-${condition}`);
      prepareHome(mexHome);
      const received = ingestion.begin(condition === "healthy" || condition === "disabled" ? "healthy" : "hanging", expectedContext("candidate"));
      const processResult = await runBoundedProcess({ cli: moduleProbePath, args: [String(warmups), String(samples)], preload: preloads[condition], cwd: fixture, env: childEnvironment(mexHome, condition === "disabled") });
      if (processResult.code !== 0 || processResult.signal || received.invalidBodies || await ingestion.finish()) throw new Error("Module probe did not exit and clean up normally.");
      const result = JSON.parse(processResult.stdout);
      if (result.started.length !== samples || result.completed.length !== samples || result.flush.length !== samples) throw new Error("Module probe sample count mismatch.");
      moduleProbe[condition] = { captureStartedMs: summarizeSamples(result.started), captureCompletedMs: summarizeSamples(result.completed), flushMs: summarizeSamples(result.flush), firstCaptureStartedMs: result.firstStartedMs, queue: result.queue, requests: received.requests, ...processResult.diagnostics };
      if (project) {
        moduleProbe[condition].projectContextReadMs = summarizeSamples(result.contextRead);
        moduleProbe[condition].projectContextEventsVerified = received.projectContextEventsVerified;
        moduleProbe[condition].verifiedQueue = await inspectQueue(mexHome, undefined, expectedContext("candidate"));
      }
    }
    if (project && fixtureDigest(fixture) !== canonicalBefore) throw new Error("Project fixture changed during ordinary reads.");
    return {
      schemaVersion: 1, kind: "telemetry-local-performance-characterization", generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: platform(), release: release(), architecture: process.arch, cpu: cpus()[0]?.model ?? "unknown" },
      builds: builds.map(({ name, sha256 }) => ({ name, cliSha256: sha256 })),
      methodology: { samplesPerCondition: samples, warmupsPerCondition: warmups, commandArguments: COMMANDS.map(({ name, args }) => ({ name, args })), conditionOrder: "rotated every round; baseline/candidate order alternates", measuredInterval: "spawn through child close, including loader, CLI, telemetry and natural process cleanup", transport: "harness-only preload redirects only the fixed PostHog HTTPS batch destination to real loopback HTTP; all other outbound sockets denied; TLS and external network latency excluded", repeatUse: "isolated preseeded installation identity and notice preferences", pristineRunsPerCondition: 3, lifetimeHangGuardMs: CHILD_TIMEOUT_MS, portablePerformanceGate: false },
      groups, pairedDeltasMs, pristine,
      ...(project ? { projectContext: { configuredAiTools: project.tools, existingScaffoldUuidMatched: true, privateSentinelsRejected: true, canonicalFixtureUnchanged: true, failureFixture: "ROUTER names one absent source file; check --json must return MISSING_PATH with exit1", canonicalFixtureSha256: canonicalBefore } } : {}),
      moduleProbe: { methodology: "Separately bundled current internal telemetry module; direct synchronous capture-call and awaited flush timings. Module/compiler startup excluded. Each repetition resets transport handles and keeps its isolated durable queue; first capture includes queue initialization. This does not replace built-CLI lifetime measurements." + (project ? " The project mode times getProjectTelemetryContext separately once per repetition and reuses its snapshot for both capture calls; this consent-gated helper skips project reads when disabled." : ""), bundleSha256: createHash("sha256").update(readFileSync(moduleProbePath)).digest("hex"), conditions: moduleProbe },
      limitations: ["Single local host; paired differences include scheduler and module-loading noise.", "Server receipt is not client acknowledgement: hanging ingestion receives bodies but never acknowledges them. Client HTTP response completions and durable retained events are reported separately; receipt/retention accounting deduplicates UUIDs in memory and retains no identifiers.", "Local HTTP ingestion does not measure production TLS or Internet latency.", "Candidate offline queues accumulate across the repeated invocations; the queue remains bounded and is inspected only after timed runs.", "First-command runs are bounded observations, not a statistically stable p95."]
    };
  } finally { await ingestion?.close(); rmSync(workspace, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--project-context") { options.projectContext = true; continue; }
    if (!["--cli", "--baseline", "--output", "--samples", "--warmups"].includes(args[index]) || !args[index + 1]) throw new Error("Usage: node scripts/benchmark-telemetry.mjs --baseline <built-cli> --output <json> [--cli dist/cli.js] [--samples 20] [--warmups 5] [--project-context]");
    options[args[index].slice(2)] = args[++index];
  }
  if (!options.baseline || !options.output) throw new Error("A preserved baseline CLI and report output path are required.");
  const report = await runTelemetryBenchmark({ cli: options.cli ?? resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js"), baseline: options.baseline, samples: Number(options.samples ?? 20), warmups: Number(options.warmups ?? 5), projectContext: options.projectContext === true, progress: (value) => process.stderr.write(JSON.stringify(value) + "\n") });
  const json = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(json) > MAX_REPORT_BYTES) throw new Error("Benchmark report exceeded its output cap.");
  writeFileSync(resolve(options.output), json);
  process.stdout.write(JSON.stringify({ result: "complete", groups: Object.keys(report.groups).length, samplesPerCondition: report.methodology.samplesPerCondition }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

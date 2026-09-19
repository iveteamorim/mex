#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createBenchmarkEnvironment } from "./environment.mjs";
import { createGraphCharacterizationFixture } from "./graph-fixture.mjs";
import { PROCESS_MEASUREMENT, startProcessTreeSampler } from "./process-tree.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("Usage: node scripts/release-benchmark/graph-characterization.mjs [--smoke] [--output path]\nCharacterization only; no release budgets are created or calibrated.\n");
  process.exit(0);
}
let output;
let smoke = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--smoke") smoke = true;
  else if (args[index] === "--output" && args[index + 1]) output = resolve(args[++index]);
  else throw new Error(`Unknown graph characterization argument: ${args[index]}`);
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "mex-graph-characterization-"));
// External imports resolve through this repository's node_modules, without changing dist.
const toolParent = join(repository, "test-results", "graph-characterization");
mkdirSync(toolParent, { recursive: true });
const tool = mkdtempSync(join(toolParent, "worker-"));
let worker;
let sampler;
try {
  const environment = createBenchmarkEnvironment(work);
  const fixture = createGraphCharacterizationFixture(join(work, "fixture"), { smoke });
  await build({ entryPoints: [join(repository, "scripts/release-benchmark/graph-characterization-worker.ts")],
    outfile: join(tool, "worker.mjs"), bundle: true, platform: "node", target: "node22", format: "esm", packages: "external" });
  cpSync(join(repository, "src/graph/schema.sql"), join(tool, "schema.sql"));
  cpSync(join(repository, "src/graph/wasm"), join(tool, "wasm"), { recursive: true });
  worker = spawn(process.execPath, ["--expose-gc", "--max-old-space-size=2048", join(tool, "worker.mjs"), fixture.root], {
    cwd: fixture.root, env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let stderr = "";
  worker.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2_000); });
  await receive(worker, 10_000);
  const samples = [];
  for (const mode of ["build", "unchanged", "changed", "unchanged", "changed"]) {
    sampler = await startProcessTreeSampler(worker.pid);
    let oversized = false;
    const guard = setInterval(() => {
      void sampler?.sample().then((usage) => {
        if (usage.rssBytes > 2.5 * 1024 ** 3) { oversized = true; worker.kill("SIGKILL"); }
      }).catch(() => undefined);
    }, 250);
    try {
      const reply = receive(worker, smoke ? 30_000 : 180_000);
      worker.send({ mode });
      const measured = await reply;
      if (measured.error) throw new Error(measured.error);
      if (measured.mode !== mode || !measured.result) throw new Error("Invalid graph characterization reply.");
      if (mode === "unchanged" && measured.result.filesIndexed !== 0) throw new Error("Unchanged graph sync unexpectedly reindexed source.");
      if (mode !== "unchanged" && measured.result.filesIndexed !== fixture.sourceFiles) throw new Error("Graph characterization source coverage changed.");
      const aggregate = await sampler.stop();
      sampler = undefined;
      samples.push({ ...measured, aggregate });
    } catch (error) {
      if (oversized) throw new Error("Graph characterization exceeded its 2.5 GiB sampled RSS hang guard.");
      throw new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`);
    } finally { clearInterval(guard); }
  }
  const { root: _fixtureRoot, ...fixtureDescription } = fixture;
  const report = {
    schemaVersion: 1, benchmark: "mex-graph-characterization", generatedAt: new Date().toISOString(),
    environment: { node: process.version, sqlite: process.versions.sqlite, v8: process.versions.v8, platform: process.platform, arch: process.arch },
    workerBundleSha256: createHash("sha256").update(readFileSync(join(tool, "worker.mjs"))).digest("hex"),
    fixture: fixtureDescription,
    measurement: { ...PROCESS_MEASUREMENT, scope: "engine-worker-and-descendants", engineOnly: true, forcedGcAfterClose: 3,
      note: "Characterization only. Five operations share one process. CPU/RSS sampling is separate from post-GC retained memory; no laptop-derived release budgets." },
    samples,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(json) > 128 * 1024) throw new Error("Graph characterization report exceeded 128 KiB.");
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, json); }
  process.stdout.write(json);
} finally {
  await sampler?.stop().catch(() => undefined);
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const stopped = once(worker, "exit");
    worker.kill("SIGKILL");
    await stopped;
  }
  rmSync(tool, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

function receive(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); child.kill("SIGKILL"); reject(new Error("Graph characterization deadline expired.")); }, timeoutMs);
    const message = (value) => { cleanup(); resolve(value); };
    const exited = () => { cleanup(); reject(new Error("Graph characterization worker exited.")); };
    const failed = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer); child.off("message", message); child.off("exit", exited); child.off("error", failed);
    };
    child.once("message", message); child.once("exit", exited); child.once("error", failed);
  });
}

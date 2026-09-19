#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGraphOutputIsolation, buildSystemArtifacts } from "../core/artifacts.mjs";
import { loadGraphSuite, resolveSystemCommands, suiteContext } from "../schemas/graph-suite.mjs";
import { validateSubjectFixture } from "./lib/fixture.mjs";
import { prepareGraphEvaluation, loadPreparedGraphEvaluation } from "./lib/prepare.mjs";
import { generateGraphReport } from "./lib/report.mjs";
import { runGraphEvaluation } from "./lib/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..");
const DEFAULT_SUITE = join(HARNESS_ROOT, "evaluate", "suites", "native", "graph", "mex.json");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function parseArgs(argv) {
  const args = {
    mode: "all",
    suite: DEFAULT_SUITE,
    repo: HARNESS_ROOT,
    timeoutMs: 120_000,
    maxOutputBytes: 32 * 1024 * 1024,
    resume: false,
    gate: true,
    systemCli: {},
  };
  let explicitMode = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (["--validate", "--prepare", "--run", "--report", "--all"].includes(arg)) {
      if (explicitMode) throw new Error("choose exactly one of --validate, --prepare, --run, --report, or --all");
      args.mode = arg.slice(2);
      explicitMode = true;
    } else if (arg === "--suite") args.suite = resolve(argv[++index]);
    else if (arg === "--repo") args.repo = resolve(argv[++index]);
    else if (arg === "--output") args.output = resolve(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--max-output-bytes") args.maxOutputBytes = Number(argv[++index]);
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--no-gate") args.gate = false;
    else if (arg === "--system-cli") {
      const value = argv[++index] ?? "";
      const split = value.indexOf("=");
      if (split < 1) throw new Error("--system-cli must be id=/path/to/cli.js");
      args.systemCli[value.slice(0, split)] = resolve(value.slice(split + 1));
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (!Number.isFinite(args.maxOutputBytes) || args.maxOutputBytes <= 0) throw new Error("--max-output-bytes must be positive");
  return args;
}

function commandsFromPrepared(prepared) {
  return Object.fromEntries(Object.entries(prepared.systems).map(([id, system]) => [id, system.command]));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const suite = loadGraphSuite(args.suite);
  const outputDir = args.output ?? join(HARNESS_ROOT, ".mex", "eval-results", "graph", suite.id, timestamp());
  if (args.mode === "validate") {
    const fixture = validateSubjectFixture(suite, args.repo);
    console.log(`valid graph suite: ${suite.id} (${suite.tasks.length} tasks, ${Object.keys(suite.systems).length} systems, subject ${fixture.subject.sha ?? fixture.subject.treeStateSha256})`);
    return;
  }
  if (args.mode === "report") {
    const report = generateGraphReport({ suite, outputDir });
    console.log(JSON.stringify(report, null, 2));
    if (args.gate && !report.gate.passed) process.exitCode = 1;
    return;
  }
  if (!existsSync(args.repo)) throw new Error(`subject repository does not exist: ${args.repo}`);
  assertGraphOutputIsolation(args.repo, outputDir);
  let prepared;
  if (args.mode === "prepare" || args.mode === "all") {
    if (args.resume && existsSync(join(outputDir, "prepare.json"))) {
      prepared = loadPreparedGraphEvaluation(outputDir);
    } else {
      const context = suiteContext(suite, HARNESS_ROOT, args.repo, join(outputDir, "artifacts"));
      const artifacts = buildSystemArtifacts({ suite, context, outputDir, overrides: args.systemCli });
      const systemCommands = resolveSystemCommands(suite, context, artifacts.overrides);
      prepared = prepareGraphEvaluation({
        suite,
        subjectRoot: args.repo,
        harnessRoot: HARNESS_ROOT,
        outputDir,
        systemCommands,
        artifactMetadata: artifacts.metadata,
        invocation: { mode: args.mode, timeoutMs: args.timeoutMs, maxOutputBytes: args.maxOutputBytes },
      });
    }
    console.log(`prepared graph evaluation ${suite.id} at ${outputDir}`);
    if (args.mode === "prepare") return;
  } else {
    prepared = loadPreparedGraphEvaluation(outputDir);
  }
  const systemCommands = commandsFromPrepared(prepared);
  const result = await runGraphEvaluation({
    suite,
    subjectRoot: args.repo,
    outputDir,
    systemCommands,
    timeoutMs: args.timeoutMs,
    maxOutputBytes: args.maxOutputBytes,
    resume: args.resume,
  });
  const report = generateGraphReport({ suite, outputDir, suppliedRows: result.rows });
  console.log(JSON.stringify(report, null, 2));
  if (args.gate && !report.gate.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[eval:graph] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}

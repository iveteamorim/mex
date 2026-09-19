#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRuntimeViolations,
  evaluateRuntimeConfirmation,
  runtimeSampleSupport,
} from "./runtime-confirmation.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "../..");
const runnerPath = join(scriptRoot, "run.mjs");
const DEFAULT_REPORT_PATH = join(repositoryRoot, "test-results", "release-benchmark", "report.json");
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      "Usage: node scripts/release-benchmark/enforce.mjs [--output <path>] [--assets-only]",
      "",
      "Runtime budgets are enforced only when MEX_ENFORCE_RELEASE_BUDGETS=1.",
      "Potentially material noisy runtime breaches receive one confirmation pass.",
      "Deterministic contract breaches and operational failures never receive a retry.",
      "",
    ].join("\n"));
    process.exitCode = 0;
  } else if (process.env.MEX_ENFORCE_RELEASE_BUDGETS !== "1" || options.assetsOnly) {
    process.exitCode = runPass(options.output, process.argv.slice(2), true).status ?? 2;
  } else {
    process.exitCode = enforceWithConfirmation(options.output ?? DEFAULT_REPORT_PATH);
  }
}

export function enforceWithConfirmation(outputPath, dependencies = {}) {
  try {
    return enforceWithConfirmationInternal(outputPath, dependencies);
  } catch {
    process.stderr.write("Release benchmark enforcement failed operationally.\n");
    return 2;
  }
}

function enforceWithConfirmationInternal(outputPath, dependencies) {
  const executePass = dependencies.executePass ?? runPass;
  const resolveRepositoryHead = dependencies.resolveRepositoryHead ?? readRepositoryHead;
  const emitReport = dependencies.emitReport ?? ((serialized) => process.stdout.write(serialized));
  const resolvedOutput = resolve(outputPath);
  const firstPath = attemptPath(resolvedOutput, 1);
  const secondPath = attemptPath(resolvedOutput, 2);
  for (const path of [resolvedOutput, firstPath, secondPath]) rmSync(path, { force: true });
  const repositoryHead = resolveRepositoryHead();
  if (repositoryHead === null) return 2;

  const firstResult = executePass(firstPath, ["--output", firstPath]);
  const firstReport = readPassReport(firstPath, firstResult);
  if (firstReport === null) return 2;

  if (firstReport.budgetEvaluation.assetViolations.length > 0) {
    writeFinalReport(resolvedOutput, firstReport, confirmationRecord(
      "skipped_immediate_failure",
      firstReport.budgetEvaluation.runtimeViolations,
      [],
      [],
      repositoryHead,
    ), undefined, undefined, emitReport);
    rmSync(firstPath, { force: true });
    return 1;
  }

  const firstClassification = classifyRuntimeViolations(
    firstReport.budgetEvaluation.runtimeViolations,
  );
  let firstSampleSupport;
  if (firstClassification.confirmable.length > 0) {
    try {
      firstSampleSupport = runtimeSampleSupport(
        firstReport,
        firstClassification.confirmable,
      );
    } catch {
      if (firstClassification.immediate.length === 0) {
        writeFinalReport(resolvedOutput, firstReport, confirmationRecord(
          "operational_failure",
          firstReport.budgetEvaluation.runtimeViolations,
          [],
          [],
          repositoryHead,
        ), firstReport.budgetEvaluation.runtimeViolations, false, emitReport);
        process.stderr.write("Release benchmark pass had invalid runtime sample evidence.\n");
        return 2;
      }
    }
  }
  const initialDecision = evaluateRuntimeConfirmation(
    firstReport.budgetEvaluation.runtimeViolations,
    undefined,
    { first: firstSampleSupport },
  );
  if (!initialDecision.retryRequired) {
    writeFinalReport(resolvedOutput, firstReport, confirmationRecord(
      initialDecision.status,
      firstReport.budgetEvaluation.runtimeViolations,
      [],
      initialDecision.confirmed,
      repositoryHead,
      initialDecision.advisoryAssessments,
      initialDecision.materialAssessments,
    ), initialDecision.finalViolations, undefined, emitReport);
    if (initialDecision.advisoryAssessments.length === 0) {
      rmSync(firstPath, { force: true });
    }
    return initialDecision.finalViolations.length === 0 ? 0 : 1;
  }

  process.stderr.write(
    "A potentially material noisy runtime budget breached; running one independent pinned confirmation pass.\n",
  );
  if (resolveRepositoryHead() !== repositoryHead) {
    writeFinalReport(resolvedOutput, firstReport, confirmationRecord(
      "operational_failure",
      firstReport.budgetEvaluation.runtimeViolations,
      [],
      [],
      repositoryHead,
    ), undefined, undefined, emitReport);
    process.stderr.write("Repository HEAD changed before the confirmation pass.\n");
    return 2;
  }
  const secondResult = executePass(secondPath, ["--output", secondPath]);
  const secondReport = readPassReport(secondPath, secondResult);
  if (secondReport === null) {
    writeFinalReport(resolvedOutput, firstReport, confirmationRecord(
      "operational_failure",
      firstReport.budgetEvaluation.runtimeViolations,
      [],
      [],
      repositoryHead,
    ), undefined, undefined, emitReport);
    return 2;
  }
  if (resolveRepositoryHead() !== repositoryHead) {
    writeFinalReport(resolvedOutput, secondReport, confirmationRecord(
      "operational_failure",
      firstReport.budgetEvaluation.runtimeViolations,
      secondReport.budgetEvaluation.runtimeViolations,
      [],
      repositoryHead,
    ), secondReport.budgetEvaluation.runtimeViolations, false, emitReport);
    process.stderr.write("Repository HEAD changed during the confirmation pass.\n");
    return 2;
  }

  let secondSampleSupport;
  try {
    secondSampleSupport = runtimeSampleSupport(
      secondReport,
      secondReport.budgetEvaluation.runtimeViolations,
    );
  } catch {
    writeFinalReport(resolvedOutput, secondReport, confirmationRecord(
      "operational_failure",
      firstReport.budgetEvaluation.runtimeViolations,
      secondReport.budgetEvaluation.runtimeViolations,
      [],
      repositoryHead,
      initialDecision.advisoryAssessments,
    ), secondReport.budgetEvaluation.runtimeViolations, false, emitReport);
    process.stderr.write("Release benchmark confirmation had invalid runtime sample evidence.\n");
    return 2;
  }
  const decision = evaluateRuntimeConfirmation(
    firstReport.budgetEvaluation.runtimeViolations,
    secondReport.budgetEvaluation.runtimeViolations,
    { first: firstSampleSupport, second: secondSampleSupport },
  );
  const secondAssetViolations = secondReport.budgetEvaluation.assetViolations;
  const passed = secondAssetViolations.length === 0 && decision.finalViolations.length === 0;
  writeFinalReport(resolvedOutput, secondReport, confirmationRecord(
    passed ? "passed" : "failed",
    firstReport.budgetEvaluation.runtimeViolations,
    secondReport.budgetEvaluation.runtimeViolations,
    decision.confirmed,
    repositoryHead,
    decision.advisoryAssessments,
    decision.materialAssessments,
  ), decision.finalViolations, passed, emitReport);
  return passed ? 0 : 1;
}

function runPass(outputPath, args, showStdout = false) {
  const runnerArgs = outputPath === undefined ? args : replaceOutputArgument(args, outputPath);
  const result = spawnSync(process.execPath, [runnerPath, ...runnerArgs], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["inherit", showStdout ? "inherit" : "ignore", "inherit"],
  });
  return { status: result.status, signal: result.signal };
}

function readPassReport(path, result) {
  if ((result.status !== 0 && result.status !== 1) || result.signal !== null || !existsSync(path)) {
    process.stderr.write("Release benchmark pass failed before producing a budget report.\n");
    return null;
  }
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) throw new Error("report too large");
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (report?.schemaVersion !== 1
      || !Array.isArray(report?.budgetEvaluation?.assetViolations)
      || !Array.isArray(report?.budgetEvaluation?.runtimeViolations)
      || report.budgetEvaluation.assetViolations.length > 200
      || report.budgetEvaluation.runtimeViolations.length > 200
      || report.budgetEvaluation.passed !== (result.status === 0)) {
      throw new Error("invalid report shape");
    }
    return report;
  } catch {
    process.stderr.write("Release benchmark pass produced an invalid budget report.\n");
    return null;
  }
}

function writeFinalReport(path, report, confirmation, runtimeViolations, passed, emitReport) {
  const finalReport = structuredClone(report);
  finalReport.budgetEvaluation.runtimeConfirmation = confirmation;
  if (runtimeViolations !== undefined) {
    finalReport.budgetEvaluation.runtimeViolations = runtimeViolations;
  }
  finalReport.budgetEvaluation.passed = passed ?? (
    finalReport.budgetEvaluation.assetViolations.length === 0
    && finalReport.budgetEvaluation.runtimeViolations.length === 0
  );
  const serialized = `${JSON.stringify(finalReport, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) {
    throw new Error(`Release benchmark report exceeded ${MAX_REPORT_BYTES} bytes.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialized, "utf8");
  emitReport(serialized);
}

function confirmationRecord(
  status,
  firstPassViolations,
  secondPassViolations,
  confirmedViolations,
  repositoryHead,
  advisoryAssessments = [],
  materialAssessments = [],
) {
  return {
    status,
    repositoryHead,
    firstPassViolations: firstPassViolations.slice(0, 200),
    secondPassViolations: secondPassViolations.slice(0, 200),
    confirmedViolations: confirmedViolations.slice(0, 200),
    advisoryAssessments: advisoryAssessments.slice(0, 400),
    materialAssessments: materialAssessments.slice(0, 200),
  };
}

function readRepositoryHead() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const head = result.stdout?.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(head)) {
    process.stderr.write("Release benchmark could not resolve the repository HEAD.\n");
    return null;
  }
  return head;
}

function attemptPath(outputPath, attempt) {
  const parts = parse(outputPath);
  return join(parts.dir, `${parts.name}.attempt-${attempt}${parts.ext || ".json"}`);
}

function replaceOutputArgument(args, outputPath) {
  const outputArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output") {
      index += 1;
      continue;
    }
    outputArgs.push(args[index]);
  }
  outputArgs.push("--output", outputPath);
  return outputArgs;
}

function parseArguments(args) {
  const parsed = { assetsOnly: false, help: false, output: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--assets-only") parsed.assetsOnly = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--output") {
      const output = args[index + 1];
      if (!output || output.startsWith("-")) throw new Error("--output requires a path.");
      parsed.output = output;
      index += 1;
    } else throw new Error(`Unknown release benchmark option: ${argument}`);
  }
  return parsed;
}

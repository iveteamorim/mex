#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRuntimeViolations,
  evaluateRuntimeConfirmation,
  runtimeSampleSupport,
} from "./runtime-confirmation.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "../..");
const runnerPath = resolve(scriptRoot, "run.mjs");
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_VIOLATIONS = 200;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const GITHUB_NUMBER_PATTERN = /^[1-9][0-9]{0,19}$/u;
const JOB_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const DISPOSITIONS = new Set([
  "clean",
  "advisory",
  "confirmation_required",
  "hard_failure",
]);

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

function main(args) {
  try {
    const parsed = parseArguments(args);
    if (parsed.command === "help") {
      process.stdout.write(helpText());
      return 0;
    }
    if (parsed.command === "attempt") return runCiAttempt(parsed.options);
    if (parsed.command === "retry-required") {
      process.stdout.write(`${readCiRetryRequired(parsed.options.manifestPath)}\n`);
      return 0;
    }
    return finalizeCiAttempts(parsed.options);
  } catch (error) {
    process.stderr.write(`Release benchmark CI orchestration failed operationally: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function runCiAttempt(options, dependencies = {}) {
  try {
    const enforceReleaseBudgets = dependencies.enforceReleaseBudgets
      ?? process.env.MEX_ENFORCE_RELEASE_BUDGETS;
    if (enforceReleaseBudgets !== "1") {
      throw new Error("MEX_ENFORCE_RELEASE_BUDGETS=1 is required for a CI benchmark attempt");
    }
    const reportPath = requiredResolvedPath(options?.reportPath, "reportPath");
    const manifestPath = requiredResolvedPath(options?.manifestPath, "manifestPath");
    assertDistinctPaths([reportPath, manifestPath]);
    rmSync(reportPath, { force: true });
    rmSync(manifestPath, { force: true });

    const resolveRepositoryHead = dependencies.resolveRepositoryHead ?? readRepositoryHead;
    const resolveGithubIdentity = dependencies.resolveGithubIdentity ?? readGithubIdentity;
    const executePass = dependencies.executePass ?? runRawPass;
    const repositoryHead = requireRepositoryHead(resolveRepositoryHead());
    const identity = validateGithubIdentity(resolveGithubIdentity());
    if (identity.sha !== repositoryHead) {
      throw new Error("GITHUB_SHA does not match the checked-out repository HEAD");
    }

    const result = executePass(reportPath);
    const artifact = readRawReport(reportPath, result);
    const analysis = analyzeInitialAttempt(artifact.report);
    const manifest = createManifest({
      repositoryHead,
      identity,
      rawReportSha256: artifact.sha256,
      analysis,
    });
    writeBoundedJsonAtomic(manifestPath, manifest, MAX_MANIFEST_BYTES);
    return 0;
  } catch (error) {
    (dependencies.emitError ?? defaultEmitError)(error);
    return 2;
  }
}

export function readCiRetryRequired(manifestPath) {
  return readManifest(requiredResolvedPath(manifestPath, "manifestPath")).retryRequired;
}

export function finalizeCiAttempts(options, dependencies = {}) {
  try {
    const firstReportPath = requiredResolvedPath(options?.firstReportPath, "firstReportPath");
    const firstManifestPath = requiredResolvedPath(options?.firstManifestPath, "firstManifestPath");
    const outputPath = requiredResolvedPath(options?.outputPath, "outputPath");
    const hasSecondReport = options?.secondReportPath !== undefined;
    const hasSecondManifest = options?.secondManifestPath !== undefined;
    if (hasSecondReport !== hasSecondManifest) {
      throw new Error("secondReportPath and secondManifestPath must be supplied together");
    }
    const secondReportPath = hasSecondReport
      ? requiredResolvedPath(options.secondReportPath, "secondReportPath")
      : undefined;
    const secondManifestPath = hasSecondManifest
      ? requiredResolvedPath(options.secondManifestPath, "secondManifestPath")
      : undefined;
    assertDistinctPaths([
      firstReportPath,
      firstManifestPath,
      outputPath,
      ...(secondReportPath === undefined ? [] : [secondReportPath, secondManifestPath]),
    ]);
    rmSync(outputPath, { force: true });

    const resolveRepositoryHead = dependencies.resolveRepositoryHead ?? readRepositoryHead;
    const resolveGithubIdentity = dependencies.resolveGithubIdentity ?? readGithubIdentity;
    const currentHead = requireRepositoryHead(resolveRepositoryHead());
    const finalizerIdentity = validateGithubIdentity(resolveGithubIdentity());
    if (finalizerIdentity.sha !== currentHead) {
      throw new Error("The finalizer GITHUB_SHA does not match repository HEAD");
    }

    const first = readAndValidateArtifact(firstReportPath, firstManifestPath, {
      currentHead,
      finalizerIdentity,
    });
    if (first.analysis.retryRequired !== hasSecondReport) {
      throw new Error(first.analysis.retryRequired
        ? "The required fresh-runner confirmation report is missing"
        : "A second report was supplied even though confirmation was not required");
    }

    let finalReport;
    let exitCode;
    if (!first.analysis.retryRequired) {
      ({ finalReport, exitCode } = finalizeSingleAttempt(first));
    } else {
      const second = readAndValidateArtifact(secondReportPath, secondManifestPath, {
        currentHead,
        finalizerIdentity,
      });
      assertCompatibleAttempts(first.manifest, second.manifest);
      ({ finalReport, exitCode } = finalizeConfirmedAttempts(first, second));
    }

    const serialized = writeBoundedJsonAtomic(outputPath, finalReport, MAX_REPORT_BYTES);
    (dependencies.emitReport ?? defaultEmitReport)(serialized);
    return exitCode;
  } catch (error) {
    (dependencies.emitError ?? defaultEmitError)(error);
    return 2;
  }
}

function analyzeInitialAttempt(report) {
  const assetViolations = report.budgetEvaluation.assetViolations;
  const runtimeViolations = report.budgetEvaluation.runtimeViolations;
  if (assetViolations.length > 0) {
    return {
      retryRequired: false,
      disposition: "hard_failure",
      decision: undefined,
      sampleSupport: undefined,
    };
  }

  const classification = classifyRuntimeViolations(runtimeViolations);
  let sampleSupport;
  if (classification.confirmable.length > 0 && classification.immediate.length === 0) {
    sampleSupport = runtimeSampleSupport(report, classification.confirmable);
  }
  const decision = evaluateRuntimeConfirmation(
    runtimeViolations,
    undefined,
    { first: sampleSupport },
  );
  const disposition = decision.retryRequired
    ? "confirmation_required"
    : decision.finalViolations.length > 0
      ? "hard_failure"
      : decision.status === "not_required"
        ? "clean"
        : "advisory";
  return { retryRequired: decision.retryRequired, disposition, decision, sampleSupport };
}

function analyzeConfirmationAttempt(report) {
  const sampleSupport = runtimeSampleSupport(
    report,
    report.budgetEvaluation.runtimeViolations,
  );
  return { sampleSupport };
}

function createManifest({ repositoryHead, identity, rawReportSha256, analysis }) {
  return {
    schemaVersion: 1,
    kind: "mex-release-benchmark-attempt",
    repositoryHead,
    github: {
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      sha: identity.sha,
    },
    runnerAllocation: {
      job: identity.job,
      runnerName: identity.runnerName,
      runnerOs: identity.runnerOs,
      runnerArch: identity.runnerArch,
    },
    rawReportSha256,
    retryRequired: analysis.retryRequired,
    disposition: analysis.disposition,
  };
}

function readAndValidateArtifact(reportPath, manifestPath, expected) {
  const artifact = readRawReport(reportPath);
  const manifest = readManifest(manifestPath);
  if (manifest.rawReportSha256 !== artifact.sha256) {
    throw new Error("A raw report does not match its manifest digest");
  }
  if (manifest.repositoryHead !== expected.currentHead
    || manifest.github.sha !== expected.currentHead) {
    throw new Error("A benchmark attempt SHA does not match repository HEAD");
  }
  if (manifest.github.runId !== expected.finalizerIdentity.runId
    || BigInt(manifest.github.runAttempt) > BigInt(expected.finalizerIdentity.runAttempt)) {
    throw new Error("Benchmark evidence belongs to a different GitHub run allocation");
  }
  const analysis = analyzeInitialAttempt(artifact.report);
  if (manifest.retryRequired !== analysis.retryRequired
    || manifest.disposition !== analysis.disposition) {
    throw new Error("A manifest does not match the recomputed retry decision");
  }
  return { ...artifact, manifest, analysis };
}

function assertCompatibleAttempts(first, second) {
  if (first.repositoryHead !== second.repositoryHead
    || first.github.sha !== second.github.sha
    || first.github.runId !== second.github.runId) {
    throw new Error("Benchmark attempts do not describe the same GitHub run and repository SHA");
  }
  if (BigInt(first.github.runAttempt) > BigInt(second.github.runAttempt)) {
    throw new Error("Benchmark confirmation predates the first benchmark attempt");
  }
  if (first.runnerAllocation.job === second.runnerAllocation.job) {
    throw new Error("Benchmark confirmation reused the first job allocation");
  }
}

function finalizeSingleAttempt(first) {
  const runtimeViolations = first.report.budgetEvaluation.runtimeViolations;
  if (first.report.budgetEvaluation.assetViolations.length > 0) {
    return {
      finalReport: finalReportFrom(first.report, {
        confirmation: confirmationRecord({
          status: "skipped_immediate_failure",
          repositoryHead: first.manifest.repositoryHead,
          firstPassViolations: runtimeViolations,
          firstManifest: first.manifest,
        }),
        runtimeViolations,
        passed: false,
      }),
      exitCode: 1,
    };
  }

  const decision = first.analysis.decision;
  const passed = decision.finalViolations.length === 0;
  return {
    finalReport: finalReportFrom(first.report, {
      confirmation: confirmationRecord({
        status: decision.status,
        repositoryHead: first.manifest.repositoryHead,
        firstPassViolations: runtimeViolations,
        confirmedViolations: decision.confirmed,
        advisoryAssessments: decision.advisoryAssessments,
        materialAssessments: decision.materialAssessments,
        firstManifest: first.manifest,
      }),
      runtimeViolations: decision.finalViolations,
      passed,
    }),
    exitCode: passed ? 0 : 1,
  };
}

function finalizeConfirmedAttempts(first, second) {
  const secondEvidence = analyzeConfirmationAttempt(second.report);
  const decision = evaluateRuntimeConfirmation(
    first.report.budgetEvaluation.runtimeViolations,
    second.report.budgetEvaluation.runtimeViolations,
    {
      first: first.analysis.sampleSupport,
      second: secondEvidence.sampleSupport,
    },
  );
  const passed = second.report.budgetEvaluation.assetViolations.length === 0
    && decision.finalViolations.length === 0;
  return {
    finalReport: finalReportFrom(second.report, {
      confirmation: confirmationRecord({
        status: passed ? "passed" : "failed",
        repositoryHead: first.manifest.repositoryHead,
        firstPassViolations: first.report.budgetEvaluation.runtimeViolations,
        secondPassViolations: second.report.budgetEvaluation.runtimeViolations,
        confirmedViolations: decision.confirmed,
        advisoryAssessments: decision.advisoryAssessments,
        materialAssessments: decision.materialAssessments,
        firstManifest: first.manifest,
        secondManifest: second.manifest,
      }),
      runtimeViolations: decision.finalViolations,
      passed,
    }),
    exitCode: passed ? 0 : 1,
  };
}

function confirmationRecord({
  status,
  repositoryHead,
  firstPassViolations,
  secondPassViolations = [],
  confirmedViolations = [],
  advisoryAssessments = [],
  materialAssessments = [],
  firstManifest,
  secondManifest,
}) {
  return {
    status,
    repositoryHead,
    firstPassViolations: firstPassViolations.slice(0, MAX_VIOLATIONS),
    secondPassViolations: secondPassViolations.slice(0, MAX_VIOLATIONS),
    confirmedViolations: confirmedViolations.slice(0, MAX_VIOLATIONS),
    advisoryAssessments: advisoryAssessments.slice(0, MAX_VIOLATIONS * 2),
    materialAssessments: materialAssessments.slice(0, MAX_VIOLATIONS),
    runnerAllocations: {
      first: runnerProvenance(firstManifest),
      ...(secondManifest === undefined ? {} : { second: runnerProvenance(secondManifest) }),
    },
  };
}

function runnerProvenance(manifest) {
  return {
    runId: manifest.github.runId,
    runAttempt: manifest.github.runAttempt,
    job: manifest.runnerAllocation.job,
    runnerName: manifest.runnerAllocation.runnerName,
    runnerOs: manifest.runnerAllocation.runnerOs,
    runnerArch: manifest.runnerAllocation.runnerArch,
  };
}

function finalReportFrom(report, { confirmation, runtimeViolations, passed }) {
  const finalReport = structuredClone(report);
  finalReport.budgetEvaluation.runtimeConfirmation = confirmation;
  finalReport.budgetEvaluation.runtimeViolations = runtimeViolations;
  finalReport.budgetEvaluation.passed = passed;
  return finalReport;
}

function readRawReport(path, result) {
  if (result !== undefined
    && ((result.status !== 0 && result.status !== 1) || result.signal !== null)) {
    throw new Error("The raw benchmark did not complete with a report-producing exit status");
  }
  const { value: report, serialized, sha256 } = readBoundedJson(path, MAX_REPORT_BYTES, "raw report");
  if (!isPlainObject(report)
    || report.schemaVersion !== 1
    || report.benchmark !== "mex-release-performance"
    || !isPlainObject(report.environment)
    || report.environment.pinnedBudgetEnvironment !== true
    || !isPlainObject(report.configuration)
    || report.configuration.runtimeBudgetsEnforced !== true
    || report.configuration.assetBudgetsEnforced !== true
    || !isPlainObject(report.budgetEvaluation)
    || !hasExactKeys(report.budgetEvaluation, ["assetViolations", "runtimeViolations", "passed"])
    || !validViolations(report.budgetEvaluation.assetViolations)
    || !validViolations(report.budgetEvaluation.runtimeViolations)
    || typeof report.budgetEvaluation.passed !== "boolean") {
    throw new Error("The raw benchmark report has an invalid bounded shape");
  }
  const expectedPassed = report.budgetEvaluation.assetViolations.length === 0
    && report.budgetEvaluation.runtimeViolations.length === 0;
  if (report.budgetEvaluation.passed !== expectedPassed
    || (result !== undefined && report.budgetEvaluation.passed !== (result.status === 0))) {
    throw new Error("The raw benchmark report disagrees with its budget exit status");
  }
  return { report, serialized, sha256 };
}

function validViolations(value) {
  return Array.isArray(value)
    && value.length <= MAX_VIOLATIONS
    && value.every((violation) => isPlainObject(violation)
      && hasExactKeys(violation, ["metric", "measured", "budget", "reason"])
      && validBoundedString(violation.metric, 256)
      && validOptionalFiniteNumber(violation.measured)
      && validOptionalFiniteNumber(violation.budget)
      && validBoundedString(violation.reason, 100));
}

function validOptionalFiniteNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function readManifest(path) {
  const { value } = readBoundedJson(path, MAX_MANIFEST_BYTES, "attempt manifest");
  if (!isPlainObject(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "repositoryHead",
      "github",
      "runnerAllocation",
      "rawReportSha256",
      "retryRequired",
      "disposition",
    ])
    || value.schemaVersion !== 1
    || value.kind !== "mex-release-benchmark-attempt"
    || !SHA_PATTERN.test(value.repositoryHead)
    || !DIGEST_PATTERN.test(value.rawReportSha256)
    || typeof value.retryRequired !== "boolean"
    || !DISPOSITIONS.has(value.disposition)
    || !validManifestGithub(value.github)
    || !validRunnerAllocation(value.runnerAllocation)
    || value.repositoryHead !== value.github.sha
    || value.retryRequired !== (value.disposition === "confirmation_required")) {
    throw new Error("The release benchmark attempt manifest is invalid");
  }
  return value;
}

function validManifestGithub(value) {
  return isPlainObject(value)
    && hasExactKeys(value, ["runId", "runAttempt", "sha"])
    && GITHUB_NUMBER_PATTERN.test(value.runId)
    && GITHUB_NUMBER_PATTERN.test(value.runAttempt)
    && SHA_PATTERN.test(value.sha);
}

function validRunnerAllocation(value) {
  return isPlainObject(value)
    && hasExactKeys(value, ["job", "runnerName", "runnerOs", "runnerArch"])
    && JOB_PATTERN.test(value.job)
    && validBoundedString(value.runnerName, 256)
    && validBoundedString(value.runnerOs, 32)
    && validBoundedString(value.runnerArch, 32);
}

function validateGithubIdentity(identity) {
  if (!isPlainObject(identity)
    || !hasExactKeys(identity, [
      "runId",
      "runAttempt",
      "sha",
      "job",
      "runnerName",
      "runnerOs",
      "runnerArch",
    ])
    || !validManifestGithub({
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      sha: identity.sha,
    })
    || !validRunnerAllocation({
      job: identity.job,
      runnerName: identity.runnerName,
      runnerOs: identity.runnerOs,
      runnerArch: identity.runnerArch,
    })) {
    throw new Error("The GitHub Actions run identity is missing or invalid");
  }
  return identity;
}

function readGithubIdentity(environment = process.env) {
  return {
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    sha: environment.GITHUB_SHA,
    job: environment.GITHUB_JOB,
    runnerName: environment.RUNNER_NAME,
    runnerOs: environment.RUNNER_OS,
    runnerArch: environment.RUNNER_ARCH,
  };
}

function readRepositoryHead() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function requireRepositoryHead(value) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error("The checked-out repository HEAD could not be resolved");
  }
  return value;
}

function runRawPass(reportPath) {
  const result = spawnSync(process.execPath, [runnerPath, "--output", reportPath], {
    cwd: repositoryRoot,
    env: { ...process.env, MEX_ENFORCE_RELEASE_BUDGETS: "1" },
    stdio: ["inherit", "ignore", "inherit"],
  });
  return { status: result.status, signal: result.signal };
}

function readBoundedJson(path, maximumBytes, label) {
  if (!existsSync(path)) throw new Error(`The ${label} is missing`);
  const size = statSync(path).size;
  if (size <= 0 || size > maximumBytes) throw new Error(`The ${label} exceeds its size bound`);
  const serialized = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error(`The ${label} is not valid JSON`);
  }
  return {
    value,
    serialized,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

function writeBoundedJsonAtomic(path, value, maximumBytes) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > maximumBytes) {
    throw new Error(`A release benchmark output exceeded ${maximumBytes} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return serialized;
}

function requiredResolvedPath(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return resolve(value);
}

function assertDistinctPaths(paths) {
  if (new Set(paths).size !== paths.length) {
    throw new Error("Release benchmark input and output paths must be distinct");
  }
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validBoundedString(value, maximumLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !/[\r\n\0]/u.test(value);
}

function defaultEmitReport(serialized) {
  process.stdout.write(serialized);
}

function defaultEmitError(error) {
  process.stderr.write(`Release benchmark CI orchestration failed operationally: ${errorMessage(error)}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}

function parseArguments(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: "help", options: {} };
  }
  const command = args[0];
  if (!new Set(["attempt", "retry-required", "finalize"]).has(command)) {
    throw new Error(`Unknown release benchmark CI command: ${command}`);
  }
  if (args.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
    return { command: "help", options: {} };
  }
  const definitions = command === "attempt"
    ? { "--report": "reportPath", "--manifest": "manifestPath" }
    : command === "retry-required"
      ? { "--manifest": "manifestPath" }
      : {
          "--first-report": "firstReportPath",
          "--first-manifest": "firstManifestPath",
          "--second-report": "secondReportPath",
          "--second-manifest": "secondManifestPath",
          "--output": "outputPath",
        };
  const required = command === "attempt"
    ? ["reportPath", "manifestPath"]
    : command === "retry-required"
      ? ["manifestPath"]
      : ["firstReportPath", "firstManifestPath", "outputPath"];
  const options = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const name = definitions[flag];
    const value = args[index + 1];
    if (name === undefined) throw new Error(`Unknown ${command} option: ${flag}`);
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a path`);
    if (options[name] !== undefined) throw new Error(`${flag} may only be supplied once`);
    options[name] = value;
  }
  for (const name of required) {
    if (options[name] === undefined) throw new Error(`${name} is required`);
  }
  if ((options.secondReportPath === undefined) !== (options.secondManifestPath === undefined)) {
    throw new Error("--second-report and --second-manifest must be supplied together");
  }
  return { command, options };
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/release-benchmark/ci-orchestrator.mjs attempt --report <raw.json> --manifest <manifest.json>",
    "  node scripts/release-benchmark/ci-orchestrator.mjs retry-required --manifest <manifest.json>",
    "  node scripts/release-benchmark/ci-orchestrator.mjs finalize --first-report <raw.json> --first-manifest <manifest.json> [--second-report <raw.json> --second-manifest <manifest.json>] --output <report.json>",
    "",
    "The attempt command executes exactly one raw pinned benchmark pass.",
    "Finalization requires a distinct GitHub job allocation for a requested confirmation.",
    "",
  ].join("\n");
}

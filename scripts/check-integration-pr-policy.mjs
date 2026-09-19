import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EXPECTED_BASE = "integration/human-team-memory-v1";
const MAIN_REF = "origin/main";
const SHA = /^[a-f0-9]{40,64}$/;

function fail(message) {
  process.stderr.write(`Checkpoint policy failed: ${message}\n`);
  process.exitCode = 1;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}

function isAncestor(ancestor, descendant) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && error.status === 1) return false;
    throw error;
  }
}

function parsePackage(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`${label} package.json is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} package.json is not an object.`);
  }
  return parsed;
}

try {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef !== EXPECTED_BASE) {
    throw new Error(`expected PR base ${EXPECTED_BASE}, received ${baseRef ?? "none"}.`);
  }

  const baseSha = process.env.MEX_POLICY_BASE_SHA;
  if (baseSha === undefined || !SHA.test(baseSha)) {
    throw new Error("MEX_POLICY_BASE_SHA must be the pull request base commit.");
  }

  git(["merge-base", "--is-ancestor", baseSha, "HEAD"]);
  const currentPackage = parsePackage(readFileSync("package.json", "utf8"), "current");
  const basePackage = parsePackage(git(["show", `${baseSha}:package.json`]), "base");

  if (currentPackage.version !== basePackage.version) {
    const mainSha = git(["rev-parse", "--verify", MAIN_REF]).trim();
    const mainPackage = parsePackage(git(["show", `${mainSha}:package.json`]), "main");
    const adoptsNewlyMergedMain = !isAncestor(mainSha, baseSha)
      && isAncestor(mainSha, "HEAD")
      && currentPackage.version === mainPackage.version;
    if (!adoptsNewlyMergedMain) {
      throw new Error(
        `package version changed from ${basePackage.version} to ${currentPackage.version} without adopting the version from a newly merged ${MAIN_REF}.`,
      );
    }
  }
  if (JSON.stringify(currentPackage.exports) !== JSON.stringify(basePackage.exports)) {
    throw new Error("package-root exports changed before the separate semver decision.");
  }

  const changedFiles = git(["diff", "--name-only", `${baseSha}...HEAD`])
    .split("\n")
    .filter(Boolean);
  if (changedFiles.includes("src/index.ts")) {
    throw new Error("src/index.ts changed; internal team contracts must not leak from the package root.");
  }

  const forbiddenReleasePaths = changedFiles.filter((path) => (
    /^\.github\/workflows\/(?:release|publish|deploy)(?:[.-]|$)/i.test(path)
    || /^(?:Dockerfile(?:\..*)?|docker-compose(?:\..*)?\.ya?ml)$/i.test(path)
  ));
  if (forbiddenReleasePaths.length > 0) {
    throw new Error(`release/deployment files are outside checkpoint scope: ${forbiddenReleasePaths.join(", ")}.`);
  }

  const executablePolicyFiles = changedFiles.filter((path) => (
    path === "package.json"
    || path.startsWith(".github/workflows/")
    || (path.startsWith("scripts/") && path !== "scripts/check-integration-pr-policy.mjs")
  ));
  if (executablePolicyFiles.length > 0) {
    const added = git([
      "diff",
      "--unified=0",
      `${baseSha}...HEAD`,
      "--",
      ...executablePolicyFiles,
    ]).split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const dangerous = added.find((line) => (
      /\bnpm\s+(?:publish|version)\b/i.test(line)
      || /\bgh\s+release\b/i.test(line)
      || /\bgit\s+tag\b/i.test(line)
      || /\bdocker\s+(?:build|push)\b/i.test(line)
      || /\b(?:deploy|deployment)\s*:/i.test(line)
    ));
    if (dangerous !== undefined) {
      throw new Error("an executable release, tag, publish, Docker, or deployment action was introduced.");
    }
  }

  process.stdout.write(`Checkpoint policy passed for ${EXPECTED_BASE}.\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : "unknown policy failure");
}

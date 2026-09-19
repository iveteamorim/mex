/**
 * Tests for the acceptance sweep's classifier.
 *
 * The sweep is the artefact that decides whether the tree is good, so its own
 * judgement has to be provoked rather than trusted. Running it end to end from
 * here would mean running the suite from inside the suite; instead the script
 * exports its pure classification and this file feeds it synthetic reports —
 * which is the only way to produce a `REGRESSION` verdict on demand, since a
 * real regression is exactly what the repository does not have.
 *
 * The verdict that matters most is the third one. A baseline entry excuses a
 * *mechanism*, not a filename, so an assertion failure inside a file that is
 * allowed to time out must still come back as a regression. That is the hole a
 * filename-only allowlist would have.
 */

import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SWEEP = pathToFileURL(join(REPO_ROOT, "scripts", "wiki-acceptance-sweep.mjs")).href;

interface Sweep {
  BASELINE: readonly { file: string; signature: RegExp; why: string }[];
  ENVIRONMENTAL: RegExp;
  classify(failure: { file: string; test: string; message: string }): string;
  failuresOf(report: unknown): { file: string; test: string; message: string }[];
  summarize(report: unknown): {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    files: number;
    failures: { file: string; test: string; message: string; verdict: string }[];
  };
  fingerprint(summary: { failures: { verdict: string; file: string; test: string }[] }): string;
}

const sweep = (await import(SWEEP)) as unknown as Sweep;

function failure(file: string, message: string, test = "some test"): { file: string; test: string; message: string } {
  return { file, test, message };
}

describe("the sweep's failure classifier", () => {
  it("has a baseline that names real files, each with a reason", () => {
    expect(sweep.BASELINE.length).toBeGreaterThan(0);
    for (const entry of sweep.BASELINE) {
      expect(entry.file, "a baseline entry must name a path").toMatch(/\.test\.ts$/);
      expect(entry.why.length, `${entry.file} needs a reason, not just an exemption`).toBeGreaterThan(20);
      expect(entry.signature.source.length).toBeGreaterThan(0);
    }
  });

  it("calls a declared file failing for its declared reason STANDING", () => {
    expect(
      sweep.classify(failure("test/graph-integration.test.ts", "Error: Test timed out in 10000ms.")),
    ).toBe("STANDING");
    expect(
      sweep.classify(failure("src/graph/__tests__/cli-agent.test.ts", "Error: EPERM, Permission denied: C:\\Temp\\x")),
    ).toBe("STANDING");
    expect(
      sweep.classify(
        failure("test/config.test.ts", "AssertionError: Scaffold directory exists but looks incomplete"),
      ),
    ).toBe("STANDING");
  });

  it("calls an assertion failure inside a baseline file a REGRESSION", () => {
    // The whole point of pairing a signature with the filename. Under a
    // filename-only allowlist this returns STANDING and a real break ships.
    expect(
      sweep.classify(failure("test/graph-integration.test.ts", "AssertionError: expected 3 to be 4")),
    ).toBe("REGRESSION");
  });

  it("calls an undeclared file's timeout NEW-ENVIRONMENTAL rather than forgiving it", () => {
    const verdict = sweep.classify(failure("src/wiki/index/__tests__/perf.test.ts", "Error: Test timed out in 60000ms."));
    expect(verdict).toBe("NEW-ENVIRONMENTAL");
    expect(verdict).not.toBe("STANDING");
  });

  it("calls an ordinary wiki assertion failure a REGRESSION", () => {
    expect(
      sweep.classify(failure("src/wiki/service/__tests__/hub.test.ts", "AssertionError: expected [] to have length 2")),
    ).toBe("REGRESSION");
  });

  it("excuses both faces of the built-CLI suite's environmental failure", () => {
    // That file fails two different ways depending on whether a `npm run build`
    // inside its `beforeAll` beats the hook timeout. Either is environmental,
    // and a baseline naming only the timeout would call the other a regression
    // — which is exactly what it did on the first full sweep of this phase.
    expect(sweep.classify(failure("test/cli.test.ts", "Error: Hook timed out in 10000ms."))).toBe("STANDING");
    expect(
      sweep.classify(
        failure(
          "test/cli.test.ts",
          "AssertionError: expected 1 to be +0 // Object.is equality",
          "built CLI main-module guard backfills scaffold_id on an existing scaffold when a command loads config",
        ),
      ),
    ).toBe("STANDING");
    // But an unrelated assertion in that same file is still a regression: the
    // exemption is for two named mechanisms, not for the filename.
    expect(
      sweep.classify(failure("test/cli.test.ts", "AssertionError: expected 'a' to be 'b'")),
    ).toBe("REGRESSION");
  });

  it("matches a baseline file however the runner spelled its path", () => {
    // Vitest reports absolute, backslashed paths on Windows; `failuresOf`
    // normalizes, and the matcher is a suffix test so both spellings land.
    expect(sweep.classify(failure("test/cli.test.ts", "Error: Hook timed out in 10000ms."))).toBe("STANDING");
    expect(
      sweep.classify(failure("C:/Users/x/mex/test/cli.test.ts", "Error: Hook timed out in 10000ms.")),
    ).toBe("STANDING");
  });
});

describe("the sweep's report reader", () => {
  const report = {
    numTotalTests: 5,
    numPassedTests: 3,
    numFailedTests: 2,
    numPendingTests: 0,
    testResults: [
      {
        name: "C:\\Users\\x\\mex\\test\\alpha.test.ts",
        status: "failed",
        message: "",
        assertionResults: [
          { fullName: "alpha > works", status: "passed", failureMessages: [] },
          { fullName: "alpha > breaks", status: "failed", failureMessages: ["AssertionError: nope\n  at line 3"] },
        ],
      },
      {
        name: "C:\\Users\\x\\mex\\test\\beta.test.ts",
        status: "failed",
        message: "Error: EPERM, Permission denied: C:\\Temp\\beta\n  at rmSync",
        assertionResults: [],
      },
      {
        name: "C:\\Users\\x\\mex\\test\\gamma.test.ts",
        status: "passed",
        assertionResults: [{ fullName: "gamma > fine", status: "passed", failureMessages: [] }],
      },
    ],
  };

  it("finds both a test-level failure and a file-level one", () => {
    const found = sweep.failuresOf(report);
    expect(found.map((entry) => entry.test)).toEqual(["alpha > breaks", "(file-level)"]);
    expect(found[0]!.message).toBe("AssertionError: nope");
    expect(found[1]!.message).toContain("EPERM");
  });

  it("does not invent a file-level failure for a file whose tests failed", () => {
    // A file is "failed" because a test in it failed. Reporting that twice —
    // once as the test and once as the file — would double-count every
    // ordinary failure and make the sweep's own numbers wrong.
    const found = sweep.failuresOf(report);
    expect(found.filter((entry) => entry.file.endsWith("alpha.test.ts"))).toHaveLength(1);
  });

  it("counts files rather than describe blocks", () => {
    // `numTotalTestSuites` counts describe blocks; every gate this project has
    // recorded is stated in files. Reading the wrong field turned 52 into 337.
    expect(sweep.summarize(report).files).toBe(3);
  });

  it("carries the run's arithmetic through unchanged", () => {
    const summary = sweep.summarize(report);
    expect(summary).toMatchObject({ total: 5, passed: 3, failed: 2, skipped: 0 });
  });

  it("fingerprints two runs the same only when they failed the same way", () => {
    const first = sweep.summarize(report);
    const second = sweep.summarize(report);
    expect(sweep.fingerprint(first)).toBe(sweep.fingerprint(second));

    const extra = {
      ...report,
      testResults: [
        ...report.testResults,
        {
          name: "C:\\Users\\x\\mex\\test\\delta.test.ts",
          status: "failed",
          message: "Error: Test timed out in 60000ms.",
          assertionResults: [],
        },
      ],
    };
    expect(sweep.fingerprint(sweep.summarize(extra))).not.toBe(sweep.fingerprint(first));
  });

  it("survives a report with no results at all", () => {
    // A vitest crash can produce a shell of a report. The sweep must say
    // "nothing ran" rather than throw and be read as "nothing failed".
    const summary = sweep.summarize({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0 });
    expect(summary.failures).toEqual([]);
    expect(summary.files).toBe(0);
  });
});

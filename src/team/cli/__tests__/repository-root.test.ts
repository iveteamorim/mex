import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MexPortError } from "../../contracts/shared.js";
import { locateTeamRepositoryRoot } from "../repository-root.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Team CLI repository locator", () => {
  it("finds a repository from a nested directory without opening scaffold config", () => {
    const root = temporaryRoot();
    const nested = join(root, "src", "nested");
    mkdirSync(join(root, ".git"));
    mkdirSync(nested, { recursive: true });

    expect(locateTeamRepositoryRoot(nested)).toBe(root);
  });

  it("returns a typed unavailable problem outside Git", () => {
    const root = temporaryRoot();
    expectProblem(() => locateTeamRepositoryRoot(root), "NOT_FOUND");
  });

  it("rejects a symbolic-link Git boundary", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    symlinkSync(outside, join(root, ".git"));

    expectProblem(() => locateTeamRepositoryRoot(root), "PATH_OUTSIDE_PROJECT");
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-team-root-"));
  roots.push(root);
  return root;
}

function expectProblem(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MexPortError);
    expect((error as MexPortError).problem.code).toBe(code);
  }
}

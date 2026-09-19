import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MexPortError } from "../../contracts/shared.js";
import { RepositoryRootGuard } from "../repository-root.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RepositoryRootGuard", () => {
  it("accepts a stable physical checkout", () => {
    const root = temporaryRoot();
    const guard = new RepositoryRootGuard(root);
    expect(() => guard.assertCurrent()).not.toThrow();
    expect(guard.path).toBe(realpathSync(root));
  });

  it("rejects a caller root symlink retargeted after binding", () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const holder = temporaryRoot();
    const link = join(holder, "repository");
    symlinkSync(first, link, "dir");
    const guard = new RepositoryRootGuard(link);

    unlinkSync(link);
    symlinkSync(second, link, "dir");
    expect(() => guard.assertCurrent()).toThrowError(MexPortError);
  });

  it("rejects a physical checkout replaced at the same path", () => {
    const holder = temporaryRoot();
    const root = join(holder, "repository");
    const moved = join(holder, "moved");
    mkdirSync(root);
    const guard = new RepositoryRootGuard(root);

    renameSync(root, moved);
    mkdirSync(root);
    expect(() => guard.assertCurrent()).toThrowError(MexPortError);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-workflow-root-"));
  roots.push(root);
  return root;
}

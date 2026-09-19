import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findScaffoldFiles } from "../src/drift/index.js";

let root: string;
let scaffoldRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-scaffold-discovery-"));
  scaffoldRoot = join(root, ".mex");
  mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  mkdirSync(join(scaffoldRoot, "patterns"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function linkOrSkip(target: string, path: string, ctx: TestContext): void {
  try {
    symlinkSync(target, path);
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      ctx.skip("Symlink creation requires Windows privileges");
      return;
    }
    throw error;
  }
}

describe("scaffold discovery", () => {
  it("deduplicates overlapping patterns without dropping distinct files", () => {
    writeFileSync(join(scaffoldRoot, "context/one.md"), "# One\n");
    writeFileSync(join(scaffoldRoot, "context/two.md"), "# Two\n");
    const files = findScaffoldFiles(root, scaffoldRoot, ["context/*.md", "context/one.md"]);
    expect(files).toHaveLength(2);
    expect(new Set(files.map((file) => realpathSync(file))).size).toBe(2);
  });

  it("deduplicates aliases across scaffold patterns", (ctx) => {
    const target = join(scaffoldRoot, "context/architecture.md");
    writeFileSync(target, "# Architecture\n");
    linkOrSkip(target, join(scaffoldRoot, "patterns/architecture.md"), ctx);
    const files = findScaffoldFiles(root, scaffoldRoot);
    expect(files).toHaveLength(1);
    expect(files.map((file) => realpathSync(file))).toEqual([realpathSync(target)]);
  });

  it("deduplicates root tool aliases against scaffold files", (ctx) => {
    const target = join(scaffoldRoot, "AGENTS.md");
    writeFileSync(target, "# Agents\n");
    writeFileSync(join(root, ".windsurfrules"), "# Independent tool config\n");
    linkOrSkip(target, join(root, "CLAUDE.md"), ctx);
    linkOrSkip(target, join(root, ".cursorrules"), ctx);
    const files = findScaffoldFiles(root, scaffoldRoot);
    expect(files).toHaveLength(2);
    expect(files.map((file) => realpathSync(file))).toEqual([
      realpathSync(target),
      realpathSync(join(root, ".windsurfrules")),
    ]);
  });

  it("deduplicates aliases between root tool files", (ctx) => {
    const target = join(root, "CLAUDE.md");
    writeFileSync(target, "# Tool config\n");
    linkOrSkip(target, join(root, ".cursorrules"), ctx);
    const files = findScaffoldFiles(root, scaffoldRoot);
    expect(files).toHaveLength(1);
    expect(files.map((file) => realpathSync(file))).toEqual([realpathSync(target)]);
  });
});

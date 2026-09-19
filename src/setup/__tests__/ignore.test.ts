import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSetupIgnoreProtection,
  renderSetupIgnoreProtection,
  SetupIgnoreProtectionError,
  verifySetupIgnoreProtection,
} from "../ignore.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup local-data ignore protection", () => {
  it("creates .mex/.gitignore with all required rules", () => {
    const root = fixture();

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result).toEqual({
      path: ".mex/.gitignore",
      action: "create",
      dryRun: false,
      applied: true,
      changed: true,
      addedRules: ["graph.db*", "wiki.db*", "local/"],
    });
    expect(readIgnore(root)).toBe("graph.db*\nwiki.db*\nlocal/\n");
    expect(renderSetupIgnoreProtection(result)).toBe(
      "Created .mex/.gitignore with graph.db*, wiki.db*, local/",
    );
  });

  it("preserves existing content and appends only missing rules", () => {
    const root = fixtureWithMex();
    writeIgnore(root, "# User rule\ngraph.db*\n*.scratch\n");

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result).toMatchObject({
      action: "update",
      addedRules: ["wiki.db*", "local/"],
    });
    expect(readIgnore(root)).toBe(
      "# User rule\ngraph.db*\n*.scratch\nwiki.db*\nlocal/\n",
    );
  });

  it("uses the existing CRLF style for appended rules", () => {
    const root = fixtureWithMex();
    const before = "# User rule\r\ngraph.db*\r\n";
    writeIgnore(root, before);

    ensureSetupIgnoreProtection({ projectRoot: root });

    expect(readIgnore(root)).toBe(`${before}wiki.db*\r\nlocal/\r\n`);
  });

  it("adds one separator when an existing file has no final newline", () => {
    const root = fixtureWithMex();
    writeIgnore(root, "# User rule");

    ensureSetupIgnoreProtection({ projectRoot: root });

    expect(readIgnore(root)).toBe(
      "# User rule\ngraph.db*\nwiki.db*\nlocal/\n",
    );
  });

  it("retains existing duplicate lines without adding another required rule", () => {
    const root = fixtureWithMex();
    const before = "graph.db*\ngraph.db*\nwiki.db*\n";
    writeIgnore(root, before);

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result.addedRules).toEqual(["local/"]);
    expect(readIgnore(root)).toBe(`${before}local/\n`);
  });

  it("is a byte-preserving no-op on rerun", () => {
    const root = fixture();
    ensureSetupIgnoreProtection({ projectRoot: root });
    const afterFirstRun = readFileSync(join(root, ".mex/.gitignore"));

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result).toMatchObject({
      action: "unchanged",
      applied: false,
      changed: false,
      addedRules: [],
    });
    expect(readFileSync(join(root, ".mex/.gitignore"))).toEqual(afterFirstRun);
  });

  it("reports a dry run without creating files", () => {
    const root = fixture();

    const result = ensureSetupIgnoreProtection({ projectRoot: root, dryRun: true });

    expect(result).toMatchObject({
      action: "create",
      dryRun: true,
      applied: false,
      changed: true,
    });
    expect(existsSync(join(root, ".mex"))).toBe(false);
    expect(renderSetupIgnoreProtection(result)).toContain("Would create");
  });

  it("fails closed when .mex/.gitignore is a symlink", () => {
    const root = fixtureWithMex();
    const outside = join(fixture(), "outside.gitignore");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(root, ".mex/.gitignore"), "file");

    expect(() => ensureSetupIgnoreProtection({ projectRoot: root })).toThrow(
      SetupIgnoreProtectionError,
    );
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("fails closed when .mex/.gitignore is not a regular file", () => {
    const root = fixtureWithMex();
    mkdirSync(join(root, ".mex/.gitignore"));

    expect(() => ensureSetupIgnoreProtection({ projectRoot: root })).toThrow(
      SetupIgnoreProtectionError,
    );
  });

  it("verifies derived files are ignored and canonical config remains trackable", () => {
    const root = fixture();
    initGit(root);
    ensureSetupIgnoreProtection({ projectRoot: root });

    expect(() => verifySetupIgnoreProtection(root)).not.toThrow();
  });

  it("rejects a broad root rule that hides canonical MEX files", () => {
    const root = fixture();
    initGit(root);
    ensureSetupIgnoreProtection({ projectRoot: root });
    writeFileSync(join(root, ".gitignore"), ".mex/\n", "utf8");

    expect(() => verifySetupIgnoreProtection(root)).toThrow(/hides \.mex\/config\.json/u);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-ignore-"));
  roots.push(root);
  return root;
}

function fixtureWithMex(): string {
  const root = fixture();
  mkdirSync(join(root, ".mex"));
  return root;
}

function writeIgnore(root: string, content: string): void {
  writeFileSync(join(root, ".mex/.gitignore"), content, "utf8");
}

function readIgnore(root: string): string {
  return readFileSync(join(root, ".mex/.gitignore"), "utf8");
}

function initGit(root: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
}

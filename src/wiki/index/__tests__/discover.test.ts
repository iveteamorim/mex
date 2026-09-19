import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMarkdownFiles, escapedSymlinkDiagnostic, globToRegExp, matchesAnyGlob } from "../discover.js";
import { WIKI_CORPUS_LIMITS, WikiCorpusLimitError } from "../corpus-policy.js";
import { DEFAULT_WIKI_EXCLUDE, DEFAULT_WIKI_READ_ONLY } from "../../../config.js";
import { createScaffold, type Scaffold } from "./harness.js";

describe("glob matching", () => {
  it("crosses separators for ** and stops at one for *", () => {
    expect(globToRegExp("**/node_modules/**").test("node_modules/x.md")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("a/b/node_modules/x.md")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("a/nodes/x.md")).toBe(false);
    expect(globToRegExp("team/**").test("team/a/b.md")).toBe(true);
    expect(globToRegExp("team/**").test("teams/a.md")).toBe(false);
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
  });

  it("treats dots as literals rather than as any-character", () => {
    expect(globToRegExp("notes.md").test("notesXmd")).toBe(false);
  });

  it("matches D10's default lists against the paths they are meant to cover", () => {
    expect(matchesAnyGlob("node_modules/pkg/readme.md", [...DEFAULT_WIKI_EXCLUDE])).toBe(true);
    expect(matchesAnyGlob("context/architecture.md", [...DEFAULT_WIKI_EXCLUDE])).toBe(false);
    for (const prefix of ["team", "workstreams", "inbox", "relays"]) {
      expect(matchesAnyGlob(`${prefix}/anything.md`, [...DEFAULT_WIKI_READ_ONLY]), prefix).toBe(true);
    }
    expect(matchesAnyGlob("context/architecture.md", [...DEFAULT_WIKI_READ_ONLY])).toBe(false);
  });
});

describe("discovery", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("returns Markdown in sorted, scaffold-relative POSIX order", () => {
    scaffold = createScaffold();
    // Written in an order that is not the sorted order, so a walk that returned
    // filesystem order would produce a different list.
    scaffold.write("zeta.md", "# Z\n");
    scaffold.write("context/architecture.md", "# A\n");
    scaffold.write("alpha.md", "# A\n");
    scaffold.write("context/nested/deep.md", "# D\n");
    scaffold.write("notes.txt", "not markdown");
    scaffold.write("README.MDX", "# Uppercase extension\n");

    const result = discoverMarkdownFiles({ root: scaffold.root });
    expect(result.files.map((file) => file.path)).toEqual([
      "README.MDX",
      "alpha.md",
      "context/architecture.md",
      "context/nested/deep.md",
      "zeta.md",
    ]);
    expect(result.files.every((file) => !file.path.includes("\\"))).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("applies exclusions, and prunes the directories they cover", () => {
    scaffold = createScaffold();
    scaffold.write("keep.md", "# Keep\n");
    scaffold.write("node_modules/pkg/readme.md", "# Vendored\n");
    scaffold.write("vendor/deep/notes.md", "# Vendored\n");

    const result = discoverMarkdownFiles({
      root: scaffold.root,
      exclude: [...DEFAULT_WIKI_EXCLUDE, "vendor/**"],
    });
    expect(result.files.map((file) => file.path)).toEqual(["keep.md"]);
  });

  it("reports a symlink that escapes the scaffold rather than following it", () => {
    scaffold = createScaffold();
    const outside = join(scaffold.root, "..", `outside-${process.pid}.md`);
    writeFileSync(outside, "# Outside\n", "utf-8");
    scaffold.write("inside.md", "# Inside\n");

    let linked = true;
    try {
      symlinkSync(outside, join(scaffold.root, "escape.md"), "file");
    } catch {
      // Windows refuses symlinks without developer mode. The rule is asserted
      // unconditionally below through the function the walk calls.
      linked = false;
    }

    if (linked) {
      const result = discoverMarkdownFiles({ root: scaffold.root });
      expect(result.files.map((file) => file.path)).toEqual(["inside.md"]);
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(["PATH_OUTSIDE_SCAFFOLD"]);
    }

    const reported = escapedSymlinkDiagnostic("escape.md", "/somewhere/else.md");
    expect(reported.code).toBe("PATH_OUTSIDE_SCAFFOLD");
    expect(reported.file).toBe("escape.md");
    expect(reported.message).toContain("outside the scaffold");
  });

  it("reports a directory it cannot read instead of throwing", () => {
    scaffold = createScaffold();
    const missing = join(scaffold.root, "gone");
    mkdirSync(missing);
    scaffold.write("gone/a.md", "# A\n");
    // Read the real tree first, then point the walk at a path that vanished.
    expect(discoverMarkdownFiles({ root: missing }).files).toHaveLength(1);
    const result = discoverMarkdownFiles({ root: join(scaffold.root, "never-existed") });
    expect(result.files).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["WIKI_PARSE_ERROR"]);
  });

  it("fails closed when directory depth exceeds the corpus ceiling", () => {
    scaffold = createScaffold();
    const path = `${Array.from(
      { length: WIKI_CORPUS_LIMITS.maxDirectoryDepth + 1 },
      (_, index) => `d${index}`,
    ).join("/")}/too-deep.md`;
    scaffold.write(path, "# Too deep\n");

    expect(() => discoverMarkdownFiles({ root: scaffold!.root }))
      .toThrow(WikiCorpusLimitError);
  });
});

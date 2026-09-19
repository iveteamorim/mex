import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeSetupWiki } from "../wiki-finalize.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can briefly retain a just-closed SQLite handle.
    }
  }
});

describe("setup Wiki finalization", () => {
  it("plans, migrates, rebuilds, validates, and reports abstentions", async () => {
    const { projectRoot, scaffoldRoot } = legacyScaffold();
    const progress: string[] = [];
    const warnings: string[] = [];

    const result = await finalizeSetupWiki({
      projectRoot,
      scaffoldRoot,
      onProgress: (message) => progress.push(message),
      onWarning: (message) => warnings.push(message),
    });

    expect(result).toMatchObject({
      ready: true,
      stage: "complete",
      reason: null,
      migrated: true,
      plannedEntities: 1,
      indexedEntities: 1,
      entitiesChecked: 1,
      abstentions: 1,
      warningCount: 1,
    });
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(readFileSync(join(scaffoldRoot, "context", "setup.md"), "utf8")).toContain("mex:");
    expect(existsSync(join(scaffoldRoot, "wiki.db"))).toBe(true);
    expect(warnings[0]).toContain("notes.md");
    expect(progress).toEqual([
      "Planning Wiki migration...",
      "Applying Wiki migration...",
      "Rebuilding Wiki index...",
      "Validating Wiki scaffold...",
      "Wiki migration and index are ready.",
    ]);
  });

  it("is safe to rerun without changing canonical files or the operation log", async () => {
    const { projectRoot, scaffoldRoot } = legacyScaffold(false);
    const first = await finalizeSetupWiki({ projectRoot, scaffoldRoot });
    expect(first.ready).toBe(true);

    const canonicalPath = join(scaffoldRoot, "context", "setup.md");
    const logPath = join(scaffoldRoot, "events", "operations.jsonl");
    const canonicalBefore = readFileSync(canonicalPath, "utf8");
    const logBefore = readFileSync(logPath, "utf8");

    const second = await finalizeSetupWiki({ projectRoot, scaffoldRoot });

    expect(second).toMatchObject({
      ready: true,
      stage: "complete",
      migrated: false,
      plannedEntities: 0,
      indexedEntities: 1,
      entitiesChecked: 1,
    });
    expect(readFileSync(canonicalPath, "utf8")).toBe(canonicalBefore);
    expect(readFileSync(logPath, "utf8")).toBe(logBefore);
  });

  it("refuses a blocked dry run before migration or index writes", async () => {
    const projectRoot = fixture();
    const scaffoldRoot = join(projectRoot, ".mex");
    const brokenPath = join(scaffoldRoot, "context", "setup.md");
    mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
    writeFileSync(
      brokenPath,
      [
        "<!-- mex:entity",
        "id: not-an-entity-id",
        "type: guide",
        "status: promoted",
        "revision: 1",
        "-->",
        "# Broken setup",
        "",
        "This entity cannot be indexed safely.",
        "",
      ].join("\n"),
      "utf8",
    );
    const before = readFileSync(brokenPath, "utf8");
    const progress: string[] = [];

    const result = await finalizeSetupWiki({
      projectRoot,
      scaffoldRoot,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      ready: false,
      stage: "plan",
      migrated: false,
      indexedEntities: 0,
    });
    expect(result.reason).toContain("blocked");
    expect(result.diagnostics.some((entry) => entry.severity === "error")).toBe(true);
    expect(readFileSync(brokenPath, "utf8")).toBe(before);
    expect(existsSync(join(scaffoldRoot, "events", "operations.jsonl"))).toBe(false);
    expect(existsSync(join(scaffoldRoot, "wiki.db"))).toBe(false);
    expect(progress).toEqual(["Planning Wiki migration..."]);
  });

  it("honors configured read-only paths during migration", async () => {
    const { projectRoot, scaffoldRoot } = legacyScaffold(false);
    const canonicalPath = join(scaffoldRoot, "context", "setup.md");
    const before = readFileSync(canonicalPath, "utf8");

    const result = await finalizeSetupWiki({
      projectRoot,
      scaffoldRoot,
      readOnly: ["context/**"],
    });

    expect(result.ready).toBe(false);
    expect(result.stage).toBe("migration");
    expect(readFileSync(canonicalPath, "utf8")).toBe(before);
    expect(existsSync(join(scaffoldRoot, "wiki.db"))).toBe(false);
  });

  it("uses configured exclusions for both migration and indexing", async () => {
    const { projectRoot, scaffoldRoot } = legacyScaffold(false);
    const canonicalPath = join(scaffoldRoot, "context", "setup.md");
    const before = readFileSync(canonicalPath, "utf8");

    const result = await finalizeSetupWiki({
      projectRoot,
      scaffoldRoot,
      exclude: ["context/**"],
    });

    expect(result).toMatchObject({ ready: true, plannedEntities: 0, indexedEntities: 0 });
    expect(readFileSync(canonicalPath, "utf8")).toBe(before);
  });
});

function legacyScaffold(withAbstention = true): { projectRoot: string; scaffoldRoot: string } {
  const projectRoot = fixture();
  const scaffoldRoot = join(projectRoot, ".mex");
  mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  writeFileSync(
    join(scaffoldRoot, "context", "setup.md"),
    [
      "---",
      "name: setup",
      "description: Preparing a machine to work on this project.",
      "---",
      "# Setup",
      "",
      "Install dependencies before running the project locally.",
      "",
    ].join("\n"),
    "utf8",
  );
  if (withAbstention) {
    writeFileSync(
      join(scaffoldRoot, "notes.md"),
      "# Scratch notes\n\nThis file has no migration classification rule.\n",
      "utf8",
    );
  }
  return { projectRoot, scaffoldRoot };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-wiki-finalize-"));
  roots.push(root);
  return root;
}

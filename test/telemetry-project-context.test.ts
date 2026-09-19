import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readTelemetryProjectContext } from "../src/telemetry/project-context.js";

const SCAFFOLD_ID = "685f71c3-b91b-4fe1-8376-c8944829cacd";
let directory: string;

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "mex-telemetry-context-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function project(name: string, config?: unknown, git: "directory" | "file" | false = "directory"): string {
  const root = join(directory, name);
  mkdirSync(join(root, ".mex"), { recursive: true });
  if (git === "directory") mkdirSync(join(root, ".git"));
  if (git === "file") writeFileSync(join(root, ".git"), "gitdir: /private/worktree/metadata\n");
  if (config !== undefined) writeFileSync(join(root, ".mex", "config.json"), JSON.stringify(config));
  return root;
}

function snapshot(root: string): unknown[] {
  const entries: unknown[] = [];
  function walk(path: string): void {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const info = lstatSync(child, { bigint: true });
      entries.push([relative(root, child), info.mode, info.ino, info.size, info.mtimeNs, info.ctimeNs,
        info.isFile() ? readFileSync(child).toString("base64") : null]);
      if (info.isDirectory()) walk(child);
    }
  }
  walk(root);
  return entries;
}

describe("bounded read-only project telemetry context", () => {
  it("projects only an existing UUID and sorted unique configured tool names", () => {
    const root = project("complete", {
      scaffold_id: SCAFFOLD_ID, scaffold_name: "private-project", origin: "git@private/repository",
      aiTools: ["windsurf", "cursor", "codex", "claude", "copilot", "opencode", "codex", "private-agent", { email: "private@example.com" }, 8],
      identity: { name: "private-person" }, arbitrary: "private-context",
    });
    expect(readTelemetryProjectContext(root)).toEqual({
      scaffold_id: SCAFFOLD_ID,
      configured_ai_tools: ["claude", "codex", "copilot", "cursor", "opencode", "windsurf"],
    });
  });

  it("reads the nearest Git project from nested directories, ignoring a nested loose scaffold", () => {
    const root = project("parent", { scaffold_id: SCAFFOLD_ID, aiTools: ["codex"] });
    const nested = join(root, "src", "feature");
    mkdirSync(join(nested, ".mex"), { recursive: true });
    writeFileSync(join(nested, ".mex", "config.json"), JSON.stringify({ aiTools: ["cursor"] }));
    expect(readTelemetryProjectContext(nested)).toEqual({ scaffold_id: SCAFFOLD_ID, configured_ai_tools: ["codex"] });
    mkdirSync(join(nested, ".git"));
    expect(readTelemetryProjectContext(nested)).toEqual({ configured_ai_tools: ["cursor"] });
  });

  it("reads only the supplied root in exact mode even inside another Git project", () => {
    const root = project("exact-parent", { scaffold_id: SCAFFOLD_ID, aiTools: ["codex"] });
    const nested = join(root, "nested");
    mkdirSync(join(nested, ".mex"), { recursive: true });
    writeFileSync(join(nested, ".mex", "config.json"), JSON.stringify({ aiTools: ["cursor"] }));
    expect(readTelemetryProjectContext(nested)).toEqual({ scaffold_id: SCAFFOLD_ID, configured_ai_tools: ["codex"] });
    expect(readTelemetryProjectContext(nested, "exact")).toEqual({ configured_ai_tools: ["cursor"] });
  });

  it("omits missing exact-root configuration instead of falling back to the containing project", () => {
    const root = project("exact-missing", { scaffold_id: SCAFFOLD_ID, aiTools: ["codex"] });
    const nested = join(root, "src");
    mkdirSync(nested);
    expect(readTelemetryProjectContext(nested, "exact")).toEqual({});
    mkdirSync(join(nested, ".mex"));
    expect(readTelemetryProjectContext(nested, "exact")).toEqual({});
    expect(readTelemetryProjectContext(nested)).toEqual({ scaffold_id: SCAFFOLD_ID, configured_ai_tools: ["codex"] });
  });

  it("recognizes a worktree .git file without following or exposing its content", () => {
    const root = project("worktree", { aiTools: ["claude"] }, "file");
    expect(readTelemetryProjectContext(root)).toEqual({ configured_ai_tools: ["claude"] });
  });

  it("supports a non-Git scaffold at the supplied directory without searching ancestor scaffolds", () => {
    const root = project("loose", { aiTools: ["codex"] }, false);
    expect(readTelemetryProjectContext(root)).toEqual({ configured_ai_tools: ["codex"] });
    const nested = join(root, "src");
    mkdirSync(nested);
    expect(readTelemetryProjectContext(nested)).toEqual({});
  });

  it("keeps explicit empty selections distinct from missing or unsupported selections", () => {
    expect(readTelemetryProjectContext(project("empty", { aiTools: [] }))).toEqual({ configured_ai_tools: [] });
    expect(readTelemetryProjectContext(project("unknown", { aiTools: ["custom-agent", "CODEX"] }))).toEqual({});
    expect(readTelemetryProjectContext(project("missing", {}))).toEqual({});
  });

  it.each([null, "codex", 1, { tool: "codex" }])("omits malformed selection %j independently of a valid UUID", (aiTools) => {
    const root = project("invalid-tools", { scaffold_id: SCAFFOLD_ID, aiTools });
    expect(readTelemetryProjectContext(root)).toEqual({ scaffold_id: SCAFFOLD_ID });
  });

  it.each([null, "private@example.com", "/private/repository", "685f71c3-b91b-1fe1-8376-c8944829cacd", `${SCAFFOLD_ID}\n`, 42])(
    "omits invalid identity %j independently of valid tools", (scaffold_id) => {
      const root = project("invalid-id", { scaffold_id, aiTools: ["codex"] });
      expect(readTelemetryProjectContext(root)).toEqual({ configured_ai_tools: ["codex"] });
    },
  );

  it.each(["{", "null", "[]", '"codex"', '{"aiTools":["codex"]}\ntrailing', Buffer.from([0x7b, 0xff, 0x7d])])(
    "quietly omits malformed JSON or non-UTF8 configuration %#", (bytes) => {
      const root = project("invalid-json");
      writeFileSync(join(root, ".mex", "config.json"), bytes);
      expect(readTelemetryProjectContext(root)).toEqual({});
    },
  );

  it("accepts the byte limit and rejects even one excess byte", () => {
    const root = project("bounded");
    const path = join(root, ".mex", "config.json");
    const raw = JSON.stringify({ aiTools: ["codex"] });
    writeFileSync(path, raw.padEnd(64 * 1024, " "));
    expect(readTelemetryProjectContext(root)).toEqual({ configured_ai_tools: ["codex"] });
    writeFileSync(path, raw.padEnd(64 * 1024 + 1, " "));
    expect(readTelemetryProjectContext(root)).toEqual({});
  });

  it("bounds ancestor discovery and avoids misattributing a deeper project", () => {
    const root = project("deep", { aiTools: ["codex"] });
    const nested = join(root, ...Array.from({ length: 64 }, () => "d"));
    mkdirSync(nested, { recursive: true });
    expect(readTelemetryProjectContext(nested)).toEqual({});
  });

  it("does not create, mint, repair, or modify configuration or scaffold files", () => {
    const present = project("present", { aiTools: ["codex"] });
    const absent = project("absent");
    const missingScaffold = join(directory, "uninitialized");
    mkdirSync(join(missingScaffold, ".git"), { recursive: true });
    const before = snapshot(directory);
    expect(readTelemetryProjectContext(present)).toEqual({ configured_ai_tools: ["codex"] });
    expect(readTelemetryProjectContext(absent)).toEqual({});
    expect(readTelemetryProjectContext(missingScaffold)).toEqual({});
    expect(readTelemetryProjectContext(join(directory, "missing"))).toEqual({});
    expect(snapshot(directory)).toEqual(before);
  });

  it("returns fresh snapshots without caching or sharing mutable selections", () => {
    const root = project("refresh", { aiTools: ["codex"] });
    const first = readTelemetryProjectContext(root);
    first.configured_ai_tools?.push("claude");
    expect(readTelemetryProjectContext(root)).toEqual({ configured_ai_tools: ["codex"] });
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({ aiTools: ["cursor"] }));
    expect(readTelemetryProjectContext(root)).toEqual({ configured_ai_tools: ["cursor"] });
  });

  it("rejects non-regular and multiply-linked configuration files", () => {
    const root = project("file-shape");
    const path = join(root, ".mex", "config.json");
    mkdirSync(path);
    expect(readTelemetryProjectContext(root)).toEqual({});
    rmSync(path, { recursive: true });
    const outside = join(directory, "shared-config.json");
    writeFileSync(outside, JSON.stringify({ aiTools: ["codex"] }));
    linkSync(outside, path);
    expect(readTelemetryProjectContext(root)).toEqual({});
  });

  it("rejects a symlinked configuration file", (context) => {
    const root = project("file-link");
    const outside = join(directory, "external-config.json");
    writeFileSync(outside, JSON.stringify({ aiTools: ["codex"] }));
    try { symlinkSync(outside, join(root, ".mex", "config.json"), "file"); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    expect(readTelemetryProjectContext(root)).toEqual({});
  });

  it("rejects an escaping scaffold symlink or junction", () => {
    const root = project("scaffold-link");
    rmSync(join(root, ".mex"), { recursive: true });
    const outside = join(directory, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config.json"), JSON.stringify({ aiTools: ["codex"] }));
    symlinkSync(outside, join(root, ".mex"), process.platform === "win32" ? "junction" : "dir");
    const before = snapshot(outside);
    expect(readTelemetryProjectContext(root)).toEqual({});
    expect(snapshot(outside)).toEqual(before);
  });

  it("omits context when invoked inside the scaffold itself", () => {
    const root = project("inside", { aiTools: ["codex"] });
    expect(readTelemetryProjectContext(join(root, ".mex"))).toEqual({});
    expect(readTelemetryProjectContext(join(root, ".mex"), "exact")).toEqual({});
  });
});

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryWikiPort } from "../../../../wiki/application-adapter.js";
import { runInboxTarget } from "../commands.js";

const ID = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function output() {
  const lines: string[] = [];
  const exits: number[] = [];
  return { lines, exits, io: { write: (line: string) => lines.push(line), setExitCode: (code: number) => exits.push(code) } };
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = `${statSync(path).mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(root);
  return files;
}

describe("Inbox target lookup", () => {
  it("returns exact authoring revisions from real Wiki reads without changing files or exposing metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-inbox-target-"));
    roots.push(root);
    mkdirSync(join(root, ".mex", "context"), { recursive: true });
    const file = join(root, ".mex", "context", "decision.md");
    writeFileSync(file, `---\nmex:\n  id: ${ID}\n  type: decision\n  title: Share through Git\n  status: promoted\n  revision: 3\n  private_note: must-not-leak\n---\n\n# Share through Git\n\nTeam knowledge uses tracked Markdown.\n`);
    const wiki = createRepositoryWikiPort(root);
    await wiki.rebuildIndex();
    const before = snapshot(root);
    const captured = output();
    await runInboxTarget(() => wiki, ID, { json: true }, captured.io);
    expect(captured.exits).toEqual([0]);
    expect(JSON.parse(captured.lines[0]!)).toMatchObject({
      ok: true, command: "inbox.target", mode: "read",
      data: {
        target: { id: ID, kind: "decision", title: "Share through Git" },
        version: { semanticRevision: 3, contentHash: createHash("sha256").update(readFileSync(file)).digest("hex") },
        body: expect.stringContaining("Team knowledge uses tracked Markdown."),
      },
    });
    expect(captured.lines[0]).not.toContain("must-not-leak");
    expect(snapshot(root)).toEqual(before);

    const target = (await wiki.readInboxTarget(ID))!;
    const oversized = output();
    await runInboxTarget(() => ({
      readInboxTarget: async () => ({ ...target, body: "\n".repeat(40 * 1024) }),
    }), ID, { json: true }, oversized.io);
    expect(JSON.parse(oversized.lines[0]!)).toMatchObject({
      ok: false, data: null, problem: { code: "INVALID_REQUEST", status: 413 },
    });
    expect(Buffer.byteLength(oversized.lines[0]!, "utf8")).toBeLessThan(64 * 1024);

    writeFileSync(file, readFileSync(file, "utf8").replace("tracked Markdown", "committed Markdown"));
    const staleBefore = snapshot(root);
    const stale = output();
    await runInboxTarget(() => wiki, ID, { json: true }, stale.io);
    expect(JSON.parse(stale.lines[0]!)).toMatchObject({ ok: false, data: null, problem: { code: "INDEX_STALE" } });
    expect(snapshot(root)).toEqual(staleBefore);
  });

  it("rejects invalid IDs before opening a reader and reports missing targets", async () => {
    const source = vi.fn(() => ({ readInboxTarget: vi.fn(async () => null) }));
    const invalid = output();
    await runInboxTarget(source, "../bad", { json: true }, invalid.io);
    expect(source).not.toHaveBeenCalled();
    expect(invalid.exits).toEqual([2]);
    const missing = output();
    await runInboxTarget(source, ID, { json: true }, missing.io);
    expect(JSON.parse(missing.lines[0]!)).toMatchObject({ ok: false, data: null, problem: { code: "NOT_FOUND" } });
  });
});

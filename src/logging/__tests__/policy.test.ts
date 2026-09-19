import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_LOGGING_MODES, readAgentLoggingPolicy, setAgentLoggingPolicy } from "../policy.js";
import { revisionOf } from "../../team/artifacts/revision.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(scaffold = true): string {
  const root = mkdtempSync(join(tmpdir(), "mex-logging-policy-"));
  roots.push(root);
  if (scaffold) mkdirSync(join(root, ".mex"));
  return root;
}

describe("checkout agent logging policy", () => {
  it("reads the quiet default without initializing local state or repairing absent scaffolds", async () => {
    const root = fixture();
    expect(readAgentLoggingPolicy(root)).toEqual({ mode: "significant", source: "default", revision: null });
    expect(readdirSync(join(root, ".mex"))).toEqual([]);
    const missing = fixture(false);
    expect(() => readAgentLoggingPolicy(missing)).toThrowError(expect.objectContaining({ problem: expect.objectContaining({ code: "NOT_FOUND" }) }));
    await expect(setAgentLoggingPolicy(missing, { mode: "manual", expectedRevision: null })).rejects.toMatchObject({ problem: { code: "NOT_FOUND" } });
    expect(existsSync(join(missing, ".mex"))).toBe(false);
  });

  it("persists each mode only locally with exact revisions and a stable repeated save", async () => {
    const root = fixture();
    const canonicalPath = join(root, ".mex/config.json");
    const canonical = '{"scaffold_id":"existing","unrelated":true}\n';
    writeFileSync(canonicalPath, canonical);
    let current = readAgentLoggingPolicy(root);
    for (const mode of AGENT_LOGGING_MODES) {
      current = await setAgentLoggingPolicy(root, { mode, expectedRevision: current.revision });
      expect(current).toMatchObject({ mode, source: "local", revision: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(readAgentLoggingPolicy(root)).toEqual(current);
      const bytes = readFileSync(join(root, ".mex/local/agent-preferences.json"));
      expect(JSON.parse(bytes.toString("utf8"))).toEqual({ schemaVersion: 1, mode });
      expect(await setAgentLoggingPolicy(root, { mode, expectedRevision: current.revision })).toEqual(current);
      expect(readFileSync(join(root, ".mex/local/agent-preferences.json"))).toEqual(bytes);
    }
    expect(readFileSync(canonicalPath, "utf8")).toBe(canonical);
    expect(readdirSync(join(root, ".mex/local"))).toEqual(["agent-preferences.json"]);
    expect(existsSync(join(root, ".mex/events"))).toBe(false);
    expect(existsSync(join(root, ".mex/local/team.db"))).toBe(false);
  });

  it("refuses stale or concurrent updates without overwriting the winning preference", async () => {
    const root = fixture();
    const first = await setAgentLoggingPolicy(root, { mode: "manual", expectedRevision: null });
    await expect(setAgentLoggingPolicy(root, { mode: "significant", expectedRevision: null })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    const attempts = await Promise.allSettled([
      setAgentLoggingPolicy(root, { mode: "checkpoints", expectedRevision: first.revision }),
      setAgentLoggingPolicy(root, { mode: "significant", expectedRevision: first.revision }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { problem: { code: "REVISION_CONFLICT" } } });
    expect(readAgentLoggingPolicy(root).mode).toBe("checkpoints");
  });

  it("treats an LF-to-CRLF external edit as a new exact revision and refuses a stale save", async () => {
    const root = fixture();
    const first = await setAgentLoggingPolicy(root, { mode: "manual", expectedRevision: null });
    const path = join(root, ".mex/local/agent-preferences.json");
    const crlf = readFileSync(path, "utf8").replaceAll("\n", "\r\n");
    writeFileSync(path, crlf);
    const changed = readAgentLoggingPolicy(root);
    expect(changed).toEqual({ mode: "manual", source: "local", revision: revisionOf(crlf) });
    expect(changed.revision).not.toBe(first.revision);
    await expect(setAgentLoggingPolicy(root, { mode: "checkpoints", expectedRevision: first.revision }))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(readFileSync(path, "utf8")).toBe(crlf);
    const saved = await setAgentLoggingPolicy(root, { mode: "checkpoints", expectedRevision: changed.revision });
    expect(readAgentLoggingPolicy(root)).toEqual(saved);
    expect(saved.mode).toBe("checkpoints");
    expect(saved.revision).toBe(revisionOf(readFileSync(path)));
  });

  it("surfaces malformed, unsupported, oversize, and non-UTF-8 preference bytes without resetting them", async () => {
    for (const bytes of [
      "not JSON", '{"schemaVersion":2,"mode":"manual"}', '{"schemaVersion":1,"mode":"always"}',
      '{"schemaVersion":1,"mode":"manual","other":true}', "x".repeat(1025), Buffer.from([0xff]),
    ]) {
      const root = fixture();
      mkdirSync(join(root, ".mex/local"));
      const path = join(root, ".mex/local/agent-preferences.json");
      writeFileSync(path, bytes);
      const before = readFileSync(path);
      expect(() => readAgentLoggingPolicy(root)).toThrow();
      await expect(setAgentLoggingPolicy(root, { mode: "significant", expectedRevision: null })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      expect(readFileSync(path)).toEqual(before);
    }
  });

  it("rejects symlinks at every settings path component and never writes outside the checkout", async () => {
    for (const location of [".mex", ".mex/local", ".mex/local/agent-preferences.json"]) {
      const root = fixture(false);
      const outside = fixture(false);
      const parts = location.split("/");
      if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
      const target = location.endsWith(".json") ? join(outside, "external.json") : outside;
      if (target !== outside) writeFileSync(target, '{"schemaVersion":1,"mode":"manual"}\n');
      symlinkSync(target, join(root, location), target === outside ? "dir" : "file");
      expect(() => readAgentLoggingPolicy(root)).toThrow();
      await expect(setAgentLoggingPolicy(root, { mode: "checkpoints", expectedRevision: null })).rejects.toMatchObject({ problem: { code: "PATH_OUTSIDE_PROJECT" } });
      expect(readdirSync(outside)).toEqual(target === outside ? [] : ["external.json"]);
    }
  });

  it("validates the closed setter request before creating any local state", async () => {
    const root = fixture();
    for (const request of [
      { mode: "always", expectedRevision: null }, { mode: "manual" },
      { mode: "manual", expectedRevision: "old" }, { mode: "manual", expectedRevision: null, extra: true },
    ]) await expect(setAgentLoggingPolicy(root, request as never)).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    expect(existsSync(join(root, ".mex/local"))).toBe(false);
  });
});

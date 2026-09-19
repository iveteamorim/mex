import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLoggingCommand } from "../cli.js";
import { readAgentLoggingPolicy } from "../policy.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-logging-cli-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  const lines: string[] = [];
  const exits: number[] = [];
  const projectRoot = vi.fn(() => root);
  const run = async (...args: string[]) => {
    const command = buildLoggingCommand({ projectRoot, write: (line) => lines.push(line), setExitCode: (code) => exits.push(code) });
    await command.parseAsync(args, { from: "user" });
    return JSON.parse(lines.at(-1)!);
  };
  return { root, lines, exits, run, projectRoot };
}

describe("logging CLI", () => {
  it("reads the default as one checkout-scoped JSON envelope and changes cadence locally", async () => {
    const fixtureValue = fixture();
    expect(await fixtureValue.run("--json")).toEqual({
      schemaVersion: 1, command: "logging", ok: true, scope: "checkout",
      data: { mode: "significant", revision: null, source: "default" }, problem: null,
    });
    expect(existsSync(join(fixtureValue.root, ".mex/local"))).toBe(false);
    const saved = await fixtureValue.run("manual", "--expected-revision", "none", "--json");
    expect(saved).toMatchObject({ ok: true, data: { mode: "manual", source: "local" } });
    expect(readAgentLoggingPolicy(fixtureValue.root)).toEqual(saved.data);
    expect(await fixtureValue.run("checkpoints", "--json")).toMatchObject({ ok: true, data: { mode: "checkpoints" } });
    expect(fixtureValue.exits).toEqual([0, 0, 0]);
  });

  it("reports an exact revision conflict and preserves the saved preference", async () => {
    const fixtureValue = fixture();
    await fixtureValue.run("manual", "--json");
    expect(await fixtureValue.run("significant", "--expected-revision", "none", "--json")).toMatchObject({
      ok: false, data: null, problem: { code: "REVISION_CONFLICT" },
    });
    expect(readAgentLoggingPolicy(fixtureValue.root).mode).toBe("manual");
    expect(fixtureValue.exits.at(-1)).toBe(4);
  });

  it("rejects invalid flags and modes before locating the project", async () => {
    const fixtureValue = fixture();
    for (const args of [["always"], ["--expected-revision", "none"], ["manual", "--expected-revision", "bad"]]) {
      expect(await fixtureValue.run(...args, "--json")).toMatchObject({ ok: false, problem: { code: "INVALID_REQUEST" } });
    }
    expect(fixtureValue.projectRoot).not.toHaveBeenCalled();
    expect(existsSync(join(fixtureValue.root, ".mex/local"))).toBe(false);
  });
});

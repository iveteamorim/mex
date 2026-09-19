import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as reader from "../src/telemetry/project-context.js";
import { __resetTelemetryForTest, __setTransport, createProjectTelemetryCapture, getProjectTelemetryContext, getTelemetryInspection } from "../src/telemetry/index.js";

const SCAFFOLD_A = "8c2215bb-bb35-48bc-8f6d-ff8ca8b7fd99";
const SCAFFOLD_B = "670c15cc-cf05-414f-9b24-841d6e646914";
let root: string;
let cwd: string;
let prior: Record<string, string | undefined>;
const capture = vi.fn();
function project(name: string, config: unknown): string {
  const path = join(root, name);
  mkdirSync(join(path, ".git"), { recursive: true });
  mkdirSync(join(path, ".mex"));
  writeFileSync(join(path, ".mex", "config.json"), JSON.stringify(config));
  return path;
}
beforeEach(() => {
  cwd = process.cwd();
  prior = Object.fromEntries(["MEX_HOME", "MEX_DEV", "MEX_TELEMETRY", "DO_NOT_TRACK"].map(key => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "mex-project-telemetry-"));
  process.chdir(root);
  process.env.MEX_HOME = join(root, "user");
  delete process.env.MEX_DEV; delete process.env.MEX_TELEMETRY; delete process.env.DO_NOT_TRACK;
  __resetTelemetryForTest();
  capture.mockReset();
  __setTransport(capture);
});
afterEach(() => {
  __resetTelemetryForTest();
  vi.restoreAllMocks();
  process.chdir(cwd);
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("project metadata capture boundary", () => {
  it("binds one immutable snapshot to the Hub's project even when cwd differs", () => {
    const selected = project("selected", { scaffold_id: SCAFFOLD_A, aiTools: ["codex", "claude"], origin: "PRIVATE_REMOTE" });
    project("unrelated", { scaffold_id: SCAFFOLD_B, aiTools: ["cursor"] });
    const read = vi.spyOn(reader, "readTelemetryProjectContext");
    const sink = createProjectTelemetryCapture(selected);
    expect(read).not.toHaveBeenCalled();
    sink("hub.session_started", {});
    writeFileSync(join(selected, ".mex", "config.json"), JSON.stringify({ scaffold_id: SCAFFOLD_B, aiTools: ["cursor"] }));
    sink("hub.page_viewed", { page: "knowledge" });
    expect(read).toHaveBeenCalledExactlyOnceWith(selected, "exact");
    for (const [, attrs] of capture.mock.calls) {
      expect(attrs).toMatchObject({ scaffold_id: SCAFFOLD_A, configured_ai_tools: ["claude", "codex"] });
      expect(JSON.stringify(attrs)).not.toContain("PRIVATE_REMOTE");
    }
  });

  it("keeps different Hubs independent while sharing installation identity", () => {
    const left = createProjectTelemetryCapture(project("left", { scaffold_id: SCAFFOLD_A, aiTools: ["claude"] }));
    const right = createProjectTelemetryCapture(project("right", { scaffold_id: SCAFFOLD_B, aiTools: ["codex"] }));
    left("hub.page_viewed", { page: "inbox" });
    right("hub.page_viewed", { page: "relays" });
    expect(capture.mock.calls[0][1].installation_id).toBe(capture.mock.calls[1][1].installation_id);
    expect(capture.mock.calls.map(([, attrs]) => [attrs.scaffold_id, attrs.configured_ai_tools])).toEqual([
      [SCAFFOLD_A, ["claude"]], [SCAFFOLD_B, ["codex"]],
    ]);
  });

  it("uses the Hub's exact nested project instead of an ancestor scaffold", () => {
    const parent = project("parent", { scaffold_id: SCAFFOLD_A, aiTools: ["claude"] });
    const nested = join(parent, "package");
    mkdirSync(join(nested, ".mex"), { recursive: true });
    writeFileSync(join(nested, ".mex", "config.json"), JSON.stringify({ scaffold_id: SCAFFOLD_B, aiTools: ["codex"] }));
    createProjectTelemetryCapture(nested)("hub.page_viewed", { page: "home" });
    expect(capture.mock.calls[0][1]).toMatchObject({ scaffold_id: SCAFFOLD_B, configured_ai_tools: ["codex"] });
  });

  it("does not read project config while disabled and discovers it on later enable", () => {
    const path = project("selected", { scaffold_id: SCAFFOLD_A, aiTools: ["codex"] });
    const read = vi.spyOn(reader, "readTelemetryProjectContext");
    process.env.DO_NOT_TRACK = "1";
    const sink = createProjectTelemetryCapture(path);
    sink("hub.page_viewed", { page: "home" });
    expect(getProjectTelemetryContext(path)).toEqual({});
    expect(read).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(join(root, "user", ".mex"))).toBe(false);
    delete process.env.DO_NOT_TRACK;
    sink("hub.page_viewed", { page: "knowledge" });
    expect(read).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0][1].scaffold_id).toBe(SCAFFOLD_A);
  });

  it("rejects unknown event input before project discovery", () => {
    const read = vi.spyOn(reader, "readTelemetryProjectContext");
    createProjectTelemetryCapture(root)("hub.page_viewed", { page: "knowledge", secret: "PRIVATE" } as never);
    expect(read).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("retains the base event when project metadata is absent or malformed", () => {
    createProjectTelemetryCapture(root)("hub.page_viewed", { page: "home" });
    const path = project("malformed", {});
    writeFileSync(join(path, ".mex", "config.json"), "not JSON PRIVATE");
    createProjectTelemetryCapture(path)("hub.page_viewed", { page: "home" });
    expect(capture).toHaveBeenCalledTimes(2);
    for (const [, attrs] of capture.mock.calls) {
      expect(attrs).not.toHaveProperty("scaffold_id");
      expect(attrs).not.toHaveProperty("configured_ai_tools");
    }
  });

  it("inspects the actual safe project metadata without minting any identity or writing", () => {
    const path = project("inspect", { scaffold_id: SCAFFOLD_A, aiTools: ["codex"], scaffold_name: "PRIVATE_NAME", origin: "PRIVATE_REMOTE" });
    process.chdir(path);
    const configPath = join(path, ".mex", "config.json");
    const before = readFileSync(configPath);
    const result = getTelemetryInspection();
    expect(result.project_context).toEqual({ scaffold_id: SCAFFOLD_A, configured_ai_tools: ["codex"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(readFileSync(configPath)).toEqual(before);
    expect(readdirSync(join(path, ".mex"))).toEqual(["config.json"]);
    expect(existsSync(join(root, "user", ".mex"))).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});

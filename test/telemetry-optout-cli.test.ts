import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Issue #110: the opt-out worked but was undiscoverable. The reporter typed
 * `mex telemetry disable`, got `unknown command`, then guessed at env var names.
 * These tests pin the three places the answer now appears — the subcommand, the
 * group's help text, and `status` — because each one is a thing a user reaches
 * for first, and any of them going quiet again reopens the issue.
 *
 * MEX_HOME is redirected per test (not $HOME: Node's homedir() ignores $HOME on
 * Windows), so no test can touch the developer's real ~/.mex/config.json.
 */

let originalMexHome: string | undefined;
let originalDoNotTrack: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalMexHome = process.env.MEX_HOME;
  originalDoNotTrack = process.env.DO_NOT_TRACK;
  delete process.env.DO_NOT_TRACK;
  tempHome = mkdtempSync(join(tmpdir(), "mex-optout-"));
  process.env.MEX_HOME = tempHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalMexHome === undefined) delete process.env.MEX_HOME;
  else process.env.MEX_HOME = originalMexHome;
  if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
  else process.env.DO_NOT_TRACK = originalDoNotTrack;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function storedTelemetry(): unknown {
  const path = join(tempHome, ".mex", "config.json");
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf-8")) as { telemetry?: unknown }).telemetry;
}

async function runCli(...args: string[]): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.join(" "));
  });
  const { program } = await import("../src/cli.js");
  await program.parseAsync(["node", "mex", ...args]);
  return lines;
}

describe("mex telemetry opt-out discoverability (#110)", () => {
  it("accepts `telemetry disable`, the command the reporter reached for first", async () => {
    const lines = await runCli("telemetry", "disable");

    expect(storedTelemetry()).toBe("off");
    expect(lines.join("\n")).toContain("Telemetry disabled");
  });

  it("round-trips back on with `telemetry enable`", async () => {
    await runCli("telemetry", "disable");
    expect(storedTelemetry()).toBe("off");

    await runCli("telemetry", "enable");
    expect(storedTelemetry()).toBe("on");
  });

  it("writes the same key as `mex config set telemetry off`, rather than a second setting", async () => {
    await runCli("config", "set", "telemetry", "off");
    const viaConfig = storedTelemetry();

    await runCli("telemetry", "enable");
    await runCli("telemetry", "disable");

    expect(storedTelemetry()).toBe(viaConfig);
  });

  it("does not claim telemetry is off when an env opt-out already outranks the stored value", async () => {
    process.env.DO_NOT_TRACK = "1";

    const lines = (await runCli("telemetry", "enable")).join("\n");

    // Honest about the outcome: the write happened, and it changes nothing yet.
    expect(storedTelemetry()).toBe("on");
    expect(lines).toContain("DO_NOT_TRACK");
  });

  it("names the env opt-outs in `telemetry --help`, where the reporter looked next", async () => {
    const { program } = await import("../src/cli.js");
    const telemetry = program.commands.find((command) => command.name() === "telemetry");
    // `helpInformation()` omits addHelpText hooks, which is exactly where the
    // env vars live — render what the user actually sees instead.
    let help = "";
    telemetry?.configureOutput({ writeOut: (chunk) => { help += chunk; } });
    telemetry?.outputHelp();

    expect(telemetry?.commands.map((command) => command.name())).toContain("disable");
    expect(help).toContain("DO_NOT_TRACK=1");
    expect(help).toContain("MEX_TELEMETRY=0");
  });

  it("tells `status` readers what to change, not just which reason code fired", async () => {
    process.env.DO_NOT_TRACK = "1";
    const disabled = (await runCli("telemetry", "status")).join("\n");

    expect(disabled).toContain("disabled (reason: DO_NOT_TRACK)");
    expect(disabled).toContain("DO_NOT_TRACK environment variable");
  });
});

import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { buildAgentCommand } from "../agent-command.js";
import { AI_TOOLS, type AiTool } from "../types.js";
import { createPopulationActivityDecoder, type PopulationActivitySignal } from "./population-activity.js";
import { createPopulationTranscriptDecoder, type PopulationTranscriptSignal } from "./population-transcript.js";
import {
  launchSetupPopulationAsync,
  SetupPopulationError,
  type SetupAgentTool,
  type SetupPopulationLaunchResult,
} from "./population.js";

const POPULATION_TIMEOUT_MS = 30 * 60_000;
const TERMINATE_GRACE_MS = 500;
const DIAGNOSTIC_BYTES = 8 * 1024;
const DISCOVERY_TIMEOUT_MS = 5_000;

export interface HeadlessPopulationOptions {
  readonly selectedTools: readonly AiTool[];
  readonly prompt: string;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  /** Agent-memory setup supports directories without a Git repository. */
  readonly allowNonGit?: boolean;
  /** A shorter bounded deadline; the browser request cannot supply this. */
  readonly timeoutMs?: number;
  /** Fixed activity categories only; never raw agent output or tool arguments. */
  readonly onActivity?: (activity: HeadlessPopulationActivity) => void;
  readonly onTranscript?: (entry: HeadlessPopulationTranscript) => void;
  /** Subprocess test seams, never part of the Hub request contract. */
  readonly __internal?: {
    readonly isAvailable?: (command: string) => Promise<boolean>;
    readonly spawn?: typeof crossSpawn;
    readonly onSpawn?: (pid: number) => void;
  };
}

export type HeadlessPopulationActivity = PopulationActivitySignal & { readonly tool: SetupAgentTool };
export type HeadlessPopulationTranscript = PopulationTranscriptSignal & { readonly tool: SetupAgentTool };

type PopulationFailure = "launch" | "arguments" | "authentication" | "failed" | "protocol" | "cancelled" | "timeout" | "prompt";

/** Fixed messages only: child output can contain prompts, paths, and secrets. */
export class HeadlessPopulationError extends SetupPopulationError {
  constructor(readonly category: PopulationFailure, tool?: SetupAgentTool) {
    const name = tool ? AI_TOOLS[tool].name : "The selected AI tool";
    const messages: Record<PopulationFailure, string> = {
      launch: `${name} could not start. Check its installation and try again.`,
      arguments: `${name} rejected the background command. Update the AI CLI and MEX, then try again.`,
      authentication: `${name} could not authenticate. Sign in to its CLI and try again.`,
      failed: `${name} exited before population completed. Check its CLI configuration and try again.`,
      protocol: `${name} stopped without confirming completion. Review the files and resume setup.`,
      cancelled: "AI population was cancelled. You can resume setup when ready.",
      timeout: "AI population exceeded its time limit and was stopped. Review the files and resume setup.",
      prompt: "The private setup population prompt could not be prepared or removed safely.",
    };
    super(messages[category]);
    this.name = "HeadlessPopulationError";
  }
}

/** The Hub owns a non-interactive background child and its entire prompt lifetime. */
export async function launchHeadlessSetupPopulation(
  options: HeadlessPopulationOptions,
): Promise<SetupPopulationLaunchResult> {
  if (options.signal?.aborted) throw new HeadlessPopulationError("cancelled");
  try {
    const result = await launchSetupPopulationAsync(
      options.selectedTools,
      options.prompt,
      options.projectRoot,
      {
        isAvailable: async (command) => {
          const available = await (options.__internal?.isAvailable
            ?? ((name) => isAvailableAsync(name, options.signal)))(command);
          if (options.signal?.aborted) throw new HeadlessPopulationError("cancelled");
          return available;
        },
        run: (tool, instruction, cwd) => runHeadlessAgent(tool, instruction, cwd, options),
      },
    );
    if (options.signal?.aborted) throw new HeadlessPopulationError("cancelled");
    return result;
  } catch (error) {
    if (error instanceof HeadlessPopulationError) throw error;
    // The shared terminal helper retains detailed local errors; browser callers
    // receive only this safe allowlist, without an attached raw error cause.
    throw new HeadlessPopulationError("prompt");
  }
}

function isAvailableAsync(command: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = crossSpawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS, signal,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function runHeadlessAgent(
  tool: SetupAgentTool,
  instruction: string,
  cwd: string,
  options: HeadlessPopulationOptions,
): Promise<boolean> {
  if (options.signal?.aborted) return Promise.reject(new HeadlessPopulationError("cancelled"));
  const invocation = buildAgentCommand(tool, instruction, "headless", { allowNonGit: options.allowNonGit })!;
  const requestedTimeout = options.timeoutMs ?? POPULATION_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(POPULATION_TIMEOUT_MS, requestedTimeout))
    : POPULATION_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = (options.__internal?.spawn ?? crossSpawn)(invocation.command, invocation.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // POSIX process groups include agent-created shell/worker descendants.
        detached: process.platform !== "win32",
      });
    } catch {
      reject(new HeadlessPopulationError("launch", tool));
      return;
    }
    const stdout = boundedDiagnostic();
    const stderr = boundedDiagnostic();
    let failure: HeadlessPopulationError | undefined;
    let treeCleanup: Promise<void> | undefined;
    let closing = false;
    const emitActivity = (activity: PopulationActivitySignal) => {
      if (closing || failure || options.signal?.aborted) return;
      // An observer must not leave an otherwise healthy child unowned.
      try { options.onActivity?.({ tool, ...activity }); } catch { /* observation only */ }
    };
    const decoder = createPopulationActivityDecoder(tool, emitActivity);
    const transcript = options.onTranscript ? createPopulationTranscriptDecoder(tool, (entry) => {
      if (closing || failure || options.signal?.aborted) return;
      try { options.onTranscript?.({ tool, ...entry }); } catch { /* observation only */ }
    }) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      if (!closing && !failure && !options.signal?.aborted) {
        decoder.write(chunk);
        transcript?.write(chunk);
      }
    });
    child.stderr?.on("data", stderr.append);
    child.once("spawn", () => emitActivity({ kind: "starting", state: "running" }));
    const stop = (reason: HeadlessPopulationError) => {
      if (closing || failure) return;
      failure = reason;
      transcript?.dispose();
      treeCleanup = terminateProcessTree(child);
    };
    const cancelled = () => stop(new HeadlessPopulationError("cancelled", tool));
    const parentExit = () => killProcessTreeOnExit(child);
    const timer = setTimeout(() => stop(new HeadlessPopulationError("timeout", tool)), timeoutMs);
    timer.unref();
    process.once("exit", parentExit);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    child.once("error", () => stop(new HeadlessPopulationError("launch", tool)));
    child.once("exit", () => {
      // A successful POSIX child must not leave background helpers holding its
      // pipes or editing after the prompt is removed. Windows cancellation uses
      // taskkill while the parent PID is still alive, to retain the tree relation.
      if (!treeCleanup && process.platform !== "win32") treeCleanup = terminateProcessTree(child);
    });
    child.once("close", async (code, signal) => {
      // `close` follows the pipe drains, so a final JSON record without a newline
      // is decoded before observers are detached and the launch promise settles.
      decoder.end();
      transcript?.end();
      closing = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancelled);
      await treeCleanup;
      process.removeListener("exit", parentExit);
      if (options.signal?.aborted) reject(new HeadlessPopulationError("cancelled", tool));
      else if (failure) reject(failure);
      else if (code !== 0 || signal || decoder.failed) {
        reject(new HeadlessPopulationError(classifyFailure(stderr.text(), stdout.text()), tool));
      } else if (!decoder.completed) reject(new HeadlessPopulationError("protocol", tool));
      else resolve(true);
    });
    try {
      if (child.pid) options.__internal?.onSpawn?.(child.pid);
    } catch {
      stop(new HeadlessPopulationError("failed", tool));
    }
    if (options.signal?.aborted) cancelled();
  });
}

function boundedDiagnostic(): { append: (chunk: Buffer) => void; text: () => string } {
  const buffer = Buffer.alloc(DIAGNOSTIC_BYTES);
  let length = 0;
  return {
    append: (chunk) => { length += chunk.copy(buffer, length, 0, Math.max(0, buffer.length - length)); },
    text: () => buffer.subarray(0, length).toString("utf8"),
  };
}

function classifyFailure(stderr: string, stdout: string): PopulationFailure {
  const text = `${stderr}\n${stdout}`;
  if (/unexpected argument|unknown (?:option|argument)|unrecognized (?:option|argument)/iu.test(text)) return "arguments";
  if (/not (?:logged|signed) in|authentication (?:failed|required)|invalid api key|unauthorized|please (?:log|sign) in/iu.test(text)) return "authentication";
  return "failed";
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      // cross-spawn may launch an npm .cmd wrapper; killing that wrapper alone
      // leaves Node and its grandchildren running. Never involve a command shell.
      const killer = crossSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS,
      });
      killer.once("error", () => { child.kill("SIGKILL"); resolve(); });
      killer.once("close", () => { child.kill("SIGKILL"); resolve(); });
    });
  }
  // Do not retain an unnecessary grace timer once the complete group is gone.
  try { process.kill(-child.pid, 0); } catch { return Promise.resolve(); }
  signalProcessGroup(child, "SIGTERM");
  return new Promise((resolve) => {
    setTimeout(() => { signalProcessGroup(child, "SIGKILL"); resolve(); }, TERMINATE_GRACE_MS);
  });
}

function killProcessTreeOnExit(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Node's exit hook cannot await work. Normal Hub shutdown uses AbortSignal
    // and the asynchronous path; this bounded fallback handles process.exit().
    crossSpawn.sync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS,
    });
  } else signalProcessGroup(child, "SIGKILL");
}

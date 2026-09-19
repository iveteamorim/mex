import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildResult } from "./engine.js";
import {
  boundedCandidateMessage,
  type GraphCandidateProgress,
  type GraphCandidateRequest,
} from "./candidate-protocol.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTUP_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 500;
// A hang guard, not a resource/performance promise for a particular repository.
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

export class GraphCandidateProcessError extends Error {
  override readonly name = "GraphCandidateProcessError";
  constructor(readonly category: "cancelled" | "compatibility" | "staging" | "failed" | "unsafe") {
    super(category === "cancelled"
      ? "Graph candidate construction was cancelled."
      : "The isolated graph candidate could not be completed safely.");
  }
}

export interface GraphCandidateProcessOptions {
  projectRoot: string;
  candidatePath: string;
  operation: "refresh" | "rebuild";
  signal?: AbortSignal;
  onProgress?: (progress: GraphCandidateProgress) => void;
  /** Deterministic subprocess fault seams; never exposed by the GraphPort. */
  __internal?: {
    entrypoint?: string;
    onSpawn?: (pid: number, workspace: string) => void;
    buildTimeoutMs?: number;
  };
}

function identity(path: string): GraphCandidateRequest["workspaceIdentity"] {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new GraphCandidateProcessError("unsafe");
  return { realPath: realpathSync(path), dev: String(stats.dev), ino: String(stats.ino) };
}

function sameDirectory(path: string, expected: ReturnType<typeof identity>): boolean {
  try {
    const current = identity(path);
    return current.realPath === expected.realPath && current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

function candidateEntrypoint(): string {
  // Bundled CLI and library use the sibling asset. Source-based Hub tests/dev
  // use the installed build; no TypeScript loader or public CLI is spawned.
  const candidates = [join(HERE, "graph-candidate.js"), join(HERE, "../../dist/graph-candidate.js")];
  const entrypoint = candidates.find((path) => existsSync(path));
  if (!entrypoint) throw new GraphCandidateProcessError("failed");
  return entrypoint;
}

/** Construct only the parent's candidate. Lease and publication stay in maintenance. */
export async function runGraphCandidateProcess(options: GraphCandidateProcessOptions): Promise<BuildResult> {
  if (options.signal?.aborted) throw new GraphCandidateProcessError("cancelled");
  const workspace = mkdtempSync(join(tmpdir(), "mex-graph-candidate-"));
  const workspaceIdentity = identity(workspace);
  try {
    const request: GraphCandidateRequest = {
      version: 1,
      operation: options.operation,
      projectRoot: options.projectRoot,
      candidatePath: options.candidatePath,
      workspace,
      workspaceIdentity,
      mexIdentity: identity(dirname(options.candidatePath)),
    };
    return await superviseCandidate(options, request);
  } finally {
    // Never remove a replaced/symlinked directory. Wait for `close` (not just an
    // IPC result or `exit`) before deleting anything: SQLite/WASM may hold files
    // until the OS has closed the child's handles, particularly on Windows.
    if (!sameDirectory(workspace, workspaceIdentity)) throw new GraphCandidateProcessError("unsafe");
    rmSync(workspace, { recursive: true, force: false });
  }
}

function superviseCandidate(options: GraphCandidateProcessOptions, request: GraphCandidateRequest): Promise<BuildResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [options.__internal?.entrypoint ?? candidateEntrypoint()], {
        cwd: options.projectRoot,
        env: { ...process.env, MEX_TELEMETRY: "0", DO_NOT_TRACK: "1" },
        // FD 4 is a lifeline. A watchdog in the child observes EOF even while
        // its main thread is inside synchronous TypeScript or SQLite work.
        // Overlapped enables asynchronous reads on the inherited Windows
        // lifeline handle; it is identical to `pipe` on Unix.
        stdio: ["ignore", "ignore", "ignore", "ipc", "overlapped"],
        serialization: "json",
        windowsHide: true,
      });
    } catch {
      reject(new GraphCandidateProcessError("failed"));
      return;
    }
    let ready = false;
    let result: BuildResult | undefined;
    let failure: GraphCandidateProcessError | undefined;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: GraphCandidateProcessError) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      terminateTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
      terminateTimer.unref();
    };
    const cancelled = () => stop(new GraphCandidateProcessError("cancelled"));
    const parentExit = () => child.kill("SIGKILL");
    const startupTimer = setTimeout(() => stop(new GraphCandidateProcessError("failed")), STARTUP_TIMEOUT_MS);
    const buildTimer = setTimeout(
      () => stop(new GraphCandidateProcessError("failed")),
      options.__internal?.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
    );
    startupTimer.unref();
    buildTimer.unref();
    process.once("exit", parentExit);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    child.on("error", () => stop(new GraphCandidateProcessError("failed")));
    child.on("disconnect", () => {
      // A live parent keeps FD4 open, so the parent-death watchdog cannot help
      // when only IPC is lost. A disconnected writer without a terminal result
      // must be stopped promptly instead of holding the lease until timeout.
      if (!result && !failure) stop(new GraphCandidateProcessError("failed"));
    });
    child.on("message", (raw: unknown) => {
      if (failure) return;
      const message = boundedCandidateMessage(raw);
      if (!message || result) return stop(new GraphCandidateProcessError("failed"));
      if (message.type === "ready") {
        if (ready) return stop(new GraphCandidateProcessError("failed"));
        ready = true;
        clearTimeout(startupTimer);
        child.send(request, (error) => { if (error) stop(new GraphCandidateProcessError("failed")); });
      } else if (!ready) {
        stop(new GraphCandidateProcessError("failed"));
      } else if (message.type === "progress") {
        try {
          options.onProgress?.(message.progress);
        } catch {
          stop(new GraphCandidateProcessError("failed"));
        }
      } else if (message.type === "complete") {
        result = message.result;
      } else {
        stop(new GraphCandidateProcessError(message.category));
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(startupTimer);
      clearTimeout(buildTimer);
      if (terminateTimer) clearTimeout(terminateTimer);
      process.removeListener("exit", parentExit);
      options.signal?.removeEventListener("abort", cancelled);
      child.stdio[4]?.destroy();
      if (options.signal?.aborted) reject(new GraphCandidateProcessError("cancelled"));
      else if (failure) reject(failure);
      else if (code !== 0 || signal || !result) reject(new GraphCandidateProcessError("failed"));
      else resolve(result);
    });
    try {
      if (child.pid) options.__internal?.onSpawn?.(child.pid, request.workspace);
      if (options.signal?.aborted) cancelled();
    } catch {
      stop(new GraphCandidateProcessError("failed"));
    }
  });
}

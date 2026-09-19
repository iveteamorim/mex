import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MexPortError } from "../../../team/contracts/shared.js";
import { TeamLocalState } from "../../../team/local-state/index.js";
import {
  generateHubJobId,
  HubJobError,
  HubJobManager,
} from "../index.js";
import type {
  HubJobExecutorContext,
  HubJobSnapshot,
} from "../index.js";

const NOW = "2026-08-23T10:00:00.000Z";
const LATER = "2026-08-23T10:01:00.000Z";
const JOB_A = "job_01K3CQW3G00000000000000000";
const JOB_B = "job_01K3CQW3G00000000000000001";
const JOB_C = "job_01K3CQW3G00000000000000002";
const LEASE_A = "a".repeat(64);
const LEASE_B = "b".repeat(64);
const PID_A = 41_001;
const PID_B = 41_002;

const roots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-jobs-"));
  roots.push(root);
  return root;
}

function localState(
  root: string,
  now = NOW,
  processStatus?: (pid: number) => "alive" | "dead" | "ambiguous",
): TeamLocalState {
  return new TeamLocalState({
    projectRoot: root,
    scaffoldId: "scaffold-a",
    now: () => now,
    ...(processStatus === undefined ? {} : { processStatus }),
  });
}

function acquire(store: TeamLocalState, token = LEASE_A, pid = PID_A): void {
  store.acquireHubJobLease({ pid, token, acquiredAt: NOW });
}

function expectPortCode(operation: () => unknown, code: string): MexPortError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MexPortError);
    expect((error as MexPortError).problem.code).toBe(code);
    return error as MexPortError;
  }
  throw new Error(`Expected ${code}`);
}

async function waitForState(
  manager: HubJobManager,
  id: string,
  state: HubJobSnapshot["state"],
): Promise<HubJobSnapshot> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = manager.get(id);
    if (job?.state === state) return job;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Job ${id} did not reach ${state}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("HubJobManager", () => {
  it.each(["success", "failure", "cancelled", "shutdown"] as const)(
    "reports one durable %s outcome without subscribers, progress, or historical replay",
    async (outcome) => {
      const root = tempProject();
      const telemetry = vi.fn();
      let now = NOW;
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const manager = new HubJobManager({
        localState: localState(root), telemetry, now: () => now, generateId: () => JOB_A,
        executors: { graph_refresh: async ({ reportProgress, signal }) => {
          reportProgress({ phase: "parse", completed: 4, total: 4 });
          signal.addEventListener("abort", finish, { once: true });
          await pending;
          if (outcome === "failure") throw new Error("/private/source.ts private@example.test");
        } },
      });
      manager.initialize();
      const job = manager.start({ kind: "graph_refresh" });
      await waitForState(manager, job.id, "running");
      expect(telemetry).not.toHaveBeenCalled();
      now = LATER;
      if (outcome === "shutdown") await manager.shutdown();
      else {
        if (outcome === "cancelled") manager.cancel(job.id);
        finish();
        await waitForState(manager, job.id, outcome === "success" ? "succeeded" : outcome === "failure" ? "failed" : "interrupted");
        manager.cancel(job.id);
        const unsubscribe = manager.subscribe(job.id, () => undefined);
        unsubscribe();
        manager.list();
        await manager.shutdown();
      }
      expect(telemetry.mock.calls).toEqual([["hub.job_completed", {
        job_kind: "graph_refresh", outcome: outcome === "shutdown" ? "cancelled" : outcome, duration_ms: 60_000,
      }]]);
      expect(JSON.stringify(telemetry.mock.calls)).not.toMatch(/private|job_01|scaffold|revision/);
      const restarted = new HubJobManager({ localState: localState(root), telemetry, now: () => LATER });
      restarted.initialize();
      restarted.get(job.id);
      restarted.list();
      await restarted.shutdown();
      expect(telemetry).toHaveBeenCalledOnce();
    },
  );

  it("reports queued cancellation once even when the queued executor never starts", async () => {
    const telemetry = vi.fn();
    const execute = vi.fn(async () => undefined);
    const manager = new HubJobManager({ localState: localState(tempProject()), telemetry,
      now: () => NOW, executors: { wiki_refresh: execute } });
    manager.initialize();
    const job = manager.start({ kind: "wiki_refresh" });
    manager.cancel(job.id);
    manager.cancel(job.id);
    await manager.shutdown();
    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.mock.calls).toEqual([["hub.job_completed", {
      job_kind: "wiki_refresh", outcome: "cancelled", duration_ms: 0,
    }]]);
  });

  it("generates standard job-prefixed ULIDs", () => {
    expect(generateHubJobId(0, new Uint8Array(10))).toBe(
      "job_00000000000000000000000000",
    );
    expect(generateHubJobId(Date.parse(NOW), new Uint8Array(10))).toMatch(
      /^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
    );
  });

  it("does not create local state for an absent read", () => {
    const root = tempProject();
    expect(localState(root).listHubJobs()).toEqual({ items: [] });
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });

  it("requires an injected capability and never creates a fake job", () => {
    const root = tempProject();
    const manager = new HubJobManager({ localState: localState(root), now: () => NOW });
    manager.initialize();

    expect(() => manager.start({ kind: "wiki_refresh" })).toThrowError(HubJobError);
    try {
      manager.start({ kind: "wiki_refresh" });
    } catch (error) {
      expect((error as HubJobError).problem).toMatchObject({
        status: 503,
        code: "CAPABILITY_UNAVAILABLE",
      });
    }
    expect(manager.list().items).toEqual([]);
  });

  it("fails closed for live or ambiguous repository lease holders", async () => {
    const root = tempProject();
    const first = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      processId: PID_A,
      leaseToken: LEASE_A,
    });
    first.initialize();

    for (const status of ["alive", "ambiguous"] as const) {
      const contender = new HubJobManager({
        localState: localState(root, NOW, () => status),
        now: () => NOW,
        processId: PID_B,
        leaseToken: LEASE_B,
      });
      expectPortCode(() => contender.initialize(), "JOB_ALREADY_RUNNING");
    }
    expectPortCode(
      () => localState(root).releaseHubJobLease(LEASE_B),
      "REVISION_CONFLICT",
    );

    await first.shutdown();
    const next = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      processId: PID_B,
      leaseToken: LEASE_B,
    });
    expect(() => next.initialize()).not.toThrow();
    await next.shutdown();
  });

  it("persists monotonic progress and publishes current snapshots", async () => {
    const root = tempProject();
    let context: HubJobExecutorContext | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: () => JOB_A,
      executors: {
        graph_refresh: async (received) => {
          context = received;
          await pending;
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    const events: string[] = [];
    const unsubscribe = manager.subscribe(queued.id, (event) => {
      events.push(`${event.type}:${event.job.state}:${event.job.progress?.completed ?? "none"}`);
    });

    await waitForState(manager, queued.id, "running");
    expect(context).toBeDefined();
    context!.reportProgress({ phase: "discover" });
    expect(manager.get(queued.id)).toMatchObject({ phase: "discover", progress: null });
    context!.reportProgress({ completed: 1, total: 2, phase: "refreshing" });
    context!.reportProgress({ completed: 2, phase: "finalizing" });
    finish();

    const succeeded = await waitForState(manager, queued.id, "succeeded");
    expect(succeeded).toMatchObject({
      generation: 1,
      phase: "complete",
      progress: { completed: 2, total: 2 },
    });
    expect(events).toEqual([
      "snapshot:queued:none",
      "progress:running:none",
      "progress:running:none",
      "progress:running:1",
      "progress:running:2",
      "terminal:succeeded:2",
    ]);
    unsubscribe();
  });

  it("retains parsed file counts through later graph phases and suppresses duplicate phase updates", async () => {
    const root = tempProject();
    let context: HubJobExecutorContext | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: () => JOB_A,
      executors: { graph_refresh: async (received) => { context = received; await pending; } },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    await waitForState(manager, queued.id, "running");
    context!.reportProgress({ phase: "parse", completed: 2, total: 2 });
    expect(manager.get(queued.id)?.progress).toEqual({ completed: 2, total: 2 });
    context!.reportProgress({ phase: "resolve" });
    const resolving = manager.get(queued.id);
    expect(resolving).toMatchObject({ phase: "resolve", progress: { completed: 2, total: 2 } });
    context!.reportProgress({ phase: "resolve" });
    expect(manager.get(queued.id)).toEqual(resolving);
    context!.reportProgress({ phase: "validate" });
    expect(manager.get(queued.id)).toMatchObject({ phase: "validate", progress: { completed: 2, total: 2 } });
    finish();
    expect(await waitForState(manager, queued.id, "succeeded")).toMatchObject({ progress: { completed: 2, total: 2 } });
  });

  it("does not persist or publish an identical progress snapshot", async () => {
    const root = tempProject();
    const store = localState(root);
    const originalUpdate = store.updateHubJobRecord.bind(store);
    let updateCalls = 0;
    store.updateHubJobRecord = ((request) => {
      updateCalls += 1;
      return originalUpdate(request);
    }) as TeamLocalState["updateHubJobRecord"];
    let context: HubJobExecutorContext | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = new HubJobManager({
      localState: store,
      now: () => NOW,
      generateId: () => JOB_A,
      executors: {
        wiki_rebuild: async (received) => {
          context = received;
          await pending;
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "wiki_rebuild" });
    const events: HubJobSnapshot[] = [];
    const unsubscribe = manager.subscribe(queued.id, (event) => {
      if (event.type === "progress") events.push(event.job);
    });

    await waitForState(manager, queued.id, "running");
    context!.reportProgress({ phase: "parse", completed: 0, total: 3 });
    const parsing = manager.get(queued.id)!;
    const callsWhileParsing = updateCalls;
    const eventsWhileParsing = events.length;

    context!.reportProgress({ phase: "publish" });

    const publishing = manager.get(queued.id)!;
    expect(updateCalls).toBe(callsWhileParsing + 1);
    expect(publishing).toMatchObject({
      phase: "publish",
      progress: { completed: 0, total: 3 },
    });
    expect(publishing.revision).not.toBe(parsing.revision);
    expect(events).toHaveLength(eventsWhileParsing + 1);

    const dbPath = join(root, ".mex/local/team.db");
    const durableBytes = readFileSync(dbPath);
    const durableMtime = statSync(dbPath, { bigint: true }).mtimeNs;
    const callsWhilePublishing = updateCalls;
    const eventsWhilePublishing = events.length;

    context!.reportProgress({ phase: "publish" });

    expect(updateCalls).toBe(callsWhilePublishing);
    expect(manager.get(queued.id)).toEqual(publishing);
    expect(readFileSync(dbPath)).toEqual(durableBytes);
    expect(statSync(dbPath, { bigint: true }).mtimeNs).toBe(durableMtime);
    expect(events).toHaveLength(eventsWhilePublishing);

    context!.reportProgress({ completed: 1 });
    expect(updateCalls).toBe(callsWhilePublishing + 1);
    expect(manager.get(queued.id)).toMatchObject({
      phase: "publish",
      progress: { completed: 1, total: 3 },
    });
    expect(manager.get(queued.id)?.revision).not.toBe(publishing.revision);
    expect(events).toHaveLength(eventsWhilePublishing + 1);

    finish();
    await waitForState(manager, queued.id, "succeeded");
    unsubscribe();
  });

  it("enforces one active index mutation per scaffold transactionally", () => {
    const root = tempProject();
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: (() => {
        const ids = [JOB_A, JOB_B, JOB_C];
        return () => ids.shift()!;
      })(),
      executors: {
        graph_refresh: async () => new Promise(() => undefined),
        wiki_rebuild: async () => new Promise(() => undefined),
      },
    });
    manager.initialize();
    manager.start({ kind: "graph_refresh" });

    const error = expectPortCode(
      () => manager.start({ kind: "wiki_rebuild" }),
      "JOB_ALREADY_RUNNING",
    );
    expect(error.problem.detail).toContain(JOB_A);
    expect((error.problem as typeof error.problem & { activeJobId: string }).activeJobId).toBe(JOB_A);
    expect(manager.list().items).toHaveLength(1);
  });

  it("cancels with AbortSignal and ignores late progress", async () => {
    const root = tempProject();
    let context: HubJobExecutorContext | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: (() => {
        const ids = [JOB_A, JOB_B, JOB_C];
        return () => ids.shift()!;
      })(),
      executors: {
        graph_rebuild: async (received) => {
          context = received;
          await pending;
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_rebuild" });
    await waitForState(manager, queued.id, "running");

    const cancellationRequested = manager.cancel(queued.id);
    expect(cancellationRequested).toMatchObject({
      state: "running",
      cancelRequested: true,
    });
    expect(context!.signal.aborted).toBe(true);
    context!.reportProgress({ completed: 99, total: 100 });

    const conflict = expectPortCode(
      () => manager.start({ kind: "graph_rebuild" }),
      "JOB_ALREADY_RUNNING",
    );
    expect(conflict.problem.detail).toContain(JOB_A);
    expect(manager.get(queued.id)).toEqual(cancellationRequested);

    finish();
    const interrupted = await waitForState(manager, queued.id, "interrupted");
    expect(interrupted).toMatchObject({
      cancelRequested: true,
      interruptedReason: "user_cancelled",
    });
    expect(() => manager.start({ kind: "graph_rebuild" })).not.toThrow();
  });

  it("enters closing before abort and releases the lease only after settlement", async () => {
    const root = tempProject();
    let context: HubJobExecutorContext | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      processId: PID_A,
      leaseToken: LEASE_A,
      generateId: () => JOB_A,
      executors: {
        graph_refresh: async (received) => {
          context = received;
          await pending;
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    await waitForState(manager, queued.id, "running");

    const closing = manager.shutdown();
    expect(context!.signal.aborted).toBe(true);
    expect(manager.get(queued.id)?.state).toBe("running");
    expect(() => manager.start({ kind: "graph_refresh" })).toThrowError(HubJobError);
    finish();
    await closing;

    expect(manager.get(queued.id)).toMatchObject({
      state: "interrupted",
      interruptedReason: "process_shutdown",
    });
    const next = new HubJobManager({
      localState: localState(root),
      now: () => LATER,
      processId: PID_B,
      leaseToken: LEASE_B,
    });
    expect(() => next.initialize()).not.toThrow();
    await next.shutdown();
  });

  it("times out visibly while retaining the active row and repository lease", async () => {
    const root = tempProject();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      processId: PID_A,
      leaseToken: LEASE_A,
      shutdownTimeoutMs: 10,
      generateId: () => JOB_A,
      executors: {
        graph_rebuild: async () => pending,
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_rebuild" });
    await waitForState(manager, queued.id, "running");

    await expect(manager.shutdown()).rejects.toMatchObject({
      problem: { code: "OPERATION_INTERRUPTED" },
    });
    expect(manager.get(queued.id)?.state).toBe("running");
    expect(() => manager.start({ kind: "graph_rebuild" })).toThrowError(HubJobError);

    const contender = new HubJobManager({
      localState: localState(root, LATER, () => "alive"),
      now: () => LATER,
      processId: PID_B,
      leaseToken: LEASE_B,
    });
    expectPortCode(() => contender.initialize(), "JOB_ALREADY_RUNNING");

    finish();
    await waitForState(manager, queued.id, "interrupted");
    await manager.shutdown();
  });

  it("settles a queued cancellation without invoking its executor", async () => {
    const root = tempProject();
    let invoked = false;
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: () => JOB_A,
      executors: {
        graph_refresh: async () => {
          invoked = true;
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    const interrupted = manager.cancel(queued.id);

    expect(interrupted).toMatchObject({
      state: "interrupted",
      cancelRequested: true,
      interruptedReason: "user_cancelled",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(invoked).toBe(false);
    expect(manager.get(queued.id)).toEqual(interrupted);
  });

  it("reconciles active jobs after restart and rejects late generations", async () => {
    const root = tempProject();
    let context: HubJobExecutorContext | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      processId: PID_A,
      leaseToken: LEASE_A,
      generateId: () => JOB_A,
      executors: {
        wiki_refresh: async (received) => {
          context = received;
          await pending;
        },
      },
    });
    first.initialize();
    const queued = first.start({ kind: "wiki_refresh" });
    await waitForState(first, queued.id, "running");

    const restarted = new HubJobManager({
      localState: localState(root, LATER, (pid) => pid === PID_A ? "dead" : "alive"),
      now: () => LATER,
      processId: PID_B,
      leaseToken: LEASE_B,
    });
    restarted.initialize();
    const interrupted = restarted.get(queued.id)!;
    expect(interrupted).toMatchObject({
      state: "interrupted",
      finishedAt: LATER,
      interruptedReason: "process_restart",
    });

    context!.reportProgress({ completed: 1 });
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(restarted.get(queued.id)).toEqual(interrupted);
  });

  it("reconciles stale active jobs across every scaffold protected by the repository lease", () => {
    const root = tempProject();
    const first = localState(root);
    const second = new TeamLocalState({
      projectRoot: root,
      scaffoldId: "scaffold-b",
      now: () => NOW,
    });
    acquire(first);
    const firstJob = first.createHubJobRecord({
      leaseToken: LEASE_A,
      id: JOB_A,
      kind: "graph_refresh",
      phase: "queued",
      createdAt: NOW,
    });
    const secondJob = second.createHubJobRecord({
      leaseToken: LEASE_A,
      id: JOB_B,
      kind: "wiki_refresh",
      phase: "queued",
      createdAt: NOW,
    });

    const reconciled = first.reconcileHubJobs(LATER, LEASE_A);
    expect(reconciled.interrupted.map((job) => job.id)).toEqual([JOB_A, JOB_B]);
    expect(first.getHubJob(firstJob.id)).toMatchObject({
      state: "interrupted",
      interruptedReason: "process_restart",
    });
    expect(second.getHubJob(secondJob.id)).toMatchObject({
      state: "interrupted",
      interruptedReason: "process_restart",
    });
    expect(() => first.releaseHubJobLease(LEASE_A)).not.toThrow();
  });

  it("persists a generic bounded failure without leaking executor text", async () => {
    const root = tempProject();
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: () => JOB_A,
      executors: {
        wiki_rebuild: async () => {
          throw new Error("secret-token=do-not-persist");
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "wiki_rebuild" });
    const failed = await waitForState(manager, queued.id, "failed");

    expect(failed.problem).toMatchObject({ code: "JOB_FAILED", status: 500 });
    expect(JSON.stringify(failed)).not.toContain("secret-token");
    expect(readFileSync(join(root, ".mex/local/team.db"), "utf8")).not.toContain(
      "secret-token",
    );
  });

  it("turns a transition failure fatal, persists a generic fallback, and refuses new work", async () => {
    const root = tempProject();
    const store = localState(root);
    const originalUpdate = store.updateHubJobRecord.bind(store);
    let failRunningTransition = true;
    store.updateHubJobRecord = ((request) => {
      if (failRunningTransition && request.state === "running") {
        throw new Error("storage path and secret must not escape");
      }
      return originalUpdate(request);
    }) as TeamLocalState["updateHubJobRecord"];
    const manager = new HubJobManager({
      localState: store,
      now: () => NOW,
      generateId: () => JOB_A,
      executors: { graph_refresh: async () => undefined },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    const failed = await waitForState(manager, queued.id, "failed");
    expect(failed.problem).toEqual({
      type: "about:blank",
      status: 500,
      code: "JOB_FAILED",
      title: "Hub job failed",
      detail: "The job did not complete. Retry it or inspect repository health.",
    });
    expect(JSON.stringify(failed)).not.toContain("storage path");
    expect(() => manager.start({ kind: "graph_refresh" })).toThrowError(HubJobError);
    failRunningTransition = false;
    await manager.shutdown();
  });

  it("retains the execution handle and lease when terminal persistence initially fails", async () => {
    const root = tempProject();
    const store = localState(root);
    const originalUpdate = store.updateHubJobRecord.bind(store);
    let failAllTransitions = true;
    store.updateHubJobRecord = ((request) => {
      if (failAllTransitions) throw new Error("simulated durable transition failure");
      return originalUpdate(request);
    }) as TeamLocalState["updateHubJobRecord"];
    const manager = new HubJobManager({
      localState: store,
      now: () => NOW,
      processId: PID_A,
      leaseToken: LEASE_A,
      generateId: () => JOB_A,
      executors: { graph_refresh: async () => undefined },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.get(queued.id)?.state).toBe("queued");
    expect(() => manager.start({ kind: "graph_refresh" })).toThrowError(HubJobError);

    failAllTransitions = false;
    await manager.shutdown();
    expect(manager.get(queued.id)).toMatchObject({
      state: "interrupted",
      interruptedReason: "process_shutdown",
    });

    const next = new HubJobManager({
      localState: localState(root),
      now: () => LATER,
      processId: PID_B,
      leaseToken: LEASE_B,
    });
    expect(() => next.initialize()).not.toThrow();
    await next.shutdown();
  });

  it("rejects executor text progress instead of persisting its contents", async () => {
    const root = tempProject();
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: () => JOB_A,
      executors: {
        graph_refresh: async (context) => {
          context.reportProgress({
            completed: 1,
            message: "system prompt secret-token=do-not-persist",
          } as never);
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    const failed = await waitForState(manager, queued.id, "failed");

    expect(failed.problem?.code).toBe("JOB_FAILED");
    expect(JSON.stringify(failed)).not.toContain("system prompt");
    expect(readFileSync(join(root, ".mex/local/team.db"), "utf8")).not.toContain(
      "do-not-persist",
    );
  });

  it("rejects non-allowlisted executor progress phases", async () => {
    const root = tempProject();
    const manager = new HubJobManager({
      localState: localState(root),
      now: () => NOW,
      generateId: () => JOB_A,
      executors: {
        wiki_refresh: async (context) => {
          context.reportProgress({ completed: 1, phase: "arbitrary phase" } as never);
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "wiki_refresh" });
    const failed = await waitForState(manager, queued.id, "failed");

    expect(failed.problem?.code).toBe("JOB_FAILED");
    expect(JSON.stringify(failed)).not.toContain("arbitrary phase");
    await manager.shutdown();
  });

  it("marks a progress read failure fatal even when storage recovers", async () => {
    const root = tempProject();
    const store = localState(root);
    const originalGet = store.getHubJob.bind(store);
    let context: HubJobExecutorContext | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = new HubJobManager({
      localState: store,
      now: () => NOW,
      generateId: () => JOB_A,
      executors: {
        graph_refresh: async (received) => {
          context = received;
          await pending;
        },
      },
    });
    manager.initialize();
    const queued = manager.start({ kind: "graph_refresh" });
    await waitForState(manager, queued.id, "running");

    let failNextRead = true;
    store.getHubJob = ((id) => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("transient storage failure");
      }
      return originalGet(id);
    }) as TeamLocalState["getHubJob"];
    expect(() => context!.reportProgress({ completed: 1 })).toThrow();
    expect(() => manager.start({ kind: "graph_refresh" })).toThrowError(HubJobError);

    finish();
    const failed = await waitForState(manager, queued.id, "failed");
    expect(failed.problem?.code).toBe("JOB_FAILED");
    await manager.shutdown();
  });

  it("rejects regressing progress and leaves durable bytes unchanged", () => {
    const root = tempProject();
    const store = localState(root);
    acquire(store);
    const queued = store.createHubJobRecord({
      leaseToken: LEASE_A,
      id: JOB_A,
      kind: "graph_refresh",
      phase: "queued",
      createdAt: NOW,
    });
    const running = store.updateHubJobRecord({
      leaseToken: LEASE_A,
      id: queued.id,
      generation: queued.generation,
      expectedRevision: queued.revision,
      phase: "running",
      progress: { completed: 2, total: 4 },
      cancelRequested: false,
      state: "running",
      startedAt: NOW,
    });
    const dbPath = join(root, ".mex/local/team.db");
    const before = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath, { bigint: true }).mtimeNs;

    expectPortCode(() => store.updateHubJobRecord({
      leaseToken: LEASE_A,
      id: running.id,
      generation: running.generation,
      expectedRevision: running.revision,
      phase: "running",
      progress: { completed: 1, total: 4 },
      cancelRequested: false,
      state: "running",
      startedAt: NOW,
    }), "VALIDATION_FAILED");
    expect(readFileSync(dbPath)).toEqual(before);
    expect(statSync(dbPath, { bigint: true }).mtimeNs).toBe(beforeMtime);
  });

  it("rejects mismatched create phases transactionally", () => {
    const root = tempProject();
    const store = localState(root);
    acquire(store);
    expectPortCode(() => store.createHubJobRecord({
      leaseToken: LEASE_A,
      id: JOB_A,
      kind: "graph_refresh",
      phase: "failed",
      createdAt: NOW,
    }), "VALIDATION_FAILED");
    expect(store.listHubJobs()).toEqual({ items: [] });
  });

  it("retains only the newest 200 terminal records with stable pagination", () => {
    const root = tempProject();
    const store = localState(root);
    acquire(store);
    const base = Date.parse(NOW);
    let firstId = "";
    let newestId = "";

    for (let index = 0; index < 201; index += 1) {
      const timestamp = new Date(base + index).toISOString();
      const id = generateHubJobId(base + index, new Uint8Array(10));
      if (index === 0) firstId = id;
      newestId = id;
      const queued = store.createHubJobRecord({
        leaseToken: LEASE_A,
        id,
        kind: "graph_refresh",
        phase: "queued",
        createdAt: timestamp,
      });
      const running = store.updateHubJobRecord({
        leaseToken: LEASE_A,
        id,
        generation: queued.generation,
        expectedRevision: queued.revision,
        phase: "running",
        progress: null,
        cancelRequested: false,
        state: "running",
        startedAt: timestamp,
      });
      store.updateHubJobRecord({
        leaseToken: LEASE_A,
        id,
        generation: running.generation,
        expectedRevision: running.revision,
        phase: "complete",
        progress: null,
        cancelRequested: false,
        state: "succeeded",
        startedAt: timestamp,
        finishedAt: timestamp,
      });
    }

    const firstPage = store.listHubJobs({ limit: 100 });
    const secondPage = store.listHubJobs({
      limit: 100,
      cursor: firstPage.nextCursor,
    });
    expect(firstPage.items).toHaveLength(100);
    expect(secondPage.items).toHaveLength(100);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(firstPage.items[0]?.id).toBe(newestId);
    expect(store.getHubJob(firstId)).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((job) => job.id)).size).toBe(200);
  }, 30_000);
});

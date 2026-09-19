import { describe, expect, it, vi } from "vitest";
import type { RepositoryGraphPort } from "../../../graph/application-adapter.js";
import { createGraphJobExecutors } from "../graph.js";

describe("graph Hub job executors", () => {
  it("passes cancellation and only projects allowlisted numeric maintenance progress", async () => {
    const refresh = vi.fn(async (options: {
      signal?: AbortSignal;
      onProgress?: (progress: {
        phase: "discover" | "parse";
        completed?: number;
        total?: number;
        message: string;
      }) => void;
    }) => {
      options.onProgress?.({ phase: "discover", message: "private path /Users/alice/project" });
      options.onProgress?.({ phase: "parse", completed: 2, total: 4, message: "two files" });
    });
    const graph = { refresh, rebuild: vi.fn() } as unknown as RepositoryGraphPort;
    const executor = createGraphJobExecutors(graph).graph_refresh!;
    const controller = new AbortController();
    const updates: unknown[] = [];

    await executor({
      job: {} as never,
      signal: controller.signal,
      reportProgress: (update) => updates.push(update),
    });

    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(updates).toEqual([
      { phase: "discover" },
      { phase: "parse", completed: 2, total: 4 },
    ]);
    expect(JSON.stringify(updates)).not.toContain("/Users/alice");
  });
});

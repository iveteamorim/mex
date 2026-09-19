import { describe, expect, it, vi } from "vitest";
import type { HubJobSnapshot } from "../types.js";
import { createWikiJobExecutors } from "../wiki.js";
import type { RepositoryWikiPort } from "../../../wiki/application-adapter.js";

const job = {} as HubJobSnapshot;

describe("createWikiJobExecutors", () => {
  it("discovers the exact changed set and forwards cancellation and numeric phases", async () => {
    const discoverRefreshPaths = vi.fn(async () => [
      ".mex/context/architecture.md",
      ".mex/context/deleted.md",
    ]);
    const refreshFiles = vi.fn(async (_paths, context) => {
      context.reportProgress?.({
        phase: "parse",
        completed: 1,
        total: 2,
        message: "must never be persisted",
      });
    });
    const wiki = {
      discoverRefreshPaths,
      refreshFiles,
      rebuildIndex: vi.fn(),
    } as unknown as RepositoryWikiPort;
    const reportProgress = vi.fn();
    const controller = new AbortController();

    await createWikiJobExecutors(wiki).wiki_refresh?.({
      job,
      signal: controller.signal,
      reportProgress,
    });

    expect(discoverRefreshPaths).toHaveBeenCalledOnce();
    expect(refreshFiles).toHaveBeenCalledWith(
      [".mex/context/architecture.md", ".mex/context/deleted.md"],
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(reportProgress).toHaveBeenNthCalledWith(1, { phase: "discover" });
    expect(reportProgress).toHaveBeenNthCalledWith(2, {
      phase: "parse",
      completed: 1,
      total: 2,
    });
    expect(JSON.stringify(reportProgress.mock.calls)).not.toContain("must never be persisted");
  });

  it("treats a concurrently fresh empty discovery as a successful no-op", async () => {
    const refreshFiles = vi.fn();
    const wiki = {
      discoverRefreshPaths: vi.fn(async () => []),
      refreshFiles,
      rebuildIndex: vi.fn(),
    } as unknown as RepositoryWikiPort;
    const reportProgress = vi.fn();

    await createWikiJobExecutors(wiki).wiki_refresh?.({
      job,
      signal: new AbortController().signal,
      reportProgress,
    });

    expect(reportProgress).toHaveBeenCalledWith({ phase: "discover" });
    expect(refreshFiles).not.toHaveBeenCalled();
  });

  it("runs rebuild with the manager AbortSignal and fixed safe progress", async () => {
    const rebuildIndex = vi.fn(async (context) => {
      context.reportProgress?.({
        phase: "publish",
        completed: 3,
        total: 3,
        message: "/private/path must be omitted",
      });
    });
    const wiki = {
      discoverRefreshPaths: vi.fn(),
      refreshFiles: vi.fn(),
      rebuildIndex,
    } as unknown as RepositoryWikiPort;
    const controller = new AbortController();
    const reportProgress = vi.fn();

    await createWikiJobExecutors(wiki).wiki_rebuild?.({
      job,
      signal: controller.signal,
      reportProgress,
    });

    expect(rebuildIndex).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(reportProgress).toHaveBeenCalledWith({ phase: "publish", completed: 3, total: 3 });
  });
});

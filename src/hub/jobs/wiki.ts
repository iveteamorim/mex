import type { IndexProgress } from "../../team/contracts/shared.js";
import type { RepositoryWikiPort } from "../../wiki/application-adapter.js";
import type { HubJobExecutors, HubJobProgressUpdate } from "./types.js";

/** Production Wiki executors. Every write is an explicit durable Hub job. */
export function createWikiJobExecutors(wiki: RepositoryWikiPort): HubJobExecutors {
  return {
    wiki_refresh: async ({ signal, reportProgress }) => {
      reportProgress({ phase: "discover" });
      const changedPaths = await wiki.discoverRefreshPaths();
      signal.throwIfAborted();
      // A concurrent CLI refresh may make the exact changed set empty between
      // eligibility and execution. That is a truthful successful no-op.
      if (changedPaths.length === 0) return;
      await wiki.refreshFiles(changedPaths, {
        signal,
        reportProgress: (progress) => reportProgress(projectProgress(progress)),
      });
    },
    wiki_rebuild: async ({ signal, reportProgress }) => {
      await wiki.rebuildIndex({
        signal,
        reportProgress: (progress) => reportProgress(projectProgress(progress)),
      });
    },
  };
}

function projectProgress(progress: IndexProgress): HubJobProgressUpdate {
  return {
    phase: asWikiPhase(progress.phase),
    ...(progress.completed === undefined ? {} : { completed: progress.completed }),
    ...(progress.total === undefined ? {} : { total: progress.total }),
  };
}

function asWikiPhase(phase: string): HubJobProgressUpdate["phase"] {
  return ["discover", "stage", "parse", "resolve", "validate", "publish"].includes(phase)
    ? phase as HubJobProgressUpdate["phase"]
    : "running";
}

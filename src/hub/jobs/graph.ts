import type { GraphMaintenanceProgress } from "../../team/contracts/graph.js";
import type { RepositoryGraphPort } from "../../graph/application-adapter.js";
import type { HubJobExecutors, HubJobProgressUpdate } from "./types.js";

/** Production graph executors. Maintenance remains explicit and capability-injected. */
export function createGraphJobExecutors(graph: RepositoryGraphPort): HubJobExecutors {
  return {
    graph_refresh: async ({ signal, reportProgress }) => {
      await graph.refresh({
        signal,
        onProgress: (progress) => reportProgress(projectProgress(progress)),
      });
    },
    graph_rebuild: async ({ signal, reportProgress }) => {
      await graph.rebuild({
        signal,
        onProgress: (progress) => reportProgress(projectProgress(progress)),
      });
    },
  };
}

function projectProgress(progress: GraphMaintenanceProgress): HubJobProgressUpdate {
  return {
    phase: progress.phase,
    ...(progress.completed === undefined ? {} : { completed: progress.completed }),
    ...(progress.total === undefined ? {} : { total: progress.total }),
  };
}

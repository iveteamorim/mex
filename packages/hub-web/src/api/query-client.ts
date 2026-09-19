import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

export const MAX_INACTIVE_QUERY_CACHE_ENTRIES = 32;
export const MAX_INACTIVE_MUTATION_CACHE_ENTRIES = 32;

function pruneInactiveQueries(queryCache: QueryCache): void {
  const inactive = queryCache
    .getAll()
    .filter((query) => query.getObserversCount() === 0)
    .sort((left, right) => {
      const leftUpdatedAt = Math.max(left.state.dataUpdatedAt, left.state.errorUpdatedAt);
      const rightUpdatedAt = Math.max(right.state.dataUpdatedAt, right.state.errorUpdatedAt);
      return leftUpdatedAt - rightUpdatedAt || left.queryHash.localeCompare(right.queryHash);
    });
  const excess = inactive.length - MAX_INACTIVE_QUERY_CACHE_ENTRIES;
  for (const query of inactive.slice(0, Math.max(0, excess))) queryCache.remove(query);
}

function pruneInactiveMutations(
  mutationCache: MutationCache,
  observedMutations: ReadonlySet<object>,
): void {
  const inactive = mutationCache
    .getAll()
    .filter((mutation) => mutation.state.status !== "pending" && !observedMutations.has(mutation))
    .sort((left, right) => left.mutationId - right.mutationId);
  const excess = inactive.length - MAX_INACTIVE_MUTATION_CACHE_ENTRIES;
  for (const mutation of inactive.slice(0, Math.max(0, excess))) mutationCache.remove(mutation);
}

export function createHubQueryClient(): QueryClient {
  const queryCache = new QueryCache();
  const mutationCache = new MutationCache();
  const observedMutations = new Set<object>();
  let pruneQueued = false;
  let mutationPruneQueued = false;

  queryCache.subscribe((event) => {
    if (event.type === "removed") return;
    if (event.type === "added") {
      if (pruneQueued) return;
      pruneQueued = true;
      queueMicrotask(() => {
        pruneQueued = false;
        pruneInactiveQueries(queryCache);
      });
      return;
    }
    if (event.type === "observerAdded" || event.type === "observerRemoved" || event.type === "updated") {
      pruneInactiveQueries(queryCache);
    }
  });

  mutationCache.subscribe((event) => {
    if (event.type === "removed") {
      observedMutations.delete(event.mutation);
      return;
    }
    if (event.type === "observerAdded") {
      observedMutations.add(event.mutation);
      return;
    }
    if (event.type === "observerRemoved") {
      observedMutations.delete(event.mutation);
      pruneInactiveMutations(mutationCache, observedMutations);
      return;
    }
    if (event.type === "added") {
      if (mutationPruneQueued) return;
      mutationPruneQueued = true;
      queueMicrotask(() => {
        mutationPruneQueued = false;
        pruneInactiveMutations(mutationCache, observedMutations);
      });
      return;
    }
    if (event.type === "updated") pruneInactiveMutations(mutationCache, observedMutations);
  });

  return new QueryClient({
    queryCache,
    mutationCache,
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
      },
      mutations: { retry: false },
    },
  });
}

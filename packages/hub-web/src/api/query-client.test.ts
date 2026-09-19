import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  createHubQueryClient,
  MAX_INACTIVE_MUTATION_CACHE_ENTRIES,
  MAX_INACTIVE_QUERY_CACHE_ENTRIES,
} from "./query-client";

describe("Hub query cache", () => {
  it("evicts the oldest inactive queries at a hard entry limit", () => {
    const queryClient = createHubQueryClient();

    for (let index = 0; index < MAX_INACTIVE_QUERY_CACHE_ENTRIES + 4; index += 1) {
      queryClient.setQueryData(["inactive", index], index, { updatedAt: index + 1 });
    }

    const inactive = queryClient.getQueryCache().findAll({ queryKey: ["inactive"] });
    expect(inactive).toHaveLength(MAX_INACTIVE_QUERY_CACHE_ENTRIES);
    expect(queryClient.getQueryData(["inactive", 0])).toBeUndefined();
    expect(queryClient.getQueryData(["inactive", MAX_INACTIVE_QUERY_CACHE_ENTRIES + 3])).toBe(
      MAX_INACTIVE_QUERY_CACHE_ENTRIES + 3,
    );
  });

  it("never evicts a query while a mounted observer still owns it", () => {
    const queryClient = createHubQueryClient();
    queryClient.setQueryData(["active"], "retained", { updatedAt: 1 });
    const observer = new QueryObserver(queryClient, {
      queryKey: ["active"],
      queryFn: async () => "retained",
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    for (let index = 0; index < MAX_INACTIVE_QUERY_CACHE_ENTRIES + 4; index += 1) {
      queryClient.setQueryData(["inactive", index], index, { updatedAt: index + 2 });
    }

    expect(queryClient.getQueryData(["active"])).toBe("retained");
    expect(queryClient.getQueryCache().findAll({ queryKey: ["inactive"] })).toHaveLength(
      MAX_INACTIVE_QUERY_CACHE_ENTRIES,
    );
    unsubscribe();
  });

  it("caps settled mutations while preserving pending work", async () => {
    const queryClient = createHubQueryClient();
    let finishPending: (() => void) | undefined;
    const pending = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => new Promise<void>((resolve) => { finishPending = resolve; }),
    });
    const pendingExecution = pending.execute(undefined);

    for (let index = 0; index < MAX_INACTIVE_MUTATION_CACHE_ENTRIES + 4; index += 1) {
      const mutation = queryClient.getMutationCache().build(queryClient, {
        mutationFn: async (value: number) => value,
      });
      await mutation.execute(index);
    }

    expect(queryClient.getMutationCache().getAll().filter((mutation) => mutation.state.status !== "pending"))
      .toHaveLength(MAX_INACTIVE_MUTATION_CACHE_ENTRIES);
    expect(queryClient.getMutationCache().getAll()).toContain(pending);

    finishPending?.();
    await pendingExecution;
  });
});

/**
 * Clustering, against the inherited oracle.
 *
 * These five cases came with the pipeline and were written before this engine
 * existed, which is exactly what makes them worth keeping: they are a reading
 * of the clustering rules by someone who was not looking at this port. Every
 * expectation below is the one the reference asserted, unchanged; only the
 * import paths and the sync-not-async call moved.
 *
 * Four more follow them, for rules the inherited set does not exercise.
 */

import { describe, it, expect } from "vitest";
import { findClusters, resolveClusterKey } from "../cluster.js";
import type { ClusterGraphReader } from "../types.js";

function stubGraph(
  entries: Array<{ path: string; nodes: Array<{ id: string; kind: string }> }>,
): ClusterGraphReader {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.nodes]));
  return {
    listFiles: () => entries.map((entry) => ({ path: entry.path })),
    nodesInFile: (filePath) => byPath.get(filePath) ?? [],
  };
}

describe("findClusters", () => {
  it("clusters flat top-level modules", () => {
    const graph = stubGraph([
      {
        path: "auth/tokens.ts",
        nodes: [
          { id: "function:issueToken", kind: "function" },
          { id: "file:auth/tokens.ts", kind: "file" },
        ],
      },
      { path: "auth/session.ts", nodes: [{ id: "function:createSession", kind: "function" }] },
      { path: "billing/invoice.ts", nodes: [{ id: "function:createInvoice", kind: "function" }] },
      { path: "node_modules/lodash/index.js", nodes: [{ id: "function:get", kind: "function" }] },
    ]);

    const clusters = findClusters(graph);

    expect(clusters.map((cluster) => cluster.name)).toEqual(["auth", "billing"]);
    expect(clusters[0]!.files).toEqual(["auth/session.ts", "auth/tokens.ts"]);
    expect(clusters[0]!.nodeIds).toEqual(["function:createSession", "function:issueToken"]);
    // file-kind nodes excluded by default
    expect(clusters[0]!.nodeIds).not.toContain("file:auth/tokens.ts");
  });

  it("prefers src/<module> over treating src as a cluster", () => {
    const graph = stubGraph([
      { path: "src/payments/charge.ts", nodes: [{ id: "function:charge", kind: "function" }] },
      { path: "src/payments/refund.ts", nodes: [{ id: "function:refund", kind: "function" }] },
      { path: "src/api/handlers.ts", nodes: [{ id: "function:handle", kind: "function" }] },
    ]);

    const clusters = findClusters(graph);
    expect(clusters.map((cluster) => cluster.name)).toEqual(["api", "payments"]);
    expect(clusters.find((cluster) => cluster.name === "payments")!.files).toEqual([
      "src/payments/charge.ts",
      "src/payments/refund.ts",
    ]);
  });

  it("handles packages/<pkg>/src/<module> monorepo paths", () => {
    const graph = stubGraph([
      { path: "packages/core/src/auth/login.ts", nodes: [{ id: "function:login", kind: "function" }] },
      { path: "packages/core/src/shared/utils.ts", nodes: [{ id: "function:util", kind: "function" }] },
    ]);

    const clusters = findClusters(graph);
    expect(clusters.map((cluster) => cluster.name)).toEqual(["auth", "shared"]);
  });

  it("normalizes Windows separators and skips low-value folders", () => {
    const graph = stubGraph([
      { path: "docs\\guide.md", nodes: [{ id: "file:docs", kind: "file" }] },
      { path: "auth\\login.ts", nodes: [{ id: "function:login", kind: "function" }] },
    ]);

    const clusters = findClusters(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.name).toBe("auth");
    expect(clusters[0]!.files[0]).toBe("auth/login.ts");
  });

  it("returns clusters sorted by name", () => {
    const graph = stubGraph([
      { path: "payments/a.ts", nodes: [{ id: "f:1", kind: "function" }] },
      { path: "api/a.ts", nodes: [{ id: "f:2", kind: "function" }] },
      { path: "billing/a.ts", nodes: [{ id: "f:3", kind: "function" }] },
    ]);

    const clusters = findClusters(graph);
    expect(clusters.map((cluster) => cluster.name)).toEqual(["api", "billing", "payments"]);
  });
});

describe("clustering rules the inherited set does not reach", () => {
  it("keeps two same-named modules in different packages apart", () => {
    // The dedupe key carries the prefix, so `packages/a/src/auth` and
    // `packages/b/src/auth` are two clusters rather than one merged one whose
    // node ids come from two unrelated packages.
    const graph = stubGraph([
      { path: "packages/alpha/src/auth/a.ts", nodes: [{ id: "f:alpha", kind: "function" }] },
      { path: "packages/beta/src/auth/b.ts", nodes: [{ id: "f:beta", kind: "function" }] },
    ]);

    const clusters = findClusters(graph);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.name)).toEqual(["auth", "auth"]);
    expect(clusters[0]!.nodeIds).not.toEqual(clusters[1]!.nodeIds);
    // …and the tie is broken deterministically by the description, which
    // carries the prefix. Two clusters with one name must still sort stably.
    expect(clusters[0]!.description).not.toBe(clusters[1]!.description);
  });

  it("drops a folder that has files but no symbols", () => {
    // Asserted rather than assumed: a cluster of nothing but file nodes cannot
    // be grounded to, so proposing knowledge about it is proposing knowledge
    // about nothing.
    const graph = stubGraph([
      { path: "assetsx/logo.ts", nodes: [{ id: "file:assetsx/logo.ts", kind: "file" }] },
      { path: "auth/login.ts", nodes: [{ id: "function:login", kind: "function" }] },
    ]);

    expect(findClusters(graph).map((cluster) => cluster.name)).toEqual(["auth"]);
  });

  it("honours minFiles", () => {
    const graph = stubGraph([
      { path: "auth/a.ts", nodes: [{ id: "f:1", kind: "function" }] },
      { path: "auth/b.ts", nodes: [{ id: "f:2", kind: "function" }] },
      { path: "solo/a.ts", nodes: [{ id: "f:3", kind: "function" }] },
    ]);

    expect(findClusters(graph, { minFiles: 2 }).map((cluster) => cluster.name)).toEqual(["auth"]);
  });

  it("resolves every documented path shape", () => {
    // The rules are an ordered list and the order is the whole content of the
    // function, so each rung is named rather than inferred from one example.
    expect(resolveClusterKey("README.md")).toBeNull();
    expect(resolveClusterKey("dist/auth/x.ts")).toBeNull();
    expect(resolveClusterKey("src/index.ts")).toBeNull();
    expect(resolveClusterKey("test/auth/x.ts")).toBeNull();
    expect(resolveClusterKey("src/__tests__/x.ts")).toBeNull();
    expect(resolveClusterKey("packages/core/bar.ts")).toEqual({ name: "core", prefix: "packages/core" });
    expect(resolveClusterKey("apps/web/src/api/h.ts")).toEqual({ name: "api", prefix: "apps/web/src" });
    expect(resolveClusterKey("lib/billing/x.ts")).toEqual({ name: "billing", prefix: "lib" });
    expect(resolveClusterKey("auth/x.ts")).toEqual({ name: "auth", prefix: "auth" });
  });

  it("is deterministic over the same graph", () => {
    // T12: the only non-determinism in this flow lives in the agent's model,
    // outside mex. Two runs over one graph must be byte-identical.
    const graph = stubGraph([
      { path: "src/payments/charge.ts", nodes: [{ id: "f:2", kind: "function" }, { id: "f:1", kind: "class" }] },
      { path: "src/auth/login.ts", nodes: [{ id: "f:3", kind: "function" }] },
    ]);

    expect(JSON.stringify(findClusters(graph))).toBe(JSON.stringify(findClusters(graph)));
  });
});

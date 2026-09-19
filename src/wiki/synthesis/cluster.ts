/**
 * §12.3 step 1 — MEX deterministically selects code scope.
 *
 * Clustering reads the repository's own folder layout rather than running a
 * graph algorithm over it, and that is a deliberate choice rather than a
 * simplification: a folder named `auth` is a statement its authors made about
 * what belongs together, and a community-detection pass over a call graph
 * produces groupings nobody recognizes and nobody can name. The output is a
 * list of clusters whose names a reader of the repository would have written
 * themselves.
 *
 * Pure. No filesystem, no model, no writes. The reads it makes are the two on
 * {@link ClusterGraphReader}, which is why the whole stage is testable against
 * an object literal.
 */

import type { Cluster, ClusterGraphReader, FindClustersOptions } from "./types.js";

/** Path segments that never form or contribute to a cluster. */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".svn",
  ".hg",
  ".mex",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  "bin",
  "obj",
  "tmp",
  "temp",
  ".idea",
  ".vscode",
]);

/**
 * Names that are not application modules.
 *
 * Overlaps `isLowValueGraphPath` in `src/graph/retrieval/query.ts` and is
 * deliberately not shared with it: that one decides what a *retrieval* answer
 * should rank down, this one decides what knowledge may be *proposed* about,
 * and the two lists have drifted apart already — this one excludes `docs`,
 * `scripts`, `assets` and `migrations`, which retrieval has no reason to. One
 * list serving two questions is how a rule ends up wrong for both.
 */
const LOW_VALUE_CLUSTER_NAMES = new Set([
  "docs",
  "doc",
  "documentation",
  "scripts",
  "script",
  "examples",
  "example",
  "fixtures",
  "fixture",
  "samples",
  "sample",
  "assets",
  "static",
  "public",
  "images",
  "img",
  "css",
  "styles",
  "fonts",
  ".github",
  ".gitlab",
  ".circleci",
  "e2e",
  "__mocks__",
  "migrations",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
]);

/** Directories that wrap modules rather than being modules. */
const CONTAINER_DIRS = new Set(["src", "lib", "app", "source"]);

/** Monorepo wrappers: the segment after one of these is a package name. */
const WORKSPACE_WRAPPERS = new Set(["packages", "apps", "services", "modules"]);

/**
 * Node kinds worth grounding a claim to.
 *
 * Checked against `NODE_KINDS` in `src/graph/types.ts`: every name here is one
 * mex's extractor actually produces, and the ones left out — `file`, `import`,
 * `export`, `parameter`, `enum_member` — are structure rather than
 * declarations anyone writes prose about.
 */
const SYMBOL_KINDS = new Set([
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "enum",
  "type_alias",
  "namespace",
  "module",
  "component",
  "route",
  "constant",
  "variable",
  "property",
  "field",
]);

/** POSIX separators, no leading `./`. Windows callers hand over backslashes. */
export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Map a repository-relative path to a cluster key, or null to exclude it.
 *
 * Decision order, first match wins:
 *
 * 1. anything under an ignored segment is dropped;
 * 2. `packages|apps|services|modules/<pkg>/[src|lib]/<module>/…` gives
 *    `<module>`, or `<pkg>` when there is no module folder;
 * 3. `src|lib|app|source/<module>/…` gives `<module>`;
 * 4. otherwise the top-level folder;
 * 5. a file at the repository root gives nothing — there is no honest module
 *    name for it, and a synthetic `root` cluster would collect every stray
 *    config file in the repository under one heading.
 *
 * Exported because the order *is* the rule, and a test that only ever sees the
 * finished clusters cannot say which rung produced one.
 */
export function resolveClusterKey(filePath: string): { name: string; prefix: string } | null {
  const segments = normalizeRepoPath(filePath).split("/").filter(Boolean);
  if (segments.length < 2) return null;
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()))) return null;

  const first = segments[0]!.toLowerCase();

  if (WORKSPACE_WRAPPERS.has(first) && segments.length >= 3) {
    const packageName = segments[1]!;
    const next = segments[2]?.toLowerCase();
    if (next !== undefined && CONTAINER_DIRS.has(next) && segments.length > 4) {
      const moduleName = segments[3]!;
      if (LOW_VALUE_CLUSTER_NAMES.has(moduleName.toLowerCase())) return null;
      return { name: moduleName, prefix: segments.slice(0, 3).join("/") };
    }
    if (LOW_VALUE_CLUSTER_NAMES.has(packageName.toLowerCase())) return null;
    return { name: packageName, prefix: segments.slice(0, 2).join("/") };
  }

  if (CONTAINER_DIRS.has(first) && segments.length >= 3) {
    const moduleName = segments[1]!;
    if (LOW_VALUE_CLUSTER_NAMES.has(moduleName.toLowerCase())) return null;
    return { name: moduleName, prefix: segments[0]! };
  }

  const top = segments[0]!;
  if (LOW_VALUE_CLUSTER_NAMES.has(top.toLowerCase())) return null;
  // A bare `src/foo.ts` with no module folder: too coarse to name.
  if (CONTAINER_DIRS.has(top.toLowerCase())) return null;

  return { name: top, prefix: top };
}

/**
 * Break an indexed codebase into clusters.
 *
 * Deterministic: the same graph yields byte-identical output, which is what
 * lets a re-run be compared against the last one instead of re-reviewed.
 * Synchronous, unlike the reference's `async` version — every read underneath
 * is a synchronous SQLite query and a promise around nothing makes every caller
 * async for no gain.
 */
export function findClusters(graph: ClusterGraphReader, options: FindClustersOptions = {}): Cluster[] {
  const minFiles = options.minFiles ?? 1;
  const symbolNodesOnly = options.symbolNodesOnly ?? true;

  interface Accumulator {
    name: string;
    prefix: string;
    files: Set<string>;
    nodeIds: Set<string>;
  }

  const byKey = new Map<string, Accumulator>();

  for (const file of graph.listFiles()) {
    const normalized = normalizeRepoPath(file.path);
    const key = resolveClusterKey(normalized);
    if (key === null) continue;

    // The prefix is part of the key so two packages with a same-named module
    // stay apart. The separator is the unicode escape for the null character,
    // written as an escape and never as a literal byte: a raw one makes this
    // file binary to Git, so every future diff of it would be unreviewable.
    // It is the right delimiter because it cannot occur in a path segment;
    // merging two such packages would produce one cluster whose node ids come
    // from two unrelated trees, and a claim grounded across both.
    const mapKey = `${key.name}\u0000${key.prefix}`;
    let accumulator = byKey.get(mapKey);
    if (accumulator === undefined) {
      accumulator = { name: key.name, prefix: key.prefix, files: new Set(), nodeIds: new Set() };
      byKey.set(mapKey, accumulator);
    }

    accumulator.files.add(normalized);
    // The *original* path, not the normalized one: the reader is keyed on what
    // the graph stored, and normalizing before the lookup would miss every file
    // on a graph that recorded backslashes.
    for (const node of graph.nodesInFile(file.path)) {
      if (symbolNodesOnly && !SYMBOL_KINDS.has(node.kind)) continue;
      accumulator.nodeIds.add(node.id);
    }
  }

  const clusters: Cluster[] = [];
  for (const accumulator of byKey.values()) {
    if (accumulator.files.size < minFiles) continue;

    const files = [...accumulator.files].sort();
    const nodeIds = [...accumulator.nodeIds].sort();
    if (symbolNodesOnly && nodeIds.length === 0) continue;

    clusters.push({
      name: accumulator.name,
      nodeIds,
      files,
      description: `Module "${accumulator.name}" (${accumulator.prefix}/): ${files.length} files, ${nodeIds.length} symbols`,
    });
  }

  clusters.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || (left.description ?? "").localeCompare(right.description ?? ""),
  );

  return clusters;
}

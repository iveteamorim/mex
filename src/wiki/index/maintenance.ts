/** Fixed maintenance phases shared by CLI, Hub jobs, and tests. */
export const WIKI_MAINTENANCE_PHASES = [
  "discover",
  "stage",
  "parse",
  "resolve",
  "validate",
  "publish",
] as const;

export type WikiMaintenancePhase = (typeof WIKI_MAINTENANCE_PHASES)[number];

export interface WikiMaintenanceProgress {
  phase: WikiMaintenancePhase;
  completed?: number;
  total?: number;
}

export interface WikiMaintenanceContext {
  signal?: AbortSignal;
  reportProgress?: (progress: WikiMaintenanceProgress) => void;
}

export class WikiMaintenanceInterruptedError extends Error {
  readonly code = "OPERATION_INTERRUPTED";

  constructor(readonly phase: WikiMaintenancePhase) {
    super(`Wiki maintenance was interrupted during ${phase}.`);
    this.name = "WikiMaintenanceInterruptedError";
  }
}

export class WikiPreparedMaintenanceSettledError extends Error {
  constructor() {
    super("This prepared Wiki maintenance handle has already been committed or discarded.");
    this.name = "WikiPreparedMaintenanceSettledError";
  }
}

export class WikiPreparedMaintenanceNotPreflightedError extends Error {
  constructor() {
    super("Prepared Wiki maintenance must pass preflight immediately before commit.");
    this.name = "WikiPreparedMaintenanceNotPreflightedError";
  }
}

interface ObservedWikiFile {
  path: string;
  absolutePath: string;
  hash: string | "absent" | "unreadable";
}

export interface WikiCorpusFastBinding {
  readonly revision: string;
}

/** Exact canonical corpus snapshot held privately by a prepared maintenance job. */
export interface WikiCorpusObservation {
  readonly revision: string;
  readonly files: readonly DiscoveredFile[];
  readonly diagnostics: readonly WikiDiagnostic[];
  readFile(absolutePath: string): string;
}

export interface WikiCorpusObservationOptions {
  scaffoldRoot: string;
  exclude?: readonly string[];
  readFile?: (absolutePath: string) => string;
  /** Omit for a full rebuild observation; refresh pins only its selected set. */
  paths?: readonly string[];
}

/**
 * Read every discovered canonical file once and bind path set + exact bytes to
 * one digest. Candidate builders re-read one file at a time and require its
 * exact hash to match this observation, so a maintenance handle never retains
 * the repository's source bodies in memory. Commit performs a fresh observation
 * and requires the same digest before publication.
 */
export function observeWikiCorpus(options: WikiCorpusObservationOptions): WikiCorpusObservation {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const discovery = discoverMarkdownFiles({ root: scaffoldRoot, exclude: options.exclude });
  const discoveredByPath = new Map(discovery.files.map((file) => [file.path, file]));
  if (options.paths !== undefined && options.paths.length > WIKI_CORPUS_LIMITS.maxMaintenancePaths) {
    throw new WikiCorpusLimitError("maxMaintenancePaths");
  }
  const selected = options.paths === undefined
    ? discovery.files
    : [...new Set(options.paths)].sort().map((path) => discoveredByPath.get(path) ?? {
      path,
      absolutePath: resolve(scaffoldRoot, path),
    });
  const observed: ObservedWikiFile[] = [];
  let corpusBytes = 0;
  for (const file of selected) {
    if (!discoveredByPath.has(file.path)) {
      observed.push({ path: file.path, absolutePath: file.absolutePath, hash: "absent" });
      continue;
    }
    try {
      const text = readContainedSource(
        scaffoldRoot,
        file.absolutePath,
        options.readFile === undefined ? {} : { readFile: options.readFile },
      );
      corpusBytes = addWikiCorpusBytes(corpusBytes, Buffer.byteLength(text, "utf8"));
      observed.push({ path: file.path, absolutePath: file.absolutePath, hash: exactFileContentHash(text) });
    } catch (error) {
      if (error instanceof WikiCorpusLimitError) throw error;
      const unreadableHash = error instanceof WikiSourceReadError && error.exactByteHash !== undefined
        ? `unreadable:${error.exactByteHash}`
        : "unreadable";
      observed.push({ path: file.path, absolutePath: file.absolutePath, hash: unreadableHash });
    }
  }
  const hash = createHash("sha256");
  hash.update("wiki-corpus-observation-v1\0", "utf8");
  for (const file of observed) hash.update(`${file.path}\0${file.hash}\0`, "utf8");
  const revision = hash.digest("hex");
  const byAbsolutePath = new Map(observed.map((file) => [resolve(file.absolutePath), file]));
  return {
    revision,
    files: discovery.files,
    diagnostics: discovery.diagnostics,
    readFile: (absolutePath: string): string => {
      const file = byAbsolutePath.get(resolve(absolutePath));
      if (file === undefined || file.hash === "absent" || file.hash.startsWith("unreadable")) {
        throw new Error("The observed Wiki file was unreadable.");
      }
      let text: string;
      try {
        text = readContainedSource(
          scaffoldRoot,
          file.absolutePath,
          options.readFile === undefined ? {} : { readFile: options.readFile },
        );
      } catch (error) {
        if (error instanceof WikiCorpusLimitError) throw error;
        throw new WikiMaintenanceInterruptedError("parse");
      }
      if (exactFileContentHash(text) !== file.hash) {
        throw new WikiMaintenanceInterruptedError("parse");
      }
      return text;
    },
  };
}

export function assertWikiCorpusUnchanged(
  expected: WikiCorpusObservation,
  options: WikiCorpusObservationOptions,
): void {
  const current = observeWikiCorpus(options);
  if (current.revision !== expected.revision) throw new WikiMaintenanceInterruptedError("publish");
}

/**
 * Cheap path-set and inode/timestamp binding used only in the narrow interval
 * after exact preflight and the consumer's final Graph observation. Exact
 * bytes are established by `assertWikiCorpusUnchanged`; this catches any later
 * add/remove/replace/same-inode edit without reading source bodies again.
 */
export function bindWikiCorpusFast(options: WikiCorpusObservationOptions): WikiCorpusFastBinding {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const discovery = discoverMarkdownFiles({ root: scaffoldRoot, exclude: options.exclude });
  const byPath = new Map(discovery.files.map((file) => [file.path, file]));
  if (options.paths !== undefined && options.paths.length > WIKI_CORPUS_LIMITS.maxMaintenancePaths) {
    throw new WikiCorpusLimitError("maxMaintenancePaths");
  }
  const paths = options.paths === undefined
    ? discovery.files.map((file) => file.path)
    : [...new Set(options.paths)].sort();
  const hash = createHash("sha256");
  hash.update("wiki-corpus-fast-binding-v1\0", "utf8");
  for (const path of paths) {
    const file = byPath.get(path);
    if (file === undefined) {
      hash.update(`${path}\0absent\0`, "utf8");
      continue;
    }
    try {
      const stats = lstatSync(file.absolutePath, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("unsafe Wiki source leaf");
      hash.update(
        `${path}\0${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}\0`,
        "utf8",
      );
    } catch {
      hash.update(`${path}\0unreadable\0`, "utf8");
    }
  }
  return { revision: hash.digest("hex") };
}

export function assertWikiCorpusFastUnchanged(
  expected: WikiCorpusFastBinding,
  options: WikiCorpusObservationOptions,
): void {
  if (bindWikiCorpusFast(options).revision !== expected.revision) {
    throw new WikiMaintenanceInterruptedError("publish");
  }
}

export function maintenanceBoundary(
  context: WikiMaintenanceContext | undefined,
  phase: WikiMaintenancePhase,
  counts: { completed?: number; total?: number } = {},
): void {
  if (maintenanceWasAborted(context)) throw new WikiMaintenanceInterruptedError(phase);
  context?.reportProgress?.({ phase, ...counts });
  if (maintenanceWasAborted(context)) throw new WikiMaintenanceInterruptedError(phase);
}

function maintenanceWasAborted(context: WikiMaintenanceContext | undefined): boolean {
  return context?.signal?.aborted === true;
}
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import { exactFileContentHash } from "../model/hash.js";
import { discoverMarkdownFiles, type DiscoveredFile } from "./discover.js";
import {
  WIKI_CORPUS_LIMITS,
  WikiCorpusLimitError,
  addWikiCorpusBytes,
} from "./corpus-policy.js";
import { readContainedSource, WikiSourceReadError } from "./source-read.js";

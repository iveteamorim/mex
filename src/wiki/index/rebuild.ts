/**
 * The clean rebuild — §10.3's ten steps, and the reference implementation for
 * everything the index claims to know (D5).
 *
 * **Two passes, always.** Every file is parsed and every entity collected
 * before a single reference is resolved. A one-pass resolver would answer
 * "does this relation target exist" differently depending on whether the target
 * happened to be parsed first, which makes the index a function of directory
 * order rather than of content. The two-pass shape is not an optimization to be
 * traded away later; it is what the determinism test is testing.
 *
 * **Grounding is stored, not resolved.** Step 8 says "resolve code grounding
 * when the graph is available". In this phase the graph is never available:
 * `wiki_groundings` records what Markdown declares and leaves health NULL. P4
 * owns resolution, and a resolver invented here would be a second one to
 * reconcile.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import { diagnostic } from "../model/diagnostic.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import type { ParsedFile } from "../markdown/contract.js";
import { discoverMarkdownFiles } from "./discover.js";
import {
  WIKI_CORPUS_LIMITS,
  WikiCorpusLimitError,
  addWikiCorpusBytes,
} from "./corpus-policy.js";
import {
  createPendingIndex,
  discardPendingIndex,
  discardSealedPendingIndex,
  publishSealedPendingIndex,
  sealPendingIndex,
  sweepPendingIndexes,
  type SealedPendingIndex,
} from "./publish.js";
import {
  acquireWikiMaintenanceLease,
  bindIndexGeneration,
  IndexInUseError,
  IndexPublishRecoveryError,
  type IndexGenerationBinding,
  type WikiMaintenanceLease,
} from "./dbfile.js";
import {
  assertWikiCorpusUnchanged,
  assertWikiCorpusFastUnchanged,
  bindWikiCorpusFast,
  maintenanceBoundary,
  observeWikiCorpus,
  type WikiCorpusObservation,
  type WikiCorpusFastBinding,
  type WikiMaintenanceContext,
  WikiPreparedMaintenanceNotPreflightedError,
  WikiPreparedMaintenanceSettledError,
  WikiMaintenanceInterruptedError,
} from "./maintenance.js";
import { resolveIndexState, writeFileDiagnostics, writeParsedFile, type GroundingResolver } from "./write.js";
import { readContainedSource } from "./source-read.js";

/** Default index location: `.mex/wiki.db`, beside the scaffold it indexes. */
export function defaultIndexPath(scaffoldRoot: string): string {
  return resolve(scaffoldRoot, "wiki.db");
}

export interface RebuildOptions {
  /** Absolute path to the scaffold root. */
  scaffoldRoot: string;
  /** Defaults to `<scaffoldRoot>/wiki.db`. */
  indexPath?: string;
  /** Ordered exclusion globs, from `config.wiki.exclude`. */
  exclude?: readonly string[];
  registry?: EntityTypeRegistry;
  /** Injectable clock, so tests can prove the excluded columns are the only volatile ones. */
  now?: () => string;
  /**
   * Injectable file reader, defaulting to `readFileSync(path, "utf-8")`.
   *
   * A seam, not a convenience. An unreadable file has to behave identically
   * under a rebuild and under a refresh, and there is no portable way to make
   * a real file unreadable on every machine the suite runs on — so the oracle
   * injects the failure instead of staging it, and covers the case everywhere
   * rather than only on the platforms where `chmod` means something.
   */
  readFile?: (absolutePath: string) => string;
  /**
   * How to resolve grounding health, when the caller has a code graph.
   *
   * Optional because the index must build in a checkout that has none — a
   * fresh clone, CI before `mex graph`, a sandbox. Absent, every grounding's
   * verdict column stays NULL, which is what "nothing looked" is stored as.
   *
   * **A rebuild and a refresh must be given the same resolver or neither**, or
   * their dumps differ for a reason that is not a refresh bug: health depends
   * on code, and code changes without the scaffold changing at all.
   */
  resolveGrounding?: GroundingResolver;
  /** Cancellation and bounded phase progress for explicit maintenance jobs. */
  maintenance?: WikiMaintenanceContext;
}

export interface RebuildResult {
  indexPath: string;
  fileCount: number;
  entityCount: number;
  /** Discovery-level problems only; per-file and set-level ones are in the index. */
  diagnostics: WikiDiagnostic[];
  /** Temp databases left by an earlier crashed build, removed before this one. */
  sweptTempFiles: string[];
}

/** Read a file as text. Never as a Buffer — offsets are UTF-16 units (D2a). */
export function readText(absolutePath: string): string {
  // Compatibility seam for callers that do not have a scaffold authority.
  // Canonical engine paths below use readContainedSource instead.
  return readContainedSource(resolve(absolutePath, ".."), absolutePath);
}

/** One file that could not be read, and the diagnostic that says so. */
export interface UnreadableFile {
  path: string;
  diagnostic: WikiDiagnostic;
}

/** The diagnostic for a file that exists but cannot be read. */
export function unreadableFileDiagnostic(path: string, error: unknown): WikiDiagnostic {
  return diagnostic(
    "WIKI_PARSE_ERROR",
    `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    { file: path },
  );
}

/**
 * Parse every discovered file.
 *
 * The codec never throws, so a malformed file costs its own diagnostics and
 * nothing else. A file that cannot even be *read* is reported and skipped
 * rather than taking the run down: one unreadable file must not cost a user
 * their whole index.
 */
export function parseAll(
  scaffoldRoot: string,
  files: readonly { path: string; absolutePath: string }[],
  registry: EntityTypeRegistry | undefined,
  readFile?: (absolutePath: string) => string,
  maintenance?: WikiMaintenanceContext,
): { parsed: ParsedFile[]; unreadable: UnreadableFile[] } {
  if (files.length > WIKI_CORPUS_LIMITS.maxMarkdownFiles) {
    throw new WikiCorpusLimitError("maxMarkdownFiles");
  }
  const parsed: ParsedFile[] = [];
  const unreadable: UnreadableFile[] = [];
  let corpusBytes = 0;

  maintenanceBoundary(maintenance, "parse", { completed: 0, total: files.length });
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    maintenanceBoundary(maintenance, "parse", { completed: index, total: files.length });
    let text: string;
    try {
      text = readContainedSource(scaffoldRoot, file.absolutePath, readFile === undefined ? {} : { readFile });
    } catch (error) {
      if (error instanceof WikiCorpusLimitError) throw error;
      if (unreadable.length < WIKI_CORPUS_LIMITS.maxDiagnostics) {
        unreadable.push({ path: file.path, diagnostic: unreadableFileDiagnostic(file.path, error) });
      }
      continue;
    }
    corpusBytes = addWikiCorpusBytes(corpusBytes, Buffer.byteLength(text, "utf8"));
    parsed.push(parseWikiMarkdown(registry === undefined ? { path: file.path, text } : { path: file.path, text, registry }));
  }
  maintenanceBoundary(maintenance, "parse", { completed: files.length, total: files.length });

  return { parsed, unreadable };
}

/**
 * Rebuild the index from Markdown alone and publish it atomically.
 *
 * Delete `wiki.db`, run this, and everything comes back. Nothing is read out of
 * the old index on the way — a rebuild that consulted the thing it is replacing
 * would let a stale row survive forever.
 */
export interface PreparedWikiRebuild {
  readonly kind: "rebuild";
  /** Exact Wiki-corpus preflight; call before the consumer's final Graph check. */
  preflight(): void;
  /** Rename-only publication after a successful preflight. */
  commit(): RebuildResult;
  discard(): void;
}

function writeObservedCorpus(
  observation: WikiCorpusObservation,
  registry: EntityTypeRegistry | undefined,
  maintenance: WikiMaintenanceContext | undefined,
  writeParsed: (file: ParsedFile) => void,
  writeUnreadable: (file: UnreadableFile) => void,
): { fileCount: number; entityCount: number; unreadable: UnreadableFile[]; omittedUnreadable: number } {
  let fileCount = 0;
  let entityCount = 0;
  const unreadable: UnreadableFile[] = [];
  let omittedUnreadable = 0;
  maintenanceBoundary(maintenance, "parse", { completed: 0, total: observation.files.length });
  for (let index = 0; index < observation.files.length; index += 1) {
    const file = observation.files[index]!;
    maintenanceBoundary(maintenance, "parse", { completed: index, total: observation.files.length });
    let parsed: ParsedFile;
    try {
      const text = observation.readFile(file.absolutePath);
      parsed = parseWikiMarkdown(registry === undefined
        ? { path: file.path, text }
        : { path: file.path, text, registry });
    } catch (error) {
      if (error instanceof WikiCorpusLimitError || error instanceof WikiMaintenanceInterruptedError) throw error;
      const entry = { path: file.path, diagnostic: unreadableFileDiagnostic(file.path, error) };
      writeUnreadable(entry);
      if (unreadable.length < WIKI_CORPUS_LIMITS.maxDiagnostics) unreadable.push(entry);
      else omittedUnreadable += 1;
      continue;
    }
    writeParsed(parsed);
    fileCount += 1;
    entityCount += parsed.entities.length;
  }
  maintenanceBoundary(maintenance, "parse", { completed: observation.files.length, total: observation.files.length });
  return { fileCount, entityCount, unreadable, omittedUnreadable };
}

function rebuildInterruptedResult(indexPath: string, sweptTempFiles: string[], error: IndexInUseError): RebuildResult {
  return {
    indexPath,
    fileCount: 0,
    entityCount: 0,
    diagnostics: [diagnostic("WIKI_INDEX_REBUILD_REQUIRED", error.message, {
      file: indexPath,
      remediation: "Close anything holding the index open and run `mex wiki rebuild-index` again.",
    })],
    sweptTempFiles,
  };
}

/**
 * Build and validate a candidate while retaining the scaffold-wide lease.
 * The returned value intentionally exposes no path, database or candidate
 * bytes: a caller may only commit the exact prepared generation or discard it.
 */
export function prepareWikiRebuild(options: RebuildOptions): PreparedWikiRebuild {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const lease = acquireWikiMaintenanceLease(indexPath, "rebuild", scaffoldRoot);
  let handle: ReturnType<typeof createPendingIndex>["handle"] | undefined;
  let tempPath: string | undefined;
  try {
    const sweptTempFiles = sweepPendingIndexes(indexPath, lease.binding);
    const live = bindIndexGeneration(indexPath, lease.binding);
    maintenanceBoundary(options.maintenance, "discover");
    const observation = observeWikiCorpus({
      scaffoldRoot,
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    });

    maintenanceBoundary(options.maintenance, "stage");
    const pending = createPendingIndex(indexPath, lease.binding);
    handle = pending.handle;
    tempPath = pending.tempPath;
    let result!: ReturnType<typeof writeObservedCorpus>;
    handle.db.transaction(() => {
      result = writeObservedCorpus(
        observation,
        options.registry,
        options.maintenance,
        (file) => writeParsedFile(handle!.db, file, { now: now() }),
        (file) => writeFileDiagnostics(handle!.db, file.path, [file.diagnostic]),
      );
      maintenanceBoundary(options.maintenance, "resolve");
      resolveIndexState(handle!.db, {
        scaffoldRoot,
        buildKind: "rebuild",
        now: now(),
        scaffoldDiagnostics: observation.diagnostics,
        resolveGrounding: options.resolveGrounding,
      });
      maintenanceBoundary(options.maintenance, "validate");
    });
    const sealed = sealPendingIndex(handle, tempPath, lease.binding);
    handle = undefined;
    const diagnostics = [...observation.diagnostics, ...result.unreadable.map((file) => file.diagnostic)]
      .slice(0, WIKI_CORPUS_LIMITS.maxDiagnostics);
    const diagnosticCount = observation.diagnostics.length + result.unreadable.length + result.omittedUnreadable;
    if (diagnosticCount > diagnostics.length) {
      diagnostics[diagnostics.length - 1] = diagnostic(
        "WIKI_PARSE_ERROR",
        `${diagnosticCount - diagnostics.length + 1} additional Wiki rebuild diagnostic(s) were omitted.`,
        {
          severity: "info",
          remediation: "Resolve the visible diagnostics, then rebuild again for any remaining issues.",
        },
      );
    }
    const summary: RebuildResult = {
      indexPath,
      fileCount: result.fileCount,
      entityCount: result.entityCount,
      diagnostics,
      sweptTempFiles,
    };
    return preparedRebuildHandle({
      options,
      scaffoldRoot,
      indexPath,
      lease,
      tempPath,
      sealed,
      live,
      observation,
      summary,
    });
  } catch (error) {
    try {
      if (handle !== undefined && tempPath !== undefined) discardPendingIndex(handle, tempPath, lease.binding);
    } finally {
      lease.release();
    }
    throw error;
  }
}

function preparedRebuildHandle(state: {
  options: RebuildOptions;
  scaffoldRoot: string;
  indexPath: string;
  lease: WikiMaintenanceLease;
  tempPath: string;
  sealed: SealedPendingIndex;
  live: IndexGenerationBinding;
  observation: WikiCorpusObservation;
  summary: RebuildResult;
}): PreparedWikiRebuild {
  let settled = false;
  let preflighted = false;
  let fastBinding: WikiCorpusFastBinding | null = null;
  const beginSettlement = (): void => {
    if (settled) throw new WikiPreparedMaintenanceSettledError();
    settled = true;
  };
  const discardCandidate = (): void => {
    if (existsSync(state.tempPath)) discardSealedPendingIndex(state.tempPath, state.lease.binding, state.sealed);
  };
  return {
    kind: "rebuild",
    preflight: () => {
      if (settled) throw new WikiPreparedMaintenanceSettledError();
      preflighted = false;
      fastBinding = null;
      maintenanceBoundary(state.options.maintenance, "publish");
      const corpusOptions = {
        scaffoldRoot: state.scaffoldRoot,
        ...(state.options.exclude === undefined ? {} : { exclude: state.options.exclude }),
        ...(state.options.readFile === undefined ? {} : { readFile: state.options.readFile }),
      };
      const before = bindWikiCorpusFast(corpusOptions);
      assertWikiCorpusUnchanged(state.observation, corpusOptions);
      assertWikiCorpusFastUnchanged(before, corpusOptions);
      maintenanceBoundary(state.options.maintenance, "publish");
      fastBinding = before;
      preflighted = true;
    },
    commit: () => {
      if (!preflighted) throw new WikiPreparedMaintenanceNotPreflightedError();
      beginSettlement();
      try {
        if (fastBinding === null) throw new WikiPreparedMaintenanceNotPreflightedError();
        maintenanceBoundary(state.options.maintenance, "publish");
        assertWikiCorpusFastUnchanged(fastBinding, {
          scaffoldRoot: state.scaffoldRoot,
          ...(state.options.exclude === undefined ? {} : { exclude: state.options.exclude }),
          ...(state.options.readFile === undefined ? {} : { readFile: state.options.readFile }),
        });
        publishSealedPendingIndex(
          state.tempPath,
          state.indexPath,
          state.lease.binding,
          state.sealed,
          state.live,
        );
        return state.summary;
      } catch (error) {
        try {
          discardCandidate();
        } catch (cleanupError) {
          throw new IndexPublishRecoveryError(state.tempPath, state.tempPath, error, cleanupError);
        }
        if (error instanceof IndexInUseError) return rebuildInterruptedResult(state.indexPath, state.summary.sweptTempFiles, error);
        throw error;
      } finally {
        state.lease.release();
      }
    },
    discard: () => {
      beginSettlement();
      try {
        discardCandidate();
      } finally {
        state.lease.release();
      }
    },
  };
}

/** Compatibility one-shot API implemented through the two-phase boundary. */
export function rebuildWikiIndex(options: RebuildOptions): RebuildResult {
  const prepared = prepareWikiRebuild(options);
  try {
    prepared.preflight();
  } catch (error) {
    prepared.discard();
    throw error;
  }
  return prepared.commit();
}

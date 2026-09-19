/**
 * `mex wiki for-code` — the code→knowledge join at the command line, and the
 * provider that attaches the same answer to `mex graph scope`.
 *
 * ## A scope note, stated rather than assumed
 *
 * P9 owns the wiki command surface and the `{schemaVersion, ok, data,
 * diagnostics}` envelope, and P3 was told to build no commands for exactly that
 * reason. This one is built anyway because the phase plan names it explicitly
 * and because the reverse join is not demonstrable without it — the product
 * claim is "ask about code, get the knowledge attached to it", and a library
 * function is not an answer to that.
 *
 * It is deliberately a **thin shell**: every decision lives in
 * `query/for-code.ts`, and this file reads arguments, opens an index, and
 * prints. The envelope below is the shape P9 will standardize, so P9's job is
 * to move it into a shared helper rather than to redesign it. If that envelope
 * changes, this command changes with it and nothing else does.
 *
 * The JSONL form exists because that is what `mex graph scope|query|get`
 * already speak, and an agent that has to switch parsers between two halves of
 * one answer will parse one of them wrong.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultIndexPath } from "../index/rebuild.js";
import { envelopeFor, renderEnvelope, exitCodeFor, type WikiEnvelope } from "./envelope.js";
import { entitiesGroundedIn } from "../query/get.js";
import type { GroundedEntity } from "../query/for-code.js";

/** What `for-code` returns, under the envelope's `data`. */
export interface ForCodeData {
  entities: ForCodeRecord[];
  /** True when a bound stopped the list before the data ran out. */
  truncated: boolean;
}

// P9 hoisted the envelope into `cli/envelope.ts`, as this file's own comment
// said it should. Re-exported here so P7's consumers keep their import, and
// so there is visibly one definition rather than two that agree today.
export { WIKI_CLI_SCHEMA_VERSION, type WikiEnvelope } from "./envelope.js";

export interface ForCodeCommandOptions {
  scaffoldRoot?: string;
  indexPath?: string;
  limit?: number;
  includeArchived?: boolean;
  json?: boolean;
  write?: (line: string) => void;
}

/** One entity, as the command reports it. */
export interface ForCodeRecord {
  type: "knowledge";
  id: string;
  entityType: string;
  title: string;
  status: string;
  /** Null when nothing has resolved this entity's groundings in this checkout. */
  health: string | null;
  file: string;
  startLine: number;
  /** Which of the requested nodes this entity is about. */
  matchedNodes: string[];
  /** Present only when reconciliation rebound one — a signal Markdown is out of date. */
  reboundNodes?: string[];
  summary?: string;
}

export function toRecord(item: GroundedEntity): ForCodeRecord {
  return {
    type: "knowledge",
    id: item.entity.id,
    entityType: item.entity.type,
    title: item.entity.title,
    status: item.entity.status,
    health: item.entity.health,
    file: item.entity.file,
    startLine: item.entity.startLine,
    matchedNodes: item.matchedNodes,
    ...(item.reboundNodes.length > 0 ? { reboundNodes: item.reboundNodes } : {}),
    ...(item.entity.summary === null ? {} : { summary: item.entity.summary }),
  };
}

/**
 * Resolve the index path, without creating anything.
 *
 * A read never builds. An absent index is a typed diagnostic the caller can
 * act on, not a five-second surprise rebuild in the middle of a query.
 */
function indexPathFor(options: ForCodeCommandOptions, rootDir: string): string {
  if (options.indexPath !== undefined) return resolve(options.indexPath);
  const scaffoldRoot = options.scaffoldRoot ?? resolve(rootDir, ".mex");
  return defaultIndexPath(scaffoldRoot);
}

/**
 * Entities grounded to the given nodes, as JSONL records.
 *
 * Returns an empty list rather than throwing when there is no index: this is
 * also the `mex graph scope --wiki` path, and a missing wiki must never take
 * out a graph command that would otherwise have succeeded.
 */
export function knowledgeRecordsFor(
  nodeIds: readonly string[],
  options: ForCodeCommandOptions = {},
  rootDir = process.cwd(),
): ForCodeRecord[] {
  const indexPath = indexPathFor(options, rootDir);
  if (!existsSync(indexPath)) return [];
  const result = entitiesGroundedIn(indexPath, nodeIds, {
    limit: options.limit,
    includeArchived: options.includeArchived,
  });
  return result.ok ? result.value.items.map(toRecord) : [];
}

/** `mex wiki for-code <nodeId…>`. */
export function runWikiForCode(
  nodeIds: readonly string[],
  rootDir = process.cwd(),
  options: ForCodeCommandOptions = {},
): void {
  const write = options.write ?? console.log;
  const indexPath = indexPathFor(options, rootDir);

  const result = entitiesGroundedIn(indexPath, nodeIds, {
    limit: options.limit,
    includeArchived: options.includeArchived,
  });

  if (!result.ok) {
    // A typed failure, in the envelope, with a non-zero exit — not a stack
    // trace. `wiki.db` being absent or stale is an ordinary state, and the
    // diagnostic carries a registry code the caller can match on.
    const envelope: WikiEnvelope<ForCodeData> = envelopeFor(
      { entities: [], truncated: false },
      [result.diagnostic],
    );
    write(renderEnvelope(envelope));
    process.exitCode = exitCodeFor(envelope);
    return;
  }

  const records = result.value.items.map(toRecord);
  if (options.json === true) {
    // Truncation rides in `data`, not as a diagnostic. Diagnostic codes are a
    // published vocabulary with a coverage test behind them; inventing one here
    // for "the list was bounded" would put a code in the contract that no
    // validator knows about.
    write(renderEnvelope(envelopeFor({ entities: records, truncated: result.value.truncated })));
    return;
  }

  for (const record of records) write(JSON.stringify(record));
}

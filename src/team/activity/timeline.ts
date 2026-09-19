import { createHash } from "node:crypto";
import {
  MexPortError,
  type ActorRef,
  type Diagnostic,
  type PageRequest,
  type RepoState,
} from "../contracts/shared.js";
import {
  TEAM_READ_LIMITS,
  type StoredActivityEvent,
} from "../contracts/workflow.js";
import type { LegacyTimelineEntry } from "./legacy.js";

const MAX_TIMELINE_CURSOR_BYTES = 4 * 1024;

export interface CanonicalTimelineEntry {
  source: "activity";
  id: string;
  timestamp: string;
  actor: ActorRef;
  repoState: RepoState;
  sourcePath: string;
  event: StoredActivityEvent;
}

export type TimelineEntry = CanonicalTimelineEntry | LegacyTimelineEntry;

export interface TimelineRequest extends PageRequest {
  source?: "activity" | "legacy";
  since?: string;
}

export interface TimelinePage {
  items: readonly TimelineEntry[];
  nextCursor: string | null;
  /** More entries exist after this page. */
  truncated: boolean;
  /** A corpus safety bound prevented a complete source scan. */
  sourceTruncated: boolean;
  deterministicRevision: string;
  diagnostics: readonly Diagnostic[];
}

interface TimelineCursor {
  version: 1;
  revision: string;
  timestamp: string;
  id: string;
  sourcePath: string;
}

export function buildTimelinePage(
  activity: readonly StoredActivityEvent[],
  legacy: readonly LegacyTimelineEntry[],
  diagnostics: readonly Diagnostic[],
  request: TimelineRequest = {},
  sourceTruncated = false,
): TimelinePage {
  const limit = pageLimit(request.limit);
  const since = parseSince(request.since);
  const entries: TimelineEntry[] = [
    ...activity.map((event): CanonicalTimelineEntry => ({
      source: "activity",
      id: event.id,
      timestamp: event.timestamp,
      actor: event.actor,
      repoState: event.repoState,
      sourcePath: event.sourcePath,
      event,
    })),
    ...legacy,
  ].filter((entry) => {
    if (request.source !== undefined && entry.source !== request.source) return false;
    return since === null || Date.parse(entry.timestamp) >= since;
  });

  entries.sort(compareTimelineEntries);
  const revision = timelineRevision(entries);
  const cursor = request.cursor === undefined ? null : decodeCursor(request.cursor);
  if (cursor !== null && cursor.revision !== revision) {
    throw problem("REVISION_CONFLICT", "Timeline changed after the page cursor was issued.");
  }

  const start = cursor === null
    ? 0
    : entries.findIndex((entry) => compareEntryToCursor(entry, cursor) > 0);
  if (cursor !== null && start === -1) {
    return {
      items: [],
      nextCursor: null,
      truncated: false,
      sourceTruncated,
      deterministicRevision: revision,
      diagnostics,
    };
  }

  const items = entries.slice(start, start + limit);
  const truncated = start + items.length < entries.length;
  const last = items.at(-1);
  return {
    items,
    nextCursor: truncated && last !== undefined
      ? encodeCursor({
          version: 1,
          revision,
          timestamp: last.timestamp,
          id: last.id,
          sourcePath: last.sourcePath,
        })
      : null,
    truncated,
    sourceTruncated,
    deterministicRevision: revision,
    diagnostics,
  };
}

export function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  const timestamp = compareCodePoints(right.timestamp, left.timestamp);
  if (timestamp !== 0) return timestamp;
  const id = compareCodePoints(left.id, right.id);
  if (id !== 0) return id;
  return compareCodePoints(left.sourcePath, right.sourcePath);
}

function compareEntryToCursor(entry: TimelineEntry, cursor: TimelineCursor): number {
  return compareTimelineEntries(entry, {
    source: "legacy",
    id: cursor.id,
    timestamp: cursor.timestamp,
    actor: null,
    repoState: null,
    sourcePath: cursor.sourcePath,
    sourceLine: 0,
    kind: "note",
    message: "",
    files: [],
    cwd: ".",
  });
}

function timelineRevision(entries: readonly TimelineEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.timestamp, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.id, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sourcePath, "utf8");
    hash.update("\0", "utf8");
    if (entry.source === "activity") hash.update(entry.event.revision, "utf8");
  }
  return hash.digest("hex");
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return TEAM_READ_LIMITS.defaultPageSize;
  if (!Number.isInteger(value) || value < 1 || value > TEAM_READ_LIMITS.maxPageSize) {
    throw problem(
      "INVALID_REQUEST",
      `Timeline limit must be an integer from 1 to ${TEAM_READ_LIMITS.maxPageSize}.`,
    );
  }
  return value;
}

function parseSince(value: string | undefined): number | null {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw problem("INVALID_REQUEST", "Timeline since must be a timestamp.");
  return timestamp;
}

function encodeCursor(value: TimelineCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): TimelineCursor {
  if (Buffer.byteLength(value, "utf8") > MAX_TIMELINE_CURSOR_BYTES) {
    throw problem("INVALID_REQUEST", "Timeline cursor is too large.");
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" || decoded === null || Array.isArray(decoded)
      || (decoded as { version?: unknown }).version !== 1
      || typeof (decoded as { revision?: unknown }).revision !== "string"
      || typeof (decoded as { timestamp?: unknown }).timestamp !== "string"
      || typeof (decoded as { id?: unknown }).id !== "string"
      || typeof (decoded as { sourcePath?: unknown }).sourcePath !== "string"
    ) throw new Error("invalid cursor");
    return decoded as TimelineCursor;
  } catch {
    throw problem("INVALID_REQUEST", "Timeline cursor is invalid.");
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function problem(code: "INVALID_REQUEST" | "REVISION_CONFLICT", detail: string): MexPortError {
  return new MexPortError({
    title: code === "INVALID_REQUEST" ? "Invalid timeline request" : "Timeline changed",
    status: code === "INVALID_REQUEST" ? 400 : 409,
    code,
    detail,
  });
}

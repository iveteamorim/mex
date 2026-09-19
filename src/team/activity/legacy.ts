import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MexPortError, type Diagnostic, type RepoRelativePath } from "../contracts/shared.js";
import { readContainedArtifact } from "../artifacts/filesystem.js";
import { EVENT_KINDS, type EventKind } from "../../events.js";

const LEGACY_ACTIVITY_PATH = ".mex/events/decisions.jsonl" as RepoRelativePath;
const VALID_EVENT_KINDS = new Set<string>(EVENT_KINDS);
const MAX_LEGACY_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_ROWS = 10_000;
const MAX_LEGACY_LINE_BYTES = 64 * 1024;

export interface LegacyTimelineEntry {
  source: "legacy";
  id: string;
  timestamp: string;
  actor: null;
  repoState: null;
  sourcePath: RepoRelativePath;
  sourceLine: number;
  kind: EventKind;
  message: string;
  files: readonly string[];
  cwd: string;
  trace?: string;
  origin?: string;
  status?: string;
}

export interface LegacyTimelineReadResult {
  entries: readonly LegacyTimelineEntry[];
  diagnostics: readonly Diagnostic[];
  truncated: boolean;
}

/**
 * Normalize the public legacy JSONL event file without ever rewriting it.
 * Invalid rows are diagnosed independently so one damaged line cannot hide
 * the remainder of repository history.
 */
export function readLegacyTimeline(projectRoot: string): LegacyTimelineReadResult {
  const diagnostics: Diagnostic[] = [];
  const file = join(projectRoot, ...LEGACY_ACTIVITY_PATH.split("/"));
  if (!existsSync(file)) return { entries: [], diagnostics, truncated: false };

  let bytes: Buffer;
  try {
    bytes = Buffer.from(readContainedArtifact(
      projectRoot,
      LEGACY_ACTIVITY_PATH,
      MAX_LEGACY_BYTES,
    ).bytes);
  } catch (error) {
    return {
      entries: [],
      diagnostics: [{
        code: error instanceof MexPortError ? error.problem.code : "LEGACY_ACTIVITY_UNREADABLE",
        severity: "error",
        message: `Unable to read legacy activity history: ${errorMessage(error)}`,
        path: LEGACY_ACTIVITY_PATH,
      }],
      truncated: true,
    };
  }

  const entries: LegacyTimelineEntry[] = [];
  const seenRows = new Map<string, number>();
  let byteOffset = 0;
  let precedingCrlfCount = 0;
  let lineNumber = 1;
  let truncated = false;

  while (byteOffset < bytes.length) {
    if (lineNumber > MAX_LEGACY_ROWS) {
      diagnostics.push({
        code: "LEGACY_ACTIVITY_LIMIT_EXCEEDED",
        severity: "warning",
        message: `Legacy activity exceeds the ${MAX_LEGACY_ROWS}-row safety limit.`,
        path: LEGACY_ACTIVITY_PATH,
      });
      truncated = true;
      break;
    }
    const newline = bytes.indexOf(0x0a, byteOffset);
    const end = newline === -1 ? bytes.length : newline;
    const rawBytes = bytes.subarray(byteOffset, end);
    // IDs retain the historical LF offsets across checkout conversion. Scan
    // positions and safety limits still account for every byte on disk.
    const logicalByteOffset = byteOffset - precedingCrlfCount;
    if (newline !== -1 && rawBytes.at(-1) === 0x0d) precedingCrlfCount += 1;
    const rawLine = stripTrailingCarriageReturn(rawBytes).toString("utf8");

    if (rawLine.trim() !== "") {
      if (rawBytes.byteLength > MAX_LEGACY_LINE_BYTES) {
        diagnostics.push({
          code: "LEGACY_ACTIVITY_MALFORMED",
          severity: "warning",
          message: `Legacy activity row ${lineNumber} exceeds the safe line limit.`,
          path: LEGACY_ACTIVITY_PATH,
          detail: { line: lineNumber },
        });
        if (newline === -1) break;
        byteOffset = newline + 1;
        lineNumber += 1;
        continue;
      }
      const duplicateKey = sha256(rawLine);
      const firstLine = seenRows.get(duplicateKey);
      const parsed = parseLegacyLine(rawLine);
      if (parsed === null) {
        diagnostics.push({
          code: "LEGACY_ACTIVITY_MALFORMED",
          severity: "warning",
          message: `Malformed legacy activity row on line ${lineNumber}.`,
          path: LEGACY_ACTIVITY_PATH,
          detail: { line: lineNumber },
        });
      } else {
        if (firstLine !== undefined) {
          diagnostics.push({
            code: "LEGACY_ACTIVITY_DUPLICATE",
            severity: "warning",
            message: `Duplicate legacy activity row; first observed on line ${firstLine}.`,
            path: LEGACY_ACTIVITY_PATH,
            detail: { line: lineNumber, firstLine },
          });
        } else {
          seenRows.set(duplicateKey, lineNumber);
        }
        entries.push({
          source: "legacy",
          id: `legacy_${sha256(`${LEGACY_ACTIVITY_PATH}\0${logicalByteOffset}\0${rawLine}`)}`,
          timestamp: parsed.timestamp,
          actor: null,
          repoState: null,
          sourcePath: LEGACY_ACTIVITY_PATH,
          sourceLine: lineNumber,
          kind: parsed.kind,
          message: parsed.message,
          files: parsed.files,
          cwd: parsed.cwd,
          ...(parsed.trace === undefined ? {} : { trace: parsed.trace }),
          ...(parsed.source === undefined ? {} : { origin: parsed.source }),
          ...(parsed.status === undefined ? {} : { status: parsed.status }),
        });
      }
    }

    if (newline === -1) break;
    byteOffset = newline + 1;
    lineNumber += 1;
  }

  return { entries, diagnostics, truncated };
}

interface ParsedLegacyLine {
  timestamp: string;
  kind: EventKind;
  message: string;
  files: readonly string[];
  cwd: string;
  trace?: string;
  source?: string;
  status?: string;
}

function parseLegacyLine(line: string): ParsedLegacyLine | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) return null;
    if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
      return null;
    }
    if (typeof value.kind !== "string" || !VALID_EVENT_KINDS.has(value.kind)) return null;
    if (
      typeof value.message !== "string"
      || Buffer.byteLength(value.message, "utf8") > 8 * 1024
      || !Array.isArray(value.files)
      || value.files.length > 256
    ) return null;
    const files = value.files.filter((item): item is string => typeof item === "string");
    if (files.some((item) => Buffer.byteLength(item, "utf8") > 4 * 1024)) return null;
    for (const field of [value.cwd, value.trace, value.source, value.status]) {
      if (typeof field === "string" && Buffer.byteLength(field, "utf8") > 4 * 1024) return null;
    }

    return {
      timestamp: new Date(value.timestamp).toISOString(),
      kind: value.kind as EventKind,
      message: value.message,
      files,
      cwd: typeof value.cwd === "string" ? value.cwd : ".",
      ...(typeof value.trace === "string" ? { trace: value.trace } : {}),
      ...(typeof value.source === "string" ? { source: value.source } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
    };
  } catch {
    return null;
  }
}

function stripTrailingCarriageReturn(bytes: Buffer): Buffer {
  return bytes.length > 0 && bytes[bytes.length - 1] === 0x0d
    ? bytes.subarray(0, bytes.length - 1)
    : bytes;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

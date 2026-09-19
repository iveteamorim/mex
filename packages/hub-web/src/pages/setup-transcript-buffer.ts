import type { SetupTranscriptBatch, SetupTranscriptEntry } from "../api/types";

export const TRANSCRIPT_MEMORY_BYTES = 1_048_576;
export const TRANSCRIPT_MEMORY_ENTRIES = 2_048;
export const TRANSCRIPT_RENDER_CHARACTERS = 32_768;
export const TRANSCRIPT_RENDER_ROWS = 80;

export interface TranscriptBuffer {
  entries: SetupTranscriptEntry[];
  bytes: number;
  cursor: number;
  truncated: boolean;
  done: boolean;
}

export const emptyTranscript = (): TranscriptBuffer => ({ entries: [], bytes: 0, cursor: 0, truncated: false, done: false });

const encoder = new TextEncoder();
const TOOL_MARKERS = new Set(["Read a file", "Searched the project", "Searched the web", "Used a tool"]);
const SESSION_NOTICES = new Set([
  "A large output record was omitted from the session view.",
  "A large output record was truncated in the session view.",
]);

/** Older servers may still send tool details; they never enter browser history. */
function visibleEntry(entry: SetupTranscriptEntry): SetupTranscriptEntry | null {
  if (entry.kind === "output") return null;
  if (entry.kind === "assistant") return entry;
  const text = entry.kind === "command" ? "Ran a command"
    : entry.kind === "file" ? "Updated a file"
    : entry.kind === "tool" ? TOOL_MARKERS.has(entry.text) ? entry.text : "Used a tool"
    : SESSION_NOTICES.has(entry.text) ? entry.text : "Session update";
  return { ...entry, text, truncated: false };
}

export function appendTranscript(buffer: TranscriptBuffer, batch: SetupTranscriptBatch): TranscriptBuffer {
  if (batch.cursor < buffer.cursor) return buffer;
  const fresh = batch.entries.filter((entry) => entry.id > buffer.cursor)
    .map(visibleEntry).filter((entry): entry is SetupTranscriptEntry => entry !== null);
  const entries = [...buffer.entries, ...fresh];
  let bytes = buffer.bytes + fresh.reduce((total, entry) => total + encoder.encode(entry.text).byteLength, 0);
  let removed = 0;
  while (entries.length - removed > TRANSCRIPT_MEMORY_ENTRIES || bytes > TRANSCRIPT_MEMORY_BYTES) {
    bytes -= encoder.encode(entries[removed]!.text).byteLength;
    removed += 1;
  }
  return {
    entries: removed === 0 ? entries : entries.slice(removed), bytes,
    cursor: batch.cursor, done: batch.done,
    truncated: buffer.truncated || batch.truncated || removed > 0,
  };
}

export interface TranscriptRow extends SetupTranscriptEntry { endId: number; count: number }

/** A fixed text/row window, independent of how much scrollback is retained. */
export function transcriptWindow(entries: SetupTranscriptEntry[], endId: number | null) {
  let requestedEnd = entries.length - 1;
  while (endId !== null && requestedEnd >= 0 && entries[requestedEnd]!.id > endId) requestedEnd -= 1;
  // When old output has fallen out of retention, show the earliest remaining
  // page instead of pretending that the requested older output is available.
  const end = requestedEnd < 0 && entries.length > 0 ? Math.min(TRANSCRIPT_RENDER_ROWS, entries.length) - 1 : requestedEnd;
  const rows: TranscriptRow[] = [];
  let characters = 0;
  let index = end;
  for (; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const adjacent = rows.at(-1);
    const mergeProse = entry.kind === "assistant" && adjacent?.kind === "assistant";
    const mergeMarker = entry.kind !== "assistant" && entry.kind === adjacent?.kind && entry.text === adjacent.text;
    const merge = mergeProse || mergeMarker;
    const addedCharacters = mergeMarker ? 0 : entry.text.length;
    if (characters + addedCharacters > TRANSCRIPT_RENDER_CHARACTERS || (!merge && rows.length >= TRANSCRIPT_RENDER_ROWS)) break;
    characters += addedCharacters;
    if (merge) {
      adjacent.id = entry.id;
      adjacent.at = entry.at;
      if (mergeProse) adjacent.text = entry.text + adjacent.text;
      adjacent.count += 1;
      adjacent.truncated ||= entry.truncated;
    } else rows.push({ ...entry, endId: entry.id, count: 1 });
  }
  rows.reverse();
  return { rows, olderCount: index + 1, laterCount: Math.max(0, entries.length - end - 1) };
}

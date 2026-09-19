import {
  SETUP_TRANSCRIPT_BATCH_ENTRIES,
  SETUP_TRANSCRIPT_ENTRY_CHARACTERS,
  SETUP_TRANSCRIPT_RETAINED_BYTES,
  SETUP_TRANSCRIPT_RETAINED_ENTRIES,
  type SetupTranscriptBatch,
  type SetupTranscriptEntry,
} from "@mex/hub-contracts/setup";

/** Defend the store even if a provider adapter forwards one enormous record. */
export const SETUP_TRANSCRIPT_MAX_APPEND_BYTES = 64 * 1_024;

type TranscriptSignal = Pick<SetupTranscriptEntry, "kind" | "text">;
interface RetainedEntry {
  readonly entry: SetupTranscriptEntry;
  readonly bytes: number;
}

/** Process-local transcript with bounded ingress, retention, and cursor pages. */
export class SetupTranscriptStore {
  private readonly entries: Array<RetainedEntry | undefined> = new Array(SETUP_TRANSCRIPT_RETAINED_ENTRIES);
  private head = 0;
  private count = 0;
  private retainedBytes = 0;
  private nextId = 1;

  constructor(private readonly runId: string, private readonly now: () => Date = () => new Date()) {
    if (runId.length !== 36 || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(runId)) {
      throw new TypeError("A setup transcript requires a UUID run identity.");
    }
  }

  append(signal: TranscriptSignal): void {
    if (signal.text.length === 0) return;
    // Only inspect bounded slices. Each decoded copy owns its text, so a V8
    // substring cannot retain the caller's complete, potentially huge string.
    const chunks: Array<{ text: string; bytes: number }> = [];
    let offset = 0;
    let appendedBytes = 0;
    while (offset < signal.text.length && appendedBytes < SETUP_TRANSCRIPT_MAX_APPEND_BYTES) {
      let end = Math.min(offset + SETUP_TRANSCRIPT_ENTRY_CHARACTERS, signal.text.length);
      if (end < signal.text.length && isHighSurrogate(signal.text.charCodeAt(end - 1))
        && isLowSurrogate(signal.text.charCodeAt(end))) end--;
      const encoded = Buffer.from(signal.text.slice(offset, end), "utf8");
      const byteEnd = utf8PrefixLength(encoded, SETUP_TRANSCRIPT_MAX_APPEND_BYTES - appendedBytes);
      if (byteEnd === 0) break;
      chunks.push({ text: encoded.toString("utf8", 0, byteEnd), bytes: byteEnd });
      appendedBytes += byteEnd;
      if (byteEnd < encoded.length) break;
      offset = end;
    }
    const truncated = offset < signal.text.length;
    if (this.nextId + chunks.length - 1 > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("The setup transcript cursor limit was reached.");
    }
    const at = this.now().toISOString();
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      while (this.count >= SETUP_TRANSCRIPT_RETAINED_ENTRIES
        || this.retainedBytes + chunk.bytes > SETUP_TRANSCRIPT_RETAINED_BYTES) this.evictOldest();
      const entry = Object.freeze({
        id: this.nextId++, at, kind: signal.kind, text: chunk.text,
        truncated: truncated && index === chunks.length - 1,
      });
      this.entries[(this.head + this.count) % SETUP_TRANSCRIPT_RETAINED_ENTRIES] = { entry, bytes: chunk.bytes };
      this.count++;
      this.retainedBytes += chunk.bytes;
    }
  }

  read(after: number, terminal: boolean): SetupTranscriptBatch {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("Invalid setup transcript cursor.");
    const firstId = this.count > 0 ? this.entries[this.head]!.entry.id : this.nextId;
    const start = Math.max(0, Math.min(this.count, after - firstId + 1));
    const entries: SetupTranscriptEntry[] = [];
    for (let index = start; index < Math.min(this.count, start + SETUP_TRANSCRIPT_BATCH_ENTRIES); index++) {
      entries.push(this.entries[(this.head + index) % SETUP_TRANSCRIPT_RETAINED_ENTRIES]!.entry);
    }
    const cursor = entries.at(-1)?.id ?? after;
    Object.freeze(entries);
    return Object.freeze({
      runId: this.runId, entries, cursor, firstId,
      truncated: after < firstId - 1,
      done: terminal && cursor >= this.nextId - 1,
    });
  }

  stats(): { readonly retainedBytes: number; readonly retainedEntries: number; readonly lastId: number } {
    return Object.freeze({ retainedBytes: this.retainedBytes, retainedEntries: this.count, lastId: this.nextId - 1 });
  }

  private evictOldest(): void {
    const oldest = this.entries[this.head]!;
    this.retainedBytes -= oldest.bytes;
    this.entries[this.head] = undefined;
    this.head = (this.head + 1) % SETUP_TRANSCRIPT_RETAINED_ENTRIES;
    this.count--;
  }
}

function utf8PrefixLength(bytes: Buffer, maximum: number): number {
  let end = Math.min(bytes.length, maximum);
  if (end < bytes.length) {
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  }
  return end;
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

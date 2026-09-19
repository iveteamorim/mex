import {
  SETUP_TRANSCRIPT_BATCH_ENTRIES,
  SETUP_TRANSCRIPT_ENTRY_CHARACTERS,
  SETUP_TRANSCRIPT_RETAINED_BYTES,
  SETUP_TRANSCRIPT_RETAINED_ENTRIES,
  SetupTranscriptBatchSchema,
} from "@mex/hub-contracts/setup";
import { describe, expect, it } from "vitest";
import { SETUP_TRANSCRIPT_MAX_APPEND_BYTES, SetupTranscriptStore } from "../transcript.js";

const runId = "22222222-2222-4222-8222-222222222222";
const at = "2026-09-10T12:00:00.000Z";
const createStore = () => new SetupTranscriptStore(runId, () => new Date(at));

describe("bounded setup transcript", () => {
  it("keeps empty and active streams open, and completes only when terminal pages drain", () => {
    const store = createStore();
    expect(store.read(0, false)).toEqual({ runId, entries: [], cursor: 0, firstId: 1, truncated: false, done: false });
    expect(store.read(0, true).done).toBe(true);
    for (let index = 0; index < 70; index++) store.append({ kind: "output", text: `line ${index}` });
    const first = store.read(0, true);
    expect(first.entries).toHaveLength(SETUP_TRANSCRIPT_BATCH_ENTRIES);
    expect(first).toMatchObject({ cursor: 32, firstId: 1, truncated: false, done: false });
    const second = store.read(first.cursor, true);
    expect(second).toMatchObject({ cursor: 64, done: false });
    const third = store.read(second.cursor, true);
    expect(third.entries.map((entry) => entry.id)).toEqual([65, 66, 67, 68, 69, 70]);
    expect(third.done).toBe(true);
    expect(store.read(third.cursor, true)).toMatchObject({ entries: [], cursor: 70, done: true });
    expect(store.read(third.cursor, false).done).toBe(false);
    expect(SetupTranscriptBatchSchema.safeParse(third).success).toBe(true);
  });

  it("preserves all permitted kinds and timestamps and ignores empty signals", () => {
    const store = createStore();
    store.append({ kind: "notice", text: "" });
    const kinds = ["assistant", "command", "output", "file", "tool", "notice"] as const;
    kinds.forEach((kind) => store.append({ kind, text: `${kind} text` }));
    expect(store.read(0, false).entries).toEqual(kinds.map((kind, index) => ({
      id: index + 1, at, kind, text: `${kind} text`, truncated: false,
    })));
  });

  it("splits a large signal without losing text or cutting Unicode surrogate pairs", () => {
    const store = createStore();
    const text = `${"a".repeat(4_095)}😀${"é界".repeat(3_000)}`;
    store.append({ kind: "assistant", text });
    const entries = store.read(0, true).entries;
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.map((entry) => entry.text).join("")).toBe(text);
    expect(entries[0]!.text).toBe("a".repeat(4_095));
    expect(entries.every((entry) => entry.text.length <= SETUP_TRANSCRIPT_ENTRY_CHARACTERS && !entry.truncated)).toBe(true);
    expect(entries.some((entry) => entry.text.includes("�"))).toBe(false);
    expect(store.stats().retainedBytes).toBe(Buffer.byteLength(text));
    expect(SetupTranscriptBatchSchema.safeParse(store.read(0, true)).success).toBe(true);
  });

  it.each(["x", "😀", "界"])("bounds enormous %s input by UTF-8 bytes and marks the last admitted chunk", (character) => {
    const store = createStore();
    const input = character.repeat(2_000_000);
    store.append({ kind: "output", text: input });
    const entries = store.read(0, true).entries;
    const kept = entries.map((entry) => entry.text).join("");
    expect(kept.length).toBeGreaterThan(0);
    expect(input.startsWith(kept)).toBe(true);
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(SETUP_TRANSCRIPT_MAX_APPEND_BYTES);
    expect(entries.filter((entry) => entry.truncated)).toEqual([entries.at(-1)]);
    expect(entries.every((entry) => entry.text.length <= SETUP_TRANSCRIPT_ENTRY_CHARACTERS)).toBe(true);
    expect(kept).not.toContain("�");
    expect(store.stats().retainedBytes).toBe(Buffer.byteLength(kept));
    expect(SetupTranscriptBatchSchema.safeParse(store.read(0, true)).success).toBe(true);
  });

  it("evicts oldest UTF-8 payloads at the byte cap and reports cursor gaps honestly", () => {
    const store = createStore();
    const text = "😀".repeat(2_048);
    for (let index = 0; index < 200; index++) store.append({ kind: "output", text });
    expect(store.stats()).toEqual({ retainedBytes: SETUP_TRANSCRIPT_RETAINED_BYTES, retainedEntries: 128, lastId: 200 });
    const missed = store.read(0, true);
    expect(missed).toMatchObject({ firstId: 73, cursor: 104, truncated: true, done: false });
    expect(missed.entries[0]!.id).toBe(73);
    expect(store.read(72, false).truncated).toBe(false);
    expect(store.read(73, false).entries[0]!.id).toBe(74);
    let cursor = missed.cursor;
    while (cursor < 200) {
      const next = store.read(cursor, true);
      expect(next.truncated).toBe(false);
      expect(next.cursor).toBeGreaterThan(cursor);
      cursor = next.cursor;
      expect(next.done).toBe(cursor === 200);
    }
  });

  it("caps entry overhead independently of bytes through repeated ring wraparound", () => {
    const store = createStore();
    for (let index = 0; index < 10_000; index++) store.append({ kind: "output", text: "x" });
    expect(store.stats()).toEqual({ retainedBytes: SETUP_TRANSCRIPT_RETAINED_ENTRIES,
      retainedEntries: SETUP_TRANSCRIPT_RETAINED_ENTRIES, lastId: 10_000 });
    const batch = store.read(0, false);
    expect(batch).toMatchObject({ firstId: 7_953, cursor: 7_984, truncated: true, done: false });
    expect(batch.entries).toHaveLength(32);
  });

  it("keeps returned snapshots immutable and detached from later append and eviction", () => {
    const store = createStore();
    store.append({ kind: "assistant", text: "first" });
    const snapshot = store.read(0, false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(() => { snapshot.entries[0]!.text = "rewritten"; }).toThrow();
    expect(() => snapshot.entries.push(snapshot.entries[0]!)).toThrow();
    for (let index = 0; index < 2_050; index++) store.append({ kind: "output", text: "later" });
    expect(snapshot).toMatchObject({ cursor: 1, firstId: 1, entries: [{ id: 1, text: "first" }] });
    expect(store.read(0, false)).toMatchObject({ firstId: 4, truncated: true });
  });

  it("allows an active reader to continue from its cursor as output arrives", () => {
    const store = createStore();
    store.append({ kind: "command", text: "command one" });
    const first = store.read(0, false);
    expect(store.read(first.cursor, false)).toMatchObject({ entries: [], cursor: 1, done: false });
    store.append({ kind: "output", text: "result one" });
    expect(store.read(first.cursor, true)).toMatchObject({ cursor: 2, done: true, entries: [{ id: 2, text: "result one" }] });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cursor %s", (cursor) => {
    expect(() => createStore().read(cursor, false)).toThrow("Invalid setup transcript cursor");
  });
});

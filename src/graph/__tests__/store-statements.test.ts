import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqlite, type SqliteDatabase } from "../db/sqlite.js";
import { GraphStore } from "../db/store.js";
import { FingerprintStore } from "../fingerprint-store.js";
import type { GraphNode } from "../types.js";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

function fixture() {
  const db = openSqlite(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { db, store: new GraphStore(db) };
}

function node(id: string): GraphNode {
  return {
    id, kind: "function", name: id, qualifiedName: id, filePath: "src/example.ts",
    language: "typescript", startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1,
  };
}

describe("GraphStore statement ownership", () => {
  it("prepares a fixed number of statements across repeated writes, replacements and point reads", () => {
    const { db, store } = fixture();
    const prepare = vi.spyOn(db, "prepare");
    const exercise = (count: number) => store.transaction(() => {
      for (let index = 0; index < count; index++) {
        const source = node(`source:${index}`);
        const target = node(`target:${index}`);
        store.insertNode(source);
        store.insertNode(target);
        store.insertNode({ ...target, returnType: "string" });
        store.insertEdge({ source: source.id, target: target.id, kind: "calls", confidence: 0.5 });
        store.insertEdge({ source: source.id, target: target.id, kind: "calls", confidence: 1 });
        store.upsertFile({
          path: source.filePath, contentHash: `hash:${index}`, language: "typescript", size: 10,
          modifiedAt: 1, indexedAt: 1, nodeCount: count * 2,
        });
        store.insertUnresolvedRef({
          fromNodeId: source.id, referenceName: "unknown", referenceKind: "calls",
          filePath: source.filePath, language: "typescript",
        });
        store.insertImportBinding({
          bindingKey: `binding:${index}`, filePath: source.filePath, localName: "target",
          importedName: "target", moduleSpecifier: "./target", targetId: target.id,
        });
        store.insertAlias(`alias:${index}`, target.id, "identity", 1);
        store.replaceSourceChunks(source.filePath, "export function source() { return target(); }", `hash:${index}`);
        store.replaceSourceChunks(source.filePath, "export function revised() { return target(); }", `hash:${index}`);
        expect(store.getNodeById(`alias:${index}`)?.returnType).toBe("string");
        expect(store.getFileRecord(source.filePath)?.contentHash).toBe(`hash:${index}`);
        store.setMetadata("counter", String(index));
        expect(store.getMetadata("counter")).toBe(String(index));
      }
    });
    exercise(1);
    const preparations = prepare.mock.calls.length;
    expect(preparations).toBeLessThanOrEqual(20);
    exercise(80);
    expect(prepare).toHaveBeenCalledTimes(preparations);
    expect(store.getAllNodes()).toHaveLength(160);
    expect(store.getAllNodeIds()).toEqual(store.getAllNodes().map((entry) => entry.id).sort());
    expect(store.getAllEdges()).toHaveLength(80);
    expect(store.getAllUnresolvedRefs()).toHaveLength(80);
    expect(store.searchSourceChunks("revised")).toHaveLength(1);
    expect(store.searchSourceChunks("source")).toEqual([]);
    expect(store.validateInvariants(160)).toEqual({ nodes: 160, duplicateEdges: 0, danglingEdges: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps statements usable after rollback while restoring graph, edge and source-search rows", () => {
    const { db, store } = fixture();
    store.insertNode(node("original"));
    store.replaceSourceChunks("src/example.ts", "originalword", "old");
    expect(() => store.transaction(() => {
      store.insertNode(node("aborted"));
      store.insertEdge({ source: "original", target: "aborted", kind: "calls" });
      store.replaceSourceChunks("src/example.ts", "abortedword", "aborted");
      throw new Error("abort publication");
    })).toThrow("abort publication");
    expect(store.getNodeById("aborted")).toBeNull();
    expect(store.getAllEdges()).toEqual([]);
    expect(store.searchSourceChunks("originalword")).toHaveLength(1);
    expect(store.searchSourceChunks("abortedword")).toEqual([]);

    store.transaction(() => {
      store.insertNode(node("committed"));
      store.insertEdge({ source: "original", target: "committed", kind: "calls" });
      store.replaceSourceChunks("src/example.ts", "committedword", "committed");
    });
    expect(store.getNodeById("committed")?.name).toBe("committed");
    expect(store.getAllEdges()).toHaveLength(1);
    expect(store.searchSourceChunks("committedword")).toHaveLength(1);
    expect(store.searchSourceChunks("originalword")).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("does not share statements with active caller-owned iterators or another connection", () => {
    const first = fixture();
    for (const id of ["a", "b", "c"]) first.store.insertNode(node(id));
    const iterator = first.db.prepare("SELECT * FROM nodes").iterate();
    expect((iterator.next().value as { id: string }).id).toBe("a");
    expect(first.store.getAllNodes().map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(first.store.getNodeById("c")?.id).toBe("c");
    expect([...iterator].map((entry) => (entry as { id: string }).id)).toEqual(["b", "c"]);

    const second = fixture();
    second.store.insertNode({ ...node("a"), name: "second database" });
    expect(first.store.getNodeById("a")?.name).toBe("a");
    expect(second.store.getNodeById("a")?.name).toBe("second database");
    first.db.close();
    expect(() => first.store.getNodeById("a")).toThrow();
    expect(second.store.getNodeById("a")?.name).toBe("second database");
  });

  it("reuses the fingerprint point read without caching results across writes", () => {
    const { db, store: graph } = fixture();
    graph.insertNode(node("a"));
    graph.insertAlias("old-a", "a", "identity", 1);
    const store = new FingerprintStore(db);
    const prepare = vi.spyOn(db, "prepare");
    for (let index = 0; index < 20; index++) expect(store.get("old-a")).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
    const fingerprint = { minhash: Array.from({ length: 64 }, (_, index) => index), neighbors: [], tokenCount: 64 };
    store.upsert("a", fingerprint);
    const afterWrite = prepare.mock.calls.length;
    expect(store.get("old-a")).toEqual(fingerprint);
    expect(store.get("a")).toEqual(fingerprint);
    expect(prepare).toHaveBeenCalledTimes(afterWrite);
    db.close();
    expect(() => store.get("a")).toThrow();
  });
});

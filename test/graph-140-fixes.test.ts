// Regression coverage for the issue #140 fix set:
//  1. a crashing TypeScript program (TS-internal assertion) must not abort the
//     whole graph build — affected files fall back to tree-sitter extraction;
//  2. `mex check` opens the graph read-only: no staging, no store writes, and
//     staleness is reported instead of silently rebuilt;
//  3. `mex graph repair` recovers a stranded WAL (killed writer) in place.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { loadReadOnlyGroundingRuntime } from "../src/graph/runtime.js";
import { runGraphRepair } from "../src/graph/cli-graph.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../src/graph/snapshot.js";

const roots: string[] = [];

function fixture(prefix: string): { root: string; source: string; config: MexConfig; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  const source = join(root, "src", "checkout.ts");
  writeFileSync(source, `
export function calculateCheckoutTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const shipping = subtotal >= 100 ? 0 : 12;
  return subtotal + shipping;
}
`);
  return {
    root,
    source,
    config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] },
    dbPath: join(root, ".mex", "graph.db"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file locks */ }
  }
});

describe("compiler program-crash isolation (#140 follow-up)", () => {
  it("completes the build via tree-sitter when every TS program creation asserts", async () => {
    const { root, dbPath } = fixture("mex-140-isolation-");
    // Hostile-fixture shape from the TypeScript repo: duplicate same-identity
    // declarations in one file must ordinal-disambiguate, not abort staging.
    writeFileSync(join(root, "src", "dupes.ts"),
      "export function duplicated(): number { return 1; }\n"
      + "export function duplicated(): number { return 2; }\n");
    const engine = createGraphEngine({
      rootDir: root,
      compilerExtraction: {
        programFactory: () => { throw new Error("Debug Failure. False expression."); },
      },
    });
    const result = await engine.build();
    engine.close();

    expect(result.filesIndexed).toBeGreaterThan(0);
    const db = openSqlite(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE file_path = 'src/checkout.ts' AND kind = 'function'",
      ).get() as { n: number };
      // The function still exists in the graph — extracted by tree-sitter.
      expect(row.n).toBeGreaterThan(0);
      const dupes = db.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE file_path = 'src/dupes.ts' AND kind = 'function'",
      ).get() as { n: number };
      expect(dupes.n).toBe(2);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("read-only grounding runtime (#140 observation 2)", () => {
  it("never writes the store and reports staleness instead of staging", async () => {
    const { root, source, config, dbPath } = fixture("mex-140-readonly-");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

    const fresh = await loadReadOnlyGroundingRuntime(config, { loadRuntime: true });
    expect(fresh.graphStatus.status).toBe("fresh");
    expect(fresh.runtime).not.toBeNull();
    fresh.runtime!.close();

    writeFileSync(source, readFileSync(source, "utf-8").replace(": 12", ": 15"));
    const stale = await loadReadOnlyGroundingRuntime(config, { loadRuntime: true });
    expect(stale.graphStatus.status).toBe("stale");
    expect(stale.runtime).toBeNull();

    const after = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    expect(after).toBe(before);
  }, 30_000);
});

describe("mex graph repair (#140 observation 3)", () => {
  it("checkpoints a stranded WAL from a killed writer without rebuilding", async () => {
    const { root, dbPath } = fixture("mex-140-repair-");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    // Simulate a killed writer: a child process writes under WAL with
    // auto-checkpoint disabled and dies without closing the connection.
    const strand = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.prepare(
        "INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run("stranded_marker", "1", Date.now());
      process.kill(process.pid, "SIGKILL");
    `, dbPath], { encoding: "utf-8" });
    expect(strand.status).not.toBe(0);
    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath) && statSync(walPath).size > 0).toBe(true);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runGraphRepair(root)).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("Graph store repaired");
    } finally {
      log.mockRestore();
    }
    // The WAL is checkpointed and truncated; the write it held survived.
    expect(!existsSync(walPath) || statSync(walPath).size === 0).toBe(true);
    const db = openSqlite(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'stranded_marker'").get() as
        | { value: string } | undefined;
      expect(row?.value).toBe("1");
    } finally {
      db.close();
    }
  }, 30_000);

  it("returns 1 when no graph store exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-140-norepair-"));
    roots.push(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runGraphRepair(root)).toBe(1);
      const rendered = error.mock.calls.flat().join("\n");
      expect(rendered).toContain("mex graph rebuild");
      expect(rendered).not.toContain(root);
    } finally {
      error.mockRestore();
    }
  });
});

describe("schema v4 fingerprint re-encode (#140 storage follow-up)", () => {
  it("migrates a v2-encoded store losslessly without marking rebuild-required", async () => {
    const { root, dbPath } = fixture("mex-140-v3-migrate-");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    const { FingerprintStore } = await import("../src/graph/fingerprint-store.js");
    const { bandHashes, decodeMinhash } = await import("../src/graph/fingerprint.js");
    const {
      openGraphDatabase,
      readSchemaVersion,
      graphRequiresRebuild,
      upgradeGraphDatabase,
      DB_SCHEMA_VERSION,
    } =
      await import("../src/graph/db/database.js");

    // Snapshot the real fingerprints, then hand-downgrade the store to the
    // exact v2 encoding: JSON minhash text, TEXT node ids in lsh_buckets,
    // 64-char hex band hashes, idx_lsh, and a version-2 row.
    const db = openSqlite(dbPath);
    const rows = db.prepare("SELECT node_id, minhash, neighbors, token_count FROM node_fingerprints").all() as
      Array<{ node_id: string; minhash: Uint8Array; neighbors: string; token_count: number }>;
    expect(rows.length).toBeGreaterThan(0);
    const reference = new Map(rows.map((row) => [row.node_id, {
      minhash: decodeMinhash(row.minhash),
      neighbors: JSON.parse(row.neighbors) as string[],
      tokenCount: row.token_count,
    }]));
    db.exec(`CREATE TABLE nf_old (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      minhash TEXT NOT NULL, neighbors TEXT NOT NULL, token_count INTEGER NOT NULL)`);
    const insertOld = db.prepare("INSERT INTO nf_old VALUES (?, ?, ?, ?)");
    for (const row of rows) {
      insertOld.run(row.node_id, JSON.stringify(decodeMinhash(row.minhash)), row.neighbors, row.token_count);
    }
    db.exec("DROP TABLE lsh_buckets");
    db.exec("DROP TABLE node_fingerprints");
    db.exec("ALTER TABLE nf_old RENAME TO node_fingerprints");
    db.exec(`CREATE TABLE lsh_buckets (
      band INTEGER NOT NULL, band_hash TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE)`);
    db.exec("CREATE INDEX idx_lsh ON lsh_buckets(band, band_hash)");
    const insertBucket = db.prepare("INSERT INTO lsh_buckets VALUES (?, ?, ?)");
    for (const [nodeId, fingerprint] of reference) {
      bandHashes(fingerprint).forEach((hash, band) => insertBucket.run(band, hash, nodeId));
    }
    db.exec("DELETE FROM schema_versions");
    db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (2, 0, 'v2 fixture')").run();
    const snapshotRow = db.prepare("SELECT value FROM project_metadata WHERE key = ?")
      .get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
    const snapshot = parseGraphSnapshot(snapshotRow.value);
    expect(snapshot).not.toBeNull();
    db.prepare("UPDATE project_metadata SET value = ? WHERE key = ?").run(
      serializeGraphSnapshot({ ...snapshot!, schemaVersion: 2 }),
      GRAPH_SNAPSHOT_METADATA_KEY,
    );
    db.close();

    // Ordinary opens never upgrade. Explicit repair owns the isolated
    // candidate boundary and performs this recognized lossless conversion.
    expect(() => openGraphDatabase(dbPath)).toThrow(/expects graph schema 4/u);
    const unchanged = openSqlite(dbPath, { readOnly: true });
    expect(readSchemaVersion(unchanged)).toBe(2);
    unchanged.close();
    expect(upgradeGraphDatabase(dbPath)).toMatchObject({
      fromVersion: 2,
      toVersion: DB_SCHEMA_VERSION,
      lineage: "v2",
      changed: true,
      requiresRebuild: false,
    });

    const migrated = openGraphDatabase(dbPath);
    try {
      expect(readSchemaVersion(migrated)).toBe(DB_SCHEMA_VERSION);
      expect(graphRequiresRebuild(migrated)).toBe(false);
      const store = new FingerprintStore(migrated);
      for (const [nodeId, fingerprint] of reference) {
        expect(store.get(nodeId)).toEqual(fingerprint);
        const hits = store.lookup(fingerprint).map((entry) => entry.nodeId);
        expect(hits).toContain(nodeId);
      }
    } finally {
      migrated.close();
    }
  }, 30_000);
});

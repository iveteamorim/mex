import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFts5Available, openGraphDatabase } from "../db/database.js";
import type { SqliteDatabase } from "../db/sqlite.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.doUnmock("../db/sqlite.js");
});

/** Minimal SqliteDatabase fake: only `exec` is exercised by assertFts5Available. */
function fakeDb(execImpl: (sql: string) => void): SqliteDatabase {
  return {
    prepare: () => {
      throw new Error("not used by this test");
    },
    exec: execImpl,
    pragma: () => {},
    transaction: (fn) => fn(),
    close: () => {},
    open: true,
  };
}

/**
 * The probe takes an injected opener precisely so its failure paths are
 * reachable without an FTS5-less Node build — and without module mocking, which
 * cannot reach a call `sqlite.ts` makes to its own `openSqlite`.
 */
function failingOpener(execImpl: (sql: string) => void) {
  return (() => fakeDb(execImpl)) as unknown as Parameters<typeof assertFts5Available>[0];
}

describe("assertFts5Available", () => {
  it("does not throw when FTS5 statements succeed", () => {
    // node:sqlite is compiled with FTS5 in every environment these tests run
    // in (see sqlite.ts's module comment), so this exercises the real probe
    // against a real throwaway :memory: connection end to end.
    expect(() => assertFts5Available()).not.toThrow();
  });

  it("raises an actionable, Node-version-specific message on the exact SQLite error from issue #110", () => {
    const probe = failingOpener(() => {
      throw new Error("no such module: fts5");
    });

    expect(() => assertFts5Available(probe)).toThrowError(
      new RegExp(`Node \\(${process.version.replace(/[.+]/g, "\\$&")}\\).*FTS5.*no such module: fts5`, "s"),
    );
  });

  it("re-throws an unrelated exec failure unchanged, rather than misattributing it to FTS5", () => {
    const probe = failingOpener(() => {
      throw new Error("database is locked");
    });

    expect(() => assertFts5Available(probe)).toThrowError("database is locked");
    expect(() => assertFts5Available(probe)).not.toThrow(/FTS5/);
  });

  it("closes the throwaway probe connection on both the success and failure paths", () => {
    let opened = 0;
    let closed = 0;
    const counting = (execImpl: (sql: string) => void) => (() => {
      opened += 1;
      return { ...fakeDb(execImpl), close: () => { closed += 1; } };
    }) as unknown as Parameters<typeof assertFts5Available>[0];

    assertFts5Available(counting(() => {}));
    expect(() => assertFts5Available(counting(() => {
      throw new Error("no such module: fts5");
    }))).toThrow(/FTS5/);
    expect(closed).toBe(opened);
  });
});

describe("openGraphDatabase FTS5 preflight", () => {
  it("still opens normally on a machine whose SQLite build has FTS5 (the common case)", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-database-fts5-"));
    roots.push(root);

    const db = openGraphDatabase(join(root, "graph.db"));
    try {
      // exercised implicitly by openGraphDatabase not throwing; assert the FTS5
      // tables schema.sql defines actually exist, confirming the preflight probe
      // did not somehow prevent or corrupt the real schema application
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_fts%'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("never opens the store when the preflight fails, on the write path or either read path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-database-fts5-guarded-"));
    roots.push(root);
    const dbPath = join(root, "graph.db");
    openGraphDatabase(dbPath).close();

    vi.resetModules();
    vi.doMock("../db/sqlite.js", async () => {
      const actual = await vi.importActual<typeof import("../db/sqlite.js")>("../db/sqlite.js");
      const storeOpens: string[] = [];
      return {
        ...actual,
        // Only the probe's own :memory: connection is faked; a real store open
        // is recorded so the test can prove it never happened.
        assertFts5Available: () => actual.assertFts5Available((() => fakeDb(() => {
          throw new Error("no such module: fts5");
        })) as unknown as typeof actual.openSqlite),
        openSqlite: (path: string, options?: { readOnly?: boolean; immutable?: boolean }) => {
          storeOpens.push(path);
          return actual.openSqlite(path, options);
        },
        __storeOpens: () => storeOpens,
      };
    });

    const fresh = await import("../db/database.js");
    const sqliteMock = (await import("../db/sqlite.js")) as unknown as { __storeOpens: () => string[] };

    for (const options of [{}, { readOnly: true }, { readOnly: true, immutable: true }]) {
      expect(() => fresh.openGraphDatabase(dbPath, options)).toThrow(/FTS5/);
    }
    // The preflight runs before the store is opened, so there is no handle to
    // close — strictly better than opening one and closing it on the way out.
    expect(sqliteMock.__storeOpens()).toEqual([]);
  });
});

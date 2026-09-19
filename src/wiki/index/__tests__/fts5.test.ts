import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fts5UnavailableDiagnostic } from "../fts5.js";
import { createWikiIndex, openWikiIndex as openWikiIndexReal } from "../open.js";
import { assertFts5Available, openSqlite } from "../../../graph/db/sqlite.js";

/**
 * Issue #110: a Node whose bundled SQLite lacks FTS5 cannot read the wiki
 * index, and said so with SQLite's raw `no such module: fts5`. No such Node
 * exists to test against here, so the probe's opener is injected; everything
 * downstream of it is the production path.
 */

const withoutFts5: typeof openSqlite = () => ({
  prepare: () => {
    throw new Error("not reached");
  },
  exec: () => {
    throw new Error("no such module: fts5");
  },
  pragma: () => {},
  transaction: (fn) => fn(),
  close: () => {},
  open: true,
});

describe("fts5UnavailableDiagnostic", () => {
  it("stays out of the way when FTS5 works, which is the ordinary case", () => {
    expect(fts5UnavailableDiagnostic("wiki.db")).toBeNull();
  });

  it("reports its own code, not one whose remediation is a rebuild that cannot help", () => {
    const emitted = fts5UnavailableDiagnostic("wiki.db", () => assertFts5Available(withoutFts5));

    expect(emitted?.code).toBe("WIKI_INDEX_FTS5_UNAVAILABLE");
    expect(emitted?.code).not.toBe("WIKI_INDEX_REBUILD_REQUIRED");
  });

  it("carries the actionable message and the index it was asked about", () => {
    const emitted = fts5UnavailableDiagnostic("/tmp/scaffold/wiki.db", () =>
      assertFts5Available(withoutFts5));

    expect(emitted?.message).toContain("FTS5");
    expect(emitted?.message).toContain(process.version);
    expect(emitted?.file).toBe("/tmp/scaffold/wiki.db");
  });
});

describe("openWikiIndex without FTS5", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.doUnmock("../fts5.js");
    vi.resetModules();
  });

  it("refuses a real, intact index rather than letting SQLite's raw error escape", async () => {
    // A genuine index file, built the way a rebuild builds one — the point is
    // that nothing is wrong with it. Only the engine reading it is unable.
    const root = mkdtempSync(join(tmpdir(), "mex-wiki-fts5-open-"));
    roots.push(root);
    const path = join(root, "wiki.db");
    createWikiIndex(path).close();

    vi.resetModules();
    vi.doMock("../fts5.js", async () => {
      const actual = await vi.importActual<typeof import("../fts5.js")>("../fts5.js");
      return {
        fts5UnavailableDiagnostic: (file: string) =>
          actual.fts5UnavailableDiagnostic(file, () => assertFts5Available(withoutFts5)),
      };
    });
    const { openWikiIndex } = await import("../open.js");

    const opened = openWikiIndex(path);

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.diagnostic.code).toBe("WIKI_INDEX_FTS5_UNAVAILABLE");
    // The distinction that matters: a rebuild on this Node cannot help, so the
    // user must not be sent to `mex wiki rebuild-index`.
    expect(opened.diagnostic.code).not.toBe("WIKI_INDEX_REBUILD_REQUIRED");
    expect(opened.diagnostic.message).toContain("FTS5");
  });

  it("opens that same index normally once the engine can do FTS5", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-wiki-fts5-ok-"));
    roots.push(root);
    const path = join(root, "wiki.db");
    createWikiIndex(path).close();

    const opened = openWikiIndexReal(path);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.index.close();
  });
});

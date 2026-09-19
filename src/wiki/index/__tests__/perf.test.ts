/**
 * D10 workload characterization and deterministic complexity guards.
 *
 * Timings from a shared unit-test worker are useful diagnostics, but not stable
 * pass/fail contracts. The release benchmark enforces numeric budgets on its
 * pinned Ubuntu/Node environment. Here, a tenth-scale corpus proves non-vacuous
 * rebuild/query behavior and instruments refresh source reads so a fallback to
 * reparsing the whole scaffold fails independent of machine speed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildWikiIndex } from "../rebuild.js";
import { refreshWikiIndex } from "../refresh.js";
import { getEntity, listEntities, relatedEntities, searchEntities } from "../../query/get.js";
import { createScaffold, steppingClock, type Scaffold } from "./harness.js";

/** 100 files x 5 entities: a tenth of D10's 1,000 files / 5,000 entities. */
const FILES = 100;
const ENTITIES_PER_FILE = 5;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A distinct, well-formed entity id per index. */
function idFor(index: number): string {
  let suffix = "";
  let remaining = index;
  for (let position = 0; position < 6; position += 1) {
    suffix = ALPHABET[remaining % 32]! + suffix;
    remaining = Math.floor(remaining / 32);
  }
  return `mx_01KR2E4K002H3ZYA9G0C${suffix}`;
}

let scaffold: Scaffold;
let indexPath: string;

function fileText(fileIndex: number): string {
  let text = "";
  for (let entity = 0; entity < ENTITIES_PER_FILE; entity += 1) {
    const index = fileIndex * ENTITIES_PER_FILE + entity;
    // Every entity points at the next, so resolution has real work to do and a
    // resolver that is quadratic in the entity count shows up immediately.
    const target = idFor((index + 1) % (FILES * ENTITIES_PER_FILE));
    text +=
      `<!-- mex:entity\nid: ${idFor(index)}\ntype: decision\nstatus: promoted\nrevision: 1\n` +
      `relations:\n  - type: depends_on\n    target: ${target}\n-->\n` +
      `## Entity ${String(index).padStart(4, "0")}\n\nProse for entity ${index}, with searchable words in it.\n\n`;
  }
  return text;
}

beforeAll(() => {
  scaffold = createScaffold();
  indexPath = join(scaffold.root, "wiki.db");
  for (let file = 0; file < FILES; file += 1) scaffold.write(`notes/file-${String(file).padStart(3, "0")}.md`, fileText(file));
});

afterAll(() => {
  scaffold.dispose();
});

function millis(body: () => void): number {
  const started = performance.now();
  body();
  return performance.now() - started;
}

let rebuildMillis = 0;

describe("D10 characterization and structural guards", () => {
  it("rebuilds a non-vacuous tenth-scale scaffold", () => {
    rebuildMillis = millis(() => {
      const result = rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
      expect(result.entityCount).toBe(FILES * ENTITIES_PER_FILE);
      expect(result.fileCount).toBe(FILES);
      expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    });
    process.stdout.write(`\n  Wiki tenth-scale rebuild: ${rebuildMillis.toFixed(1)}ms\n`);
  });

  it("refreshes one file without reparsing the scaffold", () => {
    const target = "notes/file-042.md";
    const targetAbsolute = join(scaffold.root, "notes", "file-042.md");
    scaffold.write(target, `${fileText(42)}\nChanged after rebuild.\n`);

    const sourceReads: string[] = [];
    const parseTotals: number[] = [];
    let refreshResult: ReturnType<typeof refreshWikiIndex> | undefined;
    const elapsed = millis(() => {
      refreshResult = refreshWikiIndex({
        scaffoldRoot: scaffold.root,
        indexPath,
        changed: [target],
        now: steppingClock(),
        readFile: (absolutePath) => {
          sourceReads.push(absolutePath);
          return readFileSync(absolutePath, "utf-8");
        },
        maintenance: {
          reportProgress(progress) {
            if (progress.phase === "parse" && progress.total !== undefined) parseTotals.push(progress.total);
          },
        },
      });
    });
    expect(refreshResult?.ok).toBe(true);
    if (refreshResult?.ok !== true) return;
    expect(refreshResult.reparsed).toEqual([target]);
    expect(refreshResult.removed).toEqual([]);
    expect(refreshResult.unchanged).toEqual([]);
    expect(new Set(sourceReads)).toEqual(new Set([targetAbsolute]));
    expect(sourceReads.length).toBeGreaterThan(0);
    expect(parseTotals.length).toBeGreaterThan(0);
    expect(parseTotals.every((total) => total === 1)).toBe(true);
    process.stdout.write(
      `  Wiki tenth-scale one-file refresh: ${elapsed.toFixed(1)}ms (rebuild ${rebuildMillis.toFixed(1)}ms)\n`,
    );
  });

  it("answers bounded get, list, search and related queries", () => {
    const id = idFor(7);

    const getMs = millis(() => {
      const result = getEntity(indexPath, id);
      expect(result.ok).toBe(true);
    });
    const listMs = millis(() => {
      const result = listEntities(indexPath, { limit: 50 });
      expect(result.ok && result.value.items.length).toBe(50);
    });
    const searchMs = millis(() => {
      const result = searchEntities(indexPath, "searchable", { limit: 50 });
      expect(result.ok && result.value.items.length).toBeGreaterThan(0);
    });
    const relatedMs = millis(() => {
      const result = relatedEntities(indexPath, id, { depth: 2, limit: 50 });
      expect(result.ok && result.value.reached.length).toBeGreaterThan(0);
    });

    process.stdout.write(
      `  Wiki tenth-scale reads: get ${getMs.toFixed(1)}ms · list ${listMs.toFixed(1)}ms · `
        + `search ${searchMs.toFixed(1)}ms · related ${relatedMs.toFixed(1)}ms\n`,
    );
  });
});

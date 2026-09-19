/**
 * D5, the phase's definition of done: **the clean rebuild is the oracle.**
 *
 * Two claims, tested separately because they fail differently.
 *
 * *Disposability* — delete the database, rebuild from Markdown alone, and
 * everything comes back. This one fails loudly.
 *
 * *Determinism* — a normalized dump after a long sequence of incremental
 * refreshes is byte-identical to a dump after a clean rebuild of the same final
 * state. This one is the reason the phase exists. An incremental index does not
 * crash when it goes wrong; it grows one row that quietly stops matching
 * reality, and somebody gets a confidently wrong answer six weeks later. The
 * only way to catch that is to keep a second, obviously-correct implementation
 * around — the rebuild — and diff against it.
 *
 * The mutation script is seeded, so a failure reproduces exactly.
 */

import { describe, it, expect, afterEach } from "vitest";
import { openWikiIndex } from "../open.js";
import { dumpWikiIndex } from "../dump.js";
import { rebuildWikiIndex } from "../rebuild.js";
import { refreshWikiIndex } from "../refresh.js";
import { isEntityId } from "../../model/ids.js";
import { createScaffold, steppingClock, type Scaffold } from "./harness.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { toPosix } from "../../../paths.js";

/**
 * Twelve generated ULIDs, asserted well-formed by the test below rather than by
 * eye. P2a's corpus shipped eight ids that were not ids because nothing ever
 * checked; a literal list that is never validated is the same trap.
 */
const IDS = [
  "mx_01KR2E4K002H3ZYA9G0C4XV531",
  "mx_01KRMEXM00JAAVJPQVVRX8N56V",
  "mx_01KS6FPN00RT04JXY9QEG0JN19",
  "mx_01KSRGFP00P5TVKWJ2P5Z9DFJV",
  "mx_01KTAH8Q004DSGTECA5MBCRZ88",
  "mx_01KTWJ1R00FFGFA48FZBYSZ90D",
  "mx_01KVEJTS0033N8ZWSQZXJNG34H",
  "mx_01KW0KKT00Q5R49QMFGW64X5T6",
  "mx_01KWJMCV00ACM2H6XN8PNM4010",
  "mx_01KX4N5W00W749S2GMK0FDV1Z5",
  "mx_01KXPNYX00DKJMWWS0R74V43ZM",
  "mx_01KY8PQY00F4MT10396E7B21R7",
] as const;

const TOPIC_ID = IDS[0];

/** Deterministic PRNG, so a failing run is reproducible from its seed alone. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface EntitySpec {
  id: string;
  type: string;
  status: string;
  /** Entity ids this one points at. May not exist — that is the interesting case. */
  targets: string[];
  body: string;
}

function entityMarkdown(spec: EntitySpec): string {
  const relations =
    spec.targets.length === 0
      ? ""
      : `relations:\n${spec.targets.map((target) => `  - type: depends_on\n    target: ${target}`).join("\n")}\n`;
  return (
    `<!-- mex:entity\nid: ${spec.id}\ntype: ${spec.type}\nstatus: ${spec.status}\nrevision: 1\n` +
    `topics: [${TOPIC_ID}]\n${relations}-->\n` +
    `## Section ${spec.id.slice(-6)}\n\n${spec.body}\n\n`
  );
}

function fileMarkdown(specs: readonly EntitySpec[]): string {
  return `---\nname: generated\ndescription: A generated file\n---\n\n# Generated\n\nIntro prose.\n\n${specs
    .map(entityMarkdown)
    .join("")}`;
}

const TOPIC_FILE = `---
name: topics
mex:
  id: ${TOPIC_ID}
  type: topic
  status: promoted
  revision: 1
  metadata:
    aliases: [generated, gen]
---

# Generated topic

Everything generated hangs off this.
`;

/** The mutable state the script drives, mirrored onto disk. */
type World = Map<string, EntitySpec[]>;

/** True when an absolute path ends with a scaffold-relative POSIX path. */
function isPath(absolutePath: string, scaffoldRelative: string): boolean {
  return toPosix(absolutePath).endsWith(scaffoldRelative);
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

describe("the index is disposable", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("declares only well-formed entity ids in its own fixtures", () => {
    // Not decorative. Every id below reaches the model's validator; one that is
    // not an id would silently produce zero entities and make every assertion
    // in this file pass over an empty index.
    expect(IDS).toHaveLength(12);
    for (const id of IDS) expect(isEntityId(id), `${id} is not a valid entity id`).toBe(true);
  });

  it("comes back in full after the database is deleted", () => {
    scaffold = createScaffold();
    scaffold.write("topics/generated.md", TOPIC_FILE);
    scaffold.write(
      "notes/a.md",
      fileMarkdown([
        { id: IDS[1], type: "decision", status: "promoted", targets: [IDS[2]], body: "Alpha prose." },
        { id: IDS[2], type: "component", status: "in_flight", targets: [], body: "Beta prose." },
      ]),
    );

    const first = rebuildWikiIndex({ scaffoldRoot: scaffold.root, now: steppingClock() });
    expect(first.entityCount).toBe(3);
    const before = readDump(first.indexPath);

    // Rebuild from Markdown alone, into a database that has never existed, with
    // a clock years away from the first one. Nothing is read out of the old
    // index on the way; if anything were, this would still pass and the claim
    // would be worthless — hence the separate path.
    const second = rebuildWikiIndex({
      scaffoldRoot: scaffold.root,
      indexPath: join(scaffold.root, "elsewhere.db"),
      now: steppingClock(Date.UTC(2027, 5, 5)),
    });

    expect(readDump(second.indexPath)).toBe(before);
    expect(before).toContain(IDS[1]);
    expect(before.length).toBeGreaterThan(500);
  });
});

describe("determinism (D5)", () => {
  let scaffold: Scaffold | null = null;
  afterEach(() => {
    scaffold?.dispose();
    scaffold = null;
  });

  it("matches a clean rebuild after 50 incremental mutations", () => {
    scaffold = createScaffold();
    const root = scaffold.root;
    const incremental = join(root, "wiki.db");
    const clean = join(root, "clean.db");

    scaffold.write("topics/generated.md", TOPIC_FILE);
    const world: World = new Map();
    world.set("notes/a.md", [
      { id: IDS[1], type: "decision", status: "promoted", targets: [IDS[2]], body: "Alpha prose." },
    ]);
    world.set("notes/b.md", [
      { id: IDS[2], type: "component", status: "promoted", targets: [IDS[3]], body: "Beta prose." },
    ]);
    for (const [path, specs] of world) scaffold.write(path, fileMarkdown(specs));

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: incremental, now: steppingClock() });

    const random = mulberry32(20260823);
    const slots = ["notes/a.md", "notes/b.md", "notes/c.md", "notes/d.md", "notes/e.md"];
    const clock = steppingClock(Date.UTC(2026, 6, 1));
    const applied: string[] = [];
    let danglingSeen = false;

    for (let step = 0; step < 50; step += 1) {
      const path = pick(random, slots);
      const existing = world.get(path);
      const roll = random();

      if (existing === undefined) {
        // Create a file, sometimes pointing at a target that does not exist yet.
        const target = pick(random, IDS);
        const spec: EntitySpec = {
          id: pick(random, IDS.slice(1)),
          type: pick(random, ["decision", "component", "pattern", "guide"]),
          status: pick(random, ["promoted", "in_flight", "deprecated", "archived"]),
          targets: [target],
          body: `Created at step ${step}.`,
        };
        world.set(path, [spec]);
        scaffold.write(path, fileMarkdown([spec]));
        applied.push(`create ${path}`);
      } else if (roll < 0.2) {
        // Delete a file. Anything pointing into it now dangles, which is a
        // diagnostic and must survive to the dump rather than being cascaded
        // away.
        world.delete(path);
        scaffold.remove(path);
        applied.push(`delete ${path}`);
        danglingSeen = true;
      } else if (roll < 0.5) {
        const spec: EntitySpec = {
          id: pick(random, IDS.slice(1)),
          type: pick(random, ["decision", "component", "pattern"]),
          status: pick(random, ["promoted", "in_flight"]),
          targets: [pick(random, IDS)],
          body: `Added at step ${step}.`,
        };
        existing.push(spec);
        scaffold.write(path, fileMarkdown(existing));
        applied.push(`add-entity ${path}`);
      } else if (roll < 0.7 && existing.length > 1) {
        existing.pop();
        scaffold.write(path, fileMarkdown(existing));
        applied.push(`remove-entity ${path}`);
      } else {
        const target = existing[0]!;
        target.body = `Edited at step ${step}, ${"prose ".repeat(1 + Math.floor(random() * 4))}`;
        scaffold.write(path, fileMarkdown(existing));
        applied.push(`edit ${path}`);
      }

      const result = refreshWikiIndex({
        scaffoldRoot: root,
        indexPath: incremental,
        changed: [path],
        now: clock,
      });
      expect(result.ok, `refresh failed at step ${step}`).toBe(true);
    }

    // The script has to have actually done something, in every direction the
    // exit criteria name — otherwise this passes over a world nobody mutated.
    expect(applied).toHaveLength(50);
    expect(applied.some((entry) => entry.startsWith("create"))).toBe(true);
    expect(applied.some((entry) => entry.startsWith("delete"))).toBe(true);
    expect(applied.some((entry) => entry.startsWith("add-entity"))).toBe(true);
    expect(applied.some((entry) => entry.startsWith("remove-entity"))).toBe(true);
    expect(danglingSeen).toBe(true);

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: clean, now: steppingClock(Date.UTC(2030, 0, 1)) });

    const incrementalDump = readDump(incremental);
    const cleanDump = readDump(clean);

    expect(incrementalDump).toBe(cleanDump);
    // Non-vacuity: the dumps must describe a real index, not two empty ones.
    expect(cleanDump.split("\n").length).toBeGreaterThan(20);
    expect(cleanDump).toContain("wiki_entities\t");
    expect(cleanDump).toContain("wiki_fts\t");
  });

  it("reports an unreadable file identically after a refresh of an unrelated one", () => {
    // The case the 50-mutation script could not reach, and therefore the case
    // it could not catch. A file that is present but unreadable — a permissions
    // change, or a walk/read race — was reported by a rebuild and silently
    // dropped by any later refresh of a different file, because read errors
    // were recorded against the *build* while a refresh only reads its changed
    // set. That is exactly the refresh/rebuild divergence this suite exists to
    // exclude, and no assertion could see it.
    //
    // The failure is injected through the reader rather than staged on disk:
    // there is no portable way to make a real file unreadable on every machine
    // the suite runs on, and a test that is inert on the dev box protects
    // nothing there.
    scaffold = createScaffold();
    const root = scaffold.root;
    const incremental = join(root, "wiki.db");
    const clean = join(root, "clean.db");

    scaffold.write("topics/generated.md", TOPIC_FILE);
    scaffold.write(
      "notes/readable.md",
      fileMarkdown([{ id: IDS[1], type: "decision", status: "promoted", targets: [], body: "Readable." }]),
    );
    scaffold.write(
      "notes/locked.md",
      fileMarkdown([{ id: IDS[2], type: "component", status: "promoted", targets: [], body: "Never read." }]),
    );

    const readFile = (absolutePath: string): string => {
      if (isPath(absolutePath, "notes/locked.md")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return readFileSync(absolutePath, "utf-8");
    };

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: incremental, now: steppingClock(), readFile });
    expect(diagnosticCodes(incremental).filter((code) => code === "WIKI_PARSE_ERROR")).toHaveLength(1);

    // Refresh a *different* file. The unreadable one is not in the changed set.
    const refreshed = refreshWikiIndex({
      scaffoldRoot: root,
      indexPath: incremental,
      changed: ["notes/readable.md"],
      now: steppingClock(Date.UTC(2028, 0, 1)),
      readFile,
    });
    expect(refreshed.ok).toBe(true);

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: clean, now: steppingClock(Date.UTC(2029, 0, 1)), readFile });

    expect(readDump(incremental)).toBe(readDump(clean));
    // Non-vacuity: the report has to actually be in there. Both dumps agreeing
    // that nothing happened would satisfy the line above.
    expect(readDump(clean)).toContain("Could not read notes/locked.md");
  });

  it("reports an unreadable file identically when it is itself the changed file", () => {
    // The *other* half of the read-error fix, and the half nothing guarded.
    //
    // The fix has two write sites: the rebuild path, which records a read error
    // against the file, and the refresh path, which does the same in its own
    // unreadable branch. Reverting the rebuild half turns the test above red.
    // Deleting `writeFileDiagnostics` from the unreadable branch of refresh.ts
    // left every wiki test green, because the only case that reaches it is a
    // file that is unreadable *and* in the changed set — a permissions change
    // the caller does know about, which is the ordinary way a user meets this.
    //
    // Without this test the refresh half can be deleted by any later refactor
    // and the same divergence returns through the changed-set door instead of
    // the unchanged-set one.
    scaffold = createScaffold();
    const root = scaffold.root;
    const incremental = join(root, "wiki.db");
    const clean = join(root, "clean.db");

    scaffold.write("topics/generated.md", TOPIC_FILE);
    scaffold.write(
      "notes/locked.md",
      fileMarkdown([{ id: IDS[1], type: "decision", status: "promoted", targets: [], body: "Readable for now." }]),
    );

    let locked = false;
    const readFile = (absolutePath: string): string => {
      if (locked && isPath(absolutePath, "notes/locked.md")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return readFileSync(absolutePath, "utf-8");
    };

    // Indexed successfully first, so the refresh has rows to tear down and the
    // diagnostic has to be *written*, not merely left in place from a rebuild.
    rebuildWikiIndex({ scaffoldRoot: root, indexPath: incremental, now: steppingClock(), readFile });
    expect(diagnosticCodes(incremental)).not.toContain("WIKI_PARSE_ERROR");

    locked = true;
    const refreshed = refreshWikiIndex({
      scaffoldRoot: root,
      indexPath: incremental,
      changed: ["notes/locked.md"],
      now: steppingClock(Date.UTC(2028, 0, 1)),
      readFile,
    });
    expect(refreshed.ok).toBe(true);

    rebuildWikiIndex({ scaffoldRoot: root, indexPath: clean, now: steppingClock(Date.UTC(2029, 0, 1)), readFile });

    expect(readDump(incremental)).toBe(readDump(clean));
    // Non-vacuity, twice over: the report must be present, and it must be
    // present in the *refreshed* index rather than only in the clean rebuild —
    // two indexes that both forgot the file would compare equal above.
    expect(readDump(clean)).toContain("Could not read notes/locked.md");
    expect(readDump(incremental)).toContain("Could not read notes/locked.md");
  });

  it("clears the report when the file becomes readable again", () => {
    scaffold = createScaffold();
    const root = scaffold.root;
    const indexPath = join(root, "wiki.db");

    scaffold.write("topics/generated.md", TOPIC_FILE);
    scaffold.write(
      "notes/locked.md",
      fileMarkdown([{ id: IDS[2], type: "component", status: "promoted", targets: [], body: "Eventually readable." }]),
    );

    let locked = true;
    const readFile = (absolutePath: string): string => {
      if (locked && isPath(absolutePath, "notes/locked.md")) throw new Error("EACCES");
      return readFileSync(absolutePath, "utf-8");
    };

    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock(), readFile });
    expect(diagnosticCodes(indexPath)).toContain("WIKI_PARSE_ERROR");

    locked = false;
    refreshWikiIndex({ scaffoldRoot: root, indexPath, changed: ["notes/locked.md"], now: steppingClock(), readFile });
    expect(diagnosticCodes(indexPath)).not.toContain("WIKI_PARSE_ERROR");

    const clean = join(root, "clean.db");
    rebuildWikiIndex({ scaffoldRoot: root, indexPath: clean, now: steppingClock(Date.UTC(2031, 0, 1)), readFile });
    expect(readDump(indexPath)).toBe(readDump(clean));
  });

  it("re-resolves a relation whose target is deleted and then restored", () => {
    scaffold = createScaffold();
    const root = scaffold.root;
    const indexPath = join(root, "wiki.db");

    scaffold.write("topics/generated.md", TOPIC_FILE);
    const source = fileMarkdown([
      { id: IDS[1], type: "decision", status: "promoted", targets: [IDS[2]], body: "Points at the other file." },
    ]);
    const target = fileMarkdown([
      { id: IDS[2], type: "component", status: "promoted", targets: [], body: "The target." },
    ]);
    scaffold.write("notes/source.md", source);
    scaffold.write("notes/target.md", target);

    rebuildWikiIndex({ scaffoldRoot: root, indexPath, now: steppingClock() });
    expect(resolvedFlags(indexPath)).toEqual([1]);

    scaffold.remove("notes/target.md");
    refreshWikiIndex({ scaffoldRoot: root, indexPath, changed: ["notes/target.md"], now: steppingClock() });
    expect(resolvedFlags(indexPath)).toEqual([0]);
    expect(diagnosticCodes(indexPath)).toContain("INVALID_RELATION_TARGET");

    scaffold.write("notes/target.md", target);
    refreshWikiIndex({ scaffoldRoot: root, indexPath, changed: ["notes/target.md"], now: steppingClock() });
    expect(resolvedFlags(indexPath)).toEqual([1]);
    expect(diagnosticCodes(indexPath)).not.toContain("INVALID_RELATION_TARGET");
  });
});

function readDump(path: string): string {
  const opened = openWikiIndex(path);
  if (!opened.ok) throw new Error(`could not open ${path}: ${opened.diagnostic.message}`);
  try {
    return dumpWikiIndex(opened.index.db);
  } finally {
    opened.index.close();
  }
}

function resolvedFlags(path: string): number[] {
  const opened = openWikiIndex(path);
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try {
    return (opened.index.db.prepare(`SELECT target_resolved FROM wiki_relations ORDER BY source_key`).all() as {
      target_resolved: number;
    }[]).map((row) => Number(row.target_resolved));
  } finally {
    opened.index.close();
  }
}

function diagnosticCodes(path: string): string[] {
  const opened = openWikiIndex(path);
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try {
    return (opened.index.db.prepare(`SELECT code FROM wiki_diagnostics ORDER BY code`).all() as { code: string }[]).map(
      (row) => row.code,
    );
  } finally {
    opened.index.close();
  }
}

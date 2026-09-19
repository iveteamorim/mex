/**
 * The tier-1 migration corpus, and the two things that make it an oracle.
 *
 * It is generated (`scripts/generate-wiki-migration-corpus.mjs`) to match a
 * committed shape census (plan section 6a condition 2), and it must contain
 * nothing that has already been migrated — a migration test over an
 * already-migrated corpus passes and proves nothing (finding 28).
 *
 * This file lands in the corpus commit, **before the classifier exists**, which
 * is condition 1: a fixture written after the rules is a fixture shaped to pass
 * them.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { isEntityId } from "../../model/ids.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const CORPUS = join(REPO_ROOT, "test", "fixtures", "wiki-migration", "tier1");
const CENSUS = join(REPO_ROOT, "test", "fixtures", "wiki-migration", "census.json");
const CENSUS_SCRIPT = join(REPO_ROOT, "scripts", "wiki-scaffold-census.mjs");
const GENERATOR = join(REPO_ROOT, "scripts", "generate-wiki-migration-corpus.mjs");

function markdownFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) markdownFiles(absolute, out);
    else if (entry.name.endsWith(".md")) out.push(absolute);
  }
  return out;
}

const FILES = markdownFiles(CORPUS);
const RELATIVE = FILES.map((path) => relative(CORPUS, path).split(sep).join("/"));

/** Histograms are compared as maps: key order is not a fact, and absent is 0. */
function sameCounts(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const a = (actual as Record<string, number>)[key] ?? 0;
    const b = (expected as Record<string, number>)[key] ?? 0;
    if (a !== b) return false;
  }
  return true;
}

describe("the tier-1 migration corpus", () => {
  it("is not empty, and is the size the census declares", () => {
    // Everything below compares counts. If the walk found nothing, every
    // comparison would be over an empty set and would pass for the wrong
    // reason.
    expect(FILES.length).toBe(25);
    expect(RELATIVE).toContain("context/decisions.md");
    expect(RELATIVE).toContain("patterns/INDEX.md");
  });

  it("matches the committed shape census", () => {
    // Run the committed instrument, exactly as a user would, rather than a
    // second implementation of it that could drift.
    const output = execFileSync(process.execPath, [CENSUS_SCRIPT, CORPUS], { encoding: "utf-8" });
    const actual = JSON.parse(output) as Record<string, unknown>;
    const expected = JSON.parse(readFileSync(CENSUS, "utf-8")) as Record<string, unknown>;

    const mismatched: string[] = [];
    for (const key of Object.keys(expected)) {
      if (key === "schema" || key === "provenance") continue;
      if (!sameCounts(actual[key], expected[key])) {
        mismatched.push(`${key}: census ${JSON.stringify(expected[key])} but corpus ${JSON.stringify(actual[key])}`);
      }
    }
    expect(mismatched, "regenerate the corpus, or update the census deliberately").toEqual([]);
  });

  it("carries no valid entity id and no `mex:` key — it has not already been migrated", () => {
    // Finding 28's shape. Without this, every migration assertion downstream
    // could be measuring a corpus that arrived already finished.
    const offenders: string[] = [];
    for (const path of FILES) {
      const text = readFileSync(path, "utf-8");
      const name = relative(CORPUS, path).split(sep).join("/");
      for (const token of text.match(/mx_[0-9A-Za-z]+/g) ?? []) {
        if (isEntityId(token)) offenders.push(`${name} declares a valid entity id ${token}`);
      }
      if (/^mex:/m.test(text) || text.includes("<!-- mex:entity")) offenders.push(`${name} already carries mex metadata`);
    }
    expect(offenders).toEqual([]);
  });

  it("carries the legacy shapes migration exists to convert", () => {
    const texts = new Map(FILES.map((path) => [relative(CORPUS, path).split(sep).join("/"), readFileSync(path, "utf-8")]));
    const withEdges = [...texts.values()].filter((text) => /^edges:/m.test(text));
    const conditions = [...texts.values()].flatMap((text) => text.match(/^ {4}condition:/gm) ?? []);
    const targets = [...texts.values()].flatMap((text) => text.match(/^ {2}- target:/gm) ?? []);

    expect(withEdges.length).toBe(20);
    // Every edge carries a condition in a real scaffold: 77 of 77. The
    // condition-to-`note` conversion path is always live, never occasional.
    expect(targets.length).toBe(77);
    expect(conditions.length).toBe(77);
    // The outlier the census records: one hub against a mode of three. It is
    // what stresses the mint-every-id-before-converting-any-edge ordering.
    const routerEdges = (texts.get("ROUTER.md")?.match(/^ {2}- target:/gm) ?? []).length;
    expect(routerEdges).toBe(14);
    // The nested-deeper case, sixteen depth-3 headings across two files.
    const depthThree = [...texts.values()].flatMap((text) => text.match(/^### /gm) ?? []);
    expect(depthThree.length).toBe(16);
    expect(texts.get("context/decisions.md")).toMatch(/^### Store raw mail before parsing it$/m);
  });

  it("carries no grounding and no anchor — a pre-wiki scaffold has neither", () => {
    // Measured on a real filled scaffold: zero root `grounds_to`, zero
    // `mex://` anchors, zero `mex` keys. `mex ground` is what writes those, and
    // a scaffold that has not been grounded has none of them.
    //
    // So grounding migration is **not** tier 1's to cover. It belongs to tier
    // 2, which runs the real grounding path against a temporary graph so node
    // ids and `mh:64:` fingerprints are real rather than hand-typed, and to
    // tier 3's adversarial multi-entity ambiguity case. Keeping invented
    // groundings here to make that coverage look present would have made the
    // corpus disagree with every scaffold migration will actually meet.
    for (const path of FILES) {
      const text = readFileSync(path, "utf-8");
      const name = relative(CORPUS, path).split(sep).join("/");
      expect(/^grounds_to:/m.test(text), `${name} carries a root grounds_to`).toBe(false);
      expect(text.includes("](mex://"), `${name} carries an inline anchor`).toBe(false);
    }
  });

  it("says where its numbers came from, and the instrument says so too", () => {
    // The refresh command pipes the script over census.json. If the script did
    // not emit provenance, refreshing would silently replace a census marked
    // `realScaffoldCensus: true` with one that had no provenance at all — and
    // the comparison above skips `provenance`, so nothing would fail.
    const committed = JSON.parse(readFileSync(CENSUS, "utf-8")) as { provenance?: Record<string, unknown> };
    expect(committed.provenance?.realScaffoldCensus).toBe(true);
    expect(committed.provenance?.refresh).toContain("wiki-scaffold-census.mjs");

    const emitted = JSON.parse(
      execFileSync(process.execPath, [CENSUS_SCRIPT, CORPUS], { encoding: "utf-8" }),
    ) as { provenance?: Record<string, unknown> };
    expect(emitted.provenance?.realScaffoldCensus).toBe(true);
    expect(emitted.provenance?.note).toContain("Numbers only");
    // The path the script was given is itself identifying, so it must not
    // survive into anything the script prints.
    expect(JSON.stringify(emitted.provenance)).not.toContain("tier1");
  });

  it("is byte-identical to what the generator produces", () => {
    // Generated into a temp directory, never over the committed fixture. A
    // test that deletes and rewrites shared fixture bytes races every other
    // test file reading them, which is a flake that looks like a corpus bug.
    const scratch = mkdtempSync(join(tmpdir(), "wiki-corpus-"));
    execFileSync(process.execPath, [GENERATOR, scratch], { encoding: "utf-8" });
    const produced = markdownFiles(scratch);
    expect(produced.length).toBe(FILES.length);
    for (const path of produced) {
      const name = relative(scratch, path).split(sep).join("/");
      expect(readFileSync(path, "utf-8"), `${name} differs from the committed fixture`).toBe(
        readFileSync(join(CORPUS, name), "utf-8"),
      );
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("is byte-identical across two generator runs", () => {
    // Determinism: a generator with a clock or a random seed would make the
    // fixture drift on its own, and the census assertion above would then be
    // measuring whichever run happened last. Two scratch runs, never the
    // committed fixture.
    const first = mkdtempSync(join(tmpdir(), "wiki-corpus-a-"));
    const second = mkdtempSync(join(tmpdir(), "wiki-corpus-b-"));
    execFileSync(process.execPath, [GENERATOR, first], { encoding: "utf-8" });
    execFileSync(process.execPath, [GENERATOR, second], { encoding: "utf-8" });
    const names = markdownFiles(first).map((path) => relative(first, path).split(sep).join("/"));
    expect(names.length).toBe(FILES.length);
    for (const name of names) {
      expect(readFileSync(join(second, name), "utf-8"), `${name} differs between runs`).toBe(
        readFileSync(join(first, name), "utf-8"),
      );
    }
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  it("has no CRLF or BOM in tier 1 — those belong to tier 3, deliberately", () => {
    for (const path of FILES) {
      const text = readFileSync(path, "utf-8");
      expect(text.includes("\r\n"), `${relative(CORPUS, path)} has CRLF`).toBe(false);
      expect(text.charCodeAt(0) === 0xfeff, `${relative(CORPUS, path)} has a BOM`).toBe(false);
    }
    expect(statSync(CORPUS).isDirectory()).toBe(true);
  });
});

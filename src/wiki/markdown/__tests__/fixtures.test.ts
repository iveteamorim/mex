import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  FIXTURE_EXPECTATIONS,
  SCAFFOLD_FIXTURE,
  resolveExpectedRanges,
  type FixtureExpectation,
} from "./expectations.js";
import { checkRangePartition } from "../ranges.js";
import { isEntityId } from "../../model/ids.js";
import { parseWikiMarkdown, partitionRanges } from "../contract.js";

/**
 * The codec's acceptance tests, written before the codec.
 *
 * P2a wrote these against a throwing stub, so they could not be shaped around
 * an implementation. P2b built the codec and unskipped them without editing the
 * corpus or the expectations — with one sanctioned exception, recorded in the
 * plan at §3c.1: eight scaffold ids were not valid entity ids and no codec
 * could ever have parsed them.
 *
 * The meta-tests keep the corpus and the expectations honest independently of
 * the parser: that every fixture is claimed, that every anchor resolves, that
 * the ranges an expectation describes partition the file, that the encoding
 * fixtures' absolute numbers agree with their anchors, and — since the id
 * defect — that every id an expectation names is well-formed by the model's own
 * guard. That last one is the lesson: the oracle must be able to fail on its
 * own data, or it is not an oracle.
 */

const FIXTURE_ROOT = resolve(__dirname, "../../../../test/fixtures/wiki");

function read(relativePath: string): string {
  return readFileSync(join(FIXTURE_ROOT, relativePath), "utf-8");
}

/** Every `.md` file in the corpus, as POSIX paths relative to the fixture root. */
function corpusFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // The nested legacy scaffold is a migration fixture, not a Markdown
      // codec oracle. Its pre-canonical files are asserted by the migration
      // contract and must not silently become parser expectations here.
      if (entry.isDirectory() && relative(FIXTURE_ROOT, full) !== "legacy-scaffold") walk(full);
      else if (entry.name.endsWith(".md")) found.push(relative(FIXTURE_ROOT, full).replace(/\\/g, "/"));
    }
  };
  walk(FIXTURE_ROOT);
  return found.sort();
}

const CORPUS = corpusFiles();
const SCAFFOLD_PATHS = SCAFFOLD_FIXTURE.files.map((file) => `${SCAFFOLD_FIXTURE.root}/${file}`);

// -- Meta-tests: these run now and must stay green ----------------------------

describe("fixture corpus", () => {
  it("exists and is not trivially small", () => {
    // Guards against the walk matching nothing, which would make every
    // parity assertion below vacuously true.
    expect(CORPUS.length).toBeGreaterThan(25);
  });

  it("claims every fixture exactly once", () => {
    // A fixture nobody asserts against is worse than no fixture: it looks like
    // coverage and is not.
    const claimed = [...FIXTURE_EXPECTATIONS.map((entry) => entry.path), ...SCAFFOLD_PATHS].sort();
    expect(claimed).toEqual(CORPUS);
  });

  it("names no expectation for a file that does not exist", () => {
    for (const expectation of FIXTURE_EXPECTATIONS) {
      expect(CORPUS, `${expectation.path} is claimed but missing from disk`).toContain(expectation.path);
    }
  });

  it("gives every expectation a note explaining what it proves", () => {
    for (const expectation of FIXTURE_EXPECTATIONS) {
      expect(expectation.note.length, `${expectation.path} has no note`).toBeGreaterThan(20);
    }
  });

  it("names only well-formed entity ids in every expectation", () => {
    // The scaffold's ids were the ones that were wrong, but the gap was
    // generic: nothing checked that an expectation's id was an id. Covering
    // every fixture means the next hand-typed id fails here rather than
    // surfacing as an inexplicable parser failure.
    for (const expectation of FIXTURE_EXPECTATIONS) {
      for (const entity of expectation.entities) {
        expect(isEntityId(entity.id), `${expectation.path} names ${entity.id}`).toBe(true);
      }
    }
  });

  it("covers every numbered case from the brief", () => {
    const covered = new Set<number>([
      ...FIXTURE_EXPECTATIONS.flatMap((entry) => entry.covers),
      ...SCAFFOLD_FIXTURE.covers,
    ]);
    const missing = Array.from({ length: 30 }, (_, index) => index + 1).filter((number) => !covered.has(number));
    expect(missing, "these brief cases have no fixture").toEqual([]);
  });
});

describe("expectations are internally consistent", () => {
  // Resolving every anchor against the fixture text proves the expectations
  // describe text that is actually there — a typo fails here rather than
  // silently disagreeing with a correct parser much later.
  for (const expectation of FIXTURE_EXPECTATIONS) {
    describe(expectation.path, () => {
      const text = read(expectation.path);

      it("resolves every entity's anchors", () => {
        for (const entity of expectation.entities) {
          expect(() => resolveExpectedRanges(text, entity)).not.toThrow();
        }
      });

      it("anchors each entity's metadata uniquely", () => {
        // A non-unique anchor would resolve to the wrong occurrence and quietly
        // assert the wrong range — exactly what the fenced and indented
        // fixtures are designed to trap.
        for (const entity of expectation.entities) {
          const occurrences = text.split(entity.metadataStartsWith).length - 1;
          expect(occurrences, `${entity.id} metadata anchor is not unique`).toBe(1);
        }
      });

      it("describes ordered, non-overlapping ranges", () => {
        const ranges = expectation.entities.map((entity) => resolveExpectedRanges(text, entity));
        for (const range of ranges) {
          expect(range.metadataStart).toBeLessThanOrEqual(range.metadataEnd);
          expect(range.metadataEnd).toBeLessThanOrEqual(range.headingStart);
          expect(range.headingStart).toBeLessThanOrEqual(range.headingEnd);
          expect(range.headingEnd).toBe(range.bodyStart);
          expect(range.bodyStart).toBeLessThanOrEqual(range.bodyEnd);
          expect(range.bodyEnd).toBeLessThanOrEqual(text.length);
        }
        for (let index = 1; index < ranges.length; index += 1) {
          expect(ranges[index]!.metadataStart, "entities must not overlap").toBeGreaterThanOrEqual(
            ranges[index - 1]!.bodyEnd,
          );
        }
      });

      it("describes a heading whose depth matches its markers", () => {
        for (const entity of expectation.entities) {
          if (entity.headingLine === "") {
            expect(entity.headingDepth).toBe(0);
            continue;
          }
          const atx = /^(#{1,6}) /.exec(entity.headingLine);
          if (atx) {
            expect(entity.headingDepth, `${entity.id} depth disagrees with its markers`).toBe(atx[1]!.length);
            // The title is the heading text with the markers and terminator removed.
            expect(entity.headingLine.trimEnd().slice(atx[1]!.length + 1)).toBe(entity.title);
            continue;
          }
          // Setext: a text line plus an underline of = (depth 1) or - (depth 2).
          const [titleLine, underline] = entity.headingLine.trimEnd().split("\n");
          expect(titleLine).toBe(entity.title);
          expect(entity.headingDepth).toBe(underline!.startsWith("=") ? 1 : 2);
        }
      });

      if (expectation.entities.some((entity) => entity.exact !== undefined)) {
        it("agrees with its hand-derived absolute offsets", () => {
          // The cross-check that makes the encoding fixtures worth having: the
          // literal numbers and the anchors must describe the same range. If
          // they ever disagree, one of them was written carelessly.
          for (const entity of expectation.entities) {
            if (entity.exact === undefined) continue;
            expect(resolveExpectedRanges(text, entity)).toEqual(entity.exact);
          }
        });
      }
    });
  }
});

describe("encoding fixtures really do exercise encoding", () => {
  it("has a non-ASCII fixture whose UTF-16 length differs sharply from its byte length", () => {
    const text = read("adversarial/non-ascii.md");
    expect(text.length).toBe(294);
    expect(Buffer.byteLength(text, "utf8")).toBe(351);
    // A surrogate pair: one code point, two UTF-16 units. Anything measuring
    // code points rather than units is off by one per emoji.
    expect(text).toContain("\u{1F600}");
    expect("\u{1F600}".length).toBe(2);
  });

  it("has a CRLF fixture with no lone line feeds", () => {
    const text = read("adversarial/crlf.md");
    expect(text).toContain("\r\n");
    expect(/[^\r]\n/.test(text)).toBe(false);
  });

  it("has a BOM fixture that still starts with U+FEFF", () => {
    // Git would happily normalize this away; .gitattributes marks the corpus
    // -text to stop it. If this fails, that protection was lost.
    expect(read("adversarial/bom.md").charCodeAt(0)).toBe(0xfeff);
  });
});

describe("scaffold fixture", () => {
  it("has every file it claims", () => {
    for (const path of SCAFFOLD_PATHS) {
      expect(CORPUS).toContain(path);
    }
  });

  it("declares only well-formed entity ids", () => {
    // The root cause of the defect this test was added for: P2a asserted that
    // each id appeared exactly once, but never that it was an id at all, so
    // eight malformed ones — 24-25 characters, some using O, U or L, which
    // Crockford Base32 excludes as confusable — survived a full verification
    // pass. An oracle that cannot fail on its own data is not an oracle.
    //
    // Asserted with the model's own guard rather than a regex written here, so
    // the corpus and the engine can never drift to different notions of a
    // valid id.
    for (const id of SCAFFOLD_FIXTURE.entityIds) {
      expect(isEntityId(id), `${id} is not a valid entity id`).toBe(true);
    }
  });

  it("declares each of its entity ids exactly once across the scaffold", () => {
    const text = SCAFFOLD_PATHS.map((path) => read(path)).join("\n");
    for (const id of SCAFFOLD_FIXTURE.entityIds) {
      const declarations = text.split(`id: ${id}`).length - 1;
      expect(declarations, `${id} should be declared exactly once`).toBe(1);
    }
  });

  it("has a file carrying no metadata at all", () => {
    // Real scaffolds contain ordinary prose files; a parser that assumes every
    // file yields an entity breaks on them.
    for (const file of SCAFFOLD_FIXTURE.filesWithoutEntities) {
      expect(read(`${SCAFFOLD_FIXTURE.root}/${file}`)).not.toContain("mex:entity");
    }
  });
});

// -- The acceptance tests, unskipped in P2b ------------------------------------

describe("parseWikiMarkdown against the corpus", () => {
  for (const expectation of FIXTURE_EXPECTATIONS) {
    describe(expectation.path, () => {
      const text = read(expectation.path);
      const parsed = (): ReturnType<typeof parseWikiMarkdown> =>
        parseWikiMarkdown({ path: expectation.path, text });

      it("finds exactly the expected entities", () => {
        const file = parsed();
        expect(file.entities.map((entry) => entry.entity.id)).toEqual(expectation.entities.map((entry) => entry.id));
      });

      it("reports each entity's type, lifecycle, title and heading depth", () => {
        const file = parsed();
        expectation.entities.forEach((expected, index) => {
          const actual = file.entities[index]!.entity;
          expect(actual.type).toBe(expected.type);
          expect(actual.status).toBe(expected.status);
          expect(actual.title).toBe(expected.title);
          expect(actual.location!.headingDepth).toBe(expected.headingDepth);
          expect(file.entities[index]!.metadataKind).toBe(expected.metadataKind);
        });
      });

      it("reports each entity's exact ranges", () => {
        const file = parsed();
        expectation.entities.forEach((expected, index) => {
          const location = file.entities[index]!.entity.location!;
          expect({
            metadataStart: location.metadataStart,
            metadataEnd: location.metadataEnd,
            headingStart: location.headingStart,
            headingEnd: location.headingEnd,
            bodyStart: location.bodyStart,
            bodyEnd: location.bodyEnd,
          }).toEqual(resolveExpectedRanges(text, expected));
        });
      });

      it("partitions the file completely", () => {
        // The property that catches off-by-one errors a round-trip cannot see.
        const result = checkRangePartition(text, partitionRanges(parsed()));
        expect(result.ok ? null : result.message).toBeNull();
      });

      it("produces exactly the expected diagnostics", () => {
        const codes = parsed().diagnostics.map((entry) => entry.code).sort();
        expect(codes).toEqual([...expectation.diagnostics].sort());
      });

      it("never loses prose", () => {
        // Whatever else happens, every character of the file is still
        // reachable through the reported ranges.
        const file = parsed();
        const covered = partitionRanges(file)
          .map((range) => text.slice(range.start, range.end))
          .join("");
        expect(covered).toBe(text);
      });

      if (expectation.anchors) {
        it("associates inline anchors with their containing entity", () => {
          const file = parsed();
          expect(
            file.anchors.map((anchor) => ({ nodeId: anchor.nodeId, entityId: anchor.entityId })),
          ).toEqual(expectation.anchors);
        });
      }

      if (expectation.legacy) {
        it("reads legacy root-level fields without interpreting them", () => {
          const file = parsed();
          expect(file.legacy.groundsTo).toHaveLength(expectation.legacy!.groundsTo);
          expect(file.legacy.edges).toHaveLength(expectation.legacy!.edges);
        });
      }
    });
  }
});

describe("parseWikiMarkdown against the realistic scaffold", () => {
  it("finds every declared entity across the scaffold", () => {
    const found = SCAFFOLD_PATHS.flatMap((path) =>
      parseWikiMarkdown({ path, text: read(path) }).entities.map((entry) => entry.entity.id as string),
    );
    expect(found.sort()).toEqual([...SCAFFOLD_FIXTURE.entityIds].sort());
  });

  it("partitions every scaffold file", () => {
    for (const path of SCAFFOLD_PATHS) {
      const text = read(path);
      const result = checkRangePartition(text, partitionRanges(parseWikiMarkdown({ path, text })));
      expect(result.ok ? null : `${path}: ${result.message}`).toBeNull();
    }
  });

  it("yields no entity for a file carrying no metadata", () => {
    for (const file of SCAFFOLD_FIXTURE.filesWithoutEntities) {
      const path = `${SCAFFOLD_FIXTURE.root}/${file}`;
      expect(parseWikiMarkdown({ path, text: read(path) }).entities).toEqual([]);
    }
  });
});

/** Kept exported so an orphaned expectation is a type error, not dead data. */
export type { FixtureExpectation };

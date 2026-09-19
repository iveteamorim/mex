/**
 * The run-scoped parse cache, and the guarantee it is not allowed to break.
 *
 * P5's `locate` re-reads and re-parses on purpose (handoff §51.1): the answer
 * has to be identical with a fresh index, a stale index and no index at all,
 * because a plan built from anything other than the current bytes is a plan
 * that writes over an edit nobody saw. A cache is the obvious way to lose that,
 * and the loss is silent.
 *
 * So the tests here are not "is it faster". They are the three ways a cache
 * lies — serving a tree for bytes that have since changed, serving one file's
 * tree for another file, and serving a tree parsed under a different registry —
 * plus one that asserts the cache is actually engaged, because every
 * correctness test below passes just as well with the cache switched off, and a
 * suite that only proves that is a suite that cannot see the cache at all.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyOperation } from "../apply.js";
import {
  WIKI_PARSE_CACHE_LIMITS,
  createParseCache,
  locateEntity,
  parseCached,
  readParsed,
} from "../locate.js";
import { createEntityTypeRegistry } from "../../model/entity.js";
import { makeScaffold, envelope, ARCH, GATEWAY, JWT, type Scaffold } from "./helpers.js";

let scaffold: Scaffold | null = null;

afterEach(() => {
  scaffold?.dispose();
  scaffold = null;
});

function fresh(): Scaffold {
  scaffold = makeScaffold();
  return scaffold;
}

describe("the run-scoped parse cache", () => {
  it("is engaged — a second read of unchanged bytes does not re-parse", () => {
    const s = fresh();
    const cache = createParseCache();
    const options = { scaffoldRoot: s.root, parseCache: cache };
    const absolute = join(s.root, "context/architecture.md");

    const first = readParsed(options, "context/architecture.md", absolute);
    expect(first).not.toBeNull();
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(0);

    const second = readParsed(options, "context/architecture.md", absolute);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
    // The same tree object, not merely an equal one: that is what "did not
    // re-parse" means, and an equality assertion would pass either way.
    expect(second?.parsed).toBe(first?.parsed);
    // And it is a real tree, not an empty one that would make every
    // downstream assertion in this file vacuous.
    expect(first?.parsed.entities.length).toBeGreaterThan(0);
  });

  it("re-parses when the bytes change under it, in the same run", () => {
    const s = fresh();
    const cache = createParseCache();
    const options = { scaffoldRoot: s.root, parseCache: cache };
    const absolute = join(s.root, "patterns/problem-documents.md");

    const before = readParsed(options, "patterns/problem-documents.md", absolute);
    expect(before?.parsed.entities).toHaveLength(1);

    // An edit from outside this process — the case a time-scoped cache gets
    // wrong, and the reason this one is keyed on content.
    s.write("patterns/problem-documents.md", `${before!.text}\nA sentence nobody planned.\n`);

    const after = readParsed(options, "patterns/problem-documents.md", absolute);
    expect(after?.parsed).not.toBe(before?.parsed);
    expect(after?.text).toContain("A sentence nobody planned.");
    expect(cache.misses).toBe(2);
  });

  it("does not serve one file's tree for another", () => {
    const s = fresh();
    const cache = createParseCache();
    const options = { scaffoldRoot: s.root, parseCache: cache };
    const same = "# Same bytes\n\nIdentical in both files.\n";
    s.write("a.md", same);
    s.write("b.md", same);

    const a = readParsed(options, "a.md", join(s.root, "a.md"));
    const b = readParsed(options, "b.md", join(s.root, "b.md"));
    expect(a?.parsed.path).toBe("a.md");
    expect(b?.parsed.path).toBe("b.md");
    expect(b?.parsed).not.toBe(a?.parsed);
  });

  it("does not serve a tree parsed under a different registry", () => {
    const s = fresh();
    const cache = createParseCache();
    const absolute = join(s.root, "context/architecture.md");
    const registry = createEntityTypeRegistry(["playbook"]);

    const plain = readParsed({ scaffoldRoot: s.root, parseCache: cache }, "context/architecture.md", absolute);
    const extended = readParsed(
      { scaffoldRoot: s.root, parseCache: cache, registry },
      "context/architecture.md",
      absolute,
    );
    expect(extended?.parsed).not.toBe(plain?.parsed);
    expect(cache.misses).toBe(2);
  });

  it("evicts old source and AST projections at a hard combined entry bound", () => {
    const s = fresh();
    const cache = createParseCache();
    const absolute = join(s.root, "bounded.md");
    for (let index = 0; index < WIKI_PARSE_CACHE_LIMITS.maxEntries + 4; index += 1) {
      parseCached(
        { scaffoldRoot: s.root, parseCache: cache },
        "bounded.md",
        absolute,
        `# Revision ${index}\n`,
      );
    }

    expect(cache.order).toHaveLength(WIKI_PARSE_CACHE_LIMITS.maxEntries);
    expect(cache.sourceBytes).toBeLessThanOrEqual(WIKI_PARSE_CACHE_LIMITS.maxSourceBytes);
    expect([...cache.entries.values()].reduce((total, values) => total + values.size, 0))
      .toBe(WIKI_PARSE_CACHE_LIMITS.maxEntries);
  });

  it("gives locate the same answer with a cache as without", () => {
    const s = fresh();
    const withCache = locateEntity(JWT, { scaffoldRoot: s.root, parseCache: createParseCache() });
    const without = locateEntity(JWT, { scaffoldRoot: s.root });
    expect(withCache?.path).toBe(without?.path);
    expect(withCache?.entityKey).toBe(without?.entityKey);
    expect(withCache?.entity.location.entityContentHash).toBe(without?.entity.location.entityContentHash);
    expect(without?.entity.location.entityContentHash).toBeTruthy();
  });

  it("lets a second operation in one run see the first's bytes", () => {
    const s = fresh();
    const cache = createParseCache();
    const options = { scaffoldRoot: s.root, parseCache: cache };

    const first = applyOperation(
      envelope(s, "set-property", { property: "status", value: "deprecated" }, { entityId: GATEWAY }),
      options,
    );
    expect(first.ok).toBe(true);

    // The precondition for the second operation is minted from the file *as it
    // is now*, so a cache that handed back the pre-write tree would make this
    // operation fail its own content-hash check rather than succeed quietly —
    // which is the point: the failure would be loud, and here there is none.
    const second = applyOperation(
      envelope(s, "set-property", { property: "status", value: "archived" }, { entityId: GATEWAY }),
      options,
    );
    expect(second.ok).toBe(true);

    const text = readFileSync(join(s.root, "context/architecture.md"), "utf-8");
    expect(text).toContain("status: archived");
    expect(text).not.toContain("status: deprecated");
    // Both writes really happened through the cached path.
    expect(cache.hits).toBeGreaterThan(0);
  });

  it("produces byte-identical results to an uncached run", () => {
    const cached = makeScaffold();
    const plain = makeScaffold();
    try {
      const sequence = (target: Scaffold, parseCache: ReturnType<typeof createParseCache> | undefined) => {
        const options = parseCache === undefined ? { scaffoldRoot: target.root } : { scaffoldRoot: target.root, parseCache };
        for (const [entityId, value] of [
          [GATEWAY, "deprecated"],
          [JWT, "archived"],
          [ARCH, "in_flight"],
        ] as const) {
          const result = applyOperation(
            envelope(target, "set-property", { property: "status", value }, { entityId, opId: `shared-${entityId}` }),
            options,
          );
          expect(result.ok).toBe(true);
        }
        return target.files();
      };

      const withCache = sequence(cached, createParseCache());
      const without = sequence(plain, undefined);
      expect(Object.keys(withCache)).toHaveLength(3);
      expect(withCache).toEqual(without);
    } finally {
      cached.dispose();
      plain.dispose();
    }
  });
});

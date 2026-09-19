/**
 * `wiki.exclude` and `wiki.readOnly` — D10's indexing scope, as config.
 *
 * These load on the path of *every* mex command, including the many that have
 * nothing to do with the wiki. So the interesting cases are not the happy ones:
 * they are the absent key and the hand-edited nonsense, both of which must cost
 * the user a wiki setting rather than the whole CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfig,
  findConfig,
  normalizeWikiConfig,
  DEFAULT_WIKI_EXCLUDE,
  DEFAULT_WIKI_READ_ONLY,
  DEFAULT_WIKI_SYNTHESIS,
} from "../src/config.js";

let root: string;

function scaffoldWith(persisted: string | null): string {
  const mex = join(root, ".mex");
  mkdirSync(mex, { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(mex, "ROUTER.md"), "# Router\n", "utf-8");
  if (persisted !== null) writeFileSync(join(mex, "config.json"), persisted, "utf-8");
  return root;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-wiki-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("wiki config", () => {
  it("applies D10's defaults when config.json has no wiki key", () => {
    const config = findConfig(scaffoldWith(JSON.stringify({ aiTools: ["claude"] })));
    expect(config.wiki?.exclude).toEqual([...DEFAULT_WIKI_EXCLUDE]);
    expect(config.wiki?.readOnly).toEqual([...DEFAULT_WIKI_READ_ONLY]);
    // The defaults are the real ones, not an empty list that would exclude and
    // reserve nothing while looking populated.
    expect(config.wiki?.exclude).toEqual(["**/node_modules/**"]);
    expect(config.wiki?.readOnly).toEqual([
      "team/**",
      "workstreams/**",
      "inbox/**",
      "relays/**",
      "playbooks/**",
      "events/activity/**",
    ]);
  });

  it("reads both lists when they are present", () => {
    const config = findConfig(
      scaffoldWith(JSON.stringify({ wiki: { exclude: ["drafts/**"], readOnly: ["imported/**"] } })),
    );
    expect(config.wiki?.exclude).toEqual(["drafts/**"]);
    expect(config.wiki?.readOnly).toEqual(["imported/**"]);
  });

  it("degrades to defaults for every malformed shape rather than throwing", () => {
    for (const wiki of ['"yes"', "42", "null", "[]", '{"exclude": "drafts/**"}', '{"exclude": [7, ""]}']) {
      const directory = mkdtempSync(join(tmpdir(), "mex-wiki-config-bad-"));
      try {
        const previous = root;
        root = directory;
        const config = findConfig(scaffoldWith(`{"wiki": ${wiki}}`));
        expect(config.wiki?.exclude, wiki).toEqual([...DEFAULT_WIKI_EXCLUDE]);
        expect(config.wiki?.readOnly, wiki).toEqual([...DEFAULT_WIKI_READ_ONLY]);
        root = previous;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("keeps a valid half when the other half is nonsense", () => {
    const config = findConfig(scaffoldWith(JSON.stringify({ wiki: { exclude: ["drafts/**"], readOnly: "team" } })));
    expect(config.wiki?.exclude).toEqual(["drafts/**"]);
    expect(config.wiki?.readOnly).toEqual([...DEFAULT_WIKI_READ_ONLY]);
  });

  it("leaves createConfig backward-compatible, and additive", () => {
    const minimal = createConfig({ projectRoot: root, scaffoldRoot: join(root, ".mex") });
    expect(minimal.projectRoot).toBe(root);
    expect(minimal.aiTools).toEqual([]);
    // Not required of the caller, but always present on the result, so no
    // consumer has to remember what the default was.
    expect(minimal.wiki).toEqual({
      exclude: [...DEFAULT_WIKI_EXCLUDE],
      readOnly: [...DEFAULT_WIKI_READ_ONLY],
      synthesis: { ...DEFAULT_WIKI_SYNTHESIS },
    });

    const explicit = createConfig({
      projectRoot: root,
      scaffoldRoot: join(root, ".mex"),
      wiki: { exclude: ["x/**"], readOnly: [] },
    });
    expect(explicit.wiki?.exclude).toEqual(["x/**"]);
    // An empty list is not a way to erase a default: D10 fixes the read-only
    // set deliberately, and P5 rejects writes to it.
    expect(explicit.wiki?.readOnly).toEqual([...DEFAULT_WIKI_READ_ONLY]);
  });

  it("normalizes a partial input without inventing entries", () => {
    expect(normalizeWikiConfig(undefined)).toEqual({
      exclude: [...DEFAULT_WIKI_EXCLUDE],
      readOnly: [...DEFAULT_WIKI_READ_ONLY],
      synthesis: { ...DEFAULT_WIKI_SYNTHESIS },
    });
    expect(normalizeWikiConfig({ exclude: ["a/**"] }).exclude).toEqual(["a/**"]);
  });

  it("degrades a malformed synthesis block to defaults, one field at a time", () => {
    // The same rule the two lists follow: config parsing runs on the path of
    // every mex command, so a hand-edited garbage value costs the user that
    // setting rather than the whole CLI.
    expect(normalizeWikiConfig({ synthesis: "yes" } as never).synthesis).toEqual({ ...DEFAULT_WIKI_SYNTHESIS });
    expect(normalizeWikiConfig({ synthesis: { minFiles: 0 } } as never).synthesis.minFiles).toBe(
      DEFAULT_WIKI_SYNTHESIS.minFiles,
    );
    expect(normalizeWikiConfig({ synthesis: { maxTokens: "lots" } } as never).synthesis.maxTokens).toBe(
      DEFAULT_WIKI_SYNTHESIS.maxTokens,
    );
    const partial = normalizeWikiConfig({ synthesis: { minFiles: 3 } } as never).synthesis;
    expect(partial.minFiles).toBe(3);
    expect(partial.maxTokens).toBe(DEFAULT_WIKI_SYNTHESIS.maxTokens);
  });

  it("has no knob that changes what synthesis accepts", () => {
    // The line the config draws, asserted rather than described: every field
    // here widens or narrows what mex *looks at*. The confidence gates and the
    // relationship thresholds are constants in `src/wiki/synthesis/`, because a
    // setting that lowers the bar for writing into a user's files has exactly
    // one use.
    expect(Object.keys(DEFAULT_WIKI_SYNTHESIS).sort()).toEqual([
      "maxCandidates",
      "maxFileLines",
      "maxGroups",
      "maxNodes",
      "maxPerUnit",
      "maxTokens",
      "minFiles",
      "primaryContextLines",
      "supportingMaxLines",
    ]);
    expect(JSON.stringify(DEFAULT_WIKI_SYNTHESIS)).not.toMatch(/confidence|threshold/i);
  });
});

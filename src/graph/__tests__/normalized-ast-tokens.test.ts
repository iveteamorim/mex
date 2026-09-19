import { beforeEach, describe, expect, it, vi } from "vitest";

const grammars = vi.hoisted(() => ({
  disposeTree: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("../extraction/grammars.js", () => ({
  detectLanguage: () => "python",
  disposeParsers: vi.fn(),
  disposeTree: grammars.disposeTree,
  grammarManifestHash: () => "grammar-hash",
  isSupportedSourceFile: () => true,
  loadGrammars: vi.fn(),
  parse: grammars.parse,
  supportedLanguages: () => ["python"],
  SUPPORTED_SOURCE_GLOB: "**/*.py",
}));

import { normalizedAstTokens } from "../extraction/index.js";

beforeEach(() => {
  grammars.disposeTree.mockReset();
  grammars.parse.mockReset();
});

describe("normalizedAstTokens native resources", () => {
  it("disposes its tree after producing normalized leaves", () => {
    const leaf = {
      type: "identifier",
      childCount: 0,
      children: [],
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 5 },
    };
    const tree = {
      rootNode: {
        type: "module",
        childCount: 1,
        children: [leaf],
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: 5 },
      },
    };
    grammars.parse.mockReturnValue(tree);

    expect(normalizedAstTokens("value.py", "value", [{ id: "node", startLine: 1, endLine: 1 }]))
      .toEqual(new Map([["node", ["identifier"]]]));
    expect(grammars.disposeTree).toHaveBeenCalledOnce();
    expect(grammars.disposeTree).toHaveBeenCalledWith(tree);
  });
});

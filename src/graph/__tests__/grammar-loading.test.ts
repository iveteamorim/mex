import { beforeEach, describe, expect, it, vi } from "vitest";

const wasm = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  load: vi.fn(async (path: string) => ({ path })),
}));

vi.mock("web-tree-sitter", () => ({
  Parser: { init: wasm.initialize },
  Language: { load: wasm.load },
}));
vi.mock("../assets.js", () => ({
  grammarWasmPath: (file: string) => `/grammar-assets/${file}`,
}));

beforeEach(() => {
  vi.resetModules();
  wasm.initialize.mockClear();
  wasm.load.mockClear();
});

describe("demand-driven grammar runtime initialization", () => {
  it("does not initialize WASM when compiler extraction leaves no grammar work", async () => {
    const { loadGrammars, initRuntime } = await import("../extraction/grammars.js");
    await loadGrammars([]);
    expect(wasm.initialize).not.toHaveBeenCalled();
    expect(wasm.load).not.toHaveBeenCalled();

    // Explicit callers of runtime initialization retain that contract.
    await initRuntime();
    expect(wasm.initialize).toHaveBeenCalledOnce();
  });

  it("does not initialize WASM for unsupported languages", async () => {
    const { loadGrammars } = await import("../extraction/grammars.js");
    await loadGrammars(["unknown"]);
    expect(wasm.initialize).not.toHaveBeenCalled();
    expect(wasm.load).not.toHaveBeenCalled();
  });

  it("initializes before supported and compiler-fallback grammars, then reuses them", async () => {
    const { loadGrammars } = await import("../extraction/grammars.js");
    await loadGrammars(["python", "typescript", "typescript", "rust"]);
    expect(wasm.initialize).toHaveBeenCalledOnce();
    expect(wasm.load.mock.calls).toEqual([
      ["/grammar-assets/tree-sitter-python.wasm"],
      ["/grammar-assets/tree-sitter-typescript.wasm"],
      ["/grammar-assets/tree-sitter-rust.wasm"],
    ]);
    expect(wasm.initialize.mock.invocationCallOrder[0]).toBeLessThan(wasm.load.mock.invocationCallOrder[0]!);

    await loadGrammars(["typescript", "python", "rust"]);
    expect(wasm.initialize).toHaveBeenCalledOnce();
    expect(wasm.load).toHaveBeenCalledTimes(3);
  });
});

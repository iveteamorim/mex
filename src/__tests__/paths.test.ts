import { describe, expect, it } from "vitest";
import { isSameResolvedPath, toPosix } from "../paths.js";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

describe("isSameResolvedPath", () => {
  it("accepts identical paths", () => {
    expect(isSameResolvedPath("/a/b/c.ts", "/a/b/c.ts")).toBe(true);
  });

  it("rejects different paths", () => {
    expect(isSameResolvedPath("/a/b/c.ts", "/a/b/d.ts")).toBe(false);
  });

  it("treats a case-only difference as the same name only where the volume does", () => {
    // A path that reached the graph through the TypeScript compiler host
    // arrives lowercased; on a case-insensitive volume it names the same file,
    // and comparing it as bytes once failed an entire repository's build.
    expect(isSameResolvedPath("C:\\Users\\a\\File.ts", "c:\\users\\a\\file.ts"))
      .toBe(caseInsensitive);
  });

  it("handles a missing side without throwing", () => {
    expect(isSameResolvedPath(null, null)).toBe(true);
    expect(isSameResolvedPath(null, "/a")).toBe(false);
    expect(isSameResolvedPath("/a", null)).toBe(false);
  });
});

describe("toPosix", () => {
  it("leaves forward-slash paths alone", () => {
    expect(toPosix("src/graph/status.ts")).toBe("src/graph/status.ts");
  });
});

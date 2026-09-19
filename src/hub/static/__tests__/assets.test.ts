import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HubAssetManifest, validateHubRequestPath } from "../assets.js";

describe("HubAssetManifest", () => {
  it("serves only manifest-declared files with fixed cache policy", () => {
    const root = fixture();
    const assets = new HubAssetManifest(root);
    expect(new TextDecoder().decode(assets.read("/index.html").bytes)).toContain("Project Hub");
    expect(assets.read("/index.html").cacheControl).toBe("no-store");
    expect(assets.read("/assets/app-abc12345.js").cacheControl).toContain("immutable");
    expect(() => assets.read("/assets/not-declared.js")).toThrowError(/does not exist/);
  });

  it("rejects raw, encoded, and double-encoded traversal", () => {
    for (const path of [
      "http://127.0.0.1:48123/../secret",
      "http://127.0.0.1:48123/%2e%2e%2fsecret",
      "http://127.0.0.1:48123/%252e%252e%252fsecret",
      "http://127.0.0.1:48123/assets%5csecret",
      "http://127.0.0.1:48123/%00",
    ]) {
      expect(() => validateHubRequestPath(path), path).toThrowError(/unsafe/);
    }
  });

  it("rejects symlinked declared assets", () => {
    const root = fixture();
    writeFileSync(join(root, "outside.js"), "secret");
    symlinkSync(join(root, "outside.js"), join(root, "assets", "link.js"));
    writeFileSync(join(root, ".vite", "manifest.json"), JSON.stringify({
      index: { file: "assets/link.js" },
    }));
    expect(() => new HubAssetManifest(root)).toThrowError(/symbolic link|regular file/);
  });

  it("rejects a symlink used as the asset root", () => {
    const root = fixture();
    const container = mkdtempSync(join(tmpdir(), "mex-hub-root-link-"));
    const link = join(container, "hub");
    symlinkSync(root, link);
    expect(() => new HubAssetManifest(link)).toThrowError(/must be a directory/);
  });

  it("refuses an asset whose bytes change after the manifest is bound", () => {
    const root = fixture();
    const assets = new HubAssetManifest(root);
    writeFileSync(join(root, "assets", "app-abc12345.js"), "changed!!\n");
    expect(() => assets.read("/assets/app-abc12345.js")).toThrowError(/no longer available/);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-assets-"));
  mkdirSync(join(root, ".vite"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Project Hub</title>");
  writeFileSync(join(root, "assets", "app-abc12345.js"), "export {};\n");
  writeFileSync(join(root, "assets", "not-declared.js"), "secret\n");
  writeFileSync(join(root, ".vite", "manifest.json"), JSON.stringify({
    index: { file: "assets/app-abc12345.js", isEntry: true },
  }));
  return root;
}

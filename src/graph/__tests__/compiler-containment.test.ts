import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTypeScriptExtraction } from "../extraction/compiler.js";
import { createGraphEngine } from "../engine-impl.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project nested one level down, so `..` is a real directory outside it. */
function nestedProject(): { workspace: string; root: string } {
  const workspace = mkdtempSync(join(tmpdir(), "mex-graph-containment-"));
  roots.push(workspace);
  const root = join(workspace, "package");
  mkdirSync(root, { recursive: true });
  return { workspace, root };
}

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, "utf8");
}

describe("compiler input containment declines rather than aborting", () => {
  it("finishes a build whose tsconfig extends a package hoisted above the root", async () => {
    const { workspace, root } = nestedProject();
    // The hoisted layout every pnpm/yarn workspace produces: the package the
    // config extends resolves above the indexed root.
    write(workspace, "node_modules/shared-config/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }));
    write(workspace, "node_modules/shared-config/package.json",
      JSON.stringify({ name: "shared-config", version: "1.0.0" }));
    write(root, "tsconfig.json", JSON.stringify({
      extends: "shared-config/tsconfig.json",
      compilerOptions: { target: "ES2022" },
    }));
    write(root, "package.json", JSON.stringify({ name: "package", version: "1.0.0" }));
    write(root, "src/service.ts", "export function containedPrimary(): number { return 1; }\n");
    const engine = createGraphEngine({ rootDir: root });

    try {
      const result = await engine.build();

      expect(result.filesIndexed).toBe(1);
      // The config was declined, not read — and reported by dependency
      // specifier rather than by absolute path.
      expect(result.declinedInputs).toContainEqual(expect.objectContaining({
        filePath: "node_modules/shared-config/tsconfig.json",
        reason: "outside-project-corpus",
      }));
      for (const input of result.declinedInputs ?? []) {
        expect(input.filePath.startsWith("node_modules/")).toBe(true);
      }
      expect(engine.searchNodes("containedPrimary").length).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  }, 60_000);

  it("declines an include and a project reference above the root without throwing", () => {
    const { workspace, root } = nestedProject();
    write(workspace, "sibling/tsconfig.json", JSON.stringify({ compilerOptions: {} }));
    write(workspace, "sibling/src/other.ts", "export const other = 1;\n");
    write(root, "tsconfig.json", JSON.stringify({
      compilerOptions: { composite: true },
      include: ["src/**/*", "../sibling/src/**/*"],
      references: [{ path: "../sibling" }],
    }));
    write(root, "src/service.ts", "export function referencedPrimary(): number { return 1; }\n");

    const result = buildTypeScriptExtraction(root, ["src/service.ts"], {
      stagedInputs: [
        { filePath: "tsconfig.json", source: JSON.stringify({
          compilerOptions: { composite: true },
          include: ["src/**/*", "../sibling/src/**/*"],
          references: [{ path: "../sibling" }],
        }) },
        { filePath: "src/service.ts",
          source: "export function referencedPrimary(): number { return 1; }\n" },
      ],
    });

    expect(result.files.map((file) => file.filePath)).toEqual(["src/service.ts"]);
    // The referenced project above the root is declined by path rather than
    // traversed. (The `..` include is not declined here: TypeScript invokes
    // readDirectory with the config's own directory and applies the include
    // patterns inside its matcher, so that guard is reached only when a config
    // names an out-of-root directory as the matcher root.)
    expect(result.declinedInputs.map((input) => input.filePath))
      .toEqual(["../sibling/tsconfig.json"]);
    expect(result.declinedInputs[0]?.reason).toBe("outside-project-corpus");
    // Nothing outside the root reached the graph's provenance.
    for (const input of result.semanticInputs) {
      expect(input.filePath.startsWith("..")).toBe(false);
    }
  });
});

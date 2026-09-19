import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** An independent characterization corpus; frozen release fixture sizes stay unchanged. */
export function createGraphCharacterizationFixture(root, { smoke = false } = {}) {
  if (existsSync(root)) throw new Error("Graph characterization requires a new fixture directory.");
  const projects = 4;
  const filesPerProject = smoke ? 2 : 40;
  const inferredFiles = smoke ? 2 : 20;
  const functionsPerFile = smoke ? 2 : 12;
  const largeBodyLines = smoke ? 128 : 4_096;
  const digest = createHash("sha256");
  let inputBytes = 0;
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    inputBytes += Buffer.byteLength(text);
    digest.update(path).update("\0").update(text).update("\0");
  };
  const json = (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`);
  json("package.json", { name: "mex-graph-characterization", private: true, type: "module" });
  const compilerOptions = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true };
  // Broad root intentionally overlaps the four specific ownership projects.
  json("tsconfig.json", { compilerOptions, include: ["packages/**/*.ts"] });
  write(".mex/ROUTER.md", "# Deterministic graph characterization fixture\n");
  write(".gitignore", ".mex/graph.db*\n.mex/local/\nnode_modules/\n");
  json("node_modules/@benchmark/model/package.json", { name: "@benchmark/model", version: "1.0.0", types: "index.d.ts" });
  write("node_modules/@benchmark/model/index.d.ts", [
    "export interface Model { value: number; key: string }",
    ...Array.from({ length: smoke ? 4 : 128 }, (_, index) => `export interface Model${index} extends Model { field${index}?: Model }`),
    "export declare function adapt<T extends Model>(value: T): T;",
    "",
  ].join("\n"));
  for (let project = 0; project < projects; project += 1) {
    json(`packages/p${project}/tsconfig.json`, { compilerOptions, include: ["*.ts"] });
    for (let file = 0; file < filesPerProject; file += 1) {
      const lines = ["import { adapt, type Model } from '@benchmark/model';"];
      if (file) lines.push(`import { work0 as previous } from './module-${file - 1}';`);
      else if (project) lines.push(`import { work0 as previous } from '../p${project - 1}/module-0';`);
      for (let fn = 0; fn < functionsPerFile; fn += 1) {
        lines.push(`export function work${fn}(input: Model): number {`);
        lines.push("  const model = adapt(input);");
        lines.push(`  let value = model.value + ${project + file + fn};`);
        if (fn === 0 && project === 0 && file === 0) {
          lines.push("  value += 101; // characterization-state:A");
          for (let line = 0; line < largeBodyLines; line += 1) lines.push(`  value = (value + ${line}) % 100003;`);
        }
        if (file || project) lines.push("  value += previous(model);");
        lines.push("  return value;", "}");
      }
      write(`packages/p${project}/module-${file}.ts`, `${lines.join("\n")}\n`);
    }
  }
  for (let file = 0; file < inferredFiles; file += 1) {
    write(`scripts/entry-${file}.js`, `import { work0 } from '../packages/p0/module-0';\nexport function run${file}(value) { return work0({ value, key: 'fixture' }); }\n`);
  }
  return {
    root,
    mutableSource: "packages/p0/module-0.ts",
    digest: digest.digest("hex"),
    inputBytes,
    sourceFiles: projects * filesPerProject + inferredFiles,
    projects,
    configFiles: projects + 1,
    functionsPerFile,
    inferredFiles,
    dependencyDeclarations: smoke ? 4 : 128,
    largeBodyLines,
  };
}

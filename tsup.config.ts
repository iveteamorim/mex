import { defineConfig } from "tsup";

/**
 * Two-config build:
 *  - cli + private graph candidate → executable bundles, no public declarations
 *  - index → dist/index.js + dist/index.d.ts (library entry consumed via `exports`)
 */
export default defineConfig([
  {
    entry: { cli: "src/cli.ts", "graph-candidate": "src/graph/candidate-entry.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: true,
    // Split so modules reached only through dynamic import() — the Ink TUI,
    // React, the TypeScript compiler — stay in their own chunks. With one
    // bundle, esbuild hoists every external import to the top of cli.js and
    // each command, even --version, paid to load them.
    splitting: true,
    sourcemap: true,
    dts: false,
    // Hub contracts are a private workspace package and are intentionally
    // bundled into the published CLI instead of becoming a runtime dependency.
    noExternal: ["@mex/hub-contracts"],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    // clean: false here — the CLI build above already cleans dist on each run,
    // and we don't want the library build to wipe the CLI artifacts.
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: true,
  },
]);

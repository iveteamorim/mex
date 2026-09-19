// Vitest intentionally sets NODE_ENV=test. Some root tests invoke the package
// build in a child process, so set the production condition before Vite or any
// React dependency is loaded. This keeps the output byte-for-byte independent
// of the caller's ambient test environment.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_ENV = "production";

const { build } = await import("vite");
await build({
  configFile: join(packageRoot, "vite.config.ts"),
  mode: "production",
  root: packageRoot,
});

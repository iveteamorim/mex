#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("missing graph command configuration\n");
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!Array.isArray(config.command) || !config.command.length || typeof config.subjectRoot !== "string") {
  process.stderr.write("invalid graph command configuration\n");
  process.exit(2);
}
const result = spawnSync(config.command[0], [...config.command.slice(1), ...process.argv.slice(3)], {
  cwd: config.subjectRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);

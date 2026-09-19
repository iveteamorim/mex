import { spawn, spawnSync } from "node:child_process";
import { runProcess } from "../../core/process.mjs";

export function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === null ? null : "utf8",
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? (options.encoding === null ? Buffer.alloc(0) : ""), stderr: result.stderr ?? (options.encoding === null ? Buffer.alloc(0) : ""), error: result.error };
}

export function runTimed(command, args, options = {}) {
  return runProcess(command, args, options);
}

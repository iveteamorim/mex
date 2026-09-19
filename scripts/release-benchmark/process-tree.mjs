import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const MAX_PROCESSES = 16_384;
const MAX_TREE_PROCESSES = 256;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAMPLE_TIMEOUT_MS = 5_000;

export const PROCESS_MEASUREMENT = Object.freeze({
  scope: "hub-and-descendants",
  rss: "sum-of-resident-sets-in-one-sample",
  cpu: "observed-process-lifetime-deltas",
  intervalMs: process.platform === "linux" ? 10 : 100,
  limitation: "Shared pages may be counted twice; short-lived children and final CPU between samples may be missed.",
});

/** Retain CPU already observed in exited children; PID reuse starts a new identity. */
export function createProcessTreeAccumulator(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error("Process tree root must be a positive PID.");
  const observed = new Map();
  let rootStarted;
  let initialized = false;
  let peakRssBytes = 0;
  let cpuMs = 0;
  let maxProcesses = 0;
  let sampleCount = 0;
  return {
    add(rows) {
      if (!Array.isArray(rows) || rows.length > MAX_PROCESSES) throw new Error("Process snapshot exceeded its row bound.");
      const byPid = new Map();
      const children = new Map();
      for (const row of rows) {
        if (!Number.isInteger(row.pid) || row.pid <= 0 || !Number.isInteger(row.ppid) || row.ppid < 0
          || typeof row.started !== "string" || !row.started || row.started.length > 100
          || !Number.isFinite(row.rssBytes) || row.rssBytes < 0
          || !Number.isFinite(row.cpuMs) || row.cpuMs < 0 || byPid.has(row.pid)) {
          throw new Error("Invalid process snapshot row.");
        }
        byPid.set(row.pid, row);
        const list = children.get(row.ppid) ?? [];
        list.push(row.pid);
        children.set(row.ppid, list);
      }
      if (!byPid.has(rootPid)) throw new Error("Benchmark root process disappeared while sampling.");
      const currentRootStarted = byPid.get(rootPid).started;
      if (rootStarted !== undefined && rootStarted !== currentRootStarted) throw new Error("Benchmark root PID was reused while sampling.");
      rootStarted = currentRootStarted;
      const selected = new Set();
      const pending = [rootPid];
      // A previously identified child can remain alive briefly after reparenting.
      for (const row of rows) if (observed.has(`${row.pid}:${row.started}`)) pending.push(row.pid);
      while (pending.length) {
        const pid = pending.pop();
        if (selected.has(pid)) continue;
        selected.add(pid);
        if (selected.size > MAX_TREE_PROCESSES) throw new Error("Benchmark process tree exceeded 256 processes.");
        pending.push(...(children.get(pid) ?? []));
      }
      let rssBytes = 0;
      for (const pid of selected) {
        const row = byPid.get(pid);
        const identity = `${pid}:${row.started}`;
        const previous = observed.get(identity);
        cpuMs += previous === undefined ? (initialized ? row.cpuMs : 0) : Math.max(0, row.cpuMs - previous);
        observed.set(identity, Math.max(previous ?? 0, row.cpuMs));
        rssBytes += row.rssBytes;
      }
      if (observed.size > MAX_PROCESSES) throw new Error("Benchmark lifetime process count exceeded its bound.");
      initialized = true;
      sampleCount += 1;
      peakRssBytes = Math.max(peakRssBytes, rssBytes);
      maxProcesses = Math.max(maxProcesses, selected.size);
      return { rssBytes, peakRssBytes, cpuMs, maxProcesses, sampleCount };
    },
  };
}

export async function startProcessTreeSampler(rootPid, { source, intervalMs = PROCESS_MEASUREMENT.intervalMs } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 1_000) throw new Error("Invalid process sample interval.");
  const backend = source ?? createProcessSource(rootPid);
  const accumulator = createProcessTreeAccumulator(rootPid);
  let latest;
  let failure;
  let pending;
  let stopped = false;
  const sample = () => {
    if (failure) return Promise.reject(failure);
    if (pending) return pending;
    pending = Promise.resolve().then(() => backend.read()).then((rows) => {
      latest = accumulator.add(rows);
      return latest;
    }).catch((error) => { failure = error; throw error; }).finally(() => { pending = undefined; });
    return pending;
  };
  try { await sample(); } catch (error) { await backend.close?.(); throw error; }
  const timer = setInterval(() => { void sample().catch(() => undefined); }, intervalMs);
  return {
    sample,
    async stop() {
      if (stopped) { if (failure) throw failure; return latest; }
      stopped = true;
      clearInterval(timer);
      try { return await sample(); } finally { await backend.close?.(); }
    },
  };
}

function createProcessSource(rootPid) {
  if (process.platform === "linux") return { read: () => readLinuxTree(rootPid) };
  if (process.platform === "darwin") return {
    read: async () => parsePsSnapshot(await commandOutput("ps", ["-axo", "pid=,ppid=,lstart=,time=,rss="])),
  };
  if (process.platform === "win32") return windowsSource();
  throw new Error(`Process-tree measurement is unsupported on ${process.platform}.`);
}

let linuxUnits;
function readLinuxTree(rootPid) {
  linuxUnits ??= {
    ticks: getconf("CLK_TCK"),
    pageBytes: getconf("PAGESIZE"),
  };
  const pending = [rootPid];
  const visited = new Set();
  const rows = [];
  while (pending.length) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    if (visited.size > MAX_TREE_PROCESSES) throw new Error("Benchmark process tree exceeded 256 processes.");
    try {
      rows.push(parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"), linuxUnits));
      const threads = readdirSync(`/proc/${pid}/task`);
      if (threads.length > 512) throw new Error("Benchmark process exceeded 512 threads.");
      for (const tid of threads) {
        try {
          const children = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
          if (children) pending.push(...children.split(/\s+/u).map(Number));
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
      }
    } catch (error) {
      if (pid === rootPid || (error.code !== "ENOENT" && error.code !== "ESRCH")) throw error;
    }
  }
  return rows;
}

export function parseLinuxStat(text, { ticks, pageBytes }) {
  const pid = Number(text.slice(0, text.indexOf(" ")));
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/u);
  return {
    pid, ppid: Number(fields[1]), started: fields[19],
    cpuMs: (Number(fields[11]) + Number(fields[12])) * 1_000 / ticks,
    rssBytes: Number(fields[21]) * pageBytes,
  };
}

export function parsePsSnapshot(text) {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 9) throw new Error("Unexpected ps process sample format.");
    return {
      pid: Number(fields[0]), ppid: Number(fields[1]), started: fields.slice(2, 7).join(" "),
      cpuMs: parsePsCpuTime(fields[7]), rssBytes: Number(fields[8]) * 1024,
    };
  });
}

function parsePsCpuTime(value) {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u);
  if (!match) throw new Error("Could not parse process CPU time.");
  return (((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3])) * 60 + Number(match[4])) * 1_000;
}

function getconf(name) {
  const result = spawnSync("getconf", [name], { encoding: "utf8", timeout: SAMPLE_TIMEOUT_MS, maxBuffer: 1024 });
  const value = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isFinite(value) || value <= 0) throw new Error(`Cannot determine ${name} for process measurement.`);
  return value;
}

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" }, windowsHide: true });
    let output = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output = "";
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Process sampling command timed out.")), SAMPLE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) fail(new Error("Process snapshot exceeded its byte bound."));
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) fail(new Error("Process sampling command failed."));
      else { settled = true; resolve(output); }
    });
  });
}

/** Keep PowerShell alive: starting it for every sample would dominate the measurement. */
function windowsSource() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "while ($true) {",
    "$rows = @(Get-CimInstance Win32_Process | ForEach-Object { if ($_.ProcessId -gt 0 -and $null -ne $_.CreationDate) {",
    "[PSCustomObject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');rssBytes=[double]$_.WorkingSetSize;cpuMs=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000}",
    "}})",
    "[Console]::WriteLine((ConvertTo-Json -InputObject $rows -Compress))",
    "Start-Sleep -Milliseconds 100",
    "}",
  ].join("\n");
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  let buffer = "";
  let frame;
  let failure;
  let waiter;
  const fail = (error) => { failure ??= error; buffer = ""; frame = undefined; waiter?.reject(failure); waiter = undefined; };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Windows process sampler exited.")));
  child.stdout.on("data", (chunk) => {
    if (failure) return;
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_OUTPUT_BYTES) { fail(new Error("Windows process snapshot exceeded its byte bound.")); child.kill(); return; }
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      try {
        frame = JSON.parse(line);
        if (!Array.isArray(frame) || frame.length > MAX_PROCESSES) throw new Error("Invalid Windows process snapshot.");
        if (waiter) { waiter.resolve(frame); waiter = undefined; frame = undefined; }
      } catch (error) { fail(error); child.kill(); return; }
    }
  });
  return {
    async read() {
      if (failure) throw failure;
      if (frame) { const value = frame; frame = undefined; return value; }
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          waiter = { resolve, reject };
          timer = setTimeout(() => { fail(new Error("Windows process sampler timed out.")); child.kill(); }, SAMPLE_TIMEOUT_MS);
        });
      } finally { clearTimeout(timer); }
    },
    close() { child.kill(); },
  };
}

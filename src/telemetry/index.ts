/** Pseudonymous, opt-out usage analytics. No content, names or raw arguments. */
import { getMachineId, readMachineId, readGlobalConfig, readTelemetryPreference, setGlobalConfigKey, isDevRepo, mexHomeDir } from "../global-config.js";
import { claimBatch, closeOutbox, enqueue, finishBatch, inspectOutbox, OUTBOX_LIMITS, purgeOutbox } from "./outbox.js";
import { eventAttributes, makeEvent, previewEvent, TELEMETRY_ACTIONS, TELEMETRY_COMMANDS, TELEMETRY_EVENTS,
  TELEMETRY_JOB_KINDS, TELEMETRY_PAGES, TELEMETRY_AI_TOOLS, type TelemetryAttributes,
  type TelemetryEventName, type TelemetryProjectContext } from "./schema.js";
import { readTelemetryProjectContext } from "./project-context.js";
import { sendBatch, setEndpointForTest, TELEMETRY_ENDPOINT, type BatchRequest } from "./transport.js";
export type { TelemetryAttributes, TelemetryEventName, TelemetryEvent } from "./schema.js";
export { TELEMETRY_ACTIONS, TELEMETRY_COMMANDS, TELEMETRY_EVENTS, TELEMETRY_JOB_KINDS, TELEMETRY_PAGES } from "./schema.js";

export const TELEMETRY_FLUSH_GRACE_MS = 25;
export const HUB_TELEMETRY_INTERVAL_MS = 15_000;
export interface EnabledResult { enabled: boolean; reason?: string; }
export function isEnabled(): EnabledResult {
  if (process.env.DO_NOT_TRACK === "1") return { enabled: false, reason: "DO_NOT_TRACK" };
  if (process.env.MEX_TELEMETRY === "0") return { enabled: false, reason: "MEX_TELEMETRY" };
  if (isDevRepo()) return { enabled: false, reason: "dev" };
  const preference = readTelemetryPreference();
  if (preference === "off") return { enabled: false, reason: "config" };
  if (preference === "unavailable") return { enabled: false, reason: "config_unavailable" };
  return { enabled: true };
}

type TransportFn = (event: string, properties: Record<string, unknown>) => void;
let customTransport: TransportFn | null = null;
let active: BatchRequest | undefined;
let activeDone: Promise<void> | undefined;
let scheduled: ReturnType<typeof setImmediate> | undefined;
let cliBatchAttempted = false;
let stateHome: string | undefined;
let hubUsers = 0;
let hubTimer: ReturnType<typeof setInterval> | undefined;

function abortActive(): void { active?.abort(); }
function checkEnabled(): boolean {
  if (isEnabled().enabled) return true;
  abortActive();
  return false;
}
function synchronizeHome(): void {
  const home = mexHomeDir();
  if (stateHome !== home) {
    abortActive();
    closeOutbox();
    cliBatchAttempted = false;
    stateHome = home;
  }
}

/** Projected and validated before identity, disk, or network work. */
export function captureEvent(name: TelemetryEventName, attributes: TelemetryAttributes = {}): void {
  try {
    if (!eventAttributes(name, attributes) || !checkEnabled()) return;
    synchronizeHome();
    const event = makeEvent(name, attributes, getMachineId());
    if (!event) return;
    if (customTransport) { customTransport(event.event, event.properties); return; }
    // Recheck immediately before enqueue, then again at the actual send boundary.
    if (!checkEnabled() || !enqueue(event)) return;
    if (!hubUsers && !cliBatchAttempted && !scheduled) {
      scheduled = setImmediate(() => { scheduled = undefined; dispatch(); });
      scheduled.unref();
    }
  } catch { /* Analytics never changes command results or writes to stdout/stderr. */ }
}

/** Opt-outs never trigger project discovery for ordinary telemetry captures. */
export function getProjectTelemetryContext(startDir: string, discovery: "git-root" | "exact" = "git-root"): TelemetryProjectContext {
  try { return checkEnabled() ? readTelemetryProjectContext(startDir, discovery) : {}; }
  catch { return {}; }
}

/** Each Hub binds one lazy context snapshot to its own project, not process cwd. */
export function createProjectTelemetryCapture(startDir: string): typeof captureEvent {
  let context: TelemetryProjectContext | undefined;
  return (name, attributes = {}) => {
    try {
      if (!eventAttributes(name, attributes) || !checkEnabled()) return;
      context ??= readTelemetryProjectContext(startDir, "exact");
      captureEvent(name, { ...attributes, ...context });
    } catch { /* Metadata must never change the result of a Hub operation. */ }
  };
}

function dispatch(): void {
  try {
    if (active || customTransport || !checkEnabled()) return;
    synchronizeHome();
    if (!hubUsers && cliBatchAttempted) return;
    const batch = claimBatch();
    if (!batch) return;
    if (!checkEnabled()) { finishBatch(batch, false); return; }
    cliBatchAttempted = true;
    const request = sendBatch(batch.events);
    active = request;
    activeDone = request.done.then((delivered) => {
      finishBatch(batch, delivered);
    }).catch(() => undefined).finally(() => {
      if (active === request) { active = undefined; activeDone = undefined; }
    });
  } catch { /* Busy/malformed stores or failed sends simply drop/defer telemetry. */ }
}

/** Relative grace, capped at 50ms. Abort cancels socket AND DNS work at its end. */
export async function flush(options: { deadlineMs?: number } = {}): Promise<void> {
  const value = options.deadlineMs;
  const grace = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(50, value)) : TELEMETRY_FLUSH_GRACE_MS;
  const deadline = performance.now() + grace;
  try {
    if (scheduled) { clearImmediate(scheduled); scheduled = undefined; }
    if (!checkEnabled()) return;
    dispatch();
    if (activeDone) await settleByDeadline(activeDone, deadline);
  } catch { /* best effort */ }
  finally {
    abortActive();
    // Abort settles the request immediately; finish local acknowledgement cleanup
    // without opening another request or extending the network deadline.
    await Promise.resolve();
    if (!hubUsers) closeOutbox();
  }
}

async function settleByDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
  const safe = work.then(() => undefined, () => undefined);
  const remaining = deadline - performance.now();
  if (remaining <= 0) { void safe; return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([safe, new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** A long-running Hub amortizes sending. Idle sessions do not manufacture events. */
export function startHubTelemetry(): () => Promise<void> {
  hubUsers++;
  if (!hubTimer) {
    hubTimer = setInterval(() => { dispatch(); }, HUB_TELEMETRY_INTERVAL_MS);
    hubTimer.unref();
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    if (--hubUsers === 0) {
      if (hubTimer) clearInterval(hubTimer);
      hubTimer = undefined;
      // A final Hub batch is permitted even if an earlier batch was delivered.
      cliBatchAttempted = false;
      await flush();
    }
  };
}

/** Called by explicit disable/config-off actions, not by ordinary opt-out reads. */
export function disableTelemetry(): { purged: boolean } {
  abortActive();
  if (scheduled) { clearImmediate(scheduled); scheduled = undefined; }
  // Preference errors reach the explicit config command; never silently report
  // that a failed opt-out worked. Sending has already been aborted.
  setGlobalConfigKey("telemetry", "off");
  return { purged: purgeOutbox() };
}

/** No captures, identity creation, database repair, configuration writes, or sends. */
export function getTelemetryInspection(): Record<string, unknown> {
  const id = readMachineId();
  const context = readTelemetryProjectContext(process.cwd());
  return {
    schema_version: 2, ...isEnabled(), endpoint: TELEMETRY_ENDPOINT,
    installation_id: id ?? null, project_context: context, queue: inspectOutbox(), limits: OUTBOX_LIMITS,
    catalog: { events: TELEMETRY_EVENTS, commands: TELEMETRY_COMMANDS, pages: TELEMETRY_PAGES,
      actions: TELEMETRY_ACTIONS, job_kinds: TELEMETRY_JOB_KINDS, configured_ai_tools: TELEMETRY_AI_TOOLS },
    batch_example: { api_key: "<public MEX project token>", batch: [
      previewEvent("cli.command_started", { ...context, command: "wiki.query", stage: "direct" }, id),
      previewEvent("cli.command_completed", { ...context, command: "wiki.query", stage: "direct", outcome: "success", duration_ms: 12 }, id),
      previewEvent("hub.page_viewed", { ...context, page: "knowledge" }, id),
    ] },
  };
}

/** Compatibility for old hooks; context comes from the bounded config reader. */
export function captureCommand(command: string, _scaffoldId?: string): void {
  captureEvent("cli.command_started", { command: command.replaceAll(" ", ".") });
}
export function capture(_event: string, command: string, _scaffoldId?: string): void { captureCommand(command); }
export function buildPayload(command: string, _scaffoldId?: string): Record<string, unknown> {
  return previewEvent("cli.command_started", { command: command.replaceAll(" ", ".") }).properties as Record<string, unknown>;
}
export function getPayloadPreview(command: string, _scaffoldId?: string, machineId?: string): Record<string, unknown> {
  return previewEvent("cli.command_started", { command: TELEMETRY_COMMANDS.includes(command as typeof TELEMETRY_COMMANDS[number]) ? command : "wiki.query" }, machineId).properties as Record<string, unknown>;
}

export function showFirstRunNotice(): boolean {
  try {
    if (!isEnabled().enabled || readGlobalConfig().firstRunNoticeShown || !process.stderr.isTTY) return false;
    process.stderr.write("\n  MEX collects pseudonymous feature usage and outcomes using a random\n"
      + "  installation ID shared by this CLI and local Hub. Events may include\n"
      + "  an existing random scaffold UUID and configured AI-tool names. No\n"
      + "  content, paths, queries, member identities or contact details. Events are\n"
      + "  queued locally; entries older than 7 days are dropped on next use.\n"
      + "  Inspect: mex telemetry inspect\n"
      + "  Opt out: mex telemetry disable, DO_NOT_TRACK=1 or MEX_TELEMETRY=0.\n\n");
    setGlobalConfigKey("firstRunNoticeShown", true);
    return true;
  } catch { return false; }
}

/** Offline seams are internal, never configurable by product input. */
export function __setTransport(next: TransportFn | null): void { customTransport = next; }
export function __setTelemetryEndpointForTest(endpoint: string | null): void { setEndpointForTest(endpoint); }
export function __resetTelemetryForTest(): void {
  abortActive(); active = undefined; activeDone = undefined;
  if (scheduled) clearImmediate(scheduled);
  if (hubTimer) clearInterval(hubTimer);
  scheduled = undefined; hubTimer = undefined; hubUsers = 0; cliBatchAttempted = false; stateHome = undefined;
  customTransport = null; closeOutbox(); setEndpointForTest(null);
}

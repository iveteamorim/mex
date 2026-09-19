import { isRevision, type Revision } from "../team/contracts/shared.js";
import { artifactError } from "../team/artifacts/errors.js";
import {
  assertContainedArtifactDirectory,
  atomicCreateArtifact,
  atomicReplaceArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../team/artifacts/filesystem.js";
import { RepositoryRootGuard } from "../team/workflow/repository-root.js";

export const AGENT_LOGGING_MODES = ["significant", "checkpoints", "manual"] as const;
export type AgentLoggingMode = (typeof AGENT_LOGGING_MODES)[number];

export interface AgentLoggingPolicy {
  mode: AgentLoggingMode;
  revision: Revision | null;
  source: "default" | "local";
}

export interface SetAgentLoggingPolicyRequest {
  mode: AgentLoggingMode;
  expectedRevision: Revision | null;
}

const PATH = ".mex/local/agent-preferences.json";
const MAX_BYTES = 1024;

/** Advisory checkout preference only; never initializes state or modifies logs. */
export function readAgentLoggingPolicy(projectRoot: string): AgentLoggingPolicy {
  const root = new RepositoryRootGuard(projectRoot);
  return readPolicy(root);
}

/** Write only the reviewed checkout preference, protected against lost updates. */
export async function setAgentLoggingPolicy(
  projectRoot: string,
  request: SetAgentLoggingPolicyRequest,
): Promise<AgentLoggingPolicy> {
  if (request === null || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).length !== 2
    || !Object.hasOwn(request, "mode") || !Object.hasOwn(request, "expectedRevision")
    || !isAgentLoggingMode(request.mode)
    || (request.expectedRevision !== null && !isRevision(request.expectedRevision))) {
    throw artifactError("INVALID_REQUEST", "Invalid logging preference", "Choose significant, checkpoints, or manual and provide the exact current revision, or null when no preference exists.");
  }
  // Snapshot caller-owned values before entering the asynchronous lock boundary.
  const { mode, expectedRevision } = request;
  const root = new RepositoryRootGuard(projectRoot);
  assertScaffold(root);
  return withContainedArtifactLock(root.path, ".mex/local", ".agent-preferences.mex-lock", () => {
    const current = readPolicy(root);
    if (current.revision !== expectedRevision) {
      throw artifactError("REVISION_CONFLICT", "Logging preference changed", "Read the current logging preference and retry with its exact revision.");
    }
    if (current.source === "local" && current.mode === mode) return current;
    const document = `${JSON.stringify({ schemaVersion: 1, mode })}\n`;
    assertScaffold(root);
    const revision = current.revision === null
      ? atomicCreateArtifact(root.path, PATH, document)
      : atomicReplaceArtifact(root.path, PATH, current.revision, document, MAX_BYTES, "exact");
    root.assertCurrent();
    return { mode, revision, source: "local" as const };
  });
}

export function isAgentLoggingMode(value: unknown): value is AgentLoggingMode {
  return typeof value === "string" && (AGENT_LOGGING_MODES as readonly string[]).includes(value);
}

function readPolicy(root: RepositoryRootGuard): AgentLoggingPolicy {
  assertScaffold(root);
  const stored = tryReadContainedArtifact(root.path, PATH, MAX_BYTES, "exact");
  if (stored === null) {
    root.assertCurrent();
    return { mode: "significant", revision: null, source: "default" };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes));
  } catch { throw invalidStoredPolicy(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "schemaVersion") || !Object.hasOwn(value, "mode")) throw invalidStoredPolicy();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !isAgentLoggingMode(record.mode)) throw invalidStoredPolicy();
  root.assertCurrent();
  return { mode: record.mode, revision: stored.revision, source: "local" };
}

function assertScaffold(root: RepositoryRootGuard): void {
  root.assertCurrent();
  if (assertContainedArtifactDirectory(root.path, ".mex") === null) {
    throw artifactError("NOT_FOUND", "MEX scaffold unavailable", "Run the logging command from an existing MEX project.");
  }
}

function invalidStoredPolicy() {
  return artifactError("VALIDATION_FAILED", "Invalid stored logging preference", "The checkout logging preference is malformed or unsupported. Inspect .mex/local/agent-preferences.json before changing it.");
}

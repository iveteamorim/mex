import type {
  Diagnostic,
  MexErrorCode,
  ProblemDetails,
} from "../contracts/shared.js";
import { MexPortError } from "../contracts/shared.js";

export const TEAM_CLI_SCHEMA_VERSION = 1 as const;

/** Stable process statuses for every Team command. */
export const TEAM_CLI_EXIT = {
  ok: 0,
  validation: 1,
  usage: 2,
  unavailable: 3,
  conflict: 4,
  refused: 5,
} as const;

export type TeamCliExitCode =
  (typeof TEAM_CLI_EXIT)[keyof typeof TEAM_CLI_EXIT];

export type TeamCliMode = "read" | "preview" | "apply";

export type TeamCliCommandName =
  | "member"
  | "member.list"
  | "member.show"
  | "member.current"
  | "member.add"
  | "member.update"
  | "member.deactivate"
  | "member.reactivate"
  | "member.select"
  | "activity"
  | "activity.list"
  | "activity.show"
  | "activity.record"
  | "workstream"
  | "workstream.list"
  | "workstream.show"
  | "workstream.create"
  | "workstream.update"
  | "workstream.archive"
  | "inbox"
  | "inbox.contract"
  | "inbox.target"
  | "inbox.draft"
  | "inbox.draft.list"
  | "inbox.draft.show"
  | "inbox.draft.save"
  | "inbox.draft.delete"
  | "inbox.proposal"
  | "inbox.proposal.list"
  | "inbox.proposal.show"
  | "inbox.proposal.approve"
  | "inbox.proposal.reject"
  | "inbox.proposal.withdraw"
  | "inbox.proposal.mark-stale"
  | "inbox.proposal.repair"
  | "inbox.publish"
  | "relay"
  | "relay.contract"
  | "relay.draft"
  | "relay.draft.list"
  | "relay.draft.show"
  | "relay.draft.save"
  | "relay.draft.delete"
  | "relay.list"
  | "relay.show"
  | "relay.publish"
  | "relay.acknowledge"
  | "relay.close"
  | "spec"
  | "spec.list"
  | "spec.show";

/**
 * One bounded machine envelope for Team reads, previews, and applies.
 *
 * Preview output is deliberately this complete envelope. The corresponding
 * apply command consumes that exact file and extracts the service-issued
 * preview from `data`; callers never rebuild a prepared command themselves.
 */
export interface TeamCliEnvelope<T> {
  schemaVersion: 1;
  command: TeamCliCommandName;
  mode: TeamCliMode;
  ok: boolean;
  data: T | null;
  diagnostics: readonly Diagnostic[];
  problem: ProblemDetails | null;
}

const EXIT_BY_CODE: Readonly<Record<MexErrorCode, TeamCliExitCode>> = {
  VALIDATION_FAILED: TEAM_CLI_EXIT.validation,
  JOB_FAILED: TEAM_CLI_EXIT.validation,
  INTERNAL_ERROR: TEAM_CLI_EXIT.validation,
  INVALID_REQUEST: TEAM_CLI_EXIT.usage,
  NOT_FOUND: TEAM_CLI_EXIT.unavailable,
  INDEX_MISSING: TEAM_CLI_EXIT.unavailable,
  INDEX_STALE: TEAM_CLI_EXIT.unavailable,
  INDEX_CORRUPT: TEAM_CLI_EXIT.unavailable,
  MIGRATION_REQUIRED: TEAM_CLI_EXIT.unavailable,
  REVISION_CONFLICT: TEAM_CLI_EXIT.conflict,
  JOB_ALREADY_RUNNING: TEAM_CLI_EXIT.conflict,
  OPERATION_INTERRUPTED: TEAM_CLI_EXIT.conflict,
  PATH_OUTSIDE_PROJECT: TEAM_CLI_EXIT.refused,
  UNAUTHORIZED: TEAM_CLI_EXIT.refused,
  ORIGIN_REJECTED: TEAM_CLI_EXIT.refused,
} as const;

export class TeamCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamCliUsageError";
  }
}

export function teamEnvelope<T>(options: {
  command: TeamCliCommandName;
  mode: TeamCliMode;
  data: T;
  diagnostics?: readonly Diagnostic[];
  valid?: boolean;
}): TeamCliEnvelope<T> {
  const diagnostics = sortDiagnostics(options.diagnostics ?? []);
  return {
    schemaVersion: TEAM_CLI_SCHEMA_VERSION,
    command: options.command,
    mode: options.mode,
    ok: options.valid !== false
      && !diagnostics.some((entry) => entry.severity === "error"),
    data: options.data,
    diagnostics,
    problem: null,
  };
}

export function teamProblemEnvelope(
  command: TeamCliCommandName,
  mode: TeamCliMode,
  error: unknown,
): TeamCliEnvelope<never> {
  const problem = safeProblem(error);
  return {
    schemaVersion: TEAM_CLI_SCHEMA_VERSION,
    command,
    mode,
    ok: false,
    data: null,
    diagnostics: sortDiagnostics(problem.diagnostics ?? []),
    problem,
  };
}

export function exitCodeForTeamEnvelope<T>(
  envelope: TeamCliEnvelope<T>,
): TeamCliExitCode {
  if (envelope.ok) return TEAM_CLI_EXIT.ok;
  if (envelope.problem !== null) {
    return EXIT_BY_CODE[envelope.problem.code];
  }
  return TEAM_CLI_EXIT.validation;
}

/** Canonical key ordering keeps output stable even when service objects differ. */
export function renderTeamEnvelope<T>(envelope: TeamCliEnvelope<T>): string {
  return JSON.stringify(sortJson(envelope));
}

export function invalidRequestProblem(detail: string): ProblemDetails {
  return {
    title: "Invalid Team command request",
    status: 400,
    code: "INVALID_REQUEST",
    detail,
  };
}

export function notFoundProblem(
  label: "member" | "activity" | "workstream" | "spec",
  id: string,
): ProblemDetails {
  const display = label === "activity"
    ? "Activity event"
    : `${label[0]!.toUpperCase()}${label.slice(1)}`;
  return {
    title: `${display} not found`,
    status: 404,
    code: "NOT_FOUND",
    detail: `${display} ${id} does not exist.`,
  };
}

function safeProblem(error: unknown): ProblemDetails {
  if (error instanceof MexPortError) return projectProblem(error.problem);
  if (error instanceof TeamCliUsageError) return invalidRequestProblem(error.message);
  return {
    title: "Team command failed",
    status: 500,
    code: "INTERNAL_ERROR",
    detail: "The Team command could not be completed.",
  };
}

function projectProblem(problem: ProblemDetails): ProblemDetails {
  return {
    ...(problem.type === undefined ? {} : { type: problem.type }),
    title: problem.title,
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
    ...(problem.instance === undefined ? {} : { instance: problem.instance }),
    ...(problem.diagnostics === undefined
      ? {}
      : { diagnostics: sortDiagnostics(problem.diagnostics) }),
    ...(problem.recovery === undefined
      ? {}
      : {
          recovery: [...problem.recovery]
            .map((entry) => ({
              label: entry.label,
              ...(entry.command === undefined ? {} : { command: entry.command }),
              ...(entry.route === undefined ? {} : { route: entry.route }),
            }))
            .sort((left, right) => stableCompare(left, right)),
        }),
  };
}

function sortDiagnostics(entries: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...entries]
    .map((entry) => structuredClone(entry))
    .sort((left, right) => stableCompare(left, right));
}

function stableCompare(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(sortJson(left));
  const rightJson = JSON.stringify(sortJson(right));
  return leftJson === rightJson ? 0 : leftJson < rightJson ? -1 : 1;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) sorted[key] = sortJson(child);
  }
  return sorted;
}

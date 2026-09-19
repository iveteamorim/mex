import {
  GROUNDING_HEALTH,
  type GroundingHealth,
} from "../../contracts/shared.js";
import {
  WIKI_LIFECYCLE_STATES,
  type WikiLifecycleState,
} from "../../contracts/wiki.js";
import type {
  TeamCommandIo,
  TeamOutputFlags,
} from "../../cli/commands.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
  TeamCliUsageError,
  type TeamCliEnvelope,
} from "../../cli/envelope.js";
import { SPEC_READ_LIMITS, type SpecListRequest } from "../service.js";
import {
  projectSpecList,
  projectSpecShow,
  specListDiagnostics,
  specShowDiagnostics,
  type SpecCliListProjection,
  type SpecCliShowProjection,
} from "./projections.js";
import type { SpecCliService, SpecCliServiceFactory } from "./service.js";

export interface SpecListFlags extends TeamOutputFlags {
  cursor?: string;
  limit?: string | number;
  includeArchived?: boolean;
  lifecycle?: string;
  grounding?: string;
  topic?: string;
}

export type SpecCliServiceSource = SpecCliService | SpecCliServiceFactory;

export async function runSpecList(
  source: SpecCliServiceSource,
  flags: SpecListFlags,
  io: TeamCommandIo,
): Promise<void> {
  await executeSpec("spec.list", flags, io, async () => {
    const request = requestFromFlags(flags);
    const result = projectSpecList(await (await resolveService(source)).list(request));
    return teamEnvelope({
      command: "spec.list",
      mode: "read",
      data: result,
      diagnostics: specListDiagnostics(result),
    });
  }, renderSpecList);
}

export async function runSpecShow(
  source: SpecCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await executeSpec("spec.show", flags, io, async () => {
    assertWikiEntityId(id, "Spec ID");
    const result = projectSpecShow(await (await resolveService(source)).show(id));
    return teamEnvelope({
      command: "spec.show",
      mode: "read",
      data: result,
      diagnostics: specShowDiagnostics(result),
    });
  }, renderSpecShow);
}

async function executeSpec<T>(
  command: "spec.list" | "spec.show",
  flags: TeamOutputFlags,
  io: TeamCommandIo,
  operation: () => Promise<TeamCliEnvelope<T>>,
  human: (data: T, io: TeamCommandIo) => void,
): Promise<void> {
  let envelope: TeamCliEnvelope<T> | TeamCliEnvelope<never>;
  try {
    envelope = await operation();
  } catch (error) {
    envelope = teamProblemEnvelope(command, "read", error);
  }
  if (flags.json === true) {
    io.write(renderTeamEnvelope(envelope));
  } else if (envelope.data === null) {
    const problem = envelope.problem;
    io.write(problem === null ? "Spec command failed." : `${problem.title}: ${problem.detail}`);
    for (const diagnostic of envelope.diagnostics) {
      io.write(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
    }
    if (problem?.recovery?.[0]?.command !== undefined) {
      io.write(`Recovery: ${problem.recovery[0].command}`);
    }
  } else {
    human(envelope.data as T, io);
    for (const diagnostic of envelope.diagnostics) {
      io.write(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}

function requestFromFlags(flags: SpecListFlags): SpecListRequest {
  const cursor = flags.cursor;
  if (cursor !== undefined && (cursor.length === 0
    || Buffer.byteLength(cursor, "utf8") > SPEC_READ_LIMITS.maxCursorBytes
    || !/^[A-Za-z0-9_-]+$/u.test(cursor))) {
    throw new TeamCliUsageError(`--cursor must be a valid cursor of at most ${SPEC_READ_LIMITS.maxCursorBytes} bytes.`);
  }
  const limit = flags.limit === undefined ? undefined : positiveLimit(flags.limit);
  const lifecycle = flags.lifecycle === undefined
    ? undefined
    : enumFlag(flags.lifecycle, WIKI_LIFECYCLE_STATES, "--lifecycle") as WikiLifecycleState;
  const grounding = flags.grounding === undefined
    ? undefined
    : enumFlag(flags.grounding, GROUNDING_HEALTH, "--grounding") as GroundingHealth;
  const topic = flags.topic === undefined ? undefined : wikiEntityId(flags.topic, "--topic");
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(flags.includeArchived === true ? { includeArchived: true } : {}),
    ...(lifecycle === undefined ? {} : { lifecycleStates: [lifecycle] }),
    ...(grounding === undefined ? {} : { groundingHealth: [grounding] }),
    ...(topic === undefined ? {} : { topics: [topic] }),
  };
}

function positiveLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > SPEC_READ_LIMITS.maxPageSize) {
    throw new TeamCliUsageError(`--limit must be an integer from 1 to ${SPEC_READ_LIMITS.maxPageSize}.`);
  }
  return parsed;
}

function enumFlag(value: string, allowed: readonly string[], label: string): string {
  if (!allowed.includes(value)) {
    throw new TeamCliUsageError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function wikiEntityId(value: string, label: string): string {
  const normalized = value.normalize("NFC");
  assertWikiEntityId(normalized, label);
  return normalized;
}

function assertWikiEntityId(value: string, label: string): void {
  if (!/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)) {
    throw new TeamCliUsageError(`${label} must be an mx_ prefixed Wiki ULID.`);
  }
}

async function resolveService(source: SpecCliServiceSource): Promise<SpecCliService> {
  return typeof source === "function" ? source() : source;
}

function renderSpecList(projection: SpecCliListProjection, io: TeamCommandIo): void {
  if (projection.page.items.length === 0) io.write("No Specs found.");
  for (const spec of projection.page.items) {
    io.write(`${spec.id}\t${spec.lifecycleState}\t${spec.groundingHealth}\t${spec.title}`);
  }
  if (projection.page.nextCursor !== null) {
    io.write(`Next cursor: ${projection.page.nextCursor}`);
    io.write("Results are bounded; continue with --cursor.");
  } else if (projection.page.truncated) {
    io.write("Results were truncated by a safety bound; narrow the filters.");
  }
}

function renderSpecShow(projection: SpecCliShowProjection, io: TeamCommandIo): void {
  const { detail } = projection;
  io.write(`${detail.spec.title} (${detail.spec.id})`);
  io.write(`Lifecycle: ${detail.spec.lifecycleState}`);
  io.write(`Grounding: ${detail.spec.groundingHealth}`);
  io.write(`Revision: ${detail.spec.version.semanticRevision} / ${detail.spec.version.contentHash}`);
  io.write(`Source: ${detail.spec.sourcePath}`);
  io.write(`Hierarchy: ${detail.hierarchy.requirements.length} requirements, ${detail.hierarchy.acceptanceCriteria.length} acceptance criteria, ${detail.hierarchy.constraints.length} constraints`);
  if (detail.provenance !== null) {
    io.write(`Provenance: ${detail.provenance.kind}${detail.provenance.id === undefined ? "" : `:${detail.provenance.id}`}`);
  }
  if (detail.body.length > 0) io.write(detail.body);
  if (detail.bodyTruncated) io.write("Body truncated at the 64 KiB read bound.");
  if (detail.sourcesTruncated || detail.groundingsTruncated) {
    io.write("Evidence truncated at the bounded read limit.");
  }
}

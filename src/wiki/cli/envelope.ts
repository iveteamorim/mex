/**
 * The wiki's answer shape, and the exit codes that go with it — defined once.
 *
 * §20.7 asks for "exact schema parity between CLI, service, and MCP adapters".
 * Parity that rests on three implementations agreeing is a promise somebody has
 * to keep; parity that rests on one definition is a property nobody can break
 * by accident. So this module owns the envelope, the diagnostic projection and
 * the exit-code table, every command is written over it, and a lint rule
 * asserts that no command builds an envelope of its own.
 *
 * Two things are deliberately here rather than at a call site:
 *
 * - **Remediation comes from the registry.** §14.4 requires every diagnostic to
 *   carry one, and the registry already has per-code text. Writing new prose at
 *   the call site would give the same code two different pieces of advice
 *   depending on which command surfaced it.
 * - **Nothing in this file can produce a colour.** There is no `chalk` import
 *   here or anywhere under `src/wiki/service/`, so §15.2's "no ANSI in JSON" is
 *   a property of what is in scope rather than a rule someone remembers. The
 *   human renderer lives in the CLI adapter, on the other side of this seam.
 */

import {
  sortDiagnostics,
  type DiagnosticLocation,
  type DiagnosticSeverity,
  type WikiDiagnostic,
} from "../model/diagnostic.js";

/**
 * The envelope §15.2 fixes: never ANSI, never a bare array.
 *
 * Hoisted from `cli/for-code.ts`, which shipped it in P7 and said in its own
 * comment that P9's job was to move it rather than redesign it. The version
 * stays at 1 because the shape has not changed — a shape that has already
 * shipped one command is the shape.
 */
export interface WikiEnvelope<T> {
  schemaVersion: number;
  ok: boolean;
  data: T;
  diagnostics: EnvelopeDiagnostic[];
}

/**
 * A diagnostic as it crosses the wire.
 *
 * `code`, `severity` and `message` were what P7 emitted. `file`, `entityId`,
 * `location` and `remediation` are added because §14.4 requires them and P7's
 * one command had no diagnostic that carried any — they are optional here for
 * the same reason they are optional on the model: a scaffold-wide diagnostic
 * belongs to no file.
 */
export interface EnvelopeDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  entityId?: string;
  location?: DiagnosticLocation;
  remediation?: string;
}

/** Bumped only if the envelope's shape changes. Present from the first command. */
export const WIKI_CLI_SCHEMA_VERSION = 1;

/**
 * Exit codes, as a table with one owner.
 *
 * §15.2 asks for "typed codes and non-zero exit status" and nothing more, so
 * the numbers are a choice; that they are enumerated in one place, derived from
 * the diagnostics rather than chosen at each call site, is not. A scattering of
 * `process.exit(1)` is how two commands come to disagree about what "failed"
 * means, and a caller in a shell script cannot tell "your query matched
 * nothing" from "your index is unusable" if both are 1.
 */
export const WIKI_EXIT = {
  /** The command answered. Diagnostics may still be present at warning or info. */
  ok: 0,
  /** The command ran and found problems at error severity. `wiki validate` in CI. */
  diagnostics: 1,
  /** The caller's fault: a bad flag, an unparseable operation file, a missing argument. */
  usage: 2,
  /** No index, or one this build cannot read. Distinct because the fix is a command. */
  index: 3,
  /** A precondition did not hold: the tree moved between plan and apply. */
  precondition: 4,
  /** The write was refused: outside the scaffold, or a `wiki.readOnly` path. */
  refused: 5,
} as const;

export type WikiExitCode = (typeof WIKI_EXIT)[keyof typeof WIKI_EXIT];

/**
 * Which codes mean which exit.
 *
 * Ordered by specificity, and read as "the most specific failure present wins":
 * an operation refused for writing outside the scaffold exits `refused` even
 * when the same run also reports a missing index, because the refusal is the
 * thing the caller has to act on.
 */
const EXIT_BY_CODE: ReadonlyMap<string, WikiExitCode> = new Map([
  ["WRITE_SCOPE_VIOLATION", WIKI_EXIT.refused],
  ["PATH_OUTSIDE_SCAFFOLD", WIKI_EXIT.refused],
  ["REVISION_CONFLICT", WIKI_EXIT.precondition],
  ["CONTENT_HASH_CONFLICT", WIKI_EXIT.precondition],
  ["WIKI_INDEX_MISSING", WIKI_EXIT.index],
  ["WIKI_INDEX_REBUILD_REQUIRED", WIKI_EXIT.index],
  ["INVALID_OPERATION_ENVELOPE", WIKI_EXIT.usage],
]);

/** Ranked worst-first, so the most actionable failure decides the status. */
const EXIT_PRECEDENCE: readonly WikiExitCode[] = [
  WIKI_EXIT.refused,
  WIKI_EXIT.precondition,
  WIKI_EXIT.index,
  WIKI_EXIT.usage,
  WIKI_EXIT.diagnostics,
];

/** Project a model diagnostic into the envelope's shape, keeping every §14.4 field it has. */
export function toEnvelopeDiagnostic(entry: WikiDiagnostic): EnvelopeDiagnostic {
  const projected: EnvelopeDiagnostic = {
    code: entry.code,
    severity: entry.severity,
    message: entry.message,
  };
  const file = entry.file ?? entry.location?.file;
  if (file !== undefined) projected.file = file;
  if (entry.entityId !== undefined) projected.entityId = entry.entityId;
  if (entry.location !== undefined) projected.location = entry.location;
  if (entry.remediation !== undefined) projected.remediation = entry.remediation;
  return projected;
}

/**
 * One result, ready to serialize.
 *
 * `ok` is not a free field: it is false exactly when some diagnostic is at
 * error severity, which is what makes `ok: false` with exit 0 unrepresentable
 * rather than merely discouraged.
 */
export function envelopeFor<T>(data: T, diagnostics: readonly WikiDiagnostic[] = []): WikiEnvelope<T> {
  const sorted = sortDiagnostics(diagnostics);
  return {
    schemaVersion: WIKI_CLI_SCHEMA_VERSION,
    ok: !sorted.some((entry) => entry.severity === "error"),
    data,
    diagnostics: sorted.map(toEnvelopeDiagnostic),
  };
}

/**
 * The exit status for an envelope.
 *
 * Derived from the envelope rather than passed alongside it, so the two cannot
 * disagree. A successful envelope is 0 whatever warnings it carries — a
 * `wiki list` that reports one stale grounding has still answered the question,
 * and a warning that failed the build would teach people to suppress warnings.
 */
export function exitCodeFor<T>(envelope: WikiEnvelope<T>): WikiExitCode {
  if (envelope.ok) return WIKI_EXIT.ok;
  const candidates = new Set<WikiExitCode>();
  for (const entry of envelope.diagnostics) {
    if (entry.severity !== "error") continue;
    candidates.add(EXIT_BY_CODE.get(entry.code) ?? WIKI_EXIT.diagnostics);
  }
  for (const code of EXIT_PRECEDENCE) if (candidates.has(code)) return code;
  // `ok` is false, so at least one error diagnostic exists and the loop above
  // found it. This is unreachable, and it is a failure rather than a 0 because
  // the one thing this module may never do is pair a failure with success.
  return WIKI_EXIT.diagnostics;
}

/** Serialize an envelope for the `--json` path. Deterministic, and never coloured. */
export function renderEnvelope<T>(envelope: WikiEnvelope<T>): string {
  return JSON.stringify(envelope);
}

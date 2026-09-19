import type { WikiDiagnostic } from "./diagnostic.js";
import {
  contextDiagnostic,
  isPlainObject,
  optional,
  reject,
  succeed,
  validateEnum,
  validateShape,
  validateString,
  type ValidationContext,
  type Validator,
} from "./validate.js";
import { isCanonicalRepoPath } from "./path.js";

/**
 * Sources — the evidence supporting an entity.
 *
 * Kept distinct from `provenance`, which answers *who or what produced this*.
 * The two get collapsed constantly and should not be: an entity written by an
 * agent (provenance) may cite a commit and a test (sources), and a reviewer
 * needs to see both columns to judge it. The Hub shows them in separate panels.
 *
 * Code grounding is also deliberately not a source kind — see `grounding.ts`.
 * Grounding drives drift detection and code-to-knowledge retrieval, which no
 * other evidence kind does.
 */

export const WIKI_SOURCE_TYPES = [
  "file",
  "symbol",
  "commit",
  "pull_request",
  "issue",
  "document",
  "manual",
  "agent_session",
  "test",
  "url",
] as const;

export type WikiSourceType = (typeof WIKI_SOURCE_TYPES)[number];

export interface WikiSource {
  type: WikiSourceType;
  ref?: string;
  note?: string;
  repository?: string;
  commit?: string;
  /** ISO 8601 timestamp. */
  capturedAt?: string;
  metadata?: Record<string, unknown>;
}

export function isWikiSourceType(value: unknown): value is WikiSourceType {
  return typeof value === "string" && (WIKI_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * A commit reference: hexadecimal, at least 7 characters, at most 40.
 *
 * Abbreviated SHAs are what people actually paste, and rejecting them would
 * make the commit kind unusable; 7 is Git's own default abbreviation length.
 */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Source kinds whose `ref` points outside the repository. */
const EXTERNAL_KINDS = new Set<WikiSourceType>(["url", "issue", "pull_request"]);

const metadataValidator: Validator<Record<string, unknown> | undefined> = (value, context) => {
  if (value === undefined) return succeed(undefined);
  if (!isPlainObject(value)) return reject(context, "INVALID_FIELD_TYPE", "Expected metadata to be an object.");
  return succeed(value);
};

const shapeValidator = validateShape<WikiSource>({
  type: validateEnum(WIKI_SOURCE_TYPES, "MALFORMED_SOURCE", "source type"),
  ref: optional(validateString()),
  note: optional(validateString()),
  repository: optional(validateString()),
  commit: optional(validateString()),
  capturedAt: optional(validateString()),
  metadata: metadataValidator,
});

/**
 * Validate a source, shape first and then per-kind.
 *
 * Per-kind is the whole point: a single "ref is a non-empty string" rule would
 * accept `{type: "commit", ref: "yesterday"}` and `{type: "manual"}` with no
 * evidence at all. Each kind states what makes it checkable.
 */
export const validateSource: Validator<WikiSource> = (value, context) => {
  const base = shapeValidator(value, context);
  if (!base.ok) return base;

  const source = base.value;
  const diagnostics: WikiDiagnostic[] = [...base.diagnostics];
  diagnostics.push(...validateSourceKind(source, context));

  return diagnostics.some((entry) => entry.severity === "error")
    ? { ok: false, diagnostics }
    : succeed(source, diagnostics);
};

function validateSourceKind(source: WikiSource, context: ValidationContext): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  const requireRef = (what: string): boolean => {
    if (source.ref === undefined || source.ref.trim() === "") {
      diagnostics.push(
        contextDiagnostic(context, "MALFORMED_SOURCE", `A "${source.type}" source requires ${what} in \`ref\`.`),
      );
      return false;
    }
    return true;
  };

  switch (source.type) {
    case "commit": {
      // The SHA may live in `ref` or in the dedicated `commit` field; accept
      // either, but require at least one and require it to look like a SHA.
      const sha = source.commit ?? source.ref;
      if (sha === undefined || sha.trim() === "") {
        diagnostics.push(contextDiagnostic(context, "MALFORMED_SOURCE", 'A "commit" source requires a commit SHA.'));
        break;
      }
      if (!COMMIT_SHA_PATTERN.test(sha)) {
        diagnostics.push(
          contextDiagnostic(context, "INVALID_COMMIT_FORMAT", `"${sha}" is not a hexadecimal commit SHA of 7-40 characters.`),
        );
      }
      break;
    }

    case "symbol":
      // A symbol source names a code-graph reference. It is not grounding — no
      // fingerprint, no drift — but it must still identify something.
      requireRef("a code-graph symbol reference");
      break;

    case "file":
      if (requireRef("a repository-relative file path") && !isCanonicalRepoPath(source.ref)) {
        diagnostics.push(contextDiagnostic(
          context,
          "MALFORMED_SOURCE",
          `"${source.ref}" is not a normalized repository-relative POSIX path.`,
        ));
      }
      break;

    case "test":
      requireRef("a test identifier or path");
      break;

    case "document":
      requireRef("a document path or identifier");
      break;

    case "agent_session":
      requireRef("a session identifier");
      break;

    case "manual":
      // Manual evidence has no external referent at all. The note *is* the
      // evidence, so without one the source asserts nothing.
      if (source.note === undefined || source.note.trim() === "") {
        diagnostics.push(
          contextDiagnostic(context, "MALFORMED_SOURCE", 'A "manual" source requires a note — the note is the evidence.'),
        );
      }
      break;

    case "url":
      if (requireRef("a URL")) {
        // Parsed, never fetched. Validation is offline by contract: reaching
        // out would leak the fact that a project cites a URL, and would make
        // `mex wiki validate` fail on a plane.
        if (!isParseableUrl(source.ref!)) {
          diagnostics.push(contextDiagnostic(context, "MALFORMED_SOURCE", `"${source.ref}" is not a parseable URL.`));
        }
      }
      break;

    case "issue":
    case "pull_request":
      requireRef("an issue or pull request reference");
      break;
  }

  if (source.commit !== undefined && source.type !== "commit" && !COMMIT_SHA_PATTERN.test(source.commit)) {
    diagnostics.push(
      contextDiagnostic(context, "INVALID_COMMIT_FORMAT", `"${source.commit}" is not a hexadecimal commit SHA of 7-40 characters.`),
    );
  }

  if (source.capturedAt !== undefined && Number.isNaN(Date.parse(source.capturedAt))) {
    diagnostics.push(contextDiagnostic(context, "MALFORMED_SOURCE", `"${source.capturedAt}" is not an ISO 8601 timestamp.`));
  }

  return diagnostics;
}

function isParseableUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new -- parsing for validity, not for the value
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report external evidence that has not been resolved.
 *
 * Legal — a project may cite an issue tracker it cannot reach — but the
 * unresolved state has to be *explicit* rather than assumed fine, so a reviewer
 * does not read an unchecked URL as verified. Info severity: it never blocks.
 */
export function reportUnresolvedSources(
  sources: readonly WikiSource[],
  isResolved: (source: WikiSource) => boolean = () => false,
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    if (!EXTERNAL_KINDS.has(source.type) || isResolved(source)) continue;
    diagnostics.push(
      contextDiagnostic(
        { path: `sources[${index}]` },
        "UNRESOLVED_EXTERNAL_SOURCE",
        `External ${source.type} evidence ${source.ref ?? "(no ref)"} has not been resolved.`,
      ),
    );
  }
  return diagnostics;
}

/**
 * Normalized identity of a source, for deduplication.
 *
 * `add-source` must be idempotent, and "the same evidence" has to survive
 * cosmetic differences: a differing `note`, a `capturedAt` from a later run, a
 * URL typed with different case in the host. Identity is therefore the kind
 * plus its referent — never the note, which is commentary rather than identity.
 */
export function sourceIdentity(source: WikiSource): string {
  const referent = normalizeReferent(source);
  return `${source.type}|${source.repository?.trim().toLowerCase() ?? ""}|${referent}`;
}

function normalizeReferent(source: WikiSource): string {
  if (source.type === "commit") {
    // Abbreviated and full SHAs of one commit are the same evidence; compare on
    // the shorter prefix by normalizing to 7 characters.
    const sha = (source.commit ?? source.ref ?? "").toLowerCase();
    return sha.slice(0, 7);
  }
  if (source.type === "manual") {
    // Manual evidence has no referent, so the note is all that distinguishes
    // two entries — the one kind where the note is identity.
    return (source.note ?? "").trim().toLowerCase();
  }
  const ref = (source.ref ?? "").trim();
  if (source.type === "url") {
    try {
      const url = new URL(ref);
      // Host is case-insensitive, path is not.
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
    } catch {
      return ref.toLowerCase();
    }
  }
  return ref;
}

/** Duplicate evidence entries, reported once per repeat. */
export function findDuplicateSources(sources: readonly WikiSource[]): WikiDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: WikiDiagnostic[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const identity = sourceIdentity(sources[index]!);
    if (seen.has(identity)) {
      diagnostics.push(
        contextDiagnostic({ path: `sources[${index}]` }, "DUPLICATE_SOURCE", `Duplicate ${sources[index]!.type} evidence.`),
      );
      continue;
    }
    seen.add(identity);
  }
  return diagnostics;
}

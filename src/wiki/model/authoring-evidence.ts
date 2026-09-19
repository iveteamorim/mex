import type { WikiProvenance } from "./entity.js";
import { validateSource, type WikiSource } from "./source.js";
import { reject, succeed, type ValidationContext, type ValidationResult, type Validator } from "./validate.js";

/** One proposal reference plus the Inbox's 64 evidence references. */
export const MAX_APPENDED_SOURCES = 65;
/** Matches the immutable Wiki reader's per-entity metadata bound. */
export const MAX_AUTHORING_SOURCES = 200;
export const MAX_AUTHORING_SOURCE_BYTES = 256 * 1024;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function closedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plainRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= bytes && Buffer.byteLength(value, "utf8") <= bytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isoTime(value: unknown): boolean {
  return boundedText(value, 256)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function provenanceActor(value: unknown): boolean {
  return closedRecord(value, ["kind", "id"])
    && ["human", "agent", "system"].includes(value.kind as string)
    && boundedText(value.id, 256);
}

/** Creation attribution is supplied explicitly; no actor/time is inferred here. */
export const validateAuthoringProvenance: Validator<WikiProvenance> = (value, context) => {
  if (!closedRecord(value, ["createdBy", "createdAt", "lastModifiedBy", "lastModifiedAt", "agentSessionId"])
    || !provenanceActor(value.createdBy)
    || (value.createdAt !== undefined && !isoTime(value.createdAt))
    || (value.lastModifiedBy !== undefined && !provenanceActor(value.lastModifiedBy))
    || (value.lastModifiedAt !== undefined && !isoTime(value.lastModifiedAt))
    || (value.agentSessionId !== undefined && !boundedText(value.agentSessionId, 256))) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", "Creation provenance requires bounded, explicit producer identities and valid timestamps.");
  }
  return succeed(value as unknown as WikiProvenance);
};

/** Count JSON bytes with fixed traversal bounds before serializing a collection. */
function boundedJson(value: unknown, maxBytes: number, maxDepth: number, maxEntries: number): boolean {
  let remaining = maxBytes;
  let nodes = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 10_000 || depth > maxDepth || remaining < 0) return false;
    if (entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) {
      remaining -= JSON.stringify(entry).length;
      return remaining >= 0;
    }
    if (typeof entry === "string") {
      if (entry.length > remaining) return false;
      remaining -= Buffer.byteLength(JSON.stringify(entry), "utf8");
      return remaining >= 0;
    }
    if (Array.isArray(entry)) {
      if (entry.length > maxEntries) return false;
      remaining -= 2 + Math.max(0, entry.length - 1);
      return Array.from(entry).every((item) => visit(item, depth + 1));
    }
    if (!plainRecord(entry)) return false;
    const keys = Object.keys(entry);
    if (keys.length > maxEntries) return false;
    remaining -= 2 + Math.max(0, keys.length - 1);
    return keys.every((key) => {
      remaining -= 1;
      return key !== "__proto__" && key !== "constructor" && key !== "prototype"
        && visit(key, depth + 1) && visit(entry[key], depth + 1);
    });
  };
  return visit(value, 0) && remaining >= 0;
}

const SOURCE_FIELDS = ["type", "ref", "note", "repository", "commit", "capturedAt", "metadata"] as const;

/** New evidence never silently drops unrepresentable metadata or extra fields. */
export function validateAuthoringSources(
  value: unknown,
  context: ValidationContext,
  maximum = MAX_APPENDED_SOURCES,
): ValidationResult<WikiSource[]> {
  if (!Array.isArray(value) || value.length > maximum
    || !boundedJson(value, MAX_AUTHORING_SOURCE_BYTES, 8, MAX_AUTHORING_SOURCES)) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", "Authoring evidence exceeds its source count, byte, or JSON bounds.");
  }
  const sources: WikiSource[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const source = value[index];
    const at = { ...context, path: `${context.path}[${index}]` };
    if (!closedRecord(source, SOURCE_FIELDS)
      || ([ ["ref", 4096], ["note", 65_536], ["repository", 4096], ["commit", 256] ] as const)
        .some(([key, bytes]) => source[key] !== undefined && (typeof source[key] !== "string"
          || source[key].length > bytes || Buffer.byteLength(source[key], "utf8") > bytes))
      || (source.capturedAt !== undefined && !isoTime(source.capturedAt))
      || (source.metadata !== undefined && (!plainRecord(source.metadata)
        || !boundedJson(source.metadata, 65_536, 4, 50)))) {
      return reject(at, "INVALID_OPERATION_PAYLOAD", "Authoring evidence requires bounded source fields and JSON metadata.");
    }
    const result = validateSource(source, at);
    if (!result.ok) return result;
    sources.push(result.value);
  }
  return succeed(sources);
}

/** Existing source entries remain intact; reject an append that exceeds safety. */
export function authoringSourceCollectionFits(sources: readonly WikiSource[]): boolean {
  return sources.length <= MAX_AUTHORING_SOURCES
    && boundedJson(sources, MAX_AUTHORING_SOURCE_BYTES, 8, MAX_AUTHORING_SOURCES);
}

import { generateUlid, decodeUlidTime, isUlid, ULID_LENGTH } from "./ulid.js";

/**
 * Wiki entity identity.
 *
 * Wiki-authored entity ids are `mx_` plus a 26-character Crockford Base32 ULID.
 * Team-owned entities retain the prefixed ULIDs minted by their owning
 * repository and are accepted on read. The single invariant that matters is
 * that **an id is never derived from a title or a path**, and is never
 * regenerated because a heading was renamed or a file was moved. Everything
 * downstream — relations, backlinks, topic membership, grounding — refers to
 * entities by id precisely so those edits are free.
 */

declare const entityIdBrand: unique symbol;

/**
 * An opaque entity identifier.
 *
 * Branded so a bare `string` cannot be passed where an id is expected: the only
 * ways in are {@link generateEntityId} and the {@link isEntityId} /
 * {@link normalizeEntityId} guards, all of which check the format first. The
 * brand is a phantom type and costs nothing at runtime.
 */
export type EntityId = string & { readonly [entityIdBrand]: true };

/** The prefix minted by Wiki operations. Team prefixes are read-only here. */
export const ENTITY_ID_PREFIX = "mx_";
/** Length of a Wiki-minted `mx_` id. Readable team prefixes have other lengths. */
export const ENTITY_ID_LENGTH = ENTITY_ID_PREFIX.length + ULID_LENGTH;

/**
 * Canonical prefixes the Wiki can read from its disposable index.
 *
 * Only {@link ENTITY_ID_PREFIX} is ever minted by this module. The remaining
 * prefixes belong to TeamWorkflowPort repositories; accepting them here lets
 * Wiki index and relate their canonical `mex:` entities without taking write
 * ownership of those artifacts.
 */
export const READABLE_ENTITY_ID_PREFIXES = [
  ENTITY_ID_PREFIX,
  "member_",
  "ws_",
  "proposal_",
  "relay_",
  "event_",
  "playbook_",
  "run_",
] as const;

export type ReadableEntityIdPrefix = (typeof READABLE_ENTITY_ID_PREFIXES)[number];

/**
 * Canonical on-disk form: lowercase prefix, uppercase Crockford body.
 *
 * `I`, `L`, `O` and `U` are absent from the character class because Crockford
 * excludes them — an id containing one is malformed, not merely unusual, and is
 * rejected rather than silently mapped onto `1`/`0`. Silent mapping would turn
 * a typo into a different, valid-looking id pointing at the wrong entity.
 */
export const ENTITY_ID_PATTERN = /^(?:mx_|member_|ws_|proposal_|relay_|event_|playbook_|run_)[0-9A-HJKMNP-TV-Z]{26}$/;

/** Mint a fresh entity id. The only way MEX creates one. */
export function generateEntityId(): EntityId {
  return (ENTITY_ID_PREFIX + generateUlid()) as EntityId;
}

/** True when `value` is an entity id in exact canonical form. */
export function isEntityId(value: unknown): value is EntityId {
  if (typeof value !== "string") return false;
  const prefix = canonicalPrefixOf(value);
  return prefix !== null && isUlid(value.slice(prefix.length));
}

/**
 * Accept a case-insensitive id and return it in canonical form, or null.
 *
 * Reading is lenient about case because ids get retyped by hand and pasted
 * through case-mangling tools; writing is not, so that one entity has exactly
 * one spelling on disk and textual diffs stay meaningful.
 */
export function normalizeEntityId(value: unknown): EntityId | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const prefix = readablePrefixOf(trimmed);
  if (prefix === null) return null;
  const candidate = prefix + trimmed.slice(prefix.length).toUpperCase();
  return isEntityId(candidate) ? candidate : null;
}

/** The generation timestamp encoded in an id, or null when malformed. */
export function entityIdTimestamp(id: string): number | null {
  const normalized = normalizeEntityId(id);
  if (normalized === null) return null;
  const prefix = canonicalPrefixOf(normalized);
  return prefix === null ? null : decodeUlidTime(normalized.slice(prefix.length));
}

/**
 * Ids appearing more than once, in first-seen order.
 *
 * Comparison is on the normalized form, so `mx_01ARZ…` and `MX_01arz…` count as
 * the same duplicate — which is the case a case-sensitive check would miss and
 * which produces two index rows claiming one identity. Values that are not ids
 * at all are skipped; that is a different diagnostic
 * (`INVALID_ENTITY_ID`), reported by the entity validator.
 */
export function findDuplicateEntityIds(ids: Iterable<string>): EntityId[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  const ordered: EntityId[] = [];
  for (const raw of ids) {
    const id = normalizeEntityId(raw);
    if (id === null) continue;
    if (seen.has(id)) {
      if (!duplicated.has(id)) {
        duplicated.add(id);
        ordered.push(id);
      }
      continue;
    }
    seen.add(id);
  }
  return ordered;
}

/** Deterministic id ordering. Within one owner prefix, this is creation order. */
export function compareEntityIds(left: EntityId, right: EntityId): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readablePrefixOf(value: string): ReadableEntityIdPrefix | null {
  return READABLE_ENTITY_ID_PREFIXES.find((prefix) => (
    value.length === prefix.length + ULID_LENGTH
    && value.slice(0, prefix.length).toLowerCase() === prefix
  )) ?? null;
}

function canonicalPrefixOf(value: string): ReadableEntityIdPrefix | null {
  return READABLE_ENTITY_ID_PREFIXES.find((prefix) => (
    value.length === prefix.length + ULID_LENGTH
    && value.startsWith(prefix)
  )) ?? null;
}

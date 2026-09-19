import type { WikiDiagnostic } from "./diagnostic.js";
import { normalizeEntityId, type EntityId } from "./ids.js";
import { validateGrounding, type WikiGrounding } from "./grounding.js";
import { validateRelationRef, type WikiRelationRef } from "./relation.js";
import { validateSource, type WikiSource } from "./source.js";
import {
  contextDiagnostic,
  isPlainObject,
  optional,
  reject,
  succeed,
  validateArray,
  validateEnum,
  validateInteger,
  validateShape,
  validateString,
  type ValidationContext,
  type Validator,
} from "./validate.js";

/**
 * The canonical entity — the one model every consumer uses.
 *
 * CLI, index, operations, synthesis and the future Hub all read and write this
 * shape. Agent-facing schemas may be narrower, but they map into this through
 * explicit conversion functions rather than growing a parallel near-identical
 * type; the reference implementation's divergent entity/status schemas are the
 * failure this rule exists to avoid.
 */

/** Entity types Wiki operations and synthesis may author. */
export const WIKI_ENTITY_TYPES = [
  "architecture",
  "component",
  "decision",
  "convention",
  "pattern",
  "guide",
  "risk",
  "fact",
  "task",
  "topic",
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
] as const;

/**
 * Team-owned entity types accepted by Wiki reads but never authored by Wiki.
 *
 * Their canonical paths are hard-reserved in the operation layer. Keeping this
 * list separate from {@link WIKI_ENTITY_TYPES} also prevents operation payload
 * validation and synthesis prompts from advertising them as Wiki write types.
 * Registration only accepts a valid `mex:` entity on read; it does not project
 * strict Team frontmatter. In particular, the current Activity codec remains a
 * direct Team repository read and is not automatically indexed by Wiki.
 */
export const TEAM_READABLE_ENTITY_TYPES = [
  "member",
  "workstream",
  "proposal",
  "relay",
  "activity",
  "playbook",
  "playbook_run",
] as const;

export type WikiDefaultEntityType =
  | (typeof WIKI_ENTITY_TYPES)[number]
  | (typeof TEAM_READABLE_ENTITY_TYPES)[number];

/**
 * An entity type.
 *
 * Widened to `string` beyond the defaults on purpose: the build spec requires
 * that new types can be registered without a database redesign. Unknown types
 * are a *diagnostic* by default rather than silently accepted — see
 * {@link createEntityTypeRegistry} — so the extension point is explicit and the
 * default stays strict.
 */
export type WikiEntityType = WikiDefaultEntityType | (string & {});

/**
 * Canonical lifecycle. Governance — decided by humans and operations.
 *
 * Deliberately *not* extensible, and deliberately free of any health value.
 * `stale` belongs to grounding health, which is per-checkout and derived; a
 * `stale` here would let one branch's local code drift rewrite what the whole
 * team has agreed is current.
 */
export const WIKI_LIFECYCLE_STATES = ["in_flight", "promoted", "deprecated", "archived"] as const;

export type WikiLifecycleState = (typeof WIKI_LIFECYCLE_STATES)[number];

/** Lifecycle states included in default active retrieval. */
export const ACTIVE_LIFECYCLE_STATES: readonly WikiLifecycleState[] = ["in_flight", "promoted"];

export function isWikiLifecycleState(value: unknown): value is WikiLifecycleState {
  return typeof value === "string" && (WIKI_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isDefaultEntityType(value: unknown): value is WikiDefaultEntityType {
  return typeof value === "string"
    && ((WIKI_ENTITY_TYPES as readonly string[]).includes(value)
      || (TEAM_READABLE_ENTITY_TYPES as readonly string[]).includes(value));
}

/**
 * Exact position of an entity in its file.
 *
 * **Every offset is a UTF-16 code-unit index into the decoded file text, not a
 * byte offset.** These originate in a Markdown AST, whose positions index a
 * JavaScript string; they coincide with byte offsets only for ASCII. Indexing a
 * Buffer with one would corrupt any file containing a curly quote or an emoji,
 * so all splicing operates on strings.
 *
 * The ranges are contiguous and non-overlapping: `metadataStart .. bodyEnd`
 * covers the entity exactly, which is what makes the operation layer's
 * write-scope enforcement checkable.
 */
export interface WikiEntityLocation {
  /** Path relative to the project root. */
  file: string;
  /** Start of the metadata block (frontmatter `mex:` key or HTML comment). */
  metadataStart: number;
  metadataEnd: number;
  /** Start of the bound heading. Equal to `bodyStart` for a file-level entity with no heading. */
  headingStart: number;
  headingEnd: number;
  /**
   * Body runs to whichever comes first: the next heading of equal-or-shallower
   * depth, **the start of the next entity's metadata**, or end of file.
   *
   * The middle clause is not in the build spec, which gives only the depth
   * rule. It is forced by the partition property — without it a file-level
   * entity's body swallows the block entities nested inside it and their ranges
   * overlap. A consequence: a file-level entity's body stops at the first
   * nested entity and never resumes, so it is not the whole file.
   */
  bodyStart: number;
  bodyEnd: number;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Markdown heading depth (1-6); 0 for a file-level entity with no bound heading. */
  headingDepth: number;
  /** Hash of the whole file at index time. A change signal, never a precondition. */
  fileContentHash: string;
  /** Hash of this entity's own text. The operation precondition. */
  entityContentHash: string;
}

/** Who or what produced the entity. Distinct from `sources`, which is evidence. */
export interface WikiProvenance {
  createdBy: { kind: "human" | "agent" | "system"; id: string };
  /** ISO 8601. */
  createdAt?: string;
  lastModifiedBy?: { kind: "human" | "agent" | "system"; id: string };
  lastModifiedAt?: string;
  /** Agent session this entity came out of, when it came from one. */
  agentSessionId?: string;
}

export interface WikiEntity {
  id: EntityId;
  type: WikiEntityType;
  title: string;
  summary?: string;
  body: string;
  status: WikiLifecycleState;
  /** Starts at 1; incremented only by accepted operations. */
  revision: number;
  /** Topic entity ids. Never free strings — aliases are resolved before any write. */
  topics: EntityId[];
  relations: WikiRelationRef[];
  sources: WikiSource[];
  groundsTo: WikiGrounding[];
  provenance?: WikiProvenance;
  metadata?: Record<string, unknown>;
  location: WikiEntityLocation;
}

/**
 * The set of entity types this scaffold accepts.
 *
 * The registry is the documented extension point. Projects with their own
 * vocabulary register types here; anything unregistered produces
 * `INVALID_ENTITY_TYPE` rather than being accepted silently, so a typo in a
 * hand-edited file is a reported problem instead of a new one-entity type.
 */
export interface EntityTypeRegistry {
  has(type: string): boolean;
  list(): WikiEntityType[];
}

export function createEntityTypeRegistry(additionalTypes: readonly string[] = []): EntityTypeRegistry {
  const types = new Set<string>([
    ...WIKI_ENTITY_TYPES,
    ...TEAM_READABLE_ENTITY_TYPES,
    ...additionalTypes,
  ]);
  return {
    has: (type) => types.has(type),
    list: () => [...types].sort(),
  };
}

/** The registry every consumer gets unless a project configures extra types. */
export const DEFAULT_ENTITY_TYPE_REGISTRY = createEntityTypeRegistry();

const entityIdValidator: Validator<EntityId> = (value, context) => {
  const normalized = normalizeEntityId(value);
  if (normalized === null) {
    return reject(context, "INVALID_ENTITY_ID", `Expected an entity id, got ${typeof value === "string" ? JSON.stringify(value) : typeof value}.`);
  }
  return succeed(normalized);
};

const actorValidator: Validator<{ kind: "human" | "agent" | "system"; id: string }> = validateShape({
  kind: validateEnum(["human", "agent", "system"] as const, "INVALID_FIELD_TYPE", "actor kind"),
  id: validateString(),
});

const provenanceValidator: Validator<WikiProvenance | undefined> = optional(
  validateShape<WikiProvenance>({
    createdBy: actorValidator,
    createdAt: optional(validateString()),
    lastModifiedBy: optional(actorValidator),
    lastModifiedAt: optional(validateString()),
    agentSessionId: optional(validateString()),
  }),
);

const locationValidator: Validator<WikiEntityLocation> = validateShape<WikiEntityLocation>({
  file: validateString(),
  metadataStart: validateInteger({ min: 0 }),
  metadataEnd: validateInteger({ min: 0 }),
  headingStart: validateInteger({ min: 0 }),
  headingEnd: validateInteger({ min: 0 }),
  bodyStart: validateInteger({ min: 0 }),
  bodyEnd: validateInteger({ min: 0 }),
  startLine: validateInteger({ min: 1 }),
  endLine: validateInteger({ min: 1 }),
  headingDepth: validateInteger({ min: 0, max: 6 }),
  fileContentHash: validateString(),
  entityContentHash: validateString(),
});

const metadataValidator: Validator<Record<string, unknown> | undefined> = (value, context) => {
  if (value === undefined) return succeed(undefined);
  if (!isPlainObject(value)) return reject(context, "INVALID_FIELD_TYPE", "Expected metadata to be an object.");
  return succeed(value);
};

export interface EntityValidationOptions {
  registry?: EntityTypeRegistry;
  /**
   * Validate `location` too.
   *
   * Off by default because the model is also used for entities that do not yet
   * have a position — an operation payload proposing a new entity, or a
   * synthesis candidate. Location is required of anything read from a file, and
   * the Markdown layer passes `true`.
   */
  requireLocation?: boolean;
}

/**
 * Validate one entity.
 *
 * Every field is checked even after one fails, so a single call reports every
 * problem in the entity rather than only the first.
 */
export function createEntityValidator(options: EntityValidationOptions = {}): Validator<WikiEntity> {
  const registry = options.registry ?? DEFAULT_ENTITY_TYPE_REGISTRY;

  const typeValidator: Validator<WikiEntityType> = (value, context) => {
    if (typeof value !== "string" || !registry.has(value)) {
      return reject(
        context,
        "INVALID_ENTITY_TYPE",
        `Unknown entity type ${typeof value === "string" ? JSON.stringify(value) : typeof value}. Registered: ${registry.list().join(", ")}.`,
      );
    }
    return succeed(value);
  };

  const titleValidator: Validator<string> = (value, context) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return reject(context, "MISSING_ENTITY_TITLE", "An entity needs a title, taken from its heading or set explicitly.");
    }
    return succeed(value);
  };

  const statusValidator: Validator<WikiLifecycleState> = (value, context) => {
    if (!isWikiLifecycleState(value)) {
      return reject(
        context,
        "INVALID_LIFECYCLE_STATE",
        `Unknown lifecycle state ${typeof value === "string" ? JSON.stringify(value) : typeof value}. Grounding health (fresh/changed/missing/ambiguous/unverified) is a separate, derived field and is never stored here.`,
      );
    }
    return succeed(value);
  };

  const revisionValidator: Validator<number> = (value, context) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return reject(context, "INVALID_REVISION", `Revision must be an integer >= 1, got ${String(value)}.`);
    }
    return succeed(value);
  };

  const topicValidator: Validator<EntityId> = (value, context) => {
    const normalized = normalizeEntityId(value);
    if (normalized === null) {
      return reject(
        context,
        "UNKNOWN_TOPIC",
        `Topic membership must be a topic entity id, got ${typeof value === "string" ? JSON.stringify(value) : typeof value}. Aliases are resolved to ids before writing.`,
      );
    }
    return succeed(normalized);
  };

  const shape = validateShape<WikiEntity>({
    id: entityIdValidator,
    type: typeValidator,
    title: titleValidator,
    summary: optional(validateString()),
    body: validateString({ allowEmpty: true }),
    status: statusValidator,
    revision: revisionValidator,
    topics: validateArray(topicValidator),
    relations: validateArray(validateRelationRef),
    sources: validateArray(validateSource),
    groundsTo: validateArray(validateGrounding),
    provenance: provenanceValidator,
    metadata: metadataValidator,
    location: options.requireLocation
      ? locationValidator
      : (optional(locationValidator) as Validator<WikiEntityLocation>),
  });

  return (value, context) => {
    if (!isPlainObject(value)) {
      return reject(context, "INVALID_FIELD_TYPE", "Expected an entity object.");
    }
    const result = shape(value, context);
    if (!result.ok) return result;
    const rangeDiagnostics = checkLocationRanges(result.value, context);
    const diagnostics = [...result.diagnostics, ...rangeDiagnostics];
    // An inverted range is an error, so it must fail the validation rather than
    // ride along as an advisory on a successful result.
    return rangeDiagnostics.some((entry) => entry.severity === "error")
      ? { ok: false, diagnostics }
      : succeed(result.value, diagnostics);
  };
}

/**
 * Ranges must be ordered and non-overlapping.
 *
 * Caught here rather than in the Markdown layer because an inverted range is a
 * *model* invariant: everything downstream slices with these numbers, and a
 * negative-length range silently produces an empty splice rather than an error.
 */
function checkLocationRanges(entity: WikiEntity, context: ValidationContext): WikiDiagnostic[] {
  const location = entity.location as WikiEntityLocation | undefined;
  if (location === undefined) return [];
  const diagnostics: WikiDiagnostic[] = [];
  const ordered: [string, number, string, number][] = [
    ["metadataStart", location.metadataStart, "metadataEnd", location.metadataEnd],
    ["headingStart", location.headingStart, "headingEnd", location.headingEnd],
    ["bodyStart", location.bodyStart, "bodyEnd", location.bodyEnd],
  ];
  for (const [startName, start, endName, end] of ordered) {
    if (end < start) {
      diagnostics.push(
        contextDiagnostic(
          { ...context, path: `${context.path === "" ? "" : `${context.path}.`}location` },
          "INVALID_FIELD_TYPE",
          `${endName} (${end}) precedes ${startName} (${start}).`,
        ),
      );
    }
  }
  if (location.endLine < location.startLine) {
    diagnostics.push(
      contextDiagnostic(
        { ...context, path: `${context.path === "" ? "" : `${context.path}.`}location` },
        "INVALID_FIELD_TYPE",
        `endLine (${location.endLine}) precedes startLine (${location.startLine}).`,
      ),
    );
  }
  return diagnostics;
}

/** The default entity validator, using the default type registry. */
export const validateEntity: Validator<WikiEntity> = createEntityValidator();

/**
 * Entities included in default retrieval.
 *
 * Archived entities are excluded by default and remain resolvable when asked
 * for by id — history must not dangle, but it must not crowd out current
 * knowledge either.
 */
export function isActiveEntity(entity: Pick<WikiEntity, "status">): boolean {
  return (ACTIVE_LIFECYCLE_STATES as readonly string[]).includes(entity.status);
}

/**
 * Report ids claimed by more than one entity.
 *
 * Uniqueness is validated across the whole scaffold rather than per file: the
 * usual way a duplicate appears is a file copied as a starting point for
 * another, which puts the two claimants in different files. Every claimant
 * after the first is reported, with its own location, so the user can see both
 * sides and decide which keeps the id.
 */
export function validateEntitySetIdentity(
  entities: readonly Pick<WikiEntity, "id" | "location">[],
): WikiDiagnostic[] {
  const firstSeen = new Map<string, string | undefined>();
  const diagnostics: WikiDiagnostic[] = [];

  for (const candidate of entities) {
    const id = normalizeEntityId(candidate.id);
    // Malformed ids are INVALID_ENTITY_ID from the entity validator; reporting
    // them here as well would double-count one problem.
    if (id === null) continue;

    if (!firstSeen.has(id)) {
      firstSeen.set(id, candidate.location?.file);
      continue;
    }

    const original = firstSeen.get(id);
    diagnostics.push(
      contextDiagnostic(
        { path: "id", entityId: id, file: candidate.location?.file },
        "DUPLICATE_ENTITY_ID",
        `Entity id ${id} is already claimed${original === undefined ? "" : ` by ${original}`}.`,
      ),
    );
  }

  return diagnostics;
}

/**
 * Detect entities whose recorded text no longer matches what is on disk.
 *
 * A manual edit moves the content hash without moving the revision. That is
 * **legal** — people are allowed to edit their own Markdown in any editor — so
 * this is info severity with a reconcile path, never an error, and it never
 * blocks a read.
 */
export function detectRevisionDivergence(
  entity: Pick<WikiEntity, "id" | "revision" | "location">,
  currentEntityContentHash: string,
): WikiDiagnostic[] {
  if (entity.location === undefined) return [];
  if (entity.location.entityContentHash === currentEntityContentHash) return [];
  return [
    contextDiagnostic(
      { path: "", entityId: entity.id, file: entity.location.file },
      "REVISION_DIVERGED",
      `Entity ${entity.id} was edited by hand since revision ${entity.revision} was recorded.`,
    ),
  ];
}

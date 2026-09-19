import { generateEntityId, type EntityId } from "../ids.js";
import type { WikiEntity, WikiEntityLocation } from "../entity.js";
import { entityContentHash, fileContentHash } from "../hash.js";

/**
 * Fixture builders shared across the model tests.
 *
 * Kept minimal on purpose: a test that has to name a field is a test that cares
 * about it, so everything not passed gets a valid default and the assertion in
 * each test is about the one thing it overrode.
 */

export function location(overrides: Partial<WikiEntityLocation> = {}): WikiEntityLocation {
  return {
    file: ".mex/context/architecture.md",
    metadataStart: 0,
    metadataEnd: 40,
    headingStart: 40,
    headingEnd: 60,
    bodyStart: 60,
    bodyEnd: 200,
    startLine: 1,
    endLine: 12,
    headingDepth: 2,
    fileContentHash: fileContentHash("file"),
    entityContentHash: entityContentHash("entity"),
    ...overrides,
  };
}

export function entity(overrides: Partial<WikiEntity> = {}): WikiEntity {
  return {
    id: generateEntityId(),
    type: "decision",
    title: "Rotate refresh tokens",
    body: "Refresh tokens are single-use and rotated after every successful refresh.",
    status: "promoted",
    revision: 1,
    topics: [],
    relations: [],
    sources: [],
    groundsTo: [],
    location: location(),
    ...overrides,
  };
}

/** A valid grounding, with graph-shaped node id and fingerprint. */
export function grounding(overrides: Partial<{ node: string; fingerprint: string }> = {}) {
  return {
    node: "function:a3f8c21d9e4b7f60a1c2d3e4f5061728",
    fingerprint: "mh:64:9f2a4c6e",
    ...overrides,
  };
}

export function ids(count: number): EntityId[] {
  return Array.from({ length: count }, () => generateEntityId());
}

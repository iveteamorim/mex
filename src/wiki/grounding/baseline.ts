/**
 * The wiki's view of the one grounding baseline (D1).
 *
 * There is exactly one baseline store and it lives in `graph.db`. This module
 * is a subject-shaped accessor onto it, not a second copy: everything here
 * delegates to `FingerprintStore`, which is the code that has always owned that
 * table.
 *
 * **What the baseline is for, and what it is not for.** It holds the node's
 * source and body hash as of the last grounding, so a reviewer can be shown the
 * old side of a diff. It is re-captured by an ordinary graph rebuild, which is
 * precisely why no resolution may reach a verdict from it — see `resolve.ts`.
 * The wiki index's `wiki_groundings` rows hold *derived* resolution and health;
 * delete `wiki.db` and they come back, because the canonical reference is in
 * Markdown and the baseline is recapturable from the graph. That is §20.5's
 * step 9 and it is why this file stores nothing of its own.
 */

import { FingerprintStore } from "../../graph/fingerprint-store.js";
import type { GroundingBaseline, GroundingSubject } from "../../graph/grounding.js";
import type { SqliteDatabase } from "../../graph/db/sqlite.js";
import type { EntityId } from "../model/ids.js";
import type { WikiGrounding } from "../model/grounding.js";

/** The baseline subject for a wiki entity. */
export function entitySubject(id: EntityId | string): GroundingSubject {
  return { kind: "entity", id: String(id) };
}

/**
 * Read and write baselines for wiki entities.
 *
 * Kept as a thin named wrapper rather than passing `FingerprintStore` around,
 * so the entity-kind subject is constructed in one place. A caller that builds
 * `{kind: "scaffold", id: someEntityId}` by hand writes a row nothing will ever
 * read again, and nothing would fail.
 */
export class WikiBaselineStore {
  private readonly store: FingerprintStore;

  constructor(db: SqliteDatabase) {
    this.store = new FingerprintStore(db);
  }

  get(entityId: EntityId | string, nodeId: string): GroundingBaseline | null {
    return this.store.getBaseline(entitySubject(entityId), nodeId);
  }

  list(entityId: EntityId | string): GroundingBaseline[] {
    return this.store.listBaselines(entitySubject(entityId));
  }

  /**
   * Record what a node looked like at grounding time.
   *
   * `source` is the old side of a future diff. Callers that do not have the
   * body text pass an empty string rather than omitting the row: a baseline
   * with no captured source still carries the hash and the fingerprint, and a
   * missing row would look like "never grounded".
   */
  capture(
    entityId: EntityId | string,
    grounding: WikiGrounding,
    source: string,
    bodyHash: string,
  ): void {
    this.store.saveBaseline({
      subject: entitySubject(entityId),
      nodeId: grounding.node,
      source,
      bodyHash,
      fingerprint: grounding.fingerprint,
    });
  }

  delete(entityId: EntityId | string, nodeId: string): void {
    this.store.deleteBaseline(entitySubject(entityId), nodeId);
  }
}

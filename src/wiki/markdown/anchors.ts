/**
 * Inline `mex://<nodeId>` anchors: associating them with an entity, and
 * rewriting one without disturbing its visible text.
 *
 * Anchors are not entity-level grounding and do not replace it — they are
 * in-prose references to a code node. The index associates each with the entity
 * whose body contains it so a reader can ask "what knowledge points at this
 * symbol", but an anchor outside every entity stays unattached rather than
 * being credited to the nearest one. Attaching it to a neighbour would invent a
 * relationship the author never wrote.
 */

import type { EntityId } from "../model/ids.js";
import { applyEdits, type PatchResult } from "./patch.js";
import type { ParsedAnchor } from "./contract.js";
import type { RawLink } from "./parse.js";

/** Entity body extents, enough to decide which one contains an offset. */
export interface AnchorOwner {
  id: EntityId;
  bodyStart: number;
  bodyEnd: number;
}

/**
 * Associate each anchor with its containing entity, or `null`.
 *
 * Containment is decided on the anchor's start offset: a link that begins
 * inside a body belongs to it, even in the pathological case of a body ending
 * mid-link, which cannot arise from a correct parse but should not throw here.
 */
export function associateAnchors(links: readonly RawLink[], owners: readonly AnchorOwner[]): ParsedAnchor[] {
  return links.map((link) => {
    const owner = owners.find((candidate) => link.start >= candidate.bodyStart && link.start < candidate.bodyEnd);
    return {
      nodeId: link.nodeId,
      range: { start: link.start, end: link.end },
      entityId: owner ? owner.id : null,
    };
  });
}

/**
 * Rewrite one anchor's node id, preserving the link's visible text.
 *
 * Only the URI's own range is replaced, so `[the token rotator](mex://old)`
 * keeps its label and every surrounding character. Reconciliation rewrites
 * anchors when a symbol moves, and a rewrite that reformatted the link would
 * turn a routine code move into a noisy diff.
 */
export function rewriteAnchor(text: string, anchor: ParsedAnchor, nodeId: string): PatchResult {
  if (!nodeId) throw new Error("Invalid mex anchor node id");

  const link = text.slice(anchor.range.start, anchor.range.end);
  const oldUri = `mex://${anchor.nodeId}`;
  const offset = link.indexOf(oldUri);
  if (offset < 0) throw new Error("mex anchor no longer matches the markdown content");

  const start = anchor.range.start + offset;
  return applyEdits(text, [
    { start, end: start + oldUri.length, text: `mex://${nodeId}`, label: `anchor ${anchor.nodeId}` },
  ]);
}

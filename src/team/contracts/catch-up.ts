import type {
  ActorRef,
  EntityRef,
  PageRequest,
  RepoState,
  Revision,
} from "./shared.js";

export type CatchUpGroup =
  | "needs_attention"
  | "workstreams"
  | "relays"
  | "knowledge_specs"
  | "code_changes"
  | "health";

export interface CatchUpItem {
  id: string;
  group: CatchUpGroup;
  occurredAt: string;
  title: string;
  summary: string;
  actor?: ActorRef;
  subjects: readonly EntityRef[];
}

export interface CatchUpRequest extends PageRequest {
  since?: string;
  workstreamId?: string;
  actor?: ActorRef;
}

export interface CatchUpDigest {
  baseline: string | null;
  repoState: RepoState;
  items: readonly CatchUpItem[];
  nextCursor: string | null;
  truncated: boolean;
  deterministicRevision: Revision;
}

export interface CatchUpCursor {
  scaffoldId: string;
  actor: ActorRef;
  head: string | null;
  /** Branch observed when the cursor was explicitly marked or reset. */
  branch: string | null;
  timestamp: string;
  revision: Revision;
}

/** Future aggregation seam. Workflow mutation remains outside Checkpoint B. */
export interface CatchUpPort {
  catchUp(request?: CatchUpRequest): Promise<CatchUpDigest>;
  getCatchUpCursor(actor: ActorRef): Promise<CatchUpCursor | null>;
}

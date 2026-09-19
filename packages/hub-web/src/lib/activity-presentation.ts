import {
  GraphSymbolIdSchema,
  InboxProposalIdSchema,
  RelayIdSchema,
  WikiEntityIdSchema,
} from "@mex/hub-contracts/ids";
import type {
  ActivityActor,
  ActivityItem,
  ActivitySubject,
} from "../api/types";

type CanonicalActivityItem = Extract<ActivityItem, { source: "activity" }>;

interface WorkflowNarration {
  action: string;
  headline: string;
}

export interface ActivityContextReference {
  label: string;
  subject: ActivitySubject | null;
}

const WORKFLOW_NARRATION: Readonly<Record<string, WorkflowNarration>> = {
  "inbox.publish": { action: "inbox.published", headline: "Proposed a Spec change" },
  "inbox.approve": { action: "inbox.approved", headline: "Approved and applied a Spec change" },
  "inbox.reject": { action: "inbox.rejected", headline: "Rejected a Spec change" },
  "inbox.withdraw": { action: "inbox.withdrawn", headline: "Withdrew a Spec change" },
  "inbox.mark-stale": { action: "inbox.marked-stale", headline: "Marked a Spec proposal stale" },
  "inbox.repair": { action: "inbox.repaired", headline: "Repaired a Spec proposal" },
  "relay.publish": { action: "relay.published", headline: "Published a handoff" },
  "relay.acknowledge": { action: "relay.acknowledged", headline: "Took a handoff" },
  "relay.close": { action: "relay.closed", headline: "Closed a handoff" },
  "member.add": { action: "member.added", headline: "Added a teammate" },
  "member.update": { action: "member.updated", headline: "Updated a teammate" },
  "member.deactivate": { action: "member.deactivated", headline: "Deactivated a teammate" },
  "member.reactivate": { action: "member.reactivated", headline: "Reactivated a teammate" },
  "workstream.create": { action: "workstream.created", headline: "Created a Workstream" },
  "workstream.update": { action: "workstream.updated", headline: "Updated a Workstream" },
  "workstream.archive": { action: "workstream.archived", headline: "Archived a Workstream" },
};

export function humanizeActivityIdentifier(value: string): string {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export function activityProjectNoteKind(value: string): string {
  if (["decision", "risk", "note", "todo"].includes(value)) {
    return humanizeActivityIdentifier(value);
  }
  return "Project note";
}

export function activityActorLabel(actor: ActivityActor, technical = false): string {
  if (actor.kind === "member") {
    if (technical) {
      return actor.displayName
        ? `${actor.displayName} (${actor.memberId})`
        : actor.memberId;
    }
    return actor.displayName ?? "Recorded team member";
  }
  if (actor.kind === "git") {
    if (technical) {
      return [actor.name, actor.email].filter((value): value is string => value !== null).join(" · ");
    }
    return actor.name ?? actor.email ?? "Recorded Git identity";
  }
  return technical ? "Unknown actor" : "Actor not recorded";
}

export function sameActivityActor(left: ActivityActor, right: ActivityActor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unknown" || right.kind === "unknown") return true;
  if (left.kind === "member" && right.kind === "member") {
    return left.memberId === right.memberId && left.displayName === right.displayName;
  }
  if (left.kind === "git" && right.kind === "git") {
    return left.name === right.name && left.email === right.email;
  }
  return false;
}

export function verifiedActivityWorkflowNarration(
  item: CanonicalActivityItem,
): (WorkflowNarration & { operation: string }) | null {
  if (item.recordOrigin.kind !== "workflow") return null;
  const narration = WORKFLOW_NARRATION[item.recordOrigin.operation];
  if (narration === undefined || narration.action !== item.action) return null;
  return { ...narration, operation: item.recordOrigin.operation };
}

export function activityHeadline(item: ActivityItem): string {
  if (item.source === "legacy") {
    return item.message || `${activityProjectNoteKind(item.action)} recorded`;
  }
  return verifiedActivityWorkflowNarration(item)?.headline ?? `Recorded “${item.action}”`;
}

export function activitySubjectRawValue(subject: ActivitySubject): string {
  if (subject.kind === "entity") return subject.entity.id;
  if (subject.kind === "symbol") return subject.symbolId;
  if (subject.kind === "file") return subject.path;
  return subject.hash;
}

export function activitySubjectLabel(subject: ActivitySubject): string {
  if (subject.kind === "entity") {
    return subject.entity.title ?? humanizeActivityIdentifier(subject.entity.entityKind);
  }
  if (subject.kind === "symbol") return subject.symbolId;
  if (subject.kind === "file") return subject.path;
  return subject.hash.slice(0, 12);
}

export function activitySubjectKindLabel(subject: ActivitySubject): string {
  if (subject.kind === "entity") return humanizeActivityIdentifier(subject.entity.entityKind);
  if (subject.kind === "symbol") return "Code symbol";
  if (subject.kind === "file") return "File";
  return "Commit reference";
}

export function activitySubjectRoute(subject: ActivitySubject, item: ActivityItem): string | null {
  if (subject.kind === "symbol") {
    const parsed = GraphSymbolIdSchema.safeParse(subject.symbolId);
    return parsed.success
      ? `/code/symbols/${encodeURIComponent(parsed.data)}?view=overview`
      : null;
  }
  if (subject.kind !== "entity") return null;

  const { entity } = subject;
  if (entity.entityKind === "proposal") {
    const parsed = InboxProposalIdSchema.safeParse(entity.id);
    return parsed.success
      ? `/inbox?view=review&proposal=${encodeURIComponent(parsed.data)}`
      : null;
  }
  if (entity.entityKind === "relay") {
    const parsed = RelayIdSchema.safeParse(entity.id);
    if (!parsed.success || item.source !== "activity") return null;
    const operation = verifiedActivityWorkflowNarration(item)?.operation;
    return operation === "relay.close"
      ? `/relays?view=all&state=closed&relay=${encodeURIComponent(parsed.data)}`
      : null;
  }

  const parsed = WikiEntityIdSchema.safeParse(entity.id);
  if (!parsed.success) return null;
  return entity.entityKind === "spec"
    ? `/specs/${encodeURIComponent(parsed.data)}`
    : `/knowledge/${encodeURIComponent(parsed.data)}`;
}

export function activityPrimaryContext(item: ActivityItem): ActivityContextReference | null {
  const titledEntity = item.subjects.find((subject) => (
    subject.kind === "entity" && subject.entity.title !== null
  ));
  if (item.source === "activity" && item.label) {
    return {
      label: item.label,
      subject: item.subjects.find((subject) => subject.kind === "entity") ?? titledEntity ?? null,
    };
  }
  if (titledEntity) return { label: activitySubjectLabel(titledEntity), subject: titledEntity };
  const contextual = item.subjects.find((subject) => subject.kind === "symbol" || subject.kind === "file");
  return contextual ? { label: activitySubjectLabel(contextual), subject: contextual } : null;
}

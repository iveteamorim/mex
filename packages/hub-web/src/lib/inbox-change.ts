import type { InboxDraftInput, InboxKnowledgeKind } from "../api/types";

export const inboxKnowledgeKinds: readonly InboxKnowledgeKind[] = [
  "architecture", "component", "convention", "decision", "pattern", "guide",
];

export type InboxCreateChange = Extract<InboxDraftInput["change"], { kind: "spec.create" | "knowledge.create" }>;
export type InboxUpdateChange = Extract<InboxDraftInput["change"], { kind: "spec.update" | "knowledge.update" }>;

export function isInboxCreate(change: InboxDraftInput["change"] | undefined): change is InboxCreateChange {
  return change?.kind === "spec.create" || change?.kind === "knowledge.create";
}

export function isInboxUpdate(change: InboxDraftInput["change"] | undefined): change is InboxUpdateChange {
  return change?.kind === "spec.update" || change?.kind === "knowledge.update";
}

export function isInboxKnowledgeKind(kind: string): kind is InboxKnowledgeKind {
  return inboxKnowledgeKinds.some((candidate) => candidate === kind);
}

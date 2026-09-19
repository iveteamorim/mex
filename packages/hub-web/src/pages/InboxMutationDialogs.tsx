import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Code2,
  FileDiff,
  FilePenLine,
  FileText,
  GitCommitHorizontal,
  LibraryBig,
  MapPin,
  RefreshCw,
  Send,
  ShieldCheck,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { GraphSymbolIdSchema, WikiEntityIdSchema } from "@mex/hub-contracts";
import { useHubApi } from "../api/context";
import type {
  InboxDraftDetail,
  InboxDraftInput,
  InboxEvidenceRef,
  InboxOperationApplyResponse,
  InboxOperationPreviewRequest,
  InboxOperationPreviewResponse,
  InboxProposalDetail,
  InboxSpecKind,
  InboxEntityKind,
  InboxKnowledgeKind,
  TeamActorRef,
} from "../api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/primitives/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../components/primitives/field";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Textarea } from "../components/primitives/textarea";
import { ErrorState, StatePanel, StatusPill, formatDate, sentenceCase } from "../components/ui";
import styles from "../styles/inbox-mutations.module.css";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import { inboxKnowledgeKinds, isInboxCreate, isInboxUpdate, isInboxKnowledgeKind } from "../lib/inbox-change";

type CreateChange = Extract<InboxDraftInput["change"], { kind: "spec.create" }>;
type CreateRelation = NonNullable<CreateChange["relation"]>;
type RelationType = CreateRelation["type"] | "none";
interface TopicAttestation {
  id: string;
  revision: string;
  semanticRevision: number;
}
export type ReviewAction =
  | { kind: "inbox.publish"; draft: InboxDraftDetail }
  | { kind: "inbox.draft.delete"; draft: InboxDraftDetail }
  | { kind: "inbox.approve"; proposal: InboxProposalDetail; selfApproval?: boolean }
  | { kind: "inbox.reject"; proposal: InboxProposalDetail }
  | { kind: "inbox.withdraw"; proposal: InboxProposalDetail }
  | { kind: "inbox.mark-stale"; proposal: InboxProposalDetail }
  | { kind: "inbox.repair"; proposal: InboxProposalDetail };
type SimpleReviewAction = Exclude<ReviewAction, { kind: "inbox.repair" }>;
type ApprovalAction = Extract<ReviewAction, { kind: "inbox.approve" }>;
type SupportingReviewAction = Exclude<SimpleReviewAction, ApprovalAction>;
type DraftBoundaryAction = Extract<SupportingReviewAction, { kind: "inbox.publish" | "inbox.draft.delete" }>;
type ProposalSupportingAction = Exclude<SupportingReviewAction, DraftBoundaryAction>;
export type AppliedInboxAction = ReviewAction["kind"] | "inbox.draft.save";

const specKinds: readonly InboxSpecKind[] = [
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
];

function MutationAlert({
  children,
  variant = "default",
}: {
  children: ReactNode;
  variant?: "default" | "destructive";
}) {
  return (
    <div
      className={styles.operationAlert}
      data-variant={variant}
      role="alert"
    >
      {children}
    </div>
  );
}

function MutationAlertTitle({ children }: { children: ReactNode }) {
  return <div className={styles.operationAlertTitle}>{children}</div>;
}

function MutationAlertDescription({ children }: { children: ReactNode }) {
  return <div className={styles.operationAlertDescription}>{children}</div>;
}

function MutationDisclosure({
  children,
  className,
  contentClassName,
  label,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className} data-slot="collapsible">
      <Button
        aria-expanded={open}
        data-slot="collapsible-trigger"
        onClick={() => setOpen((current) => !current)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ChevronDown data-icon="inline-start" /> {label}
      </Button>
      {open ? (
        <div className={contentClassName} data-slot="collapsible-content">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function afterDialogUnmount(callback: () => void): void {
  queueMicrotask(() => queueMicrotask(callback));
}

function actorLabel(actor: TeamActorRef): string {
  if (actor.kind === "member") return actor.displayName ?? "Team member";
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown identity";
}

function changeLabel(
  changeKind: InboxDraftDetail["changeKind"],
  entityKind: InboxEntityKind,
): string {
  const label = entityKind === "spec" ? "Spec" : entityKind.replaceAll("_", " ");
  return `${changeKind.endsWith(".create") ? "New" : "Update"} ${label}`;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalText(value: string, maximumBytes: number, required: boolean): boolean {
  return new TextEncoder().encode(value).byteLength <= maximumBytes
    && value.normalize("NFC") === value
    && !hasLoneSurrogate(value)
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    && (!required || value.trim().length > 0);
}

function operationId(label: string): string {
  return `hub_inbox_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function draftExpectation(draft: InboxDraftDetail) {
  return {
    target: { kind: "local" as const, namespace: "inbox-draft" as const, id: draft.id },
    revision: draft.revision,
  };
}

function proposalExpectation(proposal: InboxProposalDetail) {
  return {
    target: { kind: "artifact" as const, path: proposal.sourcePath },
    revision: proposal.revision,
  };
}

function parseTopicAttestations(value: string): {
  items: TopicAttestation[];
  error: string | null;
} {
  if (value.trim() === "") return { items: [], error: null };
  const rows = value.split("\n").filter((row) => row.trim() !== "");
  if (rows.length > 64) return { items: [], error: "Use no more than 64 topic attestations." };
  const items: TopicAttestation[] = [];
  for (const row of rows) {
    const [id, revision, semantic, ...extra] = row.split("|").map((item) => item.trim());
    const semanticRevision = Number(semantic);
    if (
      extra.length > 0
      || !id
      || !/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)
      || !revision
      || !/^[a-f0-9]{64}$/.test(revision)
      || !Number.isInteger(semanticRevision)
      || semanticRevision <= 0
    ) {
      return { items: [], error: "Each topic line must be: mx ID | 64-character file revision | positive semantic revision." };
    }
    items.push({ id, revision, semanticRevision });
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    return { items: [], error: "Each topic endpoint must appear once." };
  }
  return { items, error: null };
}

function relationAccepted(
  sourceKind: InboxSpecKind,
  relationType: RelationType,
  targetKind: InboxSpecKind,
): boolean {
  if (relationType === "none") return true;
  if (relationType === "derived_from") return sourceKind === "requirement" && targetKind === "spec";
  if (relationType === "verified_by") {
    return sourceKind === "acceptance_criterion"
      && (targetKind === "spec" || targetKind === "requirement");
  }
  if (relationType === "refines") return sourceKind === "requirement" && targetKind === "requirement";
  return targetKind === "constraint";
}

function buildCreateRelation(
  relationType: RelationType,
  targetId: string,
  targetKind: InboxSpecKind,
  targetTitle: string,
): CreateRelation | undefined {
  if (relationType === "none") return undefined;
  const title = targetTitle === "" ? {} : { title: targetTitle };
  if (relationType === "derived_from" && targetKind === "spec") {
    return { type: "derived_from", target: { id: targetId, kind: "spec", ...title } };
  }
  if (relationType === "verified_by" && (targetKind === "spec" || targetKind === "requirement")) {
    return { type: "verified_by", target: { id: targetId, kind: targetKind, ...title } };
  }
  if (relationType === "constrained_by" && targetKind === "constraint") {
    return { type: "constrained_by", target: { id: targetId, kind: "constraint", ...title } };
  }
  if (relationType === "refines" && targetKind === "requirement") {
    return { type: "refines", target: { id: targetId, kind: "requirement", ...title } };
  }
  return undefined;
}

function PreviewDocket({ envelope }: { envelope: InboxOperationPreviewResponse }) {
  return (
    <section className={styles.previewDocket}>
      <header className={styles.previewHeader}>
        <div>
          <p>Exact review envelope</p>
          <h3>Exact preview</h3>
        </div>
        <StatusPill tone={envelope.preview.valid ? "success" : "danger"}>
          {envelope.preview.valid ? "Ready for review" : "Invalid"}
        </StatusPill>
      </header>
      <dl className={styles.authorityGrid}>
        <div><dt>Actor</dt><dd>{actorLabel(envelope.receipt.authority.actor)}</dd></div>
        <div><dt>Captured</dt><dd>{formatDate(envelope.receipt.authority.occurredAt)}</dd></div>
        <div><dt>Branch</dt><dd>{envelope.receipt.authority.repoState.branch ?? "Detached HEAD"}</dd></div>
        <div>
          <dt>HEAD</dt>
          <dd><code>{envelope.receipt.authority.repoState.head ?? "Unborn HEAD"}</code></dd>
        </div>
        <div><dt>Worktree</dt><dd>{envelope.receipt.authority.repoState.dirty ? "Dirty · local changes" : "Clean"}</dd></div>
        <div><dt>Repository observed</dt><dd>{formatDate(envelope.receipt.authority.repoState.observedAt)}</dd></div>
        <div><dt>Scope</dt><dd>{sentenceCase(envelope.preview.scope)}</dd></div>
      </dl>
      <div className={styles.digestStrip}>
        <span>Preview digest</span>
        <code>{envelope.receipt.previewRevision}</code>
      </div>
      {envelope.preview.changes.map((change) => (
        <article className={styles.fileChange} key={`${change.kind}:${change.path}`}>
          <header>
            <FileDiff aria-hidden="true" />
            <strong>{change.path}</strong>
            <StatusPill>{change.kind}</StatusPill>
          </header>
          <pre aria-label={`Exact diff for ${change.path}`}><code>{change.diff}</code></pre>
          <footer>
            <code>{change.beforeRevision?.slice(0, 10) ?? "new"}</code>
            <span aria-hidden="true">→</span>
            <code>{change.afterRevision?.slice(0, 10) ?? "removed"}</code>
          </footer>
        </article>
      ))}
      {envelope.preview.localChanges.map((change) => (
        <article className={styles.localChange} key={`${change.namespace}:${change.id}`}>
          <MapPin aria-hidden="true" />
          <div><strong>Checkout-local only</strong><p>{change.summary}</p><code>{change.id}</code></div>
        </article>
      ))}
      {envelope.preview.diagnostics.length > 0 ? (
        <div className={styles.diagnostics} role="status">
          <AlertTriangle aria-hidden="true" />
          <span>{envelope.preview.diagnostics.map((item) => item.message).join(" ")}</span>
        </div>
      ) : (
        <p className={styles.boundEnvelope}><ShieldCheck aria-hidden="true" /> Apply accepts only this complete signed envelope.</p>
      )}
    </section>
  );
}

function ExactPreviewDetails({ envelope }: { envelope: InboxOperationPreviewResponse }) {
  return (
    <MutationDisclosure className={styles.exactPreviewDetails} label="Exact technical details">
      <PreviewDocket envelope={envelope} />
    </MutationDisclosure>
  );
}

function KnowledgeTargetPicker({ kind, targetId, targetTitle, busy, onSelect }: {
  kind: InboxKnowledgeKind;
  targetId: string;
  targetTitle: string;
  busy: boolean;
  onSelect(id: string): void;
}) {
  const api = useHubApi();
  const records = useInfiniteQuery({
    queryKey: ["inbox", "knowledge-targets", kind],
    queryFn: ({ pageParam }) => api.listWikiEntities({ kind, limit: 25, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page, pages) => boundedNextCursor(page.nextCursor, pages.length),
    retry: false,
  });
  const rows = records.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Field>
      <FieldLabel htmlFor="draft-knowledge-target">Knowledge to update</FieldLabel>
      <NativeSelect id="draft-knowledge-target" value={targetId} disabled={busy || records.isPending}
        onChange={(event) => onSelect(event.currentTarget.value)}>
        <NativeSelectOption value="">{records.isPending ? "Loading knowledge…" : "Choose a record"}</NativeSelectOption>
        {targetId && !rows.some((row) => row.id === targetId)
          ? <NativeSelectOption value={targetId}>{targetTitle || targetId}</NativeSelectOption> : null}
        {rows.map((row) => <NativeSelectOption value={row.id} key={row.id}>{row.title}</NativeSelectOption>)}
      </NativeSelect>
      {records.isError ? <FieldError>Knowledge could not be loaded. <Button size="sm" type="button" variant="ghost" onClick={() => void records.refetch()}>Try again</Button></FieldError> : null}
      {records.hasNextPage ? <Button size="sm" type="button" variant="outline" disabled={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>Load more knowledge</Button> : null}
      {(records.data?.pages.length ?? 0) >= MAX_WORKBENCH_PAGES && records.data?.pages.at(-1)?.nextCursor
        ? <FieldDescription>This picker reached its page limit. Open Context to find the record.</FieldDescription> : null}
      {targetId ? <FieldDescription>
        <Link to={`/knowledge/${encodeURIComponent(targetId)}`} target="_blank" rel="noreferrer">Open current record</Link>
        {" · "}<Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => onSelect(targetId)}>Use current version</Button>
      </FieldDescription> : <FieldDescription>Select a record to load its current wording.</FieldDescription>}
    </Field>
  );
}

function DraftEditorDialog({
  draft,
  repair,
  finalFocus,
  focusAppliedStatus,
  onClose,
  onApplied,
}: {
  draft: InboxDraftDetail | null;
  repair: InboxProposalDetail | null;
  finalFocus(): HTMLElement | null;
  focusAppliedStatus(): void;
  onClose(): void;
  onApplied(kind: AppliedInboxAction, result: InboxOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const changeTypeRef = useRef<HTMLSelectElement>(null);
  const entityKindRef = useRef<HTMLSelectElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const isRepair = repair !== null;
  const sourceInput: InboxDraftInput | undefined = draft?.input ?? (repair === null
    ? undefined
    : {
        change: repair.change,
        rationale: repair.rationale,
        evidence: repair.evidence,
        targetRevisions: repair.targetRevisions,
      });
  const existingChange = sourceInput?.change;
  const legacy = existingChange?.kind.startsWith("spec.") ?? false;
  const subject = legacy ? "Spec" : "knowledge";
  const existingExpectations = new Map(
    (sourceInput?.targetRevisions ?? []).map((item) => [item.target.id, item]),
  );
  const existingRelation = existingChange?.kind === "spec.create"
    ? existingChange.relation
    : undefined;
  const existingRelationExpectation = existingRelation === undefined
    ? undefined
    : existingExpectations.get(existingRelation.target.id);
  const [mode, setMode] = useState<"create" | "update">(
    isInboxUpdate(existingChange) ? "update" : "create",
  );
  const [includeTitle, setIncludeTitle] = useState(
    isInboxUpdate(existingChange)
      ? Object.hasOwn(existingChange.patch, "title")
      : false,
  );
  const [includeSummary, setIncludeSummary] = useState(
    isInboxUpdate(existingChange)
      ? Object.hasOwn(existingChange.patch, "summary")
      : false,
  );
  const [includeBody, setIncludeBody] = useState(
    isInboxUpdate(existingChange)
      ? Object.hasOwn(existingChange.patch, "body")
      : true,
  );
  const [entityKind, setEntityKind] = useState<InboxEntityKind>(
    isInboxCreate(existingChange) ? existingChange.entityKind : "pattern",
  );
  const [title, setTitle] = useState(
    isInboxCreate(existingChange)
      ? existingChange.title
      : existingChange?.patch.title ?? "",
  );
  const [summary, setSummary] = useState(
    isInboxCreate(existingChange)
      ? existingChange.summary ?? ""
      : existingChange?.patch.summary ?? "",
  );
  const [body, setBody] = useState(
    isInboxCreate(existingChange)
      ? existingChange.body
      : existingChange?.patch.body ?? "",
  );
  const [status, setStatus] = useState<"in_flight" | "promoted">(
    isInboxCreate(existingChange) ? existingChange.status : "in_flight",
  );
  const [topicsText, setTopicsText] = useState(
    isInboxCreate(existingChange)
      ? (existingChange.topics ?? []).map((id) => {
          const expectation = existingExpectations.get(id);
          return expectation === undefined
            ? `${id} | |`
            : `${id} | ${expectation.revision} | ${expectation.semanticRevision}`;
        }).join("\n")
      : "",
  );
  const [relationType, setRelationType] = useState<RelationType>(
    existingRelation?.type ?? "none",
  );
  const [relationTargetId, setRelationTargetId] = useState(existingRelation?.target.id ?? "");
  const [relationTargetKind, setRelationTargetKind] = useState<InboxSpecKind>(
    existingRelation?.target.kind ?? "spec",
  );
  const [relationTargetTitle, setRelationTargetTitle] = useState(existingRelation?.target.title ?? "");
  const [relationRevision, setRelationRevision] = useState(existingRelationExpectation?.revision ?? "");
  const [relationSemanticRevision, setRelationSemanticRevision] = useState(
    existingRelationExpectation ? String(existingRelationExpectation.semanticRevision) : "",
  );
  const [targetId, setTargetId] = useState(
    isInboxUpdate(existingChange) ? existingChange.target.id : "",
  );
  const [targetKind, setTargetKind] = useState<InboxEntityKind>(
    isInboxUpdate(existingChange) ? existingChange.target.kind : "pattern",
  );
  const [targetTitle, setTargetTitle] = useState(
    isInboxUpdate(existingChange) ? existingChange.target.title ?? "" : "",
  );
  const existingTarget = isInboxUpdate(existingChange)
    ? existingExpectations.get(existingChange.target.id)
    : undefined;
  const [targetRevision, setTargetRevision] = useState(existingTarget?.revision ?? "");
  const [semanticRevision, setSemanticRevision] = useState(
    existingTarget ? String(existingTarget.semanticRevision) : "",
  );
  const [rationale, setRationale] = useState(sourceInput?.rationale ?? "");
  const preservedEvidence = sourceInput?.evidence ?? [];
  const [evidenceNote, setEvidenceNote] = useState("");
  const [targetNotice, setTargetNotice] = useState("");
  const [envelope, setEnvelope] = useState<InboxOperationPreviewResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  const applySucceeded = useRef(false);
  const previewGeneration = useRef(0);
  const targetGeneration = useRef(0);
  const targetLookup = useMutation({
    mutationFn: ({ id }: { id: string; generation: number }) => api.getWikiEntity(id),
    onSuccess: (detail, { id, generation }) => {
      if (generation !== targetGeneration.current) return;
      if (detail.entity.id !== id || !isInboxKnowledgeKind(detail.entity.kind) || detail.entity.version.semanticRevision < 1) {
        setTargetNotice("This record is not available for a knowledge proposal.");
        return;
      }
      setTargetId(id);
      setTargetKind(detail.entity.kind);
      setTargetTitle(detail.entity.title);
      setTargetRevision(detail.entity.version.contentHash);
      setSemanticRevision(String(detail.entity.version.semanticRevision));
      const bodyFits = !detail.body.truncated && canonicalText(detail.body.content, 16 * 1024, true);
      if (!sourceInput) {
        setTitle(detail.entity.title);
        setSummary(detail.entity.summary ?? "");
        setBody(bodyFits ? detail.body.content : "");
        setIncludeBody(bodyFits);
      }
      setTargetNotice(bodyFits ? "Current record loaded. Only the selected fields will change." : "This body exceeds the editor limit. You can update its title or summary, or write a complete replacement body.");
      invalidate();
    },
  });
  const preview = useMutation({
    mutationFn: ({ request }: { request: InboxOperationPreviewRequest; generation: number }) => (
      api.previewInboxOperation(request)
    ),
    onSuccess: (nextEnvelope, { generation }) => {
      if (generation === previewGeneration.current) setEnvelope(nextEnvelope);
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (envelope === null) throw new Error("Preview is unavailable.");
      return api.applyInboxOperation(envelope);
    },
    onSuccess: async (result) => {
      applySucceeded.current = true;
      setConfirmOpen(false);
      await onApplied(isRepair ? "inbox.repair" : "inbox.draft.save", result);
      onClose();
      afterDialogUnmount(focusAppliedStatus);
    },
  });
  const localSave = useMutation({
    mutationFn: async () => {
      const generation = previewGeneration.current + 1;
      previewGeneration.current = generation;
      setEnvelope(null);
      const exactEnvelope = await api.previewInboxOperation(request());
      if (generation !== previewGeneration.current) {
        throw new Error("The draft changed while MEX was checking it. Review the latest wording and save again.");
      }
      setEnvelope(exactEnvelope);
      if (!exactEnvelope.preview.valid) {
        throw new Error("MEX could not produce a valid exact draft preview. No local changes were applied.");
      }
      return api.applyInboxOperation(exactEnvelope);
    },
    onSuccess: async (result) => {
      applySucceeded.current = true;
      await onApplied("inbox.draft.save", result);
      onClose();
      afterDialogUnmount(focusAppliedStatus);
    },
  });

  const invalidate = () => {
    previewGeneration.current += 1;
    setEnvelope(null);
    setConfirmOpen(false);
    preview.reset();
    apply.reset();
    if (!localSave.isPending) localSave.reset();
  };
  const startPreview = () => {
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    setEnvelope(null);
    setConfirmOpen(false);
    apply.reset();
    preview.mutate({ request: request(), generation });
  };
  const change = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    invalidate();
  };
  const selectKnowledgeTarget = (id: string) => {
    targetGeneration.current += 1;
    setTargetRevision("");
    setTargetNotice("");
    invalidate();
    if (!id) {
      setTargetId(""); setTargetTitle(""); targetLookup.reset();
      return;
    }
    targetLookup.mutate({ id, generation: targetGeneration.current });
  };
  const targetRevisionValid = /^[a-f0-9]{64}$/.test(targetRevision);
  const semanticRevisionNumber = Number(semanticRevision);
  const topicAttestations = parseTopicAttestations(topicsText);
  const relationSemanticRevisionNumber = Number(relationSemanticRevision);
  const relationIsValid = !legacy || relationType === "none" || (
    /^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(relationTargetId)
    && /^[a-f0-9]{64}$/.test(relationRevision)
    && Number.isInteger(relationSemanticRevisionNumber)
    && relationSemanticRevisionNumber > 0
    && canonicalText(relationTargetTitle, 512, false)
    && legacy && relationAccepted(entityKind as InboxSpecKind, relationType, relationTargetKind)
  );
  const createExpectationById = new Map<string, TopicAttestation>();
  let createExpectationConflict = false;
  for (const item of topicAttestations.items) createExpectationById.set(item.id, item);
  if (legacy && relationType !== "none" && relationIsValid) {
    const current = createExpectationById.get(relationTargetId);
    if (current !== undefined && (
      current.revision !== relationRevision
      || current.semanticRevision !== relationSemanticRevisionNumber
    )) {
      createExpectationConflict = true;
    } else {
      createExpectationById.set(relationTargetId, {
        id: relationTargetId,
        revision: relationRevision,
        semanticRevision: relationSemanticRevisionNumber,
      });
    }
  }
  const createTargetRevisions = [...createExpectationById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      target: { kind: "entity" as const, id: item.id },
      revision: item.revision,
      semanticRevision: item.semanticRevision,
    }));
  const updateHasPatch = includeTitle || includeSummary || includeBody;
  const canPreview = !targetLookup.isPending && canonicalText(rationale, 8 * 1024, true)
    && (mode === "create"
      ? canonicalText(body, 16 * 1024, true) && canonicalText(title, 512, true)
      : (!includeBody || canonicalText(body, 16 * 1024, true))
        && (!includeTitle || canonicalText(title, 512, true)))
    && (mode === "create" || includeSummary ? canonicalText(summary, 2 * 1024, false) : true)
    && canonicalText(evidenceNote, 4 * 1024, false)
    && (mode === "create" ? (
      topicAttestations.error === null
      && relationIsValid
      && !createExpectationConflict
    ) : (
      /^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(targetId)
      && targetRevisionValid
      && Number.isInteger(semanticRevisionNumber)
      && semanticRevisionNumber > 0
      && canonicalText(targetTitle, 512, false)
      && updateHasPatch
    ));

  const draftInput = (): InboxDraftInput => {
    const createFields = {
      title, body, ...(summary === "" ? {} : { summary }), status,
      ...(topicAttestations.items.length === 0 ? {} : { topics: topicAttestations.items.map((item) => item.id) }),
    };
    const patch = {
      ...(includeTitle ? { title } : {}),
      ...(includeSummary ? { summary } : {}),
      ...(includeBody ? { body } : {}),
    };
    const target = { id: targetId, ...(targetTitle === "" ? {} : { title: targetTitle }) };
    return {
      change: mode === "create"
        ? legacy
          ? { kind: "spec.create", entityKind: entityKind as InboxSpecKind, ...createFields,
              ...(relationType === "none" ? {} : {
                relation: buildCreateRelation(relationType, relationTargetId, relationTargetKind, relationTargetTitle)!,
              }) }
          : { kind: "knowledge.create", entityKind: entityKind as InboxKnowledgeKind, ...createFields }
        : legacy
          ? { kind: "spec.update", target: { ...target, kind: targetKind as InboxSpecKind }, patch }
          : { kind: "knowledge.update", target: { ...target, kind: targetKind as InboxKnowledgeKind }, patch },
      rationale,
      evidence: [...preservedEvidence, ...(evidenceNote === "" ? [] : [{ kind: "manual" as const, note: evidenceNote }])],
      targetRevisions: mode === "create" ? createTargetRevisions : [{
        target: { kind: "entity", id: targetId }, revision: targetRevision, semanticRevision: semanticRevisionNumber,
      }],
    };
  };

  const request = (): InboxOperationPreviewRequest => repair === null
    ? {
        operationId: operationId(draft === null ? "draft_create" : "draft_update"),
        action: {
          kind: "inbox.draft.save",
          ...(draft === null ? {} : { draftId: draft.id }),
          draft: draftInput(),
        },
        expectedRevisions: draft === null ? [] : [draftExpectation(draft)],
      }
    : {
        operationId: operationId("proposal_repair"),
        action: {
          kind: "inbox.repair",
          proposalId: repair.ref.id,
          replacement: draftInput(),
        },
        expectedRevisions: [proposalExpectation(repair)],
      };

  const editorTitle = isRepair
    ? "Repair proposal manually"
    : draft === null ? "Create local knowledge draft" : `Edit local ${subject} draft`;
  const previewLabel = isRepair ? "Review repaired proposal" : "Preview local draft";
  const wordingInitialFocusRef = mode === "create" || includeTitle
    ? titleRef
    : includeSummary ? summaryRef : bodyRef;

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !apply.isPending && !localSave.isPending) {
        onClose();
        afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
      }
    }}>
      <DialogContent
        className={styles.editorDialog}
        finalFocus={false}
        initialFocus={draft === null && !isRepair
          ? changeTypeRef
          : isRepair ? entityKindRef : wordingInitialFocusRef}
      >
        <DialogHeader>
          <DialogTitle>{editorTitle}</DialogTitle>
          <DialogDescription>
            {isRepair
              ? `Update this proposal against current ${subject} content. Repair returns it to teammate review without changing project knowledge.`
              : "This draft stays private to this checkout. Saving does not publish a proposal or change project knowledge."}
          </DialogDescription>
        </DialogHeader>
        <div className={styles.dialogScroll}>
          <FieldGroup>
            <div className={styles.formPair}>
              <Field>
                <FieldLabel htmlFor="draft-change-kind">Change type</FieldLabel>
                <NativeSelect
                  className={styles.select}
                  disabled={draft !== null || isRepair}
                  id="draft-change-kind"
                  onChange={(event) => {
                    targetGeneration.current += 1;
                    targetLookup.reset();
                    change(setMode, event.currentTarget.value as "create" | "update");
                  }}
                  ref={changeTypeRef}
                  value={mode}
                >
                  <NativeSelectOption value="create">Create knowledge</NativeSelectOption>
                  <NativeSelectOption value="update">Update knowledge</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="draft-entity-kind">{legacy ? "Spec kind" : "Knowledge kind"}</FieldLabel>
                <NativeSelect
                  className={styles.select}
                  id="draft-entity-kind"
                  onChange={(event) => {
                    change(mode === "create" ? setEntityKind : setTargetKind, event.currentTarget.value as InboxEntityKind);
                    if (mode === "update" && !legacy) {
                      targetGeneration.current += 1;
                      targetLookup.reset();
                      setTargetId(""); setTargetTitle(""); setTargetRevision(""); setTargetNotice("");
                    }
                  }}
                  ref={entityKindRef}
                  value={mode === "create" ? entityKind : targetKind}
                >
                  {(legacy ? specKinds : inboxKnowledgeKinds).map((kind) => (
                    <NativeSelectOption key={kind} value={kind}>{sentenceCase(kind)}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {mode === "update" && !legacy && isInboxKnowledgeKind(targetKind) ? <>
              <KnowledgeTargetPicker kind={targetKind} targetId={targetId} targetTitle={targetTitle}
                busy={targetLookup.isPending} onSelect={selectKnowledgeTarget} />
              {targetLookup.isError ? <FieldError>The current record could not be read. Choose it again to retry.</FieldError> : null}
              {targetNotice ? <FieldDescription role="status">{targetNotice}</FieldDescription> : null}
            </> : null}
            {mode === "update" ? (
              <Field>
                <FieldLabel>Included patch fields</FieldLabel>
                <div aria-label={`Included ${subject} update fields`} className={styles.patchToggles} role="group">
                  <Button
                    aria-pressed={includeTitle}
                    disabled={targetLookup.isPending}
                    onClick={() => change(setIncludeTitle, !includeTitle)}
                    size="sm"
                    type="button"
                    variant={includeTitle ? "secondary" : "outline"}
                  >
                    Title
                  </Button>
                  <Button
                    aria-pressed={includeSummary}
                    disabled={targetLookup.isPending}
                    onClick={() => change(setIncludeSummary, !includeSummary)}
                    size="sm"
                    type="button"
                    variant={includeSummary ? "secondary" : "outline"}
                  >
                    Summary
                  </Button>
                  <Button
                    aria-pressed={includeBody}
                    disabled={targetLookup.isPending}
                    onClick={() => change(setIncludeBody, !includeBody)}
                    size="sm"
                    type="button"
                    variant={includeBody ? "secondary" : "outline"}
                  >
                    Body
                  </Button>
                </div>
                <FieldDescription>Select at least one exact field. A selected empty summary explicitly clears it.</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="draft-title">{mode === "create" ? "Title" : "Replacement title (optional)"}</FieldLabel>
              <Input disabled={targetLookup.isPending || (mode === "update" && !includeTitle)} id="draft-title" maxLength={512} onChange={(event) => change(setTitle, event.currentTarget.value)} ref={titleRef} value={title} />
            </Field>
            <Field>
              <FieldLabel htmlFor="draft-summary">{mode === "create" ? "Summary (optional)" : "Replacement summary"}</FieldLabel>
              <Textarea disabled={targetLookup.isPending || (mode === "update" && !includeSummary)} id="draft-summary" maxLength={2 * 1024} onChange={(event) => change(setSummary, event.currentTarget.value)} ref={summaryRef} rows={3} value={summary} />
              {mode === "update" && includeSummary ? <FieldDescription>Leave empty to remove the current summary.</FieldDescription> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="draft-body">{mode === "create" ? `${legacy ? "Spec" : "Knowledge"} body` : "Replacement body"}</FieldLabel>
              <Textarea disabled={targetLookup.isPending || (mode === "update" && !includeBody)} id="draft-body" maxLength={16 * 1024} onChange={(event) => change(setBody, event.currentTarget.value)} ref={bodyRef} rows={8} value={body} />
              <FieldDescription>Tabs and line breaks are preserved.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="draft-rationale">Rationale</FieldLabel>
              <Textarea id="draft-rationale" maxLength={8 * 1024} onChange={(event) => change(setRationale, event.currentTarget.value)} rows={4} value={rationale} />
            </Field>
            {preservedEvidence.length > 0 ? (
              <Field>
                <FieldLabel>Existing evidence (preserved)</FieldLabel>
                <EvidenceList evidence={preservedEvidence} />
                <FieldDescription>{isRepair
                  ? "The replacement preserves every existing typed reference; add fresh manual evidence below."
                  : "Editing this draft keeps every typed evidence reference unchanged."}</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="draft-evidence">Additional manual evidence (optional)</FieldLabel>
              <Textarea id="draft-evidence" maxLength={4 * 1024} onChange={(event) => change(setEvidenceNote, event.currentTarget.value)} rows={3} value={evidenceNote} />
            </Field>
            <MutationDisclosure
              className={styles.advancedEditor}
              contentClassName={styles.advancedEditorContent}
              label="Advanced"
            >
                {mode === "update" ? (legacy ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="draft-target-id">Canonical Spec ID</FieldLabel>
                      <Input id="draft-target-id" onChange={(event) => change(setTargetId, event.currentTarget.value)} value={targetId} />
                      <FieldDescription>The exact mx ID being updated.</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="draft-target-title">Current title (optional)</FieldLabel>
                      <Input id="draft-target-title" maxLength={512} onChange={(event) => change(setTargetTitle, event.currentTarget.value)} value={targetTitle} />
                    </Field>
                    <div className={styles.formPair}>
                      <Field>
                        <FieldLabel htmlFor="draft-content-revision">Exact file revision</FieldLabel>
                        <Input className={styles.monoInput} id="draft-content-revision" onChange={(event) => change(setTargetRevision, event.currentTarget.value)} value={targetRevision} />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="draft-semantic-revision">Semantic revision</FieldLabel>
                        <Input id="draft-semantic-revision" min={1} onChange={(event) => change(setSemanticRevision, event.currentTarget.value)} type="number" value={semanticRevision} />
                      </Field>
                    </div>
                  </>
                ) : <p>The selected record supplies the exact file and semantic revisions.</p>) : (
                  <>
                    <Field>
                      <FieldLabel htmlFor="draft-status">Initial lifecycle</FieldLabel>
                      <NativeSelect className={styles.select} id="draft-status" onChange={(event) => change(setStatus, event.currentTarget.value as "in_flight" | "promoted")} value={status}>
                        <NativeSelectOption value="in_flight">In flight</NativeSelectOption>
                        <NativeSelectOption value="promoted">Promoted</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    <Field data-invalid={topicAttestations.error !== null || undefined}>
                      <FieldLabel htmlFor="draft-topics">Topic endpoint attestations (optional)</FieldLabel>
                      <Textarea
                        className={styles.monoInput}
                        id="draft-topics"
                        onChange={(event) => change(setTopicsText, event.currentTarget.value)}
                        placeholder="mx_… | 64-character file revision | semantic revision"
                        rows={3}
                        value={topicsText}
                      />
                      <FieldDescription>One typed topic per line. Every endpoint carries its exact file and semantic revision.</FieldDescription>
                      {topicAttestations.error ? <FieldError>{topicAttestations.error}</FieldError> : null}
                    </Field>
                    {legacy ? <Field>
                      <FieldLabel htmlFor="draft-relation-type">One hierarchy relation (optional)</FieldLabel>
                      <NativeSelect
                        className={styles.select}
                        id="draft-relation-type"
                        onChange={(event) => {
                          const next = event.currentTarget.value as RelationType;
                          setRelationType(next);
                          if (next === "derived_from") setRelationTargetKind("spec");
                          if (next === "verified_by") setRelationTargetKind("requirement");
                          if (next === "constrained_by") setRelationTargetKind("constraint");
                          if (next === "refines") setRelationTargetKind("requirement");
                          invalidate();
                        }}
                        value={relationType}
                      >
                        <NativeSelectOption value="none">No relation</NativeSelectOption>
                        <NativeSelectOption value="derived_from">Derived from</NativeSelectOption>
                        <NativeSelectOption value="verified_by">Verifies</NativeSelectOption>
                        <NativeSelectOption value="constrained_by">Constrained by</NativeSelectOption>
                        <NativeSelectOption value="refines">Refines</NativeSelectOption>
                      </NativeSelect>
                    </Field> : null}
                    {legacy && relationType !== "none" ? (
                      <div className={styles.attestationBlock}>
                        <div className={styles.formPair}>
                          <Field>
                            <FieldLabel htmlFor="draft-relation-target-id">Relation endpoint ID</FieldLabel>
                            <Input id="draft-relation-target-id" onChange={(event) => change(setRelationTargetId, event.currentTarget.value)} value={relationTargetId} />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="draft-relation-target-kind">Endpoint kind</FieldLabel>
                            <NativeSelect className={styles.select} id="draft-relation-target-kind" onChange={(event) => change(setRelationTargetKind, event.currentTarget.value as InboxSpecKind)} value={relationTargetKind}>
                              {specKinds.map((kind) => <NativeSelectOption key={kind} value={kind}>{sentenceCase(kind)}</NativeSelectOption>)}
                            </NativeSelect>
                          </Field>
                        </div>
                        <Field>
                          <FieldLabel htmlFor="draft-relation-target-title">Endpoint title (optional)</FieldLabel>
                          <Input id="draft-relation-target-title" maxLength={512} onChange={(event) => change(setRelationTargetTitle, event.currentTarget.value)} value={relationTargetTitle} />
                        </Field>
                        <div className={styles.formPair}>
                          <Field>
                            <FieldLabel htmlFor="draft-relation-revision">Endpoint file revision</FieldLabel>
                            <Input className={styles.monoInput} id="draft-relation-revision" onChange={(event) => change(setRelationRevision, event.currentTarget.value)} value={relationRevision} />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="draft-relation-semantic-revision">Endpoint semantic revision</FieldLabel>
                            <Input id="draft-relation-semantic-revision" min={1} onChange={(event) => change(setRelationSemanticRevision, event.currentTarget.value)} type="number" value={relationSemanticRevision} />
                          </Field>
                        </div>
                        {!relationIsValid ? <FieldError>The hierarchy direction, endpoint kind, ID, and exact revisions must form one valid typed relation.</FieldError> : null}
                        {createExpectationConflict ? <FieldError>A topic and relation may share an endpoint only when their exact revisions agree.</FieldError> : null}
                      </div>
                    ) : null}
                  </>
                )}
            </MutationDisclosure>
            {!canPreview ? <FieldError>Complete the required fields and any needed advanced references before saving.</FieldError> : null}
          </FieldGroup>
          {isRepair && preview.isError ? <ErrorState error={preview.error} /> : null}
          {!isRepair && localSave.isError ? <ErrorState error={localSave.error} /> : null}
          {envelope && !envelope.preview.valid ? (
            <MutationAlert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <MutationAlertTitle>This operation is not ready to apply</MutationAlertTitle>
              <MutationAlertDescription>No changes were applied. Review the exact diagnostics below, then try again.</MutationAlertDescription>
            </MutationAlert>
          ) : null}
          {envelope ? <ExactPreviewDetails envelope={envelope} /> : null}
        </div>
        <DialogFooter>
          <Button
            disabled={apply.isPending || localSave.isPending}
            onClick={() => {
              onClose();
              afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          {!isRepair ? (
            <Button disabled={!canPreview || localSave.isPending} onClick={() => localSave.mutate()} type="button">
              <ShieldCheck data-icon="inline-start" /> {localSave.isPending ? "Saving…" : "Save draft"}
            </Button>
          ) : envelope === null ? (
            <Button disabled={!canPreview || preview.isPending} onClick={startPreview} type="button">
              <FileDiff data-icon="inline-start" /> {preview.isPending ? "Preparing…" : previewLabel}
            </Button>
          ) : !envelope.preview.valid ? (
            <Button disabled={!canPreview || preview.isPending} onClick={startPreview} type="button" variant="outline">
              <RefreshCw data-icon="inline-start" /> Try preview again
            </Button>
          ) : (
            <Button ref={confirmTriggerRef} disabled={!envelope.preview.valid} onClick={() => setConfirmOpen(true)} type="button">
              <ShieldCheck data-icon="inline-start" /> {isRepair ? "Review repaired proposal" : "Review draft save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {isRepair && envelope ? (
        <AlertDialog open={confirmOpen} onOpenChange={(open) => {
          if (!apply.isPending) setConfirmOpen(open);
        }}>
          <AlertDialogContent finalFocus={() => applySucceeded.current ? false : confirmTriggerRef.current}>
            <AlertDialogHeader>
              <AlertDialogMedia><MapPin aria-hidden="true" /></AlertDialogMedia>
              <AlertDialogTitle>{isRepair ? "Return this proposal to review?" : "Save this private draft?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {isRepair
                  ? "The refreshed content and references will replace the proposal content marked Needs refresh. No canonical knowledge is written."
                  : "This writes checkout-local draft state only. It does not add proposal prose to Git or modify canonical knowledge."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ExactPreviewDetails envelope={envelope} />
            {apply.isError ? <ErrorState error={apply.error} /> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={apply.isPending}>Keep reviewing</AlertDialogCancel>
              <AlertDialogAction disabled={apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? "Saving…" : isRepair ? "Repair and return to review" : "Save local draft"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}

function reviewCopy(action: ReviewAction) {
  switch (action.kind) {
    case "inbox.publish":
      return {
        title: "Publish private draft",
        description: "Writes a pending Markdown proposal in this checkout. Share it through Git. Project knowledge changes only after approval.",
        preview: "Preview publication",
        confirmTitle: "Publish this private draft?",
        confirm: "The proposal will be saved for review and its local draft removed. Commit and push the proposal to share it with teammates.",
        apply: "Publish proposal",
      };
    case "inbox.draft.delete":
      return {
        title: "Delete local draft",
        description: "Removes this private draft from the checkout. Published proposals and project knowledge stay unchanged.",
        preview: "Preview draft deletion",
        confirmTitle: "Delete this local draft?",
        confirm: "This private draft will be removed from the checkout.",
        apply: "Delete local draft",
      };
    case "inbox.approve":
      return {
        title: "Review proposal for approval",
        description: "Approval writes the reviewed knowledge change and records the decision. Commit and push the result to share it with teammates.",
        preview: "Preview knowledge approval",
        confirmTitle: "Approve this exact knowledge change?",
        confirm: "MEX will write the reviewed knowledge change and close the proposal as approved.",
        apply: "Approve proposal and write knowledge",
      };
    case "inbox.reject":
      return {
        title: "Decline proposal",
        description: "Declining closes this proposal without changing canonical knowledge. A rationale is required.",
        preview: "Review decline",
        confirmTitle: "Decline this proposal?",
        confirm: "The proposal will close with your rationale and canonical knowledge will remain unchanged.",
        apply: "Decline proposal",
      };
    case "inbox.withdraw":
      return {
        title: "Withdraw proposal",
        description: "Withdrawal closes your proposal without changing canonical knowledge. An optional rationale stays with the review decision.",
        preview: "Preview withdrawal",
        confirmTitle: "Withdraw this proposal?",
        confirm: "The proposal will close and can no longer be reviewed; its target knowledge remains unchanged.",
        apply: "Withdraw proposal",
      };
    case "inbox.mark-stale":
      return {
        title: "Mark as needs refresh",
        description: "Use this advanced action when the referenced knowledge content changed after publication.",
        preview: "Review refresh state",
        confirmTitle: "Mark this proposal as needing refresh?",
        confirm: "The proposal cannot be approved until its author or agent refreshes it against current knowledge content.",
        apply: "Mark as needs refresh",
      };
    case "inbox.repair":
      return {
        title: "Repair proposal manually",
        description: "Update this proposal against current knowledge content. Repair returns it to teammate review and does not write canonical knowledge.",
        preview: "Review repaired proposal",
        confirmTitle: "Return this proposal to review?",
        confirm: "The refreshed proposal content will replace the content marked Needs refresh and return to review.",
        apply: "Repair and return to review",
      };
  }
}

function ReviewActionDialog({
  action,
  finalFocus,
  focusAppliedStatus,
  onClose,
  onApplied,
}: {
  action: ProposalSupportingAction;
  finalFocus(): HTMLElement | null;
  focusAppliedStatus(): void;
  onClose(): void;
  onApplied(kind: AppliedInboxAction, result: InboxOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const copy = reviewCopy(action);
  const operation = useRef(operationId(action.kind.replaceAll(".", "_")));
  const [rationale, setRationale] = useState("");
  const [envelope, setEnvelope] = useState<InboxOperationPreviewResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  const applySucceeded = useRef(false);
  const previewGeneration = useRef(0);
  const preview = useMutation({
    mutationFn: ({ request }: { request: InboxOperationPreviewRequest; generation: number }) => (
      api.previewInboxOperation(request)
    ),
    onSuccess: (nextEnvelope, { generation }) => {
      if (generation === previewGeneration.current) setEnvelope(nextEnvelope);
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (envelope === null) throw new Error("Preview is unavailable.");
      return api.applyInboxOperation(envelope);
    },
    onSuccess: async (result) => {
      applySucceeded.current = true;
      setConfirmOpen(false);
      await onApplied(action.kind, result);
      onClose();
      afterDialogUnmount(focusAppliedStatus);
    },
  });
  const rationaleRequired = action.kind === "inbox.reject" || action.kind === "inbox.mark-stale";
  const rationaleAccepted = canonicalText(rationale, 8 * 1024, rationaleRequired);

  const request = (): InboxOperationPreviewRequest => {
    const expectedRevisions = [proposalExpectation(action.proposal)];
    if (action.kind === "inbox.reject" || action.kind === "inbox.mark-stale") {
      return {
        operationId: operation.current,
        action: {
          kind: action.kind,
          proposalId: action.proposal.ref.id,
          rationale,
        },
        expectedRevisions,
      };
    }
    if (action.kind === "inbox.withdraw") {
      return {
        operationId: operation.current,
        action: {
          kind: "inbox.withdraw",
          proposalId: action.proposal.ref.id,
          ...(rationale === "" ? {} : { rationale }),
        },
        expectedRevisions,
      };
    }
    throw new Error("Unsupported Inbox review action.");
  };

  const updateRationale = (value: string) => {
    setRationale(value);
    operation.current = operationId(action.kind.replaceAll(".", "_"));
    previewGeneration.current += 1;
    setEnvelope(null);
    setConfirmOpen(false);
    preview.reset();
    apply.reset();
  };
  const startPreview = () => {
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    setEnvelope(null);
    setConfirmOpen(false);
    apply.reset();
    preview.mutate({ request: request(), generation });
  };

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !apply.isPending) {
        onClose();
        afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
      }
    }}>
      <DialogContent className={styles.reviewDialog} finalFocus={false}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className={styles.dialogScroll}>
          <div className={styles.reviewSubject}>
            <span>knowledge change</span>
            <strong>{action.proposal.title}</strong>
          </div>
          {action.kind === "inbox.reject" || action.kind === "inbox.withdraw" || action.kind === "inbox.mark-stale" ? (
            <Field data-invalid={!rationaleAccepted || undefined}>
              <FieldLabel htmlFor="proposal-review-rationale">Review rationale</FieldLabel>
              <Textarea
                autoFocus
                id="proposal-review-rationale"
                maxLength={8 * 1024}
                onChange={(event) => updateRationale(event.currentTarget.value)}
                rows={5}
                value={rationale}
              />
              <FieldDescription>
                {rationaleRequired ? "Required for this review transition." : "Optional for withdrawal."}
              </FieldDescription>
              {!rationaleAccepted ? <FieldError>Enter valid bounded review rationale.</FieldError> : null}
            </Field>
          ) : null}
          {preview.isError ? <ErrorState error={preview.error} /> : null}
          {envelope && !envelope.preview.valid ? (
            <MutationAlert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <MutationAlertTitle>This operation is not ready to apply</MutationAlertTitle>
              <MutationAlertDescription>Refresh the Inbox or correct the rationale, then check the outcome again.</MutationAlertDescription>
            </MutationAlert>
          ) : null}
          {envelope ? <ExactPreviewDetails envelope={envelope} /> : null}
        </div>
        <DialogFooter>
          <Button
            disabled={apply.isPending}
            onClick={() => {
              onClose();
              afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          {envelope === null ? (
            <Button disabled={!rationaleAccepted || preview.isPending} onClick={startPreview} type="button">
              <FileDiff data-icon="inline-start" /> {preview.isPending ? "Preparing…" : copy.preview}
            </Button>
          ) : !envelope.preview.valid ? (
            <Button disabled={preview.isPending} onClick={startPreview} type="button" variant="outline">
              <RefreshCw data-icon="inline-start" /> Check again
            </Button>
          ) : (
            <Button ref={confirmTriggerRef} disabled={!envelope.preview.valid} onClick={() => setConfirmOpen(true)} type="button">
              <ShieldCheck data-icon="inline-start" /> Review outcome
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {envelope ? (
        <AlertDialog open={confirmOpen} onOpenChange={(open) => {
          if (!apply.isPending) setConfirmOpen(open);
        }}>
          <AlertDialogContent finalFocus={() => applySucceeded.current ? false : confirmTriggerRef.current}>
            <AlertDialogHeader>
              <AlertDialogMedia><CheckCircle2 aria-hidden="true" /></AlertDialogMedia>
              <AlertDialogTitle>{copy.confirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.confirm} MEX will revalidate current project state before writing anything.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ExactPreviewDetails envelope={envelope} />
            {apply.isError ? <ErrorState error={apply.error} /> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={apply.isPending}>Keep reviewing</AlertDialogCancel>
              <AlertDialogAction disabled={apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? "Applying…" : copy.apply}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}

function approvalEntityLabel(proposal: InboxProposalDetail): string {
  if (isInboxCreate(proposal.change)) {
    return `${sentenceCase(proposal.change.entityKind)} · ${proposal.change.title}`;
  }
  return proposal.change.target.title ?? sentenceCase(proposal.change.target.kind);
}

function ApproveChangeDialog({
  action,
  finalFocus,
  focusAppliedStatus,
  onClose,
  onApplied,
}: {
  action: ApprovalAction;
  finalFocus(): HTMLElement | null;
  focusAppliedStatus(): void;
  onClose(): void;
  onApplied(kind: AppliedInboxAction, result: InboxOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const operation = useRef(operationId("inbox_approve"));
  const previewRequested = useRef(false);
  const applySucceeded = useRef(false);
  const [selfApprovalAcknowledged, setSelfApprovalAcknowledged] = useState(!action.selfApproval);
  const [envelope, setEnvelope] = useState<InboxOperationPreviewResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const preview = useMutation({
    mutationFn: (request: InboxOperationPreviewRequest) => api.previewInboxOperation(request),
    onSuccess: (nextEnvelope) => {
      setEnvelope(nextEnvelope);
      setConfirmOpen(nextEnvelope.preview.valid);
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (envelope === null || !envelope.preview.valid) throw new Error("A valid exact preview is required.");
      return api.applyInboxOperation(envelope);
    },
    onSuccess: async (result) => {
      applySucceeded.current = true;
      setConfirmOpen(false);
      await onApplied("inbox.approve", result);
      onClose();
      afterDialogUnmount(focusAppliedStatus);
    },
  });

  const requestPreview = () => {
    if (preview.isPending) return;
    previewRequested.current = true;
    operation.current = operationId("inbox_approve");
    setEnvelope(null);
    setConfirmOpen(false);
    preview.reset();
    apply.reset();
    preview.mutate({
      operationId: operation.current,
      action: { kind: "inbox.approve", proposalId: action.proposal.ref.id },
      expectedRevisions: [proposalExpectation(action.proposal)],
    });
  };

  useEffect(() => {
    if (!action.selfApproval && !previewRequested.current) requestPreview();
  });

  const closeAndRestoreFocus = () => {
    if (apply.isPending) return;
    onClose();
    afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
  };

  if (action.selfApproval && !selfApprovalAcknowledged) {
    return (
      <AlertDialog open onOpenChange={(open) => {
        if (!open) closeAndRestoreFocus();
      }}>
        <AlertDialogContent finalFocus={false}>
          <AlertDialogHeader>
            <AlertDialogMedia><AlertTriangle aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>Teammate review is recommended</AlertDialogTitle>
            <AlertDialogDescription>
              You published this proposal. Independent review is the safer default before a knowledge change becomes durable team memory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Wait for a teammate</AlertDialogCancel>
            <Button
              onClick={() => {
                setSelfApprovalAcknowledged(true);
                requestPreview();
              }}
              type="button"
              variant="destructive"
            >
              Continue without teammate review
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (envelope?.preview.valid && confirmOpen) {
    return (
      <AlertDialog open onOpenChange={(open) => {
        if (!open && !apply.isPending) closeAndRestoreFocus();
      }}>
        <AlertDialogContent className={styles.approvalConfirmation} finalFocus={() => applySucceeded.current ? false : finalFocus()}>
          <AlertDialogHeader>
            <AlertDialogMedia><CheckCircle2 aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>Approve this knowledge change?</AlertDialogTitle>
            <AlertDialogDescription>
              Approval writes this knowledge change in your checkout. Commit and push the result to share it with teammates.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className={styles.approvalSummary}>
            <div>
              <Badge variant="outline">{changeLabel(action.proposal.changeKind, action.proposal.entityKind)}</Badge>
              <strong>{action.proposal.title}</strong>
            </div>
            <dl>
              <div><dt>Knowledge entity affected</dt><dd>{approvalEntityLabel(action.proposal)}</dd></div>
              <div><dt>Identity</dt><dd>Approving as {actorLabel(envelope.receipt.authority.actor)}</dd></div>
            </dl>
            <div className={styles.approvalConsequences}>
              <span>Approval will</span>
              <ul>
                <li>Write the reviewed knowledge change</li>
                <li>Update the proposal as approved</li>
                <li>Record the decision in Activity</li>
              </ul>
            </div>
          </div>
          <ExactPreviewDetails envelope={envelope} />
          {apply.isError ? <ErrorState error={apply.error} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={apply.isPending}>Keep reviewing</AlertDialogCancel>
            <AlertDialogAction disabled={apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending ? "Approving…" : "Approve change"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) closeAndRestoreFocus();
    }}>
      <DialogContent className={styles.previewStatusDialog} finalFocus={false}>
        <DialogHeader>
          <DialogTitle>{envelope && !envelope.preview.valid ? "This change is not ready to approve" : "Preparing exact approval"}</DialogTitle>
          <DialogDescription>
            {envelope && !envelope.preview.valid
              ? "The knowledge change remains visible in Inbox. Refresh it or resolve the reported issue before trying again."
              : "MEX is checking the selected proposal against current knowledge content and preparing approval details."}
          </DialogDescription>
        </DialogHeader>
        {preview.isPending || (!preview.isError && envelope === null) ? (
          <StatePanel compact state="loading" title="Checking the change" detail="No project memory is written during preview." />
        ) : null}
        {preview.isError ? <ErrorState error={preview.error} /> : null}
        {envelope && !envelope.preview.valid ? (
          <>
            <MutationAlert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <MutationAlertTitle>Approval preview is invalid</MutationAlertTitle>
              <MutationAlertDescription>No changes were applied. Exact diagnostics are available below.</MutationAlertDescription>
            </MutationAlert>
            <ExactPreviewDetails envelope={envelope} />
          </>
        ) : null}
        <DialogFooter>
          <Button onClick={closeAndRestoreFocus} type="button" variant="outline">Cancel</Button>
          {preview.isError || (envelope !== null && !envelope.preview.valid) ? (
            <Button disabled={preview.isPending} onClick={requestPreview} type="button">
              <RefreshCw data-icon="inline-start" /> Try preview again
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftBoundaryDialog({
  action,
  finalFocus,
  focusAppliedStatus,
  onClose,
  onApplied,
}: {
  action: DraftBoundaryAction;
  finalFocus(): HTMLElement | null;
  focusAppliedStatus(): void;
  onClose(): void;
  onApplied(kind: AppliedInboxAction, result: InboxOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const applySucceeded = useRef(false);
  const [envelope, setEnvelope] = useState<InboxOperationPreviewResponse | null>(null);
  const operation = useMutation({
    mutationFn: async () => {
      const exactEnvelope = await api.previewInboxOperation({
        operationId: operationId(action.kind.replaceAll(".", "_")),
        action: { kind: action.kind, draftId: action.draft.id },
        expectedRevisions: [draftExpectation(action.draft)],
      });
      setEnvelope(exactEnvelope);
      if (!exactEnvelope.preview.valid) {
        throw new Error("MEX could not produce a valid exact preview. No draft changes were applied.");
      }
      return api.applyInboxOperation(exactEnvelope);
    },
    onSuccess: async (result) => {
      applySucceeded.current = true;
      await onApplied(action.kind, result);
      onClose();
      afterDialogUnmount(focusAppliedStatus);
    },
  });
  const publishing = action.kind === "inbox.publish";
  const closeAndRestoreFocus = () => {
    if (operation.isPending) return;
    onClose();
    afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
  };

  return (
    <AlertDialog open onOpenChange={(open) => {
      if (!open) closeAndRestoreFocus();
    }}>
      <AlertDialogContent finalFocus={() => applySucceeded.current ? false : finalFocus()}>
        <AlertDialogHeader>
          <AlertDialogMedia>{publishing ? <Send aria-hidden="true" /> : <Trash2 aria-hidden="true" />}</AlertDialogMedia>
          <AlertDialogTitle>{publishing ? "Publish this draft for review?" : "Discard this draft?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {publishing
              ? "Writes a pending Markdown proposal in this checkout. Share it through Git. Project knowledge changes only after approval."
              : "This removes the private draft from this checkout. Proposals and knowledge are not changed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className={styles.boundarySubject}>
          <Badge variant="outline">{changeLabel(action.draft.changeKind, action.draft.entityKind)}</Badge>
          <strong>{action.draft.title}</strong>
        </div>
        {publishing ? (
          <MutationAlert>
            <GitCommitHorizontal aria-hidden="true" />
            <MutationAlertTitle>Git step still required</MutationAlertTitle>
            <MutationAlertDescription>
              After publication, commit and push the proposal to make it available to teammates.
            </MutationAlertDescription>
          </MutationAlert>
        ) : null}
        {operation.isError ? <ErrorState error={operation.error} /> : null}
        {envelope ? <ExactPreviewDetails envelope={envelope} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={operation.isPending}>{publishing ? "Keep private" : "Keep draft"}</AlertDialogCancel>
          <Button
            className={publishing ? undefined : styles.destructiveConfirmation}
            disabled={operation.isPending}
            onClick={() => operation.mutate()}
            type="button"
            variant={publishing ? "default" : "destructive"}
          >
            {operation.isPending
              ? publishing ? "Publishing…" : "Discarding…"
              : publishing ? "Publish for review" : "Discard draft"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function safeExternalEvidenceUri(value: string): string | null {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === ""
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function EvidenceValue({ item }: { item: InboxEvidenceRef }) {
  if (item.kind === "entity") {
    const validId = WikiEntityIdSchema.safeParse(item.entity.id);
    const label = item.entity.title ?? `Referenced ${sentenceCase(item.entity.kind)}`;
    return validId.success
      ? <Link to={`/knowledge/${encodeURIComponent(validId.data)}`}>{label}</Link>
      : <span>{label}</span>;
  }
  if (item.kind === "code") {
    if (item.code.kind === "file") return <code>{item.code.path}</code>;
    const validId = GraphSymbolIdSchema.safeParse(item.code.symbolId);
    return validId.success
      ? <Link to={`/code/symbols/${encodeURIComponent(validId.data)}`}>Open referenced code symbol</Link>
      : <span>Referenced code symbol</span>;
  }
  if (item.kind === "external") {
    const href = safeExternalEvidenceUri(item.uri);
    return href === null
      ? <span>{item.label ?? "External evidence"}</span>
      : (
          <a href={href} rel="noopener noreferrer" target="_blank">
            {item.label ?? item.uri}
            <SquareArrowOutUpRight aria-hidden="true" />
          </a>
        );
  }
  if (item.kind === "commit") return <code>{item.hash}</code>;
  if (item.kind === "file") return <code>{item.path}</code>;
  return <p>{item.note}</p>;
}

function EvidenceIcon({ item }: { item: InboxEvidenceRef }) {
  if (item.kind === "entity") return <LibraryBig aria-hidden="true" />;
  if (item.kind === "code") return <Code2 aria-hidden="true" />;
  if (item.kind === "commit") return <GitCommitHorizontal aria-hidden="true" />;
  if (item.kind === "file") return <FileText aria-hidden="true" />;
  if (item.kind === "external") return <SquareArrowOutUpRight aria-hidden="true" />;
  return <FilePenLine aria-hidden="true" />;
}

function evidenceLabel(item: InboxEvidenceRef): string {
  if (item.kind === "entity") return "Knowledge";
  if (item.kind === "code") return item.code.kind === "symbol" ? "Code symbol" : "Code file";
  if (item.kind === "commit") return "Commit";
  if (item.kind === "file") return "File";
  if (item.kind === "external") return "External source";
  return "Review note";
}

function EvidenceList({ evidence }: { evidence: InboxDraftInput["evidence"] }) {
  if (evidence.length === 0) {
    return <p className={styles.mutedCopy}>No supporting evidence was included.</p>;
  }
  return (
    <ul className={styles.semanticEvidenceList}>
      {evidence.map((item, index) => (
        <li key={`${item.kind}:${index}`}>
          <span className={styles.evidenceIcon}><EvidenceIcon item={item} /></span>
          <div>
            <small>{evidenceLabel(item)}</small>
            <EvidenceValue item={item} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface InboxMutationDialogsProps {
  editor: { draft: InboxDraftDetail | null } | null;
  finalFocus(): HTMLElement | null;
  focusAppliedStatus(): void;
  onApplied(kind: AppliedInboxAction, result: InboxOperationApplyResponse): Promise<void>;
  onCloseEditor(): void;
  onCloseReview(): void;
  reviewAction: ReviewAction | null;
}

export default function InboxMutationDialogs({
  editor,
  finalFocus,
  focusAppliedStatus,
  onApplied,
  onCloseEditor,
  onCloseReview,
  reviewAction,
}: InboxMutationDialogsProps) {
  if (editor) {
    return (
      <DraftEditorDialog
        draft={editor.draft}
        repair={null}
        finalFocus={finalFocus}
        focusAppliedStatus={focusAppliedStatus}
        onApplied={onApplied}
        onClose={onCloseEditor}
      />
    );
  }
  if (reviewAction?.kind === "inbox.repair") {
    return (
      <DraftEditorDialog
        draft={null}
        repair={reviewAction.proposal}
        finalFocus={finalFocus}
        focusAppliedStatus={focusAppliedStatus}
        onApplied={onApplied}
        onClose={onCloseReview}
      />
    );
  }
  if (reviewAction?.kind === "inbox.approve") {
    return (
      <ApproveChangeDialog
        action={reviewAction}
        finalFocus={finalFocus}
        focusAppliedStatus={focusAppliedStatus}
        onApplied={onApplied}
        onClose={onCloseReview}
      />
    );
  }
  if (reviewAction?.kind === "inbox.publish" || reviewAction?.kind === "inbox.draft.delete") {
    return (
      <DraftBoundaryDialog
        action={reviewAction}
        finalFocus={finalFocus}
        focusAppliedStatus={focusAppliedStatus}
        onApplied={onApplied}
        onClose={onCloseReview}
      />
    );
  }
  if (reviewAction) {
    return (
      <ReviewActionDialog
        action={reviewAction}
        finalFocus={finalFocus}
        focusAppliedStatus={focusAppliedStatus}
        onApplied={onApplied}
        onClose={onCloseReview}
      />
    );
  }
  return null;
}

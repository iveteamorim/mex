import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  FileDiff,
  FilePenLine,
  Handshake,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHubApi } from "../api/context";
import type {
  RelayDetail,
  RelayDraftInput,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  TeamActorRef,
} from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/primitives/alert";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import { ErrorState, formatDate, sentenceCase, StatePanel, StatusPill } from "../components/ui";
import styles from "../styles/relay-mutation-dialog.module.css";

export type RelayReviewSnapshot =
  | { kind: "draft"; input: RelayDraftInput }
  | { kind: "relay"; relay: RelayDetail };

export type RelayReviewSource =
  | { kind: "save"; request: RelayOperationPreviewRequest; snapshot: RelayReviewSnapshot }
  | { kind: "delete"; request: RelayOperationPreviewRequest; snapshot: RelayReviewSnapshot }
  | { kind: "publish"; request: RelayOperationPreviewRequest; snapshot: RelayReviewSnapshot }
  | { kind: "acknowledge"; request: RelayOperationPreviewRequest; snapshot: RelayReviewSnapshot }
  | { kind: "close"; request: RelayOperationPreviewRequest; snapshot: RelayReviewSnapshot };

export type RelayPreviewAcceptance = "accepted" | "stale" | "mismatched";

export interface RelayMutationDialogProps {
  source: RelayReviewSource;
  finalFocus(): HTMLElement | null;
  onClose(): void;
  onApplied(result: RelayOperationApplyResponse): Promise<void>;
  acceptPreview(
    currentAttempt: number,
    expectedAttempt: number,
    expectedRequest: RelayOperationPreviewRequest,
    envelope: RelayOperationPreviewResponse,
  ): RelayPreviewAcceptance;
}

const PREVIEW_IDENTITY_ERROR = "The signed Relay preview did not exactly match the submitted request. Prepare a fresh preview before applying.";

function actorLabel(actor: TeamActorRef | null | undefined): string {
  if (actor?.kind === "member") return actor.displayName ?? "Team member";
  if (actor?.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown identity";
}

function PreviewDocket({ envelope }: { envelope: RelayOperationPreviewResponse }) {
  return (
    <section className={styles.previewDocket} aria-labelledby="relay-preview-heading">
      <div className={styles.previewHeading}>
        <div><p>Signed operation envelope</p><h3 id="relay-preview-heading">Exact operation details</h3></div>
        <StatusPill tone={envelope.preview.valid ? "success" : "danger"}>{envelope.preview.valid ? "Ready" : "Invalid"}</StatusPill>
      </div>
      <dl className={styles.authorityGrid}>
        <div><dt>Operation ID</dt><dd><code>{envelope.request.operationId}</code></dd></div>
        <div><dt>Operation</dt><dd>{envelope.request.action.kind}</dd></div>
        <div><dt>Actor</dt><dd>{actorLabel(envelope.receipt.authority.actor)}</dd></div>
        <div><dt>Captured</dt><dd>{formatDate(envelope.receipt.authority.occurredAt)}</dd></div>
        <div><dt>Branch</dt><dd>{envelope.receipt.authority.repoState.branch ?? "Detached HEAD"}</dd></div>
        <div><dt>HEAD</dt><dd><code>{envelope.receipt.authority.repoState.head ?? "Unborn HEAD"}</code></dd></div>
        <div><dt>Worktree</dt><dd>{envelope.receipt.authority.repoState.dirty ? "Dirty" : "Clean"}</dd></div>
        <div><dt>Repository observed</dt><dd>{formatDate(envelope.receipt.authority.repoState.observedAt)}</dd></div>
        <div><dt>Scope</dt><dd>{sentenceCase(envelope.preview.scope)}</dd></div>
        <div><dt>Receipt schema</dt><dd>{envelope.receipt.schemaVersion}</dd></div>
        <div><dt>Request revision</dt><dd><code>{envelope.receipt.requestRevision}</code></dd></div>
        <div><dt>Presentation revision</dt><dd><code>{envelope.receipt.presentationRevision}</code></dd></div>
      </dl>
      {envelope.request.expectedRevisions.length ? (
        <div className={styles.previewDiagnostics}>
          <h4>Expected revisions</h4>
          <ul>{envelope.request.expectedRevisions.map((expectation, index) => {
            const target = expectation.target.kind === "local"
              ? `${expectation.target.namespace}:${expectation.target.id}`
              : expectation.target.path;
            return <li key={`${index}:${target}`}><code>{target}</code>: <code>{expectation.revision}</code></li>;
          })}</ul>
        </div>
      ) : null}
      <div className={styles.digest}><span>Preview digest</span><code>{envelope.receipt.previewRevision}</code></div>
      <div className={styles.purposeList} aria-label="Generated IDs">
        {envelope.receipt.purposeIds.map((purpose) => <Badge key={`${purpose.purpose}:${purpose.id}`} variant="outline">{purpose.purpose} · {purpose.id}</Badge>)}
      </div>
      {envelope.preview.diagnostics.length ? (
        <div className={styles.previewDiagnostics}>
          <h4>Diagnostics</h4>
          <ul>{envelope.preview.diagnostics.map((diagnostic) => <li key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.code}: {diagnostic.message}</li>)}</ul>
        </div>
      ) : null}
      {envelope.preview.changes.map((change) => (
        <article className={styles.diff} key={`${change.kind}:${change.path}`}>
          <header><FileDiff aria-hidden="true" /><strong>{change.path}</strong><StatusPill>{change.kind}</StatusPill></header>
          <p className={styles.changeRevisions}>Before <code>{change.beforeRevision ?? "none"}</code> · After <code>{change.afterRevision ?? "none"}</code></p>
          <pre aria-label={`Exact diff for ${change.path}`}><code>{change.diff}</code></pre>
        </article>
      ))}
      {envelope.preview.localChanges.map((change) => (
        <p className={styles.localChange} key={change.id}><FilePenLine aria-hidden="true" /><span><strong>Checkout-local</strong>{change.summary}<small>Before <code>{change.beforeRevision ?? "none"}</code> · After <code>{change.afterRevision ?? "none"}</code></small></span></p>
      ))}
      <p className={styles.boundNote}><ShieldCheck aria-hidden="true" /> Apply accepts only this complete envelope; no field is reconstructed in the browser.</p>
    </section>
  );
}

function reviewCopy(source: RelayReviewSource): {
  title: string;
  description: string;
  confirm: string;
  pendingTitle: string;
  pendingDetail: string;
  consequence: readonly string[];
} {
  if (source.kind === "acknowledge") {
    return {
      title: "Take this handoff?",
      description: "Pull the latest repository state before claiming. You will become the sole claimant for the current synchronized Relay state.",
      confirm: "Take handoff",
      pendingTitle: "Checking the handoff",
      pendingDetail: "Confirming that the current Relay state can still be claimed.",
      consequence: [
        "Other eligible Members will no longer be able to take this synchronized state.",
        "There is no unclaim or reassignment.",
        "Two unsynchronized clones can still attempt a claim and later encounter a Git conflict.",
      ],
    };
  }
  if (source.kind === "close") {
    return {
      title: "Close this handoff?",
      description: "Closing is irreversible and removes this handoff from open attention.",
      confirm: "Close handoff",
      pendingTitle: "Checking the handoff",
      pendingDetail: "Confirming that its sender, claimant, and current Relay state still allow closing.",
      consequence: [
        "The handoff will no longer appear as open.",
        "The saved handoff remains readable in project history.",
      ],
    };
  }
  if (source.kind === "publish") {
    return {
      title: "Publish this handoff?",
      description: "This writes a Relay Markdown artifact in your working tree. Share it through Git so teammates can take it.",
      confirm: "Publish handoff",
      pendingTitle: "Checking publication",
      pendingDetail: "Confirming the current sender, recipients, draft revision, and repository state.",
      consequence: [
        "The local draft will be removed after the Relay is created.",
        "The Relay records branch, HEAD, clean or dirty state, and observation time.",
        "MEX does not create a commit or capture source-file or local-change contents.",
        "Commit and push are still required to share it; MEX does not verify delivery to another checkout.",
      ],
    };
  }
  if (source.kind === "delete") {
    return {
      title: "Delete this handoff draft?",
      description: "This removes only the checkout-local draft.",
      confirm: "Delete draft",
      pendingTitle: "Checking the draft",
      pendingDetail: "Confirming that the selected local draft revision is still current.",
      consequence: ["Published Relays and shared project memory are not changed."],
    };
  }
  return {
    title: "Save this handoff draft?",
    description: "This updates only the checkout-local handoff draft.",
    confirm: "Save draft",
    pendingTitle: "Checking the draft",
    pendingDetail: "Confirming that the selected local draft revision is still current.",
    consequence: ["No Git-tracked Relay is created by this local save."],
  };
}

export default function RelayMutationDialog({
  source,
  finalFocus,
  onClose,
  onApplied,
  acceptPreview,
}: RelayMutationDialogProps) {
  const api = useHubApi();
  const [envelope, setEnvelope] = useState<RelayOperationPreviewResponse | null>(null);
  const [identityError, setIdentityError] = useState<Error | null>(null);
  const [applyFailed, setApplyFailed] = useState(false);
  const generation = useRef(0);
  const restoreTriggerFocus = useRef(true);
  const preview = useMutation({ mutationFn: (request: RelayOperationPreviewRequest) => api.previewRelayOperation(request) });
  const apply = useMutation({ mutationFn: (request: RelayOperationPreviewResponse) => api.applyRelayOperation(request) });

  const requestPreview = () => {
    const current = ++generation.current;
    setEnvelope(null);
    setIdentityError(null);
    setApplyFailed(false);
    apply.reset();
    preview.mutate(source.request, {
      onSuccess: (result) => {
        const acceptance = acceptPreview(generation.current, current, source.request, result);
        if (acceptance === "accepted") setEnvelope(result);
        if (acceptance === "mismatched") setIdentityError(new Error(PREVIEW_IDENTITY_ERROR));
      },
    });
  };

  useEffect(() => {
    requestPreview();
    return () => { generation.current += 1; };
  // The source and acceptance function are immutable for one mounted review dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (restoreFocus = true) => {
    restoreTriggerFocus.current = restoreFocus;
    onClose();
  };
  const applyEnvelope = () => {
    if (!envelope || applyFailed) return;
    setApplyFailed(false);
    apply.mutate(envelope, {
      onSuccess: (result) => void onApplied(result).then(() => close(false)),
      onError: () => setApplyFailed(true),
    });
  };
  const copy = reviewCopy(source);
  const handoffSummary = source.snapshot.kind === "relay"
    ? source.snapshot.relay.summary
    : source.snapshot.input.summary;

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !apply.isPending) close(); }}>
      <AlertDialogContent className={styles.reviewDialog} finalFocus={() => restoreTriggerFocus.current ? finalFocus() : false}>
        <AlertDialogHeader>
          <AlertDialogMedia><Handshake aria-hidden="true" /></AlertDialogMedia>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <section className={styles.confirmationSummary} aria-label="Handoff outcome">
          <p className={styles.confirmationEyebrow}>Handoff</p>
          <h3>{handoffSummary}</h3>
          {source.kind === "publish" && source.snapshot.kind === "draft" ? <p><strong>Who can take:</strong> {source.snapshot.input.audience === "team" ? "Any active Member, including teammates who join later." : source.snapshot.input.recipients.map(actorLabel).join(", ")}</p> : null}
          <ul>{copy.consequence.map((item) => <li key={item}>{item}</li>)}</ul>
          {envelope ? <p><strong>{source.kind === "acknowledge" ? "Taking as" : source.kind === "close" ? "Closing as" : "Acting as"} {actorLabel(envelope.receipt.authority.actor)}</strong></p> : null}
          {source.kind === "publish" && envelope ? (
            <p>
              <strong>Repository at publication:</strong>{" "}
              {envelope.receipt.authority.repoState.branch ?? "Detached HEAD"},{" "}
              {envelope.receipt.authority.repoState.head === null
                ? "no committed HEAD recorded"
                : `HEAD ${envelope.receipt.authority.repoState.head.slice(0, 8)}`},{" "}
              {envelope.receipt.authority.repoState.dirty ? "local changes present" : "clean"},{" "}
              observed {formatDate(envelope.receipt.authority.repoState.observedAt)}.
            </p>
          ) : null}
        </section>
        {preview.isPending ? <StatePanel compact state="loading" title={copy.pendingTitle} detail={copy.pendingDetail} /> : null}
        {preview.isError ? <ErrorState error={preview.error} retry={requestPreview} /> : null}
        {identityError ? (
          <div className={styles.previewFailure}>
            <StatePanel
              action={<Button onClick={requestPreview} size="sm" type="button" variant="outline">Check again</Button>}
              compact
              detail="Nothing was applied. Check the current handoff again before continuing."
              state="error"
              title="The handoff changed while it was being checked"
            />
            <Collapsible className={styles.technicalDetails}>
              <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
                <ChevronDown data-icon="inline-start" /> Technical details
              </CollapsibleTrigger>
              <CollapsibleContent className={styles.technicalContent}><p>{PREVIEW_IDENTITY_ERROR}</p></CollapsibleContent>
            </Collapsible>
          </div>
        ) : null}
        {envelope && !envelope.preview.valid ? (
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>This handoff cannot be changed yet</AlertTitle>
            <AlertDescription>The current project state did not pass every required check. Nothing has been applied.</AlertDescription>
          </Alert>
        ) : null}
        {envelope ? (
          <Collapsible className={styles.technicalDetails}>
            <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
              <ChevronDown data-icon="inline-start" /> Technical details
            </CollapsibleTrigger>
            <CollapsibleContent className={styles.technicalContent}>
              <PreviewDocket envelope={envelope} />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {apply.isError ? (
          <div className={styles.previewFailure}>
            <ErrorState error={apply.error} />
            <Button onClick={requestPreview} size="sm" type="button" variant="outline">Check again</Button>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={apply.isPending}>Keep reviewing</AlertDialogCancel>
          <AlertDialogAction disabled={!envelope?.preview.valid || apply.isPending || applyFailed} onClick={applyEnvelope}>
            {apply.isPending ? "Applying…" : copy.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

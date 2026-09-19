import { CheckCircle2 } from "lucide-react";
import { lazy, Suspense } from "react";
import type { TeamOperationPreviewResponse } from "../api/types";
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
} from "./primitives/alert-dialog";
import { ErrorState } from "./ui";
import styles from "../styles/team-operation.module.css";

const LazyTeamOperationPreviewPanel = lazy(() => import("./TeamOperationPreviewPanel"));

export function TeamOperationPreviewPanel({
  envelope,
}: {
  envelope: TeamOperationPreviewResponse;
}) {
  return (
    <Suspense fallback={<div aria-live="polite" role="status">Opening exact preview…</div>}>
      <LazyTeamOperationPreviewPanel envelope={envelope} />
    </Suspense>
  );
}

export function ApplyTeamOperationDialog({
  open,
  onOpenChange,
  onApply,
  pending,
  error,
  envelope,
  consequence,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onApply(): void;
  pending: boolean;
  error?: unknown;
  envelope: TeamOperationPreviewResponse;
  consequence: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia><CheckCircle2 aria-hidden="true" /></AlertDialogMedia>
          <AlertDialogTitle>Apply this exact preview?</AlertDialogTitle>
          <AlertDialogDescription>
            {consequence} The operation is bound to preview <span className={styles.mono}>{envelope.receipt.previewRevision.slice(0, 12)}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== undefined ? <ErrorState error={error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep reviewing</AlertDialogCancel>
          <AlertDialogAction disabled={pending || !envelope.preview.valid} onClick={onApply}>
            {pending ? "Applying…" : "Apply approved preview"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

import { useEffect, useRef } from "react";
import { AlertTriangle, DatabaseZap, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { Badge } from "./primitives/badge";
import { Button } from "./primitives/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "./primitives/card";
import styles from "../styles/rebuild-confirmation.module.css";

export function RebuildConfirmation({
  open,
  pending,
  onCancel,
  onConfirm,
  target = "graph",
}: {
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  target?: "graph" | "wiki";
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    if (pending) dialogRef.current?.focus({ preventScroll: true });
    else confirmRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!pending) onCancel();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, open, pending]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} role="presentation">
      <section
        aria-describedby={`${target}-rebuild-description`}
        aria-labelledby={`${target}-rebuild-title`}
        aria-modal="true"
        className={styles.dialog}
        data-pending={pending ? "true" : "false"}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <Card className={styles.dialogCard}>
          <CardHeader className={styles.header}>
            <span className={styles.commandIcon} aria-hidden="true"><DatabaseZap /></span>
            <CardTitle className={styles.heading}>
              <h2 id={`${target}-rebuild-title`}>Rebuild the {target === "graph" ? "code graph" : "Wiki index"}?</h2>
            </CardTitle>
            <CardAction className={styles.headerAction}>
              <Button
                aria-label="Close rebuild confirmation"
                className={styles.closeButton}
                disabled={pending}
                onClick={onCancel}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" />
              </Button>
            </CardAction>
          </CardHeader>

          <CardContent className={styles.content}>
            <div className={styles.commandLine} aria-hidden="true">
              <code>{target}_rebuild</code>
              <Badge className={styles.commandPolicy} variant="outline">confirmation required</Badge>
            </div>

            <div className={styles.body}>
              <div className={styles.warning}>
                <AlertTriangle aria-hidden="true" />
                <p id={`${target}-rebuild-description`}>
                  This replaces the derived {target === "graph" ? "graph" : "Wiki index"} from repository sources. It never stages or commits files, but it can take longer than an incremental refresh.
                </p>
              </div>

              <dl className={styles.facts}>
                <div>
                  <dt><ShieldCheck aria-hidden="true" /> Previous index</dt>
                  <dd>remains trusted until publish</dd>
                </div>
                <div>
                  <dt><ShieldCheck aria-hidden="true" /> Repository</dt>
                  <dd>stays read-only</dd>
                </div>
              </dl>
            </div>
          </CardContent>

          <CardFooter className={styles.actions}>
            <span className={styles.pendingNote} aria-live="polite">
              {pending ? `Preparing the persisted ${target} job…` : "Nothing starts until you confirm."}
            </span>
            <Button className={styles.cancelButton} disabled={pending} onClick={onCancel} type="button" variant="outline">
              Keep current {target === "graph" ? "graph" : "Wiki index"}
            </Button>
            <Button className={styles.confirmButton} disabled={pending} onClick={onConfirm} ref={confirmRef} type="button">
              {pending ? <LoaderCircle aria-hidden="true" className={styles.spinner} data-icon="inline-start" /> : null}
              {pending ? "Starting rebuild…" : `Start ${target} rebuild`}
            </Button>
          </CardFooter>
        </Card>
      </section>
    </div>
  );
}

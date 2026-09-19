import { AlertTriangle, FileDiff, MapPin, ShieldCheck } from "lucide-react";
import type { TeamOperationPreviewResponse } from "../api/types";
import { StatusPill, formatDate } from "./ui";
import styles from "../styles/team-operation-preview.module.css";

function actorLabel(actor: TeamOperationPreviewResponse["receipt"]["authority"]["actor"]): string {
  if (actor.kind === "member") return actor.displayName ?? actor.memberId;
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

export default function TeamOperationPreviewPanel({
  envelope,
}: {
  envelope: TeamOperationPreviewResponse;
}) {
  return (
    <section className={styles.preview} aria-labelledby="team-preview-heading">
      <header className={styles.previewHeader}>
        <div>
          <p>Approved bytes</p>
          <h3 id="team-preview-heading">Operation preview</h3>
        </div>
        <StatusPill tone={envelope.preview.valid ? "success" : "danger"}>
          {envelope.preview.valid ? "Ready for review" : "Invalid"}
        </StatusPill>
      </header>

      <dl className={styles.authorityGrid}>
        <div><dt>Actor</dt><dd>{actorLabel(envelope.receipt.authority.actor)}</dd></div>
        <div><dt>Captured</dt><dd>{formatDate(envelope.receipt.authority.occurredAt)}</dd></div>
        <div><dt>Repository</dt><dd>{envelope.receipt.authority.repoState.branch ?? "Detached HEAD"}</dd></div>
        <div><dt>Preview</dt><dd className={styles.mono}>{envelope.receipt.previewRevision.slice(0, 12)}</dd></div>
      </dl>

      {envelope.preview.changes.length > 0 ? (
        <div className={styles.changeStack}>
          {envelope.preview.changes.map((change) => (
            <article className={styles.change} key={`${change.kind}:${change.path}`}>
              <header><FileDiff aria-hidden="true" /><strong>{change.path}</strong><span>{change.kind}</span></header>
              <pre aria-label={`Reviewed diff for ${change.path}`}><code>{change.diff}</code></pre>
            </article>
          ))}
        </div>
      ) : null}

      {envelope.preview.localChanges.length > 0 ? (
        <div className={styles.localChanges}>
          {envelope.preview.localChanges.map((change) => (
            <div key={`${change.namespace}:${change.id}`}>
              <MapPin aria-hidden="true" />
              <span><strong>Checkout-local change</strong><small>{change.summary}</small></span>
            </div>
          ))}
        </div>
      ) : null}

      {envelope.preview.diagnostics.length > 0 ? (
        <div className={styles.diagnostics} role="status">
          <AlertTriangle aria-hidden="true" />
          <span>{envelope.preview.diagnostics[0]?.message}</span>
        </div>
      ) : (
        <p className={styles.exactNote}><ShieldCheck aria-hidden="true" /> Apply uses this exact bounded envelope.</p>
      )}
    </section>
  );
}

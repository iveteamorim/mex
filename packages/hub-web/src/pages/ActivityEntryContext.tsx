import {
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  Clipboard,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Link2,
  UserRound,
} from "lucide-react";
import { Link } from "react-router-dom";
import type {
  ActivityItem,
  ActivitySubject,
} from "../api/types";
import { Button } from "../components/primitives/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import { Separator } from "../components/primitives/separator";
import {
  activityActorLabel,
  activityProjectNoteKind,
  activitySubjectKindLabel,
  activitySubjectLabel,
  activitySubjectRawValue,
  activitySubjectRoute,
  sameActivityActor,
} from "../lib/activity-presentation";
import styles from "../styles/activity.module.css";

type CanonicalActivityItem = Extract<ActivityItem, { source: "activity" }>;

function SubjectIcon({ subject }: { subject: ActivitySubject }) {
  if (subject.kind === "entity") return <Box aria-hidden="true" />;
  if (subject.kind === "symbol") return <Braces aria-hidden="true" />;
  if (subject.kind === "file") return <FileText aria-hidden="true" />;
  return <GitCommitHorizontal aria-hidden="true" />;
}

function formatTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function RelatedItems({ item }: { item: ActivityItem }) {
  const workstream = item.source === "activity"
    && item.workstream?.title
    && !item.subjects.some((subject) => (
      subject.kind === "entity" && subject.entity.id === item.workstream?.id
    ))
    ? item.workstream
    : null;
  if (item.subjectCount === 0 && workstream === null) return null;
  return (
    <section className={styles.contextSection} aria-label="Related items">
      <div className={styles.contextHeading}>
        <Link2 aria-hidden="true" />
        <div><h4>Related items</h4><p>References stored with this record.</p></div>
      </div>
      {item.subjects.length > 0 || workstream ? (
        <ul className={styles.relatedList}>
          {workstream ? (
            <li>
              <span className={styles.relatedIcon}><Box aria-hidden="true" /></span>
              <span className={styles.relatedCopy}><small>Workstream</small><strong>{workstream.title}</strong></span>
            </li>
          ) : null}
          {item.subjects.map((subject, index) => {
            const href = activitySubjectRoute(subject, item);
            const label = activitySubjectLabel(subject);
            const technical = subject.kind !== "entity" || subject.entity.title === null;
            return (
              <li key={`${subject.kind}-${activitySubjectRawValue(subject)}-${index}`}>
                <span className={styles.relatedIcon}><SubjectIcon subject={subject} /></span>
                <span className={styles.relatedCopy}>
                  <small>{activitySubjectKindLabel(subject)}</small>
                  <strong className={technical ? styles.mono : undefined}>{label}</strong>
                </span>
                {href ? (
                  <Link aria-label={`Open ${label}`} className={styles.relatedOpen} to={href}>
                    Open <ChevronRight aria-hidden="true" data-icon="inline-end" />
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.contextNote}>
          {item.subjectCount} {item.subjectCount === 1 ? "reference was" : "references were"} recorded, but their previews were omitted by the safe response limit.
        </p>
      )}
      {item.subjectsTruncated ? (
        <p className={styles.contextNote}>Showing {item.subjects.length} of {item.subjectCount} stored references.</p>
      ) : null}
    </section>
  );
}

function RepositoryContext({ item }: { item: CanonicalActivityItem }) {
  const state = item.repository.head === null
    ? "Unborn repository"
    : item.repository.branch === null ? "Detached HEAD" : "Attached to branch";
  return (
    <section className={styles.contextSection} aria-label="Repository when recorded">
      <div className={styles.contextHeading}>
        <GitBranch aria-hidden="true" />
        <div><h4>Repository when recorded</h4><p>Git context captured when recorded.</p></div>
      </div>
      <dl className={styles.repositoryGrid}>
        <div><dt>State</dt><dd>{state}</dd></div>
        <div><dt>Branch</dt><dd className={styles.mono}>{item.repository.branch ?? (item.repository.head ? "Not on a branch" : "No branch recorded")}</dd></div>
        <div><dt>HEAD</dt><dd className={styles.mono}>{item.repository.head?.slice(0, 12) ?? "No HEAD yet"}</dd></div>
        <div><dt>Observed</dt><dd><time dateTime={item.repository.observedAt}>{formatTimestamp(item.repository.observedAt)}</time></dd></div>
        <div><dt>Working tree</dt><dd>{item.repository.dirty ? "Local changes present" : "Clean"}</dd></div>
      </dl>
      {item.repository.dirty ? (
        <p className={styles.dirtyNote}>Local changes existed. MEX recorded that fact, not their paths, diff, or contents.</p>
      ) : null}
    </section>
  );
}

function IdentityContext({ item }: { item: CanonicalActivityItem }) {
  const remapped = !sameActivityActor(item.recordedActor, item.effectiveActor);
  if (!remapped && item.actorDiagnostics.length === 0) return null;
  return (
    <section className={styles.contextSection} aria-label="Identity note">
      <div className={styles.contextHeading}>
        <UserRound aria-hidden="true" />
        <div><h4>Identity note</h4><p>The identity stored in this event remains immutable.</p></div>
      </div>
      {remapped ? (
        <p className={styles.identityNote}>
          Recorded as <strong>{activityActorLabel(item.recordedActor)}</strong>. Currently matched to <strong>{activityActorLabel(item.effectiveActor)}</strong> using today’s Member aliases.
        </p>
      ) : null}
      {item.actorDiagnostics.length > 0 ? (
        <ul className={styles.identityMessages}>
          {item.actorDiagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}-${diagnostic.message}`}>{diagnostic.message}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CopyValueButton({ label, value }: { label: string; value: string }) {
  return (
    <Button
      aria-label={`Copy ${label}: ${value}`}
      onClick={() => void navigator.clipboard?.writeText(value)}
      size="icon-xs"
      title={`Copy ${label}`}
      type="button"
      variant="ghost"
    >
      <Clipboard aria-hidden="true" data-icon="inline-start" />
    </Button>
  );
}

function TechnicalValue({
  label,
  value,
  mono = false,
  copy = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined}>
        <span>{value}</span>
        {copy ? <CopyValueButton label={label} value={value} /> : null}
      </dd>
    </div>
  );
}

function RawSubjectReferences({ item }: { item: ActivityItem }) {
  if (item.subjectCount === 0) return null;
  return (
    <section className={styles.rawReferences} aria-label="Raw subject references">
      <h5>Raw subject references</h5>
      {item.subjects.length > 0 ? (
        <ul>
          {item.subjects.map((subject, index) => (
            <li key={`${subject.kind}-${activitySubjectRawValue(subject)}-${index}`}>
              <span>{subject.kind === "entity" ? subject.entity.entityKind : subject.kind}</span>
              <code>{activitySubjectRawValue(subject)}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {item.subjectsTruncated ? (
        <p>Only {item.subjects.length} of {item.subjectCount} raw references are present in this bounded response.</p>
      ) : null}
    </section>
  );
}

function TechnicalDetails({ item, headline }: { item: ActivityItem; headline: string }) {
  const canonical = item.source === "activity" ? item : null;
  const projectNote = item.source === "legacy" ? item : null;
  const integrity = item.subjectsTruncated
    ? `${item.subjects.length} of ${item.subjectCount} subject references included`
    : `${item.subjectCount} subject ${item.subjectCount === 1 ? "reference" : "references"} included in full`;
  return (
    <Collapsible className={styles.technicalDetails}>
      <CollapsibleTrigger
        aria-label={`Technical details for ${headline}`}
        render={<Button size="sm" type="button" variant="ghost" />}
      >
        <Braces data-icon="inline-start" />
        Technical details
        <ChevronDown data-icon="inline-end" />
      </CollapsibleTrigger>
      <CollapsibleContent className={styles.technicalContent}>
        {canonical ? (
          <dl className={styles.technicalGrid}>
            <TechnicalValue label="Raw action" value={canonical.action} mono copy />
            <TechnicalValue label="Event ID" value={canonical.id} mono copy />
            <TechnicalValue label="Canonical source path" value={canonical.sourcePath} mono copy />
            <TechnicalValue label="Revision" value={canonical.revision} mono copy />
            <TechnicalValue label="Record origin" value={canonical.recordOrigin.kind === "workflow"
              ? `Workflow: ${canonical.recordOrigin.operation}`
              : canonical.recordOrigin.kind === "custom" ? "Direct/custom Activity record" : "Unknown for this older event"} />
            <TechnicalValue label="Stored label" value={canonical.label ?? "Not recorded"} />
            <TechnicalValue label="Recorded actor" value={activityActorLabel(canonical.recordedActor, true)} />
            <TechnicalValue label="Effective actor now" value={activityActorLabel(canonical.effectiveActor, true)} />
            <TechnicalValue
              label="Actor diagnostics"
              value={canonical.actorDiagnostics.length > 0
                ? canonical.actorDiagnostics.map((diagnostic) => diagnostic.path ? `${diagnostic.code} · ${diagnostic.path}` : diagnostic.code).join("; ")
                : "None recorded"}
              mono={canonical.actorDiagnostics.length > 0}
            />
            <TechnicalValue
              label="Workstream reference"
              value={canonical.workstream ? `${canonical.workstream.title ?? "Untitled Workstream"} · ${canonical.workstream.id}` : "Not recorded"}
              mono={canonical.workstream !== null}
            />
            <TechnicalValue label="Subject integrity" value={integrity} />
          </dl>
        ) : (
          <>
            <p className={styles.projectNoteBoundary}>This older project-log format does not record a verified actor or verified repository context.</p>
            <dl className={styles.technicalGrid}>
              <TechnicalValue label="Project-note kind" value={activityProjectNoteKind(item.action)} />
              <TechnicalValue label="Record ID" value={item.id} mono copy />
              <TechnicalValue label="Source path" value={item.sourcePath} mono copy />
              <TechnicalValue label="Source line" value={String(projectNote?.sourceLine ?? "Unknown")} mono />
              <TechnicalValue label="Message integrity" value={projectNote?.messageTruncated ? "Message preview was shortened" : "Message included in full"} />
              <TechnicalValue label="Subject integrity" value={integrity} />
            </dl>
          </>
        )}
        <RawSubjectReferences item={item} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ActivityEntryContext({
  accessibleName,
  item,
}: {
  accessibleName: string;
  item: ActivityItem;
}) {
  const canonical = item.source === "activity" ? item : null;
  const hasRelated = item.subjectCount > 0 || Boolean(canonical?.workstream?.title);
  const hasIdentity = canonical !== null
    && (!sameActivityActor(canonical.recordedActor, canonical.effectiveActor) || canonical.actorDiagnostics.length > 0);
  return (
    <div className={styles.activityContext}>
      {hasRelated ? <RelatedItems item={item} /> : null}
      {hasRelated && canonical ? <Separator /> : null}
      {canonical ? <RepositoryContext item={canonical} /> : null}
      {canonical && hasIdentity ? <Separator /> : null}
      {canonical && hasIdentity ? <IdentityContext item={canonical} /> : null}
      {(hasRelated || canonical) ? <Separator /> : null}
      <TechnicalDetails headline={accessibleName} item={item} />
    </div>
  );
}

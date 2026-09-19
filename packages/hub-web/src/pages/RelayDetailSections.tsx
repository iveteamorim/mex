import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Code2,
  ExternalLink,
  FilePenLine,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Send,
  UserCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  RelayDetail,
  RelayDraftDetail,
  RelayDraftInput,
  RelayEvidenceRef,
  TeamActorRef,
} from "../api/types";
import { Button } from "../components/primitives/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import { formatDate, sentenceCase } from "../components/ui";
import styles from "../styles/relay-detail-sections.module.css";

type RelayContextContent = Pick<RelayDraftInput, "decisions" | "changedFiles" | "code" | "evidence">;

type RelayDetailSectionsProps =
  | { detail: { kind: "relay"; relay: RelayDetail }; warnings?: ReactNode }
  | { detail: { kind: "draft"; draft: RelayDraftDetail }; warnings?: never };

function actorLabel(actor: TeamActorRef | null | undefined): string {
  if (actor?.kind === "member") return actor.displayName ?? "Team member";
  if (actor?.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown identity";
}

function actorTechnicalValue(actor: TeamActorRef): string {
  if (actor.kind === "member") return `memberId=${actor.memberId}`;
  if (actor.kind === "git") return `git name=${actor.name ?? "null"}; email=${actor.email ?? "null"}`;
  return "unknown";
}

function safeExternalUri(value: string): string | null {
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

function KnowledgeReference({ id, kind, title }: { id: string; kind: string; title?: string }) {
  const label = title ?? `Referenced ${sentenceCase(kind)}`;
  return /^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)
    ? <Link to={`/knowledge/${encodeURIComponent(id)}`}>{label}</Link>
    : <span>{label}</span>;
}

function CodeReference({ reference }: { reference: RelayDraftInput["code"][number] }) {
  if (reference.kind === "file") return <code>{reference.path}</code>;
  const validSymbolId = reference.symbolId.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(reference.symbolId);
  return validSymbolId
    ? <Link to={`/code/symbols/${encodeURIComponent(reference.symbolId)}`}>Open referenced code symbol</Link>
    : <span>Referenced code symbol</span>;
}

function RelayEvidenceValue({ evidence }: { evidence: RelayEvidenceRef }) {
  if (evidence.kind === "entity") {
    return <KnowledgeReference id={evidence.entity.id} kind={evidence.entity.kind} title={evidence.entity.title} />;
  }
  if (evidence.kind === "code") return <CodeReference reference={evidence.code} />;
  if (evidence.kind === "external") {
    const href = safeExternalUri(evidence.uri);
    return href === null ? <span>{evidence.label ?? "External evidence"}</span> : (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {evidence.label ?? evidence.uri}<ExternalLink aria-hidden="true" />
      </a>
    );
  }
  if (evidence.kind === "file") return <code>{evidence.path}</code>;
  if (evidence.kind === "commit") return <code>{evidence.hash}</code>;
  return <p>{evidence.note}</p>;
}

function RelayEvidenceIcon({ evidence }: { evidence: RelayEvidenceRef }) {
  if (evidence.kind === "entity") return <BookOpen aria-hidden="true" />;
  if (evidence.kind === "code") return <Code2 aria-hidden="true" />;
  if (evidence.kind === "commit") return <GitCommitHorizontal aria-hidden="true" />;
  if (evidence.kind === "external") return <ExternalLink aria-hidden="true" />;
  if (evidence.kind === "file") return <FileText aria-hidden="true" />;
  return <FilePenLine aria-hidden="true" />;
}

function RelayListSection({ items, title }: { items: readonly string[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <section className={styles.handoffSection}>
      <h3>{title}</h3>
      <ul className={styles.handoffList}>{items.map((item, index) => <li key={`${title}:${index}`}>{item}</li>)}</ul>
    </section>
  );
}

function RelatedRelayContext({
  relay,
  workstream,
}: {
  relay: RelayContextContent;
  workstream?: RelayDetail["workstream"];
}) {
  const hasContext = relay.decisions.length > 0
    || relay.changedFiles.length > 0
    || relay.code.length > 0
    || relay.evidence.length > 0
    || workstream != null;
  if (!hasContext) return null;
  return (
    <Collapsible className={styles.contextDetails}>
      <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
        <ChevronDown data-icon="inline-start" /> Related context
      </CollapsibleTrigger>
      <CollapsibleContent className={styles.contextContent}>
        {workstream ? (
          <section>
            <h4>Legacy Workstream</h4>
            <p>{workstream.title ?? "Recorded Workstream"}</p>
          </section>
        ) : null}
        {relay.decisions.length ? (
          <section>
            <h4>Decisions</h4>
            <ul className={styles.contextList}>{relay.decisions.map((decision, index) => (
              <li key={`${decision.id}:${index}`}><KnowledgeReference id={decision.id} kind={decision.kind} title={decision.title} /></li>
            ))}</ul>
          </section>
        ) : null}
        {relay.changedFiles.length ? (
          <section><h4>Files involved</h4><ul className={styles.contextList}>{relay.changedFiles.map((path) => <li key={path}><code>{path}</code></li>)}</ul></section>
        ) : null}
        {relay.code.length ? (
          <section><h4>Code references</h4><ul className={styles.contextList}>{relay.code.map((reference, index) => <li key={`${reference.kind}:${index}`}><CodeReference reference={reference} /></li>)}</ul></section>
        ) : null}
        {relay.evidence.length ? (
          <section>
            <h4>Evidence</h4>
            <ul className={styles.semanticEvidenceList}>{relay.evidence.map((evidence, index) => (
              <li key={`${evidence.kind}:${index}`}>
                <span className={styles.evidenceIcon}><RelayEvidenceIcon evidence={evidence} /></span>
                <div><RelayEvidenceValue evidence={evidence} /></div>
              </li>
            ))}</ul>
          </section>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PublicationRepository({ relay }: { relay: RelayDetail }) {
  const state = relay.publishedRepoState;
  if (state === null) return null;
  return (
    <section className={styles.repositorySection}>
      <div className={styles.repositoryHeading}>
        <GitBranch aria-hidden="true" />
        <h3>Repository when published</h3>
      </div>
      <dl>
        <div><dt>Branch</dt><dd>{state.branch ?? "Detached HEAD"}</dd></div>
        <div><dt>HEAD</dt><dd>{state.head === null ? "No committed HEAD recorded" : <code>{state.head.slice(0, 8)}</code>}</dd></div>
        <div><dt>Working tree</dt><dd>{state.dirty ? "Local changes present" : "Clean"}</dd></div>
        <div><dt>Observed</dt><dd>{formatDate(state.observedAt)}</dd></div>
      </dl>
      {state.dirty ? (
        <p className={styles.dirtyWarning} role="status">
          MEX recorded that local changes existed when this handoff was published. Their contents were not captured by the Relay.
        </p>
      ) : null}
    </section>
  );
}

function RawRelayContext({ relay }: { relay: RelayContextContent }) {
  const references = [
    ...relay.decisions.map((decision) => `decision · ${decision.kind} · ${decision.id}${decision.title ? ` · ${decision.title}` : ""}`),
    ...relay.changedFiles.map((path) => `changed file · ${path}`),
    ...relay.code.map((reference) => reference.kind === "file"
      ? `code file · ${reference.path}${reference.fingerprint ? ` · ${reference.fingerprint}` : ""}`
      : `code symbol · ${reference.symbolId}${reference.fingerprint ? ` · ${reference.fingerprint}` : ""}`),
    ...relay.evidence.map((evidence) => {
      if (evidence.kind === "entity") return `entity evidence · ${evidence.entity.kind} · ${evidence.entity.id}${evidence.entity.title ? ` · ${evidence.entity.title}` : ""}`;
      if (evidence.kind === "code") return evidence.code.kind === "file"
        ? `code evidence · file · ${evidence.code.path}${evidence.code.fingerprint ? ` · ${evidence.code.fingerprint}` : ""}`
        : `code evidence · symbol · ${evidence.code.symbolId}${evidence.code.fingerprint ? ` · ${evidence.code.fingerprint}` : ""}`;
      if (evidence.kind === "file") return `file evidence · ${evidence.path}`;
      if (evidence.kind === "commit") return `commit evidence · ${evidence.hash}`;
      if (evidence.kind === "external") return `external evidence · ${evidence.uri}${evidence.label ? ` · ${evidence.label}` : ""}`;
      return `manual evidence · ${evidence.note}`;
    }),
  ];
  if (references.length === 0) return null;
  return (
    <section>
      <h4>Raw related context</h4>
      <ul>{references.map((reference, index) => <li key={`${index}:${reference}`}><code>{reference}</code></li>)}</ul>
    </section>
  );
}

function RelayLifecycle({ relay }: { relay: RelayDetail }) {
  return (
    <section className={styles.lifecycleSection}>
      <h3>Lifecycle</h3>
      <ol>
        <li data-complete="true"><span><Send aria-hidden="true" /></span><div><strong>Published</strong><small>{actorLabel(relay.sender)} · {relay.publishedAt ? formatDate(relay.publishedAt) : "Legacy publication time unavailable"}</small></div></li>
        {relay.acknowledgedBy && relay.acknowledgedAt ? <li data-complete="true"><span><UserCheck aria-hidden="true" /></span><div><strong>Taken</strong><small>{actorLabel(relay.acknowledgedBy)} · {formatDate(relay.acknowledgedAt)}</small></div></li> : null}
        {relay.closedBy && relay.closedAt ? <li data-complete="true"><span><CheckCircle2 aria-hidden="true" /></span><div><strong>Closed</strong><small>{actorLabel(relay.closedBy)} · {formatDate(relay.closedAt)}</small></div></li> : null}
      </ol>
    </section>
  );
}

function RelayTechnicalDetails({ relay }: { relay: RelayDetail }) {
  const fingerprints = [
    ...relay.code.flatMap((reference) => reference.fingerprint ? [reference.fingerprint] : []),
    ...relay.evidence.flatMap((evidence) => evidence.kind === "code" && evidence.code.fingerprint ? [evidence.code.fingerprint] : []),
  ];
  return (
    <Collapsible className={styles.technicalDetails}>
      <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
        <ChevronDown data-icon="inline-start" /> Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className={styles.technicalContent}>
        <dl>
          <div><dt>Relay ID</dt><dd><code>{relay.ref.id}</code></dd></div>
          <div><dt>Source path</dt><dd><code>{relay.sourcePath}</code></dd></div>
          <div><dt>Relay revision</dt><dd><code>{relay.revision}</code></dd></div>
          <div><dt>Schema version</dt><dd>{relay.schemaVersion}</dd></div>
          {relay.workstream ? <div><dt>Legacy Workstream ID</dt><dd><code>{relay.workstream.id}</code></dd></div> : null}
          {relay.publishedRepoState ? (
            <>
              <div><dt>Publication branch</dt><dd><code>{relay.publishedRepoState.branch ?? "null"}</code></dd></div>
              <div><dt>Publication HEAD</dt><dd><code>{relay.publishedRepoState.head ?? "null"}</code></dd></div>
              <div><dt>Publication dirty</dt><dd><code>{String(relay.publishedRepoState.dirty)}</code></dd></div>
              <div><dt>Publication observed</dt><dd><code>{relay.publishedRepoState.observedAt}</code></dd></div>
            </>
          ) : null}
          <div><dt>Recorded sender</dt><dd><code>{actorTechnicalValue(relay.sender)}</code></dd></div>
          <div><dt>Recorded recipients</dt><dd>{relay.recipients.map((recipient, index) => {
            const value = actorTechnicalValue(recipient);
            return <code key={`${index}:${value}`}>{value}</code>;
          })}</dd></div>
          {relay.acknowledgedBy ? <div><dt>Recorded claimant</dt><dd><code>{actorTechnicalValue(relay.acknowledgedBy)}</code></dd></div> : null}
          {relay.closedBy ? <div><dt>Recorded closer</dt><dd><code>{actorTechnicalValue(relay.closedBy)}</code></dd></div> : null}
        </dl>
        {relay.publishedRepoState === null ? <p>This older Relay format did not record repository state at publication.</p> : null}
        <RawRelayContext relay={relay} />
        {fingerprints.length ? <section><h4>Fingerprints</h4><ul>{fingerprints.map((fingerprint, index) => <li key={`${index}:${fingerprint}`}><code>{fingerprint}</code></li>)}</ul></section> : null}
        {relay.diagnostics.length ? <section><h4>Diagnostics</h4><ul>{relay.diagnostics.map((diagnostic) => <li key={`${diagnostic.code}:${diagnostic.message}`}><code>{diagnostic.code}</code> {diagnostic.message}</li>)}</ul></section> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RelaySections({ relay, warnings }: { relay: RelayDetail; warnings?: ReactNode }) {
  return (
    <div className={styles.semanticDetail}>
      {warnings ? <div className={styles.warningSlot}>{warnings}</div> : null}
      <PublicationRepository relay={relay} />
      <RelayListSection items={relay.nextActions} title="What to do next" />
      <RelayListSection items={relay.inProgress} title="Where things stand" />
      <RelayListSection items={relay.blockers} title="Blockers" />
      <RelayListSection items={relay.unresolvedQuestions} title="Questions to resolve" />
      <RelayListSection items={relay.completed} title="Already completed" />
      <RelatedRelayContext relay={relay} workstream={relay.workstream} />
      <RelayLifecycle relay={relay} />
      <RelayTechnicalDetails relay={relay} />
    </div>
  );
}

function DraftSections({ draft }: { draft: RelayDraftDetail }) {
  return (
    <div className={styles.semanticDetail}>
      <RelayListSection items={draft.input.nextActions} title="What to do next" />
      <RelayListSection items={draft.input.inProgress} title="Where things stand" />
      <RelayListSection items={draft.input.blockers} title="Blockers" />
      <RelayListSection items={draft.input.unresolvedQuestions} title="Questions to resolve" />
      <RelayListSection items={draft.input.completed} title="Already completed" />
      <RelatedRelayContext relay={draft.input} />
      <Collapsible className={styles.technicalDetails}>
        <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
          <ChevronDown data-icon="inline-start" /> Technical details
        </CollapsibleTrigger>
        <CollapsibleContent className={styles.technicalContent}>
          <dl>
            <div><dt>Draft ID</dt><dd><code>{draft.id}</code></dd></div>
            <div><dt>Draft revision</dt><dd><code>{draft.revision}</code></dd></div>
            <div><dt>Recipient IDs</dt><dd>{draft.input.recipients.map((recipient, index) => <code key={`${index}:${recipient.memberId}`}>{recipient.memberId}</code>)}</dd></div>
          </dl>
          <RawRelayContext relay={draft.input} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export default function RelayDetailSections({ detail, warnings }: RelayDetailSectionsProps) {
  return detail.kind === "relay"
    ? <RelaySections relay={detail.relay} warnings={warnings} />
    : <DraftSections draft={detail.draft} />;
}

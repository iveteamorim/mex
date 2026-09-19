import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  ExternalLink,
  FileText,
  FilePenLine,
  GitCommitHorizontal,
  GitPullRequestArrow,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  GraphSymbolIdSchema,
  InboxDraftIdSchema,
  InboxProposalIdSchema,
  WikiEntityIdSchema,
} from "@mex/hub-contracts";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  CapabilityStatus,
  InboxDraftDetail,
  InboxDraftInput,
  InboxDraftSummary,
  InboxEvidenceRef,
  InboxOperationApplyResponse,
  InboxProposalDetail,
  InboxProposalState,
  InboxProposalSummary,
  InboxEntityKind,
  HomeResponse,
  TeamActorRef,
  TeamCurrentActorResponse,
  WikiEntityDetailResponse,
} from "../api/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/primitives/alert";
import { Button } from "../components/primitives/button";
import { Badge } from "../components/primitives/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import { Skeleton } from "../components/primitives/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/primitives/tabs";
import { ErrorState, PageHeader, StatePanel, formatDate, sentenceCase } from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import styles from "../styles/inbox.module.css";
import { isInboxCreate, isInboxUpdate, type InboxUpdateChange } from "../lib/inbox-change";
import type { AppliedInboxAction, ReviewAction } from "./InboxMutationDialogs";
import type { InboxOverflowMenuProps } from "./InboxOverflowMenu";

const InboxMutationDialogs = lazy(() => import("./InboxMutationDialogs"));
const InboxOverflowMenu = lazy(() => import("./InboxOverflowMenu"));

const INBOX_PAGE_SIZE = 25;
const actionableProposalStates: readonly InboxProposalState[] = ["pending", "stale"];

type Selection = { kind: "draft"; id: string } | { kind: "proposal"; id: string };
type CreateChange = Extract<InboxDraftInput["change"], { kind: "spec.create" }>;
type CreateRelation = NonNullable<CreateChange["relation"]>;

function afterDialogUnmount(callback: () => void): void {
  queueMicrotask(() => queueMicrotask(callback));
}

function actorLabel(actor: TeamActorRef): string {
  if (actor.kind === "member") return actor.displayName ?? "Team member";
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown identity";
}

export function inboxActorMatches(current: TeamActorRef, author: TeamActorRef): boolean {
  if (current.kind === "unknown" || author.kind === "unknown" || current.kind !== author.kind) {
    return false;
  }
  if (current.kind === "member" && author.kind === "member") {
    return current.memberId === author.memberId;
  }
  return current.kind === "git"
    && author.kind === "git"
    && current.name === author.name
    && current.email === author.email;
}

function OnDemandInboxOverflowMenu({
  actions,
  ariaLabel,
  groupLabel,
}: Omit<InboxOverflowMenuProps, "focusFirstItem" | "triggerContent">) {
  const [activated, setActivated] = useState(false);
  const [focusFirstItem, setFocusFirstItem] = useState(false);
  const triggerContent = <><MoreHorizontal data-icon="inline-start" /> More</>;
  if (!activated) {
    return (
      <Button
        aria-haspopup="menu"
        aria-label={ariaLabel}
        onClick={(event) => {
          setFocusFirstItem(event.detail === 0);
          setActivated(true);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        {triggerContent}
      </Button>
    );
  }
  return (
    <Suspense
      fallback={(
        <Button aria-label={ariaLabel} disabled size="sm" type="button" variant="outline">
          {triggerContent}
        </Button>
      )}
    >
      <InboxOverflowMenu
        actions={actions}
        ariaLabel={ariaLabel}
        focusFirstItem={focusFirstItem}
        groupLabel={groupLabel}
        triggerContent={triggerContent}
      />
    </Suspense>
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
            <ExternalLink aria-hidden="true" />
          </a>
        );
  }
  if (item.kind === "commit") return <code>{item.hash}</code>;
  if (item.kind === "file") return <code>{item.path}</code>;
  return <p>{item.note}</p>;
}

function EvidenceIcon({ item }: { item: InboxEvidenceRef }) {
  if (item.kind === "entity") return <BookOpen aria-hidden="true" />;
  if (item.kind === "code") return <Code2 aria-hidden="true" />;
  if (item.kind === "commit") return <GitCommitHorizontal aria-hidden="true" />;
  if (item.kind === "file") return <FileText aria-hidden="true" />;
  if (item.kind === "external") return <ExternalLink aria-hidden="true" />;
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

function relationPhrase(relation: CreateRelation): string {
  if (relation.type === "derived_from") return "Derived from";
  if (relation.type === "constrained_by") return "Constrained by";
  if (relation.type === "verified_by") return "Verifies";
  return "Refines";
}

function RelatedKnowledge({ input }: { input: InboxDraftInput }) {
  const change = input.change;
  if (!isInboxCreate(change)) return null;
  const relation = change.kind === "spec.create" ? change.relation : undefined;
  const evidenceTitles = new Map(
    input.evidence.flatMap((item) => (
      item.kind === "entity" && item.entity.title
        ? [[item.entity.id, item.entity.title] as const]
        : []
    )),
  );
  const topics = (change.topics ?? []).flatMap((id) => {
    const title = relation?.target.id === id && relation.target.title
      ? relation.target.title
      : evidenceTitles.get(id);
    return title ? [{ id, title }] : [];
  });
  if (relation === undefined && topics.length === 0) return null;
  const knowledgeLink = (id: string, label: string) => {
    const parsed = WikiEntityIdSchema.safeParse(id);
    return parsed.success
      ? <Link to={`/knowledge/${encodeURIComponent(parsed.data)}`}>{label}</Link>
      : <span>{label}</span>;
  };
  return (
    <section>
      <h3>Related knowledge</h3>
      <ul className={styles.relationshipList}>
        {topics.map((topic) => (
          <li key={`topic:${topic.id}`}>
            <span>Topic</span>
            {knowledgeLink(topic.id, topic.title)}
          </li>
        ))}
        {relation ? (
          <li>
            <span>{relationPhrase(relation)}</span>
            {knowledgeLink(
              relation.target.id,
              relation.target.title ?? `Related ${sentenceCase(relation.target.kind)}`,
            )}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function ComparisonValue({
  children,
  empty = "Not set",
}: {
  children: string | null | undefined;
  empty?: string;
}) {
  return <p>{children === null || children === undefined || children === "" ? empty : children}</p>;
}

function UpdateComparison({
  change,
  current,
  currentError,
  currentPending,
}: {
  change: InboxUpdateChange;
  current?: WikiEntityDetailResponse;
  currentError?: string;
  currentPending?: boolean;
}) {
  const fields = [
    ...Object.hasOwn(change.patch, "title")
      ? [{ name: "Title", current: current?.entity.title, proposed: change.patch.title }]
      : [],
    ...Object.hasOwn(change.patch, "summary")
      ? [{ name: "Summary", current: current?.entity.summary, proposed: change.patch.summary, empty: "No summary" }]
      : [],
    ...Object.hasOwn(change.patch, "body")
      ? [{ name: "Body", current: current?.body.content, proposed: change.patch.body }]
      : [],
  ];
  return (
    <div className={styles.updatePresentation}>
      <p className={styles.targetCopy}>
        Updates <strong>{change.target.title ?? current?.entity.title ?? sentenceCase(change.target.kind)}</strong>
      </p>
      {currentPending ? (
        <div className={styles.comparisonLoading}>
          <Skeleton /><Skeleton /><Skeleton />
        </div>
      ) : null}
      {currentError ? (
        <Alert className={styles.readWarning}>
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Current knowledge content could not be read</AlertTitle>
          <AlertDescription>
            Proposed values remain available below. The approval preview is still the final freshness authority. {currentError}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className={styles.comparisonStack}>
        {fields.map((field) => (
          <section key={field.name} aria-label={`${field.name} comparison`}>
            <h4>{field.name}</h4>
            <div>
              <article>
                <span>Current</span>
                {current ? <ComparisonValue empty={field.empty} children={field.current} /> : <p className={styles.unavailableValue}>Unavailable</p>}
              </article>
              <article>
                <span>Proposed</span>
                <ComparisonValue empty={field.empty} children={field.proposed} />
              </article>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ChangeDetail({
  current,
  currentError,
  currentPending,
  input,
}: {
  current?: WikiEntityDetailResponse;
  currentError?: string;
  currentPending?: boolean;
  input: InboxDraftInput;
}) {
  const change = input.change;
  return (
    <div className={styles.semanticSections}>
      <section>
        <h3>What will change</h3>
        {isInboxCreate(change) ? (
          <div className={styles.createPresentation}>
            <dl className={styles.humanFacts}>
              <div><dt>Entity type</dt><dd>{sentenceCase(change.entityKind)}</dd></div>
              <div><dt>Lifecycle</dt><dd>{sentenceCase(change.status)}</dd></div>
            </dl>
            <h4>{change.title}</h4>
            {change.summary !== undefined && change.summary !== "" ? <p className={styles.summaryCopy}>{change.summary}</p> : null}
            <div className={styles.bodyProse}>{change.body}</div>
          </div>
        ) : (
          <UpdateComparison
            change={change}
            current={current}
            currentError={currentError}
            currentPending={currentPending}
          />
        )}
      </section>
      <section>
        <h3>Why this change</h3>
        <p className={styles.prose}>{input.rationale}</p>
      </section>
      <section>
        <h3>Evidence</h3>
        <EvidenceList evidence={input.evidence} />
      </section>
      <RelatedKnowledge input={input} />
    </div>
  );
}

function TechnicalDetails({
  draft,
  input,
  proposal,
}: {
  draft?: InboxDraftDetail;
  input: InboxDraftInput;
  proposal?: InboxProposalDetail;
}) {
  const rawEvidence = input.evidence.filter(
    (item): item is Extract<InboxEvidenceRef, { kind: "entity" | "code" }> => (
      item.kind === "entity" || item.kind === "code"
    ),
  );
  return (
    <Collapsible className={styles.technicalDetails}>
      <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
        <ChevronDown data-icon="inline-start" /> Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className={styles.technicalContent}>
        <dl>
          {proposal ? <div><dt>Proposal ID</dt><dd><code>{proposal.ref.id}</code></dd></div> : null}
          {proposal ? <div><dt>Source path</dt><dd><code>{proposal.sourcePath}</code></dd></div> : null}
          {proposal ? <div><dt>Proposal revision</dt><dd><code>{proposal.revision}</code></dd></div> : null}
          {draft ? <div><dt>Draft ID</dt><dd><code>{draft.id}</code></dd></div> : null}
          {draft ? <div><dt>Draft revision</dt><dd><code>{draft.revision}</code></dd></div> : null}
        </dl>
        {input.targetRevisions.length > 0 ? (
          <section>
            <h4>Exact dependency revisions</h4>
            <ul className={styles.revisionList}>
              {input.targetRevisions.map((item) => (
                <li key={item.target.id}>
                  <code>{item.target.id}</code>
                  <span>Semantic revision {item.semanticRevision}</span>
                  <code>{item.revision}</code>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {isInboxCreate(input.change) && (input.change.topics?.length || (input.change.kind === "spec.create" && input.change.relation)) ? (
          <section>
            <h4>Stored relationships</h4>
            <ul className={styles.technicalList}>
              {(input.change.topics ?? []).map((id) => <li key={id}>Topic <code>{id}</code></li>)}
              {input.change.kind === "spec.create" && input.change.relation ? (
                <li>{input.change.relation.type} <code>{input.change.relation.target.id}</code></li>
              ) : null}
            </ul>
          </section>
        ) : null}
        {rawEvidence.length > 0 ? (
          <section>
            <h4>Raw evidence identifiers</h4>
            <ul className={styles.technicalList}>
              {rawEvidence.map((item, index) => (
                <li key={index}>
                  {item.kind === "entity" ? <code>{item.entity.id}</code>
                    : item.code.kind === "symbol" ? <code>{item.code.symbolId}</code>
                      : <code>{item.code.path}</code>}
                  {item.kind === "code" && item.code.fingerprint ? <code>{item.code.fingerprint}</code> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function DraftDetail({
  current,
  currentError,
  currentPending,
  draft,
  draftMutation,
  proposalMutation,
  specApproval,
  onEdit,
  onAction,
}: {
  current?: WikiEntityDetailResponse;
  currentError?: string;
  currentPending?: boolean;
  draft: InboxDraftDetail;
  draftMutation: CapabilityStatus;
  proposalMutation: CapabilityStatus;
  specApproval: CapabilityStatus;
  onEdit(trigger: HTMLButtonElement): void;
  onAction(action: ReviewAction, trigger: HTMLButtonElement): void;
}) {
  const publishUnavailable = [proposalMutation, specApproval].find(
    (capability) => capability.availability === "unavailable",
  );
  return (
    <>
      <CardHeader className={styles.detailHeader}>
        <div>
          <div className={styles.detailBadges}>
            <Badge variant="outline">Private draft</Badge>
            <Badge variant="secondary">{changeLabel(draft.changeKind, draft.entityKind)}</Badge>
          </div>
          <CardTitle><h2>{draft.title}</h2></CardTitle>
          <CardDescription>Only available in this checkout.</CardDescription>
        </div>
        <CardAction><Badge variant="outline">Local only</Badge></CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        <div className={styles.proposalActionBar} aria-label="Draft actions" role="group">
          <Button
            aria-describedby={publishUnavailable ? "inbox-publish-unavailable" : undefined}
            disabled={publishUnavailable !== undefined}
            onClick={(event) => onAction({ kind: "inbox.publish", draft }, event.currentTarget)}
            size="sm"
            type="button"
          >
            <Send data-icon="inline-start" /> Publish for review
          </Button>
          <Button
            aria-describedby={draftMutation.availability === "unavailable" ? "inbox-draft-edit-unavailable" : undefined}
            disabled={draftMutation.availability === "unavailable"}
            onClick={(event) => onEdit(event.currentTarget)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Pencil data-icon="inline-start" /> Edit wording
          </Button>
          <OnDemandInboxOverflowMenu
            actions={[{
              capability: draftMutation,
              label: "Discard draft…",
              onSelect: (trigger) => onAction({ kind: "inbox.draft.delete", draft }, trigger),
              variant: "destructive",
            }]}
            ariaLabel="More draft actions"
            groupLabel="Draft actions"
          />
          {publishUnavailable ? (
            <p className={styles.actionUnavailable} id="inbox-publish-unavailable" role="status">
              Publication is unavailable: {publishUnavailable.reason}
            </p>
          ) : null}
          {draftMutation.availability === "unavailable" ? (
            <p className={styles.actionUnavailable} id="inbox-draft-edit-unavailable" role="status">
              Editing and discarding are unavailable: {draftMutation.reason}
            </p>
          ) : null}
        </div>
        <ChangeDetail
          current={current}
          currentError={currentError}
          currentPending={currentPending}
          input={draft.input}
        />
        <TechnicalDetails draft={draft} input={draft.input} />
      </CardContent>
    </>
  );
}

function ProposalActions({
  identity,
  identityError,
  onAction,
  proposal,
  proposalMutation,
  specApproval,
}: {
  identity?: TeamCurrentActorResponse;
  identityError?: boolean;
  onAction(action: ReviewAction, trigger: HTMLButtonElement): void;
  proposal: InboxProposalDetail;
  proposalMutation: CapabilityStatus;
  specApproval: CapabilityStatus;
}) {
  const identityLoading = identity === undefined && !identityError;
  const identityUnknown = Boolean(identityError || identity?.actor.kind === "unknown");
  const ownProposal = Boolean(
    !identityLoading
      && !identityUnknown
      && identity
      && inboxActorMatches(identity.actor, proposal.author),
  );
  if (identityLoading) {
    return (
      <div className={styles.actionContext} role="status">
        <Clock3 aria-hidden="true" /> Checking who can review this proposal…
      </div>
    );
  }

  if (proposal.state === "stale") {
    return (
      <div className={styles.proposalActionBar} aria-label="Proposal review actions" role="group">
        <div className={styles.actionContext}>
          <AlertTriangle aria-hidden="true" />
          {ownProposal
            ? "This proposal needs fresh knowledge references before it can return to review."
            : "Its author or their agent should refresh this proposal against current knowledge content."}
        </div>
        {ownProposal ? (
          <OnDemandInboxOverflowMenu
            actions={[{
              capability: specApproval,
              label: "Repair manually…",
              onSelect: (trigger) => onAction({ kind: "inbox.repair", proposal }, trigger),
            }]}
            ariaLabel="More proposal actions"
            groupLabel="Advanced action"
          />
        ) : null}
      </div>
    );
  }

  if (proposal.state !== "pending") return null;

  if (ownProposal) {
    return (
      <div className={styles.proposalActionBar} aria-label="Proposal review actions" role="group">
        <div className={styles.waitingForReview}>
          <Clock3 aria-hidden="true" />
          <span><strong>Waiting for teammate review</strong><small>Independent review is the recommended path.</small></span>
        </div>
        <OnDemandInboxOverflowMenu
          actions={[
            {
              capability: specApproval,
              label: "Approve without teammate review…",
              onSelect: (trigger) => onAction(
                { kind: "inbox.approve", proposal, selfApproval: true },
                trigger,
              ),
            },
            {
              capability: proposalMutation,
              label: "Withdraw proposal…",
              onSelect: (trigger) => onAction({ kind: "inbox.withdraw", proposal }, trigger),
              variant: "destructive",
            },
          ]}
          ariaLabel="More proposal actions"
          groupLabel="Advanced actions"
        />
      </div>
    );
  }

  return (
    <div className={styles.proposalActionBar} aria-label="Proposal review actions" role="group">
      <div className={styles.primaryActionStack}>
        <Button
          aria-describedby={specApproval.availability === "unavailable" ? "inbox-approve-unavailable" : undefined}
          disabled={specApproval.availability === "unavailable"}
          onClick={(event) => onAction({ kind: "inbox.approve", proposal }, event.currentTarget)}
          size="sm"
          type="button"
        >
          <CheckCircle2 data-icon="inline-start" /> Approve change
        </Button>
        {identity?.actor.kind === "git" ? (
          <span className={styles.approvingIdentity}>Approving as {actorLabel(identity.actor)}</span>
        ) : null}
      </div>
      <OnDemandInboxOverflowMenu
        actions={[
          {
            capability: proposalMutation,
            label: "Decline proposal…",
            onSelect: (trigger) => onAction({ kind: "inbox.reject", proposal }, trigger),
            variant: "destructive",
          },
          {
            capability: specApproval,
            label: "Mark as needs refresh…",
            onSelect: (trigger) => onAction({ kind: "inbox.mark-stale", proposal }, trigger),
          },
        ]}
        ariaLabel="More proposal actions"
        groupLabel="More actions"
      />
      {specApproval.availability === "unavailable" ? (
        <p className={styles.actionUnavailable} id="inbox-approve-unavailable" role="status">
          Approval is unavailable: {specApproval.reason}
        </p>
      ) : null}
    </div>
  );
}

function ProposalDetail({
  proposalMutation,
  specApproval,
  current,
  currentError,
  currentPending,
  identity,
  identityError,
  onAction,
  proposal,
}: {
  proposalMutation: CapabilityStatus;
  specApproval: CapabilityStatus;
  current?: WikiEntityDetailResponse;
  currentError?: string;
  currentPending?: boolean;
  identity?: TeamCurrentActorResponse;
  identityError?: boolean;
  onAction(action: ReviewAction, trigger: HTMLButtonElement): void;
  proposal: InboxProposalDetail;
}) {
  const terminal = proposal.state === "approved" || proposal.state === "rejected" || proposal.state === "withdrawn";
  const identityUnknown = identityError || identity?.actor.kind === "unknown";
  return (
    <>
      <CardHeader className={styles.detailHeader}>
        <div>
          <div className={styles.detailBadges}>
            <Badge variant="outline">Knowledge change</Badge>
            <Badge variant="secondary">{changeLabel(proposal.changeKind, proposal.entityKind)}</Badge>
          </div>
          <CardTitle><h2>{proposal.title}</h2></CardTitle>
          <CardDescription>Published by {actorLabel(proposal.author)}</CardDescription>
        </div>
        <CardAction>
          <Badge variant={proposal.state === "stale" ? "outline" : "secondary"}>
            {proposalStateLabel(proposal.state)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        {identityUnknown ? (
          <Alert className={styles.identityWarning}>
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Team identity is not set</AlertTitle>
            <AlertDescription>
              MEX cannot reliably tell which proposals are yours. You can still review this change, or <Link to="/members">set your identity in Team</Link>.
            </AlertDescription>
          </Alert>
        ) : null}
        {proposal.state === "stale" ? (
          <Alert className={styles.staleWarning}>
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Needs refresh</AlertTitle>
            <AlertDescription>The referenced knowledge content changed after this proposal was published.</AlertDescription>
          </Alert>
        ) : null}
        {!terminal ? (
          <ProposalActions
            identity={identity}
            identityError={identityError}
            onAction={onAction}
            proposal={proposal}
            proposalMutation={proposalMutation}
            specApproval={specApproval}
          />
        ) : (
          <div className={styles.terminalNote}>
            <ShieldCheck aria-hidden="true" />
            <p><strong>Immutable review history.</strong> Terminal proposals cannot be edited or reviewed again.</p>
          </div>
        )}
        {proposal.reviewRationale ? (
          <section className={styles.reviewDecision}>
            <p className={styles.sectionEyebrow}>Recorded decision</p>
            <p>{proposal.reviewRationale}</p>
            <small>{proposal.reviewer ? actorLabel(proposal.reviewer) : "Reviewer unavailable"} · {formatDate(proposal.reviewedAt)}</small>
          </section>
        ) : null}
        <ChangeDetail
          current={current}
          currentError={currentError}
          currentPending={currentPending}
          input={{
            change: proposal.change,
            rationale: proposal.rationale,
            evidence: proposal.evidence,
            targetRevisions: proposal.targetRevisions,
          }}
        />
        <TechnicalDetails
          input={{
            change: proposal.change,
            rationale: proposal.rationale,
            evidence: proposal.evidence,
            targetRevisions: proposal.targetRevisions,
          }}
          proposal={proposal}
        />
      </CardContent>
    </>
  );
}
type InboxView = "review" | "drafts";

function inboxView(value: string | null): InboxView {
  return value === "drafts" ? "drafts" : "review";
}

function changeLabel(
  changeKind: InboxDraftSummary["changeKind"],
  entityKind: InboxEntityKind,
): string {
  const label = entityKind === "spec" ? "Spec" : entityKind.replaceAll("_", " ");
  return `${changeKind.endsWith(".create") ? "New" : "Update"} ${label}`;
}

function proposalStateLabel(state: InboxProposalState): string {
  return state === "pending" ? "Needs review"
    : state === "stale" ? "Needs refresh"
      : sentenceCase(state);
}

interface ProposalGroup {
  key: "needs-review" | "waiting" | "needs-refresh";
  title: string;
  rows: InboxProposalSummary[];
}

export function groupInboxProposals(
  rows: InboxProposalSummary[],
  current: TeamActorRef | undefined,
): ProposalGroup[] {
  const identityResolved = current !== undefined && current.kind !== "unknown";
  const groups: ProposalGroup[] = identityResolved ? [
    {
      key: "needs-review",
      title: "Needs your review",
      rows: rows.filter((row) => row.state === "pending" && !inboxActorMatches(current, row.author)),
    },
    {
      key: "waiting",
      title: "Waiting for teammate",
      rows: rows.filter((row) => row.state === "pending" && inboxActorMatches(current, row.author)),
    },
    {
      key: "needs-refresh",
      title: "Needs refresh",
      rows: rows.filter((row) => row.state === "stale"),
    },
  ] : [
    {
      key: "needs-review",
      title: "Needs review",
      rows: rows.filter((row) => row.state === "pending"),
    },
    {
      key: "needs-refresh",
      title: "Needs refresh",
      rows: rows.filter((row) => row.state === "stale"),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

function QueueSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={styles.queueSkeleton} aria-label="Loading Inbox queue">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index}>
          <Skeleton className={styles.skeletonIcon} />
          <span>
            <Skeleton className={styles.skeletonLabel} />
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonMeta} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ProposalQueue({
  error,
  groups,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  onLoadMore,
  onSelect,
  selectedId,
  sourceBounded,
}: {
  error: unknown;
  groups: ProposalGroup[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  onLoadMore(): void;
  onSelect(id: string): void;
  selectedId: string | null;
  sourceBounded: boolean;
}) {
  const rowCount = groups.reduce((count, group) => count + group.rows.length, 0);
  return (
    <Card className={styles.queuePane} role="region" aria-labelledby="proposal-queue-heading">
      <CardHeader className={styles.queuePaneHeader}>
        <div>
          <CardTitle><h2 id="proposal-queue-heading">Knowledge changes</h2></CardTitle>
          <CardDescription>Select a change to review its meaningful content.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className={styles.queuePaneContent}>
        {isPending ? (
          <QueueSkeleton />
        ) : error && rowCount === 0 ? (
          <ErrorState error={error} />
        ) : rowCount === 0 ? (
          <Empty className={styles.emptyQueue}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><CheckCircle2 aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>You’re all caught up</EmptyTitle>
              <EmptyDescription>No knowledge changes currently need review.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/activity" />} size="sm" variant="outline">Open Activity</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {groups.map((group) => (
              <section className={styles.queueGroup} aria-labelledby={`proposal-group-${group.key}`} key={group.key}>
                <h3 id={`proposal-group-${group.key}`}>{group.title}</h3>
                <ItemGroup className={styles.queueItems}>
                  {group.rows.map((proposal) => (
                    <div key={proposal.ref.id} role="listitem">
                      <Item
                        aria-current={selectedId === proposal.ref.id ? "true" : undefined}
                        className={styles.queueItem}
                        data-inbox-proposal-id={proposal.ref.id}
                        data-selected={selectedId === proposal.ref.id ? "true" : undefined}
                        onClick={() => onSelect(proposal.ref.id)}
                        render={<button type="button" />}
                        size="sm"
                        variant="default"
                      >
                        <ItemMedia className={styles.queueItemIcon} variant="icon">
                          <GitPullRequestArrow aria-hidden="true" />
                        </ItemMedia>
                        <ItemContent>
                          <span className={styles.changeLabel}>{changeLabel(proposal.changeKind, proposal.entityKind)}</span>
                          <ItemTitle>{proposal.title}</ItemTitle>
                          <ItemDescription>
                            Published by {actorLabel(proposal.author)}
                            <span className={styles.narrowQueueState}> · {proposalStateLabel(proposal.state)}</span>
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Badge className={styles.queueStateBadge} variant={proposal.state === "stale" ? "outline" : "secondary"}>
                            {proposalStateLabel(proposal.state)}
                          </Badge>
                          <ChevronRight aria-hidden="true" />
                        </ItemActions>
                      </Item>
                    </div>
                  ))}
                </ItemGroup>
              </section>
            ))}
            {error ? <div className={styles.paginationError}><ErrorState error={error} /></div> : null}
            {hasNextPage ? (
              <Button disabled={isFetchingNextPage} onClick={onLoadMore} size="sm" type="button" variant="outline">
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : sourceBounded ? (
              <p className={styles.boundNote}>The bounded review queue limit was reached.</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DraftQueue({
  draftMutation,
  error,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  onCreate,
  onLoadMore,
  onSelect,
  rows,
  selectedId,
  sourceBounded,
}: {
  draftMutation: CapabilityStatus;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  onCreate(event: MouseEvent<HTMLButtonElement>): void;
  onLoadMore(): void;
  onSelect(id: string): void;
  rows: InboxDraftSummary[];
  selectedId: string | null;
  sourceBounded: boolean;
}) {
  return (
    <Card className={styles.queuePane} role="region" aria-labelledby="draft-queue-heading">
      <CardHeader className={styles.queuePaneHeader}>
        <div>
          <CardTitle><h2 id="draft-queue-heading">On this device</h2></CardTitle>
          <CardDescription>Private drafts in this checkout.</CardDescription>
        </div>
        <CardAction>
          <Button
            aria-describedby={draftMutation.availability === "unavailable" ? "inbox-create-unavailable" : undefined}
            disabled={draftMutation.availability === "unavailable"}
            onClick={onCreate}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus data-icon="inline-start" /> Create manually
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className={styles.queuePaneContent}>
        {draftMutation.availability === "unavailable" ? (
          <p className={styles.queueCapabilityReason} id="inbox-create-unavailable" role="status">
            Manual draft actions are unavailable: {draftMutation.reason}
          </p>
        ) : null}
        {isPending ? (
          <QueueSkeleton rows={3} />
        ) : error && rows.length === 0 ? (
          <ErrorState error={error} />
        ) : rows.length === 0 ? (
          <Empty className={styles.emptyQueue}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><FilePenLine aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No drafts on this device</EmptyTitle>
              <EmptyDescription>Coding agents can prepare private MEX drafts for you to review here.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                disabled={draftMutation.availability === "unavailable"}
                onClick={onCreate}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Plus data-icon="inline-start" /> Create manually
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <ItemGroup className={styles.queueItems}>
              {rows.map((draft) => (
                <div key={draft.id} role="listitem">
                  <Item
                    aria-current={selectedId === draft.id ? "true" : undefined}
                    className={styles.queueItem}
                    data-inbox-draft-id={draft.id}
                    data-selected={selectedId === draft.id ? "true" : undefined}
                    onClick={() => onSelect(draft.id)}
                    render={<button type="button" />}
                    size="sm"
                    variant="default"
                  >
                    <ItemMedia className={styles.queueItemIcon} variant="icon">
                      <FilePenLine aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <span className={styles.changeLabel}>{changeLabel(draft.changeKind, draft.entityKind)}</span>
                      <ItemTitle>{draft.title}</ItemTitle>
                      <ItemDescription>Private draft · {formatDate(draft.updatedAt)}</ItemDescription>
                    </ItemContent>
                    <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
                  </Item>
                </div>
              ))}
            </ItemGroup>
            {error ? <div className={styles.paginationError}><ErrorState error={error} /></div> : null}
            {hasNextPage ? (
              <Button disabled={isFetchingNextPage} onClick={onLoadMore} size="sm" type="button" variant="outline">
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : sourceBounded ? (
              <p className={styles.boundNote}>The bounded draft list limit was reached.</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function InboxPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities, home } = useOutletContext<{
    capabilities?: CapabilitiesResponse;
    home?: HomeResponse;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = inboxView(searchParams.get("view"));
  const proposalParam = view === "review" ? searchParams.get("proposal") : null;
  const draftParam = view === "drafts" ? searchParams.get("draft") : null;
  const parsedProposal = proposalParam === null ? null : InboxProposalIdSchema.safeParse(proposalParam);
  const parsedDraft = draftParam === null ? null : InboxDraftIdSchema.safeParse(draftParam);
  const selectedProposalId = parsedProposal?.success ? parsedProposal.data : null;
  const selectedDraftId = parsedDraft?.success ? parsedDraft.data : null;
  const invalidProposalSelection = proposalParam !== null && parsedProposal?.success === false;
  const invalidDraftSelection = draftParam !== null && parsedDraft?.success === false;
  const [editor, setEditor] = useState<{ draft: InboxDraftDetail | null } | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [status, setStatus] = useState("");
  const [gitNotice, setGitNotice] = useState<"approval" | "publication" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [reconcilingRemoval, setReconcilingRemoval] = useState(false);
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const gitNoticeRef = useRef<HTMLDivElement | null>(null);
  const refreshActionRef = useRef<HTMLButtonElement | null>(null);
  const readAvailable = capabilities?.inbox.read.availability === "available";
  const currentActor = useQuery({
    queryKey: ["actor", "current"],
    queryFn: () => api.getCurrentActor(),
    enabled: readAvailable,
    retry: false,
  });
  const trustedCurrentIdentity = currentActor.isError ? undefined : currentActor.data;
  const exactReviewCount = home?.attention.inbox.availability === "available"
    ? home.attention.inbox.teamReviewCount
    : null;
  const searchKey = searchParams.toString();
  const resolveOperationFinalFocus = () => operationTrigger.current;
  const focusAppliedStatus = () => {
    if (gitNoticeRef.current) gitNoticeRef.current.focus({ preventScroll: true });
    else statusRef.current?.focus({ preventScroll: true });
    operationTrigger.current = null;
  };

  const drafts = useInfiniteQuery({
    queryKey: ["inbox", "drafts"],
    queryFn: ({ pageParam }) => api.getInboxDrafts({
      limit: INBOX_PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: Boolean(readAvailable && view === "drafts"),
    retry: false,
  });
  const proposals = useInfiniteQuery({
    queryKey: ["inbox", "proposals", "actionable"],
    queryFn: ({ pageParam }) => api.getInboxProposals({
      states: [...actionableProposalStates],
      limit: INBOX_PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: Boolean(readAvailable && view === "review"),
    retry: false,
  });
  const draftRows = useMemo(() => {
    const unique = new Map<string, InboxDraftSummary>();
    for (const page of drafts.data?.pages ?? []) {
      for (const item of page.items) unique.set(item.id, item);
    }
    return [...unique.values()];
  }, [drafts.data?.pages]);
  const proposalRows = useMemo(() => {
    const unique = new Map<string, InboxProposalSummary>();
    for (const page of proposals.data?.pages ?? []) {
      for (const item of page.items) unique.set(item.ref.id, item);
    }
    return [...unique.values()];
  }, [proposals.data?.pages]);
  const proposalGroups = useMemo(
    () => groupInboxProposals(proposalRows, trustedCurrentIdentity?.actor),
    [currentActor.isError, proposalRows, trustedCurrentIdentity?.actor],
  );
  const orderedProposalRows = useMemo(
    () => proposalGroups.flatMap((group) => group.rows),
    [proposalGroups],
  );

  useEffect(() => {
    if (
      view !== "review"
      || proposalParam !== null
      || reconcilingRemoval
      || proposals.isPending
      || currentActor.isPending
      || orderedProposalRows.length === 0
    ) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", "review");
    next.set("proposal", orderedProposalRows[0]!.ref.id);
    next.delete("draft");
    setSearchParams(next, { replace: true });
  }, [
    currentActor.isPending,
    orderedProposalRows,
    proposalParam,
    proposals.isPending,
    reconcilingRemoval,
    searchKey,
    setSearchParams,
    view,
  ]);

  useEffect(() => {
    if (
      view !== "drafts"
      || draftParam !== null
      || reconcilingRemoval
      || drafts.isPending
      || draftRows.length === 0
    ) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", "drafts");
    next.set("draft", draftRows[0]!.id);
    next.delete("proposal");
    setSearchParams(next, { replace: true });
  }, [draftParam, draftRows, drafts.isPending, reconcilingRemoval, searchKey, setSearchParams, view]);

  const draftDetail = useQuery({
    queryKey: ["inbox", "draft", selectedDraftId],
    queryFn: () => api.getInboxDraft(selectedDraftId!),
    enabled: Boolean(readAvailable && view === "drafts" && selectedDraftId),
    retry: false,
  });
  const proposalDetail = useQuery({
    queryKey: ["inbox", "proposal", selectedProposalId],
    queryFn: () => api.getInboxProposal(selectedProposalId!),
    enabled: Boolean(readAvailable && view === "review" && selectedProposalId),
    retry: false,
  });
  const selectedChange = view === "review" ? proposalDetail.data?.change : draftDetail.data?.input.change;
  const selectedUpdateTargetId = isInboxUpdate(selectedChange) ? selectedChange.target.id : null;
  const wikiReadAvailable = capabilities?.wiki.read.availability === "available";
  const currentWikiEntity = useQuery({
    queryKey: ["wiki-entity", selectedUpdateTargetId],
    queryFn: () => api.getWikiEntity(selectedUpdateTargetId!),
    enabled: Boolean(selectedUpdateTargetId && wikiReadAvailable),
    retry: false,
  });
  const currentWikiError = selectedUpdateTargetId === null
    ? undefined
    : capabilities?.wiki.read.availability === "unavailable"
      ? capabilities.wiki.read.reason
      : currentWikiEntity.isError
        ? "Current content is temporarily unavailable."
        : undefined;

  const clearModeSelection = (replace = true) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", view);
    next.delete(view === "review" ? "proposal" : "draft");
    setSearchParams(next, { replace });
  };

  useEffect(() => {
    if (refreshGeneration === 0) return;
    const selectedError = view === "review"
      ? selectedProposalId !== null && proposalDetail.isError
      : selectedDraftId !== null && draftDetail.isError;
    const noLongerActionable = view === "review"
      && proposalDetail.data !== undefined
      && !actionableProposalStates.includes(proposalDetail.data.state);
    if (!selectedError && !noLongerActionable) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", view);
    next.delete(view === "review" ? "proposal" : "draft");
    setSearchParams(next, { replace: true });
    setSelectionNotice(view === "review"
      ? "That proposal is no longer in the review queue. Choose another knowledge change."
      : "That draft is no longer on this device. Choose another draft.");
  }, [
    draftDetail.isError,
    proposalDetail.data,
    proposalDetail.isError,
    refreshGeneration,
    searchKey,
    selectedDraftId,
    selectedProposalId,
    setSearchParams,
    view,
  ]);

  const selectView = (nextValue: string) => {
    const nextView = inboxView(nextValue);
    const next = new URLSearchParams(searchParams);
    next.set("view", nextView);
    next.delete(nextView === "review" ? "draft" : "proposal");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const selectProposal = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", "review");
    next.set("proposal", id);
    next.delete("draft");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const selectDraft = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", "drafts");
    next.set("draft", id);
    next.delete("proposal");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const returnToQueue = () => {
    setSelectionNotice("");
    clearModeSelection();
  };
  const refreshInbox = async () => {
    setRefreshing(true);
    setSelectionNotice("");
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["actor", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      setRefreshGeneration((generation) => generation + 1);
      setStatus("Inbox refreshed.");
    } finally {
      setRefreshing(false);
    }
  };

  const openEditor = (draft: InboxDraftDetail | null, trigger: HTMLButtonElement) => {
    operationTrigger.current = trigger;
    setEditor({ draft });
  };
  const openReview = (action: ReviewAction, trigger: HTMLButtonElement) => {
    operationTrigger.current = trigger;
    setReviewAction(action);
  };
  const onApplied = async (kind: AppliedInboxAction, result: InboxOperationApplyResponse) => {
    const createdDraftId = kind === "inbox.draft.save"
      ? result.localChanges.find((change) => change.namespace === "inbox-draft" && change.beforeRevision === null)?.id
      : undefined;
    const removesSelection = kind === "inbox.publish"
      || kind === "inbox.draft.delete"
      || kind === "inbox.approve"
      || kind === "inbox.reject"
      || kind === "inbox.withdraw";
    if (removesSelection) setReconcilingRemoval(true);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["inbox"] }),
      queryClient.invalidateQueries({ queryKey: ["home"] }),
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["activity"] }),
      queryClient.invalidateQueries({ queryKey: ["specs"] }),
      queryClient.invalidateQueries({ queryKey: ["spec"] }),
      queryClient.invalidateQueries({ queryKey: ["wiki-entity"] }),
      queryClient.invalidateQueries({ queryKey: ["wiki-entities"] }),
      queryClient.invalidateQueries({ queryKey: ["wiki-graph"] }),
      queryClient.invalidateQueries({ queryKey: ["context-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["context-code"] }),
    ]);
    if (removesSelection) clearModeSelection();
    const consequence = kind === "inbox.approve"
      ? "Knowledge change and review record were written to your working tree. Commit and push them to share the result with your team."
      : kind === "inbox.publish"
        ? "Proposal created in your working tree. Commit and push it to make it available to teammates."
        : result.changes.length > 0
          ? "Inbox review update was written to your working tree."
          : "Draft state updated on this device.";
    const hasGitNotice = kind === "inbox.approve" || kind === "inbox.publish";
    flushSync(() => {
      if (createdDraftId) {
        const next = new URLSearchParams(searchParams);
        next.set("view", "drafts");
        next.set("draft", createdDraftId);
        next.delete("proposal");
        setSearchParams(next, { replace: true });
      }
      setStatus(hasGitNotice ? "" : consequence);
      if (kind === "inbox.approve") setGitNotice("approval");
      else if (kind === "inbox.publish") setGitNotice("publication");
      if (removesSelection) setReconcilingRemoval(false);
    });
  };

  const proposalDetailState = invalidProposalSelection ? (
    <div className={styles.recoverableState}>
      <StatePanel
        compact
        state="empty"
        title="This proposal link is invalid"
        detail="Return to the queue and choose an available knowledge change."
      />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to queue</Button>
    </div>
  ) : selectedProposalId === null ? (
    <StatePanel compact state="empty" title="Choose a knowledge change" detail="Select an item from the queue to start reviewing." />
  ) : proposalDetail.isPending ? (
    <StatePanel compact state="loading" title="Opening knowledge change" detail="Loading its meaningful content only after selection." />
  ) : proposalDetail.isError ? (
    <div className={styles.recoverableState}>
      <ErrorState error={proposalDetail.error} retry={() => void proposalDetail.refetch()} />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to queue</Button>
    </div>
  ) : (
    <ProposalDetail
      current={currentWikiEntity.data}
      currentError={currentWikiError}
      currentPending={Boolean(selectedUpdateTargetId && wikiReadAvailable && currentWikiEntity.isPending)}
      identity={trustedCurrentIdentity}
      identityError={currentActor.isError}
      onAction={openReview}
      proposal={proposalDetail.data}
      proposalMutation={capabilities!.inbox.proposalMutation}
      specApproval={capabilities!.inbox.specApproval}
    />
  );

  const draftDetailState = invalidDraftSelection ? (
    <div className={styles.recoverableState}>
      <StatePanel
        compact
        state="empty"
        title="This draft link is invalid"
        detail="Return to the list and choose a draft on this device."
      />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to drafts</Button>
    </div>
  ) : selectedDraftId === null ? (
    <StatePanel compact state="empty" title="Choose a draft" detail="Select a private draft to review it." />
  ) : draftDetail.isPending ? (
    <StatePanel compact state="loading" title="Opening private draft" detail="Loading its content only after selection." />
  ) : draftDetail.isError ? (
    <div className={styles.recoverableState}>
      <ErrorState error={draftDetail.error} retry={() => void draftDetail.refetch()} />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to drafts</Button>
    </div>
  ) : (
    <DraftDetail
      current={currentWikiEntity.data}
      currentError={currentWikiError}
      currentPending={Boolean(selectedUpdateTargetId && wikiReadAvailable && currentWikiEntity.isPending)}
      draft={draftDetail.data}
      draftMutation={capabilities!.inbox.draftMutation}
      onAction={openReview}
      onEdit={(trigger) => openEditor(draftDetail.data, trigger)}
      proposalMutation={capabilities!.inbox.proposalMutation}
      specApproval={capabilities!.inbox.specApproval}
    />
  );

  return (
    <div
      className={styles.page}
      data-inbox-actor={trustedCurrentIdentity?.actor.kind ?? (currentActor.isError ? "unavailable" : "loading")}
      data-inbox-workbench={readAvailable ? "ready" : "unavailable"}
    >
      <PageHeader
        title="Inbox"
        description="Review proposed changes before they become shared project memory."
        actions={(
          <Button
            className={styles.refreshAction}
            disabled={!readAvailable || refreshing}
            onClick={() => void refreshInbox()}
            ref={refreshActionRef}
            size="sm"
            type="button"
            variant="outline"
          >
            <RefreshCw className={refreshing ? styles.refreshingIcon : undefined} data-icon="inline-start" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      />
      {status === "" ? (
        <div className={styles.liveStatus} aria-live="polite" role="status" />
      ) : (
        <div className={styles.statusBanner} ref={statusRef} role="status" tabIndex={-1}>
          <CheckCircle2 aria-hidden="true" /> {status}
        </div>
      )}
      {gitNotice ? (
        <Alert className={styles.gitTruthAlert} ref={gitNoticeRef} tabIndex={-1}>
          <GitCommitHorizontal aria-hidden="true" />
          <AlertTitle>{gitNotice === "approval" ? "Working tree updated" : "Proposal created"}</AlertTitle>
          <AlertDescription>
            {gitNotice === "approval"
              ? "Knowledge change and review record were written to your working tree. Commit and push them to share the result with your team."
              : "Proposal created in your working tree. Commit and push it to make it available to teammates."}
          </AlertDescription>
          <AlertAction>
            <Button
              aria-label="Dismiss Git notice"
              onClick={() => {
                setGitNotice(null);
                afterDialogUnmount(() => refreshActionRef.current?.focus({ preventScroll: true }));
              }}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {selectionNotice ? (
        <div className={styles.selectionNotice} role="status">{selectionNotice}</div>
      ) : null}

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking Inbox capability" detail="Confirming which Inbox reads and actions are available." />
      ) : !readAvailable ? (
        <StatePanel
          state="unavailable"
          title="Inbox is unavailable"
          detail={capabilities.inbox.read.reason ?? "Inbox reads are not connected in this Hub process."}
        />
      ) : (
        <Tabs className={styles.modeTabs} onValueChange={selectView} value={view}>
          <TabsList aria-label="Inbox views" className={styles.modeTabList} variant="line">
            <TabsTrigger value="review">
              For review
              {exactReviewCount !== null ? <Badge className={styles.tabCount} variant="secondary">{exactReviewCount}</Badge> : null}
            </TabsTrigger>
            <TabsTrigger value="drafts">Drafts on this device</TabsTrigger>
          </TabsList>
          <TabsContent className={styles.modePanel} value="review">
            <div className={styles.workbench}>
              <ProposalQueue
                error={proposals.isError ? proposals.error : null}
                groups={proposalGroups}
                hasNextPage={Boolean(proposals.hasNextPage)}
                isFetchingNextPage={proposals.isFetchingNextPage}
                isPending={proposals.isPending}
                onLoadMore={() => void proposals.fetchNextPage()}
                onSelect={selectProposal}
                selectedId={selectedProposalId}
                sourceBounded={Boolean(
                  proposals.data
                  && (proposals.data.pages.length >= MAX_WORKBENCH_PAGES
                    || proposals.data.pages.some((page) => page.sourceTruncated)),
                )}
              />
              <Card className={styles.detailCard} role="region" aria-label="Selected Inbox review detail">
                {proposalDetailState}
              </Card>
            </div>
          </TabsContent>
          <TabsContent className={styles.modePanel} value="drafts">
            <div className={styles.workbench}>
              <DraftQueue
                draftMutation={capabilities.inbox.draftMutation}
                error={drafts.isError ? drafts.error : null}
                hasNextPage={Boolean(drafts.hasNextPage)}
                isFetchingNextPage={drafts.isFetchingNextPage}
                isPending={drafts.isPending}
                onCreate={(event) => openEditor(null, event.currentTarget)}
                onLoadMore={() => void drafts.fetchNextPage()}
                onSelect={selectDraft}
                rows={draftRows}
                selectedId={selectedDraftId}
                sourceBounded={Boolean(
                  drafts.data
                  && (drafts.data.pages.length >= MAX_WORKBENCH_PAGES
                    || drafts.data.pages.some((page) => page.sourceTruncated)),
                )}
              />
              <Card className={styles.detailCard} role="region" aria-label="Selected Inbox draft detail">
                {draftDetailState}
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      )}

      {editor || reviewAction ? (
        <Suspense fallback={null}>
          <InboxMutationDialogs
            editor={editor}
            finalFocus={resolveOperationFinalFocus}
            focusAppliedStatus={focusAppliedStatus}
            onApplied={onApplied}
            onCloseEditor={() => setEditor(null)}
            onCloseReview={() => setReviewAction(null)}
            reviewAction={reviewAction}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

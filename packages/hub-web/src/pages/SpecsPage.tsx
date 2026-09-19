import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FileCheck2,
  FileText,
  GitCommitHorizontal,
  Link2,
  Network,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  SpecDetailProjection,
  SpecIndexProjection,
  SpecSummaryProjection,
  Tone,
  WikiGrounding,
} from "../api/types";
import { Badge } from "../components/primitives/badge";
import { Button, buttonVariants } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/primitives/table";
import { ErrorState, PageHeader, StatePanel, StatusPill, formatDate, sentenceCase } from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import styles from "../styles/specs.module.css";

const SPEC_PAGE_SIZE = 50;
const specFilters = ["all", "in_flight", "promoted", "deprecated", "archived"] as const;
type SpecFilter = (typeof specFilters)[number];

function groundingTone(health: SpecSummaryProjection["groundingHealth"]): Tone {
  if (health === "fresh") return "success";
  if (health === "changed" || health === "ambiguous" || health === "unverified") return "warning";
  if (health === "missing") return "danger";
  return "neutral";
}

function indexMessage(index: SpecIndexProjection): { title: string; detail: string } {
  if (index.state === "stale" || index.state === "rebuild_required") {
    return {
      title: "Specs need a fresh Wiki index",
      detail: "This view fails closed rather than combining the current repository with stale specification evidence.",
    };
  }
  return {
    title: "Specs are unavailable",
    detail: index.diagnostics[0]?.message ?? "The Wiki index cannot provide a trustworthy Spec projection.",
  };
}

function SpecIndexState({ index }: { index: SpecIndexProjection }) {
  const message = indexMessage(index);
  return (
    <StatePanel
      state="unavailable"
      title={message.title}
      detail={message.detail}
      action={(
        <Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/health">
          Review health <ArrowRight data-icon="inline-end" aria-hidden="true" />
        </Link>
      )}
    />
  );
}

function SummaryStatus({ summary }: { summary: SpecSummaryProjection }) {
  return (
    <div className={styles.summaryStatus}>
      <StatusPill>{sentenceCase(summary.lifecycleState)}</StatusPill>
      <StatusPill tone={groundingTone(summary.groundingHealth)}>{sentenceCase(summary.groundingHealth)}</StatusPill>
    </div>
  );
}

function EvidenceList({
  title,
  count,
  children,
  empty,
}: {
  title: string;
  count: number;
  children: ReactNode;
  empty: string;
}) {
  return (
    <Card className={styles.evidenceCard} size="sm">
      <CardHeader>
        <CardTitle><h3>{title}</h3></CardTitle>
        <CardAction><Badge variant="outline">{count}</Badge></CardAction>
      </CardHeader>
      <CardContent>{count ? children : <p className={styles.emptyCopy}>{empty}</p>}</CardContent>
    </Card>
  );
}

function GroundingRow({ grounding }: { grounding: WikiGrounding }) {
  return (
    <li>
      <span className={styles.evidenceGlyph}><ScanSearch aria-hidden="true" /></span>
      <div>
        <strong>{grounding.resolvedNode ?? grounding.requestedNode ?? "No code node recorded"}</strong>
        <small>{grounding.file ?? grounding.reason ?? "No file evidence recorded"}</small>
      </div>
      <StatusPill tone={groundingTone(grounding.health)}>{sentenceCase(grounding.health)}</StatusPill>
    </li>
  );
}

function HierarchyGroup({
  title,
  items,
  icon,
}: {
  title: string;
  items: readonly SpecSummaryProjection[];
  icon: ReactNode;
}) {
  return (
    <Card className={styles.hierarchyCard} size="sm">
      <CardHeader>
        <CardTitle><h3>{title}</h3></CardTitle>
        <CardAction>{icon}</CardAction>
      </CardHeader>
      <CardContent>
        {items.length ? (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <div><strong>{item.title}</strong><code>{item.id}</code></div>
                <StatusPill tone={groundingTone(item.groundingHealth)}>{sentenceCase(item.groundingHealth)}</StatusPill>
              </li>
            ))}
          </ul>
        ) : <p className={styles.emptyCopy}>No explicit {title.toLowerCase()} are linked.</p>}
      </CardContent>
    </Card>
  );
}

function SpecDetail({ detail }: { detail: SpecDetailProjection }) {
  const provenance = detail.provenance;
  const evidenceAttention = detail.groundings.filter((item) => item.health !== "fresh").length;
  const groundingStatus = detail.sourcesTruncated || detail.groundingsTruncated
    ? { tone: "warning" as const, label: "Evidence bounded" }
    : detail.groundings.length === 0
      ? { tone: "neutral" as const, label: "No grounding evidence" }
      : evidenceAttention > 0
        ? { tone: "warning" as const, label: `${evidenceAttention} need attention` }
        : { tone: "success" as const, label: "Evidence fresh" };
  return (
    <div className={styles.detailStack}>
      <Card className={styles.heroCard} role="region" aria-labelledby="spec-detail-heading">
        <CardHeader className={styles.heroHeader}>
          <div>
            <CardDescription>Read-only specification</CardDescription>
            <CardTitle><h2 id="spec-detail-heading">{detail.spec.title}</h2></CardTitle>
            <code>{detail.spec.id}</code>
          </div>
          <CardAction><SummaryStatus summary={detail.spec} /></CardAction>
        </CardHeader>
        <CardContent className={styles.heroContent}>
          <p>{detail.spec.summary ?? "No summary is recorded."}</p>
          <dl>
            <div><dt>Source</dt><dd><FileText aria-hidden="true" /><code>{detail.spec.sourcePath}</code></dd></div>
            <div><dt>Content revision</dt><dd><GitCommitHorizontal aria-hidden="true" /><code>{detail.spec.version.contentHash.slice(0, 12)}</code></dd></div>
            <div><dt>Semantic revision</dt><dd>{detail.spec.version.semanticRevision}</dd></div>
            <div><dt>Snapshot</dt><dd><code>{detail.deterministicRevision.slice(0, 12)}</code></dd></div>
          </dl>
        </CardContent>
      </Card>

      {detail.spec.diagnostics.length || detail.spec.diagnosticsTruncated ? (
        <aside className={styles.diagnosticNote} role="status">
          <AlertTriangle aria-hidden="true" />
          <span><strong>Specification diagnostic.</strong> {detail.spec.diagnostics[0]?.message ?? "Additional diagnostics were omitted by the response bound."}</span>
        </aside>
      ) : null}

      <Card className={styles.bodyCard} role="region" aria-labelledby="spec-body-heading">
        <CardHeader>
          <CardTitle><h3 id="spec-body-heading">Specification body</h3></CardTitle>
          <CardAction>{detail.bodyTruncated ? <StatusPill tone="warning">Bounded preview</StatusPill> : <StatusPill>Complete</StatusPill>}</CardAction>
        </CardHeader>
        <CardContent><pre><code>{detail.body}</code></pre></CardContent>
      </Card>

      <section className={styles.section} aria-labelledby="spec-hierarchy-heading">
        <header className={styles.sectionHeader}>
          <div><p>Explicit links only</p><h2 id="spec-hierarchy-heading">Hierarchy</h2></div>
          <StatusPill>{detail.hierarchy.estimatedTokens} estimated tokens</StatusPill>
        </header>
        <div className={styles.hierarchyGrid}>
          <HierarchyGroup icon={<BookOpenCheck aria-hidden="true" />} items={detail.hierarchy.requirements} title="Requirements" />
          <HierarchyGroup icon={<CheckCircle2 aria-hidden="true" />} items={detail.hierarchy.acceptanceCriteria} title="Acceptance criteria" />
          <HierarchyGroup icon={<ShieldCheck aria-hidden="true" />} items={detail.hierarchy.constraints} title="Constraints" />
        </div>
        <Card className={styles.relationshipCard} size="sm">
          <CardHeader>
            <CardTitle><h3>Relationship evidence</h3></CardTitle>
            <CardAction><Badge variant="outline">{detail.hierarchy.relations.length}</Badge></CardAction>
          </CardHeader>
          <CardContent>
            {detail.hierarchy.relations.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>Relationship</TableHead><TableHead>From</TableHead><TableHead>To</TableHead><TableHead>Note</TableHead></TableRow></TableHeader>
                <TableBody>
                  {detail.hierarchy.relations.map((relation, index) => (
                    <TableRow key={`${relation.type}:${relation.source.id}:${relation.target.id}:${index}`}>
                      <TableCell><StatusPill>{sentenceCase(relation.type)}</StatusPill></TableCell>
                      <TableCell><code>{relation.source.id}</code><small>{sentenceCase(relation.source.kind)}</small></TableCell>
                      <TableCell><code>{relation.target.id}</code><small>{sentenceCase(relation.target.kind)}</small></TableCell>
                      <TableCell>{relation.note ?? "Explicit link"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p className={styles.emptyCopy}>No explicit hierarchy relationships are recorded.</p>}
          </CardContent>
        </Card>
      </section>

      <section className={styles.section} aria-labelledby="spec-evidence-heading">
        <header className={styles.sectionHeader}>
          <div><p>Source-owned facts</p><h2 id="spec-evidence-heading">Provenance and grounding</h2></div>
          <StatusPill tone={groundingStatus.tone}>{groundingStatus.label}</StatusPill>
        </header>
        <div className={styles.evidenceGrid}>
          <Card className={styles.evidenceCard} size="sm">
            <CardHeader><CardTitle><h3>Provenance</h3></CardTitle><CardAction><Link2 aria-hidden="true" /></CardAction></CardHeader>
            <CardContent>
              {provenance ? (
                <dl className={styles.provenanceList}>
                  <div><dt>Kind</dt><dd>{sentenceCase(provenance.kind)}</dd></div>
                  <div><dt>Identity</dt><dd>{provenance.id ?? "Not recorded"}</dd></div>
                  <div><dt>Captured</dt><dd>{formatDate(provenance.capturedAt)}</dd></div>
                </dl>
              ) : <p className={styles.emptyCopy}>No provenance record is available.</p>}
            </CardContent>
          </Card>
          <EvidenceList count={detail.sources.length} empty="No source records are available." title="Sources">
            <ul className={styles.evidenceList}>
              {detail.sources.map((source, index) => (
                <li key={`${source.type}:${source.ref ?? ""}:${index}`}>
                  <span className={styles.evidenceGlyph}><FileText aria-hidden="true" /></span>
                  <div><strong>{source.ref ?? source.type}</strong><small>{source.note ?? source.repository ?? "No source note"}</small></div>
                  <StatusPill>{source.type}</StatusPill>
                </li>
              ))}
            </ul>
          </EvidenceList>
          <EvidenceList count={detail.groundings.length} empty="No code groundings are recorded." title="Grounding">
            <ul className={styles.evidenceList}>{detail.groundings.map((grounding, index) => <GroundingRow grounding={grounding} key={`${grounding.requestedNode ?? "none"}:${index}`} />)}</ul>
          </EvidenceList>
        </div>
        {detail.sourcesTruncated || detail.groundingsTruncated ? (
          <p className={styles.boundNote}>This response reached its explicit evidence bound; omitted records are not inferred.</p>
        ) : null}
      </section>
    </div>
  );
}

export function SpecsPage() {
  const api = useHubApi();
  const { id: routeId } = useParams<{ id?: string }>();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [filter, setFilter] = useState<SpecFilter>("all");
  const readAvailable = capabilities?.specs.read.availability === "available";
  const specs = useInfiniteQuery({
    queryKey: ["specs", filter],
    queryFn: ({ pageParam }) => api.listSpecs({
      limit: SPEC_PAGE_SIZE,
      ...(filter === "all" ? {} : { lifecycleStates: [filter] }),
      ...(filter === "archived" ? { includeArchived: true } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => lastPage.availability === "ready"
      ? boundedNextCursor(lastPage.page.nextCursor, pages.length)
      : undefined,
    enabled: readAvailable,
    retry: false,
  });
  const rows = useMemo(() => {
    const unique = new Map<string, SpecSummaryProjection>();
    for (const response of specs.data?.pages ?? []) {
      if (response.availability !== "ready") continue;
      for (const spec of response.page.items) unique.set(spec.id, spec);
    }
    return [...unique.values()];
  }, [specs.data?.pages]);
  const nonReady = specs.data?.pages.find((response) => response.availability !== "ready") ?? null;
  const readyIndex = specs.data?.pages.find((response) => response.availability === "ready")?.index ?? null;
  const terminalSafetyTruncation = specs.data?.pages.some((response) => response.availability === "ready"
    && response.page.truncated
    && response.page.nextCursor === null) ?? false;
  const detailId = routeId ?? rows[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["spec", detailId],
    queryFn: () => api.getSpec(detailId!),
    enabled: readAvailable && nonReady === null && detailId !== null,
    retry: false,
  });

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Specification memory"
        title="Specs"
        description="Review fresh, explicit Wiki-owned specification hierarchy and evidence. Editing remains governed by the Inbox."
        actions={<Badge variant="outline"><FileCheck2 data-icon="inline-start" aria-hidden="true" /> Read only</Badge>}
      />

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking Spec capability" detail="Confirming the dedicated fresh-index reader." />
      ) : !readAvailable ? (
        <StatePanel state="unavailable" title="Specs are unavailable" detail={capabilities.specs.read.reason ?? "The dedicated Spec reader is not connected in this Hub process."} />
      ) : specs.isPending ? (
        <StatePanel state="loading" title="Reading Specs" detail="Opening one fresh, deterministic Wiki snapshot." />
      ) : specs.isError ? (
        <ErrorState error={specs.error} retry={() => void specs.refetch()} />
      ) : nonReady ? (
        <SpecIndexState index={nonReady.index} />
      ) : (
        <div className={styles.workbench}>
          <Card className={styles.rail} role="region" aria-labelledby="spec-directory-heading">
            <CardHeader className={styles.railHeader}>
              <div><CardDescription>Fresh root entities</CardDescription><CardTitle><h2 id="spec-directory-heading">Specification index</h2></CardTitle></div>
              <StatusPill>{rows.length} loaded</StatusPill>
            </CardHeader>
            <CardContent className={styles.railContent}>
              <div className={styles.filterBar} aria-label="Filter Specs" role="group">
                {specFilters.map((value) => (
                  <Button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} size="sm" type="button" variant="ghost">
                    {sentenceCase(value)}
                  </Button>
                ))}
              </div>
              {rows.length === 0 ? (
                <StatePanel
                  compact
                  state="empty"
                  title={terminalSafetyTruncation ? "No trusted Specs available" : "No matching Specs"}
                  detail={terminalSafetyTruncation
                    ? "The bounded Wiki scan ended before it could establish a complete result."
                    : "Choose another lifecycle filter. Spec creation remains Inbox-governed."}
                />
              ) : (
                <ul className={styles.specList}>
                  {rows.map((spec) => (
                    <li key={spec.id}>
                      <Link aria-current={detailId === spec.id ? "page" : undefined} to={`/specs/${encodeURIComponent(spec.id)}`}>
                        <span className={styles.specGlyph}><FileCheck2 aria-hidden="true" /></span>
                        <span><strong>{spec.title}</strong><small>{spec.summary ?? "No summary recorded"}</small></span>
                        <StatusPill tone={groundingTone(spec.groundingHealth)}>{sentenceCase(spec.groundingHealth)}</StatusPill>
                        <ChevronRight aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                  </ul>
              )}
              {rows.length && (terminalSafetyTruncation || readyIndex?.diagnostics.length || readyIndex?.diagnosticsTruncated) ? (
                <aside className={styles.diagnosticNote} role="status">
                  <AlertTriangle aria-hidden="true" />
                  <span>
                    <strong>Some Spec index evidence needs attention.</strong>{" "}
                    {readyIndex?.diagnostics[0]?.message ?? (terminalSafetyTruncation
                      ? "The bounded list omitted additional root Specs."
                      : "Additional diagnostics were omitted by the response bound.")} Trusted rows remain visible.
                  </span>
                </aside>
              ) : null}
              {specs.hasNextPage ? (
                <Button className={styles.loadMore} disabled={specs.isFetchingNextPage} onClick={() => void specs.fetchNextPage()} type="button" variant="outline">
                  {specs.isFetchingNextPage ? "Loading…" : "Load more Specs"}
                </Button>
              ) : specs.data && specs.data.pages.length >= MAX_WORKBENCH_PAGES ? (
                <p className={styles.boundNote}>Browser page limit reached.</p>
              ) : null}
            </CardContent>
          </Card>

          <section className={styles.detail} aria-label="Selected Spec detail">
            {detailId === null ? (
              <StatePanel compact state="empty" title="No Spec selected" detail="No root Spec is available in this fresh snapshot." />
            ) : detail.isPending ? (
              <StatePanel compact state="loading" title="Reading Spec detail" detail="Resolving explicit hierarchy and evidence from the same index revision." />
            ) : detail.isError ? (
              <ErrorState error={detail.error} retry={() => void detail.refetch()} />
            ) : detail.data.availability !== "ready" ? (
              <SpecIndexState index={detail.data.index} />
            ) : <SpecDetail detail={detail.data.detail} />}
          </section>
        </div>
      )}

      <aside className={styles.boundaryNote}>
        <Network aria-hidden="true" />
        <span><strong>No inferred coverage.</strong> Hierarchy and evidence come only from explicit Wiki relationships in one fresh index.</span>
        <CircleDot aria-hidden="true" />
      </aside>
    </div>
  );
}

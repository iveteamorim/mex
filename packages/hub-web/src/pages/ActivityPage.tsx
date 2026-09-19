import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleDot,
  History,
  Link2,
  LockKeyhole,
  RefreshCw,
  ScrollText,
  UserRound,
} from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type {
  ActivityDiagnostic,
  ActivityItem,
  ActivitySource,
  CapabilitiesResponse,
} from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/primitives/alert";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { Card } from "../components/primitives/card";
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
import { Input } from "../components/primitives/input";
import { Separator } from "../components/primitives/separator";
import { Skeleton } from "../components/primitives/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/primitives/tabs";
import { ErrorState, PageHeader, StatePanel } from "../components/ui";
import {
  boundedNextCursor,
  MAX_ACCUMULATED_WORKBENCH_ITEMS,
  MAX_WORKBENCH_PAGES,
} from "../lib/bounds";
import {
  activityActorLabel,
  activityHeadline,
  activityPrimaryContext,
  activityProjectNoteKind,
  activitySubjectRoute,
  sameActivityActor,
  type ActivityContextReference,
} from "../lib/activity-presentation";
import styles from "../styles/activity.module.css";

type ActivityFilter = "all" | ActivitySource;

const ACTIVITY_PAGE_SIZE = 25;
const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "activity", "legacy"];
const ActivityEntryContext = lazy(() => import("./ActivityEntryContext").then((module) => ({
  default: module.ActivityEntryContext,
})));

function validDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toSinceTimestamp(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function activityFilterLabel(value: ActivityFilter): string {
  if (value === "activity") return "MEX records";
  if (value === "legacy") return "Project notes";
  return "All activity";
}

function formatDay(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function formatClock(timestamp: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(timestamp))} UTC`;
}

function formatAccessibleTimestamp(timestamp: string): string {
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

function PrimaryContext({ context, item }: { context: ActivityContextReference; item: ActivityItem }) {
  const href = context.subject ? activitySubjectRoute(context.subject, item) : null;
  if (href) {
    return (
      <Link
        className={styles.primaryContext}
        to={href}
      >
        <Link2 aria-hidden="true" data-icon="inline-start" />
        <span>{context.label}</span>
        <ChevronRight aria-hidden="true" data-icon="inline-end" />
      </Link>
    );
  }
  return (
    <span className={styles.primaryContextPlain}>
      <Link2 aria-hidden="true" />
      <span>{context.label}</span>
    </span>
  );
}

function ActivityEntry({
  item,
  position,
  expanded,
  onToggle,
}: {
  item: ActivityItem;
  position: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const headingId = useId();
  const contextId = useId();
  const canonical = item.source === "activity" ? item : null;
  const headline = activityHeadline(item);
  const context = activityPrimaryContext(item);
  const actorRemapped = canonical ? !sameActivityActor(canonical.recordedActor, canonical.effectiveActor) : false;
  const contextControlLabel = context?.label
    ?? (canonical ? activityActorLabel(canonical.recordedActor) : "actor not recorded");
  const contextAccessibleName = `${headline}: ${contextControlLabel}, timeline entry ${position}, recorded ${formatAccessibleTimestamp(item.timestamp)}`;
  const EntryIcon = canonical ? Activity : ScrollText;
  return (
    <li className={styles.activityEntry}>
      <time aria-hidden="true" className={styles.activityEntryTime} dateTime={item.timestamp}>{formatClock(item.timestamp)}</time>
      <span className={styles.activityEntryMarker} data-source={item.source}><EntryIcon aria-hidden="true" /></span>
      <Card aria-labelledby={headingId} className={styles.activityEntryCard} data-source={item.source} role="article" size="sm">
        <div className={styles.activityEntryTopline}>
          {item.source === "legacy" ? (
            <Badge variant={item.action === "risk" ? "destructive" : item.action === "note" ? "outline" : "secondary"}>
              {activityProjectNoteKind(item.action)}
            </Badge>
          ) : null}
          {canonical?.actorDiagnostics.length ? <Badge variant="outline">Identity note</Badge> : null}
        </div>
        <h3 id={headingId}>{headline}</h3>
        <p className={styles.activityActorLine}>
          <UserRound aria-hidden="true" />
          <span>{canonical ? activityActorLabel(canonical.recordedActor) : "Actor not recorded"}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={item.timestamp}>{formatClock(item.timestamp)}</time>
        </p>
        {actorRemapped && canonical ? (
          <p className={styles.activityRemap}>Currently matched to {activityActorLabel(canonical.effectiveActor)}</p>
        ) : null}
        {item.source === "legacy" && item.messageTruncated ? (
          <p className={styles.activityBoundedNote}>This project-note message was shortened by the safe response limit.</p>
        ) : null}
        {context ? <PrimaryContext context={context} item={item} /> : null}
        <Collapsible className={styles.entryCollapsible} onOpenChange={onToggle} open={expanded}>
          <CollapsibleTrigger
            aria-label={`${expanded ? "Hide" : "View"} context for ${contextAccessibleName}`}
            render={<Button className={styles.activityDisclosure} size="sm" type="button" variant="ghost" />}
          >
            <ChevronDown data-icon="inline-start" />
            {expanded ? "Hide context" : "View context"}
          </CollapsibleTrigger>
          {expanded ? (
            <CollapsibleContent id={contextId}>
              <Suspense fallback={<div className={styles.contextLoading} role="status">Loading recorded context…</div>}>
                <ActivityEntryContext accessibleName={contextAccessibleName} item={item} />
              </Suspense>
            </CollapsibleContent>
          ) : null}
        </Collapsible>
      </Card>
    </li>
  );
}

function DiagnosticsNotice({
  diagnostics,
  hasTrustedItems,
  sourceTruncated,
  diagnosticsTruncated,
}: {
  diagnostics: ActivityDiagnostic[];
  hasTrustedItems: boolean;
  sourceTruncated: boolean;
  diagnosticsTruncated: boolean;
}) {
  if (diagnostics.length === 0 && !sourceTruncated && !diagnosticsTruncated) return null;
  return (
    <Alert className={styles.activityDiagnostics}>
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{sourceTruncated ? "This activity view is incomplete" : "Some activity needs attention"}</AlertTitle>
      <AlertDescription>
        <p>
          {hasTrustedItems
            ? sourceTruncated
              ? "The trustworthy records below remain available, but a source reached its safe read limit."
              : "Trustworthy records remain visible while MEX excludes or flags damaged source data."
            : "MEX could not assemble a trusted record from this result."}
        </p>
        <details className={styles.trustDetails}>
          <summary><ChevronDown aria-hidden="true" /> View trust details</summary>
          <div data-slot="collapsible-content">
            <ul>
              {diagnostics.map((diagnostic) => (
                <li data-severity={diagnostic.severity} key={`${diagnostic.code}-${diagnostic.path ?? ""}-${diagnostic.message}`}>
                  <strong className={styles.mono}>{diagnostic.code}</strong>
                  <span>{diagnostic.message}{diagnostic.path ? <code>{diagnostic.path}</code> : null}</span>
                </li>
              ))}
            </ul>
            {sourceTruncated ? <p>A source scan stopped at its bounded safety limit.</p> : null}
            {diagnosticsTruncated ? <p>Additional diagnostic entries were omitted by the response safety limit.</p> : null}
          </div>
        </details>
      </AlertDescription>
    </Alert>
  );
}

function ActivityLoading() {
  return (
    <div aria-label="Loading team activity" className={styles.activityLoading} role="status">
      <p className={styles.loadingLabel}>Loading team activity</p>
      {[0, 1, 2].map((index) => (
        <div className={styles.loadingRow} key={index}>
          <Skeleton className={styles.loadingTime} />
          <Skeleton className={styles.loadingMarker} />
          <div>
            <Skeleton className={styles.loadingHeadline} />
            <Skeleton className={styles.loadingMeta} />
            <Skeleton className={styles.loadingContext} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityEmpty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <Empty className={styles.activityEmpty} role="status">
      <EmptyMedia variant="icon"><History aria-hidden="true" /></EmptyMedia>
      <EmptyHeader>
        <EmptyTitle><h2>{filtered ? "No activity matches these filters" : "No team activity yet"}</h2></EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Clear the source and date filters to return to the complete newest view."
            : "Shared MEX changes will appear here automatically after they are recorded. Refresh after an agent writes locally or you pull changes through Git."}
        </EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <EmptyContent>
          <Button onClick={onClear} size="sm" type="button" variant="outline">Clear filters</Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

export function ActivityPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");
  const focusAfterLoad = useRef(false);
  const resultStatusRef = useRef<HTMLDivElement>(null);
  const paramsString = params.toString();
  const sourceValues = params.getAll("source");
  const source: ActivityFilter = sourceValues.length === 1 && (sourceValues[0] === "activity" || sourceValues[0] === "legacy")
    ? sourceValues[0]
    : "all";
  const sinceValues = params.getAll("since");
  const since = sinceValues.length === 1 && validDate(sinceValues[0]) ? sinceValues[0] : "";
  const activityAvailable = capabilities?.activity.availability === "available";
  const queryKey = ["activity", source, since] as const;

  useEffect(() => {
    const normalized = new URLSearchParams(paramsString);
    let changed = false;
    if (sourceValues.length > 1 || (sourceValues.length === 1 && source === "all")) {
      normalized.delete("source");
      changed = true;
    }
    if (sinceValues.length > 1 || (sinceValues.length === 1 && since === "")) {
      normalized.delete("since");
      changed = true;
    }
    if (changed) setParams(normalized, { replace: true });
  }, [paramsString, setParams, since, sinceValues.length, source, sourceValues.length]);

  useEffect(() => setExpanded(new Set()), [since, source]);

  const timeline = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => api.getActivity({
      limit: ACTIVITY_PAGE_SIZE,
      ...(source === "all" ? {} : { source }),
      ...(since ? { since: toSinceTimestamp(since) } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, allPages) => boundedNextCursor(lastPage.nextCursor, allPages.length),
    enabled: activityAvailable,
    retry: false,
  });

  const firstRevision = timeline.data?.pages[0]?.deterministicRevision;
  const revisionMismatch = timeline.data?.pages.some((page) => page.deterministicRevision !== firstRevision) ?? false;
  const trustedPages = revisionMismatch ? (timeline.data?.pages.slice(0, 1) ?? []) : (timeline.data?.pages ?? []);
  const pageBoundReached = trustedPages.length >= MAX_WORKBENCH_PAGES
    && trustedPages.at(-1)?.nextCursor !== null;
  const items = useMemo(() => {
    const unique = new Map<string, ActivityItem>();
    for (const page of trustedPages) {
      for (const item of page.items) unique.set(`${item.source}:${item.id}`, item);
    }
    return [...unique.values()];
  }, [trustedPages]);
  const diagnostics = useMemo(() => {
    const unique = new Map<string, ActivityDiagnostic>();
    for (const page of trustedPages) {
      for (const diagnostic of page.diagnostics) {
        unique.set(`${diagnostic.code}\0${diagnostic.path ?? ""}\0${diagnostic.message}`, diagnostic);
      }
    }
    return [...unique.values()];
  }, [trustedPages]);
  const diagnosticsTruncated = trustedPages.some((page) => page.diagnosticsTruncated);
  const sourceTruncated = trustedPages.some((page) => page.sourceTruncated);
  const paginationConflict = revisionMismatch || (
    timeline.isFetchNextPageError
    && timeline.error instanceof HubApiError
    && timeline.error.problem.code === "REVISION_CONFLICT"
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, ActivityItem[]>();
    for (const item of items) {
      const key = item.timestamp.slice(0, 10);
      const existing = grouped.get(key);
      if (existing) existing.push(item);
      else grouped.set(key, [item]);
    }
    return [...grouped.entries()];
  }, [items]);
  const itemPositions = useMemo(() => new Map(items.map((item, index) => (
    [`${item.source}:${item.id}`, index + 1]
  ))), [items]);

  useEffect(() => {
    if (focusAfterLoad.current && !timeline.isFetching && (timeline.data !== undefined || timeline.isError)) {
      focusAfterLoad.current = false;
      resultStatusRef.current?.focus({ preventScroll: true });
    }
  }, [timeline.data, timeline.isError, timeline.isFetching]);

  const updateSource = (value: string) => {
    if (!ACTIVITY_FILTERS.includes(value as ActivityFilter)) return;
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("source");
    else next.set("source", value);
    setParams(next);
  };
  const updateSince = (value: string, focusResult = false) => {
    focusAfterLoad.current = focusResult;
    const next = new URLSearchParams(params);
    if (value) next.set("since", value);
    else next.delete("since");
    setParams(next);
  };
  const clearFilters = () => {
    focusAfterLoad.current = true;
    const next = new URLSearchParams(params);
    next.delete("source");
    next.delete("since");
    setParams(next);
  };
  const reloadNewest = () => {
    focusAfterLoad.current = true;
    setExpanded(new Set());
    void queryClient.resetQueries({ queryKey: ["activity"] });
  };
  const refreshActivity = async () => {
    setRefreshing(true);
    setRefreshStatus("");
    setExpanded(new Set());
    try {
      await queryClient.resetQueries(
        { queryKey: ["activity"] },
        { throwOnError: true },
      );
      setRefreshStatus("Activity refreshed.");
    } catch {
      setRefreshStatus("Activity could not be refreshed. Try again.");
    } finally {
      setRefreshing(false);
    }
  };

  let result: ReactNode;
  if (timeline.isPending) {
    result = <ActivityLoading />;
  } else if (timeline.isError && timeline.data === undefined) {
    result = <div className={styles.activityState}><ErrorState error={timeline.error} retry={() => void timeline.refetch()} /></div>;
  } else if (items.length === 0) {
    result = (
      <div className={styles.activityStateStack}>
        <DiagnosticsNotice
          diagnostics={diagnostics}
          diagnosticsTruncated={diagnosticsTruncated}
          hasTrustedItems={false}
          sourceTruncated={sourceTruncated}
        />
        {sourceTruncated ? (
          <div className={styles.incompleteEmpty}>
            <StatePanel
              compact
              detail="The source scan is incomplete, so this result cannot confirm that no matching activity exists."
              state="empty"
              title="No trusted activity available"
            />
            {source !== "all" || since ? (
              <Button onClick={clearFilters} size="sm" type="button" variant="outline">Clear filters</Button>
            ) : null}
          </div>
        ) : <ActivityEmpty filtered={source !== "all" || Boolean(since)} onClear={clearFilters} />}
      </div>
    );
  } else {
    result = (
      <>
        <DiagnosticsNotice
          diagnostics={diagnostics}
          diagnosticsTruncated={diagnosticsTruncated}
          hasTrustedItems
          sourceTruncated={sourceTruncated}
        />
        <div className={styles.activityFeed}>
          {groups.map(([day, dayItems]) => (
            <section className={styles.activityDay} key={day} aria-labelledby={`activity-day-${day}`}>
              <header className={styles.activityDayHeader}>
                <span aria-hidden="true">UTC</span>
                <h2 id={`activity-day-${day}`}>{formatDay(dayItems[0]!.timestamp)}</h2>
              </header>
              <ol className={styles.activityEntries} aria-label={`Activity for ${formatDay(dayItems[0]!.timestamp)}`}>
                {dayItems.map((item) => {
                  const key = `${item.source}:${item.id}`;
                  return (
                    <ActivityEntry
                      expanded={expanded.has(key)}
                      item={item}
                      key={key}
                      position={itemPositions.get(key) ?? 1}
                      onToggle={() => setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })}
                    />
                  );
                })}
              </ol>
            </section>
          ))}
        </div>

        <div className={styles.activityPagination}>
          {paginationConflict ? (
            <Alert className={styles.paginationAlert}>
              <RefreshCw aria-hidden="true" />
              <AlertTitle>New activity arrived while you were browsing</AlertTitle>
              <AlertDescription>Reload to keep this timeline consistent.</AlertDescription>
              <Button onClick={reloadNewest} size="sm" type="button" variant="outline">Reload newest</Button>
            </Alert>
          ) : timeline.isFetchNextPageError ? (
            <Alert className={styles.paginationAlert}>
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>Older activity could not be loaded</AlertTitle>
              <AlertDescription>The records already on screen remain trustworthy.</AlertDescription>
              <Button onClick={() => void timeline.fetchNextPage()} size="sm" type="button" variant="outline">Try again</Button>
            </Alert>
          ) : timeline.hasNextPage ? (
            <Button className={styles.activityLoadMore} disabled={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()} type="button" variant="outline">
              {timeline.isFetchingNextPage ? "Loading older activity…" : "Load older activity"}
            </Button>
          ) : pageBoundReached ? (
            <p><AlertTriangle aria-hidden="true" /> This browser view reached its safe page limit. Choose a From date to narrow the feed.</p>
          ) : (
            <p><CircleDot aria-hidden="true" /> You’ve reached the oldest available activity.</p>
          )}
          {pageBoundReached ? <span className="sr-only">The browser retained at most {MAX_ACCUMULATED_WORKBENCH_ITEMS} activity records.</span> : null}
        </div>
      </>
    );
  }

  return (
    <div className={styles.page}>
        <PageHeader
          eyebrow="Team history"
          title="Activity"
          description="See what changed across shared memory, who changed it, and the context MEX recorded."
          actions={(
            <Button disabled={!activityAvailable || refreshing} onClick={() => void refreshActivity()} size="sm" type="button" variant="outline">
              <RefreshCw className={refreshing ? styles.refreshingIcon : undefined} data-icon="inline-start" />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          )}
        />
        <div className="sr-only" aria-live="polite" role="status">{refreshStatus}</div>

        {capabilities === undefined ? (
          <StatePanel state="loading" title="Checking activity capability" detail="Confirming that the local timeline reader is connected." />
        ) : !activityAvailable ? (
          <StatePanel state="unavailable" title="Activity is unavailable" detail={capabilities.activity.reason ?? "The read-only activity reader is not connected in this Hub process."} />
        ) : (
          <section aria-label="Team activity timeline">
            <Card className={styles.activityWorkbench} data-activity-workbench="ready">
              <div className={styles.activityBoundary}>
                <LockKeyhole aria-hidden="true" />
                <p><strong>Shared MEX changes are recorded automatically and cannot be edited here.</strong> They travel between teammates through Git. Refresh after an agent writes locally or after you pull new changes.</p>
              </div>
              <Separator />
              <Tabs className={styles.activityTabs} onValueChange={updateSource} value={source}>
                <header className={styles.activityToolbar}>
                  <div className={styles.activitySourceControl}>
                    <span>Source</span>
                    <TabsList aria-label="Activity source" className={styles.sourceTabs} variant="line">
                      {ACTIVITY_FILTERS.map((value) => (
                        <TabsTrigger key={value} value={value}>{activityFilterLabel(value)}</TabsTrigger>
                      ))}
                    </TabsList>
                  </div>
                  <div className={styles.activityDateControl}>
                    <label htmlFor="activity-from-date"><span><CalendarDays aria-hidden="true" /> From</span></label>
                    <Input id="activity-from-date" onChange={(event) => updateSince(event.currentTarget.value)} type="date" value={since} />
                    {since ? <Button onClick={() => updateSince("", true)} size="sm" type="button" variant="ghost">Clear date</Button> : null}
                  </div>
                </header>
                <div className="sr-only" aria-live="polite" ref={resultStatusRef} role="status" tabIndex={-1}>
                  {items.length} {items.length === 1 ? "event" : "events"} shown
                </div>
                <Separator />
                {ACTIVITY_FILTERS.map((value) => (
                  <TabsContent className={styles.activityResult} key={value} value={value}>
                    {source === value ? result : null}
                  </TabsContent>
                ))}
              </Tabs>
            </Card>
          </section>
        )}
    </div>
  );
}

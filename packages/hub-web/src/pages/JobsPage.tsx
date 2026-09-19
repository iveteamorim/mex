import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  DatabaseZap,
  LoaderCircle,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type { CapabilitiesResponse, GraphHealthDetails, JobKind, JobProgress, JobState, JobSummary, WikiHealthDetails } from "../api/types";
import { RebuildConfirmation } from "../components/RebuildConfirmation";
import {
  ErrorState,
  formatDate,
  PageHeader,
  sentenceCase,
  StatePanel,
  StatusPill,
  stateTone,
} from "../components/ui";
import { Button } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import { Progress as ProgressPrimitive } from "../components/primitives/progress";
import {
  invalidateIndexOperationState,
  isActiveJob,
  isGraphJob,
  isWikiJob,
} from "../app/JobLifecycleObserver";
import {
  boundedNextCursor,
  MAX_ACCUMULATED_WORKBENCH_ITEMS,
  MAX_WORKBENCH_PAGES,
} from "../lib/bounds";
import styles from "../styles/jobs.module.css";

const operations: Array<{ kind: JobKind; label: string; detail: string }> = [
  { kind: "graph_refresh", label: "Refresh graph", detail: "Check for changes and update the code graph" },
  { kind: "graph_rebuild", label: "Rebuild graph", detail: "Replace the derived graph safely" },
  { kind: "wiki_refresh", label: "Refresh Wiki", detail: "Update structured project memory" },
  { kind: "wiki_rebuild", label: "Rebuild Wiki", detail: "Recreate the derived Wiki index" },
];

const graphPhases = ["discover", "stage", "parse", "resolve", "validate", "publish"] as const;

type JobFilter = "all" | "active" | "history";

function percentage(progress: JobProgress | null): number | null {
  if (!progress?.total) return null;
  return Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100)));
}

function graphPhaseIndex(phase: string): number {
  return graphPhases.indexOf(phase.trim().toLowerCase() as typeof graphPhases[number]);
}

function operationCapability(
  capabilities: CapabilitiesResponse | undefined,
  kind: JobKind,
  graphHealth: GraphHealthDetails | undefined,
  wikiHealth: WikiHealthDetails | undefined,
  healthSettled: boolean,
): { available: boolean; reason?: string } {
  if (!capabilities || capabilities.jobs.availability === "unavailable") {
    return { available: false, reason: capabilities?.jobs.reason ?? "Job execution is unavailable." };
  }
  const capability = kind === "graph_refresh"
    ? capabilities.graph.refresh
    : kind === "graph_rebuild"
      ? capabilities.graph.rebuild
      : kind === "wiki_rebuild"
        ? capabilities.wiki.rebuild
        : capabilities.wiki.refresh;
  if (capability.availability !== "available") return { available: false, reason: capability.reason };
  const activeIndexJobId = graphHealth?.activeJobId ?? wikiHealth?.activeJobId;
  if (activeIndexJobId) {
    return { available: false, reason: `Index job ${activeIndexJobId} is already active.` };
  }
  if (isGraphJob(kind)) {
    if (!healthSettled || !graphHealth) {
      return { available: false, reason: "Graph health must be readable before starting an index operation." };
    }
    if (!graphHealth.allowedJobKinds.includes(kind)) {
      return { available: false, reason: "The current graph state does not allow this operation." };
    }
  }
  if (isWikiJob(kind)) {
    if (!healthSettled || !wikiHealth) {
      return { available: false, reason: "Wiki health must be readable before starting an index operation." };
    }
    if (!wikiHealth.allowedJobKinds.includes(kind)) {
      return { available: false, reason: "The current Wiki state does not allow this operation." };
    }
  }
  return { available: true };
}

function JobStateIcon({ state }: { state: JobState }) {
  if (state === "succeeded") return <Check aria-hidden="true" />;
  if (state === "failed") return <X aria-hidden="true" />;
  if (state === "interrupted") return <Ban aria-hidden="true" />;
  if (state === "running") return <LoaderCircle aria-hidden="true" className={styles.spin} />;
  return <Clock3 aria-hidden="true" />;
}

function JobProgressView({ job }: { job: JobSummary }) {
  // Graph's durable counts describe parsed files, not overall job completion.
  const graph = isGraphJob(job.kind);
  const value = graph && job.phase !== "parse" ? null : percentage(job.progress);
  const phase = graphPhaseIndex(job.phase) >= 0 ? sentenceCase(job.phase) : job.phase;
  return (
    <div className={styles.progressBlock}>
      <div>
        <span>{phase}</span>
        <span>{graph && job.progress
          ? `${job.progress.completed}${job.progress.total === undefined ? "" : ` / ${job.progress.total}`} files parsed`
          : value === null ? (job.progress ? `${job.progress.completed} complete · total unknown` : "Total unknown") : `${value}%`}</span>
      </div>
      {value === null ? null : (
        <ProgressPrimitive aria-label={`${value}% ${graph ? "of files parsed" : "complete"}`} className={styles.progressTrack} value={value} />
      )}
    </div>
  );
}

function GraphPhaseRail({ job }: { job: JobSummary }) {
  if (!isGraphJob(job.kind) && !isWikiJob(job.kind)) return null;
  const activeIndex = graphPhaseIndex(job.phase);
  const complete = job.state === "succeeded";
  return (
    <div className={styles.graphPhaseRail} aria-label={isGraphJob(job.kind) ? "Graph operation phases" : "Wiki operation phases"}>
      {graphPhases.map((phase, index) => {
        const phaseComplete = complete || (activeIndex >= 0 && index < activeIndex);
        const current = job.state === "running" && activeIndex === index;
        const stopped = (job.state === "failed" || job.state === "interrupted") && activeIndex === index;
        return (
          <span data-state={phaseComplete ? "complete" : current ? "current" : stopped ? "stopped" : "pending"} key={phase}>
            <i aria-hidden="true">{phaseComplete ? <Check /> : index + 1}</i>
            <small aria-current={current ? "step" : undefined}>{sentenceCase(phase)}</small>
          </span>
        );
      })}
    </div>
  );
}

function JobRow({ job, selected, onSelect }: { job: JobSummary; selected: boolean; onSelect: () => void }) {
  return (
    <Button
      aria-pressed={selected}
      className={`${styles.jobRow} ${selected ? styles.jobRowSelected : ""}`}
      data-job-id={job.id}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      <span className={styles.jobStateIcon} data-tone={stateTone(job.state)}><JobStateIcon state={job.state} /></span>
      <span className={styles.jobIdentity}>
        <span><strong>{sentenceCase(job.kind)}</strong><StatusPill tone={stateTone(job.state)}>{job.cancelRequested ? "Cancelling" : sentenceCase(job.state)}</StatusPill></span>
        <small className={styles.mono}>{job.id}</small>
      </span>
      <JobProgressView job={job} />
      <time>{formatDate(job.finishedAt ?? job.startedAt ?? job.createdAt)}</time>
      <ChevronRight aria-hidden="true" />
    </Button>
  );
}

function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const detailRef = useRef<HTMLElement>(null);
  const job = useQuery({ queryKey: ["job", jobId], queryFn: () => api.getJob(jobId), retry: false });
  const cancel = useMutation({
    mutationFn: () => api.cancelJob(jobId),
    onSuccess: async (next) => {
      queryClient.setQueryData(["job", jobId], next);
      if (isGraphJob(next.kind) || isWikiJob(next.kind)) await Promise.all([
        invalidateIndexOperationState(queryClient),
        queryClient.invalidateQueries({ queryKey: ["job-lifecycle"] }),
      ]);
      else await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  useEffect(() => {
    detailRef.current?.focus({ preventScroll: window.innerWidth > 1170 });
  }, [jobId, job.isPending]);

  if (job.isPending) return <aside className={styles.jobDetail} ref={detailRef} tabIndex={-1}><StatePanel compact state="loading" title="Loading job" detail="Reading the persisted operation summary." /></aside>;
  if (job.isError) return <aside className={styles.jobDetail} ref={detailRef} tabIndex={-1}><ErrorState error={job.error} retry={() => void job.refetch()} /></aside>;
  const item = job.data;
  return (
    <aside className={styles.jobDetail} aria-label="Job detail" ref={detailRef} tabIndex={-1}>
      <div className={styles.detailHeader}>
        <div><p className={styles.panelEyebrow}>Operation detail</p><h2>{sentenceCase(item.kind)}</h2></div>
        <Button aria-label="Close job detail" className={styles.iconButton} onClick={onClose} size="icon-sm" type="button" variant="ghost"><X /></Button>
      </div>
      <div className={styles.detailState}>
        <span className={styles.jobStateIcon} data-tone={stateTone(item.state)}><JobStateIcon state={item.state} /></span>
        <div><StatusPill tone={stateTone(item.state)}>{item.cancelRequested ? "Cancelling" : sentenceCase(item.state)}</StatusPill><small>{graphPhaseIndex(item.phase) >= 0 ? sentenceCase(item.phase) : item.phase}</small></div>
      </div>
      <JobProgressView job={item} />
      <GraphPhaseRail job={item} />
      <dl className={styles.detailList}>
        <div><dt>Job ID</dt><dd className={styles.mono}>{item.id}</dd></div>
        {typeof item.generation === "number" ? <div><dt>Generation</dt><dd className={styles.mono}>{item.generation}</dd></div> : null}
        <div><dt>Created</dt><dd>{formatDate(item.createdAt)}</dd></div>
        {item.startedAt ? <div><dt>Started</dt><dd>{formatDate(item.startedAt)}</dd></div> : null}
        {item.finishedAt ? <div><dt>Finished</dt><dd>{formatDate(item.finishedAt)}</dd></div> : null}
        <div><dt>Revision</dt><dd className={styles.mono}>{item.revision.slice(0, 12)}</dd></div>
      </dl>
      {item.summary ? <div className={styles.detailNote}><strong>Summary</strong><p>{item.summary}</p></div> : null}
      {item.problem ? (
        <div className={styles.problemNote} role="alert">
          <strong>{item.problem.title ?? sentenceCase(item.problem.code)}</strong>
          {item.problem.detail ? <p>{item.problem.detail}</p> : null}
          <small className={styles.mono}>{item.problem.code}</small>
        </div>
      ) : null}
      {item.interruptedReason ? <div className={styles.detailNote}><strong>Interruption reason</strong><p>{sentenceCase(item.interruptedReason)}</p></div> : null}
      {item.cancelRequested && isActiveJob(item) ? <div className={styles.detailNote} role="status"><strong>Cancellation requested</strong><p>The executor is stopping safely. This job remains active until it settles as interrupted.</p></div> : null}
      {isActiveJob(item) ? (
        <Button className={styles.dangerButton} disabled={cancel.isPending || item.cancelRequested} onClick={() => cancel.mutate()} type="button" variant="destructive">
          <CircleStop aria-hidden="true" data-icon="inline-start" /> {cancel.isPending || item.cancelRequested ? "Cancelling…" : "Cancel job"}
        </Button>
      ) : null}
      {cancel.isError ? <p className={styles.inlineProblem} role="alert">{cancel.error instanceof Error ? cancel.error.message : "Cancellation failed"}</p> : null}
    </aside>
  );
}

export function JobsPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("job");
  const previousSelectedId = useRef<string | null>(selectedId);
  const rebuildTriggerRef = useRef<HTMLElement | null>(null);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [confirmRebuild, setConfirmRebuild] = useState<"graph_rebuild" | "wiki_rebuild" | null>(null);
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.getHealth(), retry: false });
  const jobs = useInfiniteQuery({
    queryKey: ["jobs"],
    queryFn: ({ pageParam }) => api.getJobs(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, allPages) => boundedNextCursor(lastPage.nextCursor, allPages.length),
    retry: false,
  });
  const start = useMutation({
    mutationFn: (kind: JobKind) => api.startJob({ kind }),
    onSuccess: async (job) => {
      if (isGraphJob(job.kind) || isWikiJob(job.kind)) await Promise.all([
        invalidateIndexOperationState(queryClient),
        queryClient.invalidateQueries({ queryKey: ["job-lifecycle"] }),
      ]);
      else await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setConfirmRebuild(null);
      setParams({ job: job.id });
    },
    onError: () => {
      setConfirmRebuild(null);
      rebuildTriggerRef.current?.focus({ preventScroll: true });
    },
  });

  const allJobs = useMemo(() => jobs.data?.pages.flatMap((page) => page.items) ?? [], [jobs.data]);
  const pageBoundReached = (jobs.data?.pages.length ?? 0) >= MAX_WORKBENCH_PAGES
    && jobs.data?.pages.at(-1)?.nextCursor !== null;
  const visibleJobs = allJobs.filter((job) => filter === "all" || (filter === "active" ? isActiveJob(job) : !isActiveJob(job)));
  const graphHealth = health.data?.components.find((component) => component.id === "graph")?.graph;
  const wikiHealth = health.data?.components.find((component) => component.id === "wiki")?.wiki;

  useEffect(() => {
    const previous = previousSelectedId.current;
    previousSelectedId.current = selectedId;
    if (previous !== null && selectedId === null) {
      document.querySelector<HTMLElement>(`[data-job-id="${previous}"]`)?.focus({ preventScroll: true });
    }
  }, [selectedId]);

  const contention = start.error instanceof HubApiError && start.error.problem.code === "JOB_ALREADY_RUNNING"
    ? start.error.problem
    : null;

  return (
    <div className={styles.page}>
      <PageHeader title="Jobs" />

      <Card aria-label="Start an operation" className={styles.operationStrip} role="region" size="sm">
        <CardHeader className={styles.operationHeader}>
          <CardTitle className={styles.operationTitle}>
            <DatabaseZap aria-hidden="true" />
            <h2>Start operation</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className={styles.operationGrid}>
          {operations.map((operation) => {
            const capability = operationCapability(capabilities, operation.kind, graphHealth, wikiHealth, health.isSuccess);
            return (
              <Button
                className={styles.operationButton}
                disabled={!capability.available || start.isPending}
                key={operation.kind}
                onClick={(event) => {
                  if (operation.kind === "graph_rebuild" || operation.kind === "wiki_rebuild") {
                    rebuildTriggerRef.current = event.currentTarget;
                    setConfirmRebuild(operation.kind);
                  } else start.mutate(operation.kind);
                }}
                title={!capability.available ? (capability.reason ?? `${operation.label} is unavailable in this build`) : operation.detail}
                type="button"
                variant="outline"
              >
                {start.isPending && start.variables === operation.kind
                  ? <LoaderCircle aria-hidden="true" className={styles.spin} data-icon="inline-start" />
                  : <Play aria-hidden="true" data-icon="inline-start" />}
                <span>
                  <strong>{operation.label}</strong>
                  {!capability.available ? <small>{capability.reason ?? "Capability unavailable"}</small> : null}
                </span>
              </Button>
            );
          })}
        </CardContent>
      </Card>

      {contention ? (
        <div className={styles.notice} data-tone="warning" role="alert">
          <RotateCcw aria-hidden="true" />
          <span><strong>An index operation is already running.</strong>The active job must finish or be cancelled before another starts.</span>
          <Button onClick={() => setFilter("active")} size="sm" type="button" variant="outline">Show active jobs</Button>
        </div>
      ) : start.isError ? <ErrorState error={start.error} /> : null}

      <div className={`${styles.jobsWorkspace} ${selectedId ? styles.jobsWorkspaceOpen : ""}`}>
        <Card className={styles.jobsListPanel} size="sm">
          <CardHeader className={styles.listToolbar}>
            <CardTitle><h2>Operation log</h2></CardTitle>
            <CardAction>
              <div aria-label="Filter jobs" className={styles.segmented} role="group">
                {(["all", "active", "history"] as const).map((value) => (
                  <Button
                    aria-pressed={filter === value}
                    key={value}
                    onClick={() => setFilter(value)}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    {sentenceCase(value)}
                  </Button>
                ))}
              </div>
            </CardAction>
          </CardHeader>
          <CardContent className={styles.jobsListContent}>
            {jobs.isPending ? (
              <StatePanel compact state="loading" title="Loading jobs" detail="Reading persisted job summaries." />
            ) : jobs.isError ? (
              <ErrorState error={jobs.error} retry={() => void jobs.refetch()} />
            ) : visibleJobs.length ? (
              <div className={styles.jobRows}>
                {visibleJobs.map((job) => (
                  <JobRow
                    job={job}
                    key={job.id}
                    onSelect={() => setParams({ job: job.id })}
                    selected={selectedId === job.id}
                  />
                ))}
                {jobs.hasNextPage ? (
                  <Button className={styles.loadMore} disabled={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()} type="button" variant="outline">
                    {jobs.isFetchingNextPage ? "Loading…" : "Load older jobs"}
                  </Button>
                ) : pageBoundReached ? (
                  <p className={styles.boundNote} role="status">
                    Browser safety limit reached at {MAX_ACCUMULATED_WORKBENCH_ITEMS} jobs.
                  </p>
                ) : null}
              </div>
            ) : (
              <StatePanel compact state="empty" title={allJobs.length ? `No ${filter} jobs` : "No jobs recorded"} detail={allJobs.length ? "Choose another filter to see recorded work." : "Start a supported operation to create the first persisted job."} />
            )}
          </CardContent>
        </Card>
        {selectedId ? <JobDetail jobId={selectedId} onClose={() => setParams({})} /> : null}
      </div>
      <RebuildConfirmation
        onCancel={() => {
          setConfirmRebuild(null);
          rebuildTriggerRef.current?.focus({ preventScroll: true });
        }}
        onConfirm={() => { if (confirmRebuild) start.mutate(confirmRebuild); }}
        open={confirmRebuild !== null}
        pending={start.isPending && start.variables === confirmRebuild}
        target={confirmRebuild === "wiki_rebuild" ? "wiki" : "graph"}
      />
    </div>
  );
}

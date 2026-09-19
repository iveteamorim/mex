import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CalendarClock,
  ChevronRight,
  CircleDot,
  GitCommitHorizontal,
  Milestone,
  Pencil,
  Plus,
  Route,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  TeamActorRef,
  TeamCurrentActorResponse,
  TeamOperationApplyResponse,
  TeamOperationPreviewRequest,
  TeamOperationPreviewResponse,
  TeamWorkstream,
  TeamWorkstreamState,
  Tone,
} from "../api/types";
import { ApplyTeamOperationDialog, TeamOperationPreviewPanel } from "../components/TeamOperationReview";
import { Button } from "../components/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/primitives/dialog";
import { Input } from "../components/primitives/input";
import { Textarea } from "../components/primitives/textarea";
import { ErrorState, PageHeader, StatePanel, StatusPill, formatDate, sentenceCase } from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import styles from "../styles/workstreams.module.css";

const WORKSTREAM_PAGE_SIZE = 50;
const workstreamFilters = ["all", "planned", "active", "blocked", "done", "archived"] as const;
type WorkstreamFilter = (typeof workstreamFilters)[number];
type MutableWorkstreamState = Exclude<TeamWorkstreamState, "archived">;
type WorkstreamOperation =
  | { kind: "create"; actor: TeamActorRef }
  | { kind: "update"; workstream: TeamWorkstream }
  | { kind: "archive"; workstream: TeamWorkstream };

const lifecycleTransitions: Record<TeamWorkstreamState, readonly TeamWorkstreamState[]> = {
  planned: ["planned", "active"],
  active: ["active", "blocked", "done"],
  blocked: ["blocked", "active", "done"],
  done: ["done"],
  archived: ["archived"],
};

function stateTone(state: TeamWorkstreamState): Tone {
  if (state === "active") return "info";
  if (state === "blocked") return "warning";
  if (state === "done") return "success";
  return "neutral";
}

function actorLabel(actor: TeamActorRef): string {
  if (actor.kind === "member") return actor.displayName ?? actor.memberId;
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

function workstreamExpectation(workstream: TeamWorkstream) {
  return {
    target: { kind: "artifact" as const, path: workstream.sourcePath },
    revision: workstream.revision,
  };
}

function operationId(kind: WorkstreamOperation["kind"]): string {
  return `hub_workstream_${kind}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function parseBlockers(value: string): { blockers: string[]; error: string | null } {
  const blockers = value.split("\n").map((item) => item.trim()).filter(Boolean);
  if (blockers.length > 64) return { blockers: [], error: "Use no more than 64 blockers." };
  if (new Set(blockers).size !== blockers.length) {
    return { blockers: [], error: "Each blocker must be unique." };
  }
  if (blockers.some((item) => new TextEncoder().encode(item).byteLength > 4 * 1024)) {
    return { blockers: [], error: "Each blocker must fit within 4 KiB." };
  }
  return { blockers, error: null };
}

function validText(value: string, maximum: number): boolean {
  return value.trim() === value
    && value.length > 0
    && value.normalize("NFC") === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= maximum;
}

function operationTitle(operation: WorkstreamOperation): string {
  if (operation.kind === "create") return "Create Workstream";
  if (operation.kind === "archive") return `Archive ${operation.workstream.title}`;
  return `Update ${operation.workstream.title}`;
}

function operationConsequence(operation: WorkstreamOperation): string {
  if (operation.kind === "archive") {
    return "This publishes an immutable archival transition and one Activity event. Archived Workstreams cannot be edited.";
  }
  return "This publishes the reviewed canonical Workstream bytes and one immutable Activity event.";
}

function WorkstreamOperationDialog({
  operation,
  onClose,
  onApplied,
}: {
  operation: WorkstreamOperation;
  onClose(): void;
  onApplied(result: TeamOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const id = useRef(operationId(operation.kind));
  const existing = operation.kind === "create" ? null : operation.workstream;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [goal, setGoal] = useState(existing?.goal ?? "");
  const [summary, setSummary] = useState(existing?.summary ?? "");
  const [currentState, setCurrentState] = useState(existing?.currentState ?? "");
  const [nextMilestone, setNextMilestone] = useState(existing?.nextMilestone ?? "");
  const [state, setState] = useState<MutableWorkstreamState>(
    existing?.state === "archived" ? "done" : existing?.state ?? "planned",
  );
  const [blockersText, setBlockersText] = useState(existing?.blockers.join("\n") ?? "");
  const [envelope, setEnvelope] = useState<TeamOperationPreviewResponse | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const blockers = parseBlockers(blockersText);
  const hasForm = operation.kind !== "archive";
  const canPreview = operation.kind === "archive" || (
    validText(title, 512)
    && validText(goal, 4 * 1024)
    && validText(summary, 4 * 1024)
    && validText(nextMilestone, 4 * 1024)
    && (operation.kind === "create" || validText(currentState, 8 * 1024))
    && blockers.error === null
    && (state !== "blocked" || blockers.blockers.length > 0)
  );

  const request = (): TeamOperationPreviewRequest => {
    if (operation.kind === "create") {
      return {
        operationId: id.current,
        action: {
          kind: "workstream.create",
          workstream: {
            title,
            goal,
            summary,
            owners: [operation.actor],
            nextMilestone,
          },
        },
        expectedRevisions: [],
      };
    }
    if (operation.kind === "archive") {
      return {
        operationId: id.current,
        action: { kind: "workstream.archive", workstreamId: operation.workstream.id },
        expectedRevisions: [workstreamExpectation(operation.workstream)],
      };
    }
    return {
      operationId: id.current,
      action: {
        kind: "workstream.update",
        workstreamId: operation.workstream.id,
        patch: {
          title,
          goal,
          summary,
          state,
          blockers: state === "blocked" ? blockers.blockers : [],
          currentState,
          nextMilestone,
        },
      },
      expectedRevisions: [workstreamExpectation(operation.workstream)],
    };
  };

  const preview = useMutation({
    mutationFn: () => api.previewTeamOperation(request()),
    onSuccess: setEnvelope,
  });
  const apply = useMutation({
    mutationFn: () => {
      if (envelope === null) throw new Error("Preview is unavailable.");
      return api.applyTeamOperation(envelope);
    },
    onSuccess: async (result) => {
      setApplyOpen(false);
      await onApplied(result);
      onClose();
    },
  });
  const invalidatePreview = () => {
    setEnvelope(null);
    setApplyOpen(false);
    preview.reset();
    apply.reset();
  };
  const field = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    invalidatePreview();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !apply.isPending) onClose(); }}>
      <DialogContent className={styles.operationDialog}>
        <DialogHeader>
          <DialogTitle>{operationTitle(operation)}</DialogTitle>
          <DialogDescription>{operationConsequence(operation)} Previewing does not write.</DialogDescription>
        </DialogHeader>

        {hasForm ? (
          <div className={styles.formGrid}>
            <label>
              <span>Title</span>
              <Input autoFocus maxLength={512} onChange={(event) => field(setTitle)(event.currentTarget.value)} value={title} />
            </label>
            <label>
              <span>Goal</span>
              <Input maxLength={4 * 1024} onChange={(event) => field(setGoal)(event.currentTarget.value)} value={goal} />
            </label>
            <label>
              <span>Summary</span>
              <Input maxLength={4 * 1024} onChange={(event) => field(setSummary)(event.currentTarget.value)} value={summary} />
            </label>
            {operation.kind === "update" ? (
              <>
                <label>
                  <span>Lifecycle state</span>
                  <select
                    aria-label="Lifecycle state"
                    onChange={(event) => {
                      setState(event.currentTarget.value as MutableWorkstreamState);
                      invalidatePreview();
                    }}
                    value={state}
                  >
                    {lifecycleTransitions[operation.workstream.state].map((candidate) => (
                      <option key={candidate} value={candidate}>{sentenceCase(candidate)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Current state</span>
                  <Input maxLength={8 * 1024} onChange={(event) => field(setCurrentState)(event.currentTarget.value)} value={currentState} />
                </label>
              </>
            ) : null}
            <label>
              <span>Next milestone</span>
              <Input maxLength={4 * 1024} onChange={(event) => field(setNextMilestone)(event.currentTarget.value)} value={nextMilestone} />
            </label>
            {operation.kind === "update" && state === "blocked" ? (
              <label className={styles.formWide}>
                <span>Blockers <small>one per line</small></span>
                <Textarea
                  aria-invalid={blockers.error !== null || blockers.blockers.length === 0 || undefined}
                  onChange={(event) => field(setBlockersText)(event.currentTarget.value)}
                  rows={4}
                  value={blockersText}
                />
              </label>
            ) : null}
            {blockers.error ? <p className={styles.formError} role="alert">{blockers.error}</p> : null}
            {operation.kind === "update" && state === "blocked" && blockers.blockers.length === 0 ? (
              <p className={styles.formError} role="alert">A blocked Workstream requires at least one blocker.</p>
            ) : null}
          </div>
        ) : (
          <div className={styles.operationNotice}>
            <Archive aria-hidden="true" />
            <span>{operationConsequence(operation)}</span>
          </div>
        )}

        {preview.isError ? <ErrorState error={preview.error} retry={() => preview.mutate()} /> : null}
        {envelope ? <TeamOperationPreviewPanel envelope={envelope} /> : null}
        <div className="sr-only" aria-live="polite" role="status">
          {preview.isPending ? "Preparing Workstream preview" : envelope ? "Workstream preview ready for approval" : ""}
          {apply.isPending ? "Applying approved Workstream preview" : ""}
        </div>

        <DialogFooter>
          <DialogClose render={<Button disabled={preview.isPending || apply.isPending} variant="outline" />}>
            Cancel
          </DialogClose>
          {envelope ? (
            <Button disabled={!envelope.preview.valid || apply.isPending} onClick={() => setApplyOpen(true)}>
              Review apply
            </Button>
          ) : (
            <Button disabled={!canPreview || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? "Previewing…" : "Preview change"}
            </Button>
          )}
        </DialogFooter>

        {envelope ? (
          <ApplyTeamOperationDialog
            consequence={operationConsequence(operation)}
            envelope={envelope}
            error={apply.isError ? apply.error : undefined}
            onApply={() => apply.mutate()}
            onOpenChange={setApplyOpen}
            open={applyOpen}
            pending={apply.isPending}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailList({
  title,
  items,
  empty,
}: {
  title: string;
  items: readonly string[];
  empty: string;
}) {
  return (
    <section className={styles.detailList}>
      <header><h3>{title}</h3><span>{items.length}</span></header>
      {items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>}
    </section>
  );
}

function WorkstreamDetail({
  workstream,
  canMutate,
  onOperation,
}: {
  workstream: TeamWorkstream;
  canMutate: boolean;
  onOperation(operation: WorkstreamOperation, event: MouseEvent<HTMLButtonElement>): void;
}) {
  return (
    <>
      <header className={styles.detailHeader}>
        <div>
          <p>Canonical Workstream</p>
          <h2>{workstream.title}</h2>
          <code>{workstream.id}</code>
        </div>
        <StatusPill tone={stateTone(workstream.state)}>{sentenceCase(workstream.state)}</StatusPill>
      </header>
      <div className={styles.detailNarrative}>
        <section><span>Goal</span><p>{workstream.goal}</p></section>
        <section><span>Summary</span><p>{workstream.summary}</p></section>
      </div>
      <dl className={styles.detailFacts}>
        <div><dt>Current state</dt><dd><CircleDot aria-hidden="true" /> {workstream.currentState}</dd></div>
        <div><dt>Next milestone</dt><dd><Milestone aria-hidden="true" /> {workstream.nextMilestone}</dd></div>
        <div><dt>Revision</dt><dd><GitCommitHorizontal aria-hidden="true" /> <code>{workstream.revision.slice(0, 12)}</code></dd></div>
        <div><dt>Updated</dt><dd><CalendarClock aria-hidden="true" /> {formatDate(workstream.updatedAt)}</dd></div>
      </dl>
      <div className={styles.detailColumns}>
        <DetailList title="Owners" items={workstream.owners.map(actorLabel)} empty="No owners recorded." />
        <DetailList title="Contributors" items={workstream.contributors.map(actorLabel)} empty="No contributors recorded." />
        <DetailList title="Blockers" items={workstream.blockers} empty="No blockers recorded." />
        <DetailList title="Repository paths" items={workstream.paths} empty="No repository paths linked." />
      </div>
      <footer className={styles.detailActions}>
        <span><Route aria-hidden="true" /> Semantic revision {workstream.entityRevision}</span>
        {canMutate && workstream.state !== "archived" ? (
          <div>
            <Button onClick={(event) => onOperation({ kind: "update", workstream }, event)} type="button" variant="outline">
              <Pencil aria-hidden="true" /> Update
            </Button>
            <Button onClick={(event) => onOperation({ kind: "archive", workstream }, event)} type="button" variant="outline">
              <Archive aria-hidden="true" /> Archive
            </Button>
          </div>
        ) : null}
      </footer>
    </>
  );
}

export function WorkstreamsPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [filter, setFilter] = useState<WorkstreamFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operation, setOperation] = useState<WorkstreamOperation | null>(null);
  const [status, setStatus] = useState("");
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  const operationWasOpen = useRef(false);
  const readAvailable = capabilities?.workstreams.read.availability === "available";
  const canMutate = capabilities?.workstreams.canonicalMutation.availability === "available";

  useEffect(() => {
    if (operationWasOpen.current && operation === null) {
      operationTrigger.current?.focus({ preventScroll: true });
    }
    operationWasOpen.current = operation !== null;
  }, [operation]);

  const currentActor = useQuery({
    queryKey: ["actor", "current"],
    queryFn: () => api.getCurrentActor(),
    enabled: Boolean(canMutate),
    retry: false,
  });
  const workstreams = useInfiniteQuery({
    queryKey: ["workstreams", filter],
    queryFn: ({ pageParam }) => api.getWorkstreams({
      limit: WORKSTREAM_PAGE_SIZE,
      ...(filter === "all" ? {} : { state: filter }),
      ...(filter === "archived" ? { includeArchived: true } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: readAvailable,
    retry: false,
  });
  const rows = useMemo(() => {
    const unique = new Map<string, TeamWorkstream>();
    for (const page of workstreams.data?.pages ?? []) {
      for (const workstream of page.items) unique.set(workstream.id, workstream);
    }
    return [...unique.values()];
  }, [workstreams.data?.pages]);
  const listDiagnostics = useMemo(() => {
    const unique = new Map<string, string>();
    for (const page of workstreams.data?.pages ?? []) {
      for (const diagnostic of page.diagnostics) {
        unique.set(`${diagnostic.code}:${diagnostic.path ?? ""}:${diagnostic.message}`, diagnostic.message);
      }
    }
    return [...unique.values()];
  }, [workstreams.data?.pages]);
  const sourceTruncated = workstreams.data?.pages.some((page) => page.sourceTruncated) ?? false;
  const diagnosticsTruncated = workstreams.data?.pages.some((page) => page.diagnosticsTruncated) ?? false;
  const detailId = selectedId ?? rows[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["workstream", detailId],
    queryFn: () => api.getWorkstream(detailId!),
    enabled: readAvailable && detailId !== null,
    retry: false,
  });

  const openOperation = (next: WorkstreamOperation, event: MouseEvent<HTMLButtonElement>) => {
    operationTrigger.current = event.currentTarget;
    setOperation(next);
  };
  const onApplied = async (result: TeamOperationApplyResponse) => {
    const affected = result.workstreams[0] ?? null;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workstreams"] }),
      ...(affected === null ? [] : [queryClient.invalidateQueries({ queryKey: ["workstream", affected.id] })]),
      queryClient.invalidateQueries({ queryKey: ["activity"] }),
      queryClient.invalidateQueries({ queryKey: ["home"] }),
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
    ]);
    if (affected) setSelectedId(affected.id);
    setStatus("Canonical Workstream change applied with one immutable Activity event.");
  };

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Team workflow"
        title="Workstreams"
        description="Track outcomes, lifecycle, ownership, blockers, and milestones in canonical Git-owned records."
        actions={canMutate && currentActor.data ? (
          <Button onClick={(event) => openOperation({ kind: "create", actor: currentActor.data.actor }, event)} type="button">
            <Plus aria-hidden="true" /> Create Workstream
          </Button>
        ) : undefined}
      />
      <div className={styles.liveStatus} aria-live="polite" role="status">{status}</div>

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking Workstream capability" detail="Confirming the repository-bound Team workflow connection." />
      ) : !readAvailable ? (
        <StatePanel state="unavailable" title="Workstreams are unavailable" detail={capabilities.workstreams.read.reason ?? "Workstream reads are not connected in this Hub process."} />
      ) : (
        <div className={styles.workbench}>
          <Card className={styles.rail} role="region" aria-labelledby="workstream-directory-heading">
            <CardHeader className={styles.railHeader}>
              <div>
                <CardDescription>Canonical portfolio</CardDescription>
                <CardTitle><h2 id="workstream-directory-heading">Delivery threads</h2></CardTitle>
              </div>
              <StatusPill>{rows.length} loaded</StatusPill>
            </CardHeader>
            <CardContent className={styles.railContent}>
              <div className={styles.filterBar} aria-label="Filter Workstreams" role="group">
                {workstreamFilters.map((value) => (
                  <Button
                    aria-pressed={filter === value}
                    key={value}
                    onClick={() => {
                      setFilter(value);
                      setSelectedId(null);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {sentenceCase(value)}
                  </Button>
                ))}
              </div>
              {workstreams.isPending ? (
                <StatePanel compact state="loading" title="Reading Workstreams" detail="Scanning the bounded canonical directory." />
              ) : workstreams.isError ? (
                <ErrorState error={workstreams.error} retry={() => void workstreams.refetch()} />
              ) : rows.length === 0 ? (
                <StatePanel
                  compact
                  state="empty"
                  title={sourceTruncated || listDiagnostics.length || diagnosticsTruncated ? "No trusted Workstreams available" : "No matching Workstreams"}
                  detail={sourceTruncated || listDiagnostics.length || diagnosticsTruncated
                    ? "The bounded source scan could not establish a complete result. Review repository health before treating this as empty."
                    : "Choose another lifecycle filter or create a Workstream."}
                />
              ) : (
                <ul className={styles.workstreamList}>
                  {rows.map((workstream) => (
                    <li key={workstream.id}>
                      <button
                        aria-current={detailId === workstream.id ? "true" : undefined}
                        onClick={() => setSelectedId(workstream.id)}
                        type="button"
                      >
                        <span className={styles.stateMarker} data-state={workstream.state}><CircleDot aria-hidden="true" /></span>
                        <span><strong>{workstream.title}</strong><small>{workstream.nextMilestone}</small></span>
                        <StatusPill tone={stateTone(workstream.state)}>{sentenceCase(workstream.state)}</StatusPill>
                        <ChevronRight aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                  </ul>
              )}
              {rows.length && (sourceTruncated || listDiagnostics.length || diagnosticsTruncated) ? (
                <aside className={styles.diagnosticNote} role="status">
                  <AlertTriangle aria-hidden="true" />
                  <span>
                    <strong>Some Workstream memory needs attention.</strong>{" "}
                    {listDiagnostics[0] ?? (sourceTruncated
                      ? "The source scan reached its safety bound."
                      : "Additional diagnostics were omitted by the response bound.")} Valid canonical rows remain visible.
                  </span>
                </aside>
              ) : null}
              {workstreams.hasNextPage ? (
                <Button
                  className={styles.loadMore}
                  disabled={workstreams.isFetchingNextPage}
                  onClick={() => void workstreams.fetchNextPage()}
                  type="button"
                  variant="outline"
                >
                  {workstreams.isFetchingNextPage ? "Loading…" : "Load more Workstreams"}
                </Button>
              ) : workstreams.data && workstreams.data.pages.length >= MAX_WORKBENCH_PAGES ? (
                <p className={styles.boundNote}>Browser page limit reached.</p>
              ) : null}
            </CardContent>
          </Card>

          <Card aria-label="Selected Workstream detail" className={styles.detail} role="region">
            {detailId === null ? (
              <StatePanel compact state="empty" title="No Workstream selected" detail="Choose a Workstream from the canonical portfolio." />
            ) : detail.isPending ? (
              <StatePanel compact state="loading" title="Reading Workstream detail" detail="Verifying the exact canonical revision." />
            ) : detail.isError ? (
              <ErrorState error={detail.error} retry={() => void detail.refetch()} />
            ) : (
              <WorkstreamDetail canMutate={Boolean(canMutate)} onOperation={openOperation} workstream={detail.data} />
            )}
          </Card>
        </div>
      )}

      <aside className={styles.boundaryNote}>
        {readAvailable ? <ShieldCheck aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
        <span><strong>Revision-bound.</strong> Every canonical change is previewed against the selected Workstream revision before apply.</span>
        <ArrowRight aria-hidden="true" />
      </aside>

      {operation ? (
        <WorkstreamOperationDialog onApplied={onApplied} onClose={() => setOperation(null)} operation={operation} />
      ) : null}
    </div>
  );
}

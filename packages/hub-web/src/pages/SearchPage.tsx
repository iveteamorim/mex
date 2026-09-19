import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Braces,
  FileCode2,
  FileSearch,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "../api/types";
import { ErrorState, PageHeader, StatePanel, StatusPill } from "../components/ui";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "../components/primitives/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import {
  appendBoundedUnique,
  MAX_ACCUMULATED_WORKBENCH_ITEMS,
} from "../lib/bounds";
import styles from "../styles/search.module.css";

type GroupKind = keyof SearchResponse["groups"];
type ResultGroupData = SearchResponse["groups"][GroupKind];

interface ResultGroupView {
  kind: GroupKind;
  label: string;
  group: ResultGroupData;
}

interface SearchOutletContext {
  capabilities?: CapabilitiesResponse;
  clearSearchFocusRequest?: () => void;
  searchFocusRequest?: number;
}

const cursorField: Record<GroupKind, "wikiCursor" | "symbolCursor" | "sourceCursor"> = {
  wiki: "wikiCursor",
  symbols: "symbolCursor",
  sources: "sourceCursor",
};

function SymbolResult({ item }: { item: Extract<SearchResult, { kind: "code_symbol" }> }) {
  return (
    <Item className={styles.searchResult} render={<Link to={item.route} />}>
      <ItemMedia className={styles.resultIcon} variant="icon"><Braces aria-hidden="true" /></ItemMedia>
      <ItemContent className={styles.resultBody}>
        <small>{item.symbolKind} · {item.language}</small>
        <ItemTitle>{item.name}</ItemTitle>
        <ItemDescription className={styles.resultQualified}>{item.qualifiedName}</ItemDescription>
        {item.signature ? <code className={styles.resultSignature}>{item.signature}</code> : null}
        <span className={styles.resultMetadata}>
          <span>{item.path}:{item.startLine}–{item.endLine}</span>
        </span>
      </ItemContent>
      <ItemActions className={styles.resultAction}><ArrowUpRight aria-hidden="true" /></ItemActions>
    </Item>
  );
}

function SourceResult({ item }: { item: Extract<SearchResult, { kind: "source_chunk" }> }) {
  const body = (
    <>
      <ItemMedia className={styles.resultIcon} variant="icon"><FileCode2 aria-hidden="true" /></ItemMedia>
      <ItemContent className={styles.resultBody}>
        <small>Source · lines {item.startLine}–{item.endLine}</small>
        <ItemTitle>{item.path}</ItemTitle>
        <pre className={styles.sourcePreview}>{item.preview}</pre>
        <span className={styles.resultMetadata}>
          {item.matchedTerms.slice(0, 4).map((term) => <Badge className={styles.termChip} key={term} variant="outline">{term}</Badge>)}
          {item.matchedTerms.length > 4 ? <span>+{item.matchedTerms.length - 4} terms</span> : null}
          {item.symbolIds.slice(0, 2).map((symbolId) => <span key={symbolId}>symbol {symbolId}</span>)}
          {item.symbolIds.length > 2 ? <span>+{item.symbolIds.length - 2} symbols</span> : null}
          {item.previewTruncated ? <span>Preview shortened</span> : null}
        </span>
      </ItemContent>
      {item.route ? <ItemActions className={styles.resultAction}><ArrowUpRight aria-hidden="true" /></ItemActions> : null}
    </>
  );
  return item.route
    ? <Item className={styles.searchResult} render={<Link to={item.route} />}>{body}</Item>
    : <Item className={styles.searchResult} render={<article />}>{body}</Item>;
}

function WikiResult({ item }: { item: Extract<SearchResult, { kind: "wiki" }> }) {
  return (
    <Item className={styles.searchResult} render={<Link to={item.route} />}>
      <ItemMedia className={styles.resultIcon} variant="icon"><FileSearch aria-hidden="true" /></ItemMedia>
      <ItemContent className={styles.resultBody}>
        <small>{item.entityKind} · {item.lifecycleState.replaceAll("_", " ")}</small>
        <ItemTitle>{item.title}</ItemTitle>
        {item.summary ? <ItemDescription>{item.summary}</ItemDescription> : null}
        <span className={styles.resultMetadata}>
          <span>{item.path}</span>
          <Badge className={styles.termChip} variant="outline">{item.groundingHealth}</Badge>
          {item.matchedFields.map((field) => <Badge className={styles.termChip} key={field} variant="secondary">{field}</Badge>)}
          {item.topics.slice(0, 2).map((topic) => <span key={topic}>topic {topic}</span>)}
        </span>
      </ItemContent>
      <ItemActions className={styles.resultAction}><ArrowUpRight aria-hidden="true" /></ItemActions>
    </Item>
  );
}

function Result({ item }: { item: SearchResult }) {
  if (item.kind === "code_symbol") return <SymbolResult item={item} />;
  if (item.kind === "source_chunk") return <SourceResult item={item} />;
  return <WikiResult item={item} />;
}

function ResultGroup({
  view,
  query,
  onReload,
}: {
  view: ResultGroupView;
  query: string;
  onReload: () => void;
}) {
  const api = useHubApi();
  const [group, setGroup] = useState(view.group);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const pagination = useMutation({
    mutationFn: async () => {
      if (group.status !== "available" || !group.nextCursor) return null;
      const request: SearchRequest = {
        q: query,
        limit: 25,
        [cursorField[view.kind]]: group.nextCursor,
      };
      return (await api.search(request)).groups[view.kind];
    },
    onSuccess: (next) => {
      if (!next || group.status !== "available") return;
      if (next.status !== "available") {
        if (next.code === "REVISION_CONFLICT") setRevisionConflict(true);
        else setPageFailed(true);
        return;
      }
      if (next.revision !== group.revision) {
        setRevisionConflict(true);
        return;
      }
      const accumulated = appendBoundedUnique(group.items, next.items, (item) => item.id);
      const boundReached = accumulated.omitted
        || (accumulated.items.length >= MAX_ACCUMULATED_WORKBENCH_ITEMS && next.nextCursor !== null);
      setGroup({
        ...next,
        items: accumulated.items,
        nextCursor: boundReached ? null : next.nextCursor,
        truncated: next.truncated || boundReached,
      });
    },
    onError: (error) => {
      if (error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") {
        setRevisionConflict(true);
      }
    },
  });

  function loadMore() {
    setPageFailed(false);
    pagination.mutate();
  }

  useEffect(() => {
    setGroup(view.group);
    setRevisionConflict(false);
    setPageFailed(false);
    pagination.reset();
  }, [view.group]);

  return (
    <Card className={styles.searchGroup} aria-labelledby={`group-${view.kind}`} data-kind={view.kind} size="sm">
      <CardHeader className={styles.searchGroupHeader}>
        <CardTitle><h2 id={`group-${view.kind}`}>{view.label}</h2></CardTitle>
        <CardAction>
          <StatusPill tone={group.status === "available" ? "neutral" : group.status === "failed" ? "danger" : "warning"}>
          {group.status === "available" ? `${group.items.length} loaded` : group.status}
          </StatusPill>
        </CardAction>
      </CardHeader>
      <CardContent className={styles.groupContent}>
        {group.status === "failed" ? (
          <div className={styles.groupProblem} role="status"><AlertTriangle aria-hidden="true" /><p><strong>This source failed independently.</strong>{group.detail}</p></div>
        ) : group.status === "unavailable" ? (
          <StatePanel compact state="unavailable" title={`${view.label} unavailable`} detail={group.detail ?? "This source is unavailable."} />
        ) : group.items.length ? (
          <div className={styles.searchResults}>{group.items.map((item) => <Result item={item} key={item.id} />)}</div>
        ) : (
          <StatePanel compact state="empty" title={`No ${view.label.toLowerCase()} found`} detail="This source completed successfully but returned no results." />
        )}
      </CardContent>

      {revisionConflict ? (
        <CardFooter className={styles.groupPaginationProblem} role="alert">
          <RefreshCw aria-hidden="true" />
          <span><strong>This source changed while you were paging.</strong>Reload the newest trusted snapshot before loading more results.</span>
          <Button onClick={onReload} size="sm" type="button" variant="outline">Reload results</Button>
        </CardFooter>
      ) : pagination.isError || pageFailed ? (
        <CardFooter className={styles.groupPaginationProblem} role="alert">
          <AlertTriangle aria-hidden="true" />
          <span><strong>More {view.label.toLowerCase()} could not be loaded.</strong>The results already on screen are unchanged.</span>
          <Button onClick={loadMore} size="sm" type="button" variant="outline">Try again</Button>
        </CardFooter>
      ) : group.status === "available" && group.nextCursor ? (
        <CardFooter className={styles.groupFooter}>
          <Button className={styles.loadMore} disabled={pagination.isPending} onClick={loadMore} type="button" variant="outline">
            {pagination.isPending ? "Loading…" : `Load more ${view.label.toLowerCase()}`}
          </Button>
        </CardFooter>
      ) : group.status === "available" && group.truncated ? (
        <CardFooter className={styles.truncatedNote}>This source reached its safety bound. Refine the query to narrow the result.</CardFooter>
      ) : null}
    </Card>
  );
}

function SearchWorkbench({
  focusRequest = 0,
  onFocusRequestHandled,
  scope,
}: {
  focusRequest?: number;
  onFocusRequestHandled?: () => void;
  scope: "project" | "code";
}) {
  const api = useHubApi();
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").slice(0, 256);
  const [draft, setDraft] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const search = useQuery({
    queryKey: ["search", query],
    queryFn: () => api.search({ q: query, limit: 25 }),
    enabled: query.trim().length > 0,
    retry: false,
  });

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    if (search.data) summaryRef.current?.focus({ preventScroll: true });
  }, [search.data]);

  useEffect(() => {
    if (scope === "project" && focusRequest > 0) {
      inputRef.current?.focus({ preventScroll: true });
      onFocusRequestHandled?.();
    }
  }, [focusRequest, onFocusRequestHandled, scope]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim().slice(0, 256);
    setParams(next ? { q: next } : {}, { replace: false });
  }

  function clear() {
    setDraft("");
    setParams({}, { replace: false });
  }

  const groups: ResultGroupView[] = search.data ? [
    ...(scope === "project" ? [{ kind: "wiki" as const, label: "Knowledge", group: search.data.groups.wiki }] : []),
    { kind: "symbols", label: "Code symbols", group: search.data.groups.symbols },
    { kind: "sources", label: "Source matches", group: search.data.groups.sources },
  ] : [];

  return (
    <div className={styles.searchWorkbench} data-scope={scope}>
      <Card className={styles.searchCommand} size="sm">
        <CardContent className={styles.searchCommandContent}>
          <form className={styles.searchForm} role="search" onSubmit={submit}>
            <InputGroup className={styles.searchInputGroup}>
              <InputGroupAddon className={styles.searchIcon}>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <label className={styles.srOnly} htmlFor={`${scope}-search`}>{scope === "project" ? "Search project memory and code" : "Search code symbols and source"}</label>
              <InputGroupInput autoComplete="off" id={`${scope}-search`} maxLength={256} onChange={(event) => setDraft(event.target.value)} placeholder={scope === "project" ? "Search knowledge, symbols, or source" : "Search symbols, signatures, paths, or source"} ref={inputRef} type="search" value={draft} />
              <InputGroupAddon align="inline-end" className={styles.searchInputActions}>
                <InputGroupText className={styles.queryCount}>{draft.length}/256</InputGroupText>
                {draft ? <InputGroupButton aria-label="Clear search" onClick={clear} size="icon-xs" type="button" variant="ghost"><X aria-hidden="true" /></InputGroupButton> : null}
                <InputGroupButton className={styles.primaryButton} disabled={!draft.trim()} size="sm" type="submit" variant="default">Search</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </CardContent>
      </Card>

      {!query ? (
        <Card className={styles.searchWelcome} size="sm">
          <CardContent className={styles.searchWelcomeContent}>
            <Empty className={styles.searchEmpty}>
              <EmptyMedia className={styles.welcomeIcon} variant="icon">
                {scope === "code" ? <Braces aria-hidden="true" /> : <Search aria-hidden="true" />}
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle role="heading" aria-level={2}>
                  {scope === "code" ? "Search symbols and source" : "Search project memory and code"}
                </EmptyTitle>
              </EmptyHeader>
              <EmptyContent className={styles.scopeBadges}>
                {scope === "project" ? <Badge variant="outline">Knowledge</Badge> : null}
                <Badge variant="outline">Code symbols</Badge>
                <Badge variant="outline">Source matches</Badge>
              </EmptyContent>
            </Empty>
          </CardContent>
        </Card>
      ) : search.isPending ? (
        <StatePanel state="loading" title={`Searching for “${query}”`} detail="Available local sources are being queried independently." />
      ) : search.isError ? (
        <ErrorState error={search.error} retry={() => void search.refetch()} />
      ) : (
        <>
          <div className={styles.resultsSummary} aria-live="polite" ref={summaryRef} tabIndex={-1}>
            <span>Results for</span>
            <strong>“{search.data.query}”</strong>
            <Badge variant="outline">{groups.length} sources</Badge>
          </div>
          <div className={`${styles.searchGrid} ${scope === "code" ? styles.codeSearchGrid : ""}`}>
            {groups.map((view) => <ResultGroup key={`${query}-${view.kind}`} onReload={() => void search.refetch()} query={query} view={view} />)}
          </div>
        </>
      )}
    </div>
  );
}

export function SearchPage() {
  const {
    clearSearchFocusRequest,
    searchFocusRequest = 0,
  } = useOutletContext<SearchOutletContext>();
  return (
    <div className={styles.page}>
      <PageHeader title="Search" />
      <SearchWorkbench
        focusRequest={searchFocusRequest}
        onFocusRequestHandled={clearSearchFocusRequest}
        scope="project"
      />
    </div>
  );
}

export function CodePage() {
  const { capabilities } = useOutletContext<SearchOutletContext>();
  const unavailable = capabilities?.graph.read.availability === "unavailable";
  return (
    <div className={styles.page}>
      <PageHeader title="Code" />
      {!capabilities ? (
        <StatePanel state="loading" title="Checking graph availability" detail="Reading the process-local capability boundary before querying the graph." />
      ) : unavailable ? (
        <StatePanel state="unavailable" title="Code graph unavailable" detail={capabilities.graph.read.reason ?? "The code graph is not connected in this build."} />
      ) : <SearchWorkbench scope="code" />}
    </div>
  );
}

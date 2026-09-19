import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowUpRight, Network, X } from "lucide-react";
import { useHubApi } from "../api/context";
import { HubApiError } from "../api/client";
import type { CapabilitiesResponse } from "../api/types";
import { PageHeader, sentenceCase, StatePanel, StatusPill } from "../components/ui";
import { Button, buttonVariants } from "../components/primitives/button";
import { Input } from "../components/primitives/input";
import { ContextGraphCanvas, contextTypeColor } from "../components/ContextGraphCanvas";
import styles from "../styles/context.module.css";

const KnowledgeList = lazy(async () => ({ default: (await import("./KnowledgePage")).KnowledgePage }));
const emptyNodes: never[] = [];

function ReadProblem({ error, retry }: { error: unknown; retry(): void }) {
  const problem = error instanceof HubApiError ? error.problem : null;
  return <StatePanel state="unavailable" title={problem?.code === "INDEX_STALE" ? "The Context index is stale" : "Context unavailable"}
    detail={problem?.detail ?? "The local Hub could not read this context. Retry or inspect index health."}
    action={<><Button onClick={retry} size="sm" variant="outline">Retry</Button> <Link to="/health">Open Health</Link></>} />;
}

export function ContextPage() {
  const [params, setParams] = useSearchParams();
  // Existing saved list filters remain usable when opening an older link.
  const list = params.get("view") === "list" || (!params.has("view") && ["q", "kind", "topic", "lifecycle", "grounding", "sourceType"].some((key) => params.has(key)));
  return <div className={styles.page}>
    <div className={styles.heading}><PageHeader eyebrow="Project knowledge" title="Context" description="Explore what the team knows, how it connects, and the code behind it." />
      <div aria-label="Context view" className={styles.switcher}>
        <Button aria-pressed={!list} onClick={() => setParams({})} size="sm" variant={!list ? "secondary" : "ghost"}>Graph</Button>
        <Button aria-pressed={list} onClick={() => setParams({ view: "list" })} size="sm" variant={list ? "secondary" : "ghost"}>List</Button>
      </div>
    </div>
    {list ? <Suspense fallback={<StatePanel state="loading" title="Loading knowledge list" detail="Reading the knowledge browser." />}><KnowledgeList embedded /></Suspense> : <ContextExplorer />}
  </div>;
}

function ContextExplorer() {
  const api = useHubApi();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const enabled = capabilities?.wiki.read.availability === "available";
  const graph = useQuery({ queryKey: ["wiki-graph"], queryFn: () => api.wikiGraph(), enabled, retry: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [codeId, setCodeId] = useState<string | null>(null);
  const [codeLimit, setCodeLimit] = useState(12);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const revision = graph.data?.indexedRevision;
  useEffect(() => { setSelectedId(null); setCodeId(null); }, [revision]);
  const nodes = graph.data?.nodes ?? emptyNodes;
  const selected = nodes.find((node) => node.id === selectedId);
  const detail = useQuery({ queryKey: ["context-detail", selectedId, revision], queryFn: () => api.getWikiEntity(selectedId!), enabled: enabled && !!selected, retry: false });
  const code = useQuery({ queryKey: ["context-code", selectedId, revision], queryFn: () => api.getWikiGroundedCode(selectedId!), enabled: enabled && !!selected, retry: false });
  const conflict = !!selected && (!!detail.data && (detail.data.indexedRevision !== revision || detail.data.entity.id !== selectedId)
    || !!code.data && (code.data.indexedRevision !== revision || code.data.entityId !== selectedId));
  const record = !conflict && !detail.error ? detail.data : undefined;
  const bridge = !conflict && !code.error ? code.data : undefined;
  const symbols = useMemo(() => [...new Map((bridge?.groundings ?? []).flatMap((item) => item.symbol ? [[item.symbol.id, { symbol: item.symbol, health: item.health }] as const] : [])).values()], [bridge]);
  const codeNodes = useMemo(() => symbols.slice(0, codeLimit).map(({ symbol, health }) => ({ id: symbol.id, title: symbol.name, health })), [symbols, codeLimit]);
  const edges = useMemo(() => (graph.data?.relations ?? []).map((edge) => ({ source: edge.source.id, target: edge.target.id, type: edge.type, note: edge.note })), [graph.data]);
  const kinds = useMemo(() => [...new Set(nodes.map((node) => node.kind))].sort(), [nodes]);
  const highlighted = useMemo(() => query.trim() || kind ? new Set(nodes.filter((node) => (!kind || node.kind === kind) && `${node.title} ${node.summary ?? ""} ${node.location.path}`.toLowerCase().includes(query.trim().toLowerCase())).map((node) => node.id)) : undefined, [nodes, query, kind]);
  const activeCode = symbols.find(({ symbol }) => symbol.id === codeId);
  const relations = (graph.data?.relations ?? []).filter((edge) => edge.source.id === selectedId || edge.target.id === selectedId);
  function select(id: string) { setSelectedId(id); setCodeId(null); setCodeLimit(12); }
  function clear() { setSelectedId(null); setCodeId(null); }
  function reload() { clear(); void graph.refetch(); }

  if (!capabilities) return <StatePanel state="loading" title="Checking Context availability" detail="Connecting to the project Wiki." />;
  if (!enabled) return <StatePanel state="unavailable" title="Context unavailable" detail={capabilities.wiki.read.reason ?? "The Wiki reader is unavailable."} />;
  if (graph.error) return <ReadProblem error={graph.error} retry={reload} />;
  if (!graph.data) return <StatePanel state="loading" title="Loading Context" detail="Reading knowledge and relationships." />;
  if (!nodes.length) return <StatePanel state="empty" title="No knowledge recorded yet" detail="Architecture, conventions, decisions, and other Wiki records will appear here, including records without connections." />;

  return <div className={styles.explorer} onKeyDown={(event) => { if (event.key === "Escape") clear(); }}>
    <div className={styles.toolbar}>
      <label className={styles.search}><span>Find in graph</span><Input aria-label="Find in graph" maxLength={256} onChange={(event) => setQuery(event.target.value)} placeholder="Title, summary, or file…" value={query} /></label>
      <div className={styles.legend} aria-label="Knowledge types">
        <button aria-pressed={kind === null} onClick={() => setKind(null)} type="button">All types</button>
        {kinds.map((type) => <button aria-pressed={kind === type} key={type} onClick={() => setKind(kind === type ? null : type)} type="button"><i style={{ background: contextTypeColor(type) } as CSSProperties} />{sentenceCase(type)}</button>)}
      </div>
      <span className={styles.count} role="status">{highlighted ? `${highlighted.size} matching · ` : ""}{nodes.length} entities · {edges.length} links</span>
    </div>
    {graph.data.coverage.nodesTruncated || graph.data.coverage.relationsTruncated ? <p className={styles.notice} role="status">Partial graph: up to 100 entities and 500 relationships are shown. Use List to browse more knowledge.</p> : null}
    <div className={styles.workbench}>
      <ContextGraphCanvas nodes={nodes} edges={edges} selectedId={selectedId} selectedCodeId={codeId} codeNodes={codeNodes} highlightedIds={highlighted} onSelect={select} onSelectCode={setCodeId} onClear={clear} />
      <aside aria-label="Context details" className={styles.details}>
        {!selected ? <div className={styles.welcome}><Network size={24} strokeWidth={1} /><h2>Follow a connection</h2><p>Select a knowledge node to see its details and reveal the code it’s grounded in.</p><p>Colors identify record types. Lines show recorded relationships; nearby positions are a visual grouping.</p></div> : <>
          <div className={styles.detailTop}><span>{activeCode ? "Grounded code" : sentenceCase(selected.kind)}</span><Button aria-label="Close details" onClick={clear} size="icon" variant="ghost"><X size={16} /></Button></div>
          {conflict ? <StatePanel state="unavailable" title="Context changed" detail="The selected record and graph belong to different revisions. Reload to view a consistent graph." action={<Button onClick={reload} size="sm" variant="outline">Reload graph</Button>} /> : activeCode ? <>
            <h2>{activeCode.symbol.name}</h2><StatusPill tone="neutral">{activeCode.symbol.symbolKind}</StatusPill>
            <p className={styles.path}>{activeCode.symbol.path}:{activeCode.symbol.startLine}–{activeCode.symbol.endLine}</p>
            {activeCode.symbol.signature && <pre className={styles.signature}>{activeCode.symbol.signature}</pre>}
            <p>Grounding: {activeCode.health}. This describes the code reference, not the accuracy of the knowledge.</p>
            <Link className={buttonVariants({ size: "sm", variant: "outline" })} to={activeCode.symbol.route}>Open in Code <ArrowUpRight size={13} /></Link>
            <Button onClick={() => setCodeId(null)} size="sm" variant="ghost">Back to {selected.title}</Button>
          </> : <>
            <h2>{selected.title}</h2><div className={styles.badges}><StatusPill tone="neutral">{sentenceCase(selected.lifecycleState)}</StatusPill></div>
            {selected.summary && <p>{selected.summary}</p>}
            <p className={styles.path}>{selected.location.path}:{selected.location.startLine}</p>
            <Link className={buttonVariants({ size: "sm", variant: "outline" })} to={selected.route}>Open full record <ArrowUpRight size={13} /></Link>
            {detail.error ? <ReadProblem error={detail.error} retry={() => { void detail.refetch(); }} /> : record ? <>
              <section><h3>Knowledge</h3><pre className={styles.body}>{record.body.content.slice(0, 6_144) || "No body recorded."}</pre>{record.body.truncated || record.body.content.length > 6_144 ? <p>Preview only. Open the full record to read more.</p> : null}</section>
              <section><h3>Origin & evidence</h3><p>{record.provenance ? `${record.provenance.kind}${record.provenance.id ? ` · ${record.provenance.id}` : ""}${record.provenance.capturedAt ? ` · ${record.provenance.capturedAt}` : ""}` : "No provenance recorded."}</p>{record.sources.items.length ? record.sources.items.slice(0, 5).map((source, i) => <p className={styles.path} key={i}>{source.type} · {source.ref}</p>) : <p>No sources recorded.</p>}{record.sources.truncated || record.sources.items.length > 5 ? <p>More evidence is available in the full record.</p> : null}</section>
            </> : <p role="status">Loading record…</p>}
            <section><h3>Connected code <span>{symbols.length || ""}</span></h3>{code.error ? <ReadProblem error={code.error} retry={() => { void code.refetch(); }} /> : !bridge ? <p role="status">Resolving code connections…</p> : <>
              {!bridge.groundings.length && <p>No explicit code grounding recorded.</p>}
              {bridge.groundings.length > 0 && bridge.graphRevision === null && <p>Code index unavailable. Groundings are unverified.</p>}
              {symbols.slice(0, codeLimit).map(({ symbol, health }) => <button className={styles.recordLink} key={symbol.id} onClick={() => setCodeId(symbol.id)} type="button">{symbol.name}<small>{health} · {symbol.path}</small></button>)}
              {bridge.groundings.filter((item) => !item.symbol).map((item, i) => <p className={styles.path} key={i}>{item.requestedNode} · {item.health} · code unavailable</p>)}
              {symbols.length > codeLimit && <Button onClick={() => setCodeLimit(50)} size="sm" variant="ghost">Show all {symbols.length} code nodes</Button>}
              {bridge.truncated && <p>Only the first 50 grounding references are shown.</p>}
            </>}</section>
            <section><h3>Relationships <span>{relations.length}</span></h3>{relations.length ? relations.map((edge, i) => {
              const outgoing = edge.source.id === selectedId, other = outgoing ? edge.target : edge.source;
              return <button className={styles.recordLink} key={i} onClick={() => select(other.id)} type="button">{other.title}<small>{outgoing ? "Outgoing" : "Incoming"} · {sentenceCase(edge.type)}{edge.note ? ` · ${edge.note}` : ""}</small></button>;
            }) : <p>No relationships in this graph.</p>}</section>
          </>}
        </>}
      </aside>
    </div>
  </div>;
}

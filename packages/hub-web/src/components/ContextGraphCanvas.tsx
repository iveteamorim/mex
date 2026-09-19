import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { CONTEXT_EDGE_LIMIT, CONTEXT_NODE_LIMIT, contextCurve, layoutCodeSatellites, layoutContextGraph, type ContextEdge, type ContextNode } from "../lib/context-graph";
import styles from "../styles/context-graph.module.css";

export interface ContextCodeNode { id: string; title: string; health: string }
interface Props {
  nodes: readonly ContextNode[];
  edges: readonly ContextEdge[];
  selectedId: string | null;
  selectedCodeId: string | null;
  codeNodes: readonly ContextCodeNode[];
  highlightedIds?: ReadonlySet<string>;
  onSelect(id: string): void;
  onSelectCode(id: string): void;
  onClear(): void;
}

const kinds = ["architecture", "component", "decision", "convention", "pattern", "guide", "risk", "fact", "task", "topic", "spec", "requirement", "constraint", "acceptance_criterion"];
export function contextTypeColor(kind: string): string { return `var(--context-type-${Math.max(0, kinds.indexOf(kind)) % 6})`; }

export function ContextGraphCanvas({ nodes, edges, selectedId, selectedCodeId, codeNodes, highlightedIds, onSelect, onSelectCode, onClear }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 760, height: 620 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const boundedNodes = useMemo(() => nodes.slice(0, CONTEXT_NODE_LIMIT), [nodes]);
  const world = useMemo(() => ({ width: Math.max(size.width, Math.ceil(Math.sqrt(boundedNodes.length * 22000))), height: Math.max(size.height, Math.ceil(boundedNodes.length / 5) * 110 + 60) }), [size, boundedNodes.length]);
  const layout = useMemo(() => layoutContextGraph(boundedNodes, edges, world.width, world.height), [boundedNodes, edges, world]);
  const satellites = useMemo(() => layoutCodeSatellites(codeNodes.map((node) => node.id), selectedId ? layout.get(selectedId) : undefined, layout, world.width, world.height), [codeNodes, selectedId, layout, world]);
  const worldHeight = Math.max(world.height, ...[...satellites.values()].map((point) => point.y + 55));
  const links = useMemo(() => edges.slice(0, CONTEXT_EDGE_LIMIT).filter((edge) => layout.has(edge.source) && layout.has(edge.target)), [edges, layout]);
  const neighbors = new Set(links.filter((edge) => edge.source === selectedId || edge.target === selectedId).flatMap((edge) => [edge.source, edge.target]));

  function fit() {
    const scale = Math.min(1, size.width / world.width, size.height / worldHeight);
    setView({ x: (size.width - world.width * scale) / 2, y: (size.height - worldHeight * scale) / 2, scale });
  }
  function zoom(factor: number) {
    setView((current) => {
      const floor = Math.min(.35, size.width / world.width, size.height / worldHeight);
      const scale = Math.max(floor, Math.min(2.5, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: size.width / 2 - (size.width / 2 - current.x) * ratio, y: size.height / 2 - (size.height / 2 - current.y) * ratio };
    });
  }
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const scale = Math.min(1, size.width / world.width, size.height / world.height);
    setView({ x: (size.width - world.width * scale) / 2, y: (size.height - world.height * scale) / 2, scale });
  }, [size, world]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); zoom(event.deltaY > 0 ? .9 : 1.1);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [size, world.width, worldHeight]);

  return <div aria-label="Context graph" className={styles.canvas} ref={root} onKeyDown={(event) => { if (event.key === "Escape") { onClear(); event.stopPropagation(); } }}
    onPointerDown={(event) => {
      if (event.button !== 0 || (event.target as Element).closest("button,a")) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, startX: view.x, startY: view.y, moved: false };
    }}
    onPointerMove={(event) => {
      if (!drag.current) return;
      const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
      const { startX, startY } = drag.current;
      setView((current) => ({ ...current, x: startX + dx, y: startY + dy }));
    }}
    onPointerUp={() => { if (drag.current && !drag.current.moved) onClear(); drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}>
    <div className={styles.world} style={{ width: world.width, height: worldHeight, "--view-x": `${view.x}px`, "--view-y": `${view.y}px`, "--view-scale": view.scale } as CSSProperties}>
      <svg aria-hidden="true" className={styles.edges} width={world.width} height={worldHeight}>
        <defs><marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="currentColor" /></marker></defs>
        {links.map((edge, index) => <path key={`${edge.source}-${edge.target}-${edge.type}-${index}`} d={contextCurve(layout.get(edge.source)!, layout.get(edge.target)!, index % 2 ? 16 : -16)} className={edge.source === selectedId || edge.target === selectedId ? styles.activeEdge : styles.edge} markerEnd={edge.type === "related_to" ? undefined : `url(#${id}-arrow)`} />)}
        {selectedId && layout.has(selectedId) ? [...satellites].map(([key, point]) => <path className={styles.groundingEdge} d={contextCurve(layout.get(selectedId)!, point)} key={key} />) : null}
      </svg>
      {boundedNodes.map((node) => {
        const point = layout.get(node.id)!;
        const style = { left: point.x, top: point.y, "--node-color": contextTypeColor(node.kind) } as CSSProperties;
        return <button aria-label={`${node.title} · ${node.kind}`} aria-pressed={selectedId === node.id} className={styles.node} data-dimmed={highlightedIds && !highlightedIds.has(node.id) ? "true" : undefined} data-neighbor={neighbors.has(node.id) ? "true" : undefined} key={node.id} onClick={() => onSelect(node.id)} style={style} title={node.title} type="button"><span aria-hidden="true" className={styles.orb} /><span className={styles.nodeLabel}>{node.title.replace(/[-_]/g, " ")}</span></button>;
      })}
      {codeNodes.filter((node) => satellites.has(node.id)).map((node) => {
        const point = satellites.get(node.id)!;
        const parent = selectedId ? layout.get(selectedId) : undefined;
        return <button aria-label={`${node.title} · code · ${node.health}`} aria-pressed={selectedCodeId === node.id} className={styles.codeNode} key={`${selectedId}-${node.id}`} onClick={() => onSelectCode(node.id)} style={{ left: point.x, top: point.y, "--from-x": `${(parent?.x ?? point.x) - point.x}px`, "--from-y": `${(parent?.y ?? point.y) - point.y}px` } as CSSProperties} title={node.title} type="button"><span aria-hidden="true" className={styles.codeOrb}>{"{ }"}</span><span className={styles.nodeLabel}>{node.title}</span></button>;
      })}
    </div>
    <div aria-label="Graph view controls" className={styles.controls}>
      <button aria-label="Zoom out" onClick={() => zoom(.8)} title="Zoom out" type="button"><Minus size={14} /></button>
      <button aria-label="Fit graph" onClick={fit} title="Fit graph" type="button"><Maximize2 size={14} /></button>
      <button aria-label="Zoom in" onClick={() => zoom(1.25)} title="Zoom in" type="button"><Plus size={14} /></button>
    </div>
    <p className={styles.hint}>Drag to pan · Ctrl / ⌘ scroll to zoom{codeNodes.length ? " · Fit graph to see every code node" : ""}</p>
  </div>;
}

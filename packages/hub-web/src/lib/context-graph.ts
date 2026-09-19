export interface ContextNode { id: string; title: string; kind: string }
export interface ContextEdge { source: string; target: string; type: string; note?: string | null }
export interface GraphPoint { x: number; y: number }
export const CONTEXT_NODE_LIMIT = 100;
export const CONTEXT_EDGE_LIMIT = 500;

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

/** A finite layout pass. Index order and selection never change the base positions. */
export function layoutContextGraph(nodes: readonly ContextNode[], edges: readonly ContextEdge[], width: number, height: number): Map<string, GraphPoint> {
  const entries = [...nodes.slice(0, CONTEXT_NODE_LIMIT)].sort((a, b) => a.id.localeCompare(b.id));
  const kinds = [...new Set(entries.map((node) => node.kind))].sort();
  const points = entries.map((node, index) => {
    const angle = kinds.indexOf(node.kind) * Math.PI * 2 / Math.max(kinds.length, 1) - Math.PI / 2;
    const spread = (hash(node.id) % 1000) / 1000;
    return {
      id: node.id,
      x: width / 2 + Math.cos(angle) * width * .22 + Math.cos(index * 2.39996) * (40 + spread * width * .15),
      y: height / 2 + Math.sin(angle) * height * .22 + Math.sin(index * 2.39996) * (40 + spread * height * .15),
    };
  });
  const byId = new Map(points.map((point) => [point.id, point]));
  const links = edges.slice(0, CONTEXT_EDGE_LIMIT).sort((a, b) => `${a.source}:${a.target}:${a.type}`.localeCompare(`${b.source}:${b.target}:${b.type}`)).flatMap((edge) => {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    return a && b && a !== b ? [[a, b] as const] : [];
  });
  for (let pass = 0; pass < 220; pass++) {
    if (pass < 100) for (const [a, b] of links) {
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.hypot(dx, dy) > 175) {
        a.x += dx * .003; a.y += dy * .003;
        b.x -= dx * .003; b.y -= dy * .003;
      }
    }
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!, b = points[j]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const overlapX = 124 - Math.abs(dx), overlapY = 72 - Math.abs(dy);
      if (overlapX > 0 && overlapY > 0) {
        if (overlapX / 124 < overlapY / 72) {
          const push = overlapX * .51 * (dx >= 0 ? 1 : -1);
          a.x -= push; b.x += push;
        } else {
          const push = overlapY * .51 * (dy >= 0 ? 1 : -1);
          a.y -= push; b.y += push;
        }
      }
    }
    for (const point of points) {
      point.x = Math.max(66, Math.min(width - 66, point.x));
      point.y = Math.max(36, Math.min(height - 45, point.y));
    }
  }
  return new Map(points.map(({ id, x, y }) => [id, { x, y }]));
}

/** Satellites occupy free space; the underlying knowledge layout stays fixed. */
export function layoutCodeSatellites(ids: readonly string[], parent: GraphPoint | undefined, base: ReadonlyMap<string, GraphPoint>, width: number, height: number): Map<string, GraphPoint> {
  if (!parent) return new Map();
  const occupied = [...base.values()].map((point) => ({ ...point, width: 116, height: 64 }));
  const result = new Map<string, GraphPoint>();
  for (const [index, id] of [...new Set(ids)].slice(0, 50).entries()) {
    let chosen: GraphPoint | undefined;
    for (let radius = 90; radius <= Math.max(width, height) && !chosen; radius += 18) {
      for (let step = 0; step < 32; step++) {
        const angle = step * Math.PI / 16 + index * .15;
        const point = { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
        if (point.x < 78 || point.x > width - 78 || point.y < 40 || point.y > height - 50) continue;
        if (!occupied.some((other) => Math.abs(point.x - other.x) < (148 + other.width) / 2 + 5 && Math.abs(point.y - other.y) < (72 + other.height) / 2 + 5)) {
          chosen = point; break;
        }
      }
    }
    chosen ??= { x: 90 + (index % Math.max(1, Math.floor(width / 180))) * 180, y: height + 55 + Math.floor(index / Math.max(1, Math.floor(width / 180))) * 90 };
    result.set(id, chosen);
    occupied.push({ ...chosen, width: 148, height: 72 });
  }
  return result;
}

export function contextCurve(a: GraphPoint, b: GraphPoint, bend = 16): string {
  return `M ${a.x} ${a.y - 15} Q ${(a.x + b.x) / 2 + bend} ${(a.y + b.y) / 2 - 15 - bend} ${b.x} ${b.y - 15}`;
}

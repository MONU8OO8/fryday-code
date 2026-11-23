/**
 * Where each node of the service graph goes. Layers: apps that nobody calls on top, then what
 * they call, outside services last. Within a layer, nodes are ordered to cross as few lines as
 * a few sweeps can manage: down (by the average place of their callers), then up (by the
 * average place of what they call), keeping the order with the fewest crossings.
 */

export interface LayoutNode { id: string; kind: string; label: string }
export interface LayoutLink { from: string; to: string }

export const NODE_W = 168;
export const NODE_H = 44;
const GAP_X = 36;
const GAP_Y = 96;
const PAD = 24;
const SWEEPS = 6;
/** A layer with more nodes than this is wrapped onto more rows: a row of thirty services cannot be read. */
const MAX_PER_ROW = 7;

function crossings(rows: LayoutNode[][], links: LayoutLink[]): number {
  const at = new Map<string, { r: number; i: number }>();
  rows.forEach((row, r) => row.forEach((n, i) => at.set(n.id, { r, i })));
  let total = 0;
  for (let r = 0; r < rows.length - 1; r++) {
    const between = links.map((l) => [at.get(l.from), at.get(l.to)] as const)
      .filter(([a, b]) => a && b && ((a.r === r && b.r === r + 1) || (a.r === r + 1 && b.r === r)))
      .map(([a, b]) => (a!.r === r ? [a!.i, b!.i] : [b!.i, a!.i]));
    for (let i = 0; i < between.length; i++) {
      for (let j = i + 1; j < between.length; j++) {
        const [a1, b1] = between[i]!;
        const [a2, b2] = between[j]!;
        if ((a1! - a2!) * (b1! - b2!) < 0) total++;
      }
    }
  }
  return total;
}

function sweep(rows: LayoutNode[][], links: LayoutLink[], down: boolean): LayoutNode[][] {
  const next = rows.map((r) => [...r]);
  const order = down ? next.map((_, i) => i).slice(1) : next.map((_, i) => i).slice(0, -1).reverse();
  for (const r of order) {
    const ref = new Map((next[down ? r - 1 : r + 1] ?? []).map((n, i) => [n.id, i]));
    const centre = (id: string) => {
      const ends = links.flatMap((l) => (l.to === id && ref.has(l.from) ? [ref.get(l.from)!] : l.from === id && ref.has(l.to) ? [ref.get(l.to)!] : []));
      return ends.length ? ends.reduce((a, b) => a + b, 0) / ends.length : null;
    };
    const current = new Map(next[r]!.map((n, i) => [n.id, i]));
    next[r]!.sort((a, b) => (centre(a.id) ?? current.get(a.id)!) - (centre(b.id) ?? current.get(b.id)!) || a.label.localeCompare(b.label));
  }
  return next;
}

export function layout<N extends LayoutNode, L extends LayoutLink>(nodes: N[], links: L[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const live = links.filter((l) => ids.has(l.from) && ids.has(l.to));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layer = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Longest path from a caller, bounded so a cycle cannot loop forever.
  for (let i = 0; i < nodes.length; i++) {
    let moved = false;
    for (const l of live) {
      if (byId.get(l.from)!.kind !== 'project') continue;
      const want = layer.get(l.from)! + 1;
      if (want > layer.get(l.to)! && want < nodes.length) { layer.set(l.to, want); moved = true; }
    }
    if (!moved) break;
  }
  const projectDepth = Math.max(0, ...nodes.filter((n) => n.kind === 'project').map((n) => layer.get(n.id)!));
  for (const n of nodes) if (n.kind === 'external_service') layer.set(n.id, projectDepth + 1);
  const rows: N[][] = [];
  for (const n of nodes) (rows[layer.get(n.id)!] ??= []).push(n);
  let best = rows.filter(Boolean).map((r) => r.sort((a, b) => a.label.localeCompare(b.label)));
  let bestCount = crossings(best, live);
  let cur = best;
  for (let i = 0; i < SWEEPS && bestCount > 0; i++) {
    cur = sweep(cur, live, i % 2 === 0) as N[][];
    const c = crossings(cur, live);
    if (c < bestCount) { best = cur; bestCount = c; }
  }
  best = best.flatMap((row) => {
    if (row.length <= MAX_PER_ROW) return [row];
    const parts = Math.ceil(row.length / MAX_PER_ROW);
    const size = Math.ceil(row.length / parts);
    return Array.from({ length: parts }, (_, i) => row.slice(i * size, (i + 1) * size));
  });
  const widest = Math.max(1, ...best.map((r) => r.length));
  const width = Math.max(640, PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X);
  const pos = new Map<string, { x: number; y: number }>();
  best.forEach((row, r) => {
    const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X;
    const left = (width - rowWidth) / 2;
    row.forEach((n, i) => pos.set(n.id, { x: left + i * (NODE_W + GAP_X), y: PAD + r * (NODE_H + GAP_Y) }));
  });
  return { pos, width, height: PAD * 2 + best.length * NODE_H + Math.max(0, best.length - 1) * GAP_Y, links: live, crossings: bestCount };
}

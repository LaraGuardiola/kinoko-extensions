// Layered layout (Sugiyama, small): cycles broken, nodes ranked by longest path, edges that skip
// ranks given waypoints, each rank ordered by the barycentre of its neighbours (members of a group
// kept together), then placed as near their neighbours as the gaps allow. Works in rank/order
// space; the direction only decides which of x and y is which at the end.

import type { Graph } from "./model.ts";

export interface Size {
  w: number;
  h: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  /** Cells between ranks (rows going down, columns going across). */
  rankGap: number;
  /** Cells between neighbours in a rank. */
  orderGap: number;
}

const DUMMY = "\u0000";

export function layout(graph: Graph, sizes: Map<string, Size>, opts: LayoutOptions): Map<string, Box> {
  const across = graph.dir === "LR" || graph.dir === "RL";
  const ids = [...graph.nodes.keys()];
  const pairs = dag(ids, graph.edges.filter((e) => e.from !== e.to).map((e) => [e.from, e.to] as [string, string]));
  const rank = ranks(ids, pairs);

  // Edges that skip ranks get a chain of waypoints, one per rank, so the ordering leaves lanes.
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    succs.set(a, [...(succs.get(a) ?? []), b]);
    preds.set(b, [...(preds.get(b) ?? []), a]);
  };
  let dummies = 0;
  for (const [a, b] of pairs) {
    let prev = a;
    for (let r = (rank.get(a) ?? 0) + 1; r < (rank.get(b) ?? 0); r++) {
      const d = `${DUMMY}${dummies++}`;
      rank.set(d, r);
      link(prev, d);
      prev = d;
    }
    link(prev, b);
  }

  const layers: string[][] = [];
  for (const [id, r] of rank) (layers[r] ??= []).push(id);
  const groupOf = new Map<string, number>();
  for (const [i, g] of graph.groups.entries()) {
    for (const id of g.ids) {
      const known = groupOf.get(id);
      if (known === undefined || (graph.groups[known]?.ids.length ?? 0) > g.ids.length) groupOf.set(id, i);
    }
  }
  order(layers, preds, succs, groupOf);

  const size = (id: string): Size => sizes.get(id) ?? { w: 1, h: 1 };
  const cross = (id: string): number => (across ? size(id).h : size(id).w);
  const main = (id: string): number => (across ? size(id).w : size(id).h);
  const gap = (a: string, b: string): number => (a.startsWith(DUMMY) || b.startsWith(DUMMY) ? 2 : groupOf.get(a) === groupOf.get(b) ? opts.orderGap : opts.orderGap + 2);

  // Order coordinates: packed, then pulled towards the neighbours, down and up a few times.
  const pos = new Map<string, number>();
  for (const layer of layers) {
    let at = 0;
    for (const [i, id] of layer.entries()) {
      pos.set(id, at);
      at += cross(id) + gap(id, layer[i + 1] ?? id);
    }
  }
  const center = (id: string): number => (pos.get(id) ?? 0) + cross(id) / 2;
  for (let pass = 0; pass < 6; pass++) {
    const down = pass % 2 === 0;
    const sweep = down ? layers : layers.toReversed();
    for (const layer of sweep) {
      const desired = layer.map((id) => {
        const near = (down ? preds : succs).get(id) ?? [];
        return near.length === 0 ? center(id) : near.reduce((sum, n) => sum + center(n), 0) / near.length;
      });
      const placed = place(desired.map((d, i) => Math.floor(d - cross(layer[i] ?? "") / 2)), layer.map(cross), layer.map((id, i) => (i === 0 ? 0 : gap(layer[i - 1] ?? "", id))));
      for (const [i, id] of layer.entries()) pos.set(id, placed[i] ?? 0);
    }
  }
  const least = Math.min(...pos.values());

  // Rank coordinates: each rank as thick as its thickest node, nodes centred in it.
  const start: number[] = [];
  let at = 0;
  for (const [r, layer] of layers.entries()) {
    start[r] = at;
    at += Math.max(1, ...layer.filter((id) => !id.startsWith(DUMMY)).map(main)) + opts.rankGap;
  }
  const total = at - opts.rankGap;

  const boxes = new Map<string, Box>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    const thick = Math.max(1, ...(layers[r] ?? []).filter((n) => !n.startsWith(DUMMY)).map(main));
    let m = (start[r] ?? 0) + Math.floor((thick - main(id)) / 2);
    if (graph.dir === "BT" || graph.dir === "RL") m = total - m - main(id);
    const o = (pos.get(id) ?? 0) - least;
    const { w, h } = size(id);
    boxes.set(id, across ? { x: m, y: o, w, h } : { x: o, y: m, w, h });
  }
  return boxes;
}

/** The edges with the ones that close a cycle turned around (found by depth-first search). */
function dag(ids: string[], edges: Array<[string, string]>): Array<[string, string]> {
  const out = new Map<string, string[]>();
  for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b]);
  const state = new Map<string, 1 | 2>(); // 1 on the stack, 2 done
  const back = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 1) back.add(`${id}\n${next}`);
      else if (state.get(next) === undefined) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (state.get(id) === undefined) visit(id);
  const seen = new Set<string>();
  return edges
    .map(([a, b]): [string, string] => (back.has(`${a}\n${b}`) ? [b, a] : [a, b]))
    .filter(([a, b]) => {
      const key = `${a}\n${b}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Longest path from the sources; a source then moves down to just above its first successor. */
function ranks(ids: string[], edges: Array<[string, string]>): Map<string, number> {
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const [, b] of edges) indegree.set(b, (indegree.get(b) ?? 0) + 1);
  const queue = ids.filter((id) => indegree.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] ?? "";
    for (const [a, b] of edges) {
      if (a !== id) continue;
      rank.set(b, Math.max(rank.get(b) ?? 0, (rank.get(a) ?? 0) + 1));
      indegree.set(b, (indegree.get(b) ?? 0) - 1);
      if (indegree.get(b) === 0) queue.push(b);
    }
  }
  for (const id of ids) {
    if (edges.some(([, b]) => b === id)) continue;
    const below = edges.filter(([a]) => a === id).map(([, b]) => rank.get(b) ?? 0);
    if (below.length > 0) rank.set(id, Math.min(...below) - 1);
  }
  return rank;
}

/** Barycentre ordering, a few sweeps; the members of a group stay side by side. */
function order(layers: string[][], preds: Map<string, string[]>, succs: Map<string, string[]>, groupOf: Map<string, number>): void {
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? layers.keys() : [...layers.keys()].toReversed();
    for (const r of range) {
      const near = layers[r + (down ? -1 : 1)];
      const layer = layers[r];
      if (near === undefined || layer === undefined) continue;
      const index = new Map(near.map((id, i) => [id, i]));
      const bary = new Map(
        layer.map((id, i) => {
          const ns = ((down ? preds : succs).get(id) ?? []).map((n) => index.get(n)).filter((n) => n !== undefined);
          return [id, ns.length === 0 ? i : ns.reduce((s, n) => s + n, 0) / ns.length];
        }),
      );
      const sorted = layer.toSorted((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0));
      const out: string[] = [];
      for (const id of sorted) {
        if (out.includes(id)) continue;
        const g = groupOf.get(id);
        out.push(...(g === undefined ? [id] : sorted.filter((n) => groupOf.get(n) === g)));
      }
      layers[r] = out;
    }
  }
}

/** Starts as near `want` as the sizes and gaps allow: the mean of the push-right and push-left
 *  placements, both of which keep every gap. */
function place(want: number[], size: number[], gap: number[]): number[] {
  const n = want.length;
  const right: number[] = [];
  const left: number[] = [];
  for (let i = 0; i < n; i++) right[i] = i === 0 ? (want[i] ?? 0) : Math.max(want[i] ?? 0, (right[i - 1] ?? 0) + (size[i - 1] ?? 0) + (gap[i] ?? 0));
  for (let i = n - 1; i >= 0; i--) left[i] = i === n - 1 ? (want[i] ?? 0) : Math.min(want[i] ?? 0, (left[i + 1] ?? 0) - (gap[i + 1] ?? 0) - (size[i] ?? 0));
  return right.map((r, i) => Math.floor((r + (left[i] ?? 0)) / 2));
}

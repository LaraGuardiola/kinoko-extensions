// Edge routing: A* over the character grid, around the boxes. A step costs 1, a turn more, running
// along another edge's line much more (crossing it a little): lines stay apart and straight.
// Edges from the same node may share their first stretch, which draws as a tidy fork.

import type { Box } from "./layout.ts";

export type Side = "top" | "right" | "bottom" | "left";

/** Steps: right, down, left, up. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const INTO: Record<Side, number> = { top: 1, right: 2, bottom: 3, left: 0 }; // the step that enters the box from that side

export interface Route {
  /** Cells from just outside the source to just outside the target. */
  cells: Array<[number, number]>;
  /** The side of the target the path enters: the arrowhead points through it. */
  end: Side;
  /** The side of the source it leaves from. */
  start: Side;
}

export interface Grid {
  width: number;
  height: number;
  /** Cell → what is there: a box (impassable), or lines and who drew them. */
  boxes: Box[];
  /** Horizontal / vertical line use per cell: the source node of the edge that drew it. */
  horizontal: Map<number, string>;
  vertical: Map<number, string>;
  /** Cells holding an arrowhead, by the node it points at. */
  heads: Map<number, string>;
  /** Cells costly to cross (group frames). */
  soft: Set<number>;
}

const key = (x: number, y: number): number => y * 100_000 + x;
const state = (x: number, y: number, d: number): number => key(x, y) * 4 + d;

function inside(b: Box, x: number, y: number): boolean {
  return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
}

/** Which side of `b` the step from (x, y) in direction `d` goes through, or undefined (a corner,
 *  or not into `b`). */
function entry(b: Box, x: number, y: number, d: number): Side | undefined {
  const nx = x + (DX[d] ?? 0);
  const ny = y + (DY[d] ?? 0);
  if (!inside(b, nx, ny)) return undefined;
  const corner = (nx === b.x || nx === b.x + b.w - 1) && (ny === b.y || ny === b.y + b.h - 1);
  if (corner && b.w > 1 && b.h > 1) return undefined;
  if (d === 1) return "top";
  if (d === 3) return "bottom";
  return d === 0 ? "left" : "right";
}

/** A tiny binary heap of [cost, state]. */
class Heap {
  #items: Array<[number, number]> = [];
  get size(): number {
    return this.#items.length;
  }
  push(item: [number, number]): void {
    const a = this.#items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if ((a[p]?.[0] ?? 0) <= item[0]) break;
      [a[i], a[p]] = [a[p] as [number, number], a[i] as [number, number]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.#items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if ((a[l]?.[0] ?? Infinity) < (a[m]?.[0] ?? Infinity)) m = l;
        if ((a[r]?.[0] ?? Infinity) < (a[m]?.[0] ?? Infinity)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as [number, number], a[i] as [number, number]];
        i = m;
      }
    }
    return top;
  }
}

/** Finds a path from `from`'s box to `to`'s box; `prefer` names the sides the flow favours
 *  (leaving, entering). Undefined when it is walled in. */
export function route(grid: Grid, from: { id: string; box: Box }, to: { id: string; box: Box }, prefer: [Side, Side], self = false): Route | undefined {
  const { width, height } = grid;
  const walls = new Set<number>();
  for (const box of grid.boxes) for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) walls.add(key(x, y));
  const blocked = (x: number, y: number): boolean => x < 0 || y < 0 || x >= width || y >= height || walls.has(key(x, y));
  const cost = new Map<number, number>();
  const parent = new Map<number, number>();
  const heap = new Heap();
  const target = to.box;
  const tx = target.x + target.w / 2;
  const ty = target.y + target.h / 2;
  const guess = (x: number, y: number): number => Math.max(0, Math.abs(x - tx) - target.w / 2) + Math.max(0, Math.abs(y - ty) - target.h / 2);

  // Starts: every cell along the source's sides, the preferred side and its middle cheapest.
  const b = from.box;
  const starts: Array<[number, number, number, Side]> = [];
  // Never from a corner: the line would leave from nowhere (a 1×1 node has only its one cell).
  const inset = b.w > 1 && b.h > 1 ? 1 : 0;
  for (let x = b.x + inset; x < b.x + b.w - inset; x++) starts.push([x, b.y - 1, 3, "top"], [x, b.y + b.h, 1, "bottom"]);
  for (let y = b.y + inset; y < b.y + b.h - inset; y++) starts.push([b.x - 1, y, 2, "left"], [b.x + b.w, y, 0, "right"]);
  const startSide = new Map<number, Side>();
  for (const [x, y, d, side] of starts) {
    if (blocked(x, y) || grid.heads.has(key(x, y))) continue;
    if (self && side !== "right") continue;
    const mid = side === "top" || side === "bottom" ? Math.abs(x - (b.x + (b.w - 1) / 2)) : Math.abs(y - (b.y + (b.h - 1) / 2));
    const c = (side === prefer[0] ? 0 : 6) + mid * 0.5;
    const s = state(x, y, d);
    if (c < (cost.get(s) ?? Infinity)) {
      cost.set(s, c);
      startSide.set(s, side);
      heap.push([c + guess(x, y), s]);
    }
  }

  let best: { s: number; side: Side; cost: number } | undefined;
  let steps = 0;
  while (heap.size > 0 && steps++ < 60_000) {
    const [f, s] = heap.pop() ?? [0, 0];
    if (best !== undefined && f >= best.cost) break;
    const g = cost.get(s) ?? Infinity;
    const d = s % 4;
    const cell = Math.floor(s / 4);
    const x = cell % 100_000;
    const y = Math.floor(cell / 100_000);
    // Ending: a step from here into the target, through a side (never a corner).
    const head = grid.heads.get(cell);
    if (head === undefined || head === to.id) {
      for (let nd = 0; nd < 4; nd++) {
        const side = entry(target, x, y, nd);
        if (side === undefined || (self && (side !== "top" || g < 2))) continue;
        const total = g + 1 + (nd === d ? 0 : 3) + (side === prefer[1] ? 0 : 6);
        if (best === undefined || total < best.cost) best = { s, side, cost: total };
      }
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue; // no turning back
      const nx = x + (DX[nd] ?? 0);
      const ny = y + (DY[nd] ?? 0);
      if (blocked(nx, ny)) continue;
      const k = key(nx, ny);
      const other = grid.heads.get(k);
      if (other !== undefined && other !== to.id) continue;
      const along = nd % 2 === 0 ? grid.horizontal.get(k) : grid.vertical.get(k);
      const across = nd % 2 === 0 ? grid.vertical.get(k) : grid.horizontal.get(k);
      let step = 1 + (nd === d ? 0 : 3);
      if (along !== undefined) step += along === from.id ? 0 : 40;
      if (across !== undefined && across !== from.id) step += nd === d ? 4 : 40; // crossing, or turning onto it
      if (grid.soft.has(k)) step += 3;
      const ns = state(nx, ny, nd);
      if (g + step < (cost.get(ns) ?? Infinity)) {
        cost.set(ns, g + step);
        parent.set(ns, s);
        heap.push([g + step + guess(nx, ny), ns]);
      }
    }
  }
  if (best === undefined) return undefined;
  const cells: Array<[number, number]> = [];
  let s: number | undefined = best.s;
  let first = best.s;
  while (s !== undefined) {
    const cell = Math.floor(s / 4);
    cells.push([cell % 100_000, Math.floor(cell / 100_000)]);
    first = s;
    s = parent.get(s);
  }
  return { cells: cells.toReversed(), end: best.side, start: startSide.get(first) ?? prefer[0] };
}

/** The step direction (0 right, 1 down, 2 left, 3 up) that goes through `side` into a box. */
export function into(side: Side): number {
  return INTO[side];
}

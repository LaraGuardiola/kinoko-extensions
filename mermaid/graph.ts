// Draws a flowchart or state diagram: boxes in their shapes, groups as dotted frames, edges routed
// around the boxes with arrowheads, labels on the lines or beside them. When the drawing is too
// wide it tries again narrower (left-right turns top-down, labels wrap tighter); when nothing
// fits, the edges come as a list, which reads fine on a phone.

import { Canvas, DOWN, INK, LEFT, RIGHT, UP, textWidth } from "./canvas.ts";
import { layout } from "./layout.ts";
import type { Box, Size } from "./layout.ts";
import { wrapLabel } from "./model.ts";
import type { Direction, Edge, Graph, Node } from "./model.ts";
import { into, route } from "./route.ts";
import type { Grid, Route, Side } from "./route.ts";

const DIRS = [RIGHT, DOWN, LEFT, UP];
const BACK = [LEFT, UP, RIGHT, DOWN];
const HEADS = ["▶", "▼", "◀", "▲"];
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const key = (x: number, y: number): number => y * 100_000 + x;
/** The direction (0 right, 1 down, 2 left, 3 up) of the step from cell a to cell b. */
const step = (a: [number, number], b: [number, number]): number => (b[0] > a[0] ? 0 : b[1] > a[1] ? 1 : b[0] < a[0] ? 2 : 3);
const arrow = (e: Edge): string => `${e.tail ? "◀" : ""}${e.line === "dotted" ? "┄┄" : e.line === "thick" ? "━━" : "──"}${e.head ? "▶" : "─"}`;

export function drawGraph(graph: Graph, width: number, color = true): string[] {
  const across = graph.dir === "LR" || graph.dir === "RL";
  const tries: Array<[Direction, number]> = [[graph.dir, 20], [graph.dir, 14]];
  if (across) tries.push(["TD", 16], ["TD", 10]);
  else tries.push([graph.dir, 10]);
  for (const [dir, max] of tries) {
    const rows = attempt({ ...graph, dir }, max, width, color);
    if (rows !== undefined) return rows;
  }
  return list(graph, width);
}

function attempt(graph: Graph, max: number, width: number, color: boolean): string[] | undefined {
  const across = graph.dir === "LR" || graph.dir === "RL";
  const text = new Map<string, string[]>();
  const sizes = new Map<string, Size>();
  for (const node of graph.nodes.values()) {
    if (node.shape === "start" || node.shape === "end") {
      sizes.set(node.id, { w: 1, h: 1 });
      continue;
    }
    const lines = wrapLabel(node.label, max);
    text.set(node.id, lines);
    sizes.set(node.id, { w: Math.max(...lines.map(textWidth)) + 4, h: lines.length + 2 });
  }
  const label = (e: Edge): string => (textWidth(e.label) > max + 6 ? `${[...e.label].slice(0, max + 5).join("")}…` : e.label).replace(/\n/g, " ");
  const longest = Math.max(0, ...graph.edges.map((e) => textWidth(label(e))));
  const framed = graph.groups.length > 0;
  // Room for the labels: across, on the lines between ranks; down, beside the lines.
  const rankGap = across ? Math.min(28, Math.max(6, longest + 6)) : 3 + (framed ? 2 : 0) + (longest > 0 ? 1 : 0);
  const orderGap = across ? 1 + (longest > 0 ? 1 : 0) : 4 + Math.min(longest, 10);
  const boxes = layout(graph, sizes, { rankGap, orderGap });

  // A margin all round, wider on the left for labels beside a line (empty columns are trimmed).
  const margin = framed ? 3 : 1;
  const left = margin + (across ? 0 : longest + 2);
  for (const box of boxes.values()) {
    box.x += left;
    box.y += margin;
  }
  const all = [...boxes.values()];
  const right = Math.max(...all.map((b) => b.x + b.w));
  const bottom = Math.max(...all.map((b) => b.y + b.h));
  if (right - left > width) return undefined; // the boxes alone do not fit: no use routing

  const canvas = new Canvas();
  const grid: Grid = { width: right + margin + 3, height: bottom + margin + 2, boxes: all, horizontal: new Map(), vertical: new Map(), heads: new Map(), soft: new Set() };
  const legend: string[] = [];
  for (const group of graph.groups) if (!frame(canvas, grid, group, boxes)) legend.push(`▸ ${group.title}: ${group.ids.map((id) => graph.nodes.get(id)?.label.replace(/\n/g, " ") ?? id).join(", ")}`);
  for (const node of graph.nodes.values()) {
    const box = boxes.get(node.id);
    if (box) drawBox(canvas, box, node, text.get(node.id) ?? []);
  }

  const prefer: [Side, Side] = graph.dir === "TD" ? ["bottom", "top"] : graph.dir === "BT" ? ["top", "bottom"] : graph.dir === "LR" ? ["right", "left"] : ["left", "right"];
  const center = (id: string): [number, number] => {
    const b = boxes.get(id);
    return b ? [b.x + b.w / 2, b.y + b.h / 2] : [0, 0];
  };
  const distance = (e: Edge): number => (e.from === e.to ? 1e9 : Math.abs(center(e.from)[0] - center(e.to)[0]) + Math.abs(center(e.from)[1] - center(e.to)[1]));
  const routed: Array<[Edge, Route]> = [];
  for (const edge of graph.edges.toSorted((a, b) => distance(a) - distance(b))) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    const path = route(grid, { id: edge.from, box: from }, { id: edge.to, box: to }, prefer, edge.from === edge.to);
    if (path === undefined) {
      legend.push(`${name(graph, edge.from)} → ${name(graph, edge.to)}${edge.label ? `: ${edge.label}` : ""}`);
      continue;
    }
    drawEdge(canvas, grid, edge, path);
    routed.push([edge, path]);
  }
  // A label with no room by its line: a numbered mark there instead, the label in the legend.
  const taken = new Set<number>();
  let marks = 0;
  for (const [edge, path] of routed) {
    if (edge.label === "" || place(canvas, all, taken, label(edge), path)) continue;
    const mark = String.fromCodePoint(0x2460 + Math.min(marks, 19));
    if (marks < 20 && place(canvas, all, taken, mark, path)) {
      marks++;
      legend.push(`${mark} ${edge.label}`);
    } else legend.push(`${name(graph, edge.from)} → ${name(graph, edge.to)}: ${edge.label}`);
  }

  const rows = canvas.rows(color);
  if (Math.max(0, ...canvas.rows(false).map(textWidth)) > width) return undefined;
  return [...rows, ...(legend.length > 0 ? [""] : []), ...legend.flatMap((line) => wrapLabel(line, width))];
}

function name(graph: Graph, id: string): string {
  const node = graph.nodes.get(id);
  if (node?.shape === "start") return "start";
  if (node?.shape === "end") return "end";
  return node?.label.replace(/\n/g, " ") ?? id;
}

function drawBox(c: Canvas, b: Box, node: Node, lines: string[]): void {
  if (node.shape === "start" || node.shape === "end") {
    c.put(b.x, b.y, node.label, INK.decision);
    return;
  }
  const ink = node.shape === "decision" ? INK.decision : INK.box;
  const x2 = b.x + b.w - 1;
  const y2 = b.y + b.h - 1;
  c.run(b.x, b.y, x2, b.y, ink);
  c.run(b.x, y2, x2, y2, ink);
  c.run(b.x, b.y, b.x, y2, ink);
  c.run(x2, b.y, x2, y2, ink);
  const corners = node.shape === "round" ? "╭╮╰╯" : node.shape === "decision" ? "╱╲╲╱" : "";
  if (corners !== "") {
    const [tl, tr, bl, br] = [...corners];
    c.put(b.x, b.y, tl ?? "", ink);
    c.put(x2, b.y, tr ?? "", ink);
    c.put(b.x, y2, bl ?? "", ink);
    c.put(x2, y2, br ?? "", ink);
  }
  for (const [i, line] of lines.entries()) c.text(b.x + Math.floor((b.w - textWidth(line)) / 2), b.y + 1 + i, line, INK.text);
}

/** A group's dotted frame with its title, when it fits around its members and nothing else. */
function frame(c: Canvas, grid: Grid, group: { title: string; ids: string[] }, boxes: Map<string, Box>): boolean {
  const members = group.ids.map((id) => boxes.get(id)).filter((b) => b !== undefined);
  if (members.length === 0) return false;
  const x1 = Math.min(...members.map((b) => b.x)) - 2;
  const y1 = Math.min(...members.map((b) => b.y)) - 2;
  const title = ` ${group.title} `;
  // Wide enough for its title too.
  const x2 = Math.max(Math.max(...members.map((b) => b.x + b.w)) + 1, x1 + textWidth(title) + 3);
  const y2 = Math.max(...members.map((b) => b.y + b.h)) + 1;
  if (x1 < 0 || y1 < 0) return false;
  for (const [id, b] of boxes) {
    if (group.ids.includes(id)) continue;
    if (b.x <= x2 && b.x + b.w - 1 >= x1 && b.y <= y2 && b.y + b.h - 1 >= y1) return false; // another node inside
  }
  for (let x = x1; x <= x2; x++) {
    for (const y of [y1, y2]) if (!c.free(x, y)) return false; // another frame's line
  }
  c.run(x1, y1, x2, y1, INK.frame, "dotted");
  c.run(x1, y2, x2, y2, INK.frame, "dotted");
  c.run(x1, y1, x1, y2, INK.frame, "dotted");
  c.run(x2, y1, x2, y2, INK.frame, "dotted");
  c.put(x1, y1, "╭", INK.frame);
  c.put(x2, y1, "╮", INK.frame);
  c.put(x1, y2, "╰", INK.frame);
  c.put(x2, y2, "╯", INK.frame);
  c.text(x1 + 2, y1, title, INK.title);
  for (let x = x1; x <= x2; x++) grid.soft.add(key(x, y1)).add(key(x, y2));
  for (let y = y1; y <= y2; y++) grid.soft.add(key(x1, y)).add(key(x2, y));
  return true;
}

function drawEdge(c: Canvas, grid: Grid, edge: Edge, path: Route): void {
  const cells = path.cells;
  const leave = (into(path.start) + 2) % 4; // the step that leaves the source: entering it, reversed
  for (const [i, [x, y]] of cells.entries()) {
    let mask = 0;
    const prev = cells[i - 1];
    const next = cells[i + 1];
    mask |= prev ? (BACK[step(prev, [x, y])] ?? 0) : (BACK[leave] ?? 0);
    if (next) mask |= DIRS[step([x, y], next)] ?? 0;
    else mask |= DIRS[into(path.end)] ?? 0;
    const k = key(x, y);
    if (mask & (LEFT | RIGHT)) grid.horizontal.set(k, grid.horizontal.get(k) ?? edge.from);
    if (mask & (UP | DOWN)) grid.vertical.set(k, grid.vertical.get(k) ?? edge.from);
    c.line(x, y, mask, INK.line, edge.line);
  }
  // Where the edge leaves the source, its border shows a junction (┬), or a tail arrow sits there.
  const [sx, sy] = cells[0] ?? [0, 0];
  if (edge.tail) c.put(sx, sy, HEADS[(leave + 2) % 4] ?? "", INK.arrow);
  else c.line(sx - (DX[leave] ?? 0), sy - (DY[leave] ?? 0), DIRS[leave] ?? 0, INK.box);
  const [ex, ey] = cells.at(-1) ?? [0, 0];
  const d = into(path.end);
  if (edge.head) {
    c.put(ex, ey, HEADS[d] ?? "", INK.arrow);
    grid.heads.set(key(ex, ey), edge.to);
  } else c.line(ex + (DX[d] ?? 0), ey + (DY[d] ?? 0), BACK[d] ?? 0, INK.box);
}

/** Puts an edge's label on a straight stretch of its line, or beside a vertical one; false when
 *  there is no room anywhere along it. */
function place(c: Canvas, boxes: Box[], taken: Set<number>, text: string, path: Route): boolean {
  const cells = path.cells;
  const w = textWidth(text);
  const clear = (x: number, y: number): boolean => x >= 0 && c.free(x, y) && !taken.has(key(x, y)) && !boxes.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  const mid = Math.floor(cells.length / 2);
  const order = cells.map((_, i) => i).toSorted((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  const write = (x: number, y: number): true => {
    c.text(x, y, text, INK.label);
    for (let i = 0; i < w; i++) taken.add(key(x + i, y));
    return true;
  };
  for (const i of order) {
    const [x, y] = cells[i] ?? [0, 0];
    const horizontal = cells[i - 1]?.[1] === y || cells[i + 1]?.[1] === y;
    if (horizontal) {
      // A run of plain line on this row, wide enough for the label and a space each side.
      let a = i;
      let b = i;
      const plain = (j: number): boolean => {
        const m = c.mask(cells[j]?.[0] ?? 0, y);
        return cells[j]?.[1] === y && (m & (LEFT | RIGHT)) !== 0 && (m & (UP | DOWN)) === 0 && !taken.has(key(cells[j]?.[0] ?? 0, y));
      };
      while (a > 1 && plain(a - 1)) a--;
      while (b < cells.length - 2 && plain(b + 1)) b++;
      if (!plain(i) || b - a + 1 < w + 2) continue;
      const lo = Math.min(cells[a]?.[0] ?? 0, cells[b]?.[0] ?? 0);
      const span = Math.abs((cells[b]?.[0] ?? 0) - (cells[a]?.[0] ?? 0)) + 1;
      const start = lo + Math.floor((span - w) / 2);
      c.put(start - 1, y, " ");
      c.put(start + w, y, " ");
      return write(start, y);
    }
    // Beside a vertical line, a space between them and a space beyond.
    const fits = (from: number): boolean => Array.from({ length: w + 2 }, (_, j) => from + j).every((cx) => clear(cx, y));
    if (fits(x + 1)) return write(x + 2, y);
    if (fits(x - w - 2)) return write(x - w - 1, y);
  }
  return false;
}

/** The edges as lines of text: the drawing would not fit. */
function list(graph: Graph, width: number): string[] {
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  const lines = [
    ...graph.edges.map((e) => `${name(graph, e.from)} ${arrow(e)} ${name(graph, e.to)}${e.label ? `  (${e.label.replace(/\n/g, " ")})` : ""}`),
    ...[...graph.nodes.keys()].filter((id) => !linked.has(id)).map((id) => `• ${name(graph, id)}`),
  ];
  return lines.flatMap((line) => wrapLabel(line, width));
}

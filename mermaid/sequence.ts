// `sequenceDiagram`: participants as boxes over dotted lifelines, messages as arrows between them
// (->> solid, -->> dotted, -x lost, -) async, self messages as a loop), notes, autonumber, and
// loop/alt/opt/par/critical/break blocks as frames with their else/and sections. Columns are as
// far apart as their messages need; too wide, message text wraps, and at worst it is a list.

import { Canvas, DOWN, INK, UP, textWidth } from "./canvas.ts";
import { cleanLabel, statements, wrapLabel } from "./model.ts";

interface Actor {
  id: string;
  label: string;
}

type Event =
  | { kind: "msg"; from: number; to: number; text: string; dotted: boolean; head: string; tail: boolean }
  | { kind: "note"; at: "left" | "right" | "over"; ids: number[]; text: string }
  | { kind: "open"; title: string }
  | { kind: "else"; title: string }
  | { kind: "close" };

const ARROW = /^(.+?)\s*(<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?\s*(.+?)\s*:\s*(.*)$/;
const HEAD: Record<string, string> = { ">>": "▶", x: "×", ")": "▷" };

export function parseSequence(source: string): { actors: Actor[]; events: Event[] } | undefined {
  const lines = statements(source);
  if (!/^sequenceDiagram\b/.test(lines[0] ?? "")) return undefined;
  const actors: Actor[] = [];
  const events: Event[] = [];
  const stack: boolean[] = []; // per open block: drawn (loop, alt...) or not (box, rect)
  let number = 0;
  let autonumber = false;
  const actor = (raw: string, label?: string): number => {
    const id = raw.trim();
    let i = actors.findIndex((a) => a.id === id);
    if (i < 0) i = actors.push({ id, label: id }) - 1;
    if (label !== undefined) actors[i] = { id, label: cleanLabel(label) };
    return i;
  };
  for (const line of lines.slice(1)) {
    const declared = /^(?:create\s+)?(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(line);
    if (declared) {
      actor(declared[1] ?? "", declared[2]);
      continue;
    }
    if (line === "autonumber" || line.startsWith("autonumber ")) {
      autonumber = true;
      continue;
    }
    if (/^(activate|deactivate|destroy|link|links|properties)\b/.test(line)) continue;
    if (/^(box|rect)\b/.test(line)) {
      stack.push(false);
      continue;
    }
    const block = /^(loop|alt|opt|par|critical|break)\b\s*(.*)$/.exec(line);
    if (block) {
      stack.push(true);
      events.push({ kind: "open", title: `${block[1]}${block[2] ? ` · ${cleanLabel(block[2])}` : ""}` });
      continue;
    }
    const section = /^(else|and|option)\b\s*(.*)$/.exec(line);
    if (section) {
      events.push({ kind: "else", title: `${section[1]}${section[2] ? ` · ${cleanLabel(section[2])}` : ""}` });
      continue;
    }
    if (line === "end") {
      if (stack.pop()) events.push({ kind: "close" });
      continue;
    }
    const note = /^note\s+(left of|right of|over)\s+([^:]+?)\s*:\s*(.*)$/i.exec(line);
    if (note) {
      const ids = (note[2] ?? "").split(",").map((id) => actor(id));
      const at = (note[1] ?? "").toLowerCase().startsWith("left") ? "left" : note[1]?.toLowerCase().startsWith("right") ? "right" : "over";
      events.push({ kind: "note", at, ids, text: cleanLabel(note[3] ?? "") });
      continue;
    }
    const msg = ARROW.exec(line);
    if (msg) {
      const arrow = msg[2] ?? "->";
      const end = arrow.endsWith(">>") ? ">>" : arrow.endsWith("x") ? "x" : arrow.endsWith(")") ? ")" : "";
      const text = cleanLabel(msg[4] ?? "").replace(/\n/g, " ");
      events.push({
        kind: "msg", from: actor(msg[1] ?? ""), to: actor(msg[3] ?? ""), text: autonumber ? `${++number}. ${text}` : text,
        dotted: arrow.replace(/^<</, "").startsWith("--"), head: HEAD[end] ?? "", tail: arrow.startsWith("<<"),
      });
    }
  }
  return actors.length > 0 ? { actors, events } : undefined;
}

export function drawSequence(source: string, width: number, color = true): string[] | undefined {
  const parsed = parseSequence(source);
  if (parsed === undefined) return undefined;
  for (const max of [48, 28, 16]) {
    const rows = attempt(parsed.actors, parsed.events, max, width, color);
    if (rows !== undefined) return rows;
  }
  return list(parsed.actors, parsed.events, width);
}

function attempt(actors: Actor[], events: Event[], max: number, width: number, color: boolean): string[] | undefined {
  const n = actors.length;
  const names = actors.map((a) => wrapLabel(a.label, Math.max(8, max))[0] ?? a.id);
  const boxW = names.map((name) => textWidth(name) + 4);
  const wrap = (text: string): string[] => wrapLabel(text, max);
  const widest = (text: string): number => Math.max(0, ...wrap(text).map(textWidth));
  let depth = 0;
  let deepest = 0;
  for (const e of events) {
    if (e.kind === "open") deepest = Math.max(deepest, ++depth);
    if (e.kind === "close") depth--;
  }

  // Gaps between neighbouring lifelines: the boxes, then whatever each message or note needs.
  const gaps = Array.from({ length: Math.max(0, n - 1) }, (_, i) => Math.ceil((boxW[i] ?? 0) / 2) + Math.ceil((boxW[i + 1] ?? 0) / 2) + 2);
  let leftExtra = 0;
  let rightExtra = 0;
  const need = (a: number, b: number, want: number): void => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const have = gaps.slice(lo, hi).reduce((s, g) => s + g, 0);
    for (let k = lo; k < hi; k++) gaps[k] = (gaps[k] ?? 0) + Math.ceil(Math.max(0, want - have) / (hi - lo));
  };
  const spans = events.flatMap((e): Array<[number, number, number]> => {
    if (e.kind === "msg") return e.from === e.to ? [[e.from, e.from + 1, widest(e.text) + 7]] : [[e.from, e.to, widest(e.text) + 4]];
    if (e.kind !== "note") return [];
    const w = widest(e.text) + 4;
    const i = e.ids[0] ?? 0;
    if (e.at === "right") return [[i, i + 1, w + 3]];
    if (e.at === "left") return [[i - 1, i, w + 3]];
    return e.ids.length > 1 ? [[i, e.ids.at(-1) ?? i, w - 4]] : [];
  });
  for (const [a, b, want] of spans.toSorted((x, y) => Math.abs(x[1] - x[0]) - Math.abs(y[1] - y[0]))) {
    if (b >= n) rightExtra = Math.max(rightExtra, want);
    else if (a < 0) leftExtra = Math.max(leftExtra, want);
    else need(a, b, want);
  }
  const frame = deepest * 2;
  const centers: number[] = [];
  let at = frame + Math.max(Math.ceil((boxW[0] ?? 0) / 2), leftExtra) + 1;
  for (let i = 0; i < n; i++) {
    centers.push(at);
    at += gaps[i] ?? 0;
  }
  const total = (centers.at(-1) ?? 0) + Math.max(Math.ceil((boxW.at(-1) ?? 0) / 2), rightExtra) + frame + 2;
  if (total > width) return undefined;

  const c = new Canvas();
  const box = (i: number, y: number, bottom: boolean): void => {
    const w = boxW[i] ?? 4;
    const x = (centers[i] ?? 0) - Math.floor(w / 2);
    c.run(x, y, x + w - 1, y, INK.box);
    c.run(x, y + 2, x + w - 1, y + 2, INK.box);
    c.run(x, y, x, y + 2, INK.box);
    c.run(x + w - 1, y, x + w - 1, y + 2, INK.box);
    c.text(x + 2, y + 1, names[i] ?? "", INK.text);
    c.line(centers[i] ?? 0, bottom ? y : y + 2, bottom ? UP : DOWN, INK.box);
  };
  actors.forEach((_, i) => box(i, 0, false));
  let y = 4;
  const open: number[] = [];
  const edge = (d: number): [number, number] => [d * 2, total - 1 - d * 2];
  const bar = (d: number, row: number, title: string, ends: [string, string]): void => {
    const [x1, x2] = edge(d);
    for (let x = x1; x <= x2; x++) c.put(x, row, "┄", INK.frame);
    c.put(x1, row, ends[0], INK.frame);
    c.put(x2, row, ends[1], INK.frame);
    if (title !== "") c.text(x1 + 2, row, ` ${title} `, INK.title);
  };
  for (const e of events) {
    if (e.kind === "open") {
      bar(open.length, y, e.title, ["╭", "╮"]);
      open.push(y++);
    } else if (e.kind === "else") {
      if (open.length > 0) bar(open.length - 1, y++, e.title, ["├", "┤"]);
    } else if (e.kind === "close") {
      const start = open.pop() ?? y;
      const [x1, x2] = edge(open.length);
      for (let row = start + 1; row < y; row++) for (const x of [x1, x2]) if (c.free(x, row)) c.put(x, row, "┆", INK.frame);
      bar(open.length, y++, "", ["╰", "╯"]);
    } else if (e.kind === "note") {
      const lines = wrap(e.text);
      const w = Math.max(...lines.map(textWidth)) + 4;
      const first = centers[e.ids[0] ?? 0] ?? 0;
      const last = centers[e.ids.at(-1) ?? 0] ?? 0;
      const x = e.at === "right" ? first + 2 : e.at === "left" ? first - 1 - w : Math.floor((first + last) / 2 - w / 2);
      const nw = e.at === "over" && e.ids.length > 1 ? Math.max(w, last - first + 4) : w;
      const nx = e.at === "over" && e.ids.length > 1 ? Math.min(x, first - 2) : x;
      for (let row = 0; row < lines.length + 2; row++) for (let col = 0; col < nw; col++) c.put(nx + col, y + row, " ");
      for (let col = 1; col < nw - 1; col++) {
        c.put(nx + col, y, "─", INK.frame);
        c.put(nx + col, y + lines.length + 1, "─", INK.frame);
      }
      for (let row = 1; row <= lines.length; row++) {
        c.put(nx, y + row, "│", INK.frame);
        c.put(nx + nw - 1, y + row, "│", INK.frame);
      }
      for (const [k, ch] of ["┌", "┐", "└", "┘"].entries()) c.put(nx + (k % 2 === 0 ? 0 : nw - 1), y + (k < 2 ? 0 : lines.length + 1), ch, INK.frame);
      lines.forEach((line, k) => c.text(nx + 2, y + 1 + k, line, INK.label));
      y += lines.length + 2;
    } else if (e.from === e.to) {
      const x = centers[e.from] ?? 0;
      const lines = wrap(e.text);
      c.run(x, y, x + 3, y, INK.line, e.dotted ? "dotted" : "solid");
      c.put(x + 3, y, "╮", INK.line);
      c.put(x + 3, y + 1, "╯", INK.line);
      c.put(x + 2, y + 1, "─", INK.line);
      c.put(x + 1, y + 1, e.head === "▶" ? "◀" : e.head === "▷" ? "◁" : e.head || "─", INK.arrow); // coming back
      lines.forEach((line, k) => c.text(x + 5, y + k, line, INK.label));
      y += Math.max(2, lines.length);
    } else {
      const a = centers[e.from] ?? 0;
      const b = centers[e.to] ?? 0;
      const lines = wrap(e.text);
      lines.forEach((line, k) => c.text(Math.floor((a + b) / 2 - textWidth(line) / 2), y + k, line, INK.label));
      y += lines.length;
      c.run(a, y, b, y, INK.line, e.dotted ? "dotted" : "solid");
      const dir = b > a ? 1 : -1;
      if (e.head) c.put(b - dir, y, e.head === "▶" && dir < 0 ? "◀" : e.head === "▷" && dir < 0 ? "◁" : e.head, INK.arrow);
      if (e.tail) c.put(a + dir, y, dir > 0 ? "◀" : "▶", INK.arrow);
      y++;
    }
  }
  y++;
  for (const x of centers) for (let row = 3; row < y; row++) c.line(x, row, UP | DOWN, INK.frame, "dotted");
  actors.forEach((_, i) => box(i, y, true));
  return c.rows(color);
}

function list(actors: Actor[], events: Event[], width: number): string[] {
  const name = (i: number): string => actors[i]?.label ?? "?";
  return events.flatMap((e) => {
    if (e.kind === "msg") return wrapLabel(`${name(e.from)} ${e.dotted ? "┄┄" : "──"}${e.head || "─"} ${name(e.to)}: ${e.text}`, width);
    if (e.kind === "note") return wrapLabel(`  ┆ ${e.ids.map(name).join(", ")}: ${e.text}`, width);
    if (e.kind === "close") return ["╰┄"];
    return wrapLabel(`${e.kind === "open" ? "╭┄" : "├┄"} ${e.title}`, width);
  });
}

// `flowchart` / `graph`: nodes with shapes (A[box] B(round) C{decision} ...), chains of links
// (A --> B -- label --> C, A -->|label| B, A & B --> C, -.-> dotted, ==> thick, <--> both ways)
// and subgraphs. Styling (classDef, style, click...) is ignored: a terminal draws its own way.

import { cleanLabel, direction, statements } from "./model.ts";
import type { Edge, Graph, Group, Shape } from "./model.ts";

/** Openers and their closers, longest first, with the shape each draws as. */
const SHAPES: Array<[string, string, Shape]> = [
  ["(((", ")))", "round"], ["((", "))", "round"], ["([", "])", "round"], ["[[", "]]", "rect"],
  ["[(", ")]", "round"], ["[/", "/]", "rect"], ["[\\", "\\]", "rect"], ["[/", "\\]", "rect"],
  ["[\\", "/]", "rect"], ["{{", "}}", "decision"], ["(", ")", "round"], ["[", "]", "rect"],
  ["{", "}", "decision"], [">", "]", "rect"],
];

const ID = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*?(?=$|[\s[\](){}>&;:|"']|-[-.=>]|\.-|={2}|~{3})/u;
/** A link with its label in the middle: -- text -->, -. text .->, == text ==>. */
const MID = /^\s*(<?)(--|==|-\.)(?![->=.])\s*(.+?)\s*(-{2,}[>xo]|-{3,}|={2,}[>xo]|={3,}|\.-+[>xo]?)\s*/;
/** A plain link, its label maybe after it between pipes: -->, ---, -.->, ==>, <-->, --o, ~~~. */
const PLAIN = /^\s*(<?)(-{2,}|={2,}|-\.+-|~{3,})([>xo]?)\s*(?:\|([^|]*)\|\s*)?/;

interface Cursor {
  text: string;
  at: number;
}

export function parseFlowchart(source: string): Graph | undefined {
  // `graph LR; A --> B` on one line: statements split on semicolons first, the header included.
  const lines = statements(source).flatMap(splitStatements);
  const head = /^(flowchart|graph)\b\s*(\w+)?/i.exec(lines[0] ?? "");
  if (!head) return undefined;
  const graph: Graph = { dir: direction(head[2]), nodes: new Map(), edges: [], groups: [] };
  const open: Group[] = [];
  const touch = (id: string, label?: string, shape?: Shape): void => {
    const known = graph.nodes.get(id);
    if (known === undefined) graph.nodes.set(id, { id, label: label ?? id, shape: shape ?? "rect" });
    else if (label !== undefined) graph.nodes.set(id, { id, label, shape: shape ?? known.shape });
    for (const g of open) if (!g.ids.includes(id)) g.ids.push(id);
  };

  for (const line of lines.slice(1)) {
    if (/^(classDef|class|style|linkStyle|click|direction)\b/.test(line)) continue;
    const subgraph = /^subgraph\s+(.*)$/.exec(line);
    if (subgraph) {
      const spec = subgraph[1] ?? "";
      const titled = /^([^\s[]+)\s*\[(.*)\]$/.exec(spec);
      const sub: Group = { title: cleanLabel(titled ? (titled[2] ?? "") : spec), ids: [] };
      graph.groups.push(sub);
      open.push(sub);
      continue;
    }
    if (line === "end") {
      open.pop();
      continue;
    }
    chain({ text: line, at: 0 }, graph.edges, touch);
  }
  return graph.nodes.size > 0 ? graph : undefined;
}

/** `A --> B; B --> C` on one line: statements split on semicolons outside labels. */
function splitStatements(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (const ch of line) {
    if (ch === '"') quote = !quote;
    else if (!quote && "[({".includes(ch)) depth++;
    else if (!quote && "])}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0 && !quote) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter((s) => s !== "");
}

/** A node: its id, and a label and shape when it brings them. */
function node(c: Cursor): { id: string; label?: string; shape?: Shape } | undefined {
  const rest = c.text.slice(c.at).replace(/^\s+/, "");
  c.at = c.text.length - rest.length;
  const id = ID.exec(rest)?.[0];
  if (!id) return undefined;
  c.at += id.length;
  let label: string | undefined;
  let shape: Shape | undefined;
  for (const [opener, closer, kind] of SHAPES) {
    if (!c.text.startsWith(opener, c.at)) continue;
    const start = c.at + opener.length;
    // A quoted label may hold the closer; otherwise the first closer ends it.
    const quoted = c.text[start] === '"' ? c.text.indexOf('"', start + 1) : start;
    const end = c.text.indexOf(closer, Math.max(start, quoted));
    if (end < 0) continue;
    label = cleanLabel(c.text.slice(start, end));
    shape = kind;
    c.at = end + closer.length;
    break;
  }
  const cls = /^:::[\w-]+/.exec(c.text.slice(c.at));
  if (cls) c.at += cls[0].length;
  return { id, label, shape };
}

/** Nodes joined by &. */
function group(c: Cursor, touch: (id: string, label?: string, shape?: Shape) => void): string[] {
  const ids: string[] = [];
  for (;;) {
    const n = node(c);
    if (n === undefined) break;
    touch(n.id, n.label, n.shape);
    ids.push(n.id);
    const amp = /^\s*&\s*/.exec(c.text.slice(c.at));
    if (!amp) break;
    c.at += amp[0].length;
  }
  return ids;
}

function chain(c: Cursor, edges: Edge[], touch: (id: string, label?: string, shape?: Shape) => void): void {
  let left = group(c, touch);
  while (left.length > 0 && c.at < c.text.length) {
    const rest = c.text.slice(c.at);
    const mid = MID.exec(rest);
    const plain = mid ? undefined : PLAIN.exec(rest);
    const link = mid ?? plain;
    if (!link) return;
    c.at += link[0].length;
    const body = mid ? `${mid[2]}${mid[4]}` : `${plain?.[2] ?? ""}${plain?.[3] ?? ""}`;
    const label = cleanLabel(mid ? (mid[3] ?? "") : (plain?.[4] ?? ""));
    const right = group(c, touch);
    if (body.startsWith("~~~")) {
      left = right; // an invisible link: it only places nodes
      continue;
    }
    const line = body.includes("=") ? "thick" : body.includes(".") ? "dotted" : "solid";
    const head = /[>xo]$/.test(body);
    const tail = link[1] === "<";
    for (const from of left) for (const to of right) edges.push({ from, to, label, line, head, tail });
    left = right;
  }
}

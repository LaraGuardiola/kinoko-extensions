// What a flowchart or a state diagram says, once parsed: nodes, edges, groups (subgraphs or
// composite states) and the direction it flows in. Layout and drawing read only this.

import { textWidth } from "./canvas.ts";

export type Shape = "rect" | "round" | "decision" | "start" | "end";
export type Direction = "TD" | "LR" | "BT" | "RL";

export interface Node {
  id: string;
  label: string;
  shape: Shape;
}

export interface Edge {
  from: string;
  to: string;
  label: string;
  line: "solid" | "dotted" | "thick";
  /** An arrowhead at the target; `tail` one at the source too (<-->). */
  head: boolean;
  tail: boolean;
}

export interface Group {
  title: string;
  ids: string[];
}

export interface Graph {
  dir: Direction;
  nodes: Map<string, Node>;
  edges: Edge[];
  groups: Group[];
}

export function direction(word: string | undefined): Direction {
  const d = (word ?? "").toUpperCase();
  return d === "LR" || d === "BT" || d === "RL" ? d : "TD";
}

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " ", "#39": "'" };

/** A label as text: quotes, markdown and HTML gone, <br> as a new line, entities decoded. */
export function cleanLabel(raw: string): string {
  let text = raw.trim();
  if (/^".*"$/s.test(text) || /^`.*`$/s.test(text)) text = text.slice(1, -1);
  return text
    .replace(/<br\s*\/?>|\\n/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/fa:fa-[\w-]+\s*/g, "")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/[#&](#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? (name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1)) || 63) : whole))
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** A label broken into lines of at most `max` columns, between words where it can. */
export function wrapLabel(label: string, max: number): string[] {
  const rows: string[] = [];
  for (const line of label.split("\n")) {
    let cur = "";
    for (const word of line.split(/\s+/)) {
      let piece = word;
      while (textWidth(piece) > max) {
        if (cur !== "") rows.push(cur);
        cur = "";
        let cut = "";
        for (const ch of piece) {
          if (textWidth(cut + ch) > max) break;
          cut += ch;
        }
        rows.push(cut);
        piece = piece.slice(cut.length);
      }
      if (cur === "") cur = piece;
      else if (textWidth(`${cur} ${piece}`) <= max) cur += ` ${piece}`;
      else {
        rows.push(cur);
        cur = piece;
      }
    }
    rows.push(cur);
  }
  return rows.filter((row, i) => row !== "" || i === 0);
}

/** The diagram's lines without comments and blank lines, its header first. */
export function statements(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => line !== "" && !/^(accTitle|accDescr|title)\b/.test(line));
}

// The tree drawn with characters. In display, a box of rows with a baseline: fractions stacked,
// roots with a bar, tall brackets around tall things, matrices and aligned lines on a grid,
// limits above and below ∑ and lim. Flat, the same on one line (a/b, √(…), x^(n+1)) for inline
// math and for a display too wide to stack.

import type { Kind, Node } from "./parse.ts";
import { scriptForm } from "./symbols.ts";

/** Rows of equal width; `base` is the row the formula's main line runs on. */
export interface Box {
  rows: string[];
  base: number;
}

/** Columns a string takes: combining marks (the accents) take none. */
export function textWidth(s: string): number {
  return [...s.replace(/\p{M}/gu, "")].length;
}

const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - textWidth(s)));
const center = (s: string, n: number): string => {
  const room = Math.max(0, n - textWidth(s));
  return " ".repeat(Math.floor(room / 2)) + s + " ".repeat(Math.ceil(room / 2));
};
const widthOf = (b: Box): number => Math.max(0, ...b.rows.map(textWidth));
const line = (s: string): Box => ({ rows: [s], base: 0 });

/** Side by side, on one baseline. */
function hcat(boxes: Box[]): Box {
  const above = Math.max(0, ...boxes.map((b) => b.base));
  const below = Math.max(0, ...boxes.map((b) => b.rows.length - 1 - b.base));
  const rows = Array.from({ length: above + below + 1 }, () => "");
  for (const b of boxes) {
    const w = widthOf(b);
    for (let r = 0; r < rows.length; r++) rows[r] += pad(b.rows[r - (above - b.base)] ?? "", w);
  }
  return { rows, base: above };
}

/** One above the other, centred; `base` is the row of the `at`th box's own baseline. */
function vstack(boxes: Box[], at: number): Box {
  const w = Math.max(...boxes.map(widthOf));
  const rows: string[] = [];
  let base = 0;
  boxes.forEach((b, i) => {
    if (i === at) base = rows.length + b.base;
    rows.push(...b.rows.map((r) => center(r, w)));
  });
  return { rows, base };
}

// ---- flat: one line ----

/** A flat piece that is more than one token gets parentheses where it would otherwise mislead. */
function wrap(s: string): string {
  return /^[\p{L}\p{N}\p{M}.′]+$/u.test(s) || /^\(.*\)$/.test(s) ? s : `(${s})`;
}

function spaced(s: string, kind: Kind, first: boolean, tight: boolean): string {
  if (tight) return s;
  if (kind === "rel") return ` ${s} `;
  if (kind === "bin" && !first) return ` ${s} `;
  if (kind === "punct") return `${s} `;
  return s;
}

/** Whether a row's item is an operand: a binary operator after it is binary, not a sign. */
const operand = (n: Node | undefined): boolean => n !== undefined && !(n.k === "sym" && n.kind !== "ord" && n.kind !== "close") && n.k !== "space";

/** The formula on one line. `tight`: inside a script, no room around operators. */
export function flat(node: Node, tight = false): string {
  switch (node.k) {
    case "sym":
      return node.s;
    case "space":
      return " ".repeat(node.n);
    case "row":
      return joinRow(node.items, tight, (n) => flat(n, tight));
    case "frac":
      return `${wrap(flat(node.num, true))}/${wrap(flat(node.den, true))}`;
    case "sqrt": {
      const index = node.index === undefined ? "" : (scriptForm(flat(node.index, true), true) ?? `${flat(node.index, true)}`);
      return `${index}√${wrap(flat(node.body, true))}`;
    }
    case "op":
      return node.s;
    case "scripts":
      // ∫₀¹: an operator's lower limit first, as it is read.
      return node.base.k === "op"
        ? flat(node.base, tight) + script(node.sub, false) + script(node.sup, true)
        : flat(node.base, tight) + script(node.sup, true) + script(node.sub, false);
    case "delim":
      return `${node.left}${flat(node.body, tight)}${node.right}`;
    case "grid": {
      const rows = node.rows.map((cells) => cells.map((c) => flat(c, tight)).join(node.align === "rl" ? "" : ", "));
      return `${node.left}${rows.join("; ")}${node.right}`;
    }
  }
}

function script(node: Node | undefined, up: boolean): string {
  if (node === undefined) return "";
  const text = flat(node, true);
  return scriptForm(text, up) ?? `${up ? "^" : "_"}${wrap(text)}`;
}

/** A row's items with the room TeX would leave: around = and +, after commas and named operators. */
function joinRow(items: Node[], tight: boolean, draw: (n: Node) => string): string {
  let out = "";
  items.forEach((n, i) => {
    const s = draw(n);
    if (n.k === "sym") out += spaced(s, n.kind, !operand(items[i - 1]), tight);
    else if (isNamedOp(n) && !tight) out += `${operand(items[i - 1]) ? " " : ""}${s}${items[i + 1] === undefined ? "" : " "}`;
    else out += s;
  });
  return out.replace(/ {2,}/g, " ");
}

const isNamedOp = (n: Node): boolean => (n.k === "op" && /^\p{L}/u.test(n.s)) || (n.k === "scripts" && n.base.k === "op");

// ---- display: a box ----

/** The formula as a box: stacked where TeX would stack it. */
export function display(node: Node): Box {
  switch (node.k) {
    case "sym":
    case "space":
    case "op":
      return line(flat(node));
    case "row":
      return displayRow(node.items);
    case "frac": {
      const num = display(node.num);
      const den = display(node.den);
      const w = Math.max(widthOf(num), widthOf(den)) + 2;
      return vstack([num, line("─".repeat(w)), den], 1);
    }
    case "sqrt": {
      const body = display(node.body);
      const w = widthOf(body);
      const index = node.index === undefined ? "" : (scriptForm(flat(node.index, true), true) ?? flat(node.index, true));
      const h = body.rows.length;
      const rows = [" ".repeat(textWidth(index) + 1) + "_".repeat(w), ...body.rows.map((r, i) => (i === h - 1 ? `${index}√` : `${" ".repeat(textWidth(index))}│`) + pad(r, w))];
      return { rows, base: body.base + 1 };
    }
    case "scripts":
      return displayScripts(node);
    case "delim": {
      const body = display(node.body);
      return hcat([tall(node.left, body, true), body, tall(node.right, body, false)]);
    }
    case "grid":
      return displayGrid(node);
  }
}

function displayRow(items: Node[]): Box {
  const boxes: Box[] = [];
  items.forEach((n, i) => {
    if (n.k === "sym") boxes.push(line(spaced(n.s, n.kind, !operand(items[i - 1]), false)));
    else {
      const named = isNamedOp(n);
      if (named && operand(items[i - 1])) boxes.push(line(" "));
      boxes.push(display(n));
      if (named && items[i + 1] !== undefined) boxes.push(line(" "));
    }
  });
  return boxes.length === 0 ? line("") : hcat(boxes);
}

/** The room a leading = or a trailing operator leaves at the formula's edges, taken off. */
export function trimBox(box: Box): Box {
  const lead = Math.min(...box.rows.map((r) => (r.trim() === "" ? Infinity : r.length - r.trimStart().length)));
  const cut = lead === Infinity ? 0 : lead;
  return { rows: box.rows.map((r) => r.slice(cut).trimEnd()), base: box.base };
}

function displayScripts(node: Extract<Node, { k: "scripts" }>): Box {
  const base = display(node.base);
  // ∑ and lim: their limits above and below, centred, one line each.
  if (node.base.k === "op" && node.base.limits) {
    const parts: Box[] = [];
    if (node.sup) parts.push(line(flat(node.sup, true)));
    parts.push(base);
    if (node.sub) parts.push(line(flat(node.sub, true)));
    return vstack(parts, node.sup ? 1 : 0);
  }
  const sup = node.sup === undefined ? "" : flat(node.sup, true);
  const sub = node.sub === undefined ? "" : flat(node.sub, true);
  const supForm = sup === "" ? "" : scriptForm(sup, true);
  const subForm = sub === "" ? "" : scriptForm(sub, false);
  // A one-line base whose scripts all have Unicode forms: x², aᵢⱼ, as it reads in text.
  // An operator (∫) with both limits stacks them, it does not run them together (∫¹₀).
  const both = node.base.k === "op" && sup !== "" && sub !== "";
  if (base.rows.length === 1 && !both && supForm !== undefined && subForm !== undefined) return line(base.rows[0] + supForm + subForm);
  // Otherwise the scripts go on the rows above and below the base's top and bottom.
  const w = widthOf(base);
  const rows = [...(sup === "" ? [] : [" ".repeat(w) + sup]), ...base.rows.map((r) => pad(r, w)), ...(sub === "" ? [] : [" ".repeat(w) + sub])];
  return { rows, base: base.base + (sup === "" ? 0 : 1) };
}

const TALL: Record<string, [string, string, string, string?]> = {
  "(": ["⎛", "⎜", "⎝"], ")": ["⎞", "⎟", "⎠"], "[": ["⎡", "⎢", "⎣"], "]": ["⎤", "⎥", "⎦"],
  "{": ["⎧", "⎪", "⎩", "⎨"], "}": ["⎫", "⎪", "⎭", "⎬"], "⌈": ["⎡", "⎢", "⎢"], "⌉": ["⎤", "⎥", "⎥"],
  "⌊": ["⎢", "⎢", "⎣"], "⌋": ["⎥", "⎥", "⎦"], "|": ["│", "│", "│"], "‖": ["‖", "‖", "‖"],
};

/** A delimiter as tall as `body`. */
function tall(d: string, body: Box, left: boolean): Box {
  const h = body.rows.length;
  if (d === "") return { rows: Array.from({ length: h }, () => ""), base: body.base };
  if (h === 1) return line(d);
  const parts = TALL[d];
  if (parts === undefined) return { rows: body.rows.map((_, i) => (i === body.base ? d : " ")), base: body.base };
  const [top, mid, bottom, middle] = parts;
  if (h === 2 && (d === "{" || d === "}")) return { rows: left === (d === "{") ? ["⎰", "⎱"] : ["⎱", "⎰"], base: body.base };
  const midRow = Math.floor((h - 1) / 2);
  const rows = body.rows.map((_, i) => (i === 0 ? top : i === h - 1 ? bottom : middle !== undefined && i === midRow ? middle : mid));
  return { rows, base: body.base };
}

function displayGrid(node: Extract<Node, { k: "grid" }>): Box {
  const cells = node.rows.map((r) => r.map((c) => display(c)));
  const cols = Math.max(...cells.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(0, ...cells.map((r) => (r[c] === undefined ? 0 : widthOf(r[c]!)))));
  const gap = node.align === "rl" ? "" : node.align === "l" ? "    " : "  ";
  const rows: string[] = [];
  for (const r of cells) {
    const height = Math.max(...r.map((b) => b.rows.length));
    const above = Math.max(...r.map((b) => b.base));
    for (let y = 0; y < height; y++) {
      const parts = widths.map((w, c) => {
        const b = r[c];
        const text = b?.rows[y - (above - b.base)] ?? "";
        const align = node.align === "rl" ? (c % 2 === 0 ? "r" : "l") : node.align;
        return align === "r" ? " ".repeat(Math.max(0, w - textWidth(text))) + text : align === "l" ? pad(text, w) : center(text, w);
      });
      rows.push(parts.join(gap).trimEnd());
    }
  }
  const w = Math.max(0, ...rows.map(textWidth));
  const body: Box = { rows: rows.map((r) => pad(r, w)), base: Math.floor((rows.length - 1) / 2) };
  if (node.left === "" && node.right === "") return body;
  const inner: Box = { rows: body.rows.map((r) => (node.left === "" ? "" : " ") + r + (node.right === "" ? "" : " ")), base: body.base };
  return hcat([tall(node.left, inner, true), inner, tall(node.right, inner, false)]);
}

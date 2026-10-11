// A character canvas for diagrams. Lines are stored as directions per cell (up, right, down, left)
// and drawn at the end, so two lines that meet become the right junction (├ ┬ ┼) by themselves.
// Text and glyphs overwrite. Colours are foreground only: kinoko's code panel keeps its background.

export const UP = 1;
export const RIGHT = 2;
export const DOWN = 4;
export const LEFT = 8;

export type LineStyle = "solid" | "dotted" | "thick";

const LIGHT: Record<number, string> = {
  [UP]: "│", [DOWN]: "│", [UP | DOWN]: "│", [LEFT]: "─", [RIGHT]: "─", [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "┌", [DOWN | LEFT]: "┐", [UP | RIGHT]: "└", [UP | LEFT]: "┘",
  [UP | DOWN | RIGHT]: "├", [UP | DOWN | LEFT]: "┤", [LEFT | RIGHT | DOWN]: "┬", [LEFT | RIGHT | UP]: "┴",
  [UP | DOWN | LEFT | RIGHT]: "┼",
};
const HEAVY: Record<number, string> = {
  [UP]: "┃", [DOWN]: "┃", [UP | DOWN]: "┃", [LEFT]: "━", [RIGHT]: "━", [LEFT | RIGHT]: "━",
  [DOWN | RIGHT]: "┏", [DOWN | LEFT]: "┓", [UP | RIGHT]: "┗", [UP | LEFT]: "┛",
  [UP | DOWN | RIGHT]: "┣", [UP | DOWN | LEFT]: "┫", [LEFT | RIGHT | DOWN]: "┳", [LEFT | RIGHT | UP]: "┻",
  [UP | DOWN | LEFT | RIGHT]: "╋",
};

const ESC = "\x1b[";
const rgb = (r: number, g: number, b: number): string => `${ESC}38;2;${r};${g};${b}m`;
const OFF = `${ESC}39m${ESC}22m${ESC}23m`;

/** The diagram palette, close to kinoko's own. */
export const INK = {
  box: rgb(238, 222, 186),
  text: `${ESC}1m${rgb(214, 218, 232)}`,
  line: rgb(130, 136, 164),
  arrow: rgb(238, 222, 186),
  label: `${ESC}3m${rgb(166, 172, 198)}`,
  decision: rgb(236, 104, 104),
  frame: rgb(110, 116, 144),
  title: `${ESC}1m${rgb(130, 170, 255)}`,
  none: "",
};

/** Columns a character takes: CJK and emoji take two. */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x1100) return 1;
  const wide =
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}

export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

interface Cell {
  ch: string;
  style: string;
  mask: number;
  line: LineStyle;
}

export class Canvas {
  #cells = new Map<number, Cell>();
  width = 0;
  height = 0;

  #key(x: number, y: number): number {
    return y * 100_000 + x;
  }

  #cell(x: number, y: number): Cell {
    const key = this.#key(x, y);
    let cell = this.#cells.get(key);
    if (cell === undefined) {
      cell = { ch: "", style: "", mask: 0, line: "solid" };
      this.#cells.set(key, cell);
    }
    this.width = Math.max(this.width, x + 1);
    this.height = Math.max(this.height, y + 1);
    return cell;
  }

  /** A glyph that replaces whatever was there. */
  put(x: number, y: number, ch: string, style = ""): void {
    if (x < 0 || y < 0) return;
    const cell = this.#cell(x, y);
    cell.ch = ch;
    cell.style = style;
    cell.mask = 0;
    if (charWidth(ch) === 2) {
      const next = this.#cell(x + 1, y);
      next.ch = "\u0000"; // the right half of a wide glyph: printed as nothing
      next.mask = 0;
    }
  }

  text(x: number, y: number, text: string, style = ""): void {
    let at = x;
    for (const ch of text) {
      this.put(at, y, ch, style);
      at += charWidth(ch);
    }
  }

  /** Adds line directions to a cell; the first line style and colour to reach it stay. */
  line(x: number, y: number, mask: number, style = INK.line, kind: LineStyle = "solid"): void {
    if (x < 0 || y < 0) return;
    const cell = this.#cell(x, y);
    if (cell.ch !== "") return; // a glyph or text is there
    if (cell.mask === 0) {
      cell.style = style;
      cell.line = kind;
    }
    cell.mask |= mask;
  }

  /** A straight run of line from (x1, y1) to (x2, y2), one of them equal. */
  run(x1: number, y1: number, x2: number, y2: number, style = INK.line, kind: LineStyle = "solid"): void {
    if (y1 === y2) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        this.line(x, y1, (x > Math.min(x1, x2) ? LEFT : 0) | (x < Math.max(x1, x2) ? RIGHT : 0) || LEFT | RIGHT, style, kind);
      }
    } else {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        this.line(x1, y, (y > Math.min(y1, y2) ? UP : 0) | (y < Math.max(y1, y2) ? DOWN : 0) || UP | DOWN, style, kind);
      }
    }
  }

  mask(x: number, y: number): number {
    return this.#cells.get(this.#key(x, y))?.mask ?? 0;
  }

  /** Nothing drawn there: no line, no glyph. */
  free(x: number, y: number): boolean {
    const cell = this.#cells.get(this.#key(x, y));
    return cell === undefined || (cell.ch === "" && cell.mask === 0);
  }

  /** The rows, empty columns on the left and trailing spaces trimmed; `color` false for plain text. */
  rows(color = true): string[] {
    let left = this.width;
    for (const [key, cell] of this.#cells) if (cell.ch !== "" || cell.mask !== 0) left = Math.min(left, key % 100_000);
    const out: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      let style = "";
      let pending = "";
      for (let x = left; x < this.width; x++) {
        const cell = this.#cells.get(this.#key(x, y));
        const ch = cell === undefined ? " " : cell.ch === "\u0000" ? "" : cell.ch !== "" ? cell.ch : cell.mask === 0 ? " " : glyph(cell);
        const want = ch === " " || cell === undefined ? style : cell.style;
        if (ch === " ") {
          pending += " "; // spaces wait: trailing ones are dropped
          continue;
        }
        if (color && want !== style) {
          row += `${pending}${style === "" ? "" : OFF}${want}`;
          style = want;
        } else row += pending;
        pending = "";
        row += ch;
      }
      out.push(color && style !== "" ? `${row}${OFF}` : row);
    }
    while (out.length > 0 && out.at(-1)?.trim() === "") out.pop();
    while (out.length > 0 && out[0]?.trim() === "") out.shift();
    return out;
  }
}

function glyph(cell: Cell): string {
  const mask = cell.mask;
  if (cell.line === "thick") return HEAVY[mask] ?? "━";
  const light = LIGHT[mask] ?? "─";
  if (cell.line === "dotted") return light === "│" ? "┆" : light === "─" ? "┄" : light;
  return light;
}

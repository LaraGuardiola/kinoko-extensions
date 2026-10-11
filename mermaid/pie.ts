// `pie`: the slices as horizontal bars, longest first in the given order, each with its share.
// A terminal draws bars far better than circles.

import { INK, textWidth } from "./canvas.ts";
import { cleanLabel, statements } from "./model.ts";

const ESC = "\x1b[";
const rgb = (r: number, g: number, b: number): string => `${ESC}38;2;${r};${g};${b}m`;
const OFF = `${ESC}39m${ESC}22m${ESC}23m`;
const COLORS = [rgb(236, 104, 104), rgb(238, 222, 186), rgb(130, 170, 255), rgb(166, 209, 137), rgb(239, 159, 118), rgb(245, 194, 231), rgb(137, 220, 235)];
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function drawPie(source: string, width: number, color = true): string[] | undefined {
  const lines = source.split("\n").map((line) => line.replace(/%%.*$/, "").trim()).filter((line) => line !== "");
  const head = /^pie\b(?:\s+showData)?(?:\s+title\s+(.+))?$/.exec(lines[0] ?? "");
  if (!head) return undefined;
  let title = head[1] ?? "";
  const slices: Array<[string, number]> = [];
  for (const line of statements(source).slice(1)) {
    const slice = /^"([^"]*)"\s*:\s*([\d.]+)$/.exec(line);
    if (slice) slices.push([cleanLabel(slice[1] ?? ""), Number(slice[2])]);
  }
  for (const line of lines.slice(1)) {
    // statements() leaves title lines out: read here.
    const named = /^title\s+(.+)$/.exec(line);
    if (named) title = named[1] ?? "";
  }
  const sum = slices.reduce((s, [, v]) => s + v, 0);
  if (slices.length === 0 || sum <= 0) return undefined;
  const paint = (style: string, text: string): string => (color && text !== "" ? `${style}${text}${OFF}` : text);
  const labelW = Math.min(Math.max(...slices.map(([l]) => textWidth(l))), Math.max(6, Math.floor(width / 3)));
  const bar = width - labelW - 9; // "label  ████  42.5%"
  if (bar < 4) return undefined;
  const most = Math.max(...slices.map(([, v]) => v));
  const rows = slices.map(([label, value], i) => {
    const name = textWidth(label) > labelW ? `${[...label].slice(0, labelW - 1).join("")}…` : label + " ".repeat(labelW - textWidth(label));
    const eighths = Math.round((value / most) * bar * 8);
    const blocks = "█".repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? "");
    const share = `${((value / sum) * 100).toFixed(1)}%`;
    return `${name}  ${paint(COLORS[i % COLORS.length] ?? "", blocks)}${" ".repeat(Math.max(1, bar - textWidth(blocks) + 1))}${share.padStart(6)}`.trimEnd();
  });
  return title ? [paint(INK.title, cleanLabel(title)), "", ...rows] : rows;
}

// LaTeX math drawn in the terminal: $$…$$ and \[…\] blocks, ```math / ```latex fences, and inline
// $…$ / \(…\) in the model's replies come out as Unicode instead of TeX source. Fractions stacked,
// roots, sums and limits with their bounds, matrices, cases and aligned lines, Greek and the usual
// symbols; inline math on one line (x², a/b, √x). Too wide to stack, a block goes on one line;
// anything it cannot read (or still too wide) stays as the source.

import type { Kinoko } from "../api.ts";
import { display, flat, textWidth, trimBox } from "./layout.ts";
import { parse } from "./parse.ts";

/** A display formula as rows at most `width` wide, or undefined to leave the source. */
export function render(source: string, width: number): string[] | undefined {
  let tree;
  try {
    tree = parse(source.trim());
  } catch {
    return undefined;
  }
  const rows = trimBox(display(tree)).rows;
  if (rows.length > 0 && rows.every((r) => textWidth(r) <= width)) return rows;
  const one = flat(tree).trim();
  return textWidth(one) <= width ? [one] : undefined;
}

/** Inline math: one row, or undefined to leave the source. */
export function renderInline(source: string, width: number): string[] | undefined {
  try {
    const one = flat(parse(source.trim())).replace(/ {2,}/g, " ").trim();
    return one !== "" && textWidth(one) <= width ? [one] : undefined;
  } catch {
    return undefined;
  }
}

export default function (k: Kinoko): void {
  for (const lang of ["math", "latex", "tex", "katex"]) k.registerRenderer(lang, render);
  // kinoko asks this one for $…$ and \(…\) inside a line.
  k.registerRenderer("math-inline", renderInline);
}

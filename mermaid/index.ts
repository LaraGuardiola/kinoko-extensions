// Mermaid diagrams drawn in the terminal: ```mermaid blocks in the model's replies come out as
// box-and-line drawings instead of source. Flowcharts, state diagrams, sequence diagrams and pie
// charts; anything else (or anything it cannot read) stays as the source. Sized to the
// transcript's width: too wide, it redraws narrower, and at worst lists the edges.

import type { Kinoko } from "../api.ts";
import { parseFlowchart } from "./flowchart.ts";
import { drawGraph } from "./graph.ts";
import { drawPie } from "./pie.ts";
import { drawSequence } from "./sequence.ts";
import { parseState } from "./state.ts";

/** The diagram as rows at most `width` wide, or undefined to leave the source as it is. */
export function render(source: string, width: number, color = true): string[] | undefined {
  // A front-matter block (---\nconfig: ...\n---) only configures mermaid's own renderer.
  const body = source.replace(/^\s*---\n[\s\S]*?\n---\n/, "");
  const kind = /^\s*(?:%%.*\n\s*)*(\w[\w-]*)/.exec(body)?.[1] ?? "";
  if (kind === "flowchart" || kind === "graph") {
    const graph = parseFlowchart(body);
    return graph && drawGraph(graph, width, color);
  }
  if (kind === "stateDiagram" || kind === "stateDiagram-v2") {
    const graph = parseState(body);
    return graph && drawGraph(graph, width, color);
  }
  if (kind === "sequenceDiagram") return drawSequence(body, width, color);
  if (kind === "pie") return drawPie(body, width, color);
  return undefined;
}

export default function (k: Kinoko): void {
  k.registerRenderer("mermaid", (source, width) => render(source, width));
}

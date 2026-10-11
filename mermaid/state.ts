// `stateDiagram` / `stateDiagram-v2`: transitions (A --> B : label), [*] as the start and end
// points, `state "Long name" as A`, `A : description`, composite states (state X { ... }) drawn
// as groups, <<choice>> as a decision. Notes and concurrency separators are left out.

import { cleanLabel, direction, statements } from "./model.ts";
import type { Graph, Group, Shape } from "./model.ts";

export function parseState(source: string): Graph | undefined {
  const lines = statements(source);
  if (!/^stateDiagram(-v2)?\b/.test(lines[0] ?? "")) return undefined;
  const graph: Graph = { dir: "TD", nodes: new Map(), edges: [], groups: [] };
  const open: Group[] = [];
  let note = false;
  // Each composite state has its own [*]: one start and one end per scope.
  const scope = (): string => open.at(-1)?.title ?? "";
  const touch = (raw: string, side: "from" | "to"): string => {
    let id = raw.trim();
    let label = id;
    let shape: Shape = "round";
    if (id === "[*]") {
      id = `[*]${side === "from" ? "start" : "end"}:${scope()}`;
      label = side === "from" ? "●" : "◉";
      shape = side === "from" ? "start" : "end";
    }
    if (!graph.nodes.has(id)) graph.nodes.set(id, { id, label, shape });
    for (const group of open) if (!group.ids.includes(id)) group.ids.push(id);
    return id;
  };

  for (const line of lines.slice(1)) {
    if (note) {
      note = !/^end note$/.test(line);
      continue;
    }
    if (/^note\b/.test(line)) {
      note = !line.includes(":"); // a one-line note ends where it starts
      continue;
    }
    const dir = /^direction\s+(\w+)/.exec(line);
    if (dir) {
      if (open.length === 0) graph.dir = direction(dir[1]);
      continue;
    }
    if (/^(--|classDef|class|style)\b/.test(line) || line === "--") continue;
    if (line === "}") {
      open.pop();
      continue;
    }
    const composite = /^state\s+(?:"([^"]+)"\s+as\s+)?([\w.-]+)\s*\{$/.exec(line);
    if (composite) {
      const group = { title: composite[1] ?? composite[2] ?? "", ids: [] };
      graph.groups.push(group);
      open.push(group);
      continue;
    }
    const alias = /^state\s+"([^"]+)"\s+as\s+([\w.-]+)$/.exec(line);
    if (alias) {
      const id = touch(alias[2] ?? "", "from");
      graph.nodes.set(id, { id, label: cleanLabel(alias[1] ?? id), shape: "round" });
      continue;
    }
    const special = /^state\s+([\w.-]+)\s+<<(\w+)>>$/.exec(line);
    if (special) {
      const id = touch(special[1] ?? "", "from");
      const choice = special[2] === "choice";
      graph.nodes.set(id, { id, label: choice ? "?" : "", shape: choice ? "decision" : "rect" });
      continue;
    }
    const move = /^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/.exec(line);
    if (move) {
      const from = touch(move[1] ?? "", "from");
      const to = touch(move[2] ?? "", "to");
      graph.edges.push({ from, to, label: cleanLabel(move[3] ?? ""), line: "solid", head: true, tail: false });
      continue;
    }
    const described = /^([\w.-]+)\s*:\s*(.+)$/.exec(line);
    if (described) {
      const id = touch(described[1] ?? "", "from");
      const known = graph.nodes.get(id);
      const text = cleanLabel(described[2] ?? "");
      if (known) known.label = known.label === id ? `${id}\n${text}` : `${known.label}\n${text}`;
      continue;
    }
    const bare = /^state\s+([\w.-]+)$|^([\w.-]+)$/.exec(line);
    if (bare) touch(bare[1] ?? bare[2] ?? "", "from");
  }
  return graph.nodes.size > 0 ? graph : undefined;
}
